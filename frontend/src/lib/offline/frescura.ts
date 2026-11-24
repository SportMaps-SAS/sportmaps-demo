/**
 * Etiqueta de frescura: un dato guardado en el teléfono nunca se presenta como vigente.
 * «hoy 14:32» · «ayer 18:05» · «lun 7:10» (más de 2 días). Pura y sin zona horaria propia:
 * usa la del teléfono, que es la que ve el entrenador en la cancha.
 */

const hhmm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

const inicioDeDia = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** `null` si no hay marca de tiempo (el dato no salió de la copia o no se sabe cuándo se guardó). */
export function etiquetaFrescura(dataUpdatedAt: number | null | undefined, ahora: number = Date.now()): string | null {
  if (!dataUpdatedAt || dataUpdatedAt <= 0) return null;
  const d = new Date(dataUpdatedAt);
  const dias = Math.round((inicioDeDia(new Date(ahora)) - inicioDeDia(d)) / 86_400_000);
  if (dias <= 0) return `hoy ${hhmm(d)}`;
  if (dias === 1) return `ayer ${hhmm(d)}`;
  return `${DIAS[d.getDay()]} ${hhmm(d)}`;
}
