-- =============================================================================
-- 20261123123730_saldo_a_favor_sin_huella_a_revision.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23
-- Objetivo: el saldo a favor automático NO se acredita si el comprobante llega sin
--   huella de imagen ni referencia OCR (no se puede descartar un duplicado); el pago
--   queda con requires_review. Reemite fn_payments_saldo_a_favor_al_aprobar de
--   20261120143043 con ese único cambio. Spec: docs/specs/pago-hermanas-un-comprobante.md §2.4.
-- =============================================================================
BEGIN;

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

        -- Sin huella de imagen NI referencia OCR no hay forma de saber si el mismo
        -- comprobante ya se usó en otro cobro: no se acredita saldo automático y el
        -- pago queda en revisión (spec pago-hermanas-un-comprobante.md, Q4).
        IF NEW.receipt_image_sha256 IS NULL AND NEW.ocr_reference IS NULL THEN
            UPDATE public.payments
               SET requires_review = true,
                   notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN '' ELSE notes || E'
' END
                           || 'Saldo a favor NO acreditado: el comprobante llegó sin huella ni referencia; revisar a mano (excedente leído por OCR: ' || v_ocr::text || ').',
                   updated_at = now()
             WHERE id = NEW.id;
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

REVOKE ALL ON FUNCTION public.fn_payments_saldo_a_favor_al_aprobar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payments_saldo_a_favor_al_aprobar() TO service_role;

COMMIT;
