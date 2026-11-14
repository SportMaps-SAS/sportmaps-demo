-- =============================================================================
-- 20261111114349_cobro_servicio_unificado.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-11   Versión anterior: 20261111105120
-- Objetivo: capa de BASE del «cobro de servicio unificado» (clínica, torneo,
-- viaje…), docs/specs/pago-manual-de-servicio.md v0.2 §4 y §5. Un mismo cobro
-- nace por tres caminos (la escuela en la app, el bot de WhatsApp y el registro
-- manual) y hoy no se reconocen entre sí: esta migración les da UN enlace al
-- ítem, UN precio vigente y UN conteo de cupos.
--
--   1. school_tournament_items: descuentos_grupo, precios_afiliado_por_fecha,
--      saldo_hasta (+ siembra SOLO de la clínica de Monster).
--   2. Tablas cobros_servicio_item (enlace pago ↔ ítem) y
--      cobros_servicio_movimientos (rastro idempotente de cada pago/abono).
--      RLS activo, sin policies, solo service_role (como wa_cobros_desde_comprobante).
--   3. Internas (sin EXECUTE para nadie): _servicio_precio_vigente,
--      _servicio_cupos_vivos, _servicio_grupo_cumple, _servicio_es_afiliado,
--      _servicio_cobros_del_dueno, _servicio_pago_ligado.
--   4. RPC para admins (authenticated; gate adentro): registrar_pago_servicio_manual,
--      ligar_cobro_a_servicio, reclasificar_pago_servicio.
--   5. RPC solo service_role: aplicar_comprobante_a_cobro_abierto.
--   6. wa_crear_cobro_desde_comprobante: 4º dueño (p_user_id), unregistered con
--      vínculo vivo aunque is_active=false, precio por _servicio_precio_vigente,
--      «ya lo compró» y cupos por los helpers. wa_crear_cobro_suelto: cupos por
--      _servicio_cupos_vivos. SE ELIMINA la firma vieja de 13 parámetros (si no,
--      PostgREST ve una sobrecarga ambigua).
--   7. auto_approve_payment: (a) solo la mensualidad activa inscripciones,
--      (b) el aviso va a COALESCE(parent_id, user_id).
--
-- NO crea datos de producción salvo la siembra del punto 1 (una fila). Las
-- correcciones de datos van aparte: docs/migraciones-para-aplicar-2026-11-11-cobro-servicio/.
-- UNA sola sesión aplica esto (cada DDL recarga el esquema de PostgREST) y
-- `gen types` se corre UNA vez al final.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
-- =============================================================================

BEGIN;

-- Valida que cada «desde» sea una fecha REAL (el regex del jsonpath deja pasar 2026-13-45).
-- Los CHECK no admiten subconsultas, por eso es una función. La evalúa quien escribe la fila
-- (admins de la escuela por la app): lleva GRANT EXECUTE a authenticated y service_role.
CREATE FUNCTION public._servicio_fechas_validas(p_arr jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    e jsonb;
    d date;
BEGIN
    IF jsonb_typeof(p_arr) IS DISTINCT FROM 'array' THEN
        RETURN false;
    END IF;
    FOR e IN SELECT value FROM jsonb_array_elements(p_arr) LOOP
        IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e->>'desde' IS NULL THEN
            RETURN false;
        END IF;
        BEGIN
            d := to_date(e->>'desde', 'YYYY-MM-DD');
            IF to_char(d, 'YYYY-MM-DD') <> e->>'desde' THEN
                RETURN false;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
    END LOOP;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public._servicio_fechas_validas(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._servicio_fechas_validas(jsonb) TO authenticated, service_role;

-- ── 1. Modelo del ítem ───────────────────────────────────────────────────────
ALTER TABLE public.school_tournament_items
    ADD COLUMN IF NOT EXISTS descuentos_grupo jsonb
        CONSTRAINT school_tournament_items_descuentos_grupo_check
        CHECK (descuentos_grupo IS NULL OR (
            jsonb_typeof(descuentos_grupo) = 'array'
            AND jsonb_array_length(descuentos_grupo) BETWEEN 1 AND 3
            AND NOT (descuentos_grupo @? '$[*] ? (@.type() != "object"
                || !(exists(@.clave)) || !(exists(@.pct)) || !(exists(@.minimo)) || !(exists(@.por))
                || @.clave.type() != "string" || @.pct.type() != "number"
                || @.minimo.type() != "number" || @.por.type() != "string"
                || !(@.clave like_regex "^[a-z0-9_]{1,30}$")
                || @.pct < 1 || @.pct > 90 || @.pct.floor() != @.pct
                || @.minimo < 2 || @.minimo > 100 || @.minimo.floor() != @.minimo
                || @.por != "equipo")'))),
    ADD COLUMN IF NOT EXISTS precios_afiliado_por_fecha jsonb
        CONSTRAINT school_tournament_items_precios_afiliado_por_fecha_check
        CHECK (precios_afiliado_por_fecha IS NULL OR (
            jsonb_typeof(precios_afiliado_por_fecha) = 'array'
            AND jsonb_array_length(precios_afiliado_por_fecha) BETWEEN 1 AND 12
            AND public._servicio_fechas_validas(precios_afiliado_por_fecha)
            AND NOT (precios_afiliado_por_fecha @? '$[*] ? (@.type() != "object"
                || !(exists(@.desde)) || !(exists(@.precio))
                || @.desde.type() != "string" || @.precio.type() != "number"
                || !(@.desde like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
                || @.precio < 0)'))),
    ADD COLUMN IF NOT EXISTS saldo_hasta date;

COMMENT ON COLUMN public.school_tournament_items.descuentos_grupo IS
    '[{clave, pct (1-90, entero), minimo (2-100, entero), por: "equipo"}]: descuento PORCENTUAL de grupo sobre el precio de '
    'afiliado vigente (250.000 x 0,7 = 175.000). Solo afiliados; el mínimo cuenta cobros del ítem del MISMO equipo. '
    '_servicio_precio_vigente usa la primera entrada salvo que se pida otra clave. (20261111114349)';
COMMENT ON COLUMN public.school_tournament_items.precios_afiliado_por_fecha IS
    '[{desde: YYYY-MM-DD, precio}]: desde esa fecha (Bogotá) cambia el precio de AFILIADO; antes de la primera rige '
    'precio_afiliado. Equivale a precios_por_fecha pero para afiliados. (20261111114349)';
COMMENT ON COLUMN public.school_tournament_items.saldo_hasta IS
    'Fecha límite para pagar el saldo de un abono (informativa: avisos y panel; no bloquea pagos). (20261111114349)';

-- Siembra: SOLO la clínica de armadores y atacantes de Monster's Volley Club.
-- Reglas de Iván (2026-11-11): afiliado 250.000 hasta el 15-nov y 300.000 desde el
-- 16-nov; con 30 % de grupo (mínimo 5 del mismo equipo) 175.000 y 210.000; saldo
-- antes del 20-nov. El externo ya vive en price/precios_por_fecha.
UPDATE public.school_tournament_items
   SET descuentos_grupo = '[{"clave":"equipo30","pct":30,"minimo":5,"por":"equipo"}]'::jsonb,
       precios_afiliado_por_fecha = '[{"desde":"2026-11-16","precio":300000}]'::jsonb,
       saldo_hasta = DATE '2026-11-20'
 WHERE id = '16766d2e-f8b0-4285-88e3-b1e67dda6d45'
   AND school_id = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';

-- ── 2. Tablas ────────────────────────────────────────────────────────────────
-- Enlace pago ↔ ítem. No se reutiliza wa_cobros_sueltos (exige parent_id y canal
-- whatsapp). Un pago, un enlace; el enlace anulado queda como historia.
CREATE TABLE public.cobros_servicio_item (
    payment_id       uuid        PRIMARY KEY REFERENCES public.payments(id) ON DELETE CASCADE,
    school_id        uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    item_id          uuid        NOT NULL REFERENCES public.school_tournament_items(id) ON DELETE RESTRICT,
    dueno_tipo       text        NOT NULL CHECK (dueno_tipo IN ('child', 'user', 'unregistered', 'lead')),
    dueno_id         uuid        NOT NULL,
    origen           text        NOT NULL CHECK (origen IN ('manual', 'ligado_escuela', 'comprobante_app', 'comprobante_bot')),
    opcion           text        CHECK (opcion IS NULL OR char_length(opcion) BETWEEN 1 AND 30),
    es_abono         boolean     NOT NULL DEFAULT false,
    precio_lista     numeric     CHECK (precio_lista IS NULL OR precio_lista >= 0),
    precio_acordado  numeric     CHECK (precio_acordado IS NULL OR precio_acordado > 0),
    motivo_precio    text,
    descuento_clave  text        CHECK (descuento_clave IS NULL OR descuento_clave ~ '^[a-z0-9_]{1,30}$'),
    team_id          uuid        REFERENCES public.teams(id) ON DELETE SET NULL,
    idempotency_key  text        CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200),
    queue_id         uuid,
    anulado_at       timestamptz,
    anulado_motivo   text,
    created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cobros_servicio_item_motivo_precio_chk
        CHECK (precio_acordado IS NULL OR (motivo_precio IS NOT NULL AND char_length(btrim(motivo_precio)) >= 10)),
    CONSTRAINT cobros_servicio_item_anulado_chk
        CHECK ((anulado_at IS NULL) = (anulado_motivo IS NULL))
);

COMMENT ON TABLE public.cobros_servicio_item IS
    'Enlace único pago ↔ ítem de servicio (clínica, torneo, viaje…): dueño, origen, precio de lista/acordado (con motivo), '
    'descuento de grupo, equipo e idempotencia. Lo escriben registrar_pago_servicio_manual, ligar_cobro_a_servicio y '
    'aplicar_comprobante_a_cobro_abierto. Solo service role / definer (RLS sin policies). (20261111114349)';

CREATE UNIQUE INDEX uq_cobros_servicio_item_clave
    ON public.cobros_servicio_item (school_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_cobros_servicio_item_queue
    ON public.cobros_servicio_item (queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX idx_cobros_servicio_item_item
    ON public.cobros_servicio_item (item_id);
CREATE INDEX idx_cobros_servicio_item_dueno
    ON public.cobros_servicio_item (school_id, dueno_tipo, dueno_id);

ALTER TABLE public.cobros_servicio_item ENABLE ROW LEVEL SECURITY;
-- Sin policies, a propósito: nadie la lee ni la escribe desde el navegador.
REVOKE ALL ON public.cobros_servicio_item FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cobros_servicio_item TO service_role;

-- Rastro de cada pago/abono/saldo. Un abono NO crea otra fila de enlace (el pago
-- es el mismo), así que la idempotencia de abonos y saldos vive aquí: una clave
-- (manual) o una fila de la cola (comprobante) aplica UNA vez.
CREATE TABLE public.cobros_servicio_movimientos (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id       uuid        NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
    school_id        uuid        NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    item_id          uuid,
    dueno_tipo       text        CHECK (dueno_tipo IS NULL OR dueno_tipo IN ('child', 'user', 'unregistered', 'lead')),
    dueno_id         uuid,
    tipo             text        NOT NULL CHECK (tipo IN ('pago', 'abono', 'saldo')),
    monto            numeric     NOT NULL CHECK (monto > 0),
    idempotency_key  text        CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 200),
    queue_id         uuid,
    origen           text        NOT NULL CHECK (origen IN ('manual', 'comprobante_app', 'comprobante_bot')),
    created_by       uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cobros_servicio_mov_llave_chk CHECK (idempotency_key IS NOT NULL OR queue_id IS NOT NULL)
);

COMMENT ON TABLE public.cobros_servicio_movimientos IS
    'Un movimiento por cada pago/abono/saldo aplicado a un cobro de servicio: idempotencia por clave o por fila de la cola. '
    'Solo service role / definer (RLS sin policies). (20261111114349)';

CREATE UNIQUE INDEX uq_cobros_servicio_mov_clave
    ON public.cobros_servicio_movimientos (school_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX uq_cobros_servicio_mov_queue
    ON public.cobros_servicio_movimientos (queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX idx_cobros_servicio_mov_payment
    ON public.cobros_servicio_movimientos (payment_id);

ALTER TABLE public.cobros_servicio_movimientos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cobros_servicio_movimientos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cobros_servicio_movimientos TO service_role;

-- ── 3. Funciones internas ────────────────────────────────────────────────────
-- Precio vigente a una fecha. Devuelve {ok, precio, lista, descuento_pct,
-- descuento_clave, etiqueta, afiliado} o {ok:false, codigo} (opción pedida/inválida).
--   · externo: price, pisado por la última entrada de precios_por_fecha con desde <= fecha;
--   · afiliado: la última de precios_afiliado_por_fecha, si no precio_afiliado, si no el externo;
--   · con p_grupo_cumple (solo afiliado) se aplica el pct de descuentos_grupo sobre el
--     precio de afiliado vigente (250.000 -> 175.000; 300.000 -> 210.000).
CREATE FUNCTION public._servicio_precio_vigente(
    p_item         public.school_tournament_items,
    p_fecha        date,
    p_afiliado     boolean,
    p_opcion       text,
    p_grupo_cumple boolean,
    p_clave        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_ext      numeric;
    v_af       numeric;
    v_tmp      numeric;
    v_lista    numeric;
    v_precio   numeric;
    v_opc      jsonb;
    v_desc     jsonb;
    v_pct      numeric;
    v_clave    text;
    v_etiqueta text;
BEGIN
    IF jsonb_typeof(p_item.opciones) = 'array' AND jsonb_array_length(p_item.opciones) > 0 THEN
        IF p_opcion IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_requerida');
        END IF;
        SELECT e INTO v_opc
          FROM jsonb_array_elements(p_item.opciones) e
         WHERE e->>'clave' = p_opcion
         LIMIT 1;
        IF v_opc IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'opcion_invalida');
        END IF;
        v_ext      := (v_opc->>'precio')::numeric;
        v_af       := (v_opc->>'precio_afiliado')::numeric;
        v_etiqueta := COALESCE(NULLIF(btrim(v_opc->>'etiqueta'), ''), p_opcion);
    ELSE
        v_ext := p_item.price;
        SELECT (e->>'precio')::numeric INTO v_tmp
          FROM jsonb_array_elements(COALESCE(p_item.precios_por_fecha, '[]'::jsonb)) e
         WHERE (e->>'desde')::date <= p_fecha
         ORDER BY (e->>'desde')::date DESC
         LIMIT 1;
        IF v_tmp IS NOT NULL THEN
            v_ext := v_tmp;
        END IF;

        v_af  := p_item.precio_afiliado;
        v_tmp := NULL;
        SELECT (e->>'precio')::numeric INTO v_tmp
          FROM jsonb_array_elements(COALESCE(p_item.precios_afiliado_por_fecha, '[]'::jsonb)) e
         WHERE (e->>'desde')::date <= p_fecha
         ORDER BY (e->>'desde')::date DESC
         LIMIT 1;
        IF v_tmp IS NOT NULL THEN
            v_af := v_tmp;
        END IF;
    END IF;

    IF COALESCE(p_afiliado, false) AND v_af IS NOT NULL THEN
        v_lista := v_af;
    ELSE
        v_lista := v_ext;
    END IF;
    v_precio := v_lista;

    IF COALESCE(p_afiliado, false) AND COALESCE(p_grupo_cumple, false)
       AND jsonb_typeof(p_item.descuentos_grupo) = 'array' THEN
        SELECT t.e INTO v_desc
          FROM jsonb_array_elements(p_item.descuentos_grupo) WITH ORDINALITY AS t(e, n)
         WHERE p_clave IS NULL OR t.e->>'clave' = p_clave
         ORDER BY t.n
         LIMIT 1;
        IF v_desc IS NOT NULL THEN
            v_pct    := (v_desc->>'pct')::numeric;
            v_clave  := v_desc->>'clave';
            v_precio := round(v_lista * (100 - v_pct) / 100, 2);
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'ok', true, 'precio', v_precio, 'lista', v_lista,
        'descuento_pct', v_pct, 'descuento_clave', v_clave,
        'etiqueta', v_etiqueta, 'afiliado', COALESCE(p_afiliado, false));
END;
$$;

COMMENT ON FUNCTION public._servicio_precio_vigente(public.school_tournament_items, date, boolean, text, boolean, text) IS
    'Interna: precio de un ítem de servicio a una fecha (externo / afiliado por fecha / descuento de grupo). (20261111114349)';

REVOKE ALL ON FUNCTION public._servicio_precio_vigente(public.school_tournament_items, date, boolean, text, boolean, text)
    FROM PUBLIC, anon, authenticated;

-- ¿Es afiliado ese dueño en esa escuela? child activo; user con school_members activo;
-- unregistered activo o con vínculo vivo a un perfil; lead nunca.
CREATE FUNCTION public._servicio_es_afiliado(p_school uuid, p_tipo text, p_dueno uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE p_tipo
        WHEN 'child' THEN EXISTS (
            SELECT 1 FROM public.children c
             WHERE c.id = p_dueno AND c.school_id = p_school AND c.is_active)
        WHEN 'user' THEN EXISTS (
            SELECT 1 FROM public.school_members sm
             WHERE sm.profile_id = p_dueno AND sm.school_id = p_school AND sm.status = 'active')
        WHEN 'unregistered' THEN EXISTS (
            SELECT 1 FROM public.unregistered_athletes ua
             WHERE ua.id = p_dueno AND ua.school_id = p_school
               AND (ua.is_active
                    OR (ua.linked_profile_id IS NOT NULL
                        AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = ua.linked_profile_id))))
        ELSE false
    END;
$$;

REVOKE ALL ON FUNCTION public._servicio_es_afiliado(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- Cupos vivos del ítem: pagos pending/overdue/awaiting_approval/partial/paid/glosado
-- de las tres fuentes que venden el ítem, sin doble conteo del mismo pago.
CREATE FUNCTION public._servicio_cupos_vivos(p_item uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT count(*)::int
      FROM (
            SELECT ws.payment_id
              FROM public.wa_cobros_sueltos ws
             WHERE ws.item_id = p_item AND ws.anulado_at IS NULL
            UNION
            SELECT w.payment_id
              FROM public.wa_cobros_desde_comprobante w
             WHERE w.fuente = 'tournament_item' AND w.fuente_id = p_item
            UNION
            SELECT c.payment_id
              FROM public.cobros_servicio_item c
             WHERE c.item_id = p_item AND c.anulado_at IS NULL
           ) l
      JOIN public.payments p ON p.id = l.payment_id
     WHERE p.status IN ('pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado');
$$;

REVOKE ALL ON FUNCTION public._servicio_cupos_vivos(uuid) FROM PUBLIC, anon, authenticated;

-- Cobros vivos del dueño para el ítem, de las tres fuentes (sin duplicar pagos).
CREATE FUNCTION public._servicio_cobros_del_dueno(p_school uuid, p_item uuid, p_tipo text, p_dueno uuid)
RETURNS TABLE (pago_id uuid, estado text, monto numeric, recibido numeric, concepto text, vence date, creado timestamptz)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT p.id, p.status, p.amount, p.amount_paid, p.concept, p.due_date, p.created_at
      FROM (
            SELECT c.payment_id
              FROM public.cobros_servicio_item c
             WHERE c.item_id = p_item AND c.school_id = p_school AND c.anulado_at IS NULL
            UNION
            SELECT w.payment_id
              FROM public.wa_cobros_desde_comprobante w
             WHERE w.fuente = 'tournament_item' AND w.fuente_id = p_item AND w.school_id = p_school
            UNION
            SELECT ws.payment_id
              FROM public.wa_cobros_sueltos ws
             WHERE ws.item_id = p_item AND ws.school_id = p_school AND ws.anulado_at IS NULL
           ) l
      JOIN public.payments p ON p.id = l.payment_id
     WHERE p.school_id = p_school
       AND p.status IN ('pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado')
       AND CASE p_tipo
               WHEN 'child'        THEN p.child_id = p_dueno
               WHEN 'user'         THEN p.user_id = p_dueno
               WHEN 'unregistered' THEN p.unregistered_athlete_id = p_dueno
               WHEN 'lead'         THEN p.signup_lead_id = p_dueno
               ELSE false
           END;
$$;

REVOKE ALL ON FUNCTION public._servicio_cobros_del_dueno(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;

-- ¿A qué ítem está ligado ese pago (en cualquiera de las tres fuentes)? NULL = a ninguno.
CREATE FUNCTION public._servicio_pago_ligado(p_payment uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT x.item_id
      FROM (
            SELECT c.item_id FROM public.cobros_servicio_item c
             WHERE c.payment_id = p_payment AND c.anulado_at IS NULL
            UNION ALL
            SELECT ws.item_id FROM public.wa_cobros_sueltos ws
             WHERE ws.payment_id = p_payment AND ws.anulado_at IS NULL
            UNION ALL
            SELECT w.fuente_id FROM public.wa_cobros_desde_comprobante w
             WHERE w.payment_id = p_payment AND w.fuente = 'tournament_item'
           ) x
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public._servicio_pago_ligado(uuid) FROM PUBLIC, anon, authenticated;

-- ¿Cumple el grupo el mínimo? Cuenta los cobros del ítem, del mismo equipo, con
-- descuento de grupo, en parcial/pagado/por aprobar, más los pendientes/vencidos
-- con due_date <= corte, o mientras HOY (Bogotá) <= corte: los cobros de la escuela
-- vencen el 20-nov (saldo), así que contar solo por due_date los dejaría fuera
-- mientras la promoción sigue vigente. Corte = el día anterior al primer cambio de
-- precio de afiliado (2026-11-15 en la clínica de Monster). p_sumar permite incluir al cobro que se
-- está creando (p_sumar = 1). El mínimo es el de la primera entrada de descuentos_grupo.
CREATE FUNCTION public._servicio_grupo_cumple(p_item uuid, p_team uuid, p_sumar integer DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_dg    jsonb;
    v_paf   jsonb;
    v_min   integer;
    v_corte date;
    v_n     integer;
BEGIN
    IF p_item IS NULL OR p_team IS NULL THEN
        RETURN false;
    END IF;
    SELECT i.descuentos_grupo, i.precios_afiliado_por_fecha INTO v_dg, v_paf
      FROM public.school_tournament_items i
     WHERE i.id = p_item;
    IF NOT FOUND OR jsonb_typeof(v_dg) IS DISTINCT FROM 'array' THEN
        RETURN false;
    END IF;
    v_min := (v_dg->0->>'minimo')::integer;
    IF v_min IS NULL THEN
        RETURN false;
    END IF;

    SELECT min((e->>'desde')::date) - 1 INTO v_corte
      FROM jsonb_array_elements(COALESCE(v_paf, '[]'::jsonb)) e;
    v_corte := COALESCE(v_corte, DATE '2026-11-15');

    SELECT count(*)::int INTO v_n
      FROM public.cobros_servicio_item c
      JOIN public.payments p ON p.id = c.payment_id
     WHERE c.item_id = p_item
       AND c.team_id = p_team
       AND c.descuento_clave IS NOT NULL
       AND c.anulado_at IS NULL
       AND (p.status IN ('partial', 'paid', 'awaiting_approval')
            OR (p.status IN ('pending', 'overdue')
                AND (p.due_date <= v_corte OR (now() AT TIME ZONE 'America/Bogota')::date <= v_corte)));

    RETURN v_n + COALESCE(p_sumar, 0) >= v_min;
END;
$$;

REVOKE ALL ON FUNCTION public._servicio_grupo_cumple(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;

-- ── 4. RPC para administradores ──────────────────────────────────────────────
-- registrar_pago_servicio_manual: la escuela registra un pago recibido a mano
-- (transferencia o efectivo) de un servicio. Errores de negocio en
-- {ok:false, codigo}; sin permisos RAISE 42501. Códigos:
--   dueno_invalido, metodo_invalido, clave_invalida, monto_invalido, fecha_invalida,
--   precio_acordado_invalido, motivo_requerido, item_no_disponible, clave_reutilizada,
--   lead_descartado, equipo_invalido, opcion_requerida, opcion_invalida, sin_precio,
--   cobro_sin_ligar, cobro_existente_precio_fijo, en_revision, ya_pagado, sobrepago,
--   abono_no_permitido, abono_menor_al_minimo, sin_cupos, referencia_duplicada, cobro_cambio.
CREATE FUNCTION public.registrar_pago_servicio_manual(
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
    IF NOT (jsonb_typeof(v_item.opciones) = 'array' AND jsonb_array_length(v_item.opciones) > 0) THEN
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

COMMENT ON FUNCTION public.registrar_pago_servicio_manual(uuid, uuid, numeric, text, text, uuid, uuid, uuid, uuid, date, text, text, uuid, boolean, numeric, text, boolean, boolean) IS
    'Escuela: registra un pago manual (transfer|cash) de un servicio. Dueño exacto entre child/user/unregistered/lead; precio '
    'vigente a la fecha del pago; acuerdo de precio con motivo >= 10; si ya hay cobro vivo del ítem es abono/saldo; si no, crea el '
    'cobro ya paid|partial. Idempotente por p_idempotency_key. Gate: admin de la escuela o super admin. (20261111114349)';

REVOKE ALL ON FUNCTION public.registrar_pago_servicio_manual(uuid, uuid, numeric, text, text, uuid, uuid, uuid, uuid, date, text, text, uuid, boolean, numeric, text, boolean, boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_pago_servicio_manual(uuid, uuid, numeric, text, text, uuid, uuid, uuid, uuid, date, text, text, uuid, boolean, numeric, text, boolean, boolean)
    TO authenticated;

-- ligar_cobro_a_servicio: liga un cobro que la escuela ya creó (p. ej. «Otro cobro»)
-- al ítem, SIN cambiar amount. La categoría pasa a la del ítem. Con
-- p_aplicar_descuento_clave rellena list_amount/discount_amount/discount_pct solo si
-- lista - descuento = amount; si no, error. Códigos: no_encontrado (nunca: sin permisos
-- es 42501), item_no_disponible, estado_invalido, ya_ligado, categoria_no_permitida,
-- sin_dueno, sin_cupos, motivo_requerido, no_afiliado, ya_tiene_descuento,
-- descuento_invalido, monto_no_cuadra, opcion_requerida/opcion_invalida.
CREATE FUNCTION public.ligar_cobro_a_servicio(
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
        IF v_pay.list_amount IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_descuento');
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
    IF v_clave IS NOT NULL THEN
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

COMMENT ON FUNCTION public.ligar_cobro_a_servicio(uuid, uuid, text, text) IS
    'Escuela: liga un cobro ya creado a un ítem de servicio sin cambiar amount (categoría = la del ítem; con clave de descuento '
    'rellena lista/descuento/% solo si cuadra con el monto). Segundo intento: codigo ya_ligado. Gate: admin de la escuela del '
    'cobro o super admin. (20261111114349)';

REVOKE ALL ON FUNCTION public.ligar_cobro_a_servicio(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ligar_cobro_a_servicio(uuid, uuid, text, text) TO authenticated;

-- reclasificar_pago_servicio: corrige categoría y concepto de un pago (p. ej. «Otro
-- cobro» → clase_extra). No se mueve de/hacia mensualidad (daría o quitaría vigencia).
-- Si el pago tenía enlace vivo a un ítem, queda anulado (con el motivo).
CREATE FUNCTION public.reclasificar_pago_servicio(
    p_payment_id      uuid,
    p_nueva_categoria text,
    p_nuevo_concepto  text,
    p_motivo          text
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
    v_concepto text := NULLIF(btrim(COALESCE(p_nuevo_concepto, '')), '');
    v_pay      public.payments%ROWTYPE;
    v_anulados integer;
BEGIN
    SELECT p.school_id INTO v_school FROM public.payments p WHERE p.id = p_payment_id;
    IF v_uid IS NULL OR v_school IS NULL
       OR NOT (COALESCE(v_school = ANY (public.user_admin_school_ids()), false)
               OR COALESCE(public.is_super_admin(), false)) THEN
        RAISE EXCEPTION 'Sin permisos sobre esta escuela' USING ERRCODE = '42501';
    END IF;

    IF v_motivo IS NULL OR char_length(v_motivo) < 10 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'motivo_requerido');
    END IF;
    IF p_nueva_categoria IS NULL OR p_nueva_categoria NOT IN
       ('inscripcion', 'articulos', 'torneo', 'otro', 'seguro', 'excedente',
        'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'categoria_invalida');
    END IF;
    IF v_concepto IS NOT NULL AND char_length(v_concepto) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'concepto_invalido');
    END IF;

    SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
    IF COALESCE(v_pay.payment_category, 'mensualidad') = 'mensualidad' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'categoria_no_permitida');
    END IF;
    IF v_pay.status IN ('cancelled', 'rejected', 'failed') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'estado_invalido', 'estado', v_pay.status);
    END IF;

    UPDATE public.payments
       SET payment_category = p_nueva_categoria,
           concept = COALESCE(v_concepto, concept)
     WHERE id = p_payment_id;

    UPDATE public.cobros_servicio_item
       SET anulado_at = now(), anulado_motivo = left('reclasificado: ' || v_motivo, 300)
     WHERE payment_id = p_payment_id AND anulado_at IS NULL;
    GET DIAGNOSTICS v_anulados = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok', true, 'payment_id', p_payment_id,
        'categoria_anterior', v_pay.payment_category, 'categoria', p_nueva_categoria,
        'enlace_anulado', v_anulados > 0);
END;
$$;

COMMENT ON FUNCTION public.reclasificar_pago_servicio(uuid, text, text, text) IS
    'Escuela: cambia categoría/concepto de un pago no mensualidad y anula su enlace a un ítem si lo tenía. Gate: admin de la '
    'escuela del pago o super admin. (20261111114349)';

REVOKE ALL ON FUNCTION public.reclasificar_pago_servicio(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reclasificar_pago_servicio(uuid, text, text, text) TO authenticated;

-- ── 5. RPC solo service_role: el comprobante contra el cobro abierto ─────────
-- Convención de las RPC solo-BFF: sin auth.uid(); el alcance es «todo pertenece a
-- p_school_id». Busca el cobro abierto del dueño para el ítem (o el p_payment_id
-- exacto) y le aplica el monto: igual al saldo → paid; menor → partial (solo si el
-- ítem permite abono y se llega al mínimo); mayor → sobrepago. Códigos:
--   parametros, monto_invalido, origen_invalido, dueno_invalido, cobro_no_encontrado,
--   cola_reutilizada, sin_cobro_abierto, ya_pagado, ambiguo (candidatos), en_revision,
--   sin_saldo, sobrepago, abono_no_permitido, abono_menor_al_minimo, cobro_cambio,
--   categoria_no_permitida (mensualidad), cobro_no_es_del_dueno, referencia_duplicada.
-- approved_by queda NULL a propósito (como auto_approve_payment: lo aplicó el sistema, no una persona).
CREATE FUNCTION public.aplicar_comprobante_a_cobro_abierto(
    p_school_id       uuid,
    p_queue_id        uuid,
    p_monto           numeric,
    p_item_id         uuid    DEFAULT NULL,
    p_child_id        uuid    DEFAULT NULL,
    p_user_id         uuid    DEFAULT NULL,
    p_unregistered_id uuid    DEFAULT NULL,
    p_signup_lead_id  uuid    DEFAULT NULL,
    p_payment_id      uuid    DEFAULT NULL,
    p_origen          text    DEFAULT 'comprobante_bot',
    p_referencia      text    DEFAULT NULL,
    p_receipt_url     text    DEFAULT NULL,
    p_fecha_pago      date    DEFAULT NULL,
    p_permitir_referencia_repetida boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_dup      uuid;
    v_hoy      date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_fecha    date;
    v_ref      text := NULLIF(btrim(COALESCE(p_referencia, '')), '');
    v_ref_norm text;
    v_monto    numeric;
    v_tipo     text;
    v_dueno    uuid;
    v_item_id  uuid;
    v_item     public.school_tournament_items%ROWTYPE;
    v_pay      public.payments%ROWTYPE;
    v_mov      record;
    v_cands    jsonb;
    v_n        integer;
    v_saldo    numeric;
    v_min      numeric;
    v_res      text;
    v_pid      uuid;
    v_tipo_pay text;
    v_dueno_pay uuid;
BEGIN
    IF p_school_id IS NULL OR p_queue_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'parametros');
    END IF;
    IF p_monto IS NULL OR p_monto <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'monto_invalido');
    END IF;
    IF p_origen IS NULL OR p_origen NOT IN ('comprobante_app', 'comprobante_bot') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'origen_invalido');
    END IF;
    IF num_nonnulls(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id) > 1
       OR (p_payment_id IS NULL
           AND (num_nonnulls(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id) <> 1 OR p_item_id IS NULL)) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
    END IF;
    v_monto := round(p_monto, 2);
    v_fecha := COALESCE(p_fecha_pago, v_hoy);
    IF v_fecha > v_hoy OR v_fecha < v_hoy - 400 THEN
        v_fecha := v_hoy;
    END IF;
    v_ref_norm := CASE WHEN v_ref IS NULL THEN NULL
                       ELSE NULLIF(upper(regexp_replace(v_ref, '[\s-]', '', 'g')), '') END;

    v_tipo  := CASE WHEN p_child_id IS NOT NULL THEN 'child'
                    WHEN p_user_id IS NOT NULL THEN 'user'
                    WHEN p_unregistered_id IS NOT NULL THEN 'unregistered'
                    WHEN p_signup_lead_id IS NOT NULL THEN 'lead' END;
    v_dueno := COALESCE(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id);

    -- Ítem: el dado o el del enlace del pago exacto. Candado del ítem y luego del pago
    -- (mismo orden que las RPC de la escuela).
    v_item_id := p_item_id;
    IF p_payment_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id = p_payment_id AND p.school_id = p_school_id) THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_no_encontrado');
        END IF;
        v_item_id := COALESCE(v_item_id, public._servicio_pago_ligado(p_payment_id));
    END IF;
    IF v_item_id IS NOT NULL THEN
        SELECT * INTO v_item
          FROM public.school_tournament_items
         WHERE id = v_item_id AND school_id = p_school_id
           FOR UPDATE;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
        END IF;
    END IF;

    -- Idempotencia por fila de la cola (después del candado).
    SELECT m.payment_id, m.school_id, m.monto INTO v_mov
      FROM public.cobros_servicio_movimientos m
     WHERE m.queue_id = p_queue_id;
    IF FOUND THEN
        IF v_mov.school_id <> p_school_id THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'cola_reutilizada');
        END IF;
        SELECT * INTO v_pay FROM public.payments WHERE id = v_mov.payment_id;
        RETURN jsonb_build_object(
            'ok', true, 'ya_aplicado', true, 'payment_id', v_pay.id, 'estado', v_pay.status,
            'monto_aplicado', v_mov.monto, 'recibido', COALESCE(v_pay.amount_paid, 0),
            'saldo', GREATEST(v_pay.amount - COALESCE(v_pay.amount_paid, 0)
                              - COALESCE(v_pay.early_payment_discount_applied, 0), 0),
            'es_abono', v_pay.status = 'partial');
    END IF;

    -- Cobro destino.
    IF p_payment_id IS NOT NULL THEN
        v_pid := p_payment_id;
    ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'payment_id', d.pago_id, 'concepto', d.concepto, 'monto', d.monto,
                   'recibido', COALESCE(d.recibido, 0), 'estado', d.estado, 'vence', d.vence)
                   ORDER BY d.creado), '[]'::jsonb)
          INTO v_cands
          FROM public._servicio_cobros_del_dueno(p_school_id, v_item_id, v_tipo, v_dueno) d
         WHERE d.estado IN ('pending', 'overdue', 'partial', 'awaiting_approval');
        v_n := jsonb_array_length(v_cands);
        IF v_n = 0 THEN
            IF EXISTS (SELECT 1 FROM public._servicio_cobros_del_dueno(p_school_id, v_item_id, v_tipo, v_dueno) d
                        WHERE d.estado IN ('paid', 'glosado')) THEN
                RETURN jsonb_build_object('ok', false, 'codigo', 'ya_pagado');
            END IF;
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_cobro_abierto');
        ELSIF v_n > 1 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ambiguo', 'candidatos', v_cands);
        END IF;
        v_pid := (v_cands->0->>'payment_id')::uuid;
    END IF;

    SELECT * INTO v_pay FROM public.payments WHERE id = v_pid AND school_id = p_school_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_no_encontrado');
    END IF;
    -- La mensualidad no es de esta RPC (vigencia/inscripciones). Y con p_payment_id exacto el
    -- cobro tiene que ser del dueño recibido.
    IF COALESCE(v_pay.payment_category, 'mensualidad') = 'mensualidad' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'categoria_no_permitida', 'payment_id', v_pay.id);
    END IF;
    IF v_tipo IS NOT NULL AND NOT (CASE v_tipo
            WHEN 'child'        THEN v_pay.child_id = v_dueno
            WHEN 'user'         THEN v_pay.user_id = v_dueno
            WHEN 'unregistered' THEN v_pay.unregistered_athlete_id = v_dueno
            ELSE v_pay.signup_lead_id = v_dueno END) THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_no_es_del_dueno', 'payment_id', v_pay.id);
    END IF;
    IF v_pay.status = 'awaiting_approval' THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'en_revision', 'payment_id', v_pay.id);
    END IF;
    IF v_pay.status IN ('paid', 'glosado') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'ya_pagado', 'payment_id', v_pay.id);
    END IF;
    -- Referencia ya usada por un pago vivo de la escuela (doble pago entre canales).
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
    IF v_pay.status NOT IN ('pending', 'overdue', 'partial') THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_cambio', 'payment_id', v_pay.id, 'estado', v_pay.status);
    END IF;

    v_saldo := v_pay.amount - COALESCE(v_pay.amount_paid, 0) - COALESCE(v_pay.early_payment_discount_applied, 0);
    IF v_saldo <= 0 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sin_saldo', 'payment_id', v_pay.id);
    END IF;
    IF v_monto > v_saldo + 1 THEN
        RETURN jsonb_build_object('ok', false, 'codigo', 'sobrepago', 'payment_id', v_pay.id,
                                  'saldo', v_saldo, 'monto', v_monto);
    END IF;
    IF v_monto >= v_saldo - 1 THEN
        v_monto := v_saldo;                           -- salda (tolerancia ±$1)
    ELSE
        IF v_item_id IS NULL OR NOT COALESCE(v_item.allow_installments, false) OR v_item.abono_minimo_pct IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'abono_no_permitido', 'payment_id', v_pay.id, 'saldo', v_saldo);
        END IF;
        v_min := ceil(v_pay.amount * v_item.abono_minimo_pct / 100.0);
        IF COALESCE(v_pay.amount_paid, 0) + v_monto < v_min - 1 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'abono_menor_al_minimo', 'payment_id', v_pay.id,
                                      'abono_minimo', v_min, 'saldo', v_saldo);
        END IF;
    END IF;

    BEGIN
        v_res := public._registrar_pago_en_cobro(
            v_pay.id, NULL, v_monto,
            jsonb_build_object(
                'method', 'transfer',
                'payment_date', v_fecha::text,
                'reference', v_ref,
                'receipt_url', p_receipt_url,
                'ocr', CASE WHEN v_ref_norm IS NOT NULL
                            THEN jsonb_build_object('receipt_reference_norm', v_ref_norm)
                            ELSE '{}'::jsonb END),
            true, NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM LIKE 'EN_REVISION%' THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'en_revision', 'payment_id', v_pay.id);
        ELSIF SQLERRM LIKE 'SOBREPAGO%' THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sobrepago', 'payment_id', v_pay.id);
        END IF;
        RETURN jsonb_build_object('ok', false, 'codigo', 'cobro_cambio', 'payment_id', v_pay.id, 'detalle', left(SQLERRM, 200));
    END;

    -- Dueño del movimiento: el pedido o el que dicen las columnas del pago.
    IF v_tipo IS NULL THEN
        IF v_pay.child_id IS NOT NULL THEN v_tipo_pay := 'child'; v_dueno_pay := v_pay.child_id;
        ELSIF v_pay.user_id IS NOT NULL THEN v_tipo_pay := 'user'; v_dueno_pay := v_pay.user_id;
        ELSIF v_pay.unregistered_athlete_id IS NOT NULL THEN v_tipo_pay := 'unregistered'; v_dueno_pay := v_pay.unregistered_athlete_id;
        ELSIF v_pay.signup_lead_id IS NOT NULL THEN v_tipo_pay := 'lead'; v_dueno_pay := v_pay.signup_lead_id;
        END IF;
    ELSE
        v_tipo_pay := v_tipo; v_dueno_pay := v_dueno;
    END IF;

    -- Como auto_approve_payment: el dinero entró y la conciliación bancaria lo ve pendiente.
    UPDATE public.payments SET reconciliation_status = 'pendiente' WHERE id = v_pay.id;
    -- Un abono que deja el cobro en partial lo vence en saldo_hasta (nunca baja un due_date más lejano).
    IF v_res = 'partial' AND v_item.saldo_hasta IS NOT NULL THEN
        UPDATE public.payments SET due_date = v_item.saldo_hasta
         WHERE id = v_pay.id AND due_date < v_item.saldo_hasta;
    END IF;

    BEGIN
        INSERT INTO public.cobros_servicio_movimientos (
            payment_id, school_id, item_id, dueno_tipo, dueno_id, tipo, monto, queue_id, origen
        ) VALUES (
            v_pay.id, p_school_id, v_item_id, v_tipo_pay, v_dueno_pay,
            CASE WHEN v_res = 'paid' AND COALESCE(v_pay.amount_paid, 0) > 0 THEN 'saldo'
                 WHEN v_res = 'paid' THEN 'pago' ELSE 'abono' END,
            v_monto, p_queue_id, p_origen);
    EXCEPTION WHEN unique_violation THEN
        -- Otro BFF aplicó la misma fila de la cola a la vez: el subbloque deshace este movimiento,
        -- pero el pago ya se aplicó en esta transacción; se aborta para que se deshaga todo.
        RAISE EXCEPTION 'COLA_DUPLICADA: la fila % ya se aplicó', p_queue_id USING ERRCODE = '40001';
    END;

    -- Pago exacto sin enlace + ítem conocido: queda ligado (origen = el del comprobante).
    IF v_item_id IS NOT NULL AND v_tipo_pay IS NOT NULL
       AND public._servicio_pago_ligado(v_pay.id) IS NULL THEN
        INSERT INTO public.cobros_servicio_item (
            payment_id, school_id, item_id, dueno_tipo, dueno_id, origen, es_abono, queue_id, team_id
        ) VALUES (
            v_pay.id, p_school_id, v_item_id, v_tipo_pay, v_dueno_pay, p_origen, v_res = 'partial', p_queue_id, v_pay.team_id
        )
        ON CONFLICT (payment_id) DO NOTHING;
    ELSE
        UPDATE public.cobros_servicio_item SET es_abono = (v_res = 'partial')
         WHERE payment_id = v_pay.id AND anulado_at IS NULL;
    END IF;

    SELECT * INTO v_pay FROM public.payments WHERE id = v_pay.id;
    RETURN jsonb_build_object(
        'ok', true, 'ya_aplicado', false, 'payment_id', v_pay.id, 'estado', v_pay.status,
        'monto_aplicado', v_monto, 'recibido', COALESCE(v_pay.amount_paid, 0),
        'saldo', GREATEST(v_pay.amount - COALESCE(v_pay.amount_paid, 0)
                          - COALESCE(v_pay.early_payment_discount_applied, 0), 0),
        'es_abono', v_pay.status = 'partial');
END;
$$;

COMMENT ON FUNCTION public.aplicar_comprobante_a_cobro_abierto(uuid, uuid, numeric, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, date, boolean) IS
    'Bot/app: aplica un comprobante al cobro abierto del dueño para el ítem (o a p_payment_id): saldo exacto → paid; menor → '
    'partial si el ítem permite abono; mayor → sobrepago; 2+ candidatos → ambiguo; en revisión → en_revision. Idempotente por '
    'queue_id. Solo service role. (20261111114349)';

-- Trampa 3 de CLAUDE.md: los default privileges dan EXECUTE a authenticated; se revoca explícito.
REVOKE ALL ON FUNCTION public.aplicar_comprobante_a_cobro_abierto(uuid, uuid, numeric, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, date, boolean)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_comprobante_a_cobro_abierto(uuid, uuid, numeric, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, date, boolean)
    TO service_role;

-- ── 6. wa_crear_cobro_desde_comprobante: 4º dueño + helpers ──────────────────
-- Cuerpo VIVO de 20261030123549 (sin deriva, verificado contra pg_proc el
-- 2026-11-11). Cambios: (a) p_user_id (atleta con cuenta y school_members activo) como
-- 4º dueño, num_nonnulls = 1; (b) el unregistered no exige is_active si tiene
-- linked_profile_id vivo; (c) precio del servicio sin opciones por
-- _servicio_precio_vigente (respeta precios_afiliado_por_fecha); (d) «ya lo compró» y
-- cupos por los helpers de tres fuentes. Lo demás, igual.
-- Añadir un parámetro crea una SOBRECARGA: se elimina la firma vieja (si no, PostgREST
-- no sabría cuál elegir).
DROP FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text);

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
    p_telefono             text DEFAULT NULL,
    p_user_id              uuid DEFAULT NULL
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
    v_pv         jsonb;
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
    IF num_nonnulls(p_child_id, p_unregistered_id, p_signup_lead_id, p_user_id) <> 1 THEN
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
        -- Activo, o inactivo pero con vínculo vivo a un perfil (ficha consolidada con su cuenta).
        SELECT ua.branch_id, ua.full_name INTO v_branch, v_nombre
          FROM public.unregistered_athletes ua
         WHERE ua.id = p_unregistered_id AND ua.school_id = p_school_id
           AND (ua.is_active
                OR (ua.linked_profile_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.id = ua.linked_profile_id)));
        IF NOT FOUND THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'dueno_invalido');
        END IF;
        v_afiliado := true;
    ELSIF p_user_id IS NOT NULL THEN
        -- Atleta con cuenta: miembro activo de ESTA escuela.
        SELECT pr.full_name INTO v_nombre
          FROM public.profiles pr
          JOIN public.school_members sm ON sm.profile_id = pr.id
         WHERE pr.id = p_user_id AND sm.school_id = p_school_id AND sm.status = 'active'
         LIMIT 1;
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
                    WHEN p_user_id IS NOT NULL THEN p.user_id = p_user_id
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
        -- Candado del ítem: serializa cupos con wa_crear_cobro_suelto, la RPC manual y los 3 BFF.
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
            -- Precio por fecha (Bogotá): externo = precios_por_fecha; afiliado =
            -- precios_afiliado_por_fecha / precio_afiliado. Ya resuelve afiliado.
            v_pv := public._servicio_precio_vigente(v_item, v_hoy, v_afiliado, NULL, false);
            v_precio    := (v_pv->>'precio')::numeric;
            v_precio_af := NULL;
        END IF;

        IF v_afiliado AND v_precio_af IS NOT NULL THEN
            v_precio := v_precio_af;
        END IF;
        IF COALESCE(v_precio, 0) <= 0 THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'sin_precio');
        END IF;

        -- Ya lo compró (cobro vivo del mismo ítem para el mismo dueño; las tres fuentes).
        SELECT d.pago_id INTO v_existente
          FROM public._servicio_cobros_del_dueno(
                   p_school_id, v_item.id,
                   CASE WHEN p_child_id IS NOT NULL THEN 'child'
                        WHEN p_user_id IS NOT NULL THEN 'user'
                        WHEN p_unregistered_id IS NOT NULL THEN 'unregistered'
                        ELSE 'lead' END,
                   COALESCE(p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id)) d
         ORDER BY d.creado DESC
         LIMIT 1;
        IF v_existente IS NOT NULL THEN
            RETURN jsonb_build_object('ok', false, 'codigo', 'ya_tiene_cobro', 'payment_id', v_existente);
        END IF;

        -- Cupos: todos los caminos que venden el ítem (exacto: el ítem está bloqueado).
        v_vivos := public._servicio_cupos_vivos(v_item.id);
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

    -- Un ABONO vence en saldo_hasta (el aviso al cliente dice «saldo antes de <due_date>»);
    -- el pago completo conserva hoy. Nunca se adelanta una fecha más lejana.
    IF v_es_abono AND p_fuente = 'tournament_item' AND v_item.saldo_hasta IS NOT NULL
       AND v_item.saldo_hasta > v_due THEN
        v_due := v_item.saldo_hasta;
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
            school_id, parent_id, child_id, user_id, unregistered_athlete_id, signup_lead_id, branch_id,
            amount, concept, due_date, status, payment_type,
            payment_category, period_uniqueness_exempt, created_by, notes
        ) VALUES (
            p_school_id, v_parent, p_child_id, p_user_id, p_unregistered_id, p_signup_lead_id, v_branch,
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

COMMENT ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text, uuid) IS
    'Bot de WhatsApp: crea UN cobro (pending) desde un comprobante con el precio de la fuente (trial_price, '
    'registration_fee, artículo, servicio con opción/afiliado/fecha/abono). Dueño exacto entre child, unregistered (activo o con '
    'vínculo vivo), lead o user (atleta con cuenta). Idempotente por (queue_id, fuente, fuente_id). {ok, payment_id, precio, '
    'es_abono, ya_existia} o {ok:false, codigo}. Solo service role. (20261111114349)';

REVOKE ALL ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text, uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_crear_cobro_desde_comprobante(uuid, uuid, text, numeric, text, uuid, uuid, uuid, uuid, text, uuid, text, text, uuid)
    TO service_role;

-- ── wa_crear_cobro_suelto: cupos por _servicio_cupos_vivos ───────────────────
-- Cuerpo VIVO (sin deriva). Único cambio: los dos conteos de cupos pasan por el
-- helper de tres fuentes (antes solo contaban wa_cobros_sueltos).
CREATE OR REPLACE FUNCTION public.wa_crear_cobro_suelto(p_school_id uuid, p_item_id uuid, p_parent_id uuid, p_child_id uuid, p_idempotency_key text, p_conversation_id uuid DEFAULT NULL::uuid, p_minutos_vigencia integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  c_vivos     constant text[] := ARRAY['pending','overdue','awaiting_approval','partial','paid','glosado'];
  v_key       text := btrim(COALESCE(p_idempotency_key, ''));
  v_min       int  := LEAST(GREATEST(COALESCE(p_minutos_vigencia, 60), 15), 120);
  v_hoy       date := (now() AT TIME ZONE 'America/Bogota')::date;
  v_hab       boolean;
  v_item      public.school_tournament_items%ROWTYPE;
  v_prev      record;
  v_child     text;
  v_vivos     int;
  v_existente uuid;
  v_pid       uuid;
  v_concepto  text;
  v_vence     timestamptz;
BEGIN
  IF char_length(v_key) < 8 OR char_length(v_key) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'clave_invalida');
  END IF;
  IF p_school_id IS NULL OR p_item_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
  END IF;
  IF p_parent_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'familia_no_valida');
  END IF;

  -- Interruptores: catálogo prendido por SportMaps + ventas por WhatsApp de la escuela.
  SELECT COALESCE(ss.tournament_charges_enabled, false) AND COALESCE(ss.wa_ventas_habilitadas, false)
    INTO v_hab
  FROM public.school_settings ss
  WHERE ss.school_id = p_school_id;
  IF NOT COALESCE(v_hab, false) THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'ventas_deshabilitadas');
  END IF;
  IF NOT public.school_is_operational(p_school_id) THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'escuela_no_operativa');
  END IF;

  -- Candado del ítem: serializa a todos los que compran el mismo ítem (cupos e
  -- idempotencia exactos con los 3 BFF a la vez).
  SELECT * INTO v_item
  FROM public.school_tournament_items
  WHERE id = p_item_id AND school_id = p_school_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
  END IF;
  -- Un ítem vinculado a un torneo se cobra con la inscripción, no como cobro suelto.
  IF v_item.event_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
  END IF;

  -- Idempotencia (después del candado: ve lo que commiteó el otro).
  SELECT w.payment_id, w.item_id, w.parent_id, w.child_id, w.vence_at,
         p.amount, p.concept, p.payment_category, p.status
    INTO v_prev
  FROM public.wa_cobros_sueltos w
  JOIN public.payments p ON p.id = w.payment_id
  WHERE w.school_id = p_school_id AND w.idempotency_key = v_key;
  IF FOUND THEN
    IF v_prev.item_id IS DISTINCT FROM p_item_id
       OR v_prev.parent_id IS DISTINCT FROM p_parent_id
       OR v_prev.child_id IS DISTINCT FROM p_child_id THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'clave_reutilizada');
    END IF;
    v_vivos := public._servicio_cupos_vivos(p_item_id);
    RETURN jsonb_build_object(
      'ok', true, 'idempotente', true,
      'payment_id', v_prev.payment_id,
      'monto', v_prev.amount,
      'concepto', v_prev.concept,
      'categoria', v_prev.payment_category,
      'estado', v_prev.status,
      'vence_at', v_prev.vence_at,
      'cupos_restantes', CASE WHEN v_item.capacity IS NULL THEN NULL
                              ELSE GREATEST(v_item.capacity - v_vivos, 0) END
    );
  END IF;

  -- Ítem vendible.
  IF NOT v_item.active THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_no_disponible');
  END IF;
  IF COALESCE(v_item.ends_at, v_item.starts_at) IS NOT NULL
     AND COALESCE(v_item.ends_at, v_item.starts_at) <= now() THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_vencido');
  END IF;
  IF COALESCE(v_item.price, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'item_sin_precio');
  END IF;

  -- Familia identificada de la escuela (mismo criterio que wa_identify_by_phone).
  IF NOT EXISTS (
    SELECT 1 FROM public.children c
    WHERE c.parent_id = p_parent_id AND c.school_id = p_school_id AND c.is_active
  ) THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'familia_no_valida');
  END IF;

  IF p_child_id IS NOT NULL THEN
    SELECT c.full_name INTO v_child
    FROM public.children c
    WHERE c.id = p_child_id AND c.parent_id = p_parent_id
      AND c.school_id = p_school_id AND c.is_active;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'codigo', 'atleta_no_valido');
    END IF;
  ELSIF v_item.per_athlete THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'atleta_requerido');
  END IF;

  -- Ya lo compró (cobro vivo del mismo ítem para el mismo atleta / familia).
  SELECT w.payment_id INTO v_existente
  FROM public.wa_cobros_sueltos w
  JOIN public.payments p ON p.id = w.payment_id
  WHERE w.item_id = p_item_id
    AND p.status = ANY (c_vivos)
    AND (CASE WHEN p_child_id IS NOT NULL THEN w.child_id = p_child_id
              ELSE w.parent_id = p_parent_id AND w.child_id IS NULL END)
  ORDER BY w.created_at DESC
  LIMIT 1;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'ya_inscrito', 'payment_id', v_existente);
  END IF;

  -- Cupos (exactos: el ítem está bloqueado). Las tres fuentes que venden el ítem.
  v_vivos := public._servicio_cupos_vivos(p_item_id);
  IF v_item.capacity IS NOT NULL AND v_vivos >= v_item.capacity THEN
    RETURN jsonb_build_object('ok', false, 'codigo', 'sin_cupos');
  END IF;

  v_concepto := v_item.name
    || CASE WHEN v_item.starts_at IS NOT NULL
            THEN ' · ' || to_char(v_item.starts_at AT TIME ZONE 'America/Bogota', 'DD/MM')
            ELSE '' END
    || CASE WHEN v_child IS NOT NULL THEN ' · ' || v_child ELSE '' END;
  v_vence := now() + make_interval(mins => v_min);

  BEGIN
    INSERT INTO public.payments (
      school_id, parent_id, child_id, amount, concept, due_date, status,
      payment_type, payment_category, period_uniqueness_exempt
    ) VALUES (
      p_school_id, p_parent_id, p_child_id, v_item.price, v_concepto, v_hoy, 'pending',
      'one_time', v_item.kind, true
    )
    RETURNING id INTO v_pid;

    INSERT INTO public.wa_cobros_sueltos (
      payment_id, school_id, item_id, parent_id, child_id, conversation_id,
      idempotency_key, vence_at
    ) VALUES (
      v_pid, p_school_id, p_item_id, p_parent_id, p_child_id, p_conversation_id,
      v_key, v_vence
    );
  EXCEPTION WHEN unique_violation THEN
    -- La misma clave entró por otro ítem en paralelo (el candado es por ítem).
    -- El subbloque deshace el payment insertado.
    RETURN jsonb_build_object('ok', false, 'codigo', 'clave_reutilizada');
  END;

  RETURN jsonb_build_object(
    'ok', true, 'idempotente', false,
    'payment_id', v_pid,
    'monto', v_item.price,
    'concepto', v_concepto,
    'categoria', v_item.kind,
    'estado', 'pending',
    'vence_at', v_vence,
    'cupos_restantes', CASE WHEN v_item.capacity IS NULL THEN NULL
                            ELSE GREATEST(v_item.capacity - v_vivos - 1, 0) END
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.wa_crear_cobro_suelto(uuid, uuid, uuid, uuid, text, uuid, integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_crear_cobro_suelto(uuid, uuid, uuid, uuid, text, uuid, integer)
    TO service_role;

-- ── 7. auto_approve_payment: guardas del plan §5 ─────────────────────────────
-- Cuerpo VIVO (sin deriva, pg_proc 2026-11-11). Cambio mínimo: (a) solo la
-- mensualidad (o sin categoría) activa inscripciones pendientes: un cobro «otro»
-- con equipo ya no activa la matrícula; (b) el aviso va a COALESCE(parent_id, user_id)
-- (el atleta adulto no tiene parent_id y no recibía nada).
CREATE OR REPLACE FUNCTION public.auto_approve_payment(p_payment_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
    v_school_id uuid;
    v_status    text;
    v_parent_id uuid;
    v_user_id   uuid;
    v_category  text;
    v_notify_id uuid;
    v_child_id  uuid;
    v_team_id   uuid;
    v_amount    numeric;
    v_discount  numeric;
    v_paid      numeric;
    v_data      jsonb;
    v_source    text;
BEGIN
    SELECT school_id, status, parent_id, user_id, payment_category, child_id, team_id, amount,
           COALESCE(early_payment_discount_applied, 0), amount_source
    INTO v_school_id, v_status, v_parent_id, v_user_id, v_category, v_child_id, v_team_id, v_amount, v_discount, v_source
    FROM public.payments WHERE id = p_payment_id;

    IF v_school_id IS NULL THEN RETURN false; END IF;
    IF v_status <> 'awaiting_approval' THEN RETURN false; END IF;  -- idempotente / no pisa al admin
    -- El monto lo eligió el navegador: el comprobante se compara contra un
    -- valor que controla quien paga. Lo aprueba una persona.
    IF v_source = 'cliente' THEN RETURN false; END IF;

    v_paid := v_amount - v_discount;
    v_notify_id := COALESCE(v_parent_id, v_user_id);

    UPDATE public.payments
    SET status = 'paid',
        approved_by = NULL,                       -- sistema
        approved_at = now(),
        amount_paid = v_paid,
        reconciliation_status = 'pendiente',
        updated_at = now()
    WHERE id = p_payment_id AND status = 'awaiting_approval';

    -- Solo la mensualidad activa la inscripción (plan §5.4): un cobro de otra
    -- categoría con equipo no la toca.
    IF COALESCE(v_category, 'mensualidad') = 'mensualidad' THEN
        UPDATE public.enrollments
        SET status = 'active', updated_at = now()
        WHERE school_id = v_school_id
          AND status = 'pending'
          AND (
                (v_child_id IS NOT NULL AND child_id = v_child_id)
             OR (v_child_id IS NULL AND v_parent_id IS NOT NULL AND user_id = v_parent_id)
          )
          AND (v_team_id IS NULL OR team_id = v_team_id);
    END IF;

    v_data := public._payment_notif_data(v_notify_id, v_child_id, v_team_id, v_school_id, v_paid);

    -- Notificación al PAGADOR (padre, o el propio atleta adulto) con category + data.
    IF v_notify_id IS NOT NULL THEN
        INSERT INTO public.notifications
            (user_id, school_id, title, message, type, link, category, data)
        VALUES (v_notify_id, v_school_id, 'Pago aprobado',
                'Validamos tu comprobante automáticamente y tu pago quedó aprobado. ¡Gracias!',
                'success', '/my-payments', 'payment', v_data);
    END IF;

    -- Notificación al STAFF de la sede (prerequisito Modo Recepción).
    PERFORM public._notify_school_staff(
        v_school_id, 'payment', 'success',
        'Pago recibido',
        format('Pago aprobado automáticamente: %s (%s)',
               v_data->>'payer_name', v_data->>'concept'),
        '/payments-automation',
        v_data
    );

    RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_approve_payment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_approve_payment(uuid) TO service_role;

COMMIT;
