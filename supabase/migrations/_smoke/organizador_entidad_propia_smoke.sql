
DO $smoke$
DECLARE
  u_org   uuid := gen_random_uuid();
  u_org2  uuid := gen_random_uuid();
  u_ath   uuid := gen_random_uuid();
  v_rep   text := '';
  v_sid   uuid;
  v_sid2  uuid;
  r       record;
BEGIN
  -- 1. Registro con rol organizer + nombre -> perfil organizer y organización creada
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (u_org, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'smoke-org-' || u_org || '@example.invalid',
          jsonb_build_object('role','organizer','school_name','Liga Smoke','full_name','Smoke Org','school_type','academy'), now(), now());

  SELECT role::text AS role, needs_role_selection AS needs INTO r FROM public.profiles WHERE id = u_org;
  v_rep := v_rep || format('1a perfil role=%s needs_role=%s | ', r.role, r.needs);

  SELECT id INTO v_sid FROM public.schools WHERE owner_id = u_org;
  SELECT school_type AS t, onboarding_status AS o INTO r FROM public.schools WHERE id = v_sid;
  v_rep := v_rep || format('1b escuela tipo=%s (metadata decia academy) onb=%s | ', r.t, r.o);

  SELECT count(*) AS n INTO r FROM public.school_members WHERE school_id = v_sid AND profile_id = u_org AND role = 'owner' AND status = 'active';
  v_rep := v_rep || format('1c membresia owner=%s | ', r.n);

  SELECT status AS st, tier AS ti, blocking_exempt AS ex INTO r FROM public.school_subscriptions WHERE school_id = v_sid;
  v_rep := v_rep || format('1d suscripcion status=%s tier=%s exento=%s | ', r.st, r.ti, r.ex);

  SELECT has_tournaments AS ht, has_academy AS ha INTO r FROM public.v_school_entitlements WHERE school_id = v_sid;
  v_rep := v_rep || format('1e has_tournaments=%s has_academy=%s | ', r.ht, r.ha);

  v_rep := v_rep || format('1f operativa=%s | ', public.school_is_operational(v_sid));

  -- 2. RPC de onboarding como el propio organizador (idempotente: misma organización)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_sid2 := public.create_organizer_org('Liga Smoke Pro', 'Cali', ARRAY['futbol','voleibol'], 'Liga de prueba', 'https://example.com/logo.png');
  RESET ROLE;
  v_rep := v_rep || format('2a misma_org=%s | ', v_sid2 = v_sid);
  SELECT name AS n, city AS c, onboarding_status AS o, array_to_string(sports, ',') AS sp INTO r FROM public.schools WHERE id = v_sid;
  v_rep := v_rep || format('2b nombre=%s ciudad=%s onb=%s deportes=%s | ', r.n, r.c, r.o, r.sp);
  SELECT count(*) AS n INTO r FROM public.schools WHERE owner_id = u_org;
  v_rep := v_rep || format('2c orgs_del_dueno=%s | ', r.n);

  -- 3. Organizador SIN organización (cuenta vieja): el RPC la crea
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (u_org2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'smoke-org2-' || u_org2 || '@example.invalid',
          jsonb_build_object('role','organizer','full_name','Smoke Org 2'), now(), now());
  SELECT count(*) AS n INTO r FROM public.schools WHERE owner_id = u_org2;
  v_rep := v_rep || format('3a sin_nombre_no_crea_org=%s | ', r.n = 0);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_org2, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_sid2 := public.create_organizer_org('Federacion Smoke', 'Bogota');
  RESET ROLE;
  SELECT count(*) AS n INTO r FROM public.school_members WHERE school_id = v_sid2 AND profile_id = u_org2 AND role = 'owner';
  v_rep := v_rep || format('3b rpc_crea_org_y_owner=%s | ', r.n = 1);

  -- 4. Negativos: un atleta no puede; anon no tiene EXECUTE; nombre corto; logo http
  INSERT INTO auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  VALUES (u_ath, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'smoke-ath-' || u_ath || '@example.invalid', jsonb_build_object('role','athlete','full_name','Smoke Ath'), now(), now());
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_ath, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.create_organizer_org('Intruso');
    v_rep := v_rep || '4a ATLETA_PUDO=SI(MAL) | ';
  EXCEPTION WHEN insufficient_privilege THEN
    v_rep := v_rep || '4a atleta_bloqueado=OK | ';
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.create_organizer_org('x');
    v_rep := v_rep || '4b nombre_corto=SI(MAL) | ';
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rep := v_rep || '4b nombre_corto_rechazado=OK | ';
  END;
  BEGIN
    PERFORM public.create_organizer_org('Liga Smoke', NULL, NULL, NULL, 'http://evil.example/x.png');
    v_rep := v_rep || '4c logo_http=SI(MAL) | ';
  EXCEPTION WHEN invalid_parameter_value THEN
    v_rep := v_rep || '4c logo_http_rechazado=OK | ';
  END;
  BEGIN
    PERFORM public._create_organizer_org(u_org, 'Helper directo', NULL);
    v_rep := v_rep || '4d helper_expuesto=SI(MAL) | ';
  EXCEPTION WHEN insufficient_privilege THEN
    v_rep := v_rep || '4d helper_sin_execute=OK | ';
  END;
  RESET ROLE;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.create_organizer_org('Anon');
    v_rep := v_rep || '4e anon_pudo=SI(MAL) | ';
  EXCEPTION WHEN insufficient_privilege THEN
    v_rep := v_rep || '4e anon_sin_execute=OK | ';
  END;
  RESET ROLE;

  -- 5. Regresión: los demás roles siguen igual
  SELECT role::text AS role, needs_role_selection AS needs INTO r FROM public.profiles WHERE id = u_ath;
  v_rep := v_rep || format('5a atleta role=%s needs=%s | ', r.role, r.needs);
  v_rep := v_rep || format('5b normalize(school_admin)=%s normalize(organizer)=%s normalize(basura)=%s | ',
            coalesce(public.normalize_signup_role('school_admin'),'NULL'), public.normalize_signup_role('organizer'), coalesce(public.normalize_signup_role('x'),'NULL'));

  RAISE EXCEPTION 'SMOKE-REPORT: %', v_rep;
END
$smoke$;
