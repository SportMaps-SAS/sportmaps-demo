# Ventas de servicio por WhatsApp — blindaje (2026-11-08)

**Estado:** aprobado por el usuario el 2026-11-08 («arma un plan robusto, mitígalo con múltiples agentes, sube a dev y main»).
**Caso que lo originó:** Clínica de Armadores y Atacantes de Monster´s Volley (21 y 22 de nov). Del 3 al 8 de nov: ~130 interesados, 41 recibieron la ficha del bot, 12 dijeron «Sí» a la campaña → **1 sola venta registrada en la app**, y la escuela terminó cobrando por correo.

## 1. Lo que falló (medido en la base)

| # | Falla | Ejemplo real |
|---|---|---|
| F1 | La respuesta al «Sí» de la campaña no trae cómo pagar («responde y te enviamos los datos») | 10 de 12 nunca volvieron a escribir |
| F2 | Dudas justo antes de pagar → «la escuela te confirma» → nadie responde (6 de 8) | «¿incluye grupo femenino?», «titular de la cuenta», «¿por llave?», «¿con el pago ya tengo el cupo?», «mi hija tiene 12» |
| F3 | El bot mete el CLUB en la venta: «Elige la sede», 5 preguntas, clase de prueba, vacacional | Nicolás pagó la clínica y terminó pagando una clase de prueba de $15.000 que no pidió |
| F4 | La IA repitió un dato contradictorio: la ficha de prospectos decía «preventa hasta el 9»; catálogo y anuncio, «hasta el 10» | 12 conversaciones con la fecha mal |
| F5 | Comprobante de alguien de fuera del club → «¿De qué deportista es?» → «No encontré» | la clínica es para externos |
| F6 | El precio y la cuenta van al final de un texto de 2.581 caracteres | quien pregunta «¿cuánto y cómo aparto?» no lo ve |
| F7 | En Gestión de Pagos el cobro de la clínica sale «Sin nombre» y como «clase extra»; no se distingue torneo / clínica / cortesía / mensualidad / inscripción | — |
| F8 | No hay forma de ver quién escribió, si respondió la escuela o el bot, y quién quedó esperando | — |

## 2. Reglas de producto (decididas por el usuario 2026-11-08)

1. **Una venta de servicio es solo una venta.** Mientras la conversación esté en la venta de un servicio del catálogo (`school_tournament_items`: clínica, torneo, vacacional, campamento, cualquier `kind`), el bot NO abre nada del club: ni bienvenida con sedes, ni embudo de 5 preguntas, ni clase de prueba/cortesía, ni otros servicios, ni «escríbeme tu correo». Solo sale de la venta si la persona pide el club **de forma explícita** (`pideElClub`).
2. **El valor a pagar va en un mensaje aparte, cuando lo piden** («¿cuánto?», «¿cómo aparto/separo/reservo/pago?», «datos», «cuenta», «titular», «llave», «sí me interesa», «quiero reservar»). Corto y claro: precio de HOY por tramo de fecha (con la fecha correcta del tramo siguiente), abono mínimo, cuenta(s) con titular, y «envía aquí el comprobante con el nombre completo de quien asiste».
3. **Cada respuesta sale de lo que la escuela configuró** (catálogo + cuentas). El catálogo manda sobre cualquier texto libre. Si el dato no está, el bot lo dice claro («eso te lo confirma la escuela por aquí»), avisa a la escuela y la pregunta queda **pendiente y visible** en la lista de seguimiento. Nunca adivina.
4. **Ningún monto ni fecha de precio sale si no está en los datos** (verificador de salida).
5. **Comprobante en una venta = cobro del servicio** a nombre de quien asiste (prospecto o deportista), nunca la búsqueda en el padrón del club ni el embudo.
6. **En el panel de pagos cada cobro dice qué es** (Mensualidad, Inscripción, Clase de prueba, Clínica/nombre del servicio, Torneo, Vacacional, Uniforme…) y se puede filtrar por tipo.
7. **Lista de seguimiento:** quién escribió, qué tema, si respondió la escuela, si respondió el bot, quién quedó esperando y desde cuándo, datos de pago enviados, comprobante, cobro.
8. Vale para **cualquier escuela** y cualquier servicio, no solo Monster.

## 3. Contrato común (ya en el repo, NO cambiar la firma sin avisar)

- `bff/src/services/whatsapp-venta-contexto.ts` (puro, con pruebas):
  - `ventaActiva(mensajes, itemsVigentes, { ahora?, leadServicioId?, dias? }) → { item, origen, desde } | null`
  - `itemNombradoEn(texto, items)`, `itemMarcadoEn(fila, items)`, `pideElClub(texto)`
  - `MARCA_VENTA = 'venta_servicio_id'`: **todo saliente de una venta lleva `payload.venta_servicio_id = item.id`** (así la lista de seguimiento, la cola y el propio bot la reconocen).
  - `DIAS_CONTEXTO_VENTA = 7`.
- `bff/src/services/whatsapp-servicio-ia.ts`: `responderPreguntaDeServicio(p) → { tipo:'respuesta', texto } | { tipo:'no_se', motivo }` (stub hoy; lo implementa el frente B).
- Esperado B4: al abrir una venta se registra `registrarConceptoEsperado(schoolId, tel, { motivo: motivoDeServicio(item), leadId, venceEn: item.ends_at })` para que el comprobante cree el cobro.

## 4. Frentes (uno por agente; nunca dos agentes en el mismo archivo)

### A — Bot en modo venta (`whatsapp-bot.service.ts`, `whatsapp-anuncio-destino.ts`, `whatsapp-prospecto-seguimiento.service.ts`, `whatsapp-campana-respuesta.service.ts`, nuevo `whatsapp-venta-servicio.ts`)
- Leer `ventaActiva` al inicio del turno (desconocidos **y** familias: el afiliado que compra la clínica también), con los mensajes de 7 días (UNA lectura, columnas mínimas) + catálogo vigente (`serviciosDeAnuncio`) + servicio del lead.
- Con venta activa, `atenderVentaDeServicio` atiende TODO antes que embudo/bienvenida/puerta/cortesía/seguimiento del embudo/precios del club/vacacional. Intenciones: pide pago → mensaje de pago aparte (determinista); pregunta un detalle → `responderPreguntaDeServicio` (si `no_se` → «te lo confirma la escuela» + buzón con la pregunta); «otra fecha/no puedo ese día» → acuse + buzón; «ya pagué / te mando el comprobante» → «envíalo aquí con el nombre completo de quien asiste»; saludo/«ok»/«.» → una línea del servicio (sin bucles, sin menú de sedes); cierre de cortesía → silencio.
- Ficha por anuncio/texto: el texto completo de la escuela SIN el bloque de pago pegado; si el primer mensaje ya pide precio o cómo apartar (el prellenado del anuncio «¿Cuánto cuesta…? ¿Cómo aparto mi cupo?»), sale la ficha y después el mensaje de pago aparte.
- Campaña: tras la respuesta al «Sí», queda la venta marcada (payload con `venta_servicio_id`); lo siguiente que escriba lo atiende la venta.
- Seguimiento de 20 h de un lead de servicio: SOLO del servicio, con las fechas del catálogo; nunca la clase de prueba.
- Presentación del bot en una venta: sin «y tu clase de prueba».

### B — IA anclada al catálogo + verificador (`whatsapp-servicio-ia.ts`, `whatsapp-prospecto-ia.service.ts`, `whatsapp-salida-segura.ts`, nuevos `whatsapp-catalogo-para-ia.ts`, `whatsapp-verificador-montos.ts`, `whatsapp-coherencia-ficha.ts`; UI de aviso en la pantalla donde la escuela edita la ficha de prospectos)
- Bloque de catálogo para el modelo (todos los servicios vigentes): fechas en Bogotá, precio de hoy, tramos con «hasta el D-1 / desde el D» correctos, afiliado, abono, opciones, cuentas + titular, descripción completa. Regla en el prompt: el catálogo manda sobre la ficha libre.
- `responderPreguntaDeServicio` real: modelo restringido a los datos del ítem; contesta edad, sexo, qué incluye, días, horario, lugar, titular, abono, «¿con el pago ya tengo el cupo?» (sí, la escuela lo confirma al validar); lo que no está → `no_se`.
- Verificador de salida para todo texto de IA hacia prospectos (prospecto IA, seguimiento, servicio): montos y fechas de precio deben pertenecer al conjunto permitido (catálogo, abono, afiliado, precio de clase de prueba, planes); si no, se reintenta una vez con la corrección y si no, no sale (fallback determinista). Se registra la violación en el payload.
- Auditor de coherencia ficha ↔ catálogo (puro + endpoint + script): «la ficha dice preventa hasta el 9; el catálogo dice hasta el 10». Aviso visible en la pantalla de la escuela.

### C — Comprobantes de venta (`bff/src/jobs/whatsapp-queue.job.ts`, `wa-cobro-desde-comprobante.service.ts`, `whatsapp-comprobante-de-ficha.service.ts`, `whatsapp-respuesta-de-cobro.service.ts`)
- Si el número tiene venta activa (o un esperado vivo de un motivo de servicio): el comprobante crea/aplica el cobro del servicio para el lead (crearlo si no existe) o para el deportista si es familia (precio afiliado). Monto = precio del tramo vigente a la fecha del pago, o abono ≥ mínimo (queda parcial), o saldo de un abono anterior (mismo cobro). Si falta el nombre de quien asiste: «¿Nombre completo de quien asiste a {servicio}?» (una vez) — nunca «¿de qué deportista?» contra el padrón.
- Respuestas con sabor de venta: «Recibí tu comprobante de $X para {servicio} a nombre de {Y}. La escuela lo valida y te confirma el cupo por aquí».
- Duplicado (mismo sha o referencia) → «ya lo teníamos», sin cobro nuevo. Monto que no cuadra → a la escuela con motivo claro, y se le dice a la persona.
- Regresión fija: el caso Nicolás (4 fotos, ficha pegada a mano por la escuela 4 días antes).

### D — Panel de pagos por tipo (`frontend/src/pages/PaymentsAutomationPage.tsx` + helper nuevo en `frontend/src/lib/`)
- Etiqueta de tipo en cada fila (Por validar, Historial, Operaciones, Glosas) y filtro por tipo con conteo.
- Cobros de servicio: nombre del servicio (del concepto o del ítem) y el nombre de quien asiste (prospecto) en vez de «Sin nombre», con la marca «Externo» si no es del club.
- Pruebas del helper (vitest).

### E — Lista de seguimiento de conversaciones (nuevo `bff/src/services/whatsapp-seguimiento-conversaciones.service.ts` + `bff/src/routes/whatsapp-seguimiento.routes.ts` + `frontend/src/components/whatsapp/SeguimientoConversaciones.tsx` + pestaña en `WhatsAppPage.tsx`)
- Por conversación en un rango (por defecto 14 días): contacto, tema (servicio / clase de prueba / familia / otro, con `ventaActiva`), primer mensaje, último mensaje y de quién (Persona / Escuela / Bot), ¿respondió la escuela?, ¿respondió el bot?, esperando respuesta desde, datos de pago enviados, comprobante recibido, cobro y estado, preguntas pendientes para la escuela. Filtros por servicio y «sin responder». Exportar CSV.
- Una lectura por consulta (escuela + rango, columnas mínimas, tope), nada de N+1 (regla de Disk IO).

### F — Batería de pruebas (`bff/scripts/qa-embudo.ts` bloque `ventas`, pruebas vitest de escenarios)
- Todos los caminos de una venta para cada escuela con servicios activos y para un ítem sintético (otra escuela): anuncio con prellenado, «más info», «Sí» de campaña, precio, cómo apartar, titular, llave, edad < mínima, femenino, un solo día, otra fecha, hola/ok/./gracias a mitad de la venta, pedido explícito del club (sale), comprobante completo/abono/saldo/afiliado/duplicado/monto raro, «ya pagué», seguimiento de 20 h, familia afiliada, servicio vencido, servicio sin precio, escuela sin cuentas, borde de tramo (día 10 vs 11 con reloj fijo).
- Reproducción de las conversaciones reales de la clínica (texto de los entrantes) por `turnoSimulado`: ninguna salida puede traer menú de sedes, clase de prueba, «9 de noviembre» ni un monto fuera del catálogo.

### G — Operación (hilo principal)
- Contestar y cerrar a los interesados con ventana abierta (hecho 2026-11-08 13:18, 21 conversaciones, `bff/scripts/wa-enviar-mensajes.ts`).
- Corregir la ficha de prospectos de Monster (fechas, edad, sexo, titular, dos jornadas).
- Integración, pruebas completas, push a develop y main, verificación de despliegue (Render + Vercel).

## 5. Criterios de aceptación

- `npm test` del BFF y del frontend en verde, `tsc` limpio en los dos, `npm run qa:embudo` sin regresiones + bloque `ventas` 100 %.
- Reproducción de las conversaciones reales de la clínica sin ninguna salida prohibida.
- Ninguna migración nueva salvo que sea imprescindible (si hace falta, por `npm run migrations:new` y aplicada antes de promover).
