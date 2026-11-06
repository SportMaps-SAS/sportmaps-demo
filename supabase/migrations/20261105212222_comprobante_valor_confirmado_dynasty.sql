-- =============================================================================
-- 20261105212222_comprobante_valor_confirmado_dynasty.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105212125
-- Objetivo: la escuela puede corregir, al validar un comprobante, el valor que
--   realmente se pagó (distinto al que leyó el OCR). Solo para escuelas con el
--   interruptor encendido (Dynasty). El monto leído (ocr_amount) NO se toca:
--   queda como evidencia; el valor confirmado y su razón van en columnas propias.
-- Solo agrega columnas con default; no cambia funciones, policies ni grants.
-- =============================================================================

BEGIN;

ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS receipt_amount_editable boolean NOT NULL DEFAULT false;

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS receipt_amount_confirmed numeric(12,2),
    ADD COLUMN IF NOT EXISTS receipt_amount_change_reason text,
    ADD COLUMN IF NOT EXISTS receipt_amount_confirmed_by uuid REFERENCES public.profiles(id),
    ADD COLUMN IF NOT EXISTS receipt_amount_confirmed_at timestamptz;

COMMENT ON COLUMN public.school_settings.receipt_amount_editable IS
    'Si es true, al validar un comprobante la escuela puede cambiar el valor pagado respecto al que leyó el OCR.';
COMMENT ON COLUMN public.payments.receipt_amount_confirmed IS
    'Valor que la escuela confirmó como realmente pagado al validar el comprobante (puede diferir de ocr_amount).';

-- Dynasty
UPDATE public.school_settings
   SET receipt_amount_editable = true
 WHERE school_id = '2d509571-3238-4c04-ac3f-6dfe20539226';

COMMIT;
