-- Onboarding etapa 1 · T01: el deporte elegido en el registro queda en la escuela.
-- Migración: 20261123082624_escuela_guarda_deporte_del_registro.sql
-- Datos inventados. Corre dentro de la transacción de run-local.sh (ROLLBACK).
do $$
declare
  u_con   uuid := gen_random_uuid();
  u_sin   uuid := gen_random_uuid();
  u_largo uuid := gen_random_uuid();
  v text[];
begin
  -- Dueños ficticios. El deporte viaja en raw_user_meta_data, como lo envía el registro.
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values
    (u_con,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t01-con@example.invalid',
     jsonb_build_object('full_name', 'Prueba Con Deporte', 'sport_name', '  Voleibol  '), '{}'::jsonb, now(), now()),
    (u_sin,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t01-sin@example.invalid',
     jsonb_build_object('full_name', 'Prueba Sin Deporte'), '{}'::jsonb, now(), now()),
    (u_largo, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t01-largo@example.invalid',
     jsonb_build_object('full_name', 'Prueba Largo', 'sport_name', repeat('x', 81)), '{}'::jsonb, now(), now());

  -- 1. Con deporte en el metadata: la escuela nace con ese deporte, sin espacios.
  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T01 con deporte', u_con, 'in_progress');
  select sports into v from public.schools where owner_id = u_con and name = 'ONB T01 con deporte';
  if v is distinct from array['Voleibol'] then
    raise exception 'FALLO 1: se esperaba {Voleibol}, quedó %', v;
  end if;
  raise notice 'OK 1: la escuela guarda el deporte del registro';

  -- 2. Sin deporte en el metadata: nace sin deportes, como antes.
  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T01 sin deporte', u_sin, 'in_progress');
  select sports into v from public.schools where owner_id = u_sin and name = 'ONB T01 sin deporte';
  if coalesce(array_length(v, 1), 0) <> 0 then
    raise exception 'FALLO 2: no debía tener deportes, quedó %', v;
  end if;
  raise notice 'OK 2: sin metadata no inventa deporte';

  -- 3. Si la escuela ya llega con deportes, no se pisan.
  insert into public.schools (name, owner_id, onboarding_status, sports) values ('ONB T01 explicito', u_con, 'in_progress', array['Natación']);
  select sports into v from public.schools where owner_id = u_con and name = 'ONB T01 explicito';
  if v is distinct from array['Natación'] then
    raise exception 'FALLO 3: pisó los deportes explícitos: %', v;
  end if;
  raise notice 'OK 3: respeta los deportes que ya trae la escuela';

  -- 4. Un valor absurdo (más de 80 caracteres) se descarta y el alta no falla.
  insert into public.schools (name, owner_id, onboarding_status) values ('ONB T01 largo', u_largo, 'in_progress');
  select sports into v from public.schools where owner_id = u_largo and name = 'ONB T01 largo';
  if coalesce(array_length(v, 1), 0) <> 0 then
    raise exception 'FALLO 4: guardó un deporte de más de 80 caracteres';
  end if;
  raise notice 'OK 4: descarta valores fuera de límite sin romper el alta';
end $$;
