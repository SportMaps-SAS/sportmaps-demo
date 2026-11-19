-- =============================================================================
-- 20261119125245_invariantes_excepciones_i6_i7.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-11-19   Versión anterior: 20261119125234
-- Objetivo: quitar falsos positivos del detector invariantes_seguridad() sin
--   debilitarlo. Reemite la función COMPLETA a partir del cuerpo VIVO leído de
--   pg_proc el 2026-11-19 (I1..I7 intactos); solo cambian tres listas.
--   Ref: docs/auditoria-i3-i6-2026-11-18.md (I6) y
--        docs/revision-migracion-y-i7-2026-11-18.md (Parte B, I7).
--
-- QUÉ CAMBIA
--   I6: la lista fija de vistas excluidas suma 'v_payment_adjustments_familia'.
--       Es intencional: security_barrier=true, dueño postgres, y filtra por
--       auth.uid() (acudiente titular del cobro); con security_invoker devolvería
--       0 filas a toda familia porque no tiene policy sobre payment_adjustments.
--       Riesgo residual (documentado): si alguien quita el filtro auth.uid() del
--       WHERE, fuga total; conviene test de regresión (acudiente no ve ajustes ajenos).
--   I7 (gate válido), regex del cuerpo: se aceptan además
--       · helpers delegados: retiro_actor, retiro_titular, retiro_es_admin,
--         _referral_assert_scope (todos con auth.uid() adentro, REVOKE a
--         authenticated, solo los llaman otras definer);
--       · patrón envoltorio + __interno: cuerpo con una llamada a <nombre>__interno(
--         (las __interno tienen REVOKE a authenticated y el gate vive en ellas:
--         request/issue_athlete_certificate, create_school_join_qr).
--   I7 (excepción documentada por nombre): get_tactical_shared_play, RPC pública a
--       propósito cuyo control es un token capability (144 bits, regex de formato,
--       índice único, status='active'; devuelve solo title/sport/payload/created_at).
--   Con eso los 13 falsos positivos revisados dejan de marcarse; get_personal_trainer_school_id
--   deja de marcarse por la migración 20261119125220 (ahora usa auth.uid()).
--   LIMITACIÓN: el patrón __interno y los helpers se aceptan por NOMBRE en el
--   cuerpo, no se verifica que el helper realmente exista o gate: si se renombra
--   o se vacía un helper, el detector no lo ve. Revisar al tocar esos helpers.
--
-- RADIO DE IMPACTO: ninguno sobre datos ni permisos. Es solo la función de
--   diagnóstico (STABLE SECURITY DEFINER, search_path fijo, ejecutable solo por
--   postgres y service_role: ACL viva {postgres, service_role}). Cambia solo cuántas
--   filas devuelve: I6 pierde 1, I7 pierde hasta 14 (las 13 revisadas + trainer).
--
-- ROLLBACK: reemitir la función con las tres listas anteriores (I6: solo
--   'v_school_staff_publico' y 'v_school_settings_publico'; regex sin
--   retiro_actor|retiro_titular|retiro_es_admin|_referral_assert_scope|__interno(;
--   lista de nombres sin 'get_tactical_shared_play'), cuerpo en 20261005131059.
--
-- DESPUÉS DE APLICAR (solo lectura, sin simulación de sesión):
--   npm run seguridad:invariantes  → I6 = 0; I7 baja de 14 a lo que quede real;
--   I3 = 2 si la migración 20261119125234 ya se aplicó. Esperado: I1, I2, I4, I5
--   sin cambio. No cambia esquema: NO regenerar types.ts.
--   Verificación puntual de los privilegios:
--     select proacl from pg_proc where proname = 'invariantes_seguridad';  -- {postgres,service_role}
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.invariantes_seguridad()
 RETURNS TABLE(invariante text, gravedad text, objeto text, detalle text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
    SELECT 'I1_tabla_privada_publica'::text, 'CRITICA'::text, p.tablename::text,
        ('policy "' || p.policyname || '" es USING(true), alcanza a ' || p.roles::text || ' y anon tiene SELECT')::text
      FROM pg_policies p JOIN pg_class c ON c.relname = p.tablename JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     WHERE p.schemaname = 'public' AND c.relkind = 'r' AND p.cmd IN ('SELECT','ALL') AND p.permissive = 'PERMISSIVE'
       AND btrim(coalesce(p.qual,'')) IN ('true','(true)') AND (p.roles::text[] && ARRAY['public','anon']) AND has_table_privilege('anon', c.oid, 'SELECT')
       AND p.tablename NOT IN ('schools','school_branches','teams','classes','facilities','events','event_categories_config','event_price_phases','products','product_images','product_variants','product_brands','product_brand_categories','product_categories','product_questions','product_reviews','product_review_media','product_review_votes','reviews','vendor_reviews','vendor_profiles','service_listings','service_variations','service_availability','offerings','offering_plans','subscription_plans','sports_categories','sports_equipment','sport_configs','sport_category_templates','sport_metric_definitions','sport_metric_thresholds','exercise_analyzers','exercise_analyzer_mappings','marketplace_shipping_zones','marketplace_shipping_rates','shipping_zones','platform_config','school_availability','coach_availability','school_onboarding_configs','trainer_profiles','template_variables','attendance_polls','roles')
    UNION ALL
    SELECT 'I2_familia_puede_escribir'::text, 'CRITICA'::text, (p.tablename || '.' || p.policyname)::text, ('policy ' || p.cmd || ' usa user_school_ids() sin chequeo de rol')::text
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.cmd IN ('ALL','INSERT','UPDATE','DELETE')
       AND (coalesce(p.qual,'') LIKE '%user_school_ids%' OR coalesce(p.with_check,'') LIKE '%user_school_ids%')
       AND coalesce(p.qual,'') || coalesce(p.with_check,'') NOT LIKE '%role%' AND NOT (p.tablename = 'school_staff' AND p.policyname = 'Staff manage themselves')
    UNION ALL
    SELECT 'I3_for_all_sin_with_check'::text, 'ALTA'::text, (p.tablename || '.' || p.policyname)::text, 'FOR ALL sin WITH CHECK: el USING valida los INSERT'::text
      FROM pg_policies p WHERE p.schemaname = 'public' AND p.cmd = 'ALL' AND p.permissive = 'PERMISSIVE' AND p.with_check IS NULL AND p.qual IS NOT NULL
    UNION ALL
    SELECT 'I4_definer_sin_search_path'::text, 'MEDIA'::text, p.proname::text, 'SECURITY DEFINER sin SET search_path'::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef
       AND (p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'))
    UNION ALL
    SELECT 'I5_truncate_a_usuario_comun'::text, 'CRITICA'::text, c.relname::text, ('el rol ' || r.rolname || ' puede TRUNCATE, y TRUNCATE no pasa por RLS')::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN (SELECT unnest(ARRAY['authenticated','anon']) AS rolname) r
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
    UNION ALL
    SELECT 'I6_vista_definer_expuesta'::text, 'ALTA'::text, c.relname::text,
        ('vista sin security_invoker, SELECT para: ' || array_to_string(ARRAY(SELECT r FROM unnest(ARRAY['anon','authenticated']) r WHERE has_table_privilege(r, c.oid, 'SELECT')), ', '))::text
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'v'
       AND lower(coalesce((SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'), 'false')) NOT IN ('true','on','yes','1')
       AND (has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT'))
       AND c.relname NOT IN ('v_school_staff_publico', 'v_school_settings_publico', 'v_payment_adjustments_familia')
    UNION ALL
    SELECT 'I7_rpc_definer_sin_gate'::text,
        CASE WHEN f.anon_x AND f.escribe THEN 'CRITICA' WHEN f.anon_x OR f.escribe THEN 'ALTA' ELSE 'MEDIA' END::text,
        (f.proname || '(' || f.args || ')')::text,
        ('SECURITY DEFINER sin chequeo de identidad/escuela; EXECUTE para: ' || CASE WHEN f.anon_x THEN 'anon, ' ELSE '' END || 'authenticated' || CASE WHEN f.escribe THEN ' — ESCRIBE' ELSE '' END)::text
      FROM (SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
                   has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
                   p.prosrc ~* '\m(insert|update|delete)\M' AS escribe, p.prosrc
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype <> 'trigger'::regtype) f
     WHERE (f.anon_x OR f.auth_x)
       AND f.prosrc !~* ('auth\.(uid|role|jwt|email)|is_super_admin|is_platform_admin|is_admin\(|is_school_admin|is_school_staff|user_(admin_|staff_)?school_ids|can_manage|_store_actor|coach_can|current_staff|is_support_agent|_glosa_actor|has_school_role|check_is_|_puede_ver_|_es_llamada_de_servidor|retiro_actor|retiro_titular|retiro_es_admin|_referral_assert_scope|__interno(')
       AND f.proname NOT IN ('search_schools','search_marketplace','search_explore_map','schools_near_location','get_distance_km','get_school_by_slug','get_school_id_by_slug','get_school_id_by_custom_domain','get_school_lead_landing_public','list_open_trial_slots_public','submit_school_lead','get_public_program_slots','get_plan_join_info','get_team_join_info','get_join_qr_public','validate_child_for_team_join','validate_doc_for_plan_join','validate_athlete_age','buscar_menor_por_documento_publico','verify_athlete_certificate_public','verify_athlete_id_card_public','get_tournament_invitation_public','get_school_branding_by_invitation','get_invitation_details','accept_invitation','access_demo_link','get_school_services','is_school_open_now','get_shipping_quote_mock','get_school_payment_info','has_entitlement','school_has_addon','school_has_branding_feature','school_has_custom_domain_feature','school_has_native_app','school_is_operational','school_shows_own_brand','is_gov_entity','is_non_saas_entity','get_single_branch_id','store_enabled','store_pilot_allowlist','store_seller_allowed','store_payment_methods','get_available_slots','get_trainer_athlete_ids','is_school_member','is_coach_parent_messaging_blocked','calendar_team_in_school','match_evaluation_visible_to_family','order_belongs_to_store','can_manage_finances','create_invitation','invite_parent_to_school','get_athlete_payments_v2','get_tactical_shared_play')
$function$;

REVOKE ALL ON FUNCTION public.invariantes_seguridad() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invariantes_seguridad() TO service_role;

COMMIT;
