/**
 * mercadopago — Webhook + create-payment endpoint para MercadoPago.
 *
 * Endpoints:
 *   POST /api/v1/webhooks/mercadopago/webhook  → recibe notificaciones de MP
 *   POST /api/v1/payments/mp/create            → crea payment desde Brick onSubmit
 *   POST /api/v1/payments/mp/save-card         → guarda customer+card para autopay
 *
 * Webhook flow:
 *  1. MP llama con { type: "payment", action: "...", data: { id } }
 *  2. Validamos x-signature (HMAC SHA256 con webhook_secret).
 *  3. GET /v1/payments/{id} a MP (anti-spoofing + payload completo).
 *  4. Leemos external_reference, extraemos prefijo (SCH/CART/SVC/...).
 *  5. Dispatch a handler equivalente al de Wompi pero con p_provider='mercadopago'.
 *
 * Create flow:
 *  1. Frontend renderiza Brick con publicKey del provider del contexto.
 *  2. Brick onSubmit retorna { token, paymentMethodId, installments, payer }.
 *  3. Frontend POSTea aqui con esos datos + reference + amount + schoolId/vendorId.
 *  4. BFF resuelve config (access_token), llama POST /v1/payments y retorna status.
 */

import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase';
import {
    findStoreOrderByReference,
    findStoreOrderById,
    sellerGatewayForOrder,
    amountMatchesOrder,
    SellerGatewayError,
} from '../services/store-checkout';
import type { ResolvedProvider } from '../services/payment-provider.resolver';
import { requireAuth, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { todayInZone } from '../utils/businessDate';
import {
    validateMpWebhookSignature,
    fetchMpPayment,
    createMpPayment,
    saveMpCustomerCard,
    mapMpStatus,
    esCredencialDePrueba,
    type MpPayment,
    type InternalStatus,
} from '../services/mercadopago.service';
import { loadProviderConfig } from '../services/payment-provider.resolver';
import { applyReservationPayment, schoolIdForReservationReference } from '../services/reservation-payments.service';
// Mismo formato de motivo que Wompi para que el frontend lo parsee una sola vez.
import { buildFailureReason, bankMessageFrom, conciliarMontoRecibido, motivoPagoParcial } from './wompi';
import { sendPaymentAttemptFailedEmails } from '../services/paymentFailureEmail.service';
import {
    recordWebhookEvent,
    markWebhookProcessed,
    markWebhookOrphan,
    markWebhookFailed,
    markWebhookIgnored,
} from '../services/webhook-events.service';

// Doble export: webhookRouter para /webhooks/mercadopago, paymentsRouter para /payments/mp
const webhookRouter = Router();
const paymentsRouter = Router();

// ─── Webhook ──────────────────────────────────────────────────────────────

/**
 * Handler del webhook de MercadoPago.
 *
 * `schoolIdDeLaRuta` viene de `/webhook/:schoolId` y resuelve un problema real:
 * para leer el `external_reference` hay que consultarle el pago a MP, y un
 * payment id está SCOPEADO al comercio. Sin saber de antemano de quién es el
 * evento, la única opción era preguntar con la llave global — que para una
 * escuela con cuenta propia ('direct') devuelve 404, así que el pago no se
 * conciliaba nunca. Con la URL por escuela sabemos el comercio antes de
 * preguntar. Mismo patrón que el ruteo multi-tenant de Wompi (M5).
 *
 * La ruta sin schoolId se conserva para siempre: los webhooks ya configurados
 * en los dashboards y los pagos en vuelo apuntan ahí.
 */
async function manejarWebhookMp(
    req: Request,
    res: Response,
    schoolIdDeLaRuta: string | null,
    orderIdDeLaRuta: string | null = null,
) {
    try {
        const body = req.body ?? {};
        const xSignature = (req.headers['x-signature'] || req.headers['X-Signature']) as string | undefined;
        const xRequestId = (req.headers['x-request-id'] || req.headers['X-Request-Id']) as string | undefined;

        const eventType = body?.type ?? body?.topic;
        const dataId = body?.data?.id ?? req.query['data.id'] ?? req.query['id'];

        req.log?.info({ eventType, dataId }, 'MercadoPago webhook received');

        // MP envia varios topics; solo procesamos pagos
        if (eventType !== 'payment' && eventType !== 'payment.updated') {
            return res.status(200).json({ status: 'ignored', eventType });
        }

        if (!dataId) {
            return res.status(400).json({ error: 'Missing data.id' });
        }

        // Resolver config: necesitamos el webhook_secret y access_token del merchant
        // que recibio este pago. Estrategia:
        //  1. Leer el pago para obtener el external_reference. Con qué token, abajo.
        //  2. Buscar la entidad por external_reference para encontrar school_id/vendor_id.
        //  3. Cargar config especifica de ese merchant.
        //  4. Re-validar signature con su webhook_secret.
        //
        // El paso 1 es el delicado: antes usaba SIEMPRE MP_ACCESS_TOKEN_DEFAULT
        // ("para simplicidad de demo"), y un payment id de otro comercio devuelve
        // 404 → el pago no se conciliaba. Por eso existe /webhook/:schoolId.

        // Token con el que se consulta el pago. Si la ruta trae la escuela, se usa
        // el de SU comercio (para 'aggregator' el resolver devuelve el de ENV, o
        // sea el mismo de antes). Sin escuela en la ruta, camino legacy.
        let tokenDeLectura: string | undefined;

        // Tienda (tienda v2 F0, D-5 = A): la URL trae la orden → se lee el pago
        // con el token DEL VENDEDOR de esa orden. Nunca con el de ENV.
        let sellerCfg: ResolvedProvider | null = null;
        let storeOrder: Awaited<ReturnType<typeof findStoreOrderById>> = null;
        if (orderIdDeLaRuta) {
            storeOrder = await findStoreOrderById(orderIdDeLaRuta);
            if (!storeOrder) {
                return res.status(200).json({ status: 'ignored', reason: 'order_not_found' });
            }
            try {
                sellerCfg = await sellerGatewayForOrder(storeOrder);
            } catch {
                req.log?.warn({ orderId: orderIdDeLaRuta }, 'MP webhook: store order without resolvable seller gateway');
                return res.status(503).json({ error: 'seller_gateway_unavailable' });
            }
            tokenDeLectura = sellerCfg.accessToken;
        } else if (schoolIdDeLaRuta) {
            const cfg = await loadProviderConfig({
                provider: 'mercadopago',
                schoolId: schoolIdDeLaRuta,
            });
            tokenDeLectura = cfg?.accessToken;

            // Sin credenciales para esa escuela NO se cae a la llave global: seria
            // volver al bug: preguntar por un pago ajeno con el token de otro.
            if (!tokenDeLectura) {
                req.log?.warn(
                    { schoolId: schoolIdDeLaRuta, dataId },
                    'MP webhook: la escuela no tiene credenciales resolubles; no se usa la llave global',
                );
                return res.status(200).json({ status: 'ignored', reason: 'school_without_credentials' });
            }
        } else {
            tokenDeLectura = process.env.MP_ACCESS_TOKEN_DEFAULT;
            if (!tokenDeLectura) {
                req.log?.error('MP_ACCESS_TOKEN_DEFAULT not configured');
                return res.status(500).json({ error: 'mp_not_configured' });
            }
        }

        if (!tokenDeLectura) {
            return res.status(503).json({ error: 'seller_gateway_unavailable' });
        }

        const payment = await fetchMpPayment(String(dataId), tokenDeLectura);
        if (!payment) {
            req.log?.warn({ dataId }, 'Cannot fetch MP payment');
            return res.status(400).json({ error: 'cannot_verify_payment' });
        }

        const externalRef = payment.external_reference;
        if (!externalRef) {
            req.log?.warn({ dataId }, 'MP payment without external_reference');
            return res.status(200).json({ status: 'ignored', reason: 'no_external_reference' });
        }

        // Resolver merchant especifico desde external_reference para validar firma.
        // Tienda (CART-*): el comercio es el vendedor de la orden (seller_gateway_id),
        // nunca ENV, aunque el evento haya llegado por la URL legacy.
        let merchantCtx: { schoolId: string | null; vendorId: string | null } = { schoolId: null, vendorId: null };
        let merchantConfig: ResolvedProvider | null = null;
        if (externalRef.startsWith('CART-')) {
            const order = storeOrder ?? await findStoreOrderByReference(externalRef);
            if (!order || (storeOrder && order.reference !== externalRef)) {
                req.log?.warn({ externalRef, orderIdDeLaRuta }, 'MP webhook: external_reference no corresponde a la orden');
                return res.status(400).json({ error: 'reference_mismatch' });
            }
            try {
                merchantConfig = sellerCfg ?? await sellerGatewayForOrder(order);
            } catch {
                return res.status(503).json({ error: 'seller_gateway_unavailable' });
            }
        } else {
            merchantCtx = await locateMerchantContext(externalRef);
            merchantConfig = await loadProviderConfig({
                provider: 'mercadopago',
                schoolId: merchantCtx.schoolId,
                vendorId: merchantCtx.vendorId,
            });
        }

        // Cada merchant debe tener su propio webhookSecret: un secret compartido
        // entre escuelas permitiria que una merchant maliciosa forje webhooks de
        // otras que tampoco lo configuraron.
        //
        // Este comentario decia "NO se usa fallback global" cuando loadProviderConfig
        // si caia a ENV. Ya no cae para una escuela en 'direct'/'unset' ni para un
        // vendor sin credenciales (devuelve null y el secret queda null). Sigue
        // usando ENV en dos casos legitimos: la escuela en 'aggregator', y un pago
        // sin dueno identificable — los MP viejos viven en esa cuenta.
        const effectiveSecret = merchantConfig?.webhookSecret ?? null;
        // DIN-9: sin config de comercio, el ambiente lo decide el PREFIJO de la
        // credencial, no `MP_ENV`. MP no tiene host de sandbox: un token
        // `APP_USR-` cobra de verdad aunque la variable diga `sandbox`.
        const isSandbox = merchantConfig?.sandbox ?? esCredencialDePrueba(process.env.MP_ACCESS_TOKEN_DEFAULT);

        if (!effectiveSecret) {
            req.log?.error(
                { dataId, schoolId: merchantCtx.schoolId, vendorId: merchantCtx.vendorId },
                'MP webhook: merchant sin webhookSecret configurado',
            );
            return res.status(503).json({ error: 'merchant_webhook_secret_missing' });
        }

        const validSig = validateMpWebhookSignature({
            xSignature,
            xRequestId,
            dataId,
            secret: effectiveSecret,
            isSandbox,
        });

        if (!validSig) {
            req.log?.warn({ dataId }, 'MP webhook signature invalid');
            return res.status(401).json({ error: 'invalid_signature' });
        }

        if ((payment.currency_id ?? '').toUpperCase() !== 'COP') {
            // Soporte multi-pais futuro: bloqueado por ahora a CO
            req.log?.error({ currency: payment.currency_id, externalRef }, 'MP webhook: unsupported currency');
            return res.status(400).json({ error: 'unsupported_currency' });
        }

        const internalStatus = mapMpStatus(payment.status);

        // Dedup + log persistente del evento (H-03/H-04). event_id estable por
        // (payment.id, status): deduplica el mismo update y registra transiciones.
        const { firstSeen, id: eventLogId } = await recordWebhookEvent({
            provider: 'mercadopago',
            eventId: `${payment.id}:${payment.status}`,
            reference: externalRef,
            eventType,
            payload: body,
        });
        if (!firstSeen) {
            return res.status(200).json({ status: 'already_processed', dedup: 'webhook_events' });
        }

        // Rutear (logica compartida con el reproceso de huerfanos).
        const routed = await routeMercadoPagoTransaction({ payment, log: req.log });

        if (!routed.handled) {
            req.log?.warn({ externalRef }, 'MP webhook: unknown prefix');
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

        // Captura de tarjeta para autopay (si APPROVED y la entidad lo permite)
        if (internalStatus === 'paid') {
            await maybeCaptureMpCard(req, payment, externalRef, merchantConfig?.accessToken ?? tokenDeLectura).catch(err => {
                req.log?.warn({ err: err?.message }, 'maybeCaptureMpCard failed (non-blocking)');
            });
        }

        return res.status(routed.status).json(routed.body);
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'Unexpected error in MP webhook');
        return res.status(500).json({ error: 'internal_server_error' });
    }
}

// Legacy, sin escuela. NO se retira: los webhooks ya dados de alta en los
// dashboards y los pagos en vuelo apuntan a esta URL.
webhookRouter.post('/webhook', (req: Request, res: Response) =>
    manejarWebhookMp(req, res, null));

// Por escuela. Es la que se manda como notification_url en los cobros nuevos:
// permite saber de qué comercio es el evento ANTES de preguntarle a MP.
webhookRouter.post('/webhook/:schoolId', (req: Request, res: Response) => {
    const { schoolId } = req.params as { schoolId?: string };
    return manejarWebhookMp(req, res, schoolId ?? null);
});

// Por orden de tienda (tienda v2 F0). Es la notification_url de los cobros de
// tienda: el pago está scopeado al comercio DEL VENDEDOR y solo se puede leer
// con su token. Declarada antes que '/webhook/:schoolId' no hace falta: tiene
// un segmento más.
webhookRouter.post('/webhook/order/:orderId', (req: Request, res: Response) => {
    const { orderId } = req.params as { orderId?: string };
    if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) {
        return res.status(400).json({ error: 'invalid_order_id' });
    }
    return manejarWebhookMp(req, res, null, orderId);
});

// ─── Locate merchant from external_reference ──────────────────────────────

async function locateMerchantContext(externalRef: string): Promise<{
    schoolId: string | null;
    vendorId: string | null;
}> {
    const prefix = externalRef.split('-')[0];

    if (prefix === 'SCH') {
        const { data } = await supabase
            .from('payment_links')
            .select('school_id')
            .eq('provider_reference', externalRef)
            .maybeSingle();
        return { schoolId: data?.school_id ?? null, vendorId: null };
    }

    if (['SVC', 'EVT', 'SUB', 'MKT'].includes(prefix)) {
        const { data } = await supabase
            .from('marketplace_transactions')
            .select('vendor_id')
            .eq('provider_reference', externalRef)
            .maybeSingle();
        return { schoolId: null, vendorId: data?.vendor_id ?? null };
    }

    // Reservas de canchas: el comercio es la escuela dueña de la reserva (cuenta propia).
    if (prefix === 'RSV') {
        return { schoolId: await schoolIdForReservationReference(externalRef), vendorId: null };
    }

    return { schoolId: null, vendorId: null };
}

// ─── Handlers (mismo dispatch que Wompi pero con p_provider='mercadopago') ───

interface HandlerArgs {
    req: Request;
    paymentId: string;
    externalRef: string;
    mpStatus: string;
    internalStatus: InternalStatus;
    amount: number;
    paymentMethodId: string;
    paymentTypeId: string;
    payment: MpPayment;
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
 * Rutea un pago MP (ya validado/refetcheado) al handler que corresponde por
 * prefijo de external_reference. Compartido por el webhook en vivo y por el
 * cron de reproceso de huerfanos (webhook-reprocess.service).
 *
 * `handled=false` => prefijo desconocido. No hace dedup ni card-capture.
 */
export async function routeMercadoPagoTransaction(
    input: { payment: MpPayment; log?: Request['log'] },
): Promise<{ status: number; body: Record<string, unknown>; handled: boolean }> {
    const { payment } = input;
    const externalRef: string = payment.external_reference || '';
    const internalStatus = mapMpStatus(payment.status);
    const amount = Number(payment.transaction_amount);

    const prefix = externalRef.split('-')[0];
    const handler = HANDLERS[prefix];
    if (!handler) {
        return { status: 200, body: { status: 'ignored', reason: 'unknown_prefix', prefix }, handled: false };
    }

    // Los handlers solo usan req.log?.*, asi que basta un shim con el logger.
    const req = { log: input.log } as unknown as Request;
    const result = await handler({
        req,
        paymentId: String(payment.id),
        externalRef,
        mpStatus: payment.status,
        internalStatus,
        amount,
        paymentMethodId: payment.payment_method_id,
        paymentTypeId: payment.payment_type_id,
        payment,
    });
    return { status: result.status, body: result.body, handled: true };
}

async function handleSchoolPayment(args: HandlerArgs): Promise<HandlerResult> {
    const { req, paymentId, externalRef, internalStatus, amount, paymentTypeId, payment } = args;

    const { data: link, error: linkErr } = await supabase
        .from('payment_links')
        .select('id, payment_id, school_id, gross_amount, base_amount, sportmaps_fee, status, failed_attempts')
        .eq('provider_reference', externalRef)
        .maybeSingle();

    if (linkErr || !link) {
        req.log?.warn({ externalRef }, 'MP school payment: link not found');
        return { status: 200, body: { status: 'ignored', reason: 'link_not_found' } };
    }

    const { data: existingSplit } = await supabase
        .from('payment_splits')
        .select('id')
        .eq('provider_transaction_id', paymentId)
        .maybeSingle();

    if (existingSplit) {
        return { status: 200, body: { status: 'already_processed' } };
    }

    if (internalStatus === 'paid') {
        if (Math.abs(amount - Number(link.gross_amount)) > 1) {
            req.log?.error(
                { expected: link.gross_amount, received: amount, externalRef },
                'MP school payment: amount mismatch',
            );
            return { status: 400, body: { error: 'amount_mismatch' } };
        }

        const today = todayInZone();

        // Faltante / sobrepago: mismo criterio que wompi.ts (§3.c y §3.d de
        // handleSchoolPayment). El enlace congeló `base_amount`; si entre la firma
        // y el pago `apply_late_fees` sumó la mora, lo recibido no salda el cobro
        // y NO puede quedar 'paid' (la mora se condonaba en silencio): queda
        // 'partial' con lo recibido en amount_paid y el faltante como rastro visible.
        const { data: actual } = await supabase
            .from('payments')
            .select('status, amount, amount_paid, early_payment_discount_applied, late_fee_amount')
            .eq('id', link.payment_id)
            .maybeSingle();
        const conc = conciliarMontoRecibido(actual as any, link.base_amount);
        const { sobrepago, faltante } = conc;

        const { error: payUpdErr } = await supabase
            .from('payments')
            .update({
                status: faltante > 0 ? 'partial' : 'paid',
                payment_channel: 'online',
                payment_method: 'mercadopago',
                payment_provider: 'mercadopago',
                provider_reference: externalRef,
                provider_transaction_id: paymentId,
                payment_date: today,
                approved_at: new Date().toISOString(),
                gross_amount: amount,
                sportmaps_fee: link.sportmaps_fee,
                ...(conc.amountPaidNuevo !== null ? { amount_paid: conc.amountPaidNuevo } : {}),
                updated_at: new Date().toISOString(),
            })
            .eq('id', link.payment_id);

        // Antes este error no se leía. Se registra sin cambiar el flujo (no se
        // devuelve 500 aquí: eso cambiaría los reintentos de MP y es otro alcance).
        if (payUpdErr) {
            req.log?.error({ err: payUpdErr, paymentId: link.payment_id, externalRef }, 'MP school payment: FALLÓ actualizar el payment');
        }

        // Faltante: rastro SIN bloqueo (record_payment_failure). Ver wompi.ts §3.d:
        // flag_payment_for_review frenaría todo checkout nuevo del pagador y la
        // familia no podría pagar el saldo en línea.
        // Sobrepago: a revisión como en Wompi. La marca va DESPUÉS del UPDATE: el
        // trigger trg_clear_payment_review_on_settle baja requires_review al entrar a 'paid'.
        if (!payUpdErr && (faltante > 0 || sobrepago > 0)) {
            const base = buildFailureReason('mp', faltante > 0 ? 'pago_parcial' : 'sobrepago', paymentTypeId, null, paymentId);
            const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
            const { error: flagErr } = await supabase.rpc(faltante > 0 ? 'record_payment_failure' : 'flag_payment_for_review', {
                p_kind: 'payment',
                p_id: link.payment_id,
                p_reason: faltante > 0
                    ? motivoPagoParcial(base, conc, (actual as any)?.late_fee_amount)
                    : `${base} · pagó de más ${cop(sobrepago)} (cobro ${cop(conc.montoVigente)}, recibido ${cop(conc.recibidoBase)})`,
            });
            if (flagErr) {
                req.log?.error({ err: flagErr, paymentId: link.payment_id }, 'No se pudo dejar el rastro de la diferencia de monto');
            }
            req.log?.warn({ paymentId: link.payment_id, externalRef, faltante, sobrepago }, 'MP school payment: lo recibido no coincide con el cobro vigente');
        }

        await supabase
            .from('payment_links')
            .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            })
            .eq('id', link.id);

        await supabase
            .from('payment_splits')
            .insert({
                payment_id: link.payment_id,
                payment_link_id: link.id,
                payment_provider: 'mercadopago',
                provider_reference: externalRef,
                provider_transaction_id: paymentId,
                gross_amount: amount,
                // El recargo por pago online es de la ESCUELA (cubre la comisión que le
                // descuenta la pasarela) y entra completo a su cuenta. SportMaps cobra la
                // integración por fuera, no por transacción. Ver el comentario largo en
                // routes/wompi.ts, handleSchoolPayment.
                school_receives: amount,
                sportmaps_receives: 0,
                provider_fee: 0,
                transfer_status: 'pending',
                webhook_signature_valid: true,
            });

        // Notificar al staff de la escuela (dispara Modo Recepción + outbox).
        // No-bloqueante: el pago ya quedó paid igual.
        const { error: notifErr } = await supabase.rpc('notify_school_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (notifErr) {
            req.log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_school_payment_paid falló (no-bloqueante)');
        }

        // Y al PADRE. Mismo hueco que tenia Wompi: la funcion de arriba avisa
        // solo a la escuela, asi que quien pagaba por pasarela no se enteraba.
        const { error: padreErr } = await supabase.rpc('notify_parent_payment_paid', {
            p_payment_id: link.payment_id,
        });
        if (padreErr) {
            req.log?.warn({ err: padreErr, paymentId: link.payment_id }, 'notify_parent_payment_paid falló (no-bloqueante)');
        }

        req.log?.info({ paymentId: link.payment_id, externalRef }, 'MP school payment confirmed');
        return {
            status: 200,
            body: {
                status: 'ok', kind: 'school_payment',
                ...(sobrepago > 0 ? { overpayment: sobrepago } : {}),
                ...(faltante > 0 ? { underpayment: faltante, partial: true } : {}),
            },
        };
    }

    // Mismo tratamiento que Wompi (ver wompi.ts): el error del UPDATE se lee —
    // el CHECK de payment_links no admitía estos estados y el fallo se perdía
    // en silencio — y solo lo ambiguo (ERROR/VOIDED) bloquea el reintento.
    const { error: linkUpdErr } = await supabase
        .from('payment_links')
        .update({
            status: internalStatus === 'rejected' ? 'declined' : internalStatus,
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

    const isAmbiguous = internalStatus === 'failed' || internalStatus === 'refunded';

    const { error: trailErr } = await supabase.rpc(
        isAmbiguous ? 'flag_payment_for_review' : 'record_payment_failure',
        {
            p_kind: 'payment',
            p_id: link.payment_id,
            // MP manda el motivo humano en `status_detail` (cc_rejected_call_for_authorize…).
            p_reason: buildFailureReason('mp', internalStatus, paymentTypeId, payment, paymentId),
        },
    );
    if (trailErr) {
        req.log?.error({ err: trailErr, paymentId: link.payment_id }, 'No se pudo registrar el fallo del cobro');
    }

    // Mismo aviso que en Wompi: hasta ahora un rechazo no le llegaba a nadie.
    const { error: notifErr } = await supabase.rpc('notify_payment_attempt_failed', {
        p_payment_id: link.payment_id,
        p_reason: bankMessageFrom(payment),
        p_ambiguous: isAmbiguous,
    });
    if (notifErr) {
        req.log?.warn({ err: notifErr, paymentId: link.payment_id }, 'notify_payment_attempt_failed falló (no-bloqueante)');
    }

    void sendPaymentAttemptFailedEmails(link.payment_id, bankMessageFrom(payment), isAmbiguous, req.log);

    return {
        status: 200,
        body: { status: 'ok', kind: 'school_payment', internalStatus, flagged_for_review: isAmbiguous },
    };
}

async function handleMarketplaceTransaction(args: HandlerArgs): Promise<HandlerResult> {
    const { req, paymentId, externalRef, internalStatus, amount } = args;

    const { data: tx, error: txErr } = await supabase
        .from('marketplace_transactions')
        .select('id, gross_amount, status, provider_transaction_id')
        .eq('provider_reference', externalRef)
        .maybeSingle();

    if (txErr || !tx) {
        return { status: 200, body: { status: 'ignored', reason: 'tx_not_found' } };
    }

    if (tx.provider_transaction_id === paymentId && tx.status !== 'pending') {
        return { status: 200, body: { status: 'already_processed' } };
    }

    if (internalStatus === 'paid') {
        if (Math.abs(amount - Number(tx.gross_amount)) > 1) {
            return { status: 400, body: { error: 'amount_mismatch' } };
        }

        const { data: result, error } = await supabase.rpc('confirm_marketplace_payment', {
            p_transaction_id: tx.id,
            p_wompi_reference: externalRef,             // semantica: provider_reference
            p_wompi_transaction_id: paymentId,           // semantica: provider_transaction_id
            p_payment_method: 'mercadopago',
            p_provider: 'mercadopago',
        });

        if (error) {
            req.log?.error({ err: error, externalRef }, 'confirm_marketplace_payment failed');
            return { status: 500, body: { error: 'confirm_rpc_failed' } };
        }

        return { status: 200, body: { status: 'ok', kind: 'marketplace', result } };
    }

    await supabase
        .from('marketplace_transactions')
        .update({
            status: internalStatus === 'rejected' ? 'declined' : internalStatus,
            payment_provider: 'mercadopago',
            provider_transaction_id: paymentId,
            updated_at: new Date().toISOString(),
        })
        .eq('id', tx.id);

    await supabase.rpc('flag_payment_for_review', {
        p_kind: 'marketplace_transaction',
        p_id: tx.id,
        p_reason: `mp_${internalStatus} (payment_id=${paymentId})`,
    });

    return {
        status: 200,
        body: { status: 'ok', kind: 'marketplace', internalStatus, flagged_for_review: true },
    };
}

async function handleCartOrder(args: HandlerArgs): Promise<HandlerResult> {
    const { req, paymentId, externalRef, internalStatus, amount, paymentTypeId, payment } = args;

    const order = await findStoreOrderByReference(externalRef);
    if (!order) {
        return { status: 200, body: { status: 'ignored', reason: 'order_not_found' } };
    }

    if (internalStatus === 'paid') {
        if (!amountMatchesOrder(order.total_amount, { cop: amount })) {
            req.log?.error({ expected: order.total_amount, received: amount, externalRef }, 'MP cart order: amount mismatch');
            await supabase.rpc('flag_payment_for_review', {
                p_kind: 'order', p_id: order.id, p_reason: `mp_amount_mismatch (payment_id=${paymentId})`,
            });
            return { status: 400, body: { error: 'amount_mismatch' } };
        }

        // Un solo camino (M-F0-4): reservas, stock, kardex, settlements y eventos.
        const { data: result, error } = await supabase.rpc('confirm_order_payment', {
            p_order_id: order.id,
            p_wompi_reference: externalRef,
            p_wompi_transaction_id: paymentId,
            p_payment_method_type: paymentTypeId,
            p_provider: 'mercadopago',
        });
        if (error) {
            req.log?.error({ err: error, orderId: order.id }, 'MP confirm_order_payment failed');
            await supabase.rpc('flag_payment_for_review', {
                p_kind: 'order', p_id: order.id, p_reason: `mp_confirm_failed (payment_id=${paymentId})`,
            });
            return { status: 200, body: { status: 'review', error: error.message } };
        }
        if ((result as any)?.review) {
            return { status: 200, body: { status: 'review', kind: 'cart', result } };
        }
        return { status: 200, body: { status: 'ok', kind: 'cart', result } };
    }

    const { data: failRes, error: failErr } = await supabase.rpc('store_order_payment_failed', {
        p_order_id: order.id,
        p_provider: 'mercadopago',
        p_tx_id: paymentId,
        p_status: internalStatus,
        p_reason: buildFailureReason('mp', internalStatus, paymentTypeId, payment, paymentId),
    });
    if (failErr) {
        req.log?.error({ err: failErr, orderId: order.id }, 'MP store_order_payment_failed failed');
        return { status: 500, body: { error: 'cart_failure_update_failed' } };
    }
    return { status: 200, body: { status: 'ok', kind: 'cart', internalStatus, result: failRes } };
}

// RSV: reservas de canchas (F2). Logica compartida con Wompi en
// services/reservation-payments.service.ts (valida monto, confirmar_pago_reserva).
async function handleReservation(args: HandlerArgs): Promise<HandlerResult> {
    const { req, paymentId, externalRef, internalStatus, amount, payment } = args;
    return applyReservationPayment({
        provider: 'mercadopago',
        reference: externalRef,
        internalStatus,
        amountCop: amount,
        currency: String(payment?.currency_id ?? 'COP').toUpperCase(),
        eventId: paymentId,
        log: req.log,
    });
}

async function handleSessionBooking(args: HandlerArgs): Promise<HandlerResult> {
    const { req, paymentId, externalRef, internalStatus, amount } = args;

    const { data: booking } = await supabase
        .from('session_bookings')
        .select('id, user_id, price, payment_status, provider_transaction_id')
        .eq('provider_reference', externalRef)
        .maybeSingle();

    if (!booking) {
        return { status: 200, body: { status: 'ignored', reason: 'booking_not_found' } };
    }

    if (booking.provider_transaction_id === paymentId && booking.payment_status === 'paid') {
        return { status: 200, body: { status: 'already_processed' } };
    }

    if (internalStatus === 'paid') {
        if (Math.abs(amount - Number(booking.price)) > 1) {
            return { status: 400, body: { error: 'amount_mismatch' } };
        }

        const { data: result, error } = await supabase.rpc('confirm_session_booking_payment', {
            p_booking_id: booking.id,
            p_wompi_reference: externalRef,
            p_wompi_transaction_id: paymentId,
            p_provider: 'mercadopago',
        });

        if (error) {
            req.log?.error({ err: error }, 'confirm_session_booking_payment failed');
            return { status: 500, body: { error: 'confirm_rpc_failed' } };
        }

        return { status: 200, body: { status: 'ok', kind: 'session_booking', result } };
    }

    await supabase
        .from('session_bookings')
        .update({
            payment_status: internalStatus === 'rejected' ? 'failed' : internalStatus,
            payment_provider: 'mercadopago',
            provider_transaction_id: paymentId,
            updated_at: new Date().toISOString(),
        })
        .eq('id', booking.id);

    await supabase.rpc('flag_payment_for_review', {
        p_kind: 'session_booking',
        p_id: booking.id,
        p_reason: `mp_${internalStatus} (payment_id=${paymentId})`,
    });

    return {
        status: 200,
        body: { status: 'ok', kind: 'session_booking', internalStatus, flagged_for_review: true },
    };
}

// ─── Captura de tarjeta para autopay ──────────────────────────────────────
// MP requiere customer_id + card_id (no token unico). Solo intentamos guardar
// si el payer.email es conocido y el flujo viene de subscription/SCH.

async function maybeCaptureMpCard(
    req: Request,
    payment: MpPayment,
    externalRef: string,
    accessToken: string,
): Promise<void> {
    if (!payment.payer?.email) return;

    // Recuperar user_id desde la entidad
    const prefix = externalRef.split('-')[0];
    let userId: string | null = null;

    if (prefix === 'CART') {
        const { data } = await supabase.from('orders').select('user_id').eq('provider_reference', externalRef).maybeSingle();
        userId = data?.user_id || null;
    } else if (prefix === 'SCH') {
        const { data: link } = await supabase.from('payment_links').select('payment_id').eq('provider_reference', externalRef).maybeSingle();
        if (link?.payment_id) {
            const { data: pay } = await supabase.from('payments').select('user_id').eq('id', link.payment_id).maybeSingle();
            userId = pay?.user_id || null;
        }
    } else if (['SVC', 'EVT', 'SUB', 'MKT'].includes(prefix)) {
        const { data } = await supabase.from('marketplace_transactions').select('user_id').eq('provider_reference', externalRef).maybeSingle();
        userId = data?.user_id || null;
    } else if (prefix === 'BKG') {
        const { data } = await supabase.from('session_bookings').select('user_id').eq('provider_reference', externalRef).maybeSingle();
        userId = data?.user_id || null;
    }

    if (!userId) return;

    // MP no devuelve un card_token reutilizable directamente desde un payment.
    // Para autopay el frontend debe hacer un flujo separado: tokenizar la card
    // y llamar /payments/mp/save-card explicitamente. Aqui solo persistimos
    // metadata si la card aparece en el payment.
    if (!payment.card?.last_four_digits) return;

    // Firma nueva (12 args, p_payment_provider enum). La vieja de 11 args con
    // p_wompi_token/p_provider se elimina en F2 del débito automático.
    await supabase.rpc('save_payment_token', {
        p_user_id: userId,
        p_payment_provider: 'mercadopago',
        p_provider_token: `mp_${payment.id}`,               // sintetico: marca que fue MP
        p_provider_customer_id: null,
        p_provider_card_id: null,
        p_provider_payment_source_id: null,
        p_payment_method_type: payment.payment_method_id || 'CARD',
        p_last_four: payment.card.last_four_digits,
        p_brand: null,
        p_holder_name: payment.card.cardholder?.name ?? null,
        p_expires_at: null,
        p_set_default: false,
    });

    req.log?.info({ userId, externalRef }, 'MP card metadata captured');
}

// ─── POST /api/v1/payments/mp/create — desde Brick onSubmit ────────────────

// requireAuth: sin esto, cualquiera en internet podía cobrar tarjetas
// arbitrarias contra el access_token real de una escuela/vendor (carding).
paymentsRouter.post('/create', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const {
            token,
            paymentMethodId,
            installments,
            payerEmail,
            payerFirstName,
            payerLastName,
            payerIdentification,            // { type: 'CC'|'CE'|'NIT'|'PAS', number: '...' }
            transactionAmount,
            description,
            externalReference,
            schoolId,
            vendorId,
            metadata,
            items,                          // opcional: items[] para additional_info
            statementDescriptor,            // opcional: por default 'SPORTMAPS'
        } = req.body ?? {};

        const missing: string[] = [];
        if (!token) missing.push('token');
        if (!paymentMethodId) missing.push('paymentMethodId');
        if (!transactionAmount) missing.push('transactionAmount');
        if (!payerEmail) missing.push('payerEmail');
        if (!externalReference) missing.push('externalReference');
        if (missing.length) {
            req.log?.warn({ missing, body: req.body }, 'MP /create missing_fields');
            return res.status(400).json({ error: 'missing_fields', missing });
        }

        const baseUrl = process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.get('host')}`;

        // Tienda (tienda v2 F0, D-5 = A): la orden decide el comercio (el
        // vendedor) y el monto (orders.total_amount). Se ignoran schoolId,
        // vendorId y transactionAmount del body.
        let config: ResolvedProvider | null;
        let notificationUrl: string;
        let amountToCharge = Number(transactionAmount);
        if (String(externalReference).startsWith('CART-')) {
            const order = await findStoreOrderByReference(String(externalReference));
            if (!order || order.user_id !== req.user.id) {
                return res.status(404).json({ error: 'order_not_found' });
            }
            if (order.status !== 'pending_payment' || order.payment_method !== 'mercadopago') {
                return res.status(409).json({ error: 'order_not_payable', status: order.status });
            }
            try {
                config = await sellerGatewayForOrder(order);
            } catch (e) {
                if (e instanceof SellerGatewayError) {
                    return res.status(409).json({ error: 'SELLER_GATEWAY_NOT_CONFIGURED' });
                }
                throw e;
            }
            amountToCharge = Number(order.total_amount);
            notificationUrl = `${baseUrl}/api/v1/webhooks/mercadopago/webhook/order/${order.id}`;
        } else {
            config = await loadProviderConfig({
                provider: 'mercadopago',
                schoolId: schoolId ?? null,
                vendorId: vendorId ?? null,
            });
            // Con escuela conocida se manda la URL por escuela, para que el webhook
            // sepa a qué comercio preguntarle sin usar la llave global. Sin escuela
            // (vendor/marketplace) queda la legacy.
            notificationUrl = schoolId
                ? `${baseUrl}/api/v1/webhooks/mercadopago/webhook/${schoolId}`
                : `${baseUrl}/api/v1/webhooks/mercadopago/webhook`;
        }

        if (!config) {
            return res.status(500).json({ error: 'mp_provider_not_configured' });
        }

        const result = await createMpPayment({
            accessToken: config.accessToken!,
            token,
            paymentMethodId,
            installments,
            payerEmail,
            payerFirstName,
            payerLastName,
            payerIdentification: payerIdentification?.type && payerIdentification?.number
                ? { type: String(payerIdentification.type), number: String(payerIdentification.number) }
                : undefined,
            transactionAmount: amountToCharge,
            description: description || `SportMaps ${externalReference}`,
            externalReference,
            notificationUrl,
            statementDescriptor,
            items: Array.isArray(items) && items.length ? items : undefined,
            metadata: { ...(metadata ?? {}), schoolId, vendorId },
        });

        if (!result.ok) {
            req.log?.error({ err: result.error }, 'MP create payment failed');
            return res.status(result.status ?? 502).json({ error: result.error });
        }

        return res.status(200).json({
            paymentId: result.payment.id,
            status: result.payment.status,
            statusDetail: result.payment.status_detail,
            internalStatus: mapMpStatus(result.payment.status),
            externalReference: result.payment.external_reference,
        });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'Error in /payments/mp/create');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// ─── POST /api/v1/payments/mp/save-card — autopay setup ───────────────────

// requireAuth + req.user.id: sin esto, cualquiera podía plantar/sobrescribir
// el método de pago por defecto de OTRO usuario mandando su userId en el body.
paymentsRouter.post('/save-card', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { cardToken, payerEmail, schoolId, vendorId, setDefault } = req.body ?? {};
        const userId = req.user.id;

        if (!cardToken || !payerEmail) {
            return res.status(400).json({ error: 'missing_fields' });
        }

        const config = await loadProviderConfig({
            provider: 'mercadopago',
            schoolId: schoolId ?? null,
            vendorId: vendorId ?? null,
        });

        if (!config?.accessToken) {
            return res.status(500).json({ error: 'mp_provider_not_configured' });
        }

        const result = await saveMpCustomerCard({
            accessToken: config.accessToken,
            payerEmail,
            cardToken,
        });

        if (!result.ok) {
            return res.status(502).json({ error: result.error });
        }

        const syntheticToken = `${result.customerId}:${result.cardId}`;

        const { data: rpcResult, error: rpcErr } = await supabase.rpc('save_payment_token', {
            p_user_id: userId,
            p_payment_provider: 'mercadopago',
            p_provider_token: syntheticToken,
            p_provider_customer_id: result.customerId,
            p_provider_card_id: result.cardId,
            p_provider_payment_source_id: null,
            p_payment_method_type: 'CARD',
            p_last_four: result.lastFour ?? null,
            p_brand: result.brand ?? null,
            p_holder_name: null,
            p_expires_at: null,
            p_set_default: !!setDefault,
        });

        if (rpcErr) {
            return res.status(500).json({ error: 'persist_token_failed', details: rpcErr.message });
        }

        return res.status(200).json({
            ok: true,
            tokenId: rpcResult?.token_id,
            lastFour: result.lastFour,
            brand: result.brand,
        });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'Error in /payments/mp/save-card');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

// ─── GET /api/v1/payments/providers — para frontend gate ──────────────────

paymentsRouter.get('/providers', async (req: Request, res: Response) => {
    try {
        const schoolId = (req.query.schoolId as string) || null;
        const vendorId = (req.query.vendorId as string) || null;

        // Importacion lazy para evitar ciclo
        const { listProvidersForSchool, listProvidersForVendor, listProvidersForMarketplace } =
            await import('../services/payment-provider.resolver');

        let providers;
        if (schoolId) providers = await listProvidersForSchool(schoolId);
        else if (vendorId) providers = await listProvidersForVendor(vendorId);
        else providers = listProvidersForMarketplace();

        return res.status(200).json({ providers });
    } catch (err: any) {
        req.log?.error({ err: err?.message || err }, 'Error listing providers');
        return res.status(500).json({ error: 'internal_server_error' });
    }
});

export { webhookRouter, paymentsRouter };
export default webhookRouter;
