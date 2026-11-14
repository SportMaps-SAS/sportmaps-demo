-- =============================================================================
-- 20261028201746_evaluacion_entrenadores.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261028113918
-- Objetivo: el dueño/admin califica a cada entrenador por período (semanal a
--   anual) con ítems que define cada escuela, sobre los datos de Seguimiento
--   deportivo. Spec: docs/specs/evaluacion-de-entrenadores.md (D1–D9).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================
--   Tablas   coach_evaluation_criteria · coach_evaluations · coach_evaluation_scores
--   Helpers  _coach_eval_period_end · my_coach_staff_ids
--   RPCs     ensure_coach_evaluation_criteria · save_coach_evaluation_criterion ·
--            reorder_coach_evaluation_criteria · save_coach_evaluation ·
--            delete_coach_evaluation
--   Alcance: user_admin_school_ids() (D1: solo dueño/admin; coaches excluidos).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- Ítems que califica cada escuela (D3). Uno en uso no se borra: se desactiva.
CREATE TABLE IF NOT EXISTS public.coach_evaluation_criteria (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id    uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 120),
    description  text NULL CHECK (description IS NULL OR char_length(description) <= 500),
    -- Dato de Seguimiento deportivo que se muestra al lado del ítem.
    auto_metric  text NULL CHECK (auto_metric IS NULL OR auto_metric IN
                   ('sesiones_planificadas', 'listas_tomadas', 'evaluaciones', 'adherencia_mesociclo')),
    sort_order   integer NOT NULL DEFAULT 0,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_coach_evaluation_criteria_school
    ON public.coach_evaluation_criteria (school_id, sort_order);

DROP TRIGGER IF EXISTS trg_coach_evaluation_criteria_updated_at ON public.coach_evaluation_criteria;
CREATE TRIGGER trg_coach_evaluation_criteria_updated_at
    BEFORE UPDATE ON public.coach_evaluation_criteria
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.coach_evaluation_criteria IS
  'Ítems con los que una escuela califica a sus entrenadores (spec evaluacion-de-entrenadores). Escritura solo por RPC; lectura solo administración.';

-- Una evaluación = un entrenador (school_staff, D9: también sin cuenta) en un período.
CREATE TABLE IF NOT EXISTS public.coach_evaluations (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id         uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    staff_id          uuid NOT NULL REFERENCES public.school_staff(id) ON DELETE CASCADE,
    period_type       text NOT NULL CHECK (period_type IN ('semanal', 'mensual', 'trimestral', 'semestral', 'anual')),
    period_start      date NOT NULL,
    period_end        date NOT NULL,
    status            text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'publicada')),
    overall_score     numeric(3,2) NULL CHECK (overall_score IS NULL OR overall_score BETWEEN 1 AND 5),
    strengths         text NULL CHECK (strengths    IS NULL OR char_length(strengths)    <= 2000),
    improvements      text NULL CHECK (improvements IS NULL OR char_length(improvements) <= 2000),
    commitments       text NULL CHECK (commitments  IS NULL OR char_length(commitments)  <= 2000),
    -- D6: «Otras acotaciones».
    other_notes       text NULL CHECK (other_notes  IS NULL OR char_length(other_notes)  <= 2000),
    -- Los datos de Seguimiento tal como los vio el admin al guardar: si después
    -- se cargan listas atrasadas, la nota sigue correspondiendo a lo que tenía delante.
    activity_snapshot jsonb NULL,
    evaluator_id      uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_by        uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    published_at      timestamptz NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start),
    UNIQUE (staff_id, period_type, period_start)
);
CREATE INDEX IF NOT EXISTS idx_coach_evaluations_school_staff
    ON public.coach_evaluations (school_id, staff_id, period_start DESC);

DROP TRIGGER IF EXISTS trg_coach_evaluations_updated_at ON public.coach_evaluations;
CREATE TRIGGER trg_coach_evaluations_updated_at
    BEFORE UPDATE ON public.coach_evaluations
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.coach_evaluations IS
  'Evaluación de un entrenador por período (semanal…anual). borrador = interno; publicada = la ve el entrenador (D5). Escritura solo por save_coach_evaluation.';

CREATE TABLE IF NOT EXISTS public.coach_evaluation_scores (
    evaluation_id   uuid NOT NULL REFERENCES public.coach_evaluations(id) ON DELETE CASCADE,
    criterion_id    uuid NOT NULL REFERENCES public.coach_evaluation_criteria(id) ON DELETE RESTRICT,
    -- Copia del nombre: renombrar el ítem no cambia evaluaciones viejas.
    criterion_name  text NOT NULL,
    score           smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment         text NULL CHECK (comment IS NULL OR char_length(comment) <= 1000),
    PRIMARY KEY (evaluation_id, criterion_id)
);
CREATE INDEX IF NOT EXISTS idx_coach_evaluation_scores_criterion
    ON public.coach_evaluation_scores (criterion_id);

-- -----------------------------------------------------------------------------
-- 2. RLS y privilegios de tabla
-- -----------------------------------------------------------------------------
ALTER TABLE public.coach_evaluation_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_evaluations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coach_evaluation_scores   ENABLE ROW LEVEL SECURITY;

-- Los default privileges otorgan todo a anon/authenticated en cada tabla nueva:
-- se revoca explícito y se devuelve solo SELECT.
REVOKE ALL ON TABLE public.coach_evaluation_criteria FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.coach_evaluations         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.coach_evaluation_scores   FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.coach_evaluation_criteria TO authenticated;
GRANT SELECT ON TABLE public.coach_evaluations         TO authenticated;
GRANT SELECT ON TABLE public.coach_evaluation_scores   TO authenticated;

-- Fichas de school_staff de la cuenta que llama (el entrenador ve las suyas, D5).
-- SECURITY DEFINER: la policy no depende de la RLS de school_staff.
CREATE OR REPLACE FUNCTION public.my_coach_staff_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT COALESCE(array_agg(s.id), '{}'::uuid[])
      FROM public.school_staff s
     WHERE s.coach_auth_id = auth.uid()
       AND auth.uid() IS NOT NULL;
$$;

-- Escritura: NINGUNA policy. Todo pasa por las RPCs SECURITY DEFINER.
DROP POLICY IF EXISTS coach_evaluation_criteria_select_admin ON public.coach_evaluation_criteria;
CREATE POLICY coach_evaluation_criteria_select_admin ON public.coach_evaluation_criteria
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS coach_evaluations_select_admin_or_own ON public.coach_evaluations;
CREATE POLICY coach_evaluations_select_admin_or_own ON public.coach_evaluations
    FOR SELECT TO authenticated
    USING (
        school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])
        OR (status = 'publicada' AND staff_id = ANY ((SELECT public.my_coach_staff_ids())::uuid[]))
    );

-- Las notas se ven si se ve la evaluación (tabla distinta: no hay auto-recursión).
DROP POLICY IF EXISTS coach_evaluation_scores_select_visible ON public.coach_evaluation_scores;
CREATE POLICY coach_evaluation_scores_select_visible ON public.coach_evaluation_scores
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.coach_evaluations e WHERE e.id = evaluation_id));

-- -----------------------------------------------------------------------------
-- 3. Helpers
-- -----------------------------------------------------------------------------

-- Fin del período. Falla si el inicio no está alineado: lunes · día 1 ·
-- 1 de ene/abr/jul/oct · 1 de ene/jul · 1 de enero.
CREATE OR REPLACE FUNCTION public._coach_eval_period_end(p_type text, p_start date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_type = 'semanal' THEN
        IF extract(isodow FROM p_start) <> 1 THEN
            RAISE EXCEPTION 'Una evaluación semanal empieza en lunes.' USING ERRCODE = '22023';
        END IF;
        RETURN p_start + 6;
    END IF;
    IF extract(day FROM p_start) <> 1 THEN
        RAISE EXCEPTION 'El período debe empezar el día 1 del mes.' USING ERRCODE = '22023';
    END IF;
    IF p_type = 'mensual' THEN
        RETURN (p_start + interval '1 month')::date - 1;
    ELSIF p_type = 'trimestral' THEN
        IF extract(month FROM p_start)::int NOT IN (1, 4, 7, 10) THEN
            RAISE EXCEPTION 'Un trimestre empieza en enero, abril, julio u octubre.' USING ERRCODE = '22023';
        END IF;
        RETURN (p_start + interval '3 months')::date - 1;
    ELSIF p_type = 'semestral' THEN
        IF extract(month FROM p_start)::int NOT IN (1, 7) THEN
            RAISE EXCEPTION 'Un semestre empieza en enero o julio.' USING ERRCODE = '22023';
        END IF;
        RETURN (p_start + interval '6 months')::date - 1;
    ELSIF p_type = 'anual' THEN
        IF extract(month FROM p_start)::int <> 1 THEN
            RAISE EXCEPTION 'Un período anual empieza el 1 de enero.' USING ERRCODE = '22023';
        END IF;
        RETURN (p_start + interval '1 year')::date - 1;
    END IF;
    RAISE EXCEPTION 'Tipo de período inválido: %', p_type USING ERRCODE = '22023';
END;
$$;

-- Gate común: la escuela es de quien llama (admin) o es super admin.
CREATE OR REPLACE FUNCTION public._coach_eval_assert_admin(p_school_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL OR p_school_id IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RPCs de ítems
-- -----------------------------------------------------------------------------

-- Plantilla inicial si la escuela no tiene ningún ítem. Idempotente.
CREATE OR REPLACE FUNCTION public.ensure_coach_evaluation_criteria(p_school_id uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    PERFORM public._coach_eval_assert_admin(p_school_id);
    PERFORM pg_advisory_xact_lock(hashtextextended('coach_eval_criteria:' || p_school_id::text, 0));

    IF EXISTS (SELECT 1 FROM public.coach_evaluation_criteria WHERE school_id = p_school_id) THEN
        RETURN 0;
    END IF;

    INSERT INTO public.coach_evaluation_criteria (school_id, name, description, auto_metric, sort_order)
    VALUES
      (p_school_id, 'Planificación de sesiones', 'Planifica con tiempo todas las sesiones de sus equipos.', 'sesiones_planificadas', 1),
      (p_school_id, 'Toma de asistencia', 'Toma lista en cada entrenamiento.', 'listas_tomadas', 2),
      (p_school_id, 'Evaluación de deportistas', 'Registra el rendimiento de sus deportistas.', 'evaluaciones', 3),
      (p_school_id, 'Cumplimiento del mesociclo', 'Lo planificado se entrena.', 'adherencia_mesociclo', 4),
      (p_school_id, 'Puntualidad y presentación', 'Llega a tiempo y con la indumentaria de la escuela.', NULL, 5),
      (p_school_id, 'Trato con deportistas y familias', 'Comunicación respetuosa y oportuna.', NULL, 6);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Crea (p_id NULL) o edita un ítem. Devuelve su id.
CREATE OR REPLACE FUNCTION public.save_coach_evaluation_criterion(
    p_school_id   uuid,
    p_id          uuid,
    p_name        text,
    p_description text,
    p_auto_metric text,
    p_active      boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM public._coach_eval_assert_admin(p_school_id);

    IF p_id IS NULL THEN
        INSERT INTO public.coach_evaluation_criteria (school_id, name, description, auto_metric, active, sort_order)
        VALUES (p_school_id, btrim(p_name), NULLIF(btrim(COALESCE(p_description, '')), ''), NULLIF(p_auto_metric, ''),
                COALESCE(p_active, true),
                COALESCE((SELECT max(sort_order) FROM public.coach_evaluation_criteria WHERE school_id = p_school_id), 0) + 1)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.coach_evaluation_criteria
           SET name = btrim(p_name),
               description = NULLIF(btrim(COALESCE(p_description, '')), ''),
               auto_metric = NULLIF(p_auto_metric, ''),
               active = COALESCE(p_active, active)
         WHERE id = p_id AND school_id = p_school_id
        RETURNING id INTO v_id;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'Ese ítem no es de esta escuela.' USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN v_id;
END;
$$;

-- Orden de los ítems: p_ids en el orden deseado (los que no vengan no se tocan).
CREATE OR REPLACE FUNCTION public.reorder_coach_evaluation_criteria(p_school_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public._coach_eval_assert_admin(p_school_id);
    UPDATE public.coach_evaluation_criteria c
       SET sort_order = o.ord
      FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
     WHERE c.id = o.id AND c.school_id = p_school_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RPCs de evaluaciones
-- -----------------------------------------------------------------------------

-- Crea o actualiza la evaluación del entrenador en el período, con sus notas,
-- en UNA transacción (regla: creación multi-fila = RPC). La escuela sale del
-- staff, no de un parámetro. p_scores: [{criterion_id, score 1..5, comment}].
-- p_publish = true → publicada (la ve el entrenador); false → borrador.
CREATE OR REPLACE FUNCTION public.save_coach_evaluation(
    p_staff_id     uuid,
    p_period_type  text,
    p_period_start date,
    p_scores       jsonb,
    p_strengths    text,
    p_improvements text,
    p_commitments  text,
    p_other_notes  text,
    p_snapshot     jsonb,
    p_publish      boolean
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid     uuid := auth.uid();
    v_school  uuid;
    v_end     date;
    v_id      uuid;
    v_bad     integer;
    v_n       integer;
BEGIN
    SELECT school_id INTO v_school FROM public.school_staff WHERE id = p_staff_id;
    PERFORM public._coach_eval_assert_admin(v_school);

    v_end := public._coach_eval_period_end(p_period_type, p_period_start);

    IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'array' OR jsonb_array_length(p_scores) = 0 THEN
        RAISE EXCEPTION 'Califica al menos un ítem.' USING ERRCODE = '22023';
    END IF;

    -- Cada ítem debe ser de la escuela y la nota estar entre 1 y 5.
    SELECT count(*) INTO v_bad
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, comment text)
      LEFT JOIN public.coach_evaluation_criteria c
        ON c.id = s.criterion_id AND c.school_id = v_school
     WHERE c.id IS NULL OR s.score IS NULL OR s.score NOT BETWEEN 1 AND 5;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Hay ítems que no son de la escuela o notas fuera de 1 a 5.' USING ERRCODE = '22023';
    END IF;

    SELECT count(*) - count(DISTINCT s.criterion_id) INTO v_n
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid);
    IF v_n > 0 THEN
        RAISE EXCEPTION 'Un ítem aparece dos veces.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.coach_evaluations AS e (
        school_id, staff_id, period_type, period_start, period_end, status,
        strengths, improvements, commitments, other_notes, activity_snapshot,
        evaluator_id, updated_by, published_at
    ) VALUES (
        v_school, p_staff_id, p_period_type, p_period_start, v_end,
        CASE WHEN p_publish THEN 'publicada' ELSE 'borrador' END,
        NULLIF(btrim(COALESCE(p_strengths, '')), ''),
        NULLIF(btrim(COALESCE(p_improvements, '')), ''),
        NULLIF(btrim(COALESCE(p_commitments, '')), ''),
        NULLIF(btrim(COALESCE(p_other_notes, '')), ''),
        p_snapshot, v_uid, v_uid,
        CASE WHEN p_publish THEN now() END
    )
    ON CONFLICT (staff_id, period_type, period_start) DO UPDATE
       SET status            = EXCLUDED.status,
           strengths         = EXCLUDED.strengths,
           improvements      = EXCLUDED.improvements,
           commitments       = EXCLUDED.commitments,
           other_notes       = EXCLUDED.other_notes,
           activity_snapshot = COALESCE(EXCLUDED.activity_snapshot, e.activity_snapshot),
           updated_by        = v_uid,
           published_at      = CASE WHEN EXCLUDED.status = 'publicada' THEN COALESCE(e.published_at, now()) ELSE e.published_at END
    RETURNING e.id INTO v_id;

    DELETE FROM public.coach_evaluation_scores WHERE evaluation_id = v_id;
    INSERT INTO public.coach_evaluation_scores (evaluation_id, criterion_id, criterion_name, score, comment)
    SELECT v_id, s.criterion_id, c.name, s.score, NULLIF(btrim(COALESCE(s.comment, '')), '')
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, comment text)
      JOIN public.coach_evaluation_criteria c ON c.id = s.criterion_id;

    UPDATE public.coach_evaluations
       SET overall_score = (SELECT round(avg(score)::numeric, 2) FROM public.coach_evaluation_scores WHERE evaluation_id = v_id)
     WHERE id = v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_coach_evaluation(p_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school uuid;
BEGIN
    SELECT school_id INTO v_school FROM public.coach_evaluations WHERE id = p_id;
    PERFORM public._coach_eval_assert_admin(v_school);
    DELETE FROM public.coach_evaluations WHERE id = p_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Privilegios de funciones
--    REVOKE de PUBLIC no alcanza: los default privileges dan EXECUTE a
--    authenticated/anon en cada función nueva. Se revoca explícito de los tres.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._coach_eval_period_end(text, date)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._coach_eval_assert_admin(uuid)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_coach_staff_ids()                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_coach_evaluation_criteria(uuid)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_coach_evaluation_criterion(uuid, uuid, text, text, text, boolean)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reorder_coach_evaluation_criteria(uuid, uuid[])                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_coach_evaluation(uuid, text, date, jsonb, text, text, text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_coach_evaluation(uuid)                                             FROM PUBLIC, anon, authenticated;

-- my_coach_staff_ids lo evalúa la policy con el rol del que consulta: necesita EXECUTE.
GRANT EXECUTE ON FUNCTION public.my_coach_staff_ids() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_coach_evaluation_criteria(uuid)                                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_coach_evaluation_criterion(uuid, uuid, text, text, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_coach_evaluation_criteria(uuid, uuid[])                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_coach_evaluation(uuid, text, date, jsonb, text, text, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_coach_evaluation(uuid)                                          TO authenticated;

COMMIT;

/* -----------------------------------------------------------------------------
   Pruebas (correr a mano después de aplicar, dentro de BEGIN … ROLLBACK):

   -- T1 anon no lee nada
   set local role anon; select count(*) from public.coach_evaluations;        -- 0 o permission denied
   -- T2 privilegios
   select has_table_privilege('authenticated','public.coach_evaluations','INSERT');  -- false
   -- T3 períodos
   select public._coach_eval_period_end('trimestral','2026-10-01');  -- 2026-12-31
   select public._coach_eval_period_end('semanal','2026-10-28');     -- error: no es lunes
   -- T4 un coach (claims de su uuid) llamando save_coach_evaluation → 42501
   -- T5 coach ve sus publicadas y NO sus borradores
   -- Después: npm run seguridad:invariantes y listar TODAS las policies:
   select tablename, cmd, policyname, roles, qual, with_check from pg_policies
    where tablename in ('coach_evaluation_criteria','coach_evaluations','coach_evaluation_scores');
----------------------------------------------------------------------------- */
