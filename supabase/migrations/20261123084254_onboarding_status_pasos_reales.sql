-- ============================================================================
-- Onboarding · Etapa 1 · Hallazgos B, C, D (y la base de E)
-- get_onboarding_status() marcaba pasos por señales que no correspondían a lo
-- que el asistente hace. Se reemite la función SIN ARGUMENTOS partiendo de su
-- definición viva (leída de pg_proc el 2026-11-23); las claves que ya existían
-- conservan el nombre. La variante get_onboarding_status(uuid) no se toca.
--
--   B  `has_branches` es true desde que nace la escuela (el trigger crea la
--      «Sede Principal»), así que «Tu sede» nunca se mostraba y la dirección no
--      se capturaba. Se agrega `branch_confirmed`: la sede principal tiene
--      dirección. `has_branches` queda igual para no cambiarle el sentido a
--      quien ya la lee.
--   C  `payment_setup_completed` exigía banco + número de cuenta, pero el
--      asistente acepta solo Nequi o solo Bre-B. Ahora basta cualquier medio.
--   D  `has_staff` miraba school_members; el asistente escribe en school_staff.
--      Ahora cuenta cualquiera de las dos.
--   E  Se agrega `has_charges` (la escuela ya tiene al menos un cobro): el
--      checklist del panel se muestra hasta ese momento.
--   +  `has_students` también cuenta inscripciones: un adulto sin cuenta no es
--      fila de `children` y el paso quedaba sin marcar.
--
-- CREATE OR REPLACE conserva dueño y permisos (hoy: authenticated y
-- service_role). El GRANT se repite por la regla del repo.
-- ============================================================================

BEGIN;

-- ¿La escuela tiene al menos un medio para recibir pagos? Una sola definición,
-- compartida por get_onboarding_status y por el evento payment_method_configured.
-- Solo la llaman funciones SECURITY DEFINER: sin EXECUTE para nadie más.
CREATE OR REPLACE FUNCTION public._school_has_payment_method(p_school_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.school_settings ss
         WHERE ss.school_id = p_school_id
           AND (
                (NULLIF(btrim(ss.bank_name), '') IS NOT NULL
                 AND NULLIF(btrim(ss.bank_account_number), '') IS NOT NULL)
             OR NULLIF(btrim(ss.nequi_number), '') IS NOT NULL
             OR NULLIF(btrim(ss.breb_key), '') IS NOT NULL
             OR NULLIF(btrim(ss.breb_number), '') IS NOT NULL
             OR (jsonb_typeof(ss.payment_accounts) = 'array'
                 AND jsonb_array_length(ss.payment_accounts) > 0)
           )
    );
$$;

REVOKE ALL ON FUNCTION public._school_has_payment_method(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_onboarding_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role public.user_role;
  v_school_id uuid;
  v_email_verified boolean;
  v_result jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_user_id;

  v_email_verified := (auth.jwt() ->> 'email_confirmed_at') IS NOT NULL;

  SELECT school_id INTO v_school_id
    FROM public.school_members
   WHERE profile_id = v_user_id
     AND status = 'active'
    ORDER BY joined_at DESC
    LIMIT 1;

  SELECT jsonb_build_object(
    'role', v_role,
    'school_id', v_school_id,
    'email_verified', v_email_verified,

    'onboarding_status', (
        SELECT onboarding_status FROM public.schools
         WHERE id = v_school_id OR owner_id = v_user_id
         ORDER BY created_at DESC LIMIT 1
    ),

    'business_model', (
        SELECT business_model FROM public.schools
         WHERE id = v_school_id OR owner_id = v_user_id
         ORDER BY created_at DESC LIMIT 1
    ),

    'profile_complete', (
        SELECT (
            full_name IS NOT NULL AND full_name != 'Usuario' AND
            phone IS NOT NULL AND
            date_of_birth IS NOT NULL AND
            (role != 'athlete' OR (bio IS NOT NULL OR (sports_interests IS NOT NULL AND array_length(sports_interests, 1) > 0)))
        )
        FROM public.profiles
        WHERE id = v_user_id
    ),
    'has_avatar', (SELECT EXISTS(SELECT 1 FROM public.profiles WHERE id = v_user_id AND avatar_url IS NOT NULL)),

    'has_pending_invitation', (SELECT EXISTS(SELECT 1 FROM public.school_members WHERE profile_id = v_user_id AND status = 'pending')),
    'has_accepted_invite',    (SELECT EXISTS(SELECT 1 FROM public.school_members WHERE profile_id = v_user_id AND status = 'active')),

    'has_children',          (SELECT EXISTS(SELECT 1 FROM public.children WHERE parent_id = v_user_id)),
    'has_medical_records',   (SELECT EXISTS(SELECT 1 FROM public.children c WHERE c.parent_id = v_user_id AND c.medical_info IS NOT NULL)),
    'has_enrollment', (
        SELECT EXISTS(
            SELECT 1 FROM public.enrollments e
            WHERE e.child_id IN (SELECT id FROM public.children WHERE parent_id = v_user_id)
              AND e.status = 'active'
        ) OR EXISTS(
            SELECT 1 FROM public.enrollments e
            WHERE e.user_id = v_user_id AND e.status = 'active'
        )
    ),

    'has_school',                (SELECT EXISTS(SELECT 1 FROM public.schools WHERE owner_id = v_user_id)),
    'has_branches', (
        SELECT EXISTS(
            SELECT 1 FROM public.school_branches b JOIN public.schools s ON b.school_id = s.id
             WHERE s.owner_id = v_user_id OR s.id = v_school_id
        )
    ),
    -- B: la sede principal ya tiene dirección (lo que el paso «Tu sede» pide).
    'branch_confirmed', (
        SELECT EXISTS(
            SELECT 1 FROM public.school_branches b JOIN public.schools s ON b.school_id = s.id
             WHERE (s.owner_id = v_user_id OR s.id = v_school_id)
               AND b.is_main = true
               AND NULLIF(btrim(b.address), '') IS NOT NULL
        )
    ),
    'has_teams', (
        SELECT EXISTS(
            SELECT 1 FROM public.teams
             WHERE school_id = v_school_id
                OR (v_school_id IS NULL AND school_id IN (SELECT id FROM public.schools WHERE owner_id = v_user_id))
        )
    ),
    'has_plans', (
        SELECT EXISTS(
            SELECT 1
              FROM public.offering_plans op
             WHERE op.is_active = true
               AND (op.school_id = v_school_id
                    OR (v_school_id IS NULL AND op.school_id IN (SELECT id FROM public.schools WHERE owner_id = v_user_id)))
        )
    ),
    -- D: el asistente invita al entrenador en school_staff; la membresía solo
    -- aparece cuando el entrenador se registra y acepta.
    'has_staff', (
        SELECT EXISTS(SELECT 1 FROM public.school_members WHERE school_id = v_school_id AND role IN ('coach', 'admin'))
            OR EXISTS(SELECT 1 FROM public.school_staff st WHERE st.school_id = v_school_id)
    ),
    'has_professional_profile', (SELECT EXISTS(SELECT 1 FROM public.coach_profiles WHERE id = v_user_id AND profile_completed = true)),

    'has_students', (
        SELECT EXISTS(
            SELECT 1 FROM public.children
            WHERE school_id = v_school_id
            OR (v_school_id IS NULL AND school_id IN (SELECT id FROM public.schools WHERE owner_id = v_user_id))
        ) OR EXISTS(
            SELECT 1 FROM public.enrollments e WHERE e.school_id = v_school_id
        )
    ),
    -- C: basta un medio de cobro (Nequi, Bre-B, cuenta bancaria o una llave en
    -- payment_accounts), que es lo que el asistente acepta.
    'payment_setup_completed', public._school_has_payment_method(v_school_id),
    -- E: el checklist del panel acompaña a la escuela hasta su primer cobro.
    'has_charges', (SELECT EXISTS(SELECT 1 FROM public.payments p WHERE p.school_id = v_school_id)),

    'has_sports_interest', (
        SELECT (
            (bio IS NOT NULL AND length(bio) > 10) OR
            (sports_interests IS NOT NULL AND array_length(sports_interests, 1) > 0)
        )
        FROM public.profiles
        WHERE id = v_user_id
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_onboarding_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_status() TO authenticated;

COMMIT;
