-- =============================================================================
-- 20261028110434_buckets_publicos_sin_listado.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-28   Versión anterior: 20261027192225
-- Objetivo: que los 4 buckets públicos (avatars, facility-photos,
--   product-images, school-assets) dejen de permitir LISTAR todos sus nombres
--   de archivo, y que nadie pueda subir a la carpeta de otro.
--
--   Antes (base viva, 2026-10-28):
--     · SELECT de bucket completo: avatars_public_read {public},
--       facility_photos_public_read {public}, school_assets_public_read {public},
--       product_images_public_read {anon,authenticated}. Con eso cualquiera
--       (sin sesión) hacía storage.from(b).list() y enumeraba todo: rutas con
--       UUID de menores (children/, unregistered_athletes/), escuelas, etc.
--       Para servir por URL pública (/storage/v1/object/public/…) NO hace
--       falta SELECT: basta con storage.buckets.public = true.
--     · "Authenticated users can upload avatars" y "Schools can upload
--       facility photos": INSERT con solo auth.role() = 'authenticated' →
--       cualquier usuario subía a CUALQUIER ruta (p. ej. children/<ajeno>/ o
--       schools/<otra-escuela>/).
--     · "Admin sube/borra logo de su escuela" (school-assets): duplicados
--       viejos de school_assets_admin_*; sin filtro de status (dueños
--       INACTIVOS seguían subiendo/borrando), LIMIT 1 (multiescuela a medias)
--       y el DELETE sin filtro de carpeta.
--
--   Historia: 20260511000014 y 20260513000004 ya habían quitado estas SELECT;
--   20260825125349 las volvió a poner porque useStorage subía con
--   upsert:true y el upsert de Storage (INSERT … ON CONFLICT) exige SELECT
--   aunque el archivo sea nuevo. Ahora el cliente sube con upsert:false
--   (mismo commit; los nombres ya eran únicos) y una guardia de vitest
--   prohíbe volver a upsert:true. Además se deja una SELECT ACOTADA a la
--   ruta del dueño en avatars y school-assets, para que un frontend viejo
--   en caché (que aún manda upsert:true) siga subiendo hasta que despliegue.
--
--   Después:
--     avatars          INSERT avatars_owner_insert (ruta propia, ver abajo)
--                      SELECT avatars_owner_read   (misma ruta + unregistered_athletes de su escuela)
--                      (sin cambios) "Users can update own avatar",
--                      avatars_unregistered_admin_insert/update
--     facility-photos  INSERT facility_photos_owner_insert (carpeta = auth.uid())
--                      sin SELECT (no hay código cliente que use el bucket)
--     product-images   sin SELECT (el cliente ya subía con upsert:false; el
--                      BFF usa service_role). INSERT/UPDATE/DELETE sin cambios.
--     school-assets    SELECT school_assets_admin_read (logos|covers|qr de sus escuelas)
--                      DELETE school_assets_admin_delete ahora incluye qr/
--                      (lo cubría solo la policy vieja que se borra)
--                      INSERT/UPDATE school_assets_admin_* y _qr_* sin cambios
--
--   Ruta propia en avatars (cubre el 100 % de los objetos con dueño que
--   existen hoy, salvo los 7 planos de trainer-profiles/ y 5 sueltos en la
--   raíz de feb–abr; esos archivos siguen sirviéndose, solo cambia cómo se
--   suben los nuevos):
--     <uid>/…                                   ProfileSection, SeccionesCuentaV2, AthleteProfileTabs
--     profiles|coaches|trainer-profiles|children/<uid>/…   ProfilePage, CoachProfileWizard, Trainer*, AddChildDialog
--     children/<child_id>/…  con children.parent_id = uid  EditChildDialog
--     vendor-logos|vendor-covers/<vendor_id>/… del vendor  VendorPublicProfilePage
--     schools/<school_id>/… con school_id ∈ user_admin_school_ids()  SchoolSettingsPage
--     <uid>-<…> en la raíz (formato viejo de AthleteProfileTabs)
--
--   ORDEN DE DESPLIEGUE: primero el frontend de esta rama, después pegar esta
--   migración. Con el frontend viejo, el avatar de entrenador
--   (TrainerOnboarding/TrainerProfileEditor subían a trainer-profiles/ sin
--   uid) fallaría con RLS hasta desplegar.
--
--   El BFF usa service_role (bypass RLS): pwa-icons, help-articles,
--   derivados de product-images y adjuntos de torneos no se ven afectados.
--
-- Notas técnicas:
--   · DROP POLICY IF EXISTS + CREATE separados, top-level (postgres no es
--     dueño de storage.objects; ver 20260511000014). Sin COMMENT ON POLICY.
--   · Dentro de subconsultas se usa objects.name: sin calificar, `name` se
--     resolvería contra la tabla interna si tuviera esa columna.
--   · (storage.foldername(name))[2] se compara como TEXTO contra
--     user_admin_school_ids()::text[]; castear a uuid rompería la consulta
--     entera con una ruta que no sea UUID.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ── 1. Fuera las SELECT de bucket completo (permitían .list() anónimo) ──────
DROP POLICY IF EXISTS "avatars_public_read"         ON storage.objects;
DROP POLICY IF EXISTS "facility_photos_public_read" ON storage.objects;
DROP POLICY IF EXISTS "product_images_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "school_assets_public_read"   ON storage.objects;

-- ── 2. avatars: INSERT solo a una ruta propia ───────────────────────────────
DROP POLICY IF EXISTS "Authenticated users can upload avatars" ON storage.objects;
DROP POLICY IF EXISTS "avatars_owner_insert" ON storage.objects;
CREATE POLICY "avatars_owner_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (
        (storage.foldername(name))[1] = (auth.uid())::text
     OR (     (storage.foldername(name))[1] = ANY (ARRAY['profiles','coaches','trainer-profiles','children'])
          AND (storage.foldername(name))[2] = (auth.uid())::text )
     OR (     (storage.foldername(name))[1] = 'children'
          AND EXISTS (SELECT 1 FROM public.children c
                       WHERE (c.id)::text = (storage.foldername(objects.name))[2]
                         AND c.parent_id = auth.uid()) )
     OR (     (storage.foldername(name))[1] = ANY (ARRAY['vendor-logos','vendor-covers'])
          AND EXISTS (SELECT 1 FROM public.vendor_profiles vp
                       WHERE (vp.id)::text = (storage.foldername(objects.name))[2]
                         AND vp.user_id = auth.uid()) )
     OR (     (storage.foldername(name))[1] = 'schools'
          AND (storage.foldername(name))[2] = ANY ((public.user_admin_school_ids())::text[]) )
     OR (     array_length(storage.foldername(name), 1) IS NULL
          AND name LIKE (auth.uid())::text || '-%' )
  )
);

-- ── 3. avatars: SELECT acotada (upsert de un frontend viejo + futuros remove)
--      Misma ruta propia + fotos de unregistered_athletes de su escuela
--      (SchoolStudentsManagementPage subía con upsert:true).
DROP POLICY IF EXISTS "avatars_owner_read" ON storage.objects;
CREATE POLICY "avatars_owner_read"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'avatars'
  AND (
        (storage.foldername(name))[1] = (auth.uid())::text
     OR (     (storage.foldername(name))[1] = ANY (ARRAY['profiles','coaches','trainer-profiles','children'])
          AND (storage.foldername(name))[2] = (auth.uid())::text )
     OR (     (storage.foldername(name))[1] = 'children'
          AND EXISTS (SELECT 1 FROM public.children c
                       WHERE (c.id)::text = (storage.foldername(objects.name))[2]
                         AND c.parent_id = auth.uid()) )
     OR (     (storage.foldername(name))[1] = ANY (ARRAY['vendor-logos','vendor-covers'])
          AND EXISTS (SELECT 1 FROM public.vendor_profiles vp
                       WHERE (vp.id)::text = (storage.foldername(objects.name))[2]
                         AND vp.user_id = auth.uid()) )
     OR (     (storage.foldername(name))[1] = 'schools'
          AND (storage.foldername(name))[2] = ANY ((public.user_admin_school_ids())::text[]) )
     OR (     array_length(storage.foldername(name), 1) IS NULL
          AND name LIKE (auth.uid())::text || '-%' )
     OR (     (storage.foldername(name))[1] = 'unregistered_athletes'
          AND EXISTS (SELECT 1 FROM public.unregistered_athletes ua
                       WHERE (ua.id)::text = (storage.foldername(objects.name))[2]
                         AND (public.is_school_admin(ua.school_id) OR public.is_super_admin())) )
  )
);

-- ── 4. facility-photos: INSERT solo a la carpeta propia ────────────────────
--      (0 objetos y ningún uso en el cliente; antes cualquiera subía a cualquier ruta)
DROP POLICY IF EXISTS "Schools can upload facility photos" ON storage.objects;
DROP POLICY IF EXISTS "facility_photos_owner_insert" ON storage.objects;
CREATE POLICY "facility_photos_owner_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'facility-photos'
  AND (storage.foldername(name))[1] = (auth.uid())::text
);

-- ── 5. school-assets: fuera los duplicados viejos (sin status, LIMIT 1) ────
DROP POLICY IF EXISTS "Admin sube logo de su escuela" ON storage.objects;
DROP POLICY IF EXISTS "Admin borra logo de su escuela" ON storage.objects;

-- DELETE: el vigente más qr/ (antes solo lo cubría la vieja).
DROP POLICY IF EXISTS "school_assets_admin_delete" ON storage.objects;
CREATE POLICY "school_assets_admin_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'school-assets'
  AND (storage.foldername(name))[1] = ANY (ARRAY['logos','covers','qr'])
  AND (storage.foldername(name))[2] = ANY ((public.user_admin_school_ids())::text[])
);

-- SELECT acotada a las carpetas de sus escuelas (upsert de frontend viejo).
DROP POLICY IF EXISTS "school_assets_admin_read" ON storage.objects;
CREATE POLICY "school_assets_admin_read"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'school-assets'
  AND (storage.foldername(name))[1] = ANY (ARRAY['logos','covers','qr'])
  AND (storage.foldername(name))[2] = ANY ((public.user_admin_school_ids())::text[])
);

COMMIT;
