/**
 * Orden de «Pagos recibidos» (Gestión de Pagos).
 *
 * 1. Día del pago, del más reciente al más viejo (como antes).
 * 2. Dentro del día, los pagos de un mismo atleta van JUNTOS. Antes el
 *    desempate era solo `created_at` (cuándo se emitió el cobro), y una niña
 *    con la mensualidad y las horas adicionales pagadas el mismo día quedaba
 *    partida por los pagos de otras familias. Los grupos se ordenan por su
 *    movimiento más reciente, para que lo último siga arriba.
 * 3. Dentro del atleta, del más reciente al más viejo.
 *
 * El atleta es `child_id` / `user_id` / `unregistered_athlete_id` (las tres
 * columnas, nunca solo `child_id`); `parent_id` solo como respaldo de cobros
 * viejos de adultos. Sin ninguna, el pago va solo.
 */
export interface FilaPagoRecibido {
  id: string;
  created_at?: string | null;
  child_id?: string | null;
  user_id?: string | null;
  unregistered_athlete_id?: string | null;
  parent_id?: string | null;
}

export function claveAtleta(p: FilaPagoRecibido): string {
  return p.child_id ?? p.user_id ?? p.unregistered_athlete_id ?? p.parent_id ?? `pago:${p.id}`;
}

/**
 * Junta las filas de un mismo atleta sin cambiar el orden que ya traía la lista:
 * cada atleta queda donde apareció por primera vez y sus filas siguen en su orden.
 * Para listas que solo traen el NOMBRE (glosas, filas de un lote, informe de
 * descuentos). Sin nombre, la fila va sola.
 */
export function juntarPorAtleta<T>(filas: readonly T[], nombre: (f: T) => string | null | undefined): T[] {
  const grupos = new Map<string, T[]>();
  filas.forEach((f, i) => {
    const n = (nombre(f) ?? '').trim().toLocaleLowerCase('es');
    const k = n ? `n:${n}` : `i:${i}`;
    const g = grupos.get(k);
    if (g) g.push(f);
    else grupos.set(k, [f]);
  });
  return [...grupos.values()].flat();
}

/**
 * Para dibujar un grupo como bloque: por cada fila, si CONTINÚA el grupo de la
 * anterior (no repetir fecha ni nombre, sin línea arriba) y si el grupo SIGUE en
 * la próxima (sin línea abajo). La lista ya debe venir ordenada.
 */
export function marcarGrupos<T extends { id: string }>(
  filas: readonly T[],
  clave: (f: T) => string,
): Map<string, { continua: boolean; sigue: boolean }> {
  const out = new Map<string, { continua: boolean; sigue: boolean }>();
  filas.forEach((f, i) => {
    const k = clave(f);
    out.set(f.id, {
      continua: i > 0 && clave(filas[i - 1]) === k,
      sigue: i < filas.length - 1 && clave(filas[i + 1]) === k,
    });
  });
  return out;
}

export function ordenarPagosRecibidos<T extends FilaPagoRecibido>(filas: T[], diaDe: (p: T) => string): T[] {
  const creado = (p: T) => p.created_at ?? '';
  const grupo = (p: T) => `${diaDe(p)}|${claveAtleta(p)}`;

  // Lo más reciente de cada atleta en cada día: ordena los grupos entre sí.
  const ultimo = new Map<string, string>();
  for (const p of filas) {
    const k = grupo(p);
    const c = creado(p);
    const prev = ultimo.get(k);
    if (prev === undefined || c > prev) ultimo.set(k, c);
  }

  return [...filas].sort((a, b) => {
    const da = diaDe(a);
    const db = diaDe(b);
    if (da !== db) return db.localeCompare(da);
    const ga = grupo(a);
    const gb = grupo(b);
    if (ga !== gb) {
      return (ultimo.get(gb) ?? '').localeCompare(ultimo.get(ga) ?? '') || ga.localeCompare(gb);
    }
    return creado(b).localeCompare(creado(a)) || b.id.localeCompare(a.id);
  });
}
