/**
 * Comprobantes por WhatsApp con pagos únicos (2026-10-10): el alta deja
 * mensualidad + inscripción + seguro pendientes el mismo día. Mismo andamiaje
 * que whatsapp-queue-comprobante-de-ficha.test.ts; datos inventados.
 *
 *  - $515.000 (los tres) → no se estampa en uno: lo reparte la escuela.
 *  - pie «seguro» + $35.000 → el seguro.
 *  - $300.000 → la inscripción (el monto la elige).
 *  - monto que no desempata → botones con «Inscrip.» / «Seguro», no tres «Oct».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    rpcIdentifyByPhone: { data: { estado: 'identificado', parent_id: 'parent-1' } as any },
    atencion: { atender: true, tipo: 'familia', botEncendido: true } as any,
    claim: [] as any[],
    textos: [] as any[],
    /** ¿Ya salió la pregunta del deportista en las últimas 24 h? */
    yaPreguntado: false,
    /** Cuentas generales de la escuela (destino del comprobante). */
    cuentas: ['3001112222'] as string[],
    /** Cuentas «por fuera de SportMaps» (2026-10-13). */
    fuera: [] as string[],
    /** Pago de la familia con la misma imagen (dedup por hash). */
    mismaImagen: null as any,
    filaEsperando: null as any,
};

const updatesCola: any[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, gte: () => chain,
        lte: () => chain, ilike: () => chain, limit: () => chain, order: () => chain, neq: () => chain, is: () => chain,
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

const rpcMock = vi.fn((name: string) => {
    if (name === 'wa_queue_claim') return Promise.resolve({ data: state.claim, error: null });
    if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve({ data: { estado: 'desconocido' } });
    if (name === 'wa_identify_by_phone') return Promise.resolve(state.rpcIdentifyByPhone);
    return Promise.resolve({ data: null, error: null });
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'school_whatsapp_integrations') {
                return makeChain({ data: { id: 'int-1', school_id: 'school-1', access_token: 'tok', phone_number_id: 'pn-1' } }, table);
            }
            if (table === 'whatsapp_conversations') return makeChain(state.conv, table);
            if (table === 'payments') return makeChain({ data: state.mismaImagen ? [state.mismaImagen] : [], error: null }, table);
            if (table === 'whatsapp_inbound_queue') {
                const chain = makeChain({ data: [], error: null }, table);
                const update = chain.update;
                chain.update = (v: any) => {
                    update(v);
                    // aplicarComprobanteDeFicha toma la fila que esperaba.
                    if (v.status === 'processing' && state.filaEsperando) {
                        chain.select = () => Promise.resolve({ data: [state.filaEsperando], error: null });
                    }
                    return chain;
                };
                return chain;
            }
            if (table === 'whatsapp_messages') {
                const result: any = { data: [], error: null };
                const chain = makeChain(result, table);
                let saliente = false;
                chain.eq = (col: string, val: any) => {
                    if (col === 'direction' && val === 'outbound') saliente = true;
                    if (col === 'direction' && val === 'inbound') result.data = state.textos;
                    if (saliente && col === 'payload->>step' && val === 'ask_deportista' && state.yaPreguntado) result.data = [{ id: 'm-prev' }];
                    return chain;
                };
                return chain;
            }
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
    buildVerdictContext: vi.fn(() => Promise.resolve({
        registeredAccounts: state.cuentas, restrictedAccounts: [], cuentasFueraDeSportmaps: state.fuera,
    })),
}));
vi.mock('../services/receipt-verdict', () => ({
    normalizeDestination: (d: any) => d,
    normalizeReference: (r: any) => r,
    destinationMatchesRegistered: (d: any, a: any[]) => a.includes(d),
    evaluateVerdict: vi.fn(() => ({ verdict: 'YELLOW', reasons: [] })),
}));
const evaluatePaymentReceiptMock = vi.fn((..._a: any[]) => Promise.resolve({ action: 'manual_review' }));
vi.mock('../services/receipt-approval.service', () => ({
    evaluatePaymentReceipt: (...a: any[]) => evaluatePaymentReceiptMock(...a),
    redRejectionMessage: vi.fn(() => ''),
}));
vi.mock('../services/whatsapp-venta-servicios.service', () => ({
    ventaAbiertaDeContacto: vi.fn(() => Promise.resolve(null)),
    decidirComprobanteDeVenta: vi.fn(() => ({ tipo: 'seguir' })),
}));

const pagosPendientesDeMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
vi.mock('../services/whatsapp-receipt-matching.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-receipt-matching.service');
    return { ...real, pagosPendientesDe: (...a: any[]) => pagosPendientesDeMock(...a) };
});

const fichasPorTelefonoMock = vi.fn((..._a: any[]) => Promise.resolve({ childIds: [] as string[], unregisteredIds: [] as string[] }));
const deportistaPorNombreMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
const pendientesPorLlavesMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
const pagoYaRegistradoMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
vi.mock('../services/whatsapp-comprobante-de-ficha.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-de-ficha.service');
    return {
        ...real,
        fichasPorTelefono: (...a: any[]) => fichasPorTelefonoMock(...a),
        deportistaPorNombre: (...a: any[]) => deportistaPorNombreMock(...a),
        pendientesPorLlaves: (...a: any[]) => pendientesPorLlavesMock(...a),
        pagoYaRegistrado: (...a: any[]) => pagoYaRegistradoMock(...a),
    };
});

const { runWhatsAppQueue, aplicarComprobanteDeFicha } = await import('./whatsapp-queue.job');

const comprobante = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: 'REF-EJEMPLO-1', bank: 'Nequi', date: '2026-10-06', provider: 'gemini',
    originName: 'Pedro Gómez', description: null, ...extra,
});
const SEP = { id: 'p-sep', amount: 150000, concept: 'Mensualidad 09/2026', due_date: '2026-09-10', child_id: 'c1', atleta: 'Laura Peña' };
const OCT = { id: 'p-oct', amount: 150000, concept: 'Mensualidad 10/2026', due_date: '2026-10-10', child_id: 'c1', atleta: 'Laura Peña' };

const enviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const cierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-1' } };
    state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    state.claim = [FILA('f1')];
    state.textos = [];
    state.yaPreguntado = false;
    state.cuentas = ['3001112222'];
    state.fuera = [];
    state.mismaImagen = null;
    state.filaEsperando = null;
    extractReceiptMock.mockResolvedValue(comprobante(150000));
    fichasPorTelefonoMock.mockResolvedValue({ childIds: [], unregisteredIds: [] });
    deportistaPorNombreMock.mockResolvedValue(null);
    pendientesPorLlavesMock.mockResolvedValue([]);
    pagoYaRegistradoMock.mockResolvedValue(null);
    pagosPendientesDeMock.mockResolvedValue([]);
});

const MEN = { id: 'p-men', amount: 180000, concept: 'Plan PGX — Mensualidad completa, vence día 10 — Atleta Uno', due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'mensualidad' };
const INS = { id: 'p-ins', amount: 300000, concept: 'Inscripción — PLAN RM MENSUAL — Atleta Uno', due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'inscripcion' };
const SEG = { id: 'p-seg', amount: 35000, concept: 'Seguro de accidentes — PLAN RM MENSUAL — Atleta Uno', due_date: '2026-10-10', child_id: 'c1', atleta: 'Atleta Uno', categoria: 'seguro' };

describe('pagos únicos del alta', () => {
    beforeEach(() => { pagosPendientesDeMock.mockResolvedValue([MEN, INS, SEG]); });

    it('$515.000 cubre los tres → se aplica a los tres (2026-10-13): el principal lleva el comprobante, los demás quedan cubiertos', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(515000));
        await runWhatsAppQueue();
        // Se evalúa solo el principal (el más antiguo; aquí vencen el mismo día: el primero).
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledTimes(1);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-men', undefined);
        expect(rpcMock).toHaveBeenCalledWith('wa_cubrir_cobros_con_comprobante', {
            p_school_id: 'school-1', p_principal_id: 'p-men', p_cobros: ['p-ins', 'p-seg'],
        });
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeUndefined();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('Inscripción — PLAN RM MENSUAL');
        expect(enviados()[0]).toContain('Seguro de accidentes');
        expect(enviados()[0]).not.toMatch(/sí\*? para aplicarlo/);
        expect(cierre()).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-men' });
    });

    it('pie «inscripción» y $515.000 → igual: los tres (no «otro concepto sin cobro»)', async () => {
        state.claim = [FILA('f1', { media_caption: 'inscripción' })];
        extractReceiptMock.mockResolvedValue(comprobante(515000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-men', undefined);
        expect(rpcMock).toHaveBeenCalledWith('wa_cubrir_cobros_con_comprobante', expect.objectContaining({ p_principal_id: 'p-men' }));
        expect(cierre()).toMatchObject({ status: 'done', result_type: 'payment_receipt' });
    });

    it('pie «seguro» + $35.000 → se aplica al seguro', async () => {
        state.claim = [FILA('f1', { media_caption: 'seguro' })];
        extractReceiptMock.mockResolvedValue(comprobante(35000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-seg', undefined);
        expect(enviados()[0]).toContain('Listo: comprobante de *$35.000* de *Atleta* para *seguro de accidentes*');
        // Lo que queda se nombra: la mensualidad y la inscripción siguen vivas.
        expect(enviados()[0]).toContain('Te quedan pendientes');
        expect(cierre()).toMatchObject({ status: 'done', result_ref_id: 'p-seg' });
    });

    it('pie «inscripción» + $300.000 → la inscripción aunque el plan se llame MENSUAL', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago inscripción' })];
        extractReceiptMock.mockResolvedValue(comprobante(300000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-ins', undefined);
    });

    it('sin pie, $300.000 → el monto elige la inscripción', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(300000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-ins', undefined);
    });

    it('monto que no desempata → botones que dicen qué es cada cobro', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(100000));
        await runWhatsAppQueue();
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Oct $180.000', '2. Inscrip. $300.000', '3. Seguro $35.000']);
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeTruthy();
    });
});

describe('excedente y cuentas por fuera de SportMaps (2026-10-13)', () => {
    it('pagó de más que la mensualidad → se aplica y se le dice que lo de más queda como saldo a favor', async () => {
        pagosPendientesDeMock.mockResolvedValue([MEN]);
        extractReceiptMock.mockResolvedValue(comprobante(200000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-men', undefined);
        expect(enviados()[0]).toContain('Listo: comprobante de *$200.000* de *Atleta* para *octubre*');
        expect(enviados()[0]).toContain('$20.000 de más');
        expect(enviados()[0]).toContain('saldo a favor');
        // (R9, auditoría 1–16 nov 2026) Antes `done`: $197.000 leídos contra una mensualidad de $180.000 figuraban
        // resueltos y nadie los revisó. El comprobante sigue aplicado al mismo cobro; la fila queda `ignored` +
        // `payment_receipt` para que la bandeja la muestre en ACCIÓN con los dos valores.
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'payment_receipt', result_ref_id: 'p-men' });
        expect(cierre().error_message).toMatch(/^monto_distinto_aplicado: comprobante de \$200\.000 aplicado a .*, que vale \$180\.000 \(\$20\.000 de más\)/);
    });

    it('pagó de menos y la escuela no recibe abonos → como antes, a la escuela con huellas para la bandeja', async () => {
        pagosPendientesDeMock.mockResolvedValue([MEN]);
        extractReceiptMock.mockResolvedValue(comprobante(100000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(cierre().error_message).toMatch(/^monto_no_cuadra/);
        expect(cierre().pregunta_ocr).toMatchObject({ ocr: { amount: 100000, reference: 'REF-EJEMPLO-1' } });
        expect(cierre().pregunta_ocr.sha).toBeTruthy();
    });

    it('a la cuenta «por fuera de SportMaps» → informativo, no «destino ajeno»', async () => {
        pagosPendientesDeMock.mockResolvedValue([MEN]);
        state.fuera = ['3009998888'];
        extractReceiptMock.mockResolvedValue(comprobante(180000, { destination: '3009998888' }));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(enviados()[0]).toContain('por fuera de la app');
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'pago por fuera de SportMaps' });
    });
});
