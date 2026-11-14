-- LOTE 2026-10-27 (v2, corregido ::uuid[]) — 6 migraciones en orden. Aplicar de una sola vez en el SQL Editor.
-- NO incluye las de notificaciones (sec/fixes-1027): esas van aparte y en su orden.

-- >>> supabase/migrations/20261027110401_pizarra_ia_cupo_ampliado_temporal.sql
-- =============================================================================
-- 20261027110401_pizarra_ia_cupo_ampliado_temporal.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27
-- Objetivo: cupo de IA de la pizarra AMPLIADO TEMPORALMENTE por escuela, con
--   fecha de vencimiento, sin tocar el cupo base. Primer uso: Club Carmel x3
--   durante su prueba, hasta el 2026-11-04 23:59 hora Colombia.
--
-- Cómo se calcula hoy el cupo (20261015171128_pizarra_ia_cupo_por_entrenador_tokens):
--   · tactical_ai_user_usage.budget_micro_usd   = FOTO de tactical_ai_user_budget_micro_usd()
--     (USD 1,00) al abrir el mes del usuario.
--   · tactical_ai_school_usage.ceiling_micro_usd = FOTO de 10 × eso (USD 10,00).
--   · tactical_ai_reserve compara (budget + extra − used − reserved) contra el
--     estimado; _tactical_ai_balance_json arma el saldo que ve el coach.
--
-- Por qué NO se cambia la foto ni se usa un grant: los dos son permanentes para
--   el mes (un grant de noviembre seguiría vivo después del 4). El override es un
--   MULTIPLICADOR que se lee en el momento de cada reserva y de cada consulta de
--   saldo: mientras now() esté dentro de [starts_at, expires_at) el presupuesto
--   del usuario y el techo de la escuela valen base × multiplicador; al vencer,
--   vuelven solos al normal (sin job, sin otra migración). Lo que ya se gastó no
--   se devuelve: si al vencer el gasto del mes supera el cupo normal, el coach
--   ve «Usaste tu IA de este mes» hasta el 1.º del mes siguiente.
--   Si hay dos overrides vigentes a la vez manda el MAYOR (no se multiplican).
--
-- Cambios:
--   1. Tabla tactical_ai_quota_overrides (text/numeric + CHECK, FKs a schools/profiles).
--   2. tactical_ai_quota_multiplier(school, at) → numeric (1 si no hay).
--   3. _tactical_ai_balance_json(uuid, uuid, text) y tactical_ai_reserve(...):
--      CREATE OR REPLACE con el MISMO cuerpo vivo (verificado el 2026-10-27 contra
--      pg_proc: idéntico al de 20261015171128) + el multiplicador. El JSON de
--      saldo suma la clave `boost` { multiplier, expires_at } cuando aplica.
--   4. INSERT del override de Carmel (374a6716-af42-4745-afe1-8d089153e01b,
--      «Carmel Club»), idempotente.
--
-- Seguridad: la tabla la escribe solo service_role (o el SQL de esta migración).
--   Lee el super admin y el admin de la escuela (para saber por qué su cupo es
--   otro). Funciones nuevas con search_path fijo, EXECUTE solo service_role.
--
-- Verificación (después de aplicar):
--   select * from public.tactical_ai_quota_overrides;
--   select public.tactical_ai_quota_multiplier('374a6716-af42-4745-afe1-8d089153e01b');            -- 3
--   select public.tactical_ai_quota_multiplier('374a6716-af42-4745-afe1-8d089153e01b',
--          '2026-11-05 00:00:00-05');                                                              -- 1
--   select public.tactical_ai_user_balance('374a6716-af42-4745-afe1-8d089153e01b', '<uuid coach>'); -- budget 3000000, boost
--   set local role anon; select count(*) from public.tactical_ai_quota_overrides;                  -- permission denied
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tabla
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tactical_ai_quota_overrides (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   uuid          NOT NULL REFERENCES public.schools(id)  ON DELETE CASCADE,
  multiplier  numeric(6,2)  NOT NULL,
  starts_at   timestamptz   NOT NULL DEFAULT now(),
  expires_at  timestamptz   NOT NULL,
  note        text,
  created_by  uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tactical_ai_quota_overrides_multiplier_check CHECK (multiplier > 0 AND multiplier <= 20),
  CONSTRAINT tactical_ai_quota_overrides_window_check     CHECK (expires_at > starts_at),
  CONSTRAINT tactical_ai_quota_overrides_note_len         CHECK (note IS NULL OR char_length(note) <= 300)
);
CREATE INDEX IF NOT EXISTS tactical_ai_quota_overrides_school_idx
  ON public.tactical_ai_quota_overrides (school_id, expires_at);

COMMENT ON TABLE public.tactical_ai_quota_overrides IS
  'Pizarra IA: multiplicador TEMPORAL del cupo (usuario y techo de escuela) por escuela, vigente en [starts_at, expires_at). Al vencer el cupo vuelve solo al normal.';

ALTER TABLE public.tactical_ai_quota_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tactical_ai_quota_overrides FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tactical_ai_quota_overrides FROM authenticated;
GRANT SELECT ON public.tactical_ai_quota_overrides TO authenticated;
GRANT ALL ON public.tactical_ai_quota_overrides TO service_role;

DROP POLICY IF EXISTS tactical_ai_quota_overrides_select ON public.tactical_ai_quota_overrides;
CREATE POLICY tactical_ai_quota_overrides_select
  ON public.tactical_ai_quota_overrides
  FOR SELECT
  TO authenticated
  USING (
    school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[])
    OR (SELECT public.is_super_admin())
  );

-- -----------------------------------------------------------------------------
-- 2. Multiplicador vigente
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tactical_ai_quota_multiplier(p_school_id uuid, p_at timestamptz DEFAULT now())
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(MAX(o.multiplier), 1)::numeric
    FROM public.tactical_ai_quota_overrides o
   WHERE o.school_id = p_school_id
     AND p_at >= o.starts_at
     AND p_at <  o.expires_at
$$;

REVOKE ALL ON FUNCTION public.tactical_ai_quota_multiplier(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tactical_ai_quota_multiplier(uuid, timestamptz) TO service_role;

-- -----------------------------------------------------------------------------
-- 3a. Saldo con el multiplicador (+ boost para el medidor del coach)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._tactical_ai_balance_json(p_school_id uuid, p_user_id uuid, p_period text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_u    public.tactical_ai_user_usage;
  v_s    public.tactical_ai_school_usage;
  v_mult numeric := public.tactical_ai_quota_multiplier(p_school_id, now());
  v_exp  timestamptz;
BEGIN
  SELECT * INTO v_s FROM public.tactical_ai_school_usage WHERE school_id = p_school_id AND period = p_period;
  IF p_user_id IS NOT NULL THEN
    SELECT * INTO v_u FROM public.tactical_ai_user_usage
     WHERE school_id = p_school_id AND user_id = p_user_id AND period = p_period;
  END IF;
  IF v_mult <> 1 THEN
    SELECT MAX(o.expires_at) INTO v_exp
      FROM public.tactical_ai_quota_overrides o
     WHERE o.school_id = p_school_id AND now() >= o.starts_at AND now() < o.expires_at
       AND o.multiplier = v_mult;
  END IF;
  RETURN jsonb_build_object(
    'period', p_period,
    'user', CASE WHEN p_user_id IS NULL THEN NULL ELSE jsonb_build_object(
      'budget_micro_usd',   round(COALESCE(v_u.budget_micro_usd, public.tactical_ai_user_budget_micro_usd()) * v_mult)::bigint,
      'extra_micro_usd',    COALESCE(v_u.extra_micro_usd, 0),
      'used_micro_usd',     COALESCE(v_u.used_micro_usd, 0),
      'reserved_micro_usd', COALESCE(v_u.reserved_micro_usd, 0),
      'analyses',           COALESCE(v_u.analyses, 0),
      'cache_hits',         COALESCE(v_u.cache_hits, 0)
    ) END,
    'school', jsonb_build_object(
      'ceiling_micro_usd',  round(COALESCE(v_s.ceiling_micro_usd, public.tactical_ai_school_ceiling_micro_usd()) * v_mult)::bigint,
      'extra_micro_usd',    COALESCE(v_s.extra_micro_usd, 0),
      'used_micro_usd',     COALESCE(v_s.used_micro_usd, 0),
      'reserved_micro_usd', COALESCE(v_s.reserved_micro_usd, 0)
    ),
    'boost', CASE WHEN v_mult = 1 THEN NULL
                  ELSE jsonb_build_object('multiplier', v_mult, 'expires_at', v_exp) END
  );
END;
$$;

REVOKE ALL ON FUNCTION public._tactical_ai_balance_json(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._tactical_ai_balance_json(uuid, uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 3b. Reserva con el multiplicador (resto idéntico al cuerpo vivo)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tactical_ai_reserve(
  p_school_id uuid,
  p_user_id uuid,
  p_sport text,
  p_estimate_micro_usd bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_period text := public.tactical_ai_current_period();
  v_s      public.tactical_ai_school_usage;
  v_u      public.tactical_ai_user_usage;
  v_scope  text;
  v_id     uuid;
  v_mult   numeric;
BEGIN
  IF p_school_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'school_id y user_id requeridos' USING ERRCODE = '22023';
  END IF;
  IF p_estimate_micro_usd IS NULL OR p_estimate_micro_usd < 1 OR p_estimate_micro_usd > 5000000 THEN
    RAISE EXCEPTION 'estimado fuera de rango (1..5000000 microdólares)' USING ERRCODE = '22023';
  END IF;

  -- 1) escuela (candado que serializa todo lo de la escuela), 2) vencidas, 3) usuario.
  PERFORM public._tactical_ai_lock_school(p_school_id, v_period);
  PERFORM public._tactical_ai_expire_stale(p_school_id);
  SELECT * INTO v_s FROM public.tactical_ai_school_usage WHERE school_id = p_school_id AND period = v_period;
  v_u := public._tactical_ai_lock_user(p_school_id, p_user_id, v_period);
  -- Cupo ampliado temporal (20261027110401): base × multiplicador vigente.
  v_mult := public.tactical_ai_quota_multiplier(p_school_id, now());

  IF round(v_u.budget_micro_usd * v_mult)::bigint + v_u.extra_micro_usd - v_u.used_micro_usd - v_u.reserved_micro_usd < p_estimate_micro_usd THEN
    v_scope := 'user';
  ELSIF round(v_s.ceiling_micro_usd * v_mult)::bigint + v_s.extra_micro_usd - v_s.used_micro_usd - v_s.reserved_micro_usd < p_estimate_micro_usd THEN
    v_scope := 'school';
  END IF;

  IF v_scope IS NOT NULL THEN
    UPDATE public.tactical_ai_user_usage
       SET needs_more_count = needs_more_count + 1, limit_hit_at = COALESCE(limit_hit_at, now()), updated_at = now()
     WHERE id = v_u.id;
    IF v_scope = 'school' THEN
      UPDATE public.tactical_ai_school_usage
         SET needs_more_count = needs_more_count + 1, limit_hit_at = COALESCE(limit_hit_at, now()), updated_at = now()
       WHERE id = v_s.id;
    END IF;
    INSERT INTO public.tactical_ai_runs (school_id, user_id, period, sport, status, denied_scope, finished_at)
    VALUES (p_school_id, p_user_id, v_period, p_sport, 'denied', v_scope, now());
    RETURN public._tactical_ai_balance_json(p_school_id, p_user_id, v_period)
           || jsonb_build_object('ok', false, 'denied_scope', v_scope);
  END IF;

  INSERT INTO public.tactical_ai_runs (school_id, user_id, period, sport, status, reserved_micro_usd)
  VALUES (p_school_id, p_user_id, v_period, p_sport, 'reserved', p_estimate_micro_usd)
  RETURNING id INTO v_id;
  UPDATE public.tactical_ai_user_usage
     SET reserved_micro_usd = reserved_micro_usd + p_estimate_micro_usd, updated_at = now()
   WHERE id = v_u.id;
  UPDATE public.tactical_ai_school_usage
     SET reserved_micro_usd = reserved_micro_usd + p_estimate_micro_usd, updated_at = now()
   WHERE id = v_s.id;

  RETURN public._tactical_ai_balance_json(p_school_id, p_user_id, v_period)
         || jsonb_build_object('ok', true, 'reservation_id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.tactical_ai_reserve(uuid, uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tactical_ai_reserve(uuid, uuid, text, bigint) TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Club Carmel: x3 durante la prueba, hasta el 2026-11-04 23:59 (Bogotá, UTC−5).
--    expires_at es EXCLUSIVO: 2026-11-05 00:00 −05 = vale todo el 4 de noviembre.
--    Idempotente (no duplica si se corre dos veces) y solo si la escuela existe
--    con ese nombre.
-- -----------------------------------------------------------------------------
INSERT INTO public.tactical_ai_quota_overrides (school_id, multiplier, starts_at, expires_at, note)
SELECT s.id, 3, now(), timestamptz '2026-11-05 00:00:00-05',
       'Prueba Club Carmel: cupo de IA x3 hasta el 2026-11-04 23:59 hora Colombia (pedido 2026-10-27).'
  FROM public.schools s
 WHERE s.id = '374a6716-af42-4745-afe1-8d089153e01b'
   AND s.name ILIKE '%carmel%'
   AND NOT EXISTS (
     SELECT 1 FROM public.tactical_ai_quota_overrides o
      WHERE o.school_id = s.id AND o.expires_at = timestamptz '2026-11-05 00:00:00-05'
   );


-- >>> supabase/migrations/20261027110420_pizarra_ia_feedback_sugerencias.sql
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


-- >>> supabase/migrations/20261027111037_solicitudes_borrado_cuenta.sql
-- ============================================================================
-- Solicitudes de borrado de cuenta (Ley 1581/2012, derecho de supresión) — B12
-- ============================================================================
--
-- Mi cuenta › Seguridad respondía 500: `GET /api/v1/me/data-deletion-request`
-- lee `account_deletion_requests`, que NO existe en la base viva. La parte 3-5
-- de 20260522141000_security_hardening_p1.sql nunca se aplicó (y esa migración
-- no se edita). Verificado el 2026-10-27 con to_regclass y pg_proc: no existen
-- la tabla ni `request_account_deletion` ni `cancel_account_deletion`.
--
-- Diferencias con la versión de mayo (la base cambió desde entonces):
--   · Las RPC reciben `p_user_id`: el BFF las llama con el cliente de
--     service_role, donde auth.uid() es NULL (la versión vieja respondía
--     siempre `auth_required`). Por eso EXECUTE es SOLO de service_role; el
--     BFF pasa `req.user.id` del JWT ya validado.
--   · `recurring_subscriptions` hoy es (payer_user_id, cancel_reason,
--     cancelled_by) con CHECK (status = 'cancelled') = (cancel_reason IS NOT NULL)
--     y cancel_reason ∈ {…, 'account_deleted', …}; no hay `user_id` ni
--     `cancelled_reason` ni estado 'paused'.
--   · FK a public.profiles(id) (convención del repo), no a auth.users.
--
-- Efecto al aplicarla: el job `account-deletion.job.ts` (ya desplegado) empieza
-- a encontrar la tabla y anonimiza las cuentas cuyo `scheduled_for` venció.
-- Hoy no hay ninguna solicitud (la tabla no existía), así que no hace nada
-- hasta que alguien pida borrar su cuenta y pasen 30 días.
--
-- Idempotente: CREATE TABLE/INDEX IF NOT EXISTS, DROP POLICY IF EXISTS,
-- CREATE OR REPLACE FUNCTION.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason          text,
    requested_at    timestamptz NOT NULL DEFAULT now(),
    scheduled_for   timestamptz NOT NULL,               -- requested_at + 30 días
    status          text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'cancelled', 'completed', 'failed')),
    cancelled_at    timestamptz,
    completed_at    timestamptz,
    error_message   text,
    -- Trazabilidad legal
    ip_address      inet,
    user_agent      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.account_deletion_requests IS
  'Solicitudes de supresión de cuenta (Ley 1581). Las crea/cancela el BFF vía request_account_deletion / cancel_account_deletion; las ejecuta account-deletion.job.ts al cumplirse scheduled_for.';

-- Una sola solicitud pendiente por usuario.
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_deletion_pending
    ON public.account_deletion_requests (user_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_account_deletion_scheduled
    ON public.account_deletion_requests (scheduled_for)
    WHERE status = 'pending';

ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Lectura: solo la propia. Escritura: nadie desde el cliente (solo las RPC y
-- el job, con service_role). Sin policies de INSERT/UPDATE/DELETE a propósito.
DROP POLICY IF EXISTS "account_deletion_owner_select" ON public.account_deletion_requests;
CREATE POLICY "account_deletion_owner_select" ON public.account_deletion_requests
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON public.account_deletion_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_deletion_requests TO authenticated;
GRANT ALL ON public.account_deletion_requests TO service_role;


-- ----------------------------------------------------------------------------
-- request_account_deletion(p_user_id, …)
-- Programa el borrado a 30 días y, de inmediato, corta los cobros
-- automáticos (débito) y desactiva las tarjetas guardadas.
-- ----------------------------------------------------------------------------

-- La firma de mayo (sin p_user_id) nunca llegó a la base; si alguien la
-- aplicara a mano quedaría una sobrecarga ejecutable por authenticated.
DROP FUNCTION IF EXISTS public.request_account_deletion(text, inet, text);

CREATE OR REPLACE FUNCTION public.request_account_deletion(
    p_user_id    uuid,
    p_reason     text DEFAULT NULL,
    p_ip_address inet DEFAULT NULL,
    p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_id   uuid;
    v_when timestamptz := now() + interval '30 days';
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'auth_required');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'profile_not_found');
    END IF;

    -- 1. Débitos automáticos: no se cobra nada durante la ventana de 30 días.
    UPDATE public.recurring_subscriptions
       SET status        = 'cancelled',
           cancel_reason = 'account_deleted',
           cancelled_by  = p_user_id,
           cancelled_at  = now(),
           updated_at    = now()
     WHERE payer_user_id = p_user_id
       AND status IN ('active', 'suspended');

    -- 2. Tarjetas guardadas: inutilizables desde ya (ni para un cobro suelto).
    UPDATE public.payment_tokens
       SET is_active = false, is_default = false, updated_at = now()
     WHERE user_id = p_user_id AND is_active = true;

    -- 3. La solicitud (si ya había una pendiente, se extiende la ventana).
    INSERT INTO public.account_deletion_requests (user_id, reason, scheduled_for, ip_address, user_agent)
    VALUES (p_user_id, p_reason, v_when, p_ip_address, p_user_agent)
    ON CONFLICT (user_id) WHERE status = 'pending'
    DO UPDATE SET
        reason        = COALESCE(EXCLUDED.reason, account_deletion_requests.reason),
        scheduled_for = EXCLUDED.scheduled_for,
        updated_at    = now()
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'ok', true,
        'request_id', v_id,
        'scheduled_for', v_when,
        'message', 'Tu solicitud se ejecutará en 30 días. Puedes cancelarla mientras esté pendiente.'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.request_account_deletion(uuid, text, inet, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(uuid, text, inet, text) TO service_role;


-- ----------------------------------------------------------------------------
-- cancel_account_deletion(p_user_id) — la persona se arrepiente.
-- NO reactiva tarjetas ni débitos: tiene que volver a inscribirlos (defensivo:
-- si quien cancela es un atacante con la sesión, no le devolvemos las tarjetas).
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.cancel_account_deletion();

CREATE OR REPLACE FUNCTION public.cancel_account_deletion(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'auth_required');
    END IF;

    UPDATE public.account_deletion_requests
       SET status       = 'cancelled',
           cancelled_at = now(),
           updated_at   = now()
     WHERE user_id = p_user_id AND status = 'pending';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'no_pending_request');
    END IF;
    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_account_deletion(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion(uuid) TO service_role;

-- Verificación (después de aplicar):
--   select to_regclass('public.account_deletion_requests');                       -- no null
--   select policyname, roles, qual, with_check from pg_policies where tablename = 'account_deletion_requests';
--   select proname, proacl, proconfig from pg_proc where proname in ('request_account_deletion','cancel_account_deletion');
--     → proacl solo con service_role (y el dueño); proconfig con search_path
--   set local role anon; select count(*) from public.account_deletion_requests; -- permission denied


-- >>> supabase/migrations/20261027112704_pizarra_jugadas_compartidas.sql
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


-- >>> supabase/migrations/20261027124411_cierre_policies_autoadjudicables.sql
-- =============================================================================
-- 20261027124411_cierre_policies_autoadjudicables.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: cerrar las policies "autoadjudicables" (FOR ALL / UPDATE sin
--   WITH CHECK) del plan docs/security/plan-cierre-4-policies-2026-10-27.md,
--   con las opciones recomendadas D1.1–D4.3 aprobadas, más:
--     · events: events_all_access (FOR ALL sin WITH CHECK) fuera,
--       events_update_own con WITH CHECK, y el INSERT directo del cliente exige
--       organizador verificado (o plataforma). Ver "QUEDA FUERA" abajo.
--     · biomech_captures / biomech_baselines: bc_athlete_all, bc_athlete_update,
--       bb_athlete_all separadas por comando y con WITH CHECK.
--     · get_trainer_athlete_ids(uuid): sin EXECUTE para anon ni PUBLIC.
--     · GRANTs sobrantes de anon.
--
-- Radio medido el 2026-10-27 (SELECT puntuales):
--   event_organizers 0 filas · athlete_training_plans 0 · biomech_access_grants 0
--   skill_biomech_evidence 0 · biomech_captures 45 (1 escuela, 2 atletas)
--   biomech_baselines 2 · biomech_analyses 33 · events 12 (4 escuelas, 5 creadores).
--   El BFF escribe todas estas tablas con service role (salta RLS). El frontend
--   solo LEE event_organizers y solo ESCRIBE events en un punto:
--   EventManagementPage → useEvents.updateEvent (registrations_open del propio
--   evento), que sigue pasando (USING y WITH CHECK = creador o plataforma).
--   useEvents.createEvent (INSERT directo) no lo llama ninguna pantalla.
--
-- QUEDA FUERA (rompería un flujo vivo o es decisión de producto):
--   · Guarda de `events.status` para organizadores no verificados: hay 1 evento
--     'active' público de un organizador SIN fila en event_organizers. Exigir
--     verificación en el UPDATE le quitaría el botón de abrir/cerrar
--     inscripciones (EventManagementPage). Pregunta abierta en el plan.
--   · events_select_authenticated USING(true): lo leen calendario de acudiente,
--     explorar, gestión de eventos. Pregunta abierta en el plan.
--
-- NO se tocan helpers de RLS existentes (user_*_school_ids, is_platform_admin,
-- is_school_admin_of). get_trainer_athlete_ids conserva EXECUTE para
-- authenticated: la usan 15 policies TO authenticated.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. get_trainer_athlete_ids(uuid): enumeración de atletas sin sesión
--    Ningún código (frontend/BFF/edge) la llama; solo policies. Las que la usan
--    son TO authenticated, salvo body_metrics_*_trainer ({public}); anon no lee
--    body_metrics en ningún flujo.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.get_trainer_athlete_ids(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_trainer_athlete_ids(uuid) FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. event_organizers  (D1.1 A · D1.2 RPC · trigger de guarda)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS organizer_manage_own_profile ON public.event_organizers;
DROP POLICY IF EXISTS event_organizers_select_own ON public.event_organizers;

CREATE POLICY event_organizers_select_own ON public.event_organizers
  FOR SELECT TO authenticated
  USING (profile_id = (select auth.uid()) OR (select public.is_platform_admin()));

-- Escritura: solo el BFF (service role). El cliente solo lee lo suyo.
REVOKE ALL ON public.event_organizers FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_organizers FROM authenticated;

-- Guarda de is_verified. SECURITY INVOKER a propósito: current_user debe ser
-- el LLAMADOR (en un DEFINER sería el dueño y dejaría pasar a todos).
-- Defensa en profundidad por si algún día se reabre escritura del cliente.
CREATE OR REPLACE FUNCTION public.guard_event_organizers_verificacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR coalesce(auth.role(), '') = 'service_role'
     OR public.is_platform_admin() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.is_verified := false;
  ELSIF NEW.is_verified IS DISTINCT FROM OLD.is_verified THEN
    RAISE EXCEPTION 'is_verified solo lo cambia la plataforma' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM anon;
REVOKE ALL ON FUNCTION public.guard_event_organizers_verificacion() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_event_organizers_verificacion ON public.event_organizers;
CREATE TRIGGER trg_guard_event_organizers_verificacion
  BEFORE INSERT OR UPDATE ON public.event_organizers
  FOR EACH ROW EXECUTE FUNCTION public.guard_event_organizers_verificacion();

-- D1.2: verificar (o des-verificar) un organizador con rastro, solo plataforma.
CREATE OR REPLACE FUNCTION public.verificar_organizador(p_profile_id uuid, p_verificado boolean DEFAULT true)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Solo la plataforma verifica organizadores' USING ERRCODE = '42501';
  END IF;
  UPDATE public.event_organizers
     SET is_verified = coalesce(p_verificado, true),
         updated_at  = now()
   WHERE profile_id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe perfil de organizador para %', p_profile_id USING ERRCODE = 'P0002';
  END IF;
  RETURN coalesce(p_verificado, true);
END
$$;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.verificar_organizador(uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.verificar_organizador(uuid, boolean) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. events  (D1.4 en este lote, sin romper EventManagementPage)
--    events_all_access se va: su SELECT ya lo da events_select_authenticated,
--    su UPDATE events_update_own y su DELETE events_delete_own; lo único que
--    aportaba de más era INSERT/UPDATE sin WITH CHECK.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS events_all_access ON public.events;

DROP POLICY IF EXISTS events_update_own ON public.events;
CREATE POLICY events_update_own ON public.events
  FOR UPDATE TO authenticated
  USING (creator_id = (select auth.uid()) OR (select public.is_platform_admin()))
  WITH CHECK (creator_id = (select auth.uid()) OR (select public.is_platform_admin()));

-- INSERT directo del cliente: solo organizador VERIFICADO o plataforma. La
-- escuela crea por BFF (service role) o por events_school_admin_manage.
DROP POLICY IF EXISTS events_insert_authenticated ON public.events;
CREATE POLICY events_insert_authenticated ON public.events
  FOR INSERT TO authenticated
  WITH CHECK (
    creator_id = (select auth.uid())
    AND (
      (select public.is_platform_admin())
      OR EXISTS (
        SELECT 1 FROM public.event_organizers eo
         WHERE eo.profile_id = (select auth.uid())
           AND eo.is_verified IS TRUE
      )
    )
  );

-- anon conserva SELECT (events_public_read: mapa y página pública del evento).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.events FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Helpers de alcance (nuevos)
-- ─────────────────────────────────────────────────────────────────────────────

-- ¿p_profile trabaja en p_school? Espejo de user_staff_school_ids() para otro
-- perfil (D3.2 aceptado: oráculo de pertenencia de baja sensibilidad).
CREATE OR REPLACE FUNCTION public.es_staff_de_escuela(p_profile uuid, p_school uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_profile IS NOT NULL AND p_school IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.school_members sm
     WHERE sm.profile_id = p_profile AND sm.school_id = p_school
       AND sm.status = 'active' AND sm.role NOT IN ('parent', 'athlete', 'accountant')
    UNION ALL
    SELECT 1 FROM public.school_staff ss
     WHERE ss.coach_auth_id = p_profile AND ss.school_id = p_school AND ss.status = 'active'
    UNION ALL
    SELECT 1 FROM public.school_staff ss
      JOIN auth.users au ON lower(au.email) = lower(ss.email)
     WHERE au.id = p_profile AND ss.school_id = p_school
       AND ss.coach_auth_id IS NULL AND ss.status = 'active'
    UNION ALL
    SELECT 1 FROM public.schools s WHERE s.id = p_school AND s.owner_id = p_profile
  );
$$;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.es_staff_de_escuela(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.es_staff_de_escuela(uuid, uuid) TO authenticated;

-- ¿El usuario de la sesión pertenece a p_school como miembro activo o con una
-- inscripción activa propia? (user_school_ids() no ve inscripciones).
CREATE OR REPLACE FUNCTION public.es_miembro_o_inscrito_de_escuela(p_school uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_school IS NOT NULL AND auth.uid() IS NOT NULL AND (
    p_school = ANY (public.user_school_ids())
    OR EXISTS (
      SELECT 1 FROM public.enrollments e
       WHERE e.school_id = p_school AND e.user_id = auth.uid() AND e.status = 'active'
    )
  );
$$;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.es_miembro_o_inscrito_de_escuela(uuid) TO authenticated;

-- Captura biomecánica que el atleta registra para sí mismo: escuela suya y, si
-- trae sesión, una sesión de ESA escuela asignada a ÉL (evita alimentar
-- bc_coach_read de un entrenador ajeno con un session_plan_id arbitrario).
CREATE OR REPLACE FUNCTION public.puede_registrar_captura_biomecanica(p_school uuid, p_session_plan uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.es_miembro_o_inscrito_de_escuela(p_school)
     AND (
       p_session_plan IS NULL
       OR EXISTS (
         SELECT 1 FROM public.trainer_session_plans tsp
          WHERE tsp.id = p_session_plan
            AND tsp.school_id = p_school
            AND tsp.client_id = auth.uid()
       )
     );
$$;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.puede_registrar_captura_biomecanica(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. athlete_training_plans  (D2.1 policies con alcance · D2.2 sin unregistered
--    · D2.4 admin solo lee/borra)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS atp_trainer_all ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_staff_select ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_insert ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_update ON public.athlete_training_plans;
DROP POLICY IF EXISTS atp_trainer_delete ON public.athlete_training_plans;

CREATE POLICY atp_staff_select ON public.athlete_training_plans
  FOR SELECT TO authenticated
  USING (trainer_id = (select auth.uid())
         OR school_id = ANY ((select public.user_admin_school_ids())::uuid[]));

CREATE POLICY atp_trainer_insert ON public.athlete_training_plans
  FOR INSERT TO authenticated
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    AND client_id IN (SELECT public.get_trainer_athlete_ids(school_id))
  );

CREATE POLICY atp_trainer_update ON public.athlete_training_plans
  FOR UPDATE TO authenticated
  USING (trainer_id = (select auth.uid())
         AND school_id = ANY ((select public.user_staff_school_ids())::uuid[]))
  WITH CHECK (
    trainer_id = (select auth.uid())
    AND school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    AND client_id IN (SELECT public.get_trainer_athlete_ids(school_id))
  );

CREATE POLICY atp_trainer_delete ON public.athlete_training_plans
  FOR DELETE TO authenticated
  USING ((trainer_id = (select auth.uid())
          AND school_id = ANY ((select public.user_staff_school_ids())::uuid[]))
         OR school_id = ANY ((select public.user_admin_school_ids())::uuid[]));

REVOKE ALL ON public.athlete_training_plans FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. biomech_access_grants  (D3.1 policies con alcance · D3.2 helper)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bag_athlete_all ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_select ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_insert ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_update ON public.biomech_access_grants;
DROP POLICY IF EXISTS bag_athlete_delete ON public.biomech_access_grants;

CREATE POLICY bag_athlete_select ON public.biomech_access_grants
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bag_athlete_insert ON public.biomech_access_grants
  FOR INSERT TO authenticated
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.es_miembro_o_inscrito_de_escuela(school_id)
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

-- El atleta activa/desactiva/cambia vencimiento de SUS grants, pero no puede
-- re-apuntarlos a alguien fuera de alcance.
CREATE POLICY bag_athlete_update ON public.biomech_access_grants
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.es_miembro_o_inscrito_de_escuela(school_id)
    AND public.es_staff_de_escuela(coach_id, school_id)
  );

CREATE POLICY bag_athlete_delete ON public.biomech_access_grants
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE ALL ON public.biomech_access_grants FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Lectores del coach (D3.4): un grant solo abre datos mientras el coach
--    siga trabajando en la escuela del grant. La rama de sesión
--    (trainer_session_plans) queda igual.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bc_coach_read ON public.biomech_captures;
CREATE POLICY bc_coach_read ON public.biomech_captures
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.trainer_session_plans tsp
       WHERE tsp.id = biomech_captures.session_plan_id
         AND tsp.trainer_id = (select auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.biomech_access_grants bag
       WHERE bag.athlete_id = biomech_captures.athlete_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

DROP POLICY IF EXISTS ba_coach_read ON public.biomech_analyses;
CREATE POLICY ba_coach_read ON public.biomech_analyses
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.biomech_captures bc
        JOIN public.trainer_session_plans tsp ON tsp.id = bc.session_plan_id
       WHERE bc.id = biomech_analyses.capture_id
         AND tsp.trainer_id = (select auth.uid())
    )
    OR EXISTS (
      SELECT 1 FROM public.biomech_captures bc
        JOIN public.biomech_access_grants bag ON bag.athlete_id = bc.athlete_id
       WHERE bc.id = biomech_analyses.capture_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

DROP POLICY IF EXISTS bb_coach_read ON public.biomech_baselines;
CREATE POLICY bb_coach_read ON public.biomech_baselines
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.biomech_access_grants bag
       WHERE bag.athlete_id = biomech_baselines.athlete_id
         AND bag.coach_id = (select auth.uid())
         AND bag.is_active = true
         AND (bag.expires_at IS NULL OR bag.expires_at > now())
         AND bag.school_id = ANY ((select public.user_staff_school_ids())::uuid[])
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. biomech_captures del atleta: bc_athlete_all + bc_athlete_update sin
--    WITH CHECK → una policy por comando, con la relación correcta.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bc_athlete_all ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_update ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_select ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_insert ON public.biomech_captures;
DROP POLICY IF EXISTS bc_athlete_delete ON public.biomech_captures;

CREATE POLICY bc_athlete_select ON public.biomech_captures
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bc_athlete_insert ON public.biomech_captures
  FOR INSERT TO authenticated
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id)
  );

CREATE POLICY bc_athlete_update ON public.biomech_captures
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (
    athlete_id = (select auth.uid())
    AND public.puede_registrar_captura_biomecanica(school_id, session_plan_id)
  );

CREATE POLICY bc_athlete_delete ON public.biomech_captures
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.biomech_captures FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. biomech_baselines del atleta: bb_athlete_all sin WITH CHECK → por comando.
--    La línea base es del atleta: no puede moverla a otro perfil.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS bb_athlete_all ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_select ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_insert ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_update ON public.biomech_baselines;
DROP POLICY IF EXISTS bb_athlete_delete ON public.biomech_baselines;

CREATE POLICY bb_athlete_select ON public.biomech_baselines
  FOR SELECT TO authenticated
  USING (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_insert ON public.biomech_baselines
  FOR INSERT TO authenticated
  WITH CHECK (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_update ON public.biomech_baselines
  FOR UPDATE TO authenticated
  USING (athlete_id = (select auth.uid()))
  WITH CHECK (athlete_id = (select auth.uid()));

CREATE POLICY bb_athlete_delete ON public.biomech_baselines
  FOR DELETE TO authenticated
  USING (athlete_id = (select auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.biomech_baselines FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. skill_biomech_evidence  (D4.1 A: el cliente no escribe; solo el BFF)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS sbe_adder_all ON public.skill_biomech_evidence;
DROP POLICY IF EXISTS sbe_adder_select ON public.skill_biomech_evidence;

CREATE POLICY sbe_adder_select ON public.skill_biomech_evidence
  FOR SELECT TO authenticated
  USING (added_by = (select auth.uid()));

-- sbe_athlete_read se queda tal cual.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.skill_biomech_evidence FROM authenticated;
REVOKE ALL ON public.skill_biomech_evidence FROM anon;

COMMIT;


-- >>> supabase/migrations/20261027125755_rating_coach_deporte_del_equipo.sql
-- =============================================================================
-- 20261027125755_rating_coach_deporte_del_equipo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-27   Versión anterior: 20261026155701
-- Objetivo: «Evaluar al equipo» (Entrenador V2) y el modal «Califica el entreno
--   de hoy» fallaban con 55000 «La escuela no tiene configurada la métrica de
--   rating del coach» en escuelas multideporte o de un deporte sin catálogo
--   post-entreno (bug B3 de docs/manuales/v2/pruebas-entrenador-v2.md).
--
-- Causa: submit_post_training_coach_rating (20260911123141) tomaba el deporte
--   de schools.category_id. Club Campestre es Golf y su equipo de Fútbol no se
--   podía calificar; coach_effort_rating solo existe para Fútbol, Fútbol Sala y
--   Voleibol.
--
-- Arreglo: el deporte sale del EQUIPO de la sesión, en este orden:
--   1. teams.sport (texto libre) contra sports_categories.name / slug,
--      sin distinguir mayúsculas ("Fútbol", "mma"…), si ese deporte tiene
--      coach_effort_rating activa;
--   2. el deporte de la escuela (schools.category_id), como antes;
--   3. cualquier definición activa de coach_effort_rating (hoy las tres son
--      idénticas: escala 50–100 con las mismas seis opciones; el rating del
--      esfuerzo no depende del deporte). Orden determinista por created_at, id.
--   Solo si no existe NINGUNA definición se mantiene el 55000.
--
-- El cuerpo es la copia EXACTA de la definición viva (pg_proc.prosrc leído el
-- 2026-10-27, SECURITY DEFINER, search_path = pg_catalog, public, pg_temp,
-- EXECUTE a authenticated/service_role) con un único cambio: el bloque que
-- resuelve v_def. Firma, retorno y validaciones sin cambios.
--
-- Verificación (después de aplicar):
--   select prosrc ilike '%t.sport%' as usa_equipo, proconfig, proacl
--     from pg_proc where proname = 'submit_post_training_coach_rating';
--   Y en la app: Club Campestre Demo → Fútbol Sub-15 → Asistencia → cerrar
--   lista → Evaluar al equipo → Guardar: debe quedar 1 fila en
--   performance_entries (metric_key = 'coach_effort_rating', context_id =
--   la sesión) y desaparecer «Falta evaluar» en Hoy.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.submit_post_training_coach_rating(
    p_session_id  uuid,
    p_ratings     jsonb,
    p_coach_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_session      record;
    v_coach_id     uuid;
    v_sport_id     uuid;
    v_def          record;
    v_item         jsonb;
    v_child_id     uuid;
    v_user_id      uuid;
    v_subject_type text;
    v_subject_id   uuid;
    v_status       text;
    v_num          numeric;
    v_saved        int := 0;
    v_pending      int := 0;
BEGIN
    SELECT s.*, sc.category_id AS sport_category_id
      INTO v_session
      FROM public.attendance_sessions s
      JOIN public.schools sc ON sc.id = s.school_id
     WHERE s.id = p_session_id
     FOR UPDATE OF s;

    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Sesión no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF v_session.finalized IS NOT TRUE THEN
        RAISE EXCEPTION 'La sesión todavía no se ha cerrado.' USING ERRCODE = '55000';
    END IF;

    SELECT ss.id INTO v_coach_id
      FROM public.school_staff ss
     WHERE ss.coach_auth_id = auth.uid()
       AND ss.school_id = v_session.school_id
       AND ss.status = 'active';

    IF v_coach_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.team_coaches tc
         WHERE tc.team_id = v_session.team_id AND tc.coach_id = v_coach_id
    ) THEN
        RAISE EXCEPTION 'No autorizado: no eres coach de este equipo.' USING ERRCODE = '42501';
    END IF;

    -- 1) Deporte del EQUIPO de la sesión (teams.sport es texto libre).
    SELECT d.* INTO v_def
      FROM public.teams t
      JOIN public.sports_categories spc
        ON lower(btrim(t.sport)) IN (lower(spc.name), lower(spc.slug))
      JOIN public.sport_metric_definitions d
        ON d.sport_category_id = spc.id
       AND d.metric_key = 'coach_effort_rating'
       AND d.is_active IS NOT FALSE
     WHERE t.id = v_session.team_id
     ORDER BY d.created_at, d.id
     LIMIT 1;

    -- 2) Deporte de la escuela (comportamiento anterior).
    IF v_def.metric_key IS NULL THEN
        v_sport_id := v_session.sport_category_id;

        SELECT * INTO v_def
          FROM public.sport_metric_definitions
         WHERE sport_category_id = v_sport_id AND metric_key = 'coach_effort_rating'
           AND is_active IS NOT FALSE;
    END IF;

    -- 3) Cualquier definición activa: la escala del esfuerzo es la misma en
    --    todos los deportes que la tienen.
    IF v_def.metric_key IS NULL THEN
        SELECT * INTO v_def
          FROM public.sport_metric_definitions
         WHERE metric_key = 'coach_effort_rating'
           AND is_active IS NOT FALSE
         ORDER BY created_at, id
         LIMIT 1;
    END IF;

    IF v_def.metric_key IS NULL THEN
        RAISE EXCEPTION 'La escuela no tiene configurada la métrica de rating del coach.'
            USING ERRCODE = '55000';
    END IF;
    IF jsonb_typeof(p_ratings) <> 'array' THEN
        RAISE EXCEPTION 'p_ratings debe ser un arreglo.' USING ERRCODE = '22023';
    END IF;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_ratings)
    LOOP
        v_child_id := NULLIF(v_item ->> 'child_id', '')::uuid;
        v_user_id  := NULLIF(v_item ->> 'user_id', '')::uuid;

        IF (v_child_id IS NULL) = (v_user_id IS NULL) THEN
            RAISE EXCEPTION 'Cada ítem de p_ratings necesita exactamente uno de child_id/user_id.'
                USING ERRCODE = '22023';
        END IF;

        IF v_child_id IS NOT NULL THEN
            v_subject_type := 'child';   v_subject_id := v_child_id;
        ELSE
            v_subject_type := 'profile'; v_subject_id := v_user_id;
        END IF;

        SELECT ar.status INTO v_status
          FROM public.attendance_records ar
         WHERE ar.session_id = p_session_id
           AND ((v_subject_type = 'child'   AND ar.child_id = v_subject_id)
             OR (v_subject_type = 'profile' AND ar.user_id  = v_subject_id));

        IF v_status IS NULL OR v_status NOT IN ('present', 'late') THEN
            RAISE EXCEPTION 'El atleta % no asistió a esta sesión.', v_subject_id USING ERRCODE = '55000';
        END IF;

        IF NOT (v_item ? 'effort_pct') THEN
            RAISE EXCEPTION 'Falta effort_pct para %.', v_subject_id USING ERRCODE = '22023';
        END IF;

        v_num := (v_item -> 'effort_pct' #>> '{}')::numeric;
        IF (v_def.min_value IS NOT NULL AND v_num < v_def.min_value)
           OR (v_def.max_value IS NOT NULL AND v_num > v_def.max_value) THEN
            RAISE EXCEPTION 'effort_pct fuera de rango para %: %.', v_subject_id, v_num USING ERRCODE = '22023';
        END IF;
        IF v_def.options IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_def.options) o WHERE (o ->> 'value')::numeric = v_num
        ) THEN
            RAISE EXCEPTION 'effort_pct no está en las opciones válidas para %: %.', v_subject_id, v_num
                USING ERRCODE = '22023';
        END IF;

        IF EXISTS (
            SELECT 1 FROM public.athlete_reports r
             WHERE r.school_id = v_session.school_id
               AND r.subject_type = v_subject_type AND r.subject_id = v_subject_id
               AND r.period_year  = EXTRACT(YEAR  FROM v_session.session_date)::smallint
               AND r.period_month = EXTRACT(MONTH FROM v_session.session_date)::smallint
               AND r.status = 'publicado'
        ) THEN
            RAISE EXCEPTION 'El informe de este periodo ya fue publicado para %.', v_subject_id
                USING ERRCODE = '55000';
        END IF;

        INSERT INTO public.performance_entries
            (school_id, subject_type, subject_id, metric_key, value, context_type, context_id, recorded_by)
        VALUES
            (v_session.school_id, v_subject_type, v_subject_id, 'coach_effort_rating',
             v_num, 'session', p_session_id, auth.uid())
        ON CONFLICT (subject_type, subject_id, metric_key, context_id) WHERE context_type = 'session'
        DO UPDATE SET value = EXCLUDED.value, recorded_at = now();

        v_saved := v_saved + 1;
    END LOOP;

    IF p_coach_notes IS NOT NULL THEN
        UPDATE public.attendance_sessions
           SET coach_notes = NULLIF(left(btrim(p_coach_notes), 2000), '')
         WHERE id = p_session_id;
    END IF;

    SELECT count(*) INTO v_pending
      FROM public.attendance_records ar
     WHERE ar.session_id = p_session_id
       AND ar.status IN ('present', 'late')
       AND NOT EXISTS (
           SELECT 1 FROM public.performance_entries pe
            WHERE pe.context_type = 'session' AND pe.context_id = p_session_id
              AND pe.metric_key = 'coach_effort_rating'
              AND ((ar.child_id IS NOT NULL AND pe.subject_type = 'child'   AND pe.subject_id = ar.child_id)
                OR (ar.user_id  IS NOT NULL AND pe.subject_type = 'profile' AND pe.subject_id = ar.user_id))
       );

    RETURN jsonb_build_object('saved', v_saved, 'pending', v_pending);
END;
$function$;

COMMENT ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) IS
    'Rating del coach por atleta, tras cerrar la sesión. SECURITY DEFINER: valida '
    'que el caller sea coach del equipo vía team_coaches, no depende de RLS. '
    'La escala sale del deporte del EQUIPO (teams.sport), luego del de la escuela '
    'y por último de cualquier coach_effort_rating activa (20261027125755).';

-- Mismos privilegios que la definición viva: authenticated + service_role.
REVOKE ALL ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_post_training_coach_rating(uuid, jsonb, text) TO authenticated, service_role;

COMMIT;

