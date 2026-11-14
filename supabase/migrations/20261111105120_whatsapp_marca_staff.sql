-- =============================================================================
-- 20261111105120_whatsapp_marca_staff.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-11   Versión anterior: 20261103202610
-- Objetivo: marca MANUAL «Staff» para contactos de WhatsApp de una escuela.
--
-- Problema: el staff cuyo celular no está en su perfil (profe, secretaria,
-- auxiliar) cae como «desconocido» y el bot lo trata como prospecto. `staff`
-- ya existe como valor AUTOMÁTICO de contact_kind (owner/admin/profes con
-- teléfono): no sirve como marca manual porque (a) la clasificación automática
-- lo pisa en el siguiente mensaje y (b) las marcas manuales no guardan contenido
-- ni siguen la rama de alta por foto de matrícula de los admins reales.
--
-- Solución: valor NUEVO `equipo` (la UI lo muestra como «Staff»). Se comporta
-- como las otras cuatro marcas manuales: no es familia, el bot no le habla, no
-- se guarda contenido, sus adjuntos no se procesan y sus filas de la bandeja se
-- cierran. Admite «también es familia» (el profe que además es papá).
--
-- Qué hace:
--   1. Amplía el CHECK de whatsapp_conversations.contact_kind con 'equipo'.
--   2. Reemplaza wa_campana_aprobar y wa_campana_tomar_lote: su lista de
--      contact_kind excluidos suma 'equipo'; sin esto el staff marcado recibiría
--      campañas. Cuerpos IDÉNTICOS a los vivos (20261103202610 y 20261030123555)
--      salvo esa lista. CREATE OR REPLACE conserva dueño y ACL.
--
-- Sin RLS ni funciones nuevas. Idempotente.
-- =============================================================================
-- Recordatorios (CLAUDE.md): inmutable; search_path fijo (ya en los cuerpos);
-- ACL solo service_role (se reafirma al final).
-- =============================================================================

BEGIN;

-- 1. CHECK ---------------------------------------------------------------------
ALTER TABLE public.whatsapp_conversations
    DROP CONSTRAINT IF EXISTS whatsapp_conversations_contact_kind_check;

ALTER TABLE public.whatsapp_conversations
    ADD CONSTRAINT whatsapp_conversations_contact_kind_check
    CHECK (contact_kind IS NULL OR contact_kind IN (
        'familia', 'familia_sin_cuenta', 'ambiguo', 'staff', 'desconocido',
        -- Marcas MANUALES (las pone la escuela; mandan sobre la clasificación):
        'personal', 'negocio', 'otro_club', 'plataforma',
        'equipo'               -- staff marcado a mano (la UI dice «Staff»)
    ));

COMMENT ON COLUMN public.whatsapp_conversations.contact_kind IS
    'Quién es el contacto. Automático (whatsapp-atencion.service): familia|familia_sin_cuenta|ambiguo|staff|desconocido. '
    'Marca manual de la escuela, manda sobre lo automático: personal|negocio|otro_club|plataforma|equipo '
    '(no es familia: el bot no le habla, no se guarda contenido, sus filas no cuentan en la bandeja). NULL = sin clasificar.';

-- 2. Campañas: excluir también 'equipo' ---------------------------------------
CREATE OR REPLACE FUNCTION public.wa_campana_aprobar(p_campana_id uuid, p_por uuid, p_declaracion text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_c    public.whatsapp_campanas%ROWTYPE;
    v_aj   public.whatsapp_campanas_ajustes%ROWTYPE;
    v_decl text := NULLIF(btrim(COALESCE(p_declaracion, '')), '');
    v_int  text[];
    v_br   uuid[];
    v_n    int;
BEGIN
    SELECT * INTO v_c FROM public.whatsapp_campanas WHERE id = p_campana_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CAMPANA_NO_EXISTE' USING ERRCODE = 'P0002';
    END IF;
    IF v_c.estado <> 'borrador' THEN
        RAISE EXCEPTION 'CAMPANA_NO_ES_BORRADOR' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_aj FROM public.whatsapp_campanas_ajustes WHERE school_id = v_c.school_id;
    IF NOT FOUND OR NOT v_aj.habilitadas OR v_aj.pausada_at IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANAS_DESHABILITADAS' USING ERRCODE = '55000';
    END IF;

    -- Quién aprueba: administración de ESA escuela, o el equipo de plataforma
    -- (20261103202610). Sobre p_por, no auth.uid(): el caller es el service role.
    IF p_por IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.schools s WHERE s.id = v_c.school_id AND s.owner_id = p_por)
        OR EXISTS (SELECT 1 FROM public.school_members sm
                    WHERE sm.school_id = v_c.school_id AND sm.profile_id = p_por
                      AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin'))
        OR EXISTS (SELECT 1 FROM public.platform_admins pa
                    WHERE pa.profile_id = p_por AND pa.is_active)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.school_whatsapp_integrations i
                    WHERE i.id = v_c.integration_id AND i.school_id = v_c.school_id AND i.status = 'active') THEN
        RAISE EXCEPTION 'INTEGRACION_INACTIVA' USING ERRCODE = '55000';
    END IF;
    IF v_c.vence_at IS NOT NULL AND v_c.vence_at <= now() THEN
        RAISE EXCEPTION 'CAMPANA_VENCIDA' USING ERRCODE = '55000';
    END IF;
    IF v_aj.base_consentimiento = 'contacto_previo_declarado' AND v_decl IS NULL THEN
        RAISE EXCEPTION 'DECLARACION_REQUERIDA' USING ERRCODE = '22023';
    END IF;
    IF v_decl IS NOT NULL AND length(v_decl) > 2000 THEN
        RAISE EXCEPTION 'DECLARACION_DEMASIADO_LARGA' USING ERRCODE = '22023';
    END IF;

    v_int := ARRAY(SELECT jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_c.filtro->'intereses') = 'array' THEN v_c.filtro->'intereses'
                            ELSE '[]'::jsonb END));
    v_br  := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_c.filtro->'branch_ids') = 'array' THEN v_c.filtro->'branch_ids'
                            ELSE '[]'::jsonb END) x);

    INSERT INTO public.whatsapp_campana_envios (campana_id, integration_id, school_id, contact_wa_id)
    SELECT v_c.id, a.integration_id, a.school_id, a.contact_wa_id
      FROM public.whatsapp_audiencia a
     WHERE a.integration_id = v_c.integration_id
       AND a.school_id = v_c.school_id
       AND a.excluido IS NULL
       AND (cardinality(v_int) = 0 OR a.intereses && v_int)
       AND (cardinality(v_br) = 0 OR a.branch_id = ANY (v_br))
       -- Contacto previo: solo quien escribió dentro de la antigüedad máxima.
       AND (v_aj.base_consentimiento <> 'contacto_previo_declarado'
            OR a.ultimo_entrante_at >= now() - make_interval(days => v_aj.antiguedad_max_dias))
       -- Opt-in: solo con consentimiento vigente.
       AND (v_aj.base_consentimiento <> 'optin'
            OR public.wa_can_send_template(a.integration_id, a.contact_wa_id))
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_optins o
                        WHERE o.integration_id = a.integration_id AND o.contact_wa_id = a.contact_wa_id
                          AND o.opted_out_at IS NOT NULL)
       AND NOT public.wa_is_blocked(a.integration_id, a.contact_wa_id)
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_conversations wc
                        WHERE wc.integration_id = a.integration_id AND wc.contact_wa_id = a.contact_wa_id
                          AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma', 'equipo',
                                                  'staff', 'familia', 'familia_sin_cuenta'))
    ON CONFLICT (campana_id, contact_wa_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    IF v_n = 0 THEN
        RETURN 0;
    END IF;

    UPDATE public.whatsapp_campanas
       SET estado = 'aprobada', destinatarios = v_n, aprobada_por = p_por, aprobada_at = now(),
           declaracion_version = v_decl, updated_at = now()
     WHERE id = v_c.id;

    RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.wa_campana_tomar_lote(p_campana_id uuid, p_max int, p_limite_meta int)
RETURNS SETOF public.whatsapp_campana_envios
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_c        public.whatsapp_campanas%ROWTYPE;
    v_aj       public.whatsapp_campanas_ajustes%ROWTYPE;
    v_inicio   timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota';
    v_meta     int;
    v_hoy_int  int;
    v_hoy_camp int;
    v_cupo     int;
    v_tomados  int := 0;
    v_motivo   text;
    v_row      public.whatsapp_campana_envios%ROWTYPE;
    r          record;
BEGIN
    IF p_campana_id IS NULL OR COALESCE(p_max, 0) < 1 OR COALESCE(p_limite_meta, 0) < 1 THEN
        RETURN;
    END IF;

    SELECT * INTO v_c FROM public.whatsapp_campanas WHERE id = p_campana_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('wa_campana:' || v_c.integration_id::text, 0));

    -- Releer con el candado tomado (otro BFF pudo cambiarla).
    SELECT * INTO v_c FROM public.whatsapp_campanas WHERE id = p_campana_id FOR UPDATE;
    IF v_c.estado NOT IN ('aprobada', 'enviando') THEN
        RETURN;
    END IF;

    SELECT * INTO v_aj FROM public.whatsapp_campanas_ajustes WHERE school_id = v_c.school_id;
    IF NOT FOUND OR NOT v_aj.habilitadas OR v_aj.pausada_at IS NOT NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.school_whatsapp_integrations i
                    WHERE i.id = v_c.integration_id AND i.school_id = v_c.school_id AND i.status = 'active') THEN
        RETURN;
    END IF;

    -- Lease vencido: no se sabe si salió. No se reenvía.
    UPDATE public.whatsapp_campana_envios
       SET estado = 'incierto', motivo = 'lease_vencido', lease_hasta = NULL, updated_at = now()
     WHERE campana_id = v_c.id AND estado = 'enviando' AND lease_hasta < now();

    -- Campaña vencida (fechas en el texto de la plantilla): lo pendiente se omite.
    IF v_c.vence_at IS NOT NULL AND v_c.vence_at <= now() THEN
        UPDATE public.whatsapp_campana_envios
           SET estado = 'omitido', motivo = 'campana_vencida', updated_at = now()
         WHERE campana_id = v_c.id AND estado = 'pendiente';
        UPDATE public.whatsapp_campanas SET estado = 'terminada', updated_at = now() WHERE id = v_c.id;
        RETURN;
    END IF;

    -- Cupo.
    SELECT (SELECT count(DISTINCT m.to_wa_id)
              FROM public.whatsapp_messages m
             WHERE m.integration_id = v_c.integration_id
               AND m.direction = 'outbound' AND m.type = 'template'
               AND m.created_at > now() - interval '24 hours')
         + (SELECT count(*) FROM public.whatsapp_campana_envios e
             WHERE e.integration_id = v_c.integration_id AND e.estado = 'enviando')
      INTO v_meta;
    SELECT count(*) INTO v_hoy_int
      FROM public.whatsapp_campana_envios e
     WHERE e.integration_id = v_c.integration_id
       AND (e.estado = 'enviando' OR e.enviado_at >= v_inicio);

    v_cupo := LEAST(p_max, 1000, p_limite_meta - v_meta, v_aj.tope_diario_max - v_hoy_int);

    -- Primer día de envío de la campaña: lote piloto.
    IF NOT EXISTS (SELECT 1 FROM public.whatsapp_campana_envios e
                    WHERE e.campana_id = v_c.id AND e.enviado_at < v_inicio) THEN
        SELECT count(*) INTO v_hoy_camp
          FROM public.whatsapp_campana_envios e
         WHERE e.campana_id = v_c.id AND (e.estado = 'enviando' OR e.enviado_at >= v_inicio);
        v_cupo := LEAST(v_cupo, v_aj.lote_piloto - v_hoy_camp);
    END IF;

    IF v_cupo > 0 THEN
        FOR r IN
            SELECT e.id, e.contact_wa_id
              FROM public.whatsapp_campana_envios e
             WHERE e.campana_id = v_c.id
               AND e.estado = 'pendiente'
               AND (e.proximo_intento_at IS NULL OR e.proximo_intento_at <= now())
             ORDER BY e.proximo_intento_at NULLS FIRST, e.created_at, e.id
             LIMIT LEAST(v_cupo * 3, 1000)
               FOR UPDATE OF e SKIP LOCKED
        LOOP
            EXIT WHEN v_tomados >= v_cupo;

            v_motivo := CASE
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_optins o
                              WHERE o.integration_id = v_c.integration_id AND o.contact_wa_id = r.contact_wa_id
                                AND o.opted_out_at IS NOT NULL) THEN 'baja'
                WHEN public.wa_is_blocked(v_c.integration_id, r.contact_wa_id) THEN 'bloqueado'
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_conversations wc
                              WHERE wc.integration_id = v_c.integration_id AND wc.contact_wa_id = r.contact_wa_id
                                AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma', 'equipo',
                                                        'staff', 'familia', 'familia_sin_cuenta')) THEN 'marca_manual'
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_audiencia a
                              WHERE a.integration_id = v_c.integration_id AND a.contact_wa_id = r.contact_wa_id
                                AND a.excluido IS NOT NULL) THEN 'excluido'
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_campana_envios e2
                              WHERE e2.integration_id = v_c.integration_id AND e2.contact_wa_id = r.contact_wa_id
                                AND e2.campana_id <> v_c.id
                                AND e2.enviado_at > now() - make_interval(days => v_aj.frecuencia_min_dias)) THEN 'frecuencia'
                WHEN v_aj.base_consentimiento = 'optin'
                     AND NOT public.wa_can_send_template(v_c.integration_id, r.contact_wa_id) THEN 'sin_optin'
            END;

            IF v_motivo IS NOT NULL THEN
                UPDATE public.whatsapp_campana_envios
                   SET estado = 'omitido', motivo = v_motivo, updated_at = now()
                 WHERE id = r.id;
            ELSE
                UPDATE public.whatsapp_campana_envios
                   SET estado = 'enviando', lease_hasta = now() + interval '10 minutes',
                       intentos = intentos + 1, motivo = NULL, updated_at = now()
                 WHERE id = r.id
                RETURNING * INTO v_row;
                v_tomados := v_tomados + 1;
                RETURN NEXT v_row;
            END IF;
        END LOOP;
    END IF;

    IF v_tomados > 0 AND v_c.estado = 'aprobada' THEN
        UPDATE public.whatsapp_campanas SET estado = 'enviando', updated_at = now() WHERE id = v_c.id;
    ELSIF NOT EXISTS (SELECT 1 FROM public.whatsapp_campana_envios e
                       WHERE e.campana_id = v_c.id AND e.estado IN ('pendiente', 'enviando')) THEN
        UPDATE public.whatsapp_campanas SET estado = 'terminada', updated_at = now() WHERE id = v_c.id;
    END IF;

    RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int) TO service_role;

COMMIT;

-- Verificación después de aplicar (lectura, por nombre):
--   select position($$'equipo'$$ in prosrc) > 0 as con_equipo, proacl
--     from pg_proc where proname in ('wa_campana_aprobar','wa_campana_tomar_lote');
--   → con_equipo = true en las dos; proacl {postgres=X/postgres,service_role=X/postgres}.
