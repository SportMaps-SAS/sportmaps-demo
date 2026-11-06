-- =============================================================================
-- 20261105162243_seguridad_reservas_cierre.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105124322
-- Objetivo: cerrar los huecos de seguridad e integridad que quedaron en el módulo
--   de reservas de instalaciones antes de construir el motor F1
--   (docs/specs/reservas-canchas-f1-plan-migraciones.md, ítems (a)(1),(3),(4),(5)):
--
--   (1) facilities_update_admin era FOR UPDATE USING (is_school_admin(school_id))
--       SIN WITH CHECK: un admin podía mover una instalación a OTRA escuela
--       cambiando school_id (I3). Se recrea con WITH CHECK.
--   (3) get_facility_availability devolvía row_to_json(f): TODA la fila de la
--       instalación (tarifas, abono, notas de alquiler) y el estado de cada reserva.
--       Hoy solo la llama service_role (revocada el 2026-10-05) y no hay ningún
--       consumidor en frontend/src ni bff/src (verificado con grep), así que se
--       reduce a columnas publicables sin romper a nadie.
--   (4) El trigger de solapamiento viejo (fn_check_facility_reservation_overlap)
--       solo miraba pending/confirmed. Ahora también ve hold y pending_payment
--       VIGENTES (un hold vencido no bloquea). Además el índice único por hora de
--       inicio contaba 'expired' como ocupado: un hold vencido a las 9:00 impedía
--       reservar de nuevo a las 9:00. Se recrea excluyendo expired y
--       pending_reconciliation.
--       DESVÍO RESPECTO DEL PEDIDO: pending_reconciliation NO cuenta como ocupante
--       en el trigger. Esa fila es "pagó pero la franja ya la tomó otro": no
--       ocupa nada (su ocupación queda 'released'). Si contara, confirmar_pago_reserva
--       no podría marcar esa reserva (chocaría con la ganadora) y la franja
--       aparecería libre en la disponibilidad pero rechazada al reservar.
--   (5) Se revocan los grants de escritura (y TRUNCATE/REFERENCES/TRIGGER) de anon
--       sobre facilities y facility_availability: grants inertes (las policies de
--       escritura piden is_school_admin) pero del patrón I1.
--
--   El gate de entitlement de submit_facility_booking_v2 va en una migración
--   aparte marcada NO APLICAR (hasta medir el radio) y el pg_cron va al final.
--   Orden de aplicación requerido: PRIMERA de las migraciones de reservas F1 (después de F0).
-- =============================================================================

BEGIN;

-- ── (1) facilities_update_admin con WITH CHECK ───────────────────────────────
DROP POLICY IF EXISTS facilities_update_admin ON public.facilities;
CREATE POLICY facilities_update_admin ON public.facilities
  FOR UPDATE
  USING (public.is_school_admin(school_id))
  WITH CHECK (public.is_school_admin(school_id));

-- ── (3) get_facility_availability: solo columnas publicables ─────────────────
CREATE OR REPLACE FUNCTION public.get_facility_availability(p_facility_id uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_fac    jsonb;
  v_booked jsonb;
  v_ini    timestamptz;
  v_fin    timestamptz;
BEGIN
  SELECT jsonb_build_object(
           'id',              f.id,
           'name',            f.name,
           'type',            f.type,
           'capacity',        f.capacity,
           'available_hours', f.available_hours,
           'booking_enabled', COALESCE(f.booking_enabled, true))
    INTO v_fac
    FROM public.facilities f
   WHERE f.id = p_facility_id AND f.status = 'available';

  IF v_fac IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  v_ini := (p_date::timestamp) AT TIME ZONE 'America/Bogota';
  v_fin := ((p_date + 1)::timestamp) AT TIME ZONE 'America/Bogota';

  -- Horas ocupadas: reservas vigentes del esquema viejo + ocupación única
  -- (clases, bloqueos, holds vigentes). Solo inicio y fin; sin estado ni dueño.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('start_time', x.t0, 'end_time', x.t1) ORDER BY x.t0, x.t1), '[]'::jsonb)
    INTO v_booked
    FROM (
      SELECT fr.start_time AS t0, fr.end_time AS t1
        FROM public.facility_reservations fr
       WHERE fr.facility_id = p_facility_id
         AND fr.reservation_date = p_date
         AND (fr.status IN ('pending', 'confirmed')
              OR (fr.status IN ('hold', 'pending_payment')
                  AND (fr.hold_expires_at IS NULL OR fr.hold_expires_at > now())))
      UNION
      SELECT (lower(o.slot) AT TIME ZONE 'America/Bogota')::time,
             (upper(o.slot) AT TIME ZONE 'America/Bogota')::time
        FROM public.facility_occupancy o
       WHERE o.facility_id = p_facility_id
         AND o.slot && tstzrange(v_ini, v_fin)
         AND (o.status = 'active' OR (o.status = 'hold' AND o.hold_expires_at > now()))
    ) x;

  RETURN jsonb_build_object('facility', v_fac, 'booked_slots', v_booked);
END;
$$;

REVOKE ALL ON FUNCTION public.get_facility_availability(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_facility_availability(uuid, date) TO service_role;

-- ── (4) Solapamiento viejo: ve también hold y pending_payment vigentes ───────
CREATE OR REPLACE FUNCTION public.fn_check_facility_reservation_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Solo valida cuando la fila entrante OCUPA (pending, confirmed, o un hold /
  -- pending_payment todavía vigente). cancelled, expired, completed, no_show y
  -- pending_reconciliation no ocupan.
  IF NEW.status IN ('pending', 'confirmed')
     OR (NEW.status IN ('hold', 'pending_payment')
         AND (NEW.hold_expires_at IS NULL OR NEW.hold_expires_at > now())) THEN
    IF EXISTS (
      SELECT 1 FROM public.facility_reservations o
       WHERE o.facility_id = NEW.facility_id
         AND o.reservation_date = NEW.reservation_date
         AND o.id <> NEW.id
         AND (o.status IN ('pending', 'confirmed')
              OR (o.status IN ('hold', 'pending_payment')
                  AND (o.hold_expires_at IS NULL OR o.hold_expires_at > now())))
         AND (NEW.start_time, NEW.end_time) OVERLAPS (o.start_time, o.end_time)
    ) THEN
      RAISE EXCEPTION 'facility_slot_conflict: ya existe una reserva activa para % el % entre % y %',
        NEW.facility_id, NEW.reservation_date, NEW.start_time, NEW.end_time
        USING ERRCODE = '23P01';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- El índice único por (cancha, fecha, hora de inicio) contaba 'expired' y
-- 'pending_reconciliation' como ocupantes. Se recrea acotado a los estados del esquema
-- viejo; hold y pending_payment los cubre el EXCLUDE de facility_occupancy (que sí respeta
-- el vencimiento del hold).
DROP INDEX IF EXISTS public.facility_reservations_unique_active_slot;
CREATE UNIQUE INDEX facility_reservations_unique_active_slot
  ON public.facility_reservations (facility_id, reservation_date, start_time)
  WHERE status IN ('pending', 'confirmed', 'completed', 'no_show');

-- ── (5) anon sin escritura sobre facilities / facility_availability ──────────
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.facilities         FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.facility_availability FROM anon;

COMMIT;
