/**
 * Cola de comprobantes — las formas en que perdía pagos (auditoría de producción, 1–16 nov 2026: de 723 archivos,
 * el 27 % terminó en un cobro). Cada caso de acá es uno de los reales de la auditoría, con nombres cambiados donde
 * hacía falta. Las reglas puras están en services/wa-cola-reglas.test.ts; esto es el worker de punta a punta.
 *
 *  R1  guardar siempre lo leído          R2  nunca cerrar sin escalar un pago real / archivo que no se pudo abrir
 *  R4  el nombre del pie manda           R6  pagos de torneo o de club
 *  R7  la venta no secuestra pagos       R8  pago partido
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
    /** Lo que devuelven los SELECT sobre la cola (filas anteriores del contacto). */
    colaPrevias: [] as any[],
    ajustes: { allow_installments: false } as any,
    ventaAbierta: null as any,
    decisionVenta: { tipo: 'seguir' } as any,
};

const updatesCola: any[] = [];
const updatesPagos: any[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, gte: () => chain, lt: () => chain,
        lte: () => chain, ilike: () => chain, limit: () => chain, order: () => chain, neq: () => chain, is: () => chain,
        not: () => chain, insert: () => chain, upsert: () => chain,
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
            if (table === 'school_settings') return makeChain({ data: state.ajustes, error: null }, table);
            if (table === 'whatsapp_inbound_queue') return makeChain({ data: state.colaPrevias, error: null, count: 0 }, table);
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
const downloadMediaMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, base64: 'ZmFrZQ==', mimeType: 'image/jpeg' } as any));
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
    ventaAbiertaDeContacto: vi.fn(() => Promise.resolve(state.ventaAbierta)),
    decidirComprobanteDeVenta: vi.fn(() => state.decisionVenta),
}));

const pagosPendientesDeMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
vi.mock('../services/whatsapp-receipt-matching.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-receipt-matching.service');
    return { ...real, pagosPendientesDe: (...a: any[]) => pagosPendientesDeMock(...a) };
});

const fichasPorTelefonoMock = vi.fn((..._a: any[]) => Promise.resolve({ childIds: [] as string[], unregisteredIds: [] as string[] }));
const pendientesPorLlavesMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
const pagoYaRegistradoMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
const deportistaPorNombreSinVerificarMock = vi.fn((..._a: any[]) => Promise.resolve({ exacta: null as any, parecida: null as any }));
vi.mock('../services/whatsapp-comprobante-de-ficha.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-de-ficha.service');
    return {
        ...real,
        fichasPorTelefono: (...a: any[]) => fichasPorTelefonoMock(...a),
        pendientesPorLlaves: (...a: any[]) => pendientesPorLlavesMock(...a),
        pagoYaRegistrado: (...a: any[]) => pagoYaRegistradoMock(...a),
        deportistaPorNombreSinVerificar: (...a: any[]) => deportistaPorNombreSinVerificarMock(...a),
    };
});

const fichasDeLaEscuelaMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
vi.mock('../services/whatsapp-comprobante-guiado.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-guiado.service');
    return { ...real, fichasDeLaEscuela: (...a: any[]) => fichasDeLaEscuelaMock(...a) };
});

const { runWhatsAppQueue } = await import('./whatsapp-queue.job');

const comprobante = (amount: number | null, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: 'M12345678', bank: 'Nequi', date: '2026-11-04', provider: 'gemini',
    originName: 'Carolina Amórtegui', description: null, ...extra,
});
const mensualidad = (id: string, amount: number, mes: number, atleta: string, childId: string) => ({
    id, amount, concept: `Mensualidad ${String(mes).padStart(2, '0')}/2026 - ${atleta}`, due_date: `2026-${String(mes).padStart(2, '0')}-10`,
    child_id: childId, atleta, categoria: 'mensualidad',
});
const inscripcion = (childId: string, cuota: number) => ({
    child_id: childId, unregistered_athlete_id: null, monthly_fee: cuota, fee_is_manual: false, status: 'active',
    plan: { name: 'Plan', price: cuota, registration_fee: null }, team: null,
});

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
    state.colaPrevias = [];
    state.ajustes = { allow_installments: false };
    state.ventaAbierta = null;
    state.decisionVenta = { tipo: 'seguir' };
    extractReceiptMock.mockResolvedValue(comprobante(180000));
    downloadMediaMock.mockResolvedValue({ ok: true, base64: 'ZmFrZQ==', mimeType: 'image/jpeg' });
    fichasPorTelefonoMock.mockResolvedValue({ childIds: [], unregisteredIds: [] });
    pendientesPorLlavesMock.mockResolvedValue([]);
    pagoYaRegistradoMock.mockResolvedValue(null);
    pagosPendientesDeMock.mockResolvedValue([]);
    deportistaPorNombreSinVerificarMock.mockResolvedValue({ exacta: null, parecida: null });
    fichasDeLaEscuelaMock.mockResolvedValue([]);
});

// ─── R1 ──────────────────────────────────────────────────────────────────────

describe('R1 · guardar siempre lo leído (247 filas imposibles de auditar)', () => {
    it('`contacto_no_atendido`: el código no cambia (la bandeja lo compara exacto) y queda la lectura', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        extractReceiptMock.mockResolvedValue(comprobante(250000, { destination: '3119998888', originName: 'Jorge Peña', description: 'Arriendo' }));
        await runWhatsAppQueue();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'contacto_no_atendido' });
        expect(c.pregunta_ocr).toMatchObject({
            sha: expect.any(String),
            ocr: { amount: 250000, reference: 'M12345678', date: '2026-11-04', destination: '3119998888', originName: 'Jorge Peña', description: 'Arriendo' },
        });
        expect(enviados()).toHaveLength(0);
    });

    it('«no es un comprobante»: mismo `error_message`, y queda guardado qué se leyó', async () => {
        state.claim = [FILA('f1', { media_caption: 'te envío el pago' })];
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: 90000, provider: 'gemini', description: 'Compra exitosa' });
        await runWhatsAppQueue();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'no es un comprobante' });
        expect(c.pregunta_ocr).toMatchObject({ sha: expect.any(String), ocr: { amount: 90000, description: 'Compra exitosa', isReceipt: false } });
    });

    it('destino ajeno: mismo `error_message`, con monto, referencia, destino y quién pagó', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(180000, { destination: '3119998888' }));
        await runWhatsAppQueue();
        const c = cierre();
        expect(c.error_message).toBe('destino no es de la escuela');
        expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: 180000, destination: '3119998888', originName: 'Carolina Amórtegui' }, referencias: expect.any(Array) });
    });

    it('listado de movimientos: también queda la lectura', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(180000, { isTransactionList: true }));
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ error_message: 'listado de movimientos', pregunta_ocr: { ocr: { amount: 180000, isTransactionList: true } } });
    });
});

// ─── R2 ──────────────────────────────────────────────────────────────────────

describe('R2 · nunca cerrar sin escalar una fila con monto leído y señales de pago real', () => {
    it('familia SIN cobros abiertos con un comprobante real: ACCIÓN con monto y propuesta, y el cliente recibe respuesta', async () => {
        state.children = [{ id: 'c1', full_name: 'Samuel Ríos' }];
        // Con un solo deportista se pregunta el mes (como siempre); con la conversación tomada no se puede preguntar.
        state.atencion = { atender: true, tipo: 'familia', botEncendido: true, tomada: true };
        await runWhatsAppQueue();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^sin_pendientes: pagó \$180\.000 y no tiene cobros abiertos: puede ser otro concepto o un mes que no se ha generado/);
        expect(c.error_message).toContain('deportista: Samuel Ríos');
    });

    it('archivo demasiado grande: se le AVISA al cliente y la fila queda `failed` (acción), no en silencio', async () => {
        downloadMediaMock.mockResolvedValue({ ok: false, error: 'archivo_muy_grande:9400000' });
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('Recibí tu archivo');
        expect(enviados()[0]).toContain('la escuela lo revisa');
        expect(cierre()).toMatchObject({ status: 'failed', error_message: 'archivo_muy_grande:9400000' });
        expect(extractReceiptMock).not.toHaveBeenCalled();
    });

    it('un fallo transitorio de la descarga NO avisa nada: se reintenta', async () => {
        downloadMediaMock.mockResolvedValue({ ok: false, error: 'network_error' });
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        expect(updatesCola.find((u) => u.status === 'pending')).toMatchObject({ retries: 1 });
    });
});

// ─── R4 ──────────────────────────────────────────────────────────────────────

describe('R4 · el nombre del pie o de la nota manda sobre el hijo por defecto', () => {
    const JULIANA = { id: 'jul', full_name: 'Juliana Rodríguez Amórtegui' };
    const ISABELLA = { id: 'isa', full_name: 'Isabella Rodríguez Amórtegui' };

    it('las dos hermanas con noviembre abierto por el mismo valor + pie «Mensualidad Isabella Rodríguez Amórtegui» → se aplica al de Isabella, sin preguntar', async () => {
        state.claim = [FILA('f1', { media_caption: 'Mensualidad Isabella Rodríguez Amórtegui' })];
        pagosPendientesDeMock.mockResolvedValue([
            mensualidad('p-jul', 180000, 11, JULIANA.full_name, 'jul'), mensualidad('p-isa', 180000, 11, ISABELLA.full_name, 'isa'),
        ]);
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-isa', undefined);
        expect(cierre()).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-isa', matched_child_id: 'isa' });
        expect(enviados()[0]).toContain('de *Isabella*');
    });

    it('sin el nombre en el pie, con las dos hermanas, se sigue preguntando a cuál cobro va', async () => {
        pagosPendientesDeMock.mockResolvedValue([
            mensualidad('p-jul', 180000, 11, JULIANA.full_name, 'jul'), mensualidad('p-isa', 180000, 11, ISABELLA.full_name, 'isa'),
        ]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeTruthy();
    });

    it('un mensaje de OTRA cosa que nombra a una hermana («mañana Juliana no va a entrenar») no decide de quién es el pago', async () => {
        state.textos = [{ text_body: 'mañana Juliana no va a entrenar' }];
        pagosPendientesDeMock.mockResolvedValue([
            mensualidad('p-jul', 180000, 11, JULIANA.full_name, 'jul'), mensualidad('p-isa', 180000, 11, ISABELLA.full_name, 'isa'),
        ]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeTruthy();
    });

    it('…pero «te envío el pago de Juliana» en el chat sí', async () => {
        state.textos = [{ text_body: 'te envío el pago de Juliana' }];
        pagosPendientesDeMock.mockResolvedValue([
            mensualidad('p-jul', 180000, 11, JULIANA.full_name, 'jul'), mensualidad('p-isa', 180000, 11, ISABELLA.full_name, 'isa'),
        ]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-jul', undefined);
    });

    it('el número solo tiene la ficha de Juliana (sin cobros) y el pie nombra a Isabella, la hermana, que tiene noviembre abierto por ese valor → se aplica al cobro de Isabella (antes: «¿de qué mes?» de Juliana)', async () => {
        state.claim = [FILA('f1', { media_caption: 'Mensualidad Isabella Rodríguez Amórtegui' })];
        state.children = [JULIANA];
        state.enrollments = [inscripcion('jul', 180000)];
        fichasDeLaEscuelaMock.mockResolvedValue([
            { id: 'jul', nombre: JULIANA.full_name, tipo: 'child' }, { id: 'isa', nombre: ISABELLA.full_name, tipo: 'child' },
            { id: 'x1', nombre: 'Isabella Gómez Parra', tipo: 'child' },
        ]);
        pendientesPorLlavesMock.mockResolvedValue([mensualidad('p-isa', 180000, 11, ISABELLA.full_name, 'isa')]);
        await runWhatsAppQueue();
        expect(pendientesPorLlavesMock).toHaveBeenCalledWith('school-1', { childIds: ['isa'], unregisteredIds: [] });
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-isa', undefined);
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).not.toContain('¿De qué mes');
        const c = cierre();
        expect(c).toMatchObject({ status: 'done', result_ref_id: 'p-isa' });
        expect(c.error_message).toContain('hermano_por_nombre');
    });

    it('el pie nombra a un deportista de OTRA familia (no comparte los apellidos): NO se aplica; ACCIÓN con la propuesta exacta', async () => {
        state.claim = [FILA('f1', { media_caption: 'comprobante de pago SARA DAZA' })];
        state.children = [JULIANA];
        state.enrollments = [inscripcion('jul', 180000)];
        fichasDeLaEscuelaMock.mockResolvedValue([
            { id: 'jul', nombre: JULIANA.full_name, tipo: 'child' }, { id: 'sara', nombre: 'Sara Valentina Daza Gómez', tipo: 'child' },
        ]);
        pendientesPorLlavesMock.mockResolvedValue([mensualidad('p-sara', 180000, 11, 'Sara Valentina Daza Gómez', 'sara')]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated', matched_child_id: 'sara' });
        expect(c.error_message).toMatch(/^sin_familia: numero_fuera_de_la_ficha — parece el pago de noviembre de Sara Valentina Daza Gómez: \$180\.000; el número no está en su ficha/);
        expect(enviados()).toEqual(['Gracias 🙏 Le paso tu comprobante a la escuela para que lo revise y te confirme por aquí.']);
    });

    it('dos hijos sin cobros + «pago del mes de noviembre de mi hija Antonella» → ni «¿De cuál deportista es?» ni «¿de qué mes?»: a la bandeja con Antonella y noviembre', async () => {
        state.textos = [{ text_body: 'pago del mes de noviembre de mi hija Antonella' }];
        state.children = [{ id: 'ant', full_name: 'Antonella Pérez Gil' }, { id: 'mat', full_name: 'Matías Pérez Gil' }];
        state.enrollments = [inscripcion('ant', 180000), inscripcion('mat', 180000)];
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual(['Listo: comprobante de *$180.000* de *Antonella* para *noviembre*. La escuela lo confirma.']);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated', matched_child_id: 'ant' });
        expect(c.error_message).toMatch(/^sin_pendientes: Antonella Pérez Gil no tiene cobro de noviembre 2026 · comprobante de \$180\.000/);
        expect(c.error_message).toContain('Propuesta → deportista: Antonella Pérez Gil · mes: noviembre 2026 · crear el cobro de ese mes por $180.000 y aplicar este comprobante');
    });

    it('un solo hijo sin cobros + pie «Adjunto soporte de pago Noviembre» → no se pregunta el mes', async () => {
        state.claim = [FILA('f1', { media_caption: 'Adjunto soporte de pago Noviembre' })];
        state.children = [{ id: 'c1', full_name: 'Samuel Ríos' }];
        state.enrollments = [inscripcion('c1', 180000)];
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(cierre().error_message).toMatch(/^sin_pendientes: Samuel Ríos no tiene cobro de noviembre 2026/);
    });

    it('un solo hijo sin cobros y SIN mes escrito → la pregunta del mes de siempre', async () => {
        state.children = [{ id: 'c1', full_name: 'Samuel Ríos' }];
        state.enrollments = [inscripcion('c1', 180000)];
        await runWhatsAppQueue();
        expect(enviados()[0]).toContain('¿De qué mes es?');
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeTruthy();
    });
});

// ─── R6 ──────────────────────────────────────────────────────────────────────

describe('R6 · pagos de torneo o de club (~20 filas, > $2,2 M)', () => {
    it('club externo (número sin ficha) paga $900.000 con «Inscripción del equipo Halcones sub 15» → NO «¿de qué deportista?»: torneo/club con monto y lo que dijo', async () => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
        state.claim = [FILA('f1', { media_caption: 'Inscripción del equipo Halcones sub 15' })];
        extractReceiptMock.mockResolvedValue(comprobante(900000, { originName: 'Club Halcones SAS' }));
        await runWhatsAppQueue();
        expect(enviados()).toEqual(['Recibí tu comprobante de *$900.000* 📄 Se lo paso a la escuela para que lo registre y te confirme por aquí.']);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^torneo_o_club: \$900\.000 que parece de un torneo o de un club · dijo: «Inscripción del equipo Halcones sub 15»/);
        expect(c.error_message).toContain('pagó: Club Halcones SAS');
        expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: 900000 } });
        expect(updatesCola.some((u) => u.status === 'waiting_user')).toBe(false);
    });

    it('familia sin un cobro por ese monto + «pago liga de voleibol» → torneo/club, no «¿de qué mes?»', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago liga de voleibol' })];
        state.children = [{ id: 'c1', full_name: 'Samuel Ríos' }];
        extractReceiptMock.mockResolvedValue(comprobante(250000));
        await runWhatsAppQueue();
        expect(cierre().error_message).toMatch(/^torneo_o_club: \$250\.000/);
        expect(enviados()[0]).not.toContain('¿De qué mes');
    });

    it('familia CON un cobro abierto por ese monto: aunque el pie diga «equipo», va a su cobro', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago equipo sub 12' })];
        pagosPendientesDeMock.mockResolvedValue([mensualidad('p1', 180000, 11, 'Samuel Ríos', 'c1')]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p1', undefined);
    });
});

// ─── R7 ──────────────────────────────────────────────────────────────────────

describe('R7 · la venta de un servicio no secuestra pagos de familias', () => {
    const MENSUALIDAD = mensualidad('p-men', 180000, 11, 'Sofía Mora', 'c1');
    const CLINICA = { id: 'p-clinica', amount: 180000, concept: 'Clínica Jorge Mesa — Sofía Mora', due_date: '2026-11-20', child_id: 'c1', atleta: 'Sofía Mora', categoria: 'clase_extra' };

    beforeEach(() => {
        state.ventaAbierta = { nombre: 'Clínica Jorge Mesa' };
        state.decisionVenta = { tipo: 'aplicar', pago: CLINICA };
        pagosPendientesDeMock.mockResolvedValue([MENSUALIDAD, CLINICA]);
    });

    it('«no estamos pagando la clínica, estamos pagando la mensualidad» → NUNCA al cobro de la clínica', async () => {
        state.claim = [FILA('f1', { media_caption: 'no estamos pagando la clínica, estamos pagando la mensualidad' })];
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalledWith('p-clinica', undefined);
        // Va por el camino de familia: a la mensualidad (el cobro más antiguo de ese valor).
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-men', undefined);
        expect(cierre()).toMatchObject({ status: 'done', result_ref_id: 'p-men' });
    });

    it('sin desmentirlo, la venta abierta sigue ganando como siempre', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago de la clínica' })];
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-clinica', undefined);
    });
});

// ─── R8 ──────────────────────────────────────────────────────────────────────

describe('R8 · pago partido ($9.000 + $81.000 = la cuota de $90.000)', () => {
    const CUOTA = mensualidad('p90', 90000, 11, 'Luciana Mora', 'c1');

    it('el primero ($9.000) solo no cuadra: como siempre, a la escuela con `monto_no_cuadra` y su lectura', async () => {
        pagosPendientesDeMock.mockResolvedValue([CUOTA]);
        extractReceiptMock.mockResolvedValue(comprobante(9000));
        await runWhatsAppQueue();
        const c = cierre();
        expect(c.error_message).toMatch(/^monto_no_cuadra:/);
        expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: 9000 } });
    });

    it('el segundo ($81.000), con el de $9.000 de hace minutos: ACCIÓN con la suma y el cobro; no se aplica solo', async () => {
        pagosPendientesDeMock.mockResolvedValue([CUOTA]);
        state.colaPrevias = [{ id: 'f0', status: 'ignored', result_type: 'escalated', error_message: 'monto_no_cuadra: La familia mandó…', monto: '9000', created_at: new Date(Date.now() - 120_000).toISOString() }];
        extractReceiptMock.mockResolvedValue(comprobante(81000, { reference: 'M99999999' }));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(updatesPagos).toHaveLength(0);
        const c = updatesCola.find((u) => u.status === 'ignored' && String(u.error_message).startsWith('pago_partido'));
        expect(c).toMatchObject({ result_type: 'escalated', matched_child_id: 'c1' });
        expect(c.error_message).toMatch(/^pago_partido: \$9\.000 \+ \$81\.000 = \$90\.000, el valor de /);
        expect(c.error_message).toContain('aplicar los 2 comprobantes al cobro p90');
        expect(enviados()).toEqual(['Recibí tus 2 comprobantes 📄 Juntos suman *$90.000*. Se los paso a la escuela para que los aplique al mismo cobro y te confirme por aquí.']);
        // La parte anterior deja de decir «monto no cuadra».
        expect(updatesCola.some((u) => typeof u.error_message === 'string' && u.error_message.startsWith('pago_partido: parte de un pago de $90.000'))).toBe(true);
    });

    it('si la suma no calza con ningún cobro, sigue siendo `monto_no_cuadra`', async () => {
        pagosPendientesDeMock.mockResolvedValue([CUOTA]);
        state.colaPrevias = [{ id: 'f0', status: 'ignored', error_message: 'monto_no_cuadra: …', monto: '9000' }];
        extractReceiptMock.mockResolvedValue(comprobante(50000));
        await runWhatsAppQueue();
        expect(cierre().error_message).toMatch(/^monto_no_cuadra:/);
    });
});
