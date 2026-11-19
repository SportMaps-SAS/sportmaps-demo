/**
 * wompi — Webhook unificado de Wompi (Colombia).
 *
 * Endpoint: POST /api/v1/webhooks/wompi/webhook
 *   (montado en /api/v1/webhooks/wompi + router.post('/webhook'). El sufijo /webhook NO
 *   es opcional: sin él, el catch-all de auth responde 401 "Token de autorización
 *   requerido" — no 404 —, así que una URL mal configurada en el dashboard de Wompi falla
 *   de forma silenciosa y los eventos nunca se reconcilian.)
 *
 * Wompi envia evento `transaction.updated` cuando una transaccion cambia de estado.
 * Este webhook reconcilia segun el prefijo de la `reference`:
 *   SCH-*   → payment de escuela (paga payments + payment_links + crea split)
 *   SVC-*   → cita de servicio   (RPC confirm_marketplace_payment)
 *   EVT-*   → inscripcion evento (idem)
 *   SUB-*   → suscripcion        (idem)
 *   MKT-*   → marketplace_pay    (idem)
 *   CART-*  → orden del shop     (descuenta stock atomico + cambia status)
 *
 * Seguridad:
 *  - Valida checksum SHA256 con el events_secret del comercio dueño de la referencia
 *    (multi-tenant): se resuelve la escuela por payment_links y se usan SUS credenciales.
 *    CART-* (tienda v2 F0, D-5 = A): SIEMPRE las llaves del vendedor de la orden
 *    (orders.seller_gateway_id); si no se pueden resolver, 503 y NO se cae a ENV.
 *    El resto sin escuela cae a WOMPI_EVENTS_SECRET (legacy).
 *  - Idempotencia por wompi_transaction_id (insercion unica).
 *  - Re-consulta el estado a Wompi para evitar webhook spoofing.
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { findStoreOrderByReference, sellerWompiCredsForOrder, amountMatchesOrder } from '../services/store-checkout';
import {
    validateWebhookChecksum,
    fetchTransaction,
    mapWompiStatus,
    centsToCop,
    createPaymentSource,
    wompiCredsFrom,
    type WompiCreds,
} from '../services/wompi.service';
import { resolveProvider } from '../services/payment-provider.resolver';
import {
    recordWebhookEvent,
    markWebhookProcessed,
    markWebhookOrphan,
    markWebhookFailed,
    markWebhookIgnored,
} from '../services/webhook-events.service';
import {
    applyReservationPayment,
    baseReservationReference,
    schoolIdForReservationReference,
} from '../services/reservation-payments.service';

const router = Router();

/** Formato de las referencias que emitimos: PREFIJO-BASE36-HEX. Nada más entra a la query. */
const SAFE_REFERENCE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

import {
    bankMessageFrom,
    buildFailureReason,
    conciliarMontoRecibido,
    motivoPagoParcial,
    aplicarPagoDeEscuela,
    type ConciliacionMonto,
} from '../services/pagos-escuela.core';
import { politicaWompi } from '../services/pasarelas/wompi';

// Estos helpers vivían aquí; se movieron al núcleo común y se re-exportan para no
// romper a quien los importa de './wompi' (mercadopago.ts, pruebas).
export { bankMessageFrom, buildFailureReason, conciliarMontoRecibido, motivoPagoParcial };
export type { ConciliacionMonto };

/**
 * Resuelve las credenciales Wompi del comercio dueño de una referencia.
 *
 * Necesario para escuelas con cuenta propia (payment_mode='direct'): cada una tiene su
 * events_secret, así que el checksum del webhook debe validarse con el de ESA escuela.
 * Para la escuela en 'aggregator' el resolver devuelve las llaves de ENV, o sea el mismo
 * comportamiento de antes sin ramas especiales.
 *
 * Devuelve null si la referencia no es de una escuela (marketplace) o no se encuentra;
 * el caller cae entonces a las llaves globales, que es el comportamiento legacy.
 */
async function credsForReference(reference: string): Promise<WompiCreds | null> {
    // La referencia viene del body sin validar todavía, así que se filtra por formato
    // antes de usarla en una query (PostgREST interpola los filtros como texto).
    // Reservas de canchas (RSV-<16 hex>[-n]): formato propio (solo 2 segmentos), la
    // escuela sale de facility_reservations.payment_reference. SIN esto la referencia
    // no pasa SAFE_REFERENCE, caería a las llaves globales y el checksum de una
    // escuela con cuenta propia ('direct') nunca validaría.
    if (reference.startsWith('RSV-')) {
        if (!baseReservationReference(reference)) return null;
        const rsvSchool = await schoolIdForReservationReference(reference);
        if (!rsvSchool) return null;
        const resolvedRsv = await resolveProvider({ schoolId: rsvSchool, preferredProvider: 'wompi' });
        return wompiCredsFrom(resolvedRsv);
    }

    if (!reference || !SAFE_REFERENCE.test(reference)) return null;

    // Tienda: el vendedor cobró con SUS llaves → se valida con las suyas.
    if (reference.startsWith('CART-')) {
        const order = await findStoreOrderByReference(reference);
        return order ? sellerWompiCredsForOrder(order) : null;
    }

    let schoolId: string | null = null;
    for (const col of ['provider_reference', 'wompi_reference'] as const) {
        const { data } = await supabase
            .from('payment_links')
            .select('school_id')
            .eq(col, reference)
            .maybeSingle();
        if ((data as any)?.school_id) {
            schoolId = (data as any).school_id;
            break;
        }
    }
    if (!schoolId) return null;

    const resolved = await resolveProvider({ schoolId, preferredProvider: 'wompi' });
    return wompiCredsFrom(resolved);
}

router.post('/webhook', async (req: Request, res: Response) => {
    try {
        const body = req.body;
        const { event } = body;

        req.log?.info({ event }, 'Wompi webhook received');

        // 1. Validar checksum con el events_secret del comercio dueño de la referencia.
        //
        //    La referencia se lee del body ANTES de validar la firma, para saber con qué
        //    secreto validar. Es seguro: elegir el secreto no concede nada — quien manda el
        //    evento igual tiene que producir un checksum válido para ESE secreto, y más
        //    abajo la referencia se vuelve a atar a su escuela y se re-consulta la
        //    transacción contra la API de Wompi.
        const refFromBody: string = body?.data?.transaction?.reference || '';
        const creds = await credsForReference(refFromBody);

        // Tienda (CART-*): sin las llaves del vendedor no hay con qué verificar, y
        // caer a las globales es justo lo que D-5 = A prohíbe. 503 → Wompi reintenta.
        if (refFromBody.startsWith('CART-') && !creds) {
            req.log?.warn({ reference: refFromBody }, 'Wompi webhook: store order without resolvable seller gateway');
            return res.status(503).json({ error: 'seller_gateway_unavailable' });
        }

        if (!validateWebhookChecksum(body, creds ?? undefined)) {
            req.log?.warn(
                { reference: refFromBody, perSchoolCreds: !!creds },
                'Wompi webhook checksum mismatch',
            );
            return res.status(401).json({ error: 'Invalid checksum' });
        }

        if (event !== 'transaction.updated') {
            return res.status(200).json({ status: 'ignored', event });
        }

        const transaction = body?.data?.transaction || {};
        const txId: string = transaction.id || '';
        const txStatus: string = transaction.status || '';
        const txReference: string = transaction.reference || '';
        const txAmountCents: number = Number(transaction.amount_in_cents || 0);

        if (!txId || !txReference) {
            req.log?.warn('Wompi webhook missing transaction id or reference');
            return res.status(400).json({ error: 'Invalid payload' });
        }

        // 2. Re-consultar a Wompi (defensa anti-spoofing). Con las credenciales del mismo
        //    comercio: define sandbox vs producción, que puede diferir por escuela.
        const realTx = await fetchTransaction(txId, creds ?? undefined);
        if (!realTx) {
            req.log?.warn({ txId }, 'Wompi webhook: cannot fetch transaction from Wompi');
            return res.status(400).json({ error: 'Cannot verify transaction' });
        }

        if (realTx.status !== txStatus || realTx.reference !== txReference) {
            req.log?.warn(
                { webhook: { txStatus, txReference }, real: { status: realTx.status, reference: realTx.reference } },
                'Wompi webhook: data mismatch with Wompi API',
            );
            return res.status(400).json({ error: 'Webhook data mismatch' });
        }

        // Solo COP soportado. Cualquier otra moneda indica config errada o spoofing.
        if (realTx.currency !== 'COP') {
            req.log?.error({ currency: realTx.currency, txReference }, 'Wompi webhook: unsupported currency');
            return res.status(400).json({ error: 'Unsupported currency' });
        }

        const internalStatus = mapWompiStatus(realTx.status);

        // 2.b Dedup + log persistente del evento (H-03/H-04). event_id estable
        // por (txId, status): deduplica el mismo update y a la vez permite
        // registrar transiciones de estado distintas de la misma tx.
        const { firstSeen, id: eventLogId } = await recordWebhookEvent({
            provider: 'wompi',
            eventId: `${txId}:${realTx.status}`,
            reference: txReference,
            eventType: event,
            payload: body,
        });
        if (!firstSeen) {
            return res.status(200).json({ status: 'already_processed', dedup: 'webhook_events' });
        }

        // 3. Rutear al handler segun prefijo (logica compartida con el reproceso).
        const routed = await routeWompiTransaction({ realTx, body, log: req.log });

        // Estado del evento segun el resultado:
        //  - prefijo desconocido -> ignored.
        //  - entidad local aun inexistente (*_not_found) -> orphan (reprocesar,
        //    NO perder el evento; antes se respondia 200 ignored sin retry).
        //  - fallo del handler (>=500) -> failed (reintento).
        //  - resto -> processed.
        if (!routed.handled) {
            req.log?.warn({ txReference }, 'Wompi webhook: unknown reference prefix');
            await markWebhookIgnored(eventLogId, String(routed.body?.reason ?? 'unknown_prefix'));
        } else {
            const reason = typeof routed.body?.reason === 'string' ? routed.body.reason : '';
            if (reason.endsWith('_not_found')) {
                await markWebhookOrphan(eventLogId, reason);
            } else if (routed.status >= 500) {
                await markWebhookFailed(eventLogId, `handler_status_${routed.status}`);
            } else {
                await markWebhookProcessed(eventLogId);
            }
        }

        // Captura de token: si la tx fue APPROVED y Wompi devolvio un token reusable,
        // intentar persistirlo si el user existe.
        if (internalStatus === 'paid') {
            await maybeCaptureToken(req, realTx, txReference, creds ?? undefined);
        }

        return res.status(routed.status).json(routed.body);
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'Unexpected error in Wompi webhook');
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// ─── Handlers por tipo de transaccion ──────────────────────────────────────

interface HandlerArgs {
    req: Request;
    txId: string;
    txReference: string;
    txStatus: string;
    internalStatus: ReturnType<typeof mapWompiStatus>;
    txAmountCop: number;
    paymentMethodType: string;
    rawTransaction: any;        // tx completo de Wompi (incluye payment_method.token)
}

interface HandlerResult {
    status: number;
    body: Record<string, unknown>;
}

const HANDLERS: Record<string, (args: HandlerArgs) => Promise<HandlerResult>> = {
    SCH: handleSchoolPayment,
    SVC: handleMarketplaceTransaction,
    EVT: handleMarketplaceTransaction,
    SUB: handleMarketplaceTransaction,
    MKT: handleMarketplaceTransaction,
    CART: handleCartOrder,
    BKG: handleSessionBooking,
    RSV: handleReservation,
};

/**
 * Rutea una transaccion Wompi (ya validada/refetcheada) al handler que
 * corresponde por prefijo de reference. Compartido por el webhook en vivo y
 * por el cron de reproceso de huerfanos (webhook-reprocess.service).
 *
 * `handled=false` => prefijo desconocido (no hay entidad que tocar).
 * No hace dedup ni token-capture: eso es responsabilidad del caller.
 */
export interface WompiRouteInput {
    realTx: any;
    body?: any;
    log?: Request['log'];
}

export async function routeWompiTransaction(
    input: WompiRouteInput,
): Promise<{ status: number; body: Record<string, unknown>; handled: boolean }> {
    const { realTx } = input;
    const txId: string = realTx?.id || '';
    const txReference: string = realTx?.reference || '';
    const internalStatus = mapWompiStatus(realTx.status);
    const txAmountCop = centsToCop(realTx.amount_in_cents);

    const prefix = txReference.split('-')[0];
    const handler = HANDLERS[prefix];
    if (!handler) {
        return { status: 200, body: { status: 'ignored', reason: 'unknown_prefix', prefix }, handled: false };
    }

    // Los handlers solo usan req.log?.*, asi que basta un shim con el logger.
    const req = { log: input.log } as unknown as Request;
    const result = await handler({
        req,
        txId,
        txReference,
        txStatus: realTx.status,
        internalStatus,
        txAmountCop,
        paymentMethodType: realTx.payment_method_type,
        rawTransaction: realTx,
    });
    return { status: result.status, body: result.body, handled: true };
}

// ─── SCH: pagos de escuela ─────────────────────────────────────────────────

async function handleSchoolPayment({
    req, txId, txReference, internalStatus, txAmountCop, paymentMethodType, rawTransaction,
}: HandlerArgs): Promise<HandlerResult> {
    // La lógica vive en el núcleo común (services/pagos-escuela.core.ts); lo propio de
    // Wompi, en su política (services/pasarelas/wompi.ts).
    return aplicarPagoDeEscuela(politicaWompi, {
        log: req.log,
        txId,
        referencia: txReference,
        internalStatus,
        monto: txAmountCop,
        tipoMedio: paymentMethodType,
        crudo: rawTransaction,
    });
}

// ─── SVC/EVT/SUB/MKT: marketplace_transactions ─────────────────────────────

async function handleMarketplaceTransaction({
    req, txId, txReference, internalStatus, txAmountCop,
}: HandlerArgs): Promise<HandlerResult> {
    // 1. Buscar transaction
    const { data: tx, error: txErr } = await supabase
        .from('marketplace_transactions')
        .select('id, gross_amount, status, wompi_transaction_id')
        .eq('wompi_reference', txReference)
        .maybeSingle();

    if (txErr || !tx) {
        req.log?.warn({ txReference }, 'Marketplace tx not found');
        return { status: 200, body: { status: 'ignored', reason: 'tx_not_found' } };
    }

    // 2. Idempotencia
    if (tx.wompi_transaction_id === txId && tx.status !== 'pending') {
        return { status: 200, body: { status: 'already_processed' } };
    }

    if (internalStatus === 'paid') {
        // 3. Verificar monto
        if (Math.abs(txAmountCop - Number(tx.gross_amount)) > 1) {
            req.log?.error(
                { expected: tx.gross_amount, received: txAmountCop, txReference },
                'Marketplace tx: amount mismatch',
            );
            return { status: 400, body: { error: 'Amount mismatch' } };
        }

        // 4. Confirmar via RPC unificada
        const { data: result, error } = await supabase.rpc('confirm_marketplace_payment', {
            p_transaction_id: tx.id,
            p_wompi_reference: txReference,
            p_wompi_transaction_id: txId,
            p_payment_method: 'wompi',
        });

        if (error) {
            req.log?.error({ err: error, txReference }, 'confirm_marketplace_payment failed');
            return { status: 500, body: { error: 'Confirm RPC failed' } };
        }

        req.log?.info({ txId: tx.id, txReference }, 'Marketplace tx confirmed');
        return { status: 200, body: { status: 'ok', kind: 'marketplace', result } };
    }

    // Failed/declined → flag para review
    await supabase
        .from('marketplace_transactions')
        .update({
            status: internalStatus === 'rejected' ? 'declined' : internalStatus,
            wompi_transaction_id: txId,
            updated_at: new Date().toISOString(),
        })
        .eq('id', tx.id);

    await supabase.rpc('flag_payment_for_review', {
        p_kind: 'marketplace_transaction',
        p_id: tx.id,
        p_reason: `wompi_${internalStatus} (tx=${txId})`,
    });

    req.log?.warn({ marketplaceTxId: tx.id, internalStatus }, 'Marketplace tx flagged for review');
    return { status: 200, body: { status: 'ok', kind: 'marketplace', internalStatus, flagged_for_review: true } };
}

// ─── CART: ordenes del shop ────────────────────────────────────────────────

async function handleCartOrder({
    req, txId, txReference, internalStatus, paymentMethodType, rawTransaction,
}: HandlerArgs): Promise<HandlerResult> {
    // 1. Orden por referencia (reference / wompi_reference / provider_reference).
    const order = await findStoreOrderByReference(txReference);
    if (!order) {
        req.log?.warn({ txReference }, 'Cart order not found');
        return { status: 200, body: { status: 'ignored', reason: 'order_not_found' } };
    }

    if (internalStatus === 'paid') {
        // 2. Monto exacto contra orders.total_amount (centavos).
        if (!amountMatchesOrder(order.total_amount, { cents: Number(rawTransaction?.amount_in_cents) })) {
            req.log?.error(
                { expected: order.total_amount, receivedCents: rawTransaction?.amount_in_cents, txReference },
                'Cart order: amount mismatch',
            );
            await supabase.rpc('flag_payment_for_review', {
                p_kind: 'order', p_id: order.id, p_reason: `wompi_amount_mismatch (tx=${txId})`,
            });
            return { status: 400, body: { error: 'Amount mismatch' } };
        }

        // 3. Un solo camino (M-F0-4): consume reservas, descuenta stock, kardex,
        //    settlements (un solo motor) y eventos contables, idempotente por tx.
        const { data: result, error } = await supabase.rpc('confirm_order_payment', {
            p_order_id: order.id,
            p_wompi_reference: txReference,
            p_wompi_transaction_id: txId,
            p_payment_method_type: paymentMethodType,
            p_provider: 'wompi',
        });
        if (error) {
            req.log?.error({ err: error, orderId: order.id }, 'confirm_order_payment failed');
            await supabase.rpc('flag_payment_for_review', {
                p_kind: 'order', p_id: order.id, p_reason: `wompi_confirm_failed (tx=${txId})`,
            });
            return { status: 200, body: { status: 'review', error: error.message } };
        }
        if ((result as any)?.review) {
            req.log?.warn({ orderId: order.id, result }, 'Cart order paid but sent to review');
            return { status: 200, body: { status: 'review', kind: 'cart', result } };
        }
        req.log?.info({ orderId: order.id, txReference }, 'Cart order paid');
        return { status: 200, body: { status: 'ok', kind: 'cart', result } };
    }

    // 4. No aprobado: la base libera la reserva y cancela (rechazo/fallo), o
    //    marca revisión (anulación de una orden cobrada). Nunca un UPDATE suelto.
    const { data: failRes, error: failErr } = await supabase.rpc('store_order_payment_failed', {
        p_order_id: order.id,
        p_provider: 'wompi',
        p_tx_id: txId,
        p_status: internalStatus,
        p_reason: buildFailureReason('wompi', internalStatus, paymentMethodType, rawTransaction, txId),
    });
    if (failErr) {
        req.log?.error({ err: failErr, orderId: order.id }, 'store_order_payment_failed failed');
        return { status: 500, body: { error: 'cart_failure_update_failed' } };
    }
    return { status: 200, body: { status: 'ok', kind: 'cart', internalStatus, result: failRes } };
}

// ─── BKG: reservas de cancha/sesion ─────────────────────────────────────────

async function handleSessionBooking({
    req, txId, txReference, internalStatus, txAmountCop,
}: HandlerArgs): Promise<HandlerResult> {
    const { data: booking, error: bookingErr } = await supabase
        .from('session_bookings')
        .select('id, user_id, price, payment_status, wompi_transaction_id')
        .eq('wompi_reference', txReference)
        .maybeSingle();

    if (bookingErr || !booking) {
        req.log?.warn({ txReference }, 'Session booking not found');
        return { status: 200, body: { status: 'ignored', reason: 'booking_not_found' } };
    }

    if (booking.wompi_transaction_id === txId && booking.payment_status === 'paid') {
        return { status: 200, body: { status: 'already_processed' } };
    }

    if (internalStatus === 'paid') {
        if (Math.abs(txAmountCop - Number(booking.price)) > 1) {
            req.log?.error({ expected: booking.price, received: txAmountCop, txReference }, 'Booking amount mismatch');
            return { status: 400, body: { error: 'Amount mismatch' } };
        }

        const { data: result, error } = await supabase.rpc('confirm_session_booking_payment', {
            p_booking_id: booking.id,
            p_wompi_reference: txReference,
            p_wompi_transaction_id: txId,
        });

        if (error) {
            req.log?.error({ err: error }, 'confirm_session_booking_payment failed');
            return { status: 500, body: { error: 'Confirm RPC failed' } };
        }

        return { status: 200, body: { status: 'ok', kind: 'session_booking', result } };
    }

    // Failed/declined → flag for review
    await supabase
        .from('session_bookings')
        .update({
            payment_status: internalStatus === 'rejected' ? 'failed' : internalStatus,
            wompi_transaction_id: txId,
            updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id);

    await supabase.rpc('flag_payment_for_review', {
        p_kind: 'session_booking',
        p_id: booking.id,
        p_reason: `wompi_${internalStatus} (tx=${txId})`,
    });

    return { status: 200, body: { status: 'ok', kind: 'session_booking', internalStatus, flagged_for_review: true } };
}

// ─── RSV: reservas de canchas (F2) ─────────────────────────────────────────
//
// Valida el monto y llama confirmar_pago_reserva (idempotente por id de tx).
// Toda la logica vive en services/reservation-payments.service.ts, compartida con MP.

async function handleReservation({
    req, txId, txReference, internalStatus, txAmountCop, rawTransaction,
}: HandlerArgs): Promise<HandlerResult> {
    return applyReservationPayment({
        provider: 'wompi',
        reference: txReference,
        internalStatus,
        amountCop: txAmountCop,
        currency: String(rawTransaction?.currency ?? 'COP'),
        eventId: txId,
        log: req.log,
    });
}

// ─── Captura de token reutilizable tras APPROVED ─────────────────────────
//
// Solo guardamos tarjeta si el padre opto explicitamente en el modal de
// checkout (POST /payment-tokens/save-intent crea una fila en
// pending_card_saves con los acceptance tokens que el usuario acepto).
// Sin esa fila, NO guardamos — respeta opt-in del usuario y deja prueba
// legal de aceptacion (Habeas Data).
//
// Si hay consent y la tarjeta es CARD, convertimos el token efimero del
// Widget (~15 min TTL) en un payment_source permanente via POST /v1/
// payment_sources y lo guardamos como provider_payment_source_id.
async function maybeCaptureToken(
    req: Request,
    realTx: any,
    txReference: string,
    creds?: WompiCreds,
): Promise<void> {
    try {
        const pm = realTx?.payment_method;
        const ephemeralToken: string | undefined = pm?.token || pm?.extra?.token;
        if (!ephemeralToken) return;

        // 1. Buscar consent del padre. Sin consent no guardamos.
        const { data: consentRows, error: consentErr } = await supabase
            .rpc('consume_card_save_intent', { p_reference: txReference });

        if (consentErr) {
            req.log?.warn({ err: consentErr, txReference }, 'consume_card_save_intent failed');
            return;
        }
        const consent = Array.isArray(consentRows) ? consentRows[0] : consentRows;
        if (!consent?.user_id) {
            // No hay consent → el padre NO opto por guardar. Respetamos.
            req.log?.info({ txReference }, 'no card save consent for this reference; skipping tokenization');
            return;
        }

        const customerEmail: string = realTx?.customer_email || '';
        if (!customerEmail) {
            req.log?.warn({ txReference }, 'no customer_email in tx; cannot create payment_source');
            return;
        }

        // 2. Crear payment_source permanente en Wompi.
        const paymentMethodType = (pm?.type || 'CARD') as 'CARD' | 'NEQUI' | 'DAVIPLATA' | 'BANCOLOMBIA_TRANSFER';
        // Mismo comercio que cobró: el payment_source queda ligado a esa cuenta Wompi.
        const psRes = await createPaymentSource({
            cardToken: ephemeralToken,
            customerEmail,
            acceptanceToken: consent.acceptance_token,
            personalDataAuthToken: consent.personal_data_auth_token,
            type: paymentMethodType,
        }, creds);

        if (!psRes.ok) {
            req.log?.warn({ err: psRes.error, txReference, userId: consent.user_id }, 'createPaymentSource failed');
            return;
        }

        // 3. Guardar payment_token con provider_payment_source_id + auditar consent.
        const { data: saveRes, error: saveErr } = await supabase.rpc('save_payment_token', {
            p_user_id: consent.user_id,
            p_payment_provider: 'wompi',
            p_provider_token: ephemeralToken,                 // efimero, para debug
            p_provider_customer_id: null,
            p_provider_card_id: null,
            p_provider_payment_source_id: psRes.paymentSourceId,
            p_payment_method_type: paymentMethodType,
            p_last_four: pm?.extra?.last_four || null,
            p_brand: pm?.extra?.brand || null,
            p_holder_name: pm?.extra?.card_holder || null,
            p_expires_at: null,
            p_set_default: false,
        });

        if (saveErr || !saveRes?.ok) {
            req.log?.warn({ err: saveErr || saveRes, txReference }, 'save_payment_token failed');
            return;
        }

        // 4. Insertar prueba durable en payment_consents (auditoria inalterable).
        await supabase.from('payment_consents').insert({
            user_id: consent.user_id,
            payment_provider: 'wompi',
            acceptance_token: consent.acceptance_token,
            personal_data_auth_token: consent.personal_data_auth_token,
            acceptance_permalink: consent.acceptance_permalink,
            personal_data_permalink: consent.personal_data_permalink,
            accepted_at: consent.accepted_at,
            ip_address: consent.ip_address,
            user_agent: consent.user_agent,
            payment_token_id: saveRes.token_id,
            metadata: {
                tx_reference: txReference,
                payment_source_id: psRes.paymentSourceId,
                payment_source_status: psRes.status,
            },
        });

        req.log?.info(
            { userId: consent.user_id, txReference, paymentSourceId: psRes.paymentSourceId },
            'Wompi payment_source created + consent recorded',
        );
    } catch (err: any) {
        req.log?.warn({ err: err?.message || err }, 'maybeCaptureToken failed (non-blocking)');
    }
}

export default router;
