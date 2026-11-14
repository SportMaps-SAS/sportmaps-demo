-- LOTE 4 — TORNEOS (2026-10-27). 3 migraciones en orden + registro en schema_migrations.
-- Aditivas: no rompen el BFF/frontend actuales (el BFF nuevo baja solo si falta una columna).

-- >>> supabase/migrations/20261027180907_torneos_vivo_seguir_social_tiempo_real.sql
-- =============================================================================
-- 20261027180907_torneos_vivo_seguir_social_tiempo_real.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261027150500
-- Objetivo: lo que hace única la experiencia de torneos en vivo (agente «vivo»).
--   1. Tiempo real: policy de LECTURA en realtime.messages para los canales
--      privados `tlive:<slug>` (Broadcast). Nadie puede EMITIR desde el cliente:
--      sin policy de INSERT, solo el BFF (service_role) publica.
--   2. Seguir torneo / equipo (`tournament_follows`) y la marca anti-duplicado de
--      avisos por partido (`tournament_match_notices`).
--   3. MVP del partido: votos del público (uno por dispositivo) y elección del
--      organizador.
--   4. Comentarios por partido, fotos/videos/noticias (posts) y bucket
--      `tournament-media` (lectura pública, escritura SOLO por el BFF).
--   5. Estadísticas por jugadora (ace / ataque / bloqueo) atadas a la posición
--      del punto: si el punto se deshace, la estadística deja de contar.
--   6. Índice para el recordatorio «tu partido empieza en 15 min».
-- Todo lo nuevo es del BFF: RLS encendida y nada para anon. Única excepción:
-- cada usuario puede LEER y BORRAR sus propios follows.
-- Spec: docs/specs/torneos-en-vivo-multideporte-plan.md («Experiencia en vivo»).
-- =============================================================================

BEGIN;

-- ── 1. Realtime Broadcast privado `tlive:*` ─────────────────────────────────
-- Canal privado = Realtime consulta estas policies al UNIRSE (una vez por
-- conexión), no por mensaje. Solo lectura y solo el prefijo `tlive:`; el
-- contenido es lo mismo que ya publica GET /public/:slug/live.
DROP POLICY IF EXISTS tlive_broadcast_lectura ON realtime.messages;
CREATE POLICY tlive_broadcast_lectura ON realtime.messages
    FOR SELECT TO anon, authenticated
    USING (
        realtime.messages.extension = 'broadcast'
        AND (SELECT realtime.topic()) LIKE 'tlive:%'
    );

-- ── 2. Seguir ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tournament_follows (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    -- NULL = todo el torneo
    team_id    uuid REFERENCES public.event_teams(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tournament_follows_unico
    ON public.tournament_follows (event_id, user_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS tournament_follows_event ON public.tournament_follows (event_id);
CREATE INDEX IF NOT EXISTS tournament_follows_user ON public.tournament_follows (user_id);

ALTER TABLE public.tournament_follows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_follows FROM anon, authenticated, PUBLIC;
GRANT SELECT, DELETE ON public.tournament_follows TO authenticated;
-- Alta solo por el BFF (valida que el torneo sea público y el equipo sea del torneo).
DROP POLICY IF EXISTS tournament_follows_select_propios ON public.tournament_follows;
CREATE POLICY tournament_follows_select_propios ON public.tournament_follows
    FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS tournament_follows_delete_propios ON public.tournament_follows;
CREATE POLICY tournament_follows_delete_propios ON public.tournament_follows
    FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

-- Un aviso por partido y tipo: el INSERT … ON CONFLICT DO NOTHING decide quién envía.
CREATE TABLE IF NOT EXISTS public.tournament_match_notices (
    match_id   uuid NOT NULL REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('starting_soon', 'started', 'final')),
    recipients integer NOT NULL DEFAULT 0,
    sent_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, kind)
);
ALTER TABLE public.tournament_match_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_match_notices FROM anon, authenticated, PUBLIC;

-- ── 3. MVP ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tournament_mvp_votes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id   uuid NOT NULL REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    member_id  uuid NOT NULL REFERENCES public.event_team_members(id) ON DELETE CASCADE,
    -- sha256(dispositivo + partido): no se guarda el identificador crudo
    voter_hash text NOT NULL,
    ip_hash    text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, voter_hash)
);
CREATE INDEX IF NOT EXISTS tournament_mvp_votes_match ON public.tournament_mvp_votes (match_id);
ALTER TABLE public.tournament_mvp_votes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_mvp_votes FROM anon, authenticated, PUBLIC;

CREATE TABLE IF NOT EXISTS public.tournament_match_mvp (
    match_id   uuid PRIMARY KEY REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    member_id  uuid NOT NULL REFERENCES public.event_team_members(id) ON DELETE CASCADE,
    chosen_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    chosen_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tournament_match_mvp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_match_mvp FROM anon, authenticated, PUBLIC;

-- ── 4. Comentarios, medios y noticias ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tournament_comments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    match_id       uuid REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    author_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    author_name    text NOT NULL CHECK (char_length(author_name) BETWEEN 2 AND 40),
    body           text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
    status         text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
    voter_hash     text,
    ip_hash        text,
    moderated_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_comments_match ON public.tournament_comments (match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tournament_comments_event ON public.tournament_comments (event_id, created_at DESC);
ALTER TABLE public.tournament_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_comments FROM anon, authenticated, PUBLIC;

CREATE TABLE IF NOT EXISTS public.tournament_posts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    -- NULL = del torneo (no de un partido)
    match_id      uuid REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('photo', 'video', 'news')),
    title         text CHECK (title IS NULL OR char_length(title) <= 120),
    body          text CHECK (body IS NULL OR char_length(body) <= 2000),
    media_path    text,
    video_url     text,
    status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
    created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    scorekeeper_id uuid REFERENCES public.tournament_scorekeepers(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (kind = 'photo' AND media_path IS NOT NULL)
        OR (kind = 'video' AND video_url IS NOT NULL)
        OR (kind = 'news' AND body IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS tournament_posts_event ON public.tournament_posts (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tournament_posts_match ON public.tournament_posts (match_id, created_at DESC);
ALTER TABLE public.tournament_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_posts FROM anon, authenticated, PUBLIC;

-- Bucket público de lectura (las fotos se ven en la página pública por URL).
-- SIN policies de INSERT/UPDATE/DELETE en storage.objects para anon/authenticated:
-- solo el BFF (service_role) sube y borra, después de validar al organizador o
-- al anotador. 8 MB, solo imágenes.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tournament-media', 'tournament-media', true, 8388608,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
    SET public = true, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ── 5. Estadísticas por jugadora ────────────────────────────────────────────
-- point_index = posición del punto en live_state.points (0-based). Si el punto
-- se deshace (la secuencia queda más corta) o lo ganó el otro lado, no cuenta.
CREATE TABLE IF NOT EXISTS public.tournament_player_stats (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    match_id    uuid NOT NULL REFERENCES public.tournament_matches(id) ON DELETE CASCADE,
    team_id     uuid NOT NULL REFERENCES public.event_teams(id) ON DELETE CASCADE,
    member_id   uuid NOT NULL REFERENCES public.event_team_members(id) ON DELETE CASCADE,
    side        text NOT NULL CHECK (side IN ('home', 'away')),
    stat        text NOT NULL CHECK (stat IN ('ace', 'attack', 'block')),
    point_index integer NOT NULL CHECK (point_index >= 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, point_index)
);
CREATE INDEX IF NOT EXISTS tournament_player_stats_event ON public.tournament_player_stats (event_id);
ALTER TABLE public.tournament_player_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_player_stats FROM anon, authenticated, PUBLIC;

-- ── 6. Recordatorio «empieza en 15 min» (job cada 5 min, una consulta) ──────
CREATE INDEX IF NOT EXISTS idx_tmatches_scheduled_pendientes
    ON public.tournament_matches (scheduled_at) WHERE status = 'scheduled';

COMMIT;

-- Verificación (después de aplicar):
--   select policyname, roles, cmd, qual from pg_policies where schemaname = 'realtime' and tablename = 'messages';
--   select tablename, policyname, cmd from pg_policies where tablename like 'tournament_%' order by 1;
--   set local role anon; select count(*) from public.tournament_comments;   -- debe fallar (permission denied)
--   select id, public, file_size_limit from storage.buckets where id = 'tournament-media';
--   npm run seguridad:invariantes


-- >>> supabase/migrations/20261027180825_torneos_equipos_externos_logos_copas.sql
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


-- >>> supabase/migrations/20261027191314_torneos_jugadores_carnes_adjuntos.sql
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


INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
  ('20261027180825', 'torneos_equipos_externos_logos_copas'),
  ('20261027180907', 'torneos_vivo_seguir_social_tiempo_real'),
  ('20261027191314', 'torneos_jugadores_carnes_adjuntos')
ON CONFLICT (version) DO NOTHING;
