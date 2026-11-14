-- 20261105234602_partido_vivo_correcciones_revision.sql
-- Partido en vivo F1: correcciones de la revisión independiente. NUEVA migración; no edita las 231xxx.
-- Cada cuerpo es el VIVO (pg_get_functiondef, 2026-11-05) con un cambio mínimo:
--  1. [ALTO] _live_guard_lineup_players: en UPDATE devolvía OLD (COALESCE(OLD,NEW)) y descartaba en
--     silencio el cambio de role/subject_id/subject_type para TODAS las escuelas. Ahora NEW salvo DELETE.
--  2. [MEDIO] publish_match_report: PERFORM 1 FROM match_live ... FOR SHARE antes del UPDATE de
--     match_reports (mismo orden de bloqueos que finish_live_match; evita deadlock).
--  3. [MEDIO] start_live_match: pg_advisory_xact_lock(hashtextextended(p_match::text,0)) tras el gate;
--     dos inicios simultáneos ya no dan 23505 en match_live_pkey (el segundo vuelve idempotente).
--  4. [BAJO] apply_live_events: el duplicado por client_event_id ahora compara también subject_id,
--     period_second y period_no (además de type); si difiere -> CLIENT_EVENT_ID_REUSED (código existente).
-- NO incluye (decisión de producto pendiente): minutos manuales al despublicar.
-- ACL vivo ANTES (verificado): las 3 RPC {postgres, service_role, authenticated}; el trigger fn
-- {postgres, service_role}. Esta migración deja EXACTAMENTE lo mismo (CREATE OR REPLACE conserva ACL;
-- el REVOKE/GRANT final lo reafirma). anon y PUBLIC sin EXECUTE.
-- Trigger trg_live_guard_lineup_players: NO se toca.
-- Una sola sesión aplica; recarga de esquema PostgREST al final (NOTIFY).

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public._live_guard_lineup_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_started boolean;
BEGIN
  -- Cascadas (borrado de escuela/usuario/convocatoria) no se bloquean.
  IF pg_trigger_depth() > 1 THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.role = OLD.role AND NEW.subject_id = OLD.subject_id
     AND NEW.subject_type = OLD.subject_type THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.match_lineups ml
      JOIN public.match_live l ON l.match_id = ml.source_id
     WHERE ml.id = OLD.lineup_id AND ml.source_type = 'team_match'
       AND l.status IN ('in_period','on_break','finished')
  ) INTO v_started;
  IF v_started THEN
    RAISE EXCEPTION 'El partido ya empezó; use los cambios en vivo'
      USING ERRCODE = 'P0001', HINT = 'LIVE_STARTED';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;

CREATE OR REPLACE FUNCTION public.publish_match_report(p_match uuid, p_publish boolean)
 RETURNS match_reports
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  r public.match_reports;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO r FROM public.match_reports WHERE match_id = p_match;
  IF NOT FOUND THEN RAISE EXCEPTION 'El partido todavía no tiene reporte' USING ERRCODE = '02000'; END IF;
  IF NOT (r.school_id = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
  END IF;
  IF p_publish AND r.summary IS NULL AND r.development IS NULL AND r.improvements IS NULL AND r.admin_comment IS NULL THEN
    RAISE EXCEPTION 'El reporte está vacío' USING ERRCODE = '22023';
  END IF;

  -- Orden de bloqueo único con finish_live_match (match_live primero, luego match_reports):
  -- evita el deadlock con _live_write_minutes (que toma match_live FOR SHARE más abajo).
  -- Sin fila en match_live (todas las demás escuelas) no hace nada ni falla.
  PERFORM 1 FROM public.match_live WHERE match_id = p_match FOR SHARE;

  UPDATE public.match_reports
     SET published_at = CASE WHEN p_publish THEN now() ELSE NULL END,
         updated_at = now()
   WHERE match_id = p_match
  RETURNING * INTO r;

  -- Partido en vivo terminado (D-P1=A): al PUBLICAR, los minutos de los tramos se copian a
  -- match_lineup_players.minutes_played (lo que leen las pantallas del acudiente); al despublicar
  -- se limpian. Sin fila de match_live (todas las demás escuelas) no hace nada.
  IF EXISTS (SELECT 1 FROM public.match_live ml WHERE ml.match_id = p_match AND ml.status = 'finished') THEN
    PERFORM public._live_write_minutes(p_match, p_publish);
  END IF;
  RETURN r;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_live_match(p_match uuid, p_options jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  -- Serializa inicios simultáneos: FOR UPDATE sobre una fila inexistente no bloquea a nadie, y el
  -- segundo INSERT chocaba con match_live_pkey (23505) en vez de volver idempotente.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_match::text, 0));
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
END $function$;

CREATE OR REPLACE FUNCTION public.apply_live_events(p_match uuid, p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
      IF v_old.type IS DISTINCT FROM v_type
         OR v_old.subject_id IS DISTINCT FROM v_sid
         OR v_old.period_second IS DISTINCT FROM v_sec
         OR v_old.period_no IS DISTINCT FROM v_pno THEN
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
END $function$;

REVOKE ALL ON FUNCTION public._live_guard_lineup_players()      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_match_report(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_live_match(uuid, jsonb)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_live_events(uuid, jsonb)    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_match_report(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_live_match(uuid, jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_live_events(uuid, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
