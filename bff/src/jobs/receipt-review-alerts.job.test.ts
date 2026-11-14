/**
 * Avisos de comprobantes por validar (2026-10-08): nuevo agrupado, recordatorio
 * de >2 h como mucho cada 2 h, silencio de noche y reclamo por versión entre
 * los 3 BFF.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Resp = { data: any; error: any };
const llamadas: { tabla: string; op: string; args: any[] }[] = [];
let respuestas: Record<string, Resp[]> = {};

function builder(tabla: string) {
    let op = 'select';
    const b: any = {};
    const encadenar = (nombre: string) => (...args: any[]) => { llamadas.push({ tabla, op: nombre, args }); return b; };
    for (const m of ['select', 'eq', 'not', 'in', 'limit', 'maybeSingle']) b[m] = encadenar(m);
    b.update = (...args: any[]) => { op = 'update'; llamadas.push({ tabla, op: 'update', args }); return b; };
    b.insert = (...args: any[]) => { op = 'insert'; llamadas.push({ tabla, op: 'insert', args }); return b; };
    b.upsert = (...args: any[]) => { op = 'upsert'; llamadas.push({ tabla, op: 'upsert', args }); return b; };
    b.then = (ok: any, ko: any) => {
        const cola = respuestas[`${tabla}:${op}`] ?? [];
        const r = cola.length > 0 ? cola.shift() : { data: null, error: null };
        return Promise.resolve(r).then(ok, ko);
    };
    return b;
}

vi.mock('../config/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }));

import {
    planDeAvisos, enHorarioDeAvisos, formatoEspera, horaColombia, runReceiptReviewAlerts,
    RECORDATORIO_MS, type EstadoAlertas, type ComprobantePorValidar,
} from './receipt-review-alerts.job';

// 2026-10-08 15:00 Colombia = 20:00 UTC
const AHORA = Date.parse('2026-10-08T20:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

const estado = (o: Partial<EstadoAlertas> = {}): EstadoAlertas => ({
    school_id: 'S1', new_cursor: hace(60), last_new_alert_at: null, last_reminder_at: null, version: 3, ...o,
});
const comp = (id: string, minutos: number, o: Partial<ComprobantePorValidar> = {}): ComprobantePorValidar => ({
    id, school_id: 'S1', amount: 180000, amount_paid: 0, concept: 'Mensualidad 10/2026', receipt_verdict: 'verde',
    enviado_en: hace(minutos), ...o,
});

beforeEach(() => { llamadas.length = 0; respuestas = {}; });

describe('horario y formato', () => {
    it('hora Colombia y ventana 07:00–21:59', () => {
        expect(horaColombia(AHORA)).toBe(15);
        expect(enHorarioDeAvisos(AHORA)).toBe(true);
        expect(enHorarioDeAvisos(Date.parse('2026-10-09T03:30:00Z'))).toBe(false); // 22:30
        expect(enHorarioDeAvisos(Date.parse('2026-10-09T11:59:00Z'))).toBe(false); // 06:59
        expect(enHorarioDeAvisos(Date.parse('2026-10-09T12:00:00Z'))).toBe(true);  // 07:00
    });
    it('espera legible', () => {
        expect(formatoEspera(45 * 60_000)).toBe('45 min');
        expect(formatoEspera(3 * 3_600_000)).toBe('3 h');
        expect(formatoEspera(50 * 3_600_000)).toBe('2 días');
    });
});

describe('planDeAvisos', () => {
    it('sin comprobantes no avisa', () => {
        expect(planDeAvisos(estado(), [], AHORA).aviso).toBeNull();
    });

    it('uno nuevo → aviso nuevo y adelanta el cursor hasta él', () => {
        const p = planDeAvisos(estado(), [comp('a', 5)], AHORA);
        expect(p.aviso?.tipo).toBe('nuevo');
        expect(p.aviso?.mensaje).toContain('listo para aprobar');
        expect(p.patch.new_cursor).toBe(hace(5));
    });

    it('varios nuevos van en UN aviso con el total', () => {
        const p = planDeAvisos(estado(), [comp('a', 5), comp('b', 3, { receipt_verdict: 'amarillo' })], AHORA);
        expect(p.aviso?.titulo).toBe('2 comprobantes nuevos por validar');
        expect(p.aviso?.mensaje).toContain('1 en verde');
    });

    it('lo anterior al cursor no es nuevo', () => {
        expect(planDeAvisos(estado({ new_cursor: hace(1) }), [comp('a', 5)], AHORA).aviso).toBeNull();
    });

    it('un aviso de nuevos hace menos de 10 min → espera (agrupa)', () => {
        expect(planDeAvisos(estado({ last_new_alert_at: hace(4) }), [comp('a', 2)], AHORA).aviso).toBeNull();
    });

    it('>2 h sin revisar → recordatorio agrupado, que también absorbe los nuevos', () => {
        const p = planDeAvisos(estado(), [comp('viejo', 200), comp('nuevo', 5)], AHORA);
        expect(p.aviso?.tipo).toBe('recordatorio');
        expect(p.aviso?.titulo).toBe('1 comprobante lleva más de 2 h sin revisar');
        expect(p.aviso?.mensaje).toContain('hace 3 h');
        expect(p.aviso?.mensaje).toContain('2 por validar');
        expect(p.patch.last_reminder_at).toBe(new Date(AHORA).toISOString());
        expect(p.patch.new_cursor).toBe(hace(5));
    });

    it('máximo un recordatorio cada 2 h', () => {
        // Cumplió las 2 h hace 30 min: todavía no se había recordado.
        const lista = [comp('viejo', 150, { receipt_verdict: 'rojo' })];
        expect(planDeAvisos(estado({ last_reminder_at: hace(119) }), lista, AHORA).aviso).toBeNull();
        expect(planDeAvisos(estado({ last_reminder_at: hace(120) }), lista, AHORA).aviso?.tipo).toBe('recordatorio');
    });

    it('un recordatorio por comprobante: el que ya se recordó no vuelve a sonar (2026-10-29)', () => {
        // Cumplió las 2 h hace 180 min. Con un recordatorio hace 120 min ya entró en
        // ese: no se repite (antes sonaba cada 2 h, 16 veces en 4 días).
        const lista = [comp('viejo', 300, { receipt_verdict: 'rojo' })];
        expect(planDeAvisos(estado({ last_reminder_at: hace(120) }), lista, AHORA).aviso).toBeNull();
        expect(planDeAvisos(estado({ last_reminder_at: hace(600) }), lista, AHORA).aviso?.tipo).toBe('recordatorio');
    });

    it('con abonos cuenta el saldo, no el valor del cobro', () => {
        const p = planDeAvisos(estado(), [comp('a', 5, { amount_paid: 80000 })], AHORA);
        expect(p.aviso?.mensaje).toMatch(/100\.000/);
    });

    it('el umbral es exactamente 2 h', () => {
        expect(RECORDATORIO_MS).toBe(7_200_000);
    });
});

describe('runReceiptReviewAlerts', () => {
    const filaPago = {
        id: 'p1', school_id: 'S1', amount: 180000, amount_paid: null, concept: 'Mensualidad 10/2026',
        receipt_verdict: 'verde', receipt_submitted_at: hace(5), receipt_verdict_at: null, created_at: hace(9000),
    };

    it('de noche no consulta nada', async () => {
        const r = await runReceiptReviewAlerts(undefined, Date.parse('2026-10-09T04:00:00Z'));
        expect(r.avisos).toBe(0);
        expect(llamadas).toHaveLength(0);
    });

    it('sin la migración no avisa ni revienta', async () => {
        respuestas['payments:select'] = [{ data: null, error: { code: '42703', message: 'column receipt_submitted_at does not exist' } }];
        expect((await runReceiptReviewAlerts(undefined, AHORA)).avisos).toBe(0);
        expect(llamadas.some((l) => l.tabla === 'notifications')).toBe(false);
    });

    it('gana el reclamo → notifica a dueño y admins, una vez cada uno', async () => {
        respuestas['payments:select'] = [{ data: [filaPago], error: null }];
        respuestas['school_receipt_review_alerts:select'] = [{ data: [estado()], error: null }];
        respuestas['school_receipt_review_alerts:update'] = [{ data: [{ school_id: 'S1' }], error: null }];
        respuestas['schools:select'] = [{ data: { owner_id: 'U1' }, error: null }];
        respuestas['school_members:select'] = [{ data: [{ profile_id: 'U1' }, { profile_id: 'U2' }], error: null }];
        const r = await runReceiptReviewAlerts(undefined, AHORA);
        expect(r.avisos).toBe(1);
        const upd = llamadas.find((l) => l.tabla === 'school_receipt_review_alerts' && l.op === 'update');
        expect(upd?.args[0].version).toBe(4);
        expect(llamadas.some((l) => l.tabla === 'school_receipt_review_alerts' && l.op === 'eq' && l.args[0] === 'version' && l.args[1] === 3)).toBe(true);
        const ins = llamadas.find((l) => l.tabla === 'notifications' && l.op === 'insert');
        expect(ins?.args[0].map((n: any) => n.user_id)).toEqual(['U1', 'U2']);
        expect(ins?.args[0][0]).toMatchObject({ category: 'payment', link: '/payments-automation?tab=recurrent' });
    });

    it('otro BFF ya reclamó (versión cambió) → no notifica', async () => {
        respuestas['payments:select'] = [{ data: [filaPago], error: null }];
        respuestas['school_receipt_review_alerts:select'] = [{ data: [estado()], error: null }];
        respuestas['school_receipt_review_alerts:update'] = [{ data: [], error: null }];
        const r = await runReceiptReviewAlerts(undefined, AHORA);
        expect(r.avisos).toBe(0);
        expect(llamadas.some((l) => l.tabla === 'notifications')).toBe(false);
    });

    it('escuela nueva: arranca con el cursor en ahora (lo viejo no sale como nuevo)', async () => {
        respuestas['payments:select'] = [{ data: [{ ...filaPago, receipt_submitted_at: hace(30) }], error: null }];
        respuestas['school_receipt_review_alerts:select'] = [
            { data: [], error: null },
            { data: [estado({ new_cursor: new Date(AHORA).toISOString(), version: 0 })], error: null },
        ];
        const r = await runReceiptReviewAlerts(undefined, AHORA);
        expect(r.avisos).toBe(0);
        const ups = llamadas.find((l) => l.op === 'upsert');
        expect(ups?.args[0]).toEqual([{ school_id: 'S1', new_cursor: new Date(AHORA).toISOString() }]);
        expect(ups?.args[1]).toMatchObject({ ignoreDuplicates: true });
    });
});
