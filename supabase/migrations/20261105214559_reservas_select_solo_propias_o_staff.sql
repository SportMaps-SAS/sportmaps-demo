-- 20261105214559_reservas_select_solo_propias_o_staff.sql
--
-- ORDEN EN PRODUCCIÓN: después de 20261105212125 (staff/canales) y de 20261105213601 (anon); ANTES de
--   20261105213611 (M7, que va al final). Es independiente de M7: ambas usan DROP POLICY IF EXISTS y ninguna
--   contradice a la otra (M7 deja facility_resv_school_select y facility_resv_select_own; esta deja
--   facility_resv_select_own y facility_resv_select_staff_scope). Puede aplicarse YA, sin esperar al frontend:
--   ninguna pantalla de padre/atleta lee reservas ajenas (verificado con Grep, ver abajo).
--
-- POR QUÉ (privacidad): la policy reservations_select (SELECT, authenticated) dejaba a CUALQUIER miembro activo de
-- la escuela (padre, atleta) leer TODAS las reservas de sus instalaciones, con user_id, notas, nombres de invitado
-- y montos de otras familias.
--
-- DESPUÉS: el reservante ve las SUYAS (facility_resv_select_own: user_id = auth.uid(), ya existente) y quien tiene
-- alcance operativo ve las de su escuela: user_staff_school_ids() (incluye coach: lo necesita
-- AttendanceSupervisionPage para la agenda del día) o user_admin_school_ids() (dueño/admin). Padres y atletas ya
-- NO ven reservas ajenas. La disponibilidad pública NO depende de esta policy: sale de la RPC disponibilidad_canchas
-- y de facility_occupancy vía SECURITY DEFINER.
--
-- VERIFICACIÓN de dependencias (Grep frontend/src y bff/src): las únicas lecturas con JWT de usuario de
-- facility_reservations son hooks/useFacilityReservations.ts (listado y getBookedSlots, usados por
-- SchoolFacilitiesPage, OwnerReservationModal y CourtesyBookingRescheduleModal: pantallas del staff/dueño),
-- AttendanceSupervisionPage.tsx (:331 y :471, staff/coach) y pages/venue/useVenueSummary.ts (dueño de la sede).
-- Ninguna pantalla de padre o atleta lee reservas ajenas; el BFF usa service_role. Sin dependencia legítima, así
-- que no hace falta vista ni RPC de ocupación.
-- Nota: un contador (rol accountant) ya no ve reservas; ninguna pantalla contable las lee.

BEGIN;

DROP POLICY IF EXISTS reservations_select ON public.facility_reservations;

DROP POLICY IF EXISTS facility_resv_select_staff_scope ON public.facility_reservations;
CREATE POLICY facility_resv_select_staff_scope ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.facilities f
                  WHERE f.id = facility_reservations.facility_id
                    AND (f.school_id = ANY (public.user_staff_school_ids())
                         OR f.school_id = ANY (public.user_admin_school_ids()))));

-- La del reservante ya existe (facility_resv_select_own, USING auth.uid() = user_id); se recrea por si faltara,
-- sin ampliarla.
DROP POLICY IF EXISTS facility_resv_select_own ON public.facility_reservations;
CREATE POLICY facility_resv_select_own ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

COMMIT;
