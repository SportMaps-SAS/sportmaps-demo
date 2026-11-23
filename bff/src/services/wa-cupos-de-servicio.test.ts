/**
 * Monster 2026-11-22: «si se llegan a 40 inscritos se cierra» el vacacional. El cupo (`capacity`) solo lo miraba la
 * RPC del carril B; la venta por comprobante no lo contaba. Acá: cuántos inscritos hay (cobros vivos enlazados al
 * ítem + los de la categoría registrados a mano), cuándo se cierra la venta y qué se le dice a quien llega tarde.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        sueltos: [] as { payment_id: string }[],
        deComprobante: [] as { payment_id: string }[],
        manuales: [] as { payment_id: string }[],
        pagos: [] as { id: string; status: string; payment_category?: string; created_at?: string }[],
        itemsDelTipo: [{ id: 'vac' }] as { id: string }[],
        items: [] as any[],
        falla: null as string | null,
        lecturas: [] as string[],
    };
    function resolver(table: string, ops: [string, any[]][]) {
        state.lecturas.push(table);
        if (state.falla === table) return { data: null, error: { message: 'boom' } };
        if (table === 'wa_cobros_sueltos') return { data: state.sueltos, error: null };
        if (table === 'wa_cobros_desde_comprobante') return { data: state.deComprobante, error: null };
        if (table === 'cobros_servicio_item') return { data: state.manuales, error: null };
        if (table === 'school_tournament_items') {
            // La lectura del conteo pide solo `id`; la del catálogo pide las columnas del ítem.
            const sel = String(ops.find(([m]) => m === 'select')?.[1]?.[0] ?? '');
            return { data: sel === 'id' ? state.itemsDelTipo : state.items, error: null };
        }
        if (table === 'payments') {
            let filas = [...state.pagos];
            for (const [m, a] of ops) {
                if (m === 'in' && a[0] === 'id') filas = filas.filter((p) => (a[1] as string[]).includes(p.id));
                if (m === 'in' && a[0] === 'status') filas = filas.filter((p) => (a[1] as string[]).includes(p.status));
                if (m === 'eq' && a[0] === 'payment_category') filas = filas.filter((p) => p.payment_category === a[1]);
                if (m === 'gte' && a[0] === 'created_at') filas = filas.filter((p) => String(p.created_at ?? '') >= String(a[1]));
            }
            return { data: filas.map((p) => ({ id: p.id })), error: null };
        }
        return { data: [], error: null };
    }
    function builder(table: string) {
        const ops: [string, any[]][] = [];
        const b: any = new Proxy({}, {
            get(_t, prop: string) {
                if (prop === 'then') return (ok: any, ko: any) => Promise.resolve(resolver(table, ops)).then(ok, ko);
                return (...args: any[]) => { ops.push([prop, args]); return b; };
            },
        });
        return b;
    }
    return { state, builder };
});

vi.mock('../config/supabase', () => ({ supabase: { from: (t: string) => h.builder(t) } }));

import {
    cupoDelItem, cuposLlenos, inscritosDelItem, limpiarCacheDeCupos, marcarCuposLlenos,
} from './wa-cupos-de-servicio.service';
import { serviciosDeAnuncio, textoVentaCerrada, ventaCerradaDeItem } from './whatsapp-anuncio-destino';

const VAC = {
    id: 'vac', name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true, event_id: null,
    starts_at: '2026-11-17T08:00:00-05:00', ends_at: '2026-12-11T11:00:00-05:00', capacity: 40, created_at: '2026-10-30T17:26:57-05:00',
};
const AHORA = new Date('2026-11-22T12:00:00-05:00').getTime();
const pagos = (n: number, prefijo: string, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefijo}${i}`, status: 'paid', ...extra }));

beforeEach(() => {
    limpiarCacheDeCupos();
    Object.assign(h.state, {
        sueltos: [], deComprobante: [], manuales: [], pagos: [], itemsDelTipo: [{ id: 'vac' }], items: [], falla: null, lecturas: [],
    });
});

describe('lo puro', () => {
    it('cupoDelItem: entero mayor que cero, o sin límite', () => {
        expect(cupoDelItem({ capacity: 40 })).toBe(40);
        for (const c of [null, undefined, 0, -3, 2.5]) expect(cupoDelItem({ capacity: c as any })).toBeNull();
    });
    it('cuposLlenos: lleno al llegar; sin cupo o sin conteo, nunca', () => {
        expect(cuposLlenos(40, 39)).toBe(false);
        expect(cuposLlenos(40, 40)).toBe(true);
        expect(cuposLlenos(40, 41)).toBe(true);
        expect(cuposLlenos(null, 500)).toBe(false);
        expect(cuposLlenos(40, null)).toBe(false);
    });
});

describe('inscritosDelItem', () => {
    it('Monster el 22-nov: 10 enlazados + 3 a mano por categoría = 13, sin repetir', async () => {
        const enlazados = pagos(10, 'e', { payment_category: 'vacacional', created_at: '2026-11-16T10:00:00-05:00' });
        const aMano = pagos(3, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        h.state.deComprobante = enlazados.slice(0, 8).map((p) => ({ payment_id: p.id }));
        h.state.manuales = enlazados.slice(6).map((p) => ({ payment_id: p.id })); // dos se repiten en las dos fuentes
        h.state.pagos = [...enlazados, ...aMano];
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBe(13);
    });
    it('un cobro anulado o rechazado no ocupa cupo', async () => {
        h.state.deComprobante = [{ payment_id: 'a' }, { payment_id: 'b' }, { payment_id: 'c' }];
        h.state.pagos = [
            { id: 'a', status: 'paid' }, { id: 'b', status: 'cancelled' }, { id: 'c', status: 'awaiting_approval' },
            { id: 'd', status: 'rejected', payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' },
        ];
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBe(2);
    });
    it('un cobro de la categoría ANTERIOR al ítem (otro vacacional, otro año) no cuenta', async () => {
        h.state.pagos = [
            { id: 'viejo', status: 'paid', payment_category: 'vacacional', created_at: '2025-12-01T10:00:00-05:00' },
            { id: 'nuevo', status: 'paid', payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' },
        ];
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBe(1);
    });
    it('con DOS servicios activos del mismo tipo la categoría sola no dice de cuál es: solo los enlazados', async () => {
        h.state.itemsDelTipo = [{ id: 'vac' }, { id: 'vac-norte' }];
        h.state.deComprobante = [{ payment_id: 'e0' }];
        h.state.pagos = [...pagos(1, 'e'), ...pagos(5, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' })];
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBe(1);
    });
    it('una clínica (clase_extra) no tiene categoría propia: solo los enlazados', async () => {
        h.state.manuales = [{ payment_id: 'e0' }];
        h.state.pagos = [...pagos(1, 'e'), ...pagos(4, 'x', { payment_category: 'clase_extra', created_at: '2026-11-18T10:00:00-05:00' })];
        expect(await inscritosDelItem('s1', { ...VAC, id: 'cli', kind: 'clase_extra' }, AHORA)).toBe(1);
    });
    it('si la lectura falla devuelve null (la venta NO se cierra por un error)', async () => {
        h.state.falla = 'cobros_servicio_item';
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBeNull();
        expect(cuposLlenos(40, null)).toBe(false);
    });
    it('una lectura por ítem cada 60 s', async () => {
        h.state.pagos = pagos(2, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        expect(await inscritosDelItem('s1', VAC, AHORA)).toBe(2);
        const lecturas = h.state.lecturas.length;
        h.state.pagos = pagos(9, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        expect(await inscritosDelItem('s1', VAC, AHORA + 30_000)).toBe(2);
        expect(h.state.lecturas.length).toBe(lecturas);
        expect(await inscritosDelItem('s1', VAC, AHORA + 61_000)).toBe(9);
    });
});

describe('marcarCuposLlenos', () => {
    it('un ítem sin cupo no hace ninguna lectura ni se marca', async () => {
        const [it] = await marcarCuposLlenos('s1', [{ ...VAC, capacity: null }], AHORA);
        expect((it as any).cupos_llenos).toBeUndefined();
        expect(h.state.lecturas).toEqual([]);
    });
    it('39 de 40: abierto · 40 de 40: lleno', async () => {
        h.state.pagos = pagos(39, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        expect((await marcarCuposLlenos('s1', [{ ...VAC }], AHORA))[0].cupos_llenos).toBe(false);
        limpiarCacheDeCupos();
        h.state.pagos = pagos(40, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        expect((await marcarCuposLlenos('s1', [{ ...VAC }], AHORA))[0].cupos_llenos).toBe(true);
    });
});

describe('la venta se cierra sola al llenarse', () => {
    it('ventaCerradaDeItem: un vacacional lleno cierra; uno con cupo, no (ni por haber empezado)', () => {
        expect(ventaCerradaDeItem({ ...VAC, cupos_llenos: true }, AHORA, '')).toBe(true);
        expect(ventaCerradaDeItem({ ...VAC, cupos_llenos: false }, AHORA, '')).toBe(false);
        expect(ventaCerradaDeItem({ ...VAC }, AHORA, '')).toBe(false);
    });
    it('el catálogo de las superficies de VENTA lo saca al llenarse; el de comprobantes y saldos lo conserva', async () => {
        h.state.items = [{ ...VAC }];
        h.state.pagos = pagos(40, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        expect(await serviciosDeAnuncio('s1', AHORA, { ventaAbierta: true })).toEqual([]);
        const todos = await serviciosDeAnuncio('s1', AHORA);
        expect(todos.map((i) => i.id)).toEqual(['vac']);
        expect(todos[0].cupos_llenos).toBe(true);
    });
    it('con 13 inscritos sigue en venta', async () => {
        h.state.items = [{ ...VAC }];
        h.state.pagos = pagos(13, 'm', { payment_category: 'vacacional', created_at: '2026-11-18T10:00:00-05:00' });
        const abiertos = await serviciosDeAnuncio('s1', AHORA, { ventaAbierta: true });
        expect(abiertos.map((i) => i.id)).toEqual(['vac']);
    });
    it('el mensaje dice cupos completos, ofrece lista de espera y no ofrece pagar; a quien ya pagó le pide el comprobante', () => {
        const t = textoVentaCerrada({ name: VAC.name, cupos_llenos: true });
        expect(t).toMatch(/cupos .* ya se completaron/i);
        expect(t).toMatch(/lista de espera/i);
        expect(t).toMatch(/Si ya pagaste/i);
        expect(t).not.toMatch(/\$|Nequi|Daviplata|abonaste/i);
    });
    it('el cierre por fecha de la clínica sigue con su texto de siempre', () => {
        expect(textoVentaCerrada({ name: 'Torneo relámpago' })).toMatch(/ya cerraron/);
    });
});
