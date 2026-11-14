-- =============================================================================
-- Verificación de 20261027124411_cierre_policies_autoadjudicables
-- Correr DESPUÉS de pegar cierre-policies-autoadjudicables.sql.
--
-- Un solo bloque DO que termina SIEMPRE en RAISE EXCEPTION, a propósito: todo
-- lo que toca (fila de organizador, eventos, plan, grant, captura, línea base)
-- se deshace. Resultado esperado: un error que empieza por
--   «RESULTADO — 48/48 pruebas OK (se deshace a propósito)»
-- Cualquier otro error = una prueba falló (el mensaje dice cuál) o faltaron
-- datos para prepararla («PREPARACIÓN: …»).
--
-- Usuarios reales elegidos por SELECT al arrancar (no se modifican):
--   C  coach con coach_auth_id activo en la escuela S
--   A  atleta con inscripción activa propia en S (no staff, sin línea base)
--   AD dueño de S (administración)
--   S2 otra escuela donde ni A ni C pertenecen
--   B  atleta inscrito en otra escuela, no en S
--   X  perfil sin ninguna relación (ni escuela, ni inscripción, ni plataforma)
--   O  organizador que creó un evento y NO tiene fila en event_organizers
-- Las sesiones se simulan con set_config('request.jwt.claims', …, true) y
-- SET LOCAL ROLE authenticated / anon.
-- =============================================================================
DO $$
DECLARE
  c_total constant int := 48;
  v_c   uuid; v_s  uuid; v_a  uuid; v_ad uuid; v_s2 uuid;
  v_b   uuid; v_x  uuid; v_o  uuid; v_evento_o uuid;
  v_tsp_ajeno uuid; v_plan uuid; v_cap uuid;
  v_n   int;
  v_ok  int := 0;
  v_b1  boolean;
BEGIN
  -- ── Preparación: elegir usuarios (como postgres) ───────────────────────────
  SELECT ss.coach_auth_id, ss.school_id, e.user_id, sc.owner_id
    INTO v_c, v_s, v_a, v_ad
    FROM public.school_staff ss
    JOIN public.enrollments e ON e.school_id = ss.school_id AND e.status = 'active' AND e.user_id IS NOT NULL
    JOIN public.schools sc    ON sc.id = ss.school_id
   WHERE ss.status = 'active' AND ss.coach_auth_id IS NOT NULL
     AND e.user_id <> ss.coach_auth_id
     AND sc.owner_id IS NOT NULL AND sc.owner_id NOT IN (ss.coach_auth_id, e.user_id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = e.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff x WHERE x.coach_auth_id = e.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.profile_id = e.user_id AND m.role NOT IN ('parent','athlete'))
     AND NOT EXISTS (SELECT 1 FROM public.schools o WHERE o.owner_id = e.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.biomech_baselines bb WHERE bb.athlete_id = e.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id IN (ss.coach_auth_id, e.user_id, sc.owner_id))
   ORDER BY ss.school_id, e.user_id
   LIMIT 1;
  IF v_c IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay coach C con atleta A inscrito'; END IF;

  SELECT s.id INTO v_s2
    FROM public.schools s
   WHERE s.id <> v_s
     AND s.owner_id IS DISTINCT FROM v_a AND s.owner_id IS DISTINCT FROM v_c
     AND NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.school_id = s.id AND m.profile_id IN (v_a, v_c))
     AND NOT EXISTS (SELECT 1 FROM public.school_staff ss WHERE ss.school_id = s.id AND ss.coach_auth_id IN (v_a, v_c))
     AND NOT EXISTS (SELECT 1 FROM public.school_staff ss JOIN auth.users au ON lower(au.email) = lower(ss.email)
                      WHERE ss.school_id = s.id AND au.id IN (v_a, v_c))
     AND NOT EXISTS (SELECT 1 FROM public.enrollments e WHERE e.school_id = s.id AND e.user_id = v_a)
   ORDER BY s.created_at
   LIMIT 1;
  IF v_s2 IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay escuela S2'; END IF;

  SELECT e.user_id INTO v_b
    FROM public.enrollments e
   WHERE e.status = 'active' AND e.user_id IS NOT NULL AND e.school_id <> v_s AND e.user_id NOT IN (v_a, v_c)
     AND NOT EXISTS (SELECT 1 FROM public.enrollments e2 WHERE e2.school_id = v_s AND e2.user_id = e.user_id AND e2.status = 'active')
   LIMIT 1;
  IF v_b IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay atleta B de otra escuela'; END IF;

  SELECT p.id INTO v_x
    FROM public.profiles p
    JOIN auth.users au ON au.id = p.id
   WHERE NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.profile_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff s WHERE s.coach_auth_id = p.id OR lower(s.email) = lower(au.email))
     AND NOT EXISTS (SELECT 1 FROM public.enrollments e WHERE e.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.schools s WHERE s.owner_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.events ev WHERE ev.creator_id = p.id)
   LIMIT 1;
  IF v_x IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay usuario X sin relación'; END IF;

  SELECT ev.creator_id, ev.id INTO v_o, v_evento_o
    FROM public.events ev
   WHERE ev.creator_role = 'organizer'
     AND NOT EXISTS (SELECT 1 FROM public.event_organizers eo WHERE eo.profile_id = ev.creator_id)
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = ev.creator_id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = ev.creator_id)
   LIMIT 1;
  IF v_o IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay organizador O con evento y sin perfil de organizador'; END IF;

  SELECT tsp.id INTO v_tsp_ajeno
    FROM public.trainer_session_plans tsp
   WHERE tsp.client_id IS DISTINCT FROM v_a
   LIMIT 1;
  IF v_tsp_ajeno IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay trainer_session_plans ajeno'; END IF;

  -- ── Estructura ─────────────────────────────────────────────────────────────
  -- E1: ninguna policy FOR ALL / UPDATE sin WITH CHECK en las 8 tablas
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('event_organizers','athlete_training_plans','biomech_access_grants','skill_biomech_evidence',
                       'events','biomech_captures','biomech_baselines','biomech_analyses')
     AND cmd IN ('ALL','UPDATE') AND with_check IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA E1: quedan % policies ALL/UPDATE sin WITH CHECK', v_n; END IF;
  v_ok := v_ok + 1;

  -- E2: las policies abiertas ya no existen
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('organizer_manage_own_profile','atp_trainer_all','bag_athlete_all','sbe_adder_all',
                        'events_all_access','bc_athlete_all','bb_athlete_all');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA E2: siguen vivas % policies abiertas', v_n; END IF;
  v_ok := v_ok + 1;

  -- E3: anon sin ningún privilegio en las 4 tablas
  IF has_table_privilege('anon', 'public.event_organizers',       'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('anon', 'public.athlete_training_plans', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('anon', 'public.biomech_access_grants',  'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('anon', 'public.skill_biomech_evidence', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'FALLA E3: anon conserva privilegios en alguna de las 4 tablas';
  END IF;
  v_ok := v_ok + 1;

  -- E4: anon sin escritura en events / captures / baselines; SÍ lee events (mapa público)
  IF has_table_privilege('anon', 'public.events',            'INSERT,UPDATE,DELETE')
  OR has_table_privilege('anon', 'public.biomech_captures',  'INSERT,UPDATE,DELETE')
  OR has_table_privilege('anon', 'public.biomech_baselines', 'INSERT,UPDATE,DELETE')
  OR NOT has_table_privilege('anon', 'public.events', 'SELECT') THEN
    RAISE EXCEPTION 'FALLA E4: privilegios de anon en events/biomech_* no quedaron como se esperaba';
  END IF;
  v_ok := v_ok + 1;

  -- E5: authenticated sin escritura en event_organizers ni skill_biomech_evidence; sí lee
  IF has_table_privilege('authenticated', 'public.event_organizers',       'INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated', 'public.skill_biomech_evidence', 'INSERT,UPDATE,DELETE')
  OR NOT has_table_privilege('authenticated', 'public.event_organizers', 'SELECT')
  OR NOT has_table_privilege('authenticated', 'public.skill_biomech_evidence', 'SELECT') THEN
    RAISE EXCEPTION 'FALLA E5: privilegios de authenticated en event_organizers/skill_biomech_evidence';
  END IF;
  v_ok := v_ok + 1;

  -- E6: get_trainer_athlete_ids sin EXECUTE para anon ni PUBLIC; authenticated sí
  IF has_function_privilege('anon', 'public.get_trainer_athlete_ids(uuid)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.get_trainer_athlete_ids(uuid)', 'EXECUTE')
  OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.get_trainer_athlete_ids(uuid)'::regprocedure
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA E6: EXECUTE de get_trainer_athlete_ids (anon/PUBLIC NO, authenticated SÍ)';
  END IF;
  v_ok := v_ok + 1;

  -- E7: funciones nuevas — anon NO, authenticated SÍ (salvo el trigger: nadie)
  IF has_function_privilege('anon', 'public.es_staff_de_escuela(uuid,uuid)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.verificar_organizador(uuid,boolean)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.es_miembro_o_inscrito_de_escuela(uuid)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.puede_registrar_captura_biomecanica(uuid,uuid)', 'EXECUTE')
  OR has_function_privilege('authenticated', 'public.guard_event_organizers_verificacion()', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.es_staff_de_escuela(uuid,uuid)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.verificar_organizador(uuid,boolean)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.es_miembro_o_inscrito_de_escuela(uuid)', 'EXECUTE')
  OR NOT has_function_privilege('authenticated', 'public.puede_registrar_captura_biomecanica(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA E7: permisos de EXECUTE de las funciones nuevas';
  END IF;
  v_ok := v_ok + 1;

  -- E8: los tres lectores del coach exigen staff vigente; trigger de guarda vivo
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND policyname IN ('bc_coach_read','ba_coach_read','bb_coach_read')
     AND qual LIKE '%user_staff_school_ids%';
  IF v_n <> 3 THEN RAISE EXCEPTION 'FALLA E8: % de 3 lectores del coach exigen staff vigente', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_event_organizers_verificacion'
                    AND tgrelid = 'public.event_organizers'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'FALLA E8: falta el trigger de guarda de is_verified';
  END IF;
  v_ok := v_ok + 1;

  -- ── anon ───────────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  SET LOCAL ROLE anon;
  -- T1: anon NO puede enumerar atletas de una escuela
  BEGIN
    PERFORM public.get_trainer_athlete_ids(v_s);
    RAISE EXCEPTION 'FALLA T1: anon ejecutó get_trainer_athlete_ids';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T2: anon NO lee event_organizers
  BEGIN
    PERFORM count(*) FROM public.event_organizers;
    RAISE EXCEPTION 'FALLA T2: anon leyó event_organizers';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T3: anon sigue leyendo eventos públicos (EventsMapPage / EventPublicPage)
  PERFORM count(*) FROM public.events WHERE status = 'active' AND visibility = 'public';
  v_ok := v_ok + 1;
  RESET ROLE;

  -- ── event_organizers ──────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T4: O se crea perfil autoverificado directo → NO
  BEGIN
    INSERT INTO public.event_organizers (profile_id, organization_name, is_verified) VALUES (v_o, 'prueba', true);
    RAISE EXCEPTION 'FALLA T4: el organizador insertó su perfil directo';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- Preparación (como postgres, = BFF): perfil de O sin verificar
  INSERT INTO public.event_organizers (profile_id, organization_name) VALUES (v_o, 'prueba verificación');

  SET LOCAL ROLE authenticated;
  -- T5: O se autoverifica por UPDATE → NO
  BEGIN
    UPDATE public.event_organizers SET is_verified = true WHERE profile_id = v_o;
    RAISE EXCEPTION 'FALLA T5: el organizador se autoverificó';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T6: O lee su perfil (OrganizerGuard / Settings / Profile)
  SELECT count(*) INTO v_n FROM public.event_organizers WHERE profile_id = v_o;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T6: el organizador no lee su perfil (%)', v_n; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T7: X no ve el perfil de O
  SELECT count(*) INTO v_n FROM public.event_organizers WHERE profile_id = v_o;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA T7: un tercero ve el perfil del organizador'; END IF;
  v_ok := v_ok + 1;
  -- T8: X no puede verificar a nadie
  BEGIN
    PERFORM public.verificar_organizador(v_o);
    RAISE EXCEPTION 'FALLA T8: un tercero verificó a un organizador';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── events ────────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T9: O NO verificado inserta un evento activo directo → NO
  BEGIN
    INSERT INTO public.events (slug, creator_id, creator_role, title, sport, event_date, start_time, address, city, status, visibility)
    VALUES ('verif-' || gen_random_uuid(), v_o, 'organizer', 'x', 'futbol', current_date + 30, '10:00', 'x', 'x', 'active', 'public');
    RAISE EXCEPTION 'FALLA T9: organizador sin verificar insertó un evento directo';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T10: O sigue abriendo/cerrando inscripciones de SU evento (EventManagementPage)
  UPDATE public.events SET registrations_open = NOT coalesce(registrations_open, false) WHERE id = v_evento_o;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T10: el creador no pudo actualizar su evento (%)', v_n; END IF;
  v_ok := v_ok + 1;
  -- T11: O regala su evento a otro creador → NO (WITH CHECK)
  BEGIN
    UPDATE public.events SET creator_id = v_x WHERE id = v_evento_o;
    RAISE EXCEPTION 'FALLA T11: el creador re-apuntó creator_id';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T12: X no toca el evento de O
  UPDATE public.events SET title = 'hackeado' WHERE id = v_evento_o;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA T12: un tercero editó el evento ajeno'; END IF;
  v_ok := v_ok + 1;
  -- T13: X tampoco borra el evento de O
  DELETE FROM public.events WHERE id = v_evento_o;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA T13: un tercero borró el evento ajeno'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  -- T14: plataforma (claim app_metadata.platform_admin) verifica a O por la RPC
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_x, 'role','authenticated', 'app_metadata', json_build_object('platform_admin', true))::text, true);
  SET LOCAL ROLE authenticated;
  v_b1 := public.verificar_organizador(v_o);
  RESET ROLE;
  SELECT is_verified INTO v_b1 FROM public.event_organizers WHERE profile_id = v_o;
  IF v_b1 IS NOT TRUE THEN RAISE EXCEPTION 'FALLA T14: la plataforma no pudo verificar'; END IF;
  v_ok := v_ok + 1;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T15: O ya verificado SÍ inserta su evento
  INSERT INTO public.events (slug, creator_id, creator_role, title, sport, event_date, start_time, address, city, status, visibility)
  VALUES ('verif-' || gen_random_uuid(), v_o, 'organizer', 'x', 'futbol', current_date + 30, '10:00', 'x', 'x', 'draft', 'public');
  v_ok := v_ok + 1;
  -- T16: aun verificado, no inserta a nombre de otro creador
  BEGIN
    INSERT INTO public.events (slug, creator_id, creator_role, title, sport, event_date, start_time, address, city, status, visibility)
    VALUES ('verif-' || gen_random_uuid(), v_x, 'organizer', 'x', 'futbol', current_date + 30, '10:00', 'x', 'x', 'draft', 'public');
    RAISE EXCEPTION 'FALLA T16: insertó un evento a nombre de otro';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── athlete_training_plans ────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T17: X crea plan para el atleta A → NO
  BEGIN
    INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, client_type, title, status)
    VALUES (v_s, v_x, v_a, 'registered', 'x', 'active');
    RAISE EXCEPTION 'FALLA T17: un tercero creó un plan para un atleta';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T18: el coach de S crea plan para A (inscrito en S) → SÍ
  INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, client_type, title, status)
  VALUES (v_s, v_c, v_a, 'registered', 'x', 'active')
  RETURNING id INTO v_plan;
  v_ok := v_ok + 1;
  -- T19: el coach crea plan para B (NO inscrito en S) → NO
  BEGIN
    INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, client_type, title, status)
    VALUES (v_s, v_c, v_b, 'registered', 'x', 'active');
    RAISE EXCEPTION 'FALLA T19: plan para un atleta no inscrito en la escuela';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T20: el coach mueve el plan a B → NO (WITH CHECK)
  BEGIN
    UPDATE public.athlete_training_plans SET client_id = v_b WHERE id = v_plan;
    RAISE EXCEPTION 'FALLA T20: el coach re-apuntó client_id';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T21: el coach edita su plan sin moverlo → SÍ
  UPDATE public.athlete_training_plans SET title = 'y' WHERE id = v_plan;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T21: el coach no pudo editar su plan'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T22: el atleta ve su plan activo (atp_client_select)
  SELECT count(*) INTO v_n FROM public.athlete_training_plans WHERE id = v_plan;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T22: el atleta no ve su plan'; END IF;
  v_ok := v_ok + 1;
  -- T23: el atleta (miembro, no staff) se crea un plan como entrenador → NO
  BEGIN
    INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, client_type, title, status)
    VALUES (v_s, v_a, v_a, 'registered', 'x', 'active');
    RAISE EXCEPTION 'FALLA T23: un atleta creó un plan como entrenador';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ad, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T24: la administración de S ve el plan del coach
  SELECT count(*) INTO v_n FROM public.athlete_training_plans WHERE id = v_plan;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T24: el admin no ve el plan'; END IF;
  v_ok := v_ok + 1;
  -- T25: el admin NO crea planes a nombre del coach (D2.4)
  BEGIN
    INSERT INTO public.athlete_training_plans (school_id, trainer_id, client_id, client_type, title, status)
    VALUES (v_s, v_c, v_a, 'registered', 'x', 'active');
    RAISE EXCEPTION 'FALLA T25: el admin creó un plan a nombre del coach';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T26: el admin SÍ borra el plan
  DELETE FROM public.athlete_training_plans WHERE id = v_plan;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T26: el admin no pudo borrar el plan'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  -- ── biomech_access_grants ─────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T27: A da acceso a C (staff de su escuela S) → SÍ
  INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES (v_a, v_c, v_s);
  v_ok := v_ok + 1;
  -- T28: A da acceso a X (no es staff) → NO
  BEGIN
    INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES (v_a, v_x, v_s);
    RAISE EXCEPTION 'FALLA T28: grant a alguien que no es staff';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T29: A da acceso a C en una escuela S2 que no es suya → NO
  BEGIN
    INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES (v_a, v_c, v_s2);
    RAISE EXCEPTION 'FALLA T29: grant en una escuela ajena';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T30: A re-apunta el grant a X → NO (WITH CHECK)
  BEGIN
    UPDATE public.biomech_access_grants SET coach_id = v_x WHERE athlete_id = v_a AND coach_id = v_c;
    RAISE EXCEPTION 'FALLA T30: el atleta re-apuntó el grant';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T31: A desactiva su grant → SÍ
  UPDATE public.biomech_access_grants SET is_active = false WHERE athlete_id = v_a AND coach_id = v_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T31: el atleta no pudo desactivar su grant'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T32: X se da acceso a los datos de A → NO
  BEGIN
    INSERT INTO public.biomech_access_grants (athlete_id, coach_id, school_id) VALUES (v_a, v_x, v_s);
    RAISE EXCEPTION 'FALLA T32: un tercero creó un grant con athlete_id ajeno';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── Lectura del coach con grant: solo mientras sea staff de la escuela ────
  -- Preparación (como postgres): grant activo + línea base de A
  UPDATE public.biomech_access_grants SET is_active = true WHERE athlete_id = v_a AND coach_id = v_c AND school_id = v_s;
  INSERT INTO public.biomech_baselines (athlete_id) VALUES (v_a);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T33: C (staff de S) con grant en S ve la línea base de A
  SELECT count(*) INTO v_n FROM public.biomech_baselines WHERE athlete_id = v_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T33: el coach con grant vigente no ve la línea base'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  UPDATE public.biomech_access_grants SET school_id = v_s2 WHERE athlete_id = v_a AND coach_id = v_c;
  SET LOCAL ROLE authenticated;
  -- T34: grant apuntado a una escuela donde C NO trabaja → ya no abre nada
  SELECT count(*) INTO v_n FROM public.biomech_baselines WHERE athlete_id = v_a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA T34: un grant de escuela ajena abrió la línea base'; END IF;
  v_ok := v_ok + 1;
  -- T35: C no vincula evidencia directo (solo el BFF)
  BEGIN
    INSERT INTO public.skill_biomech_evidence (academic_progress_id, capture_id, added_by)
    VALUES (gen_random_uuid(), gen_random_uuid(), v_c);
    RAISE EXCEPTION 'FALLA T35: el cliente insertó evidencia biomecánica';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── biomech_captures / biomech_baselines del atleta ──────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- T36: A registra una captura propia en su escuela, sin sesión → SÍ
  INSERT INTO public.biomech_captures (athlete_id, school_id, source) VALUES (v_a, v_s, 'voluntary')
  RETURNING id INTO v_cap;
  v_ok := v_ok + 1;
  -- T37: A registra captura en escuela ajena → NO
  BEGIN
    INSERT INTO public.biomech_captures (athlete_id, school_id, source) VALUES (v_a, v_s2, 'voluntary');
    RAISE EXCEPTION 'FALLA T37: captura en escuela ajena';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T38: A cuelga su captura de una sesión que no es suya → NO
  BEGIN
    INSERT INTO public.biomech_captures (athlete_id, school_id, session_plan_id) VALUES (v_a, v_s, v_tsp_ajeno);
    RAISE EXCEPTION 'FALLA T38: captura colgada de una sesión ajena';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- T39: A mueve su captura a escuela ajena → NO; cambiar su estado → SÍ
  BEGIN
    UPDATE public.biomech_captures SET school_id = v_s2 WHERE id = v_cap;
    RAISE EXCEPTION 'FALLA T39: el atleta movió su captura a otra escuela';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.biomech_captures SET status = 'failed' WHERE id = v_cap;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T39: el atleta no pudo actualizar su captura'; END IF;
  v_ok := v_ok + 1;
  -- T40: A regala su línea base a X → NO; editarla → SÍ
  BEGIN
    UPDATE public.biomech_baselines SET athlete_id = v_x WHERE athlete_id = v_a;
    RAISE EXCEPTION 'FALLA T40: el atleta movió su línea base a otro perfil';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.biomech_baselines (athlete_id) VALUES (v_x);
    RAISE EXCEPTION 'FALLA T40: el atleta creó una línea base ajena';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.biomech_baselines SET assessment_count = assessment_count + 1 WHERE athlete_id = v_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA T40: el atleta no pudo actualizar su línea base'; END IF;
  v_ok := v_ok + 1;
  RESET ROLE;

  -- 8 estructurales (E1..E8) + 40 de sesión (T1..T40)
  IF v_ok <> c_total THEN
    RAISE EXCEPTION 'INCOMPLETO — %/% pruebas contadas (revisar el script)', v_ok, c_total;
  END IF;
  RAISE EXCEPTION 'RESULTADO — %/% pruebas OK (se deshace a propósito)', v_ok, c_total;
END
$$;
