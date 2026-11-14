/**
 * Ajustes del asistente por escuela enchufados al bot
 * (docs/specs/whatsapp-ajustes-por-escuela.md): con el ajuste APAGADO el turno
 * es el de siempre; con el de Besser, cortesía por semana, ayuda de la app y
 * reclamo de valor — todo sin modelo.
 *
 * Andamiaje copiado de whatsapp-clase-cortesia-bot.test.ts: Supabase con
 * builder encadenable, `debeAtender` y el envío mockeados. Ni base ni Meta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'update', 'is', 'not']) b[m] = chain(m);
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
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
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({
    avisarEscalamientoPorCorreo: vi.fn(async () => {}),
    destinatariosDeEscuela: vi.fn(async () => ({ escuela: 'Dynasty', correos: [] })),
    enviarConReserva: vi.fn(async () => 'enviado'),
}));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { runBotTurn } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const PADRE = 'parent-1';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const DESCONOCIDO = { atender: false, tipo: 'desconocido', botEncendido: true } as const;

const mensaje = (over: Record<string, any> = {}) => ({
    phoneNumberId: 'pn-1', contactWaId: '573209998877', contactName: null,
    waMessageId: 'wamid.1', type: 'text', textBody: 'hola', raw: {}, waTimestamp: null, ...over,
}) as any;

const BESSER = {
    wa_modo_cortesia: 'semana_app', wa_cortesia_qr_id: 'qr-cortesia', wa_cortesia_dias: 7,
    wa_ayuda_app: true, wa_reclamos_de_valor: true,
};
const QR_CORTESIA = {
    id: 'qr-cortesia', school_id: 'school-1', slug: 'besser-cortesia', active: true,
    expires_at: null, require_first_payment: false,
};
const QR_PAGADO = { slug: 'besser-inscripciones', target_type: 'open', signup_count: 17, created_at: '2026-09-18' };
const SITIO = 'Círculo de Suboficiales (Calle 138 # 55-38)';
const EQUIPOS = [
    { name: '2011 - ARRAYANES', schedule: [2, 3, 4, 5].map((day) => ({ day, time: '16:00', end: '18:00', place: SITIO })) },
    { name: 'INFANTIL FEMENINO', schedule: [2, 4].map((day) => ({ day, time: '16:00', end: '18:00', place: SITIO })) },
];
const COBROS = [{ concept: 'Mensualidad Octubre 2026 - Juan', amount: 380000, status: 'pending', due_date: '2026-10-10' }];
const PLANES = [
    { name: 'CORTESÍA', price: 0, is_active: true },
    { name: '2 DÍAS / SEMANA (FINES DE SEMANA)', price: 210000, is_active: true },
    { name: '4 DÍAS / SEMANA (PROFUNDIZACIÓN) ', price: 340000, is_active: true },
    { name: '6 DÍAS / SEMANA (ALTO RENDIMIENTO)', price: 380000, is_active: true },
];
const BESSER_CON_PRECIOS = { ...BESSER, wa_responder_precios: true };

const borradores = () => h.state.inserts.filter((i) => i.table === 'whatsapp_message_drafts');

function base(op: {
    ajustes?: Record<string, any> | null;
    qr?: Record<string, any> | null;
    identificado?: boolean;
    pasos?: string[];
} = {}) {
    const identificado = op.identificado ?? false;
    h.state.resolve = (table, ops) => {
        const pasoPedido = ops.find(([m, a]) => m === 'eq' && String(a[0]).endsWith('>>step'))?.[1]?.[1];
        if ((table === 'whatsapp_messages' || table === 'whatsapp_message_drafts') && pasoPedido) {
            return { count: op.pasos?.includes(pasoPedido) ? 1 : 0, error: null };
        }
        if (table === 'whatsapp_conversations') {
            return { data: { id: CONV, parent_id: identificado ? PADRE : null, identified: identificado,
                             status: 'closed', contact_name: null }, error: null };
        }
        if (table === 'whatsapp_optins') {
            return { data: { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null }, error: null };
        }
        if (table === 'school_settings') return { data: op.ajustes ?? null, error: null };
        if (table === 'school_join_qr_codes') {
            const porId = ops.some(([m, a]) => m === 'eq' && a[0] === 'id');
            if (porId) return { data: op.qr === undefined ? QR_CORTESIA : op.qr, error: null };
            return { data: [QR_PAGADO], error: null };
        }
        if (table === 'teams') return { data: EQUIPOS, error: null };
        if (table === 'payments') return { data: COBROS, error: null };
        if (table === 'offering_plans') return { data: PLANES, error: null };
        if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'assisted' }, error: null };
        if (table === 'schools') {
            return { data: { name: 'Club Deportivo Besser', owner_id: 'owner-1', slug: 'club-deportivo-besser' }, error: null };
        }
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'school_signup_leads') return { data: [], error: null };
        return { data: null, error: null };
    };
    h.state.rpc = (fn) => {
        if (fn === 'list_open_trial_slots_public') return { data: [], error: null };
        if (fn === 'wa_identify_by_phone') {
            return { data: identificado ? { estado: 'identificado', parent_id: PADRE } : { estado: 'desconocido' }, error: null };
        }
        return { data: null, error: null };
    };
    h.debeAtender.mockResolvedValue(identificado
        ? { atender: true, tipo: 'familia', botEncendido: true, tomada: false }
        : DESCONOCIDO);
    h.botEncendido.mockResolvedValue(true);
}

beforeEach(() => {
    vi.clearAllMocks();
    h.state.inserts = [];
    h.state.rpcCalls = [];
    h.chatWithTools.mockResolvedValue({ text: 'Respuesta del modelo', toolCalls: [], provider: 'test' });
});

describe('prospecto (número desconocido)', () => {
    it('Besser: «quiero inscribir a mi hijo» → paso a paso de la semana de cortesía con el enlace SIN cobro', async () => {
        base({ ajustes: BESSER });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero inscribir a mi hijo' }));

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(borradores()).toHaveLength(1);
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('asistente virtual');
        expect(b.proposed_text).toContain('*gratis durante una semana*');
        // La marca (?t=slug) depende de school_shows_own_brand; acá importa la ruta.
        expect(b.proposed_text).toContain('https://app.sportmaps.co/join/besser-cortesia');
        expect(b.proposed_text).not.toContain('besser-inscripciones');
        expect(b.proposed_text).toContain('• 2011 - ARRAYANES: martes a viernes');
        // Mismo step que el resto de respuestas al desconocido: cuenta para el freno de 30 días.
        expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'cortesia_semana' });
    });

    it('Besser: «¿tienen clase de cortesía?» → también la semana, no la clase suelta', async () => {
        base({ ajustes: BESSER });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Clase de cortesía tienen' }));
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('*gratis durante una semana*');
        expect(b.tool_context.flujo).toBeUndefined();
    });

    it('SIN el ajuste (resto de escuelas) → el enlace de siempre, igual que antes', async () => {
        base({ ajustes: null });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero inscribir a mi hijo' }));
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('/join/besser-inscripciones');
        expect(b.proposed_text).not.toContain('semana');
        expect(b.tool_context).toMatchObject({ intencion: 'inscripcion' });
    });

    it('el QR configurado COBRA al registrarse → se ignora el ajuste y responde como antes', async () => {
        base({ ajustes: BESSER, qr: { ...QR_CORTESIA, require_first_payment: true } });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero inscribir a mi hijo' }));
        const b = borradores()[0].row;
        expect(b.proposed_text).not.toContain('gratis durante');
        expect(b.proposed_text).toContain('/join/besser-inscripciones');
    });

    it('el QR configurado es de OTRA escuela → se ignora', async () => {
        base({ ajustes: BESSER, qr: { ...QR_CORTESIA, school_id: 'otra' } });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero inscribir a mi hijo' }));
        expect(borradores()[0].row.proposed_text).not.toContain('besser-cortesia');
    });

    it('freno de 30 días: la segunda vez no se repite', async () => {
        base({ ajustes: BESSER, pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'Hola, quiero inscribir a mi hijo' }));
        expect(borradores().every((d) => !String(d.row.proposed_text).includes('gratis durante'))).toBe(true);
    });

    it('Besser: «no puedo entrar a la app» → paso a paso de ingreso (antes: silencio)', async () => {
        base({ ajustes: BESSER });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'No puedo entrar a la app' }));
        expect(h.chatWithTools).not.toHaveBeenCalled();
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('https://app.sportmaps.co/login');
        expect(b.proposed_text).toContain('«Entrar ahora»');
        expect(b.proposed_text).toContain('Si todavía no tienes cuenta');
        expect(b.tool_context).toMatchObject({ step: 'ayuda_app_entrar' });
    });

    it('SIN el ajuste, «no puedo entrar a la app» sigue en silencio como antes', async () => {
        base({ ajustes: null });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'No puedo entrar a la app' }));
        expect(borradores()).toHaveLength(0);
    });
});

describe('prospecto pregunta el precio (wa_responder_precios)', () => {
    it.each(['¿Cuánto cuesta?', 'cuánto vale la mensualidad', 'Hola, info de precios por favor'])(
        'Besser: «%s» → los valores y la semana gratis, SIN enlace de pago', async (texto) => {
            base({ ajustes: BESSER_CON_PRECIOS });
            await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: texto }));
            expect(h.chatWithTools).not.toHaveBeenCalled();
            expect(borradores()).toHaveLength(1);
            const b = borradores()[0].row;
            expect(b.proposed_text).toContain('• 2 días por semana (fines de semana): *$210.000*');
            expect(b.proposed_text).toContain('• 6 días por semana (alto rendimiento): *$380.000*');
            expect(b.proposed_text).not.toContain('CORTESÍA');
            expect(b.proposed_text).toContain('*gratis durante una semana*');
            expect(b.proposed_text).toContain('/join/besser-cortesia');
            expect(b.proposed_text).not.toContain('besser-inscripciones');
            expect(b.tool_context).toMatchObject({ step: 'desconocido_tema_escolar', intencion: 'precios' });
        });

    it('SIN el ajuste: «¿cuánto cuesta?» suelto sigue sin respuesta, como antes', async () => {
        base({ ajustes: BESSER });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '¿Cuánto cuesta?' }));
        expect(borradores()).toHaveLength(0);
    });

    it('SIN el ajuste: «cuánto vale la mensualidad» recibe el enlace de inscripción, como antes', async () => {
        base({ ajustes: null });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: 'cuánto vale la mensualidad' }));
        const b = borradores()[0].row;
        expect(b.proposed_text).toContain('/join/besser-inscripciones');
        expect(b.tool_context).toMatchObject({ intencion: 'pagos_y_precio' });
    });

    it('freno de 30 días: si ya se le contestó, no repite la lista', async () => {
        base({ ajustes: BESSER_CON_PRECIOS, pasos: ['desconocido_tema_escolar'] });
        await handleBotTurn(req, INTEGRATION, CONV, mensaje({ textBody: '¿Cuánto cuesta?' }));
        expect(borradores().some((d) => String(d.row.proposed_text).includes('$210.000'))).toBe(false);
    });
});

describe('familia identificada', () => {
    it('Besser: «el valor no coincide» → cobros abiertos + pasa a una persona, sin modelo', async () => {
        base({ ajustes: BESSER, identificado: true });
        await runBotTurn(INTEGRATION, CONV, '573001112233', 'El valor de la mensualidad no coincide', 'wamid.1');

        expect(h.chatWithTools).not.toHaveBeenCalled();
        const b = borradores().at(-1)!.row;
        expect(b.proposed_text).toContain('Entiendo, revisemos ese valor');
        expect(b.proposed_text).toContain('• Mensualidad Octubre 2026 - Juan: *$380.000* (vence 10 oct)');
        expect(b.proposed_text).toContain('En breve te contactan.');
        expect(b.tool_context).toMatchObject({ step: 'escalated' });
        expect(b.tool_context.reason).toContain('Reclamo de valor');
        expect(b.tool_context.reason).toContain('$380.000');
    });

    it('SIN el ajuste, «el valor no coincide» va al modelo como siempre', async () => {
        base({ ajustes: null, identificado: true });
        await runBotTurn(INTEGRATION, CONV, '573001112233', 'El valor de la mensualidad no coincide', 'wamid.1');
        expect(h.chatWithTools).toHaveBeenCalled();
    });

    it('Besser: «olvidé mi contraseña» → paso a paso, sin modelo y sin la nota de cuenta nueva', async () => {
        base({ ajustes: BESSER, identificado: true });
        await runBotTurn(INTEGRATION, CONV, '573001112233', 'Olvidé mi contraseña', 'wamid.1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        const b = borradores().at(-1)!.row;
        expect(b.proposed_text).toContain('«Enviar instrucciones»');
        expect(b.proposed_text).not.toContain('Si todavía no tienes cuenta');
    });

    it('Besser: «cómo pago?» suelto NO es ayuda de app: sigue al modelo (medios de pago)', async () => {
        base({ ajustes: BESSER, identificado: true });
        await runBotTurn(INTEGRATION, CONV, '573001112233', 'Cómo pago?', 'wamid.1');
        expect(h.chatWithTools).toHaveBeenCalled();
    });

    it('Besser: un hermano para la cortesía → paso a paso de la semana', async () => {
        base({ ajustes: BESSER, identificado: true });
        await runBotTurn(INTEGRATION, CONV, '573001112233', '¿tienen clase de cortesía? es para el hermano', 'wamid.1');
        expect(h.chatWithTools).not.toHaveBeenCalled();
        const b = borradores().at(-1)!.row;
        expect(b.proposed_text).toContain('*gratis durante una semana*');
        expect(b.tool_context).toMatchObject({ step: 'cortesia_semana' });
    });
});

