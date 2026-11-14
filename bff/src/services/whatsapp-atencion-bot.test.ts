/**
 * El filtro de atención del bot: a quién le contesta y qué pasa apagado.
 *
 * Los casos vienen de Dynasty el 2026-10-03, primer día por Coexistence: con
 * `ai_enabled=false` el bot igual corrió el modelo en cada mensaje y dejó 316
 * borradores, 238 de ellos «escríbeme tu correo» a contactos personales de la
 * dueña. De 55 conversaciones solo 30 eran familias.
 *
 * Deterministas: mockean Supabase (builder encadenable), `debeAtender`, el
 * modelo y el envío. No tocan la base ni a Meta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state: {
        resolve: (table: string, ops: Ops) => any;
        rpc: (fn: string, args: any) => any;
        inserts: { table: string; row: any }[];
        updates: { table: string; row: any }[];
        rpcCalls: string[];
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
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'update', 'is', 'not']) {
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
            rpc: (fn: string, args: any) => { state.rpcCalls.push(fn); return Promise.resolve(state.rpc(fn, args)); },
        },
        debeAtender: vi.fn(),
        botEncendido: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        sendToUser: vi.fn(),
        encolarAdjunto: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
// `temaEscolar` va REAL: es la regla que se está probando de punta a punta.
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
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    verifyWebhookSignature: vi.fn(),
    resolveIntegration: vi.fn(),
    parseInboundMessages: vi.fn(() => []),
    parseStatuses: vi.fn(() => []),
    markAsRead: vi.fn(),
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
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
// El correo de escalamiento es no bloqueante y lo prueba su propio archivo;
// acá solo estorbaría con logs del agente de correo.
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: vi.fn(async () => {}) }));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: h.encolarAdjunto }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { runBotTurn, deliver } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const PADRE = 'parent-1';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;

const mensaje = (over: Record<string, any> = {}) => ({
    phoneNumberId: 'pn-1', contactWaId: '573001112233', contactName: 'Acudiente',
    waMessageId: 'wamid.1', type: 'text', textBody: '¿cuánto debo?', raw: {}, waTimestamp: null,
    ...over,
}) as any;

/** Base de una familia ya identificada y con consentimiento: el turno llega al LLM. */
function baseDeFamilia(settings: Record<string, any> = { ai_enabled: true, mode: 'assisted' }) {
    h.state.resolve = (table) => {
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: PADRE, identified: true, status: 'closed', contact_name: 'Acudiente' }, error: null };
        }
        if (table === 'whatsapp_optins') {
            return { data: { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null }, error: null };
        }
        if (table === 'whatsapp_settings') return { data: settings, error: null };
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'wa_identify_by_phone') return { data: { estado: 'identificado', parent_id: PADRE }, error: null };
        return { data: null, error: null };
    };
}

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.updates = [];
    h.state.rpcCalls = [];
    h.chatWithTools.mockResolvedValue({ text: 'Claro, te ayudo con eso 🙌', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ waMessageId: 'wamid.out' });
    h.botEncendido.mockResolvedValue(true);
    baseDeFamilia();
});

describe('webhook: filtro de atención antes de responder', () => {
    it('bot APAGADO: no corre el modelo ni deja borrador, aunque sea familia', async () => {
        h.debeAtender.mockResolvedValue({ atender: false, tipo: 'familia', botEncendido: false });
        h.botEncendido.mockResolvedValue(false);

        await handleBotTurn(req, INTEGRATION, CONV, mensaje());

        // La clasificación corre igual: es lo que deja al buzón filtrar.
        expect(h.debeAtender).toHaveBeenCalledWith(INTEGRATION, CONV, '573001112233');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('bot APAGADO: la baja (STOP) no se confirma', async () => {
        h.debeAtender.mockResolvedValue({ atender: false, tipo: 'familia', botEncendido: false });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'STOP' }), true);
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('bot APAGADO: una nota de voz no recibe el aviso de «no puedo escuchar»', async () => {
        h.debeAtender.mockResolvedValue({ atender: false, tipo: 'familia', botEncendido: false });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'audio', textBody: null }));
        expect(borradores()).toHaveLength(0);
    });

    it.each(['desconocido', 'staff', 'personal'] as const)(
        'bot PRENDIDO y contacto %s: silencio total',
        async (tipo) => {
            h.debeAtender.mockResolvedValue({ atender: false, tipo, botEncendido: true });
            await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'hola, ¿cómo vas?' }));
            expect(h.chatWithTools).not.toHaveBeenCalled();
            expect(borradores()).toHaveLength(0);
            expect(h.sendTextMessage).not.toHaveBeenCalled();
            expect(h.sendToUser).not.toHaveBeenCalled();
        },
    );

    it('si la clasificación revienta, el bot se calla', async () => {
        h.debeAtender.mockRejectedValue(new Error('rpc caída'));
        await handleBotTurn(req, INTEGRATION, CONV, mensaje());
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(0);
    });

    it('bot PRENDIDO y familia: sí corre el modelo y deja el borrador (modo asistido)', async () => {
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje());
        expect(h.chatWithTools).toHaveBeenCalledTimes(1);
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row).toMatchObject({ proposed_text: 'Claro, te ayudo con eso 🙌', status: 'pending' });
    });

    it('bot PRENDIDO y familia en modo auto: envía', async () => {
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
        baseDeFamilia({ ai_enabled: true, mode: 'auto', assisted_until: null });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje());
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(borradores()).toHaveLength(0);
    });

    it('los adjuntos se encolan siempre y el webhook NO acusa: responde la cola (acuse diferido, 2026-10-07)', async () => {
        h.encolarAdjunto.mockResolvedValue('encolado');
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'image', textBody: null }));
        expect(h.encolarAdjunto).toHaveBeenCalledTimes(1);
        // Ni acuse enviado ni borrador: el resultado (o el acuse a los 90 s) lo manda el worker.
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('adjunto de un contacto que no se atiende (personal / bot apagado): se encola y NO se acusa', async () => {
        h.encolarAdjunto.mockResolvedValue('encolado');
        for (const d of [
            { atender: false, tipo: 'personal', botEncendido: true },
            { atender: false, tipo: 'familia', botEncendido: false },
        ]) {
            h.debeAtender.mockResolvedValue(d);
            await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'image', textBody: null }));
        }
        expect(h.encolarAdjunto).toHaveBeenCalledTimes(2);
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('reintento de Meta (duplicado): no se acusa dos veces', async () => {
        h.encolarAdjunto.mockResolvedValue('duplicado');
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'image', textBody: null }));
        expect(borradores()).toHaveLength(0);
    });
});

describe('defensa en profundidad: apagado = apagado', () => {
    it('runBotTurn llamado directo con el bot apagado no corre el modelo', async () => {
        h.botEncendido.mockResolvedValue(false);
        await runBotTurn(INTEGRATION, CONV, '573001112233', '¿cuánto debo?', 'wamid.1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(0);
    });

    it.each([
        ['ai_enabled=false', { ai_enabled: false, mode: 'assisted' }],
        ['sin fila de ajustes', null],
        ['ai_enabled=null', { ai_enabled: null, mode: 'auto' }],
    ])('deliver con %s: ni borrador ni envío', async (_caso, settings) => {
        baseDeFamilia(settings as any);
        await deliver(INTEGRATION, CONV, '573001112233', 'escríbeme tu correo', { step: 'ask_email' });
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });
});

describe('push de «alguien espera respuesta»', () => {
    const escalarConElModelo = () =>
        h.chatWithTools.mockResolvedValue({
            text: '', provider: 'test',
            toolCalls: [{ name: 'escalate_to_human', args: { reason: 'quiere hablar con alguien' } }],
        });

    it('familia que escala: la escuela recibe el push', async () => {
        escalarConElModelo();
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'quiero hablar con alguien' }));
        expect(h.sendToUser).toHaveBeenCalledTimes(1);
    });

    it('contacto que no se atiende: la conversación se escala pero no suena el celular', async () => {
        escalarConElModelo();
        // El turno pasa el filtro (p.ej. la clasificación cambió entre medio),
        // pero al escalar el contacto ya no es de los que se atienden.
        h.debeAtender
            .mockResolvedValueOnce({ atender: true, tipo: 'familia', botEncendido: true })
            .mockResolvedValueOnce({ atender: false, tipo: 'personal', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'quiero hablar con alguien' }));
        expect(h.sendToUser).not.toHaveBeenCalled();
    });
});

// ─── La puerta angosta del desconocido (opción «1C») ─────────────────────────
//
// Bot prendido, `responder_desconocidos=false`. Al desconocido se le contesta
// solo con correo, código con OTP vigente, o tema escolar una vez cada 30
// días. Las frases son inventadas con la forma de las reales de Dynasty.

describe('desconocido: correo, código vigente o tema escolar', () => {
    const DESCONOCIDO = { atender: false, tipo: 'desconocido', botEncendido: true } as const;

    /**
     * Base del desconocido: conversación sin identificar, bot prendido en modo
     * asistido. `qr` son los QR de inscripción que devuelve la consulta;
     * `yaContestado` simula una respuesta escolar dentro de los 30 días.
     */
    function baseDeDesconocido(op: {
        qr?: any[];
        yaContestado?: 'enviado' | 'borrador';
        otp?: Record<string, any> | null;
        /** ¿El correo existe en profiles? (wa_start_identification) */
        correoExiste?: boolean;
    } = {}) {
        h.state.resolve = (table, ops) => {
            const pideElFreno = ops.some(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step')
                && a[1] === 'desconocido_tema_escolar');
            if (table === 'whatsapp_messages' && pideElFreno) {
                return { count: op.yaContestado === 'enviado' ? 1 : 0, error: null };
            }
            if (table === 'whatsapp_message_drafts' && pideElFreno) {
                return { count: op.yaContestado === 'borrador' ? 1 : 0, error: null };
            }
            if (table === 'whatsapp_conversations') {
                return { data: { id: CONV, parent_id: null, identified: false, status: 'closed', contact_name: null }, error: null };
            }
            if (table === 'whatsapp_identifications') return { data: op.otp ?? null, error: null };
            if (table === 'school_join_qr_codes') return { data: op.qr ?? [], error: null };
            if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
            if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
            if (table === 'school_members') return { data: [], error: null };
            return { data: null, error: null };
        };
        h.state.rpc = (fn) => {
            if (fn === 'wa_start_identification') return { data: { ok: true, email_matches_parent: op.correoExiste ?? true }, error: null };
            if (fn === 'wa_verify_otp') return { data: { ok: false, reason: 'wrong_code', attempts_left: 4 }, error: null };
            return { data: null, error: null };
        };
        h.debeAtender.mockResolvedValue(DESCONOCIDO);
    }

    const QR_ABIERTO = { slug: 'escuela-inscripcion', target_type: 'open', signup_count: 121 };

    it('«Quiero inscribir a mi hija» → enlace de inscripción, sin modelo y sin push', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Quiero inscribir a mi hija a volleyball' }));

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.proposed_text).toContain('/join/escuela-inscripcion');
        expect(borradores()[0].row.tool_context).toMatchObject({
            step: 'desconocido_tema_escolar', intencion: 'inscripcion', con_enlace: true,
        });
        // Con enlace no hace falta molestar a nadie: el prospecto ya tiene a dónde ir.
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it('elige el QR abierto aunque haya uno de equipo o de plan antes', async () => {
        baseDeDesconocido({ qr: [
            { slug: 'solo-sub15', target_type: 'team', signup_count: 300 },
            { slug: 'plan-x', target_type: 'plan', signup_count: 200 },
            QR_ABIERTO,
        ] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({
            textBody: 'Me puedes compartir más información (Horarios, cursos, valor)',
        }));
        expect(borradores()[0].row.proposed_text).toContain('/join/escuela-inscripcion');
        expect(borradores()[0].row.proposed_text).not.toContain('solo-sub15');
    });

    it('prospecto y la escuela SIN enlace → buzón abierto y push «pregunta por inscripciones»', async () => {
        baseDeDesconocido({ qr: [{ slug: 'solo-sub15', target_type: 'team', signup_count: 3 }] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '¿Cómo es la inscripción?' }));

        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ intencion: 'inscripcion', con_enlace: false });
        expect(h.state.updates).toContainEqual(expect.objectContaining({
            table: 'whatsapp_conversations', row: expect.objectContaining({ status: 'open' }),
        }));
        expect(h.sendToUser).toHaveBeenCalledTimes(1);
        expect(h.sendToUser.mock.calls[0][1].title).toContain('inscripciones');
        // El push del prospecto NO le pregunta a `debeAtender` (diría que no).
        expect(h.debeAtender).toHaveBeenCalledTimes(1);
    });

    it('«envío comprobante de la mensualidad» → se presenta y pide el correo', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Buen día, envío comprobante de la mensualidad' }));

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        const { proposed_text, tool_context } = borradores()[0].row;
        expect(tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'pagos' });
        expect(proposed_text).toContain('asistente virtual');
        expect(proposed_text).toContain('correo electrónico');
        expect(proposed_text).toContain('celular distinto');
        expect(proposed_text).not.toContain('/join/');
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it.each(['enviado', 'borrador'] as const)(
        'freno de 30 días: ya hubo una respuesta escolar (%s) → silencio',
        async (yaContestado) => {
            baseDeDesconocido({ qr: [QR_ABIERTO], yaContestado });
            await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Quiero inscribir a mi hija' }));
            expect(borradores()).toHaveLength(0);
            expect(h.sendTextMessage).not.toHaveBeenCalled();
        },
    );

    it('el freno mira 30 días hacia atrás', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        const desdes: string[] = [];
        const resolver = h.state.resolve;
        h.state.resolve = (table, ops) => {
            // Solo la consulta del freno (la que filtra por step): antes corre la
            // lectura del flujo de clase de cortesía, con su propia ventana de 24 h.
            const esFreno = ops.some(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step'));
            if (table === 'whatsapp_messages' && esFreno) {
                const gte = ops.find(([m]) => m === 'gte');
                if (gte) desdes.push(gte[1][1]);
            }
            return resolver(table, ops);
        };
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Quiero inscribir a mi hija' }));
        const dias = (Date.now() - new Date(desdes[0]).getTime()) / 86_400_000;
        expect(dias).toBeGreaterThan(29.9);
        expect(dias).toBeLessThan(30.1);
    });

    it('correo que NO existe → lo dice claro una vez y pasa a la escuela, nunca «te envié un código» (…5281)', async () => {
        baseDeDesconocido({ correoExiste: false });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'mamá.prueba@example.com' }));

        expect(h.state.rpcCalls).toContain('wa_start_identification');
        expect(borradores()).toHaveLength(1);
        const { proposed_text, tool_context } = borradores()[0].row;
        expect(tool_context).toMatchObject({ step: 'correo_no_encontrado' });
        expect(proposed_text).toContain('No encuentro el correo');
        expect(proposed_text).toContain('a la escuela');
        expect(proposed_text).not.toContain('Te envié un código');
    });

    it('correo de un desconocido → arranca el OTP (la familia que escribe desde otro número)', async () => {
        baseDeDesconocido();
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'mi correo es acudiente.prueba@example.com' }));

        expect(h.state.rpcCalls).toContain('wa_start_identification');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'otp_sent' });
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('código de 6 dígitos SIN OTP vigente → silencio (ni siquiera se intenta verificar)', async () => {
        baseDeDesconocido({ otp: null });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '482913' }));

        expect(h.state.rpcCalls).not.toContain('wa_verify_otp');
        expect(borradores()).toHaveLength(0);
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('código con un OTP VENCIDO → silencio también', async () => {
        baseDeDesconocido({ otp: {
            otp_hash: 'h', verified_at: null, attempts: 0,
            otp_expires_at: new Date(Date.now() - 60_000).toISOString(),
        } });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '482913' }));
        expect(h.state.rpcCalls).not.toContain('wa_verify_otp');
        expect(borradores()).toHaveLength(0);
    });

    it('código con OTP vigente → se verifica', async () => {
        baseDeDesconocido({ otp: {
            otp_hash: 'h', verified_at: null, attempts: 1,
            otp_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        } });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '482913' }));

        expect(h.state.rpcCalls).toContain('wa_verify_otp');
        expect(borradores()).toHaveLength(1);
        expect(borradores()[0].row.tool_context).toMatchObject({ step: 'otp_failed', reason: 'wrong_code' });
    });

    it.each([
        'Donde andas para pagarte lo de la rifa?',
        'Yo voy a hacer plata',
        'Te mando para que desayunes algo ?',
        'hola, ¿cómo vas?',
    ])('charla personal de un desconocido «%s» → silencio', async (textBody) => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody }));
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(0);
        expect(h.sendToUser).not.toHaveBeenCalled();
    });

    it.each(['personal', 'staff'] as const)(
        '%s NUNCA responde, aunque diga «mensualidad» o mande un correo',
        async (tipo) => {
            baseDeDesconocido({ qr: [QR_ABIERTO] });
            h.debeAtender.mockResolvedValue({ atender: false, tipo, botEncendido: true });
            for (const textBody of [
                'envío comprobante de la mensualidad',
                'Quiero inscribir a mi hija',
                'acudiente.prueba@example.com',
            ]) {
                await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody }));
            }
            expect(borradores()).toHaveLength(0);
            expect(h.state.rpcCalls).not.toContain('wa_start_identification');
            expect(h.sendToUser).not.toHaveBeenCalled();
        },
    );

    it('desconocido con el bot APAGADO → silencio aunque pregunte por inscripción', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        h.debeAtender.mockResolvedValue({ atender: false, tipo: 'desconocido', botEncendido: false });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Quiero inscribir a mi hija' }));
        expect(borradores()).toHaveLength(0);
    });

    it('desconocido que pidió la baja → silencio', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'STOP inscripción' }), true);
        expect(borradores()).toHaveLength(0);
    });

    it('nota de voz de un desconocido → silencio (no hay texto que leer)', async () => {
        baseDeDesconocido({ qr: [QR_ABIERTO] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ type: 'audio', textBody: null }));
        expect(borradores()).toHaveLength(0);
    });
});
