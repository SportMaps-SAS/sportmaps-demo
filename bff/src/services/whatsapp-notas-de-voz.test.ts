/**
 * Notas de voz F1 (spec docs/specs/whatsapp-notas-de-voz.md) y la presentación
 * del asistente en la primera respuesta de cada conversación.
 *
 * Deterministas: Supabase mockeado con estado (las filas de whatsapp_messages
 * se actualizan de verdad, para que el turno vea la transcripción), `fetch`
 * mockeado para Groq/OpenAI (el `transcripcion.service` corre REAL), la
 * descarga del medio y el envío mockeados.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    type Ops = [string, any[]][];
    const state = {
        filas: [] as any[],
        settings: { ai_enabled: true, mode: 'auto', transcribir_audios: true } as Record<string, any>,
        optin: { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null } as any,
        salientesBot: 0,
        updates: [] as { table: string; row: any; ops: Ops }[],
        inserts: [] as { table: string; row: any }[],
    };
    const tieneOp = (ops: Ops, n: string) => ops.some(([m]) => m === n);
    const eqDe = (ops: Ops, col: string) => ops.find(([m, a]) => m === 'eq' && a[0] === col)?.[1][1];
    function resolver(table: string, ops: Ops): any {
        const head = ops.some(([m, a]) => m === 'select' && a[1]?.head);
        if (table === 'whatsapp_messages') {
            if (tieneOp(ops, 'update')) {
                const row = ops.find(([m]) => m === 'update')![1][0];
                const id = eqDe(ops, 'wa_message_id');
                for (const f of state.filas) if (f.wa_message_id === id) Object.assign(f, row);
                return { data: null, error: null };
            }
            if (head) return { count: state.salientesBot, error: null };
            return { data: state.filas.map((f) => ({ ...f })), error: null };
        }
        if (table === 'whatsapp_message_drafts') return head ? { count: 0, error: null } : { data: null, error: null };
        if (table === 'whatsapp_settings') return { data: state.settings, error: null };
        if (table === 'whatsapp_optins') return { data: state.optin, error: null };
        if (table === 'whatsapp_conversations') {
            return { data: { id: 'conv-1', parent_id: 'parent-1', identified: true, status: 'closed', contact_name: 'Mamá' }, error: null };
        }
        if (table === 'schools') return { data: { name: 'Dynasty', owner_id: 'owner-1' }, error: null };
        if (table === 'school_members') return { data: [], error: null };
        if (table === 'profiles') return { data: [{ full_name: 'Milena Rojas' }], error: null };
        return { data: null, error: null };
    }
    function makeBuilder(table: string) {
        const ops: Ops = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'lte', 'or', 'order', 'limit', 'is', 'not']) {
            b[m] = (...args: any[]) => { ops.push([m, args]); return b; };
        }
        b.insert = (row: any) => { state.inserts.push({ table, row }); ops.push(['insert', [row]]); return b; };
        b.update = (row: any) => { state.updates.push({ table, row, ops }); ops.push(['update', [row]]); return b; };
        b.maybeSingle = () => Promise.resolve(resolver(table, ops));
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve(resolver(table, ops)).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: {
            from: (t: string) => makeBuilder(t),
            rpc: (fn: string) => Promise.resolve(fn === 'wa_identify_by_phone'
                ? { data: { estado: 'identificado', parent_id: 'parent-1' }, error: null }
                : { data: null, error: null }),
        },
        debeAtender: vi.fn(),
        chatWithTools: vi.fn(),
        sendTextMessage: vi.fn(),
        downloadMedia: vi.fn(),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, debeAtender: h.debeAtender, botEncendido: vi.fn(async () => true) };
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
    downloadMedia: h.downloadMedia,
    AUDIO_MIME_PERMITIDOS: new Set(['audio/ogg']),
    AUDIO_MAX_BYTES: 16 * 1024 * 1024,
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-horario.service', () => ({
    estadoDeHorario: vi.fn(async () => ({ fueraDeHorario: false })),
    mensajeDeEscalamiento: vi.fn(() => 'En breve te contactan.'),
}));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-medios-de-pago.service', () => ({ mediosDePago: vi.fn() }));
vi.mock('./whatsapp-info-escuela.service', () => ({ infoDeEscuela: vi.fn(), fallbackInfoEscuela: vi.fn() }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({ resolverRespuestaDeCobro: vi.fn(async () => false) }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./avisos-correo.service', () => ({ avisarEscalamientoPorCorreo: vi.fn(async () => {}) }));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-coexistence.service', () => ({
    procesarEchos: vi.fn(), procesarHistorial: vi.fn(), registrarAppState: vi.fn(),
}));

import { handleBotTurn } from '../routes/whatsapp';
import { deliver, _olvidarPresentaciones } from './whatsapp-bot.service';
import { transcribirAudio, GROQ_STT_URL, OPENAI_STT_URL } from './transcripcion.service';
import { TEXTO_NO_PUEDO_ESCUCHAR } from './whatsapp-notas-de-voz.service';
import { esRuidoDeTranscripcion, ecoDeAudios } from './whatsapp-reglas-turno';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const CONV = 'conv-1';
const req = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as any;
const TRANSCRITO = 'Hola, quería saber cuánto debo de la mensualidad de octubre';
const PRESENTACION = 'Hola 👋 soy Mapi, el asistente virtual de Dynasty.';

const audio = () => ({
    phoneNumberId: 'pn-1', contactWaId: '573001112233', contactName: 'Mamá',
    waMessageId: 'wamid.audio', type: 'audio', textBody: null, raw: { id: 'wamid.audio', type: 'audio' },
    waTimestamp: new Date().toISOString(), mediaId: 'media-1', mediaMimeType: 'audio/ogg; codecs=opus',
    mediaCaption: null,
}) as any;

const respuestaGroq = (over: Record<string, any> = {}) => ({
    text: TRANSCRITO, duration: 6.2, language: 'es',
    segments: [{ start: 0, end: 6.2, no_speech_prob: 0.01, avg_logprob: -0.15 }],
    ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
function proveedores(groq: () => any, openai: () => any = () => ({ ok: true, json: async () => ({ text: TRANSCRITO }) })) {
    fetchMock = vi.fn(async (url: string) => {
        if (url === GROQ_STT_URL) return groq();
        if (url === OPENAI_STT_URL) return openai();
        throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
}
const groqOk = (over: Record<string, any> = {}) => () => ({ ok: true, json: async () => respuestaGroq(over) });

const enviados = () => h.sendTextMessage.mock.calls.map((c) => String(c[2]));
const filaAudio = () => h.state.filas.find((f) => f.wa_message_id === 'wamid.audio');

beforeEach(() => {
    vi.clearAllMocks();
    _olvidarPresentaciones();
    process.env.GROQ_API_KEY = 'gsk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.DISABLE_TRANSCRIPCION;
    h.state.settings = { ai_enabled: true, mode: 'auto', transcribir_audios: true };
    h.state.optin = { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: null };
    h.state.salientesBot = 1;   // por defecto la conversación ya tuvo respuestas del bot
    h.state.updates = [];
    h.state.inserts = [];
    const ahora = new Date().toISOString();
    h.state.filas = [{
        wa_message_id: 'wamid.audio', direction: 'inbound', type: 'audio', text_body: null,
        payload: { id: 'wamid.audio', type: 'audio' }, ai_generated: null, wa_timestamp: ahora, created_at: ahora,
    }];
    h.debeAtender.mockResolvedValue({ atender: true, tipo: 'familia', botEncendido: true });
    h.chatWithTools.mockResolvedValue({ text: 'Tienes pendiente la mensualidad de octubre por $150.000.', toolCalls: [], provider: 'test' });
    h.sendTextMessage.mockResolvedValue({ ok: true, waMessageId: 'wamid.out' });
    h.downloadMedia.mockResolvedValue({ ok: true, buffer: Buffer.alloc(12_000, 1), mimeType: 'audio/ogg', sizeBytes: 12_000 });
    proveedores(groqOk());
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('notas de voz: cuándo se transcriben', () => {
    it('flag APAGADO: comportamiento anterior, sin bajar el audio ni llamar al proveedor', async () => {
        h.state.settings = { ai_enabled: true, mode: 'auto', transcribir_audios: false };
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.downloadMedia).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual([TEXTO_NO_PUEDO_ESCUCHAR]);
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('familia con consentimiento y flag: transcribe, guarda texto + metadatos y responde con el eco', async () => {
        await handleBotTurn(req, INTEGRATION, CONV, audio());

        expect(h.downloadMedia).toHaveBeenCalledWith(INTEGRATION, 'media-1', expect.objectContaining({ maxBytes: 16 * 1024 * 1024 }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(GROQ_STT_URL);
        const form = fetchMock.mock.calls[0][1].body as FormData;
        expect(form.get('model')).toBe('whisper-large-v3');
        expect(form.get('language')).toBe('es');
        expect(form.get('response_format')).toBe('verbose_json');

        // Guardado en el entrante: texto limpio + payload.transcripcion.
        const fila = filaAudio();
        expect(fila.text_body).toBe(TRANSCRITO);
        expect(fila.payload.type).toBe('audio');   // conserva el payload del webhook
        expect(fila.payload.transcripcion).toMatchObject({ proveedor: 'groq', duracion: 6.2, al_bot: true });
        expect(fila.payload.transcripcion.confianza).toBeGreaterThan(0.8);

        // El turno normal recibió el texto transcrito.
        expect(h.chatWithTools).toHaveBeenCalledTimes(1);
        const mensajes = h.chatWithTools.mock.calls[0][0].messages ?? h.chatWithTools.mock.calls[0][0];
        expect(JSON.stringify(mensajes)).toContain('cuánto debo de la mensualidad');

        // La respuesta empieza con el eco.
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0].startsWith(`🎤 Entendí: «${TRANSCRITO}»`)).toBe(true);
        expect(enviados()[0]).toContain('$150.000');
    });

    it('familia SIN consentimiento: no se transcribe, «No puedo escuchar»', async () => {
        h.state.optin = null;
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.downloadMedia).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual([TEXTO_NO_PUEDO_ESCUCHAR]);
    });

    it('consentimiento revocado (baja posterior al sí): no se transcribe', async () => {
        h.state.optin = { opted_in_at: '2026-09-01T00:00:00Z', opted_out_at: '2026-09-10T00:00:00Z' };
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.downloadMedia).not.toHaveBeenCalled();
    });

    it('audio de más de 120 s: transcrito para el buzón, NO pasa al bot', async () => {
        proveedores(groqOk({ duration: 185, segments: [{ start: 0, end: 185, no_speech_prob: 0.01, avg_logprob: -0.2 }] }));
        await handleBotTurn(req, INTEGRATION, CONV, audio());

        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(filaAudio().text_body).toBe(TRANSCRITO);
        expect(filaAudio().payload.transcripcion).toMatchObject({ al_bot: false, motivo: 'audio_largo', duracion: 185 });
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('Como es largo, se lo paso a *Dynasty*');
        expect(h.state.updates.some((u) => u.table === 'whatsapp_conversations' && u.row.status === 'open')).toBe(true);
    });

    it('ruido: «¿me lo escribes?», sin modelo y sin texto guardado', async () => {
        proveedores(groqOk({ text: 'Subtítulos realizados por la comunidad de Amara.org', segments: [{ start: 0, end: 3, no_speech_prob: 0.9, avg_logprob: -1.2 }] }));
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(filaAudio().text_body).toBeNull();
        expect(enviados()[0]).toContain('No te entendí bien el audio');
    });

    it('Groq falla → respaldo OpenAI (gpt-4o-mini-transcribe)', async () => {
        proveedores(() => ({ ok: false, status: 503, text: async () => 'over capacity' }));
        await handleBotTurn(req, INTEGRATION, CONV, audio());

        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([GROQ_STT_URL, OPENAI_STT_URL]);
        expect((fetchMock.mock.calls[1][1].body as FormData).get('model')).toBe('gpt-4o-mini-transcribe');
        expect(filaAudio().payload.transcripcion).toMatchObject({ proveedor: 'openai', al_bot: true, duracion_estimada: true });
        expect(filaAudio().payload.transcripcion.intentos_fallidos[0]).toMatchObject({ proveedor: 'groq' });
        expect(h.chatWithTools).toHaveBeenCalledTimes(1);
        expect(enviados()[0].startsWith('🎤 Entendí:')).toBe(true);
    });

    it('los dos proveedores caídos: aviso honesto y al buzón, sin modelo', async () => {
        proveedores(() => ({ ok: false, status: 500, text: async () => 'x' }), () => ({ ok: false, status: 500, text: async () => 'y' }));
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(filaAudio().payload.transcripcion.error).toContain('groq');
        expect(enviados()[0]).toContain('No logré escuchar tu nota de voz');
    });

    it.each([
        ['desconocido con «responder desconocidos» prendido', { atender: true, tipo: 'desconocido', botEncendido: true }],
        ['desconocido', { atender: false, tipo: 'desconocido', botEncendido: true }],
        ['staff', { atender: false, tipo: 'staff', botEncendido: true }],
        ['personal', { atender: false, tipo: 'personal', botEncendido: true }],
    ])('%s: NUNCA se baja ni se transcribe el audio', async (_n, decision) => {
        h.debeAtender.mockResolvedValue(decision);
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.downloadMedia).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(filaAudio().text_body).toBeNull();
        expect(h.chatWithTools).not.toHaveBeenCalled();
    });

    it('2026-10-08: desconocido SIN intención escolar previa (responder desconocidos prendido) → no se le responde nada', async () => {
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'desconocido', botEncendido: true });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.sendTextMessage).not.toHaveBeenCalled();
        expect(h.downloadMedia).not.toHaveBeenCalled();
    });

    it('2026-10-08: desconocido que se presentó como entrenadora de otro club → tampoco', async () => {
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'desconocido', botEncendido: true });
        const antes = new Date(Date.now() - 20 * 60_000).toISOString();
        h.state.filas.push({ wa_message_id: 'wamid.t1', direction: 'inbound', type: 'text',
            text_body: 'Hola, hablas con Paula entrenadora del club Albatros, ¿pueden venir a un amistoso de categorías infantiles?',
            payload: {}, ai_generated: null, wa_timestamp: antes, created_at: antes });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('2026-10-08: desconocido que antes pidió inscribir (prospecto) sí recibe respuesta al audio', async () => {
        h.debeAtender.mockResolvedValue({ atender: true, tipo: 'desconocido', botEncendido: true });
        const antes = new Date(Date.now() - 20 * 60_000).toISOString();
        h.state.filas.push({ wa_message_id: 'wamid.t1', direction: 'inbound', type: 'text',
            text_body: 'Buenas, quiero inscribir a mi hija en voleibol', payload: {}, ai_generated: null,
            wa_timestamp: antes, created_at: antes });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('P4: la escuela escribió hace 5 min → se transcribe para el buzón, el bot calla', async () => {
        const hace5 = new Date(Date.now() - 5 * 60_000).toISOString();
        h.state.filas.push({ wa_message_id: 'wamid.mile', direction: 'outbound', type: 'text', text_body: 'Hola mamá',
            payload: {}, ai_generated: false, wa_timestamp: hace5, created_at: hace5 });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(filaAudio().text_body).toBe(TRANSCRITO);
        expect(filaAudio().payload.transcripcion.al_bot).toBe(false);
        expect(h.chatWithTools).not.toHaveBeenCalled();
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('P4 sin flag: tampoco se contesta «no puedo escuchar»', async () => {
        h.state.settings = { ai_enabled: true, mode: 'auto', transcribir_audios: false };
        const hace5 = new Date(Date.now() - 5 * 60_000).toISOString();
        h.state.filas.push({ wa_message_id: 'wamid.mile', direction: 'outbound', type: 'text', text_body: 'Hola',
            payload: {}, ai_generated: false, wa_timestamp: hace5, created_at: hace5 });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });

    it('P9 sin flag: «Mile, …» en la ráfaga → silencio (el mensaje ya quedó para ella)', async () => {
        h.state.settings = { ai_enabled: true, mode: 'auto', transcribir_audios: false };
        const hace = new Date(Date.now() - 20_000).toISOString();
        h.state.filas.push({ wa_message_id: 'wamid.txt', direction: 'inbound', type: 'text', text_body: 'Mile, buenos días',
            payload: {}, ai_generated: null, wa_timestamp: hace, created_at: hace });
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        expect(h.sendTextMessage).not.toHaveBeenCalled();
    });
});

describe('presentación del asistente: la primera respuesta automática, una sola vez', () => {
    it('primera respuesta de la conversación: empieza presentándose; la segunda no', async () => {
        h.state.salientesBot = 0;
        await deliver(INTEGRATION, CONV, '573001112233', '¡Hola! Estás al día ✅', { step: 'x' });
        await deliver(INTEGRATION, CONV, '573001112233', 'Los medios de pago son…', { step: 'y' });
        const [primero, segundo] = enviados();
        expect(primero).toBe(`${PRESENTACION}\n\nEstás al día ✅`);
        expect(segundo).toBe('Los medios de pago son…');
    });

    it('la conversación ya tuvo respuestas del bot: no se presenta', async () => {
        h.state.salientesBot = 3;
        await deliver(INTEGRATION, CONV, '573001112233', 'Estás al día ✅', { step: 'x' });
        expect(enviados()[0]).toBe('Estás al día ✅');
    });

    it('si el texto ya se presenta solo, no se duplica', async () => {
        h.state.salientesBot = 0;
        await deliver(INTEGRATION, CONV, '573001112233', 'Hola 👋 Soy el *asistente automático* de *Dynasty*. 🤖', { step: 'x' });
        await deliver(INTEGRATION, CONV, '573001112233', 'Otra cosa', { step: 'y' });
        expect(enviados()).toEqual(['Hola 👋 Soy el *asistente automático* de *Dynasty*. 🤖', 'Otra cosa']);
    });

    it('primera respuesta a una nota de voz: presentación, luego el eco, luego la respuesta', async () => {
        h.state.salientesBot = 0;
        await handleBotTurn(req, INTEGRATION, CONV, audio());
        const t = enviados()[0];
        expect(t.startsWith(`${PRESENTACION}\n\n🎤 Entendí: «`)).toBe(true);
        expect(t.indexOf('🎤')).toBeLessThan(t.indexOf('$150.000'));
    });
});

describe('transcripcion.service', () => {
    it('sin llaves: devuelve el motivo sin llamar a nadie', async () => {
        delete process.env.GROQ_API_KEY;
        delete process.env.OPENAI_API_KEY;
        const r = await transcribirAudio(Buffer.from('x'), 'audio/ogg');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.motivo).toMatch(/GROQ_API_KEY/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('kill-switch DISABLE_TRANSCRIPCION', async () => {
        process.env.DISABLE_TRANSCRIPCION = 'true';
        const r = await transcribirAudio(Buffer.from('x'), 'audio/ogg');
        expect(r).toMatchObject({ ok: false, motivo: 'deshabilitada' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sin GROQ_API_KEY va directo a OpenAI', async () => {
        delete process.env.GROQ_API_KEY;
        const r = await transcribirAudio(Buffer.alloc(4_000, 1), 'audio/ogg; codecs=opus');
        expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([OPENAI_STT_URL]);
        expect(r).toMatchObject({ ok: true, proveedor: 'openai', duracionS: 2, duracionEstimada: true });
    });
});

describe('reglas puras de notas de voz', () => {
    it('ruido', () => {
        expect(esRuidoDeTranscripcion('', 0)).toBe(true);
        expect(esRuidoDeTranscripcion('Gracias por ver el video', 0.1)).toBe(true);
        expect(esRuidoDeTranscripcion('quiero saber cuánto debo', 0.7)).toBe(true);
        expect(esRuidoDeTranscripcion('Sí', 0.05)).toBe(false);
        expect(esRuidoDeTranscripcion('quiero saber cuánto debo', 0.05)).toBe(false);
    });

    it('eco: solo audios transcritos para el bot, recortado', () => {
        const ahora = Date.now();
        const t = new Date(ahora - 10_000).toISOString();
        const filas = [
            { wa_message_id: 'a', direction: 'inbound', type: 'audio', text_body: 'x'.repeat(200),
                payload: { transcripcion: { al_bot: true } }, wa_timestamp: t },
            { wa_message_id: 'b', direction: 'inbound', type: 'audio', text_body: 'largo',
                payload: { transcripcion: { al_bot: false } }, wa_timestamp: t },
        ];
        const eco = ecoDeAudios(filas, 'a', ahora)!;
        expect(eco.startsWith('🎤 Entendí: «')).toBe(true);
        expect(eco.endsWith('…»')).toBe(true);
        expect(eco).not.toContain('largo');
        expect(ecoDeAudios([filas[1]], 'b', ahora)).toBeNull();
    });
});
