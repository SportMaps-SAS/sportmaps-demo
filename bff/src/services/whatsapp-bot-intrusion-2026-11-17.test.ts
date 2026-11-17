/**
 * El bot no habla encima de la escuela (hallazgo 4, auditoría Monster 14–17 nov 2026). Cada caso usa el texto
 * real (anonimizado) de la conversación. Mismo andamiaje que whatsapp-bot-dynasty-2026-10-06.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        mensajes: any[];
        pasosEnviados: string[];
        optin: any;
        conv: any;
        candado: string | null;
        pagos: any[];
        cola: any[];
        perfiles: any[];
        inserts: { table: string; row: any }[];
        updates: { table: string; row: any; ops: Ops }[];
        rpcCalls: { fn: string; args: any }[];
        identify: any;
    } = {
        mensajes: [], pasosEnviados: [], optin: null, conv: null, candado: null, pagos: [], cola: [], perfiles: [],
        inserts: [], updates: [], rpcCalls: [], identify: { estado: 'identificado', parent_id: 'parent-1' },
    };
    const pide = (ops: Ops, m: string, pred: (a: any[]) => boolean) => ops.some(([n, a]) => n === m && pred(a));

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
                if (state.candado && new Date(state.candado).getTime() > Date.now()) return { data: [], error: null };
                state.candado = fila.bot_turno_hasta;
                return { data: [{ id: 'conv-1' }], error: null };
            }
            return { data: state.conv, error: null };
        }
        if (table === 'whatsapp_optins') return { data: state.optin, error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
        if (table === 'whatsapp_inbound_queue') return { data: state.cola, error: null };
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'profiles') {
            return pide(ops, 'in', () => true) ? { data: state.perfiles, error: null } : { data: { full_name: 'Acudiente' }, error: null };
        }
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
                if (fn === 'wa_get_payment_status') return Promise.resolve({ data: state.pagos, error: null });
                return Promise.resolve({ data: null, error: null });
            },
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendInteractiveButtons: vi.fn(),
        sendToUser: vi.fn(),
        mediosDePago: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: h.botEncendido };
});
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: h.sendTextMessage,
    sendInteractiveButtons: h.sendInteractiveButtons,
    aFormatoWhatsApp: (t: string) => t,
    markAsRead: vi.fn(),
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

import { runBotTurn, acusarAdjunto, BOTON, BOTONES_CONFIRMAR_BAJA, _limpiarCacheVocativos } from './whatsapp-bot.service';
import { correrTurnoAgrupado } from './whatsapp-turno-agrupado.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573001112233';
const PRECARGADO = 'Hola, envío el comprobante de pago de Mensualidad 10/2026 - LAURA P (octubre 2026) de Laura. (ref. 3FA2B91C)';

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');
const pasos = () => borradores().map((b) => b.row.tool_context.step);
const rpcs = (fn: string) => h.state.rpcCalls.filter((c) => c.fn === fn);
const hace = (s: number) => new Date(Date.now() - s * 1000).toISOString();

beforeEach(() => {
    vi.clearAllMocks();
    _limpiarCacheVocativos();
    Object.assign(h.state, {
        mensajes: [], pasosEnviados: [], optin: null, candado: null, pagos: [], cola: [],
        perfiles: [{ full_name: 'Milena Ríos' }],
        conv: { id: CONV, parent_id: 'parent-1', identified: true, status: 'closed', contact_name: 'A.' },
        inserts: [], updates: [], rpcCalls: [], identify: { estado: 'identificado', parent_id: 'parent-1' },
    });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
    h.chatWithTools.mockResolvedValue({ text: 'Respuesta del modelo', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.sendInteractiveButtons.mockResolvedValue({ ok: true, waMessageId: 'wamid.btn' });
    h.mediosDePago.mockResolvedValue({ cuentas: [], enlace_para_pagar: 'https://x' });
});


const escuelaHace = (s: number, texto = 'Hola cómo estás') =>
    ({ direction: 'outbound', ai_generated: false, text_body: texto, wa_timestamp: hace(s), created_at: hace(s) });
const salio = () => borradores().length + h.sendTextMessage.mock.calls.length;
const abiertaSinPush = () => h.state.updates.some((u) => u.table === 'whatsapp_conversations' && u.row.status === 'open');

describe('(a) «Dejo tu mensaje para…» no se repite encima de la escuela', () => {
    it('«Mile, …» con la escuela escribiendo hace 1 h → ni presentación ni mensaje', async () => {
        h.state.mensajes = [escuelaHace(3600, 'Isa te toca ir en reemplazo del miércoles')];
        await runBotTurn(INTEGRATION, CONV, TEL, 'Mile, hoy no le toca a Paola', 'w1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(salio()).toBe(0);
        expect(abiertaSinPush()).toBe(true);
    });

    it('sin escuela en la charla sigue saliendo «Dejo tu mensaje para Milena 🙌» (comportamiento de siempre)', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Mile, hoy no le toca a Paola', 'w1');
        expect(borradores()[0].row.proposed_text).toContain('Dejo tu mensaje para Milena 🙌');
    });
});

describe('(d) el modelo no opina ni promete en una charla de la escuela', () => {
    it('Andrea P: la escuela escribió hace 19 min → el modelo no contesta («quedo atento…»)', async () => {
        h.state.mensajes = [escuelaHace(19 * 60, 'Ya voy a verificar lo de uniformes')];
        h.chatWithTools.mockResolvedValue({ text: '¡Listo, quedo atento a lo que confirmen tú y tu esposo! 😊', toolCalls: [], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Dale Teacher mi esposo está confirmando las fechas porq tiene un cuaje', 'w1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(salio()).toBe(0);
    });

    it('sin escuela en la charla, la promesa «quedo atento» se quita del texto del modelo', async () => {
        h.chatWithTools.mockResolvedValue({
            text: 'Ya le pasé la duda a la escuela. Quedo atento a lo que confirmen. Cualquier cosa me cuentas.', toolCalls: [], provider: 'test',
        });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Gracias, cualquier cosa te cuento', 'w1');
        const textos = borradores().map((b) => b.row.proposed_text).join('\n');
        expect(textos).toContain('Ya le pasé la duda a la escuela.');
        expect(textos).not.toMatch(/quedo atento/i);
    });

    it('Paola Rodríguez: una queja contra la escuela → solo el aviso (escalated), sin modelo ni consuelo', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL,
            'Quiero poner una queja como es posible que las otras compañeras de Mariana las subieron a competitivo y a Mariana no', 'w1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(pasos()).toEqual(['escalated']);
    });

    it('Paola: el modelo ya no suelta «es normal alterarse» tras un escalated del mismo turno', async () => {
        h.chatWithTools.mockResolvedValue({
            text: 'Entiendo, es normal alterarse cuando se trata de tu hija. Ya le pasé tu mensaje a la escuela.',
            toolCalls: [{ name: 'escalate_to_human', args: { reason: 'queja' } }], provider: 'test',
        });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Pero al ver a Mariana llorando tanto me alteré', 'w1');
        expect(pasos().filter((p) => p === 'escalated')).toHaveLength(1);
        expect(pasos()).not.toContain('llm_text');
    });
});

describe('(b) la clase de prueba no se ofrece a una familia con ficha por una frase suelta', () => {
    it('Gabriela V: «Pipeee Tenemos cupoo» → el modelo llama get_trial_class_info y NO sale cortesia_perfil', async () => {
        h.chatWithTools.mockResolvedValue({ text: '', toolCalls: [{ name: 'get_trial_class_info', args: {} }], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Tenemos cupoo', 'w1');
        expect(pasos()).not.toContain('cortesia_perfil');
        expect(salio()).toBe(0);
    });

    it('si la familia pide la clase de prueba con esas palabras, sí sale la oferta', async () => {
        h.chatWithTools.mockResolvedValue({ text: '', toolCalls: [{ name: 'get_trial_class_info', args: {} }], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Quiero una clase de prueba para mi sobrino', 'w1');
        expect(salio()).toBeGreaterThan(0);
    });
});

describe('(c) familia sin cuenta: «Créala aquí» solo si la pide o va a pagar', () => {
    beforeEach(() => {
        h.state.identify = { estado: 'debe_registrarse' };
        h.state.conv = { id: CONV, parent_id: null, identified: false, status: 'closed', contact_name: 'F.' };
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia_sin_cuenta', botEncendido: true });
    });
    const sinInvitacion = () => expect(pasos()).not.toContain('debe_registrarse');

    it('Olinda: «Hola buenas tardes» → sin invitación', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Hola buenas tardes', 'w1');
        sinInvitacion();
        expect(salio()).toBe(0);
    });

    it('Keynor Rey: nota de voz sobre congelar la mensualidad → a la escuela, sin invitación', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL,
            '🎤 Hola profe, ¿qué tal? te quería decir una cosita, todavía no puedo afirmar que pueda volver esta semana, tuve que comprar un celular', 'w1');
        sinInvitacion();
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('Mónica Ramírez: «el vacacional es aparte de la mensualidad que venimos pagando?» → sin invitación', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL,
            'Felipe, te quería hacer una pregunta, no tengo clara la información del mensaje que nos enviaste, el vacacional es aparte de la mensualidad?', 'w1');
        sinInvitacion();
    });

    it('quien pregunta por su cuenta SÍ recibe la invitación', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'No me deja crear mi cuenta en la app', 'w1');
        expect(pasos()).toContain('debe_registrarse');
    });
});

describe('(e) carrera con el eco de la escuela', () => {
    it('Yeins Q: la escuela escribe «Hola cómo estás» mientras el modelo redactaba el saludo → no sale', async () => {
        h.chatWithTools.mockImplementation(async () => {
            // El eco de la escuela llega mientras el modelo redactaba.
            h.state.mensajes = [escuelaHace(5)];
            return { text: '¡Buenas tardes! 👋 Soy Mapi, el asistente virtual de la escuela. ¿En qué te puedo colaborar?', toolCalls: [], provider: 'test' };
        });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Buenas tardes', 'w1');
        expect(pasos()).not.toContain('llm_text');
        expect(salio()).toBe(0);
    });
});
