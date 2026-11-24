-- =============================================================================
-- 20261123121346_pago_familia_monto_recibido.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123120036
-- Objetivo: registro manual de pagos de HERMANAS con un solo comprobante y con
--   «monto recibido»: si sobra plata, queda como saldo a favor repartido por
--   deportista. Spec: docs/specs/pago-hermanas-un-comprobante.md (rev. 2).
--   · payment_adjustments.grupo_registro: referencia común a los ajustes de un
--     mismo registro (rastreo e idempotencia por grupo).
--   · RPC register_manual_payments_familia (SECURITY DEFINER, transaccional).
--   No toca register_manual_payments (vivo).
-- =============================================================================
BEGIN;

ALTER TABLE public.payment_adjustments
  ADD COLUMN IF NOT EXISTS grupo_registro uuid;

CREATE INDEX IF NOT EXISTS ix_padj_grupo_registro
  ON public.payment_adjustments (grupo_registro)
  WHERE grupo_registro IS NOT NULL;

CREATE OR REPLACE FUNCTION public.register_manual_payments_familia(
  p_school_id      uuid,
  p_payment_ids    uuid[],
  p_method         text,
  p_payment_date   date,
  p_reference_base text,
  p_receipt_url    text    DEFAULT NULL,
  p_receipt_fields jsonb   DEFAULT NULL,
  p_monto_recibido numeric DEFAULT NULL,
  p_ancla_child    uuid    DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_ids        uuid[];
  v_found      integer;
  v_bad        integer;
  v_no_child   integer;
  v_fam_ok     boolean;
  v_row        record;
  v_rf         public.payments;
  v_i          integer := 0;
  v_total      numeric := 0;
  v_paid_ids   uuid[] := ARRAY[]::uuid[];
  v_ref        text;
  v_grupo      uuid;
  v_ya         integer;
  v_recibido   numeric;
  v_exc        numeric := 0;
  v_children   uuid[];
  v_n          integer;
  v_base       numeric;
  v_resto      numeric;
  v_parte      numeric;
  v_child      uuid;
  v_pay        record;
  v_seq        integer;
  v_cons       numeric := 0;
  v_reparto    jsonb := '[]'::jsonb;
  v_motivo     text := 'Pagó de más al registrar el pago: saldo a favor';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501';
  END IF;
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'school_id obligatorio' USING ERRCODE = '22023';
  END IF;
  IF NOT (public.is_school_admin(p_school_id) OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'sin_permiso: solo el owner o los administradores de la escuela pueden registrar pagos'
      USING ERRCODE = '42501';
  END IF;
  IF NOT public.school_is_operational(p_school_id) THEN
    RAISE EXCEPTION 'escuela_no_operativa: la cuenta de la escuela está bloqueada para esta operación'
      USING ERRCODE = '42501';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'transfer') THEN
    RAISE EXCEPTION 'metodo_invalido: debe ser cash o transfer' USING ERRCODE = '22023';
  END IF;
  IF p_reference_base IS NULL OR length(btrim(p_reference_base)) = 0 THEN
    RAISE EXCEPTION 'referencia_obligatoria' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_payment_ids, ARRAY[]::uuid[])) AS x;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'sin_cobros: selecciona al menos un cobro' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 12 THEN
    RAISE EXCEPTION 'demasiados_cobros: máximo 12 por operación' USING ERRCODE = '22023';
  END IF;

  -- Referencia común del grupo: determinista a partir de los cobros.
  v_grupo := md5(array_to_string(v_ids, ','))::uuid;

  PERFORM 1 FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id
   ORDER BY id
   FOR UPDATE;

  -- Idempotencia por grupo: si ya se registró este mismo grupo, no se repite nada.
  SELECT count(*) INTO v_ya
    FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id
     AND status = 'paid'
     AND reference LIKE p_reference_base || '%';
  IF v_ya = cardinality(v_ids) THEN
    RETURN jsonb_build_object(
      'ya_registrado', true,
      'grupo_registro', v_grupo,
      'payment_ids', to_jsonb(v_ids),
      'ajustes', COALESCE((SELECT jsonb_agg(jsonb_build_object('payment_id', a.payment_id, 'monto', a.amount))
                             FROM public.payment_adjustments a
                            WHERE a.grupo_registro = v_grupo AND a.kind = 'saldo_a_favor'), '[]'::jsonb));
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE status NOT IN ('pending', 'overdue')),
         count(*) FILTER (WHERE child_id IS NULL)
    INTO v_found, v_bad, v_no_child
    FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id;

  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'cobro_no_encontrado: alguno de los cobros no existe en esta escuela' USING ERRCODE = 'P0002';
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'cobro_no_pagable: solo se registran cobros pendientes o atrasados' USING ERRCODE = 'P0001';
  END IF;
  IF v_no_child > 0 THEN
    RAISE EXCEPTION 'solo_menores: este registro es para deportistas menores con hermanas vinculadas' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(DISTINCT child_id ORDER BY child_id) INTO v_children
    FROM public.payments WHERE id = ANY (v_ids);
  v_n := cardinality(v_children);

  -- Misma familia: mismo acudiente (children.parent_id) o mismo grupo de hermanos.
  IF v_n > 1 THEN
    SELECT (
      (SELECT count(DISTINCT c.parent_id) = 1 AND bool_and(c.parent_id IS NOT NULL)
         FROM public.children c WHERE c.id = ANY (v_children))
      OR
      (SELECT count(DISTINCT l.group_id) = 1 AND count(*) = v_n
         FROM public.school_sibling_links l
        WHERE l.school_id = p_school_id AND l.child_id = ANY (v_children))
    ) INTO v_fam_ok;
    IF NOT COALESCE(v_fam_ok, false) THEN
      RAISE EXCEPTION 'familia_distinta: los cobros deben ser de hermanas vinculadas de una misma familia'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_ancla_child IS NULL THEN
    p_ancla_child := v_children[1];
  ELSIF NOT (p_ancla_child = ANY (v_children)) THEN
    RAISE EXCEPTION 'ancla_invalida: la deportista ancla debe tener un cobro en el grupo' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO v_total FROM public.payments WHERE id = ANY (v_ids);
  v_recibido := COALESCE(p_monto_recibido, v_total);
  IF v_recibido < v_total THEN
    RAISE EXCEPTION 'recibido_menor: lo recibido es menor que lo que cubren estos cobros; registra cada cobro con su abono'
      USING ERRCODE = 'P0001';
  END IF;
  v_exc := round(v_recibido - v_total);

  v_rf := jsonb_populate_record(NULL::public.payments, COALESCE(p_receipt_fields, '{}'::jsonb));

  FOR v_row IN
    SELECT id, amount FROM public.payments
     WHERE id = ANY (v_ids) AND school_id = p_school_id
     ORDER BY due_date, created_at, id
  LOOP
    v_i := v_i + 1;
    v_ref := CASE WHEN cardinality(v_ids) = 1 THEN p_reference_base ELSE p_reference_base || '-' || v_i END;

    UPDATE public.payments SET
      status           = 'paid',
      payment_method   = p_method,
      payment_channel  = p_method,
      payment_date     = p_payment_date,
      approved_by      = v_uid,
      approved_at      = now(),
      reference        = v_ref,
      amount_paid      = amount,
      requires_review  = false,
      unblocked_at     = now(),
      unblocked_by     = v_uid,
      receipt_url      = CASE WHEN p_method = 'transfer' THEN p_receipt_url ELSE receipt_url END
    WHERE id = v_row.id;

    IF v_i = 1 AND p_method = 'transfer' AND p_receipt_fields IS NOT NULL THEN
      UPDATE public.payments SET
        ocr_amount                  = v_rf.ocr_amount,
        ocr_currency                = v_rf.ocr_currency,
        ocr_date                    = v_rf.ocr_date,
        ocr_bank                    = v_rf.ocr_bank,
        ocr_reference               = v_rf.ocr_reference,
        ocr_provider                = v_rf.ocr_provider,
        ocr_destination             = v_rf.ocr_destination,
        ocr_destination_name        = v_rf.ocr_destination_name,
        ocr_origin_name             = v_rf.ocr_origin_name,
        ocr_time                    = v_rf.ocr_time,
        ocr_raw_response            = v_rf.ocr_raw_response,
        receipt_verdict             = v_rf.receipt_verdict,
        receipt_verdict_reasons     = v_rf.receipt_verdict_reasons,
        receipt_reference_norm      = v_rf.receipt_reference_norm,
        receipt_image_sha256        = v_rf.receipt_image_sha256,
        receipt_image_sha256_source = v_rf.receipt_image_sha256_source,
        receipt_verdict_at          = v_rf.receipt_verdict_at
      WHERE id = v_row.id;
    END IF;

    v_paid_ids := v_paid_ids || v_row.id;
  END LOOP;

  -- Saldo a favor: excedente EXPLÍCITO (recibido − suma), igual en efectivo y en
  -- transferencia. Reparto por deportista, en pesos enteros; el residuo va a la ancla.
  IF v_exc > 0 THEN
    v_base  := floor(v_exc / v_n);
    v_resto := v_exc - v_base * v_n;

    FOREACH v_child IN ARRAY v_children LOOP
      v_parte := v_base + CASE WHEN v_child = p_ancla_child THEN v_resto ELSE 0 END;
      CONTINUE WHEN v_parte <= 0;

      -- Primer cobro de esa deportista dentro del grupo.
      SELECT p.id, p.amount, p.school_id, p.child_id, p.unregistered_athlete_id, p.user_id, p.parent_id
        INTO v_pay
        FROM public.payments p
       WHERE p.id = ANY (v_ids) AND p.child_id = v_child
       ORDER BY p.due_date, p.created_at, p.id
       LIMIT 1;

      SELECT COALESCE(max(a.sequence), 0) + 1 INTO v_seq
        FROM public.payment_adjustments a WHERE a.payment_id = v_pay.id;

      UPDATE public.payments
         SET amount_paid = v_pay.amount + v_parte,
             updated_at  = now()
       WHERE id = v_pay.id;

      INSERT INTO public.payment_adjustments (
          school_id, payment_id, charge_batch_id, kind, origin, applies_to, sequence,
          basis, pct, amount, scope, context, reason_code, reason_text,
          amount_before, amount_after, amount_paid_at, created_by, grupo_registro)
      VALUES (
          p_school_id, v_pay.id, NULL, 'saldo_a_favor', 'saldo_a_favor', 'pago', v_seq,
          'valor', NULL, v_parte, 'linea', 'al_pagar', 'saldo_a_favor',
          left(v_motivo, 300),
          v_pay.amount, v_pay.amount, v_pay.amount + v_parte, v_uid, v_grupo);

      v_reparto := v_reparto || jsonb_build_object('child_id', v_child, 'payment_id', v_pay.id, 'monto', v_parte);

      v_cons := v_cons + public._saldo_a_favor_consumir(
          p_school_id,
          public._saldo_a_favor_dueno(v_pay.child_id, v_pay.unregistered_athlete_id, v_pay.user_id, v_pay.parent_id),
          v_uid);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ya_registrado', false,
    'grupo_registro', v_grupo,
    'payment_ids', to_jsonb(v_paid_ids),
    'count', v_i,
    'total', v_total,
    'excedente', v_exc,
    'reparto', v_reparto,
    'consumido', v_cons);
END;
$function$;

REVOKE ALL ON FUNCTION public.register_manual_payments_familia(uuid, uuid[], text, date, text, text, jsonb, numeric, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_manual_payments_familia(uuid, uuid[], text, date, text, text, jsonb, numeric, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.register_manual_payments_familia(uuid, uuid[], text, date, text, text, jsonb, numeric, uuid) IS
  'Registra a mano cobros pendientes de hermanas vinculadas con un comprobante. Excedente = recibido − suma, repartido por deportista (residuo a la ancla). Idempotente por grupo. Solo admin de la escuela.';

COMMIT;
