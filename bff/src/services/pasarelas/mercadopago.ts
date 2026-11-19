/**
 * Política de Mercado Pago para el núcleo de cobros de escuela (../pagos-escuela.core.ts).
 *
 * Diferencias con Wompi CONSERVADAS a propósito (la F1 no cambia conducta; ver los
 * snapshots de routes/pagos-escuela.caracterizacion.test.ts):
 *   - sin protección de doble pago: un segundo pago pisa el primero;
 *   - si falla el UPDATE de `payments` no devuelve 500: lo registra y sigue;
 *   - ignora el débito automático;
 *   - escribe `payment_method = 'mercadopago'` sin mapear al CHECK de la tabla.
 * Adoptar las protecciones de Wompi es una decisión de producto: cambio aparte.
 */

import type { PoliticaCobroEscuela } from '../pagos-escuela.core';

export const politicaMercadoPago: PoliticaCobroEscuela = {
    prefijoLog: 'MP school payment',
    textoLinkNoEncontrado: 'link not found',
    claveMotivo: 'mp',
    columnaReferenciaLink: 'provider_reference',
    columnaTxSplit: 'provider_transaction_id',
    columnasLink: 'id, payment_id, school_id, gross_amount, base_amount, sportmaps_fee, status, failed_attempts',
    columnasPagoActual: 'status, amount, amount_paid, early_payment_discount_applied, late_fee_amount',
    errorMontoDistinto: 'amount_mismatch',
    doblePago: null,
    fallaUpdatePagoDevuelve500: false,
    textoFallaUpdatePago: 'MP school payment: FALLÓ actualizar el payment',
    formatoMontoSobrepago: (n) => `$${Math.round(n).toLocaleString('es-CO')}`,
    metodoDePago: () => 'mercadopago',
    columnasProveedorPago: (ev) => ({
        payment_provider: 'mercadopago',
        provider_reference: ev.referencia,
        provider_transaction_id: ev.txId,
    }),
    filaSplit: (ev, link) => ({
        payment_id: link.payment_id,
        payment_link_id: link.id,
        payment_provider: 'mercadopago',
        provider_reference: ev.referencia,
        provider_transaction_id: ev.txId,
        gross_amount: ev.monto,
        school_receives: ev.monto,
        sportmaps_receives: 0,
        provider_fee: 0,
        transfer_status: 'pending',
        webhook_signature_valid: true,
    }),
    autopay: null,
};
