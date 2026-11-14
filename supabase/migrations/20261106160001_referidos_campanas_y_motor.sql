-- =============================================================================
-- 20261106160001 · Referidos automáticos: campañas por escuela + motor de descuento
-- Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md (§4, F1)
--
-- QUÉ HACE
--   1. school_discount_campaigns : campaña configurable por escuela (hoy kind='referral').
--                                  APAGADA por defecto (active=false).
--   2. enrollment_referrals      : un renglón por referido (quién refirió a quién, %, mes).
--   3. RPCs (SECURITY DEFINER, alcance validado ADENTRO sobre ESE school_id):
--        register_enrollment_referral, update_enrollment_referral,
--        qualify_enrollment_referrals, referrals_report, upsert_school_discount_campaign
--      + helpers internos (_referral_*), sin EXECUTE para nadie salvo el dueño.
--   4. open_month y preview_open_month: se redefinen con CREATE OR REPLACE a partir de
--      la definición VIVA leída de pg_proc el 2026-11-06 (7454 / 6311 caracteres), y se
--      les agrega SOLO el descuento por referido.
--
-- AISLAMIENTO (LO MÁS IMPORTANTE DE ESTA MIGRACIÓN)
--   open_month genera los cobros de TODAS las escuelas. Con la campaña apagada
--   (o inexistente), o sin renglones 'ganado' que toquen ese mes, el resultado es
--   IDÉNTICO al de hoy: mismas filas, mismos montos, mismo concepto, mismas columnas.
--     · El lateral `rf` devuelve 0 filas si v_ref_on es false (WHERE v_ref_on ...).
--     · Con rf NULL: sib.pct, fee.amount y fee.sibling_discount_applied valen EXACTAMENTE
--       lo mismo que antes (la rama nueva del CASE solo entra si rf.referral_id no es null).
--     · `notes` se inserta NULL (el default de la columna ya es NULL).
--     · No se toma ningún lock nuevo si la campaña está apagada.
--   Se conserva todo lo demás: gate de admin, lock por escuela/mes, corte y gracia,
--   hermanos escalonados, fee_is_manual (beca / cuota manual), pausa aprobada, dedup
--   contra payments, ON CONFLICT DO NOTHING (idempotencia) y filtro de sede.
--
-- REGLAS DEL DESCUENTO POR REFERIDO (decisiones D3, D4, D8 con los valores por defecto)
--   · El renglón 'ganado' se aplica en el mes apply_year/apply_month o, si ese mes ya
--     pasó sin poder aplicarse (referente atrasado), en el primer cierre posterior:
--     (apply_year*12+apply_month) <= (año*12+mes) del cierre. Un renglón por deportista
--     y por cierre (LIMIT 1): dos referidos = meses consecutivos, nunca dos a la vez.
--   · Reemplaza al descuento de hermanos ESE mes (sib.pct = 0 cuando hay referido).
--   · No aplica a inscripciones con fee_is_manual (beca, incluida la de 100 %, o cuota
--     manual, incluido el «referido» manual de 2026-09): el manual manda y no se
--     acumulan dos descuentos sobre el mismo deportista. El renglón queda 'ganado'.
--   · require_referrer_current: el referente debe estar activo y sin mensualidades
--     vencidas de meses anteriores (pending/overdue/partial con due_date < inicio del
--     mes, del deportista o de la familia pagadora). Si no, el renglón espera.
--   · El % queda congelado en el renglón. El cobro lleva el motivo legible en
--     payments.notes: «Descuento N % por referido: <nombre del referido>».
--   · Se marca 'aplicado' + applied_payment_id EN LA MISMA sentencia que inserta el cobro
--     (CTE modificadora), bajo un advisory lock por escuela ('referidos:<school>') que
--     comparten update_enrollment_referral y qualify_enrollment_referrals: un cierre
--     repetido o concurrente no aplica dos veces y una anulación no se cruza con el cierre.
--   · No se escribe sibling_discount_applied ni list_amount/discount_amount: el descuento
--     por referido NO pasa por _descuentos_automaticos_calc ni por payment_adjustments
--     (tocar ese trigger fuera de alcance); el informe sale de enrollment_referrals.
--
-- SEGURIDAD
--   · text + CHECK (sin CREATE TYPE). FKs de negocio a profiles(id).
--   · RLS: una policy por comando. Campañas: lectura staff, escritura admin
--     (user_*_school_ids envueltos en SELECT). Referidos: SOLO lectura staff; la
--     escritura va únicamente por las RPC (desviación deliberada del «escritura con
--     admin»: un UPDATE directo de status/pct se saltaría las validaciones de familia,
--     edad y mes). Sin anon. REVOKE ALL ... FROM PUBLIC, anon + GRANT explícito.
--   · Cada RPC: search_path fijo, EXECUTE solo a authenticated (+ service_role en las
--     de lote), alcance validado adentro con _referral_assert_scope.
--   · p_actor: la BFF entra con service_role (auth.uid() NULL) y pasa el actor, igual que
--     las RPC de «Cobros y pagos». Con JWT de usuario manda auth.uid() y p_actor se ignora.
--     Sin ningún actor solo se llega por service_role (anon/PUBLIC no tienen EXECUTE):
--     es el camino del job diario y del bot.
--
-- DISK IO: sin lectura del catálogo, sin N+1 (qualify lee en lote y escribe con un solo
-- UPDATE ... FROM unnest). No regenerar types.ts hasta cerrar el lote de migraciones.
--
-- ROLLBACK (si hiciera falta): restaurar open_month / preview_open_month desde la
-- migración que las definió por última vez (20261014212627 + hermanos escalonados) con
-- CREATE OR REPLACE, y DROP de las dos tablas y las funciones de esta migración.
-- =============================================================================

-- ─── 0. Helper de validación de tramos (lo usa un CHECK: necesita EXECUTE) ───
CREATE OR REPLACE FUNCTION public._referral_tiers_valid(p_tiers jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_tiers IS NULL OR jsonb_typeof(p_tiers) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_tiers) NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_tiers) e WHERE jsonb_typeof(e) <> 'object') THEN
    RETURN false;
  END IF;
  -- Cada tramo: age_min >= 0, age_max NULL o >= age_min, 0 < pct < 100.
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_tiers) AS t(age_min int, age_max int, pct numeric)
    WHERE t.age_min IS NULL OR t.age_min < 0
       OR (t.age_max IS NOT NULL AND t.age_max < t.age_min)
       OR t.pct IS NULL OR t.pct <= 0 OR t.pct >= 100
  ) THEN
    RETURN false;
  END IF;
  -- Sin tramos que se pisen.
  IF EXISTS (
    WITH t AS (
      SELECT x.age_min, x.age_max, row_number() OVER () AS n
      FROM jsonb_to_recordset(p_tiers) AS x(age_min int, age_max int, pct numeric)
    )
    SELECT 1 FROM t a JOIN t b ON a.n < b.n
     AND a.age_min <= COALESCE(b.age_max, 1000)
     AND b.age_min <= COALESCE(a.age_max, 1000)
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public._referral_tiers_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._referral_tiers_valid(jsonb) TO authenticated, service_role;

-- ─── 1. Tablas ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.school_discount_campaigns (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  kind                     text NOT NULL DEFAULT 'referral' CHECK (kind IN ('referral')),
  name                     text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active                   boolean NOT NULL DEFAULT false,
  starts_on                date,
  ends_on                  date,
  -- Tramos por edad del REFERIDO. Ej: [{"age_min":4,"age_max":15,"pct":50},{"age_min":16,"age_max":null,"pct":25}]
  tiers                    jsonb NOT NULL,
  -- F1: un mes de descuento por referido. El modelo lo guarda; el motor aún no soporta >1.
  reward_months            int NOT NULL DEFAULT 1 CHECK (reward_months = 1),
  max_pending              int NOT NULL DEFAULT 12 CHECK (max_pending BETWEEN 1 AND 36),
  require_referrer_current boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_discount_campaigns_dates CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT school_discount_campaigns_tiers CHECK (public._referral_tiers_valid(tiers)),
  CONSTRAINT school_discount_campaigns_school_kind UNIQUE (school_id, kind)
);

CREATE TABLE IF NOT EXISTS public.enrollment_referrals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  campaign_id              uuid NOT NULL REFERENCES public.school_discount_campaigns(id) ON DELETE RESTRICT,
  referred_enrollment_id   uuid NOT NULL UNIQUE REFERENCES public.enrollments(id) ON DELETE CASCADE,
  referrer_enrollment_id   uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  referrer_profile_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  referrer_name_text       text CHECK (referrer_name_text IS NULL OR length(referrer_name_text) <= 120),
  referred_age_at_enrollment int NOT NULL CHECK (referred_age_at_enrollment >= 0),
  pct                      numeric NOT NULL CHECK (pct > 0 AND pct < 100),
  status                   text NOT NULL DEFAULT 'sin_confirmar'
                             CHECK (status IN ('sin_confirmar','pendiente','ganado','aplicado','anulado','vencido')),
  status_reason            text CHECK (status_reason IS NULL OR length(status_reason) <= 200),
  qualified_at             timestamptz,
  apply_year               int CHECK (apply_year IS NULL OR apply_year BETWEEN 2020 AND 2100),
  apply_month              int CHECK (apply_month IS NULL OR apply_month BETWEEN 1 AND 12),
  applied_payment_id       uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  created_by               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_referrals_ganado_completo CHECK (
    status NOT IN ('ganado','aplicado')
    OR (apply_year IS NOT NULL AND apply_month IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS enrollment_referrals_school_status_idx
  ON public.enrollment_referrals (school_id, status);
CREATE INDEX IF NOT EXISTS enrollment_referrals_ganado_referrer_idx
  ON public.enrollment_referrals (referrer_enrollment_id) WHERE status = 'ganado';
CREATE INDEX IF NOT EXISTS enrollment_referrals_apply_idx
  ON public.enrollment_referrals (school_id, apply_year, apply_month);
CREATE INDEX IF NOT EXISTS enrollment_referrals_campaign_idx
  ON public.enrollment_referrals (campaign_id);

DROP TRIGGER IF EXISTS trg_updated_at ON public.school_discount_campaigns;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.school_discount_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_updated_at ON public.enrollment_referrals;
CREATE TRIGGER trg_updated_at BEFORE UPDATE ON public.enrollment_referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. RLS (una policy por comando; sin anon) ───────────────────────────────
ALTER TABLE public.school_discount_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollment_referrals     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_discount_campaigns_select ON public.school_discount_campaigns;
CREATE POLICY school_discount_campaigns_select ON public.school_discount_campaigns
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

DROP POLICY IF EXISTS school_discount_campaigns_insert ON public.school_discount_campaigns;
CREATE POLICY school_discount_campaigns_insert ON public.school_discount_campaigns
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS school_discount_campaigns_update ON public.school_discount_campaigns;
CREATE POLICY school_discount_campaigns_update ON public.school_discount_campaigns
  FOR UPDATE TO authenticated
  USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS school_discount_campaigns_delete ON public.school_discount_campaigns;
CREATE POLICY school_discount_campaigns_delete ON public.school_discount_campaigns
  FOR DELETE TO authenticated
  USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- Referidos: solo lectura directa. La escritura es por RPC (ver encabezado).
DROP POLICY IF EXISTS enrollment_referrals_select ON public.enrollment_referrals;
CREATE POLICY enrollment_referrals_select ON public.enrollment_referrals
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

REVOKE ALL ON TABLE public.school_discount_campaigns FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.enrollment_referrals      FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_discount_campaigns TO authenticated, service_role;
GRANT SELECT ON TABLE public.enrollment_referrals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.enrollment_referrals TO service_role;

-- ─── 3. Helpers internos (solo los llaman funciones SECURITY DEFINER) ────────

-- Alcance del caller sobre ESE school_id. Devuelve el actor (NULL = service_role/backend).
CREATE OR REPLACE FUNCTION public._referral_assert_scope(p_school_id uuid, p_actor uuid, p_write boolean)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid := COALESCE(auth.uid(), p_actor);
  v_ok    boolean;
BEGIN
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'REF_ESCUELA_REQUERIDA' USING ERRCODE = '22023';
  END IF;
  -- Sin actor: solo service_role / dueño (anon y PUBLIC no tienen EXECUTE).
  IF v_actor IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_uid IS NOT NULL THEN
    -- JWT de usuario: las funciones de alcance de la base.
    IF p_write THEN
      v_ok := public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids());
    ELSE
      v_ok := public.is_super_admin()
           OR p_school_id = ANY (public.user_admin_school_ids())
           OR p_school_id = ANY (public.user_staff_school_ids());
    END IF;
  ELSE
    -- service_role con actor explícito (la BFF): misma regla que assertSchoolFinance*.
    v_ok := EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = v_actor AND pa.is_active)
         OR EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.owner_id = v_actor)
         OR EXISTS (
              SELECT 1 FROM public.school_members m
              WHERE m.school_id = p_school_id AND m.profile_id = v_actor AND m.status = 'active'
                AND m.role = ANY (CASE WHEN p_write
                                       THEN ARRAY['owner','admin','school_admin']
                                       ELSE ARRAY['owner','admin','school_admin','accountant'] END)
            );
  END IF;

  IF NOT COALESCE(v_ok, false) THEN
    RAISE EXCEPTION 'No autorizado para administrar referidos de esta escuela.' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END;
$$;
REVOKE ALL ON FUNCTION public._referral_assert_scope(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;

-- % según tramos y edad del referido (NULL = no califica).
CREATE OR REPLACE FUNCTION public._referral_pct_for_age(p_tiers jsonb, p_age int)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT t.pct
  FROM jsonb_to_recordset(p_tiers) AS t(age_min int, age_max int, pct numeric)
  WHERE p_age >= t.age_min AND (t.age_max IS NULL OR p_age <= t.age_max)
  ORDER BY t.age_min DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._referral_pct_for_age(jsonb, int) FROM PUBLIC, anon, authenticated;

-- D4: inscripción del referente cuando solo se conoce a la persona (perfil).
-- Propia si es deportista adulto; si es familia, la de MAYOR mensualidad entre sus hijos.
CREATE OR REPLACE FUNCTION public._referral_resolve_referrer_enrollment(p_school_id uuid, p_profile_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT e.id
  FROM public.enrollments e
  LEFT JOIN public.children c ON c.id = e.child_id
  LEFT JOIN public.teams t    ON t.id = e.team_id
  WHERE e.school_id = p_school_id
    AND e.status = 'active'
    AND (e.user_id = p_profile_id OR c.parent_id = p_profile_id)
  ORDER BY (e.user_id = p_profile_id) DESC,
           COALESCE(NULLIF(e.monthly_fee, 0),
                    NULLIF((SELECT op.price FROM public.offering_plans op WHERE op.id = e.offering_plan_id), 0),
                    NULLIF(t.price_monthly, 0), NULLIF(c.monthly_fee, 0), 0) DESC,
           e.created_at ASC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._referral_resolve_referrer_enrollment(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Valida el par referido/referente: misma escuela, referente activo, no autorreferido,
-- no de la misma familia (hermanos ya tiene su regla). Lanza REF_*.
CREATE OR REPLACE FUNCTION public._referral_check_pair(
  p_school_id uuid, p_referred_enrollment_id uuid, p_referrer_enrollment_id uuid, p_referrer_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  d record;  -- referido
  r record;  -- referente
BEGIN
  SELECT e.school_id, e.child_id, e.user_id, e.unregistered_athlete_id, c.parent_id
    INTO d
    FROM public.enrollments e LEFT JOIN public.children c ON c.id = e.child_id
   WHERE e.id = p_referred_enrollment_id;
  IF NOT FOUND OR d.school_id IS DISTINCT FROM p_school_id THEN
    RAISE EXCEPTION 'REF_INSCRIPCION_NO_ENCONTRADA' USING ERRCODE = 'P0002';
  END IF;

  IF p_referrer_profile_id IS NOT NULL
     AND (p_referrer_profile_id = d.user_id OR p_referrer_profile_id = d.parent_id) THEN
    RAISE EXCEPTION 'REF_MISMA_FAMILIA' USING ERRCODE = 'P0001';
  END IF;

  IF p_referrer_enrollment_id IS NULL THEN
    RETURN;
  END IF;

  SELECT e.school_id, e.status, e.child_id, e.user_id, e.unregistered_athlete_id, c.parent_id
    INTO r
    FROM public.enrollments e LEFT JOIN public.children c ON c.id = e.child_id
   WHERE e.id = p_referrer_enrollment_id;
  IF NOT FOUND OR r.school_id IS DISTINCT FROM p_school_id THEN
    RAISE EXCEPTION 'REF_REFERENTE_NO_ENCONTRADO' USING ERRCODE = 'P0002';
  END IF;
  IF r.status <> 'active' THEN
    RAISE EXCEPTION 'REF_REFERENTE_INACTIVO' USING ERRCODE = 'P0001';
  END IF;

  IF COALESCE(r.child_id, r.user_id, r.unregistered_athlete_id)
     = COALESCE(d.child_id, d.user_id, d.unregistered_athlete_id) THEN
    RAISE EXCEPTION 'REF_AUTOREFERIDO' USING ERRCODE = 'P0001';
  END IF;

  IF (d.parent_id IS NOT NULL AND (r.parent_id = d.parent_id OR r.user_id = d.parent_id))
     OR (d.user_id IS NOT NULL AND r.parent_id = d.user_id)
     OR (d.child_id IS NOT NULL AND r.child_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public._sibling_family(p_school_id, ARRAY[d.child_id]) f WHERE f.child_id = r.child_id))
  THEN
    RAISE EXCEPTION 'REF_MISMA_FAMILIA' USING ERRCODE = 'P0001';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._referral_check_pair(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ─── 4. RPC: configurar la campaña ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_school_discount_campaign(
  p_school_id uuid,
  p_name text,
  p_active boolean,
  p_tiers jsonb,
  p_starts_on date DEFAULT NULL,
  p_ends_on date DEFAULT NULL,
  p_max_pending int DEFAULT 12,
  p_require_referrer_current boolean DEFAULT true,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_row   public.school_discount_campaigns;
BEGIN
  v_actor := public._referral_assert_scope(p_school_id, p_actor, true);
  IF NOT public._referral_tiers_valid(p_tiers) THEN
    RAISE EXCEPTION 'REF_TRAMOS_INVALIDOS' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.school_discount_campaigns AS c
    (school_id, kind, name, active, starts_on, ends_on, tiers, max_pending, require_referrer_current, created_by)
  VALUES
    (p_school_id, 'referral', p_name, COALESCE(p_active, false), p_starts_on, p_ends_on, p_tiers,
     COALESCE(p_max_pending, 12), COALESCE(p_require_referrer_current, true), v_actor)
  ON CONFLICT (school_id, kind) DO UPDATE
    SET name = EXCLUDED.name, active = EXCLUDED.active, starts_on = EXCLUDED.starts_on,
        ends_on = EXCLUDED.ends_on, tiers = EXCLUDED.tiers, max_pending = EXCLUDED.max_pending,
        require_referrer_current = EXCLUDED.require_referrer_current
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_school_discount_campaign(uuid, text, boolean, jsonb, date, date, int, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_school_discount_campaign(uuid, text, boolean, jsonb, date, date, int, boolean, uuid) TO authenticated, service_role;

-- ─── 5. RPC: registrar un referido (captura) ─────────────────────────────────
-- Devuelve {ok:true, referral:{...}} o {ok:false, califica:false, motivo, edad} si la edad
-- queda fuera de los tramos (menor de 4 → no califica; no se crea renglón).
-- Errores (RAISE): REF_CAMPANA_INACTIVA, REF_FUERA_DE_VIGENCIA, REF_INSCRIPCION_NO_ENCONTRADA,
-- REF_SIN_REFERENTE, REF_NO_ES_NUEVO, REF_SIN_FECHA_NACIMIENTO, REF_AUTOREFERIDO,
-- REF_MISMA_FAMILIA, REF_REFERENTE_*; 23505 si el referido ya tiene renglón; 42501 sin alcance.
CREATE OR REPLACE FUNCTION public.register_enrollment_referral(
  p_school_id uuid,
  p_referred_enrollment_id uuid,
  p_referrer_enrollment_id uuid DEFAULT NULL,
  p_referrer_profile_id uuid DEFAULT NULL,
  p_referrer_name_text text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_camp     public.school_discount_campaigns%ROWTYPE;
  v_enr      record;
  v_today    date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_ref_date date;
  v_age      int;
  v_pct      numeric;
  v_ref_enr  uuid := p_referrer_enrollment_id;
  v_name     text := NULLIF(left(btrim(COALESCE(p_referrer_name_text, '')), 120), '');
  v_status   text;
  v_row      public.enrollment_referrals;
BEGIN
  v_actor := public._referral_assert_scope(p_school_id, p_actor, true);
  PERFORM pg_advisory_xact_lock(hashtextextended('referidos:' || p_school_id::text, 0));

  SELECT * INTO v_camp FROM public.school_discount_campaigns
   WHERE school_id = p_school_id AND kind = 'referral';
  IF NOT FOUND OR NOT v_camp.active THEN
    RAISE EXCEPTION 'REF_CAMPANA_INACTIVA' USING ERRCODE = 'P0001';
  END IF;
  IF (v_camp.starts_on IS NOT NULL AND v_today < v_camp.starts_on)
     OR (v_camp.ends_on IS NOT NULL AND v_today > v_camp.ends_on) THEN
    RAISE EXCEPTION 'REF_FUERA_DE_VIGENCIA' USING ERRCODE = 'P0001';
  END IF;

  IF v_ref_enr IS NULL AND p_referrer_profile_id IS NULL AND v_name IS NULL THEN
    RAISE EXCEPTION 'REF_SIN_REFERENTE' USING ERRCODE = '22023';
  END IF;

  SELECT e.id, e.school_id, e.start_date, e.created_at, e.child_id, e.user_id, e.unregistered_athlete_id,
         COALESCE(c.date_of_birth, pr.date_of_birth, ua.date_of_birth) AS dob
    INTO v_enr
    FROM public.enrollments e
    LEFT JOIN public.children c              ON c.id = e.child_id
    LEFT JOIN public.profiles pr             ON pr.id = e.user_id
    LEFT JOIN public.unregistered_athletes ua ON ua.id = e.unregistered_athlete_id
   WHERE e.id = p_referred_enrollment_id;
  IF NOT FOUND OR v_enr.school_id IS DISTINCT FROM p_school_id THEN
    RAISE EXCEPTION 'REF_INSCRIPCION_NO_ENCONTRADA' USING ERRCODE = 'P0002';
  END IF;

  -- El referido debe ser NUEVO: sin otra inscripción en la escuela en los últimos 12 meses.
  v_ref_date := COALESCE(v_enr.start_date, v_enr.created_at::date);
  IF EXISTS (
    SELECT 1 FROM public.enrollments e2
    WHERE e2.school_id = p_school_id AND e2.id <> v_enr.id
      AND COALESCE(e2.child_id, e2.user_id, e2.unregistered_athlete_id)
          = COALESCE(v_enr.child_id, v_enr.user_id, v_enr.unregistered_athlete_id)
      AND e2.created_at < v_enr.created_at
      AND COALESCE(e2.end_date, v_ref_date) >= (v_ref_date - interval '12 months')::date
  ) THEN
    RAISE EXCEPTION 'REF_NO_ES_NUEVO' USING ERRCODE = 'P0001';
  END IF;

  IF v_enr.dob IS NULL THEN
    RAISE EXCEPTION 'REF_SIN_FECHA_NACIMIENTO' USING ERRCODE = 'P0001';
  END IF;
  v_age := GREATEST(date_part('year', age(v_ref_date, v_enr.dob))::int, 0);
  v_pct := public._referral_pct_for_age(v_camp.tiers, v_age);
  IF v_pct IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'califica', false, 'motivo', 'edad_fuera_de_tramos', 'edad', v_age);
  END IF;

  IF v_ref_enr IS NULL AND p_referrer_profile_id IS NOT NULL THEN
    v_ref_enr := public._referral_resolve_referrer_enrollment(p_school_id, p_referrer_profile_id);
  END IF;
  PERFORM public._referral_check_pair(p_school_id, v_enr.id, v_ref_enr, p_referrer_profile_id);
  v_status := CASE WHEN v_ref_enr IS NOT NULL THEN 'pendiente' ELSE 'sin_confirmar' END;

  INSERT INTO public.enrollment_referrals
    (school_id, campaign_id, referred_enrollment_id, referrer_enrollment_id, referrer_profile_id,
     referrer_name_text, referred_age_at_enrollment, pct, status, created_by)
  VALUES
    (p_school_id, v_camp.id, v_enr.id, v_ref_enr, p_referrer_profile_id,
     v_name, v_age, v_pct, v_status, v_actor)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'referral', to_jsonb(v_row));
END;
$$;
REVOKE ALL ON FUNCTION public.register_enrollment_referral(uuid, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_enrollment_referral(uuid, uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

-- ─── 6. RPC: vincular / cambiar inscripción / anular ─────────────────────────
-- p_action:
--   'vincular'            confirma el referente de un renglón sin_confirmar/pendiente (perfil y/o inscripción).
--   'cambiar_inscripcion' cambia la inscripción donde se aplica (D4) mientras no esté aplicado.
--   'anular'              anula el renglón (no aplica si ya está 'aplicado').
CREATE OR REPLACE FUNCTION public.update_enrollment_referral(
  p_referral_id uuid,
  p_action text,
  p_referrer_enrollment_id uuid DEFAULT NULL,
  p_referrer_profile_id uuid DEFAULT NULL,
  p_referrer_name_text text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school  uuid;
  v_actor   uuid;
  v_row     public.enrollment_referrals;
  v_ref_enr uuid;
  v_prof    uuid;
BEGIN
  SELECT school_id INTO v_school FROM public.enrollment_referrals WHERE id = p_referral_id;
  IF v_school IS NULL THEN
    RAISE EXCEPTION 'REF_NO_ENCONTRADO' USING ERRCODE = 'P0002';
  END IF;
  v_actor := public._referral_assert_scope(v_school, p_actor, true);
  IF p_action NOT IN ('vincular', 'cambiar_inscripcion', 'anular') THEN
    RAISE EXCEPTION 'REF_ACCION_INVALIDA' USING ERRCODE = '22023';
  END IF;

  -- Mismo lock que open_month: una anulación no se cruza con un cierre de mes.
  PERFORM pg_advisory_xact_lock(hashtextextended('referidos:' || v_school::text, 0));
  SELECT * INTO v_row FROM public.enrollment_referrals WHERE id = p_referral_id FOR UPDATE;

  IF v_row.status IN ('aplicado', 'anulado', 'vencido') THEN
    RAISE EXCEPTION 'REF_ESTADO_FINAL' USING ERRCODE = 'P0001';
  END IF;

  IF p_action = 'anular' THEN
    UPDATE public.enrollment_referrals
       SET status = 'anulado', status_reason = left(NULLIF(btrim(COALESCE(p_reason, '')), ''), 200)
     WHERE id = p_referral_id RETURNING * INTO v_row;
    RETURN jsonb_build_object('ok', true, 'referral', to_jsonb(v_row));
  END IF;

  IF p_action = 'vincular' AND v_row.status NOT IN ('sin_confirmar', 'pendiente') THEN
    RAISE EXCEPTION 'REF_ESTADO_FINAL' USING ERRCODE = 'P0001';
  END IF;

  v_prof    := COALESCE(p_referrer_profile_id, v_row.referrer_profile_id);
  v_ref_enr := p_referrer_enrollment_id;
  IF v_ref_enr IS NULL AND v_prof IS NOT NULL THEN
    v_ref_enr := public._referral_resolve_referrer_enrollment(v_school, v_prof);
  END IF;
  IF v_ref_enr IS NULL THEN
    RAISE EXCEPTION 'REF_REFERENTE_NO_ENCONTRADO' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public._referral_check_pair(v_school, v_row.referred_enrollment_id, v_ref_enr, v_prof);

  UPDATE public.enrollment_referrals
     SET referrer_enrollment_id = v_ref_enr,
         referrer_profile_id    = v_prof,
         referrer_name_text     = COALESCE(NULLIF(left(btrim(COALESCE(p_referrer_name_text, '')), 120), ''), referrer_name_text),
         status                 = CASE WHEN status = 'sin_confirmar' THEN 'pendiente' ELSE status END
   WHERE id = p_referral_id
   RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'referral', to_jsonb(v_row));
END;
$$;
REVOKE ALL ON FUNCTION public.update_enrollment_referral(uuid, text, uuid, uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_enrollment_referral(uuid, text, uuid, uuid, text, text, uuid) TO authenticated, service_role;

-- ─── 7. RPC (lote): pendiente → ganado cuando el referido pagó su PRIMERA mensualidad ─
-- Lee todo en lote (joins / ANY) y escribe con UN update ... FROM unnest. Sin consulta por fila.
-- apply = mes siguiente al pago o el primer mes libre del referente (cola), nunca dos el mismo mes.
-- Además: anula pendientes de referidos retirados sin pagar, y vence ganados que llevan más de
-- max_pending meses sin poder aplicarse. Devuelve el detalle para que la BFF avise a quien refiere.
CREATE OR REPLACE FUNCTION public.qualify_enrollment_referrals(
  p_school_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor    uuid;
  v_camp     public.school_discount_campaigns%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_now_idx  int;
  v_used     jsonb := '{}'::jsonb;
  v_ids      uuid[] := '{}';
  v_ys       int[]  := '{}';
  v_ms       int[]  := '{}';
  v_anulados int := 0;
  v_vencidos int := 0;
  v_ganados  int := 0;
  v_detalle  jsonb := '[]'::jsonb;
  c          record;
  v_key      text;
  v_arr      int[];
  v_idx      int;
BEGIN
  v_actor := public._referral_assert_scope(p_school_id, p_actor, true);
  PERFORM pg_advisory_xact_lock(hashtextextended('referidos:' || p_school_id::text, 0));

  SELECT * INTO v_camp FROM public.school_discount_campaigns
   WHERE school_id = p_school_id AND kind = 'referral';
  IF NOT FOUND OR NOT v_camp.active THEN
    RETURN jsonb_build_object('ok', true, 'campana_activa', false,
                              'ganados', 0, 'anulados', 0, 'vencidos', 0, 'detalle', '[]'::jsonb);
  END IF;
  v_now_idx := extract(year FROM v_today)::int * 12 + extract(month FROM v_today)::int - 1;

  -- 1) Anular: referido retirado antes de pagar su primera mensualidad.
  WITH upd AS (
    UPDATE public.enrollment_referrals r
       SET status = 'anulado', status_reason = 'referido_retirado_antes_de_pagar'
      FROM public.enrollments ed
     WHERE r.school_id = p_school_id
       AND r.status IN ('sin_confirmar', 'pendiente')
       AND ed.id = r.referred_enrollment_id
       AND ed.status <> 'active'
       AND NOT EXISTS (
         SELECT 1 FROM public.payments p
         WHERE p.school_id = r.school_id AND p.status = 'paid' AND p.amount > 0
           AND COALESCE(p.payment_category, 'mensualidad') = 'mensualidad'
           AND ((ed.child_id IS NOT NULL AND p.child_id = ed.child_id)
             OR (ed.child_id IS NULL AND ed.user_id IS NOT NULL AND p.user_id = ed.user_id)
             OR (ed.unregistered_athlete_id IS NOT NULL AND p.unregistered_athlete_id = ed.unregistered_athlete_id))
       )
    RETURNING 1)
  SELECT count(*) INTO v_anulados FROM upd;

  -- 2) Vencer: ganado que lleva más de max_pending meses esperando.
  WITH upd AS (
    UPDATE public.enrollment_referrals r
       SET status = 'vencido', status_reason = 'sin_aplicar_en_el_plazo'
     WHERE r.school_id = p_school_id AND r.status = 'ganado'
       AND (r.apply_year * 12 + r.apply_month - 1) + v_camp.max_pending < v_now_idx
    RETURNING 1)
  SELECT count(*) INTO v_vencidos FROM upd;

  -- 3) Meses ya ocupados por referente (ganado/aplicado), en una sola lectura.
  SELECT COALESCE(jsonb_object_agg(s.k, s.meses), '{}'::jsonb) INTO v_used
  FROM (
    SELECT COALESCE(er.child_id, er.user_id, er.unregistered_athlete_id)::text AS k,
           to_jsonb(array_agg(r.apply_year * 12 + r.apply_month - 1)) AS meses
    FROM public.enrollment_referrals r
    JOIN public.enrollments er ON er.id = r.referrer_enrollment_id
    WHERE r.school_id = p_school_id AND r.status IN ('ganado', 'aplicado')
    GROUP BY 1
  ) s;

  -- 4) Candidatos en lote: pendiente con referente confirmado y primera mensualidad pagada.
  FOR c IN
    SELECT r.id,
           COALESCE(er.child_id, er.user_id, er.unregistered_athlete_id)::text AS k,
           (extract(year FROM (fp.paid_at AT TIME ZONE 'America/Bogota'))::int * 12
            + extract(month FROM (fp.paid_at AT TIME ZONE 'America/Bogota'))::int - 1) AS pay_idx
    FROM public.enrollment_referrals r
    JOIN public.enrollments ed ON ed.id = r.referred_enrollment_id
    JOIN public.enrollments er ON er.id = r.referrer_enrollment_id
    CROSS JOIN LATERAL (
      SELECT min(COALESCE(p.approved_at, p.updated_at)) AS paid_at
      FROM public.payments p
      WHERE p.school_id = r.school_id AND p.status = 'paid' AND p.amount > 0
        AND COALESCE(p.payment_category, 'mensualidad') = 'mensualidad'
        AND ((ed.child_id IS NOT NULL AND p.child_id = ed.child_id)
          OR (ed.child_id IS NULL AND ed.user_id IS NOT NULL AND p.user_id = ed.user_id)
          OR (ed.unregistered_athlete_id IS NOT NULL AND p.unregistered_athlete_id = ed.unregistered_athlete_id))
    ) fp
    WHERE r.school_id = p_school_id
      AND r.status = 'pendiente'
      AND r.referrer_enrollment_id IS NOT NULL
      AND fp.paid_at IS NOT NULL
    ORDER BY fp.paid_at, r.id
  LOOP
    v_key := c.k;
    v_arr := COALESCE(ARRAY(SELECT jsonb_array_elements_text(v_used -> v_key)::int), '{}');
    -- Tope: meses pendientes (de hoy en adelante) del referente.
    IF (SELECT count(*) FROM unnest(v_arr) m WHERE m >= v_now_idx) >= v_camp.max_pending THEN
      CONTINUE;
    END IF;
    v_idx := c.pay_idx + 1;                       -- mes siguiente al pago
    WHILE v_idx = ANY (v_arr) LOOP v_idx := v_idx + 1; END LOOP;   -- primer mes libre
    v_arr := v_arr || v_idx;
    v_used := jsonb_set(v_used, ARRAY[v_key], to_jsonb(v_arr), true);
    v_ids := v_ids || c.id;
    v_ys  := v_ys  || (v_idx / 12);
    v_ms  := v_ms  || ((v_idx % 12) + 1);
  END LOOP;

  -- 5) Una sola escritura para todo el lote.
  IF cardinality(v_ids) > 0 THEN
    WITH upd AS (
      UPDATE public.enrollment_referrals r
         SET status = 'ganado', qualified_at = now(),
             apply_year = u.y, apply_month = u.m
        FROM unnest(v_ids, v_ys, v_ms) AS u(id, y, m)
       WHERE r.id = u.id AND r.status = 'pendiente'
      RETURNING r.id, r.pct, r.apply_year, r.apply_month, r.referrer_profile_id,
                r.referrer_enrollment_id, r.referred_enrollment_id
    )
    SELECT count(*),
           COALESCE(jsonb_agg(jsonb_build_object(
             'referral_id', upd.id,
             'pct', upd.pct,
             'apply_year', upd.apply_year,
             'apply_month', upd.apply_month,
             'referrer_user_id', COALESCE(upd.referrer_profile_id, er.user_id, cr.parent_id),
             'referred_name', COALESCE(cd.full_name, pd.full_name, ud.full_name))), '[]'::jsonb)
      INTO v_ganados, v_detalle
      FROM upd
      JOIN public.enrollments er ON er.id = upd.referrer_enrollment_id
      LEFT JOIN public.children cr ON cr.id = er.child_id
      JOIN public.enrollments ed ON ed.id = upd.referred_enrollment_id
      LEFT JOIN public.children cd ON cd.id = ed.child_id
      LEFT JOIN public.profiles pd ON pd.id = ed.user_id
      LEFT JOIN public.unregistered_athletes ud ON ud.id = ed.unregistered_athlete_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'campana_activa', true, 'ganados', v_ganados,
                            'anulados', v_anulados, 'vencidos', v_vencidos, 'detalle', v_detalle);
END;
$$;
REVOKE ALL ON FUNCTION public.qualify_enrollment_referrals(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qualify_enrollment_referrals(uuid, uuid) TO authenticated, service_role;

-- ─── 8. RPC: informe de referidos ────────────────────────────────────────────
-- p_year/p_month filtran por el mes de aplicación (NULL = todos). Totales por estado y por mes;
-- «dejado_de_cobrar» = lo que la escuela no cobró en los renglones aplicados (list = monto/(1-pct)).
CREATE OR REPLACE FUNCTION public.referrals_report(
  p_school_id uuid,
  p_year int DEFAULT NULL,
  p_month int DEFAULT NULL,
  p_actor uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_referred_enrollment_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor  uuid;
  v_rows   jsonb;
  v_totals jsonb;
  v_months jsonb;
BEGIN
  v_actor := public._referral_assert_scope(p_school_id, p_actor, false);
  IF p_month IS NOT NULL AND p_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'REF_MES_INVALIDO' USING ERRCODE = '22023';
  END IF;

  WITH base AS (
    SELECT r.id, r.status, r.status_reason, r.pct, r.referred_age_at_enrollment AS age,
           r.apply_year, r.apply_month, r.qualified_at, r.created_at,
           r.referred_enrollment_id, r.referrer_enrollment_id, r.referrer_profile_id,
           COALESCE(cd.full_name, pd.full_name, ud.full_name) AS referred_name,
           COALESCE(pr.full_name, cr.full_name, prr.full_name, ur.full_name, r.referrer_name_text) AS referrer_name,
           r.referrer_name_text,
           r.applied_payment_id,
           p.amount AS payment_amount,
           CASE WHEN r.status = 'aplicado' AND p.amount IS NOT NULL
                THEN ROUND(p.amount / (1 - r.pct / 100.0) - p.amount) END AS discount_amount
    FROM public.enrollment_referrals r
    JOIN public.enrollments ed ON ed.id = r.referred_enrollment_id
    LEFT JOIN public.children cd ON cd.id = ed.child_id
    LEFT JOIN public.profiles pd ON pd.id = ed.user_id
    LEFT JOIN public.unregistered_athletes ud ON ud.id = ed.unregistered_athlete_id
    LEFT JOIN public.enrollments er ON er.id = r.referrer_enrollment_id
    LEFT JOIN public.children cr ON cr.id = er.child_id
    LEFT JOIN public.profiles prr ON prr.id = er.user_id
    LEFT JOIN public.unregistered_athletes ur ON ur.id = er.unregistered_athlete_id
    LEFT JOIN public.profiles pr ON pr.id = r.referrer_profile_id
    LEFT JOIN public.payments p ON p.id = r.applied_payment_id
    WHERE r.school_id = p_school_id
      AND (p_year  IS NULL OR r.apply_year  = p_year)
      AND (p_month IS NULL OR r.apply_month = p_month)
      AND (p_status IS NULL OR r.status = p_status)
      AND (p_referred_enrollment_id IS NULL OR r.referred_enrollment_id = p_referred_enrollment_id)
  )
  SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.apply_year NULLS LAST, b.apply_month NULLS LAST, b.created_at) FROM base b), '[]'::jsonb),
    jsonb_build_object(
      'total', (SELECT count(*) FROM base),
      'por_estado', COALESCE((SELECT jsonb_object_agg(s.status, s.n) FROM (SELECT status, count(*) AS n FROM base GROUP BY status) s), '{}'::jsonb),
      'dejado_de_cobrar', COALESCE((SELECT sum(discount_amount) FROM base WHERE status = 'aplicado'), 0)),
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'year', m.apply_year, 'month', m.apply_month,
                'aplicados', m.aplicados, 'ganados_por_aplicar', m.ganados,
                'dejado_de_cobrar', m.dejado) ORDER BY m.apply_year, m.apply_month)
              FROM (SELECT apply_year, apply_month,
                           count(*) FILTER (WHERE status = 'aplicado') AS aplicados,
                           count(*) FILTER (WHERE status = 'ganado')   AS ganados,
                           COALESCE(sum(discount_amount) FILTER (WHERE status = 'aplicado'), 0) AS dejado
                      FROM base WHERE apply_year IS NOT NULL GROUP BY apply_year, apply_month) m), '[]'::jsonb)
  INTO v_rows, v_totals, v_months;

  RETURN jsonb_build_object('school_id', p_school_id, 'year', p_year, 'month', p_month,
                            'rows', v_rows, 'totals', v_totals, 'by_month', v_months);
END;
$$;
REVOKE ALL ON FUNCTION public.referrals_report(uuid, int, int, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.referrals_report(uuid, int, int, uuid, text, uuid) TO authenticated, service_role;

-- ─── 9. open_month: definición viva + descuento por referido ─────────────────
-- Base: pg_proc.prosrc leído el 2026-11-06 (7454 caracteres). Cambios marcados con «REFERIDOS».
CREATE OR REPLACE FUNCTION public.open_month(p_school_id uuid, p_year integer, p_month integer, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_month_start      date := make_date(p_year, p_month, 1);
  v_month_end        date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_cutoff           int;
  v_due              date;
  v_created          int := 0;
  v_caller           uuid := auth.uid();
  v_sibling_enabled  boolean;
  v_sibling_pct      numeric;
  v_grace            int;
  v_today            date := (now() AT TIME ZONE 'America/Bogota')::date;
  -- REFERIDOS
  v_ref_on           boolean := false;
  v_ref_current      boolean := true;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
    RAISE EXCEPTION 'No autorizado para abrir el mes de esta escuela.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_school_id::text || ':' || p_year::text || ':' || p_month::text, 0)
  );

  SELECT COALESCE(payment_cutoff_day, 10),
         COALESCE(payment_grace_days, 5),
         COALESCE(sibling_discount_enabled, false),
         COALESCE(sibling_discount_percentage, 0)
  INTO v_cutoff, v_grace, v_sibling_enabled, v_sibling_pct
  FROM public.school_settings WHERE school_id = p_school_id;
  v_cutoff := COALESCE(v_cutoff, 10);
  v_grace  := COALESCE(v_grace, 5);

  -- REFERIDOS: ¿campaña activa? Solo entonces se toma el lock por escuela (compartido con
  -- update/qualify) y el lateral `rf` puede devolver filas. Apagada = comportamiento de hoy.
  SELECT true, c.require_referrer_current
    INTO v_ref_on, v_ref_current
    FROM public.school_discount_campaigns c
   WHERE c.school_id = p_school_id AND c.kind = 'referral' AND c.active;
  v_ref_on      := COALESCE(v_ref_on, false);
  v_ref_current := COALESCE(v_ref_current, true);
  IF v_ref_on THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('referidos:' || p_school_id::text, 0));
  END IF;

  v_due := make_date(
    p_year, p_month,
    LEAST(v_cutoff, extract(day from (v_month_end - 1))::int)
  );
  -- FIX 2026-10-05 (H-01): un cobro NUEVO nunca nace vencido. Si el corte del
  -- mes ya pasó (el cron abre el mes en curso todos los días, y una escuela que
  -- pone precio el 8 con corte el 1 recibía cobros vencidos esa misma noche), el
  -- vencimiento pasa a hoy + días de gracia: la MISMA regla que billingDue
  -- (bff/src/services/enrollmentBilling.ts) y qr_first_charge_due_date. El
  -- PERIODO no cambia: sigue siendo p_year/p_month.
  IF v_due < v_today THEN
    v_due := v_today + v_grace;
  END IF;

  -- 20261014212627 (S2): sede = la del EQUIPO de la inscripción; si no hay,
  -- la de la ficha (children.branch_id / unregistered_athletes.branch_id).
  WITH elegibles AS (
    SELECT DISTINCT ON (COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id))
      e.school_id,
      COALESCE(t.branch_id, c.branch_id, ua.branch_id)                             AS branch_id,
      c.parent_id,
      e.child_id,
      e.user_id,
      e.unregistered_athlete_id,
      e.team_id,
      e.offering_plan_id,
      COALESCE(c.full_name, pr.full_name, ua.full_name, 'Atleta')    AS athlete_name,
      fee.amount                                                     AS amount,
      fee.sibling_discount_applied                                   AS sibling_discount_applied,
      rf.referral_id                                                 AS referral_id,  -- REFERIDOS
      fee.referral_note                                              AS referral_note -- REFERIDOS
    FROM public.enrollments e
    LEFT JOIN public.children               c  ON c.id  = e.child_id
    LEFT JOIN public.profiles               pr ON pr.id = e.user_id
    LEFT JOIN public.unregistered_athletes  ua ON ua.id = e.unregistered_athlete_id
    LEFT JOIN public.teams                  t  ON t.id  = e.team_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               NULLIF(e.monthly_fee, 0),
               NULLIF((SELECT op.price FROM public.offering_plans op WHERE op.id = e.offering_plan_id), 0),
               NULLIF(t.price_monthly, 0),
               NULLIF(c.monthly_fee, 0),
               0
             ) AS base_amount
    ) base
    -- REFERIDOS: descuento ganado que toca este cierre (o uno anterior que quedó esperando).
    LEFT JOIN LATERAL (
      SELECT r.id AS referral_id, r.pct AS pct,
             left(COALESCE(cd.full_name, pd.full_name, ud.full_name, 'otro deportista'), 80) AS referred_name
      FROM public.enrollment_referrals r
      JOIN public.enrollments er ON er.id = r.referrer_enrollment_id
      JOIN public.enrollments ed ON ed.id = r.referred_enrollment_id
      LEFT JOIN public.children               cd ON cd.id = ed.child_id
      LEFT JOIN public.profiles               pd ON pd.id = ed.user_id
      LEFT JOIN public.unregistered_athletes  ud ON ud.id = ed.unregistered_athlete_id
      WHERE v_ref_on
        AND NOT e.fee_is_manual
        AND r.school_id = e.school_id
        AND r.status = 'ganado'
        AND (r.apply_year * 12 + r.apply_month) <= (p_year * 12 + p_month)
        AND er.status = 'active'
        AND COALESCE(er.child_id, er.user_id, er.unregistered_athlete_id)
            = COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id)
        AND (NOT v_ref_current OR NOT EXISTS (
              SELECT 1 FROM public.payments pc
              WHERE pc.school_id = e.school_id
                AND pc.status IN ('pending','overdue','partial')
                AND COALESCE(pc.payment_category, 'mensualidad') = 'mensualidad'
                AND pc.due_date < v_month_start
                AND (
                      (e.child_id IS NOT NULL AND pc.child_id = e.child_id)
                   OR (e.child_id IS NULL AND e.user_id IS NOT NULL
                         AND (pc.user_id = e.user_id OR pc.parent_id = e.user_id))
                   OR (e.unregistered_athlete_id IS NOT NULL
                         AND pc.unregistered_athlete_id = e.unregistered_athlete_id)
                   OR (r.referrer_profile_id IS NOT NULL AND pc.parent_id = r.referrer_profile_id)
                )
            ))
      ORDER BY r.apply_year, r.apply_month, r.qualified_at, r.id
      LIMIT 1
    ) rf ON true
    CROSS JOIN LATERAL (
      -- F2 hermanos escalonado (20261013192955): % del escalón según el
      -- rango del niño en su familia ACTIVA (mismo parent_id o vínculo de
      -- school_sibling_links; ya no exige c.parent_id). Un niño con varias
      -- inscripciones cuenta una vez; fee_is_manual no recibe pero cuenta.
      -- REFERIDOS: el descuento por referido reemplaza al de hermanos ese mes (D8).
      SELECT CASE
               WHEN v_sibling_enabled AND e.child_id IS NOT NULL AND NOT e.fee_is_manual
                    AND rf.referral_id IS NULL
               THEN public._sibling_tier_pct(e.school_id, public._sibling_rank(e.school_id, e.child_id))
               ELSE 0
             END AS pct
    ) sib
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN e.fee_is_manual THEN COALESCE(e.monthly_fee, 0)
             WHEN rf.referral_id IS NOT NULL THEN ROUND(base.base_amount * (1 - rf.pct / 100.0))
             ELSE ROUND(base.base_amount * (1 - sib.pct / 100.0))
        END AS amount,
        CASE WHEN NOT e.fee_is_manual AND sib.pct > 0
             THEN ROUND(base.base_amount * sib.pct / 100.0)
        END AS sibling_discount_applied,
        CASE WHEN rf.referral_id IS NOT NULL
             THEN 'Descuento '
                  || CASE WHEN rf.pct = trunc(rf.pct) THEN trunc(rf.pct)::text ELSE rf.pct::text END
                  || ' % por referido: ' || rf.referred_name
        END AS referral_note
    ) fee
    WHERE e.school_id = p_school_id
      AND e.status = 'active'
      AND COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id) IS NOT NULL
      AND fee.amount > 0
      AND (p_branch_id IS NULL OR COALESCE(t.branch_id, c.branch_id, ua.branch_id) = p_branch_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.enrollment_pause_requests r
        WHERE r.enrollment_id = e.id
          AND r.status = 'approved'
          AND v_month_start BETWEEN r.month_from AND r.month_to
          AND (
            r.resumed_at IS NULL
            OR date_trunc('month', (r.resumed_at AT TIME ZONE 'America/Bogota')::date)::date
                 >= v_month_start
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p2
        WHERE p2.school_id = e.school_id
          AND p2.status IN ('pending','awaiting_approval','paid','partial','overdue','glosado')
          -- 20261005221734: inscripción / seguro / excedente no son la
          -- mensualidad del período aunque traigan period_year/period_month.
          -- 20261007095911: tampoco artículos, torneo, clase extra, vacacional
          -- ni viaje (cobros sueltos de servicio, ventas por WhatsApp).
          AND COALESCE(p2.payment_category, '') NOT IN (
                'inscripcion', 'seguro', 'excedente',
                'articulos', 'torneo', 'clase_extra', 'vacacional', 'viaje', 'clase_prueba', 'reserva')
          AND (
                (e.child_id IS NOT NULL AND p2.child_id = e.child_id)
             OR (e.child_id IS NULL AND e.user_id IS NOT NULL
                   AND (p2.user_id = e.user_id OR p2.parent_id = e.user_id))
             OR (e.unregistered_athlete_id IS NOT NULL
                   AND p2.unregistered_athlete_id = e.unregistered_athlete_id)
          )
          AND (
                (p2.period_year = p_year AND p2.period_month = p_month)
             OR (p2.period_year IS NULL
                   AND p2.due_date >= v_month_start AND p2.due_date < v_month_end)
          )
      )
    ORDER BY COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id),
             (e.offering_plan_id IS NOT NULL) DESC,
             (e.team_id IS NOT NULL)          DESC,
             e.created_at ASC
  ),
  ins AS (
    INSERT INTO public.payments (
      school_id, branch_id, parent_id, child_id, user_id, unregistered_athlete_id,
      team_id, offering_plan_id, concept, amount, due_date, status, payment_type,
      period_year, period_month, payment_category, sibling_discount_applied, notes
    )
    SELECT
      el.school_id, el.branch_id, el.parent_id, el.child_id, el.user_id,
      el.unregistered_athlete_id, el.team_id, el.offering_plan_id,
      'Mensualidad ' || to_char(v_due, 'MM/YYYY') || ' - ' || el.athlete_name,
      el.amount, v_due, 'pending', 'subscription',
      p_year::smallint, p_month::smallint, 'mensualidad', el.sibling_discount_applied,
      el.referral_note
    FROM elegibles el
    ON CONFLICT DO NOTHING
    RETURNING id, child_id, user_id, unregistered_athlete_id
  ),
  -- REFERIDOS: marcar 'aplicado' en la MISMA sentencia que crea el cobro. Un cobro que
  -- chocó (ON CONFLICT) no devuelve fila en `ins`, así que su renglón sigue 'ganado'.
  aplicados AS (
    UPDATE public.enrollment_referrals rr
       SET status = 'aplicado', applied_payment_id = ins.id
      FROM ins
      JOIN elegibles el
        ON COALESCE(el.child_id, el.user_id, el.unregistered_athlete_id)
         = COALESCE(ins.child_id, ins.user_id, ins.unregistered_athlete_id)
     WHERE rr.id = el.referral_id
       AND rr.status = 'ganado'
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM ins;

  RETURN jsonb_build_object(
    'school_id', p_school_id, 'year', p_year, 'month', p_month,
    'due_date',  v_due, 'generados', v_created
  );
END;
$function$;

-- ─── 10. preview_open_month: definición viva + descuento por referido ────────
-- Base: pg_proc.prosrc leído el 2026-11-06 (6311 caracteres). Lo previsualizado es lo que se emite.
CREATE OR REPLACE FUNCTION public.preview_open_month(p_school_id uuid, p_year integer, p_month integer, p_branch_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_month_start      date := make_date(p_year, p_month, 1);
  v_month_end        date := (make_date(p_year, p_month, 1) + interval '1 month')::date;
  v_cutoff           int;
  v_due              date;
  v_items            jsonb;
  v_caller           uuid := auth.uid();
  v_sibling_enabled  boolean;
  v_sibling_pct      numeric;
  v_grace            int;
  v_today            date := (now() AT TIME ZONE 'America/Bogota')::date;
  -- REFERIDOS
  v_ref_on           boolean := false;
  v_ref_current      boolean := true;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
    RAISE EXCEPTION 'No autorizado.';
  END IF;

  SELECT COALESCE(payment_cutoff_day, 10),
         COALESCE(payment_grace_days, 5),
         COALESCE(sibling_discount_enabled, false),
         COALESCE(sibling_discount_percentage, 0)
  INTO v_cutoff, v_grace, v_sibling_enabled, v_sibling_pct
  FROM public.school_settings WHERE school_id = p_school_id;
  v_cutoff := COALESCE(v_cutoff, 10);
  v_grace  := COALESCE(v_grace, 5);

  -- REFERIDOS (solo lectura: sin lock)
  SELECT true, c.require_referrer_current
    INTO v_ref_on, v_ref_current
    FROM public.school_discount_campaigns c
   WHERE c.school_id = p_school_id AND c.kind = 'referral' AND c.active;
  v_ref_on      := COALESCE(v_ref_on, false);
  v_ref_current := COALESCE(v_ref_current, true);

  v_due := make_date(p_year, p_month, LEAST(v_cutoff, extract(day from (v_month_end - 1))::int));
  -- Mismo piso que open_month (FIX 2026-10-05, H-01): lo que se previsualiza es
  -- lo que se emite.
  IF v_due < v_today THEN
    v_due := v_today + v_grace;
  END IF;

  -- 20261014212627 (S2): mismo filtro de sede que open_month.
  WITH elegibles AS (
    SELECT DISTINCT ON (COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id))
      COALESCE(c.full_name, pr.full_name, ua.full_name, 'Atleta') AS athlete_name,
      CASE WHEN e.child_id IS NOT NULL THEN 'menor'
           WHEN e.user_id  IS NOT NULL THEN 'adulto'
           ELSE 'no_registrado' END                                AS tipo,
      fee.amount                                                   AS amount,
      fee.sibling_discount_applied                                 AS sibling_discount_applied,
      rf.pct                                                       AS referral_pct,   -- REFERIDOS
      fee.referral_note                                            AS referral_note   -- REFERIDOS
    FROM public.enrollments e
    LEFT JOIN public.children               c  ON c.id  = e.child_id
    LEFT JOIN public.profiles               pr ON pr.id = e.user_id
    LEFT JOIN public.unregistered_athletes  ua ON ua.id = e.unregistered_athlete_id
    LEFT JOIN public.teams                  t  ON t.id  = e.team_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
               NULLIF(e.monthly_fee, 0),
               NULLIF((SELECT op.price FROM public.offering_plans op WHERE op.id = e.offering_plan_id), 0),
               NULLIF(t.price_monthly, 0),
               NULLIF(c.monthly_fee, 0),
               0
             ) AS base_amount
    ) base
    -- REFERIDOS: idéntico al lateral de open_month.
    LEFT JOIN LATERAL (
      SELECT r.id AS referral_id, r.pct AS pct,
             left(COALESCE(cd.full_name, pd.full_name, ud.full_name, 'otro deportista'), 80) AS referred_name
      FROM public.enrollment_referrals r
      JOIN public.enrollments er ON er.id = r.referrer_enrollment_id
      JOIN public.enrollments ed ON ed.id = r.referred_enrollment_id
      LEFT JOIN public.children               cd ON cd.id = ed.child_id
      LEFT JOIN public.profiles               pd ON pd.id = ed.user_id
      LEFT JOIN public.unregistered_athletes  ud ON ud.id = ed.unregistered_athlete_id
      WHERE v_ref_on
        AND NOT e.fee_is_manual
        AND r.school_id = e.school_id
        AND r.status = 'ganado'
        AND (r.apply_year * 12 + r.apply_month) <= (p_year * 12 + p_month)
        AND er.status = 'active'
        AND COALESCE(er.child_id, er.user_id, er.unregistered_athlete_id)
            = COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id)
        AND (NOT v_ref_current OR NOT EXISTS (
              SELECT 1 FROM public.payments pc
              WHERE pc.school_id = e.school_id
                AND pc.status IN ('pending','overdue','partial')
                AND COALESCE(pc.payment_category, 'mensualidad') = 'mensualidad'
                AND pc.due_date < v_month_start
                AND (
                      (e.child_id IS NOT NULL AND pc.child_id = e.child_id)
                   OR (e.child_id IS NULL AND e.user_id IS NOT NULL
                         AND (pc.user_id = e.user_id OR pc.parent_id = e.user_id))
                   OR (e.unregistered_athlete_id IS NOT NULL
                         AND pc.unregistered_athlete_id = e.unregistered_athlete_id)
                   OR (r.referrer_profile_id IS NOT NULL AND pc.parent_id = r.referrer_profile_id)
                )
            ))
      ORDER BY r.apply_year, r.apply_month, r.qualified_at, r.id
      LIMIT 1
    ) rf ON true
    CROSS JOIN LATERAL (
      -- F2 hermanos escalonado (20261013192955): % del escalón según el
      -- rango del niño en su familia ACTIVA (mismo parent_id o vínculo de
      -- school_sibling_links; ya no exige c.parent_id). Un niño con varias
      -- inscripciones cuenta una vez; fee_is_manual no recibe pero cuenta.
      -- REFERIDOS: el descuento por referido reemplaza al de hermanos ese mes (D8).
      SELECT CASE
               WHEN v_sibling_enabled AND e.child_id IS NOT NULL AND NOT e.fee_is_manual
                    AND rf.referral_id IS NULL
               THEN public._sibling_tier_pct(e.school_id, public._sibling_rank(e.school_id, e.child_id))
               ELSE 0
             END AS pct
    ) sib
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN e.fee_is_manual THEN COALESCE(e.monthly_fee, 0)
             WHEN rf.referral_id IS NOT NULL THEN ROUND(base.base_amount * (1 - rf.pct / 100.0))
             ELSE ROUND(base.base_amount * (1 - sib.pct / 100.0))
        END AS amount,
        CASE WHEN NOT e.fee_is_manual AND sib.pct > 0
             THEN ROUND(base.base_amount * sib.pct / 100.0)
        END AS sibling_discount_applied,
        CASE WHEN rf.referral_id IS NOT NULL
             THEN 'Descuento '
                  || CASE WHEN rf.pct = trunc(rf.pct) THEN trunc(rf.pct)::text ELSE rf.pct::text END
                  || ' % por referido: ' || rf.referred_name
        END AS referral_note
    ) fee
    WHERE e.school_id = p_school_id
      AND e.status = 'active'
      AND COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id) IS NOT NULL
      AND fee.amount > 0
      AND (p_branch_id IS NULL OR COALESCE(t.branch_id, c.branch_id, ua.branch_id) = p_branch_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.enrollment_pause_requests r
        WHERE r.enrollment_id = e.id
          AND r.status = 'approved'
          AND v_month_start BETWEEN r.month_from AND r.month_to
          AND (
            r.resumed_at IS NULL
            OR date_trunc('month', (r.resumed_at AT TIME ZONE 'America/Bogota')::date)::date
                 >= v_month_start
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.payments p2
        WHERE p2.school_id = e.school_id
          AND p2.status IN ('pending','awaiting_approval','paid','partial','overdue','glosado')
          -- 20261005221734: inscripción / seguro / excedente no son la
          -- mensualidad del período aunque traigan period_year/period_month.
          -- F2 hermanos escalonado (20261013192955): misma lista que open_month
          -- (20261007095911) para que lo previsualizado sea lo que se emite.
          AND COALESCE(p2.payment_category, '') NOT IN (
                'inscripcion', 'seguro', 'excedente',
                'articulos', 'torneo', 'clase_extra', 'vacacional', 'viaje', 'clase_prueba', 'reserva')
          AND (
                (e.child_id IS NOT NULL AND p2.child_id = e.child_id)
             OR (e.child_id IS NULL AND e.user_id IS NOT NULL
                   AND (p2.user_id = e.user_id OR p2.parent_id = e.user_id))
             OR (e.unregistered_athlete_id IS NOT NULL
                   AND p2.unregistered_athlete_id = e.unregistered_athlete_id)
          )
          AND (
                (p2.period_year = p_year AND p2.period_month = p_month)
             OR (p2.period_year IS NULL AND p2.due_date >= v_month_start AND p2.due_date < v_month_end)
          )
      )
    ORDER BY COALESCE(e.child_id, e.user_id, e.unregistered_athlete_id),
             (e.offering_plan_id IS NOT NULL) DESC,
             (e.team_id IS NOT NULL)          DESC,
             e.created_at ASC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'athlete',  el.athlete_name,
           'tipo',     el.tipo,
           'amount',   el.amount,
           'sibling_discount_applied', el.sibling_discount_applied,
           'referral_pct',  el.referral_pct,    -- REFERIDOS (null si no aplica)
           'referral_note', el.referral_note,   -- REFERIDOS
           'due_date', v_due
         )), '[]'::jsonb)
  INTO v_items
  FROM elegibles el;

  RETURN jsonb_build_object(
    'school_id', p_school_id, 'year', p_year, 'month', p_month,
    'due_date', v_due,
    'count', jsonb_array_length(v_items),
    'items', v_items
  );
END;
$function$;

-- CREATE OR REPLACE conserva dueño y ACL (postgres, authenticated, service_role); se reafirma
-- sin abrir nada a anon.
REVOKE ALL ON FUNCTION public.open_month(uuid, integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_month(uuid, integer, integer, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_open_month(uuid, integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_open_month(uuid, integer, integer, uuid) TO authenticated, service_role;

-- =============================================================================
-- PRUEBAS T1–T8 (manuales, en una sesión con ROLLBACK; ver _smoke/referidos_smoke.sql para
-- la versión ejecutable). Preparación: escuela de prueba con campaña
-- tiers = [{"age_min":4,"age_max":15,"pct":50},{"age_min":16,"age_max":null,"pct":25}], active = true.
--
-- T1  Referido de 10 años que paga su primera mensualidad en noviembre
--       register_enrollment_referral(...) → pct 50, status 'pendiente'
--       qualify_enrollment_referrals(escuela) → 'ganado', apply = diciembre
--       preview_open_month(escuela, 2026, 12) → ítem del referente con amount = base*0.5 y
--       referral_note «Descuento 50 % por referido: <nombre>»
-- T2  Referido de 17 años → pct 25 (misma secuencia) → amount = base*0.75
-- T3  Referido de 3 años → register devuelve {ok:false, califica:false, motivo:'edad_fuera_de_tramos'};
--       no se crea renglón (select count(*) from enrollment_referrals where referred_enrollment_id = ...) = 0
-- T4  Dos referidos que pagan el mismo mes y tienen el mismo referente
--       qualify → apply_month = diciembre y enero (meses consecutivos, nunca dos en diciembre);
--       open_month(2026,12) aplica uno solo; open_month(2027,1) aplica el otro
-- T5  Referente con beca de 100 % (fee_is_manual = true, monthly_fee = 0)
--       open_month no genera cobro (monto 0, como hoy) y el renglón sigue 'ganado' (no se consume);
--       Referente con cuota manual > 0 (fee_is_manual): tampoco se descuenta (el manual manda)
-- T6  Cierre repetido: open_month(2026,12) dos veces → el segundo devuelve generados = 0 y el
--       renglón sigue 'aplicado' con el MISMO applied_payment_id; un solo payment con notes de referido
-- T7  Referente atrasado (mensualidad pending con due_date < 2026-12-01) y require_referrer_current
--       → el cobro de diciembre sale SIN descuento y el renglón sigue 'ganado'; al ponerse al día,
--       el cierre del mes siguiente lo aplica (apply <= mes del cierre)
-- T8  Otra escuela: set local role authenticated + request.jwt.claims de un admin de la escuela B;
--       select * from enrollment_referrals where school_id = <A> → 0 filas;
--       select public.referrals_report(<A>) / register_enrollment_referral(<A>, ...) → 42501
-- Con campaña apagada: preview_open_month idéntico antes/después de esta migración (comparar
-- jsonb ítem por ítem; las claves referral_pct/referral_note salen null).
-- =============================================================================
