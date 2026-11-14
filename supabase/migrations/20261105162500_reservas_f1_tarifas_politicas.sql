-- =============================================================================
-- 20261105162500_reservas_f1_tarifas_politicas.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105162331
-- Objetivo: F1 · M2 — tarifas, bloqueos y políticas de cancelación
--   (docs/specs/reservas-canchas-plan-unificado-2026-10.md §2.3).
--
--   facility_rates         tarifa por franja y público (public/member); si no hay fila
--                          se usa rental_rate / hourly_rate de la instalación.
--   facility_blackouts     mantenimiento / lluvia / cierre. Escribe ocupación 'blackout'.
--   cancellation_policies  política de reembolso por escuela (y opcional por cancha).
--   co_holidays            festivos de Colombia (se cobran como domingo). Interna.
--
-- RLS (spec §7, I2/I3): lectura user_school_ids() (tarifas y políticas); escritura de tarifas y
-- políticas user_admin_school_ids(); blackouts: lectura Y escritura user_staff_school_ids()
-- (reason es interno). Orden requerido: después de reservas_f1_columnas. Policies
-- separadas por comando, todas con WITH CHECK. Sin acceso anon.
-- El school_id de cada fila se FUERZA desde la instalación (trigger), así nadie
-- crea una tarifa de la escuela B apuntando a una cancha de la escuela A.
-- =============================================================================

BEGIN;

-- ── school_id siempre = escuela de la instalación ────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_facility_child_school()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
BEGIN
  IF NEW.facility_id IS NOT NULL THEN
    SELECT f.school_id INTO v_school FROM public.facilities f WHERE f.id = NEW.facility_id;
    IF v_school IS NULL THEN
      RAISE EXCEPTION 'facility_not_found' USING ERRCODE = 'P0001';
    END IF;
    NEW.school_id := v_school;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_facility_child_school() FROM PUBLIC, anon, authenticated;

-- ── facility_rates ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facility_rates (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id       uuid          NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  facility_id     uuid          NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  audience        text          NOT NULL CHECK (audience IN ('public', 'member')),
  weekdays        smallint[]    NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]::smallint[],
  from_time       time          NOT NULL,
  to_time         time          NOT NULL,
  price_per_hour  numeric(12,2) NOT NULL CHECK (price_per_hour >= 0),
  priority        integer       NOT NULL DEFAULT 0,
  valid_from      date,
  valid_to        date,
  label           text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT facility_rates_franja_valida   CHECK (to_time > from_time),
  CONSTRAINT facility_rates_dias_validos    CHECK (cardinality(weekdays) > 0 AND weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  CONSTRAINT facility_rates_vigencia_valida CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
);

COMMENT ON TABLE public.facility_rates IS
  'Tarifa por hora según franja, día (0=domingo..6; festivos CO cuentan como domingo) y público. Gana la de mayor priority. Sin fila: rental_rate/hourly_rate de la instalación.';

CREATE INDEX IF NOT EXISTS idx_facility_rates_facility ON public.facility_rates (facility_id, audience);
CREATE INDEX IF NOT EXISTS idx_facility_rates_school   ON public.facility_rates (school_id);

DROP TRIGGER IF EXISTS trg_facility_rates_school ON public.facility_rates;
CREATE TRIGGER trg_facility_rates_school
  BEFORE INSERT OR UPDATE ON public.facility_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_child_school();

DROP TRIGGER IF EXISTS trg_updated_at ON public.facility_rates;
CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON public.facility_rates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.facility_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.facility_rates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.facility_rates TO authenticated;

DROP POLICY IF EXISTS facility_rates_select ON public.facility_rates;
CREATE POLICY facility_rates_select ON public.facility_rates
  FOR SELECT TO authenticated
  USING (school_id = ANY (public.user_school_ids()));

DROP POLICY IF EXISTS facility_rates_insert ON public.facility_rates;
CREATE POLICY facility_rates_insert ON public.facility_rates
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

DROP POLICY IF EXISTS facility_rates_update ON public.facility_rates;
CREATE POLICY facility_rates_update ON public.facility_rates
  FOR UPDATE TO authenticated
  USING (school_id = ANY (public.user_admin_school_ids()))
  WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

DROP POLICY IF EXISTS facility_rates_delete ON public.facility_rates;
CREATE POLICY facility_rates_delete ON public.facility_rates
  FOR DELETE TO authenticated
  USING (school_id = ANY (public.user_admin_school_ids()));

-- ── facility_blackouts ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.facility_blackouts (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id    uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  facility_id  uuid        NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  kind         text        NOT NULL DEFAULT 'maintenance' CHECK (kind IN ('maintenance', 'weather', 'closed', 'other')),
  reason       text,
  created_by   uuid        REFERENCES public.profiles(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT facility_blackouts_rango_valido CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '365 days')
);

COMMENT ON TABLE public.facility_blackouts IS
  'Cierre de una instalación (mantenimiento, lluvia, evento). Escribe facility_occupancy source_kind=blackout; si choca con una reserva vigente falla con BLACKOUT_OVERLAPS_OCCUPANCY.';

CREATE INDEX IF NOT EXISTS idx_facility_blackouts_facility ON public.facility_blackouts (facility_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_facility_blackouts_school   ON public.facility_blackouts (school_id);

DROP TRIGGER IF EXISTS trg_facility_blackouts_school ON public.facility_blackouts;
CREATE TRIGGER trg_facility_blackouts_school
  BEFORE INSERT OR UPDATE ON public.facility_blackouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_child_school();

DROP TRIGGER IF EXISTS trg_updated_at ON public.facility_blackouts;
CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON public.facility_blackouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.fn_facility_blackout_sync_ocupacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.facility_occupancy
       SET status = 'released', updated_at = now()
     WHERE source_kind = 'blackout' AND source_id = OLD.id AND status <> 'released';
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.facility_occupancy
       SET school_id   = NEW.school_id,
           facility_id = NEW.facility_id,
           slot        = tstzrange(NEW.starts_at, NEW.ends_at, '[)'),
           status      = 'active',
           hold_expires_at = NULL,
           updated_at  = now()
     WHERE source_kind = 'blackout' AND source_id = NEW.id;

    IF NOT FOUND THEN
      INSERT INTO public.facility_occupancy
        (school_id, facility_id, slot, source_kind, source_id, status)
      VALUES
        (NEW.school_id, NEW.facility_id, tstzrange(NEW.starts_at, NEW.ends_at, '[)'), 'blackout', NEW.id, 'active');
    END IF;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'BLACKOUT_OVERLAPS_OCCUPANCY: ya hay una reserva, clase o evento vigente en ese horario; cancélalo o muévelo primero'
      USING ERRCODE = '23P01';
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_facility_blackout_sync_ocupacion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_facility_blackout_sync ON public.facility_blackouts;
CREATE TRIGGER trg_facility_blackout_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.facility_blackouts
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_blackout_sync_ocupacion();

ALTER TABLE public.facility_blackouts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.facility_blackouts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.facility_blackouts TO authenticated;

DROP POLICY IF EXISTS facility_blackouts_select ON public.facility_blackouts;
CREATE POLICY facility_blackouts_select ON public.facility_blackouts
  FOR SELECT TO authenticated
  USING (school_id = ANY (public.user_staff_school_ids()));   -- reason es interno; los miembros ven el efecto por la disponibilidad

DROP POLICY IF EXISTS facility_blackouts_insert ON public.facility_blackouts;
CREATE POLICY facility_blackouts_insert ON public.facility_blackouts
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY (public.user_staff_school_ids()));

DROP POLICY IF EXISTS facility_blackouts_update ON public.facility_blackouts;
CREATE POLICY facility_blackouts_update ON public.facility_blackouts
  FOR UPDATE TO authenticated
  USING (school_id = ANY (public.user_staff_school_ids()))
  WITH CHECK (school_id = ANY (public.user_staff_school_ids()));

DROP POLICY IF EXISTS facility_blackouts_delete ON public.facility_blackouts;
CREATE POLICY facility_blackouts_delete ON public.facility_blackouts
  FOR DELETE TO authenticated
  USING (school_id = ANY (public.user_staff_school_ids()));

-- ── cancellation_policies ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cancellation_policies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id             uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  facility_id           uuid        REFERENCES public.facilities(id) ON DELETE CASCADE,
  hours_full_refund     integer     NOT NULL DEFAULT 24 CHECK (hours_full_refund >= 0),
  hours_partial_refund  integer     NOT NULL DEFAULT 6  CHECK (hours_partial_refund >= 0),
  partial_pct           integer     NOT NULL DEFAULT 50 CHECK (partial_pct BETWEEN 0 AND 100),
  no_show_penalty_pct   integer     NOT NULL DEFAULT 100 CHECK (no_show_penalty_pct BETWEEN 0 AND 100),
  is_active             boolean     NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_policies_ventanas_validas CHECK (hours_partial_refund <= hours_full_refund)
);

COMMENT ON TABLE public.cancellation_policies IS
  'Política de reembolso de reservas: >= hours_full_refund h antes = 100 %, >= hours_partial_refund h = partial_pct %, después 0 %. facility_id NULL = política de la escuela. Sin fila: 24/6/50 (D10).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_escuela
  ON public.cancellation_policies (school_id) WHERE facility_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cancellation_policies_cancha
  ON public.cancellation_policies (school_id, facility_id) WHERE facility_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_cancellation_policies_school ON public.cancellation_policies;
CREATE TRIGGER trg_cancellation_policies_school
  BEFORE INSERT OR UPDATE ON public.cancellation_policies
  FOR EACH ROW EXECUTE FUNCTION public.fn_facility_child_school();

DROP TRIGGER IF EXISTS trg_updated_at ON public.cancellation_policies;
CREATE TRIGGER trg_updated_at
  BEFORE UPDATE ON public.cancellation_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.cancellation_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cancellation_policies FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cancellation_policies TO authenticated;

DROP POLICY IF EXISTS cancellation_policies_select ON public.cancellation_policies;
CREATE POLICY cancellation_policies_select ON public.cancellation_policies
  FOR SELECT TO authenticated
  USING (school_id = ANY (public.user_school_ids()));

DROP POLICY IF EXISTS cancellation_policies_insert ON public.cancellation_policies;
CREATE POLICY cancellation_policies_insert ON public.cancellation_policies
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

DROP POLICY IF EXISTS cancellation_policies_update ON public.cancellation_policies;
CREATE POLICY cancellation_policies_update ON public.cancellation_policies
  FOR UPDATE TO authenticated
  USING (school_id = ANY (public.user_admin_school_ids()))
  WITH CHECK (school_id = ANY (public.user_admin_school_ids()));

DROP POLICY IF EXISTS cancellation_policies_delete ON public.cancellation_policies;
CREATE POLICY cancellation_policies_delete ON public.cancellation_policies
  FOR DELETE TO authenticated
  USING (school_id = ANY (public.user_admin_school_ids()));

-- ── co_holidays (interna: solo la leen las RPC SECURITY DEFINER) ─────────────
CREATE TABLE IF NOT EXISTS public.co_holidays (
  holiday_date date PRIMARY KEY,
  name         text NOT NULL
);

COMMENT ON TABLE public.co_holidays IS
  'Festivos de Colombia (Ley Emiliani). Las reservas los cobran como domingo. Cargados 2026-2028 (verificados). Agregar 2029 antes de fin de 2028.';

ALTER TABLE public.co_holidays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.co_holidays FROM PUBLIC, anon, authenticated;

INSERT INTO public.co_holidays (holiday_date, name) VALUES
  -- 2026
  ('2026-01-01', 'Año Nuevo'), ('2026-01-12', 'Reyes Magos'), ('2026-03-23', 'San José'),
  ('2026-04-02', 'Jueves Santo'), ('2026-04-03', 'Viernes Santo'), ('2026-05-01', 'Día del Trabajo'),
  ('2026-05-18', 'Ascensión del Señor'), ('2026-06-08', 'Corpus Christi'), ('2026-06-15', 'Sagrado Corazón'),
  ('2026-06-29', 'San Pedro y San Pablo'), ('2026-07-20', 'Día de la Independencia'),
  ('2026-08-07', 'Batalla de Boyacá'), ('2026-08-17', 'Asunción de la Virgen'),
  ('2026-10-12', 'Día de la Raza'), ('2026-11-02', 'Todos los Santos'),
  ('2026-11-16', 'Independencia de Cartagena'), ('2026-12-08', 'Inmaculada Concepción'),
  ('2026-12-25', 'Navidad'),
  -- 2027
  ('2027-01-01', 'Año Nuevo'), ('2027-01-11', 'Reyes Magos'), ('2027-03-22', 'San José'),
  ('2027-03-25', 'Jueves Santo'), ('2027-03-26', 'Viernes Santo'), ('2027-05-01', 'Día del Trabajo'),
  ('2027-05-10', 'Ascensión del Señor'), ('2027-05-31', 'Corpus Christi'), ('2027-06-07', 'Sagrado Corazón'),
  ('2027-07-05', 'San Pedro y San Pablo'), ('2027-07-20', 'Día de la Independencia'),
  ('2027-08-07', 'Batalla de Boyacá'), ('2027-08-16', 'Asunción de la Virgen'),
  ('2027-10-18', 'Día de la Raza'), ('2027-11-01', 'Todos los Santos'),
  ('2027-11-15', 'Independencia de Cartagena'), ('2027-12-08', 'Inmaculada Concepción'),
  ('2027-12-25', 'Navidad'),
  -- 2028 (Pascua = 16-abr; móviles al lunes siguiente)
  ('2028-01-01', 'Año Nuevo'), ('2028-01-10', 'Reyes Magos'), ('2028-03-20', 'San José'),
  ('2028-04-13', 'Jueves Santo'), ('2028-04-14', 'Viernes Santo'), ('2028-05-01', 'Día del Trabajo'),
  ('2028-05-29', 'Ascensión del Señor'), ('2028-06-19', 'Corpus Christi'), ('2028-06-26', 'Sagrado Corazón'),
  ('2028-07-03', 'San Pedro y San Pablo'), ('2028-07-20', 'Día de la Independencia'),
  ('2028-08-07', 'Batalla de Boyacá'), ('2028-08-21', 'Asunción de la Virgen'),
  ('2028-10-16', 'Día de la Raza'), ('2028-11-06', 'Todos los Santos'),
  ('2028-11-13', 'Independencia de Cartagena'), ('2028-12-08', 'Inmaculada Concepción'),
  ('2028-12-25', 'Navidad')
ON CONFLICT (holiday_date) DO NOTHING;

COMMIT;
