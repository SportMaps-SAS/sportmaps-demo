/**
 * Aprobar un cobro SIN comprobante deja constancia (cómo, cuándo y quién lo
 * recibió): payment_method / payment_date reales y la línea `[Recibido: …]` al
 * inicio de notes, sin pisar las notas que ya tenía. Con comprobante nada cambia.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
    notas: null as string | null,
    updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/integrations/supabase/client', () => {
    function builder() {
        let cambios: Record<string, unknown> | null = null;
        const api: any = {
            update: (c: Record<string, unknown>) => { cambios = c; st.updates.push(c); return api; },
            eq: () => api,
            in: () => api,
            is: () => api,
            maybeSingle: () => Promise.resolve({ data: { notes: st.notas }, error: null }),
            select: (cols?: string) => (cols === 'notes'
                ? api
                : Promise.resolve({ data: [{ id: 'pay-1', payment_category: null }], error: null })),
            then: (ok: any, ko: any) => Promise.resolve({ data: null, error: null }).then(ok, ko),
        };
        return api;
    }
    return { supabase: { from: () => builder(), rpc: () => Promise.resolve({ data: null, error: null }) } };
});

const { approvePayment } = await import('@/lib/approvePayment');

const PAGO = { id: 'pay-1', amount: 100000, amount_paid: 0, concept: 'Mensualidad', child_id: 'kid-1', parent_id: 'par-1' };
const OPTS = { userId: 'admin-1', schoolId: 'esc-1', schoolName: 'Escuela', notify: false };
const RECIBIDO = { metodo: 'cash' as const, fecha: '2026-11-11', por: 'Alejandra L.' };

beforeEach(() => { st.notas = null; st.updates = []; });

describe('approvePayment — constancia de recibido sin comprobante', () => {
    it('con constancia: guarda método, fecha y la línea en notes', async () => {
        const r = await approvePayment(PAGO, { ...OPTS, recibido: RECIBIDO });
        expect(r.ok).toBe(true);
        const u = st.updates[0];
        expect(u).toMatchObject({
            status: 'paid',
            payment_method: 'cash',
            payment_channel: 'cash',
            payment_date: '2026-11-11',
            approved_by: 'admin-1',
            notes: '[Recibido: efectivo · 2026-11-11 · por Alejandra L.]',
        });
    });

    it('conserva las notas que ya tenía el cobro', async () => {
        st.notas = 'Hermano de Sofía';
        await approvePayment(PAGO, { ...OPTS, recibido: { ...RECIBIDO, metodo: 'other' } });
        expect(st.updates[0].notes).toBe('[Recibido: otro medio · 2026-11-11 · por Alejandra L.]\nHermano de Sofía');
        expect(st.updates[0]).toMatchObject({ payment_method: 'other', payment_channel: 'manual' });
    });

    it('sin constancia (aprobación con comprobante): no toca notes ni la fecha de hoy', async () => {
        await approvePayment({ ...PAGO, payment_method: 'transfer' }, OPTS);
        const u = st.updates[0];
        expect('notes' in u).toBe(false);
        expect(u.payment_method).toBe('transfer');
        expect(typeof u.payment_date).toBe('string');
    });
});
