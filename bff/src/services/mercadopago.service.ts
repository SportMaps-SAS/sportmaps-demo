/**
 * mercadopago.service — Capa unificada de integracion con MercadoPago.
 *
 * MercadoPago opera con Bricks cliente-side + API server-to-server:
 *  - El frontend usa <Payment /> Brick (@mercadopago/sdk-react) con publicKey
 *    para tokenizar la tarjeta o seleccionar PSE/efectivo.
 *  - El Brick devuelve { token, paymentMethodId, installments, payer } al
 *    onSubmit; el frontend los manda al BFF.
 *  - El BFF llama POST /v1/payments con el token, external_reference y
 *    notification_url. MercadoPago retorna { id, status, ... }.
 *  - MercadoPago llama al webhook (/api/v1/webhooks/mercadopago) cuando el
 *    payment cambia de estado. El webhook valida x-signature y reconcilia.
 *
 * Diferencias clave vs Wompi:
 *  - MP usa monto decimal (transaction_amount) en COP, no centavos.
 *  - El webhook trae solo { type, data: { id } }; hay que llamar GET
 *    /v1/payments/{id} para obtener todo (mismo patron de re-fetch que Wompi).
 *  - Tokens de tarjeta para autopay: necesitas customer.id + card.id, no un
 *    token unico como Wompi.
 *
 * NUNCA exponer MP_ACCESS_TOKEN ni MP_WEBHOOK_SECRET al cliente.
 * El access_token y webhook_secret se leen desde school_payment_providers
 * o vendor_payment_providers segun corresponda; el ENV MP_ACCESS_TOKEN_DEFAULT
 * es solo para flujos sin escuela/vendor (marketplace global).
 */

import crypto from 'crypto';
import { supabase } from '../config/supabase';

const MP_API_BASE = 'https://api.mercadopago.com';

export type MpStatus =
    | 'approved'
    | 'pending'
    | 'in_process'
    | 'authorized'
    | 'rejected'
    | 'cancelled'
    | 'refunded'
    | 'charged_back';

export interface MpPayment {
    id: number;
    status: MpStatus;
    status_detail: string;
    external_reference: string | null;
    transaction_amount: number;
    currency_id: string;            // 'COP', 'ARS', 'BRL', 'MXN', etc.
    payment_method_id: string;      // 'visa', 'master', 'pse', 'efecty', ...
    payment_type_id: string;        // 'credit_card', 'debit_card', 'bank_transfer', 'ticket', ...
    payer: {
        id?: string;
        email?: string;
        type?: 'customer' | 'guest';
    };
    metadata?: Record<string, unknown>;
    date_approved?: string | null;
    date_created?: string;
    refunds?: Array<{ id: number; amount: number; status: string }>;
    card?: {
        last_four_digits?: string;
        cardholder?: { name?: string };
        first_six_digits?: string;
    };
    additional_info?: {
        items?: Array<{ id?: string; title?: string }>;
    };
}

export interface MpProviderConfig {
    accessToken: string;
    webhookSecret: string | null;
    publicKey: string;
    sandbox: boolean;
}

// ─── Reference generation (espejo de wompi) ───────────────────────────────

export type MpSource =
    | 'school_payment'
    | 'service'
    | 'event'
    | 'subscription'
    | 'vendor_sub'
    | 'cart'
    | 'marketplace_pay'
    | 'session_booking';

const PREFIX_MAP: Record<MpSource, string> = {
    school_payment: 'SCH',
    service: 'SVC',
    event: 'EVT',
    subscription: 'SUB',
    vendor_sub: 'VSUB',
    cart: 'CART',
    marketplace_pay: 'MKT',
    session_booking: 'BKG',
};

/**
 * Genera una external_reference unica para MercadoPago.
 * Mismo formato que Wompi pero con sufijo MP para distinguir el provider
 * sin lookup en BD: <prefix>-MP-<timestamp36>-<random>
 */
export function generateMpReference(source: MpSource): string {
    const prefix = PREFIX_MAP[source];
    const ts = Date.now().toString(36).toUpperCase();
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `${prefix}-MP-${ts}-${rand}`;
}

// ─── Provider config loader ────────────────────────────────────────────────

/**
 * Lee el access_token + webhook_secret desde school_payment_providers o
 * vendor_payment_providers. Si no hay config especifica, cae al ENV
 * MP_ACCESS_TOKEN_DEFAULT (marketplace global de SportMaps).
 *
 * Retorna null si el provider 'mercadopago' no esta habilitado para la escuela/vendor.
 */
export async function loadMpConfig(params: {
    schoolId?: string | null;
    vendorId?: string | null;
}): Promise<MpProviderConfig | null> {
    const { schoolId, vendorId } = params;

    if (schoolId) {
        const { data, error } = await supabase
            .from('school_payment_providers')
            .select('public_key, access_token, webhook_secret, sandbox, enabled')
            .eq('school_id', schoolId)
            .eq('provider', 'mercadopago')
            .maybeSingle();

        if (error) {
            console.error('[mercadopago.service] loadMpConfig school error:', error.message);
        }
        if (data?.enabled) {
            return {
                accessToken: data.access_token,
                webhookSecret: data.webhook_secret,
                publicKey: data.public_key,
                sandbox: data.sandbox,
            };
        }
    }

    if (vendorId) {
        const { data, error } = await supabase
            .from('vendor_payment_providers')
            .select('public_key, access_token, webhook_secret, sandbox, enabled')
            .eq('vendor_id', vendorId)
            .eq('provider', 'mercadopago')
            .maybeSingle();

        if (error) {
            console.error('[mercadopago.service] loadMpConfig vendor error:', error.message);
        }
        if (data?.enabled) {
            return {
                accessToken: data.access_token,
                webhookSecret: data.webhook_secret,
                publicKey: data.public_key,
                sandbox: data.sandbox,
            };
        }
    }

    // Fallback: SportMaps default (marketplace global)
    const accessToken = process.env.MP_ACCESS_TOKEN_DEFAULT;
    const publicKey = process.env.MP_PUBLIC_KEY_DEFAULT;
    const webhookSecret = process.env.MP_WEBHOOK_SECRET_DEFAULT ?? null;
    // El SANDBOX lo decide la CREDENCIAL, no la variable. MercadoPago no tiene
    // host de sandbox: `MP_API_BASE` es una sola URL y lo que separa producción
    // de prueba es el prefijo del token. Con `MP_ENV=sandbox` y un token
    // `APP_USR-` el cobro es REAL, y antes esta línea devolvía `sandbox: true`
    // creyéndole a la variable. Ver el guard de arranque en assertMpEnvCoherente().
    const sandbox = esCredencialDePrueba(accessToken);

    if (!accessToken || !publicKey) return null;
    return { accessToken, publicKey, webhookSecret, sandbox };
}

/**
 * ¿La credencial es de PRUEBA? En MercadoPago lo dice el prefijo:
 *   TEST-…      → sandbox
 *   APP_USR-…   → PRODUCCIÓN, cobra de verdad
 * Sin credencial se asume prueba: no hay con qué cobrar.
 */
export function esCredencialDePrueba(token?: string | null): boolean {
    if (!token) return true;
    return token.trim().toUpperCase().startsWith('TEST-');
}

/**
 * Guard de arranque (DIN-9). Aborta el proceso si `MP_ENV` dice una cosa y la
 * credencial dice otra.
 *
 * El caso real que motiva esto: en dev había `MP_ENV=sandbox` con
 * `MP_ACCESS_TOKEN_DEFAULT=APP_USR-…`, que en MercadoPago es PRODUCCIÓN. Como
 * `MARKETPLACE_DEFAULT_PROVIDER=mercadopago`, un pago «de prueba» lanzado desde
 * dev cobraba plata de verdad. El síntoma es invisible: la app no falla, cobra.
 *
 * Falla al arrancar y no en la primera transacción a propósito: descubrirlo con
 * un cobro real ya es tarde.
 */
export function assertMpEnvCoherente(): void {
    const token = process.env.MP_ACCESS_TOKEN_DEFAULT;
    const pub = process.env.MP_PUBLIC_KEY_DEFAULT;
    if (!token && !pub) return;   // sin credenciales globales no hay nada que validar

    const declaraProduccion = (process.env.MP_ENV ?? 'sandbox').toLowerCase() === 'production';
    const tokenEsPrueba = esCredencialDePrueba(token);
    const pubEsPrueba = esCredencialDePrueba(pub);

    // 1. El token y la llave pública tienen que ser del mismo mundo.
    if (token && pub && tokenEsPrueba !== pubEsPrueba) {
        throw new Error(
            '[MP] MP_ACCESS_TOKEN_DEFAULT y MP_PUBLIC_KEY_DEFAULT son de ambientes distintos '
            + `(token=${tokenEsPrueba ? 'TEST' : 'APP_USR'}, public_key=${pubEsPrueba ? 'TEST' : 'APP_USR'}). `
            + 'Corregí las credenciales antes de arrancar.',
        );
    }

    // 2. Y tienen que coincidir con lo que declara MP_ENV.
    if (declaraProduccion !== !tokenEsPrueba) {
        throw new Error(
            `[MP] MP_ENV=${process.env.MP_ENV ?? '(sin definir → sandbox)'} pero la credencial es `
            + `${tokenEsPrueba ? 'TEST- (prueba)' : 'APP_USR- (PRODUCCION: COBRA DE VERDAD)'}. `
            + 'En MercadoPago no hay host de sandbox: manda la credencial, no la variable. '
            + (tokenEsPrueba
                ? 'Poné MP_ENV=sandbox, o usá credenciales APP_USR- si de verdad es producción.'
                : 'Usá credenciales TEST- en dev/staging, o poné MP_ENV=production si esto ES producción.'),
        );
    }
}

// ─── Webhook signature validation ──────────────────────────────────────────

/**
 * Valida la firma del webhook de MercadoPago.
 *
 * Headers que MP envia:
 *  - x-signature: "ts=1742505638683,v1=abc123..."
 *  - x-request-id: "<uuid>"
 *
 * Body (POST a notification_url):
 *  { type: "payment", action: "payment.updated", data: { id: "1234" } }
 *
 * Algoritmo:
 *  manifest = `id:${data.id};request-id:${xRequestId};ts:${ts};`
 *  expected = HMAC_SHA256_HEX(secret, manifest)
 *  match     = expected === v1
 *
 * Si webhookSecret es null (no configurado), retorna true en sandbox y
 * false en produccion (fail-closed en prod).
 */
export function validateMpWebhookSignature(params: {
    xSignature: string | undefined;
    xRequestId: string | undefined;
    dataId: string | number | undefined;
    secret: string | null;
    isSandbox: boolean;
}): boolean {
    const { xSignature, xRequestId, dataId, secret, isSandbox } = params;

    if (!secret) {
        if (isSandbox) {
            console.warn('[mercadopago.service] webhook secret missing — allowing in sandbox only');
            return true;
        }
        return false;
    }

    if (!xSignature || !xRequestId || !dataId) return false;

    // Parse "ts=...,v1=..."
    const parts = xSignature.split(',').map(p => p.trim());
    let ts: string | undefined;
    let v1: string | undefined;
    for (const part of parts) {
        const [k, ...rest] = part.split('=');
        const value = rest.join('=');
        if (k === 'ts') ts = value;
        else if (k === 'v1') v1 = value;
    }

    if (!ts || !v1) return false;

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    // Timing-safe compare
    if (expected.length !== v1.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'));
}

// ─── Fetch payment (anti-spoofing + reconciliation) ────────────────────────

export async function fetchMpPayment(
    paymentId: string | number,
    accessToken: string,
): Promise<MpPayment | null> {
    try {
        const res = await fetch(`${MP_API_BASE}/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
            console.error('[mercadopago.service] fetchMpPayment failed:', res.status, await res.text());
            return null;
        }
        return (await res.json()) as MpPayment;
    } catch (err) {
        console.error('[mercadopago.service] fetchMpPayment error:', err);
        return null;
    }
}

// ─── Create payment (server-to-server tras tokenizar el Brick) ─────────────

export interface MpIdentification {
    type: string;                           // 'CC', 'CE', 'NIT', 'PAS' (CO)
    number: string;
}

export interface MpItem {
    id: string;
    title: string;
    description?: string;
    categoryId?: string;                    // 'services', 'tickets', 'learnings', ...
    quantity?: number;
    unitPrice?: number;                     // si null usa transactionAmount
}

export interface CreateMpPaymentParams {
    accessToken: string;
    token: string;                          // viene del Payment Brick
    paymentMethodId: string;                // 'visa', 'master', 'pse', 'efecty', ...
    transactionAmount: number;              // COP decimal (no cents)
    description: string;
    installments?: number;
    payerEmail: string;
    payerFirstName?: string;
    payerLastName?: string;
    payerIdentification?: MpIdentification; // CC/CE — sube tasa de aprobacion
    externalReference: string;
    notificationUrl: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;                // X-Idempotency-Key (UUID)
    statementDescriptor?: string;           // texto en extracto del payer (max 22 chars)
    binaryMode?: boolean;                   // true: solo aprueba o rechaza, sin pendings
    items?: MpItem[];                       // additional_info.items — sube tasa de aprobacion
}

/**
 * Mapea el prefijo de external_reference al category_id que MP espera.
 * Lista de category_id soportadas: https://api.mercadopago.com/item_categories
 */
export function mpCategoryFromReference(externalReference: string): string {
    const prefix = externalReference.split('-')[0]?.toUpperCase();
    switch (prefix) {
        case 'EVT':
            return 'tickets';
        case 'SVC':
        case 'SCH':
        case 'SUB':
        case 'BKG':
            return 'services';
        case 'CART':
        case 'MKT':
            return 'services';
        default:
            return 'services';
    }
}

export async function createMpPayment(
    params: CreateMpPaymentParams,
): Promise<{ ok: true; payment: MpPayment } | { ok: false; error: string; status?: number }> {
    const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();

    const items: MpItem[] = params.items?.length
        ? params.items
        : [{
            id: params.externalReference,
            title: params.description.slice(0, 256),
            description: params.description,
            categoryId: mpCategoryFromReference(params.externalReference),
            quantity: 1,
            unitPrice: Number(params.transactionAmount),
        }];

    const payer: Record<string, unknown> = {
        email: params.payerEmail,
        first_name: params.payerFirstName,
        last_name: params.payerLastName,
    };
    if (params.payerIdentification?.type && params.payerIdentification?.number) {
        payer.identification = {
            type: params.payerIdentification.type,
            number: params.payerIdentification.number,
        };
    }

    const body: Record<string, unknown> = {
        transaction_amount: Number(params.transactionAmount),
        token: params.token,
        description: params.description,
        installments: params.installments ?? 1,
        payment_method_id: params.paymentMethodId,
        statement_descriptor: (params.statementDescriptor ?? 'SPORTMAPS').slice(0, 22),
        binary_mode: params.binaryMode ?? true,
        payer,
        additional_info: {
            items: items.map(item => ({
                id: item.id,
                title: item.title.slice(0, 256),
                description: (item.description ?? item.title).slice(0, 600),
                category_id: item.categoryId ?? 'services',
                quantity: item.quantity ?? 1,
                unit_price: Number(item.unitPrice ?? params.transactionAmount),
            })),
            payer: {
                first_name: params.payerFirstName,
                last_name: params.payerLastName,
            },
        },
        external_reference: params.externalReference,
        notification_url: params.notificationUrl,
        metadata: params.metadata ?? {},
    };

    try {
        const res = await fetch(`${MP_API_BASE}/v1/payments`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.accessToken}`,
                'X-Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errBody = await res.text();
            return { ok: false, error: `mp_create_payment_failed: ${errBody.slice(0, 500)}`, status: res.status };
        }
        const payment = (await res.json()) as MpPayment;
        return { ok: true, payment };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'createMpPayment_error' };
    }
}

// ─── Checkout Pro: preferencia con monto exacto y vencimiento ──────────────

export interface CreateMpPreferenceParams {
    accessToken: string;                    // access_token DE LA ESCUELA (nunca el de SportMaps)
    title: string;
    amount: number;                         // COP entero
    externalReference: string;
    notificationUrl: string;
    /** Hasta cuándo se puede pagar (ISO). Se manda como expiration_date_to. */
    expiresAt: string;
    backUrl?: string | null;
    payerEmail?: string | null;
    /** X-Idempotency-Key: el mismo checkout reintentado devuelve la MISMA preferencia. */
    idempotencyKey: string;
}

export async function createMpPreference(
    params: CreateMpPreferenceParams,
): Promise<{ ok: true; id: string; initPoint: string; sandboxInitPoint: string | null } | { ok: false; error: string; status?: number }> {
    const body: Record<string, unknown> = {
        items: [{
            id: params.externalReference,
            title: params.title.slice(0, 256),
            category_id: mpCategoryFromReference(params.externalReference),
            quantity: 1,
            currency_id: 'COP',
            unit_price: Number(params.amount),
        }],
        external_reference: params.externalReference,
        notification_url: params.notificationUrl,
        statement_descriptor: 'SPORTMAPS',
        binary_mode: true,
        expires: true,
        expiration_date_from: new Date().toISOString(),
        expiration_date_to: params.expiresAt,
    };
    if (params.payerEmail) body.payer = { email: params.payerEmail };
    if (params.backUrl) {
        body.back_urls = { success: params.backUrl, pending: params.backUrl, failure: params.backUrl };
        body.auto_return = 'approved';
    }

    try {
        const res = await fetch(`${MP_API_BASE}/checkout/preferences`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.accessToken}`,
                'X-Idempotency-Key': params.idempotencyKey,
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const errBody = await res.text();
            return { ok: false, error: `mp_create_preference_failed: ${errBody.slice(0, 500)}`, status: res.status };
        }
        const json: any = await res.json();
        if (!json?.id || !json?.init_point) return { ok: false, error: 'mp_create_preference_invalid_response' };
        return { ok: true, id: String(json.id), initPoint: String(json.init_point), sandboxInitPoint: json.sandbox_init_point ?? null };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'createMpPreference_error' };
    }
}

// ─── Charge with saved card (autopay para suscripciones) ───────────────────

export interface ChargeMpSavedCardParams {
    accessToken: string;
    customerId: string;                     // payment_tokens.provider_customer_id
    cardId: string;                         // payment_tokens.provider_card_id
    transactionAmount: number;
    description: string;
    payerEmail: string;
    externalReference: string;
    notificationUrl: string;
    paymentMethodId?: string;               // 'visa', 'master', etc. (deducir de la card si null)
    idempotencyKey?: string;
}

/**
 * Crea un pago server-to-server usando una tarjeta guardada del customer.
 * Flujo MP para "merchant initiated transactions":
 *  1. Generar card token desde customer/card (en backend, requiere access_token)
 *  2. POST /v1/payments con ese token + payer.type='customer', payer.id=<customer_id>
 *
 * Ref: https://www.mercadopago.com.ar/developers/en/docs/checkout-api/customers-and-cards
 */
export async function chargeMpSavedCard(
    params: ChargeMpSavedCardParams,
): Promise<{ ok: true; payment: MpPayment } | { ok: false; error: string }> {
    try {
        // 1. Crear card_token a partir del card guardado
        const tokenRes = await fetch(`${MP_API_BASE}/v1/card_tokens`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.accessToken}`,
            },
            body: JSON.stringify({
                card_id: params.cardId,
                customer_id: params.customerId,
            }),
        });

        if (!tokenRes.ok) {
            const errBody = await tokenRes.text();
            return { ok: false, error: `mp_card_token_failed: ${errBody.slice(0, 300)}` };
        }
        const tokenJson = await tokenRes.json();
        const cardToken = tokenJson?.id;
        if (!cardToken) return { ok: false, error: 'mp_no_card_token_id' };

        // 2. Crear payment usando el card_token
        const result = await createMpPayment({
            accessToken: params.accessToken,
            token: cardToken,
            paymentMethodId: params.paymentMethodId ?? 'visa',     // se sobreescribe por la card
            transactionAmount: params.transactionAmount,
            description: params.description,
            installments: 1,
            payerEmail: params.payerEmail,
            externalReference: params.externalReference,
            notificationUrl: params.notificationUrl,
            idempotencyKey: params.idempotencyKey,
            metadata: { customer_id: params.customerId, card_id: params.cardId },
        });

        return result;
    } catch (err: any) {
        return { ok: false, error: err?.message || 'chargeMpSavedCard_error' };
    }
}

// ─── Refund ────────────────────────────────────────────────────────────────

export async function refundMpPayment(params: {
    accessToken: string;
    paymentId: string | number;
    amount?: number;                        // omitir para refund total
    idempotencyKey?: string;
}): Promise<{ ok: true; refundId: string } | { ok: false; error: string }> {
    const idempotencyKey = params.idempotencyKey ?? crypto.randomUUID();

    try {
        const body: Record<string, unknown> = {};
        if (params.amount !== undefined) body.amount = params.amount;

        const res = await fetch(`${MP_API_BASE}/v1/payments/${params.paymentId}/refunds`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.accessToken}`,
                'X-Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errBody = await res.text();
            return { ok: false, error: `mp_refund_failed: ${errBody.slice(0, 300)}` };
        }

        const json = await res.json();
        return { ok: true, refundId: String(json?.id ?? '') };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'refundMpPayment_error' };
    }
}

// ─── Status mapping ────────────────────────────────────────────────────────

export type InternalStatus = 'paid' | 'rejected' | 'refunded' | 'failed' | 'pending';

/**
 * Traduce el estado de MercadoPago al interno.
 *
 * `in_mediation` es una disputa abierta: MP RETIENE la plata mientras se
 * resuelve. No es un fallo — cae en 'pending' porque el dinero sigue vivo.
 * Antes caía en el `failed` de abajo y le decía a la escuela que el cobro
 * habia rebotado cuando MP todavía lo tenía.
 *
 * El default es 'failed' a propósito y NO se cambia a 'pending' como en Wompi:
 * los nueve estados documentados de MP están todos arriba, así que llegar acá
 * significa un estado que no conocemos, y para MP eso es más seguro tratarlo
 * como fallo (no cobra de más) que como pendiente (dejaría un cobro colgado
 * esperando para siempre). Si MP agrega un estado, agregarlo arriba.
 */
export function mapMpStatus(status: string): InternalStatus {
    const s = (status ?? '').toLowerCase();
    if (s === 'approved') return 'paid';
    if (s === 'pending' || s === 'in_process' || s === 'authorized' || s === 'in_mediation') return 'pending';
    if (s === 'rejected' || s === 'cancelled') return 'rejected';
    if (s === 'refunded' || s === 'charged_back') return 'refunded';
    return 'failed';
}

// ─── Save card to MP customer (for autopay) ────────────────────────────────

/**
 * Crea un customer en MP (idempotente por email) y asocia una tarjeta a partir
 * de un card_token (one-shot, expirable). Retorna { customerId, cardId } para
 * persistir en payment_tokens.
 */
export async function saveMpCustomerCard(params: {
    accessToken: string;
    payerEmail: string;
    cardToken: string;
}): Promise<
    | { ok: true; customerId: string; cardId: string; lastFour?: string; brand?: string }
    | { ok: false; error: string }
> {
    try {
        // 1. Buscar customer existente por email
        let customerId: string | undefined;
        const searchRes = await fetch(
            `${MP_API_BASE}/v1/customers/search?email=${encodeURIComponent(params.payerEmail)}`,
            { headers: { Authorization: `Bearer ${params.accessToken}` } },
        );
        if (searchRes.ok) {
            const searchJson = await searchRes.json();
            customerId = searchJson?.results?.[0]?.id;
        }

        // 2. Crear customer si no existe
        if (!customerId) {
            const createRes = await fetch(`${MP_API_BASE}/v1/customers`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${params.accessToken}`,
                },
                body: JSON.stringify({ email: params.payerEmail }),
            });
            if (!createRes.ok) {
                const errBody = await createRes.text();
                return { ok: false, error: `mp_create_customer_failed: ${errBody.slice(0, 300)}` };
            }
            const createJson = await createRes.json();
            customerId = createJson?.id;
            if (!customerId) return { ok: false, error: 'mp_no_customer_id' };
        }

        // 3. Asociar la tarjeta al customer
        const cardRes = await fetch(`${MP_API_BASE}/v1/customers/${customerId}/cards`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${params.accessToken}`,
            },
            body: JSON.stringify({ token: params.cardToken }),
        });

        if (!cardRes.ok) {
            const errBody = await cardRes.text();
            return { ok: false, error: `mp_save_card_failed: ${errBody.slice(0, 300)}` };
        }

        const cardJson = await cardRes.json();
        return {
            ok: true,
            customerId,
            cardId: String(cardJson?.id ?? ''),
            lastFour: cardJson?.last_four_digits,
            brand: cardJson?.payment_method?.name,
        };
    } catch (err: any) {
        return { ok: false, error: err?.message || 'saveMpCustomerCard_error' };
    }
}
