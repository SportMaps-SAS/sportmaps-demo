-- Verificación POSTERIOR a aplicar aplicar-1-a-N.sql (migraciones 1 a 5 del cierre de seguridad). Solo lectura.
-- npx supabase db query --remote --read-only -f supabase/verificaciones/seguridad-cierre/post-aplicacion-1-a-5.sql -o json
-- Cada clave dice su valor esperado.
select json_build_object(
  -- 1. esperado: tabla existe, ip_address text, sin CHECK de lista cerrada en action
  'audit_tabla', to_regclass('public.security_audit_log')::text,
  'audit_ip_tipo', (select data_type from information_schema.columns where table_schema='public' and table_name='security_audit_log' and column_name='ip_address'),
  'audit_checks', (select json_agg(left(pg_get_constraintdef(oid), 160)) from pg_constraint where conrelid = to_regclass('public.security_audit_log') and contype = 'c'),
  'audit_authenticated_escribe', (select has_table_privilege('authenticated', to_regclass('public.security_audit_log'), 'INSERT')),   -- esperado false
  'audit_anon_lee', (select has_table_privilege('anon', to_regclass('public.security_audit_log'), 'SELECT')),                         -- esperado false
  -- 2. esperado: policy con WITH CHECK y trigger de owner_id
  'schools_policy', (select json_agg(json_build_object('p', policyname, 'cmd', cmd, 'tiene_check', with_check is not null)) from pg_policies where schemaname='public' and tablename='schools' and policyname ilike '%manage owner%'),
  'trigger_owner_id', (select json_agg(tgname) from pg_trigger where tgrelid='public.schools'::regclass and not tgisinternal and tgname ilike '%owner%'),
  'trigger_school_type', (select json_agg(tgname) from pg_trigger where tgrelid='public.schools'::regclass and not tgisinternal and tgname ilike '%venue%'),
  -- 3. esperado: helper admin existe; reservar_cancha con 16 argumentos; CHECK de channel con ai e import; anon sin EXECUTE
  'helper_admin', (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='_reservas_es_admin'),
  'reservar_cancha_args', (select json_agg(pronargs) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reservar_cancha'),
  'reservar_anon_execute', (select bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='reservar_cancha'),
  'channel_check', (select left(pg_get_constraintdef(oid), 220) from pg_constraint where conrelid='public.facility_reservations'::regclass and conname ilike '%channel%' limit 1),
  -- 4. esperado: anon SIN INSERT/UPDATE/DELETE en estas 6 (lista vacía)
  'anon_escribe_planes', (select json_agg(c.relname) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
       and c.relname in ('school_addons','school_subscriptions','subscription_plans','school_members','school_settings','schools')
       and (has_table_privilege('anon', c.oid,'INSERT') or has_table_privilege('anon', c.oid,'UPDATE') or has_table_privilege('anon', c.oid,'DELETE'))),
  -- 5. esperado: reservations_select ya NO existe; existen select_own y select_staff_scope
  'policies_select_resv', (select json_agg(policyname order by policyname) from pg_policies where schemaname='public' and tablename='facility_reservations' and cmd='SELECT'),
  -- M7 NO debe estar aplicada todavía: authenticated aún escribe (esperado true hasta el final)
  'm7_pendiente_authenticated_inserta', (select has_table_privilege('authenticated', 'public.facility_reservations', 'INSERT')),
  -- sin cambio de volumen
  'resv_total', (select count(*) from public.facility_reservations)
) as v;
