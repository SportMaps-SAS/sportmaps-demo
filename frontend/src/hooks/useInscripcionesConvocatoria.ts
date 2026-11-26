/**
 * Inscripciones a convocatorias (Monster's: Mayores Superliga, Sede Suba por
 * año, Sede Norte…) que llegan por WhatsApp. Pestaña «Convocatorias» de
 * Deportistas, SEPARADA de «Clase de prueba» (`listar_clase_prueba` ya no las
 * devuelve).
 *
 * RPCs: `listar_inscripciones_convocatoria(p_school_id)` y
 * `marcar_inscripcion_convocatoria(p_lead_id, p_estado, p_nota)`.
 * Si la RPC todavía no está en la base, la lista sale vacía y la pestaña no
 * se muestra (mismo criterio que `faltaEnLaBase`).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { faltaEnLaBase } from '@/lib/esquemaPendiente';
import type { EstadoInscripcion, InscripcionConvocatoria } from '@/components/students/convocatoriasModel';

export type { EstadoInscripcion, InscripcionConvocatoria } from '@/components/students/convocatoriasModel';

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase as any).rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

export function useInscripcionesConvocatoria(schoolId: string | null | undefined) {
  const qc = useQueryClient();
  const key = ['inscripciones-convocatoria', schoolId];

  const query = useQuery({
    queryKey: key,
    enabled: !!schoolId,
    queryFn: async () => {
      try {
        return (await rpc<InscripcionConvocatoria[] | null>('listar_inscripciones_convocatoria', { p_school_id: schoolId })) ?? [];
      } catch (e) {
        // Código antes que migración: sin la RPC, la pestaña simplemente no aparece.
        if (faltaEnLaBase(e as { code?: string; message?: string })) return [];
        throw e;
      }
    },
  });

  const marcar = useMutation({
    mutationFn: (p: { leadId: string; estado: EstadoInscripcion; nota: string | null }) =>
      rpc<InscripcionConvocatoria>('marcar_inscripcion_convocatoria', {
        p_lead_id: p.leadId,
        p_estado: p.estado,
        p_nota: p.nota,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  return {
    inscripciones: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch,
    marcar,
  };
}
