-- =============================================================================
-- monster_sin_clase_de_prueba_desde_hoy
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26
-- Objetivo: orden de la escuela (Monster's, 2026-11-26): NO MÁS clases de prueba,
--   tampoco el fin de semana 28–29 nov. A quien pide una convocatoria se le
--   envía la convocatoria. El bloqueo de clase de prueba arranca HOY (antes
--   1-dic) y sigue hasta el 31-ene; se cierran los cupos abiertos que quedaban
--   (28 y 29 nov). Las reservas ya separadas NO se tocan: las atiende la escuela.
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

    UPDATE public.bot_oferta_bloqueos
       SET desde = DATE '2026-11-26',
           motivo = 'Sin clases de prueba: se ofrecen las convocatorias (pedido de la escuela 2026-11-25; desde el 26-nov por orden del 2026-11-26).'
     WHERE school_id = v_escuela AND tipo = 'clase_prueba' AND hasta = DATE '2027-01-31';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'Se esperaba 1 bloqueo de clase de prueba y se tocaron %', v_n; END IF;

    UPDATE public.school_trial_slots
       SET is_open = false
     WHERE school_id = v_escuela AND is_open AND slot_date BETWEEN DATE '2026-11-26' AND DATE '2026-11-30';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'cupos de clase de prueba cerrados: %', v_n;
END $$;

COMMIT;
