-- =============================================================================
-- 20261030123549_comprobantes_con_motivo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-30   Versión anterior: 20261030123543
-- Objetivo: M2 del plan maestro del bot de WhatsApp de Monster
-- (docs/specs/whatsapp-monster-plan-maestro.md §2; base: plan B4 §2, M1-M5).
--   · Interruptor por escuela school_settings.wa_cobro_desde_comprobante (nace
--     apagado: sin él, la cola de comprobantes queda exactamente como hoy).
--   · Precios de servicios (school_tournament_items): precio de afiliado, precio
--     por fecha, abono mínimo y opciones (p. ej. semanas del vacacional).
--   · whatsapp_conceptos_esperados: el motivo que el bot espera del próximo
--     comprobante de un número (solo BFF).
--   · wa_cobros_desde_comprobante: marca «lo creó el asistente» + idempotencia
--     por fila de la cola (solo BFF).
--   · wa_es_afiliado: reconoce al afiliado por celular (145 de 148 deportistas de
--     Monster no tienen cuenta). Solo para precio y saludo: no devuelve datos.
--   · wa_crear_cobro_desde_comprobante: crea el cobro con el precio de la FUENTE,
--     nunca el del BFF.
--   · M5 del plan B4: registrar_pago_clase_prueba y listar_cobros_clase_prueba
--     solo cuentan cobros payment_category = 'clase_prueba' (hoy una matrícula
--     del prospecto bloqueaba registrar la clase). _mover_pago_clase_prueba NO se
--     toca: al inscribirse pasan TODOS los pagos del prospecto.
-- No se crea la categoría «evento»: la clínica es clase_extra (plan B4 §1).
-- Depende de 20261030123543 (cupo_separado_slot_id para la fecha de la clase).
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

-- ── M1. Interruptor por escuela ──────────────────────────────────────────────
-- Sin pantalla en esta entrega: lo prende SportMaps por SQL (como
-- tournament_charges_enabled).
ALTER TABLE public.school_settings
    ADD COLUMN wa_cobro_desde_comprobante boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.school_settings.wa_cobro_desde_comprobante IS
    'Bot de WhatsApp: crear el cobro desde el comprobante cuando el motivo tiene precio en la escuela (motivo por monto). '
    'Default false = la cola de comprobantes como antes. (20261030123549)';

-- ── Precios de servicios (D6 de Monster: clínica y vacacional) ───────────────
ALTER TABLE public.school_tournament_items
    ADD COLUMN precio_afiliado numeric
        CONSTRAINT school_tournament_items_precio_afiliado_check
        CHECK (precio_afiliado IS NULL OR precio_afiliado >= 0),
    ADD COLUMN precios_por_fecha jsonb
        CONSTRAINT school_tournament_items_precios_por_fecha_check
        CHECK (precios_por_fecha IS NULL OR (
            jsonb_typeof(precios_por_fecha) = 'array'
            AND jsonb_array_length(precios_por_fecha) BETWEEN 1 AND 12
            AND NOT (precios_por_fecha @? '$[*] ? (@.type() != "object"
                || !(exists(@.desde)) || !(exists(@.precio))
                || @.desde.type() != "string" || @.precio.type() != "number"
                || !(@.desde like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
                || @.precio < 0)'))),
    ADD COLUMN abono_minimo_pct smallint
        CONSTRAINT school_tournament_items_abono_minimo_pct_check
        CHECK (abono_minimo_pct IS NULL OR abono_minimo_pct BETWEEN 1 AND 100),
    ADD COLUMN opciones jsonb
        CONSTRAINT school_tournament_items_opciones_check
        CHECK (opciones IS NULL OR (
            jsonb_typeof(opciones) = 'array'
            AND jsonb_array_length(opciones) BETWEEN 1 AND 20
            AND NOT (opciones @? '$[*] ? (@.type() != "object"
                || !(exists(@.clave)) || !(exists(@.etiqueta)) || !(exists(@.precio))
                || @.clave.type() != "string" || @.etiqueta.type() != "string" || @.precio.type() != "number"
                || !(@.clave like_regex "^[a-z0-9_]{1,30}$")
                || @.precio < 0
                || (exists(@.precio_afiliado) && @.precio_afiliado.type() != "number" && @.precio_afiliado.type() != "null"))')));

COMMENT ON COLUMN public.school_tournament_items.precio_afiliado IS
    'Precio para deportistas/familias del club (reconocidos por cuenta o por celular). NULL = el mismo precio. (20261030123549)';
COMMENT ON COLUMN public.school_tournament_items.precios_por_fecha IS
    '[{desde: YYYY-MM-DD, precio}]: desde esa fecha (Bogotá) el precio cambia; antes de la primera, rige price. '
    'No aplica al precio de afiliado ni a las opciones. (20261030123549)';
COMMENT ON COLUMN public.school_tournament_items.abono_minimo_pct IS
    'Con allow_installments: el comprobante de al menos este % del precio separa el cupo; el cobro se crea por el '
    'precio completo y queda como abono. (20261030123549)';
COMMENT ON COLUMN public.school_tournament_items.opciones IS
    '[{clave, etiqueta, precio, precio_afiliado?}]: variantes con su precio (p. ej. 1-4 semanas del vacacional). '
    'Con opciones, el cobro exige la clave. (20261030123549)';

-- ── M2. Motivo esperado (lo escribe registrarConceptoEsperado; lo consume la cola)
CREATE TABLE public.whatsapp_conceptos_esperados (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id       uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    telefono        text        NOT NULL CHECK (telefono ~ '^[0-9]{10,15}$'),   -- = contact_wa_id
    motivo          text        NOT NULL CHECK (motivo = ANY (ARRAY[
                        'mensualidad', 'inscripcion', 'articulos', 'torneo', 'otro', 'seguro',
                        'excedente', 'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba'])),
    monto           numeric     CHECK (monto IS NULL OR monto > 0),
    signup_lead_id  uuid        REFERENCES public.school_signup_leads(id) ON DELETE CASCADE,
    child_id        uuid        REFERENCES public.children(id) ON DELETE CASCADE,
    origen          text        NOT NULL DEFAULT 'bot' CHECK (origen IN ('clase_prueba', 'venta', 'bot')),
    vence_en        timestamptz NOT NULL,
    consumido_at    timestamptz,
    payment_id      uuid        REFERENCES public.payments(id) ON DELETE SET NULL,
    queue_id        uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wa_conceptos_esperados_un_dueno_chk CHECK (num_nonnulls(signup_lead_id, child_id) <= 1)
);

COMMENT ON TABLE public.whatsapp_conceptos_esperados IS
    'Motivo que el bot espera del próximo comprobante de un número (clase de prueba, matrícula, uniformes…). '
    'Uno vivo por escuela + teléfono + motivo + dueño. Solo service role (RLS sin policies). (20261030123549)';

-- Un esperado vivo por escuela + teléfono + motivo + dueño: el «upsert» de los 3
-- BFF no puede dejar dos. También sirve la lectura por (school_id, telefono).
CREATE UNIQUE INDEX uq_wa_conceptos_vivos
    ON public.whatsapp_conceptos_esperados (
        school_id, telefono, motivo,
        COALESCE(signup_lead_id, child_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE consumido_at IS NULL;
CREATE INDEX idx_wa_conceptos_lead
    ON public.whatsapp_conceptos_esperados (signup_lead_id) WHERE signup_lead_id IS NOT NULL;

ALTER TABLE public.whatsapp_conceptos_esperados ENABLE ROW LEVEL SECURITY;
-- Sin policies, a propósito: nadie la lee ni la escribe desde el navegador.
REVOKE ALL ON public.whatsapp_conceptos_esperados FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_conceptos_esperados TO service_role;

-- ── M3. «Lo creó el asistente desde un comprobante» + idempotencia ───────────
-- Un comprobante (fila de la cola) puede crear más de un cobro (combinación:
-- matrícula + uniformes), pero uno solo por fuente.
CREATE TABLE public.wa_cobros_desde_comprobante (
    payment_id           uuid        PRIMARY KEY REFERENCES public.payments(id) ON DELETE CASCADE,
    school_id            uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    queue_id             uuid        NOT NULL,
    fuente               text        NOT NULL CHECK (fuente IN ('trial_price', 'registration_fee',
                                                                'merchandise_item', 'tournament_item')),
    fuente_id            uuid,
    opcion               text        CHECK (opcion IS NULL OR length(opcion) BETWEEN 1 AND 30),
    es_abono             boolean     NOT NULL DEFAULT false,
    concepto_esperado_id uuid        REFERENCES public.whatsapp_conceptos_esperados(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT wa_cobros_desde_comprobante_uq UNIQUE NULLS NOT DISTINCT (queue_id, fuente, fuente_id)
);

COMMENT ON TABLE public.wa_cobros_desde_comprobante IS
    'Cobros creados por wa_crear_cobro_desde_comprobante: fuente del precio, opción, abono e idempotencia por fila '
    'de la cola. Solo service role (RLS sin policies). (20261030123549)';

CREATE INDEX idx_wa_cobros_comprobante_item
    ON public.wa_cobros_desde_comprobante (fuente_id) WHERE fuente = 'tournament_item';

ALTER TABLE public.wa_cobros_desde_comprobante ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_cobros_desde_comprobante FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wa_cobros_desde_comprobante TO service_role;

-- ── Afiliado por celular (solo service_role) ─────────────────────────────────
-- Mismas fuentes que wa_identify_by_phone / wa_es_familia_sin_registrar, pero
-- todas acotadas a ESTA escuela (se parte de sus deportistas y se va al perfil
-- por PK: no se barre profiles). Devuelve solo {afiliado, fuente}: ni nombres
-- ni ids, porque un celular compartido no prueba identidad.
CREATE FUNCTION public.wa_es_afiliado(p_school_id uuid, p_telefono text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_tel text := public.wa_celular_remitente_co(p_telefono);
BEGIN
    IF p_school_id IS NULL OR v_tel IS NULL THEN
        RETURN jsonb_build_object('afiliado', false, 'fuente', NULL);
    END IF;

    -- Acudiente sin cuenta (children.parent_phone_temp; índice idx_children_tel10).
    IF EXISTS (
        SELECT 1 FROM public.children c
         WHERE c.school_id = p_school_id AND c.is_active AND c.parent_phone_temp IS NOT NULL
           AND right(regexp_replace(COALESCE(c.parent_phone_temp, ''), '[^0-9]', '', 'g'), 10) = v_tel
    ) THEN
        RETURN jsonb_build_object('afiliado', true, 'fuente', 'acudiente_sin_cuenta');
    END IF;

    -- Deportista sin cuenta (unregistered_athletes: su celular o el del acudiente).
    IF EXISTS (
        SELECT 1 FROM public.unregistered_athletes ua
         WHERE ua.school_id = p_school_id AND ua.is_active
           AND (   right(regexp_replace(COALESCE(ua.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = v_tel
                OR right(regexp_replace(COALESCE(ua.phone, ''), '[^0-9]', '', 'g'), 10) = v_tel)
    ) THEN
        RETURN jsonb_build_object('afiliado', true, 'fuente', 'deportista_sin_cuenta');
    END IF;

    -- Con cuenta: acudiente de un deportista activo, miembro deportista/acudiente
    -- activo o deportista adulto inscrito.
    IF EXISTS (
        SELECT 1 FROM public.children c JOIN public.profiles p ON p.id = c.parent_id
         WHERE c.school_id = p_school_id AND c.is_active
           AND right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_tel
    ) OR EXISTS (
        SELECT 1 FROM public.school_members sm JOIN public.profiles p ON p.id = sm.profile_id
         WHERE sm.school_id = p_school_id AND sm.status = 'active' AND sm.role IN ('parent', 'athlete')
           AND right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_tel
    ) OR EXISTS (
        SELECT 1 FROM public.enrollments e JOIN public.profiles p ON p.id = e.user_id
         WHERE e.school_id = p_school_id AND e.status IN ('active', 'pending')
           AND right(regexp_replace(COALESCE(p.phone, ''), '[^0-9]', '', 'g'), 10) = v_tel
    ) THEN
        RETURN jsonb_build_object('afiliado', true, 'fuente', 'cuenta');
    END IF;

    RETURN jsonb_build_object('afiliado', false, 'fuente', NULL);
END;
$$;

COMMENT ON FUNCTION public.wa_es_afiliado(uuid, text) IS
    '¿El celular es de una familia o deportista activo de la escuela? Solo para precio de afiliado y saludo; '
    'no devuelve datos de nadie. Solo service role. (20261030123549)';

REVOKE ALL ON FUNCTION public.wa_es_afiliado(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_es_afiliado(uuid, text) TO service_role;

-- ── M4. Crear el cobro desde el comprobante (solo BFF) ───────────────────────
-- Convención del repo para RPC solo-BFF (como wa_cubrir_cobros_con_comprobante):
-- no hay auth.uid(); el alcance es «todo pertenece a p_school_id». El precio sale
-- de la fuente; p_monto solo se compara (±$1) o se acepta como abono.
-- Errores de negocio en {ok:false, codigo}; nunca crea nada si algo no cuadra.
CREATE FUNCTION public.wa_crear_cobro_desde_comprobante(
    p_school_id            uuid,
    p_queue_id             uuid,
    p_categoria            text,
    p_monto                numeric,
    p_fuente               text,
    p_fuente_id            uuid,
    p_child_id             uuid,
    p_unregistered_id      uuid,
    p_signup_lead_id       uuid,
    p_concepto             text,
    p_concepto_esperado_id uuid DEFAULT NULL,
    p_opcion               text DEFAULT NULL,
    p_telefono             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    c_vivos    constant text[] := ARRAY['pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado'];
    c_abiertos constant text[] := ARRAY['pending', 'overdue', 'awaiting_approval', 'partial'];
    v_hoy        date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_prev       record;
    v_lead       public.school_signup_leads%ROWTYPE;
    v_item       public.school_tournament_items%ROWTYPE;
    v_parent     uuid;
    v_branch     uuid;
    v_nombre     text;
    v_categoria  text;
    v_precio     numeric;
    v_precio_af  numeric;
    v_precio_fec numeric;
    v_tallas     jsonb;
    v_articulo   text;
    v_opcion     jsonb;
    v_etiqueta   text;
    v_afiliado   boolean := false;
    v_es_abono   boolean := false;
    v_vivos      int;
    v_existente  uuid;
    v_due        date := v_hoy;
    v_concepto   text;
    v_pid        uuid;
BEGIN
    IF p_school_id IS NULL OR p_queue_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'parametros');
    END IF;
    IF p_fuente IS NULL OR p_fuente NOT IN ('trial_price', 'registration_fee', 'merchandise_item', 'tournament_item')
       OR (p_fuente <> 'trial_price' AND p_fuente_id IS NULL) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'fuente_invalida');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'monto_invalido');
    END IF;
    IF num_nonnulls(p_child_id, p_unregistered_id, p_signup_lead_id) <> 1 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
    END IF;

    -- 1. Idempotencia: la misma fila de la cola con la misma fuente ya lo creó.
    SELECT w.payment_id, w.es_abono, p.amount, p.payment_category
      INTO v_prev
      FROM public.wa_cobros_desde_comprobante w
      JOIN public.payments p ON p.id = w.payment_id
     WHERE w.queue_id = p_queue_id AND w.fuente = p_fuente
       AND w.fuente_id IS NOT DISTINCT FROM p_fuente_id
       AND w.school_id = p_school_id;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'payment_id', v_prev.payment_id, 'precio', v_prev.amount,
                                  'es_abono', v_prev.es_abono, 'ya_existia', true,
                                  'categoria', v_prev.payment_category);
    END IF;

    IF NOT public.school_is_operational(p_school_id) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'escuela_no_operativa');
    END IF;

    -- 2. Dueño: uno solo y de ESTA escuela. parent_id sale de children, nunca del BFF.
    IF p_child_id IS NOT NULL THEN
        SELECT c.parent_id, c.branch_id, c.full_name INTO v_parent, v_branch, v_nombre
          FROM public.children c
         WHERE c.id = p_child_id AND c.school_id = p_school_id AND c.is_active;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
        v_afiliado := true;
    ELSIF p_unregistered_id IS NOT NULL THEN
        SELECT ua.branch_id, ua.full_name INTO v_branch, v_nombre
          FROM public.unregistered_athletes ua
         WHERE ua.id = p_unregistered_id AND ua.school_id = p_school_id AND ua.is_active;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
        v_afiliado := true;
    ELSE
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
        v_branch := v_lead.branch_id;
        v_nombre := v_lead.full_name;
    END IF;
    v_nombre := COALESCE(NULLIF(btrim(v_nombre), ''), 'Prospecto');

    IF NOT v_afiliado AND p_telefono IS NOT NULL THEN
        v_afiliado := COALESCE((public.wa_es_afiliado(p_school_id, p_telefono)->>'afiliado')::boolean, false);
    END IF;

    -- 3. Precio desde la fuente.
    IF p_fuente = 'trial_price' THEN
        IF p_signup_lead_id IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'requiere_prospecto');
        END IF;
        v_categoria := 'clase_prueba';
        SELECT s.trial_price INTO v_precio
          FROM public.school_trial_class_settings s WHERE s.school_id = p_school_id;
        IF COALESCE(v_precio, 0) <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
        END IF;
        -- 4. Una sola clase de prueba por prospecto.
        SELECT p.id INTO v_existente
          FROM public.payments p
         WHERE p.signup_lead_id = p_signup_lead_id
           AND p.payment_category = 'clase_prueba'
           AND p.status = ANY (c_vivos)
         ORDER BY p.created_at DESC
         LIMIT 1;
        IF v_existente IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_cobro', 'payment_id', v_existente);
        END IF;
        -- Vence el día de la clase (igual que registrar_pago_clase_prueba).
        v_due := COALESCE(
            CASE WHEN (v_lead.source_detail->>'fecha_clase') ~ '^\d{4}-\d{2}-\d{2}$'
                 THEN (v_lead.source_detail->>'fecha_clase')::date END,
            (SELECT ts.slot_date FROM public.school_trial_slots ts WHERE ts.id = v_lead.trial_slot_id),
            (SELECT ts.slot_date FROM public.school_trial_slots ts WHERE ts.id = v_lead.cupo_separado_slot_id),
            v_hoy);
        v_concepto := 'Clase de prueba — ' || v_nombre;

    ELSIF p_fuente = 'registration_fee' THEN
        v_categoria := 'inscripcion';
        SELECT op.registration_fee INTO v_precio
          FROM public.offering_plans op
         WHERE op.id = p_fuente_id AND op.school_id = p_school_id AND op.is_active;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'fuente_no_disponible');
        END IF;
        IF COALESCE(v_precio, 0) <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
        END IF;
        SELECT p.id INTO v_existente
          FROM public.payments p
         WHERE p.school_id = p_school_id
           AND p.payment_category = 'inscripcion'
           AND p.status = ANY (c_abiertos)
           AND CASE WHEN p_child_id IS NOT NULL THEN p.child_id = p_child_id
                    WHEN p_unregistered_id IS NOT NULL THEN p.unregistered_athlete_id = p_unregistered_id
                    ELSE p.signup_lead_id = p_signup_lead_id END
         LIMIT 1;
        IF v_existente IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_cobro', 'payment_id', v_existente);
        END IF;
        v_concepto := 'Inscripción — ' || v_nombre;

    ELSIF p_fuente = 'merchandise_item' THEN
        v_categoria := 'articulos';
        SELECT mi.price, mi.price_by_size, mi.name INTO v_precio, v_tallas, v_articulo
          FROM public.school_merchandise_items mi
         WHERE mi.id = p_fuente_id AND mi.school_id = p_school_id AND mi.active;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'fuente_no_disponible');
        END IF;
        IF p_opcion IS NOT NULL THEN
            -- La opción de un artículo es la talla de price_by_size ({"S": 45000, …}).
            IF v_tallas IS NULL OR jsonb_typeof(v_tallas) <> 'object' OR NOT (v_tallas ? p_opcion)
               OR jsonb_typeof(v_tallas->p_opcion) <> 'number' THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_invalida');
            END IF;
            v_precio := (v_tallas->>p_opcion)::numeric;
            v_etiqueta := p_opcion;
        ELSIF abs(v_precio - p_monto) > 1 AND jsonb_typeof(v_tallas) = 'object' THEN
            SELECT e.key, (e.value #>> '{}')::numeric INTO v_etiqueta, v_precio_fec
              FROM jsonb_each(v_tallas) e
             WHERE jsonb_typeof(e.value) = 'number'
               AND abs((e.value #>> '{}')::numeric - p_monto) <= 1
             ORDER BY e.key
             LIMIT 1;
            IF v_precio_fec IS NOT NULL THEN
                v_precio := v_precio_fec;
            END IF;
        END IF;
        IF COALESCE(v_precio, 0) <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
        END IF;
        v_concepto := v_articulo || COALESCE(' · talla ' || v_etiqueta, '') || ' — ' || v_nombre;

    ELSE -- tournament_item
        -- Candado del ítem: serializa cupos con wa_crear_cobro_suelto y los 3 BFF.
        SELECT * INTO v_item
          FROM public.school_tournament_items
         WHERE id = p_fuente_id AND school_id = p_school_id
           FOR UPDATE;
        IF NOT FOUND OR NOT v_item.active OR v_item.event_id IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
        END IF;
        IF COALESCE(v_item.ends_at, v_item.starts_at) IS NOT NULL
           AND COALESCE(v_item.ends_at, v_item.starts_at) <= now() THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'item_vencido');
        END IF;
        v_categoria := v_item.kind;

        IF jsonb_typeof(v_item.opciones) = 'array' AND jsonb_array_length(v_item.opciones) > 0 THEN
            IF p_opcion IS NULL THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_requerida');
            END IF;
            SELECT e INTO v_opcion
              FROM jsonb_array_elements(v_item.opciones) e
             WHERE e->>'clave' = p_opcion
             LIMIT 1;
            IF v_opcion IS NULL THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_invalida');
            END IF;
            v_precio    := (v_opcion->>'precio')::numeric;
            v_precio_af := (v_opcion->>'precio_afiliado')::numeric;
            v_etiqueta  := COALESCE(NULLIF(btrim(v_opcion->>'etiqueta'), ''), p_opcion);
        ELSE
            v_precio := v_item.price;
            -- Precio por fecha: la entrada más reciente con desde <= hoy (Bogotá).
            SELECT (e->>'precio')::numeric INTO v_precio_fec
              FROM jsonb_array_elements(COALESCE(v_item.precios_por_fecha, '[]'::jsonb)) e
             WHERE (e->>'desde')::date <= v_hoy
             ORDER BY (e->>'desde')::date DESC
             LIMIT 1;
            IF v_precio_fec IS NOT NULL THEN
                v_precio := v_precio_fec;
            END IF;
            v_precio_af := v_item.precio_afiliado;
        END IF;

        IF v_afiliado AND v_precio_af IS NOT NULL THEN
            v_precio := v_precio_af;
        END IF;
        IF COALESCE(v_precio, 0) <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
        END IF;

        -- Ya lo compró (cobro vivo del mismo ítem para el mismo dueño).
        SELECT w.payment_id INTO v_existente
          FROM public.wa_cobros_desde_comprobante w
          JOIN public.payments p ON p.id = w.payment_id
         WHERE w.fuente = 'tournament_item' AND w.fuente_id = v_item.id
           AND p.status = ANY (c_vivos)
           AND CASE WHEN p_child_id IS NOT NULL THEN p.child_id = p_child_id
                    WHEN p_unregistered_id IS NOT NULL THEN p.unregistered_athlete_id = p_unregistered_id
                    ELSE p.signup_lead_id = p_signup_lead_id END
         LIMIT 1;
        IF v_existente IS NULL AND p_child_id IS NOT NULL THEN
            SELECT ws.payment_id INTO v_existente
              FROM public.wa_cobros_sueltos ws
              JOIN public.payments p ON p.id = ws.payment_id
             WHERE ws.item_id = v_item.id AND ws.child_id = p_child_id AND p.status = ANY (c_vivos)
             LIMIT 1;
        END IF;
        IF v_existente IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_cobro', 'payment_id', v_existente);
        END IF;

        -- Cupos: los dos caminos que venden el ítem (exacto: el ítem está bloqueado).
        SELECT (SELECT count(*) FROM public.wa_cobros_sueltos ws JOIN public.payments p ON p.id = ws.payment_id
                 WHERE ws.item_id = v_item.id AND p.status = ANY (c_vivos))
             + (SELECT count(*) FROM public.wa_cobros_desde_comprobante w JOIN public.payments p ON p.id = w.payment_id
                 WHERE w.fuente = 'tournament_item' AND w.fuente_id = v_item.id AND p.status = ANY (c_vivos))
          INTO v_vivos;
        IF v_item.capacity IS NOT NULL AND v_vivos >= v_item.capacity THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_cupos');
        END IF;

        v_concepto := v_item.name || COALESCE(' · ' || v_etiqueta, '') || ' — ' || v_nombre;
    END IF;

    IF p_categoria IS NOT NULL AND p_categoria <> v_categoria THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'categoria_no_coincide', 'categoria', v_categoria);
    END IF;

    -- 5. Monto: igual al precio (±$1) o, en servicios con abono, al menos el mínimo.
    IF abs(v_precio - p_monto) > 1 THEN
        IF p_fuente = 'tournament_item' AND v_item.allow_installments AND v_item.abono_minimo_pct IS NOT NULL
           AND p_monto < v_precio
           AND p_monto >= ceil(v_precio * v_item.abono_minimo_pct / 100.0) - 1 THEN
            v_es_abono := true;
        ELSE
            RETURN jsonb_build_object(
                'ok', false, 'codigo', 'monto_no_coincide', 'precio', v_precio,
                'abono_minimo', CASE WHEN p_fuente = 'tournament_item' AND v_item.allow_installments
                                          AND v_item.abono_minimo_pct IS NOT NULL
                                     THEN ceil(v_precio * v_item.abono_minimo_pct / 100.0) END);
        END IF;
    END IF;

    IF p_concepto_esperado_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.whatsapp_conceptos_esperados ce
         WHERE ce.id = p_concepto_esperado_id AND ce.school_id = p_school_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'esperado_invalido');
    END IF;

    v_concepto := left(COALESCE(NULLIF(btrim(p_concepto), ''), v_concepto), 200);

    BEGIN
        INSERT INTO public.payments (
            school_id, parent_id, child_id, unregistered_athlete_id, signup_lead_id, branch_id,
            amount, concept, due_date, status, payment_type,
            payment_category, period_uniqueness_exempt, created_by, notes
        ) VALUES (
            p_school_id, v_parent, p_child_id, p_unregistered_id, p_signup_lead_id, v_branch,
            v_precio, v_concepto, v_due, 'pending', 'one_time',
            v_categoria, true, NULL,
            'Creado por el asistente desde un comprobante' || CASE WHEN v_es_abono THEN ' (abono)' ELSE '' END
        )
        RETURNING id INTO v_pid;

        INSERT INTO public.wa_cobros_desde_comprobante (
            payment_id, school_id, queue_id, fuente, fuente_id, opcion, es_abono, concepto_esperado_id
        ) VALUES (
            v_pid, p_school_id, p_queue_id, p_fuente, p_fuente_id,
            CASE WHEN p_fuente IN ('tournament_item', 'merchandise_item') THEN COALESCE(p_opcion, v_etiqueta) END,
            v_es_abono, p_concepto_esperado_id
        );
    EXCEPTION WHEN unique_violation THEN
        -- Otro BFF procesó la misma fila de la cola a la vez: el subbloque deshace
        -- el payment y se devuelve el que quedó.
        SELECT w.payment_id, w.es_abono, p.amount, p.payment_category
          INTO v_prev
          FROM public.wa_cobros_desde_comprobante w
          JOIN public.payments p ON p.id = w.payment_id
         WHERE w.queue_id = p_queue_id AND w.fuente = p_fuente
           AND w.fuente_id IS NOT DISTINCT FROM p_fuente_id;
        IF FOUND THEN
            RETURN jsonb_build_object('ok', true, 'payment_id', v_prev.payment_id, 'precio', v_prev.amount,
                                      'es_abono', v_prev.es_abono, 'ya_existia', true,
                                      'categoria', v_prev.payment_category);
        END IF;
        RAISE;
    END;

    -- Si el prospecto ya se inscribió, el cobro pasa a su estado de cuenta.
    IF p_signup_lead_id IS NOT NULL AND v_lead.converted_enrollment_id IS NOT NULL THEN
        PERFORM public._mover_pago_clase_prueba(p_signup_lead_id);
    END IF;

    RETURN jsonb_build_object(
        'ok', true, 'payment_id', v_pid, 'precio', v_precio, 'es_abono', v_es_abono, 'ya_existia', false,
        'categoria', v_categoria, 'concepto', v_concepto, 'afiliado', v_afiliado,
        'opcion', CASE WHEN p_fuente IN ('tournament_item', 'merchandise_item') THEN COALESCE(p_opcion, v_etiqueta) END);
END;
$$;

COMMENT ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text) IS
    'Bot de WhatsApp: crea UN cobro (pending) desde un comprobante con el precio de la fuente (trial_price, '
    'registration_fee, artículo, servicio con opción/afiliado/fecha/abono). Idempotente por (queue_id, fuente, '
    'fuente_id). {ok, payment_id, precio, es_abono, ya_existia} o {ok:false, codigo}. Solo service role. (20261030123549)';

REVOKE ALL ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text)
    TO service_role;

-- ── M5. Clase de prueba: solo cuentan los cobros de clase de prueba ──────────
-- Cuerpos VIVOS (pg_get_functiondef, 2026-10-30). Único cambio: el «ya pagada» y
-- el LATERAL filtran payment_category = 'clase_prueba'.
CREATE OR REPLACE FUNCTION public.registrar_pago_clase_prueba(p_lead_id uuid, p_monto numeric, p_metodo text, p_referencia text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_lead public.school_signup_leads%ROWTYPE;
    v_hoy date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_fecha date;
    v_ref text := NULLIF(btrim(COALESCE(p_referencia, '')), '');
    v_pago_id uuid;
BEGIN
    IF p_metodo IS NULL OR p_metodo NOT IN ('cash', 'transfer', 'card', 'other') THEN
        RAISE EXCEPTION 'METODO_INVALIDO' USING ERRCODE = '22023';
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RAISE EXCEPTION 'MONTO_INVALIDO' USING ERRCODE = '22023',
            HINT = 'El valor de la clase de prueba debe ser mayor que cero.';
    END IF;

    SELECT * INTO v_lead FROM public.school_signup_leads WHERE id = p_lead_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prospecto no encontrado' USING ERRCODE = '02000';
    END IF;
    IF NOT (public.is_super_admin() OR public.is_school_admin(v_lead.school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_lead.status = 'discarded' THEN
        RAISE EXCEPTION 'PROSPECTO_DESCARTADO' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.payments
         WHERE signup_lead_id = p_lead_id
           AND payment_category = 'clase_prueba'
           AND status IN ('paid', 'partial', 'awaiting_approval', 'pending', 'overdue')
    ) THEN
        RAISE EXCEPTION 'CLASE_PRUEBA_YA_PAGADA' USING ERRCODE = '23505';
    END IF;

    v_fecha := COALESCE(
        CASE WHEN (v_lead.source_detail->>'fecha_clase') ~ '^\d{4}-\d{2}-\d{2}$'
             THEN (v_lead.source_detail->>'fecha_clase')::date END,
        (SELECT ts.slot_date FROM public.school_trial_slots ts WHERE ts.id = v_lead.trial_slot_id),
        v_hoy);

    INSERT INTO public.payments (
        school_id, signup_lead_id, amount, amount_paid, concept,
        due_date, payment_date, status, payment_type, payment_method,
        payment_category, period_uniqueness_exempt,
        created_by, approved_by, approved_at, notes
    ) VALUES (
        v_lead.school_id, p_lead_id, p_monto, p_monto,
        'Clase de prueba — ' || COALESCE(NULLIF(btrim(v_lead.full_name), ''), 'Prospecto'),
        v_fecha, v_hoy, 'paid', 'one_time', p_metodo,
        'clase_prueba', true,
        auth.uid(), auth.uid(), now(),
        CASE WHEN v_ref IS NOT NULL THEN left('Referencia: ' || v_ref, 500) END
    )
    RETURNING id INTO v_pago_id;

    PERFORM public._mover_pago_clase_prueba(p_lead_id);

    RETURN jsonb_build_object('ok', true, 'payment_id', v_pago_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.registrar_pago_clase_prueba(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pago_clase_prueba(uuid, numeric, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.listar_cobros_clase_prueba(p_school_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_rows jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT l.id, l.full_name, l.guardian_name, l.phone, l.status, l.created_at,
               COALESCE(l.source_detail->>'canal',
                        CASE WHEN l.how_heard = 'whatsapp' THEN 'whatsapp' ELSE 'formulario' END) AS canal,
               l.source_detail->>'asistencia' AS asistencia,
               COALESCE(l.source_detail->>'fecha_clase', ts.slot_date::text) AS fecha_clase,
               pg.pago
          FROM public.school_signup_leads l
          LEFT JOIN public.school_trial_slots ts ON ts.id = l.trial_slot_id
          LEFT JOIN LATERAL (
              SELECT jsonb_build_object(
                         'id', p.id, 'monto', p.amount, 'metodo', p.payment_method,
                         'fecha', p.payment_date, 'estado', p.status) AS pago
                FROM public.payments p
               WHERE p.signup_lead_id = l.id
                 AND p.payment_category = 'clase_prueba'
                 AND p.status NOT IN ('cancelled', 'failed', 'rejected')
               ORDER BY p.created_at DESC
               LIMIT 1
          ) pg ON true
         WHERE l.school_id = p_school_id
           AND (l.status IN ('new', 'contacted') OR pg.pago IS NOT NULL)
         ORDER BY l.created_at DESC
         LIMIT 500
      ) t;

    RETURN jsonb_build_object(
        'valor', (SELECT s.trial_price FROM public.school_trial_class_settings s WHERE s.school_id = p_school_id),
        'prospectos', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.listar_cobros_clase_prueba(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_cobros_clase_prueba(uuid) TO authenticated;

COMMIT;
