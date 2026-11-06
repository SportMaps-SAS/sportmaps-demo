-- =============================================================================
-- 20261105234141_partido_vivo_gate_visible_set_director_y_report.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105231617
-- Objetivo: que `npm run seguridad:invariantes` (I7_rpc_definer_sin_gate) deje de
--   marcar set_live_director y match_live_report.
--
-- Diagnóstico (verificado leyendo el cuerpo VIVO el 2026-11-06): NO es un hueco.
-- Ambas funciones llaman `_live_auth(p_match, 'admin' | 'staff')`, que
--   · exige auth.uid() no nulo,
--   · ata el alcance al school_id DEL PARTIDO (user_admin_school_ids /
--     user_staff_school_ids / is_platform_admin),
--   · exige school_settings.live_match_enabled.
-- El detector I7 es una regex sobre prosrc y no ve el gate dentro del helper.
--
-- Cambio: mismo cuerpo, más una comprobación explícita y barata de auth.uid() al
-- inicio (visible para el detector y para quien lea la función). NO cambia
-- firma, retorno, volatilidad ni ACL (CREATE OR REPLACE conserva los GRANT).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.set_live_director(p_match uuid, p_new_director uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m public.match_results;
  l public.match_live;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  -- Gate de alcance: admin de la escuela DEL PARTIDO (o platform admin) + flag.
  m := public._live_auth(p_match, 'admin');
  SELECT * INTO l FROM public.match_live WHERE match_id = p_match FOR UPDATE;
  IF NOT FOUND THEN PERFORM public._live_raise('LIVE_NOT_STARTED'); END IF;
  IF p_new_director IS NULL OR NOT public._live_is_staff_of(p_new_director, m.school_id) THEN
    PERFORM public._live_raise('NEW_DIRECTOR_NOT_STAFF');
  END IF;
  UPDATE public.match_live SET director_id = p_new_director, updated_at = now() WHERE match_id = p_match;
  RETURN public._live_state_json(p_match);
END
$$;

CREATE OR REPLACE FUNCTION public.match_live_report(p_match uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  -- Gate de alcance: staff de la escuela DEL PARTIDO (o platform admin) + flag.
  PERFORM public._live_auth(p_match, 'staff');
  RETURN public._live_report_data(p_match);
END
$$;

COMMIT;
