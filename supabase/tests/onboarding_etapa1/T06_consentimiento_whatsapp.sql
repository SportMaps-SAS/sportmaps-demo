-- Onboarding etapa 2 · T06: el consentimiento de WhatsApp del registro se guarda
-- solo si la persona lo marcó. Datos inventados; todo en ROLLBACK.
do $$
declare
  a uuid := gen_random_uuid();  -- marcó la casilla
  b uuid := gen_random_uuid();  -- no la marcó
  c uuid := gen_random_uuid();  -- valor basura
  v timestamptz;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at) values
   (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t06a@example.invalid',
      jsonb_build_object('full_name','Con Consentimiento','role','school','whatsapp_consent', true), '{}'::jsonb, now(), now()),
   (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t06b@example.invalid',
      jsonb_build_object('full_name','Sin Consentimiento','role','school'), '{}'::jsonb, now(), now()),
   (c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t06c@example.invalid',
      jsonb_build_object('full_name','Valor Basura','role','school','whatsapp_consent','si'), '{}'::jsonb, now(), now());

  insert into public.profiles (id, full_name, role, email) values
    (a, 'Con Consentimiento', 'school', 'onb-t06a@example.invalid'),
    (b, 'Sin Consentimiento', 'school', 'onb-t06b@example.invalid'),
    (c, 'Valor Basura', 'school', 'onb-t06c@example.invalid')
  on conflict (id) do nothing;

  select whatsapp_consent_at into v from public.profiles where id = a;
  if v is null then raise exception 'FALLO 1: quien marcó la casilla debía quedar con fecha'; end if;
  if v < now() - interval '1 minute' then raise exception 'FALLO 1: fecha inesperada %', v; end if;

  select whatsapp_consent_at into v from public.profiles where id = b;
  if v is not null then raise exception 'FALLO 2: sin casilla no hay consentimiento'; end if;

  select whatsapp_consent_at into v from public.profiles where id = c;
  if v is not null then raise exception 'FALLO 3: solo el booleano true cuenta'; end if;

  if has_function_privilege('authenticated', 'public.fn_profiles_whatsapp_consent()', 'EXECUTE')
     or has_function_privilege('anon', 'public.fn_profiles_whatsapp_consent()', 'EXECUTE') then
    raise exception 'FALLO 4: la función del trigger no debe ser llamable';
  end if;

  raise notice 'T06 OK: consentimiento de WhatsApp';
end $$;
