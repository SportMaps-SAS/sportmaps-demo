# Dynasty — plan de actualización con la V2 y Mapi (2026-11-09)

**Para qué:** que lo que se aprendió con Monster (11-04 → 11-09) se aplique a Dynasty, ahora que SportMaps tiene su propio canal de WhatsApp (+57 320 268 3539) y se puede hablar con Milena sin depender del número del club.
**Pedido del usuario (11-09):** (1) mejorar el caso «los padres pagan y no están inscritos»; (2) escribirle a Milena para empezar la toma de fotos de matrículas y de asistencias; (3) armar el plan de actualización con los pagos, enfocado en la **V2** y en **Mapi** (asistente).

## 1. Diagnóstico (medido en la base, últimos 30 días, Dynasty)

| Dato | Valor | Lo que dice |
|---|---|---|
| Comprobantes recibidos por WhatsApp (imagen/PDF) | **558** | |
| …aplicados a un cobro | 190 (34 %) | el resto no se aplicó solo |
| …de contactos «no atendidos» (marcados personal/otro) | **122** | el sistema no los reconoce como familia |
| …sin contexto de pago | 70 | llegan sin que se sepa a qué son |
| …pasados a la escuela (escalated) | 89 | de ellos: «otro concepto» 26, «cerrado por la escuela» 21, «pregunta vencida» 17, «destino no es de la escuela» 12, «sin pagos pendientes» 11 |
| Cobros de 30 días | 537 (152 pagados o con abono) | |
| Cobros **sin deportista** (ni hijo ni ficha) | 18 (5 pagados) | plata que entró sin dueño |
| Deportistas con pago sin inscripción activa | 0 | el problema NO es «pagó y no tiene inscripción»: es «pagó y no sabemos quién es» |
| Fichas activas / hijos activos | 50 / 493 | |
| Fichas sin documento / sin fecha de nacimiento | 44 / 30 | ficha incompleta → no se cruza con nadie |
| Conversaciones: desconocidas / familia sin cuenta / familia con cuenta | 390 / 47 / 225 | |

**Lectura:** el hueco de Dynasty es de **identidad**, no de cobro. Una familia que paga y no está ligada a una ficha o a una cuenta no se reconoce, su comprobante queda en la bandeja y alguien lo aplica a mano. Es el mismo patrón de Monster (Alejandra, María Paula, Katherin con dos jugadoras): **la cuenta y la ficha nunca quedaron amarradas**.

### 1b. Auditoría con dos agentes (2026-11-09, solo lectura; listas con nombres en `C:\tmp\dynasty-pagos\` y `C:\tmp\dynasty-chats\`, fuera del repo)

**Pagos (60 días):** 813 archivos en la cola; 755 tras quitar 58 de contactos personales. **264 (35 %) se aplicaron a un cobro** (todos mensualidad); 74 tienen monto legible y no se aplicaron (35 son de monto de mensualidad); 417 no tienen monto leído (175 de contactos no atendidos, 70 sin contexto, 53 «no es comprobante»).
- Mensualidades típicas: $150.000, $180.000, $90.000, $210.000, $130.000. Bancos de los 128 OCR: Nequi 40, BreB 32, Bancolombia 25, Davivienda 13, DaviPlata 7.
- **Octubre:** 247 pagados, 235 sin pagar ($39,33M recaudado, $35,08M abierto). **Noviembre:** 137 pagados, 354 sin pagar ($22,46M recaudado, $53,35M abierto).
- **29 comprobantes de mensualidad por $4,34M no están reflejados como pagados** (17 con candidato por $2,57M; 11 son de noviembre, $1,81M). Puede que ya estén pagados por otra vía: se verifica uno por uno.
- 10 cobros con comprobante ligado que no están pagados; 18 cobros sin deportista en 30 días ($2,51M; 5 pagados), 12 con ficha u hijo homónimo (casi todos fichas inactivas).
- **Cuello de botella = identidad:** ninguna de las 50 fichas activas guarda teléfono ni nombre del acudiente y 44 no tienen documento; Nequi y BreB no traen el titular de origen, así que casi nunca se cruza por nombre. Hay 5 destinos de cuentas ajenas que se repiten (esa plata no es de la escuela).
- Lista de trabajo: 148 filas (prioridad, pagador, monto, fecha, candidato, certeza, acción). Ninguna certeza «alta».

**Chats (30 días, ~595 conversaciones):** 222 sin respuesta de nadie (101 con más de 7 días; los más viejos, del 11 al 14 de octubre); 122 quieren inscribirse o preguntan por clases/precios (29 sin respuesta); **82 chats para crear ficha** (31 con certeza media; casi ninguno trae documento ni fecha de nacimiento); **37 donde Mapi debe pedir datos**.
- Temas: pagos 179, precios 114, ubicación 77, horarios 75, cortesía 61. Tráfico: pico de 8 a 12 y de 16 a 19. Cuando la escuela contesta: mediana 4 min; **la cola está en los chats que nunca contesta**.
- La ficha de la escuela NO tiene dirección, precios ni ubicación por equipo; sí tiene 9 horarios de equipos. Mapi puede contestar horarios y debe escalar precios y dirección (114 y 77 chats lo piden): primero hay que cargar esos datos.

## 2. Principios (de Monster, ya probados)
1. Una persona que paga **no se queda esperando**: el sistema le contesta con botones y le pide solo lo que falta (nombre completo del deportista, documento).
2. **Nada de preguntas antes de pagar**; el dato se pide al recibir el comprobante.
3. El caso que el sistema no resuelve le llega a una **persona por WhatsApp al instante** (canal de SportMaps), no a la app.
4. Nunca se une a un deportista con una cuenta «por parecido»: solo con evidencia o confirmación de la familia.
5. Todo lo que se ejecute queda a nombre del super admin, con `audit_logs`.

## 2b. Restricción de Dynasty: Milena usa el chat de forma muy personal (dicho por el usuario, 11-09)
El WhatsApp del club en Dynasty mezcla familias, amigos, proveedores y la vida personal de la dueña, y todo lo del club es complejo. Eso explica los **122 comprobantes de «contactos no atendidos»**: son chats que el sistema, a propósito, no toca. De esto se desprende:
1. **El bot no le contesta a nadie nuevo en Dynasty** hasta que Milena lo apruebe contacto por contacto o por regla. Mapi solo actúa con familias ya reconocidas y con quien ella marque.
2. **No se le pide a Milena clasificar 122 contactos.** Se le propone una regla simple («si manda un comprobante de pago, avísame»), y lo personal queda intacto. El texto de los contactos marcados como personal no se guarda: no hay forma de revisarlos ni se debe.
3. **El canal de SportMaps es la solución justamente porque está aparte:** los avisos llegan como un chat «SportMaps» separado de su WhatsApp personal, con un solo tipo de aviso al comienzo (comprobantes que el sistema no supo aplicar). Nada nuevo en sus chats de siempre.
4. **Una sola petición por vez y a su ritmo.** Primero solo avisos de comprobantes sin aplicar (no cambia nada de cómo trabaja); después las fotos de matrículas en lotes cuando ella pueda; asistencias al final. Sin reuniones largas.
5. **La toma de fotos** debe poder hacerse sin pasar por su chat personal: subida desde la app (V2) o por el chat de SportMaps, nunca mezclada con sus conversaciones.

## 3. Fases

**Fase 0 — Prerrequisitos (esta semana)**
- Canal de SportMaps con plantillas aprobadas y **Milena suscrita** (ella escribe «ACTIVAR» al 320 268 3539 desde el WhatsApp del club). Estado 11-09: canal conectado, 5 plantillas en revisión de Meta.
- Disparadores del bot hacia el canal: pide persona, comprobante que no cuadra, pago sobre el tope, pregunta sin respuesta.

**Fase 1 — Hablar con Milena (con aprobación del usuario antes de enviar)**
- Mensaje por el canal de SportMaps: qué cambió, qué se le pide y cuándo. Una sola petición por mensaje. Borrador en §5.
- Reunión corta (15 min) para acordar el ritmo de la toma de fotos.

**Fase 2 — Toma de fotos de matrículas y de asistencias**
- Matrículas: usar «alta por foto de matrícula» (ya existe). Meta: que las **44 fichas sin documento y las 30 sin fecha de nacimiento** queden completas primero; es lo que desbloquea el cruce con los pagos.
- Asistencias: planillas de papel (ya hubo la de septiembre) → foto → lectura → asistencia. Primero una semana de prueba con un grupo.
- Medida de éxito: fichas completas / total, y planillas leídas sin corrección humana.

**Fase 3 — Pagos de quien no se reconoce (Mapi, la parte que más mueve)**
- Cuando llega un comprobante de un contacto no reconocido: Mapi lo recibe, confirma el monto y pregunta con botones **«¿De quién es el pago?»** (nombre completo del deportista) y, si hace falta, «Documento del deportista».
- Con la respuesta se busca la ficha o el hijo; si hay coincidencia **exacta** (nombre + documento), se liga y se aplica; si no, va a Milena con el caso armado (nombre, teléfono, monto, comprobante).
- Pagos múltiples (varios deportistas, un comprobante): reconocer la lista «Jugador 1… Jugador 2…» y que el monto sea múltiplo del precio (caso Katherin 11-09: 2 × $300.000).
- Medida de éxito: % de comprobantes aplicados sin intervención (hoy 34 %) y tiempo hasta que la familia recibe su confirmación.

**Fase 4 — V2 y cuentas**
- La familia crea su cuenta **con el código de Dynasty** desde la V2 y queda amarrada a la escuela desde el primer día (hoy 47 familias escriben y no tienen cuenta).
- Mapi invita a la cuenta cuando reconoce a la familia por teléfono (como ya hace Monster con «Créala aquí, ya te dejé todo listo»).
- Evitar cuentas duplicadas (caso María Paula: dos cuentas con el mismo teléfono): aviso al crear una segunda con el mismo teléfono.

**Fase 5 — Medición semanal**
- Informe semanal a Milena por el canal de SportMaps (plantilla `sm_informe_cartera_semanal`): comprobantes aplicados solos, casos pendientes, fichas completas.

## 4. Decisiones que necesita el usuario
1. **¿Quién le escribe a Milena y cuándo?** (propuesta: el usuario, con el borrador de §5, cuando las plantillas estén aprobadas y Milena suscrita).
2. **¿Se empieza por matrículas o por asistencias?** (propuesta: matrículas, porque desbloquea los pagos).
3. **Contactos «no atendidos» (122 comprobantes):** ¿son personales de la dueña o familias? Hay que revisarlo con Milena antes de que Mapi les conteste.
4. **Tope de aprobación automática para Dynasty** (Monster tiene $400.000): ¿el mismo?

## 5. Borrador del mensaje a Milena (NO enviado)
> Hola Milena 👋 Soy [nombre] de SportMaps. Estamos estrenando un canal propio de avisos por WhatsApp: cuando una familia pida hablar con una persona, o llegue un comprobante que el sistema no sepa aplicar, te avisamos al instante. Para activarlo, escríbele **ACTIVAR** al 320 268 3539 desde este mismo WhatsApp. También queremos empezar con las fotos de las matrículas: hay 44 fichas sin documento que no podemos cruzar con los pagos. ¿Te sirve que empecemos esta semana con un grupo?

## 6. Qué NO se hace sin pedir permiso
Enviar mensajes a Milena o a familias, cambiar el modo discreto de Dynasty, unir cuentas con fichas por parecido, o aprobar pagos de contactos que nadie ha confirmado.
