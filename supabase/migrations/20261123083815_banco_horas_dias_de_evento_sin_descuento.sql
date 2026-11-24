-- =============================================================================
-- 20261123083815_banco_horas_dias_de_evento_sin_descuento.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261122113738
-- Objetivo: que la escuela pueda decir «este día es un evento, no se descuentan
--   horas» (Halloween, competencia interna) y devolver las horas de una visita
--   puntual. Hasta hoy toda entrada/salida del torniquete descontaba del banco
--   de horas y una visita ya cerrada no se podía anular (pedido de Dreamers,
--   2026-11-21).
--
-- Qué trae:
--   1. hour_bank_exempt_days: los días de evento (fecha, franja opcional, motivo).
--   2. hour_bank_visits: columnas con el rastro de la devolución.
--   3. Trigger BEFORE UPDATE OF billed_minutes en hour_bank_visits: es el ÚNICO
--      punto que hace cumplir el día de evento. Las tres rutas que facturan una
--      visita (closeHourBankVisit y /correct en el BFF, y
--      auto_close_stale_hour_bank_visits en SQL) hacen primero move_hour_bank(+N)
--      y después escriben billed_minutes = N; el trigger deshace ese +N y deja la
--      visita en 0. No se reescribe ninguna de las tres.
--   4. waive_hour_bank_visit: «No descontar esta visita».
--   5. create_hour_bank_exempt_day / cancel_hour_bank_exempt_day. Crear un día
--      que ya pasó devuelve, en la misma transacción, lo que se descontó ese día.
--
-- Las tres RPC son solo para el BFF (service_role): no llevan GRANT a
-- authenticated. El alcance del actor se valida ADENTRO con _actor_rol_finanzas.
-- =============================================================================

BEGIN;

-- ─── 1. Días de evento ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hour_bank_exempt_days (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    exempt_date   date NOT NULL,
    -- Franja opcional (hora de Bogotá). NULL en ambas = todo el día.
    time_from     time,
    time_to       time,
    reason        text NOT NULL,
    created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    cancelled_at  timestamptz,
    cancelled_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT hour_bank_exempt_days_reason_chk CHECK (length(btrim(reason)) BETWEEN 3 AND 120),
    CONSTRAINT hour_bank_exempt_days_range_chk  CHECK (
        (time_from IS NULL AND time_to IS NULL)
        OR (time_from IS NOT NULL AND time_to IS NOT NULL AND time_to > time_from)
    )
);

CREATE INDEX IF NOT EXISTS hour_bank_exempt_days_school_date_idx
    ON public.hour_bank_exempt_days (school_id, exempt_date)
    WHERE cancelled_at IS NULL;

ALTER TABLE public.hour_bank_exempt_days ENABLE ROW LEVEL SECURITY;

-- Los privilegios por defecto del esquema le dan escritura a authenticated en
-- cada tabla nueva: se revoca todo y se deja solo lectura. Escribe el BFF.
REVOKE ALL ON TABLE public.hour_bank_exempt_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.hour_bank_exempt_days TO authenticated;

DROP POLICY IF EXISTS hour_bank_exempt_days_select_staff ON public.hour_bank_exempt_days;
CREATE POLICY hour_bank_exempt_days_select_staff
    ON public.hour_bank_exempt_days
    FOR SELECT
    TO authenticated
    USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

-- ─── 2. Rastro de la devolución en la visita ─────────────────────────────────
-- El estado de la visita no cambia (sigue closed / corrected): queda con
-- billed_minutes = 0 y waived_minutes = lo que se le devolvió.
ALTER TABLE public.hour_bank_visits
    ADD COLUMN IF NOT EXISTS waived_minutes integer,
    ADD COLUMN IF NOT EXISTS waived_at      timestamptz,
    ADD COLUMN IF NOT EXISTS waived_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS waive_reason   text,
    ADD COLUMN IF NOT EXISTS exempt_day_id  uuid REFERENCES public.hour_bank_exempt_days(id) ON DELETE SET NULL;

ALTER TABLE public.hour_bank_visits
    DROP CONSTRAINT IF EXISTS hour_bank_visits_waived_minutes_chk;
ALTER TABLE public.hour_bank_visits
    ADD CONSTRAINT hour_bank_visits_waived_minutes_chk
    CHECK (waived_minutes IS NULL OR waived_minutes >= 0);

CREATE INDEX IF NOT EXISTS hour_bank_visits_exempt_day_idx
    ON public.hour_bank_visits (exempt_day_id)
    WHERE exempt_day_id IS NOT NULL;

-- ─── 3. ¿Esta visita cae en un día de evento? ────────────────────────────────
-- Cuenta el INICIO de la visita, en hora de Bogotá. Helper interno: solo lo
-- llaman funciones SECURITY DEFINER de esta migración.
CREATE OR REPLACE FUNCTION public._hour_bank_exempt_day_for(p_school_id uuid, p_started_at timestamptz)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT d.id
      FROM public.hour_bank_exempt_days d
     WHERE d.school_id = p_school_id
       AND d.cancelled_at IS NULL
       AND d.exempt_date = (p_started_at AT TIME ZONE 'America/Bogota')::date
       AND (d.time_from IS NULL
            OR (p_started_at AT TIME ZONE 'America/Bogota')::time BETWEEN d.time_from AND d.time_to)
     ORDER BY d.created_at
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public._hour_bank_exempt_day_for(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

-- Trigger: la visita que se está facturando empezó en un día de evento → se
-- devuelve lo que la ruta acaba de sumar al período y la visita queda en 0.
CREATE OR REPLACE FUNCTION public._hour_bank_visit_apply_exempt_day()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_day_id uuid;
    v_reason text;
BEGIN
    IF NEW.billed_minutes IS NULL OR NEW.billed_minutes <= 0
       OR NEW.waived_at IS NOT NULL
       OR NEW.period_id IS NULL
       OR OLD.billed_minutes IS NOT DISTINCT FROM NEW.billed_minutes THEN
        RETURN NEW;
    END IF;

    v_day_id := public._hour_bank_exempt_day_for(NEW.school_id, NEW.started_at);
    IF v_day_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT d.reason INTO v_reason FROM public.hour_bank_exempt_days d WHERE d.id = v_day_id;

    PERFORM public.move_hour_bank(NEW.period_id, 0, -NEW.billed_minutes);

    NEW.waived_minutes := NEW.billed_minutes;
    NEW.billed_minutes := 0;
    NEW.waived_at      := now();
    NEW.waive_reason   := v_reason;
    NEW.exempt_day_id  := v_day_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._hour_bank_visit_apply_exempt_day() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS hour_bank_visits_apply_exempt_day ON public.hour_bank_visits;
CREATE TRIGGER hour_bank_visits_apply_exempt_day
    BEFORE UPDATE OF billed_minutes ON public.hour_bank_visits
    FOR EACH ROW
    EXECUTE FUNCTION public._hour_bank_visit_apply_exempt_day();

-- ─── 4. Devolver las horas de UNA visita ya facturada ────────────────────────
-- Interno: hace el movimiento. Devuelve los minutos devueltos (0 si no había
-- nada que devolver). El UPDATE pone billed_minutes = 0, así que el trigger de
-- arriba no vuelve a actuar.
CREATE OR REPLACE FUNCTION public._hour_bank_waive_visit(
    p_visit_id uuid, p_actor uuid, p_reason text, p_exempt_day_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_period  uuid;
    v_minutes integer;
BEGIN
    UPDATE public.hour_bank_visits v
       SET waived_minutes = v.billed_minutes,
           billed_minutes = 0,
           waived_at      = now(),
           waived_by      = p_actor,
           waive_reason   = btrim(p_reason),
           exempt_day_id  = p_exempt_day_id,
           updated_at     = now()
     WHERE v.id = p_visit_id
       AND v.waived_at IS NULL
       AND v.status IN ('closed', 'corrected')
       AND COALESCE(v.billed_minutes, 0) > 0
       AND v.period_id IS NOT NULL
    RETURNING v.period_id, v.waived_minutes INTO v_period, v_minutes;

    IF NOT FOUND THEN
        RETURN 0;
    END IF;

    PERFORM public.move_hour_bank(v_period, 0, -v_minutes);
    RETURN v_minutes;
END;
$$;

REVOKE ALL ON FUNCTION public._hour_bank_waive_visit(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.waive_hour_bank_visit(p_visit_id uuid, p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_visit    public.hour_bank_visits%ROWTYPE;
    v_minutes  integer;
    v_overage  text;
    v_avail    integer;
BEGIN
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 120 THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: escribe el motivo (entre 3 y 120 caracteres)' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_visit FROM public.hour_bank_visits WHERE id = p_visit_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NO_ENCONTRADA: la visita no existe' USING ERRCODE = 'P0001';
    END IF;

    IF public._actor_rol_finanzas(v_visit.school_id, p_actor) IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN: el usuario no administra esta escuela' USING ERRCODE = '42501';
    END IF;

    -- Idempotente: repetir sobre la misma visita no devuelve dos veces.
    IF v_visit.waived_at IS NOT NULL THEN
        RETURN jsonb_build_object('waived', false, 'duplicated', true,
                                  'minutes', COALESCE(v_visit.waived_minutes, 0),
                                  'period_id', v_visit.period_id);
    END IF;

    IF v_visit.status NOT IN ('closed', 'corrected') OR COALESCE(v_visit.billed_minutes, 0) <= 0 THEN
        RAISE EXCEPTION 'SIN_DESCUENTO: esta visita no descontó horas' USING ERRCODE = 'P0001';
    END IF;

    v_minutes := public._hour_bank_waive_visit(p_visit_id, p_actor, p_reason, NULL);

    -- Cargo por horas de más del período: el sugerido se recalcula solo; el
    -- confirmado ya es un cobro y no se toca (la escuela lo anula a mano).
    SELECT oc.status INTO v_overage FROM public.hour_bank_overage_charges oc WHERE oc.period_id = v_visit.period_id;
    IF v_overage = 'suggested' THEN
        PERFORM public.recompute_hour_bank_overage(v_visit.period_id);
    END IF;

    SELECT p.included_minutes - p.reserved_minutes - p.consumed_minutes INTO v_avail
      FROM public.hour_bank_periods p WHERE p.id = v_visit.period_id;

    RETURN jsonb_build_object('waived', true, 'duplicated', false, 'minutes', v_minutes,
                              'period_id', v_visit.period_id, 'available_minutes', v_avail,
                              'overage_confirmed', COALESCE(v_overage = 'confirmed', false));
END;
$$;

REVOKE ALL ON FUNCTION public.waive_hour_bank_visit(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.waive_hour_bank_visit(uuid, uuid, text) TO service_role;

-- ─── 5. Crear / cancelar un día de evento ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_hour_bank_exempt_day(
    p_school_id uuid, p_actor uuid, p_date date, p_reason text,
    p_time_from time DEFAULT NULL, p_time_to time DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_today     date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_day_id    uuid;
    v_visit     record;
    v_min       integer;
    v_visits    integer := 0;
    v_minutes   integer := 0;
    v_periods   uuid[] := '{}';
    v_enrolls   uuid[] := '{}';
    v_period    uuid;
    v_confirmed integer := 0;
    v_names     text[];
BEGIN
    IF public._actor_rol_finanzas(p_school_id, p_actor) IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN: el usuario no administra esta escuela' USING ERRCODE = '42501';
    END IF;
    IF p_date IS NULL OR p_date < v_today - 60 OR p_date > v_today + 366 THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: la fecha debe estar entre hace 60 días y un año adelante' USING ERRCODE = 'P0001';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 120 THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: escribe el motivo (entre 3 y 120 caracteres)' USING ERRCODE = 'P0001';
    END IF;
    IF (p_time_from IS NULL) <> (p_time_to IS NULL) OR (p_time_from IS NOT NULL AND p_time_to <= p_time_from) THEN
        RAISE EXCEPTION 'DATOS_INVALIDOS: la franja necesita hora de inicio y una hora de fin posterior' USING ERRCODE = 'P0001';
    END IF;

    -- Doble clic / reintento: el mismo día con la misma franja no se duplica.
    PERFORM pg_advisory_xact_lock(hashtextextended('hb_exempt:' || p_school_id::text || ':' || p_date::text, 0));
    SELECT d.id INTO v_day_id
      FROM public.hour_bank_exempt_days d
     WHERE d.school_id = p_school_id AND d.exempt_date = p_date AND d.cancelled_at IS NULL
       AND d.time_from IS NOT DISTINCT FROM p_time_from
       AND d.time_to   IS NOT DISTINCT FROM p_time_to
     LIMIT 1;
    IF v_day_id IS NOT NULL THEN
        RETURN jsonb_build_object('created', false, 'duplicated', true, 'id', v_day_id,
                                  'visits_waived', 0, 'minutes_returned', 0, 'athletes', '[]'::jsonb,
                                  'overage_confirmed', 0);
    END IF;

    INSERT INTO public.hour_bank_exempt_days (school_id, exempt_date, time_from, time_to, reason, created_by)
    VALUES (p_school_id, p_date, p_time_from, p_time_to, btrim(p_reason), p_actor)
    RETURNING id INTO v_day_id;

    -- Lo que ya se descontó ese día (fecha pasada, o evento que ya empezó hoy).
    FOR v_visit IN
        SELECT v.id, v.period_id, v.enrollment_id
          FROM public.hour_bank_visits v
         WHERE v.school_id = p_school_id
           AND v.status IN ('closed', 'corrected')
           AND COALESCE(v.billed_minutes, 0) > 0
           AND v.waived_at IS NULL
           AND v.period_id IS NOT NULL
           AND v.started_at >= (p_date::timestamp AT TIME ZONE 'America/Bogota')
           AND v.started_at <  ((p_date + 1)::timestamp AT TIME ZONE 'America/Bogota')
           AND (p_time_from IS NULL
                OR (v.started_at AT TIME ZONE 'America/Bogota')::time BETWEEN p_time_from AND p_time_to)
         ORDER BY v.started_at
           FOR UPDATE OF v
    LOOP
        v_min := public._hour_bank_waive_visit(v_visit.id, p_actor, p_reason, v_day_id);
        IF v_min > 0 THEN
            v_visits  := v_visits + 1;
            v_minutes := v_minutes + v_min;
            IF NOT (v_visit.period_id = ANY (v_periods)) THEN
                v_periods := v_periods || v_visit.period_id;
            END IF;
            IF NOT (v_visit.enrollment_id = ANY (v_enrolls)) THEN
                v_enrolls := v_enrolls || v_visit.enrollment_id;
            END IF;
        END IF;
    END LOOP;

    FOREACH v_period IN ARRAY v_periods LOOP
        PERFORM public.recompute_hour_bank_overage(v_period);
    END LOOP;

    SELECT count(*) INTO v_confirmed
      FROM public.hour_bank_overage_charges oc
     WHERE oc.period_id = ANY (v_periods) AND oc.status = 'confirmed';

    SELECT array_agg(n ORDER BY n) INTO v_names
      FROM (
        SELECT COALESCE(c.full_name, p.full_name, ua.full_name, 'Atleta') AS n
          FROM public.enrollments e
          LEFT JOIN public.profiles p ON p.id = e.user_id
          LEFT JOIN public.children c ON c.id = e.child_id
          LEFT JOIN public.unregistered_athletes ua ON ua.id = e.unregistered_athlete_id
         WHERE e.id = ANY (v_enrolls)
      ) s;

    RETURN jsonb_build_object('created', true, 'duplicated', false, 'id', v_day_id,
                              'visits_waived', v_visits, 'minutes_returned', v_minutes,
                              'athletes', COALESCE(to_jsonb(v_names), '[]'::jsonb),
                              'overage_confirmed', v_confirmed);
END;
$$;

REVOKE ALL ON FUNCTION public.create_hour_bank_exempt_day(uuid, uuid, date, text, time, time) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_hour_bank_exempt_day(uuid, uuid, date, text, time, time) TO service_role;

-- Cancelar solo deja de aplicar hacia adelante: lo ya devuelto NO se vuelve a
-- descontar (las visitas conservan su rastro).
CREATE OR REPLACE FUNCTION public.cancel_hour_bank_exempt_day(p_day_id uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_day public.hour_bank_exempt_days%ROWTYPE;
BEGIN
    SELECT * INTO v_day FROM public.hour_bank_exempt_days WHERE id = p_day_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NO_ENCONTRADO: el día de evento no existe' USING ERRCODE = 'P0001';
    END IF;
    IF public._actor_rol_finanzas(v_day.school_id, p_actor) IS NULL THEN
        RAISE EXCEPTION 'FORBIDDEN: el usuario no administra esta escuela' USING ERRCODE = '42501';
    END IF;
    IF v_day.cancelled_at IS NOT NULL THEN
        RETURN jsonb_build_object('cancelled', false, 'duplicated', true, 'id', v_day.id);
    END IF;

    UPDATE public.hour_bank_exempt_days
       SET cancelled_at = now(), cancelled_by = p_actor
     WHERE id = p_day_id;

    RETURN jsonb_build_object('cancelled', true, 'duplicated', false, 'id', v_day.id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_hour_bank_exempt_day(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_hour_bank_exempt_day(uuid, uuid) TO service_role;

COMMIT;
