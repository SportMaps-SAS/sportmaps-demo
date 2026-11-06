/**
 * approvePayment — EL camino de aprobación manual de un cobro con comprobante.
 *
 * Lo usan la hoja «Aprobar cobro» (uno, con opción de abono) y «Aprobar todos
 * los verdes» (en lote, uno por uno). Un solo lugar para que el lote no se
 * salte nada de lo que hace la aprobación de a uno: approved_by/approved_at,
 * amount_paid acumulado, payment_date = hoy (día en que la escuela aprueba),
 * cierre de la revisión de pasarela, inscripción activa y aviso a la familia.
 *
 * El UPDATE exige que el cobro siga abierto: si otra persona (u otra pestaña) ya
 * lo aprobó, no se aprueba dos veces.
 */
import { supabase } from '@/integrations/supabase/client';
import { todayColombia } from '@/lib/dateUtils';
import { formatCurrency } from '@/lib/utils';
import { isOneTimeCategory } from '@/lib/payment-accounts';

export interface ApprovablePayment {
  id: string;
  amount: number;
  amount_paid?: number | null;
  concept?: string | null;
  payment_method?: string | null;
  child_id?: string | null;
  parent_id?: string | null;
  user_id?: string | null;
  unregistered_athlete_id?: string | null;
  team_id?: string | null;
  /** payments.payment_category. Si no viene, se toma la de la fila actualizada. */
  payment_category?: string | null;
}

export interface ApproveOptions {
  userId: string;
  schoolId: string;
  schoolName?: string | null;
  /** Monto de ESTE abono. Sin él (o si cubre el saldo) se aprueba completo. */
  abonoAmount?: number;
  /** Escuelas con receipt_amount_editable: el valor que la escuela confirmó como pagado. */
  confirmedAmount?: number;
  /** Razón cuando el valor confirmado difiere del que leyó el comprobante. */
  confirmedReason?: string;
}

export type ApproveResult =
  | { ok: true; isAbono: boolean; abono: number; saldoPendiente: number }
  | { ok: false; reason: 'already_handled' | 'error'; message: string };

/** Estados desde los que se puede aprobar. */
const OPEN_STATUSES = ['awaiting_approval', 'pending', 'overdue', 'partial'];

export async function approvePayment(payment: ApprovablePayment, opts: ApproveOptions): Promise<ApproveResult> {
  const expected = Number(payment.amount) || 0;
  const existingPaid = Number(payment.amount_paid) || 0;
  const remaining = Math.max(expected - existingPaid, 0);
  const abono = opts.abonoAmount ?? remaining;
  const newTotalPaid = existingPaid + abono;
  const isAbono = newTotalPaid < expected;
  const saldoPendiente = Math.max(expected - newTotalPaid, 0);

  // Conserva el método si ya viene (no se re-pregunta); default transfer.
  const method = payment.payment_method || 'transfer';
  const nowIso = new Date().toISOString();

  const { data: updated, error } = await supabase.from('payments').update({
    // Abono → 'partial' (queda saldo); pago completo → 'paid'.
    status: isAbono ? 'partial' : 'paid',
    payment_method: method,
    payment_channel: method === 'cash' ? 'cash' : 'transfer',
    payment_date: todayColombia(),
    approved_by: opts.userId,
    approved_at: nowIso,
    // amount_paid ACUMULA los abonos previos; en pago completo se salda todo.
    amount_paid: isAbono ? newTotalPaid : expected,
    // Aprobar CIERRA la revisión que dejó la pasarela tras un rechazo: el admin
    // ya vio el comprobante. last_failure_* se conserva como auditoría.
    requires_review: false,
    unblocked_at: nowIso,
    unblocked_by: opts.userId,
    ...(opts.confirmedAmount !== undefined ? {
      receipt_amount_confirmed: opts.confirmedAmount,
      receipt_amount_change_reason: opts.confirmedReason ?? null,
      receipt_amount_confirmed_by: opts.userId,
      receipt_amount_confirmed_at: nowIso,
    } : {}),
  } as never).eq('id', payment.id).in('status', OPEN_STATUSES).select('id, payment_category');

  if (error) return { ok: false, reason: 'error', message: error.message };
  if (!updated || updated.length === 0) {
    return { ok: false, reason: 'already_handled', message: 'Este cobro ya no está abierto (pudo aprobarse mientras tanto).' };
  }

  // Activar la inscripción SOLO cuando el pago quedó completo Y es la
  // mensualidad. enrollments.status es text: los pendientes reales son
  // 'pending' (NO 'pending_payment').
  // F0 (migración 20261010143132, cobros-multiples I15): un cobro ÚNICO
  // (inscripción, seguro, torneo, artículos… — isOneTimeCategory) nunca activa
  // ni extiende la inscripción; aprobar el torneo de un lote (que lleva
  // team_id) activaba una inscripción pendiente. La categoría se lee de la fila
  // que devolvió el UPDATE (la de la base manda); si no viene, la del llamador.
  const updatedRow = (updated as Array<{ payment_category?: string | null }>)[0];
  const category = updatedRow && 'payment_category' in updatedRow
    ? updatedRow.payment_category
    : payment.payment_category;
  if (!isAbono && !isOneTimeCategory(category)) {
    let enrollQuery = supabase
      .from('enrollments')
      .update({ status: 'active' })
      .eq('school_id', opts.schoolId)
      .eq('status', 'pending');
    if (payment.child_id) {
      enrollQuery = enrollQuery.eq('child_id', payment.child_id);
    } else if (payment.unregistered_athlete_id) {
      enrollQuery = (enrollQuery as any).eq('unregistered_athlete_id', payment.unregistered_athlete_id);
    } else if (payment.user_id) {
      enrollQuery = (enrollQuery as any).eq('user_id', payment.user_id).is('child_id', null);
    }
    if (payment.team_id) enrollQuery = enrollQuery.eq('team_id', payment.team_id);
    await enrollQuery;
  }

  // Aviso a la familia / responsable si tiene cuenta. No bloquea la aprobación.
  const recipientId = payment.parent_id || payment.user_id;
  if (recipientId) {
    const escuela = opts.schoolName || 'La escuela';
    await supabase.rpc('notify_user', {
      p_user_id: recipientId,
      p_title: isAbono ? '💰 Abono registrado' : '✅ Pago confirmado',
      p_message: isAbono
        ? `${escuela} registró un abono de ${formatCurrency(abono)} por ${payment.concept}. Saldo pendiente: ${formatCurrency(saldoPendiente)}.`
        : `${escuela} confirmó tu pago de ${formatCurrency(expected)} por ${payment.concept}.`,
      p_type: isAbono ? 'payment' : 'success',
      p_link: '/my-payments',
    }).then(() => undefined, () => undefined);
  }

  return { ok: true, isAbono, abono, saldoPendiente };
}
