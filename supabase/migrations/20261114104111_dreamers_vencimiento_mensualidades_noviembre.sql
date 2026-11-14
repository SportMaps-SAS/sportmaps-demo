-- =============================================================================
-- 20261114104111_dreamers_vencimiento_mensualidades_noviembre.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-14   Versión anterior: 20261112171236
-- Objetivo: seis mensualidades PAGADAS de Dreamers cubren NOVIEMBRE 2026 pero
-- siguen con due_date = 2026-11-01. La mig. 20261107104128 movió su periodo de
-- octubre a noviembre y dejó el vencimiento a propósito; la pantalla de historial
-- de pagos los rotula «Cubre Noviembre 2026 · vence el 01/11», mientras las altas
-- del 5-nov en adelante (mismo periodo) dicen «vence el 01/12».
--
-- Qué hace (solo Dreamers, ids explícitos, medido contra la base el 2026-11-14):
--   · due_date 2026-11-01 → 2026-12-01 en 6 mensualidades pagadas (Alice, Isabella
--     Saenz, Isabella Sandoval, María Paz, Santiago, Sara Sofía).
--   · No cambia montos, estados, periodos ni vigencia (enrollments.expires_at).
--
-- NO toca (decisión de la escuela, no es una corrección de rótulo):
--   · Belgica Pirela e764e5ce… (overdue, aviso de mora enviado el 09-nov)
--   · Martín Quintero e5456024… (awaiting_approval, aviso de mora enviado el 09-nov)
--   Moverles el vencimiento les da un mes de gracia sobre algo que SÍ está sin pagar.
--
-- Verificado: ningún trigger de UPDATE de payments lee due_date (fn_extend_…,
-- pronto_pago_servidor, receipt_review, rebase_list_amount); fn_guard_payments_client
-- deja pasar migraciones (sin claims). Sin recargo por mora en ninguna fila.
-- Idempotente: si ya no hay filas con due_date 2026-11-01 en esa lista, no hace nada.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_school   constant uuid := '57ba9352-2c11-4b5b-aa5b-e5ec6f526cbe';  -- Dreamers Gymnastics
    v_ids      constant uuid[] := ARRAY[
        '952642f9-9f29-4f8c-baff-a7c0033ac6c6',  -- Alice Gisselle Cordobés Pulido
        '6de28099-b9fb-4c06-a963-a2dae7fd69f6',  -- Isabella Saenz Ramirez
        '0dcf2a9f-5abb-4da0-a899-78843af383e5',  -- Isabella Sandoval
        'f5d6128a-6615-48b5-889d-847aab114d20',  -- Maria Paz Diaz Henriquez
        'fb364a19-d0cc-4daf-801b-3d6e409b2fc0',  -- Santiago Rodriguez Mesa
        '2735754f-af27-417b-baf3-db591c728add'   -- Sara Sofia Serrano
    ]::uuid[];
    v_pendientes int;
    v_movidos    int;
BEGIN
    SELECT count(*) INTO v_pendientes
      FROM public.payments
     WHERE id = ANY (v_ids) AND school_id = v_school
       AND period_year = 2026 AND period_month = 11
       AND status = 'paid'
       AND due_date = DATE '2026-11-01';

    IF v_pendientes = 0 THEN
        RAISE NOTICE 'Dreamers vencimiento nov: ya aplicada, nada que mover.';
        RETURN;
    END IF;
    IF v_pendientes <> 6 THEN
        RAISE EXCEPTION 'Dreamers vencimiento nov: se esperaban 6 cobros pagados con due_date 2026-11-01 y hay %. Volver a medir antes de aplicar.', v_pendientes;
    END IF;

    UPDATE public.payments
       SET due_date = DATE '2026-12-01'
     WHERE id = ANY (v_ids) AND school_id = v_school
       AND period_year = 2026 AND period_month = 11
       AND status = 'paid'
       AND due_date = DATE '2026-11-01';
    GET DIAGNOSTICS v_movidos = ROW_COUNT;

    IF v_movidos <> 6 THEN
        RAISE EXCEPTION 'Dreamers vencimiento nov: se movieron % cobros y se esperaban 6. Se revierte.', v_movidos;
    END IF;
END $$;

COMMIT;
