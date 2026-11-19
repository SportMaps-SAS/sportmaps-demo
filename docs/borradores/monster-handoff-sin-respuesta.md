# Monster: el hilo en traspaso que se queda sin respuesta (hilo ...6291, Sara)

Auditoría del 18-nov-2026. Escuela `monsters-volley-club`. Estado: INVESTIGACIÓN + propuesta. No hay código cambiado.

## 1. Qué pasó en el hilo ...6291

| Hora (Bogotá, 18-nov) | Quién | Mensaje |
|---|---|---|
| 15:18 | Sara | Toca «Hablar con alguien» (botón de la venta del vacacional) |
| 15:18 | Bot | «Listo, le aviso a la escuela y te escribe por aquí» (`step=venta_servicio_humano`, `pendiente_escuela`) |
| 15:21 | Escuela (eco del celular) | «Cuéntanos qué te hace falta para inscribirte al vacacional» |
| 20:38 | Sara | «Que esta muy caro» |
| 22:43 y 01:08 | Sistema | Notificación in-app + push a 2 admins: «Sara sigue esperando respuesta. Pasaron 2 h y nadie le ha respondido» |
| — | Bot / escuela | Nadie contesta |

Lo importante: el equipo SÍ fue avisado, dos veces (4 notificaciones, 2 admins x 2). El aviso existe pero no lo atendieron, y no dice nada del contenido («muy caro»), solo «sigue esperando».

## 2. Cómo funciona hoy el traspaso (mapeo)

Monster tiene `school_settings.wa_modo_discreto = 'no'` y horario 24/7 (`business_hours` 00:00–23:59 todos los días). Es decir: bot completo, sin modo discreto.

**Pasar a la escuela**
- Botón «Hablar con alguien» → `atenderBotonDeVenta` (`whatsapp-venta-servicio.ts`, caso `humano`): manda el texto, marca `pendiente_escuela` y llama `abrirEnBuzon` (deja la conversación abierta en el buzón y avisa). Un solo aviso por hora (`avisadoHaceRato`).
- Otras vías: tool `escalate_to_human` del modelo (`step=escalated`), `mensaje_para_persona`, puerta del desconocido, etc.
- No hay un «estado de traspaso» en la conversación. El traspaso es solo un saliente del bot con `step` y `payload.pendiente_escuela`. Lo único que silencia al bot a nivel de fila es `tomada_por/tomada_hasta` (alguien tomó la conversación en el buzón); Sara no estaba tomada.

**Cuándo el bot se calla / vuelve a hablar**
- `humanoReciente(recientes, 15 min)`: si una persona de la escuela escribió hace menos de 15 min, el bot calla (`whatsapp-bot.service.ts` ~470). Pasados 15 min, el bot vuelve a estar habilitado para el siguiente mensaje del cliente.
- En modo discreto la ventana sería de 12 h (`HORAS_SILENCIO_ESCUELA`); Monster no lo usa.
- Excepción de Monster: quien pide un servicio del catálogo recibe la ficha aunque la escuela haya escrito hace poco.
- A las 20:38 la escuela llevaba 5 h sin escribir, así que el silencio por humano NO aplica. El bot calló por otra causa. Hipótesis (sin verificar, no hay logs a mano): la venta del vacacional estaba «en curso» y «Que esta muy caro» no cae en ninguna intención de `intencionEnVenta`. No existe ninguna regla de objeción de precio (`grep caro` en los servicios de WhatsApp no encuentra nada), así que no sale respuesta. Hay que confirmarlo corriendo `intencionEnVenta('Que esta muy caro')` y siguiendo el camino del turno.

**Re-avisos al equipo (qué existe)**
1. `revisarEscalaciones` (30 min): solo mira salientes `escalated` con `plazo_min`. `venta_servicio_humano` NO está.
2. `revisarSlaDeEscalaciones` (2 h hábiles, push + correo): solo `PASOS_CON_SLA = escalated, identificacion_ambigua, puerta_club_recibido, puerta_otro_tema`. `venta_servicio_humano` NO está.
3. `revisarRetomas` (30 min): el bot retoma lo que sabe contestar si la escuela cedió. Solo sabe precio de lista, horarios, sede y pago; «muy caro» no es una pregunta y cae en «sin respuesta». `venta_servicio_humano` tampoco está en `PASOS_PASE_A_LA_ESCUELA`.
4. `revisarPendientesSinRespuesta` (`whatsapp-modo-discreto.ts`; lo corre `maintenance.job.ts` forzado y con predicado ancho incluso sin modo discreto): un push + campana por conversación y día cuando el último entrante que «pide algo» lleva 2 h hábiles sin saliente posterior. Es lo que avisó por Sara. Texto genérico, sin resumen, sin correo.

**Conclusión del mapeo:** el hueco no es «nadie fue avisado». Es que (a) el bot no tiene qué decir ante una objeción de precio, (b) el aviso al equipo es un push genérico, sin el mensaje, una vez al día, y (c) no hay segundo escalón (correo con resumen) ni reactivación hacia la clienta. Además el mensaje de la escuela («Cuéntanos qué te hace falta…») dejó el hilo sin dueño.

## 3. Dimensión (últimos 14 días, Monster, solo lectura)

Consulta: conversaciones con algún mensaje de traspaso del bot (`venta_servicio_humano`, `escalated`, `mensaje_para_persona`, `venta_servicio_a_la_escuela`, puertas, etc.) cuyo ÚLTIMO mensaje es del cliente, posterior al traspaso, y con más de 2 h sin respuesta.

| Medida | Conversaciones |
|---|---|
| Con algún traspaso en 14 días | 81 |
| Último mensaje es del cliente | 24 |
| ...y posterior al traspaso, sin respuesta > 2 h | 23 |
| ...sin respuesta > 24 h | 20 |
| De esas 23, la escuela SÍ había escrito después del traspaso | 22 |

La gran mayoría son cierres de cortesía («gracias», «ok», «listo, gracias», «dale», «quedo atenta»), que no piden respuesta. Revisadas a mano, las que parecen pedir algo:

| Hilo | Último mensaje | Estado |
|---|---|---|
| ...6291 | «Que esta muy caro» (hace 15 h) | abierto, el caso de Sara |
| ...4561 | «Sí, acepto» | abierto, familia; probablemente consentimiento, revisar |
| ...5413 | Mensaje de Felipe sobre confirmación (11-nov) | cerrado |
| ...0145 | Datos de una deportista y tipo de documento (11-nov) | cerrado |
| ...9990 | Explica qué tiene y que lo deja mañana (06-nov) | cerrado |
| ...2885, ...-a-e | Adjunto sin texto | cerrado |

Lectura: en 14 días hay UNA conversación abierta con pedido real sin respuesta (Sara) y 4–6 más cerradas por la escuela cuyo último mensaje quizá merecía respuesta. Volumen chico, valor alto por caso (vacacional de 80.000 a 200.000).

Objeciones de precio (30 días, «caro / costoso / descuento / no me alcanza»): ~39 coincidencias, casi todas descuentos de familias que la escuela contestó. Objeciones directas de un desconocido en el vacacional: ...6291 (bot 0 respuestas, humano 0 en 24 h), ...6090 («me sale muy costoso…», bot 1 respuesta, humano 0 en 24 h), ...6503 («no me alcanzan los ahorros», bot 1 respuesta, humano 0 en 24 h). Las 3 terminaron sin gestión humana.

## 4. Propuesta de diseño (todo apagado por defecto; nada implementado)

### A. Aviso al equipo con contenido, por correo (lo más barato y seguro)
Cuando `revisarPendientesSinRespuesta` detecte un pendiente (ya existe), además del push enviar UN correo al staff con: nombre y teléfono, el último mensaje textual, el servicio por el que preguntó, el valor de lista y de afiliado, y un borrador de respuesta. Reutiliza `avisarEscalamientoPorCorreo` (freno de 6 h por conversación). Bandera `WA_PENDIENTE_CORREO=true`, apagada por defecto.
- Riesgo: ruido. Mitigación: solo si el último entrante pasa `entrantePideAlgo` (ya excluye cierres de cortesía).

### B. Respuesta del bot a la objeción de precio en el vacacional
Intención nueva `objecion_precio` en `intencionEnVenta` («muy caro», «costoso», «no me alcanza», «hay descuento») que conteste solo con datos del catálogo: valores por semanas y, si no es afiliado, el valor de afiliado; invitación a elegir menos semanas; botón [Hablar con alguien]. Sin inventar descuentos. Bandera por escuela (a decidir dónde vive; podría ir junto a `wa_temas_a_persona`).
- Riesgo: contradecir a la escuela si negocia por fuera. Mitigación: solo cifras del catálogo.

### C. Reactivación hacia la clienta (opcional)
A las 24 h sin respuesta humana a un entrante con pedido real, un mensaje del bot: «Seguimos con tu consulta, ¿quieres ver las opciones por semanas?». Fuera de la ventana de 24 h de Meta exige plantilla aprobada. Recomiendo NO hacerlo hasta que A y B corran un tiempo.

### D. Estado de traspaso en la conversación (no recomendado ahora)
Un estado `pendiente_escuela` persistente hasta que una persona conteste. Toca esquema y migración (regla de Disk IO: una sola sesión aplica migraciones). No se justifica por el volumen medido.

### Recomendación
1. A y B como cambios separados.
2. C y D después de medir.
3. Mientras tanto, operativo: que la escuela atienda el push «sigue esperando respuesta» (hoy llega y nadie lo toma).

## 5. Decisiones de producto para ti

1. ¿Quieres que el bot responda objeciones de precio por su cuenta, o que siempre pasen a una persona (y solo mejorar el aviso)? Cambia un flujo acordado.
2. Si responde: ¿solo valores del catálogo (semanas, afiliado) o también ofrecer descuentos? (Recomiendo solo catálogo.)
3. ¿Quién recibe el correo: owner y admins (como hoy los push) o una dirección fija del equipo de ventas de Monster?
4. ¿Cuánto esperar antes del correo? Monster atiende 24/7, así que 2 h hábiles = 2 h corridas, de noche también. ¿Se silencia de noche?
5. ¿Se permite el mensaje de reactivación a la clienta (C)? Requiere plantilla de Meta pasadas 24 h.
6. ¿Solo vacacional o todo Monster?
7. ¿Confirmo antes la causa del silencio de las 20:38 con una prueba en simulación?

## 6. Qué NO se hizo
Sin commit, push, migraciones, escrituras en la base ni envíos. No se implementó código: el diagnóstico no lo necesitó, y A y B cambian comportamiento visible, así que esperan tu decisión.
