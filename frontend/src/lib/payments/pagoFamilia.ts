/**
 * Pago de hermanas con un solo comprobante + «monto recibido» (spec
 * docs/specs/pago-hermanas-un-comprobante.md, rev. 2).
 *
 * Espeja en el cliente lo que hace la RPC `register_manual_payments_familia`
 * para mostrar el reparto ANTES de guardar. La verdad la calcula la base; esto
 * es solo el aviso.
 */

export interface ParteSaldo {
  childId: string;
  monto: number;
}

/**
 * Reparte el excedente en partes iguales POR DEPORTISTA (no por cobro), en pesos
 * enteros. El residuo del redondeo va a la ancla (la deportista con la que se
 * abrió el registro).
 */
export function repartirExcedente(excedente: number, childIds: string[], anclaId: string): ParteSaldo[] {
  const ids = Array.from(new Set(childIds));
  const total = Math.round(Number(excedente) || 0);
  if (total <= 0 || ids.length === 0) return [];
  const ancla = ids.includes(anclaId) ? anclaId : ids[0];
  const base = Math.floor(total / ids.length);
  const resto = total - base * ids.length;
  return ids
    .map((childId) => ({ childId, monto: base + (childId === ancla ? resto : 0) }))
    .filter((p) => p.monto > 0);
}

/** recibido − suma de los cobros; nunca negativo. */
export function excedenteDeGrupo(recibido: number, sumaCobros: number): number {
  const r = Math.round(Number(recibido) || 0);
  const s = Math.round(Number(sumaCobros) || 0);
  return Math.max(r - s, 0);
}

/** Con menos de lo que cubren los cobros no se guarda en este modal. */
export function recibidoMenorQueSuma(recibido: number, sumaCobros: number): boolean {
  return Math.round(Number(recibido) || 0) < Math.round(Number(sumaCobros) || 0);
}

/**
 * Monto recibido que se precarga: con comprobante, el que leyó el OCR; sin él (o
 * si el OCR no leyó nada), la suma de los cobros.
 */
export function recibidoPorDefecto(sumaCobros: number, ocrAmount: number | null | undefined): number {
  const ocr = Number(ocrAmount);
  return Number.isFinite(ocr) && ocr > 0 ? Math.round(ocr) : Math.round(Number(sumaCobros) || 0);
}

const fmt = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

/**
 * Aviso previo: «Sobran $5.500: quedan $2.750 a favor de cada una». Con partes
 * distintas (residuo) lo dice por nombre.
 */
export function avisoReparto(partes: ParteSaldo[], nombres: Record<string, string>, excedente: number): string | null {
  if (partes.length === 0 || excedente <= 0) return null;
  if (partes.length === 1) {
    return `Sobran ${fmt(excedente)}: quedan a favor de ${nombres[partes[0].childId] ?? 'la deportista'}.`;
  }
  const distintos = new Set(partes.map((p) => p.monto));
  if (distintos.size === 1) {
    return `Sobran ${fmt(excedente)}: quedan ${fmt(partes[0].monto)} a favor de cada una.`;
  }
  const detalle = partes.map((p) => `${fmt(p.monto)} a ${nombres[p.childId] ?? 'una deportista'}`).join(' y ');
  return `Sobran ${fmt(excedente)}: quedan ${detalle}.`;
}

export const MENSAJE_RECIBIDO_MENOR =
  'Lo recibido es menor que lo que cubren estos cobros. Registra cada cobro con su abono.';
