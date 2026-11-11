-- =============================================================================
-- 20261111151130_cobro_servicio_seguimiento.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-11   Versión anterior: 20261111114349
-- Objetivo: seguimiento de 20261111114349 (YA aplicada, inmutable) tras las pruebas
-- de rollback (91 de 93; fallaban G3 y J4):
--   1. registrar_pago_servicio_manual: p_opcion en un ítem SIN opciones se ignora. El
--      IF que la forzaba a NULL nunca entraba con opciones NULL (jsonb_typeof(NULL) es
--      NULL) y la opción larga chocaba con el CHECK de 30 caracteres (opcion_invalida).
--   2. ligar_cobro_a_servicio: volver a ligar un cobro cuyo enlace se anuló (tras
--      reclasificar) con el MISMO descuento ya estampado es ok (no vuelve a estampar);
--      un descuento DISTINTO sigue siendo ya_tiene_descuento. Era un error de la función.
--   3. whatsapp_audiencia.intereses admite además 'vacacional' y 'campamento' (para que el
--      BFF pueda encender WA_AUDIENCIA_INTERES_PARTIDO=1).
-- CREATE OR REPLACE conserva la ACL; se re-afirma igual.
-- =============================================================================

BEGIN;

-- ── 1. registrar_pago_servicio_manual ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.registrar_pago_servicio_manual(
    p_school_id                    uuid,
    p_item_id                      uuid,
    p_monto                        numeric,
    p_metodo                       text,
    p_idempotency_key              text,
    p_child_id                     uuid    DEFAULT NULL,
    p_user_id                      uuid    DEFAULT NULL,
    p_unregistered_id              uuid    DEFAULT NULL,
    p_signup_lead_id               uuid    DEFAULT NULL,
    p_fecha_pago                   date    DEFAULT NULL,
    p_referencia                   text    DEFAULT NULL,
    p_opcion                       text    DEFAULT NULL,
    p_team_id                      uuid    DEFAULT NULL,
    p_aplicar_descuento_grupo      boolean DEFAULT true,
    p_precio_acordado              numeric DEFAULT NULL,
    p_motivo_precio                text    DEFAULT NULL,
    p_permitir_referencia_repetida boolean DEFAULT false,
    p_ignorar_cobro_sin_ligar      boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_hoy       date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_key       text := btrim(COALESCE(p_idempotency_key, ''));
    v_fecha     date;
    v_ref       text := NULLIF(btrim(COALESCE(p_referencia, '')), '');
    v_ref_norm  text;
    v_motivo    text := NULLIF(btrim(COALESCE(p_motivo_precio, '')), '');
    v_tipo      text;
    v_dueno     uuid;
    v_monto     numeric;
    v_item      public.school_tournament_items%ROWTYPE;
    v_lead      public.school_signup_leads%ROWTYPE;
    v_pago      public.payments%ROWTYPE;
    v_mov       record;
    v_ex        record;
    v_parent    uuid;
    v_branch    uuid;
    v_nombre    text;
    v_afiliado  boolean;
    v_grupo     boolean := false;
    v_pv        jsonb;
    v_lista     numeric;
    v_precio    numeric;
    v_pct       numeric;
    v_clave     text;
    v_etiqueta  text;
    v_saldo     numeric;
    v_min       numeric;
    v_es_abono  boolean := false;
    v_status    text;
    v_pid       uuid;
    v_concepto  text;
    v_cupos     integer;
    v_cands     jsonb;
    v_dup       uuid;
    v_res       text;
    v_acordado  numeric := CASE WHEN p_precio_acordado IS NULL THEN NULL ELSE round(p_precio_acordado, 2) END;
    v_opcion    text := p_opcion;
    v_due       date;
    v_cons      text;
BEGIN
    -- Gate AL INICIO: admin de ESTA escuela (o super admin). Nada se revela antes.
    IF v_uid IS NULL
       OR NOT (COALESCE(p_school_id = ANY (public.user_admin_school_ids()), false)
               OR COALESCE(public.is_super_admin(), false)) THEN
        RAISE EXCEPTION 'Sin permisos sobre esta escuela' USING ERRCODE = '42501';
    END IF;

    IF num_nonnulls(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id) <> 1 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
    END IF;
    IF p_metodo IS NULL OR p_metodo NOT IN ('transfer', 'cash') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'metodo_invalido');
    END IF;
    IF char_length(v_key) < 8 OR char_length(v_key) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'clave_invalida');
    END IF;
    IF p_item_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'monto_invalido');
    END IF;
    v_monto := round(p_monto, 2);
    v_fecha := COALESCE(p_fecha_pago, v_hoy);
    IF v_fecha > v_hoy OR v_fecha < v_hoy - 400 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'fecha_invalida');
    END IF;
    IF p_precio_acordado IS NOT NULL THEN
        IF v_acordado <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'precio_acordado_invalido');
        END IF;
        IF v_motivo IS NULL OR char_length(v_motivo) < 10 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'motivo_requerido');
        END IF;
    END IF;

    v_tipo  := CASE WHEN p_child_id IS NOT NULL THEN 'child'
                    WHEN p_user_id IS NOT NULL THEN 'user'
                    WHEN p_unregistered_id IS NOT NULL THEN 'unregistered'
                    ELSE 'lead' END;
    v_dueno := COALESCE(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id);
    v_ref_norm := CASE WHEN v_ref IS NULL THEN NULL
                       ELSE NULLIF(upper(regexp_replace(v_ref, '[\s-]', '', 'g')), '') END;

    -- Orden de candados = el de wa_crear_cobro_desde_comprobante: prospecto, luego ítem
    -- (en sentido contrario las dos transacciones podrían interbloquearse).
    IF v_tipo = 'lead' THEN
        SELECT * INTO v_lead
          FROM public.school_signup_leads
         WHERE id = p_signup_lead_id AND school_id = p_school_id
           FOR UPDATE;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
        IF v_lead.status = 'discarded' THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'lead_descartado');
        END IF;
    END IF;

    -- Candado del ítem: serializa cupos, idempotencia y abonos con el bot y la app.
    SELECT * INTO v_item
      FROM public.school_tournament_items
     WHERE id = p_item_id AND school_id = p_school_id
       FOR UPDATE;
    IF NOT FOUND OR v_item.event_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
    END IF;
    -- Sin opciones en el ítem, la opción no significa nada: no se guarda.
    -- (jsonb_typeof(NULL) es NULL: sin COALESCE el IF no entraba con opciones NULL y la opción larga
    -- llegaba al CHECK de 30 caracteres.)
    IF NOT COALESCE(jsonb_typeof(v_item.opciones) = 'array' AND jsonb_array_length(v_item.opciones) > 0, false) THEN
        v_opcion := NULL;
    END IF;

    -- Idempotencia (después del candado: ve lo que commiteó el otro).
    SELECT m.payment_id, m.item_id, m.dueno_tipo, m.dueno_id, m.tipo, m.monto INTO v_mov
      FROM public.cobros_servicio_movimientos m
     WHERE m.school_id = p_school_id AND m.idempotency_key = v_key;
    IF FOUND THEN
        IF v_mov.item_id IS DISTINCT FROM p_item_id
           OR v_mov.dueno_tipo IS DISTINCT FROM v_tipo
           OR v_mov.dueno_id IS DISTINCT FROM v_dueno THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'clave_reutilizada');
        END IF;
        SELECT * INTO v_pago FROM public.payments WHERE id = v_mov.payment_id;
        RETURN jsonb_build_object(
            'ok', true, 'idempotente', true, 'creado', false, 'payment_id', v_pago.id,
            'estado', v_pago.status, 'monto_cobro', v_pago.amount, 'recibido', COALESCE(v_pago.amount_paid, 0),
            'saldo', GREATEST(v_pago.amount - COALESCE(v_pago.amount_paid, 0)
                              - COALESCE(v_pago.early_payment_discount_applied, 0), 0),
            'es_abono', v_pago.status = 'partial');
    END IF;

    -- Dueño: uno solo y de ESTA escuela. parent_id sale de children, nunca del cliente.
    IF v_tipo = 'child' THEN
        SELECT c.parent_id, c.branch_id, c.full_name INTO v_parent, v_branch, v_nombre
          FROM public.children c
         WHERE c.id = p_child_id AND c.school_id = p_school_id AND c.is_active;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
    ELSIF v_tipo = 'user' THEN
        SELECT pr.full_name INTO v_nombre
          FROM public.profiles pr
          JOIN public.school_members sm ON sm.profile_id = pr.id
         WHERE pr.id = p_user_id AND sm.school_id = p_school_id AND sm.status = 'active'
         LIMIT 1;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
    ELSIF v_tipo = 'unregistered' THEN
        SELECT ua.branch_id, ua.full_name INTO v_branch, v_nombre
          FROM public.unregistered_athletes ua
         WHERE ua.id = p_unregistered_id AND ua.school_id = p_school_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
    ELSE
        -- v_lead ya viene bloqueado y validado arriba.
        v_branch := v_lead.branch_id;
        v_nombre := v_lead.full_name;
    END IF;
    v_nombre := COALESCE(NULLIF(btrim(v_nombre), ''), 'Cliente');

    IF p_team_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.teams t WHERE t.id = p_team_id AND t.school_id = p_school_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'equipo_invalido');
    END IF;

    -- Referencia ya usada por otro pago vivo de la escuela (doble pago entre canales).
    IF v_ref_norm IS NOT NULL AND NOT COALESCE(p_permitir_referencia_repetida, false) THEN
        SELECT p.id INTO v_dup
          FROM public.payments p
         WHERE p.school_id = p_school_id
           AND p.receipt_reference_norm = v_ref_norm
           AND p.status NOT IN ('cancelled', 'rejected', 'failed')
         LIMIT 1;
        IF v_dup IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'referencia_duplicada', 'payment_id', v_dup);
        END IF;
    END IF;

    -- ── ¿Ya hay un cobro vivo de este ítem para este dueño? → abono / saldo ──
    SELECT d.pago_id, d.estado INTO v_ex
      FROM public._servicio_cobros_del_dueno(p_school_id, p_item_id, v_tipo, v_dueno) d
     ORDER BY (d.estado IN ('pending', 'overdue', 'partial')) DESC, d.creado DESC
     LIMIT 1;
    IF FOUND THEN
        IF v_ex.estado = 'awaiting_approval' THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'en_revision', 'payment_id', v_ex.pago_id);
        END IF;
        IF v_ex.estado IN ('paid', 'glosado') THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_pagado', 'payment_id', v_ex.pago_id);
        END IF;
        IF p_precio_acordado IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_existente_precio_fijo', 'payment_id', v_ex.pago_id);
        END IF;

        SELECT * INTO v_pago FROM public.payments WHERE id = v_ex.pago_id;
        v_saldo := v_pago.amount - COALESCE(v_pago.amount_paid, 0) - COALESCE(v_pago.early_payment_discount_applied, 0);
        IF v_monto > v_saldo + 1 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sobrepago', 'payment_id', v_pago.id, 'saldo', v_saldo);
        END IF;
        IF v_monto >= v_saldo - 1 THEN
            v_monto := v_saldo;                       -- salda (tolerancia ±$1)
        ELSE
            IF NOT COALESCE(v_item.allow_installments, false) OR v_item.abono_minimo_pct IS NULL THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'abono_no_permitido', 'payment_id', v_pago.id, 'saldo', v_saldo);
            END IF;
            v_min := ceil(v_pago.amount * v_item.abono_minimo_pct / 100.0);
            IF COALESCE(v_pago.amount_paid, 0) + v_monto < v_min - 1 THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'abono_menor_al_minimo',
                                          'payment_id', v_pago.id, 'abono_minimo', v_min, 'saldo', v_saldo);
            END IF;
        END IF;

        BEGIN
            v_res := public._registrar_pago_en_cobro(
                v_pago.id, v_uid, v_monto,
                jsonb_build_object(
                    'method', p_metodo,
                    'payment_date', v_fecha::text,
                    'reference', v_ref,
                    'ocr', CASE WHEN v_ref_norm IS NOT NULL
                                THEN jsonb_build_object('receipt_reference_norm', v_ref_norm)
                                ELSE '{}'::jsonb END),
                true, NULL);
        EXCEPTION WHEN SQLSTATE 'P0001' THEN
            IF SQLERRM LIKE 'EN_REVISION%' THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'en_revision', 'payment_id', v_pago.id);
            ELSIF SQLERRM LIKE 'SOBREPAGO%' THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'sobrepago', 'payment_id', v_pago.id);
            END IF;
            RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_cambio', 'payment_id', v_pago.id, 'detalle', left(SQLERRM, 200));
        END;

        BEGIN
            INSERT INTO public.cobros_servicio_movimientos (
                payment_id, school_id, item_id, dueno_tipo, dueno_id, tipo, monto, idempotency_key, origen, created_by
            ) VALUES (
                v_pago.id, p_school_id, p_item_id, v_tipo, v_dueno,
                CASE WHEN v_res = 'paid' THEN 'saldo' ELSE 'abono' END,
                v_monto, v_key, 'manual', v_uid);
        EXCEPTION WHEN unique_violation THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'clave_reutilizada');
        END;

        UPDATE public.cobros_servicio_item SET es_abono = (v_res = 'partial')
         WHERE payment_id = v_pago.id AND anulado_at IS NULL;

        SELECT * INTO v_pago FROM public.payments WHERE id = v_pago.id;
        RETURN jsonb_build_object(
            'ok', true, 'idempotente', false, 'creado', false, 'payment_id', v_pago.id,
            'estado', v_pago.status, 'monto_cobro', v_pago.amount, 'recibido', COALESCE(v_pago.amount_paid, 0),
            'saldo', GREATEST(v_pago.amount - COALESCE(v_pago.amount_paid, 0)
                              - COALESCE(v_pago.early_payment_discount_applied, 0), 0),
            'es_abono', v_pago.status = 'partial', 'monto_aplicado', v_monto);
    END IF;

    -- ── No hay cobro: se crea ya pagado (o parcial), nunca 'pending' ──────────
    -- Un cobro de la escuela sin ligar (p. ej. «Otro cobro») es el mismo cobro:
    -- se liga primero, para no repetir el caso de Carlos.
    IF NOT COALESCE(p_ignorar_cobro_sin_ligar, false) THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'payment_id', p.id, 'concepto', p.concept, 'monto', p.amount, 'estado', p.status)
                   ORDER BY p.created_at DESC), '[]'::jsonb)
          INTO v_cands
          FROM public.payments p
         WHERE p.school_id = p_school_id
           AND p.status IN ('pending', 'overdue', 'partial')
           AND p.payment_category IN (v_item.kind, 'otro')
           AND p.created_at > now() - interval '90 days'
           AND CASE v_tipo
                   WHEN 'child'        THEN p.child_id = v_dueno
                   WHEN 'user'         THEN p.user_id = v_dueno
                   WHEN 'unregistered' THEN p.unregistered_athlete_id = v_dueno
                   ELSE p.signup_lead_id = v_dueno
               END
           AND NOT EXISTS (SELECT 1 FROM public.cobros_servicio_item c WHERE c.payment_id = p.id AND c.anulado_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM public.wa_cobros_sueltos ws WHERE ws.payment_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM public.wa_cobros_desde_comprobante w WHERE w.payment_id = p.id);
        IF jsonb_array_length(v_cands) > 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_sin_ligar', 'candidatos', v_cands);
        END IF;
    END IF;

    -- Precio vigente a la fecha del pago.
    v_afiliado := public._servicio_es_afiliado(p_school_id, v_tipo, v_dueno);
    IF p_team_id IS NOT NULL AND COALESCE(p_aplicar_descuento_grupo, true) AND v_afiliado THEN
        v_grupo := public._servicio_grupo_cumple(p_item_id, p_team_id, 1);
    END IF;
    v_pv := public._servicio_precio_vigente(v_item, v_fecha, v_afiliado, v_opcion, v_grupo);
    IF NOT COALESCE((v_pv->>'ok')::boolean, false) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', v_pv->>'codigo');
    END IF;
    v_lista    := (v_pv->>'lista')::numeric;
    v_precio   := (v_pv->>'precio')::numeric;
    v_pct      := (v_pv->>'descuento_pct')::numeric;
    v_clave    := v_pv->>'descuento_clave';
    v_etiqueta := v_pv->>'etiqueta';
    IF v_acordado IS NOT NULL THEN
        v_precio := v_acordado;       -- acuerdo de la escuela: manda sobre lista y grupo
        v_pct    := NULL;
        v_clave  := NULL;
    END IF;
    IF COALESCE(v_precio, 0) <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
    END IF;

    -- Cupos (exactos: el ítem está bloqueado).
    v_cupos := public._servicio_cupos_vivos(p_item_id);
    IF v_item.capacity IS NOT NULL AND v_cupos >= v_item.capacity THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sin_cupos');
    END IF;

    -- Monto: igual al precio (±$1) o, en servicios con abono, al menos el mínimo.
    IF v_monto > v_precio + 1 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sobrepago', 'precio', v_precio);
    END IF;
    IF v_monto >= v_precio - 1 THEN
        v_monto  := v_precio;
        v_status := 'paid';
    ELSE
        IF NOT COALESCE(v_item.allow_installments, false) OR v_item.abono_minimo_pct IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'abono_no_permitido', 'precio', v_precio);
        END IF;
        v_min := ceil(v_precio * v_item.abono_minimo_pct / 100.0);
        IF v_monto < v_min - 1 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'abono_menor_al_minimo',
                                      'precio', v_precio, 'abono_minimo', v_min);
        END IF;
        v_status   := 'partial';
        v_es_abono := true;
    END IF;

    v_concepto := left(v_item.name || COALESCE(' · ' || v_etiqueta, '') || ' — ' || v_nombre, 200);
    -- Un abono vence en saldo_hasta (si es posterior a la fecha del pago); el pago completo, el día del pago.
    v_due := v_fecha;
    IF v_status = 'partial' AND v_item.saldo_hasta IS NOT NULL AND v_item.saldo_hasta > v_due THEN
        v_due := v_item.saldo_hasta;
    END IF;

    BEGIN
        INSERT INTO public.payments (
            school_id, parent_id, child_id, user_id, unregistered_athlete_id, signup_lead_id, branch_id,
            amount, amount_paid, concept, due_date, payment_date, status, payment_type,
            payment_method, payment_channel, payment_category, period_uniqueness_exempt,
            created_by, approved_by, approved_at, receipt_number, receipt_reference_norm
        ) VALUES (
            p_school_id, v_parent, p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id, v_branch,
            v_precio, v_monto, v_concepto, v_due, v_fecha, v_status, 'one_time',
            p_metodo, p_metodo, v_item.kind, true,
            v_uid, v_uid, now(), v_ref, v_ref_norm
        )
        RETURNING id INTO v_pid;

        -- La lista y el descuento se estampan DESPUÉS del INSERT: con list_amount en el
        -- INSERT, el trigger de descuentos automáticos lo rotularía «descuento del alta».
        IF v_precio < v_lista THEN
            UPDATE public.payments
               SET list_amount = v_lista, discount_amount = v_lista - v_precio, discount_pct = v_pct
             WHERE id = v_pid;
        END IF;

        -- Un abono deja su rastro en el historial único de abonos (igual que
        -- _registrar_pago_en_cobro; la tabla exige pagador o atleta con cuenta).
        IF v_status = 'partial' AND (v_parent IS NOT NULL OR p_user_id IS NOT NULL) THEN
            INSERT INTO public.payment_installments (
                payment_id, school_id, parent_id, athlete_id, amount, receipt_url, receipt_date,
                notes, status, reviewed_by, reviewed_at, upload_channel)
            VALUES (
                v_pid, p_school_id, v_parent, p_user_id, v_monto, NULL, v_fecha,
                'Abono registrado por la escuela (Cobros y pagos)', 'approved', v_uid, now(), 'staff');
        END IF;

        INSERT INTO public.cobros_servicio_item (
            payment_id, school_id, item_id, dueno_tipo, dueno_id, origen, opcion, es_abono,
            precio_lista, precio_acordado, motivo_precio, descuento_clave, team_id, idempotency_key, created_by
        ) VALUES (
            v_pid, p_school_id, p_item_id, v_tipo, v_dueno, 'manual', v_opcion, v_es_abono,
            v_lista, v_acordado, CASE WHEN v_acordado IS NOT NULL THEN v_motivo END,
            v_clave, p_team_id, v_key, v_uid);

        INSERT INTO public.cobros_servicio_movimientos (
            payment_id, school_id, item_id, dueno_tipo, dueno_id, tipo, monto, idempotency_key, origen, created_by
        ) VALUES (
            v_pid, p_school_id, p_item_id, v_tipo, v_dueno,
            CASE WHEN v_es_abono THEN 'abono' ELSE 'pago' END, v_monto, v_key, 'manual', v_uid);
    EXCEPTION
        WHEN unique_violation THEN
            -- El subbloque deshace todo lo insertado. Se distingue QUÉ único chocó.
            GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
            IF v_cons IN ('uq_payments_school_ocr_reference', 'uq_payments_school_receipt_hash') THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'referencia_duplicada');
            ELSIF v_cons IN ('uq_cobros_servicio_item_clave', 'uq_cobros_servicio_mov_clave') THEN
                -- La misma clave entró en paralelo por otro ítem (el candado es por ítem).
                RETURN jsonb_build_object('ok', false, 'codigo', 'clave_reutilizada');
            END IF;
            RETURN jsonb_build_object('ok', false, 'codigo', 'conflicto', 'constraint', v_cons);
        WHEN check_violation THEN
            GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
            IF v_cons = 'cobros_servicio_item_opcion_check' THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_invalida');
            END IF;
            RAISE;
    END;

    -- Si el prospecto ya se inscribió, el cobro pasa a su estado de cuenta.
    IF v_tipo = 'lead' AND v_lead.converted_enrollment_id IS NOT NULL THEN
        PERFORM public._mover_pago_clase_prueba(p_signup_lead_id);
    END IF;

    RETURN jsonb_build_object(
        'ok', true, 'idempotente', false, 'creado', true, 'payment_id', v_pid,
        'estado', v_status, 'monto_cobro', v_precio, 'recibido', v_monto,
        'saldo', GREATEST(v_precio - v_monto, 0), 'es_abono', v_es_abono, 'monto_aplicado', v_monto,
        'precio_lista', v_lista, 'descuento_clave', v_clave, 'descuento_pct', v_pct,
        'categoria', v_item.kind, 'concepto', v_concepto,
        'abono_minimo', CASE WHEN COALESCE(v_item.allow_installments, false) AND v_item.abono_minimo_pct IS NOT NULL
                             THEN ceil(v_precio * v_item.abono_minimo_pct / 100.0) END,
        'cupos_restantes', CASE WHEN v_item.capacity IS NULL THEN NULL
                                ELSE GREATEST(v_item.capacity - v_cupos - 1, 0) END);
END;
$$;

-- ── 2. ligar_cobro_a_servicio ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ligar_cobro_a_servicio(
    p_payment_id            uuid,
    p_item_id               uuid,
    p_motivo                text,
    p_aplicar_descuento_clave text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid      uuid := auth.uid();
    v_school   uuid;
    v_motivo   text := NULLIF(btrim(COALESCE(p_motivo, '')), '');
    v_item     public.school_tournament_items%ROWTYPE;
    v_pay      public.payments%ROWTYPE;
    v_prev     uuid;
    v_tipo     text;
    v_dueno    uuid;
    v_afiliado boolean;
    v_fecha    date;
    v_pv       jsonb;
    v_d        jsonb;
    v_lista    numeric;
    v_pct      numeric;
    v_desc     numeric;
    v_esperado numeric;
    v_base     numeric;
    v_clave    text;
    v_acordado numeric;
    v_ok       uuid;
    v_estampado boolean := false;
BEGIN
    -- Gate con la escuela DEL COBRO. Un cobro inexistente y uno ajeno dan lo mismo.
    SELECT p.school_id INTO v_school FROM public.payments p WHERE p.id = p_payment_id;
    IF v_uid IS NULL OR v_school IS NULL
       OR NOT (COALESCE(v_school = ANY (public.user_admin_school_ids()), false)
               OR COALESCE(public.is_super_admin(), false)) THEN
        RAISE EXCEPTION 'Sin permisos sobre esta escuela' USING ERRCODE = '42501';
    END IF;

    IF v_motivo IS NULL OR char_length(v_motivo) < 10 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'motivo_requerido');
    END IF;

    -- Orden de candados = el de registrar_pago_servicio_manual: ítem y luego pago.
    SELECT * INTO v_item
      FROM public.school_tournament_items
     WHERE id = p_item_id AND school_id = v_school
       FOR UPDATE;
    IF NOT FOUND OR v_item.event_id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
    END IF;
    SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;

    v_prev := public._servicio_pago_ligado(p_payment_id);
    IF v_prev IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ya_ligado', 'item_id', v_prev);
    END IF;
    IF v_pay.status NOT IN ('pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'estado_invalido', 'estado', v_pay.status);
    END IF;
    IF COALESCE(v_pay.payment_category, 'mensualidad') = 'mensualidad' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'categoria_no_permitida');
    END IF;

    IF v_pay.child_id IS NOT NULL THEN
        v_tipo := 'child';        v_dueno := v_pay.child_id;
    ELSIF v_pay.user_id IS NOT NULL THEN
        v_tipo := 'user';         v_dueno := v_pay.user_id;
    ELSIF v_pay.unregistered_athlete_id IS NOT NULL THEN
        v_tipo := 'unregistered'; v_dueno := v_pay.unregistered_athlete_id;
    ELSIF v_pay.signup_lead_id IS NOT NULL THEN
        v_tipo := 'lead';         v_dueno := v_pay.signup_lead_id;
    ELSE
        RETURN jsonb_build_object('ok', false, 'codigo', 'sin_dueno');
    END IF;

    IF v_item.capacity IS NOT NULL AND public._servicio_cupos_vivos(p_item_id) >= v_item.capacity THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sin_cupos');
    END IF;

    -- El precio de referencia es el de la fecha en que nació el cobro.
    v_fecha    := (v_pay.created_at AT TIME ZONE 'America/Bogota')::date;
    v_afiliado := public._servicio_es_afiliado(v_school, v_tipo, v_dueno);
    v_pv       := public._servicio_precio_vigente(v_item, v_fecha, v_afiliado, NULL, false);
    v_base     := v_pay.amount - COALESCE(v_pay.late_fee_amount, 0);

    IF p_aplicar_descuento_clave IS NOT NULL THEN
        IF NOT v_afiliado THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'no_afiliado');
        END IF;
        IF NOT COALESCE((v_pv->>'ok')::boolean, false) THEN
            RETURN jsonb_build_object('ok', false, 'codigo', v_pv->>'codigo');
        END IF;
        SELECT e INTO v_d
          FROM jsonb_array_elements(COALESCE(v_item.descuentos_grupo, '[]'::jsonb)) e
         WHERE e->>'clave' = p_aplicar_descuento_clave
         LIMIT 1;
        IF v_d IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'descuento_invalido');
        END IF;
        v_lista    := (v_pv->>'lista')::numeric;
        v_pct      := (v_d->>'pct')::numeric;
        v_desc     := round(v_lista * v_pct / 100, 2);
        v_esperado := v_lista - v_desc;
        IF v_pay.list_amount IS NOT NULL THEN
            -- Re-ligar un cobro cuyo enlace se anuló (reclasificado): si ya trae EXACTAMENTE este descuento,
            -- no se vuelve a estampar. Cualquier otro descuento previo sigue siendo ya_tiene_descuento.
            IF v_pay.list_amount = v_lista AND v_pay.discount_pct = v_pct AND v_pay.discount_amount = v_desc THEN
                v_estampado := true;
            ELSE
                RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_descuento');
            END IF;
        END IF;
        IF v_esperado <> v_base THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'monto_no_cuadra',
                                      'monto', v_pay.amount, 'esperado', v_esperado, 'lista', v_lista);
        END IF;
        v_clave := p_aplicar_descuento_clave;
    ELSE
        IF COALESCE((v_pv->>'ok')::boolean, false) THEN
            v_lista := (v_pv->>'lista')::numeric;
            IF (v_pv->>'precio')::numeric <> v_base THEN
                v_acordado := v_base;           -- la escuela fijó otro valor: queda dicho con su motivo
            END IF;
        ELSE
            v_lista := v_base;                  -- ítem con opciones: no hay precio único de referencia
        END IF;
    END IF;

    -- UPSERT: un enlace anulado (reclasificado) se puede volver a ligar; uno vivo, no.
    INSERT INTO public.cobros_servicio_item AS csi (
        payment_id, school_id, item_id, dueno_tipo, dueno_id, origen, es_abono,
        precio_lista, precio_acordado, motivo_precio, descuento_clave, team_id, created_by
    ) VALUES (
        p_payment_id, v_school, p_item_id, v_tipo, v_dueno, 'ligado_escuela', v_pay.status = 'partial',
        v_lista, v_acordado, v_motivo, v_clave, v_pay.team_id, v_uid
    )
    ON CONFLICT (payment_id) DO UPDATE
       SET school_id = EXCLUDED.school_id, item_id = EXCLUDED.item_id, dueno_tipo = EXCLUDED.dueno_tipo,
           dueno_id = EXCLUDED.dueno_id, origen = EXCLUDED.origen, opcion = NULL,
           es_abono = EXCLUDED.es_abono, precio_lista = EXCLUDED.precio_lista,
           precio_acordado = EXCLUDED.precio_acordado, motivo_precio = EXCLUDED.motivo_precio,
           descuento_clave = EXCLUDED.descuento_clave, team_id = EXCLUDED.team_id,
           idempotency_key = NULL, queue_id = NULL, anulado_at = NULL, anulado_motivo = NULL,
           created_by = EXCLUDED.created_by, created_at = now()
     WHERE csi.anulado_at IS NOT NULL
    RETURNING payment_id INTO v_ok;
    IF v_ok IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ya_ligado', 'item_id', p_item_id);
    END IF;

    -- amount NO se toca. Solo categoría y, si hay descuento, lista/descuento/% (cumple
    -- payments_amount_invariante: amount = lista - descuento + recargo).
    IF v_clave IS NOT NULL AND NOT v_estampado THEN
        UPDATE public.payments
           SET payment_category = v_item.kind,
               list_amount = v_lista, discount_amount = v_desc, discount_pct = v_pct
         WHERE id = p_payment_id;
    ELSE
        UPDATE public.payments SET payment_category = v_item.kind WHERE id = p_payment_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true, 'payment_id', p_payment_id, 'item_id', p_item_id, 'categoria', v_item.kind,
        'monto', v_pay.amount, 'estado', v_pay.status, 'precio_lista', v_lista,
        'descuento_clave', v_clave, 'descuento_pct', v_pct, 'precio_acordado', v_acordado);
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_pago_servicio_manual(uuid, uuid, numeric, text, text, uuid, uuid, uuid, uuid, date, text, text, uuid, boolean, numeric, text, boolean, boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pago_servicio_manual(uuid, uuid, numeric, text, text, uuid, uuid, uuid, uuid, date, text, text, uuid, boolean, numeric, text, boolean, boolean)
    TO authenticated;

REVOKE ALL ON FUNCTION public.ligar_cobro_a_servicio(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ligar_cobro_a_servicio(uuid, uuid, text, text) TO authenticated;

-- ── 3. whatsapp_audiencia.intereses ──────────────────────────────────────────
-- Definición VIVA (pg_constraint, 2026-11-11): intereses <@ ARRAY['clase_prueba','inscripcion',
-- 'clinica','precio','horarios','informacion']. Se amplía (superconjunto), así que las filas
-- existentes siguen cumpliendo; se comprueba antes de reemplazar.
DO $chk$
DECLARE v_mal integer;
BEGIN
    SELECT count(*) INTO v_mal
      FROM public.whatsapp_audiencia a
     WHERE NOT (a.intereses <@ ARRAY['clase_prueba', 'inscripcion', 'clinica', 'precio', 'horarios',
                                     'informacion', 'vacacional', 'campamento']::text[]);
    IF v_mal > 0 THEN
        RAISE EXCEPTION 'whatsapp_audiencia: % filas no cumplen la lista ampliada de intereses', v_mal;
    END IF;
END
$chk$;

ALTER TABLE public.whatsapp_audiencia DROP CONSTRAINT IF EXISTS whatsapp_audiencia_intereses_check;
ALTER TABLE public.whatsapp_audiencia
    ADD CONSTRAINT whatsapp_audiencia_intereses_check
    CHECK (intereses <@ ARRAY['clase_prueba', 'inscripcion', 'clinica', 'precio', 'horarios',
                              'informacion', 'vacacional', 'campamento']::text[]);

COMMIT;
