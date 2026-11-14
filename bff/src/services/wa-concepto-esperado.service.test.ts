/**
 * Motivo esperado del próximo comprobante (plan B4 §3). Contra una tabla en
 * memoria con la misma forma que `whatsapp_conceptos_esperados`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = { filas: [] as any[], fallarLectura: false, inserts: [] as any[] };
    function builder(table: string) {
        const filtros: ((f: any) => boolean)[] = [];
        let accion: 'select' | 'update' | 'insert' = 'select';
        let valores: any = null;
        let devolverFilas = false;
        const b: any = {};
        b.select = () => { devolverFilas = true; return b; };
        b.eq = (c: string, v: any) => { filtros.push((f) => f[c] === v); return b; };
        b.is = (c: string, v: any) => { filtros.push((f) => (f[c] ?? null) === v); return b; };
        b.gt = (c: string, v: any) => { filtros.push((f) => String(f[c]) > String(v)); return b; };
        b.order = () => b;
        b.limit = () => b;
        b.update = (v: any) => { accion = 'update'; valores = v; return b; };
        b.insert = (v: any) => { accion = 'insert'; valores = v; return b; };
        const correr = () => {
            if (table !== 'whatsapp_conceptos_esperados') return { data: null, error: null };
            if (accion === 'insert') {
                const fila = { id: `e${state.filas.length + 1}`, consumido_at: null, created_at: new Date().toISOString(), ...valores };
                state.filas.push(fila);
                state.inserts.push(valores);
                return { data: null, error: null };
            }
            const coinciden = state.filas.filter((f) => filtros.every((p) => p(f)));
            if (accion === 'update') {
                for (const f of coinciden) Object.assign(f, valores);
                return { data: devolverFilas ? coinciden.map((f) => ({ id: f.id })) : null, error: null };
            }
            if (state.fallarLectura) return { data: null, error: { code: '42P01', message: 'relation does not exist' } };
            return { data: coinciden, error: null };
        };
        b.maybeSingle = () => {
            const r = correr();
            return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data });
        };
        b.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
        return b;
    }
    return { state, supabase: { from: (t: string) => builder(t) } };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));

import {
    registrarConceptoEsperado, conceptosEsperadosDe, consumirEsperado, elegirEsperado, telefonoDeEsperado,
    type ConceptoEsperado,
} from './wa-concepto-esperado.service';

const SCHOOL = 'school-1';

beforeEach(() => {
    h.state.filas = [];
    h.state.inserts = [];
    h.state.fallarLectura = false;
});

describe('registrarConceptoEsperado (contrato con B2)', () => {
    it('normaliza el teléfono a dígitos con 57 y vence en 24 h por defecto', async () => {
        const antes = Date.now();
        expect(await registrarConceptoEsperado(SCHOOL, '+57 319 450 5150', { motivo: 'clase_prueba', monto: 15000, leadId: 'lead-1' })).toBe(true);
        expect(h.state.filas).toHaveLength(1);
        const f = h.state.filas[0];
        expect(f).toMatchObject({ school_id: SCHOOL, telefono: '573194505150', motivo: 'clase_prueba', monto: 15000, signup_lead_id: 'lead-1', child_id: null, origen: 'clase_prueba' });
        const horas = (new Date(f.vence_en).getTime() - antes) / 3_600_000;
        expect(horas).toBeGreaterThan(23.9);
        expect(horas).toBeLessThan(24.1);
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'inscripcion', monto: 310000, childId: 'c1' })).toBe(true);
        expect(h.state.filas[1]).toMatchObject({ telefono: '573194505150', origen: 'bot', child_id: 'c1' });
    });

    it('motivo inválido, monto ≤ 0, dos dueños, teléfono corto o vencimiento pasado: no escribe', async () => {
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'evento', monto: 1000 })).toBe(false);
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'clase_prueba', monto: 0 })).toBe(false);
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'clase_prueba', leadId: 'l', childId: 'c' })).toBe(false);
        expect(await registrarConceptoEsperado(SCHOOL, '12345', { motivo: 'clase_prueba' })).toBe(false);
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'clase_prueba', venceEn: new Date(Date.now() - 1000) })).toBe(false);
        expect(h.state.filas).toHaveLength(0);
    });

    it('el mismo motivo y dueño sin consumir se ACTUALIZA, no se duplica', async () => {
        await registrarConceptoEsperado(SCHOOL, '573194505150', { motivo: 'clase_prueba', monto: 15000, leadId: 'lead-1' });
        await registrarConceptoEsperado(SCHOOL, '573194505150', { motivo: 'clase_prueba', monto: 20000, leadId: 'lead-1' });
        expect(h.state.filas).toHaveLength(1);
        expect(h.state.filas[0].monto).toBe(20000);
        // Otro dueño (hermano) u otro motivo: fila aparte.
        await registrarConceptoEsperado(SCHOOL, '573194505150', { motivo: 'clase_prueba', monto: 15000, leadId: 'lead-2' });
        await registrarConceptoEsperado(SCHOOL, '573194505150', { motivo: 'articulos', monto: 60000, leadId: 'lead-1' });
        expect(h.state.filas).toHaveLength(3);
    });

    it('uno VENCIDO sin consumir del mismo dueño se renueva (el índice único no admite otro)', async () => {
        h.state.filas = [{
            id: 'viejo', school_id: SCHOOL, telefono: '573194505150', motivo: 'clase_prueba', monto: 15000,
            signup_lead_id: 'lead-1', child_id: null, consumido_at: null, vence_en: new Date(Date.now() - 3600_000).toISOString(),
        }];
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'clase_prueba', monto: 15000, leadId: 'lead-1' })).toBe(true);
        expect(h.state.filas).toHaveLength(1);
        expect(new Date(h.state.filas[0].vence_en).getTime()).toBeGreaterThan(Date.now());
    });

    it('sin la tabla (migración sin aplicar): false, nunca lanza', async () => {
        h.state.fallarLectura = true;
        expect(await registrarConceptoEsperado(SCHOOL, '3194505150', { motivo: 'clase_prueba' })).toBe(false);
    });
});

describe('conceptosEsperadosDe y consumirEsperado', () => {
    it('solo los vivos: ni vencidos ni consumidos', async () => {
        const futuro = new Date(Date.now() + 3600_000).toISOString();
        h.state.filas = [
            { id: 'vivo', school_id: SCHOOL, telefono: '573194505150', motivo: 'clase_prueba', monto: 15000, signup_lead_id: 'l1', child_id: null, origen: 'clase_prueba', vence_en: futuro, consumido_at: null },
            { id: 'vencido', school_id: SCHOOL, telefono: '573194505150', motivo: 'inscripcion', monto: 310000, vence_en: new Date(Date.now() - 1000).toISOString(), consumido_at: null },
            { id: 'usado', school_id: SCHOOL, telefono: '573194505150', motivo: 'articulos', monto: 60000, vence_en: futuro, consumido_at: new Date().toISOString() },
            { id: 'otro-tel', school_id: SCHOOL, telefono: '573000000000', motivo: 'articulos', monto: 60000, vence_en: futuro, consumido_at: null },
        ];
        const vivos = await conceptosEsperadosDe(SCHOOL, '3194505150');
        expect(vivos.map((e) => e.id)).toEqual(['vivo']);
        expect(vivos[0]).toMatchObject({ motivo: 'clase_prueba', monto: 15000, leadId: 'l1', origen: 'clase_prueba' });
    });

    it('el consumo es único: el segundo pierde', async () => {
        h.state.filas = [{ id: 'e1', school_id: SCHOOL, telefono: '573194505150', motivo: 'clase_prueba', consumido_at: null }];
        expect(await consumirEsperado('e1', 'pay-1', 'q-1')).toBe(true);
        expect(h.state.filas[0]).toMatchObject({ payment_id: 'pay-1', queue_id: 'q-1' });
        expect(h.state.filas[0].consumido_at).toBeTruthy();
        expect(await consumirEsperado('e1', 'pay-2', 'q-2')).toBe(false);
        expect(h.state.filas[0].payment_id).toBe('pay-1');
    });
});

describe('elegirEsperado (pura)', () => {
    const E = (id: string, motivo: any, monto: number | null, extra: Partial<ConceptoEsperado> = {}): ConceptoEsperado => ({
        id, schoolId: SCHOOL, telefono: '573194505150', motivo, monto, leadId: null, childId: null, origen: 'bot',
        venceEn: '2099-01-01T00:00:00Z', createdAt: null, ...extra,
    });

    it('el del monto (±$1), o el único vivo', () => {
        const lista = [E('a', 'inscripcion', 310000), E('b', 'articulos', 60000)];
        expect(elegirEsperado(lista, 60000.5)?.id).toBe('b');
        expect(elegirEsperado(lista, 370000)).toBeNull();
        expect(elegirEsperado([E('a', 'clase_prueba', 15000)], 20000)?.id).toBe('a');
        expect(elegirEsperado([], 15000)).toBeNull();
    });

    it('hermanos: dos esperados iguales de distinto deportista → el motivo sin dueño', () => {
        const e = elegirEsperado([E('a', 'inscripcion', 310000, { childId: 'c1' }), E('b', 'inscripcion', 310000, { childId: 'c2' })], 310000);
        expect(e).toMatchObject({ motivo: 'inscripcion', childId: null });
        expect(elegirEsperado([E('a', 'inscripcion', 60000), E('b', 'articulos', 60000)], 60000)).toBeNull();
    });

    it('teléfono', () => {
        expect(telefonoDeEsperado('319 450 5150')).toBe('573194505150');
        expect(telefonoDeEsperado('+1 (305) 555-0101')).toBe('13055550101');
        expect(telefonoDeEsperado('abc')).toBeNull();
    });
});
