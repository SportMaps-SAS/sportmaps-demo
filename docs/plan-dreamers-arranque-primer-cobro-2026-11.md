# Plan — Arranque de Dreamers: que el primer cobro nazca en el mes correcto

**Fecha:** 2026-11-07 · **Escuela:** Dreamers Gymnastics · **Estado:** propuesta, faltan las decisiones D1–D4.

> Sin datos personales a propósito: la lista de atletas sale del chequeo C5, no se versiona.

---

## 1. Qué pasó y qué ya se corrigió

Dreamers arrancó en SportMaps el 29 de octubre: hoy tiene **12 atletas activos, todos con alta entre el 29-oct y el 7-nov** (8 entre el 29 y el 31 de octubre, 4 entre el 5 y el 7 de noviembre).

| Problema | Estado |
|---|---|
| Las altas del 29–31 oct quedaron cobradas como **octubre**; la escuela dice que son de **noviembre** | ✅ Corregido en la base (mig `20261107104128`): 13 cobros pasaron a noviembre |
| 6 atletas que ya habían pagado figuraban **vencidos desde el 31-oct** (la vigencia se calcula hasta fin del mes pagado) | ✅ Corregido: vigentes hasta el 30-nov |
| El arreglo del 31-oct (etiquetar por el mes del vencimiento) hacía ver las altas del 5–7 nov como **«Diciembre»** | ✅ Retirado (`3496b71e`), **falta subirlo a `main`** |

## 2. Por qué pasó (causa de fondo)

1. **El sistema decide solo el mes del primer cobro**: siempre es el mes del alta. No le pregunta a nadie y no lo muestra.
2. **La pantalla de alta dice «Mensualidad $245.000 — Vence: 1 de noviembre»**, sin decir de qué mes es. Quien hace el alta el 30-oct lee «noviembre» y confirma.
3. **El concepto del cobro tampoco dice el mes**: «Plan PGR8x2 — Mensualidad completa, vence el 01/11 — Nombre». La familia deduce el mes por el vencimiento.
4. En Dreamers el primer cobro vence en el corte del mes siguiente (regla del 11-oct, sin recargo en el mes de alta, mig `20261011101750`). Por eso el periodo y el vencimiento **siempre caen en meses distintos**, y cualquier pantalla que use uno u otro dice algo diferente.

Con esto, **cualquier alta de fin de mes vuelve a fallar.** La próxima ventana de riesgo es del 25 al 30 de noviembre.

## 3. Otras dos cosas que hay que cerrar antes del 1 de diciembre

**a) A 10 de los 12 atletas no se les cobró inscripción ni seguro.** Los 12 planes los tienen configurados ($60.000 + $75.000, o $120.000 + $150.000 según el plan), pero en el alta son *opt-in*: la casilla «Cobrar inscripción / seguro» viene **desmarcada** (`defaultFeeWaivers`). Hay 14 exoneraciones registradas en `audit_logs` (`enrollment_fees_waived`). Si se debían cobrar, faltan **~$1.755.000** (3 atletas en planes de $120k + $150k y 7 en planes de $60k + $75k). No se sabe si fue a propósito (por ejemplo, porque ya los pagaron en Nex) o si se pasó la casilla.

Cómo se cobran si toca: **Deportistas → ⋯ → Editar deportista → «Inscripción y seguro» → marcar «Cobrar inscripción / seguro» → Guardar cambios.** El sistema usa el valor del plan, no repite una inscripción ya cobrada ni un seguro de los últimos 12 meses, y deja registro (`enrollment_fees_charged_after_signup`).

**b) Diciembre no se va a generar solo.** Dreamers tiene `auto_generate_payments = false`. El 1-dic nadie va a recibir su cobro a menos que alguien abra el mes.

Simulación de solo lectura del 2026-11-07, con la misma lógica de `preview_open_month`:
- **Noviembre: 0 cobros nuevos.** Los 12 ya tienen el suyo. Encender el automático hoy es seguro: el cron (`generate-monthly-charges-daily`, 01:30 COT, todos los días, abre el mes **en curso**) no crearía nada. Antes de la migración `20261107104128` habría duplicado 8 cobros de noviembre.
- **Diciembre: 12 cobros, $3.526.500**, todos por el valor del plan. Sin pausas ni referidos. El descuento por hermanos (5 %) está encendido, pero no hay hermanos vinculados. Vencen el 1-dic si se generan ese día; si se abre el mes después, vencen 5 días después de abrirlo. Los 2 atletas con noviembre vencido quedarían debiendo dos meses.

**c) Solo 2 de los 12 atletas tienen acudiente vinculado en la app.** Las otras 10 familias no tienen cuenta: no ven sus cobros ni reciben avisos, y sus cobros nacen sin pagador. Todo pasa por la escuela (registro manual o comprobantes). Por eso «sale octubre» solo lo vieron 2 familias. Antes de diciembre conviene invitarlas: la invitación precargada ya existe. Si no, la generación automática les crea el cobro, pero nadie del lado de la familia lo ve.

## 4. Plan de mitigación

### Frente A — El primer cobro nace en el mes correcto

- **A1. La pantalla de alta muestra y deja elegir el mes.** En la tarjeta «Primer cobro» (`AltaFirstChargeCard`): **«Mensualidad de: Octubre / Noviembre»**, preseleccionado por la regla de D1 y editable por quien da el alta. Debajo, «vence el 1 de noviembre». Así nunca se confirma un mes sin verlo.
- **A2. Un solo punto en el servidor.** El alta manda el mes elegido. Si no lo manda (QR, bot, prospecto que se inscribe), el servidor aplica la misma regla de D1. Se extiende el trigger que ya existe para el primer cobro (`fn_payments_primer_cobro_vence_prox_corte`), que hoy cubre todos los caminos de alta. Si el mes es el siguiente: periodo = ese mes, vence en su corte, sin recargo (sigue siendo el primer cobro) y vigencia hasta fin de ese mes.
- **A3. Los demás caminos de alta** (QR de inscripción, prospecto o clase de prueba → inscripción, bot de WhatsApp) heredan la regla del servidor sin cambios propios. Hay que probarlos uno por uno.

### Frente B — El mes se ve en todas partes

- **B1. El concepto del cobro nombra el mes**: «Mensualidad noviembre 2026 — Plan PGR8x2 — Nombre». Solo para cobros nuevos.
- **B2. Regla fija en el código: el mes es el PERIODO, nunca el vencimiento.** Ya aplicado en `3496b71e` (`estadoCuentaModel.mesDe`, `MyPaymentsPage`), con prueba (altas de mitad de mes → mismo mes).

### Frente C — Nada sin cobrar, nada cobrado dos veces

- **C1. Inscripción y seguro: elección obligatoria en el alta** (D2). En vez de una casilla desmarcada que se pasa por alto: «¿Cobrar inscripción? Sí / No», y si es No, un motivo («ya pagó en Nex», «beca», «hermano»…) que queda en el registro de exoneración.
- **C2. Revisar con Dreamers los 10 atletas de la §3a** y cobrar lo que corresponda desde Editar deportista.
- **C3. Diciembre** (D3): activar la generación automática para Dreamers, o que la escuela abra el mes. En los dos casos, el **30-nov se corre `preview_open_month`** y se revisa: 12 cobros, todos de diciembre, montos del plan, sin duplicados. Los 2 atletas con noviembre vencido reciben diciembre aparte.
- **C4. Corregir el mes de un cobro sin SQL y sin romper la vigencia.** Hoy, si se mueve el periodo de un cobro pagado, la vigencia no se recalcula: `fn_extend_enrollment_on_payment_paid` solo corre cuando cambia el estado (por eso hubo que hacerlo a mano en `20261107104128`). Va dentro de «Editar pago» (`docs/specs/editar-pago-y-cierre-de-caja.md`, D1–D4 ya decididas): cambiar el mes recalcula la vigencia en la misma transacción.
- **C5. Chequeo de salud semanal durante el arranque** (las primeras 8 semanas), solo lectura, por escuela. Avisa de:
  1. alta en los últimos días del mes con primer cobro en el mes del alta (sospechosa);
  2. atleta activo sin mensualidad del mes en curso;
  3. atleta sin inscripción/seguro **y** sin exoneración registrada;
  4. atleta que pagó y tiene la vigencia antes del fin del periodo pagado;
  5. dos mensualidades activas del mismo mes.

  Reporta y no corrige nada solo.

## 5. Orden propuesto

| Fase | Qué | Cuándo |
|---|---|---|
| F0 | Dato corregido + etiqueta retirada | ✅ 2026-11-07 (falta subir a `main`) |
| F1 | C2 (revisión con Dreamers), C5 (chequeo), decisión D3 | semana del 9-nov |
| F2 | A1 + A2 + B1 + C1 | **antes del 25-nov** (siguiente ventana de altas de fin de mes) |
| F3 | Preview de diciembre (C3) | 30-nov |
| F4 | A3 (pruebas de los otros caminos) + C4 | diciembre |

## 6. Decisiones pendientes

- **D1 — ¿Cómo se decide el mes del primer cobro?**
  - (a) Día fijo por escuela: desde el día X, el alta es del mes siguiente.
  - (b) Siempre lo elige quien da el alta, sin valor por defecto.
  - (c) **Recomendado:** las dos cosas. Preseleccionado por el día X y editable. Para Dreamers se propone **X = 25**; conviene preguntarles qué hacían en Nex.
- **D2 — Inscripción y seguro en el alta:** seguir con la casilla desmarcada (actual) o **elección obligatoria Sí/No con motivo** (recomendado).
- **D3 — Diciembre:** generación automática el 1-dic para Dreamers (recomendado: con 12 atletas y el preview del 30-nov el riesgo es bajo), o que la escuela abra el mes a mano.
- **D4 — Los días de fin de mes** (29–31 oct) quedan de cortesía cuando el primer cobro es del mes siguiente. Es lo que implica «todo es noviembre»; queda escrito para que no se discuta después.

**Descartado:** prender «Clases restantes» (`remaining_classes_billing_enabled`) para Dreamers. Cobraría 1–2 clases de octubre más noviembre completo, y eso contradice «todo es noviembre».
