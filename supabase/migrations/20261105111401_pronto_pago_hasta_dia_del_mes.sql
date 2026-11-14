-- 20261105111401_pronto_pago_hasta_dia_del_mes.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05
-- Pronto pago «hasta el día N del mes» (Monster: 5 % hasta el día 5 de cada mes).
-- Hoy la ventana es solo «N días desde que se creó el cobro»: los cobros de una
-- misma escuela nacen en fechas distintas y vencen en fechas distintas.
-- · school_settings.early_payment_discount_mode: 'days_from_creation' (default,
--   comportamiento actual) | 'day_of_month' (early_payment_discount_days = día del
--   mes, 1-28, del mes en que se creó el cobro).
-- · Se reemplaza fn_payments_pronto_pago_servidor (misma lógica + el modo).
-- Debe coincidir con frontend/src/lib/earlyPaymentDiscount.ts.

BEGIN;

ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS early_payment_discount_mode text NOT NULL DEFAULT 'days_from_creation';
ALTER TABLE public.school_settings
    DROP CONSTRAINT IF EXISTS school_settings_early_payment_mode_check;
ALTER TABLE public.school_settings
    ADD CONSTRAINT school_settings_early_payment_mode_check
    CHECK (early_payment_discount_mode IN ('days_from_creation', 'day_of_month'));

CREATE OR REPLACE FUNCTION public.fn_payments_pronto_pago_servidor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_rol      text := COALESCE(auth.role(), '');
    v_pedido   numeric;
    v_enabled  boolean;
    v_days     integer;
    v_pct      numeric;
    v_base     timestamptz;
    v_impago   boolean := false;
    v_max      numeric := 0;
    v_final    numeric;
    v_modo     text;
    v_limite   date;
BEGIN
    -- Solo peticiones de cliente (PostgREST con JWT de usuario). service_role,
    -- crons, SQL editor y migraciones (sin claims) no se tocan.
    IF v_rol NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;

    -- Personal de la escuela del cobro: decide el pronto pago a mano
    -- (spec §15). Mismo criterio que fn_guard_payments_client.
    IF NEW.school_id IS NOT NULL
       AND NEW.school_id = ANY (public.user_staff_school_ids())
       AND (TG_OP = 'INSERT' OR OLD.school_id IS NOT DISTINCT FROM NEW.school_id) THEN
        RETURN NEW;
    END IF;

    -- created_at abre la ventana del pronto pago: el cliente no lo mueve.
    IF TG_OP = 'UPDATE' THEN
        NEW.created_at := OLD.created_at;
    ELSIF NEW.created_at IS NULL OR NEW.created_at > now() THEN
        NEW.created_at := now();
    END IF;

    -- Descuento por hermanos: solo lo estampa open_month (servidor).
    IF TG_OP = 'INSERT' AND COALESCE(NEW.sibling_discount_applied, 0) <> 0 THEN
        RAISE EXCEPTION 'PAYMENT_FIELD_LOCKED: sibling_discount_applied'
            USING ERRCODE = '42501',
                  HINT = 'El descuento por hermanos lo calcula el sistema.';
    END IF;

    v_pedido := NEW.early_payment_discount_applied;
    IF v_pedido IS NULL THEN
        RETURN NEW;
    END IF;
    -- El valor congelado que el front reenvía sin cambios no se recalcula
    -- (ya pasó por aquí cuando se escribió).
    IF TG_OP = 'UPDATE' AND v_pedido IS NOT DISTINCT FROM OLD.early_payment_discount_applied THEN
        RETURN NEW;
    END IF;

    -- ── Tope calculado por el servidor (= lib/earlyPaymentDiscount.ts) ──────
    IF v_pedido > 0
       AND COALESCE(NEW.amount, 0) > 0
       AND (NEW.payment_category IS NULL OR NEW.payment_category = 'mensualidad') THEN
        SELECT ss.early_payment_discount_enabled,
               COALESCE(NULLIF(ss.early_payment_discount_days, 0), 5),
               COALESCE(ss.early_payment_discount_percentage, 0),
               COALESCE(ss.early_payment_discount_mode, 'days_from_creation')
          INTO v_enabled, v_days, v_pct, v_modo
          FROM public.school_settings ss
         WHERE ss.school_id = NEW.school_id;

        IF COALESCE(v_enabled, false) AND v_pct > 0 THEN
            v_base := CASE WHEN TG_OP = 'INSERT' THEN now() ELSE OLD.created_at END;

            -- Modo 'day_of_month': v_days es el día del mes (1-28) del mes en que se
            -- creó el cobro; si no, v_days días desde la creación.
            IF v_modo = 'day_of_month' THEN
                v_limite := date_trunc('month', v_base AT TIME ZONE 'America/Bogota')::date
                            + (LEAST(GREATEST(v_days, 1), 28) - 1);
            ELSE
                v_limite := (v_base AT TIME ZONE 'America/Bogota')::date + v_days;
            END IF;

            IF (now() AT TIME ZONE 'America/Bogota')::date <= v_limite THEN

                IF NEW.child_id IS NOT NULL THEN
                    SELECT EXISTS (
                        SELECT 1 FROM public.payments p
                         WHERE p.school_id = NEW.school_id
                           AND p.child_id = NEW.child_id
                           AND p.status IN ('pending', 'overdue', 'partial')
                           AND p.created_at < v_base
                           AND p.id IS DISTINCT FROM NEW.id
                    ) INTO v_impago;
                ELSIF NEW.parent_id IS NOT NULL THEN
                    SELECT EXISTS (
                        SELECT 1 FROM public.payments p
                         WHERE p.school_id = NEW.school_id
                           AND p.parent_id = NEW.parent_id
                           AND p.status IN ('pending', 'overdue', 'partial')
                           AND p.created_at < v_base
                           AND p.id IS DISTINCT FROM NEW.id
                    ) INTO v_impago;
                END IF;

                IF NOT v_impago THEN
                    v_max := round(NEW.amount * v_pct / 100);
                END IF;
            END IF;
        END IF;
    END IF;

    v_final := LEAST(GREATEST(v_pedido, 0), v_max);
    NEW.early_payment_discount_applied := CASE WHEN v_final > 0 THEN v_final ELSE NULL END;

    RETURN NEW;
END;
$function$;

COMMIT;
