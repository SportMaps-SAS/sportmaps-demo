/**
 * reservation-payments — lado «webhook» del cobro de reservas de canchas (F2).
 *
 * Contrato: docs/specs/reservas-canchas-f1-contrato.md §3 (payment_reference
 * 'RSV-…') y §6 (confirmar_pago_reserva). Lo llaman el webhook de Wompi y el de
 * MercadoPago desde su router por prefijo (rama 'RSV'), con la transacción YA
 * verificada (checksum/firma con las llaves de LA ESCUELA + re-consulta a la
 * pasarela). Acá no se vuelve a validar la firma: se valida lo que solo el
 * servidor sabe — que el monto aprobado cuadre con la reserva.
 *
 * Reglas:
 *  - La plata es de la escuela (payment_mode 'direct'): SportMaps nunca la recibe
 *    ni la mueve. Este módulo solo APLICA el pago a la reserva.
 *  - Monto: > 0, COP, ≤ saldo (price − amount_paid) y, si el checkout registró los
 *    montos que ofreció (price_snapshot.checkout_amounts), igual a uno de ellos.
 *    Si no cuadra NO se llama la RPC: se avisa al admin (la plata llegó a SU
 *    cuenta y hay que conciliarla a mano) y se responde 200 (reintentar no sirve).
 *  - Idempotencia: p_provider_event_id = «<proveedor>:<id de la transacción>».
 *  - reconciliation:true → alerta al admin; el pago nunca se pierde (lo guarda la RPC).
 *  - Solo un error transitorio real (la RPC falla) devuelve 500 para que la pasarela
 *    reintente y el cron de reproceso lo recoja.
 */

import type { Logger } from 'pino';
import { supabase } from '../config/supabase';
import { writeAudit } from '../utils/auditWrite';
import { sanitizeFreeText } from '../utils/sanitize';

export type ReservationProvider = 'wompi' | 'mercadopago';

export interface ReservationPaymentResult {
    status: number;
    body: Record<string, unknown>;
}

/** RSV-<16 hex> y, para pagos posteriores al primero, un sufijo opcional (RSV-…-2). */
export const RSV_REFERENCE_RE = /^RSV-[A-Z0-9]{16}(?:-[A-Z0-9]{1,12})?$/i;

/**
 * Referencia base (= facility_reservations.payment_reference) o null si el formato
 * no es el nuestro. Filtra por formato ANTES de usarla en una query.
 */
export function baseReservationReference(reference: string | null | undefined): string | null {
    const ref = String(reference ?? '').trim();
    if (!RSV_REFERENCE_RE.test(ref)) return null;
    return ref.split('-').slice(0, 2).join('-');
}

const RESERVATION_COLUMNS =
    'id, school_id, facility_id, user_id, guest_booker_id, status, payment_status, price, amount_paid, hold_expires_at, price_snapshot, payment_reference, min_deposit_pct';

export async function findReservationByReference(reference: string): Promise<Record<string, any> | null> {
    const base = baseReservationReference(reference);
    if (!base) return null;
    const { data, error } = await supabase
        .from('facility_reservations')
        .select(RESERVATION_COLUMNS)
        .eq('payment_reference', base)
        .maybeSingle();
    if (error) return null;
    return (data as Record<string, any> | null) ?? null;
}

/** school_id dueño de una referencia RSV (para elegir las llaves/secreto de ESA escuela). */
export async function schoolIdForReservationReference(reference: string): Promise<string | null> {
    const row = await findReservationByReference(reference);
    return (row?.school_id as string | undefined) ?? null;
}

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/** Saldo por cobrar en COP enteros. */
export function saldoDeReserva(r: { price?: unknown; amount_paid?: unknown }): number {
    const price = Number(r.price) || 0;
    const paid = Number(r.amount_paid) || 0;
    return Math.max(0, Math.round(price - paid));
}

/** Piso práctico de las pasarelas colombianas (Wompi pide ≥ 1.500 COP). */
const MONTO_MINIMO_PASARELA = 1500;

/** Abono mínimo que se le puede pedir hoy. Nunca más que el saldo. */
export function abonoMinimoDeReserva(r: {
    price?: unknown; amount_paid?: unknown; price_snapshot?: any; min_deposit_pct?: unknown;
}): number {
    const price = Number(r.price) || 0;
    const snap = Number(r.price_snapshot?.deposit_min);
    const pct = Number(r.min_deposit_pct);
    const depositMin = Number.isFinite(snap) && snap >= 0
        ? snap
        : Number.isFinite(pct) ? Math.ceil((price * pct) / 100) : price;
    const faltaParaAbono = Math.max(MONTO_MINIMO_PASARELA, Math.round(depositMin - (Number(r.amount_paid) || 0)));
    return Math.min(faltaParaAbono, Math.max(1, saldoDeReserva(r)));
}

// ─── Avisos (INSERT en notifications con service_role, nunca notify_user) ────

/** Dueño + admins activos de la escuela. Sin duplicados. */
export async function adminsDeLaEscuela(schoolId: string): Promise<string[]> {
    const ids = new Set<string>();
    try {
        const { data: school } = await supabase.from('schools').select('owner_id').eq('id', schoolId).maybeSingle();
        if ((school as any)?.owner_id) ids.add((school as any).owner_id);
        const { data: members } = await supabase
            .from('school_members')
            .select('profile_id')
            .eq('school_id', schoolId)
            .eq('status', 'active')
            // QA T1: faltaba 'school_admin' (el rol real de los administradores): nunca recibían las alertas de conciliación.
            .in('role', ['owner', 'admin', 'school_admin']);
        for (const m of (members as any[] | null) ?? []) if (m?.profile_id) ids.add(m.profile_id);
    } catch {
        /* best-effort: si falla la lectura el log del webhook igual deja rastro */
    }
    return [...ids];
}

/** Aviso interno a admins de la escuela. Best-effort: jamás tumba el webhook. */
export async function alertarAdminsDeReserva(args: {
    schoolId: string;
    reservationId: string;
    titulo: string;
    mensaje: string;
    tipo: string;
    log?: Logger;
}): Promise<void> {
    try {
        const admins = await adminsDeLaEscuela(args.schoolId);
        if (admins.length === 0) {
            args.log?.warn({ schoolId: args.schoolId, reservationId: args.reservationId }, 'RSV alert: school without admins to notify');
            return;
        }
        for (const userId of admins) {
            const { error } = await supabase.from('notifications').insert({
                user_id: userId,
                school_id: args.schoolId,
                category: 'payment',
                type: args.tipo,
                title: args.titulo,
                message: args.mensaje,
                link: '/facilities',
                data: { reservation_id: args.reservationId },
            });
            if (error) args.log?.warn({ err: error.message, userId }, 'RSV alert insert failed (non-blocking)');
        }
    } catch (e: any) {
        args.log?.warn({ err: e?.message }, 'RSV alert failed (non-blocking)');
    }
}

/** Aviso a quien reservó (si tiene cuenta; el invitado se avisa por WhatsApp/correo aparte). */
export async function notificarReservaConfirmada(reservation: Record<string, any>, log?: Logger): Promise<void> {
    try {
        if (!reservation?.user_id) return; // invitado: sin notificación in-app
        const r = reservation;
        const startsAt = r.starts_at ? new Date(r.starts_at) : null;
        const dateLabel = r.local_date
            ? new Date(`${r.local_date}T00:00:00`).toLocaleDateString('es-CO', { weekday: 'long', day: '2-digit', month: 'long' })
            : startsAt
                ? startsAt.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long', day: '2-digit', month: 'long' })
                : '';
        const hora = r.local_start ? ` a las ${String(r.local_start).substring(0, 5)}` : '';
        await supabase.from('notifications').insert({
            user_id: r.user_id,
            school_id: r.school_id ?? null,
            category: 'payment',
            type: 'booking_confirmed',
            title: 'Reserva de cancha confirmada',
            message: `Tu reserva${r.facility_name ? ` de ${sanitizeFreeText(r.facility_name, { max: 120 })}` : ''}${dateLabel ? ` quedó confirmada para el ${dateLabel}` : ' quedó confirmada'}${hora}.`,
            link: '/facilities',
            data: { reservation_id: r.id },
        });
    } catch (e: any) {
        log?.warn({ err: e?.message }, 'RSV booker notification failed (non-blocking)');
    }
}

async function notificarAbonoRecibido(reservation: Record<string, any>, falta: number, log?: Logger): Promise<void> {
    try {
        if (!reservation?.user_id) return;
        await supabase.from('notifications').insert({
            user_id: reservation.user_id,
            school_id: reservation.school_id ?? null,
            category: 'payment',
            type: 'payment_received',
            title: 'Recibimos tu abono',
            message: `Recibimos tu pago. Para confirmar la cancha todavía faltan ${cop(falta)} del abono mínimo.`,
            link: '/facilities',
            data: { reservation_id: reservation.id },
        });
    } catch (e: any) {
        log?.warn({ err: e?.message }, 'RSV partial notification failed (non-blocking)');
    }
}

// ─── Validación de monto ─────────────────────────────────────────────────────

export type MontoVeredicto = { ok: true } | { ok: false; reason: string; detail: string };

export function validarMontoDeReserva(
    reserva: { price?: unknown; amount_paid?: unknown; price_snapshot?: any; min_deposit_pct?: unknown },
    amountCop: number,
    currency: string,
): MontoVeredicto {
    if ((currency || '').toUpperCase() !== 'COP') {
        return { ok: false, reason: 'unsupported_currency', detail: `moneda ${currency || '(vacía)'}` };
    }
    if (!Number.isFinite(amountCop) || amountCop <= 0) {
        return { ok: false, reason: 'amount_invalid', detail: `monto ${amountCop}` };
    }
    const saldo = saldoDeReserva(reserva);
    if (amountCop > saldo + 1) {
        return { ok: false, reason: 'amount_exceeds_balance', detail: `pagó ${cop(amountCop)}; saldo ${cop(saldo)}` };
    }
    const ofrecidos: number[] = Array.isArray(reserva.price_snapshot?.checkout_amounts)
        ? reserva.price_snapshot.checkout_amounts.map(Number).filter((n: number) => Number.isFinite(n))
        : [];
    if (ofrecidos.length > 0) {
        if (!ofrecidos.some(a => Math.abs(a - amountCop) <= 1)) {
            return { ok: false, reason: 'amount_mismatch', detail: `pagó ${cop(amountCop)}; se ofrecieron ${ofrecidos.map(cop).join(', ')}` };
        }
        return { ok: true };
    }
    // Sin montos registrados (link generado fuera de este flujo): se exige al menos el abono mínimo vigente.
    const minimo = abonoMinimoDeReserva(reserva);
    if (amountCop + 1 < minimo) {
        return { ok: false, reason: 'amount_below_deposit', detail: `pagó ${cop(amountCop)}; abono mínimo ${cop(minimo)}` };
    }
    return { ok: true };
}

// ─── Aplicar el pago ─────────────────────────────────────────────────────────

export interface ApplyReservationPaymentInput {
    provider: ReservationProvider;
    /** Referencia tal cual la devolvió la pasarela (RSV-… con o sin sufijo). */
    reference: string;
    /** Estado interno ya mapeado: 'paid' | 'rejected' | 'refunded' | 'failed' | 'pending'. */
    internalStatus: string;
    /** Monto aprobado en COP (no centavos). */
    amountCop: number;
    currency: string;
    /** Id de la transacción/pago en la pasarela (clave de idempotencia). */
    eventId: string;
    log?: Logger;
}

export async function applyReservationPayment(input: ApplyReservationPaymentInput): Promise<ReservationPaymentResult> {
    const { provider, reference, internalStatus, amountCop, currency, eventId, log } = input;

    const reserva = await findReservationByReference(reference);
    if (!reserva) {
        log?.warn({ reference, provider }, 'RSV payment: reservation not found');
        return { status: 200, body: { status: 'ignored', reason: 'reservation_not_found' } };
    }

    const providerEventId = `${provider}:${eventId}`;
    const schoolId = reserva.school_id as string;

    // Estados que no mueven plata: la reserva sigue su curso (el hold vence solo).
    if (internalStatus !== 'paid') {
        if (internalStatus === 'refunded') {
            await alertarAdminsDeReserva({
                schoolId, reservationId: reserva.id, tipo: 'reservation_payment_voided',
                titulo: 'Pago de reserva anulado en la pasarela',
                mensaje: `La pasarela anuló un pago de una reserva de cancha (${provider}, tx ${eventId}). Revísala: puede que ya no esté pagada.`,
                log,
            });
        }
        return { status: 200, body: { status: 'ok', kind: 'reservation', internalStatus, applied: false } };
    }

    // Reentrega del mismo evento ya aplicado (reproceso, doble webhook): no se revalida contra el saldo.
    const yaAplicados: string[] = Array.isArray(reserva.price_snapshot?.payment_events) ? reserva.price_snapshot.payment_events : [];
    if (yaAplicados.includes(providerEventId)) {
        return { status: 200, body: { status: 'already_processed', kind: 'reservation' } };
    }

    const veredicto = validarMontoDeReserva(reserva, amountCop, currency);
    if (!veredicto.ok) {
        log?.error({ reference, provider, eventId, amountCop, reason: veredicto.reason }, 'RSV payment rejected: amount does not match');
        await alertarAdminsDeReserva({
            schoolId, reservationId: reserva.id, tipo: 'reservation_payment_rejected',
            titulo: 'Pago de reserva que no cuadra',
            mensaje: `Entró un pago por ${provider} que NO se aplicó a la reserva (${veredicto.detail}). El dinero está en tu cuenta de la pasarela (tx ${eventId}): revísalo y devuélvelo o concílialo a mano.`,
            log,
        });
        return { status: 200, body: { status: 'rejected', kind: 'reservation', reason: veredicto.reason } };
    }

    const { data, error } = await supabase.rpc('confirmar_pago_reserva', {
        p_reference: reserva.payment_reference,
        p_amount: Math.round(amountCop),
        p_payment_id: null,
        p_provider: provider,
        p_provider_event_id: providerEventId,
    });
    if (error) {
        log?.error({ err: error.message, reference }, 'confirmar_pago_reserva failed');
        return { status: 500, body: { error: 'confirmar_pago_reserva_failed' } };
    }

    const result = (data ?? {}) as Record<string, any>;
    if (result.ok === false) {
        const code = String(result.error ?? 'UNKNOWN');
        if (code === 'RESERVATION_NOT_FOUND') {
            return { status: 200, body: { status: 'ignored', reason: 'reservation_not_found' } };
        }
        log?.error({ reference, code }, 'confirmar_pago_reserva returned a business error');
        await alertarAdminsDeReserva({
            schoolId, reservationId: reserva.id, tipo: 'reservation_payment_rejected',
            titulo: 'Pago de reserva sin aplicar',
            mensaje: `La base rechazó aplicar un pago (${code}). El dinero está en tu cuenta de la pasarela (${provider}, tx ${eventId}): revísalo a mano.`,
            log,
        });
        return { status: 200, body: { status: 'rejected', kind: 'reservation', reason: code.toLowerCase() } };
    }

    if (result.already_processed) {
        return { status: 200, body: { status: 'already_processed', kind: 'reservation' } };
    }

    if (result.reconciliation) {
        await writeAudit({ schoolId, log }, 'reservation_reconciliation', 'facility_reservations', String(reserva.id),
            { status: reserva.status, amount_paid: reserva.amount_paid }, { amount: Math.round(amountCop), provider, provider_event_id: providerEventId });
        await alertarAdminsDeReserva({
            schoolId, reservationId: reserva.id, tipo: 'reservation_reconciliation',
            titulo: 'Pago de reserva sin cancha: hay que devolver o dejar saldo a favor',
            mensaje: `Llegó un pago de ${cop(amountCop)} (${provider}) para una reserva que ya no tiene la franja (venció, se canceló o la tomó otra persona). El pago quedó registrado y la reserva en «pendiente de conciliación»: devuélvelo o déjalo como saldo a favor.`,
            log,
        });
        return { status: 200, body: { status: 'ok', kind: 'reservation', reconciliation: true } };
    }

    if (result.confirmed) {
        await writeAudit({ schoolId, log }, 'reservation_payment_confirmed', 'facility_reservations', String(reserva.id),
            { status: reserva.status, amount_paid: reserva.amount_paid }, { amount: Math.round(amountCop), provider, provider_event_id: providerEventId });
        await notificarReservaConfirmada({ ...(result.reservation ?? {}), id: reserva.id, user_id: reserva.user_id, school_id: schoolId }, log);
        return { status: 200, body: { status: 'ok', kind: 'reservation', confirmed: true } };
    }

    // Abono recibido pero no alcanza el mínimo (DEPOSIT_NOT_REACHED): sigue pending_payment.
    const falta = Math.max(0, abonoMinimoDeReserva({ ...reserva, amount_paid: Number(reserva.amount_paid || 0) + amountCop }));
    await notificarAbonoRecibido(reserva, falta, log);
    return { status: 200, body: { status: 'ok', kind: 'reservation', confirmed: false, reason: result.reason ?? null } };
}
