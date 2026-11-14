-- =============================================================================
-- 20261105163452_registro_dueno_de_espacios.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105163357
-- ORDEN REQUERIDO: después de 20261014153533 (enum facility_manager) y 20261014153542
--   (school_type 'venue' en el CHECK y gating por addon); ambas verificadas vivas. Conviene
--   aplicarla junto con (o después de) schools_school_type_venue_guard.
--
-- Objetivo: que el registro "Club / Canchas" (rol facility_manager) funcione.
--   El frontend manda raw_user_meta_data role='facility_manager', school_name y
--   school_type='venue'. Antes: normalize_signup_role no conocía el rol (caía a athlete +
--   needs_role_selection) y handle_new_user solo creaba escuela para 'school'.
--
--   A. normalize_signup_role: + 'facility_manager'.
--   B. handle_new_user: copia ENTERA de la última definición (20261010202857; ninguna
--      migración posterior la redefine, verificado por grep) con UN cambio: si el rol
--      resuelto es facility_manager y hay school_name, crea la escuela con
--      school_type = 'venue' FIJADO POR EL TRIGGER. El school_type del metadata se ignora.
--      on_school_created (handle_new_school) crea settings + membresía owner para esa
--      escuela igual que para cualquiera. Ramas y gates previos intactos (invitación
--      pendiente, school_admin/admin → school, basura → athlete + needs_role_selection).
--   C. complete_role_selection NO se toca (OAuth queda fuera de v1).
--
--   facility_manager NO recibe privilegios de plataforma: is_platform_admin() /
--   is_super_admin() se basan en platform_admins y app_metadata, no en profiles.role.
--   No se inserta fila en public.roles (no hay patrón claro; el fallback valid_role_id NULL
--   ya se tolera: el rol manda por profiles.role).
-- =============================================================================

BEGIN;

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
      -- super_admin, reporter, accountant, organizer, external_vendor, basura…
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
