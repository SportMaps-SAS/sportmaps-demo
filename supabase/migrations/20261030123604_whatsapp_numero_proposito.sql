-- =============================================================================
-- 20261030123604_whatsapp_numero_proposito.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261030123555
-- Objetivo: M4 del plan maestro del bot de WhatsApp de Monster
-- (docs/specs/whatsapp-monster-plan-maestro.md §2, B9 «dos números por escuela»).
--   · school_whatsapp_integrations.proposito: 'general' (el número de siempre) o
--     'eventos' (p. ej. Monster: torneos y clínica en el 318 868 2241).
--   · nombre: cómo lo ve la escuela en la pantalla («🏆 Torneos»), ≤40.
--   · Un número ACTIVO por escuela y propósito (índice único parcial).
-- Todas las filas existentes quedan en 'general' (DEFAULT): nada cambia hasta
-- que alguien dé de alta un segundo número. Medido 2026-10-30: ninguna escuela
-- tiene dos integraciones activas, así que el índice se crea sin choque.
-- El código de hoy que espera un solo número por escuela lo reemplaza
-- integracionDeEscuela(schoolId, { proposito?, conversationId? }) en la fase 2.
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

ALTER TABLE public.school_whatsapp_integrations
    ADD COLUMN proposito text NOT NULL DEFAULT 'general'
        CONSTRAINT school_whatsapp_integrations_proposito_check
        CHECK (proposito IN ('general', 'eventos')),
    ADD COLUMN nombre text
        CONSTRAINT school_whatsapp_integrations_nombre_check
        CHECK (nombre IS NULL OR length(btrim(nombre)) BETWEEN 1 AND 40);

COMMENT ON COLUMN public.school_whatsapp_integrations.proposito IS
    'Para qué es el número: general (el de siempre) o eventos (torneos, clínicas). Uno activo por escuela y propósito. (20261030123604)';
COMMENT ON COLUMN public.school_whatsapp_integrations.nombre IS
    'Nombre del número que ve la escuela (≤40), p. ej. «🏆 Torneos». NULL = el número. (20261030123604)';

CREATE UNIQUE INDEX uq_wa_integration_school_proposito_activa
    ON public.school_whatsapp_integrations (school_id, proposito)
    WHERE status = 'active';

COMMIT;
