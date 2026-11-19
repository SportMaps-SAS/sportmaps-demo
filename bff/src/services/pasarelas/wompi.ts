/**
 * Política de Wompi para el núcleo de cobros de escuela (../pagos-escuela.core.ts).
 * Todo lo que es «cómo lo hace Wompi» vive aquí; la lógica común, en el núcleo.
 */

import type { PoliticaCobroEscuela, EventoCobroEscuela } from '../pagos-escuela.core';
import { autopayAlResultado, autopayCobroDoble } from '../autopay.service';

// Wompi entrega el tipo de instrumento (CARD/PSE/NEQUI/…). La constraint
// payments_payment_method_check solo admite pse|card|transfer|cash|other, así
// que 'wompi' NO es válido (rompía el UPDATE en silencio). Mapeamos al enum.
export const WOMPI_METHOD_MAP: Record<string, string> = {
    CARD: 'card',
    PSE: 'pse',
    NEQUI: 'transfer',
    DAVIPLATA: 'transfer',
    BANCOLOMBIA_TRANSFER: 'transfer',
    BANCOLOMBIA_QR: 'transfer',
    BANCOLOMBIA_COLLECT: 'transfer',
};

export const politicaWompi: PoliticaCobroEscuela = {
    prefijoLog: 'School payment',
    textoLinkNoEncontrado: 'payment_link not found',
    claveMotivo: 'wompi',
    columnaReferenciaLink: 'wompi_reference',
    columnaTxSplit: 'wompi_transaction_id',
    columnasLink: 'id, payment_id, school_id, gross_amount, base_amount, sportmaps_fee, status, expires_at, failed_attempts, origin, recurring_attempt_id',
    columnasPagoActual: 'status, wompi_transaction_id, amount, amount_paid, early_payment_discount_applied, late_fee_amount',
    errorMontoDistinto: 'Amount mismatch',
    doblePago: { columnaTxPago: 'wompi_transaction_id' },
    fallaUpdatePagoDevuelve500: true,
    textoFallaUpdatePago: 'School payment: FALLÓ marcar payment como paid',
    formatoMontoSobrepago: (n) => `$${n.toLocaleString('es-CO')}`,
    metodoDePago: (tipo) => WOMPI_METHOD_MAP[String(tipo || '').toUpperCase()] ?? 'other',
    columnasProveedorPago: (ev: EventoCobroEscuela) => ({
        payment_provider: 'wompi',
        wompi_reference: ev.referencia,
        wompi_transaction_id: ev.txId,
    }),
    filaSplit: (ev, link) => ({
        payment_id: link.payment_id,
        payment_link_id: link.id,
        wompi_reference: ev.referencia,
        wompi_transaction_id: ev.txId,
        gross_amount: ev.monto,
        school_receives: ev.monto,
        sportmaps_receives: 0,
        // La comisión real de la pasarela no la expone la API de transacciones: se
        // descuenta al liquidar y solo se ve en el dashboard del comercio.
        wompi_fee: 0,
        transfer_status: 'pending',
        webhook_signature_valid: true,
    }),
    autopay: { alResultado: autopayAlResultado as any, cobroDoble: autopayCobroDoble as any },
};
