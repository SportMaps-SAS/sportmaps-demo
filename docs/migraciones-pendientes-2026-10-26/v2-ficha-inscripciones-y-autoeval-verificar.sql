-- =============================================================================
-- Verificación de 20261026155123_v2_ficha_inscripciones_y_autoeval
-- Correr DESPUÉS de pegar v2-ficha-inscripciones-y-autoeval.sql.
--
-- Un solo bloque DO que termina SIEMPRE en RAISE EXCEPTION, a propósito: todo
-- lo que toca (finalized_at de dos sesiones, las respuestas guardadas) se
-- deshace. Resultado esperado: un error que empieza por
--   «OK — 8/8 pruebas pasaron (se deshace a propósito)»
-- Cualquier otro error = una prueba falló (el mensaje dice cuál).
--
-- Datos reales (lectura del 2026-10-26), no se modifican:
--   Cuenta A 782d1cf7-815d-4de8-8815-1f57a68238af ↔ ficha 0e5aba2c-363d-4a43-ad0e-3551dc27ba87
--     inscripción be97b553-dac6-4d02-9617-687d6f6f3d1d (cancelled)
--     asistió a la sesión 39e7b72f-8a1c-4c8a-8b9e-4f28827f6f9a
--   Cuenta B c4ec1da4-c9ef-4da2-b512-52c31505e164 ↔ ficha fd486d5f-1594-4aa7-954a-af0ec8e5719a
--     inscripción 0797d1a3-3d35-4a88-8934-a796f51909e7 (cancelled)
--     asistió a la sesión 5e3868ed-424a-450b-912e-1c7a73eea7bf
-- =============================================================================
DO $$
DECLARE
  c_cuenta_a  constant uuid := '782d1cf7-815d-4de8-8815-1f57a68238af';
  c_ficha_a   constant uuid := '0e5aba2c-363d-4a43-ad0e-3551dc27ba87';
  c_insc_a    constant uuid := 'be97b553-dac6-4d02-9617-687d6f6f3d1d';
  c_sesion_a  constant uuid := '39e7b72f-8a1c-4c8a-8b9e-4f28827f6f9a';
  c_cuenta_b  constant uuid := 'c4ec1da4-c9ef-4da2-b512-52c31505e164';
  c_ficha_b   constant uuid := 'fd486d5f-1594-4aa7-954a-af0ec8e5719a';
  c_insc_b    constant uuid := '0797d1a3-3d35-4a88-8934-a796f51909e7';
  c_sesion_b  constant uuid := '5e3868ed-424a-450b-912e-1c7a73eea7bf';
  c_resp      constant jsonb := '{"rpe_borg": 5, "task_comprehension": 1, "self_effort_pct": 80, "satisfaction": 2}';
  v_n   int;
  v_res jsonb;
  v_ok  int := 0;
BEGIN
  -- ── Estructura ─────────────────────────────────────────────────────────────
  IF to_regprocedure('public.submit_post_training_self_eval(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'FALLA 1: sigue viva la firma vieja de 4 parámetros';
  END IF;
  IF has_function_privilege('anon', 'public.submit_post_training_self_eval(uuid,uuid,uuid,jsonb,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.submit_post_training_self_eval(uuid,uuid,uuid,jsonb,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA 1: permisos de EXECUTE (anon debe ser NO, authenticated SÍ)';
  END IF;
  v_ok := v_ok + 1;

  -- Preparación (como postgres): las dos sesiones (ya finalized = true) pasan a
  -- "recién cerradas". Solo finalized_at: tocar `finalized` dispararía los
  -- triggers de cierre (descuento de sesiones, avisos post-entreno).
  UPDATE public.attendance_sessions SET finalized_at = now()
   WHERE id IN (c_sesion_a, c_sesion_b) AND finalized IS TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'PREPARACIÓN: esperaba 2 sesiones cerradas, hay %', v_n; END IF;

  -- ── Cuenta A ───────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_cuenta_a, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_n FROM public.enrollments WHERE id = c_insc_a;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA 2: la cuenta A no ve la inscripción de su ficha (ve %)', v_n; END IF;
  v_ok := v_ok + 1;

  SELECT count(*) INTO v_n FROM public.enrollments WHERE id = c_insc_b;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA 3: la cuenta A ve la inscripción de la ficha de B'; END IF;
  v_ok := v_ok + 1;

  RESET ROLE;

  -- ── Cuenta B ───────────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', c_cuenta_b, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_n FROM public.enrollments WHERE id = c_insc_a;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FALLA 4: la cuenta B ve la inscripción de la ficha de A'; END IF;
  v_ok := v_ok + 1;

  -- La ficha B autoevalúa SU sesión.
  v_res := public.submit_post_training_self_eval(
    p_session_id => c_sesion_b, p_answers => c_resp, p_unregistered_athlete_id => c_ficha_b);
  IF (v_res->>'saved')::int <> 4 THEN RAISE EXCEPTION 'FALLA 5: esperaba saved=4, llegó %', v_res; END IF;
  SELECT count(*) INTO v_n FROM public.performance_entries
   WHERE subject_type = 'unregistered' AND subject_id = c_ficha_b
     AND context_type = 'session' AND context_id = c_sesion_b AND metric_key = 'rpe_borg';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA 5: la cuenta B no lee su rpe_borg guardado (%)', v_n; END IF;
  -- Idempotente: repetir no duplica.
  PERFORM public.submit_post_training_self_eval(
    p_session_id => c_sesion_b, p_answers => c_resp, p_unregistered_athlete_id => c_ficha_b);
  SELECT count(*) INTO v_n FROM public.performance_entries
   WHERE subject_type = 'unregistered' AND subject_id = c_ficha_b
     AND context_type = 'session' AND context_id = c_sesion_b AND metric_key = 'rpe_borg';
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA 5: el reenvío duplicó (%)', v_n; END IF;
  v_ok := v_ok + 1;

  -- No puede responder por una ficha ajena.
  BEGIN
    PERFORM public.submit_post_training_self_eval(
      p_session_id => c_sesion_a, p_answers => c_resp, p_unregistered_athlete_id => c_ficha_a);
    RAISE EXCEPTION 'FALLA 6: la cuenta B respondió por la ficha de A' USING ERRCODE = 'P0001';
  EXCEPTION WHEN insufficient_privilege THEN
    v_ok := v_ok + 1;
  END;

  -- Con SU ficha, no puede autoevaluar una sesión a la que la ficha no vino.
  BEGIN
    PERFORM public.submit_post_training_self_eval(
      p_session_id => c_sesion_a, p_answers => c_resp, p_unregistered_athlete_id => c_ficha_b);
    RAISE EXCEPTION 'FALLA 7: la ficha B autoevaluó una sesión ajena' USING ERRCODE = 'P0001';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
    IF SQLERRM NOT LIKE '%no asistió%' THEN RAISE EXCEPTION 'FALLA 7: error inesperado: %', SQLERRM; END IF;
    v_ok := v_ok + 1;
  END;

  -- Exactamente un sujeto.
  BEGIN
    PERFORM public.submit_post_training_self_eval(
      p_session_id => c_sesion_b, p_user_id => c_cuenta_b, p_answers => c_resp, p_unregistered_athlete_id => c_ficha_b);
    RAISE EXCEPTION 'FALLA 8: aceptó dos sujetos a la vez' USING ERRCODE = 'P0001';
  EXCEPTION WHEN invalid_parameter_value THEN
    v_ok := v_ok + 1;
  END;

  RESET ROLE;

  RAISE EXCEPTION 'OK — %/8 pruebas pasaron (se deshace a propósito)', v_ok;
END
$$;
