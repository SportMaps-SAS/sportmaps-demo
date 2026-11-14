/**
 * glosas.routes — API del ciclo de glosas (Fase 3). Montado en /api/v1/payments/glosas.
 *
 * El BFF es el único caller de los RPCs (service_role). Autoriza al usuario y pasa
 * su id como p_actor; el RPC hace la autorización fina. Endpoints admin usan
 * requireAuth; endpoints de acudiente usan validación JWT liviana (los padres no
 * son school_members, como en /extract-receipt).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    createGlosa, respondGlosa, conciliateGlosa, resolveGlosa, reopenGlosa,
    listGlosasBySchool, listGlosasForParent,
    sendGlosaCreatedEmail, sendGlosaRespondedEmail, sendGlosaResolvedEmail,
    GlosaRpcError,
} from '../services/glosa.service';
import { evaluatePaymentReceipt } from '../services/receipt-approval.service';
import { destinatarioDelCobro } from '../utils/destinatarioDelCobro';

const router = Router();

// Cliente anon solo para validar JWTs de acudientes (sin membership de escuela).
const supabaseAnonClient = createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_ANON_KEY || '',
    { auth: { autoRefreshToken: false, persistSession: false } },
);

const REASONS = [
    'MONTO_DIFIERE', 'FECHA_FUERA_VENTANA', 'REFERENCIA_DUPLICADA', 'DESTINO_NO_COINCIDE',
    'CAMPOS_ILEGIBLES', 'LECTURA_INCONSISTENTE', 'NO_APARECE_EN_BANCO', 'OTRO',
] as const;

// Mapea el código Postgres del RPC a un HTTP status con mensaje claro.
function sendGlosaError(err: unknown, res: Response) {
    const code = err instanceof GlosaRpcError ? err.code : undefined;
    switch (code) {
        case '23505':
            return res.status(409).json({ error: 'Este pago ya tiene una aclaración en curso.' });
        case '42501':
            return res.status(403).json({ error: 'No estás autorizado para esta acción.' });
        case '02000':
            return res.status(404).json({ error: 'No encontrado.' });
        case '22023':
            return res.status(400).json({ error: (err as Error).message });
        default:
            return res.status(500).json({ error: 'No se pudo procesar la glosa.' });
    }
}

/** Valida el JWT y devuelve el user, o responde 401. Para endpoints de acudiente. */
async function getJwtUser(req: AuthenticatedRequest, res: Response) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Token de autorización requerido.' });
        return null;
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabaseAnonClient.auth.getUser(token);
    if (error || !user) {
        res.status(401).json({ error: 'Token inválido o expirado.' });
        return null;
    }
    return user;
}

// ── Admin ───────────────────────────────────────────────────────────────────

const CreateSchema = z.object({
    paymentId: z.string().uuid(),
    reason: z.enum(REASONS),
    reasonDetail: z.unknown().optional(),
    respondsBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
    try {
        const id = await createGlosa(
            req.user.id, parsed.data.paymentId, parsed.data.reason,
            parsed.data.reasonDetail ?? null, parsed.data.respondsBy,
        );
        void sendGlosaCreatedEmail(id, req.log);
        return res.status(201).json({ id });
    } catch (err) {
        req.log?.warn({ err }, '[glosa] create falló');
        return sendGlosaError(err, res);
    }
});

router.post('/:id/conciliate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        await conciliateGlosa(req.user.id, String(req.params.id));
        return res.json({ ok: true });
    } catch (err) {
        return sendGlosaError(err, res);
    }
});

const ResolveSchema = z.object({
    outcome: z.enum(['ACEPTADA', 'RATIFICADA']),
    resolutionNote: z.string().trim().min(1, 'La nota es obligatoria'),
});

router.post('/:id/resolve', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
    try {
        await resolveGlosa(req.user.id, String(req.params.id), parsed.data.outcome, parsed.data.resolutionNote);
        void sendGlosaResolvedEmail(String(req.params.id), parsed.data.outcome, req.log);
        return res.json({ ok: true });
    } catch (err) {
        req.log?.warn({ err }, '[glosa] resolve falló');
        return sendGlosaError(err, res);
    }
});

const ReopenSchema = z.object({ note: z.string().trim().min(1, 'La nota es obligatoria') });

router.post('/:id/reopen', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const parsed = ReopenSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
    try {
        await reopenGlosa(req.user.id, String(req.params.id), parsed.data.note);
        return res.json({ ok: true });
    } catch (err) {
        return sendGlosaError(err, res);
    }
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const status = typeof req.query.status === 'string' ? req.query.status : undefined;
        const rows = await listGlosasBySchool(req.schoolId, status);
        return res.json(rows);
    } catch (err) {
        return sendGlosaError(err, res);
    }
});

// auto-evaluate (Fase 5): el frontend lo llama tras insertar un comprobante con veredicto.
// El servidor decide (auto-aprobar / glosa / nada) de forma server-authoritative. JWT liviano
// porque lo dispara el acudiente (no es school_member); verifica que sea dueño del pago.
router.post('/auto-evaluate', async (req: AuthenticatedRequest, res: Response) => {
    const user = await getJwtUser(req, res);
    if (!user) return;
    const paymentId = typeof req.body?.paymentId === 'string' ? req.body.paymentId : null;
    if (!paymentId) return res.status(400).json({ error: 'paymentId requerido' });
    // Ownership: solo el acudiente del pago puede disparar su evaluación (evita abuso/DoS de re-OCR).
    // Dueño = acudiente o, si el cobro no tiene, el adulto titular (user_id).
    const { data: owner } = await supabase.from('payments').select('parent_id, user_id').eq('id', paymentId).single();
    if (!owner || destinatarioDelCobro(owner) !== user.id) {
        return res.status(403).json({ error: 'No autorizado sobre este pago.' });
    }
    const result = await evaluatePaymentReceipt(paymentId, req.log);
    return res.json(result); // { action: 'approved'|'glosa'|'none', glosaId? }
});

// ── Acudiente (JWT liviano) ──────────────────────────────────────────────────

const RespondSchema = z.object({
    responseText: z.string().trim().min(1, 'Escribe tu aclaración'),
    responseFiles: z.unknown().optional(),
});

router.post('/:id/respond', async (req: AuthenticatedRequest, res: Response) => {
    const user = await getJwtUser(req, res);
    if (!user) return;
    const parsed = RespondSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.issues });
    try {
        await respondGlosa(user.id, String(req.params.id), parsed.data.responseText, parsed.data.responseFiles ?? null);
        void sendGlosaRespondedEmail(String(req.params.id), req.log);
        return res.json({ ok: true });
    } catch (err) {
        return sendGlosaError(err, res);
    }
});

router.get('/mine', async (req: AuthenticatedRequest, res: Response) => {
    const user = await getJwtUser(req, res);
    if (!user) return;
    try {
        const rows = await listGlosasForParent(user.id);
        return res.json(rows);
    } catch (err) {
        return sendGlosaError(err, res);
    }
});

export default router;
