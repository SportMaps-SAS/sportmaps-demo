/**
 * El botón [Sí, acepto] del consentimiento SIEMPRE tiene respuesta (auditoría Monster 18-nov-2026: …0261 y …4561 lo
 * tocaron justo después de un aviso de comprobante y quedaron sin respuesta ni fila en whatsapp_optins).
 * Mismo andamiaje que whatsapp-bot-intrusion-2026-11-17.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        mensajes: any[]; pasosEnviados: string[]; optin: any; conv: any; candado: string | null;
        inserts: { table: string; row: any }[]; updates: { table: string; row: any; ops: Ops }[];
        rpcCalls: { fn: string; args: any }[]; identify: any;
    } = {
        mensajes: [], pasosEnviados: [], optin: null, conv: null, candado: null,
        inserts: [], updates: [], rpcCalls: [], identify: { estado: 'identificado', parent_id: 'parent-1' },
    };

    function resolve(table: string, ops: Ops): any {
        const stepEq = ops.find(([n, a]) => n === 'eq' && String(a[0]).endsWith('>>step'));
        if (table === 'whatsapp_messages' && stepEq) {
            return { count: state.pasosEnviados.filter((p) => p === stepEq[1][1]).length, error: null };
        }
        if (table === 'whatsapp_message_drafts' && stepEq) return { count: 0, error: null };
        if (table === 'whatsapp_messages') return { data: state.mensajes, error: null };
        if (table === 'whatsapp_conversations') {
            const esCandado = ops.some(([n, a]) => n === 'update' && a[0] && 'bot_turno_hasta' in a[0]);
            if (esCandado) {
                const fila = ops.find(([n]) => n === 'update')![1][0];
                if (fila.bot_turno_hasta === null) { state.candado = null; return { data: null, error: null }; }
                state.candado = fila.bot_turno_hasta;
                return { data: [{ id: 'conv-1' }], error: null };
            }
            return { data: state.conv, error: null };
        }
        if (table === 'whatsapp_optins') return { data: state.optin, error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
        if (table === 'schools') return { data: { name: 'Monster', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'profiles') return { data: { full_name: 'Acudiente' }, error: null };
        return { data: null, error: null };
    }

    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { state.updates.push({ table, row, ops }); ops.push(['update', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(resolve(table, ops));
        b.single = () => Promise.resolve(resolve(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => {
                state.rpcCalls.push({ fn, args });
                if (fn === 'wa_identify_by_phone') return Promise.resolve({ data: state.identify, error: null });
                return Promise.resolve({ data: null, error: null });
            },
        },
        debeAtender: vi.fn(), botEncendido: vi.fn(), chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(), sendInteractiveButtons: vi.fn(), sendToUser: vi.fn(), mediosDePago: vi.fn(),
    };
});

vi.mock('@sentry/node', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn(), withScope: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: h.botEncendido };
});
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: h.sendTextMessage, sendInteractiveButtons: h.sendInteractiveButtons,
    aFormatoWhatsApp: (t: string) => t, markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'Ya le avisé a la escuela.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: h.mediosDePago }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: vi.fn(async () => {}) }));

import { runBotTurn, BOTON, PASO_CONSENTIMIENTO_SIN_CUENTA, _limpiarCacheVocativos } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573001110261';
const hace = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');
const pasos = () => borradores().map((b) => b.row.tool_context.step);
const textos = () => [
    ...borradores().map((b) => String(b.row.proposed_text)),
    ...h.sendTextMessage.mock.calls.map((c) => String(c[2])),
].join('\n');
const optins = () => h.state.rpcCalls.filter((c) => c.fn === 'wa_register_optin');

const PREGUNTA_CONSENTIMIENTO = {
    direction: 'outbound', ai_generated: true, type: 'interactive', wa_timestamp: hace(20), created_at: hace(20),
    text_body: 'Tu pago quedó confirmado.\n\nUna cosa más 🙂 ¿Quieres que *Monster* te envíe por aquí los recordatorios de pago?',
    payload: { step: 'resultado_pagado', pregunta: 'ask_consent' },
};
const escuelaHace = (s: number) =>
    ({ direction: 'outbound', ai_generated: false, text_body: 'Listo, ya quedó', wa_timestamp: hace(s), created_at: hace(s) });

beforeEach(() => {
    vi.clearAllMocks();
    _limpiarCacheVocativos();
    Object.assign(h.state, {
        mensajes: [PREGUNTA_CONSENTIMIENTO], pasosEnviados: [], optin: null, candado: null,
        conv: { id: CONV, parent_id: 'parent-1', identified: true, status: 'open', contact_name: 'Z.' },
        inserts: [], updates: [], rpcCalls: [], identify: { estado: 'identificado', parent_id: 'parent-1' },
    });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
    h.chatWithTools.mockResolvedValue({ text: 'Respuesta del modelo', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.sendInteractiveButtons.mockResolvedValue({ ok: true, waMessageId: 'wamid.btn' });
    h.mediosDePago.mockResolvedValue({ cuentas: [], enlace_para_pagar: 'https://x' });
});

describe('[Sí, acepto] del consentimiento: siempre responde y registra el opt-in', () => {
    it('familia vinculada (…4561, tras el aviso del comprobante): registra y confirma', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(optins()).toHaveLength(1);
        expect(optins()[0].args).toMatchObject({ p_contact_wa_id: TEL, p_parent_id: 'parent-1', p_source_ref: 'w1', p_opt_out: false });
        expect(pasos()).toContain('opt_in_registrado');
        expect(textos()).toContain('Listo, te avisaré');
    });

    it('con la escuela escribiendo en el chat (silencio por humano) igual responde y registra (antes se lo tragaba)', async () => {
        h.state.mensajes = [escuelaHace(60), PREGUNTA_CONSENTIMIENTO];
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(optins()).toHaveLength(1);
        expect(textos()).toContain('Listo, te avisaré');
    });

    it('conversación sin vínculo (…0261): consulta wa_identify_by_phone y, pase lo que pase, hay respuesta', async () => {
        h.state.conv = { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: 'Z.' };
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(h.state.rpcCalls.some((c) => c.fn === 'wa_identify_by_phone')).toBe(true);
        // El doble devuelve el mismo `conv` sin parent: sin vínculo no se puede registrar, pero HAY respuesta.
        expect(textos().length).toBeGreaterThan(0);
    });

    it('número sin ficha ni cuenta, con el aviso de «crea tu cuenta» ya dado en 24 h: la respuesta amable, nunca silencio', async () => {
        h.state.conv = { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: 'Z.' };
        h.state.identify = { estado: 'debe_registrarse' };
        h.state.pasosEnviados = ['familia_sin_cuenta', 'debe_registrarse'];
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia_sin_cuenta', botEncendido: true });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(pasos()).toContain(PASO_CONSENTIMIENTO_SIN_CUENTA);
        expect(textos()).toContain('todavía no está registrado');
        expect(optins()).toHaveLength(0);
    });

    it('justo después de un «no es un comprobante» del bot (…0261, 19:53): responde igual', async () => {
        h.state.mensajes = [
            { direction: 'outbound', ai_generated: true, type: 'text', wa_timestamp: hace(5), created_at: hace(5),
              text_body: 'Eso no es un comprobante de pago.', payload: { step: 'resultado_no_es_comprobante' } },
            PREGUNTA_CONSENTIMIENTO,
        ];
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(optins()).toHaveLength(1);
        expect(textos()).toContain('Listo, te avisaré');
    });

    it('ya había aceptado: se lo dice (no queda mudo)', async () => {
        h.state.optin = { opted_in_at: hace(86400), opted_out_at: null };
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'w1', false, BOTON.CONSENTIR_SI);
        expect(optins()).toHaveLength(0);
        expect(textos()).toContain('Ya tenías los avisos activados');
    });

    it('[No, gracias]: no registra y confirma', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'No, gracias', 'w1', false, BOTON.CONSENTIR_NO);
        expect(optins()).toHaveLength(0);
        expect(textos()).toContain('Sin problema');
    });
});
