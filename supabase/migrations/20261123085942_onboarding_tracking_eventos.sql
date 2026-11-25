-- ============================================================================
-- Onboarding · Etapa 1 · Tracking básico en analytics_events (hallazgo G)
--
-- La tabla analytics_events existía y nadie escribía en ella (0 filas, medido el
-- 2026-11-23). OJO: en producción anon y authenticated tenían INSERT, UPDATE y
-- DELETE sobre ella, y la política analytics_events_insert aceptaba
-- (user_id = auth.uid() OR user_id IS NULL): cualquiera, incluso sin sesión,
-- podía insertar filas ilimitadas con cualquier tipo de evento. Un embudo que se
-- puede falsificar no sirve, y es un vector de llenado de disco. Esta migración
-- lo cierra (sección 0) antes de empezar a escribir. Radio medido: tabla vacía y
-- ningún código del repo escribe en ella (el BFF usa service_role, que conserva
-- sus permisos); las lecturas (políticas SELECT) no cambian.
--
-- Los eventos entran por dos vías, ambas SECURITY DEFINER:
--
--  1. RPC track_onboarding_event(): los 4 eventos del asistente que solo el
--     navegador conoce (paso visto / completado / saltado / terminado). Lista
--     cerrada de eventos y de flujos, paso con formato fijo, `extra` reducido a
--     escalares, tope de 60 por usuario y minuto. Sin datos personales.
--
--  2. Triggers de hito, uno por EVENTO y por ESCUELA. Cubren todos los caminos
--     que crean esos registros (BFF, RPC, asistente, importaciones) sin depender
--     de que cada pantalla se acuerde de reportar:
--        signup_completed          profiles AFTER INSERT (por fila)
--        first_plan_created        offering_plans   (por sentencia)
--        first_athlete_created     children         (por sentencia)
--        first_charge_created      payments         (por sentencia)
--        payment_method_configured school_settings  (INSERT y UPDATE)
--        whatsapp_connected        school_whatsapp_integrations
--     «Primero» significa que la escuela NO tenía antes ninguna fila de ese tipo:
--     una academia con años de operación no genera un «primer cobro» falso la
--     próxima vez que cobre. Los triggers por sentencia (tablas de transición)
--     hacen UNA consulta por INSERT, no una por fila: open_month inserta miles de
--     cobros de golpe.
--
-- Garantías: ningún trigger puede romper la escritura de negocio (cada cuerpo
-- atrapa cualquier error y sigue), y ninguna función de esta migración es
-- ejecutable por anon; solo la RPC lo es por authenticated.
--
-- Orden de aplicación: después de 20261123084254 (usa _school_has_payment_method).
-- ============================================================================

BEGIN;

-- ── 0. Cerrar la escritura directa ──────────────────────────────────────────
REVOKE INSERT, UPDATE, DELETE ON public.analytics_events FROM anon, authenticated;
-- Sin grant la política ya no se evalúa, pero dejarla es una trampa si un default
-- privilege vuelve a otorgar el INSERT: se retira. Las dos SELECT se quedan.
DROP POLICY IF EXISTS analytics_events_insert ON public.analytics_events;

-- ── Predicado de «medio de cobro» por FILA, para poder comparar OLD vs NEW ──
CREATE OR REPLACE FUNCTION public._settings_has_payment_method(ss public.school_settings)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT (
            NULLIF(btrim(ss.bank_name), '') IS NOT NULL
        AND NULLIF(btrim(ss.bank_account_number), '') IS NOT NULL
    )
    OR NULLIF(btrim(ss.nequi_number), '') IS NOT NULL
    OR NULLIF(btrim(ss.breb_key), '') IS NOT NULL
    OR NULLIF(btrim(ss.breb_number), '') IS NOT NULL
    OR (jsonb_typeof(ss.payment_accounts) = 'array'
        AND jsonb_array_length(ss.payment_accounts) > 0);
$$;

REVOKE ALL ON FUNCTION public._settings_has_payment_method(public.school_settings) FROM PUBLIC, anon, authenticated;

-- Una sola definición del criterio (la de 20261123084254 se reemplaza por esta).
CREATE OR REPLACE FUNCTION public._school_has_payment_method(p_school_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.school_settings ss
         WHERE ss.school_id = p_school_id
           AND public._settings_has_payment_method(ss)
    );
$$;

REVOKE ALL ON FUNCTION public._school_has_payment_method(uuid) FROM PUBLIC, anon, authenticated;

-- ¿Ya se registró este hito para esta escuela?
CREATE OR REPLACE FUNCTION public._analytics_hito_registrado(p_type text, p_school_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.analytics_events e
         WHERE e.event_type = p_type
           AND e.event_data @> jsonb_build_object('school_id', p_school_id)
    );
$$;

REVOKE ALL ON FUNCTION public._analytics_hito_registrado(text, uuid) FROM PUBLIC, anon, authenticated;

-- ── 1. RPC del asistente ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.track_onboarding_event(
    p_event_type text,
    p_flow       text,
    p_step       text DEFAULT NULL,
    p_extra      jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid    uuid := auth.uid();
    v_school uuid;
    v_data   jsonb;
    v_k      text;
    v_v      jsonb;
    v_n      int := 0;
BEGIN
    -- Es telemetría: nunca debe romper la pantalla. Lo inválido se ignora en silencio.
    IF v_uid IS NULL THEN RETURN; END IF;
    IF p_event_type NOT IN ('onboarding_step_viewed', 'onboarding_step_completed',
                            'onboarding_step_skipped', 'onboarding_finished') THEN RETURN; END IF;
    IF p_flow NOT IN ('school', 'venue', 'parent') THEN RETURN; END IF;
    IF p_step IS NOT NULL AND p_step !~ '^[a-z0-9_]{1,40}$' THEN RETURN; END IF;
    IF p_event_type <> 'onboarding_finished' AND p_step IS NULL THEN RETURN; END IF;

    -- Tope por usuario: un cliente roto o malicioso no llena la tabla.
    IF (SELECT count(*) FROM public.analytics_events e
         WHERE e.user_id = v_uid
           AND e.created_at > now() - interval '1 minute'
           AND e.event_type LIKE 'onboarding\_%') >= 60 THEN
        RETURN;
    END IF;

    v_data := jsonb_build_object('flow', p_flow);
    IF p_step IS NOT NULL THEN v_data := v_data || jsonb_build_object('step', p_step); END IF;

    -- `extra`: solo escalares cortos, máximo 8 claves con formato fijo.
    IF p_extra IS NOT NULL AND jsonb_typeof(p_extra) = 'object' THEN
        FOR v_k, v_v IN SELECT * FROM jsonb_each(p_extra) LOOP
            EXIT WHEN v_n >= 8;
            CONTINUE WHEN v_k !~ '^[a-z_]{1,30}$' OR v_k IN ('flow', 'step', 'school_id');
            IF jsonb_typeof(v_v) = 'string' THEN
                v_data := v_data || jsonb_build_object(v_k, left(v_v #>> '{}', 40));
                v_n := v_n + 1;
            ELSIF jsonb_typeof(v_v) IN ('number', 'boolean') THEN
                v_data := v_data || jsonb_build_object(v_k, v_v);
                v_n := v_n + 1;
            END IF;
        END LOOP;
    END IF;

    -- La escuela del propio usuario (si es dueño), para poder cruzar el embudo.
    SELECT s.id INTO v_school
      FROM public.schools s
     WHERE s.owner_id = v_uid
     ORDER BY s.created_at DESC
     LIMIT 1;
    IF v_school IS NOT NULL THEN
        v_data := v_data || jsonb_build_object('school_id', v_school);
    END IF;

    INSERT INTO public.analytics_events (user_id, event_type, event_data)
    VALUES (v_uid, p_event_type, v_data);
EXCEPTION WHEN others THEN
    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.track_onboarding_event(text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.track_onboarding_event(text, text, text, jsonb) TO authenticated;

-- ── 2. Triggers de hito ─────────────────────────────────────────────────────

-- signup_completed: una fila por cuenta nueva (correo, Google o invitación).
CREATE OR REPLACE FUNCTION public.fn_analytics_signup_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_provider text;
BEGIN
    BEGIN
        SELECT u.raw_app_meta_data ->> 'provider' INTO v_provider
          FROM auth.users u WHERE u.id = NEW.id;
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        VALUES (NEW.id, 'signup_completed', jsonb_build_object(
            'role',            NEW.role::text,
            'provider',        COALESCE(v_provider, 'unknown'),
            'with_code',       NULLIF(btrim(COALESCE(NEW.invitation_code, '')), '') IS NOT NULL,
            'needs_role',      COALESCE(NEW.needs_role_selection, false)
        ));
    EXCEPTION WHEN others THEN
        NULL; -- jamás romper el alta de una cuenta por una métrica
    END;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_signup_completed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_signup_completed ON public.profiles;
CREATE TRIGGER trg_analytics_signup_completed
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.fn_analytics_signup_completed();

-- first_plan_created
CREATE OR REPLACE FUNCTION public.fn_analytics_first_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'first_plan_created', jsonb_build_object('school_id', s.id)
          FROM (SELECT DISTINCT school_id FROM nt WHERE school_id IS NOT NULL) n
          JOIN public.schools s ON s.id = n.school_id
         WHERE NOT EXISTS (SELECT 1 FROM public.offering_plans p
                            WHERE p.school_id = n.school_id AND p.id NOT IN (SELECT id FROM nt))
           AND NOT public._analytics_hito_registrado('first_plan_created', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_first_plan() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_first_plan ON public.offering_plans;
CREATE TRIGGER trg_analytics_first_plan
    AFTER INSERT ON public.offering_plans
    REFERENCING NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_first_plan();

-- first_athlete_created
CREATE OR REPLACE FUNCTION public.fn_analytics_first_athlete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'first_athlete_created', jsonb_build_object('school_id', s.id)
          FROM (SELECT DISTINCT school_id FROM nt WHERE school_id IS NOT NULL) n
          JOIN public.schools s ON s.id = n.school_id
         WHERE NOT EXISTS (SELECT 1 FROM public.children c
                            WHERE c.school_id = n.school_id AND c.id NOT IN (SELECT id FROM nt))
           AND NOT public._analytics_hito_registrado('first_athlete_created', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_first_athlete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_first_athlete ON public.children;
CREATE TRIGGER trg_analytics_first_athlete
    AFTER INSERT ON public.children
    REFERENCING NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_first_athlete();

-- first_charge_created
CREATE OR REPLACE FUNCTION public.fn_analytics_first_charge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'first_charge_created', jsonb_build_object('school_id', s.id)
          FROM (SELECT DISTINCT school_id FROM nt WHERE school_id IS NOT NULL) n
          JOIN public.schools s ON s.id = n.school_id
         WHERE NOT EXISTS (SELECT 1 FROM public.payments p
                            WHERE p.school_id = n.school_id AND p.id NOT IN (SELECT id FROM nt))
           AND NOT public._analytics_hito_registrado('first_charge_created', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_first_charge() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_first_charge ON public.payments;
CREATE TRIGGER trg_analytics_first_charge
    AFTER INSERT ON public.payments
    REFERENCING NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_first_charge();

-- payment_method_configured: INSERT con medio, o UPDATE de «sin medio» a «con medio».
CREATE OR REPLACE FUNCTION public.fn_analytics_payment_method_ins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'payment_method_configured', jsonb_build_object('school_id', s.id)
          FROM nt n
          JOIN public.schools s ON s.id = n.school_id
         WHERE public._settings_has_payment_method(n)
           AND NOT public._analytics_hito_registrado('payment_method_configured', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_payment_method_ins() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_analytics_payment_method_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'payment_method_configured', jsonb_build_object('school_id', s.id)
          FROM nt n
          JOIN ot o ON o.school_id = n.school_id
          JOIN public.schools s ON s.id = n.school_id
         WHERE public._settings_has_payment_method(n)
           AND NOT public._settings_has_payment_method(o)
           AND NOT public._analytics_hito_registrado('payment_method_configured', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_payment_method_upd() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_payment_method_ins ON public.school_settings;
CREATE TRIGGER trg_analytics_payment_method_ins
    AFTER INSERT ON public.school_settings
    REFERENCING NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_payment_method_ins();

DROP TRIGGER IF EXISTS trg_analytics_payment_method_upd ON public.school_settings;
CREATE TRIGGER trg_analytics_payment_method_upd
    AFTER UPDATE ON public.school_settings
    REFERENCING OLD TABLE AS ot NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_payment_method_upd();

-- whatsapp_connected: primera integración activa de la escuela.
CREATE OR REPLACE FUNCTION public.fn_analytics_whatsapp_ins()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'whatsapp_connected', jsonb_build_object('school_id', s.id)
          FROM (SELECT DISTINCT school_id FROM nt WHERE status = 'active' AND school_id IS NOT NULL) n
          JOIN public.schools s ON s.id = n.school_id
         WHERE NOT EXISTS (SELECT 1 FROM public.school_whatsapp_integrations i
                            WHERE i.school_id = n.school_id AND i.id NOT IN (SELECT id FROM nt))
           AND NOT public._analytics_hito_registrado('whatsapp_connected', n.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_whatsapp_ins() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_analytics_whatsapp_upd()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    BEGIN
        INSERT INTO public.analytics_events (user_id, event_type, event_data)
        SELECT s.owner_id, 'whatsapp_connected', jsonb_build_object('school_id', s.id)
          FROM (SELECT DISTINCT n.school_id
                  FROM nt n JOIN ot o ON o.id = n.id
                 WHERE n.status = 'active' AND o.status IS DISTINCT FROM 'active'
                   AND n.school_id IS NOT NULL) x
          JOIN public.schools s ON s.id = x.school_id
         WHERE NOT EXISTS (SELECT 1 FROM public.school_whatsapp_integrations i
                            WHERE i.school_id = x.school_id AND i.status = 'active'
                              AND i.id NOT IN (SELECT id FROM nt))
           AND NOT public._analytics_hito_registrado('whatsapp_connected', x.school_id);
    EXCEPTION WHEN others THEN
        NULL;
    END;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_analytics_whatsapp_upd() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_analytics_whatsapp_ins ON public.school_whatsapp_integrations;
CREATE TRIGGER trg_analytics_whatsapp_ins
    AFTER INSERT ON public.school_whatsapp_integrations
    REFERENCING NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_whatsapp_ins();

DROP TRIGGER IF EXISTS trg_analytics_whatsapp_upd ON public.school_whatsapp_integrations;
CREATE TRIGGER trg_analytics_whatsapp_upd
    AFTER UPDATE ON public.school_whatsapp_integrations
    REFERENCING OLD TABLE AS ot NEW TABLE AS nt
    FOR EACH STATEMENT EXECUTE FUNCTION public.fn_analytics_whatsapp_upd();

COMMIT;
