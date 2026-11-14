-- =============================================================================
-- 20261028111725_gates_definer_authenticated.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-28   Versión anterior: 20261027192225
--
-- Objetivo: cerrar las funciones SECURITY DEFINER que cualquier sesión
--   `authenticated` (padre, atleta o coach de OTRA escuela) podía usar para
--   escribir sobre otro tenant o leer datos personales de menores, y que hoy
--   NO tienen ningún llamador legítimo con sesión de usuario.
--   Auditoría completa: docs/security/auditoria-definer-authenticated-2026-10-28.md
--
-- Solo REVOKE. No se reescribe ningún cuerpo (no hay CREATE OR REPLACE), así
-- que no hay riesgo de pisar la deriva entre repo y base: las funciones quedan
-- como están vivas y siguen disponibles para service_role y postgres.
--
-- Por qué REVOKE y no gate: para cada una se verificó, el 2026-10-28, que
--   · frontend/src (sin types.ts ni tests), bff/src, supabase/functions y mobile
--     no la llaman (único hallazgo: un COMENTARIO en JoinTeamPage.tsx);
--   · ninguna policy la usa en qual / with_check (pg_policies);
--   · ninguna función SECURITY INVOKER ni vista la llama (pg_proc.prosrc, pg_views);
--   · ninguna rama remota activa la usa (solo las ramas viejas `production`
--     y `demo`, de abril y julio, llaman claim_child_for_parent).
--   Una función muerta y peligrosa se apaga; si algún día vuelve a hacer falta,
--   se le pone gate y se le devuelve el GRANT en otra migración.
--
-- Trampa 3 de CLAUDE.md: REVOKE ... FROM PUBLIC no alcanza, los default
-- privileges dan EXECUTE explícito a anon/authenticated. Se revoca de los tres.
-- =============================================================================

BEGIN;

-- ── CRIT ─────────────────────────────────────────────────────────────────────

-- Cierra CUALQUIER caja abierta de cualquier escuela, con el efectivo declarado
-- que quiera quien llama (falsea cash_difference). Cero gate. Sin llamadores.
REVOKE EXECUTE ON FUNCTION public.close_cash_session(uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;

-- Inserta una notificación a CUALQUIER usuario (p_user_id libre) con título,
-- texto y link arbitrarios; trg_enqueue_notification_delivery la convierte en
-- push/web. Phishing con la marca de la app. Sin llamadores (notify_user es la
-- que usa el frontend).
REVOKE EXECUTE ON FUNCTION public.send_notification(text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- Las dos inscriben a quien llama en CUALQUIER escuela (p_school_id libre) y
-- lo dan de alta como school_members 'active' (parent/athlete): con eso entra a
-- user_school_ids() de una escuela ajena y hereda su lectura por RLS. La v1
-- además toma el precio del cliente (p_price) si el equipo no es de la escuela.
-- Sin llamadores (el alta va por submit_qr_signup / claim_* / invitaciones).
REVOKE EXECUTE ON FUNCTION public.submit_enrollment(uuid, uuid, uuid, numeric, uuid, text, date, text, text, text, text, boolean, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.submit_enrollment_v2(uuid, uuid, uuid, text, date, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;

-- Con solo el child_id de un menor sin acudiente, quien llama se vuelve su
-- parent_id, lo inscribe y entra como miembro activo de la escuela. No pide
-- documento (claim_children_by_document, la que usa JoinTeamPage hoy, sí).
REVOKE EXECUTE ON FUNCTION public.claim_child_for_parent(uuid, text, text)
  FROM PUBLIC, anon, authenticated;

-- ── ALTO ─────────────────────────────────────────────────────────────────────

-- SEG-14 a medias: JoinTeamPage dejó de usarla y anon ya no la tiene, pero con
-- sesión sigue devolviendo nombre completo, FECHA DE NACIMIENTO, equipo, sede
-- y escuela de cualquier menor del país a partir del documento, sin límite de
-- intentos (buscar_menor_por_documento_publico sí lo tiene). Sin llamadores.
REVOKE EXECUTE ON FUNCTION public.find_athletes_by_document(text, uuid)
  FROM PUBLIC, anon, authenticated;

-- ── MEDIO (muertas) ──────────────────────────────────────────────────────────

-- Cualquier sesión crea un link app.sportmaps.co/demo/<token> con el nombre,
-- logo y color que quiera. La pareja de lectura (anon) cae con ella.
REVOKE EXECUTE ON FUNCTION public.create_demo_link(text, text, text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.access_demo_link(text)
  FROM PUBLIC, anon, authenticated;

-- Invitación de staff sin validar p_role ni que p_branch_id sea de la escuela.
-- accept_invitation_pro hoy frena 'owner' y el school_admin sin invited_by,
-- pero la defensa no debe depender del otro extremo. Sin llamadores.
REVOKE EXECUTE ON FUNCTION public.admin_create_staff_direct(text, text, uuid)
  FROM PUBLIC, anon, authenticated;

-- ── SERVICE (solo el BFF, con service_role) ──────────────────────────────────

-- Ciclo de facturación SaaS: lo corre el job del BFF (saas-billing-cycle.job.ts)
-- con el cliente service_role. Ya tiene gate (super_admin / service_role), esto
-- es reducción de superficie. generate_school_subscription_invoice solo la
-- llaman run_saas_billing_cycle y admin_set_saas_billing_enabled, ambas DEFINER.
REVOKE EXECUTE ON FUNCTION public.run_saas_billing_cycle()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_school_subscription_invoice(uuid)
  FROM PUBLIC, anon, authenticated;

-- service_role conserva EXECUTE (el BFF y los scripts siguen pudiendo).
GRANT EXECUTE ON FUNCTION public.close_cash_session(uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.send_notification(text, text, text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_enrollment(uuid, uuid, uuid, numeric, uuid, text, date, text, text, text, text, boolean, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_enrollment_v2(uuid, uuid, uuid, text, date, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_child_for_parent(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.find_athletes_by_document(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_demo_link(text, text, text, text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.access_demo_link(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_staff_direct(text, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_saas_billing_cycle() TO service_role;
GRANT EXECUTE ON FUNCTION public.generate_school_subscription_invoice(uuid) TO service_role;

COMMIT;
