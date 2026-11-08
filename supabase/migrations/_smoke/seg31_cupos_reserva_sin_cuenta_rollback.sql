-- ============================================================
-- ROLLBACK de 20261107111754_seg31_cupos_reserva_sin_cuenta. NO es una migración.
-- *** DESTRUCTIVO (paso 4: DROP COLUMN) — requiere aprobación humana. ***
--
-- ORDEN OBLIGATORIO:
--   1. Volver el BFF a la versión que NO llama book_session_with_credit ni
--      cancel_session_booking_with_credit, y confirmar que está desplegado
--      en los tres BFF (dev/stg/prod comparten base).
--   2. Restaurar migrate_unregistered_athlete_to_profile (cuerpo previo).
--   3. DROP de las dos RPC.
--   4. DROP de los índices y DROP COLUMN credit_enrollment_id.
-- Este script hace 2→4 en una transacción. El paso 1 es manual y va ANTES.
--
-- Uso (una sola sesión aplicando DDL; dejar rastro):
--   psql "$DATABASE_URL" -f supabase/migrations/_smoke/seg31_cupos_reserva_sin_cuenta_rollback.sql
-- Si se corre como migración nueva (npm run migrations:new -- seg31_rollback),
-- copiar este contenido tal cual.
--
-- Respaldo previo recomendado (las filas que pierden dato al soltar la columna):
--   create table public._bak_seg31_credit_enrollment as
--   select id, credit_enrollment_id from public.session_bookings
--    where credit_enrollment_id is not null;
--
-- Verificación posterior:
--   select to_regprocedure('public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid)'),
--          to_regprocedure('public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid)');   -- null, null
--   select count(*) from information_schema.columns
--    where table_schema='public' and table_name='session_bookings'
--      and column_name='credit_enrollment_id';                                                -- 0
--   select prosrc ~ 'credit_enrollment_id' from pg_proc
--    where proname='migrate_unregistered_athlete_to_profile';                                  -- false
--   select proacl from pg_proc where proname='migrate_unregistered_athlete_to_profile';
--                                                   -- {postgres=X/postgres,service_role=X/postgres}
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;

-- Guarda: no soltar el vínculo mientras haya reservas confirmadas sin cuenta
-- que lo necesiten para devolver el crédito.
DO $$
DECLARE v_n int;
BEGIN
    IF to_regclass('public.session_bookings') IS NOT NULL AND EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'session_bookings'
           AND column_name = 'credit_enrollment_id')
    THEN
        EXECUTE $q$
            SELECT count(*) FROM public.session_bookings
             WHERE credit_enrollment_id IS NOT NULL
               AND enrollment_id IS NULL
               AND status = 'confirmed'
        $q$ INTO v_n;
        IF v_n > 0 THEN
            RAISE EXCEPTION 'Rollback SEG-31 abortado: % reservas confirmadas dependen de credit_enrollment_id. Resolverlas (cancelar con devolución o asignar enrollment) antes.', v_n;
        END IF;
    END IF;
END $$;

-- ── 2. Cuerpo VIVO previo (pg_get_functiondef, luebjarufsiadojhvxgi, 2026-11-07) ──
CREATE OR REPLACE FUNCTION public.migrate_unregistered_athlete_to_profile(p_unregistered_id uuid, p_new_user_id uuid DEFAULT NULL::uuid, p_new_child_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_enrollments   int;
  v_rows_omitidos      int;
  v_rows_records       int;
  v_rows_bookings      int;
  v_rows_payments      int;
  v_rows_zk_mappings   int;
  v_rows_documents     int;
BEGIN
  IF p_new_user_id IS NULL AND p_new_child_id IS NULL THEN
    RAISE EXCEPTION 'Se requiere p_new_user_id o p_new_child_id';
  END IF;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.enrollments e
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE e.unregistered_athlete_id = p_unregistered_id
      AND e.user_id IS NULL
      AND (
        e.status <> 'active'
        OR NOT EXISTS (
          SELECT 1
          FROM public.enrollments dup
          WHERE dup.user_id = p_new_user_id
            AND dup.status  = 'active'
            AND dup.id     <> e.id
            AND (
                 (dup.offering_plan_id IS NOT NULL AND dup.offering_plan_id = e.offering_plan_id)
              OR (dup.team_id          IS NOT NULL AND dup.team_id          = e.team_id)
            )
        )
      );
  ELSE
    UPDATE public.enrollments e
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE e.unregistered_athlete_id = p_unregistered_id
      AND e.child_id IS NULL
      AND (
        e.status <> 'active'
        OR NOT EXISTS (
          SELECT 1
          FROM public.enrollments dup
          WHERE dup.child_id = p_new_child_id
            AND dup.status   = 'active'
            AND dup.id      <> e.id
            AND (
                 (dup.offering_plan_id IS NOT NULL AND dup.offering_plan_id = e.offering_plan_id)
              OR (dup.team_id          IS NOT NULL AND dup.team_id          = e.team_id)
            )
        )
      );
  END IF;
  GET DIAGNOSTICS v_rows_enrollments = ROW_COUNT;

  SELECT count(*) INTO v_rows_omitidos
  FROM public.enrollments e
  WHERE e.unregistered_athlete_id = p_unregistered_id
    AND (
         (p_new_user_id IS NOT NULL AND e.user_id  IS NULL)
      OR (p_new_user_id IS NULL     AND e.child_id IS NULL)
    );

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.attendance_records
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.attendance_records
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_records = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.session_bookings
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.session_bookings
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_bookings = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.payments
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  ELSE
    UPDATE public.payments p
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL,
        parent_id               = COALESCE(p.parent_id, c.parent_id)
    FROM public.children c
    WHERE c.id = p_new_child_id
      AND p.unregistered_athlete_id = p_unregistered_id
      AND p.child_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_payments = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.zk_user_mappings
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id
      AND user_id IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows_zk_mappings = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.athlete_documents
    SET user_id                 = p_new_user_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id;
  ELSE
    UPDATE public.athlete_documents
    SET child_id                = p_new_child_id,
        unregistered_athlete_id = NULL
    WHERE unregistered_athlete_id = p_unregistered_id;
  END IF;
  GET DIAGNOSTICS v_rows_documents = ROW_COUNT;

  IF p_new_user_id IS NOT NULL THEN
    UPDATE public.profiles pr
    SET
      date_of_birth = COALESCE(pr.date_of_birth, ua.date_of_birth),
      phone         = COALESCE(pr.phone,         ua.phone),
      updated_at    = now()
    FROM public.unregistered_athletes ua
    WHERE pr.id = p_new_user_id
      AND ua.id = p_unregistered_id
      AND (ua.date_of_birth IS NOT NULL OR ua.phone IS NOT NULL);
  END IF;

  UPDATE public.unregistered_athletes
  SET linked_profile_id = COALESCE(
        p_new_user_id,
        (SELECT c.parent_id FROM public.children c WHERE c.id = p_new_child_id)
      ),
      is_active = false
  WHERE id = p_unregistered_id;

  RETURN jsonb_build_object(
    'unregistered_id',      p_unregistered_id,
    'migrated_to_user',     p_new_user_id,
    'migrated_to_child',    p_new_child_id,
    'enrollments',          v_rows_enrollments,
    'enrollments_omitidos', v_rows_omitidos,
    'attendance_records',   v_rows_records,
    'session_bookings',     v_rows_bookings,
    'payments',             v_rows_payments,
    'zk_user_mappings',     v_rows_zk_mappings,
    'athlete_documents',    v_rows_documents
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.migrate_unregistered_athlete_to_profile(uuid,uuid,uuid) TO service_role;

-- ── 3. RPC nuevas ──
DROP FUNCTION IF EXISTS public.book_session_with_credit(uuid,uuid,uuid,uuid,uuid,uuid,boolean,uuid);
DROP FUNCTION IF EXISTS public.cancel_session_booking_with_credit(uuid,uuid,uuid,uuid);

-- ── 4. Índices y columna (DESTRUCTIVO) ──
DROP INDEX IF EXISTS public.uq_session_bookings_hour_bank_reservation_activa;
DROP INDEX IF EXISTS public.idx_session_bookings_credit_enrollment;
ALTER TABLE public.session_bookings DROP COLUMN IF EXISTS credit_enrollment_id;

COMMIT;

NOTIFY pgrst, 'reload schema';
