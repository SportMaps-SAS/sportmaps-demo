-- Onboarding etapa 1 · T02: get_onboarding_status marca los pasos por lo que existe.
-- Migración: 20261123084254_onboarding_status_pasos_reales.sql
-- Datos inventados. Corre dentro de la transacción de run-local.sh (ROLLBACK).
do $$
declare
  u uuid := gen_random_uuid();
  s uuid;
  st jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t02@example.invalid',
          jsonb_build_object('full_name', 'Prueba Status', 'role', 'school'), '{}'::jsonb, now(), now());

  insert into public.profiles (id, full_name, role, email)
  values (u, 'Prueba Status', 'school', 'onb-t02@example.invalid')
  on conflict (id) do nothing;

  insert into public.schools (name, owner_id, onboarding_status)
  values ('ONB T02 academia', u, 'in_progress') returning id into s;

  -- Red de seguridad por si la base local no trae los triggers de alta.
  insert into public.school_members (school_id, profile_id, role, status)
  values (s, u, 'owner', 'active') on conflict do nothing;
  if not exists (select 1 from public.school_branches where school_id = s and is_main) then
    insert into public.school_branches (school_id, name, is_main) values (s, 'Sede Principal', true);
  end if;
  insert into public.school_settings (school_id) values (s) on conflict (school_id) do nothing;

  -- A partir de acá, la sesión es la del dueño ficticio.
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);

  -- 1. Recién creada: hay sede, pero NO está confirmada; nada más está hecho.
  st := public.get_onboarding_status();
  if (st->>'school_id')::uuid is distinct from s then raise exception 'FALLO 1: school_id %', st->>'school_id'; end if;
  if (st->>'has_branches')::boolean is not true then raise exception 'FALLO 1: has_branches debía seguir en true'; end if;
  if (st->>'branch_confirmed')::boolean is not false then raise exception 'FALLO 1 (B): sede sin dirección no puede estar confirmada'; end if;
  if (st->>'payment_setup_completed')::boolean is not false then raise exception 'FALLO 1 (C): sin medios de cobro'; end if;
  if (st->>'has_staff')::boolean is not false then raise exception 'FALLO 1 (D): sin entrenador'; end if;
  if (st->>'has_students')::boolean is not false then raise exception 'FALLO 1: sin deportistas'; end if;
  if (st->>'has_charges')::boolean is not false then raise exception 'FALLO 1 (E): sin cobros'; end if;
  raise notice 'OK 1: escuela nueva — sede sin confirmar y ningún paso marcado';

  -- 2. B: una dirección en blanco no cuenta; una real sí.
  update public.school_branches set address = '   ' where school_id = s and is_main;
  if ((public.get_onboarding_status())->>'branch_confirmed')::boolean is not false then
    raise exception 'FALLO 2 (B): una dirección en blanco no confirma la sede';
  end if;
  update public.school_branches set address = 'Calle Ficticia 1 # 2-3' where school_id = s and is_main;
  if ((public.get_onboarding_status())->>'branch_confirmed')::boolean is not true then
    raise exception 'FALLO 2 (B): con dirección debía quedar confirmada';
  end if;
  raise notice 'OK 2 (B): la sede se confirma cuando tiene dirección';

  -- 3. C: solo Nequi basta. Y un banco sin número de cuenta, no.
  update public.school_settings set bank_name = 'Banco Ficticio' where school_id = s;
  if ((public.get_onboarding_status())->>'payment_setup_completed')::boolean is not false then
    raise exception 'FALLO 3 (C): banco sin número de cuenta no es un medio de cobro';
  end if;
  update public.school_settings set bank_name = null, nequi_number = '3000000000' where school_id = s;
  if ((public.get_onboarding_status())->>'payment_setup_completed')::boolean is not true then
    raise exception 'FALLO 3 (C): solo Nequi debía bastar';
  end if;
  update public.school_settings set nequi_number = null,
         payment_accounts = '[{"id":"x","type":"breb","label":"Bre-B","value":"@ficticia","active":true}]'::jsonb
   where school_id = s;
  if ((public.get_onboarding_status())->>'payment_setup_completed')::boolean is not true then
    raise exception 'FALLO 3 (C): una llave en payment_accounts debía bastar';
  end if;
  raise notice 'OK 3 (C): cualquier medio de cobro marca el paso';

  -- 4. D: el entrenador invitado por el asistente (school_staff) marca el paso.
  insert into public.school_staff (school_id, full_name, email, specialty, status)
  values (s, 'Entrenador Ficticio', 'onb-t02-coach@example.invalid', 'coach', 'active');
  if ((public.get_onboarding_status())->>'has_staff')::boolean is not true then
    raise exception 'FALLO 4 (D): school_staff debía marcar has_staff';
  end if;
  raise notice 'OK 4 (D): el entrenador invitado marca el paso';

  -- 5. E: el primer cobro enciende has_charges.
  insert into public.payments (school_id, amount, concept, due_date, status)
  values (s, 50000, 'ONB T02 cobro ficticio', current_date, 'pending');
  if ((public.get_onboarding_status())->>'has_charges')::boolean is not true then
    raise exception 'FALLO 5 (E): con un cobro debía dar has_charges';
  end if;
  raise notice 'OK 5 (E): el primer cobro enciende has_charges';

  -- 6. Otra cuenta no ve nada de esta escuela.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  st := public.get_onboarding_status();
  if st->>'school_id' is not null or (st->>'has_charges')::boolean or (st->>'payment_setup_completed')::boolean then
    raise exception 'FALLO 6: una cuenta ajena ve estado de la escuela: %', st;
  end if;
  raise notice 'OK 6: una cuenta sin escuela no hereda el estado de otra';

  perform set_config('request.jwt.claims', '', true);
end $$;

-- 7. Permisos: el helper no es invocable por la app; la RPC sí, y no por anon.
do $$
begin
  if has_function_privilege('authenticated', 'public._school_has_payment_method(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public._school_has_payment_method(uuid)', 'EXECUTE') then
    raise exception 'FALLO 7: _school_has_payment_method quedó ejecutable por la app';
  end if;
  if not has_function_privilege('authenticated', 'public.get_onboarding_status()', 'EXECUTE') then
    raise exception 'FALLO 7: authenticated perdió EXECUTE sobre get_onboarding_status';
  end if;
  if has_function_privilege('anon', 'public.get_onboarding_status()', 'EXECUTE') then
    raise exception 'FALLO 7: anon puede ejecutar get_onboarding_status';
  end if;
  raise notice 'OK 7: permisos correctos';
end $$;
