-- 20261031105601 — «cobros abiertos»: solo los cobros de ESTA inscripción
--
-- Bug (visto armando el manual, demo Club Campestre): cobros_abiertos_de_inscripcion
-- y resolver_cobros_abiertos filtraban los cobros por la IDENTIDAD del atleta
-- (child/user/unregistered), no por la inscripción. Un atleta con dos
-- inscripciones (Fútbol + Tenis) veía en la ventana de Fútbol también su
-- mensualidad de Tenis, con el valor sugerido de Fútbol; tras un cambio de plan
-- en Fútbol, la ventana automática proponía rebajar el cobro de Tenis.
-- Alcance hoy: 53 atletas con 2+ inscripciones vivas en 8 escuelas.
--
-- payments no tiene enrollment_id, pero open_month (y los demás caminos) le
-- copian team_id y offering_plan_id de la inscripción. Regla:
--   - team_id del cobro = el de ESTA inscripción → es suyo, siempre.
--   - si no, es de OTRA si coincide con otra inscripción viva (no cancelada)
--     del mismo atleta en la misma escuela: por equipo, o por programa
--     (offering del plan) cuando el programa difiere del de esta.
--   - sin team ni plan, o sin otra inscripción que lo reclame → se muestra
--     (mejor mostrar de más que esconder una deuda).
--   - un cambio de plan o de equipo dentro de la misma inscripción NO lo saca:
--     el equipo/plan viejo no está en otra inscripción viva.
-- Las inscripciones canceladas no reclaman cobros: su deuda abierta sigue
-- apareciendo en la inscripción viva del atleta.

BEGIN;

-- 1. Helper. Solo lo llaman las dos RPC SECURITY DEFINER (corre como su dueño):
--    sin EXECUTE para nadie más.
CREATE OR REPLACE FUNCTION public._cobro_de_otra_inscripcion(
  p_enrollment_id    uuid,
  p_team_id          uuid,
  p_offering_plan_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH e AS (
    SELECT e.id, e.school_id, e.child_id, e.user_id, e.unregistered_athlete_id, e.team_id,
           COALESCE(e.offering_id,
                    (SELECT op.offering_id FROM public.offering_plans op WHERE op.id = e.offering_plan_id)) AS offering_id
    FROM public.enrollments e
    WHERE e.id = p_enrollment_id
  ),
  pago AS (
    SELECT (SELECT op.offering_id FROM public.offering_plans op WHERE op.id = p_offering_plan_id) AS offering_id
  )
  SELECT CASE
    WHEN p_team_id IS NOT NULL AND p_team_id = (SELECT team_id FROM e) THEN false
    ELSE EXISTS (
      SELECT 1
      FROM e, pago, public.enrollments o
      WHERE o.school_id = e.school_id
        AND o.id <> e.id
        AND o.status <> 'cancelled'
        AND ( (e.child_id IS NOT NULL AND o.child_id = e.child_id)
           OR (e.child_id IS NULL AND e.user_id IS NOT NULL AND o.user_id = e.user_id AND o.child_id IS NULL)
           OR (e.unregistered_athlete_id IS NOT NULL AND o.unregistered_athlete_id = e.unregistered_athlete_id) )
        AND ( (p_team_id IS NOT NULL AND o.team_id = p_team_id)
           OR (pago.offering_id IS NOT NULL
               AND pago.offering_id IS DISTINCT FROM e.offering_id
               AND COALESCE(o.offering_id,
                            (SELECT op.offering_id FROM public.offering_plans op WHERE op.id = o.offering_plan_id))
                   = pago.offering_id) )
    )
  END;
$$;

REVOKE ALL ON FUNCTION public._cobro_de_otra_inscripcion(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._cobro_de_otra_inscripcion(uuid, uuid, uuid) IS
  'true si un cobro (por su team_id / offering_plan_id) pertenece a OTRA inscripción viva del mismo atleta. Lo usan cobros_abiertos_de_inscripcion y resolver_cobros_abiertos.';

-- 2. Lectura: igual que en 20261029161649, más el filtro por inscripción.
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
      -- Solo los de ESTA inscripción: fuera los que son de otra inscripción viva del atleta.
      AND NOT public._cobro_de_otra_inscripcion(v_e.id, p.team_id, p.offering_plan_id)
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
  'Mensualidades abiertas (pending/overdue/partial/awaiting_approval) de ESTA inscripción (no las de otra inscripción viva del atleta), con asistencias del mes, días con lista y valor sugerido según la cuota vigente. Solo admin de la escuela.';

-- 3. Escritura: igual que en 20261029190004, más el mismo filtro (un cobro de otra
--    inscripción se rechaza como «no es una mensualidad de este atleta»).
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
      -- Solo los de ESTA inscripción: fuera los que son de otra inscripción viva del atleta.
      AND NOT public._cobro_de_otra_inscripcion(v_e.id, p.team_id, p.offering_plan_id)
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

      INSERT INTO public.payment_corrections
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

      INSERT INTO public.payment_corrections
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

COMMIT;
