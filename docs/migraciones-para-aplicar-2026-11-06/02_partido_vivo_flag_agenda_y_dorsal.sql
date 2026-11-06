-- =============================================================================
-- 20261105231554_partido_vivo_flag_agenda_y_dorsal.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105231542
-- Objetivo: Partido en vivo de Carmel, Fase 1, migración 1 de 4
--   (docs/plan-partido-en-vivo-f1.md §3; docs/specs/partido-en-vivo-sustituciones.md).
--   · school_settings.live_match_enabled (default false) + columna al final de
--     v_school_entitlements. NO se enciende NINGUNA escuela aquí: el flag queda
--     en false para todas (incluida Carmel). Se enciende aparte, cuando el
--     frontend de la F2 esté listo.
--   · match_results: live_periods_count, live_period_minutes, match_kind, referee_name.
--   · football_match_events.live_event_id (espejo al terminar el partido).
--   · CHECK de rango del dorsal (0..999) en match_lineup_players.
-- PRECONDICIÓN: 20261105213545 aplicada (la vista termina en rubric_allow_na).
-- ORDEN: 1 de 4 (después: tablas y RLS, RPCs, bloqueo roster + minutos al publicar).
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS / DO con guarda.
-- DEFINICIÓN DE LA VISTA: copiada de la base VIVA (pg_get_viewdef, 2026-11-05) con
--   UNA línea nueva al final. Si el día de aplicar la vista viva ya no termina en
--   rubric_allow_na, PARAR y re-extraer (ver 00_LEEME.md).
-- RADIO: ADD COLUMN con default constante (metadatos, sin reescribir tablas en PG15).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- 1. Flag (false para todas; NO se enciende ninguna escuela) ------------------
ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS live_match_enabled boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.school_settings.live_match_enabled IS
  'Partido en vivo (reloj, cambios, minutos). Piloto Carmel. Las RPCs validan este flag ADENTRO.';

-- 2. Vista: definición viva + live_match_enabled AL FINAL ---------------------
-- Guarda: la última columna viva debe ser rubric_allow_na (si no, la vista cambió: parar).
DO $$
DECLARE v_last text;
BEGIN
  SELECT a.attname INTO v_last
    FROM pg_attribute a
   WHERE a.attrelid = 'public.v_school_entitlements'::regclass AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY a.attnum DESC LIMIT 1;
  IF v_last NOT IN ('rubric_allow_na', 'live_match_enabled') THEN
    RAISE EXCEPTION 'v_school_entitlements cambió: la última columna es %, se esperaba rubric_allow_na. Re-extraer la definición viva.', v_last;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_school_entitlements
WITH (security_invoker = true) AS
SELECT s.id AS school_id,
    s.school_type,
    COALESCE(sub.plan_code, 'starter'::text) AS plan_code,
    COALESCE(sub.tier, 'free'::text) AS tier,
    COALESCE(sub.status, 'trialing'::text) AS subscription_status,
    COALESCE(sub.trial_ends_at, s.created_at + '1 mon'::interval) AS trial_ends_at,
    sub.current_period_start,
    sub.current_period_end,
    sub.billing_cycle,
    s.school_type IS NULL OR (s.school_type = ANY (ARRAY['academy'::text, 'hybrid'::text, 'club'::text, 'escuela'::text, 'gimnasio'::text, 'personal_trainer'::text])) AS has_academy,
    s.school_type = 'venue'::text OR (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'reservations'::text AND a.enabled)) AS has_reservations,
    s.school_type = 'venue'::text OR (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'reservations'::text AND a.enabled)) AS has_wallet,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'tournaments'::text AND a.enabled)) AS has_tournaments,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'access_control'::text AND a.enabled)) AS has_access_control,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'biomech'::text AND a.enabled)) AS has_biomech,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'nutrition'::text AND a.enabled)) AS has_nutrition,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'whitelabel'::text AND a.enabled)) AS has_whitelabel,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'whatsapp'::text AND a.enabled)) AS has_whatsapp,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'wompi'::text AND a.enabled)) AS has_wompi,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'mp'::text AND a.enabled)) AS has_mp,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'store'::text AND a.enabled)) AS has_store,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'accounting'::text AND a.enabled)) AS has_accounting,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND a.addon_key = 'invoicing'::text AND a.enabled)) AS has_invoicing,
    s.created_at AS school_created_at,
    s.account_type,
    sub.school_id IS NOT NULL AS has_subscription_row,
    sub.trial_months,
    COALESCE(sub.blocking_exempt, false) AS blocking_exempt,
    sub.blocking_exempt_reason,
    school_is_operational(s.id) AS is_operational,
    (EXISTS ( SELECT 1
           FROM school_addons a
          WHERE a.school_id = s.id AND (a.addon_key = ANY (ARRAY['pwa_branding'::text, 'whitelabel'::text])) AND a.enabled)) AS has_pwa_branding,
    COALESCE(sset.billing_enabled, true) AS has_billing,
    ( SELECT jsonb_object_agg(m.module_key, m.enabled) AS jsonb_object_agg
           FROM school_module_overrides m
          WHERE m.school_id = s.id) AS module_overrides,
    COALESCE(sset.coach_can_create_athletes, false) AS coach_can_create_athletes,
    COALESCE(sset.coach_can_create_teams, false) AS coach_can_create_teams,
    COALESCE(sset.parent_email_optional, false) AS parent_email_optional,
    COALESCE(sset.coach_hide_financial_info, false) AS coach_hide_financial_info,
    COALESCE(sset.coach_can_edit_categories, false) AS coach_can_edit_categories,
    COALESCE(sset.military_discount_enabled, false) AS military_discount_enabled,
    COALESCE(sset.allow_secondary_team_enrollment, false) AS allow_secondary_team_enrollment,
    COALESCE(sset.coach_attendance_retro_days, 7) AS coach_attendance_retro_days,
    COALESCE(sset.rubric_allow_na, false) AS rubric_allow_na,
    COALESCE(sset.live_match_enabled, false) AS live_match_enabled
   FROM schools s
     LEFT JOIN school_subscriptions sub ON sub.school_id = s.id
     LEFT JOIN school_settings sset ON sset.school_id = s.id;

-- 3. Agenda del partido (D-V1, respuesta 5 de §16.1) ---------------------------
ALTER TABLE public.match_results
  ADD COLUMN IF NOT EXISTS live_periods_count  smallint NULL
        CONSTRAINT match_results_live_periods_count_chk CHECK (live_periods_count BETWEEN 1 AND 4),
  ADD COLUMN IF NOT EXISTS live_period_minutes smallint NULL
        CONSTRAINT match_results_live_period_minutes_chk CHECK (live_period_minutes BETWEEN 5 AND 60),
  ADD COLUMN IF NOT EXISTS match_kind          text NOT NULL DEFAULT 'official'
        CONSTRAINT match_results_match_kind_chk CHECK (match_kind IN ('official','practice')),
  ADD COLUMN IF NOT EXISTS referee_name        text NULL
        CONSTRAINT match_results_referee_name_chk CHECK (referee_name IS NULL OR char_length(btrim(referee_name)) BETWEEN 1 AND 120);
COMMENT ON COLUMN public.match_results.match_kind IS
  'official | practice. Distinto de match_type (competencia: Liga/Amistoso/Torneo). practice no cuenta en el historial.';

-- 4. Espejo hacia la estadística existente -------------------------------------
-- Sin FK a propósito: match_live_events no se borra nunca y el espejo se rehace por live_event_id.
ALTER TABLE public.football_match_events
  ADD COLUMN IF NOT EXISTS live_event_id uuid NULL;
CREATE INDEX IF NOT EXISTS football_match_events_live_event_idx
  ON public.football_match_events (live_event_id) WHERE live_event_id IS NOT NULL;

-- 5. Rango del dorsal (sin NOT NULL ni UNIQUE: no cambia nada a otras escuelas)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'match_lineup_players_jersey_range_chk'
                  AND conrelid = 'public.match_lineup_players'::regclass) THEN
    ALTER TABLE public.match_lineup_players
      ADD CONSTRAINT match_lineup_players_jersey_range_chk
      CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999);
  END IF;
END $$;

COMMIT;
