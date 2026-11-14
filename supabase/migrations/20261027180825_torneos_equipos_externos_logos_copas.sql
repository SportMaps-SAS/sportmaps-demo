-- =============================================================================
-- 20261027180825_torneos_equipos_externos_logos_copas.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261024084549
-- Spec: docs/specs/torneos-en-vivo-multideporte-plan.md («Payload público v2»)
-- Objetivo (todo aditivo; nada cambia para los torneos que ya existen):
--   1. Equipos rivales EXTERNOS en event_teams: solo nombre (+ club, nombre corto, logo), sin
--      cuenta ni delegación. delegation_id pasa a NULL-able con CHECK: externo ⇔ sin delegación.
--      Se eligió columna en la MISMA tabla (no tabla aparte) porque tournament_matches.home/away_team_id
--      ya apuntan a event_teams: así el sorteo, el calendario, la tabla y el avance de llaves tratan
--      igual a internos y externos sin FK polimórfica ni dos caminos de lectura.
--   2. Logo por equipo; logo, fecha de cierre, reglamento y sede del torneo (la portada reutiliza
--      events.banner_url). Las imágenes van al bucket EXISTENTE `school-assets`
--      (lectura pública; escritura solo admin de la escuela en logos/<school_id>/… y covers/<school_id>/…).
--      No se crea bucket ni se tocan sus policies.
--   3. tournament_sponsors: patrocinadores por torneo (nombre, logo, url, tier, orden).
--   4. tournament_matches.cup_label: varias copas (oro / plata…) desde la fase de grupos.
--   5. RPC reschedule_tournament_match: editar hora y cancha a mano + log en UNA transacción.
-- RLS: escritura del organizador con user_admin_school_ids() (vía helper SECURITY DEFINER);
--   nunca user_school_ids(). Se cierra además el FOR ALL sin WITH CHECK de teams_school_manage (I3).
-- NO aplicada por el agente: la aplica la sesión principal.
-- =============================================================================

BEGIN;

-- ── Helper: ¿el usuario administra la escuela dueña de este torneo? ──────────
-- SECURITY DEFINER: lee events sin disparar su RLS (sin recursión desde policies de otras tablas).
CREATE OR REPLACE FUNCTION public.is_event_school_admin(p_event_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.events e
         WHERE e.id = p_event_id
           AND e.school_id IS NOT NULL
           AND e.school_id = ANY (public.user_admin_school_ids())
    );
$$;
REVOKE ALL ON FUNCTION public.is_event_school_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_event_school_admin(uuid) TO authenticated, service_role;

-- ── 1. event_teams: equipos externos + logo ──────────────────────────────────
ALTER TABLE public.event_teams ALTER COLUMN delegation_id DROP NOT NULL;

ALTER TABLE public.event_teams
    ADD COLUMN IF NOT EXISTS is_external boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS club_name   text,
    ADD COLUMN IF NOT EXISTS short_name  text,
    ADD COLUMN IF NOT EXISTS logo_url    text;

ALTER TABLE public.event_teams
    ADD CONSTRAINT event_teams_external_sin_delegacion
    CHECK (is_external = (delegation_id IS NULL));
ALTER TABLE public.event_teams
    ADD CONSTRAINT event_teams_short_name_len
    CHECK (short_name IS NULL OR char_length(short_name) BETWEEN 1 AND 4);
ALTER TABLE public.event_teams
    ADD CONSTRAINT event_teams_club_name_len
    CHECK (club_name IS NULL OR char_length(club_name) <= 120);
ALTER TABLE public.event_teams
    ADD CONSTRAINT event_teams_logo_url_https
    CHECK (logo_url IS NULL OR (char_length(logo_url) <= 500 AND logo_url LIKE 'https://%'));

-- Pegar la misma lista dos veces no duplica rivales en la categoría.
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_teams_external_name
    ON public.event_teams (event_id, category_id, lower(btrim(team_name)))
    WHERE is_external;

COMMENT ON COLUMN public.event_teams.is_external IS
    'true = rival externo cargado por el organizador (solo nombre/club/logo, sin cuenta ni delegación).';
COMMENT ON COLUMN public.event_teams.short_name IS 'Sigla de hasta 4 letras para tablas y marcadores (opcional).';

-- RLS: el organizador (admin de la escuela dueña) gestiona SOLO los externos de su torneo.
DROP POLICY IF EXISTS teams_host_manage_external ON public.event_teams;
CREATE POLICY teams_host_manage_external ON public.event_teams
    FOR ALL TO authenticated
    USING      (is_external AND public.is_event_school_admin(event_id))
    WITH CHECK (is_external AND public.is_event_school_admin(event_id));

-- Cierre I3: la policy existente era FOR ALL sin WITH CHECK (PostgreSQL validaba los INSERT con USING).
-- Misma expresión, ahora explícita en ambos lados y solo para authenticated (usa auth.uid()).
DROP POLICY IF EXISTS teams_school_manage ON public.event_teams;
CREATE POLICY teams_school_manage ON public.event_teams
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

-- ── 2. events: identidad del torneo para la página pública ───────────────────
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS logo_url       text,
    ADD COLUMN IF NOT EXISTS end_date       date,
    ADD COLUMN IF NOT EXISTS rules_url      text,
    ADD COLUMN IF NOT EXISTS venue_name     text,
    ADD COLUMN IF NOT EXISTS venue_maps_url text,
    ADD COLUMN IF NOT EXISTS organizer_name text;

ALTER TABLE public.events
    ADD CONSTRAINT events_end_date_after_start
    CHECK (end_date IS NULL OR event_date IS NULL OR end_date >= event_date);
ALTER TABLE public.events
    ADD CONSTRAINT events_torneo_urls_https
    CHECK (
        (logo_url       IS NULL OR (char_length(logo_url)       <= 500 AND logo_url       LIKE 'https://%'))
    AND (rules_url      IS NULL OR (char_length(rules_url)      <= 500 AND rules_url      LIKE 'https://%'))
    AND (venue_maps_url IS NULL OR (char_length(venue_maps_url) <= 500 AND venue_maps_url LIKE 'https://%'))
    );
ALTER TABLE public.events
    ADD CONSTRAINT events_torneo_textos_len
    CHECK ((venue_name IS NULL OR char_length(venue_name) <= 120) AND (organizer_name IS NULL OR char_length(organizer_name) <= 120));

COMMENT ON COLUMN public.events.logo_url IS 'Logo del torneo (bucket school-assets). La portada es banner_url.';
COMMENT ON COLUMN public.events.organizer_name IS 'Nombre visible del organizador. NULL = nombre de la escuela dueña.';

-- ── 3. Patrocinadores por torneo ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tournament_sponsors (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    logo_url   text CHECK (logo_url IS NULL OR (char_length(logo_url) <= 500 AND logo_url LIKE 'https://%')),
    url        text CHECK (url IS NULL OR (char_length(url) <= 500 AND url LIKE 'https://%')),
    tier       text NOT NULL DEFAULT 'aliado' CHECK (tier IN ('principal','oficial','aliado')),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tsponsors_event ON public.tournament_sponsors (event_id, sort_order);

ALTER TABLE public.tournament_sponsors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_sponsors FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournament_sponsors TO authenticated;
GRANT ALL ON public.tournament_sponsors TO service_role;

DROP POLICY IF EXISTS tsponsors_host_manage ON public.tournament_sponsors;
CREATE POLICY tsponsors_host_manage ON public.tournament_sponsors
    FOR ALL TO authenticated
    USING      (public.is_event_school_admin(event_id))
    WITH CHECK (public.is_event_school_admin(event_id));
-- Lo público sale por el BFF (GET /tournament-live/public/:slug/live); anon no lee la tabla.

-- ── 4. Varias copas desde grupos ─────────────────────────────────────────────
ALTER TABLE public.tournament_matches
    ADD COLUMN IF NOT EXISTS cup_label text;
ALTER TABLE public.tournament_matches
    ADD CONSTRAINT tournament_matches_cup_label_len
    CHECK (cup_label IS NULL OR char_length(btrim(cup_label)) BETWEEN 1 AND 40);
COMMENT ON COLUMN public.tournament_matches.cup_label IS
    'Copa a la que pertenece el partido de fase final («Copa oro», «Copa plata»). NULL = grupos/liga o copa única.';

-- ── 5. Editar hora y cancha a mano: cambio + log en una sola transacción ─────
CREATE OR REPLACE FUNCTION public.reschedule_tournament_match(
    p_match_id     uuid,
    p_set_time     boolean,
    p_scheduled_at timestamptz,
    p_set_court    boolean,
    p_court        text,
    p_actor_id     text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_event uuid;
    v_time  timestamptz;
    v_court text;
BEGIN
    SELECT event_id, scheduled_at, court INTO v_event, v_time, v_court
      FROM public.tournament_matches WHERE id = p_match_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'not_found');
    END IF;

    UPDATE public.tournament_matches
       SET scheduled_at = CASE WHEN p_set_time  THEN p_scheduled_at ELSE scheduled_at END,
           court        = CASE WHEN p_set_court THEN NULLIF(btrim(p_court), '') ELSE court END
     WHERE id = p_match_id;

    INSERT INTO public.tournament_match_log (match_id, event_id, actor_type, actor_id, action, before_state, after_state)
    VALUES (
        p_match_id, v_event, 'user', p_actor_id, 'reschedule',
        jsonb_build_object('scheduled_at', v_time, 'court', v_court),
        jsonb_build_object(
            'scheduled_at', CASE WHEN p_set_time  THEN p_scheduled_at ELSE v_time END,
            'court',        CASE WHEN p_set_court THEN NULLIF(btrim(p_court), '') ELSE v_court END)
    );
    RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.reschedule_tournament_match(uuid, boolean, timestamptz, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_tournament_match(uuid, boolean, timestamptz, boolean, text, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
