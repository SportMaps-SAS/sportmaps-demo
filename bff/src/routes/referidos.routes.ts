/**
 * Referidos automáticos (spec campanas-descuento-referidos-y-plazos-por-whatsapp §4, F1).
 *
 *   GET   /api/v1/referidos/campaign        campaña de la escuela (o null) + tramos por defecto — admin + contador
 *   PUT   /api/v1/referidos/campaign        crea/actualiza la campaña (apagada por defecto)     — admin
 *   POST  /api/v1/referidos                 registra un referido (captura)                       — admin
 *   PATCH /api/v1/referidos/:id             { action: vincular | cambiar_inscripcion | anular }  — admin
 *   GET   /api/v1/referidos?year&month&status&referred_enrollment_id   listado                   — admin + contador
 *   GET   /api/v1/referidos/report?year&month   informe con totales por estado y por mes          — admin + contador
 *
 * MONTAJE (NO se hizo aquí; lo registra quien integre en bff/src/index.ts):
 *   import referidosRoutes from './routes/referidos.routes';
 *   app.use('/api/v1/referidos', referidosRoutes);
 *
 * Autorización: requireRole (filtro grueso) + assertSchoolFinanceAdmin / Reader (el gate real: rol EN
 * ESTA escuela, escuela = encabezado x-school-id). Coach, reporter, acudiente y atleta: 403. Las RPC
 * re-validan el alcance del actor sobre esa escuela (p_actor). El descuento NO se calcula aquí: lo
 * aplica open_month al cerrar el mes.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import { assertSchoolFinanceAdmin, assertSchoolFinanceReader } from '../middlewares/assertSchoolFinanceAdmin';
import { primerError } from '../services/charge-batches.schemas';
import {
    ActualizarReferidoSchema, CampanaSchema, InformeQuerySchema, RegistrarReferidoSchema, ReferidosError,
    TRAMOS_POR_DEFECTO, actualizarReferido, guardarCampana, informeReferidos, leerCampana, registrarReferido,
} from '../services/referidos.service';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin', 'school_admin'] as const;
const LECTURA_ROLES = [...ADMIN_ROLES, 'accountant'] as const;

function responderError(req: Request, res: Response, err: unknown) {
    if (err instanceof ReferidosError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
    }
    req.log?.error?.({ err }, 'referidos: error inesperado');
    return res.status(500).json({ error: 'No se pudo completar la operación. Intenta de nuevo.', code: 'ERROR_INTERNO' });
}

/** zod → 422 con el primer mensaje en español y la lista completa. */
function validar<T>(schema: z.ZodType<T>, valor: unknown, res: Response): T | null {
    const r = schema.safeParse(valor);
    if (!r.success) {
        res.status(422).json({
            error: primerError(r.error),
            code: 'VALIDACION',
            issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return null;
    }
    return r.data;
}

const IdParam = z.object({ id: z.string().uuid('Identificador de referido inválido.') });

router.use(requireAuth);

// ─── Campaña ─────────────────────────────────────────────────────────────────
router.get(
    '/campaign',
    requireRole(...LECTURA_ROLES),
    assertSchoolFinanceReader,
    async (req: Request, res: Response, _next: NextFunction) => {
        try {
            const campaign = await leerCampana(req.schoolId);
            return res.json({ campaign, tramos_por_defecto: TRAMOS_POR_DEFECTO });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

router.put(
    '/campaign',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const body = validar(CampanaSchema, req.body, res);
        if (!body) return;
        try {
            const campaign = await guardarCampana(req.schoolId, req.user.id, body);
            req.log?.info?.({ evento: 'referidos_campana_guardada', school_id: req.schoolId, actor: req.user.id, active: body.active }, 'referidos_campana_guardada');
            return res.json({ campaign });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Informe (antes de /:id para que «report» no se lea como id) ─────────────
router.get(
    '/report',
    requireRole(...LECTURA_ROLES),
    assertSchoolFinanceReader,
    async (req: Request, res: Response) => {
        const q = validar(InformeQuerySchema, req.query, res);
        if (!q) return;
        try {
            return res.json(await informeReferidos(req.schoolId, req.user.id, q));
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Listado ─────────────────────────────────────────────────────────────────
router.get(
    '/',
    requireRole(...LECTURA_ROLES),
    assertSchoolFinanceReader,
    async (req: Request, res: Response) => {
        const q = validar(InformeQuerySchema, req.query, res);
        if (!q) return;
        try {
            const informe = await informeReferidos(req.schoolId, req.user.id, q);
            return res.json({ rows: informe.rows, total: informe.totals?.total ?? informe.rows.length });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Captura y gestión ───────────────────────────────────────────────────────
router.post(
    '/',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const body = validar(RegistrarReferidoSchema, req.body, res);
        if (!body) return;
        try {
            const r = await registrarReferido(req.schoolId, req.user.id, body);
            if (!r.ok) return res.status(200).json(r); // no califica (p. ej. menor de 4): no es un error
            req.log?.info?.({ evento: 'referido_registrado', school_id: req.schoolId, actor: req.user.id }, 'referido_registrado');
            return res.status(201).json(r);
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

router.patch(
    '/:id',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const p = validar(IdParam, req.params, res);
        if (!p) return;
        const body = validar(ActualizarReferidoSchema, req.body, res);
        if (!body) return;
        try {
            const r = await actualizarReferido(p.id, req.user.id, body);
            req.log?.info?.({ evento: 'referido_actualizado', school_id: req.schoolId, actor: req.user.id, referral_id: p.id, action: body.action }, 'referido_actualizado');
            return res.json(r);
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

export default router;
