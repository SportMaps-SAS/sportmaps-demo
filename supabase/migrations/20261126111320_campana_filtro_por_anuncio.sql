-- =============================================================================
-- 20261126111320_campana_filtro_por_anuncio.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261125170908
-- Objetivo: campañas de RETOMA a quienes escribieron por un anuncio y no compraron
--   (Monster, 2026-11-26: 180 contactos por anuncio en 30 días; solo 41 estaban
--   en whatsapp_audiencia, porque la audiencia solo guarda a quien escribió con
--   una intención clara).
--   wa_campana_aprobar acepta filtro.anuncio = {contiene: [...], excluye: [...]}:
--   la foto sale de whatsapp_atribucion (texto del anuncio: titular y cuerpo),
--   con las MISMAS exclusiones de siempre (familias/staff/inscritos vía
--   wa_audiencia_excluidos, excluidos de la audiencia, baja/promos/bloqueo,
--   compradores del servicio, tipos de contacto, opt-in según la base) y la
--   antigüedad máxima aplicada a la fecha del anuncio. No se mezcla con
--   intereses ni sedes (FILTRO_ANUNCIO_EXCLUSIVO). Con base «contacto previo»
--   el anuncio con `contiene` cuenta como el interés concreto.
--   Firma, SECURITY DEFINER, search_path y permisos: los de antes (CREATE OR
--   REPLACE conserva el ACL: solo service_role).
-- =============================================================================
-- Recordatorios (CLAUDE.md): inmutable una vez commiteada.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wa_campana_aprobar(p_campana_id uuid, p_por uuid, p_declaracion_version text, p_declaracion_texto text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $fn$
DECLARE
    v_c     public.whatsapp_campanas%ROWTYPE;
    v_aj    public.whatsapp_campanas_ajustes%ROWTYPE;
    v_ver   text := NULLIF(btrim(COALESCE(p_declaracion_version, '')), '');
    v_txt   text := NULLIF(btrim(COALESCE(p_declaracion_texto, '')), '');
    v_ptxt  text;
    v_comp  jsonb;
    v_compradores text[] := '{}';
    v_email text;
    v_int   text[];
    v_br    uuid[];
    v_n     int;
    -- (2026-11-26) Filtro por anuncio: quien escribió por un anuncio (clic a WhatsApp) cuyo texto contiene alguna
    -- de `contiene` (o cualquiera si va vacío) y ninguna de `excluye`. Reemplaza a la audiencia clasificada.
    v_an     jsonb;
    v_an_si  text[] := '{}';
    v_an_no  text[] := '{}';
    v_cands  text[] := '{}';
    v_fuera  text[] := '{}';
    v_i      int;
BEGIN
    SELECT * INTO v_c FROM public.whatsapp_campanas WHERE id = p_campana_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CAMPANA_NO_EXISTE' USING ERRCODE = 'P0002';
    END IF;
    IF v_c.estado <> 'borrador' THEN
        RAISE EXCEPTION 'CAMPANA_NO_ES_BORRADOR' USING ERRCODE = '55000';
    END IF;

    IF EXISTS (SELECT 1 FROM public.whatsapp_campanas_freno_global g WHERE g.pausada_at IS NOT NULL) THEN
        RAISE EXCEPTION 'CAMPANAS_EN_PAUSA_GLOBAL' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO v_aj FROM public.whatsapp_campanas_ajustes WHERE school_id = v_c.school_id;
    IF NOT FOUND OR NOT v_aj.habilitadas OR v_aj.pausada_at IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANAS_DESHABILITADAS' USING ERRCODE = '55000';
    END IF;

    -- Quién aprueba: SOLO la administración de ESA escuela (sobre p_por: el caller es
    -- el service role). El administrador de plataforma ya no aprueba por la escuela.
    IF p_por IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.schools s WHERE s.id = v_c.school_id AND s.owner_id = p_por)
        OR EXISTS (SELECT 1 FROM public.school_members sm
                    WHERE sm.school_id = v_c.school_id AND sm.profile_id = p_por
                      AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin'))) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    -- La escuela aceptó la declaración al activar…
    IF NOT EXISTS (SELECT 1 FROM public.whatsapp_campanas_declaraciones d
                    WHERE d.school_id = v_c.school_id AND d.tipo = 'activacion') THEN
        RAISE EXCEPTION 'DECLARACION_DE_ACTIVACION_REQUERIDA' USING ERRCODE = '55000';
    END IF;
    -- …y acepta una por cada campaña, sea cual sea la base de consentimiento.
    IF v_ver IS NULL OR length(v_ver) > 40 OR v_txt IS NULL OR length(v_txt) NOT BETWEEN 20 AND 2000 THEN
        RAISE EXCEPTION 'DECLARACION_REQUERIDA' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.school_whatsapp_integrations i
                    WHERE i.id = v_c.integration_id AND i.school_id = v_c.school_id AND i.status = 'active') THEN
        RAISE EXCEPTION 'INTEGRACION_INACTIVA' USING ERRCODE = '55000';
    END IF;

    -- La plantilla tiene que estar APROBADA en Meta (espejo whatsapp_template_status, en la WABA
    -- actual de la integración): una plantilla en revisión o rechazada hace fallar cada envío, y
    -- los fallos cuentan para el freno. De ahí sale también el texto que queda en la declaración.
    SELECT t.components INTO v_comp
      FROM public.whatsapp_template_status t
      JOIN public.school_whatsapp_integrations i ON i.id = t.integration_id
     WHERE t.integration_id = v_c.integration_id AND t.name = v_c.plantilla AND t.language = v_c.idioma
       AND t.status = 'APPROVED' AND (i.waba_id IS NULL OR t.waba_id = i.waba_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'PLANTILLA_NO_APROBADA' USING ERRCODE = '55000';
    END IF;
    IF jsonb_typeof(v_comp) = 'array' THEN
        SELECT NULLIF(btrim(x->>'text'), '') INTO v_ptxt
          FROM jsonb_array_elements(v_comp) x
         WHERE upper(x->>'type') = 'BODY'
         LIMIT 1;
    END IF;
    v_ptxt := left(COALESCE(v_ptxt, v_c.plantilla), 4000);
    IF v_c.vence_at IS NOT NULL AND v_c.vence_at <= now() THEN
        RAISE EXCEPTION 'CAMPANA_VENCIDA' USING ERRCODE = '55000';
    END IF;

    v_int := ARRAY(SELECT jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_c.filtro->'intereses') = 'array' THEN v_c.filtro->'intereses'
                            ELSE '[]'::jsonb END));
    v_br  := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_c.filtro->'branch_ids') = 'array' THEN v_c.filtro->'branch_ids'
                            ELSE '[]'::jsonb END) x);
    v_an := CASE WHEN jsonb_typeof(v_c.filtro->'anuncio') = 'object' THEN v_c.filtro->'anuncio' END;
    IF v_an IS NOT NULL THEN
        v_an_si := ARRAY(SELECT lower(btrim(x)) FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_an->'contiene') = 'array' THEN v_an->'contiene' ELSE '[]'::jsonb END) x
                     WHERE btrim(x) <> '');
        v_an_no := ARRAY(SELECT lower(btrim(x)) FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(v_an->'excluye') = 'array' THEN v_an->'excluye' ELSE '[]'::jsonb END) x
                     WHERE btrim(x) <> '');
        -- El anuncio es el filtro: no se mezcla con intereses ni sedes de la audiencia clasificada.
        IF cardinality(v_int) > 0 OR cardinality(v_br) > 0 THEN
            RAISE EXCEPTION 'FILTRO_ANUNCIO_EXCLUSIVO' USING ERRCODE = '22023';
        END IF;
    END IF;
    -- Con la base «contacto previo» la campaña va a un interés concreto (o a quienes llegaron por un
    -- anuncio concreto), nunca a toda la lista.
    IF v_aj.base_consentimiento = 'contacto_previo_declarado' AND cardinality(v_int) = 0
       AND (v_an IS NULL OR cardinality(v_an_si) = 0) THEN
        RAISE EXCEPTION 'INTERES_REQUERIDO' USING ERRCODE = '22023';
    END IF;
    IF v_c.servicio_id IS NOT NULL THEN
        v_compradores := ARRAY(SELECT c.contact_wa_id FROM public.wa_compradores_de_servicio(v_c.school_id, v_c.servicio_id) c);
    END IF;

    IF v_an IS NOT NULL THEN
    v_cands := ARRAY(
        SELECT DISTINCT at.contact_wa_id
          FROM public.whatsapp_atribucion at
         WHERE at.integration_id = v_c.integration_id
           AND at.school_id = v_c.school_id
           AND at.contact_wa_id ~ '^[0-9]{6,20}$'
           -- Contacto previo: escribió por el anuncio dentro de la antigüedad máxima (en las dos bases).
           AND at.ultimo_at >= now() - make_interval(days => LEAST(v_aj.antiguedad_max_dias, 90))
           AND (cardinality(v_an_si) = 0 OR EXISTS (
                SELECT 1 FROM unnest(v_an_si) w
                 WHERE position(w IN lower(concat_ws(' ', at.primer_headline, at.primer_body, at.ultimo_headline))) > 0))
           AND NOT EXISTS (
                SELECT 1 FROM unnest(v_an_no) w
                 WHERE position(w IN lower(concat_ws(' ', at.primer_headline, at.primer_body, at.ultimo_headline))) > 0));
    -- Familias, staff e inscritos (los que la audiencia clasificada ya trae marcados), por lotes de 1000.
    v_i := 1;
    WHILE v_i <= cardinality(v_cands) LOOP
        v_fuera := v_fuera || ARRAY(SELECT e.contact_wa_id
                                      FROM public.wa_audiencia_excluidos(v_c.school_id, v_cands[v_i : v_i + 999]) e);
        v_i := v_i + 1000;
    END LOOP;

    INSERT INTO public.whatsapp_campana_envios (campana_id, integration_id, school_id, contact_wa_id)
    SELECT v_c.id, v_c.integration_id, v_c.school_id, w
      FROM unnest(v_cands) w
     WHERE w <> ALL (v_fuera)
       -- Excluido en la audiencia (baja, «no me interesa», marca manual…): sigue fuera.
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_audiencia a
                        WHERE a.integration_id = v_c.integration_id AND a.contact_wa_id = w AND a.excluido IS NOT NULL)
       AND (v_aj.base_consentimiento <> 'optin' OR public.wa_can_send_template(v_c.integration_id, w))
       AND public.wa_puede_recibir_promos(v_c.integration_id, w)
       AND (v_c.servicio_id IS NULL OR w <> ALL (v_compradores))
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_conversations wc
                        WHERE wc.integration_id = v_c.integration_id AND wc.contact_wa_id = w
                          AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma', 'equipo',
                                                  'staff', 'familia', 'familia_sin_cuenta'))
    ON CONFLICT (campana_id, contact_wa_id) DO NOTHING;
    ELSE
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
            OR a.ultimo_entrante_at >= now() - make_interval(days => LEAST(v_aj.antiguedad_max_dias, 90)))
       -- Opt-in: solo con consentimiento vigente.
       AND (v_aj.base_consentimiento <> 'optin'
            OR public.wa_can_send_template(a.integration_id, a.contact_wa_id))
       -- Sin baja total, sin baja de promociones y sin bloqueo.
       AND public.wa_puede_recibir_promos(a.integration_id, a.contact_wa_id)
       -- Quien ya pagó o abonó el servicio que vende la campaña no la recibe.
       AND (v_c.servicio_id IS NULL OR a.contact_wa_id <> ALL (v_compradores))
       AND NOT EXISTS (SELECT 1 FROM public.whatsapp_conversations wc
                        WHERE wc.integration_id = a.integration_id AND wc.contact_wa_id = a.contact_wa_id
                          AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma', 'equipo',
                                                  'staff', 'familia', 'familia_sin_cuenta'))
    ON CONFLICT (campana_id, contact_wa_id) DO NOTHING;
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    IF v_n = 0 THEN
        RETURN 0;   -- nadie cumple: sigue en borrador y no queda declaración
    END IF;

    UPDATE public.whatsapp_campanas
       SET estado = 'aprobada', destinatarios = v_n, aprobada_por = p_por, aprobada_at = now(),
           declaracion_version = v_ver, updated_at = now()
     WHERE id = v_c.id;

    SELECT COALESCE(NULLIF(btrim(pr.email), ''), p_por::text) INTO v_email FROM public.profiles pr WHERE pr.id = p_por;
    INSERT INTO public.whatsapp_campanas_declaraciones
        (school_id, campana_id, tipo, version, texto, aceptada_por, aceptada_por_email,
         plantilla, plantilla_texto, destinatarios)
    VALUES (v_c.school_id, v_c.id, 'campana', v_ver, v_txt, p_por, COALESCE(v_email, p_por::text),
            v_c.plantilla, v_ptxt, v_n);

    RETURN v_n;
END;
$fn$;

COMMIT;
