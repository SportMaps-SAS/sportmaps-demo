-- Prueba de 20261105213601_anon_sin_escritura_en_tablas_de_planes. Rollback al final.
begin;
do $$ declare t text; p text; begin
  foreach t in array array['school_addons','school_subscriptions','subscription_plans','school_members','school_settings','schools'] loop
    foreach p in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', 'public.' || t, p) then raise exception 'FALLO: anon conserva % en %', p, t; end if;
    end loop;
    if not has_table_privilege('authenticated', 'public.' || t, 'INSERT') then raise exception 'FALLO: authenticated perdió INSERT en %', t; end if;
  end loop;
  if not has_table_privilege('anon', 'public.subscription_plans', 'SELECT') then raise exception 'FALLO: anon perdió SELECT en subscription_plans'; end if;
  if not has_table_privilege('anon', 'public.schools', 'SELECT') then raise exception 'FALLO: anon perdió SELECT en schools'; end if;
  raise notice 'OK catálogo: anon sin escritura en las 6 tablas, SELECT conservado; authenticated intacto';
end $$;

set local role anon;
do $$ begin
  begin update public.school_addons set id = id; raise exception 'FALLO: anon actualiza school_addons';
  exception when insufficient_privilege then null; end;
  begin delete from public.school_subscriptions; raise exception 'FALLO: anon borra school_subscriptions';
  exception when insufficient_privilege then null; end;
  begin update public.subscription_plans set id = id; raise exception 'FALLO: anon actualiza subscription_plans';
  exception when insufficient_privilege then null; end;
  begin insert into public.schools(name, owner_id) values ('x', gen_random_uuid()); raise exception 'FALLO: anon inserta schools';
  exception when insufficient_privilege then null; end;
  perform count(*) from public.subscription_plans;   -- la landing sigue leyendo
  raise notice 'OK anon: permission denied en escritura, lectura de planes intacta';
end $$;
reset role;

-- registro (handle_new_user DEFINER) y onboarding del dueño siguen funcionando
do $$ declare v uuid := gen_random_uuid(); n int; begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role, created_at, updated_at)
  values (v, 'sec5.fm@qa.sportmaps.test', '{"role":"facility_manager","school_name":"SEC5 Club"}'::jsonb, 'authenticated', 'authenticated', now(), now());
  select count(*) into n from public.schools where owner_id = v and school_type = 'venue';
  if n <> 1 then raise exception 'FALLO: el registro no creó la escuela venue'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.schools set onboarding_status = 'completed', city = 'Bogotá' where owner_id = v;
  update public.school_settings set updated_at = now() where school_id = (select id from public.schools where owner_id = v);
  reset role;
  raise notice 'OK registro + onboarding del dueño con sesión siguen funcionando';
end $$;
rollback;
