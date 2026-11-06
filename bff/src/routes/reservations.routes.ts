// bff/src/routes/reservations.routes.ts
//
// Reservas de canchas CON SESIÓN (F1). Montado en /api/v1/reservations.
// Todo pasa por las RPC del contrato (docs/specs/reservas-canchas-f1-contrato.md):
// disponibilidad_canchas, reservar_cancha, cancelar_reserva, reprogramar_reserva.
// El BFF llama con service_role y pasa la identidad ya verificada en
// p_actor_profile_id (las RPC solo la leen cuando auth.uid() es NULL).
//
// Auth: optionalAuth + guard propio en vez de requireAuth, porque requireAuth
// exige fila activa en school_members y quien reserva una cancha pública sin ser
// miembro de la escuela (externo con cuenta) quedaría con 403.
//
// Orden de rutas: /availability y /mine ANTES de /:id.
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { optionalAuth } from '../middlewares/authMiddleware';
import { requireIdempotencyKey } from '../middlewares/requireIdempotencyKey';
import { requireEntitlement } from '../middlewares/requireEntitlement';
import { isFacilityStaffRole } from '../utils/facilityRoles';
import { isRpcFailure, translateRpcError, UUID_RE } from '../utils/reservations.shared';

const router = Router();

function requireSession(req: Request, res: Response, next: NextFunction) {
    if (!req.user?.id) return res.status(401).json({ error: 'Debes iniciar sesión.', reason: 'auth_required' });
    next();
}

router.use(optionalAuth, requireSession);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const iso = z.iso.datetime({ offset: true });

/** ¿El usuario es staff de esa escuela (miembro con rol de administración o admin de plataforma)? */
export async function isStaffOfSchool(userId: string, schoolId: string): Promise<boolean> {
    const { data: pa } = await supabase
        .from('platform_admins').select('profile_id').eq('profile_id', userId).eq('is_active', true).maybeSingle();
    if (pa) return true;
    const { data: m } = await supabase
        .from('school_members').select('role').eq('profile_id', userId).eq('school_id', schoolId).eq('status', 'active').limit(1);
    const role = (m as any[] | null)?.[0]?.role;
    return isFacilityStaffRole(role);
}

function sendRpc(res: Response, req: Request, fn: string, data: any, error: any, okStatus = 200) {
    if (error) {
        req.log?.error({ err: error, rpc: fn }, `reservations ${fn} falló`);
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
    if (isRpcFailure(data)) {
        const t = translateRpcError(data);
        return res.status(t.status).json(t.body);
    }
    return res.status(okStatus).json(data);
}

// ── GET /availability ────────────────────────────────────────────────────────
const AvailabilitySchema = z.object({
    school_id: z.string().regex(UUID_RE, 'school_id inválido'),
    from: z.string().regex(DATE_RE, 'from inválido (YYYY-MM-DD)'),
    to: z.string().regex(DATE_RE, 'to inválido (YYYY-MM-DD)'),
    sport: z.string().max(60).optional(),
    facility_id: z.string().regex(UUID_RE, 'facility_id inválido').optional(),
    duration_min: z.coerce.number().int().min(5).max(480).optional(),
    audience: z.enum(['public', 'member']).optional(),
});

// requireEntitlement lee req.schoolId; aquí la escuela viene en el query (ya validada como uuid).
function schoolFromQuery(req: Request, _res: Response, next: NextFunction) {
    const s = req.query.school_id;
    if (typeof s === 'string' && UUID_RE.test(s)) req.schoolId = s;
    next();
}

router.get('/availability', schoolFromQuery, requireEntitlement('reservations'), async (req: Request, res: Response) => {
    try {
        const parsed = AvailabilitySchema.safeParse(req.query);
        if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        const q = parsed.data;
        const args: Record<string, unknown> = {
            p_school_id: q.school_id, p_from: q.from, p_to: q.to, p_actor_profile_id: req.user.id,
        };
        if (q.sport) args.p_sport = q.sport;
        if (q.facility_id) args.p_facility_id = q.facility_id;
        if (q.duration_min) args.p_duration_min = q.duration_min;
        if (q.audience) args.p_audience = q.audience; // solo lo respeta el staff (lo valida el SQL)
        const { data, error } = await supabase.rpc('disponibilidad_canchas', args);
        return sendRpc(res, req, 'disponibilidad_canchas', data, error);
    } catch (err: any) {
        req.log?.error({ err }, 'reservations availability error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── POST / — reservar ────────────────────────────────────────────────────────
const ReserveSchema = z.object({
    facility_id: z.string().regex(UUID_RE, 'facility_id inválido'),
    starts_at: iso,
    ends_at: iso,
    payment_method: z.enum(['online', 'transfer', 'cash', 'none']).default('online'),
    booker_profile_id: z.string().regex(UUID_RE).optional(),
    guest: z.object({
        phone: z.string().min(7).max(20),
        full_name: z.string().min(2).max(120),
        email: z.string().email().max(160).optional(),
    }).optional(),
    rate_audience: z.enum(['public', 'member']).optional(),
    participants: z.number().int().min(1).max(200).optional(),
    notes: z.string().max(1000).optional(),
    external_org_name: z.string().max(200).optional(),
    amount_paid: z.number().min(0).max(1_000_000_000).optional(),
    channel: z.enum(['app', 'admin']).optional(),
}).refine((b) => new Date(b.ends_at) > new Date(b.starts_at), { message: 'ends_at debe ser posterior a starts_at', path: ['ends_at'] });

router.post('/', requireIdempotencyKey, async (req: Request, res: Response) => {
    try {
        const parsed = ReserveSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        const b = parsed.data;

        // 'admin' solo si el actor es staff de la escuela de la cancha; si no, 'app'.
        let channel: 'app' | 'admin' = 'app';
        if (b.channel === 'admin') {
            const { data: fac } = await supabase.from('facilities').select('school_id').eq('id', b.facility_id).maybeSingle();
            if (fac?.school_id && await isStaffOfSchool(req.user.id, fac.school_id)) channel = 'admin';
        }

        const args: Record<string, unknown> = {
            p_facility_id: b.facility_id,
            p_starts_at: b.starts_at,
            p_ends_at: b.ends_at,
            p_channel: channel,
            p_idempotency_key: req.idempotencyKey,
            p_payment_method: b.payment_method,
            p_actor_profile_id: req.user.id,
        };
        if (b.booker_profile_id) args.p_booker_profile_id = b.booker_profile_id;
        if (b.guest) args.p_guest = b.guest;
        if (b.rate_audience) args.p_rate_audience = b.rate_audience;
        if (b.participants !== undefined) args.p_participants = b.participants;
        if (b.notes !== undefined) args.p_notes = b.notes;
        if (b.external_org_name !== undefined) args.p_external_org_name = b.external_org_name;
        if (b.amount_paid !== undefined) args.p_amount_paid = b.amount_paid;

        const { data, error } = await supabase.rpc('reservar_cancha', args);
        // 201 al crear; 200 si es repetición idempotente (misma respuesta, mismo cuerpo).
        const status = (data as any)?.idempotent_replay ? 200 : 201;
        return sendRpc(res, req, 'reservar_cancha', data, error, status);
    } catch (err: any) {
        req.log?.error({ err }, 'reservations create error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── GET /mine ────────────────────────────────────────────────────────────────
router.get('/mine', async (req: Request, res: Response) => {
    try {
        const upcoming = req.query.upcoming === 'true';
        let q = supabase
            .from('facility_reservations')
            .select('*, facility:facilities(name, type)')
            .eq('user_id', req.user.id)
            .order('starts_at', { ascending: false })
            .limit(100);
        if (upcoming) q = q.gte('ends_at', new Date().toISOString());
        const { data, error } = await q;
        if (error) throw error;
        return res.json({ reservations: (data ?? []).map((r: any) => publicShape(r, false)) });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations mine error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

/** Quita lo interno. `price_snapshot` solo lo ve el staff. */
export function publicShape(r: any, staff: boolean) {
    const { idempotency_key: _k, guest_booker_id: _g, price_snapshot, ...rest } = r;
    return staff ? { ...rest, price_snapshot } : rest;
}

// ── GET /:id ─────────────────────────────────────────────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Reserva no encontrada.' });
        const { data: r, error } = await supabase
            .from('facility_reservations')
            .select('*, facility:facilities(name, type)')
            .eq('id', id)
            .maybeSingle();
        if (error) throw error;
        if (!r) return res.status(404).json({ error: 'Reserva no encontrada.' });
        const isOwner = (r as any).user_id === req.user.id;
        const staff = isOwner ? false : await isStaffOfSchool(req.user.id, (r as any).school_id);
        // 404 (no 403) para no revelar qué ids existen.
        if (!isOwner && !staff) return res.status(404).json({ error: 'Reserva no encontrada.' });
        return res.json({ reservation: publicShape(r, staff) });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations get error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── POST /:id/cancel ─────────────────────────────────────────────────────────
const CancelSchema = z.object({ reason: z.string().max(500).optional() });

router.post('/:id/cancel', async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Reserva no encontrada.' });
        const parsed = CancelSchema.safeParse(req.body ?? {});
        if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        const args: Record<string, unknown> = { p_reservation_id: id, p_actor_profile_id: req.user.id };
        if (parsed.data.reason) args.p_reason = parsed.data.reason;
        const { data, error } = await supabase.rpc('cancelar_reserva', args);
        return sendRpc(res, req, 'cancelar_reserva', data, error);
    } catch (err: any) {
        req.log?.error({ err }, 'reservations cancel error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// ── POST /:id/reschedule ─────────────────────────────────────────────────────
const RescheduleSchema = z.object({
    starts_at: iso,
    ends_at: iso,
    facility_id: z.string().regex(UUID_RE).optional(),
}).refine((b) => new Date(b.ends_at) > new Date(b.starts_at), { message: 'ends_at debe ser posterior a starts_at', path: ['ends_at'] });

router.post('/:id/reschedule', async (req: Request, res: Response) => {
    try {
        const id = String(req.params.id);
        if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Reserva no encontrada.' });
        const parsed = RescheduleSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
        const args: Record<string, unknown> = {
            p_reservation_id: id,
            p_new_starts_at: parsed.data.starts_at,
            p_new_ends_at: parsed.data.ends_at,
            p_actor_profile_id: req.user.id,
        };
        if (parsed.data.facility_id) args.p_new_facility_id = parsed.data.facility_id;
        const { data, error } = await supabase.rpc('reprogramar_reserva', args);
        return sendRpc(res, req, 'reprogramar_reserva', data, error);
    } catch (err: any) {
        req.log?.error({ err }, 'reservations reschedule error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

export default router;
