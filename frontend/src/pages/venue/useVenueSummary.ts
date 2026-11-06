import { useQuery } from '@tanstack/react-query';
import { addDays, endOfMonth, format, startOfMonth, startOfWeek } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolFacilities } from '@/hooks/useSchoolData';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import type { VenueReservationRow } from './venueMetrics';

/**
 * Lectura del panel del dueño de espacios. Solo SELECT con el cliente normal:
 * lo que la RLS no deje ver, no se ve (se reporta, no se fuerza). Una sola
 * consulta de reservas que cubre el mes y la semana en curso.
 */
export function useVenueSummary() {
  const { schoolId } = useSchoolContext();
  const { facilities, isLoading: loadingFacilities } = useSchoolFacilities();
  const ids = (facilities ?? []).map((f) => f.id);

  const hoy = new Date();
  const lunes = startOfWeek(hoy, { weekStartsOn: 1 });
  const desde = format(startOfMonth(hoy) < lunes ? startOfMonth(hoy) : lunes, 'yyyy-MM-dd');
  const hasta = format(endOfMonth(addDays(hoy, 7)), 'yyyy-MM-dd');

  const reservasQuery = useQuery({
    queryKey: ['venue-summary-reservations', schoolId, ids.join(','), desde, hasta],
    enabled: !!schoolId && ids.length > 0,
    queryFn: async (): Promise<VenueReservationRow[]> => {
      const { data, error } = await supabase
        .from('facility_reservations')
        .select('id, facility_id, reservation_date, start_time, end_time, status, price, amount_paid')
        .in('facility_id', ids)
        .gte('reservation_date', desde)
        .lte('reservation_date', hasta)
        .order('reservation_date', { ascending: true })
        .order('start_time', { ascending: true })
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as unknown as VenueReservationRow[];
    },
  });

  return {
    facilities: facilities ?? [],
    reservations: reservasQuery.data ?? [],
    loading: loadingFacilities || (ids.length > 0 && reservasQuery.isLoading),
    error: reservasQuery.error as Error | null,
    hoyIso: format(hoy, 'yyyy-MM-dd'),
    semanaIso: { desde: format(lunes, 'yyyy-MM-dd'), hasta: format(addDays(lunes, 6), 'yyyy-MM-dd') },
    mesIso: { desde: format(startOfMonth(hoy), 'yyyy-MM-dd'), hasta: format(endOfMonth(hoy), 'yyyy-MM-dd') },
  };
}
