import { todayColombia } from '@/lib/dateUtils';

export interface EarlyPaymentDiscountConfig {
  enabled: boolean;
  days: number;
  percentage: number; // 0-100
  /**
   * 'days_from_creation' (default): `days` días desde que se creó el cobro.
   * 'day_of_month': `days` es el día del mes (1-28) del mes en que se creó el cobro.
   * Debe coincidir con fn_payments_pronto_pago_servidor (20261105111401).
   */
  mode?: 'days_from_creation' | 'day_of_month';
}

/** Lee el modo desde una fila de school_settings (cualquier valor raro = días). */
export function modoProntoPago(v: unknown): 'days_from_creation' | 'day_of_month' {
  return v === 'day_of_month' ? 'day_of_month' : 'days_from_creation';
}

export interface EarlyPaymentDiscountResult {
  eligible: boolean;
  discountAmount: number;    // 0 si no aplica
  finalAmount: number;       // fullAmount - discountAmount
  validUntil: string | null; // YYYY-MM-DD (Bogota), null si no aplica
}

/**
 * El pronto pago es exclusivo de la mensualidad (payment_category NULL =
 * legado/mensualidad). Misma regla que aplica el servidor en
 * `fn_payments_pronto_pago_servidor` (migración 20261010143743, S1/H5): si el
 * navegador ofrece descuento en un cobro único, la base lo deja en NULL y la
 * familia transferiría de menos.
 */
export function earlyDiscountAppliesToCategory(paymentCategory: string | null | undefined): boolean {
  return !paymentCategory || paymentCategory === 'mensualidad';
}

/**
 * Calcula si un pago es elegible para descuento por pronto pago.
 *
 * Es una VISTA PREVIA: el valor que queda en payments.early_payment_discount_applied
 * lo acota la base (trigger trg_zzz_pronto_pago_servidor) a
 * LEAST(lo enviado, el calculado por el servidor). El navegador no puede
 * darse más descuento que el de la escuela.
 *
 * Ventana = desde payment.created_at hasta N dias despues (config.days),
 * misma regla para los 3 billing_cycle_type — no depende del dia de corte,
 * solo de cuando el cobro se genero y se hizo visible al padre.
 *
 * Si el pago YA tiene un descuento congelado (early_payment_discount_applied
 * no nulo en BD), ese valor manda siempre — no se recalcula.
 */
export function calcEarlyPaymentDiscount(
  fullAmount: number,
  params: {
    createdAt: string; // payment.created_at (timestamptz ISO)
    config: EarlyPaymentDiscountConfig;
    hasEarlierUnpaid: boolean;
    alreadyAppliedAmount?: number | null;
  },
): EarlyPaymentDiscountResult {
  if (params.alreadyAppliedAmount != null) {
    const discountAmount = Number(params.alreadyAppliedAmount) || 0;
    return {
      eligible: discountAmount > 0,
      discountAmount,
      finalAmount: fullAmount - discountAmount,
      validUntil: null,
    };
  }

  if (!params.config.enabled || params.config.percentage <= 0 || params.hasEarlierUnpaid) {
    return { eligible: false, discountAmount: 0, finalAmount: fullAmount, validUntil: null };
  }

  // Fecha calendario (Bogota) de created_at + N dias.
  const createdBogota = new Date(params.createdAt).toLocaleString('en-CA', {
    timeZone: 'America/Bogota',
  }); // "YYYY-MM-DD, HH:mm:ss"
  const createdDateStr = createdBogota.split(',')[0];
  const limit = new Date(createdDateStr + 'T12:00:00');
  if (params.config.mode === 'day_of_month') {
    limit.setDate(Math.min(Math.max(params.config.days, 1), 28));
  } else {
    limit.setDate(limit.getDate() + params.config.days);
  }
  const validUntil = limit.toISOString().split('T')[0];

  const today = todayColombia();
  const eligible = today <= validUntil;
  const discountAmount = eligible ? Math.round(fullAmount * (params.config.percentage / 100)) : 0;

  return { eligible, discountAmount, finalAmount: fullAmount - discountAmount, validUntil };
}

/**
 * True si existe un pago ANTERIOR (created_at menor) en pending/overdue/partial
 * para el mismo child/parent en la misma escuela. Bloquea el descuento si el
 * mes pasado no se pago. fail-open: ante error de red, NO bloquea el pago.
 */
export async function hasEarlierUnpaidPayment(
  supabase: any,
  params: {
    schoolId: string;
    childId?: string | null;
    parentId?: string | null;
    excludePaymentId?: string;
    beforeCreatedAt: string;
  },
): Promise<boolean> {
  let q = supabase
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', params.schoolId)
    .in('status', ['pending', 'overdue', 'partial'])
    .lt('created_at', params.beforeCreatedAt);

  if (params.childId) q = q.eq('child_id', params.childId);
  else if (params.parentId) q = q.eq('parent_id', params.parentId);
  else return false;

  if (params.excludePaymentId) q = q.neq('id', params.excludePaymentId);

  const { count, error } = await q;
  if (error) {
    console.error('[hasEarlierUnpaidPayment]', error);
    return false;
  }
  return (count ?? 0) > 0;
}
