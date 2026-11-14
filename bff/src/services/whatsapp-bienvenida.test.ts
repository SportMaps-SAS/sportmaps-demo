/**
 * Bienvenida al desconocido que solo saluda (whatsapp-bienvenida.ts): reglas puras y el
 * cableado en `atenderDesconocido`. Mismo andamiaje que whatsapp-retoma-y-pago-publico.test.ts
 * (modo asistido: lo que «sale» queda como borrador). Teléfonos y escuela de ejemplo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
    } = { resolve: () => ({ data: null, error: null }), rpc: () => ({ data: null, error: null }), inserts: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains', 'ilike']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.upsert = (row: any) => { ops.push(['upsert', [row]]); return b; };
        b.maybeSingle = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.single = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => Promise.resolve(state.rpc(fn, args)),
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendToUser: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: h.botEncendido };
});
vi.mock('./llm.service', () => ({ chatWithTools: h.chatWithTools }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    verifyWebhookSignature: vi.fn(),
    resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []),
    parseStatuses: vi.fn(() => []),
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false, proximaAtencion: null })),
    mensajeDeEscalamiento: vi.fn(() => 'Voy a pasar tu caso con una persona del equipo. En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({
    mediosDePago: vi.fn(async () => ({
        cuentas: [{ tipo: 'Bre-B Bancolombia', titular: 'Dynasty Volley Club', numero: '@dynastyejemplo' }],
        enlace_para_pagar: 'https://checkout.wompi.co/l/EJEMPLO',
        link_de_pago: 'https://checkout.wompi.co/l/EJEMPLO',
        instrucciones_del_enlace: null,
        puede_enviar_comprobante_por_whatsapp: true,
    })),
}));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Dynasty', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
    etiquetaDeContacto: vi.fn(() => 'Contacto de prueba'),
    uuidDeClave: (k: string) => `uuid:${k}`,
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));
vi.mock('./whatsapp-prospecto-lead.service', () => ({ registrarLeadDeProspecto: vi.fn(async () => {}) }));

import { atenderDesconocido, _olvidarReservasDePaso } from './whatsapp-bot.service';
import { esSaludoDeBienvenida, bienvenidaHabilitada, PASO_BIENVENIDA_DESCONOCIDO } from './whatsapp-bienvenida';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-ejemplo';
const TEL = '573000005281';

type Fila = { wa_message_id: string | null; direction: 'inbound' | 'outbound'; type?: string; text_body: string | null;
    payload?: any; ai_generated: boolean; created_at: string };
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function base(op: { filas?: Fila[]; yaPresentado?: boolean; pasos?: string[] } = {}) {
    const filas = op.filas ?? [];
    const pasos = new Set(op.pasos ?? []);
    h.state.resolve = (table, ops) => {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
        const presentacion = ops.some(([m, a]) => m === 'ilike' && String(a[1]).includes('asistente'));
        const esUpdate = ops.some(([m]) => m === 'update');
        if (table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') {
            if (presentacion) return { count: op.yaPresentado ? 1 : 0, error: null };
            if (paso) return { count: pasos.has(paso) ? 1 : 0, data: [], error: null };
        }
        if (table === 'whatsapp_messages') {
            if (esUpdate) return { data: [{ id: 'm-reservada' }], error: null };
            const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
            if (direccion === 'inbound' && ops.some(([m]) => m === 'order')) {
                // Candidatas de la retoma.
                return { data: [{ conversation_id: CONV, integration_id: 'int-1' }], error: null };
            }
            if (direccion === 'inbound') return { data: filas.filter((f) => f.direction === 'inbound'), error: null };
            if (!direccion) return { data: filas, error: null };
            return { data: null, count: 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, contact_wa_id: TEL, parent_id: null, identified: false, status: 'open', contact_name: null, tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'school_whatsapp_integrations') return { data: INTEGRATION, error: null };
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'school_settings') return { data: { business_hours: null }, error: null };
        if (table === 'school_join_qr_codes') return { data: [{ slug: 'dynasty-inscripcion', target_type: 'open', signup_count: 121 }], error: null };
        if (table === 'schools') return { data: { name: 'DYNASTY VOLLEY CLUB', owner_id: 'owner-1', slug: 'dynasty', address: 'Cl. 12 Bis #71g-09, Bogotá' }, error: null };
        if (table === 'school_trial_slots' || table === 'teams' || table === 'school_branches' || table === 'school_members') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = () => ({ data: null, error: null });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);
const avisos = () => h.state.inserts.filter((i) => i.table === 'notifications').map((i) => i.row);

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    _olvidarReservasDePaso();
    process.env.WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS = 'school-1';
});


const EQUIPO = new Map([['mile', 'Milena'], ['milena', 'Milena']]);
const OPS = { nombreEscuela: 'DYNASTY VOLLEY CLUB', equipo: EQUIPO };

describe('esSaludoDeBienvenida (pura)', () => {
    it.each(['Hola', 'Hola Dynasty 👋', 'Buenos días', 'Buenas tardes!', 'hola buenas noches', 'Hola, ¿cómo estás?', 'Saludos', 'Hola Dynasty Volley Club'])(
        '«%s» es un saludo', (t) => expect(esSaludoDeBienvenida(t, OPS)).toBe(true));

    it.each(['😍', '👏🏻', '', '   ', 'Gracias', 'Ok gracias', 'Hola mile', 'Hola profe', 'Buenos días Milena',
        'Hola, quiero inscribir a mi hija', 'Hola tienen cupo?', 'Hola le escribo de parte del club X', 'Hola Dynasty tengo una propuesta comercial'])(
        '«%s» NO es un saludo de bienvenida', (t) => expect(esSaludoDeBienvenida(t, OPS)).toBe(false));

    it('un texto largo nunca lo es', () => {
        expect(esSaludoDeBienvenida('Hola ' + 'buenas '.repeat(10), OPS)).toBe(false);
    });
});

describe('bienvenidaHabilitada', () => {
    it('solo las escuelas de la lista', () => {
        expect(bienvenidaHabilitada('a', 'a, b')).toBe(true);
        expect(bienvenidaHabilitada('c', 'a, b')).toBe(false);
        expect(bienvenidaHabilitada('a', '')).toBe(false);
        expect(bienvenidaHabilitada('a', undefined)).toBe(false);
    });
});

describe('atenderDesconocido: bienvenida al saludo suelto', () => {
    it('«Hola Dynasty 👋» de un desconocido sin humano → una bienvenida corta con presentación', async () => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola Dynasty 👋');
        expect(r).toBe('bienvenida');
        expect(borradores()).toHaveLength(1);
        const [b] = borradores();
        expect(b.tool_context).toMatchObject({ step: PASO_BIENVENIDA_DESCONOCIDO });
        expect(b.proposed_text).toContain('asistente virtual');
        expect(b.proposed_text).toContain('¿En qué te puedo ayudar?');
        expect(b.proposed_text.length).toBeLessThanOrEqual(500);
    });

    it('una sola vez por conversación: el segundo saludo no repite (ni en la misma ráfaga)', async () => {
        base();
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('bienvenida');
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Buenos días')).toBe('silencio');
        expect(borradores()).toHaveLength(1);
    });

    it('ya hubo una bienvenida en las últimas 24 h (base) → silencio', async () => {
        base({ pasos: [PASO_BIENVENIDA_DESCONOCIDO] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('silencio');
        expect(borradores()).toHaveLength(0);
    });

    it('con la escuela sin activar → silencio, como antes', async () => {
        base();
        process.env.WA_BIENVENIDA_DESCONOCIDOS_SCHOOL_IDS = 'otra-escuela';
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('silencio');
        expect(borradores()).toHaveLength(0);
    });

    it('una persona de la escuela acaba de escribirle → es suya, el bot calla', async () => {
        base({ filas: [{ wa_message_id: 'w1', direction: 'outbound', text_body: 'Hola, te cuento…', ai_generated: false, created_at: hace(30) }] });
        // Oleada 1: con la escuela en diálogo (72 h) el resultado es `escuela_atendiendo` (antes `silencio`): igual no sale nada.
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('escuela_atendiendo');
        expect(borradores()).toHaveLength(0);
    });

    it('conversación tomada desde el buzón → calla', async () => {
        base();
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => table === 'whatsapp_conversations'
            ? { data: { id: CONV, tomada_por: 'u1', tomada_hasta: new Date(Date.now() + 3600_000).toISOString() }, error: null }
            : previo(table, ops);
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('silencio');
        expect(borradores()).toHaveLength(0);
    });

    it.each(['😍', '👏🏻', 'Gracias', 'Ok gracias', 'Hola mile'])('«%s» no recibe bienvenida', async (texto) => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
        expect(r).not.toBe('bienvenida');
        expect(borradores().filter((b) => b.tool_context?.step === PASO_BIENVENIDA_DESCONOCIDO)).toHaveLength(0);
    });

    it('un externo («le escribo de parte de…») sigue yendo al buzón, sin bienvenida', async () => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola, le escribo de parte del club Estrellas para agendar un amistoso');
        expect(r).toBe('externo');
        expect(borradores().filter((b) => b.tool_context?.step === PASO_BIENVENIDA_DESCONOCIDO)).toHaveLength(0);
    });

    it('un saludo con intención («Hola, quiero inscribir a mi hija») lo sigue atendiendo el flujo de siempre', async () => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola, quiero inscribir a mi hija en voleibol');
        expect(r).not.toBe('bienvenida');
        expect(borradores().filter((b) => b.tool_context?.step === PASO_BIENVENIDA_DESCONOCIDO)).toHaveLength(0);
    });

    it('con el bot apagado no se habla', async () => {
        base();
        h.botEncendido.mockResolvedValue(false);
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola')).toBe('silencio');
        expect(borradores()).toHaveLength(0);
    });
});
