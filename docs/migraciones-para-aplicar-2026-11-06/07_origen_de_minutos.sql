-- =============================================================================
-- 20261105235829_partido_vivo_origen_de_minutos.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06
-- Objetivo: guardar DE DONDE viene cada minuto jugado ("guardamos cada minuto").
--   1) match_lineup_players.minutes_source text CHECK ('manual','live'); NULL = sin dato / historico.
--      ADD COLUMN sin DEFAULT y nullable: solo catalogo, sin reescribir tabla (PG15). Ningun backfill.
--   2) Trigger BEFORE UPDATE OF minutes_played: un UPDATE directo del cliente que CAMBIA el valor
--      marca 'manual' (valor NULL -> source NULL). No actua cuando _live_write_minutes lo hace
--      (marca de transaccion app.live_minutes_write='1'; elegida sobre pg_trigger_depth porque el
--      UPDATE de la RPC corre a profundidad 1, igual que el del cliente, asi que depth no distingue;
--      la marca es local a la transaccion y se apaga al terminar el UPDATE). Compatible con
--      trg_live_guard_lineup_players (no se toca; su rama "role/subject sin cambio" devuelve NEW).
--   3) _live_write_minutes(true): escribe tramos solo donde minutes_played IS NULL o source='live', y
--      marca 'live'. (false): NULL solo donde source='live'. Los manuales y los historicos con minutos
--      (source NULL) quedan intactos.
--   4) _live_report_data (y por ende match_live_report) agrega por jugador minutes_live,
--      minutes_published y minutes_source. 'minutes' se conserva igual. El calculo de tramos
--      (match_player_stints) nunca se toca.
-- Cuerpos extraidos de la base VIVA (pg_get_functiondef) el 2026-11-05 y modificados minimamente.
--   Si prosrc ya cambio el dia de aplicar, PARAR y re-extraer. ACL vivas: postgres+service_role
--   (+authenticated solo match_live_report, que no se redefine).
-- Una sola sesion aplica migraciones (Disk IO). Cierra con NOTIFY pgrst.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.match_lineup_players ADD COLUMN IF NOT EXISTS minutes_source text;
ALTER TABLE public.match_lineup_players DROP CONSTRAINT IF EXISTS match_lineup_players_minutes_source_check;
ALTER TABLE public.match_lineup_players ADD CONSTRAINT match_lineup_players_minutes_source_check
  CHECK (minutes_source IS NULL OR minutes_source IN ('manual', 'live'));
COMMENT ON COLUMN public.match_lineup_players.minutes_source IS
  'Origen de minutes_played: manual (editado por staff), live (copiado de los tramos del partido en vivo), NULL = sin dato o historico sin origen.';

CREATE OR REPLACE FUNCTION public._lineup_minutes_source_mark()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- Escritura de _live_write_minutes: ella fija minutes_source.
  IF COALESCE(current_setting('app.live_minutes_write', true), '') = '1' THEN
    RETURN NEW;
  END IF;
  -- Solo si el valor realmente cambia (un guardado que reenvia el mismo valor no marca nada).
  IF NEW.minutes_played IS NOT DISTINCT FROM OLD.minutes_played THEN
    RETURN NEW;
  END IF;
  NEW.minutes_source := CASE WHEN NEW.minutes_played IS NULL THEN NULL ELSE 'manual' END;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public._lineup_minutes_source_mark() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_lineup_minutes_source_mark ON public.match_lineup_players;
CREATE TRIGGER trg_lineup_minutes_source_mark
  BEFORE UPDATE OF minutes_played ON public.match_lineup_players
  FOR EACH ROW EXECUTE FUNCTION public._lineup_minutes_source_mark();

CREATE OR REPLACE FUNCTION public._live_write_minutes(p_match uuid, p_publish boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM 1 FROM public.match_live l WHERE l.match_id = p_match FOR SHARE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- Marca de transaccion: el trigger de origen NO la toma por edicion manual.
  PERFORM set_config('app.live_minutes_write', '1', true);
  IF p_publish THEN
    -- Solo donde no hay dato (NULL/NULL) o el dato ya es 'live'. 'manual' y filas viejas con
    -- minutos y source NULL (tratadas como manuales) no se pisan.
    UPDATE public.match_lineup_players mlp
       SET minutes_played = x.mins, minutes_source = 'live'
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
     WHERE mlp.id = x.id
       AND (mlp.minutes_played IS NULL OR mlp.minutes_source = 'live');
  ELSE
    UPDATE public.match_lineup_players mlp
       SET minutes_played = NULL, minutes_source = NULL
      FROM public.match_lineups ml
     WHERE mlp.lineup_id = ml.id AND ml.source_type = 'team_match' AND ml.source_id = p_match
       AND mlp.minutes_source = 'live';
  END IF;
  PERFORM set_config('app.live_minutes_write', '0', true);
END $function$
;

CREATE OR REPLACE FUNCTION public._live_report_data(p_match uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
     WHERE x.match_id = p_match AND x.type = 'red' AND x.voided_at IS NULL),
  mpub AS (
    SELECT DISTINCT ON (mp.subject_type, mp.subject_id)
           mp.subject_type, mp.subject_id, mp.minutes_played, mp.minutes_source
      FROM public.match_lineups ml
      JOIN public.match_lineup_players mp ON mp.lineup_id = ml.id
     WHERE ml.source_type = 'team_match' AND ml.source_id = p_match
     ORDER BY mp.subject_type, mp.subject_id, mp.id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'subject_type', lp.subject_type, 'subject_id', lp.subject_id, 'name', lp.name,
           'jersey_number', lp.jersey_number, 'role', lp.role,
           'seconds', COALESCE(a.secs, 0),
           'minutes', CASE WHEN COALESCE(a.secs, 0) = 0 THEN 0 ELSE GREATEST(1, round(a.secs / 60.0)::int) END,
           'minutes_live', CASE WHEN COALESCE(a.secs, 0) = 0 THEN 0 ELSE GREATEST(1, round(a.secs / 60.0)::int) END,
           'minutes_published', mpub.minutes_played,
           'minutes_source', mpub.minutes_source,
           'pct', CASE WHEN v_total > 0 THEN round(100.0 * COALESCE(a.secs, 0) / v_total, 1) ELSE 0 END,
           'stints', COALESCE(a.stints, '[]'::jsonb),
           'sent_off', (rd.subject_id IS NOT NULL))
           ORDER BY (lp.role = 'starter') DESC, lp.jersey_number NULLS LAST, lp.name), '[]'::jsonb)
    INTO v_lineup
    FROM lp
    LEFT JOIN agg a ON a.subject_type = lp.subject_type AND a.subject_id = lp.subject_id
    LEFT JOIN rd  ON rd.subject_type = lp.subject_type AND rd.subject_id = lp.subject_id
    LEFT JOIN mpub ON mpub.subject_type = lp.subject_type AND mpub.subject_id = lp.subject_id;

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
END $function$
;

REVOKE ALL ON FUNCTION public._live_report_data(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._live_write_minutes(uuid, boolean) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
