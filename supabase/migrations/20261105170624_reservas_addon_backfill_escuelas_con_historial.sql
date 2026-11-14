-- =============================================================================
-- 20261105170624_reservas_addon_backfill_escuelas_con_historial.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105164434
--
-- ORDEN REQUERIDO: aplicar ANTES de 20261105163329_reservas_gate_entitlement_submit_v2
--   (aunque su versión sea posterior: se aplican en el orden que decida quien migra;
--   esta migración es de datos y no depende de nada de F1 salvo que school_addons
--   admita addon_key 'reservations', cosa que hizo 20261014153542).
--
-- Objetivo: que ninguna escuela que ya usa reservas pierda el módulo cuando se aplique el
--   gate de entitlement. Toda escuela con filas en facility_reservations y sin el addon
--   'reservations' lo recibe (enabled = true). Radio medido en vivo el 2026-11-05:
--   MMA BLAIR TEAM (19 reservas, cliente real), Club Campestre Demo y Escuela Demo SportMaps.
-- Idempotente: UNIQUE (school_id, addon_key) + ON CONFLICT DO NOTHING. Si la fila existe
--   deshabilitada (enabled = false) se respeta la decisión previa y no se reactiva.
-- Columnas de school_addons: school_id, addon_key (obligatorias); enabled, enabled_at,
--   monthly_price_cents (0), metadata ({}) tienen default.
-- =============================================================================

BEGIN;

INSERT INTO public.school_addons (school_id, addon_key, enabled, metadata)
SELECT DISTINCT COALESCE(r.school_id, f.school_id), 'reservations', true,
       jsonb_build_object('origen', 'backfill_escuelas_con_historial_2026-11-05')
  FROM public.facility_reservations r
  JOIN public.facilities f ON f.id = r.facility_id
 WHERE COALESCE(r.school_id, f.school_id) IS NOT NULL
ON CONFLICT (school_id, addon_key) DO NOTHING;

COMMIT;
