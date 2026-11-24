/**
 * Persistencia de lecturas de React Query en IndexedDB (modo offline, Fase 1).
 *
 *  · Solo lo de la lista blanca (`esConsultaOffline`) y solo consultas con éxito.
 *  · Una copia por USUARIO (`rq:{userId}`): otra cuenta en el mismo celular no la lee.
 *  · Se restaura una vez al conocer al usuario y DESPUÉS se empieza a guardar (si no, un guardado
 *    temprano con la memoria vacía pisaría la copia buena).
 *  · Se guarda en IndexedDB (clon estructurado), no en JSON: algunas consultas devuelven `Map`.
 *  · Todo lo que sale del teléfono por cierre de sesión pasa por `borrarCopiaLocal()`.
 */
import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import {
  OFFLINE_CACHE_VERSION, OFFLINE_ENABLED, OFFLINE_MAX_AGE_MS, OFFLINE_QUERY_PREFIXES, esConsultaOffline,
} from './offlineConfig';
import { idbDelPrefix, idbGet, idbSet } from './idbStore';

interface CopiaGuardada {
  v: number;
  userId: string;
  savedAt: number;
  state: DehydratedState;
}

const PREFIJO = 'rq:';
const claveDe = (userId: string) => `${PREFIJO}${userId}`;
const ESPERA_GUARDADO_MS = 1500;

/**
 * Las consultas de la lista blanca viven en memoria tanto como vale su copia (36 h). Con el
 * `gcTime` global (10 min) se descartarían de memoria y, sin señal, al volver a la pantalla
 * no habría nada que mostrar (la copia en disco solo se lee al arrancar).
 */
export function configurarRetencionOffline(qc: QueryClient): void {
  if (!OFFLINE_ENABLED) return;
  for (const prefix of OFFLINE_QUERY_PREFIXES) {
    // `offlineFirst`: la primera consulta se intenta aunque el navegador diga «sin red». Con el modo
    // por defecto, una consulta SIN copia guardada quedaba en pausa para siempre y nunca llegaba al
    // respaldo de `conCache`; con la copia, el refetch fallido deja el dato en pantalla (no error).
    qc.setQueryDefaults([...prefix], { gcTime: OFFLINE_MAX_AGE_MS, networkMode: 'offlineFirst' });
  }
}

/** Copia a guardar: solo lista blanca, solo éxito. Exportada para las pruebas. */
export function estadoParaGuardar(qc: QueryClient): DehydratedState {
  return dehydrate(qc, {
    shouldDehydrateQuery: (q) => q.state.status === 'success' && esConsultaOffline(q.queryKey),
  });
}

/** Devuelve cuántas consultas se restauraron. Nunca lanza. */
export async function restaurarConsultas(qc: QueryClient, userId: string, ahora = Date.now()): Promise<number> {
  if (!OFFLINE_ENABLED) return 0;
  try {
    const copia = await idbGet<CopiaGuardada>(claveDe(userId));
    if (!copia || copia.v !== OFFLINE_CACHE_VERSION || copia.userId !== userId) return 0;
    if (ahora - copia.savedAt > OFFLINE_MAX_AGE_MS) return 0;
    const queries = (copia.state?.queries ?? []).filter(
      (q) => esConsultaOffline(q.queryKey) && ahora - (q.state?.dataUpdatedAt ?? 0) <= OFFLINE_MAX_AGE_MS,
    );
    if (queries.length === 0) return 0;
    hydrate(qc, { mutations: [], queries });
    return queries.length;
  } catch {
    return 0;
  }
}

/** Empieza a guardar cada cambio (con espera). Devuelve la función que lo detiene. */
export function iniciarGuardado(qc: QueryClient, userId: string): () => void {
  if (!OFFLINE_ENABLED) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let detenido = false;

  const guardarYa = () => {
    timer = null;
    if (detenido) return;
    try {
      const state = estadoParaGuardar(qc);
      if (state.queries.length === 0) return;
      void idbSet(claveDe(userId), { v: OFFLINE_CACHE_VERSION, userId, savedAt: Date.now(), state } satisfies CopiaGuardada);
    } catch { /* clon estructurado imposible o sin espacio: se sigue sin copia */ }
  };

  const programar = () => {
    if (detenido || timer) return;
    timer = setTimeout(guardarYa, ESPERA_GUARDADO_MS);
  };

  const unsub = qc.getQueryCache().subscribe((ev) => {
    if (ev.type === 'updated' && ev.action.type === 'success' && esConsultaOffline(ev.query.queryKey)) programar();
    else if (ev.type === 'removed' && esConsultaOffline(ev.query.queryKey)) programar();
  });

  return () => {
    detenido = true;
    if (timer) clearTimeout(timer);
    unsub();
  };
}

/** Cierre de sesión o cambio de usuario: se borra la copia de TODOS los usuarios de este celular. */
export async function borrarCopiaLocal(): Promise<void> {
  try { await idbDelPrefix(PREFIJO); } catch { /* sin almacén: nada que borrar */ }
}
