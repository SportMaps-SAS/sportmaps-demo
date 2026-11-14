-- =============================================================================
-- 20261105163229_reservas_f1_backfill_clases.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105163014
-- Objetivo: F1 · M6 — las clases que usan una cancha también la OCUPAN
--   (spec §2.1, hueco H3: una clase y un alquiler podían caer en la misma cancha).
--
--   · Trigger sobre attendance_sessions (solo las filas con facility_id): escribe/actualiza/
--     libera la fila source_kind='class' de facility_occupancy. IDEMPOTENTE (upsert por fuente)
--     y NUNCA BLOQUEA la clase: si la franja ya está ocupada (otra clase en la misma cancha,
--     o un alquiler), la clase se guarda igual, no queda marcada y se deja un RAISE LOG.
--     La razón: dos equipos compartiendo una cancha grande es normal hoy y un trigger
--     que rompiera la toma de asistencia sería peor que el problema.
--     Prioridad resultante: gana quien ocupó primero (alquiler vs clase se resuelve por el EXCLUDE).
--   · Solo marca sesiones de ayer en adelante (no ensucia la tabla con el pasado).
--   · occupancy_backfill_reservas_y_clases(): relleno en lote e idempotente, de reservas
--     vigentes del esquema viejo y de clases futuras. Se corre en esta migración y se puede
--     volver a correr (service_role) justo antes de activar F1 en producción.
--
--   attendance_sessions no tiene estado: una clase cancelada se borra (DELETE libera la ocupación).
--   LIMITACIÓN: los entrenamientos recurrentes de un equipo (teams.facility_id) que NO tengan
--   sesión creada no ocupan nada hasta que exista su fila en attendance_sessions.
-- Orden requerido: después de reservas_f1_columnas (índice único por fuente) y reservas_f1_rpc_ciclo.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_class_sync_ocupacion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ini    timestamptz;
  v_fin    timestamptz;
  v_school uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.facility_occupancy
       SET status = 'released', updated_at = now()
     WHERE source_kind = 'class' AND source_id = OLD.id AND status <> 'released';
    RETURN NULL;
  END IF;

  IF NEW.facility_id IS NULL OR NEW.start_time IS NULL OR NEW.end_time IS NULL OR NEW.end_time <= NEW.start_time THEN
    UPDATE public.facility_occupancy
       SET status = 'released', updated_at = now()
     WHERE source_kind = 'class' AND source_id = NEW.id AND status <> 'released';
    RETURN NULL;
  END IF;

  v_ini := (NEW.session_date + NEW.start_time) AT TIME ZONE 'America/Bogota';
  v_fin := (NEW.session_date + NEW.end_time)   AT TIME ZONE 'America/Bogota';

  IF v_fin < now() - interval '1 day' THEN
    RETURN NULL;                         -- pasado: no se marca
  END IF;

  SELECT f.school_id INTO v_school FROM public.facilities f WHERE f.id = NEW.facility_id;
  v_school := COALESCE(NEW.school_id, v_school);
  IF v_school IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.facility_occupancy
       SET school_id = v_school, facility_id = NEW.facility_id,
           slot = tstzrange(v_ini, v_fin, '[)'), status = 'active', hold_expires_at = NULL, updated_at = now()
     WHERE source_kind = 'class' AND source_id = NEW.id;

    IF NOT FOUND THEN
      INSERT INTO public.facility_occupancy (school_id, facility_id, slot, source_kind, source_id, status)
      VALUES (v_school, NEW.facility_id, tstzrange(v_ini, v_fin, '[)'), 'class', NEW.id, 'active');
    END IF;
  EXCEPTION WHEN exclusion_violation THEN
    -- La clase se guarda igual; el rango anterior (si había) ya no es válido.
    UPDATE public.facility_occupancy
       SET status = 'released', updated_at = now()
     WHERE source_kind = 'class' AND source_id = NEW.id AND status <> 'released';
    RAISE LOG 'facility_occupancy: la clase % no pudo ocupar la instalación % (%): ya hay otra ocupación en ese horario',
      NEW.id, NEW.facility_id, tstzrange(v_ini, v_fin, '[)');
  END;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_class_sync_ocupacion() FROM PUBLIC, anon, authenticated;

-- Tres triggers con WHEN: las sesiones sin cancha no pagan ni un microsegundo.
DROP TRIGGER IF EXISTS trg_class_sync_ocupacion_ins ON public.attendance_sessions;
CREATE TRIGGER trg_class_sync_ocupacion_ins
  AFTER INSERT ON public.attendance_sessions
  FOR EACH ROW WHEN (NEW.facility_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_class_sync_ocupacion();

DROP TRIGGER IF EXISTS trg_class_sync_ocupacion_upd ON public.attendance_sessions;
CREATE TRIGGER trg_class_sync_ocupacion_upd
  AFTER UPDATE OF facility_id, session_date, start_time, end_time ON public.attendance_sessions
  FOR EACH ROW WHEN (NEW.facility_id IS NOT NULL OR OLD.facility_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_class_sync_ocupacion();

DROP TRIGGER IF EXISTS trg_class_sync_ocupacion_del ON public.attendance_sessions;
CREATE TRIGGER trg_class_sync_ocupacion_del
  AFTER DELETE ON public.attendance_sessions
  FOR EACH ROW WHEN (OLD.facility_id IS NOT NULL)
  EXECUTE FUNCTION public.fn_class_sync_ocupacion();

-- ── relleno en lote, idempotente ─────────────────────────────────────────────
-- ON CONFLICT DO NOTHING (sin objetivo) también absorbe las violaciones del EXCLUDE:
-- lo que choque se salta y se cuenta en 'omitidas'. Orden determinista: gana el más antiguo.
CREATE OR REPLACE FUNCTION public.occupancy_backfill_reservas_y_clases()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_res_cand  integer;
  v_res_ins   integer;
  v_cls_cand  integer;
  v_cls_ins   integer;
BEGIN
  -- Reservas vigentes (esquema viejo o nuevo) sin fila de ocupación.
  SELECT count(*) INTO v_res_cand
    FROM public.facility_reservations r
   WHERE r.starts_at IS NOT NULL AND r.ends_at > now()
     AND r.status NOT IN ('cancelled', 'expired', 'pending_reconciliation')
     AND NOT (r.status IN ('hold', 'pending_payment') AND r.hold_expires_at IS NOT NULL AND r.hold_expires_at <= now())
     AND NOT EXISTS (SELECT 1 FROM public.facility_occupancy o WHERE o.source_kind = 'rental' AND o.source_id = r.id);

  WITH ins AS (
    INSERT INTO public.facility_occupancy (school_id, facility_id, slot, source_kind, source_id, status, hold_expires_at)
    SELECT COALESCE(r.school_id, f.school_id), r.facility_id, tstzrange(r.starts_at, r.ends_at, '[)'), 'rental', r.id,
           CASE WHEN r.status IN ('hold', 'pending_payment') AND r.hold_expires_at IS NOT NULL THEN 'hold' ELSE 'active' END,
           CASE WHEN r.status IN ('hold', 'pending_payment') AND r.hold_expires_at IS NOT NULL THEN r.hold_expires_at END
      FROM public.facility_reservations r
      JOIN public.facilities f ON f.id = r.facility_id
     WHERE r.starts_at IS NOT NULL AND r.ends_at > r.starts_at AND r.ends_at > now()
       AND r.status NOT IN ('cancelled', 'expired', 'pending_reconciliation')
       AND NOT (r.status IN ('hold', 'pending_payment') AND r.hold_expires_at IS NOT NULL AND r.hold_expires_at <= now())
       AND NOT EXISTS (SELECT 1 FROM public.facility_occupancy o WHERE o.source_kind = 'rental' AND o.source_id = r.id)
     ORDER BY r.created_at, r.id
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_res_ins FROM ins;

  -- Clases de ayer en adelante con cancha y horario, sin fila de ocupación.
  SELECT count(*) INTO v_cls_cand
    FROM public.attendance_sessions s
   WHERE s.facility_id IS NOT NULL AND s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time > s.start_time
     AND s.session_date >= current_date - 1
     AND NOT EXISTS (SELECT 1 FROM public.facility_occupancy o WHERE o.source_kind = 'class' AND o.source_id = s.id);

  WITH ins AS (
    INSERT INTO public.facility_occupancy (school_id, facility_id, slot, source_kind, source_id, status)
    SELECT COALESCE(s.school_id, f.school_id), s.facility_id,
           tstzrange((s.session_date + s.start_time) AT TIME ZONE 'America/Bogota',
                     (s.session_date + s.end_time)   AT TIME ZONE 'America/Bogota', '[)'),
           'class', s.id, 'active'
      FROM public.attendance_sessions s
      JOIN public.facilities f ON f.id = s.facility_id
     WHERE s.start_time IS NOT NULL AND s.end_time IS NOT NULL AND s.end_time > s.start_time
       AND s.session_date >= current_date - 1
       AND COALESCE(s.school_id, f.school_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.facility_occupancy o WHERE o.source_kind = 'class' AND o.source_id = s.id)
     ORDER BY s.created_at, s.id
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_cls_ins FROM ins;

  RETURN jsonb_build_object(
    'reservas', jsonb_build_object('candidatas', v_res_cand, 'insertadas', v_res_ins, 'omitidas', v_res_cand - v_res_ins),
    'clases',   jsonb_build_object('candidatas', v_cls_cand, 'insertadas', v_cls_ins, 'omitidas', v_cls_cand - v_cls_ins));
END;
$$;

REVOKE ALL ON FUNCTION public.occupancy_backfill_reservas_y_clases() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.occupancy_backfill_reservas_y_clases() TO service_role;

-- Primera pasada (hoy: 0 reservas futuras, 0 clases futuras con cancha según F0; re-verificar).
SELECT public.occupancy_backfill_reservas_y_clases();

COMMIT;
