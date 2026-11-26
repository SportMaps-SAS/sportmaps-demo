/**
 * Semáforo de habilitación EN VIVO al escanear un carnet (carnet 3D F5, spec §8).
 * RPC estado_habilitacion(p_qr_token, p_event_id) — solo con sesión; el público no tiene acceso.
 * Nunca se cachea entre escaneos ni se pinta en el carnet (D7).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { vistaDeEstado, type EstadoHabilitacionRpc, type VistaHabilitacion } from '@/lib/cards/habilitacion';

export function claveEstadoHabilitacion(qrToken: string | null | undefined, eventId: string | null | undefined) {
  return ['estado-habilitacion', qrToken ?? null, eventId ?? null] as const;
}

export function useEstadoHabilitacion(qrToken: string | null | undefined, eventId?: string | null) {
  return useQuery<VistaHabilitacion>({
    queryKey: claveEstadoHabilitacion(qrToken, eventId),
    enabled: !!qrToken,
    // En vivo: siempre se vuelve a preguntar al abrir o al volver a la pestaña.
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('estado_habilitacion' as never, {
        p_qr_token: qrToken,
        p_event_id: eventId ?? null,
      } as never);
      if (error) {
        // Sin EXECUTE (sesión anónima) = sin acceso, no un error que mostrar.
        if ((error as { code?: string }).code === '42501') return { tipo: 'sin_acceso' } as VistaHabilitacion;
        throw error;
      }
      return vistaDeEstado(data as unknown as EstadoHabilitacionRpc);
    },
  });
}
