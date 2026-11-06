-- =============================================================================
-- 20261105162611_reservas_f1_rpc_disponibilidad.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05   Versión anterior: 20261105162500
-- Objetivo: F1 · M3 — UNA sola función de disponibilidad (spec §3) y los helpers
--   internos que comparten las RPC de reserva (M4) y de ciclo (M5):
--
--     _reservas_iso            instante UTC con sufijo Z
--     _reservas_rol            'staff' | 'member' | 'external' de un perfil en una escuela
--     _reservas_audiencia      tarifa (public/member) según bookable_by y rol; NULL = no puede
--     _reservas_precio_pasos   precio por tramos (pico/valle, festivos como domingo)
--     _reservas_es_menor       ¿el perfil es menor de edad?
--     disponibilidad_canchas   franjas libres con precio. Contrato: docs/specs/reservas-canchas-f1-contrato.md §2
--
-- Helpers: SECURITY DEFINER sin GRANT (solo los ejecuta el dueño, llamados desde
-- las RPC). disponibilidad_canchas: authenticated y service_role; NO anon (la página
-- pública y el bot pasan por el BFF con service_role).
-- Solo lectura. No escribe nada.
-- Orden requerido: después de reservas_f1_columnas y reservas_f1_tarifas_politicas.
-- =============================================================================

BEGIN;

-- ── helpers ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._reservas_iso(p timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$$;

REVOKE ALL ON FUNCTION public._reservas_iso(timestamptz) FROM PUBLIC, anon, authenticated;

-- Rol de un perfil frente a la escuela. Con sesión (p_profile = auth.uid()) usa las
-- funciones oficiales de alcance; con service_role + actor explícito replica su lógica
-- por consulta directa (sin el respaldo por correo de coaches legacy).
CREATE OR REPLACE FUNCTION public._reservas_rol(p_school_id uuid, p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_profile_id IS NULL OR p_school_id IS NULL THEN
    RETURN 'external';
  END IF;

  IF p_profile_id = auth.uid() THEN
    IF p_school_id = ANY (public.user_staff_school_ids()) OR public.is_super_admin() THEN
      RETURN 'staff';
    END IF;
    IF p_school_id = ANY (public.user_school_ids()) THEN
      RETURN 'member';
    END IF;
    RETURN 'external';
  END IF;

  IF EXISTS (SELECT 1 FROM public.school_members sm
              WHERE sm.profile_id = p_profile_id AND sm.school_id = p_school_id
                AND sm.status = 'active' AND sm.role NOT IN ('parent', 'athlete', 'accountant'))
     OR EXISTS (SELECT 1 FROM public.school_staff ss
                 WHERE ss.coach_auth_id = p_profile_id AND ss.school_id = p_school_id AND ss.status = 'active')
     OR EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.owner_id = p_profile_id)
     OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = p_profile_id AND pa.is_active = true) THEN
    RETURN 'staff';
  END IF;

  IF EXISTS (SELECT 1 FROM public.school_members sm
              WHERE sm.profile_id = p_profile_id AND sm.school_id = p_school_id AND sm.status = 'active') THEN
    RETURN 'member';
  END IF;

  RETURN 'external';
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_rol(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Tarifa que aplica a un rol según quién puede reservar la instalación. NULL = no puede.
CREATE OR REPLACE FUNCTION public._reservas_audiencia(p_bookable_by text, p_rol text, p_pref text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
    WHEN p_rol = 'staff' THEN CASE WHEN p_pref IN ('public', 'member') THEN p_pref ELSE 'public' END
    WHEN p_bookable_by = 'members' THEN CASE WHEN p_rol = 'member' THEN 'member' END
    WHEN p_bookable_by = 'public'  THEN 'public'
    WHEN p_bookable_by = 'both'    THEN CASE WHEN p_rol = 'member' THEN 'member' ELSE 'public' END
  END;
$$;

REVOKE ALL ON FUNCTION public._reservas_audiencia(text, text, text) FROM PUBLIC, anon, authenticated;

-- Precio por tramos de slot_step_min. Festivo de Colombia = domingo (0).
-- Sin fila en facility_rates: public → rental_rate → hourly_rate; member → hourly_rate → rental_rate.
CREATE OR REPLACE FUNCTION public._reservas_precio_pasos(
  p_facility_id uuid, p_starts timestamptz, p_ends timestamptz, p_audience text)
RETURNS TABLE (step_from timestamptz, step_to timestamptz, rate numeric, source text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH f AS (
    SELECT fa.slot_step_min, fa.hourly_rate, fa.rental_rate
      FROM public.facilities fa WHERE fa.id = p_facility_id
  ),
  pasos AS (
    SELECT g AS s,
           LEAST(g + make_interval(mins => f.slot_step_min), p_ends) AS e,
           (g AT TIME ZONE 'America/Bogota') AS ls
      FROM f,
           generate_series(p_starts, p_ends - interval '1 second', make_interval(mins => f.slot_step_min)) AS g
  ),
  dia AS (
    SELECT p.s, p.e, p.ls::time AS lt, p.ls::date AS ld,
           CASE WHEN EXISTS (SELECT 1 FROM public.co_holidays h WHERE h.holiday_date = p.ls::date)
                THEN 0 ELSE EXTRACT(dow FROM p.ls)::int END AS wd
      FROM pasos p
  )
  SELECT d.s, d.e,
         COALESCE(r.price_per_hour,
                  CASE WHEN p_audience = 'public'
                       THEN COALESCE(f.rental_rate, f.hourly_rate, 0)
                       ELSE COALESCE(f.hourly_rate, f.rental_rate, 0) END)::numeric,
         CASE WHEN r.price_per_hour IS NOT NULL THEN 'facility_rates' ELSE 'facility_default' END
    FROM dia d
   CROSS JOIN f
    LEFT JOIN LATERAL (
      SELECT fr.price_per_hour
        FROM public.facility_rates fr
       WHERE fr.facility_id = p_facility_id
         AND fr.audience = p_audience
         AND d.wd = ANY (fr.weekdays)
         AND d.lt >= fr.from_time AND d.lt < fr.to_time
         AND (fr.valid_from IS NULL OR d.ld >= fr.valid_from)
         AND (fr.valid_to   IS NULL OR d.ld <= fr.valid_to)
       ORDER BY fr.priority DESC, fr.price_per_hour DESC
       LIMIT 1
    ) r ON true
   ORDER BY d.s;
$$;

REVOKE ALL ON FUNCTION public._reservas_precio_pasos(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;

-- Menor de edad: fecha de nacimiento del perfil (o de su ficha vinculada) < 18 años.
-- Sin fecha: es menor solo si su ficha (unregistered_athletes.linked_profile_id) trae datos
-- de acudiente y NO es 'parent' activo en alguna escuela. Sin nada de eso: adulto.
CREATE OR REPLACE FUNCTION public._reservas_es_menor(p_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_dob date;
  v_ua_dob date;
  v_ficha_con_acudiente boolean;
BEGIN
  IF p_profile_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.date_of_birth INTO v_dob FROM public.profiles p WHERE p.id = p_profile_id;

  SELECT u.date_of_birth,
         (u.guardian_full_name IS NOT NULL OR u.guardian_email IS NOT NULL OR u.guardian_phone IS NOT NULL)
    INTO v_ua_dob, v_ficha_con_acudiente
    FROM public.unregistered_athletes u
   WHERE u.linked_profile_id = p_profile_id
   ORDER BY u.created_at DESC
   LIMIT 1;

  v_dob := COALESCE(v_dob, v_ua_dob);

  IF v_dob IS NOT NULL THEN
    RETURN v_dob > (current_date - interval '18 years')::date;
  END IF;

  IF EXISTS (SELECT 1 FROM public.school_members sm
              WHERE sm.profile_id = p_profile_id AND sm.role = 'parent' AND sm.status = 'active') THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_ficha_con_acudiente, false);
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_es_menor(uuid) FROM PUBLIC, anon, authenticated;

-- ── disponibilidad_canchas ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.disponibilidad_canchas(
  p_school_id        uuid,
  p_from             date,
  p_to               date,
  p_sport            text    DEFAULT NULL,
  p_facility_id      uuid    DEFAULT NULL,
  p_duration_min     integer DEFAULT NULL,
  p_audience         text    DEFAULT NULL,
  p_actor_profile_id uuid    DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid;
  v_rol   text;
  v_staff boolean;
  v_pref  text;
  v_now   timestamptz := now();
  v_fac   record;
  v_lista jsonb;
BEGIN
  IF p_school_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to < p_from
     OR (p_audience IS NOT NULL AND p_audience NOT IN ('public', 'member'))
     OR (p_duration_min IS NOT NULL AND p_duration_min <= 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_ARGUMENT', 'message', 'Parámetros inválidos');
  END IF;
  IF p_to - p_from > 30 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RANGE_TOO_LARGE', 'message', 'El rango máximo es de 30 días');
  END IF;
  IF NOT COALESCE(public.has_entitlement(p_school_id, 'reservations'), false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ENTITLEMENT_REQUIRED', 'message', 'La escuela no tiene activas las reservas');
  END IF;

  -- Solo service_role / postgres llegan con auth.uid() NULL (anon no tiene EXECUTE).
  v_actor := COALESCE(v_uid, p_actor_profile_id);
  v_rol   := public._reservas_rol(p_school_id, v_actor);
  v_staff := (v_rol = 'staff');
  v_pref  := CASE WHEN v_staff THEN p_audience END;

  IF p_facility_id IS NOT NULL THEN
    SELECT f.* INTO v_fac FROM public.facilities f WHERE f.id = p_facility_id AND f.school_id = p_school_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'FACILITY_NOT_FOUND', 'message', 'La instalación no existe en esa escuela');
    END IF;
    IF v_fac.status <> 'available' OR COALESCE(v_fac.booking_enabled, true) = false THEN
      RETURN jsonb_build_object('ok', false, 'error', 'FACILITY_NOT_BOOKABLE', 'message', 'La instalación no recibe reservas');
    END IF;
    IF public._reservas_audiencia(v_fac.bookable_by, v_rol, v_pref) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'AUDIENCE_NOT_ALLOWED', 'message', 'Esta instalación no admite reservas de tu tipo de usuario');
    END IF;
    IF p_duration_min IS NOT NULL
       AND (p_duration_min < v_fac.min_duration_min OR p_duration_min % v_fac.slot_step_min <> 0
            OR (NOT v_staff AND p_duration_min > v_fac.max_duration_min)) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DURATION', 'message', 'Duración no válida para esta instalación');
    END IF;
  END IF;

  WITH fx AS (
    SELECT f.id, f.name, f.type, f.capacity, f.slot_step_min, f.min_duration_min, f.max_duration_min, f.min_deposit_pct,
           f.min_booking_advance_hours AS adv_h,
           COALESCE(p_duration_min, f.min_duration_min) AS dur,
           CASE WHEN jsonb_typeof(f.available_hours) = 'object' THEN f.available_hours ELSE '{}'::jsonb END AS horas,
           public._reservas_audiencia(f.bookable_by, v_rol, v_pref) AS aud
      FROM public.facilities f
     WHERE f.school_id = p_school_id
       AND f.status = 'available'
       AND COALESCE(f.booking_enabled, true)
       AND (p_facility_id IS NULL OR f.id = p_facility_id)
       AND (p_sport IS NULL OR lower(f.type) = lower(p_sport))
  ),
  fa AS (
    SELECT * FROM fx WHERE aud IS NOT NULL
  ),
  dias AS (
    SELECT g::date AS d
      FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') AS g
  ),
  cand AS (
    SELECT fa.id AS fid, fa.aud, fa.min_deposit_pct, fa.adv_h, dd.d,
           g AS ls, g + make_interval(mins => fa.dur) AS le,
           (g AT TIME ZONE 'America/Bogota') AS s,
           ((g + make_interval(mins => fa.dur)) AT TIME ZONE 'America/Bogota') AS e
      FROM fa
     CROSS JOIN dias dd
     CROSS JOIN LATERAL generate_series(
            dd.d::timestamp,
            dd.d::timestamp + interval '1 day' - make_interval(mins => fa.slot_step_min),
            make_interval(mins => fa.slot_step_min)) AS g
     WHERE fa.dur >= fa.min_duration_min
       AND (v_staff OR fa.dur <= fa.max_duration_min)
       AND fa.dur % fa.slot_step_min = 0
       AND (g + make_interval(mins => fa.dur))::date = dd.d
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements_text(
                      CASE WHEN jsonb_typeof(fa.horas -> (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(dow FROM dd.d)::int + 1]) = 'array'
                           THEN fa.horas -> (ARRAY['sunday','monday','tuesday','wednesday','thursday','friday','saturday'])[EXTRACT(dow FROM dd.d)::int + 1]
                           ELSE '[]'::jsonb END) AS w
              WHERE w ~ '^[0-9]{1,2}:[0-9]{2}-[0-9]{1,2}:[0-9]{2}$'
                AND g::time >= split_part(w, '-', 1)::time
                AND (g + make_interval(mins => fa.dur))::time <= split_part(w, '-', 2)::time)
  ),
  libres AS (
    SELECT c.*
      FROM cand c
     WHERE CASE WHEN v_staff THEN c.e > v_now
                ELSE c.s >= v_now + make_interval(hours => c.adv_h)
                     AND c.s <= v_now + interval '90 days' END
       AND NOT EXISTS (
             SELECT 1 FROM public.facility_occupancy o
              WHERE o.facility_id = c.fid
                AND o.slot && tstzrange(c.s, c.e, '[)')
                AND (o.status = 'active' OR (o.status = 'hold' AND o.hold_expires_at > v_now)))
  ),
  precios AS (
    SELECT l.*,
           (SELECT round(sum(p.rate * extract(epoch FROM (p.step_to - p.step_from)) / 3600.0))
              FROM public._reservas_precio_pasos(l.fid, l.s, l.e, l.aud) p) AS price
      FROM libres l
  ),
  por_dia AS (
    SELECT pr.fid, pr.d,
           jsonb_agg(jsonb_build_object(
             'starts_at',   public._reservas_iso(pr.s),
             'ends_at',     public._reservas_iso(pr.e),
             'start_local', to_char(pr.ls, 'HH24:MI'),
             'end_local',   to_char(pr.le, 'HH24:MI'),
             'price',       pr.price,
             'deposit_min', round(pr.price * pr.min_deposit_pct / 100.0)) ORDER BY pr.s) AS slots
      FROM precios pr
     WHERE v_staff OR pr.price > 0          -- cancha sin tarifa configurada: no se ofrece a no staff
     GROUP BY pr.fid, pr.d
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'facility_id',      fa.id,
           'name',             fa.name,
           'type',             fa.type,
           'capacity',         fa.capacity,
           'audience',         fa.aud,
           'slot_step_min',    fa.slot_step_min,
           'min_duration_min', fa.min_duration_min,
           'duration_min',     fa.dur,
           'min_deposit_pct',  fa.min_deposit_pct,
           'days', COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                       'date',       to_char(pd.d, 'YYYY-MM-DD'),
                       'weekday',    EXTRACT(dow FROM pd.d)::int,
                       'is_holiday', EXISTS (SELECT 1 FROM public.co_holidays h WHERE h.holiday_date = pd.d),
                       'slots',      pd.slots) ORDER BY pd.d)
                FROM por_dia pd WHERE pd.fid = fa.id), '[]'::jsonb)
         ) ORDER BY fa.name, fa.id), '[]'::jsonb)
    INTO v_lista
    FROM fa;

  RETURN jsonb_build_object(
    'ok',           true,
    'school_id',    p_school_id,
    'timezone',     'America/Bogota',
    'generated_at', public._reservas_iso(v_now),
    'from',         to_char(p_from, 'YYYY-MM-DD'),
    'to',           to_char(p_to, 'YYYY-MM-DD'),
    'facilities',   v_lista);
END;
$$;

REVOKE ALL ON FUNCTION public.disponibilidad_canchas(uuid, date, date, text, uuid, integer, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disponibilidad_canchas(uuid, date, date, text, uuid, integer, text, uuid) TO authenticated, service_role;

COMMIT;
