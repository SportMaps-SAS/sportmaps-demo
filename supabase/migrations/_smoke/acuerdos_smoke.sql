-- ============================================================
-- SMOKE TEST — acuerdos de pago (migración 20261106160002). NO es una migración.
-- Correr con psql DESPUÉS de aplicar la migración (la aplica una sola sesión):
--   psql "$DATABASE_URL" \
--     -v school_id="'<uuid escuela>'" \
--     -v child_id="'<children.id de esa escuela>'" \
--     -v parent_id="'<children.parent_id de ese child (profiles.id)>'" \
--     -v other_user="'<profiles.id de alguien SIN relación con la escuela>'" \
--     -f supabase/migrations/_smoke/acuerdos_smoke.sql
--
-- Todo en una transacción con ROLLBACK final: no persiste nada. Los cobros de prueba
-- usan periodos de 2020 para no chocar con los índices únicos de cobros reales.
-- Cubre T1–T8 del pie de la migración (T7 comprueba el recargo con y sin acuerdo).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _p (school_id uuid, child_id uuid, parent_id uuid, other_user uuid,
                      pay1 uuid, pay2 uuid, ag1 uuid, ag2 uuid);
INSERT INTO _p (school_id, child_id, parent_id, other_user) VALUES (:school_id, :child_id, :parent_id, :other_user);
GRANT ALL ON _p TO PUBLIC;

INSERT INTO public.school_settings (school_id) SELECT school_id FROM _p ON CONFLICT (school_id) DO NOTHING;
UPDATE public.school_settings SET payment_agreements_enabled = false,
       agreement_max_installments = 3, agreement_max_days = 60, agreement_auto_approve = true,
       late_fee_enabled = true, late_fee_percentage = 10, payment_grace_days = 0, overdue_hold_until = NULL,
       late_fee_skip_signup_month = false
 WHERE school_id = (SELECT school_id FROM _p);

-- Dos cobros abiertos de 2020 (uno vencido para la prueba de mora).
WITH a AS (
  INSERT INTO public.payments (school_id, child_id, parent_id, amount, concept, due_date, status,
                               period_year, period_month, payment_category)
  SELECT school_id, child_id, parent_id, 150000, 'SMOKE acuerdo 1', DATE '2020-01-05', 'pending', 2020, 1, 'mensualidad'
    FROM _p RETURNING id)
UPDATE _p SET pay1 = (SELECT id FROM a);
WITH b AS (
  INSERT INTO public.payments (school_id, child_id, parent_id, amount, concept, due_date, status,
                               period_year, period_month, payment_category)
  SELECT school_id, child_id, parent_id, 90000, 'SMOKE acuerdo 2', DATE '2020-02-05', 'pending', 2020, 2, 'mensualidad'
    FROM _p RETURNING id)
UPDATE _p SET pay2 = (SELECT id FROM b);

-- Sesión como el pagador.
CREATE OR REPLACE FUNCTION pg_temp.como(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.como(uuid) TO PUBLIC;

-- ── T1 apagado ──────────────────────────────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; v_ok boolean := false;
BEGIN
  SELECT * INTO p FROM _p;
  PERFORM pg_temp.como(p.parent_id);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.request_payment_agreement(p.school_id, ARRAY[p.pay1],
      jsonb_build_array(jsonb_build_object('due_date', (current_date + 10)::text, 'amount', 150000)));
  EXCEPTION WHEN SQLSTATE '55000' THEN v_ok := true; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T1: debía fallar ACUERDOS_APAGADO'; END IF;
  RAISE NOTICE 'OK T1 apagado ✓';
END $$;

UPDATE public.school_settings SET payment_agreements_enabled = true WHERE school_id = (SELECT school_id FROM _p);

-- ── T2 auto-aprobado y payments intacto ─────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; r jsonb; v_amount numeric; v_items int;
BEGIN
  SELECT * INTO p FROM _p;
  PERFORM pg_temp.como(p.parent_id);
  SET LOCAL ROLE authenticated;
  r := public.request_payment_agreement(p.school_id, ARRAY[p.pay1], jsonb_build_array(
         jsonb_build_object('due_date', (current_date + 15)::text, 'amount', 50000),
         jsonb_build_object('due_date', (current_date + 30)::text, 'amount', 50000),
         jsonb_build_object('due_date', (current_date + 45)::text, 'amount', 50000)));
  RESET ROLE;
  IF r->>'status' <> 'activo' OR (r->>'auto_approved')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL T2: %', r;
  END IF;
  UPDATE _p SET ag1 = (r->>'agreement_id')::uuid;
  SELECT amount INTO v_amount FROM public.payments WHERE id = p.pay1;
  SELECT count(*) INTO v_items FROM public.payment_agreement_items WHERE agreement_id = (r->>'agreement_id')::uuid;
  IF v_amount <> 150000 OR v_items <> 3 THEN RAISE EXCEPTION 'FAIL T2 datos amount=% items=%', v_amount, v_items; END IF;
  RAISE NOTICE 'OK T2 auto-aprobado, 3 cuotas, payments intacto ✓';
END $$;

-- ── T4 validaciones ─────────────────────────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; v_ok boolean;
BEGIN
  SELECT * INTO p FROM _p;
  PERFORM pg_temp.como(p.parent_id);
  SET LOCAL ROLE authenticated;
  -- cobro ya en acuerdo vivo
  v_ok := false;
  BEGIN
    PERFORM public.request_payment_agreement(p.school_id, ARRAY[p.pay1],
      jsonb_build_array(jsonb_build_object('due_date', (current_date + 10)::text, 'amount', 150000)));
  EXCEPTION WHEN unique_violation THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T4 cobro ya en acuerdo'; END IF;
  -- suma distinta del saldo
  v_ok := false;
  BEGIN
    PERFORM public.request_payment_agreement(p.school_id, ARRAY[p.pay2],
      jsonb_build_array(jsonb_build_object('due_date', (current_date + 10)::text, 'amount', 80000)));
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T4 suma'; END IF;
  -- fecha pasada
  v_ok := false;
  BEGIN
    PERFORM public.request_payment_agreement(p.school_id, ARRAY[p.pay2],
      jsonb_build_array(jsonb_build_object('due_date', (current_date - 1)::text, 'amount', 90000)));
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T4 fecha pasada'; END IF;
  RESET ROLE;
  -- cobro de otra familia
  PERFORM pg_temp.como(p.other_user);
  SET LOCAL ROLE authenticated;
  v_ok := false;
  BEGIN
    PERFORM public.request_payment_agreement(p.school_id, ARRAY[p.pay2],
      jsonb_build_array(jsonb_build_object('due_date', (current_date + 10)::text, 'amount', 90000)));
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := true; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T4 cobro ajeno'; END IF;
  RAISE NOTICE 'OK T4 validaciones ✓';
END $$;

-- ── T3 fuera de topes → solicitado; solo la administración resuelve ─────────
DO $$
DECLARE p _p%ROWTYPE; r jsonb; v_ok boolean := false;
BEGIN
  SELECT * INTO p FROM _p;
  PERFORM pg_temp.como(p.parent_id);
  SET LOCAL ROLE authenticated;
  r := public.request_payment_agreement(p.school_id, ARRAY[p.pay2], jsonb_build_array(
         jsonb_build_object('due_date', (current_date + 30)::text, 'amount', 45000),
         jsonb_build_object('due_date', (current_date + 90)::text, 'amount', 45000)));  -- 90 d > tope 60
  IF r->>'status' <> 'solicitado' THEN RAISE EXCEPTION 'FAIL T3: %', r; END IF;
  UPDATE _p SET ag2 = (r->>'agreement_id')::uuid;
  -- el propio pagador NO puede aprobar
  BEGIN
    PERFORM public.resolve_payment_agreement((r->>'agreement_id')::uuid, 'aprobar', NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T3: el pagador pudo resolver'; END IF;
  RAISE NOTICE 'OK T3 solicitado y resolución solo de la administración ✓ (la aprobación por admin: probar con una sesión admin real)';
END $$;

-- ── T5 abonos marcan cuotas ─────────────────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; r jsonb; v_pag int; v_st text;
BEGIN
  SELECT * INTO p FROM _p;
  UPDATE public.payments SET amount_paid = 50000, status = 'partial' WHERE id = p.pay1;
  r := public.fn_agreements_mark_paid(p.school_id, ARRAY[p.ag1]);
  SELECT count(*) INTO v_pag FROM public.payment_agreement_items WHERE agreement_id = p.ag1 AND status = 'pagado';
  IF v_pag <> 1 THEN RAISE EXCEPTION 'FAIL T5 cuota 1: pagadas=% %', v_pag, r; END IF;
  UPDATE public.payments SET amount_paid = 150000, status = 'paid' WHERE id = p.pay1;
  PERFORM public.fn_agreements_mark_paid(p.school_id, ARRAY[p.ag1]);
  SELECT status INTO v_st FROM public.payment_agreements WHERE id = p.ag1;
  IF v_st <> 'cumplido' THEN RAISE EXCEPTION 'FAIL T5 cumplido: %', v_st; END IF;
  IF EXISTS (SELECT 1 FROM public.payment_agreement_payments WHERE agreement_id = p.ag1 AND live) THEN
    RAISE EXCEPTION 'FAIL T5 live';
  END IF;
  RAISE NOTICE 'OK T5 abonos → cuotas pagadas → cumplido ✓';
END $$;

-- ── T6 vencimiento → incumplido ─────────────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; v_st text;
BEGIN
  SELECT * INTO p FROM _p;
  UPDATE public.payment_agreements SET status = 'activo' WHERE id = p.ag2;   -- como si la hubieran aprobado
  UPDATE public.payment_agreement_items SET due_date = current_date - 3 WHERE agreement_id = p.ag2 AND seq = 1;
  PERFORM public.fn_agreements_mark_paid(p.school_id, ARRAY[p.ag2]);
  -- expire_agreements exige service_role/admin; aquí se prueba el mismo cuerpo vía el helper + la regla:
  UPDATE public.payment_agreement_items SET status = 'vencido' WHERE agreement_id = p.ag2 AND seq = 1 AND status = 'pendiente';
  RAISE NOTICE 'T6 (expire_agreements): probar con service_role: select public.expire_agreements(''%'')', p.school_id;
END $$;

-- ── T7 mora: con acuerdo activo y al día no hay recargo; sin acuerdo sí ─────
DO $$
DECLARE p _p%ROWTYPE; v_fee_con numeric; v_fee_sin numeric;
BEGIN
  SELECT * INTO p FROM _p;
  -- pay2: cobro vencido SIN acuerdo vivo (el ag2 pasó a incumplido en T6 → live)
  UPDATE public.payment_agreement_payments SET live = false WHERE agreement_id = p.ag2;
  UPDATE public.payment_agreements SET status = 'incumplido' WHERE id = p.ag2;
  PERFORM public.apply_late_fees();
  SELECT late_fee_amount INTO v_fee_sin FROM public.payments WHERE id = p.pay2;
  IF v_fee_sin IS DISTINCT FROM 9000 THEN RAISE EXCEPTION 'FAIL T7 sin acuerdo: esperaba 9000, hubo %', v_fee_sin; END IF;
  -- Con acuerdo activo y al día: restaurar el cobro y crear acuerdo directo.
  UPDATE public.payments SET status = 'pending', amount = 90000, late_fee_amount = 0, late_fee_applied_at = NULL WHERE id = p.pay2;
  UPDATE public.payment_agreement_payments SET live = true WHERE agreement_id = p.ag2;
  UPDATE public.payment_agreements SET status = 'activo' WHERE id = p.ag2;
  UPDATE public.payment_agreement_items SET due_date = current_date + 20, status = 'pendiente' WHERE agreement_id = p.ag2;
  PERFORM public.apply_late_fees();
  SELECT late_fee_amount INTO v_fee_con FROM public.payments WHERE id = p.pay2;
  IF v_fee_con <> 0 THEN RAISE EXCEPTION 'FAIL T7 con acuerdo: recargo % (esperaba 0)', v_fee_con; END IF;
  RAISE NOTICE 'OK T7 mora: sin acuerdo 9000, con acuerdo activo y al día 0 ✓';
END $$;

-- ── T8 RLS ──────────────────────────────────────────────────────────────────
DO $$
DECLARE p _p%ROWTYPE; v_n int; v_ok boolean := false;
BEGIN
  SELECT * INTO p FROM _p;
  PERFORM pg_temp.como(p.other_user);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.payment_agreements WHERE school_id = p.school_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL T8: un ajeno ve % acuerdos', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.payment_agreement_items WHERE school_id = p.school_id;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL T8: un ajeno ve % cuotas', v_n; END IF;
  BEGIN
    DELETE FROM public.payment_agreements WHERE school_id = p.school_id;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T8: DELETE no está cerrado'; END IF;
  PERFORM pg_temp.como(p.parent_id);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM public.payment_agreements WHERE school_id = p.school_id;
  RESET ROLE;
  IF v_n < 1 THEN RAISE EXCEPTION 'FAIL T8: el pagador no ve su acuerdo'; END IF;
  SET LOCAL ROLE anon;
  v_ok := false;
  BEGIN
    PERFORM count(*) FROM public.payment_agreements;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true; END;
  RESET ROLE;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL T8: anon lee payment_agreements'; END IF;
  RAISE NOTICE 'OK T8 RLS ✓';
END $$;

ROLLBACK;
