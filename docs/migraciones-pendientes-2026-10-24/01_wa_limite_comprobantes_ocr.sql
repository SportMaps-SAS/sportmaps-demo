-- =============================================================================
-- 20261007163132_wa_limite_comprobantes_ocr.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-07   Versión anterior: 20261007095911
-- Objetivo: límite de comprobantes que se mandan a leer (OCR) por número y por
--   escuela, en ventana deslizante. Pendiente 3 de
--   docs/cierre-seguridad-ia-pagos-2026-10-05.md (denial-of-wallet): el worker
--   de la cola de WhatsApp dispara OCR por cada archivo, y un número en ráfaga
--   quemaba tokens de pago a discreción.
--
--   Calibración (medido 2026-10-07 sobre whatsapp_inbound_queue, 60 días):
--     por número: máx 4 archivos/hora (p99 3), máx 7/día.
--     por escuela: máx 21 archivos/hora (p99 14), máx 59/día.
--   Defaults: 8 por número y 60 por escuela en 60 minutos (2× y ~3× el máximo
--   real): no corta a ninguna familia legítima medida y frena una ráfaga.
--   Cada escuela puede ajustarlos en whatsapp_settings.
--
--   Por qué así:
--   · La RPC recibe SOLO el id de la fila de la cola: escuela y número salen
--     de la base, no de quien llama.
--   · Atomicidad: el conteo de una ventana no se puede blindar con FOR UPDATE
--     (no hay fila que bloquear: el peligro son las filas que AÚN no existen,
--     inserts fantasma de otro BFF; los 3 BFF corren el worker). Se serializa
--     contar+insertar por escuela con pg_advisory_xact_lock, el patrón que ya
--     usan open_month, la tienda v2 y ventas_wa_f0. El candado es por escuela
--     (cubre los dos topes: el número vive dentro de la escuela) y dura la
--     transacción de la RPC.
--   · Idempotente por fila (PK queue_id): un reintento de OCR caído no consume
--     otro cupo ni cambia la decisión.
--   · Se cuentan solo los permitidos: un número que sigue insistiendo no se
--     castiga más allá de la ventana.
--   · RLS activa sin policies + REVOKE: solo service_role (el BFF).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ── Ajustes por escuela (por integración) ──────────────────────────────────
ALTER TABLE public.whatsapp_settings
    ADD COLUMN IF NOT EXISTS limite_comprobantes_ventana_min integer NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS limite_comprobantes_por_numero  integer NOT NULL DEFAULT 8,
    ADD COLUMN IF NOT EXISTS limite_comprobantes_por_escuela integer NOT NULL DEFAULT 60;

ALTER TABLE public.whatsapp_settings
    DROP CONSTRAINT IF EXISTS whatsapp_settings_limite_comprobantes_chk;
ALTER TABLE public.whatsapp_settings
    ADD CONSTRAINT whatsapp_settings_limite_comprobantes_chk CHECK (
        limite_comprobantes_ventana_min BETWEEN 5 AND 1440
        AND limite_comprobantes_por_numero BETWEEN 1 AND 1000
        AND limite_comprobantes_por_escuela BETWEEN 1 AND 10000
    );

COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_ventana_min IS
  'Ventana deslizante (minutos) del límite de comprobantes que se mandan a OCR. Ver wa_reservar_cupo_ocr.';
COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_por_numero IS
  'Máximo de archivos que se leen (OCR) por número de WhatsApp dentro de la ventana.';
COMMENT ON COLUMN public.whatsapp_settings.limite_comprobantes_por_escuela IS
  'Máximo de archivos que se leen (OCR) por escuela dentro de la ventana.';

-- ── Registro de cupos ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.wa_ocr_cupos (
    queue_id   uuid PRIMARY KEY REFERENCES public.whatsapp_inbound_queue(id) ON DELETE CASCADE,
    school_id  uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    wa_phone   text NOT NULL,
    permitido  boolean NOT NULL,
    motivo     text NOT NULL CHECK (motivo IN ('ok', 'limite_numero', 'limite_escuela')),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_ocr_cupos_escuela_ventana
    ON public.wa_ocr_cupos (school_id, created_at) WHERE permitido;
CREATE INDEX IF NOT EXISTS idx_wa_ocr_cupos_numero_ventana
    ON public.wa_ocr_cupos (school_id, wa_phone, created_at) WHERE permitido;

ALTER TABLE public.wa_ocr_cupos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_ocr_cupos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.wa_ocr_cupos TO service_role;

COMMENT ON TABLE public.wa_ocr_cupos IS
  'Un cupo de OCR por fila de whatsapp_inbound_queue (permitido o frenado). Solo service_role. Ver wa_reservar_cupo_ocr.';

-- ── RPC ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wa_reservar_cupo_ocr(p_queue_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
    v_q          record;
    v_tel        text;
    v_ventana    integer := 60;
    v_max_numero integer := 8;
    v_max_escuela integer := 60;
    v_prev       record;
    v_n_numero   integer;
    v_n_escuela  integer;
    v_motivo     text;
BEGIN
    SELECT id, school_id, integration_id, wa_phone_number
      INTO v_q
      FROM public.whatsapp_inbound_queue
     WHERE id = p_queue_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('permitido', false, 'motivo', 'fila_inexistente');
    END IF;

    SELECT coalesce(s.limite_comprobantes_ventana_min, 60),
           coalesce(s.limite_comprobantes_por_numero, 8),
           coalesce(s.limite_comprobantes_por_escuela, 60)
      INTO v_ventana, v_max_numero, v_max_escuela
      FROM public.whatsapp_settings s
     WHERE s.integration_id = v_q.integration_id;
    v_ventana     := coalesce(v_ventana, 60);
    v_max_numero  := coalesce(v_max_numero, 8);
    v_max_escuela := coalesce(v_max_escuela, 60);

    v_tel := regexp_replace(coalesce(v_q.wa_phone_number, ''), '[^0-9]', '', 'g');

    -- Contar + insertar serializado por escuela (ver cabecera).
    PERFORM pg_advisory_xact_lock(hashtextextended('wa_ocr_cupo:' || v_q.school_id::text, 0));

    -- Idempotente: la misma fila (reintento) devuelve la decisión que ya tuvo.
    SELECT permitido, motivo INTO v_prev FROM public.wa_ocr_cupos WHERE queue_id = p_queue_id;
    IF FOUND THEN
        RETURN jsonb_build_object('permitido', v_prev.permitido, 'motivo', v_prev.motivo, 'repetido', true);
    END IF;

    SELECT count(*) FILTER (WHERE c.wa_phone = v_tel), count(*)
      INTO v_n_numero, v_n_escuela
      FROM public.wa_ocr_cupos c
     WHERE c.school_id = v_q.school_id
       AND c.permitido
       AND c.created_at > now() - make_interval(mins => v_ventana);

    v_motivo := CASE
        WHEN v_n_numero  >= v_max_numero  THEN 'limite_numero'
        WHEN v_n_escuela >= v_max_escuela THEN 'limite_escuela'
        ELSE 'ok'
    END;

    INSERT INTO public.wa_ocr_cupos (queue_id, school_id, wa_phone, permitido, motivo)
    VALUES (p_queue_id, v_q.school_id, v_tel, v_motivo = 'ok', v_motivo);

    RETURN jsonb_build_object(
        'permitido', v_motivo = 'ok',
        'motivo', v_motivo,
        'usados_numero', v_n_numero,
        'usados_escuela', v_n_escuela,
        'ventana_min', v_ventana
    );
END;
$fn$;

COMMENT ON FUNCTION public.wa_reservar_cupo_ocr(uuid) IS
  'Reserva (atómica, idempotente por fila) un cupo de OCR para una fila de la cola de WhatsApp. Límite por número y por escuela en ventana deslizante (whatsapp_settings). Solo service_role.';

REVOKE ALL ON FUNCTION public.wa_reservar_cupo_ocr(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_reservar_cupo_ocr(uuid) TO service_role;

COMMIT;
