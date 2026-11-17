/**
 * Auditoría de conversaciones reales de producción (8–16 nov 2026): el cableado en el bot.
 * Mismo andamiaje que whatsapp-prospecto-seguimiento.test.ts (Supabase con builder encadenable,
 * modo asistido: lo que el bot diría queda como borrador). Ni base ni Meta.
 *
 *  6. `deliver` no repite su último mensaje en menos de 2 minutos, sea del paso que sea.
 *  7. Familia sin cuenta: «crea tu cuenta» solo cuando el mensaje trata de la cuenta.
 *  8. El interesado que pregunta después de la bienvenida recibe respuesta.
 *  9. «ACTIVAR» se atiende antes que cualquier flujo, aunque la escuela esté escribiendo.
 * 10. El menú de otro negocio no se responde ni se deriva.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        updates: { table: string; row: any }[];
        rpcs: { fn: string; args: any }[];
    } = { resolve: () => ({ data: null, error: null }), rpc: () => ({ data: null, error: null }), inserts: [], updates: [], rpcs: [] };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { state.updates.push({ table, row }); ops.push(['update', [row]]); return b; };
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
            rpc: (fn: string, args: any) => { state.rpcs.push({ fn, args }); return Promise.resolve(state.rpc(fn, args)); },
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        levantarBajaDePromos: vi.fn(async () => true),
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
vi.mock('./whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '',
    levantarBajaDePromos: h.levantarBajaDePromos, registrarBajaDePromos: vi.fn(async () => true),
    leerOptinsDeContactos: vi.fn(async () => []), sinPromociones: vi.fn(() => false),
}));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'Voy a pasar tu caso a una persona de la escuela. En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Escuela', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
    etiquetaDeContacto: vi.fn(() => 'Contacto'),
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));
vi.mock('./whatsapp-prospecto-lead.service', () => ({ registrarLeadDeProspecto: vi.fn(async () => {}) }));
vi.mock('./whatsapp-invitacion-vigente.service', () => ({
    invitacionPendienteVigente: vi.fn(async () => ({ invitacion: null, atletaInactivo: false })),
}));

import {
    runBotTurn, atenderDesconocido, deliver, repiteSuUltimoMensaje, _olvidarReservasDePaso, _limpiarCacheVocativos,
} from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573153601042';
const hace = (seg: number) => new Date(Date.now() - seg * 1000).toISOString();

const SLOTS = [
    { id: 's-sen', label: 'SENIORS', slot_date: '2030-01-14', start_time: '19:00:00', end_time: '21:00:00', location: 'Coliseo', max_capacity: 5, reserved_count: 0, team_id: null },
    { id: 's-inf', label: 'INFANTIL', slot_date: '2030-01-15', start_time: '15:00:00', end_time: '17:00:00', location: 'Coliseo', max_capacity: 5, reserved_count: 0, team_id: null },
];

type Fila = { wa_message_id: string | null; direction: 'inbound' | 'outbound'; type?: string; text_body: string;
    payload?: any; ai_generated: boolean; created_at: string };

function base(op: {
    filas?: Fila[]; pasos?: string[]; conv?: any; optin?: any; optinSinColumna?: boolean; identificacion?: string;
    equipo?: string[]; ultimoSaliente?: any[] | null;
} = {}) {
    const filas = op.filas ?? [];
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
            const limite = ops.find(([m]) => m === 'limit')?.[1]?.[0];
            if (direccion === 'outbound' && esUno) {
                const ultimo = filas.filter((f) => f.direction === 'outbound').sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
                return { data: ultimo ? { payload: ultimo.payload, created_at: ultimo.created_at, text_body: ultimo.text_body } : null, error: null };
            }
            // La lectura del ÚLTIMO saliente del bot (regla de los 2 minutos): `limit(1)` sin `maybeSingle`.
            if (direccion === 'outbound' && limite === 1) return { data: op.ultimoSaliente ?? [], error: null };
            if (direccion === 'inbound') return { data: filas.filter((f) => f.direction === 'inbound'), error: null };
            if (!direccion) return { data: filas, error: null };
            return { data: null, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { data: null, count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: null, identified: false, status: 'open', contact_name: 'Contacto', tomada_por: null, tomada_hasta: null, ...(op.conv ?? {}) }, error: null };
        }
        if (table === 'whatsapp_settings') {
            return { data: { ai_enabled: true, mode: 'assisted', responder_desconocidos: false, responder_prospectos: true }, error: null };
        }
        if (table === 'whatsapp_optins') {
            const columnas = String(ops.find(([m]) => m === 'select')?.[1]?.[0] ?? '');
            if (op.optinSinColumna && columnas.includes('promos_out_at')) {
                return { data: null, error: { code: '42703', message: 'column whatsapp_optins.promos_out_at does not exist' } };
            }
            return { data: op.optin ?? null, error: null };
        }
        if (table === 'school_trial_slots') return { data: SLOTS, error: null };
        if (table === 'school_join_qr_codes') return { data: [{ slug: 'escuela-inscripcion', target_type: 'open', signup_count: 10 }], error: null };
        if (table === 'schools') return { data: { name: 'Escuela Demo', owner_id: 'owner-1', slug: 'escuela-demo', address: null }, error: null };
        if (table === 'profiles') return { data: (op.equipo ?? []).map((full_name) => ({ full_name })), error: null };
        if (table === 'teams' || table === 'school_branches' || table === 'school_members') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') return { data: { estado: op.identificacion ?? 'desconocido' }, error: null };
        return { data: null, error: null };
    };
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true, tomada: false });
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts').map((i) => i.row);
const pasosDe = () => borradores().map((b) => String(b.tool_context?.step ?? ''));

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.rpcs = [];
    _olvidarReservasDePaso();
    _limpiarCacheVocativos();
    // Sin modo discreto: es el camino en el que el bot sí le habla a la familia sin cuenta.
    process.env.WHATSAPP_MODO_DISCRETO = 'false';
});

describe('6. deliver no repite su último mensaje en menos de 2 minutos', () => {
    const LISTA = 'Elige uno de los horarios de la lista 👇\n\nEstos son los próximos horarios 👇';
    const botones = [{ id: 'sm_em_f:s1', title: 'Sáb 31 oct · 8:00' }, { id: 'sm_em_f:s2', title: 'Dom 1 nov · 8:00' }];
    const contexto = { step: 'embudo_horarios', flujo: 'embudo', paso_embudo: 'elegir_franja', datos_embudo: { lista: ['s1', 's2'] } };

    it('«Elige uno de los horarios de la lista 👇» (paso de un flujo, exento del freno de 30 min) no sale otra vez a los 30 s', async () => {
        base({ ultimoSaliente: [{ text_body: LISTA, created_at: hace(30), payload: { ...contexto, botones } }] });
        await deliver(INTEGRATION, CONV, TEL, LISTA, contexto, { botones });
        expect(borradores()).toHaveLength(0);
    });

    it('la primera vez sí sale, y también si lo último que dijo el bot fue otra cosa', async () => {
        base({ ultimoSaliente: [] });
        await deliver(INTEGRATION, CONV, TEL, LISTA, contexto, { botones });
        expect(borradores()).toHaveLength(1);
        h.state.inserts = [];
        base({ ultimoSaliente: [{ text_body: '¡Listo! ✨ Por su año (2011) a Mariana le corresponde Infantil Femenino.', created_at: hace(30), payload: {} }] });
        await deliver(INTEGRATION, CONV, TEL, LISTA, contexto, { botones });
        expect(borradores()).toHaveLength(1);
    });

    it('«Ver más horarios» (mismo texto, otras opciones) sí sale', async () => {
        base({ ultimoSaliente: [{ text_body: LISTA, created_at: hace(30), payload: { ...contexto, botones: [{ id: 'sm_em_f:s8' }, { id: 'sm_em_f:s9' }] } }] });
        await deliver(INTEGRATION, CONV, TEL, LISTA, contexto, { botones });
        expect(borradores()).toHaveLength(1);
    });

    it('los pasos repetibles de la venta y la escalación tampoco se repiten', async () => {
        const T = 'Eso te lo confirma la escuela por aquí 🙌 Ya le pasé tu pregunta.';
        for (const step of ['venta_servicio_a_la_escuela', 'venta_servicio_pago', 'escalated']) {
            h.state.inserts = [];
            base({ ultimoSaliente: [{ text_body: T, created_at: hace(20), payload: { step } }] });
            await deliver(INTEGRATION, CONV, TEL, T, { step, repetible: true });
            expect(borradores(), step).toHaveLength(0);
        }
    });

    it('el anterior salió con la presentación delante: sigue siendo el mismo mensaje', async () => {
        base({ ultimoSaliente: [{ text_body: `Hola 👋 Soy el asistente virtual de Escuela Demo.\n\n${LISTA}`, created_at: hace(30), payload: { ...contexto, botones } }] });
        expect(await repiteSuUltimoMensaje(CONV, LISTA, botones.map((b) => b.id), 'embudo_horarios')).toBe(true);
    });

    it('ante un error de lectura se habla (callar es peor que repetir)', async () => {
        base({});
        h.state.resolve = () => { throw new Error('sin base'); };
        expect(await repiteSuUltimoMensaje(CONV, LISTA, [], 'embudo_horarios')).toBe(false);
    });
});

describe('7. familia sin cuenta: el aviso de la cuenta solo cuando el mensaje trata de la cuenta', () => {
    const turno = async (texto: string, op: Parameters<typeof base>[0] = {}) => {
        const filas: Fila[] = [{ wa_message_id: 'wamid.1', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(1) }];
        // La conversación llega cerrada: así se ve si el turno la deja abierta en el buzón.
        base({ filas, identificacion: 'debe_registrarse', conv: { status: 'closed' }, ...op });
        await runBotTurn(INTEGRATION, CONV, TEL, texto, 'wamid.1');
    };

    it('«A qué hora es el entrenamiento?»: no recibe «todavía no tienes tu cuenta creada»; la pregunta va a la escuela', async () => {
        await turno('A qué hora es el entrenamiento?');
        expect(pasosDe()).not.toContain('debe_registrarse');
        expect(borradores().map((b) => b.proposed_text).join('\n')).not.toMatch(/cuenta creada/);
        expect(pasosDe()).toEqual(['pregunta_a_la_escuela']);
        expect(borradores()[0].proposed_text).toBe('Ya le pasé tu pregunta a la escuela y te responde por aquí 🙌');
        expect(h.state.updates.some((u) => u.table === 'whatsapp_conversations' && u.row.status === 'open')).toBe(true);
    });

    it('«Las fechas ya están confirmadas o hay alguna opción de que las cambien ??»: tampoco', async () => {
        await turno('Las fechas ya están confirmadas o hay alguna opción de que las cambien ??');
        expect(pasosDe()).not.toContain('debe_registrarse');
        expect(pasosDe()).toEqual(['pregunta_a_la_escuela']);
    });

    it('«envío soporte de pago de este mes»: el bot calla (el comprobante lo contesta la cola) y queda en el buzón', async () => {
        await turno('envío soporte de pago de este mes');
        expect(borradores()).toHaveLength(0);
        expect(h.state.updates.some((u) => u.table === 'whatsapp_conversations' && u.row.status === 'open')).toBe(true);
    });

    it('«…necesito a Felipe por favor»: va a una persona', async () => {
        await turno('Buenas tardes necesito a Felipe por favor', { equipo: ['Felipe Rojas'] });
        expect(pasosDe()).toEqual(['escalated']);
        expect(borradores()[0].proposed_text).not.toMatch(/cuenta creada/);
    });

    it('lo que sí trata de la cuenta, y un saludo suelto, siguen recibiendo el aviso', async () => {
        await turno('No puedo entrar a la app');
        expect(pasosDe()).toEqual(['debe_registrarse']);
        expect(borradores()[0].proposed_text).toMatch(/todavía no tienes tu cuenta creada/);
        h.state.inserts = [];
        _olvidarReservasDePaso();
        await turno('Hola buenas tardes');
        expect(pasosDe()).toEqual(['debe_registrarse']);
    });
});

describe('8. el interesado que pregunta después de la bienvenida', () => {
    const conBienvenida = (texto: string, minutos = 60): Fila[] => [
        { wa_message_id: 'wamid.0', direction: 'inbound', text_body: 'Hola', ai_generated: false, created_at: hace(minutos * 60 + 30) },
        { wa_message_id: 'wamid.b', direction: 'outbound', text_body: '¡Hola! 👋 Gracias por escribirnos.', payload: { step: 'bienvenida_desconocido' }, ai_generated: true, created_at: hace(minutos * 60) },
        { wa_message_id: 'wamid.1', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(1) },
    ];

    it('«Dame información» y «Horarios, costos» tras la bienvenida del bot: reciben respuesta (antes, silencio)', async () => {
        for (const texto of ['Dame información', 'Horarios, costos', 'Quiero saber si tienes cursos de vacaciones niña de 10 años por favor']) {
            h.state.inserts = [];
            _olvidarReservasDePaso();
            base({ filas: conBienvenida(texto), pasos: ['bienvenida_desconocido'] });
            const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
            expect(r, texto).not.toBe('silencio');
            expect(r, texto).not.toBe('frenado');
            expect(borradores().length, texto).toBeGreaterThanOrEqual(1);
            expect(borradores()[0].tool_context.step, texto).toBe('desconocido_tema_escolar');
        }
    });

    it('sin la bienvenida del bot, «Dame información» de un número cualquiera sigue en silencio (puede ser un contacto personal)', async () => {
        const texto = 'Dame información';
        base({ filas: [{ wa_message_id: 'wamid.1', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(1) }], pasos: [] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, texto)).toBe('silencio');
        expect(borradores()).toHaveLength(0);
    });

    it('«Hola buenas tardes hoy tienen juego?» con la primera respuesta y el acuse ya gastados: acuse corto, nunca silencio', async () => {
        const texto = 'Hola buenas tardes hoy tienen juego?';
        const filas: Fila[] = [
            { wa_message_id: 'wamid.0', direction: 'inbound', text_body: 'Hola quiero averiguar', ai_generated: false, created_at: hace(80_000) },
            { wa_message_id: 'wamid.b', direction: 'outbound', text_body: 'Hola 👋 Soy el asistente…', payload: { step: 'desconocido_tema_escolar' }, ai_generated: true, created_at: hace(79_000) },
            { wa_message_id: 'wamid.1', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(1) },
        ];
        base({ filas, pasos: ['desconocido_tema_escolar', 'prospecto_seguimiento'] });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
        expect(r).toBe('prospecto_seguimiento');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].proposed_text).toBe('Anotado 🙌 Esa pregunta también se la pasé a la escuela y te responde por aquí.');
    });
});

describe('9. «ACTIVAR» antes que cualquier flujo', () => {
    const escuelaEscribiendo: Fila[] = [
        { wa_message_id: null, direction: 'outbound', type: 'text', text_body: 'Hola, ya te confirmo', payload: {}, ai_generated: false, created_at: hace(300) },
        { wa_message_id: 'wamid.1', direction: 'inbound', text_body: 'ACTIVAR', ai_generated: false, created_at: hace(1) },
    ];

    it('familia que se dio de baja y la escuela escribió hace 5 minutos: se reactiva y se le confirma', async () => {
        process.env.WHATSAPP_MODO_DISCRETO = 'true';
        base({ filas: escuelaEscribiendo, conv: { parent_id: 'parent-1', identified: true }, optin: { opted_in_at: null, opted_out_at: hace(86_400), promos_out_at: null } });
        await runBotTurn(INTEGRATION, CONV, TEL, 'ACTIVAR', 'wamid.1');
        const optin = h.state.rpcs.find((r) => r.fn === 'wa_register_optin');
        expect(optin?.args).toMatchObject({ p_contact_wa_id: TEL, p_opt_out: false, p_source_ref: 'wamid.1', p_parent_id: 'parent-1' });
        expect(pasosDe()).toEqual(['opt_in_reactivado']);
        expect(borradores()[0].proposed_text).toMatch(/reactivé los mensajes de la escuela/);
        // No se identificó por teléfono ni pasó por ningún otro flujo.
        expect(h.state.rpcs.map((r) => r.fn)).not.toContain('wa_identify_by_phone');
    });

    it('«*Activar*» con formato también; y con la base sin `promos_out_at` (42703) la baja NO se pierde', async () => {
        base({ filas: escuelaEscribiendo, conv: { parent_id: null, identified: false }, optin: { opted_in_at: null, opted_out_at: hace(86_400) }, optinSinColumna: true });
        await runBotTurn(INTEGRATION, CONV, TEL, '*Activar*', 'wamid.1');
        expect(h.state.rpcs.some((r) => r.fn === 'wa_register_optin')).toBe(true);
        expect(pasosDe()).toEqual(['opt_in_reactivado']);
    });

    it('desconocido que estaba de baja (el camino del webhook), con la base sin la columna nueva: también', async () => {
        base({ filas: escuelaEscribiendo.slice(1), optin: { opted_in_at: null, opted_out_at: hace(86_400) }, optinSinColumna: true });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'ACTIVAR')).toBe('avisos_reactivados');
        expect(pasosDe()).toEqual(['opt_in_reactivado']);
    });

    it('solo tenía la baja de promociones: se levanta y se confirma', async () => {
        base({ filas: escuelaEscribiendo.slice(1), conv: { parent_id: 'parent-1', identified: true }, optin: { opted_in_at: hace(900_000), opted_out_at: null, promos_out_at: hace(86_400) } });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Activar', 'wamid.1');
        expect(h.levantarBajaDePromos).toHaveBeenCalledWith('int-1', TEL);
        expect(pasosDe()).toEqual(['promos_reactivadas']);
    });

    it('quien NO estaba de baja y escribe «activar»: no se registra nada por esta vía (el mensaje sigue su camino)', async () => {
        base({ filas: escuelaEscribiendo.slice(1), optin: null });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'ACTIVAR')).not.toBe('avisos_reactivados');
        expect(h.state.rpcs.some((r) => r.fn === 'wa_register_optin')).toBe(false);
    });
});

describe('10. el menú de otro negocio y el bot en bucle', () => {
    const MENU = 'Bienvenid@ a Plusgami.store 🎮\nSomos tu tienda de videojuegos.\n\nElige una opción:\n1. Cotizar juego\n2. Estado de mi pedido\n3. Hablar con un asesor';

    it('«Bienvenid@ a Plusgami.store… 1. Cotizar juego»: ni respuesta ni buzón', async () => {
        base({ filas: [{ wa_message_id: 'wamid.1', direction: 'inbound', text_body: MENU, ai_generated: false, created_at: hace(1) }] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, MENU)).toBe('externo');
        expect(borradores()).toHaveLength(0);
        expect(h.state.updates).toHaveLength(0);
        // Y en el turno de una familia tampoco.
        base({ filas: [], conv: { parent_id: 'parent-1', identified: true } });
        await runBotTurn(INTEGRATION, CONV, TEL, MENU, 'wamid.1');
        expect(borradores()).toHaveLength(0);
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('el mismo texto largo por tercera vez en 10 minutos: no se contesta', async () => {
        const T = 'Hola, soy el asistente virtual de la tienda. ¿En qué te puedo ayudar hoy?';
        const filas: Fila[] = [240, 120, 1].map((s, i) => (
            { wa_message_id: `wamid.${i}`, direction: 'inbound' as const, text_body: T, ai_generated: false, created_at: hace(s) }));
        base({ filas, pasos: ['bienvenida_desconocido'] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, T)).toBe('externo');
        expect(borradores()).toHaveLength(0);
    });
});

describe('1 y 5. una pregunta a mitad de la reserva: se contesta y el paso se recuerda una vez', () => {
    const enNombre = (texto: string, datos: any = {}): Fila[] => [
        { wa_message_id: 'wamid.0', direction: 'inbound', text_body: 'Hola quiero una clase de cortesía', ai_generated: false, created_at: hace(600) },
        { wa_message_id: 'wamid.b', direction: 'outbound', text_body: 'Elegiste *SENIORS*. ¿Cuál es el *nombre completo* de quien va a tomar la clase?',
            payload: { step: 'cortesia_nombre', flujo: 'clase_cortesia', paso_cortesia: 'nombre', datos_cortesia: { franja: { id: 's-sen' }, lista: ['s-sen', 's-inf'], intentos: 0, ...datos } },
            ai_generated: true, created_at: hace(300) },
        { wa_message_id: 'wamid.1', direction: 'inbound', text_body: texto, ai_generated: false, created_at: hace(1) },
    ];

    it('«Que precios manejas podrías darme más información» en la pregunta del nombre: respuesta + recordatorio, con el flujo abierto', async () => {
        const texto = 'Que precios manejas podrías darme más información';
        base({ filas: enNombre(texto), pasos: ['desconocido_tema_escolar'] });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
        expect(r).toBe('prospecto_precios');
        expect(pasosDe()).toEqual(['prospecto_seguimiento_precios', 'cortesia_recordar_paso']);
        // No se tomó como el nombre: nada de «¿Qué edad tiene Que?» ni de reserva.
        expect(borradores().map((b) => b.proposed_text).join('\n')).not.toMatch(/Qué \*edad\* tiene|Quedó reservada/);
        // La respuesta suelta y el recordatorio llevan el estado del flujo: el nombre que llegue después se toma.
        for (const b of borradores()) expect(b.tool_context).toMatchObject({ flujo: 'clase_cortesia', paso_cortesia: 'nombre' });
        expect(borradores()[1].proposed_text).toBe('Cuando quieras seguimos con tu clase de cortesía 🙌 ¿Cuál es el *nombre completo* de quien va a tomar la clase?');
        expect(borradores()[1].tool_context.datos_cortesia).toMatchObject({ recordado: 'nombre', lista: ['s-sen', 's-inf'] });
    });

    it('la segunda pregunta en el mismo paso se contesta SIN volver a recordar', async () => {
        const texto = 'Y dónde queda la sede';
        base({ filas: enNombre(texto, { recordado: 'nombre' }), pasos: ['desconocido_tema_escolar'] });
        await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
        expect(pasosDe()).not.toContain('cortesia_recordar_paso');
        expect(borradores().length).toBeGreaterThanOrEqual(1);
        expect(borradores()[0].tool_context).toMatchObject({ flujo: 'clase_cortesia', paso_cortesia: 'nombre' });
    });
});
