-- =============================================================================
-- 20261124152343_constancias_folio_privacidad_avisos_y_carnet.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-24   Versión anterior: 20261124113656
-- Objetivo: dejar operable el módulo de Constancias (0 plantillas y 0 constancias
-- en toda la base al 2026-11-24: nunca se usó) y cerrar el último hueco de
-- Carnets. Todo se reescribe sobre el cuerpo VIVO (leído con pg_proc el
-- 2026-11-24; coincide con 20260424000004 + los envoltorios de prueba de
-- 20260921204955).
--
-- 1) Folio repetido entre escuelas (rompía la solicitud). El folio era
--    UPPER(8 primeras letras del slug)-AÑO-N y folio es UNIQUE global: 77
--    escuelas empiezan por «ESCUELA-», 10 por «CLUB-DEP» (Besser incluida), 44
--    por «INSTITUT»… Desde la segunda escuela de cada grupo, pedir una
--    constancia fallaba SIEMPRE con unique_violation. Además COUNT(*)+1 chocaba
--    con dos solicitudes simultáneas. Ahora: tabla certificate_folio_counters
--    (prefijo ÚNICO por escuela + consecutivo por año, con candado), folio
--    «{PREFIJO}-{AÑO}-{00001}». Prefijo = iniciales del slug («club-deportivo-
--    besser» → CDB); si otra escuela ya lo tiene, se le suman caracteres de un
--    hash del id de la escuela (CDB3F…).
--
-- 2) Datos del PDF vacíos. 268 de 1.266 menores no tienen children.team_id y
--    836 de 1.627 inscripciones activas no tienen expires_at ni end_date → la
--    plantilla por defecto decía «inscrito en el equipo  … vigente hasta .».
--    _build_certificate_snapshot ahora toma el equipo de la inscripción si la
--    ficha no lo tiene, la sede del equipo si la ficha no la tiene, el
--    vencimiento como COALESCE(expires_at, end_date), y para el deportista
--    adulto el documento de profiles. La foto de datos se vuelve a tomar al
--    EMITIR (antes quedaba la del momento de la solicitud).
--
-- 3) Sin cobro por ahora (decisión de producto 2026-11-24): una plantilla con
--    requires_payment dejaba la constancia en 'pending_payment' para siempre
--    (nada creaba ni enlazaba el pago y la pantalla no tenía botón). Toda
--    solicitud nace 'pending_review'; issue acepta 'pending_payment' heredado
--    sin exigir pago. Las columnas requires_payment/price quedan sin uso.
--
-- 4) Privacidad de /cert/:x (sin sesión, GRANT a anon). Los folios son
--    consecutivos: recorriéndolos se obtenía el NOMBRE COMPLETO de menores. Ahora:
--      · por token (el QR del PDF apunta al token, no al folio): nombre completo;
--      · por folio (alguien lo digita): nombre enmascarado «Tomás H. M.»;
--      · solicitudes sin emitir: found=false (no se revela que existen).
--
-- 5) Avisos. El aviso de nueva solicitud no le llegaba a school_admin y su
--    link era '/admin/certificates'. Al emitir se avisaba a requested_by (si la
--    escuela la creaba, se avisaba a sí misma). Al anular no se avisaba a nadie.
--    Ahora el aviso va a la familia (acudiente o deportista adulto) al emitir y
--    al anular/rechazar, y a owner/admin/school_admin al recibir una solicitud.
--
-- 6) RPC nueva emitir_constancia_escuela: la escuela emite por su cuenta (hoy
--    solo podía aprobar lo que pedía la familia). Solicitud + emisión en UNA
--    transacción. Mismo guard de periodo de prueba que los envoltorios.
--
-- 7) list_athlete_certificates devuelve además counts por estado (la pantalla
--    contaba solo las 100 filas cargadas) y quién la pidió.
--
-- 8) Carnets: al emitir (o reemitir) un carnet, aviso en la app a la familia
--    (trigger AFTER INSERT en athlete_id_cards). Hoy la escuela tenía que
--    mandarlo a mano por WhatsApp uno por uno. Si el aviso falla, el carnet se
--    emite igual (EXCEPTION → WARNING).
--
-- NO toca: policies de las tablas (las reescribe el lote 2 de RLS,
-- 20261123123742), storage, ni las firmas/ACL de las RPC existentes.
--
-- RADIO DE IMPACTO: constancias, 0 filas en la base (nada que migrar). Carnets:
-- solo agrega avisos a partir de ahora (515 carnets existentes no se tocan; un
-- lote como el de Dynasty, 494, genera hasta 494 avisos, uno por carnet).
--
-- ROLLBACK: reemitir los cuerpos de 20260424000004 (las __interno = cuerpos
-- originales), DROP FUNCTION emitir_constancia_escuela, DROP TRIGGER
-- trg_notificar_carnet_emitido + su función, DROP TABLE
-- certificate_folio_counters (la vieja _next_certificate_folio no la usa).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Consecutivo de folios por escuela
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.certificate_folio_counters (
    school_id  uuid PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    prefix     text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Z0-9]{2,12}$'),
    year       int  NOT NULL CHECK (year BETWEEN 2020 AND 2100),
    last_seq   int  NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.certificate_folio_counters IS
  'Prefijo único por escuela y consecutivo anual de folios de constancias. Solo la muta _next_certificate_folio (SECURITY DEFINER, con candado). Sin policies a propósito: nadie la lee desde el cliente.';

ALTER TABLE public.certificate_folio_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.certificate_folio_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._next_certificate_folio(p_school_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_year   int  := EXTRACT(year FROM (now() AT TIME ZONE 'America/Bogota'))::int;
    v_hash   text := upper(md5(p_school_id::text));
    v_src    text;
    v_words  text[];
    v_base   text;
    v_prefix text;
    v_n      int  := 0;
    v_row    public.certificate_folio_counters%ROWTYPE;
    v_seq    int;
BEGIN
    -- Un solo folio a la vez por escuela (la primera vez la fila aún no existe,
    -- así que FOR UPDATE no alcanza: el candado consultivo cubre ese caso).
    PERFORM pg_advisory_xact_lock(hashtextextended('cert_folio:' || p_school_id::text, 0));

    SELECT * INTO v_row
      FROM public.certificate_folio_counters
     WHERE school_id = p_school_id
       FOR UPDATE;

    IF NOT FOUND THEN
        SELECT lower(coalesce(nullif(s.slug, ''), s.name, 'esc')) INTO v_src
          FROM public.schools s WHERE s.id = p_school_id;

        v_words := regexp_split_to_array(
                       btrim(regexp_replace(coalesce(v_src, 'esc'), '[^a-z0-9]+', ' ', 'g')),
                       '[[:space:]]+');

        IF coalesce(array_length(v_words, 1), 0) >= 2 THEN
            SELECT upper(string_agg(left(w, 1), '' ORDER BY o))
              INTO v_base
              FROM unnest(v_words[1:4]) WITH ORDINALITY AS t(w, o)
             WHERE w <> '';
        ELSE
            v_base := upper(left(coalesce(v_words[1], ''), 4));
        END IF;

        IF coalesce(length(v_base), 0) < 2 THEN
            v_base := 'ESC';
        END IF;

        LOOP
            v_prefix := CASE WHEN v_n = 0 THEN v_base ELSE v_base || substr(v_hash, 1, v_n) END;
            BEGIN
                INSERT INTO public.certificate_folio_counters (school_id, prefix, year, last_seq)
                VALUES (p_school_id, v_prefix, v_year, 0);
                EXIT;
            EXCEPTION WHEN unique_violation THEN
                v_n := v_n + 1;
                IF v_n > 8 THEN
                    RAISE;
                END IF;
            END;
        END LOOP;

        SELECT * INTO v_row
          FROM public.certificate_folio_counters
         WHERE school_id = p_school_id
           FOR UPDATE;
    END IF;

    v_seq := CASE WHEN v_row.year = v_year THEN v_row.last_seq + 1 ELSE 1 END;

    UPDATE public.certificate_folio_counters
       SET year = v_year, last_seq = v_seq, updated_at = now()
     WHERE school_id = p_school_id;

    RETURN v_row.prefix || '-' || v_year::text || '-' || lpad(v_seq::text, 5, '0');
END;
$function$;

REVOKE ALL ON FUNCTION public._next_certificate_folio(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._next_certificate_folio(uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Foto de datos de la constancia, con respaldo de equipo/sede/vencimiento
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._build_certificate_snapshot(
    p_school_id   uuid,
    p_template_id uuid,
    p_child_id    uuid,
    p_profile_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_school_name   text;
    v_school_logo   text;
    v_branding      jsonb;
    v_school_city   text;
    v_school_addr   text;
    v_school_phone  text;
    v_school_email  text;
    v_athlete       jsonb;
    v_team_id       uuid;
    v_branch_id     uuid;
    v_team_branch   uuid;
    v_team_name     text;
    v_branch_name   text;
    v_enr_team      uuid;
    v_enr_start     date;
    v_enr_status    text;
    v_enr_expires   date;
BEGIN
    SELECT s.name, s.logo_url, s.branding_settings, s.city, s.address, s.phone, s.email
      INTO v_school_name, v_school_logo, v_branding, v_school_city, v_school_addr, v_school_phone, v_school_email
      FROM public.schools s WHERE s.id = p_school_id;

    -- Inscripción de referencia: la activa primero, luego la más reciente.
    SELECT e.team_id, e.start_date, e.status, COALESCE(e.expires_at, e.end_date)
      INTO v_enr_team, v_enr_start, v_enr_status, v_enr_expires
      FROM public.enrollments e
     WHERE e.school_id = p_school_id
       AND ((p_child_id IS NOT NULL AND e.child_id = p_child_id)
         OR (p_child_id IS NULL AND e.user_id = p_profile_id))
     ORDER BY (e.status = 'active') DESC, e.created_at DESC
     LIMIT 1;

    IF p_child_id IS NOT NULL THEN
        SELECT jsonb_build_object(
                   'kind',          'child',
                   'full_name',     c.full_name,
                   'doc_type',      c.doc_type,
                   'doc_number',    c.doc_number,
                   'date_of_birth', c.date_of_birth,
                   'gender',        c.gender,
                   'avatar_url',    c.avatar_url
               ),
               c.team_id, c.branch_id
          INTO v_athlete, v_team_id, v_branch_id
          FROM public.children c
         WHERE c.id = p_child_id;
    ELSE
        SELECT jsonb_build_object(
                   'kind',          'profile',
                   'full_name',     p.full_name,
                   'doc_type',      p.document_type,
                   'doc_number',    p.document_number,
                   'date_of_birth', p.date_of_birth,
                   'gender',        p.gender,
                   'avatar_url',    p.avatar_url
               )
          INTO v_athlete
          FROM public.profiles p
         WHERE p.id = p_profile_id;
    END IF;

    v_team_id := COALESCE(v_team_id, v_enr_team);

    IF v_team_id IS NOT NULL THEN
        SELECT t.name, t.branch_id INTO v_team_name, v_team_branch
          FROM public.teams t WHERE t.id = v_team_id;
    END IF;

    v_branch_id := COALESCE(v_branch_id, v_team_branch);

    IF v_branch_id IS NOT NULL THEN
        SELECT sb.name INTO v_branch_name
          FROM public.school_branches sb WHERE sb.id = v_branch_id;
    END IF;

    RETURN jsonb_build_object(
        'snapshot_at', now(),
        'school', jsonb_build_object(
            'name',     v_school_name,
            'logo_url', v_school_logo,
            'branding', v_branding,
            'city',     v_school_city,
            'address',  v_school_addr,
            'phone',    v_school_phone,
            'email',    v_school_email
        ),
        'athlete',     v_athlete,
        'team_name',   v_team_name,
        'branch_name', v_branch_name,
        'enrollment',  jsonb_build_object(
            'start_date', v_enr_start,
            'status',     v_enr_status,
            'expires_at', v_enr_expires
        )
    );
END;
$function$;

REVOKE ALL ON FUNCTION public._build_certificate_snapshot(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._build_certificate_snapshot(uuid, uuid, uuid, uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Solicitud (la familia o la escuela). Sin cobro: siempre 'pending_review'.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_athlete_certificate__interno(
    p_school_id   uuid,
    p_template_id uuid,
    p_child_id    uuid DEFAULT NULL,
    p_profile_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_template    record;
    v_cert_id     uuid;
    v_folio       text;
    v_snapshot    jsonb;
    v_is_admin    boolean;
    v_can_request boolean := false;
    v_existing    record;
    v_athlete     text;
BEGIN
    IF (p_child_id IS NULL AND p_profile_id IS NULL)
       OR (p_child_id IS NOT NULL AND p_profile_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Must specify exactly one of p_child_id or p_profile_id'
            USING ERRCODE = '22023';
    END IF;

    v_is_admin := public.is_super_admin() OR public.is_school_admin(p_school_id);

    -- Authz: super-admin, admin de ESA escuela, el deportista adulto o el acudiente del menor.
    IF v_is_admin THEN
        v_can_request := true;
    ELSIF p_profile_id IS NOT NULL AND p_profile_id = auth.uid() THEN
        v_can_request := true;
    ELSIF p_child_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.children c
        WHERE c.id = p_child_id AND c.parent_id = auth.uid()
    ) THEN
        v_can_request := true;
    END IF;

    IF NOT v_can_request THEN
        RAISE EXCEPTION 'Forbidden: only owner/parent or school admin can request'
            USING ERRCODE = '42501';
    END IF;

    -- El deportista pertenece a la escuela (cross-tenant)
    IF p_child_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.children
            WHERE id = p_child_id AND school_id = p_school_id
        ) THEN
            RAISE EXCEPTION 'Athlete does not belong to this school' USING ERRCODE = '42501';
        END IF;
    ELSE
        IF NOT EXISTS (
            SELECT 1 FROM public.school_members
            WHERE profile_id = p_profile_id AND school_id = p_school_id AND status = 'active'
        ) THEN
            RAISE EXCEPTION 'Athlete profile is not an active member of this school' USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT * INTO v_template
      FROM public.school_certificate_templates
     WHERE id = p_template_id AND school_id = p_school_id AND active = true;
    IF v_template.id IS NULL THEN
        RAISE EXCEPTION 'Template not found or inactive' USING ERRCODE = '02000';
    END IF;

    -- Doble toque: si ya hay una solicitud igual esperando, se devuelve esa.
    SELECT ac.id, ac.folio INTO v_existing
      FROM public.athlete_certificates ac
     WHERE ac.school_id = p_school_id
       AND ac.template_id = p_template_id
       AND ac.status IN ('pending_review', 'pending_payment')
       AND ac.child_id IS NOT DISTINCT FROM p_child_id
       AND ac.profile_id IS NOT DISTINCT FROM p_profile_id
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'id', v_existing.id, 'folio', v_existing.folio, 'status', 'pending_review',
            'already_pending', true, 'requires_payment', false, 'price', 0, 'currency', v_template.currency
        );
    END IF;

    v_folio    := public._next_certificate_folio(p_school_id);
    v_snapshot := public._build_certificate_snapshot(p_school_id, p_template_id, p_child_id, p_profile_id);

    -- Sin cobro por ahora (2026-11-24): toda solicitud va a revisión de la escuela.
    INSERT INTO public.athlete_certificates (
        school_id, template_id, child_id, profile_id,
        folio, kind, title, content_snapshot,
        status, requested_by
    ) VALUES (
        p_school_id, p_template_id, p_child_id, p_profile_id,
        v_folio, v_template.kind, v_template.title, v_snapshot,
        'pending_review', auth.uid()
    )
    RETURNING id INTO v_cert_id;

    -- Aviso a la administración, solo si la pidió la familia (si la crea la
    -- escuela, no se avisa a sí misma).
    IF NOT v_is_admin THEN
        v_athlete := v_snapshot #>> '{athlete,full_name}';
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link)
        SELECT DISTINCT sm.profile_id,
               p_school_id,
               'Nueva solicitud de constancia',
               v_template.name || ' para ' || COALESCE(v_athlete, 'un deportista') || ' · Folio ' || v_folio,
               'info',
               '/certificates'
          FROM public.school_members sm
         WHERE sm.school_id = p_school_id
           AND sm.role IN ('owner', 'admin', 'school_admin')
           AND sm.status = 'active';
    END IF;

    RETURN jsonb_build_object(
        'id',               v_cert_id,
        'folio',            v_folio,
        'status',           'pending_review',
        'already_pending',  false,
        'requires_payment', false,
        'price',            0,
        'currency',         v_template.currency
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.request_athlete_certificate__interno(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_athlete_certificate__interno(uuid, uuid, uuid, uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Emisión: datos al día, sin exigir pago, aviso a la familia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_athlete_certificate__interno(
    p_certificate_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_cert      record;
    v_recipient uuid;
    v_athlete   text;
BEGIN
    SELECT * INTO v_cert
      FROM public.athlete_certificates WHERE id = p_certificate_id
       FOR UPDATE;

    IF v_cert.id IS NULL THEN
        RAISE EXCEPTION 'Certificate not found' USING ERRCODE = '02000';
    END IF;

    IF NOT (public.is_super_admin() OR public.is_school_admin(v_cert.school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    -- 'pending_payment' solo puede venir de antes del 2026-11-24 (hoy no hay
    -- ninguna): sin cobro, se emite igual.
    IF v_cert.status NOT IN ('pending_review', 'pending_payment') THEN
        RAISE EXCEPTION 'Certificate is not in a state that can be issued (current: %)', v_cert.status
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.athlete_certificates
       SET status           = 'issued',
           issued_at        = now(),
           issued_by        = auth.uid(),
           content_snapshot = public._build_certificate_snapshot(
                                  v_cert.school_id, v_cert.template_id, v_cert.child_id, v_cert.profile_id)
     WHERE id = p_certificate_id;

    -- Aviso a la familia: deportista adulto o acudiente del menor.
    v_recipient := COALESCE(
        v_cert.profile_id,
        (SELECT c.parent_id FROM public.children c WHERE c.id = v_cert.child_id)
    );
    v_athlete := COALESCE(
        (SELECT c.full_name FROM public.children c WHERE c.id = v_cert.child_id),
        (SELECT p.full_name FROM public.profiles p WHERE p.id = v_cert.profile_id)
    );

    IF v_recipient IS NOT NULL AND v_recipient IS DISTINCT FROM auth.uid() THEN
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link)
        VALUES (
            v_recipient,
            v_cert.school_id,
            'Constancia lista',
            'La constancia «' || v_cert.title || '» de ' || COALESCE(v_athlete, 'tu deportista')
                || ' (folio ' || v_cert.folio || ') ya se puede descargar.',
            'success',
            '/my-certificates'
        );
    END IF;

    RETURN jsonb_build_object(
        'id',     v_cert.id,
        'folio',  v_cert.folio,
        'status', 'issued'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.issue_athlete_certificate__interno(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_athlete_certificate__interno(uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5) La escuela emite por su cuenta: solicitud + emisión en una transacción
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.emitir_constancia_escuela(
    p_school_id   uuid,
    p_template_id uuid,
    p_child_id    uuid DEFAULT NULL,
    p_profile_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_req jsonb;
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden: school admin only' USING ERRCODE = '42501';
    END IF;

    IF NOT public.school_is_operational(p_school_id) THEN
        RAISE EXCEPTION 'Esta escuela tiene el periodo de prueba vencido: no puede emitir constancias nuevas.'
            USING ERRCODE = '42501';
    END IF;

    v_req := public.request_athlete_certificate__interno(p_school_id, p_template_id, p_child_id, p_profile_id);
    PERFORM public.issue_athlete_certificate__interno((v_req->>'id')::uuid);

    RETURN jsonb_build_object(
        'id',     v_req->>'id',
        'folio',  v_req->>'folio',
        'status', 'issued'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.emitir_constancia_escuela(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emitir_constancia_escuela(uuid, uuid, uuid, uuid) TO authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Anular / rechazar, con aviso a la familia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revoke_athlete_certificate(
    p_certificate_id uuid,
    p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_cert      record;
    v_reason    text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
    v_recipient uuid;
    v_athlete   text;
BEGIN
    SELECT * INTO v_cert
      FROM public.athlete_certificates WHERE id = p_certificate_id
       FOR UPDATE;

    IF v_cert.id IS NULL THEN
        RAISE EXCEPTION 'Certificate not found' USING ERRCODE = '02000';
    END IF;

    IF NOT (public.is_super_admin() OR public.is_school_admin(v_cert.school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    IF v_cert.status = 'revoked' THEN
        RETURN;
    END IF;

    UPDATE public.athlete_certificates
       SET status = 'revoked',
           revoked_at = now(),
           revocation_reason = v_reason
     WHERE id = p_certificate_id;

    v_recipient := COALESCE(
        v_cert.profile_id,
        (SELECT c.parent_id FROM public.children c WHERE c.id = v_cert.child_id)
    );
    v_athlete := COALESCE(
        (SELECT c.full_name FROM public.children c WHERE c.id = v_cert.child_id),
        (SELECT p.full_name FROM public.profiles p WHERE p.id = v_cert.profile_id)
    );

    IF v_recipient IS NOT NULL AND v_recipient IS DISTINCT FROM auth.uid() THEN
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link)
        VALUES (
            v_recipient,
            v_cert.school_id,
            CASE WHEN v_cert.status = 'issued' THEN 'Constancia anulada' ELSE 'Solicitud de constancia no aprobada' END,
            CASE WHEN v_cert.status = 'issued'
                 THEN 'La escuela anuló la constancia «' || v_cert.title || '» de ' || COALESCE(v_athlete, 'tu deportista') || ' (folio ' || v_cert.folio || ').'
                 ELSE 'La escuela no aprobó la constancia «' || v_cert.title || '» de ' || COALESCE(v_athlete, 'tu deportista') || '.'
            END || COALESCE(' Motivo: ' || v_reason, ''),
            'warning',
            '/my-certificates'
        );
    END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.revoke_athlete_certificate(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_athlete_certificate(uuid, text) TO authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7) Verificación pública: por token nombre completo; por folio enmascarado;
--    lo no emitido no existe para el público.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_athlete_certificate_public(
    p_folio    text DEFAULT NULL,
    p_qr_token uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_cert        record;
    v_via         text;
    v_school_name text;
    v_name        text;
BEGIN
    IF p_qr_token IS NOT NULL THEN
        SELECT * INTO v_cert FROM public.athlete_certificates WHERE qr_verify_token = p_qr_token;
        v_via := 'token';
    ELSIF nullif(btrim(coalesce(p_folio, '')), '') IS NOT NULL THEN
        SELECT * INTO v_cert FROM public.athlete_certificates WHERE folio = upper(btrim(p_folio));
        v_via := 'folio';
    ELSE
        RETURN jsonb_build_object('found', false);
    END IF;

    IF v_cert.id IS NULL OR v_cert.status NOT IN ('issued', 'revoked') THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    SELECT name INTO v_school_name FROM public.schools WHERE id = v_cert.school_id;

    -- Solo el nombre, nunca documento ni datos sensibles.
    v_name := COALESCE(
        (SELECT full_name FROM public.children WHERE id = v_cert.child_id),
        (SELECT full_name FROM public.profiles WHERE id = v_cert.profile_id)
    );

    -- Digitando un folio (consecutivo, adivinable) no se entrega el nombre
    -- completo: primer nombre + iniciales («Tomás H. M.»).
    IF v_via = 'folio' AND v_name IS NOT NULL THEN
        SELECT string_agg(CASE WHEN o = 1 THEN w ELSE left(w, 1) || '.' END, ' ' ORDER BY o)
          INTO v_name
          FROM regexp_split_to_table(btrim(v_name), '[[:space:]]+') WITH ORDINALITY AS t(w, o)
         WHERE w <> '';
    END IF;

    RETURN jsonb_build_object(
        'found',             true,
        'via',               v_via,
        'name_masked',       v_via = 'folio',
        'folio',             v_cert.folio,
        'kind',              v_cert.kind,
        'title',             v_cert.title,
        'status',            v_cert.status,
        'school_name',       v_school_name,
        'athlete_name',      v_name,
        'issued_at',         v_cert.issued_at,
        'revoked_at',        v_cert.revoked_at,
        'revocation_reason', CASE WHEN v_cert.status = 'revoked' THEN v_cert.revocation_reason ELSE NULL END
    );
END;
$function$;

-- Flujo público demostrado: /cert/:x se abre sin sesión (escaneo del QR del PDF).
GRANT EXECUTE ON FUNCTION public.verify_athlete_certificate_public(text, uuid) TO anon, authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8) Listado de la escuela: conteos por estado y quién la pidió
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_athlete_certificates(
    p_school_id uuid,
    p_status    text DEFAULT NULL,
    p_kind      text DEFAULT NULL,
    p_search    text DEFAULT NULL,
    p_limit     int  DEFAULT 50,
    p_offset    int  DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_rows   jsonb;
    v_total  bigint;
    v_counts jsonb;
    v_search text := nullif(btrim(coalesce(p_search, '')), '');
BEGIN
    IF NOT (public.is_super_admin() OR public.is_school_admin(p_school_id)) THEN
        RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
    END IF;

    WITH base AS (
        SELECT ac.*, COALESCE(c.full_name, p.full_name) AS athlete_name
          FROM public.athlete_certificates ac
          LEFT JOIN public.children c ON c.id = ac.child_id
          LEFT JOIN public.profiles p ON p.id = ac.profile_id
         WHERE ac.school_id = p_school_id
           AND (p_kind IS NULL OR ac.kind = p_kind)
           AND (
                v_search IS NULL
                OR ac.folio ILIKE '%' || v_search || '%'
                OR c.full_name ILIKE '%' || v_search || '%'
                OR p.full_name ILIKE '%' || v_search || '%'
           )
    )
    SELECT jsonb_build_object(
               'all',             count(*),
               'pending_review',  count(*) FILTER (WHERE status IN ('pending_review', 'pending_payment')),
               'issued',          count(*) FILTER (WHERE status = 'issued'),
               'revoked',         count(*) FILTER (WHERE status = 'revoked')
           ),
           count(*) FILTER (WHERE p_status IS NULL
                               OR status = p_status
                               OR (p_status = 'pending_review' AND status = 'pending_payment'))
      INTO v_counts, v_total
      FROM base;

    SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.created_at DESC), '[]'::jsonb)
      INTO v_rows
      FROM (
          SELECT
              ac.id,
              ac.folio,
              ac.kind,
              ac.title,
              ac.status,
              ac.created_at,
              ac.issued_at,
              ac.revoked_at,
              ac.revocation_reason,
              ac.pdf_url,
              ac.qr_verify_token,
              ac.template_id,
              ac.child_id,
              ac.profile_id,
              COALESCE(c.full_name, p.full_name) AS athlete_name,
              tpl.name AS template_name,
              tpl.requires_payment,
              tpl.price,
              rq.full_name AS requested_by_name,
              (ac.requested_by IS NOT NULL AND ac.requested_by = ac.issued_by) AS created_by_school
          FROM public.athlete_certificates ac
          LEFT JOIN public.children c ON c.id = ac.child_id
          LEFT JOIN public.profiles p ON p.id = ac.profile_id
          LEFT JOIN public.profiles rq ON rq.id = ac.requested_by
          LEFT JOIN public.school_certificate_templates tpl ON tpl.id = ac.template_id
         WHERE ac.school_id = p_school_id
           AND (p_status IS NULL
                OR ac.status = p_status
                OR (p_status = 'pending_review' AND ac.status = 'pending_payment'))
           AND (p_kind IS NULL OR ac.kind = p_kind)
           AND (
                v_search IS NULL
                OR ac.folio ILIKE '%' || v_search || '%'
                OR c.full_name ILIKE '%' || v_search || '%'
                OR p.full_name ILIKE '%' || v_search || '%'
           )
         ORDER BY ac.created_at DESC
         LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 500) OFFSET GREATEST(coalesce(p_offset, 0), 0)
      ) t;

    RETURN jsonb_build_object('total', v_total, 'counts', v_counts, 'rows', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.list_athlete_certificates(uuid, text, text, text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_athlete_certificates(uuid, text, text, text, int, int) TO authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9) Carnets: aviso a la familia al emitir o reemitir
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_notificar_carnet_emitido()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_dest   uuid;
    v_name   text;
    v_school text;
BEGIN
    IF NEW.status IS DISTINCT FROM 'active' THEN
        RETURN NEW;
    END IF;

    IF NEW.child_id IS NOT NULL THEN
        SELECT c.parent_id, c.full_name INTO v_dest, v_name
          FROM public.children c WHERE c.id = NEW.child_id;
    ELSIF NEW.profile_id IS NOT NULL THEN
        SELECT p.id, p.full_name INTO v_dest, v_name
          FROM public.profiles p WHERE p.id = NEW.profile_id;
    END IF;

    -- Sin cuenta (unregistered_athletes) no hay a quién avisar.
    IF v_dest IS NULL OR v_dest IS NOT DISTINCT FROM auth.uid() THEN
        RETURN NEW;
    END IF;

    SELECT s.name INTO v_school FROM public.schools s WHERE s.id = NEW.school_id;

    BEGIN
        INSERT INTO public.notifications (user_id, school_id, title, message, type, link)
        VALUES (
            v_dest,
            NEW.school_id,
            CASE WHEN COALESCE(NEW.version, 1) > 1 THEN 'Carnet actualizado' ELSE 'Carnet deportivo listo' END,
            'El carnet de ' || COALESCE(v_name, 'tu deportista') || ' en ' || COALESCE(v_school, 'la escuela')
                || ' ya está disponible en Carnets.',
            'success',
            '/my-cards'
        );
    EXCEPTION WHEN OTHERS THEN
        -- El carnet se emite igual aunque el aviso falle.
        RAISE WARNING 'tg_notificar_carnet_emitido: % (%)', SQLERRM, SQLSTATE;
    END;

    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_notificar_carnet_emitido() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notificar_carnet_emitido ON public.athlete_id_cards;
CREATE TRIGGER trg_notificar_carnet_emitido
    AFTER INSERT ON public.athlete_id_cards
    FOR EACH ROW EXECUTE FUNCTION public.tg_notificar_carnet_emitido();

COMMIT;
