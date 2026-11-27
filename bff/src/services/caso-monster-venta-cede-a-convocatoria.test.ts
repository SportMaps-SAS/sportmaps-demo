/**
 * Auditoría Monster 2026-11-26, bug 2 (…5131 y …8713, llegaron por el anuncio «Aprovecha el black friday» de las
 * convocatorias): con una venta del Vacacional ABIERTA (`ventaActiva`, 7 días), «¡Hola! Quiero inscribirme a la
 * convocatoria de suba» recibía «Para separar tu cupo en el Vacacional de voleibol — Sede Suba… $100.000». Regla:
 * LA INTENCIÓN ACTUAL MANDA sobre un estado viejo; si el mensaje pide una convocatoria y la escuela tiene
 * convocatorias guiadas vigentes, la venta cede y el turno sigue al camino de la convocatoria.
 *
 * Andamiaje copiado de caso-monster-sin-prueba-ni-clinica.test.ts (Supabase encadenable, Meta y el modelo
 * mockeados) con los datos reales de Monster; aquí además el Vacacional activo y los mensajes que lee la venta.
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
        for (const m of ['select', 'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not', 'ilike', 'contains', 'filter', 'range']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.upsert = (row: any) => { state.inserts.push({ table, row }); ops.push(['upsert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.delete = () => { ops.push(['delete', []]); return b; };
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
        sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
        sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
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
    sendInteractiveList: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.lst' })),
    aFormatoWhatsApp: (t: string) => t,
    verifyWebhookSignature: vi.fn(),
    resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []),
    parseStatuses: vi.fn(() => []),
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '', registrarBajaDePromos: vi.fn(async () => undefined),
}));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn(async () => ({ cuentas: [] })) }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', async () => {
    const real = await vi.importActual<any>('./avisos-correo.service');
    return {
        ...real,
        avisarEscalamientoPorCorreo: vi.fn(async () => {}),
        destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Monster', correos: [] })),
        enviarConReserva: vi.fn(async () => 'enviado'),
    };
});
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { runBotTurn, _olvidarReservasDePaso, _limpiarCacheVocativos } from './whatsapp-bot.service';
import { BOTON_CC } from './whatsapp-clase-cortesia.service';
import { BOTON_PUERTA } from './whatsapp-puerta-desconocido';
import { BOTON_EMBUDO } from './whatsapp-embudo-prospecto';
import { invalidarCacheOfertas } from './bot-ofertas.service';
import { ventaCedeALaConvocatoria } from './whatsapp-venta-servicio';
import { preguntaPorConvocatoria } from './whatsapp-clase-cortesia.service';

// ─── Datos de Monster (de las migraciones) ──────────────────────────────────

const MONSTER = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const DYNASTY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLINICA_ID = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';
const CAMPANA_CLINICA = 'c1a1c1a1-0000-4000-8000-000000000001';
const CONV = 'conv-m';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const DESCONOCIDO = { atender: false, tipo: 'desconocido', botEncendido: true } as const;

const BLOQUEO = { tipo: 'clase_prueba', desde: '2026-12-01', hasta: '2027-01-31', motivo: 'En diciembre y enero no hay clases de prueba' };
const PREGUNTAS = `¡Queremos conocerte y conocer tu experiencia en el voleibol!
Para orientarte hacia la convocatoria que mejor se adapte a tu perfil, cuéntanos:
- *Año de nacimiento:*
- *Trayectoria deportiva:* ¿En qué clubes has entrenado y en qué torneos has participado?
- *Posición de juego:* ¿En qué posición juegas habitualmente?
- *Género:* ¿Masculino o femenino?`;
const NOTA = 'Durante las convocatorias realizaremos una evaluación objetiva de tus habilidades técnicas.';
const PROMO = '¡Este *viernes 27 de noviembre* tenemos una oportunidad especial para ti! *BLACK FRIDAY* 10% de descuento.';
const OFERTAS = [
    { id: 'norte', tipo: 'convocatoria', titulo: 'Convocatorias Sede Norte — grupos de formación', sede: 'Sede Norte', estado: 'activa',
        vigente_desde: '2026-11-25', vigente_hasta: '2026-12-12', prioridad: 30, requiere_inscripcion: true,
        publico: 'Grupos de formación, todas las categorías',
        descripcion: '¡Tenemos una oportunidad para que sigas creciendo en el voleibol!\nPor tu edad y perfil, te invitamos a participar en las *convocatorias de los grupos de formación de nuestra sede norte*.',
        cta: '¡Anímate a participar y comienza a construir tu camino en Monster’s Volley!' },
    { id: 'mayores', tipo: 'convocatoria', titulo: 'Convocatorias equipos mayores de competencia — Superliga', sede: 'Sede Norte', estado: 'activa',
        vigente_desde: '2026-11-25', vigente_hasta: '2026-12-11', prioridad: 20, requiere_inscripcion: true,
        descripcion: 'Por tu trayectoria y perfil deportivo, te invitamos a participar en las *convocatorias de los equipos mayores de competencia de Monster’s Volley*.',
        cta: '¡Queremos conocer tu talento!\nEl valor de participación es de *$145.000*.',
        anio_nacimiento_hasta: 2008, requiere_trayectoria: true, requiere_pago: true, valor: 145000 },
    { id: 'suba', tipo: 'convocatoria', titulo: 'Convocatorias Sede Suba (Parque Pinar de Suba)', sede: 'Sede Suba', genero: 'mixto', estado: 'activa',
        vigente_desde: '2026-11-25', vigente_hasta: '2026-12-13', prioridad: 10, requiere_inscripcion: true,
        publico: 'Grupos de proyección, nacidas y nacidos de 2009 a 2022',
        descripcion: 'Por tu año de nacimiento, te invitamos a participar en las *convocatorias de los grupos de proyección de nuestra sede Suba*.',
        cta: 'El valor de participación en las convocatorias para los grupos de proyección es de *$145.000*.',
        anio_nacimiento_desde: 2009, anio_nacimiento_hasta: 2022, requiere_pago: true, valor: 145000 },
];
const SESIONES = [
    ...['2026-12-05', '2026-12-06'].map((f, i) => ({ id: `n${i}`, oferta_id: 'norte', fecha: f, hora_inicio: '07:00:00', hora_fin: '09:00:00', lugar: 'Locos por Pádel' })),
    { id: 'n9', oferta_id: 'norte', fecha: '2026-12-12', hora_inicio: '08:00:00', hora_fin: '10:00:00', lugar: 'Universidad ECCI' },
    ...['2026-12-01', '2026-12-03', '2026-12-09', '2026-12-11'].flatMap((f, i) => [
        { id: `mf${i}`, oferta_id: 'mayores', fecha: f, hora_inicio: '19:00:00', hora_fin: '21:00:00', lugar: 'Universidad ECCI', genero: 'femenino' },
        { id: `mm${i}`, oferta_id: 'mayores', fecha: f, hora_inicio: f === '2026-12-09' ? '20:00:00' : '19:00:00', hora_fin: f === '2026-12-09' ? '22:00:00' : '21:00:00', lugar: 'Universidad ECCI', genero: 'masculino' },
    ]),
    ...['2026-12-04', '2026-12-11'].flatMap((f, i) => [
        { id: `sv${i}a`, oferta_id: 'suba', fecha: f, hora_inicio: '13:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos entre 2017 y 2022' },
        { id: `sv${i}b`, oferta_id: 'suba', fecha: f, hora_inicio: '15:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2013 y 2014' },
        { id: `sv${i}c`, oferta_id: 'suba', fecha: f, hora_inicio: '19:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2009 y 2010' },
    ]),
    ...['2026-12-05', '2026-12-06', '2026-12-12', '2026-12-13'].flatMap((f, i) => [
        { id: `ss${i}a`, oferta_id: 'suba', fecha: f, hora_inicio: '09:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2013 y 2014' },
        { id: `ss${i}b`, oferta_id: 'suba', fecha: f, hora_inicio: '11:00:00', hora_fin: null, lugar: 'Parque Pinar de Suba', genero: 'mixto', publico: 'Nacidos en 2011 y 2012' },
    ]),
];

/** Franjas de clase de prueba: una antes del bloqueo, una dentro, una después. */
const FRANJAS = [
    { id: 'slot-nov', label: 'Iniciación', slot_date: '2026-11-28', start_time: '09:00:00', end_time: '10:30:00', location: 'Sede Norte', spots_left: 4 },
    { id: 'slot-dic', label: 'Iniciación', slot_date: '2026-12-05', start_time: '09:00:00', end_time: '10:30:00', location: 'Sede Norte', spots_left: 4 },
    { id: 'slot-feb', label: 'Iniciación', slot_date: '2027-02-06', start_time: '09:00:00', end_time: '10:30:00', location: 'Sede Norte', spots_left: 4 },
];
const FILAS_SLOTS = FRANJAS.map((f) => ({
    id: f.id, team_id: 'team-1', slot_date: f.slot_date, start_time: f.start_time, end_time: f.end_time,
    location: f.location, max_capacity: 10, reserved_count: 0, label: f.label, is_open: true, school_id: MONSTER,
}));

const CLINICA = {
    id: CLINICA_ID, school_id: MONSTER, name: 'Clínica de armadores y atacantes', kind: 'clinica', price: 180000, active: false,
    event_id: null, starts_at: '2026-12-06T13:00:00Z', ends_at: '2026-12-07T22:00:00Z',
    description: 'Clínica de armadores y atacantes con entrenadores invitados. Preventa $150.000.', capacity: 40, created_at: '2026-11-01T00:00:00Z',
};
/** El Vacacional real (scratchpad/auditoria/fixture.json, `items[0]`), en venta hasta el 11-dic. */
const VACACIONAL_ID = 'fff41827-cd2f-404a-b0ff-f42dc66c59a8';
const VACACIONAL = {
    id: VACACIONAL_ID, school_id: MONSTER, name: 'Vacacional de voleibol — Sede Suba', kind: 'vacacional', price: 100000, active: true,
    event_id: null, starts_at: '2026-11-17T08:00:00-05:00', ends_at: '2026-12-11T11:00:00-05:00', capacity: null,
    description: '🏐 *Vacacional de voleibol · Sede Suba*\n📍 Parque Pinar de Suba 2\n📅 Hasta el 11 de diciembre · martes, miércoles y jueves\n⏰ 8:00 a 11:00 a. m.',
    allow_installments: false, precio_afiliado: null, precios_por_fecha: null, abono_minimo_pct: null, precios_afiliado_por_fecha: null,
    opciones: [
        { clave: '1', precio: 100000, etiqueta: '1 semana', precio_afiliado: 80000 },
        { clave: '2', precio: 140000, etiqueta: '2 semanas', precio_afiliado: 120000 },
        { clave: '3', precio: 170000, etiqueta: '3 semanas', precio_afiliado: 150000 },
    ],
};
const CAMPANA = {
    id: CAMPANA_CLINICA, school_id: MONSTER, integration_id: 'int-m', nombre: 'monster_clinica_cupos_2026',
    respuesta_si: '¡Genial! 🙌 La *Clínica de armadores y atacantes* es el 6 y 7 de diciembre. Valor $180.000. ¿Separamos tu cupo?',
    estado: 'terminada', vence_at: '2026-11-22T00:00:00Z', servicio_id: CLINICA_ID,
};

// ─── Andamiaje ──────────────────────────────────────────────────────────────

interface Escenario {
    schoolId?: string;
    conConfig?: boolean;      // bot_ofertas / bloqueos / ajustes de Monster
    embudo?: boolean;         // wa_preguntas_prospecto (Monster lo tiene)
    ultimoSaliente?: any;
    familia?: boolean;
    /** tool_context de los borradores anteriores (el estado de los flujos de varios turnos). */
    historial?: any[];
    /** Los mensajes recientes de la conversación (`mensajesRecientes`): p. ej. el entrante con el anuncio. */
    recientes?: any[];
    /** El Vacacional de voleibol (fixture real) activo en el catálogo. */
    vacacional?: boolean;
    /** Los mensajes de 7 días que lee la venta (`mensajesParaVenta`): la venta abierta. */
    ventaMensajes?: any[];
}

function montar(e: Escenario = {}) {
    const schoolId = e.schoolId ?? MONSTER;
    const conConfig = e.conConfig ?? schoolId === MONSTER;
    h.state.resolve = (table, ops) => {
        const pasoPedido = ops.find(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step'))?.[1]?.[1];
        if ((table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') && pasoPedido) return { count: 0, data: [], error: null };
        const hist = e.historial ?? [];
        const t0 = Date.now();
        if (hist.length && table === 'whatsapp_messages' && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('payload, created_at'))) {
            return { data: [...hist].reverse().map((p, i) => ({ payload: p, created_at: new Date(t0 - (i + 1) * 1000).toISOString(), ai_generated: true })), error: null };
        }
        if (hist.length && table === 'whatsapp_message_drafts' && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('tool_context'))) {
            return { data: [...hist].reverse().map((p, i) => ({ tool_context: p, created_at: new Date(t0 - (i + 1) * 1000).toISOString() })), error: null };
        }
        if (e.recientes && table === 'whatsapp_messages'
            && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('wa_message_id, direction'))) {
            return { data: e.recientes, error: null };
        }
        if (table === 'whatsapp_messages'
            && ops.some(([m, a]) => m === 'select' && String(a[0]).startsWith('direction, type, text_body'))) {
            return { data: e.ventaMensajes ?? [], error: null };
        }
        if (table === 'whatsapp_messages' && ops.some(([m]) => m === 'order')) {
            if (!e.ultimoSaliente && hist.length) return { data: { payload: hist.at(-1), created_at: new Date(t0 - 1000).toISOString() }, error: null };
            return { data: e.ultimoSaliente ? { payload: e.ultimoSaliente, created_at: new Date().toISOString() } : null, error: null };
        }
        if (table === 'whatsapp_conversations') {
            return { data: e.familia
                ? { id: CONV, parent_id: 'parent-1', identified: true, status: 'open', contact_name: 'A.' }
                : { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: null }, error: null };
        }
        if (table === 'profiles') return { data: { full_name: 'Acudiente Pérez' }, error: null };
        if (table === 'school_join_qr_codes') return { data: [], error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
        if (table === 'schools') return { data: { name: schoolId === MONSTER ? "Monster's Volley" : 'Dynasty', owner_id: 'owner-1', slug: 'escuela' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'school_signup_leads') return { data: [], error: null };
        if (table === 'school_trial_slots') return { data: FILAS_SLOTS.map((s) => ({ ...s, school_id: schoolId })), error: null };
        if (table === 'school_tournament_items') {
            // `serviciosDeAnuncio` filtra active=true: la clínica está inactiva.
            const soloActivos = ops.some(([m, a]) => m === 'eq' && a[0] === 'active' && a[1] === true);
            if (schoolId !== MONSTER) return { data: [], error: null };
            const vac = e.vacacional ? [VACACIONAL] : [];
            return { data: soloActivos ? vac : [CLINICA, ...vac], error: null };
        }
        if (table === 'whatsapp_campanas') return { data: schoolId === MONSTER ? CAMPANA : null, error: null };
        if (table === 'whatsapp_campana_envios') return { data: { id: 'env-1', estado: 'enviado' }, error: null };
        if (table === 'bot_oferta_bloqueos') return { data: conConfig ? [BLOQUEO] : [], error: null };
        if (table === 'bot_ofertas') return { data: conConfig ? OFERTAS : [], error: null };
        if (table === 'bot_oferta_sesiones') return { data: conConfig ? SESIONES : [], error: null };
        if (table === 'bot_ofertas_ajustes') {
            return { data: conConfig ? {
                mensaje_sin_ofertas: 'En este momento no tenemos convocatorias abiertas; la escuela te escribe con las próximas fechas.',
                preguntas_ofertas: PREGUNTAS, nota_ofertas: NOTA, promo_texto: PROMO, promo_desde: '2026-11-25', promo_hasta: '2026-11-27',
            } : null, error: null };
        }
        if (e.embudo && table === 'school_settings') {
            return { data: { wa_modo_cortesia: 'clase', wa_preguntas_prospecto: [
                { clave: 'nombre', texto: '¿Cuál es el nombre completo del deportista?', tipo: 'texto' }] }, error: null };
        }
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'list_open_trial_slots_public') return { data: FRANJAS, error: null };
        if (fn === 'wa_identify_by_phone') {
            return { data: e.familia ? { estado: 'identificado', parent_id: 'parent-1' } : { estado: 'desconocido' }, error: null };
        }
        if (fn === 'submit_school_lead') return { data: { ok: true, lead_id: 'lead-9', duplicate: false }, error: null };
        return { data: null, error: null };
    };
    h.debeAtender.mockResolvedValue(e.familia
        ? { atender: true, tipo: 'familia', botEncendido: true, parentId: 'parent-1' }
        : DESCONOCIDO);
    h.botEncendido.mockResolvedValue(true);
    // El modelo, si lo llaman, contesta algo neutro: lo que se revisa es su PROMPT.
    h.chatWithTools.mockResolvedValue({ text: 'Con gusto te ayudo.', toolCalls: [], provider: 'test' });
}

/** Todo lo que salió (o quedó en borrador) hacia el contacto, y los prompts que vio el modelo. */
function salidas() {
    const textos: string[] = [];
    const botones: { id: string; title: string }[] = [];
    for (const i of h.state.inserts) {
        if (i.table === 'whatsapp_message_drafts') {
            textos.push(String(i.row.proposed_text ?? ''));
            botones.push(...(i.row.tool_context?.botones ?? []));
            for (const f of i.row.tool_context?.filas ?? i.row.tool_context?.lista ?? []) botones.push(f);
        }
    }
    for (const c of h.state.rpcCalls) if (c.fn === 'wa_record_outbound_message') textos.push(String(c.args?.p_text_body ?? ''));
    for (const c of h.sendTextMessage.mock.calls as any[]) textos.push(String(c[2] ?? ''));
    for (const c of h.sendInteractiveButtons.mock.calls as any[]) { textos.push(String(c[2] ?? '')); botones.push(...(c[3] ?? [])); }
    const prompts = (h.chatWithTools.mock.calls as any[]).map((c) => String(c[0]?.system ?? ''));
    return { texto: textos.join('\n---\n'), textos, botones, ids: botones.map((b) => String(b.id ?? '')), prompts };
}

/** Señales de que se OFRECE / agenda / lista / cotiza la clase de prueba. */
const IDS_DE_CLASE = /^(sm_cc_f:|sm_cc_mas|sm_cc_datos_si|sm_cc_confirmar|sm_em_f:|sm_em_mas|sm_pd_cortesia)/;
const TEXTO_DE_CLASE = new RegExp([
    'Iniciación',                                             // etiqueta de la franja
    'próximas franjas',
    '¿Cuál te reservo',
    'tu clase de (prueba|cortesía) (quedó|está)',
    '(agendar|agenda|reservar|separar|apartar)( tu| una| la)? clase',
    'clase (de prueba|de cortesía|gratis)[^.\\n]{0,40}(\\$|gratis|sin costo|vale)',
    '(quieres|puedes|te invito a|te invitamos a|anímate a) (venir a |tomar |hacer |agendar )?(una|la|tu) clase',
    'dejar(me)? tus datos',
].join('|'), 'i');
const TEXTO_DE_CLINICA = /cl[ií]nica|armadores|atacantes|180\.000|150\.000/i;
/** Lo que el prompt del modelo NO puede traer si hoy no hay clase. */
const PROMPT_QUE_OFRECE_CLASE = /y agenda paso a paso|agendar la CLASE DE CORTESIA|que te escriba el día que quiere venir/;

function sinClaseNiClinica(s: ReturnType<typeof salidas>, o: { mudoVale?: boolean } = {}) {
    const err = `\nSALIDAS:\n${s.texto}\nBOTONES: ${JSON.stringify(s.ids)}`;
    if (process.env.VER_SALIDAS) console.log(`${expect.getState().currentTestName}${err}\nPROMPTS: ${s.prompts.length}`);
    // Algo tiene que salir (un turno mudo no prueba nada): texto al contacto o borrador.
    if (!o.mudoVale) expect(s.textos.filter((t) => t.trim()).length, `turno mudo${err}`).toBeGreaterThan(0);
    expect(s.ids.filter((id) => IDS_DE_CLASE.test(id)), err).toEqual([]);
    expect(s.texto, err).not.toMatch(TEXTO_DE_CLASE);
    expect(s.texto, err).not.toMatch(TEXTO_DE_CLINICA);
    for (const p of s.prompts) {
        expect(p, 'prompt del modelo ofrece la clase').not.toMatch(PROMPT_QUE_OFRECE_CLASE);
        expect(p, 'prompt del modelo').toMatch(/NO HAY CLASES DE PRUEBA|NO TIENE CLASES DE PRUEBA/);
    }
    expect(h.state.rpcCalls.map((c) => c.fn), err).not.toContain('submit_school_lead');
    expect(h.state.rpcCalls.map((c) => c.fn), err).not.toContain('tomar_cupo_clase_prueba');
}

const INTEG = (schoolId = MONSTER) => ({ id: schoolId === MONSTER ? 'int-m' : 'int-d', school_id: schoolId }) as any;
let n = 0;
const mensaje = (over: Record<string, any> = {}) => ({
    phoneNumberId: 'pn-1', contactWaId: '573209998877', contactName: null,
    waMessageId: `wamid.m${n++}`, type: 'text', textBody: 'hola', raw: {}, waTimestamp: null, ...over,
}) as any;

async function turno(e: Escenario, texto: string, botonId: string | null = null) {
    invalidarCacheOfertas();
    _olvidarReservasDePaso();
    _limpiarCacheVocativos();
    montar(e);
    await handleBotTurn(req, INTEG(e.schoolId), CONV, mensaje({
        type: botonId ? 'interactive' : 'text', textBody: texto, botonId,
    }));
    return salidas();
}

const DIA = {
    dic02: '2026-12-02T15:00:00Z',   // 10:00 Bogotá
    dic20: '2026-12-20T15:00:00Z',   // ya no quedan convocatorias, sigue el bloqueo
    nov26: '2026-11-26T15:00:00Z',
    feb01: '2027-02-01T15:00:00Z',
};
const enFecha = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) });

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcCalls = [];
    invalidarCacheOfertas();
});
afterEach(() => { vi.useRealTimers(); invalidarCacheOfertas(); });

// ─── Escenarios ─────────────────────────────────────────────────────────────

describe('Monster, 26 de noviembre: venta del Vacacional ABIERTA y pide una convocatoria (…5131 / …8713)', () => {
    // La ficha del Vacacional salió hace 2 días (marca de la venta; 7 días de vigencia): `ventaActiva` la sostiene.
    const ventaAbierta = () => {
        const t = new Date(Date.now() - 2 * 86_400_000).toISOString();
        return [
            { direction: 'inbound', type: 'text', text_body: 'Hola, info del vacacional', ai_generated: false, created_at: t, wa_timestamp: t },
            { direction: 'outbound', type: 'text', text_body: '🏐 *Vacacional de voleibol · Sede Suba* 📍 Parque Pinar de Suba 2. Valor $100.000.',
                ai_generated: true, created_at: t, wa_timestamp: t, venta_servicio_id: VACACIONAL_ID, step: 'venta_servicio_ficha' },
        ];
    };
    const VENTA_DEL_VACACIONAL = /separar tu cupo en el Vacacional|Vacacional de voleibol|100\.000|1 semana/i;
    const TEXTO = '¡Hola! Quiero inscribirme a la convocatoria de suba';

    for (const embudo of [false, true]) {
        it(`desconocido: «${TEXTO}» → convocatoria guiada, NO la venta del Vacacional${embudo ? ' [con embudo]' : ''}`, async () => {
            enFecha(DIA.nov26);
            const s = await turno({ embudo, vacacional: true, ventaMensajes: ventaAbierta() }, TEXTO);
            const err = `\n${s.texto}\n${JSON.stringify(s.ids)}`;
            if (process.env.VER_SALIDAS) console.log(err);
            expect(s.texto, err).not.toMatch(VENTA_DEL_VACACIONAL);
            expect(s.texto, err).toMatch(/¿La convocatoria es para|¿En qué año nació|femenin|masculin/i);
            expect(s.texto, err).not.toMatch(TEXTO_DE_CLASE);
        });
    }

    it('control: con la venta abierta, lo que es de ella («¿cuánto vale el vacacional?») sigue en la venta', async () => {
        enFecha(DIA.nov26);
        const s = await turno({ vacacional: true, ventaMensajes: ventaAbierta() }, '¿cuánto vale el vacacional?');
        expect(s.texto, s.texto).toMatch(/Vacacional|100\.000/i);
    });
});

describe('ventaCedeALaConvocatoria (pura): la intención actual manda', () => {
    const o = { pideConvocatoria: preguntaPorConvocatoria, hayConvocatoriasGuiadas: true };
    const item = VACACIONAL as any;
    it('pide una convocatoria sin nombrar el servicio → cede (desconocido y familia)', () => {
        expect(ventaCedeALaConvocatoria(['¡Hola! Quiero inscribirme a la convocatoria de suba'], item, o)).toBe(true);
        expect(ventaCedeALaConvocatoria(['quiero inscribir a mi hija a la convocatoria de suba'], item, o)).toBe(true);
        expect(ventaCedeALaConvocatoria(['hola', 'cuándo son las convocatorias femeninas?'], null, o)).toBe(true);
    });
    it('no cede: nombra el servicio de la venta, no pide convocatoria o la escuela no tiene convocatorias guiadas', () => {
        expect(ventaCedeALaConvocatoria(['¿la convocatoria es la misma del vacacional?'], item, o)).toBe(false);
        expect(ventaCedeALaConvocatoria(['¿cuánto vale el vacacional?'], item, o)).toBe(false);
        expect(ventaCedeALaConvocatoria(['ya pagué'], item, o)).toBe(false);
        expect(ventaCedeALaConvocatoria(['Quiero inscribirme a la convocatoria de suba'], item, { ...o, hayConvocatoriasGuiadas: false })).toBe(false);
    });
});
