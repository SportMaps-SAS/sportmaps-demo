# Partido en vivo — iniciar, sustituir, terminar, minutos por jugador e informe automático

> **Estado: F0 (spec). Sin código, sin migraciones.** Las migraciones solo se escriben después de
> aprobar el plan de la Fase 1 (convención del repo: *plan antes de código en migraciones*).
> Las decisiones abiertas están en el §13 con una recomendación en cada una.
>
> **Origen:** Club Carmel (`374a6716-af42-4745-afe1-8d089153e01b`). Julián, el coordinador, hoy
> redacta a mano por WhatsApp el informe de cada partido: quién jugó, cuántos minutos, cuándo
> entró cada cambio, cómo quedó. Está en `docs/plan-semana-2026-11-04.md` §5, ítem 1 («Partidos en
> vivo (Carmel): spec primero»). Va **detrás de un flag solo para Carmel**, igual que el Frente B.
>
> **Base:** `docs/specs/partidos-registro-y-evaluacion-por-jugador.md` (el partido, la
> convocatoria, la evaluación, el reporte). Este spec **no reemplaza** nada de eso: agrega la capa
> «en vivo» encima de `match_results` y alimenta lo que ya existe.

---

## 1. El problema

El partido de Carmel se juega en una cancha, con el celular del cuerpo técnico, a veces con mala
señal, y con cambios libres (en fútbol formativo los jugadores entran y salen varias veces). Hoy
SportMaps solo sabe lo que se digita **después**: marcador, convocados, y un campo
`minutes_played` que nadie calcula. El minuto de cada jugador sale de la memoria de alguien, y el
informe termina en un mensaje de WhatsApp escrito a mano.

Lo que se quiere:

1. **Iniciar** el partido con un toque (cuando el árbitro pita), con los titulares ya definidos.
2. **Sustituir** con dos toques (quién sale, quién entra) y que el sistema ponga el minuto.
3. **Terminar** el partido (o cada tiempo) con un toque.
4. **Tiempo jugado por jugador automático**, también si entra y sale varias veces.
5. **Tres tiempos** (Carmel juega por tiempos en varias categorías) y que el «45» se ajuste:
   la duración de cada tiempo es configurable por categoría y se puede cambiar el día del partido.
6. **% jugado** por jugador (cuánto del partido estuvo en cancha).
7. **Informe automático al finalizar**, que reutilice el reporte del partido que ya existe y que
   Julián pueda **copiar para WhatsApp**.

## 2. Qué existe HOY (verificado en repo y en migraciones, 2026-11-05)

| Pieza | Dónde | Estado real |
|---|---|---|
| Partido | `match_results` (ampliada en `20260926131340`: `school_id`, `status` scheduled/played/cancelled, `kickoff_at`, `location`, `calendar_event_id`, `evaluation_published_at`…) | Sirve de ancla. **No tiene** estado «en juego» ni reloj. |
| Pantalla única del partido | `frontend/src/components/partidos/PartidoFlujo.tsx` (960 líneas) + `usePartidoData.ts`, ruta `/partidos/:id` | Pasos Programar → Convocar → Resultado → Evaluar → Reporte (§9 del spec de partidos, 2026-10-26). **No hay paso «En vivo».** |
| Convocatoria | `ConvocatoriaPartido.tsx` (coach V2) + RPC `save_match_roster(p_match, p_players jsonb)` (versión viva: `20261025003647`) | Arma `match_lineups` + `match_lineup_players` (`role` starter/bench, `position_code`, `jersey_number`, `minutes_played`). Convocar **refuerzos de otra categoría** ya funciona (commit `4475fe38`, 2026-11-03: buscador en toda la escuela). **Ojo: la RPC hace `DELETE` de todos los `match_lineup_players` del partido y los reinserta.** |
| Minutos | `match_lineup_players.minutes_played integer CHECK (>= 0)` | La columna existe. `coachV2Logic.ts` solo **conserva** el valor previo al reconvocar; no encontré ninguna pantalla que lo calcule ni que lo pida (el merge `725bd0fc` lo menciona en el mensaje, pero en el código solo veo la columna y el arrastre). Hoy queda `null`. |
| Goles / tarjetas | `football_match_events` (`type` goal/own_goal/yellow/red/assist, `minute integer`), BFF `school/football.ts` | Con `minute` ya en el modelo. Es el registro del entrenador; no toca los torneos. |
| Evaluación | `performance_entries` (`context_type='competition'`, `context_id = match_results.id`), RPCs `submit_match_evaluation` / `publish_match_evaluation`, criterios `school_metric_definitions` | Funciona. Es **el lugar donde deben llegar los minutos**, no un modelo nuevo. |
| Reporte del partido | `match_reports` (`summary`, `development`, `improvements`, `admin_comment`, `published_at`) + RPCs de guardar/publicar + `match_report_replies`; `MatchReportDialog.tsx` (264 líneas); flag `school_settings.share_match_reports` (default false, migración `20261022110209`) | Es el **informe que Julián escribe a mano**. Tres cuadros de texto libre. Publicar junta reporte del entrenador y comentario de administración. |
| Alineación / pizarra | `match_lineups.formation` (text), `match_lineups.arrows` (jsonb, `20260919195137`), `position_code` solo fútbol (arquero/defensa/medio/delantero) | Datos reutilizables: formación y posición de cada titular. Para el en vivo basta `position_code` + `jersey_number`; la pizarra con pases/tiros secuenciales es «fase posterior» del plan de Carmel y **no se mezcla aquí**. |
| Flags por escuela | Patrón `school_settings.<col> boolean NOT NULL DEFAULT false` + `UPDATE` para Carmel + columna **al final** de `v_school_entitlements` (ej. `allow_secondary_team_enrollment`, `20260924101138`; la vista viva termina en `coach_attendance_retro_days`) | Se reutiliza tal cual. |
| Offline / cola | No hay cola offline de escrituras en el frontend para partidos | Se decide en §13 (D-V3). |
| Idempotencia | No existe un patrón de `client_event_id` en partidos | Nuevo (§4.3). |

**Resultado:** el partido, la convocatoria, los goles con minuto, la evaluación y el reporte ya
existen. **Lo que falta es solo el reloj y el registro de entradas/salidas**, y el cálculo que
convierte eso en `minutes_played`, % y texto del informe.

## 3. Alcance y no-alcance

**Entra (v1):** un solo «director del partido» por partido que maneja reloj y cambios desde su
celular; hasta 3 tiempos con duración configurable; cambios libres con reingreso; goles y tarjetas
con el minuto del reloj; minutos y % por jugador; informe borrador + copia para WhatsApp; flag solo
Carmel.

**No entra (v1):** transmisión en vivo a las familias (el marcador en vivo está en «fuera de
alcance» del spec de partidos, y se mantiene); varios dispositivos escribiendo a la vez; estadística
avanzada (pases, tiros); video; cambios de posición dentro de la cancha (solo quién está dentro o
fuera); deportes distintos de fútbol (el modelo es genérico, la UI de v1 solo se prueba en fútbol).

## 4. Modelo de datos propuesto (conceptual; el DDL real va en el plan de la Fase 1)

Regla del repo: estados con `text + CHECK`, no `CREATE TYPE`; FKs de negocio a `public.profiles(id)`;
`school_id` en cada tabla para que la RLS no dependa de un JOIN.

### 4.1 Configuración (dónde vive el «45»)

**Pieza A — por categoría (valor por defecto).** Columnas nuevas en `teams` **o** tabla
`team_match_format` (ver D-V2; recomendado tabla aparte para no tocar `teams`, que usan todas las
escuelas):

```
team_match_format (team_id PK→teams, school_id, 
   periods_count   int  CHECK (1..4)   -- 2 ó 3 en Carmel
   period_minutes  int  CHECK (5..60)  -- duración planificada por tiempo (el «45»)
   break_minutes   int  NULL           -- informativo
   rolling_subs    bool DEFAULT true   -- reingreso permitido
   updated_by, updated_at)
```

**Pieza B — por partido (la que manda el día del partido).** Se **copia** del formato de la categoría
al iniciar y vive en el estado en vivo, de modo que cambiar el formato de la categoría mañana no
reescribe partidos ya jugados.

### 4.2 Estado en vivo del partido (1:1 con `match_results`)

```
match_live (
  match_id        uuid PK → match_results(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL,
  status          text NOT NULL CHECK (not_started | in_period | on_break | finished | voided),
  periods_planned int  NOT NULL,           -- copiado del formato
  period_seconds  int  NOT NULL,           -- duración planificada de cada tiempo (puede ajustarse, §7.3)
  current_period  int  NOT NULL DEFAULT 0, -- 0 = no empezó
  director_id     uuid NOT NULL → profiles(id),  -- el único que escribe (D-V4)
  started_at, finished_at timestamptz,
  finished_by uuid, reopened_at timestamptz,
  updated_at timestamptz
)

match_live_periods (
  match_id, period_no int,                 -- PK (match_id, period_no)
  planned_seconds int NOT NULL,            -- el «45» de ese tiempo, ajustable
  started_at timestamptz,                  -- hora de pared del pitazo inicial
  ended_at   timestamptz,                  -- hora de pared del pitazo final
  actual_seconds int,                      -- duración real jugada = lo que mide el reloj
  stoppage_seconds int GENERATED/derivado  -- max(0, actual - planned): el tiempo añadido
)
```

`actual_seconds` se guarda al cerrar el tiempo (no se recalcula con `now()` después), así el
histórico no cambia aunque alguien edite la hora del servidor.

### 4.3 Eventos (la fuente de verdad) con idempotencia

```
match_live_events (
  id              uuid PK DEFAULT gen_random_uuid(),
  match_id        uuid NOT NULL, school_id uuid NOT NULL,
  client_event_id uuid NOT NULL,          -- lo genera el celular al tocar el botón
  type            text NOT NULL CHECK (period_start | period_end | sub | red_card
                                       | clock_adjust | match_end | match_reopen),
  period_no       int,
  game_second     int NOT NULL CHECK (>= 0),  -- segundos de JUEGO transcurridos (sin descansos)
  subject_out_*   (subject_type, subject_id) NULL,  -- quien sale
  subject_in_*    (subject_type, subject_id) NULL,  -- quien entra
  reason          text NULL CHECK (tactical | injury | other),  -- solo type='sub'
  payload         jsonb NULL,             -- ej. {planned_seconds: 1500} en clock_adjust
  client_at       timestamptz,            -- hora del celular (auditoría; no se confía para el minuto)
  created_by      uuid → profiles(id), created_at timestamptz DEFAULT now(),
  voided_at timestamptz, voided_by uuid   -- deshacer = anular, nunca DELETE (D-V6)
  UNIQUE (match_id, client_event_id)      -- idempotencia: el doble toque / el reintento NO duplica
)
```

`subject_type` ∈ `profile | child | unregistered` (mismo CHECK que `match_lineup_players`).

**Goles y tarjetas** no se duplican: siguen en `football_match_events`; en el modo en vivo se
escriben con el minuto que da el reloj (`ceil(game_second / 60)`, ver §7.1). Una **roja** se registra
en `football_match_events` (type `red`, como hoy) **y** genera un evento `red_card` en `match_live_events`
para cerrar el tiempo del jugador en la misma transacción (§7.4).

### 4.4 Tramos de cancha (derivado, materializado)

```
match_player_stints (
  match_id, school_id, subject_type, subject_id,
  period_no int,
  in_second  int NOT NULL,     -- game_second de entrada (0 = titular)
  out_second int NULL,         -- NULL = sigue en cancha
  ended_by   text CHECK (sub | period_end | red_card | match_end | injury_close),
  in_event_id uuid, out_event_id uuid
)
```

Un tramo **no cruza** de un tiempo a otro (al terminar el tiempo, el tramo se cierra con
`period_end` y al empezar el siguiente se abre otro para quienes siguen). Eso hace los cálculos por
tiempo triviales (minutos por tiempo y total) y permite sustituir en el descanso sin tocar el reloj.
Es derivado de los eventos: si hubiera discrepancia, **manda `match_live_events`** y una función
`rebuild_match_stints(p_match)` lo regenera.

### 4.5 Qué se escribe en lo que ya existe (sin tablas paralelas)

| Al terminar | Va a |
|---|---|
| Minutos por jugador (entero) | `match_lineup_players.minutes_played` (columna existente) |
| Marcador final | `match_results.home_score/away_score` + `status = 'played'` |
| Goles/tarjetas | ya en `football_match_events` |
| Texto del informe | `match_reports.summary/development` (borrador, §9) |
| Minutos + % + tramos | **solo** `match_player_stints` y la función de lectura `match_live_report(p_match)` (no se agregan columnas a `match_lineup_players` salvo D-V8) |

Columnas nuevas **mínimas** en `match_results`: `live_enabled boolean DEFAULT false` no hace falta
(el estado vive en `match_live`); si se quisiera listar «partidos en juego» sin JOIN, se agrega
`match_results.is_live boolean` mantenido por las RPCs (D-V9, opcional).

## 5. RPCs (todas `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `GRANT EXECUTE … TO authenticated` explícito, sin `anon`)

Cada RPC valida **adentro**: usuario autenticado; el partido existe; `school_id = ANY (user_staff_school_ids())`
(o `is_platform_admin()`); y que el flag de la escuela esté prendido (`school_settings.live_match_enabled`,
§11). Para las que escriben eventos, además `auth.uid() = match_live.director_id` (o admin de la escuela,
para rescatar un partido, D-V4). Multi-fila = RPC transaccional: ningún paso hace N inserts sueltos
desde el cliente.

| RPC | Hace (en una transacción) |
|---|---|
| `start_live_match(p_match, p_options jsonb)` | Verifica convocatoria con ≥ 1 titular. Crea `match_live` (copiando `team_match_format` o `p_options`), crea los `match_live_periods` previstos, fija `director_id = auth.uid()`, pone `match_results.status` en `'scheduled'` aún (se pasa a `played` al terminar) y bloquea la reconvocatoria destructiva (§8.3). **No** inicia el reloj: solo deja listo. Idempotente por `match_id`. |
| `apply_live_events(p_match, p_events jsonb)` | **La RPC de escritura única.** Recibe un arreglo de eventos con `client_event_id`, los inserta con `ON CONFLICT (match_id, client_event_id) DO NOTHING` y los **aplica en orden de `game_second`** actualizando `match_live`, `match_live_periods` y `match_player_stints` en la misma transacción. Devuelve el estado resultante (quién está en cancha, reloj, tiempo añadido). Un lote con un evento inválido **se rechaza entero** (nada a medias) con el error del evento culpable. Sirve igual para 1 evento (online) que para una cola acumulada (offline). Reglas de validación en §7. |
| `finish_live_match(p_match, p_home_score, p_away_score)` | Cierra el tiempo abierto si lo hay, cierra tramos abiertos con `match_end`, calcula minutos y los escribe en `match_lineup_players.minutes_played` **con una sola sentencia**, pone el marcador y `status='played'`, genera el borrador del informe (§9) **solo si** `match_reports` está vacío, y deja `match_live.status='finished'`. Idempotente: llamarla dos veces no duplica nada. |
| `reopen_live_match(p_match)` | Solo admin de la escuela (`user_admin_school_ids()`): deshace `finished` (por si el director terminó por error). Registra `match_reopen` y `reopened_at`. No borra el informe ya editado. |
| `void_live_event(p_match, p_event uuid)` | Marca `voided_at/voided_by` (deshacer el último cambio o gol mal puesto) y recalcula tramos con `rebuild_match_stints`. Regla: se puede anular cualquier evento del partido mientras no esté `finished`. |
| `match_live_report(p_match)` | **Solo lectura** (`STABLE`): devuelve `jsonb` con tiempos, tramos, minutos, % por jugador, goles/cambios en orden cronológico. Es lo que consume el informe, la pantalla de resultados y el copiar-a-WhatsApp. Con el mismo gate de lectura de staff. |
| `set_team_match_format(p_team, p_periods, p_period_minutes, …)` | Escritura de configuración. Solo `user_admin_school_ids()` (el formato lo define la administración, igual que los criterios de evaluación en D3). |

Helpers internos (`_live_minute_of`, `_close_open_stints`, `rebuild_match_stints`): **no** llevan `GRANT`
a nadie; `REVOKE ALL … FROM PUBLIC, anon, authenticated` explícito (regla del repo para helpers que solo
llama otra `SECURITY DEFINER`).

**Choque con `save_match_roster`:** esa RPC borra y reinserta todos los jugadores del partido. Una vez
existe `match_live` con `status <> 'not_started'`, **no puede ejecutarse** (la reconvocatoria
borraría minutos y orfanaría tramos). Cambio mínimo en una **migración nueva** que redefine la función
(`CREATE OR REPLACE`, cuerpo vivo copiado de `20261025003647` + el chequeo): si hay `match_live` iniciado,
lanza `P0001 «El partido ya empezó; use los cambios en vivo»`. Y para sumar un refuerzo de última hora
(algo que pasa en Carmel), una RPC pequeña `add_live_callup(p_match, subject…)` que **agrega** una fila
en `match_lineup_players` (bench) sin tocar las demás. (Decisión D-V7.)

## 6. Pantallas — el flujo de cancha, paso a paso

Principios de UX móvil (el cuerpo técnico usa una mano, al sol, de pie):

- **Botones grandes** (alto mínimo 56 px, objetivo táctil ≥ 48 px), contraste alto, sin menús ocultos.
- **Una pantalla, tres zonas fijas:** arriba el reloj y el marcador; en medio «En cancha» y «Banca»;
  abajo la barra de acciones (`Cambio`, `Gol`, `Tarjeta`, `Pausar/Terminar tiempo`).
- **Pantalla encendida:** `navigator.wakeLock` mientras el partido está en juego (se avisa si el
  navegador no lo soporta).
- **Cada acción con confirmación visible y deshacer 8 s** («Cambio hecho · Deshacer»); un cambio mal
  puesto no obliga a abrir menús.
- **El reloj lo calcula el dispositivo** a partir de un ancla (`period.started_at` + segundos de pausa);
  no depende de la señal para seguir contando.

### 6.1 Antes del pitazo (paso «En vivo» en `PartidoFlujo`)
1. El paso **Convocar** ya existe. Se agrega el paso **En vivo** (visible solo si el flag está prendido para la
   escuela y el partido tiene convocatoria).
2. Pantalla **Preparar**: lista de convocados con los **titulares** marcados (toque para alternar titular/banca),
   número de camiseta, y un resumen del **formato**: «3 tiempos de 25′» con botón **Ajustar** (cambia
   `periods_planned` / `period_seconds` solo para este partido, §7.3).
3. Botón grande **Iniciar partido** → `start_live_match`. El celular queda como **director** (se muestra
   «Eres el director de este partido»).

### 6.2 En juego
4. Botón grande **Pitazo inicial (Tiempo 1)** → evento `period_start` con `game_second = 0`. El reloj arranca.
5. **Cambio:** botón `Cambio` → se abre una hoja inferior con dos listas: **Sale** (los de «En cancha») y
   **Entra** (los de «Banca» + los que ya salieron si `rolling_subs`). Se eligen dos jugadores y se pulsa
   **Confirmar cambio**. El minuto lo pone el reloj, **no se digita**. (Si el director olvidó registrar un
   cambio, puede indicar «hace N minutos»: ajusta `game_second` hacia atrás con límite al inicio del tiempo.)
   - Un jugador que sale pasa de «En cancha» a «Banca» (con el tiempo acumulado visible, ej. `32′`).
   - Cambio múltiple: se pueden encadenar varios sin cerrar la hoja; cada uno es un evento propio y atómico.
6. **Gol / Tarjeta:** botones `Gol propio / rival`, `Amarilla`, `Roja`; el gol a favor pide solo el goleador
   (y asistente opcional) de los de «En cancha». El rival no se desglosa por jugador (solo el marcador).
   La **roja** saca al jugador de la cancha (§7.4) sin pedir sustituto.
7. **Terminar tiempo** → `period_end`. El reloj se detiene; aparece el **tiempo añadido** que se jugó
   (`+3′`). Estado `on_break`.
8. **Descanso:** se pueden registrar cambios (quedan en `game_second` = final del tiempo anterior) y se
   pulsa **Pitazo inicial (Tiempo 2)**. Igual para el tercero.

### 6.3 Final
9. **Terminar partido** (en el último tiempo, o antes si el partido se suspende) → confirma el marcador
   (precargado por los goles; editable) → `finish_live_match`.
10. Pantalla **Resumen**: marcador, tiempos (con el añadido), tabla **jugador · minutos · % · cambios**, y
    cronología. Botones: **Revisar informe** (abre `MatchReportDialog` con el borrador) y
    **Copiar para WhatsApp**.
11. Desde ahí el flujo vuelve al paso **Evaluar** que ya existe, ahora con minutos ya cargados (§9.4).

### 6.4 Estados raros que la pantalla debe cubrir
- **Reabrir:** si el director cerró por error, la administración puede `reopen_live_match`.
- **Otro dispositivo abre el partido:** entra en modo lectura con el reloj y la alineación en vivo
  (se refresca cada 15 s o por Realtime); quien quiera tomar el control lo pide a la administración (D-V4).
- **Se cae la señal:** banner «Sin conexión · los cambios se guardan en el celular» y contador de pendientes
  (§8.2). Al volver, sincroniza solo y quita el banner.

## 7. Cálculo de minutos (lo más delicado)

### 7.1 Unidad base: segundos de juego, no de reloj de pared
`game_second` mide **tiempo transcurrido de juego dentro del partido**, **sin** contar descansos. El reloj de
pared solo ancla cada tiempo (`started_at`). Se prefiere **segundos** para no acumular error de redondeo; el minuto
mostrado es derivado.

Minuto mostrado de un evento (gol, cambio): `ceil(game_second / 60)`, con la convención del fútbol («a los 7′
cuando van 6:01 a 7:00»). Cuando supera la duración planificada del tiempo, se muestra `45+3′`.

### 7.2 Tiempo jugado por jugador
```
segundos_jugados(jugador) = Σ (out_second − in_second) de sus tramos, con out_second = actual_seconds
                            del tiempo si el tramo sigue abierto al cerrar el tiempo
minutos (entero a guardar en minutes_played) = round(segundos_jugados / 60)
                            (mínimo 1 si segundos_jugados > 0; 0 si nunca entró)
```
Para **tiempos adicionales y descansos** se maneja así: el reloj solo corre durante `in_period`;
`period_end` fija `actual_seconds` (incluye lo que el árbitro añadió). Un jugador que estaba en cancha al pitazo
final suma hasta ahí. **Entrar en el descanso** = tramo con `in_second = 0` del siguiente tiempo (no se pierde ni
se inventa tiempo). **Salir en el descanso** = tramo cerrado con `period_end` del anterior.

`minutes_played` guarda el entero para compatibilidad con lo que ya existe; **los segundos exactos viven en
`match_player_stints`** para quien necesite precisión.

### 7.3 «3 tiempos» y ajuste del «45»
- `periods_planned` (1–4) y `period_seconds` (planificado) se **copian de la categoría** (`team_match_format`) al
  iniciar y se pueden **ajustar el día del partido** desde «Ajustar» o durante el partido (evento
  `clock_adjust`, solo ajusta los tiempos que **no han empezado** o el actual si la liga lo cambia).
- **Los tiempos pueden ser distintos entre sí** (p. ej. 25′ + 25′ + 15′): `match_live_periods.planned_seconds` es
  por tiempo.
- **El partido dura lo que se jugó**, no lo planificado. Si el árbitro pita a los 41′ de un tiempo de 45′, ese tiempo
  vale 41′. Lo planificado solo sirve para mostrar el tiempo añadido y los avisos («faltan 5′»).
- El «45» es **solo un valor por defecto editable**; el sistema nunca asume 45.

### 7.4 % jugado
```
porcentaje(jugador) = segundos_jugados / duración_total_jugada_del_partido
duración_total_jugada = Σ actual_seconds de los tiempos jugados  (no el planificado)
```
Se redondea a entero para mostrar. Se calcula **solo al leer** (`match_live_report`) para que sea correcto
si un evento se anula o el partido se reabre. (Alternativa: % sobre lo planificado, D-V5.)

### 7.5 Expulsión (roja)
`red_card` cierra el tramo abierto del jugador en ese `game_second` (`ended_by = 'red_card'`) **sin** sustituto y
**bloquea su reingreso** aunque `rolling_subs` esté activo. Los minutos de los demás no cambian (la superioridad
numérica no afecta al cálculo). La doble amarilla es una amarilla + una roja: el jugador registra dos eventos, o un
botón «Segunda amarilla» que los genera juntos en una transacción.

### 7.6 Casos límite (deben tener prueba)
| Caso | Comportamiento |
|---|---|
| Doble toque / reintento del mismo cambio | `UNIQUE (match_id, client_event_id)`: el segundo no hace nada y la RPC devuelve el estado actual. |
| Sale alguien que no está en cancha | Rechazado (`P0001`): «ese jugador no está en cancha». |
| Entra alguien que ya está en cancha, o con roja | Rechazado. |
| Cambio con `game_second` mayor al reloj del tiempo | Rechazado: no se registran cambios «en el futuro». |
| Cambio anulado | Recalcula tramos; los minutos cambian al releer. |
| Más de 11 en cancha (fútbol 11) o más del tope del deporte | Aviso, **no** bloqueo (el árbitro manda, no la app); se registra. Tope configurable por formato (D-V10). |
| Titular que no llegó | Se marca `bench` antes de iniciar; si ya inició, se hace un cambio «entra X sale Y» en el segundo 0. |
| Partido suspendido a mitad | `finish_live_match` con los tiempos jugados hasta ahí (el tiempo en curso se cierra al momento). Estado `finished`, se anota en notas; el flujo de torneos no se toca. |
| Cancha sin nadie al terminar | Los tramos abiertos se cierran con `match_end`. |
| Jugador que entra con 0 s (cambio a la vez que termina el tiempo) | Tramo de 0 s: se descarta, no cuenta como «jugó». |

## 8. Offline, concurrencia e idempotencia

### 8.1 Idempotencia (obligatoria)
Cada pulsación genera un `client_event_id` (UUID) **antes** de mandar la petición. El servidor lo usa como llave
única. Un doble toque, un reintento automático o una cola que se envía dos veces **nunca** duplican un cambio ni
un gol. El botón además se deshabilita 600 ms tras el toque.

### 8.2 ¿Hace falta cola offline? (D-V3)
Sí en una versión mínima, porque la cancha de un club es el peor lugar para tener señal y perder un cambio es
exactamente el dolor que se quiere quitar. Diseño propuesto:
- La cola vive en `localStorage` (con `try/catch`, puede no estar), clave por `match_id`; cada ítem es el evento
  completo con su `client_event_id` y su `game_second` **ya calculado en el celular**.
- El reloj corre en el dispositivo desde un ancla; no necesita red para seguir contando.
- Al volver la red (o cada 10 s si hay pendientes) se manda un lote a `apply_live_events`; los aceptados salen
  de la cola, los rechazados se muestran al director con el motivo (no se descartan en silencio).
- Todos los eventos del lote se aplican **ordenados por `game_second`**, así un lote atrasado produce el mismo
  resultado que enviados uno a uno.
- Con sesión vencida el lote se reintenta tras refrescar el token; no se pierde.

### 8.3 Un solo escritor
Un partido tiene **un** director. Eso evita el problema de dos celulares moviendo el mismo reloj. Los demás
miembros del cuerpo técnico ven en lectura. Si el director pierde el celular o se queda sin batería, la
administración puede **reasignar** el director (RPC `set_live_director`, solo `user_admin_school_ids()`); el
nuevo director arranca con el estado ya sincronizado del servidor. El reloj del nuevo no «salta»: se vuelve a
anclar al tiempo transcurrido del tiempo en curso.

### 8.4 Disk IO (regla del repo)
- La pantalla **no** hace polling agresivo: el director escribe; el resto lee cada 15–20 s y solo mientras
  `status = 'in_period'`. Nada de consultas por segundo.
- Una escritura por evento (no por tick de reloj); el reloj es 100 % cliente. Un partido de Carmel genera
  decenas de filas, no miles.
- `match_live_events` y `match_player_stints` se indexan por `(match_id)`; no se leen catálogos ni listados globales.
- La migración es **una sola**, aplicada por una sesión, y `types.ts` se regenera **una vez** al final.

## 9. Informe automático al finalizar

El objetivo es que Julián **no redacte**: revise y envíe. Se reutiliza `match_reports` y `MatchReportDialog`.

### 9.1 Qué se genera
`finish_live_match` llama a un generador **determinístico por plantilla** (sin IA en v1, D-V11) que produce:

- **`summary`**: «Carmel Sub-12 empató 2-2 con Rival FC (liga, local, sábado 8 de noviembre). Jugaron 3 tiempos
  (25′ + 25′ + 18′), 24 convocados, 21 con minutos.»
- **`development`**: la **cronología**, una línea por evento: «T1 8′ Gol de #9 Nombre. T1 15′ Cambio: sale #7,
  entra #14. T2 3′ Amarilla #5…».
- **`improvements`**: **vacío** (es juicio del entrenador; el sistema no lo inventa). Puede sugerir un
  encabezado «Aspectos a mejorar:» si D-V11 lo aprueba.
- Un bloque estructurado de **minutos por jugador** (nombre, camiseta, minutos, % y tiempos jugados) que se
  muestra como tabla en `MatchReportDialog` y entra al texto copiable.

### 9.2 Reglas para no pisar el trabajo del entrenador
- El borrador se escribe **solo si** `match_reports` no existe o sus tres campos están vacíos; nunca sobrescribe.
- Si el partido se reabre y se vuelve a terminar, **no** regenera sobre un informe que el coach ya editó; el botón
  «Regenerar borrador» lo hace a pedido, mostrando antes qué sobrescribe.
- **Nunca se publica solo:** publicar sigue siendo manual (`publish_match_report`), y sigue mandando
  `share_match_reports` y `evaluation_published_at`. La regla del repo «la QA/la persona aprueba lo que sale hacia
  afuera» se mantiene: el informe nace como borrador.
- **Privacidad:** los minutos de un menor llegan a la familia solo si se publica el informe; en la versión para
  familias el cuadro de minutos muestra **solo los de su hijo** (igual que D7 con la evaluación), no la lista del
  equipo. Para v1 esto es una decisión (D-V12).

### 9.3 Copiar para WhatsApp (lo que Julián hace hoy)
Botón **Copiar para WhatsApp** que arma texto plano con `*negritas*` de WhatsApp: encabezado con rival, fecha,
marcador; cronología resumida; tabla de minutos por jugador («Nombre · 52′ · 87 %»); y una línea final editable.
Sin enviar nada: copia al portapapeles (el envío por WhatsApp Business no entra en v1).

### 9.4 Enlace con la evaluación existente
- Al abrir el paso **Evaluar**, los **minutos** ya vienen cargados desde `match_lineup_players.minutes_played`
  y aparecen junto al nombre; al evaluador le sirve para ponderar («jugó 12′, no se le exige igual»).
- **Opcional (D-V8):** crear automáticamente un criterio numérico de escuela «Minutos jugados» (`number`,
  unidad `min`) o escribir una fila `performance_entries` por jugador con `metric_key = 'minutes_played'` para que
  el **Informe Mensual del Atleta** (fase final del spec de partidos) sume minutos del mes. Recomendado en una
  fase posterior, no en v1.

## 10. Permisos

| Quién | Qué puede |
|---|---|
| **Staff de la escuela** (`user_staff_school_ids()`: coach de la categoría, administración) | Iniciar, ser director, registrar cambios/goles/tarjetas, terminar, ver el informe y copiarlo |
| **Administración** (`user_admin_school_ids()`) | Además: configurar el formato por categoría, reasignar director, reabrir un partido terminado, ver todos los partidos en vivo de la escuela |
| **Familia / deportista / padre** | **Nada en v1.** No ven el partido en vivo ni el reloj. Ven el marcador final y, si se publica, el informe y la evaluación según D7 y `share_match_reports` |
| **Escuela ajena / `anon`** | Nada (sin `GRANT` a `anon` en ninguna RPC) |

Detalles de RLS (se revisan línea por línea en el plan de F1; **escritura = `user_staff_school_ids()`, nunca
`user_school_ids()`** porque incluye padres y atletas):

| Tabla | Lectura | Escritura directa |
|---|---|---|
| `match_live`, `match_live_periods`, `match_live_events`, `match_player_stints` | `school_id = ANY (user_staff_school_ids())` | **Ninguna.** Se revoca `INSERT/UPDATE/DELETE` a `authenticated`; todo entra por RPC. Evita cambios saltándose las reglas de §7 |
| `team_match_format` | staff (el coach necesita el valor) | `user_admin_school_ids()` vía RPC |

- Toda policy con `FOR ALL` lleva `WITH CHECK` (invariante I3). Ninguna policy hace `SELECT` de su propia tabla.
- Después de aplicar: `npm run seguridad:invariantes`, simulación de sesión de un padre (debe ver 0 filas y 42501
  en las RPCs), de un coach de otra escuela (rechazado) y de un coach de la escuela (ok), con
  `set_config('request.jwt.claims', …)`.
- Ninguna escritura va por el BFF con `service_role`: las RPCs se llaman con el JWT del usuario (las lecciones del
  repo: una RPC llamada con service role se salta su propia autorización).

## 11. Flag solo para Carmel

- Columna `school_settings.live_match_enabled boolean NOT NULL DEFAULT false` (patrón
  `allow_secondary_team_enrollment`, `20260924101138`).
- `UPDATE school_settings SET live_match_enabled = true WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b'`
  (Carmel; verificar la fila antes de aplicar, igual que se hizo en 2026-09-24).
- Se expone en `v_school_entitlements` **al final** de la vista, copiando la **definición viva completa**
  (`pg_get_viewdef` el día de aplicar, no la del repo: la vista la tocan varias migraciones) — `CREATE OR REPLACE VIEW`
  no permite reordenar columnas (42P16).
- El frontend lee el flag de `useEntitlements`; sin flag no aparece el paso «En vivo» ni el botón. Las RPCs validan el
  flag **adentro** (cinturón y tirantes: no confiar solo en que la UI lo oculte).
- Un único interruptor para toda la capa en vivo; el informe automático solo existe si hay partido en vivo.
- Quitar el flag de Carmel **no borra** nada ya registrado.

## 12. Fases (sin ramas por fases; todo de corrido, cada una verificada)

| Fase | Contenido | Cierre |
|---|---|---|
| **F1 · DB + RLS + RPC** | Una migración (plan escrito y aprobado antes): flag, `team_match_format`, `match_live`, `match_live_periods`, `match_live_events`, `match_player_stints`, las RPCs de §5, la modificación de `save_match_roster` (§5) y el helper `rebuild_match_stints`. Ledger con `npm run migrations:new`. | Aplicada por `apply_migration` por una sola sesión; `seguridad:invariantes` sin críticas; pruebas T1–T12 (§14) con sesiones simuladas, **incluida concurrencia** (dos `apply_live_events` simultáneos al mismo partido y el mismo `client_event_id` desde dos pestañas) |
| **F2 · Lógica pura + hook** | `partidoEnVivoLogic.ts` (reloj desde ancla, minuto mostrado, tiempo añadido, validaciones de cambio, cola offline), con pruebas unitarias Vitest de los casos de §7.6; `useLiveMatch` (lectura, cola, sincronización) | Pruebas verdes; ninguna escritura directa a tablas |
| **F3 · Pantalla de cancha** | Paso «En vivo» en `PartidoFlujo`: preparar, reloj, cambio, gol/tarjeta, terminar, resumen; wake lock; deshacer; banner sin conexión | Probado en un celular real y con señal cortada (modo avión) |
| **F4 · Informe** | Generador de borrador en `finish_live_match`, tabla de minutos en `MatchReportDialog`, **Copiar para WhatsApp**, minutos precargados en «Evaluar» | Julián genera un informe real de un partido de práctica y lo compara con el suyo |
| **F5 · Configuración + piloto** | Pantalla de administración del formato por categoría (3 tiempos, el «45»), reasignar director, reabrir; manual corto (versión interna) en `docs/manuales/_src/` | Piloto con Julián en un partido real; ajustes con lo que salga |
| **F6 (después)** | Minutos al Informe Mensual del Atleta (D-V8), marcador en vivo para familias, IA de redacción (D-V11) | Solo si Carmel los pide |

Despliegues agrupados (cuota de Vercel): un push por fase como mucho; el BFF no cambia en F1–F4 (todo va por RPC con
el JWT del usuario). Verificar el deploy de Render solo si se toca el BFF.

## 13. Decisiones para el usuario (con mi recomendación)

> **Cerradas por el usuario el 2026-11-05** (prevalecen sobre la tabla de abajo):
> - **D-V1 (cambia el diseño):** quien programa el partido escoge **número de tiempos y duración por partido**,
>   en el formulario de agendar. NO hay formato por categoría → **D-V2 queda sin efecto** (no se crea
>   `team_match_format`); el formato vive en el propio partido (`match_live` o columnas al agendar) y el
>   valor por defecto es 2 tiempos. Ya no hace falta preguntarle a Julián el formato por categoría.
> - **D-V3:** sí, cola offline mínima en `localStorage` con `client_event_id`.
> - **D-V4:** sí, un solo director por partido, con reasignación por administración.
> - **D-V7:** sí, sumar convocados en vivo con RPC aparte.
> - **D-V11:** sí, informe por plantilla en v1, IA después.
> - **D-V12:** sí, la familia ve solo los minutos de su hijo y solo si se publica.
> - **Sin responder aún** (siguen como recomendación hasta que el usuario diga otra cosa): D-V5, D-V6, D-V8,
>   D-V9, D-V10, D-V13, D-V14.

| # | Pregunta | Opciones | Recomendación |
|---|---|---|---|
| **D-V1** | ¿Cuántos tiempos y qué duración usa Carmel por categoría? (no lo sé: **falta preguntarle a Julián**) | (a) 2×45, 3×25, etc. configurable por categoría · (b) un único formato fijo | **(a)**, con valor por defecto 2 tiempos y el «45» editable. Antes de F5 preguntar a Julián el formato real de cada categoría |
| **D-V2** | ¿Dónde se guarda el formato por categoría? | (a) tabla nueva `team_match_format` · (b) columnas en `teams` | **(a)**: `teams` lo usan todas las escuelas y es una tabla caliente; la tabla nueva no arrastra riesgo |
| **D-V3** | ¿Cola offline en v1? | (a) sin cola: falla si no hay señal · (b) cola mínima en `localStorage` con `client_event_id` · (c) PWA con IndexedDB completo | **(b)**. (a) pierde cambios justo donde más duele; (c) es mucho para v1 |
| **D-V4** | ¿Cuántos «directores» por partido? | (a) uno, con reasignación por administración · (b) varios escribiendo a la vez | **(a)**. (b) obliga a resolver conflictos de reloj y no se justifica con un cuerpo técnico pequeño |
| **D-V5** | ¿El % jugado es sobre lo jugado o sobre lo planificado? | (a) sobre lo realmente jugado (suma de `actual_seconds`) · (b) sobre lo planificado (3×25=75′) | **(a)**: si el árbitro termina antes o añade tiempo, el % sigue siendo honesto. Mostrar también los minutos absolutos |
| **D-V6** | ¿Se puede deshacer? | (a) anular el evento (queda registro) · (b) borrar | **(a)** siempre; nunca `DELETE` de eventos, para auditar |
| **D-V7** | ¿Se pueden sumar convocados cuando el partido ya empezó? | (a) sí, con RPC que agrega a la banca · (b) no, todo antes del pitazo · (c) reconvocar entero | **(a)**: en fútbol formativo pasa. **No** (c): borraría los minutos |
| **D-V8** | ¿Los minutos van a la evaluación/Informe Mensual como métrica? | (a) solo `minutes_played` (v1) · (b) además una fila `performance_entries` | **(a) en v1, (b) en F6** cuando se arme el Informe Mensual |
| **D-V9** | ¿Columna `is_live` en `match_results`? | (a) sí · (b) no, se consulta `match_live` | **(b)**: una tabla más pequeña y sin tocar `match_results`, que ya tiene muchos lectores |
| **D-V10** | ¿Tope de jugadores en cancha? | (a) aviso sin bloqueo · (b) bloqueo | **(a)**: el árbitro manda; si se bloquea, un error de la app impide registrar la realidad |
| **D-V11** | ¿IA para redactar el informe? | (a) plantilla determinística (v1) · (b) Haiku redacta el desarrollo | **(a) en v1**: no inventa, es gratis y no depende de la red. (b) si Julián lo pide después, siempre como borrador |
| **D-V12** | ¿Qué ve la familia del informe? | (a) el resumen sin tabla de minutos de otros · (b) todo | **(a)**: solo los minutos de su hijo, con `share_match_reports` y publicación manual; misma lógica que D7. Carmel tiene **0 acudientes vinculados** hoy, así que esto no urge |
| **D-V13** | ¿Quién es director por defecto? | (a) quien inicia el partido · (b) el entrenador de la categoría | **(a)**, con reasignación. Evita que un partido quede sin director |
| **D-V14** | Fútbol solo o genérico | (a) modelo genérico, UI probada solo en fútbol · (b) genérico probado en voleibol y baloncesto | **(a)** (consistente con D4 del spec de partidos: voleibol va por sets, no por minutos) |

## 14. Pruebas mínimas (para el plan de F1)

| # | Prueba |
|---|---|
| T1 | Un padre llama a cada RPC → 42501; `SELECT` directo a las tablas → 0 filas |
| T2 | Coach de otra escuela → rechazado en todas |
| T3 | Escuela sin flag → todas rechazan con mensaje claro |
| T4 | Mismo `client_event_id` dos veces (y en paralelo) → una sola fila, mismo estado |
| T5 | Lote con un evento inválido → no se aplica ninguno |
| T6 | Entra/sale/entra de nuevo → dos tramos, suma correcta |
| T7 | Roja → tramo cerrado, no puede reingresar |
| T8 | Cambio en descanso → tramos con `in_second = 0` del segundo tiempo |
| T9 | `finish_live_match` dos veces → mismos minutos, un solo borrador de informe |
| T10 | `save_match_roster` con partido iniciado → rechazada; no se pierden minutos |
| T11 | Anular un cambio → los minutos se recalculan al releer |
| T12 | Informe: no pisa un reporte ya editado; sin `improvements` inventado |

## 15. Riesgos

| Riesgo | Mitigación |
|---|---|
| Se pierde un cambio por mala señal | Cola local + idempotencia + banner; los pendientes se ven; prueba con modo avión (F3) |
| El director toca mal y registra un cambio equivocado | Deshacer 8 s + anular después; las anulaciones recalculan minutos |
| `save_match_roster` borra los jugadores y rompe tramos | Se bloquea cuando el partido está iniciado + RPC aparte para sumar refuerzos (§5, D-V7) |
| El reloj del celular se desfasa o el director lo apaga | El reloj es por ancla y `game_second`; el servidor valida contra los límites del tiempo, no contra la hora de pared |
| El celular se queda sin batería | Reasignar director (§8.3); el estado vive en el servidor, no solo en el celular |
| El informe automático dice algo equivocado a las familias | Nace borrador; publicar es manual; plantilla sin IA; sin `improvements` inventado |
| Datos de menores (minutos, nombres) | Familia ve solo lo de su hijo y solo si se publica (D-V12); la RLS de tablas en vivo es solo staff |
| Disk IO | Escritura por evento, reloj 100 % cliente, sin polling por segundo, una sola migración aplicada por una sola sesión |
| `v_school_entitlements` desactualizada en el repo | Copiar la definición **viva** con `pg_get_viewdef` el día de aplicar |
| Formato de Carmel mal supuesto (3 tiempos, el «45») | D-V1: preguntar a Julián antes de F5; el modelo ya lo admite configurable |
| Ningún otro cliente lo pidió | El flag lo deja solo para Carmel; si se reutiliza en Besser u otra escuela, es prender el flag |

## 16. Preguntas pendientes (de Julián, no del usuario)

1. ¿Cuántos tiempos juega cada categoría y de cuántos minutos? ¿Cambia entre liga y amistoso?
2. ¿Los reingresos están permitidos siempre o hay categorías con cambios definitivos?
3. ¿Quién maneja el celular en el partido: el entrenador, un asistente, o el propio Julián?
4. ¿Cómo es el informe de WhatsApp de hoy? Pedirle **un ejemplo real** (3 informes) para ajustar la plantilla de §9.3.
5. ¿Los partidos tienen siempre árbitro oficial o hay partidos de práctica (esos no deberían contar para el historial)?
6. ¿A quién se manda el informe: al grupo de padres, a la administración, a otro cuerpo técnico?

## 17. Estado

- 2026-11-05 · F0 escrito (este documento). Sin migraciones ni código. Pendiente: que el usuario decida §13 y que Julián
  conteste §16 antes de escribir el plan de F1.
