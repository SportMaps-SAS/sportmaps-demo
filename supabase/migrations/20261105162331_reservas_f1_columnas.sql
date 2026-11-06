-- =============================================================================
-- 20261105162331_reservas_f1_columnas.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105162243
-- Objetivo: F1 · M1 — columnas que faltan para el motor de reservas
--   (docs/specs/reservas-canchas-f1-plan-migraciones.md §2, contrato en
--    docs/specs/reservas-canchas-f1-contrato.md §1).
--
--   F0 (20261014153538) YA dejó en facility_reservations: starts_at, ends_at,
--   hold_expires_at, idempotency_key + UNIQUE (school_id, idempotency_key),
--   channel, guest_booker_id, payment_id, price_snapshot, recurrence_id,
--   cancelled_by, refund_status, y el CHECK de status con 9 valores. El motivo de
--   cancelación YA existe como cancellation_reason (NO se crea cancel_reason).
--
--   Aquí:
--     facilities:           bookable_by, slot_step_min, min_duration_min (+ backfill)
--     facility_reservations: payment_reference (+UNIQUE), user_id nullable
--                            (reserva de invitado), UNIQUE de ocupación por fuente,
--                            y dos triggers que hacen que TODO escritor (RPC, panel
--                            del staff, solicitud del padre) deje su franja en
--                            facility_occupancy en la misma transacción.
--
--   Orden de aplicación requerido: después de 20261014153538 (F0, tablas y columnas) y de
--   20261105162243 (seguridad_reservas_cierre).
--
--   Status 'pending' (solicitud + aprobación del admin) SIGUE siendo válido y
--   ocupa la franja; no se migra ninguna fila: hoy hay 0 reservas futuras.
-- =============================================================================

BEGIN;

-- ── facilities ───────────────────────────────────────────────────────────────
ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS bookable_by       text    NOT NULL DEFAULT 'members',
  ADD COLUMN IF NOT EXISTS slot_step_min     integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS min_duration_min  integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS max_duration_min  integer NOT NULL DEFAULT 240;

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_bookable_by_check,
  ADD  CONSTRAINT facilities_bookable_by_check
       CHECK (bookable_by IN ('members', 'public', 'both'));

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_slot_step_min_check,
  ADD  CONSTRAINT facilities_slot_step_min_check
       CHECK (slot_step_min BETWEEN 5 AND 240);

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_min_duration_min_check,
  ADD  CONSTRAINT facilities_min_duration_min_check
       CHECK (min_duration_min > 0);

ALTER TABLE public.facilities
  DROP CONSTRAINT IF EXISTS facilities_max_duration_min_check,
  ADD  CONSTRAINT facilities_max_duration_min_check
       CHECK (max_duration_min > 0);

-- Backfill: lo que ya se alquilaba (rental_enabled) arranca abierto a ambos;
-- lo demás, solo miembros (no se abre al público lo que nunca estuvo abierto).
UPDATE public.facilities
   SET bookable_by = 'both'
 WHERE rental_enabled = true
   AND bookable_by = 'members';

COMMENT ON COLUMN public.facilities.bookable_by IS
  'Quién puede reservar: members (vinculados a la escuela), public (cualquiera, tarifa pública) o both (miembros con tarifa member, externos con tarifa public). El staff siempre puede.';
COMMENT ON COLUMN public.facilities.slot_step_min IS
  'Paso de la grilla de reservas en minutos: inicios y duraciones son múltiplos de este valor.';
COMMENT ON COLUMN public.facilities.min_duration_min IS
  'Duración mínima de una reserva en minutos.';
COMMENT ON COLUMN public.facilities.max_duration_min IS
  'Duración máxima de una reserva en minutos para quien no es staff (anti-acaparamiento). Por defecto 240.';
COMMENT ON COLUMN public.facilities.booking_enabled IS
  'false = la instalación no recibe reservas (espacio de entrenamiento). Las clases siguen ocupando la franja. NULL se trata como true.';

-- ── facility_reservations ────────────────────────────────────────────────────
ALTER TABLE public.facility_reservations
  ADD COLUMN IF NOT EXISTS payment_reference text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_facility_reservations_payment_reference
  ON public.facility_reservations (payment_reference)
  WHERE payment_reference IS NOT NULL;

COMMENT ON COLUMN public.facility_reservations.payment_reference IS
  'Referencia estable RSV-XXXXXXXXXXXXXXXX (16 hex del id) para la pasarela y confirmar_pago_reserva.';

-- Reserva de invitado: sin cuenta, user_id NULL y guest_booker_id lleno.
ALTER TABLE public.facility_reservations ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.facility_reservations
  DROP CONSTRAINT IF EXISTS facility_reservations_booker_check,
  ADD  CONSTRAINT facility_reservations_booker_check
       CHECK (user_id IS NOT NULL OR guest_booker_id IS NOT NULL);

-- expirar_holds recorre hold y pending_payment vencidos (el índice de F0 solo cubría 'hold').
CREATE INDEX IF NOT EXISTS idx_facility_reservations_hold_vencimiento
  ON public.facility_reservations (hold_expires_at)
  WHERE status IN ('hold', 'pending_payment');

-- Una fila de ocupación por fuente (reserva, clase, bloqueo): permite upsert idempotente.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facility_occupancy_fuente
  ON public.facility_occupancy (source_kind, source_id)
  WHERE source_kind IN ('rental', 'class', 'blackout');

-- ── Trigger BEFORE: mantener starts_at/ends_at y las columnas viejas alineadas ─
-- RPC (GUC sportmaps.rpc_reservas = 'on'): el rango con zona manda y deriva fecha/horas.
-- Cualquier otro escritor (panel del staff, solicitud del padre): manda fecha/horas
-- (así el precio que recalcula la guarda M0 y el rango ocupado son el MISMO).
CREATE OR REPLACE FUNCTION public.fn_facility_resv_rango()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rpc            boolean := COALESCE(current_setting('sportmaps.rpc_reservas', true), '') = 'on';
  v_legacy_changed boolean;
  v_range_changed  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_rpc AND NEW.starts_at IS NOT NULL AND NEW.ends_at IS NOT NULL THEN
      NEW.reservation_date := (NEW.starts_at AT TIME ZONE 'America/Bogota')::date;
      NEW.start_time       := (NEW.starts_at AT TIME ZONE 'America/Bogota')::time;
      NEW.end_time         := (NEW.ends_at   AT TIME ZONE 'America/Bogota')::time;
    ELSE
      NEW.starts_at := (NEW.reservation_date + NEW.start_time) AT TIME ZONE 'America/Bogota';
      NEW.ends_at   := (NEW.reservation_date + NEW.end_time)   AT TIME ZONE 'America/Bogota';
    END IF;
    RETURN NEW;
  END IF;

  v_legacy_changed := (NEW.reservation_date, NEW.start_time, NEW.end_time)
                      IS DISTINCT FROM (OLD.reservation_date, OLD.start_time, OLD.end_time);
  v_range_changed  := (NEW.starts_at, NEW.ends_at)
                      IS DISTINCT FROM (OLD.starts_at, OLD.ends_at);

  IF v_range_changed AND (v_rpc OR NOT v_legacy_changed) THEN
    NEW.reservation_date := (NEW.starts_at AT TIME ZONE 'America/Bogota')::date;
    NEW.start_time       := (NEW.starts_at AT TIME ZONE 'America/Bogota')::time;
    NEW.end_time         := (NEW.ends_at   AT TIME ZONE 'America/Bogota')::time;
  ELSIF v_legacy_changed OR NEW.starts_at IS NULL OR NEW.ends_at IS NULL THEN
    NEW.starts_at := (NEW.reservation_date + NEW.start_time) AT TIME ZONE 'America/Bogota';
    NEW.ends_at   := (NEW.reservation_date + NEW.end_time)   AT TIME ZONE 'America/Bogota';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_facility_resv_rango() FROM PUBLIC, anon, authenticated;

-- Orden alfabético de los BEFORE: trg_aa_guarda… < trg_b_… < trg_check_facility_overlap.
DROP TRIGGER IF EXISTS trg_b_facility_resv_rango ON public.facility_reservations;
CREATE TRIGGER trg_b_facility_resv_rango
  BEFORE INSERT OR UPDATE ON public.facility_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_resv_rango();

-- ── Trigger AFTER: la reserva escribe su ocupación en la misma transacción ───
--   hold / pending_payment con vencimiento → hold hasta hold_expires_at
--   pending / confirmed / completed / no_show / pending_payment sin vencimiento → active
--   cancelled / expired / pending_reconciliation → released
-- El EXCLUDE de facility_occupancy lanza 23P01 si la franja ya está ocupada
-- (alquiler, clase, evento o bloqueo): el escritor se entera en el mismo INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public.fn_facility_resv_sync_ocupacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_estado text;
  v_school uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.facility_occupancy
       SET status = 'released', updated_at = now()
     WHERE source_kind = 'rental' AND source_id = OLD.id AND status <> 'released';
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.status          IS NOT DISTINCT FROM OLD.status
     AND NEW.starts_at       IS NOT DISTINCT FROM OLD.starts_at
     AND NEW.ends_at         IS NOT DISTINCT FROM OLD.ends_at
     AND NEW.facility_id     IS NOT DISTINCT FROM OLD.facility_id
     AND NEW.hold_expires_at IS NOT DISTINCT FROM OLD.hold_expires_at THEN
    RETURN NULL;
  END IF;

  IF NEW.starts_at IS NULL OR NEW.ends_at IS NULL OR NEW.ends_at <= NEW.starts_at THEN
    RETURN NULL;
  END IF;

  v_estado := CASE
    WHEN NEW.status IN ('cancelled', 'expired', 'pending_reconciliation') THEN 'released'
    WHEN NEW.status IN ('hold', 'pending_payment') AND NEW.hold_expires_at IS NOT NULL
         THEN CASE WHEN NEW.hold_expires_at > now() THEN 'hold' ELSE 'released' END
    ELSE 'active'
  END;

  SELECT f.school_id INTO v_school FROM public.facilities f WHERE f.id = NEW.facility_id;
  v_school := COALESCE(NEW.school_id, v_school);

  UPDATE public.facility_occupancy
     SET school_id       = v_school,
         facility_id     = NEW.facility_id,
         slot            = tstzrange(NEW.starts_at, NEW.ends_at, '[)'),
         status          = v_estado,
         hold_expires_at = CASE WHEN v_estado = 'hold' THEN NEW.hold_expires_at END,
         updated_at      = now()
   WHERE source_kind = 'rental' AND source_id = NEW.id;

  IF NOT FOUND AND v_estado <> 'released' THEN
    INSERT INTO public.facility_occupancy
      (school_id, facility_id, slot, source_kind, source_id, status, hold_expires_at)
    VALUES
      (v_school, NEW.facility_id, tstzrange(NEW.starts_at, NEW.ends_at, '[)'), 'rental', NEW.id,
       v_estado, CASE WHEN v_estado = 'hold' THEN NEW.hold_expires_at END);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_facility_resv_sync_ocupacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_facility_resv_sync_ocupacion ON public.facility_reservations;
CREATE TRIGGER trg_facility_resv_sync_ocupacion
  AFTER INSERT OR UPDATE ON public.facility_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_resv_sync_ocupacion();

DROP TRIGGER IF EXISTS trg_facility_resv_sync_ocupacion_del ON public.facility_reservations;
CREATE TRIGGER trg_facility_resv_sync_ocupacion_del
  AFTER DELETE ON public.facility_reservations
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_resv_sync_ocupacion();

COMMIT;
