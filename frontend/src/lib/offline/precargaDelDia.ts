/**
 * Precarga del día del entrenador: roster y lista de HOY de cada uno de sus equipos, para que
 * existan en el teléfono cuando se vaya la señal en la cancha. Antes solo se bajaba el roster al
 * abrir ese equipo (con red), así que un equipo que no se había abierto no abría offline.
 *
 * Cuidado con Disk IO (la base es UNA sola, ver CLAUDE.md): máximo `MAX_EQUIPOS` equipos, de a
 * `PARALELO` a la vez, solo si no hay copia fresca (`prefetchQuery` respeta el `staleTime`) y solo
 * con red. Las consultas son las MISMAS de la pantalla (misma `queryKey` y `queryFn`).
 */
import type { QueryClient } from '@tanstack/react-query';
import { OFFLINE_ENABLED, sinRedAhora } from './offlineConfig';
import {
  rosterQueryOptions, sesionDelDiaQueryOptions, type ContextoLista,
} from '@/components/coach/v2/useAsistenciaV2Data';

export const MAX_EQUIPOS_PRECARGA = 8;
export const PARALELO_PRECARGA = 2;
/** Un dato precargado hace menos de esto no se vuelve a pedir. */
export const FRESCO_PRECARGA_MS = 10 * 60 * 1000;

export interface EquipoMinimo { id: string; nombre: string }

export async function precargarDiaDelEntrenador(
  qc: QueryClient,
  equipos: readonly EquipoMinimo[],
  hoy: string,
  opts: { seguir?: () => boolean } = {},
): Promise<number> {
  if (!OFFLINE_ENABLED || sinRedAhora()) return 0;
  const lote = equipos.slice(0, MAX_EQUIPOS_PRECARGA);
  let hechos = 0;
  let i = 0;

  const trabajador = async () => {
    while (i < lote.length) {
      if (sinRedAhora() || (opts.seguir && !opts.seguir())) return;
      const eq = lote[i++];
      const ctx: ContextoLista = { tipo: 'team', id: eq.id, nombre: eq.nombre };
      try {
        await Promise.all([
          qc.prefetchQuery({ ...rosterQueryOptions('team', eq.id), staleTime: FRESCO_PRECARGA_MS }),
          qc.prefetchQuery({ ...sesionDelDiaQueryOptions(ctx, hoy), staleTime: FRESCO_PRECARGA_MS }),
        ]);
        hechos += 1;
      } catch { /* prefetchQuery no lanza; por si acaso */ }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PARALELO_PRECARGA, lote.length) }, trabajador));
  return hechos;
}
