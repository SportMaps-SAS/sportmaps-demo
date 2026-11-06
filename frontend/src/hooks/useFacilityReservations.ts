import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { format } from 'date-fns';
import {
  cancelBooking,
  describeRefund,
  parseBookingError,
  usesNewReservationRoutes,
  type CancelResult,
} from '@/components/reservas/reservasApi';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResvStatus =
  | 'pending' | 'confirmed' | 'cancelled' | 'completed'
  // F1 (reservas-canchas): estados del hold/pago
  | 'hold' | 'pending_payment' | 'pending_reconciliation' | 'expired' | 'no_show';

export interface FacilityReservation {
  id: string;
  facility_id: string;
  user_id: string;
  team_id: string | null;
  reservation_date: string;       // 'yyyy-MM-dd'
  start_time: string;             // 'HH:mm:ss'
  end_time: string;
  status: ResvStatus;
  price: number;
  participants: number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  // joined
  facility: { name: string; type: string; capacity: number } | null;
  requester: { full_name: string | null; email: string } | null;
  isSessionBooking?: boolean;
  // F1: columnas que trae `select *` cuando la base las tiene (todas opcionales)
  starts_at?: string | null;
  ends_at?: string | null;
  hold_expires_at?: string | null;
  payment_status?: string | null;
  payment_reference?: string | null;
  guest_booker_id?: string | null;
}

export interface CreateReservationPayload {
  facility_id: string;
  reservation_date: string;
  start_time: string;
  end_time: string;
  price: number;
  notes?: string;
  status?: ResvStatus;
}

export interface ReservationChangeNotice {
  success: boolean;
  email_sent?: boolean;
}

export interface CourtesySlot {
  facility_availability_id: string;
  slot_date: string;
  slot_start_time: string;
  slot_end_time: string;
  available_spots: number;
}

export interface RescheduleReservationPayload {
  id: string;
  isSessionBooking?: boolean;
  reservation_date: string;
  start_time: string;
  end_time: string;
  facility_availability_id?: string; // requerido cuando isSessionBooking
}

export interface UpdateReservationPayload {
  facility_id?: string;
  reservation_date?: string;
  start_time?: string;
  end_time?: string;
  price?: number;
  notes?: string;
  status?: ResvStatus;
}

/** Convierte 'HH:mm' o 'HH:mm:ss' a minutos desde medianoche. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':');
  return parseInt(h, 10) * 60 + parseInt(m ?? '0', 10);
}

/**
 * Todas las franjas horarias ('HH:mm', paso de 60 min) que ocupa el rango
 * [start, end). Acepta 'HH:mm' y 'HH:mm:ss'. Una reserva de 08:00 a 10:00
 * ocupa 08:00 y 09:00.
 */
export function expandOccupiedSlots(start: string, end: string): string[] {
  const s = timeToMinutes(start);
  let e = timeToMinutes(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return [];
  if (e <= s) e = s + 60; // dato raro: al menos la hora de inicio
  const out: string[] = [];
  for (let m = Math.floor(s / 60) * 60; m < e; m += 60) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:00`);
  }
  return out;
}

/** Traduce errores técnicos del servidor/base a un mensaje que entienda la escuela. */
export function friendlyReservationError(error: any): string {
  const msg: string = error?.message ?? '';
  if (msg.includes('facility_slot_conflict')) {
    return 'Ese horario ya está ocupado por otra reserva. Elige otro horario.';
  }
  // Códigos de las rutas nuevas ({error:'SLOT_TAKEN', message, ...}).
  const info = parseBookingError(error);
  if (info.code) return info.message;
  return msg || 'No se pudo completar la operación.';
}

/** Errores de cancelar: el servidor puede rechazar con 409 (p. ej. fuera de la ventana de cancelación). */
export function friendlyCancelError(error: any): string {
  if (parseBookingError(error).code) return parseBookingError(error).message;
  if (error?.status === 409) {
    return error?.message && !/^Error 409/.test(error.message)
      ? error.message
      : 'Esta reserva ya no se puede cancelar: está fuera de la ventana de cancelación o cambió de estado.';
  }
  return friendlyReservationError(error);
}

// Máximo de reservas que se traen de una vez (las más recientes por fecha).
const PAGE_SIZE = 200;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFacilityReservations() {
  const { user } = useAuth();
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Clave propia de este hook (el modal público usa ['facility-reservations-slots', ...]
  // para no pisarse con esta lista).
  const QUERY_KEY = ['school-facility-reservations', schoolId];

  // ── READ ──────────────────────────────────────────────────────────────────

  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);

  const { data: reservations = [], isLoading, isFetching, refetch } = useQuery<FacilityReservation[]>({
    queryKey: [...QUERY_KEY, limit],
    queryFn: async () => {
      if (!schoolId) return [];

      // 1. Get facility IDs for this school
      const { data: facilityIds } = await supabase
        .from('facilities')
        .select('id')
        .eq('school_id', schoolId);

      if (!facilityIds || facilityIds.length === 0) return [];

      const ids = facilityIds.map(f => f.id);

      // 2. Fetch reservations from facility_reservations and session_bookings
      const [resvResult, sbResult] = await Promise.all([
        supabase
          .from('facility_reservations')
          .select(`
            *,
            facility:facilities ( name, type, capacity ),
            requester:profiles!facility_reservations_user_id_fkey ( full_name, email )
          `)
          .in('facility_id', ids)
          .order('reservation_date', { ascending: false })
          .limit(limit),
        supabase
          .from('session_bookings')
          .select(`
            id,
            status,
            created_at,
            user_id,
            child_id,
            unregistered_athlete_id,
            unregistered_athlete:unregistered_athletes ( full_name, email, phone ),
            profile:profiles ( full_name, email ),
            child:children ( full_name ),
            session:attendance_sessions!inner (
              id,
              session_date,
              start_time,
              end_time,
              facility_id,
              facility:facilities ( id, name, type, capacity )
            )
          `)
          .eq('school_id', schoolId)
          .order('created_at', { ascending: false })
          .limit(limit)
      ]);

      setHasMore(
        (resvResult.data?.length ?? 0) >= limit || (sbResult.data?.length ?? 0) >= limit,
      );

      if (resvResult.error) throw resvResult.error;
      if (sbResult.error) {
        console.error('Error fetching session bookings in useFacilityReservations:', sbResult.error);
        throw sbResult.error;
      }

      // 3. Map session_bookings to the same FacilityReservation format
      const mappedSessionBookings: FacilityReservation[] = (sbResult.data || [])
        .filter((sb: any) => sb.session && sb.session.facility)
        .map((sb: any) => {
          let requesterName = 'Invitado';
          let requesterEmail = '—';
          
          if (sb.unregistered_athlete) {
            requesterName = sb.unregistered_athlete.full_name || 'Invitado';
            requesterEmail = sb.unregistered_athlete.email || '—';
          } else if (sb.child) {
            requesterName = sb.child.full_name;
            requesterEmail = sb.profile?.email || '—';
          } else if (sb.profile) {
            requesterName = sb.profile.full_name;
            requesterEmail = sb.profile.email || '—';
          }

          return {
            id: sb.id,
            facility_id: sb.session.facility.id,
            user_id: sb.user_id || sb.unregistered_athlete_id || '',
            team_id: null,
            reservation_date: sb.session.session_date,
            start_time: sb.session.start_time,
            end_time: sb.session.end_time,
            status: sb.status as ResvStatus,
            price: 0,
            participants: 1,
            notes: sb.unregistered_athlete ? 'Clase de cortesía (Invitado)' : 'Reserva de socio / plan',
            approved_by: null,
            approved_at: null,
            created_at: sb.created_at,
            updated_at: sb.created_at,
            facility: {
              name: sb.session.facility.name,
              type: sb.session.facility.type,
              capacity: sb.session.facility.capacity
            },
            requester: {
              full_name: requesterName,
              email: requesterEmail
            },
            isSessionBooking: true
          };
        });

      const merged = [
        ...((resvResult.data || []) as any[]),
        ...mappedSessionBookings
      ];

      // Sort by reservation_date desc, then start_time asc
      return merged.sort((a, b) => {
        const dateCompare = b.reservation_date.localeCompare(a.reservation_date);
        if (dateCompare !== 0) return dateCompare;
        return a.start_time.localeCompare(b.start_time);
      });
    },
    enabled: !!schoolId,
  });

  // El page memoiza getBookedSlots con deps vacías: leer la lista por ref evita un cierre viejo.
  const reservationsRef = useRef(reservations);
  reservationsRef.current = reservations;

  // ── CREATE ────────────────────────────────────────────────────────────────

  const { mutateAsync: createReservation, isPending: isCreating } = useMutation({
    mutationFn: async (payload: CreateReservationPayload) => {
      if (!user) throw new Error('No autenticado');

      const { data, error } = await supabase
        .from('facility_reservations')
        .insert({
          ...payload,
          user_id: user.id,
          status: payload.status ?? 'confirmed',
        })
        .select()
        .single();

      if (error) throw new Error(friendlyReservationError(error));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-roster'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      toast({ title: '✅ Reserva creada', description: 'La reserva fue registrada exitosamente.' });
    },
    onError: (error: any) => {
      toast({ title: 'Error al crear', description: error.message, variant: 'destructive' });
    },
  });

  // ── UPDATE ────────────────────────────────────────────────────────────────

  const { mutateAsync: updateReservation, isPending: isUpdating } = useMutation({
    mutationFn: async ({ id, payload, isSessionBooking }: { id: string; payload: UpdateReservationPayload; isSessionBooking?: boolean }) => {
      if (isSessionBooking) {
        const { data, error } = await supabase
          .from('session_bookings')
          .update({
            status: payload.status,
            updated_at: new Date().toISOString()
          } as any)
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        return data;
      }

      const { data, error } = await supabase
        .from('facility_reservations')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(friendlyReservationError(error));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-roster'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      toast({ title: '✅ Reserva actualizada' });
    },
    onError: (error: any) => {
      toast({ title: 'Error al actualizar', description: error.message, variant: 'destructive' });
    },
  });

  // ── QUICK STATUS HELPERS ──────────────────────────────────────────────────

  // Aprobar y completar pasan por el BFF: el servidor fija approved_by /
  // approved_at (antes los mandaba el navegador). Las clases de cortesía
  // (session_bookings) siguen actualizándose por updateReservation.
  const { mutateAsync: statusViaBffMutation } = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'complete' }) =>
      bffClient.patch<unknown>(`/api/v1/reservations-admin/facility/${id}/${action}`, {}),
    onSuccess: (_data, { action }) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      toast({ title: action === 'approve' ? '✅ Reserva aprobada' : '✅ Reserva completada' });
    },
    onError: (error: any, { action }) => {
      toast({
        title: action === 'approve' ? 'Error al aprobar' : 'Error al completar',
        description: friendlyReservationError(error),
        variant: 'destructive',
      });
    },
  });

  const approveReservation = async (id: string) => {
    if (!user) return;
    const isSessionBooking = reservations.find(r => r.id === id)?.isSessionBooking;
    if (isSessionBooking) {
      await updateReservation({ id, payload: { status: 'confirmed' }, isSessionBooking });
      return;
    }
    await statusViaBffMutation({ id, action: 'approve' }).catch(() => undefined);
  };

  // Cancelar pasa por el BFF (no Supabase directo) para poder mandar el
  // correo de aviso del lado del servidor — ver reservations-admin.routes.ts.
  const { mutateAsync: cancelReservationMutation, isPending: isCancelling } = useMutation({
    // Filas de facility_reservations con starts_at: POST /reservations/:id/cancel (calcula la
    // devolución según la política). Clases de cortesía: reservations-admin, como siempre.
    mutationFn: async ({ id, isSessionBooking, reason }: { id: string; isSessionBooking?: boolean; reason?: string }):
      Promise<ReservationChangeNotice | CancelResult> => {
      if (isSessionBooking) {
        return bffClient.patch<ReservationChangeNotice>(`/api/v1/reservations-admin/courtesy/${id}/cancel`, { reason });
      }
      const row = reservationsRef.current.find((r) => r.id === id);
      if (row && usesNewReservationRoutes(row)) return cancelBooking(id, reason);
      return bffClient.patch<ReservationChangeNotice>(`/api/v1/reservations-admin/facility/${id}/cancel`, { reason });
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
      if ('reservation' in result) {
        const refund = describeRefund(result.refund);
        toast({
          title: result.already_cancelled ? 'La reserva ya estaba cancelada' : '✅ Reserva cancelada',
          description: refund || undefined,
        });
        return;
      }
      toast({ title: result.email_sent ? '✅ Reserva cancelada — correo enviado' : '✅ Reserva cancelada' });
    },
    onError: (error: any) => {
      toast({ title: 'Error al cancelar', description: friendlyCancelError(error), variant: 'destructive' });
    },
  });

  const cancelReservation = async (id: string, reason?: string) => {
    const isSessionBooking = reservations.find(r => r.id === id)?.isSessionBooking;
    return cancelReservationMutation({ id, isSessionBooking, reason });
  };

  // Reprogramar (cambio de fecha/hora) — igual que cancelar, pasa por el BFF
  // para poder avisar por correo. Para clases de cortesía revalida cupo real
  // vía session_booking_reschedule (RPC atómica); para alquiler manual el
  // trigger de choque de horario ya protegía esto.
  const { mutateAsync: rescheduleReservationMutation, isPending: isRescheduling } = useMutation({
    mutationFn: (payload: RescheduleReservationPayload) => {
      if (payload.isSessionBooking) {
        if (!payload.facility_availability_id) throw new Error('facility_availability_id es requerido para reprogramar una clase de cortesía.');
        return bffClient.patch<ReservationChangeNotice>(`/api/v1/reservations-admin/courtesy/${payload.id}/reschedule`, {
          facility_availability_id: payload.facility_availability_id,
          date: payload.reservation_date,
          start_time: payload.start_time,
          end_time: payload.end_time,
        });
      }
      return bffClient.patch<ReservationChangeNotice>(`/api/v1/reservations-admin/facility/${payload.id}/reschedule`, {
        reservation_date: payload.reservation_date,
        start_time: payload.start_time,
        end_time: payload.end_time,
      });
    },
    onSuccess: (notice) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast({ title: notice.email_sent ? '✅ Reserva reprogramada — correo enviado' : '✅ Reserva reprogramada' });
    },
    onError: (error: any) => {
      toast({ title: 'No se pudo reprogramar', description: error.message, variant: 'destructive' });
    },
  });

  // Slots libres solo-por-cancha (sin coach) para reprogramar una clase de
  // cortesía — GET /courtesy/slots del mismo router.
  const getCourtesySlots = async (facilityId: string, from: string, to: string): Promise<CourtesySlot[]> => {
    const params = new URLSearchParams({ facility_id: facilityId, from, to });
    return bffClient.get<CourtesySlot[]>(`/api/v1/reservations-admin/courtesy/slots?${params.toString()}`);
  };

  const completeReservation = async (id: string) => {
    const isSessionBooking = reservations.find(r => r.id === id)?.isSessionBooking;
    if (isSessionBooking) {
      await updateReservation({ id, payload: { status: 'completed' }, isSessionBooking });
      return;
    }
    await statusViaBffMutation({ id, action: 'complete' }).catch(() => undefined);
  };

  // ── DELETE (hard, vía BFF) ───────────────────────────────────────────────
  // RLS bloquea el DELETE directo a propósito (session_bookings_delete_none
  // en session_bookings; facility_reservations solo deja borrar al propio
  // autor con status='pending') — escribir Supabase directo acá hacía que
  // el DELETE afectara 0 filas en silencio y el toast dijera "eliminado"
  // sin haber borrado nada. Solo el BFF (service_role, owner/admin) puede.

  const { mutateAsync: deleteReservation, isPending: isDeleting } = useMutation({
    mutationFn: (id: string) => {
      const isSessionBooking = reservations.find(r => r.id === id)?.isSessionBooking;
      const path = isSessionBooking
        ? `/api/v1/reservations-admin/courtesy/${id}`
        : `/api/v1/reservations-admin/facility/${id}`;
      return bffClient.delete<{ success: boolean }>(path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-bookings'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-roster'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      toast({ title: 'Reserva eliminada', description: 'El registro fue removido permanentemente.' });
    },
    onError: (error: any) => {
      toast({ title: 'Error al eliminar', description: error.message, variant: 'destructive' });
    },
  });

  // ── DERIVED ───────────────────────────────────────────────────────────────

  const stats = {
    total: reservations.length,
    confirmed: reservations.filter((r) => r.status === 'confirmed').length,
    pending: reservations.filter((r) => r.status === 'pending').length,
    cancelled: reservations.filter((r) => r.status === 'cancelled').length,
    completed: reservations.filter((r) => r.status === 'completed').length,
  };

  // Franjas ocupadas ('HH:mm') de una instalación en una fecha. Normaliza
  // 'HH:mm:ss' y bloquea TODAS las horas del rango [inicio, fin) de reservas
  // pending/confirmed, más las clases de cortesía ya cargadas en la lista.
  const getBookedSlots = async (facilityId: string, date: Date, excludeId?: string) => {
    const day = format(date, 'yyyy-MM-dd');
    const { data } = await supabase
      .from('facility_reservations')
      .select('id, start_time, end_time')
      .eq('facility_id', facilityId)
      .eq('reservation_date', day)
      .in('status', ['pending', 'confirmed', 'hold', 'pending_payment']);

    const ranges: Array<{ start: string; end: string }> = (data ?? [])
      .filter((r) => r.id !== excludeId)
      .map((r) => ({ start: r.start_time, end: r.end_time }));

    for (const r of reservationsRef.current) {
      if (
        r.isSessionBooking &&
        r.id !== excludeId &&
        r.facility_id === facilityId &&
        r.reservation_date === day &&
        (r.status === 'pending' || r.status === 'confirmed')
      ) {
        ranges.push({ start: r.start_time, end: r.end_time });
      }
    }

    return Array.from(new Set(ranges.flatMap((r) => expandOccupiedSlots(r.start, r.end))));
  };

  return {
    reservations,
    isLoading,
    isFetching,
    refetch,
    hasMore,
    loadMore: () => setLimit((l) => l + PAGE_SIZE),
    stats,
    // mutations
    createReservation,
    isCreating,
    updateReservation,
    isUpdating,
    deleteReservation,
    isDeleting,
    // helpers
    approveReservation,
    cancelReservation,
    isCancelling,
    completeReservation,
    getBookedSlots,
    rescheduleReservation: rescheduleReservationMutation,
    isRescheduling,
    getCourtesySlots,
  };
}

