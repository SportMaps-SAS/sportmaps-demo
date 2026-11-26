-- =============================================================================
-- 20261126154553_carnet_identidad_club_gratis.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-26   Versión anterior: 20261126122010
-- Objetivo: los colores y el escudo del club en el carnet 3D son GRATIS para
-- todas las escuelas (decisión del usuario 2026-11-26, reemplaza D3 de
-- docs/specs/carnet-3d-club.md). update_school_branding deja de exigir
-- school_has_branding_feature (tier) para guardar colores, acento y escudo.
-- Sigue igual: solo administración de ESA escuela (owner/admin/school_admin),
-- límite de 10 cambios por hora, logo solo desde school-assets/logos/<id>/,
-- auditoría en branding_change_log, y el «Powered by SportMaps» solo lo apaga
-- quien tiene whitelabel. Mostrar la marca en la app sigue por complemento
-- (school_shows_own_brand): eso no cambia.
-- Misma firma que 20261126095105: CREATE OR REPLACE conserva permisos; se
-- reafirman igual.
-- RADIO: cualquier escuela sin plan Pro ahora puede guardar sus colores/escudo.
-- ROLLBACK: reaplicar la definición de 20261126095105.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_school_branding(
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

    -- 2026-11-26: colores y escudo del club GRATIS para todas las escuelas (el
    -- carnet los usa). Lo que sí sigue siendo de pago es MOSTRAR la marca en la
    -- app (school_shows_own_brand, por complemento) y apagar el «Powered by»
    -- (whitelabel, abajo). Por eso aquí ya no se exige school_has_branding_feature.

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

NOTIFY pgrst, 'reload schema';

COMMIT;
