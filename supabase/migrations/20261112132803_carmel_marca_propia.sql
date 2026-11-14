-- =============================================================================
-- 20261112132803_carmel_marca_propia.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-12   Versión anterior: 20261112122901
-- Objetivo: Carmel Club Campestre ve su logo y su nombre en toda la app (marca propia, sin app nativa).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · Las funciones nuevas nacen SIN EXECUTE (salvo dueño y service_role):
--     REVOKE ALL ON FUNCTION … FROM PUBLIC, anon;
--     GRANT EXECUTE ON FUNCTION … TO authenticated;   -- o la pantalla da 42501/403
--     anon solo con flujo público demostrado. SECURITY DEFINER no exime al caller.
--   · Helper usado en una POLICY (USING / WITH CHECK): SÍ GRANT EXECUTE a
--     authenticated (y a anon si la policy alcanza a anon en una tabla que lee);
--     la policy corre con el rol de quien consulta: sin GRANT, 42501 en toda la tabla.
--   · Helper que solo llama otra función SECURITY DEFINER: REVOKE ALL … FROM
--     PUBLIC, anon, authenticated y sin GRANT.
--   · RPC que recibe id de escuela/usuario: validar alcance del caller sobre ESE id.
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================

BEGIN;

-- Carmel (374a6716-…) revisa la app completa; pidió verla con su logo y su nombre.
-- Producto: addon pwa_branding (se le MUESTRA su marca). NO es whitelabel: el
-- «Powered by SportMaps» se queda (show_sportmaps_watermark = true).
-- Se escribe como postgres (pasa el trigger enforce_branding_via_rpc); el gate por
-- tier de update_school_branding no aplica porque Carmel es free/trial_expired y
-- no paga. El archivo del logo lo sube bff/scripts/carmel-marca.ts (misma ruta).

SELECT set_config('app.branding_via_rpc', 'true', true);

INSERT INTO public.school_addons (school_id, addon_key, enabled, enabled_at, monthly_price_cents, metadata)
VALUES ('374a6716-af42-4745-afe1-8d089153e01b', 'pwa_branding', true, now(), 0,
        jsonb_build_object('via', 'carmel_marca_propia_2026_11_12',
                           'nota', 'Cliente de referencia que no paga: se le muestra su logo y nombre. NO incluye app nativa ni apaga el watermark.'))
ON CONFLICT (school_id, addon_key) DO UPDATE
   SET enabled = true, enabled_at = now(), disabled_at = NULL, updated_at = now();

UPDATE public.schools
   SET name = 'Carmel Club Campestre',
       logo_url = 'https://luebjarufsiadojhvxgi.supabase.co/storage/v1/object/public/school-assets/logos/374a6716-af42-4745-afe1-8d089153e01b/logo.jpg',
       branding_settings = COALESCE(branding_settings, '{}'::jsonb)
           || jsonb_build_object('primary_color', '#1D6FB8', 'secondary_color', '#0F172A', 'show_sportmaps_watermark', true),
       updated_at = now()
 WHERE id = '374a6716-af42-4745-afe1-8d089153e01b';

COMMIT;
