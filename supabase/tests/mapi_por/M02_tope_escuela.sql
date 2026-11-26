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
-- M02 — Tope de Mapi por escuela (school_settings.mapi_tope_aprobacion + guarda,
-- migración 20261126101150). Casos G1–G7 del plan §9.3.
-- =============================================================================
do $t$
declare
  A   constant uuid := '00000000-0000-4000-b000-000000000001';
  a02 constant uuid := '00000000-0000-4000-a000-000000000002';
  a03 constant uuid := '00000000-0000-4000-a000-000000000003';
  n int; v int;
begin
  perform t_mapi.dueno();
  select mapi_tope_aprobacion into v from public.school_settings where school_id = A;
  perform t_mapi.eq('default 400.000', v, 400000);

  -- G1: la administración de la escuela, desde la app.
  perform t_mapi.usuario(a02);
  update public.school_settings set mapi_tope_aprobacion = 300000 where school_id = A;
  get diagnostics n = row_count;
  perform t_mapi.eq('G1 admin cambia el tope (filas)', n, 1);
  perform t_mapi.dueno();
  select count(*) into n from public.audit_logs
   where table_name = 'school_settings' and record_id = A::text and profile_id = a02
     and (old_data->>'mapi_tope_aprobacion')::int = 400000 and (new_data->>'mapi_tope_aprobacion')::int = 300000;
  perform t_mapi.eq('G1 audit_logs con OLD/NEW y el admin', n, 1);

  -- G2: el coach no puede (RLS: 0 filas) y sin RLS lo para la guarda.
  perform t_mapi.usuario(a03);
  update public.school_settings set mapi_tope_aprobacion = 900000 where school_id = A;
  get diagnostics n = row_count;
  perform t_mapi.eq('G2 coach: 0 filas por RLS', n, 0);
  perform t_mapi.dueno();
  perform set_config('request.jwt.claims', json_build_object('sub', a03, 'role', 'authenticated')::text, true);
  perform t_mapi.falla(format('update public.school_settings set mapi_tope_aprobacion = 900000 where school_id = %L', A), 'tope_bloqueado');

  -- G3: el servidor (BFF / Mapi) no lo cambia.
  perform t_mapi.servidor();
  perform t_mapi.falla(format('update public.school_settings set mapi_tope_aprobacion = 900000 where school_id = %L', A), 'tope_bloqueado');

  -- G5: guardar otro ajuste con el mismo tope pasa (también como servidor).
  perform t_mapi.usuario(a02);
  update public.school_settings set pause_enabled = pause_enabled, mapi_tope_aprobacion = mapi_tope_aprobacion where school_id = A;
  get diagnostics n = row_count;
  perform t_mapi.eq('G5 admin guarda la fila con el mismo tope', n, 1);
  perform t_mapi.servidor();
  update public.school_settings set pause_enabled = pause_enabled, mapi_tope_aprobacion = 300000 where school_id = A;
  get diagnostics n = row_count;
  perform t_mapi.eq('G5 servidor guarda la fila con el mismo tope', n, 1);

  -- G6: sin claims (SQL editor de soporte) pasa.
  perform t_mapi.dueno();
  update public.school_settings set mapi_tope_aprobacion = 500000 where school_id = A;
  select mapi_tope_aprobacion into v from public.school_settings where school_id = A;
  perform t_mapi.eq('G6 soporte sin claims', v, 500000);

  -- G7: el CHECK.
  perform t_mapi.falla(format('update public.school_settings set mapi_tope_aprobacion = 0 where school_id = %L', A), 'school_settings_mapi_tope_aprobacion_check');

  -- G4: una fila nueva creada por el servidor nace en 400.000 aunque pida otro valor.
  delete from public.school_settings where school_id = A;
  perform t_mapi.servidor();
  insert into public.school_settings (school_id, mapi_tope_aprobacion) values (A, 900000);
  perform t_mapi.dueno();
  select mapi_tope_aprobacion into v from public.school_settings where school_id = A;
  perform t_mapi.eq('G4 INSERT del servidor nace en 400.000', v, 400000);
end
$t$;
rollback;
