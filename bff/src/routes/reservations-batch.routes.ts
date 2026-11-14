// bff/src/routes/reservations-batch.routes.ts
//
// Lotes de reservas (agentes de IA, importadores CSV/JSON/PDF/Excel, bots). Montado en
// /api/v1/reservations/batch. Contrato: docs/specs/reservas-agentes-ia-contrato-seguro.md
//
// HOY SOLO existe el DRY-RUN (no escribe nada en reservas):
//   POST /api/v1/reservations/batch/dry-run
//
// TODO (NO construido a propósito): POST /api/v1/reservations/batch/apply.
//   Requisitos del contrato §6: confirmación humana explícita (token de confirmación atado al hash
//   del plan del dry-run + usuario + escuela, de un solo uso y de vida corta), todo-o-nada con
//   reporte por fila, una llamada a reservar_cancha(p_channel 'ai'|'import', p_source_ref,
//   p_actor_profile_id = admin) por fila con la Idempotency-Key de deriveIdempotencyKey, nunca
//   amount_paid, topes por actor/hora y auditLog por fila.
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../config/supabase';
import { requireAuth, requireRole } from '../middlewares/authMiddleware';
import { zodBadRequest } from '../middlewares/reservationsInput';
import { BATCH_ADMIN_ROLES } from '../utils/facilityRoles';
import { writeAudit, ctxFromReq } from '../utils/auditWrite';
import { UUID_RE } from '../utils/reservations.shared';
import {
    BatchEnvelopeSchema, BatchRowSchema, planBatch, type BatchRow, type RowAvailability,
} from '../utils/reservations.batch';

const router = Router();

/** Tope por actor: 20 dry-runs por hora (clave = usuario; el limitador va DESPUÉS de requireAuth). */
export const batchLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.RESERVATIONS_BATCH_MAX_PER_HOUR ?? 20),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `rsv-batch-${(req as Request).user?.id ?? 'anon'}`,
    validate: { keyGeneratorIpFallback: false } as any,
    message: { error: 'Demasiados lotes en la última hora. Intenta más tarde.', code: 'RATE_LIMITED' },
});

const requireBatchAdmin = requireRole(...BATCH_ADMIN_ROLES);
const MAX_AVAILABILITY_LOOKUPS = 40;
const bogotaDate = (iso: string) => new Date(Date.parse(iso) - 5 * 3600_000).toISOString().slice(0, 10);

router.post('/dry-run', requireAuth, requireBatchAdmin, batchLimiter, async (req: Request, res: Response) => {
    try {
        const env = BatchEnvelopeSchema.safeParse(req.body);
        if (!env.success) return zodBadRequest(res, env.error.issues);
        const { school_id, source_kind, source_id, rows } = env.data;

        // El lote opera sobre UNA escuela y el actor debe ser administrador de ESA escuela.
        if (req.role !== 'super_admin' && req.schoolId !== school_id) {
            return res.status(403).json({ error: 'No administras esa escuela.', code: 'FORBIDDEN' });
        }

        // Filas ya válidas por esquema (las inválidas se reportan en planBatch).
        const parsed: Array<BatchRow | null> = rows.map((r) => {
            const p = BatchRowSchema.safeParse(r);
            return p.success ? p.data : null;
        });

        // Canchas de la escuela (una sola consulta).
        const ids = [...new Set(parsed.filter((r): r is BatchRow => !!r).map((r) => r.facility_id.toLowerCase()))].filter((i) => UUID_RE.test(i));
        const facState = new Map<string, 'ok' | 'not_bookable'>();
        if (ids.length) {
            const { data, error } = await supabase
                .from('facilities').select('id, status, booking_enabled').eq('school_id', school_id).in('id', ids);
            if (error) throw error;
            for (const f of (data as any[] | null) ?? []) {
                facState.set(String(f.id).toLowerCase(), f.status === 'available' && f.booking_enabled !== false ? 'ok' : 'not_bookable');
            }
        }

        // Disponibilidad real: disponibilidad_canchas por (cancha, día local, duración).
        const groups = new Map<string, { facility_id: string; date: string; dur: number }>();
        parsed.forEach((r) => {
            if (!r || facState.get(r.facility_id.toLowerCase()) !== 'ok') return;
            const dur = Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000);
            if (dur < 5 || dur > 480) return;
            const date = bogotaDate(r.starts_at);
            groups.set(`${r.facility_id.toLowerCase()}|${date}|${dur}`, { facility_id: r.facility_id, date, dur });
        });
        const free = new Set<string>();
        const checked = new Set<string>();
        const list = [...groups.entries()].slice(0, MAX_AVAILABILITY_LOOKUPS);
        for (let i = 0; i < list.length; i += 5) {
            await Promise.all(list.slice(i, i + 5).map(async ([key, g]) => {
                const { data, error } = await supabase.rpc('disponibilidad_canchas', {
                    p_school_id: school_id, p_from: g.date, p_to: g.date, p_facility_id: g.facility_id,
                    p_duration_min: g.dur, p_actor_profile_id: req.user.id,
                });
                if (error || !data || (data as any).ok === false) return; // queda 'unchecked'
                checked.add(key);
                for (const f of (data as any).facilities ?? []) {
                    for (const d of f.days ?? []) {
                        for (const s of d.slots ?? []) {
                            free.add(`${String(f.facility_id).toLowerCase()}|${Date.parse(s.starts_at)}|${Date.parse(s.ends_at)}`);
                        }
                    }
                }
            }));
        }

        const plan = planBatch(req.body, {
            facilityState: (id) => facState.get(id.toLowerCase()) ?? 'not_found',
            availability: (r): RowAvailability => {
                const dur = Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000);
                const gk = `${r.facility_id.toLowerCase()}|${bogotaDate(r.starts_at)}|${dur}`;
                if (!checked.has(gk)) return 'unchecked';
                return free.has(`${r.facility_id.toLowerCase()}|${Date.parse(r.starts_at)}|${Date.parse(r.ends_at)}`) ? 'free' : 'taken';
            },
        });

        await writeAudit({ ...ctxFromReq(req), schoolId: school_id }, 'reservation_batch_dry_run', 'facility_reservations', `${source_kind}:${source_id}`,
            null, { total: plan.total, ok_rows: plan.ok_rows, warning_rows: plan.warning_rows, error_rows: plan.error_rows, apply_allowed: plan.apply_allowed },
            { metadata: { source_ref: `${source_kind}:${source_id}` } });

        return res.status(200).json({
            dry_run: true,
            writes_performed: false,
            ...plan,
            // Aplicar el lote aún no existe: requerirá confirmación humana explícita (ver cabecera).
            apply: { available: false, reason: 'not_implemented_requires_human_confirmation' },
        });
    } catch (err: any) {
        req.log?.error({ err }, 'reservations batch dry-run error');
        return res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

export default router;
