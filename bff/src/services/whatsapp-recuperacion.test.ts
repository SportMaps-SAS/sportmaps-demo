/**
 * Recuperación en lote de comprobantes de WhatsApp (whatsapp-recuperacion.service).
 *
 * Lo que NO puede pasar nunca, y por eso se prueba con efectos y no leyendo:
 *   - que se le escriba a alguien (WhatsApp o correo) — salvo el aviso de
 *     «quedó en revisión» a la familia cuyo comprobante quedó en un cobro,
 *     dentro de la ventana de 24 h y con el bot prendido (2026-10-07);
 *   - que un comprobante quede aprobado (aunque la escuela tenga auto-aprobación);
 *   - que se registre dos veces un pago que la escuela ya registró a mano;
 *   - que la simulación escriba algo;
 *   - que una fila ya tomada se procese otra vez.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

type Op = { table: string; op: 'select' | 'update' | 'insert'; cols?: string; values?: any };
const ops: Op[] = [];
const rpcs: string[] = [];
const subidas: string[] = [];

const state = {
    pendientes: [] as any[],
    registrados: [] as any[],
    tomaOk: true,
    staff: false,
    porTelefono: { estado: 'identificado', parent_id: 'parent-1' } as any,
    previa: null as any,
    fichas: [{ id: 'child-1', parent_id: 'parent-1', parent_phone_temp: null }] as any[],
    sinRegistrar: [] as any[],
    mensajes: [] as any[],
    ultimoEntrante: null as string | null,
    bot: true,
    /** `enrollments` de los deportistas (pago esperado, 2026-10-24). */
    inscripciones: [] as any[],
    /** Nombres de los hijos de la escuela. */
    hijos: [{ id: 'child-1', full_name: 'Laura Peña' }] as any[],
};

function resultado(o: Op): { data: any; error: any } {
    if (o.table === 'payments' && o.op === 'select') {
        if (o.cols?.includes('child:children')) return { data: state.pendientes, error: null };
        if (o.cols?.includes('amount_paid')) return { data: state.registrados, error: null };
        return { data: [], error: null }; // ¿referencia/imagen ya usadas? no
    }
    if (o.table === 'payments' && o.op === 'update') return { data: [{ id: 'pay-x' }], error: null };
    if (o.table === 'whatsapp_inbound_queue' && o.op === 'select') return { data: state.previa, error: null };
    if (o.table === 'whatsapp_inbound_queue' && o.op === 'update') {
        return { data: state.tomaOk ? [{ id: 'fila-1' }] : [], error: null };
    }
    if (o.table === 'children' && o.cols?.includes('parent_phone_temp')) {
        return { data: state.fichas, error: null };
    }
    if (o.table === 'enrollments') return { data: state.inscripciones, error: null };
    if (o.table === 'children') return { data: state.hijos, error: null };
    if (o.table === 'unregistered_athletes') return { data: state.sinRegistrar, error: null };
    if (o.table === 'whatsapp_conversations') return { data: { id: 'conv-1', last_inbound_at: state.ultimoEntrante }, error: null };
    if (o.table === 'whatsapp_messages') return { data: state.mensajes, error: null };
    if (o.table === 'profiles') return { data: [{ id: 'parent-1', phone: '+57 300 123 4567' }], error: null };
    return { data: null, error: null };
}

function chain(table: string) {
    const o: Op = { table, op: 'select' };
    const c: any = {
        select: (cols?: string) => { if (o.op === 'select') o.cols = cols; return c; },
        update: (v: any) => { o.op = 'update'; o.values = v; ops.push(o); return c; },
        insert: (v: any) => { o.op = 'insert'; o.values = v; ops.push(o); return c; },
        eq: () => c, in: () => c, or: () => c, is: () => c, not: () => c, gte: () => c, lte: () => c, neq: () => c,
        limit: () => c, order: () => c,
        maybeSingle: () => Promise.resolve(resultado(o)),
        single: () => Promise.resolve(resultado(o)),
        then: (ok: any, ko: any) => Promise.resolve(resultado(o)).then(ok, ko),
    };
    return c;
}

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (t: string) => { const c = chain(t); return c; },
        rpc: (name: string) => {
            rpcs.push(name);
            if (name === 'wa_identify_staff_admin_by_phone') {
                return Promise.resolve({ data: { estado: state.staff ? 'identificado' : 'no_es_staff_admin' }, error: null });
            }
            if (name === 'wa_identify_by_phone') return Promise.resolve({ data: state.porTelefono, error: null });
            return Promise.resolve({ data: false, error: null });
        },
        storage: {
            from: () => ({
                upload: (path: string) => { subidas.push(path); return Promise.resolve({ error: null }); },
                download: () => Promise.resolve({ data: null, error: { message: 'no' } }),
            }),
        },
    },
}));

const enviar = vi.fn();
vi.mock('./whatsapp.service', () => ({
    downloadMedia: vi.fn(() => Promise.resolve({ ok: true, base64: Buffer.from('foto').toString('base64'), mimeType: 'image/jpeg' })),
    sendTextMessage: (...a: any[]) => { enviar(...a); return Promise.resolve({ ok: true }); },
    sendInteractiveButtons: (...a: any[]) => { enviar(...a); return Promise.resolve({ ok: true }); },
    aFormatoWhatsApp: (t: string) => t,
}));

vi.mock('./whatsapp-atencion.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-atencion.service')>()),
    botEncendido: () => Promise.resolve(state.bot),
}));
vi.mock('./whatsapp-tomada.service', async (orig) => ({
    ...(await orig<typeof import('./whatsapp-tomada.service')>()),
    conversacionTomada: () => Promise.resolve(false),
}));

const evaluar = vi.fn();
vi.mock('./receipt-approval.service', () => ({
    evaluatePaymentReceipt: (...a: any[]) => { evaluar(...a); return Promise.resolve({ action: 'approved' }); },
    redRejectionMessage: () => null,
}));

const correo = vi.fn();
vi.mock('../utils/emailClient', () => ({ emailClient: { send: (...a: any[]) => correo(...a) } }));

const extraer = vi.fn();
vi.mock('./ocr.service', () => ({ extractReceipt: (...a: any[]) => extraer(...a) }));

// Plantilla `comprobante_en_revision` fuera de la ventana: por defecto, no
// aprobada (comportamiento de antes); un test la aprueba.
const plantillaRevision = vi.fn((..._a: any[]) => Promise.resolve({ enviado: false, motivo: 'plantilla_no_aprobada' } as any));
vi.mock('./whatsapp-aviso-revision.service', () => ({
    avisarRevisionPorPlantilla: (...a: any[]) => plantillaRevision(...a),
}));

import {
    decidirRecuperacion, pagosQueYaCubren, fechaDeReferencia, cierreDeFila, recuperarFilaDeCola,
    decidirPorMonto, desempatarCobro, mesesMencionados, esRecuperable, filtroDeFamilia, mensajeRecuperacion,
    type PagoRegistrado,
} from './whatsapp-recuperacion.service';
import { importarAdjunto } from './whatsapp-importar-chat.service';

// ─── Datos ───────────────────────────────────────────────────────────────────

const OCR = {
    amount: 180000, currency: 'COP', date: '2026-10-04', time: '10:00', bank: 'Nequi', reference: 'M1234567',
    destination: null, destinationName: null, originName: null, isReceipt: true, isTransactionList: false,
    missingFields: [], provider: 'openai',
};
const ocrFn = vi.fn(() => Promise.resolve({ ...OCR }));

const PEND = (id: string, amount: number) => ({
    id, amount, concept: `Mensualidad ${id}`, due_date: '2026-10-05', child_id: 'child-1', atleta: null,
});
const REG = (o: Partial<PagoRegistrado>): PagoRegistrado => ({
    id: 'paid-1', amount: 180000, amount_paid: 180000, status: 'paid', payment_date: '2026-10-04',
    updated_at: '2026-10-04T15:00:00Z', concept: 'Mensualidad 10/2026', ...o,
});

const FILA = {
    id: 'fila-1', integration_id: 'int-1', school_id: 'school-1', wa_phone_number: '573001234567',
    wa_message_id: 'wamid.1', media_id: 'media-1', media_mime_type: 'image/jpeg', storage_path: null,
    retries: 0, status: 'ignored', error_message: 'bot_apagado', created_at: '2026-10-04T15:00:00Z', wa_timestamp: null,
};
const WA = { id: 'int-1', school_id: 'school-1', access_token_encrypted: 'x' } as any;

beforeEach(() => {
    ops.length = 0; rpcs.length = 0; subidas.length = 0;
    enviar.mockClear(); evaluar.mockClear(); correo.mockClear(); ocrFn.mockClear();
    state.pendientes = [PEND('p-oct', 180000)];
    state.registrados = [];
    state.tomaOk = true;
    state.staff = false;
    state.porTelefono = { estado: 'identificado', parent_id: 'parent-1' };
    state.previa = null;
    state.fichas = [{ id: 'child-1', parent_id: 'parent-1', parent_phone_temp: null }];
    state.sinRegistrar = [];
    state.mensajes = [];
    state.ultimoEntrante = null;
    state.bot = true;
    state.inscripciones = [];
    state.hijos = [{ id: 'child-1', full_name: 'Laura Peña' }];
    extraer.mockReset();
    extraer.mockImplementation(() => Promise.resolve({ ...OCR }));
});

// ─── La regla, sin mocks ─────────────────────────────────────────────────────

describe('decidirRecuperacion', () => {
    const base = {
        familia: { tipo: 'identificado', parentId: 'parent-1' } as const,
        ocr: OCR, destinoDeLaEscuela: true, yaUsadoEn: null, pagadosQueCubren: [] as PagoRegistrado[],
    };

    it('un solo cobro pendiente → en revisión en ese cobro', () => {
        const d = decidirRecuperacion({ ...base, pendientes: [PEND('a', 180000)] });
        expect(d.decision).toBe('en_revision');
        expect(d.pago?.id).toBe('a');
    });

    it('único cobro y el comprobante es MENOR pero razonable → en revisión como abono (nunca aprobado)', () => {
        const d = decidirRecuperacion({ ...base, ocr: { ...OCR, amount: 75000 }, pendientes: [PEND('a', 210000)] });
        expect(d.decision).toBe('abono_en_revision');
        expect(d.pago?.id).toBe('a');
        expect(d.motivo).toContain('saldo 135000');
    });

    it('único cobro y el OCR no leyó el monto → en revisión (lo marca el veredicto)', () => {
        const d = decidirRecuperacion({ ...base, ocr: { ...OCR, amount: null }, pendientes: [PEND('a', 210000)] });
        expect(d.decision).toBe('en_revision');
    });

    it('el monto desempata entre varios → en revisión en el del monto', () => {
        const d = decidirRecuperacion({ ...base, pendientes: [PEND('a', 90000), PEND('b', 180000)] });
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: 'b' } });
    });

    it('mismo monto y MISMO deportista → el más antiguo (la regla del worker, bug 3 del 2026-10-13)', () => {
        const sep = { ...PEND('sep', 180000), due_date: '2026-09-05' };
        const d = decidirRecuperacion({ ...base, pendientes: [PEND('oct', 180000), sep] });
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: 'sep' } });
        expect(d.motivo).toContain('el cobro más antiguo');
    });

    it('mismo monto y deportistas DISTINTOS → al buzón, no se adivina', () => {
        const d = decidirRecuperacion({ ...base, pendientes: [PEND('a', 180000), { ...PEND('b', 180000), child_id: 'child-2' }] });
        expect(d.decision).toBe('varios_cobros');
    });

    it('ya registrado a mano por ese monto y sin pendiente igual → ya_registrado, sin cobro', () => {
        const d = decidirRecuperacion({ ...base, pagadosQueCubren: [REG({})], pendientes: [PEND('nov', 90000)] });
        expect(d.decision).toBe('ya_registrado');
        expect(d.pago).toBeUndefined();
        expect(d.pagoRegistradoId).toBe('paid-1');
    });

    it('ya registrado pero también hay pendiente del mismo monto → decide una persona', () => {
        const d = decidirRecuperacion({ ...base, pagadosQueCubren: [REG({})], pendientes: [PEND('sep', 180000)] });
        expect(d.decision).toBe('varios_cobros');
        expect(d.pago).toBeUndefined();
    });

    it('referencia de banco ya usada → ya_registrado aunque haya pendientes', () => {
        const d = decidirRecuperacion({ ...base, yaUsadoEn: { paymentId: 'x', por: 'referencia' }, pendientes: [PEND('a', 180000)] });
        expect(d).toMatchObject({ decision: 'ya_registrado', pagoRegistradoId: 'x' });
    });

    it('no es comprobante / destino ajeno / sin familia', () => {
        expect(decidirRecuperacion({ ...base, ocr: { ...OCR, isReceipt: false }, pendientes: [] }).decision).toBe('no_es_comprobante');
        expect(decidirRecuperacion({ ...base, destinoDeLaEscuela: false, pendientes: [] }).decision).toBe('destino_ajeno');
        expect(decidirRecuperacion({ ...base, familia: { tipo: 'sin_cuenta' }, pendientes: [] }).decision).toBe('familia_sin_cuenta');
        expect(decidirRecuperacion({ ...base, familia: { tipo: 'desconocido' }, pendientes: [] }).decision).toBe('sin_familia');
        expect(decidirRecuperacion({ ...base, familia: { tipo: 'staff' }, pendientes: [PEND('a', 180000)] }).decision).toBe('enviado_por_equipo');
    });
});

describe('pagosQueYaCubren y fechaDeReferencia', () => {
    it('mismo monto dentro de la ventana cubre; fuera de ella o de otro monto, no', () => {
        expect(pagosQueYaCubren([REG({ payment_date: '2026-10-06' })], 180000, '2026-10-04')).toHaveLength(1);
        expect(pagosQueYaCubren([REG({ payment_date: '2026-09-05' })], 180000, '2026-10-04')).toHaveLength(0);
        expect(pagosQueYaCubren([REG({ amount: 90000, amount_paid: 90000 })], 180000, '2026-10-04')).toHaveLength(0);
        expect(pagosQueYaCubren([REG({})], null, '2026-10-04')).toHaveLength(0);
    });

    it('una fecha de comprobante absurda cede a la del mensaje', () => {
        expect(fechaDeReferencia('2025-10-04', '2026-10-04T15:00:00Z')).toBe('2026-10-04');
        expect(fechaDeReferencia('2026-10-01', '2026-10-04T15:00:00Z')).toBe('2026-10-01');
        expect(fechaDeReferencia(null, '2026-10-04T15:00:00Z')).toBe('2026-10-04');
    });
});

describe('cierreDeFila', () => {
    const STATUS = ['pending', 'processing', 'waiting_user', 'done', 'failed', 'ignored'];
    const RESULT = ['payment_receipt', 'glosa', 'escalated', 'none'];
    const decisiones = ['en_revision', 'ya_registrado', 'no_es_comprobante', 'es_listado', 'destino_ajeno', 'sin_pendientes',
        'varios_cobros', 'monto_distinto', 'familia_sin_cuenta', 'abono_en_revision', 'numero_ambiguo', 'sin_familia', 'enviado_por_equipo', 'archivo_no_disponible'] as const;

    it.each(decisiones)('%s cierra dentro de los CHECK, marcado como recuperado y sin aviso de desenlace', (decision) => {
        const c = cierreDeFila({ decision, motivo: 'm', ocr: null }, '2026-10-05T00:00:00Z')!;
        expect(STATUS).toContain(c.status);
        expect(RESULT).toContain(c.result_type);
        expect(String(c.error_message).startsWith('recuperado:')).toBe(true);
        // El job de desenlace no le escribe al acudiente cuando la escuela apruebe.
        expect(c.outcome_notified_at).toBe('2026-10-05T00:00:00Z');
    });

    it('transitorio → no se cierra', () => {
        expect(cierreDeFila({ decision: 'reintentar', motivo: 'ocr', ocr: null }, 'x')).toBeNull();
    });
});

// ─── Con efectos ─────────────────────────────────────────────────────────────

const updatesDe = (t: string) => ops.filter((o) => o.table === t && o.op === 'update');

describe('recuperarFilaDeCola', () => {
    it('SIMULACIÓN: decide pero no escribe nada, ni identifica con la RPC que vincula', async () => {
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('en_revision');
        expect(r.pago?.id).toBe('p-oct');
        expect(ops.filter((o) => o.op !== 'select')).toEqual([]);
        expect(subidas).toEqual([]);
        expect(rpcs).not.toContain('wa_identify_by_phone');
        expect(enviar).not.toHaveBeenCalled();
        expect(evaluar).not.toHaveBeenCalled();
    });

    it('APLICAR: deja el cobro awaiting_approval con el comprobante; nunca aprueba ni responde', async () => {
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('en_revision');

        const pago = updatesDe('payments');
        expect(pago).toHaveLength(1);
        expect(pago[0].values.status).toBe('awaiting_approval');
        expect(pago[0].values.receipt_url).toBe('school-1/whatsapp/fila-1.jpeg');
        expect(subidas).toEqual(['school-1/whatsapp/fila-1.jpeg']);

        expect(evaluar).not.toHaveBeenCalled();               // ni auto-aprobación ni glosa
        expect(rpcs).not.toContain('auto_approve_payment');
        expect(enviar).not.toHaveBeenCalled();                // fuera de la ventana: ni WhatsApp…
        expect(correo).not.toHaveBeenCalled();                // …ni correo
        expect(r.aviso).toBe('fuera_de_ventana');

        const cierre = updatesDe('whatsapp_inbound_queue').at(-1)!.values;
        expect(cierre).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-oct' });
        // El desenlace (aprobado/rechazado) sí se le avisa: lo manda el job de desenlace.
        expect(cierre.outcome_notified_at).toBeNull();
    });

    it('APLICAR fuera de la ventana con comprobante_en_revision aprobada: sale la plantilla, no el texto', async () => {
        plantillaRevision.mockResolvedValueOnce({ enviado: true, waMessageId: 'wamid.T', plantilla: 'comprobante_en_revision' });
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('en_revision');
        expect(r.aviso).toBe('avisado_por_plantilla');
        expect(enviar).not.toHaveBeenCalled();
        expect(plantillaRevision.mock.calls.at(-1)?.[0]).toMatchObject({ paymentId: 'p-oct', monto: 180000, paso: 'recuperado_en_revision' });
        // El desenlace se sigue avisando cuando la escuela decida.
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values.outcome_notified_at).toBeNull();
    });

    it('APLICAR dentro de la ventana: le avisa a la familia UNA vez que quedó en revisión', async () => {
        state.ultimoEntrante = new Date(Date.now() - 2 * 3600_000).toISOString();
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('en_revision');
        expect(r.aviso).toBe('avisado');
        expect(enviar).toHaveBeenCalledTimes(1);
        expect(String(enviar.mock.calls[0][2])).toMatch(/quedó aplicado a \*.*\*.*revisando/s);
        expect(rpcs).toContain('wa_record_outbound_message');
        expect(evaluar).not.toHaveBeenCalled();
        expect(correo).not.toHaveBeenCalled();
    });

    it('APLICAR con el bot apagado: no le escribe, aunque la ventana esté abierta', async () => {
        state.ultimoEntrante = new Date(Date.now() - 3600_000).toISOString();
        state.bot = false;
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.aviso).toBe('bot_apagado');
        expect(enviar).not.toHaveBeenCalled();
    });

    it('avisar: false deja el desenlace sin aviso, como antes', async () => {
        state.ultimoEntrante = new Date(Date.now() - 3600_000).toISOString();
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn, avisar: false });
        expect(r.aviso).toBeUndefined();
        expect(enviar).not.toHaveBeenCalled();
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values.outcome_notified_at).toBeTruthy();
    });

    it('lo que va al buzón no le escribe a nadie, ni dentro de la ventana', async () => {
        state.ultimoEntrante = new Date(Date.now() - 3600_000).toISOString();
        state.pendientes = [PEND('p-sep', 150000), { ...PEND('p-oct', 150000), child_id: 'child-2' }];
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('varios_cobros');
        expect(enviar).not.toHaveBeenCalled();
    });

    it('ya registrado a mano: no toca ningún cobro y la fila queda con el pago que lo cubre', async () => {
        state.pendientes = [];
        state.registrados = [{ id: 'paid-1', amount: 180000, amount_paid: 180000, status: 'paid', payment_date: '2026-10-04', updated_at: null, concept: 'Oct' }];
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('ya_registrado');
        expect(updatesDe('payments')).toEqual([]);
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values).toMatchObject({ status: 'ignored', result_ref_id: 'paid-1' });
    });

    it('idempotente: si la fila ya no está como se leyó, no se procesa (ni OCR)', async () => {
        state.tomaOk = false;
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('reintentar');
        expect(ocrFn).not.toHaveBeenCalled();
        expect(updatesDe('payments')).toEqual([]);
        expect(subidas).toEqual([]);
    });

    it('OCR caído: la fila vuelve a su estado previo, sin veredicto', async () => {
        ocrFn.mockImplementationOnce(() => Promise.reject(new Error('429')));
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('reintentar');
        expect(updatesDe('payments')).toEqual([]);
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values).toEqual({ status: 'ignored', locked_until: null });
    });

    it('lo manda quien administra la escuela (aunque sea acudiente): no se aplica a sus cobros', async () => {
        state.staff = true;
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn });
        expect(r.decision).toBe('enviado_por_equipo');
        expect(updatesDe('payments')).toEqual([]);
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values).toMatchObject({ status: 'ignored', result_type: 'escalated' });
    });
});

// ─── Importar chat exportado (Tarea B): mismo camino ─────────────────────────

describe('importarAdjunto', () => {
    const ADJ = {
        schoolId: 'school-1', integrationId: 'int-1', parentId: 'parent-1', telefono: '573001234567',
        archivo: 'IMG-20260905-WA0012.jpg', fecha: '2026-09-05', contenido: Buffer.from('foto'), mime: 'image/jpeg',
    };

    it('en revisión, fila insertada YA CERRADA (nunca pending), sin responder ni aprobar', async () => {
        state.pendientes = [PEND('p-sep', 180000)];
        const r = await importarAdjunto(ADJ);
        expect(r.decision).toBe('en_revision');
        expect(updatesDe('payments')[0].values.status).toBe('awaiting_approval');
        const fila = ops.find((o) => o.table === 'whatsapp_inbound_queue' && o.op === 'insert')!.values;
        expect(fila.status).toBe('done');
        expect(fila.wa_message_id).toMatch(/^import:[0-9a-f]{64}$/);
        expect(fila.outcome_notified_at).toBeTruthy();
        expect(evaluar).not.toHaveBeenCalled();
        expect(enviar).not.toHaveBeenCalled();
        expect(correo).not.toHaveBeenCalled();
    });

    it('idempotente: el mismo archivo ya importado no se procesa ni paga OCR', async () => {
        state.previa = { id: 'q-1', error_message: 'recuperado: en_revision — a Mensualidad' };
        const r = await importarAdjunto(ADJ);
        expect(r.decision).toBe('ya_importado');
        expect(extraer).not.toHaveBeenCalled();
        expect(ops.filter((o) => o.op !== 'select')).toEqual([]);
        expect(subidas).toEqual([]);
    });

    it('ya registrado por la planilla de papel: no estampa ningún cobro', async () => {
        state.pendientes = [PEND('p-oct', 90000)];
        state.registrados = [{ id: 'paid-sep', amount: 180000, amount_paid: 180000, status: 'paid', payment_date: '2026-09-05', updated_at: null, concept: 'Sep' }];
        extraer.mockImplementation(() => Promise.resolve({ ...OCR, date: '2026-09-05' }));
        const r = await importarAdjunto(ADJ);
        expect(r.decision).toBe('ya_registrado');
        expect(updatesDe('payments')).toEqual([]);
    });
});

// ─── Reglas del 2026-10-06 ───────────────────────────────────────────────────

const PEND_DE = (id: string, amount: number, concept: string, atleta: string | null, due = '2026-10-05') => ({
    // Cada deportista con su ficha (hermanos = child_id distintos).
    id, amount, concept, due_date: due, child_id: atleta ? `child-${atleta.split(' ')[0].toLowerCase()}` : 'child-1', atleta,
});

describe('monto: abono, menor de la cuenta y mayor', () => {
    const p = PEND('oct', 180000);
    it('menor y ≥ 20 % → abono en revisión en ESE cobro', () => {
        expect(decidirPorMonto(p, 36000, [p], 'x')).toMatchObject({ decision: 'abono_en_revision', pago: { id: 'oct' } });
    });
    it('menor al 20 % → al buzón, sin cobro', () => {
        const d = decidirPorMonto(p, 25000, [p], 'x');
        expect(d.decision).toBe('monto_distinto');
        expect(d.pago).toBeUndefined();
    });
    it('MAYOR → se toma el pago y lo de más queda como saldo a favor (decisión 2026-10-13)', () => {
        const d = decidirPorMonto(p, 210000, [p], 'x');
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: 'oct' }, excedente: 30000 });
        expect(d.motivo).toContain('saldo a favor');
    });
    it('MAYOR que suma justo todos los pendientes sin poder repartir → decide la escuela', () => {
        const otro = PEND('nov', 90000);
        const d = decidirPorMonto(p, 270000, [p, otro], 'x');
        expect(d.decision).toBe('monto_distinto');
        expect(d.motivo).toContain('suma de los 2 cobros');
    });
    it('el monto con el recargo del enlace de pago es pago completo, no excedente', () => {
        const d = decidirPorMonto(p, 189000, [p], 'x', new Map([['oct', [189000]]]));
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: 'oct' }, esperado: 189000 });
        expect(d.excedente).toBeUndefined();
    });
    it('igual o ilegible → en revisión normal', () => {
        expect(decidirPorMonto(p, 180000, [p], 'x').decision).toBe('en_revision');
        expect(decidirPorMonto(p, null, [p], 'x').decision).toBe('en_revision');
    });
});

describe('varios cobros: desempate por lo que dijo la familia', () => {
    const sofiaOct = PEND_DE('aaaabbbb-1111-2222-3333-444455556666', 180000, 'Mensualidad 10/2026 - SOFIA PEREZ GOMEZ', 'SOFIA PEREZ GOMEZ');
    const juanOct = PEND_DE('ccccdddd-1111-2222-3333-444455556666', 180000, 'Mensualidad 10/2026 - JUAN PEREZ GOMEZ', 'JUAN PEREZ GOMEZ');
    const sofiaSep = PEND_DE('eeeeffff-1111-2222-3333-444455556666', 180000, 'Mensualidad 09/2026 - SOFIA PEREZ GOMEZ', 'SOFIA PEREZ GOMEZ', '2026-09-05');
    const base = {
        familia: { tipo: 'identificado', parentId: 'parent-1' } as const,
        ocr: OCR, destinoDeLaEscuela: true, yaUsadoEn: null, pagadosQueCubren: [] as PagoRegistrado[],
        pendientes: [sofiaOct, juanOct, sofiaSep],
    };

    it('la ref. del texto precargado de /p/:token manda', () => {
        const d = decidirRecuperacion({ ...base, textos: ['Hola, envío el comprobante de pago de Mensualidad 10/2026 - JUAN PEREZ GOMEZ (octubre 2026) de Juan. (ref. ccccdddd)'] });
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: juanOct.id } });
    });

    it('nombre del deportista + mes en el pie de foto', () => {
        const d = decidirRecuperacion({ ...base, textos: ['pago de sofi... Sofia octubre'] });
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: sofiaOct.id } });
        expect(d.motivo).toContain('nombre');
    });

    it('lo que lee el OCR en la descripción del comprobante también cuenta', () => {
        // `procesarComprobanteRecuperado` agrega `ocr.description` a los textos.
        const d = decidirRecuperacion({ ...base, textos: [undefined, 'MENSUALIDAD SEPTIEMBRE SOFIA'] });
        expect(d).toMatchObject({ decision: 'en_revision', pago: { id: sofiaSep.id } });
    });

    it('el apellido compartido no desempata; sin nada distintivo queda en el buzón', () => {
        expect(decidirRecuperacion({ ...base, textos: ['pago perez gomez'] }).decision).toBe('varios_cobros');
        expect(decidirRecuperacion({ ...base, textos: ['octubre'] }).decision).toBe('varios_cobros'); // 2 de octubre
        expect(decidirRecuperacion({ ...base, textos: [] }).decision).toBe('varios_cobros');
    });

    it('elegido por pista pero por MENOS → abono en revisión de ese cobro', () => {
        const d = decidirRecuperacion({ ...base, ocr: { ...OCR, amount: 90000 }, textos: ['juan'] });
        expect(d).toMatchObject({ decision: 'abono_en_revision', pago: { id: juanOct.id } });
    });

    it('desempatarCobro y mesesMencionados', () => {
        expect(desempatarCobro([sofiaOct, juanOct], ['Juan'])?.pago.id).toBe(juanOct.id);
        expect(desempatarCobro([sofiaOct, juanOct], ['hola'])).toBeNull();
        expect(Array.from(mesesMencionados('pago 09/2026 y octubre'))).toEqual(expect.arrayContaining([9, 10]));
    });
});

describe('familia sin cuenta: cobros por la ficha', () => {
    const base = {
        ocr: OCR, destinoDeLaEscuela: true, yaUsadoEn: null, pagadosQueCubren: [] as PagoRegistrado[],
    };
    it('con fichas del teléfono → mismas reglas (en revisión / varios / ya registrado)', () => {
        const familia = { tipo: 'sin_cuenta', childIds: ['child-9'] } as const;
        expect(decidirRecuperacion({ ...base, familia, pendientes: [PEND('a', 180000)] }).decision).toBe('en_revision');
        expect(decidirRecuperacion({ ...base, familia, pendientes: [PEND('a', 180000), { ...PEND('b', 180000), child_id: 'child-2' }] }).decision).toBe('varios_cobros');
        expect(decidirRecuperacion({ ...base, familia, pagadosQueCubren: [REG({})], pendientes: [] }).decision).toBe('ya_registrado');
    });
    it('sin fichas → al buzón como antes', () => {
        expect(decidirRecuperacion({ ...base, familia: { tipo: 'sin_cuenta' }, pendientes: [PEND('a', 180000)] }).decision).toBe('familia_sin_cuenta');
    });
    it('el filtro de payments usa child_id y unregistered_athlete_id, no parent_id', () => {
        expect(filtroDeFamilia({ childIds: ['c1', 'c2'], unregisteredIds: ['u1'] }))
            .toBe('child_id.in.(c1,c2),unregistered_athlete_id.in.(u1)');
        expect(filtroDeFamilia({})).toBeNull();
    });
});

describe('sin pendientes: pista de otro mes ya pagado', () => {
    it('lo dice en el motivo, sin tocar ningún cobro', () => {
        const d = decidirRecuperacion({
            familia: { tipo: 'identificado', parentId: 'parent-1' }, ocr: OCR, destinoDeLaEscuela: true, yaUsadoEn: null,
            pagadosQueCubren: [], pendientes: [], registrados: [REG({ payment_date: '2026-09-02', concept: 'Mensualidad 09/2026' })],
        });
        expect(d.decision).toBe('sin_pendientes');
        expect(d.motivo).toContain('Mensualidad 09/2026');
        expect(d.pago).toBeUndefined();
    });
});

describe('esRecuperable (--reprocesar)', () => {
    const f = (status: string, error_message: string | null) => ({ status, error_message, media_id: 'm' });
    it('sin --reprocesar: solo lo nunca leído', () => {
        expect(esRecuperable(f('ignored', 'bot_apagado'), false)).toBe(true);
        expect(esRecuperable(f('pending', null), false)).toBe(true);
        expect(esRecuperable(f('ignored', 'recuperado: varios_cobros — x'), false)).toBe(false);
        expect(esRecuperable(f('ignored', 'sin pagos pendientes'), false)).toBe(false);
    });
    it('con --reprocesar: el buzón resoluble, nunca lo que ya está en un cobro', () => {
        for (const d of ['familia_sin_cuenta', 'varios_cobros', 'monto_distinto', 'sin_pendientes', 'sin_familia']) {
            expect(esRecuperable(f('ignored', `recuperado: ${d} — x`), true)).toBe(true);
        }
        expect(esRecuperable(f('ignored', 'sin pagos pendientes'), true)).toBe(true);
        expect(esRecuperable(f('done', 'recuperado: en_revision — x'), true)).toBe(false);
        expect(esRecuperable(f('ignored', 'recuperado: ya_registrado — x'), true)).toBe(false);
        expect(esRecuperable(f('ignored', 'recuperado: no_es_comprobante — x'), true)).toBe(false);
        expect(esRecuperable({ status: 'ignored', error_message: 'bot_apagado', media_id: null }, true)).toBe(false);
    });
});

describe('recuperarFilaDeCola con las reglas nuevas (efectos)', () => {
    it('familia sin cuenta con ficha: estampa en revisión el cobro del hijo; no responde ni aprueba', async () => {
        state.porTelefono = { estado: 'debe_registrarse' };
        state.fichas = [{ id: 'child-9', parent_id: null, parent_phone_temp: '300 123 4567' }];
        state.pendientes = [{ ...PEND('p-hijo', 180000), child_id: 'child-9' }];
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn, cache: {} });
        expect(r.decision).toBe('en_revision');
        expect(r.pago?.id).toBe('p-hijo');
        const pago = updatesDe('payments');
        expect(pago).toHaveLength(1);
        expect(pago[0].values.status).toBe('awaiting_approval');
        expect(evaluar).not.toHaveBeenCalled();
        expect(enviar).not.toHaveBeenCalled();
        expect(correo).not.toHaveBeenCalled();
        expect(updatesDe('whatsapp_inbound_queue').at(-1)!.values).toMatchObject({ status: 'done', result_ref_id: 'p-hijo', matched_child_id: 'child-9' });
    });

    it('abono: queda awaiting_approval con lo leído; NUNCA partial ni amount_paid (eso es aprobar)', async () => {
        ocrFn.mockImplementationOnce(() => Promise.resolve({ ...OCR, amount: 90000 }));
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: true, ocrFn, cache: {} });
        expect(r.decision).toBe('abono_en_revision');
        const v = updatesDe('payments')[0].values;
        expect(v.status).toBe('awaiting_approval');
        expect(v.ocr_amount).toBe(90000);
        expect(v).not.toHaveProperty('amount_paid');
        expect(evaluar).not.toHaveBeenCalled();
        expect(enviar).not.toHaveBeenCalled();
    });

    it('varios cobros resueltos por un mensaje de la familia cerca de la foto (simulación: no escribe)', async () => {
        state.pendientes = [
            PEND_DE('aaaabbbb-0000-0000-0000-000000000000', 180000, 'Mensualidad 10/2026 - SOFIA PEREZ', 'SOFIA PEREZ'),
            PEND_DE('ccccdddd-0000-0000-0000-000000000000', 180000, 'Mensualidad 10/2026 - JUAN PEREZ', 'JUAN PEREZ'),
        ];
        state.mensajes = [{ text_body: 'este es el de Juan', created_at: FILA.created_at }];
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('en_revision');
        expect(r.pago?.id).toBe('ccccdddd-0000-0000-0000-000000000000');
        expect(ops.filter((o) => o.op !== 'select')).toEqual([]);
        expect(enviar).not.toHaveBeenCalled();

        // Sin mensajes, la descripción que lee el OCR también desempata.
        state.mensajes = [];
        ocrFn.mockImplementationOnce(() => Promise.resolve({ ...OCR, description: 'MENSUALIDAD SOFIA' }));
        const r2 = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r2.pago?.id).toBe('aaaabbbb-0000-0000-0000-000000000000');
        expect(ops.filter((o) => o.op !== 'select')).toEqual([]);
    });
});

// ─── Pago esperado, deportista por nombre, torneos y propuesta (2026-10-24) ──

describe('los casos reales sin ficha (decidirRecuperacion)', () => {
    const base = { ocr: OCR, destinoDeLaEscuela: true, yaUsadoEn: null, pagadosQueCubren: [] as PagoRegistrado[], pendientes: [] as any[] };
    for (const amount of [360000, 160000, 90000]) {
        it(`$${amount.toLocaleString('es-CO')} de un número que no está en ninguna ficha → sin_familia (a la bandeja, nunca ignorado)`, () => {
            const d = decidirRecuperacion({ ...base, familia: { tipo: 'desconocido' }, ocr: { ...OCR, amount } });
            expect(d.decision).toBe('sin_familia');
            // sin_familia cae en escalated, no en ignored/none.
            const cierre = cierreDeFila({ ...d, ocr: { ...OCR, amount }, parentId: null }, '2026-10-24T00:00:00Z');
            expect(cierre).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        });
    }
    it('$1.249.334 a la cuenta de otra persona → destino_ajeno (a la bandeja)', () => {
        const d = decidirRecuperacion({ ...base, familia: { tipo: 'desconocido' }, destinoDeLaEscuela: false, ocr: { ...OCR, amount: 1249334, destination: '3119998888' } });
        expect(d.decision).toBe('destino_ajeno');
        expect(cierreDeFila({ ...d, ocr: OCR, parentId: null }, 'x')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
    });
});

describe('torneos en la recuperación (spec 3.6)', () => {
    const base = {
        familia: { tipo: 'identificado', parentId: 'parent-1' } as const,
        destinoDeLaEscuela: true, yaUsadoEn: null, pagadosQueCubren: [] as PagoRegistrado[], pendientes: [PEND('p-oct', 180000)],
        ocr: { ...OCR, amount: 80000, originName: 'Carolina Gómez' }, pie: 'pago del torneo interclubes',
    };
    it('sin catálogo: otro_concepto con quién pagó visible y «registrar a mano»', () => {
        const d = decidirRecuperacion({ ...base, deportista: 'Laura Peña' });
        expect(d.decision).toBe('otro_concepto');
        expect(d.motivo.startsWith('otro_concepto: torneo')).toBe(true);
        expect(d.motivo).toContain('pagó: Carolina Gómez');
        expect(d.motivo).toContain('deportista: Laura Peña');
        expect(d.motivo).toContain('no tiene torneos cargados');
    });
    it('con catálogo y monto menor con cuotas permitidas: abono propuesto', () => {
        const d = decidirRecuperacion({
            ...base, ocr: { ...base.ocr, amount: 30000 },
            torneos: [{ id: 'i1', name: 'Torneo Interclubes Dynasty', price: 80000, per_athlete: true, allow_installments: true, event_id: null }],
        });
        expect(d.motivo).toContain('Torneo Interclubes Dynasty');
        expect(d.motivo).toMatch(/abono de \$30\.000 \(saldo \$50\.000\)/);
    });
    it('el cierre de la fila lo deja en la bandeja como otro_concepto con el motivo completo', () => {
        const d = decidirRecuperacion({ ...base });
        const c = cierreDeFila({ ...d, ocr: base.ocr, parentId: 'parent-1' }, 'x')!;
        expect(c).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(String(c.error_message)).toMatch(/^recuperado: otro_concepto — otro_concepto: torneo/);
    });
});

describe('recuperarFilaDeCola: la propuesta va en el motivo (simulación, nada se escribe)', () => {
    const sinEscrituras = () => expect(ops.filter((o) => o.op !== 'select')).toEqual([]);

    it('sin cobro del mes: propone el mes del comprobante y «crear el cobro» (no se crea solo)', async () => {
        state.pendientes = [];
        state.inscripciones = [{ child_id: 'child-1', unregistered_athlete_id: null, monthly_fee: 150000, fee_is_manual: false, status: 'active', plan: null, team: null }];
        ocrFn.mockImplementationOnce(() => Promise.resolve({ ...OCR, amount: 150000, originName: 'Carolina Gómez' }));
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('sin_pendientes');
        expect(r.motivo).toContain('Propuesta → deportista: Laura Peña');
        expect(r.motivo).toContain('mes del comprobante: octubre 2026');
        expect(r.motivo).toContain('crear el cobro de ese mes de Laura Peña y aplicarlo (no se crea solo)');
        expect(r.motivo).toContain('pagó: Carolina Gómez');
        expect(r.propuesta).toBeTruthy();
        sinEscrituras();
    });

    it('monto menor con VARIOS cobros: sigue en el buzón, pero con la propuesta de abono (el plan no se cambia)', async () => {
        state.pendientes = [PEND('p-sep', 180000), PEND('p-oct', 180000)];
        state.inscripciones = [{ child_id: 'child-1', unregistered_athlete_id: null, monthly_fee: 180000, fee_is_manual: false, status: 'active', plan: { name: 'PRO', price: 150000, registration_fee: null }, team: null }];
        ocrFn.mockImplementationOnce(() => Promise.resolve({ ...OCR, amount: 150000 }));
        const r = await recuperarFilaDeCola({ ...FILA }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('varios_cobros');
        expect(r.motivo).toContain('abono a cuota de Laura');
        expect(r.motivo).toContain('el plan NO se cambia');
        expect(r.motivo).not.toMatch(/cambia(r)? de plan/i);
        sinEscrituras();
    });

    it('número sin ficha cuyo pie nombra UN deportista → se sigue como familia con ficha: en revisión, nunca aprobado', async () => {
        state.porTelefono = { estado: 'no_encontrado' };
        state.pendientes = [{ ...PEND('p-oct', 180000), atleta: 'Laura Peña' }];
        const r = await recuperarFilaDeCola({ ...FILA, wa_phone_number: '573009998877', media_caption: 'Mensualidad de Laura Peña' }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('en_revision');
        expect(r.pago?.id).toBe('p-oct');
        expect(r.motivo).toContain('deportista identificado por el nombre del comprobante');
        sinEscrituras();
    });

    it('PRIVACIDAD (Monster 2026-11-05): número sin ficha con el nombre a medias («Laura Peña» de «Laura Peña Ruiz») → no se liga a nadie', async () => {
        state.hijos = [{ id: 'child-1', full_name: 'Laura Peña Ruiz' }];
        state.porTelefono = { estado: 'no_encontrado' };
        state.pendientes = [{ ...PEND('p-oct', 180000), atleta: 'Laura Peña Ruiz' }];
        const r = await recuperarFilaDeCola({ ...FILA, wa_phone_number: '573009998877', media_caption: 'Mensualidad de Laura Peña' }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('sin_familia');
        expect(r.pago).toBeUndefined();
        sinEscrituras();
    });

    it('PRIVACIDAD: lo que se le dice a un número sin verificar ligado por el nombre no trae datos del deportista', () => {
        const pago = { ...PEND('p-oct', 180000), concept: 'Mensualidad 11/2026 - Laura Peña Ruiz', atleta: 'Laura Peña Ruiz' };
        const ocr = { ...OCR, amount: 180000 } as any;
        expect(mensajeRecuperacion({ decision: 'en_revision', pago, ocr })).toContain('Laura Peña Ruiz'); // familia verificada: como siempre
        const neutro = mensajeRecuperacion({ decision: 'en_revision', pago, ocr, porNombreSinVerificar: true })!;
        expect(neutro).not.toMatch(/laura|mensualidad|11\/2026/i);
        expect(neutro).toContain('Recibí tu comprobante de $');
    });

    it('número sin ficha y sin nombre que lo señale: sin_familia con «deportista: sin identificar» y quién pagó', async () => {
        state.porTelefono = { estado: 'no_encontrado' };
        state.pendientes = [];
        ocrFn.mockImplementationOnce(() => Promise.resolve({ ...OCR, amount: 360000, originName: 'Pedro Gómez' }));
        const r = await recuperarFilaDeCola({ ...FILA, wa_phone_number: '573009998877' }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('sin_familia');
        expect(r.motivo).toContain('pagó: Pedro Gómez');
        expect(r.motivo).toContain('deportista: sin identificar');
        sinEscrituras();
    });

    it('número sin ficha cuyo nombre se parece a DOS deportistas: la propuesta los nombra para elegir', async () => {
        state.hijos = [{ id: 'c1', full_name: 'Sofía Pérez Gómez' }, { id: 'c2', full_name: 'Sofía Ramírez Ortiz' }];
        state.porTelefono = { estado: 'no_encontrado' };
        state.pendientes = [];
        const r = await recuperarFilaDeCola({ ...FILA, wa_phone_number: '573009998877', media_caption: 'pago de Sofia' }, WA, { aplicar: false, ocrFn, cache: {} });
        expect(r.decision).toBe('sin_familia');
        expect(r.motivo).toContain('¿Sofía Pérez Gómez o Sofía Ramírez Ortiz?');
        sinEscrituras();
    });
});
