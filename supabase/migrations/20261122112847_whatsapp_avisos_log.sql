-- =============================================================================
-- 20261122112847_whatsapp_avisos_log.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-22   Versión anterior: 20261120143043
-- Objetivo: registrar cada intento de aviso de WhatsApp por plantilla (salió o no, con su motivo).
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

CREATE TABLE IF NOT EXISTS public.whatsapp_avisos_log (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id   uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    concepto    text        NOT NULL,
    plantilla   text,
    payment_id  uuid,
    parent_id   uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    destino     text,
    resultado   text        NOT NULL CHECK (resultado IN ('enviado', 'no_enviado')),
    motivo      text,
    detalle     text        CHECK (detalle IS NULL OR char_length(detalle) <= 300),
    wa_message_id text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.whatsapp_avisos_log IS
    'Cada intento de aviso por plantilla de WhatsApp, salga o no (motivo en no_enviado). Escribe solo el BFF (service_role). Plan: docs/specs/registro-avisos-whatsapp.md';

CREATE INDEX IF NOT EXISTS whatsapp_avisos_log_school_fecha_idx
    ON public.whatsapp_avisos_log (school_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_avisos_log_payment_idx
    ON public.whatsapp_avisos_log (payment_id) WHERE payment_id IS NOT NULL;

ALTER TABLE public.whatsapp_avisos_log ENABLE ROW LEVEL SECURITY;

-- Lectura: quien TRABAJA en la escuela (no padres ni atletas: la fila lleva teléfonos).
-- Sin policy de escritura: solo service_role (que salta RLS) inserta.
CREATE POLICY whatsapp_avisos_log_staff_select ON public.whatsapp_avisos_log
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

REVOKE ALL ON public.whatsapp_avisos_log FROM PUBLIC, anon;
GRANT SELECT ON public.whatsapp_avisos_log TO authenticated;
GRANT ALL ON public.whatsapp_avisos_log TO service_role;

COMMIT;
