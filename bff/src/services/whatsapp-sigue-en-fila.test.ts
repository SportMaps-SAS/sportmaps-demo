/**
 * «Sigue en fila» (B6): a las 2 h hábiles (lun–sáb 8–18 Bogotá) sin respuesta de
 * la escuela, el bot se lo confirma UNA vez a la familia. Solo escuelas con
 * `wa_temas_a_persona`; Dynasty (sin la lista) no cambia.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const db: { t: Record<string, any[]>; lecturas: string[]; respondio: boolean } = { t: {}, lecturas: [], respondio: false };
    const campo = (r: any, c: string) => {
        const m = c.match(/^payload->>(\w+)$/);
        return m ? (r.payload ?? {})[m[1]] ?? null : r[c];
    };
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        let op: 'select' | 'update' = 'select';
        let payload: any = null;
        let single = false;
        let head = false;
        let lim = Infinity;
        const resolver = () => {
            db.lecturas.push(`${op}:${tabla}`);
            const filas = db.t[tabla] ?? [];
            const sel = filas.filter((r) => filtros.every((f) => f(r)));
            if (op === 'update') { for (const r of sel) Object.assign(r, payload); return { data: sel.map((r) => ({ id: r.id })), error: null }; }
            if (head) return { data: null, count: sel.length, error: null };
            const pagina = sel.slice(0, lim);
            return { data: single ? (pagina[0] ?? null) : pagina, error: null };
        };
        const api: any = {
            select: (_c?: string, o?: any) => { if (o?.head) head = true; return api; },
            eq: (c: string, v: any) => { filtros.push((r) => campo(r, c) === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(campo(r, c))); return api; },
            is: (c: string, v: any) => { filtros.push((r) => (campo(r, c) ?? null) === v); return api; },
            not: (c: string, _o: string, v: any) => { filtros.push((r) => (campo(r, c) ?? null) !== v); return api; },
            gte: (c: string, v: any) => { filtros.push((r) => campo(r, c) >= v); return api; },
            lte: (c: string, v: any) => { filtros.push((r) => campo(r, c) <= v); return api; },
            order: () => api,
            limit: (n: number) => { lim = n; return api; },
            maybeSingle: () => { single = true; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return { db, supabase: { from: (t: string) => builder(t) } };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-escalaciones.service', () => ({ respondioUnaPersona: vi.fn(async () => h.db.respondio) }));

import { runSigueEnFila, tocaAvisar, TEXTO_SIGUE_EN_FILA, PASO_SIGUE_EN_FILA } from './whatsapp-sigue-en-fila.service';

const MONSTER = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
// Martes 3-nov-2026: 8:00 Bogotá = 13:00Z.
const PASADO = '2026-11-03T13:00:00.000Z';
const MARTES_1030 = new Date('2026-11-03T15:30:00Z').getTime();

function sembrar(o: { temas?: any; discreto?: string; creado?: string } = {}) {
    h.db.lecturas = [];
    h.db.respondio = false;
    h.db.t = {
        school_settings: [{ school_id: MONSTER, wa_modo_discreto: o.discreto ?? 'no', wa_temas_a_persona: o.temas === undefined ? ['salud'] : o.temas }],
        school_whatsapp_integrations: [{ id: 'int-m', school_id: MONSTER, status: 'active' }],
        whatsapp_conversations: [{ id: 'conv-1', contact_wa_id: '573001112233', status: 'open', tomada_por: null, tomada_hasta: null }],
        whatsapp_messages: [{
            id: 'msg-esc', conversation_id: 'conv-1', integration_id: 'int-m', direction: 'outbound',
            created_at: o.creado ?? PASADO, payload: { step: 'escalated', reason: 'salud' },
        }],
    };
}

describe('sigue en fila', () => {
    let enviados: any[];
    const enviar = async (_i: any, conversationId: string, contactWaId: string, texto: string, context: any) => {
        enviados.push({ conversationId, contactWaId, texto, context });
        h.db.t.whatsapp_messages.push({
            id: `out-${enviados.length}`, conversation_id: conversationId, integration_id: 'int-m', direction: 'outbound',
            created_at: new Date(MARTES_1030).toISOString(), payload: context,
        });
    };
    beforeEach(() => { enviados = []; });

    it('2 h hábiles cuentan solo lun–sáb de 8 a 18 (Bogotá)', () => {
        expect(tocaAvisar(PASADO, MARTES_1030)).toBe(true);                                      // 8:00 → 10:30
        expect(tocaAvisar(PASADO, new Date('2026-11-03T14:30:00Z').getTime())).toBe(false);      // 8:00 → 9:30
        // Sábado 17:00 → domingo 12:00: solo 1 h hábil (el domingo no cuenta).
        expect(tocaAvisar('2026-10-31T22:00:00Z', new Date('2026-11-01T17:00:00Z').getTime())).toBe(false);
        // Sábado 17:00 → lunes 9:00: 1 h del sábado + 1 h del lunes.
        expect(tocaAvisar('2026-10-31T22:00:00Z', new Date('2026-11-02T14:00:00Z').getTime())).toBe(true);
    });

    it('Monster: nadie contestó en 2 h hábiles → UNA confirmación a la familia; el segundo tick no repite', async () => {
        sembrar();
        const r = await runSigueEnFila(MARTES_1030, { enviar });
        expect(r).toMatchObject({ escuelas: 1, revisadas: 1, avisados: 1 });
        expect(enviados).toEqual([{
            conversationId: 'conv-1', contactWaId: '573001112233', texto: TEXTO_SIGUE_EN_FILA,
            context: { step: PASO_SIGUE_EN_FILA, escalacion_id: 'msg-esc' },
        }]);
        expect(h.db.t.whatsapp_messages[0].payload).toMatchObject({ sigue_en_fila: 'avisada' });
        const r2 = await runSigueEnFila(MARTES_1030 + 15 * 60_000, { enviar });
        expect(r2.avisados).toBe(0);
        expect(enviados).toHaveLength(1);
    });

    it('si una persona de la escuela ya contestó, no sale nada', async () => {
        sembrar();
        h.db.respondio = true;
        const r = await runSigueEnFila(MARTES_1030, { enviar });
        expect(r).toMatchObject({ avisados: 0, atendidas: 1 });
        expect(enviados).toHaveLength(0);
    });

    it('antes de las 2 h hábiles no sale ni se marca (se vuelve a mirar)', async () => {
        sembrar({ creado: '2026-11-03T14:00:00.000Z' }); // 9:00 → 10:30 = 90 min
        const r = await runSigueEnFila(MARTES_1030, { enviar });
        expect(r.avisados).toBe(0);
        expect(h.db.t.whatsapp_messages[0].payload.sigue_en_fila_at).toBeUndefined();
    });

    it('con el modo discreto de la escuela prendido no se le promete nada a la familia', async () => {
        sembrar({ discreto: 'si' });
        const r = await runSigueEnFila(MARTES_1030, { enviar });
        expect(r.avisados).toBe(0);
        expect(enviados).toHaveLength(0);
    });

    it('Dynasty igual: sin `wa_temas_a_persona` no se lee nada más ni se avisa', async () => {
        sembrar({ temas: null });
        const r = await runSigueEnFila(MARTES_1030, { enviar });
        expect(r).toEqual({ escuelas: 0, revisadas: 0, avisados: 0, atendidas: 0, errores: 0 });
        expect(h.db.lecturas).toEqual(['select:school_settings']);
        expect(enviados).toHaveLength(0);
    });
});
