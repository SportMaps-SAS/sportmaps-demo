# Video de partidos con Bunny Stream: grabación, clips por deportista y en vivo

> 2026-11-26. Spec de **PAR-2** (VID-1, VID-2, VID-4, VID-5, VID-6) y **PAR-3** (a, b, c = VID-3) de
> [`plan-paridad-y-v2-2026-11.md`](../plan-paridad-y-v2-2026-11.md). Continúa
> [`pizarra-m6h-videos-subidos.md`](pizarra-m6h-videos-subidos.md) (M6h, subida a Bunny ya construida detrás de
> flag) y la sección «VID — Video de partidos» de [`ROADMAP.md`](../ROADMAP.md).
> Estado: **spec para aprobar. Sin código ni migraciones.** Plan antes de código: ninguna migración de este spec se
> escribe hasta que el usuario apruebe las decisiones de §2.

**Decisiones del usuario que este spec da por cerradas (2026-11-26):**

- **D-VIDEO-1 → Bunny Stream es el proveedor único:** subida, clips, VOD y en vivo. Se reutiliza
  `bff/src/services/video/bunny.ts` y la interfaz `VideoProvider`.
- **D-IMAGEN (VID-6) → el club entero ve el partido** (staff y familias del equipo), con un consentimiento de imagen
  que cada acudiente acepta una vez. **Al deportista sin consentimiento no se le etiqueta en clips.**

**Sigue abierta:** **D-VIDEO-2** (retención y precio, VID-5). §9 trae el modelo de costo y tres opciones.

---

## 0. En una línea

Cada partido (del club o de torneo) puede tener **una o más grabaciones**:

- primero como **enlace** a Veo o YouTube (VID-1, sin costo);
- después como **video propio en Bunny** (VID-2), subido directo desde el navegador o grabado del en vivo (VID-3).

Sobre ese video se marcan **clips virtuales etiquetados por deportista y tipo de jugada** (VID-4). Los clips llegan a
la ficha técnica, al Informe Mensual y a la vista de la familia, solo para deportistas con consentimiento vigente.
Nada se reproduce sin un token firmado de vida corta, que emite el BFF después de verificar el permiso.

## 1. Qué existe hoy (leído en el repo el 2026-11-26)

| Pieza | Dónde | Estado | Qué aporta a este spec |
|---|---|---|---|
| Adaptador Bunny | `bff/src/services/video/{types,bunny,index,policy,db}.ts` | Construido y probado con HTTP falso; **sin llaves** | `createUpload` (tus con `AuthorizationSignature`), `getPlaybackUrl` (token de embed `sha256(token_key + video_id + expires)`), `getAsset`, `deleteAsset`, `webhook.verify` (HMAC-SHA256 del cuerpo crudo con la API key de solo lectura) y `parse`. `policy.clampTtl`: 15 min por defecto, entre 1 min y 6 h |
| Tablas M6h | `20261015171131_pizarra_videos_subidos.sql` | **Aplicada** (verificado 2026-11-23, sin fila en `schema_migrations`) | `school_video_settings` (flag + cupo en segundos y bytes, `FOR UPDATE`), `school_videos` (asset: `provider`, `provider_asset_id`, `status`, `source`, `team_id`, `consent_scope` bloqueado en `'staff'` por CHECK), `school_video_clips` (`start_s`/`end_s`, una jugada opcional). Además las RPCs `begin_school_video_upload`, `attach_…`, `settle_…` (solo `service_role`, idempotente), `soft_delete_…`, `set_school_video_settings` y `expire_stale_…` |
| Rutas BFF | `bff/src/routes/school/videos.ts`, `POST /api/v1/webhooks/video/:provider` | Construidas | Subida, sincronización, reproducción, clips y webhook sobre `req.rawBody` |
| UI de videos | `frontend/src/components/school/schoolVideos/*` (`UploadVideoTab`, `VideoLibraryTab`, `VideoClipsPlayer`, `ImportGuideTab`, `SchoolVideosDialog`) | Construida, se monta desde la pizarra | Cliente tus reanudable, reproductor con player.js («Marcar inicio/fin») y la guía «Importar de Veo, Hudl…» |
| Partido del club | `match_results` (ampliada por la F1 de partidos: `school_id`, `status`, `tournament_match_id`…), `match_lineups`/`match_lineup_players` (`subject_type` + `subject_id`), `football_match_events` | En producción | El partido al que se cuelga la grabación y los convocados, que son los candidatos a etiquetar |
| Partido en vivo | `/partido-en-vivo/:matchId` (`PartidoEnVivoPage`, solo staff/coach), `match_live`, `match_live_periods`, `match_live_events`, `school_settings.live_match_enabled` (default `false`, encendido por migración solo en las escuelas demo) | En producción, apagado en clientes | El reloj y los eventos con minuto. Sirven para (a) el marcador encima del video y (b) sugerir clips automáticamente |
| Torneos en vivo | `events.stream_url`, `tournament_matches.stream_url`, `LiveSettingsPanel.tsx` + `validateStreamUrl` (https; solo YouTube, Facebook, Vimeo o Veo) | En producción | El patrón de enlace de transmisión (link-out) que se copia al partido del club |
| Consentimiento | `clinical_consent_texts` + `clinical_consents` (`20261006094147`) | En producción (profesionales de salud) | El patrón a copiar: texto versionado, foto del texto aceptado, parentesco, canal y revocación |
| Informe Mensual | `bff/src/services/report-snapshot.service.ts` (snapshot congelado, `athlete: {subject_type, subject_id}`) | En producción | Ahí entran los clips del mes (campo aditivo) |

**Lo que no existe:** grabación por partido, enlace de grabación en el partido del club, clips por deportista,
consentimiento de imagen y cualquier forma de que una familia vea video.

## 2. Decisiones (numeradas, con recomendación)

Leyenda: 🟢 recomendación lista para aprobar · 🟡 necesita el visto del usuario · 🔴 bloquea una fase.

### Modelo de datos

**V-1 · `recordings` no duplica a `school_videos`: la envuelve.** 🟢
`school_videos` sigue siendo **la única tabla de assets en Bunny**, con su cupo, su webhook y su `settle`. No se
crea otra tabla de assets ni se migran filas. `recordings` es la entidad de dominio: **«la grabación de este
partido»**. Apunta a un asset de Bunny (`video_id → school_videos.id`) o a un enlace externo.
- *Por qué no renombrar `school_videos` a `recordings`:* la tabla está viva, su `id` ya es el `asset_id` que usa la
  pizarra M6c (`provider: 'sportmaps'`), y la usan 9 funciones, las rutas y el frontend. Renombrar rompe todo eso
  sin ganar nada.
- *Por qué no colgar el partido directo de `school_videos`:* el enlace de Veo o YouTube (VID-1) no es un asset, y un
  partido puede tener varias grabaciones (cámara Veo + celular del coach, primer y segundo tiempo).

**V-2 · `recordings.provider ∈ ('bunny','veo','youtube','link')`.** 🟡
El ROADMAP proponía `veo | upload | rtmp | youtube`. En este spec, «upload» y «rtmp» no son proveedores sino
**orígenes de un asset en Bunny**:
- el origen de lo subido queda en `school_videos.source` (`phone`, `veo`, `hudl`…);
- lo del en vivo queda en `recordings.kind = 'live'`.

Valores:

| `provider` | Qué es | Cómo se ve |
|---|---|---|
| `bunny` | Asset propio | Reproductor embebido con token |
| `veo` | Enlace al Clubhouse | Link-out: Veo no permite incrustar |
| `youtube` | Enlace | Link-out. No se incrusta, para no depender de que el video sea «no listado» |
| `link` | Otro dominio de la lista de `validateStreamUrl` (Facebook, Vimeo) | Link-out |

Con `text + CHECK` (regla del repo) se agrega `pixellot`, `spiideo` u otro sin rehacer el modelo.

**V-3 · Forma de `recordings`.** 🟢 (el DDL real va en el plan de F1)

```
recordings
  id uuid PK
  school_id uuid NOT NULL → schools            -- dueña (el club; en torneo, la escuela organizadora)
  team_id uuid → teams                          -- equipo grabado (alcance de las familias)
  match_id uuid → match_results ON DELETE SET NULL
  tournament_match_id uuid → tournament_matches ON DELETE SET NULL
  CHECK num_nonnulls(match_id, tournament_match_id) = 1 (v1: toda grabación es de un partido; sesiones = fase posterior)
  provider text CHECK (provider IN ('bunny','veo','youtube','link'))
  kind text CHECK (kind IN ('upload','live','link'))
  video_id uuid UNIQUE → school_videos(id)      -- obligatorio si provider='bunny', NULL si no (CHECK)
  external_url text                             -- obligatorio si provider≠'bunny'; https + lista de hosts (mismo criterio que validateStreamUrl, repetido en un CHECK/trigger)
  title text, part_label text ('1T','2T','completo'…), recorded_offset_s integer  -- desfase video↔reloj del partido (V-15)
  visibility text CHECK (visibility IN ('staff','team')) DEFAULT 'staff'
  live_status text CHECK (live_status IN ('idle','live','ended')) NULL   -- solo kind='live'
  keep_until date                               -- retención (§9); NULL = política de la escuela
  created_by → profiles, created_at, updated_at, deleted_at, deleted_by
```

Si el partido del club está enlazado a un partido de torneo (`match_results.tournament_match_id`, D12 de partidos),
la grabación se cuelga del `match_results`. Así no hay dos grabaciones del mismo juego.

**V-4 · Los clips: se amplía `school_video_clips` y se crea una tabla de etiquetas. No hay `recording_clips`
nueva.** 🟡
El clip ya es **virtual** sobre el asset (`start_s`/`end_s`, sin crear otro video en Bunny). Eso es justo lo que
pide VID-4, así que tener dos tablas de clips sería duplicar. Cambios:
- `school_video_clips` gana `recording_id` (nullable: los clips de la pizarra no son de partido) y `visibility`
  (`staff` | `team`).
- Tabla nueva **`video_clip_tags`**: `clip_id`, `school_id`, `subject_type` (`profile` | `child` | `unregistered`,
  el patrón de `match_lineup_players`), `subject_id`, `play_type` y `tagged_by`, con
  `UNIQUE(clip_id, subject_type, subject_id, play_type)`.
- *Por qué una tabla de etiquetas y no `athlete_id` en el clip:* un gol tiene goleador y asistidor, y una jugada
  defensiva tiene varios defensores. La regla de consentimiento («se comparte si **todos** los etiquetados
  consienten») necesita la lista completa.
- Si el usuario prefiere el nombre `recording_clips`, se crea una **vista** con ese nombre sobre
  `school_video_clips WHERE recording_id IS NOT NULL`. No es una tabla.

Los clips de un enlace externo (Veo, YouTube) **no existen en v1**: no hay reproductor embebido para marcar inicio y
fin. Para etiquetar, primero se descarga el MP4 de Veo y se sube (el camino de M6h).

**V-5 · Tipos de jugada por deporte: catálogo en datos, no en un CHECK.** 🟢
Tabla `video_play_types` (`sport_key`, `key`, `label_es`, `orden`, `positive boolean`), sembrada por deporte. La
escuela puede **ocultar** tipos, pero no crearlos en v1. Semilla inicial:

| Deporte | Tipos |
|---|---|
| Fútbol | gol, asistencia, remate al arco, atajada, recuperación, duelo ganado, pase clave, regate, error, falta, tarjeta |
| Baloncesto | canasta (2/3), tiro libre, asistencia, rebote, robo, tapón, pérdida, falta |
| Voleibol | punto de ataque, bloqueo, ace, recepción, defensa, error de saque |
| Genérico (cualquier otro deporte) | jugada destacada, acción defensiva, error, para corregir |

`play_type` en `video_clip_tags` se valida con una FK compuesta a `(sport_key, key)` o con un trigger contra el
deporte del equipo. Los tipos de `football_match_events.type` (`goal`, `assist`, `yellow`…) se **mapean** a este
catálogo para la sugerencia automática (V-15).

### Acceso

**V-6 · RLS de dos capas.** 🟢
- **Capa 1, la RLS:** decide **quién sabe que la grabación existe**. Lee `recordings`, `school_video_clips` y
  `video_clip_tags`.
- **Capa 2, el BFF:** decide **quién reproduce**. Firma el token después de volver a verificar el permiso con una
  RPC.

Que una fila sea visible **no** basta para reproducir.

| Quién | `recordings` (existe) | Reproducir el partido completo | Clips |
|---|---|---|---|
| Staff de la escuela (`user_staff_school_ids()`) | Todas las de su escuela | Sí | Todos |
| Familia o atleta del equipo (`calendar_family_team_ids()` ∋ `team_id`) | Las de su equipo con `visibility = 'team'` | Sí, **si el acudiente aceptó el consentimiento de imagen** de al menos un hijo en ese equipo (V-9) | Solo clips `visibility = 'team'` cuyos etiquetados tienen **todos** el consentimiento vigente. El atleta adulto con cuenta: igual, por su propio consentimiento |
| Acudiente sin cuenta, con enlace de WhatsApp | Nada por RLS | Solo por la RPC con token (V-8) | Solo los clips de **su** hijo, con consentimiento vigente |
| `anon` | Nada | Nada | Nada |
| Super admin | Todas | Sí (soporte) | Todos |

Escritura:
- Crear, editar y borrar grabaciones, clips y etiquetas: `user_tactical_edit_school_ids()`, igual que M6h (coach y
  admin).
- Pasar una grabación a `visibility = 'team'`: `user_staff_school_ids()`.
- El borrado lo hace la RPC (lógico), nunca un `DELETE` directo.
- Sin `FOR ALL`. Todo `WITH CHECK`. Helpers envueltos `(SELECT …)` con `::uuid[]`.

**V-7 · Reproducción con token firmado de vida corta, emitido solo por el BFF.** 🟢
Ruta: `GET /api/v1/recordings/:id/playback?clip=<clipId>`.
1. Llama con la **sesión del usuario** a la RPC `can_play_recording(p_recording, p_clip)` (`SECURITY DEFINER`, valida
   el alcance adentro).
2. Si da verdadero, `provider.getPlaybackUrl(asset, { ttlS, startS })`.

Condiciones:
- TTL: 15 min por defecto. El reproductor pide uno nuevo antes de que venza (techo de 6 h, como `clampTtl`).
- `Cache-Control: no-store`.
- Para un clip se usan `startS` y un tope de fin que controla el reproductor (player.js `setCurrentTime` +
  `timeupdate` → pausa en `end_s`).
- **Riesgo aceptado:** quien tiene el token del clip puede adelantar al resto del partido en ese reproductor. Para la
  familia se mitiga con lo siguiente: solo recibe tokens de grabaciones que ya podía ver completas (V-6), y si solo
  tiene derecho a los clips (el acudiente sin cuenta), el token dura `end_s - start_s + 2 min`. El cierre de verdad
  es materializar el clip como asset propio, que queda como fase posterior (§12).
- Para enlaces externos (`veo`, `youtube`, `link`) **no hay token**. El BFF devuelve la URL a quien pasa la capa 1,
  y su privacidad depende del proveedor externo. La UI lo dice así: «Este enlace lo controla Veo».

Requisitos en Bunny (acción humana, §11):
- «Embed view token authentication» encendido.
- *Allowed referrers* limitados a los dominios de SportMaps.
- MP4 fallback y descargas apagados.
- Miniaturas solo firmadas (en v1 la UI muestra una tarjeta genérica, nunca un fotograma de un menor sin firmar).

**V-8 · Acudiente sin cuenta: RPC `SECURITY DEFINER` con token, nunca una policy `USING(true)`.** 🟢
Mismo patrón que la trampa 5 de CLAUDE.md y `informe-atleta-link-publico.md`.
- Tabla `recording_share_tokens`: `token_hash` (sha256), `school_id`, `subject_type`/`subject_id`, `scope`
  (`clips_of_subject` | `recording`), `recording_id` (nullable), `expires_at` (7 días por defecto), `revoked_at` y
  `created_by`. El token se guarda **hasheado**.
- RPC `resolve_recording_share(p_token text)` → devuelve la lista de clips o grabaciones permitidas, **revalidando el
  consentimiento en cada llamada**. `GRANT EXECUTE` a `anon` **solo** porque existe una pantalla pública demostrada
  (`/v/:token`), y queda anotado como excepción justificada. Nunca devuelve `provider_asset_id`.
- El BFF expone `GET /api/v1/public/recording-share/:token/playback?clip=` con un límite de tasa por IP (Render tras
  Cloudflare: usar la IP real, ver memoria `project_render_cloudflare_req_ip`). Resuelve con la RPC y firma con TTL
  corto.
- Enviar el enlace lo hace el staff («Enviar clips por WhatsApp»), por el Despachador Unificado. **Nunca de forma
  automática por heurística.**

### Consentimiento de imagen (VID-6)

**V-9 · Modelo: textos versionados y consentimiento por deportista, otorgado por el acudiente.** 🟢
Copia el patrón clínico.
- `media_consent_texts` (`version` PK, `title`, `body`, `is_current` único, `created_at`). El texto es **de
  plataforma** en v1, con el nombre de la escuela interpolado. En una fase posterior se admite una versión propia de
  la escuela.
- `athlete_media_consents`:
  - quién: `id`, `school_id`, `subject_type`/`subject_id`, `version` → texto, `text_snapshot`;
  - quién otorga: `granted_by_profile_id` (nullable si es por WhatsApp sin cuenta), `granted_by_name`,
    `relationship` (`titular` | `madre` | `padre` | `acudiente` | `representante_legal`);
  - cómo: `channel` (`app` | `whatsapp` | `presencial_firma`), `evidence` (jsonb: id del mensaje de WhatsApp o ruta
    del documento firmado), `granted_at`;
  - revocación: `revoked_at`, `revoked_by`, `revoked_reason`.
  - Índice único parcial: un consentimiento vigente por `(school_id, subject_type, subject_id)`.
- **Alcance:** el consentimiento es **por escuela**. Si el deportista está en dos escuelas, son dos consentimientos.
  Cubre el partido completo y los clips, dentro del club (staff y familias del equipo). **No** cubre publicar fuera
  del club; eso sería otro texto, en otra fase.
- Un atleta **adulto** con cuenta consiente por sí mismo (`relationship = 'titular'`). Para un menor, solo el
  acudiente vinculado (`children.parent_id` o el vínculo vigente que use la escuela).
- Todo se escribe por RPC: `grant_media_consent(p_subject_type, p_subject_id, p_school, p_version)` valida que el
  caller sea el acudiente o el titular, y `revoke_media_consent(…)`. La RLS de lectura deja ver el consentimiento al
  acudiente y al staff de la escuela.

**V-10 · Flujo de aceptación.** 🟡
- **En la app (acudiente con cuenta):** la primera vez que la escuela tiene video encendido y el acudiente abre
  Inicio o «Mis hijos», aparece una tarjeta «Videos de los partidos de {escuela}» con el texto completo y dos botones,
  «Acepto» y «Ahora no». Es una tarjeta, **no un modal que bloquee**: el Decreto 1377 art. 6 prohíbe condicionar la
  actividad a entregar el dato. «Ahora no» la vuelve a mostrar a los 30 días, máximo tres veces. Si hay varios hijos
  en la escuela, se acepta por cada uno, con casillas **desmarcadas** por defecto (no hay
  opt-in implícito).
- **Por WhatsApp (acudiente sin cuenta o que no abre la app):** plantilla aprobada por Meta con botón de URL que
  lleva a `/consentimiento-imagen/:token`, una página pública que muestra el texto y pide nombre y parentesco. Se
  resuelve con una RPC `SECURITY DEFINER` con token (mismo patrón que V-8). **No se acepta un «sí» escrito en el
  chat** como consentimiento: se necesita el texto que se mostró y la versión. El envío lo dispara el staff desde
  «Consentimientos de imagen» (lote por equipo); el bot no lo manda solo.
- **Presencial:** el staff marca «firmado en papel», sube la foto del documento y queda `channel =
  'presencial_firma'`.
- **Panel del staff:** por equipo, quién aceptó, quién no y quién revocó, con el botón «Pedir por WhatsApp».

**V-11 · Efecto del consentimiento.** 🟢
| Situación | Partido completo (`visibility = 'team'`) | Etiquetar en clips | Clips que ve la familia |
|---|---|---|---|
| Consentimiento vigente | La familia lo ve | Sí | Los suyos y los de otros con todos los etiquetados consentidos |
| Sin consentimiento | La familia **no** lo ve (ve la tarjeta para aceptar) | **No:** la RPC `tag_clip` rechaza y la UI muestra al deportista deshabilitado con «sin autorización de imagen». El staff igual puede crear el clip **sin etiquetarlo**, y ese clip queda `staff` | — |
| Revocado | Se oculta **al instante** para esa familia (la capa 2 revalida en cada token) | Las etiquetas existentes se **borran** (no se ocultan) y los clips donde estaba vuelven a `staff` si quedan sin etiquetados válidos | Desaparece del Informe Mensual **siguiente**. El ya congelado no se reescribe, pero el reproductor del informe pasa por la capa 2 y no reproduce |

Un deportista sin consentimiento **aparece igual en el partido completo** que ven otras familias que sí
consintieron: es la decisión D-IMAGEN («el club entero ve el partido»). El texto del consentimiento lo explica así:
«Su hijo puede aparecer en el video de los partidos de su equipo, que ven el cuerpo técnico y las familias del
equipo». Lo que protege la falta de consentimiento es **no ser etiquetado** (no ser identificable por nombre), y que
la familia sin consentimiento no reciba el video.
🟡 **Para confirmar con quien lleve lo legal:** si una grabación compartida al equipo exige que **todos** los
convocados tengan consentimiento. Opción estricta: la grabación solo pasa a `team` con el 100 % de los convocados
consentidos. Opción de D-IMAGEN, recomendada: el que no consiente sigue en el plano general, sin etiqueta. El spec
implementa la de D-IMAGEN y deja un ajuste por escuela, `school_video_settings.require_full_consent_to_share`
(default `false`), para la escuela que quiera la estricta.

**V-12 · La regla de compartir vive en la base, no en el frontend.** 🟢
La función `recording_visible_to_family(p_recording, p_uid)` y la equivalente para clips se usan **dentro** de las
policies y dentro de `can_play_recording`. Son helpers de policy, así que **llevan** `GRANT EXECUTE … TO
authenticated` (CLAUDE.md: «Helpers: dos casos»).

### Integraciones

**V-13 · Clips en la ficha técnica (PAR-1), el Informe Mensual y la vista de la familia.** 🟢
- **Ficha técnica:** sección «Video» en la página 2, con los últimos 6 clips del deportista, agrupados por tipo y
  con el contador por tipo («4 goles, 7 recuperaciones»). En el PDF van **un QR por clip** que abre la app con sesión
  y el conteo, nunca un fotograma.
- **Informe Mensual:** campo aditivo `video_clips` en `ReportSnapshot`, con hasta 5 clips del mes (id, tipo,
  partido, fecha). Solo se guardan los ids; la reproducción pasa por la capa 2 al abrir. Informes ya publicados: sin
  el campo.
- **Familia (Acudiente V2):** en la ficha del hijo, la pestaña «Videos» muestra sus clips y los partidos del equipo
  con «Ver partido». Si falta el consentimiento, aparece la tarjeta de V-10 en lugar de la lista.
- **Perfil del deportista (staff):** la misma lista, con filtro por tipo.

**V-14 · Subida directa navegador → Bunny.** 🟢
Es la de M6h sin cambios:
1. `POST /school/videos/uploads` reserva el cupo y crea el asset.
2. Devuelve `endpoint` tus + `AuthorizationSignature` + `AuthorizationExpire` (de un uso, con vencimiento).
3. El navegador sube por trozos y reanuda.

Para partidos se agrega solo `POST /api/v1/recordings` con `{ match_id | tournament_match_id, video_id | external_url,
… }`, que crea la fila de `recordings`. El video **nunca** pasa por el BFF ni por Supabase Storage.

**V-15 · Sugerencia automática de clips desde el partido en vivo.** 🟢
Si el partido se registró con `/partido-en-vivo` (`match_live_events` tiene minuto y segundo del reloj) y la
grabación tiene `recorded_offset_s` (el staff lo fija una vez: «el pitazo inicial está en el 00:42 del video»), la
UI propone un clip por gol, tarjeta o cambio en `[t - 15 s, t + 10 s]`, con el deportista ya etiquetado si tiene
consentimiento. El staff acepta o descarta; **nada se crea sin un clic**.

**V-16 · Webhook de codificación: firma, relectura e idempotencia.** 🟢
Es el de M6h:
- Firma `X-BunnyStream-Signature` sobre `req.rawBody` (HMAC-SHA256 con la API key de solo lectura, comparación en
  tiempo constante).
- El payload solo **sugiere**: el BFF relee `getAsset` y llama `settle_school_video`, que es idempotente.
- Se agrega una tabla `video_webhook_events` (`provider`, `dedupe_key = sha256(raw_body)`, `received_at`,
  `processed_at`, `result`) con `UNIQUE(provider, dedupe_key)`. Un duplicado responde 200 sin reprocesar, y queda
  traza para soporte.
- Firma inválida → 401 y se registra (sin el cuerpo).
- El webhook **no trae timestamp**, así que un reenvío viejo no puede cambiar nada: el estado sale del API, no del
  payload.

**V-17 · `stream_url` también en el partido del club (PAR-3b).** 🟢
Columna `match_results.stream_url text`, validada igual que `validateStreamUrl` (https y lista de hosts), más un CHECK
de forma en la base (`^https://`). Se edita en `PartidoFlujo` (paso «programar» y en el detalle). La familia ve
«Ver transmisión» (link-out) en la tarjeta del partido del calendario. No guarda video, así que **no depende del
consentimiento**: es lo que ya existe en torneos.

**V-18 · Encendido de `live_match_enabled` por escuela (PAR-3a).** 🟢
Hoy solo se enciende por migración (las escuelas demo). Se crea la RPC `set_school_live_match(p_school uuid,
p_enabled boolean)`:
- `SECURITY DEFINER`, solo `is_super_admin()` o `service_role`;
- `REVOKE ALL` de `PUBLIC` y `anon`; `GRANT EXECUTE` a `authenticated` (la llama el panel de `/admin`), con el gate de super admin ADENTRO;
- se registra en el log de auditoría.

Interruptor en `/admin` → escuela. Sin migración por cliente.

**V-19 · En vivo (VID-3): Bunny Stream Live si existe; si no, RTMP propio hacia Bunny.** 🔴 hasta verificar
**No se pudo verificar** (2026-11-26) que Bunny Stream tenga un producto de en vivo con ingest RTMP/SRT documentado y
con precio público:
- bunny.net/pricing/stream y la página de precios de la documentación (`bunny.net/docs/stream/pricing.md`) solo traen
  VOD;
- la URL de documentación de live streaming devuelve 404 o no lo menciona;
- fuentes de terceros se contradicen.

Por eso:
1. **Gate F5-0 (acción humana):** con la cuenta creada, revisar en el panel de Bunny si la librería ofrece «Live» o
   «Live input», y pedirle a soporte el precio y la latencia. Si existe: el BFF crea un *live input* por equipo
   (método nuevo `createLiveInput` en la interfaz `VideoProvider`) y devuelve RTMP URL + stream key. El club los
   pega **una sola vez** en Veo Live como destino *Custom*. El webhook de conexión pone `recordings.live_status =
   'live'` y dispara el push a las familias **con consentimiento** del equipo (Despachador Unificado). Al terminar,
   la misma fila queda como VOD.
2. **Si Bunny no tiene en vivo:** se mantiene Bunny para todo lo demás, y el en vivo va por una de estas dos vías, a
   decidir entonces (🟡):
   - **(a) Link-out:** el club transmite desde Veo Live a su YouTube o Facebook y pega el enlace en `stream_url`
     (V-17). Sale ya, sin costo. Si quiere grabación propia, sube el MP4 después.
   - **(b) Ingest propio:** un servidor RTMP→HLS (por ejemplo MediaMTX) en una máquina con TCP 1935 abierto. **No
     puede ser Render**: sus web services solo exponen HTTP. Escribe los segmentos a Bunny Storage + CDN con token
     auth. Suma un servicio que operar; no se recomienda antes de tener un club que lo pague.
   - Cloudflare Stream Live queda **descartado**, salvo que el usuario reabra D-VIDEO-1.
3. **Marcador de SportMaps encima:** la página `/partido/:matchId/ver` (familia y staff) monta el reproductor y, sobre
   él, una capa HTML con el marcador y el reloj de `match_live` (lectura por RPC `match_live_public_state(p_match)`
   que valida a la familia del equipo). **No se quema en el video:** es una capa del navegador, así que funciona
   igual con el VOD (el reloj se sincroniza con `recorded_offset_s`) y no cuesta codificación.
4. Latencia esperada RTMP→HLS: 10–30 s. La UI lo dice («la transmisión va unos segundos atrás del marcador»), y el
   marcador puede ir **adelante** del video. Se ofrece «sincronizar marcador con el video» (retrasa la capa N
   segundos).
5. Precondiciones por club: plan de Veo que incluya Veo Live, y red en la cancha. Se confirman **antes** de prometer.

### Cupos y alertas

**V-20 · Cupos por plan en `school_video_settings`.** 🟡
Se reutilizan `quota_seconds`, `quota_bytes`, `max_upload_bytes` y `max_duration_s`. Se agregan:
- `retention_days_full` (partido completo) y `retention_days_clips` (ver §9: los clips viven mientras viva el asset);
- `monthly_delivery_gb_soft` (tope blando de entrega);
- `plan_key` (`video_basico` | `video_club` | `incluido`).

El cupo **guardado** se mide en horas, porque es lo que entiende la escuela. La entrega se mide en GB por mes a
partir de las estadísticas de Bunny (`GET /library/{id}/statistics`, campos a verificar con la primera cuenta) en un
cron **diario** que lee **un lote** (sin N+1, CLAUDE.md «Disk IO») y escribe `school_video_usage_daily` (`school_id`,
`day`, `stored_bytes`, `stored_seconds`, `delivered_bytes`, `plays`).
⚠️ Bunny reporta las estadísticas por librería, no por escuela. Para atribuir la entrega hay dos caminos: (a) una
librería por escuela (Bunny lo permite; aísla y mide, pero hay que crear librerías por API), o (b) estimar por
`plays × duración × bitrate` desde nuestros propios tokens emitidos. Recomendación: **(b) en v1** (se cuenta cada
token emitido, con su duración y la rendición asumida) y **(a)** cuando haya más de 20 escuelas o un club que exija
su propia librería.

**V-21 · Alertas de consumo.** 🟢
- A la escuela (staff admin): aviso en la app y por correo al 80 % y al 100 % del cupo guardado. Al 100 % **se
  bloquean subidas nuevas**; nunca se borra nada solo. Antes de que una grabación cumpla su retención, aviso a 14 y
  3 días con «Conservar» (consume cupo) o «Descargar resumen de clips» (fase posterior).
- A SportMaps (super admin): alerta diaria si la proyección del mes en Bunny supera el umbral `VIDEO_MONTHLY_BUDGET_USD`
  o si una escuela entrega más de 3 veces su promedio (un enlace filtrado).
- El cron de retención (borra en Bunny y marca `deleted`) corre **diario**, por lotes, y respeta `keep_until`.

## 3. Arquitectura

```
Navegador (staff) ──tus directo──────────────▶ Bunny Stream (librería por ambiente)
     │  1. POST /school/videos/uploads (reserva cupo, firma tus de un uso)      │
     │  2. POST /api/v1/recordings (cuelga el asset del partido)                │ webhook firmado
     ▼                                                                         ▼
   BFF (Render) ──RPC con la sesión del usuario──▶ Supabase   ◀── settle_school_video (service_role, idempotente)
     │  GET /recordings/:id/playback → can_play_recording() → token sha256, TTL corto
     ▼
Navegador (familia) ── iframe player.mediadelivery.net?token&expires ──▶ Bunny CDN
     + capa HTML con el marcador (match_live_public_state)
Acudiente sin cuenta: /v/:token → resolve_recording_share() (SECURITY DEFINER) → BFF firma
```

Variables nuevas (además de las de M6h, §9 de ese spec): `VIDEO_MONTHLY_BUDGET_USD`, `VIDEO_SHARE_TOKEN_TTL_DAYS`
(7), `VIDEO_PUBLIC_PLAYS_PER_MINUTE` (límite por IP) y, si existe el en vivo, `BUNNY_STREAM_LIVE_*` (nombres a fijar
cuando se vea el API).

## 4. Migraciones previstas (una sola sesión las aplica, en orden; `types.ts` al final del lote)

| # | Contenido | Fase |
|---|---|---|
| M1 | `match_results.stream_url` + CHECK; RPC `set_school_live_match` | F0 |
| M2 | `recordings` (solo `provider ≠ 'bunny'` permitido por CHECK temporal) + RLS staff/equipo + `create_recording`/`soft_delete_recording` | F1 |
| M3 | `media_consent_texts` + `athlete_media_consents` + `grant/revoke_media_consent` + `media_consent_requests` (tokens de WhatsApp, hasheados) + `resolve_media_consent_request` | F2 |
| M4 | Se levanta el CHECK temporal (`provider = 'bunny'` con `video_id`); `can_play_recording`; `recording_visible_to_family`; `video_webhook_events`; `school_video_clips.recording_id` + `visibility`. **Se reemplaza** `school_videos_consent_phase1_check` por la regla de M4 (sin editar la migración vieja: migración nueva) | F3 |
| M5 | `video_play_types` (semilla) + `video_clip_tags` + `tag_clip`/`untag_clip` (rechaza sin consentimiento) + trigger de revocación → borra etiquetas | F4 |
| M6 | `recording_share_tokens` + `resolve_recording_share` (GRANT a `anon` justificado) | F4 |
| M7 | Cupos/retención/plan en `school_video_settings` + `school_video_usage_daily` | F6 |
| M8 | Columnas de en vivo (`live_status`, `live_input_id`) + `match_live_public_state` | F5 |

Cada una se crea con `npm run migrations:new -- <slug>`, `SET search_path = pg_catalog, public, pg_temp`, GRANT
explícito por RPC y `REVOKE` explícito de `anon`/`authenticated` donde no aplica. Después de aplicar:
`npm run seguridad:invariantes` y las pruebas de RLS de §7.

## 5. Fases

| Fase | Qué | Criterio de salida | Depende de |
|---|---|---|---|
| **F0 · Transmisión por enlace y flag** (PAR-3a/b) | M1; `stream_url` en `PartidoFlujo` y en la tarjeta del calendario; interruptor `live_match_enabled` en `/admin` | Un partido del club con enlace de YouTube o Veo lo abre la familia desde el calendario; un super admin enciende el partido en vivo de una escuela sin migración; `seguridad:invariantes` sin críticas | — |
| **F1 · VID-1 enlace de grabación** | M2; «Agregar grabación (enlace)» en el partido del club y en el de torneo; «Ver grabación» (link-out) para staff y, con `visibility = 'team'`, para la familia | Un staff pega el enlace de Veo, la familia del equipo lo ve y la de otro equipo no (prueba RLS); cero costo de Bunny | F0 |
| **F2 · Consentimiento de imagen** (VID-6) | M3; tarjeta en la app del acudiente (V1 y V2); página pública por token; plantilla de WhatsApp; panel del staff por equipo | Un acudiente acepta en la app y otro por WhatsApp; ambos quedan con versión, texto y canal; revocar funciona; el texto lo aprobó quien lleve lo legal | **texto legal aprobado** 🔴 |
| **F3 · VID-2 VOD propio** | M4; subir el video del partido (reutiliza `UploadVideoTab`) y colgarlo; reproductor con token para el staff y para la familia con consentimiento; webhook con deduplicación | Subida real de un MP4 de Veo de 90' en la librería de **dev**; `status`, `length` y `storageSize` verificados contra el API real; token que vence a los N s probado; familia sin consentimiento → 403 | F2 + cuenta Bunny 🔴 |
| **F4 · VID-4 clips por deportista** | M5, M6; etiquetado por tipo y deporte; sugerencia desde `match_live_events` (V-15); clips en ficha técnica, Informe Mensual, Acudiente V2 y perfil; «Enviar clips por WhatsApp» con token | Un clip con un deportista sin consentimiento no se puede etiquetar; revocar borra etiquetas y corta la reproducción en el acto; el Informe Mensual siguiente trae los clips | F3, PAR-1 (para la sección de la ficha) |
| **F5 · VID-3 en vivo** | F5-0 (verificar Bunny Live); M8; live input por equipo; marcador encima; push «EN VIVO» | Una transmisión de prueba de Veo Live (o de OBS) a la URL de ingest se ve en `/partido/:id/ver` con el marcador encima, y al terminar queda como VOD en la misma fila | F3 + verificación 🔴 + red en la cancha |
| **F6 · Cupos, retención y cobro** (VID-5) | M7; cron de uso diario y de retención; alertas; integración con adicionales cuando D-VIDEO-2 cierre | Escuela piloto con cupo al 80 % recibe aviso; al 100 % no sube; la retención borra en Bunny y devuelve el cupo; el costo real del mes de la piloto está dentro de ±30 % del modelo de §9 | D-VIDEO-2 |

F1 y F2 pueden ir en paralelo (no comparten tablas). **No se enciende el video de Bunny en ningún cliente real antes
de F2 + F6**: es el gate `G-IMAGEN` del ROADMAP más el costeo de VID-5.

## 6. Pantallas

- **Partido (staff), en `PartidoFlujo` y el detalle del partido:** bloque «Video» con «Agregar grabación» (enlace o
  subir), la lista de grabaciones con su estado y la visibilidad (`Solo cuerpo técnico` / `Equipo y familias`),
  «Marcar clips» y el contador «12 de 18 convocados con autorización de imagen».
- **Marcar clips:** el reproductor de `VideoClipsPlayer` + un panel con las sugerencias del en vivo + un selector de
  deportista (los convocados del partido; los que no tienen consentimiento aparecen deshabilitados con el motivo) +
  el tipo de jugada del deporte del equipo.
- **Familia:** en la tarjeta del partido del calendario, «Ver transmisión» / «Ver partido». En la ficha del hijo,
  «Videos».
- **Página pública `/v/:token`:** solo los clips del hijo, sin el menú de la app, con un aviso de vencimiento.
- **`/admin` → escuela:** interruptores de video y de partido en vivo, cupo, plan y consumo del mes.

## 7. Pruebas

**RLS (script `scripts/rls-pruebas-video-partidos.mjs`, sesiones simuladas con `request.jwt.claims`):**
- Staff de la escuela A ve las grabaciones de A y no las de B. Coach de A no ve las de B aunque sea coach en B con
  otro rol (multirol).
- Familia del equipo X ve las grabaciones `team` de X; no ve las `staff`; no ve las del equipo Y de la misma escuela.
- `anon`: `count(*) = 0` en `recordings`, `school_video_clips`, `video_clip_tags`, `athlete_media_consents` y
  `recording_share_tokens` (`set local role anon`).
- Un padre no puede insertar `recordings`, clips ni etiquetas (WITH CHECK). Un coach no puede insertar un
  consentimiento a nombre de un acudiente.
- Las policies se listan completas por tabla (trampa 1: son permisivas y se suman con OR).

**Tokens:**
- Token de reproducción: con TTL = 60 s, a los 61 s Bunny responde 403 (prueba manual en la librería de dev;
  automática con un reloj falso en el adaptador). Se valida que `clampTtl` no deje pasar 0, negativos ni más de 6 h.
- Token de enlace compartido: vencido → la RPC no devuelve nada; revocado → nada; un token de la escuela A pedido con
  el id de un clip de la escuela B → nada; el token en texto plano nunca está en la base (solo el hash).
- Límite de tasa: 30 pedidos por minuto desde la misma IP a `/public/recording-share` → 429.

**Webhook:**
- Firma válida, inválida, cuerpo alterado, otra llave, cuerpo re-serializado → solo la válida pasa (ya en
  `bunny.test.ts`; se extiende).
- **Duplicado:** el mismo cuerpo dos veces → un solo `settle`, segunda respuesta 200 sin efecto, `used_*` igual.
- **Fuera de orden:** «finished» antes que «processing» → el estado final sale de `getAsset`.
- Webhook de un `provider_asset_id` desconocido → 200, sin efecto, registrado.

**Consentimiento:**
- Sin consentimiento: `tag_clip` rechaza con un código propio; la familia recibe 403 en `playback`.
- **Revocado:** se revoca mientras la familia reproduce → el siguiente pedido de token da 403 (el reproductor deja
  de renovar); las etiquetas del deportista se borran; los clips quedan `staff`; el Informe Mensual siguiente no los
  trae.
- Un acudiente no puede consentir por un deportista que no es suyo; un atleta menor no puede consentir por sí mismo.
- Con `require_full_consent_to_share = true`, una grabación con un convocado sin consentimiento no puede pasar a
  `team`.

**Concurrencia:** 20 `begin_school_video_upload` en paralelo con cupo para 15 → exactamente 15 (ya diseñado en M6h;
se corre una vez al aplicar). Dos `tag_clip` iguales a la vez → una fila (UNIQUE).

**E2E (Playwright, BFF y Bunny mockeados con `page.route`):** staff pega un enlace → la familia lo ve; staff sube →
estado «procesando» → «listo» → reproduce; marca un clip y etiqueta; la familia sin consentimiento ve la tarjeta y,
al aceptar, ve el video.

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Bunny no tiene en vivo (V-19) | Gate F5-0; link-out por `stream_url` mientras tanto |
| Campos del API de Bunny (`status`, `length`, `storageSize`, estadísticas) no verificados | Primera subida real en dev antes de abrir a una escuela (ya anotado en M6h) |
| El token de un clip permite ver el resto del partido | Solo a quien ya tiene derecho al partido; TTL acotado al clip para los enlaces públicos; materializar clips después (§12) |
| Una sola base para dev, stg y prod | Una **librería de Bunny por ambiente**; las filas de prueba en dev apuntan a la librería de dev; el cron de retención filtra por `provider_asset_id` conocido en esa librería |
| Disk IO | Cron diario y por lotes; ninguna consulta por fila; `types.ts` una vez al final del lote de migraciones |
| Un enlace compartido se reenvía | Vence a los 7 días, solo trae los clips de un deportista, se puede revocar y tiene límite por IP; la alerta de V-21 detecta picos de entrega |
| Transferencia internacional de datos (Ley 1581 art. 26) | El texto del consentimiento lo dice expresamente: «se almacena con un proveedor fuera de Colombia» |

## 9. Retención y costo (VID-5 / D-VIDEO-2, abierta)

### 9.1 Precios de Bunny Stream

Consultados el 2026-11-26 en bunny.net/pricing/stream, bunny.net/pricing/cdn y `bunny.net/docs/stream/pricing.md`,
solo páginas públicas y sin credenciales. Hay que **confirmarlos en el panel** al crear la cuenta.

| Concepto | Precio | Nota |
|---|---|---|
| Codificación estándar | **Gratis** | Premium encoding aparte, no se usa |
| Almacenamiento, región por defecto | **US$0,01/GB-mes** | La documentación lista Frankfurt como región por defecto. ⚠️ **Supuesto:** que São Paulo o Miami cuesten lo mismo; confirmar en el panel |
| Replicación, 2.ª región | +US$0,01/GB-mes | No se usa en v1 |
| Entrega, red Standard | Europa y Norteamérica **US$0,01/GB**; Sudamérica **US$0,045/GB** | ⚠️ **Supuesto:** desde qué PoP se atiende a Colombia (Bogotá → tarifa de Sudamérica; Miami → Norteamérica). El modelo usa US$0,045, el peor caso |
| Entrega, red Volume (10 PoPs, tarifa global) | **US$0,005/GB** (primeros 500 TB) | Más barata, con más latencia; se puede elegir por librería. Para VOD de partidos alcanza |
| Mínimo mensual | **US$1** | Prueba de 14 días sin tarjeta |
| DRM empresarial | US$99/mes por librería + licencia | **No se usa**: alcanza el token de embed |
| En vivo | **No publicado** | Ver V-19 |
| Tasa de referencia | COP 4.000 / US$ | ⚠️ **Supuesto**, no cotización |

### 9.2 Supuestos de volumen (marcados para confirmar con la escuela piloto)

- Partido de 90' guardado en escalera 720p + 480p + 360p ≈ **2,4 GB/h**, es decir **≈ 3,6 GB por partido** (mismo
  supuesto que M6h). Sin conservar el original.
- Entrega a 720p ≈ **1,35 GB/h**. Cada espectador ve en promedio **30 minutos** por partido (partido salteado +
  clips): ≈ 0,68 GB.
- Clips: virtuales, no suman almacenamiento.

| Escenario | Partidos/mes | Horas nuevas/mes | GB nuevos/mes | Espectadores por partido | GB entregados/mes |
|---|---|---|---|---|---|
| **Pequeña** (2 equipos) | 8 | 12 | 28,8 | 10 | 54 |
| **Mediana** (4 equipos) | 16 | 24 | 57,6 | 15 | 162 |
| **Grande** (10 equipos, tipo club) | 40 | 60 | 144 | 20 | 540 |

### 9.3 Costo mensual por escuela (US$), en régimen al mes 12

| Escenario | Entrega Standard SA (US$0,045) | Entrega Volume (US$0,005) | Almacenamiento con retención 3 meses | 6 meses | 12 meses (sin borrar) |
|---|---|---|---|---|---|
| Pequeña | 2,43 | 0,27 | 0,86 | 1,73 | 3,46 |
| Mediana | 7,29 | 0,81 | 1,73 | 3,46 | 6,91 |
| Grande | 24,30 | 2,70 | 4,32 | 8,64 | 17,28 |

Total al mes 12 = entrega + almacenamiento:

| Escenario | Retención 3 m, red Volume | Retención 6 m, Standard SA | 12 m, Standard SA (peor caso) |
|---|---|---|---|
| Pequeña | **US$1,13** (≈ COP 4.500) | US$4,16 (≈ COP 16.600) | US$5,89 (≈ COP 23.600) |
| Mediana | **US$2,54** (≈ COP 10.200) | US$10,75 (≈ COP 43.000) | US$14,20 (≈ COP 56.800) |
| Grande | **US$7,02** (≈ COP 28.100) | US$32,94 (≈ COP 131.800) | US$41,58 (≈ COP 166.300) |

Lecturas:
1. **La entrega pesa más que el almacenamiento** si se usa la red Standard hacia Sudamérica. Elegir la red
   **Volume** baja el costo de 3 a 9 veces. Recomendación: Volume, y medir la experiencia en la piloto.
2. El almacenamiento **se acumula**: sin retención, al mes 12 la escuela mediana guarda 691 GB. La retención es una
   decisión de producto.
3. Al ser clips virtuales, **los clips mueren con el partido**. Si el producto quiere «clips por 12 meses, partido
   completo por 3», hay que materializar el clip (asset propio en Bunny, unos MB) antes de borrar el partido. Eso es
   la fase posterior de §12; mientras tanto, la retención es la misma para partido y clips, con «Conservar» manual.
4. El en vivo no está costeado (precio no publicado).

### 9.4 Opciones de retención y precio por escuela (D-VIDEO-2, para que decida el usuario)

| | **Opción A · Incluido con tope** | **Opción B · Adicional «Video» por tramos** (recomendada) | **Opción C · Por equipo** |
|---|---|---|---|
| Qué incluye | En el plan Pro o superior: 10 h guardadas (≈ 6 partidos), retención **90 días**, red Volume | **Básico:** 20 h guardadas, retención 6 meses. **Club:** 80 h guardadas, retención 12 meses, «Conservar» ilimitado dentro del cupo. Los dos con enlace/VID-1 gratis para todos | Precio por equipo con video activo al mes: 10 h por equipo, retención 6 meses |
| Precio sugerido (⚠️ a validar con el usuario y con la piloto) | COP 0 (costo absorbido: ≤ US$2,5/mes por escuela mediana) | Básico **COP 49.000/mes**, Club **COP 149.000/mes** | **COP 19.000 por equipo al mes** |
| Costo estimado vs. precio | Absorbido; riesgo si el uso supera los supuestos | Básico ≈ US$2–4 de costo contra US$12 de precio; Club ≈ US$7–33 contra US$37 | Escala con el tamaño del club; difícil de explicar si un equipo comparte cámara |
| A favor | Gancho comercial; cero fricción | El costo se acumula con el uso y el precio lo sigue; coherente con la IA (cupo + paquetes); la escuela sin video no paga | Justo por tamaño |
| En contra | El almacenamiento acumulado es un pasivo que crece sin ingreso | Una decisión más de compra para la escuela | Más caro de operar (contar equipos activos); el cupo por equipo no encaja con `school_video_settings` |

Recomendación: **B**, con VID-1 (enlace) y la transmisión por enlace **gratis en todos los planes**. Con el patrón
`project_incluido_todos_los_planes`, lo que no cuesta no se cobra. El tramo y su precio los decide el usuario
después de **un mes de piloto medido** (criterio de salida de F6).

## 10. Lo que no cambia

- La pizarra M6h sigue igual: mismo botón, mismas tablas, mismos clips vinculados a jugadas. Lo que se suba desde un
  partido aparece también en «Videos de la escuela» de la pizarra (es el mismo `school_videos`).
- Los torneos siguen con `events.stream_url` y `tournament_matches.stream_url`.
- `PartidoEnVivoPage` sigue siendo la pantalla de cancha del staff. La vista de la familia es otra página
  (`/partido/:id/ver`).

## 11. Acción humana (el usuario)

1. **Crear la cuenta de bunny.net** y **una librería de Stream por ambiente** (dev, stg, prod), siguiendo los pasos 1
   a 4 de §9 de `pizarra-m6h-videos-subidos.md`:
   - token authentication encendido, *allowed referrers*, sin MP4 fallback ni descargas;
   - 720p, 480p y 360p, sin conservar el original;
   - webhook a `https://<bff>/api/v1/webhooks/video/bunny`.
   - Elegir la red de entrega **Volume** en la *pull zone* de la librería si el panel lo permite.
2. **Cargar las variables** en Render, en los BFF que estén activos (el de stg está suspendido a propósito), nunca
   en el repo ni en el chat: `VIDEO_PROVIDER=bunny`, `BUNNY_STREAM_LIBRARY_ID`, `BUNNY_STREAM_API_KEY`,
   `BUNNY_STREAM_READONLY_API_KEY`, `BUNNY_STREAM_TOKEN_KEY`, y las nuevas de §3.
3. **Verificar en el panel** si existe el en vivo (Live / Live input), su precio y su latencia. Si no está claro,
   preguntar a soporte de Bunny (gate F5-0).
4. **Texto del consentimiento de imagen:** revisarlo con quien lleve lo legal (borrador en §13) y decidir la
   pregunta 🟡 de V-11.
5. **Plantilla de WhatsApp** para el pedido de consentimiento: aprobarla en Meta (categoría de utilidad).
6. **Decidir D-VIDEO-2** (§9.4) después del mes de piloto.
7. Por club que quiera en vivo: confirmar que su plan de Veo incluye Veo Live y que hay red en la cancha.
8. Aplicar las migraciones en **una sola sesión**, por una vía que deje rastro.

## 12. Fuera de alcance (v1) y después

- Materializar clips como assets propios (retención distinta para clips y partido; cierra el riesgo de V-7).
- Clips de enlaces externos (Veo o YouTube incrustados).
- Publicar highlights fuera del club (YouTube público, redes): requiere otro consentimiento.
- Compartir grabaciones de torneo con escuelas rivales.
- Importación automática desde Veo o Pixellot por API de partners (M6h fase 5).
- Dibujar sobre el video (M6h fase 3).
- Grabación de entrenamientos (`recordings` con `training_session_id`): el modelo lo admite agregando una columna y
  ampliando el CHECK.

## 13. Borrador del texto de consentimiento (para revisión legal)

> **Videos de los partidos de {escuela}.** Autorizo a {escuela} a grabar en video los partidos y entrenamientos en
> los que participa {deportista}, a quien represento como {parentesco}, y a que esos videos los vean el cuerpo
> técnico de {escuela} y las familias de su equipo dentro de la app SportMaps. También autorizo que lo identifiquen
> por su nombre en fragmentos (clips) de sus jugadas, para su seguimiento deportivo, su ficha y su informe mensual.
> Los videos se guardan con un proveedor de tecnología fuera de Colombia, no se publican en internet ni se comparten
> con terceros, y se borran después de {retención}. Puedo retirar esta autorización en cualquier momento desde la app
> o pidiéndolo a {escuela}; al retirarla, {deportista} deja de aparecer etiquetado y yo dejo de recibir los videos.
> No autorizar no afecta su participación en {escuela}.

## 14. Cambios al ROADMAP §VID (para que los aplique quien edite `docs/ROADMAP.md`; este spec no lo edita)

1. **Proveedor: Bunny Stream en lugar de Cloudflare Stream.** En «La regla de arquitectura del track», cambiar
   «candidato: Cloudflare Stream, el único que junta ingest RTMP en vivo + VOD + tokens firmados» por «**Bunny Stream**
   (D-VIDEO-1, 2026-11-26): ya integrado en la pizarra (`bff/src/services/video/bunny.ts`), cobra por GB y no por
   minuto, y es 6 a 10 veces más barato al acumular». Agregar: «El en vivo de Bunny **no está verificado**; si no
   existe, VID-3 sale por enlace (`stream_url`) o por un ingest propio (V-19 del spec)». La firma ya no es «el patrón de
   `glosa.service.ts`» sino la de `bunny.ts` (tus `AuthorizationSignature` y token de embed sha256).
2. **Modelo:** `recordings.provider` pasa de `veo | upload | rtmp | youtube` a `bunny | veo | youtube | link`.
   «Upload» y «rtmp» son orígenes de un asset en Bunny (`school_videos.source`, `recordings.kind`). `recordings`
   **envuelve** a `school_videos` de M6h (no la duplica), y los clips son `school_video_clips` ampliada +
   `video_clip_tags` (varios deportistas y tipo de jugada por clip), no una `recording_clips` nueva.
3. **VID-1:** en lugar de `video_url` + `provider` sueltos en `tournament_matches` y sesiones, VID-1 crea filas de
   `recordings` con `provider ≠ 'bunny'` colgadas de `match_results` o de `tournament_matches`. Mismo costo cero; el
   modelo agnóstico nace desde el primer día.
4. **VID-2:** se levanta el ⛔ `G-IMAGEN`: D-IMAGEN está resuelta (el club entero ve, con consentimiento). La
   migración sigue esperando el **texto legal aprobado** (F2 del spec).
5. **VID-3:** depende de la verificación F5-0. El marcador de SportMaps va como capa HTML sobre el reproductor (no se
   quema en el video) y sirve igual para el VOD. Agregar PAR-3a (RPC `set_school_live_match`, sin migración por
   cliente) y PAR-3b (`match_results.stream_url`).
6. **VID-4:** los clips llegan también a la ficha técnica global (PAR-1) y al Acudiente V2; se agrega la sugerencia
   automática desde `match_live_events`.
7. **VID-5:** reemplazar el párrafo de Cloudflare («unidades de dólar por cada mil minutos… no verificado») por el
   modelo de §9 de este spec. Precios de Bunny consultados el 2026-11-26; costo de una escuela mediana al mes 12 entre
   US$2,5 y US$14 según red y retención. Sigue abierta D-VIDEO-2, con tres opciones (recomendada: adicional por
   tramos, con el enlace gratis).
8. **VID-6:** resuelta en lo de producto. El modelo es `media_consent_texts` + `athlete_media_consents` (patrón
   clínico), aceptación en la app, por WhatsApp con enlace y token, o presencial. Sin consentimiento no hay etiqueta ni
   video para esa familia. Queda para lo legal la pregunta de V-11 (¿grabación compartida con un convocado sin
   consentimiento?).
9. En la tabla del track, la columna «Fuente» de VID-2 a VID-6 pasa de «spec pendiente» a
   `specs/video-partidos-bunny.md`.
