-- =============================================================================
-- 20261105231608_partido_vivo_rpcs.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105231602
-- Objetivo: Partido en vivo de Carmel, Fase 1, migración 3 de 4
--   (docs/plan-partido-en-vivo-f1.md §5 y §6). Helpers internos + 9 RPCs públicas.
-- PRECONDICIÓN: 20261105231554 (flag, columnas) y 20261105231602 (tablas).
-- ORDEN: 3 de 4. No toca ninguna función existente (eso es la 4).
--
-- REGLAS (todas las funciones):
--   · SECURITY DEFINER + SET search_path = pg_catalog, public, pg_temp.
--   · Gate de alcance y flag ADENTRO (_live_auth), atado al school_id DEL PARTIDO
--     (nunca llega del cliente). El flag live_match_enabled aplica también al
--     platform admin.
--   · RPC públicas (9): REVOKE ALL FROM PUBLIC, anon, authenticated + GRANT EXECUTE
--     TO authenticated. Helpers _live_*: REVOKE ALL FROM PUBLIC, anon, authenticated y
--     SIN grant (solo los llaman las RPC, mismo dueño).
--   · Escritura serializada: toda RPC de escritura toma match_live FOR UPDATE y
--     re-chequea al director YA con el lock.
--   · D-P1=A (ajustada): los MINUTOS se calculan en vivo desde los tramos
--     (match_player_stints) y los lee el staff por match_live_report en vivo y al
--     terminar. finish_live_match NO escribe match_lineup_players.minutes_played;
--     ese espejo (la columna que leen las pantallas del acudiente) se hace al PUBLICAR
--     el informe (_live_write_minutes, enganchado en la migración 4).
--   · Decisión de implementación: match_live_report y _live_state_json son VOLATILE
--     (el plan decía STABLE) porque releen lo escrito en la misma transacción.
--   · clock_adjust no se puede anular (se corrige con otro clock_adjust).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- ===========================================================================
-- A. Helpers puros / de lectura (internos)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public._live_fmt_clock(p_sec integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT (p_sec / 60)::text || ''''
         || CASE WHEN p_sec % 60 = 0 THEN '' ELSE lpad((p_sec % 60)::text, 2, '0') || '"' END;
$$;

CREATE OR REPLACE FUNCTION public._live_period_label(p_no integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE p_no WHEN 1 THEN '1.er tiempo' WHEN 2 THEN '2.º tiempo'
                   WHEN 3 THEN '3.er tiempo' ELSE '4.º tiempo' END;
$$;

CREATE OR REPLACE FUNCTION public._live_keys_to_json(p_keys text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'subject_type', split_part(k, ':', 1),
           'subject_id',   split_part(k, ':', 2)::uuid) ORDER BY k), '[]'::jsonb)
    FROM unnest(COALESCE(p_keys, '{}'::text[])) k;
$$;

-- Convocatoria del partido con nombres (sin gate: solo la llaman otras funciones).
CREATE OR REPLACE FUNCTION public._live_lineup_rows(p_match uuid)
RETURNS TABLE (subject_type text, subject_id uuid, role text, jersey_number integer, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT mlp.subject_type, mlp.subject_id, mlp.role, mlp.jersey_number,
         COALESCE(ch.full_name, pr.full_name, ua.full_name, 'Sin nombre')::text
    FROM public.match_lineups ml
    JOIN public.match_lineup_players mlp ON mlp.lineup_id = ml.id
    LEFT JOIN public.children ch              ON mlp.subject_type = 'child'        AND ch.id = mlp.subject_id
    LEFT JOIN public.profiles pr              ON mlp.subject_type = 'profile'      AND pr.id = mlp.subject_id
    LEFT JOIN public.unregistered_athletes ua ON mlp.subject_type = 'unregistered' AND ua.id = mlp.subject_id
   WHERE ml.source_type = 'team_match' AND ml.source_id = p_match;
$$;

-- Mensajes estables: código en HINT, mensaje en español, DETAIL jsonb para la cola del celular.
CREATE OR REPLACE FUNCTION public._live_raise(
  p_code text,
  p_client uuid DEFAULT NULL,
  p_event uuid DEFAULT NULL,
  p_type text DEFAULT NULL,
  p_extra text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_msg text;
BEGIN
  v_msg := CASE p_code
    WHEN 'LIVE_DISABLED'            THEN 'El partido en vivo no está habilitado para esta escuela'
    WHEN 'NOT_DIRECTOR'             THEN 'No eres el director de este partido'
    WHEN 'LIVE_NOT_STARTED'         THEN 'El partido no se ha iniciado en vivo'
    WHEN 'LIVE_FINISHED'            THEN 'El partido terminó; pide a la administración reabrirlo'
    WHEN 'MATCH_NO_TEAM'            THEN 'El partido no tiene categoría'
    WHEN 'MATCH_CANCELLED'          THEN 'El partido está cancelado'
    WHEN 'MATCH_ALREADY_PLAYED'     THEN 'El partido ya está registrado como jugado'
    WHEN 'NO_STARTERS'              THEN 'Falta la convocatoria o los titulares'
    WHEN 'JERSEY_REQUIRED'          THEN 'Falta el dorsal'
    WHEN 'JERSEY_DUPLICATE'         THEN 'Dorsal repetido'
    WHEN 'NOTHING_PLAYED'           THEN 'No hay tiempos jugados'
    WHEN 'NOT_ON_FIELD'             THEN 'El jugador no está en la cancha'
    WHEN 'ALREADY_ON_FIELD'         THEN 'El jugador ya está en la cancha'
    WHEN 'NOT_IN_LINEUP'            THEN 'El jugador no está en la convocatoria'
    WHEN 'SENT_OFF'                 THEN 'El jugador fue expulsado'
    WHEN 'PERIOD_ORDER'             THEN 'Orden de tiempos inválido'
    WHEN 'PERIOD_NOT_OPEN'          THEN 'El tiempo no está abierto'
    WHEN 'EVENT_AFTER_PERIOD_END'   THEN 'El evento es posterior al final del tiempo'
    WHEN 'FUTURE_EVENT'             THEN 'El evento está en el futuro respecto al reloj del partido'
    WHEN 'SUB_NEEDS_PERIOD_START'   THEN 'Aún no ha empezado el primer tiempo'
    WHEN 'CLOCK_ADJUST_CLOSED'      THEN 'Ese tiempo ya terminó; no se puede ajustar'
    WHEN 'PAYLOAD_INVALID'          THEN 'Datos del evento inválidos'
    WHEN 'EVENT_SHAPE_INVALID'      THEN 'Forma del evento inválida'
    WHEN 'CLIENT_EVENT_ID_REUSED'   THEN 'client_event_id reutilizado con otro contenido'
    WHEN 'DEPENDENT_EVENTS'         THEN 'No se puede anular: hay eventos posteriores que dependen de este'
    WHEN 'EVENT_NOT_VOIDABLE'       THEN 'Ese tipo de evento no se puede anular'
    WHEN 'NEW_DIRECTOR_NOT_STAFF'   THEN 'El nuevo director debe trabajar en la escuela'
    WHEN 'ROSTER_FOREIGN_PLAYER'    THEN 'El deportista no pertenece a esta escuela'
    ELSE p_code
  END;
  RAISE EXCEPTION '%', v_msg || COALESCE(': ' || p_extra, '')
    USING ERRCODE = 'P0001',
          HINT = p_code,
          DETAIL = jsonb_strip_nulls(jsonb_build_object(
                     'code', p_code, 'client_event_id', p_client,
                     'event_id', p_event, 'type', p_type))::text;
END $$;

-- ¿p_uid trabaja en esa escuela? (ramas de user_staff_school_ids() sin la rama por email)
CREATE OR REPLACE FUNCTION public._live_is_staff_of(p_uid uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND p_school IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.school_members sm
                WHERE sm.profile_id = p_uid AND sm.school_id = p_school AND sm.status = 'active'
                  AND sm.role NOT IN ('parent', 'athlete', 'accountant'))
    OR EXISTS (SELECT 1 FROM public.school_staff ss
                WHERE ss.coach_auth_id = p_uid AND ss.school_id = p_school AND ss.status = 'active')
    OR EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school AND s.owner_id = p_uid)
  );
$$;

-- ===========================================================================
-- B. Gate único
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._live_auth(p_match uuid, p_level text)
RETURNS public.match_results
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  m        public.match_results;
  v_dir    uuid;
  v_exists boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_level NOT IN ('staff', 'director', 'admin') THEN
    RAISE EXCEPTION 'nivel de gate inválido' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO m FROM public.match_results WHERE id = p_match;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partido no encontrado' USING ERRCODE = '02000';
  END IF;
  -- alcance atado al school_id DEL PARTIDO
  IF p_level IN ('staff', 'director') THEN
    IF NOT (m.school_id = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
      RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
    END IF;
  END IF;
  -- flag ADENTRO (también para el platform admin)
  IF NOT COALESCE((SELECT ss.live_match_enabled FROM public.school_settings ss
                    WHERE ss.school_id = m.school_id), false) THEN
    PERFORM public._live_raise('LIVE_DISABLED');
  END IF;
  IF p_level = 'director' THEN
    SELECT l.director_id INTO v_dir FROM public.match_live l WHERE l.match_id = p_match;
    v_exists := FOUND;
    IF v_exists
       AND v_dir IS DISTINCT FROM v_uid
       AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
      PERFORM public._live_raise('NOT_DIRECTOR');
    END IF;
  END IF;
  RETURN m;
END $$;

-- ===========================================================================
-- C. Tramos: abrir / cerrar (internos)
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._live_open_stint(
  p_match uuid, p_school uuid, p_key text, p_period integer, p_second integer, p_event uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.match_player_stints
         (match_id, school_id, subject_type, subject_id, period_no, in_second, in_event_id)
  VALUES (p_match, p_school, split_part(p_key, ':', 1), split_part(p_key, ':', 2)::uuid,
          p_period, p_second, p_event)
  ON CONFLICT (match_id, subject_type, subject_id, period_no, in_second) DO NOTHING;
$$;

-- Cierra el tramo abierto del jugador; si dura 0 s se descarta (CHECK out > in).
CREATE OR REPLACE FUNCTION public._live_close_stint(
  p_match uuid, p_key text, p_second integer, p_by text, p_event uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM public.match_player_stints s
   WHERE s.match_id = p_match AND s.subject_type = split_part(p_key, ':', 1)
     AND s.subject_id = split_part(p_key, ':', 2)::uuid
     AND s.out_second IS NULL AND s.in_second >= p_second;
  UPDATE public.match_player_stints s
     SET out_second = p_second, ended_by = p_by, out_event_id = p_event
   WHERE s.match_id = p_match AND s.subject_type = split_part(p_key, ':', 1)
     AND s.subject_id = split_part(p_key, ':', 2)::uuid
     AND s.out_second IS NULL;
END $$;

-- ===========================================================================
-- D. Repetición completa de eventos (fuente de verdad -> tramos)
--    Asume el lock de match_live ya tomado. p_persist=false: solo calcula.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._live_rebuild_stints(p_match uuid, p_persist boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  l          public.match_live;
  v_lineup   uuid;
  v_all      text[];
  v_starters text[];
  v_f        text[] := '{}';
  v_r        text[] := '{}';
  v_status   text := 'not_started';
  v_cur      integer := 0;
  v_cap      integer := 11;
  v_warn     jsonb := '[]'::jsonb;
  v_ends     jsonb := '{}'::jsonb;
  e          record;
  ks         text;
  kr         text;
  v_ok       boolean;
  v_anchor   timestamptz;
  v_ps       integer;
BEGIN
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match;
  IF NOT FOUND THEN
    PERFORM public._live_raise('LIVE_NOT_STARTED');
  END IF;

  SELECT ml.id INTO v_lineup FROM public.match_lineups ml
   WHERE ml.source_type = 'team_match' AND ml.source_id = p_match;
  SELECT COALESCE(array_agg(mlp.subject_type || ':' || mlp.subject_id), '{}'),
         COALESCE(array_agg(mlp.subject_type || ':' || mlp.subject_id) FILTER (WHERE mlp.role = 'starter'), '{}')
    INTO v_all, v_starters
    FROM public.match_lineup_players mlp WHERE mlp.lineup_id = v_lineup;

  -- segundo del pitazo final por tiempo (eventos no anulados)
  SELECT COALESCE(jsonb_object_agg(x.period_no::text, x.period_second), '{}'::jsonb)
    INTO v_ends
    FROM public.match_live_events x
   WHERE x.match_id = p_match AND x.type = 'period_end' AND x.voided_at IS NULL;

  IF p_persist THEN
    DELETE FROM public.match_player_stints WHERE match_id = p_match;
    UPDATE public.match_live_periods
       SET started_at = NULL, ended_at = NULL, actual_seconds = NULL
     WHERE match_id = p_match;
  END IF;

  FOR e IN
    SELECT * FROM public.match_live_events ev
     WHERE ev.match_id = p_match AND ev.voided_at IS NULL
     ORDER BY ev.period_no,
              CASE WHEN ev.type = 'period_start' THEN 1
                   WHEN ev.type = 'period_end' THEN 3
                   WHEN ev.type IN ('match_end', 'match_reopen') THEN 4
                   WHEN ev.in_break THEN 0
                   ELSE 2 END,
              CASE WHEN ev.type IN ('match_end', 'match_reopen') THEN 0 ELSE ev.period_second END,
              ev.seq
  LOOP
    ks := e.subject_type || ':' || e.subject_id;
    kr := e.related_type || ':' || e.related_id;

    IF e.type = 'period_start' THEN
      IF e.period_no <> v_cur + 1 OR v_status NOT IN ('not_started', 'on_break')
         OR e.period_no > l.periods_planned THEN
        PERFORM public._live_raise('PERIOD_ORDER', e.client_event_id, e.id, e.type);
      END IF;
      IF e.period_no = 1 THEN
        v_f := v_starters;
        IF cardinality(v_f) = 0 THEN
          PERFORM public._live_raise('NO_STARTERS', e.client_event_id, e.id, e.type);
        END IF;
      END IF;
      IF (e.payload->>'cap') ~ '^[0-9]{1,2}$' THEN
        v_cap := (e.payload->>'cap')::int;
      END IF;
      v_status := 'in_period';
      v_cur := e.period_no;
      IF p_persist THEN
        v_anchor := LEAST(GREATEST(COALESCE(e.client_at, e.created_at), e.created_at - interval '12 hours'), e.created_at);
        UPDATE public.match_live_periods SET started_at = v_anchor
         WHERE match_id = p_match AND period_no = e.period_no;
        INSERT INTO public.match_player_stints
               (match_id, school_id, subject_type, subject_id, period_no, in_second, in_event_id)
        SELECT p_match, l.school_id, split_part(k, ':', 1), split_part(k, ':', 2)::uuid, v_cur, 0, e.id
          FROM unnest(v_f) k
        ON CONFLICT (match_id, subject_type, subject_id, period_no, in_second) DO NOTHING;
      END IF;

    ELSIF e.type = 'sub' THEN
      v_ok := (NOT e.in_break AND v_status = 'in_period' AND e.period_no = v_cur)
           OR (e.in_break AND v_status = 'on_break' AND e.period_no = v_cur + 1);
      IF NOT v_ok THEN
        PERFORM public._live_raise(CASE WHEN v_status = 'not_started' THEN 'SUB_NEEDS_PERIOD_START' ELSE 'PERIOD_NOT_OPEN' END,
                                   e.client_event_id, e.id, e.type);
      END IF;
      IF NOT e.in_break AND v_ends ? e.period_no::text
         AND e.period_second > (v_ends->>e.period_no::text)::int THEN
        PERFORM public._live_raise('EVENT_AFTER_PERIOD_END', e.client_event_id, e.id, e.type);
      END IF;
      IF NOT (kr = ANY (v_f)) THEN PERFORM public._live_raise('NOT_ON_FIELD', e.client_event_id, e.id, e.type); END IF;
      IF ks = ANY (v_f) THEN PERFORM public._live_raise('ALREADY_ON_FIELD', e.client_event_id, e.id, e.type); END IF;
      IF NOT (ks = ANY (v_all)) THEN PERFORM public._live_raise('NOT_IN_LINEUP', e.client_event_id, e.id, e.type); END IF;
      IF ks = ANY (v_r) THEN PERFORM public._live_raise('SENT_OFF', e.client_event_id, e.id, e.type); END IF;
      v_f := array_append(array_remove(v_f, kr), ks);
      IF cardinality(v_f) > v_cap THEN
        v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'OVER_FIELD_CAP', 'n', cardinality(v_f), 'event_id', e.id));
      END IF;
      IF p_persist AND NOT e.in_break THEN
        PERFORM public._live_close_stint(p_match, kr, e.period_second, 'sub', e.id);
        PERFORM public._live_open_stint(p_match, l.school_id, ks, e.period_no, e.period_second, e.id);
      END IF;

    ELSIF e.type IN ('red', 'yellow', 'goal', 'goal_against') THEN
      v_ok := (NOT e.in_break AND v_status = 'in_period' AND e.period_no = v_cur)
           OR (e.in_break AND v_status = 'on_break' AND e.period_no = v_cur + 1);
      IF NOT v_ok THEN
        PERFORM public._live_raise(CASE WHEN v_status = 'not_started' THEN 'SUB_NEEDS_PERIOD_START' ELSE 'PERIOD_NOT_OPEN' END,
                                   e.client_event_id, e.id, e.type);
      END IF;
      IF NOT e.in_break AND v_ends ? e.period_no::text
         AND e.period_second > (v_ends->>e.period_no::text)::int THEN
        PERFORM public._live_raise('EVENT_AFTER_PERIOD_END', e.client_event_id, e.id, e.type);
      END IF;
      IF e.type IN ('red', 'yellow') THEN
        IF NOT (ks = ANY (v_all)) THEN PERFORM public._live_raise('NOT_IN_LINEUP', e.client_event_id, e.id, e.type); END IF;
        IF e.type = 'red' THEN
          v_r := array_append(v_r, ks);
          IF ks = ANY (v_f) THEN
            v_f := array_remove(v_f, ks);
            IF p_persist AND NOT e.in_break THEN
              PERFORM public._live_close_stint(p_match, ks, e.period_second, 'red', e.id);
            END IF;
          END IF;
        END IF;
      ELSIF e.type = 'goal' THEN
        IF NOT (ks = ANY (v_f)) THEN PERFORM public._live_raise('NOT_ON_FIELD', e.client_event_id, e.id, e.type); END IF;
        IF e.related_id IS NOT NULL AND NOT (kr = ANY (v_all)) THEN
          PERFORM public._live_raise('NOT_IN_LINEUP', e.client_event_id, e.id, e.type);
        END IF;
      END IF;

    ELSIF e.type = 'period_end' THEN
      IF v_status <> 'in_period' OR e.period_no <> v_cur THEN
        PERFORM public._live_raise('PERIOD_NOT_OPEN', e.client_event_id, e.id, e.type);
      END IF;
      IF p_persist THEN
        UPDATE public.match_live_periods
           SET actual_seconds = e.period_second,
               ended_at = started_at + make_interval(secs => e.period_second)
         WHERE match_id = p_match AND period_no = e.period_no AND started_at IS NOT NULL;
        DELETE FROM public.match_player_stints s
         WHERE s.match_id = p_match AND s.out_second IS NULL AND s.in_second >= e.period_second;
        UPDATE public.match_player_stints s
           SET out_second = e.period_second, ended_by = 'period_end', out_event_id = e.id
         WHERE s.match_id = p_match AND s.out_second IS NULL;
      END IF;
      v_status := 'on_break';

    ELSIF e.type = 'clock_adjust' THEN
      IF NOT COALESCE((e.payload->>'planned_seconds') ~ '^[0-9]{3,4}$', false) THEN
        PERFORM public._live_raise('PAYLOAD_INVALID', e.client_event_id, e.id, e.type);
      END IF;
      v_ps := (e.payload->>'planned_seconds')::int;
      IF v_ps NOT BETWEEN 300 AND 3600 THEN
        PERFORM public._live_raise('PAYLOAD_INVALID', e.client_event_id, e.id, e.type);
      END IF;
      IF e.period_no < v_cur OR (e.period_no = v_cur AND v_status = 'on_break') THEN
        PERFORM public._live_raise('CLOCK_ADJUST_CLOSED', e.client_event_id, e.id, e.type);
      END IF;
      IF p_persist THEN
        UPDATE public.match_live_periods SET planned_seconds = v_ps
         WHERE match_id = p_match AND period_no = e.period_no;
      END IF;
    END IF;
    -- callup / match_end / match_reopen: auditoría, sin efecto sobre la cancha
  END LOOP;

  IF p_persist THEN
    UPDATE public.match_live
       SET status = CASE WHEN status = 'finished' THEN 'finished' ELSE v_status END,
           current_period = v_cur,
           updated_at = now()
     WHERE match_id = p_match;
  END IF;

  RETURN jsonb_build_object(
    'on_field', public._live_keys_to_json(v_f),
    'sent_off', public._live_keys_to_json(v_r),
    'status', v_status,
    'current_period', v_cur,
    'warnings', v_warn);
END $$;

-- ===========================================================================
-- E. Lectura: estado, datos del informe, borrador por plantilla
-- ===========================================================================
CREATE OR REPLACE FUNCTION public._live_state_json(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  l       public.match_live;
  v_res   jsonb;
  v_warn  jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match;
  IF NOT FOUND THEN
    PERFORM public._live_raise('LIVE_NOT_STARTED');
  END IF;
  BEGIN
    v_res := public._live_rebuild_stints(p_match, false);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_res := jsonb_build_object('on_field', '[]'::jsonb, 'sent_off', '[]'::jsonb, 'warnings', '[]'::jsonb);
    v_warn := jsonb_build_array(jsonb_build_object('code', 'REPLAY_ERROR'));
  END;
  RETURN jsonb_build_object(
    'match_id', l.match_id,
    'status', l.status,
    'current_period', l.current_period,
    'periods_planned', l.periods_planned,
    'director_id', l.director_id,
    'started_at', l.started_at,
    'finished_at', l.finished_at,
    'reopen_count', l.reopen_count,
    'periods', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'period_no', p.period_no, 'planned_seconds', p.planned_seconds,
                  'actual_seconds', p.actual_seconds, 'stoppage_seconds', p.stoppage_seconds,
                  'started_at', p.started_at, 'ended_at', p.ended_at) ORDER BY p.period_no), '[]'::jsonb)
                  FROM public.match_live_periods p WHERE p.match_id = p_match),
    'lineup', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'subject_type', r.subject_type, 'subject_id', r.subject_id, 'name', r.name,
                  'jersey_number', r.jersey_number, 'role', r.role)
                  ORDER BY (r.role = 'starter') DESC, r.jersey_number NULLS LAST, r.name), '[]'::jsonb)
                  FROM public._live_lineup_rows(p_match) r),
    'on_field', v_res->'on_field',
    'sent_off', v_res->'sent_off',
    'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'id', e.id, 'client_event_id', e.client_event_id, 'type', e.type,
                  'period_no', e.period_no, 'period_second', e.period_second, 'in_break', e.in_break,
                  'subject_type', e.subject_type, 'subject_id', e.subject_id,
                  'related_type', e.related_type, 'related_id', e.related_id,
                  'reason', e.reason, 'voided', (e.voided_at IS NOT NULL)) ORDER BY e.seq), '[]'::jsonb)
                  FROM public.match_live_events e WHERE e.match_id = p_match),
    'warnings', COALESCE(v_res->'warnings', '[]'::jsonb) || v_warn);
END $$;

CREATE OR REPLACE FUNCTION public._live_report_data(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m          public.match_results;
  l          public.match_live;
  v_school   text;
  v_total    integer;
  v_periods  jsonb;
  v_lineup   jsonb;
  v_subs     jsonb;
  v_gf       jsonb;
  v_ga       jsonb;
  v_cards    jsonb;
  v_for      integer;
  v_against  integer;
BEGIN
  SELECT * INTO m FROM public.match_results WHERE id = p_match;
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match;
  IF NOT FOUND THEN
    PERFORM public._live_raise('LIVE_NOT_STARTED');
  END IF;
  SELECT s.name INTO v_school FROM public.schools s WHERE s.id = m.school_id;

  -- tiempos y duración total jugada (tiempo abierto: hasta ahora)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period_no', p.period_no, 'planned_seconds', p.planned_seconds,
           'actual_seconds', p.actual_seconds, 'stoppage_seconds', p.stoppage_seconds,
           'started_at', p.started_at, 'ended_at', p.ended_at,
           'running', (p.started_at IS NOT NULL AND p.ended_at IS NULL)) ORDER BY p.period_no), '[]'::jsonb),
         COALESCE(SUM(CASE WHEN p.actual_seconds IS NOT NULL THEN p.actual_seconds
                           WHEN p.started_at IS NOT NULL THEN LEAST(10800, GREATEST(0, extract(epoch FROM now() - p.started_at)::int))
                           ELSE 0 END), 0)::int
    INTO v_periods, v_total
    FROM public.match_live_periods p WHERE p.match_id = p_match;

  -- minutos y % por jugador (en vivo y al terminar), desde los tramos
  WITH lp AS (SELECT * FROM public._live_lineup_rows(p_match)),
  st AS (
    SELECT s.subject_type, s.subject_id, s.period_no, s.in_second, s.out_second, s.ended_by,
           CASE WHEN s.out_second IS NOT NULL THEN s.out_second - s.in_second
                ELSE GREATEST(0, LEAST(10800, extract(epoch FROM now() - pp.started_at)::int) - s.in_second) END AS secs
      FROM public.match_player_stints s
      JOIN public.match_live_periods pp ON pp.match_id = s.match_id AND pp.period_no = s.period_no
     WHERE s.match_id = p_match),
  agg AS (
    SELECT st.subject_type, st.subject_id, SUM(st.secs)::int AS secs,
           jsonb_agg(jsonb_build_object('period_no', st.period_no, 'in', st.in_second,
                                        'out', st.out_second, 'ended_by', st.ended_by)
                     ORDER BY st.period_no, st.in_second) AS stints
      FROM st GROUP BY st.subject_type, st.subject_id),
  rd AS (
    SELECT DISTINCT x.subject_type, x.subject_id FROM public.match_live_events x
     WHERE x.match_id = p_match AND x.type = 'red' AND x.voided_at IS NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'subject_type', lp.subject_type, 'subject_id', lp.subject_id, 'name', lp.name,
           'jersey_number', lp.jersey_number, 'role', lp.role,
           'seconds', COALESCE(a.secs, 0),
           'minutes', CASE WHEN COALESCE(a.secs, 0) = 0 THEN 0 ELSE GREATEST(1, round(a.secs / 60.0)::int) END,
           'pct', CASE WHEN v_total > 0 THEN round(100.0 * COALESCE(a.secs, 0) / v_total, 1) ELSE 0 END,
           'stints', COALESCE(a.stints, '[]'::jsonb),
           'sent_off', (rd.subject_id IS NOT NULL))
           ORDER BY (lp.role = 'starter') DESC, lp.jersey_number NULLS LAST, lp.name), '[]'::jsonb)
    INTO v_lineup
    FROM lp
    LEFT JOIN agg a ON a.subject_type = lp.subject_type AND a.subject_id = lp.subject_id
    LEFT JOIN rd  ON rd.subject_type = lp.subject_type AND rd.subject_id = lp.subject_id;

  -- cambios por tiempo (los del descanso cuelgan del tiempo siguiente)
  SELECT COALESCE(jsonb_agg(g.item ORDER BY g.period_no), '[]'::jsonb)
    INTO v_subs
    FROM (
      SELECT e.period_no,
             jsonb_build_object('period_no', e.period_no, 'items', jsonb_agg(jsonb_build_object(
               'event_id', e.id, 'second', e.period_second, 'in_break', e.in_break, 'reason', e.reason,
               'in',  jsonb_build_object('subject_type', e.subject_type, 'subject_id', e.subject_id,
                                         'name', COALESCE(li.name, 'Sin nombre'), 'jersey_number', li.jersey_number),
               'out', jsonb_build_object('subject_type', e.related_type, 'subject_id', e.related_id,
                                         'name', COALESCE(lo.name, 'Sin nombre'), 'jersey_number', lo.jersey_number))
               ORDER BY e.in_break DESC, e.period_second, e.seq)) AS item
        FROM public.match_live_events e
        LEFT JOIN public._live_lineup_rows(p_match) li ON li.subject_type = e.subject_type AND li.subject_id = e.subject_id
        LEFT JOIN public._live_lineup_rows(p_match) lo ON lo.subject_type = e.related_type AND lo.subject_id = e.related_id
       WHERE e.match_id = p_match AND e.type = 'sub' AND e.voided_at IS NULL
       GROUP BY e.period_no) g;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'event_id', e.id, 'period_no', e.period_no, 'second', e.period_second,
           'scorer', jsonb_build_object('subject_type', e.subject_type, 'subject_id', e.subject_id,
                                        'name', COALESCE(li.name, 'Sin nombre'), 'jersey_number', li.jersey_number),
           'assist', CASE WHEN e.related_id IS NULL THEN NULL
                          ELSE jsonb_build_object('subject_type', e.related_type, 'subject_id', e.related_id,
                                                  'name', COALESCE(lo.name, 'Sin nombre'), 'jersey_number', lo.jersey_number) END)
           ORDER BY e.period_no, e.period_second, e.seq), '[]'::jsonb)
    INTO v_gf
    FROM public.match_live_events e
    LEFT JOIN public._live_lineup_rows(p_match) li ON li.subject_type = e.subject_type AND li.subject_id = e.subject_id
    LEFT JOIN public._live_lineup_rows(p_match) lo ON lo.subject_type = e.related_type AND lo.subject_id = e.related_id
   WHERE e.match_id = p_match AND e.type = 'goal' AND e.voided_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'event_id', e.id, 'period_no', e.period_no, 'second', e.period_second)
           ORDER BY e.period_no, e.period_second, e.seq), '[]'::jsonb)
    INTO v_ga
    FROM public.match_live_events e
   WHERE e.match_id = p_match AND e.type = 'goal_against' AND e.voided_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'event_id', e.id, 'type', e.type, 'period_no', e.period_no, 'second', e.period_second,
           'in_break', e.in_break,
           'subject', jsonb_build_object('subject_type', e.subject_type, 'subject_id', e.subject_id,
                                         'name', COALESCE(li.name, 'Sin nombre'), 'jersey_number', li.jersey_number))
           ORDER BY e.period_no, e.period_second, e.seq), '[]'::jsonb)
    INTO v_cards
    FROM public.match_live_events e
    LEFT JOIN public._live_lineup_rows(p_match) li ON li.subject_type = e.subject_type AND li.subject_id = e.subject_id
   WHERE e.match_id = p_match AND e.type IN ('yellow', 'red') AND e.voided_at IS NULL;

  IF l.status = 'finished' THEN
    v_for := CASE WHEN COALESCE(m.is_home, true) THEN m.home_score ELSE m.away_score END;
    v_against := CASE WHEN COALESCE(m.is_home, true) THEN m.away_score ELSE m.home_score END;
  ELSE
    v_for := jsonb_array_length(v_gf);
    v_against := jsonb_array_length(v_ga);
  END IF;

  RETURN jsonb_build_object(
    'match', jsonb_build_object('id', m.id, 'date', m.match_date, 'kickoff_at', m.kickoff_at,
               'opponent', m.opponent, 'location', m.location, 'is_home', m.is_home,
               'match_kind', m.match_kind, 'referee_name', m.referee_name,
               'match_type', m.match_type, 'school_name', v_school),
    'status', l.status,
    'current_period', l.current_period,
    'periods', v_periods,
    'lineup', v_lineup,
    'starters', COALESCE(jsonb_path_query_array(v_lineup, '$[*] ? (@.role == "starter")'), '[]'::jsonb),
    'bench', COALESCE(jsonb_path_query_array(v_lineup, '$[*] ? (@.role == "bench")'), '[]'::jsonb),
    'subs_by_period', v_subs,
    'goals_for', v_gf,
    'goals_against', v_ga,
    'cards', v_cards,
    'total_played_seconds', v_total,
    'duration_label', CASE WHEN v_total > 0 THEN 'casi ' || round(v_total / 60.0)::int || ' minutos' ELSE NULL END,
    'score', jsonb_build_object('for', v_for, 'against', v_against,
                                'source', CASE WHEN l.status = 'finished' THEN 'result' ELSE 'events' END));
END $$;

-- Borrador por plantilla (spec §9.3.1): summary = encabezado; development = secciones fijas.
CREATE OR REPLACE FUNCTION public._live_draft_report(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d        jsonb := public._live_report_data(p_match);
  m        public.match_results;
  v_school text;
  s        text;
  dev      text;
  v_part   text;
BEGIN
  SELECT * INTO m FROM public.match_results WHERE id = p_match;
  v_school := d->'match'->>'school_name';

  s := 'Informe del partido'
    || E'\nFecha: ' || to_char(m.match_date, 'DD/MM/YYYY')
    || COALESCE(E'\nHora: ' || to_char(m.kickoff_at AT TIME ZONE 'America/Bogota', 'HH24:MI'), '')
    || E'\nPartido: ' || CASE WHEN COALESCE(m.is_home, true) THEN COALESCE(v_school, 'Local') || ' vs ' || m.opponent
                             ELSE m.opponent || ' vs ' || COALESCE(v_school, 'Visitante') END
    || COALESCE(E'\nLugar: ' || NULLIF(btrim(m.location), ''), '')
    || E'\nResultado: ' || COALESCE(m.home_score, 0) || '-' || COALESCE(m.away_score, 0)
    || E'\nTipo: ' || CASE WHEN m.match_kind = 'practice' THEN 'Práctica' ELSE 'Oficial' END
                    || COALESCE(' (' || NULLIF(btrim(m.match_type), '') || ')', '')
    || E'\nÁrbitro: ' || COALESCE(NULLIF(btrim(m.referee_name), ''), 'Sin dato')
    || COALESCE(E'\nDuración: ' || (d->>'duration_label'), '');

  dev := E'Alineación:\n';
  SELECT string_agg(t.name || COALESCE(' ' || t.jersey_number, ''), E'\n' ORDER BY t.jersey_number NULLS LAST, t.name)
    INTO v_part
    FROM jsonb_to_recordset(d->'lineup') AS t(name text, jersey_number int, role text)
   WHERE t.role = 'starter';
  dev := dev || COALESCE(v_part, 'Sin titulares');

  dev := dev || E'\n\nSustituciones (banca):\n';
  SELECT string_agg(t.name || COALESCE(' ' || t.jersey_number, ''), E'\n' ORDER BY t.jersey_number NULLS LAST, t.name)
    INTO v_part
    FROM jsonb_to_recordset(d->'lineup') AS t(name text, jersey_number int, role text)
   WHERE t.role = 'bench';
  dev := dev || COALESCE(v_part, 'Ninguno');

  dev := dev || E'\n\nCambios realizados:\n';
  SELECT string_agg(public._live_period_label(g.period_no) || E':\n' || g.lines, E'\n' ORDER BY g.period_no)
    INTO v_part
    FROM (
      SELECT sp.period_no,
             string_agg('- ' || (i."in"->>'name') || ' ingresa '
                        || CASE WHEN i.in_break THEN 'en el descanso' ELSE 'al ' || public._live_fmt_clock(i.second) END
                        || ' (sale ' || (i."out"->>'name') || ')',
                        E'\n' ORDER BY i.in_break DESC, i.second) AS lines
        FROM jsonb_to_recordset(d->'subs_by_period') AS sp(period_no int, items jsonb)
        CROSS JOIN LATERAL jsonb_to_recordset(sp.items) AS i(second int, in_break boolean, "in" jsonb, "out" jsonb)
       GROUP BY sp.period_no) g;
  dev := dev || COALESCE(v_part, 'Ninguno');

  dev := dev || E'\n\nAnotaciones:\n';
  SELECT string_agg('- ' || (g.scorer->>'name') || ' ' || public._live_fmt_clock(g.second)
                    || CASE WHEN jsonb_typeof(g.assist) = 'object' THEN ' (asist. ' || (g.assist->>'name') || ')' ELSE '' END
                    || ' - ' || public._live_period_label(g.period_no),
                    E'\n' ORDER BY g.period_no, g.second)
    INTO v_part
    FROM jsonb_to_recordset(d->'goals_for') AS g(period_no int, second int, scorer jsonb, assist jsonb);
  dev := dev || COALESCE(v_part, 'Ninguna');

  dev := dev || E'\n\nGoles en contra:\n';
  SELECT string_agg('- ' || public._live_fmt_clock(g.second) || ' ' || public._live_period_label(g.period_no),
                    E'\n' ORDER BY g.period_no, g.second)
    INTO v_part
    FROM jsonb_to_recordset(d->'goals_against') AS g(period_no int, second int);
  dev := dev || COALESCE(v_part, 'Ninguno');

  dev := dev || E'\n\nAmonestaciones:\n';
  SELECT string_agg('- ' || CASE c."type" WHEN 'red' THEN 'Roja' ELSE 'Amarilla' END || ': '
                    || (c.subject->>'name') || COALESCE(' ' || (c.subject->>'jersey_number'), '')
                    || ' ' || public._live_fmt_clock(c.second) || ' - ' || public._live_period_label(c.period_no),
                    E'\n' ORDER BY c.period_no, c.second)
    INTO v_part
    FROM jsonb_to_recordset(d->'cards') AS c("type" text, period_no int, "second" int, subject jsonb);
  dev := dev || COALESCE(v_part, 'Ninguna');

  RETURN jsonb_build_object('summary', left(s, 4000), 'development', left(dev, 4000));
END $$;

-- Copia los minutos de los tramos a match_lineup_players.minutes_played.
-- SOLO se llama al PUBLICAR el informe (D-P1=A): esa columna es la que leen las
-- pantallas del acudiente. p_publish=false (despublicar) la deja en NULL.
CREATE OR REPLACE FUNCTION public._live_write_minutes(p_match uuid, p_publish boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.match_live l WHERE l.match_id = p_match FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF p_publish THEN
    UPDATE public.match_lineup_players mlp
       SET minutes_played = x.mins
      FROM (
        SELECT mp.id,
               CASE WHEN COALESCE(a.secs, 0) = 0 THEN 0
                    ELSE GREATEST(1, round(a.secs / 60.0)::int) END AS mins
          FROM public.match_lineups ml
          JOIN public.match_lineup_players mp ON mp.lineup_id = ml.id
          LEFT JOIN (
            SELECT s.subject_type, s.subject_id, SUM(s.out_second - s.in_second)::int AS secs
              FROM public.match_player_stints s
             WHERE s.match_id = p_match AND s.out_second IS NOT NULL
             GROUP BY s.subject_type, s.subject_id
          ) a ON a.subject_type = mp.subject_type AND a.subject_id = mp.subject_id
         WHERE ml.source_type = 'team_match' AND ml.source_id = p_match
      ) x
     WHERE mlp.id = x.id;
  ELSE
    UPDATE public.match_lineup_players mlp
       SET minutes_played = NULL
      FROM public.match_lineups ml
     WHERE mlp.lineup_id = ml.id AND ml.source_type = 'team_match' AND ml.source_id = p_match;
  END IF;
END $$;

-- ===========================================================================
-- F. RPCs públicas
-- ===========================================================================

-- F1. start_live_match -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_live_match(p_match uuid, p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  m         public.match_results;
  l         public.match_live;
  v_exists  boolean;
  v_opts    jsonb := COALESCE(p_options, '{}'::jsonb);
  v_mins    integer[];
  v_n       integer;
  v_def     integer;
  v_lineup  uuid;
  v_missing text;
  v_dups    text;
  v_warn    jsonb := '[]'::jsonb;
BEGIN
  m := public._live_auth(p_match, 'staff');
  IF jsonb_typeof(v_opts) <> 'object' THEN
    RAISE EXCEPTION 'p_options debe ser un objeto' USING ERRCODE = '22023';
  END IF;
  IF m.team_id IS NULL THEN PERFORM public._live_raise('MATCH_NO_TEAM'); END IF;
  IF m.status = 'cancelled' THEN PERFORM public._live_raise('MATCH_CANCELLED'); END IF;

  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  v_exists := FOUND;
  IF NOT v_exists AND m.status = 'played' THEN PERFORM public._live_raise('MATCH_ALREADY_PLAYED'); END IF;

  -- ya iniciado, o lo inició otro: idempotente, devuelve el estado sin cambios
  IF v_exists AND (l.status <> 'not_started'
                   OR NOT (l.director_id IS NOT DISTINCT FROM v_uid
                           OR m.school_id = ANY (public.user_admin_school_ids())
                           OR public.is_platform_admin())) THEN
    RETURN public._live_state_json(p_match);
  END IF;

  -- formato: p_options > agenda del partido > default (2 x 45)
  BEGIN
    IF jsonb_typeof(v_opts->'periods') = 'array' THEN
      SELECT array_agg(t.x::int ORDER BY t.ord) INTO v_mins
        FROM jsonb_array_elements_text(v_opts->'periods') WITH ORDINALITY t(x, ord);
      v_n := COALESCE(cardinality(v_mins), 0);
    ELSE
      v_n := COALESCE(NULLIF(v_opts->>'periods_count', '')::int, m.live_periods_count, 2);
      v_def := COALESCE(NULLIF(v_opts->>'period_minutes', '')::int, m.live_period_minutes, 45);
      IF v_n BETWEEN 1 AND 4 THEN
        v_mins := array_fill(v_def, ARRAY[v_n]);
      END IF;
    END IF;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Formato de tiempos inválido' USING ERRCODE = '22023';
  END;
  IF v_n NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'Los tiempos deben ser entre 1 y 4' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_mins) x WHERE x NOT BETWEEN 5 AND 60) THEN
    RAISE EXCEPTION 'Cada tiempo debe durar entre 5 y 60 minutos' USING ERRCODE = '22023';
  END IF;

  -- convocatoria y dorsal obligatorio (solo para el en vivo)
  SELECT ml.id INTO v_lineup FROM public.match_lineups ml
   WHERE ml.source_type = 'team_match' AND ml.source_id = p_match;
  IF v_lineup IS NULL OR NOT EXISTS (SELECT 1 FROM public._live_lineup_rows(p_match) r WHERE r.role = 'starter') THEN
    PERFORM public._live_raise('NO_STARTERS');
  END IF;
  SELECT string_agg(r.name, ', ' ORDER BY r.name) INTO v_missing
    FROM public._live_lineup_rows(p_match) r WHERE r.jersey_number IS NULL;
  IF v_missing IS NOT NULL THEN PERFORM public._live_raise('JERSEY_REQUIRED', p_extra => v_missing); END IF;
  SELECT string_agg(q.jn::text, ', ' ORDER BY q.jn) INTO v_dups
    FROM (SELECT r.jersey_number AS jn FROM public._live_lineup_rows(p_match) r
           GROUP BY r.jersey_number HAVING count(*) > 1) q;
  IF v_dups IS NOT NULL THEN PERFORM public._live_raise('JERSEY_DUPLICATE', p_extra => v_dups); END IF;

  IF NOT v_exists THEN
    INSERT INTO public.match_live (match_id, school_id, periods_planned, director_id, started_at)
    VALUES (p_match, m.school_id, v_n, v_uid, now());
  ELSE
    UPDATE public.match_live SET periods_planned = v_n, updated_at = now() WHERE match_id = p_match;
    DELETE FROM public.match_live_periods WHERE match_id = p_match AND period_no > v_n;
  END IF;
  INSERT INTO public.match_live_periods (match_id, school_id, period_no, planned_seconds)
  SELECT p_match, m.school_id, i, v_mins[i] * 60 FROM generate_series(1, v_n) i
  ON CONFLICT (match_id, period_no) DO UPDATE SET planned_seconds = EXCLUDED.planned_seconds;

  IF EXISTS (SELECT 1 FROM public.football_match_events f
              WHERE f.source_type = 'team_match' AND f.source_id = p_match AND f.live_event_id IS NULL) THEN
    v_warn := jsonb_build_array(jsonb_build_object('code', 'MANUAL_EVENTS_EXIST'));
  END IF;

  RETURN public._live_state_json(p_match) || jsonb_build_object('warnings', v_warn);
END $$;

-- F2. apply_live_events --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_live_events(p_match uuid, p_events jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  m         public.match_results;
  l         public.match_live;
  e         jsonb;
  v_idx     integer := 0;
  v_cid     uuid;
  v_type    text;
  v_pno     integer;
  v_sec     integer;
  v_brk     boolean;
  v_st      text;
  v_sid     uuid;
  v_rt      text;
  v_rid     uuid;
  v_reason  text;
  v_payload jsonb;
  v_client  timestamptz;
  v_new     uuid;
  v_old     public.match_live_events;
  v_applied uuid[] := '{}';
  v_dups    uuid[] := '{}';
  v_res     jsonb;
  v_bad     record;
BEGIN
  m := public._live_auth(p_match, 'director');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.director_id IS DISTINCT FROM v_uid
     AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    PERFORM public._live_raise('NOT_DIRECTOR');
  END IF;
  IF l.status = 'finished' THEN PERFORM public._live_raise('LIVE_FINISHED'); END IF;
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_events debe ser un arreglo' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_events) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'p_events debe traer de 1 a 200 eventos' USING ERRCODE = '22023';
  END IF;

  FOR e IN SELECT x FROM jsonb_array_elements(p_events) x LOOP
    v_idx := v_idx + 1;
    BEGIN
      IF jsonb_typeof(e) <> 'object' THEN
        RAISE EXCEPTION 'evento % no es un objeto', v_idx USING ERRCODE = '22023';
      END IF;
      v_cid  := (e->>'client_event_id')::uuid;
      v_type := e->>'type';
      v_pno  := (e->>'period_no')::int;
      v_sec  := (e->>'period_second')::int;
      v_brk  := COALESCE((e->>'in_break')::boolean, false);
      v_st   := e->'subject'->>'type';
      v_sid  := NULLIF(e->'subject'->>'id', '')::uuid;
      v_rt   := e->'related'->>'type';
      v_rid  := NULLIF(e->'related'->>'id', '')::uuid;
      v_reason := NULLIF(e->>'reason', '');
      v_payload := COALESCE(e->'payload', '{}'::jsonb);
      v_client := NULLIF(e->>'client_at', '')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format
              OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Evento % con campos inválidos', v_idx USING ERRCODE = '22023';
    END;
    IF v_cid IS NULL OR v_type IS NULL OR v_pno IS NULL OR v_sec IS NULL THEN
      RAISE EXCEPTION 'Evento %: faltan client_event_id, type, period_no o period_second', v_idx USING ERRCODE = '22023';
    END IF;
    IF v_type NOT IN ('period_start','period_end','sub','goal','goal_against','yellow','red','clock_adjust') THEN
      RAISE EXCEPTION 'Evento %: tipo % no permitido por esta vía', v_idx, v_type USING ERRCODE = '22023';
    END IF;
    IF v_pno NOT BETWEEN 1 AND l.periods_planned OR v_sec NOT BETWEEN 0 AND 10800 THEN
      RAISE EXCEPTION 'Evento %: period_no o period_second fuera de rango', v_idx USING ERRCODE = '22023';
    END IF;
    IF v_brk AND v_type NOT IN ('sub', 'yellow', 'red') THEN
      RAISE EXCEPTION 'Evento %: in_break solo aplica a cambios y tarjetas', v_idx USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_payload) <> 'object' THEN
      RAISE EXCEPTION 'Evento %: payload debe ser un objeto', v_idx USING ERRCODE = '22023';
    END IF;

    v_new := NULL;
    BEGIN
      INSERT INTO public.match_live_events
             (match_id, school_id, client_event_id, type, period_no, in_break, period_second,
              subject_type, subject_id, related_type, related_id, reason, payload, client_at, created_by)
      VALUES (p_match, m.school_id, v_cid, v_type, v_pno, v_brk, v_sec,
              v_st, v_sid, v_rt, v_rid, v_reason, v_payload, v_client, v_uid)
      ON CONFLICT (match_id, client_event_id) DO NOTHING
      RETURNING id INTO v_new;
    EXCEPTION
      WHEN check_violation THEN
        PERFORM public._live_raise('EVENT_SHAPE_INVALID', v_cid, NULL, v_type);
      WHEN unique_violation THEN
        PERFORM public._live_raise('PERIOD_ORDER', v_cid, NULL, v_type);
    END;

    IF v_new IS NULL THEN
      -- duplicado: doble toque o cola reenviada
      SELECT * INTO v_old FROM public.match_live_events x
       WHERE x.match_id = p_match AND x.client_event_id = v_cid;
      IF v_old.type IS DISTINCT FROM v_type THEN
        PERFORM public._live_raise('CLIENT_EVENT_ID_REUSED', v_cid, v_old.id, v_type);
      END IF;
      v_dups := array_append(v_dups, v_cid);
    ELSE
      v_applied := array_append(v_applied, v_new);
    END IF;
  END LOOP;

  -- una sola repetición para todo el lote; si algún evento es inválido, TODO el lote se revierte
  v_res := public._live_rebuild_stints(p_match, true);

  -- cinturón anti-futuro (tolerante a propósito: cola offline), solo tiempo abierto
  SELECT ev.id, ev.client_event_id, ev.type INTO v_bad
    FROM public.match_live_events ev
    JOIN public.match_live_periods p ON p.match_id = ev.match_id AND p.period_no = ev.period_no
   WHERE ev.id = ANY (v_applied)
     AND ev.type NOT IN ('period_start', 'period_end', 'clock_adjust')
     AND NOT ev.in_break
     AND p.started_at IS NOT NULL AND p.ended_at IS NULL
     AND ev.period_second > extract(epoch FROM (now() - p.started_at)) + 120
   LIMIT 1;
  IF FOUND THEN
    PERFORM public._live_raise('FUTURE_EVENT', v_bad.client_event_id, v_bad.id, v_bad.type);
  END IF;

  RETURN jsonb_build_object(
    'applied', to_jsonb(v_applied),
    'duplicates', to_jsonb(v_dups),
    'warnings', COALESCE(v_res->'warnings', '[]'::jsonb),
    'state', public._live_state_json(p_match));
END $$;

-- F3. match_live_report (lectura, staff): minutos y % por jugador en vivo y al terminar
CREATE OR REPLACE FUNCTION public.match_live_report(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public._live_auth(p_match, 'staff');
  RETURN public._live_report_data(p_match);
END $$;

-- F4. finish_live_match -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finish_live_match(p_match uuid, p_score_for integer, p_score_against integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  m         public.match_results;
  l         public.match_live;
  p         public.match_live_periods;
  v_sec     integer;
  v_last    integer;
  v_draft   jsonb;
BEGIN
  m := public._live_auth(p_match, 'director');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.director_id IS DISTINCT FROM v_uid
     AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    PERFORM public._live_raise('NOT_DIRECTOR');
  END IF;
  IF l.status = 'finished' THEN
    RETURN public._live_report_data(p_match);          -- doble llamada: nada se duplica
  END IF;
  IF l.status = 'not_started' THEN PERFORM public._live_raise('NOTHING_PLAYED'); END IF;
  IF p_score_for IS NULL OR p_score_against IS NULL OR p_score_for < 0 OR p_score_against < 0 THEN
    RAISE EXCEPTION 'El marcador debe ser un número mayor o igual a 0' USING ERRCODE = '22023';
  END IF;

  -- suspendido a mitad de tiempo: cerrar el tiempo al momento
  IF l.status = 'in_period' THEN
    SELECT * INTO p FROM public.match_live_periods WHERE match_id = p_match AND period_no = l.current_period;
    SELECT COALESCE(max(ev.period_second), 0) INTO v_last
      FROM public.match_live_events ev
     WHERE ev.match_id = p_match AND ev.period_no = l.current_period AND ev.voided_at IS NULL
       AND NOT ev.in_break AND ev.type NOT IN ('callup', 'match_end', 'match_reopen', 'period_end');
    v_sec := GREATEST(v_last,
                      LEAST(p.planned_seconds * 3,
                            COALESCE(round(extract(epoch FROM now() - p.started_at))::int, 0)),
                      0);
    v_sec := LEAST(v_sec, 10800);
    INSERT INTO public.match_live_events (match_id, school_id, client_event_id, type, period_no, period_second, created_by)
    VALUES (p_match, m.school_id, gen_random_uuid(), 'period_end', l.current_period, v_sec, v_uid);
  END IF;

  -- el replay cierra los tramos abiertos: los minutos quedan consultables por staff (match_live_report)
  PERFORM public._live_rebuild_stints(p_match, true);
  -- pitazo final del partido (auditoría; periodo y segundo = los del último tiempo)
  SELECT COALESCE(pp.actual_seconds, 0) INTO v_sec
    FROM public.match_live_periods pp WHERE pp.match_id = p_match AND pp.period_no = GREATEST(l.current_period, 1);
  INSERT INTO public.match_live_events (match_id, school_id, client_event_id, type, period_no, period_second, created_by)
  VALUES (p_match, m.school_id, gen_random_uuid(), 'match_end', GREATEST(l.current_period, 1),
          LEAST(COALESCE(v_sec, 0), 10800), v_uid);

  -- marcador y estado (p_score_for / p_score_against se mapean con is_home)
  UPDATE public.match_results
     SET home_score = CASE WHEN COALESCE(is_home, true) THEN p_score_for ELSE p_score_against END,
         away_score = CASE WHEN COALESCE(is_home, true) THEN p_score_against ELSE p_score_for END,
         status = 'played', updated_by = v_uid, updated_at = now()
   WHERE id = p_match;

  -- espejo a la estadística existente (idempotente: borra y reinserta SOLO lo propio)
  DELETE FROM public.football_match_events f
   WHERE f.source_type = 'team_match' AND f.source_id = p_match AND f.live_event_id IS NOT NULL;
  INSERT INTO public.football_match_events
         (school_id, team_id, source_type, source_id, subject_type, subject_id, type, minute, created_by, live_event_id)
  SELECT m.school_id, m.team_id, 'team_match', p_match,
         CASE WHEN x.kind = 'assist' THEN x.related_type ELSE x.subject_type END,
         CASE WHEN x.kind = 'assist' THEN x.related_id ELSE x.subject_id END,
         x.kind, x.minute, v_uid, x.id
    FROM (
      SELECT e.id, e.subject_type, e.subject_id, e.related_type, e.related_id,
             e.type AS kind,
             GREATEST(1, ceil((COALESCE((SELECT SUM(pp.actual_seconds) FROM public.match_live_periods pp
                                          WHERE pp.match_id = e.match_id AND pp.period_no < e.period_no), 0)
                               + e.period_second) / 60.0)::int) AS minute
        FROM public.match_live_events e
       WHERE e.match_id = p_match AND e.voided_at IS NULL AND e.type IN ('goal', 'yellow', 'red')
      UNION ALL
      SELECT e.id, e.subject_type, e.subject_id, e.related_type, e.related_id,
             'assist',
             GREATEST(1, ceil((COALESCE((SELECT SUM(pp.actual_seconds) FROM public.match_live_periods pp
                                          WHERE pp.match_id = e.match_id AND pp.period_no < e.period_no), 0)
                               + e.period_second) / 60.0)::int)
        FROM public.match_live_events e
       WHERE e.match_id = p_match AND e.voided_at IS NULL AND e.type = 'goal' AND e.related_id IS NOT NULL
    ) x;
  -- NOTA: el assist reutiliza live_event_id del gol; el borrado de arriba los quita juntos.

  -- borrador del informe: SOLO si no hay informe o sus 3 campos están en blanco (T12)
  v_draft := public._live_draft_report(p_match);
  INSERT INTO public.match_reports AS r (match_id, school_id, summary, development, improvements, coach_id)
  VALUES (p_match, m.school_id, v_draft->>'summary', v_draft->>'development', NULL, v_uid)
  ON CONFLICT (match_id) DO UPDATE
     SET summary = EXCLUDED.summary, development = EXCLUDED.development, updated_at = now()
   WHERE btrim(COALESCE(r.summary, '')) = '' AND btrim(COALESCE(r.development, '')) = ''
     AND btrim(COALESCE(r.improvements, '')) = '';
  -- NO se publica nada: published_at queda como estaba.

  UPDATE public.match_live
     SET status = 'finished', finished_at = now(), finished_by = v_uid, updated_at = now()
   WHERE match_id = p_match;

  -- si el informe YA estaba publicado (partido reabierto y vuelto a terminar), el espejo
  -- hacia el acudiente se mantiene al día; si no, minutes_played no se toca (D-P1=A).
  IF EXISTS (SELECT 1 FROM public.match_reports r2 WHERE r2.match_id = p_match AND r2.published_at IS NOT NULL) THEN
    PERFORM public._live_write_minutes(p_match, true);
  END IF;

  RETURN public._live_report_data(p_match);
END $$;

-- F5. reopen_live_match (administración) -----------------------------------------
CREATE OR REPLACE FUNCTION public.reopen_live_match(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  m     public.match_results;
  l     public.match_live;
  v_pno integer;
  v_sec integer;
BEGIN
  m := public._live_auth(p_match, 'admin');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.status <> 'finished' THEN
    RETURN public._live_state_json(p_match);
  END IF;
  v_pno := GREATEST(l.current_period, 1);
  SELECT COALESCE(pp.actual_seconds, 0) INTO v_sec
    FROM public.match_live_periods pp WHERE pp.match_id = p_match AND pp.period_no = v_pno;
  INSERT INTO public.match_live_events (match_id, school_id, client_event_id, type, period_no, period_second, created_by)
  VALUES (p_match, m.school_id, gen_random_uuid(), 'match_reopen', v_pno, LEAST(COALESCE(v_sec, 0), 10800), v_uid);
  UPDATE public.match_live
     SET status = 'on_break', reopened_at = now(), reopen_count = reopen_count + 1, updated_at = now()
   WHERE match_id = p_match;
  -- no toca match_results.status, minutes_played ni el informe
  PERFORM public._live_rebuild_stints(p_match, true);
  RETURN public._live_state_json(p_match);
END $$;

-- F6. void_live_event ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_live_event(p_match uuid, p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  m     public.match_results;
  l     public.match_live;
  ev    public.match_live_events;
BEGIN
  m := public._live_auth(p_match, 'director');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.director_id IS DISTINCT FROM v_uid
     AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    PERFORM public._live_raise('NOT_DIRECTOR');
  END IF;
  IF l.status = 'finished' THEN PERFORM public._live_raise('LIVE_FINISHED'); END IF;

  SELECT * INTO ev FROM public.match_live_events x WHERE x.id = p_event_id AND x.match_id = p_match;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento no encontrado en este partido' USING ERRCODE = '02000';
  END IF;
  IF ev.voided_at IS NOT NULL THEN
    RETURN public._live_state_json(p_match);              -- idempotente
  END IF;
  IF ev.type IN ('match_end', 'match_reopen', 'callup', 'clock_adjust') THEN
    PERFORM public._live_raise('EVENT_NOT_VOIDABLE', ev.client_event_id, ev.id, ev.type);
  END IF;

  BEGIN
    UPDATE public.match_live_events SET voided_at = now(), voided_by = v_uid WHERE id = p_event_id;
    PERFORM public._live_rebuild_stints(p_match, true);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    PERFORM public._live_raise('DEPENDENT_EVENTS', ev.client_event_id, ev.id, ev.type);
  END;
  RETURN public._live_state_json(p_match);
END $$;

-- F7. set_live_director (administración) ----------------------------------------
CREATE OR REPLACE FUNCTION public.set_live_director(p_match uuid, p_new_director uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m public.match_results;
  l public.match_live;
BEGIN
  m := public._live_auth(p_match, 'admin');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF p_new_director IS NULL OR NOT public._live_is_staff_of(p_new_director, m.school_id) THEN
    PERFORM public._live_raise('NEW_DIRECTOR_NOT_STAFF');
  END IF;
  UPDATE public.match_live SET director_id = p_new_director, updated_at = now() WHERE match_id = p_match;
  RETURN public._live_state_json(p_match);
END $$;

-- F8. add_live_callup (refuerzos / convocados en vivo) ------------------------------
CREATE OR REPLACE FUNCTION public.add_live_callup(
  p_match uuid, p_subject_type text, p_subject_id uuid, p_jersey integer,
  p_client_event_id uuid, p_role text DEFAULT 'bench'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  m        public.match_results;
  l        public.match_live;
  v_lineup uuid;
  v_new    uuid;
BEGIN
  m := public._live_auth(p_match, 'director');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.director_id IS DISTINCT FROM v_uid
     AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    PERFORM public._live_raise('NOT_DIRECTOR');
  END IF;
  IF l.status = 'finished' THEN PERFORM public._live_raise('LIVE_FINISHED'); END IF;
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('profile', 'child', 'unregistered')
     OR p_subject_id IS NULL OR p_client_event_id IS NULL
     OR p_role IS NULL OR p_role NOT IN ('bench', 'starter')
     OR (p_role = 'starter' AND l.status <> 'not_started') THEN
    RAISE EXCEPTION 'Parámetros inválidos' USING ERRCODE = '22023';
  END IF;
  IF NOT public._v2_sujeto_en_escuela(p_subject_type, p_subject_id, m.school_id) THEN
    RAISE EXCEPTION 'El deportista no pertenece a esta escuela' USING ERRCODE = '22023', HINT = 'ROSTER_FOREIGN_PLAYER';
  END IF;
  IF p_jersey IS NULL OR p_jersey NOT BETWEEN 0 AND 999 THEN
    PERFORM public._live_raise('JERSEY_REQUIRED');
  END IF;
  SELECT ml.id INTO v_lineup FROM public.match_lineups ml
   WHERE ml.source_type = 'team_match' AND ml.source_id = p_match;
  IF v_lineup IS NULL THEN PERFORM public._live_raise('NO_STARTERS'); END IF;
  IF EXISTS (SELECT 1 FROM public.match_lineup_players x
              WHERE x.lineup_id = v_lineup AND x.jersey_number = p_jersey
                AND NOT (x.subject_type = p_subject_type AND x.subject_id = p_subject_id)) THEN
    PERFORM public._live_raise('JERSEY_DUPLICATE', p_extra => p_jersey::text);
  END IF;

  INSERT INTO public.match_live_events
         (match_id, school_id, client_event_id, type, period_no, period_second,
          subject_type, subject_id, created_by)
  VALUES (p_match, m.school_id, p_client_event_id, 'callup', GREATEST(l.current_period, 1), 0,
          p_subject_type, p_subject_id, v_uid)
  ON CONFLICT (match_id, client_event_id) DO NOTHING
  RETURNING id INTO v_new;
  IF v_new IS NULL THEN
    RETURN public._live_state_json(p_match);               -- ya aplicado: no inserta otra vez
  END IF;

  INSERT INTO public.match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, jersey_number)
  VALUES (v_lineup, m.school_id, p_subject_type, p_subject_id, p_role, p_jersey)
  ON CONFLICT (lineup_id, subject_type, subject_id)
  DO UPDATE SET jersey_number = COALESCE(public.match_lineup_players.jersey_number, EXCLUDED.jersey_number);
  -- sin aviso a familias durante el partido en F1
  RETURN public._live_state_json(p_match);
END $$;

-- F9. set_live_jersey --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_live_jersey(
  p_match uuid, p_subject_type text, p_subject_id uuid, p_jersey integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  m        public.match_results;
  l        public.match_live;
  v_lineup uuid;
  v_n      integer;
BEGIN
  m := public._live_auth(p_match, 'director');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF l.director_id IS DISTINCT FROM v_uid
     AND NOT (m.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    PERFORM public._live_raise('NOT_DIRECTOR');
  END IF;
  IF l.status = 'finished' THEN PERFORM public._live_raise('LIVE_FINISHED'); END IF;
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('profile', 'child', 'unregistered') OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Parámetros inválidos' USING ERRCODE = '22023';
  END IF;
  IF p_jersey IS NULL OR p_jersey NOT BETWEEN 0 AND 999 THEN
    PERFORM public._live_raise('JERSEY_REQUIRED');
  END IF;
  SELECT ml.id INTO v_lineup FROM public.match_lineups ml
   WHERE ml.source_type = 'team_match' AND ml.source_id = p_match;
  IF EXISTS (SELECT 1 FROM public.match_lineup_players x
              WHERE x.lineup_id = v_lineup AND x.jersey_number = p_jersey
                AND NOT (x.subject_type = p_subject_type AND x.subject_id = p_subject_id)) THEN
    PERFORM public._live_raise('JERSEY_DUPLICATE', p_extra => p_jersey::text);
  END IF;
  UPDATE public.match_lineup_players x SET jersey_number = p_jersey
   WHERE x.lineup_id = v_lineup AND x.subject_type = p_subject_type AND x.subject_id = p_subject_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN PERFORM public._live_raise('NOT_IN_LINEUP'); END IF;
  RETURN public._live_state_json(p_match);
END $$;

-- ===========================================================================
-- G. Permisos
-- ===========================================================================
-- Helpers internos: sin grant para nadie (los llaman las RPC, mismo dueño).
REVOKE ALL ON FUNCTION public._live_fmt_clock(integer)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_period_label(integer)                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_keys_to_json(text[])                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_lineup_rows(uuid)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_raise(text, uuid, uuid, text, text)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_is_staff_of(uuid, uuid)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_auth(uuid, text)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_open_stint(uuid, uuid, text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_close_stint(uuid, text, integer, text, uuid)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_rebuild_stints(uuid, boolean)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_state_json(uuid)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_report_data(uuid)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_draft_report(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_write_minutes(uuid, boolean)                         FROM PUBLIC, anon, authenticated;

-- RPC públicas: authenticated sí, anon no.
REVOKE ALL ON FUNCTION public.start_live_match(uuid, jsonb)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_live_events(uuid, jsonb)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_live_report(uuid)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_live_match(uuid, integer, integer)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reopen_live_match(uuid)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_live_event(uuid, uuid)                                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_live_director(uuid, uuid)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_live_callup(uuid, text, uuid, integer, uuid, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_live_jersey(uuid, text, uuid, integer)                 FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_live_match(uuid, jsonb)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_live_events(uuid, jsonb)                          TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_live_report(uuid)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_live_match(uuid, integer, integer)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_live_match(uuid)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_live_event(uuid, uuid)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_live_director(uuid, uuid)                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_live_callup(uuid, text, uuid, integer, uuid, text)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_live_jersey(uuid, text, uuid, integer)              TO authenticated;

COMMIT;
