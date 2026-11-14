# Hoja de cálculo + correo + WhatsApp + app: un solo registro de pagos

**Estado:** propuesta, sin aprobar. Sin código ni migraciones.
**Fecha:** 2026-11-10
**Primera escuela:** Monster's Volley (sede Suba). Se construye como conector por escuela, no como script de Monster.

## 1. Qué se quiere

Monster lleva sus pagos en una hoja de Google muy ordenada y parte de las familias todavía manda el comprobante por correo; alguien del club lo abre y lo pasa a la hoja a mano. La meta:

- Un pago entra por **cualquier** camino (correo, WhatsApp, app) y queda registrado **una sola vez** en la app.
- La hoja de Monster se llena **sola** con ese mismo registro, en el formato que ya usan.
- Nadie vuelve a digitar un pago.

**Regla de fondo:** la app es la fuente de verdad de la plata. La hoja es un espejo que la app escribe; el correo y WhatsApp son entradas.

## 2. Lo que hay hoy (medido 2026-11-10)

### 2.1 Hojas de Monster (compartidas a contacto@sportmaps.co, solo lectura)

| Archivo | Contenido |
|---|---|
| `2026 SUBA` | Libro de control: una pestaña por mes, MATRICULA, TORNEOS, Clases de Prueba, UNIFORMES PEDIDOS, INDUMENTARIA, PATROCINIO, VACACIONAL 1 y 2, DRAFT, CLINICA JORGE MESA, PERSONAS DE LA APP |
| `Datos Plataforma Sede Suba` | Respuestas del formulario de inscripción, una pestaña por categoría + ÚLTIMOS INGRESOS |
| `Datos Plataforma Sede Norte` | Igual, una sola pestaña |

### 2.2 Formato de la pestaña del mes (leído de `Noviembre`)

Encabezado en la fila 8: `CATEGORÍA · NOMBRES · Mes de Ingreso · MENSUALIDAD · CONSECUTIVO · FECHA DE PAGO · DOBLE CATEGORIA · DEBE · OBSERVACIONES`.

- La hoja va **por bloques de categoría**: el nombre de la categoría solo aparece en la primera fila del bloque; cada bloque deja filas vacías al final y cierra con una fila `TOTAL:` con fórmulas.
- `MENSUALIDAD` es **lo que pagó**, no la tarifa. Hay abonos ($15.000, $20.000) y valores con descuento ($137.750 = 5 % sobre $145.000).
- `CONSECUTIVO` guarda en realidad **el medio de pago** (Nequi, Daviplata, Bold), escrito a mano y con variantes.
- `FECHA DE PAGO` va como `DD MM AA` (`05 11 26`).
- `DOBLE CATEGORIA` es `SI`/`NO`, y también se usa para marcar `BECADO`.
- `DEBE` es el saldo del mes. `$0` = al día.
- `OBSERVACIONES` lleva acuerdos que hoy no existen en ningún otro lado: saldo a favor («20mil a favor en disponible»), día de pago pactado («Paga los 15»), precio especial («Solo paga 80mil»), lesiones, retiros.
- Un mismo deportista puede estar en dos bloques (doble categoría).
- Pie de la pestaña de noviembre: recaudado $6.759.000, por llegar $4.406.500.
- La pestaña `PERSONAS DE LA APP` (octubre) tiene los totales del pie en `#REF!`.

La hoja identifica por **nombre**, no por documento. Ese es el riesgo principal de todo el proyecto.

### 2.3 Lo que la app ya tiene y se reutiliza

- **Entrada de correo:** `POST /api/v1/webhooks/resend-inbound` (`bff/src/routes/resend-inbound.routes.ts`) recibe correo por Resend Inbound con firma Svix. Hoy solo procesa **avisos del banco** reenviados por la escuela.
- **Lectura de comprobantes:** `ocr.service.ts` extrae; `receipt-verdict.ts` decide con reglas; `evaluatePaymentReceipt()` (`receipt-approval.service.ts`) recalcula el hash en el servidor, hace doble extracción y auto-aprueba o abre glosa.
- **Asociar comprobante a deportista y cobro:** `whatsapp-comprobante-de-ficha.service.ts` (por nombre), `whatsapp-comprobante-guiado.service.ts` (preguntar con opciones), `wa-cobro-desde-comprobante.service.ts` (crear el cobro que falta).
- **Duplicados:** índice único `uq_payments_school_receipt_hash`. El mismo comprobante mandado por correo y por WhatsApp choca solo.
- **No existe** ninguna integración con Google Sheets.

## 3. Diseño

```
correo de la familia ─┐
WhatsApp ─────────────┼─► comprobante ► lectura ► deportista + cobro ► pago en la app ─► hoja de Monster
app ──────────────────┘                                   │
                                                          └─► lo que no cruza: bandeja de la escuela
```

### 3.1 Correo → app

1. **Cómo llega.** En el Gmail de Monster se crea un filtro de reenvío automático (correos con adjunto) hacia una dirección de entrada de SportMaps propia de la escuela. No pedimos la contraseña ni acceso al buzón. Es el mismo mecanismo que ya se diseñó para los avisos del banco.
2. **Qué se hace con cada correo.** Se toma cada adjunto (imagen o PDF) y se pasa por la misma lectura que un comprobante de WhatsApp. Si no es un comprobante (`is_receipt = false`), se descarta sin guardar el contenido.
3. **De quién es el pago**, en este orden y parando en el primero que dé un único resultado:
   1. el correo del remitente coincide con el de un acudiente o deportista de la escuela;
   2. el asunto o el cuerpo nombran a un deportista (coincidencia exacta de nombre);
   3. el titular de la cuenta de origen que lee el comprobante coincide con un acudiente.
4. **A qué cobro va.** Al cobro pendiente cuyo monto cuadra (misma regla que WhatsApp, ±$1). Si paga algo que aún no tiene cobro (matrícula, clínica, torneo), se usa el camino de `wa-cobro-desde-comprobante`.
5. **Si no hay un único resultado** (nadie, o varios candidatos, o el monto no cuadra): **no se adivina**. Queda en la bandeja de comprobantes por asignar de la escuela, con el correo de origen a la vista, y la escuela lo asigna con un clic.
6. **Qué pasa después.** El pago queda en revisión con su comprobante y sigue el flujo normal: `evaluatePaymentReceipt()` lo auto-aprueba o lo deja para aprobación manual, según la configuración de la escuela.
7. **Respuesta a la familia.** Un correo corto de «recibimos tu comprobante de $X para [deportista]», con la invitación a enviarlo la próxima vez por WhatsApp o la app.
8. **Idempotencia.** Cada correo se registra por su `Message-ID`; un reintento de Resend no crea nada dos veces.

### 3.2 App → hoja

1. **Cuándo se escribe.** Cuando un pago queda aprobado (por cualquier camino) y cuando se anula o se edita. Se encola en una tabla de salida y un job del BFF de producción la vacía por lotes (una llamada a Google por hoja, no una por fila).
2. **Qué fila.** Por deportista + categoría + mes del **periodo** del cobro (nunca la fecha de vencimiento). El vínculo deportista ↔ fila se fija **una vez**, en la conciliación inicial (§4, fase 0), y se guarda con el id de la app en una columna oculta al final de la hoja. Desde ahí no se vuelve a buscar por nombre.
3. **Qué celdas.** Solo cuatro: `MENSUALIDAD` (suma pagada del periodo), `CONSECUTIVO` (medio de pago, normalizado), `FECHA DE PAGO` (`DD MM AA`), `DEBE` (saldo). Nunca se tocan nombres, categoría, mes de ingreso, doble categoría, observaciones ni las filas `TOTAL:`.
4. **Conflictos.** Si la celda ya tiene un valor distinto al que la app va a escribir, **no se pisa**: queda marcado como conflicto para que la escuela decida. Así, si alguien sigue digitando a mano durante la transición, no se pierde nada.
5. **Deportista nuevo.** Se escribe en la primera fila vacía de su bloque, antes del `TOTAL:`.
6. **Acceso.** Una cuenta de servicio de Google de SportMaps, a la que Monster le da permiso de editor solo sobre `2026 SUBA`. La credencial vive en variables de entorno del BFF.

### 3.3 Lo que queda fuera de esta primera entrega

- Edición en la hoja que vuelva a la app (dos sentidos sobre la misma celda).
- UNIFORMES PEDIDOS, INDUMENTARIA, PATROCINIO.
- Sede Norte: hoy solo tiene el formulario, no un libro de pagos.

## 4. Fases

| Fase | Qué entrega | Necesita de Monster |
|---|---|---|
| **0. Conciliación** | Cruce de `Noviembre` contra la app, deportista por deportista: quién está en la hoja y no en la app, y al revés; pagos que no coinciden. Solo lectura. De aquí sale el vínculo fila ↔ deportista. | Nada (ya hay acceso de lectura) |
| **1. Correo → app** | Los comprobantes que llegan por correo entran a la app solos; lo dudoso va a la bandeja. | Crear el filtro de reenvío en su Gmail |
| **2. App → hoja (mensualidades)** | La pestaña del mes se llena sola desde los pagos aprobados. Primero en una **copia** de la hoja durante una semana; luego en la real. | Permiso de editor para la cuenta de servicio |
| **3. Resto de pestañas de plata** | MATRICULA, TORNEOS, Clases de Prueba, CLINICA. | — |
| **4. Formulario → ficha** | Cada respuesta nueva del formulario de inscripción crea o completa la ficha del deportista. | — |
| **5. Conector para todas las escuelas** | «Conectar hoja de Google» y «Recibir comprobantes por correo» en la configuración de la escuela. | — |

Cada fase va completa (base + BFF + pantalla + pruebas) y el plan de migraciones se aprueba antes de escribirlas.

## 5. Decisiones resueltas

- **D1.** La app manda en los pagos; la hoja es espejo. No hay edición en dos sentidos en esta entrega.
- **D2.** El correo entra por reenvío automático a Resend Inbound, no por acceso al buzón de la escuela.
- **D3.** Un comprobante que no cruza con un único deportista y un cobro de monto igual **no se aplica solo**: va a la bandeja.
- **D4.** La app nunca pisa una celda con un valor distinto; lo marca como conflicto.
- **D5.** La fila se resuelve por el id guardado en la hoja, no por nombre.
- **D6.** El mes de la pestaña es el **periodo** del cobro.
- **D7.** Tablas nuevas con `text + CHECK`, escritura solo por `service_role`, lectura para administración de la escuela (`user_admin_school_ids()`).

Resueltas por el usuario el 2026-11-10:

- **D8. Todo mapeado: saldos a favor, deudas y acuerdos.** En la conciliación se cargan a la app el saldo a favor de cada deportista, lo que debe, el precio pactado y el día de pago pactado. Nada queda solo en observaciones.
- **D9. El correo es un camino residual.** La meta es que todas las familias paguen por WhatsApp o la app; el correo se atiende para quien lo siga usando. Se reenvían los correos con adjunto, y cuando la escuela asigna un comprobante, **el correo del remitente queda ligado a esa familia**: la próxima vez entra solo.
- **D10. La respuesta a la familia sale a nombre del club con «Powered by SportMaps»**, e invita a usar WhatsApp o la app la próxima vez.

## 6. Decisiones abiertas (para Iván)

1. **Valores pequeños sin medio ni fecha en `MENSUALIDAD`** ($10.000, $15.000, $20.000). Por las observaciones parecen ser saldo a favor que viene del mes anterior, no un abono nuevo. Confirmar.
2. **Filas sin pago ni deuda.** ¿Son deportistas inactivos? La app les sigue generando mensualidad a 30 de ellos (ver §9).
3. **Becados.** Hoy se marcan en la columna de doble categoría. ¿Se respeta esa marca en la hoja?
4. **Abonos.** ¿`MENSUALIDAD` muestra la suma de abonos del mes y `FECHA DE PAGO` la del último?

## 7. Por verificar antes de construir

- Que la API de recepción de Resend entregue los **adjuntos** del correo reenviado, y con qué límite de tamaño.
- Cómo resuelve hoy `procesarEventoResend` la dirección de entrada → escuela, para separar «aviso del banco» de «comprobante de familia» sin romper lo primero.
- Que el reenvío automático de Gmail conserve el remitente original (se necesita para el paso 3.1.3.1).
- Cuántos comprobantes llegan por correo al mes: define si la fase 1 va antes o después de la 2.

## 8. Riesgos

| Riesgo | Cómo se cubre |
|---|---|
| Nombres distintos entre hoja y app (mayúsculas, apellidos faltantes, homónimos) | Fase 0 con revisión humana; después, id fijo en la hoja |
| Alguien reordena o inserta filas en la hoja | El id va en la fila, no en el número de fila; se relocaliza en cada escritura |
| Comprobante falso por correo | Mismas reglas que WhatsApp; el aviso del banco por correo (ya construido) sigue siendo la confirmación real |
| El mismo pago por dos caminos | Hash único del comprobante |
| Cuota de la API de Google o caída | Cola de salida con reintento; la app no depende de la hoja |
| Más consultas por minuto a la base | Job por lotes con `.in()`, solo en el BFF de producción |

## 9. Fase 0: primer cruce de noviembre (2026-11-10, solo lectura)

Pestaña `Noviembre` de la hoja (última edición 7 de noviembre) contra las mensualidades de noviembre de la sede Suba en la app. El cruce fue por nombre y es una primera pasada: falta la revisión humana.

| | Hoja | App |
|---|---|---|
| Deportistas | 197 filas (195 nombres) | 152 con mensualidad de noviembre |
| Recaudado | $6.456.000 sumando filas ($6.759.000 según su pie) | $7.906.750 |
| Por cobrar | $4.551.500 | $9.348.000 |

**Cómo cruzaron los nombres**

- 107 filas con nombre idéntico.
- 43 por coincidencia parcial (la hoja o la app traen el nombre incompleto). Al menos una es falsa: dos deportistas distintas de la hoja caen en una sola ficha de la app que solo tiene nombre y primer apellido.
- 47 filas de la hoja sin mensualidad de noviembre en la app. Cuatro son solo diferencias de escritura; ocho son becados; el resto son filas sin pago ni deuda, más cuatro con pago o deuda en la hoja que hay que ubicar.

**Qué no cuadra**

- **123 coinciden en lo pagado; 27 no.** En unos la app va adelante de la hoja (pagos posteriores al 7 de noviembre); en otros la hoja tiene un pago que en la app está cancelado, en revisión o vencido.
- **Saldo a favor:** 7 deportistas tienen en la app más pagado que cobrado ($97.000 en total). Coincide con las notas «a favor» de la hoja, pero en la app no figura como saldo a favor, solo como un pago mayor al cobro.
- **30 deportistas con la fila en blanco en la hoja tienen mensualidad sin pagar en la app ($3.904.000).** Explica casi toda la diferencia en «por cobrar». Si son inactivos, la app les está cobrando de más.
- **Un becado de la hoja tiene mensualidad vencida en la app.**
- **De 29 deudas anotadas en la hoja, 19 coinciden** con la app.
- **Los totales por bloque de la hoja no siempre corresponden a sus filas** (un bloque sin deportistas suma $740.750).

El detalle con nombres no va al repo.
