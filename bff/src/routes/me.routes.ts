import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { requireCsrfHeader } from '../middlewares/csrfHeader';
import { supabase } from '../config/supabase';

const router = Router();

/** Error de PostgREST/Postgres por una tabla que no existe en la base viva. */
export function esTablaInexistente(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
    if (!error) return false;
    if (error.code === '42P01' || error.code === 'PGRST205') return true;
    return /relation .* does not exist|could not find the table/i.test(error.message ?? '');
}

/**
 * GET /api/v1/me/entitlements
 *
 * Retorna el plan SaaS + addons activos para la escuela actual del usuario
 * (vinculada por x-school-id + JWT). Lee la vista v_school_entitlements
 * que agrega schools.school_type + school_subscriptions + school_addons.
 *
 * Consumido por el hook useEntitlements() en el frontend y por el componente
 * <EntitlementGate /> para decidir qué features bloquear / mostrar upsell.
 *
 * La vista arranca en `schools` con LEFT JOIN a la suscripción, así que ahora
 * devuelve fila para toda escuela existente (con trial_ends_at = registro + 1 mes
 * cuando falta la suscripción — hay 151 escuelas así). Por eso `!data` ya solo
 * significa "la escuela no existe": ahí se responde fail-closed y no
 * starter/free/active, que era el agujero por el que se colaba acceso abierto.
 */
router.get('/entitlements', requireAuth, async (req: Request, res: Response) => {
    try {
        const { schoolId } = req;

        if (!schoolId) {
            return res.status(400).json({ error: 'school_id requerido' });
        }

        const { data, error } = await supabase
            .from('v_school_entitlements')
            .select('*')
            .eq('school_id', schoolId)
            .maybeSingle();

        if (error) {
            req.log?.error({ err: error, schoolId }, 'Error leyendo v_school_entitlements');
            return res.status(500).json({ error: 'Error al obtener entitlements' });
        }

        if (!data) {
            // La escuela no existe (la vista sí devuelve fila cuando falta la
            // suscripción). Fail-closed: sin escuela no hay entitlements.
            req.log?.warn({ schoolId }, 'v_school_entitlements sin fila: escuela inexistente, fail-closed');
            return res.json({
                school_id:            schoolId,
                school_type:          'academy',
                plan_code:            'starter',
                tier:                 'free',
                subscription_status:  'trial_expired',
                has_subscription_row: false,
                account_type:         'real',
                blocking_exempt:      false,
                is_operational:       false,
                trial_ends_at:        null,
                current_period_start: null,
                current_period_end:   null,
                billing_cycle:        null,
                has_academy:          true,
                has_reservations:     false,
                has_wallet:           false,
                has_tournaments:      false,
                has_access_control:   false,
                has_biomech:          false,
                has_nutrition:        false,
                has_whitelabel:       false,
                has_pwa_branding:     false,
                has_whatsapp:         false,
                has_wompi:            false,
                has_mp:               false,
                has_store:            false,
                has_accounting:       false,
                has_invoicing:        false,
                coach_can_create_athletes: false,
                parent_email_optional: false,
                coach_hide_financial_info: false,
                coach_can_edit_categories: false,
                military_discount_enabled: false,
                coach_attendance_retro_days: 7,
                coach_can_upload_enrollment_forms: false,
                coach_can_upload_attendance_sheets: false,
                coach_can_remove_enrollments: false,
                registration_zk_pin_enabled: false,
                access_roster_enabled: false,
            });
        }

        // Permisos de subida de fotos del coach (mig 20261005120806). Van en un
        // select APARTE de school_settings y no en la vista: si la migración aún
        // no está aplicada, PostgREST falla solo esta lectura y quedan en false
        // (comportamiento de siempre) sin tumbar los entitlements.
        {
            const { data: fotos, error: fotosErr } = await supabase
                .from('school_settings')
                .select('coach_can_upload_enrollment_forms, coach_can_upload_attendance_sheets')
                .eq('school_id', schoolId)
                .maybeSingle();
            if (fotosErr) req.log?.warn({ err: fotosErr, schoolId }, 'permisos de fotos del coach no legibles; quedan en false');
            data.coach_can_upload_enrollment_forms = (fotos as any)?.coach_can_upload_enrollment_forms === true;
            data.coach_can_upload_attendance_sheets = (fotos as any)?.coach_can_upload_attendance_sheets === true;
        }

        // Coach remueve deportistas de SUS equipos (mig 20261021…). Select aparte:
        // sin la migración falla solo esta lectura y queda en false.
        {
            const { data: rem, error: remErr } = await supabase
                .from('school_settings')
                .select('coach_can_remove_enrollments')
                .eq('school_id', schoolId)
                .maybeSingle();
            if (remErr) req.log?.warn({ err: remErr, schoolId }, 'coach_can_remove_enrollments no legible; queda en false');
            data.coach_can_remove_enrollments = (rem as any)?.coach_can_remove_enrollments === true;
        }

        // ID del torniquete en el registro (Dreamers, mig 20261013…). Select APARTE por
        // la misma razón: sin la migración falla solo esta lectura y queda en false.
        {
            const { data: zk, error: zkErr } = await supabase
                .from('school_settings')
                .select('registration_zk_pin_enabled')
                .eq('school_id', schoolId)
                .maybeSingle();
            if (zkErr) req.log?.warn({ err: zkErr, schoolId }, 'registration_zk_pin_enabled no legible; queda en false');
            data.registration_zk_pin_enabled = (zk as any)?.registration_zk_pin_enabled === true;
        }

        // Pestaña «IDs del lector» (mig 20261031131601). Select aparte, mismo motivo: falla cerrado.
        {
            const { data: ar, error: arErr } = await supabase
                .from('school_settings')
                .select('access_roster_enabled')
                .eq('school_id', schoolId)
                .maybeSingle();
            if (arErr) req.log?.warn({ err: arErr, schoolId }, 'access_roster_enabled no legible; queda en false');
            data.access_roster_enabled = (ar as any)?.access_roster_enabled === true;
        }

        if (process.env.NODE_ENV === 'staging') {
            data.has_biomech = false;
        }

        return res.json(data);
    } catch (err: any) {
        req.log?.error({ err }, 'Error en GET /me/entitlements');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/me/data-export  (Ley 1581/2012 — derecho de acceso)
//
// Devuelve un JSON con toda la informacion personal del usuario autenticado.
// El RPC data_export_user() corre como SECURITY DEFINER y filtra por
// auth.uid() internamente — no expone datos de terceros.
//
// Devuelve Content-Disposition: attachment para que el browser lo guarde
// como archivo descargable.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/data-export', requireAuth, async (req: Request, res: Response) => {
    try {
        const { data, error } = await supabase.rpc('data_export_user');
        if (error) {
            req.log?.error({ err: error }, 'data_export_user RPC failed');
            return res.status(500).json({ error: 'export_failed' });
        }
        if (!data?.ok) {
            return res.status(400).json({ error: data?.error || 'unknown' });
        }

        const filename = `sportmaps-data-export-${new Date().toISOString().slice(0, 10)}.json`;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(JSON.stringify(data.data, null, 2));
    } catch (err: any) {
        req.log?.error({ err }, 'Error en GET /me/data-export');
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/me/data-deletion-request  (Ley 1581/2012 — derecho de supresion)
//
// Programa el borrado de la cuenta en 30 dias. Inmediatamente:
//   - cancela todas las recurring_subscriptions
//   - desactiva (soft-delete) todos los payment_tokens
//   - registra IP + UA para auditoria
//
// El borrado fisico (anonimizacion) lo ejecuta un job aparte cuando se
// cumple scheduled_for. El padre puede CANCELAR la solicitud en cualquier
// momento dentro de los 30 dias via DELETE /me/data-deletion-request.
// ─────────────────────────────────────────────────────────────────────────────

const DeletionRequestSchema = z.object({
    reason: z.string().max(500).optional(),
});

router.post('/data-deletion-request', requireAuth, requireCsrfHeader, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = DeletionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_body' });
    }

    const ip = (req.ip || req.socket?.remoteAddress || '').toString();
    const ua = req.get('user-agent') || '';

    // El cliente del BFF es service_role (auth.uid() = NULL dentro de la RPC):
    // el usuario va explícito, sacado del JWT ya validado (mig. 20261027111037).
    const { data, error } = await supabase.rpc('request_account_deletion', {
        p_user_id: req.user.id,
        p_reason: parsed.data.reason ?? null,
        p_ip_address: ip || null,
        p_user_agent: ua || null,
    });

    if (error) {
        req.log?.error({ err: error }, 'request_account_deletion RPC failed');
        return res.status(500).json({ error: 'request_failed' });
    }
    if (!data?.ok) {
        return res.status(400).json({ error: data?.error || 'unknown' });
    }
    return res.status(202).json(data);
});

// Cancelar solicitud de borrado (el padre se arrepiente). NO reactiva
// payment_tokens automaticamente — el padre debe agregar la tarjeta de nuevo.
router.delete('/data-deletion-request', requireAuth, requireCsrfHeader, async (req: AuthenticatedRequest, res: Response) => {
    const { data, error } = await supabase.rpc('cancel_account_deletion', { p_user_id: req.user.id });
    if (error) {
        req.log?.error({ err: error }, 'cancel_account_deletion RPC failed');
        return res.status(500).json({ error: 'cancel_failed' });
    }
    if (!data?.ok) {
        return res.status(400).json({ error: data?.error || 'unknown' });
    }
    return res.json(data);
});

// Consultar estado de mi solicitud de borrado (si existe).
router.get('/data-deletion-request', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { data, error } = await supabase
        .from('account_deletion_requests')
        .select('id, reason, requested_at, scheduled_for, status, cancelled_at, completed_at')
        .eq('user_id', req.user.id)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        // Tabla aún sin crear (42P01 / PGRST205): no hay solicitud que mostrar.
        // Antes era un 500 que rompía Mi cuenta › Seguridad (B12).
        if (esTablaInexistente(error)) {
            req.log?.warn({ err: error }, 'account_deletion_requests no existe (falta migración 20261027111037)');
            return res.json({ request: null });
        }
        req.log?.error({ err: error }, 'data-deletion-request query failed');
        return res.status(500).json({ error: 'query_failed' });
    }
    return res.json({ request: data });
});

export default router;
