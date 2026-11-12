-- =============================================================================
-- 20261112143719_report_pdf_version.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-12   Versión anterior: 20261112132803
-- Objetivo: interruptor por escuela del diseño del Informe Mensual del Atleta (v1 actual / v2 una página con banda de marca).
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

-- Default 'v1' = el informe de hoy para TODAS las escuelas. Solo las que se pasen a 'v2' cambian.
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS report_pdf_version text NOT NULL DEFAULT 'v1'
    CHECK (report_pdf_version IN ('v1', 'v2'));

COMMENT ON COLUMN public.school_settings.report_pdf_version IS
    'Diseño del PDF del Informe Mensual del Atleta: v1 (completo clásico) o v2 (banda de marca, comentario del entrenador, tono por categoría). Besser sigue en v1 hasta que valide v2.';

-- Carmel: v2 (pidió marca propia y un informe pensado para las familias).
UPDATE public.school_settings
   SET report_pdf_version = 'v2'
 WHERE school_id = '374a6716-af42-4745-afe1-8d089153e01b';

COMMIT;
