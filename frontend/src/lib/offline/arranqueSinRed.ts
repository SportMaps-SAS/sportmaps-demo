/**
 * Arranque sin señal: lo mínimo para que la app abra y reconozca a la persona cuando la red falla.
 *
 * Tres piezas, todas SOLO en el camino de falla (con red, nada de esto se usa):
 *  1. `leerSesionGuardada()` — la sesión que supabase-js dejó en localStorage. Si `getSession()`
 *     devuelve null pero la sesión SIGUE guardada, es porque el refresco del token falló por red
 *     (un rechazo real —token revocado— la borra): no es un cierre de sesión.
 *  2. Copias de lo que Auth y la escuela resuelven al arrancar (perfil, contextos, membresías),
 *     por usuario, con vencimiento. Se usan solo si la consulta real falló.
 *  3. `limpiarDatosOffline()` — todo esto sale del teléfono al cerrar sesión.
 *
 * Nada de esto otorga acceso: el servidor (RLS + gates del BFF) decide al sincronizar.
 */
import { OFFLINE_ENABLED } from './offlineConfig';
import { borrarCopiaLocal } from './queryPersistence';

const PREFIJO_COPIA = 'sm_offline_boot:';
/** Una copia de perfil/membresías más vieja que esto no se usa: los roles pueden haber cambiado. */
export const COPIA_ARRANQUE_MAX_EDAD_MS = 14 * 24 * 60 * 60 * 1000;

/** Prefijos de localStorage que son del DISPOSITIVO y no de la persona: se borran al salir. */
const PREFIJOS_A_BORRAR_AL_SALIR = [
  PREFIJO_COPIA,
  // Lecturas del entrenador (roster, equipos, lista del día) de `conCache`. Antes NO se
  // borraban al cerrar sesión: en un celular compartido el siguiente usuario podía leerlas.
  'sm_coach_v2_cache:',
];

export interface UsuarioGuardado { id: string; email?: string | null; [k: string]: unknown }

/** Sesión que dejó supabase-js (`sb-<ref>-auth-token`). Nunca lanza. */
export function leerSesionGuardada(storage: Pick<Storage, 'length' | 'key' | 'getItem'> | null = almacenamiento()): { user: UsuarioGuardado } | null {
  if (!OFFLINE_ENABLED || !storage) return null;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
      const raw = storage.getItem(k);
      if (!raw) continue;
      const s = JSON.parse(raw) as { user?: UsuarioGuardado; refresh_token?: string } | null;
      if (s?.user?.id && s.refresh_token) return { user: s.user };
    }
  } catch { /* ilegible: sin sesión guardada */ }
  return null;
}

interface Copia<T> { v: 1; userId: string; savedAt: number; datos: T }

function almacenamiento(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function guardarCopiaArranque<T>(nombre: string, userId: string, datos: T, storage: Pick<Storage, 'setItem'> | null = almacenamiento()): void {
  if (!OFFLINE_ENABLED || !storage || !userId) return;
  try {
    const c: Copia<T> = { v: 1, userId, savedAt: Date.now(), datos };
    storage.setItem(`${PREFIJO_COPIA}${nombre}:${userId}`, JSON.stringify(c));
  } catch { /* lleno o bloqueado: sin copia */ }
}

export function leerCopiaArranque<T>(nombre: string, userId: string, storage: Pick<Storage, 'getItem'> | null = almacenamiento(), ahora = Date.now()): T | null {
  if (!OFFLINE_ENABLED || !storage || !userId) return null;
  try {
    const raw = storage.getItem(`${PREFIJO_COPIA}${nombre}:${userId}`);
    if (!raw) return null;
    const c = JSON.parse(raw) as Copia<T>;
    if (c?.v !== 1 || c.userId !== userId) return null;
    if (ahora - c.savedAt > COPIA_ARRANQUE_MAX_EDAD_MS) return null;
    return c.datos ?? null;
  } catch {
    return null;
  }
}

/** Cierre de sesión: borra lo guardado para el modo offline (copias, lecturas y consultas persistidas). */
export function limpiarDatosOffline(storage: Storage | null = almacenamiento()): Promise<void> {
  try {
    if (storage) {
      const borrar: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && PREFIJOS_A_BORRAR_AL_SALIR.some((p) => k.startsWith(p))) borrar.push(k);
      }
      borrar.forEach((k) => { try { storage.removeItem(k); } catch { /* no-op */ } });
    }
  } catch { /* sin storage */ }
  return borrarCopiaLocal();
}
