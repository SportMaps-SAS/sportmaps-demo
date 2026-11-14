-- =============================================================================
-- 20261027192225_es_staff_de_escuela_sin_oraculo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27
--
-- Problema (seguridad:invariantes I7, MEDIA): es_staff_de_escuela(p_profile,
--   p_school) es SECURITY DEFINER con EXECUTE para authenticated (lo necesitan los
--   WITH CHECK de bag_athlete_insert / bag_athlete_update, que se evalúan con el
--   rol de quien llama). Pero no mira a quien llama: cualquier sesión podía
--   preguntar «¿P trabaja en S?» para cualquier P y cualquier S (oráculo de
--   pertenencia).
--
-- Arreglo: mismo cuerpo vivo (copiado de pg_proc el 2026-10-27) + gate: devuelve
--   false salvo que quien llama pertenezca a p_school (miembro o inscrito activo,
--   es_miembro_o_inscrito_de_escuela), sea admin de plataforma o sea service_role.
--   El grant del atleta sigue funcionando: el atleta que da acceso está inscrito
--   en esa escuela. biomech_access_grants tiene 0 filas hoy.
--   Firma, SECURITY DEFINER, search_path y permisos: iguales.
--
-- Verificación:
--   select pg_get_functiondef('public.es_staff_de_escuela(uuid,uuid)'::regprocedure) ilike '%es_miembro_o_inscrito_de_escuela%';  -- true
--   -- Sesión sin relación con S → false aunque P sea staff de S:
--   select set_config('request.jwt.claims', json_build_object('sub','<uuid ajeno>','role','authenticated')::text, true);
--   set local role authenticated; select public.es_staff_de_escuela('<staff de S>','<S>');            -- false
--   npm run seguridad:invariantes   -- ya no lista es_staff_de_escuela en I7
-- =============================================================================

CREATE OR REPLACE FUNCTION public.es_staff_de_escuela(p_profile uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_profile IS NOT NULL AND p_school IS NOT NULL
    AND (
      coalesce(auth.role(), '') = 'service_role'
      OR public.es_miembro_o_inscrito_de_escuela(p_school)
      OR public.is_platform_admin()
    )
    AND EXISTS (
      SELECT 1 FROM public.school_members sm
       WHERE sm.profile_id = p_profile AND sm.school_id = p_school
         AND sm.status = 'active' AND sm.role NOT IN ('parent', 'athlete', 'accountant')
      UNION ALL
      SELECT 1 FROM public.school_staff ss
       WHERE ss.coach_auth_id = p_profile AND ss.school_id = p_school AND ss.status = 'active'
      UNION ALL
      SELECT 1 FROM public.school_staff ss
        JOIN auth.users au ON lower(au.email) = lower(ss.email)
       WHERE au.id = p_profile AND ss.school_id = p_school
         AND ss.coach_auth_id IS NULL AND ss.status = 'active'
      UNION ALL
      SELECT 1 FROM public.schools s WHERE s.id = p_school AND s.owner_id = p_profile
    );
$$;

REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.es_staff_de_escuela(uuid, uuid) TO authenticated, service_role;
