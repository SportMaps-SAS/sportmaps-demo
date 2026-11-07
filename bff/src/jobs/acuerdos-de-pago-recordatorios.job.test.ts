/**
 * Recordatorios de cuotas de acuerdos de pago: solo cuotas que vencen hoy, al propio pagador,
 * con link interno, reclamo idempotente y ningún mensaje de mora.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Resp = { data: any; error: any };
const llamadas: { tabla: string; op: string; args: any[] }[] = [];
let respuestas: Record<string, Resp[]> = {};

function builder(tabla: string) {
    let op = 'select';
    const b: any = {};
    const enc = (n: string) => (...args: any[]) => { llamadas.push({ tabla, op: n, args }); return b; };
    for (const m of ['select', 'eq', 'is', 'in', 'limit']) b[m] = enc(m);
    b.update = (...a: any[]) => { op = 'update'; llamadas.push({ tabla, op: 'update', args: a }); return b; };
    b.insert = (...a: any[]) => { op = 'insert'; llamadas.push({ tabla, op: 'insert', args: a }); return b; };
    b.then = (ok: any, ko: any) => {
        const cola = respuestas[`${tabla}:${op}`] ?? [];
        const r = cola.length > 0 ? cola.shift()! : { data: null, error: null };
        return Promise.resolve(r).then(ok, ko);
    };
    return b;
}
vi.mock('../config/supabase', () => ({
    supabase: { from: (t: string) => builder(t), rpc: vi.fn(async () => ({ data: { items_vencidos: 2, acuerdos_incumplidos: 1 }, error: null })) },
    SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k',
}));

import {
    planearRecordatorios, textoRecordatorio, enHorarioDeAvisos, recordarEscuela, runAcuerdosRecordatorios,
    correrMantenimientoAcuerdos, type CuotaDeHoy,
} from './acuerdos-de-pago-recordatorios.job';

const HOY = '2026-11-06';
const AHORA = Date.parse('2026-11-06T15:00:00Z'); // 10:00 Colombia
const cuota = (o: Partial<CuotaDeHoy> = {}): CuotaDeHoy => ({
    id: 'I1', agreement_id: 'A1', school_id: 'S1', payer_profile_id: 'U1', seq: 2, amount: 50000, total: 3, due_date: HOY, ...o,
});

beforeEach(() => { llamadas.length = 0; respuestas = {}; });

describe('planearRecordatorios', () => {
    it('solo cuotas que vencen hoy y con pagador con cuenta; al propio pagador, link interno', () => {
        const rows = planearRecordatorios([
            cuota(), cuota({ id: 'I2', due_date: '2026-11-07' }), cuota({ id: 'I3', payer_profile_id: null }),
        ], HOY);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ user_id: 'U1', school_id: 'S1', type: 'payment', category: 'payment', link: '/my-payments' });
        expect(rows[0].link.startsWith('/')).toBe(true);
        expect(rows[0].data).toEqual({ agreement_id: 'A1', item_id: 'I1', seq: 2 });
    });
    it('el texto dice cuota y monto, y NUNCA habla de mora, deuda ni atraso', () => {
        const t = textoRecordatorio(cuota());
        expect(t.message).toMatch(/cuota 2 de 3/);
        expect(t.message).toMatch(/50\.000/);
        expect(`${t.title} ${t.message}`).not.toMatch(/mora|moros|deuda|atras|vencid|multa|recargo/i);
    });
    it('horario 07:00–20:59 Colombia', () => {
        expect(enHorarioDeAvisos(AHORA)).toBe(true);
        expect(enHorarioDeAvisos(Date.parse('2026-11-06T11:30:00Z'))).toBe(false); // 06:30
        expect(enHorarioDeAvisos(Date.parse('2026-11-07T02:00:00Z'))).toBe(false); // 21:00
    });
});

describe('recordarEscuela', () => {
    const fila = (id: string, o: any = {}) => ({
        id, agreement_id: 'A1', school_id: 'S1', payer_profile_id: 'U1', seq: 1, amount: 50000, due_date: HOY,
        payment_agreements: { status: 'activo', installments: 3 }, ...o,
    });
    it('un lote: lee, reclama y manda una notificación por cuota reclamada', async () => {
        respuestas['payment_agreement_items:select'] = [{ data: [fila('I1'), fila('I2', { payer_profile_id: 'U2' })], error: null }];
        respuestas['payment_agreement_items:update'] = [{ data: [{ id: 'I1' }], error: null }]; // otro BFF ganó I2
        const n = await recordarEscuela('S1', HOY);
        expect(n).toBe(1);
        const ins = llamadas.find((l) => l.tabla === 'notifications' && l.op === 'insert');
        expect(ins?.args[0]).toHaveLength(1);
        expect(ins?.args[0][0].user_id).toBe('U1');
        // sin N+1: una sola lectura de cuotas y un solo update
        expect(llamadas.filter((l) => l.tabla === 'payment_agreement_items' && l.op === 'select' && String(l.args[0]).startsWith('id,'))).toHaveLength(1);
        expect(llamadas.filter((l) => l.op === 'update')).toHaveLength(1);
        // solo cuotas pendientes de acuerdos activos del día
        expect(llamadas.some((l) => l.op === 'eq' && l.args[0] === 'payment_agreements.status' && l.args[1] === 'activo')).toBe(true);
        expect(llamadas.some((l) => l.op === 'eq' && l.args[0] === 'status' && l.args[1] === 'pendiente')).toBe(true);
    });
    it('sin cuotas hoy no reclama ni notifica', async () => {
        respuestas['payment_agreement_items:select'] = [{ data: [], error: null }];
        expect(await recordarEscuela('S1', HOY)).toBe(0);
        expect(llamadas.some((l) => l.op === 'update' || l.op === 'insert')).toBe(false);
    });
    it('si el INSERT falla devuelve el reclamo', async () => {
        respuestas['payment_agreement_items:select'] = [{ data: [fila('I1')], error: null }];
        respuestas['payment_agreement_items:update'] = [{ data: [{ id: 'I1' }], error: null }, { data: null, error: null }];
        respuestas['notifications:insert'] = [{ data: null, error: { message: 'boom' } }];
        expect(await recordarEscuela('S1', HOY, { warn: vi.fn() } as any)).toBe(0);
        const updates = llamadas.filter((l) => l.tabla === 'payment_agreement_items' && l.op === 'update');
        expect(updates).toHaveLength(2);
        expect(updates[1].args[0]).toEqual({ reminded_at: null });
    });
});

describe('run y mantenimiento', () => {
    it('solo recorre escuelas con el módulo prendido y respeta el horario', async () => {
        expect(await runAcuerdosRecordatorios(undefined, Date.parse('2026-11-06T11:30:00Z'))).toEqual({ avisos: 0, escuelas: 0 });
        expect(llamadas).toHaveLength(0);
        respuestas['school_settings:select'] = [{ data: [{ school_id: 'S1' }], error: null }];
        respuestas['payment_agreement_items:select'] = [{ data: [], error: null }];
        expect(await runAcuerdosRecordatorios(undefined, AHORA)).toEqual({ avisos: 0, escuelas: 1 });
        expect(llamadas.some((l) => l.tabla === 'school_settings' && l.op === 'eq' && l.args[0] === 'payment_agreements_enabled')).toBe(true);
    });
    it('mantenimiento llama expire_agreements una vez', async () => {
        expect(await correrMantenimientoAcuerdos()).toEqual({ items_vencidos: 2, acuerdos_incumplidos: 1 });
    });
});
