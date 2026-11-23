-- Onboarding etapa 2 · T05: get_onboarding_checklist_extras marca por lo que existe
-- y valida el alcance del caller sobre ESE id. Datos inventados; todo en ROLLBACK.
do $$
declare
  u uuid := gen_random_uuid();   -- dueño
  p uuid := gen_random_uuid();   -- acudiente (no es staff)
  s uuid;
  x jsonb;
  hijo uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t05@example.invalid',
          jsonb_build_object('full_name', 'Prueba Extras', 'role', 'school'), '{}'::jsonb, now(), now()),
         (p, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t05p@example.invalid',
          jsonb_build_object('full_name', 'Prueba Acudiente', 'role', 'parent'), '{}'::jsonb, now(), now());
  insert into public.profiles (id, full_name, role, email) values
    (u, 'Prueba Extras', 'school', 'onb-t05@example.invalid'),
    (p, 'Prueba Acudiente', 'parent', 'onb-t05p@example.invalid')
  on conflict (id) do nothing;

  insert into public.schools (name, owner_id, onboarding_status)
  values ('ONB T05 academia', u, 'completed') returning id into s;
  insert into public.school_members (school_id, profile_id, role, status)
  values (s, u, 'owner', 'active') on conflict do nothing;
  insert into public.school_settings (school_id) values (s) on conflict (school_id) do nothing;

  -- 1. Un acudiente (miembro de otra cosa, sin ser staff) NO ve el avance.
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'ok')::boolean is not false then raise exception 'FALLO 1: un no-staff no debe ver el avance: %', x; end if;

  -- 2. El dueño ve todo en falso al principio.
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'ok')::boolean is not true then raise exception 'FALLO 2: el dueño debía ver su avance: %', x; end if;
  if (x->>'has_families')::boolean is not false then raise exception 'FALLO 2: has_families %', x; end if;
  if (x->>'has_facility')::boolean is not false then raise exception 'FALLO 2: has_facility %', x; end if;
  if (x->>'has_reservation')::boolean is not false then raise exception 'FALLO 2: has_reservation %', x; end if;
  if (x->>'has_payment_method')::boolean is not false then raise exception 'FALLO 2: has_payment_method %', x; end if;

  -- 3. Otra escuela (id ajeno): no se ve.
  x := public.get_onboarding_checklist_extras(gen_random_uuid());
  if (x->>'ok')::boolean is not false then raise exception 'FALLO 3: id ajeno %', x; end if;
  x := public.get_onboarding_checklist_extras(null);
  if (x->>'ok')::boolean is not false then raise exception 'FALLO 3: id nulo %', x; end if;

  -- 4. Medio de pago: Nequi marca has_payment_method.
  update public.school_settings set nequi_number = '3000000000' where school_id = s;
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'has_payment_method')::boolean is not true then raise exception 'FALLO 4: Nequi debía contar %', x; end if;

  -- 5. Familias: una invitación enviada cuenta.
  insert into public.invitations (school_id, email, role_to_assign, status, child_name, invited_by)
  values (s, 'familia-t05@example.invalid', 'parent', 'pending', 'Hijo Inventado', u);
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'has_families')::boolean is not true then raise exception 'FALLO 5: la invitación debía contar %', x; end if;

  -- 6. Familias: sin invitación pero con acudiente vinculado también cuenta.
  delete from public.invitations where school_id = s;
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'has_families')::boolean is not false then raise exception 'FALLO 6a: sin invitación ni acudiente %', x; end if;
  insert into public.school_members (school_id, profile_id, role, status) values (s, p, 'parent', 'active');
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'has_families')::boolean is not true then raise exception 'FALLO 6b: el acudiente vinculado debía contar %', x; end if;

  -- 7. Cancha: una fila en facilities marca has_facility.
  insert into public.facilities (school_id, name, type) values (s, 'Cancha inventada', 'cancha');
  x := public.get_onboarding_checklist_extras(s);
  if (x->>'has_facility')::boolean is not true then raise exception 'FALLO 7: la cancha debía contar %', x; end if;

  -- 8. Permisos: anon no ejecuta; authenticated sí.
  if has_function_privilege('anon', 'public.get_onboarding_checklist_extras(uuid)', 'EXECUTE') then
    raise exception 'FALLO 8: anon no debe poder ejecutarla';
  end if;
  if not has_function_privilege('authenticated', 'public.get_onboarding_checklist_extras(uuid)', 'EXECUTE') then
    raise exception 'FALLO 8: authenticated debía poder ejecutarla';
  end if;

  raise notice 'T05 OK: get_onboarding_checklist_extras';
end $$;
