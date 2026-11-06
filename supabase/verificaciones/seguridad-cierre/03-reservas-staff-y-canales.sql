-- Prueba de 20261105212125_reservas_staff_privilegiado_y_canales_ia. Gemelo local; rollback al final.
--   npm run qa:sql -- supabase/verificaciones/seguridad-cierre/03-reservas-staff-y-canales.sql
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
select set_config('qa.d2', ((now() at time zone 'America/Bogota')::date + 7)::text, true);
select set_config('qa.d3', ((now() at time zone 'America/Bogota')::date + 8)::text, true);
select set_config('qa.d4', ((now() at time zone 'America/Bogota')::date + 9)::text, true);

do $$
declare
  v_own uuid := pg_temp.mk_user('sec3.own@qa.sportmaps.test');
  v_adm uuid := pg_temp.mk_user('sec3.adm@qa.sportmaps.test');
  v_rec uuid := pg_temp.mk_user('sec3.rec@qa.sportmaps.test');
  v_coa uuid := pg_temp.mk_user('sec3.coach@qa.sportmaps.test');
  v_vie uuid := pg_temp.mk_user('sec3.viewer@qa.sportmaps.test');
  v_par uuid := pg_temp.mk_user('sec3.par@qa.sportmaps.test');
  v_oth uuid := pg_temp.mk_user('sec3.otro@qa.sportmaps.test');  -- admin de OTRA escuela
  v_own2 uuid := pg_temp.mk_user('sec3.own2@qa.sportmaps.test');
  v_sa uuid := gen_random_uuid(); v_sb uuid := gen_random_uuid(); v_f uuid := gen_random_uuid();
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'SEC3 Venue A', v_own, 'venue'), (v_sb, 'SEC3 Venue B', v_own2, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_adm, 'school_admin', 'active'), (v_sa, v_rec, 'staff', 'active'), (v_sa, v_coa, 'coach', 'active'),
    (v_sa, v_vie, 'viewer', 'active'), (v_sa, v_par, 'parent', 'active'), (v_sb, v_oth, 'admin', 'active')
  on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_coa, v_par, v_vie, v_rec, v_adm, v_oth);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  values (v_f, v_sa, 'Cancha SEC3', 'futbol', 10, 80000, 100000, true, 'both', true,
    '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}'::jsonb);
  perform set_config('qa.own', v_own::text, true); perform set_config('qa.adm', v_adm::text, true);
  perform set_config('qa.rec', v_rec::text, true); perform set_config('qa.coa', v_coa::text, true);
  perform set_config('qa.vie', v_vie::text, true); perform set_config('qa.par', v_par::text, true);
  perform set_config('qa.oth', v_oth::text, true); perform set_config('qa.f', v_f::text, true);
  perform set_config('qa.sa', v_sa::text, true);
end $$;

-- ══ (a) rol administrativo ══════════════════════════════════════════════════════
do $$
declare s uuid := current_setting('qa.sa')::uuid;
begin
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.own')::uuid) = 'staff', 'a1 dueño = staff');
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.adm')::uuid) = 'staff', 'a2 school_admin = staff');
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.rec')::uuid) = 'staff', 'a3 recepción (school_members.staff) = staff');
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.coa')::uuid) = 'member', 'a4 coach = member (ruta service_role)');
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.vie')::uuid) = 'member', 'a5 viewer = member');
  perform pg_temp.chk(public._reservas_rol(s, current_setting('qa.oth')::uuid) = 'external', 'a6 admin de OTRA escuela = external');
  perform pg_temp.chk(not public._reservas_es_admin(s, current_setting('qa.rec')::uuid, false), 'a7 recepción no es admin estricto');
end $$;

-- coach con sesión: reserva como miembro (tarifa member), NO puede lo privilegiado
set local role authenticated;
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d1');
begin
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  r := public.reservar_cancha(f, pg_temp.slot(d,'10:00'), pg_temp.slot(d,'11:00'), 'app', 'sec3-coach-0001');
  perform pg_temp.chk((r->>'ok')::boolean and (r->'pricing'->>'audience') = 'member', 'a9 coach reserva como miembro (audience member): ' || r::text);
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'app', 'sec3-coach-0002', 'none');
  perform pg_temp.chk(r->>'error' = 'PAYMENT_METHOD_NOT_ALLOWED', 'a10 coach: payment none -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'app', 'sec3-coach-0003', 'cash', null, null, null, null, null, 1, null, null, 50000);
  perform pg_temp.chk(r->>'error' = 'STAFF_ONLY_FIELD', 'a11 coach: amount_paid -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'app', 'sec3-coach-0004', 'online', null, current_setting('qa.par')::uuid);
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'a12 coach: reservar a nombre de tercero -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'app', 'sec3-coach-0005', 'online', null, null, null, '{"phone":"3001112233","full_name":"Inv"}'::jsonb);
  perform pg_temp.chk(r->>'error' = 'STAFF_ONLY_FIELD', 'a13 coach: invitado -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'app', 'sec3-coach-0006', 'online', null, null, null, null, 'member');
  perform pg_temp.chk(r->>'error' = 'STAFF_ONLY_FIELD', 'a14 coach: p_rate_audience -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'12:00'), pg_temp.slot(d,'13:00'), 'admin', 'sec3-coach-0007');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'a15 coach: canal admin -> ' || (r->>'error'));
  -- saltarse horario: 03:00 fuera de horario
  r := public.reservar_cancha(f, pg_temp.slot(d,'03:00'), pg_temp.slot(d,'04:00'), 'app', 'sec3-coach-0008');
  perform pg_temp.chk(r->>'error' = 'OUTSIDE_HOURS', 'a16 coach no se salta horario -> ' || (r->>'error'));
  -- el coach NO cancela la reserva de otro (la del padre, creada más abajo por el admin)
end $$;
reset role;

-- admin con sesión: sí puede
set local role authenticated;
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d1');
begin
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  r := public.reservar_cancha(f, pg_temp.slot(d,'14:00'), pg_temp.slot(d,'15:00'), 'admin', 'sec3-adm-0001', 'cash', null, current_setting('qa.par')::uuid, null, null, 'member', 1, null, null, 40000);
  perform pg_temp.chk((r->>'ok')::boolean, 'a17 admin reserva a nombre de tercero con cash/monto/audiencia: ' || r::text);
  perform set_config('qa.resv_par', r->'reservation'->>'id', true);
end $$;
reset role;

-- coach no cancela ni reprograma la reserva ajena; el admin sí
set local role authenticated;
do $$
declare r jsonb; d text := current_setting('qa.d1'); rid uuid := current_setting('qa.resv_par')::uuid;
begin
  perform pg_temp.as_user(current_setting('qa.coa')::uuid);
  r := public.cancelar_reserva(rid, 'x');
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'a18 coach no cancela reserva ajena');
  r := public.reprogramar_reserva(rid, pg_temp.slot(d,'16:00'), pg_temp.slot(d,'18:00'));
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'a19 coach no reprograma reserva ajena');
  perform pg_temp.as_user(current_setting('qa.oth')::uuid);   -- admin de otra escuela
  r := public.cancelar_reserva(rid, 'x');
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', 'a20 admin de otra escuela no cancela');
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  r := public.reprogramar_reserva(rid, pg_temp.slot(d,'16:00'), pg_temp.slot(d,'18:00'));
  perform pg_temp.chk((r->>'ok')::boolean, 'a21 admin reprograma con cambio de duración: ' || r::text);
  r := public.cancelar_reserva(rid, 'motivo' || chr(7) || chr(1) || ' con control');
  perform pg_temp.chk((r->>'ok')::boolean and (r->'refund'->>'pct') = '100', 'a22 admin cancela con 100 %');
  perform pg_temp.chk((select cancellation_reason from public.facility_reservations where id = rid) = 'motivo con control', 'c1 motivo sin caracteres de control');
  r := public.cancelar_reserva(rid, repeat('x', 501));
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'c2 motivo > 500 -> INVALID_ARGUMENT');
end $$;
reset role;

-- ══ (b) canales ai/import ════════════════════════════════════════════════════════
-- b1: desde authenticated (incluso admin): CHANNEL_NOT_ALLOWED
set local role authenticated;
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d2');
begin
  perform pg_temp.as_user(current_setting('qa.adm')::uuid);
  r := public.reservar_cancha(f, pg_temp.slot(d,'06:00'), pg_temp.slot(d,'07:00'), 'ai', 'sec3-ai-auth-1', 'online', current_setting('qa.adm')::uuid, null, null, null, null, 1, null, null, 0, 'msg:123');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b1 ai desde authenticated (admin) -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'06:00'), pg_temp.slot(d,'07:00'), 'import', 'sec3-imp-auth-1', 'online', current_setting('qa.adm')::uuid, null, null, null, null, 1, null, null, 0, 'doc#1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b2 import desde authenticated -> ' || (r->>'error'));
end $$;
reset role;

-- anon no tiene EXECUTE
do $$ begin
  perform pg_temp.chk(not has_function_privilege('anon', 'public.reservar_cancha(uuid,timestamptz,timestamptz,text,text,text,uuid,uuid,uuid,jsonb,text,integer,text,text,numeric,text)', 'EXECUTE'), 'b3 anon sin EXECUTE en reservar_cancha');
  perform pg_temp.chk(not has_function_privilege('authenticated', 'public._reservas_es_admin(uuid,uuid,boolean)', 'EXECUTE'), 'b3b authenticated sin EXECUTE en el helper');
end $$;

-- service_role (claims role=service_role, sin sub)
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d2'); adm uuid := current_setting('qa.adm')::uuid;
  n int; i int; ok int := 0; rl int := 0; h int;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.reservar_cancha(f, pg_temp.slot(d,'06:00'), pg_temp.slot(d,'07:00'), 'ai', 'sec3-ai-svc-0001', 'online', adm, null, null, null, null, 1, 'nota' || chr(7) || chr(11) || 'ok', 'Org' || chr(2), 0, 'msg:123/abc#1');
  perform pg_temp.chk((r->>'ok')::boolean, 'b4 ai por service_role + admin: ' || r::text);
  perform pg_temp.chk((select price_snapshot->>'created_via' = 'ai' and price_snapshot->>'source_ref' = 'msg:123/abc#1'
                         and price_snapshot->>'created_by' = adm::text and status = 'pending_payment' and channel = 'ai'
                         and notes = 'notaok' and external_org_name = 'Org'
                         from public.facility_reservations where idempotency_key = 'sec3-ai-svc-0001'),
                      'b5 snapshot created_via/source_ref/created_by, pending_payment, texto sin control');
  -- dinero: cash / none / amount_paid prohibidos
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0002', 'cash', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'PAYMENT_METHOD_NOT_ALLOWED', 'b6 ai + cash -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'import', 'sec3-ai-svc-0003', 'none', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'PAYMENT_METHOD_NOT_ALLOWED', 'b7 import + none -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0004', 'online', adm, null, null, null, null, 1, null, null, 1000, 'x:1');
  perform pg_temp.chk(r->>'error' = 'PAYMENT_METHOD_NOT_ALLOWED', 'b8 ai + amount_paid -> ' || (r->>'error'));
  -- source_ref inválido / ausente
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0005', 'online', adm, null, null, null, null, 1, null, null, 0, 'mal ref; drop');
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'b9 source_ref con espacios/; -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0006', 'online', adm, null, null, null, null, 1, null, null, 0, repeat('a', 201));
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'b10 source_ref > 200 -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0007', 'online', adm, null, null, null, null, 1, null, null, 0, null);
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'b11 ai sin source_ref -> ' || (r->>'error'));
  -- invitado, actor no admin, actor de otra escuela, sin actor
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0008', 'online', adm, null, null, '{"phone":"3000000000","full_name":"X"}'::jsonb, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b12 ai + invitado -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0009', 'online', current_setting('qa.coa')::uuid, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b13 ai con actor coach -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0010', 'online', current_setting('qa.rec')::uuid, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b14 ai con actor recepción (no admin estricto) -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0011', 'online', current_setting('qa.oth')::uuid, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b15 ai con admin de OTRA escuela -> ' || (r->>'error'));
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0012', 'online', null, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b16 ai sin actor -> ' || (r->>'error'));
  -- claims de anon/authenticated sin sub no cuentan como service_role
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := public.reservar_cancha(f, pg_temp.slot(d,'07:00'), pg_temp.slot(d,'08:00'), 'ai', 'sec3-ai-svc-0013', 'online', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', 'b17 claims role=anon -> ' || (r->>'error'));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  -- idempotencia: misma llave devuelve replay, no cuenta para el tope
  r := public.reservar_cancha(f, pg_temp.slot(d,'06:00'), pg_temp.slot(d,'07:00'), 'ai', 'sec3-ai-svc-0001', 'online', adm, null, null, null, null, 1, 'nota' || chr(7) || chr(11) || 'ok', 'Org' || chr(2), 0, 'msg:123/abc#1');
  perform pg_temp.chk((r->>'ok')::boolean and (r->>'idempotent_replay')::boolean, 'b18 replay idempotente');
  -- no se salta blackout/alineación: 06:30 desalineada
  r := public.reservar_cancha(f, pg_temp.slot(d,'08:10'), pg_temp.slot(d,'09:10'), 'ai', 'sec3-ai-svc-0014', 'online', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' in ('SLOT_NOT_ALIGNED','INVALID_DURATION'), 'b19 ai no se salta la alineación -> ' || (r->>'error'));
  -- facility sin tarifa -> total 0 por falta de tarifa NO se regala
  update public.facilities set hourly_rate = 0, rental_rate = 0 where id = f;
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'ai', 'sec3-ai-svc-0015', 'online', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'PRICE_NOT_CONFIGURED', 'b20 ai en cancha sin tarifa -> ' || (r->>'error'));
  update public.facilities set hourly_rate = 80000, rental_rate = 100000 where id = f;
  -- booking_enabled
  update public.facilities set booking_enabled = false where id = f;
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'ai', 'sec3-ai-svc-0016', 'online', adm, null, null, null, null, 1, null, null, 0, 'x:1');
  perform pg_temp.chk(r->>'error' = 'FACILITY_NOT_BOOKABLE', 'b21 ai no se salta booking_enabled -> ' || (r->>'error'));
  update public.facilities set booking_enabled = true where id = f;

  -- ráfaga: ya hay 1 creada por este actor en la hora; 29 más pasan, la 31.ª y siguientes RATE_LIMITED_AUTOMATION
  for i in 0..31 loop
    h := 8 + (i % 14);
    r := public.reservar_cancha(f, pg_temp.slot((case when i < 14 then d when i < 28 then current_setting('qa.d3') else current_setting('qa.d4') end), lpad((h)::text,2,'0') || ':00'),
                                  pg_temp.slot((case when i < 14 then d when i < 28 then current_setting('qa.d3') else current_setting('qa.d4') end), lpad((h+1)::text,2,'0') || ':00'),
                                  case when i % 2 = 0 then 'ai' else 'import' end, 'sec3-burst-' || lpad(i::text, 4, '0'),
                                  'online', adm, null, null, null, null, 1, null, null, 0, 'burst:' || i);
    if (r->>'ok')::boolean then ok := ok + 1; elsif r->>'error' = 'RATE_LIMITED_AUTOMATION' then rl := rl + 1; end if;
  end loop;
  select count(*) into n from public.facility_reservations where channel in ('ai','import') and price_snapshot->>'created_by' = adm::text;
  perform pg_temp.chk(n = 30, 'b22 el tope es exacto: 30 reservas ai/import por actor/hora (hay ' || n || ', ok=' || ok || ', limitadas=' || rl || ')');
  perform pg_temp.chk(rl >= 1, 'b23 hubo RATE_LIMITED_AUTOMATION');
  r := public.reservar_cancha(f, pg_temp.slot(d,'22:00'), pg_temp.slot(d,'23:00'), 'ai', 'sec3-burst-extra', 'online', adm, null, null, null, null, 1, null, null, 0, 'burst:x');
  perform pg_temp.chk(r->>'error' = 'RATE_LIMITED_AUTOMATION', 'b24 la reserva 31 -> ' || (r->>'error'));
  -- otro actor admin (dueño) no comparte el tope
  r := public.reservar_cancha(f, pg_temp.slot(d,'22:00'), pg_temp.slot(d,'23:00'), 'ai', 'sec3-own-ai-1', 'online', current_setting('qa.own')::uuid, null, null, null, null, 1, null, null, 0, 'own:1');
  perform pg_temp.chk((r->>'ok')::boolean, 'b25 el tope es por actor: ' || r::text);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ══ (c) texto libre ═════════════════════════════════════════════════════════════
do $$
declare r jsonb; f uuid := current_setting('qa.f')::uuid; d text := current_setting('qa.d1'); adm uuid := current_setting('qa.adm')::uuid;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  r := public.reservar_cancha(f, pg_temp.slot(d,'21:00'), pg_temp.slot(d,'22:00'), 'admin', 'sec3-txt-0001', 'online', adm, null, null,
                              jsonb_build_object('phone','3009998877','full_name','Ana' || chr(7) || ' Gómez' || chr(27)), null, 1, repeat('n',500), null, 0);
  perform pg_temp.chk((r->>'ok')::boolean, 'c3 invitado con control en el nombre: ' || r::text);
  perform pg_temp.chk((select full_name from public.guest_bookers where phone = '3009998877') = 'Ana Gómez', 'c4 nombre de invitado limpio');
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'admin', 'sec3-txt-0002', 'online', adm, null, null, null, null, 1, repeat('n',501), null, 0);
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'c5 notas > 500');
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'admin', 'sec3-txt-0003', 'online', adm, null, null, null, null, 1, null, repeat('o',201), 0);
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'c6 organización > 200');
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'admin', 'sec3-txt-0004', 'online', adm, null, null,
                              jsonb_build_object('phone','3009998866','full_name',repeat('a',201)), null, 1, null, null, 0);
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'c7 nombre de invitado > 200');
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'admin', 'sec3-txt-0005', 'online', adm, null, null,
                              jsonb_build_object('phone','3009998855','full_name',chr(7) || chr(8)), null, 1, null, null, 0);
  perform pg_temp.chk(r->>'error' = 'INVALID_ARGUMENT', 'c8 nombre de invitado solo control -> vacío -> inválido');
  -- inyección clásica queda como dato, no se ejecuta
  r := public.reservar_cancha(f, pg_temp.slot(d,'20:00'), pg_temp.slot(d,'21:00'), 'admin', 'sec3-txt-0006', 'online', adm, null, null, null, null, 1, '''; drop table public.facility_reservations; --', null, 0);
  perform pg_temp.chk((r->>'ok')::boolean and to_regclass('public.facility_reservations') is not null, 'c9 comillas/SQL en notas se guardan como texto');
  perform set_config('request.jwt.claims', '', true);
end $$;
rollback;
