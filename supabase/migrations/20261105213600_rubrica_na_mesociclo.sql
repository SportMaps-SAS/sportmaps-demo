-- =============================================================================
-- 20261105213600_rubrica_na_mesociclo.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105213545
-- Objetivo: «No aplica» en la rúbrica del mesociclo, modo equipo (plan
--   docs/plan-evaluaciones-na-f1.md, F1b). Requiere 20261105213545 (rubric_allow_na).
--   La tabla se escribe directo desde el cliente (sin RPC): el gate del flag va
--   en un trigger. RLS y policies NO cambian. Filas existentes quedan
--   not_applicable = false (válidas por el CHECK).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.training_mesocycle_evaluations
  ADD COLUMN IF NOT EXISTS not_applicable boolean NOT NULL DEFAULT false;
ALTER TABLE public.training_mesocycle_evaluations ALTER COLUMN score DROP NOT NULL;
ALTER TABLE public.training_mesocycle_evaluations DROP CONSTRAINT IF EXISTS training_mesocycle_evaluations_score_check;
ALTER TABLE public.training_mesocycle_evaluations DROP CONSTRAINT IF EXISTS training_mesocycle_evaluations_na_score_check;
ALTER TABLE public.training_mesocycle_evaluations
  ADD CONSTRAINT training_mesocycle_evaluations_na_score_check
  CHECK ((not_applicable AND score IS NULL) OR (NOT not_applicable AND score BETWEEN 1 AND 10));

-- Helper de trigger: no lo usa ninguna policy -> sin GRANT; Postgres no exige
-- EXECUTE para dispararlo.
CREATE OR REPLACE FUNCTION public._guard_mesocycle_eval_na()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.not_applicable AND NOT COALESCE(
         (SELECT ss.rubric_allow_na FROM public.school_settings ss WHERE ss.school_id = NEW.school_id),
         false) THEN
        RAISE EXCEPTION 'La opción «No aplica» no está habilitada para esta escuela.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public._guard_mesocycle_eval_na() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_mesocycle_eval_na_guard ON public.training_mesocycle_evaluations;
CREATE TRIGGER trg_mesocycle_eval_na_guard
    BEFORE INSERT OR UPDATE OF not_applicable ON public.training_mesocycle_evaluations
    FOR EACH ROW EXECUTE FUNCTION public._guard_mesocycle_eval_na();

COMMIT;
