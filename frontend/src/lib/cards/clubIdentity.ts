/**
 * Identidad visual del club para el carnet 3D (spec docs/specs/carnet-3d-club.md §4, §6).
 * Sin React. CONTRATO COMPARTIDO entre fases: no cambiar firmas sin avisar.
 *
 * - Sin complemento de marca (D3): diseño base SportMaps (verde/naranja) y escudo
 *   por defecto con iniciales.
 * - Contraste: luminancia relativa WCAG; texto blanco o casi negro según el fondo.
 */

export const SPORTMAPS_BASE = {
  primario: '#248223',
  secundario: '#FB9F1E',
  acento: '#FB9F1E',
} as const;

export const TEXTO_CLARO = '#FFFFFF';
export const TEXTO_OSCURO = '#111827';

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export function esHex(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v);
}

export interface EscudoDerechos {
  confirmado_por: string;
  confirmado_en: string;
  logo_url: string | null;
}

/** Lo que guarda schools.branding_settings (lo que interesa al carnet). */
export interface BrandingSettingsCarnet {
  primary_color?: string | null;
  secondary_color?: string | null;
  accent_color?: string | null;
  escudo_derechos?: EscudoDerechos | null;
  show_sportmaps_watermark?: boolean | null;
}

export interface ClubIdentidad {
  nombre: string;
  primario: string;
  secundario: string;
  acento: string;
  /** URL del escudo subido; null → usar escudoPorDefecto(). */
  escudoUrl: string | null;
  /** true si se pintan los colores/escudo del club (tiene complemento). */
  conMarca: boolean;
}

/**
 * Resuelve la identidad que se pinta. Sin complemento → base SportMaps aunque
 * la escuela tenga colores guardados (D3). `forzarMarca` sirve para la vista
 * previa del admin sin complemento («así quedaría con tu identidad»).
 */
export function resolverIdentidad(
  school: { name: string; logo_url?: string | null; branding_settings?: BrandingSettingsCarnet | null },
  tieneComplemento: boolean,
  opciones?: { forzarMarca?: boolean },
): ClubIdentidad {
  const b = school.branding_settings ?? {};
  const conMarca = tieneComplemento || !!opciones?.forzarMarca;
  if (!conMarca) {
    return { nombre: school.name, ...SPORTMAPS_BASE, escudoUrl: null, conMarca: false };
  }
  const primario = esHex(b.primary_color) ? b.primary_color : SPORTMAPS_BASE.primario;
  const secundario = esHex(b.secondary_color) ? b.secondary_color : SPORTMAPS_BASE.secundario;
  const acento = esHex(b.accent_color) ? b.accent_color : secundario;
  return { nombre: school.name, primario, secundario, acento, escudoUrl: school.logo_url ?? null, conMarca: true };
}

function canal(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa WCAG 2.x (0 = negro, 1 = blanco). */
export function luminancia(hex: string): number {
  const h = esHex(hex) ? hex : '#000000';
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

/** Razón de contraste WCAG (1..21). Blanco/negro = 21. */
export function razonContraste(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Color de texto legible sobre un fondo. */
export function textoSobre(fondo: string): string {
  return razonContraste(fondo, TEXTO_CLARO) >= razonContraste(fondo, TEXTO_OSCURO) ? TEXTO_CLARO : TEXTO_OSCURO;
}

/** Aviso de contraste del acento contra el principal (< 3:1, texto grande WCAG). */
export function avisoContrasteAcento(primario: string, acento: string): string | null {
  const r = razonContraste(primario, acento);
  if (r >= 3) return null;
  return `El color de acento casi no se distingue del principal (contraste ${r.toFixed(1)}:1). Prueba uno más claro u oscuro.`;
}

/** «Club Deportivo Besser» → «CDB» (máx. 3 letras, ignora palabras de 1–2 letras). */
export function iniciales(nombre: string, max = 3): string {
  const limpio = String(nombre ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const todas = limpio.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  const largas = todas.filter((w) => w.length > 2 || /^[0-9]+$/.test(w));
  const base = largas.length ? largas : todas;
  return base.slice(0, max).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
}

/**
 * Escudo por defecto (determinista, sin Storage): data URI SVG con los colores
 * del club y sus iniciales.
 */
export function escudoPorDefecto(identidad: Pick<ClubIdentidad, 'nombre' | 'primario' | 'secundario'>): string {
  const ini = iniciales(identidad.nombre);
  const tx = textoSobre(identidad.primario);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120">` +
    `<path d="M50 4 L94 20 V58 C94 86 74 104 50 116 C26 104 6 86 6 58 V20 Z" fill="${identidad.primario}" stroke="${identidad.secundario}" stroke-width="6"/>` +
    `<text x="50" y="70" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="${ini.length > 2 ? 26 : 34}" fill="${tx}">${ini}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
