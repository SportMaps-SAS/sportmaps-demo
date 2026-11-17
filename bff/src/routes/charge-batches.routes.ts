/**
 * Modal «Cobros y pagos» — operaciones (spec docs/specs/cobros-multiples.md §9.1, F2).
 *
 *   POST /api/v1/charge-batches/preview         vista previa (no escribe)
 *   POST /api/v1/charge-batches                 confirma: crea cobros, ajustes y pagos (una transacción)
 *   GET  /api/v1/charge-batches                 historial («Operaciones») — admin + contador
 *   GET  /api/v1/charge-batches/targets         atletas activos de un equipo / categoría / plan
 *   GET  /api/v1/charge-batches/athlete-search  buscador + duplicados antes de «+ Atleta nuevo»
 *   GET  /api/v1/charge-batches/:id             detalle con el estado actual de cada cobro — admin + contador
 *   POST /api/v1/charge-batches/:id/annul       anula lo anulable del lote (Q12)
 *
 * Autorización: requireRole (filtro grueso) + assertSchoolFinanceAdmin /
 * assertSchoolFinanceReader (el gate real: rol EN ESTA escuela). Coach,
 * reporter, acudiente y atleta: 403. La RPC re-valida `p_actor`.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import { assertSchoolFinanceAdmin, assertSchoolFinanceReader } from '../middlewares/assertSchoolFinanceAdmin';
import { chargeBatchRateLimit } from '../middlewares/chargeBatchRateLimit';
import { cobrosRateLimit } from '../middlewares/cobrosRateLimit';
import {
    ChargeBatchRequestSchema, ChargeBatchCreateSchema, AnnulSchema, ListQuerySchema, ReintentoHorasSchema,
    TargetsQuerySchema, AthleteSearchQuerySchema, primerError, filasDeLaOperacion,
    type ChargeBatchRequest,
} from '../services/charge-batches.schemas';
import {
    CobrosError, verificarPertenencia, previewChargeBatch, createChargeBatch, annulChargeBatch,
    listarLotes, detalleLote, atletasDelGrupo,
} from '../services/charge-batches.service';
import {
    lineaDeHoras, reintentarSumaDeHoras, revertirHorasDeLote, sumarHorasAdicionales, verificarHorasAdicionales,
} from '../services/hour-bank-extra.service';
import { verificarComprobanteConHoras } from '../services/comprobante-horas';
import { verificarConstanciaDeRecibido, anotarRecibido } from '../services/constancia-de-recibido';
import { buscarCobroDuplicadoReciente, verificarCobroDuplicado } from '../services/cobro-duplicado-reciente';
import { buscarCoincidencias } from '../services/athlete-duplicates.service';

const router = Router();

const ADMIN_ROLES = ['owner', 'admin', 'school_admin'] as const;
const LECTURA_ROLES = [...ADMIN_ROLES, 'accountant'] as const;

/** Respuesta uniforme de error: CobrosError → su status; lo demás → 500 sin detalles internos. */
export function responderError(req: Request, res: Response, err: unknown) {
    if (err instanceof CobrosError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    }
    req.log?.error?.({ err }, 'charge-batches: error inesperado');
    return res.status(500).json({ error: 'No se pudo completar la operación. Intenta de nuevo.', code: 'ERROR_INTERNO' });
}

/** zod → 422 con el primer mensaje en español y la lista completa para el modal. */
export function validar<T>(schema: z.ZodType<T>, valor: unknown, res: Response): T | null {
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

/** H4 / Q6: las horas adicionales solo las factura el dueño. */
function exigirDuenoSiHayExcedente(req: Request, b: ChargeBatchRequest) {
    if (b.lines.some((l) => l.category === 'excedente') && req.nivelFinanzas !== 'dueno') {
        throw new CobrosError(403, 'SOLO_DUENO_EXCEDENTE', 'Solo el dueño de la escuela puede facturar horas adicionales.');
    }
}

// Después de requireAuth: el cupo es POR USUARIO (lectura 120/min, preview 60/min,
// escritura 20/min — ver cobrosRateLimit.ts). Confirmar suma además chargeBatchRateLimit.
router.use(requireAuth, (req: Request, res: Response, next: NextFunction) => cobrosRateLimit.porRequest(req, res, next));

// ─── Vista previa ────────────────────────────────────────────────────────────
router.post(
    '/preview',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const body = validar(ChargeBatchRequestSchema, req.body, res);
        if (!body) return;
        try {
            exigirDuenoSiHayExcedente(req, body);
            await verificarPertenencia(req.schoolId, body);
            await verificarHorasAdicionales(req.schoolId, body);
            verificarComprobanteConHoras(body);
            const data = await previewChargeBatch(req.schoolId, req.user.id, body);
            // Aviso (no bloqueo): ¿otra persona registró lo mismo hace pocos minutos?
            const recientes = await buscarCobroDuplicadoReciente(req.schoolId, body);
            return res.json(recientes.length ? { ...data, recent_duplicates: recientes } : data);
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Confirmar ───────────────────────────────────────────────────────────────
router.post(
    '/',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    (req: Request, res: Response, next: NextFunction) => {
        const body = validar(ChargeBatchCreateSchema, req.body, res);
        if (!body) return;
        res.locals.body = body;
        res.locals.filasDelLote = filasDeLaOperacion(body);
        res.locals.clientRequestId = body.client_request_id;
        next();
    },
    (req: Request, res: Response, next: NextFunction) => chargeBatchRateLimit.middleware(req, res, next),
    async (req: Request, res: Response) => {
        const body = res.locals.body as z.infer<typeof ChargeBatchCreateSchema>;
        const inicio = Date.now();
        try {
            exigirDuenoSiHayExcedente(req, body);
            await verificarPertenencia(req.schoolId, body);
            await verificarHorasAdicionales(req.schoolId, body);
            verificarComprobanteConHoras(body);
            // Pago sin comprobante: exige quién lo recibió (se anota en notes tras crear).
            verificarConstanciaDeRecibido(body);
            await verificarCobroDuplicado(req.schoolId, body);
            const data = await createChargeBatch(req.schoolId, req.user.id, body);
            const recibidoAnotado = await anotarRecibido(req.schoolId, data.batch_id as string | undefined, data, body.payment);
            if (!recibidoAnotado) {
                req.log?.warn?.({ evento: 'recibido_sin_anotar', batch_id: data.batch_id ?? null, school_id: req.schoolId }, 'charge_batch: no se pudo anotar quién recibió el pago');
            }
            // Venta de horas por adelantado: con el cobro ya creado, se suman al banco (idempotente por pago).
            const ventaDeHoras = lineaDeHoras(body);
            const horas = ventaDeHoras
                ? await sumarHorasAdicionales(req.schoolId, req.user.id, data.batch_id as string | undefined, ventaDeHoras, body.athletes[0])
                : null;
            // §9.3: log estructurado sin nombres de menores.
            req.log?.info?.({
                evento: 'charge_batch_created',
                school_id: req.schoolId,
                actor: req.user.id,
                batch_id: data.batch_id ?? null,
                duplicated: data.duplicated === true,
                mode: body.mode,
                athletes: body.athletes.length + (body.new_athlete ? 1 : 0),
                lines: body.lines.length,
                pending: body.pending.length,
                rows_created: data.rows_created ?? null,
                total_amount: data.total_amount ?? null,
                hour_bank_grant: horas ? (horas.ok ? 'ok' : horas.reason) : undefined,
                ms: Date.now() - inicio,
            }, 'charge_batch_created');
            return res.status(200).json({ ...data, ...(recibidoAnotado ? {} : { recibido_sin_anotar: true }), ...(horas ? { hour_bank_grant: horas } : {}) });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Historial ───────────────────────────────────────────────────────────────
router.get(
    '/',
    requireRole(...LECTURA_ROLES),
    assertSchoolFinanceReader,
    async (req: Request, res: Response) => {
        const q = validar(ListQuerySchema, req.query, res);
        if (!q) return;
        try {
            return res.json(await listarLotes(req.schoolId, q.cursor, q.limit));
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Destinos por grupo (antes de /:id) ─────────────────────────────────────
router.get(
    '/targets',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const q = validar(TargetsQuerySchema, req.query, res);
        if (!q) return;
        try {
            const r = await atletasDelGrupo(req.schoolId, q.kind, q.id, q.include_paused);
            const sinAcudiente = r.athletes.filter((a: any) => a.has_guardian === false).length;
            return res.json({ ...r, count: r.athletes.length, without_guardian: sinAcudiente });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Buscador / duplicados («+ Atleta nuevo») ───────────────────────────────
router.get(
    '/athlete-search',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const q = validar(AthleteSearchQuerySchema, req.query, res);
        if (!q) return;
        try {
            const items = await buscarCoincidencias(
                req.schoolId,
                { fullName: q.q, docNumber: q.doc, phone: q.phone },
                { modo: 'buscador', limite: 20 },
            );
            return res.json({
                items,
                // ¿Hay un duplicado real? (documento o nombre). El teléfono solo es informativo.
                has_duplicate: items.some((i) => i.es_duplicado),
            });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

const IdParam = z.object({ id: z.string().uuid('Identificador de operación inválido') });

// ─── Detalle ─────────────────────────────────────────────────────────────────
router.get(
    '/:id',
    requireRole(...LECTURA_ROLES),
    assertSchoolFinanceReader,
    async (req: Request, res: Response) => {
        const p = validar(IdParam, req.params, res);
        if (!p) return;
        try {
            return res.json(await detalleLote(req.schoolId, p.id));
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Anular ──────────────────────────────────────────────────────────────────
router.post(
    '/:id/annul',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const p = validar(IdParam, req.params, res);
        if (!p) return;
        const body = validar(AnnulSchema, req.body, res);
        if (!body) return;
        try {
            const data = await annulChargeBatch(req.schoolId, req.user.id, p.id, body.reason, body.expected_count);
            // Horas vendidas con los cobros que se anularon: se restan del banco (nunca lanza).
            const idsAnulados = Array.isArray(data.annulled_ids) ? (data.annulled_ids as string[]) : [];
            const horasRevertidas = idsAnulados.length
                ? await revertirHorasDeLote(req.schoolId, req.user.id, idsAnulados, `Cobro anulado: ${body.reason}`.slice(0, 300))
                : null;
            req.log?.info?.({
                evento: 'charge_batch_annulled', school_id: req.schoolId, actor: req.user.id, batch_id: p.id,
                annulled: data.annulled ?? null, hour_bank_reverted: horasRevertidas?.reverted ?? undefined,
            }, 'charge_batch_annulled');
            return res.json(horasRevertidas && (horasRevertidas.reverted > 0 || horasRevertidas.errors.length)
                ? { ...data, hour_bank_reverted: horasRevertidas }
                : data);
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

// ─── Reintentar la suma de horas vendidas ───────────────────────────────────
// El cobro ya se creó y se pagó pero las horas no entraron al banco (falló la suma, o el pago se
// registró después). Idempotente por pago: reintentar nunca suma dos veces. Solo el dueño.
router.post(
    '/:id/hour-bank',
    requireRole(...ADMIN_ROLES),
    assertSchoolFinanceAdmin,
    async (req: Request, res: Response) => {
        const p = validar(IdParam, req.params, res);
        if (!p) return;
        const body = validar(ReintentoHorasSchema, req.body, res);
        if (!body) return;
        try {
            if (req.nivelFinanzas !== 'dueno') {
                throw new CobrosError(403, 'SOLO_DUENO_EXCEDENTE', 'Solo el dueño de la escuela puede sumar horas adicionales.');
            }
            const data = await reintentarSumaDeHoras(req.schoolId, req.user.id, p.id, body.athlete, body.enrollment_id, body.extra_hours);
            req.log?.info?.({ evento: 'hour_bank_grant_retry', school_id: req.schoolId, actor: req.user.id, batch_id: p.id, ok: data.ok, reason: data.reason }, 'hour_bank_grant_retry');
            return res.json({ hour_bank_grant: data });
        } catch (err) {
            return responderError(req, res, err);
        }
    },
);

export default router;
