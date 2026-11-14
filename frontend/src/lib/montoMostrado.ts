/**
 * Qué monto se dibuja en una fila de Gestión de Pagos (2026-11-11).
 *
 * Antes se pintaba siempre `payments.amount`, que es el VALOR DEL COBRO: un
 * abono de $175.000 sobre un cobro de $300.000 salía como «$300.000», y el
 * abono de un comprobante por validar ($150.000, solo en `ocr_amount` hasta que
 * la escuela aprueba) no se veía en ningún sitio.
 *
 * SOLO PARA MOSTRAR. No decide reglas de dinero ni toca totales.
 */
export interface CobroParaMonto {
    status: string;
    amount: number;
    amount_paid?: number | null;
    ocr_amount?: number | null;
}

export interface MontoMostrado {
    /** La cifra grande de la fila. */
    principal: number;
    /** Valor total del cobro, cuando `principal` es solo lo recibido («de $300.000»). */
    deCobro: number | null;
    /** Lo que dice el comprobante por validar si no coincide con el cobro («abono $150.000»). */
    declarado: number | null;
}

export function montoMostrado(p: CobroParaMonto, opciones: { cola?: boolean } = {}): MontoMostrado {
    const amount = Number(p.amount) || 0;
    const pagado = Number(p.amount_paid) || 0;
    const ocr = p.ocr_amount == null ? null : Number(p.ocr_amount);

    // Pagos recibidos: lo que de verdad entró. (La cola ya dice «Abonado X · saldo Y» aparte.)
    if (!opciones.cola && (p.status === 'partial' || (pagado > 0 && pagado < amount))) {
        return { principal: pagado, deCobro: amount, declarado: null };
    }
    // Por validar: el comprobante declara un valor distinto al del cobro (abono por aprobar).
    if (p.status === 'awaiting_approval' && ocr != null && ocr > 0 && Math.abs(ocr - amount) > 1) {
        return { principal: amount, deCobro: null, declarado: ocr };
    }
    return { principal: amount, deCobro: null, declarado: null };
}
