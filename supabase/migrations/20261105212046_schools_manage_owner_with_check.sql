-- SEGURIDAD (invariante I3): la policy "Schools: manage owner" es FOR ALL sin WITH CHECK, así que
-- PostgreSQL valida los INSERT/UPDATE con el USING (auth.uid() = owner_id). Eso ya obliga a que la
-- fila resultante tenga owner_id = quien escribe, pero la regla no está declarada y no sobrevive a un
-- cambio de USING. Se declara el WITH CHECK explícito.
--
-- ORDEN DE APLICACIÓN EN PRODUCCIÓN: 2.º (después de 20261105211824_security_audit_log_tabla; no depende
-- de las demás). PRECONDICIÓN: la policy "Schools: manage owner" existe (USING auth.uid() = owner_id).
--
-- Compatibilidad verificada en el gemelo:
--   * handle_new_user (SECURITY DEFINER, dueño postgres con BYPASSRLS, sin auth.uid()): inserta escuelas
--     'venue' sin pasar por esta policy.
--   * SchoolSetupPage: INSERT directo con owner_id = auth.uid()  -> pasa.
--   * UPDATE del dueño (name, city, onboarding_status, slug...) con owner_id intacto -> pasa.
--   * Insertar una escuela con OTRO owner_id, o reasignar owner_id a otro usuario -> 42501.
--
-- Además se cierra un hueco vecino que el WITH CHECK no cubre: la policy PERMISIVA
-- school_admin_update_branding deja a un admin/school_admin hacer UPDATE de CUALQUIER columna de su
-- escuela (WITH CHECK solo mira el id), incluido owner_id => toma de control de la escuela. Se añade
-- un trigger BEFORE UPDATE OF owner_id: con sesión (auth.uid() no nulo) solo un admin de plataforma o
-- el propio dueño actual (reafirmándose) puede cambiarlo; service_role / postgres (auth.uid() NULL) no
-- se ven afectados.

BEGIN;

DROP POLICY IF EXISTS "Schools: manage owner" ON public.schools;
CREATE POLICY "Schools: manage owner" ON public.schools
  FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE OR REPLACE FUNCTION public.fn_schools_owner_id_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     AND auth.uid() IS NOT NULL
     AND NOT COALESCE(public.is_platform_admin(), false)
     AND NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'owner_id de la escuela solo lo cambia un administrador de plataforma'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Función de trigger: nadie la llama por RPC.
REVOKE ALL ON FUNCTION public.fn_schools_owner_id_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_schools_owner_id_guard ON public.schools;
CREATE TRIGGER trg_schools_owner_id_guard
  BEFORE UPDATE OF owner_id ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.fn_schools_owner_id_guard();

COMMIT;
