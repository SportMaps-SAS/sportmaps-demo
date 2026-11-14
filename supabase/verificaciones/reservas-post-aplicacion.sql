-- Verificación POSTERIOR a aplicar las migraciones de reservas F1 (solo lectura).
-- Correr con: npx supabase db query --remote --read-only -f supabase/verificaciones/reservas-post-aplicacion.sql -o json
-- Devuelve un solo JSON. Esperado: ver comentarios `-- esperado`.
select json_build_object(
  -- esperado: las 6 RPC existen, SECURITY DEFINER, search_path fijo
  'rpcs', (select json_agg(r order by r.proname) from (
     select p.proname, p.prosecdef, p.proconfig::text as cfg, p.proacl::text as acl
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('disponibilidad_canchas','reservar_cancha','cancelar_reserva',
                         'reprogramar_reserva','confirmar_pago_reserva','expirar_holds')) r),
  -- esperado: NINGUNA con anon=X; confirmar_pago_reserva y expirar_holds solo service_role
  'anon_execute_en_rpcs', (select json_agg(p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('disponibilidad_canchas','reservar_cancha','cancelar_reserva',
                         'reprogramar_reserva','confirmar_pago_reserva','expirar_holds')
       and has_function_privilege('anon', p.oid, 'EXECUTE')),
  -- esperado: false (v1 sin EXECUTE para authenticated)
  'v1_ejecutable_por_authenticated', (select bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'submit_facility_booking'),
  -- esperado: bookable_by, slot_step_min, min_duration_min, max_duration_min
  'facilities_cols_nuevas', (select json_agg(column_name) from information_schema.columns
     where table_schema='public' and table_name='facilities'
       and column_name in ('bookable_by','slot_step_min','min_duration_min','max_duration_min')),
  -- esperado: 4 tablas nuevas
  'tablas_nuevas', (select json_agg(c.relname) from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and c.relname in ('facility_rates','facility_blackouts','cancellation_policies','co_holidays')),
  -- esperado: anon sin SELECT en ninguna de las tablas de reservas (lista vacía/null)
  'anon_select_tablas_reservas', (select json_agg(c.relname) from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and c.relname in ('facility_occupancy','guest_bookers','facility_rates','facility_blackouts',
                         'cancellation_policies','co_holidays','facility_reservations','reservation_payments')
       and has_table_privilege('anon', c.oid, 'SELECT')),
  -- esperado: facility_occupancy con filas = reservas pending/confirmed futuras (hoy 0)
  'occupancy_n', (select count(*) from public.facility_occupancy),
  -- esperado: MMA BLAIR TEAM + Club Campestre Demo + Escuela Demo SportMaps (+ las de F0)
  'escuelas_con_addon', (select json_agg(r) from (
     select s.name, s.school_type from public.school_addons a join public.schools s on s.id = a.school_id
     where a.addon_key = 'reservations' and a.enabled order by 1) r),
  -- esperado: 1 fila (job de expirar_holds cada minuto) tras aplicar la ÚLTIMA migración
  'cron_expirar_holds', (select json_agg(jobname || ' | ' || schedule) from cron.job where command ilike '%expirar_holds%'),
  -- esperado: trigger de guarda de school_type presente
  'trigger_school_type', (select json_agg(tgname) from pg_trigger
     where tgrelid = 'public.schools'::regclass and not tgisinternal and tgname ilike '%venue%'),
  -- esperado: handle_new_user con search_path fijo, y SU cuerpo menciona facility_manager
  'handle_new_user', (select json_build_object(
        'cfg', p.proconfig::text,
        'menciona_facility_manager', position('facility_manager' in pg_get_functiondef(p.oid)) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'handle_new_user'),
  -- esperado: los triggers de auth.users siguen siendo los 2 de antes
  'triggers_auth_users', (select json_agg(tgname) from pg_trigger
     where tgrelid = 'auth.users'::regclass and not tgisinternal),
  -- esperado: sin cambios de volumen (60 filas históricas)
  'resv_status', (select json_agg(r) from (select status, count(*) n from public.facility_reservations group by 1) r)
) as v;
