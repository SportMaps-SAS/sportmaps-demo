-- =============================================================================
-- Verificación de 20261029101109_notify_user_solo_destinatarios_con_relacion
-- Correr DESPUÉS de pegar aplicar-1-…notify_user….sql.
--
-- Un solo bloque DO que termina SIEMPRE en RAISE EXCEPTION, a propósito: las
-- notificaciones que inserta notify_user en los casos OK se deshacen.
-- Resultado esperado: un error que empieza por
--   «RESULTADO — N/N OK (se deshace a propósito)»
-- Cualquier otro error = una prueba falló (el mensaje dice cuál) o faltaron
-- datos para prepararla («PREPARACIÓN: …»).
--
-- ¿Sale algún push real? NO. El INSERT en notifications dispara
-- trg_enqueue_notification_delivery → enqueue_notification_delivery(), que
-- (1) inserta en notification_deliveries y (2) si dispatch_enabled, llama
-- net.http_post. net.http_post solo hace INSERT en net.http_request_queue
-- (tabla transaccional) + net.wake(); el worker de pg_net solo ve filas
-- commiteadas. Con el RAISE final todo se deshace: ni outbox, ni request, ni
-- push. (trg_push_on_notification, el legacy, está deshabilitado.)
--
-- Usuarios reales elegidos por SELECT al arrancar (no se modifican):
--   A   owner/admin/school_admin activo de la escuela SA
--   P   acudiente con un child en SA (no es staff en ninguna escuela)
--   C   coach (school_staff.coach_auth_id) activo en SA, sin rol de administración
--   UB  acudiente de otra escuela, sin ninguna relación con las escuelas de A
--   X   perfil sin ninguna relación (ni escuela, ni hijos, ni cobros, ni citas)
--   W/PR atleta (o quien reservó) y profesional de una wellness_appointments  [opcional]
--   PA  admin de plataforma activo                                            [opcional]
-- Las sesiones se simulan con set_config('request.jwt.claims', …, true) y
-- SET LOCAL ROLE authenticated / anon.
-- =============================================================================
DO $$
DECLARE
  v_total int := 17;
  v_a uuid; v_sa uuid; v_p uuid; v_c uuid; v_ub uuid; v_x uuid;
  v_w uuid; v_pr uuid; v_pa uuid;
  v_admin_a uuid[];
  v_n int;
  v_ok int := 0;
  v_nota text := '';
  c_marca constant text := 'VERIFICAR-NOTIFY-USER-1029';
BEGIN
  -- ── Preparación (como postgres) ────────────────────────────────────────────
  SELECT sm.profile_id, sm.school_id, c.parent_id, ss.coach_auth_id
    INTO v_a, v_sa, v_p, v_c
    FROM public.school_members sm
    JOIN public.children c      ON c.school_id = sm.school_id AND c.parent_id IS NOT NULL
    JOIN public.school_staff ss ON ss.school_id = sm.school_id AND ss.status = 'active' AND ss.coach_auth_id IS NOT NULL
   WHERE sm.role IN ('owner','admin','school_admin') AND sm.status = 'active'
     AND c.parent_id <> sm.profile_id
     AND ss.coach_auth_id NOT IN (sm.profile_id, c.parent_id)
     AND EXISTS (SELECT 1 FROM public.profiles x WHERE x.id = c.parent_id)
     AND EXISTS (SELECT 1 FROM public.profiles x WHERE x.id = ss.coach_auth_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff x   WHERE x.coach_auth_id = c.parent_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_members x WHERE x.profile_id = c.parent_id AND x.role NOT IN ('parent','athlete'))
     AND NOT EXISTS (SELECT 1 FROM public.schools x        WHERE x.owner_id = c.parent_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_members x WHERE x.profile_id = ss.coach_auth_id
                       AND x.role IN ('owner','admin','school_admin','super_admin'))
     AND NOT EXISTS (SELECT 1 FROM public.schools x        WHERE x.owner_id = ss.coach_auth_id)
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins x WHERE x.profile_id IN (sm.profile_id, c.parent_id, ss.coach_auth_id))
     AND NOT EXISTS (SELECT 1 FROM public.wellness_appointments w
                      WHERE w.professional_id IN (c.parent_id, ss.coach_auth_id))
   ORDER BY sm.school_id, c.parent_id
   LIMIT 1;
  IF v_a IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay admin A + acudiente P + coach C en una misma escuela'; END IF;

  v_admin_a := ARRAY(
    SELECT sm.school_id FROM public.school_members sm
     WHERE sm.profile_id = v_a AND sm.status = 'active' AND sm.role IN ('owner','admin','school_admin','super_admin')
    UNION
    SELECT s.id FROM public.schools s WHERE s.owner_id = v_a);

  SELECT ub.profile_id INTO v_ub
    FROM public.school_members ub
   WHERE ub.role = 'parent' AND ub.status = 'active'
     AND ub.profile_id NOT IN (v_a, v_p, v_c)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff x WHERE x.coach_auth_id = ub.profile_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff x JOIN auth.users au ON lower(au.email) = lower(x.email)
                      WHERE au.id = ub.profile_id)
     AND NOT EXISTS (SELECT 1 FROM public.schools x WHERE x.owner_id = ub.profile_id)
     AND NOT EXISTS (SELECT 1 FROM public.school_members x WHERE x.profile_id = ub.profile_id
                       AND (x.role NOT IN ('parent','athlete') OR x.school_id = ANY (v_admin_a)))
     AND NOT EXISTS (SELECT 1 FROM public.children x WHERE x.parent_id = ub.profile_id AND x.school_id = ANY (v_admin_a))
     AND NOT EXISTS (SELECT 1 FROM public.enrollments e WHERE e.school_id = ANY (v_admin_a)
                       AND (e.user_id = ub.profile_id
                            OR e.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = ub.profile_id)))
     AND NOT EXISTS (SELECT 1 FROM public.payments x WHERE x.school_id = ANY (v_admin_a)
                       AND (x.parent_id = ub.profile_id OR x.user_id = ub.profile_id))
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins x WHERE x.profile_id = ub.profile_id)
     AND NOT EXISTS (SELECT 1 FROM public.wellness_appointments w
                      WHERE ub.profile_id IN (w.professional_id, w.athlete_id, w.booked_by))
     AND EXISTS (SELECT 1 FROM public.profiles x WHERE x.id = ub.profile_id)
   LIMIT 1;
  IF v_ub IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay acudiente UB de otra escuela sin relación con A'; END IF;

  SELECT p.id INTO v_x
    FROM public.profiles p
    JOIN auth.users au ON au.id = p.id
   WHERE NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.profile_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.school_staff s WHERE s.coach_auth_id = p.id OR lower(s.email) = lower(au.email))
     AND NOT EXISTS (SELECT 1 FROM public.enrollments e WHERE e.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.children c WHERE c.parent_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.payments y WHERE y.parent_id = p.id OR y.user_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.schools s WHERE s.owner_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = p.id)
     AND NOT EXISTS (SELECT 1 FROM public.wellness_appointments w WHERE p.id IN (w.professional_id, w.athlete_id, w.booked_by))
   LIMIT 1;
  IF v_x IS NULL THEN RAISE EXCEPTION 'PREPARACIÓN: no hay usuario X sin relación'; END IF;

  SELECT coalesce(w.athlete_id, w.booked_by), w.professional_id INTO v_w, v_pr
    FROM public.wellness_appointments w
   WHERE w.professional_id IS NOT NULL
     AND coalesce(w.athlete_id, w.booked_by) IS NOT NULL
     AND coalesce(w.athlete_id, w.booked_by) <> w.professional_id
     AND NOT EXISTS (SELECT 1 FROM public.platform_admins x
                      WHERE x.profile_id IN (w.professional_id, coalesce(w.athlete_id, w.booked_by)))
   LIMIT 1;
  IF v_w IS NULL THEN v_total := v_total - 2; v_nota := v_nota || ' · wellness omitido (sin citas)'; END IF;

  SELECT pa.profile_id INTO v_pa
    FROM public.platform_admins pa
    JOIN public.profiles p ON p.id = pa.profile_id
   WHERE pa.is_active AND pa.profile_id <> v_x
   LIMIT 1;
  IF v_pa IS NULL THEN v_total := v_total - 1; v_nota := v_nota || ' · admin de plataforma omitido (no hay)'; END IF;

  -- ── Estructura ─────────────────────────────────────────────────────────────
  -- E1: SECURITY DEFINER + search_path fijo
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.notify_user(uuid,text,text,text,text)'::regprocedure
                    AND prosecdef
                    AND 'search_path=pg_catalog, public, pg_temp' = ANY (proconfig)) THEN
    RAISE EXCEPTION 'FALLA E1: notify_user no es DEFINER con search_path = pg_catalog, public, pg_temp';
  END IF;
  v_ok := v_ok + 1;

  -- E2: EXECUTE → authenticated SÍ; anon y PUBLIC NO; helper sin EXECUTE para nadie de la app
  IF NOT has_function_privilege('authenticated', 'public.notify_user(uuid,text,text,text,text)', 'EXECUTE')
  OR has_function_privilege('anon', 'public.notify_user(uuid,text,text,text,text)', 'EXECUTE')
  OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.notify_user(uuid,text,text,text,text)'::regprocedure
                AND a.grantee = 0 AND a.privilege_type = 'EXECUTE')
  OR has_function_privilege('authenticated', 'public._notify_user_destinatario_permitido(uuid)', 'EXECUTE')
  OR has_function_privilege('anon',          'public._notify_user_destinatario_permitido(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLA E2: EXECUTE de notify_user / helper no quedó como se espera';
  END IF;
  v_ok := v_ok + 1;

  -- ── F1: admin A → acudiente P de su escuela (OK) ───────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_a, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.notify_user(v_p, c_marca, 'F1', 'info', '/my-payments');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM public.notifications WHERE user_id = v_p AND title = c_marca;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA F1: admin → acudiente de su escuela no insertó (%)', v_n; END IF;
  v_ok := v_ok + 1;

  -- ── F2: admin A → acudiente P con link externo (rechaza) ──────────────────
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_user(v_p, c_marca, 'F2', 'info', 'https://evil.example/login');
    RAISE EXCEPTION 'FALLA F2: aceptó un link externo';
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := v_ok + 1;
  END;
  BEGIN
    PERFORM public.notify_user(v_p, c_marca, 'F2b', 'info', '//evil.example');
    RAISE EXCEPTION 'FALLA F2b: aceptó un link //host';
  EXCEPTION WHEN invalid_parameter_value THEN v_ok := v_ok + 1;
  END;

  -- ── F3: admin A → usuario UB de otra escuela (rechaza) ────────────────────
  BEGIN
    PERFORM public.notify_user(v_ub, c_marca, 'F3', 'info', '/');
    RAISE EXCEPTION 'FALLA F3: admin de A notificó a un usuario de otra escuela (%)', v_ub;
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── F4: acudiente P → coach C de su escuela (OK) ──────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.notify_user(v_c, c_marca, 'F4', 'payment', '/finances');
  -- F5: acudiente P → admin A de su escuela (OK, caso ParentCheckoutPage)
  PERFORM public.notify_user(v_a, c_marca, 'F5', 'payment', '/finances');
  -- F6: acudiente P → otro acudiente UB (rechaza: no es staff ni hay relación)
  BEGIN
    PERFORM public.notify_user(v_ub, c_marca, 'F6', 'info', '/');
    RAISE EXCEPTION 'FALLA F6: un acudiente notificó a otro acudiente';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;
  SELECT count(*) INTO v_n FROM public.notifications WHERE user_id IN (v_c, v_a) AND title = c_marca;
  IF v_n <> 2 THEN RAISE EXCEPTION 'FALLA F4/F5: acudiente → staff de su escuela insertó % de 2', v_n; END IF;
  v_ok := v_ok + 2;

  -- ── F7: coach C (sin rol de administración) → acudiente P (rechaza, como antes) ─
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_c, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_user(v_p, c_marca, 'F7', 'info', '/');
    RAISE EXCEPTION 'FALLA F7: un coach sin rol de administración notificó a un acudiente';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── F8/F9: usuario X sin relación → A y → P (rechaza) ─────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_x, 'role','authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.notify_user(v_a, c_marca, 'F8', 'info', '/');
    RAISE EXCEPTION 'FALLA F8: usuario sin relación notificó a un admin';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  BEGIN
    PERFORM public.notify_user(v_p, c_marca, 'F9', 'info', '/');
    RAISE EXCEPTION 'FALLA F9: usuario sin relación notificó a un acudiente';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  -- ── F10: X → sí mismo (OK, caso transactions.ts:108) ──────────────────────
  PERFORM public.notify_user(v_x, c_marca, 'F10', 'payment', '/my-payments');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM public.notifications WHERE user_id = v_x AND title = c_marca;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA F10: notificarse a sí mismo no insertó (%)', v_n; END IF;
  v_ok := v_ok + 1;

  -- ── F11: anon no ejecuta ──────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.notify_user(v_p, c_marca, 'F11', 'info', '/');
    RAISE EXCEPTION 'FALLA F11: anon ejecutó notify_user';
  EXCEPTION WHEN insufficient_privilege THEN v_ok := v_ok + 1;
  END;
  RESET ROLE;

  -- ── W1/W2: atleta ↔ profesional de wellness con cita (OK, transactions.ts:144) ─
  IF v_w IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_w, 'role','authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.notify_user(v_pr, c_marca, 'W1', 'appointment', '/wellness/schedule');
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pr, 'role','authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.notify_user(v_w, c_marca, 'W2', 'appointment', '/');
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.notifications WHERE user_id IN (v_w, v_pr) AND title = c_marca AND message IN ('W1','W2');
    IF v_n <> 2 THEN RAISE EXCEPTION 'FALLA W1/W2: atleta ↔ profesional con cita insertó % de 2', v_n; END IF;
    v_ok := v_ok + 2;
  END IF;

  -- ── PA1: admin de plataforma → X (OK) ─────────────────────────────────────
  IF v_pa IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pa, 'role','authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.notify_user(v_x, c_marca, 'PA1', 'info', '/');
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.notifications WHERE user_id = v_x AND title = c_marca AND message = 'PA1';
    IF v_n <> 1 THEN RAISE EXCEPTION 'FALLA PA1: admin de plataforma no pudo notificar'; END IF;
    v_ok := v_ok + 1;
  END IF;

  IF v_ok <> v_total THEN
    RAISE EXCEPTION 'FALLA conteo: % de % pruebas', v_ok, v_total;
  END IF;

  RAISE EXCEPTION 'RESULTADO — %/% OK (se deshace a propósito)%', v_ok, v_total, v_nota;
END $$;
