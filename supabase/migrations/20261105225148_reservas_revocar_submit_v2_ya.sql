-- =============================================================================
-- 20261105225148_reservas_revocar_submit_v2_ya.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105222237
-- Objetivo: cerrar YA (sin esperar a la M7) la vía vieja de reserva directa
--           submit_facility_booking_v2.
-- =============================================================================
-- ORDEN EN PRODUCCIÓN: puede aplicarse en cualquier momento, junto con las migraciones 1-5 del cierre
--   de seguridad (aplicar-1-a-N.sql). Es independiente de M7 (20261105213611), que sigue yendo AL FINAL.
-- PRECONDICIONES: ninguna. Idempotente (REVOKE es repetible).
--
-- POR QUÉ (revisión adversarial 2026-11-06, hallazgo A1, ALTO, VIVO hoy en producción):
--   submit_facility_booking_v2 (SECURITY DEFINER) sigue con EXECUTE para `authenticated` y NO tiene
--   llamadores en frontend/src ni bff/src. Solo exige el entitlement de la escuela, no membresía:
--   se salta bookable_by, menores, horario, anticipación y el tope de reservas activas del motor
--   nuevo, e inserta una reserva 'pending' que ocupa la franja de forma permanente (expirar_holds
--   solo toca hold y pending_payment). Con cuentas gratis, cualquiera bloquea franjas ajenas.
--   La M7 ya lo revoca, pero la M7 espera al despliegue del frontend; esta función no tiene
--   llamadores, así que se cierra ahora.
--
-- Después de esto solo service_role (y el dueño de la función) la ejecutan.
-- =============================================================================

BEGIN;

REVOKE ALL ON FUNCTION public.submit_facility_booking_v2(
  uuid, uuid, date, time without time zone, time without time zone,
  text, text, text, integer, text, numeric, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_facility_booking_v2(
  uuid, uuid, date, time without time zone, time without time zone,
  text, text, text, integer, text, numeric, text, text
) TO service_role;

-- La v1 ya quedó sin EXECUTE para clientes en 20261105163329; se reafirma por si algún entorno la conserva.
DO $$
BEGIN
  IF to_regprocedure('public.submit_facility_booking(uuid, uuid, date, time without time zone, time without time zone, integer, text, text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.submit_facility_booking(uuid, uuid, date, time without time zone, time without time zone, integer, text, text) FROM PUBLIC, anon, authenticated';
  END IF;
END $$;

COMMIT;
