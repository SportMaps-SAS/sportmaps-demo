-- =============================================================================
-- 20261030173727_team_schedule_exceptions_motivo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261030123604
-- Objetivo: M5 del bot de WhatsApp de Monster (plan maestro, fase 2). El motivo
--   con que el profe cancela o mueve un entreno en «Mi semana» («lluvia», «el
--   profe está enfermo»). Lo escribe el frontend (useSemanaAjustes) y lo lee el
--   aviso «clase reprogramada» de la clase de prueba (clase-prueba-agenda,
--   motivoDeReprogramacion). Los dos ya toleran que la columna no exista: sin
--   ella guardan sin motivo y el aviso dice «un cambio en la programación».
--   Columna nueva, nullable, sin default: no toca filas existentes ni policies
--   (las de team_schedule_exceptions de 20261030123543 cubren la fila entera).
--   Va después de M4 (20261030123604).
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

ALTER TABLE public.team_schedule_exceptions
    ADD COLUMN motivo text CHECK (motivo IS NULL OR length(motivo) <= 120);

COMMENT ON COLUMN public.team_schedule_exceptions.motivo IS
    'Por qué se canceló o movió la sesión (lo escribe el profe en «Mi semana»; ≤ 120). Sale en el aviso «clase reprogramada».';

COMMIT;
