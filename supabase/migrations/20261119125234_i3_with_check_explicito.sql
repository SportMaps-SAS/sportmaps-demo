-- =============================================================================
-- 20261119125234_i3_with_check_explicito.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119125220
-- Objetivo: bajar el invariante I3 («FOR ALL sin WITH CHECK: el USING valida los
--   INSERT») de 27 a 2, y cerrar tres hallazgos reales de la auditoría.
--   Ref: docs/auditoria-i3-i6-2026-11-18.md y docs/borradores/i3-with-check-2026-11-18.sql.borrador.
--   Todas las definiciones se releyeron de pg_policies VIVO el 2026-11-19 (las 27
--   seguían con with_check NULL; 15 no están en ninguna migración del repo).
--   Solo se escribe WITH CHECK (y USING donde se dice): NO se tocan los roles.
--
-- QUÉ HACE
--   A. 21 policies con CHECK = USING (comportamiento idéntico; solo lo explicita):
--      academic_progress_admin_all, activities_access, attendance_admin_all,
--      attendance_records_admin_all, «Admins can manage all sessions»,
--      «Attendance sessions: manage staff», class_enrollments_manage_admin,
--      classes_admin_all, coach_profiles_admin_all, coach_profiles_self_all,
--      «platform admins manage demo links», categories_organizer_manage,
--      price_phases_organizer_manage, coaches_school_manage, mp_shipping_rates_owner,
--      «School manages own templates», sa_school_manage, school_members_admin_crud,
--      «Staff: manage admin», training_sessions_admin_all,
--      school_owner_manage_unregistered_athletes.
--      Las expresiones van ENVUELTAS ((SELECT auth.uid()), = ANY ((SELECT f())::uuid[]),
--      (SELECT is_platform_admin())) por el gate de rendimiento de migrations:check
--      (desde 20261118163548); envolver no cambia lo que la policy permite.
--   B. Caja (cash_sessions, cash_session_entries): USING y CHECK exigen
--      school_members.status = 'active' (hoy un owner/admin dado de baja conserva
--      escritura). En entries el CHECK además exige que session_id sea una sesión
--      de la MISMA escuela. (El «status» de cash_sessions es open/closed/reconciled;
--      el 'active' es el de la membresía.)
--   C. children_stats.trainer_manage_children_stats (RIESGO REAL, auditoría A):
--      hoy basta tener un trainer_session_plans propio con client_id = child_id, y
--      trainer_session_plans_owner_all deja a CUALQUIER autenticado insertar un plan
--      con client_id de cualquier niño. Ahora el plan debe estar en la MISMA escuela
--      de la fila de stats (tsp.school_id = children_stats.school_id) y quien escribe
--      debe ser staff activo de esa escuela (user_staff_school_ids(), que incluye al
--      dueño de la escuela, o sea al entrenador personal), y el niño debe ser
--      CLIENTE POR INSCRIPCIÓN de esa escuela (existe enrollments.child_id =
--      client_id con enrollments.school_id = la escuela del plan). Se aplica a
--      USING y CHECK: también cierra la LECTURA cruzada. NO se valida contra
--      children.school_id: los 8 planes y las 3 stats «cross-tenant» son LEGÍTIMOS
--      (entrenadores personales con su escuela PT; el niño está inscrito en dos
--      escuelas PT) y esa regla los rompería. Forjar un plan ya no basta: hace falta
--      además una inscripción real del niño en esa escuela.
--      El SELECT de acudientes (parent_read_children_stats) no se toca.
--   D. event_delegations.delegation_school_manage (RIESGO REAL, auditoría C): el
--      CHECK fija que la escuela solo escribe SU delegación (membresía admin activa)
--      y solo en estado draft/submitted, sin confirmed_at ni total_paid. Confirmar,
--      rechazar y registrar pagos es del organizador/BFF (delegation_host_manage,
--      delegation_organizer_update, service_role), que no se tocan.
--
-- EXCLUIDAS A PROPÓSITO (I3 queda en 2): event_delegation_payments
--   .del_payments_school_manage y .del_payments_organizer_manage. Cerrarlas pide
--   DECISIÓN DE PRODUCTO (auditoría B): el CHECK propuesto (status='pending', sin
--   revisor, delegación-evento-escuela coherentes) también limita los UPDATE del
--   FOR ALL y hay que decidir si se separa la policy por comando o se pone un
--   trigger; y la del organizador puede poner cualquier school_id dentro de su
--   evento. Hoy 0 filas incoherentes y 0 pagos: radio actual 0, pero NO es
--   cosmético. PENDIENTE: no se tocan en esta migración.
-- PENDIENTE (segunda pasada, producto): trainer_session_plans_owner_all debe validar
--   client_id contra la escuela y school_id ∈ user_staff_school_ids(); hoy quien sea
--   staff de la escuela X puede forjar un plan con client_id ajeno y escribir stats
--   con school_id = X sobre ese niño (solo filas de X; las de otras escuelas ya no
--   se leen). Hay 8 planes con client_id de niño de otra escuela (client_type
--   'child') por revisar con producto.
-- NO incluido (opcional del borrador): integridad extra de attendance_records
--   (child_id de la misma escuela; 1 fila viva incoherente) y class_enrollments
--   (inscripción de la misma escuela): aquí solo CHECK = USING.
--
-- RADIO DE IMPACTO (medido 2026-11-19, solo lectura)
--   · A: cero cambio de comportamiento (el USING ya validaba los INSERT/UPDATE).
--   · B: cash_sessions 0 filas, cash_session_entries 0 filas; 2 owners/admin con
--     membresía 'inactive' pierden escritura de caja (correcto). school_members.status
--     solo toma 'active'/'inactive'.
--   · C: 3 filas en children_stats (todas de entrenadores personales, plan del dueño
--     en la misma escuela, niño inscrito allí): las 3 conservan acceso (medido con
--     el predicado nuevo). Los 9 planes client_type='child' tienen inscripción en
--     la escuela del plan (incluidos los 8 «cross-tenant»): ninguno se rompe.
--     attendance_records: 1 fila con child de otra escuela; no se endurece aquí
--     (solo CHECK = USING) y además tiene inscripción en su escuela (0 sin ella).
--     0 filas con school_id NULL. Ojo: el EXISTS sobre enrollments corre con RLS del
--     llamante (policy «Enrollments: staff select» = is_school_admin OR
--     is_school_coach); el dueño de la stats viva tiene membresía owner/admin
--     activa, pero 1 de 13 escuelas personal_trainer tiene dueño SIN membresía
--     admin activa: si algún día escribe stats por JWT, quedaría denegado (falla
--     cerrada; hoy no tiene stats y el BFF usa service_role).
--   · D: 1 delegación (confirmed): la escuela deja de poder modificarla por JWT
--     (correcto; el BFF usa service_role). Ni frontend ni bff escriben estas tablas
--     con un cliente authenticated: el frontend no tiene .from() sobre ellas
--     (children_stats se lee por la RPC get_child_exercise_stats) y el cliente
--     `supabase` del BFF es service_role (bff/src/config/supabase.ts). No hay
--     createClient con JWT de usuario en events.route, organizers.route,
--     trainer/clients ni school-delegations.route.
--
-- ROLLBACK
--   A: no hace falta (comportamiento idéntico). Para quitar un CHECK:
--      DROP POLICY + CREATE POLICY con el USING original (ALTER no permite NULL).
--   B (originales; roles {public}, FOR ALL, sin CHECK):
--      DROP POLICY "owner and admin can manage cash sessions" ON public.cash_sessions;
--      CREATE POLICY "owner and admin can manage cash sessions" ON public.cash_sessions FOR ALL
--        USING (school_id IN (SELECT school_members.school_id FROM school_members
--          WHERE school_members.profile_id = auth.uid() AND school_members.role = ANY (ARRAY['owner','admin'])));
--      (igual para "owner and admin can manage cash entries" ON public.cash_session_entries)
--   C: DROP POLICY trainer_manage_children_stats ON public.children_stats;
--      CREATE POLICY trainer_manage_children_stats ON public.children_stats FOR ALL TO authenticated
--        USING (EXISTS (SELECT 1 FROM trainer_session_plans tsp
--                        WHERE tsp.client_id = children_stats.child_id AND tsp.trainer_id = auth.uid()));
--   D: DROP POLICY delegation_school_manage ON public.event_delegations;
--      CREATE POLICY delegation_school_manage ON public.event_delegations FOR ALL
--        USING (school_id IN (SELECT school_members.school_id FROM school_members
--          WHERE school_members.profile_id = auth.uid()
--            AND school_members.role = ANY (ARRAY['owner','admin','school_admin'])
--            AND school_members.status = 'active'));
--
-- DESPUÉS DE APLICAR (una sola sesión aplicando; sin types.ts: no cambia esquema)
--   1. npm run seguridad:invariantes → I3 = 2 (las dos de event_delegation_payments).
--   2. Simulación de sesiones (cada bloque con rollback; reemplazar uuids):
--      begin;  -- C1: usuario ajeno no escribe stats de un niño ajeno
--        set local role authenticated;
--        select set_config('request.jwt.claims', json_build_object('sub','<uuid_usuario_ajeno>')::text, true);
--        insert into public.children_stats(child_id, school_id, stat_type, value, unit, stat_date)
--          values ('<child_id_victima>', '<escuela_donde_NO_es_staff>', 'x', 1, 'kg', current_date);  -- ESPERADO 42501
--        select count(*) from public.children_stats where child_id = '<child_id_victima>';           -- ESPERADO 0
--      rollback;
--      begin;  -- C2: el entrenador personal conserva su flujo (regresión)
--        set local role authenticated;
--        select set_config('request.jwt.claims', json_build_object('sub','<uuid_dueno_escuela_personal_trainer>')::text, true);
--        select count(*) from public.children_stats where school_id = '<su_escuela>';  -- ESPERADO: igual que antes (las 3 filas viven son de entrenadores personales)
--      rollback;
--      begin;  -- D: admin de escuela A no se autoconfirma
--        set local role authenticated;
--        select set_config('request.jwt.claims', json_build_object('sub','<uuid_admin_escuela_A>')::text, true);
--        select public.user_admin_school_ids(), public.user_staff_school_ids();
--        insert into public.event_delegations(event_id, school_id, status, total_paid)
--          values ('<evento>', '<escuela_A>', 'confirmed', 1000);   -- ESPERADO 42501
--        insert into public.event_delegations(event_id, school_id, status)
--          values ('<evento_abierto>', '<escuela_A>', 'draft');     -- ESPERADO OK
--      rollback;
--      begin;  -- B: owner dado de baja no escribe caja
--        set local role authenticated;
--        select set_config('request.jwt.claims', json_build_object('sub','<uuid_owner_inactive>')::text, true);
--        insert into public.cash_sessions(school_id, opened_by, status, opening_cash)
--          values ('<su_escuela>', '<uuid_owner_inactive>', 'open', 0);   -- ESPERADO 42501
--      rollback;
--      begin;  -- A: regresión de un admin activo (mismos conteos que antes)
--        set local role authenticated;
--        select set_config('request.jwt.claims', json_build_object('sub','<uuid_admin_activo>')::text, true);
--        select count(*) from public.classes; select count(*) from public.attendance_sessions;
--      rollback;
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra.
--   · RLS sin self-recursion; las policies son PERMISIVAS y se suman con OR: este
--     CHECK no restringe lo que otras policies permisivas de la misma tabla dejan
--     pasar (p. ej. delegation_host_manage, «Members: manage admin»).
--   · ALTER POLICY no admite IF EXISTS: si una policy no existe falla TODA la
--     migración (transaccional; es lo deseado).
-- =============================================================================

-- ─── A. CHECK = USING (comportamiento idéntico) ─────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '800ms';

ALTER POLICY academic_progress_admin_all ON public.academic_progress
  WITH CHECK (EXISTS (SELECT 1 FROM public.children
                       WHERE children.id = academic_progress.child_id
                         AND public.is_school_admin(children.school_id)));

ALTER POLICY activities_access ON public.activities
  WITH CHECK ((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin()));

ALTER POLICY attendance_admin_all ON public.attendance
  WITH CHECK (EXISTS (SELECT 1 FROM public.children
                       WHERE children.id = attendance.child_id
                         AND public.is_school_admin(children.school_id)));

ALTER POLICY attendance_records_admin_all ON public.attendance_records
  WITH CHECK (public.is_school_admin(school_id));

ALTER POLICY "Admins can manage all sessions" ON public.attendance_sessions
  WITH CHECK (public.is_school_admin(school_id));

ALTER POLICY "Attendance sessions: manage staff" ON public.attendance_sessions
  WITH CHECK (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

ALTER POLICY class_enrollments_manage_admin ON public.class_enrollments
  WITH CHECK (EXISTS (SELECT 1 FROM public.classes c
                       WHERE c.id = class_enrollments.class_id
                         AND public.is_school_admin(c.school_id)));

ALTER POLICY classes_admin_all ON public.classes
  WITH CHECK (public.is_school_admin(school_id));

ALTER POLICY coach_profiles_admin_all ON public.coach_profiles
  WITH CHECK ((SELECT public.is_platform_admin()));

ALTER POLICY coach_profiles_self_all ON public.coach_profiles
  WITH CHECK (id = (SELECT auth.uid()));

ALTER POLICY "platform admins manage demo links" ON public.demo_links
  WITH CHECK (EXISTS (SELECT 1 FROM public.platform_admins
                       WHERE platform_admins.profile_id = (SELECT auth.uid())));

ALTER POLICY categories_organizer_manage ON public.event_categories_config
  WITH CHECK (event_id IN (SELECT events.id FROM public.events
                            WHERE events.creator_id = (SELECT auth.uid())));

ALTER POLICY price_phases_organizer_manage ON public.event_price_phases
  WITH CHECK (event_id IN (SELECT events.id FROM public.events
                            WHERE events.creator_id = (SELECT auth.uid())));

ALTER POLICY coaches_school_manage ON public.event_team_coaches
  WITH CHECK (delegation_id IN (
    SELECT d.id
      FROM public.event_delegations d
      JOIN public.school_members sm ON sm.school_id = d.school_id
     WHERE sm.profile_id = (SELECT auth.uid())
       AND sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])
       AND sm.status = 'active'::text));

ALTER POLICY mp_shipping_rates_owner ON public.marketplace_shipping_rates
  WITH CHECK (vendor_profile_id IN (SELECT vendor_profiles.id FROM public.vendor_profiles
                                     WHERE vendor_profiles.user_id = (SELECT auth.uid())));

ALTER POLICY "School manages own templates" ON public.payment_message_templates
  WITH CHECK (school_id IN (
    SELECT school_members.school_id FROM public.school_members
     WHERE school_members.profile_id = (SELECT auth.uid())
       AND school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text, 'super_admin'::text])
       AND school_members.status = 'active'::text));

ALTER POLICY sa_school_manage ON public.school_availability
  WITH CHECK (EXISTS (SELECT 1 FROM public.school_members sm
                       WHERE sm.school_id = school_availability.school_id
                         AND sm.profile_id = (SELECT auth.uid())
                         AND sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])
                         AND sm.status = 'active'::text));

-- Duplicada con «Members: manage admin» (que ya tiene este CHECK). Se explicita igual.
-- Pendiente de producto (no es I3): un admin puede otorgar role owner/admin.
ALTER POLICY school_members_admin_crud ON public.school_members
  WITH CHECK (public.is_school_admin(school_id));

ALTER POLICY "Staff: manage admin" ON public.school_staff
  WITH CHECK (public.is_school_admin(school_id));

ALTER POLICY training_sessions_admin_all ON public.training_slots
  WITH CHECK (EXISTS (SELECT 1 FROM public.teams
                       WHERE teams.id = training_slots.team_id
                         AND public.is_school_admin(teams.school_id)));

ALTER POLICY school_owner_manage_unregistered_athletes ON public.unregistered_athletes
  WITH CHECK (
    school_id IN (SELECT schools.id FROM public.schools
                   WHERE schools.owner_id = (SELECT auth.uid()))
    OR school_id IN (SELECT school_members.school_id FROM public.school_members
                      WHERE school_members.profile_id = (SELECT auth.uid())
                        AND school_members.status = 'active'::text
                        AND school_members.role = ANY (ARRAY['admin'::text, 'coach'::text, 'staff'::text])));

COMMIT;

-- ─── B. Caja: membresía ACTIVA (USING y CHECK) ──────────────────────────────
BEGIN;
SET LOCAL lock_timeout = '800ms';

ALTER POLICY "owner and admin can manage cash sessions" ON public.cash_sessions
  USING (school_id IN (SELECT m.school_id FROM public.school_members m
                        WHERE m.profile_id = (SELECT auth.uid())
                          AND m.status = 'active'::text
                          AND m.role = ANY (ARRAY['owner'::text, 'admin'::text])))
  WITH CHECK (school_id IN (SELECT m.school_id FROM public.school_members m
                             WHERE m.profile_id = (SELECT auth.uid())
                               AND m.status = 'active'::text
                               AND m.role = ANY (ARRAY['owner'::text, 'admin'::text])));

ALTER POLICY "owner and admin can manage cash entries" ON public.cash_session_entries
  USING (school_id IN (SELECT m.school_id FROM public.school_members m
                        WHERE m.profile_id = (SELECT auth.uid())
                          AND m.status = 'active'::text
                          AND m.role = ANY (ARRAY['owner'::text, 'admin'::text])))
  WITH CHECK (
    school_id IN (SELECT m.school_id FROM public.school_members m
                   WHERE m.profile_id = (SELECT auth.uid())
                     AND m.status = 'active'::text
                     AND m.role = ANY (ARRAY['owner'::text, 'admin'::text]))
    AND EXISTS (SELECT 1 FROM public.cash_sessions s
                 WHERE s.id = cash_session_entries.session_id
                   AND s.school_id = cash_session_entries.school_id));

COMMIT;

-- ─── C. children_stats: plan en la escuela de la fila + staff + cliente por inscripción ─
BEGIN;
SET LOCAL lock_timeout = '800ms';

ALTER POLICY trainer_manage_children_stats ON public.children_stats
  USING (EXISTS (SELECT 1 FROM public.trainer_session_plans tsp
                  WHERE tsp.client_id = children_stats.child_id
                    AND tsp.trainer_id = (SELECT auth.uid())
                    AND tsp.school_id = children_stats.school_id
                    AND tsp.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
                    AND EXISTS (SELECT 1 FROM public.enrollments e
                                 WHERE e.child_id = tsp.client_id
                                   AND e.school_id = tsp.school_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.trainer_session_plans tsp
                       WHERE tsp.client_id = children_stats.child_id
                         AND tsp.trainer_id = (SELECT auth.uid())
                         AND tsp.school_id = children_stats.school_id
                         AND tsp.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
                         AND EXISTS (SELECT 1 FROM public.enrollments e
                                      WHERE e.child_id = tsp.client_id
                                        AND e.school_id = tsp.school_id)));

COMMIT;

-- ─── D. event_delegations: la escuela solo inscribe SU delegación, sin confirmar ─
BEGIN;
SET LOCAL lock_timeout = '800ms';

ALTER POLICY delegation_school_manage ON public.event_delegations
  WITH CHECK (
    school_id IN (SELECT school_members.school_id FROM public.school_members
                   WHERE school_members.profile_id = (SELECT auth.uid())
                     AND school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])
                     AND school_members.status = 'active'::text)
    AND status = ANY (ARRAY['draft'::text, 'submitted'::text])
    AND confirmed_at IS NULL
    AND COALESCE(total_paid, 0) = 0);

COMMIT;
