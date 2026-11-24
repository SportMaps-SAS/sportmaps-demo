-- =============================================================================
-- 20261123115649_mapi_agente_motor.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123083815
-- Objetivo: base del modo agente de Mapi (docs/specs/mapi-agente-plan.md §5,
--   aprobado 2026-11-23): borradores de acción con confirmación, encendido por
--   escuela, permisos del coach y medición de costo por modo.
--
-- Solo agrega. No toca tablas en uso salvo:
--   · school_settings: 3 columnas nuevas con default (378 filas).
--   · llm_usage: el CHECK de `feature` admite dos valores más.
-- Se puede aplicar en cualquier momento: el BFF actual no lee nada de esto.
--
-- El recordatorio manual de cobro (collection_notices) va en una migración
-- APARTE (…_cobranza_recordatorio_manual) porque exige desplegar antes un
-- cambio del cron de cobranza.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- ─── 1. Borradores de acción (plan §5 #1 y #6, §10) ──────────────────────────
-- Toda acción que Mapi propone queda aquí ANTES de ejecutarse. El botón
-- Confirmar la reclama con un UPDATE atómico (status 'draft' → 'executing'),
-- que es lo que garantiza que dos clics ejecuten una sola vez.
-- Escribe solo el BFF (service_role) después de validar permisos.

CREATE TABLE IF NOT EXISTS public.mapi_action_drafts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id       uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- Conversación de Mapi donde se mostró la tarjeta (para dibujarla en el chat).
    ticket_id       uuid NULL REFERENCES public.support_tickets(id) ON DELETE SET NULL,
    -- Mensaje de Mapi que presentó la tarjeta: el chat la dibuja debajo de él.
    message_id      uuid NULL REFERENCES public.support_messages(id) ON DELETE SET NULL,
    tool          text NOT NULL CHECK (char_length(tool) BETWEEN 1 AND 80),
    -- «Mismo objeto» de §10.4 (p. ej. 'deportista:<id>' o 'cartera:2026-10'):
    -- un borrador nuevo de la misma herramienta sobre el mismo objeto reemplaza
    -- al anterior.
    target_key      text NULL CHECK (target_key IS NULL OR char_length(target_key) <= 200),
    args            jsonb NOT NULL DEFAULT '{}'::jsonb,
    preview         jsonb NOT NULL,
    -- Hash de la vista previa: al confirmar se vuelve a preparar y se compara (§10.1).
    content_hash    text NOT NULL CHECK (char_length(content_hash) BETWEEN 16 AND 128),
    status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','executing','executed','partial','failed','cancelled','expired','superseded')),
    replaced_by     uuid NULL REFERENCES public.mapi_action_drafts(id) ON DELETE SET NULL,
    result          jsonb NULL,
    failure_reason  text NULL CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 500),
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
    executing_since timestamptz NULL,
    executed_at     timestamptz NULL,
    CONSTRAINT mapi_action_drafts_expira_despues CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.mapi_action_drafts IS
    'Acciones que Mapi propone (borrador → Confirmar). Escribe solo el BFF con service_role. Retención: 1 año (plan Mapi agente §12.3).';

-- Borradores pendientes de un usuario y vencimiento al listar (sin cron, §10.4).
CREATE INDEX IF NOT EXISTS mapi_action_drafts_user_status_idx
    ON public.mapi_action_drafts (user_id, status, expires_at);
-- Tarjetas de una conversación.
CREATE INDEX IF NOT EXISTS mapi_action_drafts_ticket_idx
    ON public.mapi_action_drafts (ticket_id, created_at) WHERE ticket_id IS NOT NULL;
-- Reemplazo por mismo objeto y tope de acciones masivas por escuela y día.
CREATE INDEX IF NOT EXISTS mapi_action_drafts_school_tool_idx
    ON public.mapi_action_drafts (school_id, tool, created_at);
-- Métricas y retención.
CREATE INDEX IF NOT EXISTS mapi_action_drafts_created_idx
    ON public.mapi_action_drafts (created_at);

ALTER TABLE public.mapi_action_drafts ENABLE ROW LEVEL SECURITY;

-- Cada usuario lee solo los suyos. Nadie escribe desde el cliente.
DROP POLICY IF EXISTS mapi_action_drafts_select_own ON public.mapi_action_drafts;
CREATE POLICY mapi_action_drafts_select_own ON public.mapi_action_drafts
    FOR SELECT
    TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- Los privilegios por defecto del esquema dan ALL a anon y authenticated:
-- se quitan explícitamente (CLAUDE.md, trampa 3; mismo arreglo que c7b63a14).
REVOKE ALL ON public.mapi_action_drafts FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.mapi_action_drafts FROM authenticated;
GRANT SELECT ON public.mapi_action_drafts TO authenticated;
GRANT ALL ON public.mapi_action_drafts TO service_role;

-- ─── 2. Encendido por escuela y permisos del coach (plan §5 #2 y #5) ─────────

ALTER TABLE public.school_settings
    ADD COLUMN IF NOT EXISTS mapi_agent_enabled    boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS coach_mapi_attendance boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS coach_mapi_notices    boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.school_settings.mapi_agent_enabled IS
    'Modo agente de Mapi en esta escuela. Lo prende SportMaps (escuela de pruebas → piloto → resto); el admin de la escuela no puede cambiarlo (trigger school_settings_mapi_agent_guard).';
COMMENT ON COLUMN public.school_settings.coach_mapi_attendance IS
    'El coach puede excusar ausencias de sus equipos desde Mapi.';
COMMENT ON COLUMN public.school_settings.coach_mapi_notices IS
    'El coach puede enviar avisos desde Mapi (oleada 3).';

-- Las policies «School settings: manage admin» y «Admin puede escribir
-- school_settings» son FOR ALL: sin esto, un admin de escuela podría prender
-- el agente con un PATCH directo. RLS filtra filas, no columnas (trampa 4):
-- el candado de la columna va en un trigger. Desde la app (authenticated/anon)
-- el valor se conserva; service_role y postgres (SQL Editor) sí lo cambian.
CREATE OR REPLACE FUNCTION public.school_settings_mapi_agent_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF current_user IN ('authenticated', 'anon') THEN
        IF TG_OP = 'INSERT' THEN
            NEW.mapi_agent_enabled := false;
        ELSE
            NEW.mapi_agent_enabled := OLD.mapi_agent_enabled;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.school_settings_mapi_agent_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS school_settings_mapi_agent_guard ON public.school_settings;
CREATE TRIGGER school_settings_mapi_agent_guard
    BEFORE INSERT OR UPDATE OF mapi_agent_enabled ON public.school_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.school_settings_mapi_agent_guard();

-- ─── 3. Costo por modo (plan §5 #3, §13.3) ──────────────────────────────────
-- `model` ya existe en llm_usage; solo se amplía el CHECK de `feature`.

ALTER TABLE public.llm_usage DROP CONSTRAINT IF EXISTS llm_usage_feature_check;
ALTER TABLE public.llm_usage ADD CONSTRAINT llm_usage_feature_check
    CHECK (feature = ANY (ARRAY['bot','ocr','transcripcion','sportbot','pizarra_ia','mapi_agente','mapi_evals']::text[]));

COMMIT;
