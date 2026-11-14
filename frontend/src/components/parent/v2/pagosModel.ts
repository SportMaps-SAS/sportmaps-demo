/**
 * Pagos del acudiente (rediseño V2) — modelo puro, sin React ni Supabase.
 *
 * Toma las filas que MyPaymentsPage ya arma (payments_with_installments +
 * hidratación desde `payments`) y decide en qué grupo cae cada cobro y qué
 * palabras se le muestran a la familia. Nunca se muestra el estado técnico
 * (`payments.status` es TEXT: pending, overdue, partial, awaiting_approval,
 * paid→approved, rejected, failed, glosado, cancelled…).
 *
 * Los montos que salen de acá son SOLO para mostrar: el valor que se cobra lo
 * decide el BFF (create-session de Wompi recalcula y el modal reconfirma si
 * difiere). Por eso el total del botón «Pagar» es una estimación de pantalla.
 */
import { isOneTimeCategory } from '@/lib/payment-accounts';
import { formatCurrency } from '@/lib/utils';

export interface Transaction {
  id: string;
  amount: number;
  status: string;
  reference: string;
  transaction_date: string;
  receipt_url?: string;
  amount_paid?: number;
  balance_pending?: number;
  school_id?: string;
  school_type?: string;
  concept?: string;
  child_id?: string;
  child_name?: string;
  period_year?: number | null;
  period_month?: number | null;
  period_label?: string | null;
  /** payments.due_date (YYYY-MM-DD). */
  due_date?: string | null;
  /** payments.payment_method (pse|card|transfer|cash|other) y su pasarela. */
  pay_method?: string | null;
  pay_provider?: string | null;
  late_fee_amount?: number | null;
  /** Descuento por hermanos (mig. 20260916101241) ya neteado en `amount`. Solo informativo. */
  sibling_discount_applied?: number | null;
  discount_amount?: number;
  discount_eligible?: boolean;
  discount_valid_until?: string | null;
  payment_category?: string | null;
  last_failure_reason?: string | null;
  last_failure_at?: string | null;
  requires_review?: boolean | null;
  /** Último ajuste de la escuela sobre el cobro (payment_corrections). */
  ajuste_kind?: 'anulado_no_asistio' | 'valor_cambio_plan' | null;
  ajuste_antes?: number | null;
  ajuste_motivo?: string | null;
  /** ISO del ajuste: un mes anulado se le muestra a la familia un tiempo y luego se oculta. */
  ajuste_at?: string | null;
}

/** Estados con botón de pago directo (los mismos que abre `?pay=`). `partial` = abono por el saldo. */
export const PAYABLE_STATES = ['pending', 'overdue', 'partial', 'rejected', 'failed'];
/** Comprobante enviado, la escuela lo está revisando: sin casilla. */
export const IN_REVIEW_STATES = ['awaiting_approval'];
/** La escuela pidió una aclaración del comprobante (glosa): se responde, no se paga. */
export const CLARIFY_STATES = ['glosado'];
/** Ya pagado (`paid` llega remapeado a `approved`). */
export const PAID_STATES = ['approved'];
/** Anulados: no son deuda ni pago, no se muestran (salvo el aviso de abajo). */
export const HIDDEN_STATES = ['cancelled'];
/** Días que se le sigue mostrando a la familia un mes anulado por «no asistió». */
export const DIAS_AVISO_ANULADO = 45;

/** Mes que la escuela anuló porque el deportista no asistió, anulado hace poco. */
export function esAnuladoReciente(t: Transaction, now = new Date()): boolean {
  if (t.status !== 'cancelled' || t.ajuste_kind !== 'anulado_no_asistio' || !t.ajuste_at) return false;
  const dias = (now.getTime() - new Date(t.ajuste_at).getTime()) / 86_400_000;
  return dias >= 0 && dias <= DIAS_AVISO_ANULADO;
}

export interface PagosGroups {
  payable: Transaction[];
  /** En revisión, aclaración pendiente o un estado futuro que no sabemos pagar: se ven, sin casilla. */
  waiting: Transaction[];
  paid: Transaction[];
}

export function groupTransactions(list: Transaction[], now = new Date()): PagosGroups {
  const payable: Transaction[] = [];
  const waiting: Transaction[] = [];
  const paid: Transaction[] = [];
  for (const t of list) {
    // La familia ve un tiempo que ese mes ya no se le cobra (se lo avisó la escuela).
    if (esAnuladoReciente(t, now)) { waiting.push(t); continue; }
    if (HIDDEN_STATES.includes(t.status)) continue;
    if (PAID_STATES.includes(t.status)) paid.push(t);
    else if (PAYABLE_STATES.includes(t.status)) payable.push(t);
    else waiting.push(t);
  }
  // Lo que vence primero, arriba.
  payable.sort((a, b) => (a.due_date || a.transaction_date).localeCompare(b.due_date || b.transaction_date));
  return { payable, waiting, paid };
}

const discountApplies = (t: Transaction) =>
  !!t.discount_eligible && (t.discount_amount ?? 0) > 0 && t.status !== 'partial';

/** Lo que se muestra como «a pagar» en la fila. Estimación de pantalla (ver cabecera). */
export function dueAmount(t: Transaction): number {
  const base = t.status === 'partial'
    ? Number(t.balance_pending ?? 0)
    : Number(t.balance_pending || t.amount || 0);
  return Math.max(0, base - (discountApplies(t) ? Number(t.discount_amount) : 0));
}

export function sumDue(list: Transaction[]): number {
  return list.reduce((s, t) => s + dueAmount(t), 0);
}

/** «Mensualidad de octubre · Sofía» */
export function rowTitle(t: Transaction): string {
  // concept siempre viene poblado y ya dice «Mensualidad {mes}» cuando lo es; un
  // torneo o la tienda también tienen period_* (trigger), así que no se infiere.
  const concepto = t.concept || (t.period_label ? `Mensualidad ${t.period_label}` : 'Mensualidad');
  return t.child_name ? `${concepto} · ${t.child_name}` : concepto;
}

const parseDay = (d: string) => new Date(d.length <= 10 ? `${d}T00:00:00` : d);

function dayLabel(d: string, withWeekday: boolean, now: Date): string {
  const date = parseDay(d);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
  if (withWeekday) opts.weekday = 'long';
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('es-CO', opts).replace(',', '');
}

export function isOverdue(t: Transaction, now = new Date()): boolean {
  if (t.status === 'overdue') return true;
  if (!t.due_date) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return parseDay(t.due_date) < today;
}

/** Línea secundaria de un cobro por pagar. */
export function payableDetail(t: Transaction, now = new Date()): string {
  const parts: string[] = [];
  if (t.status === 'rejected') parts.push('Rechazado: vuelve a subir el comprobante');
  else if (t.status === 'failed') parts.push('El pago no pasó: inténtalo de nuevo');
  else if (t.status === 'partial') {
    parts.push(`Abonaste ${formatCurrency(Number(t.amount_paid ?? 0))} · falta ${formatCurrency(Number(t.balance_pending ?? 0))}`);
  } else if (isOverdue(t, now)) {
    parts.push(t.due_date ? `Vencido desde el ${dayLabel(t.due_date, false, now)}` : 'Vencido');
  } else if (t.due_date) {
    parts.push(`Vence el ${dayLabel(t.due_date, true, now)}`);
  }
  if (isOneTimeCategory(t.payment_category)) parts.push('Una sola vez');
  if ((t.late_fee_amount ?? 0) > 0) parts.push(`Incluye recargo por mora de ${formatCurrency(Number(t.late_fee_amount))}`);
  if ((t.sibling_discount_applied ?? 0) > 0) parts.push(`Incluye descuento por hermanos de ${formatCurrency(Number(t.sibling_discount_applied))}`);
  if (discountApplies(t)) {
    parts.push(`Ahorras ${formatCurrency(Number(t.discount_amount))}${t.discount_valid_until ? ` pagando antes del ${t.discount_valid_until}` : ' pagando a tiempo'}`);
  }
  return parts.join(' · ');
}

/** Etiqueta de un cobro sin casilla. */
export function waitingLabel(t: Transaction): { label: string; detail: string } {
  if (t.status === 'cancelled' && t.ajuste_kind === 'anulado_no_asistio') {
    return {
      label: 'No se cobra',
      detail: `La escuela anuló este mes: no asistió.${t.ajuste_motivo ? ` ${t.ajuste_motivo}` : ''}`,
    };
  }
  if (t.status === 'awaiting_approval') {
    return { label: 'En revisión', detail: 'Enviaste el comprobante. La escuela lo está revisando.' };
  }
  if (t.status === 'glosado') {
    return { label: 'Necesita aclaración', detail: 'La escuela necesita que aclares el comprobante.' };
  }
  return { label: 'En proceso', detail: 'La escuela está procesando este cobro.' };
}

/** Nota bajo un cobro cuyo valor cambió la escuela por un cambio de plan. */
export function ajusteNota(t: Transaction): string | null {
  if (t.ajuste_kind !== 'valor_cambio_plan' || t.ajuste_antes == null) return null;
  if (t.status === 'cancelled') return null;
  return `Ajustado por cambio de plan (antes ${formatCurrency(Number(t.ajuste_antes))})`;
}

const METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  pse: 'PSE',
  transfer: 'Transferencia',
  cash: 'Efectivo',
};
const PROVIDER_LABELS: Record<string, string> = {
  wompi: 'En línea',
  mercadopago: 'Mercado Pago',
};

export function methodLabel(t: Transaction): string | null {
  if (t.pay_method && METHOD_LABELS[t.pay_method]) return METHOD_LABELS[t.pay_method];
  if (t.pay_provider && PROVIDER_LABELS[t.pay_provider]) return PROVIDER_LABELS[t.pay_provider];
  return null;
}

/** «$ 180.000 · Tarjeta · 9 de septiembre» */
export function paidDetail(t: Transaction, now = new Date()): string {
  const valor = formatCurrency(Number(t.amount_paid || t.amount || 0));
  return [valor, methodLabel(t), dayLabel(t.transaction_date, false, now)].filter(Boolean).join(' · ');
}

const sinTildes = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * De quién es un cobro SIN `child_id` (B8). Antes salía siempre «Tú (como
 * atleta)», también para acudientes que no entrenan: el Tenis de Tomás quedaba
 * rotulado como del papá.
 *   1. Si el concepto nombra a UNO solo de los hijos («… — Tenis (Tomás)»), es de ese hijo.
 *   2. «Tú (como atleta)» solo si el acudiente tiene inscripción propia.
 *   3. Si no, «Sin deportista asignado» (la escuela debe corregirlo).
 * Solo es el rótulo: el cobro no cambia de dueño.
 */
export function rotuloCobroSinHijo(
  cobro: { concept?: string | null; parent_id?: string | null },
  userId: string | null | undefined,
  hijos: { full_name: string | null }[],
  tieneInscripcionPropia: boolean,
): string {
  const concepto = sinTildes(cobro.concept ?? '');
  if (concepto) {
    const nombres = [...new Set(hijos.map((h) => (h.full_name ?? '').trim().split(/\s+/)[0]).filter(Boolean))];
    const nombrados = nombres.filter((n) => new RegExp(`(^|[^a-z])${sinTildes(n)}([^a-z]|$)`).test(concepto));
    if (nombrados.length === 1) return nombrados[0];
  }
  if (userId && cobro.parent_id === userId && tieneInscripcionPropia) return 'Tú (como atleta)';
  return 'Sin deportista asignado';
}
