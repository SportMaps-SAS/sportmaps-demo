-- =============================================================================
-- 20261106160004_retiro_y_pausa_por_canales.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-06   Versión anterior: 20261105225148
-- Objetivo: F5 de docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6
--   «Retirar, suspender o congelar el plan desde WhatsApp y la app».
--   Base de datos del contrato; las pantallas y el bot van después contra estas RPCs.
--
-- NO APLICADA. Se aplica con la CLI de Supabase (o apply_migration) desde UNA
-- sola sesión, junto al resto del lote; después `npm run seguridad:invariantes`.
-- El ledger (supabase/migrations_ledger.json) lo actualiza quien integre el lote.
--
-- QUÉ HACE
--   1. PAUSA. Las RPC de F1 ya cubren al atleta adulto (request_enrollment_pause
--      acepta source='athlete' cuando enrollments.user_id = auth.uid(), y la
--      policy pause_requests_select_atleta lo deja leer lo suyo). Lo que faltaba:
--        · el CANAL de origen (app | whatsapp | admin) -> enrollment_pause_requests.channel
--          (nombre `channel` porque `source` YA existe con otro sentido: quién pide,
--          parent|athlete|admin);
--        · la AUTOAPROBACIÓN (D10: la escuela decide; por defecto la pausa que cae
--          dentro del tope de meses/año se aprueba sola; fuera del tope va a la
--          administración) -> school_settings.pause_auto_approve + request_enrollment_pause_v2;
--        · poder llamar la RPC desde el BFF/bot (service_role) a nombre de una
--          persona ya identificada (parámetro p_actor, solo honrado con service_role).
--      request_enrollment_pause (v1) NO se toca: la pantalla del acudiente de F3
--      sigue igual (siempre pendiente; el tope rechaza).
--   2. RETIRO y REACTIVACIÓN como SOLICITUDES: tabla enrollment_withdrawal_requests
--      y RPCs request_enrollment_withdrawal / request_enrollment_reactivation /
--      resolve_enrollment_withdrawal / cancel_enrollment_request. El retiro NUNCA
--      se aprueba solo.
--
-- DECISIONES DE DISEÑO (revisar)
--   · pause_validar se REEMPLAZA (misma firma) para que una solicitud marcada
--     fuera_de_tope pueda aprobarla la administración: sin esto, el admin no podría
--     aprobar lo que justamente se le derivó por pasarse del tope. Solo se salta el
--     tope si p_excluir_request_id apunta a una fila con fuera_de_tope=true. El resto
--     es copia literal de la definición viva (20261029161649).
--   · tope = 0 significa «sin tope» (así lo trata pause_validar). Con tope 0 NO hay
--     autoaprobación: sin tope no hay «dentro del tope» que justifique aprobar solo.
--   · RETIRO: al aprobar se cancela la inscripción (status='cancelled', end_date =
--     fecha de salida) y se anulan los cobros pending/awaiting_approval/overdue cuyo
--     PERIODO empieza en o después de la fecha de salida (el criterio de estados es el
--     de set_school_athlete_status). set_school_athlete_status NO se llama por defecto:
--     es por ATLETA (cancela TODAS sus inscripciones, anula TODA la deuda sin mirar
--     fecha y lo inactiva), y un retiro puede ser de una sola de dos categorías. Se
--     llama solo si la administración marca p_dar_de_baja=true y el atleta no tiene
--     otras inscripciones activas.
--   · Si el atleta tiene OTRAS inscripciones activas en la escuela, los cobros NO se
--     anulan solos (payments no tiene enrollment_id: no se puede saber de cuál son);
--     se cuentan en payments_a_revisar para que la administración los resuelva en
--     «Cobros abiertos».
--   · La fecha de salida futura cancela la inscripción AL APROBAR (no hay cron que la
--     difiera). La fecha se limita a [mes en curso, hoy + 92 días].
--   · REACTIVACIÓN: sirve para una inscripción retirada (cancelled) o en pausa. Al
--     aprobar: retirada -> status='active', end_date=NULL (+ set_school_athlete_status
--     (...,true) si el atleta quedó inactivo); en pausa -> resume_enrollment. Los cobros
--     NO se emiten aquí: los genera open_month (cron diario o botón) desde el mes
--     elegido, como siempre. No se toca start_date ni expires_at.
--   · resolve_enrollment_withdrawal exige JWT de un administrador (auth.uid() no nulo):
--     con service_role pelado ni el BFF ni el bot pueden resolver. Aprobar/rechazar
--     PAUSAS sigue siendo approve_/reject_enrollment_pause (también con el JWT del admin).
--   · Solo aplica al atleta con titular: acudiente del menor (children.parent_id) o
--     adulto dueño (enrollments.user_id). Las fichas sin cuenta (unregistered) solo las
--     mueve la administración.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC; anon sin EXECUTE; REVOKE incluye PUBLIC.
--   · Estados en tablas nuevas: text + CHECK. RLS por comando, sin FOR ALL.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Pausa: canal, autoaprobación, marca de «fuera de tope»
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.enrollment_pause_requests
  ADD COLUMN IF NOT EXISTS channel        text,
  ADD COLUMN IF NOT EXISTS auto_approved  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fuera_de_tope  boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollment_pause_requests_channel_check') THEN
    ALTER TABLE public.enrollment_pause_requests
      ADD CONSTRAINT enrollment_pause_requests_channel_check
      CHECK (channel IS NULL OR channel IN ('app','whatsapp','admin'));
  END IF;
END $$;

COMMENT ON COLUMN public.enrollment_pause_requests.channel IS
  'Canal por el que entró la solicitud: app | whatsapp | admin. NULL en las filas anteriores a 20261106160004 (equivale a app, o admin si source=admin). Distinto de source (quién pide: parent|athlete|admin).';
COMMENT ON COLUMN public.enrollment_pause_requests.auto_approved IS
  'TRUE si la aprobó el sistema (dentro del tope y school_settings.pause_auto_approve). En ese caso reviewed_by es NULL.';
COMMENT ON COLUMN public.enrollment_pause_requests.fuera_de_tope IS
  'TRUE si al pedirla superaba el tope de meses/año: quedó pendiente para la administración, y pause_validar no le aplica el tope al aprobarla.';

ALTER TABLE public.school_settings
  ADD COLUMN IF NOT EXISTS pause_auto_approve boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.school_settings.pause_auto_approve IS
  'D10: la pausa pedida por la familia que cae DENTRO del tope de meses/año se aprueba sola. FALSE = toda pausa pedida pasa por la administración. Solo rige con pause_enabled y tope > 0. Fuera del tope siempre va a la administración.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Helpers privados (solo los llaman las RPC, que corren como owner)
-- ─────────────────────────────────────────────────────────────────────────────

-- Quién actúa. Con JWT: auth.uid(). Sin JWT: SOLO service_role puede decir a
-- nombre de quién (p_actor): el BFF/bot ya identificó a la persona. Un usuario
-- autenticado que mande p_actor ajeno es ignorado (manda su auth.uid()).
CREATE OR REPLACE FUNCTION public.retiro_actor(p_actor uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v uuid := auth.uid();
BEGIN
  IF v IS NOT NULL THEN
    RETURN v;
  END IF;
  IF COALESCE(auth.role(), '') = 'service_role' AND p_actor IS NOT NULL THEN
    RETURN p_actor;
  END IF;
  RAISE EXCEPTION 'Sesión requerida.';
END;
$$;

-- ¿Es administración de esa escuela? Mismo criterio que administraEstaEscuela()
-- del BFF (plataforma activa, dueño, o miembro owner/admin/school_admin activo),
-- pero por uid explícito para poder usarlo también con service_role.
CREATE OR REPLACE FUNCTION public.retiro_es_admin(p_school_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.platform_admins pa
                WHERE pa.profile_id = p_uid AND pa.is_active)
    OR EXISTS (SELECT 1 FROM public.schools s
                WHERE s.id = p_school_id AND s.owner_id = p_uid)
    OR EXISTS (SELECT 1 FROM public.school_members sm
                WHERE sm.school_id = p_school_id AND sm.profile_id = p_uid
                  AND sm.status = 'active'
                  AND sm.role IN ('owner','admin','school_admin'))
  );
$$;

-- ¿Quién es el titular? 'parent' (acudiente del menor), 'athlete' (el adulto
-- dueño de la inscripción) o NULL (nadie con derecho a pedir).
CREATE OR REPLACE FUNCTION public.retiro_titular(p_enrollment_id uuid, p_uid uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE
           WHEN e.child_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM public.children c
                             WHERE c.id = e.child_id AND c.parent_id = p_uid) THEN 'parent'
           WHEN e.user_id IS NOT NULL AND e.user_id = p_uid THEN 'athlete'
           ELSE NULL
         END
    FROM public.enrollments e
   WHERE e.id = p_enrollment_id;
$$;

CREATE OR REPLACE FUNCTION public.retiro_nombre_atleta(p_enrollment_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
           NULLIF(btrim(COALESCE(
             (SELECT c.full_name FROM public.children c WHERE c.id = e.child_id),
             (SELECT p.full_name FROM public.profiles p WHERE p.id = e.user_id),
             (SELECT u.full_name FROM public.unregistered_athletes u WHERE u.id = e.unregistered_athlete_id)
           )), ''),
           'un atleta')
    FROM public.enrollments e
   WHERE e.id = p_enrollment_id;
$$;

-- Aviso a la administración. Un INSERT en notifications encola el envío solo
-- (trg_enqueue_notification_delivery). Misma resolución de admins que F1.
CREATE OR REPLACE FUNCTION public.retiro_notificar_admins(
  p_school_id uuid, p_title text, p_message text, p_data jsonb, p_link text DEFAULT '/students'
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.notifications (user_id, school_id, title, message, type, category, link, data)
  SELECT DISTINCT a.admin_id, p_school_id, p_title, p_message, 'info', 'enrollment', p_link, p_data
  FROM (
    SELECT sm.profile_id AS admin_id
      FROM public.school_members sm
     WHERE sm.school_id = p_school_id
       AND sm.status = 'active'
       AND sm.role IN ('owner','admin','school_admin')
    UNION
    SELECT s.owner_id
      FROM public.schools s
     WHERE s.id = p_school_id AND s.owner_id IS NOT NULL
  ) a
  WHERE a.admin_id IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.retiro_notificar(
  p_user_id uuid, p_school_id uuid, p_title text, p_message text, p_type text, p_data jsonb,
  p_link text DEFAULT '/children'
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.notifications (user_id, school_id, title, message, type, category, link, data)
  SELECT p_user_id, p_school_id, p_title, p_message, p_type, 'enrollment', p_link, p_data
  WHERE p_user_id IS NOT NULL;
$$;

-- Tope de meses/año: cuánto se ha usado y si esta solicitud lo excede. Mismo
-- conteo que pause_validar (aprobadas del año de month_from, sin 'no_asistio').
CREATE OR REPLACE FUNCTION public.pause_tope_info(
  p_enrollment_id uuid, p_month_from date, p_month_to date, p_excluir_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_school uuid;
  v_tope   int;
  v_meses  int;
  v_ya     int;
BEGIN
  SELECT e.school_id INTO v_school FROM public.enrollments e WHERE e.id = p_enrollment_id;
  SELECT COALESCE(ss.pause_max_months_per_year, 2) INTO v_tope
    FROM public.school_settings ss WHERE ss.school_id = v_school;
  v_tope := COALESCE(v_tope, 2);

  v_meses := ((extract(year from p_month_to) * 12 + extract(month from p_month_to))
            - (extract(year from p_month_from) * 12 + extract(month from p_month_from)) + 1)::int;

  SELECT COALESCE(sum(
           (extract(year from r.month_to) * 12 + extract(month from r.month_to))
         - (extract(year from r.month_from) * 12 + extract(month from r.month_from)) + 1
         ), 0)::int
    INTO v_ya
  FROM public.enrollment_pause_requests r
  WHERE r.enrollment_id = p_enrollment_id
    AND r.status = 'approved'
    AND r.reason <> 'no_asistio'
    AND (p_excluir_request_id IS NULL OR r.id <> p_excluir_request_id)
    AND extract(year from r.month_from) = extract(year from p_month_from);

  RETURN jsonb_build_object(
    'meses',  v_meses,
    'usados', v_ya,
    'tope',   v_tope,
    'excede', (v_tope > 0 AND v_ya + v_meses > v_tope),
    'dentro', (v_tope > 0 AND v_ya + v_meses <= v_tope)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.retiro_actor(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retiro_es_admin(uuid, uuid)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retiro_titular(uuid, uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retiro_nombre_atleta(uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retiro_notificar_admins(uuid, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retiro_notificar(uuid, uuid, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pause_tope_info(uuid, date, date, uuid)              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retiro_actor(uuid)                                   TO service_role;
GRANT EXECUTE ON FUNCTION public.retiro_es_admin(uuid, uuid)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.retiro_titular(uuid, uuid)                           TO service_role;
GRANT EXECUTE ON FUNCTION public.retiro_nombre_atleta(uuid)                           TO service_role;
GRANT EXECUTE ON FUNCTION public.retiro_notificar_admins(uuid, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.retiro_notificar(uuid, uuid, text, text, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pause_tope_info(uuid, date, date, uuid)              TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. pause_validar: copia de la definición viva (20261029161649). ÚNICO cambio:
--    una solicitud marcada fuera_de_tope no vuelve a chocar con el tope al
--    aprobarla la administración.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pause_validar(
  p_enrollment_id uuid, p_month_from date, p_month_to date, p_es_admin boolean,
  p_excluir_request_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_e          record;
  v_cfg        record;
  v_meses      int;
  v_ya         int;
  v_saltar_tope boolean := false;
  v_mes_actual date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
BEGIN
  SELECT e.id, e.school_id, e.status, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;

  IF v_e.id IS NULL THEN
    RAISE EXCEPTION 'Inscripción no encontrada.';
  END IF;
  IF v_e.status <> 'active' THEN
    RAISE EXCEPTION 'Solo se puede pausar una inscripción activa (esta está %).', v_e.status;
  END IF;

  SELECT COALESCE(pause_enabled, false)            AS habilitada,
         COALESCE(pause_max_months_per_year, 2)    AS tope,
         COALESCE(pause_parent_can_request, true)  AS padre_puede
    INTO v_cfg
  FROM public.school_settings WHERE school_id = v_e.school_id;

  IF NOT COALESCE(v_cfg.habilitada, false) THEN
    RAISE EXCEPTION 'La pausa por vacaciones no está habilitada en esta escuela.';
  END IF;
  IF NOT p_es_admin AND NOT COALESCE(v_cfg.padre_puede, true) THEN
    RAISE EXCEPTION 'En esta escuela la pausa la aplica la administración; no se puede solicitar.';
  END IF;

  IF p_month_to < p_month_from THEN
    RAISE EXCEPTION 'El mes final no puede ser anterior al inicial.';
  END IF;
  IF extract(day from p_month_from) <> 1 OR extract(day from p_month_to) <> 1 THEN
    RAISE EXCEPTION 'Los meses deben venir como el día 1 del mes.';
  END IF;
  IF p_month_from < v_mes_actual THEN
    RAISE EXCEPTION 'No se puede pausar un mes que ya pasó.';
  END IF;

  v_meses := (extract(year from p_month_to) * 12 + extract(month from p_month_to))
           - (extract(year from p_month_from) * 12 + extract(month from p_month_from)) + 1;

  -- Solape con pausas ya aprobadas o pendientes de la misma inscripción.
  IF EXISTS (
    SELECT 1 FROM public.enrollment_pause_requests r
    WHERE r.enrollment_id = p_enrollment_id
      AND r.status IN ('approved','pending')
      AND (p_excluir_request_id IS NULL OR r.id <> p_excluir_request_id)
      AND daterange(r.month_from, (r.month_to + interval '1 month')::date, '[)')
          && daterange(p_month_from, (p_month_to + interval '1 month')::date, '[)')
  ) THEN
    RAISE EXCEPTION 'Ya hay una pausa aprobada o pendiente que se cruza con esos meses.';
  END IF;

  -- NUEVO: la solicitud derivada a la administración por pasarse del tope se
  -- puede aprobar (la administración decide); el tope no se le vuelve a aplicar.
  IF p_excluir_request_id IS NOT NULL THEN
    SELECT COALESCE(r.fuera_de_tope, false) INTO v_saltar_tope
      FROM public.enrollment_pause_requests r WHERE r.id = p_excluir_request_id;
    v_saltar_tope := COALESCE(v_saltar_tope, false);
  END IF;

  -- Tope por año calendario (cuenta las aprobadas del año de month_from).
  -- Los meses anulados por «no asistió» no son una pausa pedida: no gastan tope.
  IF COALESCE(v_cfg.tope, 2) > 0 AND NOT v_saltar_tope THEN
    SELECT COALESCE(sum(
             (extract(year from r.month_to) * 12 + extract(month from r.month_to))
           - (extract(year from r.month_from) * 12 + extract(month from r.month_from)) + 1
           ), 0)
      INTO v_ya
    FROM public.enrollment_pause_requests r
    WHERE r.enrollment_id = p_enrollment_id
      AND r.status = 'approved'
      AND r.reason <> 'no_asistio'
      AND (p_excluir_request_id IS NULL OR r.id <> p_excluir_request_id)
      AND extract(year from r.month_from) = extract(year from p_month_from);

    IF v_ya + v_meses > v_cfg.tope THEN
      RAISE EXCEPTION 'Supera el tope de % mes(es) de pausa por año (ya usó %).', v_cfg.tope, v_ya;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'school_id',               v_e.school_id,
    'child_id',                v_e.child_id,
    'user_id',                 v_e.user_id,
    'unregistered_athlete_id', v_e.unregistered_athlete_id,
    'meses',                   v_meses
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pause_validar(uuid, date, date, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pause_validar(uuid, date, date, boolean, uuid) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. request_enrollment_pause_v2: pausa con canal y autoaprobación
--    Para el acudiente del menor y para el atleta adulto (retiro_titular).
--    Dentro del tope + pause_auto_approve + tope>0 -> nace 'approved' y se aplica
--    en la misma transacción (pause_aplicar anula los cobros del periodo, D6).
--    Si no -> 'pending' para la administración (fuera_de_tope=true si pasó el tope).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_enrollment_pause_v2(
  p_enrollment_id uuid,
  p_reason        text,
  p_month_from    date,
  p_month_to      date,
  p_reason_note   text DEFAULT NULL,
  p_channel       text DEFAULT 'app',
  p_actor         uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller  uuid;
  v_e       record;
  v_source  text;
  v_auto_ok boolean;
  v_tope    jsonb;
  v_auto    boolean;
  v_fuera   boolean;
  v_id      uuid;
  v_res     jsonb;
  v_meses   int;
  v_nombre  text;
BEGIN
  v_caller := public.retiro_actor(p_actor);

  IF p_channel IS NULL OR p_channel NOT IN ('app','whatsapp') THEN
    RAISE EXCEPTION 'Canal inválido (app | whatsapp).';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('injury','vacation','other') THEN
    RAISE EXCEPTION 'Motivo inválido (injury | vacation | other).';
  END IF;
  IF p_reason_note IS NOT NULL AND length(p_reason_note) > 500 THEN
    RAISE EXCEPTION 'La nota no puede pasar de 500 caracteres.';
  END IF;

  SELECT e.school_id, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;
  IF v_e.school_id IS NULL THEN RAISE EXCEPTION 'Inscripción no encontrada.'; END IF;

  v_source := public.retiro_titular(p_enrollment_id, v_caller);
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'No autorizado: solo el acudiente del atleta o el atleta adulto pueden solicitar la pausa.';
  END IF;

  -- Mismo candado que las demás RPC de pausa: serializa por inscripción, así el
  -- conteo del tope y el solape no se pisan entre dos solicitudes simultáneas.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_enrollment_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.enrollment_pause_requests r
              WHERE r.enrollment_id = p_enrollment_id AND r.status = 'pending') THEN
    RAISE EXCEPTION 'Ya hay una solicitud de pausa pendiente para esta inscripción.';
  END IF;

  SELECT COALESCE(ss.pause_auto_approve, true) INTO v_auto_ok
    FROM public.school_settings ss WHERE ss.school_id = v_e.school_id;
  v_auto_ok := COALESCE(v_auto_ok, true);

  v_tope  := public.pause_tope_info(p_enrollment_id, p_month_from, p_month_to);
  v_fuera := COALESCE((v_tope->>'excede')::boolean, false);
  v_auto  := v_auto_ok AND COALESCE((v_tope->>'dentro')::boolean, false);
  v_meses := (v_tope->>'meses')::int;

  INSERT INTO public.enrollment_pause_requests (
    school_id, enrollment_id, child_id, user_id, unregistered_athlete_id,
    reason, reason_note, month_from, month_to, status, source, channel,
    requested_by, auto_approved, fuera_de_tope
  ) VALUES (
    v_e.school_id, p_enrollment_id, v_e.child_id, v_e.user_id, v_e.unregistered_athlete_id,
    p_reason, p_reason_note, p_month_from, p_month_to,
    CASE WHEN v_auto THEN 'approved' ELSE 'pending' END, v_source, p_channel,
    v_caller, v_auto, v_fuera
  )
  RETURNING id INTO v_id;

  -- Valida config (pause_enabled, pause_parent_can_request), fechas, solape y
  -- tope. Si algo falla se levanta y el INSERT de arriba se deshace.
  PERFORM public.pause_validar(p_enrollment_id, p_month_from, p_month_to, false, v_id);

  v_nombre := public.retiro_nombre_atleta(p_enrollment_id);

  IF v_auto THEN
    v_res := public.pause_aplicar(v_id, NULL);

    PERFORM public.retiro_notificar(
      v_caller, v_e.school_id, 'Pausa aprobada',
      'La pausa de ' || v_nombre || ' quedó aprobada. No se cobrarán esos meses.',
      'success', jsonb_build_object('pause_request_id', v_id, 'enrollment_id', p_enrollment_id));
    PERFORM public.retiro_notificar_admins(
      v_e.school_id, 'Pausa aprobada automáticamente',
      'La pausa de ' || v_nombre || ' por ' || v_meses || ' mes(es) se aprobó sola (dentro del tope, pedida por '
        || p_channel || ').',
      jsonb_build_object('pause_request_id', v_id, 'enrollment_id', p_enrollment_id, 'channel', p_channel));

    RETURN jsonb_build_object(
      'request_id', v_id, 'status', 'approved', 'auto_aprobada', true, 'fuera_de_tope', false,
      'meses', v_meses, 'tope', (v_tope->>'tope')::int, 'usados', (v_tope->>'usados')::int,
      'payments_cancelled', (v_res->>'payments_cancelled')::int,
      'payments_ambiguos',  (v_res->>'payments_ambiguos')::int);
  END IF;

  PERFORM public.retiro_notificar_admins(
    v_e.school_id, 'Solicitud de pausa',
    'Hay una solicitud de pausa de ' || v_nombre || ' por ' || v_meses || ' mes(es) esperando revisión'
      || CASE WHEN v_fuera THEN ' (se pasa del tope anual)' ELSE '' END || '.',
    jsonb_build_object('pause_request_id', v_id, 'enrollment_id', p_enrollment_id,
                       'channel', p_channel, 'fuera_de_tope', v_fuera));

  RETURN jsonb_build_object(
    'request_id', v_id, 'status', 'pending', 'auto_aprobada', false, 'fuera_de_tope', v_fuera,
    'meses', v_meses, 'tope', (v_tope->>'tope')::int, 'usados', (v_tope->>'usados')::int);
END;
$$;

REVOKE ALL ON FUNCTION public.request_enrollment_pause_v2(uuid, text, date, date, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_enrollment_pause_v2(uuid, text, date, date, text, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.request_enrollment_pause_v2(uuid, text, date, date, text, text, uuid) IS
  'Pausa pedida por el acudiente o el atleta adulto, con canal (app|whatsapp). Dentro del tope anual y con school_settings.pause_auto_approve (y tope>0) se aprueba sola y aplica D6; si no, queda pending para la administración (fuera_de_tope=true si pasó el tope; la administración la puede aprobar). p_actor solo se honra con service_role (BFF/bot que ya identificó a la persona).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Tabla de retiros y reactivaciones
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enrollment_withdrawal_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                uuid NOT NULL REFERENCES public.schools(id)     ON DELETE CASCADE,
  enrollment_id            uuid NOT NULL REFERENCES public.enrollments(id) ON DELETE CASCADE,

  -- Identidad del atleta (mismo trío que payments y las pausas), para las policies.
  child_id                 uuid REFERENCES public.children(id)              ON DELETE CASCADE,
  user_id                  uuid REFERENCES public.profiles(id)              ON DELETE CASCADE,
  unregistered_athlete_id  uuid REFERENCES public.unregistered_athletes(id) ON DELETE CASCADE,

  kind                     text NOT NULL CHECK (kind IN ('retiro','reactivacion')),
  -- retiro: fecha de salida. reactivacion: primer día del mes desde el que vuelve.
  effective_date           date NOT NULL,
  reason                   text CHECK (reason IS NULL OR length(reason) <= 500),

  channel                  text NOT NULL CHECK (channel IN ('app','whatsapp','admin')),
  requester_role           text NOT NULL CHECK (requester_role IN ('parent','athlete','admin')),

  status                   text NOT NULL DEFAULT 'solicitado'
                             CHECK (status IN ('solicitado','aprobado','rechazado','cancelado')),

  requested_by             uuid REFERENCES public.profiles(id),
  requested_at             timestamptz NOT NULL DEFAULT now(),
  processed_by             uuid REFERENCES public.profiles(id),
  processed_at             timestamptz,
  review_note              text CHECK (review_note IS NULL OR length(review_note) <= 500),
  result                   jsonb,   -- qué movió la aprobación (cobros anulados, a revisar, baja…)

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT withdrawal_una_identidad CHECK (
    (child_id IS NOT NULL)::int + (user_id IS NOT NULL)::int
      + (unregistered_athlete_id IS NOT NULL)::int = 1
  )
);

COMMENT ON TABLE public.enrollment_withdrawal_requests IS
  'Solicitudes de retiro (baja de la inscripción) y de reactivación, desde la app o WhatsApp. Nunca se aprueban solas: las resuelve la administración con resolve_enrollment_withdrawal. Spec: docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6.';
COMMENT ON COLUMN public.enrollment_withdrawal_requests.effective_date IS
  'retiro: fecha de salida (se anulan los cobros de periodos que empiezan en o después). reactivacion: día 1 del mes desde el que vuelve a cobrarse (lo emite open_month).';

CREATE UNIQUE INDEX IF NOT EXISTS enrollment_withdrawal_requests_una_abierta
  ON public.enrollment_withdrawal_requests(enrollment_id, kind) WHERE status = 'solicitado';
CREATE INDEX IF NOT EXISTS enrollment_withdrawal_requests_bandeja
  ON public.enrollment_withdrawal_requests(school_id, requested_at DESC) WHERE status = 'solicitado';
CREATE INDEX IF NOT EXISTS enrollment_withdrawal_requests_inscripcion
  ON public.enrollment_withdrawal_requests(enrollment_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS enrollment_withdrawal_requests_child
  ON public.enrollment_withdrawal_requests(child_id) WHERE child_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS enrollment_withdrawal_requests_user
  ON public.enrollment_withdrawal_requests(user_id) WHERE user_id IS NOT NULL;

DROP TRIGGER IF EXISTS enrollment_withdrawal_requests_set_updated_at ON public.enrollment_withdrawal_requests;
CREATE TRIGGER enrollment_withdrawal_requests_set_updated_at
  BEFORE UPDATE ON public.enrollment_withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS por comando. Escritura: NINGUNA policy, todo entra por las RPC.
ALTER TABLE public.enrollment_withdrawal_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS withdrawal_requests_select_admin     ON public.enrollment_withdrawal_requests;
DROP POLICY IF EXISTS withdrawal_requests_select_acudiente ON public.enrollment_withdrawal_requests;
DROP POLICY IF EXISTS withdrawal_requests_select_atleta    ON public.enrollment_withdrawal_requests;

-- Administración de la escuela (NO user_school_ids(): incluye padres y atletas, y
-- aquí hay motivos de retiro de otras familias). Incluye al admin de plataforma.
CREATE POLICY withdrawal_requests_select_admin
  ON public.enrollment_withdrawal_requests
  FOR SELECT TO authenticated
  USING (school_id IN (SELECT unnest(public.user_admin_school_ids()))
         OR (SELECT public.is_super_admin()));

CREATE POLICY withdrawal_requests_select_acudiente
  ON public.enrollment_withdrawal_requests
  FOR SELECT TO authenticated
  USING (child_id IS NOT NULL AND public.is_parent_of_child(child_id));

CREATE POLICY withdrawal_requests_select_atleta
  ON public.enrollment_withdrawal_requests
  FOR SELECT TO authenticated
  USING (user_id IS NOT NULL AND user_id = (SELECT auth.uid()));

REVOKE ALL    ON TABLE public.enrollment_withdrawal_requests FROM PUBLIC, anon;
GRANT  SELECT ON TABLE public.enrollment_withdrawal_requests TO authenticated;
GRANT  ALL    ON TABLE public.enrollment_withdrawal_requests TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. RPC: pedir retiro / pedir reactivación (titular; JWT o service_role+p_actor)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_enrollment_withdrawal(
  p_enrollment_id  uuid,
  p_effective_date date,
  p_reason         text DEFAULT NULL,
  p_channel        text DEFAULT 'app',
  p_actor          uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_e      record;
  v_source text;
  v_id     uuid;
  v_hoy    date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date;
  v_mes    date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
  v_nombre text;
BEGIN
  v_caller := public.retiro_actor(p_actor);

  IF p_channel IS NULL OR p_channel NOT IN ('app','whatsapp') THEN
    RAISE EXCEPTION 'Canal inválido (app | whatsapp).';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 500 THEN
    RAISE EXCEPTION 'El motivo no puede pasar de 500 caracteres.';
  END IF;

  SELECT e.school_id, e.status, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;
  IF v_e.school_id IS NULL THEN RAISE EXCEPTION 'Inscripción no encontrada.'; END IF;

  v_source := public.retiro_titular(p_enrollment_id, v_caller);
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'No autorizado: solo el acudiente del atleta o el atleta adulto pueden pedir el retiro.';
  END IF;

  IF v_e.status <> 'active' THEN
    RAISE EXCEPTION 'Solo se puede pedir el retiro de una inscripción activa (esta está %).', v_e.status;
  END IF;
  IF p_effective_date IS NULL OR p_effective_date < v_mes OR p_effective_date > v_hoy + 92 THEN
    RAISE EXCEPTION 'La fecha de salida debe estar entre el primer día de este mes y los próximos 3 meses.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_enrollment_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.enrollment_withdrawal_requests w
              WHERE w.enrollment_id = p_enrollment_id AND w.kind = 'retiro' AND w.status = 'solicitado') THEN
    RAISE EXCEPTION 'Ya hay una solicitud de retiro pendiente para esta inscripción.';
  END IF;

  -- NUNCA se aprueba sola: nace 'solicitado'.
  INSERT INTO public.enrollment_withdrawal_requests (
    school_id, enrollment_id, child_id, user_id, unregistered_athlete_id,
    kind, effective_date, reason, channel, requester_role, status, requested_by
  ) VALUES (
    v_e.school_id, p_enrollment_id, v_e.child_id, v_e.user_id, v_e.unregistered_athlete_id,
    'retiro', p_effective_date, NULLIF(btrim(p_reason), ''), p_channel, v_source, 'solicitado', v_caller
  )
  RETURNING id INTO v_id;

  v_nombre := public.retiro_nombre_atleta(p_enrollment_id);
  PERFORM public.retiro_notificar_admins(
    v_e.school_id, 'Solicitud de retiro',
    'Solicitan el retiro de ' || v_nombre || ' con fecha de salida ' || to_char(p_effective_date, 'DD/MM/YYYY')
      || ' (por ' || p_channel || '). Necesita tu aprobación.',
    jsonb_build_object('withdrawal_request_id', v_id, 'enrollment_id', p_enrollment_id,
                       'kind', 'retiro', 'channel', p_channel));

  RETURN jsonb_build_object('request_id', v_id, 'status', 'solicitado', 'kind', 'retiro',
                            'effective_date', p_effective_date);
END;
$$;

CREATE OR REPLACE FUNCTION public.request_enrollment_reactivation(
  p_enrollment_id  uuid,
  p_effective_date date,
  p_reason         text DEFAULT NULL,
  p_channel        text DEFAULT 'app',
  p_actor          uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_e      record;
  v_source text;
  v_id     uuid;
  v_hoy    date := (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date;
  v_mes    date := date_trunc('month', (CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota')::date)::date;
  v_desde  date;
  v_nombre text;
BEGIN
  v_caller := public.retiro_actor(p_actor);

  IF p_channel IS NULL OR p_channel NOT IN ('app','whatsapp') THEN
    RAISE EXCEPTION 'Canal inválido (app | whatsapp).';
  END IF;
  IF p_reason IS NOT NULL AND length(p_reason) > 500 THEN
    RAISE EXCEPTION 'El motivo no puede pasar de 500 caracteres.';
  END IF;

  SELECT e.school_id, e.status, e.paused_reason, e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = p_enrollment_id;
  IF v_e.school_id IS NULL THEN RAISE EXCEPTION 'Inscripción no encontrada.'; END IF;

  v_source := public.retiro_titular(p_enrollment_id, v_caller);
  IF v_source IS NULL THEN
    RAISE EXCEPTION 'No autorizado: solo el acudiente del atleta o el atleta adulto pueden pedir la reactivación.';
  END IF;

  IF NOT (v_e.status = 'cancelled' OR (v_e.status = 'active' AND v_e.paused_reason IS NOT NULL)) THEN
    RAISE EXCEPTION 'Solo se puede reactivar una inscripción retirada o en pausa.';
  END IF;

  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'Falta el mes desde el que vuelve.';
  END IF;
  v_desde := date_trunc('month', p_effective_date)::date;
  IF v_desde < v_mes OR v_desde > v_hoy + 366 THEN
    RAISE EXCEPTION 'El mes de regreso debe ser este mes o uno de los próximos 12.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_enrollment_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.enrollment_withdrawal_requests w
              WHERE w.enrollment_id = p_enrollment_id AND w.kind = 'reactivacion' AND w.status = 'solicitado') THEN
    RAISE EXCEPTION 'Ya hay una solicitud de reactivación pendiente para esta inscripción.';
  END IF;

  INSERT INTO public.enrollment_withdrawal_requests (
    school_id, enrollment_id, child_id, user_id, unregistered_athlete_id,
    kind, effective_date, reason, channel, requester_role, status, requested_by
  ) VALUES (
    v_e.school_id, p_enrollment_id, v_e.child_id, v_e.user_id, v_e.unregistered_athlete_id,
    'reactivacion', v_desde, NULLIF(btrim(p_reason), ''), p_channel, v_source, 'solicitado', v_caller
  )
  RETURNING id INTO v_id;

  v_nombre := public.retiro_nombre_atleta(p_enrollment_id);
  PERFORM public.retiro_notificar_admins(
    v_e.school_id, 'Solicitud de reactivación',
    'Piden reactivar el plan de ' || v_nombre || ' desde ' || to_char(v_desde, 'MM/YYYY')
      || ' (por ' || p_channel || '). Necesita tu aprobación.',
    jsonb_build_object('withdrawal_request_id', v_id, 'enrollment_id', p_enrollment_id,
                       'kind', 'reactivacion', 'channel', p_channel));

  RETURN jsonb_build_object('request_id', v_id, 'status', 'solicitado', 'kind', 'reactivacion',
                            'effective_date', v_desde);
END;
$$;

REVOKE ALL ON FUNCTION public.request_enrollment_withdrawal(uuid, date, text, text, uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_enrollment_reactivation(uuid, date, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_enrollment_withdrawal(uuid, date, text, text, uuid)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_enrollment_reactivation(uuid, date, text, text, uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RPC: resolver (SOLO administración, con JWT)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_enrollment_withdrawal(
  p_request_id    uuid,
  p_decision      text,                 -- 'aprobar' | 'rechazar'
  p_review_note   text    DEFAULT NULL,
  p_dar_de_baja   boolean DEFAULT false -- solo retiro: además inactivar al atleta (set_school_athlete_status)
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_r        record;
  v_e        record;
  v_otras    int := 0;
  v_pay      int := 0;
  v_pay_rev  int := 0;
  v_baja     jsonb := NULL;
  v_tipo     text;
  v_atleta   uuid;
  v_inactivo boolean := false;
  v_nombre   text;
  v_result   jsonb;
  v_pausa_n  int := 0;
BEGIN
  -- Sin JWT no se resuelve nada: ni el bot ni un service_role pelado.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Sesión requerida: solo la administración resuelve estas solicitudes.';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('aprobar','rechazar') THEN
    RAISE EXCEPTION 'Decisión inválida (aprobar | rechazar).';
  END IF;
  IF p_review_note IS NOT NULL AND length(p_review_note) > 500 THEN
    RAISE EXCEPTION 'La nota no puede pasar de 500 caracteres.';
  END IF;

  SELECT * INTO v_r FROM public.enrollment_withdrawal_requests WHERE id = p_request_id FOR UPDATE;
  IF v_r.id IS NULL THEN RAISE EXCEPTION 'Solicitud no encontrada.'; END IF;

  IF NOT (COALESCE(public.is_super_admin(), false)
          OR COALESCE(public.retiro_es_admin(v_r.school_id, v_caller), false)) THEN
    RAISE EXCEPTION 'No autorizado para resolver solicitudes en esta escuela.';
  END IF;
  IF v_r.status <> 'solicitado' THEN
    RAISE EXCEPTION 'Esta solicitud ya fue resuelta (está %).', v_r.status;
  END IF;

  v_nombre := public.retiro_nombre_atleta(v_r.enrollment_id);

  -- ── Rechazo ────────────────────────────────────────────────────────────────
  IF p_decision = 'rechazar' THEN
    UPDATE public.enrollment_withdrawal_requests
       SET status = 'rechazado', processed_by = v_caller, processed_at = now(),
           review_note = NULLIF(btrim(p_review_note), '')
     WHERE id = p_request_id;

    PERFORM public.retiro_notificar(
      v_r.requested_by, v_r.school_id,
      CASE v_r.kind WHEN 'retiro' THEN 'Solicitud de retiro rechazada' ELSE 'Solicitud de reactivación rechazada' END,
      COALESCE(NULLIF(btrim(p_review_note), ''), 'La administración no aprobó la solicitud de ' || v_nombre || '.'),
      'warning', jsonb_build_object('withdrawal_request_id', p_request_id, 'kind', v_r.kind));

    RETURN jsonb_build_object('request_id', p_request_id, 'status', 'rechazado', 'kind', v_r.kind);
  END IF;

  -- ── Aprobación ─────────────────────────────────────────────────────────────
  PERFORM pg_advisory_xact_lock(hashtextextended(v_r.enrollment_id::text, 0));

  SELECT e.id, e.status, e.team_id, e.offering_plan_id, e.paused_reason,
         e.child_id, e.user_id, e.unregistered_athlete_id
    INTO v_e
  FROM public.enrollments e WHERE e.id = v_r.enrollment_id FOR UPDATE;
  IF v_e.id IS NULL THEN RAISE EXCEPTION 'La inscripción ya no existe.'; END IF;

  v_tipo := CASE WHEN v_e.child_id IS NOT NULL THEN 'child'
                 WHEN v_e.user_id  IS NOT NULL THEN 'adult'
                 ELSE 'unregistered' END;
  v_atleta := COALESCE(v_e.child_id, v_e.user_id, v_e.unregistered_athlete_id);

  IF v_r.kind = 'retiro' THEN
    IF v_e.status <> 'active' THEN
      RAISE EXCEPTION 'La inscripción ya no está activa (está %).', v_e.status;
    END IF;

    -- ¿Tiene otras inscripciones activas en la escuela? (doble categoría)
    SELECT count(*) INTO v_otras
      FROM public.enrollments o
     WHERE o.school_id = v_r.school_id AND o.status = 'active' AND o.id <> v_e.id
       AND (   (v_e.child_id IS NOT NULL AND o.child_id = v_e.child_id)
            OR (v_e.user_id  IS NOT NULL AND o.user_id  = v_e.user_id)
            OR (v_e.unregistered_athlete_id IS NOT NULL
                AND o.unregistered_athlete_id = v_e.unregistered_athlete_id));

    IF COALESCE(p_dar_de_baja, false) AND v_otras > 0 THEN
      RAISE EXCEPTION 'El atleta tiene otras inscripciones activas: no se puede dar de baja completa, solo retirar esta.';
    END IF;

    UPDATE public.enrollments
       SET status = 'cancelled', end_date = v_r.effective_date, updated_at = now()
     WHERE id = v_e.id;

    -- Cobros: criterio de set_school_athlete_status (estados y casado por
    -- identidad) + la fecha de salida: solo periodos que empiezan en o después.
    IF v_otras = 0 THEN
      UPDATE public.payments p
         SET status = 'cancelled', updated_at = now()
       WHERE p.school_id = v_r.school_id
         AND p.status IN ('pending','awaiting_approval','overdue')
         AND (   (v_tipo = 'child'        AND p.child_id = v_atleta)
              OR (v_tipo = 'adult'        AND (p.user_id = v_atleta OR (p.parent_id = v_atleta AND p.child_id IS NULL)))
              OR (v_tipo = 'unregistered' AND p.unregistered_athlete_id = v_atleta))
         AND CASE WHEN p.period_year IS NOT NULL AND p.period_month IS NOT NULL
                  THEN make_date(p.period_year, p.period_month, 1) >= v_r.effective_date
                  ELSE p.due_date >= v_r.effective_date END;
      GET DIAGNOSTICS v_pay = ROW_COUNT;
    ELSE
      -- No se sabe de cuál inscripción es cada cobro: se cuentan para revisión.
      SELECT count(*) INTO v_pay_rev
        FROM public.payments p
       WHERE p.school_id = v_r.school_id
         AND p.status IN ('pending','awaiting_approval','overdue')
         AND (   (v_tipo = 'child'        AND p.child_id = v_atleta)
              OR (v_tipo = 'adult'        AND (p.user_id = v_atleta OR (p.parent_id = v_atleta AND p.child_id IS NULL)))
              OR (v_tipo = 'unregistered' AND p.unregistered_athlete_id = v_atleta))
         AND CASE WHEN p.period_year IS NOT NULL AND p.period_month IS NOT NULL
                  THEN make_date(p.period_year, p.period_month, 1) >= v_r.effective_date
                  ELSE p.due_date >= v_r.effective_date END;
    END IF;

    -- Una pausa pendiente de una inscripción que ya no existe queda huérfana.
    UPDATE public.enrollment_pause_requests
       SET status = 'cancelled'
     WHERE enrollment_id = v_e.id AND status = 'pending';
    GET DIAGNOSTICS v_pausa_n = ROW_COUNT;

    IF COALESCE(p_dar_de_baja, false) THEN
      v_baja := public.set_school_athlete_status(v_r.school_id, v_tipo, v_atleta, false);
    END IF;

    v_result := jsonb_build_object(
      'enrollment_cancelled',      true,
      'end_date',                  v_r.effective_date,
      'payments_cancelled',        v_pay,
      'payments_a_revisar',        v_pay_rev,
      'otras_inscripciones_activas', v_otras,
      'pausas_pendientes_canceladas', v_pausa_n,
      'baja_completa',             v_baja);

    PERFORM public.retiro_notificar(
      v_r.requested_by, v_r.school_id, 'Retiro aprobado',
      'La administración aprobó el retiro de ' || v_nombre || ' con fecha de salida '
        || to_char(v_r.effective_date, 'DD/MM/YYYY') || '.',
      'info', jsonb_build_object('withdrawal_request_id', p_request_id, 'kind', 'retiro'));

  ELSE
    -- ── Reactivación ─────────────────────────────────────────────────────────
    IF v_e.status = 'cancelled' THEN
      IF v_e.team_id IS NULL AND v_e.offering_plan_id IS NULL THEN
        RAISE EXCEPTION 'No se puede reactivar: la inscripción no tiene equipo ni plan. Asígnale uno primero.';
      END IF;

      v_inactivo := CASE v_tipo
        WHEN 'child' THEN COALESCE((SELECT NOT COALESCE(c.is_active, true)
                                      FROM public.children c WHERE c.id = v_atleta), false)
        WHEN 'adult' THEN COALESCE((SELECT sm.status <> 'active'
                                      FROM public.school_members sm
                                     WHERE sm.profile_id = v_atleta AND sm.school_id = v_r.school_id
                                       AND sm.role = 'athlete' LIMIT 1), false)
        ELSE COALESCE((SELECT NOT COALESCE(u.is_active, true)
                         FROM public.unregistered_athletes u WHERE u.id = v_atleta), false)
      END;

      UPDATE public.enrollments
         SET status = 'active', end_date = NULL, updated_at = now()
       WHERE id = v_e.id;

      IF v_inactivo THEN
        v_baja := public.set_school_athlete_status(v_r.school_id, v_tipo, v_atleta, true);
      END IF;

    ELSIF v_e.status = 'active' AND v_e.paused_reason IS NOT NULL THEN
      v_baja := public.resume_enrollment(v_e.id, 'Reactivación aprobada (solicitud ' || p_request_id::text || ')');

    ELSE
      RAISE EXCEPTION 'La inscripción no está retirada ni en pausa.';
    END IF;

    v_result := jsonb_build_object(
      'enrollment_reactivated', true,
      'desde',                  v_r.effective_date,
      'atleta_reactivado',      v_inactivo,
      'detalle',                v_baja,
      -- Los cobros los emite open_month (cron o botón), no esta RPC.
      'cobros',                 'los genera el cierre de mes desde ' || to_char(v_r.effective_date, 'MM/YYYY'));

    PERFORM public.retiro_notificar(
      v_r.requested_by, v_r.school_id, 'Reactivación aprobada',
      'La administración aprobó reactivar el plan de ' || v_nombre || ' desde '
        || to_char(v_r.effective_date, 'MM/YYYY') || '.',
      'success', jsonb_build_object('withdrawal_request_id', p_request_id, 'kind', 'reactivacion'));
  END IF;

  UPDATE public.enrollment_withdrawal_requests
     SET status = 'aprobado', processed_by = v_caller, processed_at = now(),
         review_note = NULLIF(btrim(p_review_note), ''), result = v_result
   WHERE id = p_request_id;

  RETURN jsonb_build_object('request_id', p_request_id, 'status', 'aprobado', 'kind', v_r.kind)
         || v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_enrollment_withdrawal(uuid, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_enrollment_withdrawal(uuid, text, text, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_enrollment_withdrawal(uuid, text, text, boolean) IS
  'Solo administración, con JWT (con service_role pelado falla: sin sesión). aprobar retiro: cancela la inscripción (end_date = fecha de salida) y anula cobros pending/awaiting_approval/overdue de periodos desde la fecha de salida (si el atleta tiene otra inscripción activa, no anula: cuenta payments_a_revisar); p_dar_de_baja=true además llama set_school_athlete_status(false). aprobar reactivación: reactiva la inscripción retirada (o resume la pausada); los cobros los emite open_month.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. RPC: cancelar la propia solicitud (pausa, retiro o reactivación)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_enrollment_request(
  p_tipo       text,      -- 'pausa' | 'retiro' | 'reactivacion'
  p_request_id uuid,
  p_actor      uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller uuid;
  v_school uuid;
  v_by     uuid;
  v_status text;
BEGIN
  v_caller := public.retiro_actor(p_actor);

  IF p_tipo = 'pausa' THEN
    SELECT r.school_id, r.requested_by, r.status INTO v_school, v_by, v_status
      FROM public.enrollment_pause_requests r WHERE r.id = p_request_id FOR UPDATE;
    IF v_school IS NULL THEN RAISE EXCEPTION 'Solicitud no encontrada.'; END IF;
    IF v_status <> 'pending' THEN
      RAISE EXCEPTION 'Solo se puede retirar una solicitud pendiente (esta está %).', v_status;
    END IF;
    IF v_by IS DISTINCT FROM v_caller AND NOT public.retiro_es_admin(v_school, v_caller) THEN
      RAISE EXCEPTION 'No autorizado.';
    END IF;
    UPDATE public.enrollment_pause_requests SET status = 'cancelled' WHERE id = p_request_id;

  ELSIF p_tipo IN ('retiro','reactivacion') THEN
    SELECT w.school_id, w.requested_by, w.status INTO v_school, v_by, v_status
      FROM public.enrollment_withdrawal_requests w
     WHERE w.id = p_request_id AND w.kind = p_tipo FOR UPDATE;
    IF v_school IS NULL THEN RAISE EXCEPTION 'Solicitud no encontrada.'; END IF;
    IF v_status <> 'solicitado' THEN
      RAISE EXCEPTION 'Solo se puede cancelar una solicitud pendiente (esta está %).', v_status;
    END IF;
    IF v_by IS DISTINCT FROM v_caller AND NOT public.retiro_es_admin(v_school, v_caller) THEN
      RAISE EXCEPTION 'No autorizado.';
    END IF;
    UPDATE public.enrollment_withdrawal_requests
       SET status = 'cancelado', processed_by = v_caller, processed_at = now()
     WHERE id = p_request_id;

  ELSE
    RAISE EXCEPTION 'Tipo inválido (pausa | retiro | reactivacion).';
  END IF;

  RETURN jsonb_build_object('request_id', p_request_id, 'tipo', p_tipo, 'status', 'cancelado');
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_enrollment_request(text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_enrollment_request(text, uuid, uuid) TO authenticated, service_role;

COMMIT;

-- =============================================================================
-- PRUEBAS (T1-T8). Ejecutables en supabase/migrations/_smoke/retiro_pausa_smoke.sql
-- (BEGIN ... ROLLBACK). NO se pudieron correr contra la base: esta migración no
-- está aplicada y la sesión que la escribió solo tenía lectura.
--
--  T1  Pausa dentro del tope, pause_enabled + pause_auto_approve + tope=2, acudiente,
--      1 mes -> status 'approved', auto_approved=true, channel guardado, el cobro
--      pending de ese mes queda 'cancelled', enrollments.paused_reason no nulo.
--  T2  Pausa que pasa el tope (3 meses con tope=2) -> status 'pending',
--      fuera_de_tope=true; la administración la aprueba con approve_enrollment_pause
--      SIN chocar con el tope.
--  T3  pause_auto_approve=false (o tope=0) -> 'pending', auto_approved=false.
--  T4  Un acudiente ajeno (o una escuela ajena) pide pausa/retiro/reactivación ->
--      'No autorizado'; el adulto pide lo suyo -> ok (source='athlete').
--  T5  Retiro: nace 'solicitado'; la inscripción sigue 'active' y los cobros intactos
--      (jamás se autoaprueba). Un segundo retiro abierto -> error. Fecha fuera de
--      [mes en curso, hoy+92] -> error.
--  T6  resolve_enrollment_withdrawal por un acudiente / sin JWT -> error; por la
--      administración 'aprobar' -> inscripción 'cancelled' con end_date, cobros
--      pending de periodos >= fecha de salida 'cancelled', los anteriores intactos;
--      con otra inscripción activa -> payments_cancelled=0 y payments_a_revisar>0.
--  T7  Reactivación aprobada sobre una inscripción 'cancelled' -> 'active', end_date
--      NULL; sobre una en pausa -> resume_enrollment (paused_reason NULL).
--  T8  Superficie: anon SIN EXECUTE en las 5 RPC públicas; RLS de la tabla nueva:
--      el acudiente ve solo sus filas, otra familia 0 filas, el admin de otra escuela
--      0 filas; ningún authenticated puede INSERT/UPDATE directo.
-- =============================================================================
