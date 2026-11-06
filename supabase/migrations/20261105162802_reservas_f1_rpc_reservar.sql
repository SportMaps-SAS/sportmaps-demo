-- =============================================================================
-- 20261105162802_reservas_f1_rpc_reservar.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105162611
-- Objetivo: F1 · M4 — reservar_cancha, el ÚNICO punto de escritura de reservas
--   nuevas (spec §3, §4). Contrato: docs/specs/reservas-canchas-f1-contrato.md §3.
--   ⚠ ES EL NÚCLEO: revisar línea por línea antes de aplicar.
--
--   · Advisory lock (cancha, día de Bogotá) → serializa a los que compiten por la misma cancha-día.
--   · Idempotencia: UNIQUE (school_id, idempotency_key); repetir = misma reserva; llave ajena = error.
--   · Libera los holds vencidos de esa cancha antes de insertar (la correctitud no depende del cron).
--   · Valida: entitlement, booking_enabled, bookable_by según rol, menor de edad, rango,
--     horario, anticipación, blackouts. El staff se salta horario/anticipación/bookable_by.
--   · Escribe reserva + facility_occupancy en la MISMA transacción (el trigger de M1 escribe
--     la ocupación; el EXCLUDE de F0 es la garantía final). 23P01 → SLOT_TAKEN + 3 alternativas.
--
--   También aquí:
--     · guarda_facility_reservations (M0 de F0) aprende a dejar pasar a las RPC mediante
--       el GUC transaccional sportmaps.rpc_reservas = 'on' (que solo ponen las RPC de reserva).
--       Sin esto la guarda trataría la reserva del padre como un INSERT directo del cliente y
--       le forzaría status 'pending' y el precio del esquema viejo.
--     · helpers internos _reservas_err, _reservas_validar_rango, _reservas_resultado.
--
-- Grants: authenticated + service_role. anon NO. Helpers sin GRANT.
-- Orden de aplicación requerido: después de reservas_f1_columnas, _tarifas_politicas y
-- _rpc_disponibilidad (usa max_duration_min, facility_rates, co_holidays y disponibilidad_canchas).
--
-- GUC sportmaps.rpc_reservas = 'on': se dejó el valor simple a propósito. Es local a la
-- transacción y PostgREST no expone set_config ni SET, así que un cliente no puede fijarlo;
-- quien pudiera ejecutar SQL arbitrario ya tendría acceso mayor. Un valor aleatorio por
-- transacción exigiría guardar un secreto en la base para verificarlo (más piezas, mismo
-- modelo de amenaza). Si algún día se expone SQL dinámico a clientes, cambiar a token con secreto.
-- =============================================================================

BEGIN;

-- ── guarda M0: las RPC de reserva pasan (GUC puesto solo por ellas, local a la transacción) ──
CREATE OR REPLACE FUNCTION public.guarda_facility_reservations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
  v_hourly numeric;
  v_rental numeric;
  v_rental_enabled boolean;
  v_rate   numeric;
  v_hours  numeric;
  c_libres constant text[] := ARRAY['status','cancellation_reason','cancelled_at','notes','updated_at'];
BEGIN
  -- Las RPC reservar/cancelar/reprogramar/confirmar validan todo adentro y marcan la transacción.
  IF COALESCE(current_setting('sportmaps.rpc_reservas', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  -- service_role / postgres (sin JWT de usuario) y triggers internos pasan.
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  SELECT f.school_id, f.hourly_rate, f.rental_rate, f.rental_enabled
    INTO v_school, v_hourly, v_rental, v_rental_enabled
    FROM public.facilities f
   WHERE f.id = NEW.facility_id;

  IF v_school IS NULL THEN
    RAISE EXCEPTION 'facility_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Staff de la escuela de la cancha (o super admin): sin restricciones nuevas.
  IF v_school = ANY (public.user_staff_school_ids()) OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_rate := CASE
                WHEN NEW.resv_type::text = 'rental' AND v_rental_enabled AND v_rental IS NOT NULL
                  THEN v_rental
                ELSE COALESCE(v_hourly, 0)
              END;
    v_hours := EXTRACT(EPOCH FROM (NEW.end_time - NEW.start_time)) / 3600.0;

    -- Anti-acaparamiento del camino directo: máximo 3 solicitudes 'pending' futuras por usuario.
    IF NEW.user_id IS NOT NULL AND (
         SELECT count(*) FROM public.facility_reservations o
          WHERE o.user_id = NEW.user_id AND o.status = 'pending'
            AND o.reservation_date >= (now() AT TIME ZONE 'America/Bogota')::date) >= 3 THEN
      RAISE EXCEPTION 'too_many_pending: ya tienes 3 solicitudes de reserva pendientes'
        USING ERRCODE = '42501';
    END IF;

    NEW.school_id      := v_school;
    NEW.status         := 'pending';
    NEW.amount_paid    := 0;
    NEW.payment_status := 'unpaid';
    NEW.approved_by    := NULL;
    NEW.approved_at    := NULL;
    NEW.price          := ROUND(v_rate * v_hours);
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - c_libres) IS DISTINCT FROM (to_jsonb(OLD) - c_libres) THEN
    RAISE EXCEPTION 'forbidden_column: solo la escuela puede cambiar horario, precio o pago de una reserva'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (NEW.status = 'cancelled' AND OLD.status IN ('pending','confirmed')) THEN
    RAISE EXCEPTION 'forbidden_status: solo puedes cancelar tu reserva'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guarda_facility_reservations() FROM PUBLIC, anon, authenticated;

-- ── _reservas_err: error de negocio uniforme ─────────────────────────────────
CREATE OR REPLACE FUNCTION public._reservas_err(p_code text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object('ok', false, 'error', p_code, 'message', CASE p_code
    WHEN 'INVALID_ARGUMENT'           THEN 'Parámetros inválidos'
    WHEN 'INVALID_AMOUNT'             THEN 'Monto inválido'
    WHEN 'FACILITY_NOT_FOUND'         THEN 'La instalación no existe'
    WHEN 'RESERVATION_NOT_FOUND'      THEN 'La reserva no existe'
    WHEN 'ENTITLEMENT_REQUIRED'       THEN 'La escuela no tiene activas las reservas'
    WHEN 'FACILITY_NOT_BOOKABLE'      THEN 'La instalación no recibe reservas'
    WHEN 'AUDIENCE_NOT_ALLOWED'       THEN 'Esta instalación no admite reservas de tu tipo de usuario'
    WHEN 'MINOR_CANNOT_BOOK'          THEN 'Un menor de edad no puede reservar: debe hacerlo su acudiente'
    WHEN 'FORBIDDEN'                  THEN 'No tienes permiso sobre esta reserva'
    WHEN 'STAFF_ONLY_FIELD'           THEN 'Ese dato solo lo puede indicar el personal de la escuela'
    WHEN 'GUEST_REQUIRED'             THEN 'Falta identificar a quien reserva'
    WHEN 'GUEST_NOT_FOUND'            THEN 'No se encontró al invitado'
    WHEN 'GUEST_NOT_VERIFIED'         THEN 'El teléfono del invitado no está verificado'
    WHEN 'CHANNEL_NOT_ALLOWED'        THEN 'Canal no permitido'
    WHEN 'PAYMENT_METHOD_NOT_ALLOWED' THEN 'Método de pago no permitido'
    WHEN 'PAYMENT_REQUIRED'           THEN 'Esta reserva exige pago en línea o por transferencia'
    WHEN 'IDEMPOTENCY_KEY_REUSED'     THEN 'La llave de idempotencia ya se usó con otros datos'
    WHEN 'INVALID_RANGE'              THEN 'Rango de horas inválido'
    WHEN 'DURATION_TOO_SHORT'         THEN 'La reserva es más corta que la duración mínima'
    WHEN 'INVALID_DURATION'           THEN 'La duración no es múltiplo del paso de la grilla'
    WHEN 'CROSSES_MIDNIGHT'           THEN 'La reserva no puede cruzar la medianoche'
    WHEN 'SLOT_NOT_ALIGNED'           THEN 'La hora de inicio no cae en la grilla de la instalación'
    WHEN 'OUTSIDE_HOURS'              THEN 'La instalación está cerrada en ese horario'
    WHEN 'TOO_SOON'                   THEN 'Falta menos que la anticipación mínima para reservar'
    WHEN 'TOO_FAR'                    THEN 'No se puede reservar con tanta anticipación'
    WHEN 'IN_THE_PAST'                THEN 'Esa hora ya pasó'
    WHEN 'FACILITY_BLOCKED'           THEN 'La instalación está cerrada en ese horario'
    WHEN 'SLOT_TAKEN'                 THEN 'Esa franja ya no está disponible'
    WHEN 'INVALID_STATE'              THEN 'La reserva no está en un estado que permita esta acción'
    WHEN 'ALREADY_STARTED'            THEN 'La reserva ya empezó'
    WHEN 'CANCELLATION_WINDOW_CLOSED' THEN 'Ya pasó el plazo para cancelar'
    WHEN 'RESCHEDULE_WINDOW_CLOSED'   THEN 'Ya pasó el plazo para reprogramar sin costo'
    WHEN 'DURATION_MISMATCH'          THEN 'La nueva reserva debe durar lo mismo que la original'
    WHEN 'DURATION_TOO_LONG'          THEN 'La reserva supera la duración máxima de la instalación'
    WHEN 'TOO_MANY_ACTIVE'            THEN 'Ya tienes el máximo de reservas activas; cancela o usa una antes de reservar otra'
    WHEN 'PRICE_NOT_CONFIGURED'       THEN 'Esta instalación aún no tiene tarifa configurada'
    WHEN 'RESCHEDULE_PRICE_DIFFERS'   THEN 'El nuevo horario cuesta más que el original; cancela y reserva de nuevo o pide ayuda a la escuela'
    ELSE p_code END);
$$;

REVOKE ALL ON FUNCTION public._reservas_err(text) FROM PUBLIC, anon, authenticated;

-- ── _reservas_validar_rango: código de error o NULL ──────────────────────────
-- Valida el rango contra la instalación (alineación, duración, horario, anticipación, blackouts).
-- NO mira ocupación de otras reservas: eso lo decide el EXCLUDE.
CREATE OR REPLACE FUNCTION public._reservas_validar_rango(
  p_facility_id uuid, p_starts timestamptz, p_ends timestamptz, p_staff boolean)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_f      public.facilities%ROWTYPE;
  v_ls     timestamp;
  v_le     timestamp;
  v_dur    numeric;
  v_min_dia integer;
  v_horas  jsonb;
  v_dia    jsonb;
  v_ok     boolean;
BEGIN
  SELECT * INTO v_f FROM public.facilities WHERE id = p_facility_id;
  IF NOT FOUND THEN
    RETURN 'FACILITY_NOT_FOUND';
  END IF;

  IF p_starts IS NULL OR p_ends IS NULL OR p_ends <= p_starts THEN
    RETURN 'INVALID_RANGE';
  END IF;

  v_dur := EXTRACT(EPOCH FROM (p_ends - p_starts)) / 60.0;
  IF v_dur <> trunc(v_dur) THEN
    RETURN 'INVALID_RANGE';
  END IF;

  v_ls := p_starts AT TIME ZONE 'America/Bogota';
  v_le := p_ends   AT TIME ZONE 'America/Bogota';
  IF v_ls::date <> v_le::date THEN
    RETURN 'CROSSES_MIDNIGHT';
  END IF;

  IF v_dur < v_f.min_duration_min THEN
    RETURN 'DURATION_TOO_SHORT';
  END IF;
  IF (v_dur::integer % v_f.slot_step_min) <> 0 THEN
    RETURN 'INVALID_DURATION';
  END IF;

  v_min_dia := EXTRACT(hour FROM v_ls)::int * 60 + EXTRACT(minute FROM v_ls)::int;
  IF EXTRACT(second FROM v_ls) <> 0 OR (v_min_dia % v_f.slot_step_min) <> 0 THEN
    RETURN 'SLOT_NOT_ALIGNED';
  END IF;

  IF p_staff THEN
    IF p_ends <= now() THEN
      RETURN 'IN_THE_PAST';
    END IF;
  ELSE
    IF v_dur > v_f.max_duration_min THEN
      RETURN 'DURATION_TOO_LONG';
    END IF;
    IF p_starts < now() + make_interval(hours => v_f.min_booking_advance_hours) THEN
      RETURN 'TOO_SOON';
    END IF;
    IF p_starts > now() + interval '90 days' THEN
      RETURN 'TOO_FAR';
    END IF;

    v_horas := CASE WHEN jsonb_typeof(v_f.available_hours) = 'object' THEN v_f.available_hours ELSE '{}'::jsonb END;
    v_dia := v_horas -> (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(dow FROM v_ls)::int + 1];
    SELECT EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_dia) = 'array' THEN v_dia ELSE '[]'::jsonb END) AS w
              WHERE w ~ '^[0-9]{1,2}:[0-9]{2}-[0-9]{1,2}:[0-9]{2}$'
                AND v_ls::time >= split_part(w, '-', 1)::time
                AND v_le::time <= split_part(w, '-', 2)::time)
      INTO v_ok;
    IF NOT v_ok THEN
      RETURN 'OUTSIDE_HOURS';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.facility_occupancy o
              WHERE o.facility_id = p_facility_id AND o.source_kind = 'blackout' AND o.status = 'active'
                AND o.slot && tstzrange(p_starts, p_ends, '[)')) THEN
    RETURN 'FACILITY_BLOCKED';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_validar_rango(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

-- ── _reservas_resultado: JSON estándar de una reserva (todas las RPC lo usan) ─
CREATE OR REPLACE FUNCTION public._reservas_resultado(p_reservation_id uuid, p_replay boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'idempotent_replay', p_replay,
    'requires_payment', (r.status = 'pending_payment'),
    'reservation', jsonb_build_object(
      'id',               r.id,
      'facility_id',      r.facility_id,
      'facility_name',    f.name,
      'school_id',        r.school_id,
      'status',           r.status,
      'payment_status',   r.payment_status,
      'starts_at',        public._reservas_iso(r.starts_at),
      'ends_at',          public._reservas_iso(r.ends_at),
      'local_date',       to_char(r.starts_at AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD'),
      'local_start',      to_char(r.starts_at AT TIME ZONE 'America/Bogota', 'HH24:MI'),
      'local_end',        to_char(r.ends_at   AT TIME ZONE 'America/Bogota', 'HH24:MI'),
      'hold_expires_at',  CASE WHEN r.hold_expires_at IS NULL THEN NULL ELSE public._reservas_iso(r.hold_expires_at) END,
      'channel',          r.channel,
      'payment_reference', r.payment_reference,
      'price',            r.price,
      'amount_paid',      r.amount_paid,
      'min_deposit_pct',  r.min_deposit_pct,
      'deposit_min',      round(r.price * r.min_deposit_pct / 100.0),
      'refund_status',    r.refund_status),
    'pricing', jsonb_build_object(
      'audience',    r.price_snapshot ->> 'audience',
      'total',       (r.price_snapshot ->> 'total')::numeric,
      'deposit_min', (r.price_snapshot ->> 'deposit_min')::numeric,
      'currency',    'COP',
      'source',      r.price_snapshot ->> 'source',
      'breakdown',   COALESCE(r.price_snapshot -> 'breakdown', '[]'::jsonb)))
    FROM public.facility_reservations r
    JOIN public.facilities f ON f.id = r.facility_id
   WHERE r.id = p_reservation_id;
$$;

REVOKE ALL ON FUNCTION public._reservas_resultado(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ── reservar_cancha ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reservar_cancha(
  p_facility_id        uuid,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_channel            text,
  p_idempotency_key    text,
  p_payment_method     text    DEFAULT 'online',
  p_actor_profile_id   uuid    DEFAULT NULL,
  p_booker_profile_id  uuid    DEFAULT NULL,
  p_guest_booker_id    uuid    DEFAULT NULL,
  p_guest              jsonb   DEFAULT NULL,
  p_rate_audience      text    DEFAULT NULL,
  p_participants       integer DEFAULT 1,
  p_notes              text    DEFAULT NULL,
  p_external_org_name  text    DEFAULT NULL,
  p_amount_paid        numeric DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_actor   uuid;
  v_fac     public.facilities%ROWTYPE;
  v_rol     text;
  v_staff   boolean;
  v_aud     text;
  v_booker  uuid;
  v_guest   uuid;
  v_gverif  timestamptz;
  v_err     text;
  v_ex      public.facility_reservations%ROWTYPE;
  v_day     date;
  v_total   numeric;
  v_steps   jsonb;
  v_source  text;
  v_deposit numeric;
  v_price   numeric;
  v_status  text;
  v_pay     text;
  v_hold_min integer;
  v_hold_exp timestamptz;
  v_id      uuid := gen_random_uuid();
  v_ref     text;
  v_btype   text;
  v_rtype   text;
  v_paid    numeric := COALESCE(p_amount_paid, 0);
  v_override boolean := false;
  v_snap    jsonb;
  v_cons    text;
  v_dur_min integer;
  v_av      jsonb;
  v_alt     jsonb := '[]'::jsonb;
BEGIN
  -- ── 0. argumentos ──────────────────────────────────────────────────────────
  IF p_facility_id IS NULL OR p_starts_at IS NULL OR p_ends_at IS NULL
     OR p_channel IS NULL OR p_channel NOT IN ('app', 'public', 'whatsapp', 'admin', 'landing')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR p_payment_method IS NULL OR p_payment_method NOT IN ('online', 'transfer', 'cash', 'none')
     OR (p_rate_audience IS NOT NULL AND p_rate_audience NOT IN ('public', 'member'))
     OR length(COALESCE(p_notes, '')) > 500
     OR length(COALESCE(p_external_org_name, '')) > 200
     OR (p_guest IS NOT NULL AND (jsonb_typeof(p_guest) <> 'object'
                                  OR btrim(COALESCE(p_guest ->> 'phone', '')) = ''
                                  OR btrim(COALESCE(p_guest ->> 'full_name', '')) = '')) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  IF v_paid < 0 THEN
    RETURN public._reservas_err('INVALID_AMOUNT');
  END IF;

  -- ── 1. instalación, entitlement, rol ───────────────────────────────────────
  SELECT * INTO v_fac FROM public.facilities WHERE id = p_facility_id;
  IF NOT FOUND OR v_fac.school_id IS NULL THEN
    RETURN public._reservas_err('FACILITY_NOT_FOUND');
  END IF;
  IF COALESCE(p_participants, 1) < 1 OR (v_fac.capacity > 0 AND COALESCE(p_participants, 1) > v_fac.capacity) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  IF NOT COALESCE(public.has_entitlement(v_fac.school_id, 'reservations'), false) THEN
    RETURN public._reservas_err('ENTITLEMENT_REQUIRED');
  END IF;

  -- auth.uid() NULL solo con service_role/postgres (anon no tiene EXECUTE); entonces manda p_actor_profile_id.
  v_actor := COALESCE(v_uid, p_actor_profile_id);
  v_rol   := public._reservas_rol(v_fac.school_id, v_actor);
  v_staff := (v_rol = 'staff');

  IF p_channel = 'admin' AND NOT v_staff THEN
    RETURN public._reservas_err('CHANNEL_NOT_ALLOWED');
  END IF;
  IF NOT v_staff AND (p_rate_audience IS NOT NULL OR v_paid > 0 OR p_guest IS NOT NULL) THEN
    RETURN public._reservas_err('STAFF_ONLY_FIELD');
  END IF;

  IF v_fac.status <> 'available' OR COALESCE(v_fac.booking_enabled, true) = false THEN
    RETURN public._reservas_err('FACILITY_NOT_BOOKABLE');
  END IF;

  -- ── 2. quién reserva ───────────────────────────────────────────────────────
  IF v_staff THEN
    v_booker := p_booker_profile_id;
    -- Un staff solo reserva a nombre de gente vinculada a SU escuela (o de un invitado que él identifica por teléfono).
    IF v_booker IS NOT NULL AND public._reservas_rol(v_fac.school_id, v_booker) = 'external' THEN
      RETURN public._reservas_err('FORBIDDEN');
    END IF;
    IF p_guest_booker_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.facility_reservations r
                      WHERE r.guest_booker_id = p_guest_booker_id AND r.school_id = v_fac.school_id) THEN
        RETURN public._reservas_err('FORBIDDEN');       -- sin historial en esta escuela: usar p_guest con su teléfono
      END IF;
      v_guest := p_guest_booker_id;
    ELSIF p_guest IS NOT NULL THEN
      -- Nunca pisa nombre/correo de un invitado que ya existe (es de otra gente y de otras escuelas).
      INSERT INTO public.guest_bookers (phone, full_name, email)
      VALUES (btrim(p_guest ->> 'phone'), btrim(p_guest ->> 'full_name'), NULLIF(btrim(COALESCE(p_guest ->> 'email', '')), ''))
      ON CONFLICT (phone) DO NOTHING
      RETURNING id INTO v_guest;
      IF v_guest IS NULL THEN
        SELECT gb.id INTO v_guest FROM public.guest_bookers gb WHERE gb.phone = btrim(p_guest ->> 'phone');
      END IF;
    END IF;
    IF v_booker IS NOT NULL AND v_guest IS NOT NULL THEN
      RETURN public._reservas_err('INVALID_ARGUMENT');
    END IF;
    IF v_booker IS NULL AND v_guest IS NULL THEN
      v_booker := v_actor;                          -- uso interno: queda a nombre del staff
    END IF;
  ELSE
    IF v_actor IS NOT NULL THEN
      IF (p_booker_profile_id IS NOT NULL AND p_booker_profile_id <> v_actor) THEN
        RETURN public._reservas_err('FORBIDDEN');
      END IF;
      IF p_guest_booker_id IS NOT NULL THEN
        RETURN public._reservas_err('INVALID_ARGUMENT');
      END IF;
      v_booker := v_actor;
    ELSE
      IF p_booker_profile_id IS NOT NULL THEN
        RETURN public._reservas_err('FORBIDDEN');
      END IF;
      IF p_guest_booker_id IS NULL THEN
        RETURN public._reservas_err('GUEST_REQUIRED');
      END IF;
      v_guest := p_guest_booker_id;
    END IF;
  END IF;

  IF v_guest IS NOT NULL THEN
    SELECT gb.verified_phone_at INTO v_gverif FROM public.guest_bookers gb WHERE gb.id = v_guest;
    IF NOT FOUND THEN
      RETURN public._reservas_err('GUEST_NOT_FOUND');
    END IF;
    IF NOT v_staff AND v_gverif IS NULL THEN
      RETURN public._reservas_err('GUEST_NOT_VERIFIED');
    END IF;
  END IF;

  -- ── 3. tarifa y reglas de quién puede ──────────────────────────────────────
  v_aud := public._reservas_audiencia(v_fac.bookable_by, v_rol, CASE WHEN v_staff THEN p_rate_audience END);
  IF v_aud IS NULL THEN
    RETURN public._reservas_err('AUDIENCE_NOT_ALLOWED');
  END IF;

  IF NOT v_staff AND v_booker IS NOT NULL AND public._reservas_es_menor(v_booker) THEN
    RETURN public._reservas_err('MINOR_CANNOT_BOOK');
  END IF;

  IF p_payment_method = 'none' AND NOT v_staff THEN
    RETURN public._reservas_err('PAYMENT_METHOD_NOT_ALLOWED');
  END IF;
  IF p_payment_method = 'cash' AND NOT v_staff AND (v_rol <> 'member' OR v_guest IS NOT NULL) THEN
    RETURN public._reservas_err('PAYMENT_REQUIRED');
  END IF;

  -- ── 4. lock por cancha-día e idempotencia ──────────────────────────────────
  v_day := (p_starts_at AT TIME ZONE 'America/Bogota')::date;
  PERFORM pg_advisory_xact_lock(hashtextextended('facility_slot:' || p_facility_id::text || ':' || v_day::text, 0));

  SELECT * INTO v_ex FROM public.facility_reservations
   WHERE school_id = v_fac.school_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_ex.facility_id = p_facility_id AND v_ex.starts_at = p_starts_at AND v_ex.ends_at = p_ends_at
       AND v_ex.user_id IS NOT DISTINCT FROM v_booker AND v_ex.guest_booker_id IS NOT DISTINCT FROM v_guest THEN
      RETURN public._reservas_resultado(v_ex.id, true);
    END IF;
    RETURN public._reservas_err('IDEMPOTENCY_KEY_REUSED');
  END IF;

  -- Anti-acaparamiento: máximo 3 reservas activas futuras por reservante en esta escuela (no staff).
  IF NOT v_staff AND (
       SELECT count(*) FROM public.facility_reservations r
        WHERE r.school_id = v_fac.school_id
          AND r.status IN ('hold', 'pending_payment', 'pending', 'confirmed')
          AND r.ends_at > now()
          AND ((v_booker IS NOT NULL AND r.user_id = v_booker) OR (v_guest IS NOT NULL AND r.guest_booker_id = v_guest))) >= 3 THEN
    RETURN public._reservas_err('TOO_MANY_ACTIVE');
  END IF;

  -- ── 5. rango, horario, anticipación, blackouts ─────────────────────────────
  v_err := public._reservas_validar_rango(p_facility_id, p_starts_at, p_ends_at, v_staff);
  IF v_err IS NOT NULL THEN
    RETURN public._reservas_err(v_err);
  END IF;
  IF v_staff THEN
    v_override := public._reservas_validar_rango(p_facility_id, p_starts_at, p_ends_at, false) IS NOT NULL;
  END IF;
  v_dur_min := (EXTRACT(EPOCH FROM (p_ends_at - p_starts_at)) / 60)::integer;

  -- ── 6. precio ──────────────────────────────────────────────────────────────
  SELECT jsonb_agg(jsonb_build_object('from', public._reservas_iso(p.step_from), 'to', public._reservas_iso(p.step_to),
                                      'rate', p.rate, 'source', p.source) ORDER BY p.step_from),
         round(sum(p.rate * EXTRACT(EPOCH FROM (p.step_to - p.step_from)) / 3600.0)),
         CASE WHEN bool_or(p.source = 'facility_rates') THEN 'facility_rates' ELSE 'facility_default' END
    INTO v_steps, v_total, v_source
    FROM public._reservas_precio_pasos(p_facility_id, p_starts_at, p_ends_at, v_aud) p;
  IF v_total IS NULL THEN
    RETURN public._reservas_err('INVALID_RANGE');
  END IF;
  IF v_total = 0 AND NOT v_staff THEN
    RETURN public._reservas_err('PRICE_NOT_CONFIGURED');   -- no hay waiver explícito: una cancha sin tarifa no se regala
  END IF;
  IF v_paid > v_total THEN
    RETURN public._reservas_err('INVALID_AMOUNT');
  END IF;
  v_deposit := round(v_total * v_fac.min_deposit_pct / 100.0);
  v_price   := v_total;

  -- ── 7. estado inicial ──────────────────────────────────────────────────────
  v_hold_min := NULL;
  IF v_staff AND p_payment_method = 'none' THEN
    v_status := 'confirmed'; v_pay := 'waived'; v_price := 0; v_paid := 0;
  ELSIF v_total = 0 THEN
    v_status := 'confirmed'; v_pay := 'waived';
  ELSIF p_payment_method = 'cash' THEN
    v_status := 'confirmed';
    v_pay := CASE WHEN v_paid = 0 THEN 'unpaid' WHEN v_paid >= v_total THEN 'paid' ELSE 'partial' END;
  ELSE
    v_status   := 'pending_payment';
    v_hold_min := CASE WHEN p_payment_method = 'transfer' THEN 15 ELSE 10 END;
    v_pay := CASE WHEN v_paid = 0 THEN 'unpaid' WHEN v_paid >= v_total THEN 'paid' ELSE 'partial' END;
  END IF;
  v_hold_exp := CASE WHEN v_status = 'pending_payment' THEN now() + make_interval(mins => v_hold_min) END;

  v_btype := CASE
    WHEN v_guest IS NOT NULL OR v_rol = 'external' OR (v_staff AND p_external_org_name IS NOT NULL) THEN 'external'
    WHEN v_staff THEN 'school'
    WHEN EXISTS (SELECT 1 FROM public.school_members sm
                  WHERE sm.profile_id = v_booker AND sm.school_id = v_fac.school_id
                    AND sm.role = 'athlete' AND sm.status = 'active') THEN 'athlete'
    ELSE 'parent' END;
  v_rtype := CASE WHEN v_btype = 'external' THEN 'rental' ELSE 'internal' END;
  v_ref   := 'RSV-' || upper(left(replace(v_id::text, '-', ''), 16));

  v_snap := jsonb_build_object(
    'audience', v_aud, 'total', v_total, 'deposit_min', v_deposit, 'source', v_source,
    'breakdown', COALESCE(v_steps, '[]'::jsonb), 'payment_method', p_payment_method,
    'hold_minutes', v_hold_min, 'staff_override', v_override, 'created_by', v_actor,
    'payment_events', '[]'::jsonb);

  -- ── 8. libera holds vencidos de esa cancha-día e inserta ───────────────────
  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);

  -- Un hold vencido con plata adentro NO se pierde: pasa a conciliación (libera la franja igual).
  UPDATE public.facility_reservations
     SET status = CASE WHEN amount_paid > 0 THEN 'pending_reconciliation' ELSE 'expired' END, updated_at = now()
   WHERE facility_id = p_facility_id AND reservation_date = v_day
     AND status IN ('hold', 'pending_payment')
     AND hold_expires_at IS NOT NULL AND hold_expires_at < now();

  UPDATE public.facility_occupancy
     SET status = 'released', updated_at = now()
   WHERE facility_id = p_facility_id AND status = 'hold' AND hold_expires_at < now();

  BEGIN
    INSERT INTO public.facility_reservations (
      id, facility_id, user_id, school_id, reservation_date, start_time, end_time,
      status, price, notes, participants, approved_by, approved_at,
      booker_type, resv_type, external_org_name, min_deposit_pct, payment_status, amount_paid,
      starts_at, ends_at, hold_expires_at, idempotency_key, channel, guest_booker_id,
      price_snapshot, payment_reference)
    VALUES (
      v_id, p_facility_id, v_booker, v_fac.school_id,
      v_day, (p_starts_at AT TIME ZONE 'America/Bogota')::time, (p_ends_at AT TIME ZONE 'America/Bogota')::time,
      v_status, v_price, p_notes, GREATEST(COALESCE(p_participants, 1), 1),
      CASE WHEN v_staff AND v_status = 'confirmed' THEN v_actor END,
      CASE WHEN v_status = 'confirmed' THEN now() END,
      v_btype::public.booker_type, v_rtype::public.resv_type, p_external_org_name,
      v_fac.min_deposit_pct, v_pay::public.resv_payment_status, v_paid,
      p_starts_at, p_ends_at, v_hold_exp, p_idempotency_key, p_channel, v_guest,
      v_snap, v_ref);
  EXCEPTION
    WHEN exclusion_violation THEN
      PERFORM set_config('sportmaps.rpc_reservas', '', true);
      BEGIN
        v_av := public.disponibilidad_canchas(v_fac.school_id, v_day, v_day + 2, NULL, p_facility_id,
                                              v_dur_min, CASE WHEN v_staff THEN p_rate_audience END, p_actor_profile_id);
        SELECT COALESCE(jsonb_agg(x.slot ORDER BY x.ord), '[]'::jsonb) INTO v_alt
          FROM (SELECT (sl || jsonb_build_object('facility_id', p_facility_id)) AS slot, (sl ->> 'starts_at') AS ord
                  FROM jsonb_array_elements(COALESCE(v_av -> 'facilities' -> 0 -> 'days', '[]'::jsonb)) AS d,
                       jsonb_array_elements(d -> 'slots') AS sl
                 WHERE (sl ->> 'starts_at')::timestamptz >= p_starts_at
                 ORDER BY (sl ->> 'starts_at')
                 LIMIT 3) x;
      EXCEPTION WHEN OTHERS THEN
        v_alt := '[]'::jsonb;
      END;
      RETURN public._reservas_err('SLOT_TAKEN') || jsonb_build_object('alternatives', v_alt);
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      PERFORM set_config('sportmaps.rpc_reservas', '', true);
      IF v_cons = 'uq_facility_reservations_idempotency' THEN
        SELECT * INTO v_ex FROM public.facility_reservations
         WHERE school_id = v_fac.school_id AND idempotency_key = p_idempotency_key;
        IF FOUND AND v_ex.facility_id = p_facility_id AND v_ex.starts_at = p_starts_at AND v_ex.ends_at = p_ends_at
           AND v_ex.user_id IS NOT DISTINCT FROM v_booker AND v_ex.guest_booker_id IS NOT DISTINCT FROM v_guest THEN
          RETURN public._reservas_resultado(v_ex.id, true);
        END IF;
        RETURN public._reservas_err('IDEMPOTENCY_KEY_REUSED');
      END IF;
      RETURN public._reservas_err('SLOT_TAKEN') || jsonb_build_object('alternatives', '[]'::jsonb);
  END;

  PERFORM set_config('sportmaps.rpc_reservas', '', true);
  RETURN public._reservas_resultado(v_id, false);
END;
$$;

REVOKE ALL ON FUNCTION public.reservar_cancha(uuid, timestamptz, timestamptz, text, text, text, uuid, uuid, uuid, jsonb, text, integer, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reservar_cancha(uuid, timestamptz, timestamptz, text, text, text, uuid, uuid, uuid, jsonb, text, integer, text, text, numeric) TO authenticated, service_role;

COMMIT;
