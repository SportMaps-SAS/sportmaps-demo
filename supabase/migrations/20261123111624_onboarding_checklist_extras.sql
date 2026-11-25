-- =============================================================================
-- 20261123111624_onboarding_checklist_extras.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123085942
-- Objetivo: onboarding etapa 2. Datos que el checklist del panel necesita y que
--   get_onboarding_status() no trae, marcados por lo que EXISTE en la base:
--     · has_families      (academia): hay una invitación a familia enviada o un
--                         acudiente vinculado (school_members.role = 'parent').
--     · has_facility / has_reservation / has_payment_method (Club / Canchas).
--   Una RPC aparte, y no otra reedición de get_onboarding_status, para no tocar
--   de nuevo una función que ya se reemitió en 20261123084254.
-- Depende de: _school_has_payment_method(uuid) (20261123084254).
-- Solo LEE. No escribe en ninguna tabla.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_onboarding_checklist_extras(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- El alcance del caller se valida SOBRE ESE id: solo quien trabaja en la
  -- escuela (staff/admin/dueño; no padres ni atletas) ve su avance.
  IF p_school_id IS NULL
     OR NOT (p_school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) THEN
    RETURN jsonb_build_object('ok', false);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'has_families',
      EXISTS (
        SELECT 1 FROM public.school_members sm
        WHERE sm.school_id = p_school_id AND sm.role = 'parent' AND sm.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM public.invitations i
        WHERE i.school_id = p_school_id
          AND (i.role_to_assign = 'parent' OR i.child_name IS NOT NULL)
      ),
    'has_facility',
      EXISTS (SELECT 1 FROM public.facilities f WHERE f.school_id = p_school_id),
    'has_reservation',
      EXISTS (SELECT 1 FROM public.facility_reservations r WHERE r.school_id = p_school_id),
    'has_payment_method',
      COALESCE(public._school_has_payment_method(p_school_id), false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_onboarding_checklist_extras(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_checklist_extras(uuid) TO authenticated;

COMMIT;
