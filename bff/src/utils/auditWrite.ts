// Escritura de auditoría que NUNCA falla en silencio.
//
// Contexto: supabase-js NO lanza si el insert falla: devuelve { error }. El auditLog anterior solo
// tenía try/catch, así que cuando security_audit_log no existía (producción) o el insert fallaba,
// no quedaba ni un log. Ahora:
//  - si el insert falla se registra a nivel ERROR con acción, escuela, tabla/id y código de error;
//  - las acciones CRÍTICAS (reservas: borrado físico, aprobar, completar, cancelar/reprogramar
//    por staff, confirmación de pago, conciliación, lotes) llevan el prefijo AUDIT_WRITE_FAILED y
//    suben un contador visible (getAuditFailureStats) para alertar en el agregador de logs;
//  - jamás lanza: el negocio no cae por la auditoría.
import type { Request } from 'express';
import { supabase } from '../config/supabase';

export interface AuditCtx {
    userId?: string | null;
    ip?: string | string[] | null;
    userAgent?: string | null;
    schoolId?: string | null;
    role?: string | null;
    requestId?: string | null;
    log?: { error: (o: any, m?: string) => void } | null;
}

export interface AuditOptions {
    /** Acción crítica: si falla, AUDIT_WRITE_FAILED + contador. */
    critical?: boolean;
    /** Metadatos extra (p. ej. source_ref de un lote/IA). */
    metadata?: Record<string, unknown>;
}

/** Acciones de reservas que siempre se consideran críticas. */
export const CRITICAL_AUDIT_ACTIONS = new Set<string>([
    'facility_reservation_delete',
    'facility_reservation_approve',
    'facility_reservation_complete',
    'facility_reservation_cancel_staff',
    'facility_reservation_reschedule_staff',
    'reservation_payment_confirmed',
    'reservation_transfer_confirmed',
    'reservation_reconciliation',
    'reservation_batch_row',
    'reservation_batch_dry_run',
    'facility_blackout_create',
    'facility_blackout_delete',
    'facility_reservation_book_secondary',
    'facility_reservation_cancel_secondary',
]);

// ── Normalización previa al insert (la tabla espera ip_address como una sola IP, action corto, metadata acotada) ──
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:.]+$/i;

/** UNA sola IP válida (primer elemento de x-forwarded-for, sin puerto) o null. Nunca una lista. */
export function normalizeIp(raw: unknown): string | null {
    const first = (Array.isArray(raw) ? raw[0] : String(raw ?? '')).split(',')[0].trim().slice(0, 64);
    if (!first) return null;
    let ip = first.replace(/^::ffff:/i, '');
    if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
    if (IPV4_RE.test(ip)) return ip.split('.').every((o: string) => Number(o) <= 255) ? ip : null;
    if (ip.includes(':') && IPV6_RE.test(ip)) return ip;
    return null;
}

export const AUDIT_ACTION_RE = /^[a-z0-9_:.-]{1,120}$/;
export function normalizeAction(action: string): string {
    const a = String(action ?? '').toLowerCase().replace(/[^a-z0-9_:.-]/g, '_').slice(0, 120);
    return a || 'unknown';
}

export const AUDIT_METADATA_MAX_BYTES = 8 * 1024;
/** Si el JSON excede ~8 KB guarda solo un resumen (claves de primer nivel y tamaño). */
export function boundJson(v: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!v) return null;
    let s: string;
    try { s = JSON.stringify(v); } catch { return { truncated: true, reason: 'not_serializable' }; }
    if (s.length <= AUDIT_METADATA_MAX_BYTES) return v;
    return { truncated: true, original_bytes: s.length, keys: Object.keys(v).slice(0, 30) };
}

const stats = { failures: 0, criticalFailures: 0, lastFailureAt: null as string | null };
export function getAuditFailureStats() { return { ...stats }; }
export function resetAuditFailureStats() { stats.failures = 0; stats.criticalFailures = 0; stats.lastFailureAt = null; }

export function ctxFromReq(req: Request): AuditCtx {
    return {
        userId: req.user?.id ?? null,
        ip: req.ip || (req.headers?.['x-forwarded-for'] as string | undefined) || null,
        userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
        schoolId: req.schoolId ?? null,
        role: req.role ?? null,
        requestId: (req as any).id ?? null,
        log: (req as any).log ?? null,
    };
}

function report(ctx: AuditCtx, critical: boolean, info: Record<string, unknown>) {
    stats.failures += 1;
    if (critical) stats.criticalFailures += 1;
    stats.lastFailureAt = new Date().toISOString();
    const payload = { ...info, critical, audit_failures_total: stats.failures, audit_failures_critical: stats.criticalFailures };
    const msg = critical ? 'AUDIT_WRITE_FAILED acción crítica sin rastro en security_audit_log' : 'Audit log write failed';
    if (ctx.log?.error) ctx.log.error(payload, msg);
    else console.error(`${critical ? 'AUDIT_WRITE_FAILED' : 'AUDIT_WRITE_WARN'} ${JSON.stringify(payload)}`);
}

/** Devuelve true si quedó escrito. Nunca lanza. */
export async function writeAudit(
    ctx: AuditCtx,
    action: string,
    targetTable: string,
    targetId: string,
    oldValue?: Record<string, unknown> | null,
    newValue?: Record<string, unknown> | null,
    opts: AuditOptions = {},
): Promise<boolean> {
    const critical = opts.critical ?? CRITICAL_AUDIT_ACTIONS.has(action);
    const info = { action, targetTable, targetId, schoolId: ctx.schoolId ?? null, actor: ctx.userId ?? null };
    try {
        const res: any = await supabase.from('security_audit_log').insert({
            user_id: ctx.userId || null,
            action: normalizeAction(action),
            target_table: String(targetTable).slice(0, 120),
            target_id: String(targetId).slice(0, 200),
            old_value: boundJson(oldValue),
            new_value: boundJson(newValue),
            ip_address: normalizeIp(ctx.ip),
            user_agent: ctx.userAgent ? String(ctx.userAgent).slice(0, 300) : null,
            metadata: boundJson({
                school_id: ctx.schoolId || null,
                role: ctx.role || null,
                request_id: ctx.requestId || null,
                ...(opts.metadata ?? {}),
            }),
        });
        const err = res?.error;
        if (err) {
            report(ctx, critical, { ...info, errCode: err.code ?? null, errMessage: String(err.message ?? err).slice(0, 300) });
            return false;
        }
        return true;
    } catch (e: any) {
        report(ctx, critical, { ...info, errCode: e?.code ?? 'THROWN', errMessage: String(e?.message ?? e).slice(0, 300) });
        return false;
    }
}
