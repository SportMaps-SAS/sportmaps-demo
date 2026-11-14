-- 20261029190004 — cobros abiertos: tabla propia para el historial y se quita
-- la policy que la migración 20261029161649 le sumó a payment_adjustments.
--
-- Qué pasó: 20261029161649 hizo CREATE TABLE IF NOT EXISTS payment_adjustments,
-- pero esa tabla YA existía (descuentos de cobros múltiples, 20261010144554),
-- con otras columnas. El CREATE no hizo nada y:
--   1. resolver_cobros_abiertos() insertaba columnas que no existen
--      (enrollment_id, status_before, motivo) → «Aplicar» fallaba siempre.
--   2. Se le sumó la policy permisiva payment_adjustments_select («se ve si se
--      ve el cobro»), que abría los descuentos —con nota y autor— a acudientes y
--      atletas. El diseño de esa tabla es: finanzas por padj_select_finance y la
--      familia SOLO por la vista v_payment_adjustments_familia (sin quién ni nota).
--   3. Se pisó el COMMENT de la tabla.
--
-- Arreglo:
--   - DROP de la policy agregada y COMMENT original restaurado (GRANTs eran iguales).
--   - Tabla nueva payment_corrections para «no asistió» / «cambio de plan».
--     RLS: finanzas de la escuela + la familia dueña del cobro (el motivo es
--     para ella, D6 del spec). Escribe solo la RPC.
--   - resolver_cobros_abiertos() redefinida para escribir ahí (cuerpo igual).
-- Las otras piezas de 20261029161649 (reason 'no_asistio', pause_validar,
-- fn_notify_pause_decision, cobros_abiertos_de_inscripcion) están bien.

BEGIN;

-- 1. Devolver payment_adjustments a como estaba
DROP POLICY IF EXISTS payment_adjustments_select ON public.payment_adjustments;

COMMENT ON TABLE public.payment_adjustments IS
    'Ajustes de un cobro (spec cobros-multiples §6.5). Solo inserción: corregir = insertar kind=reversion. '
    'payments.discount_amount / late_fee_waived_amount son su caché.';

-- 2. Historial propio de «no asistió» / «cambio de plan»
CREATE TABLE public.payment_corrections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id      uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  payment_id     uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  enrollment_id  uuid REFERENCES public.enrollments(id) ON DELETE SET NULL,
  kind           text NOT NULL
                 CONSTRAINT payment_corrections_kind_check
                 CHECK (kind IN ('anulado_no_asistio', 'valor_cambio_plan')),
  amount_before  numeric NOT NULL,
  amount_after   numeric,
  status_before  text NOT NULL,
  motivo         text CONSTRAINT payment_corrections_motivo_len CHECK (motivo IS NULL OR length(motivo) <= 500),
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_corrections_payment ON public.payment_corrections(payment_id);
CREATE INDEX idx_payment_corrections_school  ON public.payment_corrections(school_id, created_at DESC);

ALTER TABLE public.payment_corrections ENABLE ROW LEVEL SECURITY;

-- Finanzas de la escuela (misma función que padj_select_finance).
CREATE POLICY pcorr_select_finance ON public.payment_corrections
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.finance_read_school_ids())::uuid[]));

-- La familia dueña del cobro (acudiente o atleta adulto). Lee payments y
-- children, no payment_corrections: sin auto-recursión.
CREATE POLICY pcorr_select_familia ON public.payment_corrections
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.id = payment_corrections.payment_id
      AND (p.parent_id = (SELECT auth.uid())
           OR p.user_id = (SELECT auth.uid())
           OR p.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = (SELECT auth.uid())))
  ));

REVOKE ALL ON public.payment_corrections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_corrections TO authenticated;
GRANT ALL ON public.payment_corrections TO service_role;

COMMENT ON TABLE public.payment_corrections IS
  'Historial de cobros anulados por «no asistió» o con valor cambiado por cambio de plan. Lo escribe solo resolver_cobros_abiertos(); lo leen finanzas de la escuela y la familia dueña del cobro.';

-- 3. La RPC escribe en la tabla nueva
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

COMMENT ON FUNCTION public.resolver_cobros_abiertos(uuid, jsonb, text) IS
  'Aplica en una transacción las decisiones del admin sobre mensualidades abiertas: anular por «no asistió» (pending/overdue sin abonos, mes pasado o actual; deja marca no_asistio para que open_month no lo re-emita) o cambiar el valor (cambio de plan). Registra payment_corrections y avisa a la familia una sola vez. Solo admin de la escuela.';

COMMIT;
