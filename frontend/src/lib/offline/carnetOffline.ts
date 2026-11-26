/**
 * Carnet del deportista sin señal (modo offline, Fase 5, solo lectura).
 *
 * El caso real: llegar a la entrada del club y no tener datos. El carnet es solo el QR + nombre +
 * escuela + vigencia, así que se guarda la última respuesta de `my_athlete_id_cards` (solo las
 * filas `self`) con las copias de arranque: por usuario, en este teléfono, y se borra al cerrar
 * sesión (prefijo `sm_offline_boot:`). NO se guarda el reverso del carnet 3D (salud, contacto).
 *
 * Dos cuidados:
 *  · `is_expired` lo calcula el servidor: en la copia se RECALCULA con la hora del teléfono, o un
 *    carnet vencido seguiría saliendo «Vigente» hasta que vuelva la señal.
 *  · Si la escuela lo anuló después de la copia, no se sabe sin red: la pantalla lo avisa.
 */
import { guardarCopiaArranque, leerCopiaArranque } from './arranqueSinRed';

const NOMBRE = 'carnet-deportista';

export interface CarnetCopiable { valid_until: string; is_expired: boolean; relation?: string }
interface Guardado<T> { rows: T[]; guardadoEn: number }

/** `valid_until` vale TODO ese día (sin hora = hasta las 23:59 locales). */
function finDeVigencia(v: string): number {
  const d = new Date(v.length <= 10 ? `${v}T23:59:59` : v);
  return d.getTime();
}

/** Marca como vencidos los carnets cuya vigencia ya pasó según la hora del teléfono. */
export function aplicarVigencia<T extends CarnetCopiable>(rows: readonly T[], ahora = Date.now()): T[] {
  return rows.map((r) => {
    const fin = finDeVigencia(r.valid_until);
    return r.is_expired || Number.isNaN(fin) || fin >= ahora ? r : { ...r, is_expired: true };
  });
}

export function guardarCarnets<T extends CarnetCopiable>(userId: string | undefined, rows: readonly T[]): void {
  if (!userId) return;
  // Solo el carnet propio: nunca el de un hijo (datos de menores).
  const propios = rows.filter((r) => r.relation === 'self');
  if (propios.length === 0) return;
  guardarCopiaArranque<Guardado<T>>(NOMBRE, userId, { rows: propios, guardadoEn: Date.now() });
}

/** La última copia de ESTE usuario, con la vigencia recalculada. null si no hay o es de otro. */
export function leerCarnets<T extends CarnetCopiable>(userId: string | undefined, ahora = Date.now()): { rows: T[]; guardadoEn: number } | null {
  if (!userId) return null;
  const g = leerCopiaArranque<Guardado<T>>(NOMBRE, userId, undefined, ahora);
  if (!g || !Array.isArray(g.rows) || g.rows.length === 0) return null;
  return { rows: aplicarVigencia(g.rows, ahora), guardadoEn: g.guardadoEn };
}
