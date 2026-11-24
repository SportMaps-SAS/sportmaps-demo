# Pizarra M6h — videos subidos (celular, Veo y otras cámaras)

> 2026-10-15. Continúa `pizarra-m6-paridad-tacticalpad.md` (M6c = videos por **enlace**) y retoma la T6
> «análisis de video» de `pizarra-multideporte-3d-ia.md`, que se postergó por almacenamiento.
> Pedido del usuario: «en los videos, que ellos suban los del celular, o los de Veo, o de algo que haga videos;
> tener esas opciones».
> Estado: **fase 1 CONSTRUIDA detrás de un flag por escuela** (rama `pizarra-tp/m6h`). Migración
> `20261015171131` (en `develop` y en el ledger; antes `20261015145434`, y `20261015125439` en la rama; verificado 2026-11-23) **APLICADA en la base** (consulta de solo lectura del 2026-11-23: las 3 tablas con RLS, las 7 policies y las 9 funciones existen; sin fila en `schema_migrations`). Sin llaves reales: falta que el usuario cree la cuenta del proveedor (§9).

> **Actualización 2026-11-20.** El track `BOD`
> ([body-biblioteca-tecnicas-y-rendimiento.md](body-biblioteca-tecnicas-y-rendimiento.md)) reutiliza esta subida
> para el contenido real de la biblioteca de técnicas (`BOD-6`), en vez de construir otra. Si la migración
> `20261015171131` está viva y si existen las llaves del proveedor se confirma en `BOD-0`. Sigue sin existir el
> dibujo o la medición sobre el video.

## 1. Decisión en una línea

Los videos se suben **directo del celular al proveedor de video (Bunny Stream)**, nunca a Supabase ni al BFF.
El BFF solo reserva cupo, firma la subida y las URLs de reproducción, y recibe el aviso del proveedor. Fase 1:
**solo el cuerpo técnico** ve los videos; las familias, en la fase 4 y solo con consentimiento.

## 2. Por qué no Supabase Storage (y por qué no YouTube)

- **Supabase Storage** (Pro, consultado 2026-10-15 en supabase.com/pricing): 100 GB incluidos y luego
  US$0,0213/GB-mes; 250 GB de egress incluidos y luego US$0,09/GB; archivos de hasta 500 GB; subida tus
  (`/storage/v1/upload/resumable`). **No transcodifica**: un `.MOV` HEVC del iPhone no se reproduce en Chrome/Android
  y a las familias les llegaría el archivo crudo de ~9 Mbps por datos móviles. Además es **una sola base/proyecto**
  para dev, stg y prod, venimos de quedarnos sin espacio en el plan Free (los comprobantes no se comprimen) y de una
  caída de ~14 h por Disk IO. Un partido de 90' son 6–9 GB: 10 escuelas llenan el incluido en semanas.
- **YouTube (canal del coach, «no listado»)**: gratis, pero (a) «no listado» = cualquiera con el enlace lo ve, choca
  con «nunca público»; (b) el API cambió: `videos.insert` ahora gasta del cupo «Video Uploads» con **100 llamadas/día
  por proyecto** (developers.google.com/youtube/v3/docs/videos/insert, 2026-10-15) — un techo para toda la
  plataforma; (c) OAuth del coach a su cuenta personal y verificación de la app ante Google; (d) videos de menores
  quedan bajo las reglas de YouTube (contenido «para niños», comentarios apagados). Sirve más adelante para
  **publicar** highlights que la escuela quiera hacer públicos, no para el análisis interno.

## 3. Proveedor: comparación y recomendación

Supuestos (explícitos): una escuela sube **10 h de video al mes** (600 min; del celular ~9 Mbps ≈ 4 GB/h crudo);
la familia/staff lo ve **50 veces** al mes: escenario A = 50 reproducciones de ~20 min (1.000 min entregados), escenario
B = 50 horas completas (3.000 min). HLS adaptativo entregado ≈ 1,35 GB/h (720p). Lo guardado se **acumula** (600 min
más cada mes) si no se borra. Tasa de referencia: **COP 4.000 / US$** (supuesto, no cotización).

| Proveedor (precios consultados 2026-10-15) | Almacenamiento | Entrega | Codificación | Mínimo / gratis |
|---|---|---|---|---|
| **Bunny Stream** (bunny.net/pricing/stream) | desde US$0,01/GB-mes por región | desde US$0,005/GB | gratis | US$1/mes mínimo; prueba 14 días sin tarjeta |
| **Mux** (mux.com/pricing/video) | US$0,003/min-mes (1080p basic) | US$0,001/min tras **100.000 min gratis/mes** | basic 1080p gratis | sin mínimo; la página menciona US$20/mes de crédito en pago por uso |
| **api.video** (api.video/pricing) | desde US$0,00285/min-mes | desde US$0,0017/min | gratis | sandbox de 30 s; sin mínimo |
| **Cloudflare Stream** (developers.cloudflare.com/stream/pricing) | US$5 por 1.000 min, **prepago** | US$1 por 1.000 min | gratis | sin capa gratis |
| Supabase Storage Pro | US$0,0213/GB tras 100 GB **compartidos** | US$0,09/GB tras 250 GB | **no hay** | ya pagado (US$25) |

Costo real de UNA escuela (US$ ≈ COP):

| | Mes 1 (A) | Mes 1 (B) | Mes 12 (A), 120 h guardadas |
|---|---|---|---|
| **Bunny** (escalera 720p+480p+360p ≈ 2,4 GB/h guardados, 1 región) | ~0,5 → **mínimo US$1 (≈ 4.000)** | ~US$1 (≈ 4.000) | ~US$3,1 (≈ 12.400) |
| Mux | US$1,80 (≈ 7.200) | US$1,80 | US$21,60 (≈ 86.400) |
| api.video | US$3,41 (≈ 13.600) | US$6,81 | US$22,22 (≈ 88.900) |
| Cloudflare Stream | US$6 (bloque de 1.000 min + 1) (≈ 24.000) | US$8 | US$41 (≈ 164.000) |
| Supabase Storage (crudo, sin transcodificar) | dentro del incluido **compartido** | egress 200 GB del incluido compartido | ~US$8 + egress, y sin poder reproducir los .MOV |

A escala (20 escuelas así al mes 12): Bunny ≈ US$62, Mux ≈ US$432, api.video ≈ US$444, Cloudflare ≈ US$820.
El video de partido es **largo y se ve poco**: manda el almacenamiento, y Bunny cobra por GB, no por minuto.

**Recomendación: Bunny Stream** para la fase 1.
- Costo: 6–10 veces más barato al año que los que cobran por minuto, con US$1 de mínimo para arrancar.
- Subida directa reanudable (tus) desde el celular con **firma calculada en el servidor**:
  `AuthorizationSignature = sha256(library_id + api_key + expiration_time + video_id)` (docs.bunny.net/stream/tus-resumable-uploads).
- Reproducción privada: «Embed view token authentication», `token = SHA256_HEX(token_security_key + video_id + expiration)`
  (docs.bunny.net/stream/token-authentication). El reproductor habla **player.js** (`getCurrentTime`), que es lo que
  permite «Marcar inicio / fin» sin instalar librerías (docs.bunny.net/stream/playback-api).
- Webhook firmado: `X-BunnyStream-Signature` = HMAC-SHA256 del cuerpo crudo con la API key de solo lectura,
  `-Version: v1`, `-Algorithm: hmac-sha256` (bunny.net/docs/stream/webhooks).
- Codificación gratis, región de almacenamiento elegible.

Riesgos de Bunny y cómo quedan cubiertos:
- El webhook **no trae timestamp** (no hay protección de repetición). Mitigado: el payload solo dice «mira este video»;
  el BFF **relee el estado en el API de Bunny** y `settle_school_video` es idempotente. Un webhook repetido o viejo no
  cambia nada.
- Los campos del GET de video (`status`, `length`, `storageSize`) se tomaron de la referencia del API y de clientes de
  la comunidad: **verificarlos con la primera subida real** antes de abrir el flag a una escuela.
- El dominio del reproductor puede pasar de `iframe.mediadelivery.net` a `player.mediadelivery.net`: queda en
  `BUNNY_STREAM_EMBED_BASE`.
- Miniaturas: por la CDN exigen el token de la Pull Zone; en la fase 1 la UI muestra una tarjeta genérica (nunca una
  foto de un menor sin firmar).

**Plan B: Mux** (documentación impecable, webhook con timestamp `Mux-Signature: t=…,v1=…`, 100.000 min de entrega
gratis al mes, recorte instantáneo dentro del JWT). Más caro al acumular; su iframe no expone eventos (para marcar
clips haría falta Mux Player o hls.js). Cambiar = escribir `bff/src/services/video/mux.ts` con la misma interfaz.

## 4. Veo, Hudl y las demás cámaras: qué se puede integrar y cómo

| Plataforma | Cómo sale el video | ¿API pública? | Integración en SportMaps |
|---|---|---|---|
| **Veo** | Descarga MP4 del partido completo («Download full game», solo vista que sigue el balón, sin dibujos; partido asignado al equipo o admin del Clubhouse); highlights IA descargables (fútbol, desde 20-ago-2025); compartir enlace (grabación pública) — support.veo.com | No encontrada (2026-10-15) | **Enlace** (M6c) y **descargar → subir** (M6h). Importación automática: fase 5 solo si Veo abre API/partners |
| **Hudl** (Focus, Sportscode) | Enlace de descarga con MP4 o ZIP de clips; Sportscode exporta MP4 | Solo de **datos** (Wyscout, StatsBomb); video sin API pública, integraciones B2B por ventas (fuentes secundarias) | Enlace + descargar → subir |
| **Trace** | Ver/compartir; descarga del partido completo solo en planes de club | No encontrada | Enlace + descargar → subir |
| **Pixellot / VidSwap** | Descarga; highlights en ZIP | **Sí, de partners** (api.pixellot.tv, JWT, revisión de arquitectura por api-support@pixellot.tv) | Enlace + subir; **candidato** a importación por API (fase 5) |
| **Spiideo, XbotGo, Reeplayer** | Descarga desde su app/nube | No verificado | Enlace + descargar → subir |
| **PlaySight** | Descargar el juego comprado; exportar clips al celular | No verificado | Descargar → subir |
| **Cámara del celular** | Archivo local | — | **Subir** directo (`<input accept="video/*" capture>`) |

En la UI: pestaña «Importar de Veo, Hudl…» con los pasos de cada una y el botón «Ya lo descargué: subirlo»
(abre «Subir video» con el origen marcado). Los **enlaces** siguen siendo de M6c («Videos» de la jugada); acá no se
duplican.

## 5. Menores de edad: ley y decisiones

Marco (Colombia):
- **Ley 1581 de 2012**: la imagen/video de una persona identificable es dato personal; los datos biométricos son
  **sensibles** (art. 5). Art. 7: los datos de niños, niñas y adolescentes tienen protección reforzada.
  Art. 26: transferir datos a otro país exige nivel adecuado de protección o autorización expresa (Bunny almacena
  fuera de Colombia).
- **Decreto 1377 de 2013** (compilado en el Decreto 1074 de 2015): **art. 12** —el que regula a los menores; el
  art. 7 trata del *modo* de obtener la autorización (escrita, oral o conducta inequívoca; **el silencio nunca es
  autorización**)— exige que el tratamiento responda al **interés superior** del menor, respete sus derechos
  fundamentales, y que la autorización la dé el **representante legal**, después de escuchar al menor según su
  madurez. Art. 6: no se puede condicionar ninguna actividad a entregar datos sensibles.
  (Texto consultado en alcaldiabogota.gov.co, 2026-10-15; funcionpublica.gov.co no respondió.)
- **Ley 1098 de 2006** (Código de la Infancia), art. 33: derecho a la intimidad y a la propia imagen.
- La escuela es **responsable** del tratamiento; SportMaps es **encargado**.

Qué hay hoy en el repo (revisado): los **informes** de atleta no tienen registro de consentimiento: la familia los ve
cuando la escuela los **publica** (por eso los de Club Carmel siguen en borrador: el bloqueo es de consentimiento, se
resuelve fuera de la app). Los **carnets** tampoco tienen consentimiento de foto. El único mecanismo formal es el de
**profesionales de salud**: `clinical_consent_texts` (texto versionado, uno vigente por tipo) + `clinical_consents`
(foto del texto aceptado, quién lo da, parentesco, canal app/presencial, revocación) — migración `20261006094147`.

Decisiones:
1. **Fase 1 = solo cuerpo técnico.** RLS: leen `user_staff_school_ids()`; suben/editan/recortan
   `user_tactical_edit_school_ids()`; borran autor o admin. Padres y atletas **nada**. `consent_scope` existe pero un
   `CHECK` lo deja **solo en `staff`** hasta la fase 4 (y ni siquiera tiene GRANT de UPDATE).
2. **Nunca público**: reproducción solo por URL firmada que vence (15 min por defecto; el reproductor pide duración +
   30 min, techo 6 h), `Cache-Control: no-store`, sin descarga, sin miniaturas sin firmar. Bunny: activar «Embed view
   token authentication» y restringir dominios (§9).
3. **Finalidad**: análisis técnico interno de entrenamientos y partidos. La escuela debe tenerla en su autorización de
   tratamiento al inscribir (texto sugerido en §9). Sin eso, la escuela no debería prender el flag.
4. **Fase 4 (familias)** reutiliza el patrón clínico: `media_consent_texts` + `athlete_media_consents` (por atleta,
   otorgado por el acudiente con su parentesco, canal, foto del texto y revocación). Un video o clip se comparte con
   familias **solo si todos los atletas etiquetados tienen consentimiento vigente**; sin etiquetas, no se comparte.
   Revocar oculta al instante. El acceso es por sesión de la familia y URL firmada corta; nunca un enlace abierto.
5. **Supresión** (habeas data): borrar un video lo marca borrado, devuelve el cupo, borra sus clips y borra el asset en
   Bunny. Retención propuesta: partidos completos 12 meses (configurable por escuela, fase 2).

## 6. Fase 1 — lo construido (detrás del flag)

**Flag por escuela**: `school_video_settings.enabled` (sin fila = apagado) + proveedor configurado en el BFF. No se usó
`school_addons` porque su `CHECK` de `addon_key` vive en la base con una lista que cambió varias veces; cuando se
venda como adicional, `set_school_video_settings` se llama desde el flujo de adicionales. Solo SportMaps lo prende.

**Base** (`20261015171131_pizarra_videos_subidos.sql`, aplicada; verificado 2026-11-23):
- `school_video_settings`: flag, cupo (por defecto 10 h y 25 GB **guardados**), máximo por archivo (4 GB) y por video
  (3 h), contadores `used_*`.
- `school_videos`: `provider` (bunny|cloudflare|mux|apivideo), `provider_asset_id`, `status`
  (uploading|processing|ready|failed|deleted), `duration_s`, `size_bytes`, `title`, `recorded_at`, `source`
  (phone|veo|hudl|trace|pixellot|other), `consent_scope`, `created_by → profiles`, borrado lógico. El `id` es el
  `asset_id` que M6c reservó para `provider = 'sportmaps'`: una jugada referencia un video subido con
  `{ provider: 'sportmaps', asset_id: <school_videos.id> }`.
- `school_video_clips`: `start_s`/`end_s`, título y **una** jugada opcional (`lineup_id` | `preset_id` |
  `exercise_id`, `CHECK num_nonnulls ≤ 1`); trigger que fija la escuela desde el video y exige que la jugada sea de la
  misma escuela. Clips **virtuales**: no crean otro video en el proveedor.
- RPCs `SECURITY DEFINER` con `search_path` fijo y GRANT explícito: `begin_school_video_upload` (reserva cupo + fila,
  `FOR UPDATE` sobre la fila de settings), `attach_school_video_asset`, `settle_school_video` (solo service_role;
  cambia la reserva por lo real, idempotente), `soft_delete_school_video` (autor táctico o admin; devuelve cupo),
  `set_school_video_settings` (solo super admin/service_role), `expire_stale_school_video_uploads` (cron pendiente).
- Sin `FOR ALL`; escritura con `WITH CHECK`; `REVOKE` explícito a anon/authenticated y GRANT por columna.

**BFF** (`bff/src/services/video/` + `bff/src/routes/school/videos.ts`):
- Interfaz `VideoProvider`: `createUpload`, `getPlaybackUrl({ ttlS })`, `getAsset`, `deleteAsset`,
  `webhook.verify/parse`. Adaptador `bunny.ts` contra el API documentado; `index.ts` lo arma desde el entorno (sin
  variables → 503 «todavía no configurado», el resto del BFF sigue igual).
- Rutas: `GET /school/videos/settings`, `GET /school/videos`, `POST /school/videos/uploads` (valida tipo
  mp4/quicktime/webm, tamaño ≤ 4 GB, duración ≤ 3 h; reserva → crea en Bunny → guarda el asset; si algo falla devuelve
  la reserva), `POST /:id/sync`, `GET /:id/playback`, `PATCH`/`DELETE /:id`, clips CRUD,
  `POST /api/v1/webhooks/video/:provider` (firma sobre `req.rawBody`). Todo con la **sesión del usuario** contra la
  base (RLS y RPCs con `auth.uid()`); `service_role` solo para `settle`.

**Frontend**: botón «Videos» en la barra de la pizarra → diálogo con «Subir video» (cámara con `capture` o archivo;
subida tus propia con progreso, cancelar y reanudación si se cae la red), «Importar de Veo, Hudl…» (guía) y «Videos
de la escuela» (lista, estado, reproductor con clips: marcar inicio/fin desde el reproductor o a mano, «Vincular a esta
jugada»). Flag apagado → «Disponible pronto». `SchoolVideosPanel` se puede montar como pestaña del diálogo de videos de
M6c al integrar.

**Al integrar con M6c** (`pizarra-tp/m6c`, migración `20261014163705`): las dos ramas agregan una línea al final de
`supabase/migrations_ledger.json`; se conservan ambas (M6c antes, esta después) y se corre `npm run migrations:check`.
M6c ya acepta `provider: 'sportmaps'` con `asset_id` uuid en `videos` de la jugada: ese `asset_id` es `school_videos.id`.
La barra de la pizarra tendrá dos botones de video (el de M6c y «Videos» de M6h): al integrar, montar
`SchoolVideosPanel` como pestañas dentro del diálogo de M6c y dejar un solo botón.

## 7. Fases

| Fase | Qué | Depende de |
|---|---|---|
| **1** (hecha, flag) | Subir del celular / MP4 descargado, cupo, procesamiento, reproductor privado, clips virtuales vinculados a la jugada, guía de importación | cuenta Bunny + aplicar migración |
| 2 | Clips por jugada en la ficha PDF y en la pizarra (abrir el clip desde la jugada), miniaturas firmadas, retención configurable, cron de subidas abandonadas y huérfanos en Bunny | 1 |
| 3 | **Dibujar sobre el video** (telestración): capa SVG de la pizarra sobre el reproductor en pausa, guardada como cuadros con `t` del video; exportar imagen | 2 |
| 4 | **Compartir con familias con consentimiento** (§5.4), etiquetado de atletas por clip | 1 + texto legal aprobado |
| 5 | **Importar de Veo** (y Pixellot) por API/partners si lo abren; mientras tanto descargar → subir | acuerdo con el proveedor |
| — | Cobro: adicional «Video» con cupo en horas (cupo gratis + paquetes, como la IA) | precio con costo medido |

## 8. Pruebas de la fase 1

- BFF (vitest, todo mockeado): adaptador Bunny con HTTP falso (firmas de subida y de embed contra la fórmula oficial,
  TTL, borrado, estados), firma del webhook válida/ inválida/ cuerpo alterado/ otra llave/ re-serializado, reglas de
  tipos y tamaños, permisos por rol (padre/atleta 403 en todo; admin lee y no sube; autor vs. admin al borrar), flag
  apagado, **cupo con 20 subidas en paralelo y cupo para 15 → exactamente 15**, URL firmada con TTL acotado, clips, webhook
  idempotente y que asienta lo que dice el API (no el payload).
- RLS: casos «esperado tras 20261015145434» en `scripts/rls-pruebas-pizarra.mjs` (§14), NO corridos contra la base. La etiqueta del script conserva el número viejo; la migración es `20261015171131`.
  Concurrencia real del cupo (20 `begin_school_video_upload` en paralelo con cupo para 15) se prueba al aplicar, una vez.
- Frontend (vitest): cliente tus (progreso, red caída → offline → HEAD → sigue sin reenviar, 5xx con reintentos,
  cancelar, 401 sin reintento), pestaña de subida, flag apagado, clips, puente player.js.
- e2e `frontend/e2e/pizarra-videos-subidos.spec.ts` (en `playwright.pizarra.config.ts`), BFF de videos, servidor tus y
  reproductor mockeados con `page.route`; capturas de escritorio y iPhone.

## 9. Qué tiene que hacer el usuario para prenderlo

1. Crear la cuenta en **bunny.net** (prueba de 14 días sin tarjeta; luego mínimo US$1/mes) → **Stream → Add Video
   Library** «SportMaps». Región de almacenamiento: la más cercana disponible (São Paulo o Miami/NY); **sin**
   replicación al inicio. Resoluciones: 720p, 480p y 360p (1080p solo si se cobra aparte). Desactivar «Keep original
   files» si no se va a ofrecer descarga del original.
2. En la librería: **Security → Embed view token authentication: ON** y copiar la *Token authentication key*;
   **Allowed referrers**: `sportmaps.co`, `*.sportmaps.co`, el dominio de Vercel de staging y `localhost` para pruebas.
   Dejar apagados el MP4 fallback y las descargas (si el panel los ofrece).
3. **API**: copiar el *Library ID*, la *API Key* y la *Read-only API Key*.
4. **Webhook**: URL `https://<bff>/api/v1/webhooks/video/bunny` (en cada BFF: prod, stg, dev).
5. Variables en Render (los 3 BFF), nunca en el repo:
   `VIDEO_PROVIDER=bunny`, `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_READONLY_API_KEY`,
   `BUNNY_STREAM_TOKEN_KEY`; opcionales `BUNNY_STREAM_EMBED_BASE`, `VIDEO_UPLOAD_MAX_BYTES` (4 GB),
   `VIDEO_UPLOAD_MAX_DURATION_S` (10800), `VIDEO_PLAYBACK_TTL_S` (900), `VIDEO_UPLOADS_PER_MINUTE` (10).
   Una librería por ambiente (o al menos una aparte para dev) para no mezclar videos de prueba con los reales.
6. Aplicar la migración `20261015171131` (una sola sesión; ver CLAUDE.md «Disk IO»), luego
   `npm run seguridad:invariantes` y `npm run seguridad:rls-pizarra`.
7. Prender una escuela piloto: `select public.set_school_video_settings('<school_id>', true);` como super admin.
   Hacer una subida real y confirmar en Bunny los campos `status`, `length` y `storageSize` (§3, riesgos).
8. Que la escuela piloto confirme que su autorización de datos al inscribir cubre «grabación de entrenamientos y
   partidos para análisis técnico interno del cuerpo técnico». Texto sugerido para agregar:
   *«Autorizo a [escuela] a grabar en video los entrenamientos y partidos en los que participa el menor que represento,
   con la única finalidad de análisis técnico por parte del cuerpo técnico. Los videos se almacenan con un
   proveedor fuera de Colombia, no se publican ni se comparten con terceros, y puedo pedir su supresión en cualquier
   momento.»* (validarlo con quien lleve lo legal.)
