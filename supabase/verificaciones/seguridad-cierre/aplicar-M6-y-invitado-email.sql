-- =====================================================================================================
-- aplicar-M6-y-invitado-email.sql  -- ARCHIVO GENERADO: concatena las migraciones tal cual.
-- PARA EL SQL EDITOR DE SUPABASE (produccion), a mano. Cada bloque lleva su BEGIN/COMMIT: si uno falla,
-- parar ahi y avisar, no seguir con el siguiente.
-- ORDEN:
--   1. 20261106152307_reservas_m6_agenda_coach        (coach deja de leer facility_reservations completa; RPC de agenda)
--      PRECONDICION: frontend nuevo desplegado (AttendanceSupervisionPage ya llama a agenda_reservas_escuela). YA ESTA en develop.
--      Radio medido 2026-11-06: pierden lectura directa 47 coaches y 2 reporters; owner/admin/school_admin/staff siguen igual.
--   2. 20261106191635_reservas_guest_email_canal_public  (canal web exige verified_email_at). No cambia nada visible
--      mientras GUEST_WEB_BOOKING_ENABLED siga apagado en Render.
-- Verificacion posterior (solo lectura): post-aplicacion-M6-y-invitado.sql  y  npm run seguridad:invariantes
-- Despues, para encender la reserva web de invitados: GUEST_WEB_BOOKING_ENABLED=true en Render (bff-dev primero).
-- =====================================================================================================

-- ───────── 20261106152307_reservas_m6_agenda_coach.sql ─────────
-- 20261106152307_reservas_m6_agenda_coach.sql
--
-- M6 (seguridad de reservas): el COACH ya no lee facility_reservations completa.
--
-- ORDEN: después de 20261105214559 (que creó facility_resv_select_staff_scope con user_staff_school_ids(),
--   incluido el coach). Va con o sin M7 (20261105213611): M7 no toca esa policy. DESPLEGAR EL FRONTEND NUEVO
--   (que usa la RPC para el coach) ANTES o junto con esta migración.
--
-- PROBLEMA: facility_resv_select_staff_scope dejaba a coach/viewer/reporter leer TODAS las columnas de las
--   reservas de su escuela: user_id del reservante, notas, price, amount_paid, payment_reference,
--   price_snapshot (con datos de invitados), external_org_name, guest_booker_id, etc. RLS filtra filas, no columnas.
--
-- ARREGLO:
--   1. La policy se recrea SOLO para administración (user_admin_school_ids(): owner/admin/school_admin/super_admin
--      y dueño de la escuela) y recepción (school_members.role = 'staff', mismo criterio que
--      _reservas_es_admin(p_incluye_recepcion := true)). Expresado inline: no depende del GRANT de ningún helper nuevo.
--      Coach, viewer y reporter ya no ven filas (siguen viendo las suyas por facility_resv_select_own).
--   2. agenda_reservas_escuela(): RPC SECURITY DEFINER para el staff operativo (incluye coach) con SOLO columnas
--      no sensibles: sin contacto, sin montos, sin notas, sin ids de personas.
--
-- REVERSA: recrear facility_resv_select_staff_scope con user_staff_school_ids() (ver 20261105214559) y
--   DROP FUNCTION public.agenda_reservas_escuela(uuid, timestamptz, timestamptz).

BEGIN;

-- Defensa por si 20261105214559 no se aplicó: esta policy abría la lectura a cualquier miembro (padres incluidos).
DROP POLICY IF EXISTS reservations_select ON public.facility_reservations;

DROP POLICY IF EXISTS facility_resv_select_staff_scope ON public.facility_reservations;
CREATE POLICY facility_resv_select_staff_scope ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.facilities f
     WHERE f.id = facility_reservations.facility_id
       AND (
         f.school_id = ANY (public.user_admin_school_ids())
         OR EXISTS (SELECT 1 FROM public.school_members sm
                     WHERE sm.school_id = f.school_id
                       AND sm.profile_id = auth.uid()
                       AND sm.status = 'active'
                       AND sm.role = 'staff')
       )));

-- ── RPC de agenda para el coach ─────────────────────────────────────────────
-- p_from / p_to: rango [p_from, p_to). Se compara por reservation_date en hora de Bogotá (las filas históricas
-- 'Bloqueo interno' no tienen starts_at). Máximo 62 días por llamada.
CREATE OR REPLACE FUNCTION public.agenda_reservas_escuela(p_school_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  id               uuid,
  facility_id      uuid,
  facility_name    text,
  reservation_date date,
  start_time       time,
  end_time         time,
  starts_at        timestamptz,
  ends_at          timestamptz,
  status           text,
  titulo           text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_d1 date;
  v_d2 date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida' USING ERRCODE = '42501';
  END IF;
  IF p_school_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Parámetros inválidos' USING ERRCODE = '22023';
  END IF;
  -- Alcance atado a ESTE p_school_id (no "alguna escuela").
  IF NOT (p_school_id = ANY (public.user_staff_school_ids())
          OR p_school_id = ANY (public.user_admin_school_ids())) THEN
    RAISE EXCEPTION 'Sin acceso a la escuela' USING ERRCODE = '42501';
  END IF;

  v_d1 := (p_from AT TIME ZONE 'America/Bogota')::date;
  v_d2 := ((p_to - interval '1 microsecond') AT TIME ZONE 'America/Bogota')::date;
  IF v_d2 - v_d1 > 62 THEN
    RAISE EXCEPTION 'Rango máximo: 62 días' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT fr.id, fr.facility_id, f.name::text, fr.reservation_date, fr.start_time, fr.end_time,
         fr.starts_at, fr.ends_at, fr.status::text,
         (CASE WHEN fr.notes = 'Bloqueo interno' THEN 'Bloqueo' ELSE 'Reservada' END)::text
    FROM public.facility_reservations fr
    JOIN public.facilities f ON f.id = fr.facility_id
   WHERE f.school_id = p_school_id
     AND fr.reservation_date BETWEEN v_d1 AND v_d2
     AND fr.status IN ('confirmed', 'pending', 'pending_payment', 'pending_reconciliation', 'completed', 'no_show')
   ORDER BY fr.reservation_date, fr.start_time
   LIMIT 2000;
END;
$$;

COMMENT ON FUNCTION public.agenda_reservas_escuela(uuid, timestamptz, timestamptz) IS
  'Agenda de reservas de una escuela para staff operativo (incluye coach) SIN datos sensibles: solo instalación, horario, estado y título genérico. Valida alcance contra user_staff_school_ids()/user_admin_school_ids() atado a p_school_id.';

REVOKE ALL ON FUNCTION public.agenda_reservas_escuela(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agenda_reservas_escuela(uuid, timestamptz, timestamptz) TO authenticated, service_role;

COMMIT;


-- ───────── 20261106191635_reservas_guest_email_canal_public.sql ─────────
-- 20261106191635_reservas_guest_email_canal_public.sql
--
-- Reserva web de invitado: el canal `public` exige guest_bookers.verified_email_at (OTP por correo) en vez de
-- verified_phone_at, que la web no puede verificar. whatsapp/landing siguen exigiendo telefono verificado.
-- Solo cambia la rama del invitado de reservar_cancha (cuerpo vivo leido de produccion el 2026-11-06).
-- CREATE OR REPLACE conserva los GRANT/REVOKE vigentes (no se tocan). La web sigue apagada hasta
-- GUEST_WEB_BOOKING_ENABLED=true en Render.
-- REVERSA: recrear con la condicion anterior (NOT v_staff AND v_gverif IS NULL).

BEGIN;

CREATE OR REPLACE FUNCTION public.reservar_cancha(p_facility_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_channel text, p_idempotency_key text, p_payment_method text DEFAULT 'online'::text, p_actor_profile_id uuid DEFAULT NULL::uuid, p_booker_profile_id uuid DEFAULT NULL::uuid, p_guest_booker_id uuid DEFAULT NULL::uuid, p_guest jsonb DEFAULT NULL::jsonb, p_rate_audience text DEFAULT NULL::text, p_participants integer DEFAULT 1, p_notes text DEFAULT NULL::text, p_external_org_name text DEFAULT NULL::text, p_amount_paid numeric DEFAULT 0, p_source_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
  v_gverif_email timestamptz;
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
  v_auto    boolean := false;
  v_n       integer;
  v_notes   text;
  v_org     text;
  v_gphone  text;
  v_gname   text;
  v_gemail  text;
BEGIN
  -- ── 0. argumentos ──────────────────────────────────────────────────────────
  IF p_facility_id IS NULL OR p_starts_at IS NULL OR p_ends_at IS NULL
     OR p_channel IS NULL OR p_channel NOT IN ('app', 'public', 'whatsapp', 'admin', 'landing', 'ai', 'import')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR p_payment_method IS NULL OR p_payment_method NOT IN ('online', 'transfer', 'cash', 'none')
     OR (p_rate_audience IS NOT NULL AND p_rate_audience NOT IN ('public', 'member'))
     OR length(COALESCE(p_notes, '')) > 500
     OR length(COALESCE(p_external_org_name, '')) > 200
     OR (p_guest IS NOT NULL AND (jsonb_typeof(p_guest) <> 'object'
                                  OR btrim(COALESCE(public._reservas_limpiar_texto(p_guest ->> 'phone'), '')) = ''
                                  OR btrim(COALESCE(public._reservas_limpiar_texto(p_guest ->> 'full_name'), '')) = ''
                                  OR length(COALESCE(p_guest ->> 'phone', '')) > 40
                                  OR length(COALESCE(p_guest ->> 'full_name', '')) > 200
                                  OR length(COALESCE(p_guest ->> 'email', '')) > 254))
     OR (p_source_ref IS NOT NULL AND p_source_ref !~ '^[A-Za-z0-9:_./#-]{1,200}$')
     OR (p_channel IN ('ai', 'import') AND p_source_ref IS NULL) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  -- Texto libre: sin caracteres de control; nunca se interpola en SQL dinámico (sin SQL dinámico en esta función).
  v_notes := NULLIF(btrim(public._reservas_limpiar_texto(p_notes)), '');
  v_org   := NULLIF(btrim(public._reservas_limpiar_texto(p_external_org_name)), '');
  IF p_guest IS NOT NULL THEN
    v_gphone := btrim(public._reservas_limpiar_texto(p_guest ->> 'phone'));
    v_gname  := btrim(public._reservas_limpiar_texto(p_guest ->> 'full_name'));
    v_gemail := NULLIF(btrim(public._reservas_limpiar_texto(COALESCE(p_guest ->> 'email', ''))), '');
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

  -- Canales automatizados ('ai', 'import'): SOLO service_role con p_actor_profile_id de un ADMINISTRADOR de la
  -- escuela de la cancha; nunca desde authenticated, nunca para invitados, nunca mueven dinero.
  v_auto := p_channel IN ('ai', 'import');
  IF v_auto THEN
    IF v_uid IS NOT NULL OR NOT public._reservas_es_service_call()
       OR p_actor_profile_id IS NULL OR NOT v_staff
       OR NOT public._reservas_es_admin(v_fac.school_id, p_actor_profile_id, false)
       OR p_guest IS NOT NULL OR p_guest_booker_id IS NOT NULL THEN
      RETURN public._reservas_err('CHANNEL_NOT_ALLOWED');
    END IF;
    IF p_payment_method IN ('cash', 'none') OR v_paid > 0 THEN
      RETURN public._reservas_err('PAYMENT_METHOD_NOT_ALLOWED');
    END IF;
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
      VALUES (v_gphone, v_gname, v_gemail)
      ON CONFLICT (phone) DO NOTHING
      RETURNING id INTO v_guest;
      IF v_guest IS NULL THEN
        SELECT gb.id INTO v_guest FROM public.guest_bookers gb WHERE gb.phone = v_gphone;
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
    SELECT gb.verified_phone_at, gb.verified_email_at INTO v_gverif, v_gverif_email FROM public.guest_bookers gb WHERE gb.id = v_guest;
    IF NOT FOUND THEN
      RETURN public._reservas_err('GUEST_NOT_FOUND');
    END IF;
    -- Canal web (public): el invitado se verifica por EMAIL (OTP). Canales whatsapp/landing: sigue el telefono.
    IF NOT v_staff AND (
         (p_channel = 'public' AND v_gverif_email IS NULL)
      OR (p_channel <> 'public' AND v_gverif IS NULL)
    ) THEN
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
  IF v_auto THEN   -- serializa la ráfaga del mismo actor (orden de locks: actor, luego cancha-día)
    PERFORM pg_advisory_xact_lock(hashtextextended('resv_auto:' || v_actor::text, 0));
  END IF;
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

  -- Tope de automatización: 30 reservas creadas por actor por hora (canales ai + import juntos).
  IF v_auto THEN
    SELECT count(*) INTO v_n FROM public.facility_reservations fr
     WHERE fr.channel IN ('ai', 'import') AND fr.created_at > now() - interval '1 hour'
       AND fr.price_snapshot ->> 'created_by' = v_actor::text;
    IF v_n >= 30 THEN
      RETURN public._reservas_err('RATE_LIMITED_AUTOMATION');
    END IF;
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
  IF v_total = 0 AND (NOT v_staff OR (v_auto AND v_source <> 'facility_rates')) THEN
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
    WHEN v_guest IS NOT NULL OR v_rol = 'external' OR (v_staff AND v_org IS NOT NULL) THEN 'external'
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
    'payment_events', '[]'::jsonb, 'created_via', p_channel)
          || CASE WHEN p_source_ref IS NOT NULL THEN jsonb_build_object('source_ref', p_source_ref) ELSE '{}'::jsonb END;

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
      v_status, v_price, v_notes, GREATEST(COALESCE(p_participants, 1), 1),
      CASE WHEN v_staff AND v_status = 'confirmed' THEN v_actor END,
      CASE WHEN v_status = 'confirmed' THEN now() END,
      v_btype::public.booker_type, v_rtype::public.resv_type, v_org,
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
$function$;

COMMIT;


