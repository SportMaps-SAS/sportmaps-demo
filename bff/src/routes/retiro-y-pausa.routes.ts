/**
 * retiro-y-pausa.routes — pausar, retirar y reactivar el plan desde la app
 * (docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6).
 *
 * MONTAJE (bff/src/index.ts, NO editado por esta entrega):
 *   import retiroYPausaRouter from './routes/retiro-y-pausa.routes';
 *   app.use('/api/v1/plan-requests', generalLimiter, retiroYPausaRouter);
 *
 * Todas las rutas exigen sesión (requireAuth). Los permisos NO dependen del rol
 * de school_members: dependen de la inscripción (acudiente del menor / adulto
 * dueño) o de ser administración de la escuela de la solicitud.
 *
 *   POST   /pausa                           pedir pausa (meses completos)         familia
 *   POST   /retiro                          pedir retiro                          familia
 *   POST   /reactivacion                    pedir reactivación                    familia
 *   DELETE /:tipo/:id                       cancelar la propia solicitud abierta  familia | admin
 *   GET    /mias?estado=                    mis solicitudes                       familia
 *   GET    /escuela/:schoolId?estado=&tipo=&limit=   bandeja de la escuela        administración
 *   POST   /:tipo/:id/resolver              aprobar / rechazar                    administración
 *
 * `:tipo` ∈ pausa | retiro | reactivacion.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middlewares/authMiddleware';
import {
    ListaEscuelaQuery, ListaMiasQuery, PausaSchema, ReactivacionSchema, ResolverSchema, RetiroSchema, TipoSchema,
    cancelarSolicitud, esAdminDeEscuela, listarDeEscuela, listarMias, pedirPausa, pedirReactivacion, pedirRetiro,
    resolverSolicitud, type Ctx, type Resultado,
} from '../services/retiro-y-pausa.service';

const router = Router();
router.use(requireAuth);

const IdParam = z.object({ id: z.string().uuid('Identificador inválido') });
const EscuelaParam = z.object({ schoolId: z.string().uuid('Identificador de escuela inválido') });

function ctxDe(req: Request): Ctx {
    return { actorId: req.user.id, canal: 'app', authorization: String(req.headers.authorization ?? '') };
}

function validar<T extends z.ZodTypeAny>(schema: T, valor: unknown, res: Response): z.infer<T> | null {
    const r = schema.safeParse(valor);
    if (r.success) return r.data;
    res.status(400).json({
        error: 'Datos inválidos',
        detalles: r.error.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })),
    });
    return null;
}

function responder(req: Request, res: Response, r: Resultado<any>, okStatus = 200) {
    if (r.ok) return res.status(okStatus).json(r.data);
    return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
}

function falloInterno(req: Request, res: Response, e: unknown, donde: string) {
    console.error(`[plan-requests] ${donde} falló`, { err: (e as any)?.message });
    return res.status(500).json({ error: 'No se pudo completar la solicitud.' });
}

router.post('/pausa', async (req: Request, res: Response) => {
    const body = validar(PausaSchema, req.body, res);
    if (!body) return;
    try {
        const r = await pedirPausa(ctxDe(req), body);
        if (r.ok) req.log?.info?.({ evento: 'pausa_pedida', actor: req.user.id, enrollment_id: body.enrollment_id, status: r.data?.status }, 'pausa_pedida');
        return responder(req, res, r, 201);
    } catch (e) { return falloInterno(req, res, e, 'pedir pausa'); }
});

router.post('/retiro', async (req: Request, res: Response) => {
    const body = validar(RetiroSchema, req.body, res);
    if (!body) return;
    try {
        const r = await pedirRetiro(ctxDe(req), body);
        if (r.ok) req.log?.info?.({ evento: 'retiro_pedido', actor: req.user.id, enrollment_id: body.enrollment_id }, 'retiro_pedido');
        return responder(req, res, r, 201);
    } catch (e) { return falloInterno(req, res, e, 'pedir retiro'); }
});

router.post('/reactivacion', async (req: Request, res: Response) => {
    const body = validar(ReactivacionSchema, req.body, res);
    if (!body) return;
    try {
        const r = await pedirReactivacion(ctxDe(req), body);
        if (r.ok) req.log?.info?.({ evento: 'reactivacion_pedida', actor: req.user.id, enrollment_id: body.enrollment_id }, 'reactivacion_pedida');
        return responder(req, res, r, 201);
    } catch (e) { return falloInterno(req, res, e, 'pedir reactivación'); }
});

router.get('/mias', async (req: Request, res: Response) => {
    const q = validar(ListaMiasQuery, req.query, res);
    if (!q) return;
    try {
        return res.json({ solicitudes: await listarMias(req.user.id, q.estado) });
    } catch (e) { return falloInterno(req, res, e, 'listar mías'); }
});

router.get('/escuela/:schoolId', async (req: Request, res: Response) => {
    const p = validar(EscuelaParam, req.params, res);
    if (!p) return;
    const q = validar(ListaEscuelaQuery, req.query, res);
    if (!q) return;
    try {
        if (!(await esAdminDeEscuela(req.user.id, p.schoolId))) return res.status(403).json({ error: 'No autorizado.', code: 'forbidden' });
        return res.json({ solicitudes: await listarDeEscuela(p.schoolId, q) });
    } catch (e) { return falloInterno(req, res, e, 'listar escuela'); }
});

router.post('/:tipo/:id/resolver', async (req: Request, res: Response) => {
    const tipo = validar(TipoSchema, req.params.tipo, res);
    if (!tipo) return;
    const p = validar(IdParam, { id: req.params.id }, res);
    if (!p) return;
    const body = validar(ResolverSchema, req.body, res);
    if (!body) return;
    try {
        const r = await resolverSolicitud(ctxDe(req), tipo, p.id, body);
        if (r.ok) req.log?.info?.({ evento: 'solicitud_plan_resuelta', actor: req.user.id, tipo, id: p.id, decision: body.decision }, 'solicitud_plan_resuelta');
        return responder(req, res, r);
    } catch (e) { return falloInterno(req, res, e, 'resolver'); }
});

router.delete('/:tipo/:id', async (req: Request, res: Response) => {
    const tipo = validar(TipoSchema, req.params.tipo, res);
    if (!tipo) return;
    const p = validar(IdParam, { id: req.params.id }, res);
    if (!p) return;
    try {
        return responder(req, res, await cancelarSolicitud(ctxDe(req), tipo, p.id));
    } catch (e) { return falloInterno(req, res, e, 'cancelar'); }
});

export default router;
