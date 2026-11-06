# Plan Dynasty: ordenar los cobros y no perder información (2026-11-05)

Base: `Documents\demo\dynasty-conciliacion-pagos-2026-11-05.xlsx` (lectura de la base viva y OCR de los archivos guardados, sin modificar nada).

## Qué encontramos

| Hallazgo | Número |
|---|---|
| Comprobantes recibidos por WhatsApp desde el 2-oct | 691 |
| Aplicados solos a un cobro | 191 (28 %) |
| Pasaron a la bandeja de la escuela | 119 |
| El bot los ignoró | 365 (138 resultaron no ser comprobantes) |
| Sin resolver y con pago real o posible | 303 |
| Esos 303 ya leídos (monto, fecha, quién pagó) | 145 |
| Esos 303 que no se pueden leer (archivo no guardado y vencido en Meta) | 157 |
| Mensualidades pagadas con un monto distinto al cobro | 56 |
| Deportistas que pagan distinto a su cuota (plan mal puesto) | 50 |
| Cobros de mensualidad sin deportista asignado | 58 |
| Mensualidades «pagadas» sin comprobante por WhatsApp (ago–oct) | 322 |
| Octubre vencido / noviembre pendiente | 262 / 420 |

**Causas de fondo (no son «bugs sueltos»):**
1. **El cobro nace con un plan o cuota que ya no es el real.** Santiago: cobro de $150.000 (Plan PRO), paga $180.000 (Elite). Con eso el bot ve «diferencia» y aplica al mes más viejo.
2. **El bot descarta información al ignorar.** Lo que ignora no guarda el monto, y 190 archivos ni siquiera se guardaron; Meta los borra a los 30 días.
3. **Hay pagos que nadie sabe de quién son.** 177 comprobantes vinieron de números no asociados a ninguna familia.
4. **El registro vive en dos lugares.** Una parte se paga y se anota por fuera de la app (322 sin comprobante), y Milena no tiene un Excel propio.
5. **El plan por clases no puede cambiar solo.** Está apagado porque la asistencia sigue en papel.

## Plan por fases

### Fase 0: validar la foto (esta semana, con Milena, ~1 hora)
- Milena revisa en el Excel tres hojas: «Deportistas» (50 con plan distinto), «Mensualidades» (58 cobros sin deportista) y «Sin resolver» (303).
- Resultado: lista confirmada de **plan y cuota real por deportista**.
- Nosotros corregimos planes/cuotas con un script revisado y por lotes, y solo después de que Milena confirme. Las eliminaciones las maneja el usuario.
- Los 157 que no se pueden leer se piden por mensaje a las familias («envía de nuevo tu comprobante de…»), una sola vez.

### Fase 1: el bot deja de equivocarse (nosotros, ~1 semana)
1. **Monto que no cuadra → preguntar el mes con botones.** Nunca aplicar al más viejo por defecto.
2. **Pagó de más o de menos → a revisión de la escuela con una propuesta**, sin el mensaje «pagaste $30.000 de más» ni saldo a favor automático.
3. **El monto equivale a otro plan → proponer el cambio de plan** a la escuela para que lo confirme con un botón. No cambia solo.
4. **Guardar siempre el archivo y la lectura OCR**, incluso si se ignora. Así no se pierde información otra vez.
5. **Número sin familia → pedir nombre del deportista** y dejarlo asociado.

### Fase 2: el proceso de Dynasty (con Milena, ~2 semanas)
- Un solo lugar para registrar pagos: lo que entra por WhatsApp se aplica ahí; lo que entra por otra vía se registra en la app el mismo día.
- Mensaje único a las familias con instrucciones: «un comprobante por mensaje, escribe el nombre del deportista y el mes».
- Cierre de lista el último día del mes, con el reporte de cartera (ya existe `informe-cartera`).
- Asistencia en la app (hoy en papel): sin esto el plan por clases no puede cambiar solo.
- Torneos, camisas e inscripciones como **catálogo de productos** con precio, para que el bot los reconozca por monto.

### Fase 3: formulario de Meta (WhatsApp Flow)
- Registro del deportista: nombre, acudiente, plan, si tiene cuenta.
- **Condición:** el negocio de Dynasty verificado en Meta. Hay que confirmar si ya lo está.
- No se puede pedir cédula (política de Meta). Se arranca sin endpoint, con datos validados al recibir la respuesta.

## Cómo sabremos que mejoró

| Medida | Hoy | Meta a 1 mes |
|---|---|---|
| Comprobantes aplicados solos | 28 % | más del 70 % |
| Mensualidades pagadas con monto distinto al cobro | 56 | menos de 10 |
| Cobros sin deportista | 58 | 0 |
| Comprobantes sin resolver | 303 | menos de 20 |
| Archivos perdidos | 190 | 0 |

## Decisiones que necesito de ti
1. ¿Empezamos con la Fase 0 esta semana con Milena, o primero arreglamos el bot?
2. ¿Aprobamos que el bot **proponga** cambio de plan por monto? Cambia la decisión del 24-oct, que lo había descartado.
3. ¿El negocio de Dynasty ya está verificado en Meta?
4. ¿Mandamos el mensaje a las familias para recuperar los comprobantes que no se pueden leer?
