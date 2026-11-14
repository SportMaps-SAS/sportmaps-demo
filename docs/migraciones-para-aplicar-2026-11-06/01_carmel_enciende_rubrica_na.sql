-- =============================================================================
-- 20261105231542_carmel_enciende_rubrica_na.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105225148
-- Objetivo: encender el «No aplica» de las rúbricas SOLO para Carmel
--   (school_settings.rubric_allow_na = true, escuela 374a6716-…).
-- PRECONDICIÓN: 20261105213545 (crea la columna). Con guarda: si la columna no
--   existe, no hace nada y avisa. Idempotente (repetirla no cambia nada).
-- RADIO: 1 fila (Carmel). Las demás escuelas quedan en false.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'school_settings'
       AND column_name = 'rubric_allow_na'
  ) THEN
    RAISE NOTICE 'school_settings.rubric_allow_na no existe: no se hizo nada (aplica antes 20261105213545).';
    RETURN;
  END IF;

  EXECUTE $q$
    UPDATE public.school_settings
       SET rubric_allow_na = true
     WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b'::uuid
       AND rubric_allow_na IS DISTINCT FROM true
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Carmel rubric_allow_na: % fila(s) cambiada(s) (0 = ya estaba encendido).', n;

  IF NOT EXISTS (
    SELECT 1 FROM public.school_settings
     WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b'::uuid
  ) THEN
    RAISE EXCEPTION 'Carmel no tiene fila en school_settings';
  END IF;
END $$;

COMMIT;
