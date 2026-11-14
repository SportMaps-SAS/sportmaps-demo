-- =============================================================================
-- 20261029222300_open_month_ignora_clase_prueba.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261029215003
-- Objetivo: que el pago de la CLASE DE PRUEBA no tape la mensualidad del mes.
--
-- 20261029215003 pasa el pago de la clase al deportista al convertir el
-- prospecto (child_id/user_id + period del mes de la clase). open_month y
-- preview_open_month preguntan «¿ya tiene cobro este mes?» ignorando solo los
-- cobros únicos de la lista de 20261007095911; 'clase_prueba' no estaba, así que
-- ese pago contaba como la mensualidad y el mes no se emitía (aviso de la sesión
-- del bot de Monster, 2026-10-29). Se suma también 'reserva' (cobro único que ya
-- está en el CHECK y faltaba en la lista; 0 filas hoy). 'otro' queda como está.
--
-- Cómo: NO se copia el cuerpo a mano. Se toma la definición VIVA
-- (pg_get_functiondef), se reemplaza SOLO el final de la lista y se re-ejecuta.
-- Si la lista no aparece exactamente una vez, falla: hay deriva y hay que mirar.
-- CREATE OR REPLACE conserva dueño y GRANT.
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

DO $$
DECLARE
    v_fn   regprocedure;
    v_def  text;
    v_old  constant text := '''clase_extra'', ''vacacional'', ''viaje'')';
    v_new  constant text := '''clase_extra'', ''vacacional'', ''viaje'', ''clase_prueba'', ''reserva'')';
    v_veces int;
BEGIN
    FOREACH v_fn IN ARRAY ARRAY[
        'public.open_month(uuid,integer,integer,uuid)'::regprocedure,
        'public.preview_open_month(uuid,integer,integer,uuid)'::regprocedure
    ] LOOP
        v_def := pg_get_functiondef(v_fn);
        v_veces := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
        IF v_veces <> 1 THEN
            RAISE EXCEPTION '%: la lista de cobros únicos aparece % veces (se esperaba 1); revisar deriva', v_fn, v_veces;
        END IF;
        EXECUTE replace(v_def, v_old, v_new);
    END LOOP;
END;
$$;

COMMIT;
