-- Avisos de mora (cobro vencido) por escuela, separados de «cobro generado».
-- Hasta hoy charge_notifications_enabled prendía las dos cosas juntas; Monster quiere los avisos
-- normales de cobros pero NINGÚN mensaje de moroso. Default true = nada cambia para las demás.
BEGIN;
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS overdue_notices_enabled boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.school_settings.overdue_notices_enabled IS
  'false = el BFF no manda el aviso de cobro vencido (WhatsApp/correo) a las familias de esta escuela. charge_notifications_enabled sigue gobernando el aviso de cobro generado.';
UPDATE public.school_settings SET overdue_notices_enabled = false
 WHERE school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';  -- Monster´s Volley Club
COMMIT;
