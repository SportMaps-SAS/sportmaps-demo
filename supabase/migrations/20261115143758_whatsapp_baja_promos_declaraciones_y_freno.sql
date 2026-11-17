-- =============================================================================
-- 20261115143758_whatsapp_baja_promos_declaraciones_y_freno.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-15   Versión anterior: 20261114104111
-- Objetivo:
-- WhatsApp autoservicio F0 — baja de promociones separada, declaraciones de
-- responsabilidad, activación por la propia escuela y freno de emergencia.
-- Spec: docs/specs/whatsapp-autoservicio-escuelas-2026-11-15.md (D4, principio
-- de autogestión, F0).
--
-- Qué cambia
--   1. whatsapp_optins.promos_out_at: la baja de PROMOCIONES. opted_out_at sigue
--      siendo la baja TOTAL; nada de lo que hoy lo lee cambia (cobranza, envío
--      manual, notas de voz). wa_register_optin y wa_can_send_template NO se tocan.
--   2. wa_registrar_baja_promos / wa_reactivar_promos / wa_puede_recibir_promos.
--   3. whatsapp_campanas_declaraciones: registro (solo se agrega) de quién aceptó
--      qué texto y cuándo, al activar y en cada aprobación.
--   4. wa_campanas_activar: la escuela prende sus campañas aceptando la declaración.
--   5. wa_campana_aprobar pasa a 4 argumentos (versión y texto de la declaración):
--      ya no acepta al administrador de plataforma, exige la declaración de
--      activación y registra una declaración por campaña con la plantilla, su texto
--      (leído del espejo whatsapp_template_status, no de un parámetro) y el número
--      de destinatarios. Solo aprueba si la plantilla está APPROVED en Meta. La de 3
--      argumentos se elimina: un BFF sin actualizar no puede aprobar (falla cerrado).
--   6. wa_campana_tomar_lote: respeta la baja de promociones, el freno global y
--      el horario de la Ley 2300 (wa_horario_de_campanas, segundo candado además
--      del BFF); la regla de frecuencia POSPONE (proximo_intento_at) en vez de omitir.
--   7. Pausas con ORIGEN validado adentro (wa_campanas_pausar_escuela,
--      wa_campanas_reanudar_escuela, wa_campanas_freno_global) y bitácora
--      whatsapp_campanas_pausas. El freno automático marca pausa_origen='freno';
--      la escuela lo levanta viendo el motivo y aceptándolo (queda registrado); si
--      el freno vuelve a saltar dentro de los 7 días siguientes a esa reanudación,
--      la pausa nace con origen 'plataforma' y solo SportMaps la levanta.
--   8. whatsapp_campanas.servicio_id: la campaña queda ligada al servicio que vende
--      (ítem del catálogo). Con eso, quien YA PAGÓ O ABONÓ ese servicio queda fuera al
--      aprobar y otra vez al momento del envío (wa_compradores_de_servicio), y el
--      reporte de campaña puede contar quién pagó.
--  10. Plantilla aprobada en Meta: sin fila APPROVED en whatsapp_template_status ni
--      se aprueba la campaña ni se toma lote (un envío rechazado cuenta para el freno).
--  11. Base «contacto previo» por defecto al activarse sola una escuela, con dos
--      barreras: la campaña debe filtrar por al menos un interés y la antigüedad
--      máxima del último mensaje baja a 90 días (tope también para las ya activas).
--  12. Festivos: co_festivos_del_anio(año) calcula los festivos nacionales con su
--      regla de traslado (Ley 51 de 1983), incluida la Virgen de Chiquinquirá (Ley
--      2578 de 2026: 9 de julio, trasladable). co_holidays queda cargada 2026–2035
--      desde esa función y es la fuente única: la leen las reservas, el horario de
--      campañas y el BFF. Entran 2026-07-13, 2027-07-12 y 2028-07-10.
--   9. Conversión: bajas totales que vinieron del botón de una campaña y no de una
--      palabra de baja → baja de promociones (7 filas de una escuela el 2026-11-15;
--      ninguna tenía consentimiento previo: cero efecto en cobranza).
--
-- Todas las funciones: SECURITY DEFINER + search_path fijo, EXECUTE solo para
-- service_role (las llama el BFF tras autorizar; quien actúa llega en p_por y se
-- valida ADENTRO contra ESA escuela). Nada para anon ni authenticated.
-- =============================================================================

BEGIN;

-- ── 1. Baja de promociones ───────────────────────────────────────────────────
ALTER TABLE public.whatsapp_optins
    ADD COLUMN promos_out_at  timestamptz,
    ADD COLUMN promos_out_ref text CHECK (promos_out_ref IS NULL OR length(promos_out_ref) <= 200);

COMMENT ON COLUMN public.whatsapp_optins.promos_out_at IS
    'Cuándo pidió no recibir PROMOCIONES (botón «No recibir más» de una campaña). No corta la cobranza ni los '
    'avisos operativos: eso es opted_out_at (baja total).';

ALTER TABLE public.whatsapp_optins DROP CONSTRAINT chk_wa_optin_dice_algo;
ALTER TABLE public.whatsapp_optins ADD CONSTRAINT chk_wa_optin_dice_algo
    CHECK (opted_in_at IS NOT NULL OR opted_out_at IS NOT NULL OR promos_out_at IS NOT NULL);

-- Superconjunto del CHECK vivo (todas las filas actuales lo cumplen).
ALTER TABLE public.whatsapp_optins DROP CONSTRAINT chk_wa_optin_source;
ALTER TABLE public.whatsapp_optins ADD CONSTRAINT chk_wa_optin_source CHECK (source = ANY (ARRAY[
    'user_confirmed'::text, 'form_inscripcion'::text, 'invitacion'::text, 'import'::text,
    'admin_manual'::text, 'baja_directa'::text, 'bot_prospecto'::text, 'formulario_wa'::text,
    'baja_promos'::text   -- fila creada solo para dejar constancia de la baja de promociones
]));

CREATE FUNCTION public.wa_registrar_baja_promos(
    p_integration_id uuid, p_school_id uuid, p_contact_wa_id text, p_ref text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_integration_id IS NULL OR p_school_id IS NULL OR COALESCE(btrim(p_contact_wa_id), '') = '' THEN
        RAISE EXCEPTION 'DATOS_REQUERIDOS' USING ERRCODE = '22023';
    END IF;
    -- Nunca toca opted_in_at, opted_out_at ni la prueba del consentimiento (source, source_ref).
    INSERT INTO public.whatsapp_optins (
        integration_id, school_id, contact_wa_id, opted_in_at, opted_out_at,
        promos_out_at, promos_out_ref, source, source_ref
    ) VALUES (
        p_integration_id, p_school_id, p_contact_wa_id, NULL, NULL,
        now(), left(p_ref, 200), 'baja_promos', COALESCE(left(p_ref, 200), 'baja_promos')
    )
    ON CONFLICT (integration_id, contact_wa_id) DO UPDATE SET
        promos_out_at  = COALESCE(public.whatsapp_optins.promos_out_at, now()),
        promos_out_ref = COALESCE(public.whatsapp_optins.promos_out_ref, EXCLUDED.promos_out_ref),
        updated_at     = now()
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('ok', true, 'optin_id', v_id);
END;
$$;

COMMENT ON FUNCTION public.wa_registrar_baja_promos(uuid, uuid, text, text) IS
    'Baja de PROMOCIONES de un contacto (botón de campaña). No corta cobranza ni avisos. Solo service role.';

CREATE FUNCTION public.wa_reactivar_promos(p_integration_id uuid, p_contact_wa_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_n int;
BEGIN
    -- Solo la llama el BFF cuando la PERSONA lo pide (escribe ACTIVAR o acepta novedades).
    -- Una inscripción o una invitación no pasan por aquí: no borran la baja de promociones.
    UPDATE public.whatsapp_optins
       SET promos_out_at = NULL, promos_out_ref = NULL, updated_at = now()
     WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id
       AND promos_out_at IS NOT NULL
       AND (opted_in_at IS NOT NULL OR opted_out_at IS NOT NULL);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- Fila que solo decía «baja de promociones»: al reactivar ya no dice nada → se borra.
    DELETE FROM public.whatsapp_optins
     WHERE integration_id = p_integration_id AND contact_wa_id = p_contact_wa_id
       AND promos_out_at IS NOT NULL AND opted_in_at IS NULL AND opted_out_at IS NULL;
    IF FOUND THEN v_n := v_n + 1; END IF;
    RETURN v_n > 0;
END;
$$;

COMMENT ON FUNCTION public.wa_reactivar_promos(uuid, text) IS
    'Levanta la baja de promociones cuando la persona lo pide (ACTIVAR, aceptar novedades). Solo service role.';

CREATE FUNCTION public.wa_puede_recibir_promos(p_integration_id uuid, p_contact_wa_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM public.whatsapp_optins o
         WHERE o.integration_id = p_integration_id
           AND o.contact_wa_id  = p_contact_wa_id
           AND (o.opted_out_at IS NOT NULL OR o.promos_out_at IS NOT NULL)
    )
    AND NOT public.wa_is_blocked(p_integration_id, p_contact_wa_id);
$$;

COMMENT ON FUNCTION public.wa_puede_recibir_promos(uuid, text) IS
    '¿Se le puede mandar una promoción? Sin baja total, sin baja de promociones y sin bloqueo. NO afirma '
    'consentimiento: eso lo decide la base de la campaña. Solo service role.';

-- ── 2. Declaraciones de responsabilidad (solo se agrega) ─────────────────────
CREATE TABLE public.whatsapp_campanas_declaraciones (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id          uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    -- RESTRICT: una campaña con declaración no se borra (es su respaldo).
    campana_id         uuid        REFERENCES public.whatsapp_campanas(id) ON DELETE RESTRICT,
    tipo               text        NOT NULL CHECK (tipo IN ('activacion', 'campana')),
    version            text        NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 40),
    texto              text        NOT NULL CHECK (length(btrim(texto)) BETWEEN 20 AND 2000),
    aceptada_por       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- Foto de quién era: sobrevive al borrado del usuario.
    aceptada_por_email text        NOT NULL CHECK (length(aceptada_por_email) <= 320),
    aceptada_at        timestamptz NOT NULL DEFAULT now(),
    -- Solo en tipo 'campana': qué se aprobó exactamente.
    plantilla          text        CHECK (plantilla IS NULL OR length(plantilla) <= 512),
    plantilla_texto    text        CHECK (plantilla_texto IS NULL OR length(plantilla_texto) <= 4000),
    destinatarios      int         CHECK (destinatarios IS NULL OR destinatarios >= 0),
    CONSTRAINT wa_declaracion_activacion_sin_campana CHECK (tipo <> 'activacion' OR campana_id IS NULL),
    CONSTRAINT wa_declaracion_campana_completa CHECK (
        tipo <> 'campana' OR (campana_id IS NOT NULL AND plantilla IS NOT NULL
                              AND plantilla_texto IS NOT NULL AND destinatarios IS NOT NULL))
);

COMMENT ON TABLE public.whatsapp_campanas_declaraciones IS
    'Declaraciones de responsabilidad de la escuela sobre sus campañas de WhatsApp (contenido verídico, '
    'consentimiento de los destinatarios, horarios de la Ley 2300): una al activar y una por cada aprobación, '
    'con el texto aceptado, el usuario y la fecha; la de campaña guarda además la plantilla, su texto y cuántos '
    'destinatarios se aprobaron. Solo se agrega (service role sin UPDATE ni DELETE).';

CREATE INDEX idx_wa_declaraciones_escuela
    ON public.whatsapp_campanas_declaraciones (school_id, tipo, aceptada_at DESC);
CREATE INDEX idx_wa_declaraciones_campana
    ON public.whatsapp_campanas_declaraciones (campana_id) WHERE campana_id IS NOT NULL;

ALTER TABLE public.whatsapp_campanas_declaraciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_campanas_declaraciones FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.whatsapp_campanas_declaraciones TO service_role;

-- ── 3. Pausas: origen validado adentro, bitácora y horario ───────────────────
CREATE TABLE public.whatsapp_campanas_freno_global (
    unico       boolean     PRIMARY KEY DEFAULT true CHECK (unico),
    pausada_at  timestamptz,
    motivo      text        CHECK (motivo IS NULL OR length(motivo) <= 500),
    pausada_por uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.whatsapp_campanas_freno_global (unico) VALUES (true);

COMMENT ON TABLE public.whatsapp_campanas_freno_global IS
    'Una sola fila. pausada_at no nulo = ninguna campaña de ninguna escuela se aprueba ni envía. Solo se cambia '
    'por wa_campanas_freno_global (administrador de plataforma). Solo service role, solo lectura.';

ALTER TABLE public.whatsapp_campanas_freno_global ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_campanas_freno_global FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.whatsapp_campanas_freno_global TO service_role;

ALTER TABLE public.whatsapp_campanas_ajustes
    ADD COLUMN pausa_origen text CHECK (pausa_origen IN ('freno', 'escuela', 'plataforma')),
    ADD COLUMN pausada_por  uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.whatsapp_campanas_ajustes.pausa_origen IS
    'Quién pausó la escuela: freno (automático, calidad/bajas/fallos), escuela, o plataforma (emergencia o freno '
    'reincidente: la escuela no la puede levantar). NULL con pausada_at = pausa anterior a esta migración (fue el freno).';

-- Bitácora de pausas y reanudaciones (solo se agrega / se cierra la fila abierta desde las RPC).
CREATE TABLE public.whatsapp_campanas_pausas (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id          uuid        REFERENCES public.schools(id) ON DELETE CASCADE,   -- NULL = freno global
    origen             text        NOT NULL CHECK (origen IN ('freno', 'escuela', 'plataforma', 'global')),
    motivo             text        CHECK (motivo IS NULL OR length(motivo) <= 500),
    -- El freno saltó otra vez dentro de los 7 días de una reanudación de la escuela.
    reincidente        boolean     NOT NULL DEFAULT false,
    pausada_at         timestamptz NOT NULL DEFAULT now(),
    pausada_por        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL, -- NULL = automático
    levantada_at       timestamptz,
    levantada_por      uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    levantada_por_email text       CHECK (levantada_por_email IS NULL OR length(levantada_por_email) <= 320),
    -- Lo que aceptó quien reanudó («vi el motivo … y reanudo»).
    aceptacion         text        CHECK (aceptacion IS NULL OR length(aceptacion) <= 2000),
    CONSTRAINT wa_pausa_global_sin_escuela CHECK ((origen = 'global') = (school_id IS NULL))
);

COMMENT ON TABLE public.whatsapp_campanas_pausas IS
    'Bitácora de pausas de campañas por escuela (y del freno global): quién pausó, por qué, quién reanudó y qué '
    'aceptó al reanudar. La escriben solo las RPC wa_campanas_pausar_escuela / _reanudar_escuela / _freno_global.';

CREATE INDEX idx_wa_pausas_escuela ON public.whatsapp_campanas_pausas (school_id, pausada_at DESC);

ALTER TABLE public.whatsapp_campanas_pausas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.whatsapp_campanas_pausas FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.whatsapp_campanas_pausas TO service_role;

-- ¿Quién es p_por para ESTA escuela? Helpers internos (solo los llaman las RPC de abajo).
CREATE FUNCTION public._wa_campanas_es_admin_de_escuela(p_school_id uuid, p_por uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p_por IS NOT NULL AND (
           EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.owner_id = p_por)
        OR EXISTS (SELECT 1 FROM public.school_members sm
                    WHERE sm.school_id = p_school_id AND sm.profile_id = p_por
                      AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin')));
$$;

CREATE FUNCTION public._wa_campanas_es_admin_de_plataforma(p_por uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p_por IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = p_por AND pa.is_active);
$$;

REVOKE ALL ON FUNCTION public._wa_campanas_es_admin_de_escuela(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._wa_campanas_es_admin_de_plataforma(uuid)    FROM PUBLIC, anon, authenticated;

-- Pausar todas las campañas de UNA escuela. El origen se valida ADENTRO:
--   'freno'      → automático (p_por debe ser NULL). Si la escuela reanudó un freno hace
--                  menos de 7 días, esta pausa nace como 'plataforma' (reincidente).
--   'escuela'    → p_por administra ESA escuela.
--   'plataforma' → p_por es administrador de plataforma activo (freno de emergencia).
CREATE FUNCTION public.wa_campanas_pausar_escuela(p_school_id uuid, p_por uuid, p_origen text, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_aj          public.whatsapp_campanas_ajustes%ROWTYPE;
    v_origen      text := p_origen;
    v_motivo      text := NULLIF(left(btrim(COALESCE(p_motivo, '')), 500), '');
    v_reincidente boolean := false;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'ESCUELA_REQUERIDA' USING ERRCODE = '22023';
    END IF;
    IF p_origen = 'freno' THEN
        IF p_por IS NOT NULL THEN
            RAISE EXCEPTION 'EL_FRENO_ES_AUTOMATICO' USING ERRCODE = '22023';
        END IF;
    ELSIF p_origen = 'escuela' THEN
        IF NOT public._wa_campanas_es_admin_de_escuela(p_school_id, p_por) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
    ELSIF p_origen = 'plataforma' THEN
        IF NOT public._wa_campanas_es_admin_de_plataforma(p_por) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
    ELSE
        RAISE EXCEPTION 'ORIGEN_INVALIDO' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_aj FROM public.whatsapp_campanas_ajustes WHERE school_id = p_school_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SIN_AJUSTES' USING ERRCODE = 'P0002';
    END IF;

    -- Ya en pausa: solo la plataforma puede endurecerla; lo demás no cambia nada.
    IF v_aj.pausada_at IS NOT NULL AND NOT (p_origen = 'plataforma' AND v_aj.pausa_origen IS DISTINCT FROM 'plataforma') THEN
        RETURN jsonb_build_object('ok', true, 'ya_en_pausa', true, 'origen', COALESCE(v_aj.pausa_origen, 'freno'));
    END IF;

    -- Reincidencia: el freno saltó de nuevo dentro de los 7 días de una reanudación de la escuela.
    IF p_origen = 'freno' AND EXISTS (
            SELECT 1 FROM public.whatsapp_campanas_pausas b
             WHERE b.school_id = p_school_id AND b.origen = 'freno'
               AND b.levantada_at > now() - interval '7 days') THEN
        v_origen := 'plataforma';
        v_reincidente := true;
    END IF;

    -- Si la plataforma endurece una pausa abierta, esa fila se cierra sin «levantada_por».
    UPDATE public.whatsapp_campanas_pausas
       SET levantada_at = now(), aceptacion = 'reemplazada por pausa de plataforma'
     WHERE school_id = p_school_id AND levantada_at IS NULL;

    UPDATE public.whatsapp_campanas_ajustes
       SET pausada_at = now(), pausa_motivo = COALESCE(v_motivo, v_origen), pausa_origen = v_origen,
           pausada_por = p_por, updated_at = now()
     WHERE school_id = p_school_id;
    UPDATE public.whatsapp_campanas
       SET estado = 'pausada', pausa_motivo = COALESCE(v_motivo, v_origen), updated_at = now()
     WHERE school_id = p_school_id AND estado IN ('aprobada', 'enviando');
    INSERT INTO public.whatsapp_campanas_pausas (school_id, origen, motivo, reincidente, pausada_por)
    VALUES (p_school_id, v_origen, v_motivo, v_reincidente, p_por);

    RETURN jsonb_build_object('ok', true, 'origen', v_origen, 'reincidente', v_reincidente);
END;
$$;

COMMENT ON FUNCTION public.wa_campanas_pausar_escuela(uuid, uuid, text, text) IS
    'Pausa todas las campañas de una escuela. Origen validado adentro (freno automático, escuela, plataforma); un '
    'freno reincidente (< 7 días desde que la escuela reanudó) nace como pausa de plataforma. Solo service role.';

-- Levantar la pausa de UNA escuela (no reanuda ninguna campaña: eso es campaña por campaña).
--   pausa 'plataforma'            → solo un administrador de plataforma.
--   pausa 'freno' (o anterior)    → la administración de ESA escuela, ACEPTANDO el motivo (p_aceptacion).
--   pausa 'escuela'               → la administración de ESA escuela.
CREATE FUNCTION public.wa_campanas_reanudar_escuela(p_school_id uuid, p_por uuid, p_aceptacion text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_aj     public.whatsapp_campanas_ajustes%ROWTYPE;
    v_origen text;
    v_acep   text := NULLIF(left(btrim(COALESCE(p_aceptacion, '')), 2000), '');
    v_email  text;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'ESCUELA_REQUERIDA' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_aj FROM public.whatsapp_campanas_ajustes WHERE school_id = p_school_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SIN_AJUSTES' USING ERRCODE = 'P0002';
    END IF;
    IF v_aj.pausada_at IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'sin_pausa', true);
    END IF;
    v_origen := COALESCE(v_aj.pausa_origen, 'freno');

    IF v_origen = 'plataforma' THEN
        IF NOT public._wa_campanas_es_admin_de_plataforma(p_por) THEN
            RAISE EXCEPTION 'PAUSA_DE_PLATAFORMA' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF NOT public._wa_campanas_es_admin_de_escuela(p_school_id, p_por) THEN
            RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
        END IF;
        IF v_origen = 'freno' AND (v_acep IS NULL OR length(v_acep) < 20) THEN
            RAISE EXCEPTION 'ACEPTACION_REQUERIDA' USING ERRCODE = '22023';
        END IF;
    END IF;

    SELECT COALESCE(NULLIF(btrim(pr.email), ''), p_por::text) INTO v_email FROM public.profiles pr WHERE pr.id = p_por;

    UPDATE public.whatsapp_campanas_pausas
       SET levantada_at = now(), levantada_por = p_por, levantada_por_email = COALESCE(v_email, p_por::text),
           aceptacion = v_acep
     WHERE school_id = p_school_id AND levantada_at IS NULL;
    -- Pausa anterior a la bitácora (sin fila abierta): queda la constancia completa en una fila ya cerrada.
    IF NOT FOUND THEN
        INSERT INTO public.whatsapp_campanas_pausas
            (school_id, origen, motivo, pausada_at, levantada_at, levantada_por, levantada_por_email, aceptacion)
        VALUES (p_school_id, v_origen, v_aj.pausa_motivo, v_aj.pausada_at, now(), p_por, COALESCE(v_email, p_por::text), v_acep);
    END IF;

    UPDATE public.whatsapp_campanas_ajustes
       SET pausada_at = NULL, pausa_motivo = NULL, pausa_origen = NULL, pausada_por = NULL, updated_at = now()
     WHERE school_id = p_school_id;

    RETURN jsonb_build_object('ok', true, 'origen', v_origen);
END;
$$;

COMMENT ON FUNCTION public.wa_campanas_reanudar_escuela(uuid, uuid, text) IS
    'Levanta la pausa de campañas de una escuela. La de plataforma solo la levanta un administrador de plataforma; '
    'la del freno, la administración de ESA escuela aceptando el motivo (queda en la bitácora). Solo service role.';

-- Freno global: solo un administrador de plataforma.
CREATE FUNCTION public.wa_campanas_freno_global(p_por uuid, p_pausar boolean, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_motivo text := NULLIF(left(btrim(COALESCE(p_motivo, '')), 500), '');
    v_email  text;
BEGIN
    IF NOT public._wa_campanas_es_admin_de_plataforma(p_por) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_pausar IS NULL THEN
        RAISE EXCEPTION 'FALTA_PAUSAR' USING ERRCODE = '22023';
    END IF;
    IF p_pausar THEN
        UPDATE public.whatsapp_campanas_freno_global
           SET pausada_at = now(), motivo = v_motivo, pausada_por = p_por, updated_at = now()
         WHERE unico AND pausada_at IS NULL;
        IF FOUND THEN
            INSERT INTO public.whatsapp_campanas_pausas (school_id, origen, motivo, pausada_por)
            VALUES (NULL, 'global', v_motivo, p_por);
        END IF;
    ELSE
        UPDATE public.whatsapp_campanas_freno_global
           SET pausada_at = NULL, motivo = NULL, pausada_por = NULL, updated_at = now()
         WHERE unico AND pausada_at IS NOT NULL;
        IF FOUND THEN
            SELECT COALESCE(NULLIF(btrim(pr.email), ''), p_por::text) INTO v_email FROM public.profiles pr WHERE pr.id = p_por;
            UPDATE public.whatsapp_campanas_pausas
               SET levantada_at = now(), levantada_por = p_por, levantada_por_email = COALESCE(v_email, p_por::text)
             WHERE origen = 'global' AND levantada_at IS NULL;
        END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'pausada', p_pausar);
END;
$$;

COMMENT ON FUNCTION public.wa_campanas_freno_global(uuid, boolean, text) IS
    'Pone o quita el freno global de campañas (todas las escuelas). Solo un administrador de plataforma activo '
    '(p_por, validado adentro). Solo service role.';

-- ── 3a. Festivos nacionales: una sola fuente ─────────────────────────────────
-- Calcula los festivos de un año con su regla: fijos, trasladables al lunes siguiente
-- (Ley 51 de 1983) y los que dependen de la Pascua. La Virgen de Chiquinquirá (9 de julio,
-- trasladable) es festivo desde la Ley 2578 de 2026; no se agrega hacia atrás.
CREATE FUNCTION public.co_festivos_del_anio(p_anio int)
RETURNS TABLE (holiday_date date, name text)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    a int := p_anio % 19;
    b int := p_anio / 100;
    c int := p_anio % 100;
    d int := b / 4;
    e int := b % 4;
    f int := (b + 8) / 25;
    g int := (b - f + 1) / 3;
    h int := (19 * a + b - d - g + 15) % 30;
    i int := c / 4;
    k int := c % 4;
    l int := (32 + 2 * e + 2 * i - h - k) % 7;
    m int := (a + 11 * h + 22 * l) / 451;
    v_pascua date := make_date(p_anio, (h + l - 7 * m + 114) / 31, (h + l - 7 * m + 114) % 31 + 1);
BEGIN
    IF p_anio IS NULL OR p_anio NOT BETWEEN 1984 AND 2200 THEN
        RETURN;
    END IF;
    RETURN QUERY
    WITH base(orden, fecha, nombre, traslada) AS (
        VALUES
            (1,  make_date(p_anio, 1, 1),   'Año Nuevo', false),
            (2,  make_date(p_anio, 1, 6),   'Reyes Magos', true),
            (3,  make_date(p_anio, 3, 19),  'San José', true),
            (4,  v_pascua - 3,              'Jueves Santo', false),
            (5,  v_pascua - 2,              'Viernes Santo', false),
            (6,  make_date(p_anio, 5, 1),   'Día del Trabajo', false),
            (7,  v_pascua + 43,             'Ascensión del Señor', false),      -- +39, ya en lunes
            (8,  v_pascua + 64,             'Corpus Christi', false),           -- +60, ya en lunes
            (9,  v_pascua + 71,             'Sagrado Corazón', false),          -- +68, ya en lunes
            (10, make_date(p_anio, 6, 29),  'San Pedro y San Pablo', true),
            (11, make_date(p_anio, 7, 9),   'Virgen de Chiquinquirá', true),
            (12, make_date(p_anio, 7, 20),  'Día de la Independencia', false),
            (13, make_date(p_anio, 8, 7),   'Batalla de Boyacá', false),
            (14, make_date(p_anio, 8, 15),  'Asunción de la Virgen', true),
            (15, make_date(p_anio, 10, 12), 'Día de la Raza', true),
            (16, make_date(p_anio, 11, 1),  'Todos los Santos', true),
            (17, make_date(p_anio, 11, 11), 'Independencia de Cartagena', true),
            (18, make_date(p_anio, 12, 8),  'Inmaculada Concepción', false),
            (19, make_date(p_anio, 12, 25), 'Navidad', false)
    ),
    movidos AS (
        SELECT b2.orden, b2.nombre,
               CASE WHEN b2.traslada
                    THEN b2.fecha + ((8 - extract(dow FROM b2.fecha)::int) % 7)   -- lunes se queda; el resto, al lunes siguiente
                    ELSE b2.fecha END AS fecha
          FROM base b2
         WHERE b2.orden <> 11 OR p_anio >= 2026
    )
    -- Dos festivos pueden caer el mismo lunes (2030-07-01): queda una sola fila.
    SELECT DISTINCT ON (mv.fecha) mv.fecha, mv.nombre
      FROM movidos mv
     ORDER BY mv.fecha, mv.orden;
END;
$$;

COMMENT ON FUNCTION public.co_festivos_del_anio(int) IS
    'Festivos nacionales de Colombia de un año, con el traslado al lunes (Ley 51 de 1983) y la Virgen de '
    'Chiquinquirá desde 2026 (Ley 2578 de 2026). Con esto se carga co_holidays, que es la fuente única.';

INSERT INTO public.co_holidays (holiday_date, name)
SELECT f.holiday_date, f.name
  FROM generate_series(2026, 2035) anio, public.co_festivos_del_anio(anio) f
ON CONFLICT (holiday_date) DO NOTHING;

COMMENT ON TABLE public.co_holidays IS
    'Festivos de Colombia: fuente única (reservas los cobran como domingo; campañas y cobranza no envían). '
    'Cargados 2026–2035 con co_festivos_del_anio(año). Para más años: '
    'INSERT … SELECT FROM co_festivos_del_anio(2036) ON CONFLICT DO NOTHING.';

GRANT SELECT ON TABLE public.co_holidays TO service_role;

-- Horario de la Ley 2300 de 2023 en hora de Bogotá: lunes a viernes 7:00–19:00, sábados
-- 8:00–15:00, nunca domingos ni festivos (public.co_holidays). Si el año no tiene festivos
-- cargados, responde false: sin calendario no se envía (cargado 2026–2035).
CREATE FUNCTION public.wa_horario_de_campanas(p_ahora timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_local timestamp := p_ahora AT TIME ZONE 'America/Bogota';
    v_dia   int := extract(dow FROM v_local)::int;                       -- 0 = domingo
    v_min   int := (extract(hour FROM v_local) * 60 + extract(minute FROM v_local))::int;
BEGIN
    IF p_ahora IS NULL OR v_dia = 0 THEN
        RETURN false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.co_holidays h
                    WHERE h.holiday_date >= date_trunc('year', v_local)::date
                      AND h.holiday_date <  (date_trunc('year', v_local) + interval '1 year')::date) THEN
        RETURN false;
    END IF;
    IF EXISTS (SELECT 1 FROM public.co_holidays h WHERE h.holiday_date = v_local::date) THEN
        RETURN false;
    END IF;
    IF v_dia = 6 THEN
        RETURN v_min >= 8 * 60 AND v_min < 15 * 60;
    END IF;
    RETURN v_min >= 7 * 60 AND v_min < 19 * 60;
END;
$$;

COMMENT ON FUNCTION public.wa_horario_de_campanas(timestamptz) IS
    '¿Es horario permitido por la Ley 2300 (L-V 7–19, sáb 8–15, sin domingos ni festivos de co_holidays)? Segundo '
    'candado de wa_campana_tomar_lote; el primero es dentroDeHorarioDeCobranza en el BFF. Solo service role.';

-- ── 3b. Campaña ligada al servicio que vende; quien ya lo pagó queda fuera ───
ALTER TABLE public.whatsapp_campanas
    ADD COLUMN servicio_id uuid REFERENCES public.school_tournament_items(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.whatsapp_campanas.servicio_id IS
    'Servicio del catálogo que vende la campaña (clínica, torneo…). NULL = campaña general. Quien ya pagó o abonó '
    'ese servicio no la recibe (wa_compradores_de_servicio), y el reporte cuenta sus pagos.';

CREATE INDEX idx_wa_campanas_servicio ON public.whatsapp_campanas (servicio_id) WHERE servicio_id IS NOT NULL;

-- Los contact_wa_id (57 + celular) de quienes pagaron, abonaron o mandaron comprobante de UN servicio
-- de UNA escuela, con la fecha de su primer pago. Cobros ligados al ítem por las tres vías
-- (cobros_servicio_item, wa_cobros_desde_comprobante, wa_cobros_sueltos) más los que la escuela abrió
-- a mano sin ligar y cuyo concepto nombra el servicio; estos últimos SOLO si se crearon después del
-- servicio (un cobro viejo con un nombre parecido no es de este servicio). El teléfono sale de la cola
-- de comprobantes, del concepto esperado, del interesado, de la ficha o del acudiente. Un pago sin
-- teléfono colombiano reconocible no excluye a nadie.
CREATE FUNCTION public.wa_compradores_de_servicio(p_school_id uuid, p_item_id uuid)
RETURNS TABLE (contact_wa_id text, primer_pago_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    WITH item AS (
        SELECT i.id, i.created_at, lower(translate(btrim(i.name), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou')) AS nombre
          FROM public.school_tournament_items i
         WHERE i.id = p_item_id AND i.school_id = p_school_id
    ),
    ligados AS (
        SELECT c.payment_id FROM public.cobros_servicio_item c, item
         WHERE c.school_id = p_school_id AND c.item_id = item.id AND c.anulado_at IS NULL
        UNION
        SELECT w.payment_id FROM public.wa_cobros_desde_comprobante w, item
         WHERE w.school_id = p_school_id AND w.fuente = 'tournament_item' AND w.fuente_id = item.id
        UNION
        SELECT ws.payment_id FROM public.wa_cobros_sueltos ws, item
         WHERE ws.school_id = p_school_id AND ws.item_id = item.id AND ws.anulado_at IS NULL
        UNION
        SELECT p.id FROM public.payments p, item
         WHERE p.school_id = p_school_id AND length(item.nombre) >= 6
           AND p.created_at >= item.created_at
           AND position(item.nombre IN lower(translate(COALESCE(p.concept, ''), 'ÁÉÍÓÚáéíóú', 'AEIOUaeiou'))) > 0
    ),
    pagos AS (
        SELECT p.id, p.parent_id, p.user_id, p.child_id, p.unregistered_athlete_id, p.signup_lead_id,
               COALESCE(p.receipt_submitted_at, p.approved_at, p.created_at) AS pago_at
          FROM public.payments p JOIN ligados l ON l.payment_id = p.id
         WHERE p.school_id = p_school_id
           AND p.status IN ('paid', 'partial', 'awaiting_approval', 'glosado')
    ),
    telefonos AS (
        SELECT q.wa_phone_number AS tel, p.pago_at
          FROM pagos p JOIN public.wa_cobros_desde_comprobante w ON w.payment_id = p.id
          JOIN public.whatsapp_inbound_queue q ON q.id = w.queue_id
        UNION ALL SELECT q.wa_phone_number, p.pago_at FROM pagos p JOIN public.cobros_servicio_item c ON c.payment_id = p.id
          JOIN public.whatsapp_inbound_queue q ON q.id = c.queue_id
        UNION ALL SELECT q.wa_phone_number, p.pago_at FROM pagos p JOIN public.whatsapp_inbound_queue q ON q.result_ref_id = p.id
        UNION ALL SELECT ce.telefono, p.pago_at FROM pagos p JOIN public.whatsapp_conceptos_esperados ce ON ce.payment_id = p.id
        UNION ALL SELECT wc.contact_wa_id, p.pago_at FROM pagos p JOIN public.wa_cobros_sueltos ws ON ws.payment_id = p.id
          JOIN public.whatsapp_conversations wc ON wc.id = ws.conversation_id
        UNION ALL SELECT l.phone, p.pago_at FROM pagos p JOIN public.school_signup_leads l ON l.id = p.signup_lead_id
        UNION ALL SELECT ua.phone, p.pago_at FROM pagos p JOIN public.unregistered_athletes ua ON ua.id = p.unregistered_athlete_id
        UNION ALL SELECT ua.guardian_phone, p.pago_at FROM pagos p JOIN public.unregistered_athletes ua ON ua.id = p.unregistered_athlete_id
        UNION ALL SELECT ch.parent_phone_temp, p.pago_at FROM pagos p JOIN public.children ch ON ch.id = p.child_id
        UNION ALL SELECT pr.phone, p.pago_at FROM pagos p JOIN public.profiles pr ON pr.id = p.parent_id
        UNION ALL SELECT pr.phone, p.pago_at FROM pagos p JOIN public.profiles pr ON pr.id = p.user_id
    )
    SELECT '57' || public.wa_celular_remitente_co(t.tel), min(t.pago_at)
      FROM telefonos t
     WHERE t.tel IS NOT NULL AND public.wa_celular_remitente_co(t.tel) IS NOT NULL
     GROUP BY 1;
$$;

COMMENT ON FUNCTION public.wa_compradores_de_servicio(uuid, uuid) IS
    'contact_wa_id de quienes ya pagaron, abonaron o mandaron comprobante de un servicio de ESA escuela (el ítem '
    'debe ser de p_school_id), con la fecha de su primer pago. Para sacarlos de las campañas que venden ese '
    'servicio y para que el reporte cuente quién pagó. Solo service role.';

-- ── 4. La escuela activa sus campañas ────────────────────────────────────────
-- Con la base «contacto previo» nadie recibe campañas si su último mensaje tiene más de 90 días.
ALTER TABLE public.whatsapp_campanas_ajustes ALTER COLUMN antiguedad_max_dias SET DEFAULT 90;
UPDATE public.whatsapp_campanas_ajustes SET antiguedad_max_dias = 90, updated_at = now() WHERE antiguedad_max_dias > 90;

CREATE FUNCTION public.wa_campanas_activar(p_school_id uuid, p_por uuid, p_version text, p_texto text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_ver   text := NULLIF(btrim(COALESCE(p_version, '')), '');
    v_txt   text := NULLIF(btrim(COALESCE(p_texto, '')), '');
    v_email text;
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'ESCUELA_REQUERIDA' USING ERRCODE = '22023';
    END IF;
    -- Solo la administración de ESA escuela. El administrador de plataforma NO activa por ella.
    IF p_por IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.owner_id = p_por)
        OR EXISTS (SELECT 1 FROM public.school_members sm
                    WHERE sm.school_id = p_school_id AND sm.profile_id = p_por
                      AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin'))) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_ver IS NULL OR length(v_ver) > 40 OR v_txt IS NULL OR length(v_txt) NOT BETWEEN 20 AND 2000 THEN
        RAISE EXCEPTION 'DECLARACION_REQUERIDA' USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(NULLIF(btrim(pr.email), ''), p_por::text) INTO v_email FROM public.profiles pr WHERE pr.id = p_por;

    INSERT INTO public.whatsapp_campanas_declaraciones (school_id, tipo, version, texto, aceptada_por, aceptada_por_email)
    VALUES (p_school_id, 'activacion', v_ver, v_txt, p_por, COALESCE(v_email, p_por::text));

    -- Topes y pausa NO se tocan: son las barreras de SportMaps. La base es la que la escuela
    -- acaba de declarar: «contacto previo» (quien le escribió en los últimos 90 días). Si la
    -- escuela ya había estado activa, su base no se cambia.
    INSERT INTO public.whatsapp_campanas_ajustes
        (school_id, habilitadas, habilitado_por, habilitado_at, base_consentimiento, antiguedad_max_dias)
    VALUES (p_school_id, true, p_por, now(), 'contacto_previo_declarado', 90)
    ON CONFLICT (school_id) DO UPDATE SET
        habilitadas = true, habilitado_por = EXCLUDED.habilitado_por,
        base_consentimiento = CASE WHEN public.whatsapp_campanas_ajustes.habilitado_at IS NULL
                                   THEN 'contacto_previo_declarado'
                                   ELSE public.whatsapp_campanas_ajustes.base_consentimiento END,
        antiguedad_max_dias = LEAST(public.whatsapp_campanas_ajustes.antiguedad_max_dias, 90),
        habilitado_at = EXCLUDED.habilitado_at, updated_at = now();

    RETURN jsonb_build_object('ok', true);
END;
$$;

COMMENT ON FUNCTION public.wa_campanas_activar(uuid, uuid, text, text) IS
    'La administración de ESA escuela (p_por, validado adentro) prende sus campañas aceptando la declaración de '
    'responsabilidad, que queda registrada. No cambia topes ni levanta pausas. Solo service role.';

-- ── 5. Aprobar: declaración por campaña, sin administrador de plataforma ─────
DROP FUNCTION public.wa_campana_aprobar(uuid, uuid, text);

CREATE FUNCTION public.wa_campana_aprobar(
    p_campana_id uuid, p_por uuid, p_declaracion_version text, p_declaracion_texto text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
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
    -- Con la base «contacto previo» la campaña va a un interés concreto, nunca a toda la lista.
    IF v_aj.base_consentimiento = 'contacto_previo_declarado' AND cardinality(v_int) = 0 THEN
        RAISE EXCEPTION 'INTERES_REQUERIDO' USING ERRCODE = '22023';
    END IF;
    IF v_c.servicio_id IS NOT NULL THEN
        v_compradores := ARRAY(SELECT c.contact_wa_id FROM public.wa_compradores_de_servicio(v_c.school_id, v_c.servicio_id) c);
    END IF;

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
$$;

COMMENT ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text, text) IS
    'Aprueba una campaña (foto de la audiencia). Solo la administración de ESA escuela (p_por); exige la '
    'declaración de activación, la plantilla APPROVED en Meta y, con la base de contacto previo, al menos un '
    'interés. Registra una declaración por campaña (plantilla, su texto leído del espejo y destinatarios). '
    'Solo service role.';

-- ── 6. Tomar lote: baja de promociones, freno global, frecuencia que pospone ─
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
    v_ultimo   timestamptz;
    v_compradores text[] := '{}';
    v_row      public.whatsapp_campana_envios%ROWTYPE;
    r          record;
BEGIN
    IF p_campana_id IS NULL OR COALESCE(p_max, 0) < 1 OR COALESCE(p_limite_meta, 0) < 1 THEN
        RETURN;
    END IF;

    -- Freno de emergencia de plataforma: nada sale.
    IF EXISTS (SELECT 1 FROM public.whatsapp_campanas_freno_global g WHERE g.pausada_at IS NOT NULL) THEN
        RETURN;
    END IF;
    -- Ley 2300: segundo candado (el primero es el BFF). Fuera de horario, domingo o festivo: nada sale.
    IF NOT public.wa_horario_de_campanas() THEN
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
    -- La plantilla debe seguir APROBADA en Meta: si no, nada sale (un rechazo cuenta para el freno).
    IF NOT EXISTS (SELECT 1 FROM public.whatsapp_template_status t
                     JOIN public.school_whatsapp_integrations i ON i.id = t.integration_id
                    WHERE t.integration_id = v_c.integration_id AND t.name = v_c.plantilla AND t.language = v_c.idioma
                      AND t.status = 'APPROVED' AND (i.waba_id IS NULL OR t.waba_id = i.waba_id)) THEN
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

    -- Quien pagó o abonó el servicio DESPUÉS de la aprobación tampoco la recibe (una lectura por lote).
    IF v_cupo > 0 AND v_c.servicio_id IS NOT NULL THEN
        v_compradores := ARRAY(SELECT c.contact_wa_id FROM public.wa_compradores_de_servicio(v_c.school_id, v_c.servicio_id) c);
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
                                AND (o.opted_out_at IS NOT NULL OR o.promos_out_at IS NOT NULL)) THEN 'baja'
                WHEN public.wa_is_blocked(v_c.integration_id, r.contact_wa_id) THEN 'bloqueado'
                WHEN r.contact_wa_id = ANY (v_compradores) THEN 'ya_compro'
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_conversations wc
                              WHERE wc.integration_id = v_c.integration_id AND wc.contact_wa_id = r.contact_wa_id
                                AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma', 'equipo',
                                                        'staff', 'familia', 'familia_sin_cuenta')) THEN 'marca_manual'
                WHEN EXISTS (SELECT 1 FROM public.whatsapp_audiencia a
                              WHERE a.integration_id = v_c.integration_id AND a.contact_wa_id = r.contact_wa_id
                                AND a.excluido IS NOT NULL) THEN 'excluido'
                WHEN v_aj.base_consentimiento = 'optin'
                     AND NOT public.wa_can_send_template(v_c.integration_id, r.contact_wa_id) THEN 'sin_optin'
            END;

            IF v_motivo IS NOT NULL THEN
                UPDATE public.whatsapp_campana_envios
                   SET estado = 'omitido', motivo = v_motivo, updated_at = now()
                 WHERE id = r.id;
                CONTINUE;
            END IF;

            -- Frecuencia: otra campaña le escribió hace menos de frecuencia_min_dias. No se
            -- pierde: se pospone al momento en que se cumple el plazo (sigue 'pendiente').
            SELECT max(e2.enviado_at) INTO v_ultimo
              FROM public.whatsapp_campana_envios e2
             WHERE e2.integration_id = v_c.integration_id AND e2.contact_wa_id = r.contact_wa_id
               AND e2.campana_id <> v_c.id
               AND e2.enviado_at > now() - make_interval(days => v_aj.frecuencia_min_dias);
            IF v_ultimo IS NOT NULL THEN
                UPDATE public.whatsapp_campana_envios
                   SET proximo_intento_at = v_ultimo + make_interval(days => v_aj.frecuencia_min_dias),
                       motivo = 'frecuencia', updated_at = now()
                 WHERE id = r.id;
                CONTINUE;
            END IF;

            UPDATE public.whatsapp_campana_envios
               SET estado = 'enviando', lease_hasta = now() + interval '10 minutes',
                   intentos = intentos + 1, motivo = NULL, updated_at = now()
             WHERE id = r.id
            RETURNING * INTO v_row;
            v_tomados := v_tomados + 1;
            RETURN NEXT v_row;
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

-- ── 7. Permisos: solo service role (revocar explícito de authenticated y anon) ─
REVOKE ALL ON FUNCTION public.wa_registrar_baja_promos(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_reactivar_promos(uuid, text)                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_puede_recibir_promos(uuid, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campanas_activar(uuid, uuid, text, text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.co_festivos_del_anio(int)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_horario_de_campanas(timestamptz)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_compradores_de_servicio(uuid, uuid)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campanas_pausar_escuela(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campanas_reanudar_escuela(uuid, uuid, text)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campanas_freno_global(uuid, boolean, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int)            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_registrar_baja_promos(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_reactivar_promos(uuid, text)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_puede_recibir_promos(uuid, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campanas_activar(uuid, uuid, text, text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text, text)       TO service_role;
GRANT EXECUTE ON FUNCTION public.co_festivos_del_anio(int)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_horario_de_campanas(timestamptz)              TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_compradores_de_servicio(uuid, uuid)           TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campanas_pausar_escuela(uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campanas_reanudar_escuela(uuid, uuid, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campanas_freno_global(uuid, boolean, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int)            TO service_role;

-- ── 9. Conversión de las bajas existentes ────────────────────────────────────
-- Baja total que vino del botón «No recibir más» de una campaña (hay un envío en
-- estado 'baja') y NO de una palabra de baja → baja de promociones. Lo que no
-- tenga esa evidencia se queda como baja total (ante la duda, no se le escribe).
UPDATE public.whatsapp_optins o
   SET promos_out_at  = o.opted_out_at,
       promos_out_ref = left(o.source_ref, 200),
       opted_out_at   = NULL,
       source         = CASE WHEN o.opted_in_at IS NULL THEN 'baja_promos' ELSE o.source END,
       updated_at     = now()
 WHERE o.opted_out_at IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.whatsapp_campana_envios e
                WHERE e.integration_id = o.integration_id AND e.contact_wa_id = o.contact_wa_id
                  AND e.estado = 'baja')
   AND NOT EXISTS (
        SELECT 1 FROM public.whatsapp_messages m
         WHERE m.integration_id = o.integration_id AND m.from_wa_id = o.contact_wa_id
           AND m.direction = 'inbound'
           AND btrim(regexp_replace(regexp_replace(
                   translate(btrim(lower(COALESCE(m.text_body, ''))), 'áéíóúüñ', 'aeiouun'),
                   '[^a-z0-9 ]', '', 'g'), '\s+', ' ', 'g'))
               = ANY (ARRAY['stop', 'baja', 'cancelar suscripcion', 'desuscribir', 'no molestar', 'salir']));

COMMIT;

-- =============================================================================
-- Verificación (DESPUÉS de aplicar; solo lecturas, por nombre):
--   select proname, pg_get_function_identity_arguments(oid), proacl, proconfig from pg_proc
--    where proname in ('wa_registrar_baja_promos','wa_reactivar_promos','wa_puede_recibir_promos',
--                      'wa_campanas_activar','wa_campana_aprobar','wa_campana_tomar_lote',
--                      'wa_horario_de_campanas','wa_campanas_pausar_escuela',
--                      'wa_campanas_reanudar_escuela','wa_campanas_freno_global');
--   select public.wa_horario_de_campanas('2026-11-16 10:00-05'),   -- false (festivo)
--          public.wa_horario_de_campanas('2026-11-17 06:59-05'),   -- false
--          public.wa_horario_de_campanas('2026-11-17 07:00-05'),   -- true
--          public.wa_horario_de_campanas('2026-11-21 15:01-05');   -- false (sábado)
--   select holiday_date, name from public.co_holidays where name = 'Virgen de Chiquinquirá' order by 1;
--          -- 2026-07-13, 2027-07-12, 2028-07-10 … 2035
--   select count(*) filter (where opted_out_at is not null) as bajas_totales,
--          count(*) filter (where promos_out_at is not null) as bajas_promos from public.whatsapp_optins;
--   set local role anon; select count(*) from public.whatsapp_campanas_declaraciones;   -- debe fallar (42501)
--   npm run seguridad:invariantes
-- =============================================================================
