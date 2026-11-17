# WhatsApp: invariantes de confiabilidad del asistente

Fecha: 2026-11-16 · Estado: reglas aprobadas; implementación en curso en `develop`.

Este documento fija lo que el asistente de WhatsApp **nunca** puede hacer, por qué, y cómo se comprueba. Toda función nueva del bot se revisa contra esta lista antes de mezclarse. Complementa `whatsapp-autoservicio-escuelas-2026-11-15.md`.

## Por qué existe

Auditoría de producción del 1 al 16 de noviembre de 2026 (Dynasty y Monster's):

- 723 archivos recibidos; 27 % terminó en un cobro.
- Unos $3,0 M (Monster's) y $13,8 M (Dynasty) en comprobantes probablemente reales sin cobro.
- 34–36 % de los archivos no recibió ninguna respuesta en 10 minutos.
- 29 de 77 preguntas «pasadas a la escuela» sin respuesta humana en 24 h.
- El bot afirmó «anoté» sin guardar, tomó una pregunta y un enlace como nombres, y pidió comprobantes que ya tenía.

Nada de eso avisó a nadie. Tres ventas concretas del 15 de noviembre quedaron como pruebas de regresión (`bff/src/services/caso-*.test.ts`).

## Los invariantes

### I-1. Ningún comprobante se pierde en silencio
Un archivo con monto leído, o con una venta o concepto esperado vivo, termina siempre en uno de dos estados: **cobro en revisión**, o **acción en la bandeja** con monto, concepto probable, lo que se sabe de la persona y una propuesta escrita. Nunca en un cierre que la escuela no vea.

### I-2. El cliente siempre recibe respuesta a un archivo de pago
Aunque el resultado sea «la escuela lo revisa». Las excepciones (contacto marcado como equipo o negocio, foto que no es de pago y sin contexto) están enumeradas en el código, no implícitas.

### I-3. Lo leído se guarda siempre
Monto, referencia, fecha, destino, pagador y nota del comprobante quedan en la fila aunque el cierre sea silencioso. Sin eso no se puede auditar.

### I-4. La intervención de una persona de la escuela no descarta un pago
Si alguien de la escuela escribe mientras el bot espera un dato, el bot deja de hablar, pero el comprobante sigue vivo: se registra cuando llega el dato, o queda como acción.

### I-5. El bot no afirma lo que no hizo
«Anoté», «registré», «guardé», «quedó reservada», «cupo confirmado» solo después de que la escritura correspondiente tuvo éxito. Vale también para las respuestas redactadas por la IA: el prompt lo prohíbe y una red determinista lo corrige.

### I-6. El bot no pide lo que ya tiene
Antes de pedir un comprobante, un nombre, una edad, un mes o una sede, revisa: la ficha del contacto en esa escuela, la nota y el pie del archivo, y lo ya escrito en esa conversación.

### I-7. Memoria por chat
Lo que el cliente dio se guarda en su ficha de contacto de esa escuela y se reutiliza. En una segunda compra se confirma («¿Es para X, como la vez pasada?»), no se vuelve a pedir todo.

### I-8. Datos de registro obligatorios, pago nunca retenido
En la venta de un servicio son obligatorios nombre completo y fecha de nacimiento de quien asiste, y la persona responsable si es menor. «Obligatorio» significa que la inscripción no se da por completa y el bot los sigue pidiendo; el comprobante se registra igual con lo que se sepa.

### I-9. Un nombre solo es un nombre si lo parece
No son nombres: preguntas, enlaces, correos, frases con vocabulario de precio, horario o sede, ni el tipo de documento. Con dos candidatos sin marca, el bot pregunta; no elige.

### I-10. El bot no adivina el concepto por el monto
Un servicio (clínica, vacacional, torneo) no se crea solo porque el monto coincide: hace falta que la persona lo haya pedido. La venta de un servicio no absorbe pagos de una familia con cobros abiertos. El nombre escrito en el pie manda sobre el hijo por defecto.

### I-11. Una derivación tiene dueño y plazo
Cuando el bot dice «la escuela te responde por aquí», queda un pendiente visible para la escuela y el vigilante lo reporta si nadie responde.

### I-12. El bot no se repite
No envía el mismo texto dos veces seguidas en menos de dos minutos, ni reintenta una pregunta contra un mensaje que no es su respuesta.

## Cómo se comprueba

| Mecanismo | Qué cubre |
|---|---|
| Pruebas de regresión por caso real (`caso-*.test.ts`) | I-1, I-4, I-6, I-8, I-9 |
| Pruebas por regla en la cola, la venta, la cortesía y el embudo | Todos |
| **Vigilante diario** (`whatsapp-vigilante.*`): correo al equipo con comprobantes sin desenlace, derivaciones sin respuesta, clientes sin respuesta, afirmaciones por verificar y repeticiones | I-1, I-2, I-5, I-11, I-12 en producción |
| Prueba de punta a punta en el gemelo local antes de cada despliegue del bot | Flujo completo |

Regla de trabajo: **todo fallo real que reporte una escuela entra primero como prueba con sus datos exactos y después se arregla.** Así no vuelve.

## Lo que el código no resuelve

- **Datos que faltan en la ficha del servicio.** 22 de 57 preguntas derivadas eran por ciudad, plazo del saldo, acompañante, parqueadero, precio para no afiliados, categorías. Los carga la escuela.
- **Conceptos sin precio cargado.** Torneos, uniformes e inscripciones sin valor en la pestaña «Precios» siempre irán a la bandeja.
- **Costumbres del equipo.** No pedir datos en la nota de la transferencia; si se atiende a mano, registrar el pago a mano.

## Pendiente de decisión

- Enviar el resumen diario del vigilante también a cada escuela.
- Ventanas de silencio cuando una persona de la escuela atendió (hoy 12 h; 72 h para desconocidos): 165 mensajes quedaron sin dueño en 9 días.
- Publicar el formulario de inscripción de WhatsApp (Flows) por escuela.
- Fase 2 con migración: datos obligatorios configurables por servicio, mismo artículo varias veces en un comprobante, matrícula de renovación, cupos y lista de espera.
