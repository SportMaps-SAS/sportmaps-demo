-- =============================================================================
-- PRUEBAS de reservas de canchas F1 (motor de reservas) + registro de dueños de espacios.
-- NO es una migración. Correr SOLO contra el GEMELO local, después de aplicar las migraciones
-- 20261105162243 .. 20261105163229, 20261105163452 y 20261105164434 (registro_dueno_de_espacios):
--     npm run qa:sql -- supabase/verificaciones/reservas-f1-pruebas.sql
-- Todo en una transacción con ROLLBACK final: no persiste nada. Cada chequeo hace
-- RAISE EXCEPTION si falla. La prueba de 50 simultáneas y la de misma llave x10 son
-- de concurrencia real: van en supabase/verificaciones/reservas-f1-concurrencia.mjs.
-- SUPUESTO: auth.users del gemelo acepta INSERT con (id,email,raw_user_meta_data,aud,role);
-- y schools / facilities aceptan los INSERT mínimos de abajo (si el gemelo exige otra
-- columna NOT NULL, ajustar el SETUP).
-- =============================================================================
begin;

create or replace function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FALLO: %', msg; end if; raise notice 'OK: %', msg; end $$;

create or replace function pg_temp.slot(dia text, hhmm text) returns timestamptz language sql as $$
  select ((dia || ' ' || hhmm)::timestamp at time zone 'America/Bogota') $$;
grant execute on function pg_temp.slot(text, text) to public;  -- las pruebas la llaman tras set local role authenticated

create or replace function pg_temp.mk_user(p_email text, p_meta jsonb) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data, aud, role, created_at, updated_at)
  values (v, p_email, p_meta, 'authenticated', 'authenticated', now(), now());
  return v;
end $$;

select set_config('qa.dia',  ((now() at time zone 'America/Bogota')::date + 3)::text, true);
select set_config('qa.dia2', ((now() at time zone 'America/Bogota')::date + 4)::text, true);

-- ══ 0. REGISTRO DE DUEÑOS (20261105163452_registro_dueno_de_espacios) ═══════════
do $$
declare v_fm uuid; v_ath uuid; v_adm uuid; v_sup uuid; v_s record; v_p record;
begin
  -- 0a. facility_manager + school_name (+ school_type del cliente, que se ignora) → escuela venue + owner
  v_fm := pg_temp.mk_user('qa.fm@qa.sportmaps.test',
    '{"role":"facility_manager","school_name":"QA Club Canchas","school_type":"academy","full_name":"QA FM"}'::jsonb);
  select * into v_p from public.profiles where id = v_fm;
  perform pg_temp.chk(v_p.role::text = 'facility_manager' and v_p.needs_role_selection = false, '0a perfil facility_manager sin needs_role_selection');
  select * into v_s from public.schools where owner_id = v_fm;
  perform pg_temp.chk(v_s.id is not null and v_s.school_type = 'venue', '0a la escuela creada es school_type venue (aunque el metadata dijera academy)');
  perform pg_temp.chk(exists (select 1 from public.school_members where school_id = v_s.id and profile_id = v_fm and role = 'owner' and status = 'active'), '0a membresía owner activa');
  perform pg_temp.chk(exists (select 1 from public.school_settings where school_id = v_s.id), '0a school_settings creada');
  perform pg_temp.chk(public.has_entitlement(v_s.id, 'reservations'), '0a la escuela venue tiene entitlement reservations');

  -- 0b. athlete que manda school_type=venue en el metadata NO crea venue (ni escuela)
  v_ath := pg_temp.mk_user('qa.ath.venue@qa.sportmaps.test',
    '{"role":"athlete","school_name":"Intento Venue","school_type":"venue"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v_ath) = 'athlete', '0b athlete sigue athlete');
  perform pg_temp.chk(not exists (select 1 from public.schools where owner_id = v_ath), '0b athlete + school_type venue no crea escuela');

  -- 0b2. role 'school' + school_type=venue en metadata: escuela creada NO es venue
  v_sup := pg_temp.mk_user('qa.school.venue@qa.sportmaps.test',
    '{"role":"school","school_name":"Escuela Intento","school_type":"venue"}'::jsonb);
  perform pg_temp.chk((select school_type from public.schools where owner_id = v_sup) is distinct from 'venue', '0b2 role school ignora school_type venue del metadata');

  -- 0c. role=admin: el rol de plataforma NUNCA se autoasigna. (Comportamiento vivo de 20261010202857:
  --     'admin'/'school_admin' sin invitación → 'school'; NO queda profiles.role admin.)
  v_adm := pg_temp.mk_user('qa.admin@qa.sportmaps.test', '{"role":"admin","full_name":"QA admin"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v_adm) not in ('admin','super_admin','facility_manager'), '0c role=admin no concede admin de plataforma');
  -- 0c2. super_admin cae a athlete + selección de rol
  v_adm := pg_temp.mk_user('qa.superadmin@qa.sportmaps.test', '{"role":"super_admin"}'::jsonb);
  select * into v_p from public.profiles where id = v_adm;
  perform pg_temp.chk(v_p.role::text = 'athlete' and v_p.needs_role_selection = true, '0c2 role=super_admin cae a athlete + needs_role_selection');
  -- 0d. facility_manager no es admin de plataforma
  perform pg_temp.chk(not exists (select 1 from public.platform_admins where profile_id = v_fm), '0d facility_manager no está en platform_admins');
end $$;

do $$
declare v uuid; v_s record; v_n int; v_inv boolean := true;
begin
  -- 0e. roles existentes sin regresión (incluye alias padre)
  v := pg_temp.mk_user('qa.r.athlete@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'athlete', '0e athlete -> athlete');
  v := pg_temp.mk_user('qa.r.parent@qa.sportmaps.test', '{"role":"parent"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'parent', '0e parent -> parent');
  v := pg_temp.mk_user('qa.r.padre@qa.sportmaps.test', '{"role":"padre"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'parent', '0e padre -> parent');
  v := pg_temp.mk_user('qa.r.coach@qa.sportmaps.test', '{"role":"coach"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'coach', '0e coach -> coach');

  -- 0f. school sin school_type en el metadata: escuela normal (no venue), a lo sumo una Sede Principal
  v := pg_temp.mk_user('qa.r.school@qa.sportmaps.test', '{"role":"school","school_name":"QA Escuela Normal"}'::jsonb);
  select * into v_s from public.schools where owner_id = v;
  perform pg_temp.chk(v_s.id is not null and v_s.school_type is distinct from 'venue', '0f school sin metadata: escuela no venue (school_type=' || coalesce(v_s.school_type, 'NULL') || '; el esquema viejo daba academy)');
  select count(*) into v_n from public.school_branches where school_id = v_s.id and name = 'Sede Principal';
  perform pg_temp.chk(v_n <= 1, '0f a lo sumo una Sede Principal (hay ' || v_n || ')');

  -- 0g. Google OAuth: sin role -> athlete + needs_role_selection, sin escuela
  v := pg_temp.mk_user('qa.r.oauth@qa.sportmaps.test', '{"full_name":"QA OAuth","name":"QA OAuth"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'athlete' and (select needs_role_selection from public.profiles where id = v), '0g OAuth sin role -> athlete + needs_role_selection');
  perform pg_temp.chk(not exists (select 1 from public.schools where owner_id = v), '0g OAuth sin role no crea escuela');

  -- 0h. facility_manager SIN school_name: perfil sin escuela, el alta no se rompe
  v := pg_temp.mk_user('qa.r.fm.noname@qa.sportmaps.test', '{"role":"facility_manager"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'facility_manager', '0h facility_manager sin school_name: perfil facility_manager');
  perform pg_temp.chk(not exists (select 1 from public.schools where owner_id = v), '0h sin school_name no crea escuela');

  -- 0i. mayúsculas y espacios
  v := pg_temp.mk_user('qa.r.fm.caps@qa.sportmaps.test', '{"role":" Facility_Manager ","school_name":"QA Caps"}'::jsonb);
  perform pg_temp.chk((select role::text from public.profiles where id = v) = 'facility_manager', '0i " Facility_Manager " se normaliza');
  select * into v_s from public.schools where owner_id = v;
  perform pg_temp.chk(v_s.school_type = 'venue', '0i y crea escuela venue');
  -- 0j. una sola fila de suscripción para el venue
  select count(*) into v_n from public.school_subscriptions where school_id = v_s.id;
  perform pg_temp.chk(v_n <= 1, '0j school_subscriptions del venue: a lo sumo una fila (hay ' || v_n || ')');

  -- 0k/0l. con invitación pendiente (si el esquema de invitations exige más columnas, se omite con aviso)
  begin
    insert into public.invitations (email, role_to_assign, status) values ('qa.r.fm.inv@qa.sportmaps.test', 'facility_manager', 'pending');
    insert into public.invitations (email, role_to_assign, status) values ('qa.r.sadm.inv@qa.sportmaps.test', 'school_admin', 'pending');
  exception when others then
    v_inv := false; raise notice 'AVISO: 0k/0l omitidas, invitations exige otras columnas (%)', sqlerrm;
  end;
  if v_inv then
    v := pg_temp.mk_user('qa.r.fm.inv@qa.sportmaps.test', '{"role":"facility_manager","school_name":"QA Inv Venue"}'::jsonb);
    perform pg_temp.chk((select role::text from public.profiles where id = v) = 'facility_manager'
                        and (select school_type from public.schools where owner_id = v) = 'venue', '0k facility_manager con invitación pendiente: sigue siendo dueño venue');
    v := pg_temp.mk_user('qa.r.sadm.inv@qa.sportmaps.test', '{"role":"school_admin","school_name":"QA Fantasma"}'::jsonb);
    perform pg_temp.chk((select role::text from public.profiles where id = v) = 'athlete'
                        and not exists (select 1 from public.schools where owner_id = v), '0l school_admin con invitación pendiente: athlete sin escuela fantasma');
  end if;
end $$;

-- ══ SETUP del módulo ════════════════════════════════════════════════════════════
do $$
declare
  v_owner uuid := pg_temp.mk_user('qa.own@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_own2  uuid := pg_temp.mk_user('qa.own2@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_staff uuid := pg_temp.mk_user('qa.staff@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_staf2 uuid := pg_temp.mk_user('qa.staff2@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_par   uuid := pg_temp.mk_user('qa.parent@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_min   uuid := pg_temp.mk_user('qa.minor@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_ext   uuid := pg_temp.mk_user('qa.ext@qa.sportmaps.test', '{"role":"athlete"}'::jsonb);
  v_sa uuid := gen_random_uuid(); v_sb uuid := gen_random_uuid(); v_f uuid := gen_random_uuid();
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sa, 'QA Venue A', v_owner, 'venue');
  insert into public.schools (id, name, owner_id, school_type) values (v_sb, 'QA Venue B', v_own2, 'venue');
  insert into public.school_members (school_id, profile_id, role, status) values
    (v_sa, v_staff, 'staff', 'active'), (v_sb, v_staf2, 'staff', 'active'),
    (v_sa, v_par, 'parent', 'active'), (v_sa, v_min, 'athlete', 'active')
  on conflict do nothing;
  update public.profiles set date_of_birth = (current_date - interval '12 years')::date where id = v_min;
  update public.profiles set date_of_birth = (current_date - interval '40 years')::date where id in (v_par, v_ext);
  insert into public.facilities (id, school_id, name, type, capacity, hourly_rate, rental_rate, rental_enabled, bookable_by, booking_enabled, available_hours)
  -- horario fijo todos los días: el default cierra el domingo a las 18:00 y la prueba dependía del día de la semana en que corría
  values (v_f, v_sa, 'Cancha QA 1', 'futbol', 10, 80000, 100000, true, 'both', true,
    '{"monday":["06:00-23:00"],"tuesday":["06:00-23:00"],"wednesday":["06:00-23:00"],"thursday":["06:00-23:00"],"friday":["06:00-23:00"],"saturday":["06:00-23:00"],"sunday":["06:00-23:00"]}'::jsonb);
  perform set_config('qa.sa', v_sa::text, true);  perform set_config('qa.sb', v_sb::text, true);
  perform set_config('qa.f', v_f::text, true);    perform set_config('qa.staff', v_staff::text, true);
  perform set_config('qa.staff2', v_staf2::text, true); perform set_config('qa.par', v_par::text, true);
  perform set_config('qa.min', v_min::text, true); perform set_config('qa.ext', v_ext::text, true);
end $$;

-- ══ 1. Disponibilidad: audiencia por rol y bookable_by ═════════════════════════
do $$
declare r jsonb; r2 jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, current_setting('qa.dia')::date);
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean and r->'facilities'->0->>'audience' = 'member', '1 el padre ve tarifa member');
  perform pg_temp.chk(jsonb_array_length(r->'facilities'->0->'days'->0->'slots') > 0, '1 hay franjas libres');

  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.ext'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r2 := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, current_setting('qa.dia')::date);
  execute 'reset role';
  perform pg_temp.chk(r2->'facilities'->0->>'audience' = 'public', '1 el externo ve tarifa public');

  -- bookable_by = members: el externo no ve la cancha ni puede pedirla
  update public.facilities set bookable_by = 'members' where id = current_setting('qa.f')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.ext'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r2 := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, current_setting('qa.dia')::date, null, current_setting('qa.f')::uuid);
  execute 'reset role';
  perform pg_temp.chk(r2->>'error' = 'AUDIENCE_NOT_ALLOWED', '1 bookable_by=members: externo recibe AUDIENCE_NOT_ALLOWED');

  -- bookable_by = public: el padre entra pero a tarifa public (no member)
  update public.facilities set bookable_by = 'public' where id = current_setting('qa.f')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, current_setting('qa.dia')::date);
  execute 'reset role';
  perform pg_temp.chk(r->'facilities'->0->>'audience' = 'public', '1 bookable_by=public: el padre paga tarifa public');
  update public.facilities set bookable_by = 'both' where id = current_setting('qa.f')::uuid;
end $$;

-- ══ 2. Reservar: idempotencia, SLOT_TAKEN, hold, ocupación ═════════════════════
do $$
declare r jsonb; r2 jsonb; r3 jsonb; v_id uuid; i int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qa-key-0001-aaaa');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean and r->'reservation'->>'status' = 'pending_payment', '2 el padre reserva: pending_payment');
  v_id := (r->'reservation'->>'id')::uuid;
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status = 'hold'), '2 ocupación hold escrita en la misma transacción');
  perform pg_temp.chk((r->'reservation'->>'price')::numeric = 80000, '2 precio de miembro = hourly_rate (sin facility_rates)');
  perform pg_temp.chk(r->'reservation'->>'payment_reference' like 'RSV-%', '2 payment_reference RSV-…');

  -- misma llave x10 = 1 fila (la concurrencia real va en el .mjs)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  for i in 1..10 loop
    r2 := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qa-key-0001-aaaa');
    if not ((r2->>'ok')::boolean and (r2->>'idempotent_replay')::boolean and r2->'reservation'->>'id' = v_id::text) then
      execute 'reset role'; raise exception 'FALLO: replay % no devolvió la misma reserva: %', i, r2;
    end if;
  end loop;
  -- llave ajena con otros datos
  r3 := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '12:00'), pg_temp.slot(current_setting('qa.dia'), '13:00'), 'app', 'qa-key-0001-aaaa');
  execute 'reset role';
  perform pg_temp.chk(r3->>'error' = 'IDEMPOTENCY_KEY_REUSED', '2 misma llave con otro rango = IDEMPOTENCY_KEY_REUSED');
  perform pg_temp.chk((select count(*) from public.facility_reservations where idempotency_key = 'qa-key-0001-aaaa') = 1, '2 misma llave x10 = 1 sola fila');

  -- otro usuario, misma franja → SLOT_TAKEN con alternativas
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.ext'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r3 := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:00'), pg_temp.slot(current_setting('qa.dia'), '11:00'), 'app', 'qa-key-0002-bbbb');
  execute 'reset role';
  perform pg_temp.chk(r3->>'error' = 'SLOT_TAKEN' and jsonb_typeof(r3->'alternatives') = 'array', '2 franja ocupada = SLOT_TAKEN con alternatives');

  -- solape parcial (10:30-11:30) también choca; 11:00-12:00 pegado NO choca
  execute 'set local role authenticated';
  r3 := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '10:30'), pg_temp.slot(current_setting('qa.dia'), '11:30'), 'app', 'qa-key-0003-cccc');
  execute 'reset role';
  perform pg_temp.chk(r3->>'error' = 'SLOT_TAKEN', '2 solape parcial = SLOT_TAKEN');
  execute 'set local role authenticated';
  r3 := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '11:00'), pg_temp.slot(current_setting('qa.dia'), '12:00'), 'app', 'qa-key-0004-dddd');
  execute 'reset role';
  perform pg_temp.chk((r3->>'ok')::boolean, '2 franja contigua (11:00-12:00) sí se puede');
end $$;

-- ══ 3. Clase ocupa cancha y viceversa ══════════════════════════════════════════
do $$
declare r jsonb; v_cls uuid := gen_random_uuid();
begin
  -- clase 14:00-15:00 → ocupa; el alquiler da SLOT_TAKEN
  insert into public.attendance_sessions (id, school_id, session_date, start_time, end_time, facility_id, available_for_personal_classes)
  values (v_cls, current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, '14:00', '15:00', current_setting('qa.f')::uuid, true);
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'class' and source_id = v_cls and status = 'active'), '3 la clase escribe facility_occupancy');
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '14:00'), pg_temp.slot(current_setting('qa.dia'), '15:00'), 'app', 'qa-key-0005-eeee');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'SLOT_TAKEN', '3 una clase ocupa la cancha: el alquiler da SLOT_TAKEN');

  -- alquiler confirmado (staff, efectivo) 16:00-17:00 → una clase en esa franja se guarda pero NO ocupa
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '16:00'), pg_temp.slot(current_setting('qa.dia'), '17:00'), 'admin', 'qa-key-0006-ffff', 'cash');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean and r->'reservation'->>'status' = 'confirmed', '3 staff + efectivo = confirmed');
  v_cls := gen_random_uuid();
  insert into public.attendance_sessions (id, school_id, session_date, start_time, end_time, facility_id, available_for_personal_classes)
  values (v_cls, current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, '16:00', '17:00', current_setting('qa.f')::uuid, true);
  perform pg_temp.chk(exists (select 1 from public.attendance_sessions where id = v_cls), '3 la clase se guarda aunque la franja esté alquilada (no se bloquea la asistencia)');
  perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where source_kind = 'class' and source_id = v_cls and status = 'active'), '3 y no queda marcada (el alquiler ocupó primero)');
end $$;

-- ══ 4. booking_enabled = false ════════════════════════════════════════════════
do $$
declare r jsonb; r2 jsonb; v_cls uuid := gen_random_uuid();
begin
  update public.facilities set booking_enabled = false where id = current_setting('qa.f')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '10:00'), pg_temp.slot(current_setting('qa.dia2'), '11:00'), 'app', 'qa-key-0007-gggg');
  r2 := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia2')::date, current_setting('qa.dia2')::date, null, current_setting('qa.f')::uuid);
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'FACILITY_NOT_BOOKABLE', '4 booking_enabled=false: reservar = FACILITY_NOT_BOOKABLE');
  perform pg_temp.chk(r2->>'error' = 'FACILITY_NOT_BOOKABLE', '4 booking_enabled=false: disponibilidad = FACILITY_NOT_BOOKABLE');
  insert into public.attendance_sessions (id, school_id, session_date, start_time, end_time, facility_id, available_for_personal_classes)
  values (v_cls, current_setting('qa.sa')::uuid, current_setting('qa.dia2')::date, '09:00', '10:00', current_setting('qa.f')::uuid, true);
  perform pg_temp.chk(exists (select 1 from public.facility_occupancy where source_kind = 'class' and source_id = v_cls and status = 'active'), '4 la clase sigue ocupando aunque no reciba reservas');
  update public.facilities set booking_enabled = true where id = current_setting('qa.f')::uuid;
end $$;

-- ══ 5. Menor de edad / acudiente ══════════════════════════════════════════════
do $$
declare r jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.min'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '12:00'), pg_temp.slot(current_setting('qa.dia2'), '13:00'), 'app', 'qa-key-0008-hhhh');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'MINOR_CANNOT_BOOK', '5 un menor no reserva (MINOR_CANNOT_BOOK)');
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '12:00'), pg_temp.slot(current_setting('qa.dia2'), '13:00'), 'app', 'qa-key-0009-iiii');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean, '5 el acudiente (adulto) sí reserva');
end $$;

-- ══ 6. Ciclo: cancelar con política, reprogramar, pago idempotente y tardío ═══
do $$
declare r jsonb; v_id uuid; v_ref text; r2 jsonb; v_other uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '15:00'), pg_temp.slot(current_setting('qa.dia2'), '16:00'), 'app', 'qa-key-0010-jjjj');
  execute 'reset role';
  v_id := (r->'reservation'->>'id')::uuid; v_ref := r->'reservation'->>'payment_reference';

  -- confirmar pago (service_role = sin sesión de usuario): idempotente por evento
  perform set_config('request.jwt.claims', '', true);
  r2 := public.confirmar_pago_reserva(v_ref, 80000, null, 'wompi', 'evt-qa-1');
  perform pg_temp.chk((r2->>'confirmed')::boolean and r2->'reservation'->>'status' = 'confirmed', '6 pago completo confirma la reserva');
  r2 := public.confirmar_pago_reserva(v_ref, 80000, null, 'wompi', 'evt-qa-1');
  perform pg_temp.chk((r2->>'already_processed')::boolean, '6 el mismo evento no se procesa dos veces');
  perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 80000, '6 amount_paid no se duplicó');

  -- reprogramar atómico: el padre mueve su reserva a 17:00 (sin soltar la vieja antes)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r2 := public.reprogramar_reserva(v_id, pg_temp.slot(current_setting('qa.dia2'), '17:00'), pg_temp.slot(current_setting('qa.dia2'), '18:00'));
  execute 'reset role';
  perform pg_temp.chk((r2->>'ok')::boolean and r2->'reservation'->>'local_start' = '17:00', '6 reprogramar mueve la reserva');
  perform pg_temp.chk((select count(*) from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status = 'active') = 1, '6 una sola ocupación activa tras reprogramar');
  perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where facility_id = current_setting('qa.f')::uuid and status = 'active' and slot && tstzrange(pg_temp.slot(current_setting('qa.dia2'), '15:00'), pg_temp.slot(current_setting('qa.dia2'), '16:00'))), '6 la franja vieja quedó libre');

  -- cancelar: >24 h antes con pago → 100 %, refund manual
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r2 := public.cancelar_reserva(v_id, 'prueba');
  execute 'reset role';
  perform pg_temp.chk((r2->>'ok')::boolean and (r2->'refund'->>'pct')::int = 100 and r2->'refund'->>'status' = 'manual', '6 cancelar con política: 100 % y refund manual');
  perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status in ('active','hold')), '6 cancelar libera la ocupación');

  -- pago tardío: hold vencido + franja tomada por otro → pending_reconciliation, el pago no se pierde
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '19:00'), pg_temp.slot(current_setting('qa.dia2'), '20:00'), 'app', 'qa-key-0011-kkkk');
  execute 'reset role';
  v_id := (r->'reservation'->>'id')::uuid; v_ref := r->'reservation'->>'payment_reference';
  perform set_config('request.jwt.claims', '', true);
  update public.facility_reservations set hold_expires_at = now() - interval '1 minute' where id = v_id;     -- vence el hold
  perform public.expirar_holds();
  perform pg_temp.chk((select status from public.facility_reservations where id = v_id) = 'expired', '6 expirar_holds expira el hold vencido');
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.ext'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '19:00'), pg_temp.slot(current_setting('qa.dia2'), '20:00'), 'app', 'qa-key-0012-llll');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean, '6 otro toma la franja tras expirar el hold (el índice único ya no cuenta expired)');
  r2 := public.confirmar_pago_reserva(v_ref, 100000, null, 'wompi', 'evt-qa-late');
  perform pg_temp.chk((r2->>'reconciliation')::boolean and r2->'reservation'->>'status' = 'pending_reconciliation', '6 pago tardío con franja tomada = pending_reconciliation');
  perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 100000, '6 el pago tardío queda registrado');
end $$;

-- ══ 7. Seguridad: anon y staff de otra escuela ═════════════════════════════════
do $$
declare r jsonb; v_id uuid; v_n int;
begin
  -- anon no ve facility_occupancy
  begin
    execute 'set local role anon';
    execute 'select count(*) from public.facility_occupancy' into v_n;
    execute 'reset role';
    perform pg_temp.chk(v_n = 0, '7 anon: select count(*) de facility_occupancy = 0');
  exception when insufficient_privilege then
    execute 'reset role';
    raise notice 'OK: 7 anon: sin privilegio sobre facility_occupancy (0 filas visibles)';
  end;
  -- anon no ejecuta las RPC
  begin
    execute 'set local role anon';
    perform public.reservar_cancha(current_setting('qa.f')::uuid, now(), now() + interval '1 hour', 'public', 'qa-anon-key-0001');
    execute 'reset role';
    raise exception 'FALLO: anon pudo ejecutar reservar_cancha';
  exception when insufficient_privilege then
    execute 'reset role';
    raise notice 'OK: 7 anon sin EXECUTE en reservar_cancha';
  end;

  select id into v_id from public.facility_reservations where facility_id = current_setting('qa.f')::uuid and status = 'confirmed' limit 1;
  -- staff de la escuela B no toca la A
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff2'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.cancelar_reserva(v_id, 'intento ajeno');
  execute 'select count(*) from public.facility_reservations where school_id = ' || quote_literal(current_setting('qa.sa')) || '::uuid' into v_n;
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', '7 staff de B no cancela reservas de A (FORBIDDEN)');
  perform pg_temp.chk(v_n = 0, '7 staff de B no lee reservas de A por RLS');
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '08:00'), pg_temp.slot(current_setting('qa.dia2'), '09:00'), 'admin', 'qa-key-0013-mmmm', 'cash');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'CHANNEL_NOT_ALLOWED', '7 staff de B no reserva en la cancha de A como admin');
  -- tarifas/blackouts: staff de B no escribe en A
  begin
    execute 'set local role authenticated';
    insert into public.facility_rates (school_id, facility_id, audience, from_time, to_time, price_per_hour)
    values (current_setting('qa.sb')::uuid, current_setting('qa.f')::uuid, 'public', '06:00', '22:00', 1);
    execute 'reset role';
    raise exception 'FALLO: staff de B insertó una tarifa en la cancha de A';
  exception when insufficient_privilege or check_violation then
    execute 'reset role';
    raise notice 'OK: 7 staff de B no inserta tarifas en A (RLS)';
  end;
  -- facilities_update_admin con WITH CHECK: el admin de A no mueve su cancha a B
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', (select owner_id from public.schools where id = current_setting('qa.sa')::uuid), 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    execute 'update public.facilities set school_id = ' || quote_literal(current_setting('qa.sb')) || '::uuid where id = ' || quote_literal(current_setting('qa.f')) || '::uuid';
    execute 'reset role';
    raise exception 'FALLO: el admin de A movió la instalación a la escuela B';
  exception when insufficient_privilege or check_violation then
    execute 'reset role';
    raise notice 'OK: 7 facilities_update_admin con WITH CHECK (no se mueve de escuela)';
  end;
end $$;

-- ══ 8. school_type 'venue' reservado (20261105164434_schools_school_type_venue_guard) ═══
do $$
declare v_own uuid := pg_temp.mk_user('qa.own.guard@qa.sportmaps.test', '{"role":"athlete"}'::jsonb); v_sid uuid := gen_random_uuid(); v_sid2 uuid := gen_random_uuid();
begin
  insert into public.schools (id, name, owner_id, school_type) values (v_sid, 'QA Guard', v_own, 'academy');
  perform set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  -- el dueño no se vuelve venue
  begin
    update public.schools set school_type = 'venue' where id = v_sid;
    execute 'reset role'; raise exception 'FALLO: el dueño se volvió venue';
  exception when insufficient_privilege then execute 'reset role'; raise notice 'OK: 8 UPDATE a venue por el dueño bloqueado'; end;
  -- ni inserta una escuela venue
  execute 'set local role authenticated';
  begin
    insert into public.schools (id, name, owner_id, school_type) values (v_sid2, 'QA Guard 2', v_own, 'venue');
    execute 'reset role'; raise exception 'FALLO: el dueño insertó una escuela venue';
  exception when insufficient_privilege then execute 'reset role'; raise notice 'OK: 8 INSERT venue por usuario bloqueado'; end;
  -- hybrid sigue libre
  execute 'set local role authenticated';
  update public.schools set school_type = 'hybrid' where id = v_sid;
  execute 'reset role';
  perform pg_temp.chk((select school_type from public.schools where id = v_sid) = 'hybrid', '8 hybrid sigue libre para el dueño');
  -- sin sesión de usuario (service_role/postgres): puede pasar a venue y salir
  perform set_config('request.jwt.claims', '', true);   -- sin JWT de usuario = service_role/postgres
  update public.schools set school_type = 'venue' where id = v_sid;
  perform pg_temp.chk((select school_type from public.schools where id = v_sid) = 'venue', '8 service_role/postgres sí puede asignar venue');
  -- un venue no se "degrada" por el dueño
  perform set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update public.schools set school_type = 'academy' where id = v_sid;
    execute 'reset role'; raise exception 'FALLO: el dueño sacó la escuela de venue';
  exception when insufficient_privilege then execute 'reset role'; raise notice 'OK: 8 salir de venue por el dueño bloqueado'; end;
end $$;

-- ══ 9. Reglas anti-abuso y pagos huérfanos (ronda de correcciones) ═════════════
do $$
declare r jsonb; v_id uuid; v_ref text; v_ext_n int;
begin
  perform set_config('request.jwt.claims', '', true);
  -- 9a. tope de 3 reservas activas por reservante (el externo ya tiene 2 activas de la sección 2 y 6)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.ext'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '21:00'), pg_temp.slot(current_setting('qa.dia2'), '22:00'), 'app', 'qa-key-0014-nnnn');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean, '9a tercera reserva activa del externo sí pasa');
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia2'), '20:00'), pg_temp.slot(current_setting('qa.dia2'), '21:00'), 'app', 'qa-key-0015-oooo');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'TOO_MANY_ACTIVE', '9a la cuarta = TOO_MANY_ACTIVE');

  -- 9b. duración máxima
  update public.facilities set max_duration_min = 90 where id = current_setting('qa.f')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '18:00'), pg_temp.slot(current_setting('qa.dia'), '20:00'), 'app', 'qa-key-0016-pppp');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'DURATION_TOO_LONG', '9b más de max_duration_min = DURATION_TOO_LONG');
  update public.facilities set max_duration_min = 240 where id = current_setting('qa.f')::uuid;

  -- 9c. cancha sin tarifa: no se ofrece ni se reserva (no staff)
  update public.facilities set hourly_rate = 0, rental_rate = 0 where id = current_setting('qa.f')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.par'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '18:00'), pg_temp.slot(current_setting('qa.dia'), '19:00'), 'app', 'qa-key-0017-qqqq');
  execute 'reset role';
  perform pg_temp.chk(r->>'error' in ('PRICE_NOT_CONFIGURED','TOO_MANY_ACTIVE'), '9c cancha sin tarifa no se reserva (PRICE_NOT_CONFIGURED; o TOO_MANY_ACTIVE si el padre ya tiene 3 activas)');
  execute 'set local role authenticated';
  r := public.disponibilidad_canchas(current_setting('qa.sa')::uuid, current_setting('qa.dia')::date, current_setting('qa.dia')::date, null, current_setting('qa.f')::uuid);
  execute 'reset role';
  perform pg_temp.chk(jsonb_array_length(r->'facilities'->0->'days') = 0, '9c disponibilidad no ofrece franjas de precio 0 a no staff');
  update public.facilities set hourly_rate = 80000, rental_rate = 100000 where id = current_setting('qa.f')::uuid;

  -- 9d. hold vencido CON pago: expirar_holds lo manda a pending_reconciliation (no a expired)
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '07:00'), pg_temp.slot(current_setting('qa.dia'), '08:00'), 'admin', 'qa-key-0018-rrrr', 'online');
  execute 'reset role';
  v_id := (r->'reservation'->>'id')::uuid; v_ref := r->'reservation'->>'payment_reference';
  perform set_config('request.jwt.claims', '', true);
  perform public.confirmar_pago_reserva(v_ref || '-2', 10000, null, 'wompi', 'evt-qa-partial');      -- referencia con sufijo -N
  perform pg_temp.chk((select amount_paid from public.facility_reservations where id = v_id) = 10000, '9d la referencia con sufijo -N se normaliza');
  update public.facility_reservations set hold_expires_at = now() - interval '1 minute' where id = v_id;
  perform public.expirar_holds();
  perform pg_temp.chk((select status from public.facility_reservations where id = v_id) = 'pending_reconciliation', '9d hold vencido con pago -> pending_reconciliation, no expired');
  perform pg_temp.chk(not exists (select 1 from public.facility_occupancy where source_kind = 'rental' and source_id = v_id and status in ('active','hold')), '9d y libera la franja');

  -- 9e. cancelar una reserva en pending_reconciliation: 100 % y sin ventana
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.cancelar_reserva(v_id, 'devolución');
  execute 'reset role';
  perform pg_temp.chk((r->>'ok')::boolean and (r->'refund'->>'pct')::int = 100, '9e cancelar pending_reconciliation = 100 %');

  -- 9f. staff no reserva a nombre de un perfil de otra escuela
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '06:00'), pg_temp.slot(current_setting('qa.dia'), '07:00'), 'admin', 'qa-key-0019-ssss', 'cash', null, current_setting('qa.staff2')::uuid);
  execute 'reset role';
  perform pg_temp.chk(r->>'error' = 'FORBIDDEN', '9f staff no reserva a nombre de alguien ajeno a su escuela');

  -- 9g. un invitado existente no se pisa
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.staff'), 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '06:00'), pg_temp.slot(current_setting('qa.dia'), '07:00'), 'admin', 'qa-key-0020-tttt', 'cash', null, null, null, '{"phone":"+573000000099","full_name":"Original","email":"o@qa.test"}'::jsonb);
  r := public.reservar_cancha(current_setting('qa.f')::uuid, pg_temp.slot(current_setting('qa.dia'), '08:00'), pg_temp.slot(current_setting('qa.dia'), '09:00'), 'admin', 'qa-key-0021-uuuu', 'cash', null, null, null, '{"phone":"+573000000099","full_name":"Pisado","email":"p@qa.test"}'::jsonb);
  execute 'reset role';
  perform pg_temp.chk((select full_name from public.guest_bookers where phone = '+573000000099') = 'Original', '9g el nombre del invitado existente no se sobrescribe');
end $$;

rollback;
