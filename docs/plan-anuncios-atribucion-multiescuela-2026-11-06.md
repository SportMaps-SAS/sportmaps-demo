# Plan: anuncios, atribución y medición de WhatsApp (Monster primero, todas las escuelas después)

Estado: **plan para aprobar (2026-11-06)**. Nada de esto está construido salvo lo que ya cubre
`docs/specs/whatsapp-anuncios-atribucion.md` (fase 1: tabla de atribución, trigger, RPC `wa_embudo_anuncios`,
destino por anuncio). Este plan lo **extiende**; no lo reemplaza.

## 1. Qué encontramos (Monster, 4 al 6 de noviembre)

| Dato | Valor |
|---|---|
| Chats nuevos en WhatsApp | 62 |
| Conversaciones según Meta Ads (2 campañas, destino WhatsApp) | 60 (interacción 32 · ventas 28) |
| Chats con marca de anuncio (`referral`) | 28 — todos tipo anuncio, todos con el texto prellenado |
| Chats sin marca | 34: 23 con texto propio, 8 «mensaje no disponible» (errores 131060 / 131051), 2 audios, 1 con texto prellenado sin marca |
| Inversión / costo por conversación | $47.975 COP / ~$800 (interacción $756, ventas $849) |
| Pagos de la clínica registrados en SportMaps | 0 |

Conclusión: casi todos los chats vienen de los anuncios, pero **solo vemos de qué anuncio vino menos de la mitad**
(28 de ~60). Además no tenemos el gasto dentro de SportMaps ni cerramos el ciclo hasta el pago.
Sospecha por verificar: la campaña de ventas (28) coincide con los 28 marcados y la de interacción (32) con los
34 sin marca. Se confirma con el ID de cada anuncio por campaña (pedido a Monster).

## 2. Principios (para que sirva a todas las escuelas)

1. **Nada de Monster en el código.** Todo por `school_id` / `integration_id`: nombres de anuncios, reglas de texto,
   gasto, permisos de Meta. Monster es la primera escuela configurada, no un caso especial.
2. **Configurable por la escuela, con valores por defecto de la plataforma.** Mapeo «anuncio → destino»
   (ya existe en `whatsapp_anuncio_destino`), catálogo de anuncios, reglas de texto.
3. **Una convención de nombres y de texto prellenado igual para todas** (sección 4), documentada en una guía
   corta para el community manager de cada escuela.
4. **Conexión a Meta por escuela con su propio permiso** (OAuth), un solo sistema de la plataforma. La
   escuela autoriza su cuenta publicitaria; la plataforma no guarda contraseñas.
5. **Sin consultas pesadas.** Sincronizaciones diarias en lote, nunca por minuto ni una consulta por fila
   (la base es una sola y el Disk IO sigue siendo el límite).
6. **No cambiar flujos acordados.** El bot solo agrega reconocimiento de anuncio; no cambia el embudo ya acordado.
7. **Seguridad:** tablas nuevas con RLS, helper de alcance correcto (`user_admin_school_ids()` para
   configurar; lectura para staff), `GRANT EXECUTE` explícito por RPC, sin `anon`.

## 3. Fases

### Fase 0 — Esta semana, sin código (lo hace Monster)
| Qué | Quién |
|---|---|
| Mandar el **ID de cada anuncio con su campaña** (columna «ID del anuncio» en el panel de Meta) | Monster / community manager |
| **Convención de nombres** de campaña y anuncio (sección 4) | Monster |
| **Texto prellenado distinto por anuncio** (sección 4) | Monster |
| Enlace del perfil y del community manager con un texto propio, aparte de la publicidad pagada | Monster |
| Cruzar IDs con los 9 que ya llegan marcados y confirmar si la campaña de interacción llega sin marca | SportMaps |
| Registrar los pagos de la clínica que llegaron por Nequi/correo (cerrar el ciclo del abono) | Monster pasa la lista; SportMaps registra |

### Fase 1 — Código pequeño, sin permisos de Meta (SportMaps)
Objetivo: **recuperar la atribución que hoy se pierde y mostrar nombres legibles.**
1. **Reconocer el anuncio por el texto prellenado** cuando el mensaje no trae `referral`. Reglas por escuela
   (`whatsapp_anuncio_regla`: `school_id`, `patron`, `anuncio_nombre`, `destino`). Es el respaldo; si hay
   `referral`, manda `referral`.
2. **Mensajes «no disponible» (131060) y álbumes (131051):** ya los atiende el webhook
   (`routes/whatsapp.ts`: abre la conversación en el buzón y pide reescribir una vez al día cuando el asistente
   atiende). No requiere código nuevo; solo vigilar que el equipo los vea en el buzón.
3. **Catálogo de anuncios** (`whatsapp_anuncio_catalogo`: `school_id`, `source_id`, `nombre`, `campana`,
   `creativo`): carga por CSV exportado de Meta o a mano. La pestaña Anuncios muestra el nombre, no el número.
4. **Gasto por CSV** (`whatsapp_anuncio_gasto`, ya diseñada en el spec original): la escuela sube el reporte de Meta
   por anuncio y fecha. Da costo por conversación y por pago sin API.
5. **Visibilidad del vacío:** la pestaña muestra «sin marca» como una fila, con el conteo, para que nadie
   confunda «no vino de anuncio» con «no sabemos».
6. **Cierre del ciclo de pago:** vista que cruza chat → comprobante → pago → motivo (clínica, matrícula,
   vacacional) para ver pagos por anuncio.

### Fase 2 — Conexión a Meta por escuela (Marketing API)
- Botón «Conectar cuenta publicitaria» en WhatsApp › Anuncios: OAuth con permiso `ads_read`; token guardado
  cifrado por integración (nunca en el repo ni en archivos).
- Job **diario** que trae por anuncio: gasto, alcance, impresiones, clics y conversaciones iniciadas; guarda en
  `whatsapp_anuncio_gasto` y `whatsapp_anuncio_catalogo` (nombres e IDs sin CSV).
- Costo por conversación, por interesado y por pago en el panel; comparativo entre campañas.
- Requiere: app de SportMaps con el permiso aprobado por Meta (una sola revisión de la plataforma) y que cada
  escuela autorice su cuenta. **Verificar el proceso y los permisos vigentes en la documentación de Meta antes
  de construir.**

### Fase 3 — Devolver los resultados a Meta (API de Conversiones para mensajería)
- Cuando una persona paga o se matricula, SportMaps envía el evento (por ejemplo `Lead` y `Purchase`) con el
  identificador del clic (`ctwa_clid`, que ya guardamos en `whatsapp_atribucion`).
- Resultado: Meta optimiza las campañas hacia quienes **pagan**, no solo hacia quienes escriben.
- Requiere un conjunto de datos (dataset) por escuela y el visto bueno de la escuela para enviar eventos.
  Evaluar privacidad (datos mínimos, sin PII en claro) con la política de privacidad vigente.

### Fase 4 — Plantilla para todas las escuelas
- **Guía de arranque** de 1 página para el community manager (nombres, texto prellenado, cómo exportar IDs).
- **Checklist de onboarding** por escuela: número conectado, webhooks suscritos, destinos mapeados,
  catálogo cargado, cuenta publicitaria conectada, dataset de conversiones.
- **Vista de plataforma** (admin): embudo, costo por conversación y calidad de la atribución por escuela
  (porcentaje «sin marca»), para detectar escuelas con el mismo problema.
- Opcional: traer mensajes directos de Instagram y Messenger con sus APIs de mensajería.

### Avance de la Fase 1 (2026-11-06)

| Pieza | Estado |
|---|---|
| 1. Reconocer el anuncio/canal por el texto | **Hecho en el código, sin aplicar:** migración `20261106115639_whatsapp_anuncio_regla_texto.sql` (tabla `whatsapp_anuncio_regla` + 5 reglas de canal de la plataforma), servicio `whatsapp-atribucion-texto.ts` con 21 pruebas y enganche en el webhook. Falta que una sola sesión aplique la migración. |
| 2. Mensajes «no disponible» | Ya existía. |
| 3. Catálogo de anuncios (nombres legibles) | Pendiente. |
| 4. Gasto por CSV | Pendiente. |
| 5. Fila «sin marca» visible en la pestaña | Pendiente. |
| 6. Cierre del ciclo de pago | Pendiente (depende de que Monster pase los pagos). |
| Pantalla para administrar las reglas (hoy: SQL) | Pendiente. |

## 4. Convención para todas las escuelas

- **Campaña:** `{objetivo}_{servicio}_{mes}` → `ventas_clinica_nov26`.
- **Anuncio:** `{servicio}_{creativo}_{variante}` → `clinica_reel1_a`.
- **Texto prellenado por anuncio:** una frase propia, por ejemplo «Hola, vi el reel de la clínica y quiero
  separar mi cupo». No se agregan códigos visibles feos; se usa una frase distinta por anuncio.
- **Orgánico:** el enlace del perfil, el del community manager y el de campañas por correo llevan su propio texto,
  distinto a cualquier anuncio.

## 5. Métricas por escuela (panel único)

- Volumen: chats nuevos por día y por hora; con marca / sin marca.
- Por anuncio y campaña: conversaciones, interesados, separó, pagó, asistió, matriculó, recaudo.
- Atención: tiempo de primera respuesta (Mapi y equipo), chats sin respuesta, mensajes no entregados.
- Costo: gasto, costo por conversación, por interesado y por pago; mensajes cobrados por Meta.
- Calidad de datos: porcentaje de chats con marca; anuncios sin catalogar; errores de entrega.

## 6. Datos nuevos (una sola migración, una sola sesión)

- `whatsapp_anuncio_catalogo`, `whatsapp_anuncio_regla`, `whatsapp_anuncio_gasto`, y (fase 2)
  `whatsapp_meta_cuenta` con el token cifrado. Todas: `school_id` + `integration_id`, RLS activado.
- RPC de lectura agregada para el panel (misma forma que `wa_embudo_anuncios`), con el alcance validado adentro
  y `GRANT EXECUTE … TO authenticated`.
- Crear con `npm run migrations:new -- <slug>` y subir el ledger. Regenerar `types.ts` una sola vez al final.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Meta no manda la marca de algunos anuncios o canales | Reglas de texto + texto prellenado por anuncio + mostrar el vacío |
| Revisión de la app de Meta lenta | Fase 1 funciona sin permisos; gasto por CSV mientras tanto |
| Token de Meta por escuela | Cifrado, rotación, permiso solo de lectura de anuncios |
| Privacidad al enviar eventos a Meta | Solo identificador del clic y tipo de evento; consentimiento de la escuela |
| Cada escuela nombra distinto | Guía corta + el catálogo permite renombrar sin tocar Meta |

## 8. Decisiones (resueltas el 2026-11-06)

- D1. **Convención de nombres y texto prellenado como estándar de la plataforma:** pendiente de confirmar con el
  ejemplo de la sección 4 (explicado a la dueña del producto).
- D2. **Gasto por CSV primero (fase 1) y API de Marketing después (fase 2).** Aprobado como posible.
- D3. **La revisión de la app de Meta la gestiona SportMaps** (la app y el permiso `ads_read` son de la plataforma).
  Monster solo autoriza su cuenta publicitaria y da acceso en su Business Manager.
- D4. **La vista queda abierta al admin de la escuela y a un rol nuevo dedicado a esto** (community manager /
  marketing). Ese rol ve WhatsApp › Anuncios y la bandeja de mensajes; **no** ve cobros, contabilidad ni otorga
  permisos. Se crea como rol de la escuela con su propia función de alcance (no se reutiliza
  `user_staff_school_ids()`, que incluye a quien opera cobros). La vista de plataforma queda para el admin de plataforma.
- D5. **Todos los canales desde el diseño** (WhatsApp, Instagram y Messenger). Ver Fase 2b.

## Fase 2b — Instagram y Messenger (decidido: todos los canales)

- **Desde la Fase 1** el modelo de datos queda **por canal** (`canal` en conversaciones, atribución y catálogo),
  para no rehacer nada después.
- Instagram Direct y Messenger entran con sus APIs de mensajería (permisos propios con revisión de Meta);
  la bandeja de la escuela los muestra juntos con una etiqueta de canal.
- El bot de Mapi responde solo donde la escuela lo active; las reglas de ventana de respuesta cambian por canal
  y se validan contra la documentación de Meta.
- Atribución por canal: el anuncio de Instagram o Facebook con destino a mensajes trae su propio origen.
- Riesgo: es más trabajo y más permisos que WhatsApp solo. Se construye en paralelo con la Fase 2 sin retrasar
  la Fase 1.

## 9. Criterios de aceptación

- Fase 1: en Monster, el porcentaje de chats con anuncio identificado pasa de 45 % (28/62) a más de 80 % con las
  reglas de texto; la pestaña muestra nombres y la fila «sin marca»; el gasto por CSV da el costo por conversación
  de cada anuncio.
- Fase 2: el costo diario por anuncio aparece sin carga manual; el job no genera consultas por fila.
- Fase 3: al registrarse un pago de la clínica, Meta recibe el evento con su `ctwa_clid` y lo muestra en su panel.
- Fase 4: una escuela nueva queda con el panel funcionando en menos de una hora con el checklist.
- Pruebas: unitarias de las reglas de texto, batería `qa:embudo` con el bloque `anuncios`, y gate de RLS (un
  coach o una escuela ajena ve 0 filas).
