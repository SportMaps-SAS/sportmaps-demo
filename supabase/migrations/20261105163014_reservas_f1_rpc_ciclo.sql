-- =============================================================================
-- 20261105163014_reservas_f1_rpc_ciclo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105162802
-- Objetivo: F1 · M5 — ciclo de vida de la reserva (spec §3).
--   Contrato: docs/specs/reservas-canchas-f1-contrato.md §4, §5, §6.
--
--   cancelar_reserva        cancela con política de reembolso; libera la ocupación.
--   reprogramar_reserva     atómico: UN UPDATE mueve la reserva y su ocupación; el EXCLUDE
--                           valida el rango nuevo sin soltar el viejo antes.
--   confirmar_pago_reserva  idempotente por evento de pasarela; nunca pierde un pago.
--                           SOLO service_role (webhook).
--   expirar_holds           reemplaza la de F0: ahora expira reservas hold/pending_payment
--                           vencidas, en lote (LIMIT 500, SKIP LOCKED). SOLO service_role.
--   helpers: _reservas_politica, _reservas_acceso, _reservas_alternativas.
--
-- Orden de aplicación requerido: después de reservas_f1_rpc_reservar (usa sus helpers y el GUC).
-- NO programa pg_cron: eso va en la migración reservas_cron_expirar_holds (aplicar al final).
-- =============================================================================

BEGIN;

-- ── helpers ──────────────────────────────────────────────────────────────────
-- Política de la cancha → de la escuela → por defecto 24 h / 6 h / 50 % (D10).
CREATE OR REPLACE FUNCTION public._reservas_politica(p_school_id uuid, p_facility_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_p public.cancellation_policies%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM public.cancellation_policies
   WHERE school_id = p_school_id AND facility_id = p_facility_id AND is_active;
  IF FOUND THEN
    RETURN jsonb_build_object('hours_full_refund', v_p.hours_full_refund, 'hours_partial_refund', v_p.hours_partial_refund,
                              'partial_pct', v_p.partial_pct, 'no_show_penalty_pct', v_p.no_show_penalty_pct, 'source', 'facility');
  END IF;

  SELECT * INTO v_p FROM public.cancellation_policies
   WHERE school_id = p_school_id AND facility_id IS NULL AND is_active;
  IF FOUND THEN
    RETURN jsonb_build_object('hours_full_refund', v_p.hours_full_refund, 'hours_partial_refund', v_p.hours_partial_refund,
                              'partial_pct', v_p.partial_pct, 'no_show_penalty_pct', v_p.no_show_penalty_pct, 'source', 'school');
  END IF;

  RETURN jsonb_build_object('hours_full_refund', 24, 'hours_partial_refund', 6,
                            'partial_pct', 50, 'no_show_penalty_pct', 100, 'source', 'default');
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_politica(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ¿Quién llama frente a esta reserva? 'staff' | 'owner' | NULL (sin permiso).
-- owner = el dueño con sesión, o (solo service_role) el invitado dueño que el BFF ya verificó.
CREATE OR REPLACE FUNCTION public._reservas_acceso(
  p_school_id uuid, p_res_user_id uuid, p_res_guest_id uuid, p_actor uuid, p_guest uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid := COALESCE(auth.uid(), p_actor);
BEGIN
  IF public._reservas_rol(p_school_id, v_actor) = 'staff' THEN
    RETURN 'staff';
  END IF;
  IF v_actor IS NOT NULL AND p_res_user_id = v_actor THEN
    RETURN 'owner';
  END IF;
  IF v_uid IS NULL AND p_guest IS NOT NULL AND p_res_guest_id = p_guest THEN
    RETURN 'owner';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_acceso(uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Próximas 3 franjas libres de esa cancha, misma duración, desde p_from.
CREATE OR REPLACE FUNCTION public._reservas_alternativas(
  p_school_id uuid, p_facility_id uuid, p_from timestamptz, p_dur_min integer, p_pref text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_day date := (p_from AT TIME ZONE 'America/Bogota')::date;
  v_av  jsonb;
  v_alt jsonb;
BEGIN
  v_av := public.disponibilidad_canchas(p_school_id, v_day, v_day + 2, NULL, p_facility_id, p_dur_min, p_pref, p_actor);
  SELECT COALESCE(jsonb_agg(x.slot ORDER BY x.ord), '[]'::jsonb) INTO v_alt
    FROM (SELECT (sl || jsonb_build_object('facility_id', p_facility_id)) AS slot, (sl ->> 'starts_at') AS ord
            FROM jsonb_array_elements(COALESCE(v_av -> 'facilities' -> 0 -> 'days', '[]'::jsonb)) AS d,
                 jsonb_array_elements(d -> 'slots') AS sl
           WHERE (sl ->> 'starts_at')::timestamptz >= p_from
           ORDER BY (sl ->> 'starts_at')
           LIMIT 3) x;
  RETURN v_alt;
EXCEPTION WHEN OTHERS THEN
  RETURN '[]'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_alternativas(uuid, uuid, timestamptz, integer, text, uuid) FROM PUBLIC, anon, authenticated;

-- ── cancelar_reserva ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_reserva(
  p_reservation_id   uuid,
  p_reason           text DEFAULT NULL,
  p_actor_profile_id uuid DEFAULT NULL,
  p_guest_booker_id  uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_r      public.facility_reservations%ROWTYPE;
  v_fac    public.facilities%ROWTYPE;
  v_acc    text;
  v_actor  uuid := COALESCE(auth.uid(), p_actor_profile_id);
  v_pol    jsonb;
  v_hours  numeric;
  v_pct    integer;
  v_refund numeric;
  v_rs     text;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;

  SELECT * INTO v_r FROM public.facility_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._reservas_err('RESERVATION_NOT_FOUND');
  END IF;
  SELECT * INTO v_fac FROM public.facilities WHERE id = v_r.facility_id;

  v_acc := public._reservas_acceso(v_fac.school_id, v_r.user_id, v_r.guest_booker_id, p_actor_profile_id, p_guest_booker_id);
  IF v_acc IS NULL THEN
    RETURN public._reservas_err('FORBIDDEN');
  END IF;

  IF v_r.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already_cancelled', true,
             'reservation', public._reservas_resultado(v_r.id) -> 'reservation',
             'refund', jsonb_build_object('status', v_r.refund_status));
  END IF;
  IF v_r.status NOT IN ('hold', 'pending_payment', 'pending', 'confirmed', 'pending_reconciliation') THEN
    RETURN public._reservas_err('INVALID_STATE');
  END IF;

  v_hours := EXTRACT(EPOCH FROM (v_r.starts_at - now())) / 3600.0;
  -- pending_reconciliation: la clienta ya pagó y perdió la franja; sin ventana y con reembolso total.
  IF v_acc <> 'staff' AND v_r.status <> 'pending_reconciliation' THEN
    IF v_r.starts_at <= now() THEN
      RETURN public._reservas_err('ALREADY_STARTED');
    END IF;
    IF v_hours < v_fac.min_cancellation_hours THEN
      RETURN public._reservas_err('CANCELLATION_WINDOW_CLOSED');
    END IF;
  END IF;

  v_pol := public._reservas_politica(v_fac.school_id, v_fac.id);
  v_pct := CASE
    WHEN v_acc = 'staff' OR v_r.status = 'pending_reconciliation' THEN 100
    WHEN v_hours >= (v_pol ->> 'hours_full_refund')::numeric    THEN 100
    WHEN v_hours >= (v_pol ->> 'hours_partial_refund')::numeric THEN (v_pol ->> 'partial_pct')::integer
    ELSE 0 END;
  v_refund := round(v_r.amount_paid * v_pct / 100.0);
  v_rs := CASE WHEN v_refund > 0 THEN 'manual' ELSE 'none' END;   -- sin billetera hasta F6: la devolución la registra una persona

  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);
  UPDATE public.facility_reservations
     SET status              = 'cancelled',
         cancellation_reason = left(p_reason, 500),
         cancelled_at        = now(),
         cancelled_by        = v_actor,
         refund_status       = v_rs,
         updated_at          = now()
   WHERE id = v_r.id;
  PERFORM set_config('sportmaps.rpc_reservas', '', true);

  RETURN jsonb_build_object('ok', true, 'already_cancelled', false,
           'reservation', public._reservas_resultado(v_r.id) -> 'reservation',
           'refund', jsonb_build_object(
              'pct', v_pct, 'amount', v_refund, 'status', v_rs,
              'hours_before', round(v_hours, 2),
              'policy', jsonb_build_object(
                 'hours_full_refund', (v_pol ->> 'hours_full_refund')::int,
                 'hours_partial_refund', (v_pol ->> 'hours_partial_refund')::int,
                 'partial_pct', (v_pol ->> 'partial_pct')::int,
                 'source', v_pol ->> 'source')));
END;
$$;

REVOKE ALL ON FUNCTION public.cancelar_reserva(uuid, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancelar_reserva(uuid, text, uuid, uuid) TO authenticated, service_role;

-- ── reprogramar_reserva ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reprogramar_reserva(
  p_reservation_id   uuid,
  p_new_starts_at    timestamptz,
  p_new_ends_at      timestamptz,
  p_new_facility_id  uuid DEFAULT NULL,
  p_actor_profile_id uuid DEFAULT NULL,
  p_guest_booker_id  uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_r       public.facility_reservations%ROWTYPE;
  v_old_fac public.facilities%ROWTYPE;
  v_new_fac public.facilities%ROWTYPE;
  v_acc     text;
  v_actor   uuid := COALESCE(auth.uid(), p_actor_profile_id);
  v_staff   boolean;
  v_pol     jsonb;
  v_err     text;
  v_target  uuid;
  v_old_dur numeric;
  v_new_dur numeric;
  v_keys    text[];
  v_k       text;
  v_price   numeric := NULL;
  v_steps   jsonb;
  v_source  text;
  v_aud     text;
  v_snap    jsonb;
  v_pay     text;
  v_prev    jsonb;
  v_day_old date;
  v_day_new date;
BEGIN
  IF p_reservation_id IS NULL OR p_new_starts_at IS NULL OR p_new_ends_at IS NULL THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;

  SELECT * INTO v_r FROM public.facility_reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN
    RETURN public._reservas_err('RESERVATION_NOT_FOUND');
  END IF;
  SELECT * INTO v_old_fac FROM public.facilities WHERE id = v_r.facility_id;

  v_acc := public._reservas_acceso(v_old_fac.school_id, v_r.user_id, v_r.guest_booker_id, p_actor_profile_id, p_guest_booker_id);
  IF v_acc IS NULL THEN
    RETURN public._reservas_err('FORBIDDEN');
  END IF;
  v_staff := (v_acc = 'staff');

  IF NOT COALESCE(public.has_entitlement(v_old_fac.school_id, 'reservations'), false) THEN
    RETURN public._reservas_err('ENTITLEMENT_REQUIRED');
  END IF;

  v_target := COALESCE(p_new_facility_id, v_r.facility_id);
  IF v_target <> v_r.facility_id THEN
    IF NOT v_staff THEN
      RETURN public._reservas_err('STAFF_ONLY_FIELD');
    END IF;
    SELECT * INTO v_new_fac FROM public.facilities WHERE id = v_target AND school_id = v_old_fac.school_id;
    IF NOT FOUND THEN
      RETURN public._reservas_err('FACILITY_NOT_FOUND');
    END IF;
  ELSE
    v_new_fac := v_old_fac;
  END IF;
  IF v_new_fac.status <> 'available' OR COALESCE(v_new_fac.booking_enabled, true) = false THEN
    RETURN public._reservas_err('FACILITY_NOT_BOOKABLE');
  END IF;

  -- Locks por cancha-día, siempre en el mismo orden (evita deadlock entre dos reprogramaciones cruzadas).
  v_day_old := (v_r.starts_at AT TIME ZONE 'America/Bogota')::date;
  v_day_new := (p_new_starts_at AT TIME ZONE 'America/Bogota')::date;
  v_keys := ARRAY(SELECT DISTINCT k FROM unnest(ARRAY[
              'facility_slot:' || v_r.facility_id::text || ':' || v_day_old::text,
              'facility_slot:' || v_target::text        || ':' || v_day_new::text]) AS k ORDER BY k);
  FOREACH v_k IN ARRAY v_keys LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_k, 0));
  END LOOP;

  SELECT * INTO v_r FROM public.facility_reservations WHERE id = p_reservation_id FOR UPDATE;

  IF v_r.status NOT IN ('hold', 'pending_payment', 'pending', 'confirmed')
     OR (v_r.status IN ('hold', 'pending_payment') AND v_r.hold_expires_at IS NOT NULL AND v_r.hold_expires_at < now()) THEN
    RETURN public._reservas_err('INVALID_STATE');
  END IF;
  IF NOT v_staff AND v_r.starts_at <= now() THEN
    RETURN public._reservas_err('ALREADY_STARTED');
  END IF;

  IF v_target = v_r.facility_id AND p_new_starts_at = v_r.starts_at AND p_new_ends_at = v_r.ends_at THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true,
             'reservation', public._reservas_resultado(v_r.id) -> 'reservation');
  END IF;

  v_old_dur := EXTRACT(EPOCH FROM (v_r.ends_at - v_r.starts_at));
  v_new_dur := EXTRACT(EPOCH FROM (p_new_ends_at - p_new_starts_at));

  IF NOT v_staff THEN
    IF v_new_dur <> v_old_dur THEN
      RETURN public._reservas_err('DURATION_MISMATCH');
    END IF;
    v_pol := public._reservas_politica(v_old_fac.school_id, v_old_fac.id);
    IF now() > v_r.starts_at - make_interval(hours => (v_pol ->> 'hours_full_refund')::int) THEN
      RETURN public._reservas_err('RESCHEDULE_WINDOW_CLOSED');
    END IF;
  END IF;

  v_err := public._reservas_validar_rango(v_target, p_new_starts_at, p_new_ends_at, v_staff);
  IF v_err IS NOT NULL THEN
    RETURN public._reservas_err(v_err);
  END IF;

  v_snap := COALESCE(v_r.price_snapshot, '{}'::jsonb);

  -- No staff: se recalcula el total en el horario nuevo con la misma tarifa; si sale MÁS caro no se
  -- cobra diferencia en F1 (RESCHEDULE_PRICE_DIFFERS); si sale igual o menor, se conserva el precio original.
  IF NOT v_staff THEN
    SELECT round(sum(p.rate * EXTRACT(EPOCH FROM (p.step_to - p.step_from)) / 3600.0))
      INTO v_price
      FROM public._reservas_precio_pasos(v_target, p_new_starts_at, p_new_ends_at, COALESCE(v_snap ->> 'audience', 'public')) p;
    IF v_price IS NULL OR v_price > v_r.price THEN
      RETURN public._reservas_err('RESCHEDULE_PRICE_DIFFERS');
    END IF;
    v_price := NULL;                         -- conserva price y price_snapshot originales
  END IF;

  -- Staff que cambia duración o cancha: se recalcula el precio con la misma tarifa.
  IF v_staff AND (v_new_dur <> v_old_dur OR v_target <> v_r.facility_id) THEN
    v_aud := COALESCE(v_snap ->> 'audience', 'public');
    SELECT jsonb_agg(jsonb_build_object('from', public._reservas_iso(p.step_from), 'to', public._reservas_iso(p.step_to),
                                        'rate', p.rate, 'source', p.source) ORDER BY p.step_from),
           round(sum(p.rate * EXTRACT(EPOCH FROM (p.step_to - p.step_from)) / 3600.0)),
           CASE WHEN bool_or(p.source = 'facility_rates') THEN 'facility_rates' ELSE 'facility_default' END
      INTO v_steps, v_price, v_source
      FROM public._reservas_precio_pasos(v_target, p_new_starts_at, p_new_ends_at, v_aud) p;
    IF v_price IS NULL THEN
      RETURN public._reservas_err('INVALID_RANGE');
    END IF;
    v_snap := v_snap || jsonb_build_object('total', v_price,
                                           'deposit_min', round(v_price * v_new_fac.min_deposit_pct / 100.0),
                                           'source', v_source, 'breakdown', COALESCE(v_steps, '[]'::jsonb));
  END IF;

  v_prev := jsonb_build_object('facility_id', v_r.facility_id,
                               'starts_at', public._reservas_iso(v_r.starts_at),
                               'ends_at', public._reservas_iso(v_r.ends_at));
  v_snap := jsonb_set(v_snap, '{rescheduled_from}',
              COALESCE(v_snap -> 'rescheduled_from', '[]'::jsonb)
              || jsonb_build_array(v_prev || jsonb_build_object('at', public._reservas_iso(now()), 'by', v_actor)));

  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);

  -- Holds vencidos de la cancha destino no deben bloquear (excepto esta misma reserva).
  UPDATE public.facility_reservations
     SET status = CASE WHEN amount_paid > 0 THEN 'pending_reconciliation' ELSE 'expired' END, updated_at = now()
   WHERE facility_id = v_target AND reservation_date = v_day_new AND id <> v_r.id
     AND status IN ('hold', 'pending_payment') AND hold_expires_at IS NOT NULL AND hold_expires_at < now();
  UPDATE public.facility_occupancy
     SET status = 'released', updated_at = now()
   WHERE facility_id = v_target AND status = 'hold' AND hold_expires_at < now() AND source_id <> v_r.id;

  BEGIN
    UPDATE public.facility_reservations
       SET facility_id    = v_target,
           starts_at      = p_new_starts_at,
           ends_at        = p_new_ends_at,
           price          = COALESCE(v_price, price),
           payment_status = CASE
                              WHEN v_price IS NULL THEN payment_status
                              WHEN v_price > 0 AND amount_paid >= v_price THEN 'paid'::public.resv_payment_status
                              WHEN amount_paid > 0 THEN 'partial'::public.resv_payment_status
                              ELSE payment_status END,
           min_deposit_pct = CASE WHEN v_target <> facility_id THEN v_new_fac.min_deposit_pct ELSE min_deposit_pct END,
           price_snapshot = v_snap,
           updated_at     = now()
     WHERE id = v_r.id;
  EXCEPTION
    WHEN exclusion_violation OR unique_violation THEN
      PERFORM set_config('sportmaps.rpc_reservas', '', true);
      RETURN public._reservas_err('SLOT_TAKEN')
             || jsonb_build_object('alternatives',
                  public._reservas_alternativas(v_old_fac.school_id, v_target, p_new_starts_at,
                                                (v_new_dur / 60)::integer,
                                                CASE WHEN v_staff THEN COALESCE(v_snap ->> 'audience', 'public') END,
                                                p_actor_profile_id));
  END;
  PERFORM set_config('sportmaps.rpc_reservas', '', true);

  RETURN jsonb_build_object('ok', true, 'unchanged', false,
           'reservation', public._reservas_resultado(v_r.id) -> 'reservation',
           'previous', v_prev);
END;
$$;

REVOKE ALL ON FUNCTION public.reprogramar_reserva(uuid, timestamptz, timestamptz, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reprogramar_reserva(uuid, timestamptz, timestamptz, uuid, uuid, uuid) TO authenticated, service_role;

-- ── confirmar_pago_reserva ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirmar_pago_reserva(
  p_reference          text,
  p_amount             numeric,
  p_payment_id         uuid DEFAULT NULL,
  p_provider           text DEFAULT NULL,
  p_provider_event_id  text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_r        public.facility_reservations%ROWTYPE;
  v_new_paid numeric;
  v_pay      text;
  v_deposit  numeric;
  v_events   jsonb;
  v_snap     jsonb;
  v_conf     boolean := false;
  v_recon    boolean := false;
  v_reason   text;
  v_ref      text;
BEGIN
  IF p_reference IS NULL OR p_amount IS NULL OR (p_provider_event_id IS NULL AND p_payment_id IS NULL) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  IF p_amount <= 0 THEN
    RETURN public._reservas_err('INVALID_AMOUNT');
  END IF;

  -- La pasarela puede reintentar con sufijo (RSV-<16hex>-<n>): se normaliza a la referencia de la base.
  v_ref := upper(COALESCE((regexp_match(btrim(p_reference), '^(RSV-[0-9A-Fa-f]{16})(-[0-9]+)?$'))[1], btrim(p_reference)));

  SELECT * INTO v_r FROM public.facility_reservations WHERE payment_reference = v_ref;
  IF NOT FOUND THEN
    RETURN public._reservas_err('RESERVATION_NOT_FOUND');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
            'facility_slot:' || v_r.facility_id::text || ':' || v_r.reservation_date::text, 0));
  SELECT * INTO v_r FROM public.facility_reservations WHERE id = v_r.id FOR UPDATE;

  -- Idempotencia: el mismo evento (o el mismo pago, si no hay id de evento) no suma dos veces.
  v_events := COALESCE(v_r.price_snapshot -> 'payment_events', '[]'::jsonb);
  IF (p_provider_event_id IS NOT NULL AND v_events @> to_jsonb(p_provider_event_id))
     OR (p_provider_event_id IS NULL AND p_payment_id IS NOT NULL AND v_r.payment_id = p_payment_id) THEN
    RETURN public._reservas_resultado(v_r.id) || jsonb_build_object(
             'already_processed', true,
             'confirmed', v_r.status IN ('confirmed', 'completed', 'no_show'),
             'reconciliation', v_r.status = 'pending_reconciliation');
  END IF;

  v_new_paid := v_r.amount_paid + p_amount;
  v_pay := CASE WHEN v_r.price > 0 AND v_new_paid >= v_r.price THEN 'paid'
                WHEN v_new_paid > 0 THEN 'partial'
                ELSE v_r.payment_status::text END;
  v_deposit := round(v_r.price * v_r.min_deposit_pct / 100.0);

  v_snap := COALESCE(v_r.price_snapshot, '{}'::jsonb);
  v_snap := jsonb_set(v_snap, '{payment_events}',
              v_events || CASE WHEN p_provider_event_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_provider_event_id) END);
  v_snap := jsonb_set(v_snap, '{payments}',
              COALESCE(v_snap -> 'payments', '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object('event_id', p_provider_event_id, 'amount', p_amount,
                                                      'provider', p_provider, 'payment_id', p_payment_id,
                                                      'at', public._reservas_iso(now()))));

  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);

  IF v_r.status IN ('confirmed', 'completed', 'no_show') THEN
    UPDATE public.facility_reservations
       SET amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
           payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap, updated_at = now()
     WHERE id = v_r.id;
    v_conf := true;

  ELSIF v_r.status IN ('cancelled', 'pending_reconciliation') THEN
    UPDATE public.facility_reservations
       SET amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
           payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap,
           status = 'pending_reconciliation', updated_at = now()
     WHERE id = v_r.id;
    v_recon := true;
    v_reason := CASE WHEN v_r.status = 'cancelled' THEN 'PAID_AFTER_CANCELLATION' ELSE 'PAID_AGAIN_PENDING_RECONCILIATION' END;

  ELSIF v_r.status IN ('hold', 'pending_payment', 'pending', 'expired') THEN
    IF v_r.price > 0 AND v_new_paid < v_deposit THEN
      IF v_r.status = 'expired' THEN
        UPDATE public.facility_reservations
           SET amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
               payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap,
               status = 'pending_reconciliation', updated_at = now()
         WHERE id = v_r.id;
        v_recon := true; v_reason := 'PAID_AFTER_EXPIRATION_DEPOSIT_NOT_REACHED';
      ELSE
        UPDATE public.facility_reservations
           SET amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
               payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap, updated_at = now()
         WHERE id = v_r.id;
        v_reason := 'DEPOSIT_NOT_REACHED';
      END IF;
    ELSE
      BEGIN
        UPDATE public.facility_reservations
           SET status = 'confirmed', hold_expires_at = NULL, approved_at = COALESCE(approved_at, now()),
               amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
               payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap, updated_at = now()
         WHERE id = v_r.id;
        v_conf := true;
      EXCEPTION WHEN exclusion_violation OR unique_violation THEN
        -- La franja ya la tomó otro mientras el pago estaba en camino: el pago NO se pierde.
        UPDATE public.facility_reservations
           SET amount_paid = v_new_paid, payment_status = v_pay::public.resv_payment_status,
               payment_id = COALESCE(p_payment_id, payment_id), price_snapshot = v_snap,
               status = 'pending_reconciliation', hold_expires_at = NULL, updated_at = now()
         WHERE id = v_r.id;
        v_recon := true; v_reason := 'SLOT_TAKEN_AFTER_HOLD_EXPIRED';
      END;
    END IF;

  ELSE
    PERFORM set_config('sportmaps.rpc_reservas', '', true);
    RETURN public._reservas_err('INVALID_STATE');
  END IF;

  PERFORM set_config('sportmaps.rpc_reservas', '', true);

  RETURN public._reservas_resultado(v_r.id) || jsonb_build_object(
           'already_processed', false, 'confirmed', v_conf, 'reconciliation', v_recon)
         || CASE
              WHEN v_recon THEN
                -- reason: 'CANCELLED' | 'SLOT_TAKEN'; el detalle fino va en reason_detail.
                jsonb_build_object(
                  'reason', CASE WHEN v_reason = 'PAID_AFTER_CANCELLATION' THEN 'CANCELLED' ELSE 'SLOT_TAKEN' END,
                  'reason_detail', v_reason,
                  'amount_paid', v_new_paid,
                  'price', v_r.price)
              WHEN v_reason IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('reason', v_reason)
            END;
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_pago_reserva(text, numeric, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirmar_pago_reserva(text, numeric, uuid, text, text) TO service_role;

-- ── expirar_holds (reemplaza la de F0) ───────────────────────────────────────
-- Devuelve cuántas RESERVAS pasó a 'expired' (la de F0 devolvía filas de ocupación).
CREATE OR REPLACE FUNCTION public.expirar_holds()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- Higiene: la disponibilidad ya ignora holds vencidos y reservar_cancha los libera de su
  -- cancha antes de insertar. En lote (500), sin N+1, sin esperar filas bloqueadas.
  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);

  WITH vencidas AS (
    SELECT r.id
      FROM public.facility_reservations r
     WHERE r.status IN ('hold', 'pending_payment')
       AND r.hold_expires_at IS NOT NULL AND r.hold_expires_at < now()
     ORDER BY r.hold_expires_at
     LIMIT 500
       FOR UPDATE SKIP LOCKED
  ), act AS (
    UPDATE public.facility_reservations r
       SET status = CASE WHEN r.amount_paid > 0 THEN 'pending_reconciliation' ELSE 'expired' END,
           updated_at = now()
      FROM vencidas v
     WHERE r.id = v.id
    RETURNING r.id
  )
  SELECT count(*) INTO v_n FROM act;

  -- Holds huérfanos de cualquier otra fuente.
  UPDATE public.facility_occupancy
     SET status = 'released', updated_at = now()
   WHERE status = 'hold' AND hold_expires_at < now();

  PERFORM set_config('sportmaps.rpc_reservas', '', true);
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.expirar_holds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expirar_holds() TO service_role;

COMMIT;
