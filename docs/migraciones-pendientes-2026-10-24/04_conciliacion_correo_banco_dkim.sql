-- =============================================================================
-- 20261007163138_conciliacion_correo_banco_dkim.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-07   Versión anterior: 20261007095911
-- Objetivo: conciliar pagos contra la NOTIFICACIÓN DEL BANCO que la escuela
--   reenvía a SportMaps, verificada con DKIM (plan maestro de cobros §4.6 y
--   Fase 1.3; spec docs/specs/conciliacion-correo-banco-dkim.md).
-- =============================================================================
-- Qué crea (todo detrás de un flag por escuela, APAGADO por defecto):
--
--   1. school_settings.bank_email_reconciliation_enabled  (flag, default false)
--   2. bank_email_inboxes  — una dirección de recepción por escuela
--        banco+<token>@<dominio inbound>  y los buzones de la escuela a los que
--        el banco le escribe (el To: FIRMADO por DKIM tiene que ser uno de esos).
--   3. bank_email_notices  — cada aviso bancario recibido: evidencia DKIM,
--        idempotencia por (message-id, sha256 del cuerpo), lo que se leyó y el
--        resultado del cruce.
--   4. RPCs:
--        · bank_email_inbox_configure  (admin de la escuela) — crea/edita la
--          dirección y los buzones.
--        · bank_email_notice_apply     (solo service_role / BFF) — aplica el
--          resultado del cruce de forma atómica (FOR UPDATE sobre el pago).
--        · bank_email_notice_resolve   (admin de la escuela) — confirma o
--          descarta un candidato.
--
-- Por qué una tabla NUEVA y no bank_statement_lines: un correo NO es un
-- extracto. reconcile_statement() glosa como NO_APARECE_EN_BANCO todo pago del
-- rango que no aparezca en el extracto; con correos sueltos (la escuela pudo no
-- reenviar uno, Gmail pudo filtrar otro) eso abriría glosas falsas a familias
-- que sí pagaron. Además el aviso necesita guardar evidencia que una línea de
-- extracto no tiene (dominio DKIM, To firmado, message-id, hash).
--
-- Reglas de dinero (no negociables):
--   · Solo se marca reconciliation_status='confirmado' en pagos YA 'paid'.
--   · Un pago pendiente NUNCA se aprueba acá: queda como candidato y la
--     escuela lo aprueba por el flujo normal.
--   · Un pago se concilia con UN solo aviso (índice único parcial).
-- =============================================================================

BEGIN;

-- ── 1. Flag por escuela ─────────────────────────────────────────────────────
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS bank_email_reconciliation_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.school_settings.bank_email_reconciliation_enabled IS
    'Conciliación por correo del banco verificado con DKIM. Apagado por defecto. '
    'Spec: docs/specs/conciliacion-correo-banco-dkim.md';

-- ── 2. Dirección de recepción por escuela ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_email_inboxes (
    school_id   uuid PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    -- Parte variable de banco+<token>@<dominio>. 80 bits de azar: no es un
    -- secreto fuerte (el control real es DKIM + To firmado), pero evita que
    -- alguien adivine direcciones de otras escuelas.
    token       text NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{20}$'),
    -- Buzones de la escuela a los que el BANCO le escribe (los que reenvían).
    -- El To: firmado por DKIM del aviso tiene que ser uno de estos: así un
    -- aviso real del Nequi de OTRA persona reenviado acá no sirve.
    mailboxes   text[] NOT NULL DEFAULT '{}'
                CHECK (coalesce(array_length(mailboxes, 1), 0) <= 5),
    created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bank_email_inboxes ENABLE ROW LEVEL SECURITY;

-- Lectura: administración de la escuela. Escritura: solo la RPC de abajo.
DROP POLICY IF EXISTS bank_email_inboxes_select_admin ON public.bank_email_inboxes;
CREATE POLICY bank_email_inboxes_select_admin ON public.bank_email_inboxes
    FOR SELECT TO authenticated
    USING (school_id = ANY (public.user_admin_school_ids()));

REVOKE ALL ON public.bank_email_inboxes FROM anon, authenticated;
GRANT SELECT ON public.bank_email_inboxes TO authenticated;
GRANT ALL ON public.bank_email_inboxes TO service_role;

-- ── 3. Avisos bancarios recibidos ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_email_notices (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id            uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    -- Idempotencia de la entrega de Resend (el webhook se reintenta).
    resend_email_id      text NOT NULL UNIQUE,
    -- Idempotencia del CONTENIDO: el mismo aviso reenviado dos veces (por el
    -- filtro y a mano) no se cuenta dos veces.
    message_id           text,
    body_sha256          text NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
    recipient            text NOT NULL,
    from_address         text,
    subject              text,
    signed_to            text[] NOT NULL DEFAULT '{}',
    dkim_domain          text,
    dkim_selector        text,
    -- true si se verificó el original adjunto (reenvío «como adjunto»).
    via_adjunto          boolean NOT NULL DEFAULT false,
    estado               text NOT NULL DEFAULT 'verificado'
                         CHECK (estado IN (
                             'verificado',            -- DKIM ok, falta el cruce
                             'rechazado',             -- DKIM / dominio / buzón no pasan
                             'no_es_aviso',           -- correo legítimo del banco sin plata entrante
                             'confirmacion_reenvio',  -- código de confirmación del reenvío de Gmail
                             'sin_cruce',             -- plata real sin pago que le corresponda
                             'candidato',             -- coincide con un pago PENDIENTE: la escuela decide
                             'ambiguo',               -- varios pagos posibles: la escuela decide
                             'conciliado',            -- confirmó un pago ya pagado
                             'descartado'             -- la escuela lo descartó
                         )),
    motivo               text,
    banco                text CHECK (banco IS NULL OR banco IN ('nequi', 'bancolombia')),
    monto                numeric CHECK (monto IS NULL OR monto > 0),
    fecha                date,
    hora                 text,
    remitente            text,
    banco_origen         text,
    destino              text,
    candidate_payment_id uuid REFERENCES public.payments(id) ON DELETE SET NULL,
    matched_payment_id   uuid REFERENCES public.payments(id) ON DELETE SET NULL,
    detalle              jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at          timestamptz,
    received_at          timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_email_notices_contenido
    ON public.bank_email_notices (coalesce(message_id, ''), body_sha256);

-- Un pago se concilia con UN solo aviso: dos avisos no pueden reclamar el mismo
-- pago (ni un aviso real tapar un comprobante duplicado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_email_notices_pago_conciliado
    ON public.bank_email_notices (matched_payment_id)
    WHERE estado = 'conciliado' AND matched_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bank_email_notices_school
    ON public.bank_email_notices (school_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_email_notices_candidato
    ON public.bank_email_notices (candidate_payment_id)
    WHERE candidate_payment_id IS NOT NULL;

ALTER TABLE public.bank_email_notices ENABLE ROW LEVEL SECURITY;

-- Lectura: quien TRABAJA en la escuela (sin padres ni atletas). Sin policies de
-- escritura: escribe solo el BFF (service_role) o las RPC SECURITY DEFINER.
DROP POLICY IF EXISTS bank_email_notices_select_staff ON public.bank_email_notices;
CREATE POLICY bank_email_notices_select_staff ON public.bank_email_notices
    FOR SELECT TO authenticated
    USING (school_id = ANY (public.user_staff_school_ids()));

REVOKE ALL ON public.bank_email_notices FROM anon, authenticated;
GRANT SELECT ON public.bank_email_notices TO authenticated;
GRANT ALL ON public.bank_email_notices TO service_role;

-- ── 4a. RPC: configurar la dirección de recepción (admin de la escuela) ─────
CREATE OR REPLACE FUNCTION public.bank_email_inbox_configure(
    p_school_id uuid,
    p_mailboxes text[]
)
RETURNS TABLE (out_token text, out_mailboxes text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_clean text[];
BEGIN
    IF auth.uid() IS NULL OR NOT (p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(array_agg(DISTINCT m), '{}')
      INTO v_clean
      FROM (SELECT lower(btrim(x)) AS m FROM unnest(coalesce(p_mailboxes, '{}')) AS x) s
     WHERE m <> '';

    IF coalesce(array_length(v_clean, 1), 0) > 5 THEN
        RAISE EXCEPTION 'Máximo 5 buzones' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_clean) m
                WHERE m !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$') THEN
        RAISE EXCEPTION 'Correo inválido' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.bank_email_inboxes AS i (school_id, token, mailboxes, created_by)
    VALUES (p_school_id,
            substr(replace(gen_random_uuid()::text, '-', ''), 1, 20),
            v_clean,
            auth.uid())
    ON CONFLICT (school_id) DO UPDATE
        SET mailboxes = EXCLUDED.mailboxes, updated_at = now();

    RETURN QUERY
        SELECT i.token, i.mailboxes FROM public.bank_email_inboxes i
         WHERE i.school_id = p_school_id;
END;
$$;
REVOKE ALL ON FUNCTION public.bank_email_inbox_configure(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_email_inbox_configure(uuid, text[]) TO authenticated, service_role;

-- ── 4b. RPC: aplicar el resultado del cruce (solo BFF) ──────────────────────
-- Atómico e idempotente: solo actúa sobre un aviso en 'verificado'. Para
-- 'conciliado' re-verifica TODO bajo FOR UPDATE (el cruce del BFF leyó sin
-- candado): pago de la misma escuela, ya 'paid', conciliación sin resolver y sin
-- otro aviso que lo reclame. Si algo cambió, no concilia: deja 'ambiguo' para
-- que decida una persona.
CREATE OR REPLACE FUNCTION public.bank_email_notice_apply(
    p_notice_id  uuid,
    p_estado     text,
    p_payment_id uuid DEFAULT NULL,
    p_detalle    jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_notice public.bank_email_notices%ROWTYPE;
    v_pay    record;
BEGIN
    IF p_estado NOT IN ('sin_cruce', 'candidato', 'ambiguo', 'conciliado', 'no_es_aviso') THEN
        RAISE EXCEPTION 'Estado no aplicable: %', p_estado USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_notice FROM public.bank_email_notices
     WHERE id = p_notice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aviso no encontrado' USING ERRCODE = '02000';
    END IF;
    IF v_notice.estado <> 'verificado' THEN
        RETURN v_notice.estado;   -- ya procesado: idempotente
    END IF;

    IF p_estado IN ('candidato', 'conciliado') THEN
        IF p_payment_id IS NULL THEN
            RAISE EXCEPTION 'Falta el pago' USING ERRCODE = '22023';
        END IF;
        SELECT id, school_id, status, reconciliation_status INTO v_pay
          FROM public.payments WHERE id = p_payment_id FOR UPDATE;
        IF NOT FOUND OR v_pay.school_id IS DISTINCT FROM v_notice.school_id THEN
            RAISE EXCEPTION 'Pago de otra escuela' USING ERRCODE = '42501';
        END IF;
    END IF;

    IF p_estado = 'conciliado' THEN
        IF v_pay.status = 'paid'
           AND coalesce(v_pay.reconciliation_status, 'pendiente') = 'pendiente'
           AND NOT EXISTS (SELECT 1 FROM public.bank_email_notices n
                            WHERE n.matched_payment_id = p_payment_id
                              AND n.estado = 'conciliado') THEN
            UPDATE public.payments
               SET reconciliation_status = 'confirmado', updated_at = now()
             WHERE id = p_payment_id;
            UPDATE public.bank_email_notices
               SET estado = 'conciliado', matched_payment_id = p_payment_id,
                   detalle = coalesce(p_detalle, '{}'::jsonb), updated_at = now()
             WHERE id = p_notice_id;
            RETURN 'conciliado';
        END IF;
        UPDATE public.bank_email_notices
           SET estado = 'ambiguo', candidate_payment_id = p_payment_id,
               detalle = coalesce(p_detalle, '{}'::jsonb)
                         || jsonb_build_object('motivo_degradado', 'pago_cambio_o_ya_conciliado'),
               updated_at = now()
         WHERE id = p_notice_id;
        RETURN 'ambiguo';
    END IF;

    IF p_estado = 'candidato' AND v_pay.status NOT IN
           ('pending', 'overdue', 'awaiting_approval', 'partial', 'paid') THEN
        p_estado := 'sin_cruce';
        p_payment_id := NULL;
    END IF;

    UPDATE public.bank_email_notices
       SET estado = p_estado,
           candidate_payment_id = CASE WHEN p_estado = 'candidato' THEN p_payment_id END,
           detalle = coalesce(p_detalle, '{}'::jsonb),
           updated_at = now()
     WHERE id = p_notice_id;
    RETURN p_estado;
END;
$$;
REVOKE ALL ON FUNCTION public.bank_email_notice_apply(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_email_notice_apply(uuid, text, uuid, jsonb) TO service_role;

-- ── 4c. RPC: la escuela confirma o descarta (admin de la escuela) ───────────
-- 'confirmar' NO aprueba el pago: exige que la escuela ya lo haya aprobado por
-- el flujo normal (status='paid'); entonces lo concilia contra este aviso.
-- p_payment_id permite elegir entre los candidatos de un aviso 'ambiguo'.
CREATE OR REPLACE FUNCTION public.bank_email_notice_resolve(
    p_notice_id  uuid,
    p_accion     text,
    p_payment_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_notice public.bank_email_notices%ROWTYPE;
    v_pay_id uuid;
    v_pay    record;
BEGIN
    IF p_accion NOT IN ('confirmar', 'descartar') THEN
        RAISE EXCEPTION 'Acción inválida' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_notice FROM public.bank_email_notices
     WHERE id = p_notice_id FOR UPDATE;
    IF NOT FOUND
       OR auth.uid() IS NULL
       OR NOT (v_notice.school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_notice.estado NOT IN ('candidato', 'ambiguo', 'sin_cruce') THEN
        RAISE EXCEPTION 'El aviso ya está resuelto (%)', v_notice.estado USING ERRCODE = '55000';
    END IF;

    IF p_accion = 'descartar' THEN
        UPDATE public.bank_email_notices
           SET estado = 'descartado', resolved_by = auth.uid(), resolved_at = now(), updated_at = now()
         WHERE id = p_notice_id;
        RETURN 'descartado';
    END IF;

    v_pay_id := coalesce(p_payment_id, v_notice.candidate_payment_id);
    IF v_pay_id IS NULL THEN
        RAISE EXCEPTION 'Falta el pago' USING ERRCODE = '22023';
    END IF;

    SELECT id, school_id, status, reconciliation_status INTO v_pay
      FROM public.payments WHERE id = v_pay_id FOR UPDATE;
    IF NOT FOUND OR v_pay.school_id IS DISTINCT FROM v_notice.school_id THEN
        RAISE EXCEPTION 'Pago de otra escuela' USING ERRCODE = '42501';
    END IF;
    IF v_pay.status <> 'paid' THEN
        RAISE EXCEPTION 'Primero aprueba el pago; este aviso no lo aprueba' USING ERRCODE = '55000';
    END IF;
    IF coalesce(v_pay.reconciliation_status, 'pendiente') <> 'pendiente'
       OR EXISTS (SELECT 1 FROM public.bank_email_notices n
                   WHERE n.matched_payment_id = v_pay_id AND n.estado = 'conciliado') THEN
        RAISE EXCEPTION 'El pago ya está conciliado' USING ERRCODE = '55000';
    END IF;

    UPDATE public.payments
       SET reconciliation_status = 'confirmado', updated_at = now()
     WHERE id = v_pay_id;
    UPDATE public.bank_email_notices
       SET estado = 'conciliado', matched_payment_id = v_pay_id,
           resolved_by = auth.uid(), resolved_at = now(), updated_at = now()
     WHERE id = p_notice_id;
    RETURN 'conciliado';
END;
$$;
REVOKE ALL ON FUNCTION public.bank_email_notice_resolve(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_email_notice_resolve(uuid, text, uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
