-- =============================================================================
-- 20261126101055_mapi_rpc_por_actor_existentes.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126095105
-- Objetivo: que Mapi (app y WhatsApp) use las 9 RPC que autorizan con auth.uid()
-- sin el JWT de la persona. Diseño B (docs/specs/mapi-rpc-por-actor-plan.md rev. 2):
-- las originales NO se tocan; cada una gana una <rpc>_por (solo service_role) que
-- valida el rol del actor en la escuela del objeto, fija sub = actor en los claims
-- de ESTA transacción y llama a la original.
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

-- ── 1. Gate común y actor de la transacción ──────────────────────────────────
CREATE OR REPLACE FUNCTION public._por_actuar_como(p_actor uuid, p_school_id uuid, p_rol text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- 1) Solo el servidor. Si la transacción ya actúa a nombre de alguien, tiene que
  --    ser la misma persona: nunca reemplaza una sesión ni cambia de actor.
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'solo_servidor: esta función la llama el servidor' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor_requerido: falta quién actúa' USING ERRCODE = '22023';
  END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'actor_distinto: la transacción ya actúa a nombre de otra persona' USING ERRCODE = '42501';
  END IF;
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'no_encontrado: no existe o no tiene escuela' USING ERRCODE = 'P0002';
  END IF;
  IF p_rol IS NULL OR p_rol NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'rol_invalido: %', p_rol USING ERRCODE = '22023';
  END IF;

  -- 2) Actor hasta el final de ESTA transacción (PostgREST abre una por request).
  --    role sigue siendo service_role. Si el gate de abajo falla, la transacción se
  --    revierte entera y esto se va con ella. Al salir de esta función solo se
  --    restaura search_path (su cláusula SET); los claims siguen vigentes.
  PERFORM set_config('request.jwt.claims',
          (COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
             || jsonb_build_object('sub', p_actor::text))::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);

  -- 3) El rol, con los MISMOS helpers vivos de la pantalla y las policies.
  --    admin = miembro activo owner/admin/school_admin (lo mismo que alcance.ts del BFF).
  IF p_rol = 'admin' AND NOT COALESCE(public.is_school_admin(p_school_id), false) THEN
    RAISE EXCEPTION 'sin_permiso: no es de la administración activa de esta escuela' USING ERRCODE = '42501';
  END IF;
  IF p_rol = 'staff' AND NOT (p_school_id = ANY (public.user_staff_school_ids())) THEN
    RAISE EXCEPTION 'sin_permiso: no trabaja en esta escuela' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._por_actuar_como(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public._por_actuar_como(uuid, uuid, text) IS
  'Gate de las *_por (plan mapi-rpc-por-actor): service_role, fija sub = actor en ESTA transacción y exige rol admin/staff en ESA escuela con los helpers vivos.';

-- ── 2. Las 9 _por: escuela del objeto → gate → la RPC ORIGINAL ───────────────
-- VOLATILE todas, también las de lectura: fijan el actor (set_config).

CREATE OR REPLACE FUNCTION public.preview_enrollment_pause_por(p_actor uuid, p_enrollment_id uuid, p_month_from date, p_month_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.preview_enrollment_pause(p_enrollment_id, p_month_from, p_month_to);
END;
$$;

CREATE OR REPLACE FUNCTION public.pause_enrollment_directly_por(p_actor uuid, p_enrollment_id uuid, p_reason text, p_month_from date, p_month_to date, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.pause_enrollment_directly(p_enrollment_id, p_reason, p_month_from, p_month_to, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.resume_enrollment_por(p_actor uuid, p_enrollment_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.resume_enrollment(p_enrollment_id, p_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_school_athlete_status_por(p_actor uuid, p_school_id uuid, p_athlete_type text, p_athlete_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  RETURN public.set_school_athlete_status(p_school_id, p_athlete_type, p_athlete_id, p_active);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_post_training_coach_rating_por(p_actor uuid, p_session_id uuid, p_ratings jsonb, p_coach_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT s.school_id INTO v_school FROM public.attendance_sessions s WHERE s.id = p_session_id;
  -- Staff de la escuela de la sesión; que sea EL coach del equipo lo exige la original.
  PERFORM public._por_actuar_como(p_actor, v_school, 'staff');
  RETURN public.submit_post_training_coach_rating(p_session_id, p_ratings, p_coach_notes);
END;
$$;

CREATE OR REPLACE FUNCTION public.give_kudos_por(p_actor uuid, p_school_id uuid, p_child_id uuid, p_athlete_user_id uuid, p_message text, p_unregistered_athlete_id uuid DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- El coach solo felicita a los de sus equipos: lo exige la original.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'staff');
  RETURN public.give_kudos(p_school_id, p_child_id, p_athlete_user_id, p_message, p_unregistered_athlete_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.clases_prueba_semana_por(p_actor uuid, p_school_id uuid, p_desde date, p_hasta date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- La original recorta al coach a sus equipos y le esconde los montos.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'staff');
  RETURN public.clases_prueba_semana(p_school_id, p_desde, p_hasta);
END;
$$;

CREATE OR REPLACE FUNCTION public.listar_clase_prueba_por(p_actor uuid, p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- Más estricta que la original (staff): trae teléfonos y correos de prospectos.
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  RETURN public.listar_clase_prueba(p_school_id);
END;
$$;

-- Sin parámetros de plata: registrar el pago de la clase no es de Mapi.
CREATE OR REPLACE FUNCTION public.agendar_clase_prueba_desde_chat_por(p_actor uuid, p_conversation_id uuid, p_slot_id uuid, p_nombre text, p_fecha_nacimiento date DEFAULT NULL, p_genero text DEFAULT NULL, p_acudiente text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  SELECT c.school_id INTO v_school FROM public.whatsapp_conversations c WHERE c.id = p_conversation_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  RETURN public.agendar_clase_prueba_desde_chat(
    p_conversation_id, p_slot_id, p_nombre, p_fecha_nacimiento, p_genero, p_acudiente,
    NULL, NULL, NULL);
END;
$$;

-- ── 3. Privilegios: solo service_role ejecuta las _por ───────────────────────
REVOKE ALL ON FUNCTION public.preview_enrollment_pause_por(uuid, uuid, date, date)                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_enrollment_directly_por(uuid, uuid, text, date, date, text)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_enrollment_por(uuid, uuid, text)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_school_athlete_status_por(uuid, uuid, text, uuid, boolean)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_post_training_coach_rating_por(uuid, uuid, jsonb, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.give_kudos_por(uuid, uuid, uuid, uuid, text, uuid)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clases_prueba_semana_por(uuid, uuid, date, date)                            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.listar_clase_prueba_por(uuid, uuid)                                         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agendar_clase_prueba_desde_chat_por(uuid, uuid, uuid, text, date, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_enrollment_pause_por(uuid, uuid, date, date)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_enrollment_directly_por(uuid, uuid, text, date, date, text)            TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_enrollment_por(uuid, uuid, text)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.set_school_athlete_status_por(uuid, uuid, text, uuid, boolean)              TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_post_training_coach_rating_por(uuid, uuid, jsonb, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.give_kudos_por(uuid, uuid, uuid, uuid, text, uuid)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.clases_prueba_semana_por(uuid, uuid, date, date)                            TO service_role;
GRANT EXECUTE ON FUNCTION public.listar_clase_prueba_por(uuid, uuid)                                         TO service_role;
GRANT EXECUTE ON FUNCTION public.agendar_clase_prueba_desde_chat_por(uuid, uuid, uuid, text, date, text, text) TO service_role;

COMMIT;
