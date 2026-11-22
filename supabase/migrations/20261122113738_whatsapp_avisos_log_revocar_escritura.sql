-- =============================================================================
-- 20261122113738_whatsapp_avisos_log_revocar_escritura.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-22   Versión anterior: 20261122112847
-- Objetivo: whatsapp_avisos_log solo se LEE desde la app; los privilegios por defecto del esquema le daban INSERT/UPDATE/DELETE a authenticated (la RLS sin policy los bloquea, pero no deben existir).
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

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.whatsapp_avisos_log FROM authenticated, anon;

COMMIT;
