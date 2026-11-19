-- =============================================================================
-- 20261119120806_dreamers_ventana_comprobante_10_dias.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261118163548
-- Objetivo: Dreamers Gymnastics acepta comprobantes con fecha de hasta 10 días
--   atrás (antes 5, el default). Es el check 6 del veredicto de comprobantes:
--   school_settings.receipt_date_window_days. Solo datos, sin DDL: no recarga
--   el esquema de PostgREST.
-- NO toca glosa_response_days (plazo de respuesta a la glosa): sigue en 5.
-- =============================================================================

BEGIN;

UPDATE public.school_settings
   SET receipt_date_window_days = 10
 WHERE school_id = '57ba9352-2c11-4b5b-aa5b-e5ec6f526cbe'   -- Dreamers Gymnastics
   AND receipt_date_window_days IS DISTINCT FROM 10;

COMMIT;
