-- =============================================================================
-- 20261027124411_cierre_policies_autoadjudicables.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: cerrar las policies "autoadjudicables" (FOR ALL / UPDATE sin
--   WITH CHECK) del plan docs/security/plan-cierre-4-policies-2026-10-27.md,
--   con las opciones recomendadas D1.1–D4.3 aprobadas, más:
--     · events: events_all_access (FOR ALL sin WITH CHECK) fuera,
--       events_update_own con WITH CHECK, y el INSERT directo del cliente exige
--       organizador verificado (o plataforma). Ver "QUEDA FUERA" abajo.
--     · biomech_captures / biomech_baselines: bc_athlete_all, bc_athlete_update,
--       bb_athlete_all separadas por comando y con WITH CHECK.
--     · get_trainer_athlete_ids(uuid): sin EXECUTE para anon ni PUBLIC.
--     · GRANTs sobrantes de anon.
--
-- Radio medido el 2026-10-27 (SELECT puntuales):
--   event_organizers 0 filas · athlete_training_plans 0 · biomech_access_grants 0
--   skill_biomech_evidence 0 · biomech_captures 45 (1 escuela, 2 atletas)
--   biomech_baselines 2 · biomech_analyses 33 · events 12 (4 escuelas, 5 creadores).
--   El BFF escribe todas estas tablas con service role (salta RLS). El frontend
--   solo LEE event_organizers y solo ESCRIBE events en un punto:
--   EventManagementPage → useEvents.updateEvent (registrations_open del propio
--   evento), que sigue pasando (USING y WITH CHECK = creador o plataforma).
--   useEvents.createEvent (INSERT directo) no lo llama ninguna pantalla.
--
-- QUEDA FUERA (rompería un flujo vivo o es decisión de producto):
--   · Guarda de `events.status` para organizadores no verificados: hay 1 evento
--     'active' público de un organizador SIN fila en event_organizers. Exigir
--     verificación en el UPDATE le quitaría el botón de abrir/cerrar
--     inscripciones (EventManagementPage). Pregunta abierta en el plan.
--   · events_select_authenticated USING(true): lo leen calendario de acudiente,
--     explorar, gestión de eventos. Pregunta abierta en el plan.
--
-- NO se tocan helpers de RLS existentes (user_*_school_ids, is_platform_admin,
-- is_school_admin_of). get_trainer_athlete_ids conserva EXECUTE para
-- authenticated: la usan 15 policies TO authenticated.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. get_trainer_athlete_ids(uuid): enumeración de atletas sin sesión
--    Ningún código (frontend/BFF/edge) la llama; solo policies. Las que la usan
--    son TO authenticated, salvo body_metrics_*_trainer ({public}); anon no lee
--    body_metrics en ningún flujo.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_trainer_athlete_ids(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_trainer_athlete_ids(uuid) FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. event_organizers  (D1.1 A · D1.2 RPC · trigger de guarda)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS organizer_manage_own_profile ON public.event_organizers;
DROP POLICY IF EXISTS event_organizers_select_own ON public.event_organizers;

CREATE POLICY event_organizers_select_own ON public.event_organizers
  FOR SELECT TO authenticated
  USING (profile_id = (select auth.uid()) OR (select public.is_platform_admin()));

-- Escritura: solo el BFF (service role). El cliente solo lee lo suyo.
REVOKE ALL ON public.event_organizers FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_organizers FROM authenticated;

-- Guarda de is_verified. SECURITY INVOKER a propósito: current_user debe ser
-- el LLAMADOR (en un DEFINER sería el dueño y dejaría pasar a todos).
-- Defensa en profundidad por si algún día se reabre escritura del cliente.
CREATE OR REPLACE FUNCTION public.guard_event_organizers_verificacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR coalesce(auth.role(), '') = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_verified := false;
  ELSIF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    RAISE EXCEPTION 'is_verified solo lo cambia la plataforma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM anon;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_event_organizers_verificacion ON public.event_organizers;
CREATE TRIGGER trg_guard_event_organizers_verificacion
  BEFORE INSERT OR UPDATE ON public.event_organizers
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_organizers_verificacion();

-- D1.2: verificar (o des-verificar) un organizador con rastro, solo plataforma.
CREATE OR REPLACE FUNCTION public.verificar_organizador(p_profile_id uuid, p_verificado boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Solo la plataforma verifica organizadores' USING ERRCODE = '42501';
  END IF;
  UPDATE public.event_organizers
     SET is_verified = coalesce(p_verificado, true),
         updated_at  = now()
   WHERE profile_id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe perfil de organizador para %', p_profile_id USING ERRCODE = 'P0002';
  END IF;
  RETURN coalesce(p_verificado, true);
END
$$;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verificar_organizador(uuid, boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. events  (D1.4 en este lote, sin romper EventManagementPage)
--    events_all_access se va: su SELECT ya lo da events_select_authenticated,
--    su UPDATE events_update_own y su DELETE events_delete_own; lo único que
--    aportaba de más era INSERT/UPDATE sin WITH CHECK.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS events_all_access ON public.events;

DROP POLICY IF EXISTS events_update_own ON public.events;
CREATE POLICY events_update_own ON public.events
  FOR UPDATE TO authenticated
  USING (creator_id = (select auth.uid()) OR (select public.is_platform_admin()))
  WITH CHECK (creator_id = (select auth.uid()) OR (select public.is_platform_admin()));

-- INSERT directo del cliente: solo organizador VERIFICADO o plataforma. La
-- escuela crea por BFF (service role) o por events_school_admin_manage.
DROP POLICY IF EXISTS events_insert_authenticated ON public.events;
CREATE POLICY events_insert_authenticated ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (
    creator_id = (select auth.uid())
    AND (
      (select public.is_platform_admin())
      OR EXISTS (
        SELECT 1 FROM public.event_organizers eo
         WHERE eo.profile_id = (select auth.uid())
           AND eo.is_verified IS TRUE
      )
    )
  );

-- anon conserva SELECT (events_public_read: mapa y página pública del evento).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.events FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helpers de alcance (nuevos)
-- ─────────────────────────────────────────────────────────────────────────────

-- ¿p_profile trabaja en p_school? Espejo de user_staff_school_ids() para otro
-- perfil (D3.2 aceptado: oráculo de pertenencia de baja sensibilidad).
CREATE OR REPLACE FUNCTION public.es_staff_de_escuela(p_profile uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_profile IS NOT NULL AND p_school IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.school_members sm
     WHERE sm.profile_id = p_profile AND sm.school_id = p_school
       AND sm.status = 'active' AND sm.role NOT IN ('parent', 'athlete', 'accountant')
    UNION ALL
    SELECT 1 FROM public.school_staff ss
     WHERE ss.coach_auth_id = p_profile AND ss.school_id = p_school AND ss.status = 'active'
    UNION ALL
    SELECT 1 FROM public.school_staff ss
      JOIN auth.users au ON lower(au.email) = lower(ss.email)
     WHERE au.id = p_profile AND ss.school_id = p_school
       AND ss.coach_auth_id IS NULL AND ss.status = 'active'
    UNION ALL
    SELECT 1 FROM public.schools s WHERE s.id = p_school AND s.owner_id = p_profile
  );
$$;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.es_staff_de_escuela(uuid, uuid) TO authenticated;

-- ¿El usuario de la sesión pertenece a p_school como miembro activo o con una
-- inscripción activa propia? (user_school_ids() no ve inscripciones).
CREATE OR REPLACE FUNCTION public.es_miembro_o_inscrito_de_escuela(p_school uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_school IS NOT NULL AND auth.uid() IS NOT NULL AND (
    p_school = ANY (public.user_school_ids())
    OR EXISTS (
      SELECT 1 FROM public.enrollments e
       WHERE e.school_id = p_school AND e.user_id = auth.uid() AND e.status = 'active'
    )
  );
$$;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) TO authenticated;

-- Captura biomecánica que el atleta registra para sí mismo: escuela suya y, si
-- trae sesión, una sesión de ESA escuela asignada a ÉL (evita alimentar
-- bc_coach_read de un entrenador ajeno con un session_plan_id arbitrario).
CREATE OR REPLACE FUNCTION public.puede_registrar_captura_biomecanica(p_school uuid, p_session_plan uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.es_miembro_o_inscrito_de_escuela(p_school)
     AND (
       p_session_plan IS NULL
       OR EXISTS (
         SELECT 1 FROM public.trainer_session_plans tsp
          WHERE tsp.id = p_session_plan
            AND tsp.school_id = p_school
            AND tsp.client_id = auth.uid()
       )
     );
$$;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. athlete_training_plans  (D2.1 policies con alcance · D2.2 sin unregistered
--    · D2.4 admin solo lee/borra)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS atp_trainer_all ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_staff_select ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_insert ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_update ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_delete ON public.athlete_training_plans;

CREATE POLICY atp_staff_select ON public.athlete_training_plans
  FOR SELECT TO authenticated
  USING (trainer_id = (select auth.uid())
         OR school_id = ANY ((select public.user_admin_school_ids())::uuid[]));

CREATE POLICY atp_trainer_insert ON public.athlete_training_plans
  FOR INSERT TO authenticated
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    AND client_id IN (SELECT public.get_trainer_athlete_ids(school_id))
  );

CREATE POLICY atp_trainer_update ON public.athlete_training_plans
  FOR UPDATE TO authenticated
  USING (trainer_id = (select auth.uid())
         AND school_id = ANY ((select public.user_staff_school_ids())::uuid[]))
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    AND client_id IN (SELECT public.get_trainer_athlete_ids(school_id))
  );

CREATE POLICY atp_trainer_delete ON public.athlete_training_plans
  FOR DELETE TO authenticated
  USING ((trainer_id = (select auth.uid())
          AND school_id = ANY ((select public.user_staff_school_ids())::uuid[]))
         OR school_id = ANY ((select public.user_admin_school_ids())::uuid[]));

REVOKE ALL ON public.athlete_training_plans FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. biomech_access_grants  (D3.1 policies con alcance · D3.2 helper)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bag_athlete_all ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_select ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_insert ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_update ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_delete ON public.biomech_access_grants;

CREATE POLICY bag_athlete_select ON public.biomech_access_grants
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bag_athlete_insert ON public.biomech_access_grants
  FOR INSERT TO authenticated
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.es_miembro_o_inscrito_de_escuela(school_id)
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

-- El atleta activa/desactiva/cambia vencimiento de SUS grants, pero no puede
-- re-apuntarlos a alguien fuera de alcance.
CREATE POLICY bag_athlete_update ON public.biomech_access_grants
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.es_miembro_o_inscrito_de_escuela(school_id)
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

CREATE POLICY bag_athlete_delete ON public.biomech_access_grants
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE ALL ON public.biomech_access_grants FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Lectores del coach (D3.4): un grant solo abre datos mientras el coach
--    siga trabajando en la escuela del grant. La rama de sesión
--    (trainer_session_plans) queda igual.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bc_coach_read ON public.biomech_captures;
CREATE POLICY bc_coach_read ON public.biomech_captures
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.trainer_session_plans tsp
       WHERE tsp.id = biomech_captures.session_plan_id
         AND tsp.trainer_id = (select auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.biomech_access_grants bag
       WHERE bag.athlete_id = biomech_captures.athlete_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

DROP POLICY IF EXISTS ba_coach_read ON public.biomech_analyses;
CREATE POLICY ba_coach_read ON public.biomech_analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.biomech_captures bc
        JOIN public.trainer_session_plans tsp ON tsp.id = bc.session_plan_id
       WHERE bc.id = biomech_analyses.capture_id
         AND tsp.trainer_id = (select auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.biomech_captures bc
        JOIN public.biomech_access_grants bag ON bag.athlete_id = bc.athlete_id
       WHERE bc.id = biomech_analyses.capture_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

DROP POLICY IF EXISTS bb_coach_read ON public.biomech_baselines;
CREATE POLICY bb_coach_read ON public.biomech_baselines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.biomech_access_grants bag
       WHERE bag.athlete_id = biomech_baselines.athlete_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. biomech_captures del atleta: bc_athlete_all + bc_athlete_update sin
--    WITH CHECK → una policy por comando, con la relación correcta.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bc_athlete_all ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_update ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_select ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_insert ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_delete ON public.biomech_captures;

CREATE POLICY bc_athlete_select ON public.biomech_captures
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bc_athlete_insert ON public.biomech_captures
  FOR INSERT TO authenticated
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id)
  );

CREATE POLICY bc_athlete_update ON public.biomech_captures
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id)
  );

CREATE POLICY bc_athlete_delete ON public.biomech_captures
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.biomech_captures FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. biomech_baselines del atleta: bb_athlete_all sin WITH CHECK → por comando.
--    La línea base es del atleta: no puede moverla a otro perfil.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bb_athlete_all ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_select ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_insert ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_update ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_delete ON public.biomech_baselines;

CREATE POLICY bb_athlete_select ON public.biomech_baselines
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_insert ON public.biomech_baselines
  FOR INSERT TO authenticated
  WITH CHECK (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_update ON public.biomech_baselines
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_delete ON public.biomech_baselines
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.biomech_baselines FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. skill_biomech_evidence  (D4.1 A: el cliente no escribe; solo el BFF)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sbe_adder_all ON public.skill_biomech_evidence;
DROP POLICY IF EXISTS sbe_adder_select ON public.skill_biomech_evidence;

CREATE POLICY sbe_adder_select ON public.skill_biomech_evidence
  FOR SELECT TO authenticated
  USING (added_by = (select auth.uid()));

-- sbe_athlete_read se queda tal cual.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.skill_biomech_evidence FROM authenticated;
REVOKE ALL ON public.skill_biomech_evidence FROM anon;

COMMIT;
