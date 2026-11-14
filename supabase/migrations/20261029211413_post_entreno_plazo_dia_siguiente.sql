-- =============================================================================
-- 20261029211413_post_entreno_plazo_dia_siguiente.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261029191217
-- Objetivo: la encuesta post-entreno («¿Cómo estuvo el entreno?») tiene que
-- APARECER y poder RESPONDERSE hasta el final del día siguiente a cuando le
-- llegó a la familia, aunque el entrenador no cierre la lista.
--
-- Caso real (Besser, 2026-10-28/29): desde la V2 del entrenador la lista se
-- guarda pero no se cierra; la encuesta sale solo al cerrar (trigger
-- post_training_notify_on_finalize). Tres fallas encadenadas:
--   1. auto_finalize_stale_sessions solo cerraba días ANTERIORES
--      (session_date < CURRENT_DATE, y la base está en America/Bogota): una
--      lista del martes sin cerrar se cerraba el miércoles 23:55.
--   2. Al cerrar, pone finalized_at = fecha del entreno + end_time (o 23:59),
--      es decir, EN EL PASADO; y submit_post_training_self_eval rechazaba
--      «Ya pasaron 24 horas desde el cierre» contando desde ese finalized_at.
--      Resultado: la encuesta llegaba a medianoche ya vencida (10-28 23:55:
--      36 encuestas de los días 24/25, 0 respuestas).
--   3. El recordatorio de las 20:00 solo miraba encuestas creadas ESE día:
--      a la que llega de noche nunca le tocaba recordatorio.
--
-- Qué cambia:
--   · post_training_plazo_respuesta(cierre): fin del día SIGUIENTE (Bogotá) al
--     cierre real. Una sola regla para la RPC, el recordatorio y el aviso.
--   · El cierre real es GREATEST(finalized_at, updated_at): el cierre manual
--     deja ambos en now(); el automático deja finalized_at en la hora del
--     entreno y updated_at en now(). No se toca la semántica de finalized_at
--     (la usan «última actividad» del coach y los resúmenes de evaluación).
--   · auto_finalize_stale_sessions: además de los días anteriores, cierra las
--     listas de HOY cuando corre a partir de las 23:00 Bogotá (pg_cron la
--     corre 23:55). Antes de esa hora sigue igual: la ruta del BFF
--     (routes/system.ts) puede llamarla de día sin cerrar entrenos en curso.
--   · Aviso: el título ya no dice «de hoy» si el entreno no fue hoy, y dice
--     hasta cuándo se puede responder.
--   · Recordatorio de las 20:00: también para encuestas creadas AYER, si siguen
--     en plazo y la sesión sigue cerrada. Sigue siendo uno por encuesta. Y ya
--     no toma como encuesta el resumen «Así le fue hoy» (kind='daily_recap'),
--     que le llega al acudiente DESPUÉS de responder.
--
-- Verificación (después de aplicar):
--   select public.post_training_plazo_respuesta('2026-10-29 23:55-05');
--     → 2026-10-31 00:00:00-05 (se responde todo el 30)
--   select proname, proacl from pg_proc where proname like 'post_training_%'
--      or proname in ('auto_finalize_stale_sessions','submit_post_training_self_eval');
--     → ACL iguales a antes; el helper solo postgres/service_role.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ─── 1. La regla del plazo, en un solo lugar ─────────────────────────────────
-- Fin del día siguiente (hora de Bogotá) al cierre real de la lista.
CREATE OR REPLACE FUNCTION public.post_training_plazo_respuesta(p_cierre timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT ((p_cierre AT TIME ZONE 'America/Bogota')::date + 2)::timestamp
           AT TIME ZONE 'America/Bogota';
$$;

COMMENT ON FUNCTION public.post_training_plazo_respuesta(timestamptz) IS
    'Hasta cuándo se puede responder la autoevaluación post-entreno: fin del día '
    'siguiente (Bogotá) al cierre real de la lista, GREATEST(finalized_at, updated_at). '
    'La misma regla la replica el frontend en lib/postEntrenoAutoeval.ts (plazoAutoeval).';

-- Solo la llaman funciones SECURITY DEFINER (corren como dueño).
REVOKE ALL ON FUNCTION public.post_training_plazo_respuesta(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_training_plazo_respuesta(timestamptz) TO service_role;

-- ─── 2. La RPC de respuesta usa el plazo nuevo ───────────────────────────────
-- Cuerpo idéntico al vivo (20261026155123) salvo el chequeo del plazo.
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
AS $$
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
    -- Antes: finalized_at + 24 h. El cierre automático deja finalized_at en el
    -- pasado y la encuesta llegaba vencida. Ahora: fin del día siguiente al cierre real.
    IF now() >= public.post_training_plazo_respuesta(GREATEST(v_session.finalized_at, v_session.updated_at)) THEN
        RAISE EXCEPTION 'Ya se cerró el plazo para responder: era hasta el día siguiente al entreno.' USING ERRCODE = '55000';
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
$$;

-- CREATE OR REPLACE conserva el ACL; se repite para que el archivo sea la verdad.
REVOKE ALL ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_post_training_self_eval(uuid, uuid, uuid, jsonb, uuid) TO authenticated, service_role;

-- ─── 3. Cierre automático: también las listas de hoy, de noche ───────────────
CREATE OR REPLACE FUNCTION public.auto_finalize_stale_sessions()
RETURNS TABLE(sessions_finalized integer, school_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count       int := 0;
  v_school_ids  uuid[] := ARRAY[]::uuid[];
  v_session     record;
  v_hoy         date := (now() AT TIME ZONE 'America/Bogota')::date;
  -- pg_cron la corre a las 23:55 Bogotá: a esa hora el entreno de hoy ya
  -- terminó. Llamada de día (routes/system.ts) solo cierra días anteriores.
  v_noche       boolean := (now() AT TIME ZONE 'America/Bogota')::time >= time '23:00';
BEGIN
  FOR v_session IN
    SELECT id, school_id
      FROM public.attendance_sessions
     WHERE finalized = false
       AND (session_date < v_hoy OR (v_noche AND session_date = v_hoy))
  LOOP
    UPDATE public.attendance_sessions
       SET finalized    = true,
           finalized_at = (session_date + COALESCE(end_time, '23:59:00'::time))::timestamptz,
           finalized_by = NULL,
           updated_at   = now()
     WHERE id = v_session.id;

    v_count := v_count + 1;
    IF NOT (v_session.school_id = ANY (v_school_ids)) THEN
      v_school_ids := array_append(v_school_ids, v_session.school_id);
    END IF;

    BEGIN
      PERFORM public.mark_session_absences(v_session.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'mark_session_absences fallo para sesion %: %', v_session.id, SQLERRM;
    END;
  END LOOP;

  RETURN QUERY SELECT v_count, COALESCE(array_length(v_school_ids, 1), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.auto_finalize_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_finalize_stale_sessions() TO service_role;

-- ─── 4. Aviso al cerrar: título según el día y hasta cuándo responder ────────
CREATE OR REPLACE FUNCTION public.post_training_notify_on_finalize()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_rec       record;
    v_recipient uuid;
    v_opted_out boolean;
    v_team_name text;
    v_titulo    text;
BEGIN
    SELECT t.name INTO v_team_name FROM public.teams t WHERE t.id = NEW.team_id;

    -- La lista que cierra el automático de las 23:55 puede ser de otro día.
    v_titulo := CASE WHEN NEW.session_date = (now() AT TIME ZONE 'America/Bogota')::date
                     THEN '¿Cómo estuvo el entreno de hoy?'
                     ELSE '¿Cómo estuvo el entreno?' END;

    FOR v_rec IN
        SELECT ar.child_id, ar.user_id
          FROM public.attendance_records ar
         WHERE ar.session_id = NEW.id
           AND ar.status IN ('present', 'late')
    LOOP
        v_recipient := NULL;
        v_opted_out := false;

        IF v_rec.child_id IS NOT NULL THEN
            SELECT c.parent_id, COALESCE(c.post_training_opt_out, false)
              INTO v_recipient, v_opted_out
              FROM public.children c
             WHERE c.id = v_rec.child_id;
        ELSIF v_rec.user_id IS NOT NULL THEN
            SELECT p.id, COALESCE((p.preferences ->> 'post_training_opt_out')::boolean, false)
              INTO v_recipient, v_opted_out
              FROM public.profiles p
             WHERE p.id = v_rec.user_id;
        END IF;

        CONTINUE WHEN v_recipient IS NULL OR v_opted_out;

        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.notifications n
             WHERE n.user_id = v_recipient
               AND n.category = 'post_training'
               AND n.data ->> 'session_id' = NEW.id::text
               AND n.data ->> 'child_id' IS NOT DISTINCT FROM v_rec.child_id::text
               AND n.data ->> 'user_id_athlete' IS NOT DISTINCT FROM v_rec.user_id::text
        );

        INSERT INTO public.notifications (user_id, title, message, type, category, data, link)
        VALUES (
            v_recipient,
            v_titulo,
            'Responde en menos de 30 segundos cómo se sintió en el entrenamiento de '
                || COALESCE(v_team_name, 'hoy') || '. Tienes hasta mañana.',
            'info',
            'post_training',
            jsonb_build_object(
                'session_id', NEW.id,
                'team_id', NEW.team_id,
                'child_id', v_rec.child_id,
                'user_id_athlete', v_rec.user_id
            ),
            '/post-entreno/' || NEW.id::text
                || CASE WHEN v_rec.child_id IS NOT NULL THEN '?child_id=' || v_rec.child_id::text ELSE '' END
        );
    END LOOP;

    RETURN NEW;
END;
$$;

-- Función de trigger: mismo ACL que dejó 20261028111254.
REVOKE EXECUTE ON FUNCTION public.post_training_notify_on_finalize() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.post_training_notify_on_finalize() TO authenticated, service_role;

-- ─── 5. Recordatorio de las 20:00: también lo que llegó ayer ─────────────────
CREATE OR REPLACE FUNCTION public.post_training_send_parent_reminders_system()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_rec   record;
    v_count integer := 0;
    v_hoy   date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    IF (now() AT TIME ZONE 'America/Bogota')::time < time '20:00' THEN
        RETURN 0;
    END IF;

    FOR v_rec IN
        SELECT n.id, n.user_id, n.data,
               (public.post_training_plazo_respuesta(GREATEST(s.finalized_at, s.updated_at))
                    AT TIME ZONE 'America/Bogota')::date - 1 AS ultimo_dia
          FROM public.notifications n
          JOIN public.attendance_sessions s ON s.id::text = n.data ->> 'session_id'
         WHERE n.category = 'post_training'
           AND NOT (n.data ? 'reminder')
           -- Misma categoría pero NO son encuestas: el aviso al coach («sesión
           -- sin cerrar») y el resumen al acudiente que YA respondió (kind =
           -- 'daily_recap'). La versión anterior le recordaba «Todavía no
           -- respondes» a quien ya había respondido (65 casos 09-16→10-24).
           AND NOT (n.data ? 'coach_reminder')
           AND NOT (n.data ? 'kind')
           -- Antes solo las de hoy: la que llega de noche (cierre de las 23:55)
           -- se quedaba sin recordatorio. El chequeo de abajo evita duplicar.
           AND (n.created_at AT TIME ZONE 'America/Bogota')::date >= v_hoy - 1
           AND s.finalized IS TRUE
           AND now() < public.post_training_plazo_respuesta(GREATEST(s.finalized_at, s.updated_at))
    LOOP
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.performance_entries pe
             WHERE pe.context_type = 'session'
               AND pe.context_id = (v_rec.data ->> 'session_id')::uuid
               AND pe.metric_key = 'rpe_borg'
               AND ((v_rec.data ->> 'child_id' IS NOT NULL
                     AND pe.subject_type = 'child' AND pe.subject_id = (v_rec.data ->> 'child_id')::uuid)
                 OR (v_rec.data ->> 'user_id_athlete' IS NOT NULL
                     AND pe.subject_type = 'profile' AND pe.subject_id = (v_rec.data ->> 'user_id_athlete')::uuid))
        );

        CONTINUE WHEN EXISTS (
            SELECT 1 FROM public.notifications r
             WHERE r.category = 'post_training' AND r.user_id = v_rec.user_id
               AND r.data ->> 'session_id' = v_rec.data ->> 'session_id'
               AND r.data ->> 'child_id' IS NOT DISTINCT FROM v_rec.data ->> 'child_id'
               AND r.data ->> 'user_id_athlete' IS NOT DISTINCT FROM v_rec.data ->> 'user_id_athlete'
               AND r.data ? 'reminder'
        );

        INSERT INTO public.notifications (user_id, title, message, type, category, data, link)
        VALUES (
            v_rec.user_id,
            'Todavía no respondes la encuesta del entreno',
            'Un segundo y listo: cuéntanos cómo se sintió en el entrenamiento. Tienes hasta '
                || CASE WHEN v_rec.ultimo_dia <= v_hoy THEN 'hoy a la medianoche.' ELSE 'mañana.' END,
            'info', 'post_training',
            v_rec.data || jsonb_build_object('reminder', true),
            '/post-entreno/' || (v_rec.data ->> 'session_id')
                || CASE WHEN v_rec.data ->> 'child_id' IS NOT NULL
                        THEN '?child_id=' || (v_rec.data ->> 'child_id') ELSE '' END
        );
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.post_training_send_parent_reminders_system() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_training_send_parent_reminders_system() TO service_role;

COMMIT;
