/**
 * Orden y búsqueda de planes/tarifas (offering_plans) para las listas de la escuela.
 *
 * Orden: el `sort_order` que fije la escuela y, a igual valor, el ORDEN DE CREACIÓN.
 * Casi todas las escuelas tienen sort_order = 0 en todo, y sin desempate la base
 * devuelve las filas en cualquier orden (Dreamers veía sus 27 tarifas revueltas).
 */

interface Ordenable {
  sort_order?: number | null;
  created_at?: string | null;
  name?: string | null;
}

export function porOrdenDeCreacion(a: Ordenable, b: Ordenable): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    || (a.created_at ?? '').localeCompare(b.created_at ?? '')
    || (a.name ?? '').localeCompare(b.name ?? '', 'es', { numeric: true });
}

/** Minúsculas y sin tildes: «Viáticos» se encuentra escribiendo «viaticos». */
export function normalizar(texto: string | null | undefined): string {
  return (texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** ¿El texto contiene la búsqueda? Una búsqueda vacía coincide con todo. */
export function coincide(texto: string | null | undefined, busqueda: string): boolean {
  const b = normalizar(busqueda);
  return !b || normalizar(texto).includes(b);
}
