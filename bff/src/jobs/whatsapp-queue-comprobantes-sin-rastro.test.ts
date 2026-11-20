/**
 * Invariante I-1 (docs/specs/whatsapp-confiabilidad-invariantes-2026-11-16.md): ningún comprobante con monto legible
 * se cierra sin dejar un rastro visible a la escuela. Auditoría de producción de Monster's (9 días): 70 filas
 * `contacto_no_atendido`, 2 `pregunta_vencida` («aplicarlo a mano», nunca aplicadas) y ráfagas «sin ficha» omitidas
 * sin leer. Datos y nombres INVENTADOS con la forma de los casos reales.
 *
 *  1. captura con monto a la cuenta de la escuela, de un contacto que el bot no atiende → bandeja, con el archivo
 *  2. ráfaga de imágenes de un número sin ficha con un pago esperado / datos de pago enviados → se lee, no se omite
 *  3. pregunta vencida con monto → «Por clasificar» (y no solo «aplicarlo a mano»)
 *  4. lo que NO es un comprobante (afiche, foto, chat) sigue sin ruido
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    atencion: { atender: false, tipo: 'desconocido', botEncendido: true } as any,
    claim: [] as any[],
    textos: [] as any[],
    cuentas: ['3001112222'] as string[],
    previas: 0,
    /** ¿El bot le mandó datos de pago a este número? (mensaje saliente con un paso de `PASOS_CON_DATOS_DE_PAGO`). */
    datosDePago: false,
    esperados: [] as any[],
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
            if (table === 'whatsapp_inbound_queue') return makeChain({ data: [], error: null, count: state.previas }, table);
            if (table === 'whatsapp_messages') {
                const result: any = { data: [], error: null };
                const chain = makeChain(result, table);
                let saliente = false;
                chain.eq = (col: string, val: any) => {
                    if (col === 'direction' && val === 'outbound') saliente = true;
                    if (col === 'direction' && val === 'inbound') result.data = state.textos;
                    return chain;
                };
                chain.in = (col: string) => {
                    if (saliente && col === 'payload->>step' && state.datosDePago) result.data = [{ id: 'm-datos' }];
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
    return { ...real, conceptosEsperadosDe: vi.fn(() => Promise.resolve(state.esperados)) };
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

const { runWhatsAppQueue, vencerPreguntasSinRespuesta, MOTIVO_OCR_OMITIDO_RAFAGA } = await import('./whatsapp-queue.job');
const { supabase } = await import('../config/supabase');

const comprobante = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: 'REF-EJEMPLO-9', bank: 'Nequi', date: '2026-11-18', provider: 'gemini',
    originName: 'Persona Ejemplo', description: null, ...extra,
});
/** La pantalla «¡Transferencia exitosa!» recortada: monto y destino, sin fecha ni número de comprobante. */
const captura = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: null, bank: null, date: null, provider: 'gemini', originName: null, description: null, ...extra,
});
const enviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const cierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    rpcs.length = 0;
    delete process.env.WA_POR_CLASIFICAR_ESCUELAS;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
    state.claim = [FILA('f1')];
    state.textos = [];
    state.cuentas = ['3001112222'];
    state.previas = 0;
    state.datosDePago = false;
    state.esperados = [];
    extractReceiptMock.mockResolvedValue(captura(350000));
});

// ─── 1. Contacto que el bot no atiende: la captura con monto no se pierde ───────────────────────────────────

describe('I-1 · contacto que el bot no atiende con una captura de plata', () => {
    it('contacto marcado «negocio»: captura de $350.000 a la cuenta de la escuela, sin fecha ni referencia → bandeja con el archivo, sin responderle', async () => {
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^sin_familia: contacto_no_atendido \(negocio\): captura de \$350\.000 a una cuenta de la escuela, sin fecha ni número de comprobante/);
        expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: 350000 }, sha: expect.any(String) });
    });

    it('con «Por clasificar» activo en la escuela, ese cierre queda registrado en Cobros (no solo en la bandeja)', async () => {
        process.env.WA_POR_CLASIFICAR_ESCUELAS = 'school-1';
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        await runWhatsAppQueue();
        const r = rpcs.find((x) => x.name === 'wa_crear_comprobante_por_clasificar');
        expect(r).toBeDefined();
        expect(r!.args).toMatchObject({ p_school_id: 'school-1', p_queue_id: 'f1', p_monto: 350000, p_etiqueta: 'por_identificar' });
    });

    it('el mismo contacto marcado mandando plata a una cuenta que NO es de la escuela: silencio (son sus cosas)', async () => {
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        extractReceiptMock.mockResolvedValue(comprobante(250000, { destination: '3119998888' }));
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido' });
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
    });

    it('un afiche o una foto (no es comprobante, aunque el OCR lea un precio): sin ruido', async () => {
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: 90000, destination: null, provider: 'gemini' });
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido' });
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
        expect(rpcs.some((x) => x.name === 'wa_crear_comprobante_por_clasificar')).toBe(false);
    });

    it('un número desconocido (sin ficha, sin hablar de pagos) con un comprobante completo y el destino sin leer: a la bandeja', async () => {
        state.cuentas = [];
        extractReceiptMock.mockResolvedValue(comprobante(175000, { destination: null }));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(cierre().error_message).toMatch(/^sin_familia: captura_sin_contexto — comprobante de \$175\.000 a un destino sin confirmar/);
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
    });
});

// ─── 2. Ráfaga de un contacto sin ficha: no se omite si se espera un pago ───────────────────────────────────

describe('I-1 · ráfaga de imágenes de un número sin ficha', () => {
    const rafaga = () => { state.previas = 5; state.claim = [FILA('f1')]; };

    it('sin ninguna señal de pago: sigue omitida sin leer (el tope existe por costo)', async () => {
        rafaga();
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: null, destination: null });
        await runWhatsAppQueue();
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(cierre()).toMatchObject({ status: 'ignored', error_message: MOTIVO_OCR_OMITIDO_RAFAGA });
    });

    it('con un concepto ESPERADO vivo (el bot le pidió un pago): se lee y la captura con monto va a la bandeja', async () => {
        rafaga();
        state.esperados = [{ id: 'e1', schoolId: 'school-1', telefono: '573005550101', motivo: 'clinica', monto: 350000, leadId: null, childId: null, origen: 'bot', venceEn: new Date(Date.now() + 3600_000).toISOString(), createdAt: null }];
        await runWhatsAppQueue();
        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
        expect(updatesCola.some((u) => u.error_message === MOTIVO_OCR_OMITIDO_RAFAGA)).toBe(false);
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
        expect(cierre()).toMatchObject({ status: 'ignored' });
        expect(cierre().error_message).not.toBe('contacto_no_atendido');
    });

    it('con datos de pago ENVIADOS a ese teléfono (últimos días): tampoco se omite', async () => {
        rafaga();
        state.datosDePago = true;
        await runWhatsAppQueue();
        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
        expect(updatesCola.some((u) => u.error_message === MOTIVO_OCR_OMITIDO_RAFAGA)).toBe(false);
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        // (El mock devuelve el saliente para cualquier lista de pasos; lo que importa: leída, guardada y escalada.)
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
    });

    it('contacto marcado con una ráfaga: la omisión por costo se mantiene', async () => {
        rafaga();
        state.atencion = { atender: false, tipo: 'negocio', botEncendido: true };
        await runWhatsAppQueue();
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(cierre()).toMatchObject({ status: 'ignored', error_message: 'contacto_no_atendido' });
    });
});

// ─── 3. Pregunta vencida con monto → «Por clasificar» ────────────────────────────────────────────────────────

describe('I-1 · pregunta vencida con monto', () => {
    const filaVencida = (extra: Record<string, unknown> = {}) => ({
        id: 'q-venc', school_id: 'school-1', integration_id: 'int-1', wa_phone_number: '573005550101',
        storage_path: 'school-1/2026/11/venc.jpg', media_caption: null, error_message: null,
        pregunta_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:00:01Z', en_fila: null, tipo: null,
        ocr: comprobante(175000), guardado: null, ...extra,
    });

    async function vencer(fila: any) {
        const updates: any[] = [];
        const tabla = (t: string) => {
            const o: any = { op: 'select', vals: null };
            const c: any = {
                select: () => c, eq: () => c, in: () => c, lt: () => c, gte: () => c, limit: () => c,
                update: (v: any) => { o.op = 'update'; o.vals = v; updates.push(v); return c; },
                maybeSingle: () => Promise.resolve({ data: t === 'whatsapp_conversations' ? { id: 'conv-1' } : null, error: null }),
                then: (ok: any, ko: any) => {
                    let r: any = { data: [], error: null };
                    if (t === 'whatsapp_inbound_queue') r = o.op === 'update' ? { data: [{ id: fila.id }] } : { data: [fila], error: null };
                    return Promise.resolve(r).then(ok, ko);
                },
            };
            return c;
        };
        const prev = (supabase.from as any).getMockImplementation();
        (supabase.from as any).mockImplementation(tabla);
        try {
            const n = await vencerPreguntasSinRespuesta(undefined, Date.parse('2026-11-19T12:00:00Z'));
            return { n, updates };
        } finally {
            (supabase.from as any).mockImplementation(prev);
        }
    }

    it('caso real (nombres inventados): la familia no dijo a qué cobro va y había $175.000 leídos → bandeja Y «Por clasificar»', async () => {
        process.env.WA_POR_CLASIFICAR_ESCUELAS = 'school-1';
        const { n, updates } = await vencer(filaVencida());
        expect(n).toBe(1);
        expect(updates[0]).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(updates[0].error_message).toMatch(/^pregunta_vencida: /);
        const r = rpcs.find((x) => x.name === 'wa_crear_comprobante_por_clasificar');
        expect(r).toBeDefined();
        expect(r!.args).toMatchObject({
            p_school_id: 'school-1', p_queue_id: 'q-venc', p_monto: 175000, p_etiqueta: 'otro',
            p_storage_path: 'school-1/2026/11/venc.jpg', p_referencia: 'REF-EJEMPLO-9',
        });
    });

    it('sin monto leído no hay nada que clasificar: solo el buzón, como siempre', async () => {
        process.env.WA_POR_CLASIFICAR_ESCUELAS = 'school-1';
        const { n } = await vencer(filaVencida({ ocr: comprobante(0, { amount: null }) }));
        expect(n).toBe(1);
        expect(rpcs.some((x) => x.name === 'wa_crear_comprobante_por_clasificar')).toBe(false);
    });

    it('una escuela que no usa «Por clasificar» sigue con el buzón (la fila queda escalada, visible)', async () => {
        const { n, updates } = await vencer(filaVencida());
        expect(n).toBe(1);
        expect(updates[0]).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(rpcs.some((x) => x.name === 'wa_crear_comprobante_por_clasificar')).toBe(false);
    });

    it('una fila que la escuela ya cerró («Por clasificar» o resuelta) no se vuelve a registrar', async () => {
        process.env.WA_POR_CLASIFICAR_ESCUELAS = 'school-1';
        await vencer(filaVencida({ error_message: 'cerrado_escuela: resuelto_auto — pasó a «Por clasificar» en Cobros | pregunta_vencida: x' }));
        expect(rpcs.some((x) => x.name === 'wa_crear_comprobante_por_clasificar')).toBe(false);
    });
});

// ─── La regla pura ──────────────────────────────────────────────────────────────────────────────────────────

describe('imagenConPlataSinRastro (pura)', async () => {
    const { imagenConPlataSinRastro } = await import('../services/wa-cola-reglas');
    const base = { monto: 350000, completo: false, destino: 'general' as const, esperaPago: false };

    it.each([
        ['captura a la cuenta de la escuela', { ...base }, true],
        ['comprobante completo a la cuenta de la escuela', { ...base, completo: true }, true],
        ['sin monto', { ...base, monto: null }, false],
        ['no es comprobante', { ...base, isReceipt: false }, false],
        ['listado de movimientos', { ...base, isTransactionList: true }, false],
        ['cuenta ajena', { ...base, destino: 'ajena' as const }, false],
        ['cuenta restringida', { ...base, destino: 'restringida' as const }, false],
        ['por fuera de SportMaps', { ...base, destino: 'fuera_de_sportmaps' as const }, false],
        ['destino sin leer + comprobante completo', { ...base, destino: null, completo: true }, true],
        ['destino sin leer + captura sin pago esperado', { ...base, destino: null }, false],
        ['destino sin leer + captura de quien debe un pago', { ...base, destino: null, esperaPago: true }, true],
        ['destino sin leer + contacto marcado', { ...base, destino: null, completo: true, contactoMarcado: true }, false],
    ])('%s → %s', (_n, e, esperado) => expect(imagenConPlataSinRastro(e as any)).toBe(esperado));
});
