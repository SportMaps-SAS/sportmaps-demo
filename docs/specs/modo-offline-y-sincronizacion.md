# Spec — Modo offline y sincronización posterior

**Proyecto:** SportMaps · **Autor:** Brayan + Claude · **Fecha:** 2026-11-23 · **Versión:** 0.1 (propuesta, sin aprobar)
**Estado:** Fase 1 **construida en `develop`, sin desplegar** (2026-11-23). Fases 2 y 3 siguen en plan. Sin migraciones. Las decisiones **[D1–D5]** se tomaron como se proponen en §11, salvo lo anotado en §8 «Qué se construyó».

**Alcance:** que el entrenador pueda **abrir la app, ver su día y tomar lista sin señal** (la cancha), y que lo hecho sin red **suba solo y sin duplicar** cuando vuelva. Después, extender el mismo mecanismo a otros flujos de escritura de bajo riesgo. **No** es convertir toda la app en offline-first.

**Principio de diseño:** offline **por flujos, no global**. Ya existen tres colas offline independientes (asistencia del entrenador, partido en vivo, marcador de torneos). Este spec no las reemplaza a la fuerza: generaliza lo que tienen en común y cierra lo que falta (que la app *abra* y que las *lecturas* sobrevivan sin red).

---

## 0. Métricas de éxito

Ninguna está instrumentada hoy; levantarlas es parte de la Fase 0.

| Métrica | Hoy | Meta |
|---|---|---|
| Entrenador abre la app sin señal (PWA instalada, cuenta con sesión) y llega a «Asistencia» | ? (depende de qué chunks haya visitado) | 100 % de las pantallas del flujo del entrenador |
| Listas tomadas sin señal que llegan al servidor sin intervención | ? | > 99 % en ≤ 5 min tras volver la red |
| Listas duplicadas o con crédito descontado dos veces por reenvío | 0 conocidas (BFF idempotente) | 0 |
| Eventos rechazados al sincronizar que el usuario **no** vio | ? | 0 (todo rechazo es visible) |
| Ráfaga de consultas al reconectar (peor caso, por sesión) | sin medir | ≤ 10 consultas en los primeros 30 s |

---

## 1. Qué hay hoy (verificado en el código, 2026-11-23)

| Pieza | Dónde | Estado |
|---|---|---|
| Cola offline de **envío de listas** (por lista, fusiona por deportista, «Deshacer» 8 s, backoff, multi-pestaña con candado, tabla `hechas` anti-resurrección) | `components/coach/v2/colaAsistencia.ts`, `useCoachV2Senal.ts`, `CoachListasSync.tsx` (montado en `AuthLayout`) | ✅ Construido |
| Cola offline del **partido en vivo** (eventos con `client_event_id`, lote de 50 en orden, aísla al evento inválido) | `components/partido-vivo/liveQueue.ts` | ✅ Construido |
| Cola del **marcador de torneos** (`ActionQueue`, backoff 1–30 s, `safeStorage`) | `lib/tournamentActionQueue.ts` | ✅ Construido |
| Cola de **subida de videos** reanudable | `lib/school/resumableUpload.ts` | ✅ Construido |
| Service worker | `src/sw.js` | ⚠️ Parcial: ver abajo |
| React Query persistido | — | ❌ No existe. `QueryClient` en memoria (`App.tsx:291`, `staleTime` 5 min, `gcTime` 10 min) |
| **Lectura** offline del roster, equipos, sesión del día | — | ❌ No existe. `useAsistenciaV2Data` hace las consultas a Supabase y al BFF (`/attendance/roster/…`, `/attendance/session/…`) sin respaldo local |
| Indicador global «sin señal / N pendientes» | — | ❌ Solo hay `useEnLinea()` suelto en la pantalla de asistencia |

**Limitaciones concretas del service worker actual** (`frontend/src/sw.js`):

1. `__WB_MANIFEST` se inyecta pero **solo se usa para derivar `BUILD_ID`**; no se precachean los chunks. Solo se precachean `/`, `/index.html`, `/manifest.json` y dos íconos. Un chunk (`lazy`) que el usuario nunca abrió con red **no carga offline**; en ese caso `pwa/resetCaches.ts` y el ErrorBoundary ya evitan el bucle de recargas, pero la pantalla no abre.
2. Las respuestas de Supabase se guardan en la caché `supabase-api` **por URL, sin distinguir usuario**. En un celular compartido, offline podría servir los datos que cargó otra persona.
3. `activate` borra **todas** las cachés distintas de la actual (incluida `supabase-api`) en cada deploy: la caché de datos no sobrevive a una actualización.
4. Las peticiones al BFF (cross-origin) **no se interceptan** (decisión deliberada, ver comentario en `sw.js`): correcto, y se mantiene.

---

## 2. Qué entra y qué no

Regla: **entra offline lo que es un hecho que ocurrió en la cancha y que el servidor puede aceptar o rechazar sin dañar dinero ni cupos.** No entra lo que depende de un contador, una existencia o un permiso que solo el servidor puede garantizar.

| Offline + sincroniza después | Solo con conexión (se avisa claro) |
|---|---|
| Tomar lista (ya existe el envío; falta la lectura) | Pagos, comprobantes, abonos, cobros manuales |
| Evaluaciones / notas de sesión del entrenador **[D1]** | Stock y tienda (contadores con `FOR UPDATE`) |
| Encuesta post-entreno **[D1]** | Reservas e inscripciones con cupo |
| Eventos del partido en vivo (ya existe) | Cualquier cosa que otorgue permisos, invitaciones, cambios de rol |
| Marcador de torneos (ya existe) | Envío de mensajes a familias (WhatsApp/correo) |

Lo de la columna derecha no se encola: prometer «guardado» y rechazarlo horas después (cupo lleno, saldo cambiado) es peor que decir «necesitas señal».

---

## 3. Arquitectura propuesta

### 3.1 Capa 1 — La app abre sin señal (Fase 1)

- Usar `workbox-precaching` (ya es dependencia: `workbox-core`, `workbox-precaching` en `package.json`) para **precachear el manifiesto del build** que `vite-plugin-pwa` ya inyecta, en lugar de solo hashearlo. `precacheAndRoute(self.__WB_MANIFEST)` + `cleanupOutdatedCaches()`.
- Mantener las reglas que hoy protegen contra el bug del MIME (`script`/`style` nunca caen al `index.html`); con precache el chunk existe, y si no, sigue el 503 que dispara `vite:preloadError`.
- Respetar `maximumFileSizeToCacheInBytes` (5 MB por archivo) y **medir el tamaño total precacheado**: los chunks pesados (`vendor-tesseract`, `vendor-pdfjs`, `vendor-three`) **se excluyen** del precache (solo bajan al usarse y no son del flujo offline). Presupuesto propuesto: **≤ 8 MB** de precache en total **[D2]**.
- La estrategia `injectRegister: null` y el registro manual `type: 'module'` en `src/pwa/register.ts` **no se tocan** (evitan el bucle de `controllerchange`; ver comentario en `vite.config.ts`).

### 3.2 Capa 2 — Lecturas persistidas (Fase 1)

- Persistir React Query en **IndexedDB** con `@tanstack/query-async-storage-persister` + `PersistQueryClientProvider`, **con lista blanca** (`shouldDehydrateQuery`). Entran solo las `queryKey` del flujo del entrenador, p. ej.: `v2-asis-equipos`, `v2-asis-planes`, `v2-asis-clases-hoy`, `v2-asis-roster`, `v2-asis-sesion`, `coach-v2/equipos` y las de sesiones/calendario del día. Nunca consultas de pagos, finanzas ni datos de menores fuera del roster del día.
- **Clave por usuario y escuela:** el almacén se llama `sm-rq:{userId}`; no hay lectura cruzada entre cuentas. Esto reemplaza el uso de la caché `supabase-api` del SW para datos (el SW deja de cachear respuestas de Supabase; sigue sin tocar `auth/v1` ni `realtime/v1`).
- **Se borra al cerrar sesión** (`AuthContext.signOut`, incluido el camino de error) y al cambiar de usuario. Sin esto, el celular compartido es una fuga.
- **Caducidad:** `maxAge` 36 h para el roster y la agenda **[D3]**; pasado ese tiempo no se muestra como «vigente».
- **Precarga explícita del día:** al abrir la app con red, el entrenador precarga (`prefetchQuery`) los rosters de los equipos/clases de **hoy**, para que existan cuando se vaya la señal. Hoy solo se carga el roster al abrir ese equipo.
- **Etiqueta de frescura:** toda pantalla que muestre datos de caché dice «Datos de las 14:32 · sin señal» (no se presenta un dato viejo como actual).
- `refetchOnReconnect: 'always'` hoy (`App.tsx:298`) + caché persistida dispararía **todas** las consultas a la vez al reconectar. Cambiar a revalidación **escalonada y solo de la pantalla visible** (ver §7).

### 3.3 Capa 3 — Bandeja de salida común (Fase 2)

Extraer el patrón común de `LiveQueue` y `ColaAsistencia` a una cola genérica, **sin romper las existentes** (se migran después y de una en una):

- **Almacén:** IndexedDB (localStorage tiene cuota de ~5 MB y es síncrono; con comprobantes/fotos no sirve). `safeStorage()` queda como respaldo en memoria.
- **Cada acción** lleva `id` generado en el cliente (uuid), `tipo`, `payload`, `userId`, `schoolId`, `created_at`, `intentos`, `estado` (`pendiente | enviando | rechazada | atascada`).
- **Envío:** en orden por «clave de orden» (misma lista/sesión en orden; flujos distintos en paralelo), **por lotes** y con backoff (`backoffDelay`, 1–30 s, ya existe).
- **Clasificación de errores (la que ya funciona en `liveQueue.ts`):** `network` → reintenta; `blocked` (no es director/sesión cerrada/permiso) → frena sin tocar los eventos; `event` (dato inválido) → se aparta, **se muestra con su motivo**, y el resto sigue. **Nunca se descarta en silencio.**
- **Idempotencia obligatoria:** una acción entra a la cola solo si su endpoint/RPC es idempotente por `id` de cliente o por clave natural (sesión + deportista). Esta es la condición para que un flujo pueda ser offline (checklist en §9).
- **Multi-pestaña:** un solo emisor a la vez (`navigator.locks`; con respaldo por candado con vencimiento) y fusión por `key`/`version`, tal como ya hace `colaAsistencia.ts`.

### 3.4 Capa 4 — Indicador global y pantalla «Pendientes» (Fase 2)

- Banda discreta en el layout: «Sin señal · 3 pendientes» / «Sincronizando…» / «2 con problema» (toca para ver).
- Pantalla «Pendientes por enviar»: lista cada acción con etiqueta humana («Sub 11 · jueves 8 de octubre»), su estado y, si fue rechazada, el motivo con **Reintentar / Descartar** (descartar pide confirmación y deja registro).
- Sustituye los avisos sueltos que hoy tiene cada pantalla; los datos ya existen en `etiqueta`/`error`/`atascada` de `ListaEnCola`.

---

## 4. Conflictos y consistencia

| Caso | Regla |
|---|---|
| Dos pestañas/dispositivos editan la misma lista | Ya resuelto en `colaAsistencia`: fusiona por deportista, gana la `version` más alta, a igual versión el cambio más reciente. Se conserva. |
| La lista ya fue cerrada/finalizada en el servidor al sincronizar | Rechazo de regla (409/422): la acción queda **visible** con el motivo; **no** se pierde (comportamiento actual). |
| El atleta se dio de baja / cambió de equipo mientras no había señal | El servidor revalida al sincronizar y rechaza solo ese registro; el resto de la lista entra. El entrenador ve cuál y por qué. |
| Reenvío tras respuesta perdida | BFF idempotente (`upsert_attendance_record`; el crédito se mueve solo por **transición** presente↔no presente). Reenviar no descuenta dos veces. |
| Fecha de la clase | Viaja siempre **en el cuerpo** (ya ocurre): al subir al otro día entra con la fecha del entreno. |
| Eventos de partido | Solo-agregar con `client_event_id` y `period_second` calculado en el celular; el servidor es idempotente. |
| Reloj del celular mal puesto | No se confía en la hora del cliente para reglas de negocio; se guarda como dato informativo y el servidor decide. |

**Regla general:** en datos que sustituyen estado (lista) gana la última escritura *por deportista y sesión*; en datos que son hechos (eventos) no hay conflicto porque solo se agregan.

---

## 5. Sesión, auth y seguridad

- **Sin red, refrescar el token falla con 401 «sin sesión».** Eso es falta de señal, no sesión vencida: **no** cierra sesión ni vacía la cola (ya lo trata `enviarLista`; se generaliza). La sesión se refresca al volver la red y recién ahí se envía.
- **Privacidad (menores):** lo persistido en el celular son datos de menores (nombres, asistencia, salud en el reverso del carnet). Por eso: lista blanca estricta, clave por usuario, borrado al cerrar sesión, y **no se persiste** nada de salud, documentos de identidad, pagos ni comprobantes.
- **Nada de credenciales ni tokens en IndexedDB/localStorage propios** (los maneja Supabase Auth).
- **Autorización la sigue decidiendo el servidor al sincronizar** (RLS + gates del BFF como `assertCoachHasTeamAccess`). La cola solo **difiere** el envío; nunca otorga acceso. Un entrenador al que se le quitó el equipo mientras estaba offline recibe el rechazo al sincronizar.
- **No se acepta cola «reanudada» por otro usuario:** cada acción lleva `userId`; si al sincronizar la sesión activa es de otro usuario, **no se envía** (se retiene hasta que vuelva el dueño o se descarte).

---

## 6. Plataformas

| Plataforma | Comportamiento |
|---|---|
| Android PWA / Chrome | Service worker + IndexedDB + `online`. Background Sync es opcional y solo mejora. |
| **iOS Safari/PWA** | **No hay Background Sync.** Se envía al **abrir la app, al volver a primer plano (`visibilitychange`) y al evento `online`**, igual que la asistencia hoy. Documentar al usuario: «abre la app para que se envíe». |
| iOS: almacenamiento | Safari puede **purgar el almacenamiento** de sitios sin uso (≈ 7 días) si la PWA no está instalada. Pedir instalación y `navigator.storage.persist()` donde exista. |
| App nativa (Android AAB / Capacitor) | Misma lógica web; el AAB de prueba interna apunta a dev (ver memoria `project_play_internal_test_points_to_dev`). Probar offline en el AAB aparte. |

---

## 7. Disk IO de la base — restricciones (OBLIGATORIO, ver `CLAUDE.md`)

La base es **una sola** para dev/stg/prod; una ráfaga al reconectar es exactamente el patrón que la tumbó el 2026-10-14.

- **Reconexión escalonada:** al volver la red **no** se refrescan todas las consultas. Orden: (1) vaciar la bandeja de salida; (2) revalidar solo las consultas de la **pantalla visible**; (3) el resto, perezoso, al navegar. Con *jitter* aleatorio de 0–5 s para que 200 entrenadores que recuperan señal a la vez no sincronicen en el mismo segundo.
- **Lotes, no N+1:** la bandeja envía por lote donde el endpoint lo admite (eventos de partido ya: 50/lote; asistencia: una lista = un request con todos los deportistas). Un request por acción solo donde no haya alternativa.
- **Precarga del día acotada:** solo equipos/clases **de hoy** del entrenador, con `.in('id', ids)`, no una consulta por equipo.
- **Sin sondeo de catálogo** (`list_tables`, `get_advisors`) para esta funcionalidad; es solo frontend + endpoints existentes.
- **Sin migraciones en la Fase 1.** Si la Fase 2 requiere idempotencia por `client_id` en algún flujo nuevo (ver §9), va en **una** migración por flujo, aplicada por una sola sesión, con `GRANT EXECUTE` y `search_path` según las convenciones del repo.

---

## 8. Fases

> Sin ramas por fases: todo en `develop`, de corrido, con QA real entre fases (convención del repo). Cada fase es desplegable sola.

### Fase 0 — Medir (½ día)
- Instrumentar: % de aperturas sin red, cuántas listas pasan por la cola y cuánto tardan en subir, ráfaga al reconectar.
- Medir el tamaño real del precache candidato y decidir **[D2]**.

### Fase 1 — La cancha sin señal (núcleo, ~3–4 días)
1. `sw.js`: `precacheAndRoute` del manifiesto (sin chunks pesados), `cleanupOutdatedCaches`; quitar el cacheo por URL de Supabase.
2. React Query persistido en IndexedDB, lista blanca del entrenador, clave por usuario, borrado al cerrar sesión, `maxAge` 36 h.
3. Precarga del día (rosters de hoy).
4. Etiqueta de frescura en Asistencia y Sesiones del entrenador.
5. Reconexión escalonada (sustituye `refetchOnReconnect: 'always'` en esas queries).
6. **Criterio de salida:** con la PWA instalada y sesión iniciada, modo avión: abrir → Asistencia → ver roster del día → tomar y guardar lista → cerrar la app → recuperar red → la lista llega **una vez**, sin tocar nada.

#### Qué se construyó en la Fase 1 (y en qué se desvió del plan)

| Pieza | Dónde | Nota |
|---|---|---|
| Interruptor de reversa `VITE_OFFLINE_MODE=off` | `lib/offline/offlineConfig.ts` | Apaga persistencia, arranque sin señal y precarga. Encendido por defecto. |
| Lecturas persistidas | `lib/offline/queryPersistence.ts`, `idbStore.ts` | IndexedDB sin dependencias nuevas (clon estructurado: soporta `Map`). Lista blanca por prefijo, solo consultas con éxito, clave `rq:{userId}`, vence a las 36 h, versión de copia `OFFLINE_CACHE_VERSION`. |
| Retención y red | `configurarRetencionOffline` | Las consultas de la lista blanca usan `gcTime` 36 h y `networkMode: 'offlineFirst'` (si no, una consulta sin copia quedaba en pausa y nunca llegaba al respaldo `conCache`). |
| **La app arranca con la red caída** | `AuthContext.tsx`, `useSchoolContext.ts`, `lib/offline/arranqueSinRed.ts` | **No estaba en el spec original y era imprescindible:** sin red, `getSession()` y `getUser()` devuelven null con el token vencido y la app trataba al entrenador como visitante. Ahora, si la sesión sigue guardada (el refresco falló por red; un rechazo real la borra), se arranca con copia de perfil, contextos y escuelas (vence a los 14 días) y al volver la red se recarga todo en silencio. Solo actúa cuando la lectura real falló. |
| Service worker | `sw.js`, `pwa/precacheBuild.ts`, `pwa/register.ts` | **Desvío:** no se precachea en `install` (se midió el 2026-08-17 que eso duplicaba el login, 8→16 s). La página, ya ociosa, con sesión guardada, con red buena y sin ahorro de datos, le pide al SW `PRECACHE_BUILD`; baja de a 3 y solo lo que falta. El SW **ya no cachea respuestas de Supabase** (fuga entre usuarios). |
| Reconexión escalonada | `lib/offline/reconexion.ts` | React Query se entera de «volvió la red» con retraso aleatorio de 0–5 s; al irse, al instante. Las colas de envío siguen reaccionando al evento `online` sin esperar. |
| Precarga del día | `lib/offline/precargaDelDia.ts`, `CoachListasSync.tsx` | Roster y lista de hoy de hasta 8 equipos, de a 2, con las MISMAS consultas de la pantalla (`rosterQueryOptions`, `sesionDelDiaQueryOptions`). |
| Etiqueta de frescura | `lib/offline/frescura.ts`, `CoachAttendanceV2.tsx` | «Deportistas tal como estaban el hoy 14:32» en el aviso de sin señal. |
| Cierre de sesión | `limpiarDatosOffline()` | Borra IndexedDB, copias de arranque y las lecturas `sm_coach_v2_cache:*` (antes no se borraban: fuga entre usuarios en celular compartido). **No** toca la cola de listas sin subir. |
| Pruebas | `lib/offline/offline.test.ts`, `pwa/precacheBuild.test.ts` | 34 pruebas: lista blanca, aislamiento entre usuarios, vencimiento, borrado, arranque, precarga, concurrencia. |

**D2 medido (2026-11-23):** el manifiesto del build pesaba **11,4 MB** (677 archivos), por encima de los 8 MB propuestos. Se excluyeron `exceljs` y `vision_bundle` y quedó en **10,3 MB** (675 archivos). Se acepta ese tamaño porque es **una sola vez por celular**: los archivos llevan hash, van a una caché estable (`sportmaps-assets`) y cada deploy solo baja lo que cambió y poda lo que ya no existe. Solo con sesión guardada, red buena y sin ahorro de datos. Si en la Fase 0 se ve que pesa en datos móviles, el siguiente paso es dividir por rol (precache solo de las pantallas del entrenador).

**Pendiente de la Fase 1:** prueba en modo avión con la PWA instalada (Android real; iOS a mano).

### Fase 2 — Bandeja común y visibilidad (~4–5 días)
1. Cola genérica en IndexedDB (§3.3), con `ColaAsistencia` migrada primero (los tests `colaAsistencia.multi.test.ts` y `asistenciaV2.test.ts` son la red de seguridad).
2. Banda global y pantalla «Pendientes» (§3.4).
3. Primer flujo nuevo: **evaluaciones/notas de sesión** **[D1]**, solo si pasa el checklist de §9.

#### Qué se construyó en la Fase 2 (y en qué se desvió del plan)

| Pieza | Dónde | Nota |
|---|---|---|
| Bandeja de salida común | `lib/offline/bandeja.ts`, `idbStore.ts` (`idbListPrefix`) | IndexedDB, **un registro por acción** (`ob:{userId}:{id}`) para que dos pestañas no se pisen. Una acción por `id` lógico: guardar de nuevo la reemplaza (versión sube, gana lo último). Envío de a una, una sola pestaña (`navigator.locks`), esperas crecientes, mismos 4 resultados que la cola de asistencia (`ok` · `rule` · `auth` · `retry`/atascada). Si la vuelven a guardar mientras viaja, la versión nueva sale a continuación. Un tipo desconocido se conserva intacto. |
| **No se borra al cerrar sesión** | `limpiarDatosOffline` borra solo `rq:` | La bandeja es trabajo del usuario, no una copia de lectura. Cada acción lleva su `userId`: otra cuenta en el mismo celular no la ve ni la envía; espera a su dueño (spec §5). |
| Primer flujo nuevo: **evaluar al equipo** | `lib/offline/bandejaEvaluar.ts`, `CoachEvaluateV2.tsx` | Pasa el checklist §9 **sin migración**: `submit_post_training_coach_rating` hace upsert por sesión + deportista (+ nota sobrescrita), valida adentro que seas coach del equipo y no mueve dinero ni cupos. Sin señal (o si la señal se cae al enviar) la evaluación se guarda en el teléfono y sube sola. Un rechazo de regla (no eres coach, informe ya publicado, dato inválido) queda visible con su motivo; «la sesión no se ha cerrado / no asistió» se reintenta (la lista de asistencia de esa sesión puede seguir en la cola) y, si no llega, queda atascada con ese motivo. |
| Banda global y pantalla «Pendientes» | `BandaPendientes.tsx`, `PendientesPage.tsx` (`/pendientes`), `lib/offline/pendientesModel.ts`, `useBandeja.ts` | «Sin señal · 3 pendientes» / «Enviando 2 pendientes…» / «1 con problema · toca para ver». La pantalla junta **las dos fuentes** (listas de asistencia y evaluaciones), con motivo, «Volver a intentar» y «Descartar» (pide confirmación). Solo rol entrenador. |
| Sincronizador | `CoachListasSync.tsx` → `useSincronizadorBandeja` | Envía al abrir, al volver la red, al volver a primer plano y cuando vence la espera del próximo intento (un solo temporizador, sin sondeo). Avisa «Se envió: …» o el rechazo con su motivo. |
| Pruebas | `lib/offline/bandeja.test.ts` | 22 pruebas: reemplazo por id, orden, doble flush, rechazo visible, reintento con espera, atascada, sesión vencida, reguardado durante el envío, cambio de usuario, tipo desconocido, dos pestañas, clasificación de errores de la RPC, vista unificada. |

**Desvío — `ColaAsistencia` NO se migró a la bandeja.** El plan decía migrarla primero. No se hizo a propósito: la cola de asistencia es síncrona (localStorage) y su fusión multi-pestaña tiene su propia red de pruebas (`colaAsistencia.multi.test.ts`, `asistenciaV2.test.ts`); pasarla a IndexedDB asíncrono arriesga el flujo que ya funciona sin ganar nada visible. Lo que el plan buscaba (una sola vista) se logra con `pendientesModel`, que presenta las dos juntas. Se migra solo si aparece una razón real (p. ej. listas con adjuntos que no caben en localStorage).

**Pendiente de la Fase 2:** probar en un teléfono real el camino completo «evaluar sin señal → cerrar la app → recuperar señal → llega una vez» y ver la banda y la pantalla.

### Fase 3 — Más flujos y limpieza (según uso real)
- Encuesta post-entreno, otros flujos del entrenador/atleta que pasen el checklist.
- Migrar `LiveQueue` y `ActionQueue` a la cola común **solo si** hay una razón (hoy funcionan): no migrar por estética.

#### Qué se construyó en la Fase 3 (hasta ahora)

| Pieza | Dónde | Nota |
|---|---|---|
| **Autoevaluación post-entreno** («¿Qué tan duro fue?») | `lib/offline/bandejaAutoeval.ts`, `autoevalOffline.ts` | Pasa el checklist §9 **sin migración**: `submit_post_training_self_eval` es upsert por sujeto + métrica + sesión, valida adentro quién responde (acudiente del hijo / ficha vinculada / la propia cuenta), exige sesión cerrada, asistencia y plazo, y no mueve dinero ni cupos. Id = sesión + sujeto: dos hijos del mismo acudiente no se pisan. |
| Dónde se guarda sin señal | tarjeta del deportista (`AthleteHomeV2`) y formulario completo (`PostTrainingSelfEvalPage`, deportista o acudiente) | Solo si faltó la señal (navegador sin red o error de red). Un rechazo de regla se muestra como antes, no se guarda. Con `VITE_OFFLINE_MODE=off` todo se comporta como antes. |
| Fusión al re-guardar | `Bandeja.encolar(e, fusionar?)` | Atómica dentro de la serie. El «un toque» fusiona (no borra el formulario completo ya guardado); el formulario completo reemplaza. |
| Errores | `clasificarErrorAutoeval` | Red → «Sin señal» (reintenta). «Sesión sin cerrar» → reintenta contando como fallo de servidor (queda atascada con motivo si la lista del profe no llega). Plazo vencido, no asistió, sin permiso, sesión inexistente, valor inválido → se aparta **con su motivo**. |
| Montaje | `components/offline/BandejaFamiliaSync.tsx` (+ `BandaPendientes`) en `AuthLayout` para `athlete` y `parent`; `/pendientes` abierta a `coach`, `athlete`, `parent` | Sincronizan al abrir, al volver la red, al volver a primer plano y al vencer la espera. |
| Pruebas | `lib/offline/bandejaAutoeval.test.ts` | Parámetros por sujeto, clasificación, fusión, doble envío, rechazo visible, sin señal, red que se cae al enviar, sesión vencida, otra cuenta en el mismo teléfono, dos pestañas. |

**Cambio menor:** `AccionEnBandeja.schoolId` pasó a `string | null` (es solo informativo; la autoevaluación no lo conoce).

**Límite honesto:** el valor real es el caso «se vio la tarjeta/formulario y la señal se cayó antes de tocar». Las **lecturas** del deportista y del acudiente siguen sin persistirse offline (la Fase 1 fue solo del entrenador, D4): si abre la app sin señal, la tarjeta no aparece.

**Pendiente de la Fase 3:** probar en un teléfono real; decidir si las lecturas del deportista (carnet, calendario) entran como Fase 4 (lectura pura, D4); `LiveQueue`/`ActionQueue` siguen sin migrar a propósito.

---

## 9. Checklist para habilitar un flujo offline

Un flujo entra a la bandeja solo si cumple **todo**:

- [ ] El endpoint/RPC es **idempotente** por `id` generado en el cliente o por clave natural; reenviar N veces = 1 efecto.
- [ ] No mueve dinero, stock, cupos ni permisos.
- [ ] Un rechazo tardío es explicable al usuario sin dejarlo en un estado inconsistente.
- [ ] La **autorización se valida adentro** al sincronizar (RLS / gate del BFF), no en el cliente.
- [ ] Los datos que se guardan localmente están en la lista blanca de §3.2 y no incluyen salud, documentos ni pagos.
- [ ] Tiene prueba de: duplicado (doble envío), orden, rechazo de regla, sesión vencida, y dos pestañas.
- [ ] Si crea una entidad **multi-fila**, es una **RPC transaccional** (convención del repo), no N inserts sueltos.

---

## 10. Pruebas

- **Unitarias** (patrón de `liveQueue`/`colaAsistencia`, ya hay base): clasificación de errores, orden, idempotencia, fusión multi-pestaña, no-resurrección, cambio de usuario.
- **Integración con `vitest`:** persistencia → cierre de sesión → almacén vacío; usuario B no lee la caché de usuario A.
- **E2E con modo avión** (Playwright con `context.setOffline(true)`): el criterio de salida de la Fase 1, en Chromium; iOS se prueba **a mano** en un iPhone real (Background Sync y purga de almacenamiento no se simulan bien).
- **Carga:** simular 100–200 clientes reconectando juntos contra **dev** y mirar Disk IO antes de pasar a producción; no contra la base de producción.
- **Despliegue de un SW roto = problema grave** (ya pasó el 2026-10-15). Probar la actualización de un SW viejo a uno nuevo con usuarios que ya tienen el anterior; mantener `resetPwaCaches` y el botón «Recargar» como salida.

---

## 11. Decisiones abiertas (para el usuario)

| # | Pregunta | Propuesta |
|---|---|---|
| **D1** | ¿Qué flujos nuevos entran en la Fase 2/3 además de asistencia? | Evaluaciones/notas de sesión y encuesta post-entreno del entrenador. Nada de pagos. |
| **D2** | ¿Presupuesto de precache? | ≤ 8 MB, sin `vendor-tesseract`, `vendor-pdfjs` ni `vendor-three`. Se confirma con la medición de la Fase 0. |
| **D3** | ¿Cuánto tiempo se muestra un dato offline como utilizable? | 36 h para roster y agenda, siempre con la etiqueta de hora. |
| **D4** | ¿Solo el rol entrenador en la Fase 1, o también acudiente/atleta (ver carnet/calendario offline)? | Solo entrenador en la Fase 1; el carnet del atleta es un buen segundo candidato (lectura pura). |
| **D5** | ¿Escuelas con celulares compartidos? | Asumir que existen: borrado al cerrar sesión es obligatorio, no opcional. |

---

## 12. Fuera de alcance (descartado por ahora)

- **Motor de sincronización completo** (PowerSync, ElectricSQL, RxDB/Replicache): obliga a reescribir las reglas de RLS como reglas de sincronización y agrega replicación a una base compartida y ya al límite de Disk IO. Se reevalúa solo si el offline pasa a ser un requisito de producto para **todos** los roles.
- Offline para pagos, tienda, reservas, inscripciones, permisos y mensajería (ver §2).
- Resolución de conflictos con fusión campo a campo/CRDT.
- Offline del rol escuela/admin (tableros, contabilidad).

---

## 13. Referencias

- `docs/asistencia-estado-actual-y-mejoras.md` §6 «Modo offline básico del roster» (el origen de este spec) y `docs/specs/asistencia-rapida-checkin.md` (§1: «Modo offline del roster — No construido»).
- Código: `frontend/src/sw.js`, `frontend/src/pwa/{register,resetCaches}.ts`, `frontend/vite.config.ts` (`VitePWA`), `frontend/src/components/coach/v2/{colaAsistencia,useCoachV2Senal,useAsistenciaV2Data,CoachListasSync}.ts(x)`, `frontend/src/components/partido-vivo/liveQueue.ts`, `frontend/src/lib/tournamentActionQueue.ts`, `frontend/src/App.tsx` (`QueryClient`).
- `docs/gotchas-tecnicos.md` (una sola Supabase para todos los ambientes) y la sección «Disk IO» de `CLAUDE.md`.
