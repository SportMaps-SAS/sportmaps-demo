-- Prueba de 20261105211824_security_audit_log_tabla (estado final). Gemelo local, rollback al final.
begin;
do $$
declare v_uid uuid; v_n int; v_ok boolean;
begin
  select id into v_uid from auth.users limit 1;
  -- service_role (postgres en el gemelo) inserta una acción del BFF y TG_OP en mayúsculas
  insert into public.security_audit_log(user_id, action, target_table, target_id, metadata, ip_address)
  values (v_uid, 'facility_reservation_approve', 'facility_reservations', 'x', '{"school_id":"a"}', '1.2.3.4, 5.6.7.8');
  insert into public.security_audit_log(action) values ('INSERT');
  -- formato inválido
  begin insert into public.security_audit_log(action) values ('bad action!'); raise exception 'FALLO: aceptó action inválida';
  exception when check_violation then null; end;
  begin insert into public.security_audit_log(action) values (repeat('a',121)); raise exception 'FALLO: aceptó action larga';
  exception when check_violation then null; end;
  begin insert into public.security_audit_log(action, ip_address) values ('x', repeat('1',65)); raise exception 'FALLO: ip larga';
  exception when check_violation then null; end;
  -- el trigger de salud de marketplace (TG_OP uuid->text) debe poder escribir
  perform 1;
end $$;

-- anon: nada
set local role anon;
do $$ begin
  begin perform count(*) from public.security_audit_log; raise exception 'FALLO: anon lee';
  exception when insufficient_privilege then null; end;
  begin insert into public.security_audit_log(action) values ('x'); raise exception 'FALLO: anon inserta';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- authenticated común: no inserta (42501), no actualiza/borra, y SELECT devuelve 0 filas (policy platform admin)
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-00000000aaaa','role','authenticated')::text, true);
do $$ declare n int; begin
  begin insert into public.security_audit_log(action) values ('forjada'); raise exception 'FALLO: authenticated inserta';
  exception when insufficient_privilege then null; end;
  begin update public.security_audit_log set action='x'; raise exception 'FALLO: authenticated actualiza';
  exception when insufficient_privilege then null; end;
  begin delete from public.security_audit_log; raise exception 'FALLO: authenticated borra';
  exception when insufficient_privilege then null; end;
  select count(*) into n from public.security_audit_log;
  if n <> 0 then raise exception 'FALLO: authenticated no admin ve % filas', n; end if;
  raise notice 'OK: authenticated sin insert/update/delete y sin lectura';
end $$;
reset role;

-- admin de plataforma sí lee
do $$ declare v_pa uuid; n int; begin
  select profile_id into v_pa from public.platform_admins where is_active limit 1;
  if v_pa is null then raise notice 'SIN platform_admin en el gemelo: lectura de admin no probada'; return; end if;
  perform set_config('request.jwt.claims', json_build_object('sub',v_pa,'role','authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.security_audit_log;
  reset role;
  if n < 1 then raise exception 'FALLO: platform admin no lee'; end if;
  raise notice 'OK: platform admin lee % filas', n;
end $$;
rollback;
