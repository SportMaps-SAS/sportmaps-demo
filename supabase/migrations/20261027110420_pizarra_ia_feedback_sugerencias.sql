-- =============================================================================
-- 20261027110420_pizarra_ia_feedback_sugerencias.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27
-- Objetivo: medir la calidad de la IA de la pizarra.
--   · Botones «Útil / No útil» en cada sugerencia (contraataque o variante).
--   · Qué sugerencias terminan en «Guardar como nueva jugada».
--
-- Una fila por (usuario, escuela, análisis, tipo, índice). El análisis se
-- identifica por su board_hash (el mismo de la caché tactical_ai_analyses,
-- que es anónima): NO se guarda texto del cliente (el título que ve el coach
-- puede llevar etiquetas escritas por él); el texto de la sugerencia se lee de
-- la caché por (school_id, board_hash).
--
-- Escritura: el BFF (POST /api/v1/school/tactical/ai-feedback) con la sesión del
-- coach (userClient → RLS aplica). Validaciones del BFF: rol táctico, que el
-- análisis exista en la caché de SU escuela y que la sugerencia exista.
--
-- RLS (sin recursión, ninguna policy lee esta tabla):
--   SELECT  : el dueño de la fila, o el admin de plataforma (is_super_admin()).
--   INSERT  : solo filas propias (user_id = auth.uid()) en una escuela donde
--             TRABAJA (user_staff_school_ids(): sin padres ni atletas).
--   UPDATE  : solo filas propias, y el WITH CHECK impide mudarlas a otro
--             usuario o a una escuela donde no trabaja.
--   DELETE  : nadie (sin policy y sin GRANT).
--   anon    : sin GRANT.
--
-- Estados en text + CHECK (no CREATE TYPE).
--
-- Verificación (después de aplicar):
--   select cmd, policyname, roles, qual, with_check from pg_policies
--    where tablename = 'tactical_ai_suggestion_feedback';
--   set local role anon; select count(*) from public.tactical_ai_suggestion_feedback;  -- permission denied
--   -- como coach A: insertar con user_id de B → 42501 (new row violates RLS)
--   npm run seguridad:invariantes  (I3: ninguna FOR ALL; no hay FOR ALL acá)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tactical_ai_suggestion_feedback (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id         uuid        NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  user_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  board_hash        text        NOT NULL,
  sport             text        NOT NULL,
  suggestion_kind   text        NOT NULL,
  suggestion_index  smallint    NOT NULL,
  verdict           text,
  saved_as_play_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tactical_ai_feedback_hash_check  CHECK (board_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT tactical_ai_feedback_sport_check CHECK (sport IN ('futbol', 'futbol7', 'futbol5', 'futsal', 'voleibol', 'baloncesto', 'balonmano')),
  CONSTRAINT tactical_ai_feedback_kind_check  CHECK (suggestion_kind IN ('contraataque', 'variante')),
  CONSTRAINT tactical_ai_feedback_index_check CHECK (suggestion_index BETWEEN 0 AND 9),
  CONSTRAINT tactical_ai_feedback_verdict_check CHECK (verdict IS NULL OR verdict IN ('util', 'no_util')),
  CONSTRAINT tactical_ai_feedback_key UNIQUE (user_id, school_id, board_hash, suggestion_kind, suggestion_index)
);
CREATE INDEX IF NOT EXISTS tactical_ai_feedback_school_idx ON public.tactical_ai_suggestion_feedback (school_id, created_at);
CREATE INDEX IF NOT EXISTS tactical_ai_feedback_hash_idx   ON public.tactical_ai_suggestion_feedback (school_id, board_hash);

COMMENT ON TABLE public.tactical_ai_suggestion_feedback IS
  'Pizarra IA: «Útil / No útil» por sugerencia y si terminó en «Guardar como nueva jugada». Sin texto del cliente; el texto vive en tactical_ai_analyses (anónima).';

ALTER TABLE public.tactical_ai_suggestion_feedback ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tactical_ai_suggestion_feedback FROM PUBLIC, anon;
REVOKE DELETE, TRUNCATE ON public.tactical_ai_suggestion_feedback FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tactical_ai_suggestion_feedback TO authenticated;
GRANT ALL ON public.tactical_ai_suggestion_feedback TO service_role;

DROP POLICY IF EXISTS tactical_ai_feedback_select ON public.tactical_ai_suggestion_feedback;
CREATE POLICY tactical_ai_feedback_select
  ON public.tactical_ai_suggestion_feedback
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_super_admin())
  );

DROP POLICY IF EXISTS tactical_ai_feedback_insert ON public.tactical_ai_suggestion_feedback;
CREATE POLICY tactical_ai_feedback_insert
  ON public.tactical_ai_suggestion_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
  );

DROP POLICY IF EXISTS tactical_ai_feedback_update ON public.tactical_ai_suggestion_feedback;
CREATE POLICY tactical_ai_feedback_update
  ON public.tactical_ai_suggestion_feedback
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
  );

-- updated_at
CREATE OR REPLACE FUNCTION public.tactical_ai_feedback_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tactical_ai_feedback_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tactical_ai_feedback_touch ON public.tactical_ai_suggestion_feedback;
CREATE TRIGGER tactical_ai_feedback_touch
  BEFORE UPDATE ON public.tactical_ai_suggestion_feedback
  FOR EACH ROW EXECUTE FUNCTION public.tactical_ai_feedback_touch();
