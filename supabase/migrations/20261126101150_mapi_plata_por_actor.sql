-- =============================================================================
-- 20261126101150_mapi_plata_por_actor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126101055
-- Objetivo: plata desde Mapi (diseño A, plan mapi-rpc-por-actor rev. 2):
-- tope por escuela (school_settings.mapi_tope_aprobacion + guarda), pago_operaciones,
-- nivel 2 en la base, aprobar_comprobante (núcleo + gemela + _por) y
-- register_manual_payments con actor y abono (núcleo + original + _por de efectivo).
-- Prerrequisitos: 20261126101055 (_por_actuar_como) y 20261125140410 (veredicto solo servidor).
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

-- ── 1. Tope de Mapi por escuela ──────────────────────────────────────────────
-- Constante en la tabla (PG ≥ 11 no reescribe la tabla por un DEFAULT constante).
ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS mapi_tope_aprobacion integer NOT NULL DEFAULT 400000
        CONSTRAINT school_settings_mapi_tope_aprobacion_check CHECK (mapi_tope_aprobacion > 0);

COMMENT ON COLUMN public.school_settings.mapi_tope_aprobacion IS
    'Tope por operación (pesos) para aprobar comprobantes o registrar efectivo desde Mapi (app o WhatsApp). Cuenta también lo que dice el comprobante. Lo cambia SOLO la administración de la escuela desde la app (trigger school_settings_mapi_tope_guard); el servidor (BFF, bot, Mapi) no. Distinto de auto_approve_max_amount (aprobación automática).';

-- Trampa 4 de CLAUDE.md: las policies FOR ALL dan la FILA a la administración y
-- service_role las ignora; la columna lleva su candado propio. tr_audit_school_settings
-- ya deja OLD/NEW y auth.uid() en audit_logs en cada UPDATE.
CREATE OR REPLACE FUNCTION public.school_settings_mapi_tope_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rol text := COALESCE(auth.role(), '');
BEGIN
  -- Guardar otros ajustes (o un upsert de la fila completa) con el mismo tope: pasa.
  IF TG_OP = 'UPDATE' AND NEW.mapi_tope_aprobacion IS NOT DISTINCT FROM OLD.mapi_tope_aprobacion THEN
    RETURN NEW;
  END IF;

  -- El servidor (BFF, bot y Mapi corren con service_role): el tope limita justo lo
  -- que él mueve, así que nunca lo cambia. Una fila nueva nace en el default.
  IF v_rol = 'service_role' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.mapi_tope_aprobacion := 400000;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tope_bloqueado: el tope de Mapi se cambia desde la app, no desde el servidor'
      USING ERRCODE = '42501';
  END IF;

  -- Desde la app: la administración de ESA escuela (el mismo conjunto de las dos
  -- policies de escritura: owner_id y owner/admin/school_admin) o plataforma.
  IF v_rol IN ('authenticated', 'anon')
     AND NOT (NEW.school_id = ANY (public.user_admin_school_ids()) OR public.is_platform_admin()) THEN
    IF TG_OP = 'INSERT' THEN
      NEW.mapi_tope_aprobacion := 400000;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tope_bloqueado: solo la administración de la escuela cambia el tope de Mapi'
      USING ERRCODE = '42501';
  END IF;

  -- Sin claims (migraciones, SQL editor de SportMaps): pasa.
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.school_settings_mapi_tope_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS school_settings_mapi_tope_guard ON public.school_settings;
CREATE TRIGGER school_settings_mapi_tope_guard
    BEFORE INSERT OR UPDATE OF mapi_tope_aprobacion ON public.school_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.school_settings_mapi_tope_guard();

-- ── 2. Plata en los avisos ($145.000), como formatCurrency de la app ──────────
CREATE OR REPLACE FUNCTION public._formato_cop(p_valor numeric)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  -- En to_char la ',' es la coma literal (no depende del locale); se pasa a punto.
  SELECT '$' || replace(to_char(round(COALESCE(p_valor, 0)), 'FM999,999,999,990'), ',', '.');
$$;
REVOKE ALL ON FUNCTION public._formato_cop(numeric) FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. Operaciones de plata: idempotencia, quién y por dónde ─────────────────
CREATE TABLE IF NOT EXISTS public.pago_operaciones (
    idempotency_key uuid        PRIMARY KEY,
    tipo            text        NOT NULL CHECK (tipo IN ('aprobar_comprobante', 'registrar_pago')),
    canal           text        NOT NULL CHECK (canal IN ('app', 'mapi_app', 'mapi_whatsapp')),
    school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    actor_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    payment_ids     uuid[]      NOT NULL,
    monto           numeric     NOT NULL CHECK (monto >= 0),
    resultado       jsonb       NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pago_operaciones_escuela_fecha_idx
    ON public.pago_operaciones (school_id, created_at DESC);
ALTER TABLE public.pago_operaciones ENABLE ROW LEVEL SECURITY;
-- Sin policies: la escriben los núcleos (dueño) y la lee el BFF (service_role).
-- Los default privileges le dan arwdm a authenticated: se quitan explícitamente.
REVOKE ALL ON TABLE public.pago_operaciones FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.pago_operaciones IS
  'Operaciones de plata con llave de idempotencia (Mapi): una por borrador confirmado, con actor y canal. Plan mapi-rpc-por-actor §6.';

-- ── 4. Nivel 2 (§21 del plan de Mapi) recalculado en la base: PISO ───────────
-- Devuelve el motivo por el que NO es nivel 2, o NULL si lo es. La definición del
-- abono la confirmó el usuario el 2026-11-26 (plan §3.5).
CREATE OR REPLACE FUNCTION public._comprobante_nivel2_falta(p_payment_id uuid, p_abono numeric)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v         public.payments%ROWTYPE;
  v_rem     numeric;
  v_codigos text[];
BEGIN
  SELECT * INTO v FROM public.payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN 'cobro_no_encontrado'; END IF;
  IF v.status <> 'awaiting_approval' THEN RETURN 'no_esta_por_validar'; END IF;
  IF v.receipt_url IS NULL THEN RETURN 'sin_comprobante'; END IF;
  -- Paso 4 (20261125140410): la lectura y el veredicto valen solo si los selló el servidor.
  IF COALESCE(v.receipt_image_sha256_source, '') <> 'server_verified' THEN RETURN 'lectura_no_sellada_por_el_servidor'; END IF;
  -- Monto elegido por el navegador: lo aprueba una persona en la pantalla (como auto_approve_payment).
  IF COALESCE(v.amount_source, 'servidor') = 'cliente' THEN RETURN 'monto_elegido_por_quien_paga'; END IF;
  IF COALESCE(v.requires_review, false) THEN RETURN 'intento_de_pasarela_en_revision'; END IF;
  IF COALESCE(v.amount_paid, 0) > 0 THEN RETURN 'tiene_abonos_previos'; END IF;

  v_codigos := ARRAY(
    SELECT DISTINCT r ->> 'code'
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v.receipt_verdict_reasons) = 'array'
                                     THEN v.receipt_verdict_reasons ELSE '[]'::jsonb END) AS r);
  IF 'POSIBLE_MANIPULACION' = ANY (v_codigos) THEN RETURN 'posible_manipulacion'; END IF;

  v_rem := GREATEST(COALESCE(v.amount, 0) - GREATEST(COALESCE(v.early_payment_discount_applied, 0), 0)
                    - COALESCE(v.amount_paid, 0), 0);
  IF v.ocr_amount IS NULL OR v_rem <= 0 THEN RETURN 'sin_monto_leido'; END IF;
  IF p_abono IS NULL OR p_abono <= 0 THEN RETURN 'sin_monto'; END IF;
  IF p_abono > v_rem THEN RETURN 'abono_mayor_que_saldo'; END IF;

  IF p_abono = v_rem THEN
    -- Pago completo: verde y monto leído = saldo (±0,5 %: TOLERANCIA_MONTO de pagos-por-validar.job).
    IF v.receipt_verdict IS DISTINCT FROM 'verde' THEN RETURN 'no_esta_en_verde'; END IF;
    IF abs(v.ocr_amount - v_rem) / v_rem > 0.005 THEN RETURN 'monto_leido_no_coincide'; END IF;
  ELSE
    -- Abono (§20.4 regla 6): se aprueba lo que dice el comprobante y lo ÚNICO que no
    -- cuadra es el monto (amarillo solo por MONTO_DIFIERE). Confirmada por el usuario el 2026-11-26.
    IF round(v.ocr_amount) <> round(p_abono) THEN RETURN 'abono_distinto_del_comprobante'; END IF;
    IF v.receipt_verdict IS DISTINCT FROM 'amarillo'
       OR EXISTS (SELECT 1 FROM unnest(v_codigos) AS c WHERE c IS DISTINCT FROM 'MONTO_DIFIERE') THEN
      RETURN 'abono_con_otras_dudas';
    END IF;
  END IF;

  -- Un comprobante para varios cobros: va por la pantalla (como «Aprobar todos los verdes»).
  IF EXISTS (SELECT 1 FROM public.payments o
              WHERE o.school_id = v.school_id AND o.id <> v.id
                AND o.receipt_url = v.receipt_url
                AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'comprobante_cubre_varios_cobros';
  END IF;
  -- Foto y referencia nunca vistas en la escuela.
  IF v.receipt_image_sha256 IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.school_id = v.school_id AND o.id <> v.id
          AND o.receipt_image_sha256 = v.receipt_image_sha256
          AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'foto_repetida';
  END IF;
  IF v.receipt_reference_norm IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.school_id = v.school_id AND o.id <> v.id
          AND o.receipt_reference_norm = v.receipt_reference_norm
          AND o.status NOT IN ('rejected', 'cancelled', 'failed')) THEN
    RETURN 'referencia_repetida';
  END IF;
  -- Ese mes ya lo pagó otro cobro (periodosYaPagados del job).
  IF v.child_id IS NOT NULL AND v.period_year IS NOT NULL AND v.period_month IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.payments o
        WHERE o.child_id = v.child_id AND o.id <> v.id
          AND o.period_year = v.period_year AND o.period_month = v.period_month
          AND o.status IN ('paid', 'approved')) THEN
    RETURN 'ese_mes_ya_estaba_pagado';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._comprobante_nivel2_falta(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- ── 5. aprobar_comprobante ───────────────────────────────────────────────────
-- Lo que hoy hace el navegador en frontend/src/lib/approvePayment.ts, en una
-- transacción: FOR UPDATE, cuentas de approvalMath, abono → 'partial', inscripción
-- solo con mensualidad completa, aviso a la familia con el mismo texto.
CREATE OR REPLACE FUNCTION public.aprobar_comprobante_nucleo(
    p_actor             uuid,
    p_payment_id        uuid,
    p_abono             numeric DEFAULT NULL,   -- NULL = el saldo completo
    p_pagado_antes      numeric DEFAULT NULL,   -- candado optimista: amount_paid que vio quien aprueba
    p_monto_confirmado  numeric DEFAULT NULL,   -- escuelas con receipt_amount_editable (Dynasty)
    p_motivo_confirmado text    DEFAULT NULL,
    p_avisar            boolean DEFAULT true,
    p_solo_nivel2       boolean DEFAULT false,
    p_tope              numeric DEFAULT NULL,
    p_idempotency_key   uuid    DEFAULT NULL,
    p_canal             text    DEFAULT 'app'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_p         public.payments%ROWTYPE;
  v_ya        jsonb;
  v_due       numeric;
  v_prev      numeric;
  v_rem       numeric;
  v_abono     numeric;
  v_total     numeric;
  v_es_abono  boolean;
  v_saldo     numeric;
  v_pagado    numeric;
  v_metodo    text;
  v_falta     text;
  v_dest      uuid;
  v_escuela   text;
  v_activadas int := 0;
  v_res       jsonb;
BEGIN
  -- El actor es el de la sesión: la gemela pasa auth.uid() y la _por ya lo fijó
  -- (plan §3.3). Con eso, los gates usan los helpers vivos.
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'actor_distinto: el actor no coincide con la sesión' USING ERRCODE = '42501';
  END IF;
  IF p_abono IS NOT NULL AND p_abono <= 0 THEN
    RAISE EXCEPTION 'monto_invalido: el abono tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('app', 'mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;

  -- Idempotencia: el mismo borrador no se aplica dos veces, ni con dos clics a la vez
  -- (el candado de la llave serializa los reintentos antes de mirar el cobro).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pago_operaciones:' || p_idempotency_key::text, 0));
    SELECT o.resultado INTO v_ya FROM public.pago_operaciones o WHERE o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_ya || jsonb_build_object('ya_aplicada', true);
    END IF;
  END IF;

  SELECT * INTO v_p FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cobro_no_encontrado' USING ERRCODE = 'P0002';
  END IF;

  -- Mismo alcance que la policy «Payments: update admin» de la pantalla.
  IF NOT (v_p.school_id = ANY (public.user_admin_school_ids()) OR COALESCE(public.is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'sin_permiso: solo la administración de la escuela aprueba pagos' USING ERRCODE = '42501';
  END IF;
  -- Mismo candado que la policy trial_block_update.
  IF NOT public.school_is_operational(v_p.school_id) THEN
    RAISE EXCEPTION 'escuela_no_operativa: la cuenta de la escuela está bloqueada para esta operación'
      USING ERRCODE = '42501';
  END IF;
  IF v_p.status NOT IN ('awaiting_approval', 'pending', 'overdue', 'partial') THEN
    RAISE EXCEPTION 'cobro_no_abierto: este cobro ya no está abierto (pudo aprobarse mientras tanto)'
      USING ERRCODE = 'P0001';
  END IF;
  IF p_pagado_antes IS NOT NULL AND COALESCE(v_p.amount_paid, 0) <> p_pagado_antes THEN
    RAISE EXCEPTION 'cobro_cambio: el cobro cambió desde que se preparó; vuelve a revisarlo'
      USING ERRCODE = 'P0001';
  END IF;

  -- Las cuentas de approvalMath (approvePayment.ts), con el pronto pago descontado.
  v_due      := GREATEST(COALESCE(v_p.amount, 0) - GREATEST(COALESCE(v_p.early_payment_discount_applied, 0), 0), 0);
  v_prev     := COALESCE(v_p.amount_paid, 0);
  v_rem      := GREATEST(v_due - v_prev, 0);
  v_abono    := COALESCE(p_abono, v_rem);
  v_total    := v_prev + v_abono;
  v_es_abono := v_total < v_due;
  v_saldo    := GREATEST(v_due - v_total, 0);
  v_pagado   := CASE WHEN v_es_abono THEN v_total ELSE GREATEST(v_due, v_prev) END;

  -- Tope: lo que se acredita o lo que dice el comprobante (lo de más se vuelve
  -- saldo a favor con trg_payments_saldo_a_favor_al_aprobar), lo que sea mayor.
  IF p_tope IS NOT NULL AND GREATEST(v_abono, COALESCE(v_p.ocr_amount, 0)) > p_tope THEN
    RAISE EXCEPTION 'supera_tope: % supera el tope de % de la escuela para Mapi',
      GREATEST(v_abono, COALESCE(v_p.ocr_amount, 0)), p_tope USING ERRCODE = 'P0001';
  END IF;

  IF p_solo_nivel2 THEN
    v_falta := public._comprobante_nivel2_falta(p_payment_id, v_abono);
    IF v_falta IS NOT NULL THEN
      RAISE EXCEPTION 'nivel_3: %', v_falta USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_metodo := COALESCE(NULLIF(btrim(v_p.payment_method), ''), 'transfer');

  UPDATE public.payments SET
    status          = CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
    payment_method  = v_metodo,
    payment_channel = CASE v_metodo WHEN 'cash' THEN 'cash' WHEN 'other' THEN 'manual' ELSE 'transfer' END,
    payment_date    = (now() AT TIME ZONE 'America/Bogota')::date,
    approved_by     = p_actor,
    approved_at     = now(),
    amount_paid     = v_pagado,
    requires_review = false,
    unblocked_at    = now(),
    unblocked_by    = p_actor,
    receipt_amount_confirmed     = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_monto_confirmado  ELSE receipt_amount_confirmed     END,
    receipt_amount_change_reason = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_motivo_confirmado ELSE receipt_amount_change_reason END,
    receipt_amount_confirmed_by  = CASE WHEN p_monto_confirmado IS NOT NULL THEN p_actor             ELSE receipt_amount_confirmed_by  END,
    receipt_amount_confirmed_at  = CASE WHEN p_monto_confirmado IS NOT NULL THEN now()               ELSE receipt_amount_confirmed_at  END
  WHERE id = p_payment_id;

  -- Activa la inscripción pendiente SOLO con pago completo de mensualidad
  -- (isOneTimeCategory: categoría no nula y distinta de 'mensualidad' = cobro único).
  -- Siempre con el deportista: sin ninguno no se toca nada (approvePayment.ts no filtraba).
  IF NOT v_es_abono AND COALESCE(v_p.payment_category, 'mensualidad') = 'mensualidad' THEN
    UPDATE public.enrollments e
       SET status = 'active', updated_at = now()
     WHERE e.school_id = v_p.school_id
       AND e.status = 'pending'
       AND CASE
             WHEN v_p.child_id IS NOT NULL                THEN e.child_id = v_p.child_id
             WHEN v_p.unregistered_athlete_id IS NOT NULL THEN e.unregistered_athlete_id = v_p.unregistered_athlete_id
             WHEN v_p.user_id IS NOT NULL                 THEN e.user_id = v_p.user_id AND e.child_id IS NULL
             ELSE false
           END
       AND (v_p.team_id IS NULL OR e.team_id = v_p.team_id);
    GET DIAGNOSTICS v_activadas = ROW_COUNT;
  END IF;

  -- Aviso a la familia con el texto de la app (approvePayment.ts). No traba la aprobación.
  IF p_avisar THEN
    v_dest := COALESCE(v_p.parent_id,
                       (SELECT c.parent_id FROM public.children c WHERE c.id = v_p.child_id),
                       v_p.user_id);
    IF v_dest IS NOT NULL THEN
      BEGIN
        SELECT NULLIF(btrim(s.name), '') INTO v_escuela FROM public.schools s WHERE s.id = v_p.school_id;
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
        VALUES (
          v_dest, v_p.school_id,
          CASE WHEN v_es_abono THEN '💰 Abono registrado' ELSE '✅ Pago confirmado' END,
          CASE WHEN v_es_abono
               THEN format('%s registró un abono de %s por %s. Saldo pendiente: %s.',
                           COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_abono),
                           COALESCE(v_p.concept, 'tu cobro'), public._formato_cop(v_saldo))
               ELSE format('%s confirmó tu pago de %s por %s.',
                           COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_rem),
                           COALESCE(v_p.concept, 'tu cobro'))
          END,
          CASE WHEN v_es_abono THEN 'payment' ELSE 'success' END,
          '/my-payments', 'payment',
          public._payment_notif_data(v_dest, v_p.child_id, v_p.team_id, v_p.school_id, v_abono));
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'aprobar_comprobante: no se pudo avisar (%): %', SQLSTATE, SQLERRM;
      END;
    END IF;
  END IF;

  v_res := jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'estado', CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
    'es_abono', v_es_abono,
    'abono', v_abono,
    'saldo_pendiente', v_saldo,
    'inscripciones_activadas', v_activadas,
    'ya_aplicada', false);

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.pago_operaciones (idempotency_key, tipo, canal, school_id, actor_id, payment_ids, monto, resultado)
    VALUES (p_idempotency_key, 'aprobar_comprobante', p_canal, v_p.school_id, p_actor, ARRAY[p_payment_id], v_abono, v_res);
  END IF;

  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante_nucleo(uuid, uuid, numeric, numeric, numeric, text, boolean, boolean, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Gemela para la pantalla (§12 #2: hoy ninguna pantalla la usa).
CREATE OR REPLACE FUNCTION public.aprobar_comprobante(
    p_payment_id        uuid,
    p_abono             numeric DEFAULT NULL,
    p_pagado_antes      numeric DEFAULT NULL,
    p_monto_confirmado  numeric DEFAULT NULL,
    p_motivo_confirmado text    DEFAULT NULL,
    p_avisar            boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.aprobar_comprobante_nucleo(
    (SELECT auth.uid()), p_payment_id, p_abono, p_pagado_antes,
    p_monto_confirmado, p_motivo_confirmado, p_avisar,
    false, NULL, NULL, 'app');
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante(uuid, numeric, numeric, numeric, text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.aprobar_comprobante(uuid, numeric, numeric, numeric, text, boolean) TO authenticated;

-- Mapi (app o WhatsApp): solo nivel 2, con el tope de la escuela y llave.
CREATE OR REPLACE FUNCTION public.aprobar_comprobante_por(
    p_actor           uuid,
    p_payment_id      uuid,
    p_abono           numeric,
    p_pagado_antes    numeric,
    p_idempotency_key uuid,
    p_canal           text    DEFAULT 'mapi_whatsapp',
    p_tope            numeric DEFAULT NULL   -- el BFF solo puede BAJAR el de la escuela
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school        uuid;
  v_tope_escuela  numeric;
BEGIN
  SELECT p.school_id INTO v_school FROM public.payments p WHERE p.id = p_payment_id;
  PERFORM public._por_actuar_como(p_actor, v_school, 'admin');
  IF p_idempotency_key IS NULL OR p_pagado_antes IS NULL THEN
    RAISE EXCEPTION 'faltan_datos: idempotency_key y pagado_antes son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_tope IS NOT NULL AND p_tope <= 0 THEN
    RAISE EXCEPTION 'tope_invalido: el tope tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  -- Sin fila de ajustes vale el default de la columna.
  SELECT ss.mapi_tope_aprobacion INTO v_tope_escuela FROM public.school_settings ss WHERE ss.school_id = v_school;
  v_tope_escuela := COALESCE(v_tope_escuela, 400000);

  RETURN public.aprobar_comprobante_nucleo(
    p_actor, p_payment_id, p_abono, p_pagado_antes,
    NULL, NULL,                    -- sin «valor confirmado» desde Mapi
    true,                          -- avisa a la familia
    true,                          -- exige nivel 2
    LEAST(v_tope_escuela, COALESCE(p_tope, v_tope_escuela)),
    p_idempotency_key, p_canal);
END;
$$;
REVOKE ALL ON FUNCTION public.aprobar_comprobante_por(uuid, uuid, numeric, numeric, uuid, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aprobar_comprobante_por(uuid, uuid, numeric, numeric, uuid, text, numeric) TO service_role;

-- ── 6. register_manual_payments: núcleo con actor y abono ────────────────────
-- Con p_monto NULL hace EXACTAMENTE lo de hoy (register_manual_payments vivo al
-- 2026-11-25, md5 57d1b36b…; mismo gate is_school_admin() OR is_super_admin()).
-- Con p_monto: lo recibido sobre UN cobro pending/overdue/partial, sin pasarse del
-- saldo (abono si es menor).
CREATE OR REPLACE FUNCTION public.register_manual_payments_nucleo(
    p_actor           uuid,
    p_school_id       uuid,
    p_payment_ids     uuid[],
    p_method          text,
    p_payment_date    date,
    p_reference_base  text,
    p_receipt_url     text    DEFAULT NULL,
    p_receipt_fields  jsonb   DEFAULT NULL,
    p_monto           numeric DEFAULT NULL,
    p_pagado_antes    numeric DEFAULT NULL,
    p_avisar          boolean DEFAULT false,
    p_tope            numeric DEFAULT NULL,
    p_idempotency_key uuid    DEFAULT NULL,
    p_canal           text    DEFAULT 'app'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid       uuid := p_actor;
  v_ids       uuid[];
  v_found     integer;
  v_bad       integer;
  v_athletes  integer;
  v_a_cobrar  numeric;
  v_row       record;
  v_rf        public.payments;
  v_i         integer := 0;
  v_total     numeric := 0;
  v_paid_ids  uuid[] := ARRAY[]::uuid[];
  v_ref       text;
  v_p         public.payments%ROWTYPE;
  v_saldo     numeric;
  v_es_abono  boolean := false;
  v_resta     numeric := 0;
  v_ya        jsonb;
  v_res       jsonb;
  v_dest      uuid;
  v_escuela   text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'no_autenticado' USING ERRCODE = '42501';
  END IF;
  -- El actor es el de la sesión (plan §3.3): la original pasa auth.uid(); la _por lo fijó.
  IF v_uid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'actor_distinto: el actor no coincide con la sesión' USING ERRCODE = '42501';
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
  IF p_canal IS NULL OR p_canal NOT IN ('app', 'mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids
    FROM unnest(COALESCE(p_payment_ids, ARRAY[]::uuid[])) AS x;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'sin_cobros: selecciona al menos un cobro' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 50 THEN
    RAISE EXCEPTION 'demasiados_cobros: máximo 50 por operación' USING ERRCODE = '22023';
  END IF;
  IF p_monto IS NOT NULL AND (p_monto <= 0 OR cardinality(v_ids) <> 1) THEN
    RAISE EXCEPTION 'abono_invalido: el monto va a un solo cobro y tiene que ser mayor que cero'
      USING ERRCODE = '22023';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pago_operaciones:' || p_idempotency_key::text, 0));
    SELECT o.resultado INTO v_ya FROM public.pago_operaciones o WHERE o.idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN v_ya || jsonb_build_object('ya_aplicada', true);
    END IF;
  END IF;

  PERFORM 1 FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id
   FOR UPDATE;

  SELECT count(*),
         count(*) FILTER (WHERE status NOT IN ('pending', 'overdue')
                            AND NOT (p_monto IS NOT NULL AND status = 'partial')),
         count(DISTINCT COALESCE(child_id, user_id, unregistered_athlete_id)),
         COALESCE(sum(amount), 0)
    INTO v_found, v_bad, v_athletes, v_a_cobrar
    FROM public.payments
   WHERE id = ANY (v_ids) AND school_id = p_school_id;

  IF v_found <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'cobro_no_encontrado: alguno de los cobros no existe en esta escuela' USING ERRCODE = 'P0002';
  END IF;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'cobro_no_pagable: solo se registran cobros pendientes o atrasados' USING ERRCODE = 'P0001';
  END IF;
  IF v_athletes <> 1 THEN
    RAISE EXCEPTION 'atletas_distintos: los cobros deben ser de un mismo deportista' USING ERRCODE = 'P0001';
  END IF;

  IF p_monto IS NULL THEN
    IF p_tope IS NOT NULL AND v_a_cobrar > p_tope THEN
      RAISE EXCEPTION 'supera_tope: % supera el tope de %', v_a_cobrar, p_tope USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT * INTO v_p FROM public.payments WHERE id = v_ids[1];
    IF p_pagado_antes IS NOT NULL AND COALESCE(v_p.amount_paid, 0) <> p_pagado_antes THEN
      RAISE EXCEPTION 'cobro_cambio: el cobro cambió desde que se preparó; vuelve a revisarlo'
        USING ERRCODE = 'P0001';
    END IF;
    -- saldo = amount − amount_paid − pronto pago (applyFieldsFor de RegisterCashPaymentModal).
    v_saldo := GREATEST(COALESCE(v_p.amount, 0) - COALESCE(v_p.amount_paid, 0)
                        - COALESCE(v_p.early_payment_discount_applied, 0), 0);
    IF p_monto > v_saldo THEN
      RAISE EXCEPTION 'monto_mayor_que_saldo: el saldo es %; la plata de más se registra en la pantalla', v_saldo
        USING ERRCODE = 'P0001';
    END IF;
    IF p_tope IS NOT NULL AND p_monto > p_tope THEN
      RAISE EXCEPTION 'supera_tope: % supera el tope de % de la escuela para Mapi', p_monto, p_tope USING ERRCODE = 'P0001';
    END IF;
    v_es_abono := p_monto < v_saldo;
    v_resta    := v_saldo - p_monto;
  END IF;

  v_rf := jsonb_populate_record(NULL::public.payments, COALESCE(p_receipt_fields, '{}'::jsonb));

  FOR v_row IN
    SELECT id, amount FROM public.payments
     WHERE id = ANY (v_ids) AND school_id = p_school_id
     ORDER BY due_date, created_at, id
  LOOP
    v_i := v_i + 1;
    v_ref := CASE WHEN cardinality(v_ids) = 1 THEN p_reference_base ELSE p_reference_base || '-' || v_i END;

    UPDATE public.payments SET
      status           = CASE WHEN v_es_abono THEN 'partial' ELSE 'paid' END,
      payment_method   = p_method,
      payment_channel  = p_method,
      payment_date     = p_payment_date,
      approved_by      = v_uid,
      approved_at      = now(),
      reference        = v_ref,
      amount_paid      = CASE WHEN p_monto IS NULL THEN amount ELSE COALESCE(amount_paid, 0) + p_monto END,
      requires_review  = false,
      unblocked_at     = now(),
      unblocked_by     = v_uid,
      receipt_url      = CASE WHEN p_method <> 'transfer' THEN receipt_url
                              WHEN p_monto IS NULL     THEN p_receipt_url                     -- como hoy
                              ELSE COALESCE(p_receipt_url, receipt_url) END                   -- un abono no borra el soporte anterior
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

    v_total    := v_total + CASE WHEN p_monto IS NULL THEN COALESCE(v_row.amount, 0) ELSE p_monto END;
    v_paid_ids := v_paid_ids || v_row.id;
  END LOOP;

  -- Aviso a la familia (solo la _por: el modal de hoy avisa desde el navegador).
  IF p_avisar THEN
    SELECT COALESCE(p.parent_id,
                    (SELECT c.parent_id FROM public.children c WHERE c.id = p.child_id),
                    p.user_id)
      INTO v_dest
      FROM public.payments p WHERE p.id = v_paid_ids[1];
    IF v_dest IS NOT NULL THEN
      BEGIN
        SELECT NULLIF(btrim(s.name), '') INTO v_escuela FROM public.schools s WHERE s.id = p_school_id;
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category)
        SELECT v_dest, p_school_id,
               CASE WHEN v_es_abono THEN '💰 Abono registrado'
                    WHEN p_method = 'cash' THEN '✅ Pago en efectivo registrado'
                    ELSE '✅ Transferencia registrada' END,
               CASE WHEN v_es_abono
                    THEN format('%s registró un abono de %s por %s. Saldo pendiente: %s.',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(p_monto),
                                COALESCE(p.concept, 'tu cobro'), public._formato_cop(v_resta))
                    WHEN v_i = 1
                    THEN format('%s registró tu pago de %s por %s.',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_total),
                                COALESCE(p.concept, 'tu cobro'))
                    ELSE format('%s registró tu pago de %s (%s cobros).',
                                COALESCE(v_escuela, 'La escuela'), public._formato_cop(v_total), v_i)
               END,
               CASE WHEN v_es_abono THEN 'payment' ELSE 'success' END,
               '/my-payments', 'payment'
          FROM public.payments p WHERE p.id = v_paid_ids[1];
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'register_manual_payments: no se pudo avisar (%): %', SQLSTATE, SQLERRM;
      END;
    END IF;
  END IF;

  -- Misma respuesta de hoy; con monto, además si fue abono y el saldo.
  v_res := jsonb_build_object('payment_ids', to_jsonb(v_paid_ids), 'count', v_i, 'total', v_total);
  IF p_monto IS NOT NULL THEN
    v_res := v_res || jsonb_build_object('es_abono', v_es_abono, 'saldo_pendiente', v_resta);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_res := v_res || jsonb_build_object('ya_aplicada', false);
    INSERT INTO public.pago_operaciones (idempotency_key, tipo, canal, school_id, actor_id, payment_ids, monto, resultado)
    VALUES (p_idempotency_key, 'registrar_pago', p_canal, p_school_id, v_uid, v_paid_ids, v_total, v_res);
  END IF;
  RETURN v_res;
END;
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments_nucleo(uuid, uuid, uuid[], text, date, text, text, jsonb, numeric, numeric, boolean, numeric, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- La original: misma firma de 7 parámetros, mismo resultado; ahora delega.
CREATE OR REPLACE FUNCTION public.register_manual_payments(
    p_school_id uuid, p_payment_ids uuid[], p_method text, p_payment_date date, p_reference_base text,
    p_receipt_url text DEFAULT NULL::text, p_receipt_fields jsonb DEFAULT NULL::jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.register_manual_payments_nucleo(
    (SELECT auth.uid()), p_school_id, p_payment_ids, p_method, p_payment_date, p_reference_base,
    p_receipt_url, p_receipt_fields,
    NULL, NULL, false, NULL, NULL, 'app');
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments(uuid, uuid[], text, date, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_manual_payments(uuid, uuid[], text, date, text, text, jsonb) TO authenticated, service_role;

-- ── 7. registrar_pago_efectivo (Mapi): solo efectivo, UN cobro, sin pasar el saldo ──
CREATE OR REPLACE FUNCTION public.register_manual_payments_por(
    p_actor           uuid,
    p_school_id       uuid,
    p_payment_id      uuid,
    p_monto           numeric,
    p_pagado_antes    numeric,
    p_idempotency_key uuid,
    p_fecha           date    DEFAULT NULL,
    p_canal           text    DEFAULT 'mapi_whatsapp',
    p_tope            numeric DEFAULT NULL   -- el BFF solo puede BAJAR el de la escuela
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_hoy           date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_fecha         date;
  v_tope_escuela  numeric;
BEGIN
  PERFORM public._por_actuar_como(p_actor, p_school_id, 'admin');
  IF p_payment_id IS NULL OR p_monto IS NULL OR p_pagado_antes IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'faltan_datos: cobro, monto, pagado_antes e idempotency_key son obligatorios' USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NULL OR p_canal NOT IN ('mapi_app', 'mapi_whatsapp') THEN
    RAISE EXCEPTION 'canal_invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_tope IS NOT NULL AND p_tope <= 0 THEN
    RAISE EXCEPTION 'tope_invalido: el tope tiene que ser mayor que cero' USING ERRCODE = '22023';
  END IF;
  v_fecha := COALESCE(p_fecha, v_hoy);
  IF v_fecha > v_hoy THEN
    RAISE EXCEPTION 'fecha_futura: el pago no puede tener fecha futura' USING ERRCODE = '22023';
  END IF;
  SELECT ss.mapi_tope_aprobacion INTO v_tope_escuela FROM public.school_settings ss WHERE ss.school_id = p_school_id;
  v_tope_escuela := COALESCE(v_tope_escuela, 400000);

  RETURN public.register_manual_payments_nucleo(
    p_actor, p_school_id, ARRAY[p_payment_id],
    'cash',                                                  -- piloto: solo efectivo (§12 #5)
    v_fecha,
    'CASH-MAPI-' || upper(left(md5(p_idempotency_key::text), 8)),
    NULL, NULL,
    p_monto, p_pagado_antes,
    true,                                                    -- avisa a la familia
    LEAST(v_tope_escuela, COALESCE(p_tope, v_tope_escuela)),
    p_idempotency_key, p_canal);
END;
$$;
REVOKE ALL ON FUNCTION public.register_manual_payments_por(uuid, uuid, uuid, numeric, numeric, uuid, date, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_manual_payments_por(uuid, uuid, uuid, numeric, numeric, uuid, date, text, numeric) TO service_role;

COMMIT;
