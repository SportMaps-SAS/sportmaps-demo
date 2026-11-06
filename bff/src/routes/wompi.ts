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
import { todayInZone } from '../utils/businessDate';
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
import { sendPaymentAttemptFailedEmails } from '../services/paymentFailureEmail.service';
import { autopayAlResultado, autopayCobroDoble } from '../services/autopay.service';
import {
    applyReservationPayment,
    baseReservationReference,
    schoolIdForReservationReference,
} from '../services/reservation-payments.service';

const router = Router();

/** Formato de las referencias que emitimos: PREFIJO-BASE36-HEX. Nada más entra a la query. */
const SAFE_REFERENCE = /^[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+$/;

/**
 * Motivo del intento fallido, en formato legible por `parsePaymentFailure` del
 * frontend: `<proveedor>_<estado> · <medio> · <mensaje del banco> (tx=…)`.
 *
 * El mensaje del banco es lo unico que hace util el chip: sin el, la escuela
 * lee "rechazado" y sigue sin saber si la familia tiene que llamar al banco o
 * cambiar de medio. Wompi lo manda en `status_message` (p.ej. "La transaccion
 * fue rechazada (Rechazo General)" o el texto del reto 3DS).
 */
/**
 * Lo que dijo el banco, pelado, para meterlo en una notificacion.
 *
 * Distinto de `buildFailureReason`: ese arma la cadena tecnica que se guarda en
 * last_failure_reason (con el codigo del proveedor y el tx). Esto es lo que
 * lee un padre en su celular, asi que va sin prefijos ni ids.
 */
export function bankMessageFrom(rawTransaction?: any): string | null {
    const mensaje = rawTransaction?.status_message ?? rawTransaction?.status_detail ?? null;
    if (!mensaje) return null;
    return String(mensaje).slice(0, 160);
}

export function buildFailureReason(
    provider: 'wompi' | 'mp',
    internalStatus: string,
    paymentMethodType?: string | null,
    rawTransaction?: any,
    txId?: string,
): string {
    const partes = [`${provider}_${internalStatus}`];

    if (paymentMethodType) partes.push(String(paymentMethodType));

    // Se recorta: last_failure_reason no es un log, es el texto de un chip.
    const mensaje = rawTransaction?.status_message ?? rawTransaction?.status_detail ?? null;
    if (mensaje) partes.push(String(mensaje).slice(0, 160));

    return `${partes.join(' · ')}${txId ? ` (tx=${txId})` : ''}`;
}

/**
 * Concilia lo que entró por la pasarela contra lo que el cobro pide HOY.
 *
 * El enlace congela `base_amount` al crearse (y vive días: el de WhatsApp se
 * paga cuando la familia puede). Entre la firma y el pago el cobro puede:
 *   - BAJAR (un descuento) → sobrepago (I35): queda `paid` y a revisión.
 *   - SUBIR (el recargo por mora de `apply_late_fees`, decisión 2026-10-14:
 *     la mora nunca se condona en silencio y todo canal cobra el monto CON
 *     recargo) → faltante: NO puede quedar `paid`. Queda `partial` con lo
 *     recibido en `amount_paid`, con rastro visible SIN bloqueo
 *     (record_payment_failure), y el saldo se cobra aparte.
 *
 * Se compara `base_amount` (lo cobrado sin el recargo online, que es de la
 * escuela) contra el saldo vigente: amount − amount_paid − pronto pago (misma
 * regla que frontend/src/lib/cobrosYPagos.ts). Tolerancia de 1 COP, la misma
 * del chequeo de monto del webhook.
 *
 * Si el cobro no se pudo leer o no tiene monto, no se concilia (0/0): se
 * conserva el comportamiento de siempre antes que inventar una diferencia.
 */
export interface ConciliacionMonto {
    /** Monto vigente del cobro (`payments.amount`). */
    montoVigente: number;
    /** Lo recibido sin el recargo online (`payment_links.base_amount`). */
    recibidoBase: number;
    /** Saldo que el cobro pedía antes de este pago. */
    saldo: number;
    /** > 0 → pagó de más. */
    sobrepago: number;
    /** > 0 → pagó de menos; el cobro queda `partial`. */
    faltante: number;
    /** `amount_paid` a escribir, o null si no hay que tocarlo. */
    amountPaidNuevo: number | null;
}

export function conciliarMontoRecibido(
    cobro: { amount?: unknown; amount_paid?: unknown; early_payment_discount_applied?: unknown } | null | undefined,
    baseAmountLink: unknown,
): ConciliacionMonto {
    const montoVigente = Number(cobro?.amount);
    const recibidoBase = Number(baseAmountLink);
    const pagadoAntes = Math.max(0, Number(cobro?.amount_paid) || 0);
    const pronto = Math.max(0, Number(cobro?.early_payment_discount_applied) || 0);

    if (!Number.isFinite(montoVigente) || montoVigente <= 0 || !Number.isFinite(recibidoBase)) {
        return { montoVigente, recibidoBase, saldo: NaN, sobrepago: 0, faltante: 0, amountPaidNuevo: null };
    }

    const saldo = montoVigente - pagadoAntes - pronto;
    // El sobrepago se mide como siempre (contra amount, descontando solo los
    // abonos previos): el pronto pago no entra para no marcar de más cobros
    // que el enlace siempre cobró completos.
    const sobrepago = recibidoBase > montoVigente - pagadoAntes + 1
        ? Math.round(recibidoBase - (montoVigente - pagadoAntes))
        : 0;
    const faltante = recibidoBase < saldo - 1 ? Math.round(saldo - recibidoBase) : 0;

    // amount_paid solo se escribe cuando aporta: si hubo diferencia o ya había
    // abonos (el total pagado es la suma). Un pago exacto sin abonos lo deja
    // como estaba, igual que antes.
    const amountPaidNuevo = sobrepago > 0 || faltante > 0 || pagadoAntes > 0
        ? Math.round(pagadoAntes + recibidoBase)
        : null;

    return { montoVigente, recibidoBase, saldo, sobrepago, faltante, amountPaidNuevo };
}

/**
 * Motivo legible del pago parcial, para last_failure_reason (lo lee la escuela
 * en el chip de revisión). Si el cobro tiene recargo por mora se dice; si no,
 * se dice solo que el cobro subió.
 */
export function motivoPagoParcial(
    base: string,
    c: ConciliacionMonto,
    lateFeeAmount: unknown,
): string {
    const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
    const causa = Number(lateFeeAmount) > 0
        ? 'recargo por mora aplicado después de generar el enlace'
        : 'el cobro subió después de generar el enlace';
    return `${base} · Pagó ${cop(c.recibidoBase)}; faltan ${cop(c.faltante)} (${causa}; cobro ${cop(c.montoVigente)})`;
}

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

// Wompi entrega el tipo de instrumento (CARD/PSE/NEQUI/…). La constraint
// payments_payment_method_check solo admite pse|card|transfer|cash|other, así
// que 'wompi' NO es válido (rompía el UPDATE en silencio). Mapeamos al enum.
const WOMPI_METHOD_MAP: Record<string, string> = {
    CARD: 'card',
    PSE: 'pse',
    NEQUI: 'transfer',
    DAVIPLATA: 'transfer',
    BANCOLOMBIA_TRANSFER: 'transfer',
    BANCOLOMBIA_QR: 'transfer',
    BANCOLOMBIA_COLLECT: 'transfer',
};

async function handleSchoolPayment({
    req, txId, txReference, internalStatus, txAmountCop, paymentMethodType, rawTransaction,
}: HandlerArgs): Promise<HandlerResult> {
    // 1. Buscar payment_link por referencia
    const { data: link, error: linkErr } = await supabase
        .from('payment_links')
        .select('id, payment_id, school_id, gross_amount, base_amount, sportmaps_fee, status, expires_at, failed_attempts, origin, recurring_attempt_id')
        .eq('wompi_reference', txReference)
        .maybeSingle();

    if (linkErr || !link) {
        req.log?.warn({ txReference }, 'School payment: payment_link not found');
        return { status: 200, body: { status: 'ignored', reason: 'link_not_found' } };
    }

    // 2. Idempotencia
    const { data: existingSplit } = await supabase
        .from('payment_splits')
        .select('id')
        .eq('wompi_transaction_id', txId)
        .maybeSingle();

    if (existingSplit) {
        return { status: 200, body: { status: 'already_processed' } };
    }

    // Débito automático: el enlace lo creó el motor (autopay.service) para un intento.
    const autopayAttemptId: string | null = (link as any).origin === 'autopay' ? (link as any).recurring_attempt_id ?? null : null;

    if (internalStatus === 'paid') {
        // 3. Verificar monto
        if (Math.abs(txAmountCop - Number(link.gross_amount)) > 1) {
            req.log?.error(
                { expected: link.gross_amount, received: txAmountCop, txReference },
                'School payment: amount mismatch',
            );
            return { status: 400, body: { error: 'Amount mismatch' } };
        }

        const today = todayInZone();

        // 3.b Doble pago. Desde 2026-10-06 el link con monto (wompi-link-con-monto)
        //     sale por WhatsApp: una familia puede pagar con él DESPUÉS de haber
        //     transferido (y la escuela aprobado el comprobante) o con un link
        //     viejo de otra referencia del mismo cobro. Antes este UPDATE pisaba
        //     el pago ya registrado (fecha, canal, tx) y el primer pago quedaba
        //     sin rastro. Ahora: el dinero entró, así que se deja el link 'paid'
        //     y el split (registro de la plata), NO se toca el cobro y se marca
        //     para revisión con el motivo — la escuela decide si devuelve.
        const { data: actual } = await supabase
            .from('payments')
            .select('status, wompi_transaction_id, amount, amount_paid, early_payment_discount_applied, late_fee_amount')
            .eq('id', link.payment_id)
            .maybeSingle();
        if ((actual as any)?.status === 'paid' && (actual as any)?.wompi_transaction_id !== txId) {
            await supabase
                .from('payment_links')
                .update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
                .eq('id', link.id);
            await supabase.from('payment_splits').insert({
                payment_id: link.payment_id,
                payment_link_id: link.id,
                wompi_reference: txReference,
                wompi_transaction_id: txId,
                gross_amount: txAmountCop,
                school_receives: txAmountCop,
                sportmaps_receives: 0,
                wompi_fee: 0,
                transfer_status: 'pending',
                webhook_signature_valid: true,
            });
            const { error: flagErr } = await supabase.rpc('flag_payment_for_review', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: buildFailureReason('wompi', 'doble_pago', paymentMethodType, null, txId),
            });
            if (flagErr) {
                req.log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo marcar el doble pago para revisión');
            }
            // §8.3 del débito: si el cobro es del débito automático, incidente + suspensión.
            try {
                await autopayCobroDoble({
                    paymentId: link.payment_id, schoolId: link.school_id, txId, amount: txAmountCop,
                    attemptId: autopayAttemptId, reference: txReference, linkId: link.id,
                });
            } catch (e: any) {
                req.log?.error({ err: e?.message, paymentId: link.payment_id }, 'autopay: no se pudo registrar el cobro doble');
            }
            req.log?.warn({ paymentId: link.payment_id, txReference, txId }, 'School payment: el cobro ya estaba pagado — doble pago a revisión');
            return { status: 200, body: { status: 'ok', kind: 'school_payment', duplicate_payment: true } };
        }

        // 4. Marcar payment como pagado.
        //    payment_method DEBE ser un valor de payments_payment_method_check
        //    (pse|card|transfer|cash|other); 'wompi' lo violaba y el UPDATE
        //    fallaba en silencio (el pago quedaba pending pese al webhook OK).
        const payMethod = WOMPI_METHOD_MAP[String(paymentMethodType || '').toUpperCase()] ?? 'other';

        // 3.c Sobrepago (spec cobros-multiples I35, §13.10c). El enlace firmó un
        //     monto; si entre la firma y el pago la escuela bajó el cobro (un
        //     descuento por una vía que la regla PAGO_EN_CURSO no vio), lo
        //     recibido supera `amount`. La plata ya entró: el cobro queda `paid`
        //     con `amount_paid` = lo recibido y a revisión («pagó de más $X»), para
        //     que la escuela decida si devuelve. Nunca se reabre ni se pierde el
        //     descuento en silencio. Se compara `base_amount` (lo cobrado sin el
        //     recargo online, que es de la escuela) contra el `amount` vigente.
        //
        // 3.d Faltante (mora, decisión 2026-10-14). Lo inverso: el enlace se
        //     generó ANTES de que `apply_late_fees` sumara el recargo y se pagó
        //     DESPUÉS. Antes esto quedaba `paid` y la mora se condonaba en
        //     silencio. Ahora el cobro queda `partial` con lo recibido sumado a
        //     `amount_paid`, con el faltante como rastro visible pero SIN bloqueo
        //     (la familia tiene que poder pagar el saldo), y el saldo se cobra aparte.
        //     El enlace sí queda 'paid' y el split se registra: esa plata entró.
        const conc = conciliarMontoRecibido(actual as any, link.base_amount);
        const { montoVigente, recibidoBase, sobrepago, faltante } = conc;
        const { error: payUpdErr } = await supabase
            .from('payments')
            .update({
                status: faltante > 0 ? 'partial' : 'paid',
                payment_channel: 'online',
                payment_method: payMethod,
                payment_date: today,
                approved_at: new Date().toISOString(),
                // DIN-3 (segunda pasada, 20260921205037): antes del 13-ago esta
                // columna se sellaba sola vía DEFAULT 'wompi'. Al quitarse el
                // default (20260813180537), este UPDATE se quedó sin setearla
                // explícito y todo pago de Wompi confirmado por webhook empezó
                // a quedar con payment_provider = NULL — el mismo bug de DIN-3,
                // en la dirección opuesta. mercadopago.ts sí la setea en cada
                // UPDATE de webhook; este es el único camino que quedó asimétrico.
                payment_provider: 'wompi',
                wompi_reference: txReference,
                wompi_transaction_id: txId,
                gross_amount: txAmountCop,
                sportmaps_fee: link.sportmaps_fee,
                ...(conc.amountPaidNuevo !== null ? { amount_paid: conc.amountPaidNuevo } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('id', link.payment_id);

        // Si el UPDATE del pago falla, NO seguimos marcando link/split como si
        // todo hubiera ido bien. Devolvemos 500 → el webhook se marca 'failed'
        // (reintentable) en vez de un falso 'processed'.
        if (payUpdErr) {
            req.log?.error(
                { err: payUpdErr, paymentId: link.payment_id, txReference },
                'School payment: FALLÓ marcar payment como paid',
            );
            return { status: 500, body: { error: 'payment_update_failed', detail: payUpdErr.message } };
        }

        if (sobrepago > 0) {
            const { error: flagErr } = await supabase.rpc('flag_payment_for_review', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: `${buildFailureReason('wompi', 'sobrepago', paymentMethodType, null, txId)} · pagó de más $${sobrepago.toLocaleString('es-CO')} (cobro $${montoVigente.toLocaleString('es-CO')}, recibido $${recibidoBase.toLocaleString('es-CO')})`,
            });
            if (flagErr) {
                req.log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo marcar el sobrepago para revisión');
            }
            req.log?.warn({ paymentId: link.payment_id, txReference, sobrepago }, 'School payment: recibido mayor que el cobro vigente — a revisión');
        }

        // Rastro SIN bloqueo (record_payment_failure: last_failure_reason, sin
        // requires_review). NO flag_payment_for_review: ese lock frena todo
        // checkout nuevo del pagador (payments.routes / is_user_payment_blocked)
        // y la familia no podría pagar el saldo en línea — justo lo que hay que
        // cobrar. La escuela lo ve en el chip del cobro (FailedAttemptChip,
        // rótulo «Falta saldo» vía parsePaymentFailure) y el cobro queda 'partial'.
        if (faltante > 0) {
            const { error: flagErr } = await supabase.rpc('record_payment_failure', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: motivoPagoParcial(
                    buildFailureReason('wompi', 'pago_parcial', paymentMethodType, null, txId),
                    conc,
                    (actual as any)?.late_fee_amount,
                ),
            });
            if (flagErr) {
                req.log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo dejar el rastro del pago parcial');
            }
            req.log?.warn({ paymentId: link.payment_id, txReference, faltante }, 'School payment: recibido menor que el cobro vigente (mora posterior al enlace) — partial, saldo pendiente');
        }

        // 5. Marcar payment_link
        await supabase
            .from('payment_links')
            .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', link.id);

        // 6. Crear split
        await supabase
            .from('payment_splits')
            .insert({
                payment_id: link.payment_id,
                payment_link_id: link.id,
                wompi_reference: txReference,
                wompi_transaction_id: txId,
                gross_amount: txAmountCop,
                // MODELO VIGENTE: el recargo por pago online es de la ESCUELA. Existe para
                // cubrirle la comisión que la pasarela le descuenta, y el dinero ya entra
                // completo a su cuenta (el Widget de Wompi no hace split). SportMaps no
                // participa de la transacción: su ingreso es el addon de integración, que
                // se cobra por fuera del flujo de pago.
                //
                // Antes esto anotaba el recargo en `sportmaps_receives`, lo que iba dejando
                // una cuenta por cobrar contra la escuela que nadie liquidaba nunca
                // (`transfer_status` no sale de 'pending' en ningún punto del sistema).
                school_receives: txAmountCop,
                sportmaps_receives: 0,
                // La comisión real de la pasarela no la expone la API de transacciones: se
                // descuenta al liquidar y solo se ve en el dashboard del comercio.
                wompi_fee: 0,
                transfer_status: 'pending',
                webhook_signature_valid: true,
            });

        // 7. Notificar al staff de la escuela (dispara Modo Recepción + outbox).
        //    No-bloqueante: si falla, el pago ya quedó paid igual.
        const { error: notifErr } = await supabase.rpc('notify_school_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (notifErr) {
            req.log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_school_payment_paid falló (no-bloqueante)');
        }

        // 7.b Y al PADRE, que hasta ahora no se enteraba de nada.
        //
        //     `notify_school_payment_paid` avisa solo a la escuela — el nombre lo
        //     dice. Medido el 2026-09-14: de 131 pagos por Wompi con acudiente,
        //     5 recibieron notificacion. Los otros 126 pagaron y su unica forma
        //     de saber que quedo registrado era entrar a mirar.
        //
        //     No-bloqueante por lo mismo que la de arriba: el pago ya quedo paid.
        const { error: padreErr } = await supabase.rpc('notify_parent_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (padreErr) {
            req.log?.warn({ err: padreErr, paymentId: link.payment_id }, 'notify_parent_payment_paid falló (no-bloqueante)');
        }

        if (autopayAttemptId) {
            try {
                await autopayAlResultado({
                    attemptId: autopayAttemptId, paymentId: link.payment_id, txId, reference: txReference,
                    linkId: link.id, internalStatus,
                });
            } catch (e: any) {
                // El pago ya quedó paid; el intento lo cierra el barrido al reconsultar.
                req.log?.error({ err: e?.message, attemptId: autopayAttemptId }, 'autopay: no se pudo cerrar el intento aprobado');
            }
        }

        req.log?.info({ paymentId: link.payment_id, txReference }, 'School payment confirmed');
        return {
            status: 200,
            body: {
                status: 'ok', kind: 'school_payment',
                ...(sobrepago > 0 ? { overpayment: sobrepago } : {}),
                ...(faltante > 0 ? { underpayment: faltante, partial: true } : {}),
            },
        };
    }

    // No-paid (declined/voided/error) → dejar rastro del intento.
    //
    // El error de este UPDATE se lee. Durante meses no se leyó: el CHECK de
    // payment_links no admitía 'declined'/'failed'/'refunded', Postgres tiraba
    // 23514 y los 10 rechazos de Dynasty quedaron con el link en 'pending' y
    // failed_attempts en 0, como si nadie hubiera intentado pagar.
    const { error: linkUpdErr } = await supabase
        .from('payment_links')
        .update({
            status: internalStatus === 'rejected' ? 'declined' : internalStatus,
            // Contador, no bandera: tres intentos tienen que leerse como tres.
            failed_attempts: ((link as any).failed_attempts ?? 0) + 1,
            updated_at: new Date().toISOString(),
        })
        .eq('id', link.id);

    if (linkUpdErr) {
        req.log?.error(
            { err: linkUpdErr, linkId: link.id, internalStatus },
            'No se pudo marcar el payment_link como fallido — el intento queda sin rastro',
        );
    }

    // Débito automático rechazado: NO es un pago fallido de la familia (no lo intentó
    // ella, no se bloquea ni se le manda el aviso genérico). Se cierra el intento y el
    // motor avisa con la fecha del reintento o que se agotó (§10.1).
    if (autopayAttemptId) {
        try {
            await autopayAlResultado({
                attemptId: autopayAttemptId, paymentId: link.payment_id, txId, reference: txReference,
                linkId: link.id, internalStatus,
            });
        } catch (e: any) {
            req.log?.error({ err: e?.message, attemptId: autopayAttemptId }, 'autopay: no se pudo cerrar el intento rechazado');
            return { status: 500, body: { error: 'autopay_finish_failed' } };
        }
        return { status: 200, body: { status: 'ok', kind: 'school_payment', autopay: true, internalStatus } };
    }

    // Solo lo AMBIGUO bloquea. Una declinación ordinaria (el banco dijo que no,
    // o el padre abandonó el PSE) no deja plata en el aire: no hay nada que
    // revisar, hay que reintentar. ERROR y VOIDED sí: ahí no sabemos si el
    // dinero se movió, y la fila para hasta que alguien mire.
    const isAmbiguous = internalStatus === 'failed' || internalStatus === 'refunded';
    const reason = buildFailureReason('wompi', internalStatus, paymentMethodType, rawTransaction, txId);

    const { error: trailErr } = await supabase.rpc(
        isAmbiguous ? 'flag_payment_for_review' : 'record_payment_failure',
        { p_kind: 'payment', p_id: link.payment_id, p_reason: reason },
    );
    if (trailErr) {
        req.log?.error({ err: trailErr, paymentId: link.payment_id }, 'No se pudo registrar el fallo del cobro');
    }

    // Avisar a la familia y al staff. No-bloqueante: si el aviso falla, el
    // rastro del intento ya quedó igual.
    const { error: notifErr } = await supabase.rpc('notify_payment_attempt_failed', {
        p_payment_id: link.payment_id,
        p_reason: bankMessageFrom(rawTransaction),
        p_ambiguous: isAmbiguous,
    });
    if (notifErr) {
        req.log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_payment_attempt_failed falló (no-bloqueante)');
    }

    // Correo, además del in-app: no todo padre vive pendiente de la app.
    void sendPaymentAttemptFailedEmails(link.payment_id, bankMessageFrom(rawTransaction), isAmbiguous, req.log);

    req.log?.warn(
        { paymentId: link.payment_id, internalStatus, blocked: isAmbiguous },
        isAmbiguous ? 'School payment flagged for review' : 'School payment declined (reintento habilitado)',
    );
    return {
        status: 200,
        body: { status: 'ok', kind: 'school_payment', internalStatus, flagged_for_review: isAmbiguous },
    };
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
