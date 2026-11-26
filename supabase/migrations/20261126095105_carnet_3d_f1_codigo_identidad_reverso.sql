-- =============================================================================
-- 20261126095105_carnet_3d_f1_codigo_identidad_reverso.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261125190617
-- Spec: docs/specs/carnet-3d-club.md (F1). Puntos 1–6 aprobados el 2026-11-26.
--
-- Objetivo (modelo de datos del carnet 3D, sin pantallas):
-- 1) Código impreso del carnet `SM-AAAA-NNNNN` (D4): columna
--    athlete_id_cards.codigo, consecutivo GLOBAL por año en
--    athlete_card_code_counters, asignado por trigger BEFORE INSERT (el cliente
--    no lo elige) e inmutable. Cada emisión (fila) lleva el suyo (punto 2): al
--    reemitir, issue_athlete_id_card revoca la fila vieja e inserta otra, así
--    que el código viejo sigue resolviendo como «no válido». Backfill de los
--    carnets existentes por created_at.
-- 2) Número de camiseta y posición en enrollments (punto 5), con respaldo de
--    lectura en la última alineación (match_lineup_players). Helper interno
--    _carnet_numero_posicion().
-- 3) Identidad del club: update_school_branding gana p_accent_color,
--    p_reset_colores (botón «Restablecer», F2) y p_confirma_derechos_escudo
--    (quién y cuándo los pone el servidor, con auth.uid() y now()). Mismo gate
--    de plan que los otros colores. Cambia la firma: DROP + CREATE + GRANT.
-- 4) verify_athlete_id_card_public devuelve además codigo, numero y posicion.
--    Mismo cuerpo vivo, solo se AGREGA (nada de lo que ya devolvía cambia).
-- 5) verificar_carnet_por_codigo(p_codigo) — alguien digita el código: solo
--    válido / no válido + nombre enmascarado («Tomás H. M.») + club. Sin token,
--    sin foto, sin documento (mismo criterio que el folio de constancias).
-- 6) card_back_data(p_qr_token) — datos del reverso: deporte, «Zona de juego»
--    (D1) y 4 estadísticas genéricas (asistencia 90 d, sesiones, último informe,
--    antigüedad). Solo personal de la escuela del carnet, acudiente y el
--    deportista adulto; nunca anon. Las estadísticas de fútbol llegan en F4.
--
-- Fuera de F1 (van en F5): nombre del menor enmascarado en /c/:token para el
-- público (punto 3) y separación coach/admin con datos de emergencia para el
-- coach (punto 6). Esta migración no cambia lo que hoy ve cada nivel.
--
-- RADIO: athlete_id_cards 517 filas (4 escuelas) reciben código; su
-- updated_at NO se toca (trigger touch apagado durante el backfill).
-- enrollments: 2 columnas nuevas, NULL en todas las filas. update_school_branding:
-- llamadas viejas con argumentos nombrados siguen funcionando (los nuevos
-- tienen DEFAULT).
-- ROLLBACK: DROP de card_back_data, verificar_carnet_por_codigo,
-- _carnet_numero_posicion, _nombre_enmascarado, trigger+función del código,
-- _next_card_code y la tabla de contadores; ALTER TABLE … DROP COLUMN codigo /
-- jersey_number / position; recrear update_school_branding y
-- verify_athlete_id_card_public con su definición anterior (20261124152343 y
-- la viva del 2026-11-26).
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) Código del carnet
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.athlete_card_code_counters (
    year       int         PRIMARY KEY CHECK (year BETWEEN 2000 AND 9999),
    last_seq   int         NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- Solo lo mutan funciones SECURITY DEFINER: nadie lo lee ni escribe directo.
ALTER TABLE public.athlete_card_code_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.athlete_card_code_counters FROM PUBLIC, anon, authenticated;

ALTER TABLE public.athlete_id_cards ADD COLUMN IF NOT EXISTS codigo text;

CREATE OR REPLACE FUNCTION public._next_card_code(p_year int)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_seq int;
BEGIN
    -- El upsert toma el candado de la fila del año: dos emisiones simultáneas
    -- nunca reciben el mismo número.
    INSERT INTO public.athlete_card_code_counters AS k (year, last_seq)
    VALUES (p_year, 1)
    ON CONFLICT (year) DO UPDATE
        SET last_seq = k.last_seq + 1, updated_at = now()
    RETURNING k.last_seq INTO v_seq;

    IF v_seq > 99999 THEN
        RAISE EXCEPTION 'Se agotaron los códigos de carnet del año % (máximo 99999).', p_year
            USING ERRCODE = '54000';
    END IF;

    RETURN 'SM-' || p_year::text || '-' || lpad(v_seq::text, 5, '0');
END;
$function$;

REVOKE ALL ON FUNCTION public._next_card_code(int) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_athlete_id_cards_codigo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Siempre lo pone el servidor: un código traído por el cliente podría
        -- adelantarse al consecutivo y hacer fallar emisiones futuras.
        NEW.codigo := public._next_card_code(
            EXTRACT(year FROM (COALESCE(NEW.issued_at, now()) AT TIME ZONE 'America/Bogota'))::int);
    ELSIF OLD.codigo IS NOT NULL AND NEW.codigo IS DISTINCT FROM OLD.codigo THEN
        RAISE EXCEPTION 'El código del carnet no se puede cambiar.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_athlete_id_cards_codigo() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_athlete_id_cards_codigo ON public.athlete_id_cards;
CREATE TRIGGER trg_athlete_id_cards_codigo
    BEFORE INSERT OR UPDATE OF codigo ON public.athlete_id_cards
    FOR EACH ROW EXECUTE FUNCTION public.tg_athlete_id_cards_codigo();

-- Backfill por created_at, consecutivo por año (hora de Bogotá).
ALTER TABLE public.athlete_id_cards DISABLE TRIGGER trg_athlete_id_cards_touch;

WITH base AS (
    SELECT id, created_at,
           EXTRACT(year FROM (created_at AT TIME ZONE 'America/Bogota'))::int AS y
      FROM public.athlete_id_cards
     WHERE codigo IS NULL
), numerados AS (
    SELECT id, y, row_number() OVER (PARTITION BY y ORDER BY created_at, id) AS rn
      FROM base
)
UPDATE public.athlete_id_cards c
   SET codigo = 'SM-' || n.y::text || '-' || lpad(n.rn::text, 5, '0')
  FROM numerados n
 WHERE c.id = n.id;

ALTER TABLE public.athlete_id_cards ENABLE TRIGGER trg_athlete_id_cards_touch;

INSERT INTO public.athlete_card_code_counters (year, last_seq)
SELECT split_part(codigo, '-', 2)::int, max(split_part(codigo, '-', 3)::int)
  FROM public.athlete_id_cards
 GROUP BY 1
ON CONFLICT (year) DO UPDATE
    SET last_seq = GREATEST(public.athlete_card_code_counters.last_seq, EXCLUDED.last_seq),
        updated_at = now();

ALTER TABLE public.athlete_id_cards ALTER COLUMN codigo SET NOT NULL;
ALTER TABLE public.athlete_id_cards
    ADD CONSTRAINT athlete_id_cards_codigo_formato CHECK (codigo ~ '^SM-[0-9]{4}-[0-9]{5}$');
ALTER TABLE public.athlete_id_cards
    ADD CONSTRAINT athlete_id_cards_codigo_key UNIQUE (codigo);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) Número de camiseta y posición
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.enrollments
    ADD COLUMN IF NOT EXISTS jersey_number smallint,
    ADD COLUMN IF NOT EXISTS position text;

ALTER TABLE public.enrollments
    ADD CONSTRAINT enrollments_jersey_number_rango CHECK (jersey_number IS NULL OR jersey_number BETWEEN 0 AND 999);
ALTER TABLE public.enrollments
    ADD CONSTRAINT enrollments_position_largo CHECK (position IS NULL OR char_length(btrim(position)) BETWEEN 1 AND 40);

COMMENT ON COLUMN public.enrollments.jersey_number IS 'Número de camiseta en este equipo (carnet 3D). Si es NULL se toma de la última alineación.';
COMMENT ON COLUMN public.enrollments.position IS 'Posición en este equipo, texto corto (carnet 3D). Si es NULL se toma de la última alineación.';

-- Número y posición de un deportista en una escuela: primero la inscripción
-- activa, después la última alineación. Solo lo llaman funciones DEFINER.
CREATE OR REPLACE FUNCTION public._carnet_numero_posicion(
    p_school_id uuid, p_child_id uuid, p_profile_id uuid, p_unregistered_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_num      int;
    v_pos      text;
    v_lnum     int;
    v_lpos     text;
    v_tipo     text := CASE WHEN p_child_id IS NOT NULL THEN 'child'
                            WHEN p_profile_id IS NOT NULL THEN 'profile'
                            ELSE 'unregistered' END;
    v_sujeto   uuid := COALESCE(p_child_id, p_profile_id, p_unregistered_id);
BEGIN
    SELECT e.jersey_number, NULLIF(btrim(e.position), '')
      INTO v_num, v_pos
      FROM public.enrollments e
     WHERE e.school_id = p_school_id
       AND e.status = 'active'
       AND (e.jersey_number IS NOT NULL OR e.position IS NOT NULL)
       AND (   (p_child_id IS NOT NULL AND e.child_id = p_child_id)
            OR (p_profile_id IS NOT NULL AND e.user_id = p_profile_id AND e.child_id IS NULL)
            OR (p_unregistered_id IS NOT NULL AND e.unregistered_athlete_id = p_unregistered_id))
     ORDER BY e.updated_at DESC NULLS LAST
     LIMIT 1;

    IF v_num IS NULL OR v_pos IS NULL THEN
        SELECT lp.jersey_number, NULLIF(btrim(lp.position_code), '')
          INTO v_lnum, v_lpos
          FROM public.match_lineup_players lp
          JOIN public.match_lineups ml ON ml.id = lp.lineup_id
         WHERE lp.school_id = p_school_id
           AND lp.subject_type = v_tipo
           AND lp.subject_id = v_sujeto
           AND (lp.jersey_number IS NOT NULL OR lp.position_code IS NOT NULL)
         ORDER BY ml.created_at DESC
         LIMIT 1;
    END IF;

    RETURN jsonb_build_object(
        'numero',   COALESCE(v_num, v_lnum),
        'posicion', COALESCE(v_pos, v_lpos),
        'origen',   CASE WHEN v_num IS NOT NULL OR v_pos IS NOT NULL THEN 'inscripcion'
                         WHEN v_lnum IS NOT NULL OR v_lpos IS NOT NULL THEN 'alineacion'
                         ELSE NULL END);
END;
$function$;

REVOKE ALL ON FUNCTION public._carnet_numero_posicion(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- «Tomás Hernández Mejía» → «Tomás H. M.» (mismo criterio que el folio de constancias).
CREATE OR REPLACE FUNCTION public._nombre_enmascarado(p_nombre text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
    SELECT NULLIF(string_agg(CASE WHEN o = 1 THEN w ELSE left(w, 1) || '.' END, ' ' ORDER BY o), '')
      FROM regexp_split_to_table(btrim(COALESCE(p_nombre, '')), '[[:space:]]+') WITH ORDINALITY AS t(w, o)
     WHERE w <> '';
$function$;

REVOKE ALL ON FUNCTION public._nombre_enmascarado(text) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Identidad del club: acento, restablecer y derechos del escudo
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.update_school_branding(uuid, text, text, text, boolean, inet, text);

CREATE FUNCTION public.update_school_branding(
    p_school_id                 uuid,
    p_logo_url                  text    DEFAULT NULL,
    p_primary_color             text    DEFAULT NULL,
    p_secondary_color           text    DEFAULT NULL,
    p_show_watermark            boolean DEFAULT NULL,
    p_ip_address                inet    DEFAULT NULL,
    p_user_agent                text    DEFAULT NULL,
    p_accent_color              text    DEFAULT NULL,
    p_reset_colores             boolean DEFAULT NULL,
    p_confirma_derechos_escudo  boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_user_id            uuid := auth.uid();
    v_has_permission     boolean;
    v_has_feature        boolean;
    v_recent_changes     integer;
    v_before_logo        text;
    v_before_settings    jsonb;
    v_new_settings       jsonb;
    v_storage_url_prefix text;
    v_puede_apagar       boolean := false;
    v_watermark_negado   boolean := false;

    c_hex_regex constant text := '^#[0-9A-Fa-f]{6}$';
BEGIN
    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'auth_required');
    END IF;

    IF p_school_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'school_id_required');
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.school_members
         WHERE school_id = p_school_id
           AND profile_id = v_user_id
           AND role IN ('owner','super_admin','admin','school_admin')
           AND status = 'active'
    ) INTO v_has_permission;

    IF NOT v_has_permission THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT public.school_has_branding_feature(p_school_id) INTO v_has_feature;
    IF NOT v_has_feature THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'feature_not_available',
            'message', 'La personalizacion de marca esta disponible en planes Pro y superiores.'
        );
    END IF;

    SELECT COUNT(*) INTO v_recent_changes
      FROM public.branding_change_log
     WHERE school_id = p_school_id
       AND changed_at >= now() - interval '1 hour';

    IF v_recent_changes >= 10 THEN
        RETURN jsonb_build_object(
            'ok', false,
            'error', 'rate_limited',
            'message', 'Demasiados cambios recientes. Intenta de nuevo en 1 hora.'
        );
    END IF;

    IF p_primary_color IS NOT NULL AND p_primary_color !~ c_hex_regex THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_primary_color');
    END IF;
    IF p_secondary_color IS NOT NULL AND p_secondary_color !~ c_hex_regex THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_secondary_color');
    END IF;
    IF p_accent_color IS NOT NULL AND p_accent_color !~ c_hex_regex THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_accent_color');
    END IF;

    IF p_logo_url IS NOT NULL THEN
        v_storage_url_prefix := '/storage/v1/object/public/school-assets/logos/' || p_school_id::text || '/';
        IF position(v_storage_url_prefix in p_logo_url) = 0
           AND p_logo_url NOT LIKE ('logos/' || p_school_id::text || '/%')
        THEN
            RETURN jsonb_build_object(
                'ok', false,
                'error', 'invalid_logo_url',
                'message', 'logo_url debe pertenecer al bucket school-assets de esta escuela.'
            );
        END IF;
    END IF;

    SELECT logo_url, branding_settings
      INTO v_before_logo, v_before_settings
      FROM public.schools
     WHERE id = p_school_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'school_not_found');
    END IF;

    v_new_settings := COALESCE(v_before_settings, '{}'::jsonb);

    -- «Restablecer»: vuelve al diseño base de SportMaps (sin colores propios).
    -- Va antes de los colores nuevos para que «restablecer + elegir» funcione.
    IF COALESCE(p_reset_colores, false) THEN
        v_new_settings := v_new_settings - 'primary_color' - 'secondary_color' - 'accent_color';
    END IF;

    IF p_primary_color IS NOT NULL THEN
        v_new_settings := v_new_settings || jsonb_build_object('primary_color', p_primary_color);
    END IF;
    IF p_secondary_color IS NOT NULL THEN
        v_new_settings := v_new_settings || jsonb_build_object('secondary_color', p_secondary_color);
    END IF;
    IF p_accent_color IS NOT NULL THEN
        v_new_settings := v_new_settings || jsonb_build_object('accent_color', p_accent_color);
    END IF;

    -- Derechos del escudo: quién y cuándo los pone el servidor, nunca el cliente.
    -- Quedan atados al logo que se confirmó (si después cambia sin confirmar,
    -- la constancia ya no corresponde y la pantalla lo sabe comparando logo_url).
    IF COALESCE(p_confirma_derechos_escudo, false) THEN
        v_new_settings := v_new_settings || jsonb_build_object('escudo_derechos', jsonb_build_object(
            'confirmado_por', v_user_id,
            'confirmado_en',  now(),
            'logo_url',       COALESCE(p_logo_url, v_before_logo)));
    END IF;

    IF p_show_watermark IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM public.school_addons a
             WHERE a.school_id = p_school_id
               AND a.addon_key = 'whitelabel'
               AND a.enabled
        ) INTO v_puede_apagar;

        IF p_show_watermark = false AND NOT v_puede_apagar THEN
            v_watermark_negado := true;
            v_new_settings := v_new_settings || jsonb_build_object('show_sportmaps_watermark', true);
        ELSE
            v_new_settings := v_new_settings || jsonb_build_object('show_sportmaps_watermark', p_show_watermark);
        END IF;
    END IF;

    PERFORM set_config('app.branding_via_rpc', 'true', true);

    UPDATE public.schools
       SET logo_url          = COALESCE(p_logo_url, logo_url),
           branding_settings = v_new_settings,
           updated_at        = now()
     WHERE id = p_school_id;

    INSERT INTO public.branding_change_log (
        school_id, changed_by, before_state, after_state,
        ip_address, user_agent, change_source
    ) VALUES (
        p_school_id, v_user_id,
        jsonb_build_object('logo_url', v_before_logo, 'branding_settings', v_before_settings),
        jsonb_build_object('logo_url', COALESCE(p_logo_url, v_before_logo), 'branding_settings', v_new_settings),
        p_ip_address, p_user_agent,
        CASE WHEN COALESCE(p_reset_colores, false) THEN 'reset_default' ELSE 'rpc_update' END
    );

    RETURN jsonb_build_object(
        'ok', true,
        'school_id', p_school_id,
        'logo_url', COALESCE(p_logo_url, v_before_logo),
        'branding_settings', v_new_settings,
        'watermark_no_editable', v_watermark_negado
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_school_branding(uuid, text, text, text, boolean, inet, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_school_branding(uuid, text, text, text, boolean, inet, text, text, boolean, boolean) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) Verificación por token: + codigo, numero, posicion (solo se agrega)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verify_athlete_id_card_public(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_card        record;
    v_template    record;
    v_school      record;
    v_show        jsonb;
    v_athlete_filtered jsonb := '{}'::jsonb;
    v_branch_name text;
    v_team_name   text;
    v_monthly_fee numeric;
    v_fee_status  text := 'unknown';
    v_last_paid   date;
    v_next_due    date;
    v_today       date := CURRENT_DATE;
    v_child_branch uuid;
    v_child_team   uuid;
    v_child_parent uuid;
    v_last_payment jsonb;
    v_uid          uuid := auth.uid();
    v_is_staff     boolean := false;
    v_is_guardian  boolean := false;
    v_private      boolean := false;
    v_viewer       text := 'public';
    v_kind         text;
    v_np           jsonb;
BEGIN
    SELECT * INTO v_card FROM public.athlete_id_cards WHERE qr_token = p_qr_token;

    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    IF v_card.status = 'revoked' THEN
        RETURN jsonb_build_object('found', true, 'status', 'revoked', 'revoked_at', v_card.revoked_at,
                                  'reason', v_card.revocation_reason, 'codigo', v_card.codigo);
    END IF;

    IF v_card.valid_until < v_today THEN
        RETURN jsonb_build_object('found', true, 'status', 'expired', 'valid_until', v_card.valid_until,
                                  'codigo', v_card.codigo);
    END IF;

    -- ¿Quién mira? Sin sesión → público. Los datos médicos, de emergencia,
    -- documento y pagos solo salen para staff de ESTA escuela o el acudiente.
    IF v_uid IS NOT NULL THEN
        v_is_staff := public.is_super_admin()
                      OR v_card.school_id = ANY (public.user_staff_school_ids());
        v_is_guardian := (v_card.profile_id IS NOT NULL AND v_card.profile_id = v_uid)
                      OR (v_card.child_id IS NOT NULL AND EXISTS (
                            SELECT 1 FROM public.children cc
                             WHERE cc.id = v_card.child_id AND cc.parent_id = v_uid));
    END IF;
    v_private := COALESCE(v_is_staff, false) OR COALESCE(v_is_guardian, false);
    v_viewer  := CASE WHEN v_is_staff THEN 'staff' WHEN v_is_guardian THEN 'guardian' ELSE 'public' END;

    SELECT * INTO v_template FROM public.athlete_id_card_templates WHERE id = v_card.template_id;

    -- Carnet sin plantilla → la predeterminada activa de la escuela.
    IF v_template.id IS NULL THEN
        SELECT * INTO v_template
        FROM public.athlete_id_card_templates t
        WHERE t.school_id = v_card.school_id AND t.is_default = true AND t.active = true
        ORDER BY t.updated_at DESC NULLS LAST, t.created_at DESC
        LIMIT 1;
    END IF;

    v_show := COALESCE(v_template.show_fields, jsonb_build_object(
        'photo', true, 'doc_number', false, 'team', true, 'branch', true, 'plan', false,
        'valid_until', true, 'fee_status', false, 'blood_type', false,
        'emergency_contact', false, 'eps', false, 'tshirt_size', false));

    -- Lo privado se apaga para el público aunque la plantilla lo encienda.
    IF NOT v_private THEN
        v_show := v_show || jsonb_build_object(
            'doc_number', false, 'fee_status', false, 'blood_type', false,
            'emergency_contact', false, 'eps', false, 'tshirt_size', false, 'plan', false);
    END IF;

    SELECT id, name, logo_url, branding_settings, slug INTO v_school FROM public.schools WHERE id = v_card.school_id;

    IF v_card.child_id IS NOT NULL THEN
        v_kind := 'child';

        SELECT jsonb_build_object('kind', 'child', 'full_name', c.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, c.avatar_url)),
               c.branch_id, c.team_id, c.monthly_fee, c.parent_id
        INTO v_athlete_filtered, v_child_branch, v_child_team, v_monthly_fee, v_child_parent
        FROM public.children c WHERE c.id = v_card.child_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', c.doc_type, 'doc_number', c.doc_number)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'blood_type')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('blood_type', c.blood_type)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'eps')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('eps_name', c.eps_name)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'tshirt_size')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('tshirt_size', c.tshirt_size)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;
        IF COALESCE((v_show->>'emergency_contact')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('emergency_contact', c.emergency_contact)
            INTO v_athlete_filtered FROM public.children c WHERE c.id = v_card.child_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT name INTO v_branch_name FROM public.school_branches WHERE id = v_child_branch;
        END IF;
        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT name INTO v_team_name FROM public.teams WHERE id = v_child_team;
        END IF;

    ELSIF v_card.profile_id IS NOT NULL THEN
        v_kind := 'profile';

        SELECT jsonb_build_object('kind', 'profile', 'full_name', p.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, p.avatar_url))
        INTO v_athlete_filtered FROM public.profiles p WHERE p.id = v_card.profile_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', p.document_type, 'doc_number', p.document_number)
            INTO v_athlete_filtered FROM public.profiles p WHERE p.id = v_card.profile_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT sb2.name INTO v_branch_name
            FROM (
                SELECT sb2.id FROM public.team_members tm
                  JOIN public.teams t ON t.id = tm.team_id
                  JOIN public.school_branches sb2 ON sb2.id = t.branch_id
                 WHERE tm.profile_id = v_card.profile_id AND t.school_id = v_card.school_id
                UNION ALL
                SELECT sb2.id FROM public.enrollments e
                  JOIN public.teams prog ON prog.id = e.team_id
                  JOIN public.school_branches sb2 ON sb2.id = prog.branch_id
                 WHERE e.user_id = v_card.profile_id AND e.school_id = v_card.school_id AND e.status = 'active'
                UNION ALL
                SELECT sb2.id FROM public.school_members sm
                  JOIN public.school_branches sb2 ON sb2.id = sm.branch_id
                 WHERE sm.profile_id = v_card.profile_id AND sm.school_id = v_card.school_id
            ) sub
            JOIN public.school_branches sb2 ON sb2.id = sub.id
            LIMIT 1;
        END IF;

        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT t.name INTO v_team_name
            FROM public.team_members tm
            JOIN public.teams t ON t.id = tm.team_id
            WHERE tm.profile_id = v_card.profile_id AND t.school_id = v_card.school_id
            LIMIT 1;

            IF v_team_name IS NULL THEN
                SELECT t.name INTO v_team_name
                FROM public.enrollments e
                JOIN public.teams t ON t.id = e.team_id
                WHERE e.user_id = v_card.profile_id AND e.school_id = v_card.school_id AND e.status = 'active'
                ORDER BY e.created_at LIMIT 1;
            END IF;
        END IF;

    ELSE
        v_kind := 'unregistered';

        SELECT jsonb_build_object('kind', 'unregistered', 'full_name', ua.full_name,
                                  'avatar_url', COALESCE(v_card.photo_url, ua.avatar_url)),
               ua.branch_id
        INTO v_athlete_filtered, v_child_branch
        FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;

        IF COALESCE((v_show->>'doc_number')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('doc_type', ua.doc_type, 'doc_number', ua.doc_number)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'blood_type')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('blood_type', ua.blood_type)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'eps')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object('eps_name', ua.eps_name)
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;
        IF COALESCE((v_show->>'emergency_contact')::boolean, false) THEN
            SELECT COALESCE(v_athlete_filtered, '{}'::jsonb) || jsonb_build_object(
                     'emergency_contact',
                     NULLIF(btrim(COALESCE(ua.guardian_full_name, '') || ' ' || COALESCE(ua.guardian_phone, '')), '')
                   )
            INTO v_athlete_filtered FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id;
        END IF;

        IF COALESCE((v_show->>'branch')::boolean, true) THEN
            SELECT name INTO v_branch_name FROM public.school_branches WHERE id = v_child_branch;
        END IF;
        IF COALESCE((v_show->>'team')::boolean, true) THEN
            SELECT t.name INTO v_team_name
            FROM public.enrollments e
            JOIN public.teams t ON t.id = e.team_id
            WHERE e.unregistered_athlete_id = v_card.unregistered_athlete_id
              AND e.school_id = v_card.school_id AND e.status = 'active'
            ORDER BY e.created_at LIMIT 1;
        END IF;
    END IF;

    -- Si la fila del atleta desapareció, el objeto nunca queda NULL.
    v_athlete_filtered := COALESCE(v_athlete_filtered, jsonb_build_object('kind', v_kind));

    IF COALESCE((v_show->>'fee_status')::boolean, false) AND v_card.unregistered_athlete_id IS NULL THEN
        SELECT jsonb_build_object('concept', p.concept, 'amount', p.amount, 'amount_paid', p.amount_paid,
                                  'payment_date', p.payment_date, 'created_at', p.created_at,
                                  'provider_reference', p.provider_reference, 'payment_method', p.payment_method),
               COALESCE(p.payment_date, p.created_at::date)
          INTO v_last_payment, v_last_paid
          FROM public.payments p
         WHERE p.school_id = v_card.school_id
           AND p.status = 'paid'
           AND ((v_card.child_id IS NOT NULL AND (p.child_id = v_card.child_id OR (p.child_id IS NULL AND v_child_parent IS NOT NULL AND p.parent_id = v_child_parent)))
                OR (v_card.profile_id IS NOT NULL AND p.parent_id = v_card.profile_id))
         ORDER BY COALESCE(p.payment_date, p.created_at::date) DESC, p.created_at DESC
         LIMIT 1;

        IF v_last_paid IS NULL THEN
            v_fee_status := 'no_payments';
            v_last_payment := NULL;
        ELSE
            IF v_today - v_last_paid <= 30 THEN
                v_fee_status := 'paid';
            ELSIF v_today - v_last_paid <= 45 THEN
                v_fee_status := 'due_soon';
            ELSE
                v_fee_status := 'overdue';
            END IF;
            v_next_due := v_last_paid + interval '30 days';
        END IF;
    ELSE
        v_fee_status := NULL;
        v_last_paid := NULL;
        v_next_due := NULL;
        v_monthly_fee := NULL;
        v_last_payment := NULL;
    END IF;

    -- Carnet 3D (F1): número y posición van en el frente, no son datos privados.
    v_np := public._carnet_numero_posicion(v_card.school_id, v_card.child_id,
                                           v_card.profile_id, v_card.unregistered_athlete_id);

    RETURN jsonb_build_object(
        'found', true,
        'status', 'active',
        'viewer', v_viewer,
        'card_id', v_card.id,
        'qr_token', v_card.qr_token,
        'codigo', v_card.codigo,
        'numero', v_np->'numero',
        'posicion', v_np->'posicion',
        'issued_at', v_card.issued_at,
        'valid_until', v_card.valid_until,
        'version', v_card.version,
        'school', jsonb_build_object('id', v_school.id, 'name', v_school.name, 'slug', v_school.slug,
                                     'logo_url', v_school.logo_url, 'branding_settings', v_school.branding_settings),
        'template', CASE WHEN v_template.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', v_template.id,
            'name', v_template.name,
            'accent_color', v_template.accent_color,
            'secondary_color', v_template.secondary_color,
            'layout', v_template.layout,
            'pattern', v_template.pattern,
            'photo_shape', v_template.photo_shape,
            'text_mode', v_template.text_mode,
            'background_url', v_template.background_url,
            'header_text', v_template.header_text,
            'footer_text', v_template.footer_text,
            -- show_fields EFECTIVOS (con lo privado apagado para el público):
            -- el frontend decide qué filas pinta con esto.
            'show_fields', v_show) END,
        'athlete', v_athlete_filtered,
        'branch_name', v_branch_name,
        'team_name', v_team_name,
        'monthly_fee', v_monthly_fee,
        'fee_status', v_fee_status,
        'last_paid_at', v_last_paid,
        'next_due', v_next_due,
        'last_payment', v_last_payment
    );
END;
$function$;

-- Flujo público demostrado: /c/:token sin sesión (sin cambio de permisos).
REVOKE ALL ON FUNCTION public.verify_athlete_id_card_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_athlete_id_card_public(uuid) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) Verificación por código digitado (enmascarada)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verificar_carnet_por_codigo(p_codigo text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_codigo text := upper(btrim(COALESCE(p_codigo, '')));
    v_card   record;
    v_nombre text;
    v_estado text;
    v_hoy    date := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
    IF v_codigo !~ '^SM-[0-9]{4}-[0-9]{5}$' THEN
        RETURN jsonb_build_object('found', false, 'motivo', 'formato');
    END IF;

    SELECT c.id, c.status, c.valid_until, c.child_id, c.profile_id, c.unregistered_athlete_id,
           s.name AS club, s.logo_url
      INTO v_card
      FROM public.athlete_id_cards c
      JOIN public.schools s ON s.id = c.school_id
     WHERE c.codigo = v_codigo;

    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false, 'motivo', 'no_existe');
    END IF;

    SELECT COALESCE(
             (SELECT ch.full_name FROM public.children ch WHERE ch.id = v_card.child_id),
             (SELECT p.full_name FROM public.profiles p WHERE p.id = v_card.profile_id),
             (SELECT ua.full_name FROM public.unregistered_athletes ua WHERE ua.id = v_card.unregistered_athlete_id))
      INTO v_nombre;

    v_estado := CASE WHEN v_card.status = 'revoked' THEN 'revoked'
                     WHEN v_card.status = 'expired' OR v_card.valid_until < v_hoy THEN 'expired'
                     ELSE 'active' END;

    RETURN jsonb_build_object(
        'found',  true,
        'codigo', v_codigo,
        'estado', v_estado,
        'valido', v_estado = 'active',
        'nombre', public._nombre_enmascarado(v_nombre),
        'club',   jsonb_build_object('name', v_card.club, 'logo_url', v_card.logo_url));
END;
$function$;

-- Flujo público: quien recibe el carnet en papel digita el código sin sesión.
REVOKE ALL ON FUNCTION public.verificar_carnet_por_codigo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verificar_carnet_por_codigo(text) TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) Reverso del carnet
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.card_back_data(p_qr_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_uid      uuid := (SELECT auth.uid());
    v_card     record;
    v_tipo     text;
    v_sujeto   uuid;
    v_team     uuid;
    v_sport    text;
    v_deporte  text;
    v_np       jsonb;
    v_freq     text;
    v_total    int;
    v_asist    int;
    v_desde    date;
    v_inf_y    int;
    v_inf_m    int;
    v_meses    int;
    v_hoy      date := (now() AT TIME ZONE 'America/Bogota')::date;
    c_meses constant text[] := ARRAY['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    SELECT * INTO v_card FROM public.athlete_id_cards WHERE qr_token = p_qr_token;
    IF v_card.id IS NULL THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    -- Personal de la escuela del carnet, acudiente o el deportista adulto.
    IF NOT (   public.is_super_admin()
            OR v_card.school_id = ANY ((SELECT public.user_staff_school_ids())::uuid[])
            OR (v_card.profile_id IS NOT NULL AND v_card.profile_id = v_uid)
            OR (v_card.child_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.children cc
                     WHERE cc.id = v_card.child_id AND cc.parent_id = v_uid))) THEN
        RETURN jsonb_build_object('found', false);
    END IF;

    v_tipo   := CASE WHEN v_card.child_id IS NOT NULL THEN 'child'
                     WHEN v_card.profile_id IS NOT NULL THEN 'profile'
                     ELSE 'unregistered' END;
    v_sujeto := COALESCE(v_card.child_id, v_card.profile_id, v_card.unregistered_athlete_id);

    -- Equipo: la inscripción activa más reciente; si no, el equipo del menor.
    SELECT e.team_id INTO v_team
      FROM public.enrollments e
     WHERE e.school_id = v_card.school_id AND e.status = 'active' AND e.team_id IS NOT NULL
       AND (   (v_tipo = 'child' AND e.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND e.user_id = v_sujeto AND e.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND e.unregistered_athlete_id = v_sujeto))
     ORDER BY e.created_at DESC
     LIMIT 1;
    IF v_team IS NULL AND v_tipo = 'child' THEN
        SELECT ch.team_id INTO v_team FROM public.children ch WHERE ch.id = v_sujeto;
    END IF;

    SELECT t.sport INTO v_sport FROM public.teams t WHERE t.id = v_team;
    v_deporte := CASE WHEN translate(lower(COALESCE(v_sport, '')), 'áéíóú', 'aeiou') LIKE 'futbol%'
                      THEN 'futbol' ELSE 'generico' END;

    -- Zona de juego (D1): posición asignada; si no hay, la más frecuente de
    -- las últimas 10 alineaciones.
    v_np := public._carnet_numero_posicion(v_card.school_id, v_card.child_id,
                                           v_card.profile_id, v_card.unregistered_athlete_id);
    SELECT x.position_code INTO v_freq
      FROM (SELECT lp.position_code
              FROM public.match_lineup_players lp
              JOIN public.match_lineups ml ON ml.id = lp.lineup_id
             WHERE lp.school_id = v_card.school_id AND lp.subject_type = v_tipo
               AND lp.subject_id = v_sujeto AND lp.position_code IS NOT NULL
             ORDER BY ml.created_at DESC
             LIMIT 10) x
     GROUP BY x.position_code
     ORDER BY count(*) DESC, x.position_code
     LIMIT 1;

    -- Asistencia de los últimos 90 días (las excusas no cuentan en contra).
    SELECT count(*) FILTER (WHERE ar.status <> 'excused'),
           count(*) FILTER (WHERE ar.status IN ('present', 'late'))
      INTO v_total, v_asist
      FROM public.attendance_records ar
     WHERE ar.school_id = v_card.school_id
       AND ar.attendance_date BETWEEN v_hoy - 90 AND v_hoy
       AND (   (v_tipo = 'child' AND ar.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND ar.user_id = v_sujeto AND ar.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND ar.unregistered_athlete_id = v_sujeto));

    SELECT min(e.start_date) INTO v_desde
      FROM public.enrollments e
     WHERE e.school_id = v_card.school_id
       AND (   (v_tipo = 'child' AND e.child_id = v_sujeto)
            OR (v_tipo = 'profile' AND e.user_id = v_sujeto AND e.child_id IS NULL)
            OR (v_tipo = 'unregistered' AND e.unregistered_athlete_id = v_sujeto));

    SELECT r.period_year, r.period_month INTO v_inf_y, v_inf_m
      FROM public.athlete_reports r
     WHERE r.school_id = v_card.school_id AND r.subject_type = v_tipo
       AND r.subject_id = v_sujeto AND r.status = 'publicado'
     ORDER BY r.period_year DESC, r.period_month DESC
     LIMIT 1;

    IF v_desde IS NOT NULL THEN
        v_meses := (EXTRACT(year FROM age(v_hoy, v_desde)) * 12 + EXTRACT(month FROM age(v_hoy, v_desde)))::int;
    END IF;

    RETURN jsonb_build_object(
        'found', true,
        'estado', v_card.status,
        'deporte', v_deporte,
        'deporte_nombre', v_sport,
        'zona_de_juego', jsonb_build_object(
            'posicion', COALESCE(v_np->>'posicion', v_freq),
            'numero',   v_np->'numero',
            'origen',   CASE WHEN v_np->>'posicion' IS NOT NULL THEN v_np->>'origen'
                             WHEN v_freq IS NOT NULL THEN 'alineaciones' END),
        'estadisticas', jsonb_build_array(
            jsonb_build_object('clave', 'asistencia', 'etiqueta', 'Asistencia', 'detalle', 'últimos 90 días',
                'valor', CASE WHEN v_total > 0 THEN round(100.0 * v_asist / v_total)::int || ' %' END),
            jsonb_build_object('clave', 'sesiones', 'etiqueta', 'Sesiones', 'detalle', 'últimos 90 días',
                'valor', CASE WHEN v_total > 0 OR v_asist > 0 THEN v_asist::text END),
            jsonb_build_object('clave', 'ultimo_informe', 'etiqueta', 'Último informe', 'detalle', NULL,
                'valor', CASE WHEN v_inf_y IS NOT NULL THEN c_meses[v_inf_m] || ' ' || v_inf_y END),
            jsonb_build_object('clave', 'antiguedad', 'etiqueta', 'En el club', 'detalle', NULL,
                'valor', CASE WHEN v_meses IS NULL THEN NULL
                              WHEN v_meses < 1 THEN 'menos de 1 mes'
                              WHEN v_meses = 1 THEN '1 mes'
                              WHEN v_meses < 12 THEN v_meses || ' meses'
                              WHEN v_meses < 24 THEN '1 año'
                              ELSE (v_meses / 12) || ' años' END)),
        'origen', 'generico');
END;
$function$;

-- Requiere sesión; nunca anon.
REVOKE ALL ON FUNCTION public.card_back_data(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.card_back_data(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
