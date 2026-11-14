-- ============================================================
-- SMOKE TEST — Referidos automáticos (20261106160001). NO es una migración.
-- Correr DESPUÉS de aplicar la migración, en una base de PRUEBA o con el ROLLBACK final:
--   psql "$DATABASE_URL" -v school_id="'<uuid de una escuela de prueba>'" \
--     -f supabase/migrations/_smoke/referidos_smoke.sql
--
-- Una transacción con ROLLBACK final: no persiste nada. NO correr en una sesión que
-- aplique migraciones en paralelo (Disk IO). Ejecutado como dueño (service-level):
-- los chequeos de alcance de usuario (T8) van aparte con set local role (ver al final).
--
-- ESTADO: escrito contra el esquema leído el 2026-11-06 pero NO ejecutado (el agente que lo
-- escribió no podía escribir en la base). Si una columna NOT NULL no listada falla en un
-- INSERT de preparación, agrégala; las aserciones no cambian.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _p (school_id uuid);
INSERT INTO _p VALUES (:school_id);

DO $$
DECLARE
  v_school uuid; v_camp uuid;
  v_ref_child uuid; v_ref_enr uuid;            -- referente
  v_c10 uuid; v_e10 uuid;                      -- referido de 10 años
  v_c17 uuid; v_e17 uuid;                      -- referido de 17 años
  v_c3  uuid; v_e3  uuid;                      -- referido de 3 años
  v_res jsonb; v_pct numeric; v_item jsonb;
  v_dec_year int; v_dec_month int; v_n int; v_pay uuid; v_base numeric;
BEGIN
  SELECT school_id INTO v_school FROM _p;

  -- Campaña de prueba (reemplaza la de la escuela dentro de la transacción).
  DELETE FROM public.enrollment_referrals WHERE school_id = v_school;
  DELETE FROM public.school_discount_campaigns WHERE school_id = v_school;
  INSERT INTO public.school_discount_campaigns (school_id, name, active, tiers)
  VALUES (v_school, 'SMOKE referidos', true,
          '[{"age_min":4,"age_max":15,"pct":50},{"age_min":16,"age_max":null,"pct":25}]'::jsonb)
  RETURNING id INTO v_camp;

  -- Referente (mensualidad 200000) y tres referidos con edades distintas.
  INSERT INTO public.children (full_name, school_id, date_of_birth)
    VALUES ('SMOKE Referente', v_school, current_date - interval '12 years') RETURNING id INTO v_ref_child;
  INSERT INTO public.enrollments (school_id, child_id, status, start_date, monthly_fee, fee_is_manual)
    VALUES (v_school, v_ref_child, 'active', current_date - 400, 200000, false) RETURNING id INTO v_ref_enr;

  INSERT INTO public.children (full_name, school_id, date_of_birth)
    VALUES ('SMOKE Referido10', v_school, current_date - interval '10 years') RETURNING id INTO v_c10;
  INSERT INTO public.enrollments (school_id, child_id, status, start_date, monthly_fee, fee_is_manual)
    VALUES (v_school, v_c10, 'active', current_date, 100000, false) RETURNING id INTO v_e10;
  INSERT INTO public.children (full_name, school_id, date_of_birth)
    VALUES ('SMOKE Referido17', v_school, current_date - interval '17 years') RETURNING id INTO v_c17;
  INSERT INTO public.enrollments (school_id, child_id, status, start_date, monthly_fee, fee_is_manual)
    VALUES (v_school, v_c17, 'active', current_date, 100000, false) RETURNING id INTO v_e17;
  INSERT INTO public.children (full_name, school_id, date_of_birth)
    VALUES ('SMOKE Referido3', v_school, current_date - interval '3 years') RETURNING id INTO v_c3;
  INSERT INTO public.enrollments (school_id, child_id, status, start_date, monthly_fee, fee_is_manual)
    VALUES (v_school, v_c3, 'active', current_date, 100000, false) RETURNING id INTO v_e3;

  -- T1 / T2 / T3: registro y cálculo del %
  v_res := public.register_enrollment_referral(v_school, v_e10, v_ref_enr);
  ASSERT (v_res->'referral'->>'pct')::numeric = 50 AND v_res->'referral'->>'status' = 'pendiente', 'T1: 10 años → 50 %';
  v_res := public.register_enrollment_referral(v_school, v_e17, v_ref_enr);
  ASSERT (v_res->'referral'->>'pct')::numeric = 25, 'T2: 17 años → 25 %';
  v_res := public.register_enrollment_referral(v_school, v_e3, v_ref_enr);
  ASSERT (v_res->>'ok')::boolean = false AND (v_res->>'califica')::boolean = false, 'T3: menor de 4 no califica';
  SELECT count(*) INTO v_n FROM public.enrollment_referrals WHERE referred_enrollment_id = v_e3;
  ASSERT v_n = 0, 'T3: no se crea renglón';

  -- Los dos referidos pagan su primera mensualidad este mes.
  INSERT INTO public.payments (school_id, child_id, concept, amount, due_date, status, payment_type,
                               payment_category, period_year, period_month, approved_at)
  VALUES (v_school, v_c10, 'SMOKE mens', 100000, current_date, 'paid', 'subscription', 'mensualidad',
          extract(year FROM current_date)::smallint, extract(month FROM current_date)::smallint, now()),
         (v_school, v_c17, 'SMOKE mens', 100000, current_date, 'paid', 'subscription', 'mensualidad',
          extract(year FROM current_date)::smallint, extract(month FROM current_date)::smallint, now());

  -- T4: dos referidos, mismo referente → meses consecutivos.
  v_res := public.qualify_enrollment_referrals(v_school);
  ASSERT (v_res->>'ganados')::int = 2, 'T4: ganan los dos';
  SELECT count(DISTINCT (apply_year * 12 + apply_month)) INTO v_n
    FROM public.enrollment_referrals WHERE referrer_enrollment_id = v_ref_enr AND status = 'ganado';
  ASSERT v_n = 2, 'T4: dos meses distintos';
  -- Idempotencia del lote: correrlo otra vez no gana nada nuevo.
  v_res := public.qualify_enrollment_referrals(v_school);
  ASSERT (v_res->>'ganados')::int = 0, 'qualify idempotente';

  -- Mes de aplicación del primero (50 %).
  SELECT apply_year, apply_month INTO v_dec_year, v_dec_month
    FROM public.enrollment_referrals WHERE referred_enrollment_id = v_e10;

  -- Para el smoke el referente debe estar al día: sin mensualidades vencidas previas (no hay).
  -- Preview y apertura del mes del descuento.
  v_res := public.preview_open_month(v_school, v_dec_year, v_dec_month);
  SELECT i INTO v_item FROM jsonb_array_elements(v_res->'items') i WHERE i->>'athlete' = 'SMOKE Referente';
  ASSERT (v_item->>'amount')::numeric = 100000 AND (v_item->>'referral_pct')::numeric = 50, 'T1: preview 50 % sobre 200000';
  ASSERT v_item->>'referral_note' = 'Descuento 50 % por referido: SMOKE Referido10', 'T1: motivo legible';

  -- T6: cerrar dos veces aplica una sola vez.
  PERFORM public.open_month(v_school, v_dec_year, v_dec_month);
  v_res := public.open_month(v_school, v_dec_year, v_dec_month);
  ASSERT (v_res->>'generados')::int = 0, 'T6: el segundo cierre no genera nada';
  SELECT count(*) INTO v_n FROM public.payments
   WHERE child_id = v_ref_child AND notes LIKE 'Descuento 50 % por referido:%';
  ASSERT v_n = 1, 'T6: un solo cobro con descuento';
  SELECT count(*) INTO v_n FROM public.enrollment_referrals
   WHERE referred_enrollment_id = v_e10 AND status = 'aplicado' AND applied_payment_id IS NOT NULL;
  ASSERT v_n = 1, 'T6: renglón aplicado con su cobro';

  -- T4 (cont.): el mes del segundo (25 %) trae el otro descuento, no el mismo.
  SELECT apply_year, apply_month INTO v_dec_year, v_dec_month
    FROM public.enrollment_referrals WHERE referred_enrollment_id = v_e17;
  v_res := public.preview_open_month(v_school, v_dec_year, v_dec_month);
  SELECT i INTO v_item FROM jsonb_array_elements(v_res->'items') i WHERE i->>'athlete' = 'SMOKE Referente';
  ASSERT (v_item->>'referral_pct')::numeric = 25, 'T4: el mes siguiente aplica el 25 %';

  RAISE NOTICE 'referidos_smoke: T1, T2, T3, T4, T6 OK';
END $$;

-- T5 (beca 100 %), T7 (referente atrasado) y T8 (otra escuela) se verifican a mano:
--   T5: update enrollments set fee_is_manual = true, monthly_fee = 0 where id = <referente> →
--       open_month no genera cobro y el renglón sigue 'ganado'.
--   T7: insert de una mensualidad pending con due_date < inicio del mes → el cobro del mes sale sin
--       descuento y el renglón sigue 'ganado'.
--   T8: begin; set local role authenticated;
--       select set_config('request.jwt.claims', json_build_object('sub','<admin de OTRA escuela>')::text, true);
--       select count(*) from public.enrollment_referrals where school_id = <escuela A>;   -- 0
--       select public.referrals_report(<escuela A>);                                      -- ERROR 42501
--       rollback;

ROLLBACK;
