-- =============================================================================
-- 20261029161649_cobros_abiertos_no_asistio_y_cambio_plan.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261029110305
-- Objetivo: que el admin resuelva en UNA acción los cobros abiertos de un atleta
--   cuando cambia su plan o cuando el atleta no vino uno o más meses.
--
--   Caso que lo originó (Besser, Isabella Alfonso, 2026-10-29): no fue en
--   septiembre, volvió en octubre con un plan de menos clases. El cambio de
--   valor del 26-oct solo reescribe cobros `pending` (students.ts, rama «mismo
--   plan»): septiembre quedó atrasado por $340.000 y octubre, en revisión con un
--   comprobante de $210.000, siguió en $340.000. No había forma de anular el mes
--   desde la app: la Pausa no acepta meses pasados, exige pause_enabled y deja al
--   atleta en pausa hoy.
--
--   Spec: docs/specs/cambio-plan-y-cobros-abiertos.md
--
--   1. enrollment_pause_requests.reason admite 'no_asistio'. Un mes anulado deja
--      una fila aprobada de ese motivo: es lo que open_month / preview_open_month
--      ya consultan (enrollment_pausada_en) para no volver a emitir el mes — un
--      cobro `cancelled` por sí solo NO bloquea la regeneración.
--      resumed_at = inicio del mes ⇒ la ventana de DÍAS de la vista
--      v_enrollment_pauses_effective queda vacía: no saca a nadie del roster ni
--      pinta el badge «en pausa».
--   2. pause_validar: esas filas no gastan el tope anual de meses de pausa.
--   3. fn_notify_pause_decision: no avisa «inscripción en pausa» por ellas (el
--      aviso a la familia lo manda resolver_cobros_abiertos, uno solo).
--   4. payment_adjustments: historial de cada anulación / cambio de valor. Lo ve
--      quien puede ver el cobro (la familia incluida).
--   5. cobros_abiertos_de_inscripcion (lectura) y resolver_cobros_abiertos
--      (escritura, todo o nada). Solo admin de la escuela de la inscripción.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Motivo nuevo en las pausas
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.enrollment_pause_requests
  DROP CONSTRAINT IF EXISTS enrollment_pause_requests_reason_check;
ALTER TABLE public.enrollment_pause_requests
  ADD CONSTRAINT enrollment_pause_requests_reason_check
  CHECK (reason = ANY (ARRAY['injury'::text, 'vacation'::text, 'other'::text, 'no_asistio'::text]));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. pause_validar: 'no_asistio' no cuenta para el tope anual
--    (copia de la definición viva; único cambio: el filtro del tope)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pause_validar(
  p_enrollment_id uuid, p_month_from date, p_month_to date, p_es_admin boolean,
  p_excluir_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_e          record;
  v_cfg        record;
  v_meses      int;
  v_ya         int;
  v_mes_actual date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
BEGIN
  SELECT e.id, e.school_id, e.status, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;

  IF v_e.id IS NULL THEN
    RAISE EXCEPTION 'Inscripción no encontrada.';
  END IF;
  IF v_e.status <> 'active' THEN
    RAISE EXCEPTION 'Solo se puede pausar una inscripción activa (esta está %).', v_e.status;
  END IF;

  SELECT COALESCE(pause_enabled, false)            AS habilitada,
         COALESCE(pause_max_months_per_year, 2)    AS tope,
         COALESCE(pause_parent_can_request, true)  AS padre_puede
    INTO v_cfg
  FROM public.school_settings WHERE school_id = v_e.school_id;

  IF NOT COALESCE(v_cfg.habilitada, false) THEN
    RAISE EXCEPTION 'La pausa por vacaciones no está habilitada en esta escuela.';
  END IF;
  IF NOT p_es_admin AND NOT COALESCE(v_cfg.padre_puede, true) THEN
    RAISE EXCEPTION 'En esta escuela la pausa la aplica la administración; no se puede solicitar.';
  END IF;

  IF p_month_to < p_month_from THEN
    RAISE EXCEPTION 'El mes final no puede ser anterior al inicial.';
  END IF;
  IF extract(day from p_month_from) <> 1 OR extract(day from p_month_to) <> 1 THEN
    RAISE EXCEPTION 'Los meses deben venir como el día 1 del mes.';
  END IF;
  IF p_month_from < v_mes_actual THEN
    RAISE EXCEPTION 'No se puede pausar un mes que ya pasó.';
  END IF;

  v_meses := (extract(year from p_month_to) * 12 + extract(month from p_month_to))
           - (extract(year from p_month_from) * 12 + extract(month from p_month_from)) + 1;

  -- Solape con pausas ya aprobadas o pendientes de la misma inscripción.
  IF EXISTS (
    SELECT 1 FROM public.enrollment_pause_requests r
    WHERE r.enrollment_id = p_enrollment_id
      AND r.status IN ('approved','pending')
      AND (p_excluir_request_id IS NULL OR r.id <> p_excluir_request_id)
      AND daterange(r.month_from, (r.month_to + interval '1 month')::date, '[)')
          && daterange(p_month_from, (p_month_to + interval '1 month')::date, '[)')
  ) THEN
    RAISE EXCEPTION 'Ya hay una pausa aprobada o pendiente que se cruza con esos meses.';
  END IF;

  -- Tope por año calendario (cuenta las aprobadas del año de month_from).
  -- Los meses anulados por «no asistió» no son una pausa pedida: no gastan tope.
  IF COALESCE(v_cfg.tope, 2) > 0 THEN
    SELECT COALESCE(sum(
             (extract(year from r.month_to) * 12 + extract(month from r.month_to))
           - (extract(year from r.month_from) * 12 + extract(month from r.month_from)) + 1
           ), 0)
      INTO v_ya
    FROM public.enrollment_pause_requests r
    WHERE r.enrollment_id = p_enrollment_id
      AND r.status = 'approved'
      AND r.reason <> 'no_asistio'
      AND (p_excluir_request_id IS NULL OR r.id <> p_excluir_request_id)
      AND extract(year from r.month_from) = extract(year from p_month_from);

    IF v_ya + v_meses > v_cfg.tope THEN
      RAISE EXCEPTION 'Supera el tope de % mes(es) de pausa por año (ya usó %).', v_cfg.tope, v_ya;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'school_id',               v_e.school_id,
    'child_id',                v_e.child_id,
    'user_id',                 v_e.user_id,
    'unregistered_athlete_id', v_e.unregistered_athlete_id,
    'meses',                   v_meses
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pause_validar(uuid, date, date, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_validar(uuid, date, date, boolean, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Aviso de pausa: callar las filas 'no_asistio'
--    (copia de la definición viva; único cambio: la guarda del motivo)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_notify_pause_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user    uuid;
  v_nombre  text;
  v_school  text;
  v_meses   text;
  v_motivo  text;
  v_titulo  text;
  v_mensaje text;
  v_op      text;
BEGIN
  -- Un mes anulado por «no asistió» no es una pausa: el aviso a la familia lo
  -- manda resolver_cobros_abiertos, con el resto de cambios de sus cobros.
  IF NEW.reason = 'no_asistio' THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = 'approved' AND NEW.source = 'admin') THEN
      RETURN NULL;
    END IF;
    v_op := 'paused_by_admin';
  ELSE
    IF NOT (OLD.resumed_at IS NULL AND NEW.resumed_at IS NOT NULL) THEN
      RETURN NULL;
    END IF;
    v_op := 'resumed';
  END IF;

  IF NEW.child_id IS NOT NULL THEN
    SELECT c.parent_id, c.full_name INTO v_user, v_nombre
      FROM public.children c WHERE c.id = NEW.child_id;
  ELSIF NEW.user_id IS NOT NULL THEN
    v_user := NEW.user_id;
    SELECT p.full_name INTO v_nombre FROM public.profiles p WHERE p.id = NEW.user_id;
  END IF;
  IF v_user IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_op = 'paused_by_admin' AND NEW.requested_by = v_user)
     OR (v_op = 'resumed' AND NEW.resumed_by = v_user) THEN
    RETURN NULL;
  END IF;

  BEGIN
    SELECT btrim(name) INTO v_school FROM public.schools WHERE id = NEW.school_id;
    v_nombre := COALESCE(NULLIF(btrim(v_nombre), ''), 'el atleta');
    v_meses  := CASE
                  WHEN NEW.month_from = NEW.month_to THEN to_char(NEW.month_from, 'MM/YYYY')
                  ELSE to_char(NEW.month_from, 'MM/YYYY') || ' a ' || to_char(NEW.month_to, 'MM/YYYY')
                END;
    v_motivo := CASE NEW.reason
                  WHEN 'vacation' THEN 'vacaciones'
                  WHEN 'injury'   THEN 'lesión'
                  ELSE 'otro motivo'
                END;

    IF v_op = 'paused_by_admin' THEN
      v_titulo  := '🏖️ Inscripción en pausa: ' || v_nombre;
      v_mensaje := v_school || ' pausó la inscripción de ' || v_nombre
                   || ' por ' || v_motivo || ' durante ' || v_meses
                   || '. Esos meses no se cobran.'
                   || COALESCE(' Nota: ' || NULLIF(btrim(NEW.reason_note), ''), '');
    ELSE
      v_titulo  := '▶️ Inscripción reactivada: ' || v_nombre;
      v_mensaje := v_school || ' reactivó la inscripción de ' || v_nombre
                   || ' desde hoy. Ya vuelve a la lista de asistencia.'
                   || CASE WHEN COALESCE(NEW.days_extended, 0) > 0
                           THEN ' Se le suman ' || NEW.days_extended || ' día(s) de vigencia que no usó.'
                           ELSE '' END;
    END IF;

    INSERT INTO public.notifications (user_id, school_id, type, category, title, message, link, data)
    VALUES (v_user, NEW.school_id, 'info', 'enrollment', v_titulo, v_mensaje, '/children',
            jsonb_build_object('pause_request_id', NEW.id, 'enrollment_id', NEW.enrollment_id,
                               'op', v_op, 'month_from', NEW.month_from, 'month_to', NEW.month_to));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[pausas] aviso a la familia falló (% %): %', TG_OP, NEW.id, SQLERRM;
  END;

  RETURN NULL;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Historial de ajustes de cobro
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  payment_id     uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  enrollment_id  uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  kind           text NOT NULL
                 CONSTRAINT payment_adjustments_kind_check
                 CHECK (kind IN ('anulado_no_asistio', 'valor_cambio_plan')),
  amount_before  numeric NOT NULL,
  amount_after   numeric,
  status_before  text NOT NULL,
  motivo         text CONSTRAINT payment_adjustments_motivo_len CHECK (motivo IS NULL OR length(motivo) <= 500),
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_adjustments_payment ON public.payment_adjustments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_adjustments_school  ON public.payment_adjustments(school_id, created_at DESC);

ALTER TABLE public.payment_adjustments ENABLE ROW LEVEL SECURITY;

-- Se ve el ajuste si se ve el cobro: la RLS de payments (staff, acudiente,
-- atleta) decide. Es otra tabla, no hay auto-recursión. Escribe solo la RPC.
DROP POLICY IF EXISTS payment_adjustments_select ON public.payment_adjustments;
CREATE POLICY payment_adjustments_select ON public.payment_adjustments
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.payments p WHERE p.id = payment_adjustments.payment_id));

REVOKE ALL ON public.payment_adjustments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_adjustments TO authenticated;
GRANT ALL ON public.payment_adjustments TO service_role;

COMMENT ON TABLE public.payment_adjustments IS
  'Historial de cobros anulados por «no asistió» o con valor cambiado por cambio de plan. Lo escribe solo resolver_cobros_abiertos(); lo lee quien puede leer el cobro.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5a. Lectura: cobros abiertos de una inscripción + ayuda de asistencia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cobros_abiertos_de_inscripcion(p_enrollment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_e          record;
  v_fee        numeric;
  v_nombre     text;
  v_mes_actual date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
  v_cobros     jsonb;
  v_hay_lista  boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;

  SELECT e.*, op.price AS plan_price, t.price_monthly AS team_price
    INTO v_e
  FROM public.enrollments e
  LEFT JOIN public.offering_plans op ON op.id = e.offering_plan_id
  LEFT JOIN public.teams t          ON t.id  = e.team_id
  WHERE e.id = p_enrollment_id;

  IF v_e.id IS NULL THEN
    RAISE EXCEPTION 'Inscripción no encontrada.';
  END IF;
  IF NOT public.is_school_admin(v_e.school_id) THEN
    RAISE EXCEPTION 'Solo la administración de la escuela puede ver esto.' USING ERRCODE = '42501';
  END IF;

  -- Cuota vigente, con la misma precedencia que open_month.
  v_fee := CASE
             WHEN COALESCE(v_e.fee_is_manual, false) THEN COALESCE(v_e.monthly_fee, 0)
             ELSE COALESCE(NULLIF(v_e.monthly_fee, 0), v_e.plan_price, v_e.team_price, 0)
           END;

  v_nombre := COALESCE(
    (SELECT c.full_name  FROM public.children c              WHERE c.id  = v_e.child_id),
    (SELECT p.full_name  FROM public.profiles p              WHERE p.id  = v_e.user_id),
    (SELECT u.full_name  FROM public.unregistered_athletes u WHERE u.id  = v_e.unregistered_athlete_id),
    'Atleta');

  -- ¿La escuela registra asistencia? Sin ninguna lista en 90 días la columna
  -- de ayuda no se muestra (no es «0 asistencias», es «no se mide»).
  SELECT EXISTS (
    SELECT 1 FROM public.attendance_records ar
    WHERE ar.school_id = v_e.school_id
      AND ar.attendance_date >= (v_mes_actual - interval '90 days')::date
  ) INTO v_hay_lista;

  WITH cobros AS (
    SELECT p.*,
           make_date(p.period_year, p.period_month, 1) AS mes,
           COALESCE(p.team_id, v_e.team_id) AS equipo
    FROM public.payments p
    WHERE p.school_id = v_e.school_id
      AND p.status IN ('pending', 'overdue', 'partial', 'awaiting_approval')
      AND p.period_year IS NOT NULL AND p.period_month IS NOT NULL
      AND (p.payment_category = 'mensualidad'
           OR (p.payment_category IS NULL AND p.payment_type = 'subscription'))
      AND (
            (v_e.child_id IS NOT NULL AND p.child_id = v_e.child_id)
         OR (v_e.user_id  IS NOT NULL AND (p.user_id = v_e.user_id OR p.parent_id = v_e.user_id) AND p.child_id IS NULL)
         OR (v_e.unregistered_athlete_id IS NOT NULL AND p.unregistered_athlete_id = v_e.unregistered_athlete_id)
      )
  ),
  con_asistencia AS (
    SELECT c.*,
      -- Veces que vino ese mes.
      (SELECT count(DISTINCT ar.attendance_date) FROM public.attendance_records ar
        WHERE ar.school_id = v_e.school_id
          AND ar.attendance_date >= c.mes AND ar.attendance_date < (c.mes + interval '1 month')::date
          AND ar.status IN ('present', 'late')
          AND ( (v_e.child_id IS NOT NULL AND ar.child_id = v_e.child_id)
             OR (v_e.user_id  IS NOT NULL AND ar.user_id  = v_e.user_id)
             OR (v_e.unregistered_athlete_id IS NOT NULL AND ar.unregistered_athlete_id = v_e.unregistered_athlete_id))
      ) AS asistencias,
      -- Días con lista tomada: del equipo si lo hay; si no, del propio atleta.
      (SELECT count(DISTINCT ar.attendance_date) FROM public.attendance_records ar
        WHERE ar.school_id = v_e.school_id
          AND ar.attendance_date >= c.mes AND ar.attendance_date < (c.mes + interval '1 month')::date
          AND ( (c.equipo IS NOT NULL AND ar.team_id = c.equipo)
             OR (c.equipo IS NULL AND (
                    (v_e.child_id IS NOT NULL AND ar.child_id = v_e.child_id)
                 OR (v_e.user_id  IS NOT NULL AND ar.user_id  = v_e.user_id)
                 OR (v_e.unregistered_athlete_id IS NOT NULL AND ar.unregistered_athlete_id = v_e.unregistered_athlete_id)))))
      AS clases_con_lista
    FROM cobros c
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'payment_id',      x.id,
           'concepto',        x.concept,
           'period_year',     x.period_year,
           'period_month',    x.period_month,
           'status',          x.status,
           'amount',          x.amount,
           'amount_paid',     COALESCE(x.amount_paid, 0),
           'late_fee_amount', COALESCE(x.late_fee_amount, 0),
           'discount_pct',    x.discount_pct,
           'tiene_comprobante', x.receipt_url IS NOT NULL,
           'ocr_amount',      x.ocr_amount,
           'asistencias',     x.asistencias,
           'clases_con_lista', x.clases_con_lista,
           -- Valor nuevo sugerido: cuota vigente con el descuento del cobro, más
           -- la mora ya causada (la mora no se perdona por cambiar de plan).
           'monto_sugerido',  CASE WHEN v_fee > 0 THEN
                                round(v_fee * (1 - COALESCE(
                                  NULLIF(x.discount_pct, 0),
                                  CASE WHEN COALESCE(x.sibling_discount_applied, 0) > 0 AND x.amount > 0
                                       THEN x.sibling_discount_applied / (x.amount + x.sibling_discount_applied) * 100
                                       ELSE 0 END) / 100))
                                + COALESCE(x.late_fee_amount, 0)
                              END,
           'puede_anular',    x.status IN ('pending', 'overdue')
                              AND COALESCE(x.amount_paid, 0) = 0
                              AND x.mes <= v_mes_actual,
           'puede_cambiar_valor', true
         ) ORDER BY x.mes), '[]'::jsonb)
    INTO v_cobros
  FROM con_asistencia x;

  RETURN jsonb_build_object(
    'enrollment_id',   v_e.id,
    'school_id',       v_e.school_id,
    'atleta',          v_nombre,
    'cuota_vigente',   v_fee,
    'escuela_toma_lista', v_hay_lista,
    'cobros',          v_cobros
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cobros_abiertos_de_inscripcion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobros_abiertos_de_inscripcion(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.cobros_abiertos_de_inscripcion(uuid) IS
  'Mensualidades abiertas (pending/overdue/partial/awaiting_approval) del atleta de la inscripción, con asistencias del mes, días con lista y valor sugerido según la cuota vigente. Solo admin de la escuela.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5b. Escritura: aplicar las decisiones del admin, todo o nada
--     p_decisiones = [{ "payment_id": uuid, "accion": "anular" | "valor", "monto": numeric }]
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolver_cobros_abiertos(
  p_enrollment_id uuid,
  p_decisiones    jsonb,
  p_motivo        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_e          record;
  v_d          record;
  v_p          record;
  v_mes        date;
  v_mes_actual date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
  v_motivo     text := NULLIF(btrim(COALESCE(p_motivo, '')), '');
  v_monto      numeric;
  v_anulados   int := 0;
  v_ajustados  int := 0;
  v_lineas     text[] := ARRAY[]::text[];
  v_destino    uuid;
  v_nombre     text;
  v_school     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida.' USING ERRCODE = '42501';
  END IF;
  IF p_decisiones IS NULL OR jsonb_typeof(p_decisiones) <> 'array' OR jsonb_array_length(p_decisiones) = 0 THEN
    RAISE EXCEPTION 'No hay decisiones para aplicar.';
  END IF;
  IF v_motivo IS NOT NULL AND length(v_motivo) > 500 THEN
    RAISE EXCEPTION 'El motivo no puede pasar de 500 caracteres.';
  END IF;

  SELECT e.id, e.school_id, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;
  IF v_e.id IS NULL THEN
    RAISE EXCEPTION 'Inscripción no encontrada.';
  END IF;
  -- Anular o rebajar un cobro perdona plata: administración, nunca coach.
  IF NOT public.is_school_admin(v_e.school_id) THEN
    RAISE EXCEPTION 'Solo la administración de la escuela puede ajustar cobros.' USING ERRCODE = '42501';
  END IF;

  -- Orden fijo por payment_id: dos admins con decisiones cruzadas no se bloquean mutuamente.
  FOR v_d IN
    SELECT (d->>'payment_id')::uuid AS payment_id,
           d->>'accion'             AS accion,
           NULLIF(d->>'monto', '')::numeric AS monto
    FROM jsonb_array_elements(p_decisiones) d
    ORDER BY 1
  LOOP
    IF v_d.accion NOT IN ('anular', 'valor') THEN
      RAISE EXCEPTION 'Acción no válida: %', v_d.accion;
    END IF;

    SELECT p.* INTO v_p
    FROM public.payments p
    WHERE p.id = v_d.payment_id
      AND p.school_id = v_e.school_id
      AND p.period_year IS NOT NULL AND p.period_month IS NOT NULL
      AND (p.payment_category = 'mensualidad'
           OR (p.payment_category IS NULL AND p.payment_type = 'subscription'))
      AND (
            (v_e.child_id IS NOT NULL AND p.child_id = v_e.child_id)
         OR (v_e.user_id  IS NOT NULL AND (p.user_id = v_e.user_id OR p.parent_id = v_e.user_id) AND p.child_id IS NULL)
         OR (v_e.unregistered_athlete_id IS NOT NULL AND p.unregistered_athlete_id = v_e.unregistered_athlete_id)
      )
    FOR UPDATE;

    -- FOUND y no v_p.id: sin fila, el record conserva la vuelta anterior.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El cobro % no es una mensualidad de este atleta.', v_d.payment_id;
    END IF;
    v_mes := make_date(v_p.period_year, v_p.period_month, 1);

    IF v_d.accion = 'anular' THEN
      -- Releído bajo el candado: si otro admin ya lo movió, se aborta todo.
      IF v_p.status NOT IN ('pending', 'overdue') OR COALESCE(v_p.amount_paid, 0) > 0 THEN
        RAISE EXCEPTION 'El cobro de % ya no se puede anular (está %). Recarga la ventana.',
          to_char(v_mes, 'MM/YYYY'), v_p.status;
      END IF;
      IF v_mes > v_mes_actual THEN
        RAISE EXCEPTION 'El cobro de % es de un mes futuro: para eso está la Pausa.', to_char(v_mes, 'MM/YYYY');
      END IF;
      IF v_motivo IS NULL THEN
        RAISE EXCEPTION 'Escribe el motivo de la anulación (por ejemplo, quién avisó que no vino).';
      END IF;

      UPDATE public.payments SET status = 'cancelled', updated_at = now() WHERE id = v_p.id;

      INSERT INTO public.payment_adjustments
        (school_id, payment_id, enrollment_id, kind, amount_before, amount_after, status_before, motivo, created_by)
      VALUES
        (v_e.school_id, v_p.id, v_e.id, 'anulado_no_asistio', v_p.amount, NULL, v_p.status, v_motivo, v_uid);

      -- Marca del mes para que open_month no lo vuelva a emitir. resumed_at en
      -- el inicio del mes: exime el COBRO del mes, pero la ventana de DÍAS queda
      -- vacía (no saca del roster, no pinta «en pausa»).
      IF NOT EXISTS (
        SELECT 1 FROM public.enrollment_pause_requests r
        WHERE r.enrollment_id = v_e.id
          AND r.status = 'approved'
          AND v_mes BETWEEN r.month_from AND r.month_to
      ) THEN
        INSERT INTO public.enrollment_pause_requests
          (school_id, enrollment_id, child_id, user_id, unregistered_athlete_id,
           reason, reason_note, month_from, month_to, status, source,
           requested_by, requested_at, reviewed_by, reviewed_at,
           payments_cancelled, resumed_at, resumed_by)
        VALUES
          (v_e.school_id, v_e.id, v_e.child_id, v_e.user_id, v_e.unregistered_athlete_id,
           'no_asistio', v_motivo, v_mes, v_mes, 'approved', 'admin',
           v_uid, now(), v_uid, now(),
           1, (v_mes::timestamp AT TIME ZONE 'America/Bogota'), v_uid);
      END IF;

      v_anulados := v_anulados + 1;
      v_lineas := v_lineas || (to_char(v_mes, 'MM/YYYY') || ' no se cobra (no asistió)');

    ELSE  -- 'valor'
      v_monto := round(COALESCE(v_d.monto, 0));
      IF v_p.status NOT IN ('pending', 'overdue', 'partial', 'awaiting_approval') THEN
        RAISE EXCEPTION 'El cobro de % ya no está abierto (está %). Recarga la ventana.',
          to_char(v_mes, 'MM/YYYY'), v_p.status;
      END IF;
      IF v_monto <= 0 THEN
        RAISE EXCEPTION 'El valor nuevo de % debe ser mayor que cero.', to_char(v_mes, 'MM/YYYY');
      END IF;
      IF v_monto <= COALESCE(v_p.amount_paid, 0) THEN
        RAISE EXCEPTION 'El valor nuevo de % no puede ser menor o igual a lo ya abonado (%).',
          to_char(v_mes, 'MM/YYYY'), v_p.amount_paid;
      END IF;
      IF v_monto = v_p.amount THEN
        CONTINUE;  -- nada que cambiar
      END IF;

      UPDATE public.payments SET amount = v_monto, updated_at = now() WHERE id = v_p.id;

      INSERT INTO public.payment_adjustments
        (school_id, payment_id, enrollment_id, kind, amount_before, amount_after, status_before, motivo, created_by)
      VALUES
        (v_e.school_id, v_p.id, v_e.id, 'valor_cambio_plan', v_p.amount, v_monto, v_p.status, v_motivo, v_uid);

      v_ajustados := v_ajustados + 1;
      v_lineas := v_lineas || (to_char(v_mes, 'MM/YYYY') || ' queda en $'
                               || replace(to_char(v_monto, 'FM999,999,999'), ',', '.'));
    END IF;
  END LOOP;

  -- Un solo aviso a la familia con todo lo que cambió.
  IF array_length(v_lineas, 1) > 0 THEN
    IF v_e.child_id IS NOT NULL THEN
      SELECT c.parent_id, c.full_name INTO v_destino, v_nombre FROM public.children c WHERE c.id = v_e.child_id;
    ELSIF v_e.user_id IS NOT NULL THEN
      v_destino := v_e.user_id;
      SELECT p.full_name INTO v_nombre FROM public.profiles p WHERE p.id = v_e.user_id;
    END IF;

    IF v_destino IS NOT NULL AND v_destino <> v_uid THEN
      BEGIN
        SELECT btrim(name) INTO v_school FROM public.schools WHERE id = v_e.school_id;
        INSERT INTO public.notifications (user_id, school_id, type, category, title, message, link, data)
        VALUES (
          v_destino, v_e.school_id, 'info', 'payment',
          '🧾 Cobros actualizados: ' || COALESCE(NULLIF(btrim(v_nombre), ''), 'tu deportista'),
          COALESCE(v_school, 'La escuela') || ' actualizó los cobros de '
            || COALESCE(NULLIF(btrim(v_nombre), ''), 'tu deportista') || ': '
            || array_to_string(v_lineas, ' · ') || '.'
            || COALESCE(' Motivo: ' || v_motivo, ''),
          '/my-payments',
          jsonb_build_object('enrollment_id', v_e.id, 'op', 'cobros_ajustados',
                             'anulados', v_anulados, 'ajustados', v_ajustados));
      EXCEPTION WHEN OTHERS THEN
        -- El aviso nunca tumba el ajuste.
        RAISE WARNING '[cobros_abiertos] aviso a la familia falló (%): %', v_e.id, SQLERRM;
      END;
    END IF;
  END IF;

  RETURN jsonb_build_object('anulados', v_anulados, 'ajustados', v_ajustados, 'lineas', to_jsonb(v_lineas));
END;
$$;

REVOKE ALL ON FUNCTION public.resolver_cobros_abiertos(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolver_cobros_abiertos(uuid, jsonb, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolver_cobros_abiertos(uuid, jsonb, text) IS
  'Aplica en una transacción las decisiones del admin sobre mensualidades abiertas: anular por «no asistió» (pending/overdue sin abonos, mes pasado o actual; deja marca no_asistio para que open_month no lo re-emita) o cambiar el valor (cambio de plan). Registra payment_adjustments y avisa a la familia una sola vez. Solo admin de la escuela.';

COMMIT;

-- Verificación:
--   select public.cobros_abiertos_de_inscripcion('<enrollment>');   -- como admin
--   select * from public.payment_adjustments order by created_at desc limit 5;
--   set local role anon; select count(*) from public.payment_adjustments;  -- 42501
