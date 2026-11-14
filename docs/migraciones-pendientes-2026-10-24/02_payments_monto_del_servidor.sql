-- =============================================================================
-- 20261007163134_payments_monto_del_servidor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-07   Versión anterior: 20261007163132
-- Objetivo: pendiente 1 de docs/cierre-seguridad-ia-pagos-2026-10-05.md y
--   residual A2 de 20261002125957 (DIN-24): «el amount del INSERT lo pone el
--   navegador». Un acudiente podía crear su cobro con amount = $1 (en
--   awaiting_approval, con un comprobante por $1) y, como el monto esperado del
--   veredicto sale de ese mismo amount, el comprobante «cuadraba» y podía
--   auto-aprobarse por menos de lo debido.
--
--   Caminos del navegador que insertan payments con monto propio:
--     PaymentCheckoutModal.tsx  (Wompi pending, MercadoPago pending, transferencia awaiting_approval)
--     ParentCheckoutPage.tsx    (amount sale del query string ?amount=)
--   (RegisterCashPaymentModal es staff: no aplica.)
--
--   Qué hace, SOLO para escrituras directas (PostgREST) de quien NO es staff de
--   la escuela — mismo criterio que trg_zz_guard_payments_client:
--   1. MENSUALIDAD (payment_category='mensualidad', o sin categoría y concepto
--      «Mensualidad…»): el monto lo define el servidor con la MISMA regla que
--      open_month (monthly_fee > plan > team > ficha; fee_is_manual; descuento
--      de hermanos). Si el monto no es uno de los válidos para ese atleta en
--      esa escuela → RECHAZO (PAYMENT_AMOUNT_MISMATCH, 42501), con el valor
--      correcto en el HINT. Radio medido 2026-10-07 (90 días, inserts no-staff
--      con concepto de la app): 83 de 84 coinciden; el 1 restante es un precio
--      que cambió después.
--   2. Todo lo demás (abono, «otro», inscripción, artículos, torneo, o
--      mensualidad sin tarifa en el servidor): el monto es legítimamente
--      elegido por la familia, así que NO se rechaza, pero queda marcado
--      amount_source='cliente' y auto_approve_payment se NIEGA a aprobarlo: lo
--      revisa una persona. Pagos en línea no cambian: el webhook de la
--      pasarela confirma el dinero real.
--   3. amount_source no se puede cambiar desde el navegador (UPDATE bloqueado).
--   4. Monto <= 0 desde el navegador: rechazo.
--
--   Dependencia con DIN-24 (20261002125957): NO depende. Este trigger es
--   independiente (trg_zz_payments_monto_servidor corre después de
--   trg_zz_guard_payments_client por orden alfabético) y no redefine
--   fn_guard_payments_client. Nota: el cuerpo VIVO de fn_guard_payments_client
--   es idéntico (md5) al de 20261002125957: DIN-24 YA está aplicado en la base.
--   Con DIN-24 activo, un acudiente tampoco puede cambiar amount por UPDATE.
--
--   Residual: los cobros abiertos creados por el navegador ANTES de esta
--   migración quedan con amount_source='servidor' (default); no hay forma
--   fiable de distinguirlos de los de RPC (auth.uid() es el mismo).
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

-- ── Columna ─────────────────────────────────────────────────────────────────
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS amount_source text NOT NULL DEFAULT 'servidor';

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_amount_source_check;
ALTER TABLE public.payments
    ADD CONSTRAINT payments_amount_source_check CHECK (amount_source IN ('servidor', 'cliente'));

COMMENT ON COLUMN public.payments.amount_source IS
  '''cliente'' = el monto lo eligió quien no es staff desde el navegador (abono, otro, inscripción, artículos…). auto_approve_payment no aprueba esos cobros. Lo estampa trg_zz_payments_monto_servidor.';

-- ── Montos válidos de una mensualidad (misma regla que open_month) ─────────
CREATE OR REPLACE FUNCTION public.payments_montos_mensualidad_validos(
    p_school_id uuid,
    p_child_id  uuid,
    p_user_id   uuid
)
RETURNS numeric[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_uid     uuid := auth.uid();
    v_sib_on  boolean;
    v_sib_pct numeric;
    v_res     numeric[];
BEGIN
    IF v_uid IS NULL OR p_school_id IS NULL OR (p_child_id IS NULL AND p_user_id IS NULL) THEN
        RETURN NULL;
    END IF;
    -- Solo el acudiente del atleta, el atleta adulto o el staff de la escuela:
    -- no es una forma de consultar la tarifa de cualquiera.
    IF NOT (
        (p_child_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.children c WHERE c.id = p_child_id AND c.parent_id = v_uid))
        OR (p_child_id IS NULL AND p_user_id = v_uid)
        OR p_school_id = ANY (public.user_staff_school_ids())
    ) THEN
        RETURN NULL;
    END IF;

    SELECT coalesce(sibling_discount_enabled, false), coalesce(sibling_discount_percentage, 0)
      INTO v_sib_on, v_sib_pct
      FROM public.school_settings WHERE school_id = p_school_id;
    v_sib_on  := coalesce(v_sib_on, false);
    v_sib_pct := coalesce(v_sib_pct, 0);

    SELECT array_agg(DISTINCT x.monto ORDER BY x.monto) INTO v_res
    FROM (
        SELECT CASE WHEN e.fee_is_manual THEN coalesce(e.monthly_fee, 0) ELSE b.base END AS monto
        FROM public.enrollments e
        LEFT JOIN public.children c ON c.id = e.child_id
        LEFT JOIN public.teams    t ON t.id = e.team_id
        CROSS JOIN LATERAL (
            SELECT coalesce(
                nullif(e.monthly_fee, 0),
                nullif((SELECT op.price FROM public.offering_plans op WHERE op.id = e.offering_plan_id), 0),
                nullif(t.price_monthly, 0),
                nullif(c.monthly_fee, 0),
                0) AS base
        ) b
        WHERE e.school_id = p_school_id
          AND e.status = 'active'
          AND ((p_child_id IS NOT NULL AND e.child_id = p_child_id)
               OR (p_child_id IS NULL AND e.user_id = p_user_id))
        UNION ALL
        -- Con descuento de hermanos (open_month lo aplica al hermano «segundo»).
        SELECT round(b.base * (1 - v_sib_pct / 100.0))
        FROM public.enrollments e
        LEFT JOIN public.children c ON c.id = e.child_id
        LEFT JOIN public.teams    t ON t.id = e.team_id
        CROSS JOIN LATERAL (
            SELECT coalesce(
                nullif(e.monthly_fee, 0),
                nullif((SELECT op.price FROM public.offering_plans op WHERE op.id = e.offering_plan_id), 0),
                nullif(t.price_monthly, 0),
                nullif(c.monthly_fee, 0),
                0) AS base
        ) b
        WHERE v_sib_on AND v_sib_pct > 0
          AND NOT e.fee_is_manual
          AND e.school_id = p_school_id
          AND e.status = 'active'
          AND ((p_child_id IS NOT NULL AND e.child_id = p_child_id)
               OR (p_child_id IS NULL AND e.user_id = p_user_id))
    ) x
    WHERE x.monto > 0;

    RETURN v_res;
END;
$fn$;

COMMENT ON FUNCTION public.payments_montos_mensualidad_validos(uuid, uuid, uuid) IS
  'Montos válidos de la mensualidad de un atleta en una escuela (regla de open_month, con y sin descuento de hermanos). Solo para su acudiente, el atleta adulto o staff; si no, NULL.';

REVOKE ALL ON FUNCTION public.payments_montos_mensualidad_validos(uuid, uuid, uuid) FROM PUBLIC, anon;
-- El trigger es SECURITY INVOKER: corre como el acudiente y necesita EXECUTE.
GRANT EXECUTE ON FUNCTION public.payments_montos_mensualidad_validos(uuid, uuid, uuid) TO authenticated, service_role;

-- ── Trigger ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_payments_monto_servidor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_validos numeric[];
BEGIN
    -- RPC SECURITY DEFINER (postgres), BFF (service_role), SQL editor: no aplica.
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- Staff de la escuela del cobro: opera como hoy (mismo criterio que DIN-24).
    IF NEW.school_id IS NOT NULL
       AND NEW.school_id = ANY (public.user_staff_school_ids())
       AND (TG_OP = 'INSERT' OR OLD.school_id IS NOT DISTINCT FROM NEW.school_id) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.amount_source IS DISTINCT FROM OLD.amount_source THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: amount_source' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    -- ── INSERT ───────────────────────────────────────────────────────────────
    IF NEW.amount IS NULL OR NEW.amount <= 0 THEN
        RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = '42501',
            HINT = 'El valor del pago debe ser mayor que cero.';
    END IF;

    IF (NEW.payment_category = 'mensualidad'
        OR (NEW.payment_category IS NULL AND NEW.concept ILIKE 'mensualidad%'))
       AND (NEW.child_id IS NOT NULL OR NEW.user_id IS NOT NULL) THEN
        v_validos := public.payments_montos_mensualidad_validos(NEW.school_id, NEW.child_id, NEW.user_id);
        IF coalesce(cardinality(v_validos), 0) > 0 THEN
            IF NOT (NEW.amount = ANY (v_validos)) THEN
                RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH: %', v_validos[1] USING ERRCODE = '42501',
                    HINT = format('El valor de la mensualidad lo define la escuela: %s.',
                                  array_to_string(v_validos, ' o '));
            END IF;
            NEW.amount_source := 'servidor';
            RETURN NEW;
        END IF;
    END IF;

    -- Monto elegido por la familia (o sin tarifa con qué compararlo): se acepta,
    -- pero no se auto-aprueba.
    NEW.amount_source := 'cliente';
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_payments_monto_servidor() IS
  'Monto del lado del servidor para INSERT directos de quien no es staff: mensualidad = tarifa del servidor (rechaza discrepancias); resto = amount_source cliente (sin auto-aprobación). SECURITY INVOKER a propósito.';

REVOKE ALL ON FUNCTION public.fn_payments_monto_servidor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_zz_payments_monto_servidor ON public.payments;
CREATE TRIGGER trg_zz_payments_monto_servidor
    BEFORE INSERT OR UPDATE OF amount_source ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.fn_payments_monto_servidor();

-- ── auto_approve_payment: no aprueba montos elegidos por el cliente ────────
-- Cuerpo = el VIVO al 2026-10-07 + la guarda de amount_source.
CREATE OR REPLACE FUNCTION public.auto_approve_payment(p_payment_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_school_id uuid;
    v_status    text;
    v_parent_id uuid;
    v_child_id  uuid;
    v_team_id   uuid;
    v_amount    numeric;
    v_discount  numeric;
    v_paid      numeric;
    v_data      jsonb;
    v_source    text;
BEGIN
    SELECT school_id, status, parent_id, child_id, team_id, amount,
           COALESCE(early_payment_discount_applied, 0), amount_source
    INTO v_school_id, v_status, v_parent_id, v_child_id, v_team_id, v_amount, v_discount, v_source
    FROM public.payments WHERE id = p_payment_id;

    IF v_school_id IS NULL THEN RETURN false; END IF;
    IF v_status <> 'awaiting_approval' THEN RETURN false; END IF;  -- idempotente / no pisa al admin
    -- El monto lo eligió el navegador: el comprobante se compara contra un
    -- valor que controla quien paga. Lo aprueba una persona.
    IF v_source = 'cliente' THEN RETURN false; END IF;

    v_paid := v_amount - v_discount;

    UPDATE public.payments
    SET status = 'paid',
        approved_by = NULL,                       -- sistema
        approved_at = now(),
        amount_paid = v_paid,
        reconciliation_status = 'pendiente',
        updated_at = now()
    WHERE id = p_payment_id AND status = 'awaiting_approval';

    UPDATE public.enrollments
    SET status = 'active', updated_at = now()
    WHERE school_id = v_school_id
      AND status = 'pending'
      AND (
            (v_child_id IS NOT NULL AND child_id = v_child_id)
         OR (v_child_id IS NULL AND v_parent_id IS NOT NULL AND user_id = v_parent_id)
      )
      AND (v_team_id IS NULL OR team_id = v_team_id);

    v_data := public._payment_notif_data(v_parent_id, v_child_id, v_team_id, v_school_id, v_paid);

    -- Notificación al PADRE (con category + data).
    IF v_parent_id IS NOT NULL THEN
        INSERT INTO public.notifications
            (user_id, school_id, title, message, type, link, category, data)
        VALUES (v_parent_id, v_school_id, 'Pago aprobado',
                'Validamos tu comprobante automáticamente y tu pago quedó aprobado. ¡Gracias!',
                'success', '/my-payments', 'payment', v_data);
    END IF;

    -- Notificación al STAFF de la sede (prerequisito Modo Recepción).
    PERFORM public._notify_school_staff(
        v_school_id, 'payment', 'success',
        'Pago recibido',
        format('Pago aprobado automáticamente: %s (%s)',
               v_data->>'payer_name', v_data->>'concept'),
        '/payments-automation',
        v_data
    );

    RETURN true;
END;
$fn$;

REVOKE ALL ON FUNCTION public.auto_approve_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_approve_payment(uuid) TO service_role;

COMMIT;
