-- =============================================================================
-- Verificación de SOLO LECTURA de 20261028111254_cerrar_anon_funciones_definer
-- (no escribe nada: has_function_privilege + pg_policies).
-- Devuelve una fila por problema, o UNA fila «OK — N/N».
--   A (30): anon SÍ   · B/C/D (105): anon NO
--   todas: authenticated SÍ y service_role SÍ (las tenían el 2026-10-28)
--   13 policies con roles = {authenticated}
-- =============================================================================
WITH esperado(cat, sig) AS (VALUES
    ('B', 'bloquear_atleta_duplicado()'),
    ('B', 'fn_notify_calendar_event()'),
    ('B', 'fn_notify_pause_decision()'),
    ('B', 'fn_training_sessions_derive_school_id()'),
    ('B', 'guard_merchandise_enabled_super_admin_only()'),
    ('B', 'guard_tournament_charges_enabled_super_admin_only()'),
    ('B', 'post_training_check_daily_recap()'),
    ('B', 'post_training_notify_on_finalize()'),
    ('C', '_order_belongs_to_user(uuid)'),
    ('C', '_order_has_vendor_item(uuid)'),
    ('C', 'can_admin_see_member_profile(uuid)'),
    ('C', 'can_manage_event(uuid,uuid)'),
    ('C', 'can_manage_reports(uuid)'),
    ('C', 'check_is_school_admin(uuid)'),
    ('C', 'coach_can_see_report(uuid)'),
    ('C', 'coach_team_ids()'),
    ('C', 'current_staff_team_ids()'),
    ('C', 'is_store_vendor(uuid)'),
    ('C', 'user_tactical_edit_school_ids()'),
    ('C', 'coach_school_ids()'),
    ('C', 'staff_school_ids()'),
    ('C', 'school_member_profile_ids()'),
    ('C', 'is_coach_parent_messaging_blocked(uuid,uuid)'),
    ('C', 'is_own_team_coach(uuid)'),
    ('C', 'is_scoped_coach_school(uuid)'),
    ('C', 'is_school_member(uuid,uuid)'),
    ('C', 'user_admin_school_ids()'),
    ('C', 'is_parent_of_child(uuid)'),
    ('D', 'accept_invitation(uuid)'),
    ('D', 'access_demo_link(text)'),
    ('D', 'admin_list_enrollment_integrity_findings(text,integer,integer)'),
    ('D', 'admin_resolve_enrollment_integrity_finding(uuid,text,text)'),
    ('D', 'admin_run_enrollment_integrity_check()'),
    ('D', 'admin_set_saas_billing_enabled(uuid,boolean)'),
    ('D', 'check_is_branch_admin(uuid)'),
    ('D', 'check_is_school_admin_safe(uuid)'),
    ('D', 'check_is_school_member(uuid)'),
    ('D', 'check_is_school_member_safe(uuid)'),
    ('D', 'claim_child_for_parent(uuid,text,text)'),
    ('D', 'claim_children_by_document(text,uuid[],text,text)'),
    ('D', 'claim_member_for_plan(uuid,uuid,text,text,text)'),
    ('D', 'claim_orphan_children(uuid)'),
    ('D', 'complete_onboarding()'),
    ('D', 'current_staff_ids()'),
    ('D', 'equipment_accept(uuid)'),
    ('D', 'equipment_approve_delivery(uuid)'),
    ('D', 'equipment_approve_return(uuid,text)'),
    ('D', 'equipment_assign(uuid,uuid,integer,uuid,date,text,text)'),
    ('D', 'equipment_assignment_detail(uuid)'),
    ('D', 'equipment_available_for_self_checkout(uuid)'),
    ('D', 'equipment_close_with_shortage(uuid,text)'),
    ('D', 'equipment_dispute_return(uuid,text)'),
    ('D', 'equipment_list_coaches(uuid)'),
    ('D', 'equipment_list_items(uuid,uuid,text,text,integer,integer)'),
    ('D', 'equipment_my_assignments()'),
    ('D', 'equipment_pending_approvals(uuid)'),
    ('D', 'equipment_reject_delivery(uuid,text)'),
    ('D', 'equipment_report_difference(uuid,integer,text)'),
    ('D', 'equipment_request_return(uuid,integer,text,text,text)'),
    ('D', 'equipment_resolve_dispute(uuid,text,integer,text)'),
    ('D', 'equipment_save_settings(uuid,boolean,boolean,integer)'),
    ('D', 'equipment_self_checkout(uuid,integer,text,uuid,text)'),
    ('D', 'equipment_set_acta_pdf_url(uuid,text)'),
    ('D', 'equipment_soft_delete_item(uuid)'),
    ('D', 'equipment_upsert_item(uuid,text,integer,uuid,uuid,text,text,text,text)'),
    ('D', 'fn_is_admin_of_school(uuid)'),
    ('D', 'generate_report_drafts(uuid,smallint,smallint)'),
    ('D', 'get_athlete_dashboard_stats()'),
    ('D', 'get_distance_km(numeric,numeric,numeric,numeric)'),
    ('D', 'get_my_administered_school_ids()'),
    ('D', 'get_onboarding_status()'),
    ('D', 'get_public_program_slots(uuid,uuid,uuid)'),
    ('D', 'get_public_program_slots(uuid,uuid,uuid,uuid)'),
    ('D', 'get_school_id_by_custom_domain(text)'),
    ('D', 'get_school_id_by_slug(text)'),
    ('D', 'get_school_payment_info(uuid)'),
    ('D', 'get_shipping_quote_mock(text,text,integer,uuid)'),
    ('D', 'get_tournament_invitation_public(uuid)'),
    ('D', 'glosa_dashboard(uuid,date,date)'),
    ('D', 'has_entitlement(uuid,text)'),
    ('D', 'has_role(text)'),
    ('D', 'hold_athlete_report(uuid,text)'),
    ('D', 'is_admin()'),
    ('D', 'is_gov_entity(uuid)'),
    ('D', 'is_non_saas_entity(uuid)'),
    ('D', 'is_school_general_admin(uuid)'),
    ('D', 'is_school_owner(uuid)'),
    ('D', 'list_school_plans(uuid)'),
    ('D', 'publish_athlete_report(uuid,jsonb,boolean,text)'),
    ('D', 'publish_team_reports(uuid,uuid,smallint,smallint,jsonb,boolean,text)'),
    ('D', 'regenerate_report_snapshot(uuid,jsonb,text)'),
    ('D', 'report_coverage(uuid,smallint,smallint)'),
    ('D', 'reschedule_pending_reports(uuid,smallint,smallint)'),
    ('D', 'rpc_process_upgrade_request(uuid,text,integer,text)'),
    ('D', 'school_has_native_app(uuid)'),
    ('D', 'school_shows_own_brand(uuid)'),
    ('D', 'schools_near_location(numeric,numeric,numeric)'),
    ('D', 'search_marketplace(text,text,text,text,numeric,text,integer,integer,text)'),
    ('D', 'set_athlete_report_note(uuid,text)'),
    ('D', 'store_payment_methods(uuid)'),
    ('D', 'store_pilot_allowlist()'),
    ('D', 'submit_qr_signup(text,uuid,uuid,text,date,text,text,text,text,numeric,uuid,uuid,uuid)'),
    ('D', 'user_school_role(uuid)'),
    ('D', 'validate_athlete_age(integer,uuid)'),
    ('D', 'validate_child_for_team_join(uuid,text)'),
    ('A', 'buscar_menor_por_documento_publico(text,uuid)'),
    ('A', 'get_invitation_details(uuid)'),
    ('A', 'get_join_qr_public(text)'),
    ('A', 'get_qr_pay_targets(text)'),
    ('A', 'get_plan_join_info(uuid)'),
    ('A', 'validate_doc_for_plan_join(uuid,text)'),
    ('A', 'get_team_join_info(uuid)'),
    ('A', 'get_school_branding_by_invitation(text)'),
    ('A', 'get_school_by_slug(text)'),
    ('A', 'get_school_lead_landing_public(text)'),
    ('A', 'list_open_trial_slots_public(text)'),
    ('A', 'submit_school_lead(text,text,text,text,text,date,text,text,text,jsonb,text,uuid)'),
    ('A', 'get_tactical_shared_play(text)'),
    ('A', 'verify_athlete_certificate_public(text,uuid)'),
    ('A', 'verify_athlete_id_card_public(uuid)'),
    ('A', 'search_schools(text,text,text,text,numeric,numeric,numeric,boolean,boolean,numeric,numeric,numeric,integer,integer,text)'),
    ('A', 'search_explore_map(text,text,text,text,text,numeric,numeric,numeric,numeric)'),
    ('A', 'quote_cart(jsonb,text,jsonb,text)'),
    ('A', 'store_enabled()'),
    ('A', 'store_seller_allowed(uuid)'),
    ('A', 'can_manage_store(uuid)'),
    ('A', 'is_super_admin()'),
    ('A', 'is_platform_admin()'),
    ('A', 'is_school_admin(uuid)'),
    ('A', 'is_school_coach(uuid)'),
    ('A', 'user_school_ids()'),
    ('A', 'user_staff_school_ids()'),
    ('A', 'is_school_open_now(uuid)'),
    ('A', 'get_single_branch_id(uuid)'),
    ('A', 'school_is_operational(uuid)')
),
f AS (
  SELECT cat, sig, to_regprocedure('public.' || sig) AS oid FROM esperado
),
chk_fn AS (
  SELECT cat, sig,
    CASE
      WHEN oid IS NULL THEN 'no existe la función (¿cambió la firma?)'
      WHEN cat = 'A' AND NOT has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon PERDIÓ EXECUTE: flujo público roto'
      WHEN cat <> 'A' AND has_function_privilege('anon', oid, 'EXECUTE') THEN 'anon sigue con EXECUTE'
      -- access_demo_link y claim_child_for_parent: 20261028111725_gates_definer_authenticated
      -- (posterior) también las revoca de authenticated a propósito (sin llamador / CRIT).
      WHEN NOT has_function_privilege('authenticated', oid, 'EXECUTE')
           AND sig NOT IN ('access_demo_link(text)', 'claim_child_for_parent(uuid,text,text)')
        THEN 'authenticated perdió EXECUTE'
      WHEN NOT has_function_privilege('service_role', oid, 'EXECUTE') THEN 'service_role perdió EXECUTE'
    END AS problema
  FROM f
),
pol_esperada(tablename, policyname) AS (VALUES
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
    -- SEG-31 (20261107174916) eliminó session_bookings_insert_with_enrollment y _update_cancel a propósito.
    ('session_bookings', 'session_bookings_select_own')
),
chk_pol AS (
  SELECT 'POLICY'::text AS cat, e.tablename || ' · ' || e.policyname AS sig,
    CASE
      WHEN p.policyname IS NULL THEN 'no existe la policy'
      WHEN p.roles <> '{authenticated}'::name[] THEN 'roles = ' || p.roles::text || ' (esperado {authenticated})'
    END AS problema
  FROM pol_esperada e
  LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = e.tablename AND p.policyname = e.policyname
),
todo AS (SELECT * FROM chk_fn UNION ALL SELECT * FROM chk_pol)
SELECT cat, sig, problema FROM todo WHERE problema IS NOT NULL
UNION ALL
SELECT '—',
  format('OK — %s/%s (%s funciones + %s policies). DEFINER en public que anon aún ejecuta: %s (esperado %s; si hay más, son nuevas)',
    (SELECT count(*) FROM todo), (SELECT count(*) FROM todo),
    (SELECT count(*) FROM chk_fn), (SELECT count(*) FROM chk_pol),
    (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')),
    30),
  NULL
WHERE NOT EXISTS (SELECT 1 FROM todo WHERE problema IS NOT NULL)
ORDER BY 1, 2;
