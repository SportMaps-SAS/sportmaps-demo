-- =============================================================================
-- 20261027125755_rating_coach_deporte_del_equipo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: «Evaluar al equipo» (Entrenador V2) y el modal «Califica el entreno
--   de hoy» fallaban con 55000 «La escuela no tiene configurada la métrica de
--   rating del coach» en escuelas multideporte o de un deporte sin catálogo
--   post-entreno (bug B3 de docs/manuales/v2/pruebas-entrenador-v2.md).
--
-- Causa: submit_post_training_coach_rating (20260911123141) tomaba el deporte
--   de schools.category_id. Club Campestre es Golf y su equipo de Fútbol no se
--   podía calificar; coach_effort_rating solo existe para Fútbol, Fútbol Sala y
--   Voleibol.
--
-- Arreglo: el deporte sale del EQUIPO de la sesión, en este orden:
--   1. teams.sport (texto libre) contra sports_categories.name / slug,
--      sin distinguir mayúsculas ("Fútbol", "mma"…), si ese deporte tiene
--      coach_effort_rating activa;
--   2. el deporte de la escuela (schools.category_id), como antes;
--   3. cualquier definición activa de coach_effort_rating (hoy las tres son
--      idénticas: escala 50–100 con las mismas seis opciones; el rating del
--      esfuerzo no depende del deporte). Orden determinista por created_at, id.
--   Solo si no existe NINGUNA definición se mantiene el 55000.
--
-- El cuerpo es la copia EXACTA de la definición viva (pg_proc.prosrc leído el
-- 2026-10-27, SECURITY DEFINER, search_path = pg_catalog, public, pg_temp,
-- EXECUTE a authenticated/service_role) con un único cambio: el bloque que
-- resuelve v_def. Firma, retorno y validaciones sin cambios.
--
-- Verificación (después de aplicar):
--   select prosrc ilike '%t.sport%' as usa_equipo, proconfig, proacl
--     from pg_proc where proname = 'submit_post_training_coach_rating';
--   Y en la app: Club Campestre Demo → Fútbol Sub-15 → Asistencia → cerrar
--   lista → Evaluar al equipo → Guardar: debe quedar 1 fila en
--   performance_entries (metric_key = 'coach_effort_rating', context_id =
--   la sesión) y desaparecer «Falta evaluar» en Hoy.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_post_training_coach_rating(
    p_session_id  uuid,
    p_ratings     jsonb,
    p_coach_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_session      record;
    v_coach_id     uuid;
    v_sport_id     uuid;
    v_def          record;
    v_item         jsonb;
    v_child_id     uuid;
    v_user_id      uuid;
    v_subject_type text;
    v_subject_id   uuid;
    v_status       text;
    v_num          numeric;
    v_saved        int := 0;
    v_pending      int := 0;
BEGIN
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

    SELECT ss.id INTO v_coach_id
      FROM public.school_staff ss
     WHERE ss.coach_auth_id = auth.uid()
       AND ss.school_id = v_session.school_id
       AND ss.status = 'active';

    IF v_coach_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.team_coaches tc
         WHERE tc.team_id = v_session.team_id AND tc.coach_id = v_coach_id
    ) THEN
        RAISE EXCEPTION 'No autorizado: no eres coach de este equipo.' USING ERRCODE = '42501';
    END IF;

    -- 1) Deporte del EQUIPO de la sesión (teams.sport es texto libre).
    SELECT d.* INTO v_def
      FROM public.teams t
      JOIN public.sports_categories spc
        ON lower(btrim(t.sport)) IN (lower(spc.name), lower(spc.slug))
      JOIN public.sport_metric_definitions d
        ON d.sport_category_id = spc.id
       AND d.metric_key = 'coach_effort_rating'
       AND d.is_active IS NOT FALSE
     WHERE t.id = v_session.team_id
     ORDER BY d.created_at, d.id
     LIMIT 1;

    -- 2) Deporte de la escuela (comportamiento anterior).
    IF v_def.metric_key IS NULL THEN
        v_sport_id := v_session.sport_category_id;

        SELECT * INTO v_def
          FROM public.sport_metric_definitions
         WHERE sport_category_id = v_sport_id AND metric_key = 'coach_effort_rating'
           AND is_active IS NOT FALSE;
    END IF;

    -- 3) Cualquier definición activa: la escala del esfuerzo es la misma en
    --    todos los deportes que la tienen.
    IF v_def.metric_key IS NULL THEN
        SELECT * INTO v_def
          FROM public.sport_metric_definitions
         WHERE metric_key = 'coach_effort_rating'
           AND is_active IS NOT FALSE
         ORDER BY created_at, id
         LIMIT 1;
    END IF;

    IF v_def.metric_key IS NULL THEN
        RAISE EXCEPTION 'La escuela no tiene configurada la métrica de rating del coach.'
            USING ERRCODE = '55000';
    END IF;
    IF jsonb_typeof(p_ratings) <> 'array' THEN
        RAISE EXCEPTION 'p_ratings debe ser un arreglo.' USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_ratings)
    LOOP
        v_child_id := NULLIF(v_item ->> 'child_id', '')::uuid;
        v_user_id  := NULLIF(v_item ->> 'user_id', '')::uuid;

        IF (v_child_id IS NULL) = (v_user_id IS NULL) THEN
            RAISE EXCEPTION 'Cada ítem de p_ratings necesita exactamente uno de child_id/user_id.'
                USING ERRCODE = '22023';
        END IF;

        IF v_child_id IS NOT NULL THEN
            v_subject_type := 'child';   v_subject_id := v_child_id;
        ELSE
            v_subject_type := 'profile'; v_subject_id := v_user_id;
        END IF;

        SELECT ar.status INTO v_status
          FROM public.attendance_records ar
         WHERE ar.session_id = p_session_id
           AND ((v_subject_type = 'child'   AND ar.child_id = v_subject_id)
             OR (v_subject_type = 'profile' AND ar.user_id  = v_subject_id));

        IF v_status IS NULL OR v_status NOT IN ('present', 'late') THEN
            RAISE EXCEPTION 'El atleta % no asistió a esta sesión.', v_subject_id USING ERRCODE = '55000';
        END IF;

        IF NOT (v_item ? 'effort_pct') THEN
            RAISE EXCEPTION 'Falta effort_pct para %.', v_subject_id USING ERRCODE = '22023';
        END IF;

        v_num := (v_item -> 'effort_pct' #>> '{}')::numeric;
        IF (v_def.min_value IS NOT NULL AND v_num < v_def.min_value)
           OR (v_def.max_value IS NOT NULL AND v_num > v_def.max_value) THEN
            RAISE EXCEPTION 'effort_pct fuera de rango para %: %.', v_subject_id, v_num USING ERRCODE = '22023';
        END IF;
        IF v_def.options IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_def.options) o WHERE (o ->> 'value')::numeric = v_num
        ) THEN
            RAISE EXCEPTION 'effort_pct no está en las opciones válidas para %: %.', v_subject_id, v_num
                USING ERRCODE = '22023';
        END IF;

        IF EXISTS (
            SELECT 1 FROM public.athlete_reports r
             WHERE r.school_id = v_session.school_id
               AND r.subject_type = v_subject_type AND r.subject_id = v_subject_id
               AND r.period_year  = EXTRACT(YEAR  FROM v_session.session_date)::smallint
               AND r.period_month = EXTRACT(MONTH FROM v_session.session_date)::smallint
               AND r.status = 'publicado'
        ) THEN
            RAISE EXCEPTION 'El informe de este periodo ya fue publicado para %.', v_subject_id
                USING ERRCODE = '55000';
        END IF;

        INSERT INTO public.performance_entries
            (school_id, subject_type, subject_id, metric_key, value, context_type, context_id, recorded_by)
        VALUES
            (v_session.school_id, v_subject_type, v_subject_id, 'coach_effort_rating',
             v_num, 'session', p_session_id, auth.uid())
        ON CONFLICT (subject_type, subject_id, metric_key, context_id) WHERE context_type = 'session'
        DO UPDATE SET value = EXCLUDED.value, recorded_at = now();

        v_saved := v_saved + 1;
    END LOOP;

    IF p_coach_notes IS NOT NULL THEN
        UPDATE public.attendance_sessions
           SET coach_notes = NULLIF(left(btrim(p_coach_notes), 2000), '')
         WHERE id = p_session_id;
    END IF;

    SELECT count(*) INTO v_pending
      FROM public.attendance_records ar
     WHERE ar.session_id = p_session_id
       AND ar.status IN ('present', 'late')
       AND NOT EXISTS (
           SELECT 1 FROM public.performance_entries pe
            WHERE pe.context_type = 'session' AND pe.context_id = p_session_id
              AND pe.metric_key = 'coach_effort_rating'
              AND ((ar.child_id IS NOT NULL AND pe.subject_type = 'child'   AND pe.subject_id = ar.child_id)
                OR (ar.user_id  IS NOT NULL AND pe.subject_type = 'profile' AND pe.subject_id = ar.user_id))
       );

    RETURN jsonb_build_object('saved', v_saved, 'pending', v_pending);
END;
$function$;

COMMENT ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) IS
    'Rating del coach por atleta, tras cerrar la sesión. SECURITY DEFINER: valida '
    'que el caller sea coach del equipo vía team_coaches, no depende de RLS. '
    'La escala sale del deporte del EQUIPO (teams.sport), luego del de la escuela '
    'y por último de cualquier coach_effort_rating activa (20261027125755).';

-- Mismos privilegios que la definición viva: authenticated + service_role.
REVOKE ALL ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) TO authenticated, service_role;

COMMIT;
