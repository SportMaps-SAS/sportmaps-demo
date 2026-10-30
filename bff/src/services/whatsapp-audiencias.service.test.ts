/**
 * Audiencia de campañas (plan B5 T2): el clasificador puro (clase de prueba en
 * Suba, matrícula, clínica, saludo, sin intención, dos sedes) y la pasada con
 * base (exclusiones, simulación sin escribir, incremental, sin ajustes = una
 * lectura). Base en memoria; nada de la base viva.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    rpc: {} as Record<string, (args: any) => { data: any; error: any }>,
    llamadas: [] as { tabla: string; op: string }[],
    upserts: 0,
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        let op: 'select' | 'upsert' | 'update' = 'select';
        let payload: any = null;
        let single = false;
        let rango: [number, number] | null = null;
        let onConflict = '';
        const resolver = () => {
            db.llamadas.push({ tabla, op });
            const filas = (db.t[tabla] ??= []);
            if (op === 'upsert') {
                db.upserts++;
                const claves = onConflict.split(',');
                for (const p of payload) {
                    const previa = filas.find((r) => claves.every((k) => r[k] === p[k]));
                    if (previa) Object.assign(previa, p); else filas.push({ ...p });
                }
                return { data: null, error: null };
            }
            const sel = filas.filter((r) => filtros.every((f) => f(r)));
            if (op === 'update') { for (const r of sel) Object.assign(r, payload); return { data: sel, error: null }; }
            const pagina = rango ? sel.slice(rango[0], rango[1] + 1) : sel;
            return { data: single ? (pagina[0] ?? null) : pagina.map((r) => ({ ...r })), error: null };
        };
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((r) => r[c] === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(r[c])); return api; },
            gte: (c: string, v: any) => { filtros.push((r) => r[c] != null && r[c] >= v); return api; },
            order: () => api,
            range: (a: number, b: number) => { rango = [a, b]; return api; },
            upsert: (p: any, o: any) => { op = 'upsert'; payload = p; onConflict = o.onConflict; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            maybeSingle: () => { single = true; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => Promise.resolve(db.rpc[fn]?.(args) ?? { data: null, error: null }),
        },
    };
});

import { clasificarConversacion, clasificarEscuela, entranteConIntencion, sedeDeTextos } from './whatsapp-audiencias.service';

const NORTE = '3a1c0b52-6f0e-4c35-9a52-0d0b2a3c4d01';
const SUBA = '7b2d1c63-7f1f-4d46-8b63-1e1c3b4d5e02';
const SEDES = [
    { branch_id: NORTE, palabras: ['norte', '201', 'La Enseñanza'] },
    { branch_id: SUBA, palabras: ['suba', '152', 'Pinar', 'Fesan', 'Lestonnac', 'Oxxo'] },
];

describe('clasificarConversacion (pura)', () => {
    it('clase de prueba en Suba', () => {
        expect(clasificarConversacion(['Hola buenas', 'Quisiera agendar una clase de prueba para mi hija en Suba'], [], SEDES))
            .toEqual({ intereses: ['clase_prueba'], branchId: SUBA, evidencia: 1 });
    });

    it('matrícula', () => {
        expect(clasificarConversacion(['Buenas tardes, ¿cómo hago para matricular a mi hijo?'], [], SEDES))
            .toMatchObject({ intereses: ['inscripcion'], branchId: null });
    });

    it('clínica (lo que el bot no reconocía) y vacacional', () => {
        expect(clasificarConversacion(['Info de la clínica de voleibol porfa'], [], SEDES)?.intereses).toEqual(['clinica']);
        expect(clasificarConversacion(['¿Tienen vacacional en diciembre?'], [], SEDES)?.intereses).toEqual(['clinica']);
        // «Ya pagué la clínica» es de una familia, no de un interesado.
        expect(entranteConIntencion('Ya pagué la clínica, te mando el comprobante')).toBe(false);
    });

    it('saludo o charla sin intención: no entra', () => {
        expect(clasificarConversacion(['Hola', 'Gracias 🙏', 'Ok'], [], SEDES)).toBeNull();
        expect(clasificarConversacion(['Mi hija tiene 14 años'], [], SEDES)).toBeNull();
        expect(clasificarConversacion([], ['Hola, ¿en qué te ayudo?'], SEDES)).toBeNull();
    });

    it('dos sedes nombradas (o ninguna) → sin sede; la escuela también la puede nombrar', () => {
        expect(sedeDeTextos(['¿Tienen en Suba o en el norte?'], SEDES)).toBeNull();
        expect(sedeDeTextos(['Hola'], SEDES)).toBeNull();
        expect(clasificarConversacion(['Quiero inscribir a mi hija'], ['Te esperamos en el Colegio La Enseñanza'], SEDES)?.branchId).toBe(NORTE);
        expect(sedeDeTextos(['Calle 152 con Pinar'], SEDES)).toBe(SUBA);
        // «201» no es «2010» (palabra entera).
        expect(sedeDeTextos(['nació en 2010'], SEDES)).toBeNull();
    });

    it('precio y horarios junto a la intención; «informacion» solo si no hay nada más', () => {
        expect(clasificarConversacion(['Quiero inscribir a mi hijo', '¿Cuál es el valor de la mensualidad y los horarios?'], [], [])?.intereses)
            .toEqual(['horarios', 'inscripcion', 'precio']);
        expect(clasificarConversacion(['Info por favor'], [], [])?.intereses).toEqual(['informacion']);
    });
});

// ─── Con base ────────────────────────────────────────────────────────────────

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const INTEG = 'integ-monster';
const AHORA = new Date('2026-11-03T15:00:00Z').getTime();
const hace = (dias: number) => new Date(AHORA - dias * 864e5).toISOString();

function sembrar() {
    const conv = (id: string, wa: string, extra: Record<string, any> = {}) => ({
        id, integration_id: INTEG, school_id: ESC, contact_wa_id: wa, contact_name: null, contact_kind: null,
        tambien_familia: false, last_inbound_at: hace(10), ...extra,
    });
    const msg = (conversation_id: string, text_body: string, extra: Record<string, any> = {}) => ({
        conversation_id, integration_id: INTEG, direction: 'inbound', type: 'text', text_body, ai_generated: false,
        wa_message_id: `wamid.${conversation_id}.${text_body.length}`, wa_timestamp: hace(12), ...extra,
    });
    db.t = {
        whatsapp_campanas_ajustes: [{
            school_id: ESC, habilitadas: true, base_consentimiento: 'contacto_previo_declarado', antiguedad_max_dias: 180,
            palabras_sede: SEDES,
        }],
        school_whatsapp_integrations: [{ id: INTEG, school_id: ESC, status: 'active' }],
        whatsapp_conversations: [
            conv('c-prospecto', '573001000001'),
            conv('c-familia', '573001000002'),
            conv('c-personal', '573001000003', { contact_kind: 'personal' }),
            conv('c-saludo', '573001000004'),
            conv('c-vieja', '573001000005', { last_inbound_at: hace(400) }),
            conv('c-dijo-no', '573001000006'),
        ],
        whatsapp_messages: [
            msg('c-prospecto', 'Buenas, quiero una clase de prueba para mi hija en Suba'),
            msg('c-familia', 'Hola, ¿la clínica tiene precio para afiliados?'),
            msg('c-personal', 'Info de la clínica para mi sobrina'),
            msg('c-saludo', 'Hola'),
            msg('c-vieja', 'Quiero inscribir a mi hijo', { wa_timestamp: hace(400) }),
            msg('c-dijo-no', 'Info de la clínica'),
            msg('c-prospecto', 'Te esperamos', { direction: 'outbound', ai_generated: true }),
        ],
        whatsapp_optins: [],
        whatsapp_audiencia: [{ integration_id: INTEG, contact_wa_id: '573001000006', excluido: 'no_interesa', clasificado_at: hace(30) }],
    };
    db.rpc.wa_audiencia_excluidos = ({ p_wa_ids }: any) => ({
        data: p_wa_ids.includes('573001000002') ? [{ contact_wa_id: '573001000002', motivo: 'familia' }] : [], error: null,
    });
}

beforeEach(() => { db.t = {}; db.rpc = {}; db.llamadas = []; db.upserts = 0; });

describe('clasificarEscuela', () => {
    it('sin ajustes: UNA lectura (los ajustes) y nada más', async () => {
        db.t = { whatsapp_campanas_ajustes: [] };
        const r = await clasificarEscuela(ESC, { aplicar: true, ahora: AHORA });
        expect(r.estado).toBe('apagado');
        expect(db.llamadas).toEqual([{ tabla: 'whatsapp_campanas_ajustes', op: 'select' }]);
    });

    it('con ajustes apagados tampoco lee mensajes', async () => {
        sembrar();
        db.t.whatsapp_campanas_ajustes[0].habilitadas = false;
        const r = await clasificarEscuela(ESC, { ahora: AHORA });
        expect(r.estado).toBe('apagado');
        expect(db.llamadas.some((l) => l.tabla === 'whatsapp_messages')).toBe(false);
    });

    it('simulación: cuenta y excluye, pero no escribe', async () => {
        sembrar();
        const r = await clasificarEscuela(ESC, { ahora: AHORA });
        expect(r).toMatchObject({
            estado: 'ok', aplicado: false, conversaciones: 5, candidatos: 4, vigentes: 1,
            porInteres: { clase_prueba: 1 }, porSede: { [SUBA]: 1 },
            excluidos: { familia: 1, marca_manual: 1, no_interesa: 1 },
        });
        expect(db.upserts).toBe(0);
        expect(r.muestra[0].telefono).toBe('+57 ••• ••• 0001');
    });

    it('aplicar: guarda vigentes y excluidos; «no me interesa» no se borra; el incremental no relee', async () => {
        sembrar();
        const r = await clasificarEscuela(ESC, { aplicar: true, ahora: AHORA });
        expect(r.guardados).toBe(4);
        const fila = (wa: string) => db.t.whatsapp_audiencia.find((f) => f.contact_wa_id === wa);
        expect(fila('573001000001')).toMatchObject({
            intereses: ['clase_prueba'], branch_id: SUBA, excluido: null, fuente: 'reglas', school_id: ESC,
            conversation_id: 'c-prospecto', evidencia_wa_message_id: expect.stringContaining('wamid.c-prospecto'),
        });
        expect(fila('573001000002')?.excluido).toBe('familia');
        expect(fila('573001000003')?.excluido).toBe('marca_manual');
        expect(fila('573001000006')?.excluido).toBe('no_interesa');
        expect(fila('573001000004')).toBeUndefined();

        // Sin mensajes nuevos: no se relee nada (ni el saludo, que no entró).
        db.llamadas = [];
        const r2 = await clasificarEscuela(ESC, { aplicar: true, ahora: AHORA + 60_000 });
        expect(r2.releidas).toBe(0);
        expect(db.llamadas.some((l) => l.tabla === 'whatsapp_messages')).toBe(false);

        // El saludo vuelve a escribir, ahora con intención: solo esa se relee.
        db.t.whatsapp_conversations.find((c) => c.id === 'c-saludo')!.last_inbound_at = new Date(AHORA + 120_000).toISOString();
        db.t.whatsapp_messages.push({
            conversation_id: 'c-saludo', integration_id: INTEG, direction: 'inbound', type: 'text', ai_generated: false,
            text_body: '¿Cuánto vale la clínica?', wa_message_id: 'wamid.nuevo', wa_timestamp: new Date(AHORA + 120_000).toISOString(),
        });
        const r3 = await clasificarEscuela(ESC, { aplicar: true, ahora: AHORA + 180_000 });
        expect(r3.releidas).toBe(1);
        expect(db.t.whatsapp_audiencia.find((f) => f.contact_wa_id === '573001000004')).toMatchObject({ intereses: ['clinica', 'precio'] });
    });

    it('sin la RPC de exclusiones (M3 sin aplicar) no guarda nada', async () => {
        sembrar();
        db.rpc.wa_audiencia_excluidos = () => ({ data: null, error: { message: 'function does not exist' } });
        const r = await clasificarEscuela(ESC, { aplicar: true, ahora: AHORA });
        expect(r.estado).toBe('sin_migracion');
        expect(db.upserts).toBe(0);
    });

    it('quien pidió la baja queda excluido', async () => {
        sembrar();
        db.t.whatsapp_optins = [{ integration_id: INTEG, contact_wa_id: '573001000001', opted_in_at: null, opted_out_at: hace(2) }];
        const r = await clasificarEscuela(ESC, { ahora: AHORA });
        expect(r.excluidos.baja).toBe(1);
        expect(r.vigentes).toBe(0);
    });
});
