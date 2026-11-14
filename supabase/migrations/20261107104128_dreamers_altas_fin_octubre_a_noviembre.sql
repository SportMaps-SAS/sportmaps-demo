-- =============================================================================
-- 20261107104128_dreamers_altas_fin_octubre_a_noviembre.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-07   Versión anterior: 20261107101703
-- Objetivo: las altas de Dreamers del 29, 30 y 31 de octubre son de NOVIEMBRE
-- (lo confirmó la escuela: «todo es de noviembre»), pero sus cobros quedaron con
-- periodo 2026-10 (el trigger del primer cobro deja el periodo en el mes de alta y
-- solo corre el vencimiento al 01/11, mig. 20261011101750).
--
-- Consecuencias que corrige:
--   1. Las familias ven «Debe octubre» / «Mensualidad de octubre» en la app.
--   2. Dreamers usa vigencia calendar_month_end: al pagar, la inscripción quedó
--      vigente hasta el 31-oct. Seis atletas que YA pagaron figuran vencidos en
--      noviembre (Alice, Isabella Sáenz, Isabella Sandoval, María Paz, Santiago, Sara).
--   3. next_unpaid_period les iba a pedir NOVIEMBRE como siguiente mes: cobro doble.
--
-- Qué hace (solo Dreamers, ids explícitos, medido contra la base el 2026-11-07):
--   a. 13 cobros 2026-10 → 2026-11: 8 mensualidades (7 activas + 1 anulada),
--      2 inscripciones y 2 seguros. Son TODOS los cobros con periodo 2026-10 de la
--      escuela. No cambia montos, estados ni vencimientos.
--   b. Vigencia: la inscripción de cada mensualidad PAGADA que se movió pasa a
--      vencer el 30-nov (misma regla que fn_extend_enrollment_on_payment_paid en
--      modo calendar_month_end; ese trigger solo corre al cambiar el estado, por
--      eso no se recalcula solo). Belgica y Martín no pagaron: sin vigencia, como estaban.
--
-- Sin choque con uniq_payment_active_period_*: las únicas filas activas de
-- noviembre de estos atletas son «Horas adicionales» (María Paz, Sara), con
-- period_uniqueness_exempt = true, igual que inscripción y seguro.
-- Ni hour_bank_grants, ni facturas, ni recordatorios, ni cierres de mes apuntan
-- a estos cobros. Los triggers de UPDATE de payments no actúan (no cambia status).
--
-- Idempotente: si ya no hay cobros 2026-10 con esos ids, no hace nada.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_school   constant uuid := '57ba9352-2c11-4b5b-aa5b-e5ec6f526cbe';  -- Dreamers Gymnastics
    v_ids      constant uuid[] := ARRAY[
        -- mensualidades
        '952642f9-9f29-4f8c-baff-a7c0033ac6c6',  -- Alice Gisselle Cordobés Pulido  (paid)
        'e764e5ce-05e9-4d3e-8ad0-e435e06d1a74',  -- Belgica Pirela                   (overdue)
        '6de28099-b9fb-4c06-a963-a2dae7fd69f6',  -- Isabella Saenz Ramirez           (paid)
        '0dcf2a9f-5abb-4da0-a899-78843af383e5',  -- Isabella Sandoval «Plan PGR4x2»  (paid)
        'e9fe3fcf-17cd-44ec-8393-e516654f7f80',  -- Isabella Sandoval                (cancelled)
        'f5d6128a-6615-48b5-889d-847aab114d20',  -- Maria Paz Diaz Henriquez         (paid)
        'e5456024-ac5a-4a48-b440-6423bda89990',  -- Martin Quintero Cardenas         (overdue)
        'fb364a19-d0cc-4daf-801b-3d6e409b2fc0',  -- Santiago Rodriguez Mesa          (paid)
        '2735754f-af27-417b-baf3-db591c728add',  -- Sara Sofia Serrano               (paid)
        -- inscripción y seguro
        'd2f9599a-60f5-4f40-bb19-a991cbd42a39',  -- Inscripción Belgica
        'df024995-4845-4c6c-a358-04ef3312aad2',  -- Seguro Belgica
        'a3ff6d02-94a5-4a85-81b9-a9f5d7f02004',  -- Inscripción Martín
        '25f360a9-ab38-4713-96c7-472391e23eeb'   -- Seguro Martín
    ]::uuid[];
    v_pendientes int;
    v_movidos    int;
    v_vigencias  int;
BEGIN
    SELECT count(*) INTO v_pendientes
      FROM public.payments
     WHERE id = ANY (v_ids) AND school_id = v_school
       AND period_year = 2026 AND period_month = 10;

    IF v_pendientes = 0 THEN
        RAISE NOTICE 'Dreamers oct→nov: ya aplicada, nada que mover.';
        RETURN;
    END IF;
    IF v_pendientes <> 13 THEN
        RAISE EXCEPTION 'Dreamers oct→nov: se esperaban 13 cobros en 2026-10 y hay %. Volver a medir antes de aplicar.', v_pendientes;
    END IF;

    -- b. Vigencia (antes de mover, para ubicar la inscripción igual que el trigger).
    WITH pagadas AS (
        SELECT p.*
          FROM public.payments p
         WHERE p.id = ANY (v_ids) AND p.school_id = v_school
           AND p.status = 'paid'
           AND p.offering_plan_id IS NOT NULL
           AND COALESCE(p.payment_category, 'mensualidad') = 'mensualidad'
    ), insc AS (
        SELECT DISTINCT ON (pg.id) e.id AS enrollment_id
          FROM pagadas pg
          JOIN public.enrollments e
            ON e.school_id = pg.school_id
           AND e.offering_plan_id = pg.offering_plan_id
           AND e.status IN ('active', 'cancelled')
           AND (   (pg.child_id IS NOT NULL AND e.child_id = pg.child_id)
                OR (pg.unregistered_athlete_id IS NOT NULL AND e.unregistered_athlete_id = pg.unregistered_athlete_id)
                OR (pg.child_id IS NULL AND pg.unregistered_athlete_id IS NULL
                    AND e.child_id IS NULL AND e.unregistered_athlete_id IS NULL
                    AND e.user_id IN (pg.user_id, pg.parent_id)))
         ORDER BY pg.id, (e.status = 'active') DESC, e.created_at DESC
    )
    UPDATE public.enrollments e
       SET expires_at = GREATEST(COALESCE(e.expires_at, DATE '2026-11-30'), DATE '2026-11-30'),
           updated_at = now()
      FROM insc
     WHERE e.id = insc.enrollment_id;
    GET DIAGNOSTICS v_vigencias = ROW_COUNT;

    IF v_vigencias <> 6 THEN
        RAISE EXCEPTION 'Dreamers oct→nov: se esperaban 6 inscripciones a extender y salieron %.', v_vigencias;
    END IF;

    -- a. Periodo.
    UPDATE public.payments
       SET period_month = 11,
           updated_at   = now()
     WHERE id = ANY (v_ids) AND school_id = v_school
       AND period_year = 2026 AND period_month = 10;
    GET DIAGNOSTICS v_movidos = ROW_COUNT;

    IF v_movidos <> 13 THEN
        RAISE EXCEPTION 'Dreamers oct→nov: se movieron % cobros, se esperaban 13.', v_movidos;
    END IF;

    RAISE NOTICE 'Dreamers oct→nov: % cobros a 2026-11 y % inscripciones vigentes al 30-nov.', v_movidos, v_vigencias;
END;
$$;

COMMIT;
