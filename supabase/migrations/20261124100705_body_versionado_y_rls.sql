-- =============================================================================
-- 20261124100705_body_versionado_y_rls.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-24   Versión anterior: 20261123155851
-- Objetivo: BOD-0 (docs/specs/body-biblioteca-tecnicas-y-rendimiento.md §7.1).
--   (a) VERSIONAR las 8 tablas de Body (biomech_*, skill_biomech_evidence,
--       exercise_analyzers, exercise_analyzer_mappings) y sus 3 funciones de
--       ayuda, que existen en la base pero nunca tuvieron CREATE TABLE en el repo.
--       Es idempotente: en la base viva todo es no-op (IF NOT EXISTS / OR REPLACE,
--       definiciones copiadas de pg_catalog el 2026-11-24). En una base nueva
--       reconstruye lo mismo.
--   (b) CORREGIR, sin tocar datos, los hallazgos 1, 2, 3 y 5 de §7.1:
--       1. ban_coach_insert/update dejaban a CUALQUIER autenticado anotar cualquier
--          captura: ahora exigen que la captura sea de su plan de sesión o de un
--          atleta con permiso vigente en una escuela donde es staff (mismo criterio
--          que bc_coach_read).
--       2. REVOKE ALL a anon en las 8 tablas (no hay flujo público en Body).
--       3. Policies con auth.uid() sin envolver y roles {public}: recreadas con
--          (SELECT auth.uid()) y TO authenticated.
--       5. Catálogos de analizadores: lectura TO authenticated (antes {public}).
--   NO resuelve el hallazgo 4 (aislamiento indirecto por school_id): depende de
--   D-BOD-4 (qué pasa con el historial si el atleta cambia de escuela).
-- Antes de aplicar: una sola sesión; pedir turno a sportmaps-demo-f0 y avisar al
--   terminar. Después, npm run seguridad:invariantes.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Funciones de ayuda (idénticas a la base viva). Las usan las policies de
--    biomech_access_grants y biomech_captures, así que van ANTES de las tablas.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.es_miembro_o_inscrito_de_escuela(p_school uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_school IS NOT NULL AND auth.uid() IS NOT NULL AND (
    p_school = ANY (public.user_school_ids())
    OR EXISTS (
      SELECT 1 FROM public.enrollments e
       WHERE e.school_id = p_school AND e.user_id = auth.uid() AND e.status = 'active'
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.es_staff_de_escuela(p_profile uuid, p_school uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT p_profile IS NOT NULL AND p_school IS NOT NULL
    AND (
      coalesce(auth.role(), '') = 'service_role'
      OR public.es_miembro_o_inscrito_de_escuela(p_school)
      OR public.is_platform_admin()
    )
    AND EXISTS (
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
$function$;

CREATE OR REPLACE FUNCTION public.puede_registrar_captura_biomecanica(p_school uuid, p_session_plan uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
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
$function$;

-- Helpers usados dentro de policies: authenticated los necesita (sin esto, 42501).
-- No se toca el ACL de anon: ya no hay policies de Body que lo alcancen.
GRANT EXECUTE ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.es_staff_de_escuela(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tablas (en orden de dependencia). Definición = base viva a 2026-11-24.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exercise_analyzers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL,
  name         text NOT NULL,
  description  text,
  key_landmarks text[],
  metrics      jsonb DEFAULT '[]'::jsonb,
  thresholds   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  CONSTRAINT exercise_analyzers_code_key UNIQUE (code)
);

CREATE TABLE IF NOT EXISTS public.exercise_analyzer_mappings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analyzer_code text NOT NULL REFERENCES public.exercise_analyzers(code),
  wger_id       integer,
  name_pattern  text NOT NULL,
  created_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eam_wger_id
  ON public.exercise_analyzer_mappings USING btree (wger_id) WHERE (wger_id IS NOT NULL);

CREATE TABLE IF NOT EXISTS public.biomech_captures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  session_plan_id  uuid REFERENCES public.trainer_session_plans(id) ON DELETE SET NULL,
  enrollment_id    uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  analyzer_code    text REFERENCES public.exercise_analyzers(code),
  block_index      integer,
  video_path       text,
  keypoints        jsonb,
  fps              numeric,
  duration_seconds numeric,
  quality_score    numeric,
  source           text NOT NULL DEFAULT 'session',
  status           text NOT NULL DEFAULT 'pending',
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  CONSTRAINT biomech_captures_source_check CHECK (source = ANY (ARRAY['session'::text, 'voluntary'::text])),
  CONSTRAINT biomech_captures_status_check CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))
);
CREATE INDEX IF NOT EXISTS idx_biomech_captures_athlete ON public.biomech_captures USING btree (athlete_id);
CREATE INDEX IF NOT EXISTS idx_biomech_captures_session ON public.biomech_captures USING btree (session_plan_id);
CREATE INDEX IF NOT EXISTS idx_biomech_captures_status  ON public.biomech_captures USING btree (status);

CREATE TABLE IF NOT EXISTS public.biomech_analyses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id           uuid NOT NULL REFERENCES public.biomech_captures(id) ON DELETE CASCADE,
  analyzer_code        text REFERENCES public.exercise_analyzers(code),
  rep_count            integer,
  metrics              jsonb DEFAULT '{}'::jsonb,
  flags                jsonb DEFAULT '[]'::jsonb,
  summary              text,
  quality_rating       text,
  suggested_correctives jsonb DEFAULT '[]'::jsonb,
  processed_at         timestamptz,
  created_at           timestamptz DEFAULT now(),
  CONSTRAINT biomech_analyses_quality_rating_check CHECK (quality_rating = ANY (ARRAY['good'::text, 'acceptable'::text, 'poor'::text]))
);
CREATE INDEX IF NOT EXISTS idx_biomech_analyses_capture ON public.biomech_analyses USING btree (capture_id);

CREATE TABLE IF NOT EXISTS public.biomech_baselines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  joint_rom             jsonb DEFAULT '{}'::jsonb,
  compensation_patterns jsonb DEFAULT '[]'::jsonb,
  assessment_count      integer NOT NULL DEFAULT 0,
  last_updated_at       timestamptz DEFAULT now(),
  created_at            timestamptz DEFAULT now(),
  CONSTRAINT biomech_baselines_athlete_id_key UNIQUE (athlete_id)
);

CREATE TABLE IF NOT EXISTS public.biomech_annotations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id        uuid NOT NULL REFERENCES public.biomech_captures(id) ON DELETE CASCADE,
  coach_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  timestamp_seconds numeric,
  note              text NOT NULL,
  label             text,
  is_baseline_label boolean DEFAULT false,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_biomech_annotations_capture ON public.biomech_annotations USING btree (capture_id);

CREATE TABLE IF NOT EXISTS public.biomech_access_grants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  coach_id   uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  is_active  boolean NOT NULL DEFAULT true,
  granted_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT biomech_access_grants_athlete_id_coach_id_school_id_key UNIQUE (athlete_id, coach_id, school_id)
);
CREATE INDEX IF NOT EXISTS idx_biomech_grants_athlete ON public.biomech_access_grants USING btree (athlete_id);
CREATE INDEX IF NOT EXISTS idx_biomech_grants_coach   ON public.biomech_access_grants USING btree (coach_id);

CREATE TABLE IF NOT EXISTS public.skill_biomech_evidence (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academic_progress_id uuid NOT NULL REFERENCES public.academic_progress(id) ON DELETE CASCADE,
  capture_id           uuid NOT NULL REFERENCES public.biomech_captures(id) ON DELETE CASCADE,
  added_by             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at           timestamptz DEFAULT now(),
  CONSTRAINT skill_biomech_evidence_academic_progress_id_capture_id_key UNIQUE (academic_progress_id, capture_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_evidence_progress ON public.skill_biomech_evidence USING btree (academic_progress_id);

ALTER TABLE public.exercise_analyzers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exercise_analyzer_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomech_captures           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomech_analyses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomech_baselines          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomech_annotations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biomech_access_grants      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_biomech_evidence     ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Hallazgo 2: anon no tiene nada que hacer en Body (no hay pantalla pública).
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE
  public.exercise_analyzers, public.exercise_analyzer_mappings,
  public.biomech_captures, public.biomech_analyses, public.biomech_baselines,
  public.biomech_annotations, public.biomech_access_grants, public.skill_biomech_evidence
FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Policies. Las que ya estaban bien se recrean idénticas (DROP IF EXISTS +
--    CREATE) para que el repo las contenga; las de los hallazgos 1, 3 y 5 cambian.
--    Las policies son PERMISIVAS y se suman con OR: se recrean TODAS las de cada
--    tabla, no solo las que cambian, para no dejar una vieja abierta.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── biomech_captures (sin cambios de lógica) ────────────────────────────────
DROP POLICY IF EXISTS bc_athlete_select ON public.biomech_captures;
CREATE POLICY bc_athlete_select ON public.biomech_captures FOR SELECT TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bc_athlete_insert ON public.biomech_captures;
CREATE POLICY bc_athlete_insert ON public.biomech_captures FOR INSERT TO authenticated
  WITH CHECK (athlete_id = (SELECT auth.uid()) AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id));

DROP POLICY IF EXISTS bc_athlete_update ON public.biomech_captures;
CREATE POLICY bc_athlete_update ON public.biomech_captures FOR UPDATE TO authenticated
  USING (athlete_id = (SELECT auth.uid()))
  WITH CHECK (athlete_id = (SELECT auth.uid()) AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id));

DROP POLICY IF EXISTS bc_athlete_delete ON public.biomech_captures;
CREATE POLICY bc_athlete_delete ON public.biomech_captures FOR DELETE TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bc_coach_read ON public.biomech_captures;
CREATE POLICY bc_coach_read ON public.biomech_captures FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.trainer_session_plans tsp
             WHERE tsp.id = biomech_captures.session_plan_id AND tsp.trainer_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.biomech_access_grants bag
                WHERE bag.athlete_id = biomech_captures.athlete_id
                  AND bag.coach_id = (SELECT auth.uid())
                  AND bag.is_active = true
                  AND (bag.expires_at IS NULL OR bag.expires_at > now())
                  AND bag.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))
  );

-- ── biomech_analyses (hallazgo 3: ba_athlete_* pasan a authenticated + envuelto) ─
DROP POLICY IF EXISTS ba_athlete_read ON public.biomech_analyses;
CREATE POLICY ba_athlete_read ON public.biomech_analyses FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.biomech_captures bc
                  WHERE bc.id = biomech_analyses.capture_id AND bc.athlete_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS ba_athlete_insert ON public.biomech_analyses;
CREATE POLICY ba_athlete_insert ON public.biomech_analyses FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.biomech_captures bc
                       WHERE bc.id = biomech_analyses.capture_id AND bc.athlete_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS ba_coach_read ON public.biomech_analyses;
CREATE POLICY ba_coach_read ON public.biomech_analyses FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.biomech_captures bc
              JOIN public.trainer_session_plans tsp ON tsp.id = bc.session_plan_id
             WHERE bc.id = biomech_analyses.capture_id AND tsp.trainer_id = (SELECT auth.uid()))
    OR EXISTS (SELECT 1 FROM public.biomech_captures bc
                 JOIN public.biomech_access_grants bag ON bag.athlete_id = bc.athlete_id
                WHERE bc.id = biomech_analyses.capture_id
                  AND bag.coach_id = (SELECT auth.uid())
                  AND bag.is_active = true
                  AND (bag.expires_at IS NULL OR bag.expires_at > now())
                  AND bag.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))
  );

-- ── biomech_baselines (sin cambios de lógica) ───────────────────────────────
DROP POLICY IF EXISTS bb_athlete_select ON public.biomech_baselines;
CREATE POLICY bb_athlete_select ON public.biomech_baselines FOR SELECT TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bb_athlete_insert ON public.biomech_baselines;
CREATE POLICY bb_athlete_insert ON public.biomech_baselines FOR INSERT TO authenticated
  WITH CHECK (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bb_athlete_update ON public.biomech_baselines;
CREATE POLICY bb_athlete_update ON public.biomech_baselines FOR UPDATE TO authenticated
  USING (athlete_id = (SELECT auth.uid()))
  WITH CHECK (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bb_athlete_delete ON public.biomech_baselines;
CREATE POLICY bb_athlete_delete ON public.biomech_baselines FOR DELETE TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bb_coach_read ON public.biomech_baselines;
CREATE POLICY bb_coach_read ON public.biomech_baselines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.biomech_access_grants bag
                  WHERE bag.athlete_id = biomech_baselines.athlete_id
                    AND bag.coach_id = (SELECT auth.uid())
                    AND bag.is_active = true
                    AND (bag.expires_at IS NULL OR bag.expires_at > now())
                    AND bag.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])));

-- ── biomech_access_grants (hallazgo 3: bag_coach_read a authenticated + envuelto) ─
DROP POLICY IF EXISTS bag_athlete_select ON public.biomech_access_grants;
CREATE POLICY bag_athlete_select ON public.biomech_access_grants FOR SELECT TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bag_athlete_insert ON public.biomech_access_grants;
CREATE POLICY bag_athlete_insert ON public.biomech_access_grants FOR INSERT TO authenticated
  WITH CHECK (athlete_id = (SELECT auth.uid())
              AND public.es_miembro_o_inscrito_de_escuela(school_id)
              AND public.es_staff_de_escuela(coach_id, school_id));

DROP POLICY IF EXISTS bag_athlete_update ON public.biomech_access_grants;
CREATE POLICY bag_athlete_update ON public.biomech_access_grants FOR UPDATE TO authenticated
  USING (athlete_id = (SELECT auth.uid()))
  WITH CHECK (athlete_id = (SELECT auth.uid())
              AND public.es_miembro_o_inscrito_de_escuela(school_id)
              AND public.es_staff_de_escuela(coach_id, school_id));

DROP POLICY IF EXISTS bag_athlete_delete ON public.biomech_access_grants;
CREATE POLICY bag_athlete_delete ON public.biomech_access_grants FOR DELETE TO authenticated
  USING (athlete_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS bag_coach_read ON public.biomech_access_grants;
CREATE POLICY bag_coach_read ON public.biomech_access_grants FOR SELECT TO authenticated
  USING (coach_id = (SELECT auth.uid()));

-- ── biomech_annotations (hallazgos 1 y 3) ───────────────────────────────────
-- Predicado de alcance: la captura es de un plan de sesión del propio entrenador
-- o de un atleta con permiso vigente en una escuela donde es staff. Es el mismo
-- criterio de bc_coach_read, escrito explícito para no depender del RLS de la
-- subconsulta. Va en INSERT y en UPDATE (con WITH CHECK) para que cambiar
-- capture_id de una anotación propia no sea una vía de escape.
DROP POLICY IF EXISTS ban_athlete_read ON public.biomech_annotations;
CREATE POLICY ban_athlete_read ON public.biomech_annotations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.biomech_captures bc
                  WHERE bc.id = biomech_annotations.capture_id AND bc.athlete_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS ban_coach_read ON public.biomech_annotations;
CREATE POLICY ban_coach_read ON public.biomech_annotations FOR SELECT TO authenticated
  USING (coach_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS ban_coach_insert ON public.biomech_annotations;
CREATE POLICY ban_coach_insert ON public.biomech_annotations FOR INSERT TO authenticated
  WITH CHECK (
    coach_id = (SELECT auth.uid())
    AND (
      EXISTS (SELECT 1 FROM public.biomech_captures bc
                JOIN public.trainer_session_plans tsp ON tsp.id = bc.session_plan_id
               WHERE bc.id = biomech_annotations.capture_id AND tsp.trainer_id = (SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.biomech_captures bc
                   JOIN public.biomech_access_grants bag ON bag.athlete_id = bc.athlete_id
                  WHERE bc.id = biomech_annotations.capture_id
                    AND bag.coach_id = (SELECT auth.uid())
                    AND bag.is_active = true
                    AND (bag.expires_at IS NULL OR bag.expires_at > now())
                    AND bag.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))
    )
  );

DROP POLICY IF EXISTS ban_coach_update ON public.biomech_annotations;
CREATE POLICY ban_coach_update ON public.biomech_annotations FOR UPDATE TO authenticated
  USING (coach_id = (SELECT auth.uid()))
  WITH CHECK (
    coach_id = (SELECT auth.uid())
    AND (
      EXISTS (SELECT 1 FROM public.biomech_captures bc
                JOIN public.trainer_session_plans tsp ON tsp.id = bc.session_plan_id
               WHERE bc.id = biomech_annotations.capture_id AND tsp.trainer_id = (SELECT auth.uid()))
      OR EXISTS (SELECT 1 FROM public.biomech_captures bc
                   JOIN public.biomech_access_grants bag ON bag.athlete_id = bc.athlete_id
                  WHERE bc.id = biomech_annotations.capture_id
                    AND bag.coach_id = (SELECT auth.uid())
                    AND bag.is_active = true
                    AND (bag.expires_at IS NULL OR bag.expires_at > now())
                    AND bag.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))
    )
  );

DROP POLICY IF EXISTS ban_coach_delete ON public.biomech_annotations;
CREATE POLICY ban_coach_delete ON public.biomech_annotations FOR DELETE TO authenticated
  USING (coach_id = (SELECT auth.uid()));

-- ── skill_biomech_evidence (hallazgo 3: sbe_athlete_read) ───────────────────
DROP POLICY IF EXISTS sbe_adder_select ON public.skill_biomech_evidence;
CREATE POLICY sbe_adder_select ON public.skill_biomech_evidence FOR SELECT TO authenticated
  USING (added_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS sbe_athlete_read ON public.skill_biomech_evidence;
CREATE POLICY sbe_athlete_read ON public.skill_biomech_evidence FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.biomech_captures bc
                  WHERE bc.id = skill_biomech_evidence.capture_id AND bc.athlete_id = (SELECT auth.uid())));

-- ── Catálogos (hallazgo 5): umbrales sin datos personales, solo con sesión ──
DROP POLICY IF EXISTS ea_public_read ON public.exercise_analyzers;
CREATE POLICY ea_public_read ON public.exercise_analyzers FOR SELECT TO authenticated
  USING (true);  -- rls-lint: ok (catálogo sin datos personales)

DROP POLICY IF EXISTS eam_public_read ON public.exercise_analyzer_mappings;
CREATE POLICY eam_public_read ON public.exercise_analyzer_mappings FOR SELECT TO authenticated
  USING (true);  -- rls-lint: ok (catálogo sin datos personales)

COMMIT;
