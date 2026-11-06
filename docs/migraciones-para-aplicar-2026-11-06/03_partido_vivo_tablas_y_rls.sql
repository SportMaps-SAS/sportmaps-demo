-- =============================================================================
-- 20261105231602_partido_vivo_tablas_y_rls.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105231554
-- Objetivo: Partido en vivo de Carmel, Fase 1, migración 2 de 4
--   (docs/plan-partido-en-vivo-f1.md §4). Cuatro tablas nuevas, RLS solo SELECT
--   para staff, ninguna escritura directa (se escribe solo por RPC SECURITY DEFINER),
--   y el trigger que protege match_lineup_players una vez iniciado el partido.
-- PRECONDICIÓN: 20261105231554 (match_results.match_kind, etc.).
-- ORDEN: 2 de 4.
-- DECISIONES: text+CHECK (sin CREATE TYPE) · FKs de negocio a profiles(id) ·
--   director_id NULL ON DELETE SET NULL · period_no + period_second (no game_second) ·
--   goles/tarjetas viven también en match_live_events (se espejan al terminar).
-- RLS: UNA policy SELECT por tabla (staff de la escuela o platform admin), sin FOR ALL,
--   sin policies de escritura, sin GRANT de escritura, nada para anon (I1/I2/I3).
-- RADIO: tablas nuevas y vacías. El trigger roza match_lineup_players de TODAS las
--   escuelas pero es inerte sin una fila de match_live (que solo crea start_live_match).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- 1. match_live (1:1 con match_results) ----------------------------------------
CREATE TABLE IF NOT EXISTS public.match_live (
  match_id        uuid PRIMARY KEY REFERENCES public.match_results(id) ON DELETE CASCADE,
  school_id       uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'not_started'
                  CONSTRAINT match_live_status_chk CHECK (status IN ('not_started','in_period','on_break','finished','voided')),
  periods_planned smallint NOT NULL CONSTRAINT match_live_periods_planned_chk CHECK (periods_planned BETWEEN 1 AND 4),
  current_period  smallint NOT NULL DEFAULT 0 CONSTRAINT match_live_current_period_chk CHECK (current_period BETWEEN 0 AND 4),
  director_id     uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  started_at      timestamptz NULL,
  finished_at     timestamptz NULL,
  finished_by     uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  reopened_at     timestamptz NULL,
  reopen_count    smallint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_live_current_le_planned_chk CHECK (current_period <= periods_planned),
  -- «terminado» implica fecha de cierre (la regla fina de reabiertos la imponen las RPC)
  CONSTRAINT match_live_finished_chk CHECK (status <> 'finished' OR finished_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS match_live_school_active_idx
  ON public.match_live (school_id) WHERE status IN ('in_period','on_break');

-- 2. match_live_periods -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.match_live_periods (
  match_id         uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  period_no        smallint NOT NULL CONSTRAINT match_live_periods_no_chk CHECK (period_no BETWEEN 1 AND 4),
  planned_seconds  integer NOT NULL CONSTRAINT match_live_periods_planned_chk CHECK (planned_seconds BETWEEN 300 AND 3600),
  started_at       timestamptz NULL,
  ended_at         timestamptz NULL,
  actual_seconds   integer NULL CONSTRAINT match_live_periods_actual_chk CHECK (actual_seconds IS NULL OR actual_seconds BETWEEN 0 AND 10800),
  stoppage_seconds integer GENERATED ALWAYS AS (GREATEST(0, actual_seconds - planned_seconds)) STORED,
  PRIMARY KEY (match_id, period_no),
  CONSTRAINT match_live_periods_order_chk CHECK (ended_at IS NULL OR started_at IS NOT NULL)
);

-- 3. match_live_events (fuente de verdad, inmutable) --------------------------
CREATE TABLE IF NOT EXISTS public.match_live_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id        uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  client_event_id  uuid NOT NULL,
  seq              bigint GENERATED ALWAYS AS IDENTITY,
  type             text NOT NULL CONSTRAINT match_live_events_type_chk CHECK (type IN
                     ('period_start','period_end','sub','goal','goal_against','yellow','red',
                      'clock_adjust','callup','match_end','match_reopen')),
  period_no        smallint NOT NULL CONSTRAINT match_live_events_period_chk CHECK (period_no BETWEEN 1 AND 4),
  in_break         boolean NOT NULL DEFAULT false,
  period_second    integer NOT NULL CONSTRAINT match_live_events_second_chk CHECK (period_second BETWEEN 0 AND 10800),
  subject_type     text NULL CONSTRAINT match_live_events_subject_type_chk CHECK (subject_type IN ('profile','child','unregistered')),
  subject_id       uuid NULL,
  related_type     text NULL CONSTRAINT match_live_events_related_type_chk CHECK (related_type IN ('profile','child','unregistered')),
  related_id       uuid NULL,
  reason           text NULL CONSTRAINT match_live_events_reason_chk CHECK (reason IN ('tactical','injury','other')),
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb
                   CONSTRAINT match_live_events_payload_chk CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 2048),
  client_at        timestamptz NULL,
  created_by       uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  voided_at        timestamptz NULL,
  voided_by        uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT match_live_events_client_uniq UNIQUE (match_id, client_event_id),
  CONSTRAINT match_live_events_pair_subject_chk CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT match_live_events_pair_related_chk CHECK ((related_type IS NULL) = (related_id IS NULL)),
  CONSTRAINT match_live_events_shape_chk CHECK (
       (type = 'sub'          AND subject_id IS NOT NULL AND related_id IS NOT NULL
                              AND NOT (subject_type = related_type AND subject_id = related_id))
    OR (type = 'goal'         AND subject_id IS NOT NULL AND in_break = false)
    OR (type = 'goal_against' AND subject_id IS NULL AND related_id IS NULL AND in_break = false)
    OR (type IN ('yellow','red') AND subject_id IS NOT NULL AND related_id IS NULL)
    OR (type IN ('period_start','period_end','clock_adjust','match_end','match_reopen')
                              AND subject_id IS NULL AND related_id IS NULL)
    OR (type = 'callup'       AND subject_id IS NOT NULL AND related_id IS NULL)),
  CONSTRAINT match_live_events_reason_only_sub_chk CHECK (reason IS NULL OR type = 'sub')
);
CREATE UNIQUE INDEX IF NOT EXISTS match_live_events_one_start_uq
  ON public.match_live_events (match_id, period_no) WHERE type = 'period_start' AND voided_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_live_events_one_end_uq
  ON public.match_live_events (match_id, period_no) WHERE type = 'period_end' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS match_live_events_replay_idx
  ON public.match_live_events (match_id, period_no, period_second, seq);

-- 4. match_player_stints (derivado, se regenera completo) ---------------------
CREATE TABLE IF NOT EXISTS public.match_player_stints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id      uuid NOT NULL REFERENCES public.match_live(match_id) ON DELETE CASCADE,
  school_id     uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CONSTRAINT match_player_stints_subject_type_chk CHECK (subject_type IN ('profile','child','unregistered')),
  subject_id    uuid NOT NULL,
  period_no     smallint NOT NULL CONSTRAINT match_player_stints_period_chk CHECK (period_no BETWEEN 1 AND 4),
  in_second     integer NOT NULL CONSTRAINT match_player_stints_in_chk CHECK (in_second >= 0),
  out_second    integer NULL,
  ended_by      text NULL CONSTRAINT match_player_stints_ended_by_chk CHECK (ended_by IN ('sub','period_end','red','match_end')),
  in_event_id   uuid NULL,
  out_event_id  uuid NULL,
  CONSTRAINT match_player_stints_span_chk CHECK ((out_second IS NULL AND ended_by IS NULL) OR (out_second > in_second AND ended_by IS NOT NULL)),
  CONSTRAINT match_player_stints_uniq UNIQUE (match_id, subject_type, subject_id, period_no, in_second)
);
CREATE INDEX IF NOT EXISTS match_player_stints_match_idx
  ON public.match_player_stints (match_id, period_no);

-- 5. RLS: solo SELECT para staff; nada de escritura; nada para anon -------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['match_live','match_live_periods','match_live_events','match_player_stints'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_staff', t);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I
        FOR SELECT TO authenticated
        USING (
          (SELECT public.is_platform_admin())
          OR school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
        )$p$, t || '_select_staff', t);
  END LOOP;
END $$;

-- 6. Trigger de protección de match_lineup_players ------------------------------
-- Las policies existentes dejan a quien edita táctica borrar/cambiar filas por REST.
-- Con el partido iniciado eso rompería minutos y tramos. Solo DELETE y UPDATE OF
-- role/subject_*; INSERT, dorsal, posición y minutos siguen libres.
CREATE OR REPLACE FUNCTION public._live_guard_lineup_players()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_started boolean;
BEGIN
  -- Cascadas (borrado de escuela/usuario/convocatoria) no se bloquean.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(OLD, NEW);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.role = OLD.role AND NEW.subject_id = OLD.subject_id
     AND NEW.subject_type = OLD.subject_type THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.match_lineups ml
      JOIN public.match_live l ON l.match_id = ml.source_id
     WHERE ml.id = OLD.lineup_id AND ml.source_type = 'team_match'
       AND l.status IN ('in_period','on_break','finished')
  ) INTO v_started;
  IF v_started THEN
    RAISE EXCEPTION 'El partido ya empezó; use los cambios en vivo'
      USING ERRCODE = 'P0001', HINT = 'LIVE_STARTED';
  END IF;
  RETURN COALESCE(OLD, NEW);
END $$;
REVOKE ALL ON FUNCTION public._live_guard_lineup_players() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_live_guard_lineup_players ON public.match_lineup_players;
CREATE TRIGGER trg_live_guard_lineup_players
  BEFORE DELETE OR UPDATE OF role, subject_id, subject_type ON public.match_lineup_players
  FOR EACH ROW EXECUTE FUNCTION public._live_guard_lineup_players();

COMMIT;
