import type { CSSProperties } from 'react';
import { brandTextColor, safeBrandColor } from './publicModel';

/**
 * Variables CSS de la marca del torneo:
 *  --brand     fondo del encabezado y pastillas activas
 *  --brand-fg  texto sobre --brand
 *  --brand-ink títulos sobre fondo claro (el color de marca; si es muy claro, el texto normal)
 * Sin color propio se usa el primario de SportMaps.
 */
export function brandStyle(raw: string | null | undefined): { brand: string | null; style: CSSProperties } {
  const brand = safeBrandColor(raw);
  if (!brand) {
    return {
      brand: null,
      style: { '--brand': 'hsl(var(--primary))', '--brand-fg': 'hsl(var(--primary-foreground))', '--brand-ink': 'hsl(var(--primary))' } as CSSProperties,
    };
  }
  const fg = brandTextColor(brand);
  return {
    brand,
    style: { '--brand': brand, '--brand-fg': fg, '--brand-ink': fg === '#ffffff' ? brand : 'hsl(var(--foreground))' } as CSSProperties,
  };
}
