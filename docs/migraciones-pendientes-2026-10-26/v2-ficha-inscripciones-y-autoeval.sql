-- Copia lista para pegar en el SQL editor de Supabase (idéntica a
-- supabase/migrations/20261026155123_v2_ficha_inscripciones_y_autoeval.sql).
-- Después de pegarla: correr v2-ficha-inscripciones-y-autoeval-verificar.sql
-- y registrar la versión 20261026155123 en schema_migrations si se aplica por el editor.

-- =============================================================================
-- 20261026155123_v2_ficha_inscripciones_y_autoeval.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-26   Versión anterior: 20261026132948
-- Objetivo: rediseño V2 (docs/specs/entrenador-deportista-v2.md) — la cuenta
--   enlazada a una ficha (unregistered_athletes.linked_profile_id = auth.uid())
--   1) LEE las inscripciones de su ficha (solo lectura, ninguna escritura), y
--   2) responde «¿Qué tan duro fue?» por su ficha:
--      submit_post_training_self_eval gana p_unregistered_athlete_id (DEFAULT
--      NULL, al final). Autoriza con is_linked_unregistered_athlete(...) y valida
--      la asistencia en attendance_records.unregistered_athlete_id. Guarda en
--      performance_entries con subject_type = 'unregistered' (ya permitido por
--      el CHECK y ya legible por performance_entries_select_linked_athlete).
--      Todo lo demás (24 h, finalized, requeridas, rangos, opciones, focus,
--      idempotencia ON CONFLICT, racha, promedio del mes) queda IGUAL.
--
-- Radio medido (2026-10-26, lectura en la base viva):
--   · 76 fichas vinculadas, 74 cuentas. Inscripciones de esas fichas: 2 (ambas
--     'cancelled'), 1 por cuenta como máximo, ninguna ya visible por user_id.
--     → la policy nueva hace visibles 2 filas en total, a 2 cuentas.
--   · Asistencia de fichas vinculadas: 6 registros en 6 sesiones, 2 cuentas. Las
--     6 sesiones ya son legibles por esas cuentas (membresía activa de la
--     escuela → «Attendance sessions: select staff» vía user_school_ids()), así
--     que la lista de pendientes del frontend las ve SIN tocar attendance_sessions.
--     Pendiente conocido: 5 de 76 fichas vinculadas no tienen membresía activa en
--     su escuela; hoy no tienen asistencia. Si la llegan a tener, la tarjeta no
--     sale (falla cerrada), no se rompe nada.
--   · La firma de la RPC cambia (4 → 5 parámetros): DROP de la vieja + GRANT/REVOKE
--     explícitos. Las llamadas existentes usan parámetros con nombre
--     (p_session_id, p_child_id, p_user_id, p_answers) y siguen resolviendo.
--
-- Sin self-recursion: la policy de enrollments no lee enrollments; usa
--   my_linked_unregistered_ids() (SECURITY DEFINER, lee unregistered_athletes),
--   envuelta en (SELECT …) para que se evalúe una vez por consulta.
--
-- Verificación: docs/migraciones-pendientes-2026-10-26/v2-ficha-inscripciones-y-autoeval-verificar.sql
--   (un bloque DO que termina en RAISE EXCEPTION a propósito: no deja nada).
--   Rápida:
--     select policyname, roles, qual from pg_policies
--      where tablename='enrollments' and policyname='Enrollments: select linked athlete';
--     select oid::regprocedure, proacl, proconfig from pg_proc
--      where proname='submit_post_training_self_eval';
--
-- Reversa:
--   DROP POLICY IF EXISTS "Enrollments: select linked athlete" ON public.enrollments;
--   DROP FUNCTION IF EXISTS public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid);
--   -- y recrear la versión de 4 parámetros (cuerpo idéntico a este sin la rama
--   -- 'unregistered'; pg_get_functiondef antes de aplicar si se quiere el exacto),
--   -- con REVOKE … FROM PUBLIC, anon y GRANT EXECUTE … TO authenticated, service_role.
-- =============================================================================

BEGIN;

-- ── 1) Inscripciones de la ficha vinculada: solo lectura ─────────────────────
DROP POLICY IF EXISTS "Enrollments: select linked athlete" ON public.enrollments;
CREATE POLICY "Enrollments: select linked athlete"
  ON public.enrollments
  FOR SELECT
  TO authenticated
  USING (
    unregistered_athlete_id IS NOT NULL
    AND unregistered_athlete_id = ANY ((SELECT public.my_linked_unregistered_ids())::uuid[])
  );

-- ── 2) Autoevaluación también por la ficha ───────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.submit_post_training_self_eval(
    p_session_id uuid,
    p_child_id uuid DEFAULT NULL::uuid,
    p_user_id uuid DEFAULT NULL::uuid,
    p_answers jsonb DEFAULT '{}'::jsonb,
    p_unregistered_athlete_id uuid DEFAULT NULL::uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_session      record;
    v_subject_type text;
    v_subject_id   uuid;
    v_status       text;
    v_sport_id     uuid;
    v_key          text;
    v_val          jsonb;
    v_num          numeric;
    v_def          record;
    v_focus        jsonb;
    v_focus_key    text;
    v_saved        int := 0;
    v_streak       int := 0;
    v_month_avg    numeric;
    v_rec          record;
BEGIN
    IF num_nonnulls(p_child_id, p_user_id, p_unregistered_athlete_id) <> 1 THEN
        RAISE EXCEPTION 'Debe indicarse exactamente uno de p_child_id, p_user_id o p_unregistered_athlete_id.'
            USING ERRCODE = '22023';
    END IF;

    IF p_child_id IS NOT NULL THEN
        IF NOT public.is_parent_of_child(p_child_id) THEN
            RAISE EXCEPTION 'No autorizado: no eres el acudiente de este atleta.'
                USING ERRCODE = '42501';
        END IF;
        v_subject_type := 'child';
        v_subject_id := p_child_id;
    ELSIF p_unregistered_athlete_id IS NOT NULL THEN
        IF NOT public.is_linked_unregistered_athlete(p_unregistered_athlete_id) THEN
            RAISE EXCEPTION 'No autorizado: esta ficha no está vinculada a tu cuenta.'
                USING ERRCODE = '42501';
        END IF;
        v_subject_type := 'unregistered';
        v_subject_id := p_unregistered_athlete_id;
    ELSE
        IF p_user_id <> auth.uid() THEN
            RAISE EXCEPTION 'No autorizado: solo puedes responder por ti.'
                USING ERRCODE = '42501';
        END IF;
        v_subject_type := 'profile';
        v_subject_id := p_user_id;
    END IF;

    SELECT s.*, sc.category_id AS sport_category_id
      INTO v_session
      FROM public.attendance_sessions s
      JOIN public.schools sc ON sc.id = s.school_id
     WHERE s.id = p_session_id
     FOR UPDATE OF s;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Sesión no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF v_session.finalized IS NOT TRUE THEN
        RAISE EXCEPTION 'La sesión todavía no se ha cerrado.' USING ERRCODE = '55000';
    END IF;
    IF v_session.finalized_at IS NOT NULL AND now() > v_session.finalized_at + interval '24 hours' THEN
        RAISE EXCEPTION 'Ya pasaron 24 horas desde el cierre de la sesión.' USING ERRCODE = '55000';
    END IF;

    SELECT ar.status INTO v_status
      FROM public.attendance_records ar
     WHERE ar.session_id = p_session_id
       AND ((v_subject_type = 'child'        AND ar.child_id = v_subject_id)
         OR (v_subject_type = 'profile'      AND ar.user_id  = v_subject_id)
         OR (v_subject_type = 'unregistered' AND ar.unregistered_athlete_id = v_subject_id));

    IF v_status IS NULL OR v_status NOT IN ('present', 'late') THEN
        RAISE EXCEPTION 'El atleta no asistió a esta sesión.' USING ERRCODE = '55000';
    END IF;

    v_sport_id := v_session.sport_category_id;
    IF v_sport_id IS NULL THEN
        RAISE EXCEPTION 'La escuela no tiene deporte configurado.' USING ERRCODE = '55000';
    END IF;

    FOR v_def IN
        SELECT metric_key
          FROM public.sport_metric_definitions
         WHERE sport_category_id = v_sport_id
           AND required = true
           AND metric_key IN ('rpe_borg', 'task_comprehension', 'self_effort_pct', 'satisfaction')
    LOOP
        IF NOT (p_answers ? v_def.metric_key) THEN
            RAISE EXCEPTION 'Falta responder: %.', v_def.metric_key USING ERRCODE = '22023';
        END IF;
    END LOOP;

    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_answers)
    LOOP
        CONTINUE WHEN v_key IN ('focus', 'focus_other_text');

        SELECT * INTO v_def
          FROM public.sport_metric_definitions
         WHERE sport_category_id = v_sport_id AND metric_key = v_key;

        IF v_def.metric_key IS NULL THEN
            RAISE EXCEPTION 'Métrica desconocida para este deporte: %.', v_key USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_val) <> 'number' THEN
            RAISE EXCEPTION 'Valor inválido para %: se esperaba un número.', v_key USING ERRCODE = '22023';
        END IF;

        v_num := (v_val #>> '{}')::numeric;
        IF (v_def.min_value IS NOT NULL AND v_num < v_def.min_value)
           OR (v_def.max_value IS NOT NULL AND v_num > v_def.max_value) THEN
            RAISE EXCEPTION 'Valor fuera de rango para %: %.', v_key, v_num USING ERRCODE = '22023';
        END IF;
        IF v_def.options IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_def.options) o WHERE (o->>'value')::numeric = v_num
        ) THEN
            RAISE EXCEPTION 'Valor no está en las opciones válidas para %: %.', v_key, v_num USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.performance_entries
            (school_id, subject_type, subject_id, metric_key, value, context_type, context_id, recorded_by)
        VALUES
            (v_session.school_id, v_subject_type, v_subject_id, v_key, v_num, 'session', p_session_id, auth.uid())
        ON CONFLICT (subject_type, subject_id, metric_key, context_id) WHERE context_type = 'session'
        DO UPDATE SET value = EXCLUDED.value, recorded_at = now();

        v_saved := v_saved + 1;
    END LOOP;

    v_focus := COALESCE(p_answers -> 'focus', '[]'::jsonb);
    IF jsonb_typeof(v_focus) <> 'array' THEN
        RAISE EXCEPTION '"focus" debe ser un arreglo de claves.' USING ERRCODE = '22023';
    END IF;
    IF p_answers ? 'focus_other_text' AND NOT (v_focus ? 'focus_other') THEN
        RAISE EXCEPTION '"focus_other_text" solo aplica si "focus" incluye "focus_other".'
            USING ERRCODE = '22023';
    END IF;

    FOR v_focus_key IN SELECT jsonb_array_elements_text(v_focus)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.sport_metric_definitions
             WHERE sport_category_id = v_sport_id AND metric_key = v_focus_key
        ) THEN
            RAISE EXCEPTION '"aspectos a mejorar" no existe en el catálogo: %.', v_focus_key
                USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.performance_entries
            (school_id, subject_type, subject_id, metric_key, value, context_type, context_id, recorded_by, notes)
        VALUES
            (v_session.school_id, v_subject_type, v_subject_id, v_focus_key, 1, 'session', p_session_id, auth.uid(),
             CASE WHEN v_focus_key = 'focus_other' THEN left(btrim(p_answers ->> 'focus_other_text'), 200) END)
        ON CONFLICT (subject_type, subject_id, metric_key, context_id) WHERE context_type = 'session'
        DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes, recorded_at = now();

        v_saved := v_saved + 1;
    END LOOP;

    FOR v_rec IN
        SELECT EXISTS (
            SELECT 1 FROM public.performance_entries pe
             WHERE pe.context_type = 'session' AND pe.context_id = s.id
               AND pe.subject_type = v_subject_type AND pe.subject_id = v_subject_id
               AND pe.metric_key = 'rpe_borg'
        ) AS respondida
          FROM public.attendance_sessions s
          JOIN public.attendance_records ar ON ar.session_id = s.id
         WHERE s.team_id = v_session.team_id
           AND s.finalized = true
           AND ar.status IN ('present', 'late')
           AND ((v_subject_type = 'child'        AND ar.child_id = v_subject_id)
             OR (v_subject_type = 'profile'      AND ar.user_id  = v_subject_id)
             OR (v_subject_type = 'unregistered' AND ar.unregistered_athlete_id = v_subject_id))
         ORDER BY s.session_date DESC
    LOOP
        EXIT WHEN NOT v_rec.respondida;
        v_streak := v_streak + 1;
    END LOOP;

    SELECT round(avg(value)) INTO v_month_avg
      FROM public.performance_entries
     WHERE subject_type = v_subject_type AND subject_id = v_subject_id
       AND metric_key = 'rpe_borg' AND context_type = 'session'
       AND recorded_at >= date_trunc('month', now());

    RETURN jsonb_build_object('saved', v_saved, 'streak', v_streak, 'month_avg_borg', v_month_avg);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) TO service_role;

COMMENT ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) IS
  'Autoevaluación post-entreno. Sujeto: exactamente uno de p_child_id (acudiente), p_user_id (= auth.uid()) o p_unregistered_athlete_id (ficha vinculada a la cuenta). 20261026155123.';

NOTIFY pgrst, 'reload schema';

COMMIT;
