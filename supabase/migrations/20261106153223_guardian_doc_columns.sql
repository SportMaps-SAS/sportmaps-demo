-- =============================================================================
-- 20261106153223_guardian_doc_columns.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261106152913
-- Objetivo: documento del acudiente (tipo y número) en children y unregistered_athletes.
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

-- Solo columnas nullable; sin policies ni funciones (las policies por fila ya cubren las columnas nuevas).
ALTER TABLE public.children
  ADD COLUMN IF NOT EXISTS guardian_doc_type text
    CHECK (guardian_doc_type IS NULL OR guardian_doc_type IN ('CC','CE','PP','NIT')),
  ADD COLUMN IF NOT EXISTS guardian_doc_number text
    CHECK (guardian_doc_number IS NULL OR guardian_doc_number ~ '^[A-Za-z0-9-]{4,20}$');

ALTER TABLE public.unregistered_athletes
  ADD COLUMN IF NOT EXISTS guardian_doc_type text
    CHECK (guardian_doc_type IS NULL OR guardian_doc_type IN ('CC','CE','PP','NIT')),
  ADD COLUMN IF NOT EXISTS guardian_doc_number text
    CHECK (guardian_doc_number IS NULL OR guardian_doc_number ~ '^[A-Za-z0-9-]{4,20}$');

COMMIT;
