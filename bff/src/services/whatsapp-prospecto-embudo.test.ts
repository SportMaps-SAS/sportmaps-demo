/**
 * Embudo de prospectos (análisis de Dynasty 2026-10-08): 24 prospectos → 3
 * reservas → 0 inscripciones registradas. Lo que se prueba acá:
 *
 *   1. PRECIO en la primera respuesta (y en el seguimiento, y a mitad de la
 *      cortesía) cuando la escuela tiene `wa_responder_precios`.
 *   2. LEADS: etapas new → contacted → agendado → asistio → inscrito sin
 *      romper el CHECK de status; la reserva actualiza el lead que ya existía.
 *   3. CICLO DE LA CLASE: «llegamos» el día de la clase, seguimiento de la
 *      noche (20:00 COT) con el enlace de inscripción, solo con ventana.
 *
 * Textos de ejemplo inventados (no son de conversaciones reales). Mismo
 * andamiaje que whatsapp-prospecto-seguimiento.test.ts: Supabase con builder
 * encadenable y modo asistido (las respuestas quedan como borradores).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        updates: { table: string; row: any; ops: Ops }[];
        deletes: { table: string; ops: Ops }[];
    } = { resolve: () => ({ data: null, error: null }), rpc: () => ({ data: null, error: null }), inserts: [], updates: [], deletes: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { state.updates.push({ table, row, ops }); ops.push(['update', [row]]); return b; };
        b.delete = () => { state.deletes.push({ table, ops }); ops.push(['delete', []]); return b; };
        b.upsert = (row: any) => {
            // notifications entra por upsert+ignoreDuplicates: se registra como insert y devuelve la fila.
            if (table === 'notifications') { state.inserts.push({ table, row }); b.__fila = row; }
            ops.push(['upsert', [row]]); return b;
        };
        b.maybeSingle = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.single = () => { ops.push(['maybeSingle', []]); return Promise.resolve(state.resolve(table, ops)); };
        b.then = (res: any, rej: any) => Promise.resolve(b.__fila ? { data: [{ id: b.__fila.id }], error: null } : state.resolve(table, ops)).then(res, rej);
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
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Club Demo', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
    etiquetaDeContacto: vi.fn(() => 'Contacto'),
    uuidDeClave: (k: string) => `uuid:${k}`,
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { pidePrecio, bloqueDePreciosProspecto, preciosParaProspecto } from './whatsapp-precios.service';
import {
    etapaDeLead, siguienteEtapa, STATUS_DE_ETAPA, telefonoAlterno, fusionarReservaEnLead,
} from './whatsapp-prospecto-lead.service';
import {
    esLlegada, textoBienvenidaLlegada, atenderLlegada, claseTerminada, textoSeguimientoClase,
    runSeguimientoNocheCortesia, inscripcionDelLead, type ReservaParaSeguimiento,
} from './prospecto-ciclo-clase.service';
import { contenidoAviso, claveAviso } from './cortesia-reservas.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573001112233';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const hace = (seg: number) => new Date(Date.now() - seg * 1000).toISOString();

/** Fecha de HOY en Bogotá (UTC-5). */
const hoyCot = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);

const PLANES = [
    { name: 'PLAN BÁSICO', price: 90000, is_active: true },
    { name: 'PLAN PRO', price: 150000, is_active: true },
    { name: 'CORTESÍA', price: 0, is_active: true },
];
const SLOTS = [
    { id: 's-a', label: 'INFANTIL', slot_date: '2030-01-14', start_time: '16:00:00', end_time: '18:00:00', location: 'Coliseo', max_capacity: 5, reserved_count: 0, team_id: null },
    { id: 's-b', label: 'ADULTOS', slot_date: '2030-01-15', start_time: '19:00:00', end_time: '21:00:00', location: 'Coliseo', max_capacity: 5, reserved_count: 0, team_id: null },
];

type Fila = { wa_message_id: string | null; direction: 'inbound' | 'outbound'; text_body: string;
    payload?: any; ai_generated: boolean; created_at: string; wa_timestamp?: string | null };

function base(op: {
    filas: Fila[]; pasos?: string[]; precios?: boolean; leads?: any[]; indicaciones?: string | null;
}) {
    const pasos = new Set(op.pasos ?? []);
    h.state.resolve = (table, ops) => {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
        if ((table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') && paso) {
            return { count: pasos.has(paso) ? 1 : 0, error: null };
        }
        if (table === 'whatsapp_messages') {
            const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
            const esUno = ops.some(([m]) => m === 'maybeSingle');
            if (direccion === 'outbound' && esUno) {
                const ultimo = [...op.filas].filter((f) => f.direction === 'outbound')
                    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
                return { data: ultimo ? { payload: ultimo.payload, created_at: ultimo.created_at } : null, error: null };
            }
            if (direccion === 'inbound') return { data: op.filas.filter((f) => f.direction === 'inbound'), error: null };
            if (!direccion) return { data: op.filas, error: null };
            return { data: null, count: 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: 'Contacto', tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'school_settings') {
            return { data: { wa_modo_cortesia: 'clase', wa_responder_precios: op.precios ?? true, wa_cortesia_indicaciones: op.indicaciones ?? null }, error: null };
        }
        if (table === 'offering_plans') return { data: PLANES, error: null };
        if (table === 'school_signup_leads') {
            if (ops.some(([m]) => m === 'update')) return { data: [{ id: 'lead-1' }], error: null };
            if (ops.some(([m]) => m === 'maybeSingle')) return { data: (op.leads ?? [])[0] ?? null, error: null };
            return { data: op.leads ?? [], error: null };
        }
        if (table === 'school_trial_slots') return { data: SLOTS, error: null };
        if (table === 'school_join_qr_codes') return { data: [{ slug: 'club-demo', target_type: 'open', signup_count: 10 }], error: null };
        if (table === 'schools') return { data: { name: 'CLUB DEMO', owner_id: 'owner-1', slug: 'club-demo', address: null, payment_settings: {} }, error: null };
        if (table === 'teams' || table === 'school_branches') return { data: [], error: null };
        if (table === 'school_members') return { data: [{ profile_id: 'admin-1' }], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') return { data: { estado: 'desconocido' }, error: null };
        return { data: null, error: null };
    };
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);
const mensaje = (textBody: string, waMessageId: string) => ({
    phoneNumberId: 'pn-1', contactWaId: TEL, contactName: 'Contacto',
    waMessageId, type: 'text', textBody, raw: {}, waTimestamp: null,
}) as any;
const primerMensaje = (t: string): Fila[] => [
    { wa_message_id: 'wamid.0', direction: 'inbound', text_body: t, ai_generated: false, created_at: hace(2) },
];

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.deletes = [];
});

// ─── 1. Precio ───────────────────────────────────────────────────────────────

describe('pidePrecio', () => {
    it.each([
        '¿Qué precio tiene la escuela?',
        'Quiero saber los costos y los horarios',
        'cuánto cuesta para un niño de 9 años',
        'Y los precios',
        '¿cuánto es la mensualidad?',
        'Me regala el valor por favor',
        'cuanto sería? 120 mil?',
    ])('sí: %s', (t) => expect(pidePrecio(t)).toBe(true));

    it.each([
        'Hola, buenas tardes',
        'Mensualidad marzo',
        'Ya te envío la mensualidad',
        'Te mando el comprobante de la mensualidad',
        '¿En qué horario puedo ir a pagar la mensualidad?',
        'cuánto debo',
        'valor pendiente de septiembre',
        'Quiero inscribir a mi hijo',
    ])('no: %s', (t) => expect(pidePrecio(t)).toBe(false));
});

describe('preciosParaProspecto', () => {
    it('con el ajuste apagado no hay precios', async () => {
        base({ filas: [] });
        expect(await preciosParaProspecto('school-1', false)).toBeNull();
    });
    it('lista corta, sin planes en $0', async () => {
        base({ filas: [] });
        const t = await preciosParaProspecto('school-1', true);
        expect(t).toContain('Plan básico');
        expect(t).toContain('150.000');
        expect(t).not.toMatch(/cortes[ií]a/i);
    });
    it('la línea del grupo va debajo de los valores', () => {
        expect(bloqueDePreciosProspecto('💰 valores', 'Para 12 años le corresponde X.')).toBe('💰 valores\n\n👉 Para 12 años le corresponde X.');
        expect(bloqueDePreciosProspecto(null, 'algo')).toBeNull();
    });
});

describe('precio en la PRIMERA respuesta al prospecto', () => {
    it('precio + horarios en el mismo mensaje → valores y franjas de cortesía juntos', async () => {
        const t = 'Buenas, quisiera saber el costo y los horarios de las clases de voleibol';
        base({ filas: primerMensaje(t) });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje(t, 'wamid.0'));
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0];
        expect(b.proposed_text).toContain('💰 Estos son los valores de la mensualidad');
        expect(b.proposed_text).toContain('150.000');
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', flujo: 'clase_cortesia' });
    });

    it('sin `wa_responder_precios` sale igual que antes (sin cifras)', async () => {
        const t = 'Buenas, quisiera saber el costo y los horarios de las clases de voleibol';
        base({ filas: primerMensaje(t), precios: false });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje(t, 'wamid.0'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).not.toContain('💰');
    });

    it('sin preguntar precio no se mandan valores', async () => {
        const t = 'Hola, quiero información de las clases para mi hija';
        base({ filas: primerMensaje(t) });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje(t, 'wamid.0'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).not.toContain('💰');
    });
});

describe('precio en el seguimiento', () => {
    const SALUDO = { step: 'desconocido_tema_escolar', intencion: 'inscripcion', con_enlace: true };
    const conRespuesta = (despues: string): Fila[] => [
        { wa_message_id: 'wamid.0', direction: 'inbound', text_body: 'Hola, quiero información', ai_generated: false, created_at: hace(600) },
        { wa_message_id: 'wamid.bot', direction: 'outbound', text_body: 'Hola 👋…', payload: SALUDO, ai_generated: true, created_at: hace(300) },
        { wa_message_id: 'wamid.1', direction: 'inbound', text_body: despues, ai_generated: false, created_at: hace(1) },
    ];

    it('«y cuánto cuesta?» después de la primera respuesta → los valores', async () => {
        base({ filas: conRespuesta('y cuánto cuesta?'), pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje('y cuánto cuesta?', 'wamid.1'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toContain('💰');
        expect(borradores()[0].tool_context).toMatchObject({ step: 'prospecto_seguimiento_precios' });
    });

    it('«Costos» + «Mensualidad» en ráfaga → los valores, no silencio (…1177, 2026-10-29)', async () => {
        // «Mensualidad» sola es tema `pagos`; el turno lo corre el último mensaje.
        const filas: Fila[] = [
            ...conRespuesta('Costos').slice(0, 2),
            { wa_message_id: 'wamid.1', direction: 'inbound', text_body: 'Costos', ai_generated: false, created_at: hace(9) },
            { wa_message_id: 'wamid.2', direction: 'inbound', text_body: 'Mensualidad', ai_generated: false, created_at: hace(1) },
        ];
        base({ filas, pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje('Mensualidad', 'wamid.2'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toContain('💰');
        expect(borradores()[0].tool_context).toMatchObject({ step: 'prospecto_seguimiento_precios' });
    });

    it('horarios ya mostrados + pregunta de costos → igual responde el precio (no se frena)', async () => {
        const t = 'qué costos tienen y qué días entrenan';
        base({ filas: conRespuesta(t), pasos: ['desconocido_tema_escolar', 'prospecto_seguimiento_horarios'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje(t, 'wamid.1'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toContain('💰');
    });

    it('«y los precios» con el flujo de cortesía abierto → valores y el flujo sigue en su paso', async () => {
        const flujo = { step: 'cortesia_ofrecer', flujo: 'clase_cortesia', paso_cortesia: 'elegir_franja', datos_cortesia: { pagina: 0 } };
        const filas: Fila[] = [
            { wa_message_id: 'wamid.0', direction: 'inbound', text_body: 'Hola, quiero una clase de prueba', ai_generated: false, created_at: hace(600) },
            { wa_message_id: 'wamid.bot', direction: 'outbound', text_body: 'Estas son las franjas…', payload: flujo, ai_generated: true, created_at: hace(300) },
            { wa_message_id: 'wamid.1', direction: 'inbound', text_body: 'y los precios', ai_generated: false, created_at: hace(1) },
        ];
        base({ filas, pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje('y los precios', 'wamid.1'));
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0];
        expect(b.proposed_text).toContain('💰');
        expect(b.tool_context).toMatchObject({
            step: 'prospecto_seguimiento_precios', flujo: 'clase_cortesia', paso_cortesia: 'elegir_franja',
        });
    });
});

// ─── 2. Leads ────────────────────────────────────────────────────────────────

describe('etapas del lead', () => {
    it('se derivan de las columnas cuando no hay etapa guardada', () => {
        expect(etapaDeLead({ status: 'new' })).toBe('nuevo');
        expect(etapaDeLead({ status: 'contacted' })).toBe('respondido');
        expect(etapaDeLead({ status: 'contacted', trial_slot_id: 's1' })).toBe('agendado');
        expect(etapaDeLead({ status: 'converted' })).toBe('inscrito');
        expect(etapaDeLead({ status: 'discarded', trial_slot_id: 's1' })).toBe('descartado');
        expect(etapaDeLead({ status: 'contacted', trial_slot_id: 's1', source_detail: { etapa: 'asistio' } })).toBe('asistio');
        // una etapa guardada vieja no gana a las columnas
        expect(etapaDeLead({ status: 'contacted', trial_slot_id: 's1', source_detail: { etapa: 'nuevo' } })).toBe('agendado');
    });
    it('nunca se baja de etapa y las finales no se mueven', () => {
        expect(siguienteEtapa('nuevo', 'respondido')).toBe('respondido');
        expect(siguienteEtapa('agendado', 'respondido')).toBe('agendado');
        expect(siguienteEtapa('agendado', 'asistio')).toBe('asistio');
        expect(siguienteEtapa('asistio', 'inscrito')).toBe('inscrito');
        expect(siguienteEtapa('inscrito', 'asistio')).toBe('inscrito');
        expect(siguienteEtapa('descartado', 'agendado')).toBe('descartado');
    });
    it('status siempre dentro del CHECK actual (new/contacted/converted/discarded)', () => {
        for (const s of Object.values(STATUS_DE_ETAPA)) expect(['new', 'contacted', 'converted', 'discarded']).toContain(s);
        expect(STATUS_DE_ETAPA.agendado).toBe('contacted');
        expect(STATUS_DE_ETAPA.inscrito).toBe('converted');
    });
});

describe('la reserva actualiza el lead que ya existía', () => {
    it('otro formato del mismo número para que el dedupe exacto de la RPC no la frene', () => {
        expect(telefonoAlterno('3001112233')).toBe('+573001112233');
        expect(telefonoAlterno('+15551234567')).toBe('15551234567');
        expect(telefonoAlterno('15551234567')).toBe('+15551234567');
    });

    it('pasa cupo y datos de la reserva al lead del bot y borra la fila nueva', async () => {
        base({ filas: [] });
        const previo = { id: 'lead-bot', full_name: 'Madre Ejemplo', guardian_name: null, notes: 'quiere info', status: 'contacted', trial_slot_id: null, source_detail: { origen: 'wa_prospecto', conversation_id: CONV, etapa: 'respondido' }, email: null };
        const nuevo = { id: 'lead-rpc', trial_slot_id: 's-a', full_name: 'Niña Ejemplo', guardian_name: 'Madre Ejemplo', birth_date: '2016-01-01', suggested_category: 'Sub-11', notes: 'Agendada por el asistente', source_detail: { canal: 'whatsapp' }, email: null, gender: null };
        h.state.resolve = (table, ops) => {
            if (table !== 'school_signup_leads') return { data: null, error: null };
            if (ops.some(([m]) => m === 'update')) return { data: [{ id: 'lead-bot' }], error: null };
            if (ops.some(([m]) => m === 'delete')) return { data: null, error: null };
            const id = ops.find(([m, a]) => m === 'eq' && a[0] === 'id')?.[1][1];
            return { data: id === 'lead-rpc' ? nuevo : previo, error: null };
        };
        const id = await fusionarReservaEnLead('lead-bot', 'lead-rpc');
        expect(id).toBe('lead-bot');
        const up = h.state.updates.find((u) => u.table === 'school_signup_leads')!;
        expect(up.row).toMatchObject({
            trial_slot_id: 's-a', full_name: 'Niña Ejemplo', guardian_name: 'Madre Ejemplo', status: 'contacted',
            source_detail: expect.objectContaining({ origen: 'wa_prospecto', etapa: 'agendado', contacto: 'Madre Ejemplo' }),
        });
        expect(h.state.deletes).toHaveLength(1);
        expect(h.state.deletes[0].ops).toContainEqual(['eq', ['id', 'lead-rpc']]);
    });

    it('si otra reserva ya tomó esa fila, no borra la nueva', async () => {
        base({ filas: [] });
        h.state.resolve = (table, ops) => {
            if (ops.some(([m]) => m === 'update')) return { data: [], error: null };
            const id = ops.find(([m, a]) => m === 'eq' && a[0] === 'id')?.[1][1];
            return { data: id === 'lead-rpc' ? { id, trial_slot_id: 's-a', full_name: 'X' } : { id, trial_slot_id: null, status: 'new' }, error: null };
        };
        expect(await fusionarReservaEnLead('lead-bot', 'lead-rpc')).toBe('lead-rpc');
        expect(h.state.deletes).toHaveLength(0);
    });
});

// ─── 3. Ciclo de la clase ────────────────────────────────────────────────────

describe('llegada a la clase', () => {
    it.each(['Hola llegamos', 'ya llegué', 'Ya estamos aquí', 'estamos en la entrada', 'Llegamos! a quién buscamos?'])
        ('es llegada: %s', (t) => expect(esLlegada(t)).toBe(true));
    it.each(['todavía no llegamos', 'vamos a llegar tarde', '¿cómo llego a la sede?', 'llegamos tarde por el trancón?', 'hola', 'no llegué a tiempo'])
        ('no es llegada: %s', (t) => expect(esLlegada(t)).toBe(false));

    it('una línea + las indicaciones de la escuela', () => {
        expect(textoBienvenidaLlegada(null)).toBe('¡Bienvenidos! Ya le aviso a la escuela 🙌');
        expect(textoBienvenidaLlegada('Busquen al profe en la cancha 2.')).toBe('¡Bienvenidos! Ya le aviso a la escuela 🙌\n\nBusquen al profe en la cancha 2.');
    });

    const reserva = { leadId: 'lead-1', nombre: 'Niña Ejemplo', llegadaAt: null, franja: { id: 's-a', grupo: 'INFANTIL', fecha: '2030-01-14', horaInicio: '16:00', horaFin: '18:00', sede: 'Coliseo', cupos: 0 } };

    it('con clase HOY: responde, marca «asistio» y avisa a la escuela', async () => {
        const responder = vi.fn(async () => {});
        const marcarAsistio = vi.fn(async () => 'asistio');
        const avisar = vi.fn(async () => {});
        const ok = await atenderLlegada(
            { schoolId: 'school-1', conversationId: CONV, contactWaId: TEL, texto: 'Hola llegamos', responder },
            { reservaDeHoy: async () => reserva, indicaciones: async () => 'Traer agua.', marcarAsistio, avisar },
        );
        expect(ok).toBe(true);
        expect(responder).toHaveBeenCalledWith('¡Bienvenidos! Ya le aviso a la escuela 🙌\n\nTraer agua.');
        expect(marcarAsistio).toHaveBeenCalledWith('lead-1', expect.objectContaining({ llegada_at: expect.any(String) }));
        expect(avisar).toHaveBeenCalledWith(expect.objectContaining({ tipo: 'llegada', leadId: 'lead-1' }));
    });

    it('sin clase hoy no hace nada (sigue el flujo normal)', async () => {
        const responder = vi.fn();
        expect(await atenderLlegada(
            { schoolId: 'school-1', conversationId: CONV, contactWaId: TEL, texto: 'ya llegamos', responder },
            { reservaDeHoy: async () => null },
        )).toBe(false);
        expect(responder).not.toHaveBeenCalled();
    });

    it('la segunda llegada del mismo día no se repite', async () => {
        const responder = vi.fn();
        expect(await atenderLlegada(
            { schoolId: 'school-1', conversationId: CONV, contactWaId: TEL, texto: 'ya llegamos', responder },
            { reservaDeHoy: async () => ({ ...reserva, llegadaAt: new Date().toISOString() }) },
        )).toBe(false);
        expect(responder).not.toHaveBeenCalled();
    });

    it('aviso de llegada: título propio y clave idempotente por lead y cupo', () => {
        const a = { tipo: 'llegada' as const, schoolId: 'school-1', conversationId: CONV, contactWaId: TEL, leadId: 'lead-1', nombre: 'Niña Ejemplo', franja: reserva.franja };
        expect(contenidoAviso(a).titulo).toBe('Llegó un prospecto a su clase de cortesía');
        expect(claveAviso(a)).toBe('wa_clase_cortesia:llegada:lead-1:s-a');
    });

    it('en el bot: «llegamos» el día de la clase → bienvenida (no «ya pasé tu mensaje»)', async () => {
        const hoy = hoyCot();
        base({
            filas: primerMensaje('Hola llegamos'),
            indicaciones: 'Pregunten por el profe en la entrada.',
            leads: [{ id: 'lead-1', full_name: 'Niña Ejemplo', status: 'contacted', source_detail: {}, school_trial_slots: { id: 's-hoy', label: 'INFANTIL', slot_date: hoy, start_time: '16:00:00', end_time: '18:00:00', location: 'Coliseo' } }],
        });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje('Hola llegamos', 'wamid.0'));
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toBe('¡Bienvenidos! Ya le aviso a la escuela 🙌\n\nPregunten por el profe en la entrada.');
        expect(borradores()[0].tool_context).toMatchObject({ step: 'cortesia_llegada' });
        const aviso = h.state.inserts.find((i) => i.table === 'notifications');
        expect(aviso?.row).toMatchObject({ title: 'Llegó un prospecto a su clase de cortesía', data: expect.objectContaining({ evento: 'llegada' }) });
        const etapa = h.state.updates.find((u) => u.table === 'school_signup_leads');
        expect(etapa?.row).toMatchObject({ status: 'contacted', source_detail: expect.objectContaining({ etapa: 'asistio' }) });
    });
});

describe('seguimiento de la noche', () => {
    it('la clase tiene que haber terminado', () => {
        expect(claseTerminada('16:00', '18:00', 20 * 60)).toBe(true);
        expect(claseTerminada('19:30', '21:00', 20 * 60)).toBe(false);
        expect(claseTerminada('19:30', null, 20 * 60 + 30)).toBe(true);
    });

    it('«¿Cómo le fue?» + enlace de inscripción, sin pedir correo', () => {
        const t = textoSeguimientoClase({ saludo: 'Ana', atleta: 'Sara Gómez', esAcudiente: true, enlace: 'https://app/join/x', asistio: true });
        expect(t).toContain('¿Cómo le fue a *Sara Gómez* en la clase de cortesía de hoy?');
        expect(t).toContain('https://app/join/x');
        expect(t).not.toMatch(/correo/i);
    });

    const R: ReservaParaSeguimiento = {
        leadId: 'lead-1', schoolId: 'school-1', nombre: 'Sara Gómez', acudiente: 'Ana Pérez', telefono: '3001112233',
        etapa: 'agendado', sourceDetail: {}, slot: { id: 's-1', slot_date: '2030-01-14', start_time: '16:00', end_time: '18:00' },
    };
    const deps = (over: Record<string, any> = {}) => ({
        reservasDelDia: vi.fn(async () => [R]),
        integracion: vi.fn(async () => INTEGRATION),
        conversacion: vi.fn(async () => ({ id: CONV, last_inbound_at: new Date(Date.UTC(2030, 0, 14, 20)).toISOString() })),
        botEncendido: vi.fn(async () => true),
        tomada: vi.fn(async () => false),
        dadoDeBaja: vi.fn(async () => false),
        enlace: vi.fn(async () => 'https://app/join/club-demo'),
        reclamar: vi.fn(async () => true),
        soltar: vi.fn(async () => {}),
        enviar: vi.fn(async () => true),
        ...over,
    });
    // 20:15 COT del 2030-01-14 = 01:15 UTC del 15.
    const NOCHE = new Date(Date.UTC(2030, 0, 15, 1, 15));

    it('antes de las 20:00 COT no corre', async () => {
        const d = deps();
        const r = await runSeguimientoNocheCortesia({ ahora: new Date(Date.UTC(2030, 0, 14, 23, 0)), deps: d });
        expect(r.candidatas).toBe(0);
        expect(d.reservasDelDia).not.toHaveBeenCalled();
    });

    it('con la ventana abierta: uno, con el enlace /join', async () => {
        const d = deps();
        const r = await runSeguimientoNocheCortesia({ ahora: NOCHE, deps: d });
        expect(r.enviados).toBe(1);
        expect(d.reservasDelDia).toHaveBeenCalledWith('2030-01-14');
        expect(d.enviar.mock.calls[0][3]).toContain('https://app/join/club-demo');
        expect(d.enviar.mock.calls[0][4]).toMatchObject({ step: 'cortesia_seguimiento_noche', lead_id: 'lead-1' });
    });

    it('sin ventana de 24 h: nada (no hay plantilla aprobada para esto)', async () => {
        const d = deps({ conversacion: vi.fn(async () => ({ id: CONV, last_inbound_at: new Date(Date.UTC(2030, 0, 13, 0)).toISOString() })) });
        const r = await runSeguimientoNocheCortesia({ ahora: NOCHE, deps: d });
        expect(r.enviados).toBe(0);
        expect(d.reclamar).not.toHaveBeenCalled();
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('otro BFF ya lo reclamó: no se manda dos veces', async () => {
        const d = deps({ reclamar: vi.fn(async () => false) });
        const r = await runSeguimientoNocheCortesia({ ahora: NOCHE, deps: d });
        expect(r.enviados).toBe(0);
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('ya enviado (marca en source_detail) o clase sin terminar: fuera', async () => {
        const d = deps({ reservasDelDia: vi.fn(async () => [
            { ...R, sourceDetail: { seguimiento_clase_at: '2030-01-15T01:00:00Z' } },
            { ...R, leadId: 'lead-2', slot: { ...R.slot, start_time: '19:45', end_time: '21:00' } },
        ]) });
        const r = await runSeguimientoNocheCortesia({ ahora: NOCHE, deps: d });
        expect(r.candidatas).toBe(0);
        expect(d.enviar).not.toHaveBeenCalled();
    });

    it('si el envío falla, suelta el reclamo para el siguiente tick', async () => {
        const d = deps({ enviar: vi.fn(async () => false) });
        const r = await runSeguimientoNocheCortesia({ ahora: NOCHE, deps: d });
        expect(r.fallidos).toBe(1);
        expect(d.soltar).toHaveBeenCalled();
    });
});

describe('inscripción con el mismo teléfono', () => {
    const lead = { id: 'l1', school_id: 'school-1', phone: '3001112233', email: null, created_at: '2030-01-10T00:00:00Z' };
    it('inscripción del hijo de un perfil con ese teléfono, después del lead → cuenta', () => {
        const id = inscripcionDelLead(lead, new Set(['p1']),
            [{ id: 'e1', school_id: 'school-1', user_id: null, child_id: 'c1', created_at: '2030-01-16T00:00:00Z' }],
            new Map([['c1', 'p1']]));
        expect(id).toBe('e1');
    });
    it('de otra escuela o anterior al lead → no cuenta', () => {
        expect(inscripcionDelLead(lead, new Set(['p1']),
            [{ id: 'e1', school_id: 'otra', user_id: 'p1', child_id: null, created_at: '2030-01-16T00:00:00Z' },
             { id: 'e2', school_id: 'school-1', user_id: 'p1', child_id: null, created_at: '2030-01-01T00:00:00Z' }],
            new Map())).toBeNull();
    });
});
