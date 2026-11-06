// bff/src/routes/public-reservations.routes.ts
//
// Reservas de canchas SIN SESIÓN (página pública de la escuela). Montado en
// /api/v1/public/reservations. Todo entra con service_role a las RPC del
// contrato (docs/specs/reservas-canchas-f1-contrato.md); `anon` no tiene
// EXECUTE en ninguna, así que este router es la única puerta.
//
// IDENTIDAD DEL INVITADO (decisión importante):
//  · El contrato exige `guest_bookers.verified_phone_at` para los canales
//    public/whatsapp/landing. HOY el BFF solo tiene OTP por correo y NO existe
//    OTP por SMS/WhatsApp. Un OTP de correo prueba el CORREO, no el teléfono:
//    por eso /guests/verify marca SOLO `verified_email_at` y NUNCA
//    `verified_phone_at`.
//  · Reservar (POST /) pasa por verifyGuestChannel(): mientras el invitado no
//    tenga `verified_phone_at`, responde 501 PHONE_VERIFICATION_PENDING. Cuando
//    exista el adaptador de WhatsApp se reemplaza SOLO esa función.
//  · Anti-suplantación: como el teléfono no está probado, un invitado existente
//    solo se reutiliza si el correo coincide con el que ya tiene guardado; así
//    nadie obtiene el token de otro escribiendo su teléfono con un correo propio.
//
// Captcha: no existe infraestructura en el BFF; no se inventa proveedor.
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { emailClient } from '../utils/emailClient';
import { escapeHtmlText } from '../utils/sanitize';
import { requireIdempotencyKey } from '../middlewares/requireIdempotencyKey';
import {
    GuestRow, GUEST_TOKEN_TTL_MS, STATUS_LINK_TTL_MS, UUID_RE,
    allowHit, checkOtp, currentOtp, isRpcFailure, linkJti, newGuestJti, reservationsClientIp, reservationsRateLimitStore,
    signToken, translateRpcError, verifyGuestChannel, verifyToken,
} from '../utils/reservations.shared';

import { setReservationGuestAuth } from './reservations-checkout.routes';
import { zodBadRequest } from '../middlewares/reservationsInput';
import {
    LIMITS, uuid, isoZoned, dateYmd, freeText, personName, phoneField,
    rangeRefine, rangeMsg, durationRefine, durationMsg, reasonField,
} from '../utils/reservations.schemas';

const router = Router();

// QA T1: el cobro (reservations-checkout) está pensado para que el invitado pague con el token del
// enlace de estado en `X-Reservation-Token`, pero nadie registraba el validador: sin él el invitado
// caía al requireAuth (401) y no podía pagar su reserva. Se valida firma + vencimiento (typ 'r') y que el
// token sea DE ESA reserva; el módulo de cobro además exige que guest_booker_id coincida con el de la fila.
setReservationGuestAuth(async (req, reservationId) => {
    const p = verifyToken(req.header('X-Reservation-Token'), 'r');
    if (!p || !p.rid || p.rid.toLowerCase() !== String(reservationId).toLowerCase()) return null;
    return { guestBookerId: p.gid };
});

const WINDOW_MS = 10 * 60 * 1000;
const DEBUG_OTP_ENABLED = process.env.PUBLIC_BOOKING_DEBUG_OTP === 'true';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const iso = isoZoned;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/i;

// La llave usa la IP REAL del cliente (CF-Connecting-IP validada; ver reservationsClientIp), no req.ip: detrás de
// Cloudflare + Render req.ip es el borde de CF y rota. El almacén se resuelve de forma perezosa para poder
// enchufar un almacén compartido con setReservationsRateLimitStoreFactory() (el store resuelve el real en el primer uso).
const limiter = (name: string, max: number, message: string): RequestHandler => rateLimit({
    windowMs: WINDOW_MS, max, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `rsv-${name}-${ipKeyGenerator(reservationsClientIp(req))}`,
    store: reservationsRateLimitStore(),
    message: { error: message },
});
const startLimiter = limiter('guest-start', 5, 'Demasiados intentos. Espera unos minutos.');
const verifyLimiter = limiter('guest-verify', 10, 'Demasiados intentos. Espera unos minutos.');
const readLimiter = limiter('read', 120, 'Demasiadas peticiones. Intenta de nuevo en unos minutos.');
const writeLimiter = limiter('write', 20, 'Demasiadas peticiones. Intenta de nuevo en unos minutos.');

const fail = (res: Response, status: number, error: string, extra: Record<string, unknown> = {}) =>
    res.status(status).json({ error, ...extra });

function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/\D/g, '');
    const full = digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits;
    return full.length >= 10 && full.length <= 15 ? `+${full}` : null;
}

function maskEmail(email: string): string {
    const [user, domain] = email.split('@');
    return domain ? `${user.slice(0, 2)}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}` : email;
}

const GUEST_COLS = 'id, phone, email, full_name, verified_phone_at, verified_email_at';

// ── GET /schools/:slug ───────────────────────────────────────────────────────
// Solo campos publicables. Nunca rental_rate / min_deposit crudos: el precio sale de /availability.
router.get('/schools/:slug', readLimiter, async (req: Request, res: Response) => {
    try {
        const slug = String(req.params.slug ?? '');
        if (!SLUG_RE.test(slug)) return fail(res, 404, 'Escuela no encontrada.');
        const { data: school } = await supabase.from('schools').select('id, name, slug').eq('slug', slug).maybeSingle();
        if (!school) return fail(res, 404, 'Escuela no encontrada.');

        const { data: facilities, error } = await supabase
            .from('facilities')
            .select('id, name, type, capacity, slot_step_min, min_duration_min')
            .eq('school_id', school.id)
            .eq('status', 'available')
            .in('bookable_by', ['public', 'both'])
            .or('booking_enabled.is.null,booking_enabled.eq.true')
            .order('name');
        if (error) throw error;

        return res.json({
            school: { id: school.id, name: school.name, slug: school.slug },
            facilities: (facilities ?? []).map((f: any) => ({
                id: f.id, name: f.name, type: f.type, capacity: f.capacity,
                slot_step_min: f.slot_step_min, min_duration_min: f.min_duration_min,
            })),
        });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations school error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

// ── GET /availability — como invitado (p_actor_profile_id NULL => audiencia external) ──
const AvailabilitySchema = z.strictObject({
    school_id: uuid('school_id'),
    from: dateYmd,
    to: dateYmd,
    sport: freeText(LIMITS.sport).optional(),
    facility_id: uuid('facility_id').optional(),
    duration_min: z.coerce.number().int().min(LIMITS.durationMinMin).max(LIMITS.durationMinMax).optional(),
});

/** Rango máximo de la consulta PÚBLICA (el RPC acepta 30; el público no necesita tanto). */
export const PUBLIC_AVAILABILITY_MAX_DAYS = 14;
/** Con más canchas públicas que esto, la consulta debe traer facility_id (evita un barrido por todas las canchas). */
export const PUBLIC_AVAILABILITY_MAX_FACILITIES = 3;
export const PUBLIC_AVAILABILITY_CACHE_MS = 30_000;
const QUERY_TIMEOUT_MS = 8_000;

const availabilityCache = new Map<string, { exp: number; data: unknown }>();

/** Tope de tiempo del lado del cliente (abortSignal de postgrest-js). El statement_timeout de la BASE no se
 *  puede fijar por consulta con supabase-js sin un RPC/rol dedicado (migraciones cerradas): ver contrato §Cabeceras. */
function conTimeout<T>(q: T): T {
    const b = q as any;
    return typeof b?.abortSignal === 'function' ? b.abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)) : q;
}

const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

router.get('/availability', readLimiter, async (req: Request, res: Response) => {
    try {
        const parsed = AvailabilitySchema.safeParse(req.query);
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const q = parsed.data;
        if (daysBetween(q.from, q.to) > PUBLIC_AVAILABILITY_MAX_DAYS) {
            return fail(res, 422, `El rango de fechas es demasiado grande (máximo ${PUBLIC_AVAILABILITY_MAX_DAYS} días).`, { code: 'RANGE_TOO_LARGE', reason: 'range_too_large' });
        }
        // Tope por escuela que NO depende de la IP (quien rota CF-Connecting-IP no lo evade).
        if (!allowHit(`rsv-avail-school:${q.school_id}`, 600, 60_000)) {
            return fail(res, 429, 'Demasiadas peticiones. Intenta de nuevo en unos minutos.');
        }
        if (!q.facility_id) {
            const { data: pubs, error: pubErr } = await conTimeout(supabase
                .from('facilities')
                .select('id')
                .eq('school_id', q.school_id)
                .eq('status', 'available')
                .in('bookable_by', ['public', 'both'])
                .or('booking_enabled.is.null,booking_enabled.eq.true')
                .limit(PUBLIC_AVAILABILITY_MAX_FACILITIES + 1));
            if (pubErr) throw pubErr;
            if (Array.isArray(pubs) && pubs.length > PUBLIC_AVAILABILITY_MAX_FACILITIES) {
                return fail(res, 422, 'Indica la cancha (facility_id) para consultar la disponibilidad.', { code: 'FACILITY_REQUIRED', reason: 'facility_required' });
            }
        }
        const cacheKey = [q.school_id, q.facility_id ?? '', q.from, q.to, q.sport ?? '', q.duration_min ?? ''].join('|');
        const hit = availabilityCache.get(cacheKey);
        if (hit && hit.exp > Date.now()) return res.json(hit.data);

        // Sin p_actor_profile_id ni p_audience: el público nunca elige tarifa.
        const args: Record<string, unknown> = { p_school_id: q.school_id, p_from: q.from, p_to: q.to };
        if (q.sport) args.p_sport = q.sport;
        if (q.facility_id) args.p_facility_id = q.facility_id;
        if (q.duration_min) args.p_duration_min = q.duration_min;
        const { data, error } = await conTimeout(supabase.rpc('disponibilidad_canchas', args));
        if (error) throw error;
        if (isRpcFailure(data)) {
            const t = translateRpcError(data);
            return res.status(t.status).json(t.body);
        }
        if (availabilityCache.size >= 500) {
            const now = Date.now();
            for (const [k, v] of availabilityCache) if (v.exp <= now) availabilityCache.delete(k);
            if (availabilityCache.size >= 500) availabilityCache.clear();
        }
        availabilityCache.set(cacheKey, { exp: Date.now() + PUBLIC_AVAILABILITY_CACHE_MS, data });
        return res.json(data);
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations availability error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

// ── POST /guests/start — crea/reusa guest_bookers y envía OTP al correo ──────
const StartSchema = z.strictObject({
    phone: phoneField,
    email: z.string().max(LIMITS.email),
    full_name: personName,
});

router.post('/guests/start', startLimiter, async (req: Request, res: Response) => {
    try {
        const parsed = StartSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'phone, email y full_name son requeridos.');
        const email = parsed.data.email.trim().toLowerCase();
        const phone = normalizePhone(parsed.data.phone);
        if (!EMAIL_RE.test(email)) return fail(res, 400, 'Correo inválido.');
        if (!phone) return fail(res, 400, 'Teléfono inválido.');

        // Anti-flood por correo y por teléfono (además del límite por IP).
        if (!allowHit(`rsv-start-email:${email}`, 3, WINDOW_MS) || !allowHit(`rsv-start-phone:${phone}`, 3, WINDOW_MS)) {
            return fail(res, 429, 'Demasiados códigos solicitados. Espera unos minutos.');
        }

        let { data: guest } = await supabase.from('guest_bookers').select(GUEST_COLS).eq('phone', phone).maybeSingle();
        if (guest) {
            if ((guest.email ?? '').toLowerCase() !== email) {
                return fail(res, 409, 'Ese teléfono ya está asociado a otro contacto. Por ahora reserva desde la app o comunícate con la escuela.', {
                    code: 'PHONE_IN_USE', reason: 'phone_in_use',
                });
            }
        } else {
            const { data: created, error } = await supabase
                .from('guest_bookers')
                .insert({ phone, email, full_name: parsed.data.full_name })
                .select(GUEST_COLS)
                .single();
            if (error) throw error; // choque de UNIQUE(phone) por carrera => 500; reintenta y cae en la rama de arriba
            guest = created;
        }

        const code = currentOtp((guest as GuestRow).id, email);
        await emailClient.send({
            to: email,
            subject: 'Tu código para reservar tu cancha en SportMaps',
            html: `<p>Tu código de verificación es:</p><h2 style="letter-spacing:3px">${escapeHtmlText(code)}</h2><p>Vence en pocos minutos.</p>`,
            text: `Tu código de verificación es ${code} (vence en pocos minutos).`,
        });

        return res.json({
            sent: true,
            masked_email: maskEmail(email),
            // Honestidad: el correo no prueba el teléfono.
            phone_verified: !!(guest as GuestRow).verified_phone_at,
            ...(DEBUG_OTP_ENABLED ? { debug_code: code } : {}),
        });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations guests/start error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

// ── POST /guests/verify — valida el OTP y entrega token de invitado de corta vida ──
const VerifySchema = z.strictObject({ phone: z.string().max(40), email: z.string().max(LIMITS.email), code: z.string().max(10) });

router.post('/guests/verify', verifyLimiter, async (req: Request, res: Response) => {
    try {
        const parsed = VerifySchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'phone, email y code son requeridos.');
        const email = parsed.data.email.trim().toLowerCase();
        const phone = normalizePhone(parsed.data.phone);
        if (!phone || !EMAIL_RE.test(email)) return fail(res, 400, 'Código incorrecto o vencido.', { code: 'INVALID_CODE' });

        if (!allowHit(`rsv-verify-phone:${phone}`, 5, WINDOW_MS)) {
            return fail(res, 429, 'Demasiados intentos. Solicita un código nuevo en unos minutos.');
        }

        const { data: guest } = await supabase.from('guest_bookers').select(GUEST_COLS).eq('phone', phone).maybeSingle();
        // Misma respuesta para "no existe", "correo distinto" y "código malo": no se enumera nada.
        if (!guest || (guest.email ?? '').toLowerCase() !== email || !checkOtp(guest.id, email, parsed.data.code.trim())) {
            return fail(res, 400, 'Código incorrecto o vencido.', { code: 'INVALID_CODE' });
        }

        if (!guest.verified_email_at) {
            await supabase.from('guest_bookers').update({ verified_email_at: new Date().toISOString() }).eq('id', guest.id);
        }

        const token = signToken({ typ: 'g', gid: guest.id, exp: Date.now() + GUEST_TOKEN_TTL_MS, jti: newGuestJti() });
        return res.json({
            guest_token: token,
            expires_in: Math.floor(GUEST_TOKEN_TTL_MS / 1000),
            email_verified: true,
            // El teléfono sigue sin verificar hasta que exista el adaptador de WhatsApp.
            phone_verified: !!guest.verified_phone_at,
            ...(guest.verified_phone_at ? {} : {
                notice: 'Correo verificado. Para reservar se requiere además verificar el teléfono por WhatsApp (pendiente).',
            }),
        });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations guests/verify error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

// ── POST /guests/verify-phone — adaptador pendiente ─────────────────────────
router.post('/guests/verify-phone', verifyLimiter, (_req: Request, res: Response) =>
    fail(res, 501, 'Verificación por WhatsApp pendiente.', { code: 'PHONE_VERIFICATION_PENDING', reason: 'phone_verification_pending' }));

// ── Guard de invitado: X-Guest-Token ─────────────────────────────────────────
async function requireGuest(req: Request, res: Response, next: NextFunction) {
    try {
        const p = verifyToken(req.header('X-Guest-Token'), 'g');
        if (!p) return fail(res, 401, 'Verifica tu contacto para continuar.', { reason: 'guest_token_required' });
        const { data: guest } = await supabase.from('guest_bookers').select(GUEST_COLS).eq('id', p.gid).maybeSingle();
        if (!guest) return fail(res, 401, 'Verifica tu contacto para continuar.', { reason: 'guest_token_required' });
        (req as any).guest = guest as GuestRow;
        next();
    } catch (err) {
        next(err);
    }
}

// ── POST / — reservar como invitado ──────────────────────────────────────────
const ReserveSchema = z.strictObject({
    facility_id: uuid('facility_id'),
    starts_at: iso,
    ends_at: iso,
    payment_method: z.enum(['online', 'transfer', 'cash']).default('online'),
    participants: z.number().int().min(1).max(LIMITS.participantsMax).optional(),
    notes: freeText(LIMITS.notes, { keepNewlines: true }).optional(),
    external_org_name: freeText(LIMITS.externalOrg).optional(),
}).refine(rangeRefine, rangeMsg).refine(durationRefine, durationMsg);

// LISTA BLANCA de lo que ve el invitado de su reserva (nada de approved_by, channel, refund_status, payment_id,
// idempotency_key, payment_reference, price_snapshot, etc.). El pago se hace por id de reserva + X-Reservation-Token,
// así que la referencia RSV no hace falta en el cliente.
export const GUEST_RESERVATION_FIELDS = [
    'id', 'status', 'payment_status', 'starts_at', 'ends_at', 'facility_id', 'facility_name', 'facility',
    'price', 'amount_paid', 'min_deposit_pct', 'deposit_min', 'hold_expires_at',
    'cancellation_reason', 'cancelled_at', 'participants',
    'local_date', 'local_start', 'local_end', 'in_review',
] as const;
export const GUEST_RESERVATION_COLUMNS =
    'id, status, payment_status, starts_at, ends_at, facility_id, price, amount_paid, min_deposit_pct, hold_expires_at, cancellation_reason, cancelled_at, participants, price_snapshot, facility:facilities(name, type)';

function guestShape(r: any) {
    const src: any = { ...r };
    // Derivados de lo que sí es publicable (el snapshot completo NUNCA sale).
    const snap = src.price_snapshot && typeof src.price_snapshot === 'object' ? src.price_snapshot : null;
    if (src.deposit_min === undefined && snap && Number.isFinite(Number(snap.deposit_min))) src.deposit_min = Number(snap.deposit_min);
    if (src.in_review === undefined && snap?.transfer_proof?.url) src.in_review = true;
    if (src.facility_name === undefined && src.facility?.name) src.facility_name = src.facility.name;
    if (src.starts_at && src.local_date === undefined) {
        const t = Date.parse(src.starts_at);
        if (Number.isFinite(t)) { // America/Bogota = UTC-5 todo el año (sin DST)
            const l = new Date(t - 5 * 3600_000).toISOString();
            src.local_date = l.slice(0, 10);
            src.local_start = l.slice(11, 16);
            if (src.ends_at && Number.isFinite(Date.parse(src.ends_at))) src.local_end = new Date(Date.parse(src.ends_at) - 5 * 3600_000).toISOString().slice(11, 16);
        }
    }
    const out: any = {};
    for (const k of GUEST_RESERVATION_FIELDS) if (src[k] !== undefined) out[k] = src[k];
    return out;
}

/** Token del enlace de estado: determinista (vence 14 días después del fin), así el replay devuelve lo mismo. */
function statusToken(rid: string, gid: string, endsAt: string): string {
    const exp = new Date(endsAt).getTime() + STATUS_LINK_TTL_MS;
    return signToken({ typ: 'r', gid, rid, exp, jti: linkJti(rid, gid) });
}

router.post('/', writeLimiter, requireIdempotencyKey, requireGuest, async (req: Request, res: Response) => {
    try {
        const guest = (req as any).guest as GuestRow;
        const parsed = ReserveSchema.safeParse(req.body);
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const b = parsed.data;

        const v = verifyGuestChannel(guest);
        if (!v.ok) return fail(res, v.status, v.message, { code: v.code, reason: v.code.toLowerCase() });

        const args: Record<string, unknown> = {
            p_facility_id: b.facility_id,
            p_starts_at: b.starts_at,
            p_ends_at: b.ends_at,
            p_channel: 'public',
            p_idempotency_key: req.idempotencyKey,
            p_payment_method: b.payment_method,
            p_guest_booker_id: guest.id,
        };
        if (b.participants !== undefined) args.p_participants = b.participants;
        if (b.notes !== undefined) args.p_notes = b.notes;
        if (b.external_org_name !== undefined) args.p_external_org_name = b.external_org_name;

        const { data, error } = await supabase.rpc('reservar_cancha', args);
        if (error) throw error;
        if (isRpcFailure(data)) {
            const t = translateRpcError(data);
            return res.status(t.status).json(t.body);
        }
        const r = (data as any).reservation;
        const token = r?.id && r?.ends_at ? statusToken(r.id, guest.id, r.ends_at) : undefined;
        return res.status((data as any).idempotent_replay ? 200 : 201).json({
            ...(data as any),
            reservation: r ? guestShape(r) : r,
            ...(token ? { status_token: token, status_path: `/r/${token}` } : {}),
        });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations create error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

// ── Enlace de estado /r/:token ───────────────────────────────────────────────
// El token (HMAC) identifica al invitado Y a la reserva. Se valida firma y
// vencimiento; las RPC reciben p_guest_booker_id y comprueban que sea el dueño.
function linkOr401(req: Request, res: Response): { gid: string; rid: string } | null {
    const p = verifyToken(req.params.token, 'r');
    if (!p || !p.rid) { fail(res, 401, 'Enlace inválido o vencido.', { reason: 'invalid_link' }); return null; }
    return { gid: p.gid, rid: p.rid };
}

router.get('/r/:token', readLimiter, async (req: Request, res: Response) => {
    try {
        const l = linkOr401(req, res);
        if (!l) return;
        const { data: r, error } = await conTimeout(supabase
            .from('facility_reservations')
            .select(GUEST_RESERVATION_COLUMNS)
            .eq('id', l.rid)
            .eq('guest_booker_id', l.gid)
            .maybeSingle());
        if (error) throw error;
        if (!r) return fail(res, 404, 'Reserva no encontrada.');
        return res.json({ reservation: guestShape(r) });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations link get error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

const CancelSchema = z.strictObject({ reason: reasonField.optional() });

router.post('/r/:token/cancel', writeLimiter, async (req: Request, res: Response) => {
    try {
        const l = linkOr401(req, res);
        if (!l) return;
        const parsed = CancelSchema.safeParse(req.body ?? {});
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        const args: Record<string, unknown> = { p_reservation_id: l.rid, p_guest_booker_id: l.gid };
        if (parsed.data.reason) args.p_reason = parsed.data.reason;
        const { data, error } = await supabase.rpc('cancelar_reserva', args);
        if (error) throw error;
        if (isRpcFailure(data)) {
            const t = translateRpcError(data);
            return res.status(t.status).json(t.body);
        }
        const d: any = data;
        return res.json({ ...d, reservation: d.reservation ? guestShape(d.reservation) : d.reservation });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations link cancel error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

const RescheduleSchema = z.strictObject({ starts_at: iso, ends_at: iso })
    .refine(rangeRefine, rangeMsg).refine(durationRefine, durationMsg);

router.post('/r/:token/reschedule', writeLimiter, async (req: Request, res: Response) => {
    try {
        const l = linkOr401(req, res);
        if (!l) return;
        const parsed = RescheduleSchema.safeParse(req.body);
        if (!parsed.success) return zodBadRequest(res, parsed.error.issues);
        // facility_id no se acepta: cambiar de cancha es solo del staff.
        const { data, error } = await supabase.rpc('reprogramar_reserva', {
            p_reservation_id: l.rid, p_new_starts_at: parsed.data.starts_at, p_new_ends_at: parsed.data.ends_at, p_guest_booker_id: l.gid,
        });
        if (error) throw error;
        if (isRpcFailure(data)) {
            const t = translateRpcError(data);
            return res.status(t.status).json(t.body);
        }
        const d: any = data;
        return res.json({ ...d, reservation: d.reservation ? guestShape(d.reservation) : d.reservation });
    } catch (err: any) {
        req.log?.error({ err }, 'public-reservations link reschedule error');
        return fail(res, 500, 'Error interno del servidor.');
    }
});

export default router;
