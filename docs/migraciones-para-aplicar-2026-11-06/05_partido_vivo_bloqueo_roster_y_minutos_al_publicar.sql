-- =============================================================================
-- 20261105231617_partido_vivo_bloqueo_roster_y_minutos_al_publicar.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105231608
-- Objetivo: Partido en vivo de Carmel, Fase 1, migración 4 de 4 (la ÚNICA que cambia
--   funciones que usan TODAS las escuelas; por eso va última).
--   1) save_match_roster: cuerpo vivo copiado TEXTUAL + un bloque que la rechaza con
--      P0001 / HINT LIVE_STARTED si el partido ya inició en vivo (in_period, on_break,
--      finished). Sin fila de match_live (cualquier otra escuela) es una búsqueda por PK
--      que no devuelve nada. Mantiene firma, SECURITY DEFINER, search_path y ACL.
--   2) publish_match_report: cuerpo vivo copiado TEXTUAL + hook D-P1=A: al publicar el
--      informe de un partido en vivo TERMINADO copia los minutos de los tramos a
--      match_lineup_players.minutes_played (_live_write_minutes); al despublicar los
--      deja en NULL. Misma firma, gate y ACL.
-- PRECONDICIÓN: 20261105231608 (define _live_write_minutes y match_live).
-- IMPORTANTE: los cuerpos se extrajeron de la base VIVA el 2026-11-05 (pg_get_functiondef;
--   el de save_match_roster coincide con 20261025003647). Si el día de aplicar
--   prosrc ya cambió, PARAR y re-extraer (ver 00_LEEME.md).
-- Cierra con NOTIFY pgrst (recarga el esquema de PostgREST una sola vez).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.save_match_roster(p_match uuid, p_players jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  m        public.match_results%ROWTYPE;
  v_lineup uuid;
  v_n      integer;
  v_antes  text[];
  v_ahora  text[];
  v_cuando text;
  v_ajenos integer;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.match_results WHERE id = p_match;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partido no encontrado' USING ERRCODE = '02000'; END IF;
  IF NOT (m.school_id = ANY (public.user_staff_school_ids()) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Sin permiso sobre esta escuela' USING ERRCODE = '42501';
  END IF;
  -- Partido en vivo ya iniciado: la reconvocatoria destructiva borraría tramos y minutos.
  -- FOR SHARE serializa contra apply_live_events (que toma FOR UPDATE sobre la misma fila).
  PERFORM 1 FROM public.match_live l
   WHERE l.match_id = p_match AND l.status IN ('in_period','on_break','finished')
   FOR SHARE;
  IF FOUND THEN
    RAISE EXCEPTION 'El partido ya empezó; use los cambios en vivo'
      USING ERRCODE = 'P0001', HINT = 'LIVE_STARTED';
  END IF;
  IF jsonb_typeof(COALESCE(p_players, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'p_players debe ser un arreglo' USING ERRCODE = '22023';
  END IF;

  -- M2: nadie ajeno a la escuela del partido entra a la convocatoria ni recibe
  -- el aviso. Se rechaza ANTES de tocar nada (la lista vieja queda igual).
  SELECT count(*) INTO v_ajenos
    FROM jsonb_array_elements(COALESCE(p_players, '[]'::jsonb)) x
   WHERE NOT public._v2_sujeto_en_escuela(x->>'subject_type', NULLIF(x->>'subject_id', '')::uuid, m.school_id);
  IF v_ajenos > 0 THEN
    RAISE EXCEPTION '% deportista(s) de la lista no pertenecen a esta escuela', v_ajenos
      USING ERRCODE = '22023', HINT = 'ROSTER_FOREIGN_PLAYER';
  END IF;

  INSERT INTO public.match_lineups (school_id, team_id, source_type, source_id, created_by)
  VALUES (m.school_id, m.team_id, 'team_match', p_match, v_uid)
  ON CONFLICT (source_type, source_id) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_lineup;

  -- Lista de antes (clave 'tipo:id') para saber quién entra y quién sale.
  SELECT COALESCE(array_agg(mlp.subject_type || ':' || mlp.subject_id), '{}'::text[])
    INTO v_antes
    FROM public.match_lineup_players mlp WHERE mlp.lineup_id = v_lineup;

  DELETE FROM public.match_lineup_players WHERE lineup_id = v_lineup;

  INSERT INTO public.match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, minutes_played, position_code, jersey_number)
  SELECT v_lineup, m.school_id, x->>'subject_type', (x->>'subject_id')::uuid,
         COALESCE(NULLIF(x->>'role', ''), 'starter'), NULLIF(x->>'minutes_played', '')::integer,
         NULLIF(x->>'position_code', ''), NULLIF(x->>'jersey_number', '')::integer
    FROM jsonb_array_elements(COALESCE(p_players, '[]'::jsonb)) x;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  SELECT COALESCE(array_agg(mlp.subject_type || ':' || mlp.subject_id), '{}'::text[])
    INTO v_ahora
    FROM public.match_lineup_players mlp WHERE mlp.lineup_id = v_lineup;

  -- Quien sale de la lista pierde su respuesta (si vuelve, responde de nuevo).
  DELETE FROM public.match_callup_responses r
   WHERE r.lineup_id = v_lineup
     AND NOT EXISTS (SELECT 1 FROM public.match_lineup_players mlp
                      WHERE mlp.lineup_id = v_lineup
                        AND mlp.subject_id = COALESCE(r.child_id, r.athlete_user_id, r.unregistered_athlete_id));

  -- Avisos: solo partidos que no han pasado ni se cancelaron. Un fallo del
  -- aviso nunca tumba la convocatoria.
  IF m.status <> 'cancelled' AND m.match_date >= (now() AT TIME ZONE 'America/Bogota')::date THEN
    BEGIN
      v_cuando := to_char(m.match_date, 'DD/MM')
               || COALESCE(' a las ' || to_char(m.kickoff_at AT TIME ZONE 'America/Bogota', 'HH24:MI'), '')
               || COALESCE(', en ' || NULLIF(btrim(m.location), ''), '');

      WITH cambios AS (
        SELECT 'entra'::text AS tipo, k FROM unnest(v_ahora) k WHERE NOT (k = ANY (v_antes))
        UNION ALL
        SELECT 'sale', k FROM unnest(v_antes) k WHERE NOT (k = ANY (v_ahora))
      ),
      sujetos AS (
        SELECT c.tipo, split_part(c.k, ':', 1) AS st, split_part(c.k, ':', 2)::uuid AS sid
          FROM cambios c
      ),
      con_cuenta AS (
        SELECT s.tipo, s.st, s.sid,
               public._callup_subject_account(s.st, s.sid) AS uid,
               split_part(btrim(COALESCE(ch.full_name, p.full_name, ua.full_name, 'Tu deportista')), ' ', 1) AS nombre
          FROM sujetos s
          LEFT JOIN public.children ch              ON s.st = 'child'        AND ch.id = s.sid
          LEFT JOIN public.profiles p               ON s.st = 'profile'      AND p.id  = s.sid
          LEFT JOIN public.unregistered_athletes ua ON s.st = 'unregistered' AND ua.id = s.sid
      )
      INSERT INTO public.notifications (user_id, school_id, type, category, title, message, link, data)
      SELECT cc.uid, m.school_id, 'info', 'match',
             CASE cc.tipo WHEN 'entra' THEN '⚽ Convocatoria: vs ' || m.opponent
                          ELSE '⚽ Cambio en la convocatoria: vs ' || m.opponent END,
             CASE cc.tipo
               WHEN 'entra' THEN string_agg(cc.nombre, ', ' ORDER BY cc.nombre)
                                 || CASE WHEN count(*) > 1 THEN ' están convocados' ELSE ' está convocado' END
                                 || ' para el partido del ' || v_cuando || '. Cuéntanos si va.'
               ELSE string_agg(cc.nombre, ', ' ORDER BY cc.nombre)
                    || ' ya no ' || CASE WHEN count(*) > 1 THEN 'están' ELSE 'está' END
                    || ' en la convocatoria del partido del ' || v_cuando || '.'
             END,
             '/calendar',
             jsonb_build_object('lineup_id', v_lineup, 'match_id', p_match, 'op', cc.tipo,
                                'subjects', jsonb_agg(jsonb_build_object('subject_type', cc.st, 'subject_id', cc.sid)))
        FROM con_cuenta cc
       WHERE cc.uid IS NOT NULL AND cc.uid <> v_uid
       GROUP BY cc.uid, cc.tipo;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'save_match_roster: aviso de convocatoria falló (%): %', SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN v_n;
END;
$function$;

-- ACL explícita (CREATE OR REPLACE la conserva; esto cubre un cambio por fuera).
REVOKE ALL ON FUNCTION public.save_match_roster(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_match_roster(uuid, jsonb) TO authenticated;

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

REVOKE ALL ON FUNCTION public.publish_match_report(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_match_report(uuid, boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
