-- =============================================================================
-- 20261105212701_solicitud_unirse_con_documento.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05
--
-- Objetivo: que la solicitud «Enviar mis datos» del enlace por código lleve el
-- DOCUMENTO del deportista y que la bandeja «Por asignar» sugiera la ficha por
-- DOCUMENTO o CORREO exactos. REGLA: la identidad se prueba solo con datos
-- únicos (documento, correo). El nombre NUNCA decide solo (homónimos, errores
-- de digitación → vínculo equivocado que nadie detecta).
--
-- Contenido:
--   1. school_join_requests: columnas athlete_doc_number / athlete_doc_type.
--   2. submit_school_join_request: acepta documento (misma firma + 2 parámetros
--      con DEFAULT NULL; se elimina la firma anterior).
--   3. list_school_join_requests: devuelve el documento y `exact_matches`
--      (fichas de import `unregistered_athletes` Y `children` huérfanas que
--      coinciden por documento o por el correo de quien pide). Los candidatos
--      por nombre siguen aparte (`candidates`), solo como pista.
--   4. vincular_solicitud_a_ficha: la administración vincula la solicitud a la
--      ficha. El SERVIDOR exige documento o correo exactos; no acepta
--      vincular solo por nombre.
--   5. _asegurar_rol_acudiente: quien reclama un hijo pasa a `parent` SOLO si no
--      es deportista con matrícula propia (deportista Y acudiente conserva su
--      rol; el selector de rol hace el resto).
--   6. reclamar_ficha_por_codigo (20261105124322): se reemplaza igual, cambiando
--      únicamente la actualización de rol (antes degradaba a `parent` a un
--      deportista adulto que reclamaba a su hijo).
-- Reglas del repo: SECURITY DEFINER con search_path fijo, GRANT EXECUTE explícito
-- solo a `authenticated`, alcance validado ADENTRO y atado a la escuela.
-- =============================================================================

BEGIN;

-- ── 1) Columnas ──────────────────────────────────────────────────────────────
ALTER TABLE public.school_join_requests
    ADD COLUMN IF NOT EXISTS athlete_doc_number text NULL,
    ADD COLUMN IF NOT EXISTS athlete_doc_type   text NULL;

COMMENT ON COLUMN public.school_join_requests.athlete_doc_number IS
    'Documento del deportista que escribió quien pidió (normalizado). Dato único para cruzar con la ficha; null si no lo tenía a la mano.';

-- ── 2) submit_school_join_request con documento ──────────────────────────────
DROP FUNCTION IF EXISTS public.submit_school_join_request(text, text, text, date, text);

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

-- ── 3) Rol de acudiente sin degradar al deportista ───────────────────────────
CREATE OR REPLACE FUNCTION public._asegurar_rol_acudiente(p_uid uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
    UPDATE public.profiles p
       SET role = 'parent'
     WHERE p.id = p_uid
       AND p.role NOT IN ('admin', 'school', 'school_admin', 'super_admin', 'organizer',
                          'coach', 'wellness_professional', 'store_owner')
       -- Un deportista con matrícula propia conserva su rol: es deportista Y acudiente.
       AND (p.role <> 'athlete' OR NOT EXISTS (
              SELECT 1 FROM public.enrollments e WHERE e.user_id = p_uid AND e.status IN ('active', 'pending')));
$$;

-- ── 4) reclamar_ficha_por_codigo: solo cambia la actualización de rol ────────
CREATE OR REPLACE FUNCTION public.reclamar_ficha_por_codigo(
    p_code      text,
    p_ficha_id  uuid,
    p_source    text,
    p_doc       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid     uuid := auth.uid();
    v_today   date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_code    text;
    v_jc      public.school_join_codes;
    v_doc     text := public.normalize_doc_number(p_doc);
    v_email   text;
    v_ua      public.unregistered_athletes;
    v_ch      public.children;
    v_menor   boolean;
    v_doc_ok  boolean;
    v_mail_ok boolean;
    v_child   uuid;
    v_migr    jsonb;
    v_name    text;
    v_school_name text;
    v_role_id uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para reclamar tu ficha.' USING ERRCODE = '42501';
    END IF;
    IF p_source NOT IN ('unregistered_athlete', 'children') THEN
        RAISE EXCEPTION 'Origen de ficha no válido.' USING ERRCODE = '22023';
    END IF;
    IF NOT public._school_join_code_rate_ok(v_uid) THEN
        RAISE EXCEPTION 'Hiciste demasiados intentos. Espera 15 minutos y vuelve a probar.' USING ERRCODE = 'P0001';
    END IF;

    v_code := public.normalize_school_join_code(p_code);
    SELECT * INTO v_jc FROM public.school_join_codes WHERE code = v_code AND active;
    IF v_jc.id IS NULL THEN
        RAISE EXCEPTION 'Ese código no existe o la escuela lo cambió.' USING ERRCODE = '22023';
    END IF;

    IF NOT COALESCE(public.school_is_operational(v_jc.school_id), false) THEN
        RAISE EXCEPTION 'Esta escuela no puede recibir inscripciones en este momento.' USING ERRCODE = '42501';
    END IF;

    SELECT lower(u.email) INTO v_email
      FROM auth.users u WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;

    SELECT s.name INTO v_school_name FROM public.schools s WHERE s.id = v_jc.school_id;

    -- ── Ficha del import (unregistered_athletes) ──────────────────────────────
    IF p_source = 'unregistered_athlete' THEN
        SELECT * INTO v_ua FROM public.unregistered_athletes
         WHERE id = p_ficha_id AND school_id = v_jc.school_id
           AND COALESCE(is_active, true) AND linked_profile_id IS NULL
         FOR UPDATE;
        IF v_ua.id IS NULL THEN
            RAISE EXCEPTION 'Esa ficha ya no está disponible — puede que alguien más la haya reclamado.' USING ERRCODE = '42501';
        END IF;

        v_menor := CASE
            WHEN v_ua.date_of_birth IS NOT NULL THEN v_ua.date_of_birth > (v_today - interval '18 years')::date
            ELSE (v_ua.guardian_email IS NOT NULL OR v_ua.guardian_phone IS NOT NULL OR v_ua.guardian_full_name IS NOT NULL)
        END;
        v_doc_ok  := v_doc IS NOT NULL AND length(v_doc) >= 5 AND public.normalize_doc_number(v_ua.doc_number) = v_doc;
        v_name    := v_ua.full_name;

        IF v_menor THEN
            v_mail_ok := v_email IS NOT NULL AND lower(btrim(v_ua.guardian_email)) = v_email;
            IF NOT (v_doc_ok OR v_mail_ok) THEN
                RAISE EXCEPTION 'No pudimos confirmar que esta ficha sea de tu hijo(a).' USING ERRCODE = '42501';
            END IF;

            -- Mismo alta de hijo que submit_qr_signup con ficha precargada.
            PERFORM public._asegurar_rol_acudiente(v_uid);

            INSERT INTO public.children (parent_id, school_id, branch_id, full_name, date_of_birth, doc_type, doc_number, gender, is_active)
            VALUES (v_uid, v_ua.school_id, v_ua.branch_id, v_ua.full_name, v_ua.date_of_birth, v_ua.doc_type, v_ua.doc_number, v_ua.gender, true)
            RETURNING id INTO v_child;

            v_migr := public.migrate_unregistered_athlete_to_profile(v_ua.id, NULL, v_child);

            INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
            VALUES (v_ua.school_id, v_uid, 'parent', 'active', v_ua.branch_id)
            ON CONFLICT (school_id, profile_id) DO NOTHING;
        ELSE
            -- ADULTO: el documento solo NO alcanza. Exige el correo confirmado.
            IF NOT (v_email IS NOT NULL AND lower(btrim(v_ua.email)) = v_email) THEN
                RAISE EXCEPTION 'El correo de tu cuenta no coincide con el que la escuela tiene en tu ficha. Envía una solicitud y la escuela te aprueba.'
                    USING ERRCODE = '42501';
            END IF;

            SELECT id INTO v_role_id FROM public.roles WHERE LOWER(name) = 'athlete' LIMIT 1;
            UPDATE public.profiles
               SET role = 'athlete'::public.user_role, role_id = COALESCE(v_role_id, role_id)
             WHERE id = v_uid AND role NOT IN ('admin','school','school_admin','super_admin','organizer','coach','wellness_professional','store_owner');

            v_migr := public.migrate_unregistered_athlete_to_profile(v_ua.id, v_uid, NULL);

            INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
            VALUES (v_ua.school_id, v_uid, 'athlete', 'active', v_ua.branch_id)
            ON CONFLICT (school_id, profile_id) DO NOTHING;
        END IF;

    -- ── Hijo precargado sin acudiente (children huérfano) ─────────────────────
    ELSE
        SELECT * INTO v_ch FROM public.children
         WHERE id = p_ficha_id AND school_id = v_jc.school_id
           AND COALESCE(is_active, true) AND parent_id IS NULL
         FOR UPDATE;
        IF v_ch.id IS NULL THEN
            RAISE EXCEPTION 'Esa ficha ya no está disponible — puede que alguien más la haya reclamado.' USING ERRCODE = '42501';
        END IF;
        v_doc_ok  := v_doc IS NOT NULL AND length(v_doc) >= 5 AND public.normalize_doc_number(v_ch.doc_number) = v_doc;
        v_mail_ok := v_email IS NOT NULL AND lower(btrim(v_ch.parent_email_temp)) = v_email;
        IF NOT (v_doc_ok OR v_mail_ok) THEN
            RAISE EXCEPTION 'No pudimos confirmar que esta ficha sea de tu hijo(a).' USING ERRCODE = '42501';
        END IF;
        v_name := v_ch.full_name;

        PERFORM public._asegurar_rol_acudiente(v_uid);

        UPDATE public.children
           SET parent_id = v_uid,
               parent_email_temp = COALESCE((SELECT lower(email) FROM auth.users WHERE id = v_uid), parent_email_temp),
               updated_at = now()
         WHERE id = v_ch.id;
        v_child := v_ch.id;

        INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
        VALUES (v_ch.school_id, v_uid, 'parent', 'active', v_ch.branch_id)
        ON CONFLICT (school_id, profile_id) DO NOTHING;
    END IF;

    -- Aviso a la administración (owner + admin activos), como el QR de inscripción.
    INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
    SELECT a.pid, v_jc.school_id, 'Ficha reclamada por enlace',
           v_name || ' se unió con el código de la escuela y adoptó su ficha precargada.',
           'success', '/students', 'enrollment',
           jsonb_build_object('kind', 'ficha_reclamada_por_codigo', 'ficha_id', p_ficha_id)
      FROM (
            SELECT s.owner_id AS pid FROM public.schools s WHERE s.id = v_jc.school_id AND s.owner_id IS NOT NULL
            UNION
            SELECT m.profile_id FROM public.school_members m
             WHERE m.school_id = v_jc.school_id AND m.status = 'active' AND m.role IN ('owner','admin','school_admin')
           ) a
     WHERE a.pid IS NOT NULL AND a.pid <> v_uid;

    UPDATE public.school_join_codes SET uses_count = uses_count + 1 WHERE id = v_jc.id;

    RETURN jsonb_build_object(
        'ok', true,
        'school_id', v_jc.school_id,
        'school_name', v_school_name,
        'kind', CASE WHEN v_child IS NOT NULL THEN 'child' ELSE 'self' END,
        'child_id', v_child,
        'athlete_name', v_name,
        'migrated', v_migr
    );
END;
$$;

-- ── 5) Bandeja: documento y coincidencias exactas ────────────────────────────
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
               r.requester_profile_id, r.athlete_doc_number, r.athlete_doc_type,
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
               coalesce(ex.exact_matches, '[]'::jsonb) AS exact_matches,
               coalesce(cand.candidates, '[]'::jsonb) AS candidates
          FROM public.school_join_requests r
          LEFT JOIN public.profiles p ON p.id = r.requester_profile_id
          LEFT JOIN public.teams t    ON t.id = r.assigned_team_id
          LEFT JOIN LATERAL (
              -- COINCIDENCIAS EXACTAS: fichas de la escuela sin cuenta que comparten el DOCUMENTO
              -- que escribió quien pide, o el CORREO de su cuenta. Es la única base para vincular.
              SELECT jsonb_agg(jsonb_build_object(
                         'id', m.id, 'source', m.source, 'full_name', m.full_name,
                         'team_name', m.team_name, 'basis', m.basis) ORDER BY m.ord) AS exact_matches
                FROM (
                    SELECT ua.id, 'unregistered_athlete'::text AS source, ua.full_name,
                           (SELECT t2.name FROM public.enrollments e2 JOIN public.teams t2 ON t2.id = e2.team_id
                             WHERE e2.unregistered_athlete_id = ua.id AND e2.status = 'active'
                             ORDER BY e2.created_at DESC LIMIT 1) AS team_name,
                           CASE WHEN r.athlete_doc_number IS NOT NULL
                                 AND public.normalize_doc_number(ua.doc_number) = r.athlete_doc_number
                                THEN 'documento' ELSE 'correo' END AS basis,
                           CASE WHEN r.athlete_doc_number IS NOT NULL
                                 AND public.normalize_doc_number(ua.doc_number) = r.athlete_doc_number THEN 0 ELSE 1 END AS ord
                      FROM public.unregistered_athletes ua
                     WHERE ua.school_id = r.school_id AND COALESCE(ua.is_active, true) AND ua.linked_profile_id IS NULL
                       AND (   (r.athlete_doc_number IS NOT NULL AND public.normalize_doc_number(ua.doc_number) = r.athlete_doc_number)
                            OR (p.email IS NOT NULL AND lower(btrim(CASE WHEN r.for_whom = 'child' THEN ua.guardian_email ELSE ua.email END)) = lower(btrim(p.email))))
                    UNION ALL
                    SELECT c2.id, 'children'::text, c2.full_name,
                           (SELECT t3.name FROM public.teams t3 WHERE t3.id = c2.team_id),
                           CASE WHEN r.athlete_doc_number IS NOT NULL
                                 AND public.normalize_doc_number(c2.doc_number) = r.athlete_doc_number
                                THEN 'documento' ELSE 'correo' END,
                           CASE WHEN r.athlete_doc_number IS NOT NULL
                                 AND public.normalize_doc_number(c2.doc_number) = r.athlete_doc_number THEN 0 ELSE 1 END
                      FROM public.children c2
                     WHERE r.for_whom = 'child' AND c2.school_id = r.school_id AND c2.parent_id IS NULL AND COALESCE(c2.is_active, true)
                       AND (   (r.athlete_doc_number IS NOT NULL AND public.normalize_doc_number(c2.doc_number) = r.athlete_doc_number)
                            OR (p.email IS NOT NULL AND lower(btrim(c2.parent_email_temp)) = lower(btrim(p.email))))
                ) m
          ) ex ON r.status = 'pending'
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

-- ── 6) Vincular una solicitud a una ficha (solo por documento o correo) ──────
CREATE OR REPLACE FUNCTION public.vincular_solicitud_a_ficha(
    p_request_id uuid,
    p_ficha_id   uuid,
    p_source     text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid       uuid := auth.uid();
    v_school_id uuid;
    r           public.school_join_requests;
    v_email     text;
    v_ua        public.unregistered_athletes;
    v_ch        public.children;
    v_menor     boolean;
    v_doc_ok    boolean;
    v_mail_ok   boolean;
    v_child     uuid;
    v_name      text;
    v_migr      jsonb;
    v_role_id   uuid;
    v_school_name text;
    v_today     date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'No autorizado.' USING ERRCODE = '42501';
    END IF;
    IF p_source IS NULL OR p_source NOT IN ('unregistered_athlete', 'children') THEN
        RAISE EXCEPTION 'Origen de ficha no válido.' USING ERRCODE = '22023';
    END IF;

    SELECT school_id INTO v_school_id FROM public.school_join_requests WHERE id = p_request_id;
    IF v_school_id IS NULL THEN
        RAISE EXCEPTION 'Solicitud no encontrada.' USING ERRCODE = 'P0002';
    END IF;
    IF NOT (public.is_super_admin() OR v_school_id = ANY (public.user_admin_school_ids())) THEN
        RAISE EXCEPTION 'Solo la administración de la escuela puede vincular solicitudes.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO r FROM public.school_join_requests WHERE id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status <> 'pending' THEN
        RAISE EXCEPTION 'Esta solicitud ya fue resuelta por otra persona. Actualiza la bandeja.' USING ERRCODE = '55000';
    END IF;

    SELECT lower(btrim(p.email)) INTO v_email FROM public.profiles p WHERE p.id = r.requester_profile_id;
    SELECT s.name INTO v_school_name FROM public.schools s WHERE s.id = r.school_id;

    IF p_source = 'unregistered_athlete' THEN
        SELECT * INTO v_ua FROM public.unregistered_athletes
         WHERE id = p_ficha_id AND school_id = r.school_id
           AND COALESCE(is_active, true) AND linked_profile_id IS NULL
         FOR UPDATE;
        IF v_ua.id IS NULL THEN
            RAISE EXCEPTION 'Esa ficha ya no está disponible o ya fue vinculada.' USING ERRCODE = '42501';
        END IF;
        v_name := v_ua.full_name;
        v_doc_ok := r.athlete_doc_number IS NOT NULL
                    AND public.normalize_doc_number(v_ua.doc_number) = r.athlete_doc_number;
        v_menor := CASE
            WHEN v_ua.date_of_birth IS NOT NULL THEN v_ua.date_of_birth > (v_today - interval '18 years')::date
            ELSE (v_ua.guardian_email IS NOT NULL OR v_ua.guardian_phone IS NOT NULL OR v_ua.guardian_full_name IS NOT NULL)
        END;
        v_mail_ok := v_email IS NOT NULL AND lower(btrim(CASE WHEN r.for_whom = 'child' THEN v_ua.guardian_email ELSE v_ua.email END)) = v_email;
    ELSE
        SELECT * INTO v_ch FROM public.children
         WHERE id = p_ficha_id AND school_id = r.school_id
           AND COALESCE(is_active, true) AND parent_id IS NULL
         FOR UPDATE;
        IF v_ch.id IS NULL THEN
            RAISE EXCEPTION 'Esa ficha ya no está disponible o ya tiene acudiente.' USING ERRCODE = '42501';
        END IF;
        IF r.for_whom <> 'child' THEN
            RAISE EXCEPTION 'Una ficha de menor solo se vincula a una solicitud de acudiente.' USING ERRCODE = '22023';
        END IF;
        v_name := v_ch.full_name;
        v_doc_ok := r.athlete_doc_number IS NOT NULL
                    AND public.normalize_doc_number(v_ch.doc_number) = r.athlete_doc_number;
        v_mail_ok := v_email IS NOT NULL AND lower(btrim(v_ch.parent_email_temp)) = v_email;
        v_menor := true;
    END IF;

    -- REGLA: solo documento o correo exactos. El nombre no alcanza.
    IF NOT (v_doc_ok OR v_mail_ok) THEN
        RAISE EXCEPTION 'No hay un dato único (documento o correo) que confirme que es la misma persona. Pídele a la familia el documento o vincula la ficha desde Editar atleta.'
            USING ERRCODE = '42501';
    END IF;

    IF r.for_whom = 'child' AND NOT v_menor AND p_source = 'unregistered_athlete' THEN
        RAISE EXCEPTION 'Esa ficha es de una persona mayor de edad: la solicitud debe ser «para mí».' USING ERRCODE = '22023';
    END IF;
    IF r.for_whom = 'self' AND v_menor AND p_source = 'unregistered_athlete' THEN
        RAISE EXCEPTION 'Esa ficha es de un menor: la solicitud debe ser de su acudiente.' USING ERRCODE = '22023';
    END IF;

    IF p_source = 'unregistered_athlete' AND r.for_whom = 'child' THEN
        PERFORM public._asegurar_rol_acudiente(r.requester_profile_id);
        INSERT INTO public.children (parent_id, school_id, branch_id, full_name, date_of_birth, doc_type, doc_number, gender, is_active)
        VALUES (r.requester_profile_id, v_ua.school_id, v_ua.branch_id, v_ua.full_name, v_ua.date_of_birth, v_ua.doc_type, v_ua.doc_number, v_ua.gender, true)
        RETURNING id INTO v_child;
        v_migr := public.migrate_unregistered_athlete_to_profile(v_ua.id, NULL, v_child);
        INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
        VALUES (v_ua.school_id, r.requester_profile_id, 'parent', 'active', v_ua.branch_id)
        ON CONFLICT (school_id, profile_id) DO NOTHING;
    ELSIF p_source = 'unregistered_athlete' THEN
        SELECT id INTO v_role_id FROM public.roles WHERE LOWER(name) = 'athlete' LIMIT 1;
        UPDATE public.profiles
           SET role = 'athlete'::public.user_role, role_id = COALESCE(v_role_id, role_id)
         WHERE id = r.requester_profile_id
           AND role NOT IN ('admin','school','school_admin','super_admin','organizer','coach','wellness_professional','store_owner');
        v_migr := public.migrate_unregistered_athlete_to_profile(v_ua.id, r.requester_profile_id, NULL);
        INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
        VALUES (v_ua.school_id, r.requester_profile_id, 'athlete', 'active', v_ua.branch_id)
        ON CONFLICT (school_id, profile_id) DO NOTHING;
    ELSE
        PERFORM public._asegurar_rol_acudiente(r.requester_profile_id);
        UPDATE public.children
           SET parent_id = r.requester_profile_id,
               parent_email_temp = COALESCE((SELECT lower(email) FROM auth.users WHERE id = r.requester_profile_id), parent_email_temp),
               updated_at = now()
         WHERE id = v_ch.id;
        v_child := v_ch.id;
        INSERT INTO public.school_members (school_id, profile_id, role, status, branch_id)
        VALUES (v_ch.school_id, r.requester_profile_id, 'parent', 'active', v_ch.branch_id)
        ON CONFLICT (school_id, profile_id) DO NOTHING;
    END IF;

    UPDATE public.school_join_requests
       SET status = 'linked', child_id = v_child, resolved_by = v_uid, resolved_at = now()
     WHERE id = r.id;

    INSERT INTO public.notifications (user_id, school_id, title, message, type, link, category, data)
    VALUES (r.requester_profile_id, r.school_id,
            format('%s aprobó tu solicitud', v_school_name),
            format('%s quedó vinculado(a) con sus datos en %s.', v_name, v_school_name),
            'success', '/dashboard', 'enrollment',
            jsonb_build_object('kind', 'school_join_request', 'join_request_id', r.id, 'status', 'linked'));

    RETURN jsonb_build_object('request_id', r.id, 'status', 'linked', 'school_id', r.school_id,
                              'child_id', v_child, 'athlete_name', v_name, 'migrated', v_migr,
                              'needs_enrollment', false);
END;
$$;

-- ── 7) Permisos ──────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.submit_school_join_request(text, text, text, date, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_school_join_request(text, text, text, date, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.vincular_solicitud_a_ficha(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vincular_solicitud_a_ficha(uuid, uuid, text) TO authenticated;

-- Helper interno: lo llaman solo las RPC DEFINER (ejecuta el dueño).
REVOKE ALL ON FUNCTION public._asegurar_rol_acudiente(uuid) FROM PUBLIC, anon, authenticated;

-- list y reclamar conservan firma y GRANT; se re-afirman por si el default privileges los tocó.
REVOKE ALL ON FUNCTION public.list_school_join_requests(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_school_join_requests(uuid, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.vincular_solicitud_a_ficha(uuid, uuid, text) IS
    'Administración: vincula una solicitud «Por asignar» a una ficha de la escuela. Exige documento o correo exactos; nunca solo el nombre. Reutiliza migrate_unregistered_athlete_to_profile.';

COMMIT;

-- =============================================================================
-- PRUEBAS (dentro de una transacción con ROLLBACK):
--   T1 submit con documento: la fila queda con athlete_doc_number normalizado.
--   T2 list: la solicitud trae exact_matches con basis 'documento' o 'correo'.
--   T3 vincular con ficha sin documento ni correo coincidente: 42501 «dato único».
--   T4 vincular con documento exacto: solicitud → linked, ficha is_active=false, hijo con acudiente.
--   T5 vincular como no-admin: 42501.
--   T6 deportista adulto con matrícula que reclama a su hijo: su rol SIGUE en athlete.
-- =============================================================================
