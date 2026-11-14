-- COPIA PARA PEGAR de supabase/migrations/20261028111254_cerrar_anon_funciones_definer.sql
-- Preferir aplicarla por una vía que deje rastro (supabase db push / apply_migration con
-- nombre cerrar_anon_funciones_definer). Si se pega en el SQL editor, registrar después
-- la versión 20261028111254 en supabase_migrations.schema_migrations. Aplicar UNA sola vez.
-- =============================================================================
-- Cerrar a anon las funciones SECURITY DEFINER que no necesita
-- Fecha: 2026-10-28 · Versión 20261028111254
--
-- SUPERA al borrador docs/migraciones-pendientes-2026-10-24/cerrar_anon_funciones_definer_BORRADOR.sql
-- (72 revocadas, nunca aplicado). No aplicar los dos. Diferencias con aquel:
--   · mark_report_viewed ya no está en la lista (20261025003708 la cerró a anon).
--   · get_tactical_shared_play es nueva (20261027112704) y se queda abierta: /jugada/:token.
--   · Se revocan además, con su llamador revisado: los claim_*, accept_invitation,
--     complete_onboarding, get_onboarding_status, submit_qr_signup (se llaman con sesión),
--     get_school_payment_info (PaymentModal solo con usuario), validate_child_for_team_join
--     (reemplazada), access_demo_link, get_public_program_slots x2 y
--     get_school_id_by_custom_domain (sin llamador en el repo), y 9 helpers cuyas
--     policies {public} se pasan a TO authenticated (sección 1).
--
-- Estado vivo (consulta única a pg_proc + aclexplode, 2026-10-28): 823 DEFINER en public,
-- 135 ejecutables por anon. Todas con owner postgres; todas con EXECUTE para
-- authenticated y service_role.
--
-- Clasificación de las 135:
--   A  30  se QUEDAN: flujo sin sesión (con su página pública), vistas que anon
--          lee, o helpers de policies {public}/{anon} sobre tablas que anon puede leer.
--   B   8  funciones de trigger                         → revocar
--   C  20  helpers de policies solo para authenticated   → revocar
--          (9 de ellas tras pasar 13 policies {public} a TO authenticated)
--   D  77  sin uso anónimo                               → revocar
--
-- Por qué siguen abiertas is_super_admin, is_platform_admin, is_school_admin,
-- is_school_coach, user_school_ids, user_staff_school_ids, can_manage_store,
-- store_enabled, store_seller_allowed: las llaman ~130 policies {public}/{anon} sobre
-- tablas con privilegio para anon (CLAUDE.md: «Helpers de RLS: nunca revocar … al rol
-- que las invoca desde policies»). Para anon devuelven false/vacío. Cerrarlas exige una
-- fase 2 que pase esas policies a TO authenticated tabla por tabla (algunas, como las
-- de products/product_variants, sí deben seguir alcanzando a anon).
--
-- Efecto esperado: /rest/v1/rpc/<fn> sin sesión responde 401/42501 en las 105;
-- con sesión y desde el BFF (service_role) todo igual. Las 13 policies siguen dando
-- las mismas filas a authenticated y 0 a anon (como hoy).
-- Reversa: GRANT EXECUTE ON FUNCTION <firma> TO anon; y ALTER POLICY … TO public
-- (en una migración nueva).
-- Verificación: docs/migraciones-pendientes-2026-10-28/cerrar-anon-funciones-definer-verificar.sql
-- =============================================================================

BEGIN;

-- ── 1. Policies {public} que anon evaluaba sin poder ganar nada ──────────────
-- Las 13 dependen de auth.uid() (directo o vía helper): para anon siempre dan
-- false. Pasarlas a TO authenticated no le quita filas a nadie, pero deja de
-- obligar a anon a tener EXECUTE sobre sus helpers (trampa 42501: con la policy
-- en {public}, revocar el helper convierte el «0 filas» de anon en error).
-- Solo cambia el rol; USING y WITH CHECK quedan idénticos (I3 intacto).
ALTER POLICY "Children: select coach via school_staff" ON public.children TO authenticated;  -- coach_school_ids()
ALTER POLICY "Children: manage staff" ON public.children TO authenticated;  -- staff_school_ids()
ALTER POLICY "Children: select staff" ON public.children TO authenticated;  -- staff_school_ids()
ALTER POLICY "Payments: select staff" ON public.payments TO authenticated;  -- staff_school_ids()
ALTER POLICY "School members can view same-school profiles" ON public.profiles TO authenticated;  -- school_member_profile_ids()
ALTER POLICY "messages_insert_own" ON public.messages TO authenticated;  -- is_coach_parent_messaging_blocked(auth.uid(), …)
ALTER POLICY "Teams: coach manage own (scoped)" ON public.teams TO authenticated;  -- is_scoped_coach_school() AND is_own_team_coach()
ALTER POLICY "Members can view branches" ON public.school_branches TO authenticated;  -- is_school_member(auth.uid(), school_id)
ALTER POLICY "Invitations: manage staff" ON public.invitations TO authenticated;  -- user_admin_school_ids()
ALTER POLICY "Staff: manage own school" ON public.school_staff TO authenticated;  -- user_admin_school_ids()
ALTER POLICY "session_bookings_insert_with_enrollment" ON public.session_bookings TO authenticated;  -- auth.uid() / is_parent_of_child()
ALTER POLICY "session_bookings_select_own" ON public.session_bookings TO authenticated;  -- auth.uid() / is_parent_of_child() / user_school_ids()
ALTER POLICY "session_bookings_update_cancel" ON public.session_bookings TO authenticated;  -- auth.uid() / is_parent_of_child() / user_staff_school_ids()

-- ── 2. REVOKE de anon (y de PUBLIC) por firma, re-GRANT a authenticated + service_role ──
-- Hoy las 135 tienen EXECUTE para authenticated y service_role (verificado el
-- 2026-10-28); el GRANT explícito garantiza que lo conserven cuando el EXECUTE
-- les llegaba solo por PUBLIC (trampa 3). No amplía nada.

-- B · funciones de trigger: el trigger no usa el EXECUTE del rol que dispara (8)
REVOKE EXECUTE ON FUNCTION public.bloquear_atleta_duplicado() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.bloquear_atleta_duplicado() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_notify_calendar_event() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.fn_notify_calendar_event() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_notify_pause_decision() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.fn_notify_pause_decision() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_training_sessions_derive_school_id() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.fn_training_sessions_derive_school_id() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.guard_merchandise_enabled_super_admin_only() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.guard_merchandise_enabled_super_admin_only() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.guard_tournament_charges_enabled_super_admin_only() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.guard_tournament_charges_enabled_super_admin_only() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.post_training_check_daily_recap() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.post_training_check_daily_recap() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.post_training_notify_on_finalize() FROM PUBLIC, anon;  -- funcion de trigger
GRANT  EXECUTE ON FUNCTION public.post_training_notify_on_finalize() TO authenticated, service_role;

-- C · helpers de policies que solo alcanzan a authenticated (o a tablas sin privilegio para anon) (20)
REVOKE EXECUTE ON FUNCTION public._order_belongs_to_user(uuid) FROM PUBLIC, anon;  -- policy order_items (authenticated)
GRANT  EXECUTE ON FUNCTION public._order_belongs_to_user(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public._order_has_vendor_item(uuid) FROM PUBLIC, anon;  -- policy orders (authenticated)
GRANT  EXECUTE ON FUNCTION public._order_has_vendor_item(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.can_admin_see_member_profile(uuid) FROM PUBLIC, anon;  -- policy profiles (authenticated)
GRANT  EXECUTE ON FUNCTION public.can_admin_see_member_profile(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.can_manage_event(uuid,uuid) FROM PUBLIC, anon;  -- policies authenticated; event_invitations {public} pero anon sin privilegio en la tabla
GRANT  EXECUTE ON FUNCTION public.can_manage_event(uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.can_manage_reports(uuid) FROM PUBLIC, anon;  -- policies de informes (authenticated)
GRANT  EXECUTE ON FUNCTION public.can_manage_reports(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_is_school_admin(uuid) FROM PUBLIC, anon;  -- policy zk_user_mappings (authenticated)
GRANT  EXECUTE ON FUNCTION public.check_is_school_admin(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.coach_can_see_report(uuid) FROM PUBLIC, anon;  -- policy athlete_reports (authenticated)
GRANT  EXECUTE ON FUNCTION public.coach_can_see_report(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.coach_team_ids() FROM PUBLIC, anon;  -- policy enrollments {public} pero anon sin privilegio en enrollments
GRANT  EXECUTE ON FUNCTION public.coach_team_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.current_staff_team_ids() FROM PUBLIC, anon;  -- policy team_report_notes (authenticated); BFF informes
GRANT  EXECUTE ON FUNCTION public.current_staff_team_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_store_vendor(uuid) FROM PUBLIC, anon;  -- policies store_conversations/store_messages (authenticated)
GRANT  EXECUTE ON FUNCTION public.is_store_vendor(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.user_tactical_edit_school_ids() FROM PUBLIC, anon;  -- policies {public} en tablas tacticas sin privilegio para anon
GRANT  EXECUTE ON FUNCTION public.user_tactical_edit_school_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.coach_school_ids() FROM PUBLIC, anon;  -- + ALTER POLICY children (select coach) TO authenticated
GRANT  EXECUTE ON FUNCTION public.coach_school_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.staff_school_ids() FROM PUBLIC, anon;  -- + ALTER POLICY children x2 y payments (select staff) TO authenticated
GRANT  EXECUTE ON FUNCTION public.staff_school_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.school_member_profile_ids() FROM PUBLIC, anon;  -- + ALTER POLICY profiles (same-school) TO authenticated
GRANT  EXECUTE ON FUNCTION public.school_member_profile_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_coach_parent_messaging_blocked(uuid,uuid) FROM PUBLIC, anon;  -- + ALTER POLICY messages_insert_own TO authenticated
GRANT  EXECUTE ON FUNCTION public.is_coach_parent_messaging_blocked(uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_own_team_coach(uuid) FROM PUBLIC, anon;  -- + ALTER POLICY teams (coach manage own) TO authenticated
GRANT  EXECUTE ON FUNCTION public.is_own_team_coach(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_scoped_coach_school(uuid) FROM PUBLIC, anon;  -- + ALTER POLICY teams (coach manage own) TO authenticated
GRANT  EXECUTE ON FUNCTION public.is_scoped_coach_school(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_school_member(uuid,uuid) FROM PUBLIC, anon;  -- + ALTER POLICY school_branches (Members can view) TO authenticated
GRANT  EXECUTE ON FUNCTION public.is_school_member(uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.user_admin_school_ids() FROM PUBLIC, anon;  -- + ALTER POLICY invitations y school_staff (manage) TO authenticated
GRANT  EXECUTE ON FUNCTION public.user_admin_school_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_parent_of_child(uuid) FROM PUBLIC, anon;  -- + ALTER POLICY session_bookings x3 TO authenticated; resto de tablas sin privilegio para anon
GRANT  EXECUTE ON FUNCTION public.is_parent_of_child(uuid) TO authenticated, service_role;

-- D · sin uso anónimo (77)
REVOKE EXECUTE ON FUNCTION public.accept_invitation(uuid) FROM PUBLIC, anon;  -- con sesion
GRANT  EXECUTE ON FUNCTION public.accept_invitation(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.access_demo_link(text) FROM PUBLIC, anon;  -- sin llamador en el repo
GRANT  EXECUTE ON FUNCTION public.access_demo_link(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_list_enrollment_integrity_findings(text,integer,integer) FROM PUBLIC, anon;  -- AdminEnrollmentIntegrityPage
GRANT  EXECUTE ON FUNCTION public.admin_list_enrollment_integrity_findings(text,integer,integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_resolve_enrollment_integrity_finding(uuid,text,text) FROM PUBLIC, anon;  -- AdminEnrollmentIntegrityPage
GRANT  EXECUTE ON FUNCTION public.admin_resolve_enrollment_integrity_finding(uuid,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_run_enrollment_integrity_check() FROM PUBLIC, anon;  -- AdminEnrollmentIntegrityPage
GRANT  EXECUTE ON FUNCTION public.admin_run_enrollment_integrity_check() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.admin_set_saas_billing_enabled(uuid,boolean) FROM PUBLIC, anon;  -- AdminSubscriptionsPage
GRANT  EXECUTE ON FUNCTION public.admin_set_saas_billing_enabled(uuid,boolean) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_is_branch_admin(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.check_is_branch_admin(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_is_school_admin_safe(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.check_is_school_admin_safe(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_is_school_member(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.check_is_school_member(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.check_is_school_member_safe(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.check_is_school_member_safe(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.claim_child_for_parent(uuid,text,text) FROM PUBLIC, anon;  -- con sesion
GRANT  EXECUTE ON FUNCTION public.claim_child_for_parent(uuid,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.claim_children_by_document(text,uuid[],text,text) FROM PUBLIC, anon;  -- JoinTeamPage, despues de signUp y solo si hay sesion
GRANT  EXECUTE ON FUNCTION public.claim_children_by_document(text,uuid[],text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.claim_member_for_plan(uuid,uuid,text,text,text) FROM PUBLIC, anon;  -- JoinPlanPage, despues de signUp y solo si hay sesion
GRANT  EXECUTE ON FUNCTION public.claim_member_for_plan(uuid,uuid,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.claim_orphan_children(uuid) FROM PUBLIC, anon;  -- DashboardPage
GRANT  EXECUTE ON FUNCTION public.claim_orphan_children(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.complete_onboarding() FROM PUBLIC, anon;  -- onboarding y JoinSchoolPublicPage, con sesion
GRANT  EXECUTE ON FUNCTION public.complete_onboarding() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.current_staff_ids() FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.current_staff_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_accept(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_accept(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_approve_delivery(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_approve_delivery(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_approve_return(uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_approve_return(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_assign(uuid,uuid,integer,uuid,date,text,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_assign(uuid,uuid,integer,uuid,date,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_assignment_detail(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_assignment_detail(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_available_for_self_checkout(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_available_for_self_checkout(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_close_with_shortage(uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_close_with_shortage(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_dispute_return(uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_dispute_return(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_list_coaches(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_list_coaches(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_list_items(uuid,uuid,text,text,integer,integer) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_list_items(uuid,uuid,text,text,integer,integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_my_assignments() FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_my_assignments() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_pending_approvals(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_pending_approvals(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_reject_delivery(uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_reject_delivery(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_report_difference(uuid,integer,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_report_difference(uuid,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_request_return(uuid,integer,text,text,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_request_return(uuid,integer,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_resolve_dispute(uuid,text,integer,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_resolve_dispute(uuid,text,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_save_settings(uuid,boolean,boolean,integer) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_save_settings(uuid,boolean,boolean,integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_self_checkout(uuid,integer,text,uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_self_checkout(uuid,integer,text,uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_set_acta_pdf_url(uuid,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_set_acta_pdf_url(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_soft_delete_item(uuid) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_soft_delete_item(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.equipment_upsert_item(uuid,text,integer,uuid,uuid,text,text,text,text) FROM PUBLIC, anon;  -- Dotacion, con sesion
GRANT  EXECUTE ON FUNCTION public.equipment_upsert_item(uuid,text,integer,uuid,uuid,text,text,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_is_admin_of_school(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.fn_is_admin_of_school(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.generate_report_drafts(uuid,smallint,smallint) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.generate_report_drafts(uuid,smallint,smallint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_athlete_dashboard_stats() FROM PUBLIC, anon;  -- dashboard del deportista
GRANT  EXECUTE ON FUNCTION public.get_athlete_dashboard_stats() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_distance_km(numeric,numeric,numeric,numeric) FROM PUBLIC, anon;  -- helper interno de busquedas DEFINER
GRANT  EXECUTE ON FUNCTION public.get_distance_km(numeric,numeric,numeric,numeric) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_my_administered_school_ids() FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.get_my_administered_school_ids() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_onboarding_status() FROM PUBLIC, anon;  -- DashboardPage / SchoolOnboardingPage
GRANT  EXECUTE ON FUNCTION public.get_onboarding_status() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_public_program_slots(uuid,uuid,uuid) FROM PUBLIC, anon;  -- sin llamador en el repo
GRANT  EXECUTE ON FUNCTION public.get_public_program_slots(uuid,uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_public_program_slots(uuid,uuid,uuid,uuid) FROM PUBLIC, anon;  -- sin llamador en el repo
GRANT  EXECUTE ON FUNCTION public.get_public_program_slots(uuid,uuid,uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_school_id_by_custom_domain(text) FROM PUBLIC, anon;  -- sin llamador en el repo
GRANT  EXECUTE ON FUNCTION public.get_school_id_by_custom_domain(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_school_id_by_slug(text) FROM PUBLIC, anon;  -- BFF tenantBySubdomain (service_role)
GRANT  EXECUTE ON FUNCTION public.get_school_id_by_slug(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_school_payment_info(uuid) FROM PUBLIC, anon;  -- PaymentModal; SchoolDetailPage abre el login si no hay usuario
GRANT  EXECUTE ON FUNCTION public.get_school_payment_info(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_shipping_quote_mock(text,text,integer,uuid) FROM PUBLIC, anon;  -- BFF (service_role)
GRANT  EXECUTE ON FUNCTION public.get_shipping_quote_mock(text,text,integer,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_tournament_invitation_public(uuid) FROM PUBLIC, anon;  -- BFF events.route (service_role)
GRANT  EXECUTE ON FUNCTION public.get_tournament_invitation_public(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.glosa_dashboard(uuid,date,date) FROM PUBLIC, anon;  -- BFF conciliacion
GRANT  EXECUTE ON FUNCTION public.glosa_dashboard(uuid,date,date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_entitlement(uuid,text) FROM PUBLIC, anon;  -- BFF
GRANT  EXECUTE ON FUNCTION public.has_entitlement(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_role(text) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.has_role(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.hold_athlete_report(uuid,text) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.hold_athlete_report(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_gov_entity(uuid) FROM PUBLIC, anon;  -- sin llamador anonimo
GRANT  EXECUTE ON FUNCTION public.is_gov_entity(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_non_saas_entity(uuid) FROM PUBLIC, anon;  -- sin llamador anonimo
GRANT  EXECUTE ON FUNCTION public.is_non_saas_entity(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_school_general_admin(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.is_school_general_admin(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_school_owner(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.is_school_owner(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.list_school_plans(uuid) FROM PUBLIC, anon;  -- SchoolJoinQRsPage (admin)
GRANT  EXECUTE ON FUNCTION public.list_school_plans(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.publish_athlete_report(uuid,jsonb,boolean,text) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.publish_athlete_report(uuid,jsonb,boolean,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.publish_team_reports(uuid,uuid,smallint,smallint,jsonb,boolean,text) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.publish_team_reports(uuid,uuid,smallint,smallint,jsonb,boolean,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.regenerate_report_snapshot(uuid,jsonb,text) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.regenerate_report_snapshot(uuid,jsonb,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.report_coverage(uuid,smallint,smallint) FROM PUBLIC, anon;  -- BFF informes / MonthlyReportsPage
GRANT  EXECUTE ON FUNCTION public.report_coverage(uuid,smallint,smallint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.reschedule_pending_reports(uuid,smallint,smallint) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.reschedule_pending_reports(uuid,smallint,smallint) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_process_upgrade_request(uuid,text,integer,text) FROM PUBLIC, anon;  -- BFF upgrade-requests
GRANT  EXECUTE ON FUNCTION public.rpc_process_upgrade_request(uuid,text,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.school_has_native_app(uuid) FROM PUBLIC, anon;  -- pizarra, con sesion
GRANT  EXECUTE ON FUNCTION public.school_has_native_app(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.school_shows_own_brand(uuid) FROM PUBLIC, anon;  -- pizarra con sesion / BFF tenantLink
GRANT  EXECUTE ON FUNCTION public.school_shows_own_brand(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.schools_near_location(numeric,numeric,numeric) FROM PUBLIC, anon;  -- BFF explorar (service_role)
GRANT  EXECUTE ON FUNCTION public.schools_near_location(numeric,numeric,numeric) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.search_marketplace(text,text,text,text,numeric,text,integer,integer,text) FROM PUBLIC, anon;  -- BFF marketplace (service_role)
GRANT  EXECUTE ON FUNCTION public.search_marketplace(text,text,text,text,numeric,text,integer,integer,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_athlete_report_note(uuid,text) FROM PUBLIC, anon;  -- BFF informes
GRANT  EXECUTE ON FUNCTION public.set_athlete_report_note(uuid,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.store_payment_methods(uuid) FROM PUBLIC, anon;  -- BFF tienda (service_role)
GRANT  EXECUTE ON FUNCTION public.store_payment_methods(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.store_pilot_allowlist() FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.store_pilot_allowlist() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.submit_qr_signup(text,uuid,uuid,text,date,text,text,text,text,numeric,uuid,uuid,uuid) FROM PUBLIC, anon;  -- JoinSchoolPublicPage, paso posterior a signUp/login (usa auth.uid())
GRANT  EXECUTE ON FUNCTION public.submit_qr_signup(text,uuid,uuid,text,date,text,text,text,text,numeric,uuid,uuid,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.user_school_role(uuid) FROM PUBLIC, anon;  -- sin uso en policies ni llamador anonimo
GRANT  EXECUTE ON FUNCTION public.user_school_role(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.validate_athlete_age(integer,uuid) FROM PUBLIC, anon;  -- sin llamador en el repo
GRANT  EXECUTE ON FUNCTION public.validate_athlete_age(integer,uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.validate_child_for_team_join(uuid,text) FROM PUBLIC, anon;  -- reemplazada por buscar_menor_por_documento_publico
GRANT  EXECUTE ON FUNCTION public.validate_child_for_team_join(uuid,text) TO authenticated, service_role;

-- ── 3. Default privilege de supabase_admin (abierto: da EXECUTE a anon en cada función nueva) ──
-- postgres NO es miembro de supabase_admin (pg_has_role = false el 2026-10-28), así
-- que esto casi seguro falla; se intenta y se sigue, como en 20260817210308.
-- Si sale el NOTICE: paso manual. Solo supabase_admin (o soporte de Supabase) puede
-- correr ese ALTER DEFAULT PRIVILEGES; mientras tanto, la verificación lo delata en
-- la próxima función que cree ese rol (el conteo «DEFINER que anon aún ejecuta» sube).
DO $$
BEGIN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
    RAISE NOTICE 'Default privilege de supabase_admin cerrado para anon.';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'No se pudo cerrar el default privilege de supabase_admin (%). Paso manual.', SQLERRM;
END;
$$;

-- ── 4. (OPCIONAL, decidir antes) default GLOBAL de postgres: PUBLIC sigue recibiendo EXECUTE ──
-- El cierre del 09-17 (20260917152834) quitó anon/authenticated del default de postgres
-- EN EL ESQUEMA public, pero un default por esquema no puede quitar el EXECUTE que
-- PostgreSQL da a PUBLIC por omisión: por eso las funciones nuevas siguen naciendo
-- ejecutables por anon «vía PUBLIC» (submit_qr_signup, user_tactical_edit_school_ids…).
-- Cerrarlo de raíz exige este default GLOBAL. Efecto colateral: toda función nueva sin
-- GRANT explícito a authenticated da 42501 a los usuarios con sesión (CLAUDE.md ya
-- exige ese GRANT, pero un olvido pasa de silencioso a ruidoso). Por eso va comentado.
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ── 5. Autoverificación: si algo no quedó como se espera, aborta TODO ───────
DO $$
DECLARE
    v_revocar text[] := ARRAY[
        'public.bloquear_atleta_duplicado()',
        'public.fn_notify_calendar_event()',
        'public.fn_notify_pause_decision()',
        'public.fn_training_sessions_derive_school_id()',
        'public.guard_merchandise_enabled_super_admin_only()',
        'public.guard_tournament_charges_enabled_super_admin_only()',
        'public.post_training_check_daily_recap()',
        'public.post_training_notify_on_finalize()',
        'public._order_belongs_to_user(uuid)',
        'public._order_has_vendor_item(uuid)',
        'public.can_admin_see_member_profile(uuid)',
        'public.can_manage_event(uuid,uuid)',
        'public.can_manage_reports(uuid)',
        'public.check_is_school_admin(uuid)',
        'public.coach_can_see_report(uuid)',
        'public.coach_team_ids()',
        'public.current_staff_team_ids()',
        'public.is_store_vendor(uuid)',
        'public.user_tactical_edit_school_ids()',
        'public.coach_school_ids()',
        'public.staff_school_ids()',
        'public.school_member_profile_ids()',
        'public.is_coach_parent_messaging_blocked(uuid,uuid)',
        'public.is_own_team_coach(uuid)',
        'public.is_scoped_coach_school(uuid)',
        'public.is_school_member(uuid,uuid)',
        'public.user_admin_school_ids()',
        'public.is_parent_of_child(uuid)',
        'public.accept_invitation(uuid)',
        'public.access_demo_link(text)',
        'public.admin_list_enrollment_integrity_findings(text,integer,integer)',
        'public.admin_resolve_enrollment_integrity_finding(uuid,text,text)',
        'public.admin_run_enrollment_integrity_check()',
        'public.admin_set_saas_billing_enabled(uuid,boolean)',
        'public.check_is_branch_admin(uuid)',
        'public.check_is_school_admin_safe(uuid)',
        'public.check_is_school_member(uuid)',
        'public.check_is_school_member_safe(uuid)',
        'public.claim_child_for_parent(uuid,text,text)',
        'public.claim_children_by_document(text,uuid[],text,text)',
        'public.claim_member_for_plan(uuid,uuid,text,text,text)',
        'public.claim_orphan_children(uuid)',
        'public.complete_onboarding()',
        'public.current_staff_ids()',
        'public.equipment_accept(uuid)',
        'public.equipment_approve_delivery(uuid)',
        'public.equipment_approve_return(uuid,text)',
        'public.equipment_assign(uuid,uuid,integer,uuid,date,text,text)',
        'public.equipment_assignment_detail(uuid)',
        'public.equipment_available_for_self_checkout(uuid)',
        'public.equipment_close_with_shortage(uuid,text)',
        'public.equipment_dispute_return(uuid,text)',
        'public.equipment_list_coaches(uuid)',
        'public.equipment_list_items(uuid,uuid,text,text,integer,integer)',
        'public.equipment_my_assignments()',
        'public.equipment_pending_approvals(uuid)',
        'public.equipment_reject_delivery(uuid,text)',
        'public.equipment_report_difference(uuid,integer,text)',
        'public.equipment_request_return(uuid,integer,text,text,text)',
        'public.equipment_resolve_dispute(uuid,text,integer,text)',
        'public.equipment_save_settings(uuid,boolean,boolean,integer)',
        'public.equipment_self_checkout(uuid,integer,text,uuid,text)',
        'public.equipment_set_acta_pdf_url(uuid,text)',
        'public.equipment_soft_delete_item(uuid)',
        'public.equipment_upsert_item(uuid,text,integer,uuid,uuid,text,text,text,text)',
        'public.fn_is_admin_of_school(uuid)',
        'public.generate_report_drafts(uuid,smallint,smallint)',
        'public.get_athlete_dashboard_stats()',
        'public.get_distance_km(numeric,numeric,numeric,numeric)',
        'public.get_my_administered_school_ids()',
        'public.get_onboarding_status()',
        'public.get_public_program_slots(uuid,uuid,uuid)',
        'public.get_public_program_slots(uuid,uuid,uuid,uuid)',
        'public.get_school_id_by_custom_domain(text)',
        'public.get_school_id_by_slug(text)',
        'public.get_school_payment_info(uuid)',
        'public.get_shipping_quote_mock(text,text,integer,uuid)',
        'public.get_tournament_invitation_public(uuid)',
        'public.glosa_dashboard(uuid,date,date)',
        'public.has_entitlement(uuid,text)',
        'public.has_role(text)',
        'public.hold_athlete_report(uuid,text)',
        'public.is_admin()',
        'public.is_gov_entity(uuid)',
        'public.is_non_saas_entity(uuid)',
        'public.is_school_general_admin(uuid)',
        'public.is_school_owner(uuid)',
        'public.list_school_plans(uuid)',
        'public.publish_athlete_report(uuid,jsonb,boolean,text)',
        'public.publish_team_reports(uuid,uuid,smallint,smallint,jsonb,boolean,text)',
        'public.regenerate_report_snapshot(uuid,jsonb,text)',
        'public.report_coverage(uuid,smallint,smallint)',
        'public.reschedule_pending_reports(uuid,smallint,smallint)',
        'public.rpc_process_upgrade_request(uuid,text,integer,text)',
        'public.school_has_native_app(uuid)',
        'public.school_shows_own_brand(uuid)',
        'public.schools_near_location(numeric,numeric,numeric)',
        'public.search_marketplace(text,text,text,text,numeric,text,integer,integer,text)',
        'public.set_athlete_report_note(uuid,text)',
        'public.store_payment_methods(uuid)',
        'public.store_pilot_allowlist()',
        'public.submit_qr_signup(text,uuid,uuid,text,date,text,text,text,text,numeric,uuid,uuid,uuid)',
        'public.user_school_role(uuid)',
        'public.validate_athlete_age(integer,uuid)',
        'public.validate_child_for_team_join(uuid,text)'
    ];
    v_quedan text[] := ARRAY[
        'public.buscar_menor_por_documento_publico(text,uuid)',
        'public.get_invitation_details(uuid)',
        'public.get_join_qr_public(text)',
        'public.get_qr_pay_targets(text)',
        'public.get_plan_join_info(uuid)',
        'public.validate_doc_for_plan_join(uuid,text)',
        'public.get_team_join_info(uuid)',
        'public.get_school_branding_by_invitation(text)',
        'public.get_school_by_slug(text)',
        'public.get_school_lead_landing_public(text)',
        'public.list_open_trial_slots_public(text)',
        'public.submit_school_lead(text,text,text,text,text,date,text,text,text,jsonb,text,uuid)',
        'public.get_tactical_shared_play(text)',
        'public.verify_athlete_certificate_public(text,uuid)',
        'public.verify_athlete_id_card_public(uuid)',
        'public.search_schools(text,text,text,text,numeric,numeric,numeric,boolean,boolean,numeric,numeric,numeric,integer,integer,text)',
        'public.search_explore_map(text,text,text,text,text,numeric,numeric,numeric,numeric)',
        'public.quote_cart(jsonb,text,jsonb,text)',
        'public.store_enabled()',
        'public.store_seller_allowed(uuid)',
        'public.can_manage_store(uuid)',
        'public.is_super_admin()',
        'public.is_platform_admin()',
        'public.is_school_admin(uuid)',
        'public.is_school_coach(uuid)',
        'public.user_school_ids()',
        'public.user_staff_school_ids()',
        'public.is_school_open_now(uuid)',
        'public.get_single_branch_id(uuid)',
        'public.school_is_operational(uuid)'
    ];
    f text;
    v_oid regprocedure;
BEGIN
    FOREACH f IN ARRAY v_revocar LOOP
        v_oid := to_regprocedure(f);
        IF v_oid IS NULL THEN RAISE EXCEPTION 'No existe %', f; END IF;
        IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'anon sigue con EXECUTE en %', f;
        END IF;
        IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
           OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'authenticated/service_role perdió EXECUTE en %', f;
        END IF;
    END LOOP;
    FOREACH f IN ARRAY v_quedan LOOP
        v_oid := to_regprocedure(f);
        IF v_oid IS NULL OR NOT has_function_privilege('anon', v_oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'Flujo público roto: anon sin EXECUTE en %', f;
        END IF;
    END LOOP;
    IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND (tablename, policyname) IN (
              ('children', 'Children: select coach via school_staff'),
              ('children', 'Children: manage staff'),
              ('children', 'Children: select staff'),
              ('payments', 'Payments: select staff'),
              ('profiles', 'School members can view same-school profiles'),
              ('messages', 'messages_insert_own'),
              ('teams', 'Teams: coach manage own (scoped)'),
              ('school_branches', 'Members can view branches'),
              ('invitations', 'Invitations: manage staff'),
              ('school_staff', 'Staff: manage own school'),
              ('session_bookings', 'session_bookings_insert_with_enrollment'),
              ('session_bookings', 'session_bookings_select_own'),
              ('session_bookings', 'session_bookings_update_cancel')
          )
          AND roles <> '{authenticated}'::name[]
    ) THEN
        RAISE EXCEPTION 'Alguna de las 13 policies no quedó TO authenticated';
    END IF;
    RAISE NOTICE 'OK: % revocadas a anon, % siguen abiertas a propósito, 13 policies TO authenticated.',
        array_length(v_revocar, 1), array_length(v_quedan, 1);
END;
$$;

COMMIT;
