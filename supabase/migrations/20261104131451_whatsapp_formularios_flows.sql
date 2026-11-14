-- =============================================================================
-- 20261104131451_whatsapp_formularios_flows.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-04   Versión anterior: 20261104115612
-- Objetivo: fase F-a de docs/specs/whatsapp-plan-v2-anuncios-campanas-formularios.md
-- §3 (formularios dentro de WhatsApp = WhatsApp Flows, SIN endpoint):
--   · whatsapp_flows: los formularios de cada escuela en SU cuenta de WhatsApp
--     (WABA). Nombre lógico (el JSON del repo, bff/whatsapp-flows/<nombre>.json),
--     el flow_id que dio Meta, la versión del JSON subida, el estado en Meta
--     (DRAFT/PUBLISHED/DEPRECATED/THROTTLED/BLOCKED), la salud contra el número
--     (`health_status.can_send_message`) y `activo` = el interruptor de la escuela
--     (prender/apagar ese formulario sin tocar Meta). Lo escribe el script
--     bff/scripts/wa-registrar-flow.ts y el webhook (`flows` → FLOW_STATUS_CHANGE).
--   · whatsapp_flow_respuestas: cada formulario terminado (`interactive.nfm_reply`),
--     UNA fila por wa_message_id (idempotencia), con el response_json y en qué
--     terminó (procesada, token inválido/vencido, sin consentimiento…).
--   · whatsapp_consentimientos: el registro auditable (Ley 1581) de lo que aceptó
--     cada contacto: tipo 'datos' (tratamiento de datos, obligatorio) o
--     'novedades' (mensajes de la escuela, opcional), aceptado sí/no, versión de
--     la política, texto mostrado, canal y de dónde vino (fuente_id).
--   · whatsapp_optins.source admite 'formulario_wa': al aceptar «novedades» el
--     BFF registra el opt-in con wa_register_optin (lo que ya usan las campañas y
--     wa_can_send_template), con source_ref = id de la respuesta.
--   · wa_consentimientos_de_escuela: lectura para la pantalla futura de
--     Consentimientos. Gate ADENTRO: administración de ESA escuela o admin de
--     plataforma.
-- Todas las tablas: solo BFF (RLS sin policies, sin GRANT a anon/authenticated).
-- No toca whatsapp_messages ni ninguna tabla de alto volumen.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. Formularios por escuela (solo BFF) ────────────────────────────────────
CREATE TABLE public.whatsapp_flows (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id           uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    integration_id      uuid        NOT NULL,
    -- Nombre lógico = archivo del repo (bff/whatsapp-flows/<nombre>.json).
    nombre              text        NOT NULL CHECK (nombre ~ '^[a-z0-9_]{1,60}$'),
    -- Lo que dio Meta al crearlo (POST /{waba}/flows). NULL mientras no exista allá.
    flow_id             text        CHECK (flow_id IS NULL OR flow_id ~ '^[0-9]{1,40}$'),
    -- Nombre con que quedó en la WABA (único por WABA en Meta).
    nombre_en_meta      text        CHECK (nombre_en_meta IS NULL OR length(btrim(nombre_en_meta)) BETWEEN 1 AND 200),
    -- Versión del JSON del repo que se subió: sha256 corto del archivo + versión de Flow JSON.
    version_repo        text        CHECK (version_repo IS NULL OR length(version_repo) BETWEEN 1 AND 64),
    flow_json_version   text        CHECK (flow_json_version IS NULL OR flow_json_version ~ '^[0-9]+\.[0-9]+$'),
    estado              text        NOT NULL DEFAULT 'DRAFT'
                        CHECK (estado IN ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'THROTTLED', 'BLOCKED')),
    -- Interruptor de la escuela: el bot solo lo manda con activo = true (además de publicado y sano).
    activo              boolean     NOT NULL DEFAULT false,
    -- health_status.can_send_message del flow contra el número de la integración.
    health_can_send     text        CHECK (health_can_send IS NULL OR health_can_send IN ('AVAILABLE', 'LIMITED', 'BLOCKED')),
    health_detalle      jsonb,
    health_revisado_at  timestamptz,
    -- validation_errors de la última subida (vacío = sin errores).
    validacion          jsonb,
    -- Ajustes del formulario en esa escuela (p. ej. {"tallas": ["S","M","L"], "pedir_talla": "auto"}).
    config              jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
    publicado_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_wa_flows_integracion FOREIGN KEY (integration_id, school_id)
        REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE,
    CONSTRAINT uq_wa_flows_integracion_nombre UNIQUE (integration_id, nombre)
);

COMMENT ON TABLE public.whatsapp_flows IS
    'Formularios de WhatsApp (Flows) registrados en la WABA de cada escuela: flow_id de Meta, versión del JSON del repo, '
    'estado en Meta, salud contra el número y el interruptor de la escuela (activo). Lo escriben '
    'bff/scripts/wa-registrar-flow.ts y el webhook (campo flows). Solo service role (RLS sin policies). (20261104131451)';
COMMENT ON COLUMN public.whatsapp_flows.activo IS
    'La escuela usa este formulario: el bot lo manda solo con activo = true, estado PUBLISHED y salud AVAILABLE/LIMITED. '
    'Apagarlo devuelve a la escuela al chat por pasos sin tocar Meta. (20261104131451)';
COMMENT ON COLUMN public.whatsapp_flows.health_can_send IS
    'health_status.can_send_message (GET /{flow_id}?fields=health_status.phone_number(<phone_number_id>)): resume app, '
    'negocio (verificación), WABA y flow. NULL = no se ha consultado: el bot no manda el formulario. (20261104131451)';

CREATE UNIQUE INDEX uq_wa_flows_flow_id ON public.whatsapp_flows (flow_id) WHERE flow_id IS NOT NULL;
CREATE INDEX idx_wa_flows_escuela ON public.whatsapp_flows (school_id);

ALTER TABLE public.whatsapp_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_flows FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_flows TO service_role;

-- ── 2. Respuestas (nfm_reply), una por mensaje (solo BFF) ────────────────────
CREATE TABLE public.whatsapp_flow_respuestas (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- El formulario de la escuela (NULL si el token no dejó saber cuál).
    flow_id             uuid        REFERENCES public.whatsapp_flows(id) ON DELETE SET NULL,
    nombre_formulario   text        CHECK (nombre_formulario IS NULL OR nombre_formulario ~ '^[a-z0-9_]{1,60}$'),
    school_id           uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    integration_id      uuid        NOT NULL,
    conversation_id     uuid        REFERENCES public.whatsapp_conversations(id) ON DELETE SET NULL,
    contact_wa_id       text        NOT NULL CHECK (contact_wa_id ~ '^[0-9]{6,20}$'),
    -- Idempotencia: Meta reintenta el webhook con el mismo id.
    wa_message_id       text        NOT NULL CHECK (length(wa_message_id) BETWEEN 1 AND 200),
    -- Id del token (nonce) con que se envió el formulario.
    token_id            text        CHECK (token_id IS NULL OR length(token_id) BETWEEN 1 AND 64),
    servicio_id         uuid        REFERENCES public.school_tournament_items(id) ON DELETE SET NULL,
    -- Lo que mandó el formulario (sin datos personales si no aceptó el tratamiento de datos).
    response_json       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_json) = 'object'),
    resultado           text        NOT NULL DEFAULT 'recibida'
                        CHECK (resultado IN ('recibida', 'procesada', 'procesada_precio_nuevo', 'servicio_inactivo',
                                             'sin_consentimiento', 'token_invalido', 'token_vencido', 'error')),
    -- Montos, lead, motivo esperado… de lo que hizo el BFF con la respuesta.
    detalle             jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detalle) = 'object'),
    procesada_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_wa_flow_resp_integracion FOREIGN KEY (integration_id, school_id)
        REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE,
    CONSTRAINT uq_wa_flow_resp_mensaje UNIQUE (wa_message_id)
);

COMMENT ON TABLE public.whatsapp_flow_respuestas IS
    'Formularios de WhatsApp terminados (interactive.nfm_reply): uno por wa_message_id, con el response_json y su '
    'resultado. Sin consentimiento de datos el response_json queda sin datos personales. Solo service role. (20261104131451)';

CREATE INDEX idx_wa_flow_resp_escuela ON public.whatsapp_flow_respuestas (school_id, created_at DESC);
CREATE INDEX idx_wa_flow_resp_flow ON public.whatsapp_flow_respuestas (flow_id, created_at DESC) WHERE flow_id IS NOT NULL;
CREATE INDEX idx_wa_flow_resp_conversacion ON public.whatsapp_flow_respuestas (conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE public.whatsapp_flow_respuestas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_flow_respuestas FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_flow_respuestas TO service_role;

-- ── 3. Consentimientos (Ley 1581), solo BFF ──────────────────────────────────
-- Una fila por aceptación (o rechazo): el historial no se pisa. El vigente de un
-- contacto para un tipo = el más reciente sin revocado_at.
CREATE TABLE public.whatsapp_consentimientos (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id           uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    integration_id      uuid        REFERENCES public.school_whatsapp_integrations(id) ON DELETE SET NULL,
    contact_wa_id       text        NOT NULL CHECK (contact_wa_id ~ '^[0-9]{6,20}$'),
    tipo                text        NOT NULL CHECK (tipo IN ('datos', 'novedades')),
    aceptado            boolean     NOT NULL,
    version_politica    text        NOT NULL CHECK (length(btrim(version_politica)) BETWEEN 1 AND 40),
    -- El texto que se le mostró (prueba de qué aceptó).
    texto               text        CHECK (texto IS NULL OR length(texto) <= 500),
    canal               text        NOT NULL CHECK (canal IN ('formulario', 'chat', 'app')),
    -- De dónde salió: whatsapp_flow_respuestas.id (canal formulario) u otro registro.
    fuente_id           uuid,
    created_at          timestamptz NOT NULL DEFAULT now(),
    revocado_at         timestamptz,
    CONSTRAINT whatsapp_consentimientos_revocado_chk CHECK (revocado_at IS NULL OR revocado_at >= created_at)
);

COMMENT ON TABLE public.whatsapp_consentimientos IS
    'Consentimientos por contacto y escuela (Ley 1581): datos (tratamiento de datos) y novedades (mensajes de la '
    'escuela), con versión de la política, texto mostrado, canal y fuente. Aceptar novedades registra además el '
    'opt-in en whatsapp_optins (source formulario_wa). Solo service role; la escuela lee por '
    'wa_consentimientos_de_escuela. (20261104131451)';

CREATE INDEX idx_wa_consent_escuela_contacto
    ON public.whatsapp_consentimientos (school_id, contact_wa_id, tipo, created_at DESC);
CREATE INDEX idx_wa_consent_fuente ON public.whatsapp_consentimientos (fuente_id) WHERE fuente_id IS NOT NULL;

ALTER TABLE public.whatsapp_consentimientos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_consentimientos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_consentimientos TO service_role;

-- ── 4. Opt-in desde el formulario ────────────────────────────────────────────
-- Superconjunto del CHECK anterior (todas las filas actuales lo cumplen).
ALTER TABLE public.whatsapp_optins DROP CONSTRAINT chk_wa_optin_source;
ALTER TABLE public.whatsapp_optins ADD CONSTRAINT chk_wa_optin_source CHECK (source = ANY (ARRAY[
    'user_confirmed'::text, 'form_inscripcion'::text, 'invitacion'::text, 'import'::text,
    'admin_manual'::text, 'baja_directa'::text, 'bot_prospecto'::text, 'formulario_wa'::text
]));

-- ── 5. Lectura para la escuela (pantalla futura de Consentimientos) ──────────
-- El vigente por contacto y tipo (el más reciente). Gate ADENTRO: administración
-- de ESA escuela (user_admin_school_ids) o admin de plataforma activo. Sin JWT
-- (service_role) → 42501. El BFF la llama con el JWT del usuario.
CREATE FUNCTION public.wa_consentimientos_de_escuela(
    p_school_id uuid,
    p_contacto  text    DEFAULT NULL,
    p_limite    integer DEFAULT 500
)
RETURNS TABLE (
    contact_wa_id    text,
    tipo             text,
    aceptado         boolean,
    version_politica text,
    canal            text,
    fecha            timestamptz,
    revocado_at      timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF p_school_id IS NULL THEN
        RAISE EXCEPTION 'ESCUELA_REQUERIDA' USING ERRCODE = '22023';
    END IF;
    IF v_uid IS NULL OR NOT COALESCE(
           p_school_id = ANY (public.user_admin_school_ids())
        OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = v_uid AND pa.is_active),
        false) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT v.contact_wa_id, v.tipo, v.aceptado, v.version_politica, v.canal, v.created_at, v.revocado_at
      FROM (
        SELECT DISTINCT ON (c.contact_wa_id, c.tipo)
               c.contact_wa_id, c.tipo, c.aceptado, c.version_politica, c.canal, c.created_at, c.revocado_at
          FROM public.whatsapp_consentimientos c
         WHERE c.school_id = p_school_id
           AND (p_contacto IS NULL OR c.contact_wa_id = regexp_replace(p_contacto, '\D', '', 'g'))
         ORDER BY c.contact_wa_id, c.tipo, c.created_at DESC
      ) v
     ORDER BY v.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limite, 500), 1), 2000);
END;
$$;

COMMENT ON FUNCTION public.wa_consentimientos_de_escuela(uuid, text, integer) IS
    'Consentimientos vigentes (el más reciente por contacto y tipo) de una escuela. Solo administración de ESA '
    'escuela o admin de plataforma (42501 sin JWT). (20261104131451)';

REVOKE ALL ON FUNCTION public.wa_consentimientos_de_escuela(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_consentimientos_de_escuela(uuid, text, integer) TO authenticated;

COMMIT;

-- =============================================================================
-- Verificación (correr DESPUÉS de aplicar; solo lecturas, por nombre):
--
-- 1. Objetos y permisos
-- select relname, relrowsecurity from pg_class
--  where relname in ('whatsapp_flows','whatsapp_flow_respuestas','whatsapp_consentimientos');   → 3 filas, rls true
-- select tablename, count(*) from pg_policies
--  where tablename in ('whatsapp_flows','whatsapp_flow_respuestas','whatsapp_consentimientos') group by 1;  → 0 filas
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'chk_wa_optin_source';  → incluye formulario_wa
-- select proacl, proconfig from pg_proc where proname = 'wa_consentimientos_de_escuela';
--   → authenticated=X, sin anon; search_path fijo
--
-- 2. Cerradas al navegador
-- begin; set local role anon;          select count(*) from public.whatsapp_flows; rollback;            → 42501
-- begin; set local role authenticated; select count(*) from public.whatsapp_consentimientos; rollback;  → 42501
-- begin; set local role anon; select * from public.wa_consentimientos_de_escuela('eb3ebc77-4ea4-4992-96c8-3c8ec574578c'); rollback; → 42501
--
-- 3. Gate de la RPC
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', '<uuid de un coach o de otra escuela>', 'role', 'authenticated')::text, true);
--   select * from public.wa_consentimientos_de_escuela('eb3ebc77-4ea4-4992-96c8-3c8ec574578c');   → 42501 Forbidden
-- rollback;
--
-- 4. Invariantes: npm run seguridad:invariantes  (sin CRÍTICAS nuevas)
-- =============================================================================
