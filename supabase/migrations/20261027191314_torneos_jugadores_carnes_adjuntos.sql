-- =============================================================================
-- 20261027191314_torneos_jugadores_carnes_adjuntos.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261027180907
-- Spec: docs/specs/torneos-en-vivo-multideporte-plan.md («Jugadores, carnés y validación en cancha»)
-- Requiere: 20261027180825 (event_teams.is_external, is_event_school_admin()).
-- Objetivo (aditivo):
--   1. Jugadores también en los equipos EXTERNOS: event_team_members.delegation_id NULL-able con
--      CHECK externo ⇔ sin delegación. Se reutiliza la tabla de siempre (las estadísticas por
--      jugadora y el MVP del agente «vivo» ya apuntan a event_team_members.id).
--   2. Ficha de jugador del torneo: apodo, posición, número, fecha de nacimiento, teléfono, foto,
--      campos propios (extra jsonb), suspensión y versión del carné (subirla invalida el QR viejo).
--   3. events: formulario de jugador configurable, diseño del carné y adjuntos públicos.
--   4. tournament_team_invites: link de inscripción del equipo para el delegado (sin cuenta) y
--      prospecto de SportMaps con consentimiento explícito.
-- Privacidad: documento y teléfono solo los lee el organizador por el BFF; nada para anon.
-- NO aplicada por el agente: la aplica la sesión principal.
-- =============================================================================

BEGIN;

-- ── 1 y 2. event_team_members ────────────────────────────────────────────────
ALTER TABLE public.event_team_members ALTER COLUMN delegation_id DROP NOT NULL;

ALTER TABLE public.event_team_members
    ADD COLUMN IF NOT EXISTS is_external      boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS nickname         text,
    ADD COLUMN IF NOT EXISTS position         text,
    ADD COLUMN IF NOT EXISTS shirt_number     integer,
    ADD COLUMN IF NOT EXISTS birth_date       date,
    ADD COLUMN IF NOT EXISTS phone            text,
    ADD COLUMN IF NOT EXISTS photo_url        text,
    ADD COLUMN IF NOT EXISTS extra            jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS suspended        boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS suspended_reason text,
    ADD COLUMN IF NOT EXISTS card_version     integer NOT NULL DEFAULT 1;

ALTER TABLE public.event_team_members
    ADD CONSTRAINT event_team_members_external_sin_delegacion CHECK (is_external = (delegation_id IS NULL));
ALTER TABLE public.event_team_members
    ADD CONSTRAINT event_team_members_ficha_check CHECK (
        (shirt_number IS NULL OR shirt_number BETWEEN 0 AND 999)
    AND (nickname IS NULL OR char_length(nickname) <= 40)
    AND (position IS NULL OR char_length(position) <= 40)
    AND (phone IS NULL OR char_length(phone) <= 30)
    AND (photo_url IS NULL OR (char_length(photo_url) <= 500 AND photo_url LIKE 'https://%'))
    AND (suspended_reason IS NULL OR char_length(suspended_reason) <= 200)
    AND jsonb_typeof(extra) = 'object'
    AND card_version >= 1
    );

CREATE INDEX IF NOT EXISTS idx_event_team_members_team ON public.event_team_members (team_id);

-- RLS: el organizador gestiona los jugadores de SUS equipos externos.
-- La subconsulta a event_teams corre con la RLS del que llama: el admin ve sus externos por
-- teams_host_manage_external; no hay recursión (no lee event_team_members).
DROP POLICY IF EXISTS members_host_manage_external ON public.event_team_members;
CREATE POLICY members_host_manage_external ON public.event_team_members
    FOR ALL TO authenticated
    USING (is_external AND team_id IN (
        SELECT t.id FROM public.event_teams t WHERE t.is_external AND public.is_event_school_admin(t.event_id)))
    WITH CHECK (is_external AND team_id IN (
        SELECT t.id FROM public.event_teams t WHERE t.is_external AND public.is_event_school_admin(t.event_id)));

-- Cierre I3: members_school_manage era FOR ALL sin WITH CHECK. Misma expresión en ambos lados.
DROP POLICY IF EXISTS members_school_manage ON public.event_team_members;
CREATE POLICY members_school_manage ON public.event_team_members
    FOR ALL TO authenticated
    USING (delegation_id IN (
        SELECT d.id FROM public.event_delegations d
          JOIN public.school_members sm ON sm.school_id = d.school_id
         WHERE sm.profile_id = auth.uid()
           AND sm.role = ANY (ARRAY['owner','admin','school_admin'])
           AND sm.status = 'active'))
    WITH CHECK (delegation_id IN (
        SELECT d.id FROM public.event_delegations d
          JOIN public.school_members sm ON sm.school_id = d.school_id
         WHERE sm.profile_id = auth.uid()
           AND sm.role = ANY (ARRAY['owner','admin','school_admin'])
           AND sm.status = 'active'));

-- ── 3. events: formulario de jugador, carné y adjuntos ──────────────────────
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS player_form  jsonb,
    ADD COLUMN IF NOT EXISTS card_config  jsonb,
    ADD COLUMN IF NOT EXISTS attachments  jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.events
    ADD CONSTRAINT events_torneo_jsonb_shapes CHECK (
        (player_form IS NULL OR jsonb_typeof(player_form) = 'object')
    AND (card_config IS NULL OR jsonb_typeof(card_config) = 'object')
    AND jsonb_typeof(attachments) = 'array'
    AND jsonb_array_length(attachments) <= 20
    );

COMMENT ON COLUMN public.events.player_form IS
    'Formulario de jugador del torneo: { required: [campos base obligatorios], custom: [{key,label,type:text|date|bool|select,options?,required?}] }';
COMMENT ON COLUMN public.events.card_config IS
    'Carné del torneo: { subtitle, color, fields: [hasta 3 de number|nickname|document|position|phone], public_photo }';
COMMENT ON COLUMN public.events.attachments IS 'Adjuntos públicos del torneo: [{ name, url }] (reglamento, programación…).';

-- ── 4. Link de inscripción del equipo (delegado sin cuenta) ─────────────────
-- Un link por equipo. Solo se guarda el HASH del token (como tournament_scorekeepers).
-- El delegado es además el PROSPECTO de SportMaps (origen = torneo) cuando da su consentimiento
-- (Ley 1581): no se reutiliza school_signup_leads porque esa tabla es de prospectos DE una escuela
-- (alumnos de esa escuela, con clase de prueba), no de clubes para la plataforma.
CREATE TABLE IF NOT EXISTS public.tournament_team_invites (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    team_id             uuid NOT NULL REFERENCES public.event_teams(id) ON DELETE CASCADE,
    token_hash          text NOT NULL,
    delegate_name       text CHECK (delegate_name IS NULL OR char_length(delegate_name) <= 120),
    delegate_phone      text CHECK (delegate_phone IS NULL OR char_length(delegate_phone) <= 30),
    delegate_email      text CHECK (delegate_email IS NULL OR char_length(delegate_email) <= 160),
    expires_at          timestamptz,
    revoked_at          timestamptz,
    opened_at           timestamptz,
    team_colors         jsonb CHECK (team_colors IS NULL OR jsonb_typeof(team_colors) = 'object'),
    roster_target       integer CHECK (roster_target IS NULL OR roster_target BETWEEN 1 AND 200),
    roster_submitted_at timestamptz,
    rules_accepted_at   timestamptz,
    consent_at          timestamptz,
    consent_version     text,
    payment_status      text NOT NULL DEFAULT 'not_required'
                        CHECK (payment_status IN ('not_required','pending','proof_sent','paid')),
    payment_amount      numeric(12,2) CHECK (payment_amount IS NULL OR payment_amount >= 0),
    payment_proof_path  text,
    completed_at        timestamptz,
    wants_sportmaps_at  timestamptz,
    lead_origin         text NOT NULL DEFAULT 'torneo' CHECK (lead_origin IN ('torneo')),
    created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tteam_invites_token ON public.tournament_team_invites (token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tteam_invites_team ON public.tournament_team_invites (team_id);
CREATE INDEX IF NOT EXISTS idx_tteam_invites_event ON public.tournament_team_invites (event_id);
-- Prospectos con consentimiento (para el equipo comercial).
CREATE INDEX IF NOT EXISTS idx_tteam_invites_leads ON public.tournament_team_invites (consent_at) WHERE consent_at IS NOT NULL;

ALTER TABLE public.tournament_team_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_team_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_team_invites TO authenticated;
GRANT ALL ON public.tournament_team_invites TO service_role;
DROP POLICY IF EXISTS tteam_invites_host_manage ON public.tournament_team_invites;
CREATE POLICY tteam_invites_host_manage ON public.tournament_team_invites
    FOR ALL TO authenticated
    USING      (public.is_event_school_admin(event_id))
    WITH CHECK (public.is_event_school_admin(event_id));
-- El delegado NO tiene cuenta: todo lo suyo pasa por el BFF con el token (service_role).

COMMIT;

NOTIFY pgrst, 'reload schema';
