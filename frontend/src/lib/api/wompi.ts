// Wompi Payment Gateway Integration Service
//
// REGLA (Dynasty, "La firma es inválida" ago-oct 2026): la llave pública y la firma de
// integridad del Widget salen SIEMPRE del BFF, que las calcula con el MISMO par de
// credenciales del comercio que cobra. Este módulo ya no lee VITE_WOMPI_PUBLIC_KEY ni
// pide la firma a la Edge Function `wompi-sign`: mezclar una llave de build con una
// firma de otro lado mandaba el pago al comercio sandbox 11981889. Si el BFF no las
// entrega, el checkout no abre (falla cerrado con un mensaje claro).

import { cargarWidgetWompi } from '@/lib/wompiWidget';

/**
 * Genera una referencia única para iniciar un checkout de Wompi.
 * Prefijo `SCH-` indica pago de escuela (ver bff/src/routes/wompi.ts:128).
 */
export function generatePaymentReference(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `SCH-${ts}-${rand}`;
}

export interface WompiCheckoutConfig {
    reference: string;
    amountInCents: number;
    customerEmail: string;
    customerName: string;
    customerPhone?: string;
    redirectUrl?: string;
    // Documento del comprador — prellenar para no depender del desplegable
    // interno del Widget (que en algunos Android no despliega opciones).
    legalId?: string;
    legalIdType?: string;
    // SportMaps metadata
    studentName?: string;
    teamName?: string;
    schoolName?: string;
    schoolId?: string;
    /**
     * Firma de integridad calculada por el BFF (`create-session`, tienda, cobro público)
     * con el integrity secret del comercio que cobra. OBLIGATORIA: sin ella no se abre.
     */
    signature?: string | null;
    /**
     * Public key del comercio que cobra, resuelta por el BFF. OBLIGATORIA: no hay llave
     * de build de respaldo.
     */
    publicKey?: string | null;
}

/** El checkout no se puede abrir con datos confiables: no es una cancelación. */
export class WompiCheckoutNoDisponibleError extends Error {
    constructor(public code: 'sin_llave_del_bff' | 'sin_firma_del_bff', message: string) {
        super(message);
        this.name = 'WompiCheckoutNoDisponibleError';
    }
}

export const MENSAJE_WOMPI_NO_DISPONIBLE =
    'El pago en línea no está disponible en este momento. '
    + 'Puedes pagar por transferencia y subir tu comprobante, o intentar más tarde.';

/**
 * Llave + firma que el Widget va a usar. Ambas del BFF; si falta cualquiera, lanza.
 * Exportada para fijar la regla en tests.
 */
export function credencialesDelWidget(config: Pick<WompiCheckoutConfig, 'publicKey' | 'signature'>): {
    publicKey: string;
    signature: string;
} {
    const publicKey = (config.publicKey ?? '').trim();
    const signature = (config.signature ?? '').trim();
    if (!publicKey) {
        console.error('❌ Wompi: el BFF no devolvió la llave pública del comercio; no se abre el checkout.');
        throw new WompiCheckoutNoDisponibleError('sin_llave_del_bff', MENSAJE_WOMPI_NO_DISPONIBLE);
    }
    if (!signature) {
        console.error('❌ Wompi: el BFF no devolvió la firma de integridad; no se abre el checkout.');
        throw new WompiCheckoutNoDisponibleError('sin_firma_del_bff', MENSAJE_WOMPI_NO_DISPONIBLE);
    }
    return { publicKey, signature };
}

/**
 * Mensaje para la familia cuando el checkout se cerró por llave/firma no confiables,
 * venga del frontend (WompiCheckoutNoDisponibleError) o del BFF (503 con code wompi_*).
 * null si el error es otro.
 */
export function mensajeCheckoutNoDisponible(error: unknown): string | null {
    if (error instanceof WompiCheckoutNoDisponibleError) return error.message;
    const e = error as { status?: number; message?: string; body?: { code?: unknown } } | null;
    const code = e?.body?.code;
    if (typeof code === 'string' && code.startsWith('wompi_') && e?.message) return e.message;
    return null;
}

export interface WompiTransactionResult {
    id: string;
    status: 'APPROVED' | 'DECLINED' | 'ERROR' | 'VOIDED' | 'PENDING';
    reference: string;
    amountInCents: number;
    currency: string;
    paymentMethodType: string;
    createdAt: string;
}

/**
 * Abre el Widget de Checkout de Wompi con la llave y la firma que entregó el BFF.
 * Lanza WompiCheckoutNoDisponibleError si falta alguna (no se abre el Widget).
 * Devuelve null si el Widget no carga o el usuario lo cierra.
 */
export async function openWompiCheckout(
    config: WompiCheckoutConfig
): Promise<WompiTransactionResult | null> {
    const {
        reference,
        amountInCents,
        customerEmail,
        customerName,
        customerPhone,
        redirectUrl,
        legalId,
        legalIdType,
    } = config;

    // Llave y firma: SOLO del BFF, del mismo comercio. Sin fallback (ver cabecera).
    const { publicKey: effectivePublicKey, signature } = credencialesDelWidget(config);
    // El monto también viene del servidor (create-session / tienda lo calculan).
    const effectiveAmountInCents = amountInCents;

    // El script del Widget ya no va en index.html: se carga aquí, bajo demanda.
    await cargarWidgetWompi();

    return new Promise((resolve) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const WidgetCheckout = (window as any).WidgetCheckout;

            if (!WidgetCheckout) {
                console.error('❌ Wompi WidgetCheckout no cargó (red o bloqueador). Ver lib/wompiWidget.ts.');
                resolve(null);
                return;
            }

            // Wompi RECHAZA customerData con phoneNumber vacío ("El valor de
            // phoneNumber no puede estar vacío"). Solo incluimos el teléfono si
            // realmente lo tenemos; si no, el Widget lo pide en su formulario.
            const phone = (customerPhone || '').replace(/[^\d]/g, '');
            const customerData: Record<string, unknown> = {
                email: customerEmail,
                fullName: customerName,
            };
            if (phone) {
                customerData.phoneNumber = phone;
                customerData.phoneNumberPrefix = '+57';
            }
            // Prellenar el documento del comprador (evita el desplegable roto del
            // Widget en algunos dispositivos). Wompi lo toma como legalId/legalIdType.
            if (legalId && legalIdType) {
                customerData.legalId = legalId;
                customerData.legalIdType = legalIdType;
            }

            const widgetConfig: Record<string, unknown> = {
                currency: 'COP',
                amountInCents: effectiveAmountInCents,
                reference,
                publicKey: effectivePublicKey,
                redirectUrl: redirectUrl || `${window.location.origin}/payment-result`,
                customerData,
            };

            widgetConfig.signature = { integrity: signature };

            const checkout = new WidgetCheckout(widgetConfig);

            checkout.open((result: { transaction: WompiTransactionResult }) => {
                const transaction = result.transaction;
                console.log('📦 Wompi transaction result:', transaction.status, transaction.reference);
                resolve(transaction);
            });
        } catch (error) {
            console.error('❌ Error abriendo Wompi checkout:', error);
            resolve(null);
        }
    });
}

const WOMPI_API = {
    sandbox: 'https://sandbox.wompi.co/v1',
    production: 'https://production.wompi.co/v1',
} as const;

/**
 * Verifica el status de una transacción vía API pública de Wompi (página /payment-result).
 *
 * El ambiente sale del parámetro `env` que Wompi agrega al redirect (`?id=…&env=test`),
 * no de una llave de build: con VITE_WOMPI_PUBLIC_KEY=pub_test_ en producción esto
 * consultaba el sandbox para transacciones reales. Sin `env`, prueba producción y,
 * si allá no existe, sandbox.
 */
export async function checkTransactionStatus(
    transactionId: string,
    env?: string | null,
): Promise<WompiTransactionResult | null> {
    const e = (env ?? '').toLowerCase();
    const bases = e === 'test'
        ? [WOMPI_API.sandbox]
        : e === 'prod' || e === 'production'
            ? [WOMPI_API.production]
            : [WOMPI_API.production, WOMPI_API.sandbox];

    for (const baseUrl of bases) {
        try {
            const response = await fetch(`${baseUrl}/transactions/${encodeURIComponent(transactionId)}`);
            if (!response.ok) continue;
            const data = await response.json();
            return {
                id: data.data.id,
                status: data.data.status,
                reference: data.data.reference,
                amountInCents: data.data.amount_in_cents,
                currency: data.data.currency,
                paymentMethodType: data.data.payment_method_type || 'UNKNOWN',
                createdAt: data.data.created_at,
            };
        } catch (error) {
            console.error('Error verificando status de transacción:', error);
        }
    }
    return null;
}
