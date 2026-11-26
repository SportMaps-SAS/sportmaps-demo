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
-- M01 — Las 9 _por (diseño B, migración 20261126101055). Casos T2–T12 del plan §9.2.
-- =============================================================================
do $t$
declare
  A   constant uuid := '00000000-0000-4000-b000-000000000001';
  B   constant uuid := '00000000-0000-4000-b000-000000000002';
  a02 constant uuid := '00000000-0000-4000-a000-000000000002';
  a03 constant uuid := '00000000-0000-4000-a000-000000000003';
  a04 constant uuid := '00000000-0000-4000-a000-000000000004';
  a07 constant uuid := '00000000-0000-4000-a000-000000000007';
  enr constant uuid := 'b6bc2777-559f-4f18-8551-c303ef11c281';   -- Hermana Uno F3, Sub-13, activa
  f1  constant uuid := '00000000-0000-4000-c000-0000000000f1';
  f2  constant uuid := '00000000-0000-4000-c000-0000000000f2';
  team constant uuid := '1076d0e9-6fae-4dd4-803d-d9c8cabf6394';
  conv constant uuid := '5a6255c4-7cd8-4881-8f81-9121f610d20c';
  slot constant uuid := 'e72565a0-bdcd-499f-9c1e-31ebf4dc2ee8';
  mes date := date_trunc('month', (now() at time zone 'America/Bogota') + interval '1 month')::date;
  ses uuid := gen_random_uuid();
  r jsonb; v uuid; n int; t text;
begin
  -- ── Fixture (dueño) ──
  perform t_mapi.dueno();
  update public.school_settings set pause_enabled = true where school_id = A;
  insert into public.team_coaches (team_id, coach_id, school_id) values (team, '4663036e-394b-4f2a-85a5-d8651c901803', A);
  insert into public.attendance_sessions (id, school_id, team_id, session_date, finalized, finalized_at)
       values (ses, A, team, (now() at time zone 'America/Bogota')::date, true, now());
  insert into public.attendance_records (school_id, child_id, session_id, team_id, attendance_date, status)
       values (A, f1, ses, team, (now() at time zone 'America/Bogota')::date, 'present');

  -- T2: la pantalla (authenticated) no puede llamar una _por.
  perform t_mapi.usuario(a02);
  perform t_mapi.falla(format('select public.preview_enrollment_pause_por(%L, %L, %L, %L)', a02, enr, mes, mes), 'permission denied');
  -- T3: nadie llama _por_actuar_como directo.
  perform t_mapi.falla(format('select public._por_actuar_como(%L, %L, %L)', a02, A, 'admin'), 'permission denied');
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public._por_actuar_como(%L, %L, %L)', a02, A, 'admin'), 'permission denied');

  -- T8: rol service_role de Postgres pero sin claims de service_role → solo_servidor.
  perform t_mapi.servidor();
  perform set_config('request.jwt.claims', '', true);
  perform t_mapi.falla(format('select public.preview_enrollment_pause_por(%L, %L, %L, %L)', a02, enr, mes, mes), 'solo_servidor');

  -- T7: actor NULL.
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.preview_enrollment_pause_por(NULL, %L, %L, %L)', enr, mes, mes), 'actor_requerido');
  -- T6: actor de otra escuela.
  perform t_mapi.falla(format('select public.preview_enrollment_pause_por(%L, %L, %L, %L)', a07, enr, mes, mes), 'sin_permiso');
  -- T12: acudiente (la original lo dejaría; la _por es solo admin).
  perform t_mapi.falla(format('select public.preview_enrollment_pause_por(%L, %L, %L, %L)', a04, enr, mes, mes), 'sin_permiso');

  -- T4: vista previa como admin.
  perform t_mapi.servidor();
  r := public.preview_enrollment_pause_por(a02, enr, mes, mes);
  perform t_mapi.eq('T4 vista previa trae meses', jsonb_array_length(r->'meses'), 1);
  -- T5: el actor quedó fijado en la transacción.
  perform t_mapi.eq('T5 auth.uid() = actor tras la _por', auth.uid(), a02);
  perform t_mapi.eq('T5 auth.role() sigue service_role', auth.role(), 'service_role');

  -- T10: otro actor en la misma transacción → actor_distinto.
  perform t_mapi.falla(format('select public.give_kudos_por(%L, %L, %L, NULL, %L, NULL)', a03, A, f1, 'x'), 'actor_distinto');

  -- T5 (escrituras): pausa y reactivación con el actor anotado.
  r := public.pause_enrollment_directly_por(a02, enr, 'vacation', mes, mes, 'QA mapi_por');
  perform t_mapi.dueno();
  select requested_by into v from public.enrollment_pause_requests where enrollment_id = enr order by created_at desc limit 1;
  perform t_mapi.eq('T5 requested_by = actor', v, a02);
  select paused_by into v from public.enrollments where id = enr;
  perform t_mapi.eq('T5 paused_by = actor', v, a02);
  perform t_mapi.servidor();
  r := public.resume_enrollment_por(a02, enr, 'QA vuelve');
  perform t_mapi.dueno();
  select resumed_by into v from public.enrollment_pause_requests where enrollment_id = enr order by created_at desc limit 1;
  perform t_mapi.eq('T5 resumed_by = actor', v, a02);

  -- Felicitar (staff: coach de su equipo).
  perform t_mapi.servidor();
  v := public.give_kudos_por(a03, A, f1, NULL, 'Gran entreno QA', NULL);
  perform t_mapi.dueno();
  select coach_id into v from public.athlete_kudos where id = v;
  perform t_mapi.eq('kudos coach_id = actor', v, a03);
  select count(*) into n from public.notifications where category = 'kudos' and user_id = a03 and created_at > now() - interval '1 minute';
  perform t_mapi.eq('kudos no le avisa al actor', n, 0);

  -- Evaluar el entreno (el coach del equipo).
  perform t_mapi.servidor();
  r := public.submit_post_training_coach_rating_por(a03, ses, jsonb_build_array(jsonb_build_object('child_id', f1, 'effort_pct', 90)), NULL);
  perform t_mapi.dueno();
  select recorded_by into v from public.performance_entries where context_id = ses and metric_key = 'coach_effort_rating';
  perform t_mapi.eq('rating recorded_by = actor', v, a03);

  -- T11: listar prospectos es solo admin; la semana sí la ve el coach, sin montos.
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.listar_clase_prueba_por(%L, %L)', a03, A), 'sin_permiso');
  perform t_mapi.servidor();
  r := public.clases_prueba_semana_por(a03, A, (now() at time zone 'America/Bogota')::date, (now() at time zone 'America/Bogota')::date + 30);
  select count(*) into n from jsonb_array_elements(r) e where e->'pago' ? 'monto';
  perform t_mapi.eq('T11 coach sin montos', n, 0);
  perform t_mapi.servidor();
  r := public.listar_clase_prueba_por(a02, A);
  perform t_mapi.eq('T11 admin lista prospectos', jsonb_typeof(r), 'array');

  -- Agendar desde el chat (admin), sin parámetros de plata.
  perform t_mapi.servidor();
  r := public.agendar_clase_prueba_desde_chat_por(a02, conv, slot, 'Prospecto QA mapi', NULL, NULL, NULL);
  perform t_mapi.dueno();
  select source_detail->>'agendada_por' into t from public.school_signup_leads where id = (r->>'lead_id')::uuid;
  perform t_mapi.eq('agendada_por = actor', t, a02::text);
  select count(*) into n from public.audit_logs where table_name = 'school_signup_leads' and record_id = r->>'lead_id' and profile_id = a02;
  if n = 0 then raise exception 'FALLO: audit_logs de school_signup_leads sin el actor'; end if;
  raise notice 'ok audit_logs del prospecto con el actor (% filas)', n;
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.agendar_clase_prueba_desde_chat_por(%L, %L, %L, %L)', a07, conv, slot, 'x'), 'sin_permiso');

  -- T9: baja con el actor en audit_logs y payment_audit_logs; escuela ajena → sin_permiso.
  perform t_mapi.servidor();
  perform t_mapi.falla(format('select public.set_school_athlete_status_por(%L, %L, %L, %L, false)', a02, B, 'child', f2), 'sin_permiso');
  perform t_mapi.servidor();
  r := public.set_school_athlete_status_por(a02, A, 'child', f2, false);
  perform t_mapi.dueno();
  -- Los anula la baja o, antes, trg_cancel_payments_on_enrollment_cancel al cancelar la inscripción.
  select count(*) into n from public.payments where id in ('f3000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000012') and status = 'cancelled';
  perform t_mapi.eq('T9 cobros pendientes anulados', n, 2);
  select count(*) into n from public.audit_logs where table_name = 'payments' and profile_id = a02
     and record_id in ('f3000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000012');
  if n < 2 then raise exception 'FALLO T9: audit_logs con el actor = %', n; end if;
  select count(*) into n from public.payment_audit_logs where changed_by = a02 and new_status = 'cancelled'
     and payment_id in ('f3000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000012');
  perform t_mapi.eq('T9 payment_audit_logs.changed_by = actor', n, 2);
end
$t$;
rollback;
