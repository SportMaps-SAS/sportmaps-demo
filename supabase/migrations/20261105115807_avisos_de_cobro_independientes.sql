-- Avisos de cobranza independientes por escuela (cada escuela maneja su proceso).
-- Antes todo colgaba de charge_notifications_enabled. Ahora, bajo ese apagado general:
--   · charge_created_notice_enabled  → aviso de «cobro generado» (correo/WhatsApp)
--   · collection_pre_due_enabled     → recordatorios antes de vencer y el día (escalera: -3, mañana, hoy)
--   · overdue_notices_enabled        → TODO lo de mora: aviso de vencido y escalones +3, +10, +20
--                                      (columna de 20261105115230)
--   · monthly_statement_enabled      → estado de cuenta mensual (ya existía)
--   · whatsapp_/email_collection_reminders_enabled → canales de la escalera (ya existían)
-- Default true = el comportamiento actual no cambia para ninguna escuela.
BEGIN;
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS charge_created_notice_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS collection_pre_due_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS overdue_notices_enabled boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.school_settings.charge_created_notice_enabled IS 'false = no se avisa al generar un cobro (bajo charge_notifications_enabled).';
COMMENT ON COLUMN public.school_settings.collection_pre_due_enabled IS 'false = la escalera no manda los avisos de antes de vencer ni el del día.';
COMMENT ON COLUMN public.school_settings.overdue_notices_enabled IS 'false = ningún mensaje de mora: ni el aviso de vencido ni los escalones +3/+10/+20.';
COMMIT;
