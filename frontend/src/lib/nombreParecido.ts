import { normalizeText } from '@/lib/normalizeText';

/**
 * ¿Dos nombres de persona son «casi el mismo»? Pensado para atrapar la errata
 * de tipeo que el chequeo exacto deja pasar (caso real, 2026-11-14, Dreamers:
 * «Santiago Rodriguez Mesa» y «Santiago Rodruguez Mesa» quedaron como dos hijos
 * del mismo acudiente, y el sistema los contó como hermanos).
 *
 * Reglas, a propósito conservadoras para no avisar de más:
 *   · nombres ya normalizados (sin tildes, minúsculas, espacios colapsados);
 *   · NO cuenta si son idénticos: eso lo atrapa el chequeo exacto, que bloquea;
 *   · mismo número de palabras y al menos dos (un nombre de pila suelto no basta);
 *   · distancia de edición ≤ 1 (≤ 2 desde 20 caracteres).
 * «Juan David Pérez» y «Juan Daniel Pérez» (distancia 3) NO se marcan.
 */
export function normalizarNombrePersona(valor: string | null | undefined): string {
  return normalizeText(valor).replace(/\s+/g, ' ').trim();
}

function distanciaEdicion(a: string, b: string, tope: number): number {
  if (Math.abs(a.length - b.length) > tope) return tope + 1;
  let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    let minimo = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      const valor = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + costo);
      actual[j] = valor;
      if (valor < minimo) minimo = valor;
    }
    if (minimo > tope) return tope + 1;
    previa = actual;
  }
  return previa[b.length];
}

export function nombresParecidos(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizarNombrePersona(a);
  const nb = normalizarNombrePersona(b);
  if (!na || !nb || na === nb) return false;
  const ta = na.split(' ');
  const tb = nb.split(' ');
  if (ta.length < 2 || ta.length !== tb.length) return false;
  const tope = Math.max(na.length, nb.length) >= 20 ? 2 : 1;
  return distanciaEdicion(na, nb, tope) <= tope;
}
