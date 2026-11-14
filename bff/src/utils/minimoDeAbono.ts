/**
 * Abono mínimo de un cobro: UNA sola regla para la app y el bot.
 *
 * - Si el cobro está ligado a un ítem de servicio con `abono_minimo_pct`
 *   (clínica, torneo, viaje…): ceil(precio × pct / 100). Ej. 50 % de 175.000 = 87.500.
 * - Si no (cobro de mensualidad, sin ítem, o ítem sin porcentaje): el mínimo de la
 *   escuela (`school_settings.min_installment_amount`), exactamente como antes.
 *
 * Antes la app aplicaba el mínimo de la escuela ($72.500 en Monster) y el bot el
 * 50 % del ítem: el mismo cobro aceptaba abonos distintos según el canal.
 *
 * Espejo en bff/src/utils/minimoDeAbono.ts (misma lógica, misma prueba).
 * 0 = sin mínimo.
 */
export interface MinimoDeAbonoArgs {
  /** `abono_minimo_pct` del ítem al que está ligado el cobro (null/undefined si no hay ítem). */
  pctItem?: number | null;
  /** `school_settings.min_installment_amount`. */
  minEscuela?: number | null;
  /** Precio contra el que se aplica el porcentaje (el del cobro/ítem). */
  precio?: number | null;
}

export function minimoDeAbono({ pctItem, minEscuela, precio }: MinimoDeAbonoArgs): number {
  const pct = Number(pctItem);
  const base = Number(precio);
  if (Number.isFinite(pct) && pct > 0 && pct <= 100 && Number.isFinite(base) && base > 0) {
    // - 1e-9: evita que el ruido de coma flotante suba un peso (p. ej. 33,3 %).
    return Math.ceil((base * pct) / 100 - 1e-9);
  }
  const min = Number(minEscuela);
  return Number.isFinite(min) && min > 0 ? min : 0;
}
