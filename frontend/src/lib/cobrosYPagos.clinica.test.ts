/**
 * Fila «Clínica Jorge Mesa — …» (category 'otro', cobro del adulto por user_id)
 * en el modal «Cobros y pagos»: se puede marcar y registrar el pago sin errores
 * en la línea, sin depender de team_id ni branch_id (la RPC los resuelve).
 */
import { describe, expect, it } from 'vitest';
import type { OpenCharge } from '@/lib/api/chargeBatches';
import { buildSingleRequest, computeSingle, newPendingDraft, pendingBlockReason } from './cobrosYPagos';
import { tipoDeCobro } from './tipoDeCobro';

const clinica: OpenCharge = {
    id: 'p-clinica',
    concept: 'Clínica Jorge Mesa — Carlos Martínez',
    payment_category: 'otro',
    status: 'pending',
    due_date: '2026-11-15',
    amount: 175_000,
    list_amount: 250_000,
    discount_amount: 75_000,
    late_fee_amount: 0,
    amount_paid: 0,
    early_payment_discount_applied: null,
    en_revision: false,
    pago_en_curso: false,
} as OpenCharge;

describe('cobro «Clínica» (otro) en el modal de Cobros y pagos', () => {
    it('se etiqueta como Clínica y no se bloquea', () => {
        expect(tipoDeCobro(clinica).clave).toBe('clinica');
        expect(pendingBlockReason(clinica)).toBeNull();
    });

    it('al marcarlo y registrar el pago no hay errores y paga los 175.000', () => {
        const r = computeSingle({
            pending: [{ charge: clinica, draft: { ...newPendingDraft(clinica.id, true) } }],
            lines: [], global: null, paymentOn: true,
        });
        expect(r.lines).toHaveLength(1);
        expect(r.lines[0].errors).toEqual([]);
        expect(r.lines[0].category).toBe('otro');
        expect(r.toPay.total).toBe(175_000);
    });

    it('el pedido al servidor lleva al atleta adulto como user, sin team_id ni branch_id', () => {
        const calc = computeSingle({
            pending: [{ charge: clinica, draft: { ...newPendingDraft(clinica.id, true) } }],
            lines: [], global: null, paymentOn: true,
        });
        const body: any = buildSingleRequest({
            athlete: { type: 'adult', id: 'u1' },
            pending: [{ charge: clinica, draft: { ...newPendingDraft(clinica.id, true) } }],
            newAthlete: null, lines: [], global: null, calc, payment: { method: 'transfer' } as any,
        } as any);
        expect(JSON.stringify(body)).not.toMatch(/team_id|branch_id/);
        expect(JSON.stringify(body)).toContain('p-clinica');
    });
});
