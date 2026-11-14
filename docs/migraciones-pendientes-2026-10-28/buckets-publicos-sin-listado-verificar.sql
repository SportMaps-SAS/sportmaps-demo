-- =============================================================================
-- Verificación de 20261028110434_buckets_publicos_sin_listado — SOLO LECTURA
-- Correr DESPUÉS de pegar buckets-publicos-sin-listado.sql.
-- No escribe nada: SELECTs, y las sesiones simuladas van dentro de
-- BEGIN … ROLLBACK. No lista nombres de archivo: solo conteos.
-- =============================================================================

-- ── 1. No queda ninguna SELECT de bucket completo sobre los 4 buckets ───────
--    Esperado: 0 filas.
select policyname, roles, qual
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and cmd = 'SELECT'
   and qual ~ '(avatars|facility-photos|product-images|school-assets)'
   and regexp_replace(qual, '\s', '', 'g') ~ '^\(?bucket_id=''[a-z-]+''::text\)?$';

-- ── 2. Inventario esperado de policies de los 4 buckets ─────────────────────
--    Esperado (19 filas):
--      DELETE  product_images_admin_delete, product_images_owner_delete, school_assets_admin_delete
--      INSERT  avatars_owner_insert, avatars_unregistered_admin_insert, facility_photos_owner_insert,
--              product_images_owner_upload, school_assets_admin_insert, school_assets_qr_insert
--      SELECT  avatars_owner_read, school_assets_admin_read
--      UPDATE  "Users can update own avatar", avatars_unregistered_admin_update,
--              product_images_admin_update, product_images_owner_update,
--              school_assets_admin_update, school_assets_qr_update
--    Y NINGUNA de: avatars_public_read, facility_photos_public_read,
--    product_images_public_read, school_assets_public_read,
--    "Authenticated users can upload avatars", "Schools can upload facility photos",
--    "Admin sube logo de su escuela", "Admin borra logo de su escuela".
select cmd, policyname, roles
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and (coalesce(qual,'') || coalesce(with_check,'')) ~ '(avatars|facility-photos|product-images|school-assets)'
 order by cmd, policyname;

-- ── 3. INSERT de avatars/facility-photos ya no es «cualquier autenticado» ──
--    Esperado: 0 filas.
select policyname, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects' and cmd = 'INSERT'
   and with_check ~ '(avatars|facility-photos)'
   and with_check ~ 'auth\.role\(\)';

-- ── 4. anon ya no ve NINGUNA fila de los 4 buckets (lo que usa .list()) ─────
--    Esperado: 4 filas con visibles = 0.
begin;
set local role anon;
select b.bucket, (select count(*) from storage.objects o where o.bucket_id = b.bucket) as visibles
  from (values ('avatars'),('facility-photos'),('product-images'),('school-assets')) b(bucket);
rollback;

-- ── 5. Un autenticado SIN relación ve 0; un dueño ve solo lo suyo ───────────
--    Usuario X = un perfil sin escuela ni hijos ni vendor (elegido aquí).
--    Esperado: visibles_x = 0 en los 4 buckets.
select p.id as usuario_x
  from public.profiles p
 where not exists (select 1 from public.school_members sm where sm.profile_id = p.id)
   and not exists (select 1 from public.schools s where s.owner_id = p.id)
   and not exists (select 1 from public.children c where c.parent_id = p.id)
   and not exists (select 1 from public.vendor_profiles vp where vp.user_id = p.id)
   and not exists (select 1 from storage.objects o where o.owner = p.id
                    and o.bucket_id in ('avatars','facility-photos','product-images','school-assets'))
   and coalesce(p.role::text, '') not in ('admin', 'super_admin')
 limit 1;

-- Pega el uuid elegido en <X> y corre:
begin;
select set_config('request.jwt.claims', json_build_object('sub','<X>','role','authenticated')::text, true);
set local role authenticated;
select b.bucket, (select count(*) from storage.objects o where o.bucket_id = b.bucket) as visibles_x
  from (values ('avatars'),('facility-photos'),('product-images'),('school-assets')) b(bucket);
rollback;

-- ── 6. Un dueño de escuela ve solo logos/covers/qr de SUS escuelas ──────────
--    Esperado: fuera_de_su_escuela = 0 y propias >= 0.
--    Pega en <AD> el owner_id de una escuela que tenga logo (elige uno con):
--      select s.owner_id from public.schools s where s.logo_url like '%/school-assets/logos/%' limit 1;
begin;
select set_config('request.jwt.claims', json_build_object('sub','<AD>','role','authenticated')::text, true);
set local role authenticated;
select count(*) filter (where (storage.foldername(o.name))[2] = any ((public.user_admin_school_ids())::text[])) as propias,
       count(*) filter (where not ((storage.foldername(o.name))[2] = any ((public.user_admin_school_ids())::text[]))) as fuera_de_su_escuela
  from storage.objects o
 where o.bucket_id = 'school-assets';
rollback;

-- ── 7. La URL pública sigue sirviendo (desde una terminal, no SQL) ──────────
--    Esperado: 200 image/png. Es una captura de la ayuda, no un dato de usuario.
--    curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
--      "https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/school-assets/help-articles/registrar-nuevo-atleta/01-lista.png"
--
--    Y el listado anónimo ya no devuelve nada (esperado: []):
--    curl -s -X POST "https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/list/school-assets" \
--      -H "apikey: $SUPABASE_ANON_KEY" -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
--      -H "Content-Type: application/json" -d '{"prefix":"","limit":1}'
--    (antes del fix devolvía la primera entrada; con limit 1 no se enumera nada.)
