-- =============================================================================
-- 20261103202610_campanas_aprobar_admin_plataforma.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-03   Versión anterior: 20261031121849
-- Objetivo: el administrador de plataforma (equipo SportMaps) no podía APROBAR
-- campañas de WhatsApp. La ruta del BFF ya lo deja pasar (`administraEstaEscuela`
-- pregunta a platform_admins), así que crea, simula, pausa y reanuda; pero
-- wa_campana_aprobar (20261030123555) solo aceptaba al dueño o a un
-- school_members activo owner/admin/school_admin de ESA escuela y le lanzaba
-- 'Forbidden' (42501), que el BFF devuelve como 409 'no_se_pudo_aprobar'.
--
-- Cambio: SOLO el gate de quién aprueba. Se agrega un tercer camino,
--     OR EXISTS (platform_admins WHERE profile_id = p_por AND is_active)
-- que es la misma fuente que is_platform_admin() y que administraEstaEscuela.
-- No se usa is_platform_admin(): la RPC la llama el BFF con service role y ahí
-- auth.uid() / auth.jwt() son NULL; la pregunta tiene que ser sobre p_por.
--
-- Por qué es seguro: EXECUTE sigue siendo solo de service_role (p_por lo pone el
-- BFF desde la sesión, nadie lo elige), y platform_admins no es autoasignable
-- (sus policies de escritura exigen app_metadata.platform_admin, que solo fija
-- el service role). Hoy hay 1 fila activa. Un admin desactivado (is_active =
-- false) sigue sin poder aprobar.
--
-- El resto del cuerpo es IDÉNTICO al vivo (comparado contra pg_proc.prosrc el
-- 2026-11-03: sin deriva). Las otras dos funciones de la migración original no
-- tienen gate de persona (wa_audiencia_excluidos, wa_campana_tomar_lote) y
-- crear/pausar/reanudar no pasan por RPC (las hace el BFF tras `autorizar`):
-- no hay nada más que abrir.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · CREATE OR REPLACE conserva dueño y ACL ({postgres, service_role}); el
--     REVOKE/GRANT del final solo lo reafirma (idempotente).
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
-- =============================================================================

BEGIN;

-- ── Aprobar = foto de la audiencia ───────────────────────────────────────────
-- Valida ADENTRO: campaña en 'borrador', escuela habilitada y sin pausa,
-- integración activa, p_por es dueño u owner/admin/school_admin activo de ESA
-- escuela (como adminsDeEscuela) o administrador de plataforma activo,
-- declaración si la base es contacto previo.
-- Devuelve cuántos destinatarios quedaron; con 0 la campaña sigue en borrador.
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
                          AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma',
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

COMMENT ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) IS
    'Campañas: aprueba un borrador y congela sus destinatarios. Valida escuela habilitada, admin de ESA escuela '
    '(o administrador de plataforma activo) y declaración (contacto previo). Devuelve el conteo; 0 = sigue en '
    'borrador. Solo service role. (20261030123555, gate 20261103202610)';

-- Idempotente: CREATE OR REPLACE ya conservó el ACL; se reafirma por explícito.
REVOKE ALL ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) TO service_role;

COMMIT;

-- Verificación después de aplicar (lectura):
--   select proacl, proconfig, position('platform_admins' in prosrc) > 0 as con_plataforma
--     from pg_proc where proname = 'wa_campana_aprobar';
--   → proacl {postgres=X/postgres,service_role=X/postgres}; con_plataforma = true.
