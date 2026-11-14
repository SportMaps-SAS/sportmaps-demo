-- =============================================================================
-- 20261112171236_agendar_clase_prueba_desde_chat.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-12   Versión anterior: 20261112143719
-- Objetivo: botón «Agendar» en el buzón de WhatsApp. Una sola RPC transaccional
--   que, desde una conversación, deja al prospecto con cupo de clase de prueba
--   (y, si hay monto, con su pago). Antes había que hacerlo con SQL a mano: el
--   caso de Alisson Junco (Monster, 2026-11-12) llegó con alias de Meta, sin
--   teléfono, y `submit_school_lead` exige 7+ dígitos.
-- =============================================================================
-- Reglas que respeta:
--   · Multi-fila = RPC transaccional (prospecto + cupo + pago en una transacción).
--   · Alcance del caller validado ADENTRO contra la escuela de la conversación:
--     staff agenda; solo admin registra el pago (igual que registrar_pago_clase_prueba).
--   · Funciona con contactos sin teléfono (alias `wau-…`): el prospecto usa el
--     contact_wa_id de la conversación como phone.
--   · Reagendar: si el prospecto ya tenía otro cupo, lo libera.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.agendar_clase_prueba_desde_chat(
    p_conversation_id uuid,
    p_slot_id         uuid,
    p_nombre          text,
    p_fecha_nacimiento date DEFAULT NULL,
    p_genero          text DEFAULT NULL,
    p_acudiente       text DEFAULT NULL,
    p_monto           numeric DEFAULT NULL,
    p_metodo          text DEFAULT NULL,
    p_referencia      text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_conv     public.whatsapp_conversations%ROWTYPE;
    v_slot     public.school_trial_slots%ROWTYPE;
    v_lead     public.school_signup_leads%ROWTYPE;
    v_slug     text;
    v_nombre   text := NULLIF(btrim(COALESCE(p_nombre, '')), '');
    v_genero   text := NULLIF(btrim(COALESCE(p_genero, '')), '');
    v_hoy      date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_edad     int;
    v_cat      text;
    v_ref      text := NULLIF(btrim(COALESCE(p_referencia, '')), '');
    v_pago_id  uuid;
    v_liberado uuid;
    v_existe   boolean;
BEGIN
    IF v_nombre IS NULL THEN
        RAISE EXCEPTION 'NOMBRE_REQUERIDO' USING ERRCODE = '22023';
    END IF;
    IF v_genero IS NOT NULL AND v_genero NOT IN ('M', 'F') THEN
        RAISE EXCEPTION 'GENERO_INVALIDO' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_conv FROM public.whatsapp_conversations WHERE id = p_conversation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversación no encontrada' USING ERRCODE = '02000';
    END IF;

    -- El alcance se ata a la escuela de ESA conversación.
    IF NOT (public.is_super_admin() OR v_conv.school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_monto IS NOT NULL AND NOT (public.is_super_admin() OR public.is_school_admin(v_conv.school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501',
            HINT = 'Solo el administrador de la escuela registra pagos.';
    END IF;
    IF p_monto IS NOT NULL THEN
        IF p_monto <= 0 THEN
            RAISE EXCEPTION 'MONTO_INVALIDO' USING ERRCODE = '22023';
        END IF;
        IF p_metodo IS NULL OR p_metodo NOT IN ('cash', 'transfer', 'card', 'other') THEN
            RAISE EXCEPTION 'METODO_INVALIDO' USING ERRCODE = '22023';
        END IF;
    END IF;

    SELECT * INTO v_slot FROM public.school_trial_slots
     WHERE id = p_slot_id AND school_id = v_conv.school_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CUPO_NO_EXISTE' USING ERRCODE = '22023';
    END IF;
    IF NOT v_slot.is_open OR v_slot.slot_date < v_hoy THEN
        RAISE EXCEPTION 'CUPO_NO_DISPONIBLE' USING ERRCODE = '22023';
    END IF;

    -- Prospecto de la conversación: por id de conversación y, si no, por teléfono/alias.
    SELECT * INTO v_lead FROM public.school_signup_leads
     WHERE school_id = v_conv.school_id
       AND status IN ('new', 'contacted')
       AND (source_detail->>'conversation_id' = v_conv.id::text OR phone = v_conv.contact_wa_id)
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    v_existe := FOUND;

    IF v_existe AND v_lead.trial_slot_id = p_slot_id THEN
        RETURN jsonb_build_object('ok', true, 'lead_id', v_lead.id, 'ya_agendada', true);
    END IF;
    IF v_slot.reserved_count >= v_slot.max_capacity THEN
        RAISE EXCEPTION 'CUPO_LLENO' USING ERRCODE = '22023';
    END IF;

    IF p_fecha_nacimiento IS NOT NULL THEN
        v_edad := EXTRACT(YEAR FROM age(v_hoy, p_fecha_nacimiento))::int;
        v_cat := CASE
            WHEN v_edad <= 10 THEN 'Sub-11' WHEN v_edad <= 12 THEN 'Sub-13'
            WHEN v_edad <= 14 THEN 'Sub-15' WHEN v_edad <= 16 THEN 'Sub-17'
            WHEN v_edad <= 19 THEN 'Sub-20' ELSE 'Senior' END;
    END IF;

    IF NOT v_existe THEN
        SELECT slug INTO v_slug FROM public.schools WHERE id = v_conv.school_id;
        INSERT INTO public.school_signup_leads (
            school_id, source_slug, full_name, guardian_name, phone, gender, birth_date,
            suggested_category, how_heard, status, source_detail
        ) VALUES (
            v_conv.school_id, v_slug, v_nombre, NULLIF(btrim(COALESCE(p_acudiente, '')), ''),
            v_conv.contact_wa_id, v_genero, p_fecha_nacimiento, v_cat, 'whatsapp', 'contacted',
            jsonb_build_object('canal', 'whatsapp', 'conversation_id', v_conv.id,
                               'origen', 'agendada_desde_chat')
        ) RETURNING * INTO v_lead;
    ELSE
        -- Reagendar: libera el cupo anterior.
        IF v_lead.trial_slot_id IS NOT NULL THEN
            v_liberado := v_lead.trial_slot_id;
            UPDATE public.school_trial_slots
               SET reserved_count = GREATEST(reserved_count - 1, 0)
             WHERE id = v_liberado;
        END IF;
        UPDATE public.school_signup_leads SET
            full_name = v_nombre,
            guardian_name = COALESCE(NULLIF(btrim(COALESCE(p_acudiente, '')), ''), guardian_name),
            gender = COALESCE(v_genero, gender),
            birth_date = COALESCE(p_fecha_nacimiento, birth_date),
            suggested_category = COALESCE(v_cat, suggested_category),
            status = 'contacted'
         WHERE id = v_lead.id
        RETURNING * INTO v_lead;
    END IF;

    UPDATE public.school_signup_leads SET
        trial_slot_id = p_slot_id,
        source_detail = COALESCE(source_detail, '{}'::jsonb)
            || jsonb_build_object('agendada_manual', true, 'fecha_clase', v_slot.slot_date::text,
                                  'agendada_por', auth.uid(), 'agendada_at', now())
     WHERE id = v_lead.id;

    UPDATE public.school_trial_slots SET reserved_count = reserved_count + 1 WHERE id = p_slot_id;

    IF p_monto IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.payments
                    WHERE signup_lead_id = v_lead.id AND payment_category = 'clase_prueba'
                      AND status IN ('paid', 'partial', 'awaiting_approval', 'pending', 'overdue')) THEN
            RAISE EXCEPTION 'CLASE_PRUEBA_YA_PAGADA' USING ERRCODE = '23505';
        END IF;
        INSERT INTO public.payments (
            school_id, signup_lead_id, amount, amount_paid, concept, due_date, payment_date,
            status, payment_type, payment_method, payment_category, period_uniqueness_exempt,
            created_by, approved_by, approved_at, notes
        ) VALUES (
            v_conv.school_id, v_lead.id, p_monto, p_monto, 'Clase de prueba — ' || v_nombre,
            v_slot.slot_date, v_hoy, 'paid', 'one_time', p_metodo, 'clase_prueba', true,
            auth.uid(), auth.uid(), now(),
            CASE WHEN v_ref IS NOT NULL THEN left('Referencia: ' || v_ref, 500) END
        ) RETURNING id INTO v_pago_id;
    END IF;

    RETURN jsonb_build_object('ok', true, 'lead_id', v_lead.id, 'payment_id', v_pago_id,
                              'slot_id', p_slot_id, 'cupo_liberado', v_liberado);
END;
$$;

REVOKE ALL ON FUNCTION public.agendar_clase_prueba_desde_chat(uuid, uuid, text, date, text, text, numeric, text, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.agendar_clase_prueba_desde_chat(uuid, uuid, text, date, text, text, numeric, text, text)
    TO authenticated;

COMMIT;
