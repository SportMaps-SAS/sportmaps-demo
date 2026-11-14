/**
 * El worker ya no escala lo que puede resolver (Dynasty, 28-sep → 08-oct: 43
 * de 188 adjuntos al buzón). Una rama por caso, con datos inventados:
 *
 *  (a) familia sin cuenta con ficha por teléfono → se aplica por la ficha;
 *  (b) número sin ficha → por nombre, o UNA pregunta «¿De qué deportista…?»;
 *  (c) varios cobros → botones con concepto + monto;
 *  (d) sin pendientes y ya aprobado → «Este pago ya estaba registrado ✅».
 *
 * Y lo que no cambia: una sola respuesta, otro concepto, la misma imagen.
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
const rolDePersonalMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
vi.mock('../services/whatsapp-personal-escuela.service', () => ({
    rolDePersonal: (...a: any[]) => rolDePersonalMock(...a),
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
const deportistaPorNombreSinVerificarMock = vi.fn((..._a: any[]) => Promise.resolve({ exacta: null, parecida: null } as any));
const pendientesPorLlavesMock = vi.fn((..._a: any[]) => Promise.resolve([] as any[]));
const pagoYaRegistradoMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
vi.mock('../services/whatsapp-comprobante-de-ficha.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-de-ficha.service');
    return {
        ...real,
        fichasPorTelefono: (...a: any[]) => fichasPorTelefonoMock(...a),
        deportistaPorNombre: (...a: any[]) => deportistaPorNombreMock(...a),
        deportistaPorNombreSinVerificar: (...a: any[]) => deportistaPorNombreSinVerificarMock(...a),
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
    state.mismaImagen = null;
    state.filaEsperando = null;
    extractReceiptMock.mockResolvedValue(comprobante(150000));
    fichasPorTelefonoMock.mockResolvedValue({ childIds: [], unregisteredIds: [] });
    deportistaPorNombreMock.mockResolvedValue(null);
    deportistaPorNombreSinVerificarMock.mockResolvedValue({ exacta: null, parecida: null });
    rolDePersonalMock.mockResolvedValue(null);
    pendientesPorLlavesMock.mockResolvedValue([]);
    pagoYaRegistradoMock.mockResolvedValue(null);
    pagosPendientesDeMock.mockResolvedValue([]);
});

describe('(a) familia sin cuenta con ficha por teléfono', () => {
    beforeEach(() => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        fichasPorTelefonoMock.mockResolvedValue({ childIds: ['c1'], unregisteredIds: [] });
    });

    it('se aplica al cobro de la ficha, como a una familia con cuenta, sin pedir cuenta', async () => {
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        expect(pendientesPorLlavesMock).toHaveBeenCalledWith('school-1', { parentId: null, childIds: ['c1'], unregisteredIds: [] });
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-oct', undefined);
        expect(enviados()).toHaveLength(1);
        // Cierre de una línea (spec 3.3, 2026-10-24).
        expect(enviados()[0]).toContain('Listo: comprobante de *$150.000* de *Laura* para *octubre*. La escuela lo confirma.');
        expect(enviados()[0]).not.toMatch(/register|cuenta creada/);
        expect(cierre()).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-oct', matched_child_id: 'c1' });
    });

    it('la misma imagen ya en un cobro de la ficha → «ya lo había recibido», no se aplica otra vez', async () => {
        state.mismaImagen = { id: 'p-oct', concept: 'Mensualidad 10/2026', status: 'awaiting_approval' };
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        expect(enviados()).toEqual(['Este comprobante ya lo había recibido 👍']);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
    });

    it('nombra otro concepto (uniforme) y no hay cobro de eso → a la escuela, no a la mensualidad', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago del uniforme' })];
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
    });

    it('la ficha sin cobros pendientes ni pago que coincida → pregunta el MES con botones, sin «crea tu cuenta» (spec 3.3)', async () => {
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).not.toContain('/register');
        expect(enviados()[0]).toContain('¿De qué mes es?');
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        // Últimos 3 meses + «Otro mes».
        expect(botones).toHaveLength(4);
        expect(botones[3].title).toBe('4. Otro mes');
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'mes', parentId: null });
        expect(espera.pregunta_ocr.guia.opciones).toHaveLength(4);
    });

    it('sin fichas por teléfono → como antes (al buzón con el enlace de registro)', async () => {
        fichasPorTelefonoMock.mockResolvedValue({ childIds: [], unregisteredIds: [] });
        await runWhatsAppQueue();
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'escalated', error_message: 'familia_sin_cuenta' });
    });
});

describe('(b) número sin ficha', () => {
    beforeEach(() => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
    });

    it('comprobante a la escuela sin nombre reconocible → UNA pregunta corta y queda esperando', async () => {
        await runWhatsAppQueue();
        expect(enviados()).toEqual(['Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.']);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'deportista', parentId: null });
        expect(espera.pregunta_opciones).toEqual([]);
    });

    it('ya se le preguntó (otra foto) → no se repite; la fila espera la misma respuesta', async () => {
        state.yaPreguntado = true;
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        expect(updatesCola.find((u) => u.status === 'waiting_user')).toBeTruthy();
    });

    it('el pie trae el nombre COMPLETO y el monto es el de su cobro → se liga sin preguntar, sin decirle datos del deportista', async () => {
        state.claim = [FILA('f1', { media_caption: 'Mensualidad de Laura Peña' })];
        deportistaPorNombreSinVerificarMock.mockResolvedValue({ exacta: { id: 'c1', nombre: 'Laura Peña', tipo: 'child' }, parecida: null });
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        // Busca con el pie, el chat, el concepto y quien paga.
        expect(deportistaPorNombreSinVerificarMock.mock.calls[0][1]).toEqual(
            expect.arrayContaining(['Mensualidad de Laura Peña', 'Pedro Gómez']));
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-oct', undefined);
        // Un número sin verificar no recibe el nombre, el mes ni los cobros del deportista (Monster 2026-11-05).
        expect(enviados()).toEqual(['Recibí tu comprobante de *$150.000* 📄 La escuela lo valida y te confirma por aquí.']);
        expect(cierre()).toMatchObject({ status: 'done', result_ref_id: 'p-oct' });
    });

    it('solo un nombre PARECIDO (no completo) → nada se liga: la pregunta escrita, sin botones', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago de Laura' })];
        deportistaPorNombreSinVerificarMock.mockResolvedValue({ exacta: null, parecida: { id: 'c1', nombre: 'Laura Peña', tipo: 'child' } });
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual(['Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.']);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
    });

    it('a una cuenta que no es de la escuela → sin responderle, pero a la bandeja como destino_ajeno (nunca se ignora un comprobante)', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(150000, { destination: '3119998888' }));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^recuperado: destino_ajeno — el dinero fue a 3119998888/);
        expect(c.error_message).toContain('pagó: Pedro Gómez');
        expect(c.pregunta_ocr.ocr).toMatchObject({ amount: 150000 });
    });

    it('sin destino legible ni texto de pago → silencio', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(150000, { destination: null }));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(0);
    });

    it('la respuesta con el nombre aplica el comprobante guardado (aplicarComprobanteDeFicha)', async () => {
        state.filaEsperando = {
            ...FILA('f9', { storage_path: 'school-1/whatsapp/f9.jpg' }),
            pregunta_ocr: { tipo: 'deportista', ocr: comprobante(150000), sha: 'x', storagePath: 'school-1/whatsapp/f9.jpg', parentId: null },
        };
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        const responder = vi.fn((..._a: any[]) => Promise.resolve());
        await aplicarComprobanteDeFicha('f9', { childIds: ['c1'], unregisteredIds: [] }, responder);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-oct', undefined);
        expect(responder.mock.calls[0][0]).toContain('Listo: comprobante de *$150.000* de *Laura* para *octubre*');
    });
});

describe('(c) varios cobros pendientes', () => {
    // Dos deportistas con el mismo monto: no se adivina de cuál es (regla de la
    // escuela, 2026-09-15). Del MISMO deportista va al más antiguo (abajo).
    const OCT_HERMANO = { ...OCT, id: 'p-oct-2', child_id: 'c2', atleta: 'Tomás Peña' };

    it('la pregunta sale con botones: concepto + monto', async () => {
        pagosPendientesDeMock.mockResolvedValue([SEP, OCT_HERMANO]);
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).toHaveBeenCalledTimes(1);
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Laura $150.000', '2. Tomás $150.000']);
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_opciones.map((p: any) => p.id)).toEqual(['p-sep', 'p-oct-2']);
    });

    it('mismo deportista, mismo monto y sin pista: al vencido MÁS ANTIGUO, sin preguntar', async () => {
        pagosPendientesDeMock.mockResolvedValue([SEP, OCT]);
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-sep', undefined);
    });

    it('familia sin cuenta con dos cobros de la ficha → también con botones', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        fichasPorTelefonoMock.mockResolvedValue({ childIds: ['c1', 'c2'], unregisteredIds: [] });
        pendientesPorLlavesMock.mockResolvedValue([SEP, OCT_HERMANO]);
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).toHaveBeenCalledTimes(1);
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr.parentId).toBeNull();
    });
});

describe('(d) sin cobros pendientes', () => {
    it('un pago ya aprobado coincide → «Este pago ya estaba registrado ✅», sin escalar', async () => {
        pagoYaRegistradoMock.mockResolvedValue({ id: 'p-oct', concept: 'Mensualidad 10/2026' });
        await runWhatsAppQueue();
        expect(enviados()).toEqual(['Este pago ya estaba registrado ✅']);
        expect(cierre()).toMatchObject({ status: 'ignored', result_type: 'none', result_ref_id: 'p-oct' });
    });

    it('nada coincide → el mensaje de siempre', async () => {
        await runWhatsAppQueue();
        expect(enviados()[0]).toContain('no tienes cobros pendientes');
    });
});

// ─── Monto que no cuadra, escuela sin abonos (Dynasty 2026-10-09, inventado) ─

describe('(e) el pie dice «saldo» y el monto no cuadra con ningún cobro', () => {
    it('no se estampa en la mensualidad en silencio: a la escuela con el resumen y UNA respuesta', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        fichasPorTelefonoMock.mockResolvedValue({ childIds: ['c1'], unregisteredIds: [] });
        state.claim = [FILA('f1', { media_caption: 'Hola profe, envío el saldo\nago 20 - sep 20\n$70.000 gracias' })];
        extractReceiptMock.mockResolvedValue(comprobante(70000));
        pendientesPorLlavesMock.mockResolvedValue([OCT]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('No coincide con el valor de *Mensualidad 10/2026');
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^monto_no_cuadra: La familia mandó un comprobante de \$70\.000/);
        expect(c.error_message).toContain('envío el saldo');
    });

    it('el monto no cuadra y hay varios cobros: se pregunta a cuál (con botones), no se aplica', async () => {
        pagosPendientesDeMock.mockResolvedValue([SEP, OCT]);
        extractReceiptMock.mockResolvedValue(comprobante(120000));
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(sendInteractiveButtonsMock).toHaveBeenCalledTimes(1);
    });

    it('el pie nombra el mes y el monto cuadra: va a ese mes aunque haya uno más viejo', async () => {
        state.claim = [FILA('f1', { media_caption: 'pago de octubre' })];
        pagosPendientesDeMock.mockResolvedValue([SEP, OCT]);
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('p-oct', undefined);
    });
});

// ─── El personal que no administra (Monster 2026-11-08) ─────────────────────

describe('personal de la escuela o de la plataforma que NO administra', () => {
    it('un profe manda un comprobante: ni «¿de qué deportista?» ni la rama de alta por matrícula; a la bandeja sin escribirle', async () => {
        state.atencion = { atender: false, tipo: 'staff', botEncendido: true };
        rolDePersonalMock.mockResolvedValue('coach');
        await runWhatsAppQueue();
        expect(enviados()).toEqual([]);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^sin_familia: contacto_no_atendido \(staff_coach\)/);
    });

    it('un admin de la plataforma: igual, nada de prospecto ni de familia', async () => {
        state.atencion = { atender: false, tipo: 'staff', botEncendido: true };
        rolDePersonalMock.mockResolvedValue('plataforma');
        await runWhatsAppQueue();
        expect(enviados()).toEqual([]);
        expect(cierre().error_message).toMatch(/\(staff_plataforma\)/);
    });
});
