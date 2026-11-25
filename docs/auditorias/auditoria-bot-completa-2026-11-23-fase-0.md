# Auditoría completa del bot de WhatsApp — Fase 0: inventario y arquitectura

Fecha: 2026-11-23 · Zona horaria: America/Bogota · Solo lectura. Nada implementado.

Este archivo es el inventario de la Fase 0. Las fases 1 a 11 no han empezado: esperan aprobación.

## Cómo se hizo y qué tan confiable es

- Tres lectores automáticos recorrieron el código en paralelo (arquitectura, datos y configuración, intenciones y flujos). Las secciones A, B y C son su salida, sin editar.
- La versión desplegada, el censo de academias y los ajustes de aprobación automática los saqué yo, con `git` y consultas de solo lectura a la base.
- **Nada de lo que dicen A, B y C fue verificado por una segunda lectura.** Cada afirmación trae `archivo:línea` para comprobarla. Lo marcado «NO VERIFICADO» es suposición del lector.
- **Lo que no se cubrió:**
  - Unas 100 consultas de `whatsapp-bot.service.ts` no se revisaron una por una para el filtro por academia.
  - Los cuerpos de las RPC de la base no se leyeron.
  - Los servicios grandes de venta, cortesía y embudo se inventariaron por sus pasos y funciones, no línea a línea.
  - La columna de pruebas de la sección C es por mención del paso o la función, no por rama cubierta.
- En el árbol local hay trabajo sin commit (cierre por cupo y cuatro arreglos de venta). Donde se cita va marcado «sin desplegar».

## 0.1 Versión desplegada frente a `main`

- **No se pudo verificar qué commit corre en Render.** No hay acceso a Render desde esta sesión y `GET /health` solo devuelve la versión del paquete (`bff/src/index.ts:346`).
- Consulta para correr: en Render › `sportmaps-bff-prod` › Events, el commit del último deploy; compararlo con `77ea63b1` (cabeza de `main` el 22-nov a las 11:30).
- `render.yaml` define tres servicios del BFF: `sportmaps-bff-dev` (rama `develop`), `sportmaps-bff-stg` (rama `staging`) y `sportmaps-bff-prod` (rama `main`). Los tres comparten la misma base.
- Diferencia real de contenido entre `main` y `develop` en `bff/src`: 9 archivos y 659 líneas, todas del bot (acuse de «recibido» por escuela, registro de avisos por plantilla y enlace del grupo del servicio).
- Hipótesis por verificar: si `sportmaps-bff-dev` está encendido con los cron activos, corre la cola de comprobantes y las campañas contra la base de producción con código de `develop`.

## 0.2 Academias con el bot conectado (últimos 30 días)

| | Monster's Volley Club | Dynasty Volley Club | Escuela Pruebas |
|---|---|---|---|
| Integración | activa | activa | activa |
| Conversaciones | 922 | 682 | 0 |
| Mensajes entrantes | 7.634 | 10.438 | 0 |
| Respuestas del bot | 1.934 | 1.582 | 0 |
| Modo | auto, con IA | auto, con IA | auto, con IA |
| Modo discreto | no | sí (global) | sí (global) |
| Responde a desconocidos / a prospectos | no / sí | sí / sí | no / sí |
| Crea cobro desde el comprobante | sí | no | no |
| Responde precios | no | sí | no |
| Transcribe audios sin consentimiento | sí | sí | no |
| Ficha libre (caracteres) | 5.539 | 1.350 | 0 |
| Servicios activos | 1 | 0 | 0 |
| Campañas / anuncios mapeados | 4 / 21 | 0 / 0 | 0 / 0 |
| «Por clasificar» pendientes | 23 | 65 | 0 |
| Aprobación automática de comprobantes | apagada (tope $400.000) | apagada (tope $600.000) | apagada |
| Pausa del plan automática | encendida | encendida | encendida |
| Acuerdo de pago automático | encendido | encendido | encendido |

Dos lecturas de esta tabla:

- **El bot se comporta distinto en cada academia por ajustes que casi nadie ve.** En Dynasty el modelo no corre para familias (modo discreto); en Monster sí.
- **La pausa del plan y el acuerdo de pago se conceden solos en las dos academias.** La aprobación automática de comprobantes está apagada en ambas; aun así, en un chat de Monster el bot dijo «apliqué tu pago… queda al día» (chat 5c6e24 de la auditoría del vacacional). Hay otro camino que aplica pagos y queda por identificar en la Fase 2.

## 0.3 Lo más riesgoso que salió del inventario

Son candidatos a hallazgo, no hallazgos: se confirman o se descartan en las fases siguientes.

| # | Riesgo | Evidencia | Fase que lo verifica |
|---|---|---|---|
| 1 | La cola de comprobantes envía mensajes directo, sin pasar por el envío común: se salta la ventana de 24 h y el modo asistido. | `bff/src/jobs/whatsapp-queue.job.ts:5331-5402` | 7 y 8 |
| 2 | La cola crea cobros desde lo que leyó el OCR, y aplica comprobantes de números sin ficha al deportista que la persona nombró. | `bff/src/services/wa-cobro-desde-comprobante.service.ts:675-733`; `whatsapp-queue.job.ts:4909-4990` | 2 |
| 3 | Vínculo de cuenta por teléfono sin código de verificación: con coincidir el número se accede a saldo y enlaces de pago. | `bff/src/services/whatsapp-bot.service.ts:2204-2232` | 6 |
| 4 | Dos consultas de pagos no filtran por academia y validan después en memoria. | `bff/src/routes/whatsapp-admin.routes.ts:588`; `whatsapp-metricas.routes.ts:266` | 6 |
| 5 | Si una conversación queda bloqueada más de 100 s, el mensaje se queda sin respuesta y sin reintento. Un error al tomar el bloqueo hace correr el turno sin bloqueo. | `bff/src/services/whatsapp-turno-agrupado.service.ts:118-125, 167-170` | 8 |
| 6 | Los re-avisos de una urgencia sin responder los dispara el siguiente mensaje entrante, no un cron: sin tráfico, no hay re-aviso. | `bff/src/routes/whatsapp.ts:90-110` | 9 |
| 7 | Las palabras de baja son seis y se comparan contra el mensaje completo. «No más mensajes» o «cancelar» no dan de baja. | migración `20260909222343…:275` | 3 y 7 |
| 8 | No hay borrado de chats ni de comprobantes. Una migración promete borrar comprobantes a 90 días y el job no existe. | `supabase/migrations/20260911170115_whatsapp_cola_comprobantes.sql:116` | 7 |
| 9 | El mismo dato de negocio vive en cuatro sitios (tabla, ficha libre, descripción del servicio, plantilla) y solo se contrastan matrícula, inscripción, uniforme y camiseta. | `bff/src/services/whatsapp-precios-escuela.service.ts:82-91` | 4 |
| 10 | Hay texto de una academia escrito a mano en el código, ya falso («la clínica es mañana y el domingo, 21 y 22 de noviembre»). | `bff/src/services/whatsapp-anuncio-destino.ts:232-235` | 4 |
| 11 | Un proveedor de LLM retirado por los datos de menores vuelve a activarse con una variable de entorno. | `bff/src/services/llm.service.ts:395-396, 412-422` | 6 y 7 |
| 12 | Un solo interruptor apaga cola, campañas, reintentos y desenlaces de pago a la vez. | `bff/src/jobs/maintenance.job.ts:64-71` | 8 |

## 0.4 Tamaño de lo que hay que auditar

- **174 flujos:** 49 de ventas, 58 de gestión, 23 de marketing, 13 informativos y 31 transversales.
- **161 se deciden por regla fija, botón, job o ruta; 13 los decide o redacta el modelo.** Aparte, unos 20 flujos de la cola usan un modelo solo para leer la imagen o transcribir el audio.
- **Pruebas del bot:** 206 archivos y cerca de 3.653 casos. Solo 3 flujos no tienen ninguna prueba; ocho más tienen cobertura débil (lista en la sección C).
- **Datos:** unas 45 tablas, unas 40 RPC y cerca de 820 consultas en 102 archivos, todas con una sola llave de servicio.
- **Configuración:** unas 70 variables de entorno, y la mayoría de los ajustes por academia sin pantalla.

---

# Sección A — Arquitectura

## A · Fase 0 · Parte A — Arquitectura del bot de WhatsApp (solo lectura)

Fecha de lectura: 2026-11-22 · rama `develop` (HEAD c7b63a14) · rutas relativas a `bff/src/`.
Convención: `archivo:línea`. «NO VERIFICADO» = deducido de comentarios o nombres, sin leer el cuerpo.
«SIN DESPLEGAR» = cambio local sin commit (`whatsapp-anuncio-destino.ts` +30/-8, `whatsapp-venta-servicio.ts` +77, `plataforma-wa-leads.service.ts` 1 línea, y el archivo nuevo `wa-cupos-de-servicio.service.ts`, que solo importa `whatsapp-anuncio-destino.ts:52`).

Tamaño: ~81.000 líneas de código no-test con WhatsApp/LLM. Los dos núcleos: `services/whatsapp-bot.service.ts` (8.867 líneas) y `jobs/whatsapp-queue.job.ts` (5.869).

---

## A · 1. Canales y entradas

### 1.1 Webhook de Meta (único, multi-escuela)

| Qué | Dónde | Detalle |
|---|---|---|
| Montaje | `index.ts:379` | `/api/v1/webhooks/whatsapp`, SIN `generalLimiter` (control = firma + idempotencia) |
| Raw body para HMAC | `index.ts:327-332` | `express.json({ limit:'5mb', verify })` guarda `req.rawBody` |
| GET verificación | `routes/whatsapp.ts:115-129` | `hub.verify_token === WHATSAPP_VERIFY_TOKEN` → challenge; si no, 403 |
| POST firma | `routes/whatsapp.ts:134-140` + `services/whatsapp.service.ts:101-124` | HMAC-SHA256 con `WHATSAPP_APP_SECRET`, `timingSafeEqual`; sin secreto = fail-closed (401) |
| Respuesta | `routes/whatsapp.ts:146` | 200 inmediato; TODO lo demás corre después, en memoria del proceso |
| Orden tras el 200 | `routes/whatsapp.ts:150-191` | mensajes (en serie) → estados → eventos de cuenta → echos Coexistence → historial → app state → revisión de plazos de escalación |
| Ruteo a escuela | `whatsapp.service.ts:137-162` | `phone_number_id` → `school_whatsapp_integrations` (solo `status='active'`), caché 5 min / 500 entradas |
| Bloqueo por número | `routes/whatsapp.ts:436-443` | RPC `wa_is_blocked` |
| Ingesta | `routes/whatsapp.ts:452-464` | RPC `wa_ingest_inbound_message` (upsert conversación + insert mensaje + detección de STOP) |

### 1.2 Tipos de mensaje: qué se acepta y qué se descarta

| Tipo | Destino | Evidencia |
|---|---|---|
| `reaction` | Se descarta en el parser (ni se guarda) | `whatsapp.service.ts:833` |
| Tipo fuera del CHECK (contacts, order…) | Se guarda como `unsupported` (original en `raw.type`) | `whatsapp.service.ts:799-802, 838` |
| Sin `from`/`id`/`phone_number_id` | No se procesa; solo la forma queda en `whatsapp_account_events` (`inbound_descartado`) | `routes/whatsapp.ts:372-413` |
| Sin `from` pero con `from_user_id` (usuario de Meta sin teléfono) | Entra con alias del BSUID | `whatsapp.service.ts:869-875` |
| `image`, `document` | 1º soporte de ficha (oleada 1); si no, **cola de comprobantes**; mime fuera de jpeg/png/webp/pdf → aviso fijo | `routes/whatsapp.ts:568-598`, `whatsapp-queue.service.ts:25-27, 56-66` |
| `unsupported` | `revoke`/`edit` se ignoran; el resto abre buzón y pide reescribir 1 vez/24 h | `routes/whatsapp.ts:605-627` |
| `interactive` `nfm_reply` (Flows) | Handler de formulario con token firmado, sin modelo ni ráfaga | `routes/whatsapp.ts:633-641` |
| `sticker`, `location`, `template`, `system` | Guardado, el bot no responde | `routes/whatsapp.ts:645-650` |
| `text`, `interactive`, `button` | Turno del bot (ver §6) | `routes/whatsapp.ts:831` |
| `audio` | Transcripción si la escuela lo activó y hay consentimiento; si no, aviso fijo | `routes/whatsapp.ts:779-789`, `whatsapp-notas-de-voz.service.ts:186-236` |
| `video` | Respuesta fija solo si el texto cercano habla de pago, máx. 1/24 h | `routes/whatsapp.ts:799-816` |
| Contacto marcado `personal` | Solo metadatos: sin texto, sin payload con contenido, sin cola ni audio | `routes/whatsapp.ts:451, 461-462, 481-484` |

Otros campos del webhook: estados de entrega y cobro de Meta → `whatsapp_messages` (`routes/whatsapp.ts:206-258`); eventos de cuenta (`message_template_status_update`, calidad, `account_update`, `flows`…) → `whatsapp_account_events` (`routes/whatsapp.ts:261-368`); echos e historial de Coexistence (`routes/whatsapp.ts:178-189`).

### 1.3 Canal «plataforma» (número de SportMaps)

- Se detecta ANTES de `resolveIntegration` por `phone_number_id` (`routes/whatsapp.ts:419-426`); nunca toca tablas `whatsapp_*` de una escuela. Estados van a `platform_wa_mensajes` (`routes/whatsapp.ts:214-217`).
- Decisión por clase de contacto (`plataforma-wa-entrante.service.ts:110-177`): tester (`PLATFORM_WA_TESTERS`) → modo pruebas; `PLATFORM_WA_ENABLED` + ACTIVAR/DESACTIVAR/AYUDA → suscripción; suscriptor activo → ayuda 1 vez/24 h; desconocido → Mapi de leads si `PLATFORM_WA_LEADS_MAPI` (LLM, §3), o respuesta comercial fija 1 vez/30 días si `PLATFORM_WA_RESPUESTA_COMERCIAL=true`, o silencio.
- Idempotencia propia: `registrarMensaje` por `wa_message_id` (`plataforma-wa-entrante.service.ts:132-137`).
- Número por defecto del canal escrito en el código como último respaldo (`plataforma-wa.service.ts:130`).
- Admin (super admin): `/api/v1/admin/whatsapp-plataforma` — estado, conectar/desconectar, interruptor, freno global de campañas, pausa por escuela, plantillas, prueba (`routes/admin-whatsapp-plataforma.routes.ts:39-126`, montaje `index.ts:557`).
- Lado escuela (opt-in de dueñas a avisos): `/:schoolId/avisos-sportmaps` GET/POST/PATCH/DELETE (`routes/whatsapp-plataforma.routes.ts:71-174`).

### 1.4 Buzón / bandeja del staff y rutas admin

Todo bajo `/api/v1/whatsapp` con `generalLimiter` y `requireAuth` por ruta (`index.ts:392`).

| Router | Rutas principales | Archivo:línea |
|---|---|---|
| Panel/ajustes | `GET /:schoolId`, `PATCH /:schoolId/settings`, `POST /:schoolId/conectar`, `POST /:schoolId/ponerse-al-dia`, `GET /:schoolId/eventos` | `routes/whatsapp-admin.routes.ts:134, 256, 1873, 354, 866` |
| Bandeja de comprobantes | `GET /bandeja`, `POST /bandeja/:filaId/cerrar`, `POST /bandeja/cerrar-lote`, `GET /notas-de-comprobantes` | `whatsapp-admin.routes.ts:703, 764, 823, 403` |
| Buzón de conversaciones | `GET /conversaciones`, `GET /conversaciones/:id`, `PATCH …/tipo`, `POST …/cerrar`, `POST …/responder`, `POST …/tomar`, `POST …/soltar` | `whatsapp-admin.routes.ts:1299, 1534, 1442, 1514, 1585, 1679, 1704` |
| Borradores (modo asistido) | `POST /borradores/:draftId/aprobar`, `…/descartar` | `whatsapp-admin.routes.ts:1731, 1821` |
| Plantillas | `GET/POST /plantillas`, catálogo | `whatsapp-admin.routes.ts:896, 954, 1056, 1076` |
| Buzón extra | búsqueda, media de un mensaje, enviar plantilla a una conversación | `routes/whatsapp-buzon.routes.ts:91, 224, 314, 341` |
| Por clasificar | listar, dueños, cobros abiertos, aplicar, crear servicio | `routes/whatsapp-por-clasificar.routes.ts:88-273` |
| Métricas / seguimiento / coherencia | `GET /metricas`, `GET /seguimiento`, `GET /coherencia-ficha` | `whatsapp-metricas.routes.ts:99`, `whatsapp-seguimiento.routes.ts:32`, `whatsapp-coherencia.routes.ts:56` |
| Precios del bot | `GET /precios`, `PUT` interruptores/matrícula/clase-prueba, artículos | `routes/whatsapp-precios-escuela.routes.ts:68-82` |
| Anuncios (CTWA) | embudo por anuncio y destino por `sourceId` | `routes/whatsapp-anuncios.routes.ts:46-113` |
| Cortesías, importar chat | | `whatsapp-cortesias.routes.ts:41-92`, `whatsapp-importar-chat.routes.ts:70, 128` |

«Tomar» una conversación calla al bot (envío y borrador) por `WHATSAPP_TOMADA_HORAS` (12 h por defecto, `whatsapp-tomada.service.ts:33`); se respeta en `runBotTurn` (`whatsapp-bot.service.ts:418`), en `deliver` (`:7175`) y en el worker (`whatsapp-queue.job.ts:5483`).

### 1.5 Formularios (WhatsApp Flows)

- Envío: `sendFlowMessage` (`whatsapp-flows.service.ts:572`), solo desde `deliver` en modo auto (`whatsapp-bot.service.ts:7297-7301`); en modo asistido el formulario NO deja borrador (`:7356-7359`).
- Token firmado: `firmarTokenFormulario` / `verificarTokenFormulario` (`whatsapp-flows.service.ts:437, 460`); el secreto sale de una variable cuyo nombre está en la constante `ENV_SECRETO_TOKEN` (`:422`) — nombre exacto NO VERIFICADO.
- Respuesta: `atenderRespuestaDeFormularioEnBot` (`whatsapp-bot.service.ts:2982`). Formulario no entregado (131026) → sigue por chat (`routes/whatsapp.ts:247-251`, `whatsapp-bot.service.ts:3068`). Estado del flow sincronizado desde el webhook (`routes/whatsapp.ts:355-357`).

### 1.6 Campañas

- Rutas escuela: crear, activar (con declaración), simular, reporte, aprobar, pausar/reanudar (`routes/whatsapp-campanas.routes.ts:62-267`).
- Motor: `runCampanas` (`whatsapp-campanas.service.ts:643`), cada 10 min (§2). Freno por calidad y bajas en `whatsapp-campanas-freno.ts:53, 130`; tope de Meta 131049 en `whatsapp-campanas.service.ts:376`; máx. 3 intentos (`:371`). Freno global y pausa por escuela desde super admin (`:1332-1356`).
- Respuestas a campaña (botones `smc:<campaña>:si|luego|baja` o «no me interesa»): se atienden ANTES de `debeAtender`, sin depender del asistente (`routes/whatsapp.ts:666-673`).

---

## A · 2. Colas y jobs

Arranque: `index.ts:633-641` solo si `debenCorrerLosCrons()` (Render o `CRONS_LOCALES=true`, `jobs/crons-solo-en-render.ts:18-24`). Interruptor global `CRONS_ENABLED=false` (`jobs/maintenance.job.ts:73-76`). **Los tres BFF comparten una sola base** y el comentario del propio código dice que al 2026-10-27 `sportmaps-bff-dev` NO tenía `CRONS_ENABLED=false` (`maintenance.job.ts:64-71`).

| Job | Frecuencia | Qué hace | Kill-switch | Idempotencia / cola | Línea |
|---|---|---|---|---|---|
| Cola de comprobantes `runWhatsAppQueue` | cada minuto | claim de 10 filas, lease 5 min, máx. 5 reintentos; baja archivo, guarda en bucket `payment-receipts`, OCR, aplica | `DISABLE_WHATSAPP_QUEUE_CRON` | `whatsapp_inbound_queue` + RPC `wa_queue_claim` (`FOR UPDATE SKIP LOCKED`) | `maintenance.job.ts:540-551`, `whatsapp-queue.job.ts:141-144, 5803-5810` |
| Barrido de turnos perdidos | cada minuto | relanza turnos anotados que murieron en un reinicio | mismo | `whatsapp_turnos_pendientes` | `maintenance.job.ts:557-569` |
| Desenlace del comprobante `runWhatsAppPaymentOutcome` | cada minuto | avisa aprobado/rechazado/abono al chat; plantilla si la ventana cerró | mismo | `outcome_notified_at` en la fila de la cola | `maintenance.job.ts:628-637`, `whatsapp-payment-outcome.job.ts:1-40` |
| Seguimiento 20 h a prospectos | min 7,22,37,52 | escribe al interesado que dejó de contestar (ventana abierta); usa LLM (§3) | mismo | NO VERIFICADO | `maintenance.job.ts:573-585` |
| Barrido «sin respuesta» | cada 30 min | avisa a la escuela conversaciones sin respuesta | mismo + requiere `WA_BARRIDO_SIN_RESPUESTA=true` (apagado por defecto) | NO VERIFICADO | `maintenance.job.ts:589-602` |
| Rescate por plantilla | min 12,42 | plantilla `seguimiento_interesado` con consentimiento | mismo | NO VERIFICADO | `maintenance.job.ts:606-618` |
| Vencimiento de comprobantes colgados | cada 2 min | alerta desde 5 min; a los 10 min pasa a la escuela y avisa 1 vez a la familia | `DISABLE_WHATSAPP_COLA_VENCIMIENTO` (propio, a propósito) | NO VERIFICADO | `maintenance.job.ts:783-798` |
| Mantenimiento del buzón | cada 15 min | conversaciones sin actividad 48 h → `closed`; borradores >24 h → `expired` | `DISABLE_WHATSAPP_QUEUE_CRON` | idempotente por estado | `maintenance.job.ts:811-819` |
| Sync de plantillas Meta | cada 30 min | estado de plantillas por WABA | mismo | — | `maintenance.job.ts:830-838` |
| Cupos separados + clases reprogramadas | cada 15 min | aviso «tu cupo vence», libera o confirma | mismo (el comentario nombra `DISABLE_CUPOS_SEPARADOS`; NO VERIFICADO dónde se lee) | marcas en el lead | `maintenance.job.ts:1270-1284` |
| Campañas `runCampanas` | cada 10 min | envíos de marketing | mismo | lease por envío (`whatsapp-campanas.service.ts:414`) | `maintenance.job.ts:1292-1304` |
| «Sigue en fila» | min 5,20,35,50 · 8–18 h · lun–sáb | 1 confirmación a quien espera a una persona >2 h hábiles | mismo | NO VERIFICADO | `maintenance.job.ts:1313-1323` |
| Recordatorios de cobro por WhatsApp | L–V 8:00 COT | plantillas -3/-1/0/+3/+10/+20 | `DISABLE_RECORDATORIOS_COBRO_WHATSAPP` | 1 contacto por familia y día en base | `maintenance.job.ts:442-450` |
| Estado de cuenta mensual | L–V 8–12 COT | correo o WhatsApp | `DISABLE_ESTADO_CUENTA_MENSUAL` | 1 por familia y mes | `maintenance.job.ts:420-427` |
| Comprobantes por validar (a la escuela) | cada 5 min | in-app + push | `DISABLE_RECEIPT_REVIEW_ALERTS` | versión en `school_receipt_review_alerts` | `maintenance.job.ts:650-659` |
| Pagos por validar (resumen) | 07:30 y 17:00 COT | correo | `DISABLE_PAGOS_POR_VALIDAR`, solo `NODE_ENV=production` | `email_sends` | `maintenance.job.ts:676-694` |
| Resumen de cuentas | 7, 11, 15, 19 h COT | correo a escuelas de `RESUMEN_CUENTAS_ESCUELAS` | `DISABLE_RESUMEN_CUENTAS` | `email_sends` | `maintenance.job.ts:703-719` |
| Acuerdos de pago | cada hora + 06:30 UTC | recordatorio de cuota | `DISABLE_ACUERDOS_CRON` | `reminded_at` | `maintenance.job.ts:729-747` |
| Recordatorio / seguimiento de cortesía | 18:00; cada 15 min 7–19 h; 20–21 h; 21:30 | avisos de la clase de prueba | `DISABLE_RECORDATORIO_CORTESIA`, `DISABLE_SEGUIMIENTO_CLASE_CORTESIA`, `DISABLE_CORTESIA_VENCIDA_CRON`, `DISABLE_FRANJAS_CORTESIA` | NO VERIFICADO | `maintenance.job.ts:1111-1248` |
| Resumen diario WhatsApp | 07:00 COT | correo a owner+admins | `DISABLE_WHATSAPP_RESUMEN_CORREO` | `email_sends` | `maintenance.job.ts:852-861` |
| Resumen semanal de bots | lun 07:05 | correo a SportMaps | `DISABLE_BOT_RESUMEN_SEMANAL_CORREO` | `email_sends` | `maintenance.job.ts:871-880` |
| Informe calidad y costo del bot | lun 08–11 h | usa `llm_usage` | `DISABLE_INFORME_CALIDAD_BOT` | `email_sends` | `maintenance.job.ts:892-901` |
| Vigilante del bot | lun–sáb 07:15–10:15 | comprobantes sin desenlace, sin respuesta, repeticiones | `DISABLE_WHATSAPP_VIGILANTE` | `email_sends` | `maintenance.job.ts:914-923` |

Trabajos que NO son cron:
- **Plazos de escalación y retomas**: los dispara el propio webhook, como mucho 1 vez/min y 1 vez/5 min por proceso, con estado en memoria (`routes/whatsapp.ts:90-110`); apagable con `DISABLE_WHATSAPP_PLAZO_ESCALACION`. Sin tráfico entrante no corren (salvo el barrido opcional de arriba).
- **Acuse diferido del adjunto**: `setTimeout` dentro del worker (`whatsapp-queue.job.ts:5438-5456`).

Estados de `whatsapp_inbound_queue` vistos: `pending`, `processing`, `waiting_user`, `waiting_review`, `done`, `ignored`, `failed` (`whatsapp-queue.job.ts:466, 524, 563, 595, 3749`).

---

## A · 3. LLM

### 3.1 Proveedores, modelos y uso

| Función | Entrada | Modelo por defecto | Orden de respaldo | Timeout | Evidencia |
|---|---|---|---|---|---|
| Bot de familias (intents + redacción) | `chatWithTools` | Claude `claude-sonnet-5-5`, esfuerzo `low`, `max_tokens` 2048 | Claude (si hay llave) → `WHATSAPP_LLM_PROVIDER` (def. `gemini`) → Gemini `gemini-flash-latest` → Groq `openai/gpt-oss-120b` | 20 s por llamada (`WHATSAPP_LLM_TIMEOUT_MS`); Claude `maxRetries: 1` | `llm.service.ts:78, 85, 110, 274, 283, 395-424` |
| Prospecto (respuesta y seguimiento 20 h) | `chatWithTools` sin tools | `claude-haiku-5-5` (`WHATSAPP_PROSPECTO_MODEL`) | misma cadena | 20 s | `whatsapp-prospecto-ia.service.ts:57, 325-332` |
| Preguntas sobre un servicio en venta | `chatWithTools` sin tools | igual que prospecto | misma cadena | 20 s | `whatsapp-servicio-ia.ts:228-233` |
| Leads del canal plataforma | `chatWithTools` con `provider:'claude'` | `claude-haiku-5-5` (`PLATFORM_WA_LEADS_MODEL`) | claude → gemini → groq | 20 s | `plataforma-wa-leads.service.ts:324-330` |
| OCR de comprobantes | `extractReceipt` | Gemini `gemini-flash-latest` (`GEMINI_MODEL`) | `OCR_PROVIDER` (def. gemini) → gemini → openai `gpt-4o-mini` → claude `claude-haiku-5-5` → groq (solo si `GROQ_OCR_MODEL`) | 20 s (30 s OpenAI imagen y Claude PDF) | `ocr.service.ts:117, 178, 224, 276-278, 347, 370-375, 498-513` |
| Doble lectura de comprobante | `extractReceiptWithFallback` | dos proveedores distintos | gemini, claude, openai, groq | — | `ocr.service.ts:560-609` |
| Transcripción de audio | `transcribirAudio` | Groq `whisper-large-v3` | → OpenAI `gpt-4o-mini-transcribe` | 15 s | `transcripcion.service.ts:28, 130, 159, 190-204` |
| Segundo lector de ausencias | `clasificarMensajeFamilia` | `gemini-decision-1` en `…/v1beta/decisions` | ninguno (sin llave o si falla, no hace nada) | 4 s | `gemini-decisions.service.ts:26-27, 135`, `whatsapp-bot.service.ts:800-805` |
| Mapi dentro de la app (no WhatsApp) | `chatWithTools` | — | — | — | `inapp-support-bot.service.ts:205` |

Notas:
- Reintentos por saturación (429 / quota): 3 intentos por proveedor con espera ~400 ms y ~1200 ms con jitter (`llm.service.ts:442-472`).
- `claude_refusal` NO pasa al siguiente proveedor: corta la cadena (`llm.service.ts:453-458`).
- DeepSeek «salió» de la cadena por protección de datos (`llm.service.ts:412-419`), pero sigue definido (`:100-104`) y **vuelve a entrar si `WHATSAPP_LLM_PROVIDER=deepseek`**, porque `primary` se inserta en el orden sin filtro (`:395-396, 422`).
- La llave de Gemini viaja en la URL (`?key=`) (`llm.service.ts:126`, `ocr.service.ts:371`).
- Caché de prompt de Claude: 1 h por defecto, puntos de corte en sistema y última herramienta (`llm.service.ts:297-303, 343, 351`).
- La API «Decisions» de Gemini y el modelo `gemini-decision-1`: existencia NO VERIFICADA (no se llamó a nada).

### 3.2 Registro de consumo

- Tabla `llm_usage`; `registrarUsoLlm` inserta best-effort y falla en silencio (`llm-usage.service.ts:159-167`); precios en `PRECIOS_POR_MILLON` (`:213`). Se apaga con `DISABLE_LLM_USAGE_LOG`.
- Contexto (escuela, conversación, función) por `AsyncLocalStorage`: `feature:'bot'` desde el webhook (`routes/whatsapp.ts:522`), `feature:'ocr'` en el worker (`whatsapp-queue.job.ts:5266`), `'transcripcion'` (`transcripcion.service.ts:216`).
- Fallas de proveedor del turno quedan en `payload.llm_fallas` del saliente o `tool_context` del borrador (`whatsapp-bot.service.ts:7215-7217`).
- Claude además escribe el uso a consola (`llm.service.ts:358-364`).
- Salud: `GET /health/ai` solo super_admin (`index.ts:358-360`); sondea metadatos, no detecta saldo agotado (memoria del proyecto: Gemini 402 el 11-20).

### 3.3 Qué pasa si todos fallan

| Caso | Comportamiento | Evidencia |
|---|---|---|
| 1ª llamada del bot (elegir herramienta) | `responderSinModelo`: respuesta determinista, NO escala | `whatsapp-bot.service.ts:6821-6829` |
| 2ª llamada (redactar) | texto de respaldo determinista con los datos ya consultados (`fallbackPaymentText`, `fallbackMediosDePago`, `fallbackInfoEscuela`) | `whatsapp-bot.service.ts:6916-6921, 6951-6957, 7006-7014` |
| Prospecto / servicio | `null` o `no_se` → acuse fijo «pasé tu mensaje a la escuela» y buzón | `whatsapp-prospecto-ia.service.ts:240`, `whatsapp-servicio-ia.ts:253-256`, `whatsapp-bot.service.ts:4900-4933` |
| Leads plataforma | texto fijo de escalación | `plataforma-wa-leads.service.ts:333-336` |
| OCR | la fila vuelve a `pending` (`reintentar`), hasta 5; después `failed` por el claim; el job de vencimiento avisa a los 5/10 min | `whatsapp-queue.job.ts:5639-5642`, migración `20260911170505` líneas 31-36 |
| Transcripción | cae al aviso fijo de «no puedo escuchar» (detalle NO VERIFICADO) | `whatsapp-notas-de-voz.service.ts:319` |

---

## A · 4. Prompts de sistema y guardas de salida

| Prompt | Dónde se arma | Bloques que recibe | Guardas después del modelo |
|---|---|---|---|
| **Bot de familias** `SYSTEM_PROMPT` (constante única para todas las escuelas, ~165 líneas) | `whatsapp-bot.service.ts:6444-6610`; `promptDelSistema` solo añade 1 línea si la clase de prueba se cobra o tiene otro nombre (`:6439-6442`) | Sin ficha ni catálogo en el prompt. Historial: últimos 8 mensajes, 24 h, 400 caracteres c/u, con prefijo «(la escuela escribió)» (`:1533-1536`). Datos SOLO por resultado de herramienta, como texto de usuario rotulado (`llm.service.ts:144-150, 317-320`). `hoy` va en el resultado de `get_school_info` (`whatsapp-bot.service.ts:6904-6908`) | `entregarTextoDelModelo` (`:6690-6780`): (1) si el turno ya escaló, no sale; (2) relee si la escuela escribió mientras redactaba; (3) `filtrarSalidaDelModelo` quita nombres de herramientas, snake_case, JSON, fugas del prompt (`whatsapp-salida-segura.ts:154`); (4) quita promesas de seguimiento; (5) «promete consultar sin datos» → respaldo; (6) enlaces solo los del resultado de la herramienta (`enlacesNoPermitidos`, `:107`); (7) `afirmaDineroSinRespaldo` (`:144`). Sin texto confiable → respaldo determinista o escalar |
| **Prospecto** `promptDeProspecto` | `whatsapp-prospecto-ia.service.ts:165-232` | `<ficha>` (texto libre de la escuela, `wa_ficha_prospectos`, máx. 6000), `<catalogo>` de servicios con venta abierta, `<grupos>`, `<precios>`, `<atencion>`, `<enlace>`, `<conversacion>` (16 mensajes), estilo (`wa_estilo_respuesta`) | `salidaVerificada` (`:417-451`): filtro de salida + enlaces permitidos + **verificador de montos y fechas de precio**; si viola, UNA corrección; si vuelve a violar, no sale. Tope 8 respuestas/hora (`:58, 99-103`), 650 caracteres (`:60`). Solo corre si la escuela escribió ficha (`:261-262`) |
| **Servicio en venta** `promptDeServicio` | `whatsapp-servicio-ia.ts:139-176` | `<servicio>` (ficha del ítem, cuentas, afiliado, cobro previo), `<conversacion>` (10), `<pregunta>` | `evaluar` (`:201-210`): separa «FALTA:», `NO_SE`, filtro, `verificarSalida`; una corrección (`:240-252`); máx. 450 caracteres (`:96`) |
| **Leads plataforma** `promptDeLeads` | `plataforma-wa-leads.service.ts` (cuerpo NO VERIFICADO) | config comercial + `<mensaje>` en una línea, sin historial | `verificarRespuesta`; descartada → escalación fija (`:338-342`) |
| **OCR** | `ocr.service.ts:59-107` | imagen/PDF + esquema JSON; pide `raw_text` y marcar texto dirigido a una IA (inyección) | Veredicto por reglas en `receipt-verdict.ts`, no por «confianza» del modelo (`ocr.service.ts:59`); `isReceipt` por defecto true (`:433`) |

Verificador de montos (`whatsapp-verificador-montos.ts:1-40, 437`): cada monto y cada fecha de precio del texto debe estar en el conjunto permitido (catálogo + ficha sin las líneas que contradicen el catálogo + precios + valores fijos); ignora horas, años, edades, teléfonos y cuentas. Coherencia ficha↔catálogo: `whatsapp-coherencia-ficha.ts:116` (aviso a la escuela y entrada del verificador). **El bot de familias NO pasa por el verificador de montos**; su guarda de dinero es `afirmaDineroSinRespaldo` más el respaldo determinista.

Guardas comunes de `deliver` (todo lo que sale del bot, `whatsapp-bot.service.ts:7116-7399`): bot apagado → nada (`:7168`); conversación tomada (`:7175`); modo discreto con la escuela activa 12 h (`:7185-7191`); anti-repetición 30 min y «mismo último mensaje» 2 min (`:7226-7241`); máx. 3 emojis y sin emojis de deporte (`:7256-7258`); coletilla de baja (`:7259-7262`); ventana de 24 h cerrada → no envía (`:7280-7284`); modo asistido → borrador (`:7380-7398`).

---

## A · 5. Tools del modelo

Solo el bot de familias tiene herramientas (`TOOLS`, `whatsapp-bot.service.ts:6612-6642`). Prospecto, servicio y leads llaman sin tools.

| Tool | Parámetros | Lee | Escribe | Ejecución |
|---|---|---|---|---|
| `get_payment_status` | ninguno | RPC `wa_get_payment_status(parent_id, school_id)` + enlaces `/p/:token` por cobro | nada directo (la generación de enlaces puede crear tokens — NO VERIFICADO) | `:6975-7030`; error de la RPC → escala `tool_error` |
| `get_school_info` | ninguno | `infoDeEscuela`: sedes, deportes, grupos, horarios, atención; `no_disponible` | nada | `:6897-6933` |
| `get_payment_methods` | ninguno | `mediosDePagoDeFamilia`: cuentas, enlace, cobros pendientes | nada directo | `:6936-6972` |
| `get_trial_class_info` | ninguno | franjas de cortesía | **Sí**: arranca el flujo determinista que reserva/cancela cupo; sin 2ª llamada al modelo | `:6860-6895` |
| `escalate_to_human` | `reason` (texto libre) | — | **Sí**: `escalate` (buzón, push, correo); el motivo se rotula «Resumen del asistente (no verificado)» y se corta a 120 caracteres | `:6854-6858, 6683-6688` |

Mecánica: una sola ronda. Se usa **solo la primera tool call** (`first.toolCalls[0]`, `:6852`); el resto se ignora. El id de escuela y de acudiente los pone el código, no el modelo (ninguna tool recibe ids). La 2ª llamada va con `toolChoice:'none'` (`:6914, 6949, 7004`). Tool desconocida → escala (`:7034`). El modelo no puede aprobar pagos, crear cobros ni cambiar datos.

---

## A · 6. Reglas fijas vs. decisiones del LLM — orden de puertas

### 6.0 Puertas comunes del webhook (antes de cualquier turno)

1. Firma HMAC (`routes/whatsapp.ts:137`).
2. Campos mínimos (`:372`).
3. ¿Número de plataforma? → otro canal (`:419`).
4. Integración activa (`:429`).
5. Bloqueo `wa_is_blocked` (`:436`).
6. Contacto personal → solo metadatos (`:451, 481`).
7. Ingesta idempotente; duplicado → fin (`:452-475`).
8. Atribución por texto en segundo plano (`:489`).
9. Adjunto → soporte u cola (§6.3) (`:568`).
10. `unsupported` (`:605`) · formulario (`:633`) · tipo no conversacional (`:647`).
11. Asistencia del equipo («lista», `asis_*`) — corre con el bot apagado (`:658, 870-893`).
12. Respuesta a campaña (`:666`).
13. `debeAtender` (`:693`, `whatsapp-atencion.service.ts:236-255`): bot encendido, tipo de contacto, tomada. Familia/sin cuenta/ambiguo → atiende; desconocido → solo si `responder_desconocidos`; staff y marcas manuales → nunca.
14. Cierre suelto de familia → conversación atendida (`:701-706`).
15. No se atiende: desconocido + bot encendido → audio de prospecto o `atenderDesconocido` (§6.2); el resto, silencio (`:707-772`).
16. Audio (`:779`) · video (`:799`).
17. `lanzarTurno`: anota el turno, espera ráfaga 10 s, último gana, candado, `runBotTurn` (`:900-930`).

### 6.1 Familia identificada (texto) — `cuerpoDelTurno`, `whatsapp-bot.service.ts:395-899`

Todo lo numerado es regla/regex/base, **sin modelo**, salvo donde se indica.

1. Bot apagado → nada (`:413`).
2. Conversación tomada → nada (`:418`).
3. Baja pedida (STOP ya registrado) → confirmar y parar (`:439`).
4. «ACTIVAR» de alguien dado de baja (`:449`).
5. Menú o bucle de otra máquina → silencio (`:457`).
6. Botón de consentimiento Sí/No (`:468`).
7. La escuela escribió hace poco (15 min; 12 h en modo discreto) → silencio, salvo pedido de un servicio del catálogo (`:482-489`).
8. Patrocinio / alianza → texto fijo + buzón (`:493`).
9. Botón de venta de servicio (`:502`).
10. Saludo suelto con la escuela activa en 3 h → silencio (`:513`).
11. Auto-respuesta de otro negocio → silencio (`:522`).
12. «ACTIVAR AVISOS» del enlace público (`:540`).
13. Audio con pregunta de cobro abierta → pedir que lo escriba (`:557`).
14. (No identificado) respuesta a pregunta de cobro / reclamo de resultado / `handleIdentification` (teléfono → OTP por correo) (`:561-588`).
15. Revisión del vínculo por teléfono (número reciclado) (`:605`).
16. Clase de cortesía en curso (`:614`).
17. Lectura de respuesta de consentimiento (`:630`).
18. Oleada 1: soportes y referidos (`:637`).
19. Factura electrónica en curso (`:645`).
20. Venta de servicio en curso (carril B) (`:654`).
21. Modo discreto: le hablan a una persona → silencio (`:664-672`).
22. Venta de servicio de familia (frente A; **puede usar LLM de servicio**, `whatsapp-servicio-ia`) (`:679`).
23. Pide clase de cortesía (o pide salir del flujo → escala) (`:693-701`).
24. Grupo por edad (`:706`).
25. Plan, plazos, pausa, retiro (`:714`).
26. Acción de botón (o su título escrito) (`:729`).
27. Respuesta a pregunta de comprobante abierta (`:744-753`).
28. **Modo discreto: `restoDelTurnoDiscreto` y FIN — el modelo no corre nunca** (`:764-768, 912-946`): cierre suelto, urgencia, comprobante en cola, horario de hoy, cómo pagar, ayuda de app, ventas; lo demás queda para la escuela.
29. Cierre suelto («gracias», «ok») → silencio (`:772`).
30. Solicitud de retiro → escala (`:781`).
31. Aviso de ausencia (**con segundo lector Gemini Decisions si hay llave**) (`:792-813`).
32. Incidencia urgente → escala urgente (`:820-825`).
33. Pide una persona / vocativo a alguien del equipo (`:831-839`).
34. Comprobante en la cola → el turno se calla (responde la cola) (`:848`).
35. Anuncia comprobante («te envío el soporte») (`:855`).
36. Reclamo de valor (`:864`).
37. «Ya pagué» (`:870`).
38. Horario de hoy (`:879`).
39. Ayuda de la app (`:885`).
40. Venta carril B nueva (`:892`).
41. **`handleIntent` — aquí entra el LLM** (`:898, 6782-7035`), con dos puertas más antes de llamarlo: la escuela estuvo en la charla y no es tema de pago → silencio (`:6796-6801`); queja contra la escuela → escala (`:6803-6806`).

Qué decide el modelo: (a) cuál de las 5 herramientas llamar o contestar texto libre; (b) la redacción final con los datos de la herramienta. Nada más.

### 6.2 Prospecto / desconocido — `atenderDesconocidoEnEscuela`, `whatsapp-bot.service.ts:4517-5184`

Previo: `debeAtender` dijo `atender=false`, tipo `desconocido`, bot encendido, no tomada, no baja, no audio/video (`routes/whatsapp.ts:719-723`). Con `responder_desconocidos=true` el desconocido va por `runBotTurn` → `handleIdentification` (`whatsapp-bot.service.ts:576`), que termina llamando a la misma lógica («como desconocido», línea relativa 99-102 de `:2421`).

1. Otra máquina (menú o bucle) → silencio (`:4487-4492`).
2. Bot apagado / sin texto ni botón (`:4528-4531`).
3. «ACTIVAR» (`:4538`).
4. Botón de consentimiento de seguimiento (`:4544`) · de novedades (`:4549`).
5. Respuesta a pregunta de comprobante (audio → pedir escrito) (`:4556-4567`).
6. Reclamo del resultado de la cola (`:4571`).
7. Oleada 1: el equipo ya dialoga (72 h) → silencio; referidos (`:4579`).
8. Venta cerrada (`:4589`) · venta de servicio activa (7 días) — **puede usar LLM de servicio** (`:4591`).
9. Disputa de pago → escuela (`:4600`).
10. Aclaración «soy del club / quiero inscribirme» (`:4612`).
11. Vino de un anuncio: destino del anuncio (`:4616`) (lógica en `whatsapp-anuncio-destino.ts`, con cambios SIN DESPLEGAR).
12. Embudo del interesado de la escuela (`:4624`).
13. Consentimiento sin cuenta (`:4631`).
14. «Llegué» el día de la clase (`:4641`).
15. Precio con cortesía abierta (`:4651`).
16. Cortesía en curso (`:4661`) · puerta única en curso (`:4671`).
17. Respuesta al seguimiento de 20 h (`:4674`).
18. Servicio nombrado sin anuncio (`:4681`).
19. «Quiero pagar una mensualidad» → pregunta de dos botones (`:4687`).
20. Código con OTP vigente (`:4694`) · correo → arranca OTP (`:4703`).
21. Se identifica como externo (otro club, proveedor) → buzón en silencio (`:4715`).
22. Cierre de cortesía sin contenido → silencio (`:4725-4733`).
23. Horario de hoy (`:4737`) · cómo pagar público (`:4743`) · ayuda de app (`:4750`).
24. Precios con `wa_responder_precios` (`:4759`) · clases del plan (`:4792`) · ventas (`:4806`).
25. **Filtro de tema**: `temaEscolar` + `puertaDeProspecto`; sin tema ni prospecto → bienvenida (si la escuela la tiene) o silencio (`:4819-4845`).
26. Registra lead (`:4850`). Escuela escribiendo → silencio (`:4859`).
27. Ya se le contestó en 30 días (`:4868`): reglas de seguimiento (`:4892`) → **si no cubren, LLM de prospecto** `responderProspectoConIa` (`:4900-4904`) → si no, acuse fijo (`:4922-4933`).
28. Primera respuesta (todo determinista): pagos+precio (`:4965`), ya reservó (`:4995`), modo discreto (`:5008`), pedir correo (`:5014`), embudo (`:5066`), pide llamada (`:5074`), ubicación (`:5088`), semana de cortesía (`:5111`), franjas de cortesía (`:5124-5158`), enlace de inscripción (`:5161`), sin enlace → buzón con push (`:5176`).

Tras el turno: recordar paso pendiente, pregunta de referido, pregunta de novedades, acuse del embudo si quedó callado (`:4496-4513`). Salvaguarda de silencio opcional por escuela (`routes/whatsapp.ts:752-764`).

### 6.3 Comprobante (imagen / PDF)

En el webhook:
1. Puertas comunes 1–8 (§6.0).
2. ¿Soporte de la ficha? (oleada 1) (`routes/whatsapp.ts:576`).
3. `encolarAdjunto`: mime permitido; upsert con `ON CONFLICT wa_message_id DO NOTHING` (`whatsapp-queue.service.ts:71-89`). Se encola aunque el contacto esté dado de baja. Mime rechazado → aviso fijo solo si `debeAtender` (`routes/whatsapp.ts:589-596`). El webhook NO acusa recibo.

En el worker (`whatsapp-queue.job.ts`, cada minuto):
4. Vencer preguntas `waiting_user` de más de 24 h (`:5805`, `:5690`).
5. Claim con lease (`:5808`); agrupa por contacto: ráfaga → UNA respuesta al final (`:5822-5866`).
6. Integración existe (`:5282-5291`); estado de baja (`:5301`).
7. `debeAtender` ANTES de bajar el archivo y del OCR (`:5479`); tomada / «también familia» / modo discreto con escuela activa → se procesa y aplica **sin escribirle** (`:5483-5490`).
8. ¿Planilla de asistencia del staff? (`:5507-5511`) — aquí puede correr un OCR previo.
9. Staff que no administra → bandeja sin escribir (`:5516-5522`).
10. `decidirAdjunto` (`:5524`): `bot_apagado` → `ignored` (`:5527`); `silencio` → número sin ficha: buscar deportista por nombre o preguntar 1 vez; nunca se ignora un comprobante (`:5531-5565`); `staff_admin` → alta por foto de matrícula (`:5567`); `escalar_sin_cuenta` (`:5575-5593`); `escalar_ambiguo` (`:5594`).
11. Acuse diferido armado (~90 s, solo primer intento) (`:5566, 5438`).
12. Tope de comprobantes por número y escuela, antes del OCR (`:5573`).
13. Identificación por teléfono (`wa_identify_by_phone`); sin acudiente → escuela (`:5609-5627`).
14. Bajar y GUARDAR antes de leer (`:5630`).
15. **OCR (LLM de visión)** (`:5637`); si falla → reintento (`:5640`).
16. No parece pago y hay reclamo → consulta a una persona (`:5650`).
17. `isReceipt === false`: sin contexto de pago → se cierra en silencio; con contexto → «no es un comprobante» (`:5660-5668`).
18. `continuarComoComprobante` (`:5670`, cuerpo en `:3117-3590`): destino de la cuenta, referencia ya usada, imagen repetida, pista del cobro, pregunta «¿a cuál cobro?» (`waiting_user`), veredicto por reglas, aplicar o dejar `awaiting_approval` — detalle fino NO VERIFICADO en esta parte.
19. Respuesta por `enviar` del worker (`:5331-5402`): presentación, consentimiento al pie, anti-repetición 10 min, registro en `whatsapp_messages`.
20. Desenlace (aprobado/rechazado/abono) por el job `whatsapp-payment-outcome` (§2).

El LLM del comprobante solo LEE la imagen; qué cobro, si se aplica y qué se responde son reglas.

---

## A · 7. Idempotencia y concurrencia

| Mecanismo | Cómo | Evidencia |
|---|---|---|
| Mensaje duplicado de Meta | `INSERT … ON CONFLICT (wa_message_id) DO NOTHING` dentro de `wa_ingest_inbound_message`; devuelve `duplicate:true` y el webhook corta | migración `20260909222343…sql:245-260`; `routes/whatsapp.ts:472-475` |
| Adjunto duplicado | upsert con `ignoreDuplicates` por `wa_message_id` en `whatsapp_inbound_queue` | `whatsapp-queue.service.ts:71-99` |
| Canal plataforma | `registrarMensaje` por `wa_message_id` | `plataforma-wa-entrante.service.ts:132-137` |
| Cola entre 3 BFF | `wa_queue_claim`: `FOR UPDATE SKIP LOCKED`, lease 5 min, rescate de `processing` vencido sumando reintento, `failed` a los 5 | migración `20260911170505…sql:31-67` |
| Un turno por ráfaga | espera 10 s en memoria; después «¿entró uno más nuevo?» (por `created_at`, ventana 15 min) → el viejo se retira (`absorbido`) | `whatsapp-turno-agrupado.service.ts:38-44, 81-102, 158-162` |
| Candado por conversación | lease `whatsapp_conversations.bot_turno_hasta` de 90 s, tomado con UPDATE condicional; se suelta solo si sigue siendo propio | `whatsapp-turno-agrupado.service.ts:47, 107-138` |
| Espera del candado | sondeo cada 1,5 s hasta 100 s; si no se suelta → `'ocupado'`: **no se contesta**, solo un `warn` | `whatsapp-turno-agrupado.service.ts:49-50, 164-170` |
| Turno perdido en reinicio | fila en `whatsapp_turnos_pendientes` al lanzar, borrada en `finally`; barrido cada minuto: gracia 3 min, vence a 2 h, máx. 2 intentos, no relanza si ya hubo un saliente | `routes/whatsapp.ts:912-928`; `whatsapp-turnos-pendientes.service.ts:39-42, 111-116, 193-206` |
| Apagado ordenado | SIGTERM: deja de recibir y espera hasta 25 s los turnos en curso | `index.ts:649-661` |
| Pasos «una vez» | `reservarPasoUnaVez` (reserva en memoria + base) | `whatsapp-bot.service.ts:2072` |
| Borradores duplicados | no repite un borrador `pending` idéntico | `whatsapp-bot.service.ts:7380-7389` |
| Jobs entre 3 BFF | reservas en `email_sends`, marcas por fila | `maintenance.job.ts:848-850` |

Mensajes fuera de orden y casos límite:
- «Último gana» compara `created_at` (hora de ingesta), no la hora de Meta (`whatsapp-turno-agrupado.service.ts:78-79`); el historial y las reglas ordenan por `wa_timestamp` (`whatsapp-bot.service.ts:950-954`). Si Meta entrega desordenado, el turno lo corre el último en LLEGAR pero ve la conversación ordenada por la hora del mensaje.
- El mensaje actual se excluye del historial por id y se agrega al final, para que sea siempre el último turno (`whatsapp-bot.service.ts:6808-6813`).
- Un botón o un STOP no esperan la ráfaga pero sí respetan el candado (`routes/whatsapp.ts:920`).
- Audio/video sin transcribir no cuentan como «más nuevo» (`whatsapp-turno-agrupado.service.ts:52-63`).
- Si falla la lectura de «¿hay uno más nuevo?», no se retira (prefiere contestar) (`:99-101`).
- Cualquier error al tomar el candado se interpreta como «falta la columna» y el turno corre SIN candado (`:118-125`).
- Los mensajes de un mismo POST se procesan en serie; los turnos largos van en segundo plano (`routes/whatsapp.ts:71-77, 151-155`).
- Estado en memoria por proceso: caché de integración 5 min, caché de staff 5 min (`routes/whatsapp.ts:836-851`), reloj de plazos de escalación (`:90-110`).

---

## A · 8. Variables de entorno que cambian el comportamiento (sin valores)

### Webhook, Meta y cifrado
| Variable | Para qué | Evidencia |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | verificación GET del webhook | `routes/whatsapp.ts:120` |
| `WHATSAPP_APP_SECRET` | firma HMAC del POST (sin ella todo da 401) | `whatsapp.service.ts:105` |
| `WHATSAPP_TOKEN_ENC_KEY` | descifrar el token de cada integración | `whatsapp.service.ts:19` |
| `WHATSAPP_GRAPH_VERSION` | versión de Graph API (def. v21.0) | `whatsapp.service.ts:28` |
| `META_APP_ID` | alta/conexión (uso exacto NO VERIFICADO) | grep |

### Crons e interruptores
| Variable | Para qué | Evidencia |
|---|---|---|
| `RENDER`, `RENDER_SERVICE_ID`, `CRONS_LOCALES` | si arrancan los crons en este proceso | `crons-solo-en-render.ts:21-23` |
| `CRONS_ENABLED` | `false` = ningún cron | `maintenance.job.ts:73` |
| `DISABLE_WHATSAPP_QUEUE_CRON` | apaga cola, barrido de turnos, desenlace, seguimiento 20 h, rescate, mantenimiento del buzón, sync de plantillas, cupos, campañas, «sigue en fila» | `maintenance.job.ts:541, 558, 574, 590, 607, 629, 812, 831, 1271, 1293, 1314` |
| `DISABLE_WHATSAPP_COLA_VENCIMIENTO` | apaga el aviso de comprobantes colgados | `maintenance.job.ts:784` |
| `DISABLE_WHATSAPP_PLAZO_ESCALACION` | apaga re-avisos de escalación y retomas | `routes/whatsapp.ts:93` |
| `WA_BARRIDO_SIN_RESPUESTA`, `WA_BARRIDO_AMPLIO` | enciende / amplía el barrido de conversaciones sin respuesta | `maintenance.job.ts:591`; grep |
| `DISABLE_RECORDATORIOS_COBRO_WHATSAPP`, `DISABLE_ESTADO_CUENTA_MENSUAL`, `DISABLE_RECEIPT_REVIEW_ALERTS`, `DISABLE_PAGOS_POR_VALIDAR`, `DISABLE_RESUMEN_CUENTAS`, `RESUMEN_CUENTAS_ESCUELAS`, `DISABLE_ACUERDOS_CRON` | avisos de cobranza | `maintenance.job.ts:443, 418, 651, 674, 700, 730` |
| `DISABLE_RECORDATORIO_CORTESIA`, `DISABLE_SEGUIMIENTO_CLASE_CORTESIA`, `DISABLE_CORTESIA_VENCIDA_CRON`, `DISABLE_FRANJAS_CORTESIA`, `DISABLE_CUPOS_SEPARADOS` | ciclo de la clase de prueba | `maintenance.job.ts:1112-1246, 1268` |
| `DISABLE_WHATSAPP_RESUMEN_CORREO`, `DISABLE_BOT_RESUMEN_SEMANAL_CORREO`, `DISABLE_INFORME_CALIDAD_BOT`, `DISABLE_WHATSAPP_VIGILANTE`, `BOT_REPORT_EMAIL`, `SUPPORT_ALERT_EMAIL` | informes y a quién llegan | `maintenance.job.ts:853, 872, 890-893, 912-915` |

### LLM
| Variable | Para qué | Evidencia |
|---|---|---|
| `ANTHROPIC_API_KEY` | pone a Claude primero en el bot; habilita Claude en OCR | `llm.service.ts:421`; `ocr.service.ts:512` |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` | llaves de respaldo | `llm.service.ts:103, 111, 123`; `ocr.service.ts:215` |
| `WHATSAPP_LLM_PROVIDER` | proveedor «primario» tras Claude (acepta `deepseek`) | `llm.service.ts:396` |
| `WHATSAPP_CLAUDE_MODEL`, `WHATSAPP_GEMINI_MODEL`, `WHATSAPP_GROQ_MODEL`, `WHATSAPP_DEEPSEEK_MODEL` | modelo por proveedor | `llm.service.ts:78, 102, 110, 330` |
| `WHATSAPP_PROSPECTO_MODEL`, `PLATFORM_WA_LEADS_MODEL` | modelo de prospectos/servicio y de leads | `whatsapp-prospecto-ia.service.ts:329`; `plataforma-wa-leads.service.ts:328` |
| `WHATSAPP_LLM_TIMEOUT_MS` | tope por llamada | `llm.service.ts:85` |
| `WHATSAPP_CLAUDE_CACHE_TTL` | `5m` o 1 h de caché de prompt | `llm.service.ts:298` |
| `OCR_PROVIDER`, `GEMINI_MODEL`, `ANTHROPIC_OCR_MODEL` / `CLAUDE_OCR_MODEL`, `GROQ_OCR_MODEL` | cadena y modelos del OCR (`GROQ_OCR_MODEL` reactiva Groq) | `ocr.service.ts:130, 278, 370, 478, 500` |
| `GROQ_STT_MODEL`, `OPENAI_STT_MODEL`, `DISABLE_TRANSCRIPCION` | transcripción | `transcripcion.service.ts:130, 159, 196` |
| `GEMINI_DECISIONS_MODEL`, `AUSENCIAS_SEGUNDO_LECTOR` | segundo lector de ausencias (uso de la 2ª NO VERIFICADO) | `gemini-decisions.service.ts:27`; grep |
| `DISABLE_LLM_USAGE_LOG`, `LLM_USAGE_EN_PRUEBAS` | registro de consumo | `llm-usage.service.ts:161-164` |

### Comportamiento del bot
| Variable | Para qué | Evidencia |
|---|---|---|
| `WHATSAPP_BOT_ESPERA_MS` | espera de la ráfaga (def. 10 s) | `whatsapp-turno-agrupado.service.ts:39` |
| `WHATSAPP_SILENCIO_HUMANO_MIN` | minutos de silencio tras escribir la escuela (def. 15) | `whatsapp-bot.service.ts:201` |
| `WHATSAPP_MODO_DISCRETO` | modo discreto global; **encendido salvo que valga `false`** | `whatsapp-modo-discreto.ts:31` |
| `WHATSAPP_HORAS_SILENCIO_ESCUELA` | ventana del modo discreto (def. 12 h) | `whatsapp-modo-discreto.ts:35` |
| `WHATSAPP_TOMADA_HORAS` | duración de «tomar conversación» (def. 12 h) | `whatsapp-tomada.service.ts:33` |
| `WHATSAPP_PLAZO_URGENTE_MIN`, `WHATSAPP_PLAZO_NORMAL_MIN` | re-aviso de escalaciones (10 / 30) | `whatsapp-escalaciones.service.ts:38-39` |
| `WHATSAPP_RETOMA_MIN`, `WHATSAPP_SLA_ESCALAMIENTO_MIN` | retoma (30) y SLA (120 min hábiles) | `whatsapp-reglas-turno.ts:595, 1020` |
| `WHATSAPP_RESPONDER_SERVICIO_CON_ESCUELA` | excepción «ficha del servicio aunque atienda la escuela» | `whatsapp-bot.service.ts:3126` |
| `WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS` | escuelas con bienvenida al «Hola» de un desconocido | `whatsapp-bienvenida.ts:30` |
| `WA_SALVAGUARDA_SILENCIO_SCHOOL_IDS` | escuelas con aviso cuando el bot quedó mudo | `whatsapp-salvaguarda-silencio.ts:16` |
| `WA_CONSENT_SEGUIMIENTO_SCHOOL_IDS`, `WA_CONSENT_NOVEDADES_PROSPECTOS` | preguntas de consentimiento a prospectos | `whatsapp-consentimiento-seguimiento.ts:28, 87` |
| `WA_ACUSE_RECIBO_SCHOOL_IDS`, `WA_AVISOS_LOG_SCHOOL_IDS` | acuse de recibo silencioso; registro de avisos por plantilla | grep (2 usos c/u) |
| `WA_VENTAS_CERRADAS_ITEMS` | servicios con venta cerrada por variable | `whatsapp-anuncio-destino.ts:209` (archivo con cambios SIN DESPLEGAR) |
| `WA_GRUPO_SERVICIO_JSON`, `WA_AUDIENCIA_INTERES_PARTIDO`, `WA_SYNC_CONTACTOS`, `WA_POR_CLASIFICAR_OFF` | ajustes puntuales (uso exacto NO VERIFICADO) | grep |
| `FRONTEND_URL` | base de los enlaces que manda el bot | `plataforma-wa.service.ts:336` |

### Canal plataforma
| Variable | Para qué | Evidencia |
|---|---|---|
| `PLATFORM_WA_ENABLED` | enciende suscripciones del canal | `plataforma-wa.service.ts:35` |
| `PLATFORM_WA_TESTERS` | números en modo pruebas | `plataforma-wa-entrante.service.ts:8, 119` |
| `PLATFORM_WA_LEADS_MAPI` | Mapi atiende leads desconocidos (apagado por defecto) | `plataforma-wa-leads.service.ts:106` |
| `PLATFORM_WA_RESPUESTA_COMERCIAL` | respuesta comercial fija cada 30 días | `plataforma-wa-entrante.service.ts:171` |
| `SALES_WHATSAPP` | número comercial de respaldo | `plataforma-wa.service.ts:130` |

Ajustes que NO son variables sino columnas por escuela (los leen los mismos caminos): `whatsapp_settings.mode / assisted_until / ai_enabled` (`whatsapp-bot.service.ts:7145-7148`), `responder_desconocidos / responder_prospectos` (`whatsapp-atencion.service.ts:74`), `school_settings.wa_modo_discreto`, `wa_ficha_prospectos`, `wa_estilo_respuesta`, `wa_responder_precios`, `wa_ventas_habilitadas`, `wa_ayuda_app`, `wa_reclamos_de_valor`, `wa_modo_cortesia`, `wa_preguntas_prospecto`, `wa_temas_a_persona`, `wa_transcribir_sin_consentimiento` (citadas en `whatsapp-bot.service.ts:232-240, 688, 861, 884, 891, 4624, 4759` y `whatsapp-prospecto-ia.service.ts:12, 70`).

---

## A · 9. Riesgos y sorpresas (para priorizar en las siguientes fases)

1. **El worker de comprobantes no envía por `deliver`.** `enviar` llama directo a `sendInteractiveButtons` / `sendTextMessage` (`whatsapp-queue.job.ts:5331-5402`). No pasa por: modo asistido/borrador (`whatsapp-bot.service.ts:7194-7196, 7361-7398`), ventana de 24 h cerrada (`:7280`), anti-repetición de 2 min (`:7236`), ni marca `failed` si Meta rechaza (`:7338-7343`). Sí respeta tomada y modo discreto (`whatsapp-queue.job.ts:5406, 5483-5490`). Si es intencional, NO VERIFICADO.
2. **Candado ocupado = mensaje sin respuesta y sin reintento.** Tras 100 s, `correrTurnoAgrupado` devuelve `'ocupado'` (`whatsapp-turno-agrupado.service.ts:167-170`) y el `finally` del webhook borra la anotación (`routes/whatsapp.ts:926-928`), así que el barrido tampoco lo recoge. Solo queda un `warn`.
3. **Cualquier error al tomar el candado se trata como «falta la columna»** y el turno corre sin candado (`whatsapp-turno-agrupado.service.ts:118-125`): un fallo transitorio de la base permite dos turnos a la vez.
4. **DeepSeek puede volver por variable.** El código dice que salió de la cadena por transferencia de datos de menores (`llm.service.ts:412-419`), pero `WHATSAPP_LLM_PROVIDER=deepseek` lo reinserta (`:395-396, 422`) y su configuración sigue viva (`:100-104`).
5. **Un solo interruptor apaga 11 trabajos** (`DISABLE_WHATSAPP_QUEUE_CRON`, ver §8), y el turno del bot vive en memoria tras el 200 a Meta: sin ese cron no hay cola, ni relanzado de turnos, ni desenlaces, ni campañas. Además el propio código advierte que dev no tenía `CRONS_ENABLED=false` con la base compartida (`maintenance.job.ts:64-71`).

Otros hallazgos:
- Plazos de escalación y retomas dependen de que entre tráfico al webhook y de un reloj en memoria (`routes/whatsapp.ts:90-110`).
- Modo discreto está ENCENDIDO por defecto a nivel global (`whatsapp-modo-discreto.ts:31`): en esas escuelas el modelo nunca corre para familias (`whatsapp-bot.service.ts:764-768`).
- El bot de familias usa solo la primera tool call (`whatsapp-bot.service.ts:6852`) y no pasa por el verificador de montos (§4).
- Comentarios desactualizados que confunden: el encabezado del webhook habla de DeepSeek y pg-boss (`routes/whatsapp.ts:19-21, 518-519, 542`); `handleIntent` dice «Gemini → Groq» con Claude primero (`whatsapp-bot.service.ts:6823`).
- La llave de Gemini va en la URL (`llm.service.ts:126`).
- `registrarUsoLlm` falla en silencio: si la tabla o el insert fallan, el informe de costo queda corto sin aviso visible (`llm-usage.service.ts:14, 167`).
- `/health/ai` no detecta crédito agotado del proveedor (`index.ts:354-360`).

## A · 10. Lo que NO se cubrió en esta parte

- Cuerpo de `continuarComoComprobante` y de las reglas de aplicación (`whatsapp-queue.job.ts:3117-3590`), `receipt-verdict.ts`, `wa-cobro-desde-comprobante.service.ts`.
- Cuerpos de `whatsapp-venta-servicio.ts`, `whatsapp-anuncio-destino.ts`, `whatsapp-embudo-prospecto.ts`, `whatsapp-clase-cortesia.service.ts`, `whatsapp-campanas.service.ts` (solo firmas).
- `handleIdentification` e `identificarPorTelefono` (`whatsapp-bot.service.ts:2204-2626`) solo por sus comentarios.
- `promptDeLeads` y `verificarRespuesta` del canal plataforma.
- No se consultó la base: qué migraciones están vivas (p. ej. `bot_turno_hasta`, `whatsapp_turnos_pendientes`) NO VERIFICADO.
- No se revisaron las variables reales de Render.


---

# Sección B — Datos y configuración

## B · Fase 0 · Parte B — Datos y configuración del bot de WhatsApp

Auditoría de solo lectura (Read/Grep/Glob sobre `bff/`, `supabase/migrations/`, `frontend/`). Sin base, sin git, sin servicios externos.
Rutas relativas a `c:\Users\Usuario\Documents\demo\sportmaps-demo\`. Fecha: 2026-11-22/23.

## B · 0. Alcance y límites de lo verificado

- Universo: ~820 llamadas `.from('tabla')` en 102 archivos no-test (`bff/src/{services,jobs,routes}/{whatsapp*,wa-*,plataforma-wa*}`) y ~70 `.rpc()`.
- **Verificado sentencia por sentencia** (filtro leído): todos los jobs `bff/src/jobs/whatsapp*.job.ts`; todas las rutas `bff/src/routes/whatsapp*.routes.ts` (filtros por id); toda consulta de servicios que filtra por teléfono/`contact_wa_id`; campañas, plantillas, flows, anuncios, tomada, modo discreto, referidos, soportes, atribución, avisos-log, precios, ajustes, cupos.
- **NO VERIFICADO línea a línea**: las ~100 sentencias de `whatsapp-bot.service.ts` y las de `whatsapp-coexistence.service.ts`, `whatsapp-clase-cortesia.service.ts`, `whatsapp-embudo-prospecto.ts`, `whatsapp-recuperacion.service.ts` que filtran por `conversation_id` / `id` (alcance indirecto: el id sale de una conversación ya resuelta por integración). Se revisaron las que filtran por teléfono; las de id no.
- **Sin git**: no pude diferenciar qué líneas de `whatsapp-anuncio-destino.ts` / `whatsapp-venta-servicio.ts` son del cambio local. Todo lo citado de esos dos archivos y de `wa-cupos-de-servicio.service.ts` va marcado «sin desplegar (archivo con cambios locales)».
- Qué migraciones están vivas en la base: NO VERIFICADO (no me conecté).

## B · 1. Tablas que el bot lee y escribe

**Rol:** todo el BFF usa UN cliente con `SUPABASE_SERVICE_ROLE_KEY` (`bff/src/config/supabase.ts:8,23,35`). La RLS no protege nada de lo que hace el bot: el aislamiento entre academias depende solo del `.eq('school_id'|'integration_id')` de cada consulta. Las rutas autentican con JWT (`requireAuth`) y autorizan con `administraEstaEscuela` (owner / admin / school_admin activo o `platform_admins`; coaches NO) — `bff/src/routes/whatsapp-admin.routes.ts:71-91` — y luego consultan con service role.
Escrituras directas del frontend con JWT del usuario (pasan por RLS): `school_settings.wa_ventas_habilitadas` (`frontend/src/components/settings/SellableCatalogCard.tsx:298`), `school_settings.wa_transcribir_sin_consentimiento` (`frontend/src/pages/WhatsAppPage.tsx:850`), RPC `wa_comprobante_por_clasificar_descartar` (`frontend/src/components/payment/PorClasificarCard.tsx:417`).

L = lee, E = escribe. «Filtro» = columna de alcance que usa la consulta típica.

### 1.1 Tablas propias del canal

| Tabla | L/E | Módulo principal | Filtro |
|---|---|---|---|
| `school_whatsapp_integrations` | L/E | `whatsapp.service.ts:147` (ruteo por `phone_number_id`), `whatsapp-onboarding.service.ts:273-338` (alta), `whatsapp-admin.routes.ts:126` | `id`, `school_id`, `phone_number_id`, `waba_id` |
| `whatsapp_settings` | L/E | `whatsapp-admin.routes.ts:103-322`, `whatsapp-horario.service.ts:65`, `whatsapp-bot.service.ts:5870,7146,8175`, `whatsapp-notas-de-voz.service.ts:93` | `integration_id` |
| `whatsapp_conversations` | L/E | `whatsapp-bot.service.ts`, `whatsapp-coexistence.service.ts:92-714`, `whatsapp-queue.job.ts`, rutas | `integration_id`+`contact_wa_id`, o `id`, o `school_id` |
| `whatsapp_messages` | L/E (E vía RPC `wa_ingest_inbound_message` / `wa_record_outbound_message`) | bot, cola, buzón, métricas | `conversation_id` (casi siempre), `integration_id` |
| `whatsapp_message_drafts` | L/E | bot, `whatsapp-admin.routes.ts:1744-1850`, `whatsapp-mantenimiento.job.ts:74-90` | `conversation_id`; rutas con `whatsapp_conversations!inner(school_id)` |
| `whatsapp_inbound_queue` | L/E | `whatsapp-queue.job.ts`, `whatsapp-payment-outcome.job.ts`, `whatsapp-respuesta-de-cobro.service.ts`, bandeja | `integration_id`+`wa_phone_number`, `id`, `school_id` |
| `whatsapp_identifications` | L (E vía RPC) | `whatsapp-bot.service.ts:5700` | `integration_id`+`contact_wa_id` |
| `whatsapp_optins` | L (E vía RPC) | `whatsapp-optin.service.ts:33,112`, bot | `integration_id`+`contact_wa_id` |
| `whatsapp_blocked_numbers` | L | `whatsapp-campanas.service.ts:1028` | **solo `contact_wa_id`** (ver 1.4) |
| `whatsapp_account_events` | L/E | `whatsapp-coexistence.service.ts:763-779`, `whatsapp-plantillas.service.ts:477`, `whatsapp-campanas-freno.ts:214` | `integration_id` OR `waba_id`, `school_id` |
| `whatsapp_template_status` | L/E | `whatsapp-plantillas.service.ts:428-559`, `whatsapp-campanas.service.ts:258,1448` | `integration_id` (+`waba_id`) |
| `whatsapp_conversation_flows` | L/E/borra | `whatsapp-factura.service.ts:220-247`, `whatsapp-venta-servicios.service.ts:116-144` | `conversation_id` |
| `whatsapp_turnos_pendientes` | L/E/borra | `whatsapp-turnos-pendientes.service.ts:74-153` | `wa_message_id`; barrido global |
| `whatsapp_conceptos_esperados` | L | `whatsapp-vigilante.service.ts:1039` | `school_id` |
| `whatsapp_flows` / `whatsapp_flow_respuestas` / `whatsapp_consentimientos` | L/E | `whatsapp-flows.service.ts:778-850`, `whatsapp-bot.service.ts:2997-3024` | `integration_id`+`nombre`; `flow_id` de Meta |
| `whatsapp_anuncio_destino` | L/E/borra | `whatsapp-anuncio-destino.ts:154`, `whatsapp-anuncios.service.ts:249-322` | `school_id`+`source_id` |
| `whatsapp_anuncio_regla` | L | `whatsapp-atribucion-texto.ts:113` | `school_id` OR `school_id IS NULL` (reglas globales a propósito) |
| `whatsapp_atribucion` | L/E | `whatsapp-atribucion-texto.ts:175-182` | `conversation_id` |
| `whatsapp_audiencia` | L/E | `whatsapp-audiencias.service.ts:301,431`, campañas | `integration_id` |
| `whatsapp_campanas` / `whatsapp_campana_envios` | L/E | `whatsapp-campanas.service.ts:571-1448` | `school_id` o `id`/`campana_id` |
| `whatsapp_campanas_ajustes` / `_declaraciones` / `_freno_global` | L (E vía RPC) | `whatsapp-campanas.service.ts:126,1264,1347` | `school_id` (freno global: sin filtro, es de plataforma) |
| `whatsapp_avisos_log` | L/E | `whatsapp-avisos-log.ts:50,59` | `school_id` |
| `wa_comprobantes_por_clasificar` | L (E vía RPC) | `whatsapp-por-clasificar.routes.ts:56,92` | `id`+`school_id` |
| `wa_cobros_desde_comprobante` | L | `wa-cobro-desde-comprobante.service.ts:686,764` | ver 1.4 |
| `wa_cobros_sueltos`, `cobros_servicio_item` | L | `wa-cupos-de-servicio.service.ts:73,75` (sin desplegar) | **solo `item_id`** |
| `platform_wa_canal` / `_escuelas` / `_suscripciones` / `_mensajes` / `_envios` / `_auditoria` / `_sesiones_prueba` | L/E | `plataforma-wa*.service.ts`, `whatsapp-plataforma.routes.ts` | canal único de SportMaps: por `contact_wa_id`; `school_id` donde aplica |

### 1.2 Tablas de negocio que el bot toca

| Tabla | L/E | Desde | Filtro |
|---|---|---|---|
| `payments` | L (E vía RPC) | `whatsapp-queue.job.ts:715-3628`, `wa-cobro-desde-comprobante.service.ts:673-1101`, `whatsapp-recuperacion.service.ts:632-720`, bandeja | `school_id` casi siempre; excepciones en 1.4 |
| `children` | L | `whatsapp-queue.job.ts:3707,4295`, `whatsapp-comprobante-de-ficha.service.ts:60`, `whatsapp-recuperacion.service.ts:1024` | `school_id` |
| `unregistered_athletes` | L | ídem | `school_id` (o `id` desde el pago) |
| `profiles` | L | varios | `id` / `in('id')`; por teléfono solo en el canal de plataforma |
| `school_members`, `school_staff`, `team_coaches`, `platform_admins` | L | `whatsapp-personal-escuela.service.ts:75-98`, autorización de rutas | `school_id`; plataforma global |
| `school_signup_leads` | L/E/**borra** | `whatsapp-prospecto-lead.service.ts:209-580` (borra en :304 y :541), `wa-nombre-tardio.service.ts`, `whatsapp-clase-cortesia.service.ts:2185` | `school_id`+`phone`, o `id` |
| `schools` | L | nombre, `payment_settings` (puente) | `id` |
| `school_settings` | L/E | `whatsapp-ajustes-escuela.service.ts:276,395`, `whatsapp-precios-escuela.service.ts:202,331,337`, `whatsapp-medios-de-pago.service.ts:96` | `school_id` |
| `school_branches` | L | `whatsapp-info-escuela.service.ts:342`, `whatsapp-embudo-prospecto.ts:1819` | `school_id` |
| `teams`, `school_categories`, `attendance_sessions`, `team_schedule_exceptions` | L | `whatsapp-info-escuela.service.ts:343-368`, `whatsapp-embudo-prospecto.ts:1875` | `school_id` |
| `school_trial_class_settings` | L/E | `whatsapp-ajustes-escuela.service.ts:362`, `whatsapp-precios-escuela.service.ts:215,367` | `school_id` |
| `school_trial_slots` | L (reserva vía RPC) | `whatsapp-clase-cortesia.service.ts:2067`, `whatsapp-embudo-prospecto.ts:1867` | `school_id` (NO VERIFICADO línea a línea) |
| `offering_plans` | L (E vía `aplicarPagosUnicosAPlanes`) | `whatsapp-precios.service.ts:159,256`, `whatsapp-precios-escuela.service.ts:213,350` | `school_id`+`is_active` |
| `school_merchandise_items` | L/E | `whatsapp-precios-escuela.service.ts:216,385,412` | `school_id` |
| `school_tournament_items` | L | `whatsapp-anuncio-destino.ts:251,273`, `wa-cobro-desde-comprobante.service.ts:594,981`, `whatsapp-torneos-pago.service.ts:160` | `school_id` |
| `enrollments`, `enrollment_form_intake`, `invitations`, `school_join_qr_codes`, `payment_links`, `payment_agreement_payments`, `athlete_absence_notices`, `notifications`, `email_sends` | L/E | varios | `school_id` (cola: `whatsapp-queue.job.ts:3717-3755`) |

### 1.3 Storage

Un solo bucket para todo: `payment-receipts` (`whatsapp-queue.job.ts:141`, `whatsapp-asistencia-staff.service.ts:45`, `whatsapp-importar-chat.service.ts:28`). Ruta `{school_id}/whatsapp/{id_fila}.{ext}` (`whatsapp-queue.job.ts:1274`). Las URLs firmadas salen de filas ya filtradas por `school_id` (`whatsapp-admin.routes.ts:726-731`, `whatsapp-por-clasificar.routes.ts:81,107`).

### 1.4 Lecturas y escrituras SIN filtro por `school_id` / `integration_id`

Ninguna resultó ser una fuga demostrada; el aislamiento se sostiene. Estas son las que no llevan el filtro en la propia consulta, ordenadas por riesgo:

| # | Archivo:línea | Qué hace | Por qué importa |
|---|---|---|---|
| 1 | `bff/src/routes/whatsapp-admin.routes.ts:588` | `payments … .in('id', ids)` sin `school_id` (la rama gemela :591-592 sí lo lleva) | Los ids salen de `result_ref_id` de la cola de la escuela; el filtro de escuela se aplica después en memoria (`filasParaAutocierre(schoolId, …)` :599). Defensa en código, no en la consulta. |
| 2 | `bff/src/routes/whatsapp-metricas.routes.ts:266` | `payments … .in('id', ids)` sin `school_id` | Igual: ids derivados de la cola de la escuela. Devuelve `status`, `approved_by`. |
| 3 | `bff/src/services/wa-cupos-de-servicio.service.ts:73-75,82-83` (**sin desplegar**) | `wa_cobros_sueltos`, `wa_cobros_desde_comprobante`, `cobros_servicio_item` por `item_id`; `payments` por `in('id')` | Alcance indirecto por el ítem. Decide si se cierra una venta: un `item_id` equivocado contaría cobros de otra escuela. |
| 4 | `bff/src/services/whatsapp-campanas.service.ts:1028-1029` | `whatsapp_blocked_numbers … .in('contact_wa_id', lote)` | Trae bloqueos de todas las integraciones y filtra en memoria (:1039). Solo excluye de campañas; no expone datos. |
| 5 | `bff/src/services/whatsapp-campana-respuesta.service.ts:185-186` | `whatsapp_campanas … .eq('id', id)` | El id viene del payload del botón de la plantilla. NO VERIFICADO si se contrasta con la integración del mensaje entrante. |
| 6 | `bff/src/services/whatsapp-tomada.service.ts:63-66` y `:173-175` | `whatsapp_conversations` por `id` / `in('id')` sin `school_id` (las escrituras :96-143 sí lo llevan) | Solo lectura de `tomada_por/tomada_hasta`; ids ya filtrados por quien llama. |
| 7 | `bff/src/routes/whatsapp.ts:237-239` | `UPDATE whatsapp_messages … .eq('wa_message_id', …)` | Webhook de estados. `wa_message_id` es único de Meta; riesgo bajo. |
| 8 | `bff/src/services/whatsapp-flows.service.ts:848-850` | `UPDATE whatsapp_flows … .eq('flow_id', …)` | Webhook; id global de Meta. |
| 9 | `bff/src/services/whatsapp-referidos-bot.ts:111-113`, `whatsapp-prospecto-lead.service.ts:497-502,541` | `school_signup_leads` por `id` (UPDATE y **DELETE** en :541) | El id sale de una lectura previa con `school_id`. |
| 10 | Barridos globales de jobs (por diseño; cada fila lleva su integración): `whatsapp-cola-vencimiento.job.ts:82-95`, `whatsapp-mantenimiento.job.ts:43-90`, `whatsapp-payment-outcome.job.ts:916-921` y `:1169-1175`, `whatsapp-queue.job.ts:5726-5733`, `whatsapp-turnos-pendientes.service.ts:131-138`, `whatsapp-modo-discreto.ts:229-234`, `whatsapp-soportes-bot.ts:634` | Recorren todas las escuelas | No son fuga. Riesgo operativo: `limit` fijo (50–2000) compartido entre academias — una escuela con mucho volumen puede dejar sin turno a las demás. |
| 11 | Canal de plataforma: `plataforma-wa-entrante.service.ts:96-97` (suscripciones por teléfono), `:195` (`profiles … like('phone', '%…')`), `:262-265` (revoca TODAS las suscripciones del número) | Por diseño: un número = varias escuelas | `:195` busca por sufijo de 10 dígitos en todos los perfiles de la plataforma. |
| 12 | `bff/src/services/whatsapp-personal-escuela.service.ts:75-76` | `profiles` con `role in ('admin','super_admin')` de toda la plataforma | Usa `profiles.role` (la misma fuente que SEG-26 reemplazó en `whatsapp-admin.routes.ts:77-79`). Solo sirve para no atender como familia al personal de SportMaps. |

Otros hallazgos de alcance:
- `integracionDe(schoolId)` usa `.maybeSingle()` por `school_id` (`whatsapp-admin.routes.ts:124-130`, igual `whatsapp-onboarding.service.ts:273-276`), pero el modelo admite varios números por escuela (`20260618100000_whatsapp_ai_channel_wa1.sql:66`, `20261030123604_whatsapp_numero_proposito.sql:37`). Con dos integraciones `maybeSingle()` da error y la pantalla queda «sin integración». No es fuga; es una escuela sin panel.
- RLS de `school_whatsapp_integrations` y `whatsapp_settings` da SELECT solo al `owner_id` (`20260618100000…:76-78,120-126`); si una migración posterior lo amplió: NO VERIFICADO.

## B · 2. RPCs que llama el bot

Descripción tomada de `COMMENT ON FUNCTION` cuando existe; «(inferido)» = por nombre y llamador.

| RPC | Llamada desde | Qué hace |
|---|---|---|
| `wa_is_blocked` | `routes/whatsapp.ts:436` | ¿El número está bloqueado? (inferido) |
| `wa_ingest_inbound_message` | `routes/whatsapp.ts:452` | Inserta el entrante idempotente y crea/reabre la conversación (inferido; `whatsapp-mantenimiento.job.ts:13`) |
| `wa_record_outbound_message` | bot `:7323,:8851`, cola `:5068,:5390`, campañas `:960`, plantillas `:728`, rutas `:1631,:1792` | Registra el saliente en `whatsapp_messages` (inferido) |
| `wa_queue_claim` | `whatsapp-queue.job.ts:5808` | Claim atómico de la cola con lease y SKIP LOCKED (`20260911170505`) |
| `wa_identify_by_phone` | bot `:1710,:2212,:6094`, cola `:3896,:5609` | Identifica al acudiente por los últimos 10 dígitos del número (`20260916163755`) |
| `wa_identify_staff_admin_by_phone` | cola `:5496`, `whatsapp-atencion.service.ts:189` | ¿Es owner/admin/school_admin activo de la escuela? (`20260917133748`) |
| `wa_identify_staff_by_phone` | `whatsapp-asistencia-staff.service.ts:93` | Igual, incluyendo coach (`20261024211855`) |
| `wa_es_familia_sin_registrar` | `whatsapp-recuperacion.service.ts:1113` | El número es de un atleta cargado sin cuenta (`20260922130717`) |
| `wa_es_afiliado` | `wa-afiliado.service.ts:52` | ¿Familia o deportista activo? Solo para precio de afiliado y saludo (`20261030123549`) |
| `wa_invitacion_pendiente_por_telefono` | `whatsapp-invitacion-vigente.service.ts:104` | Invitación pendiente del atleta de ese número (`20260922123945`) |
| `wa_start_identification` / `wa_verify_otp` | bot `:4120` / `:4076` | Crea y valida el OTP por correo (inferido) |
| `wa_iniciar_revinculacion` | `wa-revinculacion.service.ts:85` | Desafío para pasar un número a otro acudiente (`20261025205953`) |
| `wa_register_optin` | bot `:3029,:6310`, embudo `:1779` | Registra el consentimiento (inferido) |
| `wa_registrar_baja_promos` / `wa_reactivar_promos` | `whatsapp-optin.service.ts:64,82` | Baja / alta solo de promociones (`20261115143758`) |
| `wa_can_send_template` | `whatsapp-plantillas.service.ts:615`, `whatsapp-plantilla-manual.service.ts:182` | ¿Se le puede enviar esa plantilla? (inferido) |
| `wa_get_payment_status` | bot `:1252,:1322,:1482,:6976`, `whatsapp-medios-de-pago.service.ts:187` | Estado de pagos del acudiente: lo pendiente más lo visto, con mora (`20261015163556`) |
| `wa_reservar_cupo_ocr` | `wa-limite-comprobantes.service.ts:51` | Reserva un cupo de OCR; límite por número y por escuela (`20261025205950`) |
| `wa_crear_cobro_desde_comprobante` | `wa-cobro-desde-comprobante.service.ts:715` | Crea UN cobro pendiente con el precio de la fuente (`20261111114349`) |
| `aplicar_comprobante_a_cobro_abierto` | `wa-cobro-abierto.service.ts:271` | Aplica el comprobante al cobro abierto: saldo exacto → pagado; menor → abono (`20261111114349`) |
| `wa_cubrir_cobros_con_comprobante` | `whatsapp-excedente.service.ts:187` | Reparte un comprobante entre varios cobros (inferido) |
| `wa_crear_comprobante_por_clasificar` / `_aplicar` | `wa-comprobante-por-clasificar.service.ts:200,257` | Registra dinero que el bot no aplicó / lo liga al cobro elegido (`20261118124124`) |
| `list_open_trial_slots_public` | `whatsapp-clase-cortesia.service.ts:2111` | Cupos abiertos de clase de prueba; accesible a anon (`20260825151250`) |
| `submit_school_lead` | `whatsapp-clase-cortesia.service.ts:2220` | Crea el prospecto y reserva el cupo con lock (`20260825151250`) |
| `wa_cancelar_clase_de_prueba` | `whatsapp-clase-cortesia.service.ts:2259` | Libera el cupo que reservó ese teléfono (`20261006082002`) |
| `wa_audiencia_excluidos` | `whatsapp-audiencias.service.ts:363` | De una lista de números, cuáles son staff/familia/inscritos (`20261030123555`) |
| `wa_campana_aprobar` | `whatsapp-campanas.service.ts:1220` | Aprueba y congela destinatarios; valida admin de ESA escuela (`20261115143758`) |
| `wa_campana_tomar_lote` | `:772` | Toma envíos pendientes respetando cupo de Meta, tope diario y piloto |
| `wa_campanas_activar` | `:1285` | La escuela prende campañas aceptando la declaración |
| `wa_campanas_pausar_escuela` / `_reanudar_escuela` | `:560,:1321,:1334` / `:1311,:1337` | Pausa / levanta la pausa (la de plataforma solo la levanta plataforma) |
| `wa_campanas_freno_global` | `:1357` | Freno global de campañas; solo admin de plataforma |
| `wa_compradores_de_servicio` | `:1172`, `whatsapp-campana-reporte.service.ts:529` | Quiénes ya pagaron/abonaron un servicio de ESA escuela |
| `wa_embudo_anuncios` | `whatsapp-anuncios.service.ts:233` | Embudo por anuncio (`20261104115612`) |
| `soportes_reclamar_avisos` | `whatsapp-soportes-bot.ts:678` | Reserva los avisos de soportes pendientes (inferido) |
| `wa_crear_cobro_suelto` / `wa_anular_cobros_sueltos_vencidos` | `ventas-servicios.service.ts:211,259` (fuera del patrón de nombres) | Carril B: crea un cobro de un ítem contando cupo / anula los vencidos (`20261007095911`) |

Si cada RPC que recibe `p_school_id` / `p_integration_id` valida el alcance adentro: NO VERIFICADO (no leí los cuerpos).

## B · 3. Configuración por academia

### 3.1 `whatsapp_settings` (por integración; no existe hasta conectar el número)

| Ajuste | Qué hace | Default | Quién lo cambia |
|---|---|---|---|
| `mode` | `auto` responde solo; `assisted` deja borradores | BD `assisted` (`20260618100000…:98`); **el alta inserta `auto`** (`whatsapp-onboarding.service.ts:379-383`) | Pantalla WhatsApp (`frontend/src/pages/WhatsAppPage.tsx:932-934`) |
| `assisted_until` | Fuerza asistido hasta esa fecha | NULL | Solo base |
| `ai_enabled` | Apaga el modelo | BD `true`; **el alta inserta `false`** | Pantalla (`WhatsAppPage.tsx:949-951`) |
| `responder_desconocidos` | Atiende números sin ficha | `false` (`20261003193624:75`) | Pantalla (`:967-969`) |
| `responder_prospectos` | Atiende al desconocido con intención clara | `true` (`20261006110920:19`) | Pantalla (`:987-989`) |
| `business_hours` `{tz, dias}` | Horario de atención | NULL | Pantalla (`:1025`), validado en `whatsapp-admin.routes.ts:249-279` |
| `welcome_message` | Saludo (≤1000) | NULL | API lo acepta (`whatsapp-admin.routes.ts:248`); si hay campo en pantalla: NO VERIFICADO |
| `transcribir_audios` | Transcribe notas de voz de familias con consentimiento | `false` (`20261006092320:22`) | Solo base (no está en `AjustesSchema`, `whatsapp-admin.routes.ts:239-254`) |
| `limite_comprobantes_ventana_min` / `_por_numero` / `_por_escuela` | Tope de OCR | 60 / 8 / 60 (`20261025205950:53-55`) | Solo base |
| `default_locale` | Idioma | `es` | Solo base |

### 3.2 `school_settings.wa_*` (por escuela; lector `whatsapp-ajustes-escuela.service.ts:262-286`)

Si la lectura falla o la columna no existe, el bot usa el default sin avisar (`:9-11`).

| Columna | Qué hace | Default | Quién lo cambia |
|---|---|---|---|
| `wa_modo_cortesia` | `clase` agenda una clase; `semana_app` manda el enlace de cortesía | `clase` | Solo base |
| `wa_cortesia_qr_id`, `wa_cortesia_dias` | QR y días de la semana de cortesía | NULL / 7 | Solo base |
| `wa_ayuda_app` | Responde dudas de uso de la app | `false` | Solo base |
| `wa_reclamos_de_valor` | Atiende «me están cobrando de más» | `false` | Solo base |
| `wa_responder_precios` | Da los valores al que pregunta | `false` | Pantalla WhatsApp › Precios (`PreciosDelBot.tsx` → `PUT /:schoolId/precios/interruptores`) |
| `wa_cobro_desde_comprobante` | Crea el cobro al llegar un comprobante con motivo | `false` (`20261030123549:49`) | Misma pantalla |
| `wa_ventas_habilitadas` | Carril B: cobro suelto + link a familias | `false` | Configuración › catálogo (`SellableCatalogCard.tsx:298`, escritura directa con JWT). Además exige `tournament_charges_enabled` (`whatsapp-precios-escuela.service.ts:235`) |
| `wa_bienvenida` | Texto al desconocido | NULL = el del bot | Solo base |
| `wa_botones_sede` | Botones de sede `[{branch_id, titulo}]` | NULL | Solo base |
| `wa_preguntas_prospecto` | Preguntas del embudo; **una sola inválida apaga todo el embudo** (`:122-126`) | NULL = apagado | Solo base |
| `wa_modo_discreto` | `si`/`no`/`global` | `global` → variable `WHATSAPP_MODO_DISCRETO` | Solo base |
| `wa_temas_a_persona` | Temas que siempre pasan a una persona | NULL = lista global | Solo base |
| `wa_atencion_presencial` | Dónde y cuándo atiende en persona (texto libre) | NULL = no lo dice | Solo base; respaldo en `schools.payment_settings` (`:391-408`) |
| `wa_cortesia_indicaciones` | Qué llevar a la clase (texto libre) | NULL | Solo base |
| `wa_ficha_prospectos` | Ficha libre (≤6000) que lee el modelo | NULL | Solo base; respaldo en `schools.payment_settings` (`whatsapp-prospecto-ia.service.ts:70-86`). La pantalla solo la REVISA (`CoherenciaFicha.tsx`, `GET /:schoolId/coherencia-ficha`) |
| `wa_estilo_respuesta` | Tono del modelo | NULL | Solo base |
| `wa_transcribir_sin_consentimiento` | Transcribe sin opt-in | `false` | Pantalla WhatsApp (`WhatsAppPage.tsx:836-850`, escritura directa con JWT) |

Otras columnas de `school_settings` que usa el bot: `allow_installments` (`whatsapp-queue.job.ts:350`), `tournament_charges_enabled`, `require_athlete_documents` (`whatsapp-soportes-bot.ts:634`), cuentas de pago (4).

### 3.3 `school_trial_class_settings` (lector `whatsapp-ajustes-escuela.service.ts:351-372`)

| Columna | Qué hace | Default |
|---|---|---|
| `enabled` | Clase de prueba prendida | sin fila = prendida (`whatsapp-precios-escuela.service.ts:288`) |
| `trial_price` | Valor; 0 = NULL | NULL |
| `nombre_clase` | «cortesía» o «prueba» | NULL = «clase de cortesía» |
| `separar_horas` | Horas que se sostiene el cupo; NULL = el bot no cobra | NULL |
| `cupos_por_sesion` | Tope por sesión | NULL = sin tope |
| `agendar_al_recibir` | Agenda al llegar el comprobante | `true` |
| `avisar_entrenador` | Aviso al entrenador | `false` |
| `dias_semana` | Días en que se agenda | NULL = todos |

Quién: `trial_price` desde WhatsApp › Precios (`PUT …/precios/clase-prueba`); el resto desde `frontend/src/hooks/useClasePrueba.ts` y `components/school/agendaClasePruebaModel.ts` (en qué página se montan: NO VERIFICADO). Franjas: `school_trial_slots`, sincronizadas con `POST /:schoolId/cortesias/sincronizar-franjas` (`whatsapp-cortesias.routes.ts:92`).

### 3.4 `school_tournament_items` (campos que usa la venta)

`id, name, kind, price, active, event_id, starts_at, ends_at, description, image_url, capacity, created_at, allow_installments, precio_afiliado, precios_por_fecha, abono_minimo_pct, opciones, precios_afiliado_por_fecha` (`whatsapp-anuncio-destino.ts:181-184`).
- Vigente = `active`, sin `event_id`, sin terminar (`:187-191`).
- Venta cerrada = id en `WA_VENTAS_CERRADAS_ITEMS`, o `clase_extra` ya empezada, o cupos llenos (`:206-222`, sin desplegar).
- Quién: Configuración › catálogo (`SellableCatalogCard.tsx`, `PreciosDeServicioEditor.tsx`, `frontend/src/lib/preciosDeServicio.ts`).

### 3.5 Anuncios y campañas

- `whatsapp_anuncio_destino` (`school_id, source_id, destino ∈ clase_prueba|servicio|persona, servicio_id, nota`). Sin fila el bot infiere del texto del anuncio (`whatsapp-anuncio-destino.ts:11-21`). Quién: WhatsApp › Anuncios (`Anuncios.tsx` → `PUT/DELETE /:schoolId/anuncios/:sourceId/destino`).
- `whatsapp_campanas_ajustes`: `habilitadas` (false), `base_consentimiento` (`optin`), `tope_diario_max` (200), `lote_piloto` (50), `frecuencia_min_dias` (7), `antiguedad_max_dias` (**BD 180, el código lo recorta a 90**: `20261030123555:52` vs `whatsapp-campanas.service.ts:83,111`), `palabras_sede` (`[]`), `pausada_at`. Quién: activar/pausar desde `Campanas.tsx`; topes y `palabras_sede` no tienen ruta de edición → solo base.
- `whatsapp_campanas`: plantilla, idioma (`es_CO`), `filtro {intereses, branch_ids}`, `variables`, `estado`, `respuesta_si`. Quién: `Campanas.tsx`.

### 3.6 Plantillas (`bff/whatsapp-templates/`)

- Comunes (21): cobranza (`pago_*`, `cobro_unico_*`, `abono_recibido`, `comprobante_*`), clase (`recordatorio_clase_*`, `clase_prueba_*`, `clase_cancelada`), `seguimiento_interesado`. Todo por variables; las cifras que aparecen son solo `example`.
- Plataforma (5): `plataforma/sm_*`.
- **Por escuela (6, con datos fijos): `escuelas/monster/*.json`** — ver deuda en 4.2.
- Quién: se registran en Meta desde WhatsApp › Plantillas (`POST /:schoolId/plantillas`, `…/plantillas/catalogo/:nombre`) o `register-templates.sh`. El texto aprobado no se puede editar: cambiar un dato = plantilla nueva.

### 3.7 Configuración que vive en variables de entorno (invisible para la escuela)

Listas de escuelas: `WA_ACUSE_RECIBO_SCHOOL_IDS` (`whatsapp-acuse-recibo.ts:27`), `WA_AVISOS_LOG_SCHOOL_IDS` (`whatsapp-avisos-log.ts:38`), `WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS` (`whatsapp-bienvenida.ts:30`), `WA_CONSENT_SEGUIMIENTO_SCHOOL_IDS` (`whatsapp-consentimiento-seguimiento.ts:28`), `WA_SALVAGUARDA_SILENCIO_SCHOOL_IDS` (`whatsapp-salvaguarda-silencio.ts:16`).
Datos de negocio: `WA_VENTAS_CERRADAS_ITEMS` (`whatsapp-anuncio-destino.ts:209`, `whatsapp-venta-contexto.ts:270`), `WA_GRUPO_SERVICIO_JSON` — link del grupo por NOMBRE del servicio (`whatsapp-grupo-servicio.ts:16-23`).
Globales: `WHATSAPP_MODO_DISCRETO`, `WHATSAPP_HORAS_SILENCIO_ESCUELA`, `WHATSAPP_SILENCIO_HUMANO_MIN`, `WHATSAPP_TOMADA_HORAS`, `WHATSAPP_PLAZO_URGENTE_MIN/NORMAL_MIN`, `WHATSAPP_RETOMA_MIN`, `WHATSAPP_SLA_ESCALAMIENTO_MIN`, `WHATSAPP_BOT_ESPERA_MS`, `WHATSAPP_PROSPECTO_MODEL`, `WA_POR_CLASIFICAR_OFF`, `WA_BARRIDO_AMPLIO`, `WA_SYNC_CONTACTOS`, `DISABLE_WHATSAPP_VIGILANTE`.

## B · 4. Fuente de verdad de cada dato y dónde está duplicado

### 4.1 Tabla

| Dato | Manda | Duplicados que pueden quedar viejos |
|---|---|---|
| Mensualidad | `offering_plans.price` (`whatsapp-precios.service.ts:156-170`) | `wa_ficha_prospectos`; `description` de ítems. La revisión de ficha solo contrasta matrícula/inscripción/uniforme/camiseta (`whatsapp-precios-escuela.service.ts:82-91`): **una mensualidad vieja en la ficha no se detecta**. |
| Matrícula | `offering_plans.registration_fee`, igual en todos los planes activos | Se guarda N veces (una por plan); si difieren, el bot no afirma ninguna (`whatsapp-precios.service.ts:94`). Ficha libre (sí se avisa: `ficha_menciona_valor_sin_cargar`). Plantilla `monster_cierre_2026.json:8` («antes del 30 de noviembre, noviembre te sale gratis»). |
| Clase de prueba | `school_trial_class_settings.trial_price` | Ficha libre; `wa_cortesia_indicaciones`. |
| Artículos | `school_merchandise_items.price` / `price_by_size` | Ficha libre. |
| Servicios y opciones | `school_tournament_items.price`, `precio_afiliado`, `precios_por_fecha`, `precios_afiliado_por_fecha`, `opciones`, `abono_minimo_pct` | `description` del ítem (el bot la envía tal cual como ficha: `whatsapp-anuncio-destino.ts:23`); `wa_ficha_prospectos` (el prompt dice que el catálogo manda: `whatsapp-prospecto-ia.service.ts:212`); plantillas de Monster; afiches (`image_url`, sin lectura). |
| Fechas de servicios | `starts_at` / `ends_at` | `description`; ficha; plantillas de Monster; **texto fijo en el código** (`whatsapp-anuncio-destino.ts:233`). |
| Horarios de entrenamiento | `teams.schedule`; si falta se infiere de `attendance_sessions` de 4 semanas (`whatsapp-info-escuela.service.ts:358-368`) | Ficha libre; plantilla `monster_vacacional_2026.json:8`. |
| Horario de atención | `whatsapp_settings.business_hours` | `wa_atencion_presencial` (texto libre con horas) — dos fuentes para lo mismo. |
| Franjas de clase de prueba | `school_trial_slots` + `dias_semana` + `team_schedule_exceptions` | Se generan desde `teams.schedule` con un botón manual: si cambia el horario y nadie sincroniza, quedan viejas. Ficha libre. |
| Sedes y direcciones | `school_branches.name/address`; `schools.address`; `teams.location` (tres columnas) | `wa_atencion_presencial`; `wa_botones_sede[].titulo` (copia del nombre); `whatsapp_campanas_ajustes.palabras_sede`; ficha; plantillas de Monster con DOS sedes distintas para la misma clínica. |
| Cupos | Clase: `cupos_por_sesion`. Servicio: `capacity` | Dos contadores para `capacity`: RPC `wa_crear_cobro_suelto` y el conteo nuevo del BFF (`wa-cupos-de-servicio.service.ts:67-111`, sin desplegar; suma además cobros por `payment_category`). Plantilla con «Quedan *9 cupos*». |
| Cuentas de pago | `school_settings.payment_accounts` | Columnas viejas `nequi_number`, `bank_account_number`, `breb_key`, `bank_name`, `bank_account_holder`, `bank_titular_name`: se leen las dos y se deduplica (`whatsapp-medios-de-pago.service.ts:95-123`). Ficha libre y `description` pueden traer un número de cuenta escrito. |
| Descuentos / preventa | `precios_por_fecha` (tramos) y `precio_afiliado` | Plantillas de Monster («5 % de descuento», «preventa hasta el 10 de noviembre»); ficha. No hay campo «descuento %». |
| Link del grupo del servicio | Variable `WA_GRUPO_SERVICIO_JSON`, por NOMBRE | Se rompe en silencio si la escuela renombra el servicio (`whatsapp-grupo-servicio.ts:21-23`). |
| Venta cerrada | Regla por `starts_at` + cupos | Variable `WA_VENTAS_CERRADAS_ITEMS` con ids a mano. |

### 4.2 Deuda: datos de una escuela concreta escritos a mano

**Código**
- `bff/src/services/whatsapp-anuncio-destino.ts:232-235` — `if (/cl[ií]nica de armadores/i.test(nombre))` → «Las inscripciones de la *Clínica de armadores y atacantes* ya cerraron: la clínica es mañana y el domingo (21 y 22 de noviembre).» **Ya es falso desde el 21-nov** («mañana») y queda para cualquier escuela cuyo servicio se llame así. Archivo con cambios locales: NO VERIFICADO si esta línea ya está en producción.
- `bff/src/services/whatsapp-escalaciones.service.ts:56` — `CONTEXTO_CLASE` incluye `colibri|nido` (nombres de sede de una escuela) en una regla común.
- Vocabulario de voleibol en reglas comunes: `whatsapp-datos-de-registro.ts:185`, `whatsapp-comprobante-de-ficha.service.ts:356,484`, `whatsapp-venta-servicio.ts:344` (`armador|opuesto|libero|punta…`).
- `whatsapp-bot.service.ts:6452,6538` — el prompt del sistema nombra a «Milena» (persona de una escuela) como ejemplo para todas.
- `whatsapp-ajustes-escuela.service.ts:413-414` — dirección y horario de Dynasty en un comentario (no sale al usuario).
- Montos en cadenas de ejecución: ninguno fuera del simulador (`plataforma-wa-pruebas-simular.service.ts:531-532`).

**Plantillas (texto congelado por Meta)**
- `bff/whatsapp-templates/escuelas/monster/monster_clinica_2026.json:8` — «21 y 22 de noviembre en el Colegio Bilingüe La Enseñanza. La preventa va hasta el 10 de noviembre».
- `…/monster_clinica_2026_ecci.json:8` — misma clínica «en la Universidad ECCI, Campus 170 (Bogotá)». **Dos plantillas con sedes distintas para el mismo evento.**
- `…/monster_clinica_cupos_2026.json:8` — «Quedan *9 cupos*… Reserva hasta el *jueves 19 de noviembre* y tienes *5 % de descuento*».
- `…/monster_clinica_ultimas_horas.json:8` — «abono de $150.000… mantienes el valor de $300.000; desde mañana, $350.000».
- `…/monster_cierre_2026.json:8` — «antes del 30 de noviembre, noviembre te sale gratis… Clínica (preventa hasta el 10 de noviembre)».
- `…/monster_vacacional_2026.json:8` — «Parque Pinar de Suba 2: del 17 de noviembre al 10 de diciembre, martes, miércoles y jueves de 8 a 11 a. m.».
Nada impide en el código enviar una de estas con la fecha vencida: NO VERIFICADO si `wa_campana_aprobar` valida vigencia.

**Pruebas** — ~180 archivos `*.test.ts` con datos de Dynasty/Monster (`whatsapp-dynasty-2026-10-0X.test.ts`, `caso-vacacional-auditoria-antes-de-anuncios.test.ts`, fixture `services/__fixtures__/dynasty-horarios.ts`). No inventariados uno a uno.

## B · 5. Retención

| Qué | Dónde | Borrado o vencimiento |
|---|---|---|
| Texto de chats | `whatsapp_messages.text_body` + `payload` (JSON completo de Meta) | **Ninguno.** No hay `DELETE` sobre `whatsapp_messages` ni `whatsapp_conversations` en `bff/src`. El job de mantenimiento solo cambia estados: conversación `open`→`closed` a las 48 h, borrador `pending`→`expired` a las 24 h (`whatsapp-mantenimiento.job.ts:28-29,55-60,86-90`). |
| Contactos personales (Coexistence) | Se guardan sin contenido: `payload = { privacidad: 'personal_sin_contenido', … }` (`whatsapp-coexistence.service.ts:77`) | Se purga al guardar. `purgado_at` se LEE (`whatsapp-medios.ts:42,56`) pero nada lo ESCRIBE. |
| Comprobantes (imagen/PDF) | Bucket `payment-receipts`, `{school_id}/whatsapp/{fila}.{ext}`; ruta en `whatsapp_inbound_queue.storage_path` (`whatsapp-queue.job.ts:1274-1288`) | **Ninguno.** La migración anuncia «retención a 90 días» (`20260911170115_whatsapp_cola_comprobantes.sql:116`) pero no existe el job. El único `remove` es al fallar el registro de una planilla (`whatsapp-asistencia-staff.service.ts:348`). |
| Lectura OCR | `whatsapp_inbound_queue.pregunta_ocr`, `error_message` | Ninguno. |
| Fotos de matrícula y planillas | Mismo bucket; `enrollment_form_intake.storage_path`; planillas | Matrícula: la migración habla de un job a 7 días para `rejected/failed` (`20260917123008…:75,103`); en `bff/src` solo hay borrado manual (`enrollment-intake.routes.ts:136,141`). Job automático: NO ENCONTRADO. |
| Audios | **No se guardan.** Se bajan a memoria solo si se van a transcribir (`whatsapp-notas-de-voz.service.ts:20-21`). Queda el texto en `text_body` + `payload.transcripcion` y el `media_id` | El texto transcrito no vence. El archivo vive en Meta con su propia caducidad. |
| Otros adjuntos del chat | No se copian: el buzón los pide a Meta con el token (`whatsapp-medios.ts:4-8`, `whatsapp-buzon.routes.ts:241-268`) | Dependen de Meta; con el tiempo dejan de abrir. |
| Borradores | `whatsapp_message_drafts` | Pasan a `expired`; no se borran. |
| Estado de flujos | `whatsapp_conversation_flows` (con `expires_at`) | Se borra al terminar (`whatsapp-factura.service.ts:247`, `whatsapp-venta-servicios.service.ts:144`). Los vencidos se ignoran al leer; barrido: NO ENCONTRADO. |
| Turnos pendientes | `whatsapp_turnos_pendientes` | **Único borrado por antigüedad del módulo** (`whatsapp-turnos-pendientes.service.ts:89,138`). |
| OTP | `whatsapp_identifications` | El código vence (`whatsapp-bot.service.ts:5710`); la identificación NO caduca (`:592`). |
| Prospectos | `school_signup_leads` | El bot borra duplicados recientes (`whatsapp-prospecto-lead.service.ts:304-310,541`). Sin vencimiento. |
| Canal de plataforma | `platform_wa_mensajes` (de un desconocido no se guarda el texto: `plataforma-wa.service.ts:243`) | Solo se borran sesiones de prueba (`plataforma-wa-pruebas.service.ts:441`). |
| Al borrar una integración | `whatsapp_inbound_queue` tiene `ON DELETE RESTRICT` (`20260911170115…:66-75`); conversaciones y ajustes van en `CASCADE` | Una integración con comprobantes no se puede borrar. |

No existe política de retención implementada para chats ni comprobantes: todo se conserva indefinidamente en una sola base y un solo bucket compartido con los comprobantes de la app.


---

# Sección C — Intenciones y flujos

## C · Fase 0 · Parte C — Inventario de intenciones y flujos del bot de WhatsApp (solo lectura)

Fecha: 2026-11-23 · rama `develop` · working tree con cambios sin commit.

## C · 0. Cómo leer este documento

- Rutas relativas a `bff/src/`. Abreviaturas: **BOT** = `services/whatsapp-bot.service.ts` · **COLA** = `jobs/whatsapp-queue.job.ts` · **WH** = `routes/whatsapp.ts` · **RT** = `services/whatsapp-reglas-turno.ts` · **ATN** = `services/whatsapp-atencion.service.ts`. Los demás archivos se citan por nombre (todos en `services/` salvo que diga `jobs/` o `routes/`).
- **Disparo**: REGLA (regex/regla fija en código) · BOTÓN (id del botón interactivo) · LLM (decide o redacta un modelo) · JOB (cron) · RUTA (lo dispara una persona desde la app) · WEBHOOK.
- **step**: literal que queda en `whatsapp_messages.payload.step` del saliente (o `tool_context.step` del borrador en modo asistido). En la cola de comprobantes además cuenta el código de `whatsapp_inbound_queue.error_message` / `result_type`.
- **Pruebas**: nombre del archivo sin `.test.ts`. Se obtuvo buscando el `step`, la constante o la función en los 600+ archivos de prueba del BFF; es cobertura **por mención**, no por rama: que un archivo nombre el paso no garantiza que pruebe todos sus caminos.
- **SIN DESPLEGAR**: depende de cambios locales sin commit (`whatsapp-anuncio-destino.ts`, `whatsapp-venta-servicio.ts`, `wa-cupos-de-servicio.service.ts`, `wa-cupos-de-servicio.test.ts`, `caso-vacacional-auditoria-antes-de-anuncios.test.ts`, `plataforma-wa-leads.service.ts`).
- **NO VERIFICADO**: lo supongo por nombre/comentario sin haber leído la línea. **(A)** = línea tomada de la parte A (`A-arquitectura.md`), no releída aquí.
- Límite de esta parte: se inventarió por catálogo de `step`, constantes y funciones más lectura de los despachadores (`cuerpoDelTurno`, `atenderDesconocidoEnEscuela`, `handleIntent`, `escalate`, `aplicarComprobante`). No se leyó línea a línea cada servicio de 500–2.000 líneas: los textos exactos de cada mensaje y las ramas internas de `whatsapp-venta-servicio.ts`, `whatsapp-clase-cortesia.service.ts`, `whatsapp-embudo-prospecto.ts` y `continuarComoComprobante` (COLA:3117-3590) quedan para la fase siguiente.

## C · 1. Resumen numérico

| Dominio | Flujos | Regla / botón / job / ruta | Con LLM (decide o redacta) | Sin prueba (ninguna mención) | Cobertura débil (solo regla pura o mención lateral) |
|---|---|---|---|---|---|
| VENTAS | 49 | 45 | 4 (V14 solo la entrada, V27, V37, V40) | 0 | 4 (V17, V19, V21, V47) + V30 solo con prueba sin desplegar |
| GESTIÓN | 58 | 55 | 3 (G31, G32, G44 como 2.º lector) | 1 (G4 `confirmar_combinacion`, paso huérfano) | 7 (G15, G23, G26, G29, G30, G45, G47) |
| MARKETING | 23 | 23 | 0 | 1 (M23 scripts) | 4 (M10, M12, M16, M18) |
| INFORMATIVO | 13 | 9 | 4 (I1, I2, I4, I5; I3 solo vía V40) | 0 | 3 (I6, I7, I9) |
| TRANSVERSAL | 31 | 29 | 2 (T1 con `escalate_to_human`, T28) | 1 (T18 bloqueo `wa_is_blocked`) | 3 (T3, T15, T17) |
| **Total** | **174** | **161** | **13** | **3** | **~21** |

Aparte de esos 13, unos 20 flujos de la cola de comprobantes (V34–V36, G1–G25) usan un modelo de visión **solo para leer** la imagen (OCR) y Whisper para transcribir audios; ahí el modelo no decide qué se hace.

Archivos de prueba del bot (`whatsapp*.test.ts`, `wa-*.test.ts`, `caso-*.test.ts`, `plataforma-wa*.test.ts` en `services/`, `jobs/`, `routes/`): **206 archivos, ~3.653 casos** (`it(`/`test(`; `it.each` cuenta 1). Reparto por nombre de archivo (heurístico): VENTAS 59 archivos / ~1.165 casos · GESTIÓN 61 / ~1.160 · TRANSVERSAL 51 / ~818 · MARKETING 23 / ~361 · PLATAFORMA 8 / ~96 · INFORMATIVO 4 / ~53. Dos de los 206 son nuevos SIN commit (`wa-cupos-de-servicio`, `caso-vacacional-auditoria-antes-de-anuncios`). No se ejecutó ninguna prueba.

## C · 2. VENTAS

Orden real de puertas del desconocido: `atenderDesconocidoEnEscuela` BOT:4517-5184. Familia con cuenta: `cuerpoDelTurno` BOT:395-899.

| # | Flujo | Disparo | Respuesta / efecto | step | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| V1 | Puerta única del desconocido (menú «Ya soy del club / Quiero información / Otro tema» y sus datos) | BOTÓN `sm_pd_club`, `sm_pd_info`, `sm_pd_otro`, `sm_pd_soy`, `sm_pd_otro_nombre`, `sm_pd_cortesia`, `sm_pd_inscribirme`, `sm_pd_precios` + REGLA | Mensajes fijos; pide nombre/edad/acudiente; «club» y «otro» abren buzón | `ask_email` (menú), `puerta_club_pregunta`, `puerta_club_recibido`, `puerta_otro_tema`, `puerta_info_nombre`, `puerta_info_edad`, `puerta_info_acudiente`, `puerta_info_quiere`, `puerta_info_listo` | `whatsapp-puerta-desconocido.ts:44-54, 289-465`; BOT:2710, 4671 | whatsapp-conversacion-v2, whatsapp-embudo-prospecto, whatsapp-venta-servicio-ruteo |
| V2 | Bienvenida al desconocido sin tema | REGLA: sin `temaEscolar` ni `puertaDeProspecto` (ATN:391, 714) y la escuela tiene bienvenida | Texto fijo de bienvenida | `bienvenida_desconocido` | BOT:4410-4434, 4843; `whatsapp-bienvenida.ts:18` | whatsapp-bienvenida, whatsapp-auditoria-2026-11-16-bot, whatsapp-silencio-conversacion |
| V3 | Primera respuesta al prospecto (precios / inscripción / pagos / cortesía / enlace) | REGLA `temaEscolar`, `intencionDeProspecto` (ATN:637), `preguntaPrecioComoProspecto` (ATN:475); freno 30 días (`FRENO_DESCONOCIDO_DIAS` BOT:4383) | Texto fijo armado con precios del catálogo, enlace de inscripción o franjas; registra lead; sin enlace → buzón con push | `desconocido_tema_escolar` (+`intencion`: `precios`, `inscripcion`, `pagos`, `pagos_y_precio`, `cortesia_semana`) | BOT:4759-4783, 4965-5182 | whatsapp-atencion-bot, whatsapp-prospecto, whatsapp-prospecto-embudo, whatsapp-auditoria-2026-11-16-bot y 13 más |
| V4 | Embudo de clase de prueba: bienvenida, sede, preguntas de la escuela | REGLA (`embudoActivo` por ajustes de escuela) + BOTÓN `sm_em_*` | Mensajes fijos por paso; estado en el payload | `embudo_bienvenida`, `embudo_pregunta`, `embudo_otra_sede` | `whatsapp-embudo-prospecto.ts:103-119`; BOT:2799, 2815, 4624, 5066 | whatsapp-embudo-prospecto, whatsapp-embudo-por-escuela, whatsapp-embudo-prospecto-bucles, whatsapp-auditoria-2026-11-16-embudo |
| V5 | Embudo: horarios y elección de franja | REGLA + BOTÓN `sm_em_mas` | Lista de franjas (`trial slots`) | `embudo_horarios` | `whatsapp-embudo-prospecto.ts:74, 106` | whatsapp-embudo-prospecto, whatsapp-embudo-por-escuela, whatsapp-consentimiento-seguimiento |
| V6 | Embudo: consentimiento de datos | BOTÓN `sm_em_optin_si` / `sm_em_optin_no` | Registra consentimiento; sigue o cierra | `embudo_consentimiento` | `whatsapp-embudo-prospecto.ts:77-78, 108` | whatsapp-embudo-prospecto |
| V7 | Embudo: cupo separado, esperando pago (clase de prueba paga) | REGLA | Datos de pago + cupo tomado por RPC `tomar_cupo_clase_prueba` | `embudo_esperando_pago` | `whatsapp-embudo-prospecto.ts:109`; `clase-prueba-agenda.service.ts:146` | whatsapp-embudo-prospecto, whatsapp-embudo-por-escuela, whatsapp-seguimiento-cupo |
| V8 | Agendar la clase de prueba | REGLA (tras elegir franja o tras comprobante válido) | RPC `confirmar_cupo_clase_prueba`; mensaje fijo de confirmación | `embudo_agendada`, `clase_prueba_agendada` | `clase-prueba-agenda.service.ts:465, 566`; `whatsapp-embudo-prospecto.ts:110` | clase-prueba-agenda.service, whatsapp-embudo-prospecto, whatsapp-queue-motivo, whatsapp-referidos-bot |
| V9 | Cupo por vencer / cupo liberado | JOB cada 15 min (A) | Aviso «tu cupo vence» (plantilla `clase_prueba_cupo_por_vencer` si la ventana cerró); libera con `soltar_cupos_separados` | `clase_prueba_cupo_por_vencer`, `clase_prueba_cupo_liberado` | `clase-prueba-agenda.service.ts:166, 840, 893-902` | clase-prueba-agenda.service, whatsapp-plantillas-clase-prueba, whatsapp-plantillas.service |
| V10 | Reprogramar / cambiar la clase; sin cupo; sin horario | BOTÓN `sm_em_reprogramar`, `sm_em_cambiar`, `sm_em_ahi` | Reagenda; plantilla `clase_prueba_reprogramada` | `clase_prueba_reprogramada`, `clase_prueba_sin_cupo`, `clase_prueba_sin_horario` | `clase-prueba-agenda.service.ts:56-57, 534, 540, 1120` | clase-prueba-agenda.service, whatsapp-plantillas-clase-prueba |
| V11 | Embudo: preguntas laterales sin perder el paso | REGLA | «¿Y la matrícula?», «¿dónde queda?», «me equivoqué de sede», recordatorio del paso pendiente | `embudo_matricula`, `embudo_donde`, `embudo_cambio_de_sede`, `embudo_recordar_paso` | `whatsapp-embudo-prospecto.ts:113-119` | whatsapp-auditoria-2026-11-16-embudo, whatsapp-embudo-por-escuela, whatsapp-embudo-prospecto |
| V12 | Embudo: pasar a una persona | BOTÓN `sm_em_persona` o REGLA (motivos `no_entendio`, `pide_persona`, `sin_horarios`, `sin_cuentas_de_pago`, `pide_matricula`) | Texto fijo + buzón | `embudo_a_persona` | `whatsapp-embudo-prospecto.ts:76, 111, 227-228` | whatsapp-embudo-prospecto, whatsapp-embudo-prospecto-bucles, whatsapp-auditoria-2026-11-16-embudo |
| V13 | Acuse del embudo cuando el turno quedó callado | REGLA post-turno (`pasoPorElEmbudo`, `mensajeConContenido`) | «Ya le pasé tu pregunta a la escuela» + buzón | `embudo_pregunta_a_la_escuela` | BOT:3897, 3940-3994 | whatsapp-embudo-por-escuela, whatsapp-embudo-prospecto |
| V14 | Clase de cortesía (flujo de franjas: perfil → nombre → edad → acudiente → confirmar → reservada) | REGLA `pideClaseDeCortesia` (BOT:693-699) + BOTÓN `sm_cc_mas`, `sm_cc_datos_si/no`, `sm_cc_confirmar`, `sm_cc_cambiar` + **LLM** (tool `get_trial_class_info`, BOT:6860-6895: el modelo solo decide ENTRAR; el flujo es determinista) | Mensajes fijos; reserva con RPC `submit_school_lead` | `cortesia_perfil`, `cortesia_ofrecer`, `cortesia_nombre`, `cortesia_edad`, `cortesia_acudiente`, `cortesia_confirmar`, `cortesia_reservada`, `cortesia_recordar_paso` | `whatsapp-clase-cortesia.service.ts:296-303, 1166-1175, 1460, 1572-1729, 1903, 2220`; BOT:1931 | whatsapp-clase-cortesia, whatsapp-clase-cortesia-bot, whatsapp-clase-cortesia-textos, whatsapp-auditoria-2026-11-16-cortesia, whatsapp-prospecto-embudo |
| V15 | Cortesía: bordes y fallas | REGLA | Textos fijos por caso | `cortesia_sin_franjas`, `cortesia_ya_reservada`, `cortesia_franja_vencida`, `cortesia_cupo_lleno`, `cortesia_error_reserva`, `cortesia_duplicado`, `cortesia_demasiados_intentos`, `cortesia_abandonada`, `cortesia_no_deja_datos`, `cortesia_datos_dejados` | `whatsapp-clase-cortesia.service.ts:1130-1140, 1521-1533, 1714, 1840-1892` | whatsapp-clase-cortesia, whatsapp-auditoria-2026-11-16-cortesia |
| V16 | Cortesía: cancelar la reserva | BOTÓN `sm_cc_cancelar`, `sm_cc_cancelar_si/no`; texto «CANCELAR» tras el recordatorio | Libera el cupo o deja la cancelación pedida a la escuela | `cortesia_confirmar_cancelacion`, `cortesia_cancelada`, `cortesia_cancelacion_pedida`, `cortesia_cancelacion_desistida`, `cortesia_sin_reserva` | `whatsapp-clase-cortesia.service.ts:301-303, 1064-1069, 1637, 1921-1933` | recordatorio-cortesia.service, whatsapp-clase-cortesia, whatsapp-clase-cortesia-textos |
| V17 | ¿En qué grupo queda por edad? | REGLA `preguntaGrupoPorEdad` | Grupo según edad; sin grupo → texto fijo | `cortesia_sin_grupo_para_edad` (y el que pase `grupoPorEdadEnBot`) | BOT:706, 1895; `whatsapp-clase-cortesia.service.ts:1027` | Solo la regla pura (grupos-por-edad.service). **Enganche en el bot SIN PRUEBA** |
| V18 | Semana de cortesía | REGLA + ajuste de la escuela | Texto fijo con el enlace de la semana | `cortesia_semana` | BOT:1969-1981 | whatsapp-ajustes-por-escuela-bot, whatsapp-consent-novedades-bot |
| V19 | «Llegué» el día de la clase | REGLA | Texto fijo de llegada | `cortesia_llegada` | BOT:4641-4643, 5192 | whatsapp-prospecto-embudo (mención) |
| V20 | Recordatorios de la clase y seguimiento de la noche | JOB 18:00; cada 15 min 7–19 h; 20–21 h; 21:30 (A) | Texto o plantilla `recordatorio_clase_cortesia` / `recordatorio_clase_prueba`; no escribe si bot apagado, tomada, escuela en la charla o baja | `recordatorio_cortesia_<tipo>`, `cortesia_seguimiento_noche` | `recordatorio-cortesia.service.ts:408-463`; `prospecto-ciclo-clase.service.ts:228` | recordatorio-cortesia.service, whatsapp-plantillas-clase-prueba, whatsapp-prospecto-embudo |
| V21 | Cupo separado y el flujo ya no está abierto → a la escuela | REGLA `hayCupoSeparadoSinFlujoAbierto` | Texto fijo + buzón (`puerta_otro`) | `cupo_separado_a_la_escuela` | BOT:1915-1950 | Solo whatsapp-vigilante.service (mención). **Rama SIN PRUEBA directa** |
| V22 | Destino por anuncio (clic a WhatsApp) | REGLA: `referral` del webhook → mapeo `sourceId` → destino | Lleva al servicio, al embudo, a una persona o pregunta entre varios | `destino_anuncio` en el payload; destinos `anuncio_servicio`, `anuncio_embudo`, `anuncio_persona`, `anuncio_varios` | `whatsapp-anuncio-destino.ts:81, 871-874`; BOT:3101, 4616, 4681 | whatsapp-anuncio-destino, whatsapp-anuncio-destino.armadoras, whatsapp-anuncio-destino.vacacional, caso-venta-cerrada-clinica, whatsapp-ventas-flujo. Parte del archivo **SIN DESPLEGAR** |
| V23 | Venta de servicio (clínica, vacacional, campamento, torneo): cotización y datos de pago | REGLA `EVENTO_DE_SERVICIO` (RT:28-37) o servicio nombrado; venta activa 7 días | Texto fijo con precio del catálogo y cuentas; sin precio → aviso | `venta_servicio_pago`, `venta_servicio_sin_precio` | `whatsapp-venta-servicio.ts:66-67`; BOT:3503, 3573, 4591 | whatsapp-venta-servicio, whatsapp-venta-servicio-ruteo, caso-monster-respuestas-directas-venta, caso-auditoria-entendimiento-venta y 9 más |
| V24 | Venta: opción elegida («2 semanas», «del 23 al 27») y otra fecha | REGLA | Guarda la opción en el payload; recalcula el valor | `venta_servicio_opcion`, `venta_servicio_otra_fecha` | `whatsapp-venta-servicio.ts:70, 86`; BOT:3227 | whatsapp-integracion-reclamo-y-opcion, whatsapp-queue-venta |
| V25 | Venta: datos de quien asiste (nombre, fecha de nacimiento…) y varios nombres | REGLA (`whatsapp-datos-de-registro.ts`) | Guarda el registro; con 2+ nombres pregunta para quién es el pago | `venta_servicio_asistente`, `venta_servicio_varios_asistentes` | `whatsapp-venta-servicio.ts:78, 88`; `wa-registro-de-venta.service.ts` | whatsapp-datos-de-registro, whatsapp-venta-servicio, caso-auditoria-entendimiento-venta, caso-comprobante-antes-del-nombre |
| V26 | Venta: botones [Separar mi cupo] [Ver detalles] [Hablar con alguien] [Ya pagué] | BOTÓN (id con el servicio; `ya_pague`) | Ficha de la escuela / aviso a la escuela / espera comprobante | `venta_servicio_detalles`, `venta_servicio_humano`, `venta_servicio_ya_pago`, `venta_servicio_no_vigente` | `whatsapp-venta-servicio.ts:71, 80-84, 105`; BOT:502-504, 3409 | whatsapp-venta-botones, caso-vacacional-usuario-sin-telefono, caso-venta-cerrada-clinica |
| V27 | Venta: pregunta libre sobre el servicio | **LLM** Haiku sin tools (`whatsapp-servicio-ia.ts:228-233`), con verificador de montos y una corrección | Texto del modelo ≤450 caracteres; `NO_SE` → pasa a la escuela | `venta_servicio_respuesta` / `servicio_ia`; `venta_servicio_a_la_escuela` | `whatsapp-servicio-ia.ts:97, 139-176, 201-256`; `whatsapp-venta-servicio.ts:68-69` | whatsapp-servicio-ia, whatsapp-venta-servicio, caso-comprobante-antes-del-nombre, whatsapp-vigilante.service |
| V28 | Venta: micro-respuestas | REGLA | «Claro, dime», cierre amable si desiste, la llave Bre-B, saludo | `venta_servicio_saludo`, `venta_servicio_dime`, `venta_servicio_desiste`, `venta_servicio_llave` | `whatsapp-venta-servicio.ts:72, 90-94` | caso-vacacional-usuario-sin-telefono, caso-monster-respuestas-directas-venta |
| V29 | Venta: pide el club en plena venta / toca un botón viejo del club | REGLA + BOTÓN viejo | «El club va aparte y cuesta…»; una sola respuesta al botón viejo | `venta_servicio_club_aparte`, `venta_servicio_boton_club` | `whatsapp-venta-servicio.ts:74-76`; BOT:3346, 3378 | whatsapp-venta-contexto, whatsapp-venta-servicio-ruteo, whatsapp-venta-servicio |
| V30 | Venta: varios cupos, pide abonar, «soy afiliado» | REGLA `pideVariosCupos`, `pideAbonar`, `diceSerAfiliado` | Textos fijos; **«Entonces aplica el valor de afiliados. La escuela confirma…»** | códigos `varios_cupos`, `sin_abonos`, `dice_ser_afiliado` (step NO VERIFICADO) | `whatsapp-venta-servicio.ts:~772-820, 1556-1589` (working tree) | caso-vacacional-auditoria-antes-de-anuncios. **SIN DESPLEGAR** |
| V31 | Venta cerrada (servicio ya no se vende / cupos llenos) | REGLA `ventaCerradaDeItem` | Texto fijo + buzón; cupos llenos = **SIN DESPLEGAR** (`wa-cupos-de-servicio.service.ts`) | `venta_cerrada` | BOT:3434-3488; `whatsapp-anuncio-destino.ts:~207-227` | caso-venta-cerrada-clinica; wa-cupos-de-servicio (SIN DESPLEGAR) |
| V32 | Formulario de inscripción al servicio (WhatsApp Flow) | BOTÓN/REGLA envía el Flow; respuesta `nfm_reply` con token firmado; error 131026 → sigue por chat | Guarda registro del servicio; sin modelo | `formulario_enviado`, `formulario_respuesta`, `formulario_respaldo` | `whatsapp-formulario-servicio.ts:50-52, 304-305`; BOT:2930, 2982, 3068 | whatsapp-formulario-bot, whatsapp-formulario-servicio, whatsapp-flows.service |
| V33 | Venta a familias con cuenta (catálogo: elegir ítem → atleta → confirmar → enlace de pago) | REGLA (`ventasHabilitadas`) + BOTÓN `sm_vt_si` / `sm_vt_no` | Crea cobro y manda enlace; puede anular | `venta_elegir_item`, `venta_elegir_atleta`, `venta_confirmar`, `venta_esperando_pago`, `venta_link_enviado`, `venta_cobro_sin_link`, `venta_ya_pagada`, `venta_cancelada`, `venta_vencida`, `venta_sin_catalogo`, `venta_sin_cupos`, `venta_sin_atleta_activo`, `venta_desiste_pagada`, `venta_anular_fallo` | `whatsapp-venta-servicios.service.ts:78, 387-388, 488-830`; BOT:654, 892, 1803 | whatsapp-venta-servicios, whatsapp-ventas-flujo, whatsapp-imagen |
| V34 | Comprobante de una venta (cola) | WEBHOOK + OCR (LLM solo lee) + REGLA de monto | **Crea el cobro** (`crearCobroDeVenta`) y aplica; texto «Quedó registrado tu pago… Tu cupo está confirmado» si se aprobó solo | `venta_comprobante_recibido`, `venta_comprobante_a_la_escuela`, `venta_comprobante_repetido`; códigos `venta_monto_no_cuadra`, `venta_afiliado_sin_verificar`, `venta_ya_tiene_cobro`, `venta_sin_cupos`, `venta_saldo_con_abono_en_revision`, `venta_tramo_por_fecha_de_pago` | COLA:2173-2187, 2318-2465, 2495-2559, 2759-3046 | whatsapp-queue-venta (1.682 líneas), caso-clinica-nombre-no-registrado, caso-vacacional-usuario-sin-telefono, whatsapp-queue-motivo |
| V35 | Comprobante de venta sin nombre / varios nombres / «¿es el mismo?» | REGLA en la cola + BOTÓN `sm_asiste_si` / `sm_asiste_otra`; nombre tardío | Pregunta y espera (`waiting_user`); el nombre que llega después se registra | `ask_asistente_servicio`, `ask_asistente_confirmar`, `venta_comprobante_incompleto`; códigos `venta_falta_nombre`, `venta_varios_nombres`, `nombre_tardio_registrado` | COLA:2625-2733; `whatsapp-comprobante-de-ficha.service.ts:303, 642-648`; `wa-nombre-tardio.service.ts`; `whatsapp-respuesta-de-cobro.service.ts:148, 626` | caso-comprobante-antes-del-nombre, caso-clinica-nombre-no-registrado, caso-datos-despues-de-comprobante-escalado, whatsapp-queue-venta |
| V36 | Comprobante de prospecto (clase de prueba paga) | WEBHOOK + OCR + REGLA | Agenda la clase o pasa a persona | `clase_prueba_agendada`, `clase_prueba_comprobante_rechazado`; códigos `clase_prueba_no_coincide`, `clase_prueba_sin_agenda`, `clase_prueba_a_persona`, `comprobante_prospecto_no_coincide`, `comprobante_prospecto_con_cantidad`, `comprobante_prospecto_sin_concepto` | COLA:1842-1945 | whatsapp-queue-motivo |
| V37 | Seguimiento a las 20 h | JOB min 7, 22, 37, 52 (A); **LLM** Haiku redacta | Un mensaje al interesado que dejó de contestar (ventana abierta); no si hay cupo separado, escuela atendiendo o fuera de horario | `prospecto_seguimiento_20h` | `whatsapp-prospecto-seguimiento.service.ts:30, 67-90, 281` | whatsapp-seguimiento-20h, whatsapp-prospecto-seguimiento, whatsapp-prospecto-ia |
| V38 | Respuesta al seguimiento (acepta un día, pregunta, pide persona) | REGLA `seguimientoQueContesta`, `diaAceptadoDelSeguimiento`, `diaPedidoEn`; ventana 72 h (BOT:5478) | Horarios del día o escala `prospecto_seguimiento_persona` | `prospecto_seguimiento_horarios` | BOT:5423, 5485-5565 | whatsapp-embudo-por-escuela, whatsapp-prospecto-ia, whatsapp-venta-servicio |
| V39 | Seguimiento por reglas tras la primera respuesta | REGLA (`PREGUNTA_SEDE` BOT:5269, precio, horario, info, persona) | Horarios / precios / info con o sin enlace; persona → escala | `prospecto_seguimiento_horarios`, `prospecto_seguimiento_precios`, `prospecto_seguimiento_info`; reason `prospecto_seguimiento_persona` | BOT:5250-5253, 5277-5409 | whatsapp-prospecto-seguimiento, whatsapp-prospecto-embudo, whatsapp-embudo-por-escuela |
| V40 | Prospecto con IA sobre la ficha libre | **LLM** Haiku sin tools; solo si la escuela escribió ficha; tope 8 respuestas/hora, 650 caracteres | Texto del modelo verificado (montos, fechas, enlaces) | `prospecto_ia` | BOT:4900-4904, 5438-5461; `whatsapp-prospecto-ia.service.ts:56-60, 165-232, 417-451` | whatsapp-prospecto-ia, whatsapp-prospecto-ia-catalogo, whatsapp-verificador-montos, whatsapp-vigilante.service |
| V41 | Acuse fijo «pasé tu mensaje a la escuela» (cuando reglas e IA no cubren) | REGLA; 1 cada 24 h (`pasoReciente`) | Texto fijo + buzón | `prospecto_seguimiento` (+`pregunta_nueva`, `intencion`) | BOT:4868-4932, 4995-5000, 5187 | whatsapp-prospecto-seguimiento, whatsapp-auditoria-2026-11-16-bot |
| V42 | Rescate por plantilla (ventana cerrada, hasta 7 días) | JOB min 12, 42 (A); exige consentimiento de seguimiento | Plantilla `seguimiento_interesado` | `prospecto_rescate_plantilla` | `whatsapp-prospecto-rescate.service.ts:27-30, 55-64, 182` | whatsapp-prospecto-rescate.service |
| V43 | Consentimiento de seguimiento | BOTÓN (Sí / No) tras la primera respuesta | Guarda la respuesta (habilita V42) | `consentimiento_seguimiento` (+`respuesta`) | BOT:3619-3663; `whatsapp-consentimiento-seguimiento.ts:13` | whatsapp-consentimiento-seguimiento, whatsapp-consent-novedades-bot |
| V44 | Referidos | REGLA (pregunta por el programa) + post-turno tras `embudo_agendada` / `cortesia_reservada` | Info del programa, «¿quién te refirió?», respuesta; sin campaña → escuela | `referido_pregunta`, `referido_respuesta`, `referidos_info`, `referidos_a_la_escuela` | `whatsapp-referidos-bot.ts:25-41`; `whatsapp-bot-oleada1.ts:65-85`; BOT:637, 4579 | whatsapp-referidos-bot |
| V45 | Patrocinio / alianza de marca | REGLA `esConsultaDePatrocinio` | Texto fijo + buzón (`puerta_otro`) | `patrocinio` | BOT:493-495; `whatsapp-patrocinio.ts` | whatsapp-patrocinio, whatsapp-seguimiento-conversaciones |
| V46 | «Quiero pagar una mensualidad» de un número sin ficha | REGLA + BOTÓN `sm_pm_club` / `sm_pm_inscribirme` | Pregunta de dos botones; «inscribirme» → buzón de prospecto | `pago_mensualidad_aclaracion`, `pago_mensualidad_inscribirme`, `prospecto_afiliado_hipotetico` | BOT:3836-3887, 5302; `whatsapp-pagar-mensualidad.ts:34-41, 123` | whatsapp-pagar-mensualidad |
| V47 | ¿Cuántas clases trae el plan? | REGLA `responderClasesDePlan` | Texto fijo; sin dato → buzón | `plan_clases` | BOT:4792-4798 | whatsapp-conversacion-v2, whatsapp-consentimiento-seguimiento (mención) |
| V48 | Ubicación / pide que lo llamen | REGLA `pideUbicacion` (ATN:792), `pideLlamada` (ATN:781) | Dirección u horario presencial; llamada → buzón + acuse | `ubicacion_escuela`; `prospecto_seguimiento` (`intencion: pide_llamada` / `ubicacion_a_persona`) | BOT:5074-5102, 5189 | whatsapp-embudo-por-escuela, whatsapp-prospecto, whatsapp-prospecto-lead.embudo |
| V49 | Pago de torneos / «torneo o club» | REGLA por catálogo de torneos y monto | Empareja nombre+monto o pasa a la escuela | código `torneo_o_club` | `whatsapp-torneos-pago.service.ts:40-50`; COLA:1018-1021 | whatsapp-torneos-pago.service, whatsapp-queue-auditoria-2026-11 |

## C · 3. GESTIÓN

### 3.1 Comprobantes (cola `whatsapp_inbound_queue`, worker cada minuto)

El OCR (Gemini → OpenAI → Claude, parte A §3.1) **solo lee** la imagen. A qué cobro va, si se aplica y qué se responde son reglas. El veredicto final es `evaluatePaymentReceipt` (`receipt-approval.service.ts:188-340`).

| # | Flujo | Disparo | Respuesta / efecto | step / código | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| G1 | Acuse de recibo del adjunto | WEBHOOK encola; el worker arma un acuse diferido (~90 s, 1.er intento); el turno de texto acusa si hay pista de pago (`PISTA_DE_PAGO` BOT:8588) | «Recibí tu archivo…» | `acuse_recibo_comprobante`, `acuse_adjunto`, `comprobante_en_silencio` | `whatsapp-acuse-recibo.ts:18`; COLA:5051-5072, 5438 (A); BOT:8598 | whatsapp-acuse-recibo, whatsapp-queue-acuse-recibo-silencio y 15 más |
| G2 | Aplicar el comprobante a un cobro existente | OCR + REGLA (`elegirPorPista`, monto, destino) | Estampa el comprobante en `payments` (`awaiting_approval`) y evalúa. **Si la escuela tiene `auto_approve_enabled` y el monto ≤ tope: «¡Listo! ✅ Apliqué tu pago a… Queda al día»**; si no: «La escuela lo confirma»; rechazo automático: «no lo pude validar» | `resultado_comprobante` | COLA:669-942 (texto 856-874); `receipt-approval.service.ts:199-219, 292-296` | whatsapp-queue.job, whatsapp-queue-una-respuesta, whatsapp-pagos-unicos, wa-cola-reglas y 9 más |
| G3 | «¿A cuál cobro va?» (varios pendientes) | REGLA; la respuesta llega por texto o botón y la resuelve `resolverRespuestaDeCobro` | Pregunta y deja la fila en `waiting_user`; reintento acotado; a los 24 h vence | `ask_cual_pago`, `ask_cual_pago_acotado`, `ask_cual_pago_reintento`, `eleccion_cancelada`, `eleccion_a_la_escuela`, `eleccion_multiple`, `no_entendi`, `aplicacion_fallo` | COLA:3561, 5690-5760; `whatsapp-respuesta-de-cobro.service.ts:118, 419-545`; `whatsapp-eleccion-de-pago.service.ts:373-404` | whatsapp-respuesta-de-cobro, whatsapp-respuesta-de-cobro-auditoria-2026-11, whatsapp-eleccion-de-pago, whatsapp-queue-cobro-abierto y ~35 más |
| G4 | «Confirmar combinación» | — | **Paso huérfano**: está en `PASOS_PREGUNTA` y en el vencimiento, pero nada lo emite | `confirmar_combinacion` | COLA:4109, 5762 | **SIN PRUEBA** (código muerto, NO VERIFICADO que no venga de borradores viejos) |
| G5 | Crear el cobro desde el comprobante (inscripción, artículo, clase extra, servicio, torneo, clase de prueba) | REGLA por monto y concepto esperado (`wa-concepto-esperado.service.ts`, `whatsapp-pago-esperado.service.ts:46`) | **INSERT en `payments`** y aplica; decisiones `aplicar_existente`, `cobro_distinto`, `a_la_escuela`, `es_cuota`, `con_cantidad`, `saldo_en_revision`, `aplicar_previo`, `tramo_anterior`, `no_cuadra`, `ya_tiene_cobro` | `resultado_comprobante` (o el de la venta) | `wa-cobro-desde-comprobante.service.ts:37, 121-238, 675-733, 887-905`; COLA:1563-1610 | wa-cobro-desde-comprobante, wa-concepto-esperado.service, whatsapp-pago-esperado.service, whatsapp-queue-pago-esperado, wa-afiliado.service |
| G6 | Aplicar a un cobro abierto (valor que fija quien paga) | REGLA; RPC `aplicar_comprobante_a_cobro_abierto` | Aplica a `payments` como `comprobante_bot` | códigos `venta_cobro_abierto_*`, `no_cuadra` | `wa-cobro-abierto.service.ts:271-357`; COLA:2835-2916 | wa-cobro-abierto, whatsapp-queue-cobro-abierto |
| G7 | «Por clasificar» (el bot no supo a qué va) | REGLA `pasarAPorClasificar`; lo resuelve la escuela por RUTA | Fila en la bandeja; la escuela elige `abono_de_cobro`, `saldo_de_cobro`, `clase_de_prueba`, `servicio_nuevo`, `fuera_de_sportmaps`, `por_identificar` | `result_type`/código; sin mensaje propio | COLA:498-520; `wa-comprobante-por-clasificar.service.ts:22-23, 254-266`; `routes/whatsapp-por-clasificar.routes.ts:88-273` (A) | wa-comprobante-por-clasificar, whatsapp-queue-comprobantes-sin-rastro, whatsapp-bandeja.service |
| G8 | Otro concepto (no es la mensualidad) | REGLA `motivoDeOtroConcepto` (lo que escribió con el pago) | Crea/aplica al concepto o pasa a la escuela | código `otro_concepto`, `pago_partido`, `torneo_o_club` | COLA:981-1036, 3230, 3346; `whatsapp-otro-concepto.service.ts:25-33, 179` | whatsapp-otro-concepto, whatsapp-queue-motivo, whatsapp-comprobante-guiado.service |
| G9 | Comprobante guiado: ¿de qué mes? ¿qué concepto? ¿de quién? + resumen de motivos | REGLA + BOTÓN `sm_motivos_ok` / `sm_motivos_cambiar` | Preguntas con botones; resumen de una ráfaga con el motivo de cada archivo | `ask_mes`, `ask_concepto`, `ask_deportista_botones`, `resumen_motivos`, `resumen_motivos_ok`, `resumen_motivos_cambiar`, `resultado_comprobante_guiado`, `guiado_a_la_escuela` | `whatsapp-comprobante-guiado.service.ts:81-87, 365-383`; COLA:1114-1211, 1638; `whatsapp-respuesta-de-cobro.service.ts:799-858` | whatsapp-comprobante-guiado.service, whatsapp-queue-motivo, whatsapp-respuesta-fila |
| G10 | Comprobante de un número sin ficha: «¿de qué deportista es?» | REGLA; busca por nombre | Pregunta 1 vez; aplica **sin verificar** al cobro del deportista nombrado o pasa a la escuela | `ask_deportista`; códigos `numero_sin_verificar`, `sin_verificar_recibido`, `sin_verificar_rechazado`, `sin_verificar_repetido`, `sin_verificar_a_la_escuela` | `whatsapp-comprobante-de-ficha.service.ts:43`; COLA:1037-1113, 4644-4990 | whatsapp-queue-comprobante-de-ficha, whatsapp-queue-rafaga-sin-ficha, whatsapp-comprobante-de-ficha, caso-comprobante-antes-del-nombre |
| G11 | Comprobante repetido (misma imagen o misma referencia) | REGLA: sha256 de la imagen y `receipt_reference_norm` | Avisa 1 vez que ya estaba registrado | `comprobante_repetido`, código `ya_registrado` | COLA:1465-1477, 3456, 3617-3697 | whatsapp-queue-una-respuesta, whatsapp-queue-cobro-abierto, whatsapp-recuperacion, whatsapp-bandeja.service |
| G12 | Destino del pago no es una cuenta de la escuela | REGLA `destinoEsDeLaEscuela`, `destinoFueraDeSportmaps` | No aplica; pasa a la escuela | códigos `destino_ajeno`, `fuera_de_sportmaps`, `venta_destino_no_confirmado` | COLA:1350-1440, 3157-3179, 4323, 4502 | whatsapp-queue-comprobantes-sin-rastro, whatsapp-queue-pago-esperado, whatsapp-bandeja-dinero-2026-10-13 |
| G13 | No es un comprobante / es un listado | OCR `isReceipt=false` + REGLA de contexto (`textosConContextoDePago` COLA:4247) | Sin contexto de pago: se cierra mudo; con contexto: «no es un comprobante» | `no_es_comprobante`, `es_listado`, `no_es_comprobante_sin_contexto`, `archivo_no_leido` | COLA:3146, 4278-4290, 4408; `wa-cola-reglas.ts:94, 489` | wa-cola-reglas, whatsapp-queue-atencion, whatsapp-queue-una-respuesta |
| G14 | Familia sin cuenta / número ambiguo / sin acudiente | REGLA `decidirAdjunto` (COLA:3971) | «Debes registrarte» 1 vez; el comprobante queda para la escuela (nunca se ignora) | `familia_sin_cuenta`; códigos `escalar_sin_cuenta`, `escalar_ambiguo`, `numero_ambiguo`, `familia_sin_acudiente`, `contacto_no_atendido` | COLA:3511, 3964-3968, 4173, 4388, 5093, 5596-5625 | whatsapp-queue-atencion, whatsapp-bot-consentimiento-boton-2026-11-18, whatsapp-bot-intrusion-2026-11-17 y 12 más |
| G15 | Tope de comprobantes por número y por escuela | REGLA antes del OCR | A revisión manual | `comprobante_limite_revision`; `limite_numero`, `limite_escuela` | `wa-limite-comprobantes.service.ts:25-37`; COLA:4432-4458 | wa-limite-comprobantes.service (solo unitaria) |
| G16 | Ráfaga de archivos → UNA respuesta | REGLA `resumirRafaga` | Un solo mensaje con todos los resultados | `resultado_rafaga` | COLA:4134-4168, 5822-5866 (A) | whatsapp-queue-una-respuesta, whatsapp-queue-motivo, whatsapp-queue-rafaga-sin-ficha |
| G17 | Abonos (pago parcial) | REGLA; depende de `school_settings.allow_installments` | Aplica como abono en revisión o pasa a la escuela | código `abono_en_revision` | COLA:328-352, 967; `wa-cola-reglas.ts`; `whatsapp-pago-esperado.service.ts:89` | wa-cola-reglas-abonos, whatsapp-pago-esperado.service, whatsapp-queue-pago-esperado |
| G18 | Excedente / saldo a favor | REGLA | Nota en la respuesta; el saldo lo acredita la base | — | `whatsapp-excedente.service.ts`; `whatsapp-cobro-por-texto.service.ts:57` | whatsapp-bandeja-dinero-2026-10-13, wa-cola-reglas-abonos (cobertura del servicio NO VERIFICADA) |
| G19 | Comprobante colgado y preguntas sin respuesta | JOB cada 2 min: alerta a los 5 min, vence a los 10 min; preguntas `waiting_user` vencen a las 24 h | Pasa a la escuela y avisa 1 vez a la familia | `comprobante_a_revision_manual`; `pregunta_no_enviada`, `pregunta_en_borrador`, `pregunta_en_fila`, `sin_respuesta` | `jobs/whatsapp-cola-vencimiento.job.ts:34-35, 54-76`; COLA:5692-5724; BOT:8692 | whatsapp-cola-vencimiento.job, whatsapp-queue-comprobantes-sin-rastro, whatsapp-queue.job |
| G20 | Resultado del pago (la escuela aprueba / rechaza / abono) | JOB cada minuto; idempotente por `outcome_notified_at` | Texto en ventana abierta o plantilla (`pago_confirmado`, `pago_recibido_otro_concepto`, `abono_recibido`, `comprobante_rechazado`); sin opt-in no sale plantilla | `resultado_<desenlace>` | `jobs/whatsapp-payment-outcome.job.ts:147-151, 346-353, 547, 1140` | whatsapp-payment-outcome.job, whatsapp-payment-outcome.avisos-2026-11-08, whatsapp-payment-outcome-consentimiento, whatsapp-auditoria-2026-10-13 |
| G21 | «Tu comprobante está en revisión» con la ventana cerrada | REGLA tras error de ventana de Meta | Plantilla `comprobante_en_revision` | `resultado_comprobante_plantilla` | COLA:908-912, 1212-1220; `whatsapp-aviso-revision.service.ts:61` | whatsapp-plantillas.service, whatsapp-recuperacion |
| G22 | Recuperación de comprobantes viejos (bandeja → reproceso) | RUTA `POST /:schoolId/ponerse-al-dia` (A) y scripts `wa-recuperar-comprobantes.ts`, `wa-ponerse-al-dia.ts` | Reprocesa; avisa por plantilla o no avisa (`fuera_de_ventana`, `conversacion_tomada`, `escuela_en_la_conversacion`) | `recuperado_<decisión>` | `whatsapp-recuperacion.service.ts:90-111, 1296-1301`; `whatsapp-ponerse-al-dia.service.ts` | whatsapp-recuperacion (788 líneas), whatsapp-ponerse-al-dia, whatsapp-admin.bandeja |
| G23 | «Sigues en fila» | JOB min 5, 20, 35, 50 · 8–18 h · lun–sáb (A); >2 h hábiles esperando a una persona | 1 confirmación de que sigue en espera | `sigue_en_fila` | `whatsapp-sigue-en-fila.service.ts:41-43, 79` | whatsapp-sigue-en-fila (un archivo) |
| G24 | Alta por foto de matrícula (staff admin manda la planilla de inscripción) | REGLA `procesarComoStaffAdmin` | Encola `enrollment_form_intake` en `waiting_review` | `matricula_encolada` | COLA:3698-3811, 3868 | whatsapp-queue.job, informe-calidad-bot.service |
| G25 | Asistencia del staff por WhatsApp (texto «lista» o foto de planilla) | REGLA + BOTÓN `asis_grupo`, `asis_equipo`, `asis_guardar`, `asis_corregir`, `asis_descartar`; **corre aunque el bot esté apagado** | Lee la planilla (OCR), pregunta grupo, guarda asistencia | `asistencia_staff` | `whatsapp-asistencia-staff.service.ts:46-58, 783-787`; COLA:3812-3849; WH:658, 870-893 (A) | whatsapp-asistencia-staff.service, whatsapp-queue-planilla-staff, whatsapp-asistencia-humo-webhook |
| G26 | Factura electrónica | BOTÓN `sm_fe_si/no/aqui/form/cc/nit/otro/ok/corregir/quiero` + REGLA | Pide tipo y número de documento, nombre, correo; guarda | `factura_preguntar_quiere`, `factura_elegir_canal`, `factura_tipo_documento`, `factura_tipo_documento_otro`, `factura_numero`, `factura_nombre`, `factura_correo`, `factura_confirmar`, `factura_guardada`, `factura_formulario_enviado`, `factura_no_quiere`, `factura_cancelada`, `factura_no_disponible`, `factura_sin_flujo`, `factura_demasiados_intentos`, `factura_error_guardar` | `whatsapp-factura.service.ts:42-78, 305-542`; BOT:645, 1765 | whatsapp-factura.service (un archivo) |

### 3.2 Cuenta, cobros, mora, plazos, pausa, asistencia

| # | Flujo | Disparo | Respuesta / efecto | step | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| G27 | Anuncia el comprobante («te envío el soporte») | REGLA `anunciaComprobante` (`VERBO_ENVIO`, `OBJETO_PAGO`, `FUTURO`, `ACABO_DE_PAGAR` RT:69-82) | «Listo, envíalo por aquí» | `comprobante_anunciado` | BOT:855-857, 1114-1123 | whatsapp-reglas-turno, whatsapp-bot-dynasty-2026-10-06 |
| G28 | «Ya pagué» y reclama | REGLA `yaPagoYReclama` (`YA_PAGUE` RT:124-137) | Estado de sus comprobantes; si no encuentra nada → buzón | `estado_comprobantes` | BOT:870-871, 1244-1290 | whatsapp-reglas-turno, whatsapp-bot-dynasty-2026-10-06 |
| G29 | Reclama el resultado que le dio la cola («ese no era», «era de otro mes») | REGLA `resolverReclamoDeResultado` | La fila pasa a `ignored` + nota; «recibí tu reclamo» o pasa a la escuela | `reclamo_de_resultado` | `whatsapp-respuesta-de-cobro.service.ts:176-232`; BOT:571-572, 1232, 4571 | whatsapp-integracion-reclamo-y-opcion (un archivo) |
| G30 | Reclamo de valor («me están cobrando de más») | REGLA `motivoReclamoDeValor` | Muestra los cobros y **escala** | `escalated` (reason del reclamo) | BOT:864, 2009-2019; `whatsapp-reclamo-valor.service.ts` | whatsapp-ajustes-por-escuela (mención). Cobertura débil |
| G31 | Saldo y estado de cuenta | **LLM** elige tool `get_payment_status` y redacta; BOTÓN `sm_ver_pagos` (sin modelo) | RPC `wa_get_payment_status` + enlaces `/p/:token`; si falla la redacción, `fallbackPaymentText` | `get_payment_status`, `payment_fallback` | BOT:1485-1495, 6975-7030, 8770-8778 | whatsapp-bot-auditoria-turno, whatsapp-auditoria-2026-10-07, whatsapp-enlaces-de-pago, whatsapp-mensajes-de-pago-claros y 16 más |
| G32 | Medios de pago de la familia | **LLM** tool `get_payment_methods`; BOTÓN `sm_como_pagar` | Cuentas, enlace y cobros pendientes; respaldo `fallbackMediosDePago` | `get_payment_methods`, `medios_fallback` | BOT:1468-1475, 6936-6972, 7043; `whatsapp-medios-de-pago.service.ts` | whatsapp-bot-memoria-botones, seguridad-llm-comprobantes.poc |
| G33 | Cómo pagar (público, sin cuenta) | REGLA; freno 6 h (`FRENO_MEDIOS_PUBLICOS_H` BOT:4216) | Cuentas públicas; «pago presencial» → escala `atencion_presencial` | `medios_de_pago_publicos`, `medios_de_pago_confirma` | BOT:4212-4214, 4292-4340; `whatsapp-pago-publico.ts` | whatsapp-retoma-y-pago-publico, whatsapp-casos-reales-monster-11-05 |
| G34 | Audio cuando hay una pregunta de cobro abierta | REGLA (`origen === 'audio'` + `hayPreguntaDeCobroAbierta`) | «Escríbemelo, por favor» (no decide dinero con un audio) | `cobro_por_audio` | BOT:557-558, 744-745, 4560, 7668 | whatsapp-audio-pregunta-de-dinero |
| G35 | Cobro por texto (dice el mes o el monto sin adjunto) | REGLA (`mes_del_texto`, `mas_antiguo`, `saldo_de_parcial`, `excedente_de_parcial`, `monto_no_cuadra`) | Elige el cobro o pasa a la escuela | — (NO VERIFICADO) | `whatsapp-cobro-por-texto.service.ts:51-57` | whatsapp-cobro-por-texto, whatsapp-bandeja-dinero-2026-10-13 |
| G36 | Recordatorios de cobro y mora | JOB L–V 8:00 COT (A); escalera −3 / −1 / 0 / +3 / +10 / +20; **solo con opt-in**, 1 contacto por familia y día; sin opt-in va por correo | Plantillas `pago_recordatorio_previo_v3`, `pago_vence_manana`, `pago_vence_hoy_v4`, `pago_pendiente_suave`, `pago_pendiente_directo`, `pago_aviso_final` | `cobro_<concepto>` | `recordatorios-cobro.service.ts:42-60, 186-270, 410-415`; `whatsapp-plantillas.service.ts:47-52, 101-128` | recordatorios-cobro.service, whatsapp-plantillas.service |
| G37 | Estado de cuenta mensual | JOB L–V 8–12 COT (A) | Correo o WhatsApp, 1 por familia y mes | NO VERIFICADO | `maintenance.job.ts:420-427` (A) | estado-de-cuenta.service (fuera del patrón del bot) |
| G38 | Plazos / acuerdo de pago | REGLA (`atenderPlanYPlazos` BOT:714) + confirmación; cada paso vence a los 30 min (`whatsapp-plan-comun.ts:21`) | **Crea el acuerdo**: queda `activo` si entra en lo que la escuela aprueba directo («Quedó activo tu pago por plazos»), si no queda como solicitud | `plazos_cobros`, `plazos_cuotas`, `plazos_confirmar`, `plazos_creado`, `plazos_solicitado`, `plazos_sin_cobros`, `plazos_cambio`, `plazos_calendario_invalido`, `plazos_vencida`, `plazos_cancelado`, `plazos_no_entendido` | `whatsapp-plazos.ts:197-312, 370-384` | whatsapp-plan-y-plazos (661 líneas) |
| G39 | Recordatorio de cuota del acuerdo | JOB cada hora + 06:30 UTC (A) | Aviso de la cuota | NO VERIFICADO | `maintenance.job.ts:729-747` (A) | acuerdos-de-pago-recordatorios.job |
| G40 | Pausa del plan | REGLA + confirmación | **La pausa queda `approved` sola si está dentro del tope de la escuela** («quedó aprobada… esos meses no generan cobro»); si no, en revisión | `plan_tipo`, `plan_inscripcion`, `plan_meses`, `plan_fecha`, `plan_confirmar`, `plan_pausa_aprobada`, `plan_pausa_pendiente` | `whatsapp-plan-pausa-retiro.ts:193-253, 326, 495-510` | whatsapp-plan-y-plazos |
| G41 | Retiro y reactivación por el flujo del plan | REGLA + confirmación | Deja la **solicitud** («no se cancela nada hasta que la aprueben») | `plan_retiro_solicitado`, `plan_reactivacion_solicitada`, `plan_cambio`, `plan_vencida`, `plan_cancelado`, `plan_no_entendido` | `whatsapp-plan-pausa-retiro.ts:371-418, 513-515` | whatsapp-plan-y-plazos, retiro-y-pausa.routes |
| G42 | Mis solicitudes / cancelar una solicitud | REGLA | Lista y cancela solicitudes abiertas | `plan_mis_solicitudes`, `plan_sin_solicitudes`, `plan_sin_abiertas`, `plan_cancelar_elegir`, `plan_cancelar_confirmar`, `plan_cancelada` | `whatsapp-plan-pausa-retiro.ts:79, 297-318, 475` | whatsapp-plan-y-plazos |
| G43 | Retiro dicho en texto libre («ya no va a seguir», «no me cobren más») | REGLA `esSolicitudDeRetiro` (`RETIRO`, `RETIRO_NO_ES`, `whatsapp-escalaciones.service.ts:107-129`) | **Escala** con prioridad (push inmediato, tema `retiro`) | `escalated` (reason `solicitud_de_retiro`) | BOT:781-782, 7876-7878 | whatsapp-dynasty-2026-10-08, whatsapp-plan-y-plazos |
| G44 | Aviso de ausencia | REGLA (`whatsapp-ausencias.service.ts`) + **2.º lector LLM** `clasificarMensajeFamilia` (Gemini «Decisions», 4 s, solo si hay llave) | Registra en `athlete_absence_notices`; pregunta de quién; ausencia larga o evento → escala | `ausencia_quien`, `ausencia_registrada`; reason `ausencia_larga_o_evento` | `whatsapp-ausencias.service.ts:32, 358, 452-457, 535-569`; BOT:792-806 | whatsapp-ausencias, whatsapp-bot-auditoria-turno |
| G45 | Incidencia urgente (clase, lesión, seguridad) | REGLA `incidenciaUrgente` (`INCIDENCIA_CLASE`, `LESION`, `SEGURIDAD`, `URGENTE_DECLARADO`, `whatsapp-escalaciones.service.ts:56-93`) | Escala urgente; lesión/seguridad añade «llama al 123» | `escalated` (reason `incidencia_urgente:<categoría>`, `plazo_min` 10) | BOT:820-825, 928-929, 2155, 8009-8014 | whatsapp-auditoria-2026-10-07 (un archivo) |
| G46 | Identificación por teléfono | REGLA: RPC `wa_identify_by_phone` | Vincula la conversación al acudiente **sin OTP** si el número coincide con la ficha | — (silencioso); `identificacion_ambigua` | BOT:576-588, 2204-2400 | whatsapp-auditoria-2026-11-16-bot, whatsapp-personal-escuela, whatsapp-bot-intrusion-2026-11-17 |
| G47 | El número ahora apunta a otro acudiente (número reciclado) | REGLA `revisarVinculoPorTelefono` | **Revincula solo** y avisa «este número quedó asociado a tu cuenta»; con revinculación pendiente pide código | `revinculado_por_telefono`, `revinculacion_codigo_enviado`, `revinculacion_codigo_vigente` | BOT:605-608, 1704-1757, 2091-2112; `wa-revinculacion.service.ts:23-102` | wa-revinculacion.service (unitaria del servicio; la rama `revinculado_por_telefono` del bot sin mención) |
| G48 | Vincular por correo (OTP) | REGLA `EMAIL_RE` / `CODE_RE` (BOT:2402-2403); OTP 10 min (BOT:194) | Manda código al correo; verifica; correo no encontrado → buzón | `otp_sent`, `otp_verificado`, `otp_failed`, `correo_no_encontrado` | BOT:4069-4196, 4694-4705 | whatsapp-atencion-bot, whatsapp-auditoria-2026-11-16-reglas, whatsapp-clase-cortesia-bot |
| G49 | «Debes registrarte» (familia sin cuenta, con o sin invitación vigente) | REGLA | Enlace de registro o de la invitación; atleta inactivo → buzón | `debe_registrarse` (+`con_invitacion`, `atleta_inactivo`) | BOT:2341-2389; `whatsapp-invitacion-vigente.service.ts` | whatsapp-invitacion-vigente.service, whatsapp-bot-consentimiento-boton-2026-11-18, whatsapp-metricas |
| G50 | Familia sin cuenta pregunta otra cosa | REGLA `trataDeLaCuenta` (RT:483-488) | «Ya le pasé tu mensaje/pregunta a la escuela» + buzón | `pregunta_a_la_escuela` | BOT:2118, 2133-2195 | whatsapp-auditoria-2026-11-16-bot, whatsapp-embudo-por-escuela |
| G51 | Disputa de pago de un desconocido | REGLA `atenderDisputaDePago` | Texto fijo + buzón | `disputa_de_pago` | BOT:4242-4271, 4600 | whatsapp-casos-reales-monster-11-05, whatsapp-consent-novedades-bot |
| G52 | Soportes y documentos del deportista (foto del documento, EPS, firma…) | WEBHOOK (adjunto, antes de la cola) + BOTÓN `sm_sp_soporte`, `sm_sp_pago`, `sm_sp_o_*`, `sm_sp_si`, `sm_sp_otro`, `sm_sp_no` | Guarda el documento en la ficha; aclara si era pago o soporte; recordatorio | `soporte_aclarar`, `soporte_deportista`, `soporte_tipo`, `soporte_confirmar`, `soporte_guardado`, `soporte_cancelado`, `soportes_recordatorio` | `whatsapp-soportes-bot.ts:38-52, 108-114, 678-689`; WH:576 (A) | whatsapp-soportes-bot, soportes-recordatorios.job |
| G53 | Horario de hoy / «¿hay clase hoy?» | REGLA `preguntaHorarioDeHoy` (`DE_HORARIO`, `HOY`, `COMO_PREGUNTA`, `whatsapp-desconocido-reglas.ts:141-151`) | Horario del día; cambio o cierre → buzón | `horarios_de_hoy` (+`al_buzon`) | BOT:879, 4348-4377 | whatsapp-dynasty-2026-10-08, whatsapp-dynasty-2026-10-20, whatsapp-modo-discreto |
| G54 | Ayuda de la app (cómo pagar en la app, etc.) | REGLA (`whatsapp-ayuda-app.service.ts`) + ajuste de la escuela | Texto fijo | `ayuda_app` | BOT:885, 1982-1989 | whatsapp-ajustes-por-escuela, whatsapp-ajustes-por-escuela-bot |
| G55 | Dejar un mensaje a una persona del equipo («profe Juan…») | REGLA `pideALaPersona` tipo `vocativo` (RT:253-325) | «Dejo tu mensaje para …» + buzón | `mensaje_para_persona` | BOT:836-837, 1074-1101 | whatsapp-bot-dynasty-2026-10-06, whatsapp-dynasty-2026-10-08 |
| G56 | Menú de la familia (botones) | BOTÓN `sm_ver_pagos`, `sm_como_pagar`, `sm_hablar_escuela`, `sm_horarios` (o su título escrito) | Ejecuta la acción sin modelo | `get_payment_status`, `get_payment_methods`, `get_school_info` (con `via: 'boton'`) | BOT:729-731, 1379-1388, 1441-1495 | whatsapp-botones, whatsapp-bot-memoria-botones |
| G57 | Respuesta del equipo desde la app / plantilla manual al hilo | RUTA `POST /conversaciones/:id/responder`, plantilla al hilo (A) | Envía como la escuela; cupo por usuario | — | BOT:8824; `whatsapp-plantilla-manual.service.ts:157, 223` | whatsapp-admin.buzon, whatsapp-buzon.routes, whatsapp-buzon-fase1 |
| G58 | Avisos operativos a la escuela (comprobantes por validar, resumen diario) | JOB cada 5 min; 07:00 COT (A) | In-app + push + correo (no es mensaje al cliente) | — | `maintenance.job.ts:650-659, 852-861` (A); `jobs/whatsapp-resumen-diario.job.ts` | whatsapp-resumen-diario.cortesias, avisos-correo.service |

## C · 4. MARKETING

| # | Flujo | Disparo | Respuesta / efecto | step | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| M1 | Motor de campañas | JOB cada 10 min (`MINUTOS_POR_TICK` `whatsapp-campanas.service.ts:325`) | Plantilla de marketing, 1 por persona, lease por envío, máx. 3 intentos | `campana` | `whatsapp-campanas.service.ts:371, 414, 643` | whatsapp-campanas.service (972 líneas) |
| M2 | Audiencias | Reglas `clasificarConversacion` (versión 1); antigüedad máx. 90 días | Clasifica conversaciones por interés y sede; excluye familia, staff, marcas manuales y bajas | — | `whatsapp-audiencias.service.ts:40-114, 274`; `whatsapp-campanas.service.ts:83, 982-1049` | whatsapp-audiencias.service, whatsapp-campanas.routes |
| M3 | Plantilla de campaña válida | REGLA `validarPlantillaDeCampana` (exige los botones rápidos, incluido «No recibir más») | Rechaza plantillas sin botón de baja | — | `whatsapp-campanas.service.ts:191-254` | whatsapp-campanas.service, whatsapp-admin.plantillas-campana |
| M4 | Crear / simular / aprobar / pausar / reanudar campaña | RUTA (escuela) | Estados en tablas de campañas; activar exige aceptar una declaración | — | `whatsapp-campanas.service.ts:1090-1304, 1383-1397`; `routes/whatsapp-campanas.routes.ts:62-267` (A) | whatsapp-campanas.routes, whatsapp-campanas.service |
| M5 | Botón «Sí» de la campaña | BOTÓN `smc:<campaña>:si`; se atiende ANTES de `debeAtender` (WH:666-673, A) | Lleva al servicio o al embudo | `campana_respuesta_si` | `whatsapp-campana-respuesta.service.ts:55, 71, 210` | whatsapp-campana-respuesta.service, whatsapp-campana-webhook, whatsapp-venta-servicio-ruteo |
| M6 | Botón «Luego» | BOTÓN `smc:<campaña>:luego` | Acuse fijo | `campana_respuesta_luego` | `whatsapp-campana-respuesta.service.ts:56` | whatsapp-campana-respuesta.service; mención en whatsapp-embudo-por-escuela |
| M7 | Botón «No recibir más» (baja de promociones) | BOTÓN `smc:<campaña>:baja` | `promos_out_at` (baja SOLO de promociones); confirma | `opt_out_confirmado` | `whatsapp-campana-respuesta.service.ts:57`; `whatsapp-optin.service.ts:60-96` | whatsapp-optin.service, whatsapp-campana-webhook, whatsapp-campana-respuesta.service |
| M8 | «No me interesa» escrito tras una campaña | REGLA `NO_INTERESA` (hasta 8 palabras, 72 h después de la plantilla) | «Entendido, no te escribiremos más sobre esto» | `campana_no_interesa` | `whatsapp-campana-respuesta.service.ts:51, 60-63, 81-98, 386` | whatsapp-campana-respuesta.service |
| M9 | Baja total (STOP) | REGLA en la RPC de ingesta `wa_ingest_inbound_message`: mensaje COMPLETO normalizado ∈ lista | `opted_out_at`; el bot confirma; si llega <60 s después de un «sí», repregunta con botones `sm_baja_si` / `sm_baja_no` | `opt_out_confirmado`, `confirmar_baja`, `baja_mantenida` | migración `20260909222343…sql:275`; BOT:439-440, 1347-1366, 1390-1393, 6018-6025 | whatsapp-bot-dynasty-2026-10-06, whatsapp-auditoria-2026-11-16-reglas |
| M10 | Reactivar («ACTIVAR») | REGLA `REACTIVAR` | Levanta la baja total y la de promociones | `opt_in_reactivado`, `promos_reactivadas` | BOT:449-450, 4538-4539, 5948, 6002-6035, 6244-6275 | whatsapp-auditoria-2026-11-16-bot (un archivo) |
| M11 | Consentimiento de avisos de la familia | Pregunta al pie de una respuesta (máx. 3 veces, cada 14 días: BOT:6361-6362); BOTÓN `sm_consentir_si` / `sm_consentir_no` o texto de `AFIRMATIVAS` / `NEGATIVAS` | Registra opt-in (RPC `wa_register_optin`) | `ask_consent`, `opt_in_registrado`, `opt_in_ya_activo`, `consent_rechazado` | BOT:468-469, 5943-5947, 5980-6124, 6137-6224 | whatsapp-bot-consentimiento-boton-2026-11-18, whatsapp-bot-memoria-botones, whatsapp-queue-una-respuesta |
| M12 | Consentimiento sin cuenta | BOTÓN o «sí acepto» de un número sin ficha | Texto fijo (no registra a quien no tiene cuenta — NO VERIFICADO) | `consentimiento_sin_cuenta` | BOT:4443-4459, 4631-4634, 6110 | whatsapp-auditoria-2026-10-10-bot (un archivo) |
| M13 | «ACTIVAR AVISOS» del enlace público | REGLA `esActivacionDeAvisos` | Opt-in directo desde el enlace de la app | `opt_in_registrado` (`via: 'enlace_activar'`) | BOT:540-541, 6327-6350; `whatsapp-activar-avisos.ts` | whatsapp-activar-avisos |
| M14 | Consentimiento de novedades (prospectos) | Post-turno `ofrecerConsentNovedadesTrasTurno`; BOTÓN o `SI_ESCRITO` / `NO_ESCRITO` | Guarda si quiere novedades; se pregunta una sola vez (10 años, BOT:3675) | `consentimiento_novedades` | BOT:3684-3780; `whatsapp-consentimiento-seguimiento.ts:66-134` | whatsapp-consent-novedades-bot |
| M15 | Freno por calidad | REGLA en el motor: bajas ≥5 % (mínimo 5 bajas; muestra plena 100), fallos ≥20 %, muestra mínima 20, calidad del número | Pausa las campañas de la escuela y avisa a administración | — | `whatsapp-campanas-freno.ts:35-59, 130, 186-251`; `whatsapp-campanas.service.ts:516-551` | whatsapp-campanas-freno |
| M16 | Tope diario y cupo de Meta | REGLA: límite del tier (250 por defecto), reserva para avisos (30 o 20 %), cupo por tick | Pospone envíos | — | `whatsapp-campanas-cupo.ts:51-55, 63-126, 225-274`; `whatsapp-campanas.service.ts:332-347, 424` | whatsapp-campanas.service (el archivo `-cupo` no tiene prueba propia) |
| M17 | Tope de Meta 131049 y reintentos | REGLA `destinoTrasErrorDeEnvio`, `destinoTrasFalloAsincrono` | Reprograma o da por fallido | — | `whatsapp-campanas.service.ts:371-404`; `whatsapp-errores-meta.ts` | whatsapp-errores-meta, whatsapp-campanas.service |
| M18 | Freno global y pausa por escuela (super admin) | RUTA `/api/v1/admin/whatsapp-plataforma` | Pausa todas las campañas o las de una escuela | — | `whatsapp-campanas.service.ts:1332-1370`; `routes/admin-whatsapp-plataforma.routes.ts:39-126` (A) | whatsapp-campanas.routes (mención). **La ruta de admin SIN PRUEBA propia** |
| M19 | Reporte de campaña y aviso a soporte | RUTA + cálculo | Enviados, respondieron, pagaron, no enviados, fallidos, freno | — | `whatsapp-campana-reporte.service.ts:273-621` | whatsapp-campana-reporte.service, whatsapp-campanas.reporte.routes |
| M20 | Plantillas: catálogo, sincronización y envío con rastro | JOB cada 30 min (`jobs/whatsapp-plantillas-sync.job.ts`); webhook `message_template_status_update` | Estado por WABA; motivos de no envío `sin_optin`, `plantilla_no_aprobada`, `plantilla_recategorizada`, `fuera_de_horario`, `variables_no_coinciden`… | `cobro_<concepto>` | `whatsapp-plantillas.service.ts:47-62, 208-219, 479` | whatsapp-plantillas.service, whatsapp-plantillas-clase-prueba |
| M21 | Atribución por anuncio (referral de Meta) | WEBHOOK: `referral` con `ctwa_clid` y `source_id` | Guarda el origen; alimenta V22 y el embudo por anuncio | — | `whatsapp-anuncio-destino.ts:81`; `whatsapp-anuncios.service.ts:182-318`; `routes/whatsapp-anuncios.routes.ts:46-113` (A) | whatsapp-anuncios.service, whatsapp-anuncios.routes |
| M22 | Atribución por texto (sin referral) | REGLA `buscarRegla`: frases que la escuela configura; corre en segundo plano en cada entrante (WH:489, A) | Atribuye a una etiqueta | — | `whatsapp-atribucion-texto.ts:39-160` | whatsapp-atribucion-texto |
| M23 | Campaña manual por script (Black Friday a escuelas) | SCRIPT `scripts/wa-campana.ts`, `wa-audiencia.ts`, `wa-enviar-mensajes.ts`; `scripts/campana-bf-escuelas.ts` | Envío fuera del motor — si respeta freno y topes: NO VERIFICADO | — | `bff/scripts/` | SIN PRUEBA (scripts). `campana-bf-escuelas.ts` **SIN DESPLEGAR** (sin commit) |

### Palabras de alta y baja que reconoce (comparación contra el mensaje COMPLETO normalizado, nunca por subcadena)

| Qué | Lista exacta | Dónde |
|---|---|---|
| Baja total (ingesta, SQL) | `stop`, `baja`, `cancelar suscripcion`, `desuscribir`, `no molestar`, `salir` | `supabase/migrations/20260909222343_whatsapp_optin_baja_sin_consentimiento.sql:275` (última definición viva: NO VERIFICADA contra la base) |
| Reactivar | `activar`, `reactivar`, `si activar` | BOT:5948 |
| Sí al consentimiento | `si`, `si acepto`, `acepto`, `si quiero`, `quiero`, `claro`, `claro que si`, `dale`, `de acuerdo`, `activar`, `si por favor`, `si gracias`, `si claro` | BOT:5943-5946 |
| No al consentimiento | `no`, `no gracias`, `no quiero`, `ahora no`, `prefiero que no` | BOT:5947 |
| Confirmar la baja tras STOP | Sí: `si darme de baja`, `darme de baja`, `si`, `si quiero` · No: `no mantenerlos`, `mantenerlos`, `no`, `no gracias`, `no quiero` | BOT:5952-5953 |
| «No me interesa» tras campaña | `no (me\|nos) interesa`, `no (estoy\|estamos) interesad@`, `no me escriban/manden/envien`, `no (quiero\|queremos) (recibir\|mas\|que me escriban)`, `dejen de (escribir\|enviar\|mandar)`, `^no mas`, `^no,? gracias$` | `whatsapp-campana-respuesta.service.ts:81-89` |
| Novedades (prospecto) | Sí: `si`, `si cuentenme`, `si cuenteme`, `si claro`, `si por favor`, `si gracias`, `si quiero`, `claro`, `claro que si` · No: `no`, `no gracias`, `no quiero`, `prefiero que no` | `whatsapp-consentimiento-seguimiento.ts:133-134` |

**No reconoce como baja** (no están en ninguna lista): «cancelar», «no más mensajes», «eliminar», «quitar», «darme de baja» suelto (solo vale como respuesta a la repregunta), «unsubscribe», «parar», «no me escriban» fuera de las 72 h de una campaña.

## C · 5. INFORMATIVO

| # | Flujo | Disparo | Respuesta / efecto | step | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| I1 | Información de la escuela (sedes, deportes, grupos, horarios, atención) | **LLM** tool `get_school_info` + redacción; BOTÓN `sm_horarios` (sin modelo) | Datos de `infoDeEscuela`; lo que falta va en `no_disponible`; respaldo `fallbackInfoEscuela` | `get_school_info`, `info_escuela_fallback` | BOT:1461-1466, 6897-6933; `whatsapp-info-escuela.service.ts:436` | whatsapp-info-escuela, whatsapp-atencion-bot, whatsapp-auditoria-2026-10-07 y 18 más |
| I2 | Texto libre del modelo (sin herramienta) | **LLM** Sonnet (cadena Claude → Gemini → Groq) | Pasa por `entregarTextoDelModelo`: filtro de fugas, promesas de seguimiento, enlaces no permitidos, `afirmaDineroSinRespaldo`; bloqueado → escala `salida_del_modelo_bloqueada` | `llm_text` | BOT:6690-6780, 6833-6844 | whatsapp-reglas-turno, whatsapp-bot-auditoria-turno, whatsapp-bot-intrusion-2026-11-17, whatsapp-vigilante.service y 4 más |
| I3 | Precios | REGLA con `wa_responder_precios`; valores del catálogo (`textoDePreciosDeEscuela`); en prospecto con ficha puede redactar la IA (V40) | Texto fijo con precios; los precios de la familia ya inscrita NO salen de `get_school_info` («precios de mensualidad, inscripción y uniforme» está en `no_disponible`) | `desconocido_tema_escolar` (`intencion: 'precios'`), `prospecto_seguimiento_precios` | BOT:4759-4783, 5198-5225; `whatsapp-precios.service.ts`; `whatsapp-precios-escuela.service.ts` | whatsapp-precios-escuela.service, whatsapp-precios-valores-fijos, whatsapp-precio-antes, whatsapp-ajustes-por-escuela |
| I4 | Nota de voz de una familia | REGLA: la escuela activó transcripción y hay consentimiento → **LLM** Whisper (Groq → OpenAI); el texto entra al turno normal | Sin consentimiento: lo pide (`ask_consent`, `por_audio`); no activo: «no puedo escuchar audios» 1 vez / 24 h | `ask_consent`, `tipo_no_soportado_audio` | `whatsapp-notas-de-voz.service.ts:46-68, 90-105, 186-239`; WH:779-789 (A) | whatsapp-notas-de-voz, whatsapp-audio-pregunta-de-dinero |
| I5 | Nota de voz de un prospecto | REGLA + Whisper | Audio largo (>120 s, RT:802), no entendido, no transcrito → pide escribir o abre buzón | `audio_largo`, `audio_no_entendido`, `audio_no_entendido_buzon`, `audio_no_transcrito` | `whatsapp-notas-de-voz.service.ts:274-354` | whatsapp-notas-de-voz |
| I6 | Tipo de mensaje no soportado (contacto, pedido, etc.) | REGLA; 1 vez / 24 h (`reservarPasoUnaVez`); `revoke` y `edit` se ignoran | «¿Me lo escribes?» + buzón | `tipo_no_soportado_unsupported` | WH:605-627; RT:726, 784 | whatsapp-tipo-no-soportado (un archivo) |
| I7 | Adjunto en formato no admitido (ni jpeg/png/webp/pdf) | REGLA de mime, solo si `debeAtender` | Aviso fijo | `adjunto_formato_no_soportado` | WH:589-596 (A) | whatsapp-conversacion-v2 (mención) |
| I8 | Video | REGLA: solo si el texto cercano (15 min, RT:728) habla de pago; 1 / 24 h | «Mándame una foto o PDF» | `tipo_no_soportado_video` | WH:799-816 | whatsapp-tipo-no-soportado, whatsapp-auditoria-2026-11-16-reglas |
| I9 | Sticker, ubicación, plantilla, sistema, reacción | REGLA | Se guarda y el bot no responde; la reacción ni se guarda | — | WH:645-650 (A); `whatsapp.service.ts:833` (A) | NO VERIFICADO |
| I10 | Horario de atención | REGLA `estadoDeHorario` | Solo cambia lo que el bot PROMETE al escalar («te responden mañana a las…»); el bot contesta 24/7 | `escalated` (`fuera_de_horario`) | `whatsapp-horario.service.ts:63-99`; BOT:7959-7977 | whatsapp-ajustes-escuela.service y 26 más (mención) |
| I11 | «Eso no lo tengo a la mano» / «eso te lo confirma la escuela» | Regla del prompt (BOT:6482) + REGLA `respondioQueNoLoTiene` (BOT:1504) que añade botones; en prospecto y servicio: instrucción del prompt y `NO_SE` | Botones del menú; en retomas: «Lo demás te lo confirma la escuela por aquí; ya les volví a avisar» (BOT:8349) | el del turno | BOT:1504-1505, 7730-7734; `whatsapp-prospecto-ia.service.ts:203`; `whatsapp-servicio-ia.ts:99` | whatsapp-bot-memoria-botones, whatsapp-servicio-ia |
| I12 | Respuesta sin modelo (todos los proveedores caídos) | REGLA `rutaSinModelo` (RT:522) | Medios de pago, estado de pagos o un menú; no escala | `medios_fallback`, `payment_fallback`, `llm_error_menu` | BOT:1306-1336, 6821-6829 (A) | whatsapp-reglas-turno, whatsapp-bot-dynasty-2026-10-06 |
| I13 | Ficha libre de la escuela y su coherencia con el catálogo | Texto que escribe la escuela (`wa_ficha_prospectos`, máx. 6000); verificador de montos; ruta `GET /coherencia-ficha` | Alimenta V40 y V27; aviso a la escuela si la ficha contradice el catálogo | — | `whatsapp-coherencia-ficha.ts:116`; `whatsapp-verificador-montos.ts:437` (A); `routes/whatsapp-coherencia.routes.ts:56` (A) | whatsapp-coherencia-ficha, whatsapp-coherencia.routes, whatsapp-verificador-montos |

«Qué llevar», uniforme, requisitos: no hay regla fija; solo lo contesta la IA de prospecto si está en la ficha libre (V40) o la IA de servicio si está en la ficha del servicio (V27). Para una familia ya inscrita cae en I1/I2 y normalmente termina en «no lo tengo a la mano».

## C · 6. TRANSVERSAL

### 6.1 Escalamiento a una persona

`escalate` BOT:7849-7985. Qué hace siempre: conversación a `open`; push + correo solo en la TRANSICIÓN a abierta (`avisarQueEsperan`); in-app siempre y push inmediato si es urgente o retiro (`avisarEscalacionAlEquipo`, `whatsapp-escalaciones.service.ts:353`); una sola escalación abierta por conversación (`decidirEscalacion`, `:195`). Destinatarios: `destinatariosDeLaEscuela` (`:268`) — owner y admins de la escuela (detalle NO VERIFICADO). Canales: in-app, push, correo (freno 6 h, `VENTANA_REVISION_HORAS` `:43`) y, si la escuela se suscribió, el número de plataforma (T24).

| Motivo (`reason`) | Quién lo decide | Línea |
|---|---|---|
| `incidencia_urgente:<clase\|lesion\|seguridad>` | REGLA | BOT:822, 929, 2155 |
| `solicitud_de_retiro` | REGLA | BOT:782 |
| `pidio_una_persona` | REGLA `pideALaPersona` | BOT:833, 2160 |
| `boton_hablar_con_la_escuela` | BOTÓN `sm_hablar_escuela` | BOT:1458 |
| `cortesia_pide_una_persona` | REGLA `quiereSalirDelFlujo` | BOT:694, 6865 |
| `prospecto_seguimiento_persona` | REGLA | BOT:5290, 5543 |
| `queja_de_la_familia` | REGLA `esQuejaContraLaEscuela` (RT:1103) | BOT:6804 |
| `ausencia_larga_o_evento` | REGLA (+ 2.º lector LLM) | BOT:806 |
| `atencion_presencial` | REGLA | BOT:4340 |
| `revisar_plan_y_pagos: …` | REGLA (cobro que no cuadra) | BOT:1221 |
| reclamo de valor | REGLA | BOT:2019 |
| `plan_<tipo>_error:…`, `plazos_error:…` | REGLA (falló crear) | `whatsapp-plan-pausa-retiro.ts:497-499`; `whatsapp-plazos.ts:370` |
| `tool_error`, `unknown_tool` | Falla técnica | BOT:1270, 1488, 6892, 6984, 7034 |
| `salida_del_modelo_bloqueada`, `el_asistente_pidio_una_persona` | Guarda de salida | BOT:6761-6775 |
| texto libre del modelo (`escalate_to_human`) | **LLM**; se corta a 120 caracteres y NO decide urgencia ni retiro | BOT:6854-6858, 6683-6688, 7880-7884 |

Además `abrirEnBuzon` (BOT:4027) abre la conversación SIN mensaje de escalación, con motivo `prospecto`, `puerta_club` o `puerta_otro` (unas 17 y 12 llamadas en BOT).

| # | Flujo | Disparo | Respuesta / efecto | step | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| T1 | Escalar | Ver tabla de motivos | «Voy a pasar tu caso…» según horario; urgente: «Ya le avisé a la escuela como urgente» (+123); retiro: mensaje propio; modo discreto: «Le aviso a la escuela para que te escriba por aquí» | `escalated` (+`reason`, `urgencia`, `categoria`, `tema`, `plazo_min`, `fuera_de_horario`), `escalacion_abierta_detalle` | BOT:7849-7985, 8006-8014 | 46 archivos mencionan `escalated`; núcleo: whatsapp-conversacion-v2, whatsapp-auditoria-2026-10-07, whatsapp-reglas-turno |
| T2 | Plazo de la escalación: 10 min urgente / 30 min normal (variables `WHATSAPP_PLAZO_URGENTE_MIN`, `WHATSAPP_PLAZO_NORMAL_MIN`) | Lo dispara **el webhook** (máx. 1 vez/min), no un cron: sin tráfico entrante no corre | Re-aviso al equipo + 1 mensaje honesto a la familia | `escalacion_sin_respuesta` | BOT:8026-8125; `whatsapp-escalaciones.service.ts:37-40, 230-246`; WH:90-110 (A) | whatsapp-conversacion-v2, whatsapp-vigilante.service |
| T3 | SLA en horas hábiles (pasos `escalated`, `identificacion_ambigua`, `puerta_club_recibido`, `puerta_otro_tema`; ventana 72 h) | Webhook | Push + in-app + correo a la escuela | marca `sla_at` en el payload | BOT:8133-8228; RT:1047-1071 | whatsapp-conversacion-v2 (un archivo) |
| T4 | Retoma: la escuela cedió y nadie contestó | Webhook cada 5 min; `decidirRetoma` (RT:640), ventana 6 h, re-aviso a los 60 min (RT:597-599) | Contesta lo que SÍ sabe (precio, dirección, horario, grupo, cómo pagar) o algo honesto 1 vez / 24 h; re-avisa a la escuela | `retoma_respuesta`, `retoma_sin_respuesta` | BOT:8233-8366, 8415-8587; RT:602-640 | whatsapp-retoma-y-pago-publico, whatsapp-auditoria-2026-10-07-pendientes, whatsapp-modo-discreto-bot |
| T5 | Silencio cuando la escuela escribe | REGLA `humanoReciente`: 15 min (`WHATSAPP_SILENCIO_HUMANO_MIN`, BOT:201); saludo suelto con humano en 3 h (BOT:203); no intervenir 120 min antes del modelo (RT:1089); excepción: pedido de un servicio del catálogo (BOT:485, 3126-3137) | Silencio; conversación abierta sin aviso | — (`silencio_*` en bitácora, NO VERIFICADO) | BOT:482-489, 513-516, 6796-6801 | whatsapp-reglas-turno, whatsapp-auditoria-2026-10-07-pendientes, whatsapp-bot.servicio-con-escuela |
| T6 | Conversación «tomada» por una persona | RUTA tomar/soltar; 12 h por defecto, 2 h al responder, máx. 72 h | El bot no envía ni deja borrador | — | `whatsapp-tomada.service.ts:33-35, 43-136`; BOT:418, 7175 (A) | whatsapp-tomada, whatsapp-tomada-bot, whatsapp-admin.tomar |
| T7 | Modo discreto | Ajuste; con la escuela activa 12 h (`HORAS_SILENCIO_FAMILIA`) el bot calla; **el modelo no corre nunca** (`restoDelTurnoDiscreto`) | Solo: urgencia, horario de hoy, cómo pagar, ayuda de app, ventas; solo escalan lo urgente y quien PIDIÓ persona (`ESCALA_EN_MODO_DISCRETO` o `wa_temas_a_persona`) | — | BOT:275-284, 664-672, 764-768, 912-946, 7885-7889, 7988-8003; `whatsapp-modo-discreto.ts:30-82` | whatsapp-modo-discreto, whatsapp-modo-discreto-bot |
| T8 | Aviso único de pendientes (modo discreto) | Revisión cada 10 min, ventana 72 h | Un aviso a la escuela con las conversaciones sin contestar | — | `whatsapp-modo-discreto.ts:106-117, 157-285` | whatsapp-modo-discreto, whatsapp-coexistence.historial |
| T9 | Silencio de diálogo (el equipo ya dialoga, 72 h) y entrantes «sin dueño» | Variable de entorno + REGLA; gracia 30 min | Silencio; lista para la escuela | — | `whatsapp-silencio-conversacion.ts:32-40, 100-235` | whatsapp-silencio-conversacion, whatsapp-auditoria-2026-11-16-reglas |
| T10 | Salvaguarda de silencio | Ajuste por escuela: si el turno terminó mudo o con error | Aviso a la escuela | — | `whatsapp-salvaguarda-silencio.ts:12-40`; WH:752-764 (A) | whatsapp-salvaguarda-silencio |
| T11 | Otra máquina (menú de otro negocio, auto-respuesta, bucle) | REGLA `esMenuDeOtroNegocio`, `esAutoRespuesta`, `esBucleDeOtraMaquina` (3 repeticiones en 10 min, ≥25 caracteres) | Silencio | — | RT:405-470; BOT:457, 522, 4487-4492 (A) | whatsapp-reglas-turno, whatsapp-auditoria-2026-11-16-reglas |
| T12 | Antirrepetición del bot | REGLA en `deliver`: mismo texto en 30 min; mismo último saliente en 2 min; máx. 3 emojis; quita promesas de seguimiento | No envía el duplicado | — | RT:865-1000, 1126; BOT:7226-7262 (A), 7424 | whatsapp-conversacion-v2, whatsapp-auditoria-2026-11-16-reglas, whatsapp-reglas-turno-intrusion |
| T13 | Ráfaga y candado del turno | Espera 10 s, «último gana», lease 90 s; turnos perdidos se relanzan (JOB cada minuto) | Un turno por ráfaga | — | `whatsapp-turno-agrupado.service.ts:47-146`; `whatsapp-turnos-pendientes.service.ts`; BOT:977-984 | whatsapp-turnos-pendientes, whatsapp-bot-dynasty-2026-10-06, whatsapp-bot-intrusion-2026-11-17 |
| T14 | Cierre suelto («gracias», «ok») | REGLA `esCierreSuelto` (RT:365-382), `esCierreDeCortesia` | Silencio | — | BOT:772, 925, 4725-4733 | whatsapp-reglas-turno, whatsapp-dynasty-2026-10-08 |
| T15 | Solo adjunto sin texto (sticker, ubicación) | REGLA `esSoloAdjunto`, 3 min | Silencio | — | RT:568-577 | whatsapp-auditoria-2026-10-07-pendientes |
| T16 | ¿Se atiende este contacto? | REGLA `debeAtender`: bot encendido, tipo de contacto, tomada; marcas `personal`, `negocio`, `otro_club`, `plataforma`, `equipo` nunca; `personal` = solo metadatos | Silencio para staff y marcas | — | ATN:95-255; `whatsapp-tipo-contacto.ts:25-95` | whatsapp-atencion-bot, whatsapp-atencion-marcas, whatsapp-tipo-contacto, whatsapp-admin.tipo-contacto |
| T17 | Se identifica como externo (otro club, proveedor) | REGLA `seIdentificaComoExterno` (`EXTERNO`, `ES_FAMILIA`) | Buzón en silencio | — | `whatsapp-desconocido-reglas.ts:93-132`; BOT:4715-4717 | whatsapp-dynasty-2026-10-08 |
| T18 | Número bloqueado | RPC `wa_is_blocked` en el webhook | No se procesa | — | WH:436-443 (A) | **SIN PRUEBA** |
| T19 | Modo asistido (borradores) | Ajuste de la conversación | El bot deja un borrador que la escuela aprueba o descarta; los borradores >24 h vencen; **un Flow no deja borrador** | `tool_context.step` | BOT:5864, 7356-7398 (A); `routes/whatsapp-admin.routes.ts:1731, 1821` (A) | whatsapp-admin.buzon, whatsapp-mantenimiento.job y 30 más (mención) |
| T20 | Mantenimiento del buzón | JOB cada 15 min: 48 h sin actividad → `closed`; borradores >24 h → `expired` | — | — | `jobs/whatsapp-mantenimiento.job.ts` | whatsapp-mantenimiento.job |
| T21 | Coexistence (la escuela escribe desde su celular) | WEBHOOK de echos e historial | Guarda lo que escribió la escuela: de ahí salen T5, T7 y T9 | — | `whatsapp-coexistence.service.ts`; WH:178-189 (A) | whatsapp-coexistence.echos, whatsapp-coexistence.historial, whatsapp-onboarding.historial |
| T22 | Presentación del asistente (1.ª respuesta en 24 h) | REGLA | Antepone «Soy el asistente de …» | — | BOT:7470-7660 | whatsapp-bienvenida, whatsapp-auditoria-2026-11-16-bot |
| T23 | Vigilante, resumen diario, resumen semanal, informe de calidad | JOB (lun–sáb 07:15–10:15; 07:00; lun 07:05; lun 08–11 h) | Correos a la escuela y a SportMaps: comprobantes sin desenlace, sin respuesta, repeticiones, **afirmaciones del modelo sin acción ejecutada** (`PASOS_SIN_GARANTIA`) | — | `whatsapp-vigilante.service.ts:360-390`; `jobs/whatsapp-resumen-diario.job.ts`; `jobs/bot-resumen-semanal.job.ts`; `informe-calidad-bot.service.ts` | whatsapp-vigilante.service (851 líneas), informe-calidad-bot.service, whatsapp-resumen-diario.cortesias |
| T24 | Oleada 1 (soportes + referidos; calla si el equipo ya dialoga) | REGLA | Enruta a G52 y V44 | — | `whatsapp-bot-oleada1.ts:65-95` | Indirecta: whatsapp-soportes-bot, whatsapp-referidos-bot |
| T25 | Simulador de turnos / modo pruebas | `simularEnvios` (BOT:362); testers del canal de plataforma | Corre el turno sin enviar | — | BOT:362-367; `plataforma-wa-pruebas.service.ts`; `plataforma-wa-pruebas-simular.service.ts` | plataforma-wa-pruebas, plataforma-wa-pruebas-simular, cortafuegos-simulacion |

### 6.2 Canal de plataforma (SportMaps hablando con dueños y con leads)

Número propio de SportMaps; se detecta antes de resolver la escuela (WH:419-426, A) y escribe en `platform_wa_mensajes`, nunca en tablas `whatsapp_*` de una escuela.

| # | Flujo | Disparo | Respuesta / efecto | paso | Evidencia | Pruebas |
|---|---|---|---|---|---|---|
| T26 | Suscripción del dueño a los avisos | REGLA `comandoDeSuscripcion`: «ACTIVAR», «ACTIVAR <código>», «DESACTIVAR», «AYUDA»; requiere `PLATFORM_WA_ENABLED` | Activa o desactiva; ayuda 1 vez / 24 h | `ayuda`, `desactivada` (resto NO VERIFICADO) | `plataforma-wa-entrante.service.ts:43-79, 110-177, 192, 267` | plataforma-wa-entrante, plataforma-wa-entrante-adjuntos |
| T27 | Avisos a dueños: comprobantes por validar, caso escalado, cortesía, resumen, cartera, pagos por validar | Eventos del sistema; respeta la franja de silencio de cada suscriptor (`debeSalir`) y la ventana de 24 h (plantilla si cerró) | Texto o plantilla + enlace a la app | — | `plataforma-wa-avisos.service.ts:75-261`; `plataforma-wa.service.ts:286-453` | plataforma-wa-avisos, plataforma-wa.service |
| T28 | Mapi de leads (un desconocido le escribe a SportMaps) | **LLM** Haiku (`PLATFORM_WA_LEADS_MAPI`); topes por hora y por día; `pidePersona`; verificación de montos contra la config comercial | Respuesta comercial; descartada o pide persona → escalación fija | `lead_mapi`, `lead_escalado`, `lead_pide_texto` | `plataforma-wa-leads.service.ts:94-97, 106-155, 191-342` | plataforma-wa-leads. Archivo con 2 líneas **SIN DESPLEGAR** |
| T29 | Respuesta comercial fija | `PLATFORM_WA_RESPUESTA_COMERCIAL=true`; 1 vez / 30 días | Texto fijo | `comercial` | `plataforma-wa-entrante.service.ts:172-173` | plataforma-wa-entrante |
| T30 | Administración del canal (conectar, interruptor, por escuela, plantillas, prueba) | RUTA super admin | — | — | `plataforma-wa-admin.service.ts:97-293`; `routes/admin-whatsapp-plataforma.routes.ts` (A) | plataforma-wa-admin.service |
| T31 | Opt-in de la dueña desde la app | RUTA `/:schoolId/avisos-sportmaps` | Alta, cambio y baja de la suscripción | — | `routes/whatsapp-plataforma.routes.ts:71-174` (A) | NO VERIFICADO |

### 6.3 Mapi / asistente para administradores

- **No existe un Mapi que atienda a administradores por WhatsApp.** Lo que hay por WhatsApp para dueños es T26–T27 (comandos fijos y avisos de una vía) y T28 (Mapi **de leads comerciales**, no de administradores).
- Mapi **dentro de la app**: `inapp-support-bot.service.ts:205` (LLM con tools), `mapi-contexto.service.ts`, `mapi-feedback.service.ts`. Pruebas: inapp-support-bot.service, inapp-support-bot.turno, mapi-contexto.service, mapi-feedback.service, seguridad-llm-mapi.poc. Fuera del alcance de WhatsApp.

## C · 7. Flujos sin prueba o con cobertura débil

**Sin ninguna mención en pruebas**
- G4 `confirmar_combinacion` — paso huérfano (COLA:4109, 5762).
- T18 bloqueo por número `wa_is_blocked` (WH:436-443).
- M23 scripts de campaña manual (`bff/scripts/wa-campana.ts`, `campana-bf-escuelas.ts`).

**El enganche en el bot no tiene prueba directa (solo la regla pura o una mención lateral)**
- V17 grupo por edad en el bot (BOT:706, 1895).
- V21 cupo separado → a la escuela (BOT:1915-1950).
- V19 «Llegué» (BOT:4641).
- G47 `revinculado_por_telefono` — el bot revincula solo y lo anuncia (BOT:1738-1757). **Delicado.**
- G30 reclamo de valor (BOT:2009-2019). **Delicado** (dinero).
- G45 incidencia urgente — un solo archivo (whatsapp-auditoria-2026-10-07). **Delicado** (lesión/seguridad).
- T3 SLA de escalaciones — un solo archivo.
- M10 reactivar «ACTIVAR» — un solo archivo.
- M12 consentimiento sin cuenta — un solo archivo.
- M18 freno global y pausa por escuela — la ruta de super admin no tiene prueba propia.
- M16 `whatsapp-campanas-cupo.ts` — sin archivo de prueba propio.
- G15 tope de comprobantes — solo unitaria del servicio, no su efecto en la cola.
- I7 formato de adjunto no admitido; I9 sticker/ubicación.

**Un solo archivo de prueba para un flujo grande**
- G26 factura electrónica (16 pasos) · G38–G42 plazos, pausa, retiro (un archivo de 661 líneas para ~30 pasos) · G23 «sigues en fila» · G29 reclamo del resultado · V36 comprobante de prospecto · V42 rescate por plantilla · V46 pagar mensualidad.

**Solo con pruebas SIN DESPLEGAR**: V30 (varios cupos, abonar, «soy afiliado») y los cupos llenos de V31.

## C · 8. Riesgos y sorpresas

1. **El bot sí dice «apliqué tu pago… queda al día» y «tu cupo está confirmado»**, no solo «recibido». Pasa cuando la escuela tiene `auto_approve_enabled` y el monto está bajo el tope (`receipt-approval.service.ts:199-219, 292-296`): COLA:856-858 («¡Listo! ✅ Apliqué tu pago a… Queda al día») y COLA:2182-2187 («Quedó registrado tu pago… Tu cupo está confirmado»). La regla de producto «recibido SIEMPRE, nunca aprobado» no se cumple en esas dos ramas. También hay rechazo automático con mensaje a la familia (COLA:859-862).
2. **La pausa del plan y el acuerdo de pago se conceden solos** dentro del tope de la escuela, sin que una persona los vea: `whatsapp-plan-pausa-retiro.ts:502-505` («quedó aprobada… esos meses no generan cobro») y `whatsapp-plazos.ts:375-379` («Quedó activo tu pago por plazos»). El retiro, en cambio, solo queda como solicitud (`:513`). Todo con un único archivo de prueba.
3. **La cola crea cobros en `payments` a partir de lo que leyó el OCR** (`wa-cobro-desde-comprobante.service.ts:675-733`, `crearCobroDeVenta` COLA:2432, `crearYAplicar` COLA:1563) y aplica comprobantes de números **sin ficha** al deportista que la persona nombró (`comprobantePorNombreSinVerificar` COLA:4909-4990, código `numero_sin_verificar`).
4. **Los plazos de escalación, el SLA y las retomas no son cron: los dispara el webhook** (WH:90-110; BOT:8026, 8138, 8499). En una escuela sin tráfico entrante, una urgencia sin responder no genera el re-aviso de 10 min hasta que llegue otro mensaje de cualquier contacto. El barrido alterno está apagado por defecto (`WA_BARRIDO_SIN_RESPUESTA`, parte A §2).
5. **Vínculo de cuenta por teléfono sin OTP, y revinculación automática**: `wa_identify_by_phone` vincula si el número coincide con la ficha (BOT:2204-2232) y, si el número pasa a resolver a otro acudiente, el bot reescribe el vínculo y lo anuncia (BOT:1745-1757, `revinculado_por_telefono`), sin prueba de esa rama. Con el vínculo se accede a saldo y enlaces de pago (G31).

Otros hallazgos menores:
- **Baja**: la lista de palabras es corta y exacta (`stop`, `baja`, `cancelar suscripcion`, `desuscribir`, `no molestar`, `salir`); «no más mensajes», «cancelar» o «no me escriban» fuera de las 72 h de una campaña no dan de baja y siguen al flujo normal (migración `…222343:275`; `whatsapp-campana-respuesta.service.ts:51, 81-89`).
- **SIN DESPLEGAR**: `diceSerAfiliado` contesta «Entonces aplica el valor de afiliados» con solo decirlo; la verificación queda para cuando la escuela valide el comprobante (`whatsapp-venta-servicio.ts`, working tree, `TEXTO_DICE_SER_AFILIADO`).
- **Modo discreto apaga el modelo por completo** (BOT:764-768): saldo, estado de cuenta e información de la escuela dejan de responderse; solo quedan las reglas de `restoDelTurnoDiscreto`.
- **Asistencia del staff corre con el bot apagado** (WH:658, A) y escribe asistencia desde una foto leída por OCR (COLA:3812-3849).
- **Campañas por script** (`bff/scripts/wa-campana.ts`, `campana-bf-escuelas.ts` sin commit): NO VERIFICADO que pasen por el freno de calidad y los topes del motor.
- `PASO_DESCONOCIDO_ESCOLAR = 'desconocido_tema_escolar'` está **definido cuatro veces** (BOT:4382, `whatsapp-metricas.ts:44`, `jobs/bot-resumen-semanal.job.ts:32`, `jobs/whatsapp-resumen-diario.job.ts:52`) y `PASO_VENTA_CERRADA` dos (BOT:3434, `whatsapp-campana-respuesta.service.ts:59`): un cambio de nombre rompe métricas en silencio.
- `ask_email` es a la vez el paso del menú de la puerta (`whatsapp-puerta-desconocido.ts:44`) y un paso de escalamiento para métricas (`whatsapp-metricas.ts:43`, RT:605): el nombre ya no describe lo que hace.
- Hay **más de 250 valores distintos de `step`** (conteo aproximado, por catálogo) repartidos en más de 30 archivos, sin un catálogo único; las listas que dependen de ellos (`PASOS_PASE_A_LA_ESCUELA`, `PASOS_CON_SLA`, `PASOS_DE_DERIVACION`, `PASOS_A_PERSONA`, `PASOS_ESCALAMIENTO`) se mantienen a mano y no coinciden entre sí (p. ej. `embudo_a_persona` está en `PASOS_A_PERSONA` pero no en `PASOS_CON_SLA`, BOT:8133 vs `whatsapp-sigue-en-fila.service.ts:41`).

## C · 9. Lo que NO se cubrió

- Textos exactos de cada mensaje fijo y ramas internas de `whatsapp-venta-servicio.ts` (1.878 líneas), `whatsapp-clase-cortesia.service.ts` (2.291), `whatsapp-embudo-prospecto.ts` (1.893) y `continuarComoComprobante` (COLA:3117-3590).
- La base viva: no se consultó qué versión de `wa_ingest_inbound_message`, `wa_identify_by_phone` o `auto_approve_payment` está aplicada, ni qué escuelas tienen `auto_approve_enabled`.
- Cobertura real por rama: no se corrió `vitest` ni cobertura; la columna de pruebas es por mención.
- Scripts de `bff/scripts/wa-*.ts` (30 archivos): solo se listaron los de campaña.
