-- =============================================================================
-- 20261119125220_get_personal_trainer_school_id_gate.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119121205
-- Objetivo: cerrar el oráculo uuid → escuela de get_personal_trainer_school_id.
--   Hoy la función es SECURITY DEFINER, tiene EXECUTE para authenticated y NO
--   compara p_user_id con nadie: cualquier sesión puede llamar
--   rpc('get_personal_trainer_school_id', {p_user_id: <uuid ajeno>}) y obtener el
--   school_id de un entrenador personal. No devuelve datos personales ni permite
--   actuar sobre nada (severidad baja), pero es el patrón «RPC que recibe un id
--   de usuario sin atarlo al caller» que el CLAUDE.md prohíbe (detector I7).
--   Ref: docs/revision-migracion-y-i7-2026-11-18.md (B.3).
--
-- QUÉ CAMBIA:
--   Se agrega el gate `(p_user_id = auth.uid() OR is_super_admin())` y se fija
--   search_path = pg_catalog, public, pg_temp (hoy es solo 'public').
--   Mismo nombre, misma firma, mismo tipo de retorno, LANGUAGE sql STABLE
--   SECURITY DEFINER: CREATE OR REPLACE conserva los GRANT vigentes
--   (postgres, service_role, authenticated). NO se revoca nada: es helper de
--   policies. Definición viva leída de pg_proc el 2026-11-19 (cuerpo idéntico al
--   de supabase/qa-twin/dump/01_public.sql salvo search_path).
--
-- RADIO DE IMPACTO (medido contra la base viva, 2026-11-19):
--   · 19 policies la usan (academic_progress, athlete_stats, athlete_goals,
--     training_logs, coach_availability, body_metrics; SELECT/INSERT/UPDATE/
--     DELETE/ALL) y TODAS la llaman con get_personal_trainer_school_id(auth.uid()).
--     Con p_user_id = auth.uid() el resultado es idéntico al de hoy.
--   · Ninguna otra función de public la referencia (prosrc, cero coincidencias).
--   · Ni bff/ ni frontend/ la llaman por rpc().
--   · 13 escuelas personal_trainer. Un caller con sesión pidiendo el id de otro
--     recibe NULL (antes recibía el uuid de la escuela). service_role (auth.uid()
--     NULL) también recibe NULL salvo que el contexto sea super admin: nadie lo usa
--     así hoy (el BFF no llama esta función).
--   · anon no tiene EXECUTE; con auth.uid() NULL, `p_user_id = NULL` nunca es
--     verdadero: tampoco se filtraría nada.
--
-- ROLLBACK (restaura el cuerpo anterior; idéntico al vivo antes de esta migración):
--   CREATE OR REPLACE FUNCTION public.get_personal_trainer_school_id(p_user_id uuid)
--   RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
--   AS $$ SELECT id FROM public.schools
--         WHERE owner_id = p_user_id AND school_type = 'personal_trainer' LIMIT 1; $$;
--
-- DESPUÉS DE APLICAR (simulación de sesión, sin escribir; reemplazar uuids):
--   begin;
--     set local role authenticated;
--     -- a) el propio entrenador: debe devolver su escuela (igual que antes)
--     select set_config('request.jwt.claims', json_build_object('sub','<uuid_entrenador_personal>')::text, true);
--     select public.get_personal_trainer_school_id('<uuid_entrenador_personal>');   -- ESPERADO: su school_id
--     -- b) uuid ajeno: ya no se filtra
--     select public.get_personal_trainer_school_id('<uuid_otro_entrenador>');       -- ESPERADO: NULL
--     -- c) regresión de policies: mismo conteo que antes de aplicar
--     select count(*) from public.athlete_goals;
--     select count(*) from public.training_logs;
--     select count(*) from public.body_metrics;
--   rollback;
--   -- d) super admin: debe seguir resolviendo cualquier uuid
--   begin;
--     set local role authenticated;
--     select set_config('request.jwt.claims', json_build_object('sub','<uuid_super_admin>')::text, true);
--     select public.get_personal_trainer_school_id('<uuid_entrenador_personal>');   -- ESPERADO: su school_id
--   rollback;
--   Cierre: npm run seguridad:invariantes (el detector I7 deja de marcarla).
--   No cambia esquema: NO regenerar types.ts.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Helper usado en una POLICY: SÍ GRANT EXECUTE a authenticated (se conserva).
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_personal_trainer_school_id(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  SELECT s.id
    FROM public.schools s
   WHERE s.owner_id = p_user_id
     AND s.school_type = 'personal_trainer'
     AND (p_user_id = (SELECT auth.uid()) OR (SELECT public.is_super_admin()))
   LIMIT 1;
$function$;

-- CREATE OR REPLACE conserva los privilegios; se reafirman por si la base viva
-- derivó (idempotente). authenticated DEBE conservar EXECUTE: la usan 19 policies.
REVOKE ALL ON FUNCTION public.get_personal_trainer_school_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_personal_trainer_school_id(uuid) TO authenticated, service_role;

COMMIT;
