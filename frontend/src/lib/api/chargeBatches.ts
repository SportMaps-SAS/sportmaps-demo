/**
 * «Cobros y pagos» — cliente del BFF (spec docs/specs/cobros-multiples.md §9, F3).
 *
 * Rutas (F2, todavía sin desplegar al escribir esto — el modal vive detrás de
 * `isCobrosYPagosEnabled()`):
 *   POST /api/v1/charge-batches/preview            vista previa (no escribe)
 *   POST /api/v1/charge-batches                    crear / pagar / descontar (única escritura)
 *   GET  /api/v1/charge-batches?cursor=            historial («Operaciones»)
 *   GET  /api/v1/charge-batches/:id                detalle con filas
 *   POST /api/v1/charge-batches/:id/annul          anular lo anulable
 *   GET  /api/v1/charge-batches/targets            atletas de un equipo/categoría/plan
 *   GET  /api/v1/charge-batches/athlete-search     buscador + duplicados (§16)
 *   GET  /api/v1/athletes/:type/:id/charge-suggestions
 *   GET  /api/v1/athletes/:type/:id/open-charges
 *   POST /api/v1/payment-adjustments/:id/revert    «Quitar descuento»
 *   GET  /api/v1/payment-adjustments               informe de descuentos
 *
 * El BFF NO calcula montos por su cuenta: la RPC (`_plan_charge_operation`)
 * calcula preview y create con la misma función. Lo que el modal muestra antes
 * de la vista previa es una estimación local (lib/cobrosYPagos.ts); lo que se
 * confirma es lo que devolvió la vista previa (preview_hash).
 *
 * Contrato: los tipos de abajo son los que usa el modal. Las respuestas REALES
 * del BFF de F2 (bff/src/services/charge-batches.service.ts, leído el
 * 2026-10-10) y de la RPC de F1 (`_plan_charge_operation`, migración
 * 20261010144559) tienen otros nombres (`items`/`saldo`/`discount_tags`/
 * `has_guardian`/`next_free_period`…): las funciones `normalize*` de este
 * archivo los traducen, y aceptan también la forma del spec §9. Si cambia un
 * nombre, este es el único archivo que hay que tocar.
 */

import { bffClient, BFFError } from './bffClient';
import type { PaymentChargeCategory } from '@/lib/payment-accounts';

const BASE = '/api/v1/charge-batches';

// ── Tipos del cuerpo (zod de §9.2) ────────────────────────────────────────────

export type AthleteType = 'child' | 'adult' | 'unregistered';
export type DiscountBasis = 'porcentaje' | 'valor';
/** Catálogo de motivos del modal (CHECK de payment_adjustments.reason_code sin los del sistema). */
export type ReasonCode =
    | 'pronto_pago'
    | 'varios_meses'
    | 'hermanos'
    | 'beca'
    | 'convenio'
    | 'cortesia'
    | 'ajuste_de_precio'
    | 'error_de_cobro'
    | 'condonacion_mora'
    | 'otro';

export interface DiscountPayload {
    basis: DiscountBasis;
    value: number;
    reason_code: ReasonCode;
    reason_text?: string;
}

export interface AthleteRef {
    type: AthleteType;
    id: string;
}

export interface ChargeLinePayload {
    category: PaymentChargeCategory;
    /** Ausente en mensualidad de modo varios = el monto de cada atleta (D4). */
    amount?: number;
    due_date: string;
    concept: string;
    notes?: string;
    period?: { year: number; month: number };
    enrollment_id?: string;
    fee_id?: string;
    overage_charge_id?: string;
    /** Horas adicionales vendidas por adelantado (múltiplos de 0,25). Va con `enrollment_id`. */
    extra_hours?: number;
    discount?: DiscountPayload;
    exonerate?: { reason_text: string };
    /**
     * Supuesto de contrato: §7.3 paso 9d dice «cada línea con pay_amount > 0»
     * pero el zod de §9.2 solo lo declara en PendienteSel. Se manda también en
     * las líneas nuevas (0 = solo generar). Solo modo un atleta.
     */
    pay_amount?: number;
}

export interface PendingSelectionPayload {
    payment_id: string;
    seen: { amount: number; amount_paid: number };
    discount?: DiscountPayload;
    waive_late_fee?: { value?: number; reason_text?: string };
    exonerate?: { reason_text: string };
    pay_amount: number;
    close_mode: 'cerrar' | 'abono';
}

export interface GlobalDiscountPayload extends DiscountPayload {
    /** 'new:<idx>' | 'pending:<uuid>' */
    line_refs: string[];
}

export interface PaymentPayload {
    method: 'cash' | 'transfer';
    payment_date: string;
    reference?: string;
    receipt_url?: string;
    receipt_sha256?: string;
    ocr?: Record<string, unknown>;
    /** Pide factura electrónica del pago (hoy el modal viejo la dispara al quedar paid). */
    wants_e_invoice?: boolean;
}

export interface NewAthletePayload {
    kind: 'menor' | 'adulto';
    full_name: string;
    doc_type?: string;
    doc_number?: string;
    guardian_name?: string;
    guardian_phone: string;
    date_of_birth?: string;
    allow_duplicate: boolean;
}

export type TargetKind = 'athlete' | 'team' | 'category' | 'plan' | 'list';

export interface ChargeBatchRequest {
    mode: 'single' | 'multi';
    target: { kind: TargetKind; ids: string[] };
    athletes: AthleteRef[];
    lines: ChargeLinePayload[];
    pending?: PendingSelectionPayload[];
    global_discount?: GlobalDiscountPayload;
    payment?: PaymentPayload;
    new_athlete?: NewAthletePayload;
}

export interface ChargeOverride {
    athlete: string;
    line_idx: number;
    action: 'force' | 'skip';
}

export interface ChargeBatchCreateRequest extends ChargeBatchRequest {
    client_request_id: string;
    preview_hash: string;
    overrides?: ChargeOverride[];
    notify_families?: boolean;
    /** El usuario vio que el mismo cobro ya se registró hace poco y confirma que es otro. */
    confirmar_duplicado?: boolean;
}

/** Un lote idéntico registrado hace pocos minutos (aviso del preview y detalle del 409 COBRO_DUPLICADO_RECIENTE). */
export interface CobroRecienteAviso {
    batch_id: string;
    created_at: string;
    minutes_ago: number;
    created_by_name: string | null;
    total_amount: number | null;
}

// ── Tipos de respuesta ────────────────────────────────────────────────────────

/** Un descuento/ajuste con su origen (D16). Orden = `sequence`. */
export interface AdjustmentTag {
    id?: string;
    origin: 'militar' | 'hermanos' | 'alta_solo_este_mes' | 'pronto_pago' | 'modal' | string;
    kind?: 'descuento' | 'condonacion_recargo' | 'exoneracion' | 'reversion' | string;
    reason_code?: string | null;
    basis?: DiscountBasis | null;
    pct?: number | null;
    amount: number;
    sequence?: number;
    scope?: 'linea' | 'general';
    /** Rótulo ya armado por el BFF («Hermanos −10 %»); si falta, lo arma el modal. */
    label?: string;
    reverted?: boolean;
}

export type SkipReason =
    | 'mensualidad_ya_existe'
    | 'seguro_en_12_meses'
    | 'excedente_ya_facturado'
    | 'misma_linea_hoy'
    | 'fee_unica_vez'
    | 'sin_inscripcion_para_mensualidad'
    | 'exonerado'
    | string;

export interface PreviewSkipped {
    athlete: { type?: AthleteType; id: string; name?: string } | string;
    line_idx: number;
    reason: SkipReason;
    /** seguro_en_12_meses / misma_linea_hoy se pueden forzar (§7.3 paso 5). */
    overridable?: boolean;
    detail?: string;
}

export interface PreviewAthlete {
    type: AthleteType;
    id: string;
    name: string;
    payer_linked?: boolean;
    enrollment_label?: string | null;
    suggested_monthly?: number | null;
    autopay?: boolean;
    warnings?: string[];
}

export interface PreviewLine {
    /** 'new:<idx>' | 'pending:<uuid>' (en modo varios, por atleta: 'new:<idx>:<athleteId>') */
    ref: string;
    amount_before: number;
    adjustments?: AdjustmentTag[];
    amount_after: number;
    pay_amount?: number;
    resulting_status?: 'pending' | 'paid' | 'partial' | 'cancelled';
    tags?: AdjustmentTag[];
    warnings?: string[];
}

export interface AthleteDuplicate {
    table_name: 'children' | 'unregistered_athletes' | 'profiles' | string;
    id: string;
    full_name: string;
    doc_masked?: string | null;
    guardian?: string | null;
    team_name?: string | null;
    matched_by: string[] | string;
    athlete_type?: AthleteType;
}

export interface ChargeBatchPreview {
    preview_hash: string;
    rows_to_create: number;
    total_amount: number;
    to_create?: { n: number; total: number };
    to_pay?: { n: number; total: number };
    discounts?: { total: number; by_reason?: Record<string, number> };
    late_fee_waived?: number;
    exonerated?: number;
    by_category?: Record<string, { n: number; total: number }>;
    list_total?: number;
    skipped?: PreviewSkipped[];
    athletes?: PreviewAthlete[];
    warnings_count?: Record<string, number>;
    lines?: PreviewLine[];
    duplicates?: AthleteDuplicate[];
    /** Otra pantalla registró lo mismo hace pocos minutos (aviso, no bloqueo). */
    recent_duplicates?: CobroRecienteAviso[];
    errors?: { ref?: string; code: string; message?: string }[];
}

/** Resultado de sumar las horas vendidas al banco (solo si la operación llevaba una venta de horas). */
export interface HourBankGrantResult {
    ok: boolean;
    minutes?: number;
    hours?: number;
    available_minutes?: number;
    duplicated?: boolean;
    /** sin_cobro: no se creó el cobro. sin_pago: quedó pendiente. error: falló la suma. */
    reason?: 'sin_cobro' | 'sin_pago' | 'error';
    message?: string;
}

export interface ChargeBatchResult {
    batch_id: string;
    duplicated: boolean;
    hour_bank_grant?: HourBankGrantResult;
    rows_created: number;
    total_amount: number;
    payment_ids?: string[];
    paid_ids?: string[];
    partial_ids?: string[];
    adjustments?: AdjustmentTag[];
    skipped?: PreviewSkipped[];
    payments_registered?: number;
    paid_total?: number;
    discount_total?: number;
    late_fee_waived_total?: number;
    new_athlete?: { type: AthleteType; id: string } | null;
}

export type BatchStatus = 'created' | 'partially_annulled' | 'annulled';

export interface ChargeBatchSummary {
    id: string;
    created_at: string;
    created_by?: { id: string; name: string | null } | null;
    created_by_name?: string | null;
    mode: 'single' | 'multi';
    target: { kind: TargetKind; ids: string[]; label?: string | null };
    target_label?: string | null;
    rows_created: number;
    rows_skipped?: number;
    total_amount: number;
    payments_registered: number;
    paid_total: number;
    discount_total: number;
    late_fee_waived_total: number;
    status: BatchStatus;
    annul_reason?: string | null;
}

export interface ChargeBatchRow {
    payment_id: string;
    athlete_name: string;
    concept: string;
    payment_category: string | null;
    amount: number;
    list_amount?: number | null;
    amount_paid?: number | null;
    status: string;
    adjustments?: AdjustmentTag[];
}

export interface ChargeBatchDetail extends ChargeBatchSummary {
    rows: ChargeBatchRow[];
    skipped?: PreviewSkipped[];
    /** Conteo exacto para «Anular lote» (Q12), si el BFF lo calcula. */
    annul_preview?: { annullable_count: number; annullable_total: number; kept_count: number } | null;
}

export interface ChargeBatchPage {
    items: ChargeBatchSummary[];
    next_cursor: string | null;
}

export interface TargetAthlete {
    type: AthleteType;
    id: string;
    name: string;
    team_name?: string | null;
    plan_name?: string | null;
    paused?: boolean;
    payer_linked?: boolean;
}

export interface EnrollmentOption {
    enrollment_id: string;
    offering_plan_id: string | null;
    plan_name: string | null;
    team_name: string | null;
    is_primary?: boolean;
    monthly_amount: number | null;
    active?: boolean;
    /** El plan lleva banco de horas (se pueden vender horas adicionales). */
    hours_plan?: boolean;
    /** Precio del plan ÷ horas incluidas: la misma tarifa del cobro de excedentes. */
    hourly_rate?: number | null;
    included_minutes?: number | null;
    /** Saldo del banco en el periodo vigente (incluidos − consumidos − reservados); null si no hay periodo. */
    available_minutes?: number | null;
}

export interface ChargeSuggestions {
    enrollments: EnrollmentOption[];
    suggested_monthly?: {
        amount: number;
        source?: 'monthly_fee' | 'plan' | 'team' | string;
        sibling_discount_pct?: number | null;
        sibling_discount_amount?: number | null;
    } | null;
    next_period?: { year: number; month: number } | null;
    overages?: { id: string; period_label: string; amount: number }[];
    plan_fees?: { id: string; category: PaymentChargeCategory; name: string; amount: number; will_charge?: boolean }[];
    payer_linked?: boolean;
    payer_name?: string | null;
}

/** Cobro abierto del atleta (sección «Cobros pendientes»). */
export interface OpenCharge {
    id: string;
    concept: string;
    payment_category: string | null;
    payment_type?: string | null;
    status: 'pending' | 'overdue' | 'partial' | 'rejected' | 'failed' | 'awaiting_approval' | string;
    due_date: string | null;
    period_year?: number | null;
    period_month?: number | null;
    created_at?: string | null;
    amount: number;
    list_amount: number | null;
    discount_amount: number;
    late_fee_amount: number;
    late_fee_waived_amount?: number;
    amount_paid: number;
    early_payment_discount_applied: number | null;
    sibling_discount_applied?: number | null;
    /** Saldo = amount − amount_paid − early_payment_discount_applied (lo calcula el BFF). */
    balance?: number;
    en_revision: boolean;
    pago_en_curso: boolean;
    pago_en_curso_amount?: number | null;
    requires_review?: boolean;
    last_failure_at?: string | null;
    /** Descuentos que ya trae, en orden (militar, hermanos, solo este mes, pronto pago…). */
    adjustments?: AdjustmentTag[];
    suggestions?: {
        pronto_pago?: { pct: number; valid_until: string | null } | null;
    } | null;
    warnings?: string[];
}

export interface OpenChargesResponse {
    charges: OpenCharge[];
    suggestions?: { varios_meses?: { min_months: number } | null } | null;
}

export interface AthleteSearchResult {
    matches: AthleteDuplicate[];
}

export interface PaymentAdjustmentReportRow {
    id: string;
    created_at: string;
    athlete_name: string;
    concept: string;
    kind: string;
    origin: string;
    reason_code: string;
    reason_text?: string | null;
    amount: number;
    created_by_name?: string | null;
    label?: string;
    reverted?: boolean;
    payment_id?: string;
    charge_batch_id?: string | null;
    payment_status?: string | null;
    basis?: DiscountBasis | null;
    pct?: number | null;
}

// ── Errores ───────────────────────────────────────────────────────────────────

/** Códigos que devuelve el BFF (§9.4, F2) traducidos desde los RAISE de la RPC. */
export type ChargeBatchErrorCode =
    | 'PREVIEW_STALE'
    | 'COBRO_CAMBIO'
    | 'EN_REVISION'
    | 'PAGO_EN_CURSO'
    | 'COBRO_CERRADO'
    | 'DESCUENTO_EXCEDE'
    | 'ATLETA_DUPLICADO'
    | 'SOBREPAGO'
    | 'MULTI_NO_PAGA'
    | 'EXONERACION_CON_PAGO'
    | 'ANNUL_STALE'
    | 'PERIODO_DUPLICADO'
    | 'YA_REVERTIDO'
    | 'LOTE_ANULADO'
    | 'EXCEDENTE_YA_FACTURADO'
    | 'TOPE_EXCEDIDO'
    | 'ESCUELA_NO_OPERATIVA'
    | 'COBRO_DUPLICADO_RECIENTE'
    | 'RATE_LIMIT'
    | 'FORBIDDEN'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'NO_DISPONIBLE'
    | 'DESCONOCIDO';

export class ChargeBatchError extends Error {
    constructor(
        public code: ChargeBatchErrorCode,
        message: string,
        public status: number,
        public body?: unknown,
        /** `Retry-After` del 429, en segundos (si el BFF lo mandó). */
        public retryAfterSeconds?: number,
    ) {
        super(message);
        this.name = 'ChargeBatchError';
    }

    /** 409 que se resuelven recargando pendientes y vista previa sin perder lo escrito (§10.4). */
    get needsReload(): boolean {
        return ['PREVIEW_STALE', 'COBRO_CAMBIO', 'PAGO_EN_CURSO', 'EN_REVISION', 'ANNUL_STALE', 'PERIODO_DUPLICADO'].includes(this.code);
    }
}

const KNOWN_CODES: readonly ChargeBatchErrorCode[] = [
    'PREVIEW_STALE', 'COBRO_CAMBIO', 'EN_REVISION', 'PAGO_EN_CURSO', 'COBRO_CERRADO', 'DESCUENTO_EXCEDE',
    'ATLETA_DUPLICADO', 'SOBREPAGO', 'MULTI_NO_PAGA', 'EXONERACION_CON_PAGO', 'ANNUL_STALE', 'PERIODO_DUPLICADO',
    'YA_REVERTIDO', 'LOTE_ANULADO', 'EXCEDENTE_YA_FACTURADO', 'TOPE_EXCEDIDO', 'ESCUELA_NO_OPERATIVA',
    'COBRO_DUPLICADO_RECIENTE',
];

/** Códigos del BFF de F2 (charge-batches.service.ts / middlewares) que el modal agrupa. */
const CODE_SYNONYMS: Record<string, ChargeBatchErrorCode> = {
    VALIDACION: 'VALIDATION',
    SIN_PERMISO: 'FORBIDDEN',
    SOLO_DUENO_EXCEDENTE: 'FORBIDDEN',
    SOLO_OWNER_EXCEDENTE: 'FORBIDDEN',
    RATE_LIMITED: 'RATE_LIMIT',
    COBROS_NO_DISPONIBLE: 'NO_DISPONIBLE',
    ATLETA_AJENO: 'NOT_FOUND',
    DESTINO_AJENO: 'NOT_FOUND',
    COBRO_AJENO: 'NOT_FOUND',
    EXCEDENTE_AJENO: 'NOT_FOUND',
    LOTE_NO_ENCONTRADO: 'NOT_FOUND',
    AJUSTE_NO_ENCONTRADO: 'NOT_FOUND',
    MOTIVO_REQUERIDO: 'VALIDATION',
    DATOS_INVALIDOS: 'VALIDATION',
};

/** Mensaje en español por código, si el BFF no mandó uno. */
export const CHARGE_BATCH_ERROR_MESSAGE: Record<ChargeBatchErrorCode, string> = {
    PREVIEW_STALE: 'Algo cambió mientras revisabas (otro usuario o un pago en línea). Actualizamos la vista previa: revísala y confirma de nuevo.',
    COBRO_CAMBIO: 'Uno de los cobros marcados cambió de estado (se pagó o se anuló). Recargamos los pendientes.',
    EN_REVISION: 'Ese cobro tiene un comprobante en revisión: apruébalo o recházalo antes de registrar otro pago o descontar.',
    PAGO_EN_CURSO: 'La familia tiene un pago en línea en curso por ese cobro. Espera el resultado o anula el enlace antes de descontar.',
    COBRO_CERRADO: 'Ese cobro ya está cerrado (pagado, anulado o glosado).',
    DESCUENTO_EXCEDE: 'El descuento deja el cobro por debajo de lo ya pagado o toca el recargo. Para el recargo usa «Condonar recargo».',
    ATLETA_DUPLICADO: 'Ya existe un atleta con esos datos en la escuela.',
    SOBREPAGO: 'No se puede recibir más de lo que se debe.',
    MULTI_NO_PAGA: 'Con varios atletas solo se generan cobros. Para registrar pagos elige un solo atleta.',
    EXONERACION_CON_PAGO: 'Ese cobro ya tiene abonos: no se puede exonerar. Usa «Cerrar el cobro» con descuento.',
    ANNUL_STALE: 'La cantidad de cobros anulables cambió. Revisa el lote de nuevo.',
    PERIODO_DUPLICADO: 'Ese atleta ya tiene la mensualidad de ese mes.',
    YA_REVERTIDO: 'Ese descuento ya se quitó antes.',
    LOTE_ANULADO: 'Esa operación ya estaba anulada.',
    EXCEDENTE_YA_FACTURADO: 'Esas horas adicionales ya se facturaron o se descartaron.',
    TOPE_EXCEDIDO: 'El lote supera el máximo (200 atletas o 600 cobros). Divide por equipo o plan.',
    ESCUELA_NO_OPERATIVA: 'La escuela está inhabilitada: no se pueden registrar operaciones.',
    COBRO_DUPLICADO_RECIENTE: 'Este mismo cobro ya se registró hace pocos minutos. Si de verdad es otro, confirma para crearlo igual.',
    RATE_LIMIT: 'Demasiadas operaciones seguidas. Espera unos minutos e intenta de nuevo.',
    FORBIDDEN: 'Solo el dueño o la administración de la escuela pueden hacer esto.',
    VALIDATION: 'Revisa los datos marcados.',
    NOT_FOUND: 'No encontramos ese atleta u operación en la escuela.',
    NO_DISPONIBLE: '«Cobros y pagos» todavía no está disponible en este servidor.',
    DESCONOCIDO: 'No se pudo completar la operación. Intenta de nuevo.',
};

/** Convierte cualquier error del cliente HTTP en un ChargeBatchError con código. */
export function toChargeBatchError(err: unknown): ChargeBatchError {
    if (err instanceof ChargeBatchError) return err;
    if (err instanceof BFFError) {
        const body = (err.body ?? {}) as { code?: string; error?: string; message?: string };
        const raw = String(body.code ?? '').toUpperCase();
        let code: ChargeBatchErrorCode;
        if ((KNOWN_CODES as readonly string[]).includes(raw)) code = raw as ChargeBatchErrorCode;
        else if (CODE_SYNONYMS[raw]) code = CODE_SYNONYMS[raw];
        else if (err.status === 503) code = 'NO_DISPONIBLE';
        else if (err.status === 429) code = 'RATE_LIMIT';
        else if (err.status === 403 || err.status === 401) code = 'FORBIDDEN';
        else if (err.status === 404) code = body.code ? 'NOT_FOUND' : 'NO_DISPONIBLE';
        else if (err.status === 422 || err.status === 400) code = 'VALIDATION';
        else if (err.status === 409) code = 'PREVIEW_STALE';
        else code = 'DESCONOCIDO';
        const fromServer = body.error ?? body.message;
        const message = typeof fromServer === 'string' && fromServer && !/^Error \d+$/.test(fromServer)
            ? fromServer
            : CHARGE_BATCH_ERROR_MESSAGE[code];
        return new ChargeBatchError(code, message, err.status, err.body, err.retryAfterSeconds);
    }
    if (err instanceof TypeError) {
        // fetch sin red / BFF caído
        return new ChargeBatchError('NO_DISPONIBLE', CHARGE_BATCH_ERROR_MESSAGE.NO_DISPONIBLE, 0);
    }
    const msg = err instanceof Error ? err.message : CHARGE_BATCH_ERROR_MESSAGE.DESCONOCIDO;
    return new ChargeBatchError('DESCONOCIDO', msg, 0);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        throw toChargeBatchError(err);
    }
}

const qs = (params: Record<string, string | number | boolean | null | undefined>): string => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
};

// ── Normalización (forma real del BFF de F2 → tipos del modal) ────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- respuestas JSON externas: se leen campo a campo */
const num = (v: unknown, d = 0): number => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const numOrNull = (v: unknown): number | null => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const OVERRIDABLE = ['seguro_en_12_meses', 'misma_linea_hoy'];

function normalizeTag(t: any): AdjustmentTag {
    if (typeof t === 'string') return { origin: '', amount: 0, label: t };
    return {
        id: t.id ?? undefined,
        origin: t.origin ?? 'modal',
        kind: t.kind,
        reason_code: t.reason_code ?? null,
        basis: t.basis ?? null,
        pct: numOrNull(t.pct),
        amount: num(t.amount),
        sequence: t.sequence ?? undefined,
        scope: t.scope,
        label: t.label ?? undefined,
        reverted: !!t.reverted,
    };
}

export function normalizeOpenCharge(c: any): OpenCharge {
    const sugg = c.suggestions?.pronto_pago
        ?? (c.suggested_discount?.reason_code === 'pronto_pago'
            ? { pct: num(c.suggested_discount.value), valid_until: c.suggested_discount.valid_until ?? null }
            : null);
    return {
        id: c.id,
        concept: c.concept ?? c.label ?? 'Cobro',
        payment_category: c.payment_category ?? null,
        payment_type: c.payment_type ?? null,
        status: c.status,
        due_date: c.due_date ?? null,
        period_year: c.period_year ?? null,
        period_month: c.period_month ?? null,
        created_at: c.created_at ?? null,
        amount: num(c.amount),
        list_amount: numOrNull(c.list_amount),
        discount_amount: num(c.discount_amount),
        late_fee_amount: num(c.late_fee_amount),
        late_fee_waived_amount: num(c.late_fee_waived_amount),
        amount_paid: num(c.amount_paid),
        early_payment_discount_applied: numOrNull(c.early_payment_discount_applied),
        sibling_discount_applied: numOrNull(c.sibling_discount_applied),
        balance: c.saldo != null ? num(c.saldo) : c.balance != null ? num(c.balance) : undefined,
        en_revision: !!c.en_revision,
        pago_en_curso: !!c.pago_en_curso,
        pago_en_curso_amount: numOrNull(c.pago_en_curso_amount ?? c.pago_en_curso_monto),
        requires_review: !!c.requires_review,
        last_failure_at: c.last_failure_at ?? null,
        adjustments: Array.isArray(c.adjustments) ? c.adjustments.map(normalizeTag)
            : Array.isArray(c.discount_tags) ? c.discount_tags.map(normalizeTag) : [],
        suggestions: sugg ? { pronto_pago: sugg } : null,
        warnings: Array.isArray(c.warnings) ? c.warnings : [],
    };
}

export function normalizeOpenCharges(r: any): OpenChargesResponse {
    const list = Array.isArray(r?.items) ? r.items : Array.isArray(r?.charges) ? r.charges : [];
    const vm = r?.suggestions?.varios_meses;
    return {
        charges: list.map(normalizeOpenCharge),
        suggestions: vm ? { varios_meses: { min_months: num(vm.min_mensualidades ?? vm.min_months, 3) } } : null,
    };
}

const AMOUNT_SOURCE: Record<string, string> = { tarifa_del_atleta: 'monthly_fee', plan: 'plan', equipo: 'team' };

export function normalizeSuggestions(r: any): ChargeSuggestions {
    const raw: any[] = Array.isArray(r?.enrollments) ? r.enrollments : [];
    const enrollments: EnrollmentOption[] = raw.map((e) => ({
        enrollment_id: e.enrollment_id,
        offering_plan_id: e.offering_plan_id ?? e.plan?.id ?? null,
        plan_name: e.plan_name ?? e.plan?.name ?? null,
        team_name: e.team_name ?? e.team?.name ?? null,
        is_primary: !!e.is_primary,
        monthly_amount: numOrNull(e.monthly_amount ?? e.suggested_monthly_amount),
        active: e.active ?? (e.status ? e.status === 'active' : true),
        hours_plan: !!(e.hours_plan ?? e.plan?.hours_plan),
        hourly_rate: numOrNull(e.hourly_rate ?? e.plan?.hourly_rate),
        included_minutes: numOrNull(e.included_minutes ?? e.plan?.included_minutes),
        available_minutes: numOrNull(e.available_minutes ?? e.plan?.available_minutes),
    }));
    const primary = raw.find((e) => e.is_primary) ?? raw.find((e) => e.status === 'active') ?? raw[0];
    const amount = numOrNull(r?.suggested_monthly?.amount ?? primary?.suggested_monthly_amount ?? primary?.monthly_amount);
    const overagesRaw: any[] = Array.isArray(r?.overages) ? r.overages : Array.isArray(r?.overage_charges) ? r.overage_charges : [];
    return {
        enrollments,
        suggested_monthly: r?.suggested_monthly ?? (amount != null
            ? { amount, source: AMOUNT_SOURCE[primary?.amount_source] ?? primary?.amount_source ?? 'plan' }
            : null),
        next_period: r?.next_period ?? r?.next_free_period ?? null,
        overages: overagesRaw.map((o) => ({
            id: o.id,
            amount: num(o.amount),
            period_label: o.period_label ?? (o.billable_hours != null ? `${o.billable_hours} h por encima del plan` : 'Horas adicionales'),
        })),
        plan_fees: r?.plan_fees ?? r?.one_time_fees ?? [],
        payer_linked: r?.payer_linked,
        payer_name: r?.payer_name ?? null,
    };
}

export function normalizeTargets(r: any): { athletes: TargetAthlete[] } {
    const list: any[] = Array.isArray(r?.athletes) ? r.athletes : [];
    return {
        athletes: list.map((a) => ({
            type: a.type,
            id: a.id,
            name: a.name ?? 'Atleta',
            team_name: a.team_name ?? null,
            plan_name: a.plan_name ?? null,
            paused: !!a.paused,
            payer_linked: a.payer_linked ?? a.has_guardian ?? undefined,
        })),
    };
}

export function normalizeDuplicate(m: any): AthleteDuplicate {
    return {
        table_name: m.table_name ?? m.table,
        id: m.id,
        full_name: m.full_name ?? '',
        doc_masked: m.doc_masked ?? null,
        guardian: m.guardian ?? null,
        team_name: m.team_name ?? null,
        matched_by: m.matched_by ?? [],
        athlete_type: m.athlete_type,
    };
}

export function normalizeSearch(r: any): AthleteSearchResult {
    const list: any[] = Array.isArray(r?.items) ? r.items : Array.isArray(r?.matches) ? r.matches : [];
    return { matches: list.map(normalizeDuplicate) };
}

const TARGET_LABEL: Record<string, string> = {
    team: 'Un equipo', category: 'Una categoría', plan: 'Un plan', list: 'Varios atletas (a mano)',
};

export function normalizeBatchSummary(b: any): ChargeBatchSummary {
    const kind = b.target?.kind;
    return {
        id: b.id,
        created_at: b.created_at,
        created_by: b.created_by && typeof b.created_by === 'object' ? b.created_by : null,
        created_by_name: b.created_by_name ?? null,
        mode: b.mode,
        target: b.target ?? { kind: 'athlete', ids: [] },
        target_label: b.target_label ?? b.target?.label ?? (kind === 'athlete' ? 'Un atleta' : TARGET_LABEL[kind] ?? null),
        rows_created: num(b.rows_created),
        rows_skipped: num(b.rows_skipped),
        total_amount: num(b.total_amount),
        payments_registered: num(b.payments_registered),
        paid_total: num(b.paid_total),
        discount_total: num(b.discount_total),
        late_fee_waived_total: num(b.late_fee_waived_total),
        status: b.status,
        annul_reason: b.annul_reason ?? null,
    };
}

export function normalizeBatchPage(r: any): ChargeBatchPage {
    const list: any[] = Array.isArray(r?.items) ? r.items : [];
    return { items: list.map(normalizeBatchSummary), next_cursor: r?.next_cursor ?? null };
}

export function normalizeBatchDetail(r: any): ChargeBatchDetail {
    const batch = r?.batch ?? r ?? {};
    const rows: any[] = Array.isArray(r?.rows) ? r.rows : Array.isArray(r?.payments) ? r.payments : [];
    return {
        ...normalizeBatchSummary(batch),
        rows: rows.map((p) => ({
            payment_id: p.payment_id ?? p.id,
            athlete_name: p.athlete_name ?? '',
            concept: p.concept ?? p.label ?? '',
            payment_category: p.payment_category ?? null,
            amount: num(p.amount),
            list_amount: numOrNull(p.list_amount),
            amount_paid: numOrNull(p.amount_paid),
            status: p.status,
            adjustments: Array.isArray(p.adjustments) ? p.adjustments.map(normalizeTag) : undefined,
        })),
        skipped: batch.skipped ?? r?.skipped,
        annul_preview: r?.annul_preview ?? null,
    };
}

function previewErrorMessage(e: any): string {
    const base = (CHARGE_BATCH_ERROR_MESSAGE as Record<string, string>)[e.code] ?? String(e.code ?? 'Error');
    if (e.code === 'SOBREPAGO' && e.max != null) return `No se puede recibir más del saldo ($${num(e.max).toLocaleString('es-CO')}).`;
    return e.detail ? `${base} (${e.detail})` : base;
}

/** `recent_duplicates` del preview o `duplicates` del 409 COBRO_DUPLICADO_RECIENTE → lista tipada (o undefined si no hay). */
export function normalizeCobrosRecientes(raw: any): CobroRecienteAviso[] | undefined {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw.map((d: any) => ({
        batch_id: String(d?.batch_id ?? ''),
        created_at: String(d?.created_at ?? ''),
        minutes_ago: num(d?.minutes_ago),
        created_by_name: d?.created_by_name ?? null,
        total_amount: numOrNull(d?.total_amount),
    }));
}

/** «hace 3 min por Edna» (para el aviso y el diálogo de confirmación). */
export function textoCobroReciente(c: CobroRecienteAviso): string {
    const hace = c.minutes_ago <= 0 ? 'hace menos de un minuto' : `hace ${c.minutes_ago} min`;
    return `${hace}${c.created_by_name ? ` por ${c.created_by_name}` : ''}`;
}

export function normalizePreview(r: any): ChargeBatchPreview {
    const items: any[] = [
        ...(Array.isArray(r?.items) ? r.items : []),
        ...(Array.isArray(r?.pending) ? r.pending : []),
        ...(Array.isArray(r?.lines) ? r.lines : []),
    ];
    const skipped: any[] = Array.isArray(r?.skipped) ? r.skipped : [];
    const athletes: any[] = Array.isArray(r?.athletes) ? r.athletes : [];
    const errors: any[] = Array.isArray(r?.errors) ? r.errors : [];
    const exon = r?.exonerated;
    return {
        preview_hash: r?.preview_hash ?? '',
        rows_to_create: num(r?.rows_to_create ?? r?.to_create?.n),
        total_amount: num(r?.total_amount ?? r?.to_create?.total),
        to_create: r?.to_create ? { n: num(r.to_create.n), total: num(r.to_create.total) } : undefined,
        to_pay: r?.to_pay ? { n: num(r.to_pay.n), total: num(r.to_pay.total) } : undefined,
        discounts: r?.discounts ? { total: num(r.discounts.total), by_reason: r.discounts.by_reason ?? {} } : undefined,
        late_fee_waived: numOrNull(r?.late_fee_waived) ?? undefined,
        exonerated: exon == null ? undefined : typeof exon === 'object' ? num(exon.n) : num(exon),
        by_category: r?.by_category,
        list_total: numOrNull(r?.list_total) ?? undefined,
        skipped: skipped.map((s) => ({
            athlete: typeof s.athlete === 'string' ? { id: s.athlete, name: s.athlete_name ?? undefined } : s.athlete,
            line_idx: num(s.line_idx),
            reason: s.reason,
            overridable: s.overridable ?? OVERRIDABLE.includes(s.reason),
            detail: s.detail,
        })),
        athletes: athletes.map((a) => ({
            type: a.type,
            id: a.id ?? a.key,
            name: a.name ?? 'Atleta',
            payer_linked: a.payer_linked ?? (a.type === 'child' ? !!a.parent_id : true),
            enrollment_label: a.enrollment_label ?? null,
            suggested_monthly: numOrNull(a.suggested_monthly ?? a.child_monthly_fee),
            autopay: !!a.autopay,
            warnings: Array.isArray(a.warnings) ? a.warnings : [],
        })),
        warnings_count: r?.warnings_count ?? {},
        lines: items.map((it) => ({
            ref: it.ref,
            amount_before: num(it.amount_before ?? it.list),
            adjustments: (Array.isArray(it.adjustments) ? it.adjustments : []).map(normalizeTag),
            amount_after: num(it.amount_after ?? it.amount),
            pay_amount: num(it.pay_amount),
            resulting_status: it.resulting_status ?? it.status,
            warnings: Array.isArray(it.warnings) ? it.warnings : [],
        })),
        duplicates: Array.isArray(r?.duplicates) ? r.duplicates.map(normalizeDuplicate) : undefined,
        recent_duplicates: normalizeCobrosRecientes(r?.recent_duplicates),
        errors: errors.map((e) => ({ ref: e.ref, code: e.code, message: e.message ?? previewErrorMessage(e) })),
    };
}

export function normalizeCreateResult(r: any): ChargeBatchResult {
    return {
        ...(r ?? {}),
        batch_id: r?.batch_id ?? r?.id,
        duplicated: !!r?.duplicated,
        rows_created: num(r?.rows_created),
        total_amount: num(r?.total_amount),
    };
}

export function normalizeAdjustmentsReport(r: any): { items: PaymentAdjustmentReportRow[] } {
    const list: any[] = Array.isArray(r?.items) ? r.items : [];
    return {
        items: list.map((i) => ({
            id: i.id,
            created_at: i.created_at,
            athlete_name: i.athlete_name ?? '',
            concept: i.concept ?? i.payment?.concept ?? '',
            kind: i.kind,
            origin: i.origin,
            reason_code: i.reason_code,
            reason_text: i.reason_text ?? null,
            amount: num(i.amount),
            created_by_name: i.created_by_name ?? null,
            label: i.label,
            reverted: !!i.reverted,
            payment_id: i.payment_id,
            charge_batch_id: i.charge_batch_id ?? null,
            payment_status: i.payment?.status ?? null,
            basis: i.basis ?? null,
            pct: numOrNull(i.pct),
        })),
    };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Llamadas ──────────────────────────────────────────────────────────────────

export const chargeBatchesApi = {
    preview: (body: ChargeBatchRequest) =>
        call(async () => normalizePreview(await bffClient.post<unknown>(`${BASE}/preview`, body))),

    create: (body: ChargeBatchCreateRequest) =>
        call(async () => normalizeCreateResult(await bffClient.post<unknown>(BASE, body))),

    /** `with_discounts` lo filtra el modal (F2 no lo implementa todavía). */
    list: (params: { cursor?: string | null } = {}) =>
        call(async () => normalizeBatchPage(await bffClient.get<unknown>(`${BASE}${qs({ cursor: params.cursor })}`))),

    get: (batchId: string) =>
        call(async () => normalizeBatchDetail(await bffClient.get<unknown>(`${BASE}/${encodeURIComponent(batchId)}`))),

    /** Reintenta sumar al banco las horas de una venta ya creada y pagada (solo el dueño; idempotente por pago). */
    retryHourBankGrant: (batchId: string, body: { athlete: AthleteRef; enrollment_id: string; extra_hours: number }) =>
        call(async () => (await bffClient.post<{ hour_bank_grant: HourBankGrantResult }>(
            `${BASE}/${encodeURIComponent(batchId)}/hour-bank`, body)).hour_bank_grant),

    annul: (batchId: string, body: { reason: string; expected_count: number }) =>
        call(() => bffClient.post<{ annulled?: number; kept?: { payment_id: string; status: string }[] }>(
            `${BASE}/${encodeURIComponent(batchId)}/annul`, body)),

    targets: (params: { kind: 'team' | 'category' | 'plan'; id: string; include_paused?: boolean }) =>
        call(async () => normalizeTargets(await bffClient.get<unknown>(`${BASE}/targets${qs({
            kind: params.kind, id: params.id, include_paused: params.include_paused ? 'true' : undefined,
        })}`))),

    searchAthletes: (params: { q?: string; doc?: string; phone?: string }) =>
        call(async () => normalizeSearch(await bffClient.get<unknown>(`${BASE}/athlete-search${qs(params)}`))),

    suggestions: (athlete: AthleteRef) =>
        call(async () => normalizeSuggestions(await bffClient.get<unknown>(
            `/api/v1/athletes/${athlete.type}/${encodeURIComponent(athlete.id)}/charge-suggestions`))),

    openCharges: (athlete: AthleteRef) =>
        call(async () => normalizeOpenCharges(await bffClient.get<unknown>(
            `/api/v1/athletes/${athlete.type}/${encodeURIComponent(athlete.id)}/open-charges`))),

    revertAdjustment: (adjustmentId: string, reason: string) =>
        call(() => bffClient.post<Record<string, unknown>>(
            `/api/v1/payment-adjustments/${encodeURIComponent(adjustmentId)}/revert`, { reason })),

    adjustmentsReport: (params: { from?: string; to?: string; reason?: string } = {}) =>
        call(async () => normalizeAdjustmentsReport(await bffClient.get<unknown>(`/api/v1/payment-adjustments${qs(params)}`))),
};
