/**
 * Aviso de aprobación al adulto titular (2026-11-11): un atleta adulto con
 * cuenta propia tiene parent_id NULL y user_id = él. `sendApprovalEmail` solo
 * miraba parent_id, así que aprobar su comprobante no le llegaba por correo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { baseVacia, supabaseFalso, type BaseFalsa } from '../jobs/base-falsa.test-helpers';

const h = vi.hoisted(() => ({ db: null as any, correos: [] as any[], enviados: [] as any[] }));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (...a: any[]) => h.db.from(...a),
        rpc: (...a: any[]) => h.db.rpc(...a),
        storage: { from: (...a: any[]) => h.db.storage.from(...a) },
    },
}));
const OCR = {
    amount: 145000, currency: 'COP', date: new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10), time: '08:10',
    bank: 'Bancolombia', reference: 'M48217731', destination: null, destinationName: null, originName: 'Carlos',
    isReceipt: true, isTransactionList: false, missingFields: [],
};
vi.mock('./ocr.service', () => ({
    listConfiguredProviders: () => ['a', 'b'],
    extractReceiptWithFallback: async (providers: string[]) => ({ provider: providers[0], result: { ...OCR } }),
}));
vi.mock('./receipt-context.service', () => ({
    buildVerdictContext: async (_s: string, args: any) => ({ today: OCR.date, expectedAmount: args.expectedAmount ?? null }),
}));
vi.mock('./receipt-verdict', async (orig) => {
    const real = await orig<typeof import('./receipt-verdict')>();
    return { ...real, evaluarEvidenciaAutoAprobacion: () => ({ ok: true, faltas: [] }) };
});
vi.mock('./glosa.service', () => ({
    autoCreateGlosaFromReasons: async () => 'glosa1',
    maybeAutoCreateGlosa: async () => null,
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: async (m: any) => { h.enviados.push(m); return { success: true }; } } }));
vi.mock('../utils/emailTemplates', () => ({
    BrandedEmailTemplates: {
        paymentConfirmation: async (p: any) => { h.correos.push(p); return { subject: 's', html: 'h' }; },
    },
}));

import { evaluatePaymentReceipt } from './receipt-approval.service';

function escenario(pago: Record<string, any>): BaseFalsa {
    const base = baseVacia({
        payments: [{
            id: 'pay1', school_id: 's1', status: 'awaiting_approval', amount: 145000, amount_paid: 0,
            early_payment_discount_applied: null, receipt_url: 's1/pay1.jpg', receipt_image_sha256: null,
            parent_id: null, user_id: 'adulto1', child_id: null, team_id: null, concept: 'Clínica',
            ocr_reference: 'M48217731', receipt_verdict: 'verde', receipt_verdict_reasons: [], amount_source: 'servidor',
            ...pago,
        }],
        school_settings: [{ school_id: 's1', auto_approve_enabled: true, auto_approve_max_amount: 400000 }],
        profiles: [
            { id: 'padre1', full_name: 'Padre', email: 'padre@x.co' },
            { id: 'adulto1', full_name: 'Carlos', email: 'carlos@x.co' },
        ],
    });
    base.archivos['s1/pay1.jpg'] = new Uint8Array([1, 2, 3]);
    base.rpc.auto_approve_payment = () => ({ data: true });
    return base;
}

beforeEach(() => { h.correos = []; h.enviados = []; });

describe('aviso de aprobación', () => {
    it('cobro sin acudiente: el correo va al adulto titular (user_id)', async () => {
        h.db = supabaseFalso(escenario({}));
        const r = await evaluatePaymentReceipt('pay1');
        expect(r.action).toBe('approved');
        expect(h.enviados.map((m) => m.to)).toEqual(['carlos@x.co']);
        expect(h.correos[0].parentName).toBe('Carlos');
    });
    it('cobro con acudiente: sigue yendo al acudiente, no al user_id', async () => {
        h.db = supabaseFalso(escenario({ parent_id: 'padre1' }));
        await evaluatePaymentReceipt('pay1');
        expect(h.enviados.map((m) => m.to)).toEqual(['padre@x.co']);
    });
});
