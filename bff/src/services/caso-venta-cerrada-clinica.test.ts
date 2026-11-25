/**
 * Monster 2026-11-20: la VENTA de la Clínica de armadores y atacantes terminó el 20-nov (la clínica es el 21 y 22).
 * Desde ya el bot no cotiza, no vende ni hace seguimiento comercial de la clínica a quien es NUEVO: UN mensaje fijo
 * y el chat pasa a la escuela. Quien YA abonó sigue con su saldo y sus comprobantes. El vacacional sigue igual.
 * Sin este camino, al salir la clínica de las superficies de venta el bot caía al embudo de la clase de prueba y le
 * ofrecía $15.000 a quien preguntaba por la clínica (error ya ocurrido el 8-nov). Nombres inventados.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state = {
        filas: [] as any[],
        items: [] as any[],
        lead: null as any,
        pagos: [] as any[],
    };
    const momento = (f: any) => new Date(f.wa_timestamp || f.created_at || 0).getTime();
    const plano = (f: any) => {
        const p = f.payload ?? {};
        return {
            direction: f.direction, type: f.type, text_body: f.text_body, ai_generated: f.ai_generated,
            wa_timestamp: f.wa_timestamp, created_at: f.created_at,
            venta_servicio_id: p.venta_servicio_id ?? null, servicio_id: p.servicio_id ?? null, step: p.step ?? null,
            campana_id: p.campana_id ?? null, destino_anuncio: p.destino_anuncio ?? null, caption: null,
            venta_cerrada: p.venta_cerrada ?? null,
        };
    };
    function resolver(table: string, ops: Ops, single: boolean): any {
        const eqs = ops.filter(([m]) => m === 'eq').map(([, a]) => a);
        if (table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') {
            if (table === 'whatsapp_message_drafts') return { data: single ? null : [], count: 0, error: null };
            const sel = String(ops.find(([m]) => m === 'select')?.[1]?.[0] ?? '');
            let filas = [...state.filas].sort((a, b) => momento(b) - momento(a));
            for (const [c, v] of eqs) {
                if (c === 'direction') filas = filas.filter((f) => f.direction === v);
                else if (c === 'payload->>step') filas = filas.filter((f) => f.payload?.step === v);
                else if (c === 'ai_generated') filas = filas.filter((f) => f.ai_generated === v);
            }
            if (ops.some(([m]) => m === 'ilike' || m === 'or')) return { data: [], count: 0, error: null };
            if (ops.some(([m]) => m === 'update')) return { data: [], error: null };
            const data = sel.includes('payload->>') ? filas.map(plano) : filas;
            return { data: single ? (data[0] ?? null) : data, count: data.length, error: null };
        }
        if (table === 'school_tournament_items') return { data: state.items, error: null };
        if (table === 'payments') return { data: single ? (state.pagos[0] ?? null) : state.pagos, error: null };
        if (table === 'school_signup_leads') {
            if (ops.some(([m]) => m === 'update' || m === 'insert')) return { data: [], error: null };
            return { data: single ? state.lead : (state.lead ? [state.lead] : []), error: null };
        }
        if (table === 'whatsapp_optins') return { data: single ? null : [], error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: 'conv-1', contact_wa_id: '573001112233', parent_id: null, identified: false, status: 'open', contact_name: 'Laura', tomada_por: null, tomada_hasta: null }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'auto', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'schools') return { data: { name: 'Club Inventado', slug: 'club-inventado' }, error: null };
        if (table === 'school_trial_class_settings') return { data: { nombre_clase: 'prueba', trial_price: 15000 }, error: null };
        return { data: single ? null : [], error: null };
    }
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains', 'ilike', 'insert', 'update', 'upsert', 'delete']) b[m] = chain(m);
        b.maybeSingle = () => Promise.resolve(resolver(table, ops, true));
        b.single = () => Promise.resolve(resolver(table, ops, true));
        b.then = (res: any, rej: any) => Promise.resolve(resolver(table, ops, false)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: { from: (t: string) => makeBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) },
        botEncendido: vi.fn(async () => true),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, botEncendido: h.botEncendido };
});
vi.mock('./whatsapp-ajustes-escuela.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-ajustes-escuela.service')>('./whatsapp-ajustes-escuela.service');
    const ajustes = {
        ...real.AJUSTES_POR_DEFECTO, modoDiscreto: 'no' as const,
        preguntasProspecto: [
            { clave: 'nombre', texto: '1️⃣ ¿Cuál es el *nombre completo* del deportista?', tipo: 'texto' },
            { clave: 'fecha_nacimiento', texto: '2️⃣ ¿Cuál es su *fecha de nacimiento*? (día/mes/año)', tipo: 'fecha' },
        ] as any,
    };
    return { ...real, ajustesWhatsAppDeEscuela: vi.fn(async () => ajustes), modoDiscretoEfectivo: vi.fn(async () => false) };
});
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    resolveIntegration: vi.fn(),
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '',
    levantarBajaDePromos: vi.fn(async () => false),
    registrarBajaDePromos: vi.fn(async () => true),
    leerOptinsDeContactos: vi.fn(async () => new Map()),
    sinPromociones: () => false,
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({
    mediosDePago: vi.fn(async () => ({ cuentas: [{ tipo: 'Nequi', titular: 'Persona Inventada', numero: '3001234567' }] })),
}));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    etiquetaDeContacto: vi.fn(() => 'Contacto'),
}));
vi.mock('./whatsapp-prospecto-lead.service', () => ({
    registrarLeadDeProspecto: vi.fn(async () => null),
    variantesTelefonoLead: (t: string) => [t],
}));
vi.mock('./wa-concepto-esperado.service', () => ({ registrarConceptoEsperado: vi.fn(async () => true) }));

import { atenderDesconocido, simularEnvios, _olvidarPresentaciones } from './whatsapp-bot.service';
import { MARCA_VENTA, servicioCerradoQueSeConsulta } from './whatsapp-venta-contexto';
import { serviciosDeAnuncio, textoVentaCerrada, ventaCerradaDeItem } from './whatsapp-anuncio-destino';
import { seguimientoDeVentaDelLead } from './whatsapp-prospecto-seguimiento.service';

const INTEG = { id: 'int-1', school_id: 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c' } as any;
const TEL = '573001112233';
const ID_CLINICA = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';
const CLINICA = {
    id: ID_CLINICA, name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: '300000.00', active: true, event_id: null, starts_at: '2026-11-21T05:00:00Z', ends_at: '2026-11-23T04:59:59Z',
    allow_installments: true, precio_afiliado: null, precios_por_fecha: null, abono_minimo_pct: 50, opciones: null,
    description: '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES! 🔥 Dos jornadas con referentes del voleibol.',
};
const VACACIONAL = {
    id: '22222222-2222-4222-8222-222222222222', name: 'Vacacional de verano', kind: 'vacacional',
    price: '400000.00', active: true, event_id: null, starts_at: '2026-12-01T05:00:00Z', ends_at: '2099-12-20T04:59:59Z',
    allow_installments: false, precio_afiliado: null, precios_por_fecha: null, abono_minimo_pct: null, opciones: null,
    description: 'Vacacional de verano: deporte y juego para los niños.',
};
const FIJO = 'Las inscripciones de la *Clínica de armadores y atacantes* ya cerraron: la clínica es mañana y el domingo (21 y 22 de noviembre). '
    + 'Si ya abonaste y falta tu saldo, envíanos por aquí el comprobante con el nombre completo del deportista y la escuela te lo confirma. '
    + 'Para cualquier otra pregunta, ya le pasé tu mensaje a la escuela y te responde por aquí 🙌';
const PROHIBIDO = /elige la sede|sede que te queda|clase de prueba|5 preguntas|\$15\.000|\$300\.000|\$332\.500|datos de pago|Nequi/i;

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ent = (min: number, texto: string, extra: any = {}) =>
    ({ wa_message_id: `in-${min}`, direction: 'inbound', type: 'text', text_body: texto, payload: {}, ai_generated: false, created_at: hace(min), wa_timestamp: hace(min), ...extra });
const sal = (min: number, texto: string, extra: any = {}) =>
    ({ wa_message_id: `out-${min}`, direction: 'outbound', type: 'text', text_body: texto, payload: {}, ai_generated: true, created_at: hace(min), wa_timestamp: hace(min), ...extra });

async function turno(texto: string, botonId: string | null = null) {
    h.state.filas.unshift(ent(0, texto, botonId ? { type: 'interactive' } : {}));
    return simularEnvios(() => atenderDesconocido(INTEG, 'conv-1', TEL, texto, botonId));
}

beforeEach(() => {
    vi.clearAllMocks();
    _olvidarPresentaciones();
    h.state.items = [CLINICA, VACACIONAL];
    h.state.filas = [];
    h.state.lead = null;
    h.state.pagos = [];
    // El caso es el 20-nov (venta cerrada, clínica el 21 y 22). Se fija el reloj: con
    // Date.now() real, desde el 23-nov la clínica ya terminó y los tests se caían solos.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-20T15:00:00Z') });
    // Se cierra YA por la variable (la fecha de la prueba es anterior al 21-nov).
    vi.stubEnv('WA_VENTAS_CERRADAS_ITEMS', ID_CLINICA);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('ventaCerradaDeItem (pura)', () => {
    const base = { id: 'x', kind: 'clase_extra', starts_at: '2026-11-21T05:00:00Z' };
    it('la variable WA_VENTAS_CERRADAS_ITEMS cierra YA (lista separada por comas, sin importar mayúsculas ni espacios)', () => {
        const antes = new Date('2026-11-20T15:00:00Z').getTime();
        expect(ventaCerradaDeItem(base, antes, '')).toBe(false);
        expect(ventaCerradaDeItem(base, antes, undefined)).toBe(false);
        expect(ventaCerradaDeItem(base, antes, 'otro, X ,más')).toBe(true);
        expect(ventaCerradaDeItem({ ...base, kind: 'vacacional' }, antes, 'x')).toBe(true);
        expect(ventaCerradaDeItem(base, antes, ['otro', 'x'])).toBe(true);
    });
    it('por defecto, un evento (clase_extra) cierra su venta cuando EMPIEZA: desde el 21-nov 00:00 de Bogotá', () => {
        expect(ventaCerradaDeItem(base, new Date('2026-11-21T04:59:59Z').getTime(), '')).toBe(false); // 20-nov 23:59:59 -05
        expect(ventaCerradaDeItem(base, new Date('2026-11-21T05:00:00Z').getTime(), '')).toBe(true);  // 21-nov 00:00 -05
        expect(ventaCerradaDeItem(base, new Date('2026-11-22T12:00:00Z').getTime(), '')).toBe(true);
    });
    it('el vacacional, el torneo y un ítem sin fecha de inicio NO entran en la regla por fecha', () => {
        const despues = new Date('2026-12-05T12:00:00Z').getTime();
        expect(ventaCerradaDeItem({ id: 'v', kind: 'vacacional', starts_at: '2026-12-01T05:00:00Z' }, despues, '')).toBe(false);
        expect(ventaCerradaDeItem({ id: 't', kind: 'torneo', starts_at: '2026-12-01T05:00:00Z' }, despues, '')).toBe(false);
        expect(ventaCerradaDeItem({ id: 'c', kind: 'clase_extra', starts_at: null }, despues, '')).toBe(false);
        expect(ventaCerradaDeItem(null, despues, '')).toBe(false);
    });
    it('el mensaje fijo de la clínica es exactamente el del dueño', () => {
        expect(textoVentaCerrada(CLINICA as any)).toBe(FIJO);
        expect(textoVentaCerrada({ name: 'Taller de saque' })).toContain('*Taller de saque* ya cerraron');
    });
});

describe('serviciosDeAnuncio: solo las superficies de VENTA filtran', () => {
    it('con ventaAbierta no trae la clínica cerrada; sin la opción (comprobantes, saldos, cola) la trae', async () => {
        const abiertos = await serviciosDeAnuncio(INTEG.school_id, Date.now(), { ventaAbierta: true });
        expect(abiertos.map((i) => i.id)).toEqual([VACACIONAL.id]);
        const todos = await serviciosDeAnuncio(INTEG.school_id);
        expect(todos.map((i) => i.id).sort()).toEqual([ID_CLINICA, VACACIONAL.id].sort());
    });
    it('la regla por fecha: antes del 21-nov se vende, desde el 21-nov 00:00 -05 ya no (sin variable)', async () => {
        vi.stubEnv('WA_VENTAS_CERRADAS_ITEMS', '');
        const antes = await serviciosDeAnuncio(INTEG.school_id, new Date('2026-11-21T04:59:00Z').getTime(), { ventaAbierta: true });
        expect(antes.map((i) => i.id)).toContain(ID_CLINICA);
        const despues = await serviciosDeAnuncio(INTEG.school_id, new Date('2026-11-21T05:00:00Z').getTime(), { ventaAbierta: true });
        expect(despues.map((i) => i.id)).not.toContain(ID_CLINICA);
    });
});

describe('servicioCerradoQueSeConsulta (pura)', () => {
    const items = [CLINICA, VACACIONAL] as any[];
    it('nombra la clínica, o una palabra suya, o está en su venta: ese servicio; nombra el vacacional: ninguno', () => {
        const q = (textos: string[], mensajes: any[] = []) => servicioCerradoQueSeConsulta({ items, textos, mensajes, cerradosPorEnv: ID_CLINICA })?.id ?? null;
        expect(q(['info de la clínica'])).toBe(ID_CLINICA);
        expect(q(['quiero inscribirme a lo de armadores'])).toBe(ID_CLINICA);
        expect(q(['Hola'], [sal(5, 'ficha', { payload: { [MARCA_VENTA]: ID_CLINICA } })])).toBe(ID_CLINICA);
        expect(q(['info del vacacional'], [sal(5, 'ficha', { payload: { [MARCA_VENTA]: ID_CLINICA } })])).toBeNull();
        expect(q(['Hola'])).toBeNull();
        expect(q(['quiero la clase de prueba y la clínica'])).toBeNull();
    });
});

describe('el chat: quien es NUEVO y pregunta por la clínica', () => {
    it('recibe el mensaje fijo UNA vez, pasa a la escuela, y nunca cotiza ni abre el embudo ni la clase de prueba', async () => {
        const a = await turno('Hola, info de la clínica de armadores por favor');
        expect(a.resultado).toBe('venta_cerrada');
        expect(a.salidas[0].texto).toBe(FIJO);
        expect(a.salidas[0].payload).toMatchObject({ step: 'venta_cerrada', venta_cerrada: ID_CLINICA });
        expect(a.salidas.some((s) => s.texto.includes('se abre en el buzón'))).toBe(true);
        for (const s of a.salidas) {
            expect(s.texto.replace(FIJO, '')).not.toMatch(PROHIBIDO);
            expect(String(s.step ?? '')).not.toMatch(/^embudo_|desconocido_tema_escolar/);
        }
        // El mensaje fijo quedó en la conversación: lo que siga NO lo repite ni abre nada del club.
        h.state.filas.unshift(sal(0, FIJO, { payload: { step: 'venta_cerrada', venta_cerrada: ID_CLINICA } }));
        const b = await turno('¿Y cuánto cuesta?');
        expect(b.resultado).toBe('venta_cerrada');
        expect(b.salidas.filter((s) => s.texto === FIJO)).toHaveLength(0);
        for (const s of b.salidas) expect(s.texto).not.toMatch(PROHIBIDO);
        const c = await turno('quiero inscribirme a la clínica');
        expect(c.salidas.filter((s) => s.texto === FIJO)).toHaveLength(0);
        for (const s of c.salidas) expect(s.texto).not.toMatch(PROHIBIDO);
    });

    it('un «Hola» dentro de la venta de la clínica (ficha enviada antes) tampoco recibe cotización ni clase de prueba', async () => {
        h.state.filas = [sal(60, 'ficha de la clínica', { payload: { step: 'anuncio_servicio', [MARCA_VENTA]: ID_CLINICA } })];
        const r = await turno('Hola');
        expect(r.resultado).toBe('venta_cerrada');
        expect(r.salidas[0].texto).toBe(FIJO);
    });

    it('el botón «Separar mi cupo» de la clínica (vs:) tocado por quien no abonó: el fijo, no el pago', async () => {
        const r = await turno('Separar mi cupo', `vs:${ID_CLINICA}:separar`);
        expect(r.resultado).toBe('venta_cerrada');
        expect(r.salidas[0].texto).toBe(FIJO);
        for (const s of r.salidas) expect(s.texto.replace(FIJO, '')).not.toMatch(PROHIBIDO);
    });

    it('la regla por FECHA también cierra en el chat (sin variable): clínica que empezó ayer', async () => {
        vi.stubEnv('WA_VENTAS_CERRADAS_ITEMS', '');
        h.state.items = [{ ...CLINICA, starts_at: '2026-11-01T05:00:00Z' }, VACACIONAL];
        const r = await turno('info de la clínica');
        expect(r.resultado).toBe('venta_cerrada');
        expect(r.salidas[0].texto).toBe(FIJO);
    });
});

describe('el chat: quien YA abonó sigue con su saldo y sus comprobantes', () => {
    beforeEach(() => {
        h.state.lead = { id: 'lead-1', full_name: 'Mateo Inventado', status: 'new', source_detail: { servicio_interes: { id: ID_CLINICA } }, birth_date: null, guardian_name: null, respuestas: null };
        h.state.pagos = [{
            id: 'pay-1', amount: 300000, amount_paid: 150000, status: 'pending', ocr_amount: 150000,
            concept: 'Clínica de armadores y atacantes - Mateo Inventado', child_id: null,
        }];
    });

    it('pregunta su saldo: NO recibe el mensaje fijo y la venta sigue con su cobro (saldo $150.000)', async () => {
        const r = await turno('¿Cuánto me falta por pagar de la clínica?');
        expect(r.resultado).not.toBe('venta_cerrada');
        expect(r.salidas.some((s) => s.texto === FIJO)).toBe(false);
        expect(r.salidas.map((s) => s.texto).join('\n')).toContain('$150.000');
        for (const s of r.salidas) expect(s.texto).not.toMatch(/clase de prueba|\$15\.000|elige la sede/i);
    });

    it('«Ya pagué» (botón de la venta) tampoco recibe el fijo', async () => {
        const r = await turno('Ya pagué', `vs:${ID_CLINICA}:ya_pague`);
        expect(r.resultado).not.toBe('venta_cerrada');
        expect(r.salidas.some((s) => s.texto === FIJO)).toBe(false);
    });
});

describe('el vacacional y lo demás siguen vendiéndose igual', () => {
    it('«info del vacacional» no recibe el mensaje fijo de la clínica', async () => {
        const r = await turno('Hola, info del vacacional de verano');
        expect(r.resultado).not.toBe('venta_cerrada');
        expect(r.salidas.some((s) => s.texto === FIJO)).toBe(false);
    });
    it('quien pidió la clínica y luego pregunta por el vacacional: el vacacional se atiende (no el fijo)', async () => {
        h.state.filas = [
            sal(30, FIJO, { payload: { step: 'venta_cerrada', venta_cerrada: ID_CLINICA } }),
            ent(31, 'info de la clínica'),
        ];
        const r = await turno('¿y el vacacional de verano qué incluye?');
        expect(r.resultado).not.toBe('venta_cerrada');
    });
});

describe('seguimiento automático de ~20 h', () => {
    const lead = { id: 'l1', schoolId: INTEG.school_id, conversationId: 'conv-1', sourceDetail: { servicio_interes: { id: ID_CLINICA } } } as any;
    const conv = { id: 'conv-1', integrationId: 'int-1', contactWaId: TEL, lastInboundAt: hace(1300) } as any;
    const recientes = [sal(1300, 'ficha', { payload: { [MARCA_VENTA]: ID_CLINICA, step: 'venta_servicio_pago' } })] as any[];

    it('con la venta cerrada NO sale «¿Pudiste hacer el pago…?» (texto null = se omite, sin caer al modelo)', async () => {
        const s = await seguimientoDeVentaDelLead(lead, conv, recientes, new Date());
        expect(s).toEqual({ itemId: ID_CLINICA, texto: null });
    });
    it('con la venta abierta sí sale (el vacacional sigue con su seguimiento)', async () => {
        const lv = { ...lead, sourceDetail: { servicio_interes: { id: VACACIONAL.id } } };
        const rv = [sal(1300, 'ficha', { payload: { [MARCA_VENTA]: VACACIONAL.id, step: 'venta_servicio_pago' } })] as any[];
        const s = await seguimientoDeVentaDelLead(lv, conv, rv, new Date());
        expect(s?.itemId).toBe(VACACIONAL.id);
        expect(s?.texto).toBeTruthy();
    });
});
