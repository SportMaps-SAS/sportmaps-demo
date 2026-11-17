import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
    filas: [] as Array<{ id: string; notes: string | null }>,
    selectError: null as unknown,
    updates: [] as Array<{ id: string; notes: string }>,
    updateError: null as unknown,
    filtros: [] as Array<[string, unknown]>,
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: () => ({
            select: () => {
                const q: any = {
                    in: (c: string, v: unknown) => { db.filtros.push([c, v]); return q; },
                    eq: (c: string, v: unknown) => { db.filtros.push([c, v]); return q; },
                    then: (res: (v: unknown) => unknown) => res({ data: db.filas, error: db.selectError }),
                };
                return q;
            },
            update: (patch: { notes: string }) => ({
                eq: (_c: string, id: string) => ({
                    eq: () => Promise.resolve((db.updates.push({ id, notes: patch.notes }), { error: db.updateError })),
                }),
            }),
        }),
    },
}));

const { verificarConstanciaDeRecibido, lineaRecibido, notasConRecibido, anotarRecibido, limpiarPor } = await import('./constancia-de-recibido');
const { CobrosError } = await import('./charge-batches.service');

const pago = (extra: Record<string, unknown> = {}) => ({ method: 'cash' as const, payment_date: '2026-11-11', received_by: 'Alejandra L.', ...extra });

beforeEach(() => {
    db.filas = []; db.selectError = null; db.updates = []; db.updateError = null; db.filtros = [];
});

describe('verificarConstanciaDeRecibido', () => {
    it('sin pago o con comprobante: no hace nada', () => {
        expect(() => verificarConstanciaDeRecibido({ payment: null })).not.toThrow();
        expect(() => verificarConstanciaDeRecibido({ payment: { method: 'transfer', payment_date: '2026-11-11', receipt_url: 'a/b.png' } })).not.toThrow();
    });
    it('sin comprobante y sin received_by: 422 RECIBIDO_POR_OBLIGATORIO', () => {
        try {
            verificarConstanciaDeRecibido({ payment: { method: 'cash', payment_date: '2026-11-11' } });
            throw new Error('debió lanzar');
        } catch (e) {
            expect(e).toBeInstanceOf(CobrosError);
            expect((e as InstanceType<typeof CobrosError>).status).toBe(422);
            expect((e as InstanceType<typeof CobrosError>).code).toBe('RECIBIDO_POR_OBLIGATORIO');
        }
    });
    it('con received_by válido pasa', () => {
        expect(() => verificarConstanciaDeRecibido({ payment: pago() })).not.toThrow();
    });
});

describe('formato de la línea', () => {
    it('prefijo estable y texto limpio', () => {
        expect(lineaRecibido(pago())).toBe('[Recibido: efectivo · 2026-11-11 · por Alejandra L.]');
        expect(lineaRecibido(pago({ method: 'transfer', received_by: 'Ana\n[x]' }))).toBe('[Recibido: transferencia · 2026-11-11 · por Ana x]');
        expect(limpiarPor(undefined)).toBe('');
    });
    it('antepone y no duplica', () => {
        const l = lineaRecibido(pago());
        expect(notasConRecibido(null, l)).toBe(l);
        expect(notasConRecibido('nota', l)).toBe(`${l}\nnota`);
        expect(notasConRecibido(`[Recibido: otro · x]\nnota`, l)).toBe(`${l}\nnota`);
    });
});

describe('anotarRecibido', () => {
    const data = { batch_id: 'b1', duplicated: false, paid_ids: ['p1'], partial_ids: ['p2'] };

    it('anota en los pagados y abonados del lote, conservando las notas', async () => {
        db.filas = [{ id: 'p1', notes: 'Hermano' }, { id: 'p2', notes: null }];
        expect(await anotarRecibido('s1', 'b1', data, pago())).toBe(true);
        expect(db.updates).toEqual([
            { id: 'p1', notes: '[Recibido: efectivo · 2026-11-11 · por Alejandra L.]\nHermano' },
            { id: 'p2', notes: '[Recibido: efectivo · 2026-11-11 · por Alejandra L.]' },
        ]);
        expect(db.filtros).toContainEqual(['school_id', 's1']);
        expect(db.filtros).toContainEqual(['charge_batch_id', 'b1']);
    });
    it('con comprobante, lote duplicado o sin ids: no toca nada', async () => {
        expect(await anotarRecibido('s1', 'b1', data, pago({ receipt_url: 'a/b.png' }))).toBe(true);
        expect(await anotarRecibido('s1', 'b1', { ...data, duplicated: true }, pago())).toBe(true);
        expect(await anotarRecibido('s1', 'b1', { batch_id: 'b1', paid_ids: [], partial_ids: [] }, pago())).toBe(true);
        expect(await anotarRecibido('s1', undefined, data, pago())).toBe(true);
        expect(db.updates).toHaveLength(0);
    });
    it('si falla la lectura o el update devuelve false sin lanzar', async () => {
        db.selectError = { message: 'x' };
        expect(await anotarRecibido('s1', 'b1', data, pago())).toBe(false);
        db.selectError = null; db.filas = [{ id: 'p1', notes: null }]; db.updateError = { message: 'y' };
        expect(await anotarRecibido('s1', 'b1', data, pago())).toBe(false);
    });
});
