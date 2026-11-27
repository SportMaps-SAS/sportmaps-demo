/**
 * Cancelación de reservas de clase con devolución de crédito.
 *
 * Extraído sin cambios de lógica de routes/session-bookings.ts (SEG-33) para
 * que otros caminos (las confirmaciones de encuestas en polls.controller.ts)
 * cancelen por la MISMA RPC atómica en lugar de borrar la fila.
 */
import { supabase } from '../config/supabase';

// Identidad del atleta que agenda: exactamente UNO de los tres. `userId` es
// el atleta adulto autenticado; `childId`, un hijo (ya validado contra su
// padre); `unregisteredAthleteId`, alguien con ficha en la escuela pero sin
// cuenta (agenda vía booking_token en el link público, sin loguearse — ver
// public-booking.routes.ts /available-for-enrollment y /book-for-enrollment).
export type AthleteIdentity = { userId?: string; childId?: string; unregisteredAthleteId?: string };

export interface CancelBookingResult {
  cancelled?: boolean;
  credit_returned?: boolean;
  session_id?: string;
  hour_bank?: boolean;
  reason?: string;
}

// ¿Faltó devolver un crédito que sí correspondía? Banco de horas y planes de
// horas sin reserva (hours_plan_without_reservation) no devuelven cupo: es lo esperado.
export function shouldLogMissingCredit(out: CancelBookingResult, bookingHadHourBank: boolean): boolean {
  if (out.credit_returned) return false;
  if (out.reason === 'no_credit_enrollment') return true; // reserva sin inscripción de crédito: hay que revisarla
  if (out.hour_bank || bookingHadHourBank) return false;
  return out.reason !== 'hours_plan_without_reservation';
}

export const CANCEL_REFUSAL_MESSAGES: Record<string, string> = {
  session_in_the_past: 'Esta clase ya pasó y no se puede cancelar.',
  attendance_recorded: 'Ya se registró tu asistencia a esta clase y no se puede cancelar.',
};

// Cuerpo del 400 cuando la RPC no canceló. Con reason conocido lleva mensaje
// claro; si no (ya cancelada / no confirmada) usa el error de la ruta.
export function cancelRefusalBody(out: CancelBookingResult, fallbackError: string): Record<string, string> {
  const known = out.reason ? CANCEL_REFUSAL_MESSAGES[out.reason] : undefined;
  if (known && out.reason) return { error: known, reason: out.reason };
  return { error: fallbackError };
}

// Cancelación atómica (UPDATE condicional + reembolso) con la identidad DUEÑA
// de la reserva. El staff que cancela en nombre del atleta pasa la identidad
// de la propia fila, no la suya.
export async function cancelBookingViaRpc(bookingId: string, identity: AthleteIdentity): Promise<CancelBookingResult> {
  const { data, error } = await supabase.rpc('cancel_session_booking_with_credit', {
    p_booking_id: bookingId,
    p_user_id: identity.userId ?? null,
    p_child_id: identity.childId ?? null,
    p_unregistered_athlete_id: identity.unregisteredAthleteId ?? null,
  });
  if (error) throw error;
  return (data ?? {}) as CancelBookingResult;
}

export type BookingOwnerRow = { user_id?: string | null; child_id?: string | null; unregistered_athlete_id?: string | null };

export function identityOfBookingRow(b: BookingOwnerRow): AthleteIdentity {
  if (b.child_id) return { childId: b.child_id };
  if (b.unregistered_athlete_id) return { unregisteredAthleteId: b.unregistered_athlete_id };
  return { userId: b.user_id ?? undefined };
}
