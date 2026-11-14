/**
 * Negro o blanco: el que más contraste dé sobre un color de marca (hex de 6
 * dígitos). Si el valor no es un hex válido devuelve blanco. Se usa para el texto
 * del encabezado con el color de la escuela en páginas públicas.
 */
export function textoSobre(hex: string): '#111111' | '#ffffff' {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const canal = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luz = 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
  return luz > 0.4 ? '#111111' : '#ffffff';
}
