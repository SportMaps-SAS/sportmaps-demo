-- =============================================================================
-- PRUEBAS DE SESIÓN — Partido en vivo F1 (T1–T18 y T-minutos [requiere la 07], T-agenda [requiere la 08]; T19 está en verificacion.sql)
-- Plan: docs/plan-partido-en-vivo-f1.md §9.1.   Correr DESPUÉS de aplicar 01..05.
--
-- TODO SE DESHACE. El archivo es UNA transacción explícita (BEGIN) que termina con
-- un DO que lanza una excepción a propósito con el reporte + un ROLLBACK de respaldo.
-- Nada queda en la base: ni el flag que se prende dentro de la transacción, ni los
-- partidos ni los eventos de prueba.
--
-- CÓMO CORRERLO
--   · SQL Editor: pegar TODO el archivo y ejecutar. El resultado es un ERROR con el
--     reporte en el mensaje (esa es la forma de ver las filas sin guardar nada).
--   · O: npx supabase db query --linked -f docs/migraciones-para-aplicar-2026-11-06/pruebas-sesion.sql
--   Si el cliente corta la transacción a la mitad, NO pegues un COMMIT.
--   Una sola sesión, sin otras escrituras en paralelo (toma bloqueos de fila cortos).
--
-- QUÉ ASUME (sale de la base, sin placeholders): Carmel tiene 1 owner, >=2 coaches,
--   >=15 children y >=1 team; existen padres y coaches de otras escuelas. El
--   platform admin sale de public.platform_admins (si no hay, esas pruebas se saltan).
-- Las pruebas simulan sesión con request.jwt.claims + SET LOCAL ROLE (authenticated/anon).
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _res (n serial, test text, ok boolean, detalle text);
CREATE TEMP TABLE _calls (name text, sql text);
INSERT INTO _calls VALUES
  ('01 start_live_match',   $$select public.start_live_match('{m}')$$),
  ('02 apply_live_events',  $$select public.apply_live_events('{m}', '[]'::jsonb)$$),
  ('03 match_live_report',  $$select public.match_live_report('{m}')$$),
  ('04 finish_live_match',  $$select public.finish_live_match('{m}', 0, 0)$$),
  ('05 reopen_live_match',  $$select public.reopen_live_match('{m}')$$),
  ('06 void_live_event',    $$select public.void_live_event('{m}', gen_random_uuid())$$),
  ('07 set_live_director',  $$select public.set_live_director('{m}', gen_random_uuid())$$),
  ('08 add_live_callup',    $$select public.add_live_callup('{m}', 'child', '{c15}', 15, gen_random_uuid())$$),
  ('09 set_live_jersey',    $$select public.set_live_jersey('{m}', 'child', '{c1}', 5)$$);

-- ---------------------------------------------------------------------------
-- Ayudantes temporales (viven solo en esta sesión)
-- ---------------------------------------------------------------------------
-- Ejecuta p_sql con la sesión de p_uid y rol p_role; compara con p_expect:
--   'OK' (sin error) | SQLSTATE (ej. 42501) | HINT (ej. LIVE_DISABLED) | 'VAL:<texto>' (resultado escalar)
CREATE FUNCTION pg_temp.try(p_label text, p_role text, p_uid text, p_sql text, p_expect text)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_state text := 'OK'; v_hint text := ''; v_msg text := ''; v_val text := NULL; v_ok boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  EXECUTE format('set local role %I', p_role);
  BEGIN
    IF p_expect LIKE 'VAL:%' THEN EXECUTE p_sql INTO v_val; ELSE EXECUTE p_sql; END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  EXECUTE 'reset role';
  PERFORM set_config('request.jwt.claims', '', true);
  v_ok := CASE
            WHEN p_expect = 'OK'          THEN v_state = 'OK'
            WHEN p_expect LIKE 'VAL:%'    THEN v_state = 'OK' AND v_val IS NOT DISTINCT FROM substr(p_expect, 5)
            ELSE v_state = p_expect OR coalesce(v_hint, '') = p_expect END;
  INSERT INTO _res (test, ok, detalle)
  VALUES (p_label, v_ok, 'esperaba ' || p_expect || ' | obtuvo ' || v_state || ' | ' || coalesce(v_hint, '')
                         || ' | ' || coalesce(v_val, '') || ' | ' || left(v_msg, 160));
END $f$;

-- Verifica una condición booleana (como postgres), opcionalmente con la sesión de p_uid.
CREATE FUNCTION pg_temp.ck(p_label text, p_sql text, p_uid text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_ok boolean; v_err text := '';
BEGIN
  IF p_uid IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  END IF;
  BEGIN
    EXECUTE p_sql INTO v_ok;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_err := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO _res (test, ok, detalle) VALUES (p_label, coalesce(v_ok, false), left(p_sql, 150) || ' ' || v_err);
END $f$;

CREATE FUNCTION pg_temp.c(n int) RETURNS uuid LANGUAGE sql AS $$ select current_setting('t.c' || n)::uuid $$;
CREATE FUNCTION pg_temp.m(k text) RETURNS uuid LANGUAGE sql AS $$ select current_setting('t.m_' || k)::uuid $$;

-- Crea un partido de Carmel con convocatoria: 11 titulares (c1..c11, dorsales 1..11) y 3 en banca (c12..c14).
CREATE FUNCTION pg_temp.nm(p_key text, p_jerseys boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_m uuid := gen_random_uuid(); v_l uuid; i int;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
  INSERT INTO public.match_results (id, school_id, team_id, opponent, match_date, status, is_home, location, kickoff_at,
                                    live_periods_count, live_period_minutes)
  VALUES (v_m, current_setting('t.carmel')::uuid, current_setting('t.team')::uuid, 'Rival QA', current_date,
          'scheduled', true, 'Cancha QA', now(), 2, 45);
  INSERT INTO public.match_lineups (school_id, team_id, source_type, source_id, created_by)
  VALUES (current_setting('t.carmel')::uuid, current_setting('t.team')::uuid, 'team_match', v_m, current_setting('t.admin')::uuid)
  RETURNING id INTO v_l;
  FOR i IN 1..14 LOOP
    INSERT INTO public.match_lineup_players (lineup_id, school_id, subject_type, subject_id, role, jersey_number)
    VALUES (v_l, current_setting('t.carmel')::uuid, 'child', pg_temp.c(i),
            CASE WHEN i <= 11 THEN 'starter' ELSE 'bench' END, CASE WHEN p_jerseys THEN i ELSE NULL END);
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('t.m_' || p_key, v_m::text, true);
  RETURN v_m;
END $f$;

-- Llama una RPC como p_uid sobre el partido p_key: {m} y {c1}..{c15} se reemplazan.
CREATE FUNCTION pg_temp.rpc(p_label text, p_uid text, p_key text, p_sql text, p_expect text, p_role text DEFAULT 'authenticated')
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE s text := replace(p_sql, '{m}', pg_temp.m(p_key)::text); i int;
BEGIN
  FOR i IN REVERSE 15..1 LOOP s := replace(s, '{c' || i || '}', pg_temp.c(i)::text); END LOOP;
  PERFORM pg_temp.try(p_label, p_role, p_uid, s, p_expect);
END $f$;

CREATE FUNCTION pg_temp.ev(p_type text, p_p int, p_s int, p_subj uuid DEFAULT NULL, p_rel uuid DEFAULT NULL,
                           p_brk boolean DEFAULT false, p_cid uuid DEFAULT gen_random_uuid(), p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  select jsonb_strip_nulls(jsonb_build_object(
    'client_event_id', p_cid, 'type', p_type, 'period_no', p_p, 'period_second', p_s,
    'in_break', p_brk, 'client_at', now() - interval '2 hours', 'payload', p_payload,
    'subject', case when p_subj is null then null else jsonb_build_object('type', 'child', 'id', p_subj) end,
    'related', case when p_rel  is null then null else jsonb_build_object('type', 'child', 'id', p_rel)  end))
$$;

CREATE FUNCTION pg_temp.ap(p_label text, p_uid text, p_key text, p_events jsonb, p_expect text)
RETURNS void LANGUAGE sql AS $$
  select pg_temp.try(p_label, 'authenticated', p_uid,
                     format('select public.apply_live_events(%L, %L::jsonb)', pg_temp.m(p_key), p_events::text), p_expect)
$$;

-- ---------------------------------------------------------------------------
-- 0. Personajes, flag (solo dentro de la transacción) y datos base
-- ---------------------------------------------------------------------------
SELECT set_config('t.carmel', '374a6716-af42-4745-afe1-8d089153e01b', true);
SELECT set_config('t.team', (SELECT id::text FROM public.teams WHERE school_id = current_setting('t.carmel')::uuid ORDER BY id LIMIT 1), true);
SELECT set_config('t.admin', (SELECT coalesce(
        (SELECT profile_id::text FROM public.school_members WHERE school_id = current_setting('t.carmel')::uuid
            AND status = 'active' AND role IN ('owner','admin','school_admin') ORDER BY profile_id LIMIT 1),
        (SELECT owner_id::text FROM public.schools WHERE id = current_setting('t.carmel')::uuid))), true);
SELECT set_config('t.coach', (SELECT profile_id::text FROM public.school_members WHERE school_id = current_setting('t.carmel')::uuid
        AND status = 'active' AND role = 'coach' ORDER BY profile_id LIMIT 1), true);
SELECT set_config('t.coach_b', (SELECT profile_id::text FROM public.school_members WHERE school_id = current_setting('t.carmel')::uuid
        AND status = 'active' AND role = 'coach' AND profile_id::text <> current_setting('t.coach') ORDER BY profile_id LIMIT 1), true);
SELECT set_config('t.parent', (SELECT profile_id::text FROM public.school_members sm WHERE sm.role = 'parent' AND sm.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM public.school_members x WHERE x.profile_id = sm.profile_id AND x.school_id = current_setting('t.carmel')::uuid
                          AND x.role NOT IN ('parent','athlete'))
        ORDER BY profile_id LIMIT 1), true);
SELECT set_config('t.coach2', (SELECT profile_id::text FROM public.school_members sm WHERE sm.school_id <> current_setting('t.carmel')::uuid
        AND sm.status = 'active' AND sm.role = 'coach'
        AND NOT EXISTS (SELECT 1 FROM public.school_members x WHERE x.profile_id = sm.profile_id AND x.school_id = current_setting('t.carmel')::uuid)
        ORDER BY profile_id LIMIT 1), true);
SELECT set_config('t.school2', (SELECT school_id::text FROM public.school_members WHERE profile_id::text = current_setting('t.coach2')
        AND status = 'active' LIMIT 1), true);
SELECT set_config('t.admin2', (SELECT profile_id::text FROM public.school_members WHERE school_id = current_setting('t.school2')::uuid
        AND status = 'active' AND role IN ('owner','admin','school_admin') ORDER BY profile_id LIMIT 1), true);
SELECT set_config('t.pa', coalesce((SELECT profile_id::text FROM public.platform_admins WHERE is_active LIMIT 1), ''), true);
SELECT set_config('t.c' || o, id::text, true)
  FROM (SELECT id, row_number() OVER (ORDER BY id) o
          FROM (SELECT id FROM public.children WHERE school_id = current_setting('t.carmel')::uuid ORDER BY id LIMIT 15) z) y;

SELECT pg_temp.ck('00 personajes y datos base',
  $$select current_setting('t.team') <> '' and current_setting('t.admin') <> '' and current_setting('t.coach') <> ''
           and current_setting('t.coach_b') <> '' and current_setting('t.parent') <> '' and current_setting('t.coach2') <> ''
           and current_setting('t.admin2') <> '' and current_setting('t.c15') <> ''$$);

-- El flag se prende SOLO dentro de esta transacción (se deshace con el ROLLBACK).
UPDATE public.school_settings SET live_match_enabled = true WHERE school_id = current_setting('t.carmel')::uuid;
SELECT pg_temp.ck('00b flag de Carmel prendido (dentro de la tx)',
  $$select live_match_enabled from public.school_settings where school_id = current_setting('t.carmel')::uuid$$);

-- ---------------------------------------------------------------------------
-- T1  Padre: 42501 en las 9 RPC; las 4 tablas no le devuelven filas
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T1');
SELECT pg_temp.rpc('T1 coach inicia (control)', current_setting('t.coach'), 'T1', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.rpc('T1 padre ' || name, current_setting('t.parent'), 'T1', sql, '42501') FROM _calls ORDER BY name;
SELECT pg_temp.try('T1 padre ve 0 filas en ' || t, 'authenticated', current_setting('t.parent'),
                   format('select count(*)::text from public.%I', t), 'VAL:0')
  FROM unnest(ARRAY['match_live','match_live_periods','match_live_events','match_player_stints']) t;
SELECT pg_temp.try('T1 coach de Carmel SÍ ve match_live (control)', 'authenticated', current_setting('t.coach'),
                   $$select (count(*) >= 1)::text from public.match_live$$, 'VAL:true');

-- ---------------------------------------------------------------------------
-- T1b  anon: sin EXECUTE (42501) y sin SELECT en las tablas
-- ---------------------------------------------------------------------------
SELECT pg_temp.rpc('T1b anon ' || name, '', 'T1', sql, '42501', 'anon') FROM _calls ORDER BY name;
SELECT pg_temp.try('T1b anon sin SELECT en ' || t, 'anon', '', format('select count(*) from public.%I', t), '42501')
  FROM unnest(ARRAY['match_live','match_live_periods','match_live_events','match_player_stints']) t;

-- ---------------------------------------------------------------------------
-- T2  Coach y admin de OTRA escuela sobre un partido de Carmel: 42501
-- ---------------------------------------------------------------------------
SELECT pg_temp.rpc('T2 coach ajeno ' || name, current_setting('t.coach2'), 'T1', sql, '42501') FROM _calls ORDER BY name;
SELECT pg_temp.rpc('T2 admin ajeno ' || name, current_setting('t.admin2'), 'T1', sql, '42501') FROM _calls ORDER BY name;

-- ---------------------------------------------------------------------------
-- T3  Flag apagado: LIVE_DISABLED (también para el platform admin)
-- ---------------------------------------------------------------------------
INSERT INTO public.match_results (id, school_id, opponent, match_date)
VALUES ('c3000000-0000-0000-0000-000000000001', current_setting('t.school2')::uuid, 'Rival sin flag', current_date);
SELECT set_config('t.m_T3b', 'c3000000-0000-0000-0000-000000000001', true);
SELECT pg_temp.rpc('T3 coach de escuela sin flag ' || name, current_setting('t.coach2'), 'T3b', sql, 'LIVE_DISABLED') FROM _calls ORDER BY name;
SELECT pg_temp.rpc('T3 platform admin, escuela sin flag: start', current_setting('t.pa'), 'T3b',
                   $$select public.start_live_match('{m}')$$, 'LIVE_DISABLED')
  WHERE current_setting('t.pa') <> '';
UPDATE public.school_settings SET live_match_enabled = false WHERE school_id = current_setting('t.carmel')::uuid;
SELECT pg_temp.rpc('T3 Carmel con flag apagado: start', current_setting('t.coach'), 'T1', $$select public.start_live_match('{m}')$$, 'LIVE_DISABLED');
SELECT pg_temp.rpc('T3 Carmel con flag apagado: report', current_setting('t.admin'), 'T1', $$select public.match_live_report('{m}')$$, 'LIVE_DISABLED');
UPDATE public.school_settings SET live_match_enabled = true WHERE school_id = current_setting('t.carmel')::uuid;

-- ---------------------------------------------------------------------------
-- T3b  Escritura directa a las 4 tablas: denegada (sin grant ni policy)
-- ---------------------------------------------------------------------------
SELECT pg_temp.rpc('T3b coach INSERT match_live', current_setting('t.coach'), 'T1',
  $$insert into public.match_live (match_id, school_id, periods_planned) values (gen_random_uuid(), current_setting('t.carmel')::uuid, 2)$$, '42501');
SELECT pg_temp.rpc('T3b coach UPDATE match_live', current_setting('t.coach'), 'T1', $$update public.match_live set status = 'finished'$$, '42501');
SELECT pg_temp.rpc('T3b coach DELETE match_live', current_setting('t.coach'), 'T1', $$delete from public.match_live$$, '42501');
SELECT pg_temp.rpc('T3b coach UPDATE match_live_events', current_setting('t.coach'), 'T1', $$update public.match_live_events set voided_at = now()$$, '42501');
SELECT pg_temp.rpc('T3b coach DELETE match_live_events', current_setting('t.coach'), 'T1', $$delete from public.match_live_events$$, '42501');
SELECT pg_temp.rpc('T3b coach INSERT match_player_stints', current_setting('t.coach'), 'T1',
  $$insert into public.match_player_stints (match_id, school_id, subject_type, subject_id, period_no, in_second) values ('{m}', current_setting('t.carmel')::uuid, 'child', '{c1}', 1, 0)$$, '42501');
SELECT pg_temp.rpc('T3b coach DELETE match_live_periods', current_setting('t.coach'), 'T1', $$delete from public.match_live_periods$$, '42501');

-- ---------------------------------------------------------------------------
-- T4 / T4b  Idempotencia por client_event_id
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T4');
SELECT pg_temp.rpc('T4 inicia', current_setting('t.coach'), 'T4', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T4 pitazo inicial', current_setting('t.coach'), 'T4',
  jsonb_build_array(pg_temp.ev('period_start', 1, 0, p_cid => 'a4000000-0000-0000-0000-000000000001')), 'OK');
SELECT pg_temp.ap('T4 mismo client_event_id otra vez (no es error)', current_setting('t.coach'), 'T4',
  jsonb_build_array(pg_temp.ev('period_start', 1, 0, p_cid => 'a4000000-0000-0000-0000-000000000001')), 'OK');
SELECT pg_temp.ck('T4 queda UNA sola fila',
  format($$select count(*) = 1 from public.match_live_events where match_id = %L and client_event_id = 'a4000000-0000-0000-0000-000000000001'$$, pg_temp.m('T4')));
SELECT pg_temp.ap('T4b mismo client_event_id con otro type', current_setting('t.coach'), 'T4',
  jsonb_build_array(pg_temp.ev('period_end', 1, 100, p_cid => 'a4000000-0000-0000-0000-000000000001')), 'CLIENT_EVENT_ID_REUSED');

-- ---------------------------------------------------------------------------
-- T5  Lote con un evento inválido: no se aplica NINGUNO (ni el válido)
-- ---------------------------------------------------------------------------
-- (T5 usa el partido de T4: ya tiene el pitazo inicial)
SELECT pg_temp.ap('T5 lote atómico', current_setting('t.coach'), 'T4',
  jsonb_build_array(pg_temp.ev('sub', 1, 600, pg_temp.c(12), pg_temp.c(11)),
                    pg_temp.ev('sub', 1, 650, pg_temp.c(14), pg_temp.c(13))), 'NOT_ON_FIELD');
SELECT pg_temp.ck('T5 siguen 1 evento (solo el pitazo), el válido tampoco entró',
  format($$select count(*) = 1 from public.match_live_events where match_id = %L$$, pg_temp.m('T4')));

-- ---------------------------------------------------------------------------
-- T6  Reingresos sin tope: sale, entra otro, vuelve, sale otra vez
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T6');
SELECT pg_temp.rpc('T6 inicia', current_setting('t.coach'), 'T6', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T6 secuencia de cambios', current_setting('t.coach'), 'T6', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0),
  pg_temp.ev('sub', 1, 600,  pg_temp.c(12), pg_temp.c(11)),
  pg_temp.ev('sub', 1, 1200, pg_temp.c(11), pg_temp.c(12)),
  pg_temp.ev('sub', 1, 2000, pg_temp.c(13), pg_temp.c(11)),
  pg_temp.ev('period_end', 1, 2700)), 'OK');
SELECT pg_temp.ck('T6 c11 tiene 2 tramos que suman 1400 s',
  format($$select count(*) = 2 and sum(out_second - in_second) = 1400 from public.match_player_stints
            where match_id = %L and subject_id = %L$$, pg_temp.m('T6'), pg_temp.c(11)));
SELECT pg_temp.ck('T6 c12 600 s y c13 700 s',
  format($$select (select sum(out_second - in_second) from public.match_player_stints where match_id = %L and subject_id = %L) = 600
              and (select sum(out_second - in_second) from public.match_player_stints where match_id = %L and subject_id = %L) = 700$$,
         pg_temp.m('T6'), pg_temp.c(12), pg_temp.m('T6'), pg_temp.c(13)));
SELECT pg_temp.ck('T6 (D-P1) el staff ve minutos en vivo por match_live_report: c11 = 23 min',
  format($$select (select (x->>'minutes')::int from jsonb_array_elements(public.match_live_report(%L)->'lineup') x where x->>'subject_id' = %L) = 23$$,
         pg_temp.m('T6'), pg_temp.c(11)), current_setting('t.coach'));

-- ---------------------------------------------------------------------------
-- T7  Roja: cierra el tramo; el reingreso falla SENT_OFF
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T7');
SELECT pg_temp.rpc('T7 inicia', current_setting('t.coach'), 'T7', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T7 pitazo + roja a c1 en 900', current_setting('t.coach'), 'T7',
  jsonb_build_array(pg_temp.ev('period_start', 1, 0), pg_temp.ev('red', 1, 900, pg_temp.c(1))), 'OK');
SELECT pg_temp.ck('T7 tramo de c1 cerrado por roja',
  format($$select count(*) = 1 and bool_and(ended_by = 'red' and out_second = 900) from public.match_player_stints where match_id = %L and subject_id = %L$$,
         pg_temp.m('T7'), pg_temp.c(1)));
SELECT pg_temp.ap('T7 reingreso del expulsado', current_setting('t.coach'), 'T7',
  jsonb_build_array(pg_temp.ev('sub', 1, 1000, pg_temp.c(1), pg_temp.c(2))), 'SENT_OFF');

-- ---------------------------------------------------------------------------
-- T8  Cambio en el descanso: el tramo de quien entra nace en in_second = 0 del tiempo 2
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T8');
SELECT pg_temp.rpc('T8 inicia', current_setting('t.coach'), 'T8', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T8 tiempo 1, descanso con cambio, tiempo 2', current_setting('t.coach'), 'T8', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0),
  pg_temp.ev('period_end', 1, 2700),
  pg_temp.ev('sub', 2, 0, pg_temp.c(12), pg_temp.c(11), p_brk => true),
  pg_temp.ev('period_start', 2, 0)), 'OK');
SELECT pg_temp.ck('T8 c12 entra en in_second=0 del tiempo 2',
  format($$select count(*) = 1 and bool_and(period_no = 2 and in_second = 0) from public.match_player_stints where match_id = %L and subject_id = %L$$,
         pg_temp.m('T8'), pg_temp.c(12)));
SELECT pg_temp.ck('T8 c11 cerrado por period_end en el tiempo 1 y sin tramo en el 2',
  format($$select count(*) = 1 and bool_and(period_no = 1 and ended_by = 'period_end' and out_second = 2700) from public.match_player_stints where match_id = %L and subject_id = %L$$,
         pg_temp.m('T8'), pg_temp.c(11)));

-- ---------------------------------------------------------------------------
-- T9 / T9b  finish dos veces + (D-P1) minutos al acudiente SOLO al publicar
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T9');
SELECT pg_temp.rpc('T9 inicia', current_setting('t.coach'), 'T9', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T9 partido completo: gol de c9 con asistencia de c8, 2 tiempos', current_setting('t.coach'), 'T9', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0),
  pg_temp.ev('goal', 1, 500, pg_temp.c(9), pg_temp.c(8)),
  pg_temp.ev('period_end', 1, 2700),
  pg_temp.ev('period_start', 2, 0),
  pg_temp.ev('period_end', 2, 2700)), 'OK');
SELECT pg_temp.rpc('T9 finish #1 (1-0)', current_setting('t.coach'), 'T9', $$select public.finish_live_match('{m}', 1, 0)$$, 'OK');
SELECT pg_temp.rpc('T9 finish #2 (idempotente)', current_setting('t.coach'), 'T9', $$select public.finish_live_match('{m}', 1, 0)$$, 'OK');
SELECT pg_temp.ck('T9 1 solo informe',   format($$select count(*) = 1 from public.match_reports where match_id = %L$$, pg_temp.m('T9')));
SELECT pg_temp.ck('T9 espejo sin duplicados (gol + asistencia = 2 filas con live_event_id)',
  format($$select count(*) = 2 from public.football_match_events where source_type = 'team_match' and source_id = %L and live_event_id is not null$$, pg_temp.m('T9')));
SELECT pg_temp.ck('T9 marcador y estado',
  format($$select home_score = 1 and away_score = 0 and status = 'played' from public.match_results where id = %L$$, pg_temp.m('T9')));
SELECT pg_temp.ck('T9 el informe NO se publicó solo',
  format($$select published_at is null from public.match_reports where match_id = %L$$, pg_temp.m('T9')));
SELECT pg_temp.ck('T9b (D-P1) al terminar minutes_played sigue NULL para el acudiente',
  format($$select count(*) = 0 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id
            where ml.source_id = %L and mlp.minutes_played is not null$$, pg_temp.m('T9')));
SELECT pg_temp.ck('T9b pero el staff ya ve 90 min / 100 % de c1 por match_live_report',
  format($$select (select (x->>'minutes')::int = 90 and (x->>'pct')::numeric = 100 from jsonb_array_elements(public.match_live_report(%L)->'lineup') x where x->>'subject_id' = %L)$$,
         pg_temp.m('T9'), pg_temp.c(1)), current_setting('t.coach'));
SELECT pg_temp.rpc('T9b publicar el informe', current_setting('t.coach'), 'T9', $$select public.publish_match_report('{m}', true)$$, 'OK');
SELECT pg_temp.ck('T9b al publicar, minutes_played = 90 (titular) y 0 (banca que no jugó)',
  format($$select (select minutes_played from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L) = 90
              and (select minutes_played from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L) = 0$$,
         pg_temp.m('T9'), pg_temp.c(1), pg_temp.m('T9'), pg_temp.c(14)));
SELECT pg_temp.rpc('T9b despublicar', current_setting('t.coach'), 'T9', $$select public.publish_match_report('{m}', false)$$, 'OK');
SELECT pg_temp.ck('T9b al despublicar, minutes_played vuelve a NULL',
  format($$select count(*) = 0 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id
            where ml.source_id = %L and mlp.minutes_played is not null$$, pg_temp.m('T9')));

-- ---------------------------------------------------------------------------
-- T10 / T10b  save_match_roster bloqueada con partido iniciado; trigger por vía directa
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T10');
SELECT pg_temp.rpc('T10 inicia (queda not_started)', current_setting('t.coach'), 'T10',
  $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.rpc('T10b not_started: save_match_roster SÍ funciona (reconvocar)', current_setting('t.coach'), 'T10',
  format($$select public.save_match_roster('{m}', (select jsonb_agg(jsonb_build_object('subject_type', mlp.subject_type, 'subject_id', mlp.subject_id,
            'role', mlp.role, 'jersey_number', mlp.jersey_number)) from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id
            where ml.source_id = %L))$$, pg_temp.m('T10')), 'OK');
SELECT pg_temp.ap('T10 pitazo inicial', current_setting('t.coach'), 'T10', jsonb_build_array(pg_temp.ev('period_start', 1, 0)), 'OK');
SELECT pg_temp.rpc('T10 save_match_roster con partido iniciado', current_setting('t.coach'), 'T10',
  $$select public.save_match_roster('{m}', '[]'::jsonb)$$, 'LIVE_STARTED');
SELECT pg_temp.rpc('T10 DELETE directo (vía REST) a match_lineup_players: trigger', current_setting('t.admin'), 'T10',
  format($$delete from public.match_lineup_players where lineup_id = (select id from public.match_lineups where source_id = %L)$$, pg_temp.m('T10')),
  'LIVE_STARTED', 'postgres');
SELECT pg_temp.rpc('T10 UPDATE de role por vía directa: trigger', current_setting('t.admin'), 'T10',
  format($$update public.match_lineup_players set role = 'bench' where lineup_id = (select id from public.match_lineups where source_id = %L) and subject_id = '{c1}'$$, pg_temp.m('T10')),
  'LIVE_STARTED', 'postgres');
SELECT pg_temp.rpc('T10 UPDATE de dorsal por vía directa: permitido', current_setting('t.admin'), 'T10',
  format($$update public.match_lineup_players set jersey_number = 77 where lineup_id = (select id from public.match_lineups where source_id = %L) and subject_id = '{c1}'$$, pg_temp.m('T10')),
  'OK', 'postgres');
SELECT pg_temp.ck('T10 siguen las 14 filas',
  format($$select count(*) = 14 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L$$, pg_temp.m('T10')));

-- ---------------------------------------------------------------------------
-- T11  Anular un cambio; anular uno del que depende otro => DEPENDENT_EVENTS
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T11');
SELECT pg_temp.rpc('T11 inicia', current_setting('t.coach'), 'T11', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T11 pitazo, cambio A (c11->c12 en 600), cambio B (c12->c13 en 900)', current_setting('t.coach'), 'T11', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0),
  pg_temp.ev('sub', 1, 600, pg_temp.c(12), pg_temp.c(11), p_cid => 'a1100000-0000-0000-0000-00000000000a'),
  pg_temp.ev('sub', 1, 900, pg_temp.c(13), pg_temp.c(12), p_cid => 'a1100000-0000-0000-0000-00000000000b')), 'OK');
SELECT pg_temp.rpc('T11 anular A (B depende de A)', current_setting('t.coach'), 'T11',
  format($$select public.void_live_event('{m}', (select id from public.match_live_events where match_id = %L and client_event_id = 'a1100000-0000-0000-0000-00000000000a'))$$, pg_temp.m('T11')),
  'DEPENDENT_EVENTS');
SELECT pg_temp.ck('T11 nada cambió: 0 anulados',
  format($$select count(*) = 0 from public.match_live_events where match_id = %L and voided_at is not null$$, pg_temp.m('T11')));
SELECT pg_temp.rpc('T11 anular B (no depende nadie)', current_setting('t.coach'), 'T11',
  format($$select public.void_live_event('{m}', (select id from public.match_live_events where match_id = %L and client_event_id = 'a1100000-0000-0000-0000-00000000000b'))$$, pg_temp.m('T11')),
  'OK');
SELECT pg_temp.ck('T11 c12 queda en cancha (tramo abierto) y c13 sin tramos',
  format($$select (select count(*) from public.match_player_stints where match_id = %L and subject_id = %L and out_second is null) = 1
              and (select count(*) from public.match_player_stints where match_id = %L and subject_id = %L) = 0$$,
         pg_temp.m('T11'), pg_temp.c(12), pg_temp.m('T11'), pg_temp.c(13)));

-- ---------------------------------------------------------------------------
-- T12  Informe ya editado + reabrir + terminar otra vez: no se pisa
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T12');
SELECT pg_temp.rpc('T12 inicia', current_setting('t.coach'), 'T12', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T12 un tiempo', current_setting('t.coach'), 'T12',
  jsonb_build_array(pg_temp.ev('period_start', 1, 0), pg_temp.ev('period_end', 1, 2700)), 'OK');
SELECT pg_temp.rpc('T12 finish', current_setting('t.coach'), 'T12', $$select public.finish_live_match('{m}', 0, 0)$$, 'OK');
SELECT pg_temp.rpc('T12 el entrenador edita el informe', current_setting('t.coach'), 'T12',
  $$select public.save_match_report('{m}', '{"summary":"Texto del entrenador","improvements":"Mejorar la salida"}'::jsonb)$$, 'OK');
SELECT pg_temp.rpc('T12 admin reabre', current_setting('t.admin'), 'T12', $$select public.reopen_live_match('{m}')$$, 'OK');
SELECT pg_temp.rpc('T12 coach (no admin) NO puede reabrir', current_setting('t.coach'), 'T12', $$select public.reopen_live_match('{m}')$$, '42501');
SELECT pg_temp.rpc('T12 finish otra vez', current_setting('t.coach'), 'T12', $$select public.finish_live_match('{m}', 0, 0)$$, 'OK');
SELECT pg_temp.ck('T12 texto del entrenador intacto, improvements intacto, sin publicar',
  format($$select summary = 'Texto del entrenador' and improvements = 'Mejorar la salida' and published_at is null from public.match_reports where match_id = %L$$, pg_temp.m('T12')));

-- ---------------------------------------------------------------------------
-- T13  Dorsales
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T13a', false);
SELECT pg_temp.rpc('T13 convocados sin dorsal', current_setting('t.coach'), 'T13a', $$select public.start_live_match('{m}')$$, 'JERSEY_REQUIRED');
SELECT pg_temp.nm('T13b');
UPDATE public.match_lineup_players SET jersey_number = 1
 WHERE subject_id = pg_temp.c(2) AND lineup_id = (SELECT id FROM public.match_lineups WHERE source_id = pg_temp.m('T13b'));
SELECT pg_temp.rpc('T13 dorsal repetido', current_setting('t.coach'), 'T13b', $$select public.start_live_match('{m}')$$, 'JERSEY_DUPLICATE');
SELECT pg_temp.nm('T13c');
SELECT pg_temp.rpc('T13 inicia', current_setting('t.coach'), 'T13c', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.rpc('T13 add_live_callup sin dorsal', current_setting('t.coach'), 'T13c',
  $$select public.add_live_callup('{m}', 'child', '{c15}', NULL, gen_random_uuid())$$, 'JERSEY_REQUIRED');
SELECT pg_temp.rpc('T13 add_live_callup con dorsal repetido', current_setting('t.coach'), 'T13c',
  $$select public.add_live_callup('{m}', 'child', '{c15}', 3, gen_random_uuid())$$, 'JERSEY_DUPLICATE');
SELECT pg_temp.rpc('T13 add_live_callup ok (dorsal 15)', current_setting('t.coach'), 'T13c',
  $$select public.add_live_callup('{m}', 'child', '{c15}', 15, 'a1300000-0000-0000-0000-000000000001')$$, 'OK');
SELECT pg_temp.rpc('T13 add_live_callup repetido (mismo client_event_id): no duplica', current_setting('t.coach'), 'T13c',
  $$select public.add_live_callup('{m}', 'child', '{c15}', 15, 'a1300000-0000-0000-0000-000000000001')$$, 'OK');
SELECT pg_temp.ck('T13 15 convocados, c15 en banca con dorsal 15',
  format($$select count(*) = 15 and bool_or(subject_id = %L and role = 'bench' and jersey_number = 15)
            from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L$$,
         pg_temp.c(15), pg_temp.m('T13c')));
SELECT pg_temp.rpc('T13 set_live_jersey a un dorsal repetido', current_setting('t.coach'), 'T13c',
  $$select public.set_live_jersey('{m}', 'child', '{c1}', 2)$$, 'JERSEY_DUPLICATE');
SELECT pg_temp.rpc('T13 set_live_jersey ok', current_setting('t.coach'), 'T13c',
  $$select public.set_live_jersey('{m}', 'child', '{c1}', 99)$$, 'OK');

-- ---------------------------------------------------------------------------
-- T14  Cascada (borrar la convocatoria con el partido en vivo) no la bloquea el trigger
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T14');
SELECT pg_temp.rpc('T14 inicia', current_setting('t.coach'), 'T14', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T14 pitazo', current_setting('t.coach'), 'T14', jsonb_build_array(pg_temp.ev('period_start', 1, 0)), 'OK');
SELECT pg_temp.rpc('T14 borrar la convocatoria (cascada a match_lineup_players)', current_setting('t.admin'), 'T14',
  format($$delete from public.match_lineups where source_id = %L$$, pg_temp.m('T14')), 'OK', 'postgres');

-- ---------------------------------------------------------------------------
-- T15  Goles
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T15');
SELECT pg_temp.rpc('T15 inicia', current_setting('t.coach'), 'T15', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T15 pitazo', current_setting('t.coach'), 'T15', jsonb_build_array(pg_temp.ev('period_start', 1, 0)), 'OK');
SELECT pg_temp.ap('T15 gol de un jugador que no está en cancha (c13 en banca)', current_setting('t.coach'), 'T15',
  jsonb_build_array(pg_temp.ev('goal', 1, 300, pg_temp.c(13))), 'NOT_ON_FIELD');
SELECT pg_temp.ap('T15 gol en contra CON jugador (forma inválida)', current_setting('t.coach'), 'T15',
  jsonb_build_array(pg_temp.ev('goal_against', 1, 300, pg_temp.c(1))), 'EVENT_SHAPE_INVALID');
SELECT pg_temp.ap('T15 gol en contra válido (sin jugador)', current_setting('t.coach'), 'T15',
  jsonb_build_array(pg_temp.ev('goal_against', 1, 400)), 'OK');
SELECT pg_temp.ap('T15 fin del tiempo', current_setting('t.coach'), 'T15', jsonb_build_array(pg_temp.ev('period_end', 1, 2700)), 'OK');
SELECT pg_temp.ap('T15 gol en el descanso (tiempo 2 sin pitazo)', current_setting('t.coach'), 'T15',
  jsonb_build_array(pg_temp.ev('goal', 2, 10, pg_temp.c(9))), 'PERIOD_NOT_OPEN');
SELECT pg_temp.ap('T15 gol después del pitazo final del tiempo 1', current_setting('t.coach'), 'T15',
  jsonb_build_array(pg_temp.ev('goal', 1, 2800, pg_temp.c(9))), 'EVENT_AFTER_PERIOD_END');

-- ---------------------------------------------------------------------------
-- T16  Director: reasignación
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T16');
SELECT pg_temp.rpc('T16 coach inicia (queda como director)', current_setting('t.coach'), 'T16', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T16 pitazo', current_setting('t.coach'), 'T16', jsonb_build_array(pg_temp.ev('period_start', 1, 0)), 'OK');
SELECT pg_temp.rpc('T16 coach NO puede reasignar (solo administración)', current_setting('t.coach'), 'T16',
  format($$select public.set_live_director('{m}', %L)$$, current_setting('t.coach_b')), '42501');
SELECT pg_temp.rpc('T16 admin reasigna a un padre', current_setting('t.admin'), 'T16',
  format($$select public.set_live_director('{m}', %L)$$, current_setting('t.parent')), 'NEW_DIRECTOR_NOT_STAFF');
SELECT pg_temp.rpc('T16 admin reasigna a otro coach de Carmel', current_setting('t.admin'), 'T16',
  format($$select public.set_live_director('{m}', %L)$$, current_setting('t.coach_b')), 'OK');
SELECT pg_temp.ap('T16 el director VIEJO ya no puede escribir', current_setting('t.coach'), 'T16',
  jsonb_build_array(pg_temp.ev('sub', 1, 600, pg_temp.c(12), pg_temp.c(11))), 'NOT_DIRECTOR');
SELECT pg_temp.ap('T16 el director NUEVO sí', current_setting('t.coach_b'), 'T16',
  jsonb_build_array(pg_temp.ev('sub', 1, 600, pg_temp.c(12), pg_temp.c(11))), 'OK');

-- ---------------------------------------------------------------------------
-- T17  Suspensión: finish en mitad del tiempo
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T17');
SELECT pg_temp.rpc('T17 inicia', current_setting('t.coach'), 'T17', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('T17 pitazo y cambio en 300', current_setting('t.coach'), 'T17', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0), pg_temp.ev('sub', 1, 300, pg_temp.c(12), pg_temp.c(11))), 'OK');
SELECT pg_temp.rpc('T17 finish con el tiempo abierto (0-0)', current_setting('t.coach'), 'T17', $$select public.finish_live_match('{m}', 0, 0)$$, 'OK');
SELECT pg_temp.ck('T17 no queda ningún tramo abierto y c11 jugó 300 s',
  format($$select (select count(*) from public.match_player_stints where match_id = %L and out_second is null) = 0
              and (select sum(out_second - in_second) from public.match_player_stints where match_id = %L and subject_id = %L) = 300$$,
         pg_temp.m('T17'), pg_temp.m('T17'), pg_temp.c(11)));
SELECT pg_temp.ck('T17 estado finished y marcador escrito',
  format($$select (select status from public.match_live where match_id = %L) = 'finished'
              and (select status from public.match_results where id = %L) = 'played'$$, pg_temp.m('T17'), pg_temp.m('T17')));

-- ---------------------------------------------------------------------------
-- T18  Tiempos desiguales (25' + 25' + 15') y tiempo añadido
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('T18');
SELECT pg_temp.rpc('T18 inicia con formato 25/25/15', current_setting('t.coach'), 'T18',
  $$select public.start_live_match('{m}', '{"periods":[25,25,15]}'::jsonb)$$, 'OK');
SELECT pg_temp.ap('T18 tres tiempos (el primero con 60 s añadidos)', current_setting('t.coach'), 'T18', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0), pg_temp.ev('period_end', 1, 1560),
  pg_temp.ev('period_start', 2, 0), pg_temp.ev('period_end', 2, 1500),
  pg_temp.ev('period_start', 3, 0), pg_temp.ev('period_end', 3, 900)), 'OK');
SELECT pg_temp.ck('T18 stoppage del tiempo 1 = 60 s y total jugado = 3960 s',
  format($$select (select stoppage_seconds from public.match_live_periods where match_id = %L and period_no = 1) = 60
              and (select sum(actual_seconds) from public.match_live_periods where match_id = %L) = 3960$$, pg_temp.m('T18'), pg_temp.m('T18')));
SELECT pg_temp.ck('T18 % = segundos / Σ actual_seconds: c1 (todo el partido) = 100 %, 66 min',
  format($$select (select (x->>'pct')::numeric = 100 and (x->>'minutes')::int = 66 from jsonb_array_elements(public.match_live_report(%L)->'lineup') x where x->>'subject_id' = %L)$$,
         pg_temp.m('T18'), pg_temp.c(1)), current_setting('t.coach'));

-- ---------------------------------------------------------------------------
-- T-minutos  Origen de los minutos (migración 07): manual no se pisa, despublicar solo limpia 'live'
-- Requiere 07 aplicada (columna minutes_source + trigger trg_lineup_minutes_source_mark).
-- ---------------------------------------------------------------------------
SELECT pg_temp.nm('TM');
SELECT pg_temp.rpc('TM inicia', current_setting('t.coach'), 'TM', $$select public.start_live_match('{m}')$$, 'OK');
SELECT pg_temp.ap('TM partido de 2 tiempos', current_setting('t.coach'), 'TM', jsonb_build_array(
  pg_temp.ev('period_start', 1, 0), pg_temp.ev('period_end', 1, 2700),
  pg_temp.ev('period_start', 2, 0), pg_temp.ev('period_end', 2, 2700)), 'OK');
SELECT pg_temp.rpc('TM finish', current_setting('t.coach'), 'TM', $$select public.finish_live_match('{m}', 0, 0)$$, 'OK');
-- c2: edición manual directa (UPDATE del cliente, no pasa por las RPC) => source 'manual'
SELECT pg_temp.rpc('TM staff edita minutos de c2 a mano (UPDATE directo)', current_setting('t.coach'), 'TM',
  format($$update public.match_lineup_players set minutes_played = 45 where lineup_id = (select id from public.match_lineups where source_id = %L) and subject_id = '{c2}'$$, pg_temp.m('TM')),
  'OK', 'postgres');
-- c3: dato histórico (minutos con source NULL), simulado con la marca de sesión para que el trigger no lo anote
DO $h$ BEGIN
  PERFORM set_config('app.live_minutes_write', '1', true);
  UPDATE public.match_lineup_players SET minutes_played = 33
   WHERE lineup_id = (SELECT id FROM public.match_lineups WHERE source_id = pg_temp.m('TM')) AND subject_id = pg_temp.c(3);
  PERFORM set_config('app.live_minutes_write', '0', true);
END $h$;
SELECT pg_temp.ck('TM c2 quedó manual, c3 histórico source NULL, c1 sin dato',
  format($$select (select minutes_source from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L) = 'manual'
              and (select minutes_source is null and minutes_played = 33 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)
              and (select minutes_source is null and minutes_played is null from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)$$,
         pg_temp.m('TM'), pg_temp.c(2), pg_temp.m('TM'), pg_temp.c(3), pg_temp.m('TM'), pg_temp.c(1)));
SELECT pg_temp.rpc('TM publicar el informe', current_setting('t.coach'), 'TM', $$select public.publish_match_report('{m}', true)$$, 'OK');
SELECT pg_temp.ck('TM publicar: c1=90 live, c14=0 live; c2=45 manual y c3=33 (histórico) NO se pisan',
  format($$select (select (minutes_played, minutes_source) = (90, 'live') from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)
              and (select (minutes_played, minutes_source) = (0, 'live') from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)
              and (select (minutes_played, minutes_source) = (45, 'manual') from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)
              and (select minutes_played = 33 and minutes_source is null from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)$$,
         pg_temp.m('TM'), pg_temp.c(1), pg_temp.m('TM'), pg_temp.c(14), pg_temp.m('TM'), pg_temp.c(2), pg_temp.m('TM'), pg_temp.c(3)));
SELECT pg_temp.ck('TM match_live_report: c2 minutes_live=90, minutes_published=45, source manual; c1 90/90/live',
  format($$select (select (x->>'minutes_live')::int = 90 and (x->>'minutes_published')::int = 45 and x->>'minutes_source' = 'manual'
                     from jsonb_array_elements(public.match_live_report(%L)->'lineup') x where x->>'subject_id' = %L)
              and (select (x->>'minutes_live')::int = 90 and (x->>'minutes_published')::int = 90 and x->>'minutes_source' = 'live'
                     from jsonb_array_elements(public.match_live_report(%L)->'lineup') x where x->>'subject_id' = %L)$$,
         pg_temp.m('TM'), pg_temp.c(2), pg_temp.m('TM'), pg_temp.c(1)), current_setting('t.coach'));
SELECT pg_temp.rpc('TM despublicar', current_setting('t.coach'), 'TM', $$select public.publish_match_report('{m}', false)$$, 'OK');
SELECT pg_temp.ck('TM despublicar: solo se limpian los live; c2 manual y c3 histórico intactos',
  format($$select (select count(*) = 0 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.minutes_source = 'live')
              and (select count(*) = 2 from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.minutes_played is not null)
              and (select minutes_played = 45 and minutes_source = 'manual' from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)$$,
         pg_temp.m('TM'), pg_temp.m('TM'), pg_temp.m('TM'), pg_temp.c(2)));
SELECT pg_temp.ck('TM la marca de sesión no queda prendida tras publicar/despublicar',
  $$select coalesce(current_setting('app.live_minutes_write', true), '0') <> '1'$$);
SELECT pg_temp.rpc('TM edición manual de c1 (antes live) => manual; la republicación no la pisa', current_setting('t.coach'), 'TM',
  format($$update public.match_lineup_players set minutes_played = 10 where lineup_id = (select id from public.match_lineups where source_id = %L) and subject_id = '{c1}'$$, pg_temp.m('TM')),
  'OK', 'postgres');
SELECT pg_temp.rpc('TM republicar', current_setting('t.coach'), 'TM', $$select public.publish_match_report('{m}', true)$$, 'OK');
SELECT pg_temp.ck('TM c1 sigue en 10 manual; c14 vuelve a 0 live',
  format($$select (select (minutes_played, minutes_source) = (10, 'manual') from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)
              and (select (minutes_played, minutes_source) = (0, 'live') from public.match_lineup_players mlp join public.match_lineups ml on ml.id = mlp.lineup_id where ml.source_id = %L and mlp.subject_id = %L)$$,
         pg_temp.m('TM'), pg_temp.c(1), pg_temp.m('TM'), pg_temp.c(14)));
-- Otras escuelas: el valor visible no cambia; solo se anota 'manual'. Un UPDATE con el mismo valor no marca nada.
DO $o$
DECLARE v_id uuid; v_ok boolean := true; v_det text := 'sin filas de otra escuela con minutos (prueba omitida)'; v_antes int;
BEGIN
  SELECT mlp.id, mlp.minutes_played INTO v_id, v_antes FROM public.match_lineup_players mlp
   WHERE mlp.school_id <> current_setting('t.carmel')::uuid AND mlp.minutes_played IS NOT NULL LIMIT 1;
  IF v_id IS NOT NULL THEN
    UPDATE public.match_lineup_players SET minutes_played = minutes_played WHERE id = v_id;
    v_ok := (SELECT minutes_source IS NULL FROM public.match_lineup_players WHERE id = v_id);
    UPDATE public.match_lineup_players SET minutes_played = v_antes + 1 WHERE id = v_id;
    v_ok := v_ok AND (SELECT minutes_source = 'manual' AND minutes_played = v_antes + 1 FROM public.match_lineup_players WHERE id = v_id);
    v_det := 'fila de otra escuela ' || v_id;
  END IF;
  INSERT INTO _res (test, ok, detalle) VALUES ('TM otras escuelas: mismo valor no marca; valor nuevo marca manual y se guarda tal cual', v_ok, v_det);
END $o$;

-- ---------------------------------------------------------------------------
-- T-agenda  create_match / update_match con formato del partido (migración 08)
-- Requiere 08 aplicada. Sin claves = igual que hoy; con claves y flag apagado = LIVE_DISABLED;
-- con claves y flag encendido = guarda; update sin claves conserva.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.cm(p_key text, p_json jsonb) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_r jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
  v_r := public.create_match(p_json || jsonb_build_object('team_id', current_setting('t.team'), 'opponent', 'Rival Agenda', 'match_date', current_date::text));
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('t.m_' || p_key, v_r->>'match_id', true);
END $f$;

-- flag encendido (lo prendió el bloque 0)
SELECT pg_temp.cm('AG1', '{}'::jsonb);
SELECT pg_temp.ck('AG1 create SIN claves = DEFAULT (NULL, NULL, official, NULL)',
  format($$select live_periods_count is null and live_period_minutes is null and match_kind = 'official' and referee_name is null
             from public.match_results where id = %L$$, pg_temp.m('AG1')));
SELECT pg_temp.cm('AG2', '{"live_periods_count": 3, "live_period_minutes": 30, "match_kind": "practice", "referee_name": "  Árbitro QA  "}'::jsonb);
SELECT pg_temp.ck('AG2 create CON claves y flag encendido guarda (referee con btrim)',
  format($$select live_periods_count = 3 and live_period_minutes = 30 and match_kind = 'practice' and referee_name = 'Árbitro QA'
             from public.match_results where id = %L$$, pg_temp.m('AG2')));
SELECT pg_temp.try('AG3 update SIN claves no toca el formato', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"notes": "solo notas"}'::jsonb)$$, pg_temp.m('AG2')), 'OK');
SELECT pg_temp.ck('AG3 formato conservado tras update sin claves',
  format($$select live_periods_count = 3 and live_period_minutes = 30 and match_kind = 'practice' and referee_name = 'Árbitro QA' and notes = 'solo notas'
             from public.match_results where id = %L$$, pg_temp.m('AG2')));
SELECT pg_temp.try('AG4 update CON claves guarda', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_periods_count": 2, "live_period_minutes": 45, "match_kind": "official", "referee_name": ""}'::jsonb)$$, pg_temp.m('AG2')), 'OK');
SELECT pg_temp.ck('AG4 valores nuevos (árbitro vacío = NULL)',
  format($$select live_periods_count = 2 and live_period_minutes = 45 and match_kind = 'official' and referee_name is null
             from public.match_results where id = %L$$, pg_temp.m('AG2')));
-- rangos (22023 antes de que salte el CHECK)
SELECT pg_temp.try('AG5 tiempos 5 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_periods_count": 5}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 tiempos 0 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_periods_count": 0}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 minutos 4 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_period_minutes": 4}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 minutos 61 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_period_minutes": 61}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 minutos 45.5 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"live_period_minutes": 45.5}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 match_kind raro -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"match_kind": "amistoso"}'::jsonb)$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 árbitro de 121 caracteres -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, jsonb_build_object('referee_name', repeat('a', 121)))$$, pg_temp.m('AG2')), '22023');
SELECT pg_temp.try('AG5 create con tiempos 9 -> 22023', 'authenticated', current_setting('t.admin'),
  format($$select public.create_match(jsonb_build_object('team_id', %L, 'opponent', 'X', 'match_date', current_date::text, 'live_periods_count', 9))$$, current_setting('t.team')), '22023');
SELECT pg_temp.ck('AG5 nada de lo rechazado se guardó',
  format($$select live_periods_count = 2 and live_period_minutes = 45 and match_kind = 'official' from public.match_results where id = %L$$, pg_temp.m('AG2')));
-- flag apagado (solo dentro de la tx): con claves rechaza; sin claves sigue igual
UPDATE public.school_settings SET live_match_enabled = false WHERE school_id = current_setting('t.carmel')::uuid;
SELECT pg_temp.try('AG6 create CON claves, flag apagado -> LIVE_DISABLED', 'authenticated', current_setting('t.admin'),
  format($$select public.create_match(jsonb_build_object('team_id', %L, 'opponent', 'X', 'match_date', current_date::text, 'match_kind', 'practice'))$$, current_setting('t.team')), 'LIVE_DISABLED');
SELECT pg_temp.try('AG6 update CON claves, flag apagado -> LIVE_DISABLED', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"referee_name": "Otro"}'::jsonb)$$, pg_temp.m('AG2')), 'LIVE_DISABLED');
SELECT pg_temp.try('AG6 create SIN claves, flag apagado = OK (como hoy)', 'authenticated', current_setting('t.admin'),
  format($$select public.create_match(jsonb_build_object('team_id', %L, 'opponent', 'X', 'match_date', current_date::text))$$, current_setting('t.team')), 'OK');
SELECT pg_temp.try('AG6 update SIN claves, flag apagado = OK (como hoy)', 'authenticated', current_setting('t.admin'),
  format($$select public.update_match(%L, '{"notes": "otra vez"}'::jsonb)$$, pg_temp.m('AG2')), 'OK');
SELECT pg_temp.ck('AG6 el rechazo no guardó el árbitro',
  format($$select referee_name is null and notes = 'otra vez' from public.match_results where id = %L$$, pg_temp.m('AG2')));
-- Un padre sigue sin poder (el gate de alcance no cambió)
SELECT pg_temp.try('AG7 padre create -> 42501', 'authenticated', current_setting('t.parent'),
  format($$select public.create_match(jsonb_build_object('team_id', %L, 'opponent', 'X', 'match_date', current_date::text))$$, current_setting('t.team')), '42501');
-- restaurar el flag para lo que siga
UPDATE public.school_settings SET live_match_enabled = true WHERE school_id = current_setting('t.carmel')::uuid;

-- ---------------------------------------------------------------------------
-- REPORTE (la excepción es a propósito: deshace todo) + ROLLBACK de respaldo
-- ---------------------------------------------------------------------------
DO $r$
DECLARE v text;
BEGIN
  SELECT format(E'%s pruebas: %s OK, %s FALLAN\n', count(*), count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok))
         || string_agg(CASE WHEN ok THEN 'OK     ' ELSE 'FALLA  ' END || test || CASE WHEN ok THEN '' ELSE '  ::  ' || detalle END,
                       E'\n' ORDER BY n)
    INTO v FROM _res;
  RAISE EXCEPTION E'REPORTE (esta excepción es a propósito y deshace todo)\n%', v;
END $r$;

ROLLBACK;
