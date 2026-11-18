-- =============================================================================
-- 20261118124124_wa_comprobantes_por_clasificar.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-18   Versión anterior: 20261117115141
-- Objetivo: que un comprobante de WhatsApp con dinero real nunca se quede en la
--   bandeja. Cuando el bot no sabe a qué cobro va (sin dueño, monto distinto,
--   otro concepto, la escuela tomó el chat…), el BFF lo registra aquí con su
--   etiqueta y su propuesta, y la escuela lo decide desde Cobros.
--   Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md (fase 2).
--
-- POR QUÉ UNA TABLA PROPIA Y NO UNA FILA EN payments:
--   payments tiene 25 triggers (notificar a la familia, saldo a favor, descuentos,
--   extender matrícula, gastos por comisión…) y 13 caminos que lo crean. Una fila
--   sin deportista rompería agregaciones de ingreso y reportes. Esta tabla no toca
--   payments: cuando la escuela decide, el BFF crea/estampa el cobro real con los
--   caminos de siempre y cierra esta fila con wa_comprobante_por_clasificar_aplicar.
--
-- QUÉ HACE:
--   1. Tabla wa_comprobantes_por_clasificar (RLS: solo lectura para los admin de
--      la escuela; ninguna policy de escritura — escribe service_role vía RPC).
--   2. wa_crear_comprobante_por_clasificar   (solo service_role; idempotente).
--   3. wa_comprobante_por_clasificar_aplicar (solo service_role; cierra la fila).
--   4. wa_comprobante_por_clasificar_descartar (authenticated; gate adentro).
-- NO aprueba pagos, NO crea payments, NO escribe a las familias.
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

-- ─── 1. Tabla ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wa_comprobantes_por_clasificar (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id         uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    queue_id          uuid NOT NULL REFERENCES public.whatsapp_inbound_queue(id) ON DELETE CASCADE,
    -- Quién lo mandó (el teléfono como lo guarda la cola; el nombre es el del chat).
    contacto          text,
    contacto_nombre   text,
    -- Lo que dice el comprobante (lectura del OCR, ya persistida en la cola).
    monto             numeric(14, 2) NOT NULL,
    referencia        text,
    fecha_comprobante date,
    banco             text,
    destino           text,
    storage_path      text,
    -- Lo que el sistema cree que es y por qué el bot no lo aplicó solo.
    etiqueta          text NOT NULL,
    propuesta         jsonb NOT NULL DEFAULT '{}'::jsonb,
    motivo_bot        text,
    -- Ciclo de vida.
    estado            text NOT NULL DEFAULT 'por_clasificar',
    payment_id        uuid REFERENCES public.payments(id) ON DELETE SET NULL,
    resolucion        text,
    nota              text,
    resuelto_por      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    resuelto_at       timestamptz,
    -- Aviso de envejecimiento (job de las 24 h): cuándo se avisó, para no repetir.
    avisado_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT wa_comprobantes_pc_monto_positivo CHECK (monto > 0),
    CONSTRAINT wa_comprobantes_pc_estado_check
        CHECK (estado IN ('por_clasificar', 'aplicado', 'descartado')),
    CONSTRAINT wa_comprobantes_pc_etiqueta_check
        CHECK (etiqueta IN ('abono_de_cobro', 'saldo_de_cobro', 'servicio_nuevo', 'inscripcion',
                            'clase_de_prueba', 'articulo', 'mensualidad', 'exceso', 'repetido',
                            'por_identificar', 'fuera_de_sportmaps', 'otro')),
    CONSTRAINT wa_comprobantes_pc_nota_largo
        CHECK (nota IS NULL OR length(nota) <= 500),
    -- Cerrado ⇔ con quién/cuándo (aplicado puede venir de un job sin usuario).
    CONSTRAINT wa_comprobantes_pc_cierre_coherente
        CHECK ((estado = 'por_clasificar' AND resuelto_at IS NULL)
            OR (estado <> 'por_clasificar' AND resuelto_at IS NOT NULL))
);

COMMENT ON TABLE public.wa_comprobantes_por_clasificar IS
    'Comprobantes de WhatsApp con dinero real que el bot no aplicó solo. La escuela los decide desde Cobros. Escribe service_role (RPC); los admin de la escuela leen. Spec: docs/specs/whatsapp-comprobantes-nunca-en-la-bandeja.md';

-- Una fila por fila de la cola (idempotencia del worker).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_comprobantes_pc_queue
    ON public.wa_comprobantes_por_clasificar (queue_id);

-- Un mismo comprobante (misma referencia de banco) no se duplica mientras sigue abierto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_comprobantes_pc_referencia_abierta
    ON public.wa_comprobantes_por_clasificar (school_id, referencia)
    WHERE referencia IS NOT NULL AND estado = 'por_clasificar';

-- La lista de Cobros y el job de las 24 h leen «abiertos de esta escuela por antigüedad».
CREATE INDEX IF NOT EXISTS idx_wa_comprobantes_pc_abiertos
    ON public.wa_comprobantes_por_clasificar (school_id, created_at)
    WHERE estado = 'por_clasificar';

CREATE TRIGGER trg_wa_comprobantes_pc_updated_at
    BEFORE UPDATE ON public.wa_comprobantes_por_clasificar
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 2. RLS: lectura para la administración; escritura solo por RPC ─────────

ALTER TABLE public.wa_comprobantes_por_clasificar ENABLE ROW LEVEL SECURITY;

-- Sin FOR ALL (invariante I3) y sin policy de escritura: el UPDATE/INSERT/DELETE
-- directo de un cliente queda rechazado por RLS. user_admin_school_ids() = quien
-- ADMINISTRA la escuela (sin coaches, sin padres ni atletas): es plata y comprobantes.
CREATE POLICY wa_comprobantes_pc_select_admin
    ON public.wa_comprobantes_por_clasificar
    FOR SELECT
    TO authenticated
    USING (school_id = ANY (public.user_admin_school_ids()));

REVOKE ALL ON TABLE public.wa_comprobantes_por_clasificar FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.wa_comprobantes_por_clasificar TO authenticated;
GRANT ALL    ON TABLE public.wa_comprobantes_por_clasificar TO service_role;

-- ─── 3. Crear (la llama el worker del BFF; solo service_role) ───────────────

CREATE OR REPLACE FUNCTION public.wa_crear_comprobante_por_clasificar(
    p_school_id       uuid,
    p_queue_id        uuid,
    p_etiqueta        text,
    p_monto           numeric,
    p_referencia      text DEFAULT NULL,
    p_fecha           date DEFAULT NULL,
    p_banco           text DEFAULT NULL,
    p_destino         text DEFAULT NULL,
    p_storage_path    text DEFAULT NULL,
    p_contacto        text DEFAULT NULL,
    p_contacto_nombre text DEFAULT NULL,
    p_motivo_bot      text DEFAULT NULL,
    p_propuesta       jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_prev   public.wa_comprobantes_por_clasificar%ROWTYPE;
    v_pago   record;
    v_ref    text := NULLIF(btrim(p_referencia), '');
    v_id     uuid;
    v_ya        boolean := false;
    v_repetido  boolean := false;
BEGIN
    IF p_school_id IS NULL OR p_queue_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'parametros');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'monto_invalido');
    END IF;
    IF p_etiqueta IS NULL OR p_etiqueta NOT IN (
        'abono_de_cobro', 'saldo_de_cobro', 'servicio_nuevo', 'inscripcion', 'clase_de_prueba',
        'articulo', 'mensualidad', 'exceso', 'repetido', 'por_identificar', 'fuera_de_sportmaps', 'otro'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'etiqueta_invalida');
    END IF;
    IF p_propuesta IS NOT NULL AND jsonb_typeof(p_propuesta) <> 'object' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'propuesta_invalida');
    END IF;

    -- 1. Idempotencia: la misma fila de la cola ya está registrada.
    SELECT * INTO v_prev FROM public.wa_comprobantes_por_clasificar WHERE queue_id = p_queue_id;
    IF FOUND THEN
        RETURN jsonb_build_object('ok', true, 'id', v_prev.id, 'estado', v_prev.estado, 'ya_existia', true);
    END IF;

    -- 2. La fila de la cola es de ESTA escuela (el BFF no decide a qué escuela pertenece).
    IF NOT EXISTS (
        SELECT 1 FROM public.whatsapp_inbound_queue q
         WHERE q.id = p_queue_id AND q.school_id = p_school_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'cola_ajena');
    END IF;

    -- 3. Antiduplicado: esa referencia de banco ya es de un pago de la escuela.
    IF v_ref IS NOT NULL THEN
        SELECT p.id, p.status, p.amount, p.concept INTO v_pago
          FROM public.payments p
         WHERE p.school_id = p_school_id AND p.ocr_reference = v_ref
           AND p.status NOT IN ('cancelled', 'rejected', 'failed')
         LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'referencia_ya_usada',
                                      'payment_id', v_pago.id, 'estado_pago', v_pago.status);
        END IF;
    END IF;

    BEGIN
        INSERT INTO public.wa_comprobantes_por_clasificar (
            school_id, queue_id, contacto, contacto_nombre, monto, referencia, fecha_comprobante,
            banco, destino, storage_path, etiqueta, propuesta, motivo_bot
        ) VALUES (
            p_school_id, p_queue_id, left(p_contacto, 80), left(p_contacto_nombre, 160), p_monto, v_ref, p_fecha,
            left(p_banco, 80), left(p_destino, 120), p_storage_path, p_etiqueta,
            COALESCE(p_propuesta, '{}'::jsonb), left(p_motivo_bot, 600)
        )
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        -- Otra corrida del worker (o el mismo comprobante reenviado) llegó primero.
        SELECT * INTO v_prev FROM public.wa_comprobantes_por_clasificar
         WHERE queue_id = p_queue_id
            OR (school_id = p_school_id AND referencia IS NOT DISTINCT FROM v_ref
                AND v_ref IS NOT NULL AND estado = 'por_clasificar')
         ORDER BY (queue_id = p_queue_id) DESC
         LIMIT 1;
        IF NOT FOUND THEN
            RAISE;
        END IF;
        v_id := v_prev.id;
        v_ya := true;
        v_repetido := v_prev.queue_id <> p_queue_id;
    END;

    -- 4. La fila sale de la bandeja: se marca como cerrada con el prefijo que la
    --    bandeja ya entiende (whatsapp-bandeja.service: «cerrado_escuela: <acción> — …
    --    | <motivo original>»). Solo si sigue en un estado de bandeja y no está cerrada.
    UPDATE public.whatsapp_inbound_queue q
       SET error_message = left(
               'cerrado_escuela: resuelto_auto — pasó a «Por clasificar» en Cobros | '
               || COALESCE(q.error_message, ''), 1000)
     WHERE q.id = p_queue_id
       AND q.status IN ('failed', 'ignored', 'waiting_user')
       AND COALESCE(q.error_message, '') NOT LIKE 'cerrado\_escuela:%';

    RETURN jsonb_build_object('ok', true, 'id', v_id, 'estado', 'por_clasificar',
                              'ya_existia', v_ya, 'repetido', v_repetido);
END;
$$;

COMMENT ON FUNCTION public.wa_crear_comprobante_por_clasificar IS
    'Registra un comprobante con dinero que el bot no aplicó solo y lo saca de la bandeja. Idempotente por fila de la cola; no crea payments ni escribe a las familias. Solo service_role.';

REVOKE ALL ON FUNCTION public.wa_crear_comprobante_por_clasificar(
    uuid, uuid, text, numeric, text, date, text, text, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_crear_comprobante_por_clasificar(
    uuid, uuid, text, numeric, text, date, text, text, text, text, text, text, jsonb
) TO service_role;

-- ─── 4. Cerrar como aplicado (la llama el BFF cuando la escuela decide) ─────

CREATE OR REPLACE FUNCTION public.wa_comprobante_por_clasificar_aplicar(
    p_id          uuid,
    p_payment_id  uuid,
    p_resolucion  text DEFAULT NULL,
    p_por         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_fila public.wa_comprobantes_por_clasificar%ROWTYPE;
BEGIN
    IF p_id IS NULL OR p_payment_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'parametros');
    END IF;

    SELECT * INTO v_fila FROM public.wa_comprobantes_por_clasificar WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'no_existe');
    END IF;
    IF v_fila.estado = 'aplicado' AND v_fila.payment_id IS NOT DISTINCT FROM p_payment_id THEN
        RETURN jsonb_build_object('ok', true, 'ya_aplicado', true);
    END IF;
    IF v_fila.estado <> 'por_clasificar' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ya_cerrado', 'estado', v_fila.estado);
    END IF;

    -- El pago debe ser de la MISMA escuela: un comprobante no se aplica al cobro de otra.
    IF NOT EXISTS (
        SELECT 1 FROM public.payments p WHERE p.id = p_payment_id AND p.school_id = v_fila.school_id
    ) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'pago_ajeno');
    END IF;

    UPDATE public.wa_comprobantes_por_clasificar
       SET estado = 'aplicado', payment_id = p_payment_id,
           resolucion = left(p_resolucion, 200), resuelto_por = p_por, resuelto_at = now()
     WHERE id = p_id;

    RETURN jsonb_build_object('ok', true, 'ya_aplicado', false);
END;
$$;

COMMENT ON FUNCTION public.wa_comprobante_por_clasificar_aplicar IS
    'Cierra un comprobante por clasificar ligándolo al cobro donde la escuela lo aplicó. El estampado del comprobante en el cobro lo hace el BFF antes. Solo service_role.';

REVOKE ALL ON FUNCTION public.wa_comprobante_por_clasificar_aplicar(uuid, uuid, text, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_comprobante_por_clasificar_aplicar(uuid, uuid, text, uuid)
    TO service_role;

-- ─── 5. Descartar (la llama la escuela; gate adentro, atado a ESA fila) ─────

CREATE OR REPLACE FUNCTION public.wa_comprobante_por_clasificar_descartar(
    p_id     uuid,
    p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_fila public.wa_comprobantes_por_clasificar%ROWTYPE;
    v_uid  uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Requiere sesión' USING ERRCODE = '42501';
    END IF;
    IF p_id IS NULL OR NULLIF(btrim(p_motivo), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'motivo_requerido');
    END IF;

    SELECT * INTO v_fila FROM public.wa_comprobantes_por_clasificar WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'no_existe');
    END IF;

    -- Alcance sobre la escuela de ESTA fila (no «¿es admin de alguna escuela?»).
    IF NOT (v_fila.school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Sin permisos sobre esta escuela' USING ERRCODE = '42501';
    END IF;

    IF v_fila.estado = 'descartado' THEN
        RETURN jsonb_build_object('ok', true, 'ya_descartado', true);
    END IF;
    IF v_fila.estado <> 'por_clasificar' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ya_cerrado', 'estado', v_fila.estado);
    END IF;

    UPDATE public.wa_comprobantes_por_clasificar
       SET estado = 'descartado', resolucion = 'descartado', nota = left(btrim(p_motivo), 500),
           resuelto_por = v_uid, resuelto_at = now()
     WHERE id = p_id;

    RETURN jsonb_build_object('ok', true, 'ya_descartado', false);
END;
$$;

COMMENT ON FUNCTION public.wa_comprobante_por_clasificar_descartar IS
    'La administración de la escuela descarta un comprobante por clasificar (no es nuestro, repetido, ya resuelto) con un motivo. No toca payments.';

REVOKE ALL ON FUNCTION public.wa_comprobante_por_clasificar_descartar(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.wa_comprobante_por_clasificar_descartar(uuid, text) TO authenticated;

COMMIT;
