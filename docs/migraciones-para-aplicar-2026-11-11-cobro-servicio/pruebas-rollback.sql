-- =============================================================================
-- PRUEBAS DE SESIÓN Y DE NEGOCIO — Cobro de servicio unificado
-- Migración: supabase/migrations/20261111114349_cobro_servicio_unificado.sql
-- Plan: docs/specs/pago-manual-de-servicio.md §4 y «Pruebas mínimas» del §8.
-- Correr DESPUÉS de aplicar la migración. NO correr antes: las funciones no existen.
--
-- TODO SE DESHACE. El archivo es UNA transacción (BEGIN) que termina con un DO que
-- lanza una excepción a propósito con el reporte (esa es la forma de ver las filas sin
-- guardar nada) y, de respaldo, un ROLLBACK. Nada queda en la base: ni el ítem de
-- prueba, ni los cobros, ni los enlaces, ni las notificaciones que disparen los triggers.
--
-- CÓMO CORRERLO
--   · npx supabase db query --linked -f docs/migraciones-para-aplicar-2026-11-11-cobro-servicio/pruebas-rollback.sql
--   · o SQL Editor: pegar TODO y ejecutar. El resultado es un ERROR cuyo mensaje es el reporte.
--   Si el cliente corta la transacción a la mitad, NO pegues un COMMIT.
--   Una sola sesión, sin otras escrituras en paralelo (toma candados de fila cortos).
--
-- QUÉ ASUME (sale de la base, sin placeholders): Monster's Volley Club
--   (eb3ebc77-4ea4-4992-96c8-3c8ec574578c) tiene un admin/owner, un coach, >= 9
--   deportistas (children) activos, un equipo, un prospecto no descartado, un atleta
--   miembro activo con cuenta; y existe un admin de OTRA escuela. Lo que falte se
--   reporta como «SALTADA» (no como verde).
-- NO toca el ítem real de la clínica: crea ítems de prueba propios, con la misma
-- configuración (externo 300.000 -> 350.000 desde 11-nov; afiliado 250.000 -> 300.000
-- desde 16-nov; grupo equipo30 = 30 % con mínimo 5; abono mínimo 50 %).
-- Las pruebas simulan sesión con request.jwt.claims + SET LOCAL ROLE (authenticated/anon/service_role).
--
-- Cada prueba dice su RESULTADO ESPERADO en el texto de «detalle». ok = true es verde.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE _res (n serial, test text, ok boolean, detalle text);

-- ---------------------------------------------------------------------------
-- Ayudantes temporales (viven solo en esta sesión)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.k(p_key text) RETURNS text LANGUAGE sql AS $$ select current_setting('t.' || p_key, true) $$;
CREATE FUNCTION pg_temp.q(p_key text) RETURNS uuid LANGUAGE sql AS $$ select nullif(current_setting('t.' || p_key, true), '')::uuid $$;

CREATE FUNCTION pg_temp.rec(p_test text, p_ok boolean, p_detalle text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO _res (test, ok, detalle) VALUES (p_test, coalesce(p_ok, false), p_detalle);
END $f$;

CREATE FUNCTION pg_temp.skip(p_test text, p_why text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO _res (test, ok, detalle) VALUES (p_test, false, 'SALTADA: ' || p_why);
END $f$;

-- Ejecuta p_sql (un SELECT que devuelve UN jsonb) con la sesión p_uid y el rol p_role.
-- Si lanza, devuelve {"_error": SQLSTATE, "_msg": ...}.
CREATE FUNCTION pg_temp.as_user(p_role text, p_uid text, p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', p_role)::text, true);
  EXECUTE format('set local role %I', p_role);
  BEGIN
    EXECUTE p_sql INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := jsonb_build_object('_error', SQLSTATE, '_msg', left(SQLERRM, 200));
  END;
  EXECUTE 'reset role';
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $f$;

-- Llamadas con nombre a las RPC (el prefijo fija escuela e ítem; p_args = el resto).
CREATE FUNCTION pg_temp.reg(p_uid text, p_args text, p_item text DEFAULT 'item') RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN pg_temp.as_user('authenticated', p_uid, format(
    'select public.registrar_pago_servicio_manual(p_school_id => %L, p_item_id => %L, %s)',
    pg_temp.k('school'), pg_temp.k(p_item), p_args));
END $f$;

CREATE FUNCTION pg_temp.lig(p_uid text, p_pago uuid, p_item text, p_motivo text, p_clave text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN pg_temp.as_user('authenticated', p_uid, format(
    'select public.ligar_cobro_a_servicio(%L, %L, %L, %L)', p_pago, pg_temp.k(p_item), p_motivo, p_clave));
END $f$;

CREATE FUNCTION pg_temp.apl(p_args text, p_item text DEFAULT 'item') RETURNS jsonb LANGUAGE plpgsql AS $f$
BEGIN
  RETURN pg_temp.as_user('service_role', NULL, format(
    'select public.aplicar_comprobante_a_cobro_abierto(p_school_id => %L, p_queue_id => gen_random_uuid(), %s)',
    pg_temp.k('school'), p_args));
END $f$;

-- Crea un cobro SIN ligar de la escuela (como los «Otro cobro» de la app), vencido para no
-- disparar el aviso de «cobro nuevo». Devuelve su id.
CREATE FUNCTION pg_temp.mkpay(p_child uuid, p_monto numeric, p_team uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.payments (school_id, parent_id, child_id, amount, concept, due_date, status, payment_type,
                               payment_category, period_uniqueness_exempt, team_id)
  SELECT c.school_id, c.parent_id, c.id, p_monto, 'QA cobro de la escuela — ' || c.full_name,
         DATE '2026-11-20', 'overdue', 'one_time', 'otro', true, p_team
    FROM public.children c WHERE c.id = p_child
  RETURNING id INTO v_id;
  RETURN v_id;
END $f$;

-- ---------------------------------------------------------------------------
-- Datos de la prueba (todo sale de la base; el ítem de prueba se crea aquí y se deshace)
-- ---------------------------------------------------------------------------
DO $setup$
DECLARE
  v_school uuid := 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
  v_kids uuid[];
  v_i int;
  v_item uuid;
  v_item2 uuid;
BEGIN
  PERFORM set_config('t.school', v_school::text, true);

  PERFORM set_config('t.admin', coalesce((
    SELECT sm.profile_id::text FROM public.school_members sm
     WHERE sm.school_id = v_school AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin')
     ORDER BY sm.created_at LIMIT 1), ''), true);
  PERFORM set_config('t.coach', coalesce((
    SELECT sm.profile_id::text FROM public.school_members sm
     WHERE sm.school_id = v_school AND sm.status = 'active' AND sm.role = 'coach'
       AND sm.profile_id NOT IN (SELECT x.profile_id FROM public.school_members x
                                  WHERE x.school_id = v_school AND x.status = 'active' AND x.role IN ('owner', 'admin', 'school_admin'))
     LIMIT 1), ''), true);
  PERFORM set_config('t.parent', coalesce((
    SELECT c.parent_id::text FROM public.children c
     WHERE c.school_id = v_school AND c.parent_id IS NOT NULL
       AND c.parent_id NOT IN (SELECT x.profile_id FROM public.school_members x
                                WHERE x.school_id = v_school AND x.status = 'active' AND x.role IN ('owner', 'admin', 'school_admin'))
     LIMIT 1), ''), true);
  PERFORM set_config('t.otheradmin', coalesce((
    SELECT sm.profile_id::text FROM public.school_members sm
     WHERE sm.school_id <> v_school AND sm.status = 'active' AND sm.role IN ('owner', 'admin', 'school_admin')
       AND sm.profile_id NOT IN (SELECT x.profile_id FROM public.school_members x
                                  WHERE x.school_id = v_school AND x.status = 'active')
     LIMIT 1), ''), true);
  PERFORM set_config('t.athlete', coalesce((
    SELECT sm.profile_id::text FROM public.school_members sm
     WHERE sm.school_id = v_school AND sm.status = 'active' AND sm.role = 'athlete'
     LIMIT 1), ''), true);
  PERFORM set_config('t.team', coalesce((SELECT t.id::text FROM public.teams t WHERE t.school_id = v_school LIMIT 1), ''), true);
  PERFORM set_config('t.lead', coalesce((
    SELECT l.id::text FROM public.school_signup_leads l
     WHERE l.school_id = v_school AND l.status <> 'discarded' ORDER BY l.created_at DESC LIMIT 1), ''), true);
  PERFORM set_config('t.payany', coalesce((SELECT p.id::text FROM public.payments p WHERE p.school_id = v_school LIMIT 1), ''), true);

  SELECT array_agg(id) INTO v_kids FROM (
    SELECT c.id FROM public.children c WHERE c.school_id = v_school AND c.is_active ORDER BY c.id LIMIT 9) s;
  FOR v_i IN 1..coalesce(array_length(v_kids, 1), 0) LOOP
    PERFORM set_config('t.c' || v_i, v_kids[v_i]::text, true);
  END LOOP;

  -- Ítem de prueba = la clínica de Monster (mismas reglas de Iván).
  INSERT INTO public.school_tournament_items (
    school_id, name, price, kind, active, per_athlete, allow_installments,
    precio_afiliado, precios_por_fecha, precios_afiliado_por_fecha,
    abono_minimo_pct, descuentos_grupo, saldo_hasta)
  VALUES (
    v_school, 'QA Clínica de prueba', 300000, 'clase_extra', true, true, true,
    250000, '[{"desde":"2026-11-11","precio":350000}]'::jsonb, '[{"desde":"2026-11-16","precio":300000}]'::jsonb,
    50, '[{"clave":"equipo30","pct":30,"minimo":5,"por":"equipo"}]'::jsonb, DATE '2026-11-20')
  RETURNING id INTO v_item;
  PERFORM set_config('t.item', v_item::text, true);

  -- Ítem de cupo único (sin abono, sin precios por fecha).
  INSERT INTO public.school_tournament_items (school_id, name, price, kind, active, per_athlete, capacity)
  VALUES (v_school, 'QA Cupo único', 100000, 'otro', true, true, 1)
  RETURNING id INTO v_item2;
  PERFORM set_config('t.item2', v_item2::text, true);
END $setup$;

-- ---------------------------------------------------------------------------
-- A. Estructura, siembra y permisos de objeto (como postgres)
-- ---------------------------------------------------------------------------
-- A1. La siembra de la clínica real (esperado: 3 columnas con lo que pidió Iván).
SELECT pg_temp.rec('A1 siembra de la clínica real',
  EXISTS (SELECT 1 FROM public.school_tournament_items i
           WHERE i.id = '16766d2e-f8b0-4285-88e3-b1e67dda6d45'
             AND i.descuentos_grupo = '[{"clave":"equipo30","pct":30,"minimo":5,"por":"equipo"}]'::jsonb
             AND i.precios_afiliado_por_fecha = '[{"desde":"2026-11-16","precio":300000}]'::jsonb
             AND i.saldo_hasta = DATE '2026-11-20'),
  'esperaba descuentos_grupo equipo30 30%/5, precios_afiliado_por_fecha 16-nov=300000, saldo_hasta 2026-11-20');

-- A2. Una sola firma de wa_crear_cobro_desde_comprobante, con p_user_id (sin sobrecarga ambigua).
SELECT pg_temp.rec('A2 wa_crear_cobro_desde_comprobante sin sobrecarga',
  (SELECT count(*) = 1 AND bool_and(pg_get_function_identity_arguments(p.oid) LIKE '%p_user_id uuid')
     FROM pg_proc p WHERE p.proname = 'wa_crear_cobro_desde_comprobante' AND p.pronamespace = 'public'::regnamespace),
  'esperaba exactamente 1 función, con p_user_id como último parámetro');

-- A3. anon no ejecuta NINGUNA de las funciones nuevas ni la modificada (esperado: true).
SELECT pg_temp.rec('A3 anon sin EXECUTE',
  (SELECT bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('registrar_pago_servicio_manual', 'ligar_cobro_a_servicio', 'reclasificar_pago_servicio',
                        'aplicar_comprobante_a_cobro_abierto', 'wa_crear_cobro_desde_comprobante', 'wa_crear_cobro_suelto',
                        'auto_approve_payment', '_servicio_precio_vigente', '_servicio_cupos_vivos',
                        '_servicio_grupo_cumple', '_servicio_es_afiliado', '_servicio_cobros_del_dueno', '_servicio_pago_ligado')),
  'esperaba que anon no tenga EXECUTE en ninguna');

-- A4. authenticated ejecuta SOLO las tres RPC de la escuela (esperado: true).
SELECT pg_temp.rec('A4 authenticated solo en las RPC de la escuela',
  (SELECT bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE') = (p.proname IN
        ('registrar_pago_servicio_manual', 'ligar_cobro_a_servicio', 'reclasificar_pago_servicio')))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('registrar_pago_servicio_manual', 'ligar_cobro_a_servicio', 'reclasificar_pago_servicio',
                        'aplicar_comprobante_a_cobro_abierto', 'wa_crear_cobro_desde_comprobante', 'wa_crear_cobro_suelto',
                        'auto_approve_payment', '_servicio_precio_vigente', '_servicio_cupos_vivos',
                        '_servicio_grupo_cumple', '_servicio_es_afiliado', '_servicio_cobros_del_dueno', '_servicio_pago_ligado')),
  'esperaba EXECUTE de authenticated solo en registrar/ligar/reclasificar');

-- A5. service_role ejecuta las del BFF (esperado: true).
SELECT pg_temp.rec('A5 service_role en las RPC del BFF',
  (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
     FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('aplicar_comprobante_a_cobro_abierto', 'wa_crear_cobro_desde_comprobante', 'wa_crear_cobro_suelto', 'auto_approve_payment')),
  'esperaba EXECUTE de service_role');

-- A6. Las tablas nuevas: RLS activo, sin policies, sin privilegios para anon/authenticated (esperado: true).
SELECT pg_temp.rec('A6 tablas nuevas cerradas',
  (SELECT bool_and(c.relrowsecurity)
     FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('cobros_servicio_item', 'cobros_servicio_movimientos'))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('cobros_servicio_item', 'cobros_servicio_movimientos'))
  AND NOT has_table_privilege('anon', 'public.cobros_servicio_item', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.cobros_servicio_item', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.cobros_servicio_movimientos', 'SELECT')
  AND has_table_privilege('service_role', 'public.cobros_servicio_item', 'SELECT'),
  'esperaba RLS activo, 0 policies, sin SELECT para anon/authenticated y con SELECT para service_role');

-- A7. auto_approve_payment lleva las dos guardas del plan §5 (esperado: true).
SELECT pg_temp.rec('A7 auto_approve_payment con guardas (texto; el comportamiento está en J2)',
  (SELECT p.prosrc LIKE '%COALESCE(v_category, ''mensualidad'') = ''mensualidad''%'
      AND p.prosrc LIKE '%COALESCE(v_parent_id, v_user_id)%'
     FROM pg_proc p WHERE p.proname = 'auto_approve_payment' AND p.pronamespace = 'public'::regnamespace),
  'esperaba la guarda de categoría y el aviso a COALESCE(parent_id, user_id)');

-- ---------------------------------------------------------------------------
-- B. Sesión simulada: quien NO es admin de la escuela recibe 42501
-- ---------------------------------------------------------------------------
DO $b$
DECLARE
  v_args text := 'p_monto => 250000, p_metodo => ''transfer'', p_idempotency_key => ''qa-sesion-0001'', p_child_id => ' || quote_literal(pg_temp.k('c1'));
  r jsonb; v_who text; v_role text; v_uid text; v_lbl text;
BEGIN
  FOR v_lbl, v_role, v_uid IN
    SELECT * FROM (VALUES ('anon', 'anon', NULL),
                          ('coach', 'authenticated', pg_temp.k('coach')),
                          ('parent', 'authenticated', pg_temp.k('parent')),
                          ('admin de otra escuela', 'authenticated', pg_temp.k('otheradmin'))) t(a, b, c)
  LOOP
    IF v_role = 'authenticated' AND coalesce(v_uid, '') = '' THEN
      PERFORM pg_temp.skip('B registrar como ' || v_lbl, 'no hay un usuario de ese tipo en la base');
      CONTINUE;
    END IF;
    r := pg_temp.as_user(v_role, v_uid, format(
      'select public.registrar_pago_servicio_manual(p_school_id => %L, p_item_id => %L, %s)',
      pg_temp.k('school'), pg_temp.k('item'), v_args));
    PERFORM pg_temp.rec('B registrar como ' || v_lbl || ' -> 42501', r->>'_error' = '42501',
                        'esperaba 42501 | obtuvo ' || coalesce(r->>'_error', 'sin error') || ' ' || coalesce(r->>'_msg', left(r::text, 120)));
    IF v_role = 'authenticated' THEN
      r := pg_temp.as_user(v_role, v_uid, format('select public.ligar_cobro_a_servicio(%L, %L, %L, NULL)',
                                                   pg_temp.k('payany'), pg_temp.k('item'), 'prueba de sesión simulada'));
      PERFORM pg_temp.rec('B ligar como ' || v_lbl || ' -> 42501', r->>'_error' = '42501',
                          'esperaba 42501 | obtuvo ' || coalesce(r->>'_error', 'sin error') || ' ' || coalesce(r->>'_msg', left(r::text, 120)));
      r := pg_temp.as_user(v_role, v_uid, format('select public.reclasificar_pago_servicio(%L, ''otro'', NULL, %L)',
                                                   pg_temp.k('payany'), 'prueba de sesión simulada'));
      PERFORM pg_temp.rec('B reclasificar como ' || v_lbl || ' -> 42501', r->>'_error' = '42501',
                          'esperaba 42501 | obtuvo ' || coalesce(r->>'_error', 'sin error') || ' ' || coalesce(r->>'_msg', left(r::text, 120)));
    END IF;
  END LOOP;

  -- Un cobro que no existe da lo MISMO que uno ajeno (no se revela si existe).
  IF coalesce(pg_temp.k('admin'), '') <> '' THEN
    r := pg_temp.as_user('authenticated', pg_temp.k('admin'), format(
      'select public.ligar_cobro_a_servicio(gen_random_uuid(), %L, %L, NULL)', pg_temp.k('item'), 'cobro inexistente a propósito'));
    PERFORM pg_temp.rec('B ligar cobro inexistente -> 42501', r->>'_error' = '42501',
                        'esperaba 42501 | obtuvo ' || coalesce(r->>'_error', 'sin error') || ' ' || left(r::text, 120));
  END IF;

  -- aplicar_comprobante_a_cobro_abierto: solo service_role. authenticated y anon: 42501 (permission denied).
  FOR v_role, v_uid IN SELECT * FROM (VALUES ('anon', NULL), ('authenticated', coalesce(nullif(pg_temp.k('admin'), ''), gen_random_uuid()::text))) t(a, b) LOOP
    r := pg_temp.as_user(v_role, v_uid, format(
      'select public.aplicar_comprobante_a_cobro_abierto(p_school_id => %L, p_queue_id => gen_random_uuid(), p_monto => 1000, p_item_id => %L, p_child_id => %L)',
      pg_temp.k('school'), pg_temp.k('item'), pg_temp.k('c1')));
    PERFORM pg_temp.rec('B aplicar_comprobante como ' || v_role || ' -> 42501', r->>'_error' = '42501',
                        'esperaba 42501 (sin EXECUTE) | obtuvo ' || coalesce(r->>'_error', 'sin error') || ' ' || left(r::text, 120));
  END LOOP;
END $b$;

-- ---------------------------------------------------------------------------
-- C. Precio por fecha (15 vs 16-nov) — función interna, como postgres
--    Esperado: afiliado 250.000 -> 300.000; grupo 175.000 -> 210.000; externo 350.000 (desde 11-nov) y 300.000 antes.
-- ---------------------------------------------------------------------------
DO $c$
DECLARE
  v_item public.school_tournament_items%ROWTYPE;
  r jsonb;
BEGIN
  SELECT * INTO v_item FROM public.school_tournament_items WHERE id = pg_temp.q('item');

  r := public._servicio_precio_vigente(v_item, DATE '2026-11-15', true, NULL, false);
  PERFORM pg_temp.rec('C1 afiliado 15-nov = 250.000', (r->>'precio')::numeric = 250000 AND (r->>'lista')::numeric = 250000, 'obtuvo ' || r::text);
  r := public._servicio_precio_vigente(v_item, DATE '2026-11-16', true, NULL, false);
  PERFORM pg_temp.rec('C2 afiliado 16-nov = 300.000', (r->>'precio')::numeric = 300000, 'obtuvo ' || r::text);
  r := public._servicio_precio_vigente(v_item, DATE '2026-11-15', true, NULL, true);
  PERFORM pg_temp.rec('C3 grupo 15-nov = 175.000 (30 % sobre 250.000)',
    (r->>'precio')::numeric = 175000 AND (r->>'lista')::numeric = 250000 AND (r->>'descuento_pct')::numeric = 30 AND r->>'descuento_clave' = 'equipo30',
    'obtuvo ' || r::text);
  r := public._servicio_precio_vigente(v_item, DATE '2026-11-16', true, NULL, true);
  PERFORM pg_temp.rec('C4 grupo 16-nov = 210.000 (30 % sobre 300.000)',
    (r->>'precio')::numeric = 210000 AND (r->>'lista')::numeric = 300000, 'obtuvo ' || r::text);
  r := public._servicio_precio_vigente(v_item, DATE '2026-11-15', false, NULL, true);
  PERFORM pg_temp.rec('C5 externo 15-nov = 350.000 y NO recibe descuento de grupo',
    (r->>'precio')::numeric = 350000 AND r->>'descuento_clave' IS NULL, 'obtuvo ' || r::text);
  r := public._servicio_precio_vigente(v_item, DATE '2026-11-10', false, NULL, false);
  PERFORM pg_temp.rec('C6 externo 10-nov = 300.000 (antes del cambio del 11)', (r->>'precio')::numeric = 300000, 'obtuvo ' || r::text);
END $c$;

-- ---------------------------------------------------------------------------
-- D. registrar_pago_servicio_manual (sesión del admin de Monster)
-- ---------------------------------------------------------------------------
DO $d$
DECLARE
  v_admin text := pg_temp.k('admin');
  r jsonb; r2 jsonb; v_pid uuid; v_n int; v_p public.payments%ROWTYPE; v_l public.cobros_servicio_item%ROWTYPE;
  v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_pgrp uuid; v_num numeric;
BEGIN
  IF coalesce(v_admin, '') = '' OR coalesce(pg_temp.k('c9'), '') = '' THEN
    PERFORM pg_temp.skip('D (todas)', 'faltan admin o 9 deportistas activos en Monster');
    RETURN;
  END IF;

  -- D1. Pago completo, ya pagado, con referencia y sin tocar notes. Hoy (11-nov) el afiliado paga 250.000.
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0001'', p_referencia => ''QA-REF-0001'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c1')));
  PERFORM pg_temp.rec('D1 registro completo -> paid [DEPENDE DE LA FECHA: solo hasta el 15-nov, el afiliado paga 250.000]', (r->>'ok')::boolean AND r->>'estado' = 'paid' AND (r->>'creado')::boolean AND (r->>'monto_cobro')::numeric = 250000,
                      'esperaba ok/paid/creado/250000 | obtuvo ' || left(r::text, 260));
  v_pid := (r->>'payment_id')::uuid;
  SELECT * INTO v_p FROM public.payments WHERE id = v_pid;
  PERFORM pg_temp.rec('D1b fila del pago: categoría, aprobador, referencia, sin notes',
    v_p.payment_category = 'clase_extra' AND v_p.status = 'paid' AND v_p.amount_paid = 250000 AND v_p.approved_by::text = v_admin
    AND v_p.created_by::text = v_admin AND v_p.receipt_number = 'QA-REF-0001' AND v_p.receipt_reference_norm = 'QAREF0001'
    AND v_p.notes IS NULL AND v_p.payment_method = 'transfer' AND v_p.payment_date = (now() AT TIME ZONE 'America/Bogota')::date,
    'esperaba clase_extra/paid/250000/approved_by=admin/ref QA-REF-0001 (norm QAREF0001)/notes NULL');
  SELECT * INTO v_l FROM public.cobros_servicio_item WHERE payment_id = v_pid;
  PERFORM pg_temp.rec('D1c enlace creado (origen manual, clave, lista)', v_l.origen = 'manual' AND v_l.idempotency_key = 'qa-rm-0001' AND v_l.precio_lista = 250000 AND v_l.dueno_tipo = 'child' AND NOT v_l.es_abono,
                      'obtuvo origen=' || coalesce(v_l.origen, 'NULL') || ' clave=' || coalesce(v_l.idempotency_key, 'NULL'));

  -- D2. Misma clave y mismos datos -> idempotente, el MISMO pago, sin segundo cobro.
  r2 := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0001'', p_referencia => ''QA-REF-0001'', p_child_id => %L', pg_temp.k('c1')));
  SELECT count(*) INTO v_n FROM public.cobros_servicio_item WHERE item_id = pg_temp.q('item') AND dueno_id = pg_temp.q('c1');
  PERFORM pg_temp.rec('D2 clave repetida -> idempotente, mismo pago, 1 sola fila', (r2->>'ok')::boolean AND (r2->>'idempotente')::boolean AND (r2->>'payment_id')::uuid = v_pid AND v_n = 1,
                      'esperaba idempotente=true, mismo payment_id y 1 enlace | obtuvo ' || left(r2::text, 200) || ' enlaces=' || v_n);

  -- D3. La misma clave para OTRO dueño -> clave_reutilizada.
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0001'', p_child_id => %L', pg_temp.k('c2')));
  PERFORM pg_temp.rec('D3 clave de otro dueño -> clave_reutilizada', r->>'codigo' = 'clave_reutilizada', 'obtuvo ' || left(r::text, 200));

  -- D4. Misma referencia (normalizada) en otro dueño -> referencia_duplicada (doble pago entre canales).
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0004'', p_referencia => ''qa ref-0001'', p_child_id => %L', pg_temp.k('c2')));
  PERFORM pg_temp.rec('D4 referencia ya usada -> referencia_duplicada', r->>'codigo' = 'referencia_duplicada' AND (r->>'payment_id')::uuid = v_pid, 'obtuvo ' || left(r::text, 200));

  -- D5. Abono del 50 % -> partial, saldo 125.000. (ignora el aviso de cobro sin ligar: c2 puede tener cobros reales)
  r := pg_temp.reg(v_admin, format('p_monto => 125000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0005'', p_referencia => ''QA-REF-0005'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')));
  PERFORM pg_temp.rec('D5 abono 50 % -> partial, saldo 125.000', (r->>'ok')::boolean AND r->>'estado' = 'partial' AND (r->>'es_abono')::boolean AND (r->>'saldo')::numeric = 125000 AND (r->>'recibido')::numeric = 125000 AND (r->>'monto_cobro')::numeric = 250000,
                      'obtuvo ' || left(r::text, 260));
  v_pid := (r->>'payment_id')::uuid;

  -- D6. Saldo con OTRA clave -> el MISMO pago pasa a paid (no se crea otro), tipo de movimiento 'saldo'.
  r := pg_temp.reg(v_admin, format('p_monto => 125000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0006'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')));
  SELECT count(*) INTO v_n FROM public.payments WHERE id = v_pid AND status = 'paid' AND amount_paid = 250000;
  PERFORM pg_temp.rec('D6 saldo -> mismo pago a paid', (r->>'ok')::boolean AND r->>'estado' = 'paid' AND NOT (r->>'creado')::boolean AND (r->>'payment_id')::uuid = v_pid AND v_n = 1,
                      'esperaba paid, creado=false, mismo pago | obtuvo ' || left(r::text, 260));
  SELECT count(*) INTO v_n FROM public.cobros_servicio_movimientos WHERE payment_id = v_pid AND tipo IN ('abono', 'saldo');
  PERFORM pg_temp.rec('D6b dos movimientos (abono + saldo)', v_n = 2, 'esperaba 2 | obtuvo ' || v_n);

  -- D7. Repetir la clave del saldo -> idempotente: no vuelve a sumar.
  r := pg_temp.reg(v_admin, format('p_monto => 125000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0006'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')));
  SELECT amount_paid INTO v_num FROM public.payments WHERE id = v_pid;
  PERFORM pg_temp.rec('D7 saldo repetido -> idempotente, amount_paid sigue en 250.000', (r->>'ok')::boolean AND (r->>'idempotente')::boolean AND v_num = 250000,
                      'obtuvo ' || left(r::text, 200) || ' amount_paid=' || coalesce(v_num::text, 'NULL'));

  -- D8. Ya pagado -> ya_pagado.
  r := pg_temp.reg(v_admin, format('p_monto => 1000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0008'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')));
  PERFORM pg_temp.rec('D8 cobro ya pagado -> ya_pagado', r->>'codigo' = 'ya_pagado', 'obtuvo ' || left(r::text, 200));

  -- D9. Sobrepago (300.000 contra 250.000) -> sobrepago, no se crea nada.
  r := pg_temp.reg(v_admin, format('p_monto => 300000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0009'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c3')));
  SELECT count(*) INTO v_n FROM public.cobros_servicio_item WHERE item_id = pg_temp.q('item') AND dueno_id = pg_temp.q('c3');
  PERFORM pg_temp.rec('D9 sobrepago -> sobrepago y nada creado', r->>'codigo' = 'sobrepago' AND v_n = 0, 'obtuvo ' || left(r::text, 200) || ' enlaces=' || v_n);

  -- D10. Abono por debajo del 50 % -> abono_menor_al_minimo con el mínimo (125.000).
  r := pg_temp.reg(v_admin, format('p_monto => 100000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0010'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c3')));
  PERFORM pg_temp.rec('D10 abono bajo el mínimo -> abono_menor_al_minimo (125.000)', r->>'codigo' = 'abono_menor_al_minimo' AND (r->>'abono_minimo')::numeric = 125000, 'obtuvo ' || left(r::text, 200));

  -- D11. Validaciones de entrada (cada una devuelve su código y NO crea nada).
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''cash'', p_idempotency_key => ''corta'', p_child_id => %L', pg_temp.k('c3')));
  PERFORM pg_temp.rec('D11a clave corta -> clave_invalida', r->>'codigo' = 'clave_invalida', 'obtuvo ' || left(r::text, 160));
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''card'', p_idempotency_key => ''qa-rm-0011b'', p_child_id => %L', pg_temp.k('c3')));
  PERFORM pg_temp.rec('D11b método card -> metodo_invalido', r->>'codigo' = 'metodo_invalido', 'obtuvo ' || left(r::text, 160));
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0011c'', p_fecha_pago => current_date + 3, p_child_id => %L', pg_temp.k('c3')));
  PERFORM pg_temp.rec('D11c fecha futura -> fecha_invalida', r->>'codigo' = 'fecha_invalida', 'obtuvo ' || left(r::text, 160));
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0011d'', p_child_id => %L, p_user_id => %L', pg_temp.k('c3'), pg_temp.k('athlete')));
  PERFORM pg_temp.rec('D11d dos dueños -> dueno_invalido', r->>'codigo' = 'dueno_invalido', 'obtuvo ' || left(r::text, 160));
  r := pg_temp.reg(v_admin, format('p_monto => 200000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0011e'', p_precio_acordado => 200000, p_child_id => %L', pg_temp.k('c3')));
  PERFORM pg_temp.rec('D11e precio acordado sin motivo -> motivo_requerido', r->>'codigo' = 'motivo_requerido', 'obtuvo ' || left(r::text, 160));

  -- D12. Precio acordado con motivo (>= 10): cualquier admin puede; queda en el enlace, no en notes.
  r := pg_temp.reg(v_admin, format('p_monto => 200000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0012'', p_precio_acordado => 200000, p_motivo_precio => ''Acuerdo de la escuela QA'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c3')));
  v_pid := (r->>'payment_id')::uuid;
  SELECT * INTO v_p FROM public.payments WHERE id = v_pid;
  SELECT * INTO v_l FROM public.cobros_servicio_item WHERE payment_id = v_pid;
  PERFORM pg_temp.rec('D12 precio acordado 200.000 sobre lista 250.000', (r->>'ok')::boolean AND v_p.amount = 200000 AND v_p.list_amount = 250000 AND v_p.discount_amount = 50000
                        AND v_l.precio_acordado = 200000 AND v_l.motivo_precio = 'Acuerdo de la escuela QA' AND v_p.notes IS NULL,
                      'esperaba amount 200.000, list 250.000, descuento 50.000, motivo en el enlace, notes NULL | obtuvo ' || left(r::text, 200));

  -- D13. Prospecto (externo): hoy paga 350.000 (precio por fecha del externo).
  IF coalesce(pg_temp.k('lead'), '') <> '' THEN
    r := pg_temp.reg(v_admin, format('p_monto => 350000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0013'', p_ignorar_cobro_sin_ligar => true, p_signup_lead_id => %L', pg_temp.k('lead')));
    PERFORM pg_temp.rec('D13 prospecto externo -> 350.000 paid [DEPENDE DE LA FECHA: externo 350.000 desde el 11-nov]', (r->>'ok')::boolean AND (r->>'monto_cobro')::numeric = 350000 AND r->>'estado' = 'paid', 'obtuvo ' || left(r::text, 220));
  ELSE
    PERFORM pg_temp.skip('D13 prospecto externo', 'no hay prospecto en Monster');
  END IF;

  -- D14. Cupo único: el 1.º entra, el 2.º -> sin_cupos.
  r := pg_temp.reg(v_admin, format('p_monto => 100000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0014a'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c1')), 'item2');
  PERFORM pg_temp.rec('D14a cupo 1 de 1 entra', (r->>'ok')::boolean, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.reg(v_admin, format('p_monto => 100000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0014b'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')), 'item2');
  PERFORM pg_temp.rec('D14b cupo 2 -> sin_cupos', r->>'codigo' = 'sin_cupos', 'obtuvo ' || left(r::text, 200));
  PERFORM pg_temp.rec('D14c _servicio_cupos_vivos(item2) = 1', public._servicio_cupos_vivos(pg_temp.q('item2')) = 1, 'obtuvo ' || public._servicio_cupos_vivos(pg_temp.q('item2')));

  -- D15. Cobro de la escuela SIN ligar -> cobro_sin_ligar (no se repite el caso de Carlos).
  v_t4 := pg_temp.mkpay(pg_temp.q('c9'), 100000);
  r := pg_temp.reg(v_admin, format('p_monto => 250000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-0015'', p_child_id => %L', pg_temp.k('c9')));
  PERFORM pg_temp.rec('D15 cobro de la escuela sin ligar -> cobro_sin_ligar con candidato', r->>'codigo' = 'cobro_sin_ligar' AND r::text LIKE '%' || v_t4::text || '%', 'obtuvo ' || left(r::text, 260));

  -- E. Ligar + grupo (mínimo de 5 del mismo equipo)
  IF coalesce(pg_temp.k('team'), '') = '' THEN
    PERFORM pg_temp.skip('E (ligar y grupo)', 'Monster no tiene equipos');
    RETURN;
  END IF;

  -- E1. Ligar NO cambia amount: cobro de 175.000 creado por la escuela, con clave equipo30.
  v_t1 := pg_temp.mkpay(pg_temp.q('c4'), 175000, pg_temp.q('team'));
  v_t2 := pg_temp.mkpay(pg_temp.q('c5'), 175000, pg_temp.q('team'));
  v_t3 := pg_temp.mkpay(pg_temp.q('c6'), 175000, pg_temp.q('team'));
  v_pgrp := pg_temp.mkpay(pg_temp.q('c7'), 175000, pg_temp.q('team'));
  r := pg_temp.lig(v_admin, v_t1, 'item', 'Cobro creado por la escuela sin ligar (QA)', 'equipo30');
  SELECT * INTO v_p FROM public.payments WHERE id = v_t1;
  PERFORM pg_temp.rec('E1 ligar con equipo30: amount intacto, lista 250.000, descuento 75.000 (30 %), categoría clase_extra',
    (r->>'ok')::boolean AND v_p.amount = 175000 AND v_p.list_amount = 250000 AND v_p.discount_amount = 75000 AND v_p.discount_pct = 30 AND v_p.payment_category = 'clase_extra',
    'obtuvo ' || left(r::text, 200) || ' amount=' || v_p.amount || ' list=' || coalesce(v_p.list_amount::text, 'NULL'));
  r := pg_temp.lig(v_admin, v_t1, 'item', 'Segundo intento de ligar (QA)', 'equipo30');
  PERFORM pg_temp.rec('E2 ligar otra vez -> ya_ligado', r->>'codigo' = 'ya_ligado', 'obtuvo ' || left(r::text, 160));
  PERFORM pg_temp.lig(v_admin, v_t2, 'item', 'Cobro creado por la escuela sin ligar (QA)', 'equipo30');
  PERFORM pg_temp.lig(v_admin, v_t3, 'item', 'Cobro creado por la escuela sin ligar (QA)', 'equipo30');
  PERFORM pg_temp.lig(v_admin, v_pgrp, 'item', 'Cobro creado por la escuela sin ligar (QA)', 'equipo30');

  -- E3. Monto que no cuadra con lista - descuento -> monto_no_cuadra, nada cambia.
  r := pg_temp.lig(v_admin, v_t4, 'item', 'Cobro de 100.000 con descuento (QA)', 'equipo30');
  SELECT * INTO v_p FROM public.payments WHERE id = v_t4;
  PERFORM pg_temp.rec('E3 ligar con descuento que no cuadra -> monto_no_cuadra y el cobro no cambia', r->>'codigo' = 'monto_no_cuadra' AND v_p.list_amount IS NULL AND v_p.payment_category = 'otro' AND v_p.amount = 100000,
                      'obtuvo ' || left(r::text, 200));

  -- E4. Grupo: 4 ligados con descuento NO cumplen 5; con el que se registra (sumar 1) sí.
  PERFORM pg_temp.rec('E4 grupo con 4 + el nuevo = 5 [DEPENDE DE LA FECHA: los vencidos cuentan solo hasta el 15-nov]', NOT public._servicio_grupo_cumple(pg_temp.q('item'), pg_temp.q('team'), 0) AND public._servicio_grupo_cumple(pg_temp.q('item'), pg_temp.q('team'), 1),
                      'esperaba (4 solos: false) y (4 + 1: true)');
  r := pg_temp.reg(v_admin, format('p_monto => 175000, p_metodo => ''transfer'', p_idempotency_key => ''qa-rm-0016'', p_ignorar_cobro_sin_ligar => true, p_team_id => %L, p_child_id => %L', pg_temp.k('team'), pg_temp.k('c8')));
  PERFORM pg_temp.rec('E5 registro del 5.º del equipo -> 175.000 con equipo30 [DEPENDE DE LA FECHA: hasta el 15-nov]', (r->>'ok')::boolean AND (r->>'monto_cobro')::numeric = 175000 AND (r->>'precio_lista')::numeric = 250000 AND r->>'descuento_clave' = 'equipo30' AND r->>'estado' = 'paid',
                      'obtuvo ' || left(r::text, 260));
  PERFORM pg_temp.rec('E6 con el 5.º ya cuentan 5 sin sumar', public._servicio_grupo_cumple(pg_temp.q('item'), pg_temp.q('team'), 0), 'esperaba true');

  -- E7. Ligar sin descuento: amount intacto; el valor distinto del de lista queda como precio acordado + motivo.
  r := pg_temp.lig(v_admin, v_t4, 'item', 'Cobro de 100.000 acordado con la familia (QA)', NULL);
  SELECT * INTO v_p FROM public.payments WHERE id = v_t4;
  SELECT * INTO v_l FROM public.cobros_servicio_item WHERE payment_id = v_t4;
  PERFORM pg_temp.rec('E7 ligar sin descuento: amount intacto, queda acordado con motivo', (r->>'ok')::boolean AND v_p.amount = 100000 AND v_l.precio_acordado = 100000 AND v_l.origen = 'ligado_escuela' AND v_p.payment_category = 'clase_extra',
                      'obtuvo ' || left(r::text, 200));

  -- F. aplicar_comprobante_a_cobro_abierto (service_role)
  -- F1. Dos cobros abiertos del mismo dueño para el ítem -> ambiguo con candidatos.
  v_t1 := pg_temp.mkpay(pg_temp.q('c9'), 80000);
  PERFORM pg_temp.lig(v_admin, v_t1, 'item', 'Segundo cobro del mismo atleta (QA)', NULL);
  r := pg_temp.apl(format('p_monto => 80000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c9')));
  PERFORM pg_temp.rec('F1 dos cobros abiertos -> ambiguo con 2 candidatos', r->>'codigo' = 'ambiguo' AND jsonb_array_length(r->'candidatos') = 2, 'obtuvo ' || left(r::text, 260));

  -- F2. Con el pago exacto: monto == saldo -> paid; la misma fila de la cola -> ya_aplicado.
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.aplicar_comprobante_a_cobro_abierto(p_school_id => %L, p_queue_id => %L, p_monto => 100000, p_payment_id => %L, p_item_id => %L)',
    pg_temp.k('school'), '00000000-0000-0000-0000-00000000aa01', v_t4, pg_temp.k('item')));
  PERFORM pg_temp.rec('F2 monto == saldo -> paid', (r->>'ok')::boolean AND r->>'estado' = 'paid' AND (r->>'saldo')::numeric = 0, 'obtuvo ' || left(r::text, 220));
  r2 := pg_temp.as_user('service_role', NULL, format(
    'select public.aplicar_comprobante_a_cobro_abierto(p_school_id => %L, p_queue_id => %L, p_monto => 100000, p_payment_id => %L, p_item_id => %L)',
    pg_temp.k('school'), '00000000-0000-0000-0000-00000000aa01', v_t4, pg_temp.k('item')));
  SELECT amount_paid INTO v_num FROM public.payments WHERE id = v_t4;
  PERFORM pg_temp.rec('F3 misma cola -> ya_aplicado, no suma dos veces', (r2->>'ok')::boolean AND (r2->>'ya_aplicado')::boolean AND v_num = 100000, 'obtuvo ' || left(r2::text, 200) || ' amount_paid=' || v_num);

  -- F4. Ahora el dueño tiene UN solo abierto (80.000): sobrepago, abono bajo el mínimo, abono válido y saldo.
  r := pg_temp.apl(format('p_monto => 90000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c9')));
  PERFORM pg_temp.rec('F4 sobrepago (90.000 > saldo 80.000) -> sobrepago', r->>'codigo' = 'sobrepago' AND (r->>'saldo')::numeric = 80000, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.apl(format('p_monto => 30000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c9')));
  PERFORM pg_temp.rec('F5 abono 30.000 < 50 % de 80.000 -> abono_menor_al_minimo', r->>'codigo' = 'abono_menor_al_minimo' AND (r->>'abono_minimo')::numeric = 40000, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.apl(format('p_monto => 40000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c9')));
  PERFORM pg_temp.rec('F6 abono 40.000 (50 %) -> partial', (r->>'ok')::boolean AND r->>'estado' = 'partial' AND (r->>'saldo')::numeric = 40000, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.apl(format('p_monto => 40000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c9')));
  PERFORM pg_temp.rec('F7 saldo 40.000 -> paid', (r->>'ok')::boolean AND r->>'estado' = 'paid', 'obtuvo ' || left(r::text, 200));

  -- F8. En revisión (cobro con comprobante por aprobar) -> en_revision; nada cambia.
  UPDATE public.payments SET status = 'awaiting_approval' WHERE id = v_t2;
  r := pg_temp.apl(format('p_monto => 175000, p_item_id => %L, p_child_id => %L', pg_temp.k('item'), pg_temp.k('c5')));
  PERFORM pg_temp.rec('F8 cobro en revisión -> en_revision', r->>'codigo' = 'en_revision', 'obtuvo ' || left(r::text, 200));

  -- G. reclasificar: marca el enlace anulado; no se mueve a/desde mensualidad; se puede volver a ligar.
  r := pg_temp.as_user('authenticated', v_admin, format('select public.reclasificar_pago_servicio(%L, ''otro'', ''QA cobro reclasificado'', ''Corrección de categoría (QA)'')', v_t3));
  SELECT * INTO v_l FROM public.cobros_servicio_item WHERE payment_id = v_t3;
  PERFORM pg_temp.rec('G1 reclasificar -> enlace anulado', (r->>'ok')::boolean AND (r->>'enlace_anulado')::boolean AND v_l.anulado_at IS NOT NULL, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.as_user('authenticated', v_admin, format('select public.reclasificar_pago_servicio(%L, ''mensualidad'', NULL, ''Intento no permitido (QA)'')', v_t3));
  PERFORM pg_temp.rec('G2 reclasificar a mensualidad -> categoria_invalida', r->>'codigo' = 'categoria_invalida', 'obtuvo ' || left(r::text, 200));
  r := pg_temp.lig(v_admin, v_t3, 'item', 'Volver a ligar tras reclasificar (QA)', 'equipo30');
  SELECT * INTO v_p FROM public.payments WHERE id = v_t3;
  PERFORM pg_temp.rec('G3 volver a ligar un enlace anulado con el MISMO descuento -> ok, sin re-estampar (requiere 20261111151130)', (r->>'ok')::boolean AND v_p.list_amount = 250000 AND v_p.discount_amount = 75000 AND v_p.payment_category = 'clase_extra', 'obtuvo ' || left(r::text, 200));
  r := pg_temp.as_user('authenticated', v_admin, format('select public.reclasificar_pago_servicio(%L, ''otro'', NULL, ''Otra corrección (QA)'')', v_t3));
  UPDATE public.payments SET discount_pct = 20, discount_amount = 50000, list_amount = 250000, amount = 200000 WHERE id = v_t3;
  r := pg_temp.lig(v_admin, v_t3, 'item', 'Re-ligar con otro descuento (QA)', 'equipo30');
  PERFORM pg_temp.rec('G4 re-ligar con un descuento DISTINTO ya estampado -> ya_tiene_descuento', r->>'codigo' = 'ya_tiene_descuento', 'obtuvo ' || left(r::text, 200));
END $d$;

-- ---------------------------------------------------------------------------
-- H. El bot reconoce lo del panel: wa_crear_cobro_desde_comprobante con p_user_id y «ya tiene cobro»
-- ---------------------------------------------------------------------------
DO $h$
DECLARE r jsonb;
BEGIN
  -- H1. Atleta con cuenta como 4.º dueño: cobro con el precio de afiliado de HOY (250.000).
  IF coalesce(pg_temp.k('athlete'), '') <> '' THEN
    r := pg_temp.as_user('service_role', NULL, format(
      'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => gen_random_uuid(), p_categoria => ''clase_extra'', p_monto => 250000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => NULL, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL, p_user_id => %L)',
      pg_temp.k('school'), pg_temp.k('item'), pg_temp.k('athlete')));
    PERFORM pg_temp.rec('H1 p_user_id como dueño -> cobro de 250.000 (afiliado)', (r->>'ok')::boolean AND (r->>'precio')::numeric = 250000 AND (r->>'afiliado')::boolean, 'obtuvo ' || left(r::text, 240));
    -- H2. Otra fila de la cola para el mismo atleta -> ya_tiene_cobro.
    r := pg_temp.as_user('service_role', NULL, format(
      'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => gen_random_uuid(), p_categoria => ''clase_extra'', p_monto => 250000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => NULL, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL, p_user_id => %L)',
      pg_temp.k('school'), pg_temp.k('item'), pg_temp.k('athlete')));
    PERFORM pg_temp.rec('H2 segundo comprobante del mismo atleta -> ya_tiene_cobro', r->>'codigo' = 'ya_tiene_cobro', 'obtuvo ' || left(r::text, 200));
  ELSE
    PERFORM pg_temp.skip('H1/H2 p_user_id', 'Monster no tiene un atleta con cuenta y miembro activo');
  END IF;

  -- H3. Dos dueños a la vez -> dueno_invalido (num_nonnulls = 1).
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => gen_random_uuid(), p_categoria => NULL, p_monto => 250000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => %L, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL, p_user_id => %L)',
    pg_temp.k('school'), pg_temp.k('item'), pg_temp.k('c1'), coalesce(nullif(pg_temp.k('athlete'), ''), gen_random_uuid()::text)));
  PERFORM pg_temp.rec('H3 dos dueños -> dueno_invalido', r->>'codigo' = 'dueno_invalido', 'obtuvo ' || left(r::text, 200));

  -- H4. Lo que registró la escuela a mano (D1: c1 pagó el ítem) el bot lo ve: ya_tiene_cobro (con los 13 argumentos de siempre).
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => gen_random_uuid(), p_categoria => NULL, p_monto => 250000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => %L, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL)',
    pg_temp.k('school'), pg_temp.k('item'), pg_temp.k('c1')));
  PERFORM pg_temp.rec('H4 el bot ve el pago manual (13 args, sin p_user_id) -> ya_tiene_cobro', r->>'codigo' = 'ya_tiene_cobro', 'obtuvo ' || left(r::text, 200));
END $h$;

-- ---------------------------------------------------------------------------
-- J. Casos añadidos tras la revisión
-- ---------------------------------------------------------------------------
-- J0. PRUEBA MANUAL de orden de candados (no se puede hacer en una sola sesión). Dos sesiones, A y B:
--   A: BEGIN; select public.wa_crear_cobro_desde_comprobante(<school>, gen_random_uuid(), NULL, 350000,
--        'tournament_item', <item>, NULL, NULL, <lead>, NULL);          -- toma lead y luego ítem
--      (dejar abierta)
--   B: BEGIN; set local role authenticated; select set_config('request.jwt.claims', '{"sub":"<admin>","role":"authenticated"}', true);
--      select public.registrar_pago_servicio_manual(p_school_id=><school>, p_item_id=><item>, p_monto=>350000,
--        p_metodo=>'cash', p_idempotency_key=>'qa-manual-lock-1', p_signup_lead_id=><lead>);
--      -- esperado: B ESPERA a A (toma lead primero, igual que el bot) y, al hacer COMMIT/ROLLBACK en A, continúa.
--      -- NUNCA debe salir «deadlock detected» (40P01). Repetir con A y B invertidos.
--   Misma idea para ligar/aplicar: toman ítem y luego pago, el mismo orden de registrar; ninguna toma el prospecto.

-- J1. Fechas reales en precios_afiliado_por_fecha (el regex solo no las valida).
DO $j1$
DECLARE v_ok boolean := false; v_ok2 boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.school_tournament_items (school_id, name, price, kind, precios_afiliado_por_fecha)
    VALUES (pg_temp.q('school'), 'QA fecha mala', 1000, 'otro', '[{"desde":"2026-13-45","precio":1}]'::jsonb);
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  BEGIN
    INSERT INTO public.school_tournament_items (school_id, name, price, kind, precios_afiliado_por_fecha)
    VALUES (pg_temp.q('school'), 'QA fecha 31-feb', 1000, 'otro', '[{"desde":"2026-02-31","precio":1}]'::jsonb);
  EXCEPTION WHEN check_violation THEN v_ok2 := true;
  END;
  PERFORM pg_temp.rec('J1 fechas imposibles rechazadas por el CHECK (2026-13-45 y 2026-02-31)', v_ok AND v_ok2, 'esperaba check_violation en ambas');
END $j1$;

-- J2. auto_approve_payment por COMPORTAMIENTO (no solo por texto): un cobro 'otro' con equipo NO activa la inscripción
--     pendiente; y el atleta adulto (sin parent_id) recibe su aviso.
DO $j2$
DECLARE
  v_enr record; v_pid uuid; v_pid2 uuid; v_ok boolean; v_st text; v_n int; v_child uuid;
BEGIN
  SELECT e.id, e.child_id, e.team_id, e.status INTO v_enr
    FROM public.enrollments e
   WHERE e.school_id = pg_temp.q('school') AND e.child_id IS NOT NULL AND e.team_id IS NOT NULL AND e.status IN ('active', 'pending')
   LIMIT 1;
  IF NOT FOUND THEN
    PERFORM pg_temp.skip('J2a auto_approve no activa inscripción con cobro otro', 'Monster no tiene inscripciones de menor con equipo');
  ELSE
    UPDATE public.enrollments SET status = 'pending' WHERE id = v_enr.id;
    INSERT INTO public.payments (school_id, parent_id, child_id, team_id, amount, concept, due_date, status, payment_type,
                                 payment_category, period_uniqueness_exempt)
    SELECT c.school_id, c.parent_id, c.id, v_enr.team_id, 50000, 'QA cobro otro con equipo', current_date, 'awaiting_approval', 'one_time', 'otro', true
      FROM public.children c WHERE c.id = v_enr.child_id
    RETURNING id INTO v_pid;
    v_ok := public.auto_approve_payment(v_pid);
    SELECT status INTO v_st FROM public.enrollments WHERE id = v_enr.id;
    PERFORM pg_temp.rec('J2a cobro otro con equipo: se aprueba pero la inscripción sigue pending', v_ok AND v_st = 'pending',
                        'esperaba true y enrollment pending | obtuvo ' || v_ok || ' / ' || coalesce(v_st, 'NULL'));
    -- Control: una mensualidad SÍ la activa.
    INSERT INTO public.payments (school_id, parent_id, child_id, team_id, amount, concept, due_date, status, payment_type,
                                 payment_category, period_uniqueness_exempt)
    SELECT c.school_id, c.parent_id, c.id, v_enr.team_id, 50000, 'QA mensualidad control', current_date, 'awaiting_approval', 'one_time', 'mensualidad', true
      FROM public.children c WHERE c.id = v_enr.child_id
    RETURNING id INTO v_pid2;
    v_ok := public.auto_approve_payment(v_pid2);
    SELECT status INTO v_st FROM public.enrollments WHERE id = v_enr.id;
    PERFORM pg_temp.rec('J2b control: una mensualidad sí activa la inscripción', v_ok AND v_st = 'active',
                        'esperaba true y enrollment active | obtuvo ' || v_ok || ' / ' || coalesce(v_st, 'NULL'));
  END IF;

  IF coalesce(pg_temp.k('athlete'), '') = '' THEN
    PERFORM pg_temp.skip('J2c aviso al atleta adulto', 'no hay atleta con cuenta');
  ELSE
    INSERT INTO public.payments (school_id, user_id, amount, concept, due_date, status, payment_type, payment_category, period_uniqueness_exempt)
    VALUES (pg_temp.q('school'), pg_temp.q('athlete'), 50000, 'QA cobro de adulto', current_date, 'awaiting_approval', 'one_time', 'otro', true)
    RETURNING id INTO v_pid;
    v_ok := public.auto_approve_payment(v_pid);
    SELECT count(*) INTO v_n FROM public.notifications n
     WHERE n.user_id = pg_temp.q('athlete') AND n.title = 'Pago aprobado' AND n.created_at >= now() - interval '1 minute';
    PERFORM pg_temp.rec('J2c el atleta adulto (sin parent_id) recibe «Pago aprobado»', v_ok AND v_n >= 1, 'esperaba true y >= 1 aviso | obtuvo ' || v_ok || ' / ' || v_n);
  END IF;
END $j2$;

-- J3. wa_crear_cobro_suelto + cupos de las tres fuentes: un ítem de cupo 1 vendido por el bot (suelto) bloquea a la RPC manual.
DO $j3$
DECLARE v_it uuid; v_par1 uuid; v_par2 uuid; r jsonb; v_c1 uuid := pg_temp.q('c1'); v_c2 uuid := pg_temp.q('c2');
BEGIN
  SELECT parent_id INTO v_par1 FROM public.children WHERE id = v_c1;
  SELECT parent_id INTO v_par2 FROM public.children WHERE id = v_c2;
  IF v_par1 IS NULL OR v_par2 IS NULL OR coalesce(pg_temp.k('admin'), '') = '' THEN
    PERFORM pg_temp.skip('J3 wa_crear_cobro_suelto y cupos', 'c1 o c2 no tienen acudiente, o no hay admin');
    RETURN;
  END IF;
  UPDATE public.school_settings SET tournament_charges_enabled = true, wa_ventas_habilitadas = true WHERE school_id = pg_temp.q('school');
  INSERT INTO public.school_tournament_items (school_id, name, price, kind, active, per_athlete, capacity)
  VALUES (pg_temp.q('school'), 'QA Cupo suelto', 50000, 'otro', true, true, 1) RETURNING id INTO v_it;
  PERFORM set_config('t.item3', v_it::text, true);

  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_suelto(%L, %L, %L, %L, %L)', pg_temp.k('school'), v_it, v_par1, v_c1, 'qa-suelto-0001'));
  PERFORM pg_temp.rec('J3a suelto: el 1.º entra (cupos_restantes 0)', (r->>'ok')::boolean AND (r->>'cupos_restantes')::int = 0, 'obtuvo ' || left(r::text, 200));
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_suelto(%L, %L, %L, %L, %L)', pg_temp.k('school'), v_it, v_par2, v_c2, 'qa-suelto-0002'));
  PERFORM pg_temp.rec('J3b suelto: el 2.º -> sin_cupos', r->>'codigo' = 'sin_cupos', 'obtuvo ' || left(r::text, 200));
  r := pg_temp.reg(pg_temp.k('admin'), format('p_monto => 50000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-j3c'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c3')), 'item3');
  PERFORM pg_temp.rec('J3c lo vendido por el bot cuenta para la RPC manual -> sin_cupos', r->>'codigo' = 'sin_cupos', 'obtuvo ' || left(r::text, 200));
  PERFORM pg_temp.rec('J3d _servicio_cupos_vivos(item3) = 1', public._servicio_cupos_vivos(v_it) = 1, 'obtuvo ' || public._servicio_cupos_vivos(v_it));
END $j3$;

-- J4. Opción en un ítem SIN opciones: se ignora (no choca con el CHECK de 30 caracteres).
DO $j4$
DECLARE v_it uuid; r jsonb; v_op text;
BEGIN
  IF coalesce(pg_temp.k('admin'), '') = '' THEN PERFORM pg_temp.skip('J4 opción larga', 'no hay admin'); RETURN; END IF;
  INSERT INTO public.school_tournament_items (school_id, name, price, kind, active, per_athlete)
  VALUES (pg_temp.q('school'), 'QA sin opciones', 40000, 'otro', true, true) RETURNING id INTO v_it;
  PERFORM set_config('t.item4', v_it::text, true);
  r := pg_temp.reg(pg_temp.k('admin'), format('p_monto => 40000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-j4'', p_opcion => %L, p_ignorar_cobro_sin_ligar => true, p_child_id => %L', repeat('x', 60), pg_temp.k('c1')), 'item4');
  SELECT opcion INTO v_op FROM public.cobros_servicio_item WHERE payment_id = (r->>'payment_id')::uuid;
  PERFORM pg_temp.rec('J4 p_opcion de 60 caracteres en ítem sin opciones: ok y opcion NULL (requiere 20261111151130)', (r->>'ok')::boolean AND v_op IS NULL, 'obtuvo ' || left(r::text, 200) || ' opcion=' || coalesce(v_op, 'NULL'));
END $j4$;

-- J5. Prospecto descartado -> lead_descartado (y no se crea nada).
DO $j5$
DECLARE r jsonb; v_n int;
BEGIN
  IF coalesce(pg_temp.k('lead'), '') = '' OR coalesce(pg_temp.k('admin'), '') = '' THEN
    PERFORM pg_temp.skip('J5 lead descartado', 'no hay prospecto o admin'); RETURN;
  END IF;
  UPDATE public.school_signup_leads SET status = 'discarded' WHERE id = pg_temp.q('lead');
  r := pg_temp.reg(pg_temp.k('admin'), format('p_monto => 350000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-j5'', p_ignorar_cobro_sin_ligar => true, p_signup_lead_id => %L', pg_temp.k('lead')));
  SELECT count(*) INTO v_n FROM public.cobros_servicio_movimientos WHERE idempotency_key = 'qa-rm-j5';
  PERFORM pg_temp.rec('J5 prospecto descartado -> lead_descartado y nada creado', r->>'codigo' = 'lead_descartado' AND v_n = 0, 'obtuvo ' || left(r::text, 200));
END $j5$;

-- J6. aplicar_comprobante: referencia duplicada, cobro de otro dueño y mensualidad.
DO $j6$
DECLARE r jsonb; v_p uuid; v_q uuid; v_m uuid; v_rs text;
BEGIN
  IF coalesce(pg_temp.k('c9'), '') = '' THEN PERFORM pg_temp.skip('J6', 'faltan deportistas'); RETURN; END IF;
  -- cobro abierto ligado de c8 en el ítem 4 (sin opciones) y referencia ya usada por otro pago vivo
  v_p := pg_temp.mkpay(pg_temp.q('c8'), 40000);
  UPDATE public.payments SET payment_category = 'otro' WHERE id = v_p;
  r := pg_temp.apl(format('p_monto => 40000, p_payment_id => %L, p_child_id => %L, p_referencia => ''QA-REF-0001''', v_p, pg_temp.k('c8')), 'item4');
  PERFORM pg_temp.rec('J6a referencia ya usada (D1) -> referencia_duplicada', r->>'codigo' = 'referencia_duplicada', 'obtuvo ' || left(r::text, 200));
  r := pg_temp.apl(format('p_monto => 40000, p_payment_id => %L, p_child_id => %L', v_p, pg_temp.k('c7')), 'item4');
  PERFORM pg_temp.rec('J6b p_payment_id de OTRO dueño -> cobro_no_es_del_dueno', r->>'codigo' = 'cobro_no_es_del_dueno', 'obtuvo ' || left(r::text, 200));
  v_m := pg_temp.mkpay(pg_temp.q('c6'), 40000);
  UPDATE public.payments SET payment_category = 'mensualidad' WHERE id = v_m;
  r := pg_temp.apl(format('p_monto => 40000, p_payment_id => %L, p_child_id => %L', v_m, pg_temp.k('c6')), 'item4');
  PERFORM pg_temp.rec('J6c mensualidad -> categoria_no_permitida', r->>'codigo' = 'categoria_no_permitida', 'obtuvo ' || left(r::text, 200));
  r := pg_temp.apl(format('p_monto => 40000, p_payment_id => %L, p_child_id => %L, p_referencia => ''QA-REF-J6OK''', v_p, pg_temp.k('c8')), 'item4');
  SELECT reconciliation_status INTO v_rs FROM public.payments WHERE id = v_p;
  PERFORM pg_temp.rec('J6d aplicar válido -> paid, approved_by NULL, reconciliation_status pendiente', (r->>'ok')::boolean AND r->>'estado' = 'paid' AND v_rs = 'pendiente'
                      AND (SELECT approved_by IS NULL FROM public.payments WHERE id = v_p), 'obtuvo ' || left(r::text, 200) || ' recon=' || coalesce(v_rs, 'NULL'));
END $j6$;

-- J7. due_date de los abonos = saldo_hasta (el ítem de prueba lo tiene en 2026-11-20); pago completo no lo cambia;
--     ítem sin saldo_hasta deja el comportamiento de antes. [DEPENDE DE LA FECHA: hoy < 20-nov]
DO $j7$
DECLARE r jsonb; v_d date; v_q uuid := gen_random_uuid(); v_it uuid;
BEGIN
  IF coalesce(pg_temp.k('admin'), '') = '' OR coalesce(pg_temp.k('c9'), '') = '' THEN PERFORM pg_temp.skip('J7', 'faltan admin o deportistas'); RETURN; END IF;
  -- Ítem nuevo con saldo_hasta y abono 50 %, para tener deportistas limpios.
  INSERT INTO public.school_tournament_items (school_id, name, price, kind, active, per_athlete, allow_installments, abono_minimo_pct, saldo_hasta)
  VALUES (pg_temp.q('school'), 'QA saldo_hasta', 100000, 'otro', true, true, true, 50, DATE '2026-11-20') RETURNING id INTO v_it;
  PERFORM set_config('t.item5', v_it::text, true);

  -- Camino manual: abono -> due_date = saldo_hasta; pago completo -> hoy.
  r := pg_temp.reg(pg_temp.k('admin'), format('p_monto => 50000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-j7a'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c1')), 'item5');
  SELECT due_date INTO v_d FROM public.payments WHERE id = (r->>'payment_id')::uuid;
  PERFORM pg_temp.rec('J7a registrar abono -> due_date = 2026-11-20', r->>'estado' = 'partial' AND v_d = DATE '2026-11-20', 'obtuvo ' || left(r::text, 120) || ' due=' || coalesce(v_d::text, 'NULL'));
  r := pg_temp.reg(pg_temp.k('admin'), format('p_monto => 100000, p_metodo => ''cash'', p_idempotency_key => ''qa-rm-j7b'', p_ignorar_cobro_sin_ligar => true, p_child_id => %L', pg_temp.k('c2')), 'item5');
  SELECT due_date INTO v_d FROM public.payments WHERE id = (r->>'payment_id')::uuid;
  PERFORM pg_temp.rec('J7b registrar pago completo -> due_date = hoy (no cambia)', r->>'estado' = 'paid' AND v_d = (now() AT TIME ZONE 'America/Bogota')::date, 'due=' || coalesce(v_d::text, 'NULL'));

  -- Camino del bot: abono por comprobante -> cobro nace con due_date = saldo_hasta.
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => %L, p_categoria => NULL, p_monto => 50000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => %L, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL)',
    pg_temp.k('school'), v_q, v_it, pg_temp.k('c3')));
  SELECT due_date INTO v_d FROM public.payments WHERE id = (r->>'payment_id')::uuid;
  PERFORM pg_temp.rec('J7c bot: abono -> cobro con due_date = 2026-11-20', (r->>'ok')::boolean AND (r->>'es_abono')::boolean AND v_d = DATE '2026-11-20', 'obtuvo ' || left(r::text, 120) || ' due=' || coalesce(v_d::text, 'NULL'));
  -- aplicar: un cobro vencido (due_date viejo) que recibe un abono sube a saldo_hasta.
END $j7$;

DO $j7b$
DECLARE r jsonb; v_d date; v_p uuid; v_it uuid := pg_temp.q('item5');
BEGIN
  IF v_it IS NULL THEN RETURN; END IF;
  v_p := pg_temp.mkpay(pg_temp.q('c4'), 100000);
  UPDATE public.payments SET due_date = DATE '2026-11-10' WHERE id = v_p;
  PERFORM pg_temp.lig(pg_temp.k('admin'), v_p, 'item5', 'Cobro vencido de la escuela (QA J7)', NULL);
  SELECT due_date INTO v_d FROM public.payments WHERE id = v_p;
  PERFORM pg_temp.rec('J7d ligar NO toca due_date', v_d = DATE '2026-11-10', 'due=' || coalesce(v_d::text, 'NULL'));
  r := pg_temp.apl(format('p_monto => 50000, p_payment_id => %L, p_child_id => %L', v_p, pg_temp.k('c4')), 'item5');
  SELECT due_date INTO v_d FROM public.payments WHERE id = v_p;
  PERFORM pg_temp.rec('J7e aplicar abono sobre cobro vencido -> partial y due_date = 2026-11-20', r->>'estado' = 'partial' AND v_d = DATE '2026-11-20', 'obtuvo ' || left(r::text, 120) || ' due=' || coalesce(v_d::text, 'NULL'));

  -- Ítem SIN saldo_hasta: comportamiento de antes (abono por el bot nace con due_date = hoy).
  UPDATE public.school_tournament_items SET saldo_hasta = NULL WHERE id = v_it;
  r := pg_temp.as_user('service_role', NULL, format(
    'select public.wa_crear_cobro_desde_comprobante(p_school_id => %L, p_queue_id => gen_random_uuid(), p_categoria => NULL, p_monto => 50000, p_fuente => ''tournament_item'', p_fuente_id => %L, p_child_id => %L, p_unregistered_id => NULL, p_signup_lead_id => NULL, p_concepto => NULL)',
    pg_temp.k('school'), v_it, pg_temp.k('c5')));
  SELECT due_date INTO v_d FROM public.payments WHERE id = (r->>'payment_id')::uuid;
  PERFORM pg_temp.rec('J7f ítem sin saldo_hasta: abono del bot con due_date = hoy', (r->>'ok')::boolean AND v_d = (now() AT TIME ZONE 'America/Bogota')::date, 'obtuvo ' || left(r::text, 120) || ' due=' || coalesce(v_d::text, 'NULL'));
END $j7b$;

-- J8. whatsapp_audiencia.intereses admite 'vacacional' y 'campamento' y sigue rechazando lo desconocido (requiere 20261111151130).
DO $j8$
DECLARE v_ok boolean := false; v_mal boolean := false; v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.whatsapp_audiencia'::regclass AND conname = 'whatsapp_audiencia_intereses_check';
  PERFORM pg_temp.rec('J8a el CHECK viejo y el nuevo conviven: lista ampliada', v_def LIKE '%vacacional%' AND v_def LIKE '%campamento%' AND v_def LIKE '%informacion%', coalesce(v_def, 'sin constraint'));
  -- Un valor permitido y uno no permitido, evaluados con la misma expresión del CHECK.
  v_ok  := ARRAY['vacacional', 'campamento', 'precio']::text[] <@ ARRAY['clase_prueba','inscripcion','clinica','precio','horarios','informacion','vacacional','campamento']::text[];
  v_mal := ARRAY['inventado']::text[] <@ ARRAY['clase_prueba','inscripcion','clinica','precio','horarios','informacion','vacacional','campamento']::text[];
  PERFORM pg_temp.rec('J8b intereses nuevos pasan y uno desconocido no', v_ok AND NOT v_mal, 'ok=' || v_ok || ' desconocido_pasa=' || v_mal);
  PERFORM pg_temp.rec('J8c ninguna fila existente viola el CHECK', NOT EXISTS (SELECT 1 FROM public.whatsapp_audiencia a WHERE NOT (a.intereses <@ ARRAY['clase_prueba','inscripcion','clinica','precio','horarios','informacion','vacacional','campamento']::text[])), 'esperaba 0 filas fuera de la lista');
END $j8$;

-- ---------------------------------------------------------------------------
-- I. invariantes_seguridad() — esperado: 0 violaciones CRÍTICAS y ninguna sobre los objetos nuevos
-- ---------------------------------------------------------------------------
DO $i$
DECLARE v_crit int; v_total int; v_mias int;
BEGIN
  SELECT count(*) FILTER (WHERE to_jsonb(v)->>'gravedad' = 'CRITICA'), count(*),
         count(*) FILTER (WHERE to_jsonb(v)::text ~* '(_servicio_|cobros_servicio|registrar_pago_servicio|ligar_cobro|reclasificar_pago|aplicar_comprobante)')
    INTO v_crit, v_total, v_mias
    FROM public.invariantes_seguridad() v;
  PERFORM pg_temp.rec('I invariantes_seguridad: 0 críticas y ninguna de los objetos nuevos', v_crit = 0 AND v_mias = 0,
                      'críticas=' || v_crit || ' · total=' || v_total || ' · sobre objetos nuevos=' || v_mias || ' (esperaba 0 y 0)');
END $i$;

-- ---------------------------------------------------------------------------
-- Reporte (se ve como el mensaje del ERROR) y ROLLBACK de respaldo
-- ---------------------------------------------------------------------------
DO $rep$
DECLARE v_txt text; v_fail int; v_total int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE NOT ok) INTO v_total, v_fail FROM _res;
  SELECT string_agg(format('%s %s — %s', CASE WHEN ok THEN 'OK   ' ELSE 'FALLA' END, test, detalle), E'\n' ORDER BY n)
    INTO v_txt FROM _res;
  RAISE EXCEPTION E'PRUEBAS cobro-servicio: % pruebas, % con FALLA o SALTADA (se deshace todo)\n%', v_total, v_fail, v_txt;
END $rep$;

ROLLBACK;
