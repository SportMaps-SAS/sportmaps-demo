-- =============================================================================
-- 20261123120036_cobranza_recordatorio_manual.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123115649
-- Objetivo: que el recordatorio de pago que pide un admin desde Mapi quede
--   registrado en collection_notices y comparta el candado familia-día del
--   cron (docs/specs/mapi-agente-plan.md §4 y §5 #4, aprobado 2026-11-23).
--   Tope aprobado: 1 recordatorio manual por cobro cada 7 días (lo valida el
--   BFF al preparar la acción).
--
-- ⚠ APLICAR SOLO DESPUÉS de desplegar el BFF donde `enviarContacto`
--   (bff/src/services/recordatorios-cobro.service.ts) ya NO usa
--   `upsert(..., { onConflict: 'payment_id,notice_type' })`.
--   Motivo: el índice único (payment_id, notice_type) pasa a ser PARCIAL, y
--   PostgreSQL no usa un índice parcial para un `ON CONFLICT (payment_id,
--   notice_type)` sin su WHERE: el cron fallaría con 42P10 en cada familia con
--   más de un cobro. El código nuevo inserta las filas una por una e ignora
--   23505, así que funciona con el índice viejo y con este.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra.
--   · Estados/enums: text + CHECK.
-- =============================================================================

BEGIN;

-- 1. Tipo de registro propio. El manual envía con la plantilla del escalón que
--    le toca al cobro, pero se registra como 'recordatorio_manual'.
ALTER TABLE public.collection_notices DROP CONSTRAINT IF EXISTS collection_notices_notice_type_check;
ALTER TABLE public.collection_notices ADD CONSTRAINT collection_notices_notice_type_check
    CHECK (notice_type = ANY (ARRAY[
        'recordatorio_previo','vence_manana','vence_hoy','pendiente_suave','pendiente_directo','aviso_final',
        'recordatorio_manual'
    ]::text[]));

-- 2. Un escalón del cron sigue siendo único por cobro, para siempre. El manual
--    queda fuera de ese candado (se puede repetir; el tope lo pone el BFF) y
--    conserva el candado familia-día (collection_notices_family_day_uq, intacto).
DROP INDEX IF EXISTS public.collection_notices_payment_notice_uq;
CREATE UNIQUE INDEX collection_notices_payment_notice_uq
    ON public.collection_notices (payment_id, notice_type)
    WHERE notice_type <> 'recordatorio_manual';

-- 3. Para el tope «1 manual por cobro cada 7 días».
CREATE INDEX IF NOT EXISTS collection_notices_manual_payment_idx
    ON public.collection_notices (payment_id, contact_day)
    WHERE notice_type = 'recordatorio_manual';

COMMIT;
