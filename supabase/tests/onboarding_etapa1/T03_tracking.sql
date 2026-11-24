-- Onboarding etapa 1 · T03: tracking en analytics_events.
-- Migración: 20261123085942_onboarding_tracking_eventos.sql
-- Datos inventados. Corre dentro de la transacción de run-local.sh (ROLLBACK).
do $$
declare
  u    uuid := gen_random_uuid();
  u2   uuid := gen_random_uuid();
  s    uuid;
  s_old uuid;
  n    int;
  p1   uuid;
begin
  -- ── signup_completed: nace con el perfil ──────────────────────────────────
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t03@example.invalid',
          jsonb_build_object('full_name', 'Prueba Tracking', 'role', 'school'), '{"provider":"email"}'::jsonb, now(), now());
  insert into public.profiles (id, full_name, role, email) values (u, 'Prueba Tracking', 'school', 'onb-t03@example.invalid')
  on conflict (id) do nothing;

  select count(*) into n from public.analytics_events where user_id = u and event_type = 'signup_completed';
  if n <> 1 then raise exception 'FALLO 1: signup_completed debía ser 1, fue %', n; end if;
  if not exists (select 1 from public.analytics_events where user_id = u and event_type = 'signup_completed'
                  and event_data->>'role' = 'school' and event_data->>'provider' = 'email') then
    raise exception 'FALLO 1: faltan rol o proveedor en signup_completed';
  end if;
  -- el UPSERT de handle_new_user sobre un perfil existente no duplica el evento
  insert into public.profiles (id, full_name, role, email) values (u, 'Otro Nombre', 'school', 'onb-t03@example.invalid')
  on conflict (id) do update set full_name = excluded.full_name;
  select count(*) into n from public.analytics_events where user_id = u and event_type = 'signup_completed';
  if n <> 1 then raise exception 'FALLO 1: el upsert duplicó signup_completed (%)', n; end if;
  raise notice 'OK 1: signup_completed, una vez por cuenta';

  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T03 academia', u, 'in_progress') returning id into s;
  insert into public.school_members (school_id, profile_id, role, status) values (s, u, 'owner', 'active') on conflict do nothing;
  insert into public.school_settings (school_id) values (s) on conflict (school_id) do nothing;

  -- ── first_plan_created: solo el primero ──────────────────────────────────
  insert into public.offerings (school_id, name, offering_type) values (s, 'ONB T03 oferta', 'membership');
  insert into public.offering_plans (offering_id, school_id, name, price)
    select id, s, 'Mensual', 100000 from public.offerings where school_id = s limit 1;
  select count(*) into n from public.analytics_events where event_type = 'first_plan_created' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 2: first_plan_created debía ser 1, fue %', n; end if;
  insert into public.offering_plans (offering_id, school_id, name, price)
    select id, s, 'Trimestral', 270000 from public.offerings where school_id = s limit 1;
  select count(*) into n from public.analytics_events where event_type = 'first_plan_created' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 2: el segundo plan generó otro «primero» (%)', n; end if;
  if not exists (select 1 from public.analytics_events where event_type = 'first_plan_created' and user_id = u) then
    raise exception 'FALLO 2: el evento debe quedar a nombre del dueño de la escuela';
  end if;
  raise notice 'OK 2: first_plan_created solo con el primer plan, a nombre del dueño';

  -- ── first_athlete_created ────────────────────────────────────────────────
  insert into public.children (full_name, school_id) values ('Atleta Ficticio Uno', s);
  insert into public.children (full_name, school_id) values ('Atleta Ficticio Dos', s);
  select count(*) into n from public.analytics_events where event_type = 'first_athlete_created' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 3: first_athlete_created debía ser 1, fue %', n; end if;
  raise notice 'OK 3: first_athlete_created una sola vez';

  -- ── first_charge_created: varios cobros en UNA sentencia = un solo evento ──
  insert into public.payments (school_id, amount, concept, due_date, status)
    select s, 50000, 'ONB T03 cobro ' || g, current_date, 'pending' from generate_series(1, 5) g;
  select count(*) into n from public.analytics_events where event_type = 'first_charge_created' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 4: first_charge_created debía ser 1 con 5 cobros juntos, fue %', n; end if;
  insert into public.payments (school_id, amount, concept, due_date, status) values (s, 50000, 'ONB T03 otro', current_date, 'pending');
  select count(*) into n from public.analytics_events where event_type = 'first_charge_created' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 4: un cobro posterior generó otro «primero» (%)', n; end if;
  raise notice 'OK 4: first_charge_created una sola vez, también con carga masiva';

  -- ── Escuela con historia previa: NO genera «primeros» falsos ─────────────
  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T03 antigua', u, 'completed') returning id into s_old;
  -- simula filas que ya existían ANTES de instalar los triggers
  alter table public.payments disable trigger trg_analytics_first_charge;
  insert into public.payments (school_id, amount, concept, due_date, status) values (s_old, 1000, 'ONB T03 historico', current_date, 'paid');
  alter table public.payments enable trigger trg_analytics_first_charge;
  insert into public.payments (school_id, amount, concept, due_date, status) values (s_old, 2000, 'ONB T03 nuevo', current_date, 'pending');
  select count(*) into n from public.analytics_events where event_type = 'first_charge_created' and event_data @> jsonb_build_object('school_id', s_old);
  if n <> 0 then raise exception 'FALLO 5: una escuela con cobros previos generó un «primer cobro» falso'; end if;
  raise notice 'OK 5: una escuela que ya cobraba no genera un primer cobro falso';

  -- ── payment_method_configured: de «sin medio» a «con medio», una vez ─────
  select count(*) into n from public.analytics_events where event_type = 'payment_method_configured' and event_data @> jsonb_build_object('school_id', s);
  if n <> 0 then raise exception 'FALLO 6: sin medio no debe haber evento'; end if;
  update public.school_settings set whatsapp_number = '3000000000' where school_id = s;   -- cambio ajeno al cobro
  select count(*) into n from public.analytics_events where event_type = 'payment_method_configured' and event_data @> jsonb_build_object('school_id', s);
  if n <> 0 then raise exception 'FALLO 6: un cambio ajeno al cobro disparó el evento'; end if;
  update public.school_settings set nequi_number = '3000000001' where school_id = s;
  select count(*) into n from public.analytics_events where event_type = 'payment_method_configured' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 6: configurar Nequi debía generar 1 evento, fue %', n; end if;
  update public.school_settings set nequi_number = '3000000002' where school_id = s;      -- editar el mismo medio
  select count(*) into n from public.analytics_events where event_type = 'payment_method_configured' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 6: editar el medio duplicó el evento (%)', n; end if;
  raise notice 'OK 6: payment_method_configured solo al pasar a «con medio»';

  -- ── whatsapp_connected ───────────────────────────────────────────────────
  insert into public.school_whatsapp_integrations (school_id, phone_number_id, status)
  values (s, 'onb-t03-pni', 'pending');
  select count(*) into n from public.analytics_events where event_type = 'whatsapp_connected' and event_data @> jsonb_build_object('school_id', s);
  if n <> 0 then raise exception 'FALLO 7: una integración pendiente no es «conectado»'; end if;
  update public.school_whatsapp_integrations set status = 'active' where school_id = s and phone_number_id = 'onb-t03-pni';
  select count(*) into n from public.analytics_events where event_type = 'whatsapp_connected' and event_data @> jsonb_build_object('school_id', s);
  if n <> 1 then raise exception 'FALLO 7: activar debía generar 1 evento, fue %', n; end if;
  raise notice 'OK 7: whatsapp_connected al activarse la primera integración';

  -- ── RPC del asistente ────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform public.track_onboarding_event('onboarding_step_viewed', 'school', 'plan', '{}'::jsonb);
  perform public.track_onboarding_event('onboarding_step_completed', 'school', 'plan', '{"n": 2, "ok": true, "how": "x"}'::jsonb);
  perform public.track_onboarding_event('onboarding_step_skipped', 'school', 'coach', '{}'::jsonb);
  perform public.track_onboarding_event('onboarding_finished', 'school', null, '{"how":"later"}'::jsonb);
  select count(*) into n from public.analytics_events where user_id = u and event_type like 'onboarding\_%';
  if n <> 4 then raise exception 'FALLO 8: se esperaban 4 eventos del asistente, hay %', n; end if;
  if not exists (select 1 from public.analytics_events where user_id = u and event_type = 'onboarding_step_completed'
                  and event_data @> jsonb_build_object('flow','school','step','plan','n',2,'ok',true,'school_id',s)) then
    raise exception 'FALLO 8: el evento no quedó con flujo, paso, extra y escuela';
  end if;
  raise notice 'OK 8: la RPC registra los 4 eventos con su contexto';

  -- Entradas inválidas: se ignoran en silencio, sin error.
  perform public.track_onboarding_event('signup_completed', 'school', 'plan', '{}'::jsonb);        -- evento fuera de la lista
  perform public.track_onboarding_event('onboarding_step_viewed', 'otro', 'plan', '{}'::jsonb);   -- flujo inválido
  perform public.track_onboarding_event('onboarding_step_viewed', 'school', 'Paso Raro!', '{}'::jsonb);
  perform public.track_onboarding_event('onboarding_step_viewed', 'school', null, '{}'::jsonb);   -- paso obligatorio
  perform public.track_onboarding_event('onboarding_step_viewed', 'school', 'plan',
          '{"correo":{"a":1},"school_id":"x","flow":"y","Mal Nombre":"z","largo":"0123456789012345678901234567890123456789ABCDEF"}'::jsonb);
  select count(*) into n from public.analytics_events where user_id = u and event_type like 'onboarding\_%';
  if n <> 5 then raise exception 'FALLO 9: solo el último (válido, con extra saneado) debía entrar; hay % eventos', n; end if;
  if exists (select 1 from public.analytics_events where user_id = u and event_data ? 'correo') then raise exception 'FALLO 9: coló un objeto anidado'; end if;
  if exists (select 1 from public.analytics_events where user_id = u and event_data->>'flow' = 'y') then raise exception 'FALLO 9: el extra pisó una clave reservada'; end if;
  if exists (select 1 from public.analytics_events where user_id = u and length(event_data->>'largo') > 40) then raise exception 'FALLO 9: no recortó el texto'; end if;
  raise notice 'OK 9: la RPC descarta lo inválido y sanea el extra';

  -- Sin sesión: no escribe y no falla.
  perform set_config('request.jwt.claims', '', true);
  perform public.track_onboarding_event('onboarding_step_viewed', 'school', 'plan', '{}'::jsonb);
  select count(*) into n from public.analytics_events where user_id is null and event_type like 'onboarding\_%';
  if n <> 0 then raise exception 'FALLO 10: sin sesión no debe escribir'; end if;
  raise notice 'OK 10: sin sesión no escribe';

  -- Tope por minuto (el usuario debe existir: user_id tiene llave foránea).
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (u2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t03b@example.invalid',
          '{}'::jsonb, '{}'::jsonb, now(), now());
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  for n in 1..70 loop
    perform public.track_onboarding_event('onboarding_step_completed', 'school', 'plan', '{}'::jsonb);
  end loop;
  select count(*) into n from public.analytics_events where user_id = u2 and event_type like 'onboarding\_%';
  if n <> 60 then raise exception 'FALLO 11: el tope debía dejar 60 eventos por minuto, hay %', n; end if;
  raise notice 'OK 11: tope de 60 eventos por usuario y minuto';
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ── Permisos ──────────────────────────────────────────────────────────────
do $$
declare f text;
begin
  if has_function_privilege('anon', 'public.track_onboarding_event(text,text,text,jsonb)', 'EXECUTE') then
    raise exception 'FALLO 12: anon puede llamar track_onboarding_event';
  end if;
  if not has_function_privilege('authenticated', 'public.track_onboarding_event(text,text,text,jsonb)', 'EXECUTE') then
    raise exception 'FALLO 12: authenticated no puede llamar track_onboarding_event';
  end if;
  foreach f in array array[
    'public._analytics_hito_registrado(text,uuid)',
    'public._settings_has_payment_method(public.school_settings)',
    'public._school_has_payment_method(uuid)',
    'public.fn_analytics_signup_completed()', 'public.fn_analytics_first_plan()', 'public.fn_analytics_first_athlete()',
    'public.fn_analytics_first_charge()', 'public.fn_analytics_payment_method_ins()', 'public.fn_analytics_payment_method_upd()',
    'public.fn_analytics_whatsapp_ins()', 'public.fn_analytics_whatsapp_upd()'
  ] loop
    if has_function_privilege('authenticated', f, 'EXECUTE') or has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'FALLO 12: % quedó ejecutable por la app', f;
    end if;
  end loop;
  -- El cliente no puede escribir directo en la tabla (antes sí: anon incluido).
  if has_table_privilege('authenticated', 'public.analytics_events', 'INSERT')
     or has_table_privilege('anon', 'public.analytics_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.analytics_events', 'UPDATE')
     or has_table_privilege('anon', 'public.analytics_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.analytics_events', 'DELETE')
     or has_table_privilege('anon', 'public.analytics_events', 'DELETE') then
    raise exception 'FALLO 12: la app conserva escritura directa sobre analytics_events';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'analytics_events' and cmd = 'INSERT') then
    raise exception 'FALLO 12: sigue existiendo una política de INSERT en analytics_events';
  end if;
  -- Las lecturas (propias y de administración de plataforma) se conservan.
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'analytics_events' and cmd = 'SELECT') <> 2 then
    raise exception 'FALLO 12: cambiaron las políticas SELECT de analytics_events';
  end if;
  if not has_table_privilege('authenticated', 'public.analytics_events', 'SELECT') then
    raise exception 'FALLO 12: authenticated perdió SELECT (lo necesitan las políticas)';
  end if;
  raise notice 'OK 12: permisos correctos; solo la RPC es llamable y no hay escritura directa';
end $$;

-- 13. De verdad, con los roles de la app: el INSERT directo es rechazado.
set local role anon;
do $$ begin
  begin
    insert into public.analytics_events (event_type) values ('evento_falso');
    raise exception 'FALLO 13: anon pudo insertar en analytics_events';
  exception when insufficient_privilege then
    raise notice 'OK 13a: anon no puede insertar directo';
  end;
end $$;
reset role;

set local role authenticated;
do $$ begin
  begin
    insert into public.analytics_events (event_type, user_id) values ('evento_falso', auth.uid());
    raise exception 'FALLO 13: authenticated pudo insertar en analytics_events';
  exception when insufficient_privilege then
    raise notice 'OK 13b: authenticated no puede insertar directo';
  end;
end $$;
reset role;
