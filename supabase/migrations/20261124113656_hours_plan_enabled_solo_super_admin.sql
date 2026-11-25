-- =============================================================================
-- 20261124113656_hours_plan_enabled_solo_super_admin.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-24
-- Objetivo: cerrar un hueco. school_settings.hours_plan_enabled (el interruptor del
--   banco de horas) solo debe moverlo un super admin vía admin_set_hours_plan_enabled,
--   pero la policy «Admin puede escribir school_settings» deja al dueño (y a cualquier
--   is_school_admin) escribir CUALQUIER columna con un PATCH directo. Hallado el
--   2026-11-24 al armar el manual de control de acceso: con la sesión del owner del
--   tenant demo se pudo encender y apagar el flag.
--
-- Mismo patrón que guard_merchandise_enabled_super_admin_only (20260903171854) y los
--   guardianes de billing / torneos, con dos diferencias a propósito:
--   · cubre también INSERT (un upsert del cliente puede crear la fila ya encendida);
--   · deja pasar a quien no es una sesión de usuario (auth.uid() IS NULL: service_role,
--     migraciones, mantenimiento), igual que el resto de las rutas del BFF.
--   Un super admin (directo o por la RPC SECURITY DEFINER) sigue pudiendo moverlo.
--
-- Efecto: para el dueño/admin de una escuela, el cambio de hours_plan_enabled se
--   ignora en silencio (se conserva el valor anterior, o false en un INSERT).
--   No cambia ninguna fila existente: Dreamers y Academia Superior Bogotá quedan igual.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_hours_plan_enabled_super_admin_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    -- Sin sesión de usuario (service_role / migración): no es un cliente, pasa.
    IF (SELECT auth.uid()) IS NULL OR public.is_super_admin() THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.hours_plan_enabled := false;
    ELSIF NEW.hours_plan_enabled IS DISTINCT FROM OLD.hours_plan_enabled THEN
        NEW.hours_plan_enabled := OLD.hours_plan_enabled;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_hours_plan_enabled_super_admin_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_hours_plan_enabled ON public.school_settings;
CREATE TRIGGER trg_guard_hours_plan_enabled
    BEFORE INSERT OR UPDATE ON public.school_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_hours_plan_enabled_super_admin_only();

COMMIT;
