-- =============================================================================
-- 20261029101109_notify_user_solo_destinatarios_con_relacion.sql
-- Autor: Brayan Steven Lopez   Fecha: 2026-10-29   Versión anterior: 20261029095042
-- Objetivo: notify_user solo deja notificar a destinatarios con los que quien
--           llama tiene una relación real (pregunta 1 de
--           docs/security/auditoria-definer-authenticated-2026-10-28.md).
-- =============================================================================
-- Recordatorios (CLAUDE.md):
--   · Inmutable: una vez commiteada no se edita ni se borra. Un fix va en una
--     migración NUEVA con timestamp posterior.
--   · Toda CREATE FUNCTION lleva SET search_path = pg_catalog, public, pg_temp.
--   · GRANT EXECUTE explícito por RPC (SECURITY DEFINER no exime al caller).
--   · Estados/enums en tablas nuevas: text + CHECK, no CREATE TYPE.
--   · Policies de RLS: nunca SELECT sobre la misma tabla en el USING.
-- =============================================================================
--
-- EL HUECO (prosrc vivo leído con pg_get_functiondef el 2026-10-29)
--   La primera rama del gate era «quien llama es owner/admin/school_admin activo
--   de ALGUNA escuela», sin mirar al destinatario. El admin de cualquier escuela
--   (incluida una de prueba recién creada) mandaba notificaciones —y push, vía
--   trg_enqueue_notification_delivery— con título, texto y LINK arbitrarios a
--   CUALQUIER usuario de la plataforma. Además tenía search_path = public.
--
-- LA REGLA NUEVA (helper _notify_user_destinatario_permitido)
--   Se permite si:
--   (a) el destinatario es quien llama;
--   (b) quien llama es admin de plataforma (is_platform_admin());
--   (c) el destinatario tiene relación con una escuela que quien llama ADMINISTRA
--       (user_admin_school_ids(): owner/admin/school_admin/super_admin activo o
--       schools.owner_id). Relación = miembro activo, dueño, staff activo
--       (coach_auth_id o email legacy), acudiente de un child de esa escuela,
--       inscripción activa/pendiente propia o de un hijo, o un cobro de esa
--       escuela a su nombre (payments.parent_id / user_id);
--   (d1) el destinatario es STAFF (dueño, miembro que no es parent/athlete, o
--       school_staff activo) de una escuela con la que quien llama tiene relación
--       (la misma lista de (c) + user_school_ids()). Cubre «el acudiente avisa a
--       la escuela de un pago»;
--   (d2) existe una cita en wellness_appointments entre los dos (el profesional
--       y el atleta / quien reservó, en cualquier dirección).
--
-- Llamadores en el frontend (grep 2026-10-29) y la rama que usan:
--   lib/approvePayment.ts:116                 staff → acudiente / atleta adulto del pago   (c)
--   components/payment/RegisterCashPaymentModal.tsx:561, :841
--                                             staff → acudiente / atleta adulto            (c)
--   pages/ParentCheckoutPage.tsx:576          acudiente → dueño de la escuela              (d1)
--   lib/api/transactions.ts:108               a sí mismo                                   (a)
--   lib/api/transactions.ts:144               atleta → profesional de wellness, recién
--                                             insertada la cita                            (d2)
--   Antes, :144 solo pasaba si el atleta era admin de alguna escuela, o sea que
--   casi siempre fallaba en silencio; ahora llega.
--   (c) y (d1) siguen exigiendo ROL de administración para avisar a familias:
--   un coach o un contador no notifican a acudientes, igual que antes.
--
-- Extra: p_link debe ser una ruta interna de la app ('/…', no '//…' ni
-- 'https://…'). Los siete llamadores pasan rutas internas; esto quita el
-- phishing con link externo aunque la relación exista.
--
-- Firma, SECURITY DEFINER y GRANT EXECUTE TO authenticated se conservan.
-- El helper NO se otorga a nadie: solo lo ejecuta el dueño (postgres) desde
-- notify_user.
-- =============================================================================

BEGIN;

-- ── 1. Helper: ¿quien llama (auth.uid()) puede notificar a p_target? ─────────
CREATE OR REPLACE FUNCTION public._notify_user_destinatario_permitido(p_target uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_caller      uuid := auth.uid();
    v_dest_rel    uuid[];
    v_dest_staff  uuid[];
    v_caller_rel  uuid[];
BEGIN
    IF v_caller IS NULL OR p_target IS NULL THEN
        RETURN false;
    END IF;

    -- (a) a sí mismo
    IF p_target = v_caller THEN
        RETURN true;
    END IF;

    -- (b) admin de plataforma
    IF public.is_platform_admin() THEN
        RETURN true;
    END IF;

    -- Escuelas con las que el DESTINATARIO tiene relación
    v_dest_rel := ARRAY(
        SELECT sm.school_id FROM public.school_members sm
         WHERE sm.profile_id = p_target AND sm.status = 'active'
        UNION
        SELECT s.id FROM public.schools s WHERE s.owner_id = p_target
        UNION
        SELECT ss.school_id FROM public.school_staff ss
         WHERE ss.coach_auth_id = p_target AND ss.status = 'active'
        UNION
        SELECT ss.school_id FROM public.school_staff ss
          JOIN auth.users au ON lower(au.email) = lower(ss.email)
         WHERE au.id = p_target AND ss.coach_auth_id IS NULL AND ss.status = 'active'
        UNION
        SELECT c.school_id FROM public.children c
         WHERE c.parent_id = p_target AND c.school_id IS NOT NULL
        UNION
        SELECT e.school_id FROM public.enrollments e
         WHERE e.status IN ('active', 'pending')
           AND (e.user_id = p_target
                OR e.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = p_target))
        UNION
        SELECT p.school_id FROM public.payments p
         WHERE p.school_id IS NOT NULL AND (p.parent_id = p_target OR p.user_id = p_target)
    );

    -- (c) el destinatario es de una escuela que quien llama administra
    IF v_dest_rel && public.user_admin_school_ids() THEN
        RETURN true;
    END IF;

    -- (d1) el destinatario es staff de una escuela con la que quien llama tiene relación
    v_dest_staff := ARRAY(
        SELECT s.id FROM public.schools s WHERE s.owner_id = p_target
        UNION
        SELECT sm.school_id FROM public.school_members sm
         WHERE sm.profile_id = p_target AND sm.status = 'active'
           AND sm.role NOT IN ('parent', 'athlete')
        UNION
        SELECT ss.school_id FROM public.school_staff ss
         WHERE ss.coach_auth_id = p_target AND ss.status = 'active'
        UNION
        SELECT ss.school_id FROM public.school_staff ss
          JOIN auth.users au ON lower(au.email) = lower(ss.email)
         WHERE au.id = p_target AND ss.coach_auth_id IS NULL AND ss.status = 'active'
    );

    IF cardinality(v_dest_staff) > 0 THEN
        v_caller_rel := public.user_school_ids() || ARRAY(
            SELECT s.id FROM public.schools s WHERE s.owner_id = v_caller
            UNION
            SELECT c.school_id FROM public.children c
             WHERE c.parent_id = v_caller AND c.school_id IS NOT NULL
            UNION
            SELECT e.school_id FROM public.enrollments e
             WHERE e.status IN ('active', 'pending')
               AND (e.user_id = v_caller
                    OR e.child_id IN (SELECT c.id FROM public.children c WHERE c.parent_id = v_caller))
            UNION
            SELECT p.school_id FROM public.payments p
             WHERE p.school_id IS NOT NULL AND (p.parent_id = v_caller OR p.user_id = v_caller)
        );
        IF v_caller_rel && v_dest_staff THEN
            RETURN true;
        END IF;
    END IF;

    -- (d2) cita de wellness entre los dos, en cualquier dirección
    IF EXISTS (
        SELECT 1 FROM public.wellness_appointments wa
         WHERE (wa.professional_id = p_target AND (wa.athlete_id = v_caller OR wa.booked_by = v_caller))
            OR (wa.professional_id = v_caller AND (wa.athlete_id = p_target OR wa.booked_by = p_target))
    ) THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public._notify_user_destinatario_permitido(uuid) FROM PUBLIC, anon, authenticated;

-- ── 2. notify_user: misma firma, gate nuevo, search_path fijo ────────────────
CREATE OR REPLACE FUNCTION public.notify_user(
    p_user_id uuid,
    p_title   text,
    p_message text,
    p_type    text DEFAULT 'info'::text,
    p_link    text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Falta el destinatario' USING ERRCODE = '22023';
    END IF;

    -- Solo rutas internas de la app: '/algo'. Nada de 'https://…' ni '//host'.
    IF p_link IS NOT NULL AND NOT (p_link = '/' OR p_link ~ '^/[^/\\]') THEN
        RAISE EXCEPTION 'El link de la notificación debe ser una ruta interna de la app'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public._notify_user_destinatario_permitido(p_user_id) THEN
        RAISE EXCEPTION 'Sin permisos para notificar a este usuario' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.notifications (user_id, title, message, type, link)
    VALUES (p_user_id, p_title, p_message, p_type, p_link);
END;
$$;

REVOKE ALL ON FUNCTION public.notify_user(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_user(uuid, text, text, text, text) TO authenticated;

-- ── 3. Autoverificación: si algo no quedó como se espera, aborta TODO ────────
DO $$
DECLARE
    v_cfg text[];
BEGIN
    SELECT proconfig INTO v_cfg FROM pg_proc
     WHERE oid = 'public.notify_user(uuid,text,text,text,text)'::regprocedure;
    IF NOT ('search_path=pg_catalog, public, pg_temp' = ANY (v_cfg)) THEN
        RAISE EXCEPTION 'notify_user quedó con search_path %', v_cfg;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.notify_user(uuid,text,text,text,text)'::regprocedure) THEN
        RAISE EXCEPTION 'notify_user dejó de ser SECURITY DEFINER';
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.notify_user(uuid,text,text,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'authenticated perdió EXECUTE sobre notify_user';
    END IF;
    IF has_function_privilege('anon', 'public.notify_user(uuid,text,text,text,text)', 'EXECUTE') THEN
        RAISE EXCEPTION 'anon conserva EXECUTE sobre notify_user';
    END IF;
    IF has_function_privilege('authenticated', 'public._notify_user_destinatario_permitido(uuid)', 'EXECUTE')
    OR has_function_privilege('anon',          'public._notify_user_destinatario_permitido(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'el helper _notify_user_destinatario_permitido quedó ejecutable por anon/authenticated';
    END IF;
END $$;

COMMIT;
