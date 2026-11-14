-- ============================================================
-- SMOKE + CONCURRENCIA — SEG-31 F3 (H1/H2). NO es una migración.
-- Correr DESPUÉS de aplicar 20261107111754_seg31_cupos_reserva_sin_cuenta.
-- Preferir el gemelo local (Docker). En la base compartida: una escuela de
-- prueba (Academia Superior), UNA sola sesión aplicando DDL, y cerrar con
-- fase=cleanup + verificación de limpieza.
--
-- Todas las fases reciben la escuela:  -v school_id="'<uuid>'"
-- La fase funcional además recibe:
--   -v school_b_id="'<uuid de OTRA escuela>'"
--   -v user_id="'<uuid de un usuario existente (auth.users/profiles) — solo se le
--                crea una inscripción de prueba dentro de la transacción>'"
--
-- ── Fase 1: funcional, una sola transacción con ROLLBACK (no persiste) ──
--   psql "$DATABASE_URL" -v school_id="'<uuid>'" -v school_b_id="'<uuid>'" \
--        -v user_id="'<uuid>'" -v fase=funcional \
--        -f supabase/migrations/_smoke/seg31_cupos_reserva_sin_cuenta_smoke.sql
--
-- ── Fase 2: concurrencia (necesita datos COMMITEADOS: dos conexiones) ──
--   F=supabase/migrations/_smoke/seg31_cupos_reserva_sin_cuenta_smoke.sql
--   P="-v school_id='<uuid>'"
--   psql "$DATABASE_URL" $P -v fase=setup        -f $F
--   # Dos reservas a la vez sobre una inscripción con 1 cupo libre:
--   psql "$DATABASE_URL" $P -v fase=book_a -f $F &   # reserva y retiene el lock 5 s
--   sleep 1
--   psql "$DATABASE_URL" $P -v fase=book_b -f $F     # espera el lock → no_credits
--   wait
--   psql "$DATABASE_URL" $P -v fase=check_book   -f $F
--   # Dos cancelaciones a la vez de la misma reserva:
--   psql "$DATABASE_URL" $P -v fase=cancel_a -f $F & # cancela y retiene el lock 5 s
--   sleep 1
--   psql "$DATABASE_URL" $P -v fase=cancel_b -f $F   # espera → cancelled:false
--   wait
--   psql "$DATABASE_URL" $P -v fase=check_cancel -f $F
--   psql "$DATABASE_URL" $P -v fase=cleanup      -f $F   # SIEMPRE, aunque algo falle
--
-- Datos de prueba: nombres 'SMOKE SEG31 …', fechas 2099. El plan tiene
-- max_sessions = 2 y la inscripción arranca con sessions_used = 1 (1 cupo
-- libre). Así una doble devolución SÍ se ve (1 → 0); con un plan de 1 cupo el
-- GREATEST(0, …) de move_session_credit la escondería.
-- Columnas mínimas asumidas en los INSERT (no verificadas en vivo): si alguna
-- tabla tiene otra columna NOT NULL sin default, ajustar el INSERT.
-- ============================================================
\set ON_ERROR_STOP on

SELECT :'fase' = 'funcional'    AS f_funcional,
       :'fase' = 'setup'        AS f_setup,
       :'fase' = 'book_a'       AS f_book_a,
       :'fase' = 'book_b'       AS f_book_b,
       :'fase' = 'check_book'   AS f_check_book,
       :'fase' = 'cancel_a'     AS f_cancel_a,
       :'fase' = 'cancel_b'     AS f_cancel_b,
       :'fase' = 'check_cancel' AS f_check_cancel,
       :'fase' = 'cleanup'      AS f_cleanup
\gset

-- Parámetros de la corrida, visibles para los DO $$ (que no ven variables psql).
CREATE TEMP TABLE _p (school_id uuid, school_b_id uuid, user_id uuid);
INSERT INTO _p (school_id) VALUES (:school_id);

-- ============================================================
-- Fase 1 — funcional
-- ============================================================
\if :f_funcional
UPDATE _p SET school_b_id = :school_b_id, user_id = :user_id;
BEGIN;
DO $$
DECLARE
    v_school uuid; v_school_b uuid; v_user uuid;
    v_branch uuid; v_team uuid; v_off uuid; v_plan uuid; v_plan_h uuid;
    v_ua uuid; v_ua2 uuid; v_ua3 uuid; v_ua_b uuid; v_child uuid; v_child2 uuid;
    v_enr uuid; v_enr_exp uuid; v_enr_h uuid; v_enr_child uuid; v_enr_user uuid; v_enr3 uuid; v_enr_b uuid;
    v_period_h uuid; v_period_c uuid; v_hb1 uuid; v_hb_other uuid;
    s uuid[] := '{}'; v_sid uuid; i int;
    v_b public.session_bookings; v_b2 public.session_bookings; v_r jsonb; v_used int; v_txt text; v_n int;
BEGIN
    SELECT school_id, school_b_id, user_id INTO v_school, v_school_b, v_user FROM _p;
    IF v_school_b IS NULL OR v_school_b = v_school OR v_user IS NULL THEN
        RAISE EXCEPTION 'Parámetros: school_b_id (distinta de school_id) y user_id son obligatorios en fase=funcional';
    END IF;

    INSERT INTO public.school_branches (school_id, name) VALUES (v_school, 'SMOKE SEG31 sede') RETURNING id INTO v_branch;
    INSERT INTO public.teams (school_id, name, sport) VALUES (v_school, 'SMOKE SEG31 equipo', 'futbol') RETURNING id INTO v_team;
    FOR i IN 1..16 LOOP
        INSERT INTO public.attendance_sessions (school_id, team_id, session_date)
             VALUES (v_school, v_team, DATE '2099-01-01' + i - 1) RETURNING id INTO v_sid;
        s := s || v_sid;
    END LOOP;
    INSERT INTO public.offerings (school_id, name, offering_type) VALUES (v_school, 'SMOKE SEG31 offering', 'membership') RETURNING id INTO v_off;
    INSERT INTO public.offering_plans (school_id, offering_id, name, price, max_sessions)
        VALUES (v_school, v_off, 'SMOKE SEG31 plan 2 clases', 100000, 2) RETURNING id INTO v_plan;
    INSERT INTO public.offering_plans (school_id, offering_id, name, price, included_minutes_per_period)
        VALUES (v_school, v_off, 'SMOKE SEG31 plan horas', 100000, 600) RETURNING id INTO v_plan_h;
    INSERT INTO public.unregistered_athletes (school_id, full_name) VALUES (v_school, 'SMOKE SEG31 ficha') RETURNING id INTO v_ua;
    INSERT INTO public.unregistered_athletes (school_id, full_name) VALUES (v_school, 'SMOKE SEG31 ficha ajena') RETURNING id INTO v_ua2;
    INSERT INTO public.unregistered_athletes (school_id, full_name) VALUES (v_school, 'SMOKE SEG31 ficha a migrar') RETURNING id INTO v_ua3;
    INSERT INTO public.unregistered_athletes (school_id, full_name) VALUES (v_school_b, 'SMOKE SEG31 ficha escuela B') RETURNING id INTO v_ua_b;
    INSERT INTO public.children (full_name, school_id, branch_id, is_active)
        VALUES ('SMOKE SEG31 menor ' || gen_random_uuid(), v_school, v_branch, true) RETURNING id INTO v_child;
    INSERT INTO public.children (full_name, school_id, branch_id, is_active)
        VALUES ('SMOKE SEG31 menor migrado ' || gen_random_uuid(), v_school, v_branch, true) RETURNING id INTO v_child2;

    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, offering_plan_id, status, start_date, expires_at, sessions_used)
        VALUES (v_school, v_ua, v_plan, 'active', '2099-01-01', '2099-12-31', 1) RETURNING id INTO v_enr;
    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, offering_plan_id, status, start_date, expires_at)
        VALUES (v_school, v_ua, v_plan, 'active', '2020-01-01', '2020-01-31') RETURNING id INTO v_enr_exp;
    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, offering_plan_id, status, start_date, expires_at)
        VALUES (v_school, v_ua, v_plan_h, 'active', '2099-01-01', '2099-12-31') RETURNING id INTO v_enr_h;
    INSERT INTO public.enrollments (school_id, child_id, offering_plan_id, status, start_date, expires_at)
        VALUES (v_school, v_child, v_plan, 'active', '2099-01-01', '2099-12-31') RETURNING id INTO v_enr_child;
    INSERT INTO public.enrollments (school_id, user_id, offering_plan_id, status, start_date, expires_at)
        VALUES (v_school, v_user, v_plan, 'active', '2099-01-01', '2099-12-31') RETURNING id INTO v_enr_user;
    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, offering_plan_id, status, start_date, expires_at)
        VALUES (v_school, v_ua3, v_plan, 'active', '2099-01-01', '2099-12-31') RETURNING id INTO v_enr3;
    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, status, start_date, expires_at)
        VALUES (v_school_b, v_ua_b, 'active', '2099-01-01', '2099-12-31') RETURNING id INTO v_enr_b;

    -- Banco de horas: período y reservas de horas creadas a mano (no se prueba
    -- reserve_hour_bank aquí). reserved_minutes ya incluye las reservas.
    INSERT INTO public.hour_bank_periods (enrollment_id, school_id, period_start, period_end, included_minutes, reserved_minutes)
        VALUES (v_enr_h, v_school, '2099-01-01', '2099-02-01', 600, 60) RETURNING id INTO v_period_h;
    INSERT INTO public.hour_bank_reservations (school_id, enrollment_id, period_id, reservation_date, minutes)
        VALUES (v_school, v_enr_h, v_period_h, '2099-01-11', 60) RETURNING id INTO v_hb1;
    INSERT INTO public.hour_bank_periods (enrollment_id, school_id, period_start, period_end, included_minutes, reserved_minutes)
        VALUES (v_enr, v_school, '2099-01-01', '2099-02-01', 600, 60) RETURNING id INTO v_period_c;
    INSERT INTO public.hour_bank_reservations (school_id, enrollment_id, period_id, reservation_date, minutes)
        VALUES (v_school, v_enr, v_period_c, '2099-01-11', 60) RETURNING id INTO v_hb_other;

    -- 1) Reserva sin cuenta: enrollment_id NULL, credit_enrollment_id = inscripción, consume 1.
    v_b := public.book_session_with_credit(v_school, s[1], v_enr, NULL, NULL, v_ua, false, NULL);
    IF v_b.enrollment_id IS NOT NULL OR v_b.credit_enrollment_id IS DISTINCT FROM v_enr THEN
        RAISE EXCEPTION 'FAIL 1: enrollment_id=% credit_enrollment_id=%', v_b.enrollment_id, v_b.credit_enrollment_id;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr;
    IF v_used <> 2 THEN RAISE EXCEPTION 'FAIL 1: sessions_used=% (esperaba 2)', v_used; END IF;

    -- 2) Sin cupo → no_credits, y no queda reserva.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[2], v_enr, NULL, NULL, v_ua, false, NULL);
        RAISE EXCEPTION 'FAIL 2: reservó sin cupo';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'no_credits:%' THEN RAISE; END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.session_bookings WHERE session_id = s[2]) THEN
        RAISE EXCEPTION 'FAIL 2: quedó una reserva huérfana';
    END IF;

    -- 3) Plan vencido → plan_expired.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[3], v_enr_exp, NULL, NULL, v_ua, false, NULL);
        RAISE EXCEPTION 'FAIL 3: reservó con plan vencido';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'plan_expired:%' THEN RAISE; END IF;
    END;

    -- 4) Inscripción de otra ficha → enrollment_unauthorized.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[3], v_enr, NULL, NULL, v_ua2, false, NULL);
        RAISE EXCEPTION 'FAIL 4: reservó con inscripción ajena';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'enrollment_unauthorized:%' THEN RAISE; END IF;
    END;

    -- 5) Escuela inexistente → session_not_found.
    BEGIN
        PERFORM public.book_session_with_credit(gen_random_uuid(), s[3], v_enr, NULL, NULL, v_ua, false, NULL);
        RAISE EXCEPTION 'FAIL 5: reservó en otra escuela';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'session_not_found:%' THEN RAISE; END IF;
    END;

    -- 5b) Inscripción de la escuela B con sesión de la escuela A, declarando A → enrollment_unauthorized.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[3], v_enr_b, NULL, NULL, v_ua_b, false, NULL);
        RAISE EXCEPTION 'FAIL 5b: aceptó una inscripción de otra escuela';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'enrollment_unauthorized:%' THEN RAISE; END IF;
    END;

    -- 5c) Lo mismo declarando la escuela B → session_not_found (la sesión es de A).
    BEGIN
        PERFORM public.book_session_with_credit(v_school_b, s[3], v_enr_b, NULL, NULL, v_ua_b, false, NULL);
        RAISE EXCEPTION 'FAIL 5c: aceptó una sesión de otra escuela';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'session_not_found:%' THEN RAISE; END IF;
    END;

    -- 6) Dos identidades → invalid_identity.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[3], v_enr, gen_random_uuid(), NULL, v_ua, false, NULL);
        RAISE EXCEPTION 'FAIL 6: aceptó dos identidades';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'invalid_identity:%' THEN RAISE; END IF;
    END;

    -- 7) Cancelar por otra identidad → cancelled:false, sin tocar el saldo.
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, NULL, v_ua2);
    IF (v_r->>'cancelled')::boolean THEN RAISE EXCEPTION 'FAIL 7: canceló reserva ajena (%)', v_r; END IF;

    -- 8) Cancelar → devuelve el crédito vía credit_enrollment_id.
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, NULL, v_ua);
    IF NOT (v_r->>'cancelled')::boolean OR NOT (v_r->>'credit_returned')::boolean
       OR (v_r->>'hour_bank')::boolean OR (v_r->>'session_id')::uuid IS DISTINCT FROM s[1] THEN
        RAISE EXCEPTION 'FAIL 8: %', v_r;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 8: sessions_used=% (esperaba 1)', v_used; END IF;

    -- 9) Segunda cancelación → cancelled:false, saldo intacto.
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, NULL, v_ua);
    IF (v_r->>'cancelled')::boolean THEN RAISE EXCEPTION 'FAIL 9: canceló dos veces (%)', v_r; END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 9: sessions_used=% (esperaba 1)', v_used; END IF;

    -- 11) Plan de horas SIN reserva de horas → hour_bank_reservation_required.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[4], v_enr_h, NULL, NULL, v_ua, false, NULL);
        RAISE EXCEPTION 'FAIL 11: plan de horas reservó gratis';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'hour_bank_reservation_required:%' THEN RAISE; END IF;
    END;

    -- 12) Reserva de horas de OTRA inscripción → hour_bank_reservation_mismatch.
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[4], v_enr_h, NULL, NULL, v_ua, false, v_hb_other);
        RAISE EXCEPTION 'FAIL 12: aceptó una reserva de horas ajena';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'hour_bank_reservation_mismatch:%' THEN RAISE; END IF;
    END;

    -- 13) Plan de horas CON su reserva → OK y no toca sessions_used.
    v_b := public.book_session_with_credit(v_school, s[4], v_enr_h, NULL, NULL, v_ua, false, v_hb1);
    IF v_b.hour_bank_reservation_id IS DISTINCT FROM v_hb1 OR v_b.credit_enrollment_id IS DISTINCT FROM v_enr_h THEN
        RAISE EXCEPTION 'FAIL 13: hb=% credit=%', v_b.hour_bank_reservation_id, v_b.credit_enrollment_id;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_h;
    IF v_used <> 0 THEN RAISE EXCEPTION 'FAIL 13: plan de horas movió sessions_used=%', v_used; END IF;

    -- 14) La misma reserva de horas en otra clase → 23505 (índice único N3).
    BEGIN
        PERFORM public.book_session_with_credit(v_school, s[5], v_enr_h, NULL, NULL, v_ua, false, v_hb1);
        RAISE EXCEPTION 'FAIL 14: colgó la misma reserva de horas de dos clases';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    -- 15) Cancelar la de horas → hour_bank:true, credit_returned:true, horas liberadas.
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, NULL, v_ua);
    IF NOT (v_r->>'cancelled')::boolean OR NOT (v_r->>'credit_returned')::boolean OR NOT (v_r->>'hour_bank')::boolean THEN
        RAISE EXCEPTION 'FAIL 15: %', v_r;
    END IF;
    SELECT status INTO v_txt FROM public.hour_bank_reservations WHERE id = v_hb1;
    SELECT reserved_minutes INTO v_n FROM public.hour_bank_periods WHERE id = v_period_h;
    IF v_txt <> 'cancelled' OR v_n <> 0 THEN RAISE EXCEPTION 'FAIL 15: hb status=% reserved_minutes=%', v_txt, v_n; END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_h;
    IF v_used <> 0 THEN RAISE EXCEPTION 'FAIL 15: sessions_used=%', v_used; END IF;

    -- 16) Identidad child_id: enrollment_id = inscripción, consume y devuelve.
    v_b := public.book_session_with_credit(v_school, s[6], v_enr_child, NULL, v_child, NULL, false, NULL);
    IF v_b.enrollment_id IS DISTINCT FROM v_enr_child OR v_b.child_id IS DISTINCT FROM v_child THEN
        RAISE EXCEPTION 'FAIL 16: enrollment_id=% child_id=%', v_b.enrollment_id, v_b.child_id;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_child;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 16: sessions_used=% (esperaba 1)', v_used; END IF;
    v_r := public.cancel_session_booking_with_credit(v_b.id, v_user, NULL, NULL);   -- identidad equivocada
    IF (v_r->>'cancelled')::boolean THEN RAISE EXCEPTION 'FAIL 16: canceló con user_id ajeno (%)', v_r; END IF;
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, v_child, NULL);
    IF NOT (v_r->>'credit_returned')::boolean THEN RAISE EXCEPTION 'FAIL 16: %', v_r; END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_child;
    IF v_used <> 0 THEN RAISE EXCEPTION 'FAIL 16: sessions_used=% (esperaba 0)', v_used; END IF;

    -- 17) Identidad user_id: igual.
    v_b := public.book_session_with_credit(v_school, s[7], v_enr_user, v_user, NULL, NULL, false, NULL);
    IF v_b.enrollment_id IS DISTINCT FROM v_enr_user OR v_b.user_id IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'FAIL 17: enrollment_id=% user_id=%', v_b.enrollment_id, v_b.user_id;
    END IF;
    BEGIN   -- la inscripción del usuario no sirve para el menor
        PERFORM public.book_session_with_credit(v_school, s[8], v_enr_user, NULL, v_child, NULL, false, NULL);
        RAISE EXCEPTION 'FAIL 17: usó la inscripción de un usuario para un menor';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM NOT LIKE 'enrollment_unauthorized:%' THEN RAISE; END IF;
    END;
    v_r := public.cancel_session_booking_with_credit(v_b.id, v_user, NULL, NULL);
    IF NOT (v_r->>'credit_returned')::boolean THEN RAISE EXCEPTION 'FAIL 17: %', v_r; END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_user;
    IF v_used <> 0 THEN RAISE EXCEPTION 'FAIL 17: sessions_used=% (esperaba 0)', v_used; END IF;

    -- 18) migrate_unregistered_athlete_to_profile rellena enrollment_id.
    v_b := public.book_session_with_credit(v_school, s[9], v_enr3, NULL, NULL, v_ua3, false, NULL);
    IF v_b.enrollment_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL 18: enrollment_id debería ser NULL antes de migrar'; END IF;
    v_r := public.migrate_unregistered_athlete_to_profile(v_ua3, NULL, v_child2);
    IF (v_r->>'session_bookings')::int <> 1 THEN RAISE EXCEPTION 'FAIL 18: migrate devolvió %', v_r; END IF;
    SELECT * INTO v_b2 FROM public.session_bookings WHERE id = v_b.id;
    IF v_b2.child_id IS DISTINCT FROM v_child2 OR v_b2.unregistered_athlete_id IS NOT NULL
       OR v_b2.enrollment_id IS DISTINCT FROM v_enr3 THEN
        RAISE EXCEPTION 'FAIL 18: tras migrar child_id=% unregistered=% enrollment_id=%',
            v_b2.child_id, v_b2.unregistered_athlete_id, v_b2.enrollment_id;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr3;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 18: sessions_used=% (esperaba 1)', v_used; END IF;
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, v_child2, NULL);
    IF NOT (v_r->>'credit_returned')::boolean THEN RAISE EXCEPTION 'FAIL 18: cancelar tras migrar: %', v_r; END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr3;
    IF v_used <> 0 THEN RAISE EXCEPTION 'FAIL 18: sessions_used=% (esperaba 0)', v_used; END IF;

    -- 19) R1: sesión de un día anterior (Bogotá) → no cancela ni devuelve.
    INSERT INTO public.attendance_sessions (school_id, team_id, session_date)
         VALUES (v_school, v_team, DATE '2020-01-15') RETURNING id INTO v_sid;
    v_b := public.book_session_with_credit(v_school, v_sid, v_enr_user, v_user, NULL, NULL, false, NULL);
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_user;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 19: sessions_used=% (esperaba 1)', v_used; END IF;
    v_r := public.cancel_session_booking_with_credit(v_b.id, v_user, NULL, NULL);
    IF (v_r->>'cancelled')::boolean OR v_r->>'reason' IS DISTINCT FROM 'session_in_the_past' THEN
        RAISE EXCEPTION 'FAIL 19: %', v_r;
    END IF;
    SELECT status::text INTO v_txt FROM public.session_bookings WHERE id = v_b.id;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_user;
    IF v_txt <> 'confirmed' OR v_used <> 1 THEN RAISE EXCEPTION 'FAIL 19: status=% sessions_used=%', v_txt, v_used; END IF;

    -- 20) R1: ya hay attendance_record de esa sesión e identidad → no cancela ni devuelve.
    v_b := public.book_session_with_credit(v_school, s[10], v_enr_child, NULL, v_child, NULL, false, NULL);
    INSERT INTO public.attendance_records (school_id, child_id, team_id, session_id, attendance_date, status)
         VALUES (v_school, v_child, v_team, s[10], DATE '2099-01-10', 'present');
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, v_child, NULL);
    IF (v_r->>'cancelled')::boolean OR v_r->>'reason' IS DISTINCT FROM 'attendance_recorded' THEN
        RAISE EXCEPTION 'FAIL 20: %', v_r;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_child;
    IF v_used <> 1 THEN RAISE EXCEPTION 'FAIL 20: sessions_used=% (esperaba 1, sin devolución)', v_used; END IF;

    -- 21) R2: reserva SIN credit_enrollment_id (como la de encuesta: enrollment_id
    --     del body, sin consumir) → cancela pero NO devuelve, aunque tenga enrollment_id.
    INSERT INTO public.session_bookings (school_id, session_id, enrollment_id, child_id, status)
         VALUES (v_school, s[11], v_enr_child, v_child, 'confirmed') RETURNING * INTO v_b;
    IF v_b.credit_enrollment_id IS NOT NULL THEN RAISE EXCEPTION 'FAIL 21: credit_enrollment_id debería ser NULL'; END IF;
    SELECT sessions_used INTO v_n FROM public.enrollments WHERE id = v_enr_child;
    v_r := public.cancel_session_booking_with_credit(v_b.id, NULL, v_child, NULL);
    IF NOT (v_r->>'cancelled')::boolean OR (v_r->>'credit_returned')::boolean
       OR v_r->>'reason' IS DISTINCT FROM 'no_credit_enrollment' THEN
        RAISE EXCEPTION 'FAIL 21: %', v_r;
    END IF;
    SELECT sessions_used INTO v_used FROM public.enrollments WHERE id = v_enr_child;
    IF v_used <> v_n THEN RAISE EXCEPTION 'FAIL 21: devolvió un crédito no consumido (% → %)', v_n, v_used; END IF;

    -- 22) Cancelar algo no cancelable → reason not_cancellable.
    v_r := public.cancel_session_booking_with_credit(gen_random_uuid(), NULL, v_child, NULL);
    IF (v_r->>'cancelled')::boolean OR v_r->>'reason' IS DISTINCT FROM 'not_cancellable' THEN
        RAISE EXCEPTION 'FAIL 22: %', v_r;
    END IF;

    -- 10) Grants: solo service_role.
    IF has_function_privilege('authenticated', 'public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FAIL 10: alguna RPC es ejecutable por anon/authenticated';
    END IF;
    IF NOT has_function_privilege('service_role', 'public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'FAIL 10: service_role sin EXECUTE';
    END IF;

    RAISE NOTICE 'SMOKE SEG31 funcional: OK (casos 1-22)';
END $$;
ROLLBACK;
\endif

-- ============================================================
-- Fase 2 — setup (COMMITEA datos de prueba)
-- ============================================================
\if :f_setup
BEGIN;
DO $$
DECLARE
    v_school uuid; v_team uuid; v_off uuid; v_plan uuid; v_ua uuid;
BEGIN
    SELECT school_id INTO v_school FROM _p;
    IF EXISTS (SELECT 1 FROM public.unregistered_athletes
                WHERE school_id = v_school AND full_name = 'SMOKE SEG31 concurrencia') THEN
        RAISE EXCEPTION 'Ya hay datos de una corrida anterior: correr fase=cleanup primero';
    END IF;
    INSERT INTO public.teams (school_id, name, sport) VALUES (v_school, 'SMOKE SEG31 concurrencia', 'futbol') RETURNING id INTO v_team;
    INSERT INTO public.attendance_sessions (school_id, team_id, session_date) VALUES (v_school, v_team, '2099-02-01');
    INSERT INTO public.attendance_sessions (school_id, team_id, session_date) VALUES (v_school, v_team, '2099-02-02');
    INSERT INTO public.offerings (school_id, name, offering_type) VALUES (v_school, 'SMOKE SEG31 concurrencia', 'membership') RETURNING id INTO v_off;
    INSERT INTO public.offering_plans (school_id, offering_id, name, price, max_sessions)
        VALUES (v_school, v_off, 'SMOKE SEG31 concurrencia', 100000, 2) RETURNING id INTO v_plan;
    INSERT INTO public.unregistered_athletes (school_id, full_name) VALUES (v_school, 'SMOKE SEG31 concurrencia') RETURNING id INTO v_ua;
    INSERT INTO public.enrollments (school_id, unregistered_athlete_id, offering_plan_id, status, start_date, expires_at, sessions_used)
        VALUES (v_school, v_ua, v_plan, 'active', '2099-01-01', '2099-12-31', 1);
    RAISE NOTICE 'setup OK: inscripción con sessions_used=1 de max_sessions=2 (1 cupo libre)';
END $$;
COMMIT;
\endif

-- Vista auxiliar de los ids de prueba (temporal, por conexión).
\if :f_funcional
\else
CREATE TEMP VIEW _ids AS
SELECT ua.id AS ua_id, e.id AS enr_id, op.id AS plan_id, op.offering_id, t.id AS team_id,
       (SELECT s.id FROM public.attendance_sessions s WHERE s.team_id = t.id AND s.session_date = '2099-02-01') AS s1,
       (SELECT s.id FROM public.attendance_sessions s WHERE s.team_id = t.id AND s.session_date = '2099-02-02') AS s2,
       ua.school_id
  FROM public.unregistered_athletes ua
  JOIN _p ON _p.school_id = ua.school_id
  LEFT JOIN public.enrollments e   ON e.unregistered_athlete_id = ua.id
  LEFT JOIN public.offering_plans op ON op.id = e.offering_plan_id
  LEFT JOIN public.teams t ON t.school_id = ua.school_id AND t.name = 'SMOKE SEG31 concurrencia'
 WHERE ua.full_name = 'SMOKE SEG31 concurrencia';
\endif

-- ── book_a: reserva la sesión 1 y retiene el lock de la inscripción 5 s ──
\if :f_book_a
BEGIN;
SELECT id, credit_enrollment_id
  FROM public.book_session_with_credit(
         (SELECT school_id FROM _ids), (SELECT s1 FROM _ids), (SELECT enr_id FROM _ids),
         NULL, NULL, (SELECT ua_id FROM _ids), false, NULL);
SELECT pg_sleep(5);
COMMIT;
\endif

-- ── book_b: reserva la sesión 2; debe esperar a book_a y fallar con no_credits ──
\if :f_book_b
\set ON_ERROR_STOP off
SELECT clock_timestamp() AS inicio_b;
SELECT id FROM public.book_session_with_credit(
         (SELECT school_id FROM _ids), (SELECT s2 FROM _ids), (SELECT enr_id FROM _ids),
         NULL, NULL, (SELECT ua_id FROM _ids), false, NULL);
-- Esperado: ERROR «no_credits: Ya usaste las 2 clases de tu plan.» ~4 s después de inicio_b.
SELECT clock_timestamp() AS fin_b;
\set ON_ERROR_STOP on
\endif

\if :f_check_book
DO $$
DECLARE v_used int; v_n int; v_s2 int;
BEGIN
    SELECT e.sessions_used INTO v_used FROM public.enrollments e JOIN _ids ON e.id = _ids.enr_id;
    SELECT count(*) INTO v_n  FROM public.session_bookings b JOIN _ids ON b.credit_enrollment_id = _ids.enr_id WHERE b.status = 'confirmed';
    SELECT count(*) INTO v_s2 FROM public.session_bookings b JOIN _ids ON b.session_id = _ids.s2;
    IF v_used <> 2 OR v_n <> 1 OR v_s2 <> 0 THEN
        RAISE EXCEPTION 'FAIL concurrencia reserva: sessions_used=% (esperaba 2), confirmadas=% (esperaba 1), en sesión 2=% (esperaba 0)', v_used, v_n, v_s2;
    END IF;
    RAISE NOTICE 'Concurrencia de reserva: OK (una sola reserva, un solo crédito consumido)';
END $$;
\endif

-- ── cancel_a: cancela la reserva y retiene el lock de la fila 5 s ──
\if :f_cancel_a
BEGIN;
SELECT public.cancel_session_booking_with_credit(
         (SELECT b.id FROM public.session_bookings b JOIN _ids ON b.credit_enrollment_id = _ids.enr_id WHERE b.status = 'confirmed'),
         NULL, NULL, (SELECT ua_id FROM _ids)) AS resultado_a;
SELECT pg_sleep(5);
COMMIT;
\endif

-- ── cancel_b: misma reserva; debe esperar a cancel_a y devolver cancelled:false ──
\if :f_cancel_b
SELECT clock_timestamp() AS inicio_b;
SELECT public.cancel_session_booking_with_credit(
         (SELECT b.id FROM public.session_bookings b JOIN _ids ON b.session_id = _ids.s1),
         NULL, NULL, (SELECT ua_id FROM _ids)) AS resultado_b;
-- Esperado: {"reason": "not_cancellable", "cancelled": false} ~4 s después de inicio_b.
SELECT clock_timestamp() AS fin_b;
\endif

\if :f_check_cancel
DO $$
DECLARE v_used int; v_cur int; v_st text;
BEGIN
    SELECT e.sessions_used INTO v_used FROM public.enrollments e JOIN _ids ON e.id = _ids.enr_id;
    SELECT b.status::text INTO v_st FROM public.session_bookings b JOIN _ids ON b.session_id = _ids.s1;
    SELECT s.current_bookings INTO v_cur FROM public.attendance_sessions s JOIN _ids ON s.id = _ids.s1;
    -- Una doble devolución dejaría sessions_used = 0.
    IF v_used <> 1 OR v_st <> 'cancelled' THEN
        RAISE EXCEPTION 'FAIL concurrencia cancelación: sessions_used=% (esperaba 1), status=%', v_used, v_st;
    END IF;
    -- current_bookings lo mueven los triggers (no esta migración): solo se informa.
    RAISE NOTICE 'current_bookings de la sesión 1 = % (esperado 0 si trg_sync_session_capacity descuenta una sola vez)', v_cur;
    RAISE NOTICE 'Concurrencia de cancelación: OK (un solo crédito devuelto)';
END $$;
\endif

-- ============================================================
-- cleanup — borra SOLO lo creado por fase=setup y verifica
-- (DELETE físico aceptable: son datos de prueba, no de negocio)
-- ============================================================
\if :f_cleanup
BEGIN;
CREATE TEMP TABLE _del AS SELECT * FROM _ids;
DELETE FROM public.session_bookings  WHERE credit_enrollment_id IN (SELECT enr_id FROM _del)
                                        OR unregistered_athlete_id IN (SELECT ua_id FROM _del)
                                        OR session_id IN (SELECT s1 FROM _del UNION SELECT s2 FROM _del);
DELETE FROM public.enrollments       WHERE id IN (SELECT enr_id FROM _del);
DELETE FROM public.attendance_sessions WHERE team_id IN (SELECT team_id FROM _del);
DELETE FROM public.teams             WHERE id IN (SELECT team_id FROM _del);
DELETE FROM public.offering_plans    WHERE id IN (SELECT plan_id FROM _del);
DELETE FROM public.offerings         WHERE id IN (SELECT offering_id FROM _del);
DELETE FROM public.unregistered_athletes WHERE id IN (SELECT ua_id FROM _del);
DO $$
DECLARE v_left int;
BEGIN
    SELECT (SELECT count(*) FROM public.unregistered_athletes ua JOIN _p ON _p.school_id = ua.school_id WHERE ua.full_name LIKE 'SMOKE SEG31%')
         + (SELECT count(*) FROM public.teams t JOIN _p ON _p.school_id = t.school_id WHERE t.name LIKE 'SMOKE SEG31%')
         + (SELECT count(*) FROM public.offerings o JOIN _p ON _p.school_id = o.school_id WHERE o.name LIKE 'SMOKE SEG31%')
         + (SELECT count(*) FROM public.offering_plans op JOIN _p ON _p.school_id = op.school_id WHERE op.name LIKE 'SMOKE SEG31%')
      INTO v_left;
    IF v_left <> 0 THEN RAISE EXCEPTION 'FAIL cleanup: quedan % filas SMOKE SEG31', v_left; END IF;
    RAISE NOTICE 'cleanup OK: 0 filas SMOKE SEG31';
END $$;
COMMIT;
\endif
