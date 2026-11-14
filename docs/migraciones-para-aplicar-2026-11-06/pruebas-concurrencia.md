# Pruebas de concurrencia CT1–CT7 — Partido en vivo F1 (respaldo manual en SQL)

Plan: `docs/plan-partido-en-vivo-f1.md` §9.2. La versión automática es `bff/test/integration/partido-vivo-concurrencia.test.ts`;
esta guía es para quien no pueda correrla y solo tenga un cliente SQL.

> **SOLO EL GEMELO LOCAL o una base descartable. NUNCA la base de producción (`luebjarufsiadojhvxgi`).**
> Hay una sola Supabase para dev, stg y prod: estas pruebas **escriben y hacen COMMIT** (partidos, eventos, informes, un flag).
> Por eso `pruebas-sesion.sql` (T1–T18, una sola transacción con rollback) sí puede correr en la viva, y esta guía **no**.
> Antes de pegar nada, en la ventana que vas a usar: `select to_regclass('qa_twin.meta') is not null as es_gemelo;` debe dar `true`.
> Si da `false` o falla, PARA.

## 0. Cómo levantar el gemelo (una vez)

El gemelo es un **volcado de la base viva**, que todavía no tiene el Partido en vivo: hay que aplicárselo **solo a él**.

```bash
npm run qa:dump-schema      # volcado de esquema de la viva (solo lectura)
npm run qa:twin:up          # Docker Desktop encendido; levanta Supabase local en 54321/54322 y carga volcado + semilla
npm run qa:twin:status      # imprime URL y cadena de conexión
# aplicar al gemelo, en este orden (nunca a la viva), uno por uno:
for f in 20261105231554 20261105231602 20261105231608 20261105231617 20261105234141 20261105234602 20261105235829; do
  npm run qa:sql -- supabase/migrations/${f}_*.sql
done
```

Notas: también hacen falta `20261105231542` (flag de Carmel) solo si quieres la rúbrica; **no** es requisito de estas pruebas.
Las migraciones se corren sobre el gemelo con el runner `qa:sql` (solo acepta localhost). Verifica con
`select pg_get_functiondef('public.start_live_match(uuid,jsonb)'::regprocedure) ilike '%pg_advisory_xact_lock%';` → `true`.

Para la versión automática (no hace falta `psql`):

```bash
cd bff
export SUPABASE_URL=http://127.0.0.1:54321
export QA_TWIN_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
npx vitest run -c vitest.integration.config.ts test/integration/partido-vivo-concurrencia.test.ts
```

## 1. Dos sesiones, sin `psql`: el truco del «sostén»

El SQL Editor/Studio no conserva un `BEGIN` entre ejecuciones. Para entrelazar dos sesiones se usa una función que hace la llamada
**y se duerme N segundos dentro de la misma transacción**, sosteniendo los bloqueos (`match_live FOR UPDATE`, etc.). Mientras la
sesión A duerme, lanzas B desde otra pestaña y miras si B espera y cómo termina. Con `psql` normal (dos terminales:
`docker exec -it supabase_db_<proyecto> psql -U postgres`) también sirve: ahí puedes usar `BEGIN … (sin COMMIT)` en vez de dormir.

### 1.1 Preparación (una vez, como `postgres`, en el gemelo)

```sql
create schema if not exists pvtest;

-- Ejecuta p_sql con la sesión de p_uid (rol authenticated), duerme p_hold s DENTRO de la transacción y
-- devuelve 'OK <resultado>' o 'ERR <sqlstate>/<hint> <mensaje>'. Una excepción deshace SOLO esa llamada.
create or replace function pvtest.run(p_uid uuid, p_sql text, p_hold numeric default 0) returns text
language plpgsql as $f$
declare v text; t0 timestamptz := clock_timestamp(); v_hint text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  set local role authenticated;
  begin
    execute p_sql into v;
    if p_hold > 0 then perform pg_sleep(p_hold); end if;
    reset role;
    return 'OK (' || round(extract(epoch from clock_timestamp() - t0)::numeric, 1) || ' s) ' || left(coalesce(v, ''), 300);
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    reset role;
    return 'ERR ' || sqlstate || '/' || coalesce(v_hint, '') || ' (' || round(extract(epoch from clock_timestamp() - t0)::numeric, 1) || ' s) ' || left(sqlerrm, 200);
  end;
end $f$;

-- Mundo: escuela A de la semilla, equipo y 16 fichas (mismos ids que el test automático) y flag encendido.
-- OWNER 00000000-0000-4000-a000-000000000001 · ADMIN ...0002 · COACH ...0003 · escuela ...b000-000000000001
insert into public.teams (id, name, sport, school_id)
values ('00000000-0000-4000-8d00-0000000000a1', 'PV concurrencia QA', 'futbol', '00000000-0000-4000-b000-000000000001')
on conflict (id) do nothing;
insert into public.children (id, full_name, date_of_birth, school_id, is_active, doc_type, doc_number, parent_phone_temp, parent_name_temp)
select ('00000000-0000-4000-8d00-0000000001' || lpad(to_hex(g), 2, '0'))::uuid, 'Jugador PV ' || lpad(g::text, 2, '0'), '2014-01-01',
       '00000000-0000-4000-b000-000000000001', true, 'TI', '97700000' || lpad(g::text, 2, '0'), '3105559999', 'Acudiente QA PV'
  from generate_series(1, 16) g on conflict (id) do nothing;
update public.school_settings set live_match_enabled = true where school_id = '00000000-0000-4000-b000-000000000001';

-- Fábrica de partidos: select pvtest.nuevo('a') crea el partido «a» (c1..c11 titulares, c12..c14 banca, dorsal = n) y lo deja en pvtest.m_a
create table if not exists pvtest.partidos (clave text primary key, match_id uuid not null);
create or replace function pvtest.nuevo(p_clave text) returns uuid language plpgsql as $f$
declare v_m uuid := gen_random_uuid(); v_l uuid; i int;
begin
  insert into public.match_results (id, school_id, team_id, opponent, match_date, status, is_home, location, kickoff_at, live_periods_count, live_period_minutes)
  values (v_m, '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-8d00-0000000000a1', 'Rival QA', current_date, 'scheduled', true, 'Cancha QA', now(), 2, 45);
  insert into public.match_lineups (school_id, team_id, source_type, source_id, created_by)
  values ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-8d00-0000000000a1', 'team_match', v_m, '00000000-0000-4000-a000-000000000002') returning id into v_l;
  for i in 1..14 loop
    insert into public.match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, jersey_number)
    values (v_l, '00000000-0000-4000-b000-000000000001', 'child', ('00000000-0000-4000-8d00-0000000001' || lpad(to_hex(i), 2, '0'))::uuid,
            case when i <= 11 then 'starter' else 'bench' end, i);
  end loop;
  insert into pvtest.partidos values (p_clave, v_m) on conflict (clave) do update set match_id = excluded.match_id;
  return v_m;
end $f$;

-- Evento JSON: pvtest.ev('sub', 1, 600, subj := n_entra, rel := n_sale). client_at = hace 2 h (evita FUTURE_EVENT).
create or replace function pvtest.ev(p_type text, p_p int, p_s int, p_subj int default null, p_rel int default null, p_cid uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('client_event_id', p_cid, 'type', p_type, 'period_no', p_p, 'period_second', p_s,
    'client_at', now() - interval '2 hours',
    'subject', case when p_subj is null then null else jsonb_build_object('type','child','id',('00000000-0000-4000-8d00-0000000001' || lpad(to_hex(p_subj),2,'0'))::uuid) end,
    'related', case when p_rel  is null then null else jsonb_build_object('type','child','id',('00000000-0000-4000-8d00-0000000001' || lpad(to_hex(p_rel), 2,'0'))::uuid) end))
$$;
create or replace function pvtest.m(p_clave text) returns uuid language sql as $$ select match_id from pvtest.partidos where clave = p_clave $$;
```

Atajo para dejar un partido listo (inicio + pitazo del 1.er tiempo), como `postgres`:

```sql
select pvtest.nuevo('a');
select pvtest.run('00000000-0000-4000-a000-000000000003', format($$select public.start_live_match(%L)$$, pvtest.m('a')));
select pvtest.run('00000000-0000-4000-a000-000000000003', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('period_start',1,0)))$$, pvtest.m('a')));
```

En todo lo que sigue: **A** y **B** son dos pestañas del SQL Editor del gemelo. Lanza A y, **sin esperar**, lanza B (tienes la ventana del `p_hold`).
`<COACH>` = `00000000-0000-4000-a000-000000000003`, `<ADMIN>` = `…0002`, `<OWNER>` = `…0001`.

## 2. Casos

### CT1 — Dos directores (reasignar mientras el director escribe)
Partido `a` listo (§1.1).
- **A** (sostén 10 s): `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('goal_against',1,100)))$$, pvtest.m('a')), 10);`
- **B** (de inmediato): `select pvtest.run('<ADMIN>', format($$select public.set_live_director(%L, %L)$$, pvtest.m('a'), '<OWNER>'), 0);`
- Esperado: **B tarda ≈ lo que le quede al sostén de A** (espera el `FOR UPDATE` de `match_live`) y termina `OK`.
- Luego: `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('goal_against',1,200)))$$, pvtest.m('a')));` → `ERR P0001/NOT_DIRECTOR`.
- Y: `select director_id, (select count(*) from match_live_events where match_id = pvtest.m('a') and type='goal_against') from match_live where match_id = pvtest.m('a');` → director = OWNER, 1 evento (el de A), todos con `created_by` = COACH.
- (Extra, inicio simultáneo) Partido nuevo `b`: **A** `select pvtest.run('<COACH>', format($$select public.start_live_match(%L)$$, pvtest.m('b')), 8);` y **B** `select pvtest.run('<ADMIN>', …start_live_match…)`. Esperado: ambos `OK`, **ningún `23505`**, 1 fila en `match_live`, 2 en `match_live_periods`.

### CT2 — Doble evento (mismo `client_event_id`)
Partido `a` listo; fija el id: `select gen_random_uuid() as cid \gset` (psql) o pega un uuid fijo, p. ej. `11111111-1111-4111-8111-111111111111`.
- **A** (sostén 8 s): `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('goal_against',1,300,p_cid => %L)))$$, pvtest.m('a'), '11111111-1111-4111-8111-111111111111'), 8);`
- **B**: la misma llamada con `0`.
- Esperado: ambos `OK`; la respuesta de A trae `applied` con 1 id; la de B trae `duplicates` con el uuid. `select count(*) from match_live_events where match_id = pvtest.m('a') and client_event_id = '1111…';` → **1**. Nunca `23505`.

### CT3 — Mismo cambio con llaves distintas / mismo id con otro contenido
Partido `a` listo.
- **A** (sostén 8 s): `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('sub',1,600,12,1)))$$, pvtest.m('a')), 8);`
- **B**: lo mismo (otro `client_event_id` automático) con sostén 0. Esperado: B `ERR P0001/NOT_ON_FIELD` (o `ALREADY_ON_FIELD`) tras esperar; `count(*)` de `sub` = 1; `select * from match_player_stints where match_id = pvtest.m('a') order by subject_id, in_second;` → c1: 0–600, c12: 600–abierto (**sin doble minuto**).
- Mismo id con otro contenido: A `…ev('sub',1,600,12,1,'22222222-2222-4222-8222-222222222222')` (sostén 8) y B `…ev('sub',1,700,13,2,'22222222-2222-4222-8222-222222222222')` → B (o A, el que llegue segundo) `ERR P0001/CLIENT_EVENT_ID_REUSED`.

### CT4 — `finish_live_match` en paralelo (y publicar vs terminar)
Partido `a` listo + lote base: `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('sub',1,600,12,1), pvtest.ev('goal',1,900,2,3), pvtest.ev('period_end',1,2700)))$$, pvtest.m('a')));`
- **A** (sostén 8 s): `select pvtest.run('<COACH>', format($$select public.finish_live_match(%L, 1, 0)$$, pvtest.m('a')), 8);`
- **B** y **C** (otras pestañas, sostén 0): la misma llamada. Esperado: las tres `OK`; B y C esperan a A.
- Conteos: `match_reports` = 1; `football_match_events` con `live_event_id is not null` = **2** (gol + asistencia); `match_live_events type='match_end'` = **1**; `match_results`: `played`, 1–0.
- Minutos (`select pvtest.run('<COACH>', format($$select public.match_live_report(%L)$$, pvtest.m('a')))` y mirar `lineup[].minutes`): c1 = 10, c12 = 35, c2 = 45; iguales en las tres respuestas.
- **Publicar vs terminar** (sin deadlock): partido `b` con el mismo lote base, y antes: `insert into match_reports (match_id, school_id, summary, development, coach_id) values (pvtest.m('b'), '00000000-0000-4000-b000-000000000001', 'Borrador', 'Desarrollo', '<COACH>');`
  **A** (sostén 8): `…finish_live_match(m,1,0)…`; **B**: `select pvtest.run('<COACH>', format($$select public.publish_match_report(%L, true)$$, pvtest.m('b')));`.
  Esperado: ambas `OK`, **ninguna `40P01`** (deadlock). Resultado: `published_at` no nulo, `summary` = 'Borrador' (no se pisa) y `match_lineup_players.minutes_played` de c1/c12/c2 = 10/35/45. Repite con el orden invertido (publicar primero, sostén 8; terminar en B).

### CT5 — Eventos fuera de orden
Tres partidos listos: `x`, `y`, `z`.
- `x`: A = `…ev('sub',1,900,12,1)…` y luego B = `…ev('sub',1,300,13,2)…` (en serie, el de 900 llega primero).
- `y`: primero el de 300, luego el de 900.
- `z`: **A** (sostén 8) = el de 900 y **B** = el de 300, a la vez.
- En los tres cierra: `…ev('period_end',1,2700)…`. Esperado: `select subject_id, in_second, out_second from match_player_stints where match_id = pvtest.m('x') order by 1,2;` es **idéntico** en `x`, `y`, `z` (c1 0–900, c12 900–2700, c2 0–300, c13 300–2700) y `match_live_report` da c1 = 15, c12 = 30, c2 = 5, c13 = 40 en los tres.

### CT6 — `save_match_roster` vs primer pitazo
Partido `a` solo con `start_live_match` (estado `not_started`, **sin** pitazo). Jugadores de la reconvocatoria (c15 titular en lugar de c11):
`'[{"subject_type":"child","subject_id":"<c1>","role":"starter","jersey_number":1}, … c10, {"…c15…","role":"starter","jersey_number":15}, {"…c11…","role":"bench","jersey_number":11}, … c12..c14 bench]'` (ids: `00000000-0000-4000-8d00-0000000001NN`, NN en hexadecimal, c15 = `0f`).
- **Orden 1, gana el pitazo**: A = `period_start` (sostén 8) y B = `save_match_roster(m, '<json>')` → B `ERR P0001/LIVE_STARTED` (la ve ya iniciada tras esperar el `FOR SHARE`); la convocatoria queda como estaba.
- **Orden 2, gana la reconvocatoria**: partido nuevo; A = `save_match_roster` (sostén 8) y B = `period_start`. Esperado: ambas `OK` y los tramos en `in_second = 0` son **los titulares nuevos** (con c15, sin c11): `select subject_id from match_player_stints where match_id = pvtest.m('b') and in_second = 0 order by 1;`
- Siempre: tramos huérfanos = 0 (`… where not exists (select 1 from match_lineup_players mlp join match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = s.match_id and mlp.subject_id = s.subject_id)`).
- **Ojo (ventana conocida a vigilar):** `save_match_roster` toma `match_live FOR SHARE` *solo* si el estado ya es `in_period/on_break/finished`; en `not_started` no bloquea a `apply_live_events`. La versión automática repite esta carrera 20 veces con conexiones reales precisamente para ver si el pitazo puede leer una convocatoria a medio reemplazar. Si falla, se reporta como hallazgo, no se «arregla» la prueba.

### CT7 — `void_live_event` vs `apply_live_events` (dependientes)
Partido listo con el cambio S1: `select pvtest.run('<COACH>', format($$select public.apply_live_events(%L, jsonb_build_array(pvtest.ev('sub',1,600,12,1,'33333333-3333-4333-8333-333333333333')))$$, pvtest.m('a')));` y su id: `select id from match_live_events where match_id = pvtest.m('a') and client_event_id = '3333…';` (= `<S1>`).
S2 = `pvtest.ev('sub',1,900,13,12)` (saca a c12, que solo está en cancha por S1).
- **Orden void→apply**: A = `select pvtest.run('<COACH>', format($$select public.void_live_event(%L, %L)$$, pvtest.m('a'), '<S1>'), 8);` y B = apply de S2. Esperado: A `OK`; B `ERR P0001/NOT_ON_FIELD`; c12 sin tramos.
- **Orden apply→void** (partido nuevo): A = apply de S1 y S2 en el mismo lote (sostén 8) y B = `void_live_event(<S1>)`. Esperado: A `OK`; B `ERR P0001/DEPENDENT_EVENTS`; c13 entra a 900 y c12 jugó 600–900.
- Nunca: ambos `OK`, ni ambos con error. Estado final: `select public._live_state_json(pvtest.m('a'))->'warnings';` **sin** `REPLAY_ERROR`.
- Independientes: void de S1 en A (sostén 8) y en B un `goal_against` → ambos `OK`, sin `DEPENDENT_EVENTS`.

## 3. Limpieza (como `postgres`, solo gemelo)

```sql
do $$ declare r record; begin
  for r in select match_id from pvtest.partidos loop
    delete from public.football_match_events where source_type = 'team_match' and source_id = r.match_id;
    delete from public.match_reports where match_id = r.match_id;
    delete from public.match_live where match_id = r.match_id;                       -- cascada: periodos, eventos, tramos
    delete from public.match_lineup_players where lineup_id in (select id from public.match_lineups where source_type='team_match' and source_id = r.match_id);
    delete from public.match_lineups where source_type = 'team_match' and source_id = r.match_id;
    delete from public.match_results where id = r.match_id;
  end loop;
end $$;
delete from public.children where id::text like '00000000-0000-4000-8d00-0000000001%';
delete from public.teams where id = '00000000-0000-4000-8d00-0000000000a1';
update public.school_settings set live_match_enabled = false where school_id = '00000000-0000-4000-b000-000000000001';
drop schema pvtest cascade;
```

## 4. Qué reporta cada caso (para pegar en la revisión)

| Caso | Pasa si |
|---|---|
| CT1 / CT1b | los lotes del director viejo salen `NOT_DIRECTOR`; eventos = aceptados, un solo escritor; 4 inicios simultáneos sin `23505` |
| CT2 | 1 fila por `client_event_id`; 1 llamada `applied`, el resto `duplicates`; sin `23505` |
| CT3 | un cambio entra, el repetido `NOT_ON_FIELD`; mismo id con otro contenido → `CLIENT_EVENT_ID_REUSED`; sin doble minuto |
| CT4 | 1 informe, 2 filas de espejo (gol+asistencia), 1 `match_end`, mismos minutos; publicar vs terminar sin `40P01` |
| CT5 | tramos y minutos idénticos en orden, inverso, en paralelo y en un solo lote desordenado |
| CT6 | `LIVE_STARTED` si gana el pitazo; titulares nuevos si gana la reconvocatoria; 0 tramos huérfanos |
| CT7 | un orden serial válido (void ok + `NOT_ON_FIELD`, o apply ok + `DEPENDENT_EVENTS`); sin `REPLAY_ERROR`; independientes ambos ok |
