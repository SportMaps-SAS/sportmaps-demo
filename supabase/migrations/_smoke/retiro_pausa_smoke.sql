-- =============================================================================
-- retiro_pausa_smoke.sql — pruebas T1-T8 de 20261106160004_retiro_y_pausa_por_canales
--
-- Se corre DESPUÉS de aplicar la migración, con psql o `supabase db query -f`, y
-- SIEMPRE termina en ROLLBACK: no deja nada. Escoge una inscripción de menor real
-- (con acudiente) y le prende la pausa DENTRO de la transacción.
-- NUNCA se ha ejecutado (la migración no estaba aplicada al escribirlo). Si falla
-- una aserción, el DO aborta con "SMOKE Tn FALLÓ: ...".
-- No usa tablas TEMP (el SQL editor de Supabase no las soporta).
-- =============================================================================
BEGIN;

DO $smoke$
DECLARE
  v_enr      uuid;  v_school uuid;  v_child uuid;  v_parent uuid;  v_admin uuid;  v_otro uuid;
  v_m1 date := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')) + interval '1 month')::date;
  v_m2 date := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')) + interval '2 month')::date;
  v_m3 date := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')) + interval '3 month')::date;
  v_m4 date := (date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')) + interval '4 month')::date;
  v_hoy date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date;
  r jsonb; v_id uuid; v_n int; v_estado text; v_err text;
  v_pay_ant uuid; v_pay_fut uuid;
BEGIN
  -- ── Fixture: inscripción activa de menor, sin pausas ni retiros, con acudiente
  SELECT e.id, e.school_id, e.child_id, c.parent_id
    INTO v_enr, v_school, v_child, v_parent
  FROM public.enrollments e JOIN public.children c ON c.id = e.child_id
  WHERE e.status = 'active' AND e.paused_reason IS NULL
    AND (e.team_id IS NOT NULL OR e.offering_plan_id IS NOT NULL)
    AND c.parent_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.enrollment_pause_requests r WHERE r.enrollment_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM public.enrollments o WHERE o.child_id = e.child_id AND o.id <> e.id AND o.status = 'active')
    AND EXISTS (SELECT 1 FROM public.school_settings ss WHERE ss.school_id = e.school_id)
  LIMIT 1;
  IF v_enr IS NULL THEN RAISE EXCEPTION 'SMOKE: no hay inscripción candidata'; END IF;

  SELECT sm.profile_id INTO v_admin FROM public.school_members sm
   WHERE sm.school_id = v_school AND sm.status = 'active' AND sm.role IN ('owner','admin','school_admin') LIMIT 1;
  IF v_admin IS NULL THEN SELECT s.owner_id INTO v_admin FROM public.schools s WHERE s.id = v_school; END IF;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE: la escuela no tiene administración'; END IF;

  -- Un acudiente de OTRA familia (cualquiera que no sea el de este menor).
  SELECT c2.parent_id INTO v_otro FROM public.children c2
   WHERE c2.parent_id IS NOT NULL AND c2.parent_id <> v_parent AND c2.parent_id <> v_admin LIMIT 1;

  UPDATE public.school_settings
     SET pause_enabled = true, pause_max_months_per_year = 2,
         pause_auto_approve = true, pause_parent_can_request = true
   WHERE school_id = v_school;

  -- Cobros de prueba: uno en m1 (futuro) y uno del mes anterior al m1.
  INSERT INTO public.payments (school_id, child_id, amount, concept, due_date, status,
                               payment_type, payment_category, period_year, period_month)
  VALUES (v_school, v_child, 100000, 'SMOKE m1', v_m1, 'pending', 'subscription', 'mensualidad',
          extract(year from v_m1)::int, extract(month from v_m1)::int)
  RETURNING id INTO v_pay_fut;
  INSERT INTO public.payments (school_id, child_id, amount, concept, due_date, status,
                               payment_type, payment_category, period_year, period_month)
  VALUES (v_school, v_child, 100000, 'SMOKE m4', v_m4, 'pending', 'subscription', 'mensualidad',
          extract(year from v_m4)::int, extract(month from v_m4)::int)
  RETURNING id INTO v_pay_ant;

  -- ── Se actúa como el acudiente (JWT simulado, rol authenticated)
  PERFORM set_config('request.jwt.claims',
          json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- T1: pausa de 1 mes dentro del tope -> aprobada sola, cobro anulado.
  r := public.request_enrollment_pause_v2(v_enr, 'vacation', v_m1, v_m1, NULL, 'whatsapp');
  IF r->>'status' <> 'approved' OR NOT (r->>'auto_aprobada')::boolean THEN
    RAISE EXCEPTION 'SMOKE T1 FALLÓ: esperaba approved/auto, obtuve %', r; END IF;
  RESET ROLE;
  SELECT status INTO v_estado FROM public.payments WHERE id = v_pay_fut;
  IF v_estado <> 'cancelled' THEN RAISE EXCEPTION 'SMOKE T1 FALLÓ: el cobro de m1 sigue %', v_estado; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.enrollment_pause_requests
                  WHERE id = (r->>'request_id')::uuid AND channel = 'whatsapp' AND auto_approved
                    AND reviewed_by IS NULL) THEN
    RAISE EXCEPTION 'SMOKE T1 FALLÓ: fila sin canal/auto_approved'; END IF;
  RAISE NOTICE 'T1 OK: pausa dentro del tope se aprobó sola';

  -- T2: 2 meses más con tope=2 (ya usó 1) -> pasa el tope -> pending + fuera_de_tope; admin la aprueba.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.request_enrollment_pause_v2(v_enr, 'other', v_m2, v_m3, 'smoke', 'app');
  IF r->>'status' <> 'pending' OR NOT (r->>'fuera_de_tope')::boolean THEN
    RAISE EXCEPTION 'SMOKE T2 FALLÓ: esperaba pending/fuera_de_tope, obtuve %', r; END IF;
  v_id := (r->>'request_id')::uuid;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.approve_enrollment_pause(v_id, 'smoke');
  RESET ROLE;
  SELECT status INTO v_estado FROM public.enrollment_pause_requests WHERE id = v_id;
  IF v_estado <> 'approved' THEN RAISE EXCEPTION 'SMOKE T2 FALLÓ: el admin no pudo aprobar (%)', v_estado; END IF;
  RAISE NOTICE 'T2 OK: fuera de tope va a la administración y ella puede aprobar';

  -- T3: pause_auto_approve=false -> pending. (Se libera la pausa de m2-m3 con resume para poder pedir otra no solapada.)
  UPDATE public.school_settings SET pause_auto_approve = false, pause_max_months_per_year = 12 WHERE school_id = v_school;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.request_enrollment_pause_v2(v_enr, 'injury', v_m4, v_m4, NULL, 'app');
  IF r->>'status' <> 'pending' OR (r->>'auto_aprobada')::boolean THEN
    RAISE EXCEPTION 'SMOKE T3 FALLÓ: con pause_auto_approve=false debía quedar pending, obtuve %', r; END IF;
  PERFORM public.cancel_enrollment_request('pausa', (r->>'request_id')::uuid);
  RESET ROLE;
  UPDATE public.school_settings SET pause_auto_approve = true WHERE school_id = v_school;
  RAISE NOTICE 'T3 OK: sin autoaprobación todo pasa por la administración (y la familia puede cancelar)';

  -- T4: un acudiente ajeno no puede pedir nada sobre esta inscripción.
  IF v_otro IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_otro, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.request_enrollment_withdrawal(v_enr, v_hoy, 'ajeno', 'app');
      RAISE EXCEPTION 'SMOKE T4 FALLÓ: un ajeno pidió el retiro';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'No autorizado%' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.request_enrollment_pause_v2(v_enr, 'vacation', v_m4, v_m4, NULL, 'app');
      RAISE EXCEPTION 'SMOKE T4 FALLÓ: un ajeno pidió la pausa';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'No autorizado%' THEN RAISE; END IF;
    END;
    RESET ROLE;
  END IF;
  RAISE NOTICE 'T4 OK: ajeno -> No autorizado';

  -- T5: retiro nace 'solicitado', no toca nada; duplicado y fechas fuera de rango fallan.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.request_enrollment_withdrawal(v_enr, v_m4, 'nos mudamos', 'whatsapp');
  IF r->>'status' <> 'solicitado' THEN RAISE EXCEPTION 'SMOKE T5 FALLÓ: %', r; END IF;
  v_id := (r->>'request_id')::uuid;
  BEGIN
    PERFORM public.request_enrollment_withdrawal(v_enr, v_m4, 'otra vez', 'app');
    RAISE EXCEPTION 'SMOKE T5 FALLÓ: se aceptó un segundo retiro abierto';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Ya hay una solicitud de retiro%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  SELECT e.status INTO v_estado FROM public.enrollments e WHERE e.id = v_enr;
  IF v_estado <> 'active' THEN RAISE EXCEPTION 'SMOKE T5 FALLÓ: el retiro se autoaprobó (%)', v_estado; END IF;
  RAISE NOTICE 'T5 OK: retiro solo queda solicitado';

  -- T6: resolver lo hace SOLO la administración, con JWT.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.resolve_enrollment_withdrawal(v_id, 'aprobar');
    RAISE EXCEPTION 'SMOKE T6 FALLÓ: el acudiente resolvió su propio retiro';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'No autorizado%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.resolve_enrollment_withdrawal(v_id, 'aprobar', 'smoke');
  RESET ROLE;
  SELECT e.status INTO v_estado FROM public.enrollments e WHERE e.id = v_enr;
  IF v_estado <> 'cancelled' THEN RAISE EXCEPTION 'SMOKE T6 FALLÓ: la inscripción sigue %', v_estado; END IF;
  SELECT status INTO v_estado FROM public.payments WHERE id = v_pay_ant;
  IF v_estado <> 'cancelled' THEN RAISE EXCEPTION 'SMOKE T6 FALLÓ: el cobro de m4 (>= salida) sigue %', v_estado; END IF;
  RAISE NOTICE 'T6 OK: aprobar retiro cancela la inscripción y los cobros desde la fecha de salida (%)', r;

  -- T7: reactivación de la inscripción retirada.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  r := public.request_enrollment_reactivation(v_enr, v_m4, 'volvemos', 'app');
  v_id := (r->>'request_id')::uuid;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.resolve_enrollment_withdrawal(v_id, 'aprobar');
  RESET ROLE;
  SELECT e.status INTO v_estado FROM public.enrollments e WHERE e.id = v_enr;
  IF v_estado <> 'active' THEN RAISE EXCEPTION 'SMOKE T7 FALLÓ: no se reactivó (%)', v_estado; END IF;
  RAISE NOTICE 'T7 OK: reactivación aprobada';

  -- T8: superficie. anon sin EXECUTE; RLS de la tabla nueva.
  IF has_function_privilege('anon', 'public.request_enrollment_pause_v2(uuid,text,date,date,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.request_enrollment_withdrawal(uuid,date,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.request_enrollment_reactivation(uuid,date,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_enrollment_withdrawal(uuid,text,text,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_enrollment_request(text,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE T8 FALLÓ: anon tiene EXECUTE'; END IF;
  IF has_function_privilege('authenticated', 'public.retiro_actor(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE T8 FALLÓ: un helper privado quedó expuesto'; END IF;

  IF v_otro IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_otro, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.enrollment_withdrawal_requests WHERE enrollment_id = v_enr;
    IF v_n <> 0 THEN RAISE EXCEPTION 'SMOKE T8 FALLÓ: otra familia ve % filas', v_n; END IF;
    BEGIN
      INSERT INTO public.enrollment_withdrawal_requests (school_id, enrollment_id, child_id, kind, effective_date, channel, requester_role)
      VALUES (v_school, v_enr, v_child, 'retiro', v_hoy, 'app', 'parent');
      RAISE EXCEPTION 'SMOKE T8 FALLÓ: INSERT directo permitido';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_parent, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.enrollment_withdrawal_requests WHERE enrollment_id = v_enr;
  IF v_n < 2 THEN RAISE EXCEPTION 'SMOKE T8 FALLÓ: el acudiente no ve sus propias solicitudes (%)', v_n; END IF;
  RESET ROLE;
  RAISE NOTICE 'T8 OK: superficie y RLS';
END
$smoke$;

ROLLBACK;
