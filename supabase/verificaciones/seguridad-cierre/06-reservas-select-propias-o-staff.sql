-- Prueba de 20261105214559_reservas_select_solo_propias_o_staff. Rollback al final.
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
  v_own uuid := pg_temp.mk_user('sec6.own@qa.sportmaps.test');
  v_adm uuid := pg_temp.mk_user('sec6.adm@qa.sportmaps.test');
  v_coa uuid := pg_temp.mk_user('sec6.coach@qa.sportmaps.test');
  v_p1  uuid := pg_temp.mk_user('sec6.p1@qa.sportmaps.test');
  v_p2  uuid := pg_temp.mk_user('sec6.p2@qa.sportmaps.test');
  v_ath uuid := pg_temp.mk_user('sec6.ath@qa.sportmaps.test');
  v_oth uuid := pg_temp.mk_user('sec6.otro@qa.sportmaps.test');   -- staff de OTRA escuela
  v_own2 uuid := pg_temp.mk_user('sec6.own2@qa.sportmaps.test');
  v_sa uuid := gen_random_uuid(); v_sb uuid := gen_random_uuid(); v_f uuid := gen_random_uuid();
  d text := current_setting('qa.d1'); r jsonb;
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'SEC6 A', v_own, 'venue'), (v_sb, 'SEC6 B', v_own2, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_adm, 'school_admin', 'active'), (v_sa, v_coa, 'coach', 'active'), (v_sa, v_p1, 'parent', 'active'),
    (v_sa, v_p2, 'parent', 'active'), (v_sa, v_ath, 'athlete', 'active'), (v_sb, v_oth, 'staff', 'active') on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_coa, v_p1, v_p2, v_adm, v_oth);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  values (v_f, v_sa, 'Cancha SEC6', 'futbol', 10, 80000, 100000, true, 'both', true,
    '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}'::jsonb);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- dos reservas por RPC (definer), a nombre de p1 y de p2, hechas por el admin
  r := public.reservar_cancha(v_f, pg_temp.slot(d,'10:00'), pg_temp.slot(d,'11:00'), 'admin', 'sec6-p1-0001', 'cash', v_adm, v_p1, null, null, null, 1, 'nota privada p1', null, 0);
  if not (r->>'ok')::boolean then raise exception 'setup p1: %', r; end if;
  r := public.reservar_cancha(v_f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'admin', 'sec6-p2-0001', 'cash', v_adm, v_p2, null, null, null, 1, 'nota privada p2', null, 0);
  if not (r->>'ok')::boolean then raise exception 'setup p2: %', r; end if;
  perform set_config('qa.own', v_own::text, true); perform set_config('qa.adm', v_adm::text, true);
  perform set_config('qa.coa', v_coa::text, true); perform set_config('qa.p1', v_p1::text, true);
  perform set_config('qa.p2', v_p2::text, true); perform set_config('qa.ath', v_ath::text, true);
  perform set_config('qa.oth', v_oth::text, true); perform set_config('qa.sa', v_sa::text, true);
  perform set_config('qa.f', v_f::text, true);
  perform set_config('request.jwt.claims', '', true);
end $$;

do $$ begin
  perform pg_temp.chk(not exists (select 1 from pg_policies where tablename='facility_reservations' and policyname='reservations_select'), 'reservations_select retirada');
end $$;

set local role authenticated;
do $$
declare sa uuid := current_setting('qa.sa')::uuid; n int; r jsonb;
begin
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 1, 'padre 1 ve solo la suya (ve ' || n || ')');
  select count(*) into n from public.facility_reservations where user_id = current_setting('qa.p2')::uuid;
  perform pg_temp.chk(n = 0, 'padre 1 no ve la del padre 2');
  perform pg_temp.as_user(current_setting('qa.ath')::uuid);
  select count(*) into n from public.facility_reservations;
  perform pg_temp.chk(n = 0, 'atleta (miembro) no ve ninguna ajena');
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 2, 'coach de la escuela ve las de su escuela (ve ' || n || ')');
  perform pg_temp.as_user(current_setting('qa.oth')::uuid);
  select count(*) into n from public.facility_reservations;
  perform pg_temp.chk(n = 0, 'staff de OTRA escuela no ve nada');
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 2, 'admin ve todas (ve ' || n || ')');
  perform pg_temp.as_user(current_setting('qa.own')::uuid);
  select count(*) into n from public.facility_reservations where school_id = sa;
  perform pg_temp.chk(n = 2, 'dueño ve todas (ve ' || n || ')');
  -- las RPC (definer) siguen funcionando para el padre, que no ve ajenas pero sí opera las suyas
  perform pg_temp.as_user(current_setting('qa.p1')::uuid);
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.d1'),'15:00'), pg_temp.slot(current_setting('qa.d1'),'16:00'), 'app', 'sec6-p1-0002');
  perform pg_temp.chk((r->>'ok')::boolean, 'reservar_cancha del padre funciona');
  r := public.cancelar_reserva((r->'reservation'->>'id')::uuid, 'x');
  perform pg_temp.chk((r->>'ok')::boolean, 'cancelar_reserva del padre funciona');
  -- ocupación sigue consultable por la RPC pública de disponibilidad
  r := public.disponibilidad_canchas(sa, current_setting('qa.d1')::date, current_setting('qa.d1')::date, null, current_setting('qa.f')::uuid, 60, null, null);
  perform pg_temp.chk(r is not null, 'disponibilidad_canchas sigue respondiendo al padre');
end $$;
reset role;
rollback;
