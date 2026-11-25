-- =============================================================================
-- 20261125135754_cobranza_recordatorio_manual_restriccion.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261125105034
-- Objetivo: lo mismo que 20261123120036_cobranza_recordatorio_manual, que FALLÓ
--   al aplicarse el 2026-11-25 y NO quedó aplicada (se revirtió completa):
--     ERROR 2BP01: cannot drop index collection_notices_payment_notice_uq
--     because constraint collection_notices_payment_notice_uq requires it
--   En la base viva `collection_notices_payment_notice_uq` es una RESTRICCIÓN
--   UNIQUE (contype 'u'), no un índice suelto: se quita con ALTER TABLE … DROP
--   CONSTRAINT. 20261123120036 queda REEMPLAZADA por esta: no aplicarla nunca.
--
-- Qué hace (plan Mapi agente §4 y §5 #4, aprobado 2026-11-23):
--   1. 'recordatorio_manual' en el CHECK de notice_type (el manual envía con la
--      plantilla del escalón del cobro, pero se registra con su propio tipo).
--   2. La unicidad (payment_id, notice_type) pasa a índice único PARCIAL sin
--      'recordatorio_manual': cada escalón del cron sigue siendo único por cobro
--      para siempre; el manual se puede repetir (tope 1 cada 7 días en el BFF).
--      El candado familia-día (collection_notices_family_day_uq) no se toca.
--   3. Índice para el tope del manual.
--
-- Prerrequisito (verificado el 2026-11-25): el BFF de producción (main
--   b742e9c2) ya no usa upsert(..., { onConflict: 'payment_id,notice_type' })
--   (reclamarFilasHermanas inserta fila por fila e ignora 23505), y ninguna
--   función de la base hace ON CONFLICT sobre collection_notices. Un ON CONFLICT
--   sobre esas columnas contra un índice PARCIAL daría 42P10.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra.
--   · Estados/enums: text + CHECK.
-- =============================================================================

BEGIN;

-- 1. Tipo de registro propio.
ALTER TABLE public.collection_notices DROP CONSTRAINT IF EXISTS collection_notices_notice_type_check;
ALTER TABLE public.collection_notices ADD CONSTRAINT collection_notices_notice_type_check
    CHECK (notice_type = ANY (ARRAY[
        'recordatorio_previo','vence_manana','vence_hoy','pendiente_suave','pendiente_directo','aviso_final',
        'recordatorio_manual'
    ]::text[]));

-- 2. La restricción UNIQUE (payment_id, notice_type) se reemplaza por un índice
--    único parcial con el MISMO nombre. Una restricción no puede ser parcial.
ALTER TABLE public.collection_notices DROP CONSTRAINT IF EXISTS collection_notices_payment_notice_uq;
DROP INDEX IF EXISTS public.collection_notices_payment_notice_uq;
CREATE UNIQUE INDEX collection_notices_payment_notice_uq
    ON public.collection_notices (payment_id, notice_type)
    WHERE notice_type <> 'recordatorio_manual';

-- 3. Para el tope «1 manual por cobro cada 7 días».
CREATE INDEX IF NOT EXISTS collection_notices_manual_payment_idx
    ON public.collection_notices (payment_id, contact_day)
    WHERE notice_type = 'recordatorio_manual';

COMMIT;
