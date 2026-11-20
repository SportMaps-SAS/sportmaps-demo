/**
 * Una respuesta por comprobante (2026-10-07).
 *
 * Datos reales de Dynasty (integración f50d6940…, 6-7 oct): por cada
 * comprobante la familia recibía 3–5 mensajes del bot. En 48 h, 81 ráfagas de
 * adjuntos: de las 38 que recibieron respuesta, mediana 2 mensajes, máximo 8,
 * 18 con 3 o más. Secuencias reproducidas acá (envíos mockeados), afirmando
 * CUÁNTOS mensajes salen:
 *
 *  - …9ed973: acuse con presentación + acuse «¡Gracias! Ya recibí…» en el mismo
 *    segundo + resultado 40 s después  → ahora 1 (presentación + resultado).
 *  - …b62e3f: resultado + 2 s después la pregunta del consentimiento → ahora 1
 *    (la pregunta al pie, con sus botones).
 *  - …8804c0: acuse + debe_registrarse + familia_sin_cuenta (con el párrafo de
 *    la cuenta otra vez) → ahora 1, corto.
 *  - ráfaga de 2 fotos → 1 mensaje que resume, cada una aplicada a su cobro.
 *  - cola lenta (> ACUSE_DIFERIDO_MS) → acuse + resultado; rápida → solo el resultado.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    rpcIdentifyByPhone: { data: { estado: 'desconocido' } as any },
    atencion: { atender: true, tipo: 'familia', botEncendido: true } as any,
    /** ¿El bot ya dijo «no tienes cuenta» en las últimas 24 h? */
    dijoSinCuenta: false,
    /** ¿Es la primera respuesta automática de la conversación? */
    primera: true,
    /** ¿Falta preguntar el consentimiento? */
    faltaConsentimiento: true,
    claim: [] as any[],
    ocrDemoraMs: 0,
    /** Fichas con el celular del contacto (familia sin cuenta). */
    ninos: [] as any[],
    /** Textos del contacto alrededor del archivo. */
    textos: [] as any[],
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
    id, integration_id: 'int-1', school_id: 'school-1', wa_phone_number: '573001234567',
    wa_message_id: `wamid.${id}`, media_id: `media-${id}`, media_mime_type: 'image/jpeg',
    storage_path: null, retries: 0, created_at: new Date().toISOString(), ...extra,
});

/** Lo que se registra en whatsapp_messages (cada mensaje que SALE del worker). */
const registrados: any[] = [];
const rpcMock = vi.fn((name: string, args?: any) => {
    if (name === 'wa_queue_claim') return Promise.resolve({ data: state.claim, error: null });
    if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve({ data: { estado: 'desconocido' } });
    if (name === 'wa_identify_by_phone') return Promise.resolve(state.rpcIdentifyByPhone);
    if (name === 'wa_record_outbound_message') registrados.push(args);
    return Promise.resolve({ data: null, error: null });
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'school_whatsapp_integrations') {
                return makeChain({ data: { id: 'int-1', school_id: 'school-1', access_token: 'tok', phone_number_id: 'pn-1' } }, table);
            }
            if (table === 'whatsapp_conversations') return makeChain(state.conv, table);
            if (table === 'children') return makeChain({ data: state.ninos, error: null }, table);
            if (table === 'whatsapp_messages') {
                // Salientes: solo responde «ya se dijo sin cuenta» (consulta con .in del paso).
                const result: any = { data: [], error: null };
                const chain = makeChain(result, table);
                let saliente = false;
                chain.eq = (col: string, val: any) => {
                    if (col === 'direction' && val === 'outbound') saliente = true;
                    if (col === 'direction' && val === 'inbound') result.data = state.textos;
                    return chain;
                };
                chain.in = (col: string) => {
                    if (saliente && col === 'payload->>step' && state.dijoSinCuenta) result.data = [{ id: 'm-prev' }];
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
    invitacionPendienteVigente: vi.fn(() => Promise.resolve({ invitacion: null, atletaInactivo: false })),
}));

const BOTONES = [{ id: 'si', title: 'Sí, acepto' }, { id: 'no', title: 'No, gracias' }];
const PREGUNTA = 'Una cosa más 🙂 ¿Quieres recordatorios?\n\nResponde *SÍ* para activarlos.';
const acusarAdjuntoMock = vi.fn((..._a: any[]) => Promise.resolve('acusado'));
const ofrecerConsentimientoMock = vi.fn((..._a: any[]) => Promise.resolve(true));
vi.mock('../services/whatsapp-bot.service', () => ({
    abrirConsultaParaLaEscuela: vi.fn(() => Promise.resolve()),
    ofrecerConsentimientoSiFalta: (...a: any[]) => ofrecerConsentimientoMock(...a),
    acusarAdjunto: (...a: any[]) => acusarAdjuntoMock(...a),
    conPresentacionSiEsPrimera: vi.fn(async (_w: any, _c: string, t: string) => {
        if (!state.primera) return t;
        state.primera = false;
        return `Hola 👋 soy el asistente automático de DYNASTY VOLLEY CLUB.\n\n${t}`;
    }),
    anexoDeConsentimiento: vi.fn(async () => (state.faltaConsentimiento ? { texto: PREGUNTA } : null)),
    BOTONES_CONSENTIMIENTO: BOTONES,
}));

const extractReceiptMock = vi.fn();
vi.mock('../services/ocr.service', () => ({ extractReceipt: (...a: any[]) => extractReceiptMock(...a) }));
vi.mock('../services/enrollment-ocr.service', () => ({ extractEnrollmentForm: vi.fn() }));
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: vi.fn(() => Promise.resolve({ registeredAccounts: [] })),
}));
vi.mock('../services/receipt-verdict', () => ({
    normalizeDestination: (d: any) => d,
    normalizeReference: (r: any) => r,
    destinationMatchesRegistered: () => true,
    evaluateVerdict: vi.fn(() => ({ verdict: 'YELLOW', reasons: [] })),
}));
vi.mock('../services/receipt-approval.service', () => ({
    evaluatePaymentReceipt: vi.fn(() => Promise.resolve({ action: 'manual_review' })),
    redRejectionMessage: vi.fn(() => ''),
}));

const PAGOS = [
    { id: 'p-sep', concept: 'Mensualidad 09/2026', amount: 90000, child_id: 'c1' },
    { id: 'p-oct', concept: 'Mensualidad 10/2026', amount: 180000, child_id: 'c1' },
];
const resolverPagoMock = vi.fn();
vi.mock('../services/whatsapp-receipt-matching.service', () => ({
    pagosPendientesDe: vi.fn(() => Promise.resolve(PAGOS)),
    resolverPago: (...a: any[]) => resolverPagoMock(...a),
    describirPago: (p: any) => p.concept,
    // (pronto pago, otro agente) el cobro se cubre con el valor completo o con el descuento.
    montoAPagar: (p: any) => Number(p.amount) - Number(p.descuento ?? 0),
    montoCubreElCobro: (p: any, monto: number | null) => monto !== null && Number(p.amount) === monto,
    mensajeElegirPago: () => 'elige',
}));

const { runWhatsAppQueue, resumirRafaga, _fijarEsperaAcuse, ACUSE_DIFERIDO_MS } = await import('./whatsapp-queue.job');

const comprobante = (amount: number, reference: string) => ({
    isReceipt: true, isTransactionList: false, amount, destination: null,
    reference, bank: 'Bancolombia', date: '2026-10-06', provider: 'gemini',
});

/** Mensajes que salieron a la familia (texto + interactivos) y acuses diferidos. */
const enviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const mensajesDelBot = () => enviados().length + acusarAdjuntoMock.mock.calls.length;

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    registrados.length = 0;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-1' } };
    state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    state.dijoSinCuenta = false;
    state.primera = true;
    state.faltaConsentimiento = true;
    state.claim = [FILA('f1')];
    state.ocrDemoraMs = 0;
    state.ninos = [];
    state.textos = [];
    extractReceiptMock.mockImplementation(async () => {
        if (state.ocrDemoraMs) await new Promise((r) => setTimeout(r, state.ocrDemoraMs));
        return comprobante(180000, 'REF-OCT');
    });
    resolverPagoMock.mockImplementation((_p: any[], monto: number) =>
        ({ tipo: 'unico', pago: PAGOS.find((p) => p.amount === monto) ?? PAGOS[1] }));
    _fijarEsperaAcuse(ACUSE_DIFERIDO_MS);
});

afterEach(() => _fijarEsperaAcuse(ACUSE_DIFERIDO_MS));

describe('…9ed973 / …b62e3f: familia con cuenta, una foto', () => {
    it('UN mensaje: presentación + resultado + consentimiento al pie con botones', async () => {
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(sendTextMessageMock).not.toHaveBeenCalled();
        const [, , cuerpo, botones] = sendInteractiveButtonsMock.mock.calls[0];
        expect(cuerpo.startsWith('Hola 👋 soy el asistente automático')).toBe(true);
        expect(cuerpo).toContain('Listo: comprobante de *$180.000* para *octubre*. La escuela lo confirma.');
        expect(cuerpo.indexOf('Listo: comprobante')).toBeLessThan(cuerpo.indexOf('Responde *SÍ*'));
        expect(botones).toEqual(BOTONES);
        // Ni la pregunta aparte ni el acuse.
        expect(ofrecerConsentimientoMock).not.toHaveBeenCalled();
        expect(acusarAdjuntoMock).not.toHaveBeenCalled();
        expect(registrados).toHaveLength(1);
        expect(registrados[0]).toMatchObject({ p_type: 'interactive' });
        expect(registrados[0].p_payload).toMatchObject({ step: 'resultado_comprobante', pregunta: 'ask_consent', queue_id: 'f1' });
    });

    it('ya presentado y consentimiento ya preguntado: UN mensaje de texto con solo el resultado', async () => {
        state.primera = false;
        state.faltaConsentimiento = false;
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(enviados()[0]).toMatch(/^Listo: comprobante de \*\$180\.000\* para \*octubre\*/);
    });

    it('si Meta rechaza los botones, sale el MISMO mensaje como texto (uno, no dos)', async () => {
        sendInteractiveButtonsMock.mockResolvedValueOnce({ ok: false, error: 'no_cabe' } as any);
        await runWhatsAppQueue();
        expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
        expect(sendTextMessageMock.mock.calls[0][2]).toContain('Responde *SÍ*');
        expect(registrados).toHaveLength(1);
        expect(registrados[0]).toMatchObject({ p_type: 'text' });
    });

    it('…b62e3f 21:06: comprobante repetido → UN mensaje, sin consentimiento al pie', async () => {
        // El estampado choca con la referencia ya usada (23505).
        const { supabase } = await import('../config/supabase');
        const fromOriginal = (supabase.from as any).getMockImplementation();
        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'payments') {
                const c = makeChain({ data: null, error: { code: '23505', message: 'dup' } }, table);
                c.maybeSingle = () => Promise.resolve({ data: { id: 'p-sep', concept: 'Mensualidad 09/2026', amount: 90000, status: 'awaiting_approval' } });
                return c;
            }
            return fromOriginal(table);
        });
        try {
            await runWhatsAppQueue();
        } finally {
            (supabase.from as any).mockImplementation(fromOriginal);
        }
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toContain('Ese comprobante ya lo había recibido');
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        // Bandeja: la fila queda con el pago que ya tiene esa referencia.
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({
            result_type: 'none', result_ref_id: 'p-sep', error_message: 'referencia ya usada: REF-OCT' });
    });
});

describe('…8804c0: familia sin cuenta', () => {
    beforeEach(() => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.primera = false;
    });

    it('primera vez: UN mensaje con el párrafo de la cuenta; la fila anota el atleta de la ficha', async () => {
        state.ninos = [{ id: 'child-1' }];
        await runWhatsAppQueue();
        expect(updatesCola).toContainEqual({ matched_child_id: 'child-1' });
        expect(mensajesDelBot()).toBe(1);
        // (2026-11-16) Ya no se habla de la cuenta con un comprobante en la mano.
        expect(enviados()[0]).toContain('La escuela lo revisa y te confirma por aquí');
        expect(enviados()[0]).not.toMatch(/cuenta/i);
    });

    it('el bot ya dijo debe_registrarse / familia_sin_cuenta en 24 h: UN mensaje corto, sin el párrafo', async () => {
        state.dijoSinCuenta = true;
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toBe('Recibí tu comprobante 📄 Se lo paso a la escuela para que lo aplique.');
        expect(enviados()[0]).not.toContain('cuenta');
    });
});

describe('ráfaga: 2 fotos del mismo contacto en el lote', () => {
    it('cada una se aplica a su cobro y sale UN mensaje que resume', async () => {
        state.claim = [FILA('f1'), FILA('f2')];
        extractReceiptMock
            .mockResolvedValueOnce(comprobante(90000, 'REF-SEP'))
            .mockResolvedValueOnce(comprobante(180000, 'REF-OCT'));
        state.primera = false;
        await runWhatsAppQueue();
        // Las dos filas cerradas como aplicadas, cada una a su pago.
        const cierres = updatesCola.filter((u) => u.status === 'done');
        expect(cierres.map((u) => u.result_ref_id)).toEqual(['p-sep', 'p-oct']);
        expect(mensajesDelBot()).toBe(1);
        const cuerpo = enviados()[0];
        expect(cuerpo).toMatch(/^Recibí tus 2 comprobantes:/);
        expect(cuerpo).toContain('Mensualidad 09/2026');
        expect(cuerpo).toContain('Mensualidad 10/2026');
        expect(cuerpo).toContain('Responde *SÍ*');
        expect(registrados[0].p_payload).toMatchObject({ step: 'resultado_rafaga', queue_ids: ['f1', 'f2'] });
    });

    it('dos fotos de una familia sin cuenta: un solo «Recibí tus 2 comprobantes»', async () => {
        state.claim = [FILA('f1'), FILA('f2')];
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.primera = false;
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toMatch(/^Recibí tus 2 comprobantes 📄 La escuela lo revisa y te confirma por aquí/);
    });

    it('fotos de DOS contactos distintos no se mezclan', async () => {
        state.claim = [FILA('f1'), FILA('f2', { wa_phone_number: '573009999999' })];
        state.primera = false;
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(2);
    });
});

describe('acuse diferido', () => {
    it('cola rápida: no hay acuse, solo el resultado', async () => {
        await runWhatsAppQueue();
        await new Promise((r) => setTimeout(r, 20));
        expect(acusarAdjuntoMock).not.toHaveBeenCalled();
        expect(mensajesDelBot()).toBe(1);
    });

    it('cola lenta (pasó el umbral sin resultado): UN acuse y luego el resultado', async () => {
        _fijarEsperaAcuse(10);
        state.ocrDemoraMs = 80;
        await runWhatsAppQueue();
        expect(acusarAdjuntoMock).toHaveBeenCalledTimes(1);
        expect(acusarAdjuntoMock.mock.calls[0].slice(1, 4)).toEqual(['conv-1', '573001234567', 'wamid.f1']);
        expect(mensajesDelBot()).toBe(2);
    });

    it('fila vieja ya reintentada: no se vuelve a acusar', async () => {
        _fijarEsperaAcuse(0);
        state.claim = [FILA('f1', { retries: 1, created_at: new Date(Date.now() - 10 * 60_000).toISOString() })];
        state.ocrDemoraMs = 30;
        await runWhatsAppQueue();
        expect(acusarAdjuntoMock).not.toHaveBeenCalled();
    });

    it('bot apagado o contacto no atendido: ni acuse ni respuesta', async () => {
        _fijarEsperaAcuse(0);
        for (const a of [
            { atender: false, tipo: 'familia', botEncendido: false },
            { atender: false, tipo: 'personal', botEncendido: true },
        ]) {
            state.atencion = a;
            await runWhatsAppQueue();
        }
        await new Promise((r) => setTimeout(r, 20));
        expect(mensajesDelBot()).toBe(0);
    });
});

describe('resumirRafaga (pura)', () => {
    it('una sola respuesta: tal cual', () => {
        expect(resumirRafaga([{ texto: 'A', paso: 'x', queueId: '1' }])).toEqual({ texto: 'A', paso: 'x' });
    });
    it('textos distintos: numerados bajo «Recibí tus N comprobantes:»', () => {
        const r = resumirRafaga([
            { texto: 'Uno', paso: 'resultado_comprobante', queueId: '1' },
            { texto: 'Dos', paso: 'comprobante_repetido', queueId: '2' },
        ]);
        expect(r.paso).toBe('resultado_rafaga');
        expect(r.texto).toBe('Recibí tus 2 comprobantes:\n\n*1.* Uno\n\n*2.* Dos');
    });
});

describe('Bandeja: número desconocido', () => {
    beforeEach(() => { state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true }; });

    it('anuncia un pago («Mira mile mi pago de este mes») y no es un comprobante: se GUARDA el archivo y no se le responde', async () => {
        state.textos = [{ text_body: 'Mira mile mi pago de este mes' }];
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: null });
        await runWhatsAppQueue();
        expect(downloadMediaMock).toHaveBeenCalledTimes(1);
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({ error_message: 'contacto_no_atendido' });
        expect(mensajesDelBot()).toBe(0);
    });

    it('pie «Mes octubre»: también se guarda', async () => {
        state.claim = [FILA('f1', { media_caption: 'Julian Santiago\nInfantil Masculino\nMes octubre' })];
        await runWhatsAppQueue();
        expect(downloadMediaMock).toHaveBeenCalledTimes(1);
    });

    it('(I-1) sin hablar de pagos y sin destino leído, pero con un comprobante completo (monto + referencia): NO se le responde y SÍ queda en la bandeja con el archivo', async () => {
        state.textos = [{ text_body: 'Urgente' }];
        await runWhatsAppQueue();
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({ result_type: 'escalated' });
        expect(updatesCola.find((u) => u.status === 'ignored').error_message).toMatch(/^sin_familia: captura_sin_contexto/);
        expect(mensajesDelBot()).toBe(0);
    });

    it('sin hablar de pagos y la imagen NO es un comprobante (un afiche con un precio): sigue sin ruido, sin guardar', async () => {
        state.textos = [{ text_body: 'Urgente' }];
        extractReceiptMock.mockResolvedValue({ isReceipt: false, isTransactionList: false, amount: 90000, destination: null });
        await runWhatsAppQueue();
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({ result_type: 'none', error_message: 'contacto_no_atendido' });
        expect(mensajesDelBot()).toBe(0);
    });

    it('contacto PERSONAL: se lee (un comprobante nunca se ignora por el tipo de contacto, 2026-10-24) pero NUNCA se le responde', async () => {
        state.atencion = { atender: false, tipo: 'personal', botEncendido: true };
        state.textos = [{ text_body: 'te mando el pago' }];
        await runWhatsAppQueue();
        // Sin cuentas de la escuela con qué cruzar el destino: no se guarda ni se escala.
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(false);
        expect(mensajesDelBot()).toBe(0);
    });
});

describe('auditoría 2026-10-07 (…0340): la MISMA foto dos veces', () => {
    /** payments responde «esta imagen ya está en p-oct»; la cola, si ya se avisó hace < 10 min. */
    async function conImagenYaRecibida(avisadoHacePoco: boolean, correr: () => Promise<unknown>) {
        const { supabase } = await import('../config/supabase');
        const fromOriginal = (supabase.from as any).getMockImplementation();
        (supabase.from as any).mockImplementation((table: string) => {
            if (table === 'payments') {
                return makeChain({ data: [{ id: 'p-oct', concept: 'Mensualidad 10/2026', status: 'paid' }], error: null }, table);
            }
            if (table === 'whatsapp_inbound_queue') {
                return makeChain({ data: avisadoHacePoco ? [{ id: 'f-antes' }] : [], error: null }, table);
            }
            return fromOriginal(table);
        });
        try {
            await correr();
        } finally {
            (supabase.from as any).mockImplementation(fromOriginal);
        }
    }

    it('segunda foto igual → «Este comprobante ya lo había recibido 👍», nunca «no tienes cobros pendientes»', async () => {
        state.primera = false;
        state.faltaConsentimiento = false;
        await conImagenYaRecibida(false, () => runWhatsAppQueue());
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toBe('Este comprobante ya lo había recibido 👍');
        expect(enviados()[0]).not.toContain('no tienes cobros pendientes');
        expect(resolverPagoMock).not.toHaveBeenCalled();
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({
            result_type: 'none', result_ref_id: 'p-oct', error_message: 'comprobante ya recibido (misma imagen)' });
    });

    it('si ya se le dijo hace < 10 min → silencio (la fila igual se cierra)', async () => {
        state.primera = false;
        state.faltaConsentimiento = false;
        await conImagenYaRecibida(true, () => runWhatsAppQueue());
        expect(enviados()).toHaveLength(0);
        expect(updatesCola.find((u) => u.status === 'ignored')).toMatchObject({ result_ref_id: 'p-oct' });
    });
});

// ─── «No es un comprobante» solo con contexto de pago (2026-10-09) ──────────
//
// En 7 días el aviso salió 11 veces y ninguna con texto de pago (fotos del
// entrenamiento, etc.). Datos inventados: ninguna conversación real.

describe('no es comprobante: solo se responde si hay contexto de pago', () => {
    const FOTO_ENTRENAMIENTO = {
        isReceipt: false, isTransactionList: false, amount: null, bank: null,
        destination: null, reference: null, rawText: null, provider: 'gemini',
    };
    const QR_DE_PAGO = {
        isReceipt: false, isTransactionList: false, amount: null, bank: 'Nequi',
        destination: '3001234567', reference: null, rawText: 'Escanea este código QR para pagar', provider: 'gemini',
    };
    const cierre = () => updatesCola.find((u) => u.status === 'ignored');

    it('familia: foto del entrenamiento sin texto → 0 mensajes, ignored no_es_comprobante_sin_contexto', async () => {
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(0);
        expect(cierre()).toMatchObject({ result_type: 'none', error_message: 'no_es_comprobante_sin_contexto' });
        // El archivo queda guardado para el buzón.
        expect(updatesCola.some((u) => typeof u.storage_path === 'string')).toBe(true);
    });

    it('familia: foto con charla que no habla de pagos → 0 mensajes', async () => {
        state.textos = [{ text_body: 'Qué buen entrenamiento el de hoy' }];
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(0);
        expect(cierre()).toMatchObject({ error_message: 'no_es_comprobante_sin_contexto' });
    });

    it('familia: pie «aquí el pago de octubre» y no es comprobante → 1 mensaje «no es un comprobante»', async () => {
        state.claim = [FILA('f1', { media_caption: 'aquí el pago de octubre' })];
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toContain('no es un comprobante de pago');
        expect(cierre()).toMatchObject({ error_message: 'no es un comprobante' });
    });

    it('familia: texto de pago en los ±10 min («ya te transferí») → 1 mensaje', async () => {
        state.textos = [{ text_body: 'Ya te transferí' }];
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toContain('no es un comprobante de pago');
    });

    it('familia: QR de pago sin texto → 1 mensaje (la lectura muestra la llave)', async () => {
        extractReceiptMock.mockResolvedValue(QR_DE_PAGO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toContain('no es un comprobante de pago');
        expect(extractReceiptMock).toHaveBeenCalledTimes(1);
    });

    it('familia sin cuenta con ficha: foto del entrenamiento sin texto → 0 mensajes', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.ninos = [{ id: 'c1', parent_phone_temp: '3001234567' }];
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(0);
        expect(cierre()).toMatchObject({ result_type: 'none', error_message: 'no_es_comprobante_sin_contexto' });
    });

    it('familia sin cuenta con ficha: QR de pago sin texto → 1 mensaje', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        state.ninos = [{ id: 'c1', parent_phone_temp: '3001234567' }];
        extractReceiptMock.mockResolvedValue(QR_DE_PAGO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(1);
        expect(enviados()[0]).toContain('no es un comprobante de pago');
    });

    it('familia sin cuenta SIN ficha: foto del entrenamiento sin texto → 0 mensajes (no se abre consulta)', async () => {
        state.atencion = { atender: true, tipo: 'familia_sin_cuenta', botEncendido: true };
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(0);
        expect(cierre()).toMatchObject({ result_type: 'none', error_message: 'no_es_comprobante_sin_contexto' });
    });

    it('desconocido: foto del entrenamiento sin texto → 0 mensajes (como antes)', async () => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
        extractReceiptMock.mockResolvedValue(FOTO_ENTRENAMIENTO);
        await runWhatsAppQueue();
        expect(mensajesDelBot()).toBe(0);
    });
});

describe('contexto de pago — las reglas puras', () => {
    it('textos: hablan de pago o no', async () => {
        const { textosConContextoDePago } = await import('./whatsapp-queue.job');
        for (const t of ['aquí el pago de octubre', 'Pagué la mensualidad', 'consigné por Bancolombia',
            'te mando la llave Bre-B', 'el QR para pagar', 'cuota de noviembre', 'Mes octubre', 'por Daviplata']) {
            expect(textosConContextoDePago([t])).toBe(true);
        }
        for (const t of ['Qué buen entrenamiento', 'mira la foto del partido', 'gracias profe', 'página', null, '']) {
            expect(textosConContextoDePago([t])).toBe(false);
        }
    });

    it('lectura: pantalla bancaria / QR / llave sí; foto cualquiera no', async () => {
        const { lecturaSugierePantallaDePago } = await import('./whatsapp-queue.job');
        expect(lecturaSugierePantallaDePago({ isReceipt: false, bank: 'Nequi' } as any)).toBe(true);
        expect(lecturaSugierePantallaDePago({ isReceipt: false, destination: '@llave123' } as any)).toBe(true);
        expect(lecturaSugierePantallaDePago({ isReceipt: false, rawText: 'Escanea el código QR' } as any)).toBe(true);
        expect(lecturaSugierePantallaDePago({ isReceipt: false, bank: 'Otro', rawText: 'Club 2026 Sub 13' } as any)).toBe(false);
        expect(lecturaSugierePantallaDePago({ isReceipt: false, bank: null, destination: null, rawText: null } as any)).toBe(false);
        expect(lecturaSugierePantallaDePago(null)).toBe(false);
    });
});
