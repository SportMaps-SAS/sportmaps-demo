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
