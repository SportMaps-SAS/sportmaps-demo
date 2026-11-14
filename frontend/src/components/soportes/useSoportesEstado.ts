/**
 * Estado de soportes de TODA la escuela (una sola llamada). Si la función está
 * apagada (`activo: false`), sin migración o sin permiso, el hook devuelve
 * `activo: false` y NADA de soportes se pinta: ninguna otra escuela cambia.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { soportesApi, indexarEstado, type EstadoSoportes } from '@/lib/api/soportes';

export const SOPORTES_ESTADO_KEY = 'soportes-estado';

export function useSoportesEstado(schoolId: string | null | undefined, habilitado = true) {
  const q = useQuery<EstadoSoportes>({
    queryKey: [SOPORTES_ESTADO_KEY, schoolId],
    queryFn: () => soportesApi.estado(schoolId as string),
    enabled: !!schoolId && habilitado,
    retry: false,
    staleTime: 60_000,
  });
  const activo = !!q.data?.activo;
  const indice = useMemo(() => indexarEstado(q.data), [q.data]);
  return {
    activo,
    estado: activo ? q.data! : null,
    indice,
    cargando: q.isLoading,
    error: q.isError,
    refetch: q.refetch,
  };
}
