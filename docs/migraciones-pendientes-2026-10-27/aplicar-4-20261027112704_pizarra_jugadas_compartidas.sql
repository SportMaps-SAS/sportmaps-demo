-- =============================================================================
-- 20261027112704_pizarra_jugadas_compartidas.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: «Compartir por WhatsApp» con un ENLACE de la pizarra táctica: la
--   jugada se guarda con un token y se abre en la web, en una vista pública de
--   solo lectura (/jugada/:token), sin iniciar sesión.
--
-- Diseño (CLAUDE.md, trampa 5): NO hay policy «…_by_token» con USING(true).
--   La tabla queda cerrada (RLS sin policies + REVOKE a anon/authenticated) y
--   todo pasa por dos RPC SECURITY DEFINER:
--     · create_tactical_shared_play(team, título, deporte, payload) → token.
--       Solo quien puede editar la pizarra del equipo
--       (user_tactical_edit_school_ids(), el mismo gate del BFF).
--     · get_tactical_shared_play(token) → la jugada. anon + authenticated.
--       Recibe el token y compara; sin token válido no devuelve nada.
--     · revoke_tactical_shared_play(token): el autor (o la administración de
--       la escuela) apaga el enlace.
--
-- Privacidad: el payload lo arma el frontend SIN nombres de deportistas
-- (claves p1…pn, dorsal o iniciales; ver lib/school/tacticalSharedPlay.ts).
-- La RPC de creación además le quita 'playerNames', 'notes' y 'videos' por si
-- un cliente viejo los mandara. El token es aleatorio (18 bytes, base64url).
--
-- Disk IO: get_ es una sola lectura por índice único (sin contador de vistas
-- para no escribir en cada apertura de un enlace público).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.tactical_shared_plays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token       text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{16,64}$'),
  school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  created_by  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  sport       text CHECK (sport IS NULL OR char_length(sport) <= 40),
  payload     jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

COMMENT ON TABLE public.tactical_shared_plays IS
  'Jugadas de la pizarra compartidas por enlace (/jugada/:token). Cerrada: solo por RPC (create_/get_/revoke_tactical_shared_play).';

CREATE INDEX IF NOT EXISTS tactical_shared_plays_created_by_idx
  ON public.tactical_shared_plays (created_by, created_at DESC);

ALTER TABLE public.tactical_shared_plays ENABLE ROW LEVEL SECURITY;
-- Sin policies a propósito: nadie lee ni escribe la tabla directo.
REVOKE ALL ON TABLE public.tactical_shared_plays FROM PUBLIC;
REVOKE ALL ON TABLE public.tactical_shared_plays FROM anon;
REVOKE ALL ON TABLE public.tactical_shared_plays FROM authenticated;
GRANT ALL ON TABLE public.tactical_shared_plays TO service_role;

-- ── Crear el enlace ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_tactical_shared_play(
  p_team_id uuid,
  p_title   text,
  p_sport   text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_school uuid;
  v_clean  jsonb;
  v_token  text;
  v_recent int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT t.school_id INTO v_school FROM public.teams t WHERE t.id = p_team_id;
  IF v_school IS NULL OR NOT (v_school = ANY (public.user_tactical_edit_school_ids())) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_allowed');
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_payload');
  END IF;
  -- Nada de nombres, notas ni videos en la vista pública.
  v_clean := p_payload - 'playerNames' - 'notes' - 'videos';
  IF octet_length(v_clean::text) > 300000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_large');
  END IF;

  -- Tope sano por persona (un enlace por toque de «Compartir»).
  SELECT count(*) INTO v_recent
    FROM public.tactical_shared_plays sp
   WHERE sp.created_by = v_uid AND sp.created_at > now() - interval '1 day';
  IF v_recent >= 200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  v_token := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', '-_');

  INSERT INTO public.tactical_shared_plays (token, school_id, team_id, created_by, title, sport, payload)
  VALUES (
    v_token, v_school, p_team_id, v_uid,
    left(coalesce(btrim(p_title), ''), 120),
    nullif(left(coalesce(btrim(p_sport), ''), 40), ''),
    v_clean
  );

  RETURN jsonb_build_object('ok', true, 'token', v_token);
END;
$$;

COMMENT ON FUNCTION public.create_tactical_shared_play(uuid, text, text, jsonb) IS
  'Guarda una jugada de la pizarra para compartir por enlace. Solo quien edita la pizarra de la escuela del equipo. Devuelve {ok, token}.';

-- ── Leer por token (vista pública) ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_tactical_shared_play(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object(
           'title', sp.title,
           'sport', sp.sport,
           'payload', sp.payload,
           'created_at', sp.created_at
         )
    INTO v
    FROM public.tactical_shared_plays sp
   WHERE sp.token = p_token AND sp.status = 'active';
  RETURN v;
END;
$$;

COMMENT ON FUNCTION public.get_tactical_shared_play(text) IS
  'Jugada compartida por token (solo lectura, sin nombres de deportistas). NULL si el token no existe o se revocó.';

-- ── Apagar un enlace ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_tactical_shared_play(p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows int;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.tactical_shared_plays sp
     SET status = 'revoked', revoked_at = now()
   WHERE sp.token = p_token
     AND sp.status = 'active'
     AND (sp.created_by = auth.uid() OR sp.school_id = ANY (public.user_admin_school_ids()));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

COMMENT ON FUNCTION public.revoke_tactical_shared_play(text) IS
  'Apaga un enlace de jugada compartida (su autor o la administración de la escuela).';

-- ── Permisos explícitos (los default privileges dan EXECUTE a authenticated) ─
REVOKE ALL ON FUNCTION public.create_tactical_shared_play(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_tactical_shared_play(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_tactical_shared_play(text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_tactical_shared_play(uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tactical_shared_play(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_tactical_shared_play(text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.create_tactical_shared_play(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_tactical_shared_play(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_tactical_shared_play(text) TO service_role;

COMMIT;
