-- =============================================================================
-- 20261106152913_demo_futbol_enciende_partido_vivo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261106150242
-- Objetivo: encender «Partido en vivo» (school_settings.live_match_enabled) SOLO
--   en la escuela demo «Academia Fútbol Demo» (25a123f0-…), para probar el flujo
--   completo (agendar → llevar en vivo → informe PDF) antes de encenderlo en Carmel (esta es la escuela del coach demo de fútbol).
-- PRECONDICIÓN: migraciones de partido en vivo aplicadas (columna live_match_enabled).
--   Con guarda: si la columna no existe, no hace nada y avisa. Idempotente.
-- RADIO: 1 fila (demo). Carmel y las demás quedan en false.
-- REVERSA: UPDATE public.school_settings SET live_match_enabled = false
--          WHERE school_id = '6a816b7c-81f0-4ab1-82da-756f2cb2adb1';
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
       AND column_name = 'live_match_enabled'
  ) THEN
    RAISE NOTICE 'school_settings.live_match_enabled no existe: no se hizo nada.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.school_settings
     WHERE school_id = '6a816b7c-81f0-4ab1-82da-756f2cb2adb1'::uuid
  ) THEN
    RAISE EXCEPTION 'La escuela demo no tiene fila en school_settings';
  END IF;

  EXECUTE $q$
    UPDATE public.school_settings
       SET live_match_enabled = true
     WHERE school_id = '6a816b7c-81f0-4ab1-82da-756f2cb2adb1'::uuid
       AND live_match_enabled IS DISTINCT FROM true
  $q$;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'Demo live_match_enabled: % fila(s) cambiada(s) (0 = ya estaba encendido).', n;
END $$;

COMMIT;
