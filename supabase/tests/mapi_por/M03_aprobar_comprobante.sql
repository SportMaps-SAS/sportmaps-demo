-- Preludio común de supabase/tests/mapi_por (se pega al inicio de cada caso: el
-- runner de qa:sql corre un archivo por caso, sin includes). Gemelo local SOLAMENTE.
-- Plan: docs/specs/mapi-rpc-por-actor-plan.md §9.
--
-- Actores del seed del gemelo (Academia Andes = A, QA Club Llanos = B):
--   a01 owner A · a02 school_admin A · a03 coach A (school_staff 4663036e…) ·
--   a04 acudiente A (hijos c…001, c…0f1, c…0f2) · a06 atleta A · a07 owner B
begin;
create schema t_mapi;
grant usage on schema t_mapi to public;

-- El BFF: service_role sin persona.
create function t_mapi.servidor() returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
end $f$;

-- La pantalla: sesión de una persona.
create function t_mapi.usuario(u uuid) returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  execute 'set local role authenticated';
end $f$;

-- Dueño sin claims (migraciones / SQL editor), para preparar y revisar.
create function t_mapi.dueno() returns void language plpgsql as $f$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $f$;

-- Espera un error cuyo mensaje contenga frag. El error revierte lo que hizo la
-- llamada (incluido el actor fijado), como en una request real.
create function t_mapi.falla(q text, frag text) returns void language plpgsql as $f$
begin
  begin
    execute q;
  exception when others then
    if position(lower(frag) in lower(sqlerrm)) = 0 then
      raise exception 'FALLO: esperaba «%», vino «%» en: %', frag, sqlerrm, q;
    end if;
    raise notice 'ok (%): %', frag, left(sqlerrm, 110);
    return;
  end;
  raise exception 'FALLO: esperaba el error «%» y pasó: %', frag, q;
end $f$;

create function t_mapi.eq(caso text, obtenido anyelement, esperado anyelement) returns void language plpgsql as $f$
begin
  if obtenido is distinct from esperado then
    raise exception 'FALLO %: obtenido %, esperado %', caso, obtenido, esperado;
  end if;
  raise notice 'ok %', caso;
end $f$;

-- Saldo por cubrir del cobro (amount − pronto pago − abonado).
create function t_mapi.saldo(p uuid) returns numeric language sql as $f$
  select amount - coalesce(early_payment_discount_applied, 0) - coalesce(amount_paid, 0) from public.payments where id = p $f$;

grant execute on all functions in schema t_mapi to public;
-- =============================================================================
-- M03 — aprobar_comprobante (núcleo + gemela + _por, migración 20261126101150).
-- Casos A1–A12 del plan §9.3.
-- =============================================================================

-- Cobro de prueba con comprobante (lo crea el dueño). Devuelve el id; el saldo
-- real se lee después (los triggers de alta pueden aplicar descuentos).
create function t_mapi.pago(p_monto numeric, p_veredicto text, p_motivos jsonb,
                            p_categoria text default 'otro', p_anio int default null, p_mes int default null,
                            p_url text default null)
returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin
  insert into public.payments (id, school_id, child_id, parent_id, amount, concept, due_date, status,
                               payment_type, payment_category, period_uniqueness_exempt, period_year, period_month,
                               receipt_url, receipt_verdict, receipt_verdict_reasons,
                               receipt_image_sha256, receipt_reference_norm, ocr_reference)
  values (v, '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000001',
          '00000000-0000-4000-a000-000000000004', p_monto, 'Cobro QA mapi ' || left(v::text, 8),
          (now() at time zone 'America/Bogota')::date, 'awaiting_approval',
          'one_time', p_categoria, p_categoria <> 'mensualidad', p_anio, p_mes,
          coalesce(p_url, 'qa/mapi/' || v || '.jpg'), p_veredicto, p_motivos,
          md5(v::text || 'img'), 'REF' || upper(left(md5(v::text), 10)), 'REF' || upper(left(md5(v::text), 10)));
  -- Lo que dice el comprobante = el saldo real (después de los triggers de alta).
  -- Lectura sellada por el servidor (Paso 4), como la deja el BFF al leer el comprobante.
  update public.payments set ocr_amount = amount - coalesce(early_payment_discount_applied, 0),
                             receipt_image_sha256_source = 'server_verified' where id = v;
  -- fn_payments_fill_period llena el periodo desde due_date: sin periodo pedido, se deja vacío
  -- para que los cobros de prueba no choquen con la regla «ese mes ya estaba pagado».
  if p_anio is null then update public.payments set period_year = null, period_month = null where id = v; end if;
  return v;
end $f$;
grant execute on all functions in schema t_mapi to public;

do $t$
declare
  A   constant uuid := '00000000-0000-4000-b000-000000000001';
  a01 constant uuid := '00000000-0000-4000-a000-000000000001';
  a02 constant uuid := '00000000-0000-4000-a000-000000000002';
  a04 constant uuid := '00000000-0000-4000-a000-000000000004';
  a07 constant uuid := '00000000-0000-4000-a000-000000000007';
  c1  constant uuid := '00000000-0000-4000-c000-000000000001';
  solo_monto constant jsonb := '[{"code":"MONTO_DIFIERE","level":"amarillo"}]';
  p uuid; q uuid; e uuid; r jsonb; k uuid; n int; s numeric; t text;
begin
  perform t_mapi.dueno();

  -- ── A1: verde, monto = saldo, por la _por ──
  p := t_mapi.pago(145000, 'verde', '[]', 'mensualidad', 2027, 1);
  insert into public.enrollments (id, school_id, child_id, team_id, status, start_date)
       values (gen_random_uuid(), A, c1, '1076d0e9-6fae-4dd4-803d-d9c8cabf6394', 'pending', (now() at time zone 'America/Bogota')::date) returning id into e;
  s := t_mapi.saldo(p); k := gen_random_uuid();
  perform t_mapi.servidor();
  r := public.aprobar_comprobante_por(a02, p, NULL, 0, k, 'mapi_whatsapp', NULL);
  perform t_mapi.dueno();
  perform t_mapi.eq('A1 estado paid', (select status from public.payments where id = p), 'paid');
  perform t_mapi.eq('A1 amount_paid = saldo', (select amount_paid from public.payments where id = p), s);
  perform t_mapi.eq('A1 approved_by = actor', (select approved_by from public.payments where id = p), a02);
  perform t_mapi.eq('A1 unblocked_by = actor', (select unblocked_by from public.payments where id = p), a02);
  perform t_mapi.eq('A1 inscripción activada', (select status from public.enrollments where id = e), 'active');
  perform t_mapi.eq('A1 aviso a la familia', (select count(*)::int from public.notifications where user_id = a04 and title = '✅ Pago confirmado' and created_at > now() - interval '1 minute'), 1);
  perform t_mapi.eq('A1 pago_operaciones canal', (select canal from public.pago_operaciones where idempotency_key = k), 'mapi_whatsapp');
  perform t_mapi.eq('A1 pago_operaciones actor', (select actor_id from public.pago_operaciones where idempotency_key = k), a02);
  perform t_mapi.eq('A1 payment_audit_logs.changed_by = actor', (select count(*)::int from public.payment_audit_logs where payment_id = p and changed_by = a02 and new_status = 'paid'), 1);
  perform t_mapi.eq('A1 audit_logs con el actor', (select count(*) > 0 from public.audit_logs where table_name = 'payments' and record_id = p::text and profile_id = a02), true);

  -- ── A6: la misma llave otra vez → resultado guardado, sin tocar nada ──
  perform t_mapi.servidor();
  r := public.aprobar_comprobante_por(a02, p, NULL, 0, k, 'mapi_whatsapp', NULL);
  perform t_mapi.dueno();
  perform t_mapi.eq('A6 ya_aplicada', (r->>'ya_aplicada')::boolean, true);
  perform t_mapi.eq('A6 un solo cambio de estado', (select count(*)::int from public.payment_audit_logs where payment_id = p and new_status = 'paid'), 1);

  -- ── A2: amarillo solo por MONTO_DIFIERE; abono = monto leído ──
  p := t_mapi.pago(145000, 'amarillo', solo_monto);
  update public.payments set ocr_amount = 100000 where id = p;
  perform t_mapi.servidor();
  r := public.aprobar_comprobante_por(a02, p, 100000, 0, gen_random_uuid(), 'mapi_app', NULL);
  perform t_mapi.dueno();
  perform t_mapi.eq('A2 queda partial', (select status from public.payments where id = p), 'partial');
  perform t_mapi.eq('A2 amount_paid = abono', (select amount_paid from public.payments where id = p), 100000::numeric);
  perform t_mapi.eq('A2 saldo pendiente', (r->>'saldo_pendiente')::numeric, t_mapi.saldo(p));
  perform t_mapi.eq('A2 aviso de abono', (select count(*)::int from public.notifications where user_id = a04 and title = '💰 Abono registrado' and created_at > now() - interval '1 minute'), 1);

  -- ── A3: abono con otro motivo amarillo ──
  p := t_mapi.pago(145000, 'amarillo', '[{"code":"MONTO_DIFIERE","level":"amarillo"},{"code":"FECHA_FUERA_VENTANA","level":"amarillo"}]');
  update public.payments set ocr_amount = 100000 where id = p;
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, 100000, 0, %L)', a02, p, gen_random_uuid()), 'abono_con_otras_dudas');
  -- abono distinto de lo que dice el comprobante
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, 90000, 0, %L)', a02, p, gen_random_uuid()), 'abono_distinto_del_comprobante');

  -- ── A7: pagado_antes viejo ──
  perform t_mapi.dueno();
  p := t_mapi.pago(80000, 'verde', '[]');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 999, %L)', a02, p, gen_random_uuid()), 'cobro_cambio');

  -- ── A4: tope de la escuela (300.000), cuenta también lo que dice el comprobante ──
  perform t_mapi.dueno();
  update public.school_settings set mapi_tope_aprobacion = 300000 where school_id = A;
  p := t_mapi.pago(300001, 'verde', '[]');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'supera_tope');
  perform t_mapi.dueno();
  p := t_mapi.pago(100000, 'verde', '[]');
  update public.payments set ocr_amount = 350000 where id = p;   -- comprobante por más: saldo a favor
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'supera_tope');
  perform t_mapi.dueno();
  p := t_mapi.pago(300000, 'verde', '[]');
  s := t_mapi.saldo(p);
  if s <= 300000 then
    perform t_mapi.servidor();
    r := public.aprobar_comprobante_por(a02, p, NULL, 0, gen_random_uuid(), 'mapi_whatsapp', NULL);
    perform t_mapi.eq('A4 justo en el tope pasa', r->>'estado', 'paid');
  end if;

  -- ── A5: el BFF solo baja el tope ──
  perform t_mapi.dueno();
  p := t_mapi.pago(250000, 'verde', '[]');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L, %L, 200000)', a02, p, gen_random_uuid(), 'mapi_app'), 'supera_tope');
  perform t_mapi.servidor();
  r := public.aprobar_comprobante_por(a02, p, NULL, 0, gen_random_uuid(), 'mapi_app', 900000);   -- sigue mandando 300.000
  perform t_mapi.eq('A5 p_tope mayor no sube el de la escuela (250.000 ≤ 300.000 pasa)', r->>'estado', 'paid');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L, %L, 0)', a02, p, gen_random_uuid(), 'mapi_app'), 'tope_invalido');
  perform t_mapi.dueno();
  update public.school_settings set mapi_tope_aprobacion = 400000 where school_id = A;

  -- ── A8: actor de otra escuela ──
  p := t_mapi.pago(90000, 'verde', '[]');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a07, p, gen_random_uuid()), 'sin_permiso');

  -- ── A10: nivel 3 por cada motivo ──
  perform t_mapi.dueno();
  -- comprobante que cubre varios cobros
  q := t_mapi.pago(90000, 'verde', '[]', 'otro', NULL, NULL, 'qa/mapi/compartido.jpg');
  p := t_mapi.pago(90000, 'verde', '[]', 'otro', NULL, NULL, 'qa/mapi/compartido.jpg');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'comprobante_cubre_varios_cobros');
  -- foto repetida / referencia repetida (si el índice único de la base lo permite)
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]');
  begin
    update public.payments set receipt_image_sha256 = (select receipt_image_sha256 from public.payments where id = q) where id = p;
    perform t_mapi.servidor();
    perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'foto_repetida');
  exception when unique_violation then
    raise notice 'ok A10 foto repetida: la base ya lo impide con un índice único (%)', sqlerrm;
  end;
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]');
  begin
    update public.payments set receipt_reference_norm = (select receipt_reference_norm from public.payments where id = q) where id = p;
    perform t_mapi.servidor();
    perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'referencia_repetida');
  exception when unique_violation then
    raise notice 'ok A10 referencia repetida: la base ya lo impide con un índice único (%)', sqlerrm;
  end;
  -- ese mes ya estaba pagado (00…f001 es agosto de 2026, pagado)
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]', 'otro', 2026, 8);
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'ese_mes_ya_estaba_pagado');
  -- monto elegido por quien paga
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]');
  update public.payments set amount_source = 'cliente' where id = p;
  if (select amount_source from public.payments where id = p) = 'cliente' then
    perform t_mapi.servidor();
    perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'monto_elegido_por_quien_paga');
  else
    raise notice 'aviso A10 amount_source: un trigger no dejó poner ''cliente'' a mano';
  end if;
  -- intento de pasarela en revisión
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]');
  update public.payments set requires_review = true where id = p;
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'intento_de_pasarela_en_revision');
  -- texto sospechoso
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[{"code":"POSIBLE_MANIPULACION","level":"amarillo"}]');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'posible_manipulacion');
  -- lectura no sellada por el servidor (Paso 4)
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'verde', '[]');
  update public.payments set receipt_image_sha256_source = 'client' where id = p;
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'lectura_no_sellada_por_el_servidor');
  -- no está en verde
  perform t_mapi.dueno();
  p := t_mapi.pago(90000, 'amarillo', solo_monto);
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'no_esta_en_verde');

  -- ── A11: la gemela desde la pantalla, abono mayor que el saldo = pago completo ──
  perform t_mapi.dueno();
  p := t_mapi.pago(70000, 'amarillo', solo_monto);
  s := t_mapi.saldo(p);
  perform t_mapi.usuario(a02);
  r := public.aprobar_comprobante(p, 999999);
  perform t_mapi.dueno();
  perform t_mapi.eq('A11 gemela: paid', (select status from public.payments where id = p), 'paid');
  perform t_mapi.eq('A11 gemela: amount_paid = lo debido', (select amount_paid from public.payments where id = p), s);
  perform t_mapi.eq('A11 gemela: approved_by = la sesión', (select approved_by from public.payments where id = p), a02);
  -- la gemela no la puede usar quien no administra
  p := t_mapi.pago(70000, 'verde', '[]');
  perform t_mapi.usuario(a04);
  perform t_mapi.falla(format('select public.aprobar_comprobante(%L)', p), 'sin_permiso');

  -- ── A9: escuela no operativa ──
  perform t_mapi.dueno();
  delete from public.school_subscriptions where school_id = A;
  update public.schools set created_at = now() - interval '3 months' where id = A;
  if not public.school_is_operational(A) then
    perform t_mapi.servidor();
    perform t_mapi.falla(format('select public.aprobar_comprobante_por(%L, %L, NULL, 0, %L)', a02, p, gen_random_uuid()), 'escuela_no_operativa');
  else
    raise notice 'aviso A9: no se pudo dejar la escuela no operativa en el gemelo';
  end if;

  -- ── A12: el núcleo exige actor = sesión ──
  perform t_mapi.dueno();
  perform set_config('request.jwt.claims', json_build_object('sub', a01, 'role', 'authenticated')::text, true);
  perform t_mapi.falla(format('select public.aprobar_comprobante_nucleo(%L, %L)', a02, p), 'actor_distinto');
end
$t$;
rollback;
