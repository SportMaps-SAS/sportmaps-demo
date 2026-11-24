-- Onboarding etapa 1 · T04: las consultas de embudo (docs/onboarding/embudo-*.sql)
-- dan los números esperados sobre eventos inventados. run-local.sh sustituye los
-- marcadores por el contenido real de cada archivo. Ventana de las consultas:
-- 19-nov-2026 00:00 a 23-nov-2026 00:00 (Bogotá).
create temp table _emb_u (k text primary key, id uuid not null);
insert into _emb_u select k, gen_random_uuid() from unnest(array['a1','a2','a3','a4','p1','p2','fuera','viejo']) k;

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
select id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'onb-t04-' || k || '@example.invalid', '{}', '{}', now(), now()
  from _emb_u;

-- helper: inserta un evento a una hora dada (los triggers de la tabla no interfieren)
create or replace function pg_temp.ev(p_k text, p_type text, p_data jsonb, p_at timestamptz) returns void language sql as $f$
  insert into public.analytics_events (user_id, event_type, event_data, created_at)
  select id, p_type, p_data, p_at from _emb_u where k = p_k
$f$;

-- ── Academias: 4 cuentas en ventana + 1 fuera de ventana + 1 anterior al registro ──
select pg_temp.ev(k, 'signup_completed', '{"role":"school"}', timestamptz '2026-11-20 10:00-05') from unnest(array['a1','a2','a3','a4']) k;
select pg_temp.ev('fuera', 'signup_completed', '{"role":"school"}', timestamptz '2026-11-25 10:00-05');
select pg_temp.ev('viejo', 'signup_completed', '{"role":"school"}', timestamptz '2026-11-10 10:00-05');
-- a1..a3 ven el asistente; a4 nunca entra
select pg_temp.ev(k, 'onboarding_step_viewed', '{"flow":"school","step":"model"}', timestamptz '2026-11-20 10:01-05') from unnest(array['a1','a2','a3']) k;
-- solo a1 confirma la sede
select pg_temp.ev('a1', 'onboarding_step_completed', '{"flow":"school","step":"branch"}', timestamptz '2026-11-20 10:01:30-05');
-- a1..a2 eligen modelo; a1 y a2 crean plan (a2 por trigger, sin evento de paso)
select pg_temp.ev(k, 'onboarding_step_completed', '{"flow":"school","step":"model"}', timestamptz '2026-11-20 10:02-05') from unnest(array['a1','a2']) k;
select pg_temp.ev('a1', 'onboarding_step_completed', '{"flow":"school","step":"team"}', timestamptz '2026-11-20 10:03-05');
select pg_temp.ev('a2', 'first_plan_created', '{}', timestamptz '2026-11-20 10:03-05');
-- solo a1 agrega entrenador, deportista, medio de cobro, termina, cobra y conecta WhatsApp
select pg_temp.ev('a1', 'onboarding_step_completed', '{"flow":"school","step":"coach"}', timestamptz '2026-11-20 10:04-05');
select pg_temp.ev('a1', 'first_athlete_created', '{}', timestamptz '2026-11-20 10:05-05');
select pg_temp.ev('a1', 'payment_method_configured', '{}', timestamptz '2026-11-20 10:06-05');
select pg_temp.ev('a1', 'onboarding_finished', '{"flow":"school","how":"complete"}', timestamptz '2026-11-20 10:07-05');
select pg_temp.ev('a1', 'first_charge_created', '{}', timestamptz '2026-11-21 09:00-05');
select pg_temp.ev('a1', 'whatsapp_connected', '{}', timestamptz '2026-11-21 09:30-05');
-- ruido que NO debe contar: un evento de OTRO flujo, y uno anterior al registro de a3
select pg_temp.ev('a3', 'onboarding_step_completed', '{"flow":"venue","step":"model"}', timestamptz '2026-11-20 10:02-05');
select pg_temp.ev('a3', 'first_athlete_created', '{}', timestamptz '2026-11-19 08:00-05');

create temp table emb_academias as
-- @@EMBUDO_ACADEMIAS@@

-- ── Acudientes: 2 en ventana ──
select pg_temp.ev(k, 'signup_completed', '{"role":"parent"}', timestamptz '2026-11-21 10:00-05') from unnest(array['p1','p2']) k;
select pg_temp.ev(k, 'onboarding_step_viewed', '{"flow":"parent","step":"datos"}', timestamptz '2026-11-21 10:01-05') from unnest(array['p1','p2']) k;
select pg_temp.ev('p1', 'onboarding_step_completed', '{"flow":"parent","step":"datos"}', timestamptz '2026-11-21 10:02-05');
select pg_temp.ev('p1', 'onboarding_finished', '{"flow":"parent","how":"later"}', timestamptz '2026-11-21 10:03-05');

create temp table emb_acudientes as
-- @@EMBUDO_ACUDIENTES@@

do $$
declare r record; esperado int[]; n int[];
begin
  -- Academias: 4 · 3 · 1 · 2 · 2 · 1 · 1 · 1 · 1 · 1 · 1
  esperado := array[4, 3, 1, 2, 2, 1, 1, 1, 1, 1, 1];
  select array_agg(e.n order by e.orden) into n from emb_academias e;
  if n is distinct from esperado then
    raise exception 'FALLO 1: embudo de academias % (esperado %)', n, esperado;
  end if;
  -- % del inicio y caída del paso 3 (sede): 1 de 4 = 25 %, caída (3-1)/3 = 66.7 %
  select * into r from emb_academias where orden = 3;
  if r.pct_del_inicio <> 25.0 or r.pct_caida_vs_anterior <> 66.7 then
    raise exception 'FALLO 1: porcentajes del paso 3: % / %', r.pct_del_inicio, r.pct_caida_vs_anterior;
  end if;
  -- el primer paso no tiene caída; un paso que sube respecto al anterior da caída negativa (no se oculta)
  select * into r from emb_academias where orden = 1;
  if r.pct_caida_vs_anterior is not null or r.pct_del_inicio <> 100.0 then raise exception 'FALLO 1: paso inicial mal'; end if;
  select * into r from emb_academias where orden = 4;
  if r.pct_caida_vs_anterior >= 0 then raise exception 'FALLO 1: el paso 4 sube de 1 a 2 y debía dar caída negativa'; end if;
  raise notice 'OK 1: embudo de academias (cohorte, ventana, flujo y orden temporal respetados)';

  -- Acudientes: 2 · 2 · 1 · 1
  select array_agg(e.n order by e.orden) into n from emb_acudientes e;
  if n is distinct from array[2, 2, 1, 1] then raise exception 'FALLO 2: embudo de acudientes %', n; end if;
  raise notice 'OK 2: embudo de acudientes';
end $$;
