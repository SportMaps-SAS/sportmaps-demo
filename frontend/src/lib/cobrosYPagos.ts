/**
 * «Cobros y pagos» — funciones puras del modal (spec docs/specs/cobros-multiples.md
 * §10, §15). Sin React ni red: se prueban con vitest (cobrosYPagos.test.ts).
 *
 * Qué hay aquí:
 *   - quién puede (gates visuales; el BFF es el gate real, §9.1);
 *   - la ESTIMACIÓN local de cada línea (descuento por línea, reparto del
 *     descuento general, condonación, abono vs. cierre, exoneración, topes de
 *     D14, aviso del 50 % de D16) para que el personal vea el efecto mientras
 *     escribe. Lo que se confirma es lo que devuelve la vista previa del
 *     servidor (`_plan_charge_operation`), que usa las mismas reglas;
 *   - el texto del botón principal (tabla de §10.2);
 *   - el armado del cuerpo de POST /charge-batches(/preview) (§9.2).
 *
 * Reglas de dinero (todas en pesos enteros, COP):
 *   amount = list_amount − discount_amount + late_fee_amount        (invariante §6.5)
 *   saldo  = amount − amount_paid − early_payment_discount_applied
 *   Un descuento se calcula sobre lo que queda SIN recargo
 *   (list_amount − discount_amount) y nunca toca el recargo (para eso está
 *   condonar). Los porcentajes son secuenciales (D16): cada uno sobre el saldo
 *   que dejó el anterior, no se suman.
 */

import { CHARGE_CATEGORY_LABEL, chargeCategoryOf, type PaymentChargeCategory } from '@/lib/payment-accounts';
import type {
    AdjustmentTag,
    AthleteRef,
    ChargeBatchRequest,
    ChargeLinePayload,
    DiscountBasis,
    DiscountPayload,
    GlobalDiscountPayload,
    NewAthletePayload,
    OpenCharge,
    PaymentPayload,
    PendingSelectionPayload,
    ReasonCode,
    TargetKind,
} from '@/lib/api/chargeBatches';

// ── Permisos (gates visuales) ─────────────────────────────────────────────────

/** owner, admin, school_admin y super_admin de plataforma (Q1, Q21, Q-D16). */
export const FINANCE_ADMIN_ROLES = ['owner', 'admin', 'school_admin', 'super_admin'] as const;

/** Abrir el modal, generar cobros, registrar pagos y descontar. El coach NUNCA. */
export function canManageCharges(role: string | null | undefined): boolean {
    return !!role && (FINANCE_ADMIN_ROLES as readonly string[]).includes(role);
}

/** Ver el historial «Operaciones» (Q19): administración + contador. */
export function canReadChargeBatches(role: string | null | undefined): boolean {
    return canManageCharges(role) || role === 'accountant';
}

/** Excedente de banco de horas: solo el owner (H4, Q6). */
export function canChargeOverage(role: string | null | undefined): boolean {
    return role === 'owner';
}

// ── Catálogos y rótulos ───────────────────────────────────────────────────────

export const REASON_OPTIONS: readonly { value: ReasonCode; label: string }[] = [
    { value: 'pronto_pago', label: 'Pronto pago' },
    { value: 'varios_meses', label: 'Varios meses juntos' },
    { value: 'hermanos', label: 'Hermanos' },
    { value: 'beca', label: 'Beca' },
    { value: 'convenio', label: 'Convenio' },
    { value: 'cortesia', label: 'Cortesía' },
    { value: 'ajuste_de_precio', label: 'Ajuste de precio' },
    { value: 'error_de_cobro', label: 'Error de cobro' },
    { value: 'condonacion_mora', label: 'Condonación de mora' },
    { value: 'otro', label: 'Otro' },
];

export const REASON_LABEL: Record<string, string> = Object.fromEntries(REASON_OPTIONS.map((o) => [o.value, o.label]));

/** Origen de los descuentos automáticos que ya existen (D16, §6.5). */
export const ORIGIN_LABEL: Record<string, string> = {
    militar: 'Militar',
    hermanos: 'Hermanos',
    alta_solo_este_mes: 'Solo este mes',
    pronto_pago: 'Pronto pago',
};

export const SKIP_REASON_LABEL: Record<string, string> = {
    mensualidad_ya_existe: 'ya tiene la mensualidad de ese mes',
    seguro_en_12_meses: 'ya tiene seguro en los últimos 12 meses',
    excedente_ya_facturado: 'ese excedente ya se facturó',
    misma_linea_hoy: 'ya tiene ese mismo cobro creado hoy',
    fee_unica_vez: 'ese cobro del plan es de una sola vez y ya se cobró',
    sin_inscripcion_para_mensualidad: 'no tiene inscripción con plan para cobrarle mensualidad',
    exonerado: 'no se cobra (exonerado)',
    sin_inscripcion_activa: 'no tiene inscripción activa',
    omitido: 'lo quitaste de la operación',
};

export const WARNING_LABEL: Record<string, string> = {
    sin_acudiente: 'sin acudiente vinculado: no podrá pagar en línea hasta vincularlo',
    mes_pasado: 'ese mes ya pasó',
    sin_inscripcion_activa: 'no tiene inscripción activa',
    pausado: 'está en pausa',
    descuento_total_mayor_50: 'descuento total mayor al 50 %',
    autopay: 'tiene débito automático: se le debitará',
};

/** «$1.234.567» sin depender del ICU del entorno (vitest, navegador viejo). */
export function formatPesos(n: number): string {
    const v = Math.round(Math.abs(n));
    const s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${n < 0 ? '−' : ''}$${s}`;
}

function formatPct(p: number): string {
    const r = Math.round(p * 100) / 100;
    return `${String(r).replace('.', ',')} %`;
}

/** Rótulo de un ajuste: «Hermanos −10 %», «Convenio −$20.000», «Mora condonada −$36.150». */
export function adjustmentLabel(tag: Pick<AdjustmentTag, 'origin' | 'kind' | 'reason_code' | 'basis' | 'pct' | 'amount' | 'label'>): string {
    if (tag.label) return tag.label;
    if (tag.kind === 'condonacion_recargo') return `Mora condonada −${formatPesos(tag.amount)}`;
    if (tag.kind === 'exoneracion') return 'Exonerado';
    const name = tag.origin && tag.origin !== 'modal'
        ? (ORIGIN_LABEL[tag.origin] ?? tag.origin)
        : (REASON_LABEL[tag.reason_code ?? ''] ?? 'Descuento');
    const pct = tag.pct != null && tag.pct > 0 && (tag.basis ?? 'porcentaje') === 'porcentaje' ? tag.pct : null;
    return pct != null ? `${name} −${formatPct(pct)}` : `${name} −${formatPesos(tag.amount)}`;
}

export const isMensualidad = (category: string | null | undefined): boolean =>
    (category ?? 'mensualidad') === 'mensualidad';

// ── Descuentos ────────────────────────────────────────────────────────────────

export interface DiscountDraft {
    basis: DiscountBasis;
    value: number;
    reason_code: ReasonCode | '';
    reason_text: string;
}

export const emptyDiscount = (reason: ReasonCode | '' = ''): DiscountDraft => ({
    basis: 'porcentaje', value: 0, reason_code: reason, reason_text: '',
});

/** Efecto en pesos de un descuento sobre `base` (redondeo a peso entero). */
export function discountPesos(base: number, d: Pick<DiscountDraft, 'basis' | 'value'> | null | undefined): number {
    if (!d || !(d.value > 0) || !(base > 0)) return 0;
    return d.basis === 'porcentaje' ? Math.round(base * (d.value / 100)) : Math.round(d.value);
}

/** null si el descuento está completo; si no, qué falta (para mostrar en la línea). */
export function validateDiscountDraft(d: DiscountDraft | null | undefined): string | null {
    if (!d) return null;
    if (!(d.value > 0)) return 'Escribe el valor del descuento.';
    if (d.basis === 'porcentaje' && d.value > 100) return 'El porcentaje no puede pasar de 100.';
    if (d.basis === 'valor' && d.value > 20_000_000) return 'El valor no puede pasar de $20.000.000.';
    if (!d.reason_code) return 'Elige el motivo del descuento.';
    if (d.reason_code === 'otro' && d.reason_text.trim().length < 3) return 'Escribe el motivo (mínimo 3 letras).';
    return null;
}

/**
 * Descuentos SECUENCIALES (D16): cada uno sobre el saldo que dejó el anterior.
 * Lista 100.000, 10 % → 90.000, 10 % → 81.000, 10 % → 72.900 (no 70.000).
 */
export function stackSequential(
    list: number,
    steps: readonly Pick<DiscountDraft, 'basis' | 'value'>[],
): { amount: number; after: number }[] {
    let running = list;
    return steps.map((s) => {
        const x = Math.min(running, discountPesos(running, s));
        running -= x;
        return { amount: x, after: running };
    });
}

/**
 * Reparte `total` en proporción a `weights` con tope por línea (`caps`), por el
 * método del resto mayor: la suma de las partes es EXACTAMENTE `total`. Si una
 * línea toca su tope, se recorta y el sobrante va a las demás (§15.3). Si no
 * cabe → `{ error, max }` (DESCUENTO_EXCEDE con el máximo posible).
 */
export function distributeProportional(
    total: number,
    weights: readonly number[],
    caps: readonly number[],
): { shares: number[] } | { error: 'excede'; max: number } {
    const n = weights.length;
    const shares = new Array<number>(n).fill(0);
    const t = Math.round(total);
    const max = caps.reduce((a, c, i) => a + (weights[i] > 0 ? Math.max(0, Math.floor(c)) : 0), 0);
    if (t <= 0) return { shares };
    if (t > max) return { error: 'excede', max };

    let remaining = t;
    let active = weights.map((w, i) => i).filter((i) => weights[i] > 0 && caps[i] > 0);
    // Cada vuelta o reparte todo o saca al menos una línea topada: termina.
    while (remaining > 0 && active.length > 0) {
        const W = active.reduce((a, i) => a + weights[i], 0);
        const raw = active.map((i) => (remaining * weights[i]) / W);
        const floors = raw.map(Math.floor);
        let leftover = remaining - floors.reduce((a, b) => a + b, 0);
        const order = active
            .map((i, k) => ({ k, frac: raw[k] - floors[k], i }))
            .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
        const tentative = [...floors];
        for (const o of order) {
            if (leftover <= 0) break;
            tentative[o.k] += 1;
            leftover -= 1;
        }
        const clipped = active.filter((i, k) => shares[i] + tentative[k] > caps[i]);
        if (clipped.length === 0) {
            active.forEach((i, k) => { shares[i] += tentative[k]; });
            remaining = 0;
            break;
        }
        for (const i of clipped) {
            const room = Math.floor(caps[i]) - shares[i];
            shares[i] += room;
            remaining -= room;
        }
        active = active.filter((i) => !clipped.includes(i));
    }
    if (remaining > 0) return { error: 'excede', max };
    return { shares };
}

// ── Borradores del formulario ─────────────────────────────────────────────────

export interface NewLineDraft {
    key: string;
    category: PaymentChargeCategory;
    concept: string;
    /** null = «el de cada atleta» (solo mensualidad en modo varios, D4). */
    amount: number | null;
    due_date: string;
    notes: string;
    period: { year: number; month: number } | null;
    enrollment_id: string | null;
    overage_charge_id: string | null;
    /** Horas adicionales vendidas por adelantado (null = no es una venta de horas). */
    extra_hours: number | null;
    /**
     * Línea «Horas adicionales»: 'usadas' = ya las consumió, solo se cobra (el banco NO cambia);
     * 'adelantado' = las paga antes de usarlas y se suman al banco. null = sin elegir todavía.
     */
    horas_modo: 'usadas' | 'adelantado' | null;
    /** «Ya las usó»: cuántas horas se cobran (solo informativo y para calcular el valor; NUNCA viaja como extra_hours). */
    horas_usadas: number | null;
    discount: DiscountDraft | null;
    /** «No cobrar» (exoneración, §6.5). */
    exonerate: { reason_text: string } | null;
    /** Columna «Pagar» cuando está «Ya lo pagaron» (modo un atleta). */
    pay: boolean;
    /** Entra al descuento general. */
    inGlobal: boolean;
}

export interface PendingDraft {
    payment_id: string;
    selected: boolean;
    discount: DiscountDraft | null;
    waive: { enabled: boolean; value: number | null; reason_text: string };
    exonerate: { reason_text: string } | null;
    /** null = el saldo después de ajustes. */
    payAmount: number | null;
    closeMode: 'abono' | 'cerrar';
    closeReason: { reason_code: ReasonCode | ''; reason_text: string };
    inGlobal: boolean;
}

export interface GlobalDiscountDraft extends DiscountDraft {
    enabled: boolean;
}

export const newPendingDraft = (paymentId: string, selected = false): PendingDraft => ({
    payment_id: paymentId,
    selected,
    discount: null,
    waive: { enabled: false, value: null, reason_text: '' },
    exonerate: null,
    payAmount: null,
    closeMode: 'abono',
    closeReason: { reason_code: '', reason_text: '' },
    inGlobal: true,
});

let lineSeq = 0;
export function newLineDraft(partial: Partial<NewLineDraft> & Pick<NewLineDraft, 'category' | 'due_date'>): NewLineDraft {
    lineSeq += 1;
    return {
        key: `l${Date.now().toString(36)}${lineSeq}`,
        concept: CHARGE_CATEGORY_LABEL[partial.category],
        amount: null,
        notes: '',
        period: null,
        enrollment_id: null,
        overage_charge_id: null,
        extra_hours: null,
        horas_modo: null,
        horas_usadas: null,
        discount: null,
        exonerate: null,
        pay: true,
        inGlobal: true,
        ...partial,
    };
}

// ── Cálculo de una operación (modo un atleta) ─────────────────────────────────

export type LineStatus = 'pending' | 'paid' | 'partial' | 'cancelled' | 'not_created' | 'unchanged';

export interface LineTag {
    label: string;
    amount: number;
    kind: 'auto' | 'linea' | 'general' | 'cierre' | 'condonacion' | 'exoneracion';
}

export interface LineCalc {
    ref: string;
    kind: 'new' | 'pending';
    category: PaymentChargeCategory | null;
    /** Valor de lista (antes de cualquier descuento, sin recargo). */
    list: number;
    /** Descuentos que la fila ya traía (militar, hermanos, solo este mes, modal previos). */
    existingDiscount: number;
    lateFee: number;
    amountBefore: number;
    lineDiscount: number;
    generalShare: number;
    waived: number;
    closingDiscount: number;
    amountAfter: number;
    /** amount_paid + early_payment_discount_applied: el piso de D14. */
    floor: number;
    /** Lo que queda por pagar después de ajustes y antes de este pago. */
    balance: number;
    payAmount: number;
    status: LineStatus;
    exonerated: boolean;
    hasAdjustment: boolean;
    tags: LineTag[];
    /** Descuento total sobre la lista (incluye pronto pago congelado; la condonación no cuenta). */
    discountRatio: number;
    over50: boolean;
    errors: string[];
}

export interface OperationCalc {
    lines: LineCalc[];
    toCreate: { n: number; total: number };
    toPay: { n: number; total: number };
    discountsTotal: number;
    lateFeeWaived: number;
    /** Recargo por mora que va DENTRO de lo que se registra hoy (ya sumado en `toPay`; no se suma otra vez). */
    lateFeeIncluded: number;
    exonerated: number;
    /** Pendientes marcados que solo reciben ajustes (sin pago). */
    adjustOnly: number;
    listTotal: number;
    errors: string[];
    generalError: string | null;
}

interface WorkLine {
    calc: LineCalc;
    /** Lo que queda por descontar sin tocar el recargo, después del descuento por línea. */
    baseAfterLine: number;
    inGlobal: boolean;
    globalEligible: boolean;
}

const MIN_POSITIVE = 1;

function pendingList(c: OpenCharge): { list: number; existing: number } {
    const late = Number(c.late_fee_amount) || 0;
    if (c.list_amount != null) return { list: Number(c.list_amount), existing: Number(c.discount_amount) || 0 };
    // Cobro viejo sin list_amount: la RPC la estampa como amount − late_fee (§7.5 regla 6).
    return { list: Math.max(0, Number(c.amount) - late), existing: 0 };
}

/** ¿Se puede marcar este pendiente? (Q22, §7.5 regla 2) */
export function pendingBlockReason(c: OpenCharge): string | null {
    if (c.en_revision || c.status === 'awaiting_approval') return 'Tiene comprobante en revisión: apruébalo o recházalo primero.';
    if (c.pago_en_curso) return `La familia tiene un pago en línea en curso${c.pago_en_curso_amount ? ` por ${formatPesos(c.pago_en_curso_amount)}` : ''}: espera el resultado.`;
    return null;
}

export interface SingleInput {
    pending: { charge: OpenCharge; draft: PendingDraft }[];
    lines: NewLineDraft[];
    global: GlobalDiscountDraft | null;
    paymentOn: boolean;
    /**
     * Descuentos automáticos que la RPC aplica a una línea NUEVA (hermanos en una
     * mensualidad, militar), por ref 'new:<idx>', leídos de la última vista
     * previa. Sin esto el monto local no cuadra con el del servidor y el pago de
     * la línea saldría como sobrepago.
     */
    autoDiscounts?: Record<string, { amount: number; labels: string[] }>;
}

export function computeSingle(input: SingleInput): OperationCalc {
    const work: WorkLine[] = [];

    // 1) Pendientes marcados
    for (const { charge: c, draft: d } of input.pending) {
        if (!d.selected) continue;
        const { list, existing } = pendingList(c);
        const late = Number(c.late_fee_amount) || 0;
        const amount = Number(c.amount) || 0;
        const floor = (Number(c.amount_paid) || 0) + (Number(c.early_payment_discount_applied) || 0);
        const category = chargeCategoryOf(c.payment_category, c.concept) ?? (isMensualidad(c.payment_category) ? 'mensualidad' : null);
        const errors: string[] = [];
        const block = pendingBlockReason(c);
        if (block) errors.push(block);

        const base = Math.max(0, list - existing);
        const exonerated = !!d.exonerate;
        let lineDiscount = 0;
        let waived = 0;
        if (exonerated) {
            if ((Number(c.amount_paid) || 0) > 0) errors.push('Ya tiene abonos: no se puede exonerar. Usa «Cerrar el cobro» con descuento.');
            if (d.exonerate!.reason_text.trim().length < 3) errors.push('Escribe el motivo de la exoneración.');
        } else {
            const v = validateDiscountDraft(d.discount);
            if (v) errors.push(v);
            lineDiscount = discountPesos(base, d.discount);
            if (lineDiscount > base) errors.push(`El descuento (${formatPesos(lineDiscount)}) es mayor que el valor por descontar (${formatPesos(base)}); el recargo se perdona con «Condonar recargo».`);
            if (d.waive.enabled && late > 0) {
                const want = d.waive.value == null ? late : Math.round(d.waive.value);
                if (!(want > 0)) errors.push('Escribe cuánto recargo se condona.');
                if (want > late) errors.push(`No se puede condonar más que el recargo (${formatPesos(late)}).`);
                waived = Math.min(Math.max(0, want), late);
            }
        }

        const tags: LineTag[] = (c.adjustments ?? [])
            .filter((t) => !t.reverted && t.kind !== 'reversion')
            .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
            .map((t) => ({ label: adjustmentLabel(t), amount: Number(t.amount) || 0, kind: 'auto' as const }));
        if (lineDiscount > 0 && d.discount) {
            tags.push({
                label: adjustmentLabel({ origin: 'modal', reason_code: d.discount.reason_code, basis: d.discount.basis, pct: d.discount.value, amount: lineDiscount }),
                amount: lineDiscount, kind: 'linea',
            });
        }

        work.push({
            calc: {
                ref: `pending:${c.id}`, kind: 'pending', category, list, existingDiscount: existing, lateFee: late,
                amountBefore: amount, lineDiscount, generalShare: 0, waived, closingDiscount: 0,
                amountAfter: amount, floor, balance: 0, payAmount: 0, status: 'unchanged', exonerated,
                hasAdjustment: false, tags, discountRatio: 0, over50: false, errors,
            },
            baseAfterLine: Math.max(0, base - lineDiscount),
            inGlobal: d.inGlobal,
            globalEligible: !exonerated,
        });
    }

    // 2) Líneas nuevas
    input.lines.forEach((l, idx) => {
        const errors: string[] = [];
        const amount = l.amount == null ? 0 : Math.round(l.amount);
        if (l.amount == null || !(amount > 0)) errors.push('Escribe el valor del cobro.');
        if (amount > 20_000_000) errors.push('El valor no puede pasar de $20.000.000.');
        if (!l.concept.trim()) errors.push('Escribe el detalle del cobro.');
        if (l.category === 'mensualidad' && !l.period) errors.push('Elige el mes de la mensualidad.');
        if (l.category === 'excedente') {
            if (l.horas_modo == null && l.extra_hours == null && !l.overage_charge_id) {
                errors.push('Elige si las horas ya las usó (solo se cobran) o si las paga por adelantado (se suman al banco).');
            } else if (l.horas_modo === 'usadas') {
                // Solo cobra: ni suma horas ni exige pago. Sin período del banco es un cobro libre.
                if (l.extra_hours != null) errors.push('Las horas que ya usó no se suman al banco: quita las horas vendidas.');
            } else if (l.extra_hours != null) {
                if (!(l.extra_hours > 0)) errors.push('Escribe cuántas horas se vendieron.');
                else if (Math.abs(l.extra_hours * 4 - Math.round(l.extra_hours * 4)) > 1e-9) errors.push('Las horas se venden de a 15 minutos (0,25 h).');
                else if (l.extra_hours > 24) errors.push('Máximo 24 horas por venta.');
                if (!l.enrollment_id) errors.push('Elige a cuál inscripción se le suman las horas.');
                // Las horas se suman al banco solo con el cobro pagado: sin pago no hay horas.
                if (!(input.paymentOn && l.pay && !l.exonerate)) errors.push('Las horas se venden pagadas: activa «Ya lo pagaron» y deja marcado «Pagar».');
            } else if (!l.overage_charge_id) {
                errors.push('Elige el período de horas adicionales o escribe cuántas horas se vendieron.');
            }
        }
        const exonerated = !!l.exonerate;
        const auto = input.autoDiscounts?.[`new:${idx}`];
        const autoAmt = Math.min(Math.max(0, Math.round(auto?.amount ?? 0)), amount);
        const base = amount - autoAmt;
        let lineDiscount = 0;
        if (exonerated) {
            if (l.exonerate!.reason_text.trim().length < 3) errors.push('Escribe el motivo de «No cobrar».');
        } else {
            const v = validateDiscountDraft(l.discount);
            if (v) errors.push(v);
            lineDiscount = discountPesos(base, l.discount);
            if (lineDiscount > base) errors.push('El descuento es mayor que el valor del cobro.');
        }
        const tags: LineTag[] = autoAmt > 0
            ? (auto!.labels.length ? auto!.labels : ['Descuento automático']).map((label) => ({ label, amount: 0, kind: 'auto' as const }))
            : [];
        if (lineDiscount > 0 && l.discount) {
            tags.push({
                label: adjustmentLabel({ origin: 'modal', reason_code: l.discount.reason_code, basis: l.discount.basis, pct: l.discount.value, amount: lineDiscount }),
                amount: lineDiscount, kind: 'linea',
            });
        }
        work.push({
            calc: {
                ref: `new:${idx}`, kind: 'new', category: l.category, list: amount, existingDiscount: autoAmt, lateFee: 0,
                amountBefore: base, lineDiscount, generalShare: 0, waived: 0, closingDiscount: 0,
                amountAfter: base, floor: 0, balance: 0, payAmount: 0, status: 'pending', exonerated,
                hasAdjustment: false, tags, discountRatio: 0, over50: false, errors,
            },
            baseAfterLine: Math.max(0, base - lineDiscount),
            inGlobal: l.inGlobal,
            globalEligible: !exonerated,
        });
    });

    // 3) Descuento general (después de los de línea, §15.3)
    let generalError: string | null = null;
    const g = input.global;
    if (g?.enabled) {
        const v = validateDiscountDraft(g);
        if (v) generalError = v;
        const targets = work.filter((w) => w.inGlobal && w.globalEligible);
        if (!v && targets.length === 0) generalError = 'Marca a qué cobros aplica el descuento general.';
        if (!v && targets.length > 0) {
            // Tope de cada línea: lo que queda por descontar sin recargo, sin bajar
            // de lo ya pagado y sin quedar en $0 (eso es «No cobrar»).
            const caps = targets.map((w) => {
                const before = w.calc.amountBefore - w.calc.lineDiscount - w.calc.waived;
                return Math.max(0, Math.min(w.baseAfterLine, before - Math.max(w.calc.floor, MIN_POSITIVE)));
            });
            if (g.basis === 'porcentaje') {
                targets.forEach((w, i) => {
                    const share = discountPesos(w.baseAfterLine, g);
                    if (share > caps[i]) w.calc.errors.push(`El descuento general deja este cobro por debajo de lo permitido (máximo ${formatPesos(caps[i])}).`);
                    w.calc.generalShare = Math.min(share, caps[i]);
                });
            } else {
                const res = distributeProportional(g.value, targets.map((w) => w.baseAfterLine), caps);
                if ('error' in res) {
                    generalError = `El descuento general no cabe: el máximo posible es ${formatPesos(res.max)}.`;
                } else {
                    targets.forEach((w, i) => { w.calc.generalShare = res.shares[i]; });
                }
            }
            for (const w of targets) {
                if (w.calc.generalShare > 0) {
                    w.calc.tags.push({
                        label: g.basis === 'porcentaje'
                            ? `${REASON_LABEL[g.reason_code] ?? 'Descuento'} −${formatPct(g.value)}`
                            : `${REASON_LABEL[g.reason_code] ?? 'Descuento'} −${formatPesos(w.calc.generalShare)}`,
                        amount: w.calc.generalShare, kind: 'general',
                    });
                }
            }
        }
    }

    // 4) Monto final, pago, cierre y estado resultante
    const pendingDrafts = new Map(input.pending.map((p) => [`pending:${p.charge.id}`, p]));
    for (const w of work) {
        const c = w.calc;
        if (c.exonerated) {
            const mensual = isMensualidad(c.category);
            if (c.kind === 'new' && !mensual) {
                c.status = 'not_created';
                c.amountAfter = 0;
            } else if (mensual) {
                // Beca del mes: paid $0, cuenta para la vigencia (§6.5).
                c.lineDiscount = Math.max(0, c.list - c.existingDiscount);
                c.waived = c.lateFee;
                c.amountAfter = 0;
                c.status = 'paid';
            } else {
                c.status = 'cancelled';
            }
            c.tags.push({ label: mensual ? 'Exonerado (beca del mes)' : 'No se cobra', amount: c.amountAfter, kind: 'exoneracion' });
            c.hasAdjustment = true;
            continue;
        }

        c.amountAfter = c.amountBefore - c.lineDiscount - c.generalShare - c.waived;
        if (c.waived > 0) c.tags.push({ label: `Mora condonada −${formatPesos(c.waived)}`, amount: c.waived, kind: 'condonacion' });
        if (c.amountAfter < c.floor) {
            c.errors.push(`Con ese descuento el cobro quedaría en ${formatPesos(c.amountAfter)}, por debajo de lo ya pagado (${formatPesos(c.floor)}).`);
        } else if (c.amountAfter <= 0) {
            c.errors.push('El cobro no puede quedar en $0: usa «No cobrar».');
        }
        c.balance = Math.max(0, c.amountAfter - c.floor);

        let pay = 0;
        if (input.paymentOn) {
            if (c.kind === 'pending') {
                const d = pendingDrafts.get(c.ref)!.draft;
                pay = d.payAmount == null ? c.balance : Math.round(d.payAmount);
                if (pay < 0) c.errors.push('El valor a pagar no puede ser negativo.');
                if (pay > c.balance) c.errors.push(`No se puede recibir más de lo que se debe (${formatPesos(c.balance)}).`);
                if (pay > 0 && pay < c.balance && d.closeMode === 'cerrar') {
                    c.closingDiscount = c.balance - pay;
                    const room = w.baseAfterLine - c.generalShare;
                    if (c.closingDiscount > room) {
                        c.errors.push('La diferencia incluye recargo de mora: condónalo primero o regístralo como abono.');
                    }
                    const reason = d.discount?.reason_code || d.closeReason.reason_code;
                    const text = d.discount ? d.discount.reason_text : d.closeReason.reason_text;
                    if (!reason) c.errors.push('¿Por qué se cierra por menos? Elige el motivo.');
                    else if (reason === 'otro' && text.trim().length < 3) c.errors.push('Escribe el motivo del cierre.');
                    c.tags.push({
                        label: `${REASON_LABEL[reason] ?? 'Descuento'} −${formatPesos(c.closingDiscount)}`,
                        amount: c.closingDiscount, kind: 'cierre',
                    });
                }
            } else {
                const l = input.lines[Number(c.ref.split(':')[1])];
                pay = l.pay ? c.balance : 0;
            }
        }
        c.payAmount = Math.max(0, pay);

        if (c.payAmount > 0) {
            c.status = c.payAmount + c.closingDiscount >= c.balance ? 'paid' : 'partial';
        } else if (c.kind === 'pending' && c.floor > 0 && c.floor >= c.amountAfter) {
            c.status = 'paid'; // el descuento cubre lo que faltaba (§7.5 regla 8)
        } else {
            c.status = c.kind === 'new' ? 'pending' : 'unchanged';
        }
        c.hasAdjustment = c.lineDiscount > 0 || c.generalShare > 0 || c.waived > 0 || c.closingDiscount > 0;
    }

    // 5) Aviso del 50 % (D16) y totales
    const out: OperationCalc = {
        lines: work.map((w) => w.calc),
        toCreate: { n: 0, total: 0 },
        toPay: { n: 0, total: 0 },
        discountsTotal: 0,
        lateFeeWaived: 0,
        lateFeeIncluded: 0,
        exonerated: 0,
        adjustOnly: 0,
        listTotal: 0,
        errors: [],
        generalError,
    };
    const earlyByRef = new Map(input.pending.map((p) => [`pending:${p.charge.id}`, Number(p.charge.early_payment_discount_applied) || 0]));
    for (const c of out.lines) {
        const early = earlyByRef.get(c.ref) ?? 0;
        const totalDisc = c.existingDiscount + c.lineDiscount + c.generalShare + c.closingDiscount + early;
        c.discountRatio = c.list > 0 ? totalDisc / c.list : 0;
        c.over50 = !c.exonerated && c.discountRatio > 0.5;

        out.listTotal += c.list;
        if (c.kind === 'new' && c.status !== 'not_created') {
            out.toCreate.n += 1;
            out.toCreate.total += c.amountAfter;
        }
        if (c.payAmount > 0) {
            out.toPay.n += 1;
            out.toPay.total += c.payAmount;
            if (c.kind === 'pending' && !c.exonerated) out.lateFeeIncluded += Math.max(0, c.lateFee - c.waived);
        }
        if (c.exonerated) out.exonerated += 1;
        else out.discountsTotal += c.lineDiscount + c.generalShare + c.closingDiscount;
        out.lateFeeWaived += c.exonerated ? 0 : c.waived;
        if (c.kind === 'pending' && c.payAmount === 0 && c.hasAdjustment) out.adjustOnly += 1;
        out.errors.push(...c.errors);
    }
    if (generalError) out.errors.push(generalError);
    return out;
}

// ── Modo varios (solo genera, §10.3, §15.7) ───────────────────────────────────

export interface MultiLineCalc {
    ref: string;
    list: number | null;
    lineDiscount: number;
    generalShare: number;
    /** Por atleta; null = mensualidad «el de cada atleta» (el total real lo da la vista previa). */
    perAthlete: number | null;
    tags: LineTag[];
    over50: boolean;
    exonerated: boolean;
    errors: string[];
}

export interface MultiCalc {
    lines: MultiLineCalc[];
    athletes: number;
    estimatedRows: number;
    listTotal: number;
    total: number;
    discountsTotal: number;
    hasPerAthleteAmounts: boolean;
    errors: string[];
}

export function computeMulti(input: { lines: NewLineDraft[]; global: GlobalDiscountDraft | null; athletes: number }): MultiCalc {
    const n = Math.max(0, input.athletes);
    const errors: string[] = [];
    const g = input.global?.enabled ? input.global : null;
    const gErr = g ? validateDiscountDraft(g) : null;
    if (gErr) errors.push(gErr);
    const lines = input.lines.map((l, idx): MultiLineCalc => {
        const e: string[] = [];
        if (!l.concept.trim()) e.push('Escribe el detalle del cobro.');
        if (l.category === 'mensualidad' && !l.period) e.push('Elige el mes de la mensualidad.');
        if (l.category === 'excedente') e.push('Las horas adicionales se cobran por atleta, no en modo varios.');
        if (l.exonerate) e.push('«No cobrar» es por atleta: en modo varios quita la línea.');
        const perAthleteAmount = l.amount == null ? null : Math.round(l.amount);
        if (perAthleteAmount == null && l.category !== 'mensualidad') e.push('Escribe el valor del cobro.');
        if (perAthleteAmount != null && !(perAthleteAmount > 0)) e.push('Escribe el valor del cobro.');
        const dErr = validateDiscountDraft(l.discount);
        if (dErr) e.push(dErr);
        const tags: LineTag[] = [];
        let lineDiscount = 0;
        let generalShare = 0;
        if (perAthleteAmount != null) {
            lineDiscount = discountPesos(perAthleteAmount, l.discount);
            if (lineDiscount >= perAthleteAmount && lineDiscount > 0) e.push('El descuento no puede dejar el cobro en $0.');
            const rest = perAthleteAmount - lineDiscount;
            // «Descuento para todos» = el mismo % o valor fijo en cada línea, sin reparto entre atletas.
            if (g && !gErr && l.inGlobal) {
                generalShare = discountPesos(rest, g);
                if (generalShare >= rest && generalShare > 0) e.push('El descuento para todos deja este cobro en $0.');
            }
        }
        if (lineDiscount > 0 && l.discount) {
            tags.push({ label: adjustmentLabel({ origin: 'modal', reason_code: l.discount.reason_code, basis: l.discount.basis, pct: l.discount.value, amount: lineDiscount }), amount: lineDiscount, kind: 'linea' });
        }
        if (generalShare > 0 && g) {
            tags.push({ label: g.basis === 'porcentaje' ? `${REASON_LABEL[g.reason_code] ?? 'Descuento'} −${formatPct(g.value)}` : `${REASON_LABEL[g.reason_code] ?? 'Descuento'} −${formatPesos(generalShare)}`, amount: generalShare, kind: 'general' });
        }
        const perAthlete = perAthleteAmount == null ? null : perAthleteAmount - lineDiscount - generalShare;
        const over50 = perAthleteAmount != null && perAthleteAmount > 0 && (lineDiscount + generalShare) / perAthleteAmount > 0.5;
        return { ref: `new:${idx}`, list: perAthleteAmount, lineDiscount, generalShare, perAthlete, tags, over50, exonerated: !!l.exonerate, errors: e };
    });
    for (const l of lines) errors.push(...l.errors);
    const known = lines.filter((l) => l.perAthlete != null);
    return {
        lines,
        athletes: n,
        estimatedRows: n * lines.length,
        listTotal: known.reduce((a, l) => a + (l.list ?? 0) * n, 0),
        total: known.reduce((a, l) => a + (l.perAthlete ?? 0) * n, 0),
        discountsTotal: known.reduce((a, l) => a + (l.lineDiscount + l.generalShare) * n, 0),
        hasPerAthleteAmounts: lines.some((l) => l.perAthlete == null),
        errors,
    };
}

// ── Botón principal (tabla de §10.2) ──────────────────────────────────────────

export interface PrimaryButtonState {
    label: string;
    disabled: boolean;
    /** Por qué está deshabilitado (se muestra debajo). */
    reason: string | null;
}

export function primaryButtonState(args: {
    mode: 'single' | 'multi';
    toCreate: number;
    toPay: number;
    adjustOnly: number;
    errors?: number;
    previewFresh: boolean;
    previewLoading?: boolean;
    submitting?: boolean;
    noAthlete?: boolean;
    /** Lo que la vista previa omitió (ya existe, etc.): explica por qué no hay nada que crear. */
    skippedReasons?: string[];
}): PrimaryButtonState {
    const { mode, toCreate, toPay, adjustOnly } = args;
    let label: string;
    if (mode === 'multi') {
        label = `Generar ${toCreate}`;
    } else if (toCreate > 0 && toPay > 0) {
        label = `Generar ${toCreate} · Pagar ${toPay}`;
    } else if (toCreate > 0) {
        label = `Generar ${toCreate}`;
    } else if (toPay > 0) {
        label = toPay === 1 ? 'Registrar pago' : `Registrar pago (${toPay})`;
    } else if (adjustOnly > 0) {
        label = 'Guardar descuentos';
    } else {
        label = mode === 'single' ? 'Registrar pago' : 'Generar 0';
    }

    if (args.submitting) return { label, disabled: true, reason: null };
    if (args.noAthlete) return { label, disabled: true, reason: mode === 'multi' ? 'Elige a quiénes se les cobra.' : 'Elige el atleta.' };
    if (toCreate === 0 && toPay === 0 && adjustOnly === 0) {
        if (args.skippedReasons?.length) {
            return { label, disabled: true, reason: `No hay nada que crear: ${args.skippedReasons[0]}.` };
        }
        return { label, disabled: true, reason: mode === 'multi' ? 'Agrega al menos un cobro.' : 'Marca un cobro pendiente o agrega un cobro nuevo.' };
    }
    if ((args.errors ?? 0) > 0) return { label, disabled: true, reason: 'Corrige lo marcado en rojo.' };
    if (args.previewLoading) return { label, disabled: true, reason: 'Calculando la vista previa…' };
    if (!args.previewFresh) {
        return { label, disabled: true, reason: mode === 'multi' ? 'Actualiza la vista previa antes de confirmar.' : 'Esperando la vista previa.' };
    }
    return { label, disabled: false, reason: null };
}

// ── Cuerpo de la petición (§9.2) ──────────────────────────────────────────────

/** El BFF exige 3–300 caracteres si el texto viene: más corto no se manda (salvo «otro», que lo valida el modal). */
const reasonText = (t: string): string | undefined => {
    const v = t.trim();
    return v.length >= 3 ? v.slice(0, 300) : undefined;
};

function discountPayload(d: DiscountDraft | null | undefined): DiscountPayload | undefined {
    if (!d || !(d.value > 0) || !d.reason_code) return undefined;
    const text = reasonText(d.reason_text);
    return {
        basis: d.basis,
        value: d.basis === 'porcentaje' ? Math.round(d.value * 100) / 100 : Math.round(d.value),
        reason_code: d.reason_code,
        ...(text ? { reason_text: text } : {}),
    };
}

function linePayload(l: NewLineDraft, mode: 'single' | 'multi', calc?: LineCalc): ChargeLinePayload {
    const notes = l.notes.trim();
    // «Ya las usó» sin período del banco = cobro libre: viaja como «Otro cobro» y nunca suma horas.
    const horasUsadasLibre = l.category === 'excedente' && l.horas_modo === 'usadas' && !l.overage_charge_id;
    const p: ChargeLinePayload = {
        category: horasUsadasLibre ? 'otro' : l.category,
        due_date: l.due_date,
        concept: l.concept.trim(),
        ...(l.amount != null ? { amount: Math.round(l.amount) } : {}),
        ...(notes ? { notes } : {}),
        ...(l.category === 'mensualidad' && l.period ? { period: l.period } : {}),
        ...(l.enrollment_id && !horasUsadasLibre ? { enrollment_id: l.enrollment_id } : {}),
        ...(l.overage_charge_id ? { overage_charge_id: l.overage_charge_id } : {}),
        ...(l.category === 'excedente' && l.horas_modo !== 'usadas' && l.extra_hours != null ? { extra_hours: l.extra_hours } : {}),
    };
    if (l.exonerate) {
        p.exonerate = { reason_text: l.exonerate.reason_text.trim() };
    } else {
        const d = discountPayload(l.discount);
        if (d) p.discount = d;
    }
    if (mode === 'single') p.pay_amount = calc?.payAmount ?? 0;
    return p;
}

export interface SingleRequestInput {
    athlete: AthleteRef | null;
    newAthlete: NewAthletePayload | null;
    pending: { charge: OpenCharge; draft: PendingDraft }[];
    lines: NewLineDraft[];
    global: GlobalDiscountDraft | null;
    payment: PaymentPayload | null;
    calc: OperationCalc;
}

export function buildSingleRequest(input: SingleRequestInput): ChargeBatchRequest {
    const calcByRef = new Map(input.calc.lines.map((c) => [c.ref, c]));
    const pending: PendingSelectionPayload[] = input.pending
        .filter((p) => p.draft.selected)
        .map(({ charge: c, draft: d }) => {
            const calc = calcByRef.get(`pending:${c.id}`);
            const payAmount = calc?.payAmount ?? 0;
            const closeMode: 'cerrar' | 'abono' = payAmount > 0 && (calc?.closingDiscount ?? 0) > 0 ? 'cerrar' : 'abono';
            const out: PendingSelectionPayload = {
                payment_id: c.id,
                seen: { amount: Number(c.amount) || 0, amount_paid: Number(c.amount_paid) || 0 },
                pay_amount: payAmount,
                close_mode: closeMode,
            };
            if (d.exonerate) {
                out.exonerate = { reason_text: d.exonerate.reason_text.trim() };
                return out;
            }
            let disc = discountPayload(d.discount);
            // «Cerrar» sin descuento propio: la diferencia viaja como descuento en
            // pesos con el motivo elegido (§9.2: cerrar exige discount.reason_code).
            if (closeMode === 'cerrar' && !disc && d.closeReason.reason_code) {
                const text = reasonText(d.closeReason.reason_text);
                disc = {
                    basis: 'valor',
                    value: calc!.closingDiscount,
                    reason_code: d.closeReason.reason_code,
                    ...(text ? { reason_text: text } : {}),
                };
            }
            if (disc) out.discount = disc;
            if (d.waive.enabled && (Number(c.late_fee_amount) || 0) > 0) {
                const text = d.waive.reason_text.trim().slice(0, 300);
                out.waive_late_fee = {
                    ...(d.waive.value != null ? { value: Math.round(d.waive.value) } : {}),
                    ...(text ? { reason_text: text } : {}),
                };
            }
            return out;
        });

    const lines = input.lines.map((l, i) => linePayload(l, 'single', calcByRef.get(`new:${i}`)));

    const body: ChargeBatchRequest = {
        mode: 'single',
        target: { kind: 'athlete', ids: input.athlete ? [input.athlete.id] : [] },
        athletes: input.athlete ? [input.athlete] : [],
        lines,
        pending,
    };
    const g = buildGlobal(input.global, [
        ...input.pending.filter((p) => p.draft.selected && !p.draft.exonerate && p.draft.inGlobal).map((p) => `pending:${p.charge.id}`),
        ...input.lines.map((l, i) => (l.inGlobal && !l.exonerate ? `new:${i}` : null)).filter((x): x is string => !!x),
    ]);
    if (g) body.global_discount = g;
    if (input.payment && input.calc.toPay.n > 0) body.payment = input.payment;
    if (input.newAthlete) body.new_athlete = input.newAthlete;
    return body;
}

function buildGlobal(g: GlobalDiscountDraft | null, refs: string[]): GlobalDiscountPayload | undefined {
    if (!g?.enabled || refs.length === 0) return undefined;
    const d = discountPayload(g);
    return d ? { ...d, line_refs: refs } : undefined;
}

export function buildMultiRequest(input: {
    target: { kind: TargetKind; ids: string[] };
    athletes: AthleteRef[];
    lines: NewLineDraft[];
    global: GlobalDiscountDraft | null;
}): ChargeBatchRequest {
    const body: ChargeBatchRequest = {
        mode: 'multi',
        target: input.target,
        athletes: input.athletes,
        lines: input.lines.map((l) => linePayload(l, 'multi')),
    };
    const g = buildGlobal(input.global, input.lines.map((l, i) => (l.inGlobal ? `new:${i}` : null)).filter((x): x is string => !!x));
    if (g) body.global_discount = g;
    return body;
}

/** Firma estable del formulario: si cambia, la vista previa quedó vieja. */
export function requestSignature(body: ChargeBatchRequest): string {
    return JSON.stringify(body);
}

/**
 * Espera tras la última edición antes de pedir la vista previa. Era 900 ms: con cada
 * tecla en un monto se disparaba una vista previa, y sumada al buscador y a los
 * destinos el personal llegaba al límite del BFF en uso normal.
 */
export const PREVIEW_DEBOUNCE_MS = 1500;

/**
 * ¿Hay que pedir la vista previa para este cuerpo? No si es el MISMO que ya está
 * vigente (`lastSig`) ni el que está en camino o esperando reintento (`inFlightSig`).
 * Así, editar y deshacer, o un re-render que no cambia el cuerpo, no gastan cupo.
 */
export function shouldRequestPreview(sig: string | null, lastSig: string | null, inFlightSig: string | null): boolean {
    if (!sig) return false;
    return sig !== lastSig && sig !== inFlightSig;
}

export const PREVIEW_RATE_LIMIT_MESSAGE = 'Espera un momento… estamos recalculando la vista previa.';

/** Espera antes del único reintento tras un 429: el `Retry-After` del BFF, entre 1 y 60 s (3 s si no vino). */
export function rateLimitRetryDelayMs(retryAfterSeconds?: number | null): number {
    const s = typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 3;
    return Math.min(60, Math.max(1, s)) * 1000;
}

/** UUID v4 para client_request_id (se genera al abrir el modal y se conserva en reintentos, §10.4). */
export function newClientRequestId(): string {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Suma `days` a una fecha YYYY-MM-DD (sin husos: se ancla al mediodía UTC). */
export function addDays(ymd: string, days: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
}

/** Meses entre el período y hoy (positivo = futuro). Q4: hasta 3 adelante, hasta 12 atrás. */
export function monthsFromToday(period: { year: number; month: number }, today: { year: number; month: number }): number {
    return (period.year * 12 + period.month) - (today.year * 12 + today.month);
}

// ── Horas adicionales vendidas por adelantado ────────────────────────────────

/** 1 → «1», 1.5 → «1,5», 2.25 → «2,25». */
export function formatHoras(horas: number): string {
    return String(Math.round(horas * 100) / 100).replace('.', ',');
}

/** Mismo texto que arma el BFF (`conceptoHorasAdicionales`): el servidor lo vuelve a fijar. */
export function conceptoHorasAdicionales(horas: number): string {
    return `Horas adicionales · ${formatHoras(horas)} h`;
}

/** Valor sugerido de N horas con la tarifa del plan (null si el plan no tiene tarifa). */
export function montoDeHoras(horas: number, tarifaPorHora: number | null | undefined): number | null {
    if (!(horas > 0) || !(Number(tarifaPorHora) > 0)) return null;
    return Math.round(horas * Number(tarifaPorHora));
}

/** Suma 0,25 h de a pasos, sin pasar de 24 ni bajar de 0,25. */
export function pasoDeHoras(horas: number, delta: number): number {
    const n = Math.round((horas + delta) * 4) / 4;
    return Math.min(24, Math.max(0.25, n));
}
