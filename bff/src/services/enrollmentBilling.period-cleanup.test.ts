import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cadena mínima de Supabase: select → eq... → in (resuelve filas); update → in → in (resuelve error).
const state: { rows: any[]; updated: string[][]; updateError: any } = { rows: [], updated: [], updateError: null };

vi.mock('../config/supabase', () => {
    const select = () => {
        const q: any = {
            eq: () => q,
            in: () => Promise.resolve({ data: state.rows, error: null }),
        };
        return q;
    };
    const update = () => ({
        in: (_col: string, ids: string[]) => {
            state.updated.push(ids);
            return { in: () => Promise.resolve({ error: state.updateError }) };
        },
    });
    return { supabase: { from: () => ({ select, update }) } };
});

import { cancelUnpaidPeriodCharges } from './enrollmentBilling';

const base = { schoolId: 's', athleteCol: 'child_id' as const, athleteId: 'c', startDate: '2026-10-21' };

describe('cancelUnpaidPeriodCharges', () => {
    beforeEach(() => { state.rows = []; state.updated = []; state.updateError = null; });

    it('anula el cobro vencido sin plan ligado y sin pagos (caso Hijo Pruebas)', async () => {
        state.rows = [{ id: 'a', amount_paid: 0, payment_category: 'mensualidad' }];
        const r = await cancelUnpaidPeriodCharges(base);
        expect(r).toEqual({ cancelled: 1, withPayments: 0 });
        expect(state.updated).toEqual([['a']]);
    });

    it('no toca un cobro con abono y lo reporta', async () => {
        state.rows = [{ id: 'a', amount_paid: 50000, payment_category: 'mensualidad' }];
        const r = await cancelUnpaidPeriodCharges(base);
        expect(r).toEqual({ cancelled: 0, withPayments: 1 });
        expect(state.updated).toEqual([]);
    });

    it('no toca inscripción, seguro ni excedente', async () => {
        state.rows = [
            { id: 'i', amount_paid: 0, payment_category: 'inscripcion' },
            { id: 's', amount_paid: 0, payment_category: 'seguro' },
            { id: 'e', amount_paid: 0, payment_category: 'excedente' },
            { id: 'm', amount_paid: null, payment_category: 'mensualidad' },
        ];
        const r = await cancelUnpaidPeriodCharges(base);
        expect(r.cancelled).toBe(1);
        expect(state.updated).toEqual([['m']]);
    });

    it('no toca torneo, artículos, viaje ni ningún cobro aparte (Monster, Copa Navidad 2026-11-18)', async () => {
        state.rows = [
            { id: 't', amount_paid: 0, payment_category: 'torneo' },
            { id: 'a', amount_paid: 0, payment_category: 'articulos' },
            { id: 'v', amount_paid: 0, payment_category: 'viaje' },
            { id: 'x', amount_paid: 0, payment_category: 'clase_extra' },
            { id: 'o', amount_paid: 0, payment_category: 'otro' },
            { id: 'n', amount_paid: 0, payment_category: null },
        ];
        const r = await cancelUnpaidPeriodCharges(base);
        expect(r.cancelled).toBe(1);
        expect(state.updated).toEqual([['n']]);
    });

    it('si falla la anulación no declara nada anulado', async () => {
        state.rows = [{ id: 'a', amount_paid: 0, payment_category: 'mensualidad' }];
        state.updateError = { message: 'boom' };
        const r = await cancelUnpaidPeriodCharges(base);
        expect(r.cancelled).toBe(0);
    });
});
