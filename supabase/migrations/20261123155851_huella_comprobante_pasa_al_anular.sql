-- =============================================================================
-- 20261123155851_huella_comprobante_pasa_al_anular.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23
-- Objetivo: cuando se anula (cancelled/rejected/failed) el cobro que guarda la
--   huella de imagen y la referencia OCR de un comprobante compartido por varios
--   cobros (hermanas), esos datos pasan a OTRO cobro vivo con el mismo receipt_url;
--   así el mismo comprobante no puede volver a subirse mientras alguno lo use.
--   Si no queda ningún cobro vivo con ese comprobante, se liberan.
--   Spec: docs/specs/pago-hermanas-un-comprobante.md §2.3.
-- Orden: primero se LIMPIAN en el cobro anulado y luego se copian al heredero,
--   porque uq_payments_school_ocr_reference no filtra por estado y chocaría.
-- =============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_payments_huella_pasa_al_anular()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_sha       text    := NEW.receipt_image_sha256;
  v_sha_src   text    := NEW.receipt_image_sha256_source;
  v_ref       text    := NEW.ocr_reference;
  v_heredero  uuid;
BEGIN
  IF v_sha IS NULL AND v_ref IS NULL THEN
    RETURN NULL;
  END IF;

  -- Heredero: otro cobro vivo de la misma escuela con el mismo comprobante y sin
  -- huella ni referencia propias (si ya las tiene, el comprobante ya está protegido).
  IF NEW.receipt_url IS NOT NULL THEN
    SELECT o.id INTO v_heredero
      FROM public.payments o
     WHERE o.school_id = NEW.school_id
       AND o.id <> NEW.id
       AND o.receipt_url = NEW.receipt_url
       AND o.status NOT IN ('rejected', 'cancelled', 'failed')
     ORDER BY (o.receipt_image_sha256 IS NULL AND o.ocr_reference IS NULL) DESC, o.created_at, o.id
     LIMIT 1;
  END IF;

  -- 1) Limpiar en el cobro anulado (libera los índices únicos).
  UPDATE public.payments
     SET receipt_image_sha256        = NULL,
         receipt_image_sha256_source = NULL,
         ocr_reference               = NULL,
         updated_at                  = now()
   WHERE id = NEW.id;

  -- 2) Pasarlas al heredero solo si no tiene las suyas.
  IF v_heredero IS NOT NULL THEN
    UPDATE public.payments
       SET receipt_image_sha256        = COALESCE(receipt_image_sha256, v_sha),
           receipt_image_sha256_source = COALESCE(receipt_image_sha256_source, v_sha_src),
           ocr_reference               = COALESCE(ocr_reference, v_ref),
           updated_at                  = now()
     WHERE id = v_heredero;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_payments_huella_pasa_al_anular() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payments_huella_pasa_al_anular() TO service_role;

DROP TRIGGER IF EXISTS trg_payments_huella_pasa_al_anular ON public.payments;
CREATE TRIGGER trg_payments_huella_pasa_al_anular
  AFTER UPDATE OF status ON public.payments
  FOR EACH ROW
  WHEN (new.status IN ('rejected', 'cancelled', 'failed')
        AND old.status NOT IN ('rejected', 'cancelled', 'failed'))
  EXECUTE FUNCTION public.fn_payments_huella_pasa_al_anular();

COMMIT;
