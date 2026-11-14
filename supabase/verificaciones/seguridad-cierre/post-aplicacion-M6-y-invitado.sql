-- Verificacion POSTERIOR (solo lectura): npx supabase db query --remote --read-only -f <este> -o json
select json_build_object(
 -- esperado: facility_resv_select_staff_scope SIN user_staff_school_ids (solo admin + role='staff')
 'policy_staff_scope', (select qual from pg_policies where tablename='facility_reservations' and policyname='facility_resv_select_staff_scope'),
 -- esperado: true / true / false / false
 'rpc_agenda', (select json_build_object(
     'existe', true,
     'secdef', p.prosecdef,
     'authenticated_exec', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
     'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE'),
     'cfg', p.proconfig::text)
   from pg_proc p where p.proname='agenda_reservas_escuela' and p.pronamespace='public'::regnamespace),
 -- esperado: el cuerpo menciona verified_email_at y conserva search_path fijo
 'reservar_cancha', (select json_build_object(
     'menciona_email', position('verified_email_at' in pg_get_functiondef(p.oid)) > 0,
     'cfg', p.proconfig::text,
     'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE'),
     'authenticated_exec', has_function_privilege('authenticated', p.oid, 'EXECUTE'))
   from pg_proc p where p.proname='reservar_cancha' and p.pronamespace='public'::regnamespace)
) as v;
