-- =============================================================================
-- 20261104115612_whatsapp_anuncios_atribucion.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-04   Versión anterior: 20261103202610
-- Objetivo: fase 1 de docs/specs/whatsapp-anuncios-atribucion.md (anuncios de
-- Meta con clic a WhatsApp: de dónde viene cada interesado y hasta dónde llega).
--   · whatsapp_atribucion: por conversación, el anuncio del PRIMER toque (de
--     dónde llegó: manda en el embudo, D2) y el del ÚLTIMO (el que lo hizo
--     volver). Solo BFF / RPC (RLS sin policies).
--   · Trigger AFTER INSERT en whatsapp_messages: solo entrantes con
--     payload.referral (el WHEN lo filtra antes de llamar la función: la tabla
--     es de alto volumen y el resto de inserts no paga nada).
--   · Backfill idempotente desde los payloads ya guardados.
--   · whatsapp_anuncio_destino: «este anuncio va a…» (clase de prueba / un
--     servicio del catálogo / una persona). Lo escribe la administración de la
--     escuela; lo lee el bot (service role) antes de inferir por el texto (D1).
--   · wa_embudo_anuncios: el embudo por anuncio para la pestaña WhatsApp ›
--     Anuncios. Gate ADENTRO: administración de ESA escuela o admin de plataforma.
-- Sin gasto (D3: fase 2).
--
-- Hallazgos en la base viva (2026-11-04, consultas puntuales):
--   · El historial de coexistencia SÍ trae referral: 602 entrantes con
--     referral.source_id en Monster → 561 conversaciones de 38 anuncios, del
--     2026-06-11 al 2026-11-04, todos con payload.historial = true y created_at =
--     wa_timestamp (fecha real del mensaje); 25 volvieron por otro anuncio. Aún
--     no hay ninguno vivo (el webhook no ha recibido clics desde la conexión). Por eso el backfill toma TODO lo que tenga referral (no solo
--     desde el 2026-11-04) y marca primer_historial: de esas conversaciones solo
--     se sabe que llegaron por el anuncio; las etapas siguientes no se midieron
--     (el bot no las atendía). Para limitarlo a lo vivo, agregar
--     `AND COALESCE(m.wa_timestamp, m.created_at) >= '2026-11-04'` en `ref`.
--   · Formato real del referral (Cloud API): source_id, source_type ('ad' |
--     'post'), source_url, headline, body, media_type ('image' | 'video'),
--     image_url | video_url + thumbnail_url, ctwa_clid, welcome_message.
--   · whatsapp_inbound_queue.wa_phone_number = whatsapp_conversations.contact_wa_id
--     en las 672 filas de la cola (así se liga un comprobante a su conversación).
--   · whatsapp_messages no tiene hoy ningún otro trigger (pg_trigger, 2026-11-04).
--
-- Orden a propósito: el trigger se crea ANTES del backfill. CREATE TRIGGER toma
-- SHARE ROW EXCLUSIVE sobre whatsapp_messages (espera a los INSERT en curso y
-- frena los nuevos hasta el COMMIT), y el backfill corre con una foto posterior:
-- ningún mensaje queda entre los dos. El backfill recalcula todo (no suma), así
-- que correrlo otra vez deja lo mismo.
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

-- Si algo largo tiene tomada whatsapp_messages, mejor fallar rápido (y reintentar)
-- que dejar la ingesta del webhook en fila detrás del CREATE TRIGGER.
SET LOCAL lock_timeout = '5s';

-- ── 1. Atribución por conversación (solo BFF / RPC) ──────────────────────────
CREATE TABLE public.whatsapp_atribucion (
    conversation_id    uuid        PRIMARY KEY REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
    integration_id     uuid        NOT NULL REFERENCES public.school_whatsapp_integrations(id) ON DELETE CASCADE,
    school_id          uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    contact_wa_id      text        NOT NULL,
    -- Primer toque: de qué anuncio llegó (manda en el embudo).
    primer_source_id   text        NOT NULL,
    primer_source_type text,
    primer_headline    text,
    primer_body        text,
    primer_source_url  text,
    primer_media_type  text,
    primer_media_url   text,
    primer_ctwa_clid   text,
    primer_at          timestamptz NOT NULL,
    primer_historial   boolean     NOT NULL DEFAULT false,
    -- Último toque: el anuncio que lo hizo volver (se muestra aparte).
    ultimo_source_id   text        NOT NULL,
    ultimo_source_type text,
    ultimo_headline    text,
    ultimo_source_url  text,
    ultimo_ctwa_clid   text,
    ultimo_at          timestamptz NOT NULL,
    toques             integer     NOT NULL DEFAULT 1 CHECK (toques >= 1),
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT whatsapp_atribucion_orden_chk CHECK (ultimo_at >= primer_at)
);

COMMENT ON TABLE public.whatsapp_atribucion IS
    'Anuncio de Meta (clic a WhatsApp) de cada conversación: primer toque (de dónde llegó) y último (el que la hizo '
    'volver), desde whatsapp_messages.payload.referral. La llena el trigger trg_wa_atribucion_desde_mensaje. '
    'Solo service role / RPC (RLS sin policies). (20261104115612)';
COMMENT ON COLUMN public.whatsapp_atribucion.primer_historial IS
    'El primer toque llegó por el historial de coexistencia (antes de conectar SportMaps): las etapas siguientes no se '
    'midieron. (20261104115612)';
COMMENT ON COLUMN public.whatsapp_atribucion.primer_media_url IS
    'thumbnail_url o image_url del referral. Es del CDN de Meta y vence: la pantalla lo muestra solo si carga. (20261104115612)';
COMMENT ON COLUMN public.whatsapp_atribucion.toques IS
    'Mensajes entrantes con referral en la conversación (cuántas veces llegó por un anuncio). (20261104115612)';

CREATE INDEX idx_wa_atribucion_escuela_primer ON public.whatsapp_atribucion (school_id, primer_at);
CREATE INDEX idx_wa_atribucion_escuela_ultimo ON public.whatsapp_atribucion (school_id, ultimo_at)
    WHERE ultimo_source_id <> primer_source_id;

ALTER TABLE public.whatsapp_atribucion ENABLE ROW LEVEL SECURITY;
-- Sin policies, a propósito: el navegador la ve solo agregada por wa_embudo_anuncios.
REVOKE ALL ON public.whatsapp_atribucion FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_atribucion TO service_role;

-- ── 2. Trigger: cada entrante con referral actualiza su atribución ───────────
-- El WHEN del trigger filtra (dirección + clave referral) antes de llamar la
-- función: el resto de inserts (salientes, historial sin anuncio) no la invoca.
-- Primer/último se deciden por la FECHA del mensaje, no por el orden de llegada:
-- el historial de coexistencia entra después de lo vivo con fechas pasadas.
-- Nunca tumba la ingesta: ante cualquier error deja un WARNING y sigue.
CREATE FUNCTION public.fn_wa_atribucion_desde_mensaje()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_ref   jsonb := NEW.payload->'referral';
    v_sid   text;
    v_at    timestamptz := COALESCE(NEW.wa_timestamp, NEW.created_at, now());
    v_conv  record;
BEGIN
    IF v_ref IS NULL OR jsonb_typeof(v_ref) <> 'object' THEN
        RETURN NULL;
    END IF;
    v_sid := left(NULLIF(btrim(v_ref->>'source_id'), ''), 100);
    IF v_sid IS NULL THEN
        RETURN NULL;   -- sin id de anuncio no hay a qué atribuir
    END IF;

    BEGIN
        SELECT c.school_id, c.integration_id, c.contact_wa_id INTO v_conv
          FROM public.whatsapp_conversations c
         WHERE c.id = NEW.conversation_id;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        INSERT INTO public.whatsapp_atribucion AS t (
            conversation_id, integration_id, school_id, contact_wa_id,
            primer_source_id, primer_source_type, primer_headline, primer_body, primer_source_url,
            primer_media_type, primer_media_url, primer_ctwa_clid, primer_at, primer_historial,
            ultimo_source_id, ultimo_source_type, ultimo_headline, ultimo_source_url, ultimo_ctwa_clid, ultimo_at,
            toques
        ) VALUES (
            NEW.conversation_id, v_conv.integration_id, v_conv.school_id, v_conv.contact_wa_id,
            v_sid,
            left(NULLIF(btrim(v_ref->>'source_type'), ''), 20),
            left(NULLIF(btrim(v_ref->>'headline'), ''), 300),
            left(NULLIF(btrim(v_ref->>'body'), ''), 1000),
            left(NULLIF(btrim(v_ref->>'source_url'), ''), 1000),
            left(NULLIF(btrim(v_ref->>'media_type'), ''), 20),
            left(COALESCE(NULLIF(btrim(v_ref->>'thumbnail_url'), ''), NULLIF(btrim(v_ref->>'image_url'), '')), 2000),
            left(NULLIF(btrim(v_ref->>'ctwa_clid'), ''), 500),
            v_at,
            COALESCE(NEW.payload->>'historial', '') = 'true',
            v_sid,
            left(NULLIF(btrim(v_ref->>'source_type'), ''), 20),
            left(NULLIF(btrim(v_ref->>'headline'), ''), 300),
            left(NULLIF(btrim(v_ref->>'source_url'), ''), 1000),
            left(NULLIF(btrim(v_ref->>'ctwa_clid'), ''), 500),
            v_at,
            1
        )
        ON CONFLICT (conversation_id) DO UPDATE SET
            -- En el SET, t.* es la fila de antes: cada CASE compara contra ella.
            primer_source_id   = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_source_id   ELSE t.primer_source_id   END,
            primer_source_type = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_source_type ELSE t.primer_source_type END,
            primer_headline    = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_headline    ELSE t.primer_headline    END,
            primer_body        = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_body        ELSE t.primer_body        END,
            primer_source_url  = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_source_url  ELSE t.primer_source_url  END,
            primer_media_type  = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_media_type  ELSE t.primer_media_type  END,
            primer_media_url   = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_media_url   ELSE t.primer_media_url   END,
            primer_ctwa_clid   = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_ctwa_clid   ELSE t.primer_ctwa_clid   END,
            primer_historial   = CASE WHEN EXCLUDED.primer_at < t.primer_at THEN EXCLUDED.primer_historial   ELSE t.primer_historial   END,
            primer_at          = LEAST(t.primer_at, EXCLUDED.primer_at),
            ultimo_source_id   = CASE WHEN EXCLUDED.ultimo_at >= t.ultimo_at THEN EXCLUDED.ultimo_source_id   ELSE t.ultimo_source_id   END,
            ultimo_source_type = CASE WHEN EXCLUDED.ultimo_at >= t.ultimo_at THEN EXCLUDED.ultimo_source_type ELSE t.ultimo_source_type END,
            ultimo_headline    = CASE WHEN EXCLUDED.ultimo_at >= t.ultimo_at THEN EXCLUDED.ultimo_headline    ELSE t.ultimo_headline    END,
            ultimo_source_url  = CASE WHEN EXCLUDED.ultimo_at >= t.ultimo_at THEN EXCLUDED.ultimo_source_url  ELSE t.ultimo_source_url  END,
            ultimo_ctwa_clid   = CASE WHEN EXCLUDED.ultimo_at >= t.ultimo_at THEN EXCLUDED.ultimo_ctwa_clid   ELSE t.ultimo_ctwa_clid   END,
            ultimo_at          = GREATEST(t.ultimo_at, EXCLUDED.ultimo_at),
            toques             = t.toques + 1,
            updated_at         = now();
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'wa_atribucion: no se registró el anuncio del mensaje % (%: %)', NEW.id, SQLSTATE, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_wa_atribucion_desde_mensaje() IS
    'Trigger AFTER INSERT de whatsapp_messages (solo entrantes con payload.referral): upsert de whatsapp_atribucion por '
    'fecha del mensaje (primer = el más antiguo, último = el más nuevo). Nunca tumba la ingesta. (20261104115612)';

-- Función de trigger: nadie la llama directo (el EXECUTE solo se mira al crear el trigger).
REVOKE ALL ON FUNCTION public.fn_wa_atribucion_desde_mensaje() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_wa_atribucion_desde_mensaje
    AFTER INSERT ON public.whatsapp_messages
    FOR EACH ROW
    WHEN (NEW.direction = 'inbound' AND NEW.payload ? 'referral')
    EXECUTE FUNCTION public.fn_wa_atribucion_desde_mensaje();

-- ── 3. Backfill (idempotente: recalcula, no suma) ────────────────────────────
-- Medido el 2026-11-04: 602 entrantes con referral → 561 conversaciones, todas
-- de Monster. La tabla tiene ~77 mil filas (47 MB): un barrido único, filtrando
-- por dirección antes de mirar el payload.
WITH ref AS (
    SELECT m.id, m.conversation_id, m.created_at,
           COALESCE(m.wa_timestamp, m.created_at)               AS at,
           m.payload->'referral'                                AS r,
           COALESCE(m.payload->>'historial', '') = 'true'       AS historial,
           left(NULLIF(btrim(m.payload->'referral'->>'source_id'), ''), 100) AS sid
      FROM public.whatsapp_messages m
     WHERE m.direction = 'inbound'
       AND m.payload ? 'referral'
       AND jsonb_typeof(m.payload->'referral') = 'object'
       AND NULLIF(btrim(m.payload->'referral'->>'source_id'), '') IS NOT NULL
),
primero AS (
    SELECT DISTINCT ON (x.conversation_id) x.*
      FROM ref x
     ORDER BY x.conversation_id, x.at ASC, x.created_at ASC, x.id ASC
),
ultimo AS (
    SELECT DISTINCT ON (x.conversation_id) x.*
      FROM ref x
     ORDER BY x.conversation_id, x.at DESC, x.created_at DESC, x.id DESC
),
conteo AS (
    SELECT x.conversation_id, count(*)::int AS toques
      FROM ref x
     GROUP BY x.conversation_id
)
INSERT INTO public.whatsapp_atribucion (
    conversation_id, integration_id, school_id, contact_wa_id,
    primer_source_id, primer_source_type, primer_headline, primer_body, primer_source_url,
    primer_media_type, primer_media_url, primer_ctwa_clid, primer_at, primer_historial,
    ultimo_source_id, ultimo_source_type, ultimo_headline, ultimo_source_url, ultimo_ctwa_clid, ultimo_at,
    toques
)
SELECT p.conversation_id, c.integration_id, c.school_id, c.contact_wa_id,
       p.sid,
       left(NULLIF(btrim(p.r->>'source_type'), ''), 20),
       left(NULLIF(btrim(p.r->>'headline'), ''), 300),
       left(NULLIF(btrim(p.r->>'body'), ''), 1000),
       left(NULLIF(btrim(p.r->>'source_url'), ''), 1000),
       left(NULLIF(btrim(p.r->>'media_type'), ''), 20),
       left(COALESCE(NULLIF(btrim(p.r->>'thumbnail_url'), ''), NULLIF(btrim(p.r->>'image_url'), '')), 2000),
       left(NULLIF(btrim(p.r->>'ctwa_clid'), ''), 500),
       p.at,
       p.historial,
       u.sid,
       left(NULLIF(btrim(u.r->>'source_type'), ''), 20),
       left(NULLIF(btrim(u.r->>'headline'), ''), 300),
       left(NULLIF(btrim(u.r->>'source_url'), ''), 1000),
       left(NULLIF(btrim(u.r->>'ctwa_clid'), ''), 500),
       u.at,
       n.toques
  FROM primero p
  JOIN ultimo u ON u.conversation_id = p.conversation_id
  JOIN conteo n ON n.conversation_id = p.conversation_id
  JOIN public.whatsapp_conversations c ON c.id = p.conversation_id
ON CONFLICT (conversation_id) DO UPDATE SET
    integration_id     = EXCLUDED.integration_id,
    school_id          = EXCLUDED.school_id,
    contact_wa_id      = EXCLUDED.contact_wa_id,
    primer_source_id   = EXCLUDED.primer_source_id,
    primer_source_type = EXCLUDED.primer_source_type,
    primer_headline    = EXCLUDED.primer_headline,
    primer_body        = EXCLUDED.primer_body,
    primer_source_url  = EXCLUDED.primer_source_url,
    primer_media_type  = EXCLUDED.primer_media_type,
    primer_media_url   = EXCLUDED.primer_media_url,
    primer_ctwa_clid   = EXCLUDED.primer_ctwa_clid,
    primer_at          = EXCLUDED.primer_at,
    primer_historial   = EXCLUDED.primer_historial,
    ultimo_source_id   = EXCLUDED.ultimo_source_id,
    ultimo_source_type = EXCLUDED.ultimo_source_type,
    ultimo_headline    = EXCLUDED.ultimo_headline,
    ultimo_source_url  = EXCLUDED.ultimo_source_url,
    ultimo_ctwa_clid   = EXCLUDED.ultimo_ctwa_clid,
    ultimo_at          = EXCLUDED.ultimo_at,
    toques             = EXCLUDED.toques,
    updated_at         = now();

-- ── 4. Destino por anuncio (D1: el mapeo manda; sin mapeo, el bot infiere) ───
-- Contrato con el bot (lo lee con service role por school_id + source_id):
--   destino 'clase_prueba' → embudo de la clase de prueba
--   destino 'servicio'     → servicio_id (school_tournament_items de la escuela, sin evento)
--   destino 'persona'      → buzón (lo atiende una persona)
CREATE TABLE public.whatsapp_anuncio_destino (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    source_id       text        NOT NULL CHECK (source_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
    destino         text        NOT NULL CHECK (destino IN ('clase_prueba', 'servicio', 'persona')),
    -- Si el servicio se borra, el mapeo se va con él y el bot vuelve a inferir.
    servicio_id     uuid        REFERENCES public.school_tournament_items(id) ON DELETE CASCADE,
    nota            text        CHECK (nota IS NULL OR length(nota) <= 300),
    actualizado_por uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT whatsapp_anuncio_destino_uq UNIQUE (school_id, source_id),
    CONSTRAINT whatsapp_anuncio_destino_servicio_chk CHECK ((destino = 'servicio') = (servicio_id IS NOT NULL))
);

COMMENT ON TABLE public.whatsapp_anuncio_destino IS
    'A dónde lleva el bot a quien llega por un anuncio (source_id del referral de Meta): clase_prueba | servicio '
    '(servicio_id del catálogo) | persona (buzón). Sin fila, el bot infiere por el texto del anuncio. Escribe la '
    'administración de la escuela; lee su staff y el bot (service role). (20261104115612)';

CREATE INDEX idx_wa_anuncio_destino_servicio ON public.whatsapp_anuncio_destino (servicio_id)
    WHERE servicio_id IS NOT NULL;

-- El servicio tiene que ser de ESA escuela y vendible por el bot (sin evento).
-- Va en trigger y no en la policy: el BFF y el bot escriben con service role,
-- que no pasa por RLS. También estampa quién y cuándo.
CREATE FUNCTION public.fn_wa_anuncio_destino_valida()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.destino = 'servicio' AND NOT EXISTS (
        SELECT 1 FROM public.school_tournament_items i
         WHERE i.id = NEW.servicio_id AND i.school_id = NEW.school_id AND i.event_id IS NULL
    ) THEN
        RAISE EXCEPTION 'SERVICIO_INVALIDO' USING ERRCODE = '23503',
            HINT = 'El servicio no es de esta escuela o es la inscripción de un torneo.';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        NEW.created_at := OLD.created_at;
    END IF;
    NEW.updated_at := now();
    -- Desde el navegador queda quien guardó; desde el BFF (sin JWT) lo que mande el BFF.
    NEW.actualizado_por := COALESCE(auth.uid(), NEW.actualizado_por);
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_wa_anuncio_destino_valida() IS
    'Trigger BEFORE INSERT/UPDATE de whatsapp_anuncio_destino: servicio de la misma escuela y sin evento; updated_at y '
    'actualizado_por. (20261104115612)';

REVOKE ALL ON FUNCTION public.fn_wa_anuncio_destino_valida() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_wa_anuncio_destino_valida
    BEFORE INSERT OR UPDATE ON public.whatsapp_anuncio_destino
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_wa_anuncio_destino_valida();

ALTER TABLE public.whatsapp_anuncio_destino ENABLE ROW LEVEL SECURITY;

-- Una policy por comando (nada de FOR ALL: sin WITH CHECK validaría el INSERT con
-- el USING). Son las ÚNICAS de la tabla: no hay otra permisiva que las abra.
-- Lectura: quien trabaja en la escuela (sin acudientes ni deportistas).
CREATE POLICY wa_anuncio_destino_select_staff ON public.whatsapp_anuncio_destino
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
-- Escritura: solo la administración de ESA escuela.
CREATE POLICY wa_anuncio_destino_insert_admin ON public.whatsapp_anuncio_destino
    FOR INSERT TO authenticated
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY wa_anuncio_destino_update_admin ON public.whatsapp_anuncio_destino
    FOR UPDATE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY wa_anuncio_destino_delete_admin ON public.whatsapp_anuncio_destino
    FOR DELETE TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

REVOKE ALL ON public.whatsapp_anuncio_destino FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_anuncio_destino TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_anuncio_destino TO service_role;

-- ── 5. RPC del embudo por anuncio ────────────────────────────────────────────
-- Cohorte: las conversaciones cuyo PRIMER toque cae en [p_desde, p_hasta]
-- (fechas de Bogotá). Las etapas se miden sin tope de fecha (lo que pasó
-- después con esa cohorte). Por conversación:
--   contestaron            lead del embudo con source_detail.conversation_id = la conversación
--   separaron_o_agendaron  ese lead tiene cupo_separado_slot_id o trial_slot_id, o mandó
--                          un comprobante (cobro en revisión / abono / pagado)
--   pagaron, monto         cobros paid/partial ligados al lead (signup_lead_id), a un
--                          comprobante de la conversación que creó el cobro
--                          (wa_cobros_desde_comprobante) o que se aplicó a un cobro
--                          (cola payment_receipt / payment_link, sin mensualidades),
--                          recibido después del clic. monto = amount_paid (paid sin
--                          amount_paid: amount). Desglose por payment_category y servicio.
--   asistieron             source_detail.asistencia = 'asistio' (o etapa asistio /
--                          asistio_at sin un «no_vino» del profe)
--   matriculados           lead convertido (status converted o converted_enrollment_id)
--   volvieron              (aparte, D2) conversaciones cuyo ÚLTIMO toque en el rango es
--                          este anuncio y llegaron antes por otro
-- Con p_branch_id: solo las conversaciones con un lead de esa sede o un cobro de esa sede.
-- Gate ADENTRO: administración de ESA escuela (user_admin_school_ids: dueño, owner,
-- admin, school_admin) o admin de plataforma activo. Sin JWT (service_role) → 42501:
-- nunca ceros creíbles. El BFF la llama con el JWT del usuario.
CREATE FUNCTION public.wa_embudo_anuncios(
    p_school_id uuid,
    p_desde     date,
    p_hasta     date,
    p_branch_id uuid DEFAULT NULL
)
RETURNS TABLE (
    es_total              boolean,
    source_id             text,
    source_type           text,
    headline              text,
    body                  text,
    source_url            text,
    media_url             text,
    conversaciones        integer,
    de_historial          integer,
    contestaron           integer,
    separaron_o_agendaron integer,
    pagaron               integer,
    monto                 numeric,
    pagos_por_motivo      jsonb,
    asistieron            integer,
    matriculados          integer,
    volvieron             integer,
    primera_conversacion  timestamptz,
    ultima_conversacion   timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_uid   uuid := auth.uid();
    v_desde timestamptz;
    v_hasta timestamptz;
BEGIN
    IF p_school_id IS NULL OR p_desde IS NULL OR p_hasta IS NULL
       OR p_hasta < p_desde OR (p_hasta - p_desde) > 400 THEN
        RAISE EXCEPTION 'RANGO_INVALIDO' USING ERRCODE = '22023';
    END IF;

    IF v_uid IS NULL OR NOT COALESCE(
           p_school_id = ANY (public.user_admin_school_ids())
        OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = v_uid AND pa.is_active),
        false) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.school_branches b WHERE b.id = p_branch_id AND b.school_id = p_school_id
    ) THEN
        RAISE EXCEPTION 'SEDE_INVALIDA' USING ERRCODE = '22023';
    END IF;

    v_desde := p_desde::timestamp AT TIME ZONE 'America/Bogota';
    v_hasta := (p_hasta + 1)::timestamp AT TIME ZONE 'America/Bogota';

    RETURN QUERY
    WITH conv AS (
        SELECT a.conversation_id, a.primer_source_id AS sid, a.primer_at, a.primer_historial,
               a.integration_id, a.contact_wa_id
          FROM public.whatsapp_atribucion a
         WHERE a.school_id = p_school_id
           AND a.primer_at >= v_desde AND a.primer_at < v_hasta
    ),
    lds AS (
        SELECT c.conversation_id, l.id AS lead_id, l.branch_id,
               (l.trial_slot_id IS NOT NULL OR l.cupo_separado_slot_id IS NOT NULL) AS separo,
               CASE WHEN l.source_detail->>'asistencia' = 'asistio' THEN true
                    WHEN l.source_detail->>'asistencia' = 'no_vino' THEN false
                    ELSE COALESCE(l.source_detail->>'etapa' = 'asistio', false)
                         OR COALESCE(l.source_detail ? 'asistio_at', false)
               END AS asistio,
               (l.status = 'converted' OR l.converted_enrollment_id IS NOT NULL) AS matriculado
          FROM conv c
          JOIN public.school_signup_leads l
            ON l.school_id = p_school_id
           AND l.source_detail->>'conversation_id' = c.conversation_id::text
    ),
    cola AS (
        SELECT c.conversation_id, q.id AS queue_id, q.result_type, q.result_ref_id
          FROM conv c
          JOIN public.whatsapp_inbound_queue q
            ON q.school_id = p_school_id
           AND q.integration_id = c.integration_id
           AND q.wa_phone_number = c.contact_wa_id
           AND q.created_at >= c.primer_at
    ),
    pag_ids AS (
        SELECT l.conversation_id, p.id AS payment_id
          FROM lds l
          JOIN public.payments p ON p.signup_lead_id = l.lead_id AND p.school_id = p_school_id
        UNION
        SELECT q.conversation_id, w.payment_id
          FROM cola q
          JOIN public.wa_cobros_desde_comprobante w ON w.queue_id = q.queue_id AND w.school_id = p_school_id
        UNION
        SELECT q.conversation_id, p.id
          FROM cola q
          JOIN public.payments p
            ON p.id = q.result_ref_id
           AND p.school_id = p_school_id
           AND p.payment_category IS DISTINCT FROM 'mensualidad'
         WHERE q.result_type IN ('payment_receipt', 'payment_link')
    ),
    pag AS (
        SELECT x.conversation_id, p.id AS payment_id, p.status, p.branch_id,
               COALESCE(NULLIF(btrim(p.payment_category), ''), 'otro') AS motivo,
               s.id AS servicio_id, s.name AS servicio,
               CASE p.status
                    WHEN 'paid'    THEN COALESCE(NULLIF(p.amount_paid, 0), p.amount, 0)
                    WHEN 'partial' THEN COALESCE(p.amount_paid, 0)
                    ELSE 0
               END AS cobrado
          FROM pag_ids x
          JOIN public.payments p ON p.id = x.payment_id
          LEFT JOIN public.wa_cobros_desde_comprobante w ON w.payment_id = p.id AND w.fuente = 'tournament_item'
          LEFT JOIN public.school_tournament_items s ON s.id = w.fuente_id
         WHERE p.status IN ('pending', 'overdue', 'awaiting_approval', 'partial', 'paid')
    ),
    lds_conv AS (
        SELECT l.conversation_id,
               bool_or(l.separo) AS separo, bool_or(l.asistio) AS asistio, bool_or(l.matriculado) AS matriculado,
               bool_or(l.branch_id = p_branch_id) AS en_sede
          FROM lds l
         GROUP BY l.conversation_id
    ),
    pag_conv AS (
        SELECT g.conversation_id,
               bool_or(g.status IN ('awaiting_approval', 'partial', 'paid')) AS mando,
               bool_or(g.status IN ('partial', 'paid')) AS pago,
               bool_or(g.branch_id = p_branch_id) AS en_sede
          FROM pag g
         GROUP BY g.conversation_id
    ),
    por_conv AS (
        SELECT c.conversation_id, c.sid, c.primer_at, c.primer_historial,
               (lc.conversation_id IS NOT NULL)                              AS contesto,
               (COALESCE(lc.separo, false) OR COALESCE(pc.mando, false))     AS separo,
               COALESCE(pc.pago, false)                                      AS pago,
               COALESCE(lc.asistio, false)                                   AS asistio,
               COALESCE(lc.matriculado, false)                               AS matriculado
          FROM conv c
          LEFT JOIN lds_conv lc ON lc.conversation_id = c.conversation_id
          LEFT JOIN pag_conv pc ON pc.conversation_id = c.conversation_id
         WHERE p_branch_id IS NULL
            OR COALESCE(lc.en_sede, false)
            OR COALESCE(pc.en_sede, false)
    ),
    aprobados AS (
        SELECT pc.sid, g.conversation_id, g.payment_id, g.motivo, g.servicio_id, g.servicio, g.cobrado
          FROM pag g
          JOIN por_conv pc ON pc.conversation_id = g.conversation_id
         WHERE g.status IN ('partial', 'paid')
    ),
    -- Un cobro ligado a dos conversaciones suma una sola vez (por anuncio y en el total).
    aprobados_sid AS (
        SELECT DISTINCT ON (ap.sid, ap.payment_id) ap.*
          FROM aprobados ap
         ORDER BY ap.sid, ap.payment_id
    ),
    aprobados_tot AS (
        SELECT DISTINCT ON (ap.payment_id) ap.*
          FROM aprobados ap
         ORDER BY ap.payment_id, ap.sid
    ),
    por_anuncio AS (
        SELECT pc.sid,
               count(*)::int                                   AS conversaciones,
               count(*) FILTER (WHERE pc.primer_historial)::int AS de_historial,
               count(*) FILTER (WHERE pc.contesto)::int         AS contestaron,
               count(*) FILTER (WHERE pc.separo)::int           AS separaron,
               count(*) FILTER (WHERE pc.pago)::int             AS pagaron,
               count(*) FILTER (WHERE pc.asistio)::int          AS asistieron,
               count(*) FILTER (WHERE pc.matriculado)::int      AS matriculados,
               min(pc.primer_at)                               AS primera,
               max(pc.primer_at)                               AS ultima
          FROM por_conv pc
         GROUP BY pc.sid
    ),
    monto_sid AS (
        SELECT ap.sid, sum(ap.cobrado) AS monto FROM aprobados_sid ap GROUP BY ap.sid
    ),
    motivo_sid AS (
        SELECT m.sid,
               jsonb_agg(jsonb_build_object(
                   'motivo', m.motivo, 'servicio_id', m.servicio_id, 'servicio', m.servicio,
                   'conversaciones', m.conversaciones, 'pagos', m.pagos, 'monto', m.monto)
                   ORDER BY m.monto DESC, m.motivo) AS detalle
          FROM (
              SELECT ap.sid, ap.motivo, ap.servicio_id, ap.servicio,
                     count(DISTINCT ap.conversation_id)::int AS conversaciones,
                     count(*)::int                           AS pagos,
                     sum(ap.cobrado)                         AS monto
                FROM aprobados_sid ap
               GROUP BY ap.sid, ap.motivo, ap.servicio_id, ap.servicio
          ) m
         GROUP BY m.sid
    ),
    motivo_tot AS (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'motivo', m.motivo, 'servicio_id', m.servicio_id, 'servicio', m.servicio,
                   'conversaciones', m.conversaciones, 'pagos', m.pagos, 'monto', m.monto)
                   ORDER BY m.monto DESC, m.motivo), '[]'::jsonb) AS detalle
          FROM (
              SELECT ap.motivo, ap.servicio_id, ap.servicio,
                     count(DISTINCT ap.conversation_id)::int AS conversaciones,
                     count(*)::int                           AS pagos,
                     sum(ap.cobrado)                         AS monto
                FROM aprobados_tot ap
               GROUP BY ap.motivo, ap.servicio_id, ap.servicio
          ) m
    ),
    meta AS (
        SELECT DISTINCT ON (a.primer_source_id)
               a.primer_source_id AS sid, a.primer_source_type AS source_type, a.primer_headline AS headline,
               a.primer_body AS body, a.primer_source_url AS source_url, a.primer_media_url AS media_url
          FROM public.whatsapp_atribucion a
          JOIN por_conv pc ON pc.conversation_id = a.conversation_id
         ORDER BY a.primer_source_id, a.primer_at DESC
    ),
    vol AS (
        SELECT a.ultimo_source_id AS sid,
               count(*)::int AS n,
               (array_agg(a.ultimo_source_type ORDER BY a.ultimo_at DESC))[1] AS source_type,
               (array_agg(a.ultimo_headline    ORDER BY a.ultimo_at DESC))[1] AS headline,
               (array_agg(a.ultimo_source_url  ORDER BY a.ultimo_at DESC))[1] AS source_url
          FROM public.whatsapp_atribucion a
         WHERE a.school_id = p_school_id
           AND a.ultimo_at >= v_desde AND a.ultimo_at < v_hasta
           AND a.ultimo_source_id <> a.primer_source_id
           AND (p_branch_id IS NULL OR EXISTS (
                SELECT 1 FROM public.school_signup_leads l
                 WHERE l.school_id = p_school_id
                   AND l.branch_id = p_branch_id
                   AND l.source_detail->>'conversation_id' = a.conversation_id::text))
         GROUP BY a.ultimo_source_id
    ),
    ids AS (
        SELECT pa.sid FROM por_anuncio pa
        UNION
        SELECT v.sid FROM vol v
    )
    SELECT false                                         AS es_total,
           i.sid                                         AS source_id,
           COALESCE(me.source_type, v.source_type)       AS source_type,
           COALESCE(me.headline, v.headline)             AS headline,
           me.body                                       AS body,
           COALESCE(me.source_url, v.source_url)         AS source_url,
           me.media_url                                  AS media_url,
           COALESCE(pa.conversaciones, 0)                AS conversaciones,
           COALESCE(pa.de_historial, 0)                  AS de_historial,
           COALESCE(pa.contestaron, 0)                   AS contestaron,
           COALESCE(pa.separaron, 0)                     AS separaron_o_agendaron,
           COALESCE(pa.pagaron, 0)                       AS pagaron,
           COALESCE(ms.monto, 0)::numeric                AS monto,
           COALESCE(mo.detalle, '[]'::jsonb)             AS pagos_por_motivo,
           COALESCE(pa.asistieron, 0)                    AS asistieron,
           COALESCE(pa.matriculados, 0)                  AS matriculados,
           COALESCE(v.n, 0)                              AS volvieron,
           pa.primera                                    AS primera_conversacion,
           pa.ultima                                     AS ultima_conversacion
      FROM ids i
      LEFT JOIN por_anuncio pa ON pa.sid = i.sid
      LEFT JOIN meta        me ON me.sid = i.sid
      LEFT JOIN vol         v  ON v.sid  = i.sid
      LEFT JOIN monto_sid   ms ON ms.sid = i.sid
      LEFT JOIN motivo_sid  mo ON mo.sid = i.sid
    UNION ALL
    SELECT true, NULL, NULL, NULL, NULL, NULL, NULL,
           (SELECT count(*)::int FROM por_conv),
           (SELECT count(*) FILTER (WHERE pc.primer_historial)::int FROM por_conv pc),
           (SELECT count(*) FILTER (WHERE pc.contesto)::int FROM por_conv pc),
           (SELECT count(*) FILTER (WHERE pc.separo)::int FROM por_conv pc),
           (SELECT count(*) FILTER (WHERE pc.pago)::int FROM por_conv pc),
           (SELECT COALESCE(sum(ap.cobrado), 0)::numeric FROM aprobados_tot ap),
           (SELECT mt.detalle FROM motivo_tot mt),
           (SELECT count(*) FILTER (WHERE pc.asistio)::int FROM por_conv pc),
           (SELECT count(*) FILTER (WHERE pc.matriculado)::int FROM por_conv pc),
           (SELECT COALESCE(sum(v.n), 0)::int FROM vol v),
           (SELECT min(pc.primer_at) FROM por_conv pc),
           (SELECT max(pc.primer_at) FROM por_conv pc)
    ORDER BY 1, 8 DESC, 17 DESC, 2;
END;
$$;

COMMENT ON FUNCTION public.wa_embudo_anuncios(uuid, date, date, uuid) IS
    'WhatsApp › Anuncios: embudo por anuncio (primer toque en el rango, fechas de Bogotá) → contestaron, separaron o '
    'agendaron, pagaron (+ monto y desglose por motivo/servicio), asistieron, matriculados; volvieron = último toque '
    'aparte. Última fila es_total. Solo administración de ESA escuela o admin de plataforma (42501 sin JWT). '
    '(20261104115612)';

REVOKE ALL ON FUNCTION public.wa_embudo_anuncios(uuid, date, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_embudo_anuncios(uuid, date, date, uuid) TO authenticated;

COMMIT;

-- =============================================================================
-- Verificación (correr DESPUÉS de aplicar; solo lecturas, por nombre):
--
-- 1. Objetos, RLS y permisos
-- select relname, relrowsecurity, relacl from pg_class
--  where oid in ('public.whatsapp_atribucion'::regclass, 'public.whatsapp_anuncio_destino'::regclass);
-- select policyname, cmd, permissive, roles, qual, with_check from pg_policies
--  where tablename in ('whatsapp_atribucion', 'whatsapp_anuncio_destino') order by tablename, cmd;
--   → whatsapp_atribucion: 0 filas. whatsapp_anuncio_destino: 4 (SELECT staff; INSERT/UPDATE/DELETE admin,
--     INSERT y UPDATE con with_check).
-- select proname, prosecdef, provolatile, proconfig, proacl from pg_proc
--  where proname in ('wa_embudo_anuncios', 'fn_wa_atribucion_desde_mensaje', 'fn_wa_anuncio_destino_valida');
--   → los tres con search_path fijo; wa_embudo_anuncios con authenticated=X y SIN anon; los fn_ sin
--     authenticated ni anon.
-- select tgname, pg_get_triggerdef(oid) from pg_trigger
--  where tgrelid = 'public.whatsapp_messages'::regclass and not tgisinternal;
--   → trg_wa_atribucion_desde_mensaje … WHEN ((new.direction = 'inbound'::text) AND (new.payload ? 'referral'::text))
--
-- 2. Backfill: debe cuadrar con los mensajes (medido 2026-11-04: 561 conversaciones de Monster, sum(toques) = 602,
--    561 con primer_historial, 38 anuncios)
-- select school_id, count(*) conversaciones, sum(toques) toques, count(*) filter (where primer_historial) historial,
--        count(distinct primer_source_id) anuncios, min(primer_at), max(ultimo_at)
--   from public.whatsapp_atribucion group by 1;
-- select count(*) mensajes, count(distinct m.conversation_id) conversaciones
--   from public.whatsapp_messages m
--  where m.direction = 'inbound' and m.payload ? 'referral'
--    and nullif(btrim(m.payload->'referral'->>'source_id'), '') is not null;
--
-- 3. Gate de la RPC (en una transacción que se deshace)
-- begin;
--   set local role anon;
--   select * from public.wa_embudo_anuncios('eb3ebc77-4ea4-4992-96c8-3c8ec574578c', '2026-06-01', '2026-11-04');
--   → ERROR 42501 permission denied for function (anon sin EXECUTE)
-- rollback;
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', '<uuid de un coach o de otra escuela>', 'role', 'authenticated')::text, true);
--   select * from public.wa_embudo_anuncios('eb3ebc77-4ea4-4992-96c8-3c8ec574578c', '2026-06-01', '2026-11-04');
--   → ERROR 42501 Forbidden
-- rollback;
-- begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims', json_build_object('sub', '<uuid del dueño/admin de Monster>', 'role', 'authenticated')::text, true);
--   select es_total, source_id, headline, conversaciones, de_historial, contestaron, separaron_o_agendaron,
--          pagaron, monto, asistieron, matriculados, volvieron
--     from public.wa_embudo_anuncios('eb3ebc77-4ea4-4992-96c8-3c8ec574578c', '2026-06-01', '2026-11-04');
--   → una fila por anuncio + la fila es_total (conversaciones del total = las de la consulta 2 en ese rango)
-- rollback;
--
-- 4. Tablas solo-BFF cerradas al navegador
-- begin; set local role anon;          select count(*) from public.whatsapp_atribucion; rollback;  → 42501
-- begin; set local role authenticated; select count(*) from public.whatsapp_atribucion; rollback;  → 42501
-- begin; set local role anon;          select count(*) from public.whatsapp_anuncio_destino; rollback; → 42501
--
-- 5. Invariantes: npm run seguridad:invariantes  (sin CRÍTICAS nuevas)
-- =============================================================================
