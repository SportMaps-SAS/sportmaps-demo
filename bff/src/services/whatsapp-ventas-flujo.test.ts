/**
 * Escenarios de FLUJO: el comprobante que llega en la VENTA de un servicio
 * (plan docs/specs/whatsapp-ventas-de-servicio-blindaje.md, regla 5 y frente C;
 * batería del frente F). qa-embudo no cubre la cola de comprobantes: esto corre
 * `runWhatsAppQueue` de punta a punta con una base EN MEMORIA y mira solo lo que
 * se ve desde afuera: lo que se le escribe a la persona, el cobro que se crea
 * (RPC `wa_crear_cobro_desde_comprobante`) y cómo queda la fila de la cola.
 *
 * Regla 5: «Comprobante en una venta = cobro del servicio a nombre de quien
 * asiste (prospecto o deportista), nunca la búsqueda en el padrón del club ni el
 * embudo». Datos inventados con la forma del caso real (Monster, clínica de
 * armadores, 21–22 nov 2026: $300.000 preventa, $350.000 desde el 11, afiliado
 * $250.000, abono 50 %).
 *
 * CÓMO: la base es la `ConsultaVirtual` del cortafuegos de simulación (filtros,
 * orden, insert/update reales sobre memoria) con los alias `x:payload->>x` que
 * usa la lectura de la venta activa. Se simulan solo los bordes: Meta (envíos y
 * descarga), el OCR, la decisión de a quién atiende el bot (`debeAtender`), el
 * contexto de cuentas del veredicto y la aprobación del pago. Todo lo demás
 * (venta activa, lead, precios, B4, respuestas) es el código real.
 *
 * Varios casos fallan en develop del 2026-11-08 a propósito (F5: «¿De qué
 * deportista es?» a un externo, la familia afiliada, Nicolás): los arregla el
 * frente C. Si tras integrar falla por la semilla (una tabla o RPC nueva que el
 * frente C lee y aquí no está), ajustar la semilla, no la aserción.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

const h = vi.hoisted(() => ({
    memoria: {} as Record<string, any[]>,
    rpcs: [] as { fn: string; args: any }[],
    enviados: [] as string[],
    claim: [] as any[],
    ocr: null as any,
    imagen: 'aW1n',
    afiliado: false,
    parentId: null as string | null,
    atencion: { atender: false, tipo: 'desconocido', botEncendido: true } as any,
    n: 0,
}));

/** Respuesta de RPC con los métodos que a veces se encadenan. */
function respuesta(r: { data: unknown; error: unknown }): any {
    const p: any = Promise.resolve({ ...r, count: null, status: 200, statusText: 'OK' });
    p.single = () => p; p.maybeSingle = () => p; p.select = () => p; p.throwOnError = () => p;
    return p;
}

function rpcEnMemoria(fn: string, args: any): any {
    h.rpcs.push({ fn, args });
    const m = h.memoria;
    switch (fn) {
        case 'wa_queue_claim': { const c = h.claim; h.claim = []; return respuesta({ data: c, error: null }); }
        case 'wa_identify_by_phone':
            return respuesta({ data: h.parentId ? { estado: 'identificado', parent_id: h.parentId } : { estado: 'desconocido' }, error: null });
        case 'wa_identify_staff_admin_by_phone': return respuesta({ data: { estado: 'desconocido' }, error: null });
        case 'wa_es_afiliado': return respuesta({ data: { afiliado: h.afiliado }, error: null });
        case 'wa_record_outbound_message': {
            const t = new Date().toISOString();
            (m.whatsapp_messages ??= []).push({
                id: `out-${++h.n}`, conversation_id: args?.p_conversation_id, integration_id: args?.p_integration_id,
                direction: 'outbound', type: args?.p_type ?? 'text', text_body: args?.p_text_body ?? null, payload: args?.p_payload ?? {},
                ai_generated: args?.p_ai_generated === true, wa_message_id: args?.p_wa_message_id, to_wa_id: args?.p_to_wa_id,
                wa_timestamp: t, created_at: t, status: 'sent',
            });
            return respuesta({ data: `out-${h.n}`, error: null });
        }
        case 'wa_crear_cobro_desde_comprobante': {
            const item = (m.school_tournament_items ?? []).find((x) => x.id === args?.p_fuente_id);
            const lead = (m.school_signup_leads ?? []).find((x) => x.id === args?.p_signup_lead_id);
            const hijo = (m.children ?? []).find((x) => x.id === args?.p_child_id);
            const id = `pay-creado-${++h.n}`;
            const concepto = args?.p_concepto ?? `${item?.name ?? args?.p_categoria} — ${lead?.full_name ?? hijo?.full_name ?? 'sin nombre'}`;
            // El precio que la base le reconoce a esa persona: afiliado si lo es; si no, el del tramo de hoy.
            const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
            let precioLista = Number(item?.price ?? args?.p_monto);
            for (const t of (item?.precios_por_fecha ?? []) as { desde: string; precio: number }[]) if (t.desde <= hoy) precioLista = t.precio;
            if (h.afiliado && Number(item?.precio_afiliado) > 0) precioLista = Number(item.precio_afiliado);
            (m.payments ??= []).push({
                id, school_id: args?.p_school_id, amount: args?.p_monto, status: 'pending', concept: concepto,
                payment_category: args?.p_categoria, signup_lead_id: args?.p_signup_lead_id ?? null, child_id: args?.p_child_id ?? null,
                parent_id: hijo?.parent_id ?? null, due_date: '2026-11-21', created_at: new Date().toISOString(),
            });
            return respuesta({ data: { ok: true, payment_id: id, precio: args?.p_monto, es_abono: Number(args?.p_monto) < precioLista, ya_existia: false, concepto }, error: null });
        }
        default: return respuesta({ data: null, error: null });
    }
}

vi.mock('../config/supabase', async () => {
    const { ConsultaVirtual, valorDeColumna } = await vi.importActual<typeof import('../config/cortafuegos-simulacion')>('../config/cortafuegos-simulacion');
    const ctx = { memoria: h.memoria, rpc: {}, bloqueadas: [] as string[] };
    /** `select('alias:payload->>campo')` como PostgREST: la fila trae la clave con alias. */
    class Consulta extends (ConsultaVirtual as any) {
        aliases: { alias: string; col: string }[] = [];
        select(cols?: string, opts?: any) {
            if (typeof cols === 'string') {
                this.aliases = cols.split(',').map((s) => s.trim()).map((s) => /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(s))
                    .filter((x): x is RegExpExecArray => !!x).map((x) => ({ alias: x[1], col: x[2].trim() }));
            }
            return super.select(cols, opts);
        }
        then(ok?: (v: any) => unknown, ko?: (e: any) => unknown) {
            const aliases = this.aliases;
            return super.then((r: any) => {
                const filas = Array.isArray(r?.data) ? r.data : r?.data && typeof r.data === 'object' ? [r.data] : [];
                for (const f of filas) for (const a of aliases) if (!(a.alias in f)) f[a.alias] = valorDeColumna(f, a.col) ?? null;
                return ok ? ok(r) : r;
            }, ko);
        }
    }
    const bucket = {
        download: async () => ({ data: new Blob(['img']), error: null }),
        upload: async (path: string) => ({ data: { path }, error: null }),
        remove: async () => ({ data: [], error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: 'https://qa.local/archivo' }, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'https://qa.local/archivo' } }),
    };
    return {
        supabase: {
            from: (tabla: string) => new Consulta(ctx, tabla),
            rpc: (fn: string, args?: any) => rpcEnMemoria(fn, args),
            storage: { from: () => bucket },
            functions: { invoke: async () => ({ data: null, error: { message: 'sin funciones en la prueba' } }) },
            auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
        },
    };
});

vi.mock('../services/whatsapp.service', async (original) => {
    const real = await original<any>();
    const enviar = async (_w: unknown, _to: string, texto: string) => {
        h.enviados.push(texto);
        return { ok: true, waMessageId: `wamid.qa-${++h.n}` };
    };
    return {
        ...real,
        downloadMedia: async () => ({ ok: true, base64: h.imagen, mimeType: 'image/jpeg' }),
        sendTextMessage: enviar,
        sendInteractiveButtons: enviar,
        sendCtaUrl: enviar,
    };
});
vi.mock('../services/ocr.service', () => ({ extractReceipt: vi.fn(async () => h.ocr) }));
vi.mock('../services/enrollment-ocr.service', () => ({ extractEnrollmentForm: vi.fn(async () => null) }));
vi.mock('../services/whatsapp-atencion.service', () => ({ debeAtender: vi.fn(async () => h.atencion) }));
vi.mock('../services/whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: vi.fn(async () => ({ registeredAccounts: [NEQUI], restrictedAccounts: [], cuentasFueraDeSportmaps: [] })),
}));
// El veredicto (rojo/amarillo/verde) no es lo que se prueba aquí: amarillo = revisión humana.
vi.mock('../services/receipt-verdict', async (original) => ({
    ...(await original<any>()),
    evaluateVerdict: vi.fn(() => ({ verdict: 'YELLOW', reasons: [] })),
}));
const evaluatePaymentReceiptMock = vi.fn(async (..._a: any[]) => ({ action: 'manual_review' }));
vi.mock('../services/receipt-approval.service', async (original) => ({
    ...(await original<any>()),
    evaluatePaymentReceipt: (...a: any[]) => evaluatePaymentReceiptMock(...a),
    redRejectionMessage: () => '',
}));
vi.mock('../services/whatsapp-bot.service', async (original) => ({
    ...(await original<any>()),
    abrirConsultaParaLaEscuela: vi.fn(async () => undefined),
    acusarAdjunto: vi.fn(async () => 'acusado'),
    conPresentacionSiEsPrimera: async (_w: unknown, _c: string, t: string) => t,
    anexoDeConsentimiento: async () => null,
}));

const { runWhatsAppQueue } = await import('../jobs/whatsapp-queue.job');

// ─── Semilla ──────────────────────────────────────────────────────────────────

const SCHOOL = 'school-qa-ventas';
const INTEG = 'int-qa-ventas';
const CONV = 'conv-qa-ventas';
const TEL = '573005550101';
const NEQUI = '3194505150';
const AHORA = '2026-11-08T15:00:00-05:00';
const hace = (min: number) => new Date(Date.parse(AHORA) - min * 60_000).toISOString();

const DESCRIPCION = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES! 🔥 Este 21 y 22 de noviembre, dos jornadas de técnica con un invitado de lujo. '
    + '📍 Colegio Bilingüe La Enseñanza. 🕘 9:00 a. m. a 3:00 p. m. 💰 Inversión: $300.000 (preventa hasta el 10 de noviembre); '
    + 'después del 10 de noviembre, $350.000. Hombres y mujeres de 14 años en adelante. Incluye camiseta y foto con los ponentes.';
const CLINICA = {
    id: 'item-clinica-qa', school_id: SCHOOL, name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    active: true, event_id: null, starts_at: '2026-11-21T00:00:00-05:00', ends_at: '2026-11-22T23:59:00-05:00',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null, description: DESCRIPCION, image_url: null,
};
const LEAD = {
    id: 'lead-qa-laura', school_id: SCHOOL, phone: '3005550101', full_name: 'Laura Gómez Ruiz', status: 'new',
    source_detail: { servicio_interes: { id: CLINICA.id, nombre: CLINICA.name, tipo: 'clase_extra' } },
    created_at: hace(170), updated_at: hace(170),
};

function limpiar(): void {
    for (const k of Object.keys(h.memoria)) delete h.memoria[k];
    h.rpcs.length = 0; h.enviados.length = 0; h.claim = []; h.n = 0;
    h.afiliado = false; h.parentId = null;
    h.atencion = { atender: false, tipo: 'desconocido', botEncendido: true };
    evaluatePaymentReceiptMock.mockClear();
}

function sembrarEscuela(): void {
    const m = h.memoria;
    m.schools = [{ id: SCHOOL, name: 'Escuela QA Voleibol', slug: 'escuela-qa-ventas' }];
    m.school_whatsapp_integrations = [{ id: INTEG, school_id: SCHOOL, phone_number_id: 'pn-qa', waba_id: null, access_token: 'tok', access_token_encrypted: 'tok', status: 'active' }];
    m.whatsapp_conversations = [{ id: CONV, integration_id: INTEG, school_id: SCHOOL, contact_wa_id: TEL, contact_name: 'Laura', parent_id: null, identified: false, status: 'open', created_at: hace(300) }];
    m.whatsapp_settings = [{ integration_id: INTEG, ai_enabled: true, mode: 'auto', assisted_until: null, responder_desconocidos: true, responder_prospectos: true }];
    m.school_settings = [{
        school_id: SCHOOL, wa_cobro_desde_comprobante: true, nequi_number: NEQUI, bank_titular_name: 'Iván Sossa',
        payment_accounts: [{ id: 'acc-qa', type: 'nequi', label: 'Nequi', value: NEQUI, active: true }],
    }];
    m.school_tournament_items = [{ ...CLINICA }];
    m.school_trial_class_settings = [{ school_id: SCHOOL, enabled: true, trial_price: 15000 }];
    m.whatsapp_messages = [];
    m.payments = [];
    m.whatsapp_inbound_queue = [];
}

function mensaje(direction: 'inbound' | 'outbound', texto: string, momento: string, payload: Record<string, unknown> = {}, ai = true): void {
    h.memoria.whatsapp_messages.push({
        id: `m-${++h.n}`, conversation_id: CONV, integration_id: INTEG, direction, type: 'text', text_body: texto, payload,
        ai_generated: direction === 'outbound' ? ai : false, wa_message_id: `wamid.m-${h.n}`,
        from_wa_id: direction === 'inbound' ? TEL : null, to_wa_id: direction === 'outbound' ? TEL : null,
        wa_timestamp: momento, created_at: momento, status: direction === 'outbound' ? 'sent' : 'received',
    });
}

/** La venta como la deja el frente A: anuncio → ficha marcada → «¿cuánto y cómo aparto?» → mensaje de pago marcado. */
function ventaPorAnuncio(): void {
    mensaje('inbound', 'Hola, quiero más información', hace(180), { referral: { source_id: 'ad-qa', headline: CLINICA.name } });
    mensaje('outbound', DESCRIPCION, hace(179), { step: 'anuncio_servicio', destino_anuncio: 'servicio', servicio_id: CLINICA.id, venta_servicio_id: CLINICA.id });
    mensaje('inbound', '¿Cuánto cuesta y cómo aparto mi cupo?', hace(172));
    mensaje('outbound', `Clínica de armadores y atacantes: hoy $300.000 (hasta el 10 de noviembre; desde el 11 de noviembre, $350.000). Separas con $150.000.\nNequi ${NEQUI} (a nombre de Iván Sossa).\nEnvía aquí el comprobante con el nombre completo de quien asiste.`,
        hace(171), { step: 'venta_pago', venta_servicio_id: CLINICA.id });
}

/** Caso Nicolás: la escuela pegó a mano la ficha hace 4 días (sin marcas); el bot nunca la mandó. */
function fichaPegadaPorLaEscuela(): void {
    mensaje('inbound', 'Buenas tardes, me pasan la info de la clínica?', hace(4 * 24 * 60 + 15));
    mensaje('outbound', DESCRIPCION, hace(4 * 24 * 60), {}, false);
}

function familiaAfiliada(): void {
    h.parentId = 'parent-qa';
    h.afiliado = true;
    h.atencion = { atender: true, tipo: 'familia', botEncendido: true };
    const m = h.memoria;
    m.whatsapp_conversations[0].parent_id = 'parent-qa';
    m.whatsapp_conversations[0].identified = true;
    m.profiles = [{ id: 'parent-qa', full_name: 'Marta Pérez', phone: TEL }];
    m.children = [{ id: 'child-qa', parent_id: 'parent-qa', full_name: 'Sofía Pérez', school_id: SCHOOL, is_active: true }];
    m.enrollments = [{ id: 'enr-qa', child_id: 'child-qa', school_id: SCHOOL, status: 'active', offering_plan_id: null }];
    m.payments.push({
        id: 'pay-mensualidad', school_id: SCHOOL, parent_id: 'parent-qa', child_id: 'child-qa', amount: 145000, status: 'pending',
        concept: 'Mensualidad 11/2026', payment_category: 'mensualidad', payment_type: 'monthly', due_date: '2026-11-10', created_at: hace(9000),
    });
}

function comprobante(monto: number, o: { caption?: string | null; referencia?: string; quien?: string | null; imagen?: string } = {}): string {
    const id = `f-${++h.n}`;
    h.imagen = Buffer.from(o.imagen ?? `imagen-${id}`).toString('base64');
    h.ocr = {
        isReceipt: true, isTransactionList: false, amount: monto, destination: NEQUI, reference: o.referencia ?? `M${100000 + h.n}`,
        bank: 'Nequi', date: '2026-11-08', provider: 'gemini', originName: o.quien === undefined ? 'Pedro Gómez' : o.quien, description: null,
    };
    mensaje('inbound', o.caption ?? '', AHORA, { caption: o.caption ?? null });
    h.memoria.whatsapp_messages.at(-1)!.type = 'image';
    const fila = {
        id, integration_id: INTEG, school_id: SCHOOL, wa_phone_number: TEL, wa_message_id: `wamid.${id}`,
        media_id: `media-${id}`, media_mime_type: 'image/jpeg', media_caption: o.caption ?? null, storage_path: null,
        retries: 0, status: 'processing', created_at: AHORA,
    };
    h.memoria.whatsapp_inbound_queue.push(fila);
    h.claim.push({ ...fila });
    return id;
}

const shaDe = (base64: string) => crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const enviados = () => h.enviados.join('\n---\n');
const cobros = () => h.rpcs.filter((r) => r.fn === 'wa_crear_cobro_desde_comprobante').map((r) => r.args);
const filaDeCola = (id: string) => h.memoria.whatsapp_inbound_queue.find((f) => f.id === id);
/** Lo que la regla 5 prohíbe en una venta: el padrón del club. */
const PADRON = /de qu[eé] deportista|no encontr[eé]|escr[ií]beme su nombre completo/i;
const dueno = (a: any) => a?.p_signup_lead_id || a?.p_child_id || a?.p_unregistered_id;

beforeEach(() => {
    // Solo la fecha, y avanzando: la cola mide ventanas de tiempo (ráfaga, acuse); un reloj congelado la cuelga.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(AHORA));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sin red en la prueba'); }));
    limpiar();
    sembrarEscuela();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ─── Escenarios ───────────────────────────────────────────────────────────────

describe('comprobante en la venta de un servicio (regla 5)', { timeout: 30_000 }, () => {
    it('prospecto con la venta abierta y su lead: $300.000 → cobro de la clínica a su nombre y respuesta de venta', async () => {
        ventaPorAnuncio();
        h.memoria.school_signup_leads = [{ ...LEAD }];
        comprobante(300000, { caption: 'Laura Gómez Ruiz' });
        await runWhatsAppQueue();
        expect(cobros()).toHaveLength(1);
        expect(cobros()[0]).toMatchObject({ p_fuente: 'tournament_item', p_fuente_id: CLINICA.id, p_monto: 300000 });
        expect(dueno(cobros()[0])).toBeTruthy();
        expect(enviados()).toMatch(/\$300\.000/);
        expect(enviados()).toMatch(/cl[ií]nica de armadores/i);
        expect(enviados()).not.toMatch(PADRON);
    });

    it('F5 — externo sin lead (la clínica es para gente de fuera): se crea el cobro a su nombre; nunca «¿De qué deportista es?»', async () => {
        ventaPorAnuncio();
        comprobante(300000, { caption: 'Comprobante clínica — Laura Gómez Ruiz' });
        await runWhatsAppQueue();
        expect(enviados()).not.toMatch(PADRON);
        expect(cobros()).toHaveLength(1);
        expect(cobros()[0]).toMatchObject({ p_fuente: 'tournament_item', p_fuente_id: CLINICA.id, p_monto: 300000 });
        expect(dueno(cobros()[0])).toBeTruthy();
        expect(enviados()).toMatch(/Laura/);
    });

    it('abono del 50 % ($150.000) → cobro de la clínica (queda parcial), sin «no coincide»', async () => {
        ventaPorAnuncio();
        h.memoria.school_signup_leads = [{ ...LEAD }];
        comprobante(150000, { caption: 'Abono clínica Laura Gómez Ruiz' });
        await runWhatsAppQueue();
        expect(cobros()).toHaveLength(1);
        expect(cobros()[0]).toMatchObject({ p_fuente_id: CLINICA.id, p_monto: 150000 });
        expect(enviados()).toMatch(/\$150\.000/);
        expect(enviados()).not.toMatch(/no coincide|no cuadra/i);
        expect(enviados()).not.toMatch(PADRON);
    });

    it('sin el nombre de quien asiste → «¿Nombre completo de quien asiste a …?» UNA vez; nunca el padrón del club', async () => {
        ventaPorAnuncio();
        const f1 = comprobante(300000, { caption: null, quien: null });
        await runWhatsAppQueue();
        expect(enviados()).not.toMatch(PADRON);
        expect(enviados()).toMatch(/nombre completo de quien asiste/i);
        expect(['waiting_user', 'done']).toContain(filaDeCola(f1)?.status);
        // Otra foto del mismo pago: la pregunta no se repite.
        const antes = h.enviados.filter((t) => /nombre completo de quien asiste/i.test(t)).length;
        comprobante(300000, { caption: null, quien: null });
        await runWhatsAppQueue();
        expect(h.enviados.filter((t) => /nombre completo de quien asiste/i.test(t)).length).toBe(antes);
        expect(enviados()).not.toMatch(PADRON);
    });

    it('el mismo comprobante otra vez (misma imagen y referencia) → «ya lo teníamos», sin cobro nuevo', async () => {
        ventaPorAnuncio();
        h.memoria.school_signup_leads = [{ ...LEAD }];
        const imagen = 'misma-imagen-clinica';
        h.memoria.payments.push({
            id: 'pay-clinica-previo', school_id: SCHOOL, signup_lead_id: LEAD.id, amount: 300000, status: 'awaiting_approval',
            concept: `${CLINICA.name} — ${LEAD.full_name}`, payment_category: 'clase_extra', ocr_reference: 'M777777',
            receipt_image_sha256: shaDe(Buffer.from(imagen).toString('base64')), receipt_verdict_at: hace(30), created_at: hace(40), due_date: '2026-11-21',
        });
        comprobante(300000, { caption: 'Laura Gómez Ruiz', referencia: 'M777777', imagen });
        await runWhatsAppQueue();
        expect(cobros()).toHaveLength(0);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(enviados()).toMatch(/ya lo (ten[ií]amos|hab[ií]a recibido|recib[ií])/i);
        expect(enviados()).not.toMatch(PADRON);
    });

    it('un monto que no es de la clínica ($123.456) → a la escuela con el motivo y se le dice a la persona; sin cobro', async () => {
        ventaPorAnuncio();
        h.memoria.school_signup_leads = [{ ...LEAD }];
        const f = comprobante(123456, { caption: 'Laura Gómez Ruiz' });
        await runWhatsAppQueue();
        expect(cobros()).toHaveLength(0);
        expect(h.enviados.length).toBeGreaterThan(0);
        expect(enviados()).toMatch(/escuela/i);
        expect(enviados()).not.toMatch(PADRON);
        expect(filaDeCola(f)?.result_type).toBe('escalated');
        expect(String(filaDeCola(f)?.error_message ?? '')).toMatch(/123\.456|123456|monto/i);
    });

    it('familia del club afiliada compra la clínica: $250.000 → cobro de la clínica para su deportista; la mensualidad ni se toca ni se cuela en la respuesta (regla 1)', async () => {
        familiaAfiliada();
        ventaPorAnuncio();
        comprobante(250000, { caption: 'Clínica Sofía Pérez' });
        await runWhatsAppQueue();
        expect(evaluatePaymentReceiptMock.mock.calls.map((c) => c[0])).not.toContain('pay-mensualidad');
        expect(cobros()).toHaveLength(1);
        expect(cobros()[0]).toMatchObject({ p_fuente_id: CLINICA.id, p_monto: 250000, p_child_id: 'child-qa' });
        expect(enviados()).not.toMatch(/mensualidad/i);
    });

    it('saldo de un abono anterior ($150.000) → al MISMO cobro de la clínica, sin crear otro', async () => {
        ventaPorAnuncio();
        h.memoria.school_signup_leads = [{ ...LEAD }];
        h.memoria.payments.push({
            id: 'pay-clinica-abono', school_id: SCHOOL, signup_lead_id: LEAD.id, amount: 300000, amount_paid: 150000, status: 'partial',
            concept: `${CLINICA.name} — ${LEAD.full_name}`, payment_category: 'clase_extra', created_at: hace(2000), due_date: '2026-11-21',
        });
        comprobante(150000, { caption: 'Saldo clínica Laura Gómez Ruiz' });
        await runWhatsAppQueue();
        expect(cobros()).toHaveLength(0);
        expect(evaluatePaymentReceiptMock.mock.calls.map((c) => c[0])).toContain('pay-clinica-abono');
        expect(enviados()).not.toMatch(PADRON);
    });

    it('regresión Nicolás: la escuela pegó la ficha a mano hace 4 días; $300.000 → cobro de la clínica, nunca la clase de prueba ni el padrón', async () => {
        fichaPegadaPorLaEscuela();
        comprobante(300000, { caption: 'Nicolás Rodríguez' });
        await runWhatsAppQueue();
        expect(cobros().some((c) => c.p_fuente === 'trial_price' || c.p_categoria === 'clase_prueba')).toBe(false);
        expect(enviados()).not.toMatch(/clase de prueba/i);
        expect(enviados()).not.toMatch(PADRON);
        expect(cobros()).toHaveLength(1);
        expect(cobros()[0]).toMatchObject({ p_fuente_id: CLINICA.id, p_monto: 300000 });
    });
});
