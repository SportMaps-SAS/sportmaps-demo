-- =============================================================================
-- VERIFICACIÓN (solo lectura) — Partido en vivo F1 + flag N/A de Carmel
-- Se puede correr completo en el SQL Editor o con:
--   npx supabase db query --remote --read-only -f docs/migraciones-para-aplicar-2026-11-06/verificacion.sql -o json
-- Devuelve filas (bloque, chequeo, obtenido, esperado, ok). Todo `ok` debe ser true.
-- Solo consulta objetos por nombre (nada de list_tables / get_advisors).
-- El segundo bloque (invariantes_seguridad) es una consulta aparte, también de lectura.
-- =============================================================================
WITH
carmel AS (SELECT '374a6716-af42-4745-afe1-8d089153e01b'::uuid AS id),
live_fns AS (
  SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proacl,
         pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = ANY (ARRAY[
       'start_live_match','apply_live_events','match_live_report','finish_live_match','reopen_live_match',
       'void_live_event','set_live_director','add_live_callup','set_live_jersey',
       '_live_auth','_live_is_staff_of','_live_rebuild_stints','_live_state_json','_live_report_data',
       '_live_draft_report','_live_write_minutes','_live_open_stint','_live_close_stint','_live_lineup_rows',
       '_live_raise','_live_fmt_clock','_live_period_label','_live_keys_to_json','_live_guard_lineup_players'])
),
checks AS (
  -- 01 Carmel: rúbrica N/A (migración 01) -------------------------------------------------
  SELECT '01 rubric_allow_na' AS bloque, 'Carmel encendida' AS chequeo,
         (SELECT rubric_allow_na::text FROM public.school_settings WHERE school_id = (SELECT id FROM carmel)) AS obtenido,
         'true' AS esperado
  UNION ALL
  SELECT '01 rubric_allow_na', 'escuelas encendidas (solo Carmel)',
         (SELECT count(*)::text FROM public.school_settings WHERE rubric_allow_na), '1'

  -- 02 Flag, vista, agenda, dorsal ------------------------------------------------------
  UNION ALL SELECT '02 flag', 'columna live_match_enabled existe',
         (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'school_settings' AND column_name = 'live_match_enabled'), '1'
  UNION ALL SELECT '02 flag', 'escuelas con live_match_enabled = true (DEBE ser 0: no se enciende ninguna)',
         (SELECT count(*)::text FROM public.school_settings WHERE live_match_enabled), '0'
  UNION ALL SELECT '02 flag', 'filas de school_settings con el flag en false (todas)',
         (SELECT (count(*) FILTER (WHERE NOT live_match_enabled) = count(*))::text FROM public.school_settings), 'true'
  UNION ALL SELECT '02 vista', 'v_school_entitlements: última columna',
         (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = 'public.v_school_entitlements'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum DESC LIMIT 1), 'live_match_enabled'
  UNION ALL SELECT '02 vista', 'penúltima columna sigue siendo rubric_allow_na',
         (SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = 'public.v_school_entitlements'::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum DESC OFFSET 1 LIMIT 1), 'rubric_allow_na'
  UNION ALL SELECT '02 vista', 'reloptions conserva security_invoker',
         (SELECT coalesce(reloptions::text, 'null') FROM pg_class WHERE oid = 'public.v_school_entitlements'::regclass), '{security_invoker=true}'
  UNION ALL SELECT '02 vista', 'escuelas con live_match_enabled en la vista',
         (SELECT count(*)::text FROM public.v_school_entitlements WHERE live_match_enabled), '0'
  UNION ALL SELECT '02 agenda', 'match_results: 4 columnas nuevas',
         (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'match_results'
             AND column_name IN ('live_periods_count','live_period_minutes','match_kind','referee_name')), '4'
  UNION ALL SELECT '02 agenda', 'partidos existentes con datos de agenda (no deben cambiar)',
         (SELECT count(*)::text FROM public.match_results WHERE match_kind <> 'official' OR live_periods_count IS NOT NULL
             OR live_period_minutes IS NOT NULL OR referee_name IS NOT NULL), '0'
  UNION ALL SELECT '02 espejo', 'football_match_events.live_event_id existe',
         (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'football_match_events' AND column_name = 'live_event_id'), '1'
  UNION ALL SELECT '02 espejo', 'filas espejadas hoy (0 hasta que alguien termine un partido en vivo)',
         (SELECT count(*)::text FROM public.football_match_events WHERE live_event_id IS NOT NULL), '0'
  UNION ALL SELECT '02 dorsal', 'CHECK de rango del dorsal',
         (SELECT count(*)::text FROM pg_constraint WHERE conname = 'match_lineup_players_jersey_range_chk' AND convalidated), '1'

  -- 03 Tablas y RLS ---------------------------------------------------------------------
  UNION ALL SELECT '03 tablas', 'existe ' || t,
         (SELECT (to_regclass('public.' || t) IS NOT NULL)::text), 'true'
    FROM unnest(ARRAY['match_live','match_live_periods','match_live_events','match_player_stints']) t
  UNION ALL SELECT '03 rls', 'RLS activa y sin FORCE: ' || c.relname,
         (c.relrowsecurity AND NOT c.relforcerowsecurity)::text, 'true'
    FROM pg_class c WHERE c.oid = ANY (ARRAY['public.match_live'::regclass,'public.match_live_periods'::regclass,'public.match_live_events'::regclass,'public.match_player_stints'::regclass])
  UNION ALL SELECT '03 policies', 'total de policies en las 4 tablas',
         (SELECT count(*)::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('match_live','match_live_periods','match_live_events','match_player_stints')), '4'
  UNION ALL SELECT '03 policies', 'todas SELECT para authenticated, sin FOR ALL',
         (SELECT (count(*) FILTER (WHERE cmd = 'SELECT' AND roles = '{authenticated}') = count(*))::text
            FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('match_live','match_live_periods','match_live_events','match_player_stints')), 'true'
  UNION ALL SELECT '03 policies', 'ninguna usa user_school_ids() (que incluye padres)',
         (SELECT (count(*) FILTER (WHERE qual ~ 'user_school_ids') = 0)::text
            FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('match_live','match_live_periods','match_live_events','match_player_stints')), 'true'
  UNION ALL SELECT '03 grants', 'anon sin NINGÚN privilegio en las 4 tablas',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND grantee = 'anon' AND table_name IN ('match_live','match_live_periods','match_live_events','match_player_stints')), '0'
  UNION ALL SELECT '03 grants', 'authenticated solo SELECT (filas de privilegio distintas de SELECT)',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type <> 'SELECT'
             AND table_name IN ('match_live','match_live_periods','match_live_events','match_player_stints')), '0'
  UNION ALL SELECT '03 grants', 'authenticated con SELECT en las 4',
         (SELECT count(*)::text FROM information_schema.role_table_grants
           WHERE table_schema = 'public' AND grantee = 'authenticated' AND privilege_type = 'SELECT'
             AND table_name IN ('match_live','match_live_periods','match_live_events','match_player_stints')), '4'
  UNION ALL SELECT '03 datos', 'filas en match_live fuera de Carmel',
         (SELECT count(*)::text FROM public.match_live WHERE school_id <> (SELECT id FROM carmel)), '0'
  UNION ALL SELECT '03 trigger', 'trg_live_guard_lineup_players en match_lineup_players',
         (SELECT count(*)::text FROM pg_trigger WHERE tgname = 'trg_live_guard_lineup_players' AND tgrelid = 'public.match_lineup_players'::regclass AND NOT tgisinternal), '1'
  UNION ALL SELECT '03 trigger', 'función del trigger: SECURITY DEFINER + search_path + sin EXECUTE para authenticated/anon',
         (SELECT (prosecdef AND proconfig::text LIKE '%search_path=pg_catalog, public, pg_temp%'
                  AND NOT has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE'))::text
            FROM pg_proc WHERE proname = '_live_guard_lineup_players' AND pronamespace = 'public'::regnamespace), 'true'

  -- 04 Funciones: 9 RPC públicas + helpers internos ------------------------------------
  UNION ALL SELECT '04 rpc', f.proname || '(' || f.args || '): SECURITY DEFINER + search_path fijo',
         (f.prosecdef AND f.proconfig::text LIKE '%search_path=pg_catalog, public, pg_temp%')::text, 'true'
    FROM live_fns f
   WHERE f.proname IN ('start_live_match','apply_live_events','match_live_report','finish_live_match','reopen_live_match','void_live_event','set_live_director','add_live_callup','set_live_jersey')
  UNION ALL SELECT '04 rpc', f.proname || ': authenticated SÍ, anon NO, PUBLIC NO',
         (has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
          AND coalesce(f.proacl::text, '') !~ '(^\{|,)=X')::text, 'true'
    FROM live_fns f
   WHERE f.proname IN ('start_live_match','apply_live_events','match_live_report','finish_live_match','reopen_live_match','void_live_event','set_live_director','add_live_callup','set_live_jersey')
  UNION ALL SELECT '04 rpc', 'cantidad de RPC públicas encontradas',
         (SELECT count(*)::text FROM live_fns WHERE proname IN ('start_live_match','apply_live_events','match_live_report','finish_live_match','reopen_live_match','void_live_event','set_live_director','add_live_callup','set_live_jersey')), '9'
  UNION ALL SELECT '04 helper', f.proname || '(' || f.args || '): SECURITY DEFINER (si aplica) + search_path fijo',
         (coalesce(f.proconfig::text, '') LIKE '%search_path=pg_catalog, public, pg_temp%')::text, 'true'
    FROM live_fns f
   WHERE f.proname LIKE '\_live\_%'
  UNION ALL SELECT '04 helper', f.proname || ': sin EXECUTE para authenticated, anon ni PUBLIC',
         (NOT has_function_privilege('authenticated', f.oid, 'EXECUTE') AND NOT has_function_privilege('anon', f.oid, 'EXECUTE')
          AND coalesce(f.proacl::text, '') !~ '(^\{|,)=X')::text, 'true'
    FROM live_fns f
   WHERE f.proname LIKE '\_live\_%'
  UNION ALL SELECT '04 helper', 'cantidad de helpers _live_* encontrados (14 + el del trigger)',
         (SELECT count(*)::text FROM live_fns WHERE proname LIKE '\_live\_%'), '15'

  -- 05 Funciones globales cambiadas (migración 05) --------------------------------------
  UNION ALL SELECT '05 roster', 'save_match_roster contiene el bloqueo LIVE_STARTED',
         (SELECT (prosrc LIKE '%LIVE_STARTED%')::text FROM pg_proc WHERE proname = 'save_match_roster' AND pronamespace = 'public'::regnamespace), 'true'
  UNION ALL SELECT '05 roster', 'save_match_roster: search_path fijo + SECURITY DEFINER',
         (SELECT (prosecdef AND proconfig::text LIKE '%search_path=pg_catalog, public, pg_temp%')::text FROM pg_proc WHERE proname = 'save_match_roster' AND pronamespace = 'public'::regnamespace), 'true'
  UNION ALL SELECT '05 roster', 'save_match_roster: authenticated SÍ, anon NO',
         (SELECT (has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE'))::text FROM pg_proc WHERE proname = 'save_match_roster' AND pronamespace = 'public'::regnamespace), 'true'
  UNION ALL SELECT '05 publish', 'publish_match_report contiene el hook _live_write_minutes',
         (SELECT (prosrc LIKE '%_live_write_minutes%')::text FROM pg_proc WHERE proname = 'publish_match_report' AND pronamespace = 'public'::regnamespace), 'true'
  UNION ALL SELECT '05 publish', 'publish_match_report: search_path fijo + authenticated SÍ, anon NO',
         (SELECT (proconfig::text LIKE '%search_path=pg_catalog, public, pg_temp%'
                  AND has_function_privilege('authenticated', oid, 'EXECUTE') AND NOT has_function_privilege('anon', oid, 'EXECUTE'))::text
            FROM pg_proc WHERE proname = 'publish_match_report' AND pronamespace = 'public'::regnamespace), 'true'
  UNION ALL SELECT '05 minutos', 'minutes_played con valor en partidos con match_live sin informe publicado (D-P1: 0)',
         (SELECT count(*)::text FROM public.match_lineup_players mlp
            JOIN public.match_lineups ml ON ml.id = mlp.lineup_id AND ml.source_type = 'team_match'
            JOIN public.match_live l ON l.match_id = ml.source_id
            LEFT JOIN public.match_reports r ON r.match_id = l.match_id
           WHERE mlp.minutes_played IS NOT NULL AND r.published_at IS NULL), '0'
)
SELECT bloque, chequeo, obtenido, esperado, (obtenido IS NOT DISTINCT FROM esperado) AS ok
  FROM checks
 ORDER BY (obtenido IS NOT DISTINCT FROM esperado), bloque, chequeo;

-- Segundo bloque (consulta aparte): invariantes de seguridad I1-I4 contra la base viva.
-- No debe aparecer ninguna violación CRÍTICA (equivale a `npm run seguridad:invariantes`).
SELECT * FROM public.invariantes_seguridad();
