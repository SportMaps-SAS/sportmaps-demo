-- =============================================================================
-- 20261107111754_seg31_cupos_reserva_sin_cuenta.sql
-- Autor: judegor99   Fecha: 2026-11-07   Versión anterior: 20261106191635
-- Objetivo: SEG-31 F3, hallazgos H1 y H2 de
--   docs/plan-link-agendamiento-correcciones-alta.md §2 «H1 y H2».
--
--   H1. Las reservas SIN cuenta (unregistered_athlete_id) guardan
--       enrollment_id = NULL por el CHECK chk_booking_identity. Por eso el
--       trigger trg_process_session_booking no valida estado, vencimiento ni
--       cupo del plan (solo actúa con NEW.enrollment_id), y al cancelar el BFF
--       tenía que adivinar de qué inscripción devolver el crédito
--       (findCreditEnrollment, heurística que falla con varias inscripciones).
--   H2. Consumir/devolver el crédito era un rpc() suelto después del INSERT /
--       UPDATE, sin transacción común: dos cancelaciones simultáneas devolvían
--       dos créditos; dos reservas simultáneas sobre el último cupo pasaban las
--       dos el prechequeo del BFF.
--
--   Bloques:
--     1. Columna session_bookings.credit_enrollment_id (+ índice parcial + COMMENT)
--        e índice único parcial sobre hour_bank_reservation_id (reservas no canceladas).
--     2. RPC book_session_with_credit: valida y bloquea la inscripción
--        (FOR UPDATE), inserta la reserva y consume el crédito en una sola
--        transacción.
--     3. RPC cancel_session_booking_with_credit: bloqueo condicional
--        (status='confirmed' + identidad) + devolución del crédito en una sola
--        transacción. Cierra la doble cancelación. No cancela si la sesión es
--        de un día anterior (Bogotá) ni si ya hay asistencia registrada (R1).
--        Devuelve SOLO a credit_enrollment_id, nunca a enrollment_id (R2).
--     4. migrate_unregistered_athlete_to_profile: al pasar la reserva a
--        user_id/child_id rellena enrollment_id desde credit_enrollment_id.
--        Partiendo del CUERPO VIVO (pg_get_functiondef del 2026-11-07), no del
--        repo — gotcha de apply_late_fees.
--     5. Grants: las dos RPC nuevas solo para service_role (las llama el BFF).
--
--   Sin backfill: medido en vivo el 2026-11-07, no hay reservas sin cuenta
--   confirmadas a futuro (session_bookings tiene 72 filas). Las reservas
--   históricas quedan con credit_enrollment_id NULL y, por R2, al cancelarlas
--   por esta RPC NO devuelven crédito (reason no_credit_enrollment): solo
--   devuelve lo que book_session_with_credit consumió. Medido en vivo: 0
--   reservas confirmadas a futuro, así que no hay impacto.
--
-- -----------------------------------------------------------------------------
-- Contrato de cancel_session_booking_with_credit (jsonb):
--   {cancelled:false, reason:'not_cancellable'}       no existe / no confirmed / otra identidad
--   {cancelled:false, reason:'session_in_the_past', session_id}   sesión de un día anterior (Bogotá)
--   {cancelled:false, reason:'attendance_recorded', session_id}   ya hay attendance_record (sesión+identidad)
--   {cancelled:true, credit_returned:true,  session_id, hour_bank, reason:null}
--   {cancelled:true, credit_returned:false, session_id, hour_bank, reason:…} con reason en:
--     no_credit_enrollment            sin banco de horas y credit_enrollment_id NULL
--     hours_plan_without_reservation  plan de horas sin reserva de horas (legado)
--     not_found / not_confirmed       de cancel_hour_bank_reservation
--     enrollment_not_found / no_plan / not_moved   de move_session_credit
--
--   Fechas: el vencimiento se compara contra la fecha de negocio de Bogotá,
--   (now() AT TIME ZONE 'America/Bogota')::date, porque enrollments.expires_at
--   es `date` en hora local de la escuela. No se usa CURRENT_DATE (UTC en
--   Supabase: entre las 19:00 y las 24:00 de Bogotá ya es «mañana»).
--
--   Desviación del plan (§2 punto 2): el plan mencionaba p_today; el contrato
--   acordado con el BFF calcula la fecha adentro. Mismo efecto, un parámetro
--   menos que el caller pueda mandar mal.
--
-- -----------------------------------------------------------------------------
-- Códigos de error (prefijo antes de «:», para que el BFF los traduzca a 422):
--   invalid_identity                 no hay exactamente una identidad
--   session_not_found                la sesión no existe o es de otra escuela
--   enrollment_unauthorized          la inscripción no es de esa escuela/identidad
--   enrollment_not_active            status <> 'active'
--   plan_expired                     expires_at < hoy (Bogotá), también planes de horas (D4)
--   no_credits                       plan por cupos con el tope alcanzado
--   hour_bank_reservation_required   plan de horas sin p_hour_bank_reservation_id (sería clase gratis)
--   hour_bank_reservation_mismatch   la reserva de horas no es de esa inscripción o no está confirmed
--   Errores que siguen llegando sin prefijo (los lanza el trigger o un índice):
--   «Sesión llena…», «No se puede reservar en una sesión ya finalizada»,
--   23505 en los índices únicos de reserva activa y en
--   uq_session_bookings_hour_bank_reservation_activa.
--
-- -----------------------------------------------------------------------------
-- Verificación PREVIA a aplicar (solo lectura). La migración repite la 1ª
-- dentro de un DO y aborta si encuentra algo, pero conviene verlo antes:
--
--   -- a) Duplicados que romperían el índice único nuevo (esperado: 0 filas)
--   select hour_bank_reservation_id, count(*), array_agg(id)
--     from public.session_bookings
--    where hour_bank_reservation_id is not null and status <> 'cancelled'
--    group by hour_bank_reservation_id having count(*) > 1;
--
--   -- b) Reservas vivas de plan de horas SIN reserva de horas (las nuevas
--   --    pasarán a fallar con hour_bank_reservation_required; las viejas no
--   --    devolverán sessions_used al cancelar: reason hours_plan_without_reservation)
--   select b.id, b.school_id, b.session_id, b.status
--     from public.session_bookings b
--     join public.enrollments e    on e.id = b.enrollment_id
--     join public.offering_plans op on op.id = e.offering_plan_id
--    where b.status = 'confirmed' and b.hour_bank_reservation_id is null
--      and op.included_minutes_per_period is not null;
--
-- -----------------------------------------------------------------------------
-- Verificación POSTERIOR al aplicar (solo lectura):
--
--   -- a) Columna, FK e índice
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--    where table_schema='public' and table_name='session_bookings'
--      and column_name='credit_enrollment_id';                     -- 1 fila, uuid, YES
--   select conname, confdeltype from pg_constraint
--    where conrelid='public.session_bookings'::regclass
--      and contype='f' and conkey = array[(select attnum from pg_attribute
--          where attrelid='public.session_bookings'::regclass and attname='credit_enrollment_id')];
--                                                                  -- confdeltype = 'n' (SET NULL)
--   select indexname, indexdef from pg_indexes
--    where indexname in ('idx_session_bookings_credit_enrollment',
--                        'uq_session_bookings_hour_bank_reservation_activa');   -- 2 filas
--
--   -- b) ACL y search_path de las tres funciones
--   select proname, proacl, proconfig, prosecdef
--     from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname in ('book_session_with_credit',
--                      'cancel_session_booking_with_credit',
--                      'migrate_unregistered_athlete_to_profile');
--   -- Esperado en las tres: proacl = {postgres=X/postgres,service_role=X/postgres},
--   -- proconfig = {"search_path=pg_catalog, public, pg_temp"}, prosecdef = true.
--   select has_function_privilege('authenticated','public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)','EXECUTE'),
--          has_function_privilege('anon','public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)','EXECUTE'),
--          has_function_privilege('authenticated','public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)','EXECUTE'),
--          has_function_privilege('anon','public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)','EXECUTE');
--   -- Esperado: f, f, f, f
--
--   -- c) El cambio de la migración de ficha quedó vivo
--   select prosrc ~ 'COALESCE\(enrollment_id, credit_enrollment_id\)' as ok
--     from pg_proc where proname='migrate_unregistered_athlete_to_profile';   -- true
--
--   -- d) Prueba de humo funcional (BEGIN/ROLLBACK, no persiste) y de
--   --    concurrencia: supabase/migrations/_smoke/seg31_cupos_reserva_sin_cuenta_smoke.sql
--
--   -- e) npm run seguridad:invariantes   (I4: las dos nuevas tienen search_path)
--
-- -----------------------------------------------------------------------------
-- Rollback: script ejecutable en
--   supabase/migrations/_smoke/seg31_cupos_reserva_sin_cuenta_rollback.sql
-- (contiene el cuerpo VIVO previo de migrate_unregistered_athlete_to_profile,
-- no depende de ningún archivo fuera del repo). ORDEN OBLIGATORIO:
--   1. Volver el BFF a la versión anterior (la que no llama a estas RPC) y
--      confirmar que está desplegado. Si se hace al revés, cada reserva y
--      cancelación da 404/42883 mientras tanto.
--   2. Restaurar migrate_unregistered_athlete_to_profile (cuerpo previo).
--   3. DROP de book_session_with_credit y cancel_session_booking_with_credit.
--   4. DROP de los dos índices y DROP COLUMN credit_enrollment_id.
--      DESTRUCTIVO: pierde el vínculo de crédito de las reservas sin cuenta;
--      el script aborta si queda alguna reserva confirmada que dependa de él.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role).
--     Estas dos solo las llama el BFF con service_role: REVOKE explícito a
--     PUBLIC, anon y authenticated, GRANT solo a service_role.
--   · RPC que recibe id de escuela/usuario: el caller es service_role (BFF),
--     que ya resolvió la identidad del atleta (token del link o JWT). La RPC
--     igual ata inscripción, sesión y reserva de horas a ESA escuela y a ESA
--     identidad, para que un id cruzado desde el BFF no consuma cupos ajenos.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Columna credit_enrollment_id
-- =============================================================================
-- Tabla de 72 filas, columna nullable sin default: el ADD COLUMN es solo de
-- catálogo (no reescribe la tabla).
ALTER TABLE public.session_bookings
    ADD COLUMN IF NOT EXISTS credit_enrollment_id uuid NULL
        REFERENCES public.enrollments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.session_bookings.credit_enrollment_id IS
    'Inscripción de la que salió (y a la que vuelve) el crédito de esta reserva. '
    'Existe porque las reservas sin cuenta (unregistered_athlete_id) deben guardar '
    'enrollment_id = NULL por el CHECK chk_booking_identity, y sin este dato la '
    'cancelación tenía que adivinar la inscripción. La escriben '
    'book_session_with_credit (siempre) y es la ÚNICA fuente que usa '
    'cancel_session_booking_with_credit para devolver (nunca enrollment_id: una '
    'reserva que no pasó por book_session_with_credit no consumió por esa vía). '
    'SEG-31 F3, migración 20261107111754.';

-- Índice parcial. Queries que lo necesitan:
--   · La acción de la FK al borrar una inscripción:
--       UPDATE session_bookings SET credit_enrollment_id = NULL
--        WHERE credit_enrollment_id = $1
--     (sin índice, cada DELETE de enrollments hace seq scan de session_bookings).
--   · Conciliación de créditos por inscripción (soporte / QA de SEG-31):
--       SELECT … FROM session_bookings WHERE credit_enrollment_id = $1 AND status = 'confirmed'
--   Parcial porque las filas históricas quedan en NULL y no se consultan por aquí.
CREATE INDEX IF NOT EXISTS idx_session_bookings_credit_enrollment
    ON public.session_bookings (credit_enrollment_id)
    WHERE credit_enrollment_id IS NOT NULL;

-- Índice ÚNICO parcial: una reserva de horas alimenta a lo sumo UNA reserva de
-- clase no cancelada. Es una constraint, no un índice de rendimiento: sin él,
-- el BFF (o un bug) podría colgar la misma hour_bank_reservation_id de dos
-- clases, y cancelar cualquiera de ellas liberaría las horas de ambas. También
-- sirve a la búsqueda inversa reserva de horas → reserva de clase
-- (WHERE hour_bank_reservation_id = $1), que hoy hace seq scan.
-- Pre-chequeo: si en vivo ya hubiera duplicados, el CREATE fallaría con un
-- 23505 genérico; así falla con el detalle y no deja nada a medias.
DO $$
DECLARE v_dups int;
BEGIN
    SELECT count(*) INTO v_dups
      FROM (SELECT hour_bank_reservation_id
              FROM public.session_bookings
             WHERE hour_bank_reservation_id IS NOT NULL
               AND status <> 'cancelled'
             GROUP BY hour_bank_reservation_id
            HAVING count(*) > 1) d;
    IF v_dups > 0 THEN
        RAISE EXCEPTION 'SEG-31 F3: % hour_bank_reservation_id con más de una reserva no cancelada; resolver antes de aplicar (ver consulta de verificación previa en el encabezado).', v_dups;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_bookings_hour_bank_reservation_activa
    ON public.session_bookings (hour_bank_reservation_id)
    WHERE hour_bank_reservation_id IS NOT NULL AND status <> 'cancelled';

-- =============================================================================
-- 2. book_session_with_credit
-- =============================================================================
CREATE OR REPLACE FUNCTION public.book_session_with_credit(
    p_school_id                uuid,
    p_session_id               uuid,
    p_enrollment_id            uuid,
    p_user_id                  uuid,
    p_child_id                 uuid,
    p_unregistered_athlete_id  uuid,
    p_is_secondary             boolean,
    p_hour_bank_reservation_id uuid
)
RETURNS public.session_bookings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_today        date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_is_secondary boolean := COALESCE(p_is_secondary, false);
    v_session      record;
    v_enr          record;
    v_plan         record;
    v_is_hours     boolean := false;
    v_used         integer;
    v_max          integer;
    v_booking      public.session_bookings;
BEGIN
    IF num_nonnulls(p_user_id, p_child_id, p_unregistered_athlete_id) <> 1 THEN
        RAISE EXCEPTION 'invalid_identity: La reserva debe tener exactamente una identidad (user_id, child_id o unregistered_athlete_id).';
    END IF;

    IF p_school_id IS NULL OR p_session_id IS NULL OR p_enrollment_id IS NULL THEN
        RAISE EXCEPTION 'enrollment_unauthorized: Faltan escuela, sesión o inscripción.';
    END IF;

    -- Orden de bloqueo: SESIÓN primero, INSCRIPCIÓN después. Es el mismo orden
    -- que ya sigue la ruta existente public_booking_confirm_reservation (el
    -- trigger bloquea la sesión al insertar y luego move_session_credit bloquea
    -- la inscripción). Invertirlo aquí abriría un deadlock entre las dos rutas.
    -- El trigger vuelve a pedir FOR UPDATE sobre la misma fila en la misma
    -- transacción: no espera.
    SELECT s.id, s.school_id
      INTO v_session
      FROM public.attendance_sessions s
     WHERE s.id = p_session_id
     FOR UPDATE;

    IF NOT FOUND OR v_session.school_id IS DISTINCT FROM p_school_id THEN
        RAISE EXCEPTION 'session_not_found: La sesión no existe en esta escuela.';
    END IF;

    -- FOR UPDATE sobre la inscripción: serializa a dos reservas simultáneas del
    -- mismo plan. La segunda espera aquí y lee sessions_used ya incrementado
    -- por la primera.
    SELECT e.id, e.school_id, e.user_id, e.child_id, e.unregistered_athlete_id,
           e.status, e.expires_at, e.offering_plan_id,
           COALESCE(e.sessions_used, 0)           AS sessions_used,
           COALESCE(e.secondary_sessions_used, 0) AS secondary_sessions_used
      INTO v_enr
      FROM public.enrollments e
     WHERE e.id = p_enrollment_id
     FOR UPDATE;

    IF NOT FOUND
       OR v_enr.school_id IS DISTINCT FROM p_school_id
       OR NOT (
            (p_user_id                 IS NOT NULL AND v_enr.user_id                 IS NOT DISTINCT FROM p_user_id)
         OR (p_child_id                IS NOT NULL AND v_enr.child_id                IS NOT DISTINCT FROM p_child_id)
         OR (p_unregistered_athlete_id IS NOT NULL AND v_enr.unregistered_athlete_id IS NOT DISTINCT FROM p_unregistered_athlete_id)
       )
    THEN
        RAISE EXCEPTION 'enrollment_unauthorized: La inscripción no corresponde a este atleta en esta escuela.';
    END IF;

    IF v_enr.status::text IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'enrollment_not_active: La inscripción no está activa (estado: %).', v_enr.status;
    END IF;

    -- D4: el vencimiento aplica también a los planes de horas.
    IF v_enr.expires_at IS NOT NULL AND v_enr.expires_at < v_today THEN
        RAISE EXCEPTION 'plan_expired: Tu plan venció el %.', to_char(v_enr.expires_at, 'DD/MM/YYYY');
    END IF;

    IF v_enr.offering_plan_id IS NOT NULL THEN
        SELECT op.included_minutes_per_period, op.max_sessions, op.max_secondary_sessions
          INTO v_plan
          FROM public.offering_plans op
         WHERE op.id = v_enr.offering_plan_id;

        IF FOUND THEN
            v_is_hours := v_plan.included_minutes_per_period IS NOT NULL;

            IF NOT v_is_hours THEN
                IF v_is_secondary THEN
                    v_used := v_enr.secondary_sessions_used;
                    v_max  := v_plan.max_secondary_sessions;
                ELSE
                    v_used := v_enr.sessions_used;
                    v_max  := v_plan.max_sessions;
                END IF;

                -- v_max NULL = plan ilimitado.
                IF v_max IS NOT NULL AND v_used >= v_max THEN
                    RAISE EXCEPTION 'no_credits: Ya usaste las % clases de tu plan.', v_max;
                END IF;
            END IF;
        END IF;
    END IF;

    -- Plan de horas sin reserva de horas = clase gratis (no consume
    -- sessions_used ni minutos). El BFF ya llama reserve_hour_bank antes para
    -- todo plan con included_minutes_per_period y corta con 422 si no reserva;
    -- esto lo hace obligatorio en la base también.
    IF v_is_hours AND p_hour_bank_reservation_id IS NULL THEN
        RAISE EXCEPTION 'hour_bank_reservation_required: Tu plan es por horas y la reserva necesita descontar del banco de horas.';
    END IF;

    -- La reserva de horas (si viene) tiene que ser de ESTA inscripción y estar
    -- viva; si no, cancelar esta reserva liberaría horas de otro atleta.
    -- Además el índice único uq_session_bookings_hour_bank_reservation_activa
    -- impide colgar la misma reserva de horas de dos reservas de clase.
    IF p_hour_bank_reservation_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM public.hour_bank_reservations r
         WHERE r.id = p_hour_bank_reservation_id
           AND r.enrollment_id = p_enrollment_id
           AND r.school_id = p_school_id
           AND r.status = 'confirmed'
    ) THEN
        RAISE EXCEPTION 'hour_bank_reservation_mismatch: La reserva de horas no corresponde a esta inscripción.';
    END IF;

    -- enrollment_id: con cuenta, la inscripción (como hoy); sin cuenta, NULL
    -- por chk_booking_identity. credit_enrollment_id: SIEMPRE la inscripción,
    -- es lo que lee la cancelación para devolver el crédito.
    -- trg_process_session_booking sigue corriendo (aforo, sesión finalizada,
    -- y con cuenta revalida el plan).
    INSERT INTO public.session_bookings (
        school_id, session_id, enrollment_id, user_id, child_id,
        unregistered_athlete_id, is_secondary, status,
        hour_bank_reservation_id, credit_enrollment_id
    ) VALUES (
        p_school_id,
        p_session_id,
        CASE WHEN p_unregistered_athlete_id IS NULL THEN p_enrollment_id ELSE NULL END,
        p_user_id,
        p_child_id,
        p_unregistered_athlete_id,
        v_is_secondary,
        'confirmed',
        p_hour_bank_reservation_id,
        p_enrollment_id
    )
    RETURNING * INTO v_booking;

    -- Consumir DESPUÉS del INSERT es a propósito: con cuenta, el trigger
    -- trg_process_session_booking valida contra sessions_used SIN incrementar
    -- todavía. Si consumiéramos antes, el trigger vería el último cupo ya
    -- gastado y rechazaría la reserva que lo usa. Todo queda en la misma
    -- transacción: si algo falla aquí, el INSERT se revierte.
    -- Plan de horas: el saldo lo mueve reserve_hour_bank (ya hecho por el
    -- BFF, p_hour_bank_reservation_id), no sessions_used.
    IF NOT v_is_hours THEN
        PERFORM public.move_session_credit(p_enrollment_id, 1, v_is_secondary);
    END IF;

    RETURN v_booking;
END;
$$;

COMMENT ON FUNCTION public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid) IS
    'SEG-31 F3 (H1/H2): valida inscripción (escuela, identidad, estado, vencimiento '
    'en hora Bogotá, cupo) con FOR UPDATE, inserta la reserva con '
    'credit_enrollment_id y consume el crédito en la misma transacción. Errores con '
    'prefijo de código (invalid_identity, session_not_found, enrollment_unauthorized, '
    'enrollment_not_active, plan_expired, no_credits, hour_bank_reservation_required, '
    'hour_bank_reservation_mismatch). '
    'Solo service_role (BFF).';

-- =============================================================================
-- 3. cancel_session_booking_with_credit
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cancel_session_booking_with_credit(
    p_booking_id              uuid,
    p_user_id                 uuid,
    p_child_id                uuid,
    p_unregistered_athlete_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_today           date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_b               record;
    v_session_date    date;
    v_is_hours        boolean := false;
    v_result          jsonb;
    v_credit_returned boolean := false;
    v_reason          text := NULL;
BEGIN
    IF num_nonnulls(p_user_id, p_child_id, p_unregistered_athlete_id) <> 1 THEN
        RAISE EXCEPTION 'invalid_identity: La cancelación debe tener exactamente una identidad (user_id, child_id o unregistered_athlete_id).';
    END IF;

    -- Bloqueo de la fila, condicionado a status='confirmed' y a la identidad:
    -- es el cierre de la doble cancelación. Si llegan dos a la vez, la segunda
    -- espera el bloqueo, reevalúa el WHERE (READ COMMITTED) contra la fila ya
    -- cancelada y no encuentra nada. Se bloquea ANTES de mirar fecha y
    -- asistencia para que la decisión y el UPDATE vean la misma fila.
    SELECT sb.id, sb.session_id, sb.user_id, sb.child_id, sb.unregistered_athlete_id,
           sb.credit_enrollment_id, sb.hour_bank_reservation_id, sb.is_secondary
      INTO v_b
      FROM public.session_bookings sb
     WHERE sb.id = p_booking_id
       AND sb.status = 'confirmed'
       AND (
            (p_user_id                 IS NOT NULL AND sb.user_id                 = p_user_id)
         OR (p_child_id                IS NOT NULL AND sb.child_id                = p_child_id)
         OR (p_unregistered_athlete_id IS NOT NULL AND sb.unregistered_athlete_id = p_unregistered_athlete_id)
       )
     FOR UPDATE;

    IF NOT FOUND THEN
        -- Ya cancelada / atendida / inexistente / de otro atleta: no se
        -- distingue a propósito (no revela si el id existe).
        RETURN jsonb_build_object('cancelled', false, 'reason', 'not_cancellable');
    END IF;

    -- R1: una clase de un día anterior (Bogotá) ya pasó: cancelarla devolvería
    -- un crédito de una clase que se dictó.
    SELECT s.session_date INTO v_session_date
      FROM public.attendance_sessions s
     WHERE s.id = v_b.session_id;

    IF v_session_date IS NOT NULL AND v_session_date < v_today THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'session_in_the_past',
                                  'session_id', v_b.session_id);
    END IF;

    -- R1: si ya se pasó lista (presente, ausente, excusa, no_show… cualquier
    -- registro) para esa sesión y esa persona, la reserva ya cumplió su ciclo.
    -- attendance_records no tiene FK a la reserva: el vínculo es
    -- (session_id, identidad), el mismo dedup que usa la toma de asistencia.
    IF EXISTS (
        SELECT 1
          FROM public.attendance_records ar
         WHERE ar.session_id = v_b.session_id
           AND (
                (v_b.user_id                 IS NOT NULL AND ar.user_id                 = v_b.user_id)
             OR (v_b.child_id                IS NOT NULL AND ar.child_id                = v_b.child_id)
             OR (v_b.unregistered_athlete_id IS NOT NULL AND ar.unregistered_athlete_id = v_b.unregistered_athlete_id)
           )
    ) THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'attendance_recorded',
                                  'session_id', v_b.session_id);
    END IF;

    UPDATE public.session_bookings
       SET status           = 'cancelled',
           cancelled_at     = now(),
           cancelled_reason = 'Cancelado por el atleta',
           updated_at       = now()
     WHERE id = v_b.id
       AND status = 'confirmed';

    IF v_b.hour_bank_reservation_id IS NOT NULL THEN
        v_result := public.cancel_hour_bank_reservation(v_b.hour_bank_reservation_id);
        v_credit_returned := COALESCE((v_result->>'cancelled')::boolean, false);
        IF NOT v_credit_returned THEN
            v_reason := COALESCE(v_result->>'reason', 'hour_bank_not_released');
        END IF;
    ELSIF v_b.credit_enrollment_id IS NULL THEN
        -- R2: SOLO se devuelve a credit_enrollment_id, que únicamente escribe
        -- book_session_with_credit cuando CONSUMIÓ (o validó) el crédito.
        -- Nunca a enrollment_id: una reserva de encuesta (el BFF inserta el
        -- enrollment_id del body sin consumir) o cualquier reserva anterior a
        -- esta migración no consumió nada por esta vía y no debe devolver.
        v_reason := 'no_credit_enrollment';
    ELSE
        -- Simetría con book_session_with_credit: en un plan de horas la
        -- reserva no consumió sessions_used, así que tampoco se devuelve.
        SELECT op.included_minutes_per_period IS NOT NULL
          INTO v_is_hours
          FROM public.enrollments e
          JOIN public.offering_plans op ON op.id = e.offering_plan_id
         WHERE e.id = v_b.credit_enrollment_id;
        v_is_hours := COALESCE(v_is_hours, false);

        IF v_is_hours THEN
            v_reason := 'hours_plan_without_reservation';
        ELSE
            v_result := public.move_session_credit(v_b.credit_enrollment_id, -1, COALESCE(v_b.is_secondary, false));
            v_credit_returned := COALESCE((v_result->>'moved')::boolean, false);
            IF NOT v_credit_returned THEN
                v_reason := COALESCE(v_result->>'reason', 'not_moved');
            END IF;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'cancelled',       true,
        'credit_returned', v_credit_returned,
        'session_id',      v_b.session_id,
        'hour_bank',       v_b.hour_bank_reservation_id IS NOT NULL,
        'reason',          v_reason
    );
END;
$$;

COMMENT ON FUNCTION public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid) IS
    'SEG-31 F3 (H1/H2/R1/R2): cancela la reserva solo si sigue confirmed, es de '
    'esa identidad (FOR UPDATE condicional: cierra la doble cancelación), la '
    'sesión no es de un día anterior (Bogotá) y no hay attendance_record de esa '
    'sesión e identidad. Devuelve el crédito en la misma transacción: '
    'cancel_hour_bank_reservation si hay reserva de horas; si no, '
    'move_session_credit(-1) SOLO sobre credit_enrollment_id (nunca enrollment_id). '
    'Devuelve {cancelled, credit_returned, session_id, hour_bank, reason}. '
    'Solo service_role (BFF).';

-- =============================================================================
-- 4. migrate_unregistered_athlete_to_profile (desde el CUERPO VIVO)
-- =============================================================================
-- Único cambio respecto de pg_get_functiondef del 2026-11-07: las dos ramas
-- de UPDATE public.session_bookings rellenan enrollment_id desde
-- credit_enrollment_id. CREATE OR REPLACE conserva la ACL viva
-- ({postgres=X/postgres,service_role=X/postgres}).
CREATE OR REPLACE FUNCTION public.migrate_unregistered_athlete_to_profile(p_unregistered_id uuid, p_new_user_id uuid DEFAULT NULL::uuid, p_new_child_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_enrollments   int;
  v_rows_omitidos      int;
  v_rows_records       int;
  v_rows_bookings      int;
  v_rows_payments      int;
  v_rows_zk_mappings   int;
  v_rows_documents     int;
BEGIN
  IF p_new_user_id IS NULL AND p_new_child_id IS NULL THEN
    RAISE EXCEPTION 'Se requiere p_new_user_id o p_new_child_id';
  END IF;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.enrollments e
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE e.unregistered_athlete_id = p_unregistered_id
      AND e.user_id IS NULL
      AND (
        e.status <> 'active'
        OR NOT EXISTS (
          SELECT 1
          FROM public.enrollments dup
          WHERE dup.user_id = p_new_user_id
            AND dup.status  = 'active'
            AND dup.id     <> e.id
            AND (
                 (dup.offering_plan_id IS NOT NULL AND dup.offering_plan_id = e.offering_plan_id)
              OR (dup.team_id          IS NOT NULL AND dup.team_id          = e.team_id)
            )
        )
      );
  ELSE
    UPDATE public.enrollments e
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE e.unregistered_athlete_id = p_unregistered_id
      AND e.child_id IS NULL
      AND (
        e.status <> 'active'
        OR NOT EXISTS (
          SELECT 1
          FROM public.enrollments dup
          WHERE dup.child_id = p_new_child_id
            AND dup.status   = 'active'
            AND dup.id      <> e.id
            AND (
                 (dup.offering_plan_id IS NOT NULL AND dup.offering_plan_id = e.offering_plan_id)
              OR (dup.team_id          IS NOT NULL AND dup.team_id          = e.team_id)
            )
        )
      );
  END IF;
  GET DIAGNOSTICS v_rows_enrollments = ROW_COUNT;

  SELECT count(*) INTO v_rows_omitidos
  FROM public.enrollments e
  WHERE e.unregistered_athlete_id = p_unregistered_id
    AND (
         (p_new_user_id IS NOT NULL AND e.user_id  IS NULL)
      OR (p_new_user_id IS NULL     AND e.child_id IS NULL)
    );

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.attendance_records
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.attendance_records
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_records = ROW_COUNT;

  -- SEG-31 F3: sin cuenta la reserva guardaba enrollment_id NULL (CHECK
  -- chk_booking_identity) y el crédito en credit_enrollment_id. Al pasar a
  -- user_id/child_id se rellena enrollment_id, para que la reserva con cuenta
  -- quede ligada a su inscripción como cualquier otra (trigger, listados,
  -- asistencia). La devolución del crédito sigue leyendo SOLO
  -- credit_enrollment_id, que no se toca.
  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.session_bookings
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL,
        enrollment_id           = COALESCE(enrollment_id, credit_enrollment_id)
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.session_bookings
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL,
        enrollment_id           = COALESCE(enrollment_id, credit_enrollment_id)
    WHERE unregistered_athlete_id = p_unregistered_id
      AND child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_bookings = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.payments
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.payments p
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL,
        parent_id               = COALESCE(p.parent_id, c.parent_id)
    FROM public.children c
    WHERE c.id = p_new_child_id
      AND p.unregistered_athlete_id = p_unregistered_id
      AND p.child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_payments = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.zk_user_mappings
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_zk_mappings = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.athlete_documents
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id;
  ELSE
    UPDATE public.athlete_documents
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id;
  END IF;
  GET DIAGNOSTICS v_rows_documents = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.profiles pr
    SET
      date_of_birth = COALESCE(pr.date_of_birth, ua.date_of_birth),
      phone         = COALESCE(pr.phone,         ua.phone),
      updated_at    = now()
    FROM public.unregistered_athletes ua
    WHERE pr.id = p_new_user_id
      AND ua.id = p_unregistered_id
      AND (ua.date_of_birth IS NOT NULL OR ua.phone IS NOT NULL);
  END IF;

  UPDATE public.unregistered_athletes
  SET linked_profile_id = COALESCE(
        p_new_user_id,
        (SELECT c.parent_id FROM public.children c WHERE c.id = p_new_child_id)
      ),
      is_active = false
  WHERE id = p_unregistered_id;

  RETURN jsonb_build_object(
    'unregistered_id',      p_unregistered_id,
    'migrated_to_user',     p_new_user_id,
    'migrated_to_child',    p_new_child_id,
    'enrollments',          v_rows_enrollments,
    'enrollments_omitidos', v_rows_omitidos,
    'attendance_records',   v_rows_records,
    'session_bookings',     v_rows_bookings,
    'payments',             v_rows_payments,
    'zk_user_mappings',     v_rows_zk_mappings,
    'athlete_documents',    v_rows_documents
  );
END;
$function$;

-- =============================================================================
-- 5. Grants: solo service_role (las dos RPC nuevas las llama únicamente el BFF)
-- =============================================================================
REVOKE ALL ON FUNCTION public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid) TO service_role;

REVOKE ALL ON FUNCTION public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid) TO service_role;

-- migrate_unregistered_athlete_to_profile: sin cambios de ACL (CREATE OR
-- REPLACE la conserva). Se reafirma por si la base difiere de lo medido.
REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
