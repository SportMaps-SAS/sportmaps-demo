/**
 * Cobro abierto de la escuela, contactos sin teléfono (wau-), nombre del perfil y nombre tardío
 * (Monster 2026-11-11, docs/specs/pago-manual-de-servicio.md §3). Casos reales: Carlos Martínez ($175.000 al cobro de la
 * escuela, no un cobro externo) y Aleja (nombre del perfil, nombre tardío con acompañante). Misma base en memoria que
 * whatsapp-queue-venta.test.ts, con ilike con comodín _ y un 23505 inyectable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

vi.setConfig({ testTimeout: 30_000 });

const h = vi.hoisted(() => {
    const db: Record<string, any[]> = {};
    const archivos = new Map<string, Buffer>();
    const state = {
        atencion: { atender: true, tipo: 'desconocido', botEncendido: true, tomada: false } as any,
        identify: { data: { estado: 'desconocido' } } as any,
        afiliado: false,
        accion: 'manual_review' as string,
        cuentas: ['3194505150'] as string[],
        claim: [] as any[],
        ocrPorArchivo: {} as Record<string, any>,
        pendientesFamilia: [] as any[],
        errorUnico: false,
    };
    let seq = 0;
    const nuevoId = (p: string) => `${p}-${++seq}`;
    const reiniciar = () => {
        for (const k of Object.keys(db)) delete db[k];
        archivos.clear();
        seq = 0;
    };
    const tabla = (t: string) => (db[t] ??= []);

    /** `col`, `col->k`, `col->k->>j` sobre una fila (->> devuelve texto). */
    function valor(row: any, expr: string): any {
        const m = String(expr).trim().match(/^([a-z_0-9]+)((?:->>?[a-z_0-9]+)*)$/i);
        if (!m) return row?.[expr];
        let v = row?.[m[1]];
        for (const paso of m[2].match(/->>?[a-z_0-9]+/gi) ?? []) {
            const texto = paso.startsWith('->>');
            const k = paso.replace(/^->>?/, '');
            v = v == null || typeof v !== 'object' ? null : v[k];
            if (texto && v != null) v = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
        return v ?? null;
    }
    const igual = (a: any, b: any) => a === b || (a != null && b != null && String(a) === String(b));
    const comparar = (a: any, b: any) => {
        const da = Date.parse(a); const dbb = Date.parse(b);
        if (typeof a === 'string' && typeof b === 'string' && Number.isFinite(da) && Number.isFinite(dbb) && /\d{4}-\d{2}/.test(a)) return da - dbb;
        if (typeof a === 'number' || typeof b === 'number') return Number(a) - Number(b);
        return String(a).localeCompare(String(b));
    };
    /** Divide por comas que no están dentro de paréntesis. */
    function dividir(s: string): string[] {
        const out: string[] = []; let nivel = 0; let actual = '';
        for (const c of s) {
            if (c === '(') nivel++;
            if (c === ')') nivel--;
            if (c === ',' && nivel === 0) { out.push(actual); actual = ''; } else actual += c;
        }
        if (actual) out.push(actual);
        return out;
    }
    function condicionOr(row: any, cond: string): boolean {
        const m = cond.trim().match(/^([^.]+)\.(eq|neq|in|is|ilike|gte|lte)\.(.*)$/);
        if (!m) return false;
        const [, col, op, val] = m;
        const v = valor(row, col);
        if (op === 'eq') return igual(v, val);
        if (op === 'neq') return !igual(v, val);
        if (op === 'is') return val === 'null' ? v == null : igual(v, val);
        if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').some((x) => igual(v, x.trim()));
        if (op === 'ilike') return new RegExp(`^${val.replace(/%/g, '.*')}$`, 'i').test(String(v ?? ''));
        return false;
    }
    function proyectar(row: any, sel: string | undefined): any {
        const out = { ...row };
        if (!sel || sel.trim() === '*') return out;
        for (const parte of dividir(sel)) {
            const t = parte.trim();
            const i = t.indexOf(':');
            if (i > 0 && !t.includes('(')) out[t.slice(0, i).trim()] = valor(row, t.slice(i + 1).trim());
        }
        return out;
    }

    function builder(table: string) {
        const filtros: ((r: any) => boolean)[] = [];
        const ordenes: { col: string; asc: boolean; nullsFirst: boolean }[] = [];
        let op: 'select' | 'update' | 'insert' | 'delete' = 'select';
        let cols: string | undefined;
        let devolver = false;
        let cuenta = false;
        let carga: any = null;
        let tope: number | null = null;
        const b: any = {};
        b.select = (c?: string, o?: { count?: string; head?: boolean }) => {
            if (op === 'select') { cols = c; cuenta = !!o?.count; } else devolver = true;
            if (op !== 'select') cols = c;
            return b;
        };
        b.eq = (c: string, v: any) => { filtros.push((r) => igual(valor(r, c), v)); return b; };
        b.neq = (c: string, v: any) => { filtros.push((r) => !igual(valor(r, c), v)); return b; };
        b.in = (c: string, vs: any[]) => { filtros.push((r) => vs.some((v) => igual(valor(r, c), v))); return b; };
        b.is = (c: string, v: any) => { filtros.push((r) => (v === null ? valor(r, c) == null : igual(valor(r, c), v))); return b; };
        b.not = (c: string, o: string, v: any) => {
            filtros.push((r) => {
                if (o === 'is' && v === null) return valor(r, c) != null;
                if (o === 'in') return !String(v).replace(/^\(|\)$/g, '').split(',').some((x) => igual(valor(r, c), x.trim()));
                return true;
            });
            return b;
        };
        b.gte = (c: string, v: any) => { filtros.push((r) => valor(r, c) != null && comparar(valor(r, c), v) >= 0); return b; };
        b.gt = (c: string, v: any) => { filtros.push((r) => valor(r, c) != null && comparar(valor(r, c), v) > 0); return b; };
        b.lte = (c: string, v: any) => { filtros.push((r) => valor(r, c) != null && comparar(valor(r, c), v) <= 0); return b; };
        b.lt = (c: string, v: any) => { filtros.push((r) => valor(r, c) != null && comparar(valor(r, c), v) < 0); return b; };
        b.ilike = (c: string, p: string) => { filtros.push((r) => new RegExp(`^${String(p).replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i').test(String(valor(r, c) ?? ''))); return b; };
        b.or = (expr: string) => { const conds = dividir(expr); filtros.push((r) => conds.some((cd) => condicionOr(r, cd))); return b; };
        b.order = (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => {
            const asc = o?.ascending !== false;
            ordenes.push({ col: c, asc, nullsFirst: o?.nullsFirst ?? !asc });
            return b;
        };
        b.limit = (n: number) => { tope = n; return b; };
        b.update = (v: any) => { op = 'update'; carga = v; return b; };
        b.insert = (v: any) => { op = 'insert'; carga = v; return b; };
        b.upsert = (v: any) => { op = 'insert'; carga = v; return b; };
        b.delete = () => { op = 'delete'; return b; };
        const correr = () => {
            const filas = tabla(table);
            if (op === 'insert') {
                const ahora = new Date().toISOString();
                const nuevas = (Array.isArray(carga) ? carga : [carga]).map((r: any) => ({
                    id: r.id ?? nuevoId(table), created_at: ahora, updated_at: ahora, ...r,
                }));
                filas.push(...nuevas);
                return { data: devolver ? nuevas.map((r: any) => proyectar(r, cols)) : null, error: null };
            }
            let elegidas = filas.filter((r) => filtros.every((f) => f(r)));
            if (op === 'update') {
                if (table === 'payments' && state.errorUnico && (carga as any)?.receipt_image_sha256) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_payments_school_ocr_reference"' } };
                for (const r of elegidas) Object.assign(r, carga);
                return { data: devolver ? elegidas.map((r) => proyectar(r, cols)) : null, error: null };
            }
            if (op === 'delete') {
                db[table] = filas.filter((r) => !elegidas.includes(r));
                return { data: null, error: null };
            }
            if (cuenta) return { data: null, count: elegidas.length, error: null };
            for (const o of [...ordenes].reverse()) {
                elegidas = [...elegidas].sort((x, y) => {
                    const a = valor(x, o.col); const c = valor(y, o.col);
                    if (a == null && c == null) return 0;
                    if (a == null) return o.nullsFirst ? -1 : 1;
                    if (c == null) return o.nullsFirst ? 1 : -1;
                    return o.asc ? comparar(a, c) : comparar(c, a);
                });
            }
            if (tope !== null) elegidas = elegidas.slice(0, tope);
            return { data: elegidas.map((r) => proyectar(r, cols)), error: null };
        };
        b.maybeSingle = () => { const r = correr(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }); };
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve().then(correr).then(res, rej);
        return b;
    }

    const VIVOS = ['pending', 'overdue', 'awaiting_approval', 'partial', 'paid', 'glosado'];
    const hoyBogota = (ms: number) => new Date(ms - 5 * 3600_000).toISOString().slice(0, 10);

    /** La RPC con las reglas de 20261030123549 (solo lo que estas pruebas usan). */
    function rpcCrearCobro(a: any) {
        const prev = tabla('wa_cobros_desde_comprobante').find((w) => w.queue_id === a.p_queue_id && w.fuente === a.p_fuente
            && (w.fuente_id ?? null) === (a.p_fuente_id ?? null));
        if (prev) {
            const p = tabla('payments').find((x) => x.id === prev.payment_id);
            return { ok: true, payment_id: p.id, precio: p.amount, es_abono: prev.es_abono, ya_existia: true };
        }
        const lead = a.p_signup_lead_id ? tabla('school_signup_leads').find((l) => l.id === a.p_signup_lead_id) : null;
        const nino = a.p_child_id ? tabla('children').find((c) => c.id === a.p_child_id) : null;
        if (a.p_signup_lead_id && !lead) return { ok: false, codigo: 'dueno_invalido' };
        const nombre = (lead?.full_name ?? nino?.full_name ?? 'Prospecto') as string;
        let precio: number; let categoria: string; let esAbono = false; let concepto: string;
        if (a.p_fuente === 'trial_price') {
            precio = tabla('school_trial_class_settings')[0]?.trial_price;
            categoria = 'clase_prueba';
            concepto = `Clase de prueba — ${nombre}`;
            if (Math.abs(precio - a.p_monto) > 1) return { ok: false, codigo: 'monto_no_coincide', precio };
        } else {
            const it = tabla('school_tournament_items').find((i) => i.id === a.p_fuente_id);
            if (!it || !it.active) return { ok: false, codigo: 'item_no_disponible' };
            const hoy = hoyBogota(Date.now());
            precio = it.price;
            for (const t of [...(it.precios_por_fecha ?? [])].sort((x: any, y: any) => x.desde.localeCompare(y.desde))) {
                if (t.desde <= hoy) precio = t.precio;
            }
            const afiliado = !!a.p_child_id || state.afiliado;
            if (afiliado && it.precio_afiliado != null) precio = it.precio_afiliado;
            categoria = it.kind;
            const ya = tabla('wa_cobros_desde_comprobante').filter((w) => w.fuente === 'tournament_item' && w.fuente_id === it.id)
                .map((w) => tabla('payments').find((p) => p.id === w.payment_id))
                .find((p) => p && VIVOS.includes(p.status) && (a.p_child_id ? p.child_id === a.p_child_id : p.signup_lead_id === a.p_signup_lead_id));
            if (ya) return { ok: false, codigo: 'ya_tiene_cobro', payment_id: ya.id };
            if (Math.abs(precio - a.p_monto) > 1) {
                const minimo = it.allow_installments && it.abono_minimo_pct != null ? Math.ceil((precio * it.abono_minimo_pct) / 100) : null;
                if (minimo !== null && a.p_monto < precio && a.p_monto >= minimo - 1) esAbono = true;
                else return { ok: false, codigo: 'monto_no_coincide', precio, abono_minimo: minimo };
            }
            concepto = `${it.name} — ${nombre}`;
        }
        if (a.p_categoria && a.p_categoria !== categoria) return { ok: false, codigo: 'categoria_no_coincide', categoria };
        concepto = (a.p_concepto && String(a.p_concepto).trim()) || concepto;
        const pid = nuevoId('pay');
        tabla('payments').push({
            id: pid, school_id: a.p_school_id, child_id: a.p_child_id ?? null, unregistered_athlete_id: a.p_unregistered_id ?? null,
            signup_lead_id: a.p_signup_lead_id ?? null, amount: precio, amount_paid: 0, concept: concepto, status: 'pending',
            payment_category: categoria, created_at: new Date().toISOString(),
        });
        tabla('wa_cobros_desde_comprobante').push({
            payment_id: pid, school_id: a.p_school_id, queue_id: a.p_queue_id, fuente: a.p_fuente, fuente_id: a.p_fuente_id ?? null, es_abono: esAbono,
        });
        return { ok: true, payment_id: pid, precio, es_abono: esAbono, ya_existia: false, concepto, categoria };
    }

    const rpcLlamadas: { name: string; args: any }[] = [];
    const rpc = (name: string, args?: any) => {
        rpcLlamadas.push({ name, args });
        if (name === 'wa_queue_claim') {
            for (const f of state.claim) {
                const fila = tabla('whatsapp_inbound_queue').find((x) => x.id === f.id);
                if (fila) Object.assign(fila, { status: 'processing' });
                else tabla('whatsapp_inbound_queue').push({ ...f, status: 'processing' });
            }
            return Promise.resolve({ data: state.claim.map((f) => ({ ...f })), error: null });
        }
        if (name === 'wa_identify_staff_admin_by_phone') return Promise.resolve({ data: { estado: 'desconocido' }, error: null });
        if (name === 'wa_identify_by_phone') return Promise.resolve(state.identify);
        if (name === 'wa_es_afiliado') return Promise.resolve({ data: { afiliado: state.afiliado }, error: null });
        if (name === 'wa_record_outbound_message') {
            tabla('whatsapp_messages').push({
                id: nuevoId('msg'), conversation_id: args.p_conversation_id, direction: 'outbound', type: args.p_type,
                text_body: args.p_text_body, payload: args.p_payload, ai_generated: args.p_ai_generated,
                created_at: new Date().toISOString(), wa_timestamp: new Date().toISOString(),
            });
            return Promise.resolve({ data: null, error: null });
        }
        if (name === 'wa_crear_cobro_desde_comprobante') return Promise.resolve({ data: rpcCrearCobro(args), error: null });
        if (name === 'wa_cubrir_cobros_con_comprobante') return Promise.resolve({ data: 0, error: null });
        return Promise.resolve({ data: null, error: null });
    };

    const storage = {
        from: () => ({
            upload: (path: string, buf: Buffer) => { archivos.set(path, Buffer.from(buf)); return Promise.resolve({ data: {}, error: null }); },
            download: (path: string) => Promise.resolve(archivos.has(path)
                ? { data: new Blob([archivos.get(path) as any]), error: null }
                : { data: null, error: { message: 'no existe' } }),
        }),
    };

    return { db, state, tabla, builder, rpc, rpcLlamadas, storage, reiniciar, nuevoId };
});

vi.mock('../config/supabase', () => ({
    supabase: { from: (t: string) => h.builder(t), rpc: (n: string, a?: any) => h.rpc(n, a), storage: h.storage },
}));

const sendTextMessageMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, waMessageId: `wamid.out.${Math.random()}` }));
const sendInteractiveButtonsMock = vi.fn((..._a: any[]) => Promise.resolve({ ok: true, waMessageId: `wamid.btn.${Math.random()}` }));
vi.mock('../services/whatsapp.service', () => ({
    // El «archivo» de cada media es su id: la misma foto reenviada = el mismo id de contenido.
    downloadMedia: vi.fn((_wa: any, mediaId: string) => Promise.resolve({
        ok: true, base64: Buffer.from(String(mediaId).replace(/#.*$/, '')).toString('base64'), mimeType: 'image/jpeg',
    })),
    sendTextMessage: (...a: any[]) => sendTextMessageMock(...a),
    sendInteractiveButtons: (...a: any[]) => sendInteractiveButtonsMock(...a),
    aFormatoWhatsApp: (t: string) => t,
}));
vi.mock('../services/whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(() => Promise.resolve(false)), AVISO_DADO_DE_BAJA: '' }));
vi.mock('../services/whatsapp-atencion.service', async () => ({
    ...(await vi.importActual<any>('../services/whatsapp-atencion.service')),
    debeAtender: vi.fn(() => Promise.resolve(h.state.atencion)),
}));
vi.mock('../services/whatsapp-invitacion-vigente.service', () => ({
    invitacionPendienteVigente: vi.fn(() => Promise.resolve({ invitacion: null, atletaInactivo: false })),
}));
vi.mock('../services/whatsapp-bot.service', () => ({
    abrirConsultaParaLaEscuela: vi.fn(() => Promise.resolve()),
    acusarAdjunto: vi.fn(() => Promise.resolve('acusado')),
    conPresentacionSiEsPrimera: vi.fn(async (_w: any, _c: string, t: string) => t),
    anexoDeConsentimiento: vi.fn(async () => null),
}));
const extractReceiptMock = vi.fn(async (base64: string) => {
    const o = h.state.ocrPorArchivo[Buffer.from(base64, 'base64').toString()];
    if (!o) throw new Error('sin OCR para ese archivo');
    return o;
});
vi.mock('../services/ocr.service', () => ({ extractReceipt: (b: string) => extractReceiptMock(b) }));
vi.mock('../services/enrollment-ocr.service', () => ({ extractEnrollmentForm: vi.fn() }));
vi.mock('../services/receipt-context.service', () => ({
    buildVerdictContext: vi.fn(() => Promise.resolve({ registeredAccounts: h.state.cuentas, restrictedAccounts: [] })),
}));
vi.mock('../services/receipt-verdict', () => {
    const clasificar = (d: any, a: any[]) => (!d || !a?.length ? 'none' : a.includes(d) ? 'exact' : 'none');
    return {
        normalizeDestination: (d: any) => d,
        normalizeReference: (r: any) => r,
        destinationMatchesRegistered: (d: any, a: any[]) => clasificar(d, a) !== 'none',
        classifyDestinationMatch: clasificar,
        maskedDestinationSuffix: () => null,
        evaluateVerdict: vi.fn(() => ({ verdict: 'amarillo', reasons: [] })),
    };
});
const evaluatePaymentReceiptMock = vi.fn((..._a: any[]) => Promise.resolve({ action: h.state.accion }));
vi.mock('../services/receipt-approval.service', () => ({
    evaluatePaymentReceipt: (...a: any[]) => evaluatePaymentReceiptMock(...a),
    redRejectionMessage: vi.fn(() => ''),
}));
vi.mock('../services/whatsapp-venta-servicios.service', async () => ({
    ...(await vi.importActual<any>('../services/whatsapp-venta-servicios.service')),
    ventaAbiertaDeContacto: vi.fn(() => Promise.resolve(null)),
    decidirComprobanteDeVenta: vi.fn(() => ({ tipo: 'seguir' })),
}));
vi.mock('../services/whatsapp-receipt-matching.service', async () => ({
    ...(await vi.importActual<any>('../services/whatsapp-receipt-matching.service')),
    pagosPendientesDe: vi.fn(() => Promise.resolve(h.state.pendientesFamilia)),
}));

const { runWhatsAppQueue, _fijarCargadorAgenda } = await import('./whatsapp-queue.job');
const { resolverRespuestaDeCobro } = await import('../services/whatsapp-respuesta-de-cobro.service');
const { _olvidarModoDiscretoEfectivo } = await import('../services/whatsapp-ajustes-escuela.service');
const cobro = await import('../services/wa-cobro-desde-comprobante.service');
const ficha = await import('../services/whatsapp-comprobante-de-ficha.service');
const job = await import('./whatsapp-queue.job');

// ─── Datos (forma de Monster, nombres de prueba) ─────────────────────────────

const ESCUELA = 'school-monster';
const INTEGRACION = { id: 'int-1', school_id: ESCUELA, access_token: 'tok', phone_number_id: 'pn-1' };
const TEL = '573017517726';
/** Contacto sin teléfono (commit fdd94c61): alias del BSUID de Meta. */
const WAU = 'wau-CO.-b-c-d-e-f-g-h-i-j-a-b-c-d-e-f-g';
const CONV = 'conv-1';
const CLINICA_ID = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';
const CLINICA = {
    id: CLINICA_ID, school_id: ESCUELA, name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    active: true, event_id: null, starts_at: '2026-11-21T00:00:00-05:00', ends_at: '2026-11-22T23:59:00-05:00',
    description: 'Clínica para armadores y atacantes, 21 y 22 de noviembre', image_url: null,
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    precios_afiliado_por_fecha: [{ desde: '2026-11-16', precio: 300000 }],
    abono_minimo_pct: 50, opciones: null, capacity: null,
};
const FICHA_ESCUELA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥\n\n¿Quieres llevar tu juego al siguiente nivel? '
    + 'Esta es una oportunidad para aprender de los mejores. 📅 21 y 22 de noviembre. 💰 Preventa $300.000 hasta el 10 de noviembre.';

const iso = (s: string) => new Date(s).toISOString();
const enHora = (s: string) => vi.setSystemTime(new Date(s));

function comprobante(amount: number, extra: Record<string, unknown> = {}) {
    return {
        isReceipt: true, isTransactionList: false, amount, currency: 'COP', date: '2026-11-10', time: '12:30',
        bank: 'Nequi', reference: `REF${amount}`, destination: '3194505150', destinationName: 'Iván Sossa',
        originName: 'JUAN CUBIDES', description: null, missingFields: [], provider: 'gemini', ...extra,
    };
}

function foto(id: string, archivo: string, cuando: string, extra: Record<string, unknown> = {}) {
    return {
        id, integration_id: 'int-1', school_id: ESCUELA, wa_phone_number: TEL, wa_message_id: `wamid.${id}`,
        media_id: `${archivo}#${id}`, media_mime_type: 'image/jpeg', storage_path: null, retries: 0, created_at: iso(cuando),
        media_caption: null, ...extra,
    };
}

async function procesar(f: ReturnType<typeof foto>, ocr: any, archivo: string) {
    h.state.ocrPorArchivo[archivo] = ocr;
    h.state.claim = [f];
    await runWhatsAppQueue();
}

function mensaje(direction: 'inbound' | 'outbound', texto: string | null, cuando: string, extra: Record<string, unknown> = {}) {
    h.tabla('whatsapp_messages').push({
        id: h.nuevoId('msg'), conversation_id: CONV, direction, type: texto ? 'text' : 'image', text_body: texto,
        payload: {}, ai_generated: false, created_at: iso(cuando), wa_timestamp: iso(cuando), ...extra,
    });
}

const textosEnviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const crearLlamadas = () => h.rpcLlamadas.filter((l) => l.name === 'wa_crear_cobro_desde_comprobante').map((l) => l.args);
const fila = (id: string) => h.tabla('whatsapp_inbound_queue').find((f) => f.id === id);
const pagos = () => h.tabla('payments');
const pago = (id: string) => pagos().find((p) => p.id === id);

function escuela(o: { contacto?: string; perfil?: string | null } = {}) {
    h.tabla('school_whatsapp_integrations').push({ ...INTEGRACION });
    h.tabla('schools').push({ id: ESCUELA, slug: 'monsters-volley-club' });
    h.tabla('school_settings').push({ school_id: ESCUELA, wa_cobro_desde_comprobante: true, allow_installments: true });
    h.tabla('school_tournament_items').push({ ...CLINICA, precios_por_fecha: [...CLINICA.precios_por_fecha] });
    h.tabla('school_trial_class_settings').push({ school_id: ESCUELA, trial_price: 15000 });
    h.tabla('whatsapp_conversations').push({
        id: CONV, integration_id: 'int-1', contact_wa_id: o.contacto ?? TEL, parent_id: null, identified: false,
        contact_name: o.perfil ?? null,
    });
}

/** La conversación de venta: la escuela pegó la ficha y los datos de pago A MANO. */
function conversacionDeVenta() {
    mensaje('inbound', 'Estoy interesado', '2026-11-04T19:45:13-05:00');
    mensaje('outbound', FICHA_ESCUELA, '2026-11-04T20:00:27-05:00');
    mensaje('inbound', 'Donde podría pagar el cupo', '2026-11-04T20:17:29-05:00');
    mensaje('outbound', 'Realizar el pago al nequi o daviplata al número 3194505150 y este soporte debe ser enviado por este medio '
        + 'indicando el nombre del jugador', '2026-11-04T20:19:29-05:00');
}

function responderDelBot() {
    const enviados: { texto: string; paso: string; payload?: Record<string, unknown> }[] = [];
    const fn = vi.fn(async (texto: string, paso: string, _b?: any, _l?: any, payload?: Record<string, unknown>) => {
        enviados.push({ texto, paso, payload });
        return { ok: true };
    });
    return { fn, enviados };
}

/** Carlos Martínez: ficha INACTIVA consolidada con su perfil; el cobro de la escuela es de su `user_id`, categoría «otro». */
function carlos(extra: { cobro?: Record<string, unknown> } = {}) {
    h.tabla('unregistered_athletes').push({
        id: 'ua-carlos', school_id: ESCUELA, full_name: 'Carlos Martínez', is_active: false, linked_profile_id: 'prof-carlos',
    });
    h.tabla('profiles').push({ id: 'prof-carlos', full_name: 'Carlos Martínez' });
    h.tabla('school_members').push({ school_id: ESCUELA, profile_id: 'prof-carlos', status: 'active', role: 'athlete' });
    h.tabla('payments').push({
        id: 'pay-escuela', school_id: ESCUELA, user_id: 'prof-carlos', child_id: null, unregistered_athlete_id: null, signup_lead_id: null,
        amount: 175000, amount_paid: 0, status: 'pending', payment_category: 'otro',
        concept: 'Clínica Jorge Mesa — Carlos Martínez', created_at: iso('2026-11-09T10:00:00-05:00'), ...(extra.cobro ?? {}),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    h.reiniciar();
    h.rpcLlamadas.length = 0;
    h.state.atencion = { atender: true, tipo: 'desconocido', botEncendido: true, tomada: false };
    h.state.identify = { data: { estado: 'desconocido' } };
    h.state.afiliado = false;
    h.state.accion = 'manual_review';
    h.state.cuentas = ['3194505150'];
    h.state.ocrPorArchivo = {};
    h.state.pendientesFamilia = [];
    h.state.errorUnico = false;
    _fijarCargadorAgenda(null);
    _olvidarModoDiscretoEfectivo();
    vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
    vi.useRealTimers();
});

// ─── (1) Carlos Martínez: contacto wau-, ficha inactiva, cobro de la escuela ─

describe('Carlos Martínez (contacto wau-, ficha inactiva con linked_profile_id, cobro de la escuela «otro» con user_id)', () => {
    it('aplica $175.000 al cobro de la escuela y NO crea un cobro externo', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('c1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(175000, { reference: '1869669577' }), 'A');

        expect(crearLlamadas()).toHaveLength(0);
        expect(pagos()).toHaveLength(1);
        expect(pago('pay-escuela')).toMatchObject({ status: 'awaiting_approval', ocr_amount: 175000, ocr_reference: '1869669577', amount: 175000 });
        expect(fila('c1')).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: 'pay-escuela' });
        // A quien escribe, solo lo que él mismo dijo: ni cobros, ni montos de otros, ni nada de la ficha.
        const dicho = textosEnviados().join(' ');
        expect(dicho).toContain('Carlos Martínez');
        expect(dicho).not.toMatch(/inactiv|ficha|perfil|prof-carlos|Jorge Mesa/i);
    });

    it('lo mismo con el nombre guardado en el prospecto (anotarAsistente) y el perfil con emoji', async () => {
        escuela({ contacto: WAU, perfil: 'Carlos 🏐' });
        conversacionDeVenta();
        carlos();
        h.tabla('school_signup_leads').push({
            id: 'lead-wau', school_id: ESCUELA, phone: WAU, full_name: 'Carlos 🏐', status: 'contacted',
            source_detail: { asistente_servicio: { nombre: 'Carlos Martínez', servicio_id: CLINICA_ID } },
        });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('c1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU }), comprobante(175000), 'A');
        expect(crearLlamadas()).toHaveLength(0);
        expect(pago('pay-escuela')).toMatchObject({ status: 'awaiting_approval', ocr_amount: 175000 });
    });

    it('homónimos (dos «Carlos Martínez» en el club) → a la escuela, sin aplicar nada ni mostrar nombres', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        h.tabla('unregistered_athletes').push({ id: 'ua-otro', school_id: ESCUELA, full_name: 'Carlos Martínez', is_active: true, linked_profile_id: null });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('c1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(175000), 'A');
        expect(crearLlamadas()).toHaveLength(0);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
        expect(fila('c1')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('c1').error_message).toMatch(/^venta_atleta_homonimos:/);
        expect(textosEnviados().join(' ')).not.toMatch(/homónimo|2 personas|otro Carlos/i);
    });

    it('el nombre no es de nadie del club → sigue el camino de siempre (cobro externo del servicio por su precio)', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('c1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Pedro Gómez Rojas' }),
            comprobante(300000), 'A');
        expect(crearLlamadas()).toHaveLength(1);
    });

    it('un wau- que paga un monto de grupo sin decir el nombre: se le pregunta (no va directo a la escuela)', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('c1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU }), comprobante(175000), 'A');
        expect(fila('c1')).toMatchObject({ status: 'waiting_user', pregunta_ocr: { tipo: 'asistente_servicio' } });
        expect(textosEnviados()).toHaveLength(1);
        expect(textosEnviados()[0]).toMatch(/nombre completo de quien asiste/);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
    });
});

// ─── (2) Montos contra el cobro abierto ──────────────────────────────────────

describe('montos contra el cobro abierto de la escuela', () => {
    const correr = async (monto: number, cobro: Record<string, unknown> = {}) => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos({ cobro });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('m1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(monto), 'A');
    };

    it('$87.500 sobre un cobro de $175.000 = el abono mínimo (50 %): abono, en revisión', async () => {
        await correr(87500);
        expect(crearLlamadas()).toHaveLength(0);
        expect(pago('pay-escuela')).toMatchObject({ status: 'awaiting_approval', ocr_amount: 87500, amount: 175000 });
        expect(textosEnviados().join(' ')).toMatch(/Recibí tu abono de \*\$87\.500\*/);
        expect(textosEnviados().join(' ')).toMatch(/Quedan \*\$87\.500\*/);
    });

    it('$120.000 sobre $175.000 ya es un abono válido (≥ 50 %): abono en revisión', async () => {
        await correr(120000);
        expect(pago('pay-escuela')).toMatchObject({ status: 'awaiting_approval', ocr_amount: 120000 });
    });

    it('$120.000 sobre un cobro de $300.000 (abono mínimo $150.000): a la escuela con «aplicar al cobro X», sin tocar el cobro', async () => {
        await correr(120000, { amount: 300000 });
        expect(crearLlamadas()).toHaveLength(0);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending', amount: 300000 });
        expect(fila('m1')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('m1').error_message).toMatch(/^venta_cobro_abierto_monto:/);
        expect(fila('m1').error_message).toContain('aplicar al cobro pay-escuela');
    });

    it('$87.000 (por debajo del mínimo de $87.500) sobre $175.000: a la escuela', async () => {
        await correr(87000);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
        expect(fila('m1').error_message).toMatch(/^venta_cobro_abierto_monto:/);
    });

    it('un monto MAYOR al cobro abierto: a la escuela (no se aplica ni se crea nada)', async () => {
        await correr(300000);
        expect(crearLlamadas()).toHaveLength(0);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
        expect(fila('m1').error_message).toMatch(/^venta_cobro_abierto_monto:/);
    });

    it('dos cobros abiertos de la clínica → ambiguo: a la escuela', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        h.tabla('payments').push({
            id: 'pay-escuela-2', school_id: ESCUELA, user_id: 'prof-carlos', amount: 175000, amount_paid: 0, status: 'pending',
            payment_category: 'otro', concept: 'Clínica Jorge Mesa — Carlos Martínez (2.º cupo)', created_at: iso('2026-11-09T11:00:00-05:00'),
        });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('m1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(175000), 'A');
        expect(fila('m1').error_message).toMatch(/^venta_cobro_abierto_ambiguo:/);
        expect(pagos().filter((p) => p.status === 'pending')).toHaveLength(2);
    });

    it('un cobro «otro» que NO es de la clínica (otro concepto) no se toca', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos({ cobro: { concept: 'Uniforme de entrenamiento — Carlos Martínez' } });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('m1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(175000), 'A');
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
    });
});

// ─── (3) Aleja: nombre del perfil de WhatsApp ────────────────────────────────

describe('Aleja (lead con el nombre del perfil de WhatsApp)', () => {
    it('el lead se llama como el perfil («Aleja 💫»): se pregunta el nombre y no se crea el cobro', async () => {
        escuela({ perfil: 'Aleja 💫' });
        conversacionDeVenta();
        h.tabla('school_signup_leads').push({
            id: 'lead-aleja', school_id: ESCUELA, phone: '3017517726', full_name: 'Aleja 💫', status: 'contacted',
            source_detail: { registro_completo_at: '2026-11-08T10:00:00Z' },
        });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('a1', 'A', '2026-11-10T12:30:00-05:00'), comprobante(300000), 'A');
        expect(crearLlamadas()).toHaveLength(0);
        expect(fila('a1')).toMatchObject({ status: 'waiting_user', pregunta_ocr: { tipo: 'asistente_servicio' } });
        expect(textosEnviados()).toHaveLength(1);
        expect(textosEnviados()[0]).toMatch(/nombre completo de quien asiste/);
    });

    it('con un nombre real ya confirmado como quien asiste, no se vuelve a preguntar aunque se parezca al perfil', async () => {
        escuela({ perfil: 'Laura Gómez' });
        conversacionDeVenta();
        h.tabla('school_signup_leads').push({
            id: 'lead-l', school_id: ESCUELA, phone: '3017517726', full_name: 'Laura Gómez', status: 'contacted',
            source_detail: { asistente_servicio: { nombre: 'Laura Gómez', servicio_id: CLINICA_ID } },
        });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('a1', 'A', '2026-11-10T12:30:00-05:00'), comprobante(300000), 'A');
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_concepto: 'Clínica de armadores y atacantes — Laura Gómez' })]);
    });
});

// ─── (4) Nombre tardío ───────────────────────────────────────────────────────

describe('nombre tardío (llega después del comprobante, sin fila waiting_user)', () => {
    const TEXTO = 'María Alejandra Muñoz Hernández\nAcompañante: Juan Sebastian Muñoz Hernández';
    const sembrar = (o: { concepto?: string; hace?: string } = {}) => {
        escuela({ perfil: 'Aleja 💫' });
        h.tabla('school_signup_leads').push({
            id: 'lead-aleja', school_id: ESCUELA, phone: TEL, full_name: 'Aleja 💫', status: 'contacted', source_detail: { registro_completo_at: 'x' },
        });
        h.tabla('payments').push({
            id: 'pay-aleja', school_id: ESCUELA, signup_lead_id: 'lead-aleja', amount: 300000, amount_paid: 0, status: 'awaiting_approval',
            payment_category: 'clase_extra', concept: o.concepto ?? 'Clínica de armadores y atacantes — Aleja 💫',
        });
        h.tabla('whatsapp_inbound_queue').push({
            id: 'f-aleja', integration_id: 'int-1', school_id: ESCUELA, wa_phone_number: TEL, status: 'done', result_type: 'payment_receipt',
            result_ref_id: 'pay-aleja', created_at: iso(o.hace ?? '2026-11-10T14:00:00-05:00'),
        });
    };

    it('actualiza el prospecto, el acompañante y el concepto del cobro, sin tocar monto ni estado; responde DESPUÉS de guardar', async () => {
        sembrar();
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        const orden: string[] = [];
        bot.fn.mockImplementation(async (texto: string, paso: string) => {
            orden.push(`responde:${pago('pay-aleja').concept}`);
            bot.enviados.push({ texto, paso });
            return { ok: true };
        });
        const consumio = await resolverRespuestaDeCobro(INTEGRACION as any, TEL, TEXTO, bot.fn as any);
        expect(consumio).toBe(true);
        const lead = h.tabla('school_signup_leads')[0];
        expect(lead.full_name).toBe('María Alejandra Muñoz Hernández');
        expect(lead.source_detail).toMatchObject({
            acompanante: 'Juan Sebastian Muñoz Hernández', contacto: 'Aleja 💫', registro_completo_at: 'x',
            asistente_servicio: { nombre: 'María Alejandra Muñoz Hernández' },
        });
        expect(pago('pay-aleja')).toMatchObject({
            concept: 'Clínica de armadores y atacantes — María Alejandra Muñoz Hernández', amount: 300000, status: 'awaiting_approval', amount_paid: 0,
        });
        // La respuesta salió con el cobro YA actualizado (nunca «anotado» antes de guardar).
        expect(orden).toEqual(['responde:Clínica de armadores y atacantes — María Alejandra Muñoz Hernández']);
        expect(bot.enviados).toHaveLength(1);
        expect(bot.enviados[0].paso).toBe('nombre_tardio_registrado');
        expect(bot.enviados[0].texto).toContain('María Alejandra Muñoz Hernández');
        expect(bot.enviados[0].texto).toContain('Juan Sebastian Muñoz Hernández');
    });

    it('sin acompañante: solo el nombre', async () => {
        sembrar();
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'Se llama María Alejandra Muñoz Hernández', bot.fn as any)).toBe(true);
        expect(h.tabla('school_signup_leads')[0].source_detail.acompanante).toBeUndefined();
        expect(pago('pay-aleja').concept).toBe('Clínica de armadores y atacantes — María Alejandra Muñoz Hernández');
    });

    it('si falla guardar, no promete nada y el texto sigue al bot general', async () => {
        sembrar();
        enHora('2026-11-10T20:00:00-05:00');
        h.tabla('school_signup_leads').length = 0; // el prospecto ya no existe
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, TEXTO, bot.fn as any)).toBe(false);
        expect(bot.enviados).toHaveLength(0);
        expect(pago('pay-aleja').concept).toBe('Clínica de armadores y atacantes — Aleja 💫');
    });

    it('un texto nuevo sin comprobante reciente no hace nada (sigue al bot general)', async () => {
        escuela({ perfil: 'Aleja 💫' });
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, TEXTO, bot.fn as any)).toBe(false);
        expect(bot.enviados).toHaveLength(0);
    });

    it('un comprobante de hace más de 48 h no cuenta', async () => {
        sembrar({ hace: '2026-11-07T14:00:00-05:00' });
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, TEXTO, bot.fn as any)).toBe(false);
        expect(pago('pay-aleja').concept).toBe('Clínica de armadores y atacantes — Aleja 💫');
    });

    it('si el cobro ya tiene un nombre real, no se reescribe', async () => {
        sembrar({ concepto: 'Clínica de armadores y atacantes — Laura Gómez Pérez' });
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, TEXTO, bot.fn as any)).toBe(false);
        expect(pago('pay-aleja').concept).toBe('Clínica de armadores y atacantes — Laura Gómez Pérez');
    });

    it('un texto que no parece un nombre («ok gracias», una pregunta) no lee nada ni cambia nada', async () => {
        sembrar();
        enHora('2026-11-10T20:00:00-05:00');
        const bot = responderDelBot();
        for (const t of ['ok gracias', '¿a qué hora es la clínica?', 'Hola buenas tardes']) {
            expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, t, bot.fn as any)).toBe(false);
        }
        expect(pago('pay-aleja').concept).toBe('Clínica de armadores y atacantes — Aleja 💫');
    });
});

// ─── (5) Doble canal ─────────────────────────────────────────────────────────

describe('doble canal: el mismo comprobante por la app y por WhatsApp', () => {
    it('misma referencia normalizada (la app guardó receipt_reference_norm) → «ya recibido», sin crear nada', async () => {
        escuela();
        conversacionDeVenta();
        h.tabla('payments').push({
            id: 'pay-app', school_id: ESCUELA, user_id: 'x', amount: 175000, amount_paid: 175000, status: 'paid', payment_category: 'otro',
            concept: 'Clínica — X', receipt_reference_norm: 'REF300000', created_at: iso('2026-11-10T09:00:00-05:00'),
        });
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('d1', 'A', '2026-11-10T12:30:00-05:00', { media_caption: 'Pago clínica a nombre de Laura Gómez Pérez' }),
            comprobante(300000, { reference: 'REF300000' }), 'A');
        expect(crearLlamadas()).toHaveLength(0);
        expect(textosEnviados()).toEqual(['Ese comprobante ya lo teníamos ✅']);
        expect(fila('d1')).toMatchObject({ status: 'ignored', result_type: 'none', result_ref_id: 'pay-app' });
        expect(pagos()).toHaveLength(1);
    });

    it('el mismo comprobante dos veces por WhatsApp → la segunda es «ya recibido»', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        enHora('2026-11-10T12:35:00-05:00');
        const cap = { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' };
        await procesar(foto('d1', 'A', '2026-11-10T12:30:00-05:00', cap), comprobante(175000, { reference: '1869669577' }), 'A');
        expect(pago('pay-escuela')).toMatchObject({ status: 'awaiting_approval' });
        enHora('2026-11-10T12:45:00-05:00');
        await procesar(foto('d2', 'B', '2026-11-10T12:40:00-05:00', cap), comprobante(175000, { reference: '1869669577' }), 'B');
        expect(fila('d2').error_message).toMatch(/^venta_comprobante_repetido: misma referencia/);
        expect(pagos()).toHaveLength(1);
        expect(crearLlamadas()).toHaveLength(0);
    });

    it('un 23505 de la base al estampar (otra sesión ganó la carrera) se trata como «ya recibido», no como fallo', async () => {
        escuela({ contacto: WAU });
        conversacionDeVenta();
        carlos();
        h.state.errorUnico = true;
        enHora('2026-11-10T12:35:00-05:00');
        await procesar(foto('d1', 'A', '2026-11-10T12:30:00-05:00', { wa_phone_number: WAU, media_caption: 'Pago clínica a nombre de Carlos Martínez' }),
            comprobante(175000, { reference: '1869669577' }), 'A');
        expect(textosEnviados().join(' ')).toMatch(/ya lo había recibido/);
        expect(fila('d1')).toMatchObject({ status: 'ignored', result_type: 'none' });
        expect(fila('d1').error_message).toMatch(/^referencia ya usada/);
        expect(pago('pay-escuela')).toMatchObject({ status: 'pending' });
        expect(pagos()).toHaveLength(1);
    });
});
