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
    'id, school_id, facility_id, user_id, guest_booker_id, status, payment_status, price, amount_paid, hold_expires_at, price_snapshot, payment_reference, min_deposit_pct';

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
        const snap = (reserva.price_snapshot && typeof reserva.price_snapshot === 'object') ? { ...reserva.price_snapshot } : {};
        const previos: number[] = Array.isArray(snap.checkout_amounts) ? snap.checkout_amounts.map(Number) : [];
        snap.checkout_amounts = [...new Set([...previos, amount])].slice(-MAX_CHECKOUT_AMOUNTS);
        snap.checkout = { provider: resolved.provider, amount, reference, expires_at: expiresAt, created_at: new Date().toISOString() };
        const { error: persistErr } = await supabase
            .from('facility_reservations')
            .update({ price_snapshot: snap })
            .eq('id', reserva.id)
            .eq('status', 'pending_payment');
        if (persistErr) {
            req.log?.error({ err: persistErr.message, reservationId: reserva.id }, 'reservations checkout: no se pudo registrar el monto');
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
        const baseApi = process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.get('host')}`;
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

/** Solo se acepta un archivo que YA está en nuestro Storage (no una URL arbitraria). */
export function esUrlDeComprobanteValida(raw: unknown): raw is string {
    if (typeof raw !== 'string' || raw.length > 1000) return false;
    const base = String(process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    if (!base) return false;
    return raw.startsWith(`${base}/storage/v1/object/`);
}

router.post('/:id/transfer-proof', authSesionOInvitado, async (req: Request, res: Response) => {
    try {
        const cargada = await cargarReservaAutorizada(req);
        if (!cargada) return res.status(404).json({ error: 'reservation_not_found' });
        const { reserva } = cargada;

        const proofParsed = TransferProofBodySchema.safeParse(req.body ?? {});
        if (!proofParsed.success) return zodBadRequest(res, proofParsed.error.issues);
        const proofUrl = proofParsed.data.proof_url;
        if (!esUrlDeComprobanteValida(proofUrl)) {
            return res.status(400).json({ error: 'invalid_proof_url' });
        }
        if (reserva.status !== 'pending_payment') {
            return res.status(409).json({ error: 'reservation_not_payable', status: reserva.status });
        }
        // Con el hold vencido la franja ya pudo tomarla otra persona: no se alarga a ciegas.
        if (!holdVigente(reserva, 0)) {
            return res.status(409).json({ error: 'hold_expired', message: 'El tiempo para esta reserva se agotó. Vuelve a reservar.' });
        }

        const snap = (reserva.price_snapshot && typeof reserva.price_snapshot === 'object') ? { ...reserva.price_snapshot } : {};
        const yaAlargado = !!snap.transfer_proof?.hold_extended;
        const nuevoHold = new Date(Date.now() + TRANSFER_REVIEW_HOLD_MIN * 60 * 1000).toISOString();
        snap.transfer_proof = {
            url: proofUrl,
            submitted_at: new Date().toISOString(),
            hold_extended: true,
        };

        const cambios: Record<string, unknown> = { price_snapshot: snap };
        // Se alarga UNA sola vez: subir comprobantes en cadena no debe congelar la cancha para siempre.
        if (!yaAlargado) cambios.hold_expires_at = nuevoHold;

        const { data: upd, error: updErr } = await supabase
            .from('facility_reservations')
            .update(cambios)
            .eq('id', reserva.id)
            .eq('status', 'pending_payment')
            .gt('hold_expires_at', new Date().toISOString())
            .select('id, hold_expires_at');
        if (updErr) {
            req.log?.error({ err: updErr.message, reservationId: reserva.id }, 'transfer-proof update failed');
            return res.status(500).json({ error: 'transfer_proof_failed' });
        }
        if (!upd || (Array.isArray(upd) && upd.length === 0)) {
            // Perdió la carrera contra expirar_holds o un pago.
            return res.status(409).json({ error: 'hold_expired' });
        }

        await alertarAdminsDeReserva({
            schoolId: reserva.school_id,
            reservationId: reserva.id,
            tipo: 'reservation_transfer_proof',
            titulo: 'Comprobante de reserva por revisar',
            mensaje: 'Llegó un comprobante de transferencia de una reserva de cancha. Revísalo y confírmalo; la franja queda apartada mientras tanto.',
            log: req.log,
        });

        const holdFinal = (Array.isArray(upd) ? (upd[0] as any)?.hold_expires_at : null) ?? (yaAlargado ? reserva.hold_expires_at : nuevoHold);
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
