/**
 * Consentimiento de novedades y promociones para PROSPECTOS (2026-11-15, whatsapp-autoservicio D4),
 * en whatsapp-bot.service: cuándo pregunta, que pregunta una sola vez, y qué registra cada respuesta.
 *
 * Mismo andamiaje que whatsapp-auditoria-2026-10-10-bot.test.ts. `whatsapp-optin.service` va REAL:
 * sus RPC caen en la base de mentira y así se ve exactamente qué se registró. Datos inventados.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        rpcCalls: { fn: string; args: any }[];
        inserts: { table: string; row: any }[];
    } = {
        resolve: () => ({ data: null, error: null }),
        rpc: () => ({ data: null, error: null }),
        rpcCalls: [],
        inserts: [],
    };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not', 'ilike']) {
            b[m] = chain(m);
        }
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, [...ops, ['maybeSingle', []]]));
        b.single = () => Promise.resolve(state.resolve(table, [...ops, ['maybeSingle', []]]));
        b.then = (res: any, rej: any) => Promise.resolve(state.resolve(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string, args: any) => {
                state.rpcCalls.push({ fn, args });
                return Promise.resolve(state.rpc(fn, args));
            },
        },
        botEncendido: vi.fn(),
        debeAtender: vi.fn(),
        sendTextMessage: vi.fn(),
        sendInteractiveButtons: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: h.botEncendido };
});
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: h.sendTextMessage,
    sendInteractiveButtons: h.sendInteractiveButtons,
    sendCtaUrl: vi.fn(),
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: vi.fn() }));

import {
    atenderDesconocido, ofrecerConsentNovedadesTrasTurno, _olvidarConsentNovedades, _olvidarReservasDePaso,
} from './whatsapp-bot.service';
import {
    PASO_CONSENT_NOVEDADES, BOTON_CONSENT_NOVEDADES, textoConsentNovedades, textoRespuestaConsentNovedades,
} from './whatsapp-consentimiento-seguimiento';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const TEL = '573000000001';
const hace = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Escena {
    /** Fila de la conversación (familia = con parent_id). */
    conv: { parent_id: string | null; identified: boolean } | null;
    /** Filas de whatsapp_optins del contacto. */
    optins: any[];
    /** La base todavía no tiene `promos_out_at` (migración 20261115143758 sin aplicar). */
    sinColumnaPromos: boolean;
    /** Ya salió alguna pregunta de consentimiento en la conversación (mensajes). */
    yaPreguntado: boolean;
    /** Lo mismo, pero quedó en borrador (modo asistido). */
    borradorPreguntado: boolean;
    /** Mensajes de las últimas 24 h. */
    recientes: any[];
    /** Pregunta «¿a cuál cobro?» de un comprobante abierta. */
    cobroAbierto: boolean;
}

/** El bot acaba de contestarle la consulta al prospecto. */
const respuestaDelBot = (payload: Record<string, unknown> = { step: 'prospecto_precios' }) => ({
    wa_message_id: 'wamid.resp', direction: 'outbound', type: 'text', text_body: 'Estos son los valores…',
    payload, ai_generated: true, wa_timestamp: hace(2_000), created_at: hace(2_000),
});
const entrante = (texto: string, ms = 10_000) => ({
    wa_message_id: 'wamid.in', direction: 'inbound', type: 'text', text_body: texto,
    payload: null, ai_generated: null, wa_timestamp: hace(ms), created_at: hace(ms),
});

function escena(e: Partial<Escena> = {}): void {
    const s: Escena = {
        conv: { parent_id: null, identified: false }, optins: [], sinColumnaPromos: false, yaPreguntado: false,
        borradorPreguntado: false, recientes: [entrante('cuánto vale la mensualidad?'), respuestaDelBot()], cobroAbierto: false,
        ...e,
    };
    const tiene = (ops: [string, any[]][], op: string, ...args: any[]) =>
        ops.some(([n, a]) => n === op && args.every((x, i) => (typeof x === 'function' ? x(a[i]) : a[i] === x)));
    const esConteo = (ops: [string, any[]][]) => ops.some(([n, a]) => n === 'select' && a[1]?.count === 'exact');
    const cols = (ops: [string, any[]][]) => String(ops.find(([n]) => n === 'select')?.[1]?.[0] ?? '');

    h.state.resolve = (table, ops) => {
        if (table === 'whatsapp_conversations') {
            return { data: s.conv ? { id: CONV, ...s.conv, last_inbound_at: hace(10_000), tomada_hasta: null } : null, error: null };
        }
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'auto', assisted_until: null }, error: null };
        if (table === 'schools') return { data: { name: 'Escuela Ejemplo', owner_id: 'owner-1' }, error: null };
        if (table === 'whatsapp_optins') {
            if (s.sinColumnaPromos && cols(ops).includes('promos_out_at')) {
                return { data: null, error: { code: '42703', message: 'column promos_out_at does not exist' } };
            }
            // Las lecturas de UNA fila (`estaDadoDeBaja`) y las del lote (`leerOptinsDeContactos`).
            return tiene(ops, 'maybeSingle') ? { data: s.optins[0] ?? null, error: null } : { data: s.optins, error: null };
        }
        if (table === 'whatsapp_messages') {
            if (esConteo(ops)) {
                const porPasos = tiene(ops, 'in', 'payload->>step');
                return { data: null, count: porPasos && s.yaPreguntado ? 1 : 0, error: null };
            }
            if (cols(ops) === 'wa_message_id') return { data: { wa_message_id: 'wamid.respuesta-del-prospecto' }, error: null };
            if (cols(ops).startsWith('wa_message_id, direction')) return { data: s.recientes, error: null };
            return { data: [], count: 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') {
            if (esConteo(ops)) {
                return { data: null, count: tiene(ops, 'in', 'tool_context->>step') && s.borradorPreguntado ? 1 : 0, error: null };
            }
            return { data: [], count: 0, error: null };
        }
        if (table === 'whatsapp_inbound_queue') {
            if (tiene(ops, 'eq', 'status', 'waiting_user')) return { data: s.cobroAbierto ? { id: 'q-1' } : null, error: null };
            return { data: [], count: 0, error: null };
        }
        return { data: tiene(ops, 'maybeSingle') ? null : [], count: 0, error: null };
    };
    h.state.rpc = () => ({ data: null, error: null });
}

const enviados = () => [
    ...h.sendTextMessage.mock.calls.map((c: any[]) => ({ texto: c[2] as string, botones: null as any })),
    ...h.sendInteractiveButtons.mock.calls.map((c: any[]) => ({ texto: c[2] as string, botones: c[3] })),
];
const salientes = () => h.state.rpcCalls.filter((c) => c.fn === 'wa_record_outbound_message').map((c) => c.args?.p_payload);
const rpcs = (fn: string) => h.state.rpcCalls.filter((c) => c.fn === fn);
const preguntar = (resultado = 'prospecto_precios') => ofrecerConsentNovedadesTrasTurno(INTEGRATION, CONV, TEL, resultado);

beforeEach(() => {
    vi.clearAllMocks();
    h.state.rpcCalls = [];
    h.state.inserts = [];
    _olvidarConsentNovedades();
    _olvidarReservasDePaso();
    delete process.env.WA_CONSENT_NOVEDADES_PROSPECTOS;
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.sendInteractiveButtons.mockResolvedValue({ ok: true, waMessageId: 'wamid.btn' });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: true });
});
afterEach(() => { delete process.env.WA_CONSENT_NOVEDADES_PROSPECTOS; });

describe('la pregunta de novedades al prospecto', () => {
    it('tras una consulta contestada: UNA pregunta con los dos botones y su paso', async () => {
        escena();
        expect(await preguntar()).toBe(true);
        const out = enviados();
        expect(out).toHaveLength(1);
        // (La base de mentira no recuerda la presentación del bot, así que acá sale encima; lo que importa es la pregunta.)
        expect(out[0].texto.endsWith(textoConsentNovedades('Escuela Ejemplo'))).toBe(true);
        expect(out[0].botones.map((b: any) => b.title)).toEqual(['Sí, cuéntenme', 'No, gracias']);
        expect(salientes().map((p) => p.step)).toEqual([PASO_CONSENT_NOVEDADES]);
        // Preguntar no registra nada: ni consentimiento ni baja.
        expect(rpcs('wa_register_optin')).toHaveLength(0);
        expect(rpcs('wa_registrar_baja_promos')).toHaveLength(0);
    });

    it('se pregunta una sola vez: la segunda llamada no manda nada', async () => {
        escena();
        expect(await preguntar()).toBe(true);
        expect(await preguntar('prospecto_ia')).toBe(false);
        expect(enviados()).toHaveLength(1);
    });

    it('una sola vez también tras reiniciar el proceso: manda lo que quedó guardado en la conversación', async () => {
        escena({ yaPreguntado: true });
        expect(await preguntar()).toBe(false);
        _olvidarConsentNovedades();
        _olvidarReservasDePaso();
        escena({ borradorPreguntado: true });
        expect(await preguntar()).toBe(false);
        expect(enviados()).toHaveLength(0);
    });

    it('no se le pregunta a una familia ni a una conversación identificada', async () => {
        escena({ conv: { parent_id: 'parent-1', identified: true } });
        expect(await preguntar()).toBe(false);
        _olvidarConsentNovedades();
        escena({ conv: { parent_id: null, identified: true } });
        expect(await preguntar()).toBe(false);
        expect(enviados()).toHaveLength(0);
    });

    it('no se le pregunta a quien ya decidió: consentimiento, baja total o baja de promociones', async () => {
        for (const optin of [
            { contact_wa_id: TEL, opted_in_at: hace(86_400_000), opted_out_at: null, promos_out_at: null },
            { contact_wa_id: TEL, opted_in_at: null, opted_out_at: hace(86_400_000), promos_out_at: null },
            { contact_wa_id: TEL, opted_in_at: null, opted_out_at: null, promos_out_at: hace(86_400_000) },
        ]) {
            _olvidarConsentNovedades();
            escena({ optins: [optin] });
            expect(await preguntar()).toBe(false);
        }
        expect(enviados()).toHaveLength(0);
    });

    it('no se pregunta en medio de una venta, un pago, un comprobante, una agenda ni como primer mensaje', async () => {
        escena();
        for (const r of ['venta_respuesta', 'venta_pago', 'venta_silencio', 'embudo', 'embudo_acuse', 'clase_cortesia',
            'clase_cortesia_en_curso', 'cortesia_semana', 'prospecto_horarios', 'pagos', 'pagos_y_precio', 'medios_de_pago',
            'pregunta_de_comprobante', 'disputa_de_pago', 'otp_correo', 'otp_codigo', 'bienvenida', 'puerta',
            'prospecto_persona', 'escuela_atendiendo', 'consentimiento_seguimiento', 'frenado', 'silencio']) {
            expect(await preguntar(r)).toBe(false);
        }
        expect(enviados()).toHaveLength(0);
    });

    it('tampoco si la respuesta dejó un flujo abierto, hay una pregunta de comprobante o la escuela está escribiendo', async () => {
        escena({ recientes: [entrante('precio?'), respuestaDelBot({ step: 'embudo_pregunta', flujo: 'embudo', paso_embudo: 'pregunta' })] });
        expect(await preguntar()).toBe(false);
        escena({ cobroAbierto: true });
        expect(await preguntar()).toBe(false);
        escena({ recientes: [entrante('precio?'), respuestaDelBot(),
            { wa_message_id: 'wamid.h', direction: 'outbound', type: 'text', text_body: 'Hola, te cuento', payload: null,
                ai_generated: false, wa_timestamp: hace(60_000), created_at: hace(60_000) }] });
        expect(await preguntar()).toBe(false);
        // El bot no alcanzó a contestar (modo asistido, envío frenado): no hay respuesta que cerrar.
        escena({ recientes: [entrante('precio?')] });
        expect(await preguntar()).toBe(false);
        expect(enviados()).toHaveLength(0);
    });

    it('con el interruptor apagado no pregunta', async () => {
        escena();
        for (const v of ['false', '0', 'off', 'NO']) {
            process.env.WA_CONSENT_NOVEDADES_PROSPECTOS = v;
            expect(await preguntar()).toBe(false);
        }
        expect(enviados()).toHaveLength(0);
        process.env.WA_CONSENT_NOVEDADES_PROSPECTOS = 'true';
        expect(await preguntar()).toBe(true);
    });

    it('tolera la base sin `promos_out_at` (42703): pregunta igual', async () => {
        escena({ sinColumnaPromos: true });
        expect(await preguntar()).toBe(true);
        expect(enviados()).toHaveLength(1);
    });

    it('si no se pudo leer la conversación, no pregunta', async () => {
        escena({ conv: null });
        expect(await preguntar()).toBe(false);
        expect(enviados()).toHaveLength(0);
    });
});

describe('la respuesta a la pregunta', () => {
    it('«Sí, cuéntenme» registra el consentimiento con fuente bot_prospecto y el mensaje como prueba; ninguna baja', async () => {
        escena();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí, cuéntenme', BOTON_CONSENT_NOVEDADES.SI);
        expect(r).toBe('consentimiento_seguimiento');
        expect(rpcs('wa_register_optin')).toHaveLength(1);
        expect(rpcs('wa_register_optin')[0].args).toMatchObject({
            p_integration_id: 'int-1', p_school_id: 'school-1', p_contact_wa_id: TEL,
            p_source: 'bot_prospecto', p_source_ref: 'wamid.respuesta-del-prospecto', p_opt_out: false,
        });
        expect(rpcs('wa_registrar_baja_promos')).toHaveLength(0);
        expect(enviados().map((m) => m.texto)).toEqual([textoRespuestaConsentNovedades(true)]);
        expect(salientes()[0]).toMatchObject({ step: PASO_CONSENT_NOVEDADES, respuesta: 'si' });
    });

    it('«No, gracias» registra SOLO la baja de promociones: ni consentimiento ni baja total', async () => {
        escena();
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'No, gracias', BOTON_CONSENT_NOVEDADES.NO);
        expect(r).toBe('consentimiento_seguimiento');
        expect(rpcs('wa_registrar_baja_promos')).toHaveLength(1);
        expect(rpcs('wa_registrar_baja_promos')[0].args).toMatchObject({
            p_integration_id: 'int-1', p_school_id: 'school-1', p_contact_wa_id: TEL, p_ref: 'wamid.respuesta-del-prospecto',
        });
        // `wa_register_optin` es la única vía de la baja total (p_opt_out): no se llama.
        expect(rpcs('wa_register_optin')).toHaveLength(0);
        expect(enviados().map((m) => m.texto)).toEqual([textoRespuestaConsentNovedades(false)]);
        expect(salientes()[0]).toMatchObject({ step: PASO_CONSENT_NOVEDADES, respuesta: 'no' });
    });

    it('el «sí» de quien había dicho que no levanta la baja de promociones', async () => {
        escena({ optins: [{ contact_wa_id: TEL, opted_in_at: null, opted_out_at: null, promos_out_at: hace(3_600_000) }] });
        await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí, cuéntenme', BOTON_CONSENT_NOVEDADES.SI);
        expect(rpcs('wa_register_optin')).toHaveLength(1);
        expect(rpcs('wa_reactivar_promos')).toHaveLength(1);
    });

    it('«sí» ESCRITO vale solo si la pregunta es lo último que dijo el bot', async () => {
        const pregunta = respuestaDelBot({ step: PASO_CONSENT_NOVEDADES });
        escena({ recientes: [entrante('si', 1_000), pregunta, entrante('precio?', 20_000)] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí')).toBe('consentimiento_seguimiento');
        expect(rpcs('wa_register_optin')).toHaveLength(1);

        h.state.rpcCalls = [];
        escena({ recientes: [entrante('no', 1_000), pregunta] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'no')).toBe('consentimiento_seguimiento');
        expect(rpcs('wa_registrar_baja_promos')).toHaveLength(1);
        expect(rpcs('wa_register_optin')).toHaveLength(0);
    });

    it('«sí» escrito SIN la pregunta abierta no registra nada', async () => {
        // Lo último del bot fue otra cosa (los valores): ese «sí» no es un consentimiento.
        escena({ recientes: [entrante('si', 1_000), respuestaDelBot()] });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí');
        expect(r).not.toBe('consentimiento_seguimiento');
        expect(rpcs('wa_register_optin')).toHaveLength(0);
        expect(rpcs('wa_registrar_baja_promos')).toHaveLength(0);
        // Y la pregunta ya contestada tampoco: un «sí» posterior es respuesta a otra cosa.
        escena({ recientes: [entrante('si', 1_000), respuestaDelBot({ step: PASO_CONSENT_NOVEDADES, respuesta: 'no' })] });
        expect(await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí')).not.toBe('consentimiento_seguimiento');
        expect(rpcs('wa_register_optin')).toHaveLength(0);
    });

    it('por nota de voz no se toma un «sí» como consentimiento', async () => {
        escena({ recientes: [entrante('si', 1_000), respuestaDelBot({ step: PASO_CONSENT_NOVEDADES })] });
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Sí', null, null, 'audio');
        expect(r).not.toBe('consentimiento_seguimiento');
        expect(rpcs('wa_register_optin')).toHaveLength(0);
    });
});
