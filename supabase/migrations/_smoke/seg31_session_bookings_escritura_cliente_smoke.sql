-- ============================================================
-- SMOKE — SEG-31 C2/R1: escritura REST de session_bookings. NO es una migración.
-- Correr DESPUÉS de aplicar 20261107174916_seg31_session_bookings_escritura_cliente.
-- Una transacción con ROLLBACK final: no persiste nada. Fechas 2099.
--
--   psql "$DATABASE_URL" \
--     -v school_id="'<uuid escuela>'" \
--     -v staff_user_id="'<uuid de un STAFF activo de esa escuela (user_staff_school_ids)>'" \
--     -v athlete_user_id="'<uuid de un usuario existente que NO sea staff de esa escuela>'" \
--     -f supabase/migrations/_smoke/seg31_session_bookings_escritura_cliente_smoke.sql
--
-- Opcional, SOLO en el gemelo local (hace DDL dentro de la transacción y toma
-- un lock exclusivo de session_bookings hasta el ROLLBACK):
--     -v probar_guardia=1
--   Devuelve temporalmente un GRANT UPDATE y una policy permisiva para que el
--   UPDATE llegue al trigger, y verifica que la guardia corte con
--   transicion_no_permitida (defensa en profundidad).
--
-- Simula sesiones REST con SET LOCAL ROLE authenticated + request.jwt.claims.
-- Los ids viajan entre roles por GUCs locales (smoke.*), no por tablas
-- temporales (authenticated no puede leer las de postgres).
-- Usa SOLO los valores vivos de booking_status: confirmed, cancelled,
-- attended, no_show.
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('smoke.school',  :'school_id',       true),
       set_config('smoke.staff',   :'staff_user_id',   true),
       set_config('smoke.athlete', :'athlete_user_id', true);

-- ── Setup (postgres) ──
DO $$
DECLARE
    v_school uuid := current_setting('smoke.school')::uuid;
    v_ath    uuid := current_setting('smoke.athlete')::uuid;
    v_team uuid; v_s uuid; v_id uuid; i int;
    v_status text[] := ARRAY['attended', 'cancelled', 'confirmed', 'no_show'];
BEGIN
    INSERT INTO public.teams (school_id, name, sport) VALUES (v_school, 'SMOKE SEG31 C2', 'futbol') RETURNING id INTO v_team;
    FOR i IN 1..array_length(v_status, 1) LOOP
        INSERT INTO public.attendance_sessions (school_id, team_id, session_date)
             VALUES (v_school, v_team, DATE '2099-03-01' + i) RETURNING id INTO v_s;
        -- Inserción directa como postgres (camino de prueba, no el de la app).
        INSERT INTO public.session_bookings (school_id, session_id, user_id, status)
             VALUES (v_school, v_s, v_ath, v_status[i]::public.booking_status) RETURNING id INTO v_id;
        PERFORM set_config('smoke.b_' || v_status[i], v_id::text, true);
    END LOOP;
    PERFORM set_config('smoke.session', v_s::text, true);
END $$;

-- Escrituras que deben dar 42501 para CUALQUIER authenticated (atleta o staff).
-- Mismo bloque para las dos identidades (se repite a propósito: una función
-- temporal de postgres no es ejecutable de forma fiable tras SET ROLE).
\set casos_c2 'DO $c2$ DECLARE v_casos text[] := ARRAY[ format(''UPDATE public.session_bookings SET status = %L WHERE id = %L'', ''confirmed'', current_setting(''smoke.b_attended'')), format(''UPDATE public.session_bookings SET status = %L WHERE id = %L'', ''confirmed'', current_setting(''smoke.b_no_show'')), format(''UPDATE public.session_bookings SET status = %L WHERE id = %L'', ''confirmed'', current_setting(''smoke.b_cancelled'')), format(''UPDATE public.session_bookings SET status = %L WHERE id = %L'', ''cancelled'', current_setting(''smoke.b_confirmed'')), format(''UPDATE public.session_bookings SET status = %L WHERE id = %L'', ''attended'', current_setting(''smoke.b_confirmed'')), format(''UPDATE public.session_bookings SET updated_at = now() WHERE id = %L'', current_setting(''smoke.b_confirmed'')), format(''UPDATE public.session_bookings SET is_secondary = true WHERE id = %L'', current_setting(''smoke.b_confirmed'')), format(''INSERT INTO public.session_bookings (school_id, session_id, user_id, status) VALUES (%L, %L, %L, %L)'', current_setting(''smoke.school''), current_setting(''smoke.session''), current_setting(''smoke.athlete''), ''confirmed''), format(''DELETE FROM public.session_bookings WHERE id = %L'', current_setting(''smoke.b_confirmed'')) ]; v_sql text; BEGIN FOREACH v_sql IN ARRAY v_casos LOOP BEGIN EXECUTE v_sql; RAISE EXCEPTION ''FAIL (%): se permitió por REST: %'', current_setting(''smoke.quien''), v_sql; EXCEPTION WHEN insufficient_privilege THEN NULL; END; END LOOP; RAISE NOTICE ''% : OK (% escrituras REST rechazadas con 42501)'', current_setting(''smoke.quien''), array_length(v_casos, 1); END $c2$;'

-- ── Atleta dueño de las reservas ──
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
       json_build_object('sub', current_setting('smoke.athlete'), 'role', 'authenticated')::text, true),
       set_config('smoke.quien', 'atleta', true);
DO $$
BEGIN
    IF current_setting('smoke.school')::uuid = ANY (public.user_staff_school_ids()) THEN
        RAISE EXCEPTION 'Parámetro inválido: athlete_user_id es staff de la escuela';
    END IF;
END $$;
:casos_c2

-- ── Staff de la escuela ──
SELECT set_config('request.jwt.claims',
       json_build_object('sub', current_setting('smoke.staff'), 'role', 'authenticated')::text, true),
       set_config('smoke.quien', 'staff', true);
DO $$
BEGIN
    IF NOT (current_setting('smoke.school')::uuid = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'Parámetro inválido: staff_user_id no es staff de la escuela';
    END IF;
END $$;
:casos_c2

-- ── Lectura intacta: el staff sigue viendo las reservas de su escuela ──
DO $$
DECLARE v_n int;
BEGIN
    SELECT count(*) INTO v_n FROM public.session_bookings
     WHERE id IN (current_setting('smoke.b_attended')::uuid, current_setting('smoke.b_confirmed')::uuid);
    IF v_n <> 2 THEN RAISE EXCEPTION 'FAIL lectura: el staff ve % de 2 reservas (select_own cambió?)', v_n; END IF;
END $$;

RESET ROLE;

-- ── Opcional (gemelo local): la guardia corta aunque vuelva un GRANT ──
\if :{?probar_guardia}
GRANT UPDATE (status, updated_at) ON public.session_bookings TO authenticated;
CREATE POLICY "_smoke_seg31_update_todo" ON public.session_bookings
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_n int;
BEGIN
    BEGIN
        UPDATE public.session_bookings SET status = 'confirmed' WHERE id = current_setting('smoke.b_attended')::uuid;
        RAISE EXCEPTION 'FAIL guardia: attended → confirmed pasó';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM NOT LIKE 'transicion_no_permitida:%' THEN RAISE; END IF;
    END;
    BEGIN
        UPDATE public.session_bookings SET status = 'confirmed' WHERE id = current_setting('smoke.b_cancelled')::uuid;
        RAISE EXCEPTION 'FAIL guardia: cancelled → confirmed pasó';
    EXCEPTION WHEN insufficient_privilege THEN
        IF SQLERRM NOT LIKE 'transicion_no_permitida:%' THEN RAISE; END IF;
    END;
    -- Solo updated_at: la guardia no dispara.
    UPDATE public.session_bookings SET updated_at = now() WHERE id = current_setting('smoke.b_attended')::uuid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL guardia: updated_at afectó % filas', v_n; END IF;
    RAISE NOTICE 'Guardia: OK (defensa en profundidad)';
END $$;
RESET ROLE;
\endif

DO $$ BEGIN RAISE NOTICE 'SMOKE SEG31 C2/R1: OK'; END $$;
ROLLBACK;
