/**
 * Gancho de las campañas en el webhook (plan B5 T4): `handleBotTurn` atiende
 * los botones `smc:` ANTES de `debeAtender` y deja todo lo demás por el camino
 * de siempre, sin una sola lectura de campañas. Servicio real de respuestas
 * sobre una base en memoria; nada de Meta ni de la base viva.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    t: {} as Record<string, any[]>,
    lecturas: [] as string[],
    rpc: [] as { fn: string; args: any }[],
}));
const enviados = vi.hoisted(() => ({ texto: [] as string[] }));

vi.mock('../config/supabase', () => {
    const builder = (name: string) => {
        db.lecturas.push(name);
        const rows = () => (db.t[name] ??= []);
        const f: ((r: any) => boolean)[] = [];
        let op = 'select'; let payload: any; let single = false; let lim = Infinity;
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { f.push((r) => r[c] === v); return api; },
            in: (c: string, v: any[]) => { f.push((r) => v.includes(r[c])); return api; },
            is: () => api, gte: () => api, lt: () => api, or: () => api, order: () => api,
            limit: (n: number) => { lim = n; return api; },
            insert: (p: any) => { op = 'insert'; payload = p; return api; },
            update: (p: any) => { op = 'update'; payload = p; return api; },
            upsert: () => api,
            maybeSingle: () => { single = true; return api; },
            single: () => { single = true; return api; },
            then: (ok: any, ko: any) => {
                let r: any;
                if (op === 'insert') { rows().push(payload); r = { data: payload, error: null }; } else {
                    const sel = rows().filter((x) => f.every((fn) => fn(x)));
                    if (op === 'update') { sel.forEach((x) => Object.assign(x, payload)); r = { data: sel, error: null }; } else {
                        r = { data: single ? (sel[0] ?? null) : sel.slice(0, lim), error: null };
                    }
                }
                return Promise.resolve(r).then(ok, ko);
            },
        };
        return api;
    };
    return {
        supabase: {
            from: builder,
            rpc: (fn: string, args: any) => { db.rpc.push({ fn, args }); return Promise.resolve({ data: null, error: null }); },
            storage: { from: () => ({ upload: () => Promise.resolve({ error: null }), remove: () => Promise.resolve({ error: null }) }) },
        },
    };
});

const atencion = vi.hoisted(() => ({ debeAtender: vi.fn() }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: atencion.debeAtender };
});
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async (_i: any, _to: string, t: string) => { enviados.texto.push(t); return { ok: true, waMessageId: 'wamid.t' }; }),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.b' })),
    sendRawPayload: vi.fn(),
    aFormatoWhatsApp: (t: string) => t,
    decryptToken: () => 't',
    verifyWebhookSignature: vi.fn(),
    resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []),
    parseStatuses: vi.fn(() => []),
    markAsRead: vi.fn(),
    downloadMedia: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';

const ESC = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CAMP = '11111111-1111-4111-8111-111111111111';
const INTEGRATION = { id: 'integ-1', school_id: ESC, phone_number_id: 'pn', access_token_encrypted: 'x' } as any;
const TEL = '573001112233';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
let n = 0;
const mensaje = (extra: Record<string, any>) => ({
    type: 'button', textBody: 'x', botonId: null, contactWaId: TEL, waMessageId: `w${++n}`, contactName: 'Carolina', ...extra,
}) as any;

beforeEach(() => {
    n = 0;
    db.lecturas = []; db.rpc = [];
    enviados.texto.length = 0;
    db.t = {
        whatsapp_campanas: [{ id: CAMP, school_id: ESC, integration_id: INTEGRATION.id, nombre: 'Cierre 2026', respuesta_si: null }],
        whatsapp_campana_envios: [{ id: 'env-1', campana_id: CAMP, contact_wa_id: TEL, estado: 'enviado' }],
        whatsapp_audiencia: [{ integration_id: INTEGRATION.id, contact_wa_id: TEL, excluido: null }],
        schools: [{ id: ESC, name: 'Monster´s Volley Club' }],
    };
    atencion.debeAtender.mockReset();
    atencion.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: false, tomada: false, tambienFamilia: false });
});

describe('webhook — respuesta a una campaña', () => {
    it('«No recibir más» de la plantilla: opt-out y confirmación, sin pasar por debeAtender (bot apagado incluido)', async () => {
        await handleBotTurn(req, INTEGRATION, 'conv-1', mensaje({ botonId: `smc:${CAMP}:baja`, textBody: 'No recibir más' }));
        expect(atencion.debeAtender).not.toHaveBeenCalled();
        expect(db.rpc.find((l) => l.fn === 'wa_register_optin')?.args).toMatchObject({ p_opt_out: true, p_contact_wa_id: TEL });
        expect(db.t.whatsapp_campana_envios[0].estado).toBe('baja');
        expect(enviados.texto).toHaveLength(1);
        expect(enviados.texto[0]).toMatch(/Monster´s Volley Club/);
    });

    it('botón de otro flujo (sm_cc_*): el camino de hoy, sin leer campañas', async () => {
        await handleBotTurn(req, INTEGRATION, 'conv-1', mensaje({ type: 'interactive', botonId: 'sm_cc_confirmar' }));
        expect(atencion.debeAtender).toHaveBeenCalledTimes(1);
        expect(db.lecturas).not.toContain('whatsapp_campanas');
        expect(db.lecturas).not.toContain('whatsapp_campana_envios');
    });

    it('texto común: el camino de hoy, sin leer campañas', async () => {
        await handleBotTurn(req, INTEGRATION, 'conv-1', mensaje({ type: 'text', textBody: 'Hola, buenas tardes' }));
        expect(atencion.debeAtender).toHaveBeenCalledTimes(1);
        expect(db.lecturas).not.toContain('whatsapp_campanas');
        expect(db.lecturas).not.toContain('whatsapp_messages');
    });

    it('«no me interesa» sin campaña detrás: sigue el camino de hoy', async () => {
        await handleBotTurn(req, INTEGRATION, 'conv-1', mensaje({ type: 'text', textBody: 'No me interesa' }));
        expect(atencion.debeAtender).toHaveBeenCalledTimes(1);
        expect(db.t.whatsapp_audiencia[0].excluido).toBeNull();
    });
});
