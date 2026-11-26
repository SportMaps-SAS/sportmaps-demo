-- =============================================================================
-- 20261125170908_bot_ofertas_descuento_promo_y_norte_valor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125150253
-- Objetivo: que el BOT calcule el descuento de una promoción de la escuela
--   (Monster's Black Friday, 2026-11-25): 10 % sobre el valor de TODAS las
--   ofertas con valor, para pagos cuyo comprobante tenga fecha/hora entre
--   promo_pago_desde y promo_pago_hasta (America/Bogota).
--   · bot_ofertas_ajustes.promo_descuento_pct  (1–90, entero)
--   · bot_ofertas_ajustes.promo_pago_desde/hasta (timestamptz)
--   Datos: Sede Norte formación cuesta $200.000 (lo confirmó la escuela);
--   ventana de pago 25-nov 00:00 → 27-nov 23:59:59 COT.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
-- =============================================================================

BEGIN;

ALTER TABLE public.bot_ofertas_ajustes
    ADD COLUMN promo_descuento_pct smallint
        CHECK (promo_descuento_pct IS NULL OR promo_descuento_pct BETWEEN 1 AND 90),
    ADD COLUMN promo_pago_desde timestamptz,
    ADD COLUMN promo_pago_hasta timestamptz,
    ADD CONSTRAINT bot_ofertas_ajustes_promo_pago_ok CHECK (
        (promo_descuento_pct IS NULL) OR (promo_pago_desde IS NOT NULL AND promo_pago_hasta IS NOT NULL
                                          AND promo_pago_hasta > promo_pago_desde));

COMMENT ON COLUMN public.bot_ofertas_ajustes.promo_descuento_pct IS
    'Descuento (%) de la promoción sobre el valor de las ofertas con valor, para pagos con comprobante entre promo_pago_desde y promo_pago_hasta.';

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base: se omiten los datos';
        RETURN;
    END IF;

    UPDATE public.bot_ofertas SET requiere_pago = true, valor = 200000
    WHERE school_id = v_escuela AND tipo = 'convocatoria' AND titulo LIKE 'Convocatorias Sede Norte%';

    UPDATE public.bot_ofertas_ajustes SET
        promo_descuento_pct = 10,
        promo_pago_desde = TIMESTAMPTZ '2026-11-25 00:00:00-05',
        promo_pago_hasta = TIMESTAMPTZ '2026-11-27 23:59:59-05'
    WHERE school_id = v_escuela;
END $$;

COMMIT;
