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
-- M04 — register_manual_payments (núcleo + original + _por de efectivo,
-- migración 20261126101150). Casos R1–R6 del plan §9.3.
-- =============================================================================
create function t_mapi.cobro(p_monto numeric) returns uuid language plpgsql as $f$
declare v uuid := gen_random_uuid();
begin
  insert into public.payments (id, school_id, child_id, parent_id, amount, concept, due_date, status,
                               payment_type, payment_category, period_uniqueness_exempt)
  values (v, '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000001',
          '00000000-0000-4000-a000-000000000004', p_monto, 'Cobro efectivo QA ' || left(v::text, 8),
          (now() at time zone 'America/Bogota')::date, 'pending', 'one_time', 'otro', true);
  update public.payments set period_year = null, period_month = null where id = v;
  return v;
end $f$;
grant execute on all functions in schema t_mapi to public;

do $t$
declare
  A   constant uuid := '00000000-0000-4000-b000-000000000001';
  a02 constant uuid := '00000000-0000-4000-a000-000000000002';
  a04 constant uuid := '00000000-0000-4000-a000-000000000004';
  a07 constant uuid := '00000000-0000-4000-a000-000000000007';
  p uuid; q uuid; r jsonb; k uuid; n int; s numeric;
begin
  -- ── R1: la original, como la pantalla (varios cobros, efectivo) ──
  perform t_mapi.dueno();
  p := t_mapi.cobro(100000); q := t_mapi.cobro(50000);
  perform t_mapi.usuario(a02);
  r := public.register_manual_payments(A, array[p, q], 'cash', (now() at time zone 'America/Bogota')::date, 'CASH-QA1');
  perform t_mapi.eq('R1 misma respuesta: count', (r->>'count')::int, 2);
  perform t_mapi.eq('R1 misma respuesta: total', (r->>'total')::numeric, 150000::numeric);
  perform t_mapi.eq('R1 sin llaves nuevas', (select count(*)::int from jsonb_object_keys(r)), 3);
  perform t_mapi.dueno();
  perform t_mapi.eq('R1 los dos pagados', (select count(*)::int from public.payments where id in (p, q) and status = 'paid' and approved_by = a02), 2);
  -- R1 con transferencia y campos OCR del modal (compatibilidad con 20261125140410)
  p := t_mapi.cobro(80000);
  perform t_mapi.usuario(a02);
  r := public.register_manual_payments(A, array[p], 'transfer', (now() at time zone 'America/Bogota')::date, 'TRF-QA1',
         'qa/mapi/trf.jpg', jsonb_build_object('ocr_amount', 80000, 'receipt_verdict', 'verde', 'ocr_reference', 'M01234567'));
  perform t_mapi.dueno();
  perform t_mapi.eq('R1 transferencia: ocr_amount guardado', (select ocr_amount from public.payments where id = p), 80000::numeric);
  perform t_mapi.eq('R1 transferencia: veredicto guardado', (select receipt_verdict from public.payments where id = p), 'verde');
  -- R1: quien no administra sigue sin poder
  p := t_mapi.cobro(80000);
  perform t_mapi.usuario(a04);
  perform t_mapi.falla(format('select public.register_manual_payments(%L, array[%L]::uuid[], %L, current_date, %L)', A, p, 'cash', 'X'), 'sin_permiso');

  -- ── R2: abono 100.000 sobre 145.000; 46.000 se pasa; 45.000 salda ──
  perform t_mapi.dueno();
  p := t_mapi.cobro(145000); s := t_mapi.saldo(p);
  k := gen_random_uuid();
  perform t_mapi.servidor();
  r := public.register_manual_payments_por(a02, A, p, 100000, 0, k, NULL, 'mapi_whatsapp', NULL);
  perform t_mapi.eq('R2 abono', (r->>'es_abono')::boolean, true);
  perform t_mapi.eq('R2 saldo', (r->>'saldo_pendiente')::numeric, s - 100000);
  perform t_mapi.dueno();
  perform t_mapi.eq('R2 partial', (select status from public.payments where id = p), 'partial');
  perform t_mapi.eq('R2 amount_paid', (select amount_paid from public.payments where id = p), 100000::numeric);
  perform t_mapi.eq('R2 aviso de abono', (select count(*)::int from public.notifications where user_id = a04 and title = '💰 Abono registrado' and created_at > now() - interval '1 minute'), 1);
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.register_manual_payments_por(%L, %L, %L, %s, 100000, %L)', a02, A, p, s - 100000 + 1, gen_random_uuid()), 'monto_mayor_que_saldo');
  perform t_mapi.servidor();
  r := public.register_manual_payments_por(a02, A, p, s - 100000, 100000, gen_random_uuid(), NULL, 'mapi_whatsapp', NULL);
  perform t_mapi.dueno();
  perform t_mapi.eq('R2 salda: paid', (select status from public.payments where id = p), 'paid');

  -- ── R5: la misma llave → ya_aplicada, sin otro abono ──
  perform t_mapi.servidor();
  r := public.register_manual_payments_por(a02, A, p, 100000, 0, k, NULL, 'mapi_whatsapp', NULL);
  perform t_mapi.eq('R5 ya_aplicada', (r->>'ya_aplicada')::boolean, true);

  -- ── R3: por encima del tope de la escuela ──
  perform t_mapi.dueno();
  update public.school_settings set mapi_tope_aprobacion = 300000 where school_id = A;
  p := t_mapi.cobro(500000);
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.register_manual_payments_por(%L, %L, %L, 300001, 0, %L)', a02, A, p, gen_random_uuid()), 'supera_tope');

  -- ── R4: fecha futura; y escuela ajena ──
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.register_manual_payments_por(%L, %L, %L, 1000, 0, %L, %L)', a02, A, p, gen_random_uuid(), current_date + 5), 'fecha_futura');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.register_manual_payments_por(%L, %L, %L, 1000, 0, %L)', a07, A, p, gen_random_uuid()), 'sin_permiso');

  -- ── R6: efectivo, referencia, canal y actor auditados ──
  perform t_mapi.servidor();
  k := gen_random_uuid();
  r := public.register_manual_payments_por(a02, A, p, 200000, 0, k, NULL, 'mapi_app', NULL);
  perform t_mapi.dueno();
  perform t_mapi.eq('R6 método cash', (select payment_method from public.payments where id = p), 'cash');
  perform t_mapi.eq('R6 referencia CASH-MAPI-', (select reference like 'CASH-MAPI-%' from public.payments where id = p), true);
  perform t_mapi.eq('R6 approved_by = actor', (select approved_by from public.payments where id = p), a02);
  perform t_mapi.eq('R6 pago_operaciones canal', (select canal from public.pago_operaciones where idempotency_key = k), 'mapi_app');
  perform t_mapi.eq('R6 pago_operaciones actor', (select actor_id from public.pago_operaciones where idempotency_key = k), a02);
  perform t_mapi.eq('R6 pago_operaciones tipo', (select tipo from public.pago_operaciones where idempotency_key = k), 'registrar_pago');
  perform t_mapi.eq('R6 audit_logs con el actor', (select count(*) > 0 from public.audit_logs where table_name = 'payments' and record_id = p::text and profile_id = a02), true);
  perform t_mapi.eq('R6 payment_audit_logs con el actor', (select count(*)::int from public.payment_audit_logs where payment_id = p and changed_by = a02), 1);
end
$t$;
rollback;
