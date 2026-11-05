-- La respuesta al «Sí» de una campaña iba hasta 1024 caracteres; el texto de la clínica de
-- Monster mide ~2.100 y WhatsApp admite 4096 por mensaje. Sube el tope a 4000.
BEGIN;
ALTER TABLE public.whatsapp_campanas DROP CONSTRAINT IF EXISTS whatsapp_campanas_respuesta_si_check;
ALTER TABLE public.whatsapp_campanas ADD CONSTRAINT whatsapp_campanas_respuesta_si_check
    CHECK (respuesta_si IS NULL OR (length(respuesta_si) >= 1 AND length(respuesta_si) <= 4000));
COMMIT;
