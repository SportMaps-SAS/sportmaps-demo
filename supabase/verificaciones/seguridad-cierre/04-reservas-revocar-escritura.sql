-- Prueba de 20261105213611_reservas_revocar_escritura_directa (se corre DESPUÉS de aplicarla). Rollback al final.
--   npm run qa:sql -- supabase/verificaciones/seguridad-cierre/04-reservas-revocar-escritura.sql
begin;

create or replace function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALLO: %', msg; end if; raise notice 'OK: %', msg; end $$;
grant execute on function pg_temp.chk(boolean, text) to public;
create or replace function pg_temp.slot(dia text, hhmm text) returns timestamptz language sql as $$
  select ((dia || ' ' || hhmm)::timestamp at time zone 'America/Bogota') $$;
grant execute on function pg_temp.slot(text, text) to public;
create or replace function pg_temp.mk_user(p_email text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role, created_at, updated_at)
  values (v, p_email, '{"role":"athlete"}'::jsonb, 'authenticated', 'authenticated', now(), now());
  return v;
end $$;
create or replace function pg_temp.as_user(p uuid) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true); end $$;
grant execute on function pg_temp.as_user(uuid) to public;
select set_config('qa.d1', ((now() at time zone 'America/Bogota')::date + 6)::text, true);

do $$
declare
  v_own uuid := pg_temp.mk_user('sec4.own@qa.sportmaps.test');
  v_adm uuid := pg_temp.mk_user('sec4.adm@qa.sportmaps.test');
  v_coa uuid := pg_temp.mk_user('sec4.coach@qa.sportmaps.test');
  v_par uuid := pg_temp.mk_user('sec4.par@qa.sportmaps.test');
  v_sa uuid := gen_random_uuid(); v_f uuid := gen_random_uuid();
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'SEC4 Venue', v_own, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_adm, 'school_admin', 'active'), (v_sa, v_coa, 'coach', 'active'), (v_sa, v_par, 'parent', 'active') on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_coa, v_par, v_adm);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  values (v_f, v_sa, 'Cancha SEC4', 'futbol', 10, 80000, 100000, true, 'both', true,
    '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}'::jsonb);
  perform set_config('qa.adm', v_adm::text, true); perform set_config('qa.coa', v_coa::text, true);
  perform set_config('qa.par', v_par::text, true); perform set_config('qa.f', v_f::text, true); perform set_config('qa.sa', v_sa::text, true);
end $$;

-- privilegios por catálogo
do $$ declare t text; p text; begin
  foreach t in array array['facility_reservations','reservation_payments','facility_blackouts'] loop
    foreach p in array array['INSERT','UPDATE','DELETE','TRUNCATE'] loop
      perform pg_temp.chk(not has_table_privilege('authenticated', 'public.' || t, p), 'g authenticated sin ' || p || ' en ' || t);
      perform pg_temp.chk(not has_table_privilege('anon', 'public.' || t, p), 'g anon sin ' || p || ' en ' || t);
    end loop;
    perform pg_temp.chk(has_table_privilege('authenticated', 'public.' || t, 'SELECT'), 'g authenticated conserva SELECT en ' || t);
    perform pg_temp.chk(has_table_privilege('service_role', 'public.' || t, 'INSERT'), 'g service_role conserva INSERT en ' || t);
  end loop;
  perform pg_temp.chk(not exists (select 1 from pg_policies where tablename in ('facility_reservations','reservation_payments','facility_blackouts')
                                    and cmd in ('INSERT','UPDATE','DELETE','ALL')), 'g no queda policy de escritura/ALL en las tres tablas');
  perform pg_temp.chk(not has_function_privilege('authenticated', 'public.submit_facility_booking_v2(uuid,uuid,date,time,time,text,text,text,integer,text,numeric,text,text)', 'EXECUTE'), 'g submit_facility_booking_v2 sin EXECUTE para authenticated');
  perform pg_temp.chk(has_function_privilege('service_role', 'public.submit_facility_booking_v2(uuid,uuid,date,time,time,text,text,text,integer,text,numeric,text,text)', 'EXECUTE'), 'g submit_facility_booking_v2 conserva service_role');
end $$;

-- el padre reserva por RPC y ve lo suyo
set local role authenticated;
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d1'); n int;
begin
  perform pg_temp.as_user(current_setting('qa.par')::uuid);
  r := public.reservar_cancha(f, pg_temp.slot(d,'10:00'), pg_temp.slot(d,'11:00'), 'app', 'sec4-par-00001');
  perform pg_temp.chk((r->>'ok')::boolean, 'rpc reservar_cancha funciona: ' || left(r::text, 60));
  perform set_config('qa.rid', r->'reservation'->>'id', true);
  perform set_config('qa.rref', r->'reservation'->>'payment_reference', true);
  select count(*) into n from public.facility_reservations where user_id = auth.uid();
  perform pg_temp.chk(n = 1, 'el padre ve sus reservas por SELECT');
  -- escritura directa: 42501
  begin
    insert into public.facility_reservations (facility_id, user_id, school_id, reservation_date, start_time, end_time, status)
    values (f, auth.uid(), current_setting('qa.sa')::uuid, d::date, '12:00', '13:00', 'pending');
    raise exception 'FALLO: insert directo permitido';
  exception when insufficient_privilege then null; end;
  begin update public.facility_reservations set status = 'confirmed' where id = current_setting('qa.rid')::uuid; raise exception 'FALLO: update directo permitido';
  exception when insufficient_privilege then null; end;
  begin delete from public.facility_reservations where id = current_setting('qa.rid')::uuid; raise exception 'FALLO: delete directo permitido';
  exception when insufficient_privilege then null; end;
  begin insert into public.reservation_payments (reservation_id, user_id, amount) values (current_setting('qa.rid')::uuid, auth.uid(), 1); raise exception 'FALLO: insert en reservation_payments permitido';
  exception when insufficient_privilege then null; end;
  begin insert into public.facility_blackouts (school_id, facility_id, starts_at, ends_at, kind) values (current_setting('qa.sa')::uuid, f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'other'); raise exception 'FALLO: insert en blackouts permitido';
  exception when insufficient_privilege then null; end;
  raise notice 'OK padre: SELECT propio sí; INSERT/UPDATE/DELETE directos 42501 en las tres tablas';
  -- otro padre/ajeno no ve la reserva
  perform pg_temp.as_user(gen_random_uuid());
  select count(*) into n from public.facility_reservations where id = current_setting('qa.rid')::uuid;
  perform pg_temp.chk(n = 0, 'un usuario ajeno no ve reservas de otros');
  -- coach (staff amplio): tampoco escribe directo
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  begin update public.facility_reservations set status = 'cancelled' where id = current_setting('qa.rid')::uuid; raise exception 'FALLO: coach actualiza directo';
  exception when insufficient_privilege then null; end;
  perform pg_temp.chk(true, 'coach sin escritura directa');
end $$;
reset role;

-- admin: SELECT de toda la escuela (policy SELECT-only) y operaciones por RPC
set local role authenticated;
do $$
declare r jsonb; d text := current_setting('qa.d1'); n int; rid uuid := current_setting('qa.rid')::uuid;
begin
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  select count(*) into n from public.facility_reservations where school_id = current_setting('qa.sa')::uuid;
  perform pg_temp.chk(n >= 1, 'el admin ve las reservas de su escuela (SELECT)');
  r := public.reprogramar_reserva(rid, pg_temp.slot(d,'15:00'), pg_temp.slot(d,'16:00'));
  perform pg_temp.chk((r->>'ok')::boolean, 'rpc reprogramar_reserva funciona (admin)');
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(d,'17:00'), pg_temp.slot(d,'18:00'), 'admin', 'sec4-adm-00001', 'cash', null, null, null, null, null, 1, null, null, 0);
  perform pg_temp.chk((r->>'ok')::boolean, 'rpc reservar_cancha (admin, cash) funciona');
  perform pg_temp.as_user(current_setting('qa.par')::uuid);
  r := public.reprogramar_reserva(rid, pg_temp.slot(d,'16:00'), pg_temp.slot(d,'17:00'));
  perform pg_temp.chk((r->>'ok')::boolean, 'rpc reprogramar_reserva funciona (dueño de la reserva)');
end $$;
reset role;

-- service_role: confirmar pago por RPC y escritura directa del BFF (aprobar/completar) siguen funcionando
set local role service_role;
do $$
declare r jsonb; rid uuid := current_setting('qa.rid')::uuid; n int; st text;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.confirmar_pago_reserva(current_setting('qa.rref'), 80000, null, 'wompi', 'evt-sec4-0001');
  perform pg_temp.chk((r->>'ok')::boolean, 'rpc confirmar_pago_reserva funciona (service_role): ' || left(r::text, 80));
  update public.facility_reservations set status = 'completed' where id = rid;   -- aprobar/completar por BFF
  get diagnostics n = row_count;
  select status into st from public.facility_reservations where id = rid;
  perform pg_temp.chk(n = 1 and st = 'completed', 'BFF (service_role) actualiza estado directo');
  insert into public.facility_blackouts (school_id, facility_id, starts_at, ends_at, kind, reason)
  values (current_setting('qa.sa')::uuid, current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.d1'),'21:00'), pg_temp.slot(current_setting('qa.d1'),'22:00'), 'maintenance', 'prueba');
  perform pg_temp.chk(true, 'blackout por service_role (auth.uid() NULL): el trigger de ocupación funciona');
  -- bloqueo que choca con una reserva vigente (la del admin 17:00-18:00 sigue confirmed)
  begin
    insert into public.facility_blackouts (school_id, facility_id, starts_at, ends_at, kind)
    values (current_setting('qa.sa')::uuid, current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.d1'),'17:00'), pg_temp.slot(current_setting('qa.d1'),'18:00'), 'other');
    raise exception 'FALLO: el bloqueo chocó con reserva y no falló';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    perform pg_temp.chk(sqlerrm like 'BLACKOUT_OVERLAPS_OCCUPANCY%', 'bloqueo sobre reserva vigente -> ' || left(sqlerrm, 60));
  end;
end $$;
reset role;
rollback;
