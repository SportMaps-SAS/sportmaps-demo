/**
 * recurring.routes — Suscripciones de cobro recurrente (debito automatico).
 *
 * Soporta dos modos en el mismo motor:
 *   - School mode (legacy): padre paga mensualidad a la escuela. Primer
 *     cobro el dia billing_day del mes siguiente (mes gratis hasta).
 *   - Vendor mode (multi-vendor, 2026-05-22): cliente paga suscripcion a
 *     un coach/wellness/organizer/store. Primer cobro inmediato (lo dispara
 *     el endpoint sincronamente); los siguientes segun billing_period del
 *     plan (weekly/biweekly/monthly/quarterly/yearly).
 *
 * Endpoints para el suscriptor:
 *  - POST   /api/v1/recurring/subscriptions              RETIRADO: 410 (usar /api/v1/autopay/subscriptions).
 *  - GET    /api/v1/recurring/subscriptions              Lista las del usuario
 *  - POST   /api/v1/recurring/subscriptions/:id/pause    Pausa
 *  - POST   /api/v1/recurring/subscriptions/:id/resume   Reactiva
 *  - POST   /api/v1/recurring/subscriptions/:id/cancel   Cancela (no reactivable)
 *
 * Endpoints para el vendor (lectura del lado receptor):
 *  - GET    /api/v1/recurring/vendor/subscriptions       Lista las subs activas del vendor.
 *                                                        RLS filtra por dueno del vendor_profile.
 *
 * Endpoint del cron (no expuesto al usuario):
 *  - POST   /api/v1/recurring/run                        Ejecuta cobros vencidos.
 *                                                        Auth: header x-cron-secret == RECURRING_CRON_SECRET.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { runDueRecurringCharges } from '../services/recurring-charges.service';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /subscriptions — RETIRADO (2026-10-27)
// ─────────────────────────────────────────────────────────────────────────────
// Antes llamaba la RPC `create_recurring_subscription`, que NO existe en la base
// viva (se retiró con el débito automático F0/F1) → 500 siempre si el router se
// llegaba a montar. Además confiaba `schoolId`/`childId` del body sin verificar
// que el caller fuera pagador o staff de esa escuela.
//
// El alta canónica es POST /api/v1/autopay/subscriptions (autopay.routes.ts), que
// llama `autopay_create_subscription` (SECURITY DEFINER, solo service_role) con
// `p_user_id = req.user.id`; la RPC valida acudiente del deportista (not_guardian),
// inscripción activa en esa escuela, dueño del medio (token_not_owned) y consentimiento.
// Ningún llamador en frontend/ ni en el BFF usa esta ruta, y en index.ts todo
// /api/v1/recurring responde 410 (este router no está montado). Se deja un 410
// explícito aquí, sin tocar la base, por si alguien vuelve a montar el router.

router.post(
    '/subscriptions',
    requireAuth,
    (_req: AuthenticatedRequest, res: Response) => res.status(410).json({
        error: 'Este servicio fue reemplazado. Activa el débito automático desde Mis Pagos.',
        code: 'recurring_v1_retired',
        replacement: '/api/v1/autopay/subscriptions',
    }),
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /subscriptions — lista las del usuario autenticado
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    '/subscriptions',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
        const { data, error } = await supabase
            .from('recurring_subscriptions')
            .select(`
                id, school_id, vendor_profile_id, subscription_plan_id,
                child_id, amount, currency, concept, billing_day, billing_period,
                next_charge_at, last_charge_at, status, failed_attempts,
                cancelled_at, created_at,
                payment_token:payment_tokens!payment_token_id(id, last_four, brand, payment_provider),
                subscription_plan:subscription_plans!subscription_plan_id(id, name, plan_type)
            `)
            .eq('user_id', req.user.id)
            .order('created_at', { ascending: false });

        if (error) {
            req.log?.error({ err: error }, 'list recurring_subscriptions failed');
            return res.status(500).json({ error: 'No se pudieron listar las suscripciones.' });
        }
        return res.json({ subscriptions: data ?? [] });
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendor/subscriptions — vendor lista sus suscriptores activos
// ─────────────────────────────────────────────────────────────────────────────
// RLS (rec_subs_vendor_owner_select) ya filtra por dueno del vendor_profile.
// El BFF agrega join con el plan y el subscriptor.
router.get(
    '/vendor/subscriptions',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
        const status = (req.query.status as string | undefined) ?? null;

        let query = supabase
            .from('recurring_subscriptions')
            .select(`
                id, vendor_profile_id, subscription_plan_id, user_id,
                amount, currency, concept, billing_period,
                next_charge_at, last_charge_at, status, failed_attempts,
                cancelled_at, created_at,
                subscription_plan:subscription_plans!subscription_plan_id(id, name, plan_type, price)
            `)
            .not('vendor_profile_id', 'is', null)
            .order('created_at', { ascending: false });

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query;

        if (error) {
            req.log?.error({ err: error }, 'list vendor recurring_subscriptions failed');
            return res.status(500).json({ error: 'No se pudieron listar tus suscriptores.' });
        }
        return res.json({ subscriptions: data ?? [] });
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /subscriptions/:id/pause | /resume | /cancel
// ─────────────────────────────────────────────────────────────────────────────

const IdSchema = z.object({ id: z.string().uuid() });

router.post(
    '/subscriptions/:id/pause',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
        const parsed = IdSchema.safeParse(req.params);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_id' });
        const { data, error } = await supabase.rpc('pause_recurring_subscription', { p_sub_id: parsed.data.id });
        if (error) return res.status(500).json({ error: error.message });
        if (!data?.ok) return res.status(400).json({ error: data?.error });
        return res.json(data);
    },
);

router.post(
    '/subscriptions/:id/resume',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
        const parsed = IdSchema.safeParse(req.params);
        if (!parsed.success) return res.status(400).json({ error: 'invalid_id' });
        const { data, error } = await supabase.rpc('resume_recurring_subscription', { p_sub_id: parsed.data.id });
        if (error) return res.status(500).json({ error: error.message });
        if (!data?.ok) return res.status(400).json({ error: data?.error });
        return res.json(data);
    },
);

const CancelSchema = z.object({ reason: z.string().max(280).optional() });
router.post(
    '/subscriptions/:id/cancel',
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
        const idParsed = IdSchema.safeParse(req.params);
        if (!idParsed.success) return res.status(400).json({ error: 'invalid_id' });
        const bodyParsed = CancelSchema.safeParse(req.body ?? {});
        if (!bodyParsed.success) return res.status(400).json({ error: 'invalid_body' });

        const { data, error } = await supabase.rpc('cancel_recurring_subscription', {
            p_sub_id: idParsed.data.id,
            p_reason: bodyParsed.data.reason ?? null,
        });
        if (error) return res.status(500).json({ error: error.message });
        if (!data?.ok) return res.status(400).json({ error: data?.error });
        return res.json(data);
    },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /run — endpoint del cron. NO usa requireAuth: se autentica por secret.
// ─────────────────────────────────────────────────────────────────────────────

const RunSchema = z.object({
    limit: z.number().int().min(1).max(500).optional(),
});

router.post('/run', async (req, res: Response) => {
    const expected = process.env.RECURRING_CRON_SECRET;
    const got = req.header('x-cron-secret');
    if (!expected || !got || got !== expected) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    const parsed = RunSchema.safeParse(req.body ?? {});
    const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;

    try {
        const result = await runDueRecurringCharges(limit);
        return res.json(result);
    } catch (err: any) {
        console.error('[recurring.routes] /run failed:', err);
        return res.status(500).json({ error: err?.message ?? 'run_failed' });
    }
});

export default router;
