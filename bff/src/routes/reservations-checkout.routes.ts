/**
 * reservations-checkout — cobro de reservas de canchas (F2).
 *
 *   POST /api/v1/reservations/:id/checkout        → link de pago DE LA ESCUELA
 *   POST /api/v1/reservations/:id/transfer-proof  → comprobante de transferencia (alarga el hold)
 *   POST /api/v1/reservations/:id/confirm-transfer → staff: aplica la transferencia revisada
 *
 * Contrato: docs/specs/reservas-canchas-f1-contrato.md §3 y §6; modelo de pagos:
 * docs/specs/reservas-canchas-plan-unificado-2026-10.md §5 y docs/payments-connected-accounts-plan.md.
 *
 * Seguridad (lo que NO se negocia):
 *  - La plata es de la escuela. El link se firma con las llaves de LA ESCUELA
 *    (payment_mode 'direct', source 'school_direct'). Escuela en 'unset', en
 *    'aggregator' (llaves de ENV = otra escuela real) o sin pasarela habilitada →
 *    409 SIN_PASARELA_DIRECTA. Nunca se usan credenciales de SportMaps.
 *  - El monto lo decide el servidor: [abono mínimo, saldo]. El cliente solo elige dentro
 *    de ese rango. Se registra en price_snapshot.checkout_amounts para que el webhook
 *    rechace lo que no cuadre.
 *  - Referencia = facility_reservations.payment_reference (RSV-…). Si la reserva ya tiene un
 *    pago aprobado se agrega un sufijo (RSV-…-N): Wompi no deja reutilizar una referencia ya
 *    aprobada y el webhook normaliza el sufijo antes de buscar la reserva.
 *  - Vencimiento del link = hold_expires_at (Wompi expiration-time firmado; MP
 *    expiration_date_to). MP lleva X-Idempotency-Key determinista.
 *  - Un acceso ajeno recibe 404 (no se confirma que la reserva existe).
 *
 * Acople con el invitado (rutas públicas de BFF-1)
 * ------------------------------------------------
 * El invitado no tiene sesión: BFF-1 emite un token de enlace (/r/:token) y lo valida en
 * sus rutas. Para no depender de sus archivos, la validación se INYECTA:
 *
 *     import { setReservationGuestAuth } from './reservations-checkout.routes';
 *     setReservationGuestAuth(async (req, reservationId) => {
 *         const token = req.header('X-Reservation-Token');
 *         const guestBookerId = await validarTokenDeInvitado(token, reservationId); // BFF-1
 *         return guestBookerId ? { guestBookerId } : null;
 *     });
 *
 * Si el validador devuelve un guestBookerId, la ruta exige que sea el guest_booker_id de la
 * reserva. Sin validador registrado, o sin cabecera X-Reservation-Token, se exige sesión
 * (requireAuth). Mientras BFF-1 no lo registre, el invitado simplemente no puede pagar por acá.
 */

import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import { requireAuth } from '../middlewares/authMiddleware';
import { isFacilityStaffRole } from '../utils/facilityRoles';
import { resolveProvider, type ResolvedProvider } from '../services/payment-provider.resolver';
import {
    buildWebCheckoutUrl,
    copToCents,
    signIntegrityWithExpiration,
    wompiCredsFrom,
} from '../services/wompi.service';
import { createMpPreference } from '../services/mercadopago.service';
import { validarLlaveCheckoutEscuela } from '../services/wompi-llave-checkout.guard';
import { appPublica } from '../utils/url-publica-familias';
import { z } from 'zod';
import { zodBadRequest } from '../middlewares/reservationsInput';
import { writeAudit, ctxFromReq } from '../utils/auditWrite';
import { LIMITS } from '../utils/reservations.schemas';
import {
    abonoMinimoDeReserva,
    alertarAdminsDeReserva,
    baseReservationReference,
    notificarReservaConfirmada,
    saldoDeReserva,
} from '../services/reservation-payments.service';

const router = Router();

// ─── Acople del invitado (inyectable) ────────────────────────────────────────

export type ReservationGuestAuth = (
    req: Request,
    reservationId: string,
) => Promise<{ guestBookerId: string } | null>;

let guestAuth: ReservationGuestAuth | null = null;

/** BFF-1 registra aquí su validador del token de enlace del invitado. `null` lo quita. */
export function setReservationGuestAuth(fn: ReservationGuestAuth | null): void {
    guestAuth = fn;
}

declare global {
    namespace Express {
        interface Request {
            /** Invitado ya validado por el validador inyectado (no hay sesión). */
            reservationGuest?: { guestBookerId: string };
        }
    }
}

/** Invitado con token válido, o sesión normal. */
async function authSesionOInvitado(req: Request, res: Response, next: NextFunction) {
    if (guestAuth && req.header('X-Reservation-Token')) {
        try {
            const reservationId = String(req.params.id ?? '');
            const g = await guestAuth(req, reservationId);
            if (!g?.guestBookerId) return res.status(404).json({ error: 'reservation_not_found' });
            req.reservationGuest = { guestBookerId: g.guestBookerId };
            return next();
        } catch {
            return res.status(404).json({ error: 'reservation_not_found' });
        }
    }
    return requireAuth(req, res, next);
}

// ─── Utilidades ──────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Margen mínimo de vigencia para abrir un checkout (no nace a punto de vencer). */
const MIN_HOLD_MS = 60 * 1000;
/** Al subir comprobante de transferencia el hold se alarga (revisión humana). */
export const TRANSFER_REVIEW_HOLD_MIN = 12 * 60;
const MAX_CHECKOUT_AMOUNTS = 10;

const RESERVATION_COLUMNS =
    'id, school_id, facility_id, user_id, guest_booker_id, status, payment_status, price, amount_paid, hold_expires_at, price_snapshot, payment_reference, min_deposit_pct, updated_at';

async function esStaffDeLaEscuela(userId: string, schoolId: string): Promise<boolean> {
    const { data: school } = await supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle();
    if ((school as any)?.owner_id === userId) return true;
    // QA T1: antes solo ['owner','admin','staff']: el rol real de los administradores es 'school_admin'
    // (y 'school' / 'facility_manager'), así que ellos recibían 404 al confirmar transferencias. Misma
    // lista que el resto del módulo (utils/facilityRoles). 'staff' se conserva por compatibilidad.
    const { data: member } = await supabase
        .from('school_members')
        .select('role')
        .eq('school_id', schoolId)
        .eq('profile_id', userId)
        .eq('status', 'active')
        .maybeSingle(); // UNIQUE (profile_id, school_id): una sola fila
    const role = (member as any)?.role;
    return isFacilityStaffRole(role) || role === 'staff';
}

/** Carga la reserva y verifica que quien llama sea su dueño, el invitado dueño o staff. */
async function cargarReservaAutorizada(
    req: Request,
    opts: { soloStaff?: boolean } = {},
): Promise<{ reserva: Record<string, any>; esStaff: boolean } | null> {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return null;
    const { data } = await supabase.from('facility_reservations').select(RESERVATION_COLUMNS).eq('id', id).maybeSingle();
    const reserva = data as Record<string, any> | null;
    if (!reserva) return null;

    if (req.reservationGuest) {
        if (opts.soloStaff) return null;
        return reserva.guest_booker_id && reserva.guest_booker_id === req.reservationGuest.guestBookerId
            ? { reserva, esStaff: false }
            : null;
    }
    const userId = req.user?.id;
    if (!userId) return null;
    const esStaff = reserva.school_id ? await esStaffDeLaEscuela(userId, reserva.school_id) : false;
    if (opts.soloStaff) return esStaff ? { reserva, esStaff } : null;
    if (reserva.user_id === userId || esStaff) return { reserva, esStaff };
    return null;
}

function holdVigente(reserva: Record<string, any>, minMs = MIN_HOLD_MS): boolean {
    const t = reserva.hold_expires_at ? new Date(reserva.hold_expires_at).getTime() : NaN;
    return Number.isFinite(t) && t - Date.now() >= minMs;
}

/** UUID determinista: el mismo checkout reintentado manda la misma X-Idempotency-Key a MP. */
export function idempotencyKeyDeCheckout(parts: (string | number)[]): string {
    const h = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Ruta interna segura para volver de la pasarela (sin open redirect). */
function rutaDeRetorno(raw: unknown): string {
    const p = typeof raw === 'string' ? raw : '';
    return p.startsWith('/') && !p.startsWith('//') && !p.includes('\\') && p.length <= 200 ? p : '/venue/reservas';
}

/** Monto elegido por el cliente dentro de [abono mínimo, saldo]. */
export function resolverMontoCheckout(
    reserva: Record<string, any>,
    body: { amount?: unknown; mode?: unknown },
): { ok: true; amount: number } | { ok: false; min: number; max: number } {
    const min = abonoMinimoDeReserva(reserva);
    const max = saldoDeReserva(reserva);
    let amount: number;
    if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
        amount = Number(body.amount);
    } else if (body.mode === 'total') {
        amount = max;
    } else {
        amount = min;
    }
    if (!Number.isInteger(amount) || amount < min || amount > max || max <= 0) return { ok: false, min, max };
    return { ok: true, amount };
}

// ─── Escritura de price_snapshot con bloqueo optimista (M5) ──────────────────

const MAX_SNAPSHOT_RETRIES = 3;

type PersistirResultado =
    | { ok: true; row: Record<string, any> }
    | { ok: false; reason: 'error' | 'gone' | 'conflict'; error?: string };

/**
 * confirmar_pago_reserva escribe payment_events / payments en el MISMO jsonb (price_snapshot) y sube updated_at.
 * Leer-copiar-escribir sin guarda pisaba lo que el webhook había guardado entre la lectura y el UPDATE (p. ej. el id
 * de evento de repetición). Acá el UPDATE lleva `updated_at = <valor leído>`: si alguien escribió antes, no actualiza
 * ninguna fila, se RELEE la reserva y se reconstruye el cambio sobre lo nuevo (hasta 3 intentos).
 *
 * `construir` recibe la fila más reciente y devuelve las columnas a escribir; se vuelve a llamar en cada reintento.
 */
async function persistirConBloqueo(
    reserva: Record<string, any>,
    construir: (actual: Record<string, any>) => Record<string, unknown>,
    opts: { holdVigente?: boolean } = {},
): Promise<PersistirResultado> {
    let actual = reserva;
    for (let intento = 0; intento < MAX_SNAPSHOT_RETRIES; intento++) {
        let q: any = supabase
            .from('facility_reservations')
            .update(construir(actual))
            .eq('id', actual.id)
            .eq('status', 'pending_payment');
        if (typeof actual.updated_at === 'string') q = q.eq('updated_at', actual.updated_at);
        if (opts.holdVigente) q = q.gt('hold_expires_at', new Date().toISOString());
        const { data, error } = await q.select('id, hold_expires_at');
        if (error) return { ok: false, reason: 'error', error: error.message };
        if (Array.isArray(data) && data.length > 0) return { ok: true, row: data[0] as Record<string, any> };

        // 0 filas: cambió el estado/updated_at (o venció el hold). Se relee y se decide.
        const { data: fresca } = await supabase.from('facility_reservations').select(RESERVATION_COLUMNS).eq('id', actual.id).maybeSingle();
        const f = fresca as Record<string, any> | null;
        if (!f || f.status !== 'pending_payment') return { ok: false, reason: 'gone' };
        if (opts.holdVigente && !holdVigente(f, 0)) return { ok: false, reason: 'gone' };
        actual = f;
    }
    return { ok: false, reason: 'conflict' };
}

// ─── Comprobantes de transferencia: validación de la URL (A2) ────────────────

/** Extensiones de comprobante aceptadas. */
export const PROOF_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'pdf'] as const;
/** Tamaño máximo del objeto (10 MB) cuando Storage informa metadata. */
export const PROOF_MAX_BYTES = 10 * 1024 * 1024;
/** Topes diarios de reservas con comprobante en revisión: por quien reservó y por escuela. */
export const PROOF_DAILY_LIMIT_PER_USER = 3;
export const PROOF_DAILY_LIMIT_PER_SCHOOL = 20;

/**
 * Buckets de comprobantes permitidos. Por defecto `payment-receipts` (el bucket que ya usan los comprobantes de pago
 * del repo: receipt-approval.service, glosa.service, cobro-enlace-publico). Configurable con
 * RESERVATION_PROOF_BUCKETS="bucket1,bucket2".
 */
export function proofBuckets(): string[] {
    const raw = String(process.env.RESERVATION_PROOF_BUCKETS ?? 'payment-receipts');
    return raw.split(',').map(b => b.trim()).filter(Boolean);
}

export interface ProofRef { bucket: string; path: string; segments: string[] }

/**
 * Parsea una URL de Storage de NUESTRO proyecto: mismo origen que SUPABASE_URL y ruta
 * /storage/v1/object/(public|sign|authenticated)/<bucket>/<path...>. Devuelve null si algo no cuadra
 * (otro host, otro esquema/puerto, credenciales en la URL, `..`, segmentos vacíos, bucket fuera de la lista
 * blanca o extensión no permitida).
 */
export function parseProofUrl(raw: unknown): ProofRef | null {
    if (typeof raw !== 'string' || raw.length > 1000) return null;
    // new URL() normaliza `..`; se rechaza ANTES, sobre el texto crudo (también `%2e` / `%2f` / `%5c`).
    if (/%2e|%2f|%5c|\/\.\.?(\/|$)/i.test(raw.split('?')[0])) return null;
    let base: URL; let u: URL;
    try {
        base = new URL(String(process.env.SUPABASE_URL ?? ''));
        u = new URL(raw);
    } catch { return null; }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
    if (u.origin !== base.origin || u.username || u.password) return null;
    const m = /^\/storage\/v1\/object\/(public|sign|authenticated)\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    let segments: string[];
    try { segments = m[2].split('/').map(decodeURIComponent); } catch { return null; }
    if (segments.length < 3) return null; // bucket + carpeta + archivo
    if (segments.some(sg => !sg || sg === '.' || sg === '..' || /[\\/\u0000-\u001f]/.test(sg))) return null;
    const [bucket, ...rest] = segments;
    if (!proofBuckets().includes(bucket)) return null;
    const ext = rest[rest.length - 1].split('.').pop()?.toLowerCase() ?? '';
    if (!(PROOF_EXTENSIONS as readonly string[]).includes(ext)) return null;
    return { bucket, path: rest.join('/'), segments: rest };
}

/**
 * Convención de ruta (documentada en docs/specs/reservas-canchas-f1-contrato.md §Comprobantes):
 *   <actor>/<archivo>   o   <actor>/<reservationId>/<archivo>
 * donde <actor> = user_id de quien sube (sesión) | guest_booker_id (invitado), o bien el id de la RESERVA
 * (sirve a un invitado que sube con una URL firmada de subida emitida por el BFF).
 */
export function proofPathPerteneceAlActor(ref: ProofRef, actorId: string | null, reservationId: string): boolean {
    const first = ref.segments[0]?.toLowerCase();
    if (!first) return false;
    return (!!actorId && first === actorId.toLowerCase()) || first === reservationId.toLowerCase();
}

/** ¿El objeto existe en Storage (service_role) y parece un comprobante? Sin fetch HTTP arbitrario. */
export async function comprobanteExisteEnStorage(ref: ProofRef): Promise<'ok' | 'missing' | 'invalid' | 'error'> {
    const i = ref.path.lastIndexOf('/');
    const carpeta = ref.path.slice(0, i);
    const nombre = ref.path.slice(i + 1);
    try {
        const { data, error } = await supabase.storage.from(ref.bucket).list(carpeta, { limit: 100, search: nombre });
        if (error) return 'error';
        const obj = (data ?? []).find((o: any) => o?.name === nombre && o?.id);
        if (!obj) return 'missing';
        const meta = (obj as any).metadata ?? {};
        if (Number.isFinite(Number(meta.size)) && (Number(meta.size) <= 0 || Number(meta.size) > PROOF_MAX_BYTES)) return 'invalid';
        const mime = String(meta.mimetype ?? '');
        if (mime && !/^(image\/|application\/pdf$)/i.test(mime)) return 'invalid';
        return 'ok';
    } catch {
        return 'error';
    }
}

/** Cuántas reservas (otras que esta) tienen comprobante en revisión en las últimas 24 h. */
async function comprobantesEnRevisionHoy(
    filtro: { col: 'user_id' | 'guest_booker_id' | 'school_id'; id: string },
    excluirReservaId: string,
    tope: number,
): Promise<number> {
    const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await supabase
        .from('facility_reservations')
        .select('id')
        .eq(filtro.col, filtro.id)
        .eq('status', 'pending_payment')
        .neq('id', excluirReservaId)
        .gte('price_snapshot->transfer_proof->>submitted_at', desde)
        .limit(tope + 1);
    return Array.isArray(data) ? data.length : 0;
}

// ─── Esquemas de entrada (estrictos) ─────────────────────────────────────────

const CheckoutBodySchema = z.strictObject({
    // El rango real [abono mínimo, saldo] lo impone resolverMontoCheckout (400 amount_out_of_range).
    amount: z.number().finite().min(-LIMITS.amountMax).max(LIMITS.amountMax).optional(),
    mode: z.enum(['total', 'deposit', 'min']).optional(),
    provider: z.enum(['wompi', 'mercadopago']).optional(),
    return_path: z.string().max(200).optional(),
});
const TransferProofBodySchema = z.strictObject({ proof_url: z.string().max(1000) });
const ConfirmTransferBodySchema = z.strictObject({
    amount: z.number().int().min(1).max(LIMITS.amountMax),
});

// ─── POST /:id/checkout ──────────────────────────────────────────────────────

router.post('/:id/checkout', authSesionOInvitado, async (req: Request, res: Response) => {
    try {
        const cargada = await cargarReservaAutorizada(req);
        if (!cargada) return res.status(404).json({ error: 'reservation_not_found' });
        const { reserva } = cargada;
        const bodyParsed = CheckoutBodySchema.safeParse(req.body ?? {});
        if (!bodyParsed.success) return zodBadRequest(res, bodyParsed.error.issues);
        const body = bodyParsed.data;

        if (reserva.status !== 'pending_payment') {
            return res.status(409).json({ error: 'reservation_not_payable', status: reserva.status });
        }
        if (!holdVigente(reserva)) {
            return res.status(409).json({ error: 'hold_expired', message: 'El tiempo para pagar esta reserva se agotó. Vuelve a reservar.' });
        }
        const base = baseReservationReference(reserva.payment_reference);
        if (!base || !reserva.school_id) {
            return res.status(409).json({ error: 'reservation_without_reference' });
        }

        const monto = resolverMontoCheckout(reserva, body);
        if (!monto.ok) {
            return res.status(400).json({ error: 'amount_out_of_range', min: monto.min, max: monto.max });
        }
        const amount = monto.amount;

        // Pasarela DE LA ESCUELA. resolveProvider ya es fail-closed para 'unset' y 'direct'
        // sin cuenta; además se exige source 'school_direct' (nada de ENV = otra escuela).
        const preferred = body.provider ?? null;
        const resolved: ResolvedProvider | null = await resolveProvider({ schoolId: reserva.school_id, preferredProvider: preferred });
        if (!resolved || resolved.source !== 'school_direct' || !resolved.accessToken) {
            return res.status(409).json({
                error: 'SIN_PASARELA_DIRECTA',
                message: 'La escuela no tiene pago en línea habilitado. Paga por transferencia.',
            });
        }
        if (preferred && resolved.provider !== preferred) {
            return res.status(409).json({ error: 'SIN_PASARELA_DIRECTA', message: 'La escuela no tiene ese medio de pago habilitado.' });
        }

        const expiresAt = new Date(reserva.hold_expires_at).toISOString();
        // Pago posterior al primero: referencia con sufijo (ver cabecera).
        const reference = Number(reserva.amount_paid) > 0
            ? `${base}-${Date.now().toString(36).toUpperCase()}`
            : base;

        // Se registra lo que se OFRECE antes de entregar el link: el webhook lo usa para validar.
        // Con bloqueo optimista (M5): se re-lee y se fusiona si el webhook escribió el snapshot entre medias.
        const persist = await persistirConBloqueo(reserva, (actual) => {
            const snap = (actual.price_snapshot && typeof actual.price_snapshot === 'object') ? { ...actual.price_snapshot } : {};
            const previos: number[] = Array.isArray(snap.checkout_amounts) ? snap.checkout_amounts.map(Number) : [];
            snap.checkout_amounts = [...new Set([...previos, amount])].slice(-MAX_CHECKOUT_AMOUNTS);
            snap.checkout = { provider: resolved.provider, amount, reference, expires_at: expiresAt, created_at: new Date().toISOString() };
            return { price_snapshot: snap };
        });
        if (!persist.ok) {
            if (persist.reason === 'gone') return res.status(409).json({ error: 'reservation_not_payable' });
            if (persist.reason === 'conflict') return res.status(409).json({ error: 'reservation_busy', message: 'La reserva cambió mientras se preparaba el pago. Inténtalo de nuevo.' });
            req.log?.error({ err: persist.error, reservationId: reserva.id }, 'reservations checkout: no se pudo registrar el monto');
            return res.status(500).json({ error: 'checkout_persist_failed' });
        }

        const retorno = `${appPublica()}${rutaDeRetorno(body.return_path)}`;

        if (resolved.provider === 'wompi') {
            const guard = validarLlaveCheckoutEscuela(resolved);
            if (!guard.ok) {
                req.log?.warn({ code: guard.code, schoolId: reserva.school_id }, 'reservations checkout: llave Wompi no apta');
                return res.status(409).json({ error: 'SIN_PASARELA_DIRECTA', message: 'La pasarela de la escuela no está lista para cobrar.' });
            }
            const creds = wompiCredsFrom(resolved);
            if (!creds?.integritySecret) {
                return res.status(409).json({ error: 'SIN_PASARELA_DIRECTA', message: 'La pasarela de la escuela no está lista para cobrar.' });
            }
            const amountInCents = copToCents(amount);
            const url = buildWebCheckoutUrl({
                publicKey: creds.publicKey,
                reference,
                amountInCents,
                expirationTime: expiresAt,
                signature: signIntegrityWithExpiration({ reference, amountInCents, expirationTime: expiresAt }, creds),
                redirectUrl: retorno,
            });
            return res.status(200).json({ checkout_url: url, expires_at: expiresAt, amount, provider: 'wompi', reference });
        }

        // MercadoPago (cuenta de la escuela)
        if (resolved.sandbox && process.env.NODE_ENV === 'production') {
            return res.status(409).json({ error: 'SIN_PASARELA_DIRECTA', message: 'La pasarela de la escuela no está lista para cobrar.' });
        }
        // En producción NUNCA se confía en la cabecera Host (la controla quien llama): la URL de notificación sale de
        // PUBLIC_API_URL. Sin ella, 409 claro (antes de crear la preferencia en MP).
        const baseApiEnv = String(process.env.PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
        if (!baseApiEnv && process.env.NODE_ENV === 'production') {
            req.log?.error({ reservationId: reserva.id }, 'reservations checkout: PUBLIC_API_URL no configurada en producción');
            return res.status(409).json({ error: 'PUBLIC_API_URL_REQUIRED', message: 'El pago en línea no está disponible por ahora. Paga por transferencia.' });
        }
        const baseApi = baseApiEnv || `${req.protocol}://${req.get('host')}`;
        const pref = await createMpPreference({
            accessToken: resolved.accessToken,
            title: 'Reserva de cancha',
            amount,
            externalReference: reference,
            notificationUrl: `${baseApi}/api/v1/webhooks/mercadopago/webhook/${reserva.school_id}`,
            expiresAt,
            backUrl: retorno,
            idempotencyKey: idempotencyKeyDeCheckout(['rsv-checkout', reserva.id, 'mercadopago', amount, expiresAt]),
        });
        if (!pref.ok) {
            req.log?.error({ err: pref.error, reservationId: reserva.id }, 'reservations checkout: MP preference failed');
            return res.status(502).json({ error: 'gateway_error' });
        }
        const url = resolved.sandbox && pref.sandboxInitPoint ? pref.sandboxInitPoint : pref.initPoint;
        return res.status(200).json({ checkout_url: url, expires_at: expiresAt, amount, provider: 'mercadopago', reference });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'reservations checkout: unexpected error');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// ─── POST /:id/transfer-proof ────────────────────────────────────────────────

/**
 * Compat: solo valida la FORMA de la URL (host propio, ruta de Storage, bucket permitido, extensión). La pertenencia
 * al actor, la existencia del objeto y los topes diarios se verifican en la ruta.
 */
export function esUrlDeComprobanteValida(raw: unknown): raw is string {
    return parseProofUrl(raw) !== null;
}

router.post('/:id/transfer-proof', authSesionOInvitado, async (req: Request, res: Response) => {
    try {
        const cargada = await cargarReservaAutorizada(req);
        if (!cargada) return res.status(404).json({ error: 'reservation_not_found' });
        const { reserva } = cargada;

        const proofParsed = TransferProofBodySchema.safeParse(req.body ?? {});
        if (!proofParsed.success) return zodBadRequest(res, proofParsed.error.issues);
        const proofUrl = proofParsed.data.proof_url;
        const ref = parseProofUrl(proofUrl);
        if (!ref) {
            return res.status(400).json({ error: 'invalid_proof_url' });
        }
        // Debe vivir bajo la carpeta del actor (user_id | guest_booker_id) o de la reserva: nadie referencia el archivo de otro.
        const actorId = req.reservationGuest?.guestBookerId ?? req.user?.id ?? null;
        if (!proofPathPerteneceAlActor(ref, actorId, String(reserva.id))) {
            return res.status(403).json({ error: 'proof_not_owned' });
        }
        if (reserva.status !== 'pending_payment') {
            return res.status(409).json({ error: 'reservation_not_payable', status: reserva.status });
        }
        // Con el hold vencido la franja ya pudo tomarla otra persona: no se alarga a ciegas.
        if (!holdVigente(reserva, 0)) {
            return res.status(409).json({ error: 'hold_expired', message: 'El tiempo para esta reserva se agotó. Vuelve a reservar.' });
        }

        // Topes diarios (el hold de 12 h congela la franja: no se regala con cuentas gratis).
        const dueno = reserva.user_id
            ? { col: 'user_id' as const, id: String(reserva.user_id) }
            : reserva.guest_booker_id ? { col: 'guest_booker_id' as const, id: String(reserva.guest_booker_id) } : null;
        if (dueno && await comprobantesEnRevisionHoy(dueno, String(reserva.id), PROOF_DAILY_LIMIT_PER_USER) >= PROOF_DAILY_LIMIT_PER_USER) {
            return res.status(429).json({ error: 'proof_daily_limit', scope: 'user', message: 'Ya tienes varias reservas con comprobante en revisión hoy. Espera a que la escuela las revise.' });
        }
        if (reserva.school_id && await comprobantesEnRevisionHoy({ col: 'school_id', id: String(reserva.school_id) }, String(reserva.id), PROOF_DAILY_LIMIT_PER_SCHOOL) >= PROOF_DAILY_LIMIT_PER_SCHOOL) {
            return res.status(429).json({ error: 'proof_daily_limit', scope: 'school', message: 'Hay demasiados comprobantes en revisión para esta escuela. Intenta más tarde.' });
        }

        // El objeto debe existir de verdad en Storage y parecer un comprobante.
        const existe = await comprobanteExisteEnStorage(ref);
        if (existe === 'error') return res.status(503).json({ error: 'proof_check_unavailable' });
        if (existe !== 'ok') return res.status(400).json({ error: 'proof_not_found', reason: existe });

        const nuevoHold = new Date(Date.now() + TRANSFER_REVIEW_HOLD_MIN * 60 * 1000).toISOString();
        let yaAlargado = false;
        const persist = await persistirConBloqueo(reserva, (actual) => {
            const snap = (actual.price_snapshot && typeof actual.price_snapshot === 'object') ? { ...actual.price_snapshot } : {};
            yaAlargado = !!snap.transfer_proof?.hold_extended;
            snap.transfer_proof = {
                url: proofUrl,
                bucket: ref.bucket,
                path: ref.path,
                submitted_at: new Date().toISOString(),
                hold_extended: true,
            };
            const cambios: Record<string, unknown> = { price_snapshot: snap };
            // Se alarga UNA sola vez: subir comprobantes en cadena no debe congelar la cancha para siempre.
            if (!yaAlargado) cambios.hold_expires_at = nuevoHold;
            return cambios;
        }, { holdVigente: true });
        if (!persist.ok) {
            if (persist.reason === 'gone') return res.status(409).json({ error: 'hold_expired' }); // perdió la carrera contra expirar_holds o un pago
            if (persist.reason === 'conflict') return res.status(409).json({ error: 'reservation_busy', message: 'La reserva cambió mientras se guardaba el comprobante. Inténtalo de nuevo.' });
            req.log?.error({ err: persist.error, reservationId: reserva.id }, 'transfer-proof update failed');
            return res.status(500).json({ error: 'transfer_proof_failed' });
        }

        await alertarAdminsDeReserva({
            schoolId: reserva.school_id,
            reservationId: reserva.id,
            tipo: 'reservation_transfer_proof',
            titulo: 'Comprobante de reserva por revisar',
            mensaje: 'Llegó un comprobante de transferencia de una reserva de cancha. Revísalo y confírmalo; la franja queda apartada mientras tanto.',
            log: req.log,
        });

        const holdFinal = (persist.row as any)?.hold_expires_at ?? (yaAlargado ? reserva.hold_expires_at : nuevoHold);
        return res.status(200).json({ ok: true, status: 'pending_payment', in_review: true, hold_expires_at: holdFinal });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'transfer-proof: unexpected error');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// ─── POST /:id/confirm-transfer (solo staff) ─────────────────────────────────

router.post('/:id/confirm-transfer', requireAuth, async (req: Request, res: Response) => {
    try {
        const cargada = await cargarReservaAutorizada(req, { soloStaff: true });
        if (!cargada) return res.status(404).json({ error: 'reservation_not_found' });
        const { reserva } = cargada;

        const snap = reserva.price_snapshot ?? {};
        if (!snap.transfer_proof?.url) {
            return res.status(409).json({ error: 'no_transfer_proof' });
        }
        const confirmParsed = ConfirmTransferBodySchema.safeParse(req.body ?? {});
        if (!confirmParsed.success) return zodBadRequest(res, confirmParsed.error.issues);
        const amount = confirmParsed.data.amount;
        const saldo = saldoDeReserva(reserva);
        if (!Number.isInteger(amount) || amount <= 0 || amount > saldo) {
            return res.status(400).json({ error: 'amount_out_of_range', min: 1, max: saldo });
        }

        // Clave de idempotencia determinista: el mismo comprobante + monto no suma dos veces.
        const urlHash = crypto.createHash('sha256').update(String(snap.transfer_proof.url)).digest('hex').slice(0, 16);
        const eventId = `transfer:${reserva.id}:${urlHash}:${amount}`;

        const { data, error } = await supabase.rpc('confirmar_pago_reserva', {
            p_reference: reserva.payment_reference,
            p_amount: amount,
            p_payment_id: null,
            p_provider: 'transfer',
            p_provider_event_id: eventId,
        });
        if (error) {
            req.log?.error({ err: error.message, reservationId: reserva.id }, 'confirm-transfer: RPC failed');
            return res.status(500).json({ error: 'confirmar_pago_reserva_failed' });
        }
        const result = (data ?? {}) as Record<string, any>;
        if (result.ok === false) {
            return res.status(result.error === 'RESERVATION_NOT_FOUND' ? 404 : 422).json({ error: result.error, message: result.message });
        }
        if (!result.already_processed && (result.confirmed || result.reconciliation)) {
            await writeAudit(
                { ...ctxFromReq(req), schoolId: reserva.school_id },
                result.reconciliation ? 'reservation_reconciliation' : 'reservation_transfer_confirmed',
                'facility_reservations', String(reserva.id), { status: reserva.status, amount_paid: reserva.amount_paid },
                { amount, confirmed: !!result.confirmed, reconciliation: !!result.reconciliation, provider: 'transfer' },
            );
        }
        if (result.confirmed && !result.already_processed) {
            await notificarReservaConfirmada({ ...(result.reservation ?? {}), id: reserva.id, user_id: reserva.user_id, school_id: reserva.school_id }, req.log);
        }
        if (result.reconciliation) {
            await alertarAdminsDeReserva({
                schoolId: reserva.school_id, reservationId: reserva.id, tipo: 'reservation_reconciliation',
                titulo: 'Transferencia de reserva sin cancha',
                mensaje: 'Confirmaste una transferencia, pero la franja ya no está disponible. Devuelve el dinero o déjalo como saldo a favor.',
                log: req.log,
            });
        }
        return res.status(200).json({
            ok: true,
            confirmed: !!result.confirmed,
            already_processed: !!result.already_processed,
            reconciliation: !!result.reconciliation,
            reservation: result.reservation ?? null,
        });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'confirm-transfer: unexpected error');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

export default router;
