/**
 * Filtro de sede de los cobros (panel «Cobros y pagos»).
 *
 * Con una sede elegida salen los cobros de ESA sede y también los que no tienen
 * sede (`branch_id` NULL), que se ven con la etiqueta «Sin sede». Antes, en una
 * escuela multisede, el filtro era `branch_id = X` a secas y los cobros sin sede
 * desaparecían del panel: en Monster, 15 de 19 cobros sin sede eran de la
 * clínica y quedaban invisibles apenas se elegía una sede. Esconder plata
 * pendiente por un dato que le falta al cobro es peor que mostrarlo en dos
 * sedes. «Todas» (sin sede activa) no filtra nada.
 *
 * Devuelve la expresión para `query.or(...)` de PostgREST, o null si no hay que
 * filtrar. El id de sede es un uuid del propio sistema; aun así se descartan los
 * caracteres que rompen la sintaxis del filtro.
 */
export function filtroDeSede(activeBranchId: string | null | undefined): string | null {
  if (!activeBranchId) return null;
  const id = String(activeBranchId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!id) return null;
  return `branch_id.is.null,branch_id.eq.${id}`;
}

/** Misma regla, en memoria (para listas ya cargadas). */
export function cobroEnSede(
  branchId: string | null | undefined,
  activeBranchId: string | null | undefined,
): boolean {
  if (!activeBranchId) return true;
  return !branchId || branchId === activeBranchId;
}
