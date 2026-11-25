/**
 * Clase de cortesía enchufada al bot: el desconocido que pregunta (prospecto),
 * el que sigue a mitad del flujo, y el freno del saludo «ask_email».
 *
 * Mismo andamiaje que whatsapp-atencion-bot.test.ts: Supabase con builder
 * encadenable, `debeAtender` y el envío mockeados. Ni base ni Meta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import {
    runBotTurn, _olvidarReservasDePaso, _limpiarCacheVocativos, promptConOfertas, presentacionLarga, SYSTEM_PROMPT,
} from './whatsapp-bot.service';
import { BOTON_CC } from './whatsapp-clase-cortesia.service';
import { invalidarCacheOfertas, armarEstado } from './bot-ofertas.service';

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

describe('clase de prueba cerrada por la escuela y convocatorias (bot-ofertas, Monster 2026-11-25)', () => {
    // Un bloqueo que cubre «hoy» siempre y sesiones lejos en el futuro: la prueba no caduca con el calendario.
    const BLOQUEO = { tipo: 'clase_prueba', desde: '2000-01-01', hasta: '2099-12-31', motivo: null };
    const OFERTA = {
        id: 'o-1', tipo: 'convocatoria', titulo: 'Convocatorias Sede Norte', sede: 'Sede Norte', estado: 'activa',
        prioridad: 1, requiere_inscripcion: true, cta: 'Escríbenos el nombre del deportista y a cuál fecha quiere ir.',
    };
    const SESIONES = [
        { id: 's-1', oferta_id: 'o-1', fecha: '2030-01-12', hora_inicio: '07:00:00', hora_fin: '09:00:00', lugar: 'ECCI', genero: 'femenino' },
        { id: 's-2', oferta_id: 'o-1', fecha: '2030-01-12', hora_inicio: '09:00:00', hora_fin: '11:00:00', lugar: 'ECCI', genero: 'masculino' },
    ];
    /** Las tablas de bot-ofertas encima del `base` del caso. */
    function conOfertas(op: { bloqueos?: any[]; ofertas?: any[]; sesiones?: any[] }) {
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => {
            if (table === 'bot_oferta_bloqueos') return { data: op.bloqueos ?? [], error: null };
            if (table === 'bot_ofertas') return { data: op.ofertas ?? [], error: null };
            if (table === 'bot_oferta_sesiones') return { data: op.sesiones ?? [], error: null };
            return previo(table, ops);
        };
    }
    /** Familia con cuenta (el teléfono la identifica). */
    function conFamilia() {
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => {
            if (table === 'whatsapp_conversations') {
                return { data: { id: CONV, parent_id: 'parent-1', identified: true, status: 'open', contact_name: 'A.' }, error: null };
            }
            if (table === 'profiles') return { data: { full_name: 'Acudiente Pérez' }, error: null };
            return previo(table, ops);
        };
        const rpcPrevio = h.state.rpc;
        h.state.rpc = (fn, args) => (fn === 'wa_identify_by_phone'
            ? { data: { estado: 'identificado', parent_id: 'parent-1' }, error: null } : rpcPrevio(fn, args));
    }
    beforeEach(() => invalidarCacheOfertas());
    afterEach(() => invalidarCacheOfertas());

    it('desconocido: «Clase de cortesía tienen» con el bloqueo → ni franjas ni «gratis»: «no tenemos (vuelven…)» + convocatorias', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS });
        conOfertas({ bloqueos: [BLOQUEO], ofertas: [OFERTA], sesiones: SESIONES });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Clase de cortesía tienen' }));

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('Por ahora no tenemos clases de cortesía (vuelven el');
        expect(b.proposed_text).toContain('*Convocatorias Sede Norte*');
        expect(b.proposed_text).toContain('Escríbenos el nombre del deportista');
        expect(b.proposed_text).not.toMatch(/Sub-15|gratis|dejar(me)? tus datos|tu clase de cortesía/);
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'ofertas_vigentes' });
        expect(b.tool_context.flujo).toBeUndefined();
        expect(b.tool_context.botones ?? []).toEqual([]);
    });

    it('desconocido: «¿cuándo son las convocatorias femeninas?» con la clase ABIERTA → las femeninas, sin ofrecer la clase', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS });
        conOfertas({ ofertas: [OFERTA], sesiones: SESIONES });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, ¿cuándo son las convocatorias femeninas?' }));

        expect(borradores()).toHaveLength(1);
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('*Convocatorias Sede Norte*');
        expect(b.proposed_text).toContain('7:00 a 9:00 a. m.');
        expect(b.proposed_text).not.toContain('9:00 a 11:00 a. m.');
        expect(b.proposed_text).not.toMatch(/Sub-15|clase de cortesía\* gratis|Estas son las próximas franjas/);
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'ofertas_vigentes' });
        expect(b.tool_context.flujo).toBeUndefined();
    });

    /** Escuela con embudo del interesado (Monster): `wa_preguntas_prospecto` no vacío. */
    function conEmbudo() {
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => (table === 'school_settings'
            ? { data: { wa_modo_cortesia: 'clase', wa_preguntas_prospecto: [
                { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
            ] }, error: null }
            : previo(table, ops));
    }

    it('escuela con EMBUDO, clase abierta (control): un saludo sin convocatoria arranca el embudo', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS });
        conOfertas({ ofertas: [OFERTA], sesiones: SESIONES });
        conEmbudo();
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero información para inscribir a mi hija' }));

        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context.intencion).not.toBe('ofertas_vigentes');
        expect(borradores()[0].row.tool_context.flujo).toBe('embudo');
    });

    it('escuela con EMBUDO, clase abierta (26–30 nov): «¿cuándo son las convocatorias?» → las ofertas, NO el embudo de la clase', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS });
        conOfertas({ ofertas: [OFERTA], sesiones: SESIONES });
        conEmbudo();
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, ¿cuándo son las convocatorias?' }));

        expect(borradores()).toHaveLength(1);
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('*Convocatorias Sede Norte*');
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'ofertas_vigentes' });
        expect(b.tool_context.flujo).not.toBe('embudo');
        expect(b.proposed_text).not.toMatch(/nombre completo del deportista|Estas son las próximas franjas|clase de cortesía\* gratis/);
    });

    it('familia con cuenta: pide la clase de prueba con el bloqueo → no agenda: «no tenemos» y las ofertas', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS, identificado: true });
        conOfertas({ bloqueos: [BLOQUEO], ofertas: [OFERTA], sesiones: SESIONES });
        conFamilia();
        // Si llegara al modelo, el modelo pediría la herramienta de la clase: tampoco agenda.
        h.chatWithTools.mockResolvedValue({ text: '', toolCalls: [{ name: 'get_trial_class_info', args: {} }], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, '573209998877', 'Quiero una clase de prueba para mi sobrino', 'wamid.f1');

        const textos = borradores().map((b) => String(b.row.proposed_text)).join('\n---\n');
        expect(textos).toContain('Por ahora no tenemos clases de cortesía');
        expect(textos).toContain('*Convocatorias Sede Norte*');
        expect(textos).not.toMatch(/Sub-15|gratis|¿Cuál te reservo\?/);
        expect(borradores().every((b) => !b.row.tool_context?.flujo)).toBe(true);
        expect(h.state.rpcCalls.find((c) => c.fn === 'submit_school_lead')).toBeUndefined();
    });

    it('un botón VIEJO de franja tocado durante el bloqueo no reserva', async () => {
        _olvidarReservasDePaso();
        base({ franjas: FRANJAS });
        conOfertas({ bloqueos: [BLOQUEO], ofertas: [OFERTA], sesiones: SESIONES });
        await handleBotTurn(req, INTEGRATION, CONV,
            mensaje({ type: 'interactive', textBody: 'Sub-15', botonId: `${BOTON_CC.FRANJA}slot-1` }));
        expect(h.state.rpcCalls.find((c) => c.fn === 'submit_school_lead')).toBeUndefined();
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('Por ahora no tenemos clases de cortesía');
        expect(b.tool_context.step).toBe('cortesia_no_disponible');
        expect(b.tool_context.flujo).toBeUndefined();
    });

    it('regresión: sin bloqueos ni ofertas, el prompt de la familia es SYSTEM_PROMPT letra por letra', () => {
        const abierta = armarEstado('s', { ofertas: [], sesiones: [], bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null });
        expect(promptConOfertas(SYSTEM_PROMPT, abierta)).toBe(SYSTEM_PROMPT);
    });

    it('prompt con la clase cerrada: no anuncia ni agenda la clase; van las reglas y <ofertas_vigentes>', () => {
        const ahora = new Date('2026-12-02T15:00:00Z').getTime();
        const cerrada = armarEstado('s', {
            ofertas: [{ ...OFERTA, vigente_desde: null, vigente_hasta: null }],
            sesiones: [{ ...SESIONES[0], fecha: '2026-12-09' }],
            bloqueos: [{ tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: null }],
            ajustesClasePrueba: null, mensajeSinOfertas: null,
        }, ahora);
        const p = promptConOfertas(SYSTEM_PROMPT, cerrada);
        expect(p).not.toContain('agendar la CLASE DE CORTESIA');
        expect(p).not.toContain('y agenda paso a paso');
        expect(p).toContain('HOY LA ESCUELA NO TIENE CLASES DE PRUEBA');
        expect(p).toContain('HOY NO HAY CLASES DE PRUEBA. Vuelven el lunes 1 de febrero de 2027.');
        expect(p).toContain('<ofertas_vigentes');
        expect(p).toContain('Convocatorias Sede Norte');
        expect(p).toContain('COMO PAGAR:');   // lo demás del prompt sigue igual
    });

    it('prompt con la clase abierta y convocatorias: el prompt de siempre + la regla «a quien pregunte por una convocatoria NO le ofrezcas clase de prueba»', () => {
        const ahora = new Date('2026-11-26T15:00:00Z').getTime();
        const abierta = armarEstado('s', {
            ofertas: [{ ...OFERTA, vigente_desde: null, vigente_hasta: null }],
            sesiones: [{ ...SESIONES[0], fecha: '2026-12-09' }],
            bloqueos: [], ajustesClasePrueba: null, mensajeSinOfertas: null,
        }, ahora);
        const p = promptConOfertas(SYSTEM_PROMPT, abierta);
        expect(p.startsWith(SYSTEM_PROMPT)).toBe(true);
        expect(p).toContain('A quien pregunte por una convocatoria NO le ofrezcas clase de prueba');
    });

    it('la presentación sin clase de prueba no la nombra', () => {
        expect(presentacionLarga('Monster', null)).toContain('Te ayudo con horarios, valores, pagos e inscripciones.');
        expect(presentacionLarga('Monster', null)).not.toMatch(/clase/);
        expect(presentacionLarga('Monster', 'clase de prueba')).toContain('pagos y tu clase de prueba.');
    });
});

describe('convocatoria guiada con botones para el desconocido (Monster 2026-11-25)', () => {
    // Bloqueo que siempre cubre «hoy» y sesiones lejos en el futuro: la prueba no caduca con el calendario.
    const BLOQUEO = { tipo: 'clase_prueba', desde: '2000-01-01', hasta: '2099-12-31', motivo: null };
    const PREGUNTAS = '¡Queremos conocerte y conocer tu experiencia en el voleibol!\n\n- *Año de nacimiento:*\n- *Género:*';
    const NOTA = 'Durante las convocatorias haremos una evaluación objetiva de tus habilidades.';
    const OFERTAS = [
        { id: 'may', tipo: 'convocatoria', titulo: 'Convocatorias equipos mayores', sede: 'Sede Norte', estado: 'activa', prioridad: 20,
            descripcion: 'Por tu trayectoria, te invitamos a las *convocatorias de los equipos mayores de competencia*.',
            cta: '¡Queremos contar contigo!', anio_nacimiento_hasta: 2008, requiere_trayectoria: true, requiere_pago: true, valor: 50000 },
        { id: 'suba', tipo: 'convocatoria', titulo: 'Convocatorias Sede Suba', sede: 'Sede Suba', estado: 'activa', prioridad: 10, genero: 'mixto',
            descripcion: 'Por tu año de nacimiento, te invitamos a los *grupos de proyección de nuestra sede Suba*.',
            cta: '¡Tu próximo paso puede comenzar aquí!', anio_nacimiento_desde: 2009, anio_nacimiento_hasta: 2022 },
        { id: 'norte', tipo: 'convocatoria', titulo: 'Convocatorias Sede Norte', sede: 'Sede Norte', estado: 'activa', prioridad: 30,
            descripcion: 'Por tu edad y perfil, te invitamos a los *grupos de formación de nuestra sede norte*.', cta: '¡Anímate a participar!' },
    ];
    const SESIONES = [
        { id: 'm1', oferta_id: 'may', fecha: '2030-01-09', hora_inicio: '19:00:00', hora_fin: '21:00:00', lugar: 'Universidad ECCI', genero: 'femenino' },
        { id: 'm2', oferta_id: 'may', fecha: '2030-01-09', hora_inicio: '20:00:00', hora_fin: '22:00:00', lugar: 'Universidad ECCI', genero: 'masculino' },
        { id: 's1', oferta_id: 'suba', fecha: '2030-01-11', hora_inicio: '16:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2013 y 2014' },
        { id: 's2', oferta_id: 'suba', fecha: '2030-01-11', hora_inicio: '18:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2011 y 2012' },
        { id: 'n1', oferta_id: 'norte', fecha: '2030-01-12', hora_inicio: '07:00:00', hora_fin: '09:00:00', lugar: 'Locos por Pádel', genero: 'femenino' },
        { id: 'n2', oferta_id: 'norte', fecha: '2030-01-12', hora_inicio: '09:00:00', hora_fin: '11:00:00', lugar: 'Locos por Pádel', genero: 'masculino' },
    ];

    /** Lo que el bot fue dejando (tool_context de cada borrador): el último es el estado del flujo. */
    let historial: any[] = [];
    let n = 0;
    function montar(op: { preguntas?: boolean; bloqueo?: boolean; embudo?: boolean } = {}) {
        const ultimo = historial.at(-1) ?? null;
        base({ franjas: FRANJAS, ultimoSaliente: ultimo, pasos: historial.map((c) => c?.step) });
        const previo = h.state.resolve;
        h.state.resolve = (table, ops) => {
            if (table === 'bot_oferta_bloqueos') return { data: op.bloqueo ? [BLOQUEO] : [], error: null };
            if (table === 'bot_ofertas') return { data: OFERTAS, error: null };
            if (table === 'bot_oferta_sesiones') return { data: SESIONES, error: null };
            if (table === 'bot_ofertas_ajustes') {
                return { data: op.preguntas === false ? null : { mensaje_sin_ofertas: null, preguntas_ofertas: PREGUNTAS, nota_ofertas: NOTA }, error: null };
            }
            if (op.embudo && table === 'school_settings') {
                return { data: { wa_modo_cortesia: 'clase', wa_preguntas_prospecto: [
                    { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' }] }, error: null };
            }
            // Los últimos salientes (estado de la convocatoria aunque el bot haya contestado otra cosa después).
            if (table === 'whatsapp_messages' && ops.some(([m, a]) => m === 'select' && String(a[0]) === 'payload, created_at, ai_generated')) {
                const t0 = Date.now();
                return { data: [...historial].reverse().map((p, i) => ({ payload: p, created_at: new Date(t0 - i * 1000).toISOString(), ai_generated: true })), error: null };
            }
            return previo(table, ops);
        };
    }
    /** Un turno: lo que escribió o tocó; devuelve los borradores nuevos. */
    async function turno(texto: string, botonId: string | null = null, op: Parameters<typeof montar>[0] = {}) {
        invalidarCacheOfertas();
        montar(op);
        const antes = borradores().length;
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({
            type: botonId ? 'interactive' : 'text', textBody: texto, botonId, waMessageId: `wamid.g${n++}`,
        }));
        const nuevos = borradores().slice(antes).map((b) => b.row);
        historial.push(...nuevos.map((b) => b.tool_context));
        return nuevos;
    }
    const botonesDe = (b: any) => (b.tool_context.botones ?? []).map((x: any) => x.id);
    const titulosDe = (b: any) => (b.tool_context.botones ?? []).map((x: any) => x.title);
    const idPorTitulo = (b: any, t: string) => b.tool_context.botones.find((x: any) => x.title === t)?.id;

    beforeEach(() => { historial = []; _olvidarReservasDePaso(); invalidarCacheOfertas(); });
    afterEach(() => invalidarCacheOfertas());

    it('niña 2014: botones → lista de años → sede → SOLO Suba 2013–2014 → «Quiero inscribirme» → nombre → lista de fechas → confirmación', async () => {
        let r = await turno('Hola, ¿cuándo son las convocatorias?');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(r).toHaveLength(1);
        expect(r[0].proposed_text).toContain('¡Queremos conocerte y conocer tu experiencia en el voleibol!');
        expect(r[0].proposed_text).toContain('¿La convocatoria es para *femenino* o *masculino*?');
        expect(r[0].proposed_text).not.toMatch(/Año de nacimiento:|Convocatorias Sede|Sub-15/);
        expect(r[0].tool_context).toMatchObject({
            step: 'desconocido_tema_escolar', intencion: 'ofertas_preguntas', flujo: 'puerta_desconocido', paso_puerta: 'oferta',
            datos_puerta: { ultimoPaso: 'genero' },
        });
        expect(botonesDe(r[0])).toEqual(['of_g_femenino', 'of_g_masculino']);

        r = await turno('Femenino', 'of_g_femenino');
        expect(r.at(-1).proposed_text).toContain('¿En qué año nació');
        expect(titulosDe(r.at(-1))).toEqual(['2015 o después', '2013 a 2014', '2011 a 2012', '2008 o antes']);
        expect(r.at(-1).tool_context.datos_puerta).toMatchObject({ ultimoPaso: 'anio' });

        r = await turno('2013 a 2014', 'of_a_2013_2014');
        expect([...titulosDe(r.at(-1))].sort()).toEqual(['Sede Norte', 'Sede Suba']);

        r = await turno('Sede Suba', idPorTitulo(r.at(-1), 'Sede Suba'));
        const todo = r.map((b) => b.proposed_text).join('\n---\n');
        expect(todo).toContain('grupos de proyección de nuestra sede Suba');
        expect(todo).toContain('Nacidos en 2013 y 2014');
        expect(todo).not.toContain('Nacidos en 2011 y 2012');
        expect(todo).not.toMatch(/sede norte|equipos mayores/);
        expect(r.at(-1).proposed_text).toContain('¿Qué quieres hacer? 👇');
        expect(titulosDe(r.at(-1))).toEqual(['Quiero inscribirme', 'Cómo es la evaluación', 'Hablar con alguien']);

        r = await turno('Quiero inscribirme', 'of_inscribirme');
        expect(r.at(-1).proposed_text).toContain('*nombre completo* del deportista');
        r = await turno('Sofía Gómez Uribe');
        expect(r.at(-1).proposed_text).toContain('¿A cuál fecha vas a ir con *Sofía*?');
        expect(botonesDe(r.at(-1))).toEqual(['of_f_s1']);

        r = await turno('Vie 11 ene · 4:00 p. m.', 'of_f_s1');
        const fin = r.at(-1);
        expect(fin.proposed_text).toContain('¡Listo! ✅');
        expect(fin.proposed_text).toContain('*Sofía Gómez Uribe* a *Convocatorias Sede Suba*');
        expect(fin.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'puerta_info',
            pendiente_escuela: expect.stringContaining('inscripción: Convocatorias Sede Suba') });
        expect(fin.tool_context.flujo).toBeUndefined();
    });

    it('hombre 1998 con trayectoria: «convocatorias masculinas» ya trae el género → mayores SOLO masculino → inscripción con el valor', async () => {
        let r = await turno('Hola, ¿cuándo son las convocatorias masculinas?');
        expect(r[0].tool_context.datos_puerta).toMatchObject({ ultimoPaso: 'anio', oferta: { genero: 'masculino' } });
        r = await turno('2008 o antes', 'of_a_x_2008');
        expect(titulosDe(r.at(-1))).toEqual(['Sí', 'No']);
        r = await turno('Sí', 'of_t_si');
        expect(r.at(-1).proposed_text).toContain('en qué clubes o torneos');
        r = await turno('Club X y torneo departamental, opuesto');
        const todo = r.map((b) => b.proposed_text).join('\n---\n');
        expect(todo).toContain('equipos mayores de competencia');
        expect(todo).toContain('8:00 a 10:00 p. m.');
        expect(todo).not.toContain('7:00 a 9:00 p. m.');
        expect(todo).not.toMatch(/sede Suba|sede norte/);
        await turno('Quiero inscribirme', 'of_inscribirme');
        r = await turno('Juan Pérez');
        expect(botonesDe(r.at(-1))).toEqual(['of_f_m2']);
        r = await turno('', 'of_f_m2');
        expect(r.at(-1).proposed_text).toContain('Valor: *$50.000*. La escuela te indica cómo pagar.');
    });

    it('respuestas escritas en vez de tocar: «femenino», «2014», «suba»', async () => {
        await turno('Hola, ¿cuándo son las convocatorias?');
        let r = await turno('femenino');
        expect(r.at(-1).tool_context.datos_puerta).toMatchObject({ ultimoPaso: 'anio' });
        r = await turno('2014');
        expect(r.at(-1).tool_context.datos_puerta).toMatchObject({ ultimoPaso: 'sede' });
        r = await turno('suba');
        expect(r.map((b) => b.proposed_text).join('\n')).toContain('Nacidos en 2013 y 2014');
    });

    it('una pregunta con «?» a mitad del flujo no la toma la convocatoria; después el botón sigue valiendo', async () => {
        await turno('Hola, ¿cuándo son las convocatorias?');
        const r1 = await turno('¿Y dónde queda la sede?');
        expect(r1.every((b) => b.tool_context?.paso_puerta !== 'oferta')).toBe(true);
        // Aunque el bot haya contestado otra cosa después, el botón tocado sigue la convocatoria.
        historial.push({ step: 'prospecto_seguimiento' });
        const r2 = await turno('Femenino', 'of_g_femenino');
        expect(r2.at(-1).tool_context.datos_puerta).toMatchObject({ ultimoPaso: 'anio', oferta: { genero: 'femenino' } });
    });

    it('escuela con EMBUDO: «¿cuándo son las convocatorias?» arranca la convocatoria guiada, no el embudo de la clase', async () => {
        const r = await turno('Hola, ¿cuándo son las convocatorias?', null, { embudo: true });
        expect(r).toHaveLength(1);
        expect(r[0].tool_context).toMatchObject({ flujo: 'puerta_desconocido', paso_puerta: 'oferta' });
        expect(r[0].proposed_text).not.toContain('nombre completo del deportista');
    });

    it('sin clase de prueba hoy, «Clase de cortesía tienen» → «Por ahora no tenemos… (vuelven el …)» y la primera pregunta', async () => {
        const r = await turno('Clase de cortesía tienen', null, { bloqueo: true });
        expect(r).toHaveLength(1);
        expect(r[0].proposed_text).toContain('Por ahora no tenemos clases de cortesía (vuelven el');
        expect(r[0].proposed_text).toContain('¿La convocatoria es para *femenino* o *masculino*?');
        expect(r[0].proposed_text).not.toMatch(/Sub-15|gratis/);
        expect(r[0].tool_context).toMatchObject({ paso_puerta: 'oferta', step: 'desconocido_tema_escolar' });
    });

    it('regresión: escuela SIN preguntas → las ofertas de una vez, como antes (sin flujo)', async () => {
        const r = await turno('Hola, ¿cuándo son las convocatorias femeninas?', null, { preguntas: false });
        expect(r).toHaveLength(1);
        expect(r[0].proposed_text).toContain('grupos de formación de nuestra sede norte');
        expect(r[0].tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'ofertas_vigentes' });
        expect(r[0].tool_context.flujo).toBeUndefined();
    });
});
