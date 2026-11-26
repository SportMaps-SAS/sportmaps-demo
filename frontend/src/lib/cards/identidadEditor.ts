/**
 * Ayudas sin React del editor «Identidad del club» (carnet 3D, F2).
 * Spec docs/specs/carnet-3d-club.md §6. La validación de verdad la hace el BFF
 * (firma de bytes, 512 px, SVG → PNG → WebP); esto solo evita un viaje inútil.
 */

export const ESCUDO_MAX_BYTES = 2 * 1024 * 1024;
export const ESCUDO_MIN_LADO_PX = 512;
export const ESCUDO_TIPOS = ['image/png', 'image/webp', 'image/svg+xml'] as const;
export const ESCUDO_ACCEPT = ESCUDO_TIPOS.join(',');

/** Primer filtro del archivo elegido (tipo declarado y peso). null = sigue. */
export function revisarArchivoEscudo(archivo: { type: string; size: number }): string | null {
  if (!(ESCUDO_TIPOS as readonly string[]).includes(archivo.type)) {
    return 'Sube el escudo en PNG, WebP o SVG.';
  }
  if (archivo.size > ESCUDO_MAX_BYTES) return 'El escudo pesa más de 2 MB. Usa uno más liviano.';
  if (archivo.size === 0) return 'El archivo está vacío.';
  return null;
}

/** Medidas en px (SVG no aplica: es vectorial y el servidor lo rasteriza). */
export function revisarMedidasEscudo(ancho: number, alto: number): string | null {
  if (Math.min(ancho, alto) < ESCUDO_MIN_LADO_PX) {
    return `El escudo es muy pequeño (${ancho} × ${alto} px). Necesita al menos 512 px por lado.`;
  }
  return null;
}

/** Errores del BFF / de update_school_branding → frase para la pantalla. */
const MENSAJES: Record<string, string> = {
  feature_not_available: 'Tu plan no incluye los colores y el escudo del club.',
  rate_limited: 'Hiciste muchos cambios seguidos. Intenta en una hora.',
  forbidden: 'Solo la administración del club puede cambiar su identidad.',
  auth_required: 'Tu sesión venció. Vuelve a entrar.',
  invalid_primary_color: 'El color principal no es válido.',
  invalid_secondary_color: 'El color secundario no es válido.',
  invalid_accent_color: 'El color de acento no es válido.',
  invalid_logo_url: 'No pudimos guardar el escudo. Vuelve a subirlo.',
  derechos_sin_confirmar: 'Confirma que el club tiene derecho a usar este escudo.',
  archivo_muy_grande: 'El escudo pesa más de 2 MB. Usa uno más liviano.',
  formato_no_permitido: 'Sube el escudo en PNG, WebP o SVG.',
  svg_inseguro: 'Ese SVG trae contenido que no podemos usar. Expórtalo de nuevo o súbelo en PNG.',
  imagen_muy_pequena: 'El escudo es muy pequeño: necesita al menos 512 px por lado.',
  imagen_ilegible: 'No pudimos abrir la imagen. Prueba con otro archivo.',
};

export const MENSAJE_GENERICO = 'No se pudo guardar. Intenta de nuevo.';

/** Saca la frase a mostrar de un error del bffClient (BFFError) o cualquiera. */
export function mensajeDeErrorIdentidad(err: unknown): string {
  const e = err as { message?: string; body?: { error?: string; message?: string } } | null;
  const codigo = e?.body?.error ?? e?.message ?? '';
  if (codigo && MENSAJES[codigo]) return MENSAJES[codigo];
  // El BFF ya manda frases cortas en `message` para los errores del escudo.
  if (e?.body?.message && !/[_]/.test(e.body.message)) return e.body.message;
  return MENSAJE_GENERICO;
}

/** Archivo → base64 (data URL); el BFF quita el prefijo. */
export function archivoABase64(archivo: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => resolve(String(lector.result ?? ''));
    lector.onerror = () => reject(lector.error ?? new Error('lectura_fallida'));
    lector.readAsDataURL(archivo);
  });
}

/** Medidas naturales de una imagen (object URL). */
export function medirImagen(url: string): Promise<{ ancho: number; alto: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ ancho: img.naturalWidth, alto: img.naturalHeight });
    img.onerror = () => reject(new Error('imagen_ilegible'));
    img.src = url;
  });
}
