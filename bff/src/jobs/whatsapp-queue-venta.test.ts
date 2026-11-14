/**
 * Comprobantes de la VENTA de un servicio (frente C, 2026-11-08,
 * docs/specs/whatsapp-ventas-de-servicio-blindaje.md §4.C).
 *
 * Caso que lo originó (Monster, Clínica de Armadores y Atacantes, Nicolás): la
 * escuela le pegó la ficha a mano el 04-nov; el 08-nov mandó el comprobante de
 * $300.000 y el bot le preguntó «¿De qué deportista es este pago?» → «No encontré
 * a ese deportista». Después, un cobro de clase de prueba que no quería y fotos
 * repetidas en la bandeja. Acá se reproduce paso a paso con el resultado correcto,
 * más abono/saldo, afiliado, tramo por fecha de pago, monto raro, repetidos y lo
 * que NO cambia (números sin venta, familias pagando su mensualidad).
 *
 * La base es un juego de tablas en memoria (con filtros, rutas JSON y la RPC
 * `wa_crear_cobro_desde_comprobante` simulada con las reglas de su migración
 * 20261030123549: precio de HOY por tramo, afiliado, abono ≥ mínimo, ya_tiene_cobro).
 * Datos con la forma de los reales; nombres de prueba.
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
        b.ilike = (c: string, p: string) => { filtros.push((r) => new RegExp(`^${String(p).replace(/%/g, '.*')}$`, 'i').test(String(valor(r, c) ?? ''))); return b; };
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

// ─── Datos (forma de Monster) ────────────────────────────────────────────────

const ESCUELA = 'school-monster';
const INTEGRACION = { id: 'int-1', school_id: ESCUELA, access_token: 'tok', phone_number_id: 'pn-1' };
const TEL = '573017517726';
const CONV = 'conv-nicolas';
const CLINICA_ID = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';
const CLINICA = {
    id: CLINICA_ID, school_id: ESCUELA, name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000,
    active: true, event_id: null, starts_at: '2026-11-21T00:00:00-05:00', ends_at: '2026-11-22T23:59:00-05:00',
    description: 'Clínica para armadores y atacantes, 21 y 22 de noviembre', image_url: null,
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null, capacity: null,
};
/** La ficha que la escuela pegó a mano el 04-nov 20:00 (texto real, recortado). */
const FICHA_ESCUELA = '🏐 ¡CLÍNICA DE ARMADORES Y ATACANTES MONSTER’S VOLLEY! 🔥\n\n¿Quieres llevar tu juego al siguiente nivel? '
    + 'Esta es una oportunidad para aprender de los mejores. 📅 21 y 22 de noviembre. 💰 Preventa $300.000 hasta el 10 de noviembre.';

const iso = (s: string) => new Date(s).toISOString();
const enHora = (s: string) => vi.setSystemTime(new Date(s));

function comprobante(amount: number, extra: Record<string, unknown> = {}) {
    return {
        isReceipt: true, isTransactionList: false, amount, currency: 'COP', date: '2026-11-08', time: '11:55',
        bank: 'Nequi', reference: `REF${amount}`, destination: '3194505150', destinationName: 'Iván Sossa',
        originName: 'JUAN CUBIDES', description: null, missingFields: [], provider: 'gemini', ...extra,
    };
}

/** Una foto que llega a la cola. `archivo` = contenido (la misma foto reenviada = el mismo contenido). */
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

const salientes = () => h.tabla('whatsapp_messages').filter((m) => m.direction === 'outbound' && m.ai_generated === true);
const textosEnviados = () => [
    ...sendTextMessageMock.mock.calls.map((c) => c[2] as string),
    ...sendInteractiveButtonsMock.mock.calls.map((c) => c[2] as string),
];
const crearLlamadas = () => h.rpcLlamadas.filter((l) => l.name === 'wa_crear_cobro_desde_comprobante').map((l) => l.args);
const fila = (id: string) => h.tabla('whatsapp_inbound_queue').find((f) => f.id === id);
const pagos = () => h.tabla('payments');

function escuelaMonster() {
    h.tabla('school_whatsapp_integrations').push({ ...INTEGRACION });
    h.tabla('schools').push({ id: ESCUELA, slug: 'monsters-volley-club' });
    h.tabla('school_settings').push({ school_id: ESCUELA, wa_cobro_desde_comprobante: true, allow_installments: true });
    h.tabla('school_tournament_items').push({ ...CLINICA, precios_por_fecha: [...CLINICA.precios_por_fecha] });
    h.tabla('school_trial_class_settings').push({ school_id: ESCUELA, trial_price: 15000 });
    h.tabla('whatsapp_conversations').push({ id: CONV, integration_id: 'int-1', contact_wa_id: TEL, parent_id: null, identified: false });
}

/** La conversación de Nicolás hasta el 04-nov: la escuela pegó la ficha y los datos de pago A MANO. */
function conversacionDeNicolas() {
    mensaje('inbound', 'Estoy interesado', '2026-11-04T19:45:13-05:00');
    mensaje('outbound', FICHA_ESCUELA, '2026-11-04T20:00:27-05:00');
    mensaje('inbound', 'Existe alguna problema que sea jugador de voley playa haciendo la transición a piso?', '2026-11-04T20:09:31-05:00');
    mensaje('outbound', 'No existe problema', '2026-11-04T20:16:26-05:00');
    mensaje('inbound', 'Donde podría pagar el cupo', '2026-11-04T20:17:29-05:00');
    mensaje('outbound', 'Realizar el pago al nequi o daviplata al número 3194505150 y este soporte debe ser enviado por este medio '
        + 'indicando el nombre del jugador', '2026-11-04T20:19:29-05:00');
}

/** El responder del bot para la respuesta a la pregunta (deliver): guarda texto, paso y payload. */
function responderDelBot() {
    const enviados: { texto: string; paso: string; payload?: Record<string, unknown> }[] = [];
    const fn = vi.fn(async (texto: string, paso: string, _b?: any, _l?: any, payload?: Record<string, unknown>) => {
        enviados.push({ texto, paso, payload });
        return { ok: true };
    });
    return { fn, enviados };
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
    _fijarCargadorAgenda(null);
    _olvidarModoDiscretoEfectivo();
    vi.useFakeTimers({ toFake: ['Date'] });
    escuelaMonster();
});

afterEach(() => {
    vi.useRealTimers();
});

const TEXTO_PREGUNTA = 'Recibí tu comprobante de *$300.000* 📄 ¿Cuál es el nombre completo de quien asiste a la *Clínica de armadores y atacantes*?';
const TEXTO_RECIBIDO_NICOLAS = 'Recibí tu comprobante de *$300.000* para la *Clínica de armadores y atacantes* a nombre de '
    + '*Nicolás Cubides Ávila*. La escuela lo valida y te confirma el cupo por aquí.';

// ─── (a) El caso Nicolás, paso a paso ────────────────────────────────────────

describe('(a) Nicolás, Clínica de armadores (ficha pegada por la escuela 4 días antes): 5 fotos', () => {
    it('pregunta UNA vez el nombre, crea el cobro del servicio para el lead, y lo repetido no crea nada', async () => {
        conversacionDeNicolas();
        const A = 'foto-clinica-300k';
        const B = 'foto-clase-prueba-15k';
        const OCR_A = comprobante(300000, { reference: '20261108901383474SRV001794139011125' });
        const OCR_B = comprobante(15000, { reference: '20261108901383474SRV001794140237220' });

        // 11:57 — foto del comprobante de $300.000 con «Buenas tardes mira».
        enHora('2026-11-08T11:57:30-05:00');
        mensaje('inbound', null, '2026-11-08T11:57:23-05:00');
        await procesar(foto('f1', A, '2026-11-08T11:57:24-05:00', { media_caption: 'Buenas tardes mira' }), OCR_A, A);

        expect(textosEnviados()).toEqual([TEXTO_PREGUNTA]);
        expect(textosEnviados().join(' ')).not.toMatch(/deportista|correo|sede|clase de prueba/i);
        expect(salientes()[0].payload).toMatchObject({ step: 'ask_asistente_servicio', venta_servicio_id: CLINICA_ID, queue_id: 'f1' });
        expect(fila('f1')).toMatchObject({ status: 'waiting_user', pregunta_ocr: { tipo: 'asistente_servicio', venta: { itemId: CLINICA_ID } } });
        expect(crearLlamadas()).toHaveLength(0);

        // 11:59 — «Nicolás Cubides Ávila 18 de Diciembre del 2006 Opuesto».
        enHora('2026-11-08T11:59:11-05:00');
        const bot = responderDelBot();
        const consumio = await resolverRespuestaDeCobro(INTEGRACION as any, TEL,
            'Nicolás Cubides Ávila 18 de Diciembre del 2006 Opuesto', bot.fn as any);
        expect(consumio).toBe(true);
        // El lead se crea con el nombre de quien asiste y el servicio.
        const leads = h.tabla('school_signup_leads');
        expect(leads).toHaveLength(1);
        expect(leads[0]).toMatchObject({ full_name: 'Nicolás Cubides Ávila', phone: '3017517726', school_id: ESCUELA });
        expect(leads[0].source_detail.servicio_interes).toMatchObject({ id: CLINICA_ID });
        // El cobro del servicio (precio de la base: preventa $300.000), a nombre del lead.
        expect(crearLlamadas()).toEqual([expect.objectContaining({
            p_school_id: ESCUELA, p_queue_id: 'f1', p_categoria: 'clase_extra', p_monto: 300000, p_fuente: 'tournament_item',
            p_fuente_id: CLINICA_ID, p_signup_lead_id: leads[0].id, p_child_id: null,
            p_concepto: 'Clínica de armadores y atacantes — Nicolás Cubides Ávila', p_telefono: TEL,
        })]);
        expect(pagos()).toHaveLength(1);
        expect(pagos()[0]).toMatchObject({
            amount: 300000, status: 'awaiting_approval', signup_lead_id: leads[0].id, ocr_amount: 300000,
            ocr_reference: '20261108901383474SRV001794139011125',
            receipt_image_sha256: crypto.createHash('sha256').update(Buffer.from(A)).digest('hex'),
        });
        expect(bot.enviados).toEqual([{
            texto: TEXTO_RECIBIDO_NICOLAS, paso: 'venta_comprobante_recibido', payload: { venta_servicio_id: CLINICA_ID },
        }]);
        expect(fila('f1')).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: pagos()[0].id });

        // 12:12 — la MISMA foto otra vez.
        enHora('2026-11-08T12:12:20-05:00');
        await procesar(foto('f2', A, '2026-11-08T12:12:10-05:00'), OCR_A, A);
        expect(textosEnviados().slice(1)).toEqual(['Ese comprobante ya lo teníamos ✅']);
        expect(fila('f2')).toMatchObject({ status: 'ignored', result_type: 'none', result_ref_id: pagos()[0].id });
        expect(fila('f2').error_message).toMatch(/^venta_comprobante_repetido: misma imagen/);

        // 12:17 — un comprobante de $15.000 (en el caso real, la clase de prueba que el embudo le cobró):
        // en la venta no es nada del servicio → a la escuela, y se le dice el valor que sí es.
        enHora('2026-11-08T12:17:40-05:00');
        await procesar(foto('f3', B, '2026-11-08T12:17:36-05:00'), OCR_B, B);
        expect(textosEnviados().slice(2)).toEqual([
            'Recibí tu comprobante de *$15.000* 📄 No coincide con el valor de la *Clínica de armadores y atacantes* '
            + '(*$300.000* o el abono de *$150.000*); la escuela lo revisa y te confirma por aquí.',
        ]);
        expect(fila('f3')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('f3').error_message).toMatch(/^venta_monto_no_cuadra: comprobante de \$15\.000 para Clínica de armadores y atacantes; el valor de hoy es \$300\.000 \(abono mínimo \$150\.000\)/);
        expect(fila('f3').error_message).toContain('asiste: Nicolás Cubides Ávila');

        // 12:19 — la foto de $15.000 otra vez (sigue en la bandeja) → repetida, sin mensaje nuevo
        // (el mismo «ya lo teníamos» salió hace menos de 10 min: no se repite).
        enHora('2026-11-08T12:20:00-05:00');
        await procesar(foto('f4', B, '2026-11-08T12:19:56-05:00'), OCR_B, B);
        expect(fila('f4').error_message).toMatch(/^venta_comprobante_repetido: misma imagen que la fila f3/);

        // 12:26 — la de $300.000 por tercera vez.
        enHora('2026-11-08T12:26:10-05:00');
        await procesar(foto('f5', A, '2026-11-08T12:26:01-05:00'), OCR_A, A);
        expect(fila('f5').error_message).toMatch(/^venta_comprobante_repetido: misma imagen que el cobro/);

        // Total: UN cobro (el de la clínica), ninguno de clase de prueba, nunca «¿de qué deportista?».
        expect(crearLlamadas()).toHaveLength(1);
        expect(pagos().map((p) => p.payment_category)).toEqual(['clase_extra']);
        expect(textosEnviados().every((t) => !/deportista|correo|Elige la sede/i.test(t))).toBe(true);
        expect(textosEnviados().filter((t) => t === 'Ese comprobante ya lo teníamos ✅')).toHaveLength(2);
        // Todo lo que salió de la cola en la venta lleva la marca del servicio.
        expect(salientes().every((m) => m.payload?.venta_servicio_id === CLINICA_ID)).toBe(true);
    });

    it('si el pie ya trae el nombre de quien asiste, no se pregunta: el cobro sale directo', async () => {
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00', { media_caption: 'Pago clínica a nombre de Nicolás Cubides Ávila' }),
            comprobante(300000), 'A');
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_concepto: 'Clínica de armadores y atacantes — Nicolás Cubides Ávila' })]);
        expect(textosEnviados()).toEqual([TEXTO_RECIBIDO_NICOLAS]);
    });

    it('lo que no es un nombre («¿a qué hora es?») no consume la respuesta: la pregunta sigue abierta', async () => {
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00'), comprobante(300000), 'A');
        enHora('2026-11-08T12:10:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, '¿A qué hora es la clínica el sábado?', bot.fn as any)).toBe(false);
        expect(fila('f1').status).toBe('waiting_user');
        expect(crearLlamadas()).toHaveLength(0);
    });

    it('con la conversación tomada por la escuela: no se le escribe; sin nombre, a la bandeja con lo que falta', async () => {
        conversacionDeNicolas();
        h.state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true, tomada: true };
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00'), comprobante(300000), 'A');
        expect(textosEnviados()).toEqual([]);
        expect(fila('f1')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('f1').error_message).toMatch(/^venta_falta_nombre: comprobante de \$300\.000 para Clínica de armadores y atacantes/);
    });

    it('con la conversación tomada y el nombre conocido: el cobro del servicio se crea igual, sin escribirle', async () => {
        conversacionDeNicolas();
        h.tabla('school_signup_leads').push({
            id: 'lead-n', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Nicolás Cubides',
            source_detail: { registro_completo_at: '2026-11-08T12:05:00-05:00' },
        });
        h.state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true, tomada: true };
        enHora('2026-11-08T12:12:20-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T12:12:10-05:00'), comprobante(300000), 'A');
        expect(textosEnviados()).toEqual([]);
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_signup_lead_id: 'lead-n', p_concepto: 'Clínica de armadores y atacantes — Nicolás Cubides' })]);
        expect(fila('f1')).toMatchObject({ status: 'done', result_type: 'payment_receipt' });
    });

    it('con la conversación tomada y SIN venta: como siempre (a la bandeja como contacto no atendido, sin escribirle)', async () => {
        h.state.atencion = { atender: false, tipo: 'desconocido', botEncendido: true, tomada: true };
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T08:59:00-05:00'), comprobante(180000), 'A');
        expect(textosEnviados()).toEqual([]);
        expect(crearLlamadas()).toHaveLength(0);
        expect(fila('f1').error_message).toMatch(/^sin_familia: contacto_no_atendido \(desconocido\)/);
    });
});

// ─── (b) Abono y saldo ───────────────────────────────────────────────────────

describe('(b) abono de $150.000 → cobro parcial; el saldo de $150.000 va al MISMO cobro', () => {
    beforeEach(() => {
        conversacionDeNicolas();
        h.tabla('school_signup_leads').push({
            id: 'lead-sara', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Sara Gómez',
            source_detail: { registro_completo_at: '2026-11-05T10:00:00Z' }, created_at: iso('2026-11-05T10:00:00Z'),
        });
    });

    it('abono → cobro de $300.000 en revisión como abono; aprobado (partial) → el saldo se estampa en ese cobro', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'abono', '2026-11-08T08:59:00-05:00'), comprobante(150000, { reference: 'AB1' }), 'abono');
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_monto: 150000, p_signup_lead_id: 'lead-sara' })]);
        const pago = pagos()[0];
        expect(pago).toMatchObject({ amount: 300000, status: 'awaiting_approval', ocr_amount: 150000 });
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled(); // un abono lo aprueba una persona
        expect(textosEnviados()).toEqual(['Recibí tu abono de *$150.000* para la *Clínica de armadores y atacantes* a nombre de '
            + '*Sara Gómez*. Quedan *$150.000* para completar *$300.000*. La escuela lo valida y te confirma el cupo por aquí.']);
        expect(fila('f1').error_message).toMatch(/^abono_en_revision: Clínica de armadores y atacantes — abono de \$150\.000 de \$300\.000/);

        // La escuela aprueba el abono.
        Object.assign(pago, { status: 'partial', amount_paid: 150000 });

        enHora('2026-11-09T09:00:00-05:00');
        await procesar(foto('f2', 'saldo', '2026-11-09T08:59:00-05:00'), comprobante(150000, { reference: 'SA2', date: '2026-11-09' }), 'saldo');
        expect(crearLlamadas()).toHaveLength(1); // no se crea otro cobro
        expect(pagos()).toHaveLength(1);
        expect(pago).toMatchObject({ status: 'awaiting_approval', ocr_amount: 150000, ocr_reference: 'SA2' });
        expect(fila('f2')).toMatchObject({ status: 'done', result_type: 'payment_receipt', result_ref_id: pago.id });
        expect(fila('f2').error_message).toMatch(/^saldo_de_abono: Clínica de armadores y atacantes — saldo de \$150\.000/);
        // El saldo pasa por la evaluación de siempre (como el saldo por el enlace /p/:token).
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith(pago.id, undefined);
        expect(textosEnviados()[1]).toBe('Recibí el saldo de *$150.000* para la *Clínica de armadores y atacantes* a nombre de '
            + '*Sara Gómez*: con esto completas *$300.000*. La escuela lo valida y te confirma el cupo por aquí.');
    });

    it('el saldo llega con el abono todavía en revisión: no se estampa encima; a la escuela con la propuesta', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'abono', '2026-11-08T08:59:00-05:00'), comprobante(150000, { reference: 'AB1' }), 'abono');
        enHora('2026-11-08T10:00:00-05:00');
        await procesar(foto('f2', 'saldo', '2026-11-08T09:59:00-05:00'), comprobante(150000, { reference: 'SA2' }), 'saldo');
        expect(pagos()[0]).toMatchObject({ ocr_reference: 'AB1', ocr_amount: 150000 }); // el primer comprobante intacto
        expect(fila('f2')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('f2').error_message).toMatch(/^venta_saldo_con_abono_en_revision: saldo de \$150\.000 de Clínica de armadores y atacantes \(Sara Gómez\)/);
        expect(crearLlamadas()).toHaveLength(1);
    });
});

// ─── (c) Afiliado ────────────────────────────────────────────────────────────

describe('(c) familia del club compra la clínica: precio de afiliado $250.000 para su deportista', () => {
    beforeEach(() => {
        h.state.atencion = { atender: true, tipo: 'familia', botEncendido: true, tomada: false };
        h.state.identify = { data: { estado: 'identificado', parent_id: 'parent-1' } };
        h.tabla('whatsapp_conversations')[0].parent_id = 'parent-1';
        h.tabla('children').push({ id: 'c1', parent_id: 'parent-1', school_id: ESCUELA, is_active: true, full_name: 'Laura Peña' });
        h.tabla('enrollments').push({ id: 'e1', child_id: 'c1', school_id: ESCUELA, status: 'active', monthly_fee: 180000, fee_is_manual: true });
        // El bot le mandó la ficha de la clínica (saliente marcado con el servicio).
        mensaje('outbound', 'Te cuento de la Clínica de armadores y atacantes…', '2026-11-08T08:00:00-05:00',
            { ai_generated: true, payload: { step: 'venta_servicio_ficha', venta_servicio_id: CLINICA_ID } });
    });

    it('$250.000 → cobro de la clínica para Laura con el precio de afiliado (lo pone la base)', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'af', '2026-11-08T08:59:00-05:00'), comprobante(250000, { reference: 'AF1' }), 'af');
        expect(crearLlamadas()).toEqual([expect.objectContaining({
            p_child_id: 'c1', p_signup_lead_id: null, p_monto: 250000, p_fuente_id: CLINICA_ID,
            p_concepto: 'Clínica de armadores y atacantes — Laura Peña',
        })]);
        expect(pagos()[0]).toMatchObject({ amount: 250000, child_id: 'c1', status: 'awaiting_approval' });
        expect(textosEnviados()).toEqual(['Recibí tu comprobante de *$250.000* para la *Clínica de armadores y atacantes* a nombre de '
            + '*Laura Peña*. La escuela lo valida y te confirma el cupo por aquí.']);
        expect(salientes().at(-1)?.payload).toMatchObject({ venta_servicio_id: CLINICA_ID });
    });

    it('(g) la misma familia paga su cuota de $180.000 en plena venta → el camino de siempre (¿de qué mes?), sin tocar la clínica', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'cuota', '2026-11-08T08:59:00-05:00'), comprobante(180000, { reference: 'CU1' }), 'cuota');
        expect(crearLlamadas()).toHaveLength(0);
        expect(textosEnviados()[0]).toContain('¿De qué mes es?');
        expect(salientes().at(-1)?.payload?.venta_servicio_id).toBeUndefined();
    });
});

// ─── (d) Tramo por fecha de pago ─────────────────────────────────────────────

describe('(d) pagó $300.000 el 10-nov (preventa) y se procesa el 11-nov (ya rige $350.000)', () => {
    beforeEach(() => {
        conversacionDeNicolas();
        h.tabla('school_signup_leads').push({
            id: 'lead-ana', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Ana Torres',
            source_detail: { registro_completo_at: '2026-11-05T10:00:00Z' }, created_at: iso('2026-11-05T10:00:00Z'),
        });
    });

    it('aceptado: se le confirma el recibido a nombre de quien asiste y NO se crea un cobro de $350.000 que la deje debiendo', async () => {
        enHora('2026-11-11T10:00:00-05:00');
        await procesar(foto('f1', 'pre', '2026-11-11T09:59:00-05:00'), comprobante(300000, { reference: 'PV1', date: '2026-11-10' }), 'pre');
        expect(crearLlamadas()).toHaveLength(0); // la RPC cobraría el precio de HOY (y lo dejaría como abono)
        expect(textosEnviados()).toEqual(['Recibí tu comprobante de *$300.000* para la *Clínica de armadores y atacantes* a nombre de '
            + '*Ana Torres*. La escuela lo valida y te confirma el cupo por aquí.']);
        expect(fila('f1')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila('f1').error_message).toMatch(/^venta_tramo_por_fecha_de_pago: \$300\.000 pagados el 2026-11-10 para Clínica de armadores y atacantes: era el valor de ese día \(\$300\.000\); hoy es \$350\.000/);
        expect(fila('f1').error_message).toContain('crear el cobro por $300.000 y aplicar este comprobante');
    });

    it('el mismo $300.000 pagado HOY (11-nov) es un abono del precio nuevo: cobro de $350.000, quedan $50.000', async () => {
        enHora('2026-11-11T10:00:00-05:00');
        await procesar(foto('f1', 'hoy', '2026-11-11T09:59:00-05:00'), comprobante(300000, { reference: 'HY1', date: '2026-11-11' }), 'hoy');
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_monto: 300000 })]);
        expect(pagos()[0]).toMatchObject({ amount: 350000 });
        expect(textosEnviados()[0]).toContain('Quedan *$50.000* para completar *$350.000*');
    });

    it('$350.000 el 11-nov = el precio de hoy → cobro completo', async () => {
        enHora('2026-11-11T10:00:00-05:00');
        await procesar(foto('f1', 'full', '2026-11-11T09:59:00-05:00'), comprobante(350000, { reference: 'FU1', date: '2026-11-11' }), 'full');
        expect(pagos()[0]).toMatchObject({ amount: 350000, status: 'awaiting_approval' });
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledTimes(1);
    });
});

// ─── (e) Monto raro y (f) duplicados ─────────────────────────────────────────

describe('(e) monto que no es del servicio y (f) comprobante repetido', () => {
    beforeEach(() => conversacionDeNicolas());

    it('(e) $42.000 → a la escuela con el motivo y a la persona el valor del servicio; nada se crea', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'raro', '2026-11-08T08:59:00-05:00'), comprobante(42000), 'raro');
        expect(crearLlamadas()).toHaveLength(0);
        expect(textosEnviados()).toEqual(['Recibí tu comprobante de *$42.000* 📄 No coincide con el valor de la *Clínica de armadores y atacantes* '
            + '(*$300.000* o el abono de *$150.000*); la escuela lo revisa y te confirma por aquí.']);
        expect(fila('f1').error_message).toMatch(/^venta_monto_no_cuadra: /);
        expect(salientes()[0].payload).toMatchObject({ venta_servicio_id: CLINICA_ID, step: 'venta_comprobante_a_la_escuela' });
    });

    it('destino sin leer (o que no coincide exacto): como en B4, a un prospecto no se le crea el cobro; a la escuela', async () => {
        h.tabla('school_signup_leads').push({
            id: 'lead-x', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Sara Gómez',
            source_detail: { registro_completo_at: '2026-11-05T10:00:00Z' },
        });
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'sindestino', '2026-11-08T08:59:00-05:00'), comprobante(300000, { destination: null }), 'sindestino');
        expect(crearLlamadas()).toHaveLength(0);
        expect(textosEnviados()).toEqual(['Recibí tu comprobante de *$300.000* para la *Clínica de armadores y atacantes* a nombre de '
            + '*Sara Gómez*. La escuela lo valida y te confirma el cupo por aquí.']);
        expect(fila('f1').error_message).toMatch(/^venta_destino_no_confirmado: comprobante de \$300\.000 para Clínica de armadores y atacantes a un destino sin leer/);
    });

    it('(f) misma referencia del banco que un cobro ya pagado (otra captura del mismo pago) → «ya lo teníamos», sin cobro', async () => {
        h.tabla('payments').push({ id: 'pay-viejo', school_id: ESCUELA, ocr_reference: 'REF-UNICA', receipt_image_sha256: 'otro', status: 'paid', amount: 300000 });
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'captura2', '2026-11-08T08:59:00-05:00'), comprobante(300000, { reference: 'REF-UNICA' }), 'captura2');
        expect(textosEnviados()).toEqual(['Ese comprobante ya lo teníamos ✅']);
        expect(fila('f1')).toMatchObject({ status: 'ignored', result_type: 'none', result_ref_id: 'pay-viejo' });
        expect(fila('f1').error_message).toMatch(/^venta_comprobante_repetido: misma referencia/);
        expect(crearLlamadas()).toHaveLength(0);
    });

    it('(f) la misma imagen de un cobro RECHAZADO no cuenta como repetida (el rechazo la libera, como el índice parcial)', async () => {
        const sha = crypto.createHash('sha256').update(Buffer.from('rechazada')).digest('hex');
        h.tabla('payments').push({ id: 'pay-rech', school_id: ESCUELA, receipt_image_sha256: sha, ocr_reference: 'OTRA', status: 'rejected', amount: 300000 });
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'rechazada', '2026-11-08T08:59:00-05:00'), comprobante(300000, { reference: 'NUEVA' }), 'rechazada');
        expect(textosEnviados()).toEqual([TEXTO_PREGUNTA]);
    });

    it('(f) la misma foto mientras la primera espera el nombre → «ya lo teníamos», y la respuesta crea UN cobro', async () => {
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'X', '2026-11-08T08:59:00-05:00'), comprobante(300000, { reference: 'X1' }), 'X');
        enHora('2026-11-08T09:01:00-05:00');
        await procesar(foto('f2', 'X', '2026-11-08T09:00:30-05:00'), comprobante(300000, { reference: 'X1' }), 'X');
        expect(textosEnviados()).toEqual([TEXTO_PREGUNTA, 'Ese comprobante ya lo teníamos ✅']);
        expect(fila('f2').error_message).toMatch(/^venta_comprobante_repetido: misma imagen que la fila f1/);
        enHora('2026-11-08T09:02:00-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'Se llama Mateo Rincón', bot.fn as any)).toBe(true);
        expect(crearLlamadas()).toHaveLength(1);
        expect(crearLlamadas()[0]).toMatchObject({ p_concepto: 'Clínica de armadores y atacantes — Mateo Rincón' });
    });
});

// ─── (g) Sin venta activa: lo de siempre ─────────────────────────────────────

describe('(g) número SIN venta activa → el comportamiento de hoy, intacto', () => {
    it('número sin ficha, conversación sin servicio → «¿De qué deportista es este pago?» como siempre', async () => {
        mensaje('inbound', 'Hola, buenas', '2026-11-08T08:50:00-05:00');
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'pago', '2026-11-08T08:59:00-05:00', { media_caption: 'pago' }), comprobante(180000), 'pago');
        expect(textosEnviados()[0]).toContain('¿De qué deportista es este pago?');
        expect(fila('f1').pregunta_ocr).toMatchObject({ tipo: 'deportista' });
        expect(salientes()[0].payload?.venta_servicio_id).toBeUndefined();
        expect(crearLlamadas()).toHaveLength(0);
    });

    it('escuela sin servicios vigentes: ni siquiera se leen los mensajes para la venta', async () => {
        h.db.school_tournament_items = [];
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'pago', '2026-11-08T08:59:00-05:00', { media_caption: 'pago' }), comprobante(300000), 'pago');
        expect(textosEnviados()[0]).toContain('¿De qué deportista es este pago?');
    });

    it('prospecto de la clase de prueba (el bot pidió $15.000, sin venta): se crea la clase de prueba y pasa a una persona, como hoy', async () => {
        const lead = { id: 'lead-cp', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Juan Pérez', source_detail: {} };
        h.tabla('school_signup_leads').push(lead);
        h.tabla('whatsapp_conceptos_esperados').push({
            id: 'e-cp', school_id: ESCUELA, telefono: TEL, motivo: 'clase_prueba', monto: 15000, signup_lead_id: 'lead-cp', child_id: null,
            origen: 'clase_prueba', vence_en: iso('2026-11-09T09:00:00-05:00'), consumido_at: null, created_at: iso('2026-11-08T08:00:00-05:00'),
        });
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'cp', '2026-11-08T08:59:00-05:00'), comprobante(15000, { reference: 'CP1' }), 'cp');
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_fuente: 'trial_price', p_signup_lead_id: 'lead-cp', p_concepto_esperado_id: 'e-cp' })]);
        expect(textosEnviados()[0]).toContain('para la clase de prueba');
        expect(salientes()[0].payload?.venta_servicio_id).toBeUndefined();
    });
});

// ─── PRIVACIDAD: el comprobante de Ethann (Monster 2026-11-05, conversación bd8a1532, •••1992) ───
//
// Un papá cuyo número NO es de ninguna familia escribió «Envío el comprobante de pago de
// Ethann Pedraza» y mandó la foto. El bot le ofreció el botón «1. Laura Sofía» —una menor
// de OTRA familia que solo compartía el apellido—, él lo tocó y el pago de $117.750 se
// aplicó a esa niña (la escuela lo rechazó después). Luego escribió «DEPORTISTA :
// ETHANN MATIAS PEDRAZA PINTO» y recibió «No encontré a ese deportista».

describe('PRIVACIDAD — número sin verificar (Ethann, bd8a1532): nunca nombres de otros deportistas', () => {
    const LAURA = {
        id: 'u-laura', school_id: ESCUELA, full_name: 'Laura Sofía Pedraza Sanchez', is_active: true, linked_profile_id: null,
        guardian_phone: '3143378717', phone: '3188844466',
    };
    const ETHANN = {
        id: 'a6cfc80d-9c81-4f65-b9bb-138a1c9d6cd1', school_id: ESCUELA, full_name: 'Ethann Matías Pedraza Pinto', is_active: true,
        parent_id: 'parent-ethann', parent_phone_temp: null,
    };
    const COBRO_ETHANN = {
        id: 'pay-ethann-nov', school_id: ESCUELA, child_id: ETHANN.id, unregistered_athlete_id: null, parent_id: 'parent-ethann',
        amount: 117750, status: 'pending', concept: 'Mensualidad 11/2026 - Ethann Matías Pedraza Pinto', due_date: '2026-11-10',
        payment_category: 'mensualidad',
    };
    const COBRO_LAURA = {
        id: 'pay-laura-nov', school_id: ESCUELA, child_id: null, unregistered_athlete_id: LAURA.id, parent_id: null,
        amount: 155000, status: 'pending', concept: 'Mensualidad 11/2026 - Laura Sofía Pedraza Sanchez', due_date: '2026-11-10',
        payment_category: 'mensualidad',
    };
    const OCR_ETHANN = (extra: Record<string, unknown> = {}) => comprobante(117750, {
        date: '2026-11-05', originName: 'JOHN PEDRAZA', reference: 'M3456789', ...extra,
    });
    const PROHIBIDO_DE_OTRA_FAMILIA = /laura|sof[ií]a|sanchez|155\.000/i;

    /** Las fotos y el texto del 05-nov 18:33. */
    async function comprobanteDeEthann() {
        enHora('2026-11-05T18:34:00-05:00');
        mensaje('inbound', 'Envío el comprobante de pago de Ethann Pedraza.', '2026-11-05T18:33:45-05:00');
        mensaje('inbound', null, '2026-11-05T18:33:49-05:00');
        await procesar(foto('e1', 'ethann-117750', '2026-11-05T18:33:49-05:00'), OCR_ETHANN(), 'ethann-117750');
    }

    it('18:33 (Ethann todavía sin ficha): la pregunta ESCRITA, sin botones ni el nombre de nadie (antes: «1. Laura Sofía»)', async () => {
        h.tabla('unregistered_athletes').push({ ...LAURA });
        h.tabla('payments').push({ ...COBRO_LAURA });
        await comprobanteDeEthann();
        expect(textosEnviados()).toEqual(['Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.']);
        expect(sendInteractiveButtonsMock).not.toHaveBeenCalled();
        for (const t of textosEnviados()) expect(t).not.toMatch(PROHIBIDO_DE_OTRA_FAMILIA);
        expect(salientes()[0].payload?.step).toBe('ask_deportista');
        expect(fila('e1')).toMatchObject({ status: 'waiting_user' });
        expect(fila('e1').pregunta_ocr.guia).toBeUndefined();
        // Y el cobro de Laura sigue intacto.
        expect(pagos().find((p) => p.id === COBRO_LAURA.id)).toMatchObject({ status: 'pending' });
    });

    it('18:55 «DEPORTISTA :\\nETHANN MATIAS PEDRAZA PINTO» (con su ficha y un cobro de $117.750): se liga a ESE cobro y pasa por la evaluación; sin decirle datos del menor', async () => {
        h.tabla('unregistered_athletes').push({ ...LAURA });
        h.tabla('children').push({ ...ETHANN });
        h.tabla('payments').push({ ...COBRO_LAURA }, { ...COBRO_ETHANN });
        await comprobanteDeEthann();
        // «Ethann Pedraza» es parcial (2 de 4 palabras): no liga nada, pregunta escrita.
        expect(textosEnviados()).toEqual(['Recibí tu comprobante 📄 ¿De qué deportista es este pago? Escríbeme su nombre completo.']);
        sendTextMessageMock.mockClear();
        enHora('2026-11-05T18:55:10-05:00');
        const bot = responderDelBot();
        expect(await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'DEPORTISTA :\nETHANN MATIAS PEDRAZA PINTO', bot.fn as any)).toBe(true);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith(COBRO_ETHANN.id, undefined);
        expect(pagos().find((p) => p.id === COBRO_ETHANN.id)).toMatchObject({ status: 'awaiting_approval', receipt_url: expect.any(String) });
        expect(pagos().find((p) => p.id === COBRO_LAURA.id)).toMatchObject({ status: 'pending' });
        expect(fila('e1')).toMatchObject({ status: 'done', result_ref_id: COBRO_ETHANN.id });
        expect(bot.enviados.map((e) => e.texto)).toEqual(['Recibí tu comprobante de *$117.750* 📄 La escuela lo valida y te confirma por aquí.']);
        for (const e of bot.enviados) expect(e.texto).not.toMatch(/ethann|pedraza|noviembre|mensualidad|laura/i);
    });

    it('con la auto-aprobación de la escuela: el mismo camino lo aprueba (evaluatePaymentReceipt → approved) y se le confirma sin datos del menor', async () => {
        h.state.accion = 'approved';
        h.tabla('children').push({ ...ETHANN });
        h.tabla('payments').push({ ...COBRO_ETHANN });
        await comprobanteDeEthann();
        enHora('2026-11-05T18:55:10-05:00');
        const bot = responderDelBot();
        await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'ETHANN MATÍAS PEDRAZA PINTO', bot.fn as any);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledTimes(1);
        expect(bot.enviados.map((e) => e.texto)).toEqual(['¡Listo! ✅ Quedó registrado tu pago de *$117.750*. Gracias.']);
    });

    it('nombre completo pero el monto no es el de UN cobro abierto suyo → a la bandeja LIGADA al deportista y con la propuesta (nunca huérfana); a él, nada del menor', async () => {
        h.tabla('children').push({ ...ETHANN });
        h.tabla('payments').push({ ...COBRO_ETHANN, amount: 145000 });
        await comprobanteDeEthann();
        enHora('2026-11-05T18:55:10-05:00');
        const bot = responderDelBot();
        await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'DEPORTISTA :\nETHANN MATIAS PEDRAZA PINTO', bot.fn as any);
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        const f = fila('e1');
        expect(f).toMatchObject({ status: 'ignored', result_type: 'escalated', matched_child_id: ETHANN.id });
        expect(f.error_message).toMatch(/^sin_familia: numero_sin_verificar — Ethann Matías Pedraza Pinto/);
        expect(f.error_message).toContain('Propuesta → pagó: JOHN PEDRAZA · $117.750');
        expect(f.pregunta_ocr).toMatchObject({ sha: expect.any(String) });
        expect(bot.enviados.map((e) => e.texto)).toEqual(['Gracias 🙏 Le paso tu comprobante a la escuela para que lo revise y te confirme por aquí.']);
    });

    it('fila vieja (antes del arreglo) con el botón «1. Laura Sofía»: tocarlo NO aplica el pago a otra familia', async () => {
        h.tabla('unregistered_athletes').push({ ...LAURA });
        h.tabla('payments').push({ ...COBRO_LAURA });
        await comprobanteDeEthann();
        // Así quedaba la fila con el código de antes: la guía con la ficha de Laura.
        Object.assign(fila('e1').pregunta_ocr, {
            guia: { opciones: [{ n: 1, etiqueta: LAURA.full_name, valor: { id: LAURA.id, nombre: LAURA.full_name, tipo: 'unregistered' } }], monto: 117750, quienPago: 'JOHN PEDRAZA', parentId: null },
        });
        enHora('2026-11-05T18:35:53-05:00');
        const bot = responderDelBot();
        await resolverRespuestaDeCobro(INTEGRACION as any, TEL, '1', bot.fn as any);
        expect(pagos().find((p) => p.id === COBRO_LAURA.id)).toMatchObject({ status: 'pending' });
        expect(pagos().find((p) => p.id === COBRO_LAURA.id).receipt_url).toBeUndefined();
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(fila('e1')).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        for (const e of bot.enviados) expect(e.texto).not.toMatch(PROHIBIDO_DE_OTRA_FAMILIA);
    });
});

// ─── Aprobación automática en TODOS los caminos del bot (Monster la prendió el 08-nov, tope $400.000) ───

describe('aprobación automática: cada camino de comprobante del bot pasa por evaluatePaymentReceipt (abonos, no)', () => {
    it('venta de un servicio, valor completo: se evalúa y, si la escuela lo aprueba solo, se le confirma el cupo', async () => {
        h.state.accion = 'approved';
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00', { media_caption: 'Pago clínica a nombre de Nicolás Cubides Ávila' }),
            comprobante(300000), 'A');
        const pago = pagos()[0];
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith(pago.id, undefined);
        expect(textosEnviados()).toEqual(['¡Listo! ✅ Quedó registrado tu pago de *$300.000* para la *Clínica de armadores y atacantes* '
            + 'a nombre de *Nicolás Cubides Ávila*. Tu cupo está confirmado.']);
    });

    it('venta de un servicio, la respuesta al nombre de quien asiste: también se evalúa', async () => {
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00'), comprobante(300000), 'A');
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled(); // todavía sin nombre: no hay cobro
        const bot = responderDelBot();
        enHora('2026-11-08T11:59:11-05:00');
        await resolverRespuestaDeCobro(INTEGRACION as any, TEL, 'Nicolás Cubides Ávila\n18 de Diciembre del 2006\nOpuesto', bot.fn as any);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledTimes(1);
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith(pagos()[0].id, undefined);
    });

    it('clase de prueba de un prospecto (el bot pidió los $15.000): se evalúa como el camino normal', async () => {
        const lead = { id: 'lead-cp', school_id: ESCUELA, phone: '3017517726', status: 'contacted', full_name: 'Juan Pérez', source_detail: {} };
        h.tabla('school_signup_leads').push(lead);
        h.tabla('whatsapp_conceptos_esperados').push({
            id: 'e-cp', school_id: ESCUELA, telefono: TEL, motivo: 'clase_prueba', monto: 15000, signup_lead_id: 'lead-cp', child_id: null,
            origen: 'clase_prueba', vence_en: iso('2026-11-09T09:00:00-05:00'), consumido_at: null, created_at: iso('2026-11-08T08:00:00-05:00'),
        });
        enHora('2026-11-08T09:00:00-05:00');
        await procesar(foto('f1', 'cp', '2026-11-08T08:59:00-05:00'), comprobante(15000, { reference: 'CP1' }), 'cp');
        expect(evaluatePaymentReceiptMock).toHaveBeenCalledWith(pagos()[0].id, undefined);
    });

    it('los datos de quien asiste que el bot anotó ANTES del comprobante (prospecto con asistente_servicio): no se vuelve a preguntar el nombre', async () => {
        h.tabla('school_signup_leads').push({
            id: 'lead-nico', school_id: ESCUELA, phone: '3017517726', status: 'respondido', full_name: 'Nicolás Cubides Ávila',
            source_detail: { asistente_servicio: { nombre: 'Nicolás Cubides Ávila', servicio_id: CLINICA_ID } }, created_at: iso('2026-11-08T11:00:00-05:00'),
        });
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'A', '2026-11-08T11:57:24-05:00'), comprobante(300000), 'A');
        expect(textosEnviados()).toEqual([TEXTO_RECIBIDO_NICOLAS]);
        expect(crearLlamadas()).toEqual([expect.objectContaining({ p_signup_lead_id: 'lead-nico', p_concepto: 'Clínica de armadores y atacantes — Nicolás Cubides Ávila' })]);
    });

    it('un abono del servicio se queda «Por validar»: NO pasa por la aprobación automática (como hoy)', async () => {
        h.state.accion = 'approved';
        conversacionDeNicolas();
        enHora('2026-11-08T11:57:30-05:00');
        await procesar(foto('f1', 'AB', '2026-11-08T11:57:24-05:00', { media_caption: 'Abono clínica a nombre de Nicolás Cubides Ávila' }),
            comprobante(150000), 'AB');
        expect(evaluatePaymentReceiptMock).not.toHaveBeenCalled();
        expect(pagos()[0]).toMatchObject({ status: 'awaiting_approval' });
    });
});

// ─── Piezas puras ────────────────────────────────────────────────────────────

describe('decidirMontoDeVenta (puro)', () => {
    const item = { ...CLINICA };
    const el = (fecha: string) => Date.parse(`${fecha}T10:00:00-05:00`);

    it('precio de hoy, afiliado, abono, tramo por fecha de pago y no cuadra', () => {
        expect(cobro.decidirMontoDeVenta(300000, item, { ahora: el('2026-11-08') })).toMatchObject({ tipo: 'completo', precio: { monto: 300000 } });
        expect(cobro.decidirMontoDeVenta(250000, item, { ahora: el('2026-11-08'), afiliado: true })).toMatchObject({ tipo: 'completo', precio: { monto: 250000 } });
        expect(cobro.decidirMontoDeVenta(150000, item, { ahora: el('2026-11-08') })).toMatchObject({ tipo: 'abono', total: 300000, minimo: 150000, precio: { monto: 150000, esAbono: true } });
        expect(cobro.decidirMontoDeVenta(200000, item, { ahora: el('2026-11-08') })).toMatchObject({ tipo: 'abono', total: 300000 });
        expect(cobro.decidirMontoDeVenta(149000, item, { ahora: el('2026-11-08') })).toEqual({ tipo: 'no_cuadra', precios: [300000], minimo: 150000 });
        expect(cobro.decidirMontoDeVenta(350000, item, { ahora: el('2026-11-11') })).toMatchObject({ tipo: 'completo' });
        expect(cobro.decidirMontoDeVenta(300000, item, { ahora: el('2026-11-11'), fechaPago: '2026-11-10' }))
            .toEqual({ tipo: 'tramo_anterior', fecha: '2026-11-10', precioDeEseDia: 300000, precioHoy: 350000, esAbono: false });
        // abono del día del pago que hoy ya no alcanza (mínimo de hoy $175.000)
        expect(cobro.decidirMontoDeVenta(150000, item, { ahora: el('2026-11-11'), fechaPago: '2026-11-10' }))
            .toMatchObject({ tipo: 'tramo_anterior', esAbono: true, precioDeEseDia: 300000 });
        // fecha del pago vieja o futura: manda el precio de hoy
        expect(cobro.fechaDePagoParaPrecio('2026-09-01', '2026-11-11')).toBeNull();
        expect(cobro.fechaDePagoParaPrecio('2026-11-12', '2026-11-11')).toBeNull();
        expect(cobro.fechaDePagoParaPrecio('2026-11-10', '2026-11-11')).toBe('2026-11-10');
    });

    it('con un cobro previo: saldo (partial), saldo con el abono en revisión, pendiente, ya tiene el cobro', () => {
        const base = { id: 'p1', amount: 300000, amountPaid: 0, ocrAmount: null, concept: 'Clínica — X', childId: null };
        const hoy = el('2026-11-08');
        expect(cobro.decidirMontoDeVenta(150000, item, { ahora: hoy, previo: { ...base, status: 'partial', amountPaid: 150000 } }))
            .toMatchObject({ tipo: 'saldo', saldo: 150000 });
        expect(cobro.decidirMontoDeVenta(100000, item, { ahora: hoy, previo: { ...base, status: 'partial', amountPaid: 200000 } }))
            .toMatchObject({ tipo: 'saldo', saldo: 100000 }); // un saldo menor que el abono mínimo también vale
        expect(cobro.decidirMontoDeVenta(150000, item, { ahora: hoy, previo: { ...base, status: 'awaiting_approval', ocrAmount: 150000 } }))
            .toMatchObject({ tipo: 'saldo_en_revision', saldo: 150000 });
        expect(cobro.decidirMontoDeVenta(300000, item, { ahora: hoy, previo: { ...base, status: 'pending' } }))
            .toMatchObject({ tipo: 'aplicar_previo', esAbono: false });
        expect(cobro.decidirMontoDeVenta(300000, item, { ahora: hoy, previo: { ...base, status: 'paid', amountPaid: 300000 } }))
            .toMatchObject({ tipo: 'ya_tiene_cobro' });
    });

    it('opciones con el mismo precio → ambiguo; sin abono si el ítem no admite cuotas', () => {
        const vacacional = {
            ...item, name: 'Vacacional', kind: 'vacacional', precio_afiliado: null, precios_por_fecha: null,
            opciones: [{ clave: 's1', etiqueta: '1 semana', precio: 200000 }, { clave: 's1b', etiqueta: '1 semana (tarde)', precio: 200000 }],
        };
        expect(cobro.decidirMontoDeVenta(200000, vacacional, { ahora: el('2026-11-08') })).toMatchObject({ tipo: 'ambiguo' });
        expect(cobro.decidirMontoDeVenta(150000, { ...item, allow_installments: false }, { ahora: el('2026-11-08') })).toMatchObject({ tipo: 'no_cuadra', minimo: null });
    });
});

describe('el nombre de quien asiste (puro)', () => {
    it('toma el nombre del comienzo de la respuesta y corta en la fecha, la posición o la pregunta', () => {
        expect(ficha.nombreDeAsistente('Nicolás Cubides Ávila 18 de Diciembre del 2006 Opuesto')).toBe('Nicolás Cubides Ávila');
        expect(ficha.nombreDeAsistente('Se llama Sofía Pérez, tiene 12 años')).toBe('Sofía Pérez');
        expect(ficha.nombreDeAsistente('Es para mi hijo Juan David Gómez')).toBe('Juan David Gómez');
        expect(ficha.nombreDeAsistente('MARÍA DE LOS ÁNGELES TORRES')).toBe('María de los Ángeles Torres');
        expect(ficha.nombreDeAsistente('Bueno, Juan Bueno')).toBe('Juan Bueno');
        expect(ficha.nombreDeAsistente('Nicolás')).toBeNull(); // se pidió el nombre completo
        expect(ficha.nombreDeAsistente('ok gracias')).toBeNull();
        expect(ficha.nombreDeAsistente('¿a qué hora es?')).toBeNull();
        expect(ficha.nombreDeAsistente('cuando es la clinica')).toBeNull();
        expect(ficha.nombreDeAsistente('Muchas gracias quedo atento')).toBeNull();
    });

    it('en el pie o la descripción del pago: con marca, o un texto que es solo el nombre; nunca «soy …» (quien escribe)', () => {
        const s = 'Clínica de armadores y atacantes';
        expect(ficha.nombreDeAsistenteEnTextos(['Buenas tardes mira'], s)).toBeNull();
        expect(ficha.nombreDeAsistenteEnTextos(['Pago clínica a nombre de Nicolás Cubides'], s)).toBe('Nicolás Cubides');
        expect(ficha.nombreDeAsistenteEnTextos(['Clinica Nicolas Cubides'], s)).toBe('Nicolas Cubides');
        expect(ficha.nombreDeAsistenteEnTextos(['Nicolás cubides'], s)).toBe('Nicolás Cubides');
        expect(ficha.nombreDeAsistenteEnTextos(['Hola esa también ya la pagué'], s)).toBeNull();
        expect(ficha.nombreDeAsistenteEnTextos(['Juan Cubides el papá de Nicolás'], s)).toBeNull();
        // En el chat, solo con marca: un botón del embudo («Club y torneos») no es un nombre.
        expect(ficha.nombreDeAsistenteEnTextos([null], s, ['Club y torneos', 'Nicolás cubides'])).toBeNull();
        expect(ficha.nombreDeAsistenteEnTextos([null], s, ['el cupo es a nombre de Valentina Ruiz Mora'])).toBe('Valentina Ruiz Mora');
        expect(ficha.nombreDeAsistenteEnTextos(['Soy Juan Cubides'], s)).toBeNull();
    });

    it('textos de la venta con el artículo del servicio', () => {
        expect(ficha.paraElServicio('Clínica de armadores')).toBe('para la *Clínica de armadores*');
        expect(ficha.aElServicio('Torneo Relámpago')).toBe('al *Torneo Relámpago*');
        expect(ficha.aElServicio('Copa Monster')).toBe('a la *Copa Monster*');
        expect(ficha.paraElServicio('Monster Cup')).toBe('para *Monster Cup*');
        expect(job.textoVentaNoCuadra(15000, 'Vacacional de verano', [200000, 380000], null))
            .toBe('Recibí tu comprobante de *$15.000* 📄 No coincide con el valor del *Vacacional de verano* (*$200.000* o *$380.000*); la escuela lo revisa y te confirma por aquí.');
    });
});
