-- ============================================================
-- VERIFICACIÓN — Bot de WhatsApp de Monster, M1-M4 del plan maestro
--   20261030123543_embudo_y_agenda_clase_prueba
--   20261030123549_comprobantes_con_motivo
--   20261030123555_campanas_whatsapp
--   20261030123604_whatsapp_numero_proposito
-- NO es una migración. Correr con psql DESPUÉS de aplicar las 4:
--   psql "$DATABASE_URL" \
--     -v school_id="'<uuid escuela de PRUEBA (Club Campestre Demo), nunca una real>'" \
--     -v coach_uid="'<profiles.id de un profe de esa escuela (school_staff.coach_auth_id)>'" \
--     -v team_id="'<teams.id de un equipo de ESE profe>'" \
--     -v otro_team_id="'<teams.id de la misma escuela que NO es de ese profe>'" \
--     -v parent_uid="'<profiles.id de un acudiente activo de esa escuela>'" \
--     -f supabase/migrations/_smoke/monster_20261030_verificacion.sql
--
-- Todo corre en UNA transacción con ROLLBACK final: no persiste nada. Solo
-- consultas puntuales filtradas por nombre (nada de barrer el catálogo).
-- Cada bloque imprime «OK …» o corta con «FAIL …».
-- La base es una sola para dev/stg/prod: por eso la escuela de PRUEBA.
-- La concurrencia real (dos sesiones) va descrita al final: no cabe en una
-- sola transacción.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _p (school_id uuid, coach_uid uuid, team_id uuid, otro_team_id uuid, parent_uid uuid);
INSERT INTO _p VALUES (:school_id, :coach_uid, :team_id, :otro_team_id, :parent_uid);
GRANT SELECT ON _p TO authenticated, anon, service_role;

-- ── 0. Objetos y permisos (pg_proc / pg_class filtrados por nombre) ─────────
DO $$
DECLARE
    f text;
    solo_bff text[] := ARRAY[
        'public.tomar_cupo_clase_prueba(uuid,uuid)',
        'public.confirmar_cupo_clase_prueba(uuid,uuid)',
        'public.soltar_cupos_separados(uuid,integer)',
        'public._soltar_o_confirmar_cupo(uuid)',
        'public.wa_es_afiliado(uuid,text)',
        'public.wa_crear_cobro_desde_comprobante(uuid,uuid,text,numeric,text,uuid,uuid,uuid,uuid,text,uuid,text,text)',
        'public.wa_audiencia_excluidos(uuid,text[])',
        'public.wa_campana_aprobar(uuid,uuid,text)',
        'public.wa_campana_tomar_lote(uuid,integer,integer)'];
    pantalla text[] := ARRAY[
        'public.puede_editar_semana_equipo(uuid,uuid)',
        'public.repetir_semana_equipo(uuid,date)',
        'public.clases_prueba_semana(uuid,date,date)',
        'public.marcar_clase_prueba_entrenador(uuid,text,uuid)',
        'public.guardar_ajustes_clase_prueba(uuid,jsonb)',
        'public.listar_clase_prueba(uuid)',
        'public.registrar_pago_clase_prueba(uuid,numeric,text,text)',
        'public.listar_cobros_clase_prueba(uuid)'];
    t text;
BEGIN
    FOREACH f IN ARRAY solo_bff LOOP
        IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
            RAISE EXCEPTION 'FAIL grants: anon/authenticated pueden ejecutar %', f;
        END IF;
        IF f <> 'public._soltar_o_confirmar_cupo(uuid)' AND NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
            RAISE EXCEPTION 'FAIL grants: service_role no puede ejecutar %', f;
        END IF;
    END LOOP;
    FOREACH f IN ARRAY pantalla LOOP
        IF has_function_privilege('anon', f, 'EXECUTE') OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
            RAISE EXCEPTION 'FAIL grants: % debe ser solo de authenticated', f;
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc p
                WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
                  AND p.proname IN ('puede_editar_semana_equipo','repetir_semana_equipo','clases_prueba_semana',
                                    'marcar_clase_prueba_entrenador','guardar_ajustes_clase_prueba','tomar_cupo_clase_prueba',
                                    'confirmar_cupo_clase_prueba','soltar_cupos_separados','_soltar_o_confirmar_cupo',
                                    'wa_es_afiliado','wa_crear_cobro_desde_comprobante','wa_audiencia_excluidos',
                                    'wa_campana_aprobar','wa_campana_tomar_lote','listar_clase_prueba',
                                    'registrar_pago_clase_prueba','listar_cobros_clase_prueba')
                  AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')) THEN
        RAISE EXCEPTION 'FAIL I4: SECURITY DEFINER sin search_path';
    END IF;
    FOREACH t IN ARRAY ARRAY['whatsapp_conceptos_esperados','wa_cobros_desde_comprobante','whatsapp_campanas_ajustes',
                             'whatsapp_audiencia','whatsapp_campanas','whatsapp_campana_envios','team_schedule_exceptions'] LOOP
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
            RAISE EXCEPTION 'FAIL RLS apagado en %', t;
        END IF;
        IF has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
            RAISE EXCEPTION 'FAIL anon con SELECT en %', t;
        END IF;
    END LOOP;
    RAISE NOTICE 'OK 0: grants de las 17 funciones, search_path y RLS de las 7 tablas nuevas';
END $$;

-- ── 1. Policies de team_schedule_exceptions (para leer a ojo) ──────────────
SELECT cmd, policyname, permissive, roles, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'team_schedule_exceptions'
 ORDER BY cmd;

DO $$
BEGIN
    IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'team_schedule_exceptions') <> 4 THEN
        RAISE EXCEPTION 'FAIL: team_schedule_exceptions debía tener 4 policies (select/insert/update/delete)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'team_schedule_exceptions'
                AND (cmd = 'ALL' OR (cmd IN ('INSERT', 'UPDATE') AND with_check IS NULL)
                     OR 'anon' = ANY (roles) OR 'public' = ANY (roles))) THEN
        RAISE EXCEPTION 'FAIL: FOR ALL, escritura sin WITH CHECK o policy que alcanza a anon/public';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                AND tablename IN ('whatsapp_conceptos_esperados','wa_cobros_desde_comprobante','whatsapp_campanas_ajustes',
                                  'whatsapp_audiencia','whatsapp_campanas','whatsapp_campana_envios')) THEN
        RAISE EXCEPTION 'FAIL: una tabla solo-BFF tiene policies';
    END IF;
    RAISE NOTICE 'OK 1: 4 policies por comando con WITH CHECK; tablas solo-BFF sin policies';
END $$;

-- ── 2. authenticated → 42501 en las tablas solo-BFF ─────────────────────────
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT coach_uid FROM _p), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['whatsapp_conceptos_esperados','wa_cobros_desde_comprobante','whatsapp_campanas_ajustes',
                             'whatsapp_audiencia','whatsapp_campanas','whatsapp_campana_envios'] LOOP
        BEGIN
            EXECUTE format('SELECT 1 FROM public.%I LIMIT 1', t);
            RAISE EXCEPTION 'FAIL: authenticated leyó %', t;
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
    END LOOP;
    BEGIN
        PERFORM public.tomar_cupo_clase_prueba(gen_random_uuid(), gen_random_uuid());
        RAISE EXCEPTION 'FAIL: authenticated ejecutó tomar_cupo_clase_prueba';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'OK 2: 42501 en las 6 tablas solo-BFF y en las RPC del BFF';
END $$;

-- ── 3. Sesión simulada del PROFE ────────────────────────────────────────────
DO $$
DECLARE p record; v_n int;
BEGIN
    SELECT * INTO p FROM _p;
    IF NOT (p.school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'FAIL: el profe no es staff de la escuela (revisar coach_uid)';
    END IF;
    IF NOT public.puede_editar_semana_equipo(p.team_id, p.school_id) THEN
        RAISE EXCEPTION 'FAIL: el profe no puede editar la semana de SU equipo (revisar team_id)';
    END IF;
    IF public.puede_editar_semana_equipo(p.otro_team_id, p.school_id) THEN
        RAISE EXCEPTION 'FAIL: el profe puede editar la semana de un equipo ajeno';
    END IF;
    INSERT INTO public.team_schedule_exceptions (school_id, team_id, fecha, tipo)
    VALUES (p.school_id, p.team_id, current_date + 7, 'cancelada');
    BEGIN
        INSERT INTO public.team_schedule_exceptions (school_id, team_id, fecha, tipo)
        VALUES (p.school_id, p.otro_team_id, current_date + 7, 'cancelada');
        RAISE EXCEPTION 'FAIL: el profe escribió en un equipo ajeno';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    v_n := jsonb_array_length(public.clases_prueba_semana(p.school_id, current_date, current_date + 7));
    RAISE NOTICE 'OK 3: profe escribe en su equipo, no en el ajeno; clases_prueba_semana devuelve % filas (solo de sus equipos)', v_n;
END $$;
RESET ROLE;

-- ── 4. Sesión simulada del ACUDIENTE ────────────────────────────────────────
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT parent_uid FROM _p), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE p record;
BEGIN
    SELECT * INTO p FROM _p;
    IF (SELECT count(*) FROM public.team_schedule_exceptions WHERE school_id = p.school_id) < 1 THEN
        RAISE EXCEPTION 'FAIL: el acudiente no lee la semana de su escuela';
    END IF;
    BEGIN
        INSERT INTO public.team_schedule_exceptions (school_id, team_id, fecha, tipo)
        VALUES (p.school_id, p.team_id, current_date + 8, 'cancelada');
        RAISE EXCEPTION 'FAIL: el acudiente escribió en la semana';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM public.clases_prueba_semana(p.school_id, current_date, current_date + 7);
        RAISE EXCEPTION 'FAIL: el acudiente vio las clases de prueba';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM public.guardar_ajustes_clase_prueba(p.school_id, '{"nombre_clase":"prueba"}');
        RAISE EXCEPTION 'FAIL: el acudiente cambió los ajustes de la clase de prueba';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'OK 4: acudiente lee la semana; no escribe, no ve clases de prueba ni ajustes';
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
    BEGIN
        PERFORM 1 FROM public.team_schedule_exceptions LIMIT 1;
        RAISE EXCEPTION 'FAIL: anon leyó team_schedule_exceptions';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RAISE NOTICE 'OK 5: anon sin acceso a team_schedule_exceptions';
END $$;
RESET ROLE;

-- ── 6. BFF: cupo separado, cobro desde comprobante y confirmación ───────────
SET LOCAL ROLE service_role;
DO $$
DECLARE
    p record; v_slot uuid; v_lead uuid; r jsonb; v_pid uuid; v_cola uuid := gen_random_uuid();
BEGIN
    SELECT * INTO p FROM _p;
    INSERT INTO public.school_trial_class_settings (school_id, trial_price, separar_horas)
    VALUES (p.school_id, 15000, 24)
    ON CONFLICT (school_id) DO UPDATE SET trial_price = 15000, separar_horas = 24;
    INSERT INTO public.school_trial_slots (school_id, team_id, label, slot_date, start_time, end_time, max_capacity)
    VALUES (p.school_id, p.team_id, 'Smoke', current_date + 3, '08:00', '10:00', 1)
    RETURNING id INTO v_slot;
    INSERT INTO public.school_signup_leads (school_id, source_slug, full_name, phone)
    VALUES (p.school_id, 'smoke', 'Smoke Monster', '573000000001')
    RETURNING id INTO v_lead;

    r := public.tomar_cupo_clase_prueba(v_lead, v_slot);
    IF r->>'estado' <> 'separada' THEN RAISE EXCEPTION 'FAIL tomar_cupo: %', r; END IF;
    r := public.wa_crear_cobro_desde_comprobante(p.school_id, v_cola, 'clase_prueba', 15000, 'trial_price',
                                                 NULL, NULL, NULL, v_lead, NULL);
    IF NOT (r->>'ok')::boolean OR (r->>'precio')::numeric <> 15000 THEN RAISE EXCEPTION 'FAIL cobro: %', r; END IF;
    v_pid := (r->>'payment_id')::uuid;
    r := public.wa_crear_cobro_desde_comprobante(p.school_id, v_cola, 'clase_prueba', 15000, 'trial_price',
                                                 NULL, NULL, NULL, v_lead, NULL);
    IF NOT (r->>'ya_existia')::boolean THEN RAISE EXCEPTION 'FAIL idempotencia: %', r; END IF;
    r := public.wa_crear_cobro_desde_comprobante(p.school_id, gen_random_uuid(), 'clase_prueba', 9000, 'trial_price',
                                                 NULL, NULL, NULL, v_lead, NULL);
    IF r->>'codigo' <> 'ya_tiene_cobro' THEN RAISE EXCEPTION 'FAIL segundo cobro: %', r; END IF;
    UPDATE public.payments SET status = 'awaiting_approval' WHERE id = v_pid;   -- lo que deja el estampado
    r := public.confirmar_cupo_clase_prueba(v_lead, v_pid);
    IF r->>'estado' <> 'agendada' THEN RAISE EXCEPTION 'FAIL confirmar: %', r; END IF;
    IF (SELECT reserved_count FROM public.school_trial_slots WHERE id = v_slot) <> 1 THEN
        RAISE EXCEPTION 'FAIL: el contador no quedó en 1';
    END IF;
    -- Solo ESTE lead (con NULL tomaría los vencidos de todas las escuelas).
    IF jsonb_array_length(public.soltar_cupos_separados(v_lead)) <> 0 THEN
        RAISE EXCEPTION 'FAIL soltar_cupos_separados: el lead ya no tenía cupo separado';
    END IF;
    RAISE NOTICE 'OK 6: separar → cobro (idempotente, uno por prospecto) → agendar; contador correcto';
END $$;
RESET ROLE;

-- ── 7. Dos números: todo lo existente quedó en 'general' ────────────────────
SELECT proposito, status, count(*) FROM public.school_whatsapp_integrations GROUP BY 1, 2 ORDER BY 1, 2;

ROLLBACK;
\echo VERIFICACION_OK

-- ============================================================
-- CONCURRENCIA (no corre aquí: dos terminales a la vez, contra la escuela de
-- PRUEBA y con datos creados para eso; borrar después).
--
-- a) Último cupo. Franja con max_capacity = 1 y dos prospectos L1, L2 de la
--    misma escuela. En cada terminal, casi al mismo tiempo:
--      BEGIN; SET LOCAL ROLE service_role;
--      SELECT public.tomar_cupo_clase_prueba('<L1 | L2>', '<franja>');
--      SELECT pg_sleep(3); COMMIT;
--    Esperado: uno «separada» (o «agendada») y el otro «lleno»; la franja queda
--    con reserved_count = 1. El candado es FOR UPDATE del lead y luego de las
--    franjas por id (mismo orden que wa_cancelar_clase_de_prueba): no hay deadlock.
--
-- b) Lote de campaña. Campaña aprobada con ≥ 8 envíos pendientes y lote_piloto
--    ≥ 8. En cada terminal a la vez:
--      BEGIN; SET LOCAL ROLE service_role;
--      SELECT string_agg(contact_wa_id, ',') FROM public.wa_campana_tomar_lote('<campaña>', 4, 250);
--      SELECT pg_sleep(3); COMMIT;
--    Esperado: dos listas de 4 SIN números repetidos (pg_advisory_xact_lock por
--    integración + FOR UPDATE SKIP LOCKED); 8 envíos en 'enviando'.
--
-- Ambas se corrieron en una base desechable (Docker, supabase/postgres 17.6)
-- el 2026-10-30: a) separada / lleno, reserved_count = 1; b) 4 + 4 distintos.
-- ============================================================
