-- =============================================================================
-- 20261120143043 — El saldo a favor cuenta los abonos previos del cobro
-- =============================================================================
-- Problema (auditoría de cobros de Monster's Volley, 2026-11-20):
--   Al aprobar un comprobante mayor al cobro, el trigger
--   fn_payments_saldo_a_favor_al_aprobar calculaba el sobrante como
--       comprobante − (amount − pronto pago)
--   sin mirar lo que el cobro YA tenía abonado, y _saldo_a_favor_registrar
--   escribía amount_paid = esperado + sobrante, pisando ese abono.
--   Caso: cobro $125.000 con $20.000 abonados y comprobante de $165.000 →
--   guardaba $40.000 de saldo (son $60.000) y amount_paid $165.000 (son $185.000).
--
-- Arreglo:
--   · El trigger toma el abono previo de OLD.amount_paid y lo pasa.
--   · _saldo_a_favor_registrar recibe p_abonado_antes (DEFAULT 0) y lo suma a lo
--     recibido. Con 0 se comporta EXACTAMENTE como antes, así que
--     registrar_saldo_a_favor (RPC del BFF, 4 argumentos) no cambia.
--
-- Lo que NO cambia: el tope de 4 veces lo esperado, la regla del recargo del
--   enlace de pago, que el saldo nunca traba una aprobación, la idempotencia
--   (un cobro, un solo saldo a favor) y la cuenta de los cobros que comparten
--   comprobante (sigue restando su `amount` completo: restarles su saldo
--   inventaría un sobrante cuando ya quedaron pagados en la misma aprobación).
--
-- Sin cambios de tablas, policies ni triggers (el trigger sigue apuntando a la
--   misma función). No recalcula nada hacia atrás.
-- Decisión de producto (2026-11-20): un abono que nació de un saldo a favor
--   anterior también cuenta: el sobrante vuelve a quedar a favor de la familia.
-- =============================================================================

BEGIN;

-- ── 1. Registrar: ahora con el abono previo ─────────────────────────────────
-- Cambia la firma (5.º parámetro con DEFAULT): se quita la de 4 para que no
-- queden dos candidatas a la llamada de 4 argumentos.
DROP FUNCTION IF EXISTS public._saldo_a_favor_registrar(uuid, numeric, uuid, text);

CREATE OR REPLACE FUNCTION public._saldo_a_favor_registrar(
    p_payment_id uuid, p_monto_recibido numeric, p_actor uuid, p_motivo text,
    p_abonado_antes numeric DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    r           public.payments;
    v_esperado  numeric;
    v_cubiertos numeric := 0;
    v_antes     numeric;
    v_exc       numeric;
    v_seq       integer;
    v_paid      numeric;
    v_consumido numeric;
    v_motivo    text := NULLIF(btrim(COALESCE(p_motivo, '')), '');
BEGIN
    SELECT * INTO r FROM public.payments WHERE id = p_payment_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: cobro % no existe', p_payment_id USING ERRCODE = 'P0001';
    END IF;
    IF r.status <> 'paid' THEN
        RAISE EXCEPTION 'COBRO_NO_PAGADO: el cobro está %; el saldo a favor sale de un pago aprobado', r.status
            USING ERRCODE = 'P0001';
    END IF;
    IF p_monto_recibido IS NULL OR p_monto_recibido <= 0 THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: monto recibido' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.payment_adjustments a
                WHERE a.payment_id = r.id AND a.kind = 'saldo_a_favor') THEN
        RETURN jsonb_build_object('excedente', 0, 'consumido', 0, 'motivo', 'ya_registrado');
    END IF;

    v_esperado := r.amount - COALESCE(r.early_payment_discount_applied, 0);
    -- Lo abonado ANTES de este comprobante: nunca negativo ni más que lo debido
    -- (lo que pasara de lo debido ya habría sido su propio saldo a favor).
    v_antes := LEAST(GREATEST(COALESCE(p_abonado_antes, 0), 0), GREATEST(v_esperado, 0));

    IF r.receipt_url IS NOT NULL THEN
        SELECT COALESCE(sum(o.amount), 0) INTO v_cubiertos
          FROM public.payments o
         WHERE o.school_id = r.school_id
           AND o.id <> r.id
           AND o.receipt_url = r.receipt_url
           AND o.status NOT IN ('rejected', 'cancelled', 'failed');
    END IF;

    v_exc := round(v_antes + p_monto_recibido - v_esperado - v_cubiertos);
    IF v_exc <= 0 THEN
        RETURN jsonb_build_object('excedente', 0, 'consumido', 0, 'motivo', 'sin_excedente');
    END IF;

    v_paid := v_esperado + v_exc;
    UPDATE public.payments
       SET amount_paid = v_paid,
           updated_at  = now()
     WHERE id = r.id;

    SELECT COALESCE(max(a.sequence), 0) + 1 INTO v_seq
      FROM public.payment_adjustments a WHERE a.payment_id = r.id;

    INSERT INTO public.payment_adjustments (
        school_id, payment_id, charge_batch_id, kind, origin, applies_to, sequence,
        basis, pct, amount, scope, context, reason_code, reason_text,
        amount_before, amount_after, amount_paid_at, created_by)
    VALUES (
        r.school_id, r.id, NULL, 'saldo_a_favor', 'saldo_a_favor', 'pago', v_seq,
        'valor', NULL, v_exc, 'linea', 'al_pagar', 'saldo_a_favor',
        left(COALESCE(v_motivo, 'Pagó de más: saldo a favor'), 300),
        r.amount, r.amount, v_paid, p_actor);

    v_consumido := public._saldo_a_favor_consumir(
        r.school_id,
        public._saldo_a_favor_dueno(r.child_id, r.unregistered_athlete_id, r.user_id, r.parent_id),
        p_actor);

    RETURN jsonb_build_object('excedente', v_exc, 'consumido', v_consumido, 'motivo', 'registrado');
END;
$function$;

-- Helper interno: lo llaman el trigger y registrar_saldo_a_favor (ambos SECURITY
-- DEFINER). Sin EXECUTE para nadie más (los default privileges se lo darían a
-- authenticated).
REVOKE ALL ON FUNCTION public._saldo_a_favor_registrar(uuid, numeric, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._saldo_a_favor_registrar(uuid, numeric, uuid, text, numeric) TO service_role;

-- ── 2. Trigger al aprobar: cuenta lo ya abonado ─────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_payments_saldo_a_favor_al_aprobar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_ocr       numeric := NEW.ocr_amount;
    v_esperado  numeric := NEW.amount - COALESCE(NEW.early_payment_discount_applied, 0);
    -- Lo abonado antes de esta aprobación (la aprobación ya pisó NEW.amount_paid).
    v_antes     numeric := LEAST(GREATEST(COALESCE(OLD.amount_paid, 0), 0),
                                 GREATEST(NEW.amount - COALESCE(NEW.early_payment_discount_applied, 0), 0));
    v_cubiertos numeric := 0;
BEGIN
    IF v_ocr IS NULL OR NEW.receipt_url IS NULL OR v_antes + v_ocr <= v_esperado THEN
        RETURN NULL;
    END IF;

    BEGIN
        -- a. Recargo del enlace de pago: es de la escuela, no saldo a favor.
        IF v_ocr = NEW.gross_amount
           OR EXISTS (SELECT 1 FROM public.payment_links l
                       WHERE l.payment_id = NEW.id
                         AND (l.gross_amount = v_ocr
                              OR round(NEW.amount * (1 + COALESCE(l.fee_pct, 0) / 100)) = v_ocr
                              OR round(l.base_amount * (1 + COALESCE(l.fee_pct, 0) / 100)) = v_ocr)) THEN
            IF NEW.gross_amount IS NULL THEN
                UPDATE public.payments SET gross_amount = v_ocr, updated_at = now() WHERE id = NEW.id;
            END IF;
            RETURN NULL;
        END IF;

        -- b. El mismo comprobante cubre otros cobros (wa_cubrir_cobros_con_comprobante).
        SELECT COALESCE(sum(o.amount), 0) INTO v_cubiertos
          FROM public.payments o
         WHERE o.school_id = NEW.school_id
           AND o.id <> NEW.id
           AND o.receipt_url = NEW.receipt_url
           AND o.status NOT IN ('rejected', 'cancelled', 'failed');
        IF v_antes + v_ocr <= v_esperado + v_cubiertos THEN
            RETURN NULL;
        END IF;

        -- Lectura dudosa (más de 4 veces lo esperado): no se acredita plata por
        -- un OCR que pudo leer mal un cero. Queda para registrar a mano.
        IF v_ocr > 4 * (v_esperado + v_cubiertos) THEN
            RAISE WARNING 'saldo_a_favor: ocr_amount % muy por encima de lo esperado % (pago %): no se acredita',
                v_ocr, v_esperado + v_cubiertos, NEW.id;
            RETURN NULL;
        END IF;

        -- c. Plata de más: saldo a favor (con lo que ya estaba abonado).
        PERFORM public._saldo_a_favor_registrar(NEW.id, v_ocr, NEW.approved_by,
            'Pagó de más con el comprobante: saldo a favor', v_antes);
    EXCEPTION WHEN OTHERS THEN
        -- El saldo a favor nunca traba la aprobación de un pago.
        RAISE WARNING 'fn_payments_saldo_a_favor_al_aprobar: % (pago %)', SQLERRM, NEW.id;
    END;
    RETURN NULL;
END;
$function$;

-- Función de trigger: nadie la invoca directo.
REVOKE ALL ON FUNCTION public.fn_payments_saldo_a_favor_al_aprobar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payments_saldo_a_favor_al_aprobar() TO service_role;

COMMIT;
