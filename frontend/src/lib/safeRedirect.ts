/**
 * safeRedirectUrl — única puerta para navegar a una URL que viene del servidor
 * (checkout_url, return_path, status_path…). Solo deja pasar:
 *   - https://host/...           (sin usuario:clave@; nunca http, javascript:, data:, blob:…)
 *   - rutas internas '/algo'     (nunca '//host' ni '/\host', que el navegador lee como otro origen)
 * Devuelve la URL lista para usar o null si no es segura.
 */
export function safeRedirectUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.trim();
  if (!u || u.length > 2048) return null;
  // Caracteres de control (incluye tab/CR/LF, que el navegador ignora dentro de la URL) y barra invertida.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(u)) return null;

  if (u.startsWith('/')) {
    return u.startsWith('//') ? null : u;
  }

  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}
