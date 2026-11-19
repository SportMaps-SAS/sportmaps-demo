-- =============================================================================
-- 20261119141319_mora_nace_en_cobro_manual.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19
-- Objetivo: la mora nace YA SUMADA en la mensualidad que se crea a mano desde
--   «Cobros y pagos» (create_charge_batch / preview_charge_batch).
--
-- PROBLEMA. Las líneas nuevas del lote nacían con 'late' = 0: el recargo solo lo
--   sumaba el job nocturno apply_late_fees, y ese job exige además que haya pasado
--   la gracia desde que el cobro EXISTE (fix H-01, 20261005135525). Resultado: una
--   mensualidad creada a mano con vencimiento ya vencido salía sin mora, no se veía
--   ni se podía condonar en el modal, y llegaba días después.
--
-- REGLA (la misma de apply_late_fees, SIN la espera desde la creación):
--   · solo categoría mensualidad (inscripción, seguro y demás únicos no llevan mora);
--   · la escuela tiene late_fee_enabled y due_date + payment_grace_days < hoy (Bogotá);
--   · recargo = round(late_fee_percentage/100 × valor sin recargo);
--   · NO se suma cuando la línea se registra ya pagada («Ya lo pagaron»): es un
--     registro de algo que ocurrió, no una deuda que corre.
--   · el cobro sigue 'pending' (nace con recargo pero NO vencido): marcarlo 'overdue'
--     activa torniquete y auto-bloqueo, y eso lo sigue decidiendo apply_late_fees.
--   · se estampa late_fee_applied_at = now(): apply_late_fees no vuelve a cobrarlo.
--
-- CÓMO. _mora_al_crear(...) es el cálculo único. Se parchea por texto, con
--   pg_get_functiondef y con aserción de UNA coincidencia, el planificador
--   (_plan_charge_operation: 'late', 'late_initial', 'amount') y el INSERT de
--   create_charge_batch (amount + late_fee_amount + late_fee_applied_at). Si la
--   función viva difiere del repo, la migración ABORTA en vez de adivinar.
--   'late_initial' es el recargo de nacimiento: 'late' puede bajar después por
--   condonación y el INSERT debe partir del original (la condonación se aplica
--   después del INSERT, igual que los demás ajustes del modal).
--
-- ACL: CREATE OR REPLACE conserva los GRANT de las dos funciones parchadas.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public._mora_al_crear(
    p_school_id   uuid,
    p_is_mens     boolean,
    p_will_create boolean,
    p_due         date,
    p_base        numeric,
    p_con_pago    boolean)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT COALESCE((
        SELECT round(COALESCE(ss.late_fee_percentage, 0)::numeric / 100 * GREATEST(COALESCE(p_base, 0), 0))
          FROM public.school_settings ss
         WHERE ss.school_id = p_school_id
           AND ss.late_fee_enabled IS TRUE
           AND COALESCE(p_is_mens, false)
           AND COALESCE(p_will_create, false)
           AND NOT COALESCE(p_con_pago, false)
           AND p_due IS NOT NULL
           AND p_due + COALESCE(ss.payment_grace_days, 0) < (now() AT TIME ZONE 'America/Bogota')::date
    ), 0);
$function$;

REVOKE ALL ON FUNCTION public._mora_al_crear(uuid, boolean, boolean, date, numeric, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._mora_al_crear(uuid, boolean, boolean, date, numeric, boolean)
    TO service_role;

-- ── Parche 1: el planificador (preview y create comparten este cálculo) ───────
DO $patch1$
DECLARE
    v_oid oid;
    v_def text;
    v_new text;
    v_pat text := $re$'late',\s*0,\s*'waived',\s*0,\s*'amount',\s*COALESCE\(v_list,\s*0\)\s*-\s*v_mil\s*-\s*v_sib,$re$;
    v_rep text := $rp$'late', public._mora_al_crear(p_school_id, v_is_mens, v_skip IS NULL, v_due, COALESCE(v_list, 0) - v_mil - v_sib, p_payment IS NOT NULL),
                'late_initial', public._mora_al_crear(p_school_id, v_is_mens, v_skip IS NULL, v_due, COALESCE(v_list, 0) - v_mil - v_sib, p_payment IS NOT NULL),
                'waived', 0,
                'amount', COALESCE(v_list, 0) - v_mil - v_sib
                          + public._mora_al_crear(p_school_id, v_is_mens, v_skip IS NULL, v_due, COALESCE(v_list, 0) - v_mil - v_sib, p_payment IS NOT NULL),$rp$;
BEGIN
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_plan_charge_operation';
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'MORA_AL_CREAR: no existe _plan_charge_operation';
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%_mora_al_crear%' THEN
        RAISE NOTICE 'parche 1 ya aplicado';
        RETURN;
    END IF;
    IF regexp_count(v_def, v_pat) <> 1 THEN
        RAISE EXCEPTION 'MORA_AL_CREAR: _plan_charge_operation viva difiere del repo (coincidencias: %)', regexp_count(v_def, v_pat);
    END IF;
    v_new := regexp_replace(v_def, v_pat, v_rep);
    EXECUTE v_new;
END
$patch1$;

-- ── Parche 2: el INSERT de create_charge_batch ───────────────────────────────
DO $patch2$
DECLARE
    v_oid oid;
    v_def text;
    v_new text;
    p1 text := $re$list_amount,\s*discount_amount,\s*sibling_discount_applied,\s*created_by,\s*notes,\s*charge_batch_id\)$re$;
    r1 text := $rp$list_amount, discount_amount, sibling_discount_applied, created_by, notes, charge_batch_id,
        late_fee_amount, late_fee_applied_at)$rp$;
    p2 text := $re$\(x->>'list'\)::numeric\s*-\s*COALESCE\(\(x->>'auto_disc'\)::numeric,\s*0\),\s*x->>'concept'$re$;
    r2 text := $rp$(x->>'list')::numeric - COALESCE((x->>'auto_disc')::numeric, 0)
                + COALESCE((x->>'late_initial')::numeric, 0),
           x->>'concept'$rp$;
    p3 text := $re$p_actor,\s*x->>'notes',\s*v_batch_id\s*FROM jsonb_array_elements\(v_items\) x$re$;
    r3 text := $rp$p_actor, x->>'notes', v_batch_id,
           COALESCE((x->>'late_initial')::numeric, 0),
           CASE WHEN COALESCE((x->>'late_initial')::numeric, 0) > 0 THEN now() END
      FROM jsonb_array_elements(v_items) x$rp$;
BEGIN
    SELECT p.oid INTO v_oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'create_charge_batch';
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'MORA_AL_CREAR: no existe create_charge_batch';
    END IF;
    v_def := pg_get_functiondef(v_oid);
    IF v_def LIKE '%late_initial%' THEN
        RAISE NOTICE 'parche 2 ya aplicado';
        RETURN;
    END IF;
    IF regexp_count(v_def, p1) <> 1 OR regexp_count(v_def, p2) <> 1 OR regexp_count(v_def, p3) <> 1 THEN
        RAISE EXCEPTION 'MORA_AL_CREAR: create_charge_batch viva difiere del repo (coincidencias: %, %, %)',
            regexp_count(v_def, p1), regexp_count(v_def, p2), regexp_count(v_def, p3);
    END IF;
    v_new := regexp_replace(regexp_replace(regexp_replace(v_def, p1, r1), p2, r2), p3, r3);
    EXECUTE v_new;
END
$patch2$;

COMMIT;
