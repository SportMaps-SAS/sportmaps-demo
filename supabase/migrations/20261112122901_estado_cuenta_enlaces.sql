-- =============================================================================
-- 20261112122901_estado_cuenta_enlaces.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-12   Versión anterior: 20261112114054
-- Objetivo: el enlace público sin login del ESTADO DE CUENTA de una familia —
-- https://app.sportmaps.co/e/<token> — para que la escuela se lo mande a cada
-- acudiente (primer cliente: Club Deportivo Besser) y lo revise con él: mes a
-- mes qué se cobró, cuándo era el límite, cuándo y cómo se pagó, y cómo le fue
-- en asistencia. Plan: docs/specs/estado-de-cuenta-envio-a-familias.md.
--
-- Calcado de `payment_public_tokens` (20261004083707), con tres diferencias:
--   · El enlace es de una FAMILIA (todos los hijos de un acudiente en la
--     escuela), no de un cobro: guarda la fotografía de a quiénes cubre en
--     `atletas` ([{tipo, id}]).
--   · Muestra el estado EN VIVO de los últimos `meses` meses (default 12) cada
--     vez que se abre; no guarda montos. Si la familia paga mañana, el enlace
--     de hoy ya lo dice.
--   · Un solo enlace 'active' por familia y escuela.
--
-- Seguridad (CLAUDE.md):
--   · RLS activa y SIN policies: nadie fuera de service_role lee la tabla. El
--     token es la credencial; una policy «by_token» sería USING(true) (trampa 5).
--     La resolución va por RPC SECURITY DEFINER que recibe el token.
--   · Las RPC son solo para service_role (las llama el BFF). REVOKE explícito a
--     anon y authenticated (trampa 3: REVOKE FROM PUBLIC no alcanza).
--   · Token: 18 bytes aleatorios de pgcrypto → 24 caracteres base64url (144
--     bits). No contiene ningún id ni nada derivable.
--   · Estados en text + CHECK, no CREATE TYPE. FK de negocio a profiles(id).
--   · `atletas` es jsonb con forma validada por CHECK (arreglo de 1 a 20).
--
-- NO APLICADA. Mientras no se aplique, el BFF degrada solo: la ruta pública
-- responde «enlace no válido» y el botón «Enviar al acudiente» avisa que el
-- envío todavía no está disponible. Se aplica en UNA sola sesión, sin otras
-- migraciones en paralelo (cada DDL recarga el esquema de PostgREST), y
-- `types.ts` se regenera una sola vez al final.
--
-- Verificación después de aplicar:
--   set local role anon;          select count(*) from public.estado_cuenta_enlaces; -- debe dar 42501
--   set local role authenticated; select count(*) from public.estado_cuenta_enlaces; -- debe dar 42501
--   npm run seguridad:invariantes
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.estado_cuenta_enlaces (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id       uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    -- Clave estable de la familia: correo en minúscula, o 'wa:<wa_id>' si no hay
    -- correo. La misma que usa agruparPorFamilia() del estado de cuenta mensual.
    familia_clave   text NOT NULL CHECK (length(familia_clave) BETWEEN 3 AND 320),
    -- [{ "tipo": "hijo" | "adulto" | "ficha", "id": "<uuid>" }, ...]
    atletas         jsonb NOT NULL
                    CHECK (jsonb_typeof(atletas) = 'array'
                           AND jsonb_array_length(atletas) BETWEEN 1 AND 20),
    -- Ventana en meses que muestra el enlace, contada hacia atrás desde hoy.
    meses           smallint NOT NULL DEFAULT 12 CHECK (meses BETWEEN 1 AND 36),
    token           text NOT NULL UNIQUE
                    CHECK (token ~ '^[A-Za-z0-9_-]{24}$'),
    -- active   → el que se reusa en los envíos nuevos de la misma familia.
    -- replaced → se emitió uno nuevo (a este le quedaban < 7 días o cambiaron
    --            los atletas); SIGUE abriendo hasta su expires_at: la familia
    --            puede tener el correo viejo.
    -- revoked  → no abre más (anulación manual).
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'replaced', 'revoked')),
    expires_at      timestamptz NOT NULL,
    open_count      integer NOT NULL DEFAULT 0,
    last_opened_at  timestamptz,
    -- Quién lo envió (perfil de la escuela). Si se borra el perfil, el enlace
    -- sigue funcionando: la auditoría del envío vive en email_sends.
    created_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Un solo enlace 'active' por familia y escuela: es el que se reusa en cada envío.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estado_cuenta_enlaces_one_active
    ON public.estado_cuenta_enlaces (school_id, familia_clave) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_estado_cuenta_enlaces_school
    ON public.estado_cuenta_enlaces (school_id);
CREATE INDEX IF NOT EXISTS idx_estado_cuenta_enlaces_created_by
    ON public.estado_cuenta_enlaces (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.estado_cuenta_enlaces IS
    'Enlace público sin login del estado de cuenta de una familia (https://app.sportmaps.co/e/<token>). '
    'Solo service_role; se emite con estado_cuenta_enlace_emitir() y se resuelve con estado_cuenta_enlace_resolver().';

ALTER TABLE public.estado_cuenta_enlaces ENABLE ROW LEVEL SECURITY;
-- Sin policies a propósito. Y sin privilegios para los roles de PostgREST: los
-- default privileges del esquema se los otorgan a anon/authenticated.
REVOKE ALL ON TABLE public.estado_cuenta_enlaces FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.estado_cuenta_enlaces TO service_role;

-- ── Emitir (o reusar) el enlace de una familia ──────────────────────────────
-- Reusa el 'active' si le quedan más de 7 días Y cubre exactamente los mismos
-- atletas y la misma ventana; si no, lo pasa a 'replaced' (sigue abriendo hasta
-- vencer) y emite uno nuevo. `p_atletas` llega ordenado por el BFF para que la
-- comparación de jsonb sea estable.
CREATE OR REPLACE FUNCTION public.estado_cuenta_enlace_emitir(
    p_school_id     uuid,
    p_familia_clave text,
    p_atletas       jsonb,
    p_meses         integer DEFAULT 12,
    p_created_by    uuid DEFAULT NULL,
    p_dias          integer DEFAULT 60
)
RETURNS TABLE (enlace_token text, vence_en timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_meses   integer := LEAST(GREATEST(COALESCE(p_meses, 12), 1), 36);
    v_dias    integer := LEAST(GREATEST(COALESCE(p_dias, 60), 1), 90);
    v_actual  public.estado_cuenta_enlaces%ROWTYPE;
BEGIN
    IF p_familia_clave IS NULL OR length(p_familia_clave) < 3 THEN
        RAISE EXCEPTION 'familia_invalida' USING ERRCODE = '22023';
    END IF;
    IF p_atletas IS NULL OR jsonb_typeof(p_atletas) <> 'array' OR jsonb_array_length(p_atletas) = 0 THEN
        RAISE EXCEPTION 'atletas_invalidos' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id) THEN
        RAISE EXCEPTION 'escuela_no_existe' USING ERRCODE = 'P0002';
    END IF;

    -- Serializa por familia: dos envíos simultáneos no pueden crear dos 'active'
    -- (además lo impide el índice único parcial).
    PERFORM pg_advisory_xact_lock(hashtextextended('estado_cuenta_enlace:' || p_school_id::text || ':' || p_familia_clave, 0));

    SELECT t.* INTO v_actual
      FROM public.estado_cuenta_enlaces t
     WHERE t.school_id = p_school_id AND t.familia_clave = p_familia_clave AND t.status = 'active';

    IF FOUND
       AND v_actual.expires_at > now() + interval '7 days'
       AND v_actual.atletas = p_atletas
       AND v_actual.meses = v_meses THEN
        RETURN QUERY SELECT v_actual.token, v_actual.expires_at;
        RETURN;
    END IF;

    IF FOUND THEN
        UPDATE public.estado_cuenta_enlaces t SET status = 'replaced' WHERE t.id = v_actual.id;
    END IF;

    RETURN QUERY
    INSERT INTO public.estado_cuenta_enlaces AS t (school_id, familia_clave, atletas, meses, token, expires_at, created_by)
    VALUES (
        p_school_id,
        p_familia_clave,
        p_atletas,
        v_meses,
        translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_'),
        now() + make_interval(days => v_dias),
        p_created_by
    )
    RETURNING t.token, t.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.estado_cuenta_enlace_emitir(uuid, text, jsonb, integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estado_cuenta_enlace_emitir(uuid, text, jsonb, integer, uuid, integer) TO service_role;

-- ── Resolver un token ───────────────────────────────────────────────────────
-- Sin fila = no existe (el BFF responde lo mismo que a un token mal formado,
-- para no dar un oráculo de existencia). 'vencido' y 'revocado' sí se
-- distinguen: quien los tiene ya tuvo el enlace legítimo.
CREATE OR REPLACE FUNCTION public.estado_cuenta_enlace_resolver(p_token text)
RETURNS TABLE (school_id uuid, atletas jsonb, meses integer, vence_en timestamptz, estado text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_row public.estado_cuenta_enlaces%ROWTYPE;
BEGIN
    IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{24}$' THEN
        RETURN;
    END IF;

    SELECT t.* INTO v_row FROM public.estado_cuenta_enlaces t WHERE t.token = p_token;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_row.status = 'revoked' THEN
        RETURN QUERY SELECT v_row.school_id, v_row.atletas, v_row.meses::integer, v_row.expires_at, 'revocado'::text;
        RETURN;
    END IF;

    IF v_row.expires_at <= now() THEN
        RETURN QUERY SELECT v_row.school_id, v_row.atletas, v_row.meses::integer, v_row.expires_at, 'vencido'::text;
        RETURN;
    END IF;

    -- Métrica mínima: ¿la familia abre el enlace?
    UPDATE public.estado_cuenta_enlaces t
       SET open_count = t.open_count + 1, last_opened_at = now()
     WHERE t.id = v_row.id;

    RETURN QUERY SELECT v_row.school_id, v_row.atletas, v_row.meses::integer, v_row.expires_at, 'vigente'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.estado_cuenta_enlace_resolver(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estado_cuenta_enlace_resolver(text) TO service_role;

COMMIT;
