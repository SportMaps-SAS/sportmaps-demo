-- ============================================================================
-- Solicitudes de borrado de cuenta (Ley 1581/2012, derecho de supresión) — B12
-- ============================================================================
--
-- Mi cuenta › Seguridad respondía 500: `GET /api/v1/me/data-deletion-request`
-- lee `account_deletion_requests`, que NO existe en la base viva. La parte 3-5
-- de 20260522141000_security_hardening_p1.sql nunca se aplicó (y esa migración
-- no se edita). Verificado el 2026-10-27 con to_regclass y pg_proc: no existen
-- la tabla ni `request_account_deletion` ni `cancel_account_deletion`.
--
-- Diferencias con la versión de mayo (la base cambió desde entonces):
--   · Las RPC reciben `p_user_id`: el BFF las llama con el cliente de
--     service_role, donde auth.uid() es NULL (la versión vieja respondía
--     siempre `auth_required`). Por eso EXECUTE es SOLO de service_role; el
--     BFF pasa `req.user.id` del JWT ya validado.
--   · `recurring_subscriptions` hoy es (payer_user_id, cancel_reason,
--     cancelled_by) con CHECK (status = 'cancelled') = (cancel_reason IS NOT NULL)
--     y cancel_reason ∈ {…, 'account_deleted', …}; no hay `user_id` ni
--     `cancelled_reason` ni estado 'paused'.
--   · FK a public.profiles(id) (convención del repo), no a auth.users.
--
-- Efecto al aplicarla: el job `account-deletion.job.ts` (ya desplegado) empieza
-- a encontrar la tabla y anonimiza las cuentas cuyo `scheduled_for` venció.
-- Hoy no hay ninguna solicitud (la tabla no existía), así que no hace nada
-- hasta que alguien pida borrar su cuenta y pasen 30 días.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS, DROP POLICY IF EXISTS,
-- CREATE OR REPLACE FUNCTION.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason          text,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    scheduled_for   timestamptz NOT NULL,               -- requested_at + 30 días
    status          text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'cancelled', 'completed', 'failed')),
    cancelled_at    timestamptz,
    completed_at    timestamptz,
    error_message   text,
    -- Trazabilidad legal
    ip_address      inet,
    user_agent      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.account_deletion_requests IS
  'Solicitudes de supresión de cuenta (Ley 1581). Las crea/cancela el BFF vía request_account_deletion / cancel_account_deletion; las ejecuta account-deletion.job.ts al cumplirse scheduled_for.';

-- Una sola solicitud pendiente por usuario.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_pending
    ON public.account_deletion_requests (user_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_account_deletion_scheduled
    ON public.account_deletion_requests (scheduled_for)
    WHERE status = 'pending';

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Lectura: solo la propia. Escritura: nadie desde el cliente (solo las RPC y
-- el job, con service_role). Sin policies de INSERT/UPDATE/DELETE a propósito.
DROP POLICY IF EXISTS "account_deletion_owner_select" ON public.account_deletion_requests;
CREATE POLICY "account_deletion_owner_select" ON public.account_deletion_requests
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.account_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_requests TO authenticated;
GRANT ALL ON public.account_deletion_requests TO service_role;


-- ----------------------------------------------------------------------------
-- request_account_deletion(p_user_id, …)
-- Programa el borrado a 30 días y, de inmediato, corta los cobros
-- automáticos (débito) y desactiva las tarjetas guardadas.
-- ----------------------------------------------------------------------------

-- La firma de mayo (sin p_user_id) nunca llegó a la base; si alguien la
-- aplicara a mano quedaría una sobrecarga ejecutable por authenticated.
DROP FUNCTION IF EXISTS public.request_account_deletion(text, inet, text);

CREATE OR REPLACE FUNCTION public.request_account_deletion(
    p_user_id    uuid,
    p_reason     text DEFAULT NULL,
    p_ip_address inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_id   uuid;
    v_when timestamptz := now() + interval '30 days';
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'auth_required');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'profile_not_found');
    END IF;

    -- 1. Débitos automáticos: no se cobra nada durante la ventana de 30 días.
    UPDATE public.recurring_subscriptions
       SET status        = 'cancelled',
           cancel_reason = 'account_deleted',
           cancelled_by  = p_user_id,
           cancelled_at  = now(),
           updated_at    = now()
     WHERE payer_user_id = p_user_id
       AND status IN ('active', 'suspended');

    -- 2. Tarjetas guardadas: inutilizables desde ya (ni para un cobro suelto).
    UPDATE public.payment_tokens
       SET is_active = false, is_default = false, updated_at = now()
     WHERE user_id = p_user_id AND is_active = true;

    -- 3. La solicitud (si ya había una pendiente, se extiende la ventana).
    INSERT INTO public.account_deletion_requests (user_id, reason, scheduled_for, ip_address, user_agent)
    VALUES (p_user_id, p_reason, v_when, p_ip_address, p_user_agent)
    ON CONFLICT (user_id) WHERE status = 'pending'
    DO UPDATE SET
        reason        = COALESCE(EXCLUDED.reason, account_deletion_requests.reason),
        scheduled_for = EXCLUDED.scheduled_for,
        updated_at    = now()
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'request_id', v_id,
        'scheduled_for', v_when,
        'message', 'Tu solicitud se ejecutará en 30 días. Puedes cancelarla mientras esté pendiente.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.request_account_deletion(uuid, text, inet, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(uuid, text, inet, text) TO service_role;


-- ----------------------------------------------------------------------------
-- cancel_account_deletion(p_user_id) — la persona se arrepiente.
-- NO reactiva tarjetas ni débitos: tiene que volver a inscribirlos (defensivo:
-- si quien cancela es un atacante con la sesión, no le devolvemos las tarjetas).
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.cancel_account_deletion();

CREATE OR REPLACE FUNCTION public.cancel_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'auth_required');
    END IF;

    UPDATE public.account_deletion_requests
       SET status       = 'cancelled',
           cancelled_at = now(),
           updated_at   = now()
     WHERE user_id = p_user_id AND status = 'pending';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'no_pending_request');
    END IF;
    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion(uuid) TO service_role;

-- Verificación (después de aplicar):
--   select to_regclass('public.account_deletion_requests');                       -- no null
--   select policyname, roles, qual, with_check from pg_policies where tablename = 'account_deletion_requests';
--   select proname, proacl, proconfig from pg_proc where proname in ('request_account_deletion','cancel_account_deletion');
--     → proacl solo con service_role (y el dueño); proconfig con search_path
--   set local role anon; select count(*) from public.account_deletion_requests; -- permission denied
