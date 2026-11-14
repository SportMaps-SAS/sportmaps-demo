-- =============================================================================
-- 20261026132948_codigo_de_escuela.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-26   Versión anterior: 20261025205957
-- Objetivo: «Código de escuela» (docs/specs/codigo-de-escuela-union-por-codigo.md).
--   Quien YA tiene cuenta (acudiente o deportista) y no quedó unido a ninguna
--   escuela ingresa el código corto de su escuela (BES-4K7Q) y queda en la
--   bandeja «Por asignar». La administración elige el equipo y la sede.
--
--   Esta migración NO crea inscripciones ni cobros. Asignar crea/adopta la FICHA
--   (children con parent_id = quien pidió) o la membresía (caso «para mí»); la
--   inscripción y su cobro los crea el MISMO camino que «Agregar atleta»:
--   POST /api/v1/students/create-one (child_existing / adult_existing →
--   RPC create_enrollment_with_payments), llamado desde la bandeja después de
--   resolver. Así no nace un camino 14 que cree payments.
--
-- Objetos:
--   Tablas  school_join_codes · school_join_requests · school_join_code_attempts
--   Helpers normalize_school_join_code · _school_join_code_prefix ·
--           _generate_school_join_code · _create_school_join_code ·
--           _school_join_code_rate_ok  (sin EXECUTE para nadie salvo el dueño)
--   RPCs    preview_school_join_code · submit_school_join_request ·
--           cancel_school_join_request · my_school_join_status ·
--           list_school_join_requests · resolve_school_join_request ·
--           confirm_school_join_request_enrollment · get_school_join_code ·
--           rotate_school_join_code
--   Backfill: un código activo para cada escuela existente.
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tablas
-- -----------------------------------------------------------------------------

-- Alfabeto del sufijo: sin 0/O/1/I/L (ambiguos al dictarlos o escribirlos).
-- Se guarda SIN guion (BES4K7Q); la UI lo muestra como BES-4K7Q.
CREATE TABLE IF NOT EXISTS public.school_join_codes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id   uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    -- D2: un código por escuela; la sede se elige al asignar. Queda la columna
    -- por si algún día se pide un código por sede, siempre NULL hoy.
    branch_id   uuid NULL REFERENCES public.school_branches(id) ON DELETE SET NULL,
    code        text NOT NULL UNIQUE
                CHECK (code ~ '^[A-Z]{3}[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$'),
    active      boolean NOT NULL DEFAULT true,
    uses_count  integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
    created_by  uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at  timestamptz NULL,
    revoked_by  uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    CHECK (active OR revoked_at IS NOT NULL)
);

-- Un solo código activo por escuela. Los revocados conservan su fila (y su
-- UNIQUE de code), así un código viejo nunca se reasigna a otra escuela.
CREATE UNIQUE INDEX IF NOT EXISTS uq_school_join_codes_one_active
    ON public.school_join_codes (school_id) WHERE active;

COMMENT ON TABLE public.school_join_codes IS
  'Código corto para unirse a una escuela con una cuenta ya creada (spec codigo-de-escuela-union-por-codigo). Escritura solo por RPC; lectura solo administración (user_admin_school_ids).';

CREATE TABLE IF NOT EXISTS public.school_join_requests (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id             uuid NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    join_code_id          uuid NULL REFERENCES public.school_join_codes(id) ON DELETE SET NULL,
    requester_profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    for_whom              text NOT NULL CHECK (for_whom IN ('self', 'child')),
    athlete_name          text NOT NULL CHECK (char_length(btrim(athlete_name)) BETWEEN 2 AND 150),
    birth_date            date NULL,
    suggested_category    text NULL CHECK (suggested_category IS NULL OR char_length(suggested_category) <= 120),
    status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'assigned', 'linked', 'rejected', 'cancelled')),
    assigned_team_id      uuid NULL REFERENCES public.teams(id) ON DELETE SET NULL,
    assigned_branch_id    uuid NULL REFERENCES public.school_branches(id) ON DELETE SET NULL,
    child_id              uuid NULL REFERENCES public.children(id) ON DELETE SET NULL,
    enrollment_id         uuid NULL REFERENCES public.enrollments(id) ON DELETE SET NULL,
    resolved_by           uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
    resolved_at           timestamptz NULL,
    reject_reason         text NULL CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 300),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Una sola solicitud en revisión por (escuela, cuenta, deportista).
CREATE UNIQUE INDEX IF NOT EXISTS uq_school_join_requests_one_pending
    ON public.school_join_requests (school_id, requester_profile_id, public.normalize_athlete_name(athlete_name))
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_school_join_requests_school_status
    ON public.school_join_requests (school_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_school_join_requests_requester
    ON public.school_join_requests (requester_profile_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_school_join_requests_updated_at ON public.school_join_requests;
CREATE TRIGGER trg_school_join_requests_updated_at
    BEFORE UPDATE ON public.school_join_requests
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.school_join_requests IS
  'Bandeja «Por asignar»: solicitudes de cuentas existentes para unirse a una escuela por código. pending → assigned (ficha creada) | linked (ficha existente vinculada) | rejected | cancelled. NO crea inscripción ni cobro: eso lo hace students/create-one desde la bandeja.';

-- Intentos de código por usuario (freno a quien quiera adivinar códigos).
CREATE TABLE IF NOT EXISTS public.school_join_code_attempts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    success     boolean NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_join_code_attempts_profile
    ON public.school_join_code_attempts (profile_id, created_at DESC);

COMMENT ON TABLE public.school_join_code_attempts IS
  'Registro de intentos de código de escuela por usuario, para el límite de preview/submit. Sin acceso desde el cliente.';

-- -----------------------------------------------------------------------------
-- 2. RLS y privilegios de tabla
-- -----------------------------------------------------------------------------
ALTER TABLE public.school_join_codes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_join_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_join_code_attempts ENABLE ROW LEVEL SECURITY;

-- Los default privileges del esquema otorgan todo a anon/authenticated en cada
-- tabla nueva: se revoca explícito y se devuelve solo SELECT donde aplica.
REVOKE ALL ON TABLE public.school_join_codes         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.school_join_requests      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.school_join_code_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.school_join_codes    TO authenticated;
GRANT SELECT ON TABLE public.school_join_requests TO authenticated;

-- Escritura: NINGUNA policy. Todo pasa por las RPCs SECURITY DEFINER.
DROP POLICY IF EXISTS school_join_codes_select_admin ON public.school_join_codes;
CREATE POLICY school_join_codes_select_admin ON public.school_join_codes
    FOR SELECT TO authenticated
    USING (school_id = ANY ((SELECT public.user_admin_school_ids())::uuid[]));

DROP POLICY IF EXISTS school_join_requests_select_own_or_staff ON public.school_join_requests;
CREATE POLICY school_join_requests_select_own_or_staff ON public.school_join_requests
    FOR SELECT TO authenticated
    USING (
        requester_profile_id = (SELECT auth.uid())
        OR school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
    );
-- school_join_code_attempts: RLS sin policies = nadie lee ni escribe desde el cliente.

-- -----------------------------------------------------------------------------
-- 3. Helpers (sin EXECUTE para anon/authenticated)
-- -----------------------------------------------------------------------------

-- Mayúsculas, sin guiones/espacios. En el prefijo (3 letras) un 0 es una O y un 1
-- es una I: el sufijo no tiene esos caracteres, el prefijo sí puede tenerlos.
CREATE OR REPLACE FUNCTION public.normalize_school_join_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
    SELECT CASE
             WHEN v IS NULL OR char_length(v) <> 7 THEN v
             ELSE translate(substr(v, 1, 3), '01', 'OI') || substr(v, 4)
           END
      FROM (SELECT NULLIF(regexp_replace(upper(coalesce(p_code, '')), '[^A-Z0-9]', '', 'g'), '') AS v) s;
$$;

-- Prefijo de 3 letras desde el nombre, saltando palabras genéricas
-- («Club Deportivo Besser» → BES). Si todo es genérico, usa el nombre entero.
CREATE OR REPLACE FUNCTION public._school_join_code_prefix(p_name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_clean   text := upper(coalesce(public.normalize_athlete_name(p_name), ''));
    v_stop    text[] := ARRAY[
        'CLUB','ESCUELA','ESCUELAS','ESCUELITA','ACADEMIA','ACADEMIAS','DEPORTIVO','DEPORTIVA',
        'DEPORTIVOS','DEPORTIVAS','DEPORTES','DEPORTE','DE','DEL','LA','LAS','EL','LOS','Y',
        'FC','CD','CF','SC','AC','FUNDACION','CORPORACION','LIGA','EQUIPO','INSTITUTO',
        'CENTRO','THE','OF','SPORT','SPORTS','TEAM'];
    v_letters text := '';
    w         text;
BEGIN
    FOREACH w IN ARRAY regexp_split_to_array(regexp_replace(v_clean, '[^A-Z ]', ' ', 'g'), '\s+') LOOP
        CONTINUE WHEN w = '' OR w = ANY (v_stop);
        v_letters := v_letters || w;
        EXIT WHEN char_length(v_letters) >= 3;
    END LOOP;
    IF char_length(v_letters) < 3 THEN
        v_letters := v_letters || regexp_replace(v_clean, '[^A-Z]', '', 'g');
    END IF;
    RETURN rpad(left(v_letters, 3), 3, 'X');
END;
$$;

-- Prefijo + 4 caracteres aleatorios (bytes de gen_random_uuid, fuente fuerte).
CREATE OR REPLACE FUNCTION public._generate_school_join_code(p_prefix text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    c_alpha CONSTANT text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   -- 31 caracteres
    v_bytes bytea := uuid_send(gen_random_uuid());
    v_out   text := p_prefix;
BEGIN
    FOR i IN 0..3 LOOP
        v_out := v_out || substr(c_alpha, (get_byte(v_bytes, i) % 31) + 1, 1);
    END LOOP;
    RETURN v_out;
END;
$$;

-- Crea el código activo de una escuela, con reintento ante choque de código.
-- Se llama SOLO desde RPCs SECURITY DEFINER (que ya validaron permisos) y desde
-- el backfill; el caller debe tomar el advisory lock de la escuela.
CREATE OR REPLACE FUNCTION public._create_school_join_code(p_school_id uuid, p_created_by uuid)
RETURNS public.school_join_codes
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_prefix text;
    v_row    public.school_join_codes;
    v_try    integer := 0;
BEGIN
    SELECT public._school_join_code_prefix(s.name) INTO v_prefix
      FROM public.schools s WHERE s.id = p_school_id;
    IF v_prefix IS NULL THEN
        RAISE EXCEPTION 'Escuela no encontrada.' USING ERRCODE = 'P0002';
    END IF;

    LOOP
        v_try := v_try + 1;
        BEGIN
            INSERT INTO public.school_join_codes (school_id, code, created_by)
            VALUES (p_school_id, public._generate_school_join_code(v_prefix), p_created_by)
            RETURNING * INTO v_row;
            RETURN v_row;
        EXCEPTION WHEN unique_violation THEN
            -- ¿Chocó contra el activo de la escuela (otro proceso lo creó)? Se devuelve ese.
            SELECT * INTO v_row FROM public.school_join_codes
             WHERE school_id = p_school_id AND active;
            IF FOUND THEN
                RETURN v_row;
            END IF;
            -- Si no, chocó contra un código ya usado: se reintenta con otro sufijo.
            IF v_try >= 25 THEN
                RAISE EXCEPTION 'No se pudo generar un código único para la escuela.';
            END IF;
        END;
    END LOOP;
END;
$$;

-- Límite de intentos: 8 códigos inválidos en 15 minutos bloquean 15 minutos.
-- Limpia de paso los intentos de más de un día de ese usuario.
CREATE OR REPLACE FUNCTION public._school_join_code_rate_ok(p_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    DELETE FROM public.school_join_code_attempts
     WHERE profile_id = p_profile_id
       AND created_at < now() - interval '1 day';

    RETURN (
        SELECT count(*) FROM public.school_join_code_attempts
         WHERE profile_id = p_profile_id
           AND NOT success
           AND created_at > now() - interval '15 minutes'
    ) < 8;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. RPCs de la familia / deportista
-- -----------------------------------------------------------------------------

-- Vista previa: SOLO nombre, logo y ciudad (más dos banderas sobre la propia cuenta).
-- Un código inválido devuelve ok=false en vez de lanzar error, para que el
-- intento fallido quede registrado (un RAISE desharía el INSERT del intento).
CREATE OR REPLACE FUNCTION public.preview_school_join_code(p_code text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid    uuid := auth.uid();
    v_code   text;
    v_jc     public.school_join_codes;
    v_school record;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para usar el código de tu escuela.' USING ERRCODE = '42501';
    END IF;

    IF NOT public._school_join_code_rate_ok(v_uid) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited',
            'message', 'Hiciste demasiados intentos. Espera 15 minutos y vuelve a probar.');
    END IF;

    v_code := public.normalize_school_join_code(p_code);
    SELECT * INTO v_jc FROM public.school_join_codes WHERE code = v_code AND active;

    INSERT INTO public.school_join_code_attempts (profile_id, success)
    VALUES (v_uid, v_jc.id IS NOT NULL);

    IF v_jc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
            'message', 'Ese código no existe o la escuela lo cambió. Pídeselo de nuevo a tu escuela.');
    END IF;

    SELECT s.id, s.name, s.logo_url, s.city INTO v_school
      FROM public.schools s WHERE s.id = v_jc.school_id;

    RETURN jsonb_build_object(
        'ok',          true,
        'code',        v_jc.code,
        'school_id',   v_school.id,
        'school_name', v_school.name,
        'logo_url',    v_school.logo_url,
        'city',        v_school.city,
        'already_member', EXISTS (
            SELECT 1 FROM public.school_members m
             WHERE m.profile_id = v_uid AND m.school_id = v_school.id AND m.status = 'active'),
        'pending_requests', (
            SELECT count(*) FROM public.school_join_requests r
             WHERE r.requester_profile_id = v_uid AND r.school_id = v_school.id AND r.status = 'pending')
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_school_join_request(
    p_code       text,
    p_for_whom   text,
    p_name       text,
    p_birth_date date,
    p_category   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid         uuid := auth.uid();
    v_today       date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_name        text;
    v_cat         text;
    v_code        text;
    v_jc          public.school_join_codes;
    v_school_name text;
    v_requester   text;
    v_req_id      uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para usar el código de tu escuela.' USING ERRCODE = '42501';
    END IF;

    IF p_for_whom IS NULL OR p_for_whom NOT IN ('self', 'child') THEN
        RAISE EXCEPTION 'Elige si la solicitud es para ti o para tu hijo(a).' USING ERRCODE = '22023';
    END IF;

    v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
    IF char_length(v_name) < 2 OR char_length(v_name) > 150 THEN
        RAISE EXCEPTION 'Escribe el nombre completo del deportista.' USING ERRCODE = '22023';
    END IF;

    IF p_birth_date IS NULL OR p_birth_date > v_today OR p_birth_date < DATE '1920-01-01' THEN
        RAISE EXCEPTION 'Revisa la fecha de nacimiento.' USING ERRCODE = '22023';
    END IF;

    v_cat := NULLIF(left(btrim(coalesce(p_category, '')), 120), '');

    IF NOT public._school_join_code_rate_ok(v_uid) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited',
            'message', 'Hiciste demasiados intentos. Espera 15 minutos y vuelve a probar.');
    END IF;

    v_code := public.normalize_school_join_code(p_code);
    SELECT * INTO v_jc FROM public.school_join_codes WHERE code = v_code AND active;

    INSERT INTO public.school_join_code_attempts (profile_id, success)
    VALUES (v_uid, v_jc.id IS NOT NULL);

    IF v_jc.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
            'message', 'Ese código no existe o la escuela lo cambió. Pídeselo de nuevo a tu escuela.');
    END IF;

    -- Tope de solicitudes abiertas por cuenta (no inundar la bandeja de nadie).
    IF (SELECT count(*) FROM public.school_join_requests
         WHERE requester_profile_id = v_uid AND status = 'pending') >= 5 THEN
        RAISE EXCEPTION 'Ya tienes 5 solicitudes en revisión. Espera a que las escuelas respondan o cancela alguna.'
            USING ERRCODE = '54000';
    END IF;

    IF p_for_whom = 'self' AND EXISTS (
        SELECT 1 FROM public.enrollments e
         WHERE e.school_id = v_jc.school_id AND e.user_id = v_uid AND e.status IN ('active', 'pending')
    ) THEN
        RAISE EXCEPTION 'Ya estás inscrito(a) en esta escuela.' USING ERRCODE = '23505';
    END IF;

    IF p_for_whom = 'child' AND EXISTS (
        SELECT 1 FROM public.children c
         WHERE c.parent_id = v_uid AND c.school_id = v_jc.school_id
           AND public.normalize_athlete_name(c.full_name) = public.normalize_athlete_name(v_name)
    ) THEN
        RAISE EXCEPTION '% ya está registrado(a) en esta escuela. Lo encuentras en Mis hijos.', v_name
            USING ERRCODE = '23505';
    END IF;

    BEGIN
        INSERT INTO public.school_join_requests
            (school_id, join_code_id, requester_profile_id, for_whom, athlete_name, birth_date, suggested_category)
        VALUES
            (v_jc.school_id, v_jc.id, v_uid, p_for_whom, v_name, p_birth_date, v_cat)
        RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Ya enviaste una solicitud para % a esta escuela. Está en revisión.', v_name
            USING ERRCODE = '23505';
    END;

    UPDATE public.school_join_codes SET uses_count = uses_count + 1 WHERE id = v_jc.id;

    SELECT s.name INTO v_school_name FROM public.schools s WHERE s.id = v_jc.school_id;
    SELECT coalesce(p.full_name, p.email, 'Una familia') INTO v_requester
      FROM public.profiles p WHERE p.id = v_uid;

    -- Aviso a la administración (owner + admin/school_admin activos): son los
    -- únicos que pueden asignar (D3). Pasa por el despachador (triggers de
    -- notifications: enqueue_notification_delivery / push).
    INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
    SELECT a.pid, v_jc.school_id,
           'Nueva solicitud para unirse',
           CASE WHEN p_for_whom = 'child'
                THEN format('%s pidió unir a %s. Asígnale una categoría en Atletas → Por asignar.', v_requester, v_name)
                ELSE format('%s pidió unirse a la escuela. Asígnale una categoría en Atletas → Por asignar.', v_name)
           END,
           'info', '/students?bandeja=por-asignar', 'enrollment',
           jsonb_build_object('kind', 'school_join_request', 'join_request_id', v_req_id)
      FROM (
            SELECT s.owner_id AS pid FROM public.schools s
             WHERE s.id = v_jc.school_id AND s.owner_id IS NOT NULL
            UNION
            SELECT m.profile_id FROM public.school_members m
             WHERE m.school_id = v_jc.school_id AND m.status = 'active'
               AND m.role IN ('owner', 'admin', 'school_admin')
           ) a
     WHERE a.pid IS NOT NULL
       AND a.pid <> v_uid;

    RETURN jsonb_build_object('ok', true, 'request_id', v_req_id, 'school_name', v_school_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_school_join_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_id  uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    UPDATE public.school_join_requests
       SET status = 'cancelled', resolved_at = now(), resolved_by = v_uid
     WHERE id = p_request_id
       AND requester_profile_id = v_uid
       AND status = 'pending'
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'Esa solicitud ya no está en revisión.' USING ERRCODE = '55000';
    END IF;

    RETURN jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'cancelled');
END;
$$;

-- ¿La cuenta tiene escuela? + sus solicitudes recientes (para el aviso del inicio
-- y de «Mis hijos»).
CREATE OR REPLACE FUNCTION public.my_school_join_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    RETURN jsonb_build_object(
        'has_school', (
            EXISTS (SELECT 1 FROM public.school_members m
                     WHERE m.profile_id = v_uid AND m.status = 'active')
            OR EXISTS (SELECT 1 FROM public.children c
                        WHERE c.parent_id = v_uid AND c.school_id IS NOT NULL)
        ),
        'requests', coalesce((
            SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
              FROM (
                SELECT r.id, r.status, r.for_whom, r.athlete_name, r.created_at, r.resolved_at,
                       r.reject_reason, s.name AS school_name, s.logo_url, t.name AS team_name
                  FROM public.school_join_requests r
                  JOIN public.schools s ON s.id = r.school_id
                  LEFT JOIN public.teams t ON t.id = r.assigned_team_id
                 WHERE r.requester_profile_id = v_uid
                   AND (r.status = 'pending' OR r.resolved_at > now() - interval '30 days')
                 ORDER BY r.created_at DESC
                 LIMIT 10
              ) x
        ), '[]'::jsonb)
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RPCs de la escuela
-- -----------------------------------------------------------------------------

-- Bandeja «Por asignar». Lectura: staff (user_staff_school_ids), como la policy.
-- Trae las pendientes y las ya asignadas a las que todavía les falta la
-- inscripción (si la llamada a students/create-one falló o no se hizo).
CREATE OR REPLACE FUNCTION public.list_school_join_requests(
    p_school_id        uuid,
    p_include_resolved boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_rows jsonb;
BEGIN
    IF auth.uid() IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_staff_school_ids())) THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at), '[]'::jsonb)
      INTO v_rows
      FROM (
        SELECT r.id, r.for_whom, r.athlete_name, r.birth_date, r.suggested_category,
               r.status, r.created_at, r.resolved_at, r.reject_reason,
               r.child_id, r.assigned_team_id, t.name AS team_name,
               r.assigned_branch_id, r.enrollment_id,
               r.requester_profile_id,
               p.full_name AS requester_name, p.email AS requester_email, p.phone AS requester_phone,
               (r.status IN ('assigned', 'linked') AND r.enrollment_id IS NULL
                AND r.assigned_team_id IS NOT NULL) AS needs_enrollment,
               EXISTS (
                   SELECT 1 FROM public.enrollments e
                    WHERE e.school_id = r.school_id
                      AND e.status IN ('active', 'pending')
                      AND (   (r.child_id IS NOT NULL AND e.child_id = r.child_id)
                           OR (r.for_whom = 'self' AND e.user_id = r.requester_profile_id))
               ) AS has_enrollment,
               coalesce(cand.candidates, '[]'::jsonb) AS candidates
          FROM public.school_join_requests r
          LEFT JOIN public.profiles p ON p.id = r.requester_profile_id
          LEFT JOIN public.teams t    ON t.id = r.assigned_team_id
          LEFT JOIN LATERAL (
              -- Fichas de la escuela SIN acudiente que podrían ser la misma persona
              -- (para «Ya tiene ficha → vincular» en vez de crear un duplicado).
              SELECT jsonb_agg(jsonb_build_object(
                         'id', k.id, 'full_name', k.full_name, 'date_of_birth', k.date_of_birth,
                         'team_name', kt.name, 'same_birth_date', k.date_of_birth = r.birth_date)
                       ORDER BY k.score DESC) AS candidates
                FROM (
                    SELECT c.id, c.full_name, c.date_of_birth, c.team_id,
                           CASE WHEN public.normalize_athlete_name(c.full_name) = public.normalize_athlete_name(r.athlete_name)
                                THEN 1.0
                                ELSE extensions.similarity(public.normalize_athlete_name(c.full_name),
                                                           public.normalize_athlete_name(r.athlete_name))
                           END
                           + CASE WHEN c.date_of_birth = r.birth_date THEN 0.5 ELSE 0 END AS score
                      FROM public.children c
                     WHERE c.school_id = r.school_id
                       AND c.parent_id IS NULL
                       AND c.is_active
                       AND (   public.normalize_athlete_name(c.full_name) = public.normalize_athlete_name(r.athlete_name)
                            OR public.nombre_es_prefijo(c.full_name, r.athlete_name)   -- simétrica
                            OR extensions.similarity(public.normalize_athlete_name(c.full_name),
                                                     public.normalize_athlete_name(r.athlete_name)) >= 0.45)
                     ORDER BY score DESC
                     LIMIT 5
                ) k
                LEFT JOIN public.teams kt ON kt.id = k.team_id
          ) cand ON r.status = 'pending' AND r.for_whom = 'child'
         WHERE r.school_id = p_school_id
           AND (   r.status = 'pending'
                OR (r.status IN ('assigned', 'linked') AND r.enrollment_id IS NULL AND r.assigned_team_id IS NOT NULL)
                OR (p_include_resolved AND r.resolved_at > now() - interval '30 days'))
      ) x;

    RETURN v_rows;
END;
$$;

-- Resolver una solicitud. SOLO administración (D3). Transaccional y con la
-- solicitud bloqueada FOR UPDATE: dos admins a la vez → el segundo recibe
-- «ya fue resuelta» (55000), nunca dos fichas.
--   assign: crea la ficha (child, parent_id = quien pidió) — o adopta la que la
--           familia ya tenía en su cuenta sin escuela — o la membresía de
--           atleta (self). NO crea inscripción ni cobro.
--   link:   pone parent_id en una ficha existente de la escuela sin acudiente.
--   reject: solo cambia el estado.
-- Devuelve needs_enrollment = true cuando falta llamar a students/create-one.
CREATE OR REPLACE FUNCTION public.resolve_school_join_request(
    p_request_id uuid,
    p_action     text,
    p_team_id    uuid DEFAULT NULL,
    p_branch_id  uuid DEFAULT NULL,
    p_child_id   uuid DEFAULT NULL,
    p_reason     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid         uuid := auth.uid();
    v_school_id   uuid;
    r             public.school_join_requests;
    v_team_id     uuid;
    v_team_name   text;
    v_team_branch uuid;
    v_branch      uuid;
    v_child       uuid;
    v_c           record;
    v_status      text;
    v_needs       boolean := false;
    v_school_name text;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('assign', 'link', 'reject') THEN
        RAISE EXCEPTION 'Acción inválida.' USING ERRCODE = '22023';
    END IF;

    -- Permiso ANTES de bloquear la fila.
    SELECT school_id INTO v_school_id FROM public.school_join_requests WHERE id = p_request_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.is_super_admin() OR v_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo la administración de la escuela puede asignar o rechazar solicitudes.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.school_join_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status <> 'pending' THEN
        RAISE EXCEPTION 'Esta solicitud ya fue resuelta por otra persona. Actualiza la bandeja.'
            USING ERRCODE = '55000';
    END IF;

    SELECT s.name INTO v_school_name FROM public.schools s WHERE s.id = r.school_id;

    -- ── Rechazar ────────────────────────────────────────────────────────────
    IF p_action = 'reject' THEN
        UPDATE public.school_join_requests
           SET status = 'rejected', resolved_by = v_uid, resolved_at = now(),
               reject_reason = NULLIF(left(btrim(coalesce(p_reason, '')), 300), '')
         WHERE id = r.id;

        INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
        VALUES (r.requester_profile_id, r.school_id,
                format('%s no aprobó la solicitud', v_school_name),
                CASE WHEN NULLIF(btrim(coalesce(p_reason, '')), '') IS NULL
                     THEN format('La solicitud para %s no fue aprobada. Si crees que es un error, habla con la escuela.', r.athlete_name)
                     ELSE format('La solicitud para %s no fue aprobada. Motivo: %s', r.athlete_name, left(btrim(p_reason), 300))
                END,
                'warning', '/dashboard', 'enrollment',
                jsonb_build_object('kind', 'school_join_request', 'join_request_id', r.id, 'status', 'rejected'));

        RETURN jsonb_build_object('request_id', r.id, 'status', 'rejected', 'school_id', r.school_id,
                                  'needs_enrollment', false);
    END IF;

    -- ── Equipo y sede (D2: la sede se elige aquí) ───────────────────────────
    IF p_team_id IS NOT NULL THEN
        SELECT t.id, t.name, t.branch_id INTO v_team_id, v_team_name, v_team_branch
          FROM public.teams t WHERE t.id = p_team_id AND t.school_id = r.school_id;
        IF v_team_id IS NULL THEN
            RAISE EXCEPTION 'El equipo elegido no es de esta escuela.' USING ERRCODE = '22023';
        END IF;
    ELSIF p_action = 'assign' THEN
        RAISE EXCEPTION 'Elige el equipo (categoría) para asignar.' USING ERRCODE = '22023';
    END IF;

    IF p_branch_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.school_branches b WHERE b.id = p_branch_id AND b.school_id = r.school_id
    ) THEN
        RAISE EXCEPTION 'La sede elegida no es de esta escuela.' USING ERRCODE = '22023';
    END IF;
    v_branch := coalesce(p_branch_id, v_team_branch);

    -- ── Vincular a una ficha existente ──────────────────────────────────────
    IF p_action = 'link' THEN
        IF r.for_whom <> 'child' THEN
            RAISE EXCEPTION 'Solo se vincula a una ficha cuando la solicitud es de un acudiente para su hijo(a).'
                USING ERRCODE = '22023';
        END IF;
        IF p_child_id IS NULL THEN
            RAISE EXCEPTION 'Elige la ficha que quieres vincular.' USING ERRCODE = '22023';
        END IF;

        SELECT c.id, c.parent_id, c.school_id INTO v_c
          FROM public.children c WHERE c.id = p_child_id FOR UPDATE;
        IF v_c.id IS NULL OR v_c.school_id IS DISTINCT FROM r.school_id THEN
            RAISE EXCEPTION 'Esa ficha no es de esta escuela.' USING ERRCODE = '22023';
        END IF;
        IF v_c.parent_id IS NOT NULL AND v_c.parent_id <> r.requester_profile_id THEN
            RAISE EXCEPTION 'Esa ficha ya tiene otro acudiente vinculado. Revísala antes de vincular.'
                USING ERRCODE = '23505';
        END IF;

        -- parent_id dispara los triggers existentes: membresía de acudiente
        -- (auto_add_parent_to_school) y adopción de cobros sin pagador.
        UPDATE public.children
           SET parent_id = r.requester_profile_id,
               team_id   = coalesce(p_team_id, team_id),
               branch_id = coalesce(v_branch, branch_id)
         WHERE id = p_child_id;

        v_child  := p_child_id;
        v_status := 'linked';

    -- ── Asignar ─────────────────────────────────────────────────────────────
    ELSIF r.for_whom = 'child' THEN
        -- ¿La familia ya tenía esta ficha en su cuenta, sin escuela o en esta
        -- escuela? Se adopta: crear otra sería el duplicado de siempre.
        SELECT c.id INTO v_child
          FROM public.children c
         WHERE c.parent_id = r.requester_profile_id
           AND public.normalize_athlete_name(c.full_name) = public.normalize_athlete_name(r.athlete_name)
           AND (c.school_id IS NULL OR c.school_id = r.school_id)
         ORDER BY (c.school_id IS NOT NULL) DESC, c.created_at
         LIMIT 1
         FOR UPDATE;

        IF v_child IS NULL AND EXISTS (
            SELECT 1 FROM public.children c
             WHERE c.parent_id = r.requester_profile_id
               AND public.normalize_athlete_name(c.full_name) = public.normalize_athlete_name(r.athlete_name)
               AND c.school_id IS NOT NULL AND c.school_id <> r.school_id
        ) THEN
            RAISE EXCEPTION 'Esa familia ya tiene a % registrado(a) en otra escuela. Escríbenos a soporte para unirlo(a) también aquí sin duplicar su ficha.', r.athlete_name
                USING ERRCODE = '23505';
        END IF;

        IF v_child IS NOT NULL THEN
            UPDATE public.children
               SET school_id = r.school_id,
                   branch_id = coalesce(v_branch, branch_id),
                   team_id   = p_team_id,
                   is_active = true
             WHERE id = v_child;
        ELSE
            -- Los triggers de children siguen activos a propósito
            -- (bloquear_atleta_duplicado, guard de alta manual): si la escuela ya
            -- tiene esa persona, el error sugiere vincular en vez de duplicar.
            INSERT INTO public.children
                (full_name, date_of_birth, parent_id, school_id, branch_id, team_id,
                 medical_info, is_active, is_demo)
            VALUES
                (r.athlete_name, r.birth_date, r.requester_profile_id, r.school_id, v_branch, p_team_id,
                 '{"has_allergies": false}', true, false)
            RETURNING id INTO v_child;
        END IF;
        v_status := 'assigned';

    ELSE  -- self
        INSERT INTO public.school_members AS sm (profile_id, school_id, role, status, branch_id, joined_at)
        VALUES (r.requester_profile_id, r.school_id, 'athlete', 'active', v_branch, now())
        ON CONFLICT (profile_id, school_id) DO UPDATE
           SET status    = 'active',
               branch_id = coalesce(sm.branch_id, EXCLUDED.branch_id)
         WHERE sm.status <> 'active'
           AND sm.role IN ('athlete', 'parent');
        v_status := 'assigned';
    END IF;

    -- ¿Falta la inscripción? Solo si hay equipo y el deportista no tiene ya una
    -- inscripción activa/pendiente en ese equipo.
    v_needs := p_team_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.enrollments e
         WHERE e.school_id = r.school_id
           AND e.status IN ('active', 'pending')
           AND e.team_id = p_team_id
           AND (   (v_child IS NOT NULL AND e.child_id = v_child)
                OR (r.for_whom = 'self' AND e.user_id = r.requester_profile_id))
    );

    UPDATE public.school_join_requests
       SET status             = v_status,
           assigned_team_id   = p_team_id,
           assigned_branch_id = v_branch,
           child_id           = v_child,
           resolved_by        = v_uid,
           resolved_at        = now()
     WHERE id = r.id;

    INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
    VALUES (r.requester_profile_id, r.school_id,
            format('¡Bienvenido(a) a %s!', v_school_name),
            CASE WHEN v_team_name IS NOT NULL
                 THEN format('%s ya quedó en %s. La escuela te contará horarios y pagos.', r.athlete_name, v_team_name)
                 ELSE format('%s ya quedó unido(a) a la escuela.', r.athlete_name)
            END,
            'success', CASE WHEN r.for_whom = 'child' THEN '/children' ELSE '/dashboard' END, 'enrollment',
            jsonb_build_object('kind', 'school_join_request', 'join_request_id', r.id, 'status', v_status));

    RETURN jsonb_build_object(
        'request_id',       r.id,
        'status',           v_status,
        'for_whom',         r.for_whom,
        'school_id',        r.school_id,
        'child_id',         v_child,
        'user_id',          CASE WHEN r.for_whom = 'self' THEN r.requester_profile_id END,
        'team_id',          p_team_id,
        'branch_id',        v_branch,
        'athlete_name',     r.athlete_name,
        'needs_enrollment', v_needs
    );
END;
$$;

-- Después de que students/create-one creó la inscripción: la amarra a la
-- solicitud (sale de la bandeja). Idempotente; si no la encuentra, devuelve null.
CREATE OR REPLACE FUNCTION public.confirm_school_join_request_enrollment(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_school_id uuid;
    r           public.school_join_requests;
    v_enr       uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    SELECT school_id INTO v_school_id FROM public.school_join_requests WHERE id = p_request_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.is_super_admin() OR v_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.school_join_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status NOT IN ('assigned', 'linked') THEN
        RAISE EXCEPTION 'La solicitud no está asignada.' USING ERRCODE = '55000';
    END IF;
    IF r.enrollment_id IS NOT NULL THEN
        RETURN jsonb_build_object('request_id', r.id, 'enrollment_id', r.enrollment_id);
    END IF;

    SELECT e.id INTO v_enr
      FROM public.enrollments e
     WHERE e.school_id = r.school_id
       AND e.status IN ('active', 'pending')
       AND (r.assigned_team_id IS NULL OR e.team_id = r.assigned_team_id)
       AND (   (r.child_id IS NOT NULL AND e.child_id = r.child_id)
            OR (r.for_whom = 'self' AND e.user_id = r.requester_profile_id))
     ORDER BY e.created_at DESC
     LIMIT 1;

    IF v_enr IS NOT NULL THEN
        UPDATE public.school_join_requests SET enrollment_id = v_enr WHERE id = r.id;
    END IF;

    RETURN jsonb_build_object('request_id', r.id, 'enrollment_id', v_enr);
END;
$$;

-- Código activo de la escuela (lo crea si la escuela es posterior al backfill).
CREATE OR REPLACE FUNCTION public.get_school_join_code(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.school_join_codes;
BEGIN
    IF v_uid IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo la administración de la escuela ve su código.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.school_join_codes WHERE school_id = p_school_id AND active;
    IF v_row.id IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('school_join_code:' || p_school_id::text, 0));
        SELECT * INTO v_row FROM public.school_join_codes WHERE school_id = p_school_id AND active;
        IF v_row.id IS NULL THEN
            v_row := public._create_school_join_code(p_school_id, v_uid);
        END IF;
    END IF;

    RETURN jsonb_build_object('code', v_row.code, 'uses_count', v_row.uses_count, 'created_at', v_row.created_at);
END;
$$;

-- «Cambiar código» (D5: no vence, pero se puede cambiar). El anterior deja de servir.
CREATE OR REPLACE FUNCTION public.rotate_school_join_code(p_school_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_row public.school_join_codes;
BEGIN
    IF v_uid IS NULL
       OR NOT (public.is_super_admin() OR p_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo la administración de la escuela puede cambiar el código.' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('school_join_code:' || p_school_id::text, 0));

    UPDATE public.school_join_codes
       SET active = false, revoked_at = now(), revoked_by = v_uid
     WHERE school_id = p_school_id AND active;

    v_row := public._create_school_join_code(p_school_id, v_uid);

    RETURN jsonb_build_object('code', v_row.code, 'uses_count', v_row.uses_count, 'created_at', v_row.created_at);
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Privilegios de funciones
--    REVOKE de PUBLIC no alcanza: los default privileges dan EXECUTE a
--    authenticated/anon en cada función nueva. Se revoca explícito de los tres.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.normalize_school_join_code(text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._school_join_code_prefix(text)                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._generate_school_join_code(text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._create_school_join_code(uuid, uuid)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._school_join_code_rate_ok(uuid)               FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.preview_school_join_code(text)                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_school_join_request(text, text, text, date, text)     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_school_join_request(uuid)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_school_join_status()                                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_school_join_requests(uuid, boolean)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_school_join_request(uuid, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_school_join_request_enrollment(uuid)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_school_join_code(uuid)                                   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_school_join_code(uuid)                                FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.preview_school_join_code(text)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_school_join_request(text, text, text, date, text)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_school_join_request(uuid)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_school_join_status()                                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_join_requests(uuid, boolean)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_school_join_request(uuid, text, uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_school_join_request_enrollment(uuid)                 TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_school_join_code(uuid)                                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_school_join_code(uuid)                                TO authenticated;

-- -----------------------------------------------------------------------------
-- 7. Backfill: un código activo por cada escuela existente (~370 filas).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    s record;
BEGIN
    FOR s IN
        SELECT sc.id FROM public.schools sc
         WHERE NOT EXISTS (SELECT 1 FROM public.school_join_codes j
                            WHERE j.school_id = sc.id AND j.active)
    LOOP
        PERFORM public._create_school_join_code(s.id, NULL);
    END LOOP;
END $$;

COMMIT;

-- =============================================================================
-- PRUEBAS — correr DESPUÉS de aplicar, en el SQL editor (rol postgres).
-- Todo va dentro de BEGIN … ROLLBACK: no deja nada escrito.
-- Usa una escuela de PRUEBA (account_type = 'test') con dueño, equipo y coach,
-- y una cuenta parent sin escuela ni hijos. Cada DO lanza error si la prueba falla.
-- =============================================================================
/*
BEGIN;

-- 0. Actores (si alguna columna sale NULL, elegir otra escuela de prueba a mano)
SELECT set_config('t.school', s.id::text, true),
       set_config('t.admin',  s.owner_id::text, true),
       set_config('t.code',   (SELECT j.code FROM public.school_join_codes j WHERE j.school_id = s.id AND j.active), true),
       set_config('t.team',   (SELECT t.id::text FROM public.teams t WHERE t.school_id = s.id ORDER BY t.created_at LIMIT 1), true),
       set_config('t.coach',  (SELECT m.profile_id::text FROM public.school_members m
                                WHERE m.school_id = s.id AND m.role = 'coach' AND m.status = 'active'
                                  AND m.profile_id <> s.owner_id LIMIT 1), true)
  FROM public.schools s
 WHERE s.account_type = 'test' AND s.owner_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.teams t WHERE t.school_id = s.id)
   AND EXISTS (SELECT 1 FROM public.school_members m WHERE m.school_id = s.id AND m.role = 'coach'
                  AND m.status = 'active' AND m.profile_id <> s.owner_id)
 LIMIT 1;

SELECT set_config('t.parent', p.id::text, true)
  FROM public.profiles p
 WHERE p.role = 'parent'
   AND NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.profile_id = p.id)
   AND NOT EXISTS (SELECT 1 FROM public.children c WHERE c.parent_id = p.id)
 ORDER BY p.created_at DESC LIMIT 1;

SELECT set_config('t.otro', p.id::text, true)
  FROM public.profiles p
 WHERE p.id::text <> current_setting('t.parent')
   AND p.role::text NOT IN ('admin', 'super_admin')
   AND NOT EXISTS (SELECT 1 FROM public.school_members m WHERE m.profile_id = p.id
                     AND m.school_id = current_setting('t.school')::uuid)
   AND p.id::text <> current_setting('t.admin')
 ORDER BY p.created_at DESC LIMIT 1;

SELECT current_setting('t.school') school, current_setting('t.code') code, current_setting('t.team') team,
       current_setting('t.admin') admin, current_setting('t.coach') coach,
       current_setting('t.parent') parent, current_setting('t.otro') otro;

-- 1. Padre sin escuela: vista previa + envía la solicitud y la ve
SELECT set_config('role', 'authenticated', true),
       set_config('request.jwt.claims', json_build_object('sub', current_setting('t.parent'), 'role', 'authenticated')::text, true);
DO $$ DECLARE v jsonb; BEGIN
  v := public.preview_school_join_code(lower(substr(current_setting('t.code'),1,3)) || '-' || substr(current_setting('t.code'),4));
  IF NOT (v->>'ok')::boolean THEN RAISE EXCEPTION 'T1a FALLÓ: preview %', v; END IF;
  v := public.preview_school_join_code('ZZZ-2222');
  IF (v->>'ok')::boolean OR v->>'reason' <> 'not_found' THEN RAISE EXCEPTION 'T1b FALLÓ: código falso %', v; END IF;
  v := public.submit_school_join_request(current_setting('t.code'), 'child', 'Prueba Codigo Escuela', DATE '2010-05-01', 'Sub-16');
  IF NOT (v->>'ok')::boolean THEN RAISE EXCEPTION 'T1c FALLÓ: submit %', v; END IF;
  PERFORM set_config('t.req', v->>'request_id', true);
  IF (SELECT count(*) FROM public.school_join_requests WHERE id = (v->>'request_id')::uuid) <> 1 THEN
    RAISE EXCEPTION 'T1d FALLÓ: el padre no ve su solicitud'; END IF;
  BEGIN
    PERFORM public.submit_school_join_request(current_setting('t.code'), 'child', 'prueba  códigó escuela', DATE '2010-05-01', NULL);
    RAISE EXCEPTION 'T1e FALLÓ: aceptó una solicitud duplicada';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'T1e ok: %', SQLERRM; END;
  BEGIN
    INSERT INTO public.school_join_requests (school_id, requester_profile_id, for_whom, athlete_name)
    VALUES (current_setting('t.school')::uuid, current_setting('t.parent')::uuid, 'child', 'Directo');
    RAISE EXCEPTION 'T1f FALLÓ: el cliente pudo insertar directo';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T1f ok: sin INSERT directo'; END;
  RAISE NOTICE 'T1 ok: solicitud %', current_setting('t.req');
END $$;

-- 2. Otro usuario (sin relación con la escuela) no la ve ni ve el código
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('t.otro'), 'role', 'authenticated')::text, true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.school_join_requests WHERE id = current_setting('t.req')::uuid) <> 0 THEN
    RAISE EXCEPTION 'T2 FALLÓ: otro usuario ve la solicitud'; END IF;
  IF (SELECT count(*) FROM public.school_join_codes WHERE school_id = current_setting('t.school')::uuid) <> 0 THEN
    RAISE EXCEPTION 'T2 FALLÓ: otro usuario ve el código'; END IF;
  BEGIN
    PERFORM public.list_school_join_requests(current_setting('t.school')::uuid, false);
    RAISE EXCEPTION 'T2 FALLÓ: otro usuario lista la bandeja';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.cancel_school_join_request(current_setting('t.req')::uuid);
    RAISE EXCEPTION 'T2 FALLÓ: otro usuario canceló la solicitud ajena';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
  RAISE NOTICE 'T2 ok';
END $$;

-- 3. Coach: ve la bandeja (staff) pero NO puede resolver ni ver/cambiar el código
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('t.coach'), 'role', 'authenticated')::text, true);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.school_join_requests WHERE id = current_setting('t.req')::uuid) <> 1 THEN
    RAISE EXCEPTION 'T3 FALLÓ: el coach (staff) no ve la solicitud'; END IF;
  BEGIN
    PERFORM public.resolve_school_join_request(current_setting('t.req')::uuid, 'assign', current_setting('t.team')::uuid);
    RAISE EXCEPTION 'T3 FALLÓ: el coach pudo resolver';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T3a ok: %', SQLERRM; END;
  BEGIN
    PERFORM public.rotate_school_join_code(current_setting('t.school')::uuid);
    RAISE EXCEPTION 'T3 FALLÓ: el coach pudo cambiar el código';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T3b ok'; END;
  RAISE NOTICE 'T3 ok';
END $$;

-- 4. Admin resuelve: ficha creada con parent_id = el padre, SIN inscripción ni cobro
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
DO $$ DECLARE v jsonb; v_child uuid; BEGIN
  v := public.list_school_join_requests(current_setting('t.school')::uuid, false);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'id' = current_setting('t.req')) THEN
    RAISE EXCEPTION 'T4a FALLÓ: la bandeja no trae la solicitud'; END IF;
  v := public.resolve_school_join_request(current_setting('t.req')::uuid, 'assign', current_setting('t.team')::uuid);
  v_child := (v->>'child_id')::uuid;
  IF v->>'status' <> 'assigned' OR v_child IS NULL OR NOT (v->>'needs_enrollment')::boolean THEN
    RAISE EXCEPTION 'T4b FALLÓ: %', v; END IF;
  PERFORM set_config('t.child', v_child::text, true);
  RAISE NOTICE 'T4 ok: %', v;
END $$;

-- 5. Doble resolve: el segundo falla limpio (55000), no crea otra ficha
DO $$ BEGIN
  PERFORM public.resolve_school_join_request(current_setting('t.req')::uuid, 'assign', current_setting('t.team')::uuid);
  RAISE EXCEPTION 'T5 FALLÓ: se resolvió dos veces';
EXCEPTION WHEN object_not_in_prerequisite_state THEN RAISE NOTICE 'T5 ok: %', SQLERRM;
END $$;

-- 4c/5b. Verificación como postgres
SELECT set_config('role', 'postgres', true);
SELECT (SELECT parent_id::text FROM public.children WHERE id = current_setting('t.child')::uuid) = current_setting('t.parent') AS t4c_parent_ok,
       (SELECT count(*) FROM public.children WHERE parent_id = current_setting('t.parent')::uuid) = 1        AS t5b_una_sola_ficha,
       (SELECT count(*) FROM public.enrollments WHERE child_id = current_setting('t.child')::uuid) = 0       AS t4d_sin_inscripcion,
       (SELECT count(*) FROM public.payments    WHERE child_id = current_setting('t.child')::uuid) = 0       AS t4e_sin_cobro,
       EXISTS (SELECT 1 FROM public.school_members WHERE profile_id = current_setting('t.parent')::uuid
                 AND school_id = current_setting('t.school')::uuid AND role = 'parent')                    AS t4f_padre_miembro,
       (SELECT count(*) FROM public.notifications WHERE data->>'join_request_id' = current_setting('t.req')) >= 2 AS t4g_avisos;

-- 6. anon no ejecuta nada ni lee nada
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,          -- esperado: false en TODAS
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec  -- true solo en las 9 RPC públicas
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('normalize_school_join_code','_school_join_code_prefix','_generate_school_join_code',
                     '_create_school_join_code','_school_join_code_rate_ok','preview_school_join_code',
                     'submit_school_join_request','cancel_school_join_request','my_school_join_status',
                     'list_school_join_requests','resolve_school_join_request',
                     'confirm_school_join_request_enrollment','get_school_join_code','rotate_school_join_code')
 ORDER BY 1;
SELECT has_table_privilege('anon', 'public.school_join_codes', 'SELECT')            AS anon_codes,     -- false
       has_table_privilege('anon', 'public.school_join_requests', 'SELECT')         AS anon_requests,  -- false
       has_table_privilege('authenticated', 'public.school_join_requests', 'INSERT') AS auth_insert,   -- false
       has_table_privilege('authenticated', 'public.school_join_code_attempts', 'SELECT') AS auth_attempts; -- false
SELECT set_config('role', 'anon', true), set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$ BEGIN
  PERFORM public.preview_school_join_code('ABC-2345');
  RAISE EXCEPTION 'T6 FALLÓ: anon ejecutó preview';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'T6 ok: %', SQLERRM;
END $$;

ROLLBACK;

-- 7. Concurrencia real del FOR UPDATE (opcional, DOS pestañas del SQL editor, sin COMMIT):
--    Pestaña A: BEGIN; <bloque 0 + 1 + set claims del admin>; SELECT public.resolve_school_join_request('<req>', 'assign', '<team>');
--               (NO cerrar la transacción)
--    Pestaña B: BEGIN; SET LOCAL lock_timeout = '3s'; <claims del admin>;
--               SELECT public.resolve_school_join_request('<req>', 'reject');
--               → debe esperar y fallar por lock_timeout (la fila está tomada por A). ROLLBACK;
--    Pestaña A: ROLLBACK;
--    (La solicitud solo existe dentro de A; para B usar una solicitud pending real de la escuela de prueba.)

-- 8. Después de aplicar: npm run seguridad:invariantes, y listar TODAS las policies:
--    select tablename, cmd, policyname, permissive, roles, qual, with_check
--      from pg_policies where tablename in ('school_join_codes','school_join_requests','school_join_code_attempts');
*/
