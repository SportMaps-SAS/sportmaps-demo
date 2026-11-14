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
