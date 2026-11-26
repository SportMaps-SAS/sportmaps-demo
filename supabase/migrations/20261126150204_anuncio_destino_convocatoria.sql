-- =============================================================================
-- anuncio_destino_convocatoria
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26
-- Objetivo: en WhatsApp › Anuncios, «este anuncio va a…» acepta «Convocatorias»
--   (destino 'convocatoria'): el bot lleva a quien llega por ese anuncio a la
--   convocatoria guiada de la escuela (bot_ofertas). Sin convocatorias vigentes,
--   a una persona; nunca a la clase de prueba. Solo se amplía el CHECK.
-- =============================================================================
-- Recordatorios (CLAUDE.md): inmutable una vez commiteada.
-- =============================================================================

BEGIN;

ALTER TABLE public.whatsapp_anuncio_destino
    DROP CONSTRAINT whatsapp_anuncio_destino_destino_check,
    ADD CONSTRAINT whatsapp_anuncio_destino_destino_check
        CHECK (destino IN ('clase_prueba', 'servicio', 'persona', 'convocatoria'));

COMMENT ON COLUMN public.whatsapp_anuncio_destino.destino IS
    'clase_prueba | servicio (servicio_id) | persona (buzón) | convocatoria (convocatoria guiada de bot_ofertas). (20261104115612, convocatoria 2026-11-26)';

COMMIT;
