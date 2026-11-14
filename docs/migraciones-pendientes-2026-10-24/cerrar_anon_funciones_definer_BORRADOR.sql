-- =============================================================================
-- Cerrar a anon las funciones SECURITY DEFINER que no necesita — BORRADOR 2026-10-24
-- Origen: linter de Supabase 0028 (anon_security_definer_function_executable), 136 funciones.
-- Esta migración revoca 72. Se quedan abiertas (a propósito):
--   · 22 usadas por policies para anon/public (revocarlas rompería esas consultas con 403)
--   · los flujos que corren SIN sesión: unirse por QR / enlace de equipo o plan, verificación de
--     carnets y certificados, perfil público de la escuela, demo, leads, invitaciones, explorar
--   · get_single_branch_id, is_school_open_now, school_is_operational (las usan vistas que anon lee)
--   · 8 funciones de trigger (no se pueden llamar sueltas)
-- Por qué «FROM PUBLIC, anon»: 52 de estas funciones tienen EXECUTE por el pseudo-rol PUBLIC;
--   revocar solo de anon no cambiaría nada (CLAUDE.md, trampa 3). Se re-otorga explícitamente a
--   authenticated y service_role, que HOY ya la tienen todas (verificado), así que no se amplía nada.
-- Efecto esperado: PostgREST /rest/v1/rpc/<fn> sin sesión responde 401/403 en estas 72;
--   con sesión (authenticated) y desde el BFF (service_role) todo igual.
-- NO EJECUTADA. Reversa: GRANT EXECUTE ON FUNCTION <fn> TO anon (migración nueva).
-- =============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION public._order_belongs_to_user(p_order_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._order_belongs_to_user(p_order_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public._order_has_vendor_item(p_order_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._order_has_vendor_item(p_order_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_list_enrollment_integrity_findings(p_status text, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_enrollment_integrity_findings(p_status text, p_limit integer, p_offset integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_resolve_enrollment_integrity_finding(p_finding_id uuid, p_status text, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_enrollment_integrity_finding(p_finding_id uuid, p_status text, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_run_enrollment_integrity_check() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_run_enrollment_integrity_check() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.admin_set_saas_billing_enabled(p_school_id uuid, p_enabled boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_saas_billing_enabled(p_school_id uuid, p_enabled boolean) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.can_admin_see_member_profile(p_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_admin_see_member_profile(p_profile_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.can_manage_reports(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_reports(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_is_branch_admin(check_branch_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_branch_admin(check_branch_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_is_school_admin(check_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_school_admin(check_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_is_school_admin_safe(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_school_admin_safe(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_is_school_member(check_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_school_member(check_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.check_is_school_member_safe(lookup_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_school_member_safe(lookup_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.coach_can_see_report(p_report_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.coach_can_see_report(p_report_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.current_staff_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_staff_ids() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.current_staff_team_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_staff_team_ids() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_accept(p_assignment_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_accept(p_assignment_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_approve_delivery(p_assignment_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_approve_delivery(p_assignment_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_approve_return(p_return_id uuid, p_final_condition text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_approve_return(p_return_id uuid, p_final_condition text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_assign(p_item_id uuid, p_assigned_to uuid, p_quantity integer, p_branch_id uuid, p_return_due_at date, p_note text, p_photo_url text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_assign(p_item_id uuid, p_assigned_to uuid, p_quantity integer, p_branch_id uuid, p_return_due_at date, p_note text, p_photo_url text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_assignment_detail(p_assignment_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_assignment_detail(p_assignment_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_available_for_self_checkout(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_available_for_self_checkout(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_close_with_shortage(p_assignment_id uuid, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_close_with_shortage(p_assignment_id uuid, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_dispute_return(p_return_id uuid, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_dispute_return(p_return_id uuid, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_list_coaches(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_list_coaches(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_list_items(p_school_id uuid, p_branch_id uuid, p_status text, p_search text, p_limit integer, p_offset integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_list_items(p_school_id uuid, p_branch_id uuid, p_status text, p_search text, p_limit integer, p_offset integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_my_assignments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_my_assignments() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_pending_approvals(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_pending_approvals(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_reject_delivery(p_assignment_id uuid, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_reject_delivery(p_assignment_id uuid, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_report_difference(p_assignment_id uuid, p_reported_quantity integer, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_report_difference(p_assignment_id uuid, p_reported_quantity integer, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_request_return(p_assignment_id uuid, p_quantity integer, p_condition text, p_photo_url text, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_request_return(p_assignment_id uuid, p_quantity integer, p_condition text, p_photo_url text, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_resolve_dispute(p_assignment_id uuid, p_action text, p_new_quantity integer, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_resolve_dispute(p_assignment_id uuid, p_action text, p_new_quantity integer, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_save_settings(p_school_id uuid, p_self_checkout_enabled boolean, p_require_photo_admin_mode boolean, p_default_return_days integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_save_settings(p_school_id uuid, p_self_checkout_enabled boolean, p_require_photo_admin_mode boolean, p_default_return_days integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_self_checkout(p_item_id uuid, p_quantity integer, p_photo_url text, p_branch_id uuid, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_self_checkout(p_item_id uuid, p_quantity integer, p_photo_url text, p_branch_id uuid, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_set_acta_pdf_url(p_assignment_id uuid, p_pdf_url text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_set_acta_pdf_url(p_assignment_id uuid, p_pdf_url text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_soft_delete_item(p_item_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_soft_delete_item(p_item_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.equipment_upsert_item(p_school_id uuid, p_name text, p_quantity_total integer, p_id uuid, p_branch_id uuid, p_size text, p_condition text, p_photo_url text, p_self_checkout_override text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.equipment_upsert_item(p_school_id uuid, p_name text, p_quantity_total integer, p_id uuid, p_branch_id uuid, p_size text, p_condition text, p_photo_url text, p_self_checkout_override text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_is_admin_of_school(lookup_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_admin_of_school(lookup_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.generate_report_drafts(p_school_id uuid, p_year smallint, p_month smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_report_drafts(p_school_id uuid, p_year smallint, p_month smallint) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_athlete_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_athlete_dashboard_stats() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_distance_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_distance_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_my_administered_school_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_administered_school_ids() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_school_id_by_slug(p_slug text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_school_id_by_slug(p_slug text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_shipping_quote_mock(p_origin_city text, p_destination_city text, p_weight_grams integer, p_vendor_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_shipping_quote_mock(p_origin_city text, p_destination_city text, p_weight_grams integer, p_vendor_profile_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_tournament_invitation_public(p_token uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tournament_invitation_public(p_token uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.glosa_dashboard(p_school_id uuid, p_from date, p_to date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.glosa_dashboard(p_school_id uuid, p_from date, p_to date) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.has_entitlement(p_school_id uuid, p_key text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_entitlement(p_school_id uuid, p_key text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.has_role(req_role text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(req_role text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.hold_athlete_report(p_report_id uuid, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hold_athlete_report(p_report_id uuid, p_reason text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_gov_entity(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_gov_entity(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_non_saas_entity(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_non_saas_entity(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_school_general_admin(check_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_school_general_admin(check_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_school_owner(lookup_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_school_owner(lookup_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_store_vendor(p_vendor_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_store_vendor(p_vendor_profile_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.list_school_plans(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_school_plans(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.mark_report_viewed(p_report_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_report_viewed(p_report_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.publish_athlete_report(p_report_id uuid, p_snapshot jsonb, p_override_note boolean, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_athlete_report(p_report_id uuid, p_snapshot jsonb, p_override_note boolean, p_reason text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.publish_team_reports(p_school_id uuid, p_team_id uuid, p_year smallint, p_month smallint, p_snapshots jsonb, p_override_note boolean, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_team_reports(p_school_id uuid, p_team_id uuid, p_year smallint, p_month smallint, p_snapshots jsonb, p_override_note boolean, p_reason text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.regenerate_report_snapshot(p_report_id uuid, p_snapshot jsonb, p_reason text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_report_snapshot(p_report_id uuid, p_snapshot jsonb, p_reason text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.report_coverage(p_school_id uuid, p_year smallint, p_month smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_coverage(p_school_id uuid, p_year smallint, p_month smallint) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.reschedule_pending_reports(p_school_id uuid, p_year smallint, p_month smallint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reschedule_pending_reports(p_school_id uuid, p_year smallint, p_month smallint) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.rpc_process_upgrade_request(p_request_id uuid, p_notes text, p_amount_cents integer, p_contact_method text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_process_upgrade_request(p_request_id uuid, p_notes text, p_amount_cents integer, p_contact_method text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.school_has_native_app(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.school_has_native_app(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.school_shows_own_brand(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.school_shows_own_brand(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.schools_near_location(p_lat numeric, p_lng numeric, p_radius_km numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schools_near_location(p_lat numeric, p_lng numeric, p_radius_km numeric) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.search_marketplace(p_query text, p_category text, p_type text, p_city text, p_price_max numeric, p_service_type text, p_page integer, p_limit integer, p_order_by text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_marketplace(p_query text, p_category text, p_type text, p_city text, p_price_max numeric, p_service_type text, p_page integer, p_limit integer, p_order_by text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.set_athlete_report_note(p_report_id uuid, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_athlete_report_note(p_report_id uuid, p_note text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.store_payment_methods(p_vendor_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_payment_methods(p_vendor_profile_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.store_pilot_allowlist() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_pilot_allowlist() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_school_role(p_school_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_school_role(p_school_id uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.validate_athlete_age(p_birth_year integer, p_category_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_athlete_age(p_birth_year integer, p_category_id uuid) TO authenticated, service_role;

COMMIT;

-- Verificación posterior (debe devolver 0 filas de las revocadas; las que se quedan siguen apareciendo):
--   select p.proname from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef
--     and has_function_privilege('anon', p.oid, 'EXECUTE') order by 1;
-- Y probar sin sesión una función que se queda (p. ej. verify_athlete_certificate_public) y una revocada:
--   set local role anon; select public.admin_run_enrollment_integrity_check();  -- debe dar permission denied
