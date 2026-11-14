-- ============================================================
-- SMOKE TEST — Seguridad del cobro por WhatsApp / comprobantes
--   20261007163132 (límite de OCR), 20261007163134 (monto del servidor),
--   20261007163135 (revinculación con código por correo).
-- NO es una migración. Correr con psql tras aplicar las tres:
--   psql "$DATABASE_URL" \
--     -v integration_id="'<school_whatsapp_integrations.id de una escuela de PRUEBA>'" \
--     -v parent_viejo="'<profiles.id con un hijo ACTIVO en esa escuela>'" \
--     -v parent_nuevo="'<OTRO profiles.id con hijo ACTIVO en esa escuela y correo>'" \
--     -v child_nuevo="'<children.id activo del parent_nuevo en esa escuela, con tarifa>'" \
--     -f supabase/migrations/_smoke/seguridad_cobro_wa_smoke.sql
-- Todo en una transacción con ROLLBACK final. Usar una escuela de prueba.
-- No cubre: concurrencia real entre dos sesiones (el candado por escuela de
-- wa_reservar_cupo_ocr se prueba con dos psql en paralelo, a mano).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _p (integration_id uuid, school_id uuid, parent_viejo uuid, parent_nuevo uuid, child_nuevo uuid);
INSERT INTO _p SELECT :integration_id, i.school_id, :parent_viejo, :parent_nuevo, :child_nuevo
FROM public.school_whatsapp_integrations i WHERE i.id = :integration_id;
GRANT SELECT ON _p TO authenticated;

-- ── 0. Permisos ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  f text;
  solo_servicio text[] := ARRAY[
    'public.wa_reservar_cupo_ocr(uuid)',
    'public.wa_iniciar_revinculacion(uuid,text,text,timestamp with time zone)',
    'public.wa_identify_by_phone(uuid,text)',
    'public.auto_approve_payment(uuid)'];
BEGIN
  FOREACH f IN ARRAY solo_servicio LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL grants: % abierta a anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL grants: service_role sin EXECUTE en %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.payments_montos_mensualidad_validos(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.payments_montos_mensualidad_validos(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL grants: payments_montos_mensualidad_validos';
  END IF;
  IF has_table_privilege('authenticated', 'public.wa_ocr_cupos', 'SELECT')
     OR has_table_privilege('anon', 'public.wa_ocr_cupos', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL grants: wa_ocr_cupos abierta';
  END IF;
  RAISE NOTICE 'OK 0 permisos';
END $$;

-- ── 1. Límite de OCR: tope 2 por número en 60 min ──────────────────────────
UPDATE public.whatsapp_settings SET limite_comprobantes_por_numero = 2, limite_comprobantes_ventana_min = 60
 WHERE integration_id = (SELECT integration_id FROM _p);

DO $$
DECLARE
  v_p _p%ROWTYPE;
  v_q uuid;
  ids uuid[] := ARRAY[]::uuid[];
  i int;
  r jsonb;
BEGIN
  SELECT * INTO v_p FROM _p;
  FOR i IN 1..3 LOOP
    INSERT INTO public.whatsapp_inbound_queue (school_id, integration_id, wa_phone_number, wa_message_id, message_type)
    VALUES (v_p.school_id, v_p.integration_id, '573009998877', 'smoke-cupo-' || i || '-' || gen_random_uuid(), 'image')
    RETURNING id INTO v_q;
    ids := ids || v_q;
  END LOOP;

  r := public.wa_reservar_cupo_ocr(ids[1]);
  IF (r->>'permitido')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL 1a: el primero debía pasar: %', r; END IF;
  r := public.wa_reservar_cupo_ocr(ids[2]);
  IF (r->>'permitido')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL 1b: el segundo debía pasar: %', r; END IF;
  r := public.wa_reservar_cupo_ocr(ids[3]);
  IF (r->>'permitido')::boolean OR r->>'motivo' <> 'limite_numero' THEN RAISE EXCEPTION 'FAIL 1c: el tercero debía frenarse: %', r; END IF;
  -- Reintento de una fila ya permitida: misma decisión, sin consumir otro cupo.
  r := public.wa_reservar_cupo_ocr(ids[1]);
  IF (r->>'permitido')::boolean IS NOT TRUE OR (r->>'repetido')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAIL 1d: idempotencia: %', r; END IF;
  IF (SELECT count(*) FROM public.wa_ocr_cupos WHERE queue_id = ANY (ids)) <> 3 THEN RAISE EXCEPTION 'FAIL 1e: filas de cupo'; END IF;
  RAISE NOTICE 'OK 1 límite de OCR';
END $$;

-- ── 2. Revinculación con código por correo ──────────────────────────────────
DO $$
DECLARE
  v_p _p%ROWTYPE;
  v_tel text := '573009991122';
  r jsonb;
  v_conv record;
BEGIN
  SELECT * INTO v_p FROM _p;
  UPDATE public.profiles SET phone = '3009991122' WHERE id = v_p.parent_nuevo;
  UPDATE public.profiles SET phone = '3000000001' WHERE id = v_p.parent_viejo;

  INSERT INTO public.whatsapp_conversations (integration_id, school_id, contact_wa_id, parent_id, identified)
  VALUES (v_p.integration_id, v_p.school_id, v_tel, v_p.parent_viejo, true)
  ON CONFLICT DO NOTHING;
  UPDATE public.whatsapp_conversations SET parent_id = v_p.parent_viejo, identified = true
   WHERE integration_id = v_p.integration_id AND contact_wa_id = v_tel;
  DELETE FROM public.whatsapp_identifications WHERE integration_id = v_p.integration_id AND contact_wa_id = v_tel;

  r := public.wa_identify_by_phone(v_p.integration_id, v_tel);
  IF r->>'estado' <> 'revinculacion_pendiente' OR r ? 'parent_id' THEN RAISE EXCEPTION 'FAIL 2a: %', r; END IF;
  SELECT parent_id, identified INTO v_conv FROM public.whatsapp_conversations
   WHERE integration_id = v_p.integration_id AND contact_wa_id = v_tel;
  IF v_conv.parent_id IS NOT NULL OR v_conv.identified THEN RAISE EXCEPTION 'FAIL 2b: la conversación sigue vinculada'; END IF;

  -- Un segundo mensaje NO vincula por teléfono.
  r := public.wa_identify_by_phone(v_p.integration_id, v_tel);
  IF r->>'estado' <> 'revinculacion_pendiente' THEN RAISE EXCEPTION 'FAIL 2c: %', r; END IF;

  r := public.wa_iniciar_revinculacion(v_p.integration_id, v_tel, encode(sha256('482913'::bytea), 'hex'), now() + interval '10 minutes');
  IF (r->>'ok')::boolean IS NOT TRUE OR r->>'email' IS NULL THEN RAISE EXCEPTION 'FAIL 2d (¿parent_nuevo sin correo?): %', r; END IF;
  -- Con un código vigente no se emite otro.
  r := public.wa_iniciar_revinculacion(v_p.integration_id, v_tel, encode(sha256('111111'::bytea), 'hex'), now() + interval '10 minutes');
  IF r->>'motivo' <> 'codigo_vigente' THEN RAISE EXCEPTION 'FAIL 2e: %', r; END IF;

  r := public.wa_verify_otp(v_p.integration_id, v_tel, encode(sha256('000000'::bytea), 'hex'));
  IF (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL 2f: código equivocado aceptado'; END IF;
  r := public.wa_verify_otp(v_p.integration_id, v_tel, encode(sha256('482913'::bytea), 'hex'));
  IF (r->>'ok')::boolean IS NOT TRUE OR (r->>'parent_id')::uuid <> v_p.parent_nuevo THEN RAISE EXCEPTION 'FAIL 2g: %', r; END IF;

  r := public.wa_identify_by_phone(v_p.integration_id, v_tel);
  IF r->>'estado' <> 'identificado' OR (r->>'parent_id')::uuid <> v_p.parent_nuevo THEN RAISE EXCEPTION 'FAIL 2h: %', r; END IF;
  RAISE NOTICE 'OK 2 revinculación';
END $$;

-- ── 3. Monto del servidor (como el acudiente, por PostgREST) ────────────────
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT parent_nuevo FROM _p), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  v_p _p%ROWTYPE;
  v_validos numeric[];
  v_id uuid;
  v_src text;
BEGIN
  SELECT * INTO v_p FROM _p;
  v_validos := public.payments_montos_mensualidad_validos(v_p.school_id, v_p.child_nuevo, NULL);
  IF coalesce(cardinality(v_validos), 0) = 0 THEN RAISE EXCEPTION 'FAIL 3a: child_nuevo sin tarifa (elegir otro)'; END IF;

  BEGIN
    INSERT INTO public.payments (parent_id, child_id, school_id, amount, concept, status, payment_type, due_date, payment_category, period_uniqueness_exempt)
    VALUES (v_p.parent_nuevo, v_p.child_nuevo, v_p.school_id, 1, 'Mensualidad smoke', 'pending', 'one_time', current_date, 'mensualidad', true);
    RAISE EXCEPTION 'FAIL 3b: mensualidad de $1 aceptada';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'PAYMENT_AMOUNT_MISMATCH%' THEN RAISE; END IF;
  END;

  INSERT INTO public.payments (parent_id, child_id, school_id, amount, concept, status, payment_type, due_date, payment_category, period_uniqueness_exempt)
  VALUES (v_p.parent_nuevo, v_p.child_nuevo, v_p.school_id, v_validos[1], 'Mensualidad smoke', 'pending', 'one_time', current_date, 'mensualidad', true)
  RETURNING id, amount_source INTO v_id, v_src;
  IF v_src <> 'servidor' THEN RAISE EXCEPTION 'FAIL 3c: %', v_src; END IF;

  INSERT INTO public.payments (parent_id, child_id, school_id, amount, concept, status, payment_type, due_date, payment_category, period_uniqueness_exempt)
  VALUES (v_p.parent_nuevo, v_p.child_nuevo, v_p.school_id, 1, 'Pago / Abono', 'pending', 'one_time', current_date, 'otro', true)
  RETURNING id, amount_source INTO v_id, v_src;
  IF v_src <> 'cliente' THEN RAISE EXCEPTION 'FAIL 3d: abono no quedó cliente: %', v_src; END IF;

  BEGIN
    UPDATE public.payments SET amount_source = 'servidor' WHERE id = v_id;
    RAISE EXCEPTION 'FAIL 3e: el acudiente cambió amount_source';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'OK 3 monto del servidor';
END $$;

RESET ROLE;

-- auto_approve_payment no aprueba un monto del cliente.
DO $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.payments WHERE concept = 'Pago / Abono' AND amount = 1 AND amount_source = 'cliente'
   AND parent_id = (SELECT parent_nuevo FROM _p) ORDER BY created_at DESC LIMIT 1;
  UPDATE public.payments SET status = 'awaiting_approval' WHERE id = v_id;
  IF public.auto_approve_payment(v_id) THEN RAISE EXCEPTION 'FAIL 3f: auto-aprobó un monto del cliente'; END IF;
  RAISE NOTICE 'OK 3f auto_approve';
END $$;

ROLLBACK;
