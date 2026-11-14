-- =============================================================================
-- 20261105164434_schools_school_type_venue_guard.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105163452
-- Objetivo: que nadie se vuelva 'venue' (entitlement de reservas gratis) por su cuenta.
--   La policy "Schools: manage owner" (FOR ALL, owner_id = auth.uid()) deja al dueño de
--   cualquier escuela hacer UPDATE schools SET school_type = 'venue', y SchoolSetupPage
--   hace INSERT con el school_type que manda el cliente. 'venue' = has_reservations y
--   has_wallet sin addon (20261014153542).
--
--   Trigger BEFORE INSERT OR UPDATE OF school_type: se bloquea entrar a 'venue' (INSERT o
--   UPDATE) y salir de 'venue' a otro tipo, SALVO que quien actúe sea:
--     · service_role / postgres / triggers de auth (auth.uid() NULL): incluye handle_new_user,
--       que fija 'venue' en el INSERT del signup de facility_manager (corre en el alta de
--       auth.users, sin JWT de usuario), y el BFF;
--     · super admin de plataforma (is_super_admin()): admin_set_school_type sigue funcionando.
--   Todo lo demás queda libre: 'hybrid' (toggle de alquiler), academy, club, etc.
--   Usos de school_type revisados (grep frontend/src, bff/src, migrations): SchoolSetupPage
--   (INSERT con el tipo elegido; no ofrece venue), AdminSubscriptionsPage →
--   admin_set_school_type (super admin), handle_new_user. Ninguno legítimo se rompe.
-- SECURITY INVOKER con search_path fijo; is_super_admin() ya tiene EXECUTE para authenticated.
-- Orden: independiente; aplicar antes o junto con registro_dueno_de_espacios (que inserta 'venue' sin sesión de usuario).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_schools_school_type_venue_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.school_type IS DISTINCT FROM 'venue' THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.school_type IS NOT DISTINCT FROM OLD.school_type
       OR (NEW.school_type IS DISTINCT FROM 'venue' AND OLD.school_type IS DISTINCT FROM 'venue') THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Cambio hacia/desde 'venue': solo sin sesión de usuario (service_role, postgres, trigger de alta) o super admin.
  IF auth.uid() IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'school_type_venue_reservado: solo un administrador de plataforma puede asignar o quitar el tipo venue; para alquilar tus canchas activa el alquiler (hybrid)'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.fn_schools_school_type_venue_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_schools_school_type_venue_guard ON public.schools;
CREATE TRIGGER trg_schools_school_type_venue_guard
  BEFORE INSERT OR UPDATE OF school_type ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.fn_schools_school_type_venue_guard();

COMMIT;
