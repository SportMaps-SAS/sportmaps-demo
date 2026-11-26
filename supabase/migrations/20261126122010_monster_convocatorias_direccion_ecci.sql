-- =============================================================================
-- 20261126122010_monster_convocatorias_direccion_ecci.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126111320
-- Objetivo: las sesiones de convocatoria de Monster's en la Universidad ECCI
--   (Sede Norte y equipos mayores) llevan la dirección completa, la misma de la
--   clínica: «Universidad ECCI, Campus 170 (Cl. 170 #49b-96), Bogotá» + Maps.
--   Antes decían solo «Universidad ECCI». Las de Locos por Pádel no cambian.
-- =============================================================================
-- Recordatorios (CLAUDE.md): inmutable una vez commiteada.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_escuela constant uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
    v_n int;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.schools WHERE id = v_escuela) THEN
        RAISE NOTICE 'Monster no existe en esta base: se omite';
        RETURN;
    END IF;

    UPDATE public.bot_oferta_sesiones s
       SET lugar = 'Universidad ECCI, Campus 170 (Cl. 170 #49b-96), Bogotá · https://maps.app.goo.gl/QCwRCPuVbKiW9zVk7'
      FROM public.bot_ofertas o
     WHERE o.id = s.oferta_id AND o.school_id = v_escuela AND s.school_id = v_escuela
       AND s.lugar = 'Universidad ECCI';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'sesiones en ECCI con dirección: %', v_n;
END $$;

COMMIT;
