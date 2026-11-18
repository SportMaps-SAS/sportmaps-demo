-- =============================================================================
-- 20261118163548_rls_initplan_lote1_tablas_calientes.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-18   Versión anterior: 20261118131559
-- Objetivo: rendimiento de RLS en las tablas de la ruta caliente (plan de
-- arquitectura §11, R2.1; linter auth_rls_initplan / multiple_permissive).
-- =============================================================================
-- QUÉ CAMBIA (y qué NO)
--   Lo que cada policy PERMITE no cambia. Solo cuándo se calcula:
--   · auth.uid()            -> (SELECT auth.uid())                 una vez por consulta
--   · ANY (helper_uuid[]()) -> ANY ((SELECT public.helper())::uuid[])  (la forma
--     sin ::uuid[] da 42883: ver CORRECCIÓN 2026-10-26)
--   · is_platform_admin() / is_super_admin() -> (SELECT public.f())
--   · TO authenticated en las policies {public} que no pueden ser verdaderas sin
--     sesión (todas dependen de auth.uid(); las públicas a propósito —
--     teams_select_public, offering_plans_select_public, el registro de invitado
--     por encuesta— no se tocan). Para anon el resultado ya era «ninguna fila».
--   Las funciones con argumento por fila (is_school_admin(school_id), etc.) NO se
--   tocan aquí: reemplazarlas cambia semántica y va en el lote 2.
--
-- CÓMO SE GENERÓ
--   Desde pg_policies VIVO (la base tiene policies que el repo no crea), con
--   reemplazo mecánico. Verificado el 2026-11-18 antes de escribir este archivo:
--   · Prueba textual: deshacer el envoltorio en cada expresión nueva devuelve la
--     vieja carácter por carácter (42 policies + 1, 0 fallas).
--   · Prueba en vivo (solo lectura): expresión vieja vs nueva evaluadas sobre todas
--     las filas para 34 sesiones (anon, 6 acudientes, 5 atletas, 6 dueños,
--     6 entrenadores, 4 coach de equipo, 4 dueños de escuela, admin de plataforma,
--     cuenta demo): 0 diferencias en 28 expresiones. Las que usan helpers sin
--     EXECUTE para el usuario de solo lectura quedan cubiertas por la textual.
--
-- CÓMO APLICAR
--   Una transacción por tabla, lock_timeout 800ms (< deadlock_timeout 1s, para
--   fallar con 55P03 reintentable y no con deadlock). ALTER POLICY toma
--   AccessExclusiveLock unos milisegundos: aplicar en hora valle y desde UNA sola
--   sesión. Es idempotente: si falla a mitad, se vuelve a correr completo.
--   Sin cambios de tipos: NO hace falta regenerar types.ts.
--   Después: npm run seguridad:invariantes.
-- =============================================================================

-- attendance_records: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Coaches can insert attendance for their teams" ON public.attendance_records
  TO authenticated
  WITH CHECK ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid()))
UNION
 SELECT team_coaches.team_id
   FROM team_coaches
  WHERE (team_coaches.coach_id = (SELECT auth.uid())))));
ALTER POLICY "Coaches can update attendance for their teams" ON public.attendance_records
  TO authenticated
  USING ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid()))
UNION
 SELECT team_coaches.team_id
   FROM team_coaches
  WHERE (team_coaches.coach_id = (SELECT auth.uid())))));
ALTER POLICY "Coaches can view attendance for their teams" ON public.attendance_records
  TO authenticated
  USING ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid()))
UNION
 SELECT team_coaches.team_id
   FROM team_coaches
  WHERE (team_coaches.coach_id = (SELECT auth.uid())))));
ALTER POLICY "Parents can view attendance of their children" ON public.attendance_records
  TO authenticated
  USING ((child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))));
ALTER POLICY "attendance_records_admin_all" ON public.attendance_records
  TO authenticated
  USING (is_school_admin(school_id));
COMMIT;

-- children: 7 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Children: insert parent" ON public.children
  TO authenticated
  WITH CHECK (((SELECT auth.uid()) = parent_id));
ALTER POLICY "Children: manage staff" ON public.children
  USING ((school_id = ANY ((SELECT public.staff_school_ids())::uuid[])))
  WITH CHECK ((school_id = ANY ((SELECT public.staff_school_ids())::uuid[])));
ALTER POLICY "Children: select coach via school_staff" ON public.children
  USING ((school_id = ANY ((SELECT public.coach_school_ids())::uuid[])));
ALTER POLICY "Children: select parent" ON public.children
  TO authenticated
  USING (((SELECT auth.uid()) = parent_id));
ALTER POLICY "Children: select staff" ON public.children
  USING ((school_id = ANY ((SELECT public.staff_school_ids())::uuid[])));
ALTER POLICY "Children: update parent" ON public.children
  USING (((SELECT auth.uid()) = parent_id))
  WITH CHECK (((SELECT auth.uid()) = parent_id));
ALTER POLICY "Coaches can view children in their teams" ON public.children
  USING ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid())))));
COMMIT;

-- enrollments: 9 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Coaches can view enrollments of their teams" ON public.enrollments
  TO authenticated
  USING ((team_id = ANY ((SELECT public.coach_team_ids())::uuid[])));
ALTER POLICY "Enrollments: admin delete" ON public.enrollments
  USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])));
ALTER POLICY "Enrollments: admin insert" ON public.enrollments
  WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])));
ALTER POLICY "Enrollments: admin update" ON public.enrollments
  USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
  WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])));
ALTER POLICY "Enrollments: athlete cancel own" ON public.enrollments
  TO authenticated
  USING (((user_id = (SELECT auth.uid())) AND (status = 'active'::text)))
  WITH CHECK (((user_id = (SELECT auth.uid())) AND (status = 'cancelled'::text)));
ALTER POLICY "Enrollments: parent cancel child" ON public.enrollments
  TO authenticated
  USING (((child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))) AND (status = 'active'::text)))
  WITH CHECK (((child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))) AND (status = 'cancelled'::text)));
ALTER POLICY "Enrollments: select athlete" ON public.enrollments
  TO authenticated
  USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "Enrollments: staff select" ON public.enrollments
  TO authenticated
  USING ((is_school_admin(school_id) OR is_school_coach(school_id)));
ALTER POLICY "Parents can view their children enrollments" ON public.enrollments
  TO authenticated
  USING ((child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))));
COMMIT;

-- payments: 9 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Payments: insert athlete" ON public.payments
  TO authenticated
  WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "Payments: insert parent" ON public.payments
  TO authenticated
  WITH CHECK ((parent_id = (SELECT auth.uid())));
ALTER POLICY "Payments: insert staff" ON public.payments
  TO authenticated
  WITH CHECK ((school_id = ANY ((SELECT public.staff_school_ids())::uuid[])));
ALTER POLICY "Payments: select athlete" ON public.payments
  TO authenticated
  USING ((user_id = (SELECT auth.uid())));
ALTER POLICY "Payments: select parent" ON public.payments
  TO authenticated
  USING (((parent_id = (SELECT auth.uid())) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))));
ALTER POLICY "Payments: select staff" ON public.payments
  USING ((school_id = ANY ((SELECT public.staff_school_ids())::uuid[])));
ALTER POLICY "Payments: update admin" ON public.payments
  TO authenticated
  USING (((school_id = ANY ((SELECT public.user_school_ids())::uuid[])) AND (EXISTS ( SELECT 1
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.school_id = payments.school_id) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text, 'super_admin'::text])) AND (school_members.status = 'active'::text))))));
ALTER POLICY "Payments: update athlete" ON public.payments
  TO authenticated
  USING ((user_id = (SELECT auth.uid())))
  WITH CHECK ((user_id = (SELECT auth.uid())));
ALTER POLICY "Payments: update parent" ON public.payments
  TO authenticated
  USING (((parent_id = (SELECT auth.uid())) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))))
  WITH CHECK (((parent_id = (SELECT auth.uid())) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))));
COMMIT;

-- profiles: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Profiles: select own or admin" ON public.profiles
  TO authenticated
  USING ((((SELECT auth.uid()) = id) OR (SELECT public.is_platform_admin())));
ALTER POLICY "Profiles: update own" ON public.profiles
  TO authenticated
  USING (((SELECT auth.uid()) = id));
ALTER POLICY "School members can view same-school profiles" ON public.profiles
  USING ((id = ANY ((SELECT public.school_member_profile_ids())::uuid[])));
ALTER POLICY "profiles_admin_read" ON public.profiles
  USING ((SELECT public.is_super_admin()));
COMMIT;

-- school_members: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Members: manage admin" ON public.school_members
  TO authenticated
  USING (is_school_admin(school_id))
  WITH CHECK (is_school_admin(school_id));
ALTER POLICY "Members: select school" ON public.school_members
  TO authenticated
  USING (((profile_id = (SELECT auth.uid())) OR is_school_admin(school_id)));
ALTER POLICY "school_members_admin_crud" ON public.school_members
  TO authenticated
  USING (is_school_admin(school_id));
COMMIT;

-- teams: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "Teams: coach update own" ON public.teams
  USING (((id = ANY ((SELECT public.user_coached_team_ids())::uuid[])) AND (NOT is_scoped_coach_school(school_id))))
  WITH CHECK (((id = ANY ((SELECT public.user_coached_team_ids())::uuid[])) AND (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) AND (NOT is_scoped_coach_school(school_id))));
ALTER POLICY "Teams: manage admin" ON public.teams
  USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
  WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])));
ALTER POLICY "Teams: select members" ON public.teams
  TO authenticated
  USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = (SELECT auth.uid())))));
ALTER POLICY "Teams: select staff" ON public.teams
  TO authenticated
  USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])));
COMMIT;

-- unregistered_athletes: 1 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "school_owner_manage_unregistered_athletes" ON public.unregistered_athletes
  TO authenticated
  USING (((school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = (SELECT auth.uid())))) OR (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text])))))));
COMMIT;

-- wa_comprobantes_por_clasificar: 1 policy (20261118124124 nació sin envolver)
BEGIN;
SET LOCAL lock_timeout = '800ms';
ALTER POLICY "wa_comprobantes_pc_select_admin" ON public.wa_comprobantes_por_clasificar
  USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])));
COMMIT;

-- Índices duplicados (16 kB cada uno, ninguno respalda una restricción).
-- Se queda el gemelo que sí se usa (scans al 2026-11-18 entre paréntesis).
BEGIN;
SET LOCAL lock_timeout = '800ms';
DROP INDEX IF EXISTS public.idx_event_team_members_team;   -- 0 (queda idx_team_members_team: 25)
DROP INDEX IF EXISTS public.ix_padj_payment;               -- 0 (queda idx_payment_adjustments_payment: 775)
DROP INDEX IF EXISTS public.ix_padj_school_created;        -- 4 (queda idx_payment_adjustments_school: 87)
COMMIT;
