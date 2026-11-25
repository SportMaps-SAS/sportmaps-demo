-- Onboarding etapa 3 · T07: aprobación automática de solicitudes de unión por código.
-- Migración: 20261123115126_solicitudes_union_aprobacion_automatica.sql
-- Datos inventados (@example.invalid). Todo en la transacción de run-local.sh (ROLLBACK).

create or replace function pg_temp.t07_user(p_email text, p_confirmed boolean, p_role text default 'parent')
returns uuid language plpgsql as $f$
declare u uuid := gen_random_uuid();
begin
  insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email,
          case when p_confirmed then now() else null end,
          jsonb_build_object('full_name', 'Prueba ' || p_email, 'role', p_role), '{}'::jsonb, now(), now());
  insert into public.profiles (id, full_name, role, email)
  values (u, 'Prueba ' || p_email, p_role::public.user_role, p_email)
  on conflict (id) do nothing;
  return u;
end $f$;

create or replace function pg_temp.t07_as(p_uid uuid) returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
end $f$;

do $$
declare
  o uuid; s uuid; code text;
  p uuid; r jsonb; n int;
  hoy date := (now() at time zone 'America/Bogota')::date;
  dob_menor date := (hoy - interval '10 years')::date;
  dob_adulto date := (hoy - interval '30 years')::date;
begin
  o := pg_temp.t07_user('t07-dueno@example.invalid', true, 'school');
  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T07 academia', o, 'completed') returning id into s;
  insert into public.school_members (school_id, profile_id, role, status) values (s, o, 'owner', 'active') on conflict do nothing;
  insert into public.school_settings (school_id, whatsapp_number) values (s, '3001112233')
    on conflict (school_id) do update set whatsapp_number = '3001112233';
  code := (select public._create_school_join_code(s, o));
  select jc.code into code from public.school_join_codes jc where jc.school_id = s and jc.active limit 1;
  if code is null then raise exception 'FALLO 0: no se pudo crear el código de la escuela'; end if;

  -- ── 1. Menor con correo de acudiente igual: AUTOMÁTICA ──────────────────────
  p := pg_temp.t07_user('t07-p1@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email, guardian_full_name)
  values (s, 'Ana Prueba Uno', '1000000001', dob_menor, 't07-p1@example.invalid', 'Acudiente Uno');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Ana Prueba Uno', dob_menor, null, '1000000001', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is not true then raise exception 'FALLO 1: debía aprobarse sola: %', r; end if;
  if not exists (select 1 from public.school_join_requests q where q.requester_profile_id = p and q.status = 'linked' and q.auto_approved and q.child_id is not null) then
    raise exception 'FALLO 1: la solicitud debía quedar linked + auto_approved';
  end if;
  if not exists (select 1 from public.children c where c.parent_id = p and c.school_id = s) then raise exception 'FALLO 1: debía existir el hijo vinculado'; end if;
  if not exists (select 1 from public.school_members m where m.school_id = s and m.profile_id = p and m.role = 'parent' and m.status = 'active') then
    raise exception 'FALLO 1: debía quedar como miembro acudiente';
  end if;

  -- ── 2. Correo de acudiente DISTINTO: manual ─────────────────────────────────
  p := pg_temp.t07_user('t07-p2@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email, guardian_full_name)
  values (s, 'Beto Prueba Dos', '1000000002', dob_menor, 'otra-persona@example.invalid', 'Otro');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Beto Prueba Dos', dob_menor, null, '1000000002', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true or (r->>'ok')::boolean is not true then raise exception 'FALLO 2: debía quedar manual: %', r; end if;
  if not exists (select 1 from public.school_join_requests q where q.requester_profile_id = p and q.status = 'pending' and not q.auto_approved) then
    raise exception 'FALLO 2: debía quedar pendiente';
  end if;

  -- ── 3. Ficha SIN correo de acudiente, misma fecha: AUTOMÁTICA ───────────────
  p := pg_temp.t07_user('t07-p3@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_full_name)
  values (s, 'Carla Prueba Tres', '1000000003', dob_menor, 'Acudiente Tres');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'carla  prueba tres', dob_menor, null, '1000000003', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is not true then raise exception 'FALLO 3: debía aprobarse sola: %', r; end if;

  -- ── 4. Dos fichas con el mismo documento: manual ────────────────────────────
  p := pg_temp.t07_user('t07-p4@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
  values (s, 'Dani Prueba Cuatro', '1000000004', dob_menor, 't07-p4@example.invalid');
  begin
    insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
    values (s, 'Dani Prueba Cuatro Bis', '1000000004', dob_menor, 't07-p4@example.invalid');
  exception when others then
    -- Si un guard de duplicados impide crear la segunda, el caso se arma con otra tabla.
    insert into public.children (full_name, school_id, doc_number, date_of_birth, parent_email_temp)
    values ('Dani Prueba Cuatro Bis', s, '1000000004', dob_menor, 't07-p4@example.invalid');
  end;
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Dani Prueba Cuatro', dob_menor, null, '1000000004', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 4: con dos fichas no puede ser automática'; end if;

  -- ── 5. El documento ya está en una ficha VINCULADA: manual ──────────────────
  p := pg_temp.t07_user('t07-p5@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email, linked_profile_id)
  values (s, 'Eli Prueba Cinco', '1000000005', dob_menor, 't07-p5@example.invalid', o);
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Eli Prueba Cinco', dob_menor, null, '1000000005', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 5: ficha ya vinculada, no puede ser automática'; end if;

  -- ── 6. Nombre distinto: manual ──────────────────────────────────────────────
  p := pg_temp.t07_user('t07-p6@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
  values (s, 'Fabi Prueba Seis', '1000000006', dob_menor, 't07-p6@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Otro Nombre Distinto', dob_menor, null, '1000000006', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 6: nombre distinto'; end if;

  -- ── 7. Fecha de nacimiento distinta: manual ─────────────────────────────────
  p := pg_temp.t07_user('t07-p7@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
  values (s, 'Gabi Prueba Siete', '1000000007', dob_menor, 't07-p7@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Gabi Prueba Siete', dob_menor - 1, null, '1000000007', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 7: fecha distinta'; end if;

  -- ── 8. Correo SIN confirmar: manual ─────────────────────────────────────────
  p := pg_temp.t07_user('t07-p8@example.invalid', false);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
  values (s, 'Hugo Prueba Ocho', '1000000008', dob_menor, 't07-p8@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Hugo Prueba Ocho', dob_menor, null, '1000000008', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 8: correo sin confirmar'; end if;

  -- ── 9. Adulto para sí: con su correo en la ficha es automática; sin él, manual ─
  p := pg_temp.t07_user('t07-a9@example.invalid', true, 'athlete');
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, email)
  values (s, 'Ivan Prueba Nueve', '1000000009', dob_adulto, 't07-a9@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'self', 'Ivan Prueba Nueve', dob_adulto, null, '1000000009', 'CC');
  if coalesce((r->>'auto_approved')::boolean, false) is not true then raise exception 'FALLO 9a: adulto con su correo debía ser automática: %', r; end if;

  p := pg_temp.t07_user('t07-a10@example.invalid', true, 'athlete');
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, email)
  values (s, 'Juli Prueba Diez', '1000000010', dob_adulto, 'ficha-con-otro-correo@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'self', 'Juli Prueba Diez', dob_adulto, null, '1000000010', 'CC');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 9b: adulto sin su correo no puede ser automática'; end if;

  -- ── 10. Sin documento en la solicitud: manual ───────────────────────────────
  p := pg_temp.t07_user('t07-p11@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email)
  values (s, 'Kari Prueba Once', '1000000011', dob_menor, 't07-p11@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Kari Prueba Once', dob_menor, null, null, null);
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 10: sin documento no puede ser automática'; end if;

  -- ── 11. Para sí sobre una ficha de menor: manual ────────────────────────────
  p := pg_temp.t07_user('t07-p12@example.invalid', true);
  insert into public.unregistered_athletes (school_id, full_name, doc_number, date_of_birth, guardian_email, email)
  values (s, 'Leo Prueba Doce', '1000000012', dob_menor, 't07-p12@example.invalid', 't07-p12@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'self', 'Leo Prueba Doce', dob_menor, null, '1000000012', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is true then raise exception 'FALLO 11: for_whom self sobre menor'; end if;

  -- ── 12. Hijo precargado sin acudiente (children): AUTOMÁTICA ────────────────
  p := pg_temp.t07_user('t07-p13@example.invalid', true);
  insert into public.children (full_name, school_id, doc_number, date_of_birth, parent_email_temp)
  values ('Mari Prueba Trece', s, '1000000013', dob_menor, 't07-p13@example.invalid');
  perform pg_temp.t07_as(p);
  r := public.submit_school_join_request(code, 'child', 'Mari Prueba Trece', dob_menor, null, '1000000013', 'TI');
  if coalesce((r->>'auto_approved')::boolean, false) is not true then raise exception 'FALLO 12: children huérfano debía ser automática: %', r; end if;
  if not exists (select 1 from public.children c where c.school_id = s and c.doc_number = '1000000013' and c.parent_id = p) then
    raise exception 'FALLO 12: la ficha debía quedar con el acudiente';
  end if;

  -- ── 13. Estado del solicitante: trae auto_approved y el WhatsApp de la escuela ─
  p := (select requester_profile_id from public.school_join_requests where status = 'pending' and athlete_name = 'Beto Prueba Dos' limit 1);
  perform pg_temp.t07_as(p);
  r := public.my_school_join_status();
  if (r #>> '{requests,0,school_whatsapp}') is distinct from '3001112233' then raise exception 'FALLO 13: falta el WhatsApp de la escuela: %', r; end if;
  if (r #>> '{requests,0,auto_approved}')::boolean is not false then raise exception 'FALLO 13: auto_approved debía venir false: %', r; end if;

  -- ── 14. Permisos ────────────────────────────────────────────────────────────
  if has_function_privilege('authenticated', 'public._join_request_auto_match(uuid,uuid,text,text,date,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public._join_request_auto_match(uuid,uuid,text,text,date,text)', 'EXECUTE') then
    raise exception 'FALLO 14: el helper de coincidencia no debe ser llamable';
  end if;
  if not has_function_privilege('authenticated', 'public.submit_school_join_request(text,text,text,date,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.submit_school_join_request(text,text,text,date,text,text,text)', 'EXECUTE') then
    raise exception 'FALLO 14: submit debe ser de authenticated y no de anon';
  end if;

  raise notice 'T07 OK: aprobación automática de solicitudes de unión (14 casos)';
end $$;
