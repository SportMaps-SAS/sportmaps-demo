import { describe, expect, it } from 'vitest';
import type { OpenCharge } from '@/lib/api/chargeBatches';
import {
    PREVIEW_DEBOUNCE_MS,
    rateLimitRetryDelayMs,
    shouldRequestPreview,
    adjustmentLabel,
    buildMultiRequest,
    buildSingleRequest,
    canChargeOverage,
    canManageCharges,
    canReadChargeBatches,
    computeMulti,
    computeSingle,
    discountPesos,
    distributeProportional,
    conceptoHorasAdicionales,
    formatHoras,
    formatPesos,
    montoDeHoras,
    newLineDraft,
    pasoDeHoras,
    newPendingDraft,
    primaryButtonState,
    stackSequential,
    validateDiscountDraft,
    type DiscountDraft,
    type GlobalDiscountDraft,
    type NewLineDraft,
    type PendingDraft,
} from './cobrosYPagos';

const pct = (value: number, reason: DiscountDraft['reason_code'] = 'convenio'): DiscountDraft => ({ basis: 'porcentaje', value, reason_code: reason, reason_text: '' });
const pesos = (value: number, reason: DiscountDraft['reason_code'] = 'convenio'): DiscountDraft => ({ basis: 'valor', value, reason_code: reason, reason_text: '' });
const global = (d: DiscountDraft): GlobalDiscountDraft => ({ ...d, enabled: true });

function charge(over: Partial<OpenCharge> = {}): OpenCharge {
    return {
        id: over.id ?? 'p-oct',
        concept: 'Mensualidad Octubre 2026',
        payment_category: 'mensualidad',
        status: 'pending',
        due_date: '2026-10-05',
        amount: 723_000,
        list_amount: null,
        discount_amount: 0,
        late_fee_amount: 0,
        amount_paid: 0,
        early_payment_discount_applied: null,
        en_revision: false,
        pago_en_curso: false,
        ...over,
    };
}

function sel(c: OpenCharge, over: Partial<PendingDraft> = {}) {
    return { charge: c, draft: { ...newPendingDraft(c.id, true), ...over } };
}

function line(over: Partial<NewLineDraft> & Pick<NewLineDraft, 'category'>): NewLineDraft {
    return newLineDraft({ due_date: '2026-10-20', amount: 80_000, ...over });
}

describe('permisos', () => {
    it('owner/admin/school_admin/super_admin gestionan; coach, accountant, parent no', () => {
        for (const r of ['owner', 'admin', 'school_admin', 'super_admin']) expect(canManageCharges(r)).toBe(true);
        for (const r of ['coach', 'reporter', 'accountant', 'parent', 'athlete', null, undefined, '']) expect(canManageCharges(r as string)).toBe(false);
    });
    it('el contador lee el historial pero no gestiona', () => {
        expect(canReadChargeBatches('accountant')).toBe(true);
        expect(canReadChargeBatches('coach')).toBe(false);
    });
    it('excedente solo owner (H4)', () => {
        expect(canChargeOverage('owner')).toBe(true);
        expect(canChargeOverage('admin')).toBe(false);
        expect(canChargeOverage('school_admin')).toBe(false);
    });
});

describe('descuentos básicos', () => {
    it('porcentaje redondea a peso; valor fijo tal cual', () => {
        expect(discountPesos(723_000, pct(10))).toBe(72_300);
        expect(discountPesos(100_001, pct(15))).toBe(15_000);
        expect(discountPesos(80_000, pesos(20_000))).toBe(20_000);
        expect(discountPesos(80_000, null)).toBe(0);
    });
    it('valida motivo, tope de % y texto de «otro»', () => {
        expect(validateDiscountDraft(pct(101))).toMatch(/100/);
        expect(validateDiscountDraft({ ...pct(10), reason_code: '' })).toMatch(/motivo/);
        expect(validateDiscountDraft({ ...pct(10), reason_code: 'otro', reason_text: 'x' })).toMatch(/motivo/);
        expect(validateDiscountDraft({ ...pct(10), reason_code: 'otro', reason_text: 'Acuerdo con el club' })).toBeNull();
        expect(validateDiscountDraft(pct(0))).toMatch(/valor/);
    });
    it('rótulos de etiquetas', () => {
        expect(adjustmentLabel({ origin: 'hermanos', pct: 10, amount: 80_333 })).toBe('Hermanos −10 %');
        expect(adjustmentLabel({ origin: 'modal', reason_code: 'convenio', basis: 'valor', amount: 20_000 })).toBe('Convenio −$20.000');
        expect(adjustmentLabel({ origin: 'modal', kind: 'condonacion_recargo', amount: 36_150 })).toBe('Mora condonada −$36.150');
        expect(formatPesos(1_453_700)).toBe('$1.453.700');
    });
});

describe('acumulación secuencial (D16)', () => {
    it('militar 10 % → hermanos 10 % → modal 10 % = 72.900 (no 70.000)', () => {
        const steps = stackSequential(100_000, [pct(10), pct(10), pct(10)]);
        expect(steps.map((s) => s.after)).toEqual([90_000, 81_000, 72_900]);
        expect(steps.map((s) => s.amount)).toEqual([10_000, 9_000, 8_100]);
    });
    it('el % del modal va sobre el saldo con hermanos (Q-D10/Q-D17)', () => {
        // Mensualidad nacida con hermanos: lista 803.333, ya descontada a 723.000.
        const c = charge({ list_amount: 803_333, discount_amount: 80_333, amount: 723_000 });
        const r = computeSingle({ pending: [sel(c, { discount: pct(10, 'pronto_pago') })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].lineDiscount).toBe(72_300);
        expect(r.lines[0].amountAfter).toBe(650_700);
    });
    it('etiquetas en orden: las que trae y luego la del modal', () => {
        const c = charge({
            list_amount: 803_333, discount_amount: 80_333,
            adjustments: [{ origin: 'hermanos', pct: 10, amount: 80_333, sequence: 1 }],
        });
        const r = computeSingle({ pending: [sel(c, { discount: pct(10, 'pronto_pago') })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].tags.map((t) => t.label)).toEqual(['Hermanos −10 %', 'Pronto pago −10 %']);
    });
});

describe('descuentos automáticos del servidor en una línea nueva (Q17)', () => {
    it('hermanos va primero y el % del modal se calcula sobre el saldo; el pago cuadra', () => {
        const lines = [line({ category: 'mensualidad', amount: 100_000, period: { year: 2026, month: 11 }, discount: pct(10, 'pronto_pago'), pay: true })];
        const r = computeSingle({
            pending: [], lines, global: null, paymentOn: true,
            autoDiscounts: { 'new:0': { amount: 10_000, labels: ['Hermanos −10 %'] } },
        });
        expect(r.lines[0].existingDiscount).toBe(10_000);
        expect(r.lines[0].lineDiscount).toBe(9_000);
        expect(r.lines[0].amountAfter).toBe(81_000);
        expect(r.lines[0].payAmount).toBe(81_000);
        expect(r.lines[0].tags.map((t) => t.label)).toEqual(['Hermanos −10 %', 'Pronto pago −10 %']);
    });
});

describe('caso mixto del wireframe (T20)', () => {
    const sep = charge({ id: 'p-sep', concept: 'Mensualidad Septiembre 2026', status: 'overdue', amount: 759_150, late_fee_amount: 36_150 });
    const oct = charge({ id: 'p-oct', amount: 723_000 });
    const lines = [
        line({ category: 'torneo', concept: 'Copa Pony 2026', amount: 80_000, pay: true }),
        line({ category: 'mensualidad', concept: 'Mensualidad Noviembre 2026', amount: 723_000, period: { year: 2026, month: 11 }, pay: false }),
    ];
    const r = computeSingle({
        pending: [
            sel(sep, { waive: { enabled: true, value: null, reason_text: '' } }),
            sel(oct, { discount: pct(10, 'pronto_pago') }),
        ],
        lines,
        global: null,
        paymentOn: true,
    });

    it('2 cobros nuevos y 3 pagos', () => {
        expect(r.errors).toEqual([]);
        expect(r.toCreate).toEqual({ n: 2, total: 803_000 });
        expect(r.toPay.n).toBe(3);
        expect(r.toPay.total).toBe(723_000 + 650_700 + 80_000);
        expect(r.toPay.total).toBe(1_453_700);
    });
    it('sep: recargo condonado completo; oct: 650.700', () => {
        const [s, o] = r.lines;
        expect(s.waived).toBe(36_150);
        expect(s.amountAfter).toBe(723_000);
        expect(s.status).toBe('paid');
        expect(o.amountAfter).toBe(650_700);
        expect(o.status).toBe('paid');
        expect(r.discountsTotal).toBe(72_300);
        expect(r.lateFeeWaived).toBe(36_150);
    });
    it('el botón dice «Generar 2 · Pagar 3»', () => {
        const b = primaryButtonState({ mode: 'single', toCreate: r.toCreate.n, toPay: r.toPay.n, adjustOnly: r.adjustOnly, errors: r.errors.length, previewFresh: true });
        expect(b).toEqual({ label: 'Generar 2 · Pagar 3', disabled: false, reason: null });
    });
});

describe('condonar recargo', () => {
    it('parcial: baja el monto y no toca el valor', () => {
        const c = charge({ amount: 759_150, late_fee_amount: 36_150 });
        const r = computeSingle({ pending: [sel(c, { waive: { enabled: true, value: 20_000, reason_text: '' } })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].waived).toBe(20_000);
        expect(r.lines[0].amountAfter).toBe(739_150);
        expect(r.adjustOnly).toBe(1);
    });
    it('no se condona más que el recargo', () => {
        const c = charge({ amount: 759_150, late_fee_amount: 36_150 });
        const r = computeSingle({ pending: [sel(c, { waive: { enabled: true, value: 50_000, reason_text: '' } })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].errors.join(' ')).toMatch(/más que el recargo/);
    });
    it('un descuento no se come el recargo (DESCUENTO_EXCEDE)', () => {
        const c = charge({ amount: 759_150, late_fee_amount: 36_150 });
        const r = computeSingle({ pending: [sel(c, { discount: pesos(740_000) })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].errors.join(' ')).toMatch(/Condonar recargo/);
    });
});

describe('abono vs. cerrar (T23)', () => {
    const c = charge({ list_amount: 723_000, amount: 650_700, discount_amount: 72_300 });
    it('abono: queda partial y la deuda sigue', () => {
        const r = computeSingle({ pending: [sel(c, { payAmount: 600_000, closeMode: 'abono' })], lines: [], global: null, paymentOn: true });
        expect(r.lines[0].status).toBe('partial');
        expect(r.lines[0].payAmount).toBe(600_000);
        expect(r.lines[0].closingDiscount).toBe(0);
        expect(r.errors).toEqual([]);
    });
    it('cerrar sin motivo → error; con motivo → paid y la diferencia es descuento', () => {
        const sinMotivo = computeSingle({ pending: [sel(c, { payAmount: 600_000, closeMode: 'cerrar' })], lines: [], global: null, paymentOn: true });
        expect(sinMotivo.errors.join(' ')).toMatch(/por qué se cierra/i);
        const r = computeSingle({
            pending: [sel(c, { payAmount: 600_000, closeMode: 'cerrar', closeReason: { reason_code: 'cortesia', reason_text: '' } })],
            lines: [], global: null, paymentOn: true,
        });
        expect(r.errors).toEqual([]);
        expect(r.lines[0].status).toBe('paid');
        expect(r.lines[0].closingDiscount).toBe(50_700);
        expect(r.discountsTotal).toBe(50_700);
    });
    it('no se recibe más del saldo (SOBREPAGO)', () => {
        const r = computeSingle({ pending: [sel(c, { payAmount: 700_000 })], lines: [], global: null, paymentOn: true });
        expect(r.errors.join(' ')).toMatch(/más de lo que se debe/);
    });
    it('el saldo descuenta lo ya abonado y el pronto pago congelado', () => {
        const p = charge({ amount: 723_000, amount_paid: 300_000, early_payment_discount_applied: 23_000, status: 'partial' });
        const r = computeSingle({ pending: [sel(p)], lines: [], global: null, paymentOn: true });
        expect(r.lines[0].balance).toBe(400_000);
        expect(r.lines[0].payAmount).toBe(400_000);
        expect(r.lines[0].status).toBe('paid');
    });
    it('un descuento no baja el cobro por debajo de lo abonado (D14)', () => {
        const p = charge({ amount: 723_000, amount_paid: 300_000, status: 'partial' });
        const r = computeSingle({ pending: [sel(p, { discount: pesos(500_000) })], lines: [], global: null, paymentOn: false });
        expect(r.errors.join(' ')).toMatch(/por debajo de lo ya pagado/);
    });
    it('descuento que cubre exactamente lo que faltaba deja el cobro pagado', () => {
        const p = charge({ amount: 723_000, amount_paid: 650_700, status: 'partial' });
        const r = computeSingle({ pending: [sel(p, { discount: pesos(72_300, 'pronto_pago') })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].status).toBe('paid');
        expect(r.errors).toEqual([]);
    });
});

describe('exoneración («No cobrar», §6.5)', () => {
    it('mensualidad nueva: paid en $0 (beca del mes)', () => {
        const r = computeSingle({ pending: [], lines: [line({ category: 'mensualidad', amount: 723_000, period: { year: 2026, month: 11 }, exonerate: { reason_text: 'Beca deportiva' } })], global: null, paymentOn: false });
        expect(r.lines[0].status).toBe('paid');
        expect(r.lines[0].amountAfter).toBe(0);
        expect(r.toCreate.n).toBe(1);
        expect(r.exonerated).toBe(1);
        expect(r.discountsTotal).toBe(0);
    });
    it('cobro único nuevo: no se crea', () => {
        const r = computeSingle({ pending: [], lines: [line({ category: 'seguro', amount: 150_000, exonerate: { reason_text: 'Ya tiene seguro' } })], global: null, paymentOn: false });
        expect(r.lines[0].status).toBe('not_created');
        expect(r.toCreate.n).toBe(0);
    });
    it('cobro único pendiente: se anula; con abonos no se puede', () => {
        const t = charge({ id: 'p-t', payment_category: 'torneo', concept: 'Torneo', amount: 80_000 });
        const r = computeSingle({ pending: [sel(t, { exonerate: { reason_text: 'Cortesía del club' } })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].status).toBe('cancelled');
        const conAbono = computeSingle({ pending: [sel({ ...t, amount_paid: 10_000 }, { exonerate: { reason_text: 'Cortesía del club' } })], lines: [], global: null, paymentOn: false });
        expect(conAbono.errors.join(' ')).toMatch(/no se puede exonerar/);
    });
    it('exige motivo', () => {
        const r = computeSingle({ pending: [], lines: [line({ category: 'torneo', exonerate: { reason_text: '' } })], global: null, paymentOn: false });
        expect(r.errors.join(' ')).toMatch(/motivo/);
    });
});

describe('descuento general (§15.3, T22)', () => {
    it('porcentaje: el mismo % a cada línea, después del descuento por línea', () => {
        const a = charge({ id: 'a', amount: 723_000 });
        const b = charge({ id: 'b', amount: 723_000 });
        const c = charge({ id: 'c', amount: 723_000 });
        const r = computeSingle({
            pending: [sel(a), sel(b), sel(c, { discount: pct(10, 'beca') })],
            lines: [], global: global(pct(5, 'varios_meses')), paymentOn: false,
        });
        expect(r.lines.map((l) => l.generalShare)).toEqual([36_150, 36_150, 32_535]);
        expect(r.lines[2].lineDiscount).toBe(72_300);
    });
    it('valor fijo: prorrateo por resto mayor, la suma es exacta', () => {
        const r = computeSingle({
            pending: [],
            lines: [
                line({ category: 'torneo', amount: 100_000 }),
                line({ category: 'articulos', amount: 100_000 }),
                line({ category: 'viaje', amount: 100_000 }),
            ],
            global: global(pesos(10_000)), paymentOn: false,
        });
        const shares = r.lines.map((l) => l.generalShare);
        expect(shares.reduce((x, y) => x + y, 0)).toBe(10_000);
        expect(shares).toEqual([3_334, 3_333, 3_333]);
        expect(r.discountsTotal).toBe(10_000);
    });
    it('solo las líneas marcadas reciben su parte', () => {
        const r = computeSingle({
            pending: [],
            lines: [line({ category: 'torneo', amount: 60_000 }), line({ category: 'otro', amount: 40_000, inGlobal: false })],
            global: global(pesos(6_000)), paymentOn: false,
        });
        expect(r.lines.map((l) => l.generalShare)).toEqual([6_000, 0]);
    });
    it('si no cabe, dice el máximo posible', () => {
        const r = computeSingle({ pending: [], lines: [line({ category: 'torneo', amount: 10_000 })], global: global(pesos(50_000)), paymentOn: false });
        expect(r.generalError).toMatch(/máximo posible es \$9\.999/);
    });
});

describe('distributeProportional', () => {
    it('reparte exacto y respeta topes redistribuyendo', () => {
        const res = distributeProportional(1_000, [500, 500], [100, 2_000]);
        expect(res).toEqual({ shares: [100, 900] });
    });
    it('resto mayor con empate desempata por orden', () => {
        expect(distributeProportional(1, [1, 1], [10, 10])).toEqual({ shares: [1, 0] });
    });
    it('excede → máximo', () => {
        expect(distributeProportional(500, [1, 1], [100, 100])).toEqual({ error: 'excede', max: 200 });
    });
});

describe('aviso del 50 % (D16): aviso, no bloqueo', () => {
    it('un descuento de 55 % marca over50 y no agrega error', () => {
        const r = computeSingle({ pending: [], lines: [line({ category: 'torneo', amount: 100_000, discount: pct(55, 'beca') })], global: null, paymentOn: false });
        expect(r.lines[0].over50).toBe(true);
        expect(r.errors).toEqual([]);
    });
    it('cuenta los descuentos previos y el pronto pago congelado; no la condonación', () => {
        const c = charge({ list_amount: 100_000, discount_amount: 30_000, amount: 90_000, late_fee_amount: 20_000, early_payment_discount_applied: 0 });
        const r = computeSingle({ pending: [sel(c, { discount: pesos(15_000), waive: { enabled: true, value: null, reason_text: '' } })], lines: [], global: null, paymentOn: false });
        expect(r.lines[0].discountRatio).toBeCloseTo(0.45);
        expect(r.lines[0].over50).toBe(false);
        const r2 = computeSingle({ pending: [sel(c, { discount: pesos(25_000) })], lines: [], global: null, paymentOn: false });
        expect(r2.lines[0].over50).toBe(true);
    });
});

describe('bloqueos de pendientes (Q22, §7.5)', () => {
    it('comprobante en revisión o pago en curso → error', () => {
        const r = computeSingle({ pending: [sel(charge({ en_revision: true }))], lines: [], global: null, paymentOn: true });
        expect(r.errors.join(' ')).toMatch(/revisión/);
        const r2 = computeSingle({ pending: [sel(charge({ pago_en_curso: true, pago_en_curso_amount: 723_000 }))], lines: [], global: null, paymentOn: false });
        expect(r2.errors.join(' ')).toMatch(/pago en línea en curso por \$723\.000/);
    });
});

describe('texto del botón principal (§10.2)', () => {
    const base = { previewFresh: true, errors: 0 };
    it('los 6 casos', () => {
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 2, toPay: 0, adjustOnly: 0 }).label).toBe('Generar 2');
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 0, toPay: 1, adjustOnly: 0 }).label).toBe('Registrar pago');
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 0, toPay: 3, adjustOnly: 0 }).label).toBe('Registrar pago (3)');
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 2, toPay: 3, adjustOnly: 0 }).label).toBe('Generar 2 · Pagar 3');
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 0, toPay: 0, adjustOnly: 2 }).label).toBe('Guardar descuentos');
        expect(primaryButtonState({ ...base, mode: 'multi', toCreate: 17, toPay: 0, adjustOnly: 0 }).label).toBe('Generar 17');
    });
    it('deshabilitado con motivo: nada marcado, errores, vista previa vieja', () => {
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 0, toPay: 0, adjustOnly: 0 })).toMatchObject({ disabled: true, reason: expect.stringMatching(/Marca/) });
        expect(primaryButtonState({ ...base, errors: 1, mode: 'single', toCreate: 1, toPay: 0, adjustOnly: 0 })).toMatchObject({ disabled: true, reason: expect.stringMatching(/rojo/) });
        // La vista previa omitió el cobro (mes ya existente): el motivo lo dice en vez de «Marca un cobro…».
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 0, toPay: 0, adjustOnly: 0, skippedReasons: ['ya tiene la mensualidad de ese mes'] }))
            .toMatchObject({ disabled: true, reason: 'No hay nada que crear: ya tiene la mensualidad de ese mes.' });
        expect(primaryButtonState({ mode: 'multi', toCreate: 17, toPay: 0, adjustOnly: 0, previewFresh: false })).toMatchObject({ disabled: true, reason: expect.stringMatching(/vista previa/) });
        expect(primaryButtonState({ ...base, mode: 'single', toCreate: 1, toPay: 0, adjustOnly: 0, noAthlete: true })).toMatchObject({ disabled: true });
    });
});

describe('modo varios (§10.3, §15.7)', () => {
    it('mismo descuento a cada atleta; «para todos» es por línea, sin reparto', () => {
        const r = computeMulti({ lines: [line({ category: 'torneo', amount: 80_000, discount: pct(10) })], global: null, athletes: 17 });
        expect(r.lines[0].perAthlete).toBe(72_000);
        expect(r.total).toBe(72_000 * 17);
        expect(r.listTotal).toBe(80_000 * 17);
        const r2 = computeMulti({ lines: [line({ category: 'torneo', amount: 80_000 })], global: global(pesos(5_000)), athletes: 10 });
        expect(r2.lines[0].generalShare).toBe(5_000);
        expect(r2.total).toBe(750_000);
    });
    it('mensualidad sin monto fijo = el de cada atleta', () => {
        const r = computeMulti({ lines: [line({ category: 'mensualidad', amount: null, period: { year: 2026, month: 11 } })], global: null, athletes: 5 });
        expect(r.hasPerAthleteAmounts).toBe(true);
        expect(r.errors).toEqual([]);
    });
    it('sin «No cobrar» ni excedente en modo varios', () => {
        const r = computeMulti({ lines: [line({ category: 'excedente' }), line({ category: 'torneo', exonerate: { reason_text: 'Becado' } })], global: null, athletes: 3 });
        expect(r.errors.length).toBe(2);
    });
});

describe('cuerpo de la petición (§9.2)', () => {
    it('modo un atleta: pendientes con seen, pay_amount, cerrar con motivo y global con refs', () => {
        const oct = charge({ id: 'p-oct', amount: 650_700, list_amount: 723_000, discount_amount: 72_300 });
        const sep = charge({ id: 'p-sep', amount: 759_150, late_fee_amount: 36_150, status: 'overdue' });
        const pending = [
            sel(oct, { payAmount: 600_000, closeMode: 'cerrar', closeReason: { reason_code: 'cortesia', reason_text: '' }, inGlobal: false }),
            sel(sep, { waive: { enabled: true, value: null, reason_text: 'Condonación de mora' } }),
        ];
        const lines = [line({ category: 'torneo', concept: 'Copa Pony', amount: 80_000, pay: true })];
        const g = global(pct(5, 'varios_meses'));
        const calc = computeSingle({ pending, lines, global: g, paymentOn: true });
        const body = buildSingleRequest({
            athlete: { type: 'child', id: 'ath-1' }, newAthlete: null, pending, lines, global: g,
            payment: { method: 'cash', payment_date: '2026-10-10' }, calc,
        });
        expect(body.mode).toBe('single');
        expect(body.athletes).toEqual([{ type: 'child', id: 'ath-1' }]);
        expect(body.pending![0]).toMatchObject({
            payment_id: 'p-oct', seen: { amount: 650_700, amount_paid: 0 }, pay_amount: 600_000, close_mode: 'cerrar',
            discount: { basis: 'valor', value: 50_700, reason_code: 'cortesia' },
        });
        expect(body.pending![1]).toMatchObject({ payment_id: 'p-sep', waive_late_fee: { reason_text: 'Condonación de mora' }, close_mode: 'abono' });
        expect(body.pending![1].waive_late_fee).not.toHaveProperty('value');
        expect(body.global_discount).toMatchObject({ basis: 'porcentaje', value: 5, reason_code: 'varios_meses', line_refs: ['pending:p-sep', 'new:0'] });
        expect(body.lines[0]).toMatchObject({ category: 'torneo', amount: 80_000, concept: 'Copa Pony', pay_amount: expect.any(Number) });
        expect(body.payment).toEqual({ method: 'cash', payment_date: '2026-10-10' });
    });
    it('sin pagos no manda el bloque payment', () => {
        const lines = [line({ category: 'torneo', pay: false })];
        const calc = computeSingle({ pending: [], lines, global: null, paymentOn: false });
        const body = buildSingleRequest({ athlete: { type: 'adult', id: 'u1' }, newAthlete: null, pending: [], lines, global: null, payment: { method: 'cash', payment_date: '2026-10-10' }, calc });
        expect(body.payment).toBeUndefined();
        expect(body.lines[0].pay_amount).toBe(0);
    });
    it('modo varios: sin pending ni payment; mensualidad sin amount', () => {
        const body = buildMultiRequest({
            target: { kind: 'team', ids: ['t1'] },
            athletes: [{ type: 'child', id: 'a' }, { type: 'adult', id: 'b' }],
            lines: [line({ category: 'mensualidad', amount: null, period: { year: 2026, month: 11 } })],
            global: null,
        });
        expect(body).not.toHaveProperty('pending');
        expect(body).not.toHaveProperty('payment');
        expect(body.lines[0]).not.toHaveProperty('amount');
        expect(body.lines[0]).not.toHaveProperty('pay_amount');
        expect(body.lines[0].period).toEqual({ year: 2026, month: 11 });
    });
});

describe('vista previa: debounce, dedupe y reintento tras 429', () => {
    it('espera 1,5 s tras la última edición', () => {
        expect(PREVIEW_DEBOUNCE_MS).toBe(1500);
    });

    it('no repite la vista previa si el cuerpo es el vigente o el que ya va en camino', () => {
        expect(shouldRequestPreview(null, null, null)).toBe(false);
        expect(shouldRequestPreview('A', null, null)).toBe(true);
        expect(shouldRequestPreview('A', 'A', null)).toBe(false);
        expect(shouldRequestPreview('A', null, 'A')).toBe(false);
        expect(shouldRequestPreview('B', 'A', null)).toBe(true);
        expect(shouldRequestPreview('B', 'A', 'C')).toBe(true);
    });

    it('reintento: Retry-After acotado entre 1 y 60 s; 3 s si no vino', () => {
        expect(rateLimitRetryDelayMs(undefined)).toBe(3000);
        expect(rateLimitRetryDelayMs(null)).toBe(3000);
        expect(rateLimitRetryDelayMs(0)).toBe(1000);
        expect(rateLimitRetryDelayMs(12)).toBe(12000);
        expect(rateLimitRetryDelayMs(3600)).toBe(60000);
        expect(rateLimitRetryDelayMs(Number.NaN)).toBe(3000);
    });
});

describe('horas adicionales vendidas por adelantado', () => {
    const venta = (over: Partial<NewLineDraft> = {}) =>
        line({ category: 'excedente', extra_hours: 2, enrollment_id: 'enr-1', amount: 30_625, concept: conceptoHorasAdicionales(2), ...over });
    const errores = (l: NewLineDraft) => {
        const c = computeSingle({ pending: [], lines: [l], global: null, paymentOn: true });
        return (c.lines.find((x) => x.ref === 'new:0') as { errors: string[] } | undefined)?.errors ?? [];
    };

    it('helpers: formato es-CO, concepto, monto y pasos de 15 minutos con tope', () => {
        expect(formatHoras(2)).toBe('2');
        expect(formatHoras(1.5)).toBe('1,5');
        expect(conceptoHorasAdicionales(1.25)).toBe('Horas adicionales · 1,25 h');
        expect(montoDeHoras(2, 15_312.5)).toBe(30_625);
        expect(montoDeHoras(1, 32_250)).toBe(32_250);
        expect(montoDeHoras(2, null)).toBeNull();
        expect(montoDeHoras(0, 100)).toBeNull();
        expect(pasoDeHoras(1, 1)).toBe(2);
        expect(pasoDeHoras(1, -1)).toBe(0.25);   // no baja de 15 min
        expect(pasoDeHoras(24, 1)).toBe(24);     // no pasa de 24 h
    });
    it('una venta completa (horas + inscripción + valor) no tiene errores', () => {
        expect(errores(venta())).toEqual([]);
    });
    it('sin inscripción, con horas inválidas o sin ninguna fuente, avisa', () => {
        expect(errores(venta({ enrollment_id: null })).join(' ')).toContain('cuál inscripción');
        expect(errores(venta({ extra_hours: 1.1 })).join(' ')).toContain('15 minutos');
        expect(errores(venta({ extra_hours: 0 })).join(' ')).toContain('cuántas horas');
        expect(errores(venta({ extra_hours: 30 })).join(' ')).toContain('24');
        expect(errores(line({ category: 'excedente', amount: 5_000, concept: 'Horas adicionales' })).join(' ')).toContain('ya las usó');
    });
    it('sin elegir «Ya las usó» / «Por adelantado» no se puede confirmar', () => {
        const e = errores(line({ category: 'excedente', amount: 30_000, concept: 'Hora adicional consumida', horas_modo: null }));
        expect(e.join(' ')).toContain('Elige si las horas ya las usó');
    });
    it('las horas se venden pagadas: sin «Ya lo pagaron» o con «Pagar» desmarcado avisa', () => {
        expect(errores(venta({ pay: false })).join(' ')).toContain('pagadas');
        const c = computeSingle({ pending: [], lines: [venta()], global: null, paymentOn: false });
        expect((c.lines.find((x) => x.ref === 'new:0') as { errors: string[] }).errors.join(' ')).toContain('pagadas');
        expect(errores(venta({ exonerate: { reason_text: 'beca' } })).join(' ')).toContain('pagadas');
    });
    it('un excedente con su período sigue sin errores de horas', () => {
        const e = errores(line({ category: 'excedente', overage_charge_id: 'ov-1', amount: 50_000, concept: 'Horas adicionales sept' }));
        expect(e.join(' ')).not.toContain('horas se vendieron');
        expect(e).toEqual([]);
    });
    it('el payload lleva extra_hours y enrollment_id; el excedente no', () => {
        const lines = [venta()];
        const calc = computeSingle({ pending: [], lines, global: null, paymentOn: true });
        const body = buildSingleRequest({ athlete: { type: 'child', id: 'a' }, newAthlete: null, pending: [], lines, global: null, payment: { method: 'cash', payment_date: '2026-10-20' }, calc });
        expect(body.lines[0]).toMatchObject({ category: 'excedente', extra_hours: 2, enrollment_id: 'enr-1', amount: 30_625, concept: 'Horas adicionales · 2 h', pay_amount: 30_625 });
        const lines2 = [line({ category: 'excedente', overage_charge_id: 'ov-1', amount: 50_000, concept: 'Horas adicionales sept' })];
        const calc2 = computeSingle({ pending: [], lines: lines2, global: null, paymentOn: false });
        const body2 = buildSingleRequest({ athlete: { type: 'child', id: 'a' }, newAthlete: null, pending: [], lines: lines2, global: null, payment: null, calc: calc2 });
        expect(body2.lines[0]).toHaveProperty('overage_charge_id', 'ov-1');
        expect(body2.lines[0]).not.toHaveProperty('extra_hours');
    });
    describe('«Ya las usó» (caso Zoe: la hora ya se consumió, solo se cobra)', () => {
        const usadas = (over: Partial<NewLineDraft> = {}) =>
            line({ category: 'excedente', horas_modo: 'usadas', amount: 30_625, concept: 'Hora adicional consumida', ...over });
        const cuerpo = (l: NewLineDraft, paymentOn = false) => {
            const calc = computeSingle({ pending: [], lines: [l], global: null, paymentOn });
            return buildSingleRequest({
                athlete: { type: 'child', id: 'a' }, newAthlete: null, pending: [], lines: [l], global: null,
                payment: paymentOn ? { method: 'cash', payment_date: '2026-10-20' } : null, calc,
            });
        };

        it('sin período del banco es un cobro libre válido, sin exigir pago ni inscripción', () => {
            expect(errores(usadas({ pay: false }))).toEqual([]);
        });
        it('viaja como «Otro cobro»: sin extra_hours, sin enrollment_id y sin overage_charge_id', () => {
            const l = usadas({ enrollment_id: 'enr-1', extra_hours: 3 });
            const p = cuerpo(l, true).lines[0];
            expect(p).toMatchObject({ category: 'otro', amount: 30_625, concept: 'Hora adicional consumida' });
            expect(p).not.toHaveProperty('extra_hours');
            expect(p).not.toHaveProperty('enrollment_id');
            expect(p).not.toHaveProperty('overage_charge_id');
        });
        it('con el excedente del período sigue siendo «excedente» con su overage_charge_id (tampoco suma horas)', () => {
            const p = cuerpo(usadas({ overage_charge_id: 'ov-1', amount: 50_000, concept: 'Horas adicionales sept' })).lines[0];
            expect(p).toMatchObject({ category: 'excedente', overage_charge_id: 'ov-1' });
            expect(p).not.toHaveProperty('extra_hours');
        });
        it('«Por adelantado» sigue mandando excedente + extra_hours', () => {
            expect(cuerpo(venta({ horas_modo: 'adelantado' }), true).lines[0]).toMatchObject({ category: 'excedente', extra_hours: 2, enrollment_id: 'enr-1' });
        });
    });
    it('una línea que NO es horas adicionales nunca manda extra_hours, aunque el borrador lo arrastre', () => {
        const lines = [line({ category: 'torneo', extra_hours: 2, amount: 10_000 })];
        const calc = computeSingle({ pending: [], lines, global: null, paymentOn: false });
        const body = buildSingleRequest({ athlete: { type: 'child', id: 'a' }, newAthlete: null, pending: [], lines, global: null, payment: null, calc });
        expect(body.lines[0]).not.toHaveProperty('extra_hours');
    });
});
