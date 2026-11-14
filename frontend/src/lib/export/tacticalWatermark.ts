/**
 * Marca de agua de lo que se exporta de la pizarra (PNG, PDF y video/GIF):
 * «Hecho con SportMaps · sportmaps.co». Siempre, salvo marca blanca (la misma
 * regla que recibos, carnets y el video 3D: useSportmapsWatermark).
 *
 * Logo del club: solo si el TIER de la escuela incluye la marca propia
 * (`school_has_branding_feature()`, permiso por plan), que es una pregunta
 * distinta de si se le MUESTRA su marca (`school_shows_own_brand`, por addon).
 * El logo del club se suma a la marca de agua: no la reemplaza (logo y colores
 * propios no son marca blanca).
 */

export const WATERMARK_TEXT = 'Hecho con SportMaps · sportmaps.co';
export const WATERMARK_URL = 'https://sportmaps.co';

export interface ExportBranding {
  /** false solo con marca blanca. Sin dato = true. */
  watermark?: boolean;
  /** Logo del club (URL pública). Solo con el permiso del tier. */
  clubLogoUrl?: string | null;
}

/** Regla pura: qué marca lleva la exportación. */
export function resolveExportBranding(opts: {
  showsSportmapsWatermark: boolean;
  hasBrandingFeature: boolean;
  logoUrl: string | null | undefined;
}): Required<ExportBranding> {
  const logo = opts.hasBrandingFeature && typeof opts.logoUrl === 'string' && /^https?:\/\//i.test(opts.logoUrl.trim())
    ? opts.logoUrl.trim()
    : null;
  return { watermark: opts.showsSportmapsWatermark, clubLogoUrl: logo };
}

export const wantsWatermark = (b: ExportBranding | null | undefined) => b?.watermark !== false;

/**
 * Carga el logo para pintarlo en un canvas sin «ensuciarlo» (crossOrigin
 * anónimo: si el servidor no manda CORS, la imagen no carga y la exportación
 * sale sin logo en vez de fallar).
 */
export function loadLogo(url: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!url || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 6000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0 ? img : null); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

/** Logo → data URL PNG (para jsPDF). null si no carga. */
export async function logoDataUrl(url: string | null | undefined, maxPx = 256): Promise<{ dataUrl: string; aspect: number } | null> {
  const img = await loadLogo(url);
  if (!img || typeof document === 'undefined') return null;
  try {
    const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL('image/png'), aspect: c.width / c.height };
  } catch {
    return null;
  }
}

/**
 * Pinta la marca de agua (y el logo del club, si hay) sobre un canvas: una
 * pastilla semitransparente abajo a la derecha, legible sobre césped y sobre
 * la pizarra blanca. Se usa en cada cuadro del video/GIF.
 */
export function drawCanvasWatermark(
  ctx: CanvasRenderingContext2D, width: number, height: number,
  opts: { watermark: boolean; logo?: HTMLImageElement | null },
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  const pad = Math.max(6, Math.round(width * 0.018));
  if (opts.watermark) {
    const font = Math.max(10, Math.round(width * 0.026));
    ctx.font = `700 ${font}px Helvetica, Arial, sans-serif`;
    const tw = ctx.measureText(WATERMARK_TEXT)?.width ?? WATERMARK_TEXT.length * font * 0.55;
    const bw = tw + font * 1.2;
    const bh = font * 1.8;
    const x = width - pad - bw;
    const y = height - pad - bh;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.62)';
    roundRect(ctx, x, y, bw, bh, bh / 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(WATERMARK_TEXT, x + bw / 2, y + bh / 2);
  }
  if (opts.logo) {
    const h = Math.max(24, Math.round(width * 0.09));
    const w = Math.min(h * 3, h * (opts.logo.naturalWidth / Math.max(1, opts.logo.naturalHeight)));
    ctx.globalAlpha = 0.92;
    ctx.drawImage(opts.logo, pad, height - pad - h, w, h);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
