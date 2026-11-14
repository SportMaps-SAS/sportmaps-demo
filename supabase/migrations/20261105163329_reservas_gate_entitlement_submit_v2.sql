-- =============================================================================
-- 20261105163329_reservas_gate_entitlement_submit_v2.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105163229
--
-- NO APLICAR hasta medir radio
--   Correr antes supabase/verificaciones/reservas-radio-entitlement.sql. Esta migración
--   rompe el ALQUILER A EXTERNOS de las canchas con rental_enabled = true cuyas escuelas
--   NO tienen has_entitlement('reservations') (el plan habla de 12 canchas). Si el radio da
--   >0 con reservas recientes, primero se les activa el addon o se acepta el corte.
--
-- ORDEN REQUERIDO: aplicar DESPUÉS de reservas_addon_backfill_escuelas_con_historial (que da el
--   addon a las escuelas con reservas reales: MMA BLAIR TEAM, Club Campestre Demo, Escuela Demo)
--   y después de reservas_f1_columnas (índices/triggers de ocupación). Sin el backfill, las
--   escuelas con historial pero sin addon perderían el alquiler a externos.
--
-- Objetivo: submit_facility_booking_v2 (esquema viejo, solicitud + aprobación):
--   · search_path fijo (antes solo 'public').
--   · Gate: con entitlement → pasa como hoy. Sin entitlement → solo puede solicitar quien es
--     miembro de ESA escuela y NO es alquiler (p_resv_type <> 'rental'). Un externo o un
--     alquiler en una escuela sin el addon → 'entitlement_required'.
--   · El chequeo de choque ahora ve también hold/pending_payment vigentes, y un choque con una
--     clase o bloqueo (23P01 desde facility_occupancy) responde 'time_conflict'.
--   · Se revoca EXECUTE de submit_facility_booking (v1, 8 argumentos) a PUBLIC/anon/authenticated:
--     no tiene llamadores en frontend ni bff y permitía saltarse el gate de v2.
--   · Los errores inesperados ya no exponen SQLERRM: devuelven 'booking_failed' (el detalle queda en el log).
-- Mismo contrato de retorno que antes (jsonb ok/error). Sin cambio de firma ni de grants.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_facility_booking_v2(
  p_school_id uuid, p_facility_id uuid, p_reservation_date date,
  p_start_time time without time zone, p_end_time time without time zone,
  p_booker_type text DEFAULT 'parent', p_resv_type text DEFAULT 'internal',
  p_external_org_name text DEFAULT NULL, p_participants integer DEFAULT 1,
  p_notes text DEFAULT NULL, p_deposit_amount numeric DEFAULT NULL,
  p_deposit_method text DEFAULT 'transfer', p_deposit_receipt text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid             uuid := auth.uid();
  v_reservation_id  uuid;
  v_payment_id      uuid;
  v_hourly_rate     numeric;
  v_min_deposit_pct integer;
  v_rental_rate     numeric;
  v_rental_enabled  boolean;
  v_booking_enabled boolean;
  v_hours           numeric;
  v_price           numeric;
  v_min_deposit     numeric;
  v_conflict        boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  -- Gate de entitlement (ver encabezado).
  IF NOT COALESCE(public.has_entitlement(p_school_id, 'reservations'), false) THEN
    IF p_resv_type = 'rental' OR NOT (p_school_id = ANY (public.user_school_ids())) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'entitlement_required');
    END IF;
  END IF;

  SELECT hourly_rate, booking_enabled, min_deposit_pct, rental_enabled, rental_rate
  INTO   v_hourly_rate, v_booking_enabled, v_min_deposit_pct, v_rental_enabled, v_rental_rate
  FROM public.facilities
  WHERE id = p_facility_id AND school_id = p_school_id AND status = 'available';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'facility_not_found');
  END IF;
  IF NOT COALESCE(v_booking_enabled, true) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'booking_disabled');
  END IF;
  IF p_resv_type = 'rental' AND NOT v_rental_enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rental_not_enabled');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.facility_reservations
    WHERE facility_id = p_facility_id
      AND reservation_date = p_reservation_date
      AND (status IN ('pending', 'confirmed')
           OR (status IN ('hold', 'pending_payment') AND (hold_expires_at IS NULL OR hold_expires_at > now())))
      AND (p_start_time, p_end_time) OVERLAPS (start_time, end_time)
  ) INTO v_conflict;

  IF v_conflict THEN
    RETURN jsonb_build_object('ok', false, 'error', 'time_conflict');
  END IF;

  v_hours := EXTRACT(EPOCH FROM (p_end_time - p_start_time)) / 3600.0;
  IF p_resv_type = 'rental' AND v_rental_rate IS NOT NULL THEN
    v_price := ROUND(v_hours * v_rental_rate);
  ELSE
    v_price := ROUND(v_hours * COALESCE(v_hourly_rate, 0));
  END IF;

  v_min_deposit := ROUND(v_price * v_min_deposit_pct / 100.0);

  IF p_deposit_amount IS NOT NULL AND p_deposit_amount < v_min_deposit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'deposit_too_low',
      'min_deposit', v_min_deposit, 'min_deposit_pct', v_min_deposit_pct);
  END IF;

  INSERT INTO public.facility_reservations (
    facility_id, user_id, school_id, reservation_date, start_time, end_time,
    status, price, participants, notes, booker_type, resv_type, external_org_name,
    min_deposit_pct, payment_status
  ) VALUES (
    p_facility_id, v_uid, p_school_id, p_reservation_date, p_start_time, p_end_time,
    'pending', v_price, p_participants, p_notes,
    p_booker_type::public.booker_type, p_resv_type::public.resv_type, p_external_org_name,
    v_min_deposit_pct, 'unpaid'
  ) RETURNING id INTO v_reservation_id;

  IF p_deposit_amount IS NOT NULL AND p_deposit_amount > 0 THEN
    INSERT INTO public.reservation_payments (
      reservation_id, user_id, school_id, amount, payment_method, receipt_url, notes, status
    ) VALUES (
      v_reservation_id, v_uid, p_school_id, p_deposit_amount, p_deposit_method::public.pay_method,
      p_deposit_receipt, 'Abono inicial', 'pending_review'
    ) RETURNING id INTO v_payment_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reservation_id', v_reservation_id, 'payment_id', v_payment_id,
    'hours', v_hours, 'price', v_price, 'min_deposit', v_min_deposit,
    'amount_paid', COALESCE(p_deposit_amount, 0));
EXCEPTION
  WHEN exclusion_violation OR unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'error', 'time_conflict');
  WHEN OTHERS THEN
    RAISE WARNING 'submit_facility_booking_v2 % / %: %', p_facility_id, v_uid, SQLERRM;
    RETURN jsonb_build_object('ok', false, 'error', 'booking_failed');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_facility_booking(uuid, uuid, date, time without time zone, time without time zone, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_facility_booking(uuid, uuid, date, time without time zone, time without time zone, integer, text, text)
  TO service_role;

COMMIT;
