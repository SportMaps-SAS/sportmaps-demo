-- Respuesta con modelo al prospecto de WhatsApp (Dynasty 2026-10-28).
--
-- wa_ficha_prospectos: lo que la escuela le diría a un interesado (proceso de
--   inscripción, valores, uniforme, requisitos, sedes). Es la ÚNICA fuente de
--   lo que el modelo puede afirmar; sin ficha, el bot sigue con sus reglas de
--   siempre (bff/src/services/whatsapp-prospecto-ia.service.ts).
-- wa_estilo_respuesta: cómo escribe quien atiende el WhatsApp (tono).
--
-- Mismas policies de school_settings: la escuela las edita desde Ajustes.
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS wa_ficha_prospectos text,
    ADD COLUMN IF NOT EXISTS wa_estilo_respuesta text;

ALTER TABLE public.school_settings
    DROP CONSTRAINT IF EXISTS school_settings_wa_ficha_prospectos_len,
    ADD CONSTRAINT school_settings_wa_ficha_prospectos_len CHECK (wa_ficha_prospectos IS NULL OR length(wa_ficha_prospectos) <= 6000),
    DROP CONSTRAINT IF EXISTS school_settings_wa_estilo_respuesta_len,
    ADD CONSTRAINT school_settings_wa_estilo_respuesta_len CHECK (wa_estilo_respuesta IS NULL OR length(wa_estilo_respuesta) <= 1500);
