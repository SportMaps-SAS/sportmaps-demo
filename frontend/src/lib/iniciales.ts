/**
 * Iniciales de una PERSONA: primer nombre + primer apellido. Una sola regla para
 * el avatar de la barra superior, el del menú lateral y cualquier otro lugar
 * donde se muestre al usuario (antes la barra decía «CA» y el menú «CR» para
 * Carlos Ramírez).
 *
 * Nombres colombianos: «Nombre Apellido» → N A · «Nombre Apellido Apellido» →
 * N A (se asume un solo nombre) · «Nombre Nombre Apellido Apellido» → N A (el
 * tercero). Partículas («de», «del», «la», «los», «y», «van», «da»…) no cuentan.
 */
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'da', 'do', 'dos', 'das', 'van', 'von', 'di']);

export function inicialesPersona(nombreCompleto: string | null | undefined, respaldo?: string | null): string {
  const palabras = (nombreCompleto ?? '')
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((p) => p && !PARTICULAS.has(p.toLowerCase()));
  if (!palabras.length) {
    const r = (respaldo ?? '').trim().split('@')[0].replace(/[^\p{L}\p{N}]/gu, '');
    return r ? r.slice(0, 2).toUpperCase() : 'U';
  }
  if (palabras.length === 1) return palabras[0].charAt(0).toUpperCase();
  const apellido = palabras.length >= 4 ? palabras[2] : palabras[1];
  return (palabras[0].charAt(0) + apellido.charAt(0)).toUpperCase();
}
