-- Prueba de schools_manage_owner_with_check. Gemelo local, rollback al final.
begin;
do $$
declare v_pol text;
begin
  select with_check into v_pol from pg_policies where tablename='schools' and policyname='Schools: manage owner';
  if v_pol is null then raise exception 'FALLO: sin WITH CHECK'; end if;
end $$;

-- Actor sin escuela propia: owner de t1 (venue) = ca23363a...; admin.a, owner.a, owner.b del seed
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-a000-000000000001','role','authenticated')::text, true);
do $$
declare v_id uuid; n int;
begin
  -- dueño inserta su propia escuela (SchoolSetupPage)
  insert into public.schools(name, owner_id) values ('SEC prueba escuela', auth.uid()) returning id into v_id;
  -- dueño actualiza campos normales
  update public.schools set name='SEC prueba 2', city='Cali', onboarding_status='in_progress' where id = v_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALLO: dueño no pudo actualizar su escuela'; end if;
  -- no inserta con otro owner_id
  begin
    insert into public.schools(name, owner_id) values ('ajena', '00000000-0000-4000-a000-000000000007');
    raise exception 'FALLO: insertó escuela con owner ajeno';
  exception when insufficient_privilege then null; end;
  -- no reasigna owner_id
  begin
    update public.schools set owner_id='00000000-0000-4000-a000-000000000007' where id = v_id;
    raise exception 'FALLO: reasignó owner_id';
  exception when insufficient_privilege then null; end;
  -- no toca la escuela de otro dueño (0 filas)
  update public.schools set name='hack' where id='00000000-0000-4000-b000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLO: actualizó escuela ajena'; end if;
  raise notice 'OK dueño: insert propio, update propio, sin owner ajeno ni reasignación';
end $$;

-- el trigger de school_type venue sigue vivo: un dueño no puede auto-declararse 'venue'
do $$
begin
  begin
    insert into public.schools(name, owner_id, school_type) values ('venue falsa', auth.uid(), 'venue');
    raise exception 'FALLO: guard venue no actuó';
  exception when others then
    if sqlerrm like 'FALLO%' then raise; end if;
    raise notice 'OK guard venue: % ', sqlerrm;
  end;
end $$;
reset role;

-- admin (school_admin) de la escuela A: puede seguir editando branding/nombre pero NO tomar la propiedad
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','00000000-0000-4000-a000-000000000002','role','authenticated')::text, true);
do $$
declare n int;
begin
  begin
    update public.schools set owner_id = auth.uid() where id='00000000-0000-4000-b000-000000000001';
    raise exception 'FALLO: admin se adueñó de la escuela';
  exception when insufficient_privilege then null; end;
  raise notice 'OK admin no puede adueñarse';
end $$;
reset role;

-- service_role / postgres (auth.uid() NULL) puede reasignar (transferencia operativa)
update public.schools set owner_id = owner_id where id='00000000-0000-4000-b000-000000000001';
rollback;
