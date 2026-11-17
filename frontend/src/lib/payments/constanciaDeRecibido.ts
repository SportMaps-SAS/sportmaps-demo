/**
 * constanciaDeRecibido — la constancia de un pago que pasa a «pagado» SIN comprobante.
 *
 * Caso origen (Monster's Volley, 11-nov-2026): una administradora aprobó una
 * mensualidad sin comprobante y no quedó escrito cómo se recibió la plata, cuándo
 * ni quién la recibió. Sin columnas nuevas, la constancia vive en lo que ya existe:
 *   · cómo  → payments.payment_method
 *   · cuándo → payments.payment_date
 *   · quién aprobó en el sistema → approved_by / approved_at
 *   · quién RECIBIÓ la plata (persona del equipo, texto corto) → una línea
 *     estructurada al inicio de payments.notes con prefijo estable:
 *       [Recibido: efectivo · 2026-11-11 · por Alejandra L.]
 *
 * El prefijo `[Recibido:` es estable a propósito: permite buscarlo con un LIKE y
 * lo usaría el trigger de la mitigación de servidor (ver el informe).
 */

export const PREFIJO_RECIBIDO = '[Recibido:';

export type MedioRecibido = 'cash' | 'transfer' | 'other';

export const MEDIOS_RECIBIDO: ReadonlyArray<{ value: MedioRecibido; label: string }> = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'other', label: 'Otro medio' },
];

const ETIQUETA: Record<MedioRecibido, string> = { cash: 'efectivo', transfer: 'transferencia', other: 'otro medio' };

export const MAX_RECIBIDO_POR = 80;

export interface RecibidoSinComprobante {
  metodo: MedioRecibido;
  /** YYYY-MM-DD tal cual lo eligió la escuela. */
  fecha: string;
  /** Persona del equipo que recibió la plata. */
  por: string;
}

const limpiar = (t: string) => t.replace(/[\r\n[\]·]+/g, ' ').replace(/\s+/g, ' ').trim();

/** null si la constancia está completa; si no, qué falta (español de Colombia, tuteando). */
export function errorDeRecibido(
  r: { metodo?: string | null; fecha?: string | null; por?: string | null },
  hoy: string,
): string | null {
  if (!r.metodo || !(r.metodo in ETIQUETA)) return 'Dinos cómo recibiste el pago: efectivo, transferencia u otro medio.';
  if (!r.fecha || !/^\d{4}-\d{2}-\d{2}$/.test(r.fecha)) return 'Elige la fecha en que recibiste el pago.';
  if (r.fecha > hoy) return 'La fecha en que recibiste el pago no puede ser futura.';
  if (limpiar(r.por ?? '').length < 2) return 'Escribe quién recibió el pago (alguien del equipo).';
  return null;
}

/** `[Recibido: efectivo · 2026-11-11 · por Alejandra L.]` */
export function lineaRecibido(r: RecibidoSinComprobante): string {
  const por = limpiar(r.por).slice(0, MAX_RECIBIDO_POR);
  return `${PREFIJO_RECIBIDO} ${ETIQUETA[r.metodo]} · ${r.fecha} · por ${por}]`;
}

/** Antepone la línea a las notas que ya tenga el cobro (sin duplicar una constancia previa). */
export function notasConRecibido(notasPrevias: string | null | undefined, r: RecibidoSinComprobante): string {
  const previas = (notasPrevias ?? '').trim();
  const linea = lineaRecibido(r);
  if (!previas) return linea;
  const sinPrevia = previas.split('\n').filter((l) => !l.trim().startsWith(PREFIJO_RECIBIDO)).join('\n').trim();
  return sinPrevia ? `${linea}\n${sinPrevia}` : linea;
}
