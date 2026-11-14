/**
 * «Pago esperado», deportista + mes y torneos en el worker (spec
 * whatsapp-conversacion-v2-dynasty §3.3, §3.5, §3.6, 2026-10-24). Datos
 * inventados con la forma de los casos reales de Dynasty:
 *
 *  C. un comprobante NUNCA se ignora por el tipo de contacto: los 3 pagos sin
 *     ficha ($360.000, $160.000, $90.000) y la transferencia a cuenta ajena
 *     ($1.249.334);
 *  A. monto MENOR a la cuota = abono en revisión (nunca cambia el plan, nunca se
 *     aprueba solo);
 *  B. deportista con botones, mes, concepto;
 *  D. torneos: quién pagó visible, degrada sin catálogo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    rpcIdentifyByPhone: { data: { estado: 'identificado', parent_id: 'parent-1' } as any },
    atencion: { atender: true, tipo: 'familia', botEncendido: true } as any,
    claim: [] as any[],
    textos: [] as any[],
    cuentas: ['3001112222'] as string[],
    children: [] as any[],
    enrollments: [] as any[],
    torneos: [] as any[],
};

const updatesCola: any[] = [];
const updatesPagos: any[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, gte: () => chain,
        lte: () => chain, ilike: () => chain, limit: () => chain, order: () => chain, neq: () => chain, is: () => chain,
        insert: () => chain, upsert: () => chain,
        update: (v: any) => {
            if (table === 'whatsapp_inbound_queue') updatesCola.push(v);
            if (table === 'payments') updatesPagos.push(v);
            return chain;
        },
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
            if (table === 'children') return makeChain({ data: state.children, error: null }, table);
            if (table === 'enrollments') return makeChain({ data: state.enrollments, error: null }, table);
            if (table === 'school_tournament_items') return makeChain({ data: state.torneos, error: null }, table);
            if (table === 'whatsapp_messages') {
                const result: any = { data: [], error: null };
                const chain = makeChain(result, table);
                chain.eq = (col: string, val: any) => {
                    if (col === 'direction' && val === 'inbound') result.data = state.textos;
                    return chain;
                };
                return chain;
            }
            return makeChain({ data: [], error: null }, table);
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

const { runWhatsAppQueue } = await import('./whatsapp-queue.job');

const comprobante = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: 'REF-EJEMPLO-1', bank: 'Nequi', date: '2026-10-06', provider: 'gemini',
    originName: 'Pedro Gómez', description: null, ...extra,
});
const LAURA = { id: 'c1', full_name: 'Laura Peña' };
const OCT = { id: 'p-oct', amount: 180000, concept: 'Mensualidad 10/2026', due_date: '2026-10-10', child_id: 'c1', atleta: 'Laura Peña' };
const INSCRIPCION_LAURA = { child_id: 'c1', unregistered_athlete_id: null, monthly_fee: 180000, fee_is_manual: false, status: 'active', plan: { name: 'PRO', price: 150000, registration_fee: null }, team: null };

const enviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const cierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    updatesPagos.length = 0;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-1' } };
    state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    state.claim = [FILA('f1')];
    state.textos = [];
    state.cuentas = ['3001112222'];
    state.children = [];
    state.enrollments = [];
    state.torneos = [];
    extractReceiptMock.mockResolvedValue(comprobante(150000));
    fichasPorTelefonoMock.mockResolvedValue({ childIds: [], unregisteredIds: [] });
    deportistaPorNombreMock.mockResolvedValue(null);
    pendientesPorLlavesMock.mockResolvedValue([]);
    pagoYaRegistradoMock.mockResolvedValue(null);
    pagosPendientesDeMock.mockResolvedValue([]);
});

// ─── C. Un comprobante nunca se ignora por el tipo de contacto ──────────────

describe('C. contacto que el bot no atiende con un comprobante a la cuenta de la escuela', () => {
    for (const monto of [360000, 160000, 90000]) {
        it(`$${monto.toLocaleString('es-CO')} de un número sin ficha (contacto personal) → se GUARDA y va a la bandeja, sin responderle a nadie`, async () => {
            state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
            extractReceiptMock.mockResolvedValue(comprobante(monto));
            await runWhatsAppQueue();
            expect(enviados()).toHaveLength(0);
            expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
            const c = cierre();
            expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
            expect(c.error_message).toMatch(new RegExp(`^sin_familia: contacto_no_atendido \\(personal\\): comprobante de \\$\\s?${String(monto).replace(/(\d)(?=(\d{3})+$)/g, '$1\\.')}`));
            expect(c.error_message).toContain('pagó: Pedro Gómez');
            expect(c.error_message).toContain('deportista: sin identificar');
            expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: monto, reference: 'REF-EJEMPLO-1' }, sha: expect.any(String) });
        });
    }

    it('número desconocido con la conversación TOMADA por una persona: también va a la bandeja', async () => {
        state.atencion = { atender: true, tipo: 'desconocido', botEncendido: true, tomada: true };
        extractReceiptMock.mockResolvedValue(comprobante(360000));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(cierre().error_message).toContain('contacto_no_atendido (desconocido)');
    });

    it('lo que NO es un comprobante sigue en silencio (sin guardar)', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: null, provider: 'gemini' });
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido' });
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
    });

    it('un contacto personal que manda plata a una cuenta que NO es de la escuela: silencio (son sus cosas)', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        extractReceiptMock.mockResolvedValue(comprobante(1249334, { destination: '3119998888' }));
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido' });
    });

    it('el OCR caído NO descarta el pago: la fila se reintenta (antes se cerraba como contacto_no_atendido)', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        extractReceiptMock.mockRejectedValue(new Error('503'));
        await runWhatsAppQueue();
        const u = [...updatesCola].reverse().find((x) => x.status === 'pending');
        expect(u).toMatchObject({ status: 'pending', retries: 1 });
        expect(u.error_message).toContain('OCR no disponible');
        expect(cierre()?.status).not.toBe('ignored');
    });

    it('«por fuera de SportMaps»: informativo, no «contacto no atendido»', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        const { buildVerdictContext } = await import('../services/receipt-context.service');
        (buildVerdictContext as any).mockResolvedValueOnce({ registeredAccounts: ['3001112222'], restrictedAccounts: [], cuentasFueraDeSportmaps: ['3009998888'] });
        extractReceiptMock.mockResolvedValue(comprobante(80000, { destination: '3009998888' }));
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'pago por fuera de SportMaps' });
    });
});

describe('C. transferencia a cuenta ajena de un número sin ficha', () => {
    it('$1.249.334 a otra persona → destino_ajeno en la bandeja (no se ignora), sin responderle', async () => {
        state.atencion = { atender: true, tipo: 'desconocido', botEncendido: true };
        extractReceiptMock.mockResolvedValue(comprobante(1249334, { destination: '3119998888' }));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^recuperado: destino_ajeno — el dinero fue a 3119998888, que no es una cuenta de la escuela/);
        expect(c.error_message).toContain('pagó: Pedro Gómez');
        expect(c.pregunta_ocr.ocr.amount).toBe(1249334);
    });
});

// ─── A. Abono: monto MENOR a la cuota ───────────────────────────────────────

describe('A. monto menor a la cuota → abono en revisión (el plan NO se cambia, no se aprueba solo)', () => {
    beforeEach(() => {
        state.children = [LAURA];
        state.enrollments = [INSCRIPCION_LAURA];
        pagosPendientesDeMock.mockResolvedValue([OCT]);
    });

    it('$150.000 de una cuota de $180.000: queda en revisión como abono, NO pasa por evaluatePaymentReceipt', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(150000));
        await runWhatsAppQueue();
        // Estampado en el cobro, en revisión, con quién pagó.
        expect(updatesPagos[0]).toMatchObject({ status: 'awaiting_approval', ocr_amount: 150000, ocr_origin_name: 'Pedro Gómez' });
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('Listo: abono de *$150.000* de *Laura* para *octubre*. La escuela lo confirma.');
        expect(enviados()[0]).toMatch(/Quedan \*\$\s?30\.000\*/);
        const c = cierre();
        expect(c).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-oct' });
        expect(c.error_message).toMatch(/^abono_en_revision: Propuesta → deportista: Laura Peña/);
        expect(c.error_message).toContain('el plan NO se cambia');
    });

    it('aunque $130.000 sea el precio de otro plan: abono, nunca «cambiar de plan»', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(130000));
        await runWhatsAppQueue();
        expect(cierre().error_message).toContain('abono');
        expect(cierre().error_message).not.toMatch(/cambia(r)? de plan/i);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
    });

    it('el monto exacto sigue el camino de siempre (evaluatePaymentReceipt: el ajuste de la escuela decide), y el pago queda con quién pagó', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(180000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-oct', undefined);
        expect(updatesPagos[0]).toMatchObject({ ocr_origin_name: 'Pedro Gómez' });
        expect(enviados()[0]).toBe('Listo: comprobante de *$180.000* de *Laura* para *octubre*. La escuela lo confirma.');
    });

    it('menos del 20 % de la cuota: no es abono; se pregunta el concepto [Mensualidad][Inscripción][Otro]', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(20000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Mensualidad', '2. Inscripción', '3. Otro']);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'concepto' });
        expect(espera.pregunta_ocr.guia.deportista).toMatchObject({ id: 'c1', nombre: 'Laura Peña' });
        expect(espera.pregunta_ocr.guia.propuesta).toContain('Propuesta →');
    });

    it('si dice «saldo» no se le pregunta el concepto: a la escuela con el resumen y la propuesta', async () => {
        state.claim = [FILA('f1', { media_caption: 'envío el saldo $20.000' })];
        extractReceiptMock.mockResolvedValue(comprobante(20000));
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^monto_no_cuadra: /);
        expect(c.error_message).toContain('Propuesta →');
    });
});

// ─── B. Deportista y mes con botones ────────────────────────────────────────

describe('B. deportista con botones', () => {
    it('número sin ficha cuyo nombre se parece a DOS deportistas → la pregunta ESCRITA, nunca botones con nombres (privacidad, Monster 2026-11-05)', async () => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
        state.children = [{ id: 'c1', full_name: 'Sofía Pérez Gómez' }, { id: 'c2', full_name: 'Sofía Ramírez Ortiz' }, { id: 'c3', full_name: 'Laura Peña' }];
        state.claim = [FILA('f1', { media_caption: 'pago de Sofia' })];
        extractReceiptMock.mockResolvedValue(comprobante(150000, { originName: null }));
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual(['Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.']);
        for (const t of enviados()) expect(t).not.toMatch(/sof[ií]a|p[eé]rez|ram[ií]rez/i);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'deportista' });
        expect(espera.pregunta_ocr.guia).toBeUndefined();
    });

    it('sin ningún parecido → la pregunta de siempre, para escribir el nombre', async () => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
        state.children = [{ id: 'c3', full_name: 'Laura Peña' }];
        state.claim = [FILA('f1', { media_caption: 'pago de Zoe' })];
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(enviados()[0]).toContain('¿De qué deportista es este pago?');
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr.guia).toBeUndefined();
    });

    it('familia con DOS hijos y ningún cobro pendiente → primero de cuál hijo (botones), después el mes', async () => {
        state.children = [LAURA, { id: 'c2', full_name: 'Tomás Peña' }];
        pagosPendientesDeMock.mockResolvedValue([]);
        await runWhatsAppQueue();
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Laura Peña', '2. Tomás Peña']);
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr).toMatchObject({ tipo: 'deportista' });
    });

    it('familia con UN hijo y ningún cobro pendiente → el mes (últimos 3 + «Otro mes»), nunca «no tienes cobros»', async () => {
        state.children = [LAURA];
        pagosPendientesDeMock.mockResolvedValue([]);
        await runWhatsAppQueue();
        expect(enviados()[0]).toContain('de *Laura*');
        expect(enviados()[0]).toContain('¿De qué mes es?');
        expect(enviados()[0]).not.toContain('no tienes cobros');
        expect((sendInteractiveButtonsMock.mock.calls[0][3] as any[])).toHaveLength(4);
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr).toMatchObject({ tipo: 'mes' });
    });

    it('con la conversación tomada por una persona NO se pregunta: sigue como antes (sin dejar la fila esperando)', async () => {
        state.atencion = { atender: true, tipo: 'familia', botEncendido: true, tomada: true };
        state.children = [LAURA];
        await runWhatsAppQueue();
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeUndefined();
        expect(cierre()).toMatchObject({ status: 'ignored' });
    });
});

// ─── D. Torneos ─────────────────────────────────────────────────────────────

describe('D. torneos: quién pagó visible', () => {
    beforeEach(() => {
        state.children = [LAURA];
        pagosPendientesDeMock.mockResolvedValue([OCT]);
        state.claim = [FILA('f1', { media_caption: 'pago torneo interclubes' })];
        extractReceiptMock.mockResolvedValue(comprobante(80000, { originName: 'Carolina Gómez' }));
    });

    it('catálogo VACÍO (Dynasty hoy): otro_concepto: torneo, con quién pagó, y degrada a «registrar a mano»', async () => {
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message.startsWith('otro_concepto: torneo')).toBe(true);
        expect(c.error_message).toContain('pagó: Carolina Gómez');
        expect(c.error_message).toContain('deportista: Laura Peña');
        expect(c.error_message).toContain('no tiene torneos cargados');
    });

    it('con catálogo: el torneo propuesto por nombre y monto', async () => {
        state.torneos = [{ id: 'i1', name: 'Torneo Interclubes Dynasty', price: 80000, per_athlete: true, allow_installments: true, event_id: null, active: true }];
        await runWhatsAppQueue();
        const c = cierre();
        expect(c.error_message.startsWith('otro_concepto: torneo')).toBe(true);
        expect(c.error_message).toContain('torneo: Torneo Interclubes Dynasty ($80.000 por deportista); el monto coincide');
        expect(c.error_message).toContain('pagó: Carolina Gómez');
    });

    it('monto menor al ítem con cuotas permitidas: abono propuesto', async () => {
        state.torneos = [{ id: 'i1', name: 'Torneo Interclubes Dynasty', price: 80000, per_athlete: true, allow_installments: true, event_id: null, active: true }];
        extractReceiptMock.mockResolvedValue(comprobante(30000, { originName: 'Carolina Gómez' }));
        await runWhatsAppQueue();
        expect(cierre().error_message).toMatch(/abono de \$\s?30\.000 \(saldo \$\s?50\.000\)/);
    });

    it('un cobro de torneo YA creado por ese monto: se aplica a ese (payment_category torneo) y queda con quién pagó', async () => {
        const TORNEO = { id: 'p-torneo', amount: 80000, concept: 'Torneo Interclubes — Laura Peña', due_date: '2026-10-20', child_id: 'c1', atleta: 'Laura Peña', categoria: 'torneo' };
        pagosPendientesDeMock.mockResolvedValue([OCT, TORNEO]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-torneo', undefined);
        expect(updatesPagos[0]).toMatchObject({ ocr_origin_name: 'Carolina Gómez', status: 'awaiting_approval' });
        expect(enviados()[0]).toContain('para *torneo*');
    });
});
