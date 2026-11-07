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
