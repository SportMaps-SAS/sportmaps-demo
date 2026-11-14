// Piezas reutilizables y PURAS para reservas por lote / agente de IA / importador de documentos.
// Contrato obligatorio: docs/specs/reservas-agentes-ia-contrato-seguro.md
//
//  · deriveIdempotencyKey(sourceKind, sourceId, rowIndex) — llave determinista por fila.
//  · ReservationBatchSchema — esquema zod ESTRICTO del lote (máx. 200 filas).
//  · planBatch() — DRY-RUN: valida y reporta por fila SIN tocar la base (la disponibilidad real la
//    inyecta quien llama; esta función no hace I/O).
//
// Un documento / JSON / salida de un LLM es DATO, nunca instrucción: aquí solo se valida contra el
// esquema; ningún texto del lote se interpreta ni se ejecuta.
import { createHash } from 'crypto';
import { z } from 'zod';
import {
    LIMITS, uuid, isoZoned, freeText, personName, phoneField, emailField,
    MAX_RESERVATION_MS,
} from './reservations.schemas';

export const BATCH_MAX_ROWS = LIMITS.batchRows; // 200
export const BATCH_SOURCE_KINDS = ['ai', 'import', 'csv', 'json', 'pdf', 'excel', 'bot'] as const;
export type BatchSourceKind = (typeof BATCH_SOURCE_KINDS)[number];

/** Canal que se pasa a reservar_cancha: SOLO lo fija el BFF desde el camino de lotes. */
export function channelForSourceKind(kind: BatchSourceKind): 'ai' | 'import' {
    return kind === 'ai' || kind === 'bot' ? 'ai' : 'import';
}

const SOURCE_ID_RE = /^[A-Za-z0-9._:\-]{1,120}$/;

/**
 * Idempotency-Key = hash(sourceKind + sourceId + índice de fila), con forma de UUID para pasar el
 * validador de requireIdempotencyKey. Mismo documento + misma fila => misma llave (reintento seguro);
 * otro documento o fila distinta => llave distinta.
 */
export function deriveIdempotencyKey(sourceKind: string, sourceId: string, rowIndex: number): string {
    if (!(BATCH_SOURCE_KINDS as readonly string[]).includes(sourceKind)) throw new Error('sourceKind inválido');
    if (!SOURCE_ID_RE.test(String(sourceId))) throw new Error('sourceId inválido');
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= BATCH_MAX_ROWS) throw new Error('rowIndex fuera de rango');
    const h = createHash('sha256').update(`rsv-batch|${sourceKind}|${sourceId}|${rowIndex}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Trazabilidad del origen: va a reservar_cancha(p_source_ref) y a auditLog. */
export function sourceRefFor(sourceKind: string, sourceId: string, rowIndex: number): string {
    return `${sourceKind}:${sourceId}#${rowIndex}`;
}

// ── Esquema ──────────────────────────────────────────────────────────────────

/**
 * Fila = los campos de reservar_cancha que un lote puede fijar. NO existe amount_paid ni channel:
 * el dinero no se mueve por IA y el canal lo pone el BFF. Cualquier clave extra => error de esquema.
 */
export const BatchRowSchema = z.strictObject({
    row_ref: z.string().max(60).regex(/^[A-Za-z0-9._:\- ]*$/, 'row_ref inválido').optional(),
    facility_id: uuid('facility_id'),
    starts_at: isoZoned,
    ends_at: isoZoned,
    payment_method: z.enum(['online', 'transfer', 'cash', 'none']).default('none'),
    booker_profile_id: uuid('booker_profile_id').optional(),
    guest: z.strictObject({ phone: phoneField, full_name: personName, email: emailField.optional() }).optional(),
    rate_audience: z.enum(['public', 'member']).optional(),
    participants: z.number().int().min(1).max(LIMITS.participantsMax).optional(),
    notes: freeText(LIMITS.notes, { keepNewlines: true }).optional(),
    external_org_name: freeText(LIMITS.externalOrg).optional(),
}).superRefine((b, ctx) => {
    const s = Date.parse(b.starts_at); const e = Date.parse(b.ends_at);
    if (!(e > s)) ctx.addIssue({ code: 'custom', message: 'ends_at debe ser posterior a starts_at', path: ['ends_at'] });
    else if (e - s > MAX_RESERVATION_MS) ctx.addIssue({ code: 'custom', message: 'la duración supera las 24 horas', path: ['ends_at'] });
    if (!b.booker_profile_id && !b.guest) ctx.addIssue({ code: 'custom', message: 'indica booker_profile_id o guest', path: ['booker_profile_id'] });
    if (b.booker_profile_id && b.guest) ctx.addIssue({ code: 'custom', message: 'booker_profile_id y guest son excluyentes', path: ['guest'] });
});
export type BatchRow = z.infer<typeof BatchRowSchema>;

const EnvelopeShape = {
    source_kind: z.enum(BATCH_SOURCE_KINDS),
    source_id: z.string().regex(SOURCE_ID_RE, 'source_id inválido'),
    school_id: uuid('school_id'),
};

/** Lote completo: todo o nada a nivel de esquema (una fila inválida invalida el lote). */
export const ReservationBatchSchema = z.strictObject({
    ...EnvelopeShape,
    rows: z.array(BatchRowSchema).min(1).max(BATCH_MAX_ROWS),
});
export type ReservationBatch = z.infer<typeof ReservationBatchSchema>;

/** Envoltorio con filas sin validar: permite reportar fila por fila en el dry-run. */
export const BatchEnvelopeSchema = z.strictObject({
    ...EnvelopeShape,
    rows: z.array(z.unknown()).min(1).max(BATCH_MAX_ROWS),
});

// ── Planificador (dry-run) ───────────────────────────────────────────────────

export type RowAvailability = 'free' | 'taken' | 'unchecked';

export interface PlanRowIssue { code: string; message: string; path?: string }
export interface PlanRow {
    index: number;
    row_ref: string | null;
    status: 'ok' | 'warning' | 'error';
    idempotency_key: string | null;
    source_ref: string;
    channel: 'ai' | 'import';
    issues: PlanRowIssue[];
}
export interface BatchPlan {
    ok: boolean;               // el envoltorio es válido
    apply_allowed: boolean;    // todo-o-nada: true solo si NINGUNA fila tiene error
    total: number;
    ok_rows: number;
    warning_rows: number;
    error_rows: number;
    rows: PlanRow[];
    envelope_issues: PlanRowIssue[];
}

export interface PlanOptions {
    now?: number;
    /** Oráculo de disponibilidad inyectado (I/O afuera). Sin él, las filas quedan 'unchecked' (warning). */
    availability?: (row: BatchRow, index: number) => RowAvailability;
    /** Estado de cada cancha DENTRO de la escuela del lote (null = no verificado). */
    facilityState?: (facilityId: string) => 'ok' | 'not_found' | 'not_bookable';
}

const fmtIssues = (issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): PlanRowIssue[] =>
    issues.slice(0, 8).map((i) => ({ code: 'SCHEMA', message: String(i.message).slice(0, 200), path: i.path.map(String).join('.') }));

/** DRY-RUN puro: no toca la base ni la red. Nunca lanza por entrada mala. */
export function planBatch(input: unknown, opts: PlanOptions = {}): BatchPlan {
    const now = opts.now ?? Date.now();
    const env = BatchEnvelopeSchema.safeParse(input);
    if (!env.success) {
        return {
            ok: false, apply_allowed: false, total: 0, ok_rows: 0, warning_rows: 0, error_rows: 0, rows: [],
            envelope_issues: fmtIssues(env.error.issues),
        };
    }
    const { source_kind, source_id, rows } = env.data;
    const channel = channelForSourceKind(source_kind);

    const planRows: PlanRow[] = rows.map((raw, index) => {
        const base: PlanRow = {
            index, row_ref: null, status: 'ok', channel,
            idempotency_key: deriveIdempotencyKey(source_kind, source_id, index),
            source_ref: sourceRefFor(source_kind, source_id, index),
            issues: [],
        };
        const p = BatchRowSchema.safeParse(raw);
        if (!p.success) return { ...base, status: 'error', issues: fmtIssues(p.error.issues) };
        const r = p.data;
        base.row_ref = r.row_ref ?? null;
        if (Date.parse(r.starts_at) <= now) base.issues.push({ code: 'IN_THE_PAST', message: 'La franja ya empezó o está en el pasado.' });
        return { ...base, _row: r } as PlanRow & { _row: BatchRow };
    });

    // Choques DENTRO del lote (misma cancha, rangos que se cruzan) y llaves repetidas.
    const valid = planRows.filter((r: any) => r._row) as Array<PlanRow & { _row: BatchRow }>;
    for (let i = 0; i < valid.length; i++) {
        for (let j = i + 1; j < valid.length; j++) {
            const a = valid[i]._row; const b = valid[j]._row;
            if (a.facility_id.toLowerCase() !== b.facility_id.toLowerCase()) continue;
            if (Date.parse(a.starts_at) < Date.parse(b.ends_at) && Date.parse(b.starts_at) < Date.parse(a.ends_at)) {
                valid[j].issues.push({ code: 'BATCH_INTERNAL_OVERLAP', message: `Se cruza con la fila ${valid[i].index} del mismo lote.` });
            }
        }
    }

    // Disponibilidad real (inyectada).
    for (const pr of valid) {
        const fs = opts.facilityState ? opts.facilityState(pr._row.facility_id) : 'ok';
        if (fs === 'not_found') { pr.issues.push({ code: 'FACILITY_NOT_FOUND', message: 'La cancha no existe en esta escuela.' }); continue; }
        if (fs === 'not_bookable') { pr.issues.push({ code: 'FACILITY_NOT_BOOKABLE', message: 'La cancha no recibe reservas por ahora.' }); continue; }
        const av = opts.availability ? opts.availability(pr._row, pr.index) : 'unchecked';
        if (av === 'taken') pr.issues.push({ code: 'SLOT_UNAVAILABLE', message: 'La franja no está disponible (ocupada, bloqueada o fuera de horario/grilla).' });
        else if (av === 'unchecked') pr.issues.push({ code: 'AVAILABILITY_NOT_CHECKED', message: 'No se pudo verificar la disponibilidad de esta fila.' });
    }

    const out: PlanRow[] = planRows.map((r: any) => {
        const { _row, ...clean } = r;
        const hardErr = clean.issues.some((i: PlanRowIssue) => i.code !== 'AVAILABILITY_NOT_CHECKED');
        const status: PlanRow['status'] = hardErr ? 'error' : clean.issues.length ? 'warning' : clean.status;
        return { ...clean, status: clean.status === 'error' ? 'error' : status };
    });
    const count = (s: PlanRow['status']) => out.filter((r) => r.status === s).length;
    return {
        ok: true,
        apply_allowed: count('error') === 0 && count('warning') === 0,
        total: out.length,
        ok_rows: count('ok'), warning_rows: count('warning'), error_rows: count('error'),
        rows: out, envelope_issues: [],
    };
}
