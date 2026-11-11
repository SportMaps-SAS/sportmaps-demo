/**
 * Embudo por escuela — regresión «Dynasty igual» (plan B2/B3 §5.7). Mismo
 * andamiaje que whatsapp-prospecto-embudo.test.ts (Supabase con builder
 * encadenable y modo asistido: las respuestas quedan como borradores).
 *
 *   1. El bot de hoy responde EXACTAMENTE igual con `school_settings` sin las
 *      columnas del embudo (migración sin aplicar) que con ellas en NULL
 *      (aplicada y sin configurar): «Hola», «quiero información», «clase de
 *      prueba», el precio, la puerta de 3 botones y el «Sí, acepto» de un
 *      desconocido. Cuando Integración cablee el embudo en el bot, este archivo
 *      sigue siendo el candado.
 *   2. El motor con las lecturas reales (`depsEmbudoDeSupabase`) queda apagado
 *      para Dynasty y prende para Monster, que ve su bienvenida con las sedes.
 *
 * Textos de ejemplo inventados.
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
import { ajustesWhatsAppDeEscuela, embudoActivo } from './whatsapp-ajustes-escuela.service';
import { iniciarEmbudo, atenderTurnoEmbudo, depsEmbudoDeSupabase, type CtxEmbudo } from './whatsapp-embudo-prospecto';
import { BOTON_PUERTA } from './whatsapp-puerta-desconocido';
import {
    BOTON, _olvidarReservasDePaso, seguimientoQueContesta, claseConValor, lineaPrimeraClase, lineaDeDireccionDelInteresado,
} from './whatsapp-bot.service';
import { textosDeClase } from './textos-clase-prueba';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573001112233';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const hace = (seg: number) => new Date(Date.now() - seg * 1000).toISOString();
const NORTE = '11111111-1111-4111-8111-111111111111';
const SUBA = '22222222-2222-4222-8222-222222222222';

const SLOTS = [
    { id: 's-a', label: 'INFANTIL', slot_date: '2030-01-14', start_time: '16:00:00', end_time: '18:00:00', location: 'Coliseo', max_capacity: 5, reserved_count: 0, team_id: null },
];
const COLUMNAS_EMBUDO = ['wa_bienvenida', 'wa_botones_sede', 'wa_preguntas_prospecto', 'wa_modo_discreto', 'wa_temas_a_persona'];
const FILA_DYNASTY = { wa_modo_cortesia: 'clase', wa_responder_precios: true, wa_cortesia_indicaciones: null };
const FILA_MONSTER = {
    ...FILA_DYNASTY,
    wa_bienvenida: '¡Hola! 👋 Bienvenid@ a Club Monsters Volley 🏐⚡\nPara enviarte la información exacta, cuéntanos: ¿cuál sede te queda más cerca?',
    wa_botones_sede: [{ branch_id: NORTE, titulo: '🟡 Sede Norte' }, { branch_id: SUBA, titulo: '⚫ Sede Suba' }],
    wa_preguntas_prospecto: [
        { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' },
        { clave: 'fecha_nacimiento', texto: '¿Cuál es su fecha de nacimiento?', tipo: 'fecha' },
    ],
    wa_modo_discreto: 'no', wa_temas_a_persona: null,
};

/**
 * `escuela`:
 *  - 'sin_columnas': la migración no está aplicada (pedir las columnas da 42703);
 *  - 'columnas_null': aplicada y sin configurar (Dynasty después de la migración);
 *  - 'monster': aplicada y con el embudo.
 */
type Escuela = 'sin_columnas' | 'columnas_null' | 'monster';
type Fila = { wa_message_id: string | null; direction: 'inbound' | 'outbound'; text_body: string;
    payload?: any; ai_generated: boolean; created_at: string };

function base(escuela: Escuela, filas: Fila[]) {
    h.state.resolve = (table, ops) => {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
        if ((table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') && paso) return { count: 0, error: null };
        if (table === 'whatsapp_messages') {
            const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
            const esUno = ops.some(([m]) => m === 'maybeSingle');
            if (direccion === 'outbound' && esUno) {
                const ultimo = [...filas].filter((f) => f.direction === 'outbound').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
                return { data: ultimo ? { payload: ultimo.payload, created_at: ultimo.created_at } : null, error: null };
            }
            if (direccion === 'inbound') return { data: filas.filter((f) => f.direction === 'inbound'), error: null };
            if (!direccion) return { data: filas, error: null };
            return { data: null, count: 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: 'Contacto', tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: true, responder_prospectos: true }, error: null };
        }
        if (table === 'school_settings') {
            const columnas = String(ops.find(([m]) => m === 'select')?.[1]?.[0] ?? '');
            const pideEmbudo = COLUMNAS_EMBUDO.some((c) => columnas.includes(c));
            if (escuela === 'sin_columnas' && pideEmbudo) {
                return { data: null, error: { code: '42703', message: 'column school_settings.wa_bienvenida does not exist' } };
            }
            if (escuela === 'columnas_null') {
                return { data: { ...FILA_DYNASTY, wa_bienvenida: null, wa_botones_sede: null, wa_preguntas_prospecto: null, wa_modo_discreto: 'global', wa_temas_a_persona: null }, error: null };
            }
            return { data: escuela === 'monster' ? FILA_MONSTER : FILA_DYNASTY, error: null };
        }
        if (table === 'offering_plans') return { data: [{ name: 'PLAN PRO', price: 150000, is_active: true }], error: null };
        if (table === 'school_signup_leads') {
            if (ops.some(([m]) => m === 'update')) return { data: [{ id: 'lead-1' }], error: null };
            if (ops.some(([m]) => m === 'maybeSingle')) return { data: null, error: null };
            return { data: [], error: null };
        }
        if (table === 'school_trial_slots') return { data: SLOTS, error: null };
        if (table === 'school_join_qr_codes') return { data: [{ slug: 'club-demo', target_type: 'open', signup_count: 10 }], error: null };
        if (table === 'schools') return { data: { name: 'CLUB DEMO', owner_id: 'owner-1', slug: 'club-demo', address: null, payment_settings: {} }, error: null };
        if (table === 'school_branches') {
            return { data: [{ id: NORTE, name: 'Sede Norte', address: 'Calle 201 #67-12' }, { id: SUBA, name: 'Sede Suba', address: 'Calle 152 #94A-67' }], error: null };
        }
        if (table === 'teams') return { data: [], error: null };
        if (table === 'school_members') return { data: [{ profile_id: 'admin-1' }], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => (fn === 'wa_identify_by_phone' ? { data: { estado: 'desconocido' }, error: null } : { data: null, error: null });
    h.botEncendido.mockResolvedValue(true);
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);
const mensaje = (textBody: string, waMessageId: string, botonId: string | null = null) => ({
    phoneNumberId: 'pn-1', contactWaId: TEL, contactName: 'Contacto', waMessageId,
    type: botonId ? 'interactive' : 'text', textBody, botonId, raw: {}, waTimestamp: null,
}) as any;

/**
 * La base con la historia de verdad: los frenos por step cuentan los salientes de
 * `filas` (el de 30 días incluido) y las listas de salientes las devuelven
 * ordenadas. Monster ya pagó la clase de prueba de su escuela ($15.000).
 */
function conHistoria(filas: Fila[]) {
    const orig = h.state.resolve;
    h.state.resolve = (table, ops) => {
        if (table === 'school_trial_class_settings') return { data: { nombre_clase: 'prueba', trial_price: 15000 }, error: null };
        if (table === 'whatsapp_messages') {
            const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
            const paso = eqs.find((a) => String(a[0]).endsWith('>>step'))?.[1];
            const direccion = eqs.find((a) => a[0] === 'direction')?.[1];
            const salientes = filas.filter((f) => f.direction === 'outbound').sort((a, b) => b.created_at.localeCompare(a.created_at));
            if (paso) return { count: salientes.filter((f) => f.payload?.step === paso).length, error: null };
            if (direccion === 'outbound' && !ops.some(([m]) => m === 'maybeSingle')) return { data: salientes, error: null };
        }
        return orig(table, ops);
    };
}

/**
 * El catálogo de servicios y el mapeo de anuncios (whatsapp-anuncio-destino). Sin
 * `mapeo`, la tabla todavía no existe (PGRST205), como hoy en la base.
 */
function conCatalogo(items: any[], mapeo?: any) {
    const orig = h.state.resolve;
    h.state.resolve = (table, ops) => {
        if (table === 'school_tournament_items') return { data: items, error: null };
        if (table === 'whatsapp_anuncio_destino') {
            return mapeo ? { data: [mapeo], error: null }
                : { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.whatsapp_anuncio_destino' in the schema cache" } };
        }
        return orig(table, ops);
    };
}

/** Lo que el bot hace HOY con ese mensaje: texto, step y botones del borrador. */
async function respuesta(escuela: Escuela, texto: string, op: {
    botonId?: string | null; atender?: boolean; previos?: Fila[]; historia?: boolean;
    /** El payload del entrante (el mensaje crudo de Meta: `referral` si vino de un anuncio). */
    payload?: any; catalogo?: any[]; mapeo?: any;
    /** La dirección registrada de la escuela (`schools.address`). */
    direccion?: string | null;
} = {}) {
    vi.clearAllMocks();
    _olvidarReservasDePaso();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.deletes = [];
    const filas: Fila[] = [
        ...(op.previos ?? []),
        { wa_message_id: 'wamid.0', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(2),
            ...(op.payload ? { payload: op.payload } : {}) },
    ];
    base(escuela, filas);
    if (op.historia) conHistoria(filas);
    if (op.direccion !== undefined) {
        const orig = h.state.resolve;
        h.state.resolve = (table, ops) => table === 'schools'
            ? { data: { name: 'CLUB DEMO', owner_id: 'owner-1', slug: 'club-demo', address: op.direccion, payment_settings: {} }, error: null }
            : orig(table, ops);
    }
    if (op.catalogo || op.mapeo) conCatalogo(op.catalogo ?? [], op.mapeo);
    h.debeAtender.mockResolvedValue(op.atender
        ? { atender: true, tipo: 'desconocido', botEncendido: true, tomada: false }
        : { atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
    await handleBotTurn(req, INTEGRATION, CONV, mensaje(texto, 'wamid.0', op.botonId ?? null));
    return borradores().map((b) => ({
        texto: b.proposed_text,
        step: b.tool_context?.step ?? null,
        flujo: b.tool_context?.flujo ?? null,
        botones: (b.tool_context?.botones ?? b.botones ?? null),
    }));
}

/** Un interesado que ya escribió antes pidiendo información (así el bot lo reconoce como prospecto). */
const INTERESADO_PREVIO: Fila = {
    wa_message_id: 'wamid.i', direction: 'inbound', text_body: 'Hola, quiero información de las clases para mi hijo',
    ai_generated: false, created_at: hace(3600),
};

const PUERTA_ABIERTA: Fila = {
    wa_message_id: 'wamid.p', direction: 'outbound', text_body: '¿Qué necesitas?', ai_generated: true, created_at: hace(60),
    payload: { step: 'ask_email', flujo: 'puerta_desconocido', paso_puerta: 'menu', datos_puerta: {} },
};

const CASOS: [string, string, { botonId?: string | null; atender?: boolean; previos?: Fila[] }][] = [
    ['saludo suelto', 'Hola', {}],
    ['consulta sin tema (puerta de 3 botones)', 'Buenas, una consulta sobre lo del fin de semana', { atender: true }],
    ['quiero información', 'Hola, quiero información de las clases para mi hija', {}],
    ['clase de prueba', 'Buenas, quisiera una clase de prueba', {}],
    ['precio', 'Buenas, quisiera saber el costo y los horarios de las clases de voleibol', {}],
    ['puerta: «Quiero información»', 'Quiero información', { botonId: BOTON_PUERTA.INFO, atender: true, previos: [PUERTA_ABIERTA] }],
    ['puerta: «Otro tema»', 'Otro tema', { botonId: BOTON_PUERTA.OTRO, atender: true, previos: [PUERTA_ABIERTA] }],
    ['«Sí, acepto» de un desconocido', 'Sí, acepto', { botonId: BOTON.CONSENTIR_SI, atender: true }],
];

describe('Dynasty igual: con o sin las columnas del embudo el bot responde lo mismo', () => {
    it.each(CASOS)('%s', async (_n, texto, op) => {
        const sinColumnas = await respuesta('sin_columnas', texto, op);
        const conNull = await respuesta('columnas_null', texto, op);
        expect(conNull).toEqual(sinColumnas);
        // Salvo el «Hola» suelto (hoy, silencio), cada caso tiene una respuesta que comparar.
        if (texto !== 'Hola') expect(sinColumnas.length).toBeGreaterThan(0);
        // Nada del embudo se cuela en lo de hoy.
        expect(JSON.stringify(conNull)).not.toMatch(/sm_em_|"embudo"/);
    });

    it('lo de hoy, fijado: la primera respuesta al prospecto sigue siendo la de siempre', async () => {
        const r = await respuesta('columnas_null', 'Hola, quiero información de las clases para mi hija');
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('desconocido_tema_escolar');
        expect(r[0].flujo).toBe('clase_cortesia');
    });

    it('lo de hoy, fijado: la puerta de 3 botones y el «Hola» suelto (sin la variable de entorno, silencio)', async () => {
        const r = await respuesta('columnas_null', 'Buenas, una consulta sobre lo del fin de semana', { atender: true });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'ask_email', flujo: 'puerta_desconocido' });
        expect(r[0].botones.map((b: any) => b.id)).toEqual([BOTON_PUERTA.CLUB, BOTON_PUERTA.INFO, BOTON_PUERTA.OTRO]);
        expect(await respuesta('columnas_null', 'Hola')).toEqual([]);
    });

    // Dynasty 2026-11-04/08: «dónde queda la cancha» y «regrésame la llamada» recibían la oferta de
    // la clase de cortesía y el enlace de inscripción.
    it('«Donde queda la cancha»: la dirección de la escuela, sin la oferta de cortesía ni el enlace', async () => {
        const r = await respuesta('columnas_null', 'Donde queda la cancha', { direccion: 'Cl. 12 Bis #71g-09, Bogotá', previos: [INTERESADO_PREVIO] });
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('ubicacion_escuela');
        expect(r[0].texto).toContain('Cl. 12 Bis #71g-09, Bogotá');
        expect(r[0].texto).not.toMatch(/En este enlace|próximos horarios|Ver opciones/i);
    });

    it('«Donde queda la cancha» sin dirección cargada: la escuela la confirma (al buzón), sin inventar', async () => {
        const r = await respuesta('columnas_null', 'Donde queda la cancha', { direccion: null, previos: [INTERESADO_PREVIO] });
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('prospecto_seguimiento');
        expect(r[0].texto).toContain('le pasé tu pregunta a la escuela');
        expect(r[0].texto).not.toMatch(/En este enlace|próximos horarios|Ver opciones/i);
    });

    it('«Te agradezco si me puedes regresar la llamada»: pasa a una persona, sin la oferta de cortesía', async () => {
        const r = await respuesta('columnas_null', 'Te agradezco si me puedes regresar la llamada me gustaría hablar contigo', { previos: [INTERESADO_PREVIO] });
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('prospecto_seguimiento');
        expect(r[0].texto).toContain('para que te llamen o te escriban');
        expect(r[0].texto).not.toMatch(/En este enlace|próximos horarios|Ver opciones/i);
    });

    it('lo de hoy, fijado: el «Sí, acepto» de un número sin ficha', async () => {
        const r = await respuesta('columnas_null', 'Sí, acepto', { botonId: BOTON.CONSENTIR_SI, atender: true });
        expect(r.map((x) => x.texto).join('\n')).toContain('Este número todavía no está registrado en la escuela');
    });
});

describe('el motor con las lecturas reales (depsEmbudoDeSupabase)', () => {
    function ctx(enviados: any[]): CtxEmbudo {
        return {
            conversationId: CONV, schoolId: 'school-1', contactWaId: TEL,
            ...depsEmbudoDeSupabase('school-1', TEL),
            enviar: async (texto, step, estado, botones, enTexto, contexto) => { enviados.push({ texto, step, estado, botones, enTexto, contexto }); },
            elegirGrupo: async () => ({ principal: null, candidatos: [], otraSede: null, motivo: 'sin_grupo' as const }),
            guardarLead: async () => null,
            registrarOptIn: async () => {},
            avisarEscuela: async () => {},
        };
    }

    it.each(['sin_columnas', 'columnas_null'] as const)('Dynasty (%s): ajustes apagados, el motor no arranca ni atiende', async (escuela) => {
        base(escuela, []);
        expect(embudoActivo(await ajustesWhatsAppDeEscuela('school-1'))).toBe(false);
        const enviados: any[] = [];
        expect(await iniciarEmbudo(ctx(enviados))).toBe(false);
        for (const [t, b] of [['Hola', null], ['quiero información', null], ['Sede Norte', `sm_em_sede:${NORTE}`], ['Sí, claro', null]] as const) {
            expect(await atenderTurnoEmbudo(ctx(enviados), t, b)).toBe(false);
        }
        expect(enviados).toHaveLength(0);
    });

    it('Monster ve la bienvenida con sus sedes (dirección de school_branches)', async () => {
        base('monster', []);
        const enviados: any[] = [];
        expect(await iniciarEmbudo(ctx(enviados))).toBe(true);
        expect(enviados).toHaveLength(1);
        expect(enviados[0].texto).toBe(
            '¡Hola! 👋 Bienvenid@ a Club Monsters Volley 🏐⚡\nPara enviarte la información exacta, cuéntanos: ¿cuál sede te queda más cerca?\n\n' +
            '🟡 Sede Norte · Calle 201 #67-12\n⚫ Sede Suba · Calle 152 #94A-67');
        expect(enviados[0].botones.map((b: any) => b.title)).toEqual(['🟡 Sede Norte', '⚫ Sede Suba', 'Ya soy del club']);
        expect(enviados[0].estado).toEqual({ paso: 'sede', datos: {} });
    });
});

// ─── Integración (2026-10-30): el embudo cableado en el bot ──────────────────
describe('Monster con el bot cableado: el embudo reemplaza la cortesía, la puerta y el saludo', () => {
    const IDS_BIENVENIDA = [`sm_em_sede:${NORTE}`, `sm_em_sede:${SUBA}`, BOTON_PUERTA.CLUB];

    it('«quiero información»: SU bienvenida con sedes (emojis de la escuela intactos), step del freno de 30 días', async () => {
        const r = await respuesta('monster', 'Hola, quiero información de las clases para mi hija');
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'desconocido_tema_escolar', flujo: 'embudo' });
        expect(r[0].botones.map((b: any) => b.id)).toEqual(IDS_BIENVENIDA);
        // La bienvenida trae 5 emojis y el del voleibol: deliver no se los recorta.
        expect(r[0].texto).toContain('Bienvenid@ a Club Monsters Volley 🏐⚡');
        expect(r[0].texto).toContain('🟡 Sede Norte · Calle 201 #67-12');
        expect(r[0].texto).toContain('⚫ Sede Suba · Calle 152 #94A-67');
        expect(r[0].texto).not.toMatch(/gratis|cortes[ií]a/i);
    });

    it('el «Hola» suelto de un número nuevo recibe la bienvenida del embudo (sin la variable de entorno)', async () => {
        const r = await respuesta('monster', 'Hola');
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'desconocido_tema_escolar', flujo: 'embudo' });
        expect(r[0].botones.map((b: any) => b.id)).toEqual(IDS_BIENVENIDA);
    });

    it('una consulta sin tema (camino de identificación) recibe el embudo en vez de la puerta de 3 botones', async () => {
        const r = await respuesta('monster', 'Buenas, una consulta sobre lo del fin de semana', { atender: true });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'desconocido_tema_escolar', flujo: 'embudo' });
        expect(JSON.stringify(r)).not.toContain('puerta_desconocido');
    });

    it('tocar «Sede Norte» sigue el flujo: la primera pregunta de la escuela', async () => {
        const bienvenida: Fila = {
            wa_message_id: 'wamid.b', direction: 'outbound', text_body: '¡Hola! ¿cuál sede?', ai_generated: true, created_at: hace(60),
            payload: { step: 'desconocido_tema_escolar', flujo: 'embudo', paso_embudo: 'sede', datos_embudo: {} },
        };
        const r = await respuesta('monster', '🟡 Sede Norte', { botonId: `sm_em_sede:${NORTE}`, previos: [bienvenida] });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'embudo_pregunta', flujo: 'embudo' });
        expect(r[0].texto).toContain('¿Cuál es el nombre completo del deportista?');
    });

    it('B6: con el modo discreto global prendido, Monster («no») recibe el embudo y Dynasty («global») sigue callada', async () => {
        const antes = process.env.WHATSAPP_MODO_DISCRETO;
        process.env.WHATSAPP_MODO_DISCRETO = 'true';
        try {
            const monster = await respuesta('monster', 'Buenas, una consulta sobre lo del fin de semana', { atender: true });
            expect(monster).toHaveLength(1);
            expect(monster[0]).toMatchObject({ flujo: 'embudo' });
            const dynasty = await respuesta('columnas_null', 'Buenas, una consulta sobre lo del fin de semana', { atender: true });
            expect(dynasty).toEqual([]);
        } finally {
            process.env.WHATSAPP_MODO_DISCRETO = antes;
        }
    });
});

// ─── Después del embudo (Monster 2026-11-03): nunca silencio ─────────────────
describe('Monster: el interesado que ya pasó por el embudo nunca queda en silencio', () => {
    const DATOS = {
        leadId: 'lead-1', nombre: 'Mariana Gómez', genero: 'f', anio: 2012, branchId: NORTE, sedeTitulo: '🟡 Sede Norte',
        teamId: 't-1', grupo: 'Infantil Femenino', slotId: 's-a', consentimiento: 'si',
    };
    const BIENVENIDA: Fila = {
        wa_message_id: 'wamid.b', direction: 'outbound', text_body: '¡Hola! ¿cuál sede?', ai_generated: true, created_at: hace(900),
        payload: { step: 'desconocido_tema_escolar', flujo: 'embudo', paso_embudo: 'sede', datos_embudo: {} },
    };
    const PAGO: Fila = {
        wa_message_id: 'wamid.pago', direction: 'outbound', ai_generated: true, created_at: hace(120),
        text_body: '¡Listo! 🙌 Para confirmarlo, paga la clase de prueba ($15.000) por Nequi… envíame el comprobante 📸',
        payload: { step: 'embudo_esperando_pago', flujo: 'embudo', paso_embudo: 'esperando_pago', datos_embudo: DATOS },
    };
    const previos = [BIENVENIDA, PAGO];

    it('«Y para matricularla…?» después del pago: la respuesta de la matrícula y la escuela avisada', async () => {
        const r = await respuesta('monster', 'Y para matricularla después de la clase qué tengo que hacer?', { previos, historia: true });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'embudo_matricula', flujo: 'embudo' });
        expect(r[0].texto).toBe('La matrícula se hace después de la clase de prueba: el profe evalúa a Mariana, ' +
            'la escuela te confirma el grupo y te escribe por aquí para matricularla 🙌');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        // Aviso a la escuela (push) aunque la conversación ya estuviera abierta.
        expect(h.sendToUser).toHaveBeenCalled();
    });

    it('«ya te mandé el comprobante» (pagos sin precio: antes silencio total) → acuse, estado intacto y aviso', async () => {
        const r = await respuesta('monster', 'ya te mandé el comprobante', { previos, historia: true });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'embudo_pregunta_a_la_escuela', flujo: 'embudo' });
        expect(r[0].texto).toBe('¡Gracias por escribir! 🙌 Ya le pasé tu mensaje a la escuela y te responde por aquí.');
        const borrador = borradores()[0];
        expect(borrador.tool_context).toMatchObject({ paso_embudo: 'esperando_pago', datos_embudo: { slotId: 's-a' } });
        expect(h.sendToUser).toHaveBeenCalled();
    });

    it('con el acuse de 24 h ya gastado y sin modelo: acuse corto; ni silencio ni las franjas de cortesía de otro flujo', async () => {
        const acuse: Fila = {
            wa_message_id: 'wamid.acuse', direction: 'outbound', ai_generated: true, created_at: hace(40),
            text_body: '¡Gracias! 🙌 Ya pasé tu mensaje a la escuela y alguien te responde por aquí.',
            payload: { step: 'prospecto_seguimiento' },
        };
        const r = await respuesta('monster', 'Hola, y qué debo llevar a la clase de prueba?', { previos: [...previos, acuse], historia: true });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'embudo_pregunta_a_la_escuela', flujo: 'embudo' });
        expect(r[0].texto).toBe('Anotado 🙌 También se lo pasé a la escuela y te responde por aquí.');
    });

    it('un cierre de cortesía no se contesta; con una persona de la escuela escribiendo, tampoco', async () => {
        expect(await respuesta('monster', 'Muchas gracias, quedo atenta', { previos, historia: true })).toEqual([]);
        const persona: Fila = {
            wa_message_id: 'wamid.h', direction: 'outbound', ai_generated: false, created_at: hace(60),
            text_body: 'Hola, ya revisamos tu comprobante', payload: {},
        };
        expect(await respuesta('monster', 'ya te mandé el comprobante', { previos: [...previos, persona], historia: true })).toEqual([]);
    });

    it('«¿dónde queda la sede?» a mitad del registro: la de SU sede (antes, la dirección de la escuela: Suba a la Norte)', async () => {
        const interes: Fila = {
            wa_message_id: 'wamid.i', direction: 'inbound', text_body: 'Hola, quiero información para entrenar voleibol',
            ai_generated: false, created_at: hace(1000),
        };
        const pregunta: Fila = {
            wa_message_id: 'wamid.q', direction: 'outbound', ai_generated: true, created_at: hace(120),
            text_body: '¡Genial, 🟡 Sede Norte! 🙌\n\n1️⃣ ¿Cuál es el nombre completo del deportista?',
            payload: { step: 'embudo_pregunta', flujo: 'embudo', paso_embudo: 'pregunta', datos_embudo: { i: 0, respuestas: {}, branchId: NORTE, sedeTitulo: '🟡 Sede Norte' } },
        };
        const r = await respuesta('monster', 'donde queda la sede', { previos: [interes, BIENVENIDA, pregunta], historia: true });
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('prospecto_seguimiento_info');
        expect(r[0].texto).toContain('📍 La *Sede Norte* queda en Calle 201 #67-12.');
        expect(r[0].texto).not.toContain('Calle 152');
    });

    it('«cuanto vale la mensualidad» a mitad del registro de quien solo escribió «Hola»: el valor (antes, solo el acuse)', async () => {
        const hola: Fila = { wa_message_id: 'wamid.h0', direction: 'inbound', text_body: 'Hola', ai_generated: false, created_at: hace(1000) };
        const pregunta: Fila = {
            wa_message_id: 'wamid.q', direction: 'outbound', ai_generated: true, created_at: hace(120),
            text_body: '1️⃣ ¿Cuál es el nombre completo del deportista?',
            payload: { step: 'embudo_pregunta', flujo: 'embudo', paso_embudo: 'pregunta', datos_embudo: { i: 0, respuestas: {}, branchId: NORTE } },
        };
        const r = await respuesta('monster', 'cuanto vale la mensualidad', { previos: [hola, BIENVENIDA, pregunta], historia: true });
        expect(r).toHaveLength(1);
        expect(r[0].step).toBe('prospecto_seguimiento_precios');
        expect(r[0].texto).toMatch(/\$\s?150\.000/);
        // No se tomó como el nombre («¡Mucho gusto, Cuanto!»).
        expect(r[0].texto).not.toMatch(/mucho gusto/i);
    });

    it('lineaDeDireccionDelInteresado: la cancha de su clase, su sede o todas las del embudo', () => {
        const sedes = [{ id: NORTE, nombre: 'Sede Norte', direccion: 'Calle 201 #67-12' }, { id: SUBA, nombre: 'Sede Suba', direccion: 'Calle 152 #94A-67' }];
        expect(lineaDeDireccionDelInteresado({ lugar: { lugar: 'La Enseñanza', direccion: 'Calle 201 #67-12', mapsUrl: 'https://maps.app.goo.gl/x' }, branchId: SUBA, sedes }))
            .toBe('📍 La clase es en *La Enseñanza · Calle 201 #67-12*.\nCómo llegar: https://maps.app.goo.gl/x');
        expect(lineaDeDireccionDelInteresado({ branchId: SUBA, sedes })).toBe('📍 La *Sede Suba* queda en Calle 152 #94A-67.');
        expect(lineaDeDireccionDelInteresado({ sedes, sedesDelEmbudo: [NORTE, SUBA] }))
            .toBe('📍 Nuestras sedes:\n• *Sede Norte*: Calle 201 #67-12\n• *Sede Suba*: Calle 152 #94A-67');
        expect(lineaDeDireccionDelInteresado({ sedes: [] })).toBeNull();
    });

    it('Dynasty (sin embudo) con el mismo mensaje sigue igual: sin acuse del embudo', async () => {
        const sinColumnas = await respuesta('sin_columnas', 'ya te mandé el comprobante', { historia: true });
        const conNull = await respuesta('columnas_null', 'ya te mandé el comprobante', { historia: true });
        expect(conNull).toEqual(sinColumnas);
        expect(JSON.stringify(conNull)).not.toMatch(/embudo/);
    });
});

// ─── Anuncios con clic a WhatsApp (Monster 2026-11-04, whatsapp-anuncio-destino) ─
describe('anuncios: el destino del anuncio manda (la clínica nunca cae en el embudo de la clase de prueba)', () => {
    const hoy = new Date(Date.now() - 5 * 3600_000);
    const enDias = (n: number) => new Date(hoy.getTime() + n * 86400_000).toISOString().slice(0, 10);
    const CLINICA = {
        id: 'srv-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true,
        event_id: null, starts_at: '2030-11-21T05:00:00Z', ends_at: '2030-11-23T04:59:00Z', allow_installments: true,
        precio_afiliado: 250000, precios_por_fecha: [{ desde: enDias(7), precio: 350000 }], abono_minimo_pct: 50, opciones: null,
        description: 'Clínica con Jorge Mesa. Incluye camiseta oficial y fotografía con los ponentes.', image_url: null,
    };
    const ANUNCIO_CLINICA = {
        referral: { source_id: '120210000000001', source_type: 'ad', headline: 'Clínica de armadores y atacantes', body: 'Separa tu cupo', ctwa_clid: 'ARAk1' },
    };
    const ANUNCIO_CLASE = {
        referral: { source_id: '120210000000002', source_type: 'ad', headline: 'Tu clase de prueba de voleibol', body: 'Sede Norte o Suba' },
    };
    const IDS_BIENVENIDA = [`sm_em_sede:${NORTE}`, `sm_em_sede:${SUBA}`, BOTON_PUERTA.CLUB];

    beforeEach(async () => {
        const { mediosDePago } = await import('./whatsapp-medios-de-pago.service');
        (mediosDePago as any).mockResolvedValue({ cuentas: [{ tipo: 'Nequi', numero: '3194505150', titular: null }] });
    });

    it('clic en el anuncio de la clínica + «quiero información»: la ficha con el precio de hoy, no las sedes', async () => {
        const r = await respuesta('monster', 'Hola, quiero más información', { payload: ANUNCIO_CLINICA, catalogo: [CLINICA] });
        // La ficha y, aparte, «¿Qué quieres hacer?» con los botones de la venta (Monster 2026-11-09).
        expect(r).toHaveLength(2);
        expect((r[1].botones as any[]).map((b) => (typeof b === 'string' ? b : b.title))).toEqual(['Separar mi cupo', 'Hablar con alguien']);
        expect(r[0].step).toBe('desconocido_tema_escolar');
        expect(r[0].flujo).toBeNull();
        expect(r[0].botones ?? []).toEqual([]);
        expect(r[0].texto).toContain('*Clínica de armadores y atacantes*');
        expect(r[0].texto).toContain('Valor hoy: *$300.000*');
        expect(r[0].texto).toContain('*$350.000*');
        expect(r[0].texto).toContain('abono mínimo de *$150.000* (50 %)');
        // Frente A (2026-11-08): la ficha ya no trae la cuenta pegada; las cuentas van en un
        // mensaje aparte y solo si las pide. Sin pedirlas, la ficha cierra con el próximo paso.
        expect(r[0].texto).not.toContain('3194505150');
        expect(r[0].texto).toContain('respóndeme y te paso los datos de pago');
        expect(r[0].texto).not.toMatch(/sede|nombre completo|gratis|clase de prueba/i);
        // El motivo esperado (B4) y el lead con el servicio y el anuncio quedan registrados.
        const esperado = h.state.inserts.find((i) => i.table === 'whatsapp_conceptos_esperados')?.row;
        expect(esperado).toMatchObject({ motivo: 'clase_extra', monto: null, telefono: TEL });
        const lead = h.state.inserts.find((i) => i.table === 'school_signup_leads')?.row;
        expect(lead?.source_detail).toMatchObject({
            servicio_interes: { id: 'srv-clinica', nombre: 'Clínica de armadores y atacantes', tipo: 'clase_extra' },
            anuncio: { source_id: '120210000000001', headline: 'Clínica de armadores y atacantes', ctwa_clid: 'ARAk1' },
        });
        expect(borradores()[0].tool_context).toMatchObject({ destino_anuncio: 'servicio', servicio_id: 'srv-clinica' });
    });

    it('con el mapeo de la escuela: un anuncio que no dice «clínica» va a la clínica', async () => {
        const r = await respuesta('monster', 'Hola', {
            payload: { referral: { source_id: 'ad-generico', headline: '¡Inscríbete ya!' } },
            catalogo: [CLINICA], mapeo: { destino: 'servicio', servicio_id: 'srv-clinica' },
        });
        expect(r).toHaveLength(2); // la ficha y los botones
        expect(r[0].texto).toContain('*Clínica de armadores y atacantes*');
    });

    it('clic en el anuncio de la clase de prueba: el embudo de siempre (bienvenida con sedes)', async () => {
        const r = await respuesta('monster', 'Hola, quiero más información', { payload: ANUNCIO_CLASE, catalogo: [CLINICA] });
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ step: 'desconocido_tema_escolar', flujo: 'embudo' });
        expect(r[0].botones.map((b: any) => b.id)).toEqual(IDS_BIENVENIDA);
        expect(r[0].texto).not.toContain('Clínica');
    });

    it('«info de la clínica» sin anuncio: la ficha de la clínica', async () => {
        const r = await respuesta('monster', 'Buenas, info de la clínica', { catalogo: [CLINICA] });
        expect(r).toHaveLength(2); // la ficha y los botones de la venta
        expect(r[0].texto).toContain('*Clínica de armadores y atacantes*');
        expect(JSON.stringify(r)).not.toMatch(/sm_em_/);
    });

    it('Dynasty (sin embudo ni ventas): el mismo mensaje con o sin anuncio recibe lo de siempre', async () => {
        for (const escuela of ['sin_columnas', 'columnas_null'] as const) {
            const sinAnuncio = await respuesta(escuela, 'Hola, quiero información de las clases para mi hija');
            const conAnuncio = await respuesta(escuela, 'Hola, quiero información de las clases para mi hija',
                { payload: ANUNCIO_CLINICA, catalogo: [CLINICA] });
            expect(conAnuncio).toEqual(sinAnuncio);
            expect(JSON.stringify(conAnuncio)).not.toContain('Clínica');
        }
    });
});

describe('textos de la clase en el bot (B3) y respuesta a la campaña (B5 T7)', () => {
    it('por defecto, los literales de siempre; con valor, nunca «gratis»', () => {
        expect(claseConValor()).toBe('*clase de cortesía* gratis');
        expect(lineaPrimeraClase()).toBe('\n\nLa primera clase es de *cortesía* (gratis): escríbeme el día que quieres venir y te muestro los horarios.');
        const monster = textosDeClase({ nombre_clase: 'prueba', trial_price: 15000 });
        expect(claseConValor(monster)).toBe('*clase de prueba* (*$15.000*)');
        expect(lineaPrimeraClase(monster)).not.toMatch(/gratis|cortes[ií]a/i);
        expect(lineaPrimeraClase(monster)).toContain('*$15.000*');
    });

    it('lo que escriben después de la plantilla de campaña o del «Sí» lo contesta el bot; el «Más adelante» no', () => {
        const ahora = Date.now();
        const saliente = (step: string) => ({ payload: { step }, text_body: 'Hola María 🏐', created_at: new Date(ahora - 3600_000).toISOString() });
        expect(seguimientoQueContesta(saliente('campana'), ahora)).not.toBeNull();
        expect(seguimientoQueContesta(saliente('campana_respuesta_si'), ahora)).not.toBeNull();
        expect(seguimientoQueContesta(saliente('campana_respuesta_luego'), ahora)).toBeNull();
        expect(seguimientoQueContesta(saliente('desconocido_tema_escolar'), ahora)).toBeNull();
    });
});
