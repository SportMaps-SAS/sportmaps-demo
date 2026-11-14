-- =============================================================================
-- 20261106115639_whatsapp_anuncio_regla_texto.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261106001001
-- Objetivo: reconocer el anuncio o el canal por el TEXTO del primer mensaje cuando
--   Meta no manda `referral` (Monster 2026-11-04/06: 62 chats, solo 28 con marca
--   de anuncio). Plan: docs/plan-anuncios-atribucion-multiescuela-2026-11-06.md, fase 1.
--
-- Cómo se usa: la escuela (o la plataforma, para todas) registra frases —por anuncio
--   («Hola, vi el reel de la clínica») o por canal («(Instagram)»)—. El BFF compara
--   el primer mensaje de una conversación SIN referral contra estas reglas y, si
--   calza una, deja la atribución en `whatsapp_atribucion` con source_id 'texto:<etiqueta>'.
--   El embudo por anuncio (wa_embudo_anuncios) y la pestaña Anuncios no cambian.
--
-- Reglas con school_id NULL = de la plataforma, valen para todas las escuelas; solo las
--   escribe service role. Las de una escuela las administra su administración.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
--   · Una policy por comando (nada de FOR ALL sin WITH CHECK).
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE public.whatsapp_anuncio_regla (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = regla de la plataforma (todas las escuelas).
    school_id       uuid        REFERENCES public.schools(id) ON DELETE CASCADE,
    -- Frase que debe CONTENER el primer mensaje. El BFF la compara sin tildes, sin
    -- mayúsculas y sin signos de puntuación (se conservan los paréntesis para poder
    -- usar marcas como «(instagram)»).
    patron          text        NOT NULL CHECK (length(btrim(patron)) BETWEEN 2 AND 120),
    -- Nombre que se ve en la pestaña Anuncios.
    etiqueta        text        NOT NULL CHECK (length(btrim(etiqueta)) BETWEEN 1 AND 80),
    tipo            text        NOT NULL DEFAULT 'anuncio' CHECK (tipo IN ('anuncio', 'canal')),
    activa          boolean     NOT NULL DEFAULT true,
    nota            text        CHECK (nota IS NULL OR length(nota) <= 300),
    actualizado_por uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_anuncio_regla IS
    'Reglas por texto para atribuir un chat a un anuncio o canal cuando Meta no manda referral. school_id NULL = '
    'regla de la plataforma. Escribe la administración de la escuela (las de plataforma, service role); lee su staff '
    'y el BFF. (20261106115639)';

-- Una regla por frase y por escuela (la de plataforma incluida).
CREATE UNIQUE INDEX uq_wa_anuncio_regla_escuela_patron
    ON public.whatsapp_anuncio_regla (COALESCE(school_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(patron)));

CREATE INDEX idx_wa_anuncio_regla_escuela ON public.whatsapp_anuncio_regla (school_id) WHERE activa;

ALTER TABLE public.whatsapp_anuncio_regla ENABLE ROW LEVEL SECURITY;

-- Lectura: las de la plataforma las ve cualquiera con sesión (no son sensibles) y las de la
-- escuela, quien trabaja en ella (sin acudientes ni deportistas).
CREATE POLICY wa_anuncio_regla_select ON public.whatsapp_anuncio_regla
    FOR SELECT TO authenticated
    USING (school_id IS NULL OR school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));
-- Escritura: solo la administración de ESA escuela; las de plataforma nunca por aquí.
CREATE POLICY wa_anuncio_regla_insert_admin ON public.whatsapp_anuncio_regla
    FOR INSERT TO authenticated
    WITH CHECK (school_id IS NOT NULL AND school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY wa_anuncio_regla_update_admin ON public.whatsapp_anuncio_regla
    FOR UPDATE TO authenticated
    USING (school_id IS NOT NULL AND school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
    WITH CHECK (school_id IS NOT NULL AND school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));
CREATE POLICY wa_anuncio_regla_delete_admin ON public.whatsapp_anuncio_regla
    FOR DELETE TO authenticated
    USING (school_id IS NOT NULL AND school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

REVOKE ALL ON public.whatsapp_anuncio_regla FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_anuncio_regla TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_anuncio_regla TO service_role;

-- Reglas de la plataforma: la marca de canal que se pone entre paréntesis al final del texto del
-- enlace de WhatsApp (bio de Instagram, mensajes del community manager, Facebook, web, QR).
INSERT INTO public.whatsapp_anuncio_regla (school_id, patron, etiqueta, tipo, nota) VALUES
    (NULL, '(instagram)', 'Canal: Instagram',               'canal', 'Enlace de la bio o de mensajes de Instagram'),
    (NULL, '(directo)',   'Canal: Mensaje directo',         'canal', 'Enlace que manda el community manager'),
    (NULL, '(facebook)',  'Canal: Facebook',                'canal', 'Enlace publicado en Facebook'),
    (NULL, '(web)',       'Canal: Página web',              'canal', 'Enlace de la página web'),
    (NULL, '(qr)',        'Canal: Código QR / volante',     'canal', 'Código QR o volante impreso');

COMMIT;
