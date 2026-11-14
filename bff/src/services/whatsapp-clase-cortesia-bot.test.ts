/**
 * Clase de cortesía enchufada al bot: el desconocido que pregunta (prospecto),
 * el que sigue a mitad del flujo, y el freno del saludo «ask_email».
 *
 * Mismo andamiaje que whatsapp-atencion-bot.test.ts: Supabase con builder
 * encadenable, `debeAtender` y el envío mockeados. Ni base ni Meta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        rpcCalls: { fn: string; args: any }[];
    } = { resolve: () => ({ data: null, error: null }), rpc: () => ({ data: null, error: null }), inserts: [], rpcCalls: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'update', 'is', 'not']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, ops));
        b.single = () => Promise.resolve(state.resolve(table, ops));
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => { state.rpcCalls.push({ fn, args }); return Promise.resolve(state.rpc(fn, args)); },
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
    return {
        // Lo puro (puerta de prospecto, intereses…) va REAL; `ajustesDeAtencion`
        // también: con la fila mockeada vacía, `responder_prospectos` queda prendido.
        ...real,
        debeAtender: h.debeAtender,
        botEncendido: h.botEncendido,
        temaEscolar: real.temaEscolar,
        preguntaPrecioComoProspecto: real.preguntaPrecioComoProspecto,
    };
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
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Dynasty', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { runBotTurn, _olvidarReservasDePaso, _limpiarCacheVocativos } from './whatsapp-bot.service';
import { BOTON_CC } from './whatsapp-clase-cortesia.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const DESCONOCIDO = { atender: false, tipo: 'desconocido', botEncendido: true } as const;

const mensaje = (over: Record<string, any> = {}) => ({
    phoneNumberId: 'pn-1', contactWaId: '573209998877', contactName: null,
    waMessageId: 'wamid.1', type: 'text', textBody: 'hola', raw: {}, waTimestamp: null, ...over,
}) as any;

// Franjas lejos en el futuro: la prueba no caduca con el calendario.
const FRANJAS = [
    { id: 'slot-1', label: 'Sub-15', slot_date: '2030-01-12', start_time: '17:00:00', end_time: '18:30:00', location: 'Sede principal Dynasty', spots_left: 3 },
    { id: 'slot-2', label: 'Sub-17', slot_date: '2030-01-13', start_time: '18:00:00', end_time: '19:30:00', location: 'Sede principal Dynasty', spots_left: 1 },
];

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');

/**
 * `ultimoSaliente`: payload del último mensaje del bot (el estado del flujo).
 * `pasos`: steps ya enviados (cuentan para frenos de 30 días / 24 h).
 */
function base(op: { franjas?: any[]; ultimoSaliente?: any; pasos?: string[]; identificado?: boolean } = {}) {
    h.state.resolve = (table, ops) => {
        const pasoPedido = ops.find(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step'))?.[1]?.[1];
        if ((table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') && pasoPedido) {
            return { count: op.pasos?.includes(pasoPedido) ? 1 : 0, error: null };
        }
        if (table === 'whatsapp_messages' && ops.some(([m]) => m === 'order')) {
            return { data: op.ultimoSaliente ? { payload: op.ultimoSaliente, created_at: new Date().toISOString() } : null, error: null };
        }
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: null, identified: op.identificado ?? false, status: 'open', contact_name: null }, error: null };
        }
        if (table === 'school_join_qr_codes') return { data: [], error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1', slug: 'dynasty-volley-club' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'school_signup_leads') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'list_open_trial_slots_public') return { data: op.franjas ?? [], error: null };
        if (fn === 'wa_identify_by_phone') return { data: { estado: 'desconocido' }, error: null };
        return { data: null, error: null };
    };
    h.debeAtender.mockResolvedValue(DESCONOCIDO);
    h.botEncendido.mockResolvedValue(true);
}

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcCalls = [];
});

describe('desconocido (prospecto) pregunta por la clase de cortesía', () => {
    it('«Clase de cortesía tienen» con franjas → las ofrece con botones, sin modelo, y cuenta para el freno de 30 días', async () => {
        base({ franjas: FRANJAS });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Clase de cortesía tienen' }));

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('asistente virtual');
        expect(b.proposed_text).toContain('*Sub-15* — sábado 12 de enero');
        expect(b.tool_context).toMatchObject({
            step: 'desconocido_tema_escolar', flujo: 'clase_cortesia', paso_cortesia: 'elegir_franja',
        });
        expect(b.tool_context.botones.map((x: any) => x.id)).toEqual([`${BOTON_CC.FRANJA}slot-1`, `${BOTON_CC.FRANJA}slot-2`]);
    });

    it('sin franjas cargadas (Dynasty hoy) → lo dice y ofrece dejar los datos', async () => {
        base({ franjas: [] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Clase de cortesía tienen' }));
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('no tengo horarios de *clase de cortesía* publicados');
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', paso_cortesia: 'dejar_datos' });
    });

    it('a mitad del flujo, «Valentina Ríos» NO es tema escolar pero se atiende (pide la edad)', async () => {
        base({
            franjas: FRANJAS,
            ultimoSaliente: { step: 'cortesia_nombre', flujo: 'clase_cortesia', paso_cortesia: 'nombre', datos_cortesia: {} },
            pasos: ['desconocido_tema_escolar'],
        });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Valentina Ríos' }));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.proposed_text).toContain('*edad*');
        expect(borradores()[0].row.tool_context).toMatchObject({ paso_cortesia: 'edad' });
    });

    it('confirmar desde un desconocido reserva con submit_school_lead (la RPC del formulario) y el celular de 10 dígitos', async () => {
        const franja = { id: 'slot-1', grupo: 'Sub-15', fecha: '2030-01-12', horaInicio: '17:00', horaFin: '18:30', sede: 'Sede principal Dynasty', cupos: 3 };
        base({
            franjas: FRANJAS,
            ultimoSaliente: {
                step: 'cortesia_confirmar', flujo: 'clase_cortesia', paso_cortesia: 'confirmar',
                datos_cortesia: { franja, nombre: 'Valentina Ríos', edad: 11, fechaNacimiento: null, acudiente: 'Paula Ríos' },
            },
        });
        h.state.rpc = (fn) => {
            if (fn === 'list_open_trial_slots_public') return { data: FRANJAS, error: null };
            if (fn === 'submit_school_lead') return { data: { ok: true, lead_id: 'lead-9', duplicate: false }, error: null };
            return { data: null, error: null };
        };
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'interactive', textBody: 'Confirmar', botonId: BOTON_CC.CONFIRMAR }));

        const llamada = h.state.rpcCalls.find((c) => c.fn === 'submit_school_lead');
        expect(llamada?.args).toMatchObject({
            p_slug: 'dynasty-volley-club', p_full_name: 'Valentina Ríos', p_phone: '3209998877',
            p_guardian_name: 'Paula Ríos', p_trial_slot_id: 'slot-1',
        });
        expect(borradores()[0].row.proposed_text).toContain('Quedó reservada');
    });

    it('«Quiero inscribir a mi hija» con franjas → además del saludo, ofrece la clase de cortesía', async () => {
        base({ franjas: FRANJAS });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Quiero inscribir a mi hija a volleyball' }));
        expect(borradores()[0].row.proposed_text).toContain('puedes venir a una *clase de cortesía* gratis');
    });

    it('freno de 30 días: no se vuelve a OFRECER', async () => {
        base({ franjas: FRANJAS, pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Clase de cortesía tienen' }));
        expect(borradores()).toHaveLength(0);
    });
});

describe('freno del saludo ask_email (responder_desconocidos=true)', () => {
    it('la primera vez saluda', async () => {
        base();
        await runBotTurn(INTEGRATION, CONV, '573209998877', 'Buenas, una consulta sobre lo del fin de semana', 'wamid.1');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'ask_email' });
    });

    it('a un saludo, «gracias» o emoji suelto no le pide el correo (2026-10-07)', async () => {
        base();
        for (const t of ['hola', 'Buenas tardes', 'gracias', '👍', 'Hola buen día, espero se encuentre bien']) {
            await runBotTurn(INTEGRATION, CONV, '573209998877', t, `wamid.s-${t}`);
        }
        expect(borradores()).toHaveLength(0);
    });

    it('si ya saludó en las últimas 24 h, se calla (medido 2026-10-06: varias veces seguidas al mismo contacto)', async () => {
        base({ pasos: ['ask_email'] });
        await runBotTurn(INTEGRATION, CONV, '573209998877', 'hola?', 'wamid.2');
        await runBotTurn(INTEGRATION, CONV, '573209998877', 'buenos días', 'wamid.3');
        expect(borradores()).toHaveLength(0);
    });

    it('pero si pregunta por la clase de cortesía, sí le contesta', async () => {
        base({ pasos: ['ask_email'], franjas: FRANJAS });
        await runBotTurn(INTEGRATION, CONV, '573209998877', '¿tienen clase de prueba?', 'wamid.4');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ flujo: 'clase_cortesia' });
    });
});

describe('auditoría Dynasty 2026-10-07: correo en la ráfaga y saludo con el nombre de quien atiende', () => {
    const conRafaga = (filas: { id: string; texto: string }[]) => {
        const previo = h.state.resolve;
        const ahora = new Date().toISOString();
        h.state.resolve = (table, ops) => {
            if (table === 'whatsapp_messages'
                && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('wa_message_id, direction'))) {
                return {
                    data: filas.map((f) => ({ wa_message_id: f.id, direction: 'inbound', type: 'text', text_body: f.texto, created_at: ahora })),
                    error: null,
                };
            }
            return previo(table, ops);
        };
    };
    const conEquipo = () => {
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => {
            if (table === 'profiles') return { data: [{ full_name: 'Milena Pérez' }], error: null };
            return previo(table, ops);
        };
    };

    it('el correo de un mensaje ANTERIOR de la ráfaga arranca el OTP (…5281: correo → nombre → «Soy la mamá»)', async () => {
        _olvidarReservasDePaso();
        base({ pasos: ['ask_email'] });
        conRafaga([
            { id: 'wamid.r1', texto: 'mama.prueba@correo.com' },
            { id: 'wamid.r2', texto: 'Ana Pérez' },
            { id: 'wamid.r3', texto: 'Soy la mamá' },
        ]);
        await runBotTurn(INTEGRATION, 'conv-r', '573209998877', 'Soy la mamá', 'wamid.r3');
        const otp = h.state.rpcCalls.find((c) => c.fn === 'wa_start_identification');
        expect(otp?.args.p_email).toBe('mama.prueba@correo.com');
        expect(borradores().map((b) => b.row.tool_context?.step)).toContain('otp_sent');
    });

    it('«hola mile», «Hola Mile...buenas tardes...como estas?» y «dale mile / quedo pendiente» no piden el correo', async () => {
        _olvidarReservasDePaso();
        _limpiarCacheVocativos();
        base();
        conEquipo();
        for (const t of ['hola mile\ncomo estas??', 'Hola Mile...buenas tardes...como estas?', 'dale mile\nquedo pendiente\ngracias']) {
            await runBotTurn(INTEGRATION, `conv-${t.length}`, '573209998877', t, `wamid.v-${t.length}`);
        }
        expect(borradores()).toHaveLength(0);
    });

    it('2026-10-07 tarde: charla corta o con vocativo sin tema escolar → silencio', async () => {
        _olvidarReservasDePaso();
        _limpiarCacheVocativos();
        base();
        conEquipo();
        for (const t of ['noooo', 'De comida', 'No puedo pasar!', 'como estas??', 'Profe no tienen respuesta aún si se arranca este fin de semana']) {
            await runBotTurn(INTEGRATION, `conv-ch-${t.length}`, '573209998877', t, `wamid.ch-${t.length}`);
        }
        expect(borradores()).toHaveLength(0);
    });

    it('2026-10-07 tarde: «mile voy tenemos entreno?» de alguien con quien la escuela conversa (eco en 30 días) → silencio', async () => {
        _olvidarReservasDePaso();
        _limpiarCacheVocativos();
        base();
        conEquipo();
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => {
            if (table === 'whatsapp_messages' && ops.some(([m, a]) => m === 'eq' && a[0] === 'ai_generated' && a[1] === false)) {
                return { data: [{ direction: 'outbound', type: 'text', text_body: 'Hola, cómo estás', ai_generated: false, payload: {}, created_at: new Date().toISOString() }], error: null };
            }
            return previo(table, ops);
        };
        await runBotTurn(INTEGRATION, 'conv-eco', '573209998877', 'mile voy tenemos entreno?', 'wamid.eco1');
        expect(borradores()).toHaveLength(0);
    });

    it('con contenido sí lo pide: «mile tenemos entreno?»', async () => {
        _olvidarReservasDePaso();
        _limpiarCacheVocativos();
        base();
        conEquipo();
        await runBotTurn(INTEGRATION, 'conv-c', '573209998877', 'mile voy tenemos entreno?', 'wamid.c1');
        expect(borradores().map((b) => b.row.tool_context?.step)).toEqual(['ask_email']);
    });
});
