-- =============================================================================
-- 20261125140410_veredicto_comprobante_solo_servidor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-25   Versión anterior: 20261010144558
-- Spec: docs/specs/seguridad-veredicto-comprobante-plan.md §4 (decisiones D2, D3, D10)
-- Objetivo: la lectura del comprobante (ocr_*), su veredicto (receipt_verdict*),
--   su huella (receipt_image_sha256*, receipt_reference_norm) y el valor que
--   confirmó la escuela (receipt_amount_confirmed*) solo los escriben el servidor
--   (service_role / RPC SECURITY DEFINER) y la administración de la escuela
--   (user_admin_school_ids()). Para cualquier otro cliente del navegador
--   (acudiente, atleta adulto, coach — D2) se IGNORA lo que mande — sin error,
--   para no romper la subida desde la PWA vieja:
--     · INSERT                        → NULL
--     · UPDATE que cambia receipt_url → NULL en la lectura (el BFF vuelve a leer
--                                        el archivo nuevo en /sellar-comprobante);
--                                        el valor confirmado conserva OLD
--     · UPDATE sin cambiar el archivo → OLD
--   D10: el mismo cliente solo puede poner en receipt_url un archivo de SU carpeta
--   de payment-receipts ({auth.uid()}/…, como lo deja useStorage). Si no, se
--   conserva OLD (UPDATE) o NULL (INSERT). Cierra la lectura de comprobantes
--   ajenos por la policy de storage «Parents can view own payment receipts via
--   DB» (receipt_url = objects.name) y, para el coach, «School staff can read
--   payment receipts».
--   CREATE OR REPLACE desde el cuerpo VIVO (pg_get_functiondef, 2026-11-25,
--   idéntico a 20261010144558). Cambios marcados «(veredicto servidor)».
-- Radio (base viva 2026-11-25, solo lectura):
--   · Escritores no-admin desde el navegador: ParentCheckoutPage y
--     PaymentCheckoutModal (cero columnas de lectura después del deploy del
--     frontend del plan; la PWA vieja las sigue mandando y se ignoran).
--   · Escritores admin (siguen): RegisterCashPaymentModal (directo y RPC),
--     approvePayment (receipt_amount_confirmed*), create_charge_batch (BFF).
--     Servidor (siguen): estamparComprobante / sellado, receipt-approval,
--     reject_payment_receipt, fn_payments_huella_pasa_al_anular,
--     wa_cubrir_cobros_con_comprobante.
--   · D10, últimos 30 días: todo receipt_url fuera de la carpeta del
--     acudiente/atleta del cobro es de la carpeta de la escuela (bot/servidor:
--     27 por validar, 255 pagados…) o de un admin (67 pagados). Ninguno de un
--     acudiente, atleta o coach fuera de su carpeta.
--   · No modifica filas existentes. No toca policies ni columnas ni el trigger.
--   · Sin cambio de esquema: no se regenera types.ts.
-- Precondición: BFF con /sellar-comprobante desplegado (si no, las subidas
--   nuevas de la app quedan sin lectura ni veredicto hasta que el BFF exista —
--   ver §5 del spec).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_guard_payments_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_open_states text[] := ARRAY['pending','overdue','partial','rejected','failed','awaiting_approval'];
    v_col text;
    v_admin boolean := false;        -- (veredicto servidor)
    v_archivo_nuevo boolean;         -- (veredicto servidor)
    v_carpeta text;                  -- (veredicto servidor) D10
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- (cobros F1) Columnas que solo escriben las RPC de «Cobros y pagos», para
    -- TODO cliente del navegador (staff incluido).
    IF TG_OP = 'INSERT' THEN
        v_col := CASE
            WHEN NEW.charge_batch_id IS NOT NULL               THEN 'charge_batch_id'
            WHEN COALESCE(NEW.discount_amount, 0) <> 0         THEN 'discount_amount'
            WHEN COALESCE(NEW.late_fee_waived_amount, 0) <> 0  THEN 'late_fee_waived_amount'
            WHEN NEW.list_amount IS NOT NULL                   THEN 'list_amount'
        END;
    ELSE
        v_col := CASE
            WHEN NEW.charge_batch_id        IS DISTINCT FROM OLD.charge_batch_id        THEN 'charge_batch_id'
            WHEN NEW.discount_amount        IS DISTINCT FROM OLD.discount_amount        THEN 'discount_amount'
            WHEN NEW.late_fee_waived_amount IS DISTINCT FROM OLD.late_fee_waived_amount THEN 'late_fee_waived_amount'
            WHEN NEW.list_amount            IS DISTINCT FROM OLD.list_amount            THEN 'list_amount'
        END;
    END IF;
    IF v_col IS NOT NULL THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501',
            HINT = 'Descuentos, condonaciones y lotes solo se registran desde «Cobros y pagos».';
    END IF;

    -- (veredicto servidor) Lectura, veredicto y huella del comprobante: solo el
    -- servidor o la administración de la escuela. Al resto se le IGNORA (no se
    -- lanza error: la PWA instalada vieja sigue mandando estos campos al subir).
    -- Va ANTES del atajo de staff: un coach (staff sin administración) también
    -- cae aquí (D2). user_admin_school_ids() no tiene EXECUTE para anon: solo se
    -- consulta con sesión.
    IF current_user = 'authenticated' AND NEW.school_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR OLD.school_id IS NOT DISTINCT FROM NEW.school_id) THEN
        v_admin := NEW.school_id = ANY (public.user_admin_school_ids());
    END IF;

    IF NOT v_admin THEN
        -- (veredicto servidor) D10: el archivo tiene que ser de la carpeta de
        -- quien escribe ({uid}/…, useStorage). Va primero: un receipt_url ajeno
        -- ignorado no cuenta como «archivo nuevo» abajo.
        v_carpeta := auth.uid()::text || '/';
        IF TG_OP = 'INSERT' THEN
            IF NEW.receipt_url IS NOT NULL
               AND NOT (v_carpeta IS NOT NULL
                        AND starts_with(NEW.receipt_url, v_carpeta)
                        AND strpos(NEW.receipt_url, '..') = 0) THEN
                NEW.receipt_url := NULL;
            END IF;
        ELSIF NEW.receipt_url IS DISTINCT FROM OLD.receipt_url
              AND NOT (v_carpeta IS NOT NULL
                       AND NEW.receipt_url IS NOT NULL
                       AND starts_with(NEW.receipt_url, v_carpeta)
                       AND strpos(NEW.receipt_url, '..') = 0) THEN
            NEW.receipt_url := OLD.receipt_url;
        END IF;

        IF TG_OP = 'INSERT' THEN
            v_archivo_nuevo := true;
        ELSE
            v_archivo_nuevo := NEW.receipt_url IS DISTINCT FROM OLD.receipt_url;
        END IF;

        IF v_archivo_nuevo THEN
            -- Archivo nuevo (o cobro nuevo): nada de lo que diga el navegador
            -- cuenta; el BFF lo lee del archivo guardado (/sellar-comprobante).
            NEW.ocr_amount                  := NULL;
            NEW.ocr_currency                := NULL;
            NEW.ocr_date                    := NULL;
            NEW.ocr_bank                    := NULL;
            NEW.ocr_reference               := NULL;
            NEW.ocr_provider                := NULL;
            NEW.ocr_destination             := NULL;
            NEW.ocr_destination_name        := NULL;
            NEW.ocr_origin_name             := NULL;
            NEW.ocr_time                    := NULL;
            NEW.ocr_raw_response            := NULL;
            NEW.receipt_verdict             := NULL;
            NEW.receipt_verdict_reasons     := NULL;
            NEW.receipt_verdict_at          := NULL;
            NEW.receipt_reference_norm      := NULL;
            NEW.receipt_image_sha256        := NULL;
            NEW.receipt_image_sha256_source := NULL;
        ELSE
            NEW.ocr_amount                  := OLD.ocr_amount;
            NEW.ocr_currency                := OLD.ocr_currency;
            NEW.ocr_date                    := OLD.ocr_date;
            NEW.ocr_bank                    := OLD.ocr_bank;
            NEW.ocr_reference               := OLD.ocr_reference;
            NEW.ocr_provider                := OLD.ocr_provider;
            NEW.ocr_destination             := OLD.ocr_destination;
            NEW.ocr_destination_name        := OLD.ocr_destination_name;
            NEW.ocr_origin_name             := OLD.ocr_origin_name;
            NEW.ocr_time                    := OLD.ocr_time;
            NEW.ocr_raw_response            := OLD.ocr_raw_response;
            NEW.receipt_verdict             := OLD.receipt_verdict;
            NEW.receipt_verdict_reasons     := OLD.receipt_verdict_reasons;
            NEW.receipt_verdict_at          := OLD.receipt_verdict_at;
            NEW.receipt_reference_norm      := OLD.receipt_reference_norm;
            NEW.receipt_image_sha256        := OLD.receipt_image_sha256;
            NEW.receipt_image_sha256_source := OLD.receipt_image_sha256_source;
        END IF;

        -- (veredicto servidor) D3: el valor que la ESCUELA confirmó al aprobar
        -- (approvePayment.ts).
        IF TG_OP = 'INSERT' THEN
            NEW.receipt_amount_confirmed     := NULL;
            NEW.receipt_amount_confirmed_by  := NULL;
            NEW.receipt_amount_confirmed_at  := NULL;
            NEW.receipt_amount_change_reason := NULL;
        ELSE
            NEW.receipt_amount_confirmed     := OLD.receipt_amount_confirmed;
            NEW.receipt_amount_confirmed_by  := OLD.receipt_amount_confirmed_by;
            NEW.receipt_amount_confirmed_at  := OLD.receipt_amount_confirmed_at;
            NEW.receipt_amount_change_reason := OLD.receipt_amount_change_reason;
        END IF;
    END IF;

    IF NEW.school_id IS NOT NULL
       AND NEW.school_id = ANY (public.user_staff_school_ids())
       AND (TG_OP = 'INSERT' OR OLD.school_id IS NOT DISTINCT FROM NEW.school_id) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.school_id IS NULL
           OR NOT (
                NEW.school_id = ANY (public.user_school_ids())
                OR EXISTS (SELECT 1 FROM public.children c
                            WHERE c.parent_id = auth.uid() AND c.school_id = NEW.school_id)
           ) THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: school_id' USING ERRCODE = '42501',
                HINT = 'Solo puedes registrar pagos en una escuela de la que eres miembro.';
        END IF;
        IF NEW.status NOT IN ('pending', 'awaiting_approval') THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status'
                USING ERRCODE = '42501',
                      HINT = 'Solo la escuela o la pasarela marcan un pago como pagado.';
        END IF;

        v_col := CASE
            WHEN COALESCE(NEW.amount_paid, 0) <> 0      THEN 'amount_paid'
            WHEN NEW.approved_at IS NOT NULL            THEN 'approved_at'
            WHEN NEW.approved_by IS NOT NULL            THEN 'approved_by'
            WHEN COALESCE(NEW.late_fee_amount, 0) <> 0  THEN 'late_fee_amount'
            WHEN NEW.late_fee_applied_at IS NOT NULL    THEN 'late_fee_applied_at'
            WHEN NEW.gross_amount IS NOT NULL           THEN 'gross_amount'
            WHEN NEW.sportmaps_fee IS NOT NULL          THEN 'sportmaps_fee'
            WHEN NEW.epayco_fee IS NOT NULL             THEN 'epayco_fee'
            WHEN NEW.wompi_transaction_id IS NOT NULL   THEN 'wompi_transaction_id'
            WHEN NEW.provider_transaction_id IS NOT NULL THEN 'provider_transaction_id'
            WHEN NEW.cash_session_id IS NOT NULL        THEN 'cash_session_id'
            WHEN NEW.reconciliation_status IS NOT NULL  THEN 'reconciliation_status'
            WHEN NEW.unblocked_at IS NOT NULL           THEN 'unblocked_at'
            WHEN NEW.unblocked_by IS NOT NULL           THEN 'unblocked_by'
            WHEN NEW.discount_pct IS NOT NULL           THEN 'discount_pct'
            WHEN NEW.list_amount IS NOT NULL            THEN 'list_amount'
            -- (cobros F1)
            WHEN COALESCE(NEW.sibling_discount_applied, 0) <> 0 THEN 'sibling_discount_applied'
            WHEN NEW.created_by IS NOT NULL             THEN 'created_by'
            WHEN NEW.notes IS NOT NULL                  THEN 'notes'
        END;
        IF v_col IS NOT NULL THEN
            RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IN ('paid', 'glosado', 'cancelled')
       AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status (cobro %)', OLD.status USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = 'awaiting_approval' AND OLD.status = ANY (v_open_states)) THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: status (% -> %)', OLD.status, NEW.status
            USING ERRCODE = '42501';
    END IF;

    v_col := CASE
        WHEN NEW.amount                   IS DISTINCT FROM OLD.amount                   THEN 'amount'
        WHEN NEW.amount_paid              IS DISTINCT FROM OLD.amount_paid              THEN 'amount_paid'
        WHEN NEW.school_id                IS DISTINCT FROM OLD.school_id                THEN 'school_id'
        WHEN NEW.branch_id                IS DISTINCT FROM OLD.branch_id                THEN 'branch_id'
        WHEN NEW.offering_plan_id         IS DISTINCT FROM OLD.offering_plan_id         THEN 'offering_plan_id'
        WHEN NEW.team_id                  IS DISTINCT FROM OLD.team_id                  THEN 'team_id'
        WHEN NEW.child_id                 IS DISTINCT FROM OLD.child_id                 THEN 'child_id'
        WHEN NEW.parent_id                IS DISTINCT FROM OLD.parent_id                THEN 'parent_id'
        WHEN NEW.user_id                  IS DISTINCT FROM OLD.user_id                  THEN 'user_id'
        WHEN NEW.unregistered_athlete_id  IS DISTINCT FROM OLD.unregistered_athlete_id  THEN 'unregistered_athlete_id'
        WHEN NEW.coach_id                 IS DISTINCT FROM OLD.coach_id                 THEN 'coach_id'
        WHEN NEW.late_fee_amount          IS DISTINCT FROM OLD.late_fee_amount          THEN 'late_fee_amount'
        WHEN NEW.late_fee_applied_at      IS DISTINCT FROM OLD.late_fee_applied_at      THEN 'late_fee_applied_at'
        WHEN NEW.approved_at              IS DISTINCT FROM OLD.approved_at              THEN 'approved_at'
        WHEN NEW.approved_by              IS DISTINCT FROM OLD.approved_by              THEN 'approved_by'
        WHEN NEW.rejection_reason         IS DISTINCT FROM OLD.rejection_reason         THEN 'rejection_reason'
        WHEN NEW.gross_amount             IS DISTINCT FROM OLD.gross_amount             THEN 'gross_amount'
        WHEN NEW.sportmaps_fee            IS DISTINCT FROM OLD.sportmaps_fee            THEN 'sportmaps_fee'
        WHEN NEW.epayco_fee               IS DISTINCT FROM OLD.epayco_fee               THEN 'epayco_fee'
        WHEN NEW.payment_category         IS DISTINCT FROM OLD.payment_category         THEN 'payment_category'
        WHEN NEW.period_uniqueness_exempt IS DISTINCT FROM OLD.period_uniqueness_exempt THEN 'period_uniqueness_exempt'
        WHEN NEW.sibling_discount_applied IS DISTINCT FROM OLD.sibling_discount_applied THEN 'sibling_discount_applied'
        WHEN NEW.discount_pct             IS DISTINCT FROM OLD.discount_pct             THEN 'discount_pct'
        WHEN NEW.list_amount              IS DISTINCT FROM OLD.list_amount              THEN 'list_amount'
        WHEN NEW.due_date                 IS DISTINCT FROM OLD.due_date                 THEN 'due_date'
        WHEN NEW.concept                  IS DISTINCT FROM OLD.concept                  THEN 'concept'
        WHEN NEW.payment_type             IS DISTINCT FROM OLD.payment_type             THEN 'payment_type'
        WHEN NEW.provider_transaction_id  IS DISTINCT FROM OLD.provider_transaction_id  THEN 'provider_transaction_id'
        WHEN NEW.wompi_transaction_id     IS DISTINCT FROM OLD.wompi_transaction_id     THEN 'wompi_transaction_id'
        WHEN NEW.wompi_id                 IS DISTINCT FROM OLD.wompi_id                 THEN 'wompi_id'
        WHEN NEW.cash_session_id          IS DISTINCT FROM OLD.cash_session_id          THEN 'cash_session_id'
        WHEN NEW.reconciliation_status    IS DISTINCT FROM OLD.reconciliation_status    THEN 'reconciliation_status'
        WHEN NEW.requires_review          IS DISTINCT FROM OLD.requires_review          THEN 'requires_review'
        WHEN NEW.unblocked_at             IS DISTINCT FROM OLD.unblocked_at             THEN 'unblocked_at'
        WHEN NEW.unblocked_by             IS DISTINCT FROM OLD.unblocked_by             THEN 'unblocked_by'
        -- (cobros F1)
        WHEN NEW.created_by               IS DISTINCT FROM OLD.created_by               THEN 'created_by'
        WHEN NEW.notes                    IS DISTINCT FROM OLD.notes                    THEN 'notes'
        WHEN OLD.period_year  IS NOT NULL AND NEW.period_year  IS DISTINCT FROM OLD.period_year  THEN 'period_year'
        WHEN OLD.period_month IS NOT NULL AND NEW.period_month IS DISTINCT FROM OLD.period_month THEN 'period_month'
        WHEN NEW.status <> 'awaiting_approval'
             AND NEW.payment_date IS DISTINCT FROM OLD.payment_date THEN 'payment_date'
        WHEN NEW.status <> 'awaiting_approval'
             AND NEW.early_payment_discount_applied IS DISTINCT FROM OLD.early_payment_discount_applied
             THEN 'early_payment_discount_applied'
    END;
    IF v_col IS NOT NULL THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: %', v_col USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

-- Privilegios vivos: {postgres=X, service_role=X} (CREATE OR REPLACE los
-- conserva; se re-emiten por claridad). Una función trigger no necesita EXECUTE
-- para el rol que dispara el trigger (las familias escriben hoy con este ACL).
REVOKE ALL ON FUNCTION public.fn_guard_payments_client() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_guard_payments_client() TO service_role;

COMMIT;

-- Verificación (solo lectura, después de aplicar):
--   select prosrc ilike '%veredicto servidor%', proacl from pg_proc where proname = 'fn_guard_payments_client';
--   select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_zz_guard_payments_client';
--   npm run seguridad:invariantes
