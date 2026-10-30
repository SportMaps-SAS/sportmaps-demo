/**
 * Afiliado y precios de servicio (plan maestro §2 M2, Monster 2026-10-30):
 *  · Clínica: $250.000 afiliados; preventa $300.000; desde el 10-nov $350.000;
 *    se separa cupo con el 50 %.
 *  · Vacacional: afiliados $80k/$120k/$150k/$170k y externos $100k/$140k/$170k/$200k
 *    por 1, 2, 3 o 4 semanas.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        rpc: { data: null as any, error: null as any },
        rpcLlamadas: [] as any[],
        items: [] as any[],
        itemsError: null as any,
        selects: [] as string[],
    };
    function builder(table: string) {
        let cols = '';
        const b: any = {};
        b.select = (c: string) => { cols = c; state.selects.push(c); return b; };
        for (const m of ['eq', 'is', 'in', 'neq', 'order', 'limit']) b[m] = () => b;
        const correr = () => {
            if (table !== 'school_tournament_items') return { data: [], error: null };
            if (state.itemsError && cols.includes('precio_afiliado')) return { data: null, error: state.itemsError };
            return { data: state.items, error: null };
        };
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        b.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => builder(t),
            rpc: vi.fn(async (nombre: string, args: any) => { state.rpcLlamadas.push({ nombre, args }); return state.rpc; }),
        },
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./receipt-context.service', () => ({ buildVerdictContext: vi.fn(async () => ({})) }));

import { esAfiliado, afiliacionDesdeRespuesta } from './wa-afiliado.service';
import {
    precioVigente, abonoMinimo, preciosDeServicios, preciosDeMotivos, motivoPorMonto, opcionesDelItem,
    type ItemDeServicio,
} from './wa-cobro-desde-comprobante.service';

const CLINICA: ItemDeServicio = {
    id: 'clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-10', precio: 350000 }], abono_minimo_pct: 50, allow_installments: true,
    starts_at: '2026-11-21T13:00:00Z', ends_at: '2026-11-22T22:00:00Z',
};
const VACACIONAL: ItemDeServicio = {
    id: 'vac', name: 'Vacacional de voleibol', kind: 'vacacional', price: 100000,
    starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T16:00:00Z',
    opciones: [
        { clave: '1s', etiqueta: '1 semana', precio: 100000, precio_afiliado: 80000 },
        { clave: '2s', etiqueta: '2 semanas', precio: 140000, precio_afiliado: 120000 },
        { clave: '3s', etiqueta: '3 semanas', precio: 170000, precio_afiliado: 150000 },
        { clave: '4s', etiqueta: '4 semanas', precio: 200000, precio_afiliado: 170000 },
    ],
};
const OCT30 = Date.parse('2026-10-30T15:00:00Z');
const NOV10 = Date.parse('2026-11-10T15:00:00Z');

beforeEach(() => {
    h.state.rpc = { data: null, error: null };
    h.state.rpcLlamadas = [];
    h.state.items = [];
    h.state.itemsError = null;
    h.state.selects = [];
});

describe('esAfiliado (RPC wa_es_afiliado, solo precio y saludo)', () => {
    it('llama la RPC con el teléfono en dígitos y devuelve solo el primer nombre', async () => {
        h.state.rpc = { data: { afiliado: true, nombre: 'Carolina Gómez' }, error: null };
        expect(await esAfiliado('s1', '+57 319 450 5150')).toEqual({ afiliado: true, nombre: 'Carolina' });
        expect(h.state.rpcLlamadas[0]).toEqual({ nombre: 'wa_es_afiliado', args: { p_school_id: 's1', p_telefono: '573194505150' } });
    });

    it('formas de la respuesta; RPC sin aplicar o error → no afiliado (precio de lista)', async () => {
        expect(afiliacionDesdeRespuesta(true)).toEqual({ afiliado: true, nombre: null });
        expect(afiliacionDesdeRespuesta({ es_afiliado: true, primer_nombre: 'Ana' })).toEqual({ afiliado: true, nombre: 'Ana' });
        expect(afiliacionDesdeRespuesta({ afiliado: false, nombre: 'X' })).toEqual({ afiliado: false, nombre: null });
        expect(afiliacionDesdeRespuesta(null)).toEqual({ afiliado: false, nombre: null });
        h.state.rpc = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        expect(await esAfiliado('s1', '3194505150')).toEqual({ afiliado: false, nombre: null });
        expect(await esAfiliado('s1', '123')).toEqual({ afiliado: false, nombre: null });
    });
});

describe('precio de la clínica: afiliado, preventa, por fecha y abono del 50 %', () => {
    it('afiliado: $250.000 antes y después del 10-nov', () => {
        expect(precioVigente(CLINICA, { afiliado: true, hoy: '2026-10-30' })).toBe(250000);
        expect(precioVigente(CLINICA, { afiliado: true, hoy: '2026-11-15' })).toBe(250000);
    });

    it('externo: $300.000 en preventa y $350.000 desde el 10-nov (Bogotá)', () => {
        expect(precioVigente(CLINICA, { afiliado: false, hoy: '2026-11-09' })).toBe(300000);
        expect(precioVigente(CLINICA, { afiliado: false, hoy: '2026-11-10' })).toBe(350000);
    });

    it('abono: 50 % del precio vigente', () => {
        expect(abonoMinimo(300000, 50)).toBe(150000);
        expect(abonoMinimo(250000, 50)).toBe(125000);
        expect(abonoMinimo(300000, 100)).toBeNull();
        expect(abonoMinimo(300000, null)).toBeNull();
    });

    it('los precios que reconoce un comprobante: completo y abono', () => {
        const r = preciosDeServicios([CLINICA], { ahora: OCT30, afiliado: false });
        expect(r.map((p) => [p.monto, !!p.esAbono])).toEqual([[300000, false], [150000, true]]);
        expect(motivoPorMonto(150000, r)).toMatchObject({ tipo: 'uno', precio: { esAbono: true, fuenteId: 'clinica' } });
        expect(preciosDeServicios([CLINICA], { ahora: NOV10, afiliado: false }).map((p) => p.monto)).toEqual([350000, 175000]);
        expect(preciosDeServicios([CLINICA], { ahora: OCT30, afiliado: true }).map((p) => p.monto)).toEqual([250000, 125000]);
    });
});

describe('vacacional con opciones (semanas)', () => {
    it('un precio por opción, el de afiliado si corresponde', () => {
        expect(opcionesDelItem(VACACIONAL).map((o) => o.clave)).toEqual(['1s', '2s', '3s', '4s']);
        const ext = preciosDeServicios([VACACIONAL], { ahora: OCT30, afiliado: false });
        expect(ext.map((p) => [p.opcion, p.monto])).toEqual([['1s', 100000], ['2s', 140000], ['3s', 170000], ['4s', 200000]]);
        expect(ext[1].etiqueta).toBe('Vacacional de voleibol — 2 semanas');
        const afi = preciosDeServicios([VACACIONAL], { ahora: OCT30, afiliado: true });
        expect(afi.map((p) => p.monto)).toEqual([80000, 120000, 150000, 170000]);
        expect(motivoPorMonto(120000, afi)).toMatchObject({ tipo: 'uno', precio: { motivo: 'vacacional', opcion: '2s' } });
    });

    it('opciones rotas se ignoran; sin opciones, el precio del ítem', () => {
        expect(opcionesDelItem({ opciones: [{ etiqueta: 'sin clave' }, null, { clave: 'x', precio: 'abc' }] })).toEqual([
            { clave: 'x', etiqueta: 'x', precio: null, precio_afiliado: null },
        ]);
        expect(preciosDeServicios([{ ...VACACIONAL, opciones: 'no-es-lista' }], { ahora: OCT30 }).map((p) => p.monto)).toEqual([100000]);
    });
});

describe('preciosDeMotivos con servicios', () => {
    it('pregunta a la base si es afiliado SOLO si algún servicio tiene precio de afiliado', async () => {
        h.state.items = [CLINICA];
        h.state.rpc = { data: { afiliado: true }, error: null };
        const r = await preciosDeMotivos('s1', { leadId: 'l1' }, { motivos: ['clase_extra'], telefono: '573194505150', ahora: OCT30 });
        expect(r.map((p) => p.monto)).toEqual([250000, 125000]);
        expect(h.state.rpcLlamadas.map((c) => c.nombre)).toEqual(['wa_es_afiliado']);

        h.state.rpcLlamadas = [];
        h.state.items = [{ ...CLINICA, precio_afiliado: null }];
        await preciosDeMotivos('s1', { leadId: 'l1' }, { motivos: ['clase_extra'], telefono: '573194505150', ahora: OCT30 });
        expect(h.state.rpcLlamadas).toEqual([]);
    });

    it('sin las columnas nuevas (M2 sin aplicar): relee con las de siempre y cobra el precio de lista', async () => {
        h.state.items = [{ id: 'c', name: 'Clínica', kind: 'clase_extra', price: 300000, active: true, event_id: null, starts_at: '2026-11-21T13:00:00Z' }];
        h.state.itemsError = { code: '42703', message: 'column school_tournament_items.precio_afiliado does not exist' };
        const r = await preciosDeMotivos('s1', { leadId: 'l1' }, { motivos: ['clase_extra'], telefono: '573194505150', ahora: OCT30 });
        expect(r.map((p) => p.monto)).toEqual([300000]);
        expect(h.state.selects.filter((s) => s.includes('kind'))).toHaveLength(2);
    });
});

describe('abono: solo si el ítem admite cuotas (la base lo exige)', () => {
    it('sin allow_installments no se ofrece el abono', () => {
        const r = preciosDeServicios([{ ...CLINICA, allow_installments: false }], { ahora: OCT30, afiliado: false });
        expect(r.map((p) => p.monto)).toEqual([300000]);
        expect(abonoMinimo(299999, 50)).toBe(150000);
    });
});
