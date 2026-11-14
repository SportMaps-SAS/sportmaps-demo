-- =============================================================================
-- 20261106000100_unirse_reclamar_y_vincular_con_valvula_y_rol.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05
--
-- Une dos arreglos que se pisaron entre sesiones:
--   · 20261105222237 (reclamar_ficha_exime_guard_duplicado): válvula
--     sportmaps.alta_hijo_desde_rpc alrededor del INSERT de children en
--     reclamar_ficha_por_codigo, para que bloquear_atleta_duplicado no trate la
--     ficha que se adopta como duplicada («Ya existe una ficha de … pendiente de vincular»).
--   · 20261105212701 (solicitud_unirse_con_documento): _asegurar_rol_acudiente
--     (un deportista con matrícula propia conserva su rol al reclamar a su hijo).
-- 212701 se aplicó DESPUÉS de 222237 y dejó viva la versión sin la válvula.
-- Esta migración deja reclamar_ficha_por_codigo con AMBAS cosas y le pone la misma
-- válvula a vincular_solicitud_a_ficha (que inserta el hijo con la misma forma).
-- Solo cambian esas dos funciones; firmas y permisos iguales.
-- =============================================================================

BEGIN;

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

            -- La ficha que se adopta ES la «duplicada» que bloquear_atleta_duplicado frena (mismo documento, sin vincular).
            -- Se declara el alta como hecha desde RPC (igual que accept_invitation_pro); is_local=true la limita a esta transacción.
            PERFORM set_config('sportmaps.alta_hijo_desde_rpc', 'on', true);
            INSERT INTO public.children (parent_id, school_id, branch_id, full_name, date_of_birth, doc_type, doc_number, gender, is_active)
            VALUES (v_uid, v_ua.school_id, v_ua.branch_id, v_ua.full_name, v_ua.date_of_birth, v_ua.doc_type, v_ua.doc_number, v_ua.gender, true)
            RETURNING id INTO v_child;
            PERFORM set_config('sportmaps.alta_hijo_desde_rpc', 'off', true);

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
        -- La ficha que se adopta ES la «duplicada» que bloquear_atleta_duplicado frena (mismo documento, sin vincular).
        -- Se declara el alta como hecha desde RPC (igual que accept_invitation_pro); is_local=true la limita a esta transacción.
        PERFORM set_config('sportmaps.alta_hijo_desde_rpc', 'on', true);
        INSERT INTO public.children (parent_id, school_id, branch_id, full_name, date_of_birth, doc_type, doc_number, gender, is_active)
        VALUES (r.requester_profile_id, v_ua.school_id, v_ua.branch_id, v_ua.full_name, v_ua.date_of_birth, v_ua.doc_type, v_ua.doc_number, v_ua.gender, true)
        RETURNING id INTO v_child;
        PERFORM set_config('sportmaps.alta_hijo_desde_rpc', 'off', true);
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

-- Firmas y GRANT sin cambios; se re-afirman por si los default privileges los tocaron.
REVOKE ALL ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.vincular_solicitud_a_ficha(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vincular_solicitud_a_ficha(uuid, uuid, text) TO authenticated;

COMMIT;
