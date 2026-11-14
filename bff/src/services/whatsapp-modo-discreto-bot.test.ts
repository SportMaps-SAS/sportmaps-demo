/**
 * Modo discreto en el turno del bot (análisis de las 604 conversaciones de
 * Dynasty, 2026-10-29): «si Milena entra a escribir, el bot no debe responder
 * solo» y «no podemos ir respondiendo por responder cualquier cosa».
 *
 * Mismo andamiaje que whatsapp-auditoria-2026-10-10-bot.test.ts. Datos inventados.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        rpcCalls: { fn: string; args: any }[];
    } = {
        resolve: () => ({ data: null, error: null }),
        rpc: () => ({ data: null, error: null }),
        inserts: [],
        rpcCalls: [],
    };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'delete']) {
            b[m] = chain(m);
        }
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.upsert = (row: any) => { ops.push(['upsert', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, ops));
        b.single = () => Promise.resolve(state.resolve(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => {
                state.rpcCalls.push({ fn, args });
                return Promise.resolve(state.rpc(fn, args));
            },
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendInteractiveButtons: vi.fn(),
        sendCtaUrl: vi.fn(),
        sendToUser: vi.fn(),
        mediosDePago: vi.fn(),
        avisarEscalamientoPorCorreo: vi.fn(),
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
    sendCtaUrl: h.sendCtaUrl,
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('./whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(async () => false),
    AVISO_DADO_DE_BAJA: '\n\n(baja)',
}));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: true })),
    mensajeDeEscalamiento: vi.fn(() => 'Ahora mismo están fuera del horario de atención, así que te responden hoy a las 16:00.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({
    mediosDePago: h.mediosDePago,
    mediosDePagoDeFamilia: async (schoolId: string) => ({ ...(await h.mediosDePago(schoolId)), cobros_pendientes: [] }),
}));
vi.mock('./whatsapp-info-escuela.service', () => ({
    infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn(), horariosDelDia: vi.fn(async () => null), textoHorarioDeHoy: vi.fn(),
}));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', async () => {
    const real = await vi.importActual<typeof import('./avisos-correo.service')>('./avisos-correo.service');
    return { ...real, avisarEscalamientoPorCorreo: h.avisarEscalamientoPorCorreo };
});

import { runBotTurn, atenderDesconocido, revisarRetomas } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const PADRE = 'parent-1';
const TEL = '573000000001';
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Lo que salió por WhatsApp (texto o botones). */
const enviados = () => [
    ...h.sendTextMessage.mock.calls.map((c: any[]) => c[2] as string),
    ...h.sendInteractiveButtons.mock.calls.map((c: any[]) => c[2] as string),
];
const avisosAlEquipo = () => h.state.inserts.filter((i) => i.table === 'notifications');

/** Eco del celular de Milena (Coexistence). */
const ecoDeMilena = (min: number, texto = 'Hola mi Carito') => ({
    wa_message_id: `wamid.m${min}`, direction: 'outbound', type: 'text', text_body: texto, ai_generated: false,
    payload: { from: '573000000999', text: { body: texto } }, created_at: hace(min), wa_timestamp: hace(min),
});
const entrante = (min: number, texto: string) => ({
    wa_message_id: `wamid.i${min}`, direction: 'inbound', type: 'text', text_body: texto, ai_generated: false,
    payload: {}, created_at: hace(min), wa_timestamp: hace(min),
});

/**
 * `filasTurno`: lo que ve el turno al empezar (`mensajesRecientes`, limit 120).
 * `filasEnvio`: lo que ve `deliver` justo antes de enviar (`escuelaActiva`, limit 200).
 */
function base(op: {
    identified?: boolean;
    estadoTelefono?: string;
    filasTurno?: any[];
    filasEnvio?: any[];
}) {
    const identified = op.identified ?? true;
    h.state.resolve = (table, ops) => {
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: identified ? PADRE : null, identified, status: 'closed', contact_name: 'Carolina' }, error: null };
        }
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'auto', assisted_until: null }, error: null };
        if (table === 'whatsapp_optins') return { data: { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null }, error: null };
        if (table === 'schools') return { data: { name: 'Escuela Ejemplo', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'whatsapp_messages') {
            const limite = ops.find(([n]) => n === 'limit')?.[1]?.[0];
            if (limite === 200) return { data: op.filasEnvio ?? op.filasTurno ?? [], count: 0, error: null };
            if (limite === 120) return { data: op.filasTurno ?? [], count: 0, error: null };
            return { data: [], count: 0, error: null };
        }
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') {
            return { data: { estado: op.estadoTelefono ?? 'identificado', parent_id: identified ? PADRE : null }, error: null };
        }
        return { data: null, error: null };
    };
}

const turno = (texto: string, waId = 'wamid.i0') => runBotTurn(INTEGRATION, CONV, TEL, texto, waId);

beforeEach(() => {
    process.env.WHATSAPP_MODO_DISCRETO = 'true';
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcCalls = [];
    h.chatWithTools.mockResolvedValue({ text: 'Tu saldo es $180.000', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.sendInteractiveButtons.mockResolvedValue({ ok: true, waMessageId: 'wamid.btn' });
    h.sendCtaUrl.mockResolvedValue({ ok: true, waMessageId: 'wamid.cta' });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
    h.mediosDePago.mockResolvedValue({
        cuentas: [{ tipo: 'Nequi', numero: '3001234567', titular: 'Escuela Ejemplo' }], link_de_pago: null, enlace_para_pagar: null,
    });
});

afterEach(() => {
    process.env.WHATSAPP_MODO_DISCRETO = 'false';
});

describe('si Milena entra a escribir, el bot no responde solo', () => {
    it('Milena escribió hace 2 h → nada (antes la ventana era de 15 min)', async () => {
        base({ filasTurno: [entrante(0, '¿Me pasas la cuenta para pagar?'), ecoDeMilena(120)] });
        await turno('¿Me pasas la cuenta para pagar?');
        expect(enviados()).toHaveLength(0);
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('Milena escribe MIENTRAS el turno corre → deliver no envía (la carrera de «¿Qué edad tiene Soy?»)', async () => {
        base({
            filasTurno: [entrante(0, '¿Me pasas la cuenta para pagar?')],
            filasEnvio: [entrante(0, '¿Me pasas la cuenta para pagar?'), ecoDeMilena(0, 'Holaaaaa Karol')],
        });
        await turno('¿Me pasas la cuenta para pagar?');
        expect(enviados()).toHaveLength(0);
    });

    it('sin Milena en la charla, cómo pagar (información pública) sí sale', async () => {
        base({ filasTurno: [entrante(0, '¿Me pasas la cuenta para pagar?')] });
        await turno('¿Me pasas la cuenta para pagar?');
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toMatch(/3001234567/);
    });
});

describe('no responder por responder', () => {
    it('«Hola Milena, ¿cómo estás?» → silencio: sin «Dejo tu mensaje para Milena» ni push', async () => {
        base({ filasTurno: [entrante(0, 'Hola Milena, ¿cómo estás?')] });
        await turno('Hola Milena, ¿cómo estás?');
        expect(enviados()).toHaveLength(0);
        expect(h.sendToUser).not.toHaveBeenCalled();
        expect(avisosAlEquipo()).toHaveLength(0);
    });

    it('«Mile, ¿será que me puedes cambiar la talla de la camisa?» en versalitas también es para ella', async () => {
        // El parser ya lo deja en letras normales (whatsapp-letras-decorativas).
        base({ filasTurno: [entrante(0, 'mile sera q me puedes cambiar la talla de la camisa por m')] });
        await turno('mile sera q me puedes cambiar la talla de la camisa por m');
        expect(enviados()).toHaveLength(0);
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('«Quiero hablar con alguien» de una familia → lo ve la escuela; sin «fuera del horario… 16:00»', async () => {
        base({ filasTurno: [entrante(0, 'Quiero hablar con una persona por favor')] });
        await turno('Quiero hablar con una persona por favor');
        expect(enviados()).toHaveLength(0);
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it('«¿Cuánto debo?» → no pasa por el modelo (los cobros los confirma la escuela)', async () => {
        base({ filasTurno: [entrante(0, 'Buenas, ¿cuánto debo de este mes?')] });
        await turno('Buenas, ¿cuánto debo de este mes?');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(enviados()).toHaveLength(0);
    });

    it('«Mi hija ya no va a seguir en el club» → sin «Le paso tu solicitud de retiro» ni push', async () => {
        base({ filasTurno: [entrante(0, 'Hola, mi hija ya no va a seguir en el club, que no me sigan cobrando')] });
        await turno('Hola, mi hija ya no va a seguir en el club, que no me sigan cobrando');
        expect(enviados()).toHaveLength(0);
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it('una incidencia urgente sí se escala (aviso a la escuela)', async () => {
        base({ filasTurno: [entrante(0, 'Estamos en la cancha y no ha llegado el profe a dar la clase')] });
        await turno('Estamos en la cancha y no ha llegado el profe a dar la clase');
        expect(enviados().join(' ')).toMatch(/urgente/i);
    });
});

describe('números sin ficha', () => {
    it('dos cuentas con el mismo número → silencio, sin «Voy a pasar tu caso»', async () => {
        base({ identified: false, estadoTelefono: 'ambiguo', filasTurno: [entrante(0, 'Hola buenas tardes')] });
        await turno('Hola buenas tardes');
        expect(enviados()).toHaveLength(0);
    });

    it('un número sin ficha que habla de SUS cobros → no se le pide el correo', async () => {
        base({ identified: false, estadoTelefono: 'desconocido' });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola, ¿cuánto debo de la mensualidad de mi hija?');
        expect(r).toBe('silencio');
        expect(enviados().join(' ')).not.toMatch(/correo/i);
    });
});

describe('retoma', () => {
    it('en modo discreto el bot no retoma solo una conversación que la escuela tomó', async () => {
        base({});
        expect(await revisarRetomas()).toEqual({ revisadas: 0, respondidas: 0, reavisadas: 0 });
    });
});
