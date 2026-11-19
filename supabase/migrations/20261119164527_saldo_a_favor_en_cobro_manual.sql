-- =============================================================================
-- 20261119164527_saldo_a_favor_en_cobro_manual.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119141319
-- Objetivo: que el SALDO A FAVOR se descuente también en lo que se crea a mano
--   desde «Cobros y pagos» (create_charge_batch / preview_charge_batch).
--
-- PROBLEMA. El saldo a favor (20261013165308) se consume con el trigger
--   trg_zzzz_payments_saldo_a_favor_al_crear, que solo corre con
--   charge_batch_id IS NULL: «las filas de un lote las maneja create_charge_batch».
--   Pero create_charge_batch NUNCA llamó al consumidor (verificado en la base viva
--   el 2026-11-19: ni create_charge_batch, ni _plan_charge_operation, ni
--   preview_charge_batch mencionan saldo_a_favor). Resultado: una familia con saldo
--   a favor a la que se le crea una mensualidad a mano la ve completa, y el saldo
--   queda «disponible» en la pestaña Saldos a favor sin gastarse.
--
-- QUÉ HACE.
--   1. create_charge_batch: DESPUÉS de la verificación PLAN_DIVERGE (que compara lo
--      escrito con lo planificado) y ANTES de los avisos, llama a
--      _saldo_a_favor_consumir una vez por dueño con cobros pendientes en el lote.
--      Va al final a propósito: antes rompería PLAN_DIVERGE (el monto cambia) y la
--      mora/descuentos/exoneración del modal ya están asentados. El consumidor
--      jamás toca el recargo por mora (solo valor de lista menos descuentos), no
--      toca cobros con pago, ni con enlace de pasarela en vuelo; «Ya lo pagaron»
--      (status paid/partial, amount_paid > 0) y la exoneración (amount 0) quedan
--      fuera solos. Camino rápido: si la escuela no tiene ningún saldo, no hace nada.
--   2. preview_charge_batch: devuelve 'saldo_a_favor' (por dueño de las líneas
--      nuevas sin pago, con saldo disponible > 0) para que la pantalla avise. Va
--      FUERA de _plan_charge_operation: NO entra al preview_hash (no hay PREVIEW_STALE
--      nuevo ni cambia el contrato del plan).
--
-- CÓMO. Parche por texto con pg_get_functiondef y aserción de UNA coincidencia
--   (como 20261119141319): si la función viva difiere del repo, ABORTA.
-- ACL: CREATE OR REPLACE conserva los GRANT de las dos funciones parchadas.
-- =============================================================================

BEGIN;

-- ── Parche 1: create_charge_batch consume el saldo ───────────────────────────
DO $patch1$
DECLARE
    v_oid oid;
    v_def text;
    v_new text;
    v_pat text := $re$-- 11\. Avisos agrupados por familia con cuenta\.$re$;
    v_rep text := $rp$-- 10b. Saldo a favor (20261119164527): descuenta del cobro pendiente más
    --      antiguo de cada dueño lo que pagó de más antes. Después de PLAN_DIVERGE.
    IF EXISTS (SELECT 1 FROM public.payment_adjustments a
                WHERE a.school_id = p_school_id AND a.origin = 'saldo_a_favor') THEN
        FOR v_row IN
            SELECT DISTINCT public._saldo_a_favor_dueno(p.child_id, p.unregistered_athlete_id, p.user_id, p.parent_id) AS dueno
              FROM public.payments p
             WHERE p.charge_batch_id = v_batch_id
               AND p.status IN ('pending', 'overdue')
               AND p.amount > 0
             ORDER BY 1
        LOOP
            IF v_row.dueno IS NOT NULL THEN
                PERFORM public._saldo_a_favor_consumir(p_school_id, v_row.dueno, p_actor);
            END IF;
        END LOOP;
    END IF;

    -- 11. Avisos agrupados por familia con cuenta.$rp$;
BEGIN
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_charge_batch';
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'SALDO_COBRO_MANUAL: no existe create_charge_batch';
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%_saldo_a_favor_consumir%' THEN
        RAISE NOTICE 'parche 1 ya aplicado';
        RETURN;
    END IF;
    IF regexp_count(v_def, v_pat) <> 1 THEN
        RAISE EXCEPTION 'SALDO_COBRO_MANUAL: create_charge_batch viva difiere del repo (coincidencias: %)', regexp_count(v_def, v_pat);
    END IF;
    v_new := regexp_replace(v_def, v_pat, replace(v_rep, '\', '\\'));
    EXECUTE v_new;
END
$patch1$;

-- ── Parche 2: preview_charge_batch avisa del saldo ───────────────────────────
DO $patch2$
DECLARE
    v_oid oid;
    v_def text;
    v_new text;
    v_pat text := $re$RETURN v_plan;\s*END;$re$;
    v_rep text := $rp$-- Saldo a favor de los dueños de las líneas nuevas sin pago (solo informativo;
    -- NO entra al preview_hash). 20261119164527.
    IF EXISTS (SELECT 1 FROM public.payment_adjustments a
                WHERE a.school_id = p_school_id AND a.origin = 'saldo_a_favor') THEN
        v_plan := v_plan || jsonb_build_object('saldo_a_favor', (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'dueno', g.dueno, 'child_id', g.child_id, 'user_id', g.user_id,
                       'unregistered_athlete_id', g.unreg_id, 'disponible', g.disp)), '[]'::jsonb)
              FROM (SELECT s.dueno, min(s.child_id) AS child_id, min(s.user_id) AS user_id,
                           min(s.unreg_id) AS unreg_id,
                           public._saldo_a_favor_disponible(p_school_id, s.dueno) AS disp
                      FROM (SELECT public._saldo_a_favor_dueno(
                                       NULLIF(x->>'child_id', '')::uuid,
                                       NULLIF(x->>'unregistered_athlete_id', '')::uuid,
                                       NULLIF(x->>'user_id', '')::uuid,
                                       NULLIF(x->>'parent_id', '')::uuid) AS dueno,
                                   x->>'child_id' AS child_id, x->>'user_id' AS user_id,
                                   x->>'unregistered_athlete_id' AS unreg_id
                              FROM jsonb_array_elements(v_plan->'items') x
                             WHERE COALESCE((x->>'will_create')::boolean, false)
                               AND COALESCE((x->>'pay_amount')::numeric, 0) = 0) s
                     WHERE s.dueno IS NOT NULL
                     GROUP BY s.dueno) g
             WHERE g.disp > 0));
    END IF;

    RETURN v_plan;
END;$rp$;
BEGIN
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'preview_charge_batch';
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'SALDO_COBRO_MANUAL: no existe preview_charge_batch';
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%saldo_a_favor%' THEN
        RAISE NOTICE 'parche 2 ya aplicado';
        RETURN;
    END IF;
    IF regexp_count(v_def, v_pat) <> 1 THEN
        RAISE EXCEPTION 'SALDO_COBRO_MANUAL: preview_charge_batch viva difiere del repo (coincidencias: %)', regexp_count(v_def, v_pat);
    END IF;
    v_new := regexp_replace(v_def, v_pat, replace(v_rep, '\', '\\'));
    EXECUTE v_new;
END
$patch2$;

COMMIT;
