-- =============================================================================
-- 20261105213545_rubrica_na_entrenadores.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105212701
-- Objetivo: «No aplica» (N/A) en la evaluación de entrenadores (plan
--   docs/plan-evaluaciones-na-f1.md, F1a). N/A no cuenta en el promedio.
--   · school_settings.rubric_allow_na (default false). NO se enciende ninguna
--     escuela aquí (Carmel se enciende en una migración aparte).
--   · v_school_entitlements: copia de la definición de 20261014153542 (última
--     que la redefine) + rubric_allow_na AL FINAL (posición 42).
--   · coach_evaluation_scores: not_applicable + score nullable + CHECK de coherencia.
--   · save_coach_evaluation: misma firma y cuerpo de 20261029191217 (gate,
--     duplicados, aviso a /mis-evaluaciones) + N/A, gate por flag y promedio
--     solo de aplicables. Publicar exige >= 1 ítem con nota.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS rubric_allow_na boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.school_settings.rubric_allow_na IS
  '«No aplica» en las rúbricas (evaluación de entrenadores y rúbrica del mesociclo); no cuenta en el promedio.';

-- Vista: idéntica a 20261014153542 + rubric_allow_na al final.
CREATE OR REPLACE VIEW public.v_school_entitlements
WITH (security_invoker = true) AS
 SELECT s.id AS school_id,
    s.school_type,
    COALESCE(sub.plan_code, 'starter'::text) AS plan_code,
    COALESCE(sub.tier, 'free'::text) AS tier,
    COALESCE(sub.status, 'trialing'::text) AS subscription_status,
    COALESCE(sub.trial_ends_at, s.created_at + '1 mon'::interval) AS trial_ends_at,
    sub.current_period_start,
    sub.current_period_end,
    sub.billing_cycle,
    s.school_type IS NULL OR (s.school_type = ANY (ARRAY['academy'::text, 'hybrid'::text, 'club'::text, 'escuela'::text, 'gimnasio'::text, 'personal_trainer'::text])) AS has_academy,
    (s.school_type = 'venue'::text OR (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'reservations'::text AND a.enabled))) AS has_reservations,
    (s.school_type = 'venue'::text OR (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'reservations'::text AND a.enabled))) AS has_wallet,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'tournaments'::text AND a.enabled)) AS has_tournaments,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'access_control'::text AND a.enabled)) AS has_access_control,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'biomech'::text AND a.enabled)) AS has_biomech,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'nutrition'::text AND a.enabled)) AS has_nutrition,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'whitelabel'::text AND a.enabled)) AS has_whitelabel,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'whatsapp'::text AND a.enabled)) AS has_whatsapp,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'wompi'::text AND a.enabled)) AS has_wompi,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'mp'::text AND a.enabled)) AS has_mp,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'store'::text AND a.enabled)) AS has_store,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'accounting'::text AND a.enabled)) AS has_accounting,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'invoicing'::text AND a.enabled)) AS has_invoicing,
    s.created_at AS school_created_at,
    s.account_type,
    sub.school_id IS NOT NULL AS has_subscription_row,
    sub.trial_months,
    COALESCE(sub.blocking_exempt, false) AS blocking_exempt,
    sub.blocking_exempt_reason,
    school_is_operational(s.id) AS is_operational,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND (a.addon_key = ANY (ARRAY['pwa_branding'::text, 'whitelabel'::text])) AND a.enabled)) AS has_pwa_branding,
    COALESCE(sset.billing_enabled, true) AS has_billing,
    ( SELECT jsonb_object_agg(m.module_key, m.enabled) AS jsonb_object_agg
           FROM school_module_overrides m
          WHERE m.school_id = s.id) AS module_overrides,
    COALESCE(sset.coach_can_create_athletes, false) AS coach_can_create_athletes,
    COALESCE(sset.coach_can_create_teams, false) AS coach_can_create_teams,
    COALESCE(sset.parent_email_optional, false) AS parent_email_optional,
    COALESCE(sset.coach_hide_financial_info, false) AS coach_hide_financial_info,
    COALESCE(sset.coach_can_edit_categories, false) AS coach_can_edit_categories,
    COALESCE(sset.military_discount_enabled, false) AS military_discount_enabled,
    COALESCE(sset.allow_secondary_team_enrollment, false) AS allow_secondary_team_enrollment,
    COALESCE(sset.coach_attendance_retro_days, 7) AS coach_attendance_retro_days,
    COALESCE(sset.rubric_allow_na, false) AS rubric_allow_na
   FROM schools s
     LEFT JOIN school_subscriptions sub ON sub.school_id = s.id
     LEFT JOIN school_settings sset ON sset.school_id = s.id;

ALTER VIEW public.v_school_entitlements SET (security_invoker = true);

ALTER TABLE public.coach_evaluation_scores
  ADD COLUMN IF NOT EXISTS not_applicable boolean NOT NULL DEFAULT false;
ALTER TABLE public.coach_evaluation_scores ALTER COLUMN score DROP NOT NULL;
ALTER TABLE public.coach_evaluation_scores DROP CONSTRAINT IF EXISTS coach_evaluation_scores_score_check;
ALTER TABLE public.coach_evaluation_scores DROP CONSTRAINT IF EXISTS coach_evaluation_scores_na_score_check;
ALTER TABLE public.coach_evaluation_scores
  ADD CONSTRAINT coach_evaluation_scores_na_score_check
  CHECK ((not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 5));

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
    v_na         integer;   -- NUEVO
    v_app        integer;   -- NUEVO
    v_allow_na   boolean;   -- NUEVO
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

    -- NUEVO: cuántos N/A y cuántos con nota.
    SELECT count(*) FILTER (WHERE COALESCE(s.not_applicable, false)),
           count(*) FILTER (WHERE NOT COALESCE(s.not_applicable, false))
      INTO v_na, v_app
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text);

    -- NUEVO: el flag solo se lee si vino algún N/A.
    IF v_na > 0 THEN
        SELECT COALESCE(ss.rubric_allow_na, false) INTO v_allow_na
          FROM public.school_settings ss WHERE ss.school_id = v_school;
        IF NOT COALESCE(v_allow_na, false) THEN
            RAISE EXCEPTION 'La opción «No aplica» no está habilitada para esta escuela.' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- CAMBIA: nota 1-5 si aplica; sin nota si es N/A.
    SELECT count(*) INTO v_bad
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text)
      LEFT JOIN public.coach_evaluation_criteria c
        ON c.id = s.criterion_id AND c.school_id = v_school
     WHERE c.id IS NULL
        OR (COALESCE(s.not_applicable, false) AND s.score IS NOT NULL)
        OR (NOT COALESCE(s.not_applicable, false) AND (s.score IS NULL OR s.score NOT BETWEEN 1 AND 5));
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Hay ítems que no son de la escuela, notas fuera de 1 a 5 o «No aplica» con nota.' USING ERRCODE = '22023';
    END IF;

    SELECT count(*) - count(DISTINCT s.criterion_id) INTO v_n
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid);
    IF v_n > 0 THEN
        RAISE EXCEPTION 'Un ítem aparece dos veces.' USING ERRCODE = '22023';
    END IF;

    -- NUEVO: publicar exige al menos un ítem con nota (todo N/A solo como borrador).
    IF p_publish AND v_app = 0 THEN
        RAISE EXCEPTION 'Para publicar necesitas al menos un ítem con nota (todo en «No aplica» solo sirve como borrador).' USING ERRCODE = '22023';
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
    INSERT INTO public.coach_evaluation_scores (evaluation_id, criterion_id, criterion_name, score, not_applicable, comment)
    SELECT v_id, s.criterion_id, c.name,
           CASE WHEN COALESCE(s.not_applicable, false) THEN NULL ELSE s.score END,
           COALESCE(s.not_applicable, false),
           NULLIF(btrim(COALESCE(s.comment, '')), '')
      FROM jsonb_to_recordset(p_scores) AS s(criterion_id uuid, score int, not_applicable boolean, comment text)
      JOIN public.coach_evaluation_criteria c ON c.id = s.criterion_id;

    -- CAMBIA: promedio solo de lo aplicable (NULL si no hay).
    SELECT round((avg(score) FILTER (WHERE NOT not_applicable))::numeric, 2) INTO v_score
      FROM public.coach_evaluation_scores WHERE evaluation_id = v_id;
    UPDATE public.coach_evaluations SET overall_score = v_score WHERE id = v_id;

    -- Aviso al entrenador: primera publicación y solo si tiene cuenta.
    -- (v_score nunca es NULL aquí: publicar exige v_app >= 1.)
    IF p_publish AND COALESCE(v_prev, 'borrador') = 'borrador' AND v_coach_user IS NOT NULL THEN
        BEGIN
            SELECT name INTO v_school_nm FROM public.schools WHERE id = v_school;
            INSERT INTO public.notifications (user_id, school_id, type, category, title, message, link, data)
            VALUES (
                v_coach_user, v_school, 'info', 'system',
                '⭐ Tienes una evaluación nueva',
                COALESCE(NULLIF(btrim(v_school_nm), ''), 'Tu escuela') || ' publicó tu evaluación del '
                  || to_char(p_period_start, 'DD/MM/YYYY') || ' al ' || to_char(v_end, 'DD/MM/YYYY')
                  || ': ' || to_char(v_score, 'FM0.0') || ' de 5'
                  || CASE WHEN v_na > 0 THEN ' (' || v_app || ' de ' || (v_app + v_na) || ' ítems)' ELSE '' END
                  || '.',
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

REVOKE ALL ON FUNCTION public.save_coach_evaluation(uuid,text,date,jsonb,text,text,text,text,jsonb,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_coach_evaluation(uuid,text,date,jsonb,text,text,text,text,jsonb,boolean) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
