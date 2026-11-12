-- =============================================================================
-- 20261112114054_organizador_entidad_propia.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-12   Versión anterior: 20261111151130
-- Spec: docs/specs/organizador-torneos-modulo-aparte.md (§3 modelo, §4 plan gratis, D1/D3).
--
-- Objetivo: que el rol Organizador TENGA ENTIDAD. Hoy el organizador tiene pantallas pero
--   ninguna fila que lo represente: el BFF lo rechaza (requireAuth exige school_members) y
--   todo el motor de torneos cuelga de events.school_id. Se replica el precedente de
--   facility_manager / venue (20261105163452): la organización es una fila de `schools` con
--   school_type = 'event_organizer', dueño = el perfil, membresía owner (la crea
--   handle_new_school). Cero cambios en RLS: can_manage_event / is_school_admin_of /
--   user_admin_school_ids ya reconocen al owner.
--
--   A. schools_school_type_check: + 'event_organizer'. v_school_entitlements.has_academy
--      NO lo incluye (su lista es positiva) → no ve módulos de academia. Verificado vivo.
--   B. _create_organizer_org(uuid, text, text): helper idempotente. Crea la escuela, y deja
--      la suscripción en plan GRATIS (active, free, blocking_exempt: «nadie pierde acceso»,
--      spec §4.2) y el complemento `tournaments` encendido a $0. Sin GRANT a nadie.
--   C. create_organizer_org(...): RPC del onboarding. Ata SIEMPRE a auth.uid() (nunca recibe
--      un id de usuario/escuela). Exige profiles.role = 'organizer'. Crea o completa SU
--      organización. GRANT EXECUTE solo a authenticated.
--   D. normalize_signup_role: + 'organizer'. handle_new_user: copia ENTERA de la definición
--      viva (md5 coincide con 20261105163452, verificado 2026-11-12) con UN bloque nuevo:
--      si el rol resuelto es organizer y hay school_name, crea la organización.
--
--   NO toca: RLS de events (F1 #4, va aparte con medición de radio), event_organizers
--   (0 filas; se retira en F1 con confirmación), complete_role_selection (ya acepta organizer).
-- =============================================================================

BEGIN;

-- ── A. Tipo de entidad ───────────────────────────────────────────────────────
ALTER TABLE public.schools DROP CONSTRAINT IF EXISTS schools_school_type_check;
ALTER TABLE public.schools ADD CONSTRAINT schools_school_type_check
  CHECK (school_type IS NULL OR school_type = ANY (ARRAY[
    'academy','club','federation','institute','personal_trainer','association',
    'hybrid','gimnasio','escuela','venue','event_organizer'
  ]));

-- ── B. Helper: crear la organización (idempotente) ───────────────────────────
CREATE OR REPLACE FUNCTION public._create_organizer_org(p_user uuid, p_name text, p_city text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'usuario requerido' USING ERRCODE = '22004';
  END IF;

  -- Idempotente: una sola organización por dueño.
  SELECT id INTO v_school
    FROM public.schools
   WHERE owner_id = p_user AND school_type = 'event_organizer'
   ORDER BY created_at
   LIMIT 1;

  IF v_school IS NULL THEN
    -- on_school_created crea settings + membresía owner; schools_create_default_subscription
    -- deja una suscripción 'trialing' de 1 mes que se reemplaza abajo por el plan gratis.
    INSERT INTO public.schools (name, owner_id, school_type, city, onboarding_status, onboarding_step)
    VALUES (left(trim(p_name), 120), p_user, 'event_organizer', NULLIF(trim(COALESCE(p_city, '')), ''), 'in_progress', 1)
    RETURNING id INTO v_school;
  END IF;

  -- Plan GRATIS (spec §4.2): activo, sin bloqueo por fin de prueba. Los niveles de pago los
  -- fija el super admin con custom_price_cents / el complemento; esto es solo el piso.
  INSERT INTO public.school_subscriptions (
    school_id, plan_code, tier, status, billing_cycle, trial_months,
    blocking_exempt, blocking_exempt_reason, metadata
  ) VALUES (
    v_school, 'starter', 'free', 'active', 'monthly', 0,
    true, 'Organizador de torneos: plan Gratis (nadie pierde acceso)',
    jsonb_build_object('created_via', 'organizer_signup')
  )
  ON CONFLICT (school_id) DO UPDATE
     SET status = CASE WHEN school_subscriptions.status IN ('trialing','trial_expired') THEN 'active'
                       ELSE school_subscriptions.status END,
         blocking_exempt = true,
         blocking_exempt_reason = COALESCE(school_subscriptions.blocking_exempt_reason,
                                           'Organizador de torneos: plan Gratis (nadie pierde acceso)'),
         updated_at = now()
   WHERE school_subscriptions.tier = 'free' AND school_subscriptions.plan_code = 'starter';

  -- Complemento Torneos encendido a $0 (el nivel pago lo pone el super admin).
  INSERT INTO public.school_addons (school_id, addon_key, enabled, enabled_at, monthly_price_cents, metadata)
  VALUES (v_school, 'tournaments', true, now(), 0, jsonb_build_object('source', 'organizer_free'))
  ON CONFLICT (school_id, addon_key) DO NOTHING;

  RETURN v_school;
END;
$$;

REVOKE ALL ON FUNCTION public._create_organizer_org(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ── C. RPC del onboarding: crea o completa MI organización ───────────────────
CREATE OR REPLACE FUNCTION public.create_organizer_org(
  p_name        text,
  p_city        text    DEFAULT NULL,
  p_sports      text[]  DEFAULT NULL,
  p_description text    DEFAULT NULL,
  p_logo_url    text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_role   text;
  v_school uuid;
  v_name   text := trim(COALESCE(p_name, ''));
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida' USING ERRCODE = '28000';
  END IF;

  SELECT role::text INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Solo una cuenta de organizador puede crear una organización' USING ERRCODE = '42501';
  END IF;

  IF char_length(v_name) < 2 OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'El nombre de la organización debe tener entre 2 y 120 caracteres' USING ERRCODE = '22023';
  END IF;
  IF p_logo_url IS NOT NULL AND p_logo_url <> '' AND p_logo_url !~* '^https://' THEN
    RAISE EXCEPTION 'El logo debe ser una URL https' USING ERRCODE = '22023';
  END IF;

  v_school := public._create_organizer_org(v_uid, v_name, p_city);

  UPDATE public.schools
     SET name              = v_name,
         city              = COALESCE(NULLIF(trim(COALESCE(p_city, '')), ''), city),
         sports            = COALESCE(p_sports, sports),
         description       = COALESCE(NULLIF(trim(COALESCE(p_description, '')), ''), description),
         logo_url          = COALESCE(NULLIF(trim(COALESCE(p_logo_url, '')), ''), logo_url),
         onboarding_status = 'completed',
         onboarding_step   = 3
   WHERE id = v_school AND owner_id = v_uid;

  UPDATE public.profiles SET onboarding_completed = true WHERE id = v_uid;

  RETURN v_school;
END;
$$;

REVOKE ALL ON FUNCTION public.create_organizer_org(text, text, text[], text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_organizer_org(text, text, text[], text, text) TO authenticated;

-- ── D. Registro: lista blanca + alta de la organización ──────────────────────
CREATE OR REPLACE FUNCTION public.normalize_signup_role(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE LOWER(TRIM(COALESCE(p_role, '')))
        WHEN 'athlete'               THEN 'athlete'
        WHEN 'parent'                THEN 'parent'
        WHEN 'padre'                 THEN 'parent'
        WHEN 'coach'                 THEN 'coach'
        WHEN 'school'                THEN 'school'
        WHEN 'wellness_professional' THEN 'wellness_professional'
        WHEN 'wellness'              THEN 'wellness_professional'
        WHEN 'store_owner'           THEN 'store_owner'
        WHEN 'personal_trainer'      THEN 'personal_trainer'
        WHEN 'facility_manager'      THEN 'facility_manager'
        WHEN 'organizer'             THEN 'organizer'
        ELSE NULL
    END;
$$;

REVOKE ALL ON FUNCTION public.normalize_signup_role(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.normalize_signup_role(text) TO service_role;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  meta_role       text;
  normalized_role text;
  legacy_role     text;
  valid_role_id   uuid;
  new_school_id   uuid;
  school_name_val text;
  v_needs_role    boolean;
  v_dob           date;
  v_invitado      boolean := false;
BEGIN
  meta_role       := LOWER(TRIM(new.raw_user_meta_data->>'role'));
  school_name_val := new.raw_user_meta_data->>'school_name';

  v_needs_role := (meta_role IS NULL OR meta_role = '');

  BEGIN
    v_dob := NULLIF(new.raw_user_meta_data->>'date_of_birth', '')::date;
  EXCEPTION WHEN others THEN
    v_dob := NULL;
  END;

  -- Rol: SOLO de la lista blanca. El metadata lo escribe el cliente.
  legacy_role := public.normalize_signup_role(meta_role);

  IF legacy_role IS NULL AND NOT v_needs_role THEN
    -- Pidió un rol que no se autoasigna. ¿Lo respalda una invitación pendiente
    -- a SU correo con ESE rol? (los links de invitación llevan &role=<rol>).
    BEGIN
      SELECT EXISTS (
        SELECT 1 FROM public.invitations i
         WHERE i.status = 'pending'
           AND i.email IS NOT NULL
           AND LOWER(TRIM(i.email)) = LOWER(TRIM(new.email))
           AND LOWER(TRIM(i.role_to_assign)) = meta_role
      ) INTO v_invitado;
    EXCEPTION WHEN others THEN
      v_invitado := false;
    END;

    IF v_invitado THEN
      -- accept_invitation_pro le pone el rol real; mientras tanto, el menor
      -- privilegio y sin pasar por /onboarding/role.
      legacy_role  := 'athlete';
      v_needs_role := false;
    ELSIF meta_role IN ('school_admin', 'admin') THEN
      -- Alta de escuela con el nombre del catálogo (así se registraron 7
      -- dueños en feb–mar 2026). Mismo resultado que el cuerpo anterior.
      legacy_role := 'school';
    ELSE
      -- super_admin, reporter, accountant, external_vendor, basura…
      legacy_role  := 'athlete';
      v_needs_role := true;
    END IF;
  END IF;

  IF legacy_role IS NULL OR legacy_role = '' THEN
    legacy_role := 'athlete';   -- sin rol (OAuth): v_needs_role ya es true
  END IF;

  normalized_role := CASE legacy_role WHEN 'school' THEN 'school_admin' ELSE legacy_role END;
  SELECT id INTO valid_role_id FROM public.roles WHERE LOWER(name) = normalized_role LIMIT 1;

  INSERT INTO public.profiles (
    id, full_name, role, role_id, email,
    avatar_url, phone, date_of_birth, invitation_code, needs_role_selection
  )
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Nuevo Usuario'),
    legacy_role::public.user_role,
    valid_role_id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'avatar_url', new.raw_user_meta_data->>'picture'),
    new.raw_user_meta_data->>'phone',
    v_dob,
    new.raw_user_meta_data->>'invitation_code',
    v_needs_role
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name        = EXCLUDED.full_name,
    phone            = COALESCE(EXCLUDED.phone, profiles.phone),
    date_of_birth    = COALESCE(EXCLUDED.date_of_birth, profiles.date_of_birth),
    role             = EXCLUDED.role,
    role_id          = EXCLUDED.role_id,
    invitation_code  = COALESCE(EXCLUDED.invitation_code, profiles.invitation_code),
    updated_at       = now();

  -- Auto-creación de escuela AISLADA. NO se crea la sede aquí: el trigger
  -- on_school_created (handle_new_school) crea Sede Principal + settings +
  -- membresía owner. Insertarla aquí también duplicaba la "Sede Principal".
  -- Con invitación pendiente legacy_role es 'athlete': no se crea escuela
  -- fantasma con el nombre de la escuela que invita.
  IF legacy_role = 'school' AND school_name_val IS NOT NULL AND school_name_val <> '' THEN
    BEGIN
      INSERT INTO public.schools (name, owner_id, onboarding_status, onboarding_step)
      VALUES (school_name_val, new.id, 'in_progress', 2)
      ON CONFLICT DO NOTHING;
    EXCEPTION WHEN others THEN
      NULL;  -- el perfil school ya quedó; la escuela se crea luego en onboarding
    END;
  END IF;

  -- Dueño de espacios (SportMaps Canchas): escuela school_type 'venue'. El tipo lo fija ESTE
  -- trigger según el rol de la lista blanca; el school_type del metadata del cliente se
  -- IGNORA (nadie sale 'venue' sin haber elegido el rol, y ningún otro rol sale 'venue').
  IF legacy_role = 'facility_manager' AND school_name_val IS NOT NULL AND school_name_val <> '' THEN
    BEGIN
      INSERT INTO public.schools (name, owner_id, school_type, onboarding_status, onboarding_step)
      VALUES (school_name_val, new.id, 'venue', 'in_progress', 2)
      ON CONFLICT DO NOTHING;
    EXCEPTION WHEN others THEN
      -- No rompe el alta (el perfil ya quedó), pero deja rastro para diagnosticar.
      RAISE WARNING 'handle_new_user venue %: %', new.id, SQLERRM;
    END;
  END IF;

  -- Organizador de torneos: su organización es una fila de schools con school_type
  -- 'event_organizer' (spec organizador-torneos-modulo-aparte §3). El tipo lo fija ESTE
  -- trigger según el rol de la lista blanca; el school_type del metadata se IGNORA.
  -- Sin nombre no se crea: el organizador la crea después en su onboarding
  -- (create_organizer_org). Un fallo no rompe el alta: el perfil ya quedó.
  IF legacy_role = 'organizer' AND school_name_val IS NOT NULL AND school_name_val <> '' THEN
    BEGIN
      PERFORM public._create_organizer_org(new.id, school_name_val, NULL);
    EXCEPTION WHEN others THEN
      RAISE WARNING 'handle_new_user organizer %: %', new.id, SQLERRM;
    END;
  END IF;

  RETURN new;

EXCEPTION WHEN others THEN
  BEGIN
    INSERT INTO public.profiles (id, full_name, role, role_id, email, needs_role_selection)
    VALUES (
      new.id,
      COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Nuevo Usuario'),
      -- legacy_role solo puede ser un valor de la lista blanca, 'school' o 'athlete'.
      COALESCE(NULLIF(legacy_role, ''), 'athlete')::public.user_role,
      valid_role_id,
      new.email,
      COALESCE(v_needs_role, true)
    )
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN others THEN
    BEGIN
      INSERT INTO public.profiles (id, full_name, role, email, needs_role_selection)
      VALUES (
        new.id,
        COALESCE(new.raw_user_meta_data->>'full_name', 'Nuevo Usuario'),
        'athlete'::public.user_role,
        new.email,
        true
      )
      ON CONFLICT (id) DO NOTHING;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END;
  RETURN new;
END;
$function$;

COMMIT;
