# Plan Fase 1 (base de datos) — Partido en vivo de Carmel

> **Estado: PLAN para aprobar. No se ha escrito ninguna migración, ni se tocó el ledger, ni se aplicó nada.**
> Convención del repo: *plan antes de código en migraciones*. Cuando el usuario lo apruebe, se crean los `.sql`
> con `npm run migrations:new -- <slug>` (uno por cada slug de §2) y se aplican **una sola sesión, en orden**.
>
> Entrada: `docs/specs/partido-en-vivo-sustituciones.md` (§13 decisiones cerradas el 2026-11-05, §16.1 respuestas,
> §9.3.1 plantilla real del informe). Este plan **refina** el spec donde el modelo no cerraba (ver §1.2).
> Fecha de verificación contra la base viva: **2026-11-05** (solo lectura, filtrado por nombre, sin `list_tables` ni `get_advisors`).

---

## 0. Resumen en diez líneas

1. Cuatro migraciones: (1) flag + columnas de agenda + dorsal, (2) tablas + RLS + trigger de protección, (3) helpers y RPCs, (4) bloqueo de `save_match_roster`.
2. Cinco tablas nuevas (`match_live`, `match_live_periods`, `match_live_events`, `match_player_stints`) más columnas nuevas en `match_results` y `football_match_events`. **No existe `team_match_format`** (D-V1 lo eliminó).
3. Los eventos son la fuente de verdad; los tramos se **regeneran por repetición completa** (`_live_rebuild_stints`) en cada escritura. Eso resuelve gratis eventos fuera de orden, anulaciones y reingresos sin tope.
4. Escritura **solo por RPC** con el JWT del usuario; las tablas nuevas no tienen policies de escritura y `authenticated` solo tiene `SELECT`.
5. Cada RPC valida **adentro** alcance (staff/admin/director) atado al `school_id` del partido y el flag `live_match_enabled`.
6. El flag es `school_settings.live_match_enabled DEFAULT false`, prendido solo para Carmel (`374a6716-…`), con asserts de 1 fila.
7. `save_match_roster` se bloquea si el partido ya inició; un trigger cubre el camino por REST directo.
8. El dorsal (`match_lineup_players.jersey_number`) **ya existe** (nullable, 24 de 294 filas lo tienen): se vuelve obligatorio **solo para el en vivo**, dentro de las RPCs, sin tocar a las demás escuelas.
9. Pruebas T1–T12 + concurrencia CT1–CT6 se corren en el **gemelo local**, no en la base compartida.
10. Radio: demostrable con consultas de §10 (0 filas de `match_live` fuera de Carmel, vista idéntica salvo una columna al final).

---

## 1. Verificación contra el repo y la base viva

### 1.1 Lo que se encontró (hechos)

| Pregunta | Resultado verificado |
|---|---|
| ¿Existe dorsal? | **Sí.** `match_lineup_players.jersey_number integer NULL`, sin CHECK de rango. Hoy 24 de 294 filas lo tienen; rango real 1..55; **0 lineups con dorsal repetido**. `save_match_roster` ya lo recibe (`x->>'jersey_number'`). |
| Columnas de `match_results` | `id, team_id (NULL), opponent, home_score, away_score, is_home, match_date, match_type (text libre: Torneo 38, Amistoso 9, Liga 7, Clasificatorio 1), notes, created_at, opponent_team_id, school_id, status (scheduled/played/cancelled, default 'played'), kickoff_at, location, calendar_event_id, tournament_match_id, evaluation_published_at, created_by, updated_by, updated_at`. **No hay** árbitro, ni tipo oficial/práctica, ni número de tiempos. Ojo: `team_id` es NULLABLE y `football_match_events.team_id` es NOT NULL. Total hoy: 55 partidos, 6 de Carmel. |
| `save_match_roster(p_match uuid, p_players jsonb)` viva | SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, ACL `postgres, service_role, authenticated` (sin anon). Cuerpo = el de `20261025003647`: valida staff/platform admin, rechaza ajenos con `_v2_sujeto_en_escuela`, upsert de `match_lineups`, **`DELETE` de todos los `match_lineup_players` del lineup y reinserta** (con `jersey_number`, `minutes_played`, `position_code`), borra respuestas de quien salió, avisa a las familias (en bloque con `EXCEPTION`), devuelve `v_n`. Se copiará **textual** (§7.4). |
| `v_school_entitlements` viva | Última columna: `COALESCE(sset.coach_attendance_retro_days, 7) AS coach_attendance_retro_days`. Sin vistas dependientes. Ninguna de las migraciones sin commitear de hoy (`20261105211824`, `…212046`, `…212125`) la toca. El texto completo (4208 caracteres) se vuelve a extraer con `pg_get_viewdef` **el día de aplicar** (regla del repo), no se copia de aquí. |
| Helpers de alcance | `user_staff_school_ids()` (members activos con rol NOT IN parent/athlete/accountant + `school_staff` por `coach_auth_id` + por email + `schools.owner_id`), `user_admin_school_ids()` (members owner/admin/school_admin/super_admin + owner), `is_platform_admin()`: los tres SECURITY DEFINER con `search_path` fijo, `EXECUTE` a `authenticated`. `user_school_ids()` incluye padres/atletas: **no se usa en escritura**. `user_tactical_edit_school_ids()` existe (lo usan las policies de `match_lineup_players`). `_v2_sujeto_en_escuela` y `_callup_subject_account` son internos (sin grant a authenticated): se pueden llamar desde RPCs SECURITY DEFINER. |
| Policies actuales de `match_lineup_players` | SELECT: staff **o el propio perfil o padre del hijo** (`is_parent_of_child`). INSERT/UPDATE/DELETE: `user_tactical_edit_school_ids()`, roles `{public}`. **Implica que un coach puede borrar/cambiar filas por REST sin pasar por `save_match_roster`** → por eso el trigger de §4.6. |
| `match_reports` | PK `match_id`; `school_id NOT NULL`; `coach_id` NULL; CHECK ≤ 4000 caracteres en `summary/development/improvements/admin_comment`; **solo policy SELECT** (se escribe por RPC `save_match_report` / `publish_match_report`). Un RPC SECURITY DEFINER puede insertar el borrador. |
| `football_match_events` | `type` solo `goal/own_goal/yellow/red/assist`; `subject_id NOT NULL`; `minute integer NULL`; `team_id NOT NULL`; sin columna que enlace a un evento en vivo; policies de escritura por `user_tactical_edit_school_ids()`. Sin triggers. |
| `school_settings` | RLS activa, 373 filas, 152 columnas, fila de Carmel existe. Policies ALL de admin + `trial_block_*`. **No existe** `live_match_enabled`. `share_match_reports` sí existe. |
| Realtime | Ninguna tabla `match*` en `supabase_realtime`. No se agrega (el resto lee por RPC cada 15–20 s). |
| Falla de esquema del entorno | `security_audit_log` **no existe aún en la base viva** (su migración `20261105211824` está sin commitear de otra sesión). **Este plan no depende de ella**: la auditoría del en vivo vive en `match_live_events` (inmutable, con `created_by`, `voided_*`). |

### 1.2 Cambios frente al spec (a aprobar)

| # | Spec | Este plan | Por qué |
|---|---|---|---|
| C1 | `game_second` = segundos de juego acumulados del partido, y a la vez «in_second=0 del siguiente tiempo» (contradictorio) | **`period_no` + `period_second`** (segundos dentro del tiempo, ≥ 0) + `in_break boolean` para cambios en el descanso | El informe real agrupa «Cambios (1.er tiempo / 2.º / 3.º)» con minuto dentro del tiempo. El acumulado se deriva cuando hace falta |
| C2 | Goles/tarjetas solo en `football_match_events` (minuto entero) | Los eventos `goal`, `goal_against`, `yellow`, `red` **también viven en `match_live_events`** (con segundos y tiempo). Al terminar se **espejan** a `football_match_events` (con `live_event_id`) | La plantilla pide `7'47"` y gol en contra sin jugador; `football_match_events` no puede (`subject_id NOT NULL`, minuto entero). El espejo conserva las estadísticas actuales de temporada |
| C3 | `finish_live_match(p_match, p_home_score, p_away_score)` | `p_score_for`, `p_score_against` (se mapean con `is_home` adentro) | Evita invertir local/visitante al registrar desde la cancha |
| C4 | `set_team_match_format` y `team_match_format` | **Eliminados** (D-V1). El formato va en `match_results` al agendar y se copia a `match_live` al iniciar | Decisión cerrada del usuario |
| C5 | `director_id NOT NULL` | `director_id uuid NULL … ON DELETE SET NULL` | El borrado total de usuario (gotcha del repo) no debe bloquearse por un partido; sin director el gate exige admin |
| C6 | `rebuild_match_stints` público | `_live_rebuild_stints` **interno** (sin grant) y llamado desde cada RPC de escritura | Regla de helpers: solo los llama otra SECURITY DEFINER |
| C7 | Dorsal obligatorio | Se valida **en las RPCs del en vivo** (inicio, refuerzo, edición de dorsal), **sin** `NOT NULL` ni índice único global | No cambia el comportamiento de las otras escuelas (ver R-03) |
| C8 | Spec 4.2: `status` incluye `voided` | Se mantiene `voided` en el CHECK pero **ninguna RPC de F1 lo escribe** (reservado; evita migración futura) | Sin código muerto en las RPCs |

---

## 2. Orden de migraciones

Una sola sesión aplica, en este orden, con `apply_migration` o `db push` (que deje rastro). Nunca en paralelo con otra sesión (cada DDL recarga el esquema de PostgREST; Disk IO).
Cada archivo comienza con `SET lock_timeout = '3s';` para que, si `school_settings`/`match_results`/`football_match_events` están ocupadas, **falle rápido** en vez de encolar bloqueos sobre tablas calientes (se reintenta).

| # | Slug (el timestamp lo reserva `migrations:new`) | Contenido | ¿Toca tablas con datos de otras escuelas? |
|---|---|---|---|
| 1 | `partido_vivo_flag_agenda_y_dorsal` | Flag en `school_settings` + `UPDATE` Carmel + columna al final de `v_school_entitlements`; 4 columnas en `match_results`; `live_event_id` en `football_match_events`; CHECK de rango del dorsal | Solo `ADD COLUMN` con default constante (metadatos, sin reescribir tabla en PG15) |
| 2 | `partido_vivo_tablas_y_rls` | 4 tablas nuevas, índices, RLS (solo SELECT), `REVOKE`/`GRANT`, trigger de protección de `match_lineup_players` | El trigger es el único objeto que roza datos existentes; es inerte sin `match_live` (§10) |
| 3 | `partido_vivo_rpcs` | Helpers internos + 9 RPCs + `match_live_report`, todos con `SET search_path`, `GRANT`/`REVOKE` explícitos | No |
| 4 | `partido_vivo_bloqueo_save_match_roster` | `CREATE OR REPLACE FUNCTION save_match_roster` con el cuerpo vivo + chequeo | Cambia una función usada por todas las escuelas, pero el chequeo nuevo no actúa sin una fila de `match_live` |

`types.ts` se regenera **una sola vez, después de aplicar la migración 4 y verificar** (§12).
Después de aplicar: `npm run seguridad:invariantes` y las pruebas de §9 sobre el gemelo.
La migración 4 va **última** a propósito: es la única que modifica una RPC global; si algo falla antes, no queda nada a medias.

---

## 3. Migración 1 — `partido_vivo_flag_agenda_y_dorsal`

### 3.1 Flag solo Carmel

```sql
SET lock_timeout = '3s';

ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS live_match_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.school_settings.live_match_enabled IS
  'Partido en vivo (reloj, cambios, minutos). Solo Carmel. Las RPCs validan este flag ADENTRO.';

DO $$
DECLARE n int;
BEGIN
  UPDATE public.school_settings SET live_match_enabled = true
   WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Carmel: se esperaba 1 fila en school_settings y hubo %', n;   -- aborta toda la migración
  END IF;
END $$;
```

`CREATE OR REPLACE VIEW public.v_school_entitlements AS …` con la **definición viva completa** (`pg_get_viewdef('public.v_school_entitlements'::regclass, true)` el día de aplicar) y **una sola línea nueva al final del SELECT**:

```sql
    , COALESCE(sset.live_match_enabled, false) AS live_match_enabled
```

Reglas: no reordenar ni renombrar columnas (42P16); mantener `LEFT JOIN school_settings sset` tal cual; conservar `security_invoker`/opciones de la vista viva (verificar `reloptions` antes y después: `select reloptions from pg_class where oid='public.v_school_entitlements'::regclass`).

### 3.2 Columnas de agenda en `match_results` (D-V1 y respuesta 5 de §16.1)

```sql
ALTER TABLE public.match_results
  ADD COLUMN IF NOT EXISTS live_periods_count  smallint NULL
        CONSTRAINT match_results_live_periods_count_chk CHECK (live_periods_count BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS live_period_minutes smallint NULL
        CONSTRAINT match_results_live_period_minutes_chk CHECK (live_period_minutes BETWEEN 5 AND 60),
  ADD COLUMN IF NOT EXISTS match_kind          text NOT NULL DEFAULT 'official'
        CONSTRAINT match_results_match_kind_chk CHECK (match_kind IN ('official','practice')),
  ADD COLUMN IF NOT EXISTS referee_name        text NULL
        CONSTRAINT match_results_referee_name_chk CHECK (referee_name IS NULL OR char_length(btrim(referee_name)) BETWEEN 1 AND 120);
COMMENT ON COLUMN public.match_results.match_kind IS
  'official | practice. Distinto de match_type (competencia: Liga/Amistoso/Torneo). practice no cuenta en el historial.';
```

- `NULL` en `live_periods_count/live_period_minutes` = «no se escogió»: `start_live_match` aplica el default **2 tiempos de 45 min** y el director lo ajusta en «Preparar».
- `match_kind` default `'official'` mantiene idéntico el comportamiento de los 55 partidos de hoy. «Cuenta en el historial» lo decide el frontend/reportes con este campo; **F1 no cambia ningún reporte existente**.
- Las escribe el formulario de agendar por el `UPDATE`/`INSERT` normal (policies de staff ya vigentes sobre `match_results`). No requiere RPC.
- Efecto en lectores: `match_results_select` deja ver estas columnas a familias del equipo. Es información no sensible (árbitro, tipo). Si Carmel no quiere mostrar el árbitro a las familias, es decisión de UI (D-P2 en §14).

### 3.3 Espejo hacia estadística existente

```sql
ALTER TABLE public.football_match_events
  ADD COLUMN IF NOT EXISTS live_event_id uuid NULL;   -- sin FK: se llena con el id de match_live_events; ver §8.4
CREATE INDEX IF NOT EXISTS football_match_events_live_event_idx
  ON public.football_match_events (live_event_id) WHERE live_event_id IS NOT NULL;
```

Sin FK a propósito: `match_live_events` no se borra nunca y el espejo se borra/rehace por `source_id` + `live_event_id IS NOT NULL`; una FK solo sumaría bloqueos en una tabla de estadística de temporada.

### 3.4 Rango del dorsal (sin imponer nada nuevo a nadie)

```sql
ALTER TABLE public.match_lineup_players
  ADD CONSTRAINT match_lineup_players_jersey_range_chk
  CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999);   -- datos vivos: 1..55, valida sin problema
```

Se agrega validada (294 filas; escaneo trivial). **No** se agrega `UNIQUE (lineup_id, jersey_number)` ni `NOT NULL` (ver C7 y R-03).

---

## 4. Migración 2 — `partido_vivo_tablas_y_rls`

Convenciones aplicadas a todas: `text + CHECK` (sin `CREATE TYPE`), FKs de negocio a `public.profiles(id)`, `school_id NOT NULL` en cada tabla (la RLS no hace JOIN), `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL … FROM PUBLIC, anon, authenticated` y luego **solo** `GRANT SELECT … TO authenticated` (los default privileges de Supabase otorgan todo a `anon`/`authenticated` en tablas nuevas; hay que revocarlo explícito, invariante I1).

### 4.1 `match_live` (1:1 con `match_results`)

```sql
CREATE TABLE public.match_live (
  match_id        uuid PRIMARY KEY REFERENCES public.match_results(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'not_started'
                  CONSTRAINT match_live_status_chk CHECK (status IN ('not_started','in_period','on_break','finished','voided')),
  periods_planned smallint NOT NULL CONSTRAINT match_live_periods_planned_chk CHECK (periods_planned BETWEEN 1 AND 4),
  current_period  smallint NOT NULL DEFAULT 0 CONSTRAINT match_live_current_period_chk CHECK (current_period BETWEEN 0 AND 4),
  director_id     uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at      timestamptz NULL,          -- cuando se creó el estado en vivo (start_live_match)
  finished_at     timestamptz NULL,
  finished_by     uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  reopened_at     timestamptz NULL,
  reopen_count    smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_live_current_le_planned_chk CHECK (current_period <= periods_planned),
  CONSTRAINT match_live_finished_chk CHECK ((status = 'finished') = (finished_at IS NOT NULL) OR reopened_at IS NOT NULL)
);
CREATE INDEX match_live_school_active_idx ON public.match_live (school_id) WHERE status IN ('in_period','on_break');
```

(`period_seconds` del spec desaparece: la duración vive en `match_live_periods.planned_seconds`, por tiempo.)
La CHECK `match_live_finished_chk` es deliberadamente laxa con reabiertos (un partido reabierto queda `on_break` con `finished_at` previo); la regla fina la imponen las RPCs. Si al escribir la migración resulta confusa, se cambia por trigger o se elimina: no es una invariante de seguridad.

### 4.2 `match_live_periods`

```sql
CREATE TABLE public.match_live_periods (
  match_id         uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  period_no        smallint NOT NULL CONSTRAINT match_live_periods_no_chk CHECK (period_no BETWEEN 1 AND 4),
  planned_seconds  integer NOT NULL CONSTRAINT match_live_periods_planned_chk CHECK (planned_seconds BETWEEN 300 AND 3600),
  started_at       timestamptz NULL,       -- ancla de pared (derivada del evento period_start; ver §6.4)
  ended_at         timestamptz NULL,
  actual_seconds   integer NULL CONSTRAINT match_live_periods_actual_chk CHECK (actual_seconds IS NULL OR actual_seconds BETWEEN 0 AND 10800),
  stoppage_seconds integer GENERATED ALWAYS AS (GREATEST(0, actual_seconds - planned_seconds)) STORED,
  PRIMARY KEY (match_id, period_no),
  CONSTRAINT match_live_periods_order_chk CHECK (ended_at IS NULL OR started_at IS NOT NULL)
);
```

Las filas de periodos las crea `start_live_match` (una por tiempo previsto) y las **reescribe** el replay (`started_at/ended_at/actual_seconds`). `actual_seconds` guardado al cerrar, nunca recalculado con `now()`.

### 4.3 `match_live_events` (fuente de verdad, inmutable)

```sql
CREATE TABLE public.match_live_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  client_event_id  uuid NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,          -- desempate estable
  type             text NOT NULL CONSTRAINT match_live_events_type_chk CHECK (type IN
                     ('period_start','period_end','sub','goal','goal_against','yellow','red',
                      'clock_adjust','callup','match_end','match_reopen')),
  period_no        smallint NOT NULL CONSTRAINT match_live_events_period_chk CHECK (period_no BETWEEN 1 AND 4),
  in_break         boolean NOT NULL DEFAULT false,               -- cambio/tarjeta puesto en el descanso ANTES de period_no
  period_second    integer NOT NULL CONSTRAINT match_live_events_second_chk CHECK (period_second BETWEEN 0 AND 10800),
  -- subject = quien entra (sub) / goleador / sancionado / convocado agregado (callup)
  -- related = quien sale (sub) / asistente opcional (goal)
  subject_type     text NULL CONSTRAINT match_live_events_subject_type_chk CHECK (subject_type IN ('profile','child','unregistered')),
  subject_id       uuid NULL,
  related_type     text NULL CONSTRAINT match_live_events_related_type_chk CHECK (related_type IN ('profile','child','unregistered')),
  related_id       uuid NULL,
  reason           text NULL CONSTRAINT match_live_events_reason_chk CHECK (reason IN ('tactical','injury','other')),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb
                   CONSTRAINT match_live_events_payload_chk CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 2048),
  client_at        timestamptz NULL,                              -- auditoría; no manda para el minuto
  created_by       uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz NULL,
  voided_by        uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT match_live_events_client_uniq UNIQUE (match_id, client_event_id),
  CONSTRAINT match_live_events_pair_subject_chk CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT match_live_events_pair_related_chk CHECK ((related_type IS NULL) = (related_id IS NULL)),
  CONSTRAINT match_live_events_shape_chk CHECK (
       (type = 'sub'          AND subject_id IS NOT NULL AND related_id IS NOT NULL
                              AND NOT (subject_type = related_type AND subject_id = related_id))
    OR (type = 'goal'         AND subject_id IS NOT NULL AND in_break = false)
    OR (type = 'goal_against' AND subject_id IS NULL AND related_id IS NULL AND in_break = false)
    OR (type IN ('yellow','red') AND subject_id IS NOT NULL AND related_id IS NULL)
    OR (type IN ('period_start','period_end','clock_adjust','match_end','match_reopen')
                              AND subject_id IS NULL AND related_id IS NULL)
    OR (type = 'callup'       AND subject_id IS NOT NULL AND related_id IS NULL)),
  CONSTRAINT match_live_events_reason_only_sub_chk CHECK (reason IS NULL OR type = 'sub')
);
-- un solo pitazo inicial y final por tiempo, entre los NO anulados (carrera de dos RPCs ya queda cubierta por el lock; esto es el cinturón)
CREATE UNIQUE INDEX match_live_events_one_start_uq ON public.match_live_events (match_id, period_no) WHERE type = 'period_start' AND voided_at IS NULL;
CREATE UNIQUE INDEX match_live_events_one_end_uq   ON public.match_live_events (match_id, period_no) WHERE type = 'period_end'   AND voided_at IS NULL;
-- orden del replay
CREATE INDEX match_live_events_replay_idx ON public.match_live_events (match_id, period_no, period_second, seq);
```

Inmutabilidad: ninguna policy de escritura y sin `GRANT`; la anulación solo la hace `void_live_event` (UPDATE de `voided_*` como dueño). Nunca `DELETE` de eventos (D-V6). `ON DELETE CASCADE` desde `match_live` solo actúa si se borra el partido completo (borrado de escuela/partido), no por uso normal.

### 4.4 `match_player_stints` (derivado, materializado)

```sql
CREATE TABLE public.match_player_stints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CONSTRAINT match_player_stints_subject_type_chk CHECK (subject_type IN ('profile','child','unregistered')),
  subject_id    uuid NOT NULL,
  period_no     smallint NOT NULL CONSTRAINT match_player_stints_period_chk CHECK (period_no BETWEEN 1 AND 4),
  in_second     integer NOT NULL CONSTRAINT match_player_stints_in_chk CHECK (in_second >= 0),
  out_second    integer NULL,                               -- NULL = sigue en cancha
  ended_by      text NULL CONSTRAINT match_player_stints_ended_by_chk CHECK (ended_by IN ('sub','period_end','red','match_end')),
  in_event_id   uuid NULL,                                   -- sin FK: tabla derivada que se regenera completa
  out_event_id  uuid NULL,
  CONSTRAINT match_player_stints_span_chk CHECK ((out_second IS NULL AND ended_by IS NULL) OR (out_second > in_second AND ended_by IS NOT NULL)),
  CONSTRAINT match_player_stints_uniq UNIQUE (match_id, subject_type, subject_id, period_no, in_second)
);
CREATE INDEX match_player_stints_match_idx ON public.match_player_stints (match_id, period_no);
```

Un tramo nunca cruza de tiempo. Tramos de 0 s se **descartan** (no se insertan; CHECK `out > in`). Reingresos sin tope: no hay ningún límite ni UNIQUE por jugador/tiempo (decisión 16.1-2). Se regenera con `DELETE` + reinsert dentro de la misma transacción del RPC bajo lock de `match_live`; es una tabla de decenas de filas.

### 4.5 RLS línea por línea (solo lectura de staff; ninguna escritura directa)

Se aplica igual a las 4 tablas (`match_live`, `match_live_periods`, `match_live_events`, `match_player_stints`):

```sql
ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.<t> FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.<t> TO authenticated;

CREATE POLICY <t>_select_staff ON public.<t>
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_platform_admin())
    OR school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
  );
```

| Tabla | Policy | Cmd | Roles | USING | WITH CHECK |
|---|---|---|---|---|---|
| `match_live` | `match_live_select_staff` | SELECT | authenticated | `is_platform_admin() OR school_id = ANY(user_staff_school_ids())` | (n/a, SELECT) |
| `match_live_periods` | `match_live_periods_select_staff` | SELECT | authenticated | idéntico | n/a |
| `match_live_events` | `match_live_events_select_staff` | SELECT | authenticated | idéntico | n/a |
| `match_player_stints` | `match_player_stints_select_staff` | SELECT | authenticated | idéntico | n/a |

Revisión contra las cinco trampas del repo:
1. **Permisivas con OR:** cada tabla tiene **una sola** policy y ninguna de escritura; no hay quinta puerta abierta. Verificar post-aplicación: `select tablename, policyname, cmd, roles from pg_policies where tablename in ('match_live','match_live_periods','match_live_events','match_player_stints')` → exactamente 4 filas, todas SELECT.
2. **`FOR ALL` sin `WITH CHECK`:** no se usa `FOR ALL`. (I3 sin hallazgos.)
3. **`REVOKE ALL FROM PUBLIC` no alcanza:** se revoca explícito de `anon` y `authenticated` y se re-concede solo `SELECT` (arriba).
4. **RLS filtra filas, no columnas:** no se expone nada a familias. Las familias leen su dato por las vías ya existentes (§11, riesgo R-05).
5. **Policy `_by_token`:** no aplica.
- `user_staff_school_ids()` (no `user_school_ids()`): padres/atletas **no** pasan (I2). Las policies de lectura usan `(SELECT …)` para que el planner lo evalúe una vez (mismo estilo que `match_results_select`).
- Sin self-recursion: ninguna policy hace `SELECT` de su propia tabla.
- Se **quita** `anon` de todo: I1.
- `INSERT/UPDATE/DELETE` quedan denegados por falta de grant y de policy (doble cierre). Los RPCs son `SECURITY DEFINER` (dueño `postgres`, que no está sujeto a RLS por ser dueño/BYPASSRLS; verificar que las tablas no tengan `FORCE ROW LEVEL SECURITY`).

### 4.6 Trigger de protección sobre `match_lineup_players` (cierra el camino por REST)

Las policies existentes dejan a quien edita táctica borrar/cambiar filas de `match_lineup_players` por REST. Una vez iniciado el partido eso rompería minutos/tramos.

```sql
CREATE FUNCTION public._live_guard_lineup_players() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_started boolean;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(OLD, NEW); END IF;     -- cascadas (borrado de escuela/usuario) no se bloquean
  IF TG_OP = 'UPDATE' AND NEW.role = OLD.role AND NEW.subject_id = OLD.subject_id
                      AND NEW.subject_type = OLD.subject_type THEN RETURN NEW; END IF;   -- dorsal/posición/minutos: permitido
  SELECT EXISTS (
    SELECT 1 FROM public.match_lineups ml
      JOIN public.match_live l ON l.match_id = ml.source_id
     WHERE ml.id = OLD.lineup_id AND ml.source_type = 'team_match'
       AND l.status IN ('in_period','on_break','finished')
  ) INTO v_started;
  IF v_started THEN
    RAISE EXCEPTION 'El partido ya empezó; use los cambios en vivo' USING ERRCODE = 'P0001', HINT = 'LIVE_STARTED';
  END IF;
  RETURN COALESCE(OLD, NEW);
END $$;
REVOKE ALL ON FUNCTION public._live_guard_lineup_players() FROM PUBLIC, anon, authenticated;   -- función de trigger, sin grant

CREATE TRIGGER trg_live_guard_lineup_players
  BEFORE DELETE OR UPDATE OF role, subject_id, subject_type ON public.match_lineup_players
  FOR EACH ROW EXECUTE FUNCTION public._live_guard_lineup_players();
```

Notas: (a) solo `DELETE` y `UPDATE OF role, subject_*` (INSERT, dorsal, posición, minutos siguen libres; `add_live_callup` es INSERT); (b) costo por fila: dos búsquedas por PK/índice (`match_lineups` por id, `match_live` por PK), tolerable en convocatorias de ~25 filas; (c) `pg_trigger_depth() > 1` deja pasar las cascadas del borrado total de usuario/escuela (probar en T14); (d) como el trigger bloquea el `DELETE` de `save_match_roster`, es también red de seguridad de la migración 4.

---

## 5. Helpers internos (migración 3)

Todos `LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`, con `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated` y **sin** `GRANT` (solo los llaman otras RPCs del mismo dueño).

| Helper | Firma | Qué hace |
|---|---|---|
| `_live_auth` | `(p_match uuid, p_level text) RETURNS public.match_results` | Gate único (abajo) |
| `_live_is_staff_of` | `(p_uid uuid, p_school uuid) RETURNS boolean` | ¿`p_uid` trabaja en esa escuela? Replica las ramas de `user_staff_school_ids()` (members activos NOT IN parent/athlete/accountant, `school_staff.coach_auth_id`, owner) **sin** la rama por email. Solo para validar al nuevo director |
| `_live_rebuild_stints` | `(p_match uuid) RETURNS jsonb` | Replay completo (§6.3). Devuelve `{on_field, sent_off, status, current_period, warnings[]}` |
| `_live_state_json` | `(p_match uuid) RETURNS jsonb` | Estado para el cliente: match_live, periodos, en cancha, banca, expulsados, último evento |
| `_live_fmt_clock` | `(p_sec int) RETURNS text IMMUTABLE` | `mm'` si es redondo, `mm'ss"` si no (plantilla §9.3.1) |
| `_live_draft_report` | `(p_match uuid) RETURNS jsonb` | `{summary, development}` por plantilla, recortado a 4000 caracteres cada uno |

### 5.1 `_live_auth(p_match, p_level)` — el gate, en pseudocódigo

```
v_uid := auth.uid()
IF v_uid IS NULL THEN RAISE '42501' 'Authentication required'
SELECT * INTO m FROM match_results WHERE id = p_match        -- sin FOR UPDATE aquí
IF NOT FOUND THEN RAISE '02000' 'Partido no encontrado'
-- alcance atado al school_id DEL PARTIDO (no a uno que mande el cliente)
CASE p_level
  'staff' | 'director': IF NOT (m.school_id = ANY(user_staff_school_ids()) OR is_platform_admin()) THEN RAISE '42501' 'Sin permiso sobre esta escuela'
  'admin':              IF NOT (m.school_id = ANY(user_admin_school_ids()) OR is_platform_admin()) THEN RAISE '42501' ...
-- flag ADENTRO (aplica también al platform admin; se verifica en T3)
IF NOT COALESCE((SELECT live_match_enabled FROM school_settings WHERE school_id = m.school_id), false)
   THEN RAISE 'P0001' 'El partido en vivo no está habilitado para esta escuela' HINT 'LIVE_DISABLED'
-- director: solo para escritura de campo
IF p_level = 'director':
   SELECT director_id INTO d FROM match_live WHERE match_id = p_match
   IF NOT (d = v_uid OR m.school_id = ANY(user_admin_school_ids()) OR is_platform_admin())
      THEN RAISE 'P0001' 'No eres el director de este partido' HINT 'NOT_DIRECTOR'
RETURN m
```

Los RPCs de escritura, tras `_live_auth`, toman `SELECT … FROM match_live WHERE match_id = p_match FOR UPDATE` (serialización, §9.2) y vuelven a verificar `director_id` **ya con el lock** (para que una reasignación concurrente no deje pasar al director viejo). `ERRCODE 42501` para falta de permiso se alinea con T1/T2.

---

## 6. RPCs (migración 3)

Reglas comunes a todas: `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated;` seguido de `GRANT EXECUTE … TO authenticated;` (anon **sin** `EXECUTE`; `service_role` conserva el suyo por default y no se usa: el BFF **no** las llama). Errores con `ERRCODE` y `HINT` estables para el cliente. Mensajes en español.
Cada firma lleva `p_match uuid` y el `school_id` se **deriva del partido** (nunca llega del cliente).

### 6.1 `start_live_match(p_match uuid, p_options jsonb DEFAULT '{}'::jsonb) RETURNS jsonb`

Gate: `_live_auth(p_match,'staff')`. Idempotente por `match_id`.

```
m := _live_auth(p_match,'staff')
IF m.team_id IS NULL THEN RAISE 'P0001' 'El partido no tiene categoría' HINT 'MATCH_NO_TEAM'     -- football_match_events.team_id NOT NULL
IF m.status = 'cancelled' THEN RAISE 'P0001' 'Partido cancelado'
IF m.status = 'played' AND NOT EXISTS (match_live ...) THEN RAISE 'P0001' 'El partido ya está registrado como jugado'   -- no se enciende en retrospectiva en F1
INSERT INTO match_live (match_id, school_id, periods_planned, director_id, started_at) ... ON CONFLICT (match_id) DO NOTHING
IF ya existía: bloquear fila FOR UPDATE; si status='not_started' => se permite re-ajustar formato/director (idempotente, mismo uid o admin); si no, devolver _live_state_json sin cambios
-- formato: p_options.periods_count / period_minutes / periods[] (minutos por tiempo) > match_results.live_* > defaults (2, 45)
validar: 1..4 tiempos, cada tiempo 5..60 min  (22023 si no)
-- convocatoria
v_lineup := lineup de (team_match, p_match);  IF NULL o 0 titulares THEN RAISE 'P0001' 'Falta la convocatoria o los titulares' HINT 'NO_STARTERS'
-- dorsal obligatorio (C7)
faltan := convocados (starter y bench) con jersey_number IS NULL
IF faltan THEN RAISE 'P0001' 'Falta el dorsal de: <nombres>' HINT 'JERSEY_REQUIRED'   (DETAIL = jsonb con subjects)
repetidos := dorsales repetidos dentro del lineup => RAISE 'P0001' 'Dorsal repetido: n' HINT 'JERSEY_DUPLICATE'
-- periodos previstos
INSERT INTO match_live_periods (match_id, school_id, period_no, planned_seconds) por cada tiempo ON CONFLICT DO NOTHING
-- aviso (no bloqueo): ya hay football_match_events manuales de este partido => warnings += 'MANUAL_EVENTS_EXIST'
director_id := auth.uid()           -- D-V13: quien inicia
RETURN _live_state_json(p_match) || {warnings}
```

No inicia el reloj ni cambia `match_results.status` (sigue `scheduled` hasta terminar). Sin efecto sobre `save_match_roster` mientras `status='not_started'` (la reconvocatoria sigue permitida hasta el pitazo; los titulares se leen en el primer `period_start`).

### 6.2 `apply_live_events(p_match uuid, p_events jsonb) RETURNS jsonb`

La RPC de escritura única (online y cola offline). Gate: `_live_auth(p_match,'director')`.

Forma de cada elemento de `p_events`:
```json
{"client_event_id":"uuid","type":"sub","period_no":2,"period_second":431,"in_break":false,
 "subject":{"type":"child","id":"uuid"}, "related":{"type":"child","id":"uuid"},
 "reason":"tactical","payload":{}, "client_at":"2026-11-08T15:22:10-05:00"}
```

```
m := _live_auth(p_match,'director')
SELECT * INTO l FROM match_live WHERE match_id = p_match FOR UPDATE        -- serializa TODO escritor del partido
IF NOT FOUND THEN RAISE 'P0001' 'El partido no se ha iniciado en vivo' HINT 'LIVE_NOT_STARTED'
re-chequear director con el lock: IF l.director_id IS DISTINCT FROM auth.uid() AND NOT (admin OR platform admin) THEN NOT_DIRECTOR
IF l.status = 'finished' THEN RAISE 'P0001' 'El partido terminó; pida a la administración reabrirlo' HINT 'LIVE_FINISHED'
IF jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 200 THEN RAISE '22023'
FOR cada elemento i (en el orden recibido):
   validar tipo ∈ {period_start, period_end, sub, goal, goal_against, yellow, red, clock_adjust}     -- match_end/match_reopen/callup NO entran por aquí
   validar UUIDs, period_no 1..periods_planned, period_second 0..10800, subject/related según forma (misma tabla que el CHECK)
   INSERT INTO match_live_events (...) ON CONFLICT (match_id, client_event_id) DO NOTHING RETURNING id
   IF no insertó:   -- duplicado: doble toque o cola reenviada
        SELECT type, ... FROM match_live_events WHERE (match_id, client_event_id)
        IF type distinto al recibido THEN RAISE 'P0001' 'client_event_id reutilizado con otro contenido' HINT 'CLIENT_EVENT_ID_REUSED'
        duplicates += client_event_id ; CONTINUE
   applied += id
-- una sola repetición completa para todo el lote (los eventos quedan ordenados por (period_no, phase, period_second, seq))
res := _live_rebuild_stints(p_match)       -- lanza P0001 con DETAIL {index, client_event_id, code} si algún evento es inválido => TODO el lote se revierte
-- cinturón anti-futuro (§6.4)
UPDATE match_live SET status/current_period según res, updated_at = now()
RETURN jsonb_build_object('applied', applied, 'duplicates', duplicates, 'warnings', res->'warnings', 'state', _live_state_json(p_match))
```

- **Idempotencia:** `UNIQUE (match_id, client_event_id)` + `ON CONFLICT DO NOTHING`; el segundo envío devuelve el estado actual (T4).
- **Atomicidad:** cualquier excepción deshace el lote entero (es una sola transacción de la función). El error trae `DETAIL` con el `client_event_id` culpable y el motivo, para que la cola del celular lo muestre y lo descarte **a mano** (nunca en silencio, spec §8.2).
- **Fuera de orden:** los eventos se aplican por el orden del replay, no por orden de llegada: un lote atrasado produce el mismo resultado que enviados uno a uno (CT5).
- **`period_start` de `p_events`:** solo el director y solo si `period_no = current_period + 1`.
- Códigos de error del replay (todos `P0001`, `HINT`): `NOT_ON_FIELD`, `ALREADY_ON_FIELD`, `NOT_IN_LINEUP`, `SENT_OFF`, `PERIOD_ORDER`, `PERIOD_NOT_OPEN`, `EVENT_AFTER_PERIOD_END`, `FUTURE_EVENT`, `SUB_NEEDS_PERIOD_START`. Tope de jugadores en cancha: **aviso** (`warnings:[{code:'OVER_FIELD_CAP', n}]`), nunca bloqueo (D-V10; el tope es 11 para fútbol 11, leído de `payload` del `period_start` o por defecto 11).

### 6.3 `_live_rebuild_stints(p_match uuid)` — cálculo de tramos y minutos con reingresos

Interno; asume el lock de `match_live` ya tomado. Es una **repetición determinista** de todos los eventos no anulados:

```
orden := (period_no, phase, period_second, seq) con
  phase = 0  si in_break           -- cambios del descanso, antes del pitazo del tiempo siguiente
        = 1  si type='period_start'
        = 2  en cualquier otro caso
        = 3  si type='period_end'   -- cambios del último segundo ocurren antes del pitazo final

DELETE FROM match_player_stints WHERE match_id = p_match
reset: F = {} (en cancha), R = {} (expulsados), status='not_started', cur=0
UPDATE match_live_periods SET started_at=NULL, ended_at=NULL, actual_seconds=NULL WHERE match_id = p_match     -- se reescriben al avanzar

FOR e IN eventos no anulados EN ESE ORDEN:
  CASE e.type
  'period_start':
      exigir e.period_no = cur+1 y status ∈ {not_started, on_break}  (PERIOD_ORDER)
      IF e.period_no = 1 THEN F := titulares (role='starter') del lineup  — requiere ≥1 (NO_STARTERS)  [así la reconvocatoria previa al pitazo sí vale]
      status := 'in_period'; cur := e.period_no
      periods[cur].started_at := ancla (§6.4)
      por cada x en F: abrir tramo (cur, in_second=0)
  'sub':
      exigir (in_break=false AND status='in_period' AND e.period_no=cur) OR (in_break=true AND status='on_break' AND e.period_no=cur+1)
         (SUB_NEEDS_PERIOD_START si no ha empezado el primer tiempo)
      exigir related ∈ F (NOT_ON_FIELD), subject ∉ F (ALREADY_ON_FIELD), subject ∈ lineup (NOT_IN_LINEUP), subject ∉ R (SENT_OFF)
      F := F - related + subject
      si NOT in_break: cerrar tramo de related en e.period_second (ended_by 'sub'; si 0 s, se descarta) y abrir tramo de subject en e.period_second
      si in_break: no se escribe tramo ahora; el tramo se abre en el 'period_start' siguiente con in_second=0 (T8)
      si |F| > cap: warnings += OVER_FIELD_CAP
  'red':
      exigir subject ∈ lineup. R += subject.
      si subject ∈ F: F -= subject; si NOT in_break cerrar tramo en e.period_second (ended_by 'red'). (expulsado de banca solo se marca R)
  'yellow': exigir subject ∈ lineup; sin efecto en F
  'goal':        exigir status='in_period' y subject ∈ F  (el goleador está en cancha en ese segundo)
  'goal_against':exigir status='in_period'                 (sin jugador)
  'period_end':
      exigir status='in_period' AND e.period_no=cur
      periods[cur].actual_seconds := e.period_second; ended_at := ancla + e.period_second
      cerrar TODOS los tramos abiertos en e.period_second (ended_by 'period_end'; descartar los de 0 s)
      status := 'on_break'
  'clock_adjust': payload {period_no, planned_seconds 300..3600}; solo periodos no empezados o el actual; UPDATE planned_seconds
  'callup','match_end','match_reopen': sin efecto sobre F (son auditoría)
  FIN CASE
FIN FOR
al terminar: cualquier evento posterior a un period_end del mismo tiempo (period_second mayor) cae en status='on_break' y ya falló arriba con EVENT_AFTER_PERIOD_END
persistir: match_live.status / current_period; devolver {on_field:F, sent_off:R, warnings}
```

Reglas que quedan **probadas por construcción**:
- **Reingresos sin tope:** entrar/salir/entrar produce un tramo por entrada; no hay ningún límite ni unicidad por jugador.
- **Minutos por jugador** (lo consume `finish_live_match` y `match_live_report`):
  `segundos(j) = Σ (out_second − in_second)` de sus tramos;
  `minutos(j) = 0` si nunca entró; `GREATEST(1, round(segundos/60.0))` si `segundos > 0`.
  `duración_total = Σ actual_seconds` de los tiempos terminados; `% = segundos / duración_total` (D-V5 a, sobre lo realmente jugado). Para un tiempo aún abierto, `match_live_report` marca `out_second NULL` y el cliente suma hasta su reloj.
- **Cambio en el descanso:** (T8) `in_break=true`; el tramo del que entra nace en `in_second=0` del tiempo siguiente y el del que sale ya se cerró con `period_end`.
- **Roja:** cierra el tramo, mete a `R`, y cualquier `sub` posterior que lo haga entrar falla `SENT_OFF`.
- **Anulaciones:** el replay ignora eventos con `voided_at`; si anular deja inválido un evento posterior (p. ej. anular el cambio que metió a quien después salió), el replay falla y `void_live_event` revierte con `DEPENDENT_EVENTS`.

### 6.4 Ancla de pared y cinturón anti-futuro

- `periods.started_at` = `clamp(client_at del period_start, created_at − 12 h, created_at)` (si `client_at` es nulo, `created_at`). `ended_at = started_at + actual_seconds` (derivado, solo informativo).
- Cinturón: en `apply_live_events`, para eventos del lote de tiempo abierto, se rechaza `FUTURE_EVENT` si `period_second > extract(epoch from (now() − started_at)) + 120`. Es **tolerante a propósito** (cola offline: al sincronizar, `now()` es posterior a todos los eventos). La validación fuerte son las invariantes del replay, no la hora de pared.
- Si el reloj del celular está muy desfasado, no se rechaza nada legítimo; solo podría pasar un `period_second` demasiado grande hasta `120 s` por encima de lo real. Se acepta (riesgo R-08).

### 6.5 `finish_live_match(p_match uuid, p_score_for integer, p_score_against integer) RETURNS jsonb`

Gate: `_live_auth(p_match,'director')`. **Idempotente.**

```
m := _live_auth(p_match,'director');  l := match_live FOR UPDATE;  re-chequear director
IF l.status = 'finished' THEN RETURN match_live_report(p_match)      -- doble llamada: nada se duplica (T9)
IF l.status = 'not_started' THEN RAISE 'P0001' 'No hay tiempos jugados' HINT 'NOTHING_PLAYED'
IF p_score_for / p_score_against NULL o < 0 THEN RAISE '22023'
IF l.status = 'in_period' THEN                                         -- suspendido a mitad: cerrar el tiempo al momento
    insertar evento period_end (client_event_id nuevo, period_second = LEAST(planned*3, round(now() - ancla)))
INSERT match_live_events type='match_end' (period_no = cur, period_second = actual_seconds del último)
_live_rebuild_stints(p_match)                                          -- cierra tramos con 'match_end' si queda alguno
-- minutos: UNA sola sentencia
UPDATE match_lineup_players mlp
   SET minutes_played = COALESCE(x.minutos, 0)
  FROM (agregado por tramos → (lineup_id, subject_type, subject_id, minutos)) x RIGHT JOIN lineup actual …
 WHERE mlp.lineup_id = v_lineup                                        -- los convocados que no jugaron quedan en 0, no NULL
-- marcador y estado
UPDATE match_results SET home_score = CASE WHEN COALESCE(is_home,true) THEN p_score_for ELSE p_score_against END,
                         away_score = CASE WHEN COALESCE(is_home,true) THEN p_score_against ELSE p_score_for END,
                         status = 'played', updated_by = auth.uid(), updated_at = now()
-- espejo a estadística existente (idempotente, §8.4)
DELETE FROM football_match_events WHERE source_type='team_match' AND source_id=p_match AND live_event_id IS NOT NULL
INSERT … goal (con goleador) / assist (si related) / yellow / red con minute = ceil((Σ actual_seconds de tiempos previos + period_second)/60.0), live_event_id = e.id, team_id = m.team_id
-- borrador del informe: SOLO si no hay informe o sus 3 campos están en blanco
IF NOT EXISTS (SELECT 1 FROM match_reports WHERE match_id=p_match AND (btrim(coalesce(summary,''))<>'' OR btrim(coalesce(development,''))<>'' OR btrim(coalesce(improvements,''))<>'')) THEN
    INSERT INTO match_reports (match_id, school_id, summary, development, improvements, coach_id) VALUES (…, _live_draft_report(), NULL, auth.uid())
    ON CONFLICT (match_id) DO UPDATE SET summary = EXCLUDED.summary, development = EXCLUDED.development, updated_at = now()
       WHERE (campos actuales en blanco)                               -- nunca pisa texto del entrenador (T12)
-- NO se publica nada: published_at queda NULL; publicar sigue siendo publish_match_report manual
UPDATE match_live SET status='finished', finished_at=now(), finished_by=auth.uid(), updated_at=now()
RETURN match_live_report(p_match)
```

Notas: `improvements` queda NULL (no se inventa). El texto sigue la plantilla §9.3.1: `summary` = encabezado (Informe, Fecha, Hora, Partido, Lugar, Resultado, Tipo, Árbitro); `development` = Alineación, Sustituciones (banca), Cambios por tiempo, Anotaciones (con `7'47"` si no es redondo), Goles en contra (solo minuto y tiempo, «Ninguno» si no hay), Amonestaciones («Ninguna» si no hay). El **PDF** y el **copiar para WhatsApp** (F4) se arman en el frontend desde el `jsonb` de `match_live_report`, no desde este texto; el texto guardado es el borrador editable para el entrenador.

### 6.6 `reopen_live_match(p_match uuid) RETURNS jsonb`

Gate: `_live_auth(p_match,'admin')`. Con lock. `IF status <> 'finished' THEN` devuelve el estado (idempotente). Inserta evento `match_reopen`, pone `match_live.status='on_break'`, `reopened_at=now()`, `reopen_count+1`; **no** toca `match_results.status`, `minutes_played` ni el informe (los reescribe el siguiente `finish_live_match`; el informe editado no se pisa, T12).

### 6.7 `void_live_event(p_match uuid, p_event_id uuid) RETURNS jsonb`

Gate: `_live_auth(p_match,'director')`, lock, rechaza si `finished` (`LIVE_FINISHED`: primero reabrir). El evento debe ser de ese partido; si ya está anulado devuelve el estado (idempotente). Tipos no anulables: `match_end`, `match_reopen`, `callup`. `UPDATE … SET voided_at=now(), voided_by=auth.uid()`; `_live_rebuild_stints`; si el replay falla ⇒ `DEPENDENT_EVENTS` y todo se revierte. Nunca `DELETE` (D-V6).

### 6.8 `match_live_report(p_match uuid) RETURNS jsonb` — `STABLE`

Gate de lectura: `_live_auth(p_match,'staff')`. Solo lectura. Devuelve:

```
{ match: {id, date, kickoff_at, opponent, location, is_home, match_kind, referee_name, match_type},
  status, periods: [{period_no, planned_seconds, actual_seconds, stoppage_seconds}],
  lineup: [{subject_type, subject_id, name, jersey_number, role, seconds, minutes, pct, stints:[{period_no,in,out}], sent_off}],
  starters: [...], bench: [...],
  subs_by_period: [{period_no, items:[{second, in:{…}, out:{…}, reason, in_break}]}],
  goals_for: [{period_no, second, scorer, assist}], goals_against: [{period_no, second}],
  cards: [{type, period_no, second, subject}],   // vacío => la plantilla imprime «Ninguna»
  total_played_seconds, duration_label, score: {for, against} }
```

El nombre sale de `children` / `profiles` / `unregistered_athletes` según `subject_type`. Una sola consulta por fuente (nada de N+1; regla del repo: los BFF comparten la base). Para menores: en F1 el reporte solo lo ve el staff (la familia no ejecuta esta RPC: `_live_auth` exige staff). La versión para familias (solo su hijo) es F4/F6 con otra RPC.

### 6.9 `set_live_director(p_match uuid, p_new_director uuid) RETURNS jsonb`

Gate: `_live_auth(p_match,'admin')` (administración, D-V4). Con lock. Valida `_live_is_staff_of(p_new_director, m.school_id)` (rechaza familias o ajenos con `P0001 NEW_DIRECTOR_NOT_STAFF`), `UPDATE match_live SET director_id`. El estado vive en el servidor: el nuevo director lo lee con `match_live_report`/`_live_state_json` y su reloj se re-ancla con `period.started_at` y `actual_seconds` (§8.3 del spec).

### 6.10 `add_live_callup(p_match uuid, p_subject_type text, p_subject_id uuid, p_jersey integer, p_client_event_id uuid, p_role text DEFAULT 'bench') RETURNS jsonb`

(D-V7: sumar convocados en vivo / refuerzos.) Gate: `_live_auth(p_match,'director')`, lock; `status <> 'finished'`.

```
validar p_subject_type en ('profile','child','unregistered'); p_role IN ('bench','starter') pero 'starter' solo si status='not_started'
IF NOT _v2_sujeto_en_escuela(p_subject_type, p_subject_id, m.school_id) THEN RAISE '22023' 'El deportista no pertenece a esta escuela' HINT 'ROSTER_FOREIGN_PLAYER'
IF p_jersey IS NULL OR NOT BETWEEN 0 AND 999 THEN RAISE 'P0001' 'El dorsal es obligatorio' HINT 'JERSEY_REQUIRED'
IF dorsal ya usado por otro del lineup THEN RAISE 'P0001' 'Dorsal repetido' HINT 'JERSEY_DUPLICATE'
idempotencia: INSERT match_live_events (type='callup', period_no = GREATEST(current_period,1), period_second 0, subject_*, client_event_id) ON CONFLICT (match_id, client_event_id) DO NOTHING
   si ya existía → devolver el estado (no inserta la fila otra vez)
INSERT INTO match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, jersey_number)  -- solo INSERT: no toca las demás filas
   ON CONFLICT (lineup_id, subject_type, subject_id) DO NOTHING      -- ya convocado: no-op; si ya estaba sin dorsal, se le asigna el dorsal
UPDATE … SET jersey_number = p_jersey WHERE jersey_number IS NULL (si ya estaba convocado sin dorsal)
-- sin notificación a familias durante el partido en F1 (el aviso de convocatoria de save_match_roster no se replica)
RETURN _live_state_json(p_match)
```

El INSERT no dispara el trigger de §4.6 (solo DELETE/UPDATE OF role/subject).

### 6.11 `set_live_jersey(p_match uuid, p_subject_type text, p_subject_id uuid, p_jersey integer) RETURNS jsonb`

Corrección de dorsal en la cancha (un dedo mal puesto). Gate `director`, lock, mismas validaciones de rango y repetido; `UPDATE match_lineup_players SET jersey_number` (permitido por el trigger: no cambia role/subject). Disponible también con `finished`? **No** (reabrir primero).

### 6.12 Tabla resumen de grants y gates

| RPC | Gate adentro | Flag | `GRANT EXECUTE` | anon |
|---|---|---|---|---|
| `start_live_match` | staff de la escuela del partido | sí | authenticated | no |
| `apply_live_events` | director (o admin/platform admin) | sí | authenticated | no |
| `finish_live_match` | director (o admin) | sí | authenticated | no |
| `void_live_event` | director (o admin) | sí | authenticated | no |
| `add_live_callup` | director (o admin) | sí | authenticated | no |
| `set_live_jersey` | director (o admin) | sí | authenticated | no |
| `reopen_live_match` | admin de la escuela | sí | authenticated | no |
| `set_live_director` | admin de la escuela | sí | authenticated | no |
| `match_live_report` | staff | sí | authenticated | no |
| helpers `_live_*` | (internos) | — | **ninguno** (`REVOKE ALL … FROM PUBLIC, anon, authenticated`) | no |

Post-aplicación se verifica con `select proname, proacl, proconfig from pg_proc where proname like '%live%'` (filtrado por nombre): todas con `search_path=pg_catalog, public, pg_temp`, ninguna con `anon` ni `=X/` (PUBLIC) en el ACL, helpers sin `authenticated`.

---

## 7. Migración 4 — bloqueo de `save_match_roster`

### 7.1 Qué cambia

`CREATE OR REPLACE FUNCTION public.save_match_roster(p_match uuid, p_players jsonb)`: **cuerpo vivo copiado textual** (se re-extrae con `select prosrc, proconfig, proacl from pg_proc where proname='save_match_roster'` el día de aplicar; hoy coincide con `20261025003647`; si no coincide, se para y se reevalúa) y **una sola inserción**, justo después del chequeo de permiso y antes del chequeo de `p_players`:

```sql
  -- Partido en vivo ya iniciado: la reconvocatoria destructiva borraría minutos y orfanaría tramos.
  -- FOR SHARE serializa contra apply_live_events (que toma FOR UPDATE sobre la misma fila).
  PERFORM 1 FROM public.match_live l
   WHERE l.match_id = p_match AND l.status IN ('in_period','on_break','finished')
   FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'El partido ya empezó; use los cambios en vivo'
      USING ERRCODE = 'P0001', HINT = 'LIVE_STARTED';
  END IF;
```

Se conservan idénticos: `SECURITY DEFINER`, `SET search_path = pg_catalog, public, pg_temp`, firma, y ACL (`postgres, service_role, authenticated`; sin anon). Tras el `CREATE OR REPLACE` se re-verifica el ACL (un `CREATE OR REPLACE` conserva el ACL existente; aun así se incluye `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated;` explícito por si la sesión lo hubiera cambiado).

### 7.2 Por qué no necesita el flag
El bloqueo depende de que exista una fila de `match_live` con estado iniciado. Ninguna escuela distinta de Carmel puede crearla (`start_live_match` exige el flag), así que para las demás el chequeo es una búsqueda por PK que devuelve cero filas.

### 7.3 Dos puertas, un solo bloqueo
Camino RPC (`save_match_roster`) y camino REST directo (policies de `match_lineup_players` por `user_tactical_edit_school_ids()`): el primero lo corta el chequeo; el segundo, el trigger de §4.6.

### 7.4 `types.ts` y frontend
`save_match_roster` mantiene la firma: no cambia `types.ts` por esta migración. El frontend de F2 debe traducir `LIVE_STARTED` a un mensaje claro.

---

## 8. Detalles transversales

### 8.1 Idempotencia por `client_event_id`
Clave `UNIQUE (match_id, client_event_id)` + `INSERT … ON CONFLICT DO NOTHING`. Un reintento con el mismo UUID y el mismo `type` es un no-op que devuelve el estado actual; con otro `type`, `CLIENT_EVENT_ID_REUSED`. `add_live_callup` usa la misma llave vía un evento `callup`. `finish_live_match`, `reopen_live_match` y `void_live_event` son idempotentes por **estado** (ya terminado / ya reabierto / ya anulado).

### 8.2 Disk IO
Una escritura por evento; sin polling dentro de la base; el replay lee y reescribe decenas de filas por llamada; **sin** lectura de catálogos en tiempo de ejecución (ninguna RPC consulta `pg_*`); `match_live_report` es una lectura por partido con índices por `match_id`. Una sola sesión aplica las 4 migraciones; `types.ts` una sola vez. Los índices parciales de `match_live` son para el listado de «partidos en juego» (no se usa en F1 salvo el panel de administración de F5).

### 8.3 Un solo director
`director_id` único; `apply_live_events` valida contra el valor leído **con el lock**. Si se reasigna con eventos pendientes en el celular del director anterior, esos eventos se rechazan con `NOT_DIRECTOR` y el celular los muestra (riesgo R-06).

### 8.4 Espejo a `football_match_events`
Solo al terminar y siempre por **borrar y reinsertar lo propio** (`live_event_id IS NOT NULL` del partido), dentro de la misma transacción de `finish_live_match`; nunca toca filas manuales (con `live_event_id` nulo). Si ya existen eventos manuales del partido al iniciar, `start_live_match` devuelve un aviso `MANUAL_EVENTS_EXIST` (la pantalla de F3 desactiva la carga manual de eventos mientras el partido esté en vivo, para no duplicar). `own_goal` (gol de un jugador en su propia puerta) **no** se modela en v1: el gol que sufre el equipo es `goal_against` sin jugador (decisión 16.1/plantilla).

---

## 9. Pruebas

> **Dónde se corren:** en el **gemelo local** (`npm run qa:twin:up`; el mismo camino de `supabase/verificaciones/reservas-f1-*`), **no** contra la base viva compartida (regla del usuario: los datos de prueba no se borran en la base viva; y Disk IO). Contra la base viva solo lecturas de verificación (§10 y §9.4). Archivos propuestos: `supabase/verificaciones/partido-en-vivo-f1/pruebas.sql`, `concurrencia.mjs`, `radio.sql`, `reversa.sql` (ninguno es una migración).

### 9.1 Simulación de sesión (SQL)

Plantilla (cada prueba dentro de `BEGIN … ROLLBACK`, en el gemelo):

```sql
BEGIN;
select set_config('request.jwt.claims', json_build_object('sub','<uuid>','role','authenticated')::text, true);
set local role authenticated;
-- select public.start_live_match('<match>');   ← la llamada de la prueba
ROLLBACK;
```

Personajes del gemelo: **P** padre vinculado a un jugador de Carmel; **C1** coach de Carmel; **A1** administración de Carmel; **C2** coach de otra escuela (flag apagado); **A2** admin de otra escuela; **PA** platform admin; **anon**.

| # | Prueba | Esperado |
|---|---|---|
| T1 | P llama a cada RPC (9) | `42501` en todas; `select` directo a las 4 tablas → 0 filas |
| T1b | anon llama a cada RPC | `permission denied for function` (sin `EXECUTE`); `select` a las tablas → denegado |
| T2 | C2 y A2 llaman cada RPC sobre un partido de Carmel | `42501` («Sin permiso sobre esta escuela») |
| T3 | C2 sobre un partido propio (escuela sin flag); y **PA** sobre partido de escuela sin flag; y Carmel con el flag apagado temporalmente | `P0001 LIVE_DISABLED` en todas (también PA) |
| T3b | `insert/update/delete` directo de C1 sobre las 4 tablas | denegado (sin grant ni policy) |
| T4 | Mismo `client_event_id` dos veces (serial) | 1 fila; la segunda devuelve `duplicates:[id]`; mismo estado |
| T4b | Mismo `client_event_id` con otro `type` | `CLIENT_EVENT_ID_REUSED` |
| T5 | Lote [sub válido, sub con jugador que no está en cancha] | `NOT_ON_FIELD`, **0 filas nuevas** en `match_live_events` (incluido el válido) |
| T6 | Titular sale, banca entra, sale, titular vuelve | 3 tramos del titular o 2 + 1 según el caso; suma correcta; sin tope de reingresos |
| T7 | Roja a un jugador en cancha y luego intento de reingreso | tramo cerrado `ended_by='red'`; `SENT_OFF` |
| T8 | Cambio en descanso (`in_break=true`, `period_no=2`) | tramo de quien entra con `in_second=0` en el tiempo 2; el de quien sale cerrado en `period_end` del 1 |
| T9 | `finish_live_match` dos veces | mismos minutos, **1** fila de `match_reports`, `football_match_events` sin duplicados (conteo con `live_event_id` igual) |
| T10 | `save_match_roster` con partido iniciado (por RPC) y `DELETE` directo a `match_lineup_players` (por REST) | ambos `P0001 LIVE_STARTED`; las filas siguen; `minutes_played` intacto |
| T10b | Con `status='not_started'` (tras `start_live_match`, antes del pitazo) | `save_match_roster` **sí** funciona |
| T11 | Anular un cambio | minutos recalculados al releer; si el cambio anulado era base de otro posterior → `DEPENDENT_EVENTS` y nada cambia |
| T12 | Informe ya editado + reabrir + terminar otra vez | texto del entrenador intacto; `improvements` sigue NULL; `published_at` sigue NULL |
| T13 | Dorsales: convocado sin dorsal / dorsal repetido / `add_live_callup` sin dorsal | `JERSEY_REQUIRED` / `JERSEY_DUPLICATE` |
| T14 | Borrado de escuela/usuario con un partido en vivo en el gemelo (cascada) | no lo bloquea el trigger (`pg_trigger_depth() > 1`) |
| T15 | Gol con jugador que no está en cancha / gol en el descanso / gol en contra con jugador | `NOT_ON_FIELD` / `PERIOD_NOT_OPEN` / violación de CHECK de forma |
| T16 | `set_live_director` a un padre | `NEW_DIRECTOR_NOT_STAFF`; a un coach de la escuela → ok; el director viejo ya no puede escribir (`NOT_DIRECTOR`) |
| T17 | Suspensión: `finish_live_match` en `in_period` | cierra el tiempo al momento, tramos con `match_end`/`period_end`, minutos escritos |
| T18 | Tiempos desiguales (25′+25′+15′) y tiempo añadido | `% = segundos / Σ actual_seconds`; `stoppage_seconds` correcto |
| T19 | Invariantes | `npm run seguridad:invariantes` sin críticas (I1–I4) |

### 9.2 Concurrencia (`concurrencia.mjs`, `pg` pool contra el gemelo; cada conexión hace su propio `BEGIN; set_config(...local); set local role authenticated; …; COMMIT`)

| # | Escenario | Esperado |
|---|---|---|
| CT1 | **Dos directores:** D1 (director) y D2 (admin que reasigna) en paralelo: D2 llama `set_live_director` a otro mientras D1 manda 20 `apply_live_events` | El lock de `match_live` los serializa; tras la reasignación los lotes de D1 salen con `NOT_DIRECTOR`; **nunca** quedan eventos de dos escritores intercalados con el mismo reloj; el conteo de eventos = el de los aceptados |
| CT2 | **Doble evento:** 50 llamadas simultáneas con el **mismo** `client_event_id` desde 2 conexiones (simula dos pestañas) | exactamente 1 fila; todas devuelven el mismo estado; ningún error 23505 sale al cliente |
| CT3 | **Mismo cambio con llaves distintas** (dos toques con dos `client_event_id`) | el segundo falla `NOT_ON_FIELD` (o `ALREADY_ON_FIELD`) por replay: no hay doble minuto |
| CT4 | **`finish_live_match` en paralelo ×10** | un solo informe, un solo conjunto de espejo, mismos minutos |
| CT5 | **Eventos fuera de orden:** lote A con `period_second` 900 llega antes que lote B con 300 (mismo tiempo, jugadores disjuntos) | resultado final idéntico al de enviarlos en orden (comparar `match_player_stints` y minutos) |
| CT6 | **Carrera `save_match_roster` vs `apply_live_events`** (primer `period_start`) | si gana el pitazo, la reconvocatoria falla `LIVE_STARTED`; si gana la reconvocatoria, el pitazo lee los titulares nuevos; nunca tramos huérfanos (comprobar que todo `subject` de `match_player_stints` está en el lineup) |
| CT7 | `void_live_event` vs `apply_live_events` simultáneos sobre eventos dependientes | un orden serial válido; sin estados intermedios; sin `DEPENDENT_EVENTS` espurio |

### 9.3 Cómo se prueban las firmas de seguridad (checklist de `pg_proc`, solo lectura)
`proacl` sin `anon` ni PUBLIC, `proconfig` con `search_path`, helpers sin grants a `authenticated`; `pg_policies` de las 4 tablas = 4 filas SELECT.

### 9.4 Verificaciones sobre la base viva (solo lectura, tras aplicar)
Las de §10 y `seguridad:invariantes`. **No** se crea ningún partido de prueba en la base viva; el primer uso real es el partido de práctica de Carmel con Julián (F5).

---

## 10. Medición del radio (el flag solo Carmel ⇒ 0 efecto en otras escuelas)

Se corre **antes** (línea base) y **después** de aplicar, con consultas **por nombre** (sin catálogos masivos). Una consulta a la vez con `npx supabase db query --remote --read-only -f radio.sql -o json`.

| # | Consulta (resumen) | Antes | Después (esperado) | Qué demuestra |
|---|---|---|---|---|
| R1 | `select count(*), count(*) filter (where live_match_enabled) from school_settings` | columna no existe | 373 filas, **1** con flag (Carmel); `select school_id from school_settings where live_match_enabled` = `374a6716-…` | El flag está solo en Carmel |
| R2 | `select count(*) from v_school_entitlements where live_match_enabled` y `select count(*) from v_school_entitlements` | n/a | 1 y el mismo total que antes | La vista solo ganó una columna |
| R3 | Hash por escuela de todas las columnas **menos** la nueva: `select md5(string_agg(to_jsonb(v) - 'live_match_enabled'::text …))` antes y después | h0 | h0 igual | La definición copiada no alteró ninguna otra columna ni fila |
| R4 | `reloptions` de la vista y orden de columnas (`information_schema.columns` de `v_school_entitlements`) | r0 | r0 + 1 columna al final | Sin 42P16 ni cambio de opciones (`security_invoker`) |
| R5 | `select count(*) from match_live`; `… where school_id <> '374a6716-…'` | tabla no existe | 0 y 0 | Ninguna otra escuela tiene estado en vivo ⇒ el chequeo de `save_match_roster` y el trigger no actúan sobre nadie |
| R6 | `select count(*) filter (where match_kind <> 'official'), count(*) filter (where live_periods_count is not null or live_period_minutes is not null or referee_name is not null) from match_results` | n/a | 0 y 0 (55 partidos) | Las columnas de agenda no cambiaron ningún partido existente |
| R7 | Comparar `prosrc` de `save_match_roster` con el de antes: la diferencia debe ser **solo** el bloque nuevo; y `proacl`/`proconfig` idénticos | p0 | p0 + bloque | Cambio mínimo, mismo ACL |
| R8 | `select count(*) from football_match_events where live_event_id is not null` | n/a | 0 | El espejo no se ejecuta sin partido en vivo terminado |
| R9 | Probar `start_live_match` desde sesión simulada de otra escuela **en el gemelo** | n/a | `LIVE_DISABLED` | Gate de flag verificado en acción (T3) |
| R10 | Tiempo de `save_match_roster` en el gemelo antes/después con una convocatoria de 25 | t0 | ≈ t0 (+1 búsqueda por PK; +2 por fila por el trigger) | Sin regresión de latencia |

Criterio de aprobación del radio: R1–R8 coinciden con «Después» o **se revierte** (§11).
Medir además el efecto de los pools: ninguna RPC nueva se llama desde jobs del BFF; no hay consultas por minuto (sin N+1).

---

## 11. Plan de reversa

La reversa **no edita ni borra migraciones** (inmutables): es un script `supabase/verificaciones/partido-en-vivo-f1/reversa.sql` que se convierte en una migración **nueva** con timestamp posterior si hay que usarlo. Orden inverso al de aplicar. Se mide el radio **antes** de ejecutarla (datos reales de Carmel pueden existir).

| Paso | Acción | Notas |
|---|---|---|
| 0 (apagado suave, preferible) | `UPDATE school_settings SET live_match_enabled = false WHERE school_id = '374a6716-…'` | Detiene todo uso sin borrar nada. Los datos registrados quedan (spec §11). Es la reversa normal |
| 1 | Restaurar `save_match_roster` al cuerpo de `20261025003647` (sin el bloqueo) y re-verificar ACL | Solo si el bloqueo causara un problema; con el flag apagado igual protege los partidos ya iniciados |
| 2 | `DROP TRIGGER trg_live_guard_lineup_players …; DROP FUNCTION _live_guard_lineup_players()` | Reversible sin pérdida |
| 3 | `DROP FUNCTION` de las RPCs y helpers (`_live_*`, `start_live_match`, `apply_live_events`, `finish_live_match`, `void_live_event`, `reopen_live_match`, `match_live_report`, `set_live_director`, `add_live_callup`, `set_live_jersey`) | |
| 4 | **Antes de borrar tablas:** exportar `match_live_events` y `match_player_stints` de partidos reales (`COPY`/JSON a disco) | `minutes_played`, marcador, informe y `football_match_events` espejados **ya viven en las tablas originales** y no se pierden |
| 5 | `DROP TABLE match_player_stints, match_live_events, match_live_periods, match_live` (en ese orden) | Solo si no hay partidos reales o ya se exportaron |
| 6 | `DROP INDEX football_match_events_live_event_idx; ALTER TABLE football_match_events DROP COLUMN live_event_id` | |
| 7 | `ALTER TABLE match_results DROP COLUMN live_periods_count, live_period_minutes, match_kind, referee_name` | **Si el frontend de agendar ya los escribe, revisar antes** |
| 8 | Vista: `CREATE OR REPLACE VIEW` **no puede quitar columnas** (42P16). Se deja la columna `live_match_enabled` en la vista (apuntando a la columna del settings); si hay que quitarla: `DROP VIEW` + recrear con la definición viva sin ella, en una sola transacción y verificando dependencias | Por eso el paso 8 es el último y raro |
| 9 | `ALTER TABLE school_settings DROP COLUMN live_match_enabled` (después de 8) | |
| 10 | `ALTER TABLE match_lineup_players DROP CONSTRAINT match_lineup_players_jersey_range_chk` | |

Condición para reversa parcial segura: si solo falla la parte frontend, **no se revierte nada de base**: se apaga el flag.

---

## 12. Qué NO regenerar / no hacer (Disk IO y reglas del repo)

- **`types.ts` (`gen types` / `generate_typescript_types`): una sola vez**, después de aplicar y verificar las 4 migraciones. No después de cada una.
- **No** `list_tables`, **no** `get_advisors`, **no** listados de funciones como sondeo: consultas por nombre sobre `pg_policies` / `pg_proc` / `information_schema` del objeto puntual.
- **No** aplicar migraciones desde agentes o sesiones en paralelo; una sola sesión, en el orden de §2; no mezclar con las migraciones sin commitear de otras sesiones (`20261105211824`, `…212046`, `…212125`): se aplican antes o después, no intercaladas, y cada una por su dueño.
- **No** `npm run migrations:sync` ni editar `supabase/migrations_ledger.json` a mano: lo hace `migrations:new`; el ledger se commitea junto al `.sql` y `migrations:check` debe pasar.
- **No** `service_role` para llamar estas RPCs (sin `auth.uid()` el gate las rechaza a propósito).
- **No** pegar SQL en el SQL Editor: aplicar por CLI/`apply_migration` para dejar rastro.
- **No** commitear con `git add -A`: varias sesiones trabajan en `develop` (commit solo lo propio con índice temporal).
- **No** crear partidos de prueba en la base viva compartida.

---

## 13. Riesgos

| ID | Riesgo | Mitigación / estado |
|---|---|---|
| R-01 | El replay completo en cada escritura crece con el partido | Decenas de eventos por partido; coste lineal trivial. Si algún día no basta, se hace incremental con el mismo modelo de eventos |
| R-02 | Los **cambios de `save_match_roster`** afectan una RPC global | Va **última**; el chequeo no actúa sin `match_live`; se mide con R5/R7 y T10b |
| R-03 | Dorsal obligatorio solo en el en vivo (no `NOT NULL` global) deja convocatorias de otras escuelas sin dorsal | Es intencional (C7). Si se quiere el dorsal obligatorio para todos, se hace en otra fase con migración de datos |
| R-04 | Un coach de **otra categoría** de Carmel puede iniciar un partido ajeno (el gate es «staff de la escuela») | Es lo que dice el spec §10. Si Carmel lo quiere cerrado, añadir restricción por `team_id` (D-P3) |
| R-05 | **Fuga de minutos antes de publicar:** `finish_live_match` escribe `minutes_played`, y `match_lineup_players_select` + `ChildReportDetailPage`/`reportsQueries` ya muestran los minutos del hijo a su acudiente **sin esperar la publicación** | D-V12 pide «solo si se publica». Hay que **decidir** (D-P1): (a) aceptar (dato del propio hijo; Carmel tiene 0 acudientes vinculados hoy) o (b) escribir `minutes_played` solo al publicar el informe |
| R-06 | Reasignar director con eventos offline pendientes del anterior | Se rechazan con `NOT_DIRECTOR` y se muestran; la administración puede rescatar escribiendo como admin |
| R-07 | El trigger de `match_lineup_players` añade latencia a convocatorias de todas las escuelas | Dos búsquedas por PK por fila borrada/cambiada; se mide en R10; es la única pieza «global», fácil de quitar (§11 paso 2) |
| R-08 | Reloj de pared del celular desfasado | La verdad es `period_second` y las invariantes del replay; el único uso de pared es el cinturón `FUTURE_EVENT` (tolerancia 120 s) y `started_at` informativo |
| R-09 | Aviso de `football_match_events` manuales previos duplicando goles | Aviso `MANUAL_EVENTS_EXIST` + UI sin carga manual en vivo; el espejo solo toca filas con `live_event_id` |
| R-10 | `match_live_finished_chk` demasiado ingeniosa | Se puede simplificar o quitar; las RPCs son la invariante real |
| R-11 | Ventana de `lock_timeout = 3s` hace fallar una migración en hora pico | Se reintenta; son `ADD COLUMN` instantáneos; mejor fallar que encolar sobre `school_settings` |
| R-12 | Informe: el texto guardado y el PDF/WhatsApp (desde el `jsonb`) pueden diferir | El texto es solo borrador editable; el PDF sale del `jsonb` (plantilla §9.3.1) en F4 |
| R-13 | `match_kind`/`referee_name` visibles a familias vía `match_results_select` | Poco sensible; ocultarlo es decisión de UI (D-P2) |
| R-14 | `security_audit_log` no existe en la base viva todavía | No hay dependencia: auditoría propia en `match_live_events` |

---

## 14. Decisiones que necesito del usuario antes de crear los `.sql`

| ID | Pregunta | Recomendación |
|---|---|---|
| D-P1 | R-05: ¿los minutos del hijo pueden verse en su informe **al terminar** (a) o **solo cuando se publique** (b)? | (a) en F1 porque hoy Carmel tiene 0 acudientes vinculados; si se prevé familias pronto, (b) con un cambio pequeño (`finish_live_match` no escribe `minutes_played`; `publish_match_report` lo escribe) |
| D-P2 | ¿Se oculta el nombre del árbitro a las familias? | Sí en UI (no es columna sensible) |
| D-P3 | ¿Quién puede iniciar: cualquier staff de Carmel o solo el coach de esa categoría + administración? | Cualquier staff (spec §10) y reasignación por administración |
| D-P4 | Cambios sobre el spec C1–C8 (§1.2), en especial `period_second` en vez de `game_second` y el espejo a `football_match_events` | Aprobar |
| D-P5 | Formato por defecto si el partido se agenda sin escoger tiempos | 2 tiempos de 45′ |

---

## 15. Checklist de aprobación

- [ ] Decisiones D-P1 a D-P5 respondidas.
- [ ] Cambios C1–C8 aprobados (en especial C1 y C2).
- [ ] Orden y slugs de §2 aprobados (4 migraciones, una sesión, `lock_timeout 3s`).
- [ ] DDL de §3–§4 revisado tabla por tabla (text+CHECK, FKs a `profiles`, `school_id` en cada tabla, índices).
- [ ] RLS de §4.5 revisada línea por línea: una sola policy SELECT por tabla, sin escritura, `anon` sin nada, sin `FOR ALL`.
- [ ] Trigger de §4.6 aceptado (o decisión de quitarlo y confiar en el bloqueo de la RPC).
- [ ] RPCs de §6: firma, gate adentro atado al `school_id` del partido, flag adentro, `GRANT EXECUTE` a `authenticated` y nada a `anon`, helpers sin grants.
- [ ] Bloqueo de `save_match_roster` (§7) y refuerzos por `add_live_callup` aceptados.
- [ ] Pruebas T1–T19 y CT1–CT7 aceptadas, corridas en el **gemelo**.
- [ ] Medición de radio R1–R10 aceptada (línea base tomada **antes** de aplicar).
- [ ] Plan de reversa de §11 aceptado (primer recurso: apagar el flag).
- [ ] Confirmado: `types.ts` una sola vez al final; nada de `list_tables`/`get_advisors`; ninguna otra sesión aplicando migraciones durante la ventana.
- [ ] Confirmado: la definición de `v_school_entitlements` y el cuerpo de `save_match_roster` se re-extraen de la base viva **el día de aplicar** (no de este documento).
- [ ] Después de aplicar: `npm run seguridad:invariantes` sin críticas; simulación de sesión de padre / coach ajeno / coach de Carmel.
