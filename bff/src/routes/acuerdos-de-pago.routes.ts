/**
 * acuerdos-de-pago.routes — pago por plazos (spec campanas-descuento-referidos-y-plazos-por-whatsapp §5).
 *
 * MONTAJE (NO está montado: este archivo no toca index.ts). En index.ts:
 *   import acuerdosDePagoRouter from './routes/acuerdos-de-pago.routes';
 *   app.use('/api/v1/payment-agreements', generalLimiter, acuerdosDePagoRouter);
 *
 *   GET  /settings/:schoolId        topes de la escuela { habilitado, max_cuotas, max_dias, auto_aprobar }
 *   PUT  /settings/:schoolId        guarda los topes { habilitado, max_cuotas, max_dias, auto_aprobar } (solo administración)
 *   POST /preview                   propone/valida el calendario (no escribe)
 *   POST /                          solicita el acuerdo (RPC request_payment_agreement)
 *   GET  /mine                      los acuerdos del propio usuario (?estado=activo,solicitado)
 *   GET  /school/:schoolId          los de la escuela (staff; ?estado=)
 *   POST /:id/resolve               { decision: 'aprobar'|'rechazar', nota? }  solo administración
 *   POST /:id/cancel                { nota? }  pagador / quien pidió / administración
 *
 * Autorización: requireAuth; el alcance real lo imponen la RLS y las RPC (se llaman con el JWT
 * del usuario, nunca con service role). Un acuerdo ajeno o de otra escuela da 404/403/lista vacía.
 * Con la migración 20261106160002 sin aplicar responde 503 `migracion_pendiente`.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedRequest } from '../middlewares/authMiddleware';
import {
    ESTADOS_ACUERDO, MAX_CUOTAS_ABSOLUTO, acuerdosDeEscuela, alcanceEnEscuela, cancelar, clienteDeUsuario, guardarTopes,
    misAcuerdos, previsualizar, resolver, solicitar, topesDeEscuela, type EstadoAcuerdo,
} from '../services/acuerdos-de-pago.service';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID);
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PreviewSchema = z.object({
    school_id: uuid,
    payment_ids: z.array(uuid).min(1).max(50),
    cuotas: z.number().int().min(1).max(MAX_CUOTAS_ABSOLUTO).optional(),
    fechas: z.array(fecha).min(1).max(MAX_CUOTAS_ABSOLUTO).optional(),
    montos: z.array(z.number().int().positive()).min(1).max(MAX_CUOTAS_ABSOLUTO).optional(),
}).refine((b) => b.cuotas !== undefined || b.fechas !== undefined || b.montos !== undefined, { message: 'cuotas_fechas_o_montos' });

export const SolicitarSchema = z.object({
    school_id: uuid,
    payment_ids: z.array(uuid).min(1).max(50),
    items: z.array(z.object({ due_date: fecha, amount: z.number().int().positive() })).min(1).max(MAX_CUOTAS_ABSOLUTO),
    /** Solo la administración (a nombre de un pagador) o el bot con service role. */
    payer_profile_id: uuid.optional(),
});

export const ResolverSchema = z.object({
    decision: z.enum(['aprobar', 'rechazar']),
    nota: z.string().trim().max(500).optional(),
});
export const CancelarSchema = z.object({ nota: z.string().trim().max(500).optional() });

export const TopesSchema = z.object({
    habilitado: z.boolean(),
    max_cuotas: z.number().int().min(1).max(MAX_CUOTAS_ABSOLUTO),
    max_dias: z.number().int().min(1).max(365),
    auto_aprobar: z.boolean(),
});

const auth = (req: AuthenticatedRequest) => String(req.headers.authorization ?? '');

function estadosDe(q: unknown): EstadoAcuerdo[] | undefined {
    if (typeof q !== 'string' || !q) return undefined;
    const l = q.split(',').map((s) => s.trim()).filter((s): s is EstadoAcuerdo => (ESTADOS_ACUERDO as readonly string[]).includes(s));
    return l.length ? l : undefined;
}

function fallo(res: Response, req: AuthenticatedRequest, donde: string, e: any) {
    console.error(`[acuerdos] ${donde} falló`, { err: e?.message });
    return res.status(500).json({ error: 'No se pudo completar la operación de acuerdos de pago' });
}

router.get('/settings/:schoolId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'id inválido' });
    try {
        const t = await topesDeEscuela(schoolId);
        return res.json({ habilitado: t.habilitado, max_cuotas: t.maxCuotas, max_dias: t.maxDias, auto_aprobar: t.autoAprobar });
    } catch (e) { return fallo(res, req, 'settings', e); }
});

router.put('/settings/:schoolId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'id inválido' });
    const p = TopesSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'datos_invalidos', detalle: p.error.issues.map((i) => i.message) });
    try {
        const alcance = await alcanceEnEscuela(clienteDeUsuario(auth(req)), schoolId);
        if (!alcance.admin) return res.status(403).json({ error: 'forbidden' });
        const r = await guardarTopes(schoolId, {
            habilitado: p.data.habilitado, maxCuotas: p.data.max_cuotas, maxDias: p.data.max_dias, autoAprobar: p.data.auto_aprobar,
        });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ habilitado: r.topes.habilitado, max_cuotas: r.topes.maxCuotas, max_dias: r.topes.maxDias, auto_aprobar: r.topes.autoAprobar });
    } catch (e) { return fallo(res, req, 'guardar-settings', e); }
});

router.post('/preview', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const p = PreviewSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'datos_invalidos', detalle: p.error.issues.map((i) => i.message) });
    try {
        const r = await previsualizar(clienteDeUsuario(auth(req)), {
            schoolId: p.data.school_id, paymentIds: p.data.payment_ids,
            cuotas: p.data.cuotas, fechas: p.data.fechas, montos: p.data.montos,
        });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        const c = r.calendario;
        return res.json({
            saldo_total: c.saldoTotal,
            cuotas: c.cuotas.map((q) => ({ seq: q.seq, fecha: q.fecha, monto: q.monto })),
            primera_fecha: c.primeraFecha, ultima_fecha: c.ultimaFecha, dias: c.dias,
            requiere_aprobacion: c.requiereAprobacion, motivos: c.motivos,
            topes: { max_cuotas: r.topes.maxCuotas, max_dias: r.topes.maxDias, auto_aprobar: r.topes.autoAprobar },
            cobros: r.cobros,
        });
    } catch (e) { return fallo(res, req, 'preview', e); }
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const p = SolicitarSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'datos_invalidos', detalle: p.error.issues.map((i) => i.message) });
    try {
        const r = await solicitar(clienteDeUsuario(auth(req)), {
            schoolId: p.data.school_id, paymentIds: p.data.payment_ids,
            items: p.data.items, payerProfileId: p.data.payer_profile_id ?? null,
        });
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        req.log?.info({ agreement: r.acuerdo.agreement_id, status: r.acuerdo.status }, '[acuerdos] solicitado');
        return res.status(201).json({
            agreement_id: r.acuerdo.agreement_id, status: r.acuerdo.status, auto_aprobado: r.acuerdo.auto_approved,
            total: r.acuerdo.total_amount, cuotas: r.acuerdo.installments,
        });
    } catch (e) { return fallo(res, req, 'solicitar', e); }
});

router.get('/mine', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const r = await misAcuerdos(clienteDeUsuario(auth(req)), req.user.id, estadosDe((req.query as any).estado));
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ acuerdos: r.acuerdos });
    } catch (e) { return fallo(res, req, 'mine', e); }
});

router.get('/school/:schoolId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { schoolId } = req.params as { schoolId: string };
    if (!UUID.test(schoolId)) return res.status(400).json({ error: 'id inválido' });
    try {
        const db = clienteDeUsuario(auth(req));
        const alcance = await alcanceEnEscuela(db, schoolId);
        if (!alcance.staff && !alcance.admin) return res.status(403).json({ error: 'forbidden' });
        const r = await acuerdosDeEscuela(db, schoolId, estadosDe((req.query as any).estado));
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ acuerdos: r.acuerdos, puede_resolver: alcance.admin });
    } catch (e) { return fallo(res, req, 'school', e); }
});

router.post('/:id/resolve', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return res.status(400).json({ error: 'id inválido' });
    const p = ResolverSchema.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: 'datos_invalidos' });
    try {
        const r = await resolver(clienteDeUsuario(auth(req)), id, p.data.decision, p.data.nota ?? null);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ agreement_id: r.agreement_id, status: r.status });
    } catch (e) { return fallo(res, req, 'resolver', e); }
});

router.post('/:id/cancel', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    const { id } = req.params as { id: string };
    if (!UUID.test(id)) return res.status(400).json({ error: 'id inválido' });
    const p = CancelarSchema.safeParse(req.body ?? {});
    if (!p.success) return res.status(400).json({ error: 'datos_invalidos' });
    try {
        const r = await cancelar(clienteDeUsuario(auth(req)), id, p.data.nota ?? null);
        if (!r.ok) return res.status(r.status).json({ error: r.error });
        return res.json({ agreement_id: r.agreement_id, status: r.status });
    } catch (e) { return fallo(res, req, 'cancelar', e); }
});

export default router;
