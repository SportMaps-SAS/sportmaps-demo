-- =============================================================================
-- REBASADA 2026-10-24 sobre la versión VIVA de wa_identify_by_phone (20261013165308).
-- La original (10-07) se escribió sobre la versión del 09-22 y habría borrado:
--   · el teléfono solo-Colombia (wa_celular_remitente_co, 20261008164914)
--   · «atleta adulto» y «número del equipo» (bug 5 del informe 10-13)
-- Merge de tres vías (base 20260922130832 · develop vivo · esta migración); 4 conflictos
-- resueltos a favor de develop (delimitador, chequeo `v_tel IS NULL`, bloque atleta adulto).
-- BORRADOR: verificado estáticamente (variables, IF/END IF) y NO ejecutado en la base.
-- Revisar el cuerpo línea por línea antes de aplicar (es la puerta de identidad de WhatsApp).
-- =============================================================================
-- =============================================================================
-- 20261007163135_wa_revinculacion_con_codigo_por_correo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-07   Versión anterior: 20261007163134
-- Objetivo: pendiente 2 de docs/cierre-seguridad-ia-pagos-2026-10-05.md. Cuando
--   el número de una conversación YA vinculada pasa a apuntar (por
--   profiles.phone) a OTRO acudiente, wa_identify_by_phone reescribía el
--   vínculo en silencio y el bot le entregaba al que escribe el estado de pagos,
--   montos y nombres de atletas de la cuenta nueva. Número reasignado, SIM-swap
--   o un perfil que se cargó con un teléfono ajeno: nadie probaba ser el dueño
--   de esa cuenta.
--
--   Ahora, en ese caso (y SOLO en ese: el camino feliz —mismo número, mismo
--   acudiente, o primer vínculo— no cambia):
--   · la conversación se DESVINCULA (no se ve ni la cuenta vieja ni la nueva),
--   · queda una revinculación pendiente en whatsapp_identifications
--     (revinculacion_de = el acudiente anterior, parent_id = el nuevo), y
--   · la RPC responde estado 'revinculacion_pendiente' hasta que el código que
--     se manda al CORREO del acudiente nuevo se verifique con wa_verify_otp
--     (que ya vincula la conversación al parent_id de la identificación).
--   Un código por el mismo WhatsApp no frenaría un SIM-swap: va al correo.
--
--   wa_iniciar_revinculacion genera el desafío SOLO si hay una revinculación
--   pendiente (no sirve para mandar códigos a cuentas arbitrarias), no pisa un
--   código vigente y devuelve el correo al BFF (service_role) para enviarlo.
--
--   Cuerpo base de wa_identify_by_phone: el VIVO al 2026-10-07 (= 20260922130832).
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

COMMIT;
