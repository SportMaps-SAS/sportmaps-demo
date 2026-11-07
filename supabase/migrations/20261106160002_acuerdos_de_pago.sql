-- ============================================================================
-- 20261106160002 · Acuerdos de pago (pago por plazos) — F4 de
-- docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md (§5, D9)
-- ============================================================================
-- Un ACUERDO DE PAGO es un compromiso de FECHAS Y MONTOS sobre uno o más cobros
-- abiertos de un pagador. NO mueve dinero y NO crea cobros: el dinero entra por
-- los abonos / cobros parciales que ya existen (payments.amount_paid, estado
-- 'partial'). Esta migración NO inserta ni actualiza `payments` (hay 13 caminos
-- que lo hacen; este no es el 14). El acuerdo solo:
--   · registra el calendario (cuotas con fecha y monto),
--   · marca cada cuota 'pagado' cuando los abonos de los cobros cubiertos la
--     alcanzan (mark_agreement_items_from_payments),
--   · pasa a 'incumplido' si una cuota vence sin pago (expire_agreements),
--   · hace que apply_late_fees NO recargue esos cobros mientras el acuerdo esté
--     'activo' y al día.
--
-- Apagado por defecto: school_settings.payment_agreements_enabled = false.
-- Topes por escuela (D9, configurables): agreement_max_installments (3),
-- agreement_max_days (60), agreement_auto_approve (true). Dentro de los topes y
-- con auto-aprobación → 'activo'; fuera → 'solicitado' (la administración decide).
--
-- ── CAMBIO A apply_late_fees (mora) ─────────────────────────────────────────
-- Se leyó la definición VIVA (pg_proc, solo lectura, 2026-11-06) y se reemplaza
-- con CREATE OR REPLACE conservando TODO lo demás. Cambios mínimos y marcados
-- con «-- (acuerdos)»:
--   1. Al inicio: si hay algún acuerdo 'activo', se sincronizan las cuotas
--      pagadas (fn_agreements_mark_paid) para no recargar a quien ya abonó.
--   2. En ambos bloques (rejected y pending/partial) el LATERAL `x` calcula
--      `agr` = el cobro está en un acuerdo 'activo' y al día (sin cuota
--      pendiente con fecha < hoy). Con `agr` el recargo (fee) es 0, y en el
--      bloque pending/partial un parcial con acuerdo no se reescribe cada noche.
--   El cobro igual pasa a 'overdue' si le toca (solo se omite el RECARGO); por
--   eso `late_fee_applied_at` queda NULL y, si el acuerdo se incumple, la mora
--   retoma desde la fecha original (el recargo se calcula sobre el saldo).
-- Con la función apagada o SIN acuerdos el comportamiento es IDÉNTICO al actual:
-- el EXISTS sobre una tabla vacía da false y el PERFORM inicial no corre.
-- Conserva owner, SECURITY DEFINER, search_path y grants (CREATE OR REPLACE).
--
-- Reglas de CLAUDE.md: search_path fijo en toda función, GRANT EXECUTE explícito
-- por RPC, sin EXECUTE para anon, estados text + CHECK, RLS por comando sin
-- self-recursion, escritura de la administración con user_admin_school_ids().
-- ============================================================================

-- ── 1. Topes por escuela ────────────────────────────────────────────────────
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS payment_agreements_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agreement_max_installments integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS agreement_max_days integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS agreement_auto_approve boolean NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_settings_agreement_caps_check'
                   AND conrelid = 'public.school_settings'::regclass) THEN
    ALTER TABLE public.school_settings
      ADD CONSTRAINT school_settings_agreement_caps_check
      CHECK (agreement_max_installments BETWEEN 1 AND 12 AND agreement_max_days BETWEEN 1 AND 365);
  END IF;
END $$;

-- ── 2. Tablas ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_agreements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  requested_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,  -- NULL: lo pidió el bot/servicio
  payer_profile_id  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'solicitado'
                    CHECK (status IN ('solicitado','activo','cumplido','incumplido','rechazado','cancelado')),
  source            text NOT NULL DEFAULT 'app' CHECK (source IN ('whatsapp','app','admin')),
  installments      integer NOT NULL CHECK (installments BETWEEN 1 AND 12),
  total_amount      numeric NOT NULL CHECK (total_amount > 0),   -- saldo cubierto al solicitar
  first_due_date    date NOT NULL,
  last_due_date     date NOT NULL,
  auto_approved     boolean NOT NULL DEFAULT false,
  approved_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  resolution_note   text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Cobros que cubre el acuerdo. `live` = el acuerdo sigue vivo (solicitado/activo):
-- el índice parcial único impide que un cobro esté en dos acuerdos vivos.
CREATE TABLE IF NOT EXISTS public.payment_agreement_payments (
  agreement_id      uuid NOT NULL REFERENCES public.payment_agreements(id) ON DELETE CASCADE,
  payment_id        uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  school_id         uuid NOT NULL,                 -- denormalizado: RLS sin joins
  payer_profile_id  uuid,                          -- denormalizado: RLS sin joins
  balance_at_request numeric NOT NULL CHECK (balance_at_request > 0),
  paid_at_request   numeric NOT NULL DEFAULT 0 CHECK (paid_at_request >= 0),  -- abonado efectivo al solicitar
  live              boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, payment_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_agreement_payments_live_uq
  ON public.payment_agreement_payments (payment_id) WHERE live;

CREATE TABLE IF NOT EXISTS public.payment_agreement_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id      uuid NOT NULL REFERENCES public.payment_agreements(id) ON DELETE CASCADE,
  school_id         uuid NOT NULL,                 -- denormalizado: RLS sin joins
  payer_profile_id  uuid,                          -- denormalizado: RLS sin joins
  payment_id        uuid REFERENCES public.payments(id) ON DELETE SET NULL,  -- solo si el acuerdo cubre UN cobro
  seq               integer NOT NULL CHECK (seq >= 1),
  due_date          date NOT NULL,
  amount            numeric NOT NULL CHECK (amount > 0),
  status            text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','pagado','vencido')),
  paid_at           timestamptz,
  reminded_at       timestamptz,                   -- reclamo del job de recordatorios (idempotente entre BFF)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, seq)
);

CREATE INDEX IF NOT EXISTS payment_agreements_school_status_idx ON public.payment_agreements (school_id, status);
CREATE INDEX IF NOT EXISTS payment_agreements_payer_idx ON public.payment_agreements (payer_profile_id);
CREATE INDEX IF NOT EXISTS payment_agreements_requested_by_idx ON public.payment_agreements (requested_by);
CREATE INDEX IF NOT EXISTS payment_agreement_payments_agreement_idx ON public.payment_agreement_payments (agreement_id);
CREATE INDEX IF NOT EXISTS payment_agreement_items_due_idx
  ON public.payment_agreement_items (due_date) WHERE status = 'pendiente';
CREATE INDEX IF NOT EXISTS payment_agreement_items_school_due_idx
  ON public.payment_agreement_items (school_id, due_date) WHERE status = 'pendiente';

-- ── 3. RLS por comando (sin anon; sin self-recursion: nada consulta su propia tabla) ──
ALTER TABLE public.payment_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_agreement_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_agreement_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.payment_agreements, public.payment_agreement_payments, public.payment_agreement_items
  FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.payment_agreements, public.payment_agreement_payments,
  public.payment_agreement_items TO authenticated;
-- DELETE: nadie (el historial del acuerdo no se borra desde el cliente).

-- payment_agreements
DROP POLICY IF EXISTS payment_agreements_select_payer ON public.payment_agreements;
CREATE POLICY payment_agreements_select_payer ON public.payment_agreements
  FOR SELECT TO authenticated
  USING (payer_profile_id = (SELECT auth.uid()) OR requested_by = (SELECT auth.uid()));

DROP POLICY IF EXISTS payment_agreements_select_staff ON public.payment_agreements;
CREATE POLICY payment_agreements_select_staff ON public.payment_agreements
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreements_insert_admin ON public.payment_agreements;
CREATE POLICY payment_agreements_insert_admin ON public.payment_agreements
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreements_update_admin ON public.payment_agreements;
CREATE POLICY payment_agreements_update_admin ON public.payment_agreements
  FOR UPDATE TO authenticated
  USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- payment_agreement_payments
DROP POLICY IF EXISTS payment_agreement_payments_select_payer ON public.payment_agreement_payments;
CREATE POLICY payment_agreement_payments_select_payer ON public.payment_agreement_payments
  FOR SELECT TO authenticated USING (payer_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS payment_agreement_payments_select_staff ON public.payment_agreement_payments;
CREATE POLICY payment_agreement_payments_select_staff ON public.payment_agreement_payments
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreement_payments_insert_admin ON public.payment_agreement_payments;
CREATE POLICY payment_agreement_payments_insert_admin ON public.payment_agreement_payments
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreement_payments_update_admin ON public.payment_agreement_payments;
CREATE POLICY payment_agreement_payments_update_admin ON public.payment_agreement_payments
  FOR UPDATE TO authenticated
  USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- payment_agreement_items
DROP POLICY IF EXISTS payment_agreement_items_select_payer ON public.payment_agreement_items;
CREATE POLICY payment_agreement_items_select_payer ON public.payment_agreement_items
  FOR SELECT TO authenticated USING (payer_profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS payment_agreement_items_select_staff ON public.payment_agreement_items;
CREATE POLICY payment_agreement_items_select_staff ON public.payment_agreement_items
  FOR SELECT TO authenticated
  USING (school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreement_items_insert_admin ON public.payment_agreement_items;
CREATE POLICY payment_agreement_items_insert_admin ON public.payment_agreement_items
  FOR INSERT TO authenticated
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS payment_agreement_items_update_admin ON public.payment_agreement_items;
CREATE POLICY payment_agreement_items_update_admin ON public.payment_agreement_items
  FOR UPDATE TO authenticated
  USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]))
  WITH CHECK (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

-- ── 4. Helper interno: sincroniza cuotas pagadas (solo lo ejecuta el dueño) ──
-- Cumulativo: la cuota k queda 'pagado' cuando lo abonado DESDE el acuerdo en los
-- cobros cubiertos alcanza la suma de las cuotas 1..k. Lectura en lote (sin N+1).
CREATE OR REPLACE FUNCTION public.fn_agreements_mark_paid(
  p_school_id uuid DEFAULT NULL,
  p_agreement_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_items integer := 0;
  v_done integer := 0;
  v_cancelled integer := 0;
BEGIN
  WITH ag AS (
    SELECT a.id FROM public.payment_agreements a
     WHERE a.status = 'activo'
       AND (p_school_id IS NULL OR a.school_id = p_school_id)
       AND (p_agreement_ids IS NULL OR a.id = ANY (p_agreement_ids))
  ), ab AS (
    SELECT l.agreement_id,
           GREATEST(
             SUM(CASE WHEN p.status = 'paid' THEN GREATEST(COALESCE(p.amount_paid, 0), p.amount)
                      ELSE COALESCE(p.amount_paid, 0) END) - SUM(l.paid_at_request), 0) AS abonado
      FROM ag
      JOIN public.payment_agreement_payments l ON l.agreement_id = ag.id
      JOIN public.payments p ON p.id = l.payment_id
     GROUP BY l.agreement_id
  ), cum AS (
    SELECT i.id, i.agreement_id,
           SUM(i.amount) OVER (PARTITION BY i.agreement_id ORDER BY i.seq) AS acumulado
      FROM public.payment_agreement_items i
      JOIN ag ON ag.id = i.agreement_id
  ), upd AS (
    UPDATE public.payment_agreement_items i
       SET status = 'pagado', paid_at = now(), updated_at = now()
      FROM cum JOIN ab ON ab.agreement_id = cum.agreement_id
     WHERE i.id = cum.id
       AND i.status IN ('pendiente', 'vencido')
       AND cum.acumulado <= ab.abonado
    RETURNING i.id
  )
  SELECT count(*) INTO v_items FROM upd;

  -- Todas las cuotas pagadas → cumplido (y el acuerdo deja de estar vivo).
  WITH done AS (
    UPDATE public.payment_agreements a
       SET status = 'cumplido', updated_at = now()
     WHERE a.status = 'activo'
       AND (p_school_id IS NULL OR a.school_id = p_school_id)
       AND (p_agreement_ids IS NULL OR a.id = ANY (p_agreement_ids))
       AND NOT EXISTS (SELECT 1 FROM public.payment_agreement_items i
                        WHERE i.agreement_id = a.id AND i.status <> 'pagado')
    RETURNING a.id
  ), lv AS (
    UPDATE public.payment_agreement_payments l SET live = false
      FROM done WHERE l.agreement_id = done.id RETURNING 1
  )
  SELECT count(*) INTO v_done FROM done;

  -- Todos los cobros cubiertos se anularon (p. ej. baja) → cancelado.
  WITH gone AS (
    UPDATE public.payment_agreements a
       SET status = 'cancelado', resolution_note = COALESCE(a.resolution_note, 'Los cobros del acuerdo se anularon.'),
           updated_at = now()
     WHERE a.status = 'activo'
       AND (p_school_id IS NULL OR a.school_id = p_school_id)
       AND (p_agreement_ids IS NULL OR a.id = ANY (p_agreement_ids))
       AND NOT EXISTS (SELECT 1 FROM public.payment_agreement_payments l
                         JOIN public.payments p ON p.id = l.payment_id
                        WHERE l.agreement_id = a.id AND p.status <> 'cancelled')
    RETURNING a.id
  ), lv AS (
    UPDATE public.payment_agreement_payments l SET live = false
      FROM gone WHERE l.agreement_id = gone.id RETURNING 1
  )
  SELECT count(*) INTO v_cancelled FROM gone;

  RETURN jsonb_build_object('items_pagados', v_items, 'acuerdos_cumplidos', v_done, 'acuerdos_cancelados', v_cancelled);
END;
$$;
REVOKE ALL ON FUNCTION public.fn_agreements_mark_paid(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

-- ── 5. RPC: el pagador (o la administración, o el bot con service_role) solicita ──
-- p_items: [{"due_date":"2026-11-20","amount":50000}, ...] (en orden, ≥ hoy).
-- Quién es el pagador:
--   · authenticated sin p_payer_profile_id (o el propio) → él mismo, source 'app'.
--   · authenticated con p_payer_profile_id de OTRO → solo administración de p_school_id,
--     source 'admin', queda 'activo' (la administración lo aprueba al crearlo).
--   · service_role (bot; auth.uid() es NULL) → p_payer_profile_id obligatorio (la persona
--     que el bot identificó), source = p_source ('whatsapp' por defecto).
-- Errores (mensaje): ACUERDOS_APAGADO, SIN_PERMISO, DATOS_INVALIDOS:<causa>,
--   COBRO_NO_ELEGIBLE, COBRO_YA_EN_ACUERDO (23505).
CREATE OR REPLACE FUNCTION public.request_payment_agreement(
  p_school_id uuid,
  p_payment_ids uuid[],
  p_items jsonb,
  p_payer_profile_id uuid DEFAULT NULL,
  p_source text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_ss record;
  v_payer uuid;
  v_source text;
  v_admin boolean := false;
  v_n integer;
  v_total numeric := 0;
  v_sum numeric;
  v_first date;
  v_last date;
  v_found integer;
  v_incumplido boolean;
  v_status text;
  v_auto boolean := false;
  v_id uuid;
BEGIN
  IF p_school_id IS NULL OR p_payment_ids IS NULL OR COALESCE(array_length(p_payment_ids, 1), 0) = 0
     OR p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:parametros' USING ERRCODE = '22023';
  END IF;
  IF array_length(p_payment_ids, 1) > 50
     OR (SELECT count(DISTINCT x) FROM unnest(p_payment_ids) x) <> array_length(p_payment_ids, 1) THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:cobros' USING ERRCODE = '22023';
  END IF;

  -- Quién llama.
  IF v_uid IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' OR p_payer_profile_id IS NULL THEN
      RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
    END IF;
    v_payer := p_payer_profile_id;
    v_source := CASE WHEN p_source IN ('whatsapp', 'app') THEN p_source ELSE 'whatsapp' END;
  ELSIF p_payer_profile_id IS NULL OR p_payer_profile_id = v_uid THEN
    v_payer := v_uid;
    v_source := 'app';
  ELSE
    v_admin := COALESCE(p_school_id = ANY (public.user_admin_school_ids()), false);
    IF NOT v_admin THEN
      RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
    END IF;
    v_payer := p_payer_profile_id;
    v_source := 'admin';
  END IF;

  SELECT payment_agreements_enabled, agreement_max_installments, agreement_max_days, agreement_auto_approve
    INTO v_ss FROM public.school_settings WHERE school_id = p_school_id;
  IF NOT FOUND OR v_ss.payment_agreements_enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'ACUERDOS_APAGADO' USING ERRCODE = '55000';
  END IF;

  -- Calendario: n entre 1 y 12, montos > 0, fechas ≥ hoy y no decrecientes.
  v_n := jsonb_array_length(p_items);
  IF v_n < 1 OR v_n > 12 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:cuotas' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(SUM((e->>'amount')::numeric), 0), MIN((e->>'due_date')::date), MAX((e->>'due_date')::date)
    INTO v_sum, v_first, v_last
    FROM jsonb_array_elements(p_items) e;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) e
              WHERE (e->>'amount') IS NULL OR (e->>'due_date') IS NULL OR (e->>'amount')::numeric <= 0) THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:monto' USING ERRCODE = '22023';
  END IF;
  IF v_first < v_today THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:fecha_pasada' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM (
               SELECT (e.value->>'due_date')::date AS d,
                      LAG((e.value->>'due_date')::date) OVER (ORDER BY e.ordinality) AS prev
                 FROM jsonb_array_elements(p_items) WITH ORDINALITY e) s
              WHERE s.prev IS NOT NULL AND s.d < s.prev) THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:fechas_desordenadas' USING ERRCODE = '22023';
  END IF;
  IF v_last > v_today + 365 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:fecha_lejana' USING ERRCODE = '22023';
  END IF;

  -- Cobros: bloqueados (serializa solicitudes concurrentes), de esa escuela, abiertos y del pagador.
  PERFORM 1 FROM public.payments p WHERE p.id = ANY (p_payment_ids) ORDER BY p.id FOR UPDATE;

  SELECT count(*), COALESCE(SUM(GREATEST(p.amount - COALESCE(p.amount_paid, 0), 0)), 0)
    INTO v_found, v_total
    FROM public.payments p
   WHERE p.id = ANY (p_payment_ids)
     AND p.school_id = p_school_id
     AND p.status IN ('pending', 'overdue', 'partial')
     AND p.amount - COALESCE(p.amount_paid, 0) > 0
     AND (p.parent_id = v_payer OR p.user_id = v_payer
          OR p.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = v_payer));
  IF v_found <> array_length(p_payment_ids, 1) THEN
    RAISE EXCEPTION 'COBRO_NO_ELEGIBLE' USING ERRCODE = '22023';
  END IF;
  IF v_sum <> v_total THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:suma_distinta_del_saldo' USING ERRCODE = '22023';
  END IF;

  -- ¿Incumplió antes un acuerdo sobre alguno de estos cobros? Entonces no se auto-aprueba.
  SELECT EXISTS (SELECT 1 FROM public.payment_agreement_payments l
                   JOIN public.payment_agreements a ON a.id = l.agreement_id
                  WHERE l.payment_id = ANY (p_payment_ids) AND a.status = 'incumplido')
    INTO v_incumplido;

  IF v_admin THEN
    v_status := 'activo';
  ELSIF v_ss.agreement_auto_approve IS TRUE
        AND NOT v_incumplido
        AND v_n <= v_ss.agreement_max_installments
        AND (v_last - v_today) <= v_ss.agreement_max_days THEN
    v_status := 'activo';
    v_auto := true;
  ELSE
    v_status := 'solicitado';
  END IF;

  BEGIN
    INSERT INTO public.payment_agreements
      (school_id, requested_by, payer_profile_id, status, source, installments, total_amount,
       first_due_date, last_due_date, auto_approved, approved_by, approved_at)
    VALUES
      (p_school_id, v_uid, v_payer, v_status, v_source, v_n, v_total, v_first, v_last, v_auto,
       CASE WHEN v_admin THEN v_uid END, CASE WHEN v_status = 'activo' THEN now() END)
    RETURNING id INTO v_id;

    INSERT INTO public.payment_agreement_payments
      (agreement_id, school_id, payer_profile_id, payment_id, balance_at_request, paid_at_request)
    SELECT v_id, p_school_id, v_payer, p.id,
           p.amount - COALESCE(p.amount_paid, 0),
           COALESCE(p.amount_paid, 0)
      FROM public.payments p WHERE p.id = ANY (p_payment_ids);

    INSERT INTO public.payment_agreement_items
      (agreement_id, school_id, payer_profile_id, payment_id, seq, due_date, amount)
    SELECT v_id, p_school_id, v_payer,
           CASE WHEN array_length(p_payment_ids, 1) = 1 THEN p_payment_ids[1] END,
           e.ordinality::int, (e.value->>'due_date')::date, (e.value->>'amount')::numeric
      FROM jsonb_array_elements(p_items) WITH ORDINALITY e;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'COBRO_YA_EN_ACUERDO' USING ERRCODE = '23505';
  END;

  RETURN jsonb_build_object('agreement_id', v_id, 'status', v_status, 'auto_approved', v_auto,
                            'total_amount', v_total, 'installments', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.request_payment_agreement(uuid, uuid[], jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_payment_agreement(uuid, uuid[], jsonb, uuid, text)
  TO authenticated, service_role;

-- ── 6. RPC: la administración aprueba o rechaza ─────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_payment_agreement(
  p_agreement_id uuid,
  p_decision text,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a record;
  v_open integer;
BEGIN
  IF p_decision NOT IN ('aprobar', 'rechazar') THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:decision' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:nota' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_a FROM public.payment_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACUERDO_NO_ENCONTRADO' USING ERRCODE = 'P0002';
  END IF;
  -- Alcance adentro, atado a la escuela del acuerdo (no «¿es admin de alguna?»).
  IF v_uid IS NULL OR NOT COALESCE(v_a.school_id = ANY (public.user_admin_school_ids()), false) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
  END IF;
  IF v_a.status <> 'solicitado' THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO:%', v_a.status USING ERRCODE = '55000';
  END IF;

  IF p_decision = 'aprobar' THEN
    -- Los cobros deben seguir abiertos (si ya se pagaron o anularon, no hay qué plazar).
    SELECT count(*) INTO v_open
      FROM public.payment_agreement_payments l
      JOIN public.payments p ON p.id = l.payment_id
     WHERE l.agreement_id = p_agreement_id AND p.status IN ('pending', 'overdue', 'partial');
    IF v_open = 0 THEN
      RAISE EXCEPTION 'COBRO_NO_ELEGIBLE' USING ERRCODE = '22023';
    END IF;
    UPDATE public.payment_agreements
       SET status = 'activo', approved_by = v_uid, approved_at = now(),
           resolution_note = p_note, updated_at = now()
     WHERE id = p_agreement_id;
    RETURN jsonb_build_object('agreement_id', p_agreement_id, 'status', 'activo');
  END IF;

  UPDATE public.payment_agreements
     SET status = 'rechazado', approved_by = v_uid, approved_at = now(),
         resolution_note = p_note, updated_at = now()
   WHERE id = p_agreement_id;
  UPDATE public.payment_agreement_payments SET live = false WHERE agreement_id = p_agreement_id;
  RETURN jsonb_build_object('agreement_id', p_agreement_id, 'status', 'rechazado');
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_payment_agreement(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_payment_agreement(uuid, text, text) TO authenticated;

-- ── 7. RPC: cancelar (el pagador o la administración) ───────────────────────
CREATE OR REPLACE FUNCTION public.cancel_payment_agreement(
  p_agreement_id uuid,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_a record;
BEGIN
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'DATOS_INVALIDOS:nota' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_a FROM public.payment_agreements WHERE id = p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACUERDO_NO_ENCONTRADO' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL
     OR NOT (v_uid IN (v_a.payer_profile_id, v_a.requested_by)
             OR COALESCE(v_a.school_id = ANY (public.user_admin_school_ids()), false)) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
  END IF;
  IF v_a.status NOT IN ('solicitado', 'activo') THEN
    RAISE EXCEPTION 'ESTADO_INVALIDO:%', v_a.status USING ERRCODE = '55000';
  END IF;
  UPDATE public.payment_agreements
     SET status = 'cancelado', resolution_note = COALESCE(p_note, resolution_note), updated_at = now()
   WHERE id = p_agreement_id;
  UPDATE public.payment_agreement_payments SET live = false WHERE agreement_id = p_agreement_id;
  RETURN jsonb_build_object('agreement_id', p_agreement_id, 'status', 'cancelado');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_payment_agreement(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_payment_agreement(uuid, text) TO authenticated;

-- ── 8. RPC en lote: marcar cuotas pagadas según los abonos ──────────────────
-- service_role (job) sin restricción; administración solo con p_school_id propio.
CREATE OR REPLACE FUNCTION public.mark_agreement_items_from_payments(
  p_school_id uuid DEFAULT NULL,
  p_agreement_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
    END IF;
  ELSIF p_school_id IS NULL OR NOT COALESCE(p_school_id = ANY (public.user_admin_school_ids()), false) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
  END IF;
  RETURN public.fn_agreements_mark_paid(p_school_id, p_agreement_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.mark_agreement_items_from_payments(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_agreement_items_from_payments(uuid, uuid[]) TO authenticated, service_role;

-- ── 9. RPC: vencer cuotas sin pago → incumplido ─────────────────────────────
-- Primero sincroniza lo pagado (para no incumplir a quien ya abonó), luego vence.
CREATE OR REPLACE FUNCTION public.expire_agreements(p_school_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_items integer := 0;
  v_agreements integer := 0;
  v_sync jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
    END IF;
  ELSIF p_school_id IS NULL OR NOT COALESCE(p_school_id = ANY (public.user_admin_school_ids()), false) THEN
    RAISE EXCEPTION 'SIN_PERMISO' USING ERRCODE = '42501';
  END IF;

  v_sync := public.fn_agreements_mark_paid(p_school_id, NULL);

  WITH due AS (
    UPDATE public.payment_agreement_items i
       SET status = 'vencido', updated_at = now()
      FROM public.payment_agreements a
     WHERE i.agreement_id = a.id
       AND a.status = 'activo'
       AND (p_school_id IS NULL OR a.school_id = p_school_id)
       AND i.status = 'pendiente'
       AND i.due_date < v_today
    RETURNING i.agreement_id
  ), bad AS (
    UPDATE public.payment_agreements a
       SET status = 'incumplido', updated_at = now()
     WHERE a.id IN (SELECT agreement_id FROM due)
    RETURNING a.id
  ), lv AS (
    UPDATE public.payment_agreement_payments l SET live = false
      FROM bad WHERE l.agreement_id = bad.id RETURNING 1
  )
  SELECT (SELECT count(*) FROM due), (SELECT count(*) FROM bad) INTO v_items, v_agreements;

  RETURN jsonb_build_object('run_date', v_today, 'items_vencidos', v_items,
                            'acuerdos_incumplidos', v_agreements, 'sincronizado', v_sync);
END;
$$;
REVOKE ALL ON FUNCTION public.expire_agreements(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.expire_agreements(uuid) TO authenticated, service_role;

-- ── 10. Mora: apply_late_fees no recarga cobros con acuerdo activo y al día ──
-- Definición viva (2026-11-06) + marcas «-- (acuerdos)». Todo lo demás idéntico.
CREATE OR REPLACE FUNCTION public.apply_late_fees()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_today        date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_overdue      integer := 0;
    v_fees_applied integer := 0;
    v_total_fees   numeric := 0;
    v_reopened     integer := 0;
    v_reopen_skip  integer := 0;
    v_links        integer := 0;   -- (links)
    v_n            integer;        -- (links)
    r              record;
BEGIN
    -- (acuerdos) Con acuerdos activos, primero se reconocen las cuotas ya abonadas
    -- para no recargar a quien está al día. Sin acuerdos: no corre nada.
    IF EXISTS (SELECT 1 FROM public.payment_agreements WHERE status = 'activo') THEN
        PERFORM public.fn_agreements_mark_paid(NULL, NULL);
    END IF;

    FOR r IN
        SELECT
            p.id,
            CASE
                WHEN ss.late_fee_enabled IS TRUE
                     AND p.late_fee_applied_at IS NULL
                     AND NOT x.exempt   -- (primer cobro)
                     AND NOT x.agr      -- (acuerdos)
                THEN round(
                        COALESCE(ss.late_fee_percentage, 0)::numeric / 100
                        * GREATEST(p.amount - COALESCE(p.amount_paid, 0), 0)
                     )
                ELSE 0
            END AS fee
        FROM public.payments p
        JOIN public.school_settings ss ON ss.school_id = p.school_id
        CROSS JOIN LATERAL (   -- (primer cobro) + (acuerdos)
            SELECT (ss.late_fee_skip_signup_month IS TRUE
                    AND public.fn_is_first_monthly_charge(
                            p.school_id, p.child_id, p.user_id, p.unregistered_athlete_id,
                            p.period_year::int, p.period_month::int, p.id)) AS exempt,
                   -- (acuerdos) cobro en un acuerdo 'activo' y al día (sin cuota pendiente con fecha < hoy)
                   EXISTS (SELECT 1
                             FROM public.payment_agreement_payments ap
                             JOIN public.payment_agreements ag ON ag.id = ap.agreement_id
                            WHERE ap.payment_id = p.id AND ap.live AND ag.status = 'activo'
                              AND NOT EXISTS (SELECT 1 FROM public.payment_agreement_items i
                                               WHERE i.agreement_id = ag.id
                                                 AND i.status <> 'pagado'
                                                 AND i.due_date < v_today)) AS agr
        ) x
        WHERE p.status = 'rejected'
          AND ss.pending_proof_counts_as_paid IS TRUE
          AND NOT (ss.overdue_hold_until IS NOT NULL AND v_today <= ss.overdue_hold_until)
          AND COALESCE(p.child_id, p.unregistered_athlete_id, p.user_id) IS NOT NULL
          -- (20261010143132) solo la mensualidad entra en mora; todo cobro único queda fuera.
          AND COALESCE(p.payment_category, 'mensualidad') = 'mensualidad'
          AND (p.due_date + COALESCE(ss.payment_grace_days, 0)) < v_today
          AND (p.period_year IS NULL
               OR p.period_month IS NULL
               OR make_date(p.period_year::int, p.period_month::int, 1)
                  <= date_trunc('month', v_today)::date)
          AND ((COALESCE(p.created_at, now()) AT TIME ZONE 'America/Bogota')::date
               + COALESCE(ss.payment_grace_days, 0)) < v_today
          AND NOT EXISTS (
                SELECT 1 FROM public.payments q
                WHERE q.id <> p.id
                  AND q.school_id = p.school_id
                  AND q.status IN ('pending', 'awaiting_approval', 'paid', 'partial', 'overdue', 'glosado')
                  AND q.period_year  IS NOT DISTINCT FROM p.period_year
                  AND q.period_month IS NOT DISTINCT FROM p.period_month
                  AND (p.period_year IS NOT NULL
                       OR q.offering_plan_id IS NOT DISTINCT FROM p.offering_plan_id)
                  AND (
                        (p.child_id IS NOT NULL AND q.child_id = p.child_id)
                        OR (p.unregistered_athlete_id IS NOT NULL
                            AND q.unregistered_athlete_id = p.unregistered_athlete_id)
                        OR (p.child_id IS NULL AND p.user_id IS NOT NULL
                            AND q.child_id IS NULL AND q.user_id = p.user_id)
                      )
              )
        ORDER BY p.created_at DESC
    LOOP
        BEGIN
            UPDATE public.payments p
            SET late_fee_amount     = p.late_fee_amount + r.fee,
                amount              = p.amount + r.fee,
                late_fee_applied_at = CASE WHEN r.fee > 0 THEN now()
                                           ELSE p.late_fee_applied_at END,
                status              = 'overdue',
                updated_at          = now()
            WHERE p.id = r.id
              AND p.status = 'rejected';
            IF FOUND THEN
                v_reopened := v_reopened + 1;
                IF r.fee > 0 THEN
                    v_fees_applied := v_fees_applied + 1;
                    v_total_fees   := v_total_fees + r.fee;

                    -- (links) Un link pendiente quedó firmado con el monto sin recargo.
                    UPDATE public.payment_links l
                       SET status = 'expired', updated_at = now()
                     WHERE l.payment_id = r.id
                       AND l.status = 'pending'
                       AND NOT (l.origin = 'autopay'
                                AND EXISTS (SELECT 1 FROM public.recurring_charge_attempts a
                                             WHERE a.id = l.recurring_attempt_id
                                               AND a.status IN ('processing', 'pending_provider')));
                    GET DIAGNOSTICS v_n = ROW_COUNT;
                    v_links := v_links + v_n;
                END IF;
            END IF;
        EXCEPTION WHEN unique_violation THEN
            v_reopen_skip := v_reopen_skip + 1;
        END;
    END LOOP;

    WITH candidates AS (
        SELECT
            p.id,
            p.status,
            p.amount,
            p.late_fee_applied_at,
            CASE
                WHEN ss.late_fee_enabled IS TRUE
                     AND p.late_fee_applied_at IS NULL
                     AND NOT x.exempt   -- (primer cobro)
                     AND NOT x.agr      -- (acuerdos)
                THEN round(
                        COALESCE(ss.late_fee_percentage, 0)::numeric / 100
                        * GREATEST(p.amount - COALESCE(p.amount_paid, 0), 0)
                     )
                ELSE 0
            END AS fee
        FROM public.payments p
        JOIN public.school_settings ss ON ss.school_id = p.school_id
        CROSS JOIN LATERAL (   -- (primer cobro) + (acuerdos)
            SELECT (ss.late_fee_skip_signup_month IS TRUE
                    AND public.fn_is_first_monthly_charge(
                            p.school_id, p.child_id, p.user_id, p.unregistered_athlete_id,
                            p.period_year::int, p.period_month::int, p.id)) AS exempt,
                   -- (acuerdos) igual que arriba
                   EXISTS (SELECT 1
                             FROM public.payment_agreement_payments ap
                             JOIN public.payment_agreements ag ON ag.id = ap.agreement_id
                            WHERE ap.payment_id = p.id AND ap.live AND ag.status = 'activo'
                              AND NOT EXISTS (SELECT 1 FROM public.payment_agreement_items i
                                               WHERE i.agreement_id = ag.id
                                                 AND i.status <> 'pagado'
                                                 AND i.due_date < v_today)) AS agr
        ) x
        WHERE p.status IN ('pending', 'partial')
          AND NOT (ss.overdue_hold_until IS NOT NULL AND v_today <= ss.overdue_hold_until)
          -- (20261010143132) solo la mensualidad entra en mora; todo cobro único queda fuera.
          AND COALESCE(p.payment_category, 'mensualidad') = 'mensualidad'
          AND (p.due_date + COALESCE(ss.payment_grace_days, 0)) < v_today
          AND (p.period_year IS NULL
               OR p.period_month IS NULL
               OR make_date(p.period_year::int, p.period_month::int, 1)
                  <= date_trunc('month', v_today)::date)
          AND ((COALESCE(p.created_at, now()) AT TIME ZONE 'America/Bogota')::date
               + COALESCE(ss.payment_grace_days, 0)) < v_today
          AND (
                p.status = 'pending'
                OR (ss.late_fee_enabled IS TRUE AND p.late_fee_applied_at IS NULL
                    AND NOT x.exempt    -- (primer cobro) sin esto un parcial exento se reescribiría cada noche
                    AND NOT x.agr)      -- (acuerdos) ídem para un parcial con acuerdo al día
              )
    ), updated AS (
        UPDATE public.payments p
        SET
            late_fee_amount     = p.late_fee_amount + c.fee,
            amount              = p.amount + c.fee,
            late_fee_applied_at = CASE WHEN c.fee > 0 THEN now()
                                       ELSE p.late_fee_applied_at END,
            status              = CASE WHEN p.status = 'pending' THEN 'overdue'
                                       ELSE p.status END,
            updated_at          = now()
        FROM candidates c
        WHERE p.id = c.id
        RETURNING p.id, (c.status = 'pending') AS became_overdue, c.fee
    ), expired_links AS (   -- (links) mismo criterio que en el bucle de 'rejected'
        UPDATE public.payment_links l
           SET status = 'expired', updated_at = now()
          FROM updated u
         WHERE l.payment_id = u.id
           AND u.fee > 0
           AND l.status = 'pending'
           AND NOT (l.origin = 'autopay'
                    AND EXISTS (SELECT 1 FROM public.recurring_charge_attempts a
                                 WHERE a.id = l.recurring_attempt_id
                                   AND a.status IN ('processing', 'pending_provider')))
        RETURNING l.id
    )
    SELECT
        COUNT(*) FILTER (WHERE became_overdue),
        v_fees_applied + COUNT(*) FILTER (WHERE fee > 0),
        v_total_fees + COALESCE(SUM(fee), 0),
        v_links + (SELECT COUNT(*) FROM expired_links)   -- (links)
    INTO v_overdue, v_fees_applied, v_total_fees, v_links
    FROM updated;

    RETURN jsonb_build_object(
        'run_date',                v_today,
        'overdue_marked',          v_overdue,
        'fees_applied',            v_fees_applied,
        'total_fees',              v_total_fees,
        'rejected_reopened',       v_reopened,
        'rejected_reopen_skipped', v_reopen_skip,
        'links_expired',           v_links   -- (links)
    );
END;
$function$;

-- ============================================================================
-- PRUEBAS (a mano, en transacción con ROLLBACK; ver _smoke/acuerdos_smoke.sql)
-- ============================================================================
-- T1  Escuela con payment_agreements_enabled = false: request_payment_agreement
--     → ACUERDOS_APAGADO (55000). Ninguna fila nueva.
-- T2  Pagador con 1 cobro 'pending' de 150000, 3 cuotas 50000 a 20/40/60 días,
--     enabled + auto_approve: status 'activo', auto_approved = true; 3 items 'pendiente';
--     payments NO cambió.
-- T3  Mismo caso con 4 cuotas (tope 3) o 90 días (tope 60) o auto_approve = false:
--     status 'solicitado'. resolve 'aprobar' por admin → 'activo'; por un coach o por
--     un admin de OTRA escuela → 42501.
-- T4  Cobro de otra familia, de otra escuela, 'paid' o 'awaiting_approval' → COBRO_NO_ELEGIBLE;
--     suma de cuotas ≠ saldo → DATOS_INVALIDOS:suma_distinta_del_saldo; fecha pasada o
--     desordenada → DATOS_INVALIDOS; un cobro ya en acuerdo vivo → COBRO_YA_EN_ACUERDO (23505).
-- T5  Abono de 50000 sobre el cobro (amount_paid = 50000, 'partial'):
--     mark_agreement_items_from_payments marca la cuota 1 'pagado' y deja 2 y 3;
--     abono total 150000 → las 3 'pagado' y el acuerdo 'cumplido' (live = false).
-- T6  Cuota con due_date < hoy sin pago: expire_agreements → item 'vencido', acuerdo
--     'incumplido', links live = false. Si ya había abonado esa cuota, NO se incumple.
-- T7  apply_late_fees con late_fee_enabled: cobro 'pending' vencido con acuerdo activo y al día
--     → pasa a 'overdue' pero late_fee_amount = 0 y late_fee_applied_at NULL. Con acuerdo
--     'incumplido' (o sin acuerdo) → recargo normal sobre el saldo. Sin filas en las tablas
--     nuevas el resultado es idéntico al de antes de la migración.
-- T8  RLS: el pagador ve solo sus acuerdos/cuotas; staff de la escuela ve los de su escuela;
--     otro usuario, otra escuela y anon → 0 filas / 42501; INSERT/UPDATE directos solo admin;
--     DELETE de cualquiera → 42501. EXECUTE de los RPC: anon sin permiso; fn_agreements_mark_paid
--     sin permiso para authenticated.
-- Verificación en la base viva tras aplicar (pg_policies / pg_proc filtrando por nombre):
--   select policyname, cmd, roles, qual, with_check from pg_policies where tablename like 'payment_agreement%';
--   select proname, proacl, proconfig from pg_proc where proname in
--     ('request_payment_agreement','resolve_payment_agreement','cancel_payment_agreement',
--      'mark_agreement_items_from_payments','expire_agreements','fn_agreements_mark_paid','apply_late_fees');
--   npm run seguridad:invariantes
