-- =============================================================================
-- 20261123115126_solicitudes_union_aprobacion_automatica.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-23   Versión anterior: 20261123112301
-- Objetivo: onboarding etapa 3 — solicitudes de unión por código de escuela.
--
--  1. Aprobación automática SOLO con coincidencia sin ambigüedad con una ficha ya
--     cargada por la escuela (criterio aprobado por producto el 23-nov-2026):
--       · correo de la cuenta confirmado;
--       · el solicitante escribió el documento (>= 5 dígitos);
--       · ese documento está en EXACTAMENTE UNA ficha de esa escuela (entre
--         unregistered_athletes y children, incluidas las ya vinculadas), y esa
--         ficha está activa y sin vincular;
--       · el nombre normalizado es igual y, si la ficha trae fecha de nacimiento,
--         es la misma;
--       · menor: el correo confirmado es el del acudiente de la ficha; si la ficha
--         no tiene correo de acudiente, basta lo anterior con fecha de nacimiento
--         en ambos lados. Adulto (para sí): el correo confirmado es el de la ficha.
--     Todo lo demás sigue manual, como hoy. La vinculación llama a
--     reclamar_ficha_por_codigo (mismos efectos y avisos) y la solicitud queda
--     'linked' con auto_approved = true para poder auditarla.
--  2. Columnas de marca para el aviso por WhatsApp y su recordatorio a las 24 h
--     (las llena el job del BFF con service_role).
--  3. my_school_join_status devuelve auto_approved y el WhatsApp de contacto de la
--     escuela (school_settings.whatsapp_number), solo de las solicitudes del propio
--     solicitante.
--
-- submit_school_join_request y my_school_join_status se reemiten desde la
-- definición VIVA (verificada igual a las migraciones 20261105212701 y
-- 20261026132948); solo cambia lo descrito. Firmas y permisos iguales.
-- Solo ALTER ... ADD COLUMN con default constante (sin reescribir la tabla).
-- =============================================================================

BEGIN;

ALTER TABLE public.school_join_requests
    ADD COLUMN IF NOT EXISTS auto_approved      boolean     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS wa_aviso_at        timestamptz NULL,
    ADD COLUMN IF NOT EXISTS wa_recordatorio_at timestamptz NULL;

COMMENT ON COLUMN public.school_join_requests.auto_approved IS
    'true = se vinculó sola por coincidencia sin ambigüedad con una ficha ya cargada (no pasó por la bandeja).';
COMMENT ON COLUMN public.school_join_requests.wa_aviso_at IS
    'Cuándo el job avisó por WhatsApp a la administración de esta solicitud pendiente.';
COMMENT ON COLUMN public.school_join_requests.wa_recordatorio_at IS
    'Cuándo el job mandó el recordatorio de las 24 h (una sola vez).';

-- Índice parcial para el job: solo pendientes a las que aún les falta un aviso.
CREATE INDEX IF NOT EXISTS idx_school_join_requests_avisos_pendientes
    ON public.school_join_requests (created_at)
    WHERE status = 'pending' AND (wa_aviso_at IS NULL OR wa_recordatorio_at IS NULL);

-- ── Coincidencia sin ambigüedad ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._join_request_auto_match(
    p_school_id uuid,
    p_uid       uuid,
    p_for_whom  text,
    p_name      text,
    p_birth     date,
    p_doc       text
)
RETURNS TABLE (ficha_id uuid, source text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_today date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_doc   text := public.normalize_doc_number(p_doc);
    v_email text;
    r       record;
    v_menor boolean;
BEGIN
    IF v_doc IS NULL OR length(v_doc) < 5 THEN RETURN; END IF;

    -- Solo un correo CONFIRMADO cuenta como prueba de identidad.
    SELECT lower(btrim(u.email)) INTO v_email
      FROM auth.users u
     WHERE u.id = p_uid AND u.email_confirmed_at IS NOT NULL;
    IF v_email IS NULL OR v_email = '' THEN RETURN; END IF;

    -- Todas las fichas de la escuela con ese documento, en cualquier estado:
    -- si hay más de una (o la única ya está vinculada), no es una coincidencia limpia.
    WITH cand AS (
        SELECT ua.id, 'unregistered_athlete'::text AS src, ua.full_name, ua.date_of_birth,
               lower(btrim(ua.email))          AS own_email,
               lower(btrim(ua.guardian_email)) AS guardian_email,
               (ua.guardian_email IS NOT NULL OR ua.guardian_phone IS NOT NULL OR ua.guardian_full_name IS NOT NULL) AS tiene_acudiente,
               (COALESCE(ua.is_active, true) AND ua.linked_profile_id IS NULL) AS disponible
          FROM public.unregistered_athletes ua
         WHERE ua.school_id = p_school_id
           AND public.normalize_doc_number(ua.doc_number) = v_doc
        UNION ALL
        SELECT c.id, 'children'::text, c.full_name, c.date_of_birth,
               NULL::text,
               lower(btrim(c.parent_email_temp)),
               true,
               (COALESCE(c.is_active, true) AND c.parent_id IS NULL)
          FROM public.children c
         WHERE c.school_id = p_school_id
           AND public.normalize_doc_number(c.doc_number) = v_doc
    )
    SELECT count(*) OVER () AS total, cand.* INTO r FROM cand LIMIT 1;

    IF NOT FOUND OR r.total <> 1 OR NOT r.disponible THEN RETURN; END IF;

    -- Nombre igual (normalizado) y, si la ficha trae fecha de nacimiento, la misma.
    IF public.normalize_athlete_name(p_name) IS DISTINCT FROM public.normalize_athlete_name(r.full_name) THEN RETURN; END IF;
    IF r.date_of_birth IS NOT NULL AND r.date_of_birth IS DISTINCT FROM p_birth THEN RETURN; END IF;

    -- Menor o adulto: igual que reclamar_ficha_por_codigo.
    v_menor := CASE
        WHEN r.date_of_birth IS NOT NULL THEN r.date_of_birth > (v_today - interval '18 years')::date
        ELSE r.tiene_acudiente
    END;

    IF p_for_whom = 'child' THEN
        IF NOT v_menor THEN RETURN; END IF;
        IF COALESCE(r.guardian_email, '') <> '' THEN
            -- La ficha tiene correo de acudiente: tiene que ser el de la cuenta.
            IF r.guardian_email <> v_email THEN RETURN; END IF;
        ELSE
            -- Sin correo de acudiente: se exige fecha de nacimiento en AMBOS lados.
            IF r.date_of_birth IS NULL OR p_birth IS NULL THEN RETURN; END IF;
        END IF;
    ELSIF p_for_whom = 'self' THEN
        IF v_menor OR r.src <> 'unregistered_athlete' THEN RETURN; END IF;
        IF COALESCE(r.own_email, '') <> v_email THEN RETURN; END IF;
    ELSE
        RETURN;
    END IF;

    ficha_id := r.id;
    source   := r.src;
    RETURN NEXT;
END;
$$;

-- Helper que solo llama otra función SECURITY DEFINER: lo ejecuta el dueño.
REVOKE ALL ON FUNCTION public._join_request_auto_match(uuid, uuid, text, text, date, text) FROM PUBLIC, anon, authenticated;

-- ── submit_school_join_request ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_school_join_request(
    p_code       text,
    p_for_whom   text,
    p_name       text,
    p_birth_date date,
    p_category   text DEFAULT NULL,
    p_doc_number text DEFAULT NULL,
    p_doc_type   text DEFAULT NULL
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
    v_doc         text;
    v_doc_type    text;
    v_ficha_id    uuid;
    v_ficha_src   text;
    v_claim       jsonb;
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

    -- Documento: opcional, pero si viene tiene que ser un número razonable.
    IF p_doc_number IS NOT NULL AND btrim(p_doc_number) <> '' THEN
        v_doc := public.normalize_doc_number(p_doc_number);
        IF v_doc IS NULL OR length(v_doc) < 5 OR length(v_doc) > 20 THEN
            RAISE EXCEPTION 'Revisa el número de documento del deportista.' USING ERRCODE = '22023';
        END IF;
    END IF;
    v_doc_type := CASE WHEN upper(btrim(coalesce(p_doc_type, ''))) IN ('TI', 'RC', 'CC', 'CE', 'PP', 'PAS')
                       THEN upper(btrim(p_doc_type)) ELSE NULL END;

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

    -- ── Aprobación automática (etapa 3 del onboarding, criterio aprobado 23-nov-2026) ──
    -- Solo con una coincidencia SIN ambigüedad con una ficha que la escuela ya cargó
    -- (ver _join_request_auto_match). Si algo no cuadra o falla, sigue el camino
    -- manual de siempre: la solicitud queda en «Por asignar».
    IF v_doc IS NOT NULL THEN
        SELECT m.ficha_id, m.source INTO v_ficha_id, v_ficha_src
          FROM public._join_request_auto_match(v_jc.school_id, v_uid, p_for_whom, v_name, p_birth_date, v_doc) m;
        IF v_ficha_id IS NOT NULL THEN
            BEGIN
                -- Mismos efectos que reclamar la ficha a mano: vincula, crea el miembro,
                -- avisa a los administradores y cuenta el uso del código.
                v_claim := public.reclamar_ficha_por_codigo(p_code, v_ficha_id, v_ficha_src, v_doc);
                INSERT INTO public.school_join_requests
                    (school_id, join_code_id, requester_profile_id, for_whom, athlete_name, birth_date,
                     suggested_category, athlete_doc_number, athlete_doc_type,
                     status, child_id, resolved_at, auto_approved)
                VALUES
                    (v_jc.school_id, v_jc.id, v_uid, p_for_whom, v_name, p_birth_date,
                     v_cat, v_doc, v_doc_type,
                     'linked', NULLIF(v_claim ->> 'child_id', '')::uuid, now(), true)
                RETURNING id INTO v_req_id;
                RETURN v_claim || jsonb_build_object('auto_approved', true, 'request_id', v_req_id);
            EXCEPTION WHEN OTHERS THEN
                -- Una carrera (otra cuenta reclamó la ficha) o cualquier otro fallo: manual.
                v_ficha_id := NULL;
            END;
        END IF;
    END IF;

    BEGIN
        INSERT INTO public.school_join_requests
            (school_id, join_code_id, requester_profile_id, for_whom, athlete_name, birth_date,
             suggested_category, athlete_doc_number, athlete_doc_type)
        VALUES
            (v_jc.school_id, v_jc.id, v_uid, p_for_whom, v_name, p_birth_date,
             v_cat, v_doc, v_doc_type)
        RETURNING id INTO v_req_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'Ya enviaste una solicitud para % a esta escuela. Está en revisión.', v_name
            USING ERRCODE = '23505';
    END;

    UPDATE public.school_join_codes SET uses_count = uses_count + 1 WHERE id = v_jc.id;

    SELECT s.name INTO v_school_name FROM public.schools s WHERE s.id = v_jc.school_id;
    SELECT coalesce(p.full_name, p.email, 'Una familia') INTO v_requester
      FROM public.profiles p WHERE p.id = v_uid;

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

REVOKE ALL ON FUNCTION public.submit_school_join_request(text, text, text, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_school_join_request(text, text, text, date, text, text, text) TO authenticated;

-- ── my_school_join_status ────────────────────────────────────────────────────
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
                       r.reject_reason, r.auto_approved, s.name AS school_name, s.logo_url, t.name AS team_name,
                       ss.whatsapp_number AS school_whatsapp
                  FROM public.school_join_requests r
                  JOIN public.schools s ON s.id = r.school_id
                  LEFT JOIN public.school_settings ss ON ss.school_id = r.school_id
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

REVOKE ALL ON FUNCTION public.my_school_join_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_school_join_status() TO authenticated;

COMMIT;
