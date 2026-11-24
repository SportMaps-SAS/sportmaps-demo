/**
 * Simulación del caso Carlos Clavijo (Monster, 2026-11-15): un número que el bot no atiende, con la conversación
 * tomada por la escuela, manda un comprobante de $175.000 a la cuenta de la escuela. Antes: la fila quedaba en la
 * bandeja y la persona NO recibía nada hasta que la escuela se lo pidió otra vez (4 días). Ahora, con la bandera de
 * la escuela encendida, recibe UN «Recibí tu comprobante…» y nunca un «aprobado».
 * Datos INVENTADOS con la forma del caso real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    atencion: { atender: false, tipo: 'desconocido', botEncendido: true, tomada: true } as any,
    claim: [] as any[],
    cuentas: ['3001112222'] as string[],
    /** ¿Ya salió un acuse de recibido en esta conversación en los últimos minutos? */
    acusePrevio: 0,
};

const updatesCola: any[] = [];
const rpcs: { name: string; args: any }[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, gte: () => chain,
        lte: () => chain, lt: () => chain, ilike: () => chain, limit: () => chain, order: () => chain, neq: () => chain, is: () => chain,
        insert: () => chain, upsert: () => chain,
        update: (v: any) => { if (table === 'whatsapp_inbound_queue') updatesCola.push(v); return chain; },
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
}

const FILA = (id: string, extra: Record<string, unknown> = {}) => ({
    id, integration_id: 'int-1', school_id: 'school-1', wa_phone_number: '573005550101',
    wa_message_id: `wamid.${id}`, media_id: `media-${id}`, media_mime_type: 'image/jpeg',
    storage_path: null, retries: 0, created_at: new Date().toISOString(), ...extra,
});

const rpcMock = vi.fn((name: string, args?: any) => {
    rpcs.push({ name, args });
    if (name === 'wa_queue_claim') return Promise.resolve({ data: state.claim, error: null });
    if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve({ data: { estado: 'desconocido' } });
    if (name === 'wa_identify_by_phone') return Promise.resolve({ data: { estado: 'desconocido' } });
    if (name === 'wa_crear_comprobante_por_clasificar') return Promise.resolve({ data: { ok: true, id: 'pc-1', ya_existia: false }, error: null });
    return Promise.resolve({ data: null, error: null });
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'school_whatsapp_integrations') {
                return makeChain({ data: { id: 'int-1', school_id: 'school-1', access_token: 'tok', phone_number_id: 'pn-1' } }, table);
            }
            if (table === 'whatsapp_conversations') return makeChain(state.conv, table);
            if (table === 'whatsapp_inbound_queue') return makeChain({ data: [], error: null, count: 0 }, table);
            if (table === 'whatsapp_messages') return makeChain({ data: [], error: null, count: state.acusePrevio }, table);
            return makeChain({ data: null, error: null }, table);
        }),
        rpc: (...args: any[]) => (rpcMock as any)(...args),
        storage: {
            from: () => ({
                download: vi.fn(() => Promise.resolve({ data: new Blob(['fake']), error: null })),
                upload: vi.fn(() => Promise.resolve({ data: {}, error: null })),
            }),
        },
    },
}));

const sendTextMessageMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, waMessageId: 'wamid.out' }));
const sendInteractiveButtonsMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, waMessageId: 'wamid.btn' }));
const downloadMediaMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, base64: 'ZmFrZQ==', mimeType: 'image/jpeg' }));
vi.mock('../services/whatsapp.service', () => ({
    downloadMedia: (...a: any[]) => downloadMediaMock(...a),
    sendTextMessage: (...a: any[]) => sendTextMessageMock(...a),
    sendInteractiveButtons: (...a: any[]) => sendInteractiveButtonsMock(...a),
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('../services/whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(() => Promise.resolve(false)),
    AVISO_DADO_DE_BAJA: '',
}));
vi.mock('../services/whatsapp-atencion.service', () => ({
    debeAtender: vi.fn(() => Promise.resolve(state.atencion)),
}));
vi.mock('../services/whatsapp-invitacion-vigente.service', () => ({
    invitacionPendienteVigente: vi.fn(() => Promise.resolve({ invitacion: { invite_id: 'inv-1' }, atletaInactivo: false })),
}));
vi.mock('../services/whatsapp-bot.service', () => ({
    abrirConsultaParaLaEscuela: vi.fn(() => Promise.resolve()),
    acusarAdjunto: vi.fn(() => Promise.resolve('acusado')),
    conPresentacionSiEsPrimera: vi.fn(async (_w: any, _c: string, t: string) => t),
    anexoDeConsentimiento: vi.fn(async () => null),
}));

const extractReceiptMock = vi.fn();
vi.mock('../services/ocr.service', () => ({ extractReceipt: (...a: any[]) => extractReceiptMock(...a) }));
vi.mock('../services/enrollment-ocr.service', () => ({ extractEnrollmentForm: vi.fn() }));
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: vi.fn(() => Promise.resolve({ registeredAccounts: state.cuentas, restrictedAccounts: [] })),
}));
vi.mock('../services/receipt-verdict', () => ({
    normalizeDestination: (d: any) => d,
    normalizeReference: (r: any) => r,
    destinationMatchesRegistered: (d: any, a: any[]) => a.includes(d),
    evaluateVerdict: vi.fn(() => ({ verdict: 'YELLOW', reasons: [] })),
}));
vi.mock('../services/receipt-approval.service', () => ({
    evaluatePaymentReceipt: vi.fn(() => Promise.resolve({ action: 'manual_review' })),
    redRejectionMessage: vi.fn(() => ''),
}));
vi.mock('../services/whatsapp-venta-servicios.service', () => ({
    ventaAbiertaDeContacto: vi.fn(() => Promise.resolve(null)),
    decidirComprobanteDeVenta: vi.fn(() => ({ tipo: 'seguir' })),
}));
vi.mock('../services/wa-concepto-esperado.service', async () => {
    const real = await vi.importActual<any>('../services/wa-concepto-esperado.service');
    return { ...real, conceptosEsperadosDe: vi.fn(() => Promise.resolve([])) };
});
vi.mock('../services/whatsapp-receipt-matching.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-receipt-matching.service');
    return { ...real, pagosPendientesDe: vi.fn(() => Promise.resolve([])) };
});
vi.mock('../services/whatsapp-comprobante-de-ficha.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-de-ficha.service');
    return {
        ...real,
        fichasPorTelefono: vi.fn(() => Promise.resolve({ childIds: [], unregisteredIds: [] })),
        deportistaPorNombre: vi.fn(() => Promise.resolve(null)),
        deportistaPorNombreSinVerificar: vi.fn(() => Promise.resolve({ exacta: null, parecida: null })),
        pendientesPorLlaves: vi.fn(() => Promise.resolve([])),
        pagoYaRegistrado: vi.fn(() => Promise.resolve(null)),
    };
});

const { runWhatsAppQueue } = await import('./whatsapp-queue.job');

const comprobante = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: 'REF-EJEMPLO-9', bank: 'Nequi', date: '2026-11-15', provider: 'gemini',
    originName: 'Persona Ejemplo', description: null, ...extra,
});
const enviados = () => sendTextMessageMock.mock.calls.map((c) => c[2] as string);
const cierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');
const acuseGrabado = () => rpcs.find((r) => r.name === 'wa_record_outbound_message' && r.args?.p_payload?.step === 'acuse_recibo_comprobante');

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    rpcs.length = 0;
    delete process.env.WA_ACUSE_RECIBO_SCHOOL_IDS;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true, tomada: true };
    state.claim = [FILA('f1')];
    state.cuentas = ['3001112222'];
    state.acusePrevio = 0;
    extractReceiptMock.mockResolvedValue(comprobante(175000));
});
afterEach(() => { delete process.env.WA_ACUSE_RECIBO_SCHOOL_IDS; });

describe('caso Carlos: la escuela tomó el chat y llega un comprobante de $175.000', () => {
    it('con la bandera encendida: queda en la bandeja Y la persona recibe UN «recibido», sin «aprobado»', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'school-1';
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toBe('Recibí tu comprobante 📄 La escuela lo revisa y te confirma por aquí.');
        expect(enviados()[0]).not.toMatch(/aprob|valid|cupo confirmado/i);
        expect(acuseGrabado()).toBeDefined();
    });

    it('con la bandera apagada: todo igual que antes (bandeja, sin mensaje)', async () => {
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(enviados()).toHaveLength(0);
    });

    it('bandera encendida en OTRA escuela: no escribe', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'otra-escuela';
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
    });

    it('si ya salió un acuse hace poco (ráfaga), no manda otro', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'school-1';
        state.acusePrevio = 1;
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(enviados()).toHaveLength(0);
    });

    it('un contacto marcado como personal/negocio no recibe acuse (manda plata por otras razones)', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'school-1';
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
    });

    it('el archivo llegó hace más de 24 h: Meta no deja texto libre, no se intenta', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'school-1';
        state.claim = [FILA('f1', { created_at: new Date(Date.now() - 26 * 3600_000).toISOString() })];
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
    });

    it('lo que no es un comprobante (afiche, foto) no recibe acuse', async () => {
        process.env.WA_ACUSE_RECIBO_SCHOOL_IDS = 'school-1';
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: 90000, destination: null, provider: 'gemini' });
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
    });
});
