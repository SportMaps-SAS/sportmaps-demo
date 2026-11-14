# Torneos en vivo para todos los deportes — plan v2

**Fecha:** 2026-10-24 · **Versión:** 2.1 (v2 + cuatro huecos cerrados tras revisión; la v1 queda en el historial de git) · **Estado:** PLAN para aprobar. No hay código ni migración escritos.
**Cómo leer:** §1 y §2 describen lo que hay HOY (verificado en la base y el código el 2026-10-24). Desde §3 todo es propuesta. Los tamaños (S/M/L) son relativos, no fechas.

---

## Estado de implementación (2026-10-24)

El usuario pidió construir **todo de una** (los tres formatos independientes, partidos y sorteo configurables, anotador, página pública y pruebas) para probar y descartar. Se construyó:

- **Migración única `20261024084549_torneos_en_vivo_formatos`** (aplicada): reemplaza el plan de M1+M2 por una sola. Agrega `events.live_enabled/scoring_config/format_config/stream_url`; `tournament_matches` (`live`, `stage`, `group_label`, `home_ref/away_ref`, `court`, `version`, `live_state`, anotador); `tournament_match_log`, `tournament_scorekeepers` y la RPC `apply_tournament_match_action` (todo cerrado a `anon` y `authenticated`). **No se creó `tournament_match_sets`**: los sets se derivan de la secuencia de puntos guardada en `live_state`.
- **Motores puros** en `bff/src/services/tournament/`: `scoring.shared.ts` (goles y sets; copia en `frontend/src/lib/tournamentScoring.ts` con prueba de paridad), `standings.shared.ts`, `fixtures.shared.ts` (liga, copa y grupos + fase final; sorteo aleatorio con semilla o manual; partidos por equipo; ida y vuelta; tercer puesto; canchas y horas).
- **Servicio y rutas**: `tournament-live.service.ts` y `routes/tournament-live.route.ts` (`/api/v1/tournament-live`): ajustes, calendario por formato, acción única con versión + log + idempotencia, anotador por token, lectura pública con caché de 5 s y ETag. Interruptor global `TOURNAMENT_LIVE_DISABLED=true`.
- **Rutas heredadas** (`events.route.ts`) delegan al motor: `PATCH /matches/:matchId` (con `scoring_config` o sin él), generate-fixtures, standings y public-results. Cambio de comportamiento: **un empate en eliminatoria se rechaza** (antes se guardaba y no avanzaba a nadie).
- **Formatos independientes**: cada categoría puede usar uno distinto (`stage` por partido); `competition_format` del torneo guarda el último usado.
- **Pruebas**: motores (75), servicio con base simulada (33: torneo completo grupos → fase final → final, idempotencia, conflictos, anotadores, privacidad pública, carga), rutas HTTP (8) y `scripts/torneos-carga.mjs` (carga real; correr solo con torneo de prueba y fuera de horario).

Pendiente de decisión del cliente: torneo real de Monster, fecha, canchas y reglamento por categoría (§10).

## Resumen

- **Primera entrega concreta: vóley en vivo para un torneo real de Monster's Volley.** «Todos los deportes» es la arquitectura (modelos de marcador), no la primera entrega.
- **MVP = F0 + F1 + F2 + ensayo en cancha:** motor de tabla único, modelo de sets, estado «en juego», anotador para el admin del club y página pública que se refresca sola. El anotador sin cuenta (enlace) llega en F3, salvo que la mesa la maneje alguien externo.
- **Nada cambia para lo existente:** `live_enabled = false` y `scoring_config = NULL` dan exactamente el comportamiento de hoy.
- **Riesgos principales:** la señal en el coliseo y que dev, staging y producción comparten una sola base.
- **Para arrancar F1 se necesitan 4 respuestas (§10, 1–4).** Cada decisión trae un valor por defecto: si te sirve, basta con aprobarlo.

---

## 0. Qué queremos

Que un torneo creado en SportMaps genere **en vivo** su calendario, marcadores, tabla y cuadro, para cualquier deporte, con:

1. **Interruptor por torneo** para lo «en vivo» (apagado = solo el resultado final, como hoy).
2. **Página pública** sin login, con enlace y QR, que se actualiza sola.
3. **Anotador en la cancha** desde el celular.
4. **Más adelante, transmisión:** modo pantalla grande y enlace al video que el club ya transmite (YouTube/Facebook).

**Para quién**
- **Mesa o admin del club:** anota rápido, corrige sin miedo.
- **Familias:** ven el marcador y la tabla sin instalar nada.
- **Otros clubes y público:** descubren SportMaps. La página pública es también un canal de adquisición.

**Principios:** genérico por **modelo de marcador** (no una pantalla por deporte); **opt-in** por torneo; lo que funciona hoy no cambia; **una sola vía para cambiar un marcador**; **funciona con mala señal**; sin datos de menores en lo público.

### 0.1 Cómo sabremos que funcionó (primer torneo real)

| Métrica | Meta |
|---|---|
| Resultados finales correctos sin arreglos a mano en la base | 100 % |
| Partidos anotados en vivo (no solo el resultado final) | ≥ 90 % |
| Tiempo hasta que un cambio aparece en la página pública | ≤ 15 s (p95) en F2; ≤ 2 s en F4 |
| Visitas únicas a la página pública | ≥ 1 por deportista inscrito (ajustar con el club) |
| Clics en «Organiza tu torneo con SportMaps» | Medir; es la línea base de adquisición |
| Datos de menores expuestos en lo público | 0 |

---

## 1. Lo que ya hay (verificado el 2026-10-24)

**Base de datos**
- `events`: 12 eventos (11 de escuela). Campos útiles: `competition_format` (liga, copa, grupos, americano), `tournament_scope`, `sport`, `slug`, `school_id`, `visibility`, `status`.
- `tournament_matches`: local/visitante, marcador, ronda, `scheduled_at`, `venue`. **`status` solo admite** `scheduled`, `played`, `walkover`, `cancelled`. Hoy hay 5 partidos: 2 programados, 2 jugados, 1 walkover.
- `tournament_match_events`: goles y tarjetas (`goal`, `own_goal`, `yellow`, `red`, `assist`). Pensado para fútbol.
- Equipos, delegaciones, categorías y pagos de inscripción.
- Plantillas de categorías para **9 deportes** (atletismo, baloncesto, cheerleading, fútbol, futsal, gimnasia, natación, porras, voleibol). El catálogo tiene **100 deportes**.
- RLS solo para `authenticated`. **Nada para `anon`:** la página pública pasa por el BFF.
- `tournament_matches` **no** está en el tiempo real de Supabase.

**BFF (`events.route.ts`)**
- Crear torneo de escuela (exige el complemento `tournaments`).
- Calendario: **liga** (todos contra todos) y **copa** (eliminación directa con byes y avance del ganador).
- Cargar resultado: marca `played`, avanza al ganador en copa (salvo empate) y notifica a los integrantes de los dos equipos.
- Tabla, goleadores y página pública de resultados sin login.
- **La tabla está escrita dos veces** y es **solo de fútbol** (3/1/0, empates, diferencia de gol).
- Solo `school` / `school_admin` cargan resultados.
- Hoy el resultado entra por `PATCH /matches/:matchId` (`events.route.ts`): guarda el marcador **sin versión ni log**, avanza al ganador en copa **comparando `home_score` con `away_score`** y avisa a las familias.
- El calendario solo genera **liga** y **copa** (`format === 'copa' ? 'copa' : 'liga'`). **`grupos` y `americano` existen en el campo `competition_format`, pero no tienen generador ni cruces: no están implementados** (verificado el 2026-10-24).

**Frontend**
- Pestaña **Resultados** en el detalle del torneo.
- Página pública `/tournaments/:id/results`: **solo la tabla, carga una vez**, con botón de compartir.

**Gating:** el complemento Torneos está **apagado en Monster**.

---

## 2. Lo que falta

| # | Brecha | Por qué importa |
|---|---|---|
| B1 | No hay modelo de marcador: todo es fútbol | Vóley, tenis, baloncesto, gimnasia y natación no caben |
| B2 | No hay estado «en juego» | Sin eso no hay marcador en vivo |
| B3 | No hay marcador por set | El vóley se puntúa por sets |
| B4 | La página pública no se actualiza y solo muestra la tabla | No muestra partidos, marcadores ni cuadro |
| B5 | Solo la escuela carga resultados, con cuenta | En la cancha a veces anota otra persona |
| B6 | Sin interruptor «en vivo» ni reglas por torneo | No se puede activar o desactivar |
| B7 | Tabla duplicada en dos rutas | Cada regla nueva hay que cambiarla dos veces |
| B8 | Sin enlace de transmisión | Para ver el video junto al marcador |
| B9 | Sin corrección auditada | En vivo se corrige seguido |
| B10 | Puntos de tabla fijos en 3/1/0 | Baloncesto usa 2/1 sin empates; vóley usa 3/2/1/0 |
| B11 | Las reglas no cambian por categoría | Iniciación e infantil suelen jugar distinto que juvenil |
| B12 | No hay concepto de cancha *(por confirmar si `venue` alcanza)* | El anotador y «siguiente en cancha» lo necesitan |
| B13 | Nada contempla la mala señal | En un coliseo la conexión se cae; sin cola ni reintento se pierden puntos o se duplican |
| B14 | Walkover y abandono sin reglas por deporte | El resultado de un walkover en vóley no es igual al de fútbol |
| B15 | La ruta vieja `PATCH /matches/:matchId` escribe sin versión ni log | Si sigue abierta, un admin se salta el motor y el log |
| B16 | La copa avanza al ganador por `home_score > away_score` | Con sets hay que usar `matchOutcome`, no el marcador entero |
| B17 | No existe el formato «grupos + fase final» (ni generador ni cruces) | Es el formato típico del vóley; hoy solo hay liga y copa |

---

## 3. Diseño propuesto

### 3.1 Modelos de marcador

| Modelo | Deportes | Cómo se anota | Fase |
|---|---|---|---|
| `goals` | fútbol, futsal, balonmano, hockey, baloncesto | Goles o puntos corridos; empate permitido o no según el deporte | Ya existe (se parametriza en F0) |
| `sets` | vóley, pádel, bádminton, tenis de mesa; tenis solo por games | Unidades por set (puntos o games); gana quien llega a N sets | **F1** |
| `judged` | gimnasia, porras, patinaje, artes marciales | Nota de jueces | F5 |
| `timed` | atletismo, natación, ciclismo | Tiempo o puesto | F5 |

Cada torneo guarda su configuración en `events.scoring_config` (jsonb), con **valores por defecto por deporte** en código y **ajustes por categoría**. Ejemplo de vóley:

```json
{
  "model": "sets",
  "best_of": 3,
  "set_points": 25,
  "deciding_set_points": 15,
  "win_by": 2,
  "cap": null,
  "standings_points": { "win": 3, "win_deciding_set": 2, "loss_deciding_set": 1, "loss": 0 },
  "walkover": { "loser_points": 0, "set_score": [25, 0] },
  "tiebreakers": ["wins", "points", "set_ratio", "point_ratio", "head_to_head"],
  "by_category": { "<category_id>": { "set_points": 15, "deciding_set_points": 15 } }
}
```

- `win_deciding_set` reemplaza llaves como `"3-2"`: sirve igual para partidos a 2 de 3 y a 3 de 5.
- Los desempates siguen como referencia el orden FIVB (partidos ganados, puntos, ratio de sets, ratio de puntos, enfrentamiento directo). La v1 ponía los puntos primero. Lo decide el reglamento del torneo (§10).
- `scoring_config = NULL` = fútbol con 3/1/0, igual que hoy.
- **Compatibilidad en `sets`:** `home_score` y `away_score` guardan los **sets ganados** (ej. 3-1), no los puntos. Así lo que ya lee `tournament_matches` sigue teniendo sentido. El detalle por set vive en `tournament_match_sets`. **El ganador, la tabla y el avance de copa salen de `matchOutcome`, nunca de comparar `home_score` con `away_score`.**
- En la interfaz la escuela elige de una **plantilla por deporte**; nunca edita JSON.

### 3.2 Datos: dos migraciones pequeñas, cada una con aprobación

Las migraciones son inmutables y se aplican a mano. Por eso conviene no crear hoy tablas que solo se usan en F3: si el diseño cambia después del ensayo en cancha, habría que corregirlas con otra migración.

**M1 (F1)**
- `events.live_enabled boolean not null default false`.
- `events.scoring_config jsonb null`.
- `tournament_matches`: agregar `live` al CHECK de `status`; columnas `started_at`, `finished_at`, `version int not null default 0` y `court text null` (si `venue` no alcanza).
- Ciclo de estados: `scheduled → live → played`; `walkover` y `cancelled` desde `scheduled`. Corregir un partido `played` queda en el log.
- `tournament_match_sets`: `match_id`, `set_number`, `home_points`, `away_points`, `finished`; único por (`match_id`, `set_number`); puntos ≥ 0.
- `tournament_match_log`: `match_id`, `actor_type` (`user` | `scorekeeper` | `system`), `actor_id`, `action`, `before` y `after` (jsonb), `client_action_id`, `created_at`; único por (`match_id`, `client_action_id`) para que un reintento no se aplique dos veces.

**M2 (F3/F6)**
- `tournament_scorekeepers`: torneo, cancha opcional, etiqueta («Mesa cancha 1»), **hash del token**, `expires_at`, `revoked_at`, `last_used_at`.
- `tournament_matches.stream_url`.

**En ambas:** `search_path` fijo, `GRANT` explícito, estados como `text + CHECK`, **nada expuesto a `anon`**.

### 3.3 BFF

**Motor puro `tournament-scoring.shared.ts`**, con la misma interfaz para cada modelo:
- `applyAction(estado, acción, config)`: valida y devuelve el nuevo estado o un error claro.
- `matchOutcome(partido, config)`: ganador, sets y puntos, para la tabla.
- `standings(partidos, config)`: tabla genérica con puntos y desempates configurables.

Reemplaza la tabla duplicada.

**Una sola vía de escritura:** `POST /matches/:id/actions`, con acciones `start`, `point`, `undo`, `end_set`, `finish`, `correct` y `walkover`. En cada acción:
1. Autentica al usuario del club o al token de anotador.
2. Verifica que `live_enabled` esté encendido.
3. Aplica idempotencia (`client_action_id`) y la versión.
4. Llama al motor.
5. Guarda el estado y el log en **una transacción**.
6. Notifica **después**, sin demorar la respuesta.

**Ruta heredada `PATCH /matches/:matchId`** (decidido):
- Torneo **sin** `scoring_config`: sigue exactamente igual que hoy.
- Torneo **con** `scoring_config`: no escribe por su cuenta; **delega por dentro a la vía única del motor** (versión, log, avance de copa y avisos). Así ninguna ruta se salta el log.
- Se cubre con prueba de regresión (§5) y se revisa en el inventario de F0.

**`tournament_match_events` no se toca.** Sigue siendo solo de fútbol (goles y tarjetas), convive con `sets` y no se migra ni se reutiliza para puntos de vóley.

**Lectura pública:** `GET /public/tournaments/:slug/live`.
- Usa el `slug`, no el id interno. La ruta vieja redirige.
- Caché de **5 s** en el BFF y `ETag`.
- Responde solo con equipos, marcadores, horarios y cancha.

**Refresco del cliente:**
- Cada **10 s** si hay partidos en juego y cada 60 s si no.
- Solo con la pestaña visible.
- Peor caso: ~15 s.
- Carga estimada: 500 espectadores son ~50 solicitudes/s al BFF, pero máximo **1 consulta a la base cada 5 s por torneo**.

### 3.4 Frontend

**Ajustes del torneo**
- Plantilla por deporte.
- Ajustes por categoría.
- Interruptor «en vivo».
- Enlace de transmisión (F6).

**Anotador** (web móvil)
- **F1:** dentro de la app, para `school` / `school_admin`. Alcanza para el primer torneo si la mesa es del club.
- **F3:** enlace o QR sin cuenta.
- Botones grandes por equipo y **deshacer siempre visible**.
- Confirmación al cerrar set y partido.
- Pantalla siempre encendida (Wake Lock).
- **Un anotador activo por partido:** quien lo abre lo «toma». Otro puede tomarlo con confirmación, lo que evita choques de versión punto a punto.
- **Cola local con reintento** cuando se cae la señal, con indicador «sincronizado / pendiente».

**Página pública en vivo**
- «En juego ahora» arriba, «Siguiente en cada cancha», resultados, tabla por categoría o grupo, cuadro de copa y QR.
- Hora de Colombia.
- `noindex` por defecto.
- Pie con marca SportMaps y botón **«Organiza tu torneo con SportMaps»** con UTM para medir.

**Modo TV** (`/tournaments/:slug/tv`): solo lectura, letra grande, rota entre canchas.

**Textos:** en español colombiano. El aviso actual dice «podés»; se corrige.

### 3.5 Privacidad y seguridad

- **Lo público** muestra equipos, marcadores, horarios y cancha. **No** muestra nombres de menores, documentos, contactos ni pagos. Hay una prueba automática que falla si alguno aparece.
- **Ley 1581 de 2012:** si más adelante se muestran nombres de deportistas (§10), el club debe tener la autorización de padres o acudientes. Ese permiso es por torneo y está apagado por defecto.
- **Transmisión:** el club es responsable del video y de la autorización de las familias. SportMaps solo enlaza, y lo avisa al pegar el enlace.
- **Token de anotador:** largo, guardado como hash, vence al terminar el torneo + 24 h, revocable, con alcance de un torneo (y opcionalmente de una cancha).
- **Límite de frecuencia** en los endpoints públicos y de anotador.
- **Interruptores de emergencia:**
  - Por torneo (`live_enabled`).
  - **Global** (variable de entorno), que apaga lo «en vivo» en todos los torneos sin desplegar.
- **Enlace de video:** solo dominios permitidos (YouTube, Facebook, Vimeo).

### 3.6 Avisos a las familias

- Solo eventos que importan: **resultado final** y, opcionalmente, **inicio del partido**. Nunca punto a punto.
- Canal: **notificación de la app primero**.
- WhatsApp solo con opt-in. Desde el 1 de octubre de 2026, los avisos que inicia el club por WhatsApp se cobran desde el primer mensaje. Los 1.000 mensajes gratis al mes cubren solo las respuestas de servicio.

### 3.7 Transmisión

- **Incluido:** la escuela pega el enlace de su transmisión (por partido o por cancha) y el video se ve junto al marcador. También el modo TV.
- **No incluido:** video propio de SportMaps, que tiene infraestructura y costo aparte.

---

## 4. Fases

| Fase | Entrega | Criterio de aceptación | Tamaño |
|---|---|---|---|
| **F0** | Inventario de todo lo que asume los 4 estados actuales y de todas las rutas que escriben un marcador (incluida `PATCH /matches/:matchId`). Motor de tabla puro con puntos configurables (por defecto 3/1/0). Borrar la copia | `standings` y `public-results` devuelven lo mismo que antes con los 5 partidos (snapshot) | S |
| **F1** | Modelo `sets`, estado `live`, reglas por torneo y categoría, anotador para el admin, log y M1 | Partidos a 2 de 3 y a 3 de 5 con tabla correcta; casos borde (§5) en verde; deshacer funciona; un torneo de fútbol existente se ve igual. **Con sets, `home_score`/`away_score` guardan los sets ganados (ej. 3-1) y el ganador y el avance de copa salen de `matchOutcome`** (prueba: copa 2-1 en sets avanza al ganador correcto). **`PATCH /matches/:matchId` con `scoring_config` delega al motor y deja log** | M |
| **F1b** | Formato **«grupos + fase final»**: generador de grupos (todos contra todos por grupo), tabla por grupo y cruces a la fase final (ej. 1.º A vs 2.º B). Depende de la decisión 10 | Con N grupos y los clasificados definidos, el cuadro final se arma solo con los cruces acordados; empates entre grupos resueltos por los desempates de la config; liga y copa existentes no cambian | M |
| **F2** | Página pública en vivo: en juego, siguiente por cancha, tabla, cuadro, QR, interruptor, marca y CTA | Apagado = igual que hoy; encendido, cambio visible ≤ 15 s (p95); prueba de carga de §5 dentro de meta; sin datos sensibles | M |
| **Ensayo** | Partido amistoso de Monster con la señal real del coliseo | Un partido completo anotado sin perder ni duplicar puntos; familias viéndolo por QR | — |
| **F3** | Anotador sin cuenta (enlace/QR), toma de partido, cola offline y M2 | Con el celular 2 min sin señal, los puntos se sincronizan al volver sin duplicarse; un segundo anotador tiene que «tomar» el partido; revocar corta al instante | M |
| **F4** | Tiempo real (Broadcast desde el BFF), modo TV y avisos de inicio y final | Cambio visible ≤ 2 s sin recargar; la carga de la base no crece con los espectadores | M |
| **F6** | Enlace de transmisión por partido o cancha | Se ve el video; solo dominios permitidos | S |
| **F5** | Modelos `judged` y `timed` | Gimnasia con notas y natación con tiempos, con su clasificación | L |

**MVP para el primer torneo:** F0 → F1 → F2 → ensayo. **F1b entra al MVP si el torneo de Monster es «grupos + fase final»** (decisión 10); si es liga o copa, no. F3 entra al MVP solo si la mesa la maneja alguien sin cuenta del club. Después: F4 → F6. F5 cuando un torneo real de un deporte calificado o cronometrado lo pida.

---

## 5. Pruebas

- **Motor de vóley (casos borde):**
  - 25-23 cierra el set.
  - 25-24 sigue.
  - 26-24 cierra.
  - 31-29 cierra (sin tope).
  - Set decisivo 15-13 cierra y 15-14 sigue.
  - No se puede sumar a un set cerrado.
  - Deshacer el último punto de un set cerrado lo reabre.
  - El partido termina al llegar a ⌈best_of/2⌉ sets.
  - Walkover según config.
- **Ruta heredada:** `PATCH /matches/:matchId` en un torneo sin `scoring_config` da el mismo resultado de hoy; con `scoring_config` delega al motor y escribe en el log (versión incrementada).
- **Copa con sets:** un 2-1 en sets avanza al ganador por `matchOutcome`; un marcador de sets nunca se compara como goles.
- **Grupos + fase final (F1b):** generación de grupos, tabla por grupo y cruces (1.º A vs 2.º B), con empates entre clasificados.
- **Tabla:** empate a puntos resuelto por cada desempate en orden; regresión de fútbol con los 5 partidos.
- **Concurrencia e idempotencia:**
  - Dos acciones con la misma versión: una se aplica y la otra recibe conflicto.
  - El mismo `client_action_id` dos veces se aplica una sola vez.
- **Carga:** JMeter o k6 contra el endpoint público con 500 espectadores, refresco de 10 s y 30 min. Se mide p95 y consultas a la base. **Correrla con un torneo de prueba y fuera de horario, porque la base es la misma de producción.**
- **Seguridad:**
  - La respuesta pública no contiene campos sensibles (prueba automática).
  - Un token vencido o revocado se rechaza.
  - El límite de frecuencia responde 429.
- **Campo:** el ensayo de §4.

---

## 6. Día del torneo

- **Antes:**
  - Reglas confirmadas y `live_enabled` encendido.
  - QR impreso por cancha.
  - Celular de la mesa cargado, con batería externa y datos de respaldo.
  - Prueba rápida de anotar y deshacer.
- **Durante:**
  - Alguien de SportMaps de guardia, con acceso al log.
  - **Plan B:** si lo «en vivo» falla, se apaga `live_enabled` y se cargan los resultados finales como hoy.
- **Después:** revisar el log de correcciones y las métricas de §0.1, y ajustar antes del siguiente torneo.

---

## 7. Lo que tengo para hacerlo

**Tengo:**
- Acceso al repo y al módulo actual (ya leído).
- Consultas a la base.
- Migraciones con aprobación y verificación.
- Pruebas automáticas del BFF y del frontend.
- Agentes en paralelo por archivos distintos.
- Entorno de desarrollo con datos de prueba.

**Necesito de ti:**
- Las respuestas de §10.
- Un torneo real de Monster y un partido amistoso para el ensayo.
- El enlace de transmisión, si lo hay.

**No tengo:**
- El reglamento de cada deporte.
- Credenciales de YouTube o Facebook (no hacen falta: solo se enlaza).

---

## 8. Riesgos

| Riesgo | Cobertura |
|---|---|
| Se cae la señal en el coliseo | Cola local, reintento, idempotencia, ensayo previo y plan B |
| La página pública golpea la única base (dev, staging y producción comparten) | Caché de 5 s y `ETag`, solo torneos con `live_enabled`, Broadcast en F4, prueba de carga controlada |
| Exponer tablas a `anon` | No se exponen: todo pasa por el BFF |
| Dos anotadores en el mismo partido | Un anotador activo por partido, `version` optimista y log |
| Código que asume solo 4 estados | Inventario en F0, tipos exhaustivos y regresión |
| Reglas distintas por federación o categoría | `scoring_config` por torneo con ajustes por categoría, no en el código |
| Datos de menores en lo público | Solo equipos y marcadores; prueba automática; nombres solo con autorización |
| Costo de los avisos por WhatsApp | Notificación de la app primero; WhatsApp solo con opt-in |
| «Todos los deportes» infla el alcance | Multideporte es arquitectura; se entrega vóley primero |
| Una migración mal hecha | Dos migraciones pequeñas, revisadas antes de aplicar |

---

## 9. Fuera de alcance

- Video propio de SportMaps.
- Estadísticas individuales de vóley (ataques, bloqueos, saques).
- Tenis con puntos 15-30-40.
- Penales en copa de fútbol. Hoy un empate en copa no avanza a nadie; queda en el backlog.
- Acta digital firmada por árbitros.
- App nativa del anotador (es web móvil).

---

## 10. Decisiones abiertas (con valor por defecto)

**Bloquean F1** (la 10 bloquea F1b)

| # | Pregunta | Propuesta por defecto |
|---|---|---|
| 1 | ¿Qué torneo primero, en qué fecha, cuántas canchas y cuántos partidos? | Sin propuesta: se necesita la respuesta |
| 2 | Reglamento de vóley por categoría | Menores: 2 de 3 sets a 25 y el tercero a 15. Mayores: 3 de 5 y el quinto a 15. Diferencia de 2, sin tope. Tabla 3/2/1/0. Desempates FIVB. Walkover 25-0 por set y 0 puntos |
| 3 | ¿Quién anota y cuántas canchas a la vez? | Mesa del club con cuenta `school_admin` en el MVP; enlace sin cuenta en F3 |
| 4 | ¿Monster activa el complemento Torneos? | Sí, primero con un torneo de prueba |
| 10 | **Formato del torneo y cruces:** liga, copa o grupos + fase final. Si es grupos: cuántos grupos, cuántos clasifican y qué cruces (ej. 1.º A vs 2.º B) | Grupos de 4 equipos, clasifican los 2 primeros, cruces 1.º A vs 2.º B y 1.º B vs 2.º A. Si el torneo es de pocos equipos, liga |

**Bloquean F2**

| # | Pregunta | Propuesta por defecto |
|---|---|---|
| 5 | ¿Para quién es lo público? ¿Nombres de deportistas? | Familias y público; solo equipos y marcadores; `noindex` |
| 6 | ¿Torneos solo del club o con otros clubes? | Con otros clubes (revisar si las delegaciones actuales lo cubren); solo se muestra el nombre del equipo |

**Pueden esperar**

| # | Pregunta | Propuesta por defecto |
|---|---|---|
| 7 | ¿Hay transmisión? | Enlace de YouTube o Facebook del club, en F6 |
| 8 | Avisos a las familias | Resultado final por la app; WhatsApp solo con opt-in |
| 9 | ¿Lo «en vivo» va dentro del complemento Torneos o se cobra aparte? | Incluido en el piloto con Monster; precio después de medir el uso |

---

## 11. Primer paso si se aprueba

**F0:**
1. Hacer el inventario de usos de `status` en el BFF y el frontend.
2. Extraer la tabla a un motor puro con puntos configurables.
3. Comprobar con snapshot que los 5 partidos actuales dan exactamente lo mismo.

No toca la base ni cambia lo que ven los usuarios. Después viene F1, con la migración M1 presentada para revisión antes de aplicarla.

---

## Cambios de la v2.1 frente a la v2

- **Ruta heredada:** `PATCH /matches/:matchId` sin `scoring_config` no cambia; con `scoring_config` delega por dentro al motor (B15).
- **Sets y marcador:** `home_score`/`away_score` guardan sets ganados; ganador y avance de copa salen de `matchOutcome` (B16, criterio de F1).
- **Grupos:** verificado que `grupos` **no está implementado**; se agrega la brecha B17, la fase F1b y la decisión 10 de formato y cruces.
- **`tournament_match_events`:** explícito que no se toca.

## Cambios frente a la v1

- **Foco:** primera entrega en vóley para un torneo real de Monster, con MVP explícito y ensayo en cancha.
- **Nuevas secciones:** métricas de éxito, pruebas, día del torneo y fuera de alcance.
- **Brechas nuevas:** B10–B14 (puntos de tabla por deporte, reglas por categoría, canchas, mala señal y walkover).
- **Configuración:** `standings_points` genérico (sirve a 2 de 3 y a 3 de 5), desempates con referencia FIVB y ajustes por categoría.
- **Migraciones:** dos pequeñas en lugar de una grande.
- **Anotador:** uno activo por partido, cola offline e idempotencia por `client_action_id`.
- **Página pública:** por `slug`, caché de 5 s con refresco de 10 s (≤ 15 s), `noindex`, marca y CTA.
- **Privacidad:** Ley 1581, responsabilidad del club sobre el video e interruptor global.
- **Avisos:** solo inicio y final; WhatsApp con opt-in por costo.
- **Decisiones:** cada una con valor por defecto, ordenadas por lo que bloquean.

---

## Experiencia en vivo (agente «vivo», 2026-10-27)

Lo que nos diferencia de Star Vivo / Copa Fácil: SportMaps conoce a las deportistas y a sus familias.
Migración **`20261027180907_torneos_vivo_seguir_social_tiempo_real`** (SIN aplicar; aplicarla ANTES de desplegar el BFF — sin ella todo esto queda mudo pero no rompe nada).

### Tiempo real (F4)
- Tras cada acción NO duplicada, `performMatchAction` llama `onMatchActionApplied` (`tournament-follow.service.ts`), que publica UN mensaje Broadcast al canal **privado** `tlive:<slug>` por la API REST de Realtime (`live-push.ts`).
- Payload mínimo: `{ match_id, version, status, home_score, away_score, sets[], started_at, finished_at, sent_at }`. Sin nombres.
- Sin tormentas: por partido como mucho 1 mensaje cada 300 ms (el último estado gana); por canal ≤ 10/s. Nunca una versión menor que la ya enviada.
- Canal privado: policy `tlive_broadcast_lectura` (SELECT a anon/authenticated solo para `tlive:%`). Sin policy de INSERT → nadie puede emitir desde el navegador. Realtime evalúa la policy al UNIRSE (una consulta por conexión), no por mensaje.
- Cliente (`usePublicLive`): aplica el mensaje si `sent_at` es posterior al `server_time` del último polling. Polling de respaldo 3× más lento con push (30 s / 180 s). Al terminar un partido pide el payload completo a los 6–10 s (después de la caché de 5 s, con espera aleatoria). Pestaña oculta = suelta el canal.
- Interruptor: `TOURNAMENT_LIVE_PUSH_DISABLED=true` (queda el polling).
- Cuota de Realtime (Pro): cada mensaje cuenta por espectador conectado. Un partido de ~100 puntos con 300 espectadores ≈ 30 000 mensajes.

### Seguir y avisos
- `tournament_follows` (torneo completo o equipo). Con cuenta → avisos por el camino EXISTENTE: insert en `notifications` (category `tournament`) → trigger → despachador unificado → Web Push / FCM. **Dependencia:** el despachador de prod está atascado (arreglo en curso, `20261027150500_desatascar_cola_notificaciones`); mientras tanto los avisos quedan en la campana. No se tocó `notifications-dispatch.job` ni el trigger.
- Web Push exige cuenta (`push_subscriptions.user_id`). Sin cuenta: **Agregar al calendario** — `GET /public/:slug/calendar.ics[?team=]` (sale de la caché de `publicLive`, alarma 15 min antes).
- Avisos: «⏰ … empieza en 15 min en la cancha 3» (cron cada 5 min, ventana +10/+20 min, solo Render, `DISABLE_TOURNAMENT_REMINDERS_CRON`), «🏐 Empezó Monsters vs Orange», «Final: Monsters 2-0 Orange (25-22, 25-20)».
- Destinatarios: seguidores del torneo o de uno de los equipos + familias y deportistas de la planilla (en «final» solo seguidores: a la planilla ya le llega `notifyMatchFinished`). `tournament_match_notices` (PK partido+tipo, `ON CONFLICT DO NOTHING`) garantiza un aviso por partido y tipo aunque haya reintentos o dos BFF. Una corrección posterior NO vuelve a avisar.

### Inicio V2 de familias y deportistas
- `GET /me/today` → partidos de HOY (día de Bogotá) de los equipos donde está la persona (`event_team_members.profile_id`) o sus hijos (`children.parent_id`). Tarjeta `HoyJuegaCard` en ParentHomeV2 y AthleteHomeV2. Limitación: hijos vinculados por otros caminos (no `parent_id`) no salen.

### Tarjeta para compartir
- PNG 1080×1350 en el cliente (`live/shareCard.ts`): torneo, fase (+ `cup_label`), escudos (`*_logo_url` del payload v2 si existen; si no, iniciales), marcador y sets, MVP, «Powered by SportMaps». Botón `ShareResultButton` (Web Share con archivo; si no, descarga). En el anotador aparece al terminar el partido.

### Social (comentarios, medios, noticias)
- `GET /public/:slug/matches/:id/social` → `{ comments[], media[], mvp, player_stats }` (caché 10 s). `GET /public/:slug/social` (torneo).
- Comentarios: con cuenta (nombre de pila + inicial, marca de verificado) o con nombre + reto «¿Cuánto es 3 + 5?» firmado (HMAC, ≥ 3 s, ≤ 30 min, `TOURNAMENT_SOCIAL_SECRET`), campo trampa, sin enlaces, filtro de groserías, 1 cada 20 s por dispositivo y 6/min por IP. Moderación: `PATCH /school/:id/comments/:id { hide | show | delete }`.
- Medios: el organizador o el anotador sube fotos con URL firmada al bucket `tournament-media` (lectura pública; SIN policies de escritura para clientes) o pega un enlace de video; noticias solo el organizador. Pestañas «Todo / Noticias».

### MVP y estadísticas por jugadora
- Solo para equipos **con planilla** (`event_team_members`). Sin planilla, `mvp.available = false` (no hay MVP por jugadora).
- Nombre público: solo nombre de pila; inicial del apellido solo si consta que es mayor de edad. La planilla no tiene número de camiseta (si se agrega, va como `#7`).
- Voto: uno por dispositivo y partido (hash de dispositivo+partido), 30/min por IP, abierto en juego y hasta 3 h después. El organizador puede elegir (`PUT /school/:id/matches/:id/mvp`) y su elección manda.
- Estadísticas (ace / ataque / bloqueo; puntos = suma) atadas a `point_index`: cuentan solo si el punto sigue en la secuencia y lo ganó el lado de la jugadora. Deshacer/corregir borra las etiquetas de los puntos que ya no existen. Ranking: `GET /public/:slug/player-stats`, y también en `player_stats` del payload de `/public/:slug/live` (hecho por «datos»).

## Multideporte: plantillas, anotador y planilla (agente «deportes», 2026-10-27)

Motor: `bff/src/services/tournament/scoring.shared.ts` (copia idéntica en `frontend/src/lib/tournamentScoring.ts`, prueba de paridad en `frontend/src/test/tournamentScoringParity.test.ts`). Catálogo de deportes de torneo: `frontend/src/lib/tournamentSports.ts`. Cada plantilla nueva guarda su clave en `scoring_config.preset`, así el anotador y la planilla saben el deporte sin leer `events.sport`. Los torneos existentes (sin `preset`) siguen igual: fútbol 3-1-0 y las plantillas viejas no cambiaron (pádel sigue contando games como unidad, con tope 7).

### Tabla deporte → plantilla → anotador → tabla de posiciones

| Deporte | Plantilla(s) (`preset`) | Anotador | Tabla de posiciones (puntos · desempates) |
|---|---|---|---|
| Fútbol, Futsal | `futbol` | Goles +1; en eliminatoria un empate pide **penales** | 3-1-0 · pts, DG, GF, enfrentamiento directo |
| Balonmano | `balonmano` (2-1-0), `balonmano_3` (3-1-0) | Goles; empate en grupos; en eliminatoria «lanzamientos de 7 m» | 2-1-0 / 3-1-0 · pts, DG, GF, directo |
| Hockey | `hockey` | Goles; en eliminatoria shoot-out / penales | 3-1-0 · pts, DG, GF, directo |
| Baloncesto | `baloncesto` | Puntos; sin empate (se juega tiempo extra, no penales) | 2-1 · pts, DG, GF, directo |
| Voleibol | `voleibol_3`, `voleibol_5` | Puntos por set; el set se cierra solo | 3/2/1/0 (3-0 y 3-1 = 3; 3-2 = 2 y 1) · pts, victorias, ratio sets, ratio puntos, directo |
| Vóley playa | `voley_playa` (21, decisivo 15) | Igual que vóley | Igual que vóley |
| Futvóley | `futvoley` (18, decisivo 15) | Igual que vóley | Igual que vóley |
| Tenis de mesa | `tenis_mesa` (3 de 5 a 11) | Puntos por set | 2-0 · pts, ratio sets, ratio puntos, directo |
| Bádminton | `badminton` (21, tope 30) | Puntos por set | 2-0 · igual |
| Pádel | `padel` (games, tope 7) | Games como unidad (sin cambios) | 2-0 · igual |
| Tenis | `tenis` (2 de 3, tie-break a 7 en 6-6), `tenis_super` (3.º set = super tie-break a 10) | **Puntos 15-30-40-AD**, games y tie-break se cuentan solos; sets se muestran «6-4 · 7-6(4) · [10-8]» | 2-0 · pts, ratio sets, ratio **games** (PF/PA = games), directo |
| Beach tennis | `beach_tennis` (1 set), `beach_tennis_3` (2 de 3), punto de oro | Como tenis, con punto de oro a 40-40 | 2-0 · igual que tenis |
| Ajedrez | `ajedrez` | Tres botones: **1-0 · ½-½ · 0-1** (blancas = local). Marcador en medios puntos (2-0, 1-1, 0-2); en eliminatoria tablas → armagedón | 1 · ½ · 0 · pts, directo, victorias, luego **Buchholz y Sonneborn-Berger** (`extra_tiebreakers`) |
| Bochas | `bochas` (a 12), `bochas_13` (a 13) | Un solo «set» a 12/13 con diferencia de 1 (+1 por bocha) | 2-0 · pts, ratio puntos, directo |
| Críquet | `criquet` (20 overs) | Manual por innings: runs / wickets / overs por equipo; gana quien más runs; empate posible; en eliminatoria «super over» | 2-1-0 · pts, victorias, diferencia de runs, directo |
| Videojuegos | `videojuegos_mapas` (mejor de 3), `videojuegos_mapas_5`, `videojuegos_goles` (FIFA) | Mapas: cada toque = un mapa ganado. FIFA: goles con empate | Mapas 3-0 · pts, victorias, ratio mapas, directo. FIFA 3-1-0 |
| Deporte genérico | `generico` (con empate 3-1-0), `generico_sin_empate` (2-0) | Marcador numérico libre | Según plantilla · pts, DG, GF, directo |
| Atletismo | — (modo **ranking por marca**, no «A vs B») | `MarksScorer`: marca por participante (tiempo, distancia, altura, puntos), hasta 3 intentos, DNS/DNF/DQ | Posición por marca; puntos por posición (10-8-6-5-4-3-2-1); tabla por delegación sumando pruebas |

Lo que no cabe en la secuencia de puntos va en `live_state.detail` (`penalties: [local, visitante]`, `innings: [{ side, runs, wickets, overs }]`); solo lo cambia «corregir». El servicio en vivo ya lo guarda y lo lee (`stateOf` y `p_live_state`).

### Pendiente para «datos» (no editado por este agente)
1. `standings.shared.ts`: después de `order(...)`, si `cfg.extra_tiebreakers?.length`, llamar `orderWithExtraTiebreakers(rows, matches, cfg)` (exportado por el motor) y devolver `buchholz` / `sonneborn_berger` en cada fila para mostrarlos en la tabla de ajedrez.
2. Mostrar puntos de ajedrez con `formatHalfPoints(GF)` (GF está en medios puntos; `Pts` ya viene en 1 · ½ · 0). En tablas y tarjetas públicas («publico»): si `config.half_points`, el marcador 2-0 se muestra «1-0» y 1-1 «½-½».
3. Sets de tenis: `SetDto` trae `tb` y `super`; en `tournamentDisplay.formatSetsLine` mostrar «7-6(4)» y «[10-8]» (helper `setScoreText` exportado por `LiveScorer.tsx`).
4. Críquet: mostrar `live_state.detail.innings` como «156/7 (20)».
5. `PatchTournamentSchema` (events.route.ts) no acepta `competition_format`: el asistente pasa el formato elegido en la URL (`?formato=liga|grupos|copa&nuevo=1`) para que el detalle lo preseleccione en `FixtureGeneratorDialog`.
6. `POST /api/v1/events/school-tournament` exige fecha, hora, dirección y ciudad: el asistente manda valores de borrador (fecha +14 días, 08:00, «Por definir»). Si se vuelven opcionales, quitar esos valores en `tournamentWizard.logic.ts`.
7. El motor en vivo (`/tournament-live/school/:id/...`) solo atiende torneos de escuela; el organizador crea con `POST /api/v1/events` y su plantilla queda en la URL (`&reglas=`) hasta que exista un endpoint de config para organizador.
8. Gate: el frontend lo concentra en `frontend/src/lib/tournaments/tournamentAccess.ts` (`useTournamentAccess` / `tournamentAccessFor`). `CreateTournamentPage` aún usa `hasAddon('tournaments')` directo: cambiarlo al helper al integrar. En el BFF el gate sigue en `POST /school-tournament` (`v_school_entitlements.has_tournaments`).

### Asistente rápido de creación
`frontend/src/components/tournaments/create/TournamentWizard.tsx` (lógica pura en `tournamentWizard.logic.ts`). Rutas: `/school/tournaments/nuevo-rapido` (admin de la escuela) y `/organizer/torneo-rapido` (organizador). Para enchufarlo: botón «Crear torneo» de la sección Torneos → `/school/tournaments/nuevo-rapido`. Cuatro pasos de una pantalla: nombre → tipo («Un solo torneo» = categoría General; «Con categorías» con sugerencias por edad y rama) → deporte (19, con emoji; si hay varias plantillas, se elige) → formato («Todos contra todos» = `liga`, «Grupos + eliminatoria» = `grupos`, «Eliminatoria» = `copa`; «Puedes cambiarlo después»). Crea en borrador, guarda la plantilla con `PATCH /tournament-live/school/:id/config {preset}` y lleva al detalle. No asume deportistas de la escuela: los equipos (internos o invitados) se agregan después.

### Planilla de juego (PDF)
`components/tournaments/planilla/`: `planillaModel.ts` (qué tablas lleva cada deporte, puro), `planillaPdf.ts` (jsPDF, A4) y `<PlanillaPartidoButton match tournamentTitle sport loadRoster />`. Precargada con equipos, fase, cancha, hora y nómina (`GET /events/school-tournaments/:id/matches/:matchId/rosters`, solo organizador) o en blanco sin `match`. Voleibol: nóminas, sets con tiempos y cambios, rotaciones I-VI por set. Fútbol / balonmano / hockey: nóminas con goles y tarjetas, resultado por tiempo y penales, goles, tarjetas, cambios. Baloncesto: faltas F1-F5, puntos por cuarto, faltas de equipo y tiempos muertos. Raqueta: sets con tie-break y quién saca. Ajedrez: planilla de 80 jugadas y resultado. Críquet: bateo, resumen por innings y lanzadores. Atletismo: prueba con intentos y posición. Ya está en el anotador; falta ponerlo en cada partido del panel (`SchoolTournamentDetailPage` / `TournamentResultsPanel`, de «datos»).

### Atletismo: ranking por marca
Motor puro `bff/src/services/tournament/marks.shared.ts` (copia `frontend/src/lib/tournamentMarks.ts`, con paridad): `rankByMark(entries, { unit, points_by_position })`, `teamPoints`, `parseMark` («10,52», «1:02.35», «6.45 m»), `formatMark`. Reglas: tiempo menor es mejor y el empate comparte posición; distancia desempata con la segunda mejor marca, luego la tercera; altura con menos fallos en la altura ganada y luego totales; DNS/DNF/DQ/NM sin posición. Los empatados se reparten los puntos de los puestos que ocupan. Anotador `MarksScorer.tsx` (controlado, sin guardar todavía).

**Persistencia (siguiente fase, sin migración escrita):** tabla `tournament_mark_events` (event_id, category_id, name, unit text CHECK in ('time','distance','height','points'), attempts int, points_by_position int[], status text CHECK) y `tournament_marks` (mark_event_id, team_id → tournament teams, participant_name, marks jsonb, status text CHECK, failures_at_best, failures_total, version). RLS: lectura pública solo si el evento es público (vía vista con columnas publicables, como `v_school_staff_publico`); escritura solo por RPC `SECURITY DEFINER` con `user_staff_school_ids()` sobre la escuela del evento o por token de anotador, con `SET search_path = pg_catalog, public, pg_temp` y `GRANT EXECUTE` explícito. Endpoints: `GET/PUT /tournament-live/school/:id/mark-events/:meId/marks` y la versión con token del anotador.


## Datos y administración (agente «datos», 2026-10-27)

Migraciones **escritas, sin aplicar** (las aplica la sesión principal, en este orden, después de `20261027180907` de «vivo»):

| Migración | Qué hace |
|---|---|
| `20261027180825_torneos_equipos_externos_logos_copas` | `event_teams.delegation_id` NULL-able + `is_external`, `club_name`, `short_name` (≤4), `logo_url`; CHECK externo ⇔ sin delegación; único por nombre en la categoría para externos. `events`: `logo_url`, `end_date`, `rules_url`, `venue_name`, `venue_maps_url`, `organizer_name` (portada = `banner_url`). `tournament_sponsors`. `tournament_matches.cup_label`. RPC `reschedule_tournament_match` (cambio + log). Helper `is_event_school_admin()` (usa `user_admin_school_ids()`). Cierra el `FOR ALL` sin `WITH CHECK` de `teams_school_manage`. |
| `20261027191314_torneos_jugadores_carnes_adjuntos` | `event_team_members` para externos (delegation_id NULL-able + `is_external`) y ficha (apodo, posición, número, nacimiento, teléfono, foto, `extra` jsonb, suspensión, `card_version`). `events.player_form`, `card_config`, `attachments`. `tournament_team_invites` (link del delegado, hash del token, avance, consentimiento, prospecto `lead_origin='torneo'`). Cierra el `FOR ALL` sin `WITH CHECK` de `members_school_manage`. |

**Por qué columna y no tabla aparte para los externos:** `tournament_matches.home/away_team_id` ya apuntan a `event_teams`; con una columna el sorteo, la tabla y el avance de llaves tratan igual a internos y externos, sin FK polimórfica. Las fotos y logos van al bucket existente `school-assets` (carpeta `logos/<school_id>/…`, escritura solo del admin; el delegado sin cuenta sube con URL firmada del BFF). No se reutiliza `school_signup_leads` para los prospectos: esa tabla es de prospectos *de una escuela* (alumnos con clase de prueba), no de clubes para SportMaps.

**Permisos del organizador:** un solo lugar, `bff/src/services/tournament/tournament-access.ts` (`assertTournamentOrganizer` / `schoolOrganizesTournament`). Hoy = admin de la escuela dueña; el rol organizador entra cambiando solo ese archivo. Lo público, el anotador y el link del delegado no pasan por `school_members`. (`tournament-follow.route.ts` de «vivo» todavía tiene su propio `ownedEvent`: conviene que lo importe de ahí al integrar.)

**BFF compatible antes de aplicar:** las lecturas caen a las columnas viejas si PostgREST responde columna inexistente (`42703` / `PGRST204`); crear y editar torneos omiten la identidad nueva. Lo nuevo (externos, jugadores, patrocinadores, links) sí exige las migraciones.

### Endpoints nuevos (`/api/v1/tournament-live`)
- Organizador: `GET/POST/PATCH/DELETE /school/:id/teams…` (externos: `POST /teams/external` uno o lista), `…/sponsors`, `PATCH /school/:id/matches/:matchId/schedule` (hora y cancha, log `reschedule`), `GET/PUT /school/:id/player-form`, `GET/POST /school/:id/teams/:teamId/players`, `POST …/players/from-school`, `GET /school/:id/school-athletes`, `PATCH/DELETE /school/:id/players/:pid`, `POST …/reissue-card`, `GET/PUT /school/:id/card-config`, `GET /school/:id/cards`, `POST /school/:id/roster-photo` (OCR, no guarda), `GET /school/:id/invites`, `POST /school/:id/teams/:teamId/invite`, `POST …/invites/:iid/revoke`, `PATCH …/invites/:iid/payment`, `GET …/invites/:iid/proof`.
- Delegado sin cuenta (token): `GET /invite/:token`, `PATCH /invite/:token/team`, `POST/DELETE /invite/:token/players…`, `POST /invite/:token/upload-url` (logo, foto o comprobante), `POST /invite/:token/roster-photo`, `POST /invite/:token/submit` (reglamento + consentimiento obligatorios).
- Público: `GET /public/:slug/validate/:token` (validación en cancha: nombre de pila, foto si se permite, equipo, categoría, `habilitado|no_habilitado` con razones; nunca documento, teléfono ni nacimiento; `no-store`).
- `PATCH /api/v1/events/school-tournaments/:id` acepta además `logo_url`, `banner_url`, `end_date`, `rules_url`, `venue_name`, `venue_maps_url`, `organizer_name`, `attachments[{name,url}]` y `slug` (único, 409 `slug_en_uso`). `PUT …/categories` **conserva los ids** (antes borraba y reinsertaba y dejaba equipos/partidos/inscripciones con `category_id` NULL); quitar una categoría en uso da 409.

### Motor
- **Varias copas:** `format_config.cups = [{ label, positions, third_place? }]` en «grupos»; cada copa es un cuadro con su `cup_label`; el ganador y el 3.º puesto avanzan solo dentro de su copa.
- **Desempates de vóley:** `set_diff`, `point_diff`, `set_ratio`, `point_ratio` en cada fila y como claves de `tiebreakers` (validadas). Cociente `null` = nada en contra («MAX»).
- **Reglas por categoría:** `scoring_config.by_category[catId]` validado; no se cambia goles↔sets en una categoría con marcador; elegir otra plantilla del torneo conserva `by_category`.

### Payload público v2 — `GET /api/v1/tournament-live/public/:slug/live`
Agrega sin quitar nada (caché 5 s + ETag igual que antes). `tournament` es el mismo objeto que `event`.

```json
{
  "payload_version": 2,
  "event": { "…": "igual que tournament" },
  "tournament": {
    "id": "8f0c…", "title": "Copa Monster 2026", "sport": "Voleibol", "city": "Medellín", "event_date": "2026-11-07",
    "school_name": "Monster Volley", "live_enabled": true, "stream_url": "https://youtu.be/abc", "format": "grupos",
    "status": "in_progress",
    "start_date": "2026-11-07", "end_date": "2026-11-08",
    "cover_url": "https://<proyecto>.supabase.co/storage/v1/object/public/school-assets/covers/<school>/torneos/<id>/portada.jpg",
    "logo_url": "https://<proyecto>.supabase.co/storage/v1/object/public/school-assets/logos/<school>/torneos/<id>/logo.png",
    "organizer_name": "Monster Volley",
    "rules_url": "https://drive.google.com/reglamento",
    "venue": { "name": "Coliseo Iván de Bedout", "address": "Cra 70 #1, Medellín", "maps_url": "https://www.google.com/maps/search/?api=1&query=6.25,-75.59" },
    "sponsors": [ { "id": "s1", "name": "Bebidas El Nevado", "logo_url": "https://…/sp.png", "url": "https://elnevado.co/", "tier": "principal" } ],
    "attachments": [ { "name": "Programación", "url": "https://drive.google.com/programacion.pdf" } ]
  },
  "categories": [ { "id": "c-sub14", "name": "Infantil · A · Sub 14 · Femenina" } ],
  "teams": [
    { "id": "t1", "name": "Monster A", "category_id": "c-sub14", "short_name": "MON", "logo_url": "https://…/mon.png", "is_external": false, "club_name": "Monster Volley" },
    { "id": "t2", "name": "Halcones", "category_id": "c-sub14", "short_name": "HAL", "logo_url": null, "is_external": true, "club_name": "Club Halcones" }
  ],
  "matches": [
    {
      "id": "m9", "category_id": "c-sub14", "stage": "knockout", "group_label": null, "cup_label": "Copa oro", "round": 1, "slot": 1,
      "home_team_id": "t1", "away_team_id": "t2", "home_name": "Monster A", "away_name": "Halcones",
      "home_label": null, "away_label": null, "is_bye": false,
      "home_score": 2, "away_score": 1, "status": "played", "scheduled_at": "2026-11-08T14:00:00.000Z", "court": "Cancha 1",
      "started_at": "…", "finished_at": "…", "sets": [ { "home": 25, "away": 20, "closed": true, "deciding": false } ], "model": "sets",
      "home_logo_url": "https://…/mon.png", "away_logo_url": null, "home_short_name": "MON", "away_short_name": "HAL"
    }
  ],
  "standings": {
    "c-sub14": {
      "model": "sets", "standings": [],
      "groups": { "A": [ {
        "team_id": "t1", "team_name": "Monster A", "P": 3, "W": 3, "D": 0, "L": 0, "GF": 6, "GA": 1, "GD": 5, "Pts": 8,
        "SW": 6, "SL": 1, "PF": 160, "PA": 120, "set_diff": 5, "point_diff": 40, "set_ratio": 6, "point_ratio": 1.333,
        "logo_url": "https://…/mon.png", "short_name": "MON", "is_external": false
      } ] }
    }
  },
  "player_stats": [ { "member_id": "p1", "name": "Ana", "team_id": "t1", "ace": 3, "attack": 7, "block": 1, "points": 11 } ],
  "server_time": "2026-11-08T15:02:11.000Z"
}
```

`status` se deriva (no hay columna): `draft` → borrador; `cancelled` → cancelado; `completed` o todos los partidos reales terminados → `finished`; algún partido en juego o jugado → `in_progress`; si no, `published`. Los equipos y filas nunca traen datos de personas; los jugadores solo salen con nombre público en `player_stats`.

### Pendiente
- Pasarela de pago en el link del delegado: hoy es «Pago por transferencia» con comprobante que el organizador confirma.
- Código de verificación por WhatsApp/correo para el delegado: hoy basta el token.
- Marcas de atletismo (`MarksScorer` de «deportes»): sin tablas ni endpoints todavía.
- Motor en vivo para torneos del ORGANIZADOR (rol `organizer`, sin escuela): `requireAuth` exige membresía en `school_members`, así que las rutas `/school/:id/*` no lo dejan pasar. Hace falta un middleware de organizador y abrir `assertTournamentOrganizer` (tournament-access.ts) para `events.creator_id`; mientras, el asistente deja la plantilla en `&reglas=`.
- `tournament-follow.route.ts` aún tiene su propio `ownedEvent`: cambiarlo por `assertTournamentOrganizer`.
- Al llegar con `?formato=` al detalle, abrir el generador con ese formato preseleccionado (el alta ya guarda `competition_format`).
