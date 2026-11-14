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
