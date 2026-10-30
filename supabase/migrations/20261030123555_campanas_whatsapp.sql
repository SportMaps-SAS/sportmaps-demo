-- =============================================================================
-- 20261030123555_campanas_whatsapp.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261030123549
-- Objetivo: M3 del plan maestro del bot de WhatsApp de Monster
-- (docs/specs/whatsapp-monster-plan-maestro.md §2; exactamente plan B5 §2).
-- Campaña de marketing por escuela a los contactos clasificados del historial:
--   · whatsapp_campanas_ajustes: interruptor y límites por escuela. SIN FILA =
--     APAGADO: Dynasty y las demás no cambian (ni se lee whatsapp_messages).
--   · whatsapp_audiencia: una fila por número de la integración, con intereses,
--     sede y motivo de exclusión.
--   · whatsapp_campanas / whatsapp_campana_envios: la campaña aprobada y su foto
--     de destinatarios; idempotencia campaña + número, «a lo sumo una vez» con lease.
--   · wa_audiencia_excluidos: familias, staff e inscritos en UN barrido.
--   · wa_campana_aprobar: valida ADENTRO (borrador, escuela habilitada, quien
--     aprueba es admin de ESA escuela, declaración si la base es contacto previo).
--   · wa_campana_tomar_lote: cupo (Meta 24 h, tope diario, piloto del 1.er día),
--     omisiones (baja, bloqueo, marca manual, frecuencia, sin opt-in) y lease.
-- Las 4 tablas y las 3 funciones son solo-BFF: RLS prendido sin policies y
-- EXECUTE solo para service_role. La pantalla lee por rutas del BFF.
-- Bases de consentimiento: 'optin' y 'contacto_previo_declarado'; la escuela
-- elige al encender (decisión pendiente del usuario: el código soporta las dos).
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

-- ── 1. Interruptor + límites por escuela ─────────────────────────────────────
CREATE TABLE public.whatsapp_campanas_ajustes (
    school_id            uuid        PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    habilitadas          boolean     NOT NULL DEFAULT false,
    base_consentimiento  text        NOT NULL DEFAULT 'optin'
                         CHECK (base_consentimiento IN ('optin', 'contacto_previo_declarado')),
    tope_diario_max      int         NOT NULL DEFAULT 200 CHECK (tope_diario_max BETWEEN 1 AND 100000),
    lote_piloto          int         NOT NULL DEFAULT 50 CHECK (lote_piloto BETWEEN 1 AND 1000),   -- 1.er día de cada campaña
    frecuencia_min_dias  int         NOT NULL DEFAULT 7 CHECK (frecuencia_min_dias BETWEEN 1 AND 90),
    antiguedad_max_dias  int         NOT NULL DEFAULT 180 CHECK (antiguedad_max_dias BETWEEN 1 AND 365),
    -- [{branch_id, palabras:[…]}]: las palabras de cada sede viven en datos, nada de Monster en el código.
    palabras_sede        jsonb       NOT NULL DEFAULT '[]'::jsonb
                         CONSTRAINT wa_campanas_ajustes_palabras_sede_check
                         CHECK (jsonb_typeof(palabras_sede) = 'array'
                                AND jsonb_array_length(palabras_sede) <= 20
                                AND NOT (palabras_sede @? '$[*] ? (@.type() != "object"
                                    || !(exists(@.branch_id)) || !(exists(@.palabras))
                                    || @.branch_id.type() != "string" || @.palabras.type() != "array")')
                                AND NOT (palabras_sede @? '$[*].palabras[*] ? (@.type() != "string")')),
    pausada_at           timestamptz,
    pausa_motivo         text        CHECK (pausa_motivo IS NULL OR length(pausa_motivo) <= 500),
    habilitado_por       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    habilitado_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_campanas_ajustes IS
    'Campañas de marketing por WhatsApp: interruptor y límites por escuela. Sin fila = apagado. Solo service role. (20261030123555)';

-- ── 2. Audiencia clasificada: una fila por número de la integración ──────────
CREATE TABLE public.whatsapp_audiencia (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id         uuid        NOT NULL,
    school_id              uuid        NOT NULL,
    conversation_id        uuid        REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    contact_wa_id          text        NOT NULL CHECK (contact_wa_id ~ '^[0-9]{6,20}$'),
    intereses              text[]      NOT NULL DEFAULT '{}'
                           CHECK (intereses <@ ARRAY['clase_prueba', 'inscripcion', 'clinica', 'precio',
                                                     'horarios', 'informacion']::text[]),
    branch_id              uuid        REFERENCES public.school_branches(id) ON DELETE SET NULL,
    excluido               text        CHECK (excluido IN ('familia', 'staff', 'marca_manual', 'baja',
                                                           'bloqueado', 'no_interesa', 'inscrito')),
    fuente                 text        NOT NULL DEFAULT 'reglas' CHECK (fuente IN ('reglas', 'modelo', 'importado')),
    evidencia_wa_message_id text,
    primer_entrante_at     timestamptz,
    ultimo_entrante_at     timestamptz,
    version_reglas         smallint    NOT NULL DEFAULT 1,
    clasificado_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wa_audiencia UNIQUE (integration_id, contact_wa_id),
    CONSTRAINT fk_wa_audiencia_integ FOREIGN KEY (integration_id, school_id)
        REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.whatsapp_audiencia IS
    'Contactos del historial de WhatsApp clasificados por intención y sede para campañas. Solo service role. (20261030123555)';

CREATE INDEX idx_wa_audiencia_vigente
    ON public.whatsapp_audiencia (integration_id) WHERE excluido IS NULL;

-- ── 3. Campañas ──────────────────────────────────────────────────────────────
CREATE TABLE public.whatsapp_campanas (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_id       uuid        NOT NULL,
    school_id            uuid        NOT NULL,
    nombre               text        NOT NULL CHECK (length(nombre) BETWEEN 3 AND 80),
    plantilla            text        NOT NULL CHECK (length(plantilla) <= 512 AND plantilla ~ '^[a-z0-9_]+$'),
    idioma               text        NOT NULL DEFAULT 'es_CO' CHECK (idioma ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
    filtro               jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filtro) = 'object'),  -- {intereses:[], branch_ids:[]}
    variables            jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(variables) = 'array'), -- ["nombre"] → {{1}}
    respuesta_si         text        CHECK (respuesta_si IS NULL OR length(respuesta_si) BETWEEN 1 AND 1024),
    estado               text        NOT NULL DEFAULT 'borrador'
                         CHECK (estado IN ('borrador', 'aprobada', 'enviando', 'pausada', 'terminada', 'cancelada')),
    destinatarios        int,
    aprobada_por         uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    aprobada_at          timestamptz,
    declaracion_version  text        CHECK (declaracion_version IS NULL OR length(declaracion_version) <= 2000),
    vence_at             timestamptz,
    pausa_motivo         text        CHECK (pausa_motivo IS NULL OR length(pausa_motivo) <= 500),
    creada_por           uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_wa_campana_integ FOREIGN KEY (integration_id, school_id)
        REFERENCES public.school_whatsapp_integrations(id, school_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.whatsapp_campanas IS
    'Campaña de marketing por WhatsApp (plantilla MARKETING aprobada por Meta + filtro de audiencia). Solo service role. (20261030123555)';

-- El cron de cada 10 min solo mira las vivas (tabla chica; sin campañas = cero IO).
CREATE INDEX idx_wa_campanas_vivas
    ON public.whatsapp_campanas (estado) WHERE estado IN ('aprobada', 'enviando');

-- ── 4. Envíos (idempotencia: UNIQUE campaña + número; a lo sumo una vez, con lease)
CREATE TABLE public.whatsapp_campana_envios (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    campana_id         uuid        NOT NULL REFERENCES public.whatsapp_campanas(id) ON DELETE CASCADE,
    integration_id     uuid        NOT NULL,
    school_id          uuid        NOT NULL,
    contact_wa_id      text        NOT NULL,
    estado             text        NOT NULL DEFAULT 'pendiente'
                       CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'incierto', 'fallido',
                                         'omitido', 'respondio_si', 'respondio_luego', 'baja')),
    motivo             text        CHECK (motivo IS NULL OR length(motivo) <= 500),
    wa_message_id      text,
    intentos           smallint    NOT NULL DEFAULT 0,
    proximo_intento_at timestamptz,
    lease_hasta        timestamptz,
    enviado_at         timestamptz,
    respondido_at      timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wa_campana_envio UNIQUE (campana_id, contact_wa_id)
);

COMMENT ON TABLE public.whatsapp_campana_envios IS
    'Un envío por campaña y número. enviando = tomado con lease de 10 min; si vence sin confirmar queda incierto '
    '(no se reenvía). Solo service role. (20261030123555)';

CREATE INDEX idx_wa_envios_cola
    ON public.whatsapp_campana_envios (campana_id, proximo_intento_at) WHERE estado = 'pendiente';
CREATE INDEX idx_wa_envios_contacto
    ON public.whatsapp_campana_envios (integration_id, contact_wa_id, enviado_at DESC);
CREATE UNIQUE INDEX uq_wa_envios_wamid
    ON public.whatsapp_campana_envios (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- ── RLS: las 4 tablas son solo-BFF ───────────────────────────────────────────
ALTER TABLE public.whatsapp_campanas_ajustes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_audiencia        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_campanas         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_campana_envios   ENABLE ROW LEVEL SECURITY;
-- Sin policies, a propósito. Los default privileges le dan todo a authenticated
-- en tablas nuevas: se revoca explícito.
REVOKE ALL ON TABLE public.whatsapp_campanas_ajustes, public.whatsapp_audiencia,
                    public.whatsapp_campanas, public.whatsapp_campana_envios
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.whatsapp_campanas_ajustes, public.whatsapp_audiencia,
                    public.whatsapp_campanas, public.whatsapp_campana_envios
    TO service_role;

-- Cupo de Meta: destinatarios de plantillas de la integración en 24 h. Índice
-- parcial chico (solo plantillas salientes) para no recorrer todo el historial
-- de la integración en cada tick.
CREATE INDEX idx_wa_msg_plantillas_salientes
    ON public.whatsapp_messages (integration_id, created_at)
    WHERE direction = 'outbound' AND type = 'template';

-- ── 5. Exclusión por teléfono en UN barrido ──────────────────────────────────
-- En vez de N llamadas a wa_identify_by_phone (sin índice por teléfono en
-- profiles). Todas las fuentes acotadas a ESTA escuela; a profiles se llega por
-- PK. Prioridad: staff > familia > inscrito. Hasta 1000 números por llamada.
CREATE FUNCTION public.wa_audiencia_excluidos(p_school_id uuid, p_wa_ids text[])
RETURNS TABLE (contact_wa_id text, motivo text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_school_id IS NULL OR p_wa_ids IS NULL OR cardinality(p_wa_ids) = 0 THEN
        RETURN;
    END IF;
    IF cardinality(p_wa_ids) > 1000 THEN
        RAISE EXCEPTION 'LOTE_DEMASIADO_GRANDE' USING ERRCODE = '22023', HINT = 'Máximo 1000 números por llamada.';
    END IF;

    RETURN QUERY
    WITH t AS (
        SELECT DISTINCT w AS wa,
               COALESCE(public.wa_celular_remitente_co(w), regexp_replace(w, '[^0-9]', '', 'g')) AS llave
          FROM unnest(p_wa_ids) AS w
         WHERE w IS NOT NULL AND btrim(w) <> ''
    ),
    tel AS (
        -- staff (prio 1)
        SELECT pr.phone AS fono, 'staff'::text AS mot, 1 AS prio
          FROM public.school_members sm JOIN public.profiles pr ON pr.id = sm.profile_id
         WHERE sm.school_id = p_school_id AND sm.status = 'active' AND sm.role NOT IN ('parent', 'athlete')
        UNION ALL
        SELECT ss.phone, 'staff', 1
          FROM public.school_staff ss
         WHERE ss.school_id = p_school_id AND ss.status = 'active'
        UNION ALL
        SELECT pr.phone, 'staff', 1
          FROM public.schools s JOIN public.profiles pr ON pr.id = s.owner_id
         WHERE s.id = p_school_id
        -- familia (prio 2)
        UNION ALL
        SELECT c.parent_phone_temp, 'familia', 2
          FROM public.children c
         WHERE c.school_id = p_school_id AND c.is_active AND c.parent_phone_temp IS NOT NULL
        UNION ALL
        SELECT pr.phone, 'familia', 2
          FROM public.children c JOIN public.profiles pr ON pr.id = c.parent_id
         WHERE c.school_id = p_school_id AND c.is_active
        UNION ALL
        SELECT pr.phone, 'familia', 2
          FROM public.school_members sm JOIN public.profiles pr ON pr.id = sm.profile_id
         WHERE sm.school_id = p_school_id AND sm.status = 'active' AND sm.role IN ('parent', 'athlete')
        UNION ALL
        SELECT pr.phone, 'familia', 2
          FROM public.enrollments e JOIN public.profiles pr ON pr.id = e.user_id
         WHERE e.school_id = p_school_id AND e.status IN ('active', 'pending')
        UNION ALL
        SELECT ua.phone, 'familia', 2
          FROM public.unregistered_athletes ua
         WHERE ua.school_id = p_school_id AND ua.is_active AND ua.phone IS NOT NULL
        UNION ALL
        SELECT ua.guardian_phone, 'familia', 2
          FROM public.unregistered_athletes ua
         WHERE ua.school_id = p_school_id AND ua.is_active AND ua.guardian_phone IS NOT NULL
        -- inscrito (prio 3): prospecto que ya se convirtió
        UNION ALL
        SELECT l.phone, 'inscrito', 3
          FROM public.school_signup_leads l
         WHERE l.school_id = p_school_id AND l.status = 'converted'
    ),
    tel_llave AS (
        SELECT COALESCE(public.wa_celular_remitente_co(tel.fono),
                        regexp_replace(tel.fono, '[^0-9]', '', 'g')) AS llave,
               tel.mot, tel.prio
          FROM tel
         WHERE tel.fono IS NOT NULL AND regexp_replace(tel.fono, '[^0-9]', '', 'g') <> ''
    )
    SELECT DISTINCT ON (t.wa) t.wa, tl.mot
      FROM t
      JOIN tel_llave tl ON tl.llave = t.llave
     ORDER BY t.wa, tl.prio;
END;
$$;

COMMENT ON FUNCTION public.wa_audiencia_excluidos(uuid, text[]) IS
    'Campañas: de una lista de números (≤1000), cuáles son staff, familia o inscritos de la escuela. Solo service role. (20261030123555)';

REVOKE ALL ON FUNCTION public.wa_audiencia_excluidos(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_audiencia_excluidos(uuid, text[]) TO service_role;

-- ── 6. Aprobar = foto de la audiencia ────────────────────────────────────────
-- Valida ADENTRO: campaña en 'borrador', escuela habilitada y sin pausa,
-- integración activa, p_por es dueño u owner/admin/school_admin activo de ESA
-- escuela (como adminsDeEscuela), declaración si la base es contacto previo.
-- Devuelve cuántos destinatarios quedaron; con 0 la campaña sigue en borrador.
CREATE FUNCTION public.wa_campana_aprobar(p_campana_id uuid, p_por uuid, p_declaracion text)
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

    IF p_por IS NULL OR NOT (
           EXISTS (SELECT 1 FROM public.schools s WHERE s.id = v_c.school_id AND s.owner_id = p_por)
        OR EXISTS (SELECT 1 FROM public.school_members sm
                    WHERE sm.school_id = v_c.school_id AND sm.profile_id = p_por
                      AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin'))) THEN
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
    'Campañas: aprueba un borrador y congela sus destinatarios. Valida escuela habilitada, admin de ESA escuela y '
    'declaración (contacto previo). Devuelve el conteo; 0 = sigue en borrador. Solo service role. (20261030123555)';

REVOKE ALL ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campana_aprobar(uuid, uuid, text) TO service_role;

-- ── 7. Tomar un lote ─────────────────────────────────────────────────────────
-- pg_advisory_xact_lock por integración (el cupo se calcula de a uno entre los 3
-- BFF); 'enviando' con lease vencido → 'incierto' (no se reenvía); omite baja,
-- bloqueo, marca manual, excluido, marketing a ese número hace < frecuencia, sin
-- opt-in (base optin) y campaña vencida. Cupo = el menor entre p_max, el límite
-- de Meta menos los destinatarios de plantillas en 24 h, el tope diario de la
-- escuela y, el primer día de la campaña, el lote piloto. FOR UPDATE SKIP LOCKED
-- → 'enviando', lease 10 min, intentos+1.
CREATE FUNCTION public.wa_campana_tomar_lote(p_campana_id uuid, p_max int, p_limite_meta int)
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
                                AND wc.contact_kind IN ('personal', 'negocio', 'otro_club', 'plataforma',
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

COMMENT ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int) IS
    'Campañas: toma hasta p_max envíos pendientes (cupo de Meta 24 h, tope diario, piloto, omisiones) y los deja '
    'en enviando con lease de 10 min. Serializado por integración. Solo service role. (20261030123555)';

REVOKE ALL ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campana_tomar_lote(uuid, int, int) TO service_role;

COMMIT;
