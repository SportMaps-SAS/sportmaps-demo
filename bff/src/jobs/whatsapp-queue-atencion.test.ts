/**
 * La puerta de atención del worker de comprobantes (whatsapp-queue.job.ts).
 *
 * Origen, medido el 2026-10-03 en Dynasty (Coexistence, bot APAGADO): el
 * worker no miraba `ai_enabled` y le escribió de verdad a 17 familias
 * «escríbeme el correo… te mando un código». Del 2 al 3 de octubre, 18 de 29
 * comprobantes se cerraron «contacto sin identificar»; contra
 * `wa_identify_by_phone` 7 eran familias identificables por teléfono, 4
 * familias sin cuenta y 7 desconocidos.
 *
 * Dos capas: la regla pura (`decidirAdjunto`) sin mocks, y el recorrido de
 * `runWhatsAppQueue` con supabase/OCR/envío mockeados para comprobar los
 * efectos: qué se manda, si se gasta OCR y cómo queda la fila.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    rpcStaffAdmin: { data: { estado: 'desconocido' } as any },
    rpcIdentifyByPhone: { data: { estado: 'desconocido' } as any },
    rpcInvitacion: { data: null as any },
    atencion: { atender: true, tipo: 'familia', botEncendido: true } as any,
    /** Mensajes entrantes de la familia alrededor del adjunto. */
    mensajes: [] as { text_body: string | null }[],
    /** Lo que devuelve invitacionPendienteVigente. */
    vigente: { invitacion: null, atletaInactivo: false } as any,
};

/** Cada UPDATE a la cola queda acá, para ver cómo se cerró la fila. */
const updatesCola: any[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        or: () => chain,
        gte: () => chain,
        lte: () => chain,
        ilike: () => chain,
        limit: () => chain,
        order: () => chain,
        insert: () => chain,
        update: (v: any) => { if (table === 'whatsapp_inbound_queue') updatesCola.push(v); return chain; },
        upsert: () => chain,
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
}

const FILA_BASE = {
    id: 'fila-1',
    integration_id: 'int-1',
    school_id: 'school-1',
    wa_phone_number: '573001234567',
    wa_message_id: 'wamid.abc',
    media_id: 'media-1',
    media_mime_type: 'image/jpeg',
    storage_path: null,
    retries: 0,
};

const rpcMock = vi.fn((name: string) => {
    if (name === 'wa_queue_claim') return Promise.resolve({ data: [{ ...FILA_BASE }], error: null });
    if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve(state.rpcStaffAdmin);
    if (name === 'wa_identify_by_phone') return Promise.resolve(state.rpcIdentifyByPhone);
    if (name === 'wa_invitacion_pendiente_por_telefono') return Promise.resolve(state.rpcInvitacion);
    return Promise.resolve({ data: null, error: null });
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'school_whatsapp_integrations') {
                return makeChain({ data: { id: 'int-1', school_id: 'school-1', access_token: 'tok', phone_number_id: 'pn-1' } }, table);
            }
            if (table === 'whatsapp_conversations') return makeChain(state.conv, table);
            if (table === 'whatsapp_messages') {
                // Entrantes = los textos de la familia; salientes (anti-repetición) = nada.
                const result = { data: state.mensajes as any[], error: null };
                const chain = makeChain(result, table);
                chain.eq = (col: string, val: any) => {
                    if (col === 'direction' && val === 'outbound') result.data = [];
                    return chain;
                };
                return chain;
            }
            return makeChain({ data: null, error: null }, table);
        }),
        rpc: (...args: any[]) => (rpcMock as any)(...args),
        storage: {
            from: () => ({
                download: vi.fn(() => Promise.resolve({ data: null, error: null })),
                upload: vi.fn(() => Promise.resolve({ data: {}, error: null })),
            }),
        },
    },
}));

const sendTextMessageMock = vi.fn((..._args: any[]) => Promise.resolve({ ok: true, waMessageId: 'wamid.out' }));
const downloadMediaMock = vi.fn((..._args: any[]) => Promise.resolve({ ok: true, base64: 'ZmFrZQ==', mimeType: 'image/jpeg' }));
vi.mock('../services/whatsapp.service', () => ({
    downloadMedia: (...a: any[]) => downloadMediaMock(...a),
    sendTextMessage: (...a: any[]) => sendTextMessageMock(...a),
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('../services/whatsapp-optin.service', () => ({
    estaDadoDeBaja: vi.fn(() => Promise.resolve(false)),
    AVISO_DADO_DE_BAJA: '',
}));

const debeAtenderMock = vi.fn((..._args: any[]) => Promise.resolve(state.atencion));
vi.mock('../services/whatsapp-atencion.service', () => ({
    debeAtender: (...a: any[]) => debeAtenderMock(...a),
}));

const invitacionPendienteVigenteMock = vi.fn((..._a: any[]) => Promise.resolve(state.vigente));
vi.mock('../services/whatsapp-invitacion-vigente.service', () => ({
    invitacionPendienteVigente: (...a: any[]) => invitacionPendienteVigenteMock(...a),
}));

const abrirConsultaMock = vi.fn((..._a: any[]) => Promise.resolve());
vi.mock('../services/whatsapp-bot.service', () => ({
    abrirConsultaParaLaEscuela: (...a: any[]) => abrirConsultaMock(...a),
    ofrecerConsentimientoSiFalta: vi.fn(() => Promise.resolve()),
}));

const extractReceiptMock = vi.fn();
vi.mock('../services/ocr.service', () => ({
    extractReceipt: (...args: any[]) => extractReceiptMock(...args),
}));
const extractEnrollmentFormMock = vi.fn();
vi.mock('../services/enrollment-ocr.service', () => ({
    extractEnrollmentForm: (...args: any[]) => extractEnrollmentFormMock(...args),
}));
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: vi.fn(() => Promise.resolve({ registeredAccounts: [] })),
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

const pagosPendientesDeMock = vi.fn();
const resolverPagoMock = vi.fn();
vi.mock('../services/whatsapp-receipt-matching.service', () => ({
    pagosPendientesDe: (...args: any[]) => pagosPendientesDeMock(...args),
    resolverPago: (...args: any[]) => resolverPagoMock(...args),
    describirPago: () => 'un pago',
    mensajeElegirPago: () => 'elige',
}));

const { runWhatsAppQueue, decidirAdjunto, esConsultaSobreCobro, pareceComprobanteDePago } = await import('./whatsapp-queue.job');

const COMPROBANTE = {
    isReceipt: true, isTransactionList: false, amount: 150000, destination: null,
    reference: 'REF9', bank: 'Bancolombia', date: '2026-10-03', provider: 'gemini',
};

/** El último cierre de la fila (status + result_type + error_message). */
const ultimoCierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');
const textosEnviados = () => sendTextMessageMock.mock.calls.map((c) => c[2] as string);

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.rpcStaffAdmin = { data: { estado: 'desconocido' } };
    state.rpcIdentifyByPhone = { data: { estado: 'desconocido' } };
    state.rpcInvitacion = { data: null };
    state.mensajes = [];
    state.vigente = { invitacion: null, atletaInactivo: false };
    state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    extractReceiptMock.mockResolvedValue(COMPROBANTE);
    resolverPagoMock.mockReturnValue({ tipo: 'sin_pendientes' });
    pagosPendientesDeMock.mockResolvedValue([]);
});

// ─── La regla pura ───────────────────────────────────────────────────────────

describe('decidirAdjunto — la regla', () => {
    const tipos = ['familia', 'familia_sin_cuenta', 'ambiguo', 'staff', 'desconocido', 'personal'] as const;

    it('bot apagado → bot_apagado para TODOS los tipos, staff incluido', () => {
        for (const tipo of tipos) {
            for (const esStaffAdmin of [false, true]) {
                expect(decidirAdjunto({ botEncendido: false, tipo, esStaffAdmin })).toBe('bot_apagado');
            }
        }
    });

    it('bot prendido: cada tipo a su camino', () => {
        expect(decidirAdjunto({ botEncendido: true, tipo: 'familia', esStaffAdmin: false })).toBe('comprobante');
        expect(decidirAdjunto({ botEncendido: true, tipo: 'familia_sin_cuenta', esStaffAdmin: false })).toBe('escalar_sin_cuenta');
        expect(decidirAdjunto({ botEncendido: true, tipo: 'ambiguo', esStaffAdmin: false })).toBe('escalar_ambiguo');
        expect(decidirAdjunto({ botEncendido: true, tipo: 'staff', esStaffAdmin: true })).toBe('staff_admin');
        expect(decidirAdjunto({ botEncendido: true, tipo: 'desconocido', esStaffAdmin: false })).toBe('silencio');
        expect(decidirAdjunto({ botEncendido: true, tipo: 'personal', esStaffAdmin: false })).toBe('silencio');
    });

    it('dueña que también es familia sigue por staff-admin (no pierde el alta por foto)', () => {
        expect(decidirAdjunto({ botEncendido: true, tipo: 'familia', esStaffAdmin: true })).toBe('staff_admin');
    });

    it('marcado como personal manda sobre staff', () => {
        expect(decidirAdjunto({ botEncendido: true, tipo: 'personal', esStaffAdmin: true })).toBe('silencio');
    });
});

// ─── El recorrido ────────────────────────────────────────────────────────────

describe('runWhatsAppQueue — la puerta de atención', () => {
    it('bot apagado: no responde, no baja el archivo, no gasta OCR, fila ignored/bot_apagado', async () => {
        state.atencion = { atender: false, tipo: 'familia', botEncendido: false };

        await runWhatsAppQueue();

        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(downloadMediaMock).not.toHaveBeenCalled();
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(extractEnrollmentFormMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', error_message: 'bot_apagado' });
    });

    it('bot apagado con un admin escribiendo: tampoco corre la rama staff-admin', async () => {
        state.atencion = { atender: false, tipo: 'staff', botEncendido: false };
        state.rpcStaffAdmin = { data: { estado: 'identificado', profile_id: 'staff-1' } };

        await runWhatsAppQueue();

        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', error_message: 'bot_apagado' });
    });

    it('familia sin parent_id previo: se identifica por teléfono y NO se pide el correo', async () => {
        state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };

        await runWhatsAppQueue();

        expect(debeAtenderMock).toHaveBeenCalledWith(expect.anything(), 'conv-1', '573001234567');
        expect(extractReceiptMock).toHaveBeenCalled();
        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-9', 'school-1');
        for (const t of textosEnviados()) expect(t).not.toMatch(/correo|código/i);
    });

    it('familia identificada por OTP (el teléfono no la resuelve): usa el parent_id de la conversación', async () => {
        state.conv = { data: { id: 'conv-1', parent_id: 'parent-otp', identified: true } };
        state.rpcIdentifyByPhone = { data: { estado: 'desconocido' } };

        await runWhatsAppQueue();

        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-otp', 'school-1');
    });

    it('familia_sin_cuenta: mensaje de escalamiento una vez, sin pedir correo, fila escalated', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };

        await runWhatsAppQueue();

        expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
        const [texto] = textosEnviados();
        expect(texto).toMatch(/todavía no tienes tu cuenta creada/);
        expect(texto).toMatch(/escuela/);
        expect(texto).not.toMatch(/correo|código/i);
        // Se lee (2026-10-06): sin lectura no se sabe si es un comprobante.
        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
        // El archivo SÍ se guarda: la escuela tiene que verlo para aplicarlo.
        expect(downloadMediaMock).toHaveBeenCalled();
        expect(pagosPendientesDeMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated', error_message: 'familia_sin_cuenta' });
    });

    it('familia_sin_cuenta con invitación pendiente: el mensaje trae SU enlace', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.vigente = { invitacion: { invite_id: 'inv-1', email: 'mama@x.com' }, atletaInactivo: false };

        await runWhatsAppQueue();

        expect(textosEnviados()[0]).toContain('/register?invite=inv-1');
    });

    it('ambiguo: «más de una cuenta», escalated, sin pedir correo', async () => {
        state.atencion = { atender: true, tipo: 'ambiguo', botEncendido: true };

        await runWhatsAppQueue();

        const [texto] = textosEnviados();
        expect(texto).toMatch(/más de una cuenta/);
        expect(texto).not.toMatch(/correo|código/i);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated', error_message: 'numero_ambiguo' });
    });

    it('personal: nunca se le responde; se lee, y sin cuenta de la escuela con qué cruzar queda ignored/contacto_no_atendido', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };

        await runWhatsAppQueue();

        // 2026-10-24: un comprobante NUNCA se ignora por el tipo de contacto, así que se lee.
        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', error_message: 'contacto_no_atendido' });
    });

    it('desconocido: comprobante sin destino de la escuela ni texto de pago → silencio, sin guardar', async () => {
        state.atencion = { atender: true, tipo: 'desconocido', botEncendido: true };

        await runWhatsAppQueue();

        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', error_message: 'contacto_no_atendido' });
    });

    it('staff con bot prendido: sigue la rama staff-admin', async () => {
        state.atencion = { atender: false, tipo: 'staff', botEncendido: true };
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, provider: 'gemini' });
        extractEnrollmentFormMock.mockResolvedValue({ isEnrollmentForm: false });

        await runWhatsAppQueue();

        // Rama staff: después del comprobante prueba la hoja de matrícula.
        expect(extractEnrollmentFormMock).toHaveBeenCalled();
    });
});

// ─── Mejora 9: conversación tomada desde el buzón ────────────────────────────

describe('runWhatsAppQueue — conversación tomada por una persona', () => {
    it('familia: el comprobante se procesa y se aplica, pero no se le escribe', async () => {
        state.atencion = { atender: false, tipo: 'familia', botEncendido: true, tomada: true };
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };

        await runWhatsAppQueue();

        expect(extractReceiptMock).toHaveBeenCalled();
        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-9', 'school-1');
        expect(sendTextMessageMock).not.toHaveBeenCalled();
    });

    it('familia_sin_cuenta: se escala a la escuela (archivo guardado), sin mensaje a la familia', async () => {
        state.atencion = { atender: false, tipo: 'familia_sin_cuenta', botEncendido: true, tomada: true };

        await runWhatsAppQueue();

        expect(downloadMediaMock).toHaveBeenCalled();
        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
    });
});

// ─── Adjunto que acompaña una consulta (Dynasty, 2026-10-06) ────────────────
//
// Beverly (sin cuenta): «acabo de ver un correo» + captura del correo de estado
// de cuenta + «te comento que llevo varios meses sin asistir» + «no entiendo
// porque me estan cobrando?». El bot contestó «Recibí tu comprobante 📄 …» con
// el enlace de registro y dejó la fila en el buzón de comprobantes.

const TEXTOS_BEVERLY = [
    'acabo de ver un correo',
    'te comento que llevo varios meses sin asistir',
    'no entiendo porque me estan cobrando?',
];

/** Lo que el OCR saca de la captura de un correo de cobro: monto y fecha, sin transacción. */
const CORREO_DE_COBRO = {
    isReceipt: true, isTransactionList: false, amount: 180000, destination: null,
    reference: null, bank: null, date: '2026-10-05', provider: 'gemini',
    missingFields: ['reference', 'bank', 'destination'],
};

describe('esConsultaSobreCobro — la regla', () => {
    it('el caso real es una consulta', () => {
        expect(esConsultaSobreCobro(TEXTOS_BEVERLY)).toBe(true);
        expect(esConsultaSobreCobro(['no entiendo porque me estan cobrando?'])).toBe(true);
        expect(esConsultaSobreCobro(['llevo varios meses sin asistir'])).toBe(true);
        expect(esConsultaSobreCobro(['acabo de ver un correo'])).toBe(true);
        expect(esConsultaSobreCobro(['¿Por qué me cobran octubre si no fue?'])).toBe(true);
        expect(esConsultaSobreCobro(['me llegó el estado de cuenta'])).toBe(true);
        expect(esConsultaSobreCobro(['me puedes aclarar eso'])).toBe(true);
    });

    it('anunciar o mandar un comprobante NO es una consulta', () => {
        expect(esConsultaSobreCobro([
            'Hola, envío el comprobante de pago de Mensualidad 10/2026 - Sub 13 (octubre 2026) de Ana. (ref. ABCD1234)',
        ])).toBe(false);
        expect(esConsultaSobreCobro(['ya pagué', 'te mando el soporte de la mensualidad'])).toBe(false);
        expect(esConsultaSobreCobro(['Muy buenos dias', 'Cómo estas', null, undefined, ''])).toBe(false);
    });
});

describe('pareceComprobanteDePago — la regla', () => {
    it('comprobante con monto y referencia, o con fecha y banco', () => {
        expect(pareceComprobanteDePago(COMPROBANTE as any)).toBe(true);
        expect(pareceComprobanteDePago({ ...COMPROBANTE, reference: null } as any)).toBe(true);
    });
    it('correo de cobro / estado de cuenta: monto y fecha sin transacción → no', () => {
        expect(pareceComprobanteDePago(CORREO_DE_COBRO as any)).toBe(false);
        expect(pareceComprobanteDePago({ ...COMPROBANTE, reference: null, bank: 'Otro' } as any)).toBe(false);
    });
    it('no es comprobante, es listado, o sin monto → no', () => {
        expect(pareceComprobanteDePago({ ...COMPROBANTE, isReceipt: false } as any)).toBe(false);
        expect(pareceComprobanteDePago({ ...COMPROBANTE, isTransactionList: true } as any)).toBe(false);
        expect(pareceComprobanteDePago({ ...COMPROBANTE, amount: null } as any)).toBe(false);
        expect(pareceComprobanteDePago(null)).toBe(false);
    });
});

describe('runWhatsAppQueue — adjunto con consulta', () => {
    it('familia sin cuenta + reclamo (caso Beverly): consulta a la escuela, sin «comprobante», sin enlace, fila NO escalated', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.mensajes = TEXTOS_BEVERLY.map((t) => ({ text_body: t }));
        state.vigente = { invitacion: { invite_id: 'inv-1', email: 'mama@x.com' }, atletaInactivo: false };
        extractReceiptMock.mockResolvedValue(CORREO_DE_COBRO);

        await runWhatsAppQueue();

        expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
        const [texto] = textosEnviados();
        expect(texto).not.toMatch(/comprobante/i);
        expect(texto).not.toContain('/register');
        expect(texto).toMatch(/escuela/);
        // El texto ya lo decide: no se gasta OCR ni se busca la invitación.
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(invitacionPendienteVigenteMock).not.toHaveBeenCalled();
        // Handoff humano: la conversación pasa a la escuela.
        expect(abrirConsultaMock).toHaveBeenCalledWith(expect.anything(), 'conv-1', '573001234567', 'consulta_con_adjunto');
        // No queda como comprobante a aplicar.
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none' });
        expect(ultimoCierre().error_message).toMatch(/^consulta_no_comprobante/);
        // El archivo sí se guarda: la escuela lo ve en la conversación.
        expect(downloadMediaMock).toHaveBeenCalled();
    });

    it('familia sin cuenta, sin texto, la lectura es un correo de cobro: consulta, no «Recibí tu comprobante»', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        extractReceiptMock.mockResolvedValue(CORREO_DE_COBRO);

        await runWhatsAppQueue();

        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
        expect(textosEnviados()[0]).not.toMatch(/comprobante/i);
        expect(abrirConsultaMock).toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none' });
    });

    it('familia sin cuenta, la imagen NO es comprobante (isReceipt=false) y nada habla de pagar: silencio (2026-10-09)', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, provider: 'gemini' });

        await runWhatsAppQueue();

        expect(sendTextMessageMock).not.toHaveBeenCalled();
        expect(abrirConsultaMock).not.toHaveBeenCalled();
        // El archivo queda guardado: la escuela lo ve en el buzón.
        expect(downloadMediaMock).toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none', error_message: 'no_es_comprobante_sin_contexto' });
    });

    it('familia sin cuenta, la imagen NO es comprobante pero habla de un pago: consulta', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.mensajes = [{ text_body: 'aquí el pago de octubre' }];
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, provider: 'gemini' });

        await runWhatsAppQueue();

        expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
        expect(textosEnviados()[0]).not.toMatch(/comprobante/i);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none' });
        expect(ultimoCierre().error_message).toMatch(/^consulta_no_comprobante/);
    });

    it('familia sin cuenta, OCR caído y sin reclamo: sigue como antes (escalated a la escuela)', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        extractReceiptMock.mockRejectedValue(new Error('503'));

        await runWhatsAppQueue();

        expect(textosEnviados()[0]).toMatch(/todavía no tienes tu cuenta creada/);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated', error_message: 'familia_sin_cuenta' });
        expect(abrirConsultaMock).not.toHaveBeenCalled();
    });

    it('número ambiguo + reclamo: consulta, no «más de una cuenta… lo aplique»', async () => {
        state.atencion = { atender: true, tipo: 'ambiguo', botEncendido: true };
        state.mensajes = [{ text_body: 'no entiendo porque me estan cobrando?' }];

        await runWhatsAppQueue();

        expect(textosEnviados()[0]).not.toMatch(/comprobante/i);
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none' });
    });

    it('familia identificada + reclamo + captura de un correo: consulta, no se busca a qué cobro aplicarlo', async () => {
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };
        state.mensajes = TEXTOS_BEVERLY.map((t) => ({ text_body: t }));
        extractReceiptMock.mockResolvedValue(CORREO_DE_COBRO);

        await runWhatsAppQueue();

        expect(pagosPendientesDeMock).not.toHaveBeenCalled();
        expect(textosEnviados()[0]).not.toMatch(/comprobante/i);
        expect(abrirConsultaMock).toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'none' });
    });

    it('familia identificada + reclamo + comprobante REAL: el comprobante se aplica igual', async () => {
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };
        state.mensajes = [{ text_body: 'ya pagué, no entiendo porque me siguen cobrando' }];

        await runWhatsAppQueue();

        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-9', 'school-1');
        expect(abrirConsultaMock).not.toHaveBeenCalled();
    });

    it('familia sin cuenta con comprobante real pero atleta inactivo: sin enlace de registro', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.vigente = { invitacion: null, atletaInactivo: true };

        await runWhatsAppQueue();

        expect(textosEnviados()[0]).toMatch(/todavía no tienes tu cuenta creada/);
        expect(textosEnviados()[0]).not.toContain('/register');
    });
});

// ─── Marcas manuales de no-familia (2026-10-13) ─────────────────────────────

describe('decidirAdjunto — negocio, otro club y plataforma valen lo mismo que personal', () => {
    it('silencio, incluso sobre staff', () => {
        for (const tipo of ['negocio', 'otro_club', 'plataforma', 'equipo'] as const) {
            expect(decidirAdjunto({ botEncendido: true, tipo, esStaffAdmin: false })).toBe('silencio');
            expect(decidirAdjunto({ botEncendido: true, tipo, esStaffAdmin: true })).toBe('silencio');
        }
    });
});

describe('runWhatsAppQueue — marcado personal pero «también es familia»', () => {
    it('su comprobante se aplica al cobro del hijo, sin escribirle', async () => {
        state.atencion = { atender: false, tipo: 'familia', botEncendido: true, tomada: false, tambienFamilia: true };
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };

        await runWhatsAppQueue();

        expect(extractReceiptMock).toHaveBeenCalled();
        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-9', 'school-1');
        expect(sendTextMessageMock).not.toHaveBeenCalled();
    });
});

// ─── Seguridad del cobro por WhatsApp (2026-10-07) ───────────────────────────

describe('runWhatsAppQueue — límite de comprobantes y revinculación', () => {
    function conRpc(extra: Record<string, any>) {
        const base = rpcMock.getMockImplementation()!;
        rpcMock.mockImplementation(((name: string) => (name in extra
            ? Promise.resolve(extra[name]) : base(name))) as any);
        return () => rpcMock.mockImplementation(base);
    }

    it('pasado del tope: guarda el archivo, NO llama al OCR y la fila queda escalada', async () => {
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };
        const restaurar = conRpc({ wa_reservar_cupo_ocr: { data: { permitido: false, motivo: 'limite_numero' }, error: null } });
        try {
            await runWhatsAppQueue();
        } finally { restaurar(); }

        expect(downloadMediaMock).toHaveBeenCalled();
        expect(extractReceiptMock).not.toHaveBeenCalled();
        expect(pagosPendientesDeMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated', error_message: 'limite_ocr: limite_numero' });
        for (const t of textosEnviados()) expect(t).not.toMatch(/l[ií]mite|demasiad/i);
    });

    it('dentro del tope: sigue al OCR como siempre', async () => {
        state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-9' } };
        const restaurar = conRpc({ wa_reservar_cupo_ocr: { data: { permitido: true, motivo: 'ok' }, error: null } });
        try {
            await runWhatsAppQueue();
        } finally { restaurar(); }
        expect(extractReceiptMock).toHaveBeenCalled();
        expect(pagosPendientesDeMock).toHaveBeenCalledWith('parent-9', 'school-1');
    });

    it('revinculación pendiente: NO usa el vínculo viejo de la conversación (no aplica a cobros de otra familia)', async () => {
        state.conv = { data: { id: 'conv-1', parent_id: 'parent-viejo', identified: true } };
        state.rpcIdentifyByPhone = { data: { estado: 'revinculacion_pendiente' } };

        await runWhatsAppQueue();

        expect(pagosPendientesDeMock).not.toHaveBeenCalled();
        expect(ultimoCierre()).toMatchObject({ status: 'ignored', result_type: 'escalated' });
    });
});
