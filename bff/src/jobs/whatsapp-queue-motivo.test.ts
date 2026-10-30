/**
 * Comprobantes con motivo (plan B4, docs/specs/whatsapp-monster-plan-B4.md §5).
 *
 * Primero la CARACTERIZACIÓN: con el interruptor `wa_cobro_desde_comprobante`
 * apagado (como nace en todas las escuelas) la cola responde exactamente como
 * hoy — pregunta del mes, [Mensualidad][Inscripción][Otro], otro concepto a la
 * escuela, ráfaga sin botones y prospecto sin ficha. Dynasty, Dreamers y las
 * demás no pueden notar el cambio. Datos inventados con la forma de los reales.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// La primera foto carga en frío los servicios que la cola importa perezoso.
vi.setConfig({ testTimeout: 30_000 });

const state = {
    conv: { data: { id: 'conv-1', parent_id: null, identified: false } as any },
    rpcIdentifyByPhone: { data: { estado: 'identificado', parent_id: 'parent-1' } as any },
    atencion: { atender: true, tipo: 'familia', botEncendido: true } as any,
    claim: [] as any[],
    textos: [] as any[],
    cuentas: ['3001112222'] as string[],
    children: [] as any[],
    enrollments: [] as any[],
    // ─── B4 ───
    interruptor: false,
    esperados: [] as any[],
    leads: [] as any[],
    trialPrice: null as number | null,
    planes: [] as any[],
    articulos: [] as any[],
    servicios: [] as any[],
    /** Filas de la cola tal como quedaron después de cada update (por id). */
    cola: {} as Record<string, any>,
    rpcCrear: null as null | ((args: any) => any),
};

const updatesCola: any[] = [];
const updatesPagos: any[] = [];
const updatesOtras: { table: string; v: any }[] = [];
const registrados: any[] = [];

function makeChain(result: any, table?: string) {
    const chain: any = {
        select: () => chain, eq: () => chain, in: () => chain, or: () => chain, gte: () => chain, gt: () => chain,
        lte: () => chain, lt: () => chain, ilike: () => chain, limit: () => chain, order: () => chain, neq: () => chain,
        is: () => chain, not: () => chain, insert: () => chain, upsert: () => chain,
        update: (v: any) => {
            if (table === 'payments') updatesPagos.push(v);
            else if (table) updatesOtras.push({ table, v });
            return chain;
        },
        maybeSingle: () => Promise.resolve(result),
        single: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    };
    return chain;
}

/**
 * La cola con memoria: cada update queda en `state.cola[id]`, así la segunda
 * foto de una ráfaga ve la pregunta abierta de la primera (fila de preguntas).
 */
function chainCola() {
    const filtros: [string, string, any][] = [];
    let update: any = null;
    const c: any = {};
    for (const m of ['select', 'in', 'or', 'gte', 'gt', 'lte', 'lt', 'ilike', 'limit', 'order', 'is', 'not', 'insert', 'upsert']) c[m] = () => c;
    c.eq = (col: string, v: any) => { filtros.push(['eq', col, v]); return c; };
    c.neq = (col: string, v: any) => { filtros.push(['neq', col, v]); return c; };
    c.update = (v: any) => { update = v; updatesCola.push(v); return c; };
    const correr = () => {
        const id = filtros.find(([op, col]) => op === 'eq' && col === 'id')?.[2];
        if (update) {
            if (id) state.cola[id] = { ...(state.cola[id] ?? { id }), ...update };
            return { data: [], error: null };
        }
        const filas = Object.values(state.cola).filter((r: any) => filtros.every(([op, col, v]) => {
            if (col === 'integration_id' || col === 'wa_phone_number') return true;
            return op === 'eq' ? r[col] === v : r[col] !== v;
        }));
        // Solo las preguntas que SALIERON (la consulta real filtra pregunta_at ≥ hace 24 h).
        return { data: filas.filter((r: any) => r.status !== 'waiting_user' || !!r.pregunta_at), error: null };
    };
    c.maybeSingle = () => Promise.resolve({ data: correr().data[0] ?? null, error: null });
    c.single = c.maybeSingle;
    c.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
    return c;
}

const FILA = (id: string, extra: Record<string, unknown> = {}) => ({
    id, integration_id: 'int-1', school_id: 'school-1', wa_phone_number: '573005550101',
    wa_message_id: `wamid.${id}`, media_id: `media-${id}`, media_mime_type: 'image/jpeg',
    storage_path: null, retries: 0, created_at: new Date().toISOString(), ...extra,
});

let pagosCreados = 0;
const rpcMock = vi.fn((name: string, args?: any) => {
    if (name === 'wa_queue_claim') return Promise.resolve({ data: state.claim, error: null });
    if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve({ data: { estado: 'desconocido' } });
    if (name === 'wa_identify_by_phone') return Promise.resolve(state.rpcIdentifyByPhone);
    if (name === 'wa_record_outbound_message') registrados.push(args);
    if (name === 'wa_crear_cobro_desde_comprobante') {
        if (state.rpcCrear) return Promise.resolve({ data: state.rpcCrear(args), error: null });
        pagosCreados += 1;
        return Promise.resolve({ data: { ok: true, payment_id: `pay-${pagosCreados}`, precio: args.p_monto, es_abono: false, ya_existia: false }, error: null });
    }
    if (name === 'wa_cubrir_cobros_con_comprobante') return Promise.resolve({ data: (args?.p_cobros ?? []).length, error: null });
    if (name === 'wa_es_afiliado') return Promise.resolve({ data: { afiliado: false }, error: null });
    return Promise.resolve({ data: null, error: null });
});

vi.mock('../config/supabase', () => ({
    supabase: {
        from: vi.fn((table: string) => {
            if (table === 'school_whatsapp_integrations') {
                return makeChain({ data: { id: 'int-1', school_id: 'school-1', access_token: 'tok', phone_number_id: 'pn-1' } }, table);
            }
            if (table === 'whatsapp_inbound_queue') return chainCola();
            if (table === 'whatsapp_conversations') return makeChain(state.conv, table);
            if (table === 'children') return makeChain({ data: state.children, error: null }, table);
            if (table === 'enrollments') return makeChain({ data: state.enrollments, error: null }, table);
            if (table === 'school_settings') return makeChain({ data: state.interruptor ? { wa_cobro_desde_comprobante: true } : {}, error: null }, table);
            if (table === 'whatsapp_conceptos_esperados') return makeChain({ data: state.esperados, error: null }, table);
            if (table === 'school_signup_leads') return makeChain({ data: state.leads, error: null }, table);
            if (table === 'school_trial_class_settings') return makeChain({ data: { trial_price: state.trialPrice }, error: null }, table);
            if (table === 'offering_plans') return makeChain({ data: state.planes, error: null }, table);
            if (table === 'school_merchandise_items') return makeChain({ data: state.articulos, error: null }, table);
            if (table === 'school_tournament_items') return makeChain({ data: state.servicios, error: null }, table);
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
vi.mock('../services/whatsapp.service', () => ({
    downloadMedia: vi.fn(() => Promise.resolve({ ok: true, base64: 'ZmFrZQ==', mimeType: 'image/jpeg' })),
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
vi.mock('../services/receipt-verdict', () => {
    // Igual que la real: exacta, o enmascarada («****2222») si una cuenta termina en esos dígitos.
    const clasificar = (d: any, a: any[]) => {
        if (!d || !a?.length) return 'none';
        if (a.includes(d)) return 'exact';
        const m = /[*]+(\d{4,})$/.exec(String(d));
        return m && a.some((x: string) => x.endsWith(m[1])) ? 'masked' : 'none';
    };
    return {
        normalizeDestination: (d: any) => d,
        normalizeReference: (r: any) => r,
        destinationMatchesRegistered: (d: any, a: any[]) => clasificar(d, a) !== 'none',
        classifyDestinationMatch: clasificar,
        maskedDestinationSuffix: () => null,
        evaluateVerdict: vi.fn(() => ({ verdict: 'amarillo', reasons: [] })),
    };
});
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

const deportistaPorNombreMock = vi.fn((..._a: any[]) => Promise.resolve(null as any));
vi.mock('../services/whatsapp-comprobante-de-ficha.service', async () => {
    const real = await vi.importActual<any>('../services/whatsapp-comprobante-de-ficha.service');
    return {
        ...real,
        fichasPorTelefono: vi.fn(() => Promise.resolve({ childIds: [], unregisteredIds: [] })),
        deportistaPorNombre: (...a: any[]) => deportistaPorNombreMock(...a),
        pendientesPorLlaves: vi.fn(() => Promise.resolve([])),
        pagoYaRegistrado: vi.fn(() => Promise.resolve(null)),
    };
});

const { runWhatsAppQueue, _fijarCargadorAgenda, TEXTO_CLASE_PRUEBA_A_PERSONA } = await import('./whatsapp-queue.job');
const bot = await import('../services/whatsapp-bot.service');
const { evaluateVerdict } = await import('../services/receipt-verdict');

const comprobante = (amount: number, extra: Record<string, unknown> = {}) => ({
    isReceipt: true, isTransactionList: false, amount, destination: '3001112222',
    reference: `REF-${amount}`, bank: 'Nequi', date: '2026-10-06', provider: 'gemini',
    originName: 'Pedro Gómez', description: null, ...extra,
});
const LAURA = { id: 'c1', full_name: 'Laura Peña' };
const OCT = { id: 'p-oct', amount: 180000, concept: 'Mensualidad 10/2026', due_date: '2026-10-10', child_id: 'c1', atleta: 'Laura Peña' };
const INSC = { id: 'p-insc', amount: 310000, concept: 'Inscripción — Laura Peña', due_date: '2026-10-01', child_id: 'c1', atleta: 'Laura Peña', categoria: 'inscripcion' };
const INSCRIPCION_LAURA = { child_id: 'c1', unregistered_athlete_id: null, monthly_fee: 180000, fee_is_manual: false, status: 'active', plan: { name: 'PRO', price: 180000, registration_fee: 310000 }, team: null };

const enviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const cierre = () => [...updatesCola].reverse().find((u) => u.status && u.status !== 'processing');
const llamadasRpc = (nombre: string) => rpcMock.mock.calls.filter((c) => c[0] === nombre);

beforeAll(async () => {
    await import('../services/whatsapp-recuperacion.service');
});

beforeEach(() => {
    vi.clearAllMocks();
    updatesCola.length = 0;
    updatesPagos.length = 0;
    registrados.length = 0;
    state.conv = { data: { id: 'conv-1', parent_id: null, identified: false } };
    state.rpcIdentifyByPhone = { data: { estado: 'identificado', parent_id: 'parent-1' } };
    state.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    state.claim = [FILA('f1')];
    state.textos = [];
    state.cuentas = ['3001112222'];
    state.children = [];
    state.enrollments = [];
    state.interruptor = false;
    state.esperados = [];
    state.leads = [];
    state.trialPrice = null;
    state.planes = [];
    state.articulos = [];
    state.servicios = [];
    state.cola = {};
    state.rpcCrear = null;
    updatesOtras.length = 0;
    pagosCreados = 0;
    _fijarCargadorAgenda(null);
    extractReceiptMock.mockResolvedValue(comprobante(150000));
    deportistaPorNombreMock.mockResolvedValue(null);
    pagosPendientesDeMock.mockResolvedValue([]);
});

// ─── Caracterización: interruptor apagado = idéntico a hoy ──────────────────

describe('caracterización (interruptor apagado, sin motivo esperado): la cola responde como hoy', () => {
    it('familia con UN hijo y sin cobros pendientes → la pregunta del mes con 4 botones', async () => {
        state.children = [LAURA];
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toBe('Recibí tu comprobante por *$150.000* de *Laura* 📄 ¿De qué mes es? Toca una opción.');
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones).toHaveLength(4);
        expect(botones[3].title).toBe('4. Otro mes');
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr).toMatchObject({ tipo: 'mes' });
        expect(updatesPagos).toHaveLength(0);
    });

    it('monto que no cuadra con la mensualidad → [Mensualidad][Inscripción][Otro], nada se crea ni se aplica', async () => {
        state.children = [LAURA];
        state.enrollments = [INSCRIPCION_LAURA];
        pagosPendientesDeMock.mockResolvedValue([OCT]);
        extractReceiptMock.mockResolvedValue(comprobante(20000));
        await runWhatsAppQueue();
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Mensualidad', '2. Inscripción', '3. Otro']);
        expect(botones.map((b) => b.id)).toEqual(['sm_cobro_1', 'sm_cobro_2', 'sm_cobro_3']);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'concepto' });
        expect(espera.pregunta_ocr.guia.opciones.map((o: any) => o.valor)).toEqual(['mensualidad', 'inscripcion', 'otro']);
        expect(updatesPagos).toHaveLength(0);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
    });

    it('$310.000 sin cobro de inscripción creado (= registration_fee del plan) → NO se crea el cobro: se pregunta como hoy', async () => {
        state.children = [LAURA];
        state.enrollments = [INSCRIPCION_LAURA];
        pagosPendientesDeMock.mockResolvedValue([]);
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        await runWhatsAppQueue();
        expect(llamadasRpc('wa_crear_cobro_desde_comprobante')).toHaveLength(0);
        expect(enviados()[0]).toContain('¿De qué mes es?');
        expect(updatesPagos).toHaveLength(0);
    });

    it('pie «lo de los uniformes» sin cobro de uniformes → a la escuela, sin aplicarlo a la mensualidad', async () => {
        state.children = [LAURA];
        pagosPendientesDeMock.mockResolvedValue([OCT]);
        state.claim = [FILA('f1', { media_caption: 'mira aquí lo de los uniformes' })];
        extractReceiptMock.mockResolvedValue(comprobante(60000));
        await runWhatsAppQueue();
        expect(enviados()).toEqual([
            'Recibí tu comprobante de *uniforme* 📄 Se lo paso a la escuela para que lo registre; no lo apliqué a la mensualidad.',
        ]);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message.startsWith('otro_concepto: uniforme (pie: «mira aquí lo de los uniformes»)')).toBe(true);
        expect(updatesPagos).toHaveLength(0);
        expect(llamadasRpc('wa_crear_cobro_desde_comprobante')).toHaveLength(0);
    });

    it('ráfaga de 2 fotos que se aplican → UN mensaje numerado, sin botones nuevos', async () => {
        state.children = [LAURA];
        pagosPendientesDeMock.mockResolvedValue([OCT, INSC]);
        state.claim = [FILA('f1'), FILA('f2')];
        extractReceiptMock
            .mockResolvedValueOnce(comprobante(180000))
            .mockResolvedValueOnce(comprobante(310000));
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        expect(sendTextMessageMock).toHaveBeenCalledTimes(1);
        const texto = enviados()[0];
        expect(texto.startsWith('Recibí tus 2 comprobantes:\n\n*1.* Listo: comprobante de *$180.000* de *Laura* para *octubre*.')).toBe(true);
        expect(texto).toContain('*2.* Listo: comprobante de *$310.000* de *Laura* para *inscripción*. La escuela lo confirma.');
        expect(registrados[0].p_payload).toMatchObject({ step: 'resultado_rafaga', queue_ids: ['f1', 'f2'] });
        expect(updatesPagos.map((u) => u.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    });

    it('prospecto (número sin ficha) con comprobante a la cuenta de la escuela → «¿De qué deportista es este pago?», sin cobro creado', async () => {
        state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
        state.claim = [FILA('f1', { media_caption: 'pago de la clase de prueba' })];
        extractReceiptMock.mockResolvedValue(comprobante(15000));
        await runWhatsAppQueue();
        expect(enviados()).toHaveLength(1);
        expect(enviados()[0]).toContain('¿De qué deportista es este pago?');
        expect(updatesCola.find((u) => u.status === 'waiting_user').pregunta_ocr).toMatchObject({ tipo: 'deportista' });
        expect(llamadasRpc('wa_crear_cobro_desde_comprobante')).toHaveLength(0);
        expect(updatesPagos).toHaveLength(0);
    });
});

// ─── Lo nuevo (interruptor prendido) ─────────────────────────────────────────

const TOMAS = { id: 'c2', full_name: 'Tomás Peña' };
const PLAN = { id: 'plan-1', school_id: 'school-1', is_active: true, registration_fee: 310000 };
const UNIFORMES = { id: 'art-1', name: 'Uniformes', price: 60000, active: true };
const FUTURO = () => new Date(Date.now() + 6 * 3600_000).toISOString();
const ESPERADO_PRUEBA = () => ({
    id: 'e1', school_id: 'school-1', telefono: '573005550101', motivo: 'clase_prueba', monto: 15000,
    signup_lead_id: 'lead-1', child_id: null, origen: 'clase_prueba', vence_en: FUTURO(), created_at: new Date().toISOString(),
});
const crearLlamadas = () => llamadasRpc('wa_crear_cobro_desde_comprobante').map((c) => c[1]);
const agendaMock = vi.fn(async (..._a: any[]) => ({
    texto: 'Listo ✅ Tu clase de prueba quedó el *sábado 8 a. m.* en el Parque Pinar de Suba 2.',
    botones: [{ id: 'cp_ok', title: 'Perfecto' }],
    step: 'clase_prueba_agendada',
}));

function prospecto() {
    state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
    state.interruptor = true;
    state.trialPrice = 15000;
}

function familiaMonster() {
    state.interruptor = true;
    state.children = [LAURA];
    state.enrollments = [{ ...INSCRIPCION_LAURA, offering_plan_id: 'plan-1' }];
    state.planes = [PLAN];
    state.articulos = [UNIFORMES];
}

describe('prospecto con motivo esperado: clase de prueba de $15.000 (Monster)', () => {
    beforeEach(() => {
        prospecto();
        state.esperados = [ESPERADO_PRUEBA()];
        extractReceiptMock.mockResolvedValue(comprobante(15000, { originName: 'Carolina Ruiz' }));
    });

    it('crea el cobro del lead con la RPC, queda EN REVISIÓN, pasa por evaluatePaymentReceipt y B3 agenda (una vez, con su texto)', async () => {
        _fijarCargadorAgenda(async () => ({ confirmarClasePruebaPagada: agendaMock }));
        await runWhatsAppQueue();

        expect(crearLlamadas()).toEqual([expect.objectContaining({
            p_school_id: 'school-1', p_queue_id: 'f1', p_categoria: 'clase_prueba', p_monto: 15000,
            p_fuente: 'trial_price', p_fuente_id: null, p_child_id: null, p_unregistered_id: null,
            p_signup_lead_id: 'lead-1', p_concepto: null, p_concepto_esperado_id: 'e1',
            p_telefono: '573005550101',
        })]);
        expect(updatesPagos[0]).toMatchObject({ status: 'awaiting_approval', ocr_amount: 15000, receipt_verdict: 'amarillo' });
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('pay-1', undefined);
        expect(agendaMock).toHaveBeenCalledTimes(1);
        expect(agendaMock).toHaveBeenCalledWith({ schoolId: 'school-1', leadId: 'lead-1', paymentId: 'pay-1', telefono: '573005550101' });
        expect(enviados()).toEqual(['Listo ✅ Tu clase de prueba quedó el *sábado 8 a. m.* en el Parque Pinar de Suba 2.']);
        expect((sendInteractiveButtonsMock.mock.calls[0][3] as any[]).map((b) => b.title)).toEqual(['Perfecto']);
        expect(registrados[0].p_payload).toMatchObject({ step: 'clase_prueba_agendada', queue_id: 'f1' });
        expect(cierre()).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'pay-1' });
        expect(updatesOtras.find((u) => u.table === 'whatsapp_conceptos_esperados')?.v)
            .toMatchObject({ payment_id: 'pay-1', queue_id: 'f1', consumido_at: expect.any(String) });
        expect(bot.abrirConsultaParaLaEscuela).not.toHaveBeenCalled();
    });

    it('sin el módulo de B3 (en esta rama todavía no existe): el cobro se crea igual, NO se agenda y pasa a una persona', async () => {
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(1);
        expect(updatesPagos[0]).toMatchObject({ status: 'awaiting_approval' });
        expect(enviados()).toEqual([TEXTO_CLASE_PRUEBA_A_PERSONA(15000)]);
        expect(enviados()[0]).toBe('Recibí tu comprobante de *$15.000* para la clase de prueba 📄 Una persona de la escuela te confirma el horario por aquí.');
        expect(bot.abrirConsultaParaLaEscuela).toHaveBeenCalledWith(expect.anything(), 'conv-1', '573005550101', 'clase_prueba_sin_agenda');
    });

    it('veredicto rojo: el cobro queda en revisión pero NO se agenda; a una persona', async () => {
        _fijarCargadorAgenda(async () => ({ confirmarClasePruebaPagada: agendaMock }));
        (evaluateVerdict as any).mockReturnValueOnce({ verdict: 'rojo', reasons: [] });
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(1);
        expect(agendaMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual([TEXTO_CLASE_PRUEBA_A_PERSONA(15000)]);
        expect(bot.abrirConsultaParaLaEscuela).toHaveBeenCalledWith(expect.anything(), 'conv-1', '573005550101', 'clase_prueba_no_coincide');
    });

    it('monto distinto del esperado: NO se crea nada; a la bandeja con la propuesta y a una persona', async () => {
        _fijarCargadorAgenda(async () => ({ confirmarClasePruebaPagada: agendaMock }));
        extractReceiptMock.mockResolvedValue(comprobante(20000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(updatesPagos).toHaveLength(0);
        expect(agendaMock).not.toHaveBeenCalled();
        expect(enviados()).toEqual(['Recibí tu comprobante de *$20.000* 📄 Se lo paso a la escuela para que lo revise y te confirme por aquí.']);
        const c = cierre();
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(c.error_message).toMatch(/^motivo_esperado_no_coincide \(monto\): se esperaba clase de prueba por \$15\.000 y llegó \$20\.000/);
        expect(c.error_message).toContain('Propuesta →');
        expect(c.pregunta_ocr).toMatchObject({ ocr: { amount: 20000 } });
        expect(bot.abrirConsultaParaLaEscuela).toHaveBeenCalledWith(expect.anything(), 'conv-1', '573005550101', 'comprobante_prospecto_no_coincide');
    });

    it('destino enmascarado («****2222»): no hay coincidencia exacta → no se crea nada, a una persona', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(15000, { destination: '****2222' }));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(cierre().error_message).toMatch(/^motivo_esperado_no_coincide \(destino\)/);
    });

    it('el lead ya tiene el cobro de la clase pendiente (la escuela lo creó): se aplica a ese, sin crear otro', async () => {
        _fijarCargadorAgenda(async () => ({ confirmarClasePruebaPagada: agendaMock }));
        const { supabase } = await import('../config/supabase');
        const original = (supabase.from as any).getMockImplementation();
        (supabase.from as any).mockImplementation((t: string) => (t === 'payments'
            ? makeChain({ data: [{ id: 'pay-escuela', amount: 15000, concept: 'Clase de prueba — Carolina', payment_category: 'clase_prueba' }], error: null }, t)
            : original(t)));
        try {
            await runWhatsAppQueue();
        } finally {
            (supabase.from as any).mockImplementation(original);
        }
        expect(crearLlamadas()).toHaveLength(0);
        expect(agendaMock).toHaveBeenCalledWith(expect.objectContaining({ paymentId: 'pay-escuela' }));
    });

    it('con el interruptor APAGADO el esperado no se lee: el prospecto recibe la pregunta de hoy', async () => {
        state.interruptor = false;
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(enviados()[0]).toContain('¿De qué deportista es este pago?');
    });
});

describe('prospecto SIN motivo esperado: el lead por teléfono y el monto', () => {
    beforeEach(() => {
        prospecto();
        state.leads = [{ id: 'lead-9', full_name: 'Mariana Ruiz', status: 'contacted', phone: '3005550101' }];
    });

    it('$15.000 = valor de la clase de prueba, a la cuenta de la escuela → cobro del lead y B3 agenda', async () => {
        _fijarCargadorAgenda(async () => ({ confirmarClasePruebaPagada: agendaMock }));
        extractReceiptMock.mockResolvedValue(comprobante(15000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toEqual([expect.objectContaining({
            p_categoria: 'clase_prueba', p_signup_lead_id: 'lead-9', p_concepto: 'Clase de prueba — Mariana Ruiz', p_concepto_esperado_id: null,
        })]);
        expect(agendaMock).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'lead-9', paymentId: 'pay-1' }));
    });

    it('un monto que no es ningún precio sigue el camino de hoy', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(42000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(enviados()[0]).toContain('¿De qué deportista es este pago?');
    });
});

describe('familia: cobro desde el comprobante por el monto (sin cobro creado)', () => {
    beforeEach(() => familiaMonster());

    it('$310.000 = matrícula del plan → crea la inscripción de Laura y la aplica', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toEqual([expect.objectContaining({
            p_categoria: 'inscripcion', p_monto: 310000, p_fuente: 'registration_fee', p_fuente_id: 'plan-1',
            p_child_id: 'c1', p_signup_lead_id: null, p_concepto: 'Inscripción — Laura Peña',
        })]);
        expect(updatesPagos[0]).toMatchObject({ status: 'awaiting_approval', ocr_amount: 310000 });
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith('pay-1', undefined);
        expect(enviados()[0]).toBe('Listo: comprobante de *$310.000* de *Laura* para *inscripción*. La escuela lo confirma.');
    });

    it('$370.000 = matrícula + uniformes → crea los 2 y el comprobante cubre los dos', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(370000));
        await runWhatsAppQueue();
        expect(crearLlamadas().map((a) => [a.p_categoria, a.p_monto])).toEqual([['inscripcion', 310000], ['articulos', 60000]]);
        expect(llamadasRpc('wa_cubrir_cobros_con_comprobante')[0][1]).toEqual({ p_school_id: 'school-1', p_principal_id: 'pay-1', p_cobros: ['pay-2'] });
        expect(enviados()[0]).toMatch(/^Recibí tu comprobante y lo apliqué a \*Inscripción — Laura Peña por .*\* y \*Uniformes — Laura Peña por /);
    });

    it('$55.000 no es ningún precio → botones con los motivos que tienen precio + «Otro»', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(55000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        const botones = sendInteractiveButtonsMock.mock.calls[0][3] as any[];
        expect(botones.map((b) => b.title)).toEqual(['1. Uniformes', '2. Inscripción', '3. Otro']);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'concepto' });
        expect(espera.pregunta_ocr.guia.opciones[0].valor).toMatchObject({ motivo: 'articulos', fuente: 'merchandise_item', fuenteId: 'art-1', monto: 60000 });
    });

    it('$180.000 es la cuota: nunca se propone un motivo; la pregunta del mes de hoy', async () => {
        extractReceiptMock.mockResolvedValue(comprobante(180000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(enviados()[0]).toContain('¿De qué mes es?');
    });

    it('hermanos: el motivo está claro y el deportista no → «¿De cuál deportista es?» con la guía del motivo', async () => {
        state.children = [LAURA, TOMAS];
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(0);
        expect(enviados()[0]).toBe('Recibí tu comprobante de *inscripción* 📄 ¿De cuál deportista es? Toca el nombre.');
        expect((sendInteractiveButtonsMock.mock.calls[0][3] as any[]).map((b) => b.title)).toEqual(['1. Laura Peña', '2. Tomás Peña']);
        const espera = updatesCola.find((u) => u.status === 'waiting_user');
        expect(espera.pregunta_ocr).toMatchObject({ tipo: 'deportista' });
        expect(espera.pregunta_ocr.guia.motivo).toMatchObject({ motivo: 'inscripcion', monto: 310000, fuente: 'registration_fee', fuenteId: 'plan-1' });
    });

    it('motivo esperado de la familia (inscripción de Laura): se crea con el esperado y se consume', async () => {
        state.esperados = [{ id: 'e2', school_id: 'school-1', telefono: '573005550101', motivo: 'inscripcion', monto: 310000, signup_lead_id: null, child_id: 'c1', origen: 'bot', vence_en: FUTURO() }];
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_categoria: 'inscripcion', p_child_id: 'c1', p_concepto_esperado_id: 'e2' })]);
        expect(updatesOtras.find((u) => u.table === 'whatsapp_conceptos_esperados')?.v).toMatchObject({ payment_id: 'pay-1' });
    });

    it('pie «lo de los uniformes» y $60.000 es su precio → se crea el cobro de uniformes (no va a la escuela)', async () => {
        pagosPendientesDeMock.mockResolvedValue([OCT]);
        state.claim = [FILA('f1', { media_caption: 'mira aquí lo de los uniformes' })];
        extractReceiptMock.mockResolvedValue(comprobante(60000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_categoria: 'articulos', p_fuente: 'merchandise_item', p_fuente_id: 'art-1' })]);
        expect(enviados()[0]).toContain('para *uniformes*');
        expect(enviados()[0]).toContain('Te queda pendiente');
    });

    it('ráfaga de 2 comprobantes con motivo asignado → UN resumen con [Sí, está bien][Cambiar un motivo]', async () => {
        state.claim = [FILA('f1'), FILA('f2')];
        extractReceiptMock
            .mockResolvedValueOnce(comprobante(310000))
            .mockResolvedValueOnce(comprobante(60000));
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).toHaveBeenCalledTimes(1);
        expect(sendTextMessageMock).not.toHaveBeenCalled();
        const [, , texto, botones] = sendInteractiveButtonsMock.mock.calls[0] as any[];
        expect(texto).toBe('¡Recibí 2 comprobantes! ✅\n\n*1.* $310.000 → Inscripción · Laura\n*2.* $60.000 → Uniformes · Laura\n\n'
            + 'La escuela los revisa y te confirma. ¿Está bien así?');
        expect(botones.map((b: any) => [b.id, b.title])).toEqual([['sm_motivos_ok', 'Sí, está bien'], ['sm_motivos_cambiar', 'Cambiar un motivo']]);
        expect(registrados[0].p_payload).toMatchObject({ step: 'resumen_motivos', queue_ids: ['f1', 'f2'] });
        expect(registrados[0].p_payload.lineas).toEqual([
            { monto: 310000, motivo: 'Inscripción', atleta: 'Laura Peña', paymentId: 'pay-1', nuevo: true },
            { monto: 60000, motivo: 'Uniformes', atleta: 'Laura Peña', paymentId: 'pay-2', nuevo: true },
        ]);
    });

    it('referencia de banco ya usada en la escuela: no se crea el cobro (sigue el camino de hoy)', async () => {
        const { supabase } = await import('../config/supabase');
        const original = (supabase.from as any).getMockImplementation();
        (supabase.from as any).mockImplementation((t: string) => (t === 'payments'
            ? makeChain({ data: [{ id: 'pay-viejo' }], error: null }, t) : original(t)));
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        try {
            await runWhatsAppQueue();
        } finally {
            (supabase.from as any).mockImplementation(original);
        }
        expect(crearLlamadas()).toHaveLength(0);
    });

    it('la base no crea el cobro (p. ej. monto_no_coincide): no se aplica nada y sigue el camino de hoy', async () => {
        state.rpcCrear = () => ({ ok: false, codigo: 'monto_no_coincide' });
        extractReceiptMock.mockResolvedValue(comprobante(310000));
        await runWhatsAppQueue();
        expect(crearLlamadas()).toHaveLength(1);
        expect(updatesPagos).toHaveLength(0);
        expect(enviados()[0]).toContain('¿De qué mes es?');
    });
});

describe('fila de preguntas (todas las escuelas, aun con el interruptor apagado)', () => {
    it('ráfaga de 2 fotos que necesitan pregunta: sale UNA; la otra queda en fila con su texto y su monto', async () => {
        state.children = [LAURA];
        state.claim = [FILA('f1'), FILA('f2')];
        extractReceiptMock
            .mockResolvedValueOnce(comprobante(150000))
            .mockResolvedValueOnce(comprobante(140000));
        await runWhatsAppQueue();
        expect(sendInteractiveButtonsMock).toHaveBeenCalledTimes(1);
        expect(enviados()[0]).toContain('*$150.000*');
        expect(state.cola.f1).toMatchObject({ status: 'waiting_user', pregunta_at: expect.any(String) });
        expect(state.cola.f2.status).toBe('waiting_user');
        expect(state.cola.f2.pregunta_at).toBeNull();
        expect(state.cola.f2.pregunta_ocr.en_fila).toMatchObject({ paso: 'ask_mes', monto: 140000 });
        expect(state.cola.f2.pregunta_ocr.en_fila.texto).toContain('*$140.000*');
        expect(state.cola.f2.pregunta_ocr.en_fila.botones).toHaveLength(4);
    });
});
