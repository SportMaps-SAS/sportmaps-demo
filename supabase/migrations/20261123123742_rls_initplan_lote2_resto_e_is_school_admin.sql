-- =============================================================================
-- 20261123123742_rls_initplan_lote2_resto_e_is_school_admin.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123121346
-- Objetivo: rendimiento de RLS en el resto de las tablas (plan de arquitectura
-- §11, R2.1 lote 2; linter auth_rls_initplan). Aplicar DESPUÉS de 20261118163548
-- (lote 1) y de verificarlo.
-- =============================================================================
-- QUÉ CAMBIA (y qué NO)
--   511 policies en 210 tablas (todas las de public salvo las 9 del lote 1).
--   Lo que cada policy PERMITE no cambia. Solo cuándo se calcula:
--   · auth.uid() / auth.jwt() / auth.role() / auth.email() -> (SELECT auth.f())
--   · helper sin argumentos (STABLE, no SETOF) -> (SELECT public.f()), y dentro de
--     ANY/ALL -> ANY ((SELECT public.f())::<tipo>)  (sin el cast da 42883)
--   · is_school_admin(x) -> (x = ANY ((SELECT public.is_school_admin_ids())::uuid[]))
--     en 87 policies. is_school_admin es plpgsql VOLATILE: hoy corre una consulta a
--     school_members POR FILA. is_school_admin_ids() (nueva, abajo) es su gemela
--     exacta: mismo filtro (profile_id = auth.uid(), role owner/admin/school_admin,
--     status active), misma dueña, SECURITY DEFINER, y devuelve las escuelas en vez
--     de preguntar por una. Para x no nulo, is_school_admin(x) <=> x = ANY(ids).
--     Para x nulo, la vieja da false y la nueva NULL; las dos niegan, y ninguno de
--     los 87 usos está bajo NOT, CASE, COALESCE ni comparación (revisado), así que
--     el resultado de la policy es el mismo.
--   · Los ROLES NO se tocan (el lote 1 sí agregaba TO authenticated). Por eso
--     is_school_admin_ids() lleva EXECUTE para anon, igual que is_school_admin: hay
--     policies {public} que anon evalúa; sin el GRANT darían 42501. Para anon
--     devuelve '{}'.
--   · Solo se reescribe la cláusula que cambia (USING y/o WITH CHECK); la otra
--     queda como esté.
--   NO entra aquí: las funciones con argumento por fila (school_is_operational,
--   can_manage_finances, get_personal_trainer_school_id, …), las 5 policies con
--   is_school_admin de las tablas del lote 1, la unión de policies duplicadas y
--   el esquema storage.
--
-- GUARD CONTRA DERIVA
--   Cada ALTER va dentro de un DO que lee la policy viva antes de tocarla:
--   · igual al texto que vio el generador -> se reescribe y se comprueba que no
--     quedó nada sin envolver;
--   · ya envuelta (por este lote o por otra vía) -> se salta con NOTICE;
--   · distinta -> RAISE: otra sesión la cambió y pisarla desharía su cambio
--     (ya pasó con 20261119125234_i3). Hay que regenerar el lote.
--   Es idempotente: si falla a mitad, se vuelve a correr completo y salta lo
--   que ya entró.
--
-- CÓMO SE GENERÓ Y VERIFICÓ (2026-11-23)
--   · Desde pg_policies VIVO (solo lectura, search_path "$user", public; cada
--     bloque fija ese mismo search_path para que el texto comparado coincida).
--   · Prueba textual: deshacer cada reescritura devuelve la expresión vieja
--     carácter por carácter (511 policies, 0 fallas), y no queda nada pelado.
--   · Ensayo en el gemelo local, en una transacción con ROLLBACK.
--   · Guard probado en una base desechable: aplica, salta lo ya aplicado y se
--     detiene ante una policy cambiada.
--
-- CÓMO APLICAR
--   Una transacción por tabla, lock_timeout 800ms (< deadlock_timeout 1s, para
--   fallar con 55P03 reintentable). ALTER POLICY toma AccessExclusiveLock unos
--   milisegundos: hora valle y UNA sola sesión. scripts/aplicar-migraciones.mjs
--   reintenta solo ante 55P03/40P01.
--   Sin cambios de tipos: NO hace falta regenerar types.ts.
--   Después: npm run seguridad:invariantes.
-- =============================================================================

-- 0. Función gemela de is_school_admin y verificador temporal de la sesión
BEGIN;
SET LOCAL lock_timeout = '800ms';
CREATE OR REPLACE FUNCTION public.is_school_admin_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
  SELECT COALESCE(ARRAY(
    SELECT sm.school_id
      FROM public.school_members sm
     WHERE sm.profile_id = auth.uid()
       AND sm.school_id IS NOT NULL
       AND sm.role IN ('owner', 'admin', 'school_admin')
       AND sm.status = 'active'
  ), '{}'::uuid[]);
$fn$;
COMMENT ON FUNCTION public.is_school_admin_ids() IS
  'Gemela exacta de is_school_admin(p): para p no nulo, p = ANY(is_school_admin_ids()) <=> is_school_admin(p). Para policies: envuelta en (SELECT …) se calcula una vez por consulta; is_school_admin(col) es plpgsql VOLATILE y corre una consulta por fila.';
REVOKE ALL ON FUNCTION public.is_school_admin_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_school_admin_ids() TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION pg_temp.lote2_envuelta(t text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $f$
  SELECT t IS NULL OR (
        t !~ $re$(?<!SELECT )auth\.(uid|jwt|role|email)\(\)$re$
    AND t !~ $re$(?<![a-z0-9_.])is_school_admin\($re$
    AND t !~ $re$(?<!SELECT )(?<![a-z0-9_.])(autopay_visible_subscription_ids|user_tactical_edit_school_ids|calendar_family_school_ids|my_linked_unregistered_ids|calendar_family_team_ids|finance_read_school_ids|current_staff_team_ids|user_admin_school_ids|user_staff_school_ids|my_coach_staff_ids|is_platform_admin|is_support_agent|user_school_ids|is_super_admin|store_enabled)\(\)$re$
  )
$f$;
COMMIT;

-- academic_progress: 11 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_admin_all', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND is_school_admin(children.school_id))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND is_school_admin(children.school_id))))$o$ THEN
    EXECUTE $a$ALTER POLICY "academic_progress_admin_all" ON public."academic_progress"
      USING ((EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND (children.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND (children.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_admin_all', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_admin_all', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_admin_all', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_athlete_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_athlete_read', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_athlete_read" ON public."academic_progress"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_athlete_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_athlete_read', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_athlete_read', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_athlete_read', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_delete', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_delete" ON public."academic_progress"
      USING (((EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_delete', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_delete', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_delete', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_insert', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "academic_progress_insert" ON public."academic_progress"
      WITH CHECK (((coach_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_insert', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_insert', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_insert', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_parent_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_parent_read', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND (children.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_parent_read" ON public."academic_progress"
      USING ((EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = academic_progress.child_id) AND (children.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_parent_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_parent_read', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_parent_read', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_parent_read', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_select', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = academic_progress.child_id) AND (c.parent_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_select" ON public."academic_progress"
      USING (((coach_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = academic_progress.child_id) AND (c.parent_id = (SELECT auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_select', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_select', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_select', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_trainer_delete', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) AND (school_id = get_personal_trainer_school_id(auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_trainer_delete" ON public."academic_progress"
      USING (((coach_id = (SELECT auth.uid())) AND (school_id = get_personal_trainer_school_id((SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_trainer_delete', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_trainer_delete', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_trainer_delete', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_trainer_insert', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) AND (school_id = get_personal_trainer_school_id(auth.uid())) AND ((user_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids)) OR (child_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))))$o$ THEN
    EXECUTE $a$ALTER POLICY "academic_progress_trainer_insert" ON public."academic_progress"
      WITH CHECK (((coach_id = (SELECT auth.uid())) AND (school_id = get_personal_trainer_school_id((SELECT auth.uid()))) AND ((user_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)) OR (child_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_trainer_insert', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_trainer_insert', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_trainer_insert', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_trainer_select', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) AND (school_id = get_personal_trainer_school_id(auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_trainer_select" ON public."academic_progress"
      USING (((coach_id = (SELECT auth.uid())) AND (school_id = get_personal_trainer_school_id((SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_trainer_select', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_trainer_select', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_trainer_select', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_trainer_update', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) AND (school_id = get_personal_trainer_school_id(auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_trainer_update" ON public."academic_progress"
      USING (((coach_id = (SELECT auth.uid())) AND (school_id = get_personal_trainer_school_id((SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_trainer_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_trainer_update', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_trainer_update', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_trainer_update', 'academic_progress';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'academic_progress_update', 'academic_progress';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "academic_progress_update" ON public."academic_progress"
      USING (((coach_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM (children c
     JOIN school_members sm ON ((sm.school_id = c.school_id)))
  WHERE ((c.id = academic_progress.child_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'academic_progress' AND p.policyname = 'academic_progress_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'academic_progress_update', 'academic_progress';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'academic_progress_update', 'academic_progress';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'academic_progress_update', 'academic_progress';
  END IF;
END
$lote2$;
COMMIT;

-- access_events: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'access_events' AND p.policyname = 'School members can view access events';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School members can view access events', 'access_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School members can view access events" ON public."access_events"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'access_events' AND p.policyname = 'School members can view access events';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School members can view access events', 'access_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School members can view access events', 'access_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School members can view access events', 'access_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'access_events' AND p.policyname = 'User can view own access events';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'User can view own access events', 'access_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "User can view own access events" ON public."access_events"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'access_events' AND p.policyname = 'User can view own access events';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'User can view own access events', 'access_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'User can view own access events', 'access_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'User can view own access events', 'access_events';
  END IF;
END
$lote2$;
COMMIT;

-- activities: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_access';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'activities_access', 'activities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM $o$((user_id = ( SELECT auth.uid() AS uid)) OR ( SELECT is_platform_admin() AS is_platform_admin))$o$ THEN
    EXECUTE $a$ALTER POLICY "activities_access" ON public."activities"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_access';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'activities_access', 'activities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'activities_access', 'activities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'activities_access', 'activities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'activities_delete', 'activities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "activities_delete" ON public."activities"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'activities_delete', 'activities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'activities_delete', 'activities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'activities_delete', 'activities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'activities_insert', 'activities';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "activities_insert" ON public."activities"
      WITH CHECK (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'activities_insert', 'activities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'activities_insert', 'activities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'activities_insert', 'activities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'activities_select', 'activities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "activities_select" ON public."activities"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'activities_select', 'activities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'activities_select', 'activities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'activities_select', 'activities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'activities_update', 'activities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "activities_update" ON public."activities"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'activities' AND p.policyname = 'activities_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'activities_update', 'activities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'activities_update', 'activities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'activities_update', 'activities';
  END IF;
END
$lote2$;
COMMIT;

-- adms_device_log: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'adms_device_log' AND p.policyname = 'school_admins_read_own_device_log';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_admins_read_own_device_log', 'adms_device_log';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_admins_read_own_device_log" ON public."adms_device_log"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'adms_device_log' AND p.policyname = 'school_admins_read_own_device_log';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_admins_read_own_device_log', 'adms_device_log';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_admins_read_own_device_log', 'adms_device_log';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_admins_read_own_device_log', 'adms_device_log';
  END IF;
END
$lote2$;
COMMIT;

-- analytics_events: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'analytics_events_insert', 'analytics_events';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR (user_id IS NULL))$o$ THEN
    EXECUTE $a$ALTER POLICY "analytics_events_insert" ON public."analytics_events"
      WITH CHECK (((user_id = (SELECT auth.uid())) OR (user_id IS NULL)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'analytics_events_insert', 'analytics_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'analytics_events_insert', 'analytics_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'analytics_events_insert', 'analytics_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'analytics_events_select_admin', 'analytics_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "analytics_events_select_admin" ON public."analytics_events"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'analytics_events_select_admin', 'analytics_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'analytics_events_select_admin', 'analytics_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'analytics_events_select_admin', 'analytics_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'analytics_events_select_own', 'analytics_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "analytics_events_select_own" ON public."analytics_events"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'analytics_events' AND p.policyname = 'analytics_events_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'analytics_events_select_own', 'analytics_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'analytics_events_select_own', 'analytics_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'analytics_events_select_own', 'analytics_events';
  END IF;
END
$lote2$;
COMMIT;

-- announcements: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'announcements_delete_own', 'announcements';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) OR is_school_admin(( SELECT teams.school_id
   FROM teams
  WHERE (teams.id = announcements.team_id))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "announcements_delete_own" ON public."announcements"
      USING (((coach_id = (SELECT auth.uid())) OR (( SELECT teams.school_id
   FROM teams
  WHERE (teams.id = announcements.team_id)) = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'announcements_delete_own', 'announcements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'announcements_delete_own', 'announcements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'announcements_delete_own', 'announcements';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_insert_coach_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'announcements_insert_coach_admin', 'announcements';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = announcements.team_id) AND (is_school_admin(t.school_id) OR is_school_coach(t.school_id))))))$o$ THEN
    EXECUTE $a$ALTER POLICY "announcements_insert_coach_admin" ON public."announcements"
      WITH CHECK (((coach_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = announcements.team_id) AND ((t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(t.school_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_insert_coach_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'announcements_insert_coach_admin', 'announcements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'announcements_insert_coach_admin', 'announcements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'announcements_insert_coach_admin', 'announcements';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_select_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'announcements_select_members', 'announcements';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = announcements.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "announcements_select_members" ON public."announcements"
      USING ((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = announcements.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_select_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'announcements_select_members', 'announcements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'announcements_select_members', 'announcements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'announcements_select_members', 'announcements';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'announcements_update_own', 'announcements';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "announcements_update_own" ON public."announcements"
      USING ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'announcements' AND p.policyname = 'announcements_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'announcements_update_own', 'announcements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'announcements_update_own', 'announcements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'announcements_update_own', 'announcements';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_certificates: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_certificates' AND p.policyname = 'athlete_certificates_modify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_certificates_modify', 'athlete_certificates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_certificates_modify" ON public."athlete_certificates"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_certificates' AND p.policyname = 'athlete_certificates_modify';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_certificates_modify', 'athlete_certificates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_certificates_modify', 'athlete_certificates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_certificates_modify', 'athlete_certificates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_certificates' AND p.policyname = 'athlete_certificates_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_certificates_select', 'athlete_certificates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id) OR (profile_id = auth.uid()) OR ((child_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_certificates.child_id) AND (c.parent_id = auth.uid()))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_certificates_select" ON public."athlete_certificates"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (profile_id = (SELECT auth.uid())) OR ((child_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_certificates.child_id) AND (c.parent_id = (SELECT auth.uid()))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_certificates' AND p.policyname = 'athlete_certificates_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_certificates_select', 'athlete_certificates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_certificates_select', 'athlete_certificates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_certificates_select', 'athlete_certificates';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_documents: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_documents' AND p.policyname = 'school_staff_manage_athlete_documents';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_staff_manage_athlete_documents', 'athlete_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "school_staff_manage_athlete_documents" ON public."athlete_documents"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))
      WITH CHECK (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_documents' AND p.policyname = 'school_staff_manage_athlete_documents';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_staff_manage_athlete_documents', 'athlete_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_staff_manage_athlete_documents', 'athlete_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_staff_manage_athlete_documents', 'athlete_documents';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_goals: 8 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_delete_own', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_delete_own" ON public."athlete_goals"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_delete_own', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_delete_own', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_delete_own', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_insert_own', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_insert_own" ON public."athlete_goals"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_insert_own', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_insert_own', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_insert_own', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_select_own', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_select_own" ON public."athlete_goals"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_select_own', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_select_own', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_select_own', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_trainer_delete', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_trainer_delete" ON public."athlete_goals"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_trainer_delete', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_trainer_delete', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_trainer_delete', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_trainer_insert', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_trainer_insert" ON public."athlete_goals"
      WITH CHECK ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_trainer_insert', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_trainer_insert', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_trainer_insert', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_trainer_select', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_trainer_select" ON public."athlete_goals"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_trainer_select', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_trainer_select', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_trainer_select', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_trainer_update', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_trainer_update" ON public."athlete_goals"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_trainer_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_trainer_update', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_trainer_update', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_trainer_update', 'athlete_goals';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_goals_update_own', 'athlete_goals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_goals_update_own" ON public."athlete_goals"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_goals' AND p.policyname = 'athlete_goals_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_goals_update_own', 'athlete_goals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_goals_update_own', 'athlete_goals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_goals_update_own', 'athlete_goals';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_id_card_templates: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_card_templates' AND p.policyname = 'card_templates_modify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'card_templates_modify', 'athlete_id_card_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "card_templates_modify" ON public."athlete_id_card_templates"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_card_templates' AND p.policyname = 'card_templates_modify';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'card_templates_modify', 'athlete_id_card_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'card_templates_modify', 'athlete_id_card_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'card_templates_modify', 'athlete_id_card_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_card_templates' AND p.policyname = 'card_templates_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'card_templates_select', 'athlete_id_card_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "card_templates_select" ON public."athlete_id_card_templates"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_card_templates' AND p.policyname = 'card_templates_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'card_templates_select', 'athlete_id_card_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'card_templates_select', 'athlete_id_card_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'card_templates_select', 'athlete_id_card_templates';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_id_cards: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_cards' AND p.policyname = 'athlete_id_cards_modify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_id_cards_modify', 'athlete_id_cards';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_id_cards_modify" ON public."athlete_id_cards"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_cards' AND p.policyname = 'athlete_id_cards_modify';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_id_cards_modify', 'athlete_id_cards';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_id_cards_modify', 'athlete_id_cards';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_id_cards_modify', 'athlete_id_cards';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_cards' AND p.policyname = 'athlete_id_cards_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_id_cards_select', 'athlete_id_cards';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id) OR (profile_id = auth.uid()) OR ((child_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_id_cards.child_id) AND (c.parent_id = auth.uid()))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_id_cards_select" ON public."athlete_id_cards"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (profile_id = (SELECT auth.uid())) OR ((child_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_id_cards.child_id) AND (c.parent_id = (SELECT auth.uid()))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_id_cards' AND p.policyname = 'athlete_id_cards_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_id_cards_select', 'athlete_id_cards';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_id_cards_select', 'athlete_id_cards';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_id_cards_select', 'athlete_id_cards';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_payment_installments: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'athlete_can_insert_installments_ap';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_can_insert_installments_ap', 'athlete_payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_can_insert_installments_ap" ON public."athlete_payment_installments"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'athlete_can_insert_installments_ap';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_can_insert_installments_ap', 'athlete_payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_can_insert_installments_ap', 'athlete_payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_can_insert_installments_ap', 'athlete_payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'athlete_sees_own_installments_ap';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_sees_own_installments_ap', 'athlete_payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_sees_own_installments_ap" ON public."athlete_payment_installments"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'athlete_sees_own_installments_ap';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_sees_own_installments_ap', 'athlete_payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_sees_own_installments_ap', 'athlete_payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_sees_own_installments_ap', 'athlete_payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'school_reviews_athlete_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_reviews_athlete_installments', 'athlete_payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_reviews_athlete_installments" ON public."athlete_payment_installments"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'school_reviews_athlete_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_reviews_athlete_installments', 'athlete_payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_reviews_athlete_installments', 'athlete_payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_reviews_athlete_installments', 'athlete_payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'school_sees_athlete_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_sees_athlete_installments', 'athlete_payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_sees_athlete_installments" ON public."athlete_payment_installments"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payment_installments' AND p.policyname = 'school_sees_athlete_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_sees_athlete_installments', 'athlete_payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_sees_athlete_installments', 'athlete_payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_sees_athlete_installments', 'athlete_payment_installments';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_payments: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'Athlete payments: update athlete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Athlete payments: update athlete', 'athlete_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Athlete payments: update athlete" ON public."athlete_payments"
      USING ((athlete_id = (SELECT auth.uid())))
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'Athlete payments: update athlete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Athlete payments: update athlete', 'athlete_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Athlete payments: update athlete', 'athlete_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Athlete payments: update athlete', 'athlete_payments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'athlete_own_payments_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_own_payments_insert', 'athlete_payments';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_own_payments_insert" ON public."athlete_payments"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'athlete_own_payments_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_own_payments_insert', 'athlete_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_own_payments_insert', 'athlete_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_own_payments_insert', 'athlete_payments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'athlete_own_payments_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_own_payments_select', 'athlete_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_own_payments_select" ON public."athlete_payments"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_payments' AND p.policyname = 'athlete_own_payments_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_own_payments_select', 'athlete_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_own_payments_select', 'athlete_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_own_payments_select', 'athlete_payments';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_reports: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_reports' AND p.policyname = 'athlete_reports_select_family';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_reports_select_family', 'athlete_reports';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((status = 'publicado'::text) AND (((subject_type = 'child'::text) AND is_parent_of_child(subject_id)) OR ((subject_type = 'profile'::text) AND (subject_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_reports_select_family" ON public."athlete_reports"
      USING (((status = 'publicado'::text) AND (((subject_type = 'child'::text) AND is_parent_of_child(subject_id)) OR ((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_reports' AND p.policyname = 'athlete_reports_select_family';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_reports_select_family', 'athlete_reports';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_reports_select_family', 'athlete_reports';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_reports_select_family', 'athlete_reports';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_stats: 9 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_delete_own', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_delete_own" ON public."athlete_stats"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_delete_own', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_delete_own', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_delete_own', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_insert_admin', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_stats.athlete_id) AND is_school_admin(c.school_id))))$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_insert_admin" ON public."athlete_stats"
      WITH CHECK ((EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = athlete_stats.athlete_id) AND (c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_insert_admin', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_insert_admin', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_insert_admin', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_insert_own', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_insert_own" ON public."athlete_stats"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_insert_own', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_insert_own', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_insert_own', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_select', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((athlete_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM ((team_members tm
     JOIN teams t ON ((t.id = tm.team_id)))
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((tm.profile_id = athlete_stats.athlete_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_select" ON public."athlete_stats"
      USING (((athlete_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM ((team_members tm
     JOIN teams t ON ((t.id = tm.team_id)))
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((tm.profile_id = athlete_stats.athlete_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_select', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_select', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_select', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_trainer_delete', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_trainer_delete" ON public."athlete_stats"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_trainer_delete', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_trainer_delete', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_trainer_delete', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_trainer_insert', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_trainer_insert" ON public."athlete_stats"
      WITH CHECK ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_trainer_insert', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_trainer_insert', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_trainer_insert', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_trainer_select', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_trainer_select" ON public."athlete_stats"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_trainer_select', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_trainer_select', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_trainer_select', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_trainer_update', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_trainer_update" ON public."athlete_stats"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_trainer_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_trainer_update', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_trainer_update', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_trainer_update', 'athlete_stats';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_stats_update_own', 'athlete_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_stats_update_own" ON public."athlete_stats"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_stats' AND p.policyname = 'athlete_stats_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_stats_update_own', 'athlete_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_stats_update_own', 'athlete_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_stats_update_own', 'athlete_stats';
  END IF;
END
$lote2$;
COMMIT;

-- athlete_training_plans: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_training_plans' AND p.policyname = 'atp_client_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'atp_client_select', 'athlete_training_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((client_id = auth.uid()) AND (status <> 'draft'::text))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "atp_client_select" ON public."athlete_training_plans"
      USING (((client_id = (SELECT auth.uid())) AND (status <> 'draft'::text)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_training_plans' AND p.policyname = 'atp_client_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'atp_client_select', 'athlete_training_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'atp_client_select', 'athlete_training_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'atp_client_select', 'athlete_training_plans';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_training_plans' AND p.policyname = 'atp_parent_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'atp_parent_select', 'athlete_training_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid()))) AND (status <> 'draft'::text))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "atp_parent_select" ON public."athlete_training_plans"
      USING (((client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))) AND (status <> 'draft'::text)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'athlete_training_plans' AND p.policyname = 'atp_parent_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'atp_parent_select', 'athlete_training_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'atp_parent_select', 'athlete_training_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'atp_parent_select', 'athlete_training_plans';
  END IF;
END
$lote2$;
COMMIT;

-- attendance: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance' AND p.policyname = 'attendance_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'attendance_admin_all', 'attendance';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = attendance.child_id) AND is_school_admin(children.school_id))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = attendance.child_id) AND is_school_admin(children.school_id))))$o$ THEN
    EXECUTE $a$ALTER POLICY "attendance_admin_all" ON public."attendance"
      USING ((EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = attendance.child_id) AND (children.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM children
  WHERE ((children.id = attendance.child_id) AND (children.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance' AND p.policyname = 'attendance_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'attendance_admin_all', 'attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'attendance_admin_all', 'attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'attendance_admin_all', 'attendance';
  END IF;
END
$lote2$;
COMMIT;

-- attendance_polls: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'admin can insert polls';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'admin can insert polls', 'attendance_polls';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "admin can insert polls" ON public."attendance_polls"
      WITH CHECK ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'admin can insert polls';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'admin can insert polls', 'attendance_polls';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'admin can insert polls', 'attendance_polls';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'admin can insert polls', 'attendance_polls';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'admin can update polls';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'admin can update polls', 'attendance_polls';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "admin can update polls" ON public."attendance_polls"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'admin can update polls';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'admin can update polls', 'attendance_polls';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'admin can update polls', 'attendance_polls';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'admin can update polls', 'attendance_polls';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'school members can view polls';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school members can view polls', 'attendance_polls';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school members can view polls" ON public."attendance_polls"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = attendance_polls.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_polls' AND p.policyname = 'school members can view polls';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school members can view polls', 'attendance_polls';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school members can view polls', 'attendance_polls';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school members can view polls', 'attendance_polls';
  END IF;
END
$lote2$;
COMMIT;

-- attendance_sessions: 7 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Admins can manage all sessions';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Admins can manage all sessions', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Admins can manage all sessions" ON public."attendance_sessions"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Admins can manage all sessions';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Admins can manage all sessions', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Admins can manage all sessions', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Admins can manage all sessions', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Athletes can view bookable sessions of their enrollments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Athletes can view bookable sessions of their enrollments', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(((offering_id IS NOT NULL) AND (offering_id IN ( SELECT op.offering_id
   FROM (enrollments e
     JOIN offering_plans op ON ((op.id = e.offering_plan_id)))
  WHERE ((e.user_id = auth.uid()) AND (e.status = 'active'::text) AND (op.offering_id IS NOT NULL))))) OR ((team_id IS NOT NULL) AND (offering_id IS NULL) AND (team_id IN ( SELECT e.team_id
   FROM enrollments e
  WHERE ((e.user_id = auth.uid()) AND (e.status = 'active'::text) AND (e.team_id IS NOT NULL) AND (e.offering_plan_id IS NULL))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Athletes can view bookable sessions of their enrollments" ON public."attendance_sessions"
      USING ((((offering_id IS NOT NULL) AND (offering_id IN ( SELECT op.offering_id
   FROM (enrollments e
     JOIN offering_plans op ON ((op.id = e.offering_plan_id)))
  WHERE ((e.user_id = (SELECT auth.uid())) AND (e.status = 'active'::text) AND (op.offering_id IS NOT NULL))))) OR ((team_id IS NOT NULL) AND (offering_id IS NULL) AND (team_id IN ( SELECT e.team_id
   FROM enrollments e
  WHERE ((e.user_id = (SELECT auth.uid())) AND (e.status = 'active'::text) AND (e.team_id IS NOT NULL) AND (e.offering_plan_id IS NULL)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Athletes can view bookable sessions of their enrollments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Athletes can view bookable sessions of their enrollments', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Athletes can view bookable sessions of their enrollments', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Athletes can view bookable sessions of their enrollments', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: manage staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Attendance sessions: manage staff', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (( SELECT user_staff_school_ids() AS user_staff_school_ids)::uuid[]))$o$ THEN
    EXECUTE $a$ALTER POLICY "Attendance sessions: manage staff" ON public."attendance_sessions"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: manage staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Attendance sessions: manage staff', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Attendance sessions: manage staff', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Attendance sessions: manage staff', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: select parent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Attendance sessions: select parent', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(team_id IN ( SELECT e.team_id
   FROM (enrollments e
     JOIN children c ON ((c.id = e.child_id)))
  WHERE ((c.parent_id = auth.uid()) AND (e.team_id IS NOT NULL))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Attendance sessions: select parent" ON public."attendance_sessions"
      USING ((team_id IN ( SELECT e.team_id
   FROM (enrollments e
     JOIN children c ON ((c.id = e.child_id)))
  WHERE ((c.parent_id = (SELECT auth.uid())) AND (e.team_id IS NOT NULL)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: select parent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Attendance sessions: select parent', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Attendance sessions: select parent', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Attendance sessions: select parent', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: select staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Attendance sessions: select staff', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Attendance sessions: select staff" ON public."attendance_sessions"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Attendance sessions: select staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Attendance sessions: select staff', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Attendance sessions: select staff', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Attendance sessions: select staff', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Coaches can manage their sessions';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can manage their sessions', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can manage their sessions" ON public."attendance_sessions"
      USING ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid())))))
      WITH CHECK ((team_id IN ( SELECT teams.id
   FROM teams
  WHERE (teams.coach_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Coaches can manage their sessions';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can manage their sessions', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can manage their sessions', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can manage their sessions', 'attendance_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Parents can view sessions of their children';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Parents can view sessions of their children', 'attendance_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(team_id IN ( SELECT e.team_id
   FROM (enrollments e
     JOIN children c ON ((c.id = e.child_id)))
  WHERE (c.parent_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Parents can view sessions of their children" ON public."attendance_sessions"
      USING ((team_id IN ( SELECT e.team_id
   FROM (enrollments e
     JOIN children c ON ((c.id = e.child_id)))
  WHERE (c.parent_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sessions' AND p.policyname = 'Parents can view sessions of their children';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Parents can view sessions of their children', 'attendance_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Parents can view sessions of their children', 'attendance_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Parents can view sessions of their children', 'attendance_sessions';
  END IF;
END
$lote2$;
COMMIT;

-- attendance_sheet_intake: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sheet_intake' AND p.policyname = 'att_sheet_staff_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'att_sheet_staff_select', 'attendance_sheet_intake';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "att_sheet_staff_select" ON public."attendance_sheet_intake"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'attendance_sheet_intake' AND p.policyname = 'att_sheet_staff_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'att_sheet_staff_select', 'attendance_sheet_intake';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'att_sheet_staff_select', 'attendance_sheet_intake';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'att_sheet_staff_select', 'attendance_sheet_intake';
  END IF;
END
$lote2$;
COMMIT;

-- audit_logs: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs' AND p.policyname = 'audit_logs_platform_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'audit_logs_platform_admin_select', 'audit_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "audit_logs_platform_admin_select" ON public."audit_logs"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'audit_logs' AND p.policyname = 'audit_logs_platform_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'audit_logs_platform_admin_select', 'audit_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'audit_logs_platform_admin_select', 'audit_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'audit_logs_platform_admin_select', 'audit_logs';
  END IF;
END
$lote2$;
COMMIT;

-- bank_email_inboxes: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_email_inboxes' AND p.policyname = 'bank_email_inboxes_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'bank_email_inboxes_select_admin', 'bank_email_inboxes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "bank_email_inboxes_select_admin" ON public."bank_email_inboxes"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_email_inboxes' AND p.policyname = 'bank_email_inboxes_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'bank_email_inboxes_select_admin', 'bank_email_inboxes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'bank_email_inboxes_select_admin', 'bank_email_inboxes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'bank_email_inboxes_select_admin', 'bank_email_inboxes';
  END IF;
END
$lote2$;
COMMIT;

-- bank_email_notices: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_email_notices' AND p.policyname = 'bank_email_notices_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'bank_email_notices_select_staff', 'bank_email_notices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "bank_email_notices_select_staff" ON public."bank_email_notices"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_email_notices' AND p.policyname = 'bank_email_notices_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'bank_email_notices_select_staff', 'bank_email_notices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'bank_email_notices_select_staff', 'bank_email_notices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'bank_email_notices_select_staff', 'bank_email_notices';
  END IF;
END
$lote2$;
COMMIT;

-- bank_statement_lines: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_statement_lines' AND p.policyname = 'bank_statement_lines_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'bank_statement_lines_select_admin', 'bank_statement_lines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "bank_statement_lines_select_admin" ON public."bank_statement_lines"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_statement_lines' AND p.policyname = 'bank_statement_lines_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'bank_statement_lines_select_admin', 'bank_statement_lines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'bank_statement_lines_select_admin', 'bank_statement_lines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'bank_statement_lines_select_admin', 'bank_statement_lines';
  END IF;
END
$lote2$;
COMMIT;

-- bank_statements: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_statements' AND p.policyname = 'bank_statements_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'bank_statements_select_admin', 'bank_statements';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "bank_statements_select_admin" ON public."bank_statements"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bank_statements' AND p.policyname = 'bank_statements_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'bank_statements_select_admin', 'bank_statements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'bank_statements_select_admin', 'bank_statements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'bank_statements_select_admin', 'bank_statements';
  END IF;
END
$lote2$;
COMMIT;

-- billing_events: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'billing_events_insert_admin', 'billing_events';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "billing_events_insert_admin" ON public."billing_events"
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'billing_events_insert_admin', 'billing_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'billing_events_insert_admin', 'billing_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'billing_events_insert_admin', 'billing_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'billing_events_select', 'billing_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR (enrollment_id IN ( SELECT e.id
   FROM enrollments e
  WHERE ((e.user_id = auth.uid()) OR (e.child_id IN ( SELECT c.id
           FROM children c
          WHERE (c.parent_id = auth.uid())))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "billing_events_select" ON public."billing_events"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (enrollment_id IN ( SELECT e.id
   FROM enrollments e
  WHERE ((e.user_id = (SELECT auth.uid())) OR (e.child_id IN ( SELECT c.id
           FROM children c
          WHERE (c.parent_id = (SELECT auth.uid())))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'billing_events_select', 'billing_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'billing_events_select', 'billing_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'billing_events_select', 'billing_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_update_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'billing_events_update_admin', 'billing_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "billing_events_update_admin" ON public."billing_events"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'billing_events' AND p.policyname = 'billing_events_update_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'billing_events_update_admin', 'billing_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'billing_events_update_admin', 'billing_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'billing_events_update_admin', 'billing_events';
  END IF;
END
$lote2$;
COMMIT;

-- biomech_access_grants: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_access_grants' AND p.policyname = 'bag_coach_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'bag_coach_read', 'biomech_access_grants';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "bag_coach_read" ON public."biomech_access_grants"
      USING ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_access_grants' AND p.policyname = 'bag_coach_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'bag_coach_read', 'biomech_access_grants';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'bag_coach_read', 'biomech_access_grants';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'bag_coach_read', 'biomech_access_grants';
  END IF;
END
$lote2$;
COMMIT;

-- biomech_analyses: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_analyses' AND p.policyname = 'ba_athlete_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ba_athlete_insert', 'biomech_analyses';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_analyses.capture_id) AND (bc.athlete_id = auth.uid()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "ba_athlete_insert" ON public."biomech_analyses"
      WITH CHECK ((EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_analyses.capture_id) AND (bc.athlete_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_analyses' AND p.policyname = 'ba_athlete_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ba_athlete_insert', 'biomech_analyses';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ba_athlete_insert', 'biomech_analyses';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ba_athlete_insert', 'biomech_analyses';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_analyses' AND p.policyname = 'ba_athlete_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ba_athlete_read', 'biomech_analyses';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_analyses.capture_id) AND (bc.athlete_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ba_athlete_read" ON public."biomech_analyses"
      USING ((EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_analyses.capture_id) AND (bc.athlete_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_analyses' AND p.policyname = 'ba_athlete_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ba_athlete_read', 'biomech_analyses';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ba_athlete_read', 'biomech_analyses';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ba_athlete_read', 'biomech_analyses';
  END IF;
END
$lote2$;
COMMIT;

-- biomech_annotations: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_athlete_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ban_athlete_read', 'biomech_annotations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_annotations.capture_id) AND (bc.athlete_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ban_athlete_read" ON public."biomech_annotations"
      USING ((EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = biomech_annotations.capture_id) AND (bc.athlete_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_athlete_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ban_athlete_read', 'biomech_annotations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ban_athlete_read', 'biomech_annotations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ban_athlete_read', 'biomech_annotations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ban_coach_delete', 'biomech_annotations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ban_coach_delete" ON public."biomech_annotations"
      USING ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ban_coach_delete', 'biomech_annotations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ban_coach_delete', 'biomech_annotations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ban_coach_delete', 'biomech_annotations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ban_coach_insert', 'biomech_annotations';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "ban_coach_insert" ON public."biomech_annotations"
      WITH CHECK ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ban_coach_insert', 'biomech_annotations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ban_coach_insert', 'biomech_annotations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ban_coach_insert', 'biomech_annotations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ban_coach_read', 'biomech_annotations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ban_coach_read" ON public."biomech_annotations"
      USING ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ban_coach_read', 'biomech_annotations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ban_coach_read', 'biomech_annotations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ban_coach_read', 'biomech_annotations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ban_coach_update', 'biomech_annotations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ban_coach_update" ON public."biomech_annotations"
      USING ((coach_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'biomech_annotations' AND p.policyname = 'ban_coach_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ban_coach_update', 'biomech_annotations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ban_coach_update', 'biomech_annotations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ban_coach_update', 'biomech_annotations';
  END IF;
END
$lote2$;
COMMIT;

-- body_metrics: 7 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_delete_own', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(recorded_by = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "body_metrics_delete_own" ON public."body_metrics"
      USING ((recorded_by = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_delete_own', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_delete_own', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_delete_own', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_insert_own', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((client_id = auth.uid()) AND (source = 'self'::text))$o$ THEN
    EXECUTE $a$ALTER POLICY "body_metrics_insert_own" ON public."body_metrics"
      WITH CHECK (((client_id = (SELECT auth.uid())) AND (source = 'self'::text)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_insert_own', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_insert_own', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_insert_own', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_insert_trainer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_insert_trainer', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((source = 'trainer'::text) AND (school_id = get_personal_trainer_school_id(auth.uid())) AND (client_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids)))$o$ THEN
    EXECUTE $a$ALTER POLICY "body_metrics_insert_trainer" ON public."body_metrics"
      WITH CHECK (((source = 'trainer'::text) AND (school_id = get_personal_trainer_school_id((SELECT auth.uid()))) AND (client_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_insert_trainer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_insert_trainer', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_insert_trainer', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_insert_trainer', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_select_own', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(client_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "body_metrics_select_own" ON public."body_metrics"
      USING ((client_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_select_own', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_select_own', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_select_own', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_parent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_select_parent', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "body_metrics_select_parent" ON public."body_metrics"
      USING ((client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_parent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_select_parent', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_select_parent', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_select_parent', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_trainer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_select_trainer', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(client_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "body_metrics_select_trainer" ON public."body_metrics"
      USING ((client_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_select_trainer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_select_trainer', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_select_trainer', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_select_trainer', 'body_metrics';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'body_metrics_update_own', 'body_metrics';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(recorded_by = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "body_metrics_update_own" ON public."body_metrics"
      USING ((recorded_by = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'body_metrics' AND p.policyname = 'body_metrics_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'body_metrics_update_own', 'body_metrics';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'body_metrics_update_own', 'body_metrics';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'body_metrics_update_own', 'body_metrics';
  END IF;
END
$lote2$;
COMMIT;

-- booking_holds: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'booking_holds' AND p.policyname = 'booking_holds_staff_lectura';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'booking_holds_staff_lectura', 'booking_holds';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_availability sa
  WHERE ((sa.id = booking_holds.availability_slot_id) AND (sa.school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "booking_holds_staff_lectura" ON public."booking_holds"
      USING ((EXISTS ( SELECT 1
   FROM school_availability sa
  WHERE ((sa.id = booking_holds.availability_slot_id) AND (sa.school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'booking_holds' AND p.policyname = 'booking_holds_staff_lectura';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'booking_holds_staff_lectura', 'booking_holds';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'booking_holds_staff_lectura', 'booking_holds';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'booking_holds_staff_lectura', 'booking_holds';
  END IF;
END
$lote2$;
COMMIT;

-- bookings: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_own_bookings_insert', 'bookings';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_own_bookings_insert" ON public."bookings"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_own_bookings_insert', 'bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_own_bookings_insert', 'bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_own_bookings_insert', 'bookings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_own_bookings_select', 'bookings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_own_bookings_select" ON public."bookings"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_own_bookings_select', 'bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_own_bookings_select', 'bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_own_bookings_select', 'bookings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_own_bookings_update', 'bookings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_own_bookings_update" ON public."bookings"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'bookings' AND p.policyname = 'athlete_own_bookings_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_own_bookings_update', 'bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_own_bookings_update', 'bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_own_bookings_update', 'bookings';
  END IF;
END
$lote2$;
COMMIT;

-- branding_change_log: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'branding_change_log' AND p.policyname = 'branding_log_school_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'branding_log_school_admin_select', 'branding_change_log';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "branding_log_school_admin_select" ON public."branding_change_log"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'branding_change_log' AND p.policyname = 'branding_log_school_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'branding_log_school_admin_select', 'branding_change_log';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'branding_log_school_admin_select', 'branding_change_log';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'branding_log_school_admin_select', 'branding_change_log';
  END IF;
END
$lote2$;
COMMIT;

-- cancellation_policies: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cancellation_policies_delete', 'cancellation_policies';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "cancellation_policies_delete" ON public."cancellation_policies"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cancellation_policies_delete', 'cancellation_policies';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cancellation_policies_delete', 'cancellation_policies';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cancellation_policies_delete', 'cancellation_policies';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cancellation_policies_insert', 'cancellation_policies';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "cancellation_policies_insert" ON public."cancellation_policies"
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cancellation_policies_insert', 'cancellation_policies';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cancellation_policies_insert', 'cancellation_policies';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cancellation_policies_insert', 'cancellation_policies';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cancellation_policies_select', 'cancellation_policies';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "cancellation_policies_select" ON public."cancellation_policies"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cancellation_policies_select', 'cancellation_policies';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cancellation_policies_select', 'cancellation_policies';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cancellation_policies_select', 'cancellation_policies';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cancellation_policies_update', 'cancellation_policies';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "cancellation_policies_update" ON public."cancellation_policies"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cancellation_policies' AND p.policyname = 'cancellation_policies_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cancellation_policies_update', 'cancellation_policies';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cancellation_policies_update', 'cancellation_policies';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cancellation_policies_update', 'cancellation_policies';
  END IF;
END
$lote2$;
COMMIT;

-- carts: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'carts_delete_own', 'carts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "carts_delete_own" ON public."carts"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'carts_delete_own', 'carts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'carts_delete_own', 'carts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'carts_delete_own', 'carts';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'carts_insert_own', 'carts';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "carts_insert_own" ON public."carts"
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'carts_insert_own', 'carts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'carts_insert_own', 'carts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'carts_insert_own', 'carts';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'carts_select_own', 'carts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "carts_select_own" ON public."carts"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'carts_select_own', 'carts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'carts_select_own', 'carts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'carts_select_own', 'carts';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'carts_update_own', 'carts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "carts_update_own" ON public."carts"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'carts' AND p.policyname = 'carts_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'carts_update_own', 'carts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'carts_update_own', 'carts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'carts_update_own', 'carts';
  END IF;
END
$lote2$;
COMMIT;

-- cash_session_entries: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cash_session_entries' AND p.policyname = 'school members can view cash entries';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school members can view cash entries', 'cash_session_entries';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'reporter'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school members can view cash entries" ON public."cash_session_entries"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'reporter'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cash_session_entries' AND p.policyname = 'school members can view cash entries';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school members can view cash entries', 'cash_session_entries';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school members can view cash entries', 'cash_session_entries';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school members can view cash entries', 'cash_session_entries';
  END IF;
END
$lote2$;
COMMIT;

-- cash_sessions: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cash_sessions' AND p.policyname = 'school members can view cash sessions';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school members can view cash sessions', 'cash_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'reporter'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school members can view cash sessions" ON public."cash_sessions"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'reporter'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'cash_sessions' AND p.policyname = 'school members can view cash sessions';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school members can view cash sessions', 'cash_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school members can view cash sessions', 'cash_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school members can view cash sessions', 'cash_sessions';
  END IF;
END
$lote2$;
COMMIT;

-- children_stats: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'children_stats' AND p.policyname = 'parent_read_children_stats';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'parent_read_children_stats', 'children_stats';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = children_stats.child_id) AND (c.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "parent_read_children_stats" ON public."children_stats"
      USING ((EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = children_stats.child_id) AND (c.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'children_stats' AND p.policyname = 'parent_read_children_stats';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'parent_read_children_stats', 'children_stats';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'parent_read_children_stats', 'children_stats';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'parent_read_children_stats', 'children_stats';
  END IF;
END
$lote2$;
COMMIT;

-- class_enrollments: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_manage_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'class_enrollments_manage_admin', 'class_enrollments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND is_school_admin(c.school_id))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND is_school_admin(c.school_id))))$o$ THEN
    EXECUTE $a$ALTER POLICY "class_enrollments_manage_admin" ON public."class_enrollments"
      USING ((EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND (c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND (c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_manage_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'class_enrollments_manage_admin', 'class_enrollments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'class_enrollments_manage_admin', 'class_enrollments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'class_enrollments_manage_admin', 'class_enrollments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'class_enrollments_select_own', 'class_enrollments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = class_enrollments.enrollment_id) AND ((e.user_id = auth.uid()) OR (e.child_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = auth.uid())))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "class_enrollments_select_own" ON public."class_enrollments"
      USING ((EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = class_enrollments.enrollment_id) AND ((e.user_id = (SELECT auth.uid())) OR (e.child_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = (SELECT auth.uid())))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'class_enrollments_select_own', 'class_enrollments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'class_enrollments_select_own', 'class_enrollments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'class_enrollments_select_own', 'class_enrollments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'class_enrollments_select_staff', 'class_enrollments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND (is_school_admin(c.school_id) OR is_school_coach(c.school_id)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "class_enrollments_select_staff" ON public."class_enrollments"
      USING ((EXISTS ( SELECT 1
   FROM classes c
  WHERE ((c.id = class_enrollments.class_id) AND ((c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(c.school_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'class_enrollments' AND p.policyname = 'class_enrollments_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'class_enrollments_select_staff', 'class_enrollments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'class_enrollments_select_staff', 'class_enrollments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'class_enrollments_select_staff', 'class_enrollments';
  END IF;
END
$lote2$;
COMMIT;

-- classes: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'classes_admin_all', 'classes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "classes_admin_all" ON public."classes"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'classes_admin_all', 'classes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'classes_admin_all', 'classes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'classes_admin_all', 'classes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'classes_delete', 'classes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "classes_delete" ON public."classes"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'classes_delete', 'classes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'classes_delete', 'classes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'classes_delete', 'classes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'classes_insert', 'classes';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "classes_insert" ON public."classes"
      WITH CHECK (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'classes_insert', 'classes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'classes_insert', 'classes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'classes_insert', 'classes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'classes_select', 'classes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text)))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "classes_select" ON public."classes"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'classes_select', 'classes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'classes_select', 'classes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'classes_select', 'classes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'classes_update', 'classes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((coach_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "classes_update" ON public."classes"
      USING (((coach_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = classes.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'classes' AND p.policyname = 'classes_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'classes_update', 'classes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'classes_update', 'classes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'classes_update', 'classes';
  END IF;
END
$lote2$;
COMMIT;

-- coach_availability: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_availability' AND p.policyname = 'coach_availability_trainer_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coach_availability_trainer_all', 'coach_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = get_personal_trainer_school_id(auth.uid()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = get_personal_trainer_school_id(auth.uid()))$o$ THEN
    EXECUTE $a$ALTER POLICY "coach_availability_trainer_all" ON public."coach_availability"
      USING ((school_id = get_personal_trainer_school_id((SELECT auth.uid()))))
      WITH CHECK ((school_id = get_personal_trainer_school_id((SELECT auth.uid()))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_availability' AND p.policyname = 'coach_availability_trainer_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coach_availability_trainer_all', 'coach_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coach_availability_trainer_all', 'coach_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coach_availability_trainer_all', 'coach_availability';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_availability' AND p.policyname = 'school_admin_can_manage_coach_availability';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_admin_can_manage_coach_availability', 'coach_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "school_admin_can_manage_coach_availability" ON public."coach_availability"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_availability' AND p.policyname = 'school_admin_can_manage_coach_availability';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_admin_can_manage_coach_availability', 'coach_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_admin_can_manage_coach_availability', 'coach_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_admin_can_manage_coach_availability', 'coach_availability';
  END IF;
END
$lote2$;
COMMIT;

-- coach_certifications: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can delete their own certifications';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can delete their own certifications', 'coach_certifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = coach_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Coaches can delete their own certifications" ON public."coach_certifications"
      USING (((SELECT auth.uid()) = coach_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can delete their own certifications';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can delete their own certifications', 'coach_certifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can delete their own certifications', 'coach_certifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can delete their own certifications', 'coach_certifications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can insert their own certifications';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can insert their own certifications', 'coach_certifications';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = coach_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can insert their own certifications" ON public."coach_certifications"
      WITH CHECK (((SELECT auth.uid()) = coach_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can insert their own certifications';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can insert their own certifications', 'coach_certifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can insert their own certifications', 'coach_certifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can insert their own certifications', 'coach_certifications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can update their own certifications';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can update their own certifications', 'coach_certifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = coach_id)$o$
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = coach_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can update their own certifications" ON public."coach_certifications"
      USING (((SELECT auth.uid()) = coach_id))
      WITH CHECK (((SELECT auth.uid()) = coach_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can update their own certifications';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can update their own certifications', 'coach_certifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can update their own certifications', 'coach_certifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can update their own certifications', 'coach_certifications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can view their own certifications';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can view their own certifications', 'coach_certifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = coach_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Coaches can view their own certifications" ON public."coach_certifications"
      USING (((SELECT auth.uid()) = coach_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_certifications' AND p.policyname = 'Coaches can view their own certifications';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can view their own certifications', 'coach_certifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can view their own certifications', 'coach_certifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can view their own certifications', 'coach_certifications';
  END IF;
END
$lote2$;
COMMIT;

-- coach_profiles: 7 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can insert their own profile';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can insert their own profile', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can insert their own profile" ON public."coach_profiles"
      WITH CHECK (((SELECT auth.uid()) = id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can insert their own profile';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can insert their own profile', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can insert their own profile', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can insert their own profile', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can manage own profile';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can manage own profile', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can manage own profile" ON public."coach_profiles"
      USING (((SELECT auth.uid()) = id))
      WITH CHECK (((SELECT auth.uid()) = id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can manage own profile';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can manage own profile', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can manage own profile', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can manage own profile', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can update their own profile';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can update their own profile', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Coaches can update their own profile" ON public."coach_profiles"
      USING (((SELECT auth.uid()) = id))
      WITH CHECK (((SELECT auth.uid()) = id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can update their own profile';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can update their own profile', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can update their own profile', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can update their own profile', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can view their own profile';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Coaches can view their own profile', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Coaches can view their own profile" ON public."coach_profiles"
      USING (((SELECT auth.uid()) = id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'Coaches can view their own profile';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Coaches can view their own profile', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Coaches can view their own profile', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Coaches can view their own profile', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'School admins can view coaches';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School admins can view coaches', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School admins can view coaches" ON public."coach_profiles"
      USING ((EXISTS ( SELECT 1
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'School admins can view coaches';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School admins can view coaches', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School admins can view coaches', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School admins can view coaches', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'coach_profiles_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coach_profiles_admin_all', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$( SELECT is_platform_admin() AS is_platform_admin)$o$ THEN
    EXECUTE $a$ALTER POLICY "coach_profiles_admin_all" ON public."coach_profiles"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'coach_profiles_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coach_profiles_admin_all', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coach_profiles_admin_all', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coach_profiles_admin_all', 'coach_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'coach_profiles_self_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coach_profiles_self_all', 'coach_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(id = ( SELECT auth.uid() AS uid))$o$ THEN
    EXECUTE $a$ALTER POLICY "coach_profiles_self_all" ON public."coach_profiles"
      USING ((id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'coach_profiles' AND p.policyname = 'coach_profiles_self_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coach_profiles_self_all', 'coach_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coach_profiles_self_all', 'coach_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coach_profiles_self_all', 'coach_profiles';
  END IF;
END
$lote2$;
COMMIT;

-- competition_results: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_delete_school_only';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'competition_results_delete_school_only', 'competition_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "competition_results_delete_school_only" ON public."competition_results"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_delete_school_only';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'competition_results_delete_school_only', 'competition_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'competition_results_delete_school_only', 'competition_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'competition_results_delete_school_only', 'competition_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_insert_school_or_self';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'competition_results_insert_school_or_self', 'competition_results';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR ((subject_type = 'profile'::text) AND (subject_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "competition_results_insert_school_or_self" ON public."competition_results"
      WITH CHECK (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR ((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_insert_school_or_self';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'competition_results_insert_school_or_self', 'competition_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'competition_results_insert_school_or_self', 'competition_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'competition_results_insert_school_or_self', 'competition_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'competition_results_select_own', 'competition_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(((subject_type = 'profile'::text) AND (subject_id = auth.uid())) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id)) OR (school_id = ANY (user_school_ids())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "competition_results_select_own" ON public."competition_results"
      USING ((((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid()))) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id)) OR (school_id = ANY ((SELECT public.user_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'competition_results_select_own', 'competition_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'competition_results_select_own', 'competition_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'competition_results_select_own', 'competition_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_update_school_or_recorder';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'competition_results_update_school_or_recorder', 'competition_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (recorded_by = auth.uid()))$o$
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (recorded_by = auth.uid()))$o$ THEN
    EXECUTE $a$ALTER POLICY "competition_results_update_school_or_recorder" ON public."competition_results"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (recorded_by = (SELECT auth.uid()))))
      WITH CHECK (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (recorded_by = (SELECT auth.uid()))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'competition_results' AND p.policyname = 'competition_results_update_school_or_recorder';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'competition_results_update_school_or_recorder', 'competition_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'competition_results_update_school_or_recorder', 'competition_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'competition_results_update_school_or_recorder', 'competition_results';
  END IF;
END
$lote2$;
COMMIT;

-- contact_messages: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'contact_messages_delete', 'contact_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "contact_messages_delete" ON public."contact_messages"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'contact_messages_delete', 'contact_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'contact_messages_delete', 'contact_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'contact_messages_delete', 'contact_messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'contact_messages_select', 'contact_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((assigned_to = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "contact_messages_select" ON public."contact_messages"
      USING (((assigned_to = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'contact_messages_select', 'contact_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'contact_messages_select', 'contact_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'contact_messages_select', 'contact_messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'contact_messages_update', 'contact_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((assigned_to = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "contact_messages_update" ON public."contact_messages"
      USING (((assigned_to = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'contact_messages' AND p.policyname = 'contact_messages_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'contact_messages_update', 'contact_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'contact_messages_update', 'contact_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'contact_messages_update', 'contact_messages';
  END IF;
END
$lote2$;
COMMIT;

-- demo_links: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'demo_links' AND p.policyname = 'platform admins manage demo links';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'platform admins manage demo links', 'demo_links';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM platform_admins
  WHERE (platform_admins.profile_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM platform_admins
  WHERE (platform_admins.profile_id = ( SELECT auth.uid() AS uid))))$o$ THEN
    EXECUTE $a$ALTER POLICY "platform admins manage demo links" ON public."demo_links"
      USING ((EXISTS ( SELECT 1
   FROM platform_admins
  WHERE (platform_admins.profile_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'demo_links' AND p.policyname = 'platform admins manage demo links';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'platform admins manage demo links', 'demo_links';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'platform admins manage demo links', 'demo_links';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'platform admins manage demo links', 'demo_links';
  END IF;
END
$lote2$;
COMMIT;

-- device_commands: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'device_commands' AND p.policyname = 'School members can view device commands';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School members can view device commands', 'device_commands';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School members can view device commands" ON public."device_commands"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'device_commands' AND p.policyname = 'School members can view device commands';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School members can view device commands', 'device_commands';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School members can view device commands', 'device_commands';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School members can view device commands', 'device_commands';
  END IF;
END
$lote2$;
COMMIT;

-- electronic_invoice_items: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoice_items' AND p.policyname = 'einvoice_items_order_buyer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'einvoice_items_order_buyer', 'electronic_invoice_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (electronic_invoices i
     JOIN orders o ON ((o.id = i.order_id)))
  WHERE ((i.id = electronic_invoice_items.invoice_id) AND (o.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "einvoice_items_order_buyer" ON public."electronic_invoice_items"
      USING ((EXISTS ( SELECT 1
   FROM (electronic_invoices i
     JOIN orders o ON ((o.id = i.order_id)))
  WHERE ((i.id = electronic_invoice_items.invoice_id) AND (o.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoice_items' AND p.policyname = 'einvoice_items_order_buyer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'einvoice_items_order_buyer', 'electronic_invoice_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'einvoice_items_order_buyer', 'electronic_invoice_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'einvoice_items_order_buyer', 'electronic_invoice_items';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoice_items' AND p.policyname = 'einvoice_items_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'einvoice_items_read', 'electronic_invoice_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM electronic_invoices i
  WHERE ((i.id = electronic_invoice_items.invoice_id) AND (can_manage_finances(i.owner_type, i.owner_id) OR (EXISTS ( SELECT 1
           FROM payments p
          WHERE ((p.id = i.payment_id) AND (p.parent_id = auth.uid()))))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "einvoice_items_read" ON public."electronic_invoice_items"
      USING ((EXISTS ( SELECT 1
   FROM electronic_invoices i
  WHERE ((i.id = electronic_invoice_items.invoice_id) AND (can_manage_finances(i.owner_type, i.owner_id) OR (EXISTS ( SELECT 1
           FROM payments p
          WHERE ((p.id = i.payment_id) AND (p.parent_id = (SELECT auth.uid()))))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoice_items' AND p.policyname = 'einvoice_items_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'einvoice_items_read', 'electronic_invoice_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'einvoice_items_read', 'electronic_invoice_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'einvoice_items_read', 'electronic_invoice_items';
  END IF;
END
$lote2$;
COMMIT;

-- electronic_invoices: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoices' AND p.policyname = 'einvoices_payer_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'einvoices_payer_read', 'electronic_invoices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = electronic_invoices.payment_id) AND (p.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "einvoices_payer_read" ON public."electronic_invoices"
      USING ((EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = electronic_invoices.payment_id) AND (p.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'electronic_invoices' AND p.policyname = 'einvoices_payer_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'einvoices_payer_read', 'electronic_invoices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'einvoices_payer_read', 'electronic_invoices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'einvoices_payer_read', 'electronic_invoices';
  END IF;
END
$lote2$;
COMMIT;

-- email_sends: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'email_sends' AND p.policyname = 'School admins read their email log';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School admins read their email log', 'email_sends';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR ((school_id IS NOT NULL) AND is_school_admin_of(school_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School admins read their email log" ON public."email_sends"
      USING (((SELECT public.is_super_admin()) OR ((school_id IS NOT NULL) AND is_school_admin_of(school_id))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'email_sends' AND p.policyname = 'School admins read their email log';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School admins read their email log', 'email_sends';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School admins read their email log', 'email_sends';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School admins read their email log', 'email_sends';
  END IF;
END
$lote2$;
COMMIT;

-- enrollment_categories: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_categories' AND p.policyname = 'enrollment_categories_manage_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'enrollment_categories_manage_staff', 'enrollment_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "enrollment_categories_manage_staff" ON public."enrollment_categories"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_categories' AND p.policyname = 'enrollment_categories_manage_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'enrollment_categories_manage_staff', 'enrollment_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'enrollment_categories_manage_staff', 'enrollment_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'enrollment_categories_manage_staff', 'enrollment_categories';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_categories' AND p.policyname = 'enrollment_categories_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'enrollment_categories_select', 'enrollment_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_school_coach(school_id) OR can_view_enrollment(enrollment_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "enrollment_categories_select" ON public."enrollment_categories"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(school_id) OR can_view_enrollment(enrollment_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_categories' AND p.policyname = 'enrollment_categories_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'enrollment_categories_select', 'enrollment_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'enrollment_categories_select', 'enrollment_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'enrollment_categories_select', 'enrollment_categories';
  END IF;
END
$lote2$;
COMMIT;

-- enrollment_form_intake: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_form_intake' AND p.policyname = 'enrollment_intake_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'enrollment_intake_admin_select', 'enrollment_form_intake';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "enrollment_intake_admin_select" ON public."enrollment_form_intake"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_form_intake' AND p.policyname = 'enrollment_intake_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'enrollment_intake_admin_select', 'enrollment_form_intake';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'enrollment_intake_admin_select', 'enrollment_form_intake';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'enrollment_intake_admin_select', 'enrollment_form_intake';
  END IF;
END
$lote2$;
COMMIT;

-- enrollment_pause_requests: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_pause_requests' AND p.policyname = 'pause_requests_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pause_requests_select_staff', 'enrollment_pause_requests';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT unnest(user_school_ids()) AS unnest))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "pause_requests_select_staff" ON public."enrollment_pause_requests"
      USING ((school_id IN ( SELECT unnest((SELECT public.user_school_ids())) AS unnest)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_pause_requests' AND p.policyname = 'pause_requests_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pause_requests_select_staff', 'enrollment_pause_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pause_requests_select_staff', 'enrollment_pause_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pause_requests_select_staff', 'enrollment_pause_requests';
  END IF;
END
$lote2$;
COMMIT;

-- enrollment_plan_changes: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_plan_changes' AND p.policyname = 'epc_staff_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'epc_staff_select', 'enrollment_plan_changes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "epc_staff_select" ON public."enrollment_plan_changes"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_plan_changes' AND p.policyname = 'epc_staff_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'epc_staff_select', 'enrollment_plan_changes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'epc_staff_select', 'enrollment_plan_changes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'epc_staff_select', 'enrollment_plan_changes';
  END IF;
END
$lote2$;
COMMIT;

-- enrollment_withdrawal_requests: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_withdrawal_requests' AND p.policyname = 'withdrawal_requests_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'withdrawal_requests_select_admin', 'enrollment_withdrawal_requests';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_admin_school_ids()) AS unnest)) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "withdrawal_requests_select_admin" ON public."enrollment_withdrawal_requests"
      USING (((school_id IN ( SELECT unnest((SELECT public.user_admin_school_ids())) AS unnest)) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'enrollment_withdrawal_requests' AND p.policyname = 'withdrawal_requests_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'withdrawal_requests_select_admin', 'enrollment_withdrawal_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'withdrawal_requests_select_admin', 'enrollment_withdrawal_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'withdrawal_requests_select_admin', 'enrollment_withdrawal_requests';
  END IF;
END
$lote2$;
COMMIT;

-- equipment_assignment_logs: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignment_logs' AND p.policyname = 'equipment_logs_admin_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_logs_admin_read', 'equipment_assignment_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM equipment_assignments ea
  WHERE ((ea.id = equipment_assignment_logs.assignment_id) AND (is_super_admin() OR is_school_admin(ea.school_id)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "equipment_logs_admin_read" ON public."equipment_assignment_logs"
      USING ((EXISTS ( SELECT 1
   FROM equipment_assignments ea
  WHERE ((ea.id = equipment_assignment_logs.assignment_id) AND ((SELECT public.is_super_admin()) OR (ea.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignment_logs' AND p.policyname = 'equipment_logs_admin_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_logs_admin_read', 'equipment_assignment_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_logs_admin_read', 'equipment_assignment_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_logs_admin_read', 'equipment_assignment_logs';
  END IF;
END
$lote2$;
COMMIT;

-- equipment_assignments: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignments' AND p.policyname = 'equipment_assignments_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_assignments_admin', 'equipment_assignments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "equipment_assignments_admin" ON public."equipment_assignments"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignments' AND p.policyname = 'equipment_assignments_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_assignments_admin', 'equipment_assignments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_assignments_admin', 'equipment_assignments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_assignments_admin', 'equipment_assignments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignments' AND p.policyname = 'equipment_assignments_coach_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_assignments_coach_read', 'equipment_assignments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(assigned_to = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "equipment_assignments_coach_read" ON public."equipment_assignments"
      USING ((assigned_to = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_assignments' AND p.policyname = 'equipment_assignments_coach_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_assignments_coach_read', 'equipment_assignments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_assignments_coach_read', 'equipment_assignments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_assignments_coach_read', 'equipment_assignments';
  END IF;
END
$lote2$;
COMMIT;

-- equipment_items: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_items' AND p.policyname = 'equipment_items_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_items_admin', 'equipment_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "equipment_items_admin" ON public."equipment_items"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_items' AND p.policyname = 'equipment_items_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_items_admin', 'equipment_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_items_admin', 'equipment_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_items_admin', 'equipment_items';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_items' AND p.policyname = 'equipment_items_coach_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_items_coach_read', 'equipment_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = equipment_items.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = 'coach'::text) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "equipment_items_coach_read" ON public."equipment_items"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = equipment_items.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = 'coach'::text) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_items' AND p.policyname = 'equipment_items_coach_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_items_coach_read', 'equipment_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_items_coach_read', 'equipment_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_items_coach_read', 'equipment_items';
  END IF;
END
$lote2$;
COMMIT;

-- equipment_returns: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_returns' AND p.policyname = 'equipment_returns_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_returns_admin', 'equipment_returns';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "equipment_returns_admin" ON public."equipment_returns"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_returns' AND p.policyname = 'equipment_returns_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_returns_admin', 'equipment_returns';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_returns_admin', 'equipment_returns';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_returns_admin', 'equipment_returns';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_returns' AND p.policyname = 'equipment_returns_coach_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_returns_coach_read', 'equipment_returns';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM equipment_assignments ea
  WHERE ((ea.id = equipment_returns.assignment_id) AND (ea.assigned_to = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "equipment_returns_coach_read" ON public."equipment_returns"
      USING ((EXISTS ( SELECT 1
   FROM equipment_assignments ea
  WHERE ((ea.id = equipment_returns.assignment_id) AND (ea.assigned_to = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_returns' AND p.policyname = 'equipment_returns_coach_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_returns_coach_read', 'equipment_returns';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_returns_coach_read', 'equipment_returns';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_returns_coach_read', 'equipment_returns';
  END IF;
END
$lote2$;
COMMIT;

-- equipment_settings: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_settings' AND p.policyname = 'equipment_settings_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'equipment_settings_admin', 'equipment_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "equipment_settings_admin" ON public."equipment_settings"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'equipment_settings' AND p.policyname = 'equipment_settings_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'equipment_settings_admin', 'equipment_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'equipment_settings_admin', 'equipment_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'equipment_settings_admin', 'equipment_settings';
  END IF;
END
$lote2$;
COMMIT;

-- event_categories_config: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_categories_config' AND p.policyname = 'categories_organizer_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'categories_organizer_manage', 'event_categories_config';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = ( SELECT auth.uid() AS uid))))$o$ THEN
    EXECUTE $a$ALTER POLICY "categories_organizer_manage" ON public."event_categories_config"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_categories_config' AND p.policyname = 'categories_organizer_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'categories_organizer_manage', 'event_categories_config';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'categories_organizer_manage', 'event_categories_config';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'categories_organizer_manage', 'event_categories_config';
  END IF;
END
$lote2$;
COMMIT;

-- event_delegation_payments: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegation_payments' AND p.policyname = 'del_payments_organizer_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'del_payments_organizer_manage', 'event_delegation_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "del_payments_organizer_manage" ON public."event_delegation_payments"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegation_payments' AND p.policyname = 'del_payments_organizer_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'del_payments_organizer_manage', 'event_delegation_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'del_payments_organizer_manage', 'event_delegation_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'del_payments_organizer_manage', 'event_delegation_payments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegation_payments' AND p.policyname = 'del_payments_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'del_payments_school_manage', 'event_delegation_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "del_payments_school_manage" ON public."event_delegation_payments"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegation_payments' AND p.policyname = 'del_payments_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'del_payments_school_manage', 'event_delegation_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'del_payments_school_manage', 'event_delegation_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'del_payments_school_manage', 'event_delegation_payments';
  END IF;
END
$lote2$;
COMMIT;

-- event_delegations: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_organizer_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'delegation_organizer_read', 'event_delegations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "delegation_organizer_read" ON public."event_delegations"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_organizer_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'delegation_organizer_read', 'event_delegations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'delegation_organizer_read', 'event_delegations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'delegation_organizer_read', 'event_delegations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_organizer_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'delegation_organizer_update', 'event_delegations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "delegation_organizer_update" ON public."event_delegations"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_organizer_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'delegation_organizer_update', 'event_delegations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'delegation_organizer_update', 'event_delegations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'delegation_organizer_update', 'event_delegations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'delegation_school_manage', 'event_delegations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = ( SELECT auth.uid() AS uid)) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text)))) AND (status = ANY (ARRAY['draft'::text, 'submitted'::text])) AND (confirmed_at IS NULL) AND (COALESCE(total_paid, (0)::numeric) = (0)::numeric))$o$ THEN
    EXECUTE $a$ALTER POLICY "delegation_school_manage" ON public."event_delegations"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_delegations' AND p.policyname = 'delegation_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'delegation_school_manage', 'event_delegations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'delegation_school_manage', 'event_delegations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'delegation_school_manage', 'event_delegations';
  END IF;
END
$lote2$;
COMMIT;

-- event_invitations: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_invitations' AND p.policyname = 'event_invitations_host_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_invitations_host_manage', 'event_invitations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$can_manage_event(event_id, auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$can_manage_event(event_id, auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "event_invitations_host_manage" ON public."event_invitations"
      USING (can_manage_event(event_id, (SELECT auth.uid())))
      WITH CHECK (can_manage_event(event_id, (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_invitations' AND p.policyname = 'event_invitations_host_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_invitations_host_manage', 'event_invitations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_invitations_host_manage', 'event_invitations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_invitations_host_manage', 'event_invitations';
  END IF;
END
$lote2$;
COMMIT;

-- event_price_phases: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_price_phases' AND p.policyname = 'price_phases_organizer_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'price_phases_organizer_manage', 'event_price_phases';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = ( SELECT auth.uid() AS uid))))$o$ THEN
    EXECUTE $a$ALTER POLICY "price_phases_organizer_manage" ON public."event_price_phases"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_price_phases' AND p.policyname = 'price_phases_organizer_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'price_phases_organizer_manage', 'event_price_phases';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'price_phases_organizer_manage', 'event_price_phases';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'price_phases_organizer_manage', 'event_price_phases';
  END IF;
END
$lote2$;
COMMIT;

-- event_registrations: 6 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_registrations_delete', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = auth.uid())))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "event_registrations_delete" ON public."event_registrations"
      USING (((user_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = (SELECT auth.uid()))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_registrations_delete', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_registrations_delete', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_registrations_delete', 'event_registrations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_registrations_insert', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "event_registrations_insert" ON public."event_registrations"
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_registrations_insert', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_registrations_insert', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_registrations_insert', 'event_registrations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_registrations_select', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = auth.uid())))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "event_registrations_select" ON public."event_registrations"
      USING (((user_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = (SELECT auth.uid()))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_registrations_select', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_registrations_select', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_registrations_select', 'event_registrations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_select_own_child';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_registrations_select_own_child', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "event_registrations_select_own_child" ON public."event_registrations"
      USING ((child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_select_own_child';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_registrations_select_own_child', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_registrations_select_own_child', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_registrations_select_own_child', 'event_registrations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_registrations_update', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = auth.uid())))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "event_registrations_update" ON public."event_registrations"
      USING (((EXISTS ( SELECT 1
   FROM events e
  WHERE ((e.id = event_registrations.event_id) AND (e.creator_id = (SELECT auth.uid()))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'event_registrations_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_registrations_update', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_registrations_update', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_registrations_update', 'event_registrations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'school_admin_view_own_athlete_registrations';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_admin_view_own_athlete_registrations', 'event_registrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_admin_view_own_athlete_registrations" ON public."event_registrations"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_registrations' AND p.policyname = 'school_admin_view_own_athlete_registrations';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_admin_view_own_athlete_registrations', 'event_registrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_admin_view_own_athlete_registrations', 'event_registrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_admin_view_own_athlete_registrations', 'event_registrations';
  END IF;
END
$lote2$;
COMMIT;

-- event_team_coaches: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_coaches' AND p.policyname = 'coaches_organizer_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coaches_organizer_read', 'event_team_coaches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM event_delegations d
  WHERE (d.event_id IN ( SELECT events.id
           FROM events
          WHERE (events.creator_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "coaches_organizer_read" ON public."event_team_coaches"
      USING ((delegation_id IN ( SELECT d.id
   FROM event_delegations d
  WHERE (d.event_id IN ( SELECT events.id
           FROM events
          WHERE (events.creator_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_coaches' AND p.policyname = 'coaches_organizer_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coaches_organizer_read', 'event_team_coaches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coaches_organizer_read', 'event_team_coaches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coaches_organizer_read', 'event_team_coaches';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_coaches' AND p.policyname = 'coaches_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coaches_school_manage', 'event_team_coaches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = ( SELECT auth.uid() AS uid)) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "coaches_school_manage" ON public."event_team_coaches"
      USING ((delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_coaches' AND p.policyname = 'coaches_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coaches_school_manage', 'event_team_coaches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coaches_school_manage', 'event_team_coaches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coaches_school_manage', 'event_team_coaches';
  END IF;
END
$lote2$;
COMMIT;

-- event_team_members: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_members' AND p.policyname = 'members_organizer_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'members_organizer_read', 'event_team_members';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM event_delegations d
  WHERE (d.event_id IN ( SELECT events.id
           FROM events
          WHERE (events.creator_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "members_organizer_read" ON public."event_team_members"
      USING ((delegation_id IN ( SELECT d.id
   FROM event_delegations d
  WHERE (d.event_id IN ( SELECT events.id
           FROM events
          WHERE (events.creator_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_members' AND p.policyname = 'members_organizer_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'members_organizer_read', 'event_team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'members_organizer_read', 'event_team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'members_organizer_read', 'event_team_members';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_members' AND p.policyname = 'members_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'members_school_manage', 'event_team_members';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "members_school_manage" ON public."event_team_members"
      USING ((delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))
      WITH CHECK ((delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_team_members' AND p.policyname = 'members_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'members_school_manage', 'event_team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'members_school_manage', 'event_team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'members_school_manage', 'event_team_members';
  END IF;
END
$lote2$;
COMMIT;

-- event_teams: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_teams' AND p.policyname = 'teams_organizer_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'teams_organizer_read', 'event_teams';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "teams_organizer_read" ON public."event_teams"
      USING ((event_id IN ( SELECT events.id
   FROM events
  WHERE (events.creator_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_teams' AND p.policyname = 'teams_organizer_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'teams_organizer_read', 'event_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'teams_organizer_read', 'event_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'teams_organizer_read', 'event_teams';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_teams' AND p.policyname = 'teams_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'teams_school_manage', 'event_teams';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "teams_school_manage" ON public."event_teams"
      USING ((delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))
      WITH CHECK ((delegation_id IN ( SELECT d.id
   FROM (event_delegations d
     JOIN school_members sm ON ((sm.school_id = d.school_id)))
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_teams' AND p.policyname = 'teams_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'teams_school_manage', 'event_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'teams_school_manage', 'event_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'teams_school_manage', 'event_teams';
  END IF;
END
$lote2$;
COMMIT;

-- event_telemetry: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_telemetry' AND p.policyname = 'event_telemetry_platform_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'event_telemetry_platform_admin_select', 'event_telemetry';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "event_telemetry_platform_admin_select" ON public."event_telemetry"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'event_telemetry' AND p.policyname = 'event_telemetry_platform_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'event_telemetry_platform_admin_select', 'event_telemetry';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'event_telemetry_platform_admin_select', 'event_telemetry';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'event_telemetry_platform_admin_select', 'event_telemetry';
  END IF;
END
$lote2$;
COMMIT;

-- events: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'events' AND p.policyname = 'events_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'events_delete_own', 'events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((creator_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "events_delete_own" ON public."events"
      USING (((creator_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'events' AND p.policyname = 'events_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'events_delete_own', 'events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'events_delete_own', 'events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'events_delete_own', 'events';
  END IF;
END
$lote2$;
COMMIT;

-- facilities: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_delete_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facilities_delete_admin', 'facilities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facilities_delete_admin" ON public."facilities"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_delete_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facilities_delete_admin', 'facilities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facilities_delete_admin', 'facilities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facilities_delete_admin', 'facilities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facilities_insert_admin', 'facilities';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "facilities_insert_admin" ON public."facilities"
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facilities_insert_admin', 'facilities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facilities_insert_admin', 'facilities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facilities_insert_admin', 'facilities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_read_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facilities_read_admin', 'facilities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facilities_read_admin" ON public."facilities"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_read_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facilities_read_admin', 'facilities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facilities_read_admin', 'facilities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facilities_read_admin', 'facilities';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_update_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facilities_update_admin', 'facilities';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "facilities_update_admin" ON public."facilities"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facilities' AND p.policyname = 'facilities_update_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facilities_update_admin', 'facilities';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facilities_update_admin', 'facilities';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facilities_update_admin', 'facilities';
  END IF;
END
$lote2$;
COMMIT;

-- facility_availability: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_availability' AND p.policyname = 'facility_availability_authenticated_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_availability_authenticated_read', 'facility_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() IS NOT NULL)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_availability_authenticated_read" ON public."facility_availability"
      USING (((SELECT auth.uid()) IS NOT NULL))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_availability' AND p.policyname = 'facility_availability_authenticated_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_availability_authenticated_read', 'facility_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_availability_authenticated_read', 'facility_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_availability_authenticated_read', 'facility_availability';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_availability' AND p.policyname = 'facility_availability_school_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_availability_school_admin_all', 'facility_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "facility_availability_school_admin_all" ON public."facility_availability"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_availability' AND p.policyname = 'facility_availability_school_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_availability_school_admin_all', 'facility_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_availability_school_admin_all', 'facility_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_availability_school_admin_all', 'facility_availability';
  END IF;
END
$lote2$;
COMMIT;

-- facility_blackouts: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_blackouts' AND p.policyname = 'facility_blackouts_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_blackouts_select', 'facility_blackouts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_blackouts_select" ON public."facility_blackouts"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_blackouts' AND p.policyname = 'facility_blackouts_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_blackouts_select', 'facility_blackouts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_blackouts_select', 'facility_blackouts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_blackouts_select', 'facility_blackouts';
  END IF;
END
$lote2$;
COMMIT;

-- facility_rates: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_rates_delete', 'facility_rates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_rates_delete" ON public."facility_rates"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_rates_delete', 'facility_rates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_rates_delete', 'facility_rates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_rates_delete', 'facility_rates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_rates_insert', 'facility_rates';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "facility_rates_insert" ON public."facility_rates"
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_rates_insert', 'facility_rates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_rates_insert', 'facility_rates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_rates_insert', 'facility_rates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_rates_select', 'facility_rates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_rates_select" ON public."facility_rates"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_rates_select', 'facility_rates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_rates_select', 'facility_rates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_rates_select', 'facility_rates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_rates_update', 'facility_rates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "facility_rates_update" ON public."facility_rates"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_rates' AND p.policyname = 'facility_rates_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_rates_update', 'facility_rates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_rates_update', 'facility_rates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_rates_update', 'facility_rates';
  END IF;
END
$lote2$;
COMMIT;

-- facility_reservations: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_school_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_resv_school_select', 'facility_reservations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = facility_reservations.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_resv_school_select" ON public."facility_reservations"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = facility_reservations.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_school_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_resv_school_select', 'facility_reservations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_resv_school_select', 'facility_reservations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_resv_school_select', 'facility_reservations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_resv_select_own', 'facility_reservations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_resv_select_own" ON public."facility_reservations"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_resv_select_own', 'facility_reservations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_resv_select_own', 'facility_reservations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_resv_select_own', 'facility_reservations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_select_staff_scope';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'facility_resv_select_staff_scope', 'facility_reservations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM facilities f
  WHERE ((f.id = facility_reservations.facility_id) AND ((f.school_id = ANY (user_admin_school_ids())) OR (EXISTS ( SELECT 1
           FROM school_members sm
          WHERE ((sm.school_id = f.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = 'staff'::text))))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "facility_resv_select_staff_scope" ON public."facility_reservations"
      USING ((EXISTS ( SELECT 1
   FROM facilities f
  WHERE ((f.id = facility_reservations.facility_id) AND ((f.school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
           FROM school_members sm
          WHERE ((sm.school_id = f.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = 'staff'::text)))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'facility_reservations' AND p.policyname = 'facility_resv_select_staff_scope';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'facility_resv_select_staff_scope', 'facility_reservations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'facility_resv_select_staff_scope', 'facility_reservations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'facility_resv_select_staff_scope', 'facility_reservations';
  END IF;
END
$lote2$;
COMMIT;

-- football_match_events: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'football_match_events_delete', 'football_match_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "football_match_events_delete" ON public."football_match_events"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'football_match_events_delete', 'football_match_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'football_match_events_delete', 'football_match_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'football_match_events_delete', 'football_match_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'football_match_events_insert', 'football_match_events';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "football_match_events_insert" ON public."football_match_events"
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'football_match_events_insert', 'football_match_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'football_match_events_insert', 'football_match_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'football_match_events_insert', 'football_match_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'football_match_events_select', 'football_match_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR ((subject_type = 'profile'::text) AND (subject_id = auth.uid())) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "football_match_events_select" ON public."football_match_events"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR ((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid()))) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'football_match_events_select', 'football_match_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'football_match_events_select', 'football_match_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'football_match_events_select', 'football_match_events';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'football_match_events_update', 'football_match_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "football_match_events_update" ON public."football_match_events"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'football_match_events' AND p.policyname = 'football_match_events_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'football_match_events_update', 'football_match_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'football_match_events_update', 'football_match_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'football_match_events_update', 'football_match_events';
  END IF;
END
$lote2$;
COMMIT;

-- group_class_athletes: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'group_class_athletes' AND p.policyname = 'school_admin_can_manage_group_class_athletes';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_admin_can_manage_group_class_athletes', 'group_class_athletes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "school_admin_can_manage_group_class_athletes" ON public."group_class_athletes"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'group_class_athletes' AND p.policyname = 'school_admin_can_manage_group_class_athletes';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_admin_can_manage_group_class_athletes', 'group_class_athletes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_admin_can_manage_group_class_athletes', 'group_class_athletes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_admin_can_manage_group_class_athletes', 'group_class_athletes';
  END IF;
END
$lote2$;
COMMIT;

-- hour_bank_periods: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_periods' AND p.policyname = 'hour_bank_periods_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'hour_bank_periods_select', 'hour_bank_periods';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_periods.enrollment_id) AND ((e.user_id = auth.uid()) OR is_parent_of_child(e.child_id))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "hour_bank_periods_select" ON public."hour_bank_periods"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_periods.enrollment_id) AND ((e.user_id = (SELECT auth.uid())) OR is_parent_of_child(e.child_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_periods' AND p.policyname = 'hour_bank_periods_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'hour_bank_periods_select', 'hour_bank_periods';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'hour_bank_periods_select', 'hour_bank_periods';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'hour_bank_periods_select', 'hour_bank_periods';
  END IF;
END
$lote2$;
COMMIT;

-- hour_bank_reservations: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_reservations' AND p.policyname = 'hour_bank_reservations_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'hour_bank_reservations_select', 'hour_bank_reservations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_reservations.enrollment_id) AND ((e.user_id = auth.uid()) OR is_parent_of_child(e.child_id))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "hour_bank_reservations_select" ON public."hour_bank_reservations"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_reservations.enrollment_id) AND ((e.user_id = (SELECT auth.uid())) OR is_parent_of_child(e.child_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_reservations' AND p.policyname = 'hour_bank_reservations_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'hour_bank_reservations_select', 'hour_bank_reservations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'hour_bank_reservations_select', 'hour_bank_reservations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'hour_bank_reservations_select', 'hour_bank_reservations';
  END IF;
END
$lote2$;
COMMIT;

-- hour_bank_visit_segments: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_visit_segments' AND p.policyname = 'hour_bank_visit_segments_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'hour_bank_visit_segments_select', 'hour_bank_visit_segments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_visit_segments.enrollment_id) AND ((e.user_id = auth.uid()) OR is_parent_of_child(e.child_id))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "hour_bank_visit_segments_select" ON public."hour_bank_visit_segments"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_visit_segments.enrollment_id) AND ((e.user_id = (SELECT auth.uid())) OR is_parent_of_child(e.child_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_visit_segments' AND p.policyname = 'hour_bank_visit_segments_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'hour_bank_visit_segments_select', 'hour_bank_visit_segments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'hour_bank_visit_segments_select', 'hour_bank_visit_segments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'hour_bank_visit_segments_select', 'hour_bank_visit_segments';
  END IF;
END
$lote2$;
COMMIT;

-- hour_bank_visits: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_visits' AND p.policyname = 'hour_bank_visits_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'hour_bank_visits_select', 'hour_bank_visits';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_visits.enrollment_id) AND ((e.user_id = auth.uid()) OR is_parent_of_child(e.child_id))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "hour_bank_visits_select" ON public."hour_bank_visits"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.id = hour_bank_visits.enrollment_id) AND ((e.user_id = (SELECT auth.uid())) OR is_parent_of_child(e.child_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'hour_bank_visits' AND p.policyname = 'hour_bank_visits_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'hour_bank_visits_select', 'hour_bank_visits';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'hour_bank_visits_select', 'hour_bank_visits';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'hour_bank_visits_select', 'hour_bank_visits';
  END IF;
END
$lote2$;
COMMIT;

-- identity_documents: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'identity_docs_admin_select', 'identity_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "identity_docs_admin_select" ON public."identity_documents"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'identity_docs_admin_select', 'identity_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'identity_docs_admin_select', 'identity_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'identity_docs_admin_select', 'identity_documents';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_admin_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'identity_docs_admin_update', 'identity_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "identity_docs_admin_update" ON public."identity_documents"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_admin_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'identity_docs_admin_update', 'identity_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'identity_docs_admin_update', 'identity_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'identity_docs_admin_update', 'identity_documents';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_parent_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'identity_docs_parent_insert', 'identity_documents';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((profile_id = auth.uid()) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "identity_docs_parent_insert" ON public."identity_documents"
      WITH CHECK (((profile_id = (SELECT auth.uid())) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_parent_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'identity_docs_parent_insert', 'identity_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'identity_docs_parent_insert', 'identity_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'identity_docs_parent_insert', 'identity_documents';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_parent_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'identity_docs_parent_select', 'identity_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((profile_id = auth.uid()) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "identity_docs_parent_select" ON public."identity_documents"
      USING (((profile_id = (SELECT auth.uid())) OR (child_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'identity_documents' AND p.policyname = 'identity_docs_parent_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'identity_docs_parent_select', 'identity_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'identity_docs_parent_select', 'identity_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'identity_docs_parent_select', 'identity_documents';
  END IF;
END
$lote2$;
COMMIT;

-- invitations: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invitations' AND p.policyname = 'Invitations: manage staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Invitations: manage staff', 'invitations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "Invitations: manage staff" ON public."invitations"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invitations' AND p.policyname = 'Invitations: manage staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Invitations: manage staff', 'invitations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Invitations: manage staff', 'invitations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Invitations: manage staff', 'invitations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invitations' AND p.policyname = 'Invitations: select own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Invitations: select own', 'invitations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(lower(email) = lower((auth.jwt() ->> 'email'::text)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Invitations: select own" ON public."invitations"
      USING ((lower(email) = lower(((SELECT auth.jwt()) ->> 'email'::text))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invitations' AND p.policyname = 'Invitations: select own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Invitations: select own', 'invitations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Invitations: select own', 'invitations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Invitations: select own', 'invitations';
  END IF;
END
$lote2$;
COMMIT;

-- invoices: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invoices' AND p.policyname = 'invoices_select_buyer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'invoices_select_buyer', 'invoices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = invoices.order_id) AND (o.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "invoices_select_buyer" ON public."invoices"
      USING ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = invoices.order_id) AND (o.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invoices' AND p.policyname = 'invoices_select_buyer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'invoices_select_buyer', 'invoices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'invoices_select_buyer', 'invoices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'invoices_select_buyer', 'invoices';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invoices' AND p.policyname = 'invoices_select_vendor';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'invoices_select_vendor', 'invoices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "invoices_select_vendor" ON public."invoices"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'invoices' AND p.policyname = 'invoices_select_vendor';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'invoices_select_vendor', 'invoices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'invoices_select_vendor', 'invoices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'invoices_select_vendor', 'invoices';
  END IF;
END
$lote2$;
COMMIT;

-- join_applications: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'join_applications_delete', 'join_applications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "join_applications_delete" ON public."join_applications"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'join_applications_delete', 'join_applications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'join_applications_delete', 'join_applications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'join_applications_delete', 'join_applications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'join_applications_select', 'join_applications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "join_applications_select" ON public."join_applications"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'join_applications_select', 'join_applications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'join_applications_select', 'join_applications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'join_applications_select', 'join_applications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'join_applications_update', 'join_applications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "join_applications_update" ON public."join_applications"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'join_applications' AND p.policyname = 'join_applications_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'join_applications_update', 'join_applications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'join_applications_update', 'join_applications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'join_applications_update', 'join_applications';
  END IF;
END
$lote2$;
COMMIT;

-- marketplace_shipping_rates: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'marketplace_shipping_rates' AND p.policyname = 'mp_shipping_rates_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'mp_shipping_rates_owner', 'marketplace_shipping_rates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = ( SELECT auth.uid() AS uid))))$o$ THEN
    EXECUTE $a$ALTER POLICY "mp_shipping_rates_owner" ON public."marketplace_shipping_rates"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'marketplace_shipping_rates' AND p.policyname = 'mp_shipping_rates_owner';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'mp_shipping_rates_owner', 'marketplace_shipping_rates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'mp_shipping_rates_owner', 'marketplace_shipping_rates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'mp_shipping_rates_owner', 'marketplace_shipping_rates';
  END IF;
END
$lote2$;
COMMIT;

-- match_lineup_players: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineup_players_delete', 'match_lineup_players';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "match_lineup_players_delete" ON public."match_lineup_players"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineup_players_delete', 'match_lineup_players';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineup_players_delete', 'match_lineup_players';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineup_players_delete', 'match_lineup_players';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineup_players_insert', 'match_lineup_players';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "match_lineup_players_insert" ON public."match_lineup_players"
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineup_players_insert', 'match_lineup_players';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineup_players_insert', 'match_lineup_players';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineup_players_insert', 'match_lineup_players';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineup_players_select', 'match_lineup_players';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR ((subject_type = 'profile'::text) AND (subject_id = auth.uid())) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "match_lineup_players_select" ON public."match_lineup_players"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR ((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid()))) OR ((subject_type = 'child'::text) AND is_parent_of_child(subject_id))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineup_players_select', 'match_lineup_players';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineup_players_select', 'match_lineup_players';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineup_players_select', 'match_lineup_players';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineup_players_update', 'match_lineup_players';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "match_lineup_players_update" ON public."match_lineup_players"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineup_players' AND p.policyname = 'match_lineup_players_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineup_players_update', 'match_lineup_players';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineup_players_update', 'match_lineup_players';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineup_players_update', 'match_lineup_players';
  END IF;
END
$lote2$;
COMMIT;

-- match_lineups: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineups_delete', 'match_lineups';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "match_lineups_delete" ON public."match_lineups"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineups_delete', 'match_lineups';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineups_delete', 'match_lineups';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineups_delete', 'match_lineups';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineups_insert', 'match_lineups';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "match_lineups_insert" ON public."match_lineups"
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineups_insert', 'match_lineups';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineups_insert', 'match_lineups';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineups_insert', 'match_lineups';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineups_select', 'match_lineups';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (EXISTS ( SELECT 1
   FROM match_lineup_players mlp
  WHERE ((mlp.lineup_id = match_lineups.id) AND (((mlp.subject_type = 'profile'::text) AND (mlp.subject_id = auth.uid())) OR ((mlp.subject_type = 'child'::text) AND is_parent_of_child(mlp.subject_id)))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "match_lineups_select" ON public."match_lineups"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM match_lineup_players mlp
  WHERE ((mlp.lineup_id = match_lineups.id) AND (((mlp.subject_type = 'profile'::text) AND (mlp.subject_id = (SELECT auth.uid()))) OR ((mlp.subject_type = 'child'::text) AND is_parent_of_child(mlp.subject_id))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineups_select', 'match_lineups';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineups_select', 'match_lineups';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineups_select', 'match_lineups';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'match_lineups_update', 'match_lineups';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "match_lineups_update" ON public."match_lineups"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'match_lineups' AND p.policyname = 'match_lineups_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'match_lineups_update', 'match_lineups';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'match_lineups_update', 'match_lineups';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'match_lineups_update', 'match_lineups';
  END IF;
END
$lote2$;
COMMIT;

-- memberships: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'memberships_staff_delete', 'memberships';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "memberships_staff_delete" ON public."memberships"
      USING (((school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest)) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'memberships_staff_delete', 'memberships';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'memberships_staff_delete', 'memberships';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'memberships_staff_delete', 'memberships';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'memberships_staff_insert', 'memberships';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "memberships_staff_insert" ON public."memberships"
      WITH CHECK (((school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest)) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'memberships_staff_insert', 'memberships';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'memberships_staff_insert', 'memberships';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'memberships_staff_insert', 'memberships';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_lectura';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'memberships_staff_lectura', 'memberships';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "memberships_staff_lectura" ON public."memberships"
      USING (((school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest)) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_lectura';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'memberships_staff_lectura', 'memberships';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'memberships_staff_lectura', 'memberships';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'memberships_staff_lectura', 'memberships';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'memberships_staff_update', 'memberships';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM $o$((school_id IN ( SELECT unnest(user_staff_school_ids()) AS unnest)) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "memberships_staff_update" ON public."memberships"
      USING (((school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest)) OR (SELECT public.is_super_admin())))
      WITH CHECK (((school_id IN ( SELECT unnest((SELECT public.user_staff_school_ids())) AS unnest)) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'memberships' AND p.policyname = 'memberships_staff_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'memberships_staff_update', 'memberships';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'memberships_staff_update', 'memberships';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'memberships_staff_update', 'memberships';
  END IF;
END
$lote2$;
COMMIT;

-- message_attachments: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'message_attachments_delete', 'message_attachments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "message_attachments_delete" ON public."message_attachments"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'message_attachments_delete', 'message_attachments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'message_attachments_delete', 'message_attachments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'message_attachments_delete', 'message_attachments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'message_attachments_insert_own', 'message_attachments';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM messages m
  WHERE ((m.id = message_attachments.message_id) AND (m.sender_id = auth.uid()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "message_attachments_insert_own" ON public."message_attachments"
      WITH CHECK ((EXISTS ( SELECT 1
   FROM messages m
  WHERE ((m.id = message_attachments.message_id) AND (m.sender_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'message_attachments_insert_own', 'message_attachments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'message_attachments_insert_own', 'message_attachments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'message_attachments_insert_own', 'message_attachments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'message_attachments_select', 'message_attachments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM contact_messages cm
  WHERE ((cm.id = message_attachments.message_id) AND ((cm.assigned_to = auth.uid()) OR is_platform_admin()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "message_attachments_select" ON public."message_attachments"
      USING ((EXISTS ( SELECT 1
   FROM contact_messages cm
  WHERE ((cm.id = message_attachments.message_id) AND ((cm.assigned_to = (SELECT auth.uid())) OR (SELECT public.is_platform_admin()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'message_attachments' AND p.policyname = 'message_attachments_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'message_attachments_select', 'message_attachments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'message_attachments_select', 'message_attachments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'message_attachments_select', 'message_attachments';
  END IF;
END
$lote2$;
COMMIT;

-- messages: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_delete_sender';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'messages_delete_sender', 'messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(sender_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "messages_delete_sender" ON public."messages"
      USING ((sender_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_delete_sender';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'messages_delete_sender', 'messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'messages_delete_sender', 'messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'messages_delete_sender', 'messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'messages_insert_own', 'messages';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((sender_id = auth.uid()) AND (NOT is_coach_parent_messaging_blocked(auth.uid(), recipient_id)))$o$ THEN
    EXECUTE $a$ALTER POLICY "messages_insert_own" ON public."messages"
      WITH CHECK (((sender_id = (SELECT auth.uid())) AND (NOT is_coach_parent_messaging_blocked((SELECT auth.uid()), recipient_id))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'messages_insert_own', 'messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'messages_insert_own', 'messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'messages_insert_own', 'messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'messages_select_own', 'messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((sender_id = auth.uid()) OR (recipient_id = auth.uid()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "messages_select_own" ON public."messages"
      USING (((sender_id = (SELECT auth.uid())) OR (recipient_id = (SELECT auth.uid()))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'messages_select_own', 'messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'messages_select_own', 'messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'messages_select_own', 'messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_update_recipient';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'messages_update_recipient', 'messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(recipient_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "messages_update_recipient" ON public."messages"
      USING ((recipient_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'messages' AND p.policyname = 'messages_update_recipient';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'messages_update_recipient', 'messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'messages_update_recipient', 'messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'messages_update_recipient', 'messages';
  END IF;
END
$lote2$;
COMMIT;

-- monthly_closes: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'monthly_closes' AND p.policyname = 'monthly_closes_manage_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'monthly_closes_manage_admin', 'monthly_closes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "monthly_closes_manage_admin" ON public."monthly_closes"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'monthly_closes' AND p.policyname = 'monthly_closes_manage_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'monthly_closes_manage_admin', 'monthly_closes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'monthly_closes_manage_admin', 'monthly_closes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'monthly_closes_manage_admin', 'monthly_closes';
  END IF;
END
$lote2$;
COMMIT;

-- notifications: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'notifications_delete_own', 'notifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "notifications_delete_own" ON public."notifications"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'notifications_delete_own', 'notifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'notifications_delete_own', 'notifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'notifications_delete_own', 'notifications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'notifications_select_own', 'notifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "notifications_select_own" ON public."notifications"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'notifications_select_own', 'notifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'notifications_select_own', 'notifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'notifications_select_own', 'notifications';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'notifications_update_own', 'notifications';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "notifications_update_own" ON public."notifications"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'notifications' AND p.policyname = 'notifications_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'notifications_update_own', 'notifications';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'notifications_update_own', 'notifications';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'notifications_update_own', 'notifications';
  END IF;
END
$lote2$;
COMMIT;

-- ocr_processing_log: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'ocr_processing_log' AND p.policyname = 'ocr_log_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ocr_log_admin_select', 'ocr_processing_log';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ocr_log_admin_select" ON public."ocr_processing_log"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'ocr_processing_log' AND p.policyname = 'ocr_log_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ocr_log_admin_select', 'ocr_processing_log';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ocr_log_admin_select', 'ocr_processing_log';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ocr_log_admin_select', 'ocr_processing_log';
  END IF;
END
$lote2$;
COMMIT;

-- offering_coaches: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_coaches' AND p.policyname = 'offering_coaches_admin_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offering_coaches_admin_manage', 'offering_coaches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "offering_coaches_admin_manage" ON public."offering_coaches"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_coaches' AND p.policyname = 'offering_coaches_admin_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offering_coaches_admin_manage', 'offering_coaches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offering_coaches_admin_manage', 'offering_coaches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offering_coaches_admin_manage', 'offering_coaches';
  END IF;
END
$lote2$;
COMMIT;

-- offering_plans: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_delete_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offering_plans_delete_admin', 'offering_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "offering_plans_delete_admin" ON public."offering_plans"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_delete_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offering_plans_delete_admin', 'offering_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offering_plans_delete_admin', 'offering_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offering_plans_delete_admin', 'offering_plans';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offering_plans_insert_admin', 'offering_plans';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "offering_plans_insert_admin" ON public."offering_plans"
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offering_plans_insert_admin', 'offering_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offering_plans_insert_admin', 'offering_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offering_plans_insert_admin', 'offering_plans';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_select_school_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offering_plans_select_school_members', 'offering_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT unnest(user_school_ids()) AS unnest))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "offering_plans_select_school_members" ON public."offering_plans"
      USING ((school_id IN ( SELECT unnest((SELECT public.user_school_ids())) AS unnest)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_select_school_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offering_plans_select_school_members', 'offering_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offering_plans_select_school_members', 'offering_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offering_plans_select_school_members', 'offering_plans';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_update_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offering_plans_update_admin', 'offering_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "offering_plans_update_admin" ON public."offering_plans"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offering_plans' AND p.policyname = 'offering_plans_update_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offering_plans_update_admin', 'offering_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offering_plans_update_admin', 'offering_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offering_plans_update_admin', 'offering_plans';
  END IF;
END
$lote2$;
COMMIT;

-- offerings: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_delete_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offerings_delete_admin', 'offerings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "offerings_delete_admin" ON public."offerings"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_delete_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offerings_delete_admin', 'offerings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offerings_delete_admin', 'offerings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offerings_delete_admin', 'offerings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offerings_insert_admin', 'offerings';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "offerings_insert_admin" ON public."offerings"
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offerings_insert_admin', 'offerings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offerings_insert_admin', 'offerings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offerings_insert_admin', 'offerings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_select_school_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offerings_select_school_members', 'offerings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT unnest(user_school_ids()) AS unnest))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "offerings_select_school_members" ON public."offerings"
      USING ((school_id IN ( SELECT unnest((SELECT public.user_school_ids())) AS unnest)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_select_school_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offerings_select_school_members', 'offerings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offerings_select_school_members', 'offerings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offerings_select_school_members', 'offerings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_update_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'offerings_update_admin', 'offerings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "offerings_update_admin" ON public."offerings"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'offerings' AND p.policyname = 'offerings_update_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'offerings_update_admin', 'offerings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'offerings_update_admin', 'offerings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'offerings_update_admin', 'offerings';
  END IF;
END
$lote2$;
COMMIT;

-- order_items: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'order_items' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'order_items';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."order_items"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'order_items' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'order_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'order_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'order_items';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'order_items' AND p.policyname = 'store_off_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_update', 'order_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$store_enabled()$o$
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_update" ON public."order_items"
      USING ((SELECT public.store_enabled()))
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'order_items' AND p.policyname = 'store_off_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_update', 'order_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_update', 'order_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_update', 'order_items';
  END IF;
END
$lote2$;
COMMIT;

-- orders: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'orders_select_buyer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'orders_select_buyer', 'orders';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "orders_select_buyer" ON public."orders"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'orders_select_buyer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'orders_select_buyer', 'orders';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'orders_select_buyer', 'orders';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'orders_select_buyer', 'orders';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'orders';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."orders"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'orders';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'orders';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'orders';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'store_off_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_update', 'orders';
  END IF;
  IF q IS NOT DISTINCT FROM $o$store_enabled()$o$
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_update" ON public."orders"
      USING ((SELECT public.store_enabled()))
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'orders' AND p.policyname = 'store_off_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_update', 'orders';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_update', 'orders';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_update', 'orders';
  END IF;
END
$lote2$;
COMMIT;

-- payment_audit_logs: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_audit_logs' AND p.policyname = 'payment_audit_logs_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_audit_logs_select_admin', 'payment_audit_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_audit_logs_select_admin" ON public."payment_audit_logs"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_audit_logs' AND p.policyname = 'payment_audit_logs_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_audit_logs_select_admin', 'payment_audit_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_audit_logs_select_admin', 'payment_audit_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_audit_logs_select_admin', 'payment_audit_logs';
  END IF;
END
$lote2$;
COMMIT;

-- payment_consents: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_consents' AND p.policyname = 'payment_consents_owner_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_consents_owner_select', 'payment_consents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_consents_owner_select" ON public."payment_consents"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_consents' AND p.policyname = 'payment_consents_owner_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_consents_owner_select', 'payment_consents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_consents_owner_select', 'payment_consents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_consents_owner_select', 'payment_consents';
  END IF;
END
$lote2$;
COMMIT;

-- payment_glosas: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_glosas' AND p.policyname = 'payment_glosas_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_glosas_admin', 'payment_glosas';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "payment_glosas_admin" ON public."payment_glosas"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))
      WITH CHECK (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_glosas' AND p.policyname = 'payment_glosas_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_glosas_admin', 'payment_glosas';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_glosas_admin', 'payment_glosas';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_glosas_admin', 'payment_glosas';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_glosas' AND p.policyname = 'payment_glosas_parent_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_glosas_parent_read', 'payment_glosas';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = payment_glosas.payment_id) AND (p.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_glosas_parent_read" ON public."payment_glosas"
      USING ((EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = payment_glosas.payment_id) AND (p.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_glosas' AND p.policyname = 'payment_glosas_parent_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_glosas_parent_read', 'payment_glosas';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_glosas_parent_read', 'payment_glosas';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_glosas_parent_read', 'payment_glosas';
  END IF;
END
$lote2$;
COMMIT;

-- payment_installments: 8 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'Installments: update athlete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Installments: update athlete', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Installments: update athlete" ON public."payment_installments"
      USING ((athlete_id = (SELECT auth.uid())))
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'Installments: update athlete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Installments: update athlete', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Installments: update athlete', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Installments: update athlete', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'Installments: update parent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Installments: update parent', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(parent_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(parent_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Installments: update parent" ON public."payment_installments"
      USING ((parent_id = (SELECT auth.uid())))
      WITH CHECK ((parent_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'Installments: update parent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Installments: update parent', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Installments: update parent', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Installments: update parent', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'athlete_can_insert_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_can_insert_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "athlete_can_insert_installments" ON public."payment_installments"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'athlete_can_insert_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_can_insert_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_can_insert_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_can_insert_installments', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'athlete_sees_own_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'athlete_sees_own_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "athlete_sees_own_installments" ON public."payment_installments"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'athlete_sees_own_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'athlete_sees_own_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'athlete_sees_own_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'athlete_sees_own_installments', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'parent_can_insert_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'parent_can_insert_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(parent_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "parent_can_insert_installments" ON public."payment_installments"
      WITH CHECK ((parent_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'parent_can_insert_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'parent_can_insert_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'parent_can_insert_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'parent_can_insert_installments', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'parent_sees_own_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'parent_sees_own_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(parent_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "parent_sees_own_installments" ON public."payment_installments"
      USING ((parent_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'parent_sees_own_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'parent_sees_own_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'parent_sees_own_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'parent_sees_own_installments', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'school_can_review_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_can_review_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_can_review_installments" ON public."payment_installments"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'school_can_review_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_can_review_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_can_review_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_can_review_installments', 'payment_installments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'school_sees_own_installments';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_sees_own_installments', 'payment_installments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_sees_own_installments" ON public."payment_installments"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_installments' AND p.policyname = 'school_sees_own_installments';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_sees_own_installments', 'payment_installments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_sees_own_installments', 'payment_installments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_sees_own_installments', 'payment_installments';
  END IF;
END
$lote2$;
COMMIT;

-- payment_links: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_links' AND p.policyname = 'payment_links_select_by_school';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_links_select_by_school', 'payment_links';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_links_select_by_school" ON public."payment_links"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_links' AND p.policyname = 'payment_links_select_by_school';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_links_select_by_school', 'payment_links';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_links_select_by_school', 'payment_links';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_links_select_by_school', 'payment_links';
  END IF;
END
$lote2$;
COMMIT;

-- payment_message_templates: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'School manages own templates';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School manages own templates', 'payment_message_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text, 'super_admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = ( SELECT auth.uid() AS uid)) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text, 'super_admin'::text])) AND (school_members.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "School manages own templates" ON public."payment_message_templates"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text, 'super_admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'School manages own templates';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School manages own templates', 'payment_message_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School manages own templates', 'payment_message_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School manages own templates', 'payment_message_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pmt_delete', 'payment_message_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "pmt_delete" ON public."payment_message_templates"
      USING (((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pmt_delete', 'payment_message_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pmt_delete', 'payment_message_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pmt_delete', 'payment_message_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pmt_insert', 'payment_message_templates';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$o$ THEN
    EXECUTE $a$ALTER POLICY "pmt_insert" ON public."payment_message_templates"
      WITH CHECK (((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pmt_insert', 'payment_message_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pmt_insert', 'payment_message_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pmt_insert', 'payment_message_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pmt_select', 'payment_message_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IS NULL) OR (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "pmt_select" ON public."payment_message_templates"
      USING (((school_id IS NULL) OR (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pmt_select', 'payment_message_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pmt_select', 'payment_message_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pmt_select', 'payment_message_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pmt_update', 'payment_message_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "pmt_update" ON public."payment_message_templates"
      USING (((school_id IS NOT NULL) AND (school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_message_templates' AND p.policyname = 'pmt_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pmt_update', 'payment_message_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pmt_update', 'payment_message_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pmt_update', 'payment_message_templates';
  END IF;
END
$lote2$;
COMMIT;

-- payment_reminder_logs: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminder_logs' AND p.policyname = 'School staff can manage reminder logs';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School staff can manage reminder logs', 'payment_reminder_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_school_coach(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_school_coach(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "School staff can manage reminder logs" ON public."payment_reminder_logs"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(school_id)))
      WITH CHECK (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(school_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminder_logs' AND p.policyname = 'School staff can manage reminder logs';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School staff can manage reminder logs', 'payment_reminder_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School staff can manage reminder logs', 'payment_reminder_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School staff can manage reminder logs', 'payment_reminder_logs';
  END IF;
END
$lote2$;
COMMIT;

-- payment_reminders: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminders' AND p.policyname = 'Payment reminders: manage staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Payment reminders: manage staff', 'payment_reminders';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(payment_id IN ( SELECT payments.id
   FROM payments
  WHERE (payments.school_id = ANY (user_staff_school_ids()))))$o$
     AND c IS NOT DISTINCT FROM $o$(payment_id IN ( SELECT payments.id
   FROM payments
  WHERE (payments.school_id = ANY (user_staff_school_ids()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "Payment reminders: manage staff" ON public."payment_reminders"
      USING ((payment_id IN ( SELECT payments.id
   FROM payments
  WHERE (payments.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))))
      WITH CHECK ((payment_id IN ( SELECT payments.id
   FROM payments
  WHERE (payments.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminders' AND p.policyname = 'Payment reminders: manage staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Payment reminders: manage staff', 'payment_reminders';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Payment reminders: manage staff', 'payment_reminders';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Payment reminders: manage staff', 'payment_reminders';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminders' AND p.policyname = 'payment_reminders_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_reminders_select', 'payment_reminders';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = payment_reminders.payment_id) AND (p.parent_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (payments p
     JOIN school_members sm ON ((sm.school_id = p.school_id)))
  WHERE ((p.id = payment_reminders.payment_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_reminders_select" ON public."payment_reminders"
      USING (((EXISTS ( SELECT 1
   FROM payments p
  WHERE ((p.id = payment_reminders.payment_id) AND (p.parent_id = (SELECT auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM (payments p
     JOIN school_members sm ON ((sm.school_id = p.school_id)))
  WHERE ((p.id = payment_reminders.payment_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_reminders' AND p.policyname = 'payment_reminders_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_reminders_select', 'payment_reminders';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_reminders_select', 'payment_reminders';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_reminders_select', 'payment_reminders';
  END IF;
END
$lote2$;
COMMIT;

-- payment_splits: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_splits' AND p.policyname = 'payment_splits_select_by_school';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payment_splits_select_by_school', 'payment_splits';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(payment_id IN ( SELECT p.id
   FROM payments p
  WHERE (p.school_id IN ( SELECT sm.school_id
           FROM school_members sm
          WHERE ((sm.profile_id = auth.uid()) AND (sm.status = 'active'::text))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "payment_splits_select_by_school" ON public."payment_splits"
      USING ((payment_id IN ( SELECT p.id
   FROM payments p
  WHERE (p.school_id IN ( SELECT sm.school_id
           FROM school_members sm
          WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payment_splits' AND p.policyname = 'payment_splits_select_by_school';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payment_splits_select_by_school', 'payment_splits';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payment_splits_select_by_school', 'payment_splits';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payment_splits_select_by_school', 'payment_splits';
  END IF;
END
$lote2$;
COMMIT;

-- payroll_config: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payroll_config' AND p.policyname = 'payroll_config_sa_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payroll_config_sa_insert', 'payroll_config';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "payroll_config_sa_insert" ON public."payroll_config"
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payroll_config' AND p.policyname = 'payroll_config_sa_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payroll_config_sa_insert', 'payroll_config';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payroll_config_sa_insert', 'payroll_config';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payroll_config_sa_insert', 'payroll_config';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payroll_config' AND p.policyname = 'payroll_config_sa_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'payroll_config_sa_update', 'payroll_config';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "payroll_config_sa_update" ON public."payroll_config"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'payroll_config' AND p.policyname = 'payroll_config_sa_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'payroll_config_sa_update', 'payroll_config';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'payroll_config_sa_update', 'payroll_config';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'payroll_config_sa_update', 'payroll_config';
  END IF;
END
$lote2$;
COMMIT;

-- pending_card_saves: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'pending_card_saves' AND p.policyname = 'pending_card_saves_owner_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'pending_card_saves_owner_select', 'pending_card_saves';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "pending_card_saves_owner_select" ON public."pending_card_saves"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'pending_card_saves' AND p.policyname = 'pending_card_saves_owner_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'pending_card_saves_owner_select', 'pending_card_saves';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'pending_card_saves_owner_select', 'pending_card_saves';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'pending_card_saves_owner_select', 'pending_card_saves';
  END IF;
END
$lote2$;
COMMIT;

-- performance_entries: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_delete_school_only';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'performance_entries_delete_school_only', 'performance_entries';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "performance_entries_delete_school_only" ON public."performance_entries"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_delete_school_only';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'performance_entries_delete_school_only', 'performance_entries';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'performance_entries_delete_school_only', 'performance_entries';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'performance_entries_delete_school_only', 'performance_entries';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_insert_school_or_self';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'performance_entries_insert_school_or_self', 'performance_entries';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR ((subject_type = 'profile'::text) AND (subject_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "performance_entries_insert_school_or_self" ON public."performance_entries"
      WITH CHECK (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR ((subject_type = 'profile'::text) AND (subject_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_insert_school_or_self';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'performance_entries_insert_school_or_self', 'performance_entries';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'performance_entries_insert_school_or_self', 'performance_entries';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'performance_entries_insert_school_or_self', 'performance_entries';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_update_school_or_recorder';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'performance_entries_update_school_or_recorder', 'performance_entries';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (recorded_by = auth.uid()))$o$
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) OR (recorded_by = auth.uid()))$o$ THEN
    EXECUTE $a$ALTER POLICY "performance_entries_update_school_or_recorder" ON public."performance_entries"
      USING (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (recorded_by = (SELECT auth.uid()))))
      WITH CHECK (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) OR (recorded_by = (SELECT auth.uid()))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'performance_entries' AND p.policyname = 'performance_entries_update_school_or_recorder';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'performance_entries_update_school_or_recorder', 'performance_entries';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'performance_entries_update_school_or_recorder', 'performance_entries';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'performance_entries_update_school_or_recorder', 'performance_entries';
  END IF;
END
$lote2$;
COMMIT;

-- plan_upgrade_requests: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'plan_upgrade_requests_insert', 'plan_upgrade_requests';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "plan_upgrade_requests_insert" ON public."plan_upgrade_requests"
      WITH CHECK (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'plan_upgrade_requests_insert', 'plan_upgrade_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'plan_upgrade_requests_insert', 'plan_upgrade_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'plan_upgrade_requests_insert', 'plan_upgrade_requests';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'plan_upgrade_requests_select', 'plan_upgrade_requests';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "plan_upgrade_requests_select" ON public."plan_upgrade_requests"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'plan_upgrade_requests_select', 'plan_upgrade_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'plan_upgrade_requests_select', 'plan_upgrade_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'plan_upgrade_requests_select', 'plan_upgrade_requests';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_super_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'plan_upgrade_requests_super_admin_all', 'plan_upgrade_requests';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "plan_upgrade_requests_super_admin_all" ON public."plan_upgrade_requests"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_super_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'plan_upgrade_requests_super_admin_all', 'plan_upgrade_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'plan_upgrade_requests_super_admin_all', 'plan_upgrade_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'plan_upgrade_requests_super_admin_all', 'plan_upgrade_requests';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_super_admin_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'plan_upgrade_requests_super_admin_delete', 'plan_upgrade_requests';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "plan_upgrade_requests_super_admin_delete" ON public."plan_upgrade_requests"
      USING ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'plan_upgrade_requests' AND p.policyname = 'plan_upgrade_requests_super_admin_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'plan_upgrade_requests_super_admin_delete', 'plan_upgrade_requests';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'plan_upgrade_requests_super_admin_delete', 'plan_upgrade_requests';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'plan_upgrade_requests_super_admin_delete', 'plan_upgrade_requests';
  END IF;
END
$lote2$;
COMMIT;

-- platform_admins: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'platform_admins_insert', 'platform_admins';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((((auth.jwt() -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true)$o$ THEN
    EXECUTE $a$ALTER POLICY "platform_admins_insert" ON public."platform_admins"
      WITH CHECK ((((((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'platform_admins_insert', 'platform_admins';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'platform_admins_insert', 'platform_admins';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'platform_admins_insert', 'platform_admins';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'platform_admins_select', 'platform_admins';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((((auth.jwt() -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "platform_admins_select" ON public."platform_admins"
      USING ((((((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'platform_admins_select', 'platform_admins';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'platform_admins_select', 'platform_admins';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'platform_admins_select', 'platform_admins';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'platform_admins_update', 'platform_admins';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((((auth.jwt() -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "platform_admins_update" ON public."platform_admins"
      USING ((((((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'platform_admin'::text))::boolean = true))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'platform_admins' AND p.policyname = 'platform_admins_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'platform_admins_update', 'platform_admins';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'platform_admins_update', 'platform_admins';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'platform_admins_update', 'platform_admins';
  END IF;
END
$lote2$;
COMMIT;

-- product_questions: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_questions' AND p.policyname = 'Usuario crea pregunta';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Usuario crea pregunta', 'product_questions';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Usuario crea pregunta" ON public."product_questions"
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_questions' AND p.policyname = 'Usuario crea pregunta';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Usuario crea pregunta', 'product_questions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Usuario crea pregunta', 'product_questions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Usuario crea pregunta', 'product_questions';
  END IF;
END
$lote2$;
COMMIT;

-- product_review_media: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_media' AND p.policyname = 'Autor maneja media de su review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Autor maneja media de su review', 'product_review_media';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM product_reviews r
  WHERE ((r.id = product_review_media.review_id) AND (r.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM product_reviews r
  WHERE ((r.id = product_review_media.review_id) AND (r.user_id = auth.uid()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "Autor maneja media de su review" ON public."product_review_media"
      USING ((EXISTS ( SELECT 1
   FROM product_reviews r
  WHERE ((r.id = product_review_media.review_id) AND (r.user_id = (SELECT auth.uid()))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM product_reviews r
  WHERE ((r.id = product_review_media.review_id) AND (r.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_media' AND p.policyname = 'Autor maneja media de su review';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Autor maneja media de su review', 'product_review_media';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Autor maneja media de su review', 'product_review_media';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Autor maneja media de su review', 'product_review_media';
  END IF;
END
$lote2$;
COMMIT;

-- product_review_votes: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_votes' AND p.policyname = 'Usuario crea/cambia su voto';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Usuario crea/cambia su voto', 'product_review_votes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Usuario crea/cambia su voto" ON public."product_review_votes"
      USING ((user_id = (SELECT auth.uid())))
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_votes' AND p.policyname = 'Usuario crea/cambia su voto';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Usuario crea/cambia su voto', 'product_review_votes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Usuario crea/cambia su voto', 'product_review_votes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Usuario crea/cambia su voto', 'product_review_votes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_votes' AND p.policyname = 'Votos visibles para todos los autenticados';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Votos visibles para todos los autenticados', 'product_review_votes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.role() = 'authenticated'::text)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Votos visibles para todos los autenticados" ON public."product_review_votes"
      USING (((SELECT auth.role()) = 'authenticated'::text))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_review_votes' AND p.policyname = 'Votos visibles para todos los autenticados';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Votos visibles para todos los autenticados', 'product_review_votes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Votos visibles para todos los autenticados', 'product_review_votes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Votos visibles para todos los autenticados', 'product_review_votes';
  END IF;
END
$lote2$;
COMMIT;

-- product_reviews: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Autor edita su review en 24h';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Autor edita su review en 24h', 'product_reviews';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) AND (created_at > (now() - '24:00:00'::interval)))$o$
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "Autor edita su review en 24h" ON public."product_reviews"
      USING (((user_id = (SELECT auth.uid())) AND (created_at > (now() - '24:00:00'::interval))))
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Autor edita su review en 24h';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Autor edita su review en 24h', 'product_reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Autor edita su review en 24h', 'product_reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Autor edita su review en 24h', 'product_reviews';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Autor ve sus reviews (cualquier status)';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Autor ve sus reviews (cualquier status)', 'product_reviews';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Autor ve sus reviews (cualquier status)" ON public."product_reviews"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Autor ve sus reviews (cualquier status)';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Autor ve sus reviews (cualquier status)', 'product_reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Autor ve sus reviews (cualquier status)', 'product_reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Autor ve sus reviews (cualquier status)', 'product_reviews';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Solo verified purchasers crean reviews';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Solo verified purchasers crean reviews', 'product_reviews';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((user_id = auth.uid()) AND ((EXISTS ( SELECT 1
   FROM (orders o
     JOIN order_items oi ON ((oi.order_id = o.id)))
  WHERE ((oi.product_id = product_reviews.product_id) AND (o.user_id = auth.uid()) AND (o.status = 'delivered'::text)))) OR ( SELECT is_super_admin() AS is_super_admin)))$o$ THEN
    EXECUTE $a$ALTER POLICY "Solo verified purchasers crean reviews" ON public."product_reviews"
      WITH CHECK (((user_id = (SELECT auth.uid())) AND ((EXISTS ( SELECT 1
   FROM (orders o
     JOIN order_items oi ON ((oi.order_id = o.id)))
  WHERE ((oi.product_id = product_reviews.product_id) AND (o.user_id = (SELECT auth.uid())) AND (o.status = 'delivered'::text)))) OR ( SELECT is_super_admin() AS is_super_admin))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_reviews' AND p.policyname = 'Solo verified purchasers crean reviews';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Solo verified purchasers crean reviews', 'product_reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Solo verified purchasers crean reviews', 'product_reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Solo verified purchasers crean reviews', 'product_reviews';
  END IF;
END
$lote2$;
COMMIT;

-- product_variants: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'product_variants';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."product_variants"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'product_variants';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'product_variants';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'product_variants';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_select', 'product_variants';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(store_enabled() OR (EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = product_variants.product_id) AND (p.vendor_id = auth.uid())))) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "store_off_select" ON public."product_variants"
      USING (((SELECT public.store_enabled()) OR (EXISTS ( SELECT 1
   FROM products p
  WHERE ((p.id = product_variants.product_id) AND (p.vendor_id = (SELECT auth.uid()))))) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_select', 'product_variants';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_select', 'product_variants';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_select', 'product_variants';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_update', 'product_variants';
  END IF;
  IF q IS NOT DISTINCT FROM $o$store_enabled()$o$
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_update" ON public."product_variants"
      USING ((SELECT public.store_enabled()))
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'product_variants' AND p.policyname = 'store_off_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_update', 'product_variants';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_update', 'product_variants';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_update', 'product_variants';
  END IF;
END
$lote2$;
COMMIT;

-- products: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'products_select_school_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'products_select_school_members', 'products';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((visibility = 'school_only'::product_visibility) AND (active = true) AND (status = 'active'::text) AND (school_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = products.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "products_select_school_members" ON public."products"
      USING (((visibility = 'school_only'::product_visibility) AND (active = true) AND (status = 'active'::text) AND (school_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = products.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'products_select_school_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'products_select_school_members', 'products';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'products_select_school_members', 'products';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'products_select_school_members', 'products';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'products';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."products"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'products';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'products';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'products';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_select', 'products';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(store_enabled() OR (vendor_id = auth.uid()) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "store_off_select" ON public."products"
      USING (((SELECT public.store_enabled()) OR (vendor_id = (SELECT auth.uid())) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_select', 'products';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_select', 'products';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_select', 'products';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_update', 'products';
  END IF;
  IF q IS NOT DISTINCT FROM $o$store_enabled()$o$
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_update" ON public."products"
      USING ((SELECT public.store_enabled()))
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'products' AND p.policyname = 'store_off_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_update', 'products';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_update', 'products';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_update', 'products';
  END IF;
END
$lote2$;
COMMIT;

-- push_subscriptions: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'push_subscriptions_delete_own', 'push_subscriptions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "push_subscriptions_delete_own" ON public."push_subscriptions"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'push_subscriptions_delete_own', 'push_subscriptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'push_subscriptions_delete_own', 'push_subscriptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'push_subscriptions_delete_own', 'push_subscriptions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'push_subscriptions_insert_own', 'push_subscriptions';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "push_subscriptions_insert_own" ON public."push_subscriptions"
      WITH CHECK (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'push_subscriptions_insert_own', 'push_subscriptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'push_subscriptions_insert_own', 'push_subscriptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'push_subscriptions_insert_own', 'push_subscriptions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'push_subscriptions_select_own', 'push_subscriptions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "push_subscriptions_select_own" ON public."push_subscriptions"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'push_subscriptions' AND p.policyname = 'push_subscriptions_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'push_subscriptions_select_own', 'push_subscriptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'push_subscriptions_select_own', 'push_subscriptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'push_subscriptions_select_own', 'push_subscriptions';
  END IF;
END
$lote2$;
COMMIT;

-- refunds: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'refunds' AND p.policyname = 'refunds_owner_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'refunds_owner_read', 'refunds';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((auth.uid() = requested_by) OR (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = refunds.order_id) AND ((o.user_id = auth.uid()) OR (o.vendor_id = auth.uid()))))) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "refunds_owner_read" ON public."refunds"
      USING ((((SELECT auth.uid()) = requested_by) OR (EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = refunds.order_id) AND ((o.user_id = (SELECT auth.uid())) OR (o.vendor_id = (SELECT auth.uid())))))) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'refunds' AND p.policyname = 'refunds_owner_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'refunds_owner_read', 'refunds';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'refunds_owner_read', 'refunds';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'refunds_owner_read', 'refunds';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'refunds' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'refunds';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."refunds"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'refunds' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'refunds';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'refunds';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'refunds';
  END IF;
END
$lote2$;
COMMIT;

-- report_section_notes: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'report_section_notes_select_staff', 'report_section_notes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "report_section_notes_select_staff" ON public."report_section_notes"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'report_section_notes_select_staff', 'report_section_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'report_section_notes_select_staff', 'report_section_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'report_section_notes_select_staff', 'report_section_notes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_update_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'report_section_notes_update_staff', 'report_section_notes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "report_section_notes_update_staff" ON public."report_section_notes"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_update_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'report_section_notes_update_staff', 'report_section_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'report_section_notes_update_staff', 'report_section_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'report_section_notes_update_staff', 'report_section_notes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_write_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'report_section_notes_write_staff', 'report_section_notes';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "report_section_notes_write_staff" ON public."report_section_notes"
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_section_notes' AND p.policyname = 'report_section_notes_write_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'report_section_notes_write_staff', 'report_section_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'report_section_notes_write_staff', 'report_section_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'report_section_notes_write_staff', 'report_section_notes';
  END IF;
END
$lote2$;
COMMIT;

-- report_team_schedule: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_team_schedule' AND p.policyname = 'report_team_schedule_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'report_team_schedule_select', 'report_team_schedule';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "report_team_schedule_select" ON public."report_team_schedule"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'report_team_schedule' AND p.policyname = 'report_team_schedule_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'report_team_schedule_select', 'report_team_schedule';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'report_team_schedule_select', 'report_team_schedule';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'report_team_schedule_select', 'report_team_schedule';
  END IF;
END
$lote2$;
COMMIT;

-- reservation_payments: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'rp_own', 'reservation_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "rp_own" ON public."reservation_payments"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'rp_own', 'reservation_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'rp_own', 'reservation_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'rp_own', 'reservation_payments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_school_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'rp_school_select', 'reservation_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = reservation_payments.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "rp_school_select" ON public."reservation_payments"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = reservation_payments.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_school_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'rp_school_select', 'reservation_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'rp_school_select', 'reservation_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'rp_school_select', 'reservation_payments';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'rp_select_own', 'reservation_payments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "rp_select_own" ON public."reservation_payments"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reservation_payments' AND p.policyname = 'rp_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'rp_select_own', 'reservation_payments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'rp_select_own', 'reservation_payments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'rp_select_own', 'reservation_payments';
  END IF;
END
$lote2$;
COMMIT;

-- reviews: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'reviews_delete_own', 'reviews';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "reviews_delete_own" ON public."reviews"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'reviews_delete_own', 'reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'reviews_delete_own', 'reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'reviews_delete_own', 'reviews';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_insert_authenticated';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'reviews_insert_authenticated', 'reviews';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "reviews_insert_authenticated" ON public."reviews"
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_insert_authenticated';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'reviews_insert_authenticated', 'reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'reviews_insert_authenticated', 'reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'reviews_insert_authenticated', 'reviews';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'reviews_update_own', 'reviews';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "reviews_update_own" ON public."reviews"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'reviews' AND p.policyname = 'reviews_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'reviews_update_own', 'reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'reviews_update_own', 'reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'reviews_update_own', 'reviews';
  END IF;
END
$lote2$;
COMMIT;

-- roles: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'roles' AND p.policyname = 'roles_manage_platform_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'roles_manage_platform_admin', 'roles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_platform_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "roles_manage_platform_admin" ON public."roles"
      USING ((SELECT public.is_platform_admin()))
      WITH CHECK ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'roles' AND p.policyname = 'roles_manage_platform_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'roles_manage_platform_admin', 'roles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'roles_manage_platform_admin', 'roles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'roles_manage_platform_admin', 'roles';
  END IF;
END
$lote2$;
COMMIT;

-- school_addons: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_addons' AND p.policyname = 'school_addons_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_addons_select_admin', 'school_addons';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_addons_select_admin" ON public."school_addons"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_addons' AND p.policyname = 'school_addons_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_addons_select_admin', 'school_addons';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_addons_select_admin', 'school_addons';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_addons_select_admin', 'school_addons';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_addons' AND p.policyname = 'school_addons_super_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_addons_super_admin_all', 'school_addons';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_addons_super_admin_all" ON public."school_addons"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_addons' AND p.policyname = 'school_addons_super_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_addons_super_admin_all', 'school_addons';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_addons_super_admin_all', 'school_addons';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_addons_super_admin_all', 'school_addons';
  END IF;
END
$lote2$;
COMMIT;

-- school_availability: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_availability' AND p.policyname = 'sa_school_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sa_school_manage', 'school_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_availability.school_id) AND (sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_availability.school_id) AND (sm.profile_id = ( SELECT auth.uid() AS uid)) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "sa_school_manage" ON public."school_availability"
      USING ((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_availability.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_availability' AND p.policyname = 'sa_school_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sa_school_manage', 'school_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sa_school_manage', 'school_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sa_school_manage', 'school_availability';
  END IF;
END
$lote2$;
COMMIT;

-- school_billing_schedule: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_billing_schedule_delete', 'school_billing_schedule';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_billing_schedule_delete" ON public."school_billing_schedule"
      USING ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_billing_schedule_delete', 'school_billing_schedule';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_billing_schedule_delete', 'school_billing_schedule';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_billing_schedule_delete', 'school_billing_schedule';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_billing_schedule_insert', 'school_billing_schedule';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_billing_schedule_insert" ON public."school_billing_schedule"
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_billing_schedule_insert', 'school_billing_schedule';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_billing_schedule_insert', 'school_billing_schedule';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_billing_schedule_insert', 'school_billing_schedule';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_billing_schedule_select', 'school_billing_schedule';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR (school_id = ANY (user_admin_school_ids())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_billing_schedule_select" ON public."school_billing_schedule"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_billing_schedule_select', 'school_billing_schedule';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_billing_schedule_select', 'school_billing_schedule';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_billing_schedule_select', 'school_billing_schedule';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_billing_schedule_update', 'school_billing_schedule';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_billing_schedule_update" ON public."school_billing_schedule"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_billing_schedule' AND p.policyname = 'school_billing_schedule_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_billing_schedule_update', 'school_billing_schedule';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_billing_schedule_update', 'school_billing_schedule';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_billing_schedule_update', 'school_billing_schedule';
  END IF;
END
$lote2$;
COMMIT;

-- school_branches: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'Members can view branches';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Members can view branches', 'school_branches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_member(auth.uid(), school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Members can view branches" ON public."school_branches"
      USING (is_school_member((SELECT auth.uid()), school_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'Members can view branches';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Members can view branches', 'school_branches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Members can view branches', 'school_branches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Members can view branches', 'school_branches';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'School admins can manage branches';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School admins can manage branches', 'school_branches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "School admins can manage branches" ON public."school_branches"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'School admins can manage branches';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School admins can manage branches', 'school_branches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School admins can manage branches', 'school_branches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School admins can manage branches', 'school_branches';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'school_branches_read_policy';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_branches_read_policy', 'school_branches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_branches.school_id) AND (sm.profile_id = auth.uid())))) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_branches_read_policy" ON public."school_branches"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_branches.school_id) AND (sm.profile_id = (SELECT auth.uid()))))) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_branches' AND p.policyname = 'school_branches_read_policy';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_branches_read_policy', 'school_branches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_branches_read_policy', 'school_branches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_branches_read_policy', 'school_branches';
  END IF;
END
$lote2$;
COMMIT;

-- school_categories: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_manage_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_categories_manage_staff', 'school_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "school_categories_manage_staff" ON public."school_categories"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_manage_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_categories_manage_staff', 'school_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_categories_manage_staff', 'school_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_categories_manage_staff', 'school_categories';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_select_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_categories_select_members', 'school_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE (sm.profile_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_categories_select_members" ON public."school_categories"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE (sm.profile_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_select_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_categories_select_members', 'school_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_categories_select_members', 'school_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_categories_select_members', 'school_categories';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_categories_select_staff', 'school_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_categories_select_staff" ON public."school_categories"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_categories' AND p.policyname = 'school_categories_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_categories_select_staff', 'school_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_categories_select_staff', 'school_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_categories_select_staff', 'school_categories';
  END IF;
END
$lote2$;
COMMIT;

-- school_certificate_templates: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_certificate_templates' AND p.policyname = 'cert_templates_modify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cert_templates_modify', 'school_certificate_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "cert_templates_modify" ON public."school_certificate_templates"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_certificate_templates' AND p.policyname = 'cert_templates_modify';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cert_templates_modify', 'school_certificate_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cert_templates_modify', 'school_certificate_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cert_templates_modify', 'school_certificate_templates';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_certificate_templates' AND p.policyname = 'cert_templates_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'cert_templates_select', 'school_certificate_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id) OR (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_certificate_templates.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text)))) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.school_id = school_certificate_templates.school_id) AND (c.parent_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "cert_templates_select" ON public."school_certificate_templates"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = school_certificate_templates.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.school_id = school_certificate_templates.school_id) AND (c.parent_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_certificate_templates' AND p.policyname = 'cert_templates_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'cert_templates_select', 'school_certificate_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'cert_templates_select', 'school_certificate_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'cert_templates_select', 'school_certificate_templates';
  END IF;
END
$lote2$;
COMMIT;

-- school_courtesy_settings: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_courtesy_settings' AND p.policyname = 'school_courtesy_settings_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_courtesy_settings_admin_all', 'school_courtesy_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "school_courtesy_settings_admin_all" ON public."school_courtesy_settings"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_courtesy_settings' AND p.policyname = 'school_courtesy_settings_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_courtesy_settings_admin_all', 'school_courtesy_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_courtesy_settings_admin_all', 'school_courtesy_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_courtesy_settings_admin_all', 'school_courtesy_settings';
  END IF;
END
$lote2$;
COMMIT;

-- school_custom_domains: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_custom_domains' AND p.policyname = 'custom_domains_school_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'custom_domains_school_admin_select', 'school_custom_domains';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "custom_domains_school_admin_select" ON public."school_custom_domains"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (sm.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_custom_domains' AND p.policyname = 'custom_domains_school_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'custom_domains_school_admin_select', 'school_custom_domains';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'custom_domains_school_admin_select', 'school_custom_domains';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'custom_domains_school_admin_select', 'school_custom_domains';
  END IF;
END
$lote2$;
COMMIT;

-- school_join_qr_codes: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_join_qr_codes' AND p.policyname = 'school_join_qr_modify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_join_qr_modify', 'school_join_qr_codes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "school_join_qr_modify" ON public."school_join_qr_codes"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_join_qr_codes' AND p.policyname = 'school_join_qr_modify';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_join_qr_modify', 'school_join_qr_codes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_join_qr_modify', 'school_join_qr_codes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_join_qr_modify', 'school_join_qr_codes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_join_qr_codes' AND p.policyname = 'school_join_qr_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_join_qr_select', 'school_join_qr_codes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_join_qr_select" ON public."school_join_qr_codes"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_join_qr_codes' AND p.policyname = 'school_join_qr_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_join_qr_select', 'school_join_qr_codes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_join_qr_select', 'school_join_qr_codes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_join_qr_select', 'school_join_qr_codes';
  END IF;
END
$lote2$;
COMMIT;

-- school_merchandise_items: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_merchandise_items' AND p.policyname = 'school_merchandise_items_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_merchandise_items_select', 'school_merchandise_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(((active = true) AND (school_id = ANY (user_school_ids()))) OR is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_merchandise_items_select" ON public."school_merchandise_items"
      USING ((((active = true) AND (school_id = ANY ((SELECT public.user_school_ids())::uuid[]))) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_merchandise_items' AND p.policyname = 'school_merchandise_items_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_merchandise_items_select', 'school_merchandise_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_merchandise_items_select', 'school_merchandise_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_merchandise_items_select', 'school_merchandise_items';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_merchandise_items' AND p.policyname = 'school_merchandise_items_write';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_merchandise_items_write', 'school_merchandise_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "school_merchandise_items_write" ON public."school_merchandise_items"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))
      WITH CHECK (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_merchandise_items' AND p.policyname = 'school_merchandise_items_write';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_merchandise_items_write', 'school_merchandise_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_merchandise_items_write', 'school_merchandise_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_merchandise_items_write', 'school_merchandise_items';
  END IF;
END
$lote2$;
COMMIT;

-- school_module_overrides: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_module_overrides' AND p.policyname = 'school_module_overrides_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_module_overrides_select_admin', 'school_module_overrides';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_module_overrides_select_admin" ON public."school_module_overrides"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_module_overrides' AND p.policyname = 'school_module_overrides_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_module_overrides_select_admin', 'school_module_overrides';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_module_overrides_select_admin', 'school_module_overrides';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_module_overrides_select_admin', 'school_module_overrides';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_module_overrides' AND p.policyname = 'school_module_overrides_super_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_module_overrides_super_admin_all', 'school_module_overrides';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_module_overrides_super_admin_all" ON public."school_module_overrides"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_module_overrides' AND p.policyname = 'school_module_overrides_super_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_module_overrides_super_admin_all', 'school_module_overrides';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_module_overrides_super_admin_all', 'school_module_overrides';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_module_overrides_super_admin_all', 'school_module_overrides';
  END IF;
END
$lote2$;
COMMIT;

-- school_one_time_charges: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_one_time_charges_delete', 'school_one_time_charges';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_one_time_charges_delete" ON public."school_one_time_charges"
      USING ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_one_time_charges_delete', 'school_one_time_charges';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_one_time_charges_delete', 'school_one_time_charges';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_one_time_charges_delete', 'school_one_time_charges';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_one_time_charges_insert', 'school_one_time_charges';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_one_time_charges_insert" ON public."school_one_time_charges"
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_one_time_charges_insert', 'school_one_time_charges';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_one_time_charges_insert', 'school_one_time_charges';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_one_time_charges_insert', 'school_one_time_charges';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_one_time_charges_select', 'school_one_time_charges';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_super_admin() OR (school_id = ANY (user_admin_school_ids())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_one_time_charges_select" ON public."school_one_time_charges"
      USING (((SELECT public.is_super_admin()) OR (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_one_time_charges_select', 'school_one_time_charges';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_one_time_charges_select', 'school_one_time_charges';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_one_time_charges_select', 'school_one_time_charges';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_one_time_charges_update', 'school_one_time_charges';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_one_time_charges_update" ON public."school_one_time_charges"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_one_time_charges' AND p.policyname = 'school_one_time_charges_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_one_time_charges_update', 'school_one_time_charges';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_one_time_charges_update', 'school_one_time_charges';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_one_time_charges_update', 'school_one_time_charges';
  END IF;
END
$lote2$;
COMMIT;

-- school_payment_providers: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_payment_providers' AND p.policyname = 'school_payment_providers_owner_write';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_payment_providers_owner_write', 'school_payment_providers';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM schools s
  WHERE ((s.id = school_payment_providers.school_id) AND ((s.owner_id = auth.uid()) OR ( SELECT is_super_admin() AS is_super_admin)))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM schools s
  WHERE ((s.id = school_payment_providers.school_id) AND ((s.owner_id = auth.uid()) OR ( SELECT is_super_admin() AS is_super_admin)))))$o$ THEN
    EXECUTE $a$ALTER POLICY "school_payment_providers_owner_write" ON public."school_payment_providers"
      USING ((EXISTS ( SELECT 1
   FROM schools s
  WHERE ((s.id = school_payment_providers.school_id) AND ((s.owner_id = (SELECT auth.uid())) OR ( SELECT is_super_admin() AS is_super_admin))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM schools s
  WHERE ((s.id = school_payment_providers.school_id) AND ((s.owner_id = (SELECT auth.uid())) OR ( SELECT is_super_admin() AS is_super_admin))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_payment_providers' AND p.policyname = 'school_payment_providers_owner_write';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_payment_providers_owner_write', 'school_payment_providers';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_payment_providers_owner_write', 'school_payment_providers';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_payment_providers_owner_write', 'school_payment_providers';
  END IF;
END
$lote2$;
COMMIT;

-- school_referrals: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_referrals' AND p.policyname = 'referrals_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'referrals_select_own', 'school_referrals';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(referrer_school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "referrals_select_own" ON public."school_referrals"
      USING ((referrer_school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_referrals' AND p.policyname = 'referrals_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'referrals_select_own', 'school_referrals';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'referrals_select_own', 'school_referrals';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'referrals_select_own', 'school_referrals';
  END IF;
END
$lote2$;
COMMIT;

-- school_settings: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'Admin puede escribir school_settings';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Admin puede escribir school_settings', 'school_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "Admin puede escribir school_settings" ON public."school_settings"
      USING ((school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = (SELECT auth.uid())))))
      WITH CHECK ((school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'Admin puede escribir school_settings';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Admin puede escribir school_settings', 'school_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Admin puede escribir school_settings', 'school_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Admin puede escribir school_settings', 'school_settings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'Admin puede leer school_settings';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Admin puede leer school_settings', 'school_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Admin puede leer school_settings" ON public."school_settings"
      USING ((school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'Admin puede leer school_settings';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Admin puede leer school_settings', 'school_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Admin puede leer school_settings', 'school_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Admin puede leer school_settings', 'school_settings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'School settings: manage admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School settings: manage admin', 'school_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "School settings: manage admin" ON public."school_settings"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'School settings: manage admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School settings: manage admin', 'school_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School settings: manage admin', 'school_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School settings: manage admin', 'school_settings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'School settings: select members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School settings: select members', 'school_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School settings: select members" ON public."school_settings"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_settings' AND p.policyname = 'School settings: select members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School settings: select members', 'school_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School settings: select members', 'school_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School settings: select members', 'school_settings';
  END IF;
END
$lote2$;
COMMIT;

-- school_staff: 14 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can delete staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School owners can delete staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School owners can delete staff" ON public."school_staff"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can delete staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School owners can delete staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School owners can delete staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School owners can delete staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can insert staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School owners can insert staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$ THEN
    EXECUTE $a$ALTER POLICY "School owners can insert staff" ON public."school_staff"
      WITH CHECK ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can insert staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School owners can insert staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School owners can insert staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School owners can insert staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can update staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School owners can update staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School owners can update staff" ON public."school_staff"
      USING ((school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'School owners can update staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School owners can update staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School owners can update staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School owners can update staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff manage themselves';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Staff manage themselves', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(email = auth.email())$o$
     AND c IS NOT DISTINCT FROM $o$((email = auth.email()) AND (school_id = ANY (user_school_ids())))$o$ THEN
    EXECUTE $a$ALTER POLICY "Staff manage themselves" ON public."school_staff"
      USING ((email = (SELECT auth.email())))
      WITH CHECK (((email = (SELECT auth.email())) AND (school_id = ANY ((SELECT public.user_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff manage themselves';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Staff manage themselves', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Staff manage themselves', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Staff manage themselves', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: manage admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Staff: manage admin', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Staff: manage admin" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: manage admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Staff: manage admin', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Staff: manage admin', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Staff: manage admin', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: manage own school';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Staff: manage own school', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "Staff: manage own school" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: manage own school';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Staff: manage own school', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Staff: manage own school', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Staff: manage own school', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: select own school';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Staff: select own school', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Staff: select own school" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: select own school';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Staff: select own school', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Staff: select own school', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Staff: select own school', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: select school';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Staff: select school', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Staff: select school" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'Staff: select school';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Staff: select school', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Staff: select school', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Staff: select school', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'coach_read_own_record';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'coach_read_own_record', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(coach_auth_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "coach_read_own_record" ON public."school_staff"
      USING ((coach_auth_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'coach_read_own_record';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'coach_read_own_record', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'coach_read_own_record', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'coach_read_own_record', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_delete_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_members_delete_staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_members_delete_staff" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_delete_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_members_delete_staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_members_delete_staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_members_delete_staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_insert_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_members_insert_staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "school_members_insert_staff" ON public."school_staff"
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_insert_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_members_insert_staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_members_insert_staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_members_insert_staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_read_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_members_read_staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_members_read_staff" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_read_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_members_read_staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_members_read_staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_members_read_staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_update_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_members_update_staff', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "school_members_update_staff" ON public."school_staff"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'school_members_update_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_members_update_staff', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_members_update_staff', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_members_update_staff', 'school_staff';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'staff_select_propia_ficha_por_correo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'staff_select_propia_ficha_por_correo', 'school_staff';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(email = auth.email())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "staff_select_propia_ficha_por_correo" ON public."school_staff"
      USING ((email = (SELECT auth.email())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_staff' AND p.policyname = 'staff_select_propia_ficha_por_correo';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'staff_select_propia_ficha_por_correo', 'school_staff';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'staff_select_propia_ficha_por_correo', 'school_staff';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'staff_select_propia_ficha_por_correo', 'school_staff';
  END IF;
END
$lote2$;
COMMIT;

-- school_subscription_invoices: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscription_invoices' AND p.policyname = 'school_subscription_invoices_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_subscription_invoices_select', 'school_subscription_invoices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(( SELECT is_school_admin(school_subscription_invoices.school_id) AS is_school_admin) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_subscription_invoices_select" ON public."school_subscription_invoices"
      USING ((( SELECT (school_subscription_invoices.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) AS is_school_admin) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscription_invoices' AND p.policyname = 'school_subscription_invoices_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_subscription_invoices_select', 'school_subscription_invoices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_subscription_invoices_select', 'school_subscription_invoices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_subscription_invoices_select', 'school_subscription_invoices';
  END IF;
END
$lote2$;
COMMIT;

-- school_subscriptions: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscriptions' AND p.policyname = 'school_subscriptions_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_subscriptions_select_admin', 'school_subscriptions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_subscriptions_select_admin" ON public."school_subscriptions"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscriptions' AND p.policyname = 'school_subscriptions_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_subscriptions_select_admin', 'school_subscriptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_subscriptions_select_admin', 'school_subscriptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_subscriptions_select_admin', 'school_subscriptions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscriptions' AND p.policyname = 'school_subscriptions_super_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_subscriptions_super_admin_all', 'school_subscriptions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_super_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_super_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "school_subscriptions_super_admin_all" ON public."school_subscriptions"
      USING ((SELECT public.is_super_admin()))
      WITH CHECK ((SELECT public.is_super_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_subscriptions' AND p.policyname = 'school_subscriptions_super_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_subscriptions_super_admin_all', 'school_subscriptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_subscriptions_super_admin_all', 'school_subscriptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_subscriptions_super_admin_all', 'school_subscriptions';
  END IF;
END
$lote2$;
COMMIT;

-- school_tournament_items: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_tournament_items' AND p.policyname = 'school_tournament_items_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_tournament_items_select', 'school_tournament_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(((active = true) AND (school_id = ANY (user_school_ids()))) OR is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_tournament_items_select" ON public."school_tournament_items"
      USING ((((active = true) AND (school_id = ANY ((SELECT public.user_school_ids())::uuid[]))) OR (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_tournament_items' AND p.policyname = 'school_tournament_items_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_tournament_items_select', 'school_tournament_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_tournament_items_select', 'school_tournament_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_tournament_items_select', 'school_tournament_items';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_tournament_items' AND p.policyname = 'school_tournament_items_write';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_tournament_items_write', 'school_tournament_items';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$
     AND c IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "school_tournament_items_write" ON public."school_tournament_items"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))
      WITH CHECK (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_tournament_items' AND p.policyname = 'school_tournament_items_write';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_tournament_items_write', 'school_tournament_items';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_tournament_items_write', 'school_tournament_items';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_tournament_items_write', 'school_tournament_items';
  END IF;
END
$lote2$;
COMMIT;

-- school_trial_class_settings: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_trial_class_settings' AND p.policyname = 'school_trial_class_settings_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_trial_class_settings_select_admin', 'school_trial_class_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "school_trial_class_settings_select_admin" ON public."school_trial_class_settings"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_trial_class_settings' AND p.policyname = 'school_trial_class_settings_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_trial_class_settings_select_admin', 'school_trial_class_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_trial_class_settings_select_admin', 'school_trial_class_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_trial_class_settings_select_admin', 'school_trial_class_settings';
  END IF;
END
$lote2$;
COMMIT;

-- school_whatsapp_integrations: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_whatsapp_integrations' AND p.policyname = 'wa_integration_owner_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_integration_owner_select', 'school_whatsapp_integrations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_integration_owner_select" ON public."school_whatsapp_integrations"
      USING ((school_id IN ( SELECT schools.id
   FROM schools
  WHERE (schools.owner_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'school_whatsapp_integrations' AND p.policyname = 'wa_integration_owner_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_integration_owner_select', 'school_whatsapp_integrations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_integration_owner_select', 'school_whatsapp_integrations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_integration_owner_select', 'school_whatsapp_integrations';
  END IF;
END
$lote2$;
COMMIT;

-- schools: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'schools' AND p.policyname = 'Schools: manage owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Schools: manage owner', 'schools';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = owner_id)$o$
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = owner_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "Schools: manage owner" ON public."schools"
      USING (((SELECT auth.uid()) = owner_id))
      WITH CHECK (((SELECT auth.uid()) = owner_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'schools' AND p.policyname = 'Schools: manage owner';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Schools: manage owner', 'schools';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Schools: manage owner', 'schools';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Schools: manage owner', 'schools';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'schools' AND p.policyname = 'school_admin_update_branding';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'school_admin_update_branding', 'schools';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text))))$o$
     AND c IS NOT DISTINCT FROM $o$(id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text))))$o$ THEN
    EXECUTE $a$ALTER POLICY "school_admin_update_branding" ON public."schools"
      USING ((id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text)))))
      WITH CHECK ((id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.role = ANY (ARRAY['owner'::text, 'super_admin'::text, 'admin'::text, 'school_admin'::text])) AND (school_members.status = 'active'::text)))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'schools' AND p.policyname = 'school_admin_update_branding';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'school_admin_update_branding', 'schools';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'school_admin_update_branding', 'schools';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'school_admin_update_branding', 'schools';
  END IF;
END
$lote2$;
COMMIT;

-- security_audit_log: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'security_audit_log' AND p.policyname = 'audit_log_select_platform_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'audit_log_select_platform_admin', 'security_audit_log';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "audit_log_select_platform_admin" ON public."security_audit_log"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'security_audit_log' AND p.policyname = 'audit_log_select_platform_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'audit_log_select_platform_admin', 'security_audit_log';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'audit_log_select_platform_admin', 'security_audit_log';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'audit_log_select_platform_admin', 'security_audit_log';
  END IF;
END
$lote2$;
COMMIT;

-- service_availability: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_availability' AND p.policyname = 'service_availability_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_availability_owner', 'service_availability';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vp.id
   FROM vendor_profiles vp
  WHERE (vp.user_id = ( SELECT auth.uid() AS uid))))$o$ THEN
    EXECUTE $a$ALTER POLICY "service_availability_owner" ON public."service_availability"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_availability' AND p.policyname = 'service_availability_owner';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_availability_owner', 'service_availability';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_availability_owner', 'service_availability';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_availability_owner', 'service_availability';
  END IF;
END
$lote2$;
COMMIT;

-- service_listings: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_listings_delete_own', 'service_listings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "service_listings_delete_own" ON public."service_listings"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_listings_delete_own', 'service_listings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_listings_delete_own', 'service_listings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_listings_delete_own', 'service_listings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_listings_insert_own', 'service_listings';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "service_listings_insert_own" ON public."service_listings"
      WITH CHECK ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_listings_insert_own', 'service_listings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_listings_insert_own', 'service_listings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_listings_insert_own', 'service_listings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_listings_select_own', 'service_listings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "service_listings_select_own" ON public."service_listings"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_listings_select_own', 'service_listings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_listings_select_own', 'service_listings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_listings_select_own', 'service_listings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_listings_update_own', 'service_listings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "service_listings_update_own" ON public."service_listings"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_listings' AND p.policyname = 'service_listings_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_listings_update_own', 'service_listings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_listings_update_own', 'service_listings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_listings_update_own', 'service_listings';
  END IF;
END
$lote2$;
COMMIT;

-- service_variations: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_variations' AND p.policyname = 'service_variations_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'service_variations_owner', 'service_variations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (service_listings sl
     JOIN vendor_profiles vp ON ((vp.id = sl.vendor_profile_id)))
  WHERE ((sl.id = service_variations.service_listing_id) AND (vp.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (service_listings sl
     JOIN vendor_profiles vp ON ((vp.id = sl.vendor_profile_id)))
  WHERE ((sl.id = service_variations.service_listing_id) AND (vp.user_id = ( SELECT auth.uid() AS uid)))))$o$ THEN
    EXECUTE $a$ALTER POLICY "service_variations_owner" ON public."service_variations"
      USING ((EXISTS ( SELECT 1
   FROM (service_listings sl
     JOIN vendor_profiles vp ON ((vp.id = sl.vendor_profile_id)))
  WHERE ((sl.id = service_variations.service_listing_id) AND (vp.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'service_variations' AND p.policyname = 'service_variations_owner';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'service_variations_owner', 'service_variations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'service_variations_owner', 'service_variations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'service_variations_owner', 'service_variations';
  END IF;
END
$lote2$;
COMMIT;

-- session_attendance: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_attendance_delete', 'session_attendance';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND is_school_admin(t.school_id))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "session_attendance_delete" ON public."session_attendance"
      USING ((EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND (t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_attendance_delete', 'session_attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_attendance_delete', 'session_attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_attendance_delete', 'session_attendance';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_attendance_insert', 'session_attendance';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND (is_school_admin(t.school_id) OR is_school_coach(t.school_id)))))$o$ THEN
    EXECUTE $a$ALTER POLICY "session_attendance_insert" ON public."session_attendance"
      WITH CHECK ((EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND ((t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(t.school_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_attendance_insert', 'session_attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_attendance_insert', 'session_attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_attendance_insert', 'session_attendance';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_attendance_select', 'session_attendance';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND (is_school_admin(t.school_id) OR is_school_coach(t.school_id)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "session_attendance_select" ON public."session_attendance"
      USING ((EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND ((t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(t.school_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_attendance_select', 'session_attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_attendance_select', 'session_attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_attendance_select', 'session_attendance';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_attendance_select_own', 'session_attendance';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(player_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "session_attendance_select_own" ON public."session_attendance"
      USING ((player_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_attendance_select_own', 'session_attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_attendance_select_own', 'session_attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_attendance_select_own', 'session_attendance';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_attendance_update', 'session_attendance';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND (is_school_admin(t.school_id) OR is_school_coach(t.school_id)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "session_attendance_update" ON public."session_attendance"
      USING ((EXISTS ( SELECT 1
   FROM (training_slots ts
     JOIN teams t ON ((t.id = ts.team_id)))
  WHERE ((ts.id = session_attendance.session_id) AND ((t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR is_school_coach(t.school_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_attendance' AND p.policyname = 'session_attendance_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_attendance_update', 'session_attendance';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_attendance_update', 'session_attendance';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_attendance_update', 'session_attendance';
  END IF;
END
$lote2$;
COMMIT;

-- session_bookings: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_insert_with_enrollment';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_bookings_insert_with_enrollment', 'session_bookings';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.user_id = auth.uid()) AND (e.school_id = session_bookings.school_id) AND (e.status = 'active'::text))))) OR ((child_id IS NOT NULL) AND is_parent_of_child(child_id) AND (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.child_id = session_bookings.child_id) AND (e.school_id = session_bookings.school_id) AND (e.status = 'active'::text))))))$o$ THEN
    EXECUTE $a$ALTER POLICY "session_bookings_insert_with_enrollment" ON public."session_bookings"
      WITH CHECK ((((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.user_id = (SELECT auth.uid())) AND (e.school_id = session_bookings.school_id) AND (e.status = 'active'::text))))) OR ((child_id IS NOT NULL) AND is_parent_of_child(child_id) AND (EXISTS ( SELECT 1
   FROM enrollments e
  WHERE ((e.child_id = session_bookings.child_id) AND (e.school_id = session_bookings.school_id) AND (e.status = 'active'::text)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_insert_with_enrollment';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_bookings_insert_with_enrollment', 'session_bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_bookings_insert_with_enrollment', 'session_bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_bookings_insert_with_enrollment', 'session_bookings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_bookings_select_own', 'session_bookings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_parent_of_child(child_id) OR (school_id = ANY (user_school_ids())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "session_bookings_select_own" ON public."session_bookings"
      USING (((user_id = (SELECT auth.uid())) OR is_parent_of_child(child_id) OR (school_id = ANY ((SELECT public.user_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_bookings_select_own', 'session_bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_bookings_select_own', 'session_bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_bookings_select_own', 'session_bookings';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_update_cancel';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'session_bookings_update_cancel', 'session_bookings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_parent_of_child(child_id) OR (school_id = ANY (user_staff_school_ids())))$o$
     AND c IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_parent_of_child(child_id) OR (school_id = ANY (user_staff_school_ids())))$o$ THEN
    EXECUTE $a$ALTER POLICY "session_bookings_update_cancel" ON public."session_bookings"
      USING (((user_id = (SELECT auth.uid())) OR is_parent_of_child(child_id) OR (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))))
      WITH CHECK (((user_id = (SELECT auth.uid())) OR is_parent_of_child(child_id) OR (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_bookings' AND p.policyname = 'session_bookings_update_cancel';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'session_bookings_update_cancel', 'session_bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'session_bookings_update_cancel', 'session_bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'session_bookings_update_cancel', 'session_bookings';
  END IF;
END
$lote2$;
COMMIT;

-- session_exercise_results: 6 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_delete', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(recorded_by = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ser_delete" ON public."session_exercise_results"
      USING ((recorded_by = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_delete', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_delete', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_delete', 'session_exercise_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_insert', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((recorded_by = auth.uid()) AND ((session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id = auth.uid()))) OR (session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.trainer_id = auth.uid())))))$o$ THEN
    EXECUTE $a$ALTER POLICY "ser_insert" ON public."session_exercise_results"
      WITH CHECK (((recorded_by = (SELECT auth.uid())) AND ((session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id = (SELECT auth.uid())))) OR (session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.trainer_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_insert', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_insert', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_insert', 'session_exercise_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_client';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_select_client', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ser_select_client" ON public."session_exercise_results"
      USING ((session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_client';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_select_client', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_select_client', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_select_client', 'session_exercise_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_parent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_select_parent', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ser_select_parent" ON public."session_exercise_results"
      USING ((session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.client_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_parent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_select_parent', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_select_parent', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_select_parent', 'session_exercise_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_trainer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_select_trainer', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.trainer_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ser_select_trainer" ON public."session_exercise_results"
      USING ((session_plan_id IN ( SELECT trainer_session_plans.id
   FROM trainer_session_plans
  WHERE (trainer_session_plans.trainer_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_select_trainer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_select_trainer', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_select_trainer', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_select_trainer', 'session_exercise_results';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ser_update', 'session_exercise_results';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(recorded_by = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ser_update" ON public."session_exercise_results"
      USING ((recorded_by = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'session_exercise_results' AND p.policyname = 'ser_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ser_update', 'session_exercise_results';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ser_update', 'session_exercise_results';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ser_update', 'session_exercise_results';
  END IF;
END
$lote2$;
COMMIT;

-- settlements: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'settlements' AND p.policyname = 'Vendor lee sus settlements';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Vendor lee sus settlements', 'settlements';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = settlements.vendor_profile_id) AND (vp.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Vendor lee sus settlements" ON public."settlements"
      USING ((EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = settlements.vendor_profile_id) AND (vp.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'settlements' AND p.policyname = 'Vendor lee sus settlements';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Vendor lee sus settlements', 'settlements';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Vendor lee sus settlements', 'settlements';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Vendor lee sus settlements', 'settlements';
  END IF;
END
$lote2$;
COMMIT;

-- shipments: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'shipments' AND p.policyname = 'shipments_select_buyer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'shipments_select_buyer', 'shipments';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = shipments.order_id) AND (o.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "shipments_select_buyer" ON public."shipments"
      USING ((EXISTS ( SELECT 1
   FROM orders o
  WHERE ((o.id = shipments.order_id) AND (o.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'shipments' AND p.policyname = 'shipments_select_buyer';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'shipments_select_buyer', 'shipments';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'shipments_select_buyer', 'shipments';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'shipments_select_buyer', 'shipments';
  END IF;
END
$lote2$;
COMMIT;

-- skill_biomech_evidence: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'skill_biomech_evidence' AND p.policyname = 'sbe_athlete_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sbe_athlete_read', 'skill_biomech_evidence';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = skill_biomech_evidence.capture_id) AND (bc.athlete_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "sbe_athlete_read" ON public."skill_biomech_evidence"
      USING ((EXISTS ( SELECT 1
   FROM biomech_captures bc
  WHERE ((bc.id = skill_biomech_evidence.capture_id) AND (bc.athlete_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'skill_biomech_evidence' AND p.policyname = 'sbe_athlete_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sbe_athlete_read', 'skill_biomech_evidence';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sbe_athlete_read', 'skill_biomech_evidence';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sbe_athlete_read', 'skill_biomech_evidence';
  END IF;
END
$lote2$;
COMMIT;

-- sport_category_templates: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_category_templates' AND p.policyname = 'sport_cat_templates_admin_write';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sport_cat_templates_admin_write', 'sport_category_templates';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_platform_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "sport_cat_templates_admin_write" ON public."sport_category_templates"
      USING ((SELECT public.is_platform_admin()))
      WITH CHECK ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_category_templates' AND p.policyname = 'sport_cat_templates_admin_write';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sport_cat_templates_admin_write', 'sport_category_templates';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sport_cat_templates_admin_write', 'sport_category_templates';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sport_cat_templates_admin_write', 'sport_category_templates';
  END IF;
END
$lote2$;
COMMIT;

-- sport_configs: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_delete_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sport_configs_delete_admin', 'sport_configs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "sport_configs_delete_admin" ON public."sport_configs"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_delete_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sport_configs_delete_admin', 'sport_configs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sport_configs_delete_admin', 'sport_configs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sport_configs_delete_admin', 'sport_configs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_insert_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sport_configs_insert_admin', 'sport_configs';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "sport_configs_insert_admin" ON public."sport_configs"
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_insert_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sport_configs_insert_admin', 'sport_configs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sport_configs_insert_admin', 'sport_configs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sport_configs_insert_admin', 'sport_configs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_select_school_members';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sport_configs_select_school_members', 'sport_configs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT unnest(user_school_ids()) AS unnest))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "sport_configs_select_school_members" ON public."sport_configs"
      USING ((school_id IN ( SELECT unnest((SELECT public.user_school_ids())) AS unnest)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_select_school_members';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sport_configs_select_school_members', 'sport_configs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sport_configs_select_school_members', 'sport_configs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sport_configs_select_school_members', 'sport_configs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_update_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sport_configs_update_admin', 'sport_configs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "sport_configs_update_admin" ON public."sport_configs"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sport_configs' AND p.policyname = 'sport_configs_update_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sport_configs_update_admin', 'sport_configs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sport_configs_update_admin', 'sport_configs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sport_configs_update_admin', 'sport_configs';
  END IF;
END
$lote2$;
COMMIT;

-- sports_categories: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sports_categories' AND p.policyname = 'sports_categories_manage_platform_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sports_categories_manage_platform_admin', 'sports_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_platform_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "sports_categories_manage_platform_admin" ON public."sports_categories"
      USING ((SELECT public.is_platform_admin()))
      WITH CHECK ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sports_categories' AND p.policyname = 'sports_categories_manage_platform_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sports_categories_manage_platform_admin', 'sports_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sports_categories_manage_platform_admin', 'sports_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sports_categories_manage_platform_admin', 'sports_categories';
  END IF;
END
$lote2$;
COMMIT;

-- sports_equipment: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sports_equipment' AND p.policyname = 'sports_equipment_manage_platform_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sports_equipment_manage_platform_admin', 'sports_equipment';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_platform_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "sports_equipment_manage_platform_admin" ON public."sports_equipment"
      USING ((SELECT public.is_platform_admin()))
      WITH CHECK ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'sports_equipment' AND p.policyname = 'sports_equipment_manage_platform_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sports_equipment_manage_platform_admin', 'sports_equipment';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sports_equipment_manage_platform_admin', 'sports_equipment';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sports_equipment_manage_platform_admin', 'sports_equipment';
  END IF;
END
$lote2$;
COMMIT;

-- store_conversations: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_conv_insert', 'store_conversations';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(buyer_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "store_conv_insert" ON public."store_conversations"
      WITH CHECK ((buyer_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_conv_insert', 'store_conversations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_conv_insert', 'store_conversations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_conv_insert', 'store_conversations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_conv_read', 'store_conversations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((buyer_id = auth.uid()) OR is_store_vendor(vendor_profile_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "store_conv_read" ON public."store_conversations"
      USING (((buyer_id = (SELECT auth.uid())) OR is_store_vendor(vendor_profile_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_conv_read', 'store_conversations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_conv_read', 'store_conversations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_conv_read', 'store_conversations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_conv_update', 'store_conversations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((buyer_id = auth.uid()) OR is_store_vendor(vendor_profile_id))$o$
     AND c IS NOT DISTINCT FROM $o$((buyer_id = auth.uid()) OR is_store_vendor(vendor_profile_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "store_conv_update" ON public."store_conversations"
      USING (((buyer_id = (SELECT auth.uid())) OR is_store_vendor(vendor_profile_id)))
      WITH CHECK (((buyer_id = (SELECT auth.uid())) OR is_store_vendor(vendor_profile_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_conversations' AND p.policyname = 'store_conv_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_conv_update', 'store_conversations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_conv_update', 'store_conversations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_conv_update', 'store_conversations';
  END IF;
END
$lote2$;
COMMIT;

-- store_messages: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_msg_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_msg_insert', 'store_messages';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((sender_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM store_conversations c
  WHERE ((c.id = store_messages.conversation_id) AND ((c.buyer_id = auth.uid()) OR is_store_vendor(c.vendor_profile_id))))))$o$ THEN
    EXECUTE $a$ALTER POLICY "store_msg_insert" ON public."store_messages"
      WITH CHECK (((sender_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM store_conversations c
  WHERE ((c.id = store_messages.conversation_id) AND ((c.buyer_id = (SELECT auth.uid())) OR is_store_vendor(c.vendor_profile_id)))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_msg_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_msg_insert', 'store_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_msg_insert', 'store_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_msg_insert', 'store_messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_msg_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_msg_read', 'store_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM store_conversations c
  WHERE ((c.id = store_messages.conversation_id) AND ((c.buyer_id = auth.uid()) OR is_store_vendor(c.vendor_profile_id)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "store_msg_read" ON public."store_messages"
      USING ((EXISTS ( SELECT 1
   FROM store_conversations c
  WHERE ((c.id = store_messages.conversation_id) AND ((c.buyer_id = (SELECT auth.uid())) OR is_store_vendor(c.vendor_profile_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_msg_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_msg_read', 'store_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_msg_read', 'store_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_msg_read', 'store_messages';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_off_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'store_off_insert', 'store_messages';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$store_enabled()$o$ THEN
    EXECUTE $a$ALTER POLICY "store_off_insert" ON public."store_messages"
      WITH CHECK ((SELECT public.store_enabled()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'store_messages' AND p.policyname = 'store_off_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'store_off_insert', 'store_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'store_off_insert', 'store_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'store_off_insert', 'store_messages';
  END IF;
END
$lote2$;
COMMIT;

-- subscription_plans: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'subscription_plans' AND p.policyname = 'sub_plans_owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'sub_plans_owner', 'subscription_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM $o$(vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "sub_plans_owner" ON public."subscription_plans"
      USING ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))
      WITH CHECK ((vendor_profile_id IN ( SELECT vendor_profiles.id
   FROM vendor_profiles
  WHERE (vendor_profiles.user_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'subscription_plans' AND p.policyname = 'sub_plans_owner';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'sub_plans_owner', 'subscription_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'sub_plans_owner', 'subscription_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'sub_plans_owner', 'subscription_plans';
  END IF;
END
$lote2$;
COMMIT;

-- support_messages: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_messages' AND p.policyname = 'messages_select_agent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'messages_select_agent', 'support_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_support_agent()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "messages_select_agent" ON public."support_messages"
      USING ((SELECT public.is_support_agent()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_messages' AND p.policyname = 'messages_select_agent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'messages_select_agent', 'support_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'messages_select_agent', 'support_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'messages_select_agent', 'support_messages';
  END IF;
END
$lote2$;
COMMIT;

-- support_tickets: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_select_agent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tickets_select_agent', 'support_tickets';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_support_agent()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tickets_select_agent" ON public."support_tickets"
      USING ((SELECT public.is_support_agent()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_select_agent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tickets_select_agent', 'support_tickets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tickets_select_agent', 'support_tickets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tickets_select_agent', 'support_tickets';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tickets_select_own', 'support_tickets';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(requester_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tickets_select_own" ON public."support_tickets"
      USING ((requester_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tickets_select_own', 'support_tickets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tickets_select_own', 'support_tickets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tickets_select_own', 'support_tickets';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_update_agent';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tickets_update_agent', 'support_tickets';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_support_agent()$o$
     AND c IS NOT DISTINCT FROM $o$is_support_agent()$o$ THEN
    EXECUTE $a$ALTER POLICY "tickets_update_agent" ON public."support_tickets"
      USING ((SELECT public.is_support_agent()))
      WITH CHECK ((SELECT public.is_support_agent()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'support_tickets' AND p.policyname = 'tickets_update_agent';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tickets_update_agent', 'support_tickets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tickets_update_agent', 'support_tickets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tickets_update_agent', 'support_tickets';
  END IF;
END
$lote2$;
COMMIT;

-- system_errors: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'system_errors' AND p.policyname = 'system_errors_platform_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'system_errors_platform_admin_select', 'system_errors';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "system_errors_platform_admin_select" ON public."system_errors"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'system_errors' AND p.policyname = 'system_errors_platform_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'system_errors_platform_admin_select', 'system_errors';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'system_errors_platform_admin_select', 'system_errors';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'system_errors_platform_admin_select', 'system_errors';
  END IF;
END
$lote2$;
COMMIT;

-- tactical_rival_teams: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tactical_rival_teams_delete', 'tactical_rival_teams';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tactical_rival_teams_delete" ON public."tactical_rival_teams"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tactical_rival_teams_delete', 'tactical_rival_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tactical_rival_teams_delete', 'tactical_rival_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tactical_rival_teams_delete', 'tactical_rival_teams';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tactical_rival_teams_insert', 'tactical_rival_teams';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_tactical_edit_school_ids())) AND ((created_by IS NULL) OR (created_by = auth.uid())))$o$ THEN
    EXECUTE $a$ALTER POLICY "tactical_rival_teams_insert" ON public."tactical_rival_teams"
      WITH CHECK (((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])) AND ((created_by IS NULL) OR (created_by = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tactical_rival_teams_insert', 'tactical_rival_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tactical_rival_teams_insert', 'tactical_rival_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tactical_rival_teams_insert', 'tactical_rival_teams';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tactical_rival_teams_select', 'tactical_rival_teams';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tactical_rival_teams_select" ON public."tactical_rival_teams"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tactical_rival_teams_select', 'tactical_rival_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tactical_rival_teams_select', 'tactical_rival_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tactical_rival_teams_select', 'tactical_rival_teams';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tactical_rival_teams_update', 'tactical_rival_teams';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "tactical_rival_teams_update" ON public."tactical_rival_teams"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'tactical_rival_teams' AND p.policyname = 'tactical_rival_teams_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tactical_rival_teams_update', 'tactical_rival_teams';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tactical_rival_teams_update', 'tactical_rival_teams';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tactical_rival_teams_update', 'tactical_rival_teams';
  END IF;
END
$lote2$;
COMMIT;

-- team_branches: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_branches' AND p.policyname = 'team_branches_delete_via_team';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_branches_delete_via_team', 'team_branches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = team_branches.team_id) AND is_school_admin(t.school_id))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_branches_delete_via_team" ON public."team_branches"
      USING ((EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = team_branches.team_id) AND (t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_branches' AND p.policyname = 'team_branches_delete_via_team';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_branches_delete_via_team', 'team_branches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_branches_delete_via_team', 'team_branches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_branches_delete_via_team', 'team_branches';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_branches' AND p.policyname = 'team_branches_manage_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_branches_manage_admin', 'team_branches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_branches_manage_admin" ON public."team_branches"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_branches' AND p.policyname = 'team_branches_manage_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_branches_manage_admin', 'team_branches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_branches_manage_admin', 'team_branches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_branches_manage_admin', 'team_branches';
  END IF;
END
$lote2$;
COMMIT;

-- team_coaches: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_coaches' AND p.policyname = 'team_coaches_delete_via_team';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_coaches_delete_via_team', 'team_coaches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = team_coaches.team_id) AND is_school_admin(t.school_id))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_coaches_delete_via_team" ON public."team_coaches"
      USING ((EXISTS ( SELECT 1
   FROM teams t
  WHERE ((t.id = team_coaches.team_id) AND (t.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_coaches' AND p.policyname = 'team_coaches_delete_via_team';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_coaches_delete_via_team', 'team_coaches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_coaches_delete_via_team', 'team_coaches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_coaches_delete_via_team', 'team_coaches';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_coaches' AND p.policyname = 'team_coaches_manage_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_coaches_manage_admin', 'team_coaches';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_admin_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_coaches_manage_admin" ON public."team_coaches"
      USING ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_coaches' AND p.policyname = 'team_coaches_manage_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_coaches_manage_admin', 'team_coaches';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_coaches_manage_admin', 'team_coaches';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_coaches_manage_admin', 'team_coaches';
  END IF;
END
$lote2$;
COMMIT;

-- team_members: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_members_delete', 'team_members';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((profile_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_members_delete" ON public."team_members"
      USING (((profile_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_members_delete', 'team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_members_delete', 'team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_members_delete', 'team_members';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_members_insert', 'team_members';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "team_members_insert" ON public."team_members"
      WITH CHECK (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_members_insert', 'team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_members_insert', 'team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_members_insert', 'team_members';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_members_select', 'team_members';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((profile_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_members_select" ON public."team_members"
      USING (((profile_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_members_select', 'team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_members_select', 'team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_members_select', 'team_members';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_members_update', 'team_members';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_members_update" ON public."team_members"
      USING (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = team_members.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_members' AND p.policyname = 'team_members_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_members_update', 'team_members';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_members_update', 'team_members';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_members_update', 'team_members';
  END IF;
END
$lote2$;
COMMIT;

-- team_report_notes: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_report_notes_insert', 'team_report_notes';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((team_id = ANY (current_staff_team_ids())) OR can_manage_reports(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_report_notes_insert" ON public."team_report_notes"
      WITH CHECK (((team_id = ANY ((SELECT public.current_staff_team_ids())::uuid[])) OR can_manage_reports(school_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_report_notes_insert', 'team_report_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_report_notes_insert', 'team_report_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_report_notes_insert', 'team_report_notes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_report_notes_select', 'team_report_notes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((team_id = ANY (current_staff_team_ids())) OR can_manage_reports(school_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_report_notes_select" ON public."team_report_notes"
      USING (((team_id = ANY ((SELECT public.current_staff_team_ids())::uuid[])) OR can_manage_reports(school_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_report_notes_select', 'team_report_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_report_notes_select', 'team_report_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_report_notes_select', 'team_report_notes';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_report_notes_update', 'team_report_notes';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((team_id = ANY (current_staff_team_ids())) OR can_manage_reports(school_id))$o$
     AND c IS NOT DISTINCT FROM $o$((team_id = ANY (current_staff_team_ids())) OR can_manage_reports(school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_report_notes_update" ON public."team_report_notes"
      USING (((team_id = ANY ((SELECT public.current_staff_team_ids())::uuid[])) OR can_manage_reports(school_id)))
      WITH CHECK (((team_id = ANY ((SELECT public.current_staff_team_ids())::uuid[])) OR can_manage_reports(school_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_report_notes' AND p.policyname = 'team_report_notes_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_report_notes_update', 'team_report_notes';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_report_notes_update', 'team_report_notes';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_report_notes_update', 'team_report_notes';
  END IF;
END
$lote2$;
COMMIT;

-- team_reports: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_reports' AND p.policyname = 'team_reports_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_reports_select_staff', 'team_reports';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_reports_select_staff" ON public."team_reports"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_reports' AND p.policyname = 'team_reports_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_reports_select_staff', 'team_reports';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_reports_select_staff', 'team_reports';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_reports_select_staff', 'team_reports';
  END IF;
END
$lote2$;
COMMIT;

-- team_schedule_exceptions: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_schedule_exceptions' AND p.policyname = 'tse_insert_staff_equipo';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tse_insert_staff_equipo', 'team_schedule_exceptions';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((creado_por = auth.uid()) AND puede_editar_semana_equipo(team_id, school_id))$o$ THEN
    EXECUTE $a$ALTER POLICY "tse_insert_staff_equipo" ON public."team_schedule_exceptions"
      WITH CHECK (((creado_por = (SELECT auth.uid())) AND puede_editar_semana_equipo(team_id, school_id)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_schedule_exceptions' AND p.policyname = 'tse_insert_staff_equipo';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tse_insert_staff_equipo', 'team_schedule_exceptions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tse_insert_staff_equipo', 'team_schedule_exceptions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tse_insert_staff_equipo', 'team_schedule_exceptions';
  END IF;
END
$lote2$;
COMMIT;

-- team_tactical_presets: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_tactical_presets_delete', 'team_tactical_presets';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "team_tactical_presets_delete" ON public."team_tactical_presets"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_tactical_presets_delete', 'team_tactical_presets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_tactical_presets_delete', 'team_tactical_presets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_tactical_presets_delete', 'team_tactical_presets';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_tactical_presets_insert', 'team_tactical_presets';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_tactical_presets_insert" ON public."team_tactical_presets"
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_tactical_presets_insert', 'team_tactical_presets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_tactical_presets_insert', 'team_tactical_presets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_tactical_presets_insert', 'team_tactical_presets';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'team_tactical_presets_update', 'team_tactical_presets';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_tactical_edit_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "team_tactical_presets_update" ON public."team_tactical_presets"
      USING ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_tactical_edit_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'team_tactical_presets' AND p.policyname = 'team_tactical_presets_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'team_tactical_presets_update', 'team_tactical_presets';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'team_tactical_presets_update', 'team_tactical_presets';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'team_tactical_presets_update', 'team_tactical_presets';
  END IF;
END
$lote2$;
COMMIT;

-- trainer_profiles: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_profiles' AND p.policyname = 'trainer_profiles_owner_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_profiles_owner_all', 'trainer_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "trainer_profiles_owner_all" ON public."trainer_profiles"
      USING ((user_id = (SELECT auth.uid())))
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_profiles' AND p.policyname = 'trainer_profiles_owner_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_profiles_owner_all', 'trainer_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_profiles_owner_all', 'trainer_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_profiles_owner_all', 'trainer_profiles';
  END IF;
END
$lote2$;
COMMIT;

-- trainer_routines: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_athlete_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_routines_athlete_read', 'trainer_routines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((visible_to_athletes = true) AND ((scope = 'global'::text) OR (school_id IN ( SELECT e.school_id
   FROM enrollments e
  WHERE ((e.status = 'active'::text) AND ((e.user_id = auth.uid()) OR (e.child_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = auth.uid())))))))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "trainer_routines_athlete_read" ON public."trainer_routines"
      USING (((visible_to_athletes = true) AND ((scope = 'global'::text) OR (school_id IN ( SELECT e.school_id
   FROM enrollments e
  WHERE ((e.status = 'active'::text) AND ((e.user_id = (SELECT auth.uid())) OR (e.child_id IN ( SELECT children.id
           FROM children
          WHERE (children.parent_id = (SELECT auth.uid())))))))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_athlete_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_routines_athlete_read', 'trainer_routines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_routines_athlete_read', 'trainer_routines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_routines_athlete_read', 'trainer_routines';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_global_admin_manage';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_routines_global_admin_manage', 'trainer_routines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((scope = 'global'::text) AND is_super_admin())$o$
     AND c IS NOT DISTINCT FROM $o$((scope = 'global'::text) AND is_super_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "trainer_routines_global_admin_manage" ON public."trainer_routines"
      USING (((scope = 'global'::text) AND (SELECT public.is_super_admin())))
      WITH CHECK (((scope = 'global'::text) AND (SELECT public.is_super_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_global_admin_manage';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_routines_global_admin_manage', 'trainer_routines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_routines_global_admin_manage', 'trainer_routines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_routines_global_admin_manage', 'trainer_routines';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_global_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_routines_global_select', 'trainer_routines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((scope = 'global'::text) AND (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.status = 'active'::text)))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "trainer_routines_global_select" ON public."trainer_routines"
      USING (((scope = 'global'::text) AND (EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_global_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_routines_global_select', 'trainer_routines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_routines_global_select', 'trainer_routines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_routines_global_select', 'trainer_routines';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_pt_legacy_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_routines_pt_legacy_all', 'trainer_routines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(trainer_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(trainer_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "trainer_routines_pt_legacy_all" ON public."trainer_routines"
      USING ((trainer_id = (SELECT auth.uid())))
      WITH CHECK ((trainer_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_pt_legacy_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_routines_pt_legacy_all', 'trainer_routines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_routines_pt_legacy_all', 'trainer_routines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_routines_pt_legacy_all', 'trainer_routines';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_school_staff_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_routines_school_staff_all', 'trainer_routines';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((scope = 'school'::text) AND (school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text, 'staff'::text]))))))$o$
     AND c IS NOT DISTINCT FROM $o$((scope = 'school'::text) AND (school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text, 'staff'::text]))))))$o$ THEN
    EXECUTE $a$ALTER POLICY "trainer_routines_school_staff_all" ON public."trainer_routines"
      USING (((scope = 'school'::text) AND (school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text, 'staff'::text])))))))
      WITH CHECK (((scope = 'school'::text) AND (school_id IN ( SELECT sm.school_id
   FROM school_members sm
  WHERE ((sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'coach'::text, 'staff'::text])))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_routines' AND p.policyname = 'trainer_routines_school_staff_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_routines_school_staff_all', 'trainer_routines';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_routines_school_staff_all', 'trainer_routines';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_routines_school_staff_all', 'trainer_routines';
  END IF;
END
$lote2$;
COMMIT;

-- trainer_session_plans: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_session_plans' AND p.policyname = 'trainer_session_plans_client_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_session_plans_client_read', 'trainer_session_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((client_id = auth.uid()) OR (client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "trainer_session_plans_client_read" ON public."trainer_session_plans"
      USING (((client_id = (SELECT auth.uid())) OR (client_id IN ( SELECT children.id
   FROM children
  WHERE (children.parent_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_session_plans' AND p.policyname = 'trainer_session_plans_client_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_session_plans_client_read', 'trainer_session_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_session_plans_client_read', 'trainer_session_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_session_plans_client_read', 'trainer_session_plans';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_session_plans' AND p.policyname = 'trainer_session_plans_owner_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trainer_session_plans_owner_all', 'trainer_session_plans';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(trainer_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(trainer_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "trainer_session_plans_owner_all" ON public."trainer_session_plans"
      USING ((trainer_id = (SELECT auth.uid())))
      WITH CHECK ((trainer_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trainer_session_plans' AND p.policyname = 'trainer_session_plans_owner_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trainer_session_plans_owner_all', 'trainer_session_plans';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trainer_session_plans_owner_all', 'trainer_session_plans';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trainer_session_plans_owner_all', 'trainer_session_plans';
  END IF;
END
$lote2$;
COMMIT;

-- training_logs: 8 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_delete_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_delete_own', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_delete_own" ON public."training_logs"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_delete_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_delete_own', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_delete_own', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_delete_own', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_insert_own', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "training_logs_insert_own" ON public."training_logs"
      WITH CHECK ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_insert_own', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_insert_own', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_insert_own', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_select_own', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((athlete_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = training_logs.athlete_id) AND (c.parent_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_select_own" ON public."training_logs"
      USING (((athlete_id = (SELECT auth.uid())) OR (EXISTS ( SELECT 1
   FROM children c
  WHERE ((c.id = training_logs.athlete_id) AND (c.parent_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_select_own', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_select_own', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_select_own', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_trainer_delete', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_trainer_delete" ON public."training_logs"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_trainer_delete', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_trainer_delete', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_trainer_delete', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_trainer_insert', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_logs_trainer_insert" ON public."training_logs"
      WITH CHECK ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_trainer_insert', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_trainer_insert', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_trainer_insert', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_trainer_select', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_trainer_select" ON public."training_logs"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_trainer_select', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_trainer_select', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_trainer_select', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_trainer_update', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id(auth.uid())) AS get_trainer_athlete_ids))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_trainer_update" ON public."training_logs"
      USING ((athlete_id IN ( SELECT get_trainer_athlete_ids(get_personal_trainer_school_id((SELECT auth.uid()))) AS get_trainer_athlete_ids)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_trainer_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_trainer_update', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_trainer_update', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_trainer_update', 'training_logs';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_logs_update_own', 'training_logs';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(athlete_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_logs_update_own" ON public."training_logs"
      USING ((athlete_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_logs' AND p.policyname = 'training_logs_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_logs_update_own', 'training_logs';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_logs_update_own', 'training_logs';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_logs_update_own', 'training_logs';
  END IF;
END
$lote2$;
COMMIT;

-- training_mesocycle_documents: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_delete_uploader_or_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tmd_delete_uploader_or_admin', 'training_mesocycle_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(((uploaded_by = auth.uid()) AND (school_id = ANY (user_staff_school_ids()))) OR (school_id = ANY (user_admin_school_ids())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tmd_delete_uploader_or_admin" ON public."training_mesocycle_documents"
      USING ((((uploaded_by = (SELECT auth.uid())) AND (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]))) OR (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_delete_uploader_or_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tmd_delete_uploader_or_admin', 'training_mesocycle_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tmd_delete_uploader_or_admin', 'training_mesocycle_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tmd_delete_uploader_or_admin', 'training_mesocycle_documents';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_insert_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tmd_insert_staff', 'training_mesocycle_documents';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((school_id = ANY (user_staff_school_ids())) AND (uploaded_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM training_mesocycles m
  WHERE ((m.id = training_mesocycle_documents.mesocycle_id) AND (m.school_id = training_mesocycle_documents.school_id)))))$o$ THEN
    EXECUTE $a$ALTER POLICY "tmd_insert_staff" ON public."training_mesocycle_documents"
      WITH CHECK (((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])) AND (uploaded_by = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM training_mesocycles m
  WHERE ((m.id = training_mesocycle_documents.mesocycle_id) AND (m.school_id = training_mesocycle_documents.school_id))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_insert_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tmd_insert_staff', 'training_mesocycle_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tmd_insert_staff', 'training_mesocycle_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tmd_insert_staff', 'training_mesocycle_documents';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_select_staff';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'tmd_select_staff', 'training_mesocycle_documents';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "tmd_select_staff" ON public."training_mesocycle_documents"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_documents' AND p.policyname = 'tmd_select_staff';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'tmd_select_staff', 'training_mesocycle_documents';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'tmd_select_staff', 'training_mesocycle_documents';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'tmd_select_staff', 'training_mesocycle_documents';
  END IF;
END
$lote2$;
COMMIT;

-- training_mesocycle_evaluations: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycle_evaluations_delete', 'training_mesocycle_evaluations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_mesocycle_evaluations_delete" ON public."training_mesocycle_evaluations"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycle_evaluations_delete', 'training_mesocycle_evaluations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycle_evaluations_delete', 'training_mesocycle_evaluations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycle_evaluations_delete', 'training_mesocycle_evaluations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycle_evaluations_insert', 'training_mesocycle_evaluations';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_mesocycle_evaluations_insert" ON public."training_mesocycle_evaluations"
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycle_evaluations_insert', 'training_mesocycle_evaluations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycle_evaluations_insert', 'training_mesocycle_evaluations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycle_evaluations_insert', 'training_mesocycle_evaluations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycle_evaluations_select', 'training_mesocycle_evaluations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_mesocycle_evaluations_select" ON public."training_mesocycle_evaluations"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycle_evaluations_select', 'training_mesocycle_evaluations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycle_evaluations_select', 'training_mesocycle_evaluations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycle_evaluations_select', 'training_mesocycle_evaluations';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycle_evaluations_update', 'training_mesocycle_evaluations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_mesocycle_evaluations_update" ON public."training_mesocycle_evaluations"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycle_evaluations' AND p.policyname = 'training_mesocycle_evaluations_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycle_evaluations_update', 'training_mesocycle_evaluations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycle_evaluations_update', 'training_mesocycle_evaluations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycle_evaluations_update', 'training_mesocycle_evaluations';
  END IF;
END
$lote2$;
COMMIT;

-- training_mesocycles: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycles_delete', 'training_mesocycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_mesocycles_delete" ON public."training_mesocycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycles_delete', 'training_mesocycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycles_delete', 'training_mesocycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycles_delete', 'training_mesocycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycles_insert', 'training_mesocycles';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_mesocycles_insert" ON public."training_mesocycles"
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycles_insert', 'training_mesocycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycles_insert', 'training_mesocycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycles_insert', 'training_mesocycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycles_select', 'training_mesocycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_mesocycles_select" ON public."training_mesocycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycles_select', 'training_mesocycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycles_select', 'training_mesocycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycles_select', 'training_mesocycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_mesocycles_update', 'training_mesocycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_mesocycles_update" ON public."training_mesocycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_mesocycles' AND p.policyname = 'training_mesocycles_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_mesocycles_update', 'training_mesocycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_mesocycles_update', 'training_mesocycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_mesocycles_update', 'training_mesocycles';
  END IF;
END
$lote2$;
COMMIT;

-- training_microcycle_days: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycle_days_delete', 'training_microcycle_days';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_microcycle_days_delete" ON public."training_microcycle_days"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycle_days_delete', 'training_microcycle_days';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycle_days_delete', 'training_microcycle_days';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycle_days_delete', 'training_microcycle_days';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycle_days_insert', 'training_microcycle_days';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_microcycle_days_insert" ON public."training_microcycle_days"
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycle_days_insert', 'training_microcycle_days';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycle_days_insert', 'training_microcycle_days';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycle_days_insert', 'training_microcycle_days';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycle_days_select', 'training_microcycle_days';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_microcycle_days_select" ON public."training_microcycle_days"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycle_days_select', 'training_microcycle_days';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycle_days_select', 'training_microcycle_days';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycle_days_select', 'training_microcycle_days';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycle_days_update', 'training_microcycle_days';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_microcycle_days_update" ON public."training_microcycle_days"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycle_days' AND p.policyname = 'training_microcycle_days_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycle_days_update', 'training_microcycle_days';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycle_days_update', 'training_microcycle_days';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycle_days_update', 'training_microcycle_days';
  END IF;
END
$lote2$;
COMMIT;

-- training_microcycles: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycles_delete', 'training_microcycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_microcycles_delete" ON public."training_microcycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycles_delete', 'training_microcycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycles_delete', 'training_microcycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycles_delete', 'training_microcycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycles_insert', 'training_microcycles';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_microcycles_insert" ON public."training_microcycles"
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycles_insert', 'training_microcycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycles_insert', 'training_microcycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycles_insert', 'training_microcycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycles_select', 'training_microcycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_microcycles_select" ON public."training_microcycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycles_select', 'training_microcycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycles_select', 'training_microcycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycles_select', 'training_microcycles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_microcycles_update', 'training_microcycles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$
     AND c IS NOT DISTINCT FROM $o$(school_id = ANY (user_staff_school_ids()))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_microcycles_update" ON public."training_microcycles"
      USING ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))
      WITH CHECK ((school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_microcycles' AND p.policyname = 'training_microcycles_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_microcycles_update', 'training_microcycles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_microcycles_update', 'training_microcycles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_microcycles_update', 'training_microcycles';
  END IF;
END
$lote2$;
COMMIT;

-- training_sessions: 4 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_plans_delete', 'training_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_plans_delete" ON public."training_sessions"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_plans_delete', 'training_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_plans_delete', 'training_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_plans_delete', 'training_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_plans_insert', 'training_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "training_plans_insert" ON public."training_sessions"
      WITH CHECK (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_plans_insert', 'training_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_plans_insert', 'training_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_plans_insert', 'training_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_plans_select', 'training_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_plans_select" ON public."training_sessions"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_plans_select', 'training_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_plans_select', 'training_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_plans_select', 'training_sessions';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_plans_update', 'training_sessions';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "training_plans_update" ON public."training_sessions"
      USING (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))
      WITH CHECK (((EXISTS ( SELECT 1
   FROM school_members sm
  WHERE ((sm.school_id = training_sessions.school_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_sessions' AND p.policyname = 'training_plans_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_plans_update', 'training_sessions';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_plans_update', 'training_sessions';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_plans_update', 'training_sessions';
  END IF;
END
$lote2$;
COMMIT;

-- training_slots: 5 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_admin_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_sessions_admin_all', 'training_slots';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM teams
  WHERE ((teams.id = training_slots.team_id) AND is_school_admin(teams.school_id))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM teams
  WHERE ((teams.id = training_slots.team_id) AND is_school_admin(teams.school_id))))$o$ THEN
    EXECUTE $a$ALTER POLICY "training_sessions_admin_all" ON public."training_slots"
      USING ((EXISTS ( SELECT 1
   FROM teams
  WHERE ((teams.id = training_slots.team_id) AND (teams.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM teams
  WHERE ((teams.id = training_slots.team_id) AND (teams.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_admin_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_sessions_admin_all', 'training_slots';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_sessions_admin_all', 'training_slots';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_sessions_admin_all', 'training_slots';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_sessions_delete', 'training_slots';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_sessions_delete" ON public."training_slots"
      USING (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_sessions_delete', 'training_slots';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_sessions_delete', 'training_slots';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_sessions_delete', 'training_slots';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_sessions_insert', 'training_slots';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$ THEN
    EXECUTE $a$ALTER POLICY "training_sessions_insert" ON public."training_slots"
      WITH CHECK (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_sessions_insert', 'training_slots';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_sessions_insert', 'training_slots';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_sessions_insert', 'training_slots';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_sessions_select', 'training_slots';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text)))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_sessions_select" ON public."training_slots"
      USING (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text)))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_sessions_select', 'training_slots';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_sessions_select', 'training_slots';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_sessions_select', 'training_slots';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_update';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'training_sessions_update', 'training_slots';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = auth.uid()) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "training_sessions_update" ON public."training_slots"
      USING (((EXISTS ( SELECT 1
   FROM (teams t
     JOIN school_members sm ON ((sm.school_id = t.school_id)))
  WHERE ((t.id = training_slots.team_id) AND (sm.profile_id = (SELECT auth.uid())) AND (sm.status = 'active'::text) AND (sm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'staff'::text, 'coach'::text, 'super_admin'::text, 'school_admin'::text]))))) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'training_slots' AND p.policyname = 'training_sessions_update';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'training_sessions_update', 'training_slots';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'training_sessions_update', 'training_slots';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'training_sessions_update', 'training_slots';
  END IF;
END
$lote2$;
COMMIT;

-- trial_class_bookings: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trial_class_bookings' AND p.policyname = 'trial_class_bookings_select_admin_or_coach';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trial_class_bookings_select_admin_or_coach', 'trial_class_bookings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(is_school_admin(school_id) OR (EXISTS ( SELECT 1
   FROM school_staff ss
  WHERE ((ss.id = trial_class_bookings.coach_id) AND (ss.coach_auth_id = auth.uid())))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "trial_class_bookings_select_admin_or_coach" ON public."trial_class_bookings"
      USING (((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])) OR (EXISTS ( SELECT 1
   FROM school_staff ss
  WHERE ((ss.id = trial_class_bookings.coach_id) AND (ss.coach_auth_id = (SELECT auth.uid())))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trial_class_bookings' AND p.policyname = 'trial_class_bookings_select_admin_or_coach';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trial_class_bookings_select_admin_or_coach', 'trial_class_bookings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trial_class_bookings_select_admin_or_coach', 'trial_class_bookings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trial_class_bookings_select_admin_or_coach', 'trial_class_bookings';
  END IF;
END
$lote2$;
COMMIT;

-- trial_class_categories: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trial_class_categories' AND p.policyname = 'trial_class_categories_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'trial_class_categories_select_admin', 'trial_class_categories';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "trial_class_categories_select_admin" ON public."trial_class_categories"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'trial_class_categories' AND p.policyname = 'trial_class_categories_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'trial_class_categories_select_admin', 'trial_class_categories';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'trial_class_categories_select_admin', 'trial_class_categories';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'trial_class_categories_select_admin', 'trial_class_categories';
  END IF;
END
$lote2$;
COMMIT;

-- turnstile_devices: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School admins can insert devices';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School admins can insert devices', 'turnstile_devices';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$ THEN
    EXECUTE $a$ALTER POLICY "School admins can insert devices" ON public."turnstile_devices"
      WITH CHECK ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School admins can insert devices';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School admins can insert devices', 'turnstile_devices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School admins can insert devices', 'turnstile_devices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School admins can insert devices', 'turnstile_devices';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School admins can update their devices';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School admins can update their devices', 'turnstile_devices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = auth.uid()) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text])))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School admins can update their devices" ON public."turnstile_devices"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE ((school_members.profile_id = (SELECT auth.uid())) AND (school_members.status = 'active'::text) AND (school_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'school_admin'::text]))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School admins can update their devices';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School admins can update their devices', 'turnstile_devices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School admins can update their devices', 'turnstile_devices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School admins can update their devices', 'turnstile_devices';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School members can view their devices';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'School members can view their devices', 'turnstile_devices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = auth.uid())))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "School members can view their devices" ON public."turnstile_devices"
      USING ((school_id IN ( SELECT school_members.school_id
   FROM school_members
  WHERE (school_members.profile_id = (SELECT auth.uid())))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'turnstile_devices' AND p.policyname = 'School members can view their devices';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'School members can view their devices', 'turnstile_devices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'School members can view their devices', 'turnstile_devices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'School members can view their devices', 'turnstile_devices';
  END IF;
END
$lote2$;
COMMIT;

-- ui_usage_daily: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'ui_usage_daily' AND p.policyname = 'ui_usage_daily_select_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'ui_usage_daily_select_admin', 'ui_usage_daily';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "ui_usage_daily_select_admin" ON public."ui_usage_daily"
      USING ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'ui_usage_daily' AND p.policyname = 'ui_usage_daily_select_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'ui_usage_daily_select_admin', 'ui_usage_daily';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'ui_usage_daily_select_admin', 'ui_usage_daily';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'ui_usage_daily_select_admin', 'ui_usage_daily';
  END IF;
END
$lote2$;
COMMIT;

-- user_devices: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_devices' AND p.policyname = 'user_devices_owner_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'user_devices_owner_select', 'user_devices';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "user_devices_owner_select" ON public."user_devices"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_devices' AND p.policyname = 'user_devices_owner_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'user_devices_owner_select', 'user_devices';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'user_devices_owner_select', 'user_devices';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'user_devices_owner_select', 'user_devices';
  END IF;
END
$lote2$;
COMMIT;

-- user_favorites: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_delete';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'fav_delete', 'user_favorites';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "fav_delete" ON public."user_favorites"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_delete';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'fav_delete', 'user_favorites';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'fav_delete', 'user_favorites';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'fav_delete', 'user_favorites';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_insert';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'fav_insert', 'user_favorites';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$ THEN
    EXECUTE $a$ALTER POLICY "fav_insert" ON public."user_favorites"
      WITH CHECK (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_insert';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'fav_insert', 'user_favorites';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'fav_insert', 'user_favorites';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'fav_insert', 'user_favorites';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'fav_select', 'user_favorites';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(auth.uid() = user_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "fav_select" ON public."user_favorites"
      USING (((SELECT auth.uid()) = user_id))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_favorites' AND p.policyname = 'fav_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'fav_select', 'user_favorites';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'fav_select', 'user_favorites';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'fav_select', 'user_favorites';
  END IF;
END
$lote2$;
COMMIT;

-- user_roles: 2 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_roles' AND p.policyname = 'user_roles_manage_platform_admin';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'user_roles_manage_platform_admin', 'user_roles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_platform_admin()$o$
     AND c IS NOT DISTINCT FROM $o$is_platform_admin()$o$ THEN
    EXECUTE $a$ALTER POLICY "user_roles_manage_platform_admin" ON public."user_roles"
      USING ((SELECT public.is_platform_admin()))
      WITH CHECK ((SELECT public.is_platform_admin()))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_roles' AND p.policyname = 'user_roles_manage_platform_admin';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'user_roles_manage_platform_admin', 'user_roles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'user_roles_manage_platform_admin', 'user_roles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'user_roles_manage_platform_admin', 'user_roles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_roles' AND p.policyname = 'user_roles_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'user_roles_select', 'user_roles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "user_roles_select" ON public."user_roles"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_roles' AND p.policyname = 'user_roles_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'user_roles_select', 'user_roles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'user_roles_select', 'user_roles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'user_roles_select', 'user_roles';
  END IF;
END
$lote2$;
COMMIT;

-- user_search_preferences: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_search_preferences' AND p.policyname = 'user_search_preferences_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'user_search_preferences_own', 'user_search_preferences';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((user_id = auth.uid()) OR is_platform_admin())$o$
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "user_search_preferences_own" ON public."user_search_preferences"
      USING (((user_id = (SELECT auth.uid())) OR (SELECT public.is_platform_admin())))
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'user_search_preferences' AND p.policyname = 'user_search_preferences_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'user_search_preferences_own', 'user_search_preferences';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'user_search_preferences_own', 'user_search_preferences';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'user_search_preferences_own', 'user_search_preferences';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_balances: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_balances' AND p.policyname = 'Vendor lee su balance';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Vendor lee su balance', 'vendor_balances';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_balances.vendor_profile_id) AND (vp.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "Vendor lee su balance" ON public."vendor_balances"
      USING ((EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_balances.vendor_profile_id) AND (vp.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_balances' AND p.policyname = 'Vendor lee su balance';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Vendor lee su balance', 'vendor_balances';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Vendor lee su balance', 'vendor_balances';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Vendor lee su balance', 'vendor_balances';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_bank_accounts: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_bank_accounts' AND p.policyname = 'Vendor maneja sus cuentas bancarias';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Vendor maneja sus cuentas bancarias', 'vendor_bank_accounts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_bank_accounts.vendor_profile_id) AND (vp.user_id = auth.uid()))))$o$
     AND c IS NOT DISTINCT FROM $o$(EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_bank_accounts.vendor_profile_id) AND (vp.user_id = auth.uid()))))$o$ THEN
    EXECUTE $a$ALTER POLICY "Vendor maneja sus cuentas bancarias" ON public."vendor_bank_accounts"
      USING ((EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_bank_accounts.vendor_profile_id) AND (vp.user_id = (SELECT auth.uid()))))))
      WITH CHECK ((EXISTS ( SELECT 1
   FROM vendor_profiles vp
  WHERE ((vp.id = vendor_bank_accounts.vendor_profile_id) AND (vp.user_id = (SELECT auth.uid()))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_bank_accounts' AND p.policyname = 'Vendor maneja sus cuentas bancarias';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Vendor maneja sus cuentas bancarias', 'vendor_bank_accounts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Vendor maneja sus cuentas bancarias', 'vendor_bank_accounts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Vendor maneja sus cuentas bancarias', 'vendor_bank_accounts';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_payment_providers: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_payment_providers' AND p.policyname = 'vendor_payment_providers_owner_all';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'vendor_payment_providers_owner_all', 'vendor_payment_providers';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((auth.uid() = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM $o$((auth.uid() = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin))$o$ THEN
    EXECUTE $a$ALTER POLICY "vendor_payment_providers_owner_all" ON public."vendor_payment_providers"
      USING ((((SELECT auth.uid()) = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin)))
      WITH CHECK ((((SELECT auth.uid()) = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_payment_providers' AND p.policyname = 'vendor_payment_providers_owner_all';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'vendor_payment_providers_owner_all', 'vendor_payment_providers';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'vendor_payment_providers_owner_all', 'vendor_payment_providers';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'vendor_payment_providers_owner_all', 'vendor_payment_providers';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_payouts: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_payouts' AND p.policyname = 'vendor_payouts_owner_read';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'vendor_payouts_owner_read', 'vendor_payouts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((auth.uid() = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "vendor_payouts_owner_read" ON public."vendor_payouts"
      USING ((((SELECT auth.uid()) = vendor_id) OR ( SELECT is_super_admin() AS is_super_admin)))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_payouts' AND p.policyname = 'vendor_payouts_owner_read';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'vendor_payouts_owner_read', 'vendor_payouts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'vendor_payouts_owner_read', 'vendor_payouts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'vendor_payouts_owner_read', 'vendor_payouts';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_profiles: 3 policies
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_insert_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'vendor_profiles_insert_own', 'vendor_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "vendor_profiles_insert_own" ON public."vendor_profiles"
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_insert_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'vendor_profiles_insert_own', 'vendor_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'vendor_profiles_insert_own', 'vendor_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'vendor_profiles_insert_own', 'vendor_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_select_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'vendor_profiles_select_own', 'vendor_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "vendor_profiles_select_own" ON public."vendor_profiles"
      USING ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_select_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'vendor_profiles_select_own', 'vendor_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'vendor_profiles_select_own', 'vendor_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'vendor_profiles_select_own', 'vendor_profiles';
  END IF;
END
$lote2$;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_update_own';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'vendor_profiles_update_own', 'vendor_profiles';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$
     AND c IS NOT DISTINCT FROM $o$(user_id = auth.uid())$o$ THEN
    EXECUTE $a$ALTER POLICY "vendor_profiles_update_own" ON public."vendor_profiles"
      USING ((user_id = (SELECT auth.uid())))
      WITH CHECK ((user_id = (SELECT auth.uid())))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_profiles' AND p.policyname = 'vendor_profiles_update_own';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'vendor_profiles_update_own', 'vendor_profiles';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'vendor_profiles_update_own', 'vendor_profiles';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'vendor_profiles_update_own', 'vendor_profiles';
  END IF;
END
$lote2$;
COMMIT;

-- vendor_reviews: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_reviews' AND p.policyname = 'Compradores crean vendor review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'Compradores crean vendor review', 'vendor_reviews';
  END IF;
  IF q IS NOT DISTINCT FROM NULL
     AND c IS NOT DISTINCT FROM $o$((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM ((orders o
     JOIN order_items oi ON ((oi.order_id = o.id)))
     JOIN products p ON ((p.id = oi.product_id)))
  WHERE ((p.vendor_profile_id = vendor_reviews.vendor_profile_id) AND (o.user_id = auth.uid()) AND (o.status = 'delivered'::text)))))$o$ THEN
    EXECUTE $a$ALTER POLICY "Compradores crean vendor review" ON public."vendor_reviews"
      WITH CHECK (((user_id = (SELECT auth.uid())) AND (EXISTS ( SELECT 1
   FROM ((orders o
     JOIN order_items oi ON ((oi.order_id = o.id)))
     JOIN products p ON ((p.id = oi.product_id)))
  WHERE ((p.vendor_profile_id = vendor_reviews.vendor_profile_id) AND (o.user_id = (SELECT auth.uid())) AND (o.status = 'delivered'::text))))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'vendor_reviews' AND p.policyname = 'Compradores crean vendor review';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'Compradores crean vendor review', 'vendor_reviews';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'Compradores crean vendor review', 'vendor_reviews';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'Compradores crean vendor review', 'vendor_reviews';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_account_events: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_account_events' AND p.policyname = 'wa_account_events_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_account_events_admin_select', 'whatsapp_account_events';
  END IF;
  IF q IS NOT DISTINCT FROM $o$((school_id IS NOT NULL) AND is_school_admin(school_id))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_account_events_admin_select" ON public."whatsapp_account_events"
      USING (((school_id IS NOT NULL) AND (school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[]))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_account_events' AND p.policyname = 'wa_account_events_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_account_events_admin_select', 'whatsapp_account_events';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_account_events_admin_select', 'whatsapp_account_events';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_account_events_admin_select', 'whatsapp_account_events';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_conversations: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_conversations' AND p.policyname = 'wa_conv_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_conv_admin_select', 'whatsapp_conversations';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_conv_admin_select" ON public."whatsapp_conversations"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_conversations' AND p.policyname = 'wa_conv_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_conv_admin_select', 'whatsapp_conversations';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_conv_admin_select', 'whatsapp_conversations';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_conv_admin_select', 'whatsapp_conversations';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_inbound_queue: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_inbound_queue' AND p.policyname = 'wa_queue_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_queue_admin_select', 'whatsapp_inbound_queue';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_queue_admin_select" ON public."whatsapp_inbound_queue"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_inbound_queue' AND p.policyname = 'wa_queue_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_queue_admin_select', 'whatsapp_inbound_queue';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_queue_admin_select', 'whatsapp_inbound_queue';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_queue_admin_select', 'whatsapp_inbound_queue';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_message_drafts: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_message_drafts' AND p.policyname = 'wa_drafts_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_drafts_admin_select', 'whatsapp_message_drafts';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(conversation_id IN ( SELECT c.id
   FROM whatsapp_conversations c
  WHERE is_school_admin(c.school_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_drafts_admin_select" ON public."whatsapp_message_drafts"
      USING ((conversation_id IN ( SELECT c.id
   FROM whatsapp_conversations c
  WHERE (c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_message_drafts' AND p.policyname = 'wa_drafts_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_drafts_admin_select', 'whatsapp_message_drafts';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_drafts_admin_select', 'whatsapp_message_drafts';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_drafts_admin_select', 'whatsapp_message_drafts';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_messages: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_messages' AND p.policyname = 'wa_msg_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_msg_admin_select', 'whatsapp_messages';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(conversation_id IN ( SELECT c.id
   FROM whatsapp_conversations c
  WHERE is_school_admin(c.school_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_msg_admin_select" ON public."whatsapp_messages"
      USING ((conversation_id IN ( SELECT c.id
   FROM whatsapp_conversations c
  WHERE (c.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_messages' AND p.policyname = 'wa_msg_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_msg_admin_select', 'whatsapp_messages';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_msg_admin_select', 'whatsapp_messages';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_msg_admin_select', 'whatsapp_messages';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_optins: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_optins' AND p.policyname = 'wa_optin_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_optin_admin_select', 'whatsapp_optins';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_optin_admin_select" ON public."whatsapp_optins"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_optins' AND p.policyname = 'wa_optin_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_optin_admin_select', 'whatsapp_optins';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_optin_admin_select', 'whatsapp_optins';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_optin_admin_select', 'whatsapp_optins';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_settings: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_settings' AND p.policyname = 'wa_settings_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_settings_admin_select', 'whatsapp_settings';
  END IF;
  IF q IS NOT DISTINCT FROM $o$(integration_id IN ( SELECT i.id
   FROM school_whatsapp_integrations i
  WHERE is_school_admin(i.school_id)))$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_settings_admin_select" ON public."whatsapp_settings"
      USING ((integration_id IN ( SELECT i.id
   FROM school_whatsapp_integrations i
  WHERE (i.school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_settings' AND p.policyname = 'wa_settings_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_settings_admin_select', 'whatsapp_settings';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_settings_admin_select', 'whatsapp_settings';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_settings_admin_select', 'whatsapp_settings';
  END IF;
END
$lote2$;
COMMIT;

-- whatsapp_template_status: 1 policy
BEGIN;
SET LOCAL lock_timeout = '800ms';
SET LOCAL search_path = "$user", public;
DO $lote2$
DECLARE q text; c text;
BEGIN
  SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_template_status' AND p.policyname = 'wa_template_status_admin_select';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lote 2: no existe la policy % en %', 'wa_template_status_admin_select', 'whatsapp_template_status';
  END IF;
  IF q IS NOT DISTINCT FROM $o$is_school_admin(school_id)$o$
     AND c IS NOT DISTINCT FROM NULL THEN
    EXECUTE $a$ALTER POLICY "wa_template_status_admin_select" ON public."whatsapp_template_status"
      USING ((school_id = ANY ((SELECT public.is_school_admin_ids())::uuid[])))$a$;
    SELECT p.qual, p.with_check INTO q, c FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = 'whatsapp_template_status' AND p.policyname = 'wa_template_status_admin_select';
    IF NOT (pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c)) THEN
      RAISE EXCEPTION 'lote 2: % en % quedó con algo sin envolver', 'wa_template_status_admin_select', 'whatsapp_template_status';
    END IF;
  ELSIF pg_temp.lote2_envuelta(q) AND pg_temp.lote2_envuelta(c) THEN
    RAISE NOTICE 'lote 2: % en % ya estaba envuelta; se salta', 'wa_template_status_admin_select', 'whatsapp_template_status';
  ELSE
    RAISE EXCEPTION 'lote 2: la policy % en % cambió desde que se generó esta migración; regenerar el lote antes de aplicar', 'wa_template_status_admin_select', 'whatsapp_template_status';
  END IF;
END
$lote2$;
COMMIT;
