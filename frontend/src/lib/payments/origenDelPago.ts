/**
 * origenDelPago — de dónde viene la constancia de un pago, resuelto en UN lugar.
 *
 * Contexto (Monster's Volley, nov-2026): la escuela cargó sus pagos desde el
 * Excel con un script; esos cobros llevan `reference` que empieza por `XLS-`
 * (XLS-ABONO-…, XLS-NOV-…) y casi ninguno tiene comprobante. Ese historial no se
 * audita, pero desde ahora la app es la fuente de verdad: hay que poder ver qué
 * pago nació de un comprobante y cuál de esa carga inicial.
 *
 *   migrado_excel          reference empieza por `XLS-` (insensible a mayúsculas).
 *   comprobante            hay `receipt_url`.
 *   manual_sin_comprobante pagado, sin comprobante, sin `XLS-` y NO confirmado por
 *                          una pasarela (Wompi/MercadoPago son su propia constancia).
 *   otro                   todo lo demás (cobros abiertos, pasarela, etc.).
 *
 * Es solo para pantallas del personal de la escuela: la familia no lo ve.
 */
import { isGatewayPayment, type PaymentOriginInput } from '@/lib/paymentOrigin';

export type OrigenDelPago = 'migrado_excel' | 'comprobante' | 'manual_sin_comprobante' | 'otro';

export interface OrigenDelPagoInput extends PaymentOriginInput {
  status?: string | null;
  reference?: string | null;
}

export const PREFIJO_REFERENCIA_EXCEL = 'XLS-';

export function origenDelPago(p: OrigenDelPagoInput | null | undefined): OrigenDelPago {
  if (!p) return 'otro';
  if (String(p.reference ?? '').trim().toUpperCase().startsWith(PREFIJO_REFERENCIA_EXCEL)) return 'migrado_excel';
  if (p.receipt_url) return 'comprobante';
  if (p.status === 'paid' && !isGatewayPayment(p)) return 'manual_sin_comprobante';
  return 'otro';
}
