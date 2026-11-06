-- =============================================================================
-- 20261106001001_partido_vivo_agenda_create_update_match.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105235829
-- Objetivo: Partido en vivo, «Programar partido»: create_match y update_match
--   aceptan y guardan el formato del partido (match_results.live_periods_count,
--   live_period_minutes, match_kind, referee_name; columnas de 20261105231554).
-- Reglas:
--   (a) Cada columna se escribe SOLO si su clave viene en p. Sin la clave: update
--       conserva el valor actual y create deja el DEFAULT (NULL/NULL/'official'/NULL).
--       CalendarPage y las demás escuelas llaman sin claves: nada cambia.
--   (b) Rangos del CHECK validados adentro con 22023: tiempos 1-4, minutos 5-60
--       (enteros), árbitro <=120 tras btrim (vacío = NULL), match_kind official|practice
--       (null/vacío = 'official', la columna es NOT NULL).
--   (c) Si viene CUALQUIERA de las 4 claves y school_settings.live_match_enabled de la
--       escuela del partido no está encendido: P0001 con HINT/DETAIL LIVE_DISABLED
--       (mismo contrato que _live_raise; se inlinea para no depender de la migración 04).
--   (d) Firma, retorno, SECURITY DEFINER, search_path y gate de alcance idénticos a los
--       VIVOS (extraídos con pg_get_functiondef el 2026-11-06; última definición:
--       20260926131340, sin versiones posteriores). ACL viva: postgres, service_role,
--       authenticated; se reafirma igual (REVOKE PUBLIC/anon).
-- PRECONDICIÓN: 20261105231554 aplicada (columnas y flag). IDEMPOTENTE (CREATE OR REPLACE).
-- RADIO: solo cuerpos de función; sin DDL de tablas. NOTIFY pgrst por el cambio de RPC.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'match_results' AND column_name = 'referee_name')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'school_settings' AND column_name = 'live_match_enabled') THEN
    RAISE EXCEPTION 'Falta aplicar 20261105231554 (match_results.referee_name / school_settings.live_match_enabled)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.create_match(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_team    uuid := NULLIF(p->>'team_id', '')::uuid;
  v_school  uuid;
  v_date    date := NULLIF(p->>'match_date', '')::date;
  v_kickoff timestamptz := NULLIF(p->>'kickoff_at', '')::timestamptz;
  v_home    integer := NULLIF(p->>'home_score', '')::integer;
  v_away    integer := NULLIF(p->>'away_score', '')::integer;
  v_opp     text := NULLIF(trim(p->>'opponent'), '');
  v_event   uuid := NULLIF(p->>'calendar_event_id', '')::uuid;
  v_day     uuid := NULLIF(p->>'microcycle_day_id', '')::uuid;
  v_start   timestamptz;
  v_match   uuid;
  v_n       integer;
  v_periods smallint;
  v_minutes smallint;
  v_kind    text;
  v_referee text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF v_team IS NULL OR v_opp IS NULL OR (v_date IS NULL AND v_kickoff IS NULL) THEN
    RAISE EXCEPTION 'Faltan categoría, rival o fecha' USING ERRCODE = '22023';
  END IF;
  SELECT school_id INTO v_school FROM public.teams WHERE id = v_team;
  IF v_school IS NULL THEN RAISE EXCEPTION 'Categoría no válida' USING ERRCODE = '22023'; END IF;
  IF NOT (v_school = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
  END IF;

  -- Formato del partido en vivo (solo si viene alguna clave): rangos y flag
  IF p ?| ARRAY['live_periods_count', 'live_period_minutes', 'match_kind', 'referee_name'] THEN
    IF p ? 'live_periods_count' THEN
      IF NULLIF(btrim(p->>'live_periods_count'), '') IS NOT NULL THEN
        IF (p->>'live_periods_count') !~ '^[0-9]{1,3}$' OR (p->>'live_periods_count')::integer NOT BETWEEN 1 AND 4 THEN
          RAISE EXCEPTION 'Cantidad de tiempos no válida (1 a 4)' USING ERRCODE = '22023';
        END IF;
        v_periods := (p->>'live_periods_count')::smallint;
      END IF;
    END IF;
    IF p ? 'live_period_minutes' THEN
      IF NULLIF(btrim(p->>'live_period_minutes'), '') IS NOT NULL THEN
        IF (p->>'live_period_minutes') !~ '^[0-9]{1,3}$' OR (p->>'live_period_minutes')::integer NOT BETWEEN 5 AND 60 THEN
          RAISE EXCEPTION 'Minutos por tiempo no válidos (5 a 60)' USING ERRCODE = '22023';
        END IF;
        v_minutes := (p->>'live_period_minutes')::smallint;
      END IF;
    END IF;
    IF p ? 'match_kind' THEN
      v_kind := COALESCE(NULLIF(btrim(p->>'match_kind'), ''), 'official');
      IF v_kind NOT IN ('official', 'practice') THEN
        RAISE EXCEPTION 'Tipo de partido no válido (official o practice)' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF p ? 'referee_name' THEN
      v_referee := NULLIF(btrim(p->>'referee_name'), '');
      IF char_length(v_referee) > 120 THEN
        RAISE EXCEPTION 'El nombre del árbitro supera 120 caracteres' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF NOT COALESCE((SELECT ss.live_match_enabled FROM public.school_settings ss WHERE ss.school_id = v_school), false) THEN
      RAISE EXCEPTION 'El partido en vivo no está habilitado para esta escuela'
        USING ERRCODE = 'P0001', HINT = 'LIVE_DISABLED', DETAIL = '{"code": "LIVE_DISABLED"}';
    END IF;
  END IF;

  v_date  := COALESCE(v_date, (v_kickoff AT TIME ZONE 'America/Bogota')::date);
  v_start := COALESCE(v_kickoff, (v_date + time '15:00') AT TIME ZONE 'America/Bogota');

  IF v_event IS NOT NULL THEN
    PERFORM 1 FROM public.calendar_events WHERE id = v_event AND school_id = v_school;
    IF NOT FOUND THEN RAISE EXCEPTION 'Evento de calendario no válido' USING ERRCODE = '22023'; END IF;
  ELSIF COALESCE((p->>'create_calendar_event')::boolean, false) THEN
    INSERT INTO public.calendar_events (user_id, title, description, event_type, start_time, end_time, location, all_day, team_id, school_id)
    VALUES (v_uid, 'Partido vs ' || v_opp, NULLIF(p->>'notes', ''), 'match', v_start, v_start + interval '2 hours',
            NULLIF(p->>'location', ''), false, v_team, v_school)
    RETURNING id INTO v_event;
  END IF;

  INSERT INTO public.match_results (team_id, opponent, home_score, away_score, is_home, match_date, match_type, notes,
                                    status, kickoff_at, location, calendar_event_id, tournament_match_id, created_by, updated_by,
                                    live_periods_count, live_period_minutes, match_kind, referee_name)
  VALUES (v_team, v_opp, v_home, v_away, COALESCE((p->>'is_home')::boolean, true), v_date, NULLIF(p->>'match_type', ''),
          NULLIF(p->>'notes', ''),
          CASE WHEN v_home IS NOT NULL AND v_away IS NOT NULL THEN 'played' ELSE 'scheduled' END,
          v_kickoff, NULLIF(p->>'location', ''), v_event, NULLIF(p->>'tournament_match_id', '')::uuid, v_uid, v_uid,
          v_periods, v_minutes, COALESCE(v_kind, 'official'), v_referee)
  RETURNING id INTO v_match;

  IF v_day IS NOT NULL THEN
    UPDATE public.training_microcycle_days SET match_id = v_match WHERE id = v_day AND school_id = v_school;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RAISE EXCEPTION 'Día del mesociclo no válido' USING ERRCODE = '22023'; END IF;
  END IF;

  RETURN jsonb_build_object('match_id', v_match, 'calendar_event_id', v_event);
END; $function$;

CREATE OR REPLACE FUNCTION public.update_match(p_match uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  m     public.match_results%ROWTYPE;
  v_new_start timestamptz;
  v_periods smallint;
  v_minutes smallint;
  v_kind    text;
  v_referee text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.match_results WHERE id = p_match FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partido no encontrado' USING ERRCODE = '02000'; END IF;
  IF NOT (m.school_id = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
  END IF;
  IF p ? 'status' AND (p->>'status') NOT IN ('scheduled', 'played', 'cancelled') THEN
    RAISE EXCEPTION 'Estado no válido' USING ERRCODE = '22023';
  END IF;

  -- Formato del partido en vivo (solo si viene alguna clave): rangos y flag
  IF p ?| ARRAY['live_periods_count', 'live_period_minutes', 'match_kind', 'referee_name'] THEN
    IF p ? 'live_periods_count' THEN
      IF NULLIF(btrim(p->>'live_periods_count'), '') IS NOT NULL THEN
        IF (p->>'live_periods_count') !~ '^[0-9]{1,3}$' OR (p->>'live_periods_count')::integer NOT BETWEEN 1 AND 4 THEN
          RAISE EXCEPTION 'Cantidad de tiempos no válida (1 a 4)' USING ERRCODE = '22023';
        END IF;
        v_periods := (p->>'live_periods_count')::smallint;
      END IF;
    END IF;
    IF p ? 'live_period_minutes' THEN
      IF NULLIF(btrim(p->>'live_period_minutes'), '') IS NOT NULL THEN
        IF (p->>'live_period_minutes') !~ '^[0-9]{1,3}$' OR (p->>'live_period_minutes')::integer NOT BETWEEN 5 AND 60 THEN
          RAISE EXCEPTION 'Minutos por tiempo no válidos (5 a 60)' USING ERRCODE = '22023';
        END IF;
        v_minutes := (p->>'live_period_minutes')::smallint;
      END IF;
    END IF;
    IF p ? 'match_kind' THEN
      v_kind := COALESCE(NULLIF(btrim(p->>'match_kind'), ''), 'official');
      IF v_kind NOT IN ('official', 'practice') THEN
        RAISE EXCEPTION 'Tipo de partido no válido (official o practice)' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF p ? 'referee_name' THEN
      v_referee := NULLIF(btrim(p->>'referee_name'), '');
      IF char_length(v_referee) > 120 THEN
        RAISE EXCEPTION 'El nombre del árbitro supera 120 caracteres' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF NOT COALESCE((SELECT ss.live_match_enabled FROM public.school_settings ss WHERE ss.school_id = m.school_id), false) THEN
      RAISE EXCEPTION 'El partido en vivo no está habilitado para esta escuela'
        USING ERRCODE = 'P0001', HINT = 'LIVE_DISABLED', DETAIL = '{"code": "LIVE_DISABLED"}';
    END IF;
  END IF;

  UPDATE public.match_results SET
    opponent   = CASE WHEN p ? 'opponent'   THEN COALESCE(NULLIF(trim(p->>'opponent'), ''), opponent) ELSE opponent END,
    match_date = CASE WHEN p ? 'match_date' THEN COALESCE(NULLIF(p->>'match_date', '')::date, match_date) ELSE match_date END,
    kickoff_at = CASE WHEN p ? 'kickoff_at' THEN NULLIF(p->>'kickoff_at', '')::timestamptz ELSE kickoff_at END,
    is_home    = CASE WHEN p ? 'is_home'    THEN COALESCE((p->>'is_home')::boolean, is_home) ELSE is_home END,
    match_type = CASE WHEN p ? 'match_type' THEN NULLIF(p->>'match_type', '') ELSE match_type END,
    location   = CASE WHEN p ? 'location'   THEN NULLIF(p->>'location', '') ELSE location END,
    notes      = CASE WHEN p ? 'notes'      THEN NULLIF(p->>'notes', '') ELSE notes END,
    home_score = CASE WHEN p ? 'home_score' THEN NULLIF(p->>'home_score', '')::integer ELSE home_score END,
    away_score = CASE WHEN p ? 'away_score' THEN NULLIF(p->>'away_score', '')::integer ELSE away_score END,
    status     = CASE WHEN p ? 'status' THEN p->>'status' ELSE status END,
    live_periods_count  = CASE WHEN p ? 'live_periods_count'  THEN v_periods ELSE live_periods_count  END,
    live_period_minutes = CASE WHEN p ? 'live_period_minutes' THEN v_minutes ELSE live_period_minutes END,
    match_kind          = CASE WHEN p ? 'match_kind'          THEN v_kind    ELSE match_kind          END,
    referee_name        = CASE WHEN p ? 'referee_name'        THEN v_referee ELSE referee_name        END,
    updated_by = v_uid
  WHERE id = p_match
  RETURNING * INTO m;

  IF m.status = 'scheduled' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL AND NOT (p ? 'status') THEN
    UPDATE public.match_results SET status = 'played' WHERE id = p_match RETURNING * INTO m;
  END IF;

  IF m.calendar_event_id IS NOT NULL AND (p ? 'kickoff_at' OR p ? 'match_date') THEN
    v_new_start := COALESCE(m.kickoff_at, (m.match_date + time '15:00') AT TIME ZONE 'America/Bogota');
    UPDATE public.calendar_events
       SET end_time = v_new_start + (end_time - start_time), start_time = v_new_start, updated_at = now()
     WHERE id = m.calendar_event_id;
  END IF;

  RETURN to_jsonb(m);
END; $function$;

-- ACL idéntica a la viva: postgres (dueño), service_role y authenticated; sin PUBLIC ni anon.
REVOKE ALL ON FUNCTION public.create_match(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_match(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_match(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_match(uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
