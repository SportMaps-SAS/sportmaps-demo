/**
 * Respuestas a una campaña (plan B5 T4): botones `smc:<campaña>:si|luego|baja`
 * y el «no me interesa» corto tras la plantilla. Base en memoria; Graph, push
 * y el lead simulados. Nada sale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    rpcLlamadas: [] as { fn: string; args: any }[],
    seq: 0,
}));
const est = vi.hoisted(() => ({
    enviados: [] as { to: string; texto: string }[],
    leads: [] as any[],
    tomada: false,
    discreto: false,
    escuelaActiva: false,
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const filtros: ((r: any) => boolean)[] = [];
        let op: 'select' | 'insert' | 'update' = 'select';
        let payload: any = null;
        let single = false;
        let lim = Infinity;
        const resolver = () => {
            const filas = (db.t[tabla] ??= []);
            if (op === 'insert') {
                const fila = { id: `${tabla}-${++db.seq}`, ...payload };
                if (filas.some((r) => r.id === fila.id)) return { data: null, error: { code: '23505', message: 'duplicate' } };
                filas.push(fila);
                return { data: fila, error: null };
            }
            const sel = filas.filter((r) => filtros.every((f) => f(r)));
            if (op === 'update') { for (const r of sel) Object.assign(r, payload); return { data: sel, error: null }; }
            const pagina = sel.slice(0, lim);
            return { data: single ? (pagina[0] ?? null) : pagina.map((r) => ({ ...r })), error: null };
        };
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((r) => r[c] === v); return api; },
            in: (c: string, vs: any[]) => { filtros.push((r) => vs.includes(r[c])); return api; },
            order: () => api,
            limit: (n: number) => { lim = n; return api; },
            insert: (p: any) => { op = 'insert'; payload = p; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            maybeSingle: () => { single = true; return api; },
            then: (ok: any, ko: any) => Promise.resolve(resolver()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: (fn: string, args: any) => { db.rpcLlamadas.push({ fn, args }); return Promise.resolve({ data: null, error: null }); },
        },
    };
});
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async (_i: any, to: string, texto: string) => { est.enviados.push({ to, texto }); return { ok: true, waMessageId: `wamid.r${est.enviados.length}` }; }),
    sendRawPayload: vi.fn(),
    decryptToken: () => 't',
}));
vi.mock('./whatsapp-tomada.service', () => ({ conversacionTomada: vi.fn(async () => est.tomada) }));
vi.mock('./whatsapp-modo-discreto', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-modo-discreto')>('./whatsapp-modo-discreto');
    return { ...real, modoDiscreto: () => est.discreto, escuelaActiva: vi.fn(async () => est.escuelaActiva) };
});
vi.mock('./whatsapp-prospecto-lead.service', () => ({
    registrarLeadDeProspecto: vi.fn(async (p: any) => { est.leads.push(p); return { leadId: 'lead-1', creado: true }; }),
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn(async () => ({ sent: 1 })) }));
vi.mock('./plataforma-wa.service', () => ({
    adminsDeEscuela: vi.fn(async () => new Set(['admin-1'])),
    nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club'),
}));

import {
    atenderRespuestaDeCampana, esNoMeInteresa, esPosibleRespuestaDeCampana, parsearBotonDeCampana, TEXTO_LUEGO,
    TEXTO_NO_INTERESA,
} from './whatsapp-campana-respuesta.service';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CAMP = '11111111-1111-4111-8111-111111111111';
const INTEG = { id: 'integ-monster', school_id: ESC, phone_number_id: 'pn', access_token_encrypted: 'x' } as any;
const TEL = '573001112233';
let n = 0;
const boton = (accion: string, campana = CAMP) => ({
    type: 'button', textBody: 'x', botonId: `smc:${campana}:${accion}`, contactWaId: TEL, contactName: 'Carolina Ruiz',
    waMessageId: `wamid.in${++n}`, phoneNumberId: 'pn', waTimestamp: new Date().toISOString(), raw: {},
}) as any;
const texto = (t: string) => ({ ...boton('si'), type: 'text', textBody: t, botonId: null }) as any;

beforeEach(() => {
    n = 0; db.seq = 0; db.rpcLlamadas = [];
    est.enviados = []; est.leads = []; est.tomada = false; est.discreto = false; est.escuelaActiva = false;
    db.t = {
        whatsapp_campanas: [{
            id: CAMP, school_id: ESC, integration_id: INTEG.id, nombre: 'Cierre 2026',
            respuesta_si: '¡Genial! Te cuento: noviembre gratis si te matriculas antes del 30…',
        }],
        whatsapp_campana_envios: [{ id: 'env-1', campana_id: CAMP, contact_wa_id: TEL, estado: 'enviado' }],
        whatsapp_audiencia: [{ integration_id: INTEG.id, contact_wa_id: TEL, excluido: null }],
        whatsapp_conversations: [{ id: 'conv-1', status: 'closed' }],
        whatsapp_messages: [
            { conversation_id: 'conv-1', direction: 'inbound', text_body: 'Hola' },
            { conversation_id: 'conv-1', direction: 'inbound', text_body: 'Quiero una clase de prueba para mi hija' },
        ],
        notifications: [],
    };
});

describe('filtros puros', () => {
    it('parsea smc:<uuid>:si|luego|baja y nada más', () => {
        expect(parsearBotonDeCampana(`smc:${CAMP}:si`)).toEqual({ campanaId: CAMP, accion: 'si' });
        expect(parsearBotonDeCampana(`smc:${CAMP}:baja`)).toEqual({ campanaId: CAMP, accion: 'baja' });
        expect(parsearBotonDeCampana(`smc:${CAMP}:otra`)).toBeNull();
        expect(parsearBotonDeCampana(`smc:no-es-uuid:si`)).toBeNull();
        expect(parsearBotonDeCampana(`smc:${CAMP}:si:extra`)).toBeNull();
        expect(parsearBotonDeCampana('sm_cc_confirmar')).toBeNull();
        expect(parsearBotonDeCampana(null)).toBeNull();
    });

    it('«no me interesa» corto sí; con más contexto no (sigue el bot)', () => {
        for (const t of ['No me interesa', 'no gracias', 'No más', 'No me escriban más', 'No estoy interesada 🙏', 'Dejen de escribirme']) {
            expect(esNoMeInteresa(t)).toBe(true);
        }
        for (const t of ['Sí me interesa', 'No me interesa la clínica pero sí las clases para mi hija de 9 años', 'Hola', '']) {
            expect(esNoMeInteresa(t)).toBe(false);
        }
    });

    it('el webhook solo pregunta por botones smc: o por la frase', () => {
        expect(esPosibleRespuestaDeCampana({ type: 'button', textBody: 'Sí, cuéntame', botonId: `smc:${CAMP}:si` })).toBe(true);
        expect(esPosibleRespuestaDeCampana({ type: 'interactive', textBody: 'Confirmar', botonId: 'sm_cc_confirmar' })).toBe(false);
        expect(esPosibleRespuestaDeCampana({ type: 'text', textBody: 'Hola, buenas tardes', botonId: null })).toBe(false);
        expect(esPosibleRespuestaDeCampana({ type: 'text', textBody: 'No me interesa', botonId: null })).toBe(true);
        expect(esPosibleRespuestaDeCampana({ type: 'audio', textBody: 'No me interesa', botonId: null })).toBe(false);
    });
});

describe('botones', () => {
    it('«No recibir más» → opt-out con el wamid, fuera de la audiencia, envío baja y confirmación (aun con la escuela escribiendo)', async () => {
        est.discreto = true; est.escuelaActiva = true;
        const msg = boton('baja');
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg })).toBe('baja');
        const optout = db.rpcLlamadas.find((l) => l.fn === 'wa_register_optin')!;
        expect(optout.args).toMatchObject({ p_integration_id: INTEG.id, p_contact_wa_id: TEL, p_opt_out: true, p_source_ref: msg.waMessageId });
        expect(db.t.whatsapp_audiencia[0].excluido).toBe('baja');
        expect(db.t.whatsapp_campana_envios[0].estado).toBe('baja');
        expect(est.enviados).toHaveLength(1);
        expect(est.enviados[0].texto).toMatch(/no volverás a recibir mensajes automáticos de Monster´s Volley Club/);
        const saliente = db.rpcLlamadas.find((l) => l.fn === 'wa_record_outbound_message')!;
        expect(saliente.args.p_payload).toMatchObject({ step: 'opt_out_confirmado', automatico: true });

        // Segundo toque: el opt-out se reafirma, pero no se repite la confirmación.
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('baja') })).toBe('repetido');
        expect(est.enviados).toHaveLength(1);
    });

    it('«Más adelante» → respondio_luego y un texto corto', async () => {
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('luego') })).toBe('luego');
        expect(db.t.whatsapp_campana_envios[0].estado).toBe('respondio_luego');
        expect(est.enviados.map((e) => e.texto)).toEqual([TEXTO_LUEGO]);
    });

    it('«Sí» → respuesta aprobada, lead con los mensajes de intención, buzón abierto y aviso; el segundo toque no repite', async () => {
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('si') })).toBe('si');
        expect(db.t.whatsapp_campana_envios[0].estado).toBe('respondio_si');
        expect(est.enviados.map((e) => e.texto)).toEqual(['¡Genial! Te cuento: noviembre gratis si te matriculas antes del 30…']);
        expect(est.leads).toHaveLength(1);
        expect(est.leads[0]).toMatchObject({
            schoolId: ESC, conversationId: 'conv-1', contactWaId: TEL, estado: 'nuevo',
            textos: ['Quiero una clase de prueba para mi hija'],
        });
        expect(db.t.whatsapp_conversations[0].status).toBe('open');
        expect(db.t.notifications).toHaveLength(1);
        expect(db.t.notifications[0]).toMatchObject({
            user_id: 'admin-1', title: expect.stringMatching(/Carolina Ruiz .* respondió «Sí»/), link: '/whatsapp?conversacion=conv-1',
        });

        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('si') })).toBe('repetido');
        expect(est.enviados).toHaveLength(1);
        expect(db.t.notifications).toHaveLength(1);
    });

    it('«Sí» con la escuela escribiendo (modo discreto) o tomada: no sale el texto, pero quedan lead y aviso', async () => {
        est.discreto = true; est.escuelaActiva = true;
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('si') })).toBe('si');
        expect(est.enviados).toHaveLength(0);
        expect(est.leads).toHaveLength(1);
        expect(db.t.notifications).toHaveLength(1);
    });

    it('un smc: de la campaña de OTRA escuela no se atiende', async () => {
        db.t.whatsapp_campanas[0].integration_id = 'integ-otra';
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: boton('si') })).toBe('no_aplica');
        expect(est.enviados).toHaveLength(0);
        expect(db.t.whatsapp_campana_envios[0].estado).toBe('enviado');
    });
});

describe('«no me interesa» en texto', () => {
    const plantilla = (horas: number, step = 'campana') => ({
        conversation_id: 'conv-1', direction: 'outbound', payload: { step, campana_id: CAMP },
        created_at: new Date(Date.now() - horas * 3600_000).toISOString(),
    });

    it('tras la plantilla (< 72 h) → excluido no_interesa y un «entendido»', async () => {
        db.t.whatsapp_messages = [plantilla(5)];
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: texto('No me interesa, gracias') })).toBe('no_interesa');
        expect(db.t.whatsapp_audiencia[0].excluido).toBe('no_interesa');
        expect(db.t.whatsapp_campana_envios[0]).toMatchObject({ motivo: 'no_interesa', estado: 'enviado' });
        expect(est.enviados.map((e) => e.texto)).toEqual([TEXTO_NO_INTERESA]);
    });

    it('si lo último no fue la campaña, o fue hace más de 72 h: camino de siempre', async () => {
        db.t.whatsapp_messages = [plantilla(5, 'cobro_vence_hoy')];
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: texto('No me interesa') })).toBe('no_aplica');
        db.t.whatsapp_messages = [plantilla(80)];
        expect(await atenderRespuestaDeCampana({ integration: INTEG, conversationId: 'conv-1', msg: texto('No me interesa') })).toBe('no_aplica');
        expect(db.t.whatsapp_audiencia[0].excluido).toBeNull();
        expect(est.enviados).toHaveLength(0);
    });
});
