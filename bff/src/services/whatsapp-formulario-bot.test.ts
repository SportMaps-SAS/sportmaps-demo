/**
 * Formularios de WhatsApp (Flows, fase F-a) dentro del bot: `deliver` con un
 * formulario, el webhook con un `nfm_reply` y el respaldo por chat cuando Meta
 * no lo entrega (131026).
 *
 * Mismo andamiaje que whatsapp-tomada-bot.test.ts (Supabase encadenable,
 * `whatsapp.service` mockeado: nada sale a Meta).
 *
 * Lo que se vigila:
 *   · modo auto: el formulario sale como `interactive.type = flow` y queda en el
 *     buzón como interactivo con su flow_id (sin el token);
 *   · si Meta lo rechaza, sale el RESPALDO por chat (no la invitación a un botón que no llegó);
 *   · modo asistido: el formulario no deja borrador;
 *   · el webhook atiende el `nfm_reply` con su handler (sin modelo) y SIEMPRE contesta;
 *   · un estado `failed` de un formulario (131026) manda el respaldo UNA vez.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        inserts: { table: string; row: any }[];
        rpcs: { fn: string; args: any }[];
    } = { resolve: () => ({ data: null, error: null }), inserts: [], rpcs: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'update', 'is', 'not', 'delete']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, ops));
        b.single = () => Promise.resolve(state.resolve(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => { state.rpcs.push({ fn, args }); return Promise.resolve({ data: null, error: null }); },
        },
        debeAtender: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendRawPayload: vi.fn(),
        resolveIntegration: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: vi.fn(async () => true) };
});
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp.service')>('./whatsapp.service');
    return {
        ...real,
        sendTextMessage: h.sendTextMessage,
        sendRawPayload: h.sendRawPayload,
        sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
        resolveIntegration: h.resolveIntegration,
        markAsRead: vi.fn(),
    };
});
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '\n\n(baja)' }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn(async () => ({ cuentas: [] })) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: vi.fn(async () => {}), uuidDeClave: (k: string) => k }));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
    esContactoPersonal: vi.fn(async () => false), payloadSinContenido: (x: any) => x,
}));

import { handleBotTurn } from '../routes/whatsapp';
import { deliver, seguirPorChatTrasFormularioFallido } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1', phone_number_id: 'pn-1' } as any;
const CONV = 'conv-1';
const TEL = '573001112233';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const FORMULARIO = {
    flowId: '900000000000001', cta: 'Inscribirme', token: 'v1.datos.firma', pantalla: 'FICHA',
    data: { servicio: 'Clínica de armadores y atacantes' },
};
const RESPALDO = 'No pude abrirte el formulario en este WhatsApp 🙏 Sigamos por aquí: transfiere con los datos que te envié y mándame la foto o el PDF del comprobante.';

let ajustes: Record<string, any> = { ai_enabled: true, mode: 'auto', assisted_until: null };
let saliente: Record<string, any> | null = null;

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcs = [];
    ajustes = { ai_enabled: true, mode: 'auto', assisted_until: null };
    saliente = null;
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.txt' });
    h.sendRawPayload.mockResolvedValue({ ok: true, waMessageId: 'wamid.flow' });
    h.resolveIntegration.mockResolvedValue(INTEGRATION);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
    h.state.resolve = (table) => {
        if (table === 'whatsapp_settings') return { data: ajustes, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, contact_wa_id: TEL, status: 'open', last_inbound_at: new Date().toISOString() }, error: null };
        }
        // Ya hubo una respuesta automática: sin presentación.
        if (table === 'whatsapp_messages') return saliente ? { data: saliente, error: null } : { data: [{ ai_generated: true }], error: null };
        if (table === 'schools') return { data: { name: 'Monster´s Volley Club' }, error: null };
        if (table === 'whatsapp_flow_respuestas') return { data: { id: 'resp-1' }, error: null };
        return { data: null, error: null };
    };
});

const registro = () => h.state.rpcs.find((r) => r.fn === 'wa_record_outbound_message')?.args;

describe('deliver con un formulario', () => {
    it('modo auto: sale `interactive.type = flow` y queda en el buzón como interactivo con su flow_id', async () => {
        await deliver(INTEGRATION, CONV, TEL, '¿Quieres dejar listo el cupo? Toca *Inscribirme*.', {
            step: 'formulario_enviado', repetible: true, formulario: { nombre: 'servicio_inscripcion', respaldo: RESPALDO },
        }, { botones: [], enTexto: RESPALDO, formulario: FORMULARIO });
        expect(h.sendRawPayload).toHaveBeenCalledTimes(1);
        const payload = h.sendRawPayload.mock.calls[0][1];
        expect(payload.interactive.type).toBe('flow');
        expect(payload.interactive.action.parameters).toMatchObject({
            flow_message_version: '3', flow_id: FORMULARIO.flowId, flow_cta: 'Inscribirme', flow_token: FORMULARIO.token,
            mode: 'published', flow_action: 'navigate', flow_action_payload: { screen: 'FICHA', data: FORMULARIO.data },
        });
        expect(h.sendTextMessage).not.toHaveBeenCalled();
        expect(registro()).toMatchObject({ p_type: 'interactive', p_wa_message_id: 'wamid.flow', p_payload: { flow_id: FORMULARIO.flowId, flow_cta: 'Inscribirme' } });
        expect(JSON.stringify(registro()?.p_payload)).not.toContain(FORMULARIO.token);
    });

    it('Meta lo rechaza (negocio sin verificar, flow estrangulado…): sale el respaldo por chat', async () => {
        h.sendRawPayload.mockResolvedValue({ ok: false, error: 'Flow is throttled' });
        await deliver(INTEGRATION, CONV, TEL, '¿Quieres dejar listo el cupo? Toca *Inscribirme*.', { step: 'formulario_enviado', repetible: true },
            { botones: [], enTexto: RESPALDO, formulario: FORMULARIO });
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(h.sendTextMessage.mock.calls[0][2]).toBe(RESPALDO);
        expect(registro()).toMatchObject({ p_type: 'text', p_text_body: RESPALDO });
    });

    it('modo asistido: el formulario no deja borrador ni sale', async () => {
        ajustes = { ai_enabled: true, mode: 'assisted', assisted_until: null };
        await deliver(INTEGRATION, CONV, TEL, '¿Quieres dejar listo el cupo?', { step: 'formulario_enviado', repetible: true },
            { botones: [], enTexto: RESPALDO, formulario: FORMULARIO });
        expect(h.sendRawPayload).not.toHaveBeenCalled();
        expect(h.sendTextMessage).not.toHaveBeenCalled();
        expect(h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts')).toHaveLength(0);
    });
});

describe('el webhook con un formulario terminado (nfm_reply)', () => {
    const nfm = (response_json: string) => ({
        phoneNumberId: 'pn-1', contactWaId: TEL, contactName: 'Ana', waMessageId: 'wamid.form', type: 'interactive',
        textBody: 'Formulario enviado', botonId: null, waTimestamp: new Date().toISOString(),
        raw: { type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json } } },
    }) as any;

    it('lo atiende su handler (sin modelo, sin debeAtender) y nunca calla: token que no valida → se lo dice', async () => {
        await handleBotTurn(req, INTEGRATION, CONV, nfm(JSON.stringify({ flow_token: 'v1.falso.falso', nombre_deportista: 'Ana' })));
        expect(h.debeAtender).not.toHaveBeenCalled();
        expect(h.chatWithTools).not.toHaveBeenCalled();
        const resp = h.state.inserts.find((i) => i.table === 'whatsapp_flow_respuestas')?.row;
        expect(resp).toMatchObject({ wa_message_id: 'wamid.form', contact_wa_id: TEL, conversation_id: CONV, resultado: 'recibida' });
        expect(resp.response_json).not.toHaveProperty('nombre_deportista');
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(h.sendTextMessage.mock.calls[0][2]).toMatch(/No pude validar este formulario/);
        expect(h.state.inserts.some((i) => i.table === 'whatsapp_consentimientos')).toBe(false);
    });
});

describe('Meta no entregó el formulario (estado failed, 131026)', () => {
    it('manda el respaldo por chat UNA vez; un saliente que no es formulario no hace nada', async () => {
        saliente = { conversation_id: 'conv-131026', direction: 'outbound', type: 'interactive', payload: { formulario: { respaldo: RESPALDO, servicio_id: 'srv' } } };
        expect(await seguirPorChatTrasFormularioFallido('pn-1', 'wamid.flow', 131026)).toBe(true);
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(h.sendTextMessage.mock.calls[0][2]).toBe(RESPALDO);
        expect(await seguirPorChatTrasFormularioFallido('pn-1', 'wamid.flow', 131026)).toBe(false);
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);

        saliente = { conversation_id: 'conv-otro', direction: 'outbound', type: 'text', payload: { step: 'x' } };
        expect(await seguirPorChatTrasFormularioFallido('pn-1', 'wamid.txt', 131026)).toBe(false);
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    });
});
