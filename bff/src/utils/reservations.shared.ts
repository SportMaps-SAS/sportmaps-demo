// Piezas comunes de las rutas de reservas de canchas (sesión y públicas):
//  · traducción {ok:false,error} de las RPC -> HTTP (contrato F1 §7),
//  · tokens firmados HMAC (invitado y enlace de estado /r/:token),
//  · OTP de correo sin estado (HMAC por ventana de 5 min),
//  · contador anti-abuso en memoria,
//  · interfaz aislada de verificación de canal del invitado (verifyGuestChannel).
//
// Contrato: docs/specs/reservas-canchas-f1-contrato.md
import { createHmac, createHash, timingSafeEqual } from 'crypto';

// ── Traducción de errores de negocio ─────────────────────────────────────────

interface ErrDef { status: number; message: string }

const E = (status: number, message: string): ErrDef => ({ status, message });

export const RESERVATION_ERRORS: Record<string, ErrDef> = {
    SLOT_TAKEN: E(409, 'Ese horario ya fue tomado. Te sugerimos otras franjas disponibles.'),
    IDEMPOTENCY_KEY_REUSED: E(409, 'Esta solicitud ya se usó con otros datos. Genera una nueva e inténtalo de nuevo.'),
    INVALID_STATE: E(409, 'La reserva no está en un estado que permita esta acción.'),
    ALREADY_STARTED: E(409, 'La reserva ya empezó.'),
    CANCELLATION_WINDOW_CLOSED: E(409, 'Ya no puedes cancelar: se cerró la ventana de cancelación. Comunícate con la escuela.'),
    RESCHEDULE_WINDOW_CLOSED: E(409, 'Ya no puedes reprogramar: se cerró la ventana de cambios. Comunícate con la escuela.'),
    FACILITY_BLOCKED: E(409, 'La cancha está bloqueada en ese horario (mantenimiento u otro motivo).'),

    FORBIDDEN: E(403, 'No tienes permiso para esta acción.'),
    STAFF_ONLY_FIELD: E(403, 'Ese dato solo lo puede indicar el personal de la escuela.'),
    CHANNEL_NOT_ALLOWED: E(403, 'Ese canal de reserva no está permitido para ti.'),
    AUDIENCE_NOT_ALLOWED: E(403, 'Esta cancha no está disponible para tu tipo de usuario.'),
    MINOR_CANNOT_BOOK: E(403, 'Un menor de edad no puede reservar. Debe hacerlo su acudiente.'),
    GUEST_NOT_VERIFIED: E(403, 'Debes verificar tu contacto antes de reservar.'),
    ENTITLEMENT_REQUIRED: E(403, 'El plan de esta escuela no incluye reservas de canchas.'),
    PAYMENT_REQUIRED: E(402, 'Esta reserva requiere pago en línea o por transferencia.'),
    TOO_MANY_ACTIVE: E(429, 'Ya tienes el máximo de reservas activas; cancela o usa una antes de reservar otra.'),

    FACILITY_NOT_FOUND: E(404, 'Cancha no encontrada.'),
    RESERVATION_NOT_FOUND: E(404, 'Reserva no encontrada.'),
    GUEST_NOT_FOUND: E(404, 'Invitado no encontrado.'),

    FACILITY_NOT_BOOKABLE: E(422, 'Esta cancha no recibe reservas por ahora.'),
    DURATION_TOO_LONG: E(422, 'La duración supera el máximo permitido para esta cancha.'),
    PRICE_NOT_CONFIGURED: E(422, 'Esta cancha no tiene tarifa configurada.'),
    RESCHEDULE_PRICE_DIFFERS: E(422, 'El nuevo horario cuesta más que el original; cancela y reserva de nuevo.'),
    INVALID_RANGE: E(422, 'El rango de fechas u horas no es válido.'),
    DURATION_TOO_SHORT: E(422, 'La duración es menor a la mínima de la cancha.'),
    INVALID_DURATION: E(422, 'La duración no es válida para esta cancha.'),
    DURATION_MISMATCH: E(422, 'La nueva reserva debe durar lo mismo que la original.'),
    CROSSES_MIDNIGHT: E(422, 'La reserva no puede cruzar la medianoche.'),
    SLOT_NOT_ALIGNED: E(422, 'El horario no coincide con la grilla de la cancha.'),
    OUTSIDE_HOURS: E(422, 'El horario está fuera del horario de atención de la cancha.'),
    TOO_SOON: E(422, 'Ese horario requiere más anticipación.'),
    TOO_FAR: E(422, 'Ese horario está demasiado lejos en el futuro.'),
    IN_THE_PAST: E(422, 'No se puede reservar en el pasado.'),
    PAYMENT_METHOD_NOT_ALLOWED: E(422, 'Ese método de pago no está permitido.'),
    RANGE_TOO_LARGE: E(422, 'El rango de fechas es demasiado grande (máximo 30 días).'),

    INVALID_ARGUMENT: E(400, 'Datos inválidos.'),
    INVALID_AMOUNT: E(400, 'El monto no es válido.'),
    GUEST_REQUIRED: E(400, 'Faltan los datos del invitado.'),
};

export interface RpcFailure {
    ok: false;
    error: string;
    message?: string;
    [k: string]: unknown;
}

export function isRpcFailure(v: any): v is RpcFailure {
    return !!v && typeof v === 'object' && v.ok === false;
}

/** {ok:false,error,...extras} -> { status, body } con mensaje en español. */
export function translateRpcError(fail: RpcFailure): { status: number; body: Record<string, unknown> } {
    const code = String(fail.error ?? 'UNKNOWN');
    const def = RESERVATION_ERRORS[code] ?? E(422, 'No se pudo completar la acción.');
    const { ok: _ok, error: _e, message, ...extras } = fail;
    return {
        status: def.status,
        // El texto del SQL ya viene en español; si no viene, el nuestro.
        body: { error: (typeof message === 'string' && message) || def.message, code, reason: code.toLowerCase(), ...extras },
    };
}

// ── Secreto y tokens firmados ────────────────────────────────────────────────
// Mismo patrón que el carné de torneos: secreto propio por env y, si falta,
// derivado del service-role (no se puede adivinar ni reusar entre propósitos).

export function reservationsSecret(): string {
    return process.env.RESERVATIONS_TOKEN_SECRET
        || createHash('sha256').update(`reservas-canchas:${process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'dev'}`).digest('hex');
}

const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sig = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

export interface SignedPayload { typ: 'g' | 'r'; gid: string; rid?: string; exp: number }

export function signToken(p: SignedPayload, secret = reservationsSecret()): string {
    const body = b64u(JSON.stringify(p));
    return `${body}.${sig(body, secret)}`;
}

export function verifyToken(token: unknown, typ: 'g' | 'r', secret = reservationsSecret(), now = Date.now()): SignedPayload | null {
    if (typeof token !== 'string' || token.length > 600) return null;
    const [body, s, extra] = token.split('.');
    if (!body || !s || extra !== undefined) return null;
    const expected = Buffer.from(sig(body, secret));
    const got = Buffer.from(s);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    try {
        const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload;
        if (p.typ !== typ || typeof p.gid !== 'string' || typeof p.exp !== 'number' || p.exp < now) return null;
        if (typ === 'r' && typeof p.rid !== 'string') return null;
        return p;
    } catch {
        return null;
    }
}

export const GUEST_TOKEN_TTL_MS = 30 * 60_000;
/** El enlace de estado vence 30 días después del fin de la reserva. */
export const STATUS_LINK_TTL_MS = 30 * 24 * 3600_000;

// ── OTP de correo sin estado ─────────────────────────────────────────────────
// código = HMAC(secreto, guest|correo|ventana de 5 min) -> 6 dígitos. Vale la
// ventana actual y la anterior (5–10 min). No toca la base.

const OTP_BUCKET_MS = 5 * 60_000;

export function otpCode(guestId: string, email: string, bucket: number, secret = reservationsSecret()): string {
    const h = createHmac('sha256', secret).update(`otp|${guestId}|${email.toLowerCase()}|${bucket}`).digest();
    return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function currentOtp(guestId: string, email: string, now = Date.now()): string {
    return otpCode(guestId, email, Math.floor(now / OTP_BUCKET_MS));
}

export function checkOtp(guestId: string, email: string, code: string, now = Date.now()): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    const b = Math.floor(now / OTP_BUCKET_MS);
    const a = Buffer.from(code);
    return [b, b - 1].some((bk) => {
        const e = Buffer.from(otpCode(guestId, email, bk));
        return e.length === a.length && timingSafeEqual(e, a);
    });
}

// ── Contador anti-abuso en memoria (por correo / teléfono / invitado) ────────
// Igual que otpStartLimiter de public-booking: vive en el proceso del BFF.

const hits = new Map<string, number[]>();

/** true si todavía cabe (y lo cuenta); false si ya superó `max` en `windowMs`. */
export function allowHit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) {
        for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
    return true;
}

export function resetHits(): void { hits.clear(); }

// ── Verificación de canal del invitado (aislada detrás de una interfaz) ──────

export interface GuestRow {
    id: string;
    phone: string;
    email: string | null;
    full_name: string;
    verified_phone_at: string | null;
    verified_email_at: string | null;
}

export type ChannelVerification =
    | { ok: true; method: 'phone' }
    | { ok: false; status: 501; code: 'PHONE_VERIFICATION_PENDING'; message: string };

/**
 * Las reservas por canal public/whatsapp/landing exigen `verified_phone_at`
 * (contrato §3). HOY no existe OTP por SMS/WhatsApp en el BFF y un OTP de correo
 * NO prueba el teléfono, así que este adaptador solo acepta a quien ya tenga
 * `verified_phone_at` (lo marcará el futuro adaptador de WhatsApp o el bot).
 * Cuando exista el proveedor, se reemplaza SOLO esta función.
 */
export function verifyGuestChannel(guest: Pick<GuestRow, 'verified_phone_at'>): ChannelVerification {
    if (guest.verified_phone_at) return { ok: true, method: 'phone' };
    return {
        ok: false,
        status: 501,
        code: 'PHONE_VERIFICATION_PENDING',
        message: 'La verificación por WhatsApp está pendiente. Por ahora reserva desde la app o comunícate con la escuela.',
    };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
