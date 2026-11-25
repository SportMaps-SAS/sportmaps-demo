-- =============================================================================
-- 20261124173412_saas_periodo_dia_1.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-24   Versión anterior: 20261124152343
-- Objetivo: la facturación SaaS (SportMaps → escuelas) va SIEMPRE del 1 al 1.
-- =============================================================================
-- Por qué: Besser quedó facturando del 15 al 15 porque el panel aceptaba
-- cualquier fecha en «Reiniciar período desde». Se corrigió a mano el
-- 2026-11-24 (su SM-2026-00003 cubre 15-nov → 1-ene). Tres caminos dejaban
-- fechas a mitad de mes:
--   1. admin_set_school_custom_price(p_period_start) aceptaba cualquier día.
--   2. Activar la facturación sin período fijado: la primera factura
--      arrancaba el día de la activación (COALESCE(..., CURRENT_DATE)).
--   3. admin_reactivate_school reiniciaba el período en now().
--
-- Decisión del usuario (2026-11-24, opción A): los días sueltos entre la
-- activación y el primer día 1 NO se cobran; la primera factura arranca el 1
-- siguiente. Si el trato es cobrar el mes en curso completo, el panel deja
-- elegir ese mes.
--
-- Cambios:
--   A. generate_school_subscription_invoice
--      · Inicio = primer día 1 en o después de la base. Base = la MAYOR entre
--        el fin de la última factura viva y current_period_start; si no hay
--        ninguna, hoy (hora Colombia). Antes ganaba siempre la última
--        factura, así que «Reiniciar período desde» y la reactivación no
--        movían nada si la escuela ya tenía facturas.
--      · Al insertar la factura, si el ciclo es mensual, deja
--        current_period_start/end iguales a la factura. Antes no los tocaba:
--        una escuela activada solo con el interruptor (período NULL) nunca
--        recibía la segunda factura, porque run_saas_billing_cycle solo
--        avanza filas con current_period_end; y si período y factura no
--        coincidían, la siguiente salía en otra fecha. Los ciclos no
--        mensuales (GYM RM, semestral) no se tocan: el ciclo diario no los
--        procesa y es otro problema.
--   B. admin_set_school_custom_price: p_period_start debe ser día 1 (22023).
--   C. admin_reactivate_school: el período arranca el primer día 1 en o
--      después de hoy.
--   D. Candado en la tabla: toda factura creada desde el 2026-11-24 empieza y
--      termina en día 1. Corte por created_at y NO con NOT VALID: un
--      NOT VALID se revalida en cada UPDATE, y el recordatorio diario
--      actualiza facturas viejas (Academia Superior, 2-oct → 2-nov): el
--      ciclo entero de todas las escuelas fallaría.
--
-- Fechas en hora de Colombia explícita ('America/Bogota') en vez de depender
-- del TimeZone de la sesión.
--
-- Firmas y dueños iguales: CREATE OR REPLACE conserva los GRANT; igual se
-- reafirman abajo con los mismos que tiene la base viva (2026-11-24).
-- No cambia types.ts.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ============================================================================
-- A. Generador de facturas
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_school_subscription_invoice(p_school_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_sub            public.school_subscriptions%ROWTYPE;
    v_plan_cents     integer;
    v_addons_cents   integer;
    v_items          jsonb;
    v_period_start   date;
    v_period_end     date;
    v_due_date       date;
    v_invoice_id     uuid;
    v_invoice_number text;
    v_seq            integer;
    v_ultimo_fin     date;
    -- ACUERDO:
    v_step_cents     integer;
    v_one_cents      integer;
    v_one_items      jsonb;
    -- DÍA 1:
    v_base           date;
BEGIN
    IF NOT (
        public.is_super_admin()
        OR auth.role() = 'service_role'
        OR session_user IN ('postgres', 'supabase_admin')
    ) THEN
        RAISE EXCEPTION 'solo super_admin o el proceso del BFF pueden generar facturas SaaS' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_sub
      FROM public.school_subscriptions
     WHERE school_id = p_school_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'la escuela % no tiene fila en school_subscriptions', p_school_id
            USING ERRCODE = '23503';
    END IF;

    SELECT MAX(period_end) INTO v_ultimo_fin
      FROM public.school_subscription_invoices
     WHERE school_id = p_school_id AND status <> 'cancelled';

    -- DÍA 1: la base es la mayor entre el fin de la última factura viva y el
    -- inicio del período vigente (GREATEST ignora NULL); sin ninguna, hoy.
    v_base := COALESCE(
        GREATEST(v_ultimo_fin, (v_sub.current_period_start AT TIME ZONE 'America/Bogota')::date),
        (now() AT TIME ZONE 'America/Bogota')::date
    );
    -- DÍA 1: el período arranca el primer día 1 en o después de la base. Los
    -- días sueltos antes de ese 1 no se cobran (decisión 2026-11-24).
    v_period_start := CASE WHEN extract(day FROM v_base) = 1
                           THEN v_base
                           ELSE (date_trunc('month', v_base) + INTERVAL '1 month')::date
                      END;
    v_period_end   := (v_period_start + INTERVAL '1 month')::date;
    -- ACUERDO: vencimiento configurable (default 5 = comportamiento anterior)
    v_due_date     := v_period_start + (v_sub.due_offset_days * INTERVAL '1 day');

    -- ACUERDO: escalón de precio vigente al inicio del período (si existe)
    SELECT s.monthly_price_cents INTO v_step_cents
      FROM public.school_billing_schedule s
     WHERE s.school_id = p_school_id AND s.effective_from <= v_period_start
     ORDER BY s.effective_from DESC
     LIMIT 1;

    v_plan_cents := COALESCE(
        v_step_cents,
        v_sub.custom_price_cents,
        CASE v_sub.plan_code
            WHEN 'starter'     THEN 0
            WHEN 'start'       THEN 6900000
            WHEN 'crecimiento' THEN 9900000
            WHEN 'profesional' THEN 15900000
            WHEN 'elite'       THEN 34900000
            ELSE 0
        END
    );

    SELECT COALESCE(SUM(a.monthly_price_cents), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object(
               'kind', 'addon',
               'code', a.addon_key,
               'amount_cents', a.monthly_price_cents
           ) ORDER BY a.addon_key), '[]'::jsonb)
      INTO v_addons_cents, v_items
      FROM public.school_addons a
     WHERE a.school_id = p_school_id
       AND a.enabled
       AND a.monthly_price_cents > 0;

    v_items := jsonb_build_array(jsonb_build_object(
                   'kind', 'plan',
                   'code', v_sub.plan_code,
                   'amount_cents', v_plan_cents,
                   'negotiated', v_step_cents IS NOT NULL OR v_sub.custom_price_cents IS NOT NULL
               )) || v_items;

    -- ACUERDO: cobros únicos/recurrentes que vencen dentro o antes del período
    SELECT COALESCE(SUM(c.amount_cents), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object(
               'kind', 'one_time',
               'code', c.code,
               'label', c.label,
               'amount_cents', c.amount_cents
           ) ORDER BY c.next_bill_on, c.code), '[]'::jsonb)
      INTO v_one_cents, v_one_items
      FROM public.school_one_time_charges c
     WHERE c.school_id = p_school_id
       AND c.status = 'active'
       AND c.next_bill_on < v_period_end;

    v_items := v_items || v_one_items;

    v_seq := v_sub.next_invoice_number;
    v_invoice_number := 'SM-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

    INSERT INTO public.school_subscription_invoices (
        school_id, invoice_number, plan_code, amount_cents, line_items,
        period_start, period_end, due_date, status
    ) VALUES (
        p_school_id, v_invoice_number, v_sub.plan_code, v_plan_cents + v_addons_cents + v_one_cents, v_items,
        v_period_start, v_period_end, v_due_date, 'pending'
    )
    ON CONFLICT (school_id, period_start) WHERE status <> 'cancelled' DO NOTHING
    RETURNING id INTO v_invoice_id;

    IF v_invoice_id IS NULL THEN
        SELECT id INTO v_invoice_id
          FROM public.school_subscription_invoices
         WHERE school_id = p_school_id AND period_start = v_period_start AND status <> 'cancelled';
        RETURN v_invoice_id;
    END IF;

    -- ACUERDO: solo si la factura se insertó de verdad, se avanzan los cobros incluidos
    UPDATE public.school_one_time_charges
       SET next_bill_on = CASE WHEN renews_every_months IS NOT NULL
                               THEN (next_bill_on + (renews_every_months * INTERVAL '1 month'))::date
                               ELSE next_bill_on END,
           status       = CASE WHEN renews_every_months IS NULL THEN 'billed' ELSE status END
     WHERE school_id = p_school_id
       AND status = 'active'
       AND next_bill_on < v_period_end;

    -- DÍA 1: con ciclo mensual, el período vigente queda igual a la factura,
    -- así run_saas_billing_cycle dispara justo el día 1 que la cierra.
    UPDATE public.school_subscriptions
       SET next_invoice_number  = v_seq + 1,
           current_period_start = CASE WHEN billing_cycle = 'monthly'
                                       THEN v_period_start::timestamp AT TIME ZONE 'America/Bogota'
                                       ELSE current_period_start END,
           current_period_end   = CASE WHEN billing_cycle = 'monthly'
                                       THEN v_period_end::timestamp AT TIME ZONE 'America/Bogota'
                                       ELSE current_period_end END
     WHERE school_id = p_school_id;

    RETURN v_invoice_id;
END;
$function$;

-- Igual que en la base viva: solo dueño y service_role (la llaman el BFF y
-- otras funciones SECURITY DEFINER).
REVOKE ALL ON FUNCTION public.generate_school_subscription_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_school_subscription_invoice(uuid) TO service_role;

-- ============================================================================
-- B. Precio negociado / reiniciar período: solo día 1
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_set_school_custom_price(
    p_school_id uuid,
    p_custom_price_cents integer,
    p_billing_cycle text DEFAULT NULL::text,
    p_period_start date DEFAULT NULL::date,
    p_billing_emails text[] DEFAULT NULL::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_effective_cycle text;
    v_period_end      date;
    v_email           text;
BEGIN
    IF NOT (
        public.is_super_admin()
        OR auth.role() = 'service_role'
        OR session_user IN ('postgres', 'supabase_admin')
    ) THEN
        RAISE EXCEPTION 'solo super_admin o el proceso del BFF pueden fijar un precio negociado' USING ERRCODE = '42501';
    END IF;

    IF p_custom_price_cents IS NOT NULL AND p_custom_price_cents < 0 THEN
        RAISE EXCEPTION 'custom_price_cents no puede ser negativo' USING ERRCODE = '22023';
    END IF;

    IF p_billing_cycle IS NOT NULL AND p_billing_cycle NOT IN ('monthly', 'quarterly', 'semiannual', 'annual') THEN
        RAISE EXCEPTION 'billing_cycle debe ser monthly, quarterly, semiannual o annual' USING ERRCODE = '22023';
    END IF;

    -- DÍA 1
    IF p_period_start IS NOT NULL AND extract(day FROM p_period_start) <> 1 THEN
        RAISE EXCEPTION 'la facturación va del 1 al 1: el período debe empezar el día 1 (llegó %)', p_period_start
            USING ERRCODE = '22023';
    END IF;

    IF p_billing_emails IS NOT NULL THEN
        FOREACH v_email IN ARRAY p_billing_emails LOOP
            IF v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
                RAISE EXCEPTION 'correo de facturación inválido: %', v_email USING ERRCODE = '22023';
            END IF;
        END LOOP;
    END IF;

    IF p_period_start IS NOT NULL THEN
        SELECT COALESCE(p_billing_cycle, billing_cycle) INTO v_effective_cycle
          FROM public.school_subscriptions
         WHERE school_id = p_school_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'la escuela % no tiene fila en school_subscriptions', p_school_id
                USING ERRCODE = '23503';
        END IF;

        v_period_end := p_period_start + CASE v_effective_cycle
            WHEN 'quarterly'   THEN INTERVAL '3 months'
            WHEN 'semiannual'  THEN INTERVAL '6 months'
            WHEN 'annual'      THEN INTERVAL '1 year'
            ELSE INTERVAL '1 month'
        END;
    END IF;

    UPDATE public.school_subscriptions
       SET custom_price_cents   = p_custom_price_cents,
           billing_cycle        = COALESCE(p_billing_cycle, billing_cycle),
           current_period_start = COALESCE(p_period_start::timestamp AT TIME ZONE 'America/Bogota', current_period_start),
           current_period_end   = COALESCE(v_period_end::timestamp AT TIME ZONE 'America/Bogota', current_period_end),
           billing_emails       = COALESCE(p_billing_emails, billing_emails),
           updated_at           = now()
     WHERE school_id = p_school_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'la escuela % no tiene fila en school_subscriptions', p_school_id
            USING ERRCODE = '23503';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'school_id', p_school_id,
        'custom_price_cents', p_custom_price_cents,
        'billing_cycle', COALESCE(p_billing_cycle, (SELECT billing_cycle FROM public.school_subscriptions WHERE school_id = p_school_id)),
        'current_period_start', (SELECT current_period_start FROM public.school_subscriptions WHERE school_id = p_school_id),
        'current_period_end', (SELECT current_period_end FROM public.school_subscriptions WHERE school_id = p_school_id),
        'billing_emails', (SELECT billing_emails FROM public.school_subscriptions WHERE school_id = p_school_id)
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_school_custom_price(uuid, integer, text, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_school_custom_price(uuid, integer, text, date, text[]) TO authenticated, service_role;

-- ============================================================================
-- C. Reactivación: período desde el próximo día 1
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_reactivate_school(p_school_id uuid, p_plan_code text DEFAULT 'crecimiento'::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_actor  uuid := auth.uid();
    v_hoy    date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_inicio date;
BEGIN
    IF public.is_super_admin() IS NOT TRUE THEN
        RAISE EXCEPTION 'solo super_admin puede reactivar' USING ERRCODE = '42501';
    END IF;

    -- DÍA 1: primer día 1 en o después de hoy
    v_inicio := CASE WHEN extract(day FROM v_hoy) = 1
                     THEN v_hoy
                     ELSE (date_trunc('month', v_hoy) + INTERVAL '1 month')::date
                END;

    PERFORM public.admin_set_school_plan(p_school_id, p_plan_code, 'active');

    UPDATE public.school_subscriptions
       SET blocking_exempt        = false,
           blocking_exempt_reason = NULL,
           current_period_start   = v_inicio::timestamp AT TIME ZONE 'America/Bogota',
           current_period_end     = (v_inicio + INTERVAL '1 month')::timestamp AT TIME ZONE 'America/Bogota',
           metadata               = metadata || jsonb_build_object(
                                        'reactivated_by', v_actor::text,
                                        'reactivated_at', to_jsonb(now()), 'via', 'admin_reactivate_school'),
           updated_at             = now()
     WHERE school_id = p_school_id;

    RETURN jsonb_build_object('ok', true, 'school_id', p_school_id, 'plan_code', p_plan_code,
                             'status', 'active', 'is_operational', public.school_is_operational(p_school_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_reactivate_school(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_school(uuid, text) TO authenticated, service_role;

-- ============================================================================
-- D. Candado: facturas nuevas del 1 al 1
-- ============================================================================
ALTER TABLE public.school_subscription_invoices
    DROP CONSTRAINT IF EXISTS school_subscription_invoices_periodo_dia_1;
ALTER TABLE public.school_subscription_invoices
    ADD CONSTRAINT school_subscription_invoices_periodo_dia_1
    CHECK (
        created_at < TIMESTAMPTZ '2026-11-24 00:00:00-05'
        OR (extract(day FROM period_start) = 1 AND extract(day FROM period_end) = 1)
    );

COMMENT ON CONSTRAINT school_subscription_invoices_periodo_dia_1 ON public.school_subscription_invoices IS
    'Facturación SaaS del 1 al 1 (20261124173412). Las facturas creadas antes del 2026-11-24 quedan como estaban.';

COMMIT;
