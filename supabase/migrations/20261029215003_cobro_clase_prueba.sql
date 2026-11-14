-- =============================================================================
-- 20261029215003_cobro_clase_prueba.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261029211413
-- Objetivo: cobrar la clase de prueba desde Gestión de Pagos (pedido Dreamers,
-- 2026-10-29: una acudiente quería pagar la clase y no había cómo).
--
-- El prospecto vive en school_signup_leads, NO en children/enrollments (cicatriz
-- 20260803110621), y «Cobros y pagos» solo trabaja con deportistas. Así que:
--   · payments.signup_lead_id amarra el cobro al prospecto, sin inventar un
--     deportista ni un unregistered_athlete que ensucie Deportistas.
--   · payment_category 'clase_prueba': ingreso real (cash_ledger, KPIs y
--     dashboard lo suman por status), sin plan → no da vigencia, no vence, no
--     bloquea torniquete. period_uniqueness_exempt: al pasar a deportista no
--     choca con la mensualidad del mismo mes.
--   · school_trial_class_settings.trial_price: el valor lo decide la escuela en
--     Clase de prueba → Configurar; al cobrar sale precargado y se puede cambiar.
--   · Al convertir el prospecto (cerrar_prospecto_clase_prueba pone
--     converted_enrollment_id) el pago pasa al estado de cuenta del deportista.
-- Decisiones del usuario 2026-10-29: valor fijo en Configurar; cobran dueño y
-- administradores; al inscribir, el pago pasa a su estado de cuenta.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ── 1. Columnas ──────────────────────────────────────────────────────────────
-- Sin IF NOT EXISTS a propósito: si ya existieran, que falle y se mire (un
-- IF NOT EXISTS ocultó un choque de tablas el 2026-10-29).
ALTER TABLE public.payments
    ADD COLUMN signup_lead_id uuid REFERENCES public.school_signup_leads(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payments.signup_lead_id IS
    'Prospecto de clase de prueba al que corresponde el cobro (payment_category = clase_prueba). '
    'Al convertirlo, el pago además recibe child_id/user_id del deportista.';

CREATE INDEX idx_payments_signup_lead
    ON public.payments (signup_lead_id)
    WHERE signup_lead_id IS NOT NULL;

ALTER TABLE public.school_trial_class_settings
    ADD COLUMN trial_price numeric CHECK (trial_price IS NULL OR trial_price >= 0);

COMMENT ON COLUMN public.school_trial_class_settings.trial_price IS
    'Valor de la clase de prueba del registro rápido y WhatsApp. NULL = sin valor (se escribe al cobrar).';

-- Misma lista viva + 'clase_prueba'.
ALTER TABLE public.payments DROP CONSTRAINT payments_payment_category_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_payment_category_check CHECK (
    payment_category IS NULL OR payment_category = ANY (ARRAY[
        'mensualidad', 'inscripcion', 'articulos', 'torneo', 'otro', 'seguro',
        'excedente', 'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba'
    ])
);

-- ── 2. Helper: el pago del prospecto pasa al deportista ─────────────────────
-- Solo lo llaman la RPC de pago y el trigger de conversión (ambos SECURITY
-- DEFINER): sin EXECUTE para nadie. Solo toma pagos que todavía no tienen
-- deportista; nunca les pone offering_plan_id (no es mensualidad del plan).
CREATE FUNCTION public._mover_pago_clase_prueba(p_lead_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_e record;
    v_parent uuid;
BEGIN
    SELECT e.child_id, e.user_id, e.unregistered_athlete_id
      INTO v_e
      FROM public.school_signup_leads l
      JOIN public.enrollments e ON e.id = l.converted_enrollment_id
     WHERE l.id = p_lead_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_e.child_id IS NOT NULL THEN
        SELECT c.parent_id INTO v_parent FROM public.children c WHERE c.id = v_e.child_id;
    END IF;

    UPDATE public.payments p
       SET child_id                = v_e.child_id,
           parent_id               = CASE WHEN v_e.child_id IS NOT NULL THEN v_parent ELSE p.parent_id END,
           user_id                 = CASE WHEN v_e.child_id IS NULL AND v_e.unregistered_athlete_id IS NULL
                                          THEN v_e.user_id ELSE p.user_id END,
           unregistered_athlete_id = v_e.unregistered_athlete_id
     WHERE p.signup_lead_id = p_lead_id
       AND p.child_id IS NULL
       AND p.user_id IS NULL
       AND p.unregistered_athlete_id IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public._mover_pago_clase_prueba(uuid) FROM PUBLIC, anon, authenticated;

-- Trigger: cerrar_prospecto_clase_prueba (o quien sea) amarra la inscripción.
CREATE FUNCTION public.fn_lead_convertido_mueve_pago()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    PERFORM public._mover_pago_clase_prueba(NEW.id);
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_lead_convertido_mueve_pago() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_lead_convertido_mueve_pago
    AFTER UPDATE OF converted_enrollment_id ON public.school_signup_leads
    FOR EACH ROW
    WHEN (NEW.converted_enrollment_id IS NOT NULL
          AND NEW.converted_enrollment_id IS DISTINCT FROM OLD.converted_enrollment_id)
    EXECUTE FUNCTION public.fn_lead_convertido_mueve_pago();

-- ── 3. RPC: registrar el pago (dueño y administradores) ─────────────────────
CREATE FUNCTION public.registrar_pago_clase_prueba(
    p_lead_id uuid,
    p_monto numeric,
    p_metodo text,
    p_referencia text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_lead public.school_signup_leads%ROWTYPE;
    v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_fecha date;
    v_ref text := NULLIF(btrim(COALESCE(p_referencia, '')), '');
    v_pago_id uuid;
BEGIN
    IF p_metodo IS NULL OR p_metodo NOT IN ('cash', 'transfer', 'card', 'other') THEN
        RAISE EXCEPTION 'METODO_INVALIDO' USING ERRCODE = '22023';
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RAISE EXCEPTION 'MONTO_INVALIDO' USING ERRCODE = '22023',
            HINT = 'El valor de la clase de prueba debe ser mayor que cero.';
    END IF;

    -- FOR UPDATE: dos clics (o dos admins) no dejan dos pagos.
    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prospecto no encontrado' USING ERRCODE = '02000';
    END IF;
    IF NOT (public.is_super_admin() OR public.is_school_admin(v_lead.school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_lead.status = 'discarded' THEN
        RAISE EXCEPTION 'PROSPECTO_DESCARTADO' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.payments
         WHERE signup_lead_id = p_lead_id
           AND status IN ('paid', 'partial', 'awaiting_approval', 'pending', 'overdue')
    ) THEN
        RAISE EXCEPTION 'CLASE_PRUEBA_YA_PAGADA' USING ERRCODE = '23505';
    END IF;

    v_fecha := COALESCE(
        CASE WHEN (v_lead.source_detail->>'fecha_clase') ~ '^\d{4}-\d{2}-\d{2}$'
             THEN (v_lead.source_detail->>'fecha_clase')::date END,
        (SELECT ts.slot_date FROM public.school_trial_slots ts WHERE ts.id = v_lead.trial_slot_id),
        v_hoy);

    INSERT INTO public.payments (
        school_id, signup_lead_id, amount, amount_paid, concept,
        due_date, payment_date, status, payment_type, payment_method,
        payment_category, period_uniqueness_exempt,
        created_by, approved_by, approved_at, notes
    ) VALUES (
        v_lead.school_id, p_lead_id, p_monto, p_monto,
        'Clase de prueba — ' || COALESCE(NULLIF(btrim(v_lead.full_name), ''), 'Prospecto'),
        v_fecha, v_hoy, 'paid', 'one_time', p_metodo,
        'clase_prueba', true,
        auth.uid(), auth.uid(), now(),
        CASE WHEN v_ref IS NOT NULL THEN left('Referencia: ' || v_ref, 500) END
    )
    RETURNING id INTO v_pago_id;

    -- Si ya se había inscrito, el pago entra directo a su estado de cuenta.
    PERFORM public._mover_pago_clase_prueba(p_lead_id);

    RETURN jsonb_build_object('ok', true, 'payment_id', v_pago_id);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_pago_clase_prueba(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pago_clase_prueba(uuid, numeric, text, text) TO authenticated;

-- ── 4. RPC: listado para Gestión de Pagos ───────────────────────────────────
-- Los mismos prospectos de Deportistas → «Clase de prueba» (new/contacted) más
-- los que ya pagaron aunque se hayan inscrito, con su pago.
CREATE FUNCTION public.listar_cobros_clase_prueba(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_rows jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT l.id, l.full_name, l.guardian_name, l.phone, l.status, l.created_at,
               COALESCE(l.source_detail->>'canal',
                        CASE WHEN l.how_heard = 'whatsapp' THEN 'whatsapp' ELSE 'formulario' END) AS canal,
               l.source_detail->>'asistencia' AS asistencia,
               COALESCE(l.source_detail->>'fecha_clase', ts.slot_date::text) AS fecha_clase,
               pg.pago
          FROM public.school_signup_leads l
          LEFT JOIN public.school_trial_slots ts ON ts.id = l.trial_slot_id
          LEFT JOIN LATERAL (
              SELECT jsonb_build_object(
                         'id', p.id, 'monto', p.amount, 'metodo', p.payment_method,
                         'fecha', p.payment_date, 'estado', p.status) AS pago
                FROM public.payments p
               WHERE p.signup_lead_id = l.id
                 AND p.status NOT IN ('cancelled', 'failed', 'rejected')
               ORDER BY p.created_at DESC
               LIMIT 1
          ) pg ON true
         WHERE l.school_id = p_school_id
           AND (l.status IN ('new', 'contacted') OR pg.pago IS NOT NULL)
         ORDER BY l.created_at DESC
         LIMIT 500
      ) t;

    RETURN jsonb_build_object(
        'valor', (SELECT s.trial_price FROM public.school_trial_class_settings s WHERE s.school_id = p_school_id),
        'prospectos', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.listar_cobros_clase_prueba(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_cobros_clase_prueba(uuid) TO authenticated;

-- ── 5. RPC: valor de la clase de prueba (Configurar) ────────────────────────
-- Sin fila de configuración = todo prendido; el upsert respeta esos defaults.
CREATE FUNCTION public.guardar_valor_clase_prueba(p_school_id uuid, p_valor numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_valor IS NOT NULL AND p_valor < 0 THEN
        RAISE EXCEPTION 'MONTO_INVALIDO' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.school_trial_class_settings (school_id, trial_price)
    VALUES (p_school_id, NULLIF(p_valor, 0))
    ON CONFLICT (school_id) DO UPDATE
       SET trial_price = EXCLUDED.trial_price,
           updated_at  = now();

    RETURN jsonb_build_object('ok', true, 'valor', NULLIF(p_valor, 0));
END;
$$;

REVOKE ALL ON FUNCTION public.guardar_valor_clase_prueba(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guardar_valor_clase_prueba(uuid, numeric) TO authenticated;

COMMIT;
