-- =============================================================================
-- Smoke de 20261106160003_soportes_obligatorios.sql  (BEGIN ... ROLLBACK; no deja nada)
-- NO se ejecuto al escribirlo (el flujo prohibe escribir en la base): correrlo UNA persona, con la migracion ya aplicada.
-- Usa Monster y datos reales solo para LEER; todo lo que escribe se deshace con el ROLLBACK final.
-- Cualquier T que falle lanza una excepcion con su nombre.
-- =============================================================================
BEGIN;

DO $$
DECLARE
  v_school  uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
  v_admin   uuid;
  v_coach   uuid;
  v_otro    uuid;   -- admin de OTRA escuela
  v_ua      uuid;   -- una ficha activa sin cuenta de Monster y sin documentos
  v_n       int;
  v_msg     text;
  v_uid     text;
  v_miss    text[];
  v_json    jsonb;
  v_tipos   text[] := ARRAY['athlete_photo','eps_certificate','guardian_id_front','athlete_id_front',
                            'guardian_signature','athlete_signature','good_standing_certificate'];
  t         text;
BEGIN
  SELECT owner_id INTO v_admin FROM public.schools WHERE id = v_school;
  SELECT sm.profile_id INTO v_coach FROM public.school_members sm
   WHERE sm.school_id = v_school AND sm.role = 'coach' AND sm.status = 'active' LIMIT 1;
  SELECT s.owner_id INTO v_otro FROM public.schools s WHERE s.id <> v_school AND s.owner_id <> v_admin LIMIT 1;
  SELECT ua.id INTO v_ua FROM public.unregistered_athletes ua
   WHERE ua.school_id = v_school AND ua.is_active AND ua.linked_profile_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.athlete_documents d WHERE d.unregistered_athlete_id = ua.id)
   LIMIT 1;
  IF v_ua IS NULL THEN RAISE EXCEPTION 'smoke: no hay ficha de Monster sin documentos para probar'; END IF;

  -- T1: flag apagado (estado de origen): 0 filas, completo=true, _soportes_exigir no lanza.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.athlete_documents_status(v_school);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T1 fallo: con el flag apagado debia haber 0 filas y hay %', v_n; END IF;
  v_json := public.soportes_verificar_sujeto(v_school, 'unregistered', v_ua);
  IF (v_json->>'activo')::boolean OR NOT (v_json->>'completo')::boolean THEN
    RAISE EXCEPTION 'T1 fallo: verificar_sujeto con flag apagado = %', v_json;
  END IF;
  RESET ROLE;
  PERFORM public._soportes_exigir(v_school, 'unregistered', v_ua);   -- no debe lanzar

  -- Se prende SOLO dentro de la transaccion (ROLLBACK al final).
  UPDATE public.school_settings SET require_athlete_documents = true, required_document_types = v_tipos
   WHERE school_id = v_school;

  -- T2: 6 de 7 -> falta exactamente 1.
  FOREACH t IN ARRAY v_tipos[1:6] LOOP
    INSERT INTO public.athlete_documents (school_id, unregistered_athlete_id, document_type, storage_path)
    VALUES (v_school, v_ua, t, 'unregistered_athletes/' || v_ua || '/docs/' || t || '-smoke.pdf');
  END LOOP;
  SELECT e.missing INTO v_miss FROM public.soportes_estado_interno(v_school, 'unregistered', v_ua) e;
  IF v_miss IS DISTINCT FROM ARRAY['good_standing_certificate'] THEN
    RAISE EXCEPTION 'T2 fallo: missing = %', v_miss;
  END IF;

  -- T4: con faltantes, _soportes_exigir lanza SP001 con mensaje SOPORTES_INCOMPLETOS.
  BEGIN
    PERFORM public._soportes_exigir(v_school, 'unregistered', v_ua);
    RAISE EXCEPTION 'T4 fallo: no lanzo con faltantes';
  EXCEPTION WHEN SQLSTATE 'SP001' THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'SOPORTES_INCOMPLETOS:%' THEN RAISE EXCEPTION 'T4 fallo: mensaje %', v_msg; END IF;
  END;

  -- T3: con los 7 -> completo y no lanza.
  INSERT INTO public.athlete_documents (school_id, unregistered_athlete_id, document_type, storage_path)
  VALUES (v_school, v_ua, 'good_standing_certificate', 'unregistered_athletes/' || v_ua || '/docs/good_standing_certificate-smoke.pdf');
  IF NOT (SELECT e.complete FROM public.soportes_estado_interno(v_school, 'unregistered', v_ua) e) THEN
    RAISE EXCEPTION 'T3 fallo: con los 7 debia estar completo';
  END IF;
  PERFORM public._soportes_exigir(v_school, 'unregistered', v_ua);

  -- T5: coach y admin de otra escuela -> 42501; anon sin EXECUTE; internas solo service_role.
  FOR v_uid IN SELECT x FROM unnest(ARRAY[v_coach::text, v_otro::text]) AS x WHERE x IS NOT NULL LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM * FROM public.athlete_documents_status(v_school);
      RESET ROLE;
      RAISE EXCEPTION 'T5 fallo: % pudo leer el estado', v_uid;
    EXCEPTION WHEN insufficient_privilege THEN
      RESET ROLE;
    END;
  END LOOP;
  IF has_function_privilege('anon', 'public.athlete_documents_status(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.soportes_estado_interno(uuid,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.soportes_reclamar_avisos(uuid,jsonb,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'T5 fallo: grants de mas';
  END IF;

  -- T6: tope de recordatorios (cada 4 dias, maximo 6).
  SELECT count(*) INTO v_n FROM public.soportes_reclamar_avisos(v_school,
    jsonb_build_array(jsonb_build_object('subject_type','unregistered','subject_id',v_ua)));
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 fallo: la 1.a llamada debia reclamar (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.soportes_reclamar_avisos(v_school,
    jsonb_build_array(jsonb_build_object('subject_type','unregistered','subject_id',v_ua)));
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 fallo: la 2.a inmediata no debia reclamar (%)', v_n; END IF;
  UPDATE public.soportes_recordatorios SET last_sent_at = now() - interval '5 days'
   WHERE school_id = v_school AND subject_id = v_ua;
  SELECT count(*) INTO v_n FROM public.soportes_reclamar_avisos(v_school,
    jsonb_build_array(jsonb_build_object('subject_type','unregistered','subject_id',v_ua)));
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 fallo: a los 5 dias debia reclamar (%)', v_n; END IF;
  UPDATE public.soportes_recordatorios SET last_sent_at = now() - interval '5 days', sent_count = 6
   WHERE school_id = v_school AND subject_id = v_ua;
  SELECT count(*) INTO v_n FROM public.soportes_reclamar_avisos(v_school,
    jsonb_build_array(jsonb_build_object('subject_type','unregistered','subject_id',v_ua)));
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 fallo: con 6 avisos no debia reclamar mas (%)', v_n; END IF;

  RAISE NOTICE 'soportes_smoke: T1..T6 OK (se deshace con ROLLBACK)';
END $$;

ROLLBACK;
