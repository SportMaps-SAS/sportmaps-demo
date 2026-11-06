/**
 * Monster 2026-11-05 — cuatro fallos del bot encendido en producción:
 *  1. «Hola Pipe» / «Hello Pipe, ¿podemos compartir la app…?» recibían el aviso de registro.
 *  2. Disputa de pago («ya envié el comprobante», «me llegó un correo donde dice que debo»)
 *     contestada con los datos de Nequi.
 *  3. «este número?» tras los datos de pago reiniciaba la identificación.
 *  4. «el campamento del 21 de nov… hasta qué edades aplica» no se contestaba (era la clínica).
 * Mismo andamiaje que whatsapp-retoma-y-pago-publico.test.ts (modo asistido: lo que «sale» queda como borrador).
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

import { atenderDesconocido } from './whatsapp-bot.service';
import { esDisputaDePago, seguimientoDeDatosDePago, textoConfirmaDatosDePago } from './whatsapp-pago-publico';
import { llamaAPersonaSinPedir } from './whatsapp-desconocido-reglas';
import { vocativosDelEquipo } from './whatsapp-reglas-turno';
import { fechasDelTexto, servicioCubreFecha, servicioEmpiezaOTerminaEn, inferirServicio, decidirDestino, fragmentoQueResponde, preguntaDetalleDeEvento, eventosNombrados, type ItemConFicha } from './whatsapp-anuncio-destino';

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
});

// ─── 1. Mensajes personales a alguien de la escuela ─────────────────────────

describe('1. «Hola Pipe»: un conocido, no una familia sin cuenta', () => {
    // «Pipe» no sale del nombre de pila del dueño (Iván): llega por el apodo de la tabla o por «Hola + Nombre».
    const equipo = vocativosDelEquipo(['Iván Felipe Rojas']);
    const hablaDeLaEscuela = (t: string) => /\b(pago|mensualidad|comprobante|horario|precio|clase|entreno)\b/i.test(t);

    it('el apodo «pipe» sale del segundo nombre de pila', () => {
        expect(equipo.has('pipe')).toBe(true);
        expect(equipo.has('ivan')).toBe(true);
        // un apellido no es un vocativo
        expect(vocativosDelEquipo(['Ana Gómez Santos']).has('gomez')).toBe(false);
    });

    it.each([
        'Hello Pipe!! Cómo vas? Disculpame ayer no recuerdo si podemos compartir la aplicación con los acudientes o no',
        'Hola Pipe, como vas ??',
        'Hola Sebas, cómo estás',
        'Buenas tardes profe Iván, cómo le va',
    ])('«%s» se lee como charla personal (silencio)', (t) => {
        expect(llamaAPersonaSinPedir(t, equipo, hablaDeLaEscuela)).toBe(true);
    });

    it.each([
        'Hola Pipe, ¿cuánto vale la mensualidad?',
        'Hola Pipe, te envío el comprobante del pago',
        'Hola, cuál es el horario del entreno',
    ])('«%s» trae una petición clara: sigue su camino', (t) => {
        expect(llamaAPersonaSinPedir(t, equipo, hablaDeLaEscuela)).toBe(false);
    });
});

// ─── 2. Disputa de pago ─────────────────────────────────────────────────────

describe('2. Disputa de pago: a la escuela, sin datos de pago', () => {
    it.each([
        'Una pregunta, es que iba a hacer el pago de la mensualidad y lo del torneo, pero me fijé y llegó un correo de un portal de pagos donde dice que yo debo la mensualidad',
        'Estaba revisando y yo envié el mes pasado el comprobante',
        'ya envié el comprobante',
        'Ya pagué la mensualidad pero me sigue llegando el cobro',
        'dice que debo pero ya pagué',
        'No entiendo por qué me cobran otra vez',
        'Buenas tardes quisiera saber si aplicó al descuento de pronto pago ya que falte el día de halloween y además para saber más sobre la clínica de armadores',
        'el mes pasado habíamos hecho el pago de la pensión de 145 y nos habían quedado 20 mil pesos a favor, ¿cuánto nos toca pagar entonces en noviembre?',
    ])('«%s» es una disputa', (t) => {
        expect(esDisputaDePago(t)).toBe(true);
    });

    it.each([
        '¿Cómo pago la mensualidad?',
        'me indicas a donde consigno por favor',
        'A qué número te consigno?',
        'Voy a pagar la mensualidad mañana',
        'Cuándo debo pagar el torneo',
        '¿Hay descuento por pronto pago?',
        'Info de la clínica de armadores',
    ])('«%s» NO es una disputa', (t) => {
        expect(esDisputaDePago(t)).toBe(false);
    });

    it('el mensaje de captura: un acuse corto, sin datos de pago, y la conversación va al buzón', async () => {
        base();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL,
            'Una pregunta, es que iba a hacer el pago de la mensualidad y lo del torneo, pero me fijé y llegó un correo de un portal de pagos donde dice que yo debo la mensualidad');
        expect(r).toBe('disputa_de_pago');
        const bs = borradores();
        expect(bs).toHaveLength(1);
        expect(bs[0].tool_context).toMatchObject({ step: 'disputa_de_pago' });
        expect(bs[0].proposed_text).toContain('Le paso tu caso a la escuela');
        expect(bs[0].proposed_text).not.toMatch(/Bre-B|@dynasty|checkout|Puedes pagar así/);
        expect(bs.some((b) => b.tool_context?.step === 'medios_de_pago_publicos')).toBe(false);
    });

    it('el segundo mensaje («yo envié el mes pasado el comprobante») no repite el acuse', async () => {
        base({ pasos: ['disputa_de_pago'] });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Estaba revisando y yo envié el mes pasado el comprobante');
        expect(r).toBe('disputa_de_pago');
        expect(borradores()).toHaveLength(0);
    });
});

// ─── 3. Seguimiento corto tras los datos de pago ────────────────────────────

describe('3. «este número?» tras los datos de pago: se confirma, no se reinicia', () => {
    it.each([
        ['este numero?', 'numero'], ['Este número?', 'numero'], ['ese es el número?', 'numero'], ['a ese?', 'numero'],
        ['y a nombre de quién?', 'titular'], ['a nombre de quien está?', 'titular'],
    ])('«%s» → %s', (t, esperado) => {
        expect(seguimientoDeDatosDePago(t)).toBe(esperado);
    });

    it.each(['me indicas a donde consigno por favor', 'quiero inscribir a mi hija', 'ese mismo día no puedo ir a clase hoy'])(
        '«%s» no es un seguimiento', (t) => {
            expect(seguimientoDeDatosDePago(t)).toBeNull();
        });

    it('la confirmación repite número y titular en una línea', () => {
        const t = textoConfirmaDatosDePago([{ tipo: 'Nequi', titular: 'Monster Volley', numero: '3001234567' }], 'numero')!;
        expect(t).toContain('3001234567');
        expect(t).toContain('Monster Volley');
        expect(t).not.toMatch(/Créala|registr/i);
        expect(textoConfirmaDatosDePago([], 'numero')).toBeNull();
    });

    it('tras los datos de pago, «este numero?» se contesta con el dato y NO con el enlace de registro', async () => {
        base({
            filas: [
                { wa_message_id: 'in-1', direction: 'inbound', text_body: 'me indicas a donde consigno por favor', ai_generated: false, created_at: hace(3) },
                { wa_message_id: 'out-1', direction: 'outbound', text_body: 'Puedes pagar así…', payload: { step: 'medios_de_pago_publicos' },
                    ai_generated: true, created_at: hace(2) },
                { wa_message_id: 'in-2', direction: 'inbound', text_body: 'este numero?', ai_generated: false, created_at: hace(0) },
            ],
        });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'este numero?');
        expect(r).toBe('medios_de_pago');
        const [b] = borradores();
        expect(b.tool_context).toMatchObject({ step: 'medios_de_pago_confirma' });
        expect(b.proposed_text).toContain('@dynastyejemplo');
        expect(b.proposed_text).not.toMatch(/Créala|registrad/i);
    });

    it('sin datos de pago recientes, «este numero?» no se toma por un seguimiento', async () => {
        base();
        await atenderDesconocido(INTEGRATION, CONV, TEL, 'este numero?');
        expect(borradores().some((b) => b.tool_context?.step === 'medios_de_pago_confirma')).toBe(false);
    });
});

// ─── 4. Preguntas de detalle de un evento ───────────────────────────────────

describe('4. «el campamento del 21 de nov… hasta qué edades aplica»', () => {
    const clinica: ItemConFicha = {
        id: 'it-clinica', name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 150000, active: true, event_id: null,
        starts_at: '2026-11-21T13:00:00Z', ends_at: '2026-11-22T22:00:00Z',
        description: 'Clínica de armadores y atacantes. Sábado 21 y domingo 22 de noviembre. Hombres y mujeres de 14 años en adelante. '
            + 'No va dirigida a principiantes.',
    } as any;
    const vacacional: ItemConFicha = {
        id: 'it-vac', name: 'Vacacional de diciembre', kind: 'vacacional', price: 300000, active: true, event_id: null,
        starts_at: '2026-12-14T13:00:00Z', ends_at: '2026-12-18T22:00:00Z', description: 'Vacacional.',
    } as any;
    const PREGUNTA = 'por favor me confirmas el campamentos del 21 de nov. hasta que edades aplica';

    it('las fechas del texto se leen y caen en los días del servicio (hora de Bogotá)', () => {
        expect(fechasDelTexto(PREGUNTA)).toEqual([{ mes: 11, dia: 21 }]);
        expect(fechasDelTexto('el 21 y 22 de noviembre')).toEqual([{ mes: 11, dia: 21 }, { mes: 11, dia: 22 }]);
        expect(servicioCubreFecha(clinica, [{ mes: 11, dia: 22 }])).toBe(true);
        expect(servicioCubreFecha(clinica, [{ mes: 12, dia: 15 }])).toBe(false);
    });

    it('«campamento» con la fecha de la clínica es la clínica, aunque haya un vacacional activo', () => {
        const inf = inferirServicio([PREGUNTA], [vacacional, clinica]);
        expect(inf).toMatchObject({ tipo: 'uno', item: { id: 'it-clinica' } });
    });

    it('«campamento» sin fecha sigue como antes (el vacacional; la clínica no)', () => {
        expect(inferirServicio(['info del campamento'], [clinica])).toMatchObject({ tipo: 'evento_sin_servicio' });
        expect(inferirServicio(['info del campamento'], [vacacional, clinica])).toMatchObject({ tipo: 'uno', item: { id: 'it-vac' } });
    });

    it('un vacacional largo que solo CONTIENE la fecha no compite con la clínica que empieza ese día', () => {
        const largo = { ...vacacional, starts_at: '2026-11-17T13:00:00Z', ends_at: '2026-12-10T16:00:00Z' } as ItemConFicha;
        expect(inferirServicio([PREGUNTA], [largo, clinica])).toMatchObject({ tipo: 'uno', item: { id: 'it-clinica' } });
        expect(servicioEmpiezaOTerminaEn(largo, [{ mes: 11, dia: 21 }])).toBe(false);
        expect(servicioEmpiezaOTerminaEn(clinica, [{ mes: 11, dia: 21 }])).toBe(true);
    });

    it('el pedazo de la edad sale aunque el texto de venta hable de «nivel» y «experiencia» por todos lados', () => {
        const largo = 'Quieres llevar tu juego al siguiente nivel?\nEste 21 y 22 de noviembre, dos jornadas de alto nivel.\n'
            + 'Compartirá su experiencia con los deportistas.\n*Hombres y mujeres de 14 años en adelante*\n'
            + 'Si tienes menos de esta debes contar con experiencia ya que la clínica no va dirigida a principiantes';
        const p = fragmentoQueResponde(largo, PREGUNTA)!;
        expect(p).toContain('14 años en adelante');
        expect(p).toContain('principiantes');
        expect(p).not.toContain('siguiente nivel');
    });

    it('dos servicios que calzan con la fecha → la lista de varios', () => {
        const otra = { ...clinica, id: 'it-otra', name: 'Clínica de líberos' } as ItemConFicha;
        expect(inferirServicio([PREGUNTA], [clinica, otra])).toMatchObject({ tipo: 'varios' });
    });

    it('una pregunta de edad sobre el evento es una consulta del servicio (sin «quiero» ni «precio»)', () => {
        expect(preguntaDetalleDeEvento(PREGUNTA)).toBe(true);
        expect(eventosNombrados([PREGUNTA])).toContain('campamento');
        expect(decidirDestino({ referral: null, mapeo: null, texto: PREGUNTA, items: [vacacional, clinica] }))
            .toMatchObject({ destino: 'servicio', item: { id: 'it-clinica' } });
        // un comprobante no es una pregunta de detalle
        expect(preguntaDetalleDeEvento('ya envié el comprobante de la clínica')).toBe(false);
    });

    it('el pedazo del texto de la escuela que responde la edad', () => {
        const p = fragmentoQueResponde(clinica.description, PREGUNTA)!;
        expect(p).toContain('14 años en adelante');
        expect(p).toContain('principiantes');
        expect(fragmentoQueResponde('Sin datos.', PREGUNTA)).toBeNull();
    });
});
