import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  DEFAULT_CANCELLATION_POLICY,
  fetchAvailability,
  type AvailabilityParams,
  type CancellationPolicy,
} from './reservasApi';

// Las tablas/columnas de F1 todavía no están en types.ts: cliente sin tipar a propósito.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = supabase as any;

export type BookableBy = 'members' | 'public' | 'both';

export const BOOKABLE_BY_LABELS: Record<BookableBy, string> = {
  members: 'Solo miembros',
  public: 'Solo público',
  both: 'Ambos',
};

/** ¿La base ya tiene `facilities.bookable_by`? (mig. reservas_f1_columnas). Una vez por sesión. */
export function useBookableByDisponible(schoolId: string | null | undefined, enabled = true) {
  const q = useQuery({
    queryKey: ['facilities-bookable-by-disponible'],
    enabled: !!schoolId && enabled,
    staleTime: Infinity,
    queryFn: async () => {
      const { error } = await db.from('facilities').select('bookable_by').eq('school_id', schoolId).limit(1);
      return !error;
    },
  });
  return q.data === true;
}

/** Solo manda `bookable_by` cuando está definido (undefined = la base no lo tiene o el form no lo mostró). */
export function camposBookableBy(input: { bookable_by?: BookableBy }): { bookable_by?: BookableBy } {
  return input.bookable_by === 'members' || input.bookable_by === 'public' || input.bookable_by === 'both'
    ? { bookable_by: input.bookable_by }
    : {};
}

export function useAvailability(params: AvailabilityParams | null, enabled = true) {
  return useQuery({
    queryKey: ['reservas-availability', params],
    enabled: enabled && !!params?.school_id && !!params?.from && !!params?.to,
    staleTime: 15_000,
    retry: false,
    queryFn: () => fetchAvailability(params as AvailabilityParams),
  });
}

/** Política de la instalación, luego la de la escuela, luego 24 h / 6 h / 50 %. */
export function useCancellationPolicy(schoolId: string | null | undefined, facilityId: string | null | undefined) {
  return useQuery({
    queryKey: ['reservas-cancellation-policy', schoolId, facilityId],
    enabled: !!schoolId,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<CancellationPolicy> => {
      const { data, error } = await db
        .from('cancellation_policies')
        .select('facility_id, hours_full_refund, hours_partial_refund, partial_pct, is_active')
        .eq('school_id', schoolId)
        .eq('is_active', true);
      // Sin permiso de lectura o sin tabla: se muestra la política por defecto.
      if (error || !data?.length) return DEFAULT_CANCELLATION_POLICY;
      const row =
        data.find((p: any) => p.facility_id === facilityId) ?? data.find((p: any) => p.facility_id == null);
      if (!row) return DEFAULT_CANCELLATION_POLICY;
      return {
        hours_full_refund: Number(row.hours_full_refund),
        hours_partial_refund: Number(row.hours_partial_refund),
        partial_pct: Number(row.partial_pct),
      };
    },
  });
}
