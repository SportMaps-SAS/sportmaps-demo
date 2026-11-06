-- =====================================================================================================
-- aplicar-1-a-N.sql  (cierre de seguridad de reservas)  -- ARCHIVO GENERADO: concatena los archivos de
-- supabase/migrations/ tal cual; si cambian, se regenera.
-- PARA EL SQL EDITOR DE SUPABASE (producción), a mano. Cada bloque lleva su propio BEGIN/COMMIT
-- (si uno falla, solo ese hace rollback: parar ahí y avisar, no seguir con el siguiente).
-- ORDEN (el que está abajo):
--   1. 20261105211824_security_audit_log_tabla
--   2. 20261105212046_schools_manage_owner_with_check
--   3. 20261105212125_reservas_staff_privilegiado_y_canales_ia
--   4. 20261105213601_anon_sin_escritura_en_tablas_de_planes
--   5. 20261105214559_reservas_select_solo_propias_o_staff
-- NO incluye 20261105213611_reservas_revocar_escritura_directa (M7): va aparte, AL FINAL, en
-- aplicar-M7-al-final.sql, solo cuando el frontend nuevo (sin escrituras directas) y el BFF estén desplegados.
-- Después de la 3: desplegar BFF/frontend que usan reservar_cancha de 16 argumentos (p_source_ref).
-- Verificación posterior: npm run seguridad:invariantes
-- =====================================================================================================

-- ───────── 20261105211824_security_audit_log_tabla.sql ─────────
-- 20261105211824_security_audit_log_tabla.sql
--
-- ORDEN DE APLICACIÓN EN PRODUCCIÓN: 1.º de las 4 migraciones del cierre de seguridad de reservas
--   (independiente de las demás; puede ir en cualquier momento, ANTES de desplegar el BFF que audita).
-- PRECONDICIONES: ninguna. Idempotente: si la tabla ya existe (twin, o alguna base), la endurece.
--
-- POR QUÉ: bff/src/utils/auditWrite.ts inserta en public.security_audit_log, pero en producción la
-- tabla NO EXISTE (to_regclass = NULL; la 20260415000001 figura "aplicada" en el ledger y nunca
-- llegó). Resultado: cada auditoría (borrar/aprobar/completar reservas, etc.) fallaba en silencio.
--
-- COLUMNAS: exactamente las que escribe auditWrite.ts (user_id, action, target_table, target_id,
-- old_value, new_value, ip_address, user_agent, metadata) + id y ts que pone la base.
-- Diferencias deliberadas frente a la definición original (20260415000001:202):
--   * SIN CHECK de lista cerrada en `action` (el original tenía 16 valores y rechazaría decenas de
--     acciones del BFF con 23514). Solo formato/longitud: 1..120, [A-Za-z0-9_:.-] (TG_OP en mayúsculas
--     de los triggers de salud también pasa).
--   * ip_address es TEXT (<= 64): inet fallaba con un x-forwarded-for en lista.
--   * user_id -> auth.users ON DELETE SET NULL (no bloquea el borrado de usuarios).
--   * RLS habilitada; SIN policy de INSERT (el original daba WITH CHECK(true) a authenticated: cualquiera
--     podía falsificar auditoría). Solo service_role escribe. SELECT solo para admin de plataforma.
--   * Inmutable: sin UPDATE/DELETE para nadie salvo service_role.

BEGIN;

CREATE TABLE IF NOT EXISTS public.security_audit_log (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts           timestamptz NOT NULL DEFAULT now(),
    user_id      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
    action       text        NOT NULL,
    target_table text,
    target_id    text,
    old_value    jsonb,
    new_value    jsonb,
    ip_address   text,
    user_agent   text,
    metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- Si existía con el CHECK cerrado original, fuera (cualquier CHECK que toque `action`).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.conname FROM pg_constraint c
            WHERE c.conrelid = 'public.security_audit_log'::regclass AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) ILIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE public.security_audit_log DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

-- Si existía con ip_address inet, pasa a text; y la FK a SET NULL.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'security_audit_log' AND column_name = 'ip_address') <> 'text' THEN
    ALTER TABLE public.security_audit_log ALTER COLUMN ip_address TYPE text USING host(ip_address);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'security_audit_log_user_id_fkey' AND conrelid = 'public.security_audit_log'::regclass
                AND confdeltype <> 'n') THEN
    ALTER TABLE public.security_audit_log DROP CONSTRAINT security_audit_log_user_id_fkey;
    ALTER TABLE public.security_audit_log
      ADD CONSTRAINT security_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.security_audit_log DROP CONSTRAINT IF EXISTS security_audit_log_action_fmt;
ALTER TABLE public.security_audit_log ADD CONSTRAINT security_audit_log_action_fmt
  CHECK (length(action) BETWEEN 1 AND 120 AND action ~ '^[A-Za-z0-9_:.-]+$') NOT VALID;
ALTER TABLE public.security_audit_log VALIDATE CONSTRAINT security_audit_log_action_fmt;
ALTER TABLE public.security_audit_log DROP CONSTRAINT IF EXISTS security_audit_log_ip_len;
ALTER TABLE public.security_audit_log ADD CONSTRAINT security_audit_log_ip_len
  CHECK (ip_address IS NULL OR length(ip_address) <= 64) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_audit_log_user_ts   ON public.security_audit_log (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON public.security_audit_log (action, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target    ON public.security_audit_log (target_table, target_id);
-- La escuela vive en metadata.school_id (auditWrite.ts).
CREATE INDEX IF NOT EXISTS idx_audit_log_school_ts ON public.security_audit_log ((metadata ->> 'school_id'), ts DESC);

ALTER TABLE public.security_audit_log ENABLE ROW LEVEL SECURITY;

-- Las policies originales (INSERT abierto, SELECT admin por profiles.role) se reemplazan.
DROP POLICY IF EXISTS "audit_log_insert_authenticated" ON public.security_audit_log;
DROP POLICY IF EXISTS "audit_log_select_admin"         ON public.security_audit_log;
DROP POLICY IF EXISTS audit_log_select_platform_admin  ON public.security_audit_log;
CREATE POLICY audit_log_select_platform_admin ON public.security_audit_log
  FOR SELECT TO authenticated
  USING (public.is_platform_admin());

REVOKE ALL ON public.security_audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.security_audit_log TO authenticated;      -- filtrado por la policy de arriba
GRANT ALL ON public.security_audit_log TO service_role;
REVOKE ALL ON SEQUENCE public.security_audit_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.security_audit_log_id_seq TO service_role;

COMMIT;


-- ───────── 20261105212046_schools_manage_owner_with_check.sql ─────────
-- SEGURIDAD (invariante I3): la policy "Schools: manage owner" es FOR ALL sin WITH CHECK, así que
-- PostgreSQL valida los INSERT/UPDATE con el USING (auth.uid() = owner_id). Eso ya obliga a que la
-- fila resultante tenga owner_id = quien escribe, pero la regla no está declarada y no sobrevive a un
-- cambio de USING. Se declara el WITH CHECK explícito.
--
-- ORDEN DE APLICACIÓN EN PRODUCCIÓN: 2.º (después de 20261105211824_security_audit_log_tabla; no depende
-- de las demás). PRECONDICIÓN: la policy "Schools: manage owner" existe (USING auth.uid() = owner_id).
--
-- Compatibilidad verificada en el gemelo:
--   * handle_new_user (SECURITY DEFINER, dueño postgres con BYPASSRLS, sin auth.uid()): inserta escuelas
--     'venue' sin pasar por esta policy.
--   * SchoolSetupPage: INSERT directo con owner_id = auth.uid()  -> pasa.
--   * UPDATE del dueño (name, city, onboarding_status, slug...) con owner_id intacto -> pasa.
--   * Insertar una escuela con OTRO owner_id, o reasignar owner_id a otro usuario -> 42501.
--
-- Además se cierra un hueco vecino que el WITH CHECK no cubre: la policy PERMISIVA
-- school_admin_update_branding deja a un admin/school_admin hacer UPDATE de CUALQUIER columna de su
-- escuela (WITH CHECK solo mira el id), incluido owner_id => toma de control de la escuela. Se añade
-- un trigger BEFORE UPDATE OF owner_id: con sesión (auth.uid() no nulo) solo un admin de plataforma o
-- el propio dueño actual (reafirmándose) puede cambiarlo; service_role / postgres (auth.uid() NULL) no
-- se ven afectados.

BEGIN;

DROP POLICY IF EXISTS "Schools: manage owner" ON public.schools;
CREATE POLICY "Schools: manage owner" ON public.schools
  FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

CREATE OR REPLACE FUNCTION public.fn_schools_owner_id_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     AND auth.uid() IS NOT NULL
     AND NOT COALESCE(public.is_platform_admin(), false)
     AND NOT COALESCE(public.is_super_admin(), false) THEN
    RAISE EXCEPTION 'owner_id de la escuela solo lo cambia un administrador de plataforma'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Función de trigger: nadie la llama por RPC.
REVOKE ALL ON FUNCTION public.fn_schools_owner_id_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_schools_owner_id_guard ON public.schools;
CREATE TRIGGER trg_schools_owner_id_guard
  BEFORE UPDATE OF owner_id ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.fn_schools_owner_id_guard();

COMMIT;


-- ───────── 20261105212125_reservas_staff_privilegiado_y_canales_ia.sql ─────────
-- 20261105212125_reservas_staff_privilegiado_y_canales_ia.sql
--
-- ORDEN DE APLICACIÓN EN PRODUCCIÓN: 3.º (tras 20261105211824 y 20261105212046). Independiente de la
--   migración de revocación de escritura directa, que va AL FINAL.
-- PRECONDICIONES: aplicadas 20261105162611, 20261105162802 y 20261105163014 (RPC de reservas vivas).
--   Desplegar el BFF/Frontend que usa p_source_ref DESPUÉS (la firma de reservar_cancha cambia: ver (b)).
--
-- (a) PRIVILEGIO ADMINISTRATIVO. Hasta hoy "staff" = user_staff_school_ids(), que incluye coach, viewer y
--     reporter (todo school_members activo salvo parent/athlete/accountant, más school_staff). Con eso un coach
--     podía reservar a nombre de un tercero, poner payment_method none/cash con monto, saltarse horario,
--     cancelar con reembolso 100 % y reprogramar cambiando cancha/duración.
--     Ahora _reservas_rol devuelve 'staff' SOLO para administradores de la escuela (helper nuevo
--     _reservas_es_admin): school_members activo con rol owner|admin|school_admin|super_admin, el dueño
--     (schools.owner_id; es el rol "facility_manager": el dueño de espacios es el owner_id de su escuela
--     'venue'), admin de plataforma activo, o is_super_admin() de la sesión, MÁS el rol school_members 'staff'
--     (recepción/operación de sede: es quien cobra en caja y reserva por clientes; DECISIÓN a revisar, se
--     quita poniendo p_incluye_recepcion en false por defecto). coach/viewer/reporter/school_staff
--     (la tabla de entrenadores) pasan a 'member': siguen reservando como MIEMBRO (tarifa member)
--     y viendo disponibilidad, pero sin poderes privilegiados. Ruta service_role + p_actor_profile_id intacta.
--     Los canales automatizados ('ai','import') exigen administración estricta (sin el rol 'staff').
-- (b) CANALES 'ai' e 'import' (ver docs/specs/reservas-canchas-f1-contrato.md, "Canales automatizados").
--     reservar_cancha gana el parámetro p_source_ref => se hace DROP de la firma de 15 argumentos y se crea la
--     de 16 (si no, un CREATE OR REPLACE dejaría dos sobrecargas y las llamadas con nombre serían ambiguas).
-- (c) Texto libre: sin caracteres de control, longitudes acotadas, nunca SQL dinámico.

BEGIN;

-- ── helpers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._reservas_limpiar_texto(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT regexp_replace(p, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
$$;

DROP FUNCTION IF EXISTS public._reservas_es_admin(uuid, uuid);
-- p_incluye_recepcion = true: además de los administradores cuenta el rol school_members 'staff' (recepción /
-- operación de la sede, quien cobra en caja y reserva a nombre de clientes). false = solo administración
-- (lo exigen los canales automatizados).
CREATE OR REPLACE FUNCTION public._reservas_es_admin(p_school_id uuid, p_actor uuid, p_incluye_recepcion boolean DEFAULT true)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p_actor IS NOT NULL AND p_school_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.school_members sm
             WHERE sm.profile_id = p_actor AND sm.school_id = p_school_id AND sm.status = 'active'
               AND (sm.role IN ('owner', 'admin', 'school_admin', 'super_admin')
                    OR (p_incluye_recepcion AND sm.role = 'staff')))
    OR EXISTS (SELECT 1 FROM public.schools s WHERE s.id = p_school_id AND s.owner_id = p_actor)
    OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.profile_id = p_actor AND pa.is_active = true)
    OR (p_actor = auth.uid() AND COALESCE(public.is_super_admin(), false))
  );
$$;

-- ¿La llamada viene de service_role (o del dueño de la base)? auth.uid() NULL y, si hay claims JWT, rol service_role.
CREATE OR REPLACE FUNCTION public._reservas_es_service_call()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_claims jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN false; END IF;
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  RETURN v_claims IS NULL OR v_claims ->> 'role' = 'service_role';
END;
$$;

REVOKE ALL ON FUNCTION public._reservas_limpiar_texto(text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reservas_es_admin(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._reservas_es_service_call()       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._reservas_limpiar_texto(text)  TO service_role;
GRANT EXECUTE ON FUNCTION public._reservas_es_admin(uuid, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._reservas_es_service_call()    TO service_role;

-- ── _reservas_rol / _reservas_acceso ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public._reservas_rol(p_school_id uuid, p_profile_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_profile_id IS NULL OR p_school_id IS NULL THEN
    RETURN 'external';
  END IF;

  -- 'staff' = ADMINISTRADOR de la escuela (ver cabecera).
  IF public._reservas_es_admin(p_school_id, p_profile_id) THEN
    RETURN 'staff';
  END IF;

  IF p_profile_id = auth.uid() THEN
    IF p_school_id = ANY (public.user_school_ids()) OR p_school_id = ANY (public.user_staff_school_ids()) THEN
      RETURN 'member';
    END IF;
    RETURN 'external';
  END IF;

  IF EXISTS (SELECT 1 FROM public.school_members sm
              WHERE sm.profile_id = p_profile_id AND sm.school_id = p_school_id AND sm.status = 'active')
     OR EXISTS (SELECT 1 FROM public.school_staff ss
                 WHERE ss.coach_auth_id = p_profile_id AND ss.school_id = p_school_id AND ss.status = 'active') THEN
    RETURN 'member';
  END IF;

  RETURN 'external';
END;
$$;

CREATE OR REPLACE FUNCTION public._reservas_acceso(p_school_id uuid, p_res_user_id uuid, p_res_guest_id uuid, p_actor uuid, p_guest uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_actor uuid := COALESCE(auth.uid(), p_actor);
BEGIN
  IF public._reservas_es_admin(p_school_id, v_actor) THEN
    RETURN 'staff';
  END IF;
  IF v_actor IS NOT NULL AND p_res_user_id = v_actor THEN
    RETURN 'owner';
  END IF;
  IF v_uid IS NULL AND p_guest IS NOT NULL AND p_res_guest_id = p_guest THEN
    RETURN 'owner';
  END IF;
  RETURN NULL;
END;
$$;

-- ── mensajes de error ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._reservas_err(p_code text)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('ok', false, 'error', p_code, 'message', CASE p_code
    WHEN 'INVALID_ARGUMENT'           THEN 'Parámetros inválidos'
    WHEN 'INVALID_AMOUNT'             THEN 'Monto inválido'
    WHEN 'FACILITY_NOT_FOUND'         THEN 'La instalación no existe'
    WHEN 'RESERVATION_NOT_FOUND'      THEN 'La reserva no existe'
    WHEN 'ENTITLEMENT_REQUIRED'       THEN 'La escuela no tiene activas las reservas'
    WHEN 'FACILITY_NOT_BOOKABLE'      THEN 'La instalación no recibe reservas'
    WHEN 'AUDIENCE_NOT_ALLOWED'       THEN 'Esta instalación no admite reservas de tu tipo de usuario'
    WHEN 'MINOR_CANNOT_BOOK'          THEN 'Un menor de edad no puede reservar: debe hacerlo su acudiente'
    WHEN 'FORBIDDEN'                  THEN 'No tienes permiso sobre esta reserva'
    WHEN 'STAFF_ONLY_FIELD'           THEN 'Ese dato solo lo puede indicar el personal de la escuela'
    WHEN 'GUEST_REQUIRED'             THEN 'Falta identificar a quien reserva'
    WHEN 'GUEST_NOT_FOUND'            THEN 'No se encontró al invitado'
    WHEN 'GUEST_NOT_VERIFIED'         THEN 'El teléfono del invitado no está verificado'
    WHEN 'CHANNEL_NOT_ALLOWED'        THEN 'Canal no permitido'
    WHEN 'PAYMENT_METHOD_NOT_ALLOWED' THEN 'Método de pago no permitido'
    WHEN 'PAYMENT_REQUIRED'           THEN 'Esta reserva exige pago en línea o por transferencia'
    WHEN 'IDEMPOTENCY_KEY_REUSED'     THEN 'La llave de idempotencia ya se usó con otros datos'
    WHEN 'INVALID_RANGE'              THEN 'Rango de horas inválido'
    WHEN 'DURATION_TOO_SHORT'         THEN 'La reserva es más corta que la duración mínima'
    WHEN 'INVALID_DURATION'           THEN 'La duración no es múltiplo del paso de la grilla'
    WHEN 'CROSSES_MIDNIGHT'           THEN 'La reserva no puede cruzar la medianoche'
    WHEN 'SLOT_NOT_ALIGNED'           THEN 'La hora de inicio no cae en la grilla de la instalación'
    WHEN 'OUTSIDE_HOURS'              THEN 'La instalación está cerrada en ese horario'
    WHEN 'TOO_SOON'                   THEN 'Falta menos que la anticipación mínima para reservar'
    WHEN 'TOO_FAR'                    THEN 'No se puede reservar con tanta anticipación'
    WHEN 'IN_THE_PAST'                THEN 'Esa hora ya pasó'
    WHEN 'FACILITY_BLOCKED'           THEN 'La instalación está cerrada en ese horario'
    WHEN 'SLOT_TAKEN'                 THEN 'Esa franja ya no está disponible'
    WHEN 'INVALID_STATE'              THEN 'La reserva no está en un estado que permita esta acción'
    WHEN 'ALREADY_STARTED'            THEN 'La reserva ya empezó'
    WHEN 'CANCELLATION_WINDOW_CLOSED' THEN 'Ya pasó el plazo para cancelar'
    WHEN 'RESCHEDULE_WINDOW_CLOSED'   THEN 'Ya pasó el plazo para reprogramar sin costo'
    WHEN 'DURATION_MISMATCH'          THEN 'La nueva reserva debe durar lo mismo que la original'
    WHEN 'DURATION_TOO_LONG'          THEN 'La reserva supera la duración máxima de la instalación'
    WHEN 'TOO_MANY_ACTIVE'            THEN 'Ya tienes el máximo de reservas activas; cancela o usa una antes de reservar otra'
    WHEN 'PRICE_NOT_CONFIGURED'       THEN 'Esta instalación aún no tiene tarifa configurada'
    WHEN 'RESCHEDULE_PRICE_DIFFERS'   THEN 'El nuevo horario cuesta más que el original; cancela y reserva de nuevo o pide ayuda a la escuela'
    WHEN 'RATE_LIMITED_AUTOMATION'    THEN 'Se alcanzó el tope de reservas automáticas por hora; reintenta más tarde'
    ELSE p_code END);
$function$;

-- ── canal: 'ai' e 'import' ─────────────────────────────────────────────────
ALTER TABLE public.facility_reservations DROP CONSTRAINT IF EXISTS facility_reservations_channel_check;
ALTER TABLE public.facility_reservations ADD CONSTRAINT facility_reservations_channel_check
  CHECK (channel IS NULL OR channel IN ('app', 'public', 'whatsapp', 'admin', 'landing', 'ai', 'import'));

CREATE INDEX IF NOT EXISTS idx_facility_reservations_auto_created
  ON public.facility_reservations (created_at DESC) WHERE channel IN ('ai', 'import');

-- ── cancelar_reserva (motivo saneado y acotado) ────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_reserva(p_reservation_id uuid, p_reason text DEFAULT NULL::text, p_actor_profile_id uuid DEFAULT NULL::uuid, p_guest_booker_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_r      public.facility_reservations%ROWTYPE;
  v_fac    public.facilities%ROWTYPE;
  v_acc    text;
  v_actor  uuid := COALESCE(auth.uid(), p_actor_profile_id);
  v_pol    jsonb;
  v_hours  numeric;
  v_pct    integer;
  v_refund numeric;
  v_rs     text;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;

  IF length(COALESCE(p_reason, '')) > 500 THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;

  SELECT * INTO v_r FROM public.facility_reservations WHERE id = p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public._reservas_err('RESERVATION_NOT_FOUND');
  END IF;
  SELECT * INTO v_fac FROM public.facilities WHERE id = v_r.facility_id;

  v_acc := public._reservas_acceso(v_fac.school_id, v_r.user_id, v_r.guest_booker_id, p_actor_profile_id, p_guest_booker_id);
  IF v_acc IS NULL THEN
    RETURN public._reservas_err('FORBIDDEN');
  END IF;

  IF v_r.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', true, 'already_cancelled', true,
             'reservation', public._reservas_resultado(v_r.id) -> 'reservation',
             'refund', jsonb_build_object('status', v_r.refund_status));
  END IF;
  IF v_r.status NOT IN ('hold', 'pending_payment', 'pending', 'confirmed', 'pending_reconciliation') THEN
    RETURN public._reservas_err('INVALID_STATE');
  END IF;

  v_hours := EXTRACT(EPOCH FROM (v_r.starts_at - now())) / 3600.0;
  -- pending_reconciliation: la clienta ya pagó y perdió la franja; sin ventana y con reembolso total.
  IF v_acc <> 'staff' AND v_r.status <> 'pending_reconciliation' THEN
    IF v_r.starts_at <= now() THEN
      RETURN public._reservas_err('ALREADY_STARTED');
    END IF;
    IF v_hours < v_fac.min_cancellation_hours THEN
      RETURN public._reservas_err('CANCELLATION_WINDOW_CLOSED');
    END IF;
  END IF;

  v_pol := public._reservas_politica(v_fac.school_id, v_fac.id);
  v_pct := CASE
    WHEN v_acc = 'staff' OR v_r.status = 'pending_reconciliation' THEN 100
    WHEN v_hours >= (v_pol ->> 'hours_full_refund')::numeric    THEN 100
    WHEN v_hours >= (v_pol ->> 'hours_partial_refund')::numeric THEN (v_pol ->> 'partial_pct')::integer
    ELSE 0 END;
  v_refund := round(v_r.amount_paid * v_pct / 100.0);
  v_rs := CASE WHEN v_refund > 0 THEN 'manual' ELSE 'none' END;   -- sin billetera hasta F6: la devolución la registra una persona

  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);
  UPDATE public.facility_reservations
     SET status              = 'cancelled',
         cancellation_reason = NULLIF(btrim(public._reservas_limpiar_texto(p_reason)), ''),
         cancelled_at        = now(),
         cancelled_by        = v_actor,
         refund_status       = v_rs,
         updated_at          = now()
   WHERE id = v_r.id;
  PERFORM set_config('sportmaps.rpc_reservas', '', true);

  RETURN jsonb_build_object('ok', true, 'already_cancelled', false,
           'reservation', public._reservas_resultado(v_r.id) -> 'reservation',
           'refund', jsonb_build_object(
              'pct', v_pct, 'amount', v_refund, 'status', v_rs,
              'hours_before', round(v_hours, 2),
              'policy', jsonb_build_object(
                 'hours_full_refund', (v_pol ->> 'hours_full_refund')::int,
                 'hours_partial_refund', (v_pol ->> 'hours_partial_refund')::int,
                 'partial_pct', (v_pol ->> 'partial_pct')::int,
                 'source', v_pol ->> 'source')));
END;
$function$;

-- ── reservar_cancha (firma nueva con p_source_ref) ─────────────────────────
DROP FUNCTION IF EXISTS public.reservar_cancha(uuid, timestamptz, timestamptz, text, text, text, uuid, uuid, uuid, jsonb, text, integer, text, text, numeric);
CREATE OR REPLACE FUNCTION public.reservar_cancha(p_facility_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_channel text, p_idempotency_key text, p_payment_method text DEFAULT 'online'::text, p_actor_profile_id uuid DEFAULT NULL::uuid, p_booker_profile_id uuid DEFAULT NULL::uuid, p_guest_booker_id uuid DEFAULT NULL::uuid, p_guest jsonb DEFAULT NULL::jsonb, p_rate_audience text DEFAULT NULL::text, p_participants integer DEFAULT 1, p_notes text DEFAULT NULL::text, p_external_org_name text DEFAULT NULL::text, p_amount_paid numeric DEFAULT 0, p_source_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_actor   uuid;
  v_fac     public.facilities%ROWTYPE;
  v_rol     text;
  v_staff   boolean;
  v_aud     text;
  v_booker  uuid;
  v_guest   uuid;
  v_gverif  timestamptz;
  v_err     text;
  v_ex      public.facility_reservations%ROWTYPE;
  v_day     date;
  v_total   numeric;
  v_steps   jsonb;
  v_source  text;
  v_deposit numeric;
  v_price   numeric;
  v_status  text;
  v_pay     text;
  v_hold_min integer;
  v_hold_exp timestamptz;
  v_id      uuid := gen_random_uuid();
  v_ref     text;
  v_btype   text;
  v_rtype   text;
  v_paid    numeric := COALESCE(p_amount_paid, 0);
  v_override boolean := false;
  v_snap    jsonb;
  v_cons    text;
  v_dur_min integer;
  v_av      jsonb;
  v_alt     jsonb := '[]'::jsonb;
  v_auto    boolean := false;
  v_n       integer;
  v_notes   text;
  v_org     text;
  v_gphone  text;
  v_gname   text;
  v_gemail  text;
BEGIN
  -- ── 0. argumentos ──────────────────────────────────────────────────────────
  IF p_facility_id IS NULL OR p_starts_at IS NULL OR p_ends_at IS NULL
     OR p_channel IS NULL OR p_channel NOT IN ('app', 'public', 'whatsapp', 'admin', 'landing', 'ai', 'import')
     OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 128
     OR p_payment_method IS NULL OR p_payment_method NOT IN ('online', 'transfer', 'cash', 'none')
     OR (p_rate_audience IS NOT NULL AND p_rate_audience NOT IN ('public', 'member'))
     OR length(COALESCE(p_notes, '')) > 500
     OR length(COALESCE(p_external_org_name, '')) > 200
     OR (p_guest IS NOT NULL AND (jsonb_typeof(p_guest) <> 'object'
                                  OR btrim(COALESCE(public._reservas_limpiar_texto(p_guest ->> 'phone'), '')) = ''
                                  OR btrim(COALESCE(public._reservas_limpiar_texto(p_guest ->> 'full_name'), '')) = ''
                                  OR length(COALESCE(p_guest ->> 'phone', '')) > 40
                                  OR length(COALESCE(p_guest ->> 'full_name', '')) > 200
                                  OR length(COALESCE(p_guest ->> 'email', '')) > 254))
     OR (p_source_ref IS NOT NULL AND p_source_ref !~ '^[A-Za-z0-9:_./#-]{1,200}$')
     OR (p_channel IN ('ai', 'import') AND p_source_ref IS NULL) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  -- Texto libre: sin caracteres de control; nunca se interpola en SQL dinámico (sin SQL dinámico en esta función).
  v_notes := NULLIF(btrim(public._reservas_limpiar_texto(p_notes)), '');
  v_org   := NULLIF(btrim(public._reservas_limpiar_texto(p_external_org_name)), '');
  IF p_guest IS NOT NULL THEN
    v_gphone := btrim(public._reservas_limpiar_texto(p_guest ->> 'phone'));
    v_gname  := btrim(public._reservas_limpiar_texto(p_guest ->> 'full_name'));
    v_gemail := NULLIF(btrim(public._reservas_limpiar_texto(COALESCE(p_guest ->> 'email', ''))), '');
  END IF;
  IF v_paid < 0 THEN
    RETURN public._reservas_err('INVALID_AMOUNT');
  END IF;

  -- ── 1. instalación, entitlement, rol ───────────────────────────────────────
  SELECT * INTO v_fac FROM public.facilities WHERE id = p_facility_id;
  IF NOT FOUND OR v_fac.school_id IS NULL THEN
    RETURN public._reservas_err('FACILITY_NOT_FOUND');
  END IF;
  IF COALESCE(p_participants, 1) < 1 OR (v_fac.capacity > 0 AND COALESCE(p_participants, 1) > v_fac.capacity) THEN
    RETURN public._reservas_err('INVALID_ARGUMENT');
  END IF;
  IF NOT COALESCE(public.has_entitlement(v_fac.school_id, 'reservations'), false) THEN
    RETURN public._reservas_err('ENTITLEMENT_REQUIRED');
  END IF;

  -- auth.uid() NULL solo con service_role/postgres (anon no tiene EXECUTE); entonces manda p_actor_profile_id.
  v_actor := COALESCE(v_uid, p_actor_profile_id);
  v_rol   := public._reservas_rol(v_fac.school_id, v_actor);
  v_staff := (v_rol = 'staff');

  IF p_channel = 'admin' AND NOT v_staff THEN
    RETURN public._reservas_err('CHANNEL_NOT_ALLOWED');
  END IF;

  -- Canales automatizados ('ai', 'import'): SOLO service_role con p_actor_profile_id de un ADMINISTRADOR de la
  -- escuela de la cancha; nunca desde authenticated, nunca para invitados, nunca mueven dinero.
  v_auto := p_channel IN ('ai', 'import');
  IF v_auto THEN
    IF v_uid IS NOT NULL OR NOT public._reservas_es_service_call()
       OR p_actor_profile_id IS NULL OR NOT v_staff
       OR NOT public._reservas_es_admin(v_fac.school_id, p_actor_profile_id, false)
       OR p_guest IS NOT NULL OR p_guest_booker_id IS NOT NULL THEN
      RETURN public._reservas_err('CHANNEL_NOT_ALLOWED');
    END IF;
    IF p_payment_method IN ('cash', 'none') OR v_paid > 0 THEN
      RETURN public._reservas_err('PAYMENT_METHOD_NOT_ALLOWED');
    END IF;
  END IF;
  IF NOT v_staff AND (p_rate_audience IS NOT NULL OR v_paid > 0 OR p_guest IS NOT NULL) THEN
    RETURN public._reservas_err('STAFF_ONLY_FIELD');
  END IF;

  IF v_fac.status <> 'available' OR COALESCE(v_fac.booking_enabled, true) = false THEN
    RETURN public._reservas_err('FACILITY_NOT_BOOKABLE');
  END IF;

  -- ── 2. quién reserva ───────────────────────────────────────────────────────
  IF v_staff THEN
    v_booker := p_booker_profile_id;
    -- Un staff solo reserva a nombre de gente vinculada a SU escuela (o de un invitado que él identifica por teléfono).
    IF v_booker IS NOT NULL AND public._reservas_rol(v_fac.school_id, v_booker) = 'external' THEN
      RETURN public._reservas_err('FORBIDDEN');
    END IF;
    IF p_guest_booker_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.facility_reservations r
                      WHERE r.guest_booker_id = p_guest_booker_id AND r.school_id = v_fac.school_id) THEN
        RETURN public._reservas_err('FORBIDDEN');       -- sin historial en esta escuela: usar p_guest con su teléfono
      END IF;
      v_guest := p_guest_booker_id;
    ELSIF p_guest IS NOT NULL THEN
      -- Nunca pisa nombre/correo de un invitado que ya existe (es de otra gente y de otras escuelas).
      INSERT INTO public.guest_bookers (phone, full_name, email)
      VALUES (v_gphone, v_gname, v_gemail)
      ON CONFLICT (phone) DO NOTHING
      RETURNING id INTO v_guest;
      IF v_guest IS NULL THEN
        SELECT gb.id INTO v_guest FROM public.guest_bookers gb WHERE gb.phone = v_gphone;
      END IF;
    END IF;
    IF v_booker IS NOT NULL AND v_guest IS NOT NULL THEN
      RETURN public._reservas_err('INVALID_ARGUMENT');
    END IF;
    IF v_booker IS NULL AND v_guest IS NULL THEN
      v_booker := v_actor;                          -- uso interno: queda a nombre del staff
    END IF;
  ELSE
    IF v_actor IS NOT NULL THEN
      IF (p_booker_profile_id IS NOT NULL AND p_booker_profile_id <> v_actor) THEN
        RETURN public._reservas_err('FORBIDDEN');
      END IF;
      IF p_guest_booker_id IS NOT NULL THEN
        RETURN public._reservas_err('INVALID_ARGUMENT');
      END IF;
      v_booker := v_actor;
    ELSE
      IF p_booker_profile_id IS NOT NULL THEN
        RETURN public._reservas_err('FORBIDDEN');
      END IF;
      IF p_guest_booker_id IS NULL THEN
        RETURN public._reservas_err('GUEST_REQUIRED');
      END IF;
      v_guest := p_guest_booker_id;
    END IF;
  END IF;

  IF v_guest IS NOT NULL THEN
    SELECT gb.verified_phone_at INTO v_gverif FROM public.guest_bookers gb WHERE gb.id = v_guest;
    IF NOT FOUND THEN
      RETURN public._reservas_err('GUEST_NOT_FOUND');
    END IF;
    IF NOT v_staff AND v_gverif IS NULL THEN
      RETURN public._reservas_err('GUEST_NOT_VERIFIED');
    END IF;
  END IF;

  -- ── 3. tarifa y reglas de quién puede ──────────────────────────────────────
  v_aud := public._reservas_audiencia(v_fac.bookable_by, v_rol, CASE WHEN v_staff THEN p_rate_audience END);
  IF v_aud IS NULL THEN
    RETURN public._reservas_err('AUDIENCE_NOT_ALLOWED');
  END IF;

  IF NOT v_staff AND v_booker IS NOT NULL AND public._reservas_es_menor(v_booker) THEN
    RETURN public._reservas_err('MINOR_CANNOT_BOOK');
  END IF;

  IF p_payment_method = 'none' AND NOT v_staff THEN
    RETURN public._reservas_err('PAYMENT_METHOD_NOT_ALLOWED');
  END IF;
  IF p_payment_method = 'cash' AND NOT v_staff AND (v_rol <> 'member' OR v_guest IS NOT NULL) THEN
    RETURN public._reservas_err('PAYMENT_REQUIRED');
  END IF;

  -- ── 4. lock por cancha-día e idempotencia ──────────────────────────────────
  v_day := (p_starts_at AT TIME ZONE 'America/Bogota')::date;
  IF v_auto THEN   -- serializa la ráfaga del mismo actor (orden de locks: actor, luego cancha-día)
    PERFORM pg_advisory_xact_lock(hashtextextended('resv_auto:' || v_actor::text, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('facility_slot:' || p_facility_id::text || ':' || v_day::text, 0));

  SELECT * INTO v_ex FROM public.facility_reservations
   WHERE school_id = v_fac.school_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_ex.facility_id = p_facility_id AND v_ex.starts_at = p_starts_at AND v_ex.ends_at = p_ends_at
       AND v_ex.user_id IS NOT DISTINCT FROM v_booker AND v_ex.guest_booker_id IS NOT DISTINCT FROM v_guest THEN
      RETURN public._reservas_resultado(v_ex.id, true);
    END IF;
    RETURN public._reservas_err('IDEMPOTENCY_KEY_REUSED');
  END IF;

  -- Tope de automatización: 30 reservas creadas por actor por hora (canales ai + import juntos).
  IF v_auto THEN
    SELECT count(*) INTO v_n FROM public.facility_reservations fr
     WHERE fr.channel IN ('ai', 'import') AND fr.created_at > now() - interval '1 hour'
       AND fr.price_snapshot ->> 'created_by' = v_actor::text;
    IF v_n >= 30 THEN
      RETURN public._reservas_err('RATE_LIMITED_AUTOMATION');
    END IF;
  END IF;

  -- Anti-acaparamiento: máximo 3 reservas activas futuras por reservante en esta escuela (no staff).
  IF NOT v_staff AND (
       SELECT count(*) FROM public.facility_reservations r
        WHERE r.school_id = v_fac.school_id
          AND r.status IN ('hold', 'pending_payment', 'pending', 'confirmed')
          AND r.ends_at > now()
          AND ((v_booker IS NOT NULL AND r.user_id = v_booker) OR (v_guest IS NOT NULL AND r.guest_booker_id = v_guest))) >= 3 THEN
    RETURN public._reservas_err('TOO_MANY_ACTIVE');
  END IF;

  -- ── 5. rango, horario, anticipación, blackouts ─────────────────────────────
  v_err := public._reservas_validar_rango(p_facility_id, p_starts_at, p_ends_at, v_staff);
  IF v_err IS NOT NULL THEN
    RETURN public._reservas_err(v_err);
  END IF;
  IF v_staff THEN
    v_override := public._reservas_validar_rango(p_facility_id, p_starts_at, p_ends_at, false) IS NOT NULL;
  END IF;
  v_dur_min := (EXTRACT(EPOCH FROM (p_ends_at - p_starts_at)) / 60)::integer;

  -- ── 6. precio ──────────────────────────────────────────────────────────────
  SELECT jsonb_agg(jsonb_build_object('from', public._reservas_iso(p.step_from), 'to', public._reservas_iso(p.step_to),
                                      'rate', p.rate, 'source', p.source) ORDER BY p.step_from),
         round(sum(p.rate * EXTRACT(EPOCH FROM (p.step_to - p.step_from)) / 3600.0)),
         CASE WHEN bool_or(p.source = 'facility_rates') THEN 'facility_rates' ELSE 'facility_default' END
    INTO v_steps, v_total, v_source
    FROM public._reservas_precio_pasos(p_facility_id, p_starts_at, p_ends_at, v_aud) p;
  IF v_total IS NULL THEN
    RETURN public._reservas_err('INVALID_RANGE');
  END IF;
  IF v_total = 0 AND (NOT v_staff OR (v_auto AND v_source <> 'facility_rates')) THEN
    RETURN public._reservas_err('PRICE_NOT_CONFIGURED');   -- no hay waiver explícito: una cancha sin tarifa no se regala
  END IF;
  IF v_paid > v_total THEN
    RETURN public._reservas_err('INVALID_AMOUNT');
  END IF;
  v_deposit := round(v_total * v_fac.min_deposit_pct / 100.0);
  v_price   := v_total;

  -- ── 7. estado inicial ──────────────────────────────────────────────────────
  v_hold_min := NULL;
  IF v_staff AND p_payment_method = 'none' THEN
    v_status := 'confirmed'; v_pay := 'waived'; v_price := 0; v_paid := 0;
  ELSIF v_total = 0 THEN
    v_status := 'confirmed'; v_pay := 'waived';
  ELSIF p_payment_method = 'cash' THEN
    v_status := 'confirmed';
    v_pay := CASE WHEN v_paid = 0 THEN 'unpaid' WHEN v_paid >= v_total THEN 'paid' ELSE 'partial' END;
  ELSE
    v_status   := 'pending_payment';
    v_hold_min := CASE WHEN p_payment_method = 'transfer' THEN 15 ELSE 10 END;
    v_pay := CASE WHEN v_paid = 0 THEN 'unpaid' WHEN v_paid >= v_total THEN 'paid' ELSE 'partial' END;
  END IF;
  v_hold_exp := CASE WHEN v_status = 'pending_payment' THEN now() + make_interval(mins => v_hold_min) END;

  v_btype := CASE
    WHEN v_guest IS NOT NULL OR v_rol = 'external' OR (v_staff AND v_org IS NOT NULL) THEN 'external'
    WHEN v_staff THEN 'school'
    WHEN EXISTS (SELECT 1 FROM public.school_members sm
                  WHERE sm.profile_id = v_booker AND sm.school_id = v_fac.school_id
                    AND sm.role = 'athlete' AND sm.status = 'active') THEN 'athlete'
    ELSE 'parent' END;
  v_rtype := CASE WHEN v_btype = 'external' THEN 'rental' ELSE 'internal' END;
  v_ref   := 'RSV-' || upper(left(replace(v_id::text, '-', ''), 16));

  v_snap := jsonb_build_object(
    'audience', v_aud, 'total', v_total, 'deposit_min', v_deposit, 'source', v_source,
    'breakdown', COALESCE(v_steps, '[]'::jsonb), 'payment_method', p_payment_method,
    'hold_minutes', v_hold_min, 'staff_override', v_override, 'created_by', v_actor,
    'payment_events', '[]'::jsonb, 'created_via', p_channel)
          || CASE WHEN p_source_ref IS NOT NULL THEN jsonb_build_object('source_ref', p_source_ref) ELSE '{}'::jsonb END;

  -- ── 8. libera holds vencidos de esa cancha-día e inserta ───────────────────
  PERFORM set_config('sportmaps.rpc_reservas', 'on', true);

  -- Un hold vencido con plata adentro NO se pierde: pasa a conciliación (libera la franja igual).
  UPDATE public.facility_reservations
     SET status = CASE WHEN amount_paid > 0 THEN 'pending_reconciliation' ELSE 'expired' END, updated_at = now()
   WHERE facility_id = p_facility_id AND reservation_date = v_day
     AND status IN ('hold', 'pending_payment')
     AND hold_expires_at IS NOT NULL AND hold_expires_at < now();

  UPDATE public.facility_occupancy
     SET status = 'released', updated_at = now()
   WHERE facility_id = p_facility_id AND status = 'hold' AND hold_expires_at < now();

  BEGIN
    INSERT INTO public.facility_reservations (
      id, facility_id, user_id, school_id, reservation_date, start_time, end_time,
      status, price, notes, participants, approved_by, approved_at,
      booker_type, resv_type, external_org_name, min_deposit_pct, payment_status, amount_paid,
      starts_at, ends_at, hold_expires_at, idempotency_key, channel, guest_booker_id,
      price_snapshot, payment_reference)
    VALUES (
      v_id, p_facility_id, v_booker, v_fac.school_id,
      v_day, (p_starts_at AT TIME ZONE 'America/Bogota')::time, (p_ends_at AT TIME ZONE 'America/Bogota')::time,
      v_status, v_price, v_notes, GREATEST(COALESCE(p_participants, 1), 1),
      CASE WHEN v_staff AND v_status = 'confirmed' THEN v_actor END,
      CASE WHEN v_status = 'confirmed' THEN now() END,
      v_btype::public.booker_type, v_rtype::public.resv_type, v_org,
      v_fac.min_deposit_pct, v_pay::public.resv_payment_status, v_paid,
      p_starts_at, p_ends_at, v_hold_exp, p_idempotency_key, p_channel, v_guest,
      v_snap, v_ref);
  EXCEPTION
    WHEN exclusion_violation THEN
      PERFORM set_config('sportmaps.rpc_reservas', '', true);
      BEGIN
        v_av := public.disponibilidad_canchas(v_fac.school_id, v_day, v_day + 2, NULL, p_facility_id,
                                              v_dur_min, CASE WHEN v_staff THEN p_rate_audience END, p_actor_profile_id);
        SELECT COALESCE(jsonb_agg(x.slot ORDER BY x.ord), '[]'::jsonb) INTO v_alt
          FROM (SELECT (sl || jsonb_build_object('facility_id', p_facility_id)) AS slot, (sl ->> 'starts_at') AS ord
                  FROM jsonb_array_elements(COALESCE(v_av -> 'facilities' -> 0 -> 'days', '[]'::jsonb)) AS d,
                       jsonb_array_elements(d -> 'slots') AS sl
                 WHERE (sl ->> 'starts_at')::timestamptz >= p_starts_at
                 ORDER BY (sl ->> 'starts_at')
                 LIMIT 3) x;
      EXCEPTION WHEN OTHERS THEN
        v_alt := '[]'::jsonb;
      END;
      RETURN public._reservas_err('SLOT_TAKEN') || jsonb_build_object('alternatives', v_alt);
    WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_cons = CONSTRAINT_NAME;
      PERFORM set_config('sportmaps.rpc_reservas', '', true);
      IF v_cons = 'uq_facility_reservations_idempotency' THEN
        SELECT * INTO v_ex FROM public.facility_reservations
         WHERE school_id = v_fac.school_id AND idempotency_key = p_idempotency_key;
        IF FOUND AND v_ex.facility_id = p_facility_id AND v_ex.starts_at = p_starts_at AND v_ex.ends_at = p_ends_at
           AND v_ex.user_id IS NOT DISTINCT FROM v_booker AND v_ex.guest_booker_id IS NOT DISTINCT FROM v_guest THEN
          RETURN public._reservas_resultado(v_ex.id, true);
        END IF;
        RETURN public._reservas_err('IDEMPOTENCY_KEY_REUSED');
      END IF;
      RETURN public._reservas_err('SLOT_TAKEN') || jsonb_build_object('alternatives', '[]'::jsonb);
  END;

  PERFORM set_config('sportmaps.rpc_reservas', '', true);
  RETURN public._reservas_resultado(v_id, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.reservar_cancha(uuid, timestamptz, timestamptz, text, text, text, uuid, uuid, uuid, jsonb, text, integer, text, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reservar_cancha(uuid, timestamptz, timestamptz, text, text, text, uuid, uuid, uuid, jsonb, text, integer, text, text, numeric, text) TO authenticated, service_role;

COMMIT;


-- ───────── 20261105213601_anon_sin_escritura_en_tablas_de_planes.sql ─────────
-- 20261105213601_anon_sin_escritura_en_tablas_de_planes.sql
--
-- ORDEN: 4.º (después de 20261105212125; independiente del resto; no depende del frontend).
-- PRECONDICIONES: ninguna.
--
-- POR QUÉ: anon (sin sesión) tiene hoy INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER sobre las tablas que
-- deciden qué paga cada escuela (school_addons, school_subscriptions, subscription_plans) y sobre school_members,
-- school_settings y schools. Hoy las frena solo RLS; un error de policy (p. ej. un USING(true) nuevo) las dejaría
-- escribibles sin login. Son grants "inertes" por los default privileges de Supabase y no los necesita nadie:
-- el registro ocurre con authenticated tras signUp y handle_new_user es SECURITY DEFINER (dueño postgres).
-- Verificado con Grep en frontend/src, bff/src y supabase/functions: ningún cliente sin sesión escribe estas
-- tablas. Se conserva SELECT de anon (la landing / planes públicos pueden leer subscription_plans y schools;
-- school_addons y school_subscriptions no tienen policy para anon, su SELECT es inerte).

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_addons        FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_subscriptions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.subscription_plans   FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_members       FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.school_settings      FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.schools              FROM anon;

COMMIT;


-- ───────── 20261105214559_reservas_select_solo_propias_o_staff.sql ─────────
-- 20261105214559_reservas_select_solo_propias_o_staff.sql
--
-- ORDEN EN PRODUCCIÓN: después de 20261105212125 (staff/canales) y de 20261105213601 (anon); ANTES de
--   20261105213611 (M7, que va al final). Es independiente de M7: ambas usan DROP POLICY IF EXISTS y ninguna
--   contradice a la otra (M7 deja facility_resv_school_select y facility_resv_select_own; esta deja
--   facility_resv_select_own y facility_resv_select_staff_scope). Puede aplicarse YA, sin esperar al frontend:
--   ninguna pantalla de padre/atleta lee reservas ajenas (verificado con Grep, ver abajo).
--
-- POR QUÉ (privacidad): la policy reservations_select (SELECT, authenticated) dejaba a CUALQUIER miembro activo de
-- la escuela (padre, atleta) leer TODAS las reservas de sus instalaciones, con user_id, notas, nombres de invitado
-- y montos de otras familias.
--
-- DESPUÉS: el reservante ve las SUYAS (facility_resv_select_own: user_id = auth.uid(), ya existente) y quien tiene
-- alcance operativo ve las de su escuela: user_staff_school_ids() (incluye coach: lo necesita
-- AttendanceSupervisionPage para la agenda del día) o user_admin_school_ids() (dueño/admin). Padres y atletas ya
-- NO ven reservas ajenas. La disponibilidad pública NO depende de esta policy: sale de la RPC disponibilidad_canchas
-- y de facility_occupancy vía SECURITY DEFINER.
--
-- VERIFICACIÓN de dependencias (Grep frontend/src y bff/src): las únicas lecturas con JWT de usuario de
-- facility_reservations son hooks/useFacilityReservations.ts (listado y getBookedSlots, usados por
-- SchoolFacilitiesPage, OwnerReservationModal y CourtesyBookingRescheduleModal: pantallas del staff/dueño),
-- AttendanceSupervisionPage.tsx (:331 y :471, staff/coach) y pages/venue/useVenueSummary.ts (dueño de la sede).
-- Ninguna pantalla de padre o atleta lee reservas ajenas; el BFF usa service_role. Sin dependencia legítima, así
-- que no hace falta vista ni RPC de ocupación.
-- Nota: un contador (rol accountant) ya no ve reservas; ninguna pantalla contable las lee.

BEGIN;

DROP POLICY IF EXISTS reservations_select ON public.facility_reservations;

DROP POLICY IF EXISTS facility_resv_select_staff_scope ON public.facility_reservations;
CREATE POLICY facility_resv_select_staff_scope ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.facilities f
                  WHERE f.id = facility_reservations.facility_id
                    AND (f.school_id = ANY (public.user_staff_school_ids())
                         OR f.school_id = ANY (public.user_admin_school_ids()))));

-- La del reservante ya existe (facility_resv_select_own, USING auth.uid() = user_id); se recrea por si faltara,
-- sin ampliarla.
DROP POLICY IF EXISTS facility_resv_select_own ON public.facility_reservations;
CREATE POLICY facility_resv_select_own ON public.facility_reservations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

COMMIT;


