-- =============================================================================
-- 20261029191217_evaluacion_entrenadores_aviso_al_publicar.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261029190407
-- Objetivo: avisar al entrenador cuando el dueño/admin PUBLICA su evaluación
--   (spec evaluacion-de-entrenadores, D5). Antes solo la veía si entraba a
--   «Mis evaluaciones». Se avisa una sola vez: al pasar de borrador (o de no
--   existir) a publicada; editar una ya publicada no vuelve a avisar.
--   Solo a staff con cuenta (coach_auth_id). Si el aviso falla, la evaluación
--   se guarda igual. Mismo cuerpo que 20261028201746 + el aviso;
--   CREATE OR REPLACE conserva los GRANT.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

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
    v_uid        uuid := auth.uid();
    v_school     uuid;
    v_coach_user uuid;
    v_prev       text;
    v_end        date;
    v_id         uuid;
    v_bad        integer;
    v_n          integer;
    v_score      numeric;
    v_school_nm  text;
BEGIN
    SELECT school_id, coach_auth_id INTO v_school, v_coach_user FROM public.school_staff WHERE id = p_staff_id;
    IF v_uid IS NULL OR v_school IS NULL
       OR NOT (public.is_super_admin() OR v_school = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;

    v_end := public._coach_eval_period_end(p_period_type, p_period_start);

    IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'array' OR jsonb_array_length(p_scores) = 0 THEN
        RAISE EXCEPTION 'Califica al menos un ítem.' USING ERRCODE = '22023';
    END IF;

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

    -- Estado anterior, para avisar solo en la primera publicación.
    SELECT status INTO v_prev
      FROM public.coach_evaluations
     WHERE staff_id = p_staff_id AND period_type = p_period_type AND period_start = p_period_start;

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

    SELECT round(avg(score)::numeric, 2) INTO v_score FROM public.coach_evaluation_scores WHERE evaluation_id = v_id;
    UPDATE public.coach_evaluations SET overall_score = v_score WHERE id = v_id;

    -- Aviso al entrenador: primera publicación y solo si tiene cuenta.
    IF p_publish AND COALESCE(v_prev, 'borrador') = 'borrador' AND v_coach_user IS NOT NULL THEN
        BEGIN
            SELECT name INTO v_school_nm FROM public.schools WHERE id = v_school;
            INSERT INTO public.notifications (user_id, school_id, type, category, title, message, link, data)
            VALUES (
                v_coach_user, v_school, 'info', 'system',
                '⭐ Tienes una evaluación nueva',
                COALESCE(NULLIF(btrim(v_school_nm), ''), 'Tu escuela') || ' publicó tu evaluación del '
                  || to_char(p_period_start, 'DD/MM/YYYY') || ' al ' || to_char(v_end, 'DD/MM/YYYY')
                  || ': ' || to_char(v_score, 'FM0.0') || ' de 5.',
                '/mis-evaluaciones',
                jsonb_build_object('coach_evaluation_id', v_id, 'period_type', p_period_type, 'period_start', p_period_start)
            );
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING '[evaluacion_entrenadores] aviso al entrenador falló (%): %', v_id, SQLERRM;
        END;
    END IF;

    RETURN v_id;
END;
$$;

COMMIT;

-- Verificación (BEGIN … ROLLBACK, con claims de un admin): publicar una
-- evaluación de un staff con cuenta → 1 fila nueva en notifications con
-- link '/mis-evaluaciones'; volver a publicarla → ninguna fila más.
