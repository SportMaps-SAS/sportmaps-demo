# WhatsApp v2: anuncios, campañas y formularios — plan completo

Estado: **aprobado por el usuario (2026-11-04: «arma todo el plan completo y démosle de una»)**. Une tres
piezas: atribución de anuncios (`whatsapp-anuncios-atribucion.md`), campañas al historial con tope de Meta, y
formularios dentro de WhatsApp (`whatsapp-flows-formularios.md`). Piloto: Monster´s Volley Club; todo por
escuela, Dynasty y las demás no cambian salvo que se prenda para ellas.

## 0. Principios

- Quitar pasos (memoria del usuario): un formulario de 3 pantallas en vez de 8 mensajes.
- Nunca silencio ni un callejón: si el formulario no abre o lo cierran, sigue el chat por pasos de hoy.
- Medir todo el embudo: anuncio → conversación → formulario (por pantalla) → cupo/pago → asistencia → matrícula.
- Consentimiento explícito y guardado (Ley 1581): es lo que habilita las campañas.
- Una sola sesión aplica migraciones; cada fase con su batería `qa:embudo` en 100 % antes de subir.

## 1. Lo que ya está (2026-11-04)

- Monster conectado por coexistencia (318 868 2241), historial de 6 meses (59 mil mensajes, 1786 personas),
  bot apagado en modo automático, 19 plantillas en revisión de Meta, clínica activa en el catálogo.
- Límite de Meta: TIER_250, calidad verde, negocio **no verificado**.
- La referencia del anuncio (`referral`) ya se guarda en cada mensaje entrante desde las 10:54.

## 2. Fase A — en curso (3 agentes)

| Pieza | Qué | Estado |
|---|---|---|
| A1 Atribución | tabla + trigger + relleno + RPC del embudo por anuncio + pestaña **Anuncios** + mapeo anuncio→destino | agente trabajando |
| A2 Destino por anuncio | el bot manda cada anuncio a su destino (clínica → ficha + precio del día + pago + motivo esperado); inferencia por texto; nunca el embudo equivocado | agente trabajando |
| A3 Audiencia + tope | el historial alimenta la audiencia (sin disparar nada viejo); la campaña frena antes del límite de Meta con reserva para interesados y avisos; «Cupo de hoy» en Campañas | agente trabajando |

Salida: un commit, batería completa en 100 %, migración y relleno para aplicar, `main` para el `push`.

## 3. Fase F — formularios (WhatsApp Flows)

### 3.0 Lo que confirmó la documentación de Meta (2026-11-04) y cómo cambia el plan

Fuente: docs oficiales en `developers.facebook.com/documentation/business-messaging/whatsapp/flows/…`
(páginas guardadas en el scratchpad `metadocs/`).

| Hallazgo | Consecuencia |
|---|---|
| **Publicar y enviar Flows exige verificación del negocio** (crear borradores no). En coexistencia la WABA es del portafolio de la ESCUELA; la verificación hecha por el socio no está disponible para Tech Providers. | Los formularios se prenden **por escuela verificada** (se consulta `health_status` del flow contra su número). Sin verificación → chat por pasos, automático. Monster: verificación en revisión; mientras tanto se construye y se prueba en borrador. |
| Coexistencia + Flows **no está documentado**. | Primera tarea de F-a: prueba real en el número de Monster en modo `draft` (entrega, `nfm_reply`, cómo se ve en la app Business). |
| Los flows viven en cada WABA; `migrate_flows` solo copia dentro del mismo negocio. | Crear y publicar por API en la WABA de cada escuela (`POST /{waba}/flows` con `flow_json` + `publish:true`), como las plantillas. |
| Endpoint: llave RSA 2048 **por número**, Advanced Access a `whatsapp_business_messaging`, WABA suscrita al campo `flows`, ping < 10 s (alertas desde p90 > 1 s, disponibilidad < 90 % en 10 min) → si no, THROTTLED/BLOCKED. | **Primero sin endpoint**: los datos que dependen de la escuela (precio del día, fechas/cupos disponibles) se **inyectan al enviar** (`flow_action_payload.data`) y se **revalidan al recibir** el `nfm_reply`. El endpoint queda para cuando de verdad haga falta (no depender de la base compartida en un mal momento de Disk IO). |
| Clase de prueba: el grupo depende de las respuestas (año, sexo). | F1 en dos tiempos sin endpoint: formulario con datos + consentimiento → el bot calcula el grupo → lista de horarios por chat (la de hoy) o un segundo formulario con esos cupos inyectados. |
| La Policy **prohíbe pedir números completos de documento de identidad** y restringe datos de salud; muchos deportistas son menores. | F3 matrícula **no pide cédula/TI ni datos médicos** en el formulario: pide lo no sensible + consentimientos y manda un enlace de SportMaps (bandeja de matrículas) para documento y lo demás. |
| Archivos (PhotoPicker/DocumentPicker): en `nfm_reply` llegan como `{id, sha256, mime_type}` y se bajan con la Media API. | F4 comprobante con `max-uploaded-photos: 1` → se baja y entra a la cola de comprobantes con el motivo ya elegido. |
| Flow JSON **7.3** recomendada; `data_api_version` 3.0/4.0; `flow_message_version` "3"; OptIn (5 por pantalla, «Leer más» con `open_url`), CalendarPicker (`include-days`, `unavailable-dates`), barra de avance automática con más de una pantalla. | Se usa 7.3. Consentimiento con dos OptIn (datos obligatorio, novedades opcional) con enlace a la política unificada. Calendario solo con sáb/dom en Monster. |
| Cobro: desde el **1-oct-2026** los mensajes de servicio se cobran después de **1.000 gratis al mes por número**; las plantillas por categoría; el `nfm_reply` no se cobra. Límite de envío por portafolio: 250 → 2.000 → 10.000 → 100.000. | Cada envío de un formulario dentro de la ventana es un mensaje de servicio: medio de pago en Meta obligatorio; la pestaña Formularios muestra cuántos van en el mes. |
| WhatsApp Web: la doc se contradice (no soportado vs. «desde dic-2025»). Android ≥ 6 / iOS ≥ 12. | Siempre respaldo por chat; si llega 131026 «Undeliverable», el bot sigue por pasos sin pedirle nada a la familia. |

### 3.1 Infraestructura (FL-INFRA)
- Migración: `whatsapp_flows` (escuela/integración, nombre, `flow_id` de Meta, versión, estado, `endpoint`),
  `whatsapp_flow_respuestas` (cada respuesta completa: flow, conversación, contacto, `response_json`, fecha),
  `whatsapp_consentimientos` (contacto, escuela, tipo `datos|novedades`, versión de la política, canal,
  fecha, revocado_at) que alimenta `whatsapp_optins`. RLS: solo BFF; lectura de la escuela por RPC/vista.
- `flow_token` firmado (HMAC con secreto del BFF): lleva escuela, conversación, formulario y paso; un token
  inválido o vencido se rechaza.
- Webhook: reconoce `interactive.nfm_reply` y lo enruta por formulario al motor de hoy.
- Envío: mensaje interactivo `flow` (botón «Reservar mi cupo», «Completar matrícula»…) y plantillas con
  botón de Flow para fuera de las 24 h.
- Endpoint cifrado `POST /api/v1/webhooks/whatsapp/flows`: llave RSA por número (privada cifrada con la
  llave del BFF; pública subida a Meta), descifrado/cifrado de cada petición, `ping` de salud, respuesta en
  < 3 s (Meta exige < 10), errores con los códigos de Meta.
- Scripts: `wa-registrar-flow` (crear, subir JSON, validar, publicar), `wa-copiar-flows` (a otra WABA),
  `wa-estado-flows` (solo lectura). Versionado en `bff/whatsapp-flows/*.json`.

### 3.2 Formularios (FL-FORMS)
| # | Formulario | Tipo | Al terminar |
|---|---|---|---|
| F2 | Inscripción a servicio (clínica, vacacional, torneo): ficha, deportista, talla, semanas, afiliado, resumen con valor y abono + consentimientos | estático → dinámico (precio del día) | lead/inscripción + motivo esperado con monto + datos de pago |
| F1 | Clase de prueba: qué es + valor + consentimientos · deportista (calendario, listas) · sede y horario con cupos reales | dinámico | separa el cupo (misma RPC), lead, consentimiento, datos de pago |
| F3 | Matrícula después de la prueba: acudiente, deportista, documento, EPS, autorizaciones, grupo asignado | dinámico | entra a la bandeja de matrículas V2 (crear con un clic) |
| F4 | Comprobante con motivo: deportista, motivo, monto, foto/PDF | dinámico | cola de comprobantes con motivo ya elegido |
| F5 | Datos y consentimiento de familias del club | estático | ficha actualizada + opt-in |
| F6 | Encuestas (post-entreno, PQRS) | estático | lo que hoy pide el bot por mensajes |

Cada uno con su respaldo por chat y su bloque en la batería (`--solo flows`: completo, incompleto, token
inválido, sin cupo al confirmar, precio que cambió entre pantallas).

### 3.3 Pantallas en SportMaps (FL-UI)
- WhatsApp → **Formularios**: qué formularios tiene la escuela, estado en Meta (borrador/publicado), publicar o
  actualizar, respuestas recientes y tasa de terminación por pantalla.
- **Consentimientos**: quién aceptó datos/novedades, cuándo y con qué versión; exportable.
- Campañas: elegir una plantilla con botón de formulario (p. ej. clínica «Reservar mi cupo»).
- Anuncios: el embudo suma «abrió el formulario» y «lo terminó».

### 3.4 Orden
1. **F-a**: infraestructura sin endpoint + F2 clínica estático + consentimiento + plantilla «Reservar mi
   cupo». (Primero lo que trae plata: la clínica tiene anuncios corriendo.)
2. **F-b**: endpoint cifrado + F1 clase de prueba con cupos reales + F2 con precio del día.
3. **F-c**: F3 matrícula + F4 comprobante; después F5–F6 y los mismos formularios para el canal de SportMaps
   (B10).

## 4. Campañas al historial

- Audiencia: personas del historial con intención (clase de prueba, inscripción, precio, horarios, clínica,
  vacacional), sin familias/staff/inscritos/bajas.
- Tope: cupo del día = mín(tope de la escuela, límite de Meta − reserva − ya enviados en 24 h); reserva
  = máx(30, 20 %). Piloto de 50, frecuencia mínima 7 días, pausa automática si la calidad baja.
- Consentimiento: hoy `optin` (0 personas). Para el historial hace falta «contacto previo declarado» (180
  días) — **decisión del usuario y asesoría legal (Ley 2300)**. Desde la fase F, el formulario genera opt-ins
  explícitos y las campañas pasan a usarlos.
- Costo: cada plantilla de marketing tiene costo en Meta (método de pago de Monster en Meta).

## 5. Lo que depende de otros

| Quién | Qué |
|---|---|
| Usuario | aplicar migraciones; `push` a `main`; prender el catálogo de cobros de Monster en /admin/subscriptions; decidir base de consentimiento del historial |
| Monster | verificar el negocio en Meta (sube el límite y quizá lo exijan los formularios); método de pago en Meta; enlace de Maps de «Pinar»; 5.º domingo; afiliados $250.000 en la clínica; horario de atención real |
| Meta | aprobar plantillas y publicar formularios |

## 6. Riesgos

- Formularios en números de coexistencia o sin verificación: se confirma con la doc antes de construir (agente
  de investigación); si no aplica, F queda para Dynasty/canal SportMaps y Monster sigue por chat hasta verificar.
- Endpoint con latencia alta → Meta lo estrangula: respuesta < 3 s, sin consultas pesadas por pantalla (Disk IO).
- Datos sensibles: no pedir números de tarjeta ni contraseñas; documento de identidad solo en matrícula (F3) y
  con consentimiento.
