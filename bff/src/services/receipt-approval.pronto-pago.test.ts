/**
 * Pronto pago en la aprobación automática (2026-11-08). Monster: 5 % hasta el
 * día 5. La familia transfiere $137.750 de un cobro de $145.000 con $7.250 de
 * pronto pago. Antes el veredicto comparaba contra `amount`: MONTO_DIFIERE →
 * glosa, y nunca se aprobaba solo. El correo de aprobación decía $145.000.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseVacia, supabaseFalso, type BaseFalsa } from '../jobs/base-falsa.test-helpers';

const h = vi.hoisted(() => ({
    db: null as any,
    contextos: [] as any[],
    glosas: [] as any[],
    correos: [] as any[],
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (...a: any[]) => h.db.from(...a),
        rpc: (...a: any[]) => h.db.rpc(...a),
        storage: { from: (...a: any[]) => h.db.storage.from(...a) },
    },
}));
const OCR = {
    amount: 137750, currency: 'COP', date: new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10), time: '08:10',
    bank: 'Bancolombia', reference: 'M48217730', destination: null, destinationName: null, originName: 'Carolina',
    isReceipt: true, isTransactionList: false, missingFields: [],
};
vi.mock('./ocr.service', () => ({
    listConfiguredProviders: () => ['a', 'b'],
    extractReceiptWithFallback: async (providers: string[]) => ({ provider: providers[0], result: { ...OCR } }),
}));
vi.mock('./receipt-context.service', () => ({
    buildVerdictContext: async (_school: string, args: any) => {
        h.contextos.push(args);
        return { today: OCR.date, expectedAmount: args.expectedAmount ?? null };
    },
}));
vi.mock('./receipt-verdict', async (orig) => {
    const real = await orig<typeof import('./receipt-verdict')>();
    // La evidencia (hora, destino exacto…) no es lo que se prueba acá: el
    // veredicto del MONTO sí corre de verdad (evaluateVerdict real).
    return { ...real, evaluarEvidenciaAutoAprobacion: () => ({ ok: true, faltas: [] }) };
});
vi.mock('./glosa.service', () => ({
    autoCreateGlosaFromReasons: async (_id: string, _s: string, reasons: any[]) => { h.glosas.push(reasons); return 'glosa1'; },
    maybeAutoCreateGlosa: async () => null,
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: async () => ({ success: true }) } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: {
        paymentConfirmation: async (p: any) => { h.correos.push(p); return { subject: 's', html: 'h' }; },
    },
}));

import { evaluatePaymentReceipt, montoEsperadoDelComprobante } from './receipt-approval.service';

function escenario(pago: Record<string, any>): BaseFalsa {
    const base = baseVacia({
        payments: [{
            id: 'pay1', school_id: 's1', status: 'awaiting_approval', amount: 145000, amount_paid: 0,
            early_payment_discount_applied: 7250, receipt_url: 's1/pay1.jpg', receipt_image_sha256: null,
            parent_id: 'padre1', child_id: 'hijo1', team_id: null, concept: 'Mensualidad noviembre 2026',
            ocr_reference: 'M48217730', receipt_verdict: 'verde', receipt_verdict_reasons: [], amount_source: 'servidor',
            ...pago,
        }],
        school_settings: [{ school_id: 's1', auto_approve_enabled: true, auto_approve_max_amount: 400000 }],
        profiles: [{ id: 'padre1', full_name: 'Carolina', email: 'c@x.co' }],
    });
    base.archivos['s1/pay1.jpg'] = new Uint8Array([1, 2, 3]);
    base.rpc.auto_approve_payment = () => ({ data: true });
    return base;
}

beforeEach(() => { h.contextos = []; h.glosas = []; h.correos = []; });

describe('montoEsperadoDelComprobante', () => {
    it('amount − amount_paid − pronto pago; sin saldo, amount', () => {
        expect(montoEsperadoDelComprobante({ amount: 145000, amount_paid: 0, early_payment_discount_applied: 7250 })).toBe(137750);
        expect(montoEsperadoDelComprobante({ amount: 145000, amount_paid: 50000, early_payment_discount_applied: null })).toBe(95000);
        expect(montoEsperadoDelComprobante({ amount: 145000 })).toBe(145000);
        expect(montoEsperadoDelComprobante({ amount: 145000, amount_paid: 145000 })).toBe(145000);
    });
});

describe('evaluatePaymentReceipt con pronto pago', () => {
    it('comprobante de $137.750 con $7.250 de pronto pago → verde y se aprueba solo; el correo dice $137.750', async () => {
        const base = escenario({});
        h.db = supabaseFalso(base);
        const r = await evaluatePaymentReceipt('pay1');
        expect(h.contextos[0].expectedAmount).toBe(137750);
        expect(r.action).toBe('approved');
        expect(h.glosas).toHaveLength(0);
        expect(base.llamadasRpc.map((c) => c.nombre)).toContain('auto_approve_payment');
        expect(h.correos[0].amount.replace(/[^\d]/g, '')).toBe('137750');
    });

    it('sin el pronto pago en la comparación saldría MONTO_DIFIERE (control: un cobro sin descuento)', async () => {
        h.db = supabaseFalso(escenario({ early_payment_discount_applied: null }));
        const r = await evaluatePaymentReceipt('pay1');
        expect(h.contextos[0].expectedAmount).toBe(145000);
        expect(r.action).toBe('glosa');
        expect(h.glosas[0].map((x: any) => x.code)).toContain('MONTO_DIFIERE');
    });
});
