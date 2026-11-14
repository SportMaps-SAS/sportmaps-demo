/**
 * Silencio cuando el equipo ya está atendiendo (corrección A, Monster 2026-11-06): reglas puras y el enganche en
 * `atenderDesconocido`. Casos reales: …3191 (30 mensajes con el equipo, «Hola / Oye / el entreno es mixto?») y el
 * contacto del equipo que le escribe a «Pipe». Y el interesado nuevo, que sigue recibiendo bienvenida.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: { resolve: (table: string, ops: Ops) => any; inserts: { table: string; row: any }[] } =
        { resolve: () => ({ data: null, error: null }), inserts: [] };
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
        supabase: { from: (t: string) => makeBuilder(t), rpc: (_f: string, _a: any) => Promise.resolve({ data: null, error: null }) },
        debeAtender: vi.fn(), botEncendido: vi.fn(), chatWithTools: vi.fn(), sendToUser: vi.fn(),
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
    aFormatoWhatsApp: (t: string) => t, verifyWebhookSignature: vi.fn(), resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []), parseStatuses: vi.fn(() => []), markAsRead: vi.fn(), downloadMedia: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false, proximaAtencion: null })),
    mensajeDeEscalamiento: vi.fn(() => 'Voy a pasar tu caso con una persona del equipo.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn(async () => ({ cuentas: [], enlace_para_pagar: null, link_de_pago: null, instrucciones_del_enlace: null, puede_enviar_comprobante_por_whatsapp: true })) }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}), destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Monster', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'), etiquetaDeContacto: vi.fn(() => 'Contacto'), uuidDeClave: (k: string) => `uuid:${k}`,
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({ procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn() }));
vi.mock('./whatsapp-prospecto-lead.service', () => ({ registrarLeadDeProspecto: vi.fn(async () => {}) }));

import { atenderDesconocido } from './whatsapp-bot.service';
import {
    estadoDeDialogo, esMensajeHumanoReal, pareceSaludoDeApp, silencioDeDialogoActivo, VENTANA_DIALOGO_HORAS,
} from './whatsapp-silencio-conversacion';
import type { FilaReciente } from './whatsapp-reglas-turno';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-3191';
const TEL = '573000003191';
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const entrante = (texto: string, min: number): FilaReciente =>
    ({ wa_message_id: `in-${min}-${texto}`, direction: 'inbound', type: 'text', text_body: texto, payload: {}, ai_generated: null, wa_timestamp: hace(min), created_at: hace(min) });
const humano = (texto: string, min: number, payload: any = { to: TEL }): FilaReciente =>
    ({ wa_message_id: `h-${min}-${texto}`, direction: 'outbound', type: 'text', text_body: texto, payload, ai_generated: false, wa_timestamp: hace(min), created_at: hace(min) });
const bot = (texto: string, min: number, step = 'bienvenida_desconocido'): FilaReciente =>
    ({ wa_message_id: `b-${min}`, direction: 'outbound', type: 'text', text_body: texto, payload: { step }, ai_generated: true, wa_timestamp: hace(min), created_at: hace(min) });

const SALUDO_APP = '¡Hola! Gracias por escribir a Monsters Volley Club. En este momento no podemos responder, te respondemos en breve.';

describe('regla pura: qué cuenta como diálogo humano real', () => {
    it('una charla del equipo (…3191, 30 mensajes) activa el silencio', () => {
        const filas: FilaReciente[] = [];
        for (let i = 0; i < 15; i++) { filas.push(entrante(`pregunta ${i}`, 3000 - i * 100)); filas.push(humano(`respuesta ${i}`, 2990 - i * 100)); }
        const r = estadoDeDialogo(filas);
        expect(r.activo).toBe(true);
        expect(r.humanos).toBeGreaterThanOrEqual(15);
    });

    it('el último humano de hace más de 72 h ya no silencia', () => {
        const filas = [entrante('hola', 5000), humano('claro, te cuento', 4400)];
        expect(4400).toBeGreaterThan(VENTANA_DIALOGO_HORAS * 60);
        expect(estadoDeDialogo(filas).activo).toBe(false);
    });

    it('el saludo de la app Business MARCADO automático no cuenta (interesado nuevo)', () => {
        const filas = [entrante('Hola, info del club', 1), humano(SALUDO_APP, 0.99, { to: TEL, automatico: true })];
        expect(estadoDeDialogo(filas).activo).toBe(false);
    });

    it('el saludo de la app AÚN sin marca (primero de la conversación, 3 s tras el entrante, con forma de saludo) no cuenta', () => {
        const filas = [
            { ...entrante('Hola', 2), wa_timestamp: hace(2), created_at: hace(2) },
            { ...humano(SALUDO_APP, 2), wa_timestamp: new Date(Date.now() - 2 * 60_000 + 3000).toISOString(), created_at: new Date(Date.now() - 2 * 60_000 + 3000).toISOString() },
        ];
        expect(estadoDeDialogo(filas).activo).toBe(false);
    });

    it('la misma frase DESPUÉS de una charla del equipo sí cuenta (no es el primer saliente)', () => {
        const filas = [entrante('hola', 600), humano('Hola, te cuento del club', 599), entrante('Hola', 2), humano('Hola, gracias por escribir, claro que sí', 1.95)];
        expect(estadoDeDialogo(filas).activo).toBe(true);
    });

    it('lo del bot, las plantillas, las campañas y los recordatorios no cuentan', () => {
        const filas = [
            entrante('hola', 100), bot('Hola, soy el asistente', 99),
            humano('Recordatorio de tu clase', 90, { to: TEL, step: 'recordatorio_cortesia' }),
            humano('Promo de noviembre', 80, { to: TEL, campana_id: 'c1' }),
            { ...humano('plantilla', 70), type: 'template' },
            { ...humano('👍', 60), type: 'reaction' },
        ];
        expect(estadoDeDialogo(filas).activo).toBe(false);
    });

    it('una respuesta rápida manual de una persona (payload.manual) sí cuenta', () => {
        expect(esMensajeHumanoReal(humano('Bienvenidos a Monsters', 10, { to: TEL, manual: true, automatico: true }), [])).toBe(true);
    });

    it('pareceSaludoDeApp reconoce el saludo y el texto configurado, no una respuesta real', () => {
        expect(pareceSaludoDeApp(SALUDO_APP)).toBe(true);
        expect(pareceSaludoDeApp('Hola, bienvenidos a Monsters. ¿En qué te podemos ayudar?')).toBe(true);
        expect(pareceSaludoDeApp('El entreno es mixto, sí. Te espero el sábado', [])).toBe(false);
        expect(pareceSaludoDeApp('Texto propio del club', ['texto propio del club'])).toBe(true);
    });

    it('la función se apaga con WA_SILENCIO_DIALOGO_EQUIPO=false', () => {
        expect(silencioDeDialogoActivo({} as any)).toBe(true);
        expect(silencioDeDialogoActivo({ WA_SILENCIO_DIALOGO_EQUIPO: 'false' } as any)).toBe(false);
    });
});

// ─── Enganche en atenderDesconocido ──────────────────────────────────────────

function base(filas: FilaReciente[]) {
    h.state.resolve = (table, ops) => {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
        if (table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') {
            if (paso) return { count: 0, data: [], error: null };
        }
        if (table === 'whatsapp_messages') {
            if (ops.some(([m]) => m === 'update')) return { data: [{ id: 'm' }], error: null };
            const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
            if (direccion === 'inbound') return { data: filas.filter((f) => f.direction === 'inbound'), error: null };
            if (direccion === 'outbound') return { data: filas.filter((f) => f.direction === 'outbound'), error: null };
            return { data: filas, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') return { data: { id: CONV, contact_wa_id: TEL, parent_id: null, identified: false, status: 'open', tomada_hasta: null }, error: null };
        if (table === 'school_whatsapp_integrations') return { data: INTEGRATION, error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: false, responder_prospectos: true }, error: null };
        if (table === 'school_settings') return { data: { business_hours: null }, error: null };
        if (table === 'schools') return { data: { name: 'MONSTERS VOLLEY CLUB', owner_id: 'o1', slug: 'monsters' }, error: null };
        return { data: table.startsWith('school_') || table === 'teams' ? [] : null, error: null };
    };
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
}
const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);

beforeEach(() => { vi.clearAllMocks(); h.state.inserts = []; delete process.env.WA_SILENCIO_DIALOGO_EQUIPO; });
afterEach(() => { delete process.env.WA_SILENCIO_DIALOGO_EQUIPO; });

describe('atenderDesconocido con el equipo en diálogo', () => {
    // El equipo habló hace 20 h (fuera de los 15 min de siempre, pero dentro de las 72 h).
    const charla: FilaReciente[] = [
        entrante('Hola, quiero info del club', 1500), humano('Hola Karol, claro, te cuento…', 1490),
        entrante('Gracias, y los horarios?', 1450), humano('Martes y jueves 6 pm', 1440),
    ];

    it('…3191: «Hola» tras la charla con el equipo → silencio total (sin saludo ni «Elige sede»)', async () => {
        base([...charla, entrante('Hola', 0.3)]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola');
        expect(r).toBe('escuela_atendiendo');
        expect(borradores()).toHaveLength(0);
        expect(h.state.inserts.filter((i) => i.table === 'whatsapp_messages')).toHaveLength(0);
    });

    it('…3191: «el entreno es mixto?» tampoco recibe nada del bot', async () => {
        base([...charla, entrante('Oye', 0.5), entrante('el entreno es mixto?', 0.3)]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'el entreno es mixto?');
        expect(r).toBe('escuela_atendiendo');
        expect(borradores()).toHaveLength(0);
    });

    it('contacto del equipo que le escribe a «Pipe»: con charla previa, el bot no contesta', async () => {
        base([humano('Hola, ¿cómo vas?', 3000), entrante('Hola Pipe, ¿cómo vas?', 1)]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola Pipe, ¿cómo vas?');
        expect(r).toBe('escuela_atendiendo');
        expect(borradores()).toHaveLength(0);
    });

    it('interesado NUEVO (solo el saludo automático de la app): NO queda en silencio por esta regla', async () => {
        base([
            entrante('Hola, quiero info', 1),
            humano(SALUDO_APP, 0.99, { to: TEL, automatico: true }),
            entrante('Hola', 0.2),
        ]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola');
        expect(r).not.toBe('escuela_atendiendo');
    });

    it('con la función apagada, el bot actúa como antes (no devuelve escuela_atendiendo por el diálogo)', async () => {
        process.env.WA_SILENCIO_DIALOGO_EQUIPO = 'false';
        base([...charla, entrante('Hola', 0.3)]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola');
        expect(r).not.toBe('escuela_atendiendo');
    });

    it('el diálogo de hace más de 72 h no silencia', async () => {
        base([entrante('hola', 5000), humano('claro', 4500), entrante('Hola', 0.3)]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Hola');
        expect(r).not.toBe('escuela_atendiendo');
    });
});
