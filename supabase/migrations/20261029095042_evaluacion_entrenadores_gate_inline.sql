-- =============================================================================
-- 20261029095042_evaluacion_entrenadores_gate_inline.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261028201746
-- Objetivo: escribir el chequeo de permisos DENTRO de las 4 RPCs de la
--   evaluación de entrenadores que lo delegaban en _coach_eval_assert_admin.
--   El gate ya funcionaba (verificado 2026-10-29: un coach de Carmel queda
--   bloqueado en las 4), pero el invariante I7 solo reconoce el chequeo escrito
--   en el cuerpo de la función y las reportaba como «sin gate» (ALTA, falso
--   positivo). Mismo comportamiento; CREATE OR REPLACE conserva los GRANT.
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
    IF auth.uid() IS NULL OR p_school_id IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;
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
    IF auth.uid() IS NULL OR p_school_id IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;

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

CREATE OR REPLACE FUNCTION public.reorder_coach_evaluation_criteria(p_school_id uuid, p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL OR p_school_id IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;
    UPDATE public.coach_evaluation_criteria c
       SET sort_order = o.ord
      FROM unnest(p_ids) WITH ORDINALITY AS o(id, ord)
     WHERE c.id = o.id AND c.school_id = p_school_id;
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
    IF auth.uid() IS NULL OR v_school IS NULL
       OR NOT (public.is_super_admin() OR v_school = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo el dueño o la administración de la escuela califican a los entrenadores.' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.coach_evaluations WHERE id = p_id;
END;
$$;

COMMIT;

-- Verificación: npm run seguridad:invariantes ya no lista estas 4 en I7.
