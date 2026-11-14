-- =============================================================================
-- COBROS · SEGURIDAD PENDIENTE (consolidada) — borrador 2026-10-24
-- Junta en UNA transacción las cuatro migraciones de las ramas cobros/* (10-07) que
-- nunca se aplicaron, con dos correcciones:
--   1) payments_monto_del_servidor: el monto de mensualidad que no coincide con la
--      tarifa ya NO se rechaza (PAYMENT_AMOUNT_MISMATCH): se marca amount_source='cliente'
--      y no se auto-aprueba. Solo se rechaza monto <= 0. (Medición del radio, LEEME.md.)
--   2) wa_revinculacion: wa_identify_by_phone REBASADA sobre la versión viva
--      (20261013165308), conserva teléfono solo-Colombia y atleta adulto / número del equipo.
-- Orden: 1 wa_limite_comprobantes_ocr · 2 payments_monto_del_servidor ·
--        3 wa_revinculacion_con_codigo_por_correo · 4 conciliacion_correo_banco_dkim.
-- NO EJECUTADA contra ninguna base. Un solo COMMIT: si algo falla, no queda nada a medias.
-- Aplicar UNA vez, desde UNA sesión, por CLI (db query --linked -f / migrations repair).
-- =============================================================================

BEGIN;


-- ############################################################################
-- ## PARTE 1: wa_limite_comprobantes_ocr
-- ############################################################################

-- ── Ajustes por escuela (por integración) ──────────────────────────────────
ALTER TABLE public.whatsapp_settings
    ADD COLUMN IF NOT EXISTS limite_comprobantes_ventana_min integer NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS limite_comprobantes_por_numero  integer NOT NULL DEFAULT 8,
    ADD COLUMN IF NOT EXISTS limite_comprobantes_por_escuela integer NOT NULL DEFAULT 60;

ALTER TABLE public.whatsapp_settings
    DROP CONSTRAINT IF EXISTS whatsapp_settings_limite_comprobantes_chk;
ALTER TABLE public.whatsapp_settings
    ADD CONSTRAINT whatsapp_settings_limite_comprobantes_chk CHECK (
        limite_comprobantes_ventana_min BETWEEN 5 AND 1440
        AND limite_comprobantes_por_numero BETWEEN 1 AND 1000
        AND limite_comprobantes_por_escuela BETWEEN 1 AND 10000
    );

COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_ventana_min IS
  'Ventana deslizante (minutos) del límite de comprobantes que se mandan a OCR. Ver wa_reservar_cupo_ocr.';
COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_por_numero IS
  'Máximo de archivos que se leen (OCR) por número de WhatsApp dentro de la ventana.';
COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_por_escuela IS
  'Máximo de archivos que se leen (OCR) por escuela dentro de la ventana.';

-- ── Registro de cupos ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_ocr_cupos (
    queue_id   uuid PRIMARY KEY REFERENCES public.whatsapp_inbound_queue(id) ON DELETE CASCADE,
    school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    wa_phone   text NOT NULL,
    permitido  boolean NOT NULL,
    motivo     text NOT NULL CHECK (motivo IN ('ok', 'limite_numero', 'limite_escuela')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_ocr_cupos_escuela_ventana
    ON public.wa_ocr_cupos (school_id, created_at) WHERE permitido;
CREATE INDEX IF NOT EXISTS idx_wa_ocr_cupos_numero_ventana
    ON public.wa_ocr_cupos (school_id, wa_phone, created_at) WHERE permitido;

ALTER TABLE public.wa_ocr_cupos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_ocr_cupos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.wa_ocr_cupos TO service_role;

COMMENT ON TABLE public.wa_ocr_cupos IS
  'Un cupo de OCR por fila de whatsapp_inbound_queue (permitido o frenado). Solo service_role. Ver wa_reservar_cupo_ocr.';

-- ── RPC ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_reservar_cupo_ocr(p_queue_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_q          record;
    v_tel        text;
    v_ventana    integer := 60;
    v_max_numero integer := 8;
    v_max_escuela integer := 60;
    v_prev       record;
    v_n_numero   integer;
    v_n_escuela  integer;
    v_motivo     text;
BEGIN
    SELECT id, school_id, integration_id, wa_phone_number
      INTO v_q
      FROM public.whatsapp_inbound_queue
     WHERE id = p_queue_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('permitido', false, 'motivo', 'fila_inexistente');
    END IF;

    SELECT coalesce(s.limite_comprobantes_ventana_min, 60),
           coalesce(s.limite_comprobantes_por_numero, 8),
           coalesce(s.limite_comprobantes_por_escuela, 60)
      INTO v_ventana, v_max_numero, v_max_escuela
      FROM public.whatsapp_settings s
     WHERE s.integration_id = v_q.integration_id;
    v_ventana     := coalesce(v_ventana, 60);
    v_max_numero  := coalesce(v_max_numero, 8);
    v_max_escuela := coalesce(v_max_escuela, 60);

    v_tel := regexp_replace(coalesce(v_q.wa_phone_number, ''), '[^0-9]', '', 'g');

    -- Contar + insertar serializado por escuela (ver cabecera).
    PERFORM pg_advisory_xact_lock(hashtextextended('wa_ocr_cupo:' || v_q.school_id::text, 0));

    -- Idempotente: la misma fila (reintento) devuelve la decisión que ya tuvo.
    SELECT permitido, motivo INTO v_prev FROM public.wa_ocr_cupos WHERE queue_id = p_queue_id;
    IF FOUND THEN
        RETURN jsonb_build_object('permitido', v_prev.permitido, 'motivo', v_prev.motivo, 'repetido', true);
    END IF;

    SELECT count(*) FILTER (WHERE c.wa_phone = v_tel), count(*)
      INTO v_n_numero, v_n_escuela
      FROM public.wa_ocr_cupos c
     WHERE c.school_id = v_q.school_id
       AND c.permitido
       AND c.created_at > now() - make_interval(mins => v_ventana);

    v_motivo := CASE
        WHEN v_n_numero  >= v_max_numero  THEN 'limite_numero'
        WHEN v_n_escuela >= v_max_escuela THEN 'limite_escuela'
        ELSE 'ok'
    END;

    INSERT INTO public.wa_ocr_cupos (queue_id, school_id, wa_phone, permitido, motivo)
    VALUES (p_queue_id, v_q.school_id, v_tel, v_motivo = 'ok', v_motivo);

    RETURN jsonb_build_object(
        'permitido', v_motivo = 'ok',
        'motivo', v_motivo,
        'usados_numero', v_n_numero,
        'usados_escuela', v_n_escuela,
        'ventana_min', v_ventana
    );
END;
$fn$;

COMMENT ON FUNCTION public.wa_reservar_cupo_ocr(uuid) IS
  'Reserva (atómica, idempotente por fila) un cupo de OCR para una fila de la cola de WhatsApp. Límite por número y por escuela en ventana deslizante (whatsapp_settings). Solo service_role.';

REVOKE ALL ON FUNCTION public.wa_reservar_cupo_ocr(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_reservar_cupo_ocr(uuid) TO service_role;

-- ############################################################################
-- ## PARTE 2: payments_monto_del_servidor (monto distinto = cliente, no rechazo)
-- ############################################################################

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
        IF coalesce(cardinality(v_validos), 0) > 0 AND NEW.amount = ANY (v_validos) THEN
            NEW.amount_source := 'servidor';
            RETURN NEW;
        END IF;
        -- CAMBIO 2026-10-24 (medición del radio): un monto distinto de la tarifa YA NO se
        -- rechaza. Abonos parciales y pagos de varios meses entran como 'cliente' y
        -- auto_approve_payment no los aprueba: los revisa una persona.
    END IF;

    -- Monto elegido por la familia (o sin tarifa con qué compararlo): se acepta,
    -- pero no se auto-aprueba.
    NEW.amount_source := 'cliente';
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_payments_monto_servidor() IS
  'Monto del lado del servidor para INSERT directos de quien no es staff: mensualidad = tarifa del servidor (marca como cliente lo que no coincide); resto = amount_source cliente (sin auto-aprobación). SECURITY INVOKER a propósito.';

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

-- ############################################################################
-- ## PARTE 3: wa_revinculacion_con_codigo_por_correo (REBASADA)
-- ############################################################################

ALTER TABLE public.whatsapp_identifications
    ADD COLUMN IF NOT EXISTS revinculacion_de uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS revinculacion_solicitada_at timestamptz;

COMMENT ON COLUMN public.whatsapp_identifications.revinculacion_de IS
  'Acudiente al que estaba vinculada la conversación cuando el número pasó a apuntar a otro. Con verified_at NULL = revinculación pendiente (código por correo). Queda como rastro de auditoría.';

-- ── wa_identify_by_phone ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_identify_by_phone(p_integration_id uuid, p_contact_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school_id   uuid;
    v_tel         text;
    v_ids         uuid[];
    v_parent_id   uuid;
    v_es_familia  boolean;
    v_conv_parent uuid;
    v_conv_ident  boolean;
    v_ident       public.whatsapp_identifications%ROWTYPE;
BEGIN
    SELECT school_id INTO v_school_id
    FROM public.school_whatsapp_integrations
    WHERE id = p_integration_id;

    IF v_school_id IS NULL THEN
        RETURN jsonb_build_object('estado', 'desconocido', 'motivo', 'integracion_inexistente');
    END IF;

    v_tel := public.wa_celular_remitente_co(p_contact_wa_id);

    IF v_tel IS NULL THEN
        RETURN jsonb_build_object('estado', 'desconocido', 'motivo', 'no_es_celular');
    END IF;

    SELECT array_agg(DISTINCT p.id) INTO v_ids
    FROM public.profiles p
    WHERE right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 10) = v_tel
      AND EXISTS (
            SELECT 1 FROM public.children c
            WHERE c.parent_id = p.id AND c.school_id = v_school_id AND c.is_active
      );

    -- Atleta adulto (bug 5 del informe 2026-10-13): solo si ningún acudiente
    -- tiene el número, para no volver 'ambiguo' el número de una familia que
    -- comparte celular con su hijo mayor de edad.
    IF coalesce(array_length(v_ids, 1), 0) = 0 THEN
        SELECT array_agg(DISTINCT p.id) INTO v_ids
        FROM public.profiles p
        WHERE right(regexp_replace(coalesce(p.phone,''), '[^0-9]', '', 'g'), 10) = v_tel
          AND (
                EXISTS (SELECT 1 FROM public.school_members sm
                         WHERE sm.profile_id = p.id AND sm.school_id = v_school_id
                           AND sm.role = 'athlete' AND sm.status = 'active')
             OR EXISTS (SELECT 1 FROM public.enrollments e
                         WHERE e.user_id = p.id AND e.child_id IS NULL AND e.school_id = v_school_id
                           AND e.status IN ('active', 'pending'))
             OR EXISTS (SELECT 1 FROM public.unregistered_athletes ua
                         WHERE ua.linked_profile_id = p.id AND ua.school_id = v_school_id AND ua.is_active)
          );
    END IF;

    -- Número del equipo en el perfil de otra persona.
    IF coalesce(array_length(v_ids, 1), 0) = 1 AND EXISTS (
        SELECT 1
        FROM public.school_members sm
        JOIN public.profiles s ON s.id = sm.profile_id
        WHERE sm.school_id = v_school_id
          AND sm.status = 'active'
          AND sm.role NOT IN ('parent', 'athlete')
          AND sm.profile_id <> v_ids[1]
          AND right(regexp_replace(coalesce(s.phone,''), '[^0-9]', '', 'g'), 10) = v_tel
    ) THEN
        UPDATE public.whatsapp_conversations wc
           SET parent_id = NULL, identified = false, updated_at = now()
         WHERE wc.integration_id = p_integration_id
           AND wc.contact_wa_id = p_contact_wa_id
           AND wc.identified
           AND NOT EXISTS (
                SELECT 1
                FROM public.whatsapp_identifications i
                JOIN public.profiles pv ON pv.id = wc.parent_id
                WHERE i.integration_id = p_integration_id
                  AND i.contact_wa_id = p_contact_wa_id
                  AND i.verified_at IS NOT NULL
                  AND i.email IS NOT NULL
                  AND lower(pv.email) = lower(i.email)
           );
        RETURN jsonb_build_object('estado', 'ambiguo', 'motivo', 'numero_de_personal');
    END IF;

    IF coalesce(array_length(v_ids, 1), 0) > 1 THEN
        UPDATE public.whatsapp_conversations wc
           SET parent_id = NULL, identified = false, updated_at = now()
         WHERE wc.integration_id = p_integration_id
           AND wc.contact_wa_id = p_contact_wa_id
           AND wc.identified
           AND NOT EXISTS (
                SELECT 1
                FROM public.whatsapp_identifications i
                JOIN public.profiles pv ON pv.id = wc.parent_id
                WHERE i.integration_id = p_integration_id
                  AND i.contact_wa_id = p_contact_wa_id
                  AND i.verified_at IS NOT NULL
                  AND i.email IS NOT NULL
                  AND lower(pv.email) = lower(i.email)
           );
        RETURN jsonb_build_object('estado', 'ambiguo', 'motivo', 'varias_cuentas_mismo_numero');
    END IF;

    IF coalesce(array_length(v_ids, 1), 0) = 1 THEN
        v_parent_id := v_ids[1];

        -- Se bloquea la fila de la identificación (si existe) para que dos
        -- mensajes simultáneos no abran dos revinculaciones distintas.
        SELECT * INTO v_ident
        FROM public.whatsapp_identifications
        WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id
        FOR UPDATE;

        -- (a) Revinculación ya pendiente: el teléfono NO vincula hasta el código.
        IF FOUND AND v_ident.revinculacion_de IS NOT NULL AND v_ident.verified_at IS NULL THEN
            IF v_parent_id = v_ident.revinculacion_de THEN
                -- El número volvió a ser del acudiente de antes: no hay cuenta
                -- nueva que proteger. Se cancela y sigue el camino de siempre.
                UPDATE public.whatsapp_identifications
                   SET revinculacion_de = NULL, otp_hash = NULL, otp_expires_at = NULL,
                       attempts = 0, updated_at = now()
                 WHERE id = v_ident.id;
            ELSE
                IF v_ident.parent_id IS DISTINCT FROM v_parent_id THEN
                    -- Cambió de dueño otra vez: el código anterior iba a otra cuenta.
                    UPDATE public.whatsapp_identifications
                       SET parent_id = v_parent_id, email = NULL, otp_hash = NULL,
                           otp_expires_at = NULL, attempts = 0, updated_at = now()
                     WHERE id = v_ident.id;
                END IF;
                RETURN jsonb_build_object('estado', 'revinculacion_pendiente');
            END IF;
        END IF;

        -- (b) La conversación está vinculada a OTRO acudiente: no se reescribe.
        SELECT parent_id, identified INTO v_conv_parent, v_conv_ident
        FROM public.whatsapp_conversations
        WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id
        FOR UPDATE;

        IF coalesce(v_conv_ident, false) AND v_conv_parent IS NOT NULL AND v_conv_parent <> v_parent_id THEN
            UPDATE public.whatsapp_conversations
               SET parent_id = NULL, identified = false, updated_at = now()
             WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id;

            INSERT INTO public.whatsapp_identifications (
                integration_id, contact_wa_id, parent_id, email,
                otp_hash, otp_expires_at, attempts, verified_at,
                revinculacion_de, revinculacion_solicitada_at, updated_at
            ) VALUES (
                p_integration_id, p_contact_wa_id, v_parent_id, NULL,
                NULL, NULL, 0, NULL,
                v_conv_parent, now(), now()
            )
            ON CONFLICT (integration_id, contact_wa_id) DO UPDATE SET
                parent_id = EXCLUDED.parent_id, email = NULL,
                otp_hash = NULL, otp_expires_at = NULL, attempts = 0, verified_at = NULL,
                revinculacion_de = EXCLUDED.revinculacion_de,
                revinculacion_solicitada_at = now(), updated_at = now();

            RETURN jsonb_build_object('estado', 'revinculacion_pendiente');
        END IF;

        -- Camino de siempre: mismo acudiente, o primer vínculo.
        UPDATE public.whatsapp_conversations
           SET parent_id = v_parent_id, identified = true, updated_at = now()
         WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id;

        INSERT INTO public.whatsapp_identifications (
            integration_id, contact_wa_id, parent_id, email,
            otp_hash, otp_expires_at, attempts, verified_at, updated_at
        ) VALUES (
            p_integration_id, p_contact_wa_id, v_parent_id, NULL,
            NULL, NULL, 0, now(), now()
        )
        ON CONFLICT (integration_id, contact_wa_id) DO UPDATE SET
            parent_id = EXCLUDED.parent_id, verified_at = now(), updated_at = now();

        RETURN jsonb_build_object('estado', 'identificado', 'parent_id', v_parent_id);
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.children c
        WHERE c.school_id = v_school_id
          AND c.is_active
          AND right(regexp_replace(coalesce(c.parent_phone_temp,''), '[^0-9]', '', 'g'), 10) = v_tel
    ) INTO v_es_familia;

    IF NOT v_es_familia THEN
        v_es_familia := public.wa_es_familia_sin_registrar(v_school_id, p_contact_wa_id);
    END IF;

    IF v_es_familia THEN
        RETURN jsonb_build_object('estado', 'debe_registrarse');
    END IF;

    RETURN jsonb_build_object('estado', 'desconocido', 'motivo', 'sin_coincidencia');
END;
$$;

REVOKE ALL ON FUNCTION public.wa_identify_by_phone(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_identify_by_phone(uuid, text) TO service_role;

-- ── wa_iniciar_revinculacion ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_iniciar_revinculacion(
    p_integration_id uuid,
    p_contact_wa_id  text,
    p_otp_hash       text,
    p_expires_at     timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_ident public.whatsapp_identifications%ROWTYPE;
    v_email text;
BEGIN
    IF p_otp_hash IS NULL OR length(p_otp_hash) < 32 OR p_expires_at IS NULL
       OR p_expires_at > now() + interval '30 minutes' THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'parametros_invalidos');
    END IF;

    SELECT * INTO v_ident
    FROM public.whatsapp_identifications
    WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id
    FOR UPDATE;

    IF NOT FOUND OR v_ident.revinculacion_de IS NULL OR v_ident.verified_at IS NOT NULL
       OR v_ident.parent_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'sin_revinculacion');
    END IF;

    SELECT nullif(lower(trim(email)), '') INTO v_email
    FROM public.profiles WHERE id = v_ident.parent_id;

    IF v_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'sin_correo');
    END IF;

    -- Un código vigente no se pisa: ni se reenvía en cada mensaje ni, agotados
    -- los 5 intentos de wa_verify_otp, se regala un código nuevo enseguida (se
    -- espera a que venza: frena la fuerza bruta código tras código).
    IF v_ident.otp_hash IS NOT NULL AND v_ident.otp_expires_at > now() THEN
        RETURN jsonb_build_object('ok', false, 'motivo', 'codigo_vigente', 'email', v_email);
    END IF;

    UPDATE public.whatsapp_identifications
       SET email = v_email, otp_hash = p_otp_hash, otp_expires_at = p_expires_at,
           attempts = 0, updated_at = now()
     WHERE id = v_ident.id;

    RETURN jsonb_build_object('ok', true, 'email', v_email);
END;
$fn$;

COMMENT ON FUNCTION public.wa_iniciar_revinculacion(uuid, text, text, timestamptz) IS
  'Desafío de la revinculación de un número a otro acudiente: guarda el hash del código y devuelve el correo del acudiente NUEVO para que el BFF lo envíe. Solo con revinculación pendiente. Solo service_role.';

REVOKE ALL ON FUNCTION public.wa_iniciar_revinculacion(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_iniciar_revinculacion(uuid, text, text, timestamptz) TO service_role;

-- ############################################################################
-- ## PARTE 4: conciliacion_correo_banco_dkim
-- ############################################################################

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
