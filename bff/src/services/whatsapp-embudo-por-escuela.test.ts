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
import { BOTON, _olvidarReservasDePaso, seguimientoQueContesta, claseConValor, lineaPrimeraClase } from './whatsapp-bot.service';
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

/** Lo que el bot hace HOY con ese mensaje: texto, step y botones del borrador. */
async function respuesta(escuela: Escuela, texto: string, op: { botonId?: string | null; atender?: boolean; previos?: Fila[] } = {}) {
    vi.clearAllMocks();
    _olvidarReservasDePaso();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.deletes = [];
    const filas: Fila[] = [
        ...(op.previos ?? []),
        { wa_message_id: 'wamid.0', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(2) },
    ];
    base(escuela, filas);
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
