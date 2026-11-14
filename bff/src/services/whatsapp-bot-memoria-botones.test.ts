/**
 * Memoria de la conversación, botones de respuesta rápida, prospecto que
 * pregunta el precio y correo al escalar (2026-10-04).
 *
 * Mismo andamiaje que whatsapp-atencion-bot.test.ts: Supabase con un builder
 * encadenable, el modelo y el envío mockeados. No tocan la base ni a Meta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        updates: { table: string; row: any }[];
        rpcCalls: { fn: string; args: any }[];
    } = {
        resolve: () => ({ data: null, error: null }),
        rpc: () => ({ data: null, error: null }),
        inserts: [],
        updates: [],
        rpcCalls: [],
    };
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        const chain = (name: string) => (...args: any[]) => { ops.push([name, args]); return b; };
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not']) {
            b[m] = chain(m);
        }
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { state.updates.push({ table, row }); ops.push(['update', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(state.resolve(table, ops));
        b.single = () => Promise.resolve(state.resolve(table, ops));
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
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendInteractiveButtons: vi.fn(),
        sendCtaUrl: vi.fn(),
        sendToUser: vi.fn(),
        mediosDePago: vi.fn(),
        avisarEscalamientoPorCorreo: vi.fn(),
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
    sendTextMessage: h.sendTextMessage,
    sendInteractiveButtons: h.sendInteractiveButtons,
    sendCtaUrl: h.sendCtaUrl,
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('./whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(async () => false),
    AVISO_DADO_DE_BAJA: '\n\n(baja)',
}));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: h.sendToUser }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({
    mediosDePago: h.mediosDePago,
    // Con los cobros de la familia (enlace /p/:token de cada uno); acá sin cobros.
    mediosDePagoDeFamilia: async (schoolId: string) => ({ ...(await h.mediosDePago(schoolId)), cobros_pendientes: [] }),
}));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: h.avisarEscalamientoPorCorreo }));

import {
    runBotTurn, atenderDesconocido, historialDesdeFilas, armarTurnos, accionDeBoton,
    respondioQueNoLoTiene, BOTON, BOTONES_SIN_DATO, BOTONES_CONSENTIMIENTO,
    HISTORIAL_MAX_MENSAJES, HISTORIAL_MAX_CARACTERES, PREFIJO_ESCUELA, type FilaDeHistorial,
} from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const PADRE = 'parent-1';
const TEL = '573001112233';

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');
const rpcs = (fn: string) => h.state.rpcCalls.filter((c) => c.fn === fn);
const esConsultaDeHistorial = (ops: [string, any[]][]) => ops.some(([m]) => m === 'order');
const pideStep = (ops: [string, any[]][], step: string) =>
    ops.some(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step') && a[1] === step);

/**
 * Familia identificada. `consentimiento`: 'dado' (ya aceptó), 'preguntado'
 * (se le preguntó y no contestó) o 'nunca'.
 */
function baseDeFamilia(op: {
    settings?: Record<string, any>;
    consentimiento?: 'dado' | 'preguntado' | 'nunca';
    historial?: FilaDeHistorial[];
    statusConv?: string;
} = {}) {
    const settings = op.settings ?? { ai_enabled: true, mode: 'assisted' };
    const consentimiento = op.consentimiento ?? 'dado';
    h.state.resolve = (table, ops) => {
        if (table === 'whatsapp_messages' && esConsultaDeHistorial(ops)) {
            return { data: op.historial ?? [], error: null };
        }
        if (table === 'whatsapp_messages' && pideStep(ops, 'ask_consent')) {
            return { count: consentimiento === 'preguntado' ? 1 : 0, error: null };
        }
        if (table === 'whatsapp_message_drafts') return { count: 0, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: PADRE, identified: true,
                status: op.statusConv ?? 'closed', contact_name: 'Acudiente' }, error: null };
        }
        if (table === 'whatsapp_optins') {
            return { data: consentimiento === 'dado'
                ? { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null } : null, error: null };
        }
        if (table === 'whatsapp_settings') return { data: settings, error: null };
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') return { data: { estado: 'identificado', parent_id: PADRE }, error: null };
        if (fn === 'wa_get_payment_status') {
            return { data: [{ concept: 'Mensualidad Octubre', saldo: 170000, due_date: '2026-10-10', debe_pagarse: true }], error: null };
        }
        return { data: null, error: null };
    };
}

const AUTO = { ai_enabled: true, mode: 'auto', assisted_until: null };

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.rpcCalls = [];
    h.chatWithTools.mockResolvedValue({ text: 'Estás al día ✅', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.sendInteractiveButtons.mockResolvedValue({ ok: true, waMessageId: 'wamid.btn' });
    h.sendCtaUrl.mockResolvedValue({ ok: true, waMessageId: 'wamid.cta' });
    h.botEncendido.mockResolvedValue(true);
    h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
    h.mediosDePago.mockResolvedValue({ cuentas: [{ tipo: 'Nequi', numero: '3001234567', titular: 'Dynasty' }],
        enlace_para_pagar: 'https://app.sportmaps.co/pagar' });
    h.avisarEscalamientoPorCorreo.mockResolvedValue(undefined);
    baseDeFamilia();
});

// ─── 1. Memoria ───────────────────────────────────────────────────────────────

describe('historial: qué entra y en qué forma', () => {
    const AHORA = new Date('2026-10-04T15:00:00Z').getTime();
    const hace = (min: number) => new Date(AHORA - min * 60_000).toISOString();

    it('ordena, mapea roles, marca a la escuela y excluye automáticos, el actual y lo viejo', () => {
        const filas: FilaDeHistorial[] = [
            // vienen desordenadas (la consulta trae desc)
            { wa_message_id: 'w-actual', direction: 'inbound', type: 'text', text_body: '¿y a qué cuenta?', created_at: hace(0) },
            { wa_message_id: 'w3', direction: 'outbound', type: 'text', text_body: 'El sábado no hay entreno',
              ai_generated: false, payload: { to: TEL }, created_at: hace(5) },
            { wa_message_id: 'w2', direction: 'outbound', type: 'text', text_body: 'Debes $170.000',
              ai_generated: true, payload: { step: 'get_payment_status' }, created_at: hace(10) },
            { wa_message_id: 'w1', direction: 'inbound', type: 'text', text_body: '¿cuánto debo?', created_at: hace(11) },
            { wa_message_id: 'auto', direction: 'outbound', type: 'text', text_body: 'Gracias por escribir a Dynasty, ya te respondemos',
              ai_generated: false, payload: { to: TEL, automatico: true }, created_at: hace(12) },
            { wa_message_id: 'viejo', direction: 'inbound', type: 'text', text_body: 'mensaje de ayer', created_at: hace(25 * 60) },
            // historial sincronizado: created_at de hoy, wa_timestamp de hace meses
            { wa_message_id: 'sync', direction: 'inbound', type: 'text', text_body: 'de junio',
              wa_timestamp: '2026-06-01T10:00:00Z', created_at: hace(30) },
            { wa_message_id: 'st', direction: 'inbound', type: 'sticker', text_body: null, created_at: hace(3) },
            { wa_message_id: 'img', direction: 'inbound', type: 'image', text_body: null, created_at: hace(2) },
        ];

        const turnos = historialDesdeFilas(filas, 'w-actual', AHORA);

        expect(turnos).toEqual([
            { role: 'user', content: '¿cuánto debo?' },
            { role: 'assistant', content: 'Debes $170.000' },
            { role: 'assistant', content: `${PREFIJO_ESCUELA}El sábado no hay entreno` },
            { role: 'user', content: '[envió una imagen]' },
        ]);
        expect(JSON.stringify(turnos)).not.toContain('Gracias por escribir');
        expect(JSON.stringify(turnos)).not.toContain('de junio');
    });

    it(`se queda con los últimos ${HISTORIAL_MAX_MENSAJES} y recorta los largos`, () => {
        const filas: FilaDeHistorial[] = Array.from({ length: 12 }, (_, i) => ({
            wa_message_id: `w${i}`, direction: i % 2 ? 'outbound' : 'inbound', ai_generated: true,
            type: 'text', text_body: i === 11 ? 'x'.repeat(2000) : `m${i}`, created_at: hace(60 - i),
        }));
        const turnos = historialDesdeFilas(filas, null, AHORA);
        expect(turnos).toHaveLength(HISTORIAL_MAX_MENSAJES);
        expect(turnos[0].content).toBe('m4');
        const ultimo = turnos[turnos.length - 1].content;
        expect(ultimo.length).toBeLessThanOrEqual(HISTORIAL_MAX_CARACTERES + 1);
        expect(ultimo.endsWith('…')).toBe(true);
    });

    it('armarTurnos: alterna user/assistant, fusiona consecutivos y empieza por user (Gemini)', () => {
        const turnos = armarTurnos([
            { role: 'assistant', content: 'Activado ✅' },          // la ventana cortó acá → se descarta
            { role: 'user', content: 'hola' },
            { role: 'user', content: 'una pregunta' },
            { role: 'assistant', content: 'Debes $170.000' },
            { role: 'assistant', content: `${PREFIJO_ESCUELA}ya te mando la cuenta` },
        ], '¿y a qué cuenta?');

        expect(turnos).toEqual([
            { role: 'user', content: 'hola\nuna pregunta' },
            { role: 'assistant', content: `Debes $170.000\n${PREFIJO_ESCUELA}ya te mando la cuenta` },
            { role: 'user', content: '¿y a qué cuenta?' },
        ]);
        for (let i = 1; i < turnos.length; i++) expect(turnos[i].role).not.toBe(turnos[i - 1].role);
    });

    it('armarTurnos: sin historial es el mensaje solo, como antes', () => {
        expect(armarTurnos([], 'hola')).toEqual([{ role: 'user', content: 'hola' }]);
    });

    it('el modelo recibe el historial + el mensaje actual al final', async () => {
        const ahora = Date.now();
        baseDeFamilia({ historial: [
            { wa_message_id: 'wamid.actual', direction: 'inbound', type: 'text', text_body: '¿y el de mi otra hija?',
              created_at: new Date(ahora).toISOString() },
            { wa_message_id: 'w2', direction: 'outbound', type: 'text', text_body: 'Sara debe $170.000', ai_generated: true,
              created_at: new Date(ahora - 60_000).toISOString() },
            { wa_message_id: 'w1', direction: 'inbound', type: 'text', text_body: '¿cuánto debe Sara?',
              created_at: new Date(ahora - 120_000).toISOString() },
        ] });

        await runBotTurn(INTEGRATION, CONV, TEL, '¿y el de mi otra hija?', 'wamid.actual');

        const { messages } = h.chatWithTools.mock.calls[0][0];
        expect(messages).toEqual([
            { role: 'user', content: '¿cuánto debe Sara?' },
            { role: 'assistant', content: 'Sara debe $170.000' },
            { role: 'user', content: '¿y el de mi otra hija?' },
        ]);
    });

    it('si leer el historial falla, el bot sigue con el mensaje solo', async () => {
        const base = h.state.resolve;
        h.state.resolve = (t, ops) => (t === 'whatsapp_messages' && esConsultaDeHistorial(ops))
            ? { data: null, error: { message: 'timeout' } } : base(t, ops);
        await runBotTurn(INTEGRATION, CONV, TEL, 'hola', 'wamid.1');
        expect(h.chatWithTools.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'hola' }]);
    });
});

// ─── 3. Botones ──────────────────────────────────────────────────────────────

describe('botones: respuesta a un botón = acción determinista, sin modelo', () => {
    it('accionDeBoton: por id y por el título escrito tal cual, nunca por subcadena', () => {
        expect(accionDeBoton(BOTON.VER_PAGOS, 'Ver mis pagos')).toBe('get_payment_status');
        expect(accionDeBoton(BOTON.COMO_PAGAR, 'lo que sea')).toBe('get_payment_methods');
        expect(accionDeBoton(BOTON.HABLAR_CON_ESCUELA, '')).toBe('escalate');
        expect(accionDeBoton(null, 'ver mis pagos')).toBe('get_payment_status');
        expect(accionDeBoton(null, '*Cómo pagar*')).toBe('get_payment_methods');
        expect(accionDeBoton(null, 'no quiero ver mis pagos todavía')).toBeNull();
        expect(accionDeBoton('id-desconocido', 'hola')).toBeNull();
    });

    it('«Ver mis pagos» → wa_get_payment_status y el texto determinista', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Ver mis pagos', 'wamid.b', false, BOTON.VER_PAGOS);
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(rpcs('wa_get_payment_status')).toHaveLength(1);
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.proposed_text).toContain('Mensualidad Octubre');
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'get_payment_status', via: 'boton' });
    });

    it('«Ver mis pagos» con UN cobro: «Pagar: /p/<token>» en el texto y botón URL (auto)', async () => {
        baseDeFamilia({ settings: AUTO });
        const TOKEN = 'abcdefghijklmnopqrstuvwx';
        const resolvePrevio = h.state.resolve;
        h.state.resolve = (table, ops) => table === 'payments'
            ? { data: [{ id: 'pay-1', concept: 'Mensualidad Octubre', amount: 170000, due_date: '2026-10-10', status: 'pending' }], error: null }
            : resolvePrevio(table, ops);
        const rpcPrevio = h.state.rpc;
        h.state.rpc = (fn, args) => {
            if (fn === 'wa_get_payment_status') {
                return { data: [{ concept: 'Mensualidad Octubre', saldo: 170000, amount: 170000, status: 'pending',
                    due_date: '2026-10-10', debe_pagarse: true }], error: null };
            }
            if (fn === 'cobro_enlace_publico_emitir') return { data: [{ enlace_token: TOKEN }], error: null };
            return rpcPrevio(fn, args);
        };
        await runBotTurn(INTEGRATION, CONV, TEL, 'Ver mis pagos', 'wamid.b', false, BOTON.VER_PAGOS);
        const url = `https://app.sportmaps.co/p/${TOKEN}`;
        expect(rpcs('cobro_enlace_publico_emitir')[0].args).toMatchObject({ p_payment_id: 'pay-1' });
        expect(h.sendCtaUrl).toHaveBeenCalledTimes(1);
        const [, , cuerpo, texto, enlace] = h.sendCtaUrl.mock.calls[0];
        expect(cuerpo).toContain(`Pagar: ${url}`);
        expect([texto, enlace]).toEqual(['Pagar', url]);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('«Cómo pagar» → medios de pago sin modelo', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Cómo pagar', 'wamid.b', false, BOTON.COMO_PAGAR);
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(h.mediosDePago).toHaveBeenCalledWith('school-1');
        expect(borradores()[0].row.proposed_text).toContain('3001234567');
    });

    it('«Hablar con la escuela» → escala (buzón abierto, push y correo una vez)', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'Hablar con la escuela', 'wamid.b', false, BOTON.HABLAR_CON_ESCUELA);
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(h.state.updates).toContainEqual(expect.objectContaining({
            table: 'whatsapp_conversations', row: expect.objectContaining({ status: 'open' }),
        }));
        expect(h.sendToUser).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(h.avisarEscalamientoPorCorreo).toHaveBeenCalledTimes(1);
        expect(h.avisarEscalamientoPorCorreo).toHaveBeenCalledWith({
            schoolId: 'school-1', conversationId: CONV, contactName: 'Acudiente',
            contactWaId: TEL, motivo: 'boton_hablar_con_la_escuela',
        });
    });

    it('el título escrito a mano (borrador aprobado como texto) hace lo mismo', async () => {
        await runBotTurn(INTEGRATION, CONV, TEL, 'ver mis pagos', 'wamid.b');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(rpcs('wa_get_payment_status')).toHaveLength(1);
    });
});

describe('botones: consentimiento', () => {
    it('el botón «Sí, acepto» estampa el opt-in igual que escribir «sí»', async () => {
        baseDeFamilia({ consentimiento: 'preguntado' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Sí, acepto', 'wamid.si', false, BOTON.CONSENTIR_SI);
        expect(rpcs('wa_register_optin')).toHaveLength(1);
        expect(rpcs('wa_register_optin')[0].args).toMatchObject({ p_source_ref: 'wamid.si', p_opt_out: false });
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('vale el id aunque el título llegue distinto', async () => {
        baseDeFamilia({ consentimiento: 'preguntado' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Yes, I accept', 'wamid.si', false, BOTON.CONSENTIR_SI);
        expect(rpcs('wa_register_optin')).toHaveLength(1);
    });

    it('«No, gracias» no registra nada y cierra la pregunta', async () => {
        baseDeFamilia({ consentimiento: 'preguntado' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'No, gracias', 'wamid.no', false, BOTON.CONSENTIR_NO);
        expect(rpcs('wa_register_optin')).toHaveLength(0);
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'consent_rechazado' });
    });

    // P2 (análisis 2026-10-06): la pregunta va con un turno resuelto, nunca
    // como primera respuesta. P2 bis (2026-10-07): AL PIE del estado de pagos,
    // en el mismo mensaje — no como un segundo mensaje 2 s después (…2d2e84).
    it('la pregunta de consentimiento va al pie del estado de pagos, con botones, en UN mensaje', async () => {
        baseDeFamilia({ consentimiento: 'nunca', settings: AUTO });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Ver mis pagos', 'wamid.1', false, BOTON.VER_PAGOS);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
        expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
        const [, to, body, botones] = h.sendInteractiveButtons.mock.calls[0];
        expect(to).toBe(TEL);
        expect(body).toContain('Mensualidad Octubre');
        expect(body).toContain('Responde *SÍ*');
        expect(body.indexOf('Mensualidad Octubre')).toBeLessThan(body.indexOf('Responde *SÍ*'));
        expect(body).not.toContain('STOP');
        expect(botones).toEqual(BOTONES_CONSENTIMIENTO);
        const salientes = rpcs('wa_record_outbound_message');
        expect(salientes).toHaveLength(1);
        expect(salientes[0].args).toMatchObject({ p_type: 'interactive', p_wa_message_id: 'wamid.btn' });
        expect(salientes[0].args.p_payload).toMatchObject({ step: 'get_payment_status', pregunta: 'ask_consent' });
    });

    it('un saludo NO recibe la pregunta de consentimiento como respuesta', async () => {
        baseDeFamilia({ consentimiento: 'nunca' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'hola', 'wamid.1');
        expect(borradores().map((b) => b.row.tool_context.step)).not.toContain('ask_consent');
    });

    it('modo asistido: el borrador es texto y guarda los botones en tool_context', async () => {
        baseDeFamilia({ consentimiento: 'nunca' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Ver mis pagos', 'wamid.1', false, BOTON.VER_PAGOS);
        expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.proposed_text).toContain('Mensualidad Octubre');
        expect(borradores()[0].row.proposed_text).toContain('Responde *SÍ*');
        expect(borradores()[0].row.tool_context).toMatchObject({
            step: 'get_payment_status', pregunta: 'ask_consent', botones: BOTONES_CONSENTIMIENTO });
    });

    it('ya preguntado (una vez máximo): no se vuelve a preguntar', async () => {
        baseDeFamilia({ consentimiento: 'preguntado' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'Ver mis pagos', 'wamid.1', false, BOTON.VER_PAGOS);
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'get_payment_status' });
    });
});

describe('botones: tras «eso no lo tengo a la mano»', () => {
    const NO_LO_TENGO = 'Eso no lo tengo a la mano. ¿Quieres que te comunique con la escuela?';

    it('detecta la frase del prompt', () => {
        expect(respondioQueNoLoTiene(NO_LO_TENGO)).toBe(true);
        expect(respondioQueNoLoTiene('No tengo ese dato, pero la escuela te lo confirma')).toBe(true);
        expect(respondioQueNoLoTiene('Estás al día ✅')).toBe(false);
    });

    it('modo auto: salen los tres botones', async () => {
        baseDeFamilia({ settings: AUTO });
        h.chatWithTools.mockResolvedValue({ text: NO_LO_TENGO, toolCalls: [], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, TEL, '¿quién es el entrenador del sub 13?', 'wamid.1');
        expect(h.sendInteractiveButtons).toHaveBeenCalledWith(INTEGRATION, TEL, NO_LO_TENGO, BOTONES_SIN_DATO);
        expect(rpcs('wa_record_outbound_message')[0].args.p_type).toBe('interactive');
    });

    it('si Meta rechaza los botones, sale el texto con las opciones escritas', async () => {
        baseDeFamilia({ settings: AUTO });
        h.chatWithTools.mockResolvedValue({ text: NO_LO_TENGO, toolCalls: [], provider: 'test' });
        h.sendInteractiveButtons.mockResolvedValue({ ok: false, error: 'graph_400' });
        await runBotTurn(INTEGRATION, CONV, TEL, '¿quién es el entrenador?', 'wamid.1');
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(h.sendTextMessage.mock.calls[0][2]).toContain('*Ver mis pagos*');
        expect(rpcs('wa_record_outbound_message')[0].args.p_type).toBe('text');
    });

    it('modo asistido: borrador con las opciones en texto y los botones en tool_context', async () => {
        h.chatWithTools.mockResolvedValue({ text: NO_LO_TENGO, toolCalls: [], provider: 'test' });
        await runBotTurn(INTEGRATION, CONV, TEL, '¿quién es el entrenador?', 'wamid.1');
        const { proposed_text, tool_context } = borradores()[0].row;
        expect(proposed_text).toContain(NO_LO_TENGO);
        expect(proposed_text).toContain('*Cómo pagar*');
        expect(tool_context.botones).toEqual(BOTONES_SIN_DATO);
    });

    it('una respuesta normal no lleva botones', async () => {
        baseDeFamilia({ settings: AUTO });
        await runBotTurn(INTEGRATION, CONV, TEL, '¿cuánto debo?', 'wamid.1');
        expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    });
});

// ─── 5. Correo al escalar ────────────────────────────────────────────────────

describe('correo al escalar', () => {
    const escalarConElModelo = () => h.chatWithTools.mockResolvedValue({
        text: '', provider: 'test',
        toolCalls: [{ name: 'escalate_to_human', args: { reason: 'quiere hablar con alguien' } }],
    });

    it('transición a abierta: un solo correo con el motivo', async () => {
        escalarConElModelo();
        // Un texto que NO dispara la regla de «pedir una persona» (P9): acá se
        // prueba la escalación que decide el modelo.
        await runBotTurn(INTEGRATION, CONV, TEL, 'tengo un problema con la inscripción de mi hijo', 'wamid.1');
        await Promise.resolve();
        expect(h.avisarEscalamientoPorCorreo).toHaveBeenCalledTimes(1);
        expect(h.avisarEscalamientoPorCorreo.mock.calls[0][0]).toMatchObject({ motivo: 'Resumen del asistente (no verificado): quiere hablar con alguien' });
    });

    it('ya estaba abierta: ni push ni correo', async () => {
        escalarConElModelo();
        baseDeFamilia({ statusConv: 'open' });
        await runBotTurn(INTEGRATION, CONV, TEL, 'quiero hablar con alguien', 'wamid.1');
        await Promise.resolve();
        expect(h.avisarEscalamientoPorCorreo).not.toHaveBeenCalled();
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it('si el correo revienta, la familia igual recibe la respuesta', async () => {
        escalarConElModelo();
        h.avisarEscalamientoPorCorreo.mockRejectedValue(new Error('resend caído'));
        await runBotTurn(INTEGRATION, CONV, TEL, 'quiero hablar con alguien', 'wamid.1');
        await Promise.resolve();
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'escalated' });
    });

    it('contacto que no se atiende: tampoco hay correo', async () => {
        escalarConElModelo();
        h.debeAtender.mockResolvedValue({ atender: false, tipo: 'personal', botEncendido: true });
        await runBotTurn(INTEGRATION, CONV, TEL, 'quiero hablar con alguien', 'wamid.1');
        await Promise.resolve();
        expect(h.avisarEscalamientoPorCorreo).not.toHaveBeenCalled();
    });
});

// ─── 2. Prospecto que pregunta el precio ─────────────────────────────────────

describe('desconocido que pregunta el precio de la mensualidad', () => {
    function baseDeDesconocido(qr: any[]) {
        h.state.resolve = (table, ops) => {
            if (pideStep(ops, 'desconocido_tema_escolar')) return { count: 0, error: null };
            if (table === 'whatsapp_conversations') {
                return { data: { id: CONV, parent_id: null, identified: false, status: 'closed', contact_name: null }, error: null };
            }
            if (table === 'school_join_qr_codes') return { data: qr, error: null };
            if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
            if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
            if (table === 'school_members') return { data: [], error: null };
            return { data: null, error: null };
        };
    }
    const QR = { slug: 'escuela-inscripcion', target_type: 'open', signup_count: 121 };

    it.each([
        '¿Qué precio tiene la mensualidad?',
        'Cuánto vale la mensualidad de 2 clases',
    ])('«%s» → UN mensaje con correo para familias y enlace para prospectos', async (texto) => {
        baseDeDesconocido([QR]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, texto);
        expect(r).toBe('pagos_y_precio');
        expect(borradores()).toHaveLength(1);
        const { proposed_text, tool_context } = borradores()[0].row;
        expect(proposed_text).toContain('correo electrónico');
        expect(proposed_text).toContain('/join/escuela-inscripcion');
        expect(tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'pagos_y_precio', con_enlace: true });
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it('sin enlace: correo para familias + aviso a la escuela (push y correo de prospecto)', async () => {
        baseDeDesconocido([]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, '¿Qué precio tiene la mensualidad?');
        expect(r).toBe('pagos_y_precio_sin_enlace');
        expect(borradores()[0].row.proposed_text).toContain('correo electrónico');
        expect(borradores()[0].row.proposed_text).not.toContain('/join/');
        expect(h.sendToUser).toHaveBeenCalledTimes(1);
        await Promise.resolve();
        expect(h.avisarEscalamientoPorCorreo).toHaveBeenCalledTimes(1);
        expect(h.avisarEscalamientoPorCorreo.mock.calls[0][0]).toMatchObject({ motivo: 'prospecto' });
    });

    it('familia que habla de SU cobro → solo el pedido de correo, sin enlace', async () => {
        baseDeDesconocido([QR]);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, 'Envío comprobante de la mensualidad');
        expect(r).toBe('pagos');
        expect(borradores()[0].row.proposed_text).not.toContain('/join/');
    });

    it('mismo freno de 30 días', async () => {
        baseDeDesconocido([QR]);
        const base = h.state.resolve;
        h.state.resolve = (t, ops) => (t === 'whatsapp_messages' && pideStep(ops, 'desconocido_tema_escolar'))
            ? { count: 1, error: null } : base(t, ops);
        const r = await atenderDesconocido(INTEGRATION, CONV, TEL, '¿Qué precio tiene la mensualidad?');
        expect(r).toBe('frenado');
        expect(borradores()).toHaveLength(0);
    });
});
