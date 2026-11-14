-- Prueba de 20261106152307_reservas_m6_agenda_coach (M6). Correr SOLO en una base de pruebas con la migración aplicada. Rollback al final.
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
  v_own uuid := pg_temp.mk_user('sec7.own@qa.sportmaps.test');
  v_adm uuid := pg_temp.mk_user('sec7.adm@qa.sportmaps.test');
  v_rec uuid := pg_temp.mk_user('sec7.recep@qa.sportmaps.test');
  v_coa uuid := pg_temp.mk_user('sec7.coach@qa.sportmaps.test');
  v_p1  uuid := pg_temp.mk_user('sec7.p1@qa.sportmaps.test');
  v_oth uuid := pg_temp.mk_user('sec7.otro@qa.sportmaps.test');   -- coach de OTRA escuela
  v_own2 uuid := pg_temp.mk_user('sec7.own2@qa.sportmaps.test');
  v_sa uuid := gen_random_uuid(); v_sb uuid := gen_random_uuid(); v_f uuid := gen_random_uuid();
  d text := current_setting('qa.d1'); r jsonb;
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'SEC7 A', v_own, 'venue'), (v_sb, 'SEC7 B', v_own2, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_adm, 'school_admin', 'active'), (v_sa, v_rec, 'staff', 'active'), (v_sa, v_coa, 'coach', 'active'),
    (v_sa, v_p1, 'parent', 'active'), (v_sb, v_oth, 'coach', 'active') on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_coa, v_p1, v_adm, v_rec, v_oth);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  values (v_f, v_sa, 'Cancha SEC7', 'futbol', 10, 80000, 100000, true, 'both', true,
    '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}'::jsonb);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.reservar_cancha(v_f, pg_temp.slot(d,'10:00'), pg_temp.slot(d,'11:00'), 'admin', 'sec7-p1-0001', 'cash', v_adm, v_p1, null, null, null, 1, 'nota privada p1', null, 0);
  if not (r->>'ok')::boolean then raise exception 'setup p1: %', r; end if;
  perform set_config('qa.own', v_own::text, true); perform set_config('qa.adm', v_adm::text, true);
  perform set_config('qa.rec', v_rec::text, true); perform set_config('qa.coa', v_coa::text, true);
  perform set_config('qa.p1', v_p1::text, true); perform set_config('qa.oth', v_oth::text, true);
  perform set_config('qa.sa', v_sa::text, true); perform set_config('qa.sb', v_sb::text, true);
  perform set_config('qa.f', v_f::text, true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- estructura: policy y permisos de la RPC
do $$
declare q text;
begin
  select qual into q from pg_policies where tablename='facility_reservations' and policyname='facility_resv_select_staff_scope';
  perform pg_temp.chk(q is not null and q like '%user_admin_school_ids%' and q like '%staff%' and q not like '%user_staff_school_ids%', 'policy staff_scope: admin + recepcion, sin user_staff_school_ids');
  perform pg_temp.chk(not has_function_privilege('anon', 'public.agenda_reservas_escuela(uuid,timestamptz,timestamptz)', 'EXECUTE'), 'anon sin EXECUTE en la RPC');
  perform pg_temp.chk(has_function_privilege('authenticated', 'public.agenda_reservas_escuela(uuid,timestamptz,timestamptz)', 'EXECUTE'), 'authenticated con EXECUTE en la RPC');
  perform pg_temp.chk((select prosecdef from pg_proc where proname='agenda_reservas_escuela'), 'RPC es SECURITY DEFINER');
  perform pg_temp.chk((select proconfig::text like '%search_path%' from pg_proc where proname='agenda_reservas_escuela'), 'RPC con search_path fijo');
end $$;

set local role authenticated;
do $$
declare
  sa uuid := current_setting('qa.sa')::uuid; sb uuid := current_setting('qa.sb')::uuid;
  d text := current_setting('qa.d1'); n int; cols text;
  t0 timestamptz; t1 timestamptz;
begin
  t0 := pg_temp.slot(d,'00:00'); t1 := t0 + interval '1 day';

  -- coach: tabla cerrada, RPC abierta
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 0, 'coach YA NO lee facility_reservations (ve ' || n || ')');
  select count(*) into n from public.agenda_reservas_escuela(sa, t0, t1);
  perform pg_temp.chk(n = 1, 'coach ve la agenda por RPC (ve ' || n || ')');
  select string_agg(a.attname, ',') into cols
    from pg_proc p, unnest(p.proargnames) with ordinality as a(attname, i)
   where p.proname = 'agenda_reservas_escuela' and a.i > 3;
  perform pg_temp.chk(cols !~ '(user_id|price|amount|notes|payment|snapshot|guest|external|email|phone)', 'la RPC no expone columnas sensibles (' || cols || ')');
  perform pg_temp.chk((select titulo from public.agenda_reservas_escuela(sa, t0, t1) limit 1) = 'Reservada', 'titulo generico');
  begin
    perform * from public.agenda_reservas_escuela(sb, t0, t1);
    perform pg_temp.chk(false, 'coach NO debe leer la agenda de OTRA escuela');
  exception when insufficient_privilege then perform pg_temp.chk(true, 'coach rechazado (42501) en escuela ajena'); end;

  -- coach de otra escuela
  perform pg_temp.as_user(current_setting('qa.oth')::uuid);
  begin
    perform * from public.agenda_reservas_escuela(sa, t0, t1);
    perform pg_temp.chk(false, 'coach ajeno NO debe leer la agenda');
  exception when insufficient_privilege then perform pg_temp.chk(true, 'coach de otra escuela rechazado (42501)'); end;

  -- padre: sin RPC
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  begin
    perform * from public.agenda_reservas_escuela(sa, t0, t1);
    perform pg_temp.chk(false, 'padre NO debe usar la RPC de agenda');
  exception when insufficient_privilege then perform pg_temp.chk(true, 'padre rechazado (42501)'); end;

  -- rango invalido
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  begin
    perform * from public.agenda_reservas_escuela(sa, t1, t0);
    perform pg_temp.chk(false, 'rango invertido debe fallar');
  exception when invalid_parameter_value then perform pg_temp.chk(true, 'rango invertido rechazado (22023)'); end;

  -- admin, recepcion y dueño siguen leyendo la tabla completa
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 1, 'admin lee la tabla (ve ' || n || ')');
  perform pg_temp.as_user(current_setting('qa.rec')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 1, 'recepcion (staff) lee la tabla (ve ' || n || ')');
  select count(*) into n from public.agenda_reservas_escuela(sa, t0, t1);
  perform pg_temp.chk(n = 1, 'recepcion tambien puede usar la RPC');
  perform pg_temp.as_user(current_setting('qa.own')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 1, 'dueño lee la tabla (ve ' || n || ')');
end $$;

-- anon: sin EXECUTE
reset role;
set local role anon;
do $$
begin
  begin
    perform * from public.agenda_reservas_escuela(current_setting('qa.sa')::uuid, now(), now() + interval '1 day');
    raise exception 'FALLO: anon ejecuto la RPC';
  exception when insufficient_privilege then raise notice 'OK: anon rechazado en la RPC'; end;
end $$;
reset role;
rollback;
