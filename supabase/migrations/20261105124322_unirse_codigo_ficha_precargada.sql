-- =============================================================================
-- 20261105124322_unirse_codigo_ficha_precargada.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-05
--
-- Objetivo: que el enlace único por escuela (/unirse?codigo=MON-Z2QB) encuentre
-- la FICHA que la escuela ya cargó (unregistered_athletes o children huérfanos)
-- y la adopte, en vez de dejar una solicitud en blanco en «Por asignar».
-- Sirve igual para cualquier escuela: todo cuelga del código, nada de Monster.
--
--   · MENOR  → el acudiente se identifica con el documento del menor (mismo
--     nivel de confianza que ya acepta el QR de inscripción, H-12) o con el
--     correo del acudiente que está en la ficha.
--   · ADULTO → SOLO si el correo (confirmado) de la cuenta es el de la ficha.
--     El documento solo NO basta: con la cédula de otra persona alguien se
--     quedaría con su plan y sus pagos. Sin coincidencia de correo, el flujo
--     cae a la solicitud manual de «Por asignar» (la aprueba un admin).
--
-- Reutiliza `migrate_unregistered_athlete_to_profile` (con sus fixes de
-- 20260909/20260915) y el mismo alta de hijo de submit_qr_signup. No toca
-- cobros: lo que la ficha ya tenía (inscripción, plan, pagos) se reata.
--
-- Dos RPC nuevas, ambas SECURITY DEFINER, search_path fijo, solo `authenticated`:
--   buscar_ficha_por_codigo(p_code, p_doc)             → candidatos, sin contacto
--   reclamar_ficha_por_codigo(p_code, p_ficha_id, p_source, p_doc)
-- La alcanzabilidad se valida ADENTRO y se ata a la escuela del código.
-- =============================================================================

BEGIN;

-- ── 1) Buscar ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.buscar_ficha_por_codigo(
    p_code text,
    p_doc  text DEFAULT NULL
)
RETURNS TABLE (
    ficha_id       uuid,
    source         text,     -- 'unregistered_athlete' | 'children'
    tipo           text,     -- 'menor' | 'adulto'
    nombre         text,     -- enmascarado: «Carlos S. D.»
    team_name      text,
    email_match    boolean,  -- el correo de la cuenta es el de la ficha
    puede_reclamar boolean   -- menor: sí; adulto: solo con email_match
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_uid    uuid := auth.uid();
    v_today  date := (now() AT TIME ZONE 'America/Bogota')::date;
    v_code   text;
    v_jc     public.school_join_codes;
    v_doc    text := public.normalize_doc_number(p_doc);
    v_email  text;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para buscar tu ficha.' USING ERRCODE = '42501';
    END IF;

    IF NOT public._school_join_code_rate_ok(v_uid) THEN
        RAISE EXCEPTION 'Hiciste demasiados intentos. Espera 15 minutos y vuelve a probar.' USING ERRCODE = 'P0001';
    END IF;

    v_code := public.normalize_school_join_code(p_code);
    SELECT * INTO v_jc FROM public.school_join_codes WHERE code = v_code AND active;
    IF v_jc.id IS NULL THEN
        INSERT INTO public.school_join_code_attempts (profile_id, success) VALUES (v_uid, false);
        RAISE EXCEPTION 'Ese código no existe o la escuela lo cambió.' USING ERRCODE = '22023';
    END IF;

    -- Solo un correo CONFIRMADO cuenta como prueba de identidad.
    SELECT lower(u.email) INTO v_email
      FROM auth.users u
     WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;

    IF (v_doc IS NULL OR length(v_doc) < 5) AND v_email IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH cand AS (
        SELECT ua.id,
               'unregistered_athlete'::text AS source,
               ua.full_name,
               ua.date_of_birth,
               (ua.guardian_email IS NOT NULL OR ua.guardian_phone IS NOT NULL OR ua.guardian_full_name IS NOT NULL) AS tiene_acudiente,
               (v_email IS NOT NULL AND lower(btrim(ua.email)) = v_email)                   AS email_propio,
               (v_email IS NOT NULL AND lower(btrim(ua.guardian_email)) = v_email)          AS email_acudiente,
               (v_doc IS NOT NULL AND length(v_doc) >= 5
                  AND public.normalize_doc_number(ua.doc_number) = v_doc)                    AS doc_ok,
               (SELECT t.name FROM public.enrollments e
                  JOIN public.teams t ON t.id = e.team_id
                 WHERE e.unregistered_athlete_id = ua.id AND e.status = 'active'
                 ORDER BY e.created_at DESC LIMIT 1)                                         AS team_name
          FROM public.unregistered_athletes ua
         WHERE ua.school_id = v_jc.school_id
           AND COALESCE(ua.is_active, true)
           AND ua.linked_profile_id IS NULL
        UNION ALL
        SELECT c.id,
               'children'::text,
               c.full_name,
               c.date_of_birth,
               true,
               false,
               (v_email IS NOT NULL AND lower(btrim(c.parent_email_temp)) = v_email),
               (v_doc IS NOT NULL AND length(v_doc) >= 5
                  AND public.normalize_doc_number(c.doc_number) = v_doc),
               (SELECT t.name FROM public.teams t WHERE t.id = c.team_id)
          FROM public.children c
         WHERE c.school_id = v_jc.school_id
           AND COALESCE(c.is_active, true)
           AND c.parent_id IS NULL
    ), clasif AS (
        SELECT cand.*,
               CASE
                 WHEN cand.date_of_birth IS NOT NULL THEN
                      CASE WHEN cand.date_of_birth > (v_today - interval '18 years')::date THEN 'menor' ELSE 'adulto' END
                 WHEN cand.tiene_acudiente THEN 'menor'
                 ELSE 'adulto'
               END AS tipo
          FROM cand
    )
    SELECT k.id,
           k.source,
           k.tipo,
           (split_part(btrim(k.full_name), ' ', 1)
             || COALESCE((SELECT string_agg(' ' || left(w, 1) || '.', '')
                            FROM unnest(string_to_array(btrim(k.full_name), ' ')) WITH ORDINALITY AS t(w, i)
                           WHERE i > 1 AND w <> ''), '')),
           k.team_name,
           (k.email_propio OR k.email_acudiente),
           CASE WHEN k.tipo = 'menor' THEN true ELSE k.email_propio END
      FROM clasif k
     WHERE k.doc_ok OR k.email_propio OR k.email_acudiente
     ORDER BY k.full_name
     LIMIT 10;

    -- RETURN QUERY deja FOUND = true si devolvió filas. Un intento sin
    -- resultado cuenta para el freno; uno exitoso no.
    INSERT INTO public.school_join_code_attempts (profile_id, success) VALUES (v_uid, FOUND);
END;
$$;

-- ── 2) Reclamar ──────────────────────────────────────────────────────────────
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
            UPDATE public.profiles SET role = 'parent'
             WHERE id = v_uid AND role NOT IN ('admin','school','school_admin','super_admin','organizer','coach','wellness_professional','store_owner');

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

        UPDATE public.profiles SET role = 'parent'
         WHERE id = v_uid AND role NOT IN ('admin','school','school_admin','super_admin','organizer','coach','wellness_professional','store_owner');

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

-- ── 3) Permisos ──────────────────────────────────────────────────────────────
-- Los default privileges dan EXECUTE a anon/authenticated: se revoca explícito.
REVOKE ALL ON FUNCTION public.buscar_ficha_por_codigo(text, text)                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.buscar_ficha_por_codigo(text, text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) TO authenticated;

COMMENT ON FUNCTION public.buscar_ficha_por_codigo(text, text) IS
    'Candidatos de ficha precargada de la escuela del código, por documento o por correo confirmado de la cuenta. Sin datos de contacto. Con freno compartido con submit_school_join_request.';
COMMENT ON FUNCTION public.reclamar_ficha_por_codigo(text, uuid, text, text) IS
    'Adopta una ficha precargada. Menor: documento o correo del acudiente. Adulto: SOLO correo confirmado igual al de la ficha. Reutiliza migrate_unregistered_athlete_to_profile.';

COMMIT;

-- =============================================================================
-- PRUEBAS (NO corren solas; ejecutar dentro de una transacción con ROLLBACK):
--   T1 menor por documento:  set_config('request.jwt.claims', json_build_object('sub','<uuid acudiente>')::text, true);
--        select * from buscar_ficha_por_codigo('MONZ2QB','<doc menor>');   -- tipo=menor, puede_reclamar=true
--   T2 adulto solo con documento: puede_reclamar=false y reclamar_* debe lanzar 42501.
--   T3 adulto con correo confirmado igual al de la ficha: reclamar_* devuelve ok y deja UNA inscripción
--      (la original, con su start_date viejo), ficha is_active=false y linked_profile_id=<uid>.
--   T4 ficha con inscripción activa del MISMO plan: sobrevive una sola fila (caso del bug 23505).
--   T5 sin sesión (anon): ambas RPC deben dar 42501/permission denied.
--   T6 código de otra escuela con ficha ajena: 'Esa ficha ya no está disponible'.
-- =============================================================================
