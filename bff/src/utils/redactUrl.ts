/**
 * Redacta secretos que viajan en la ruta antes de loguear una URL.
 * El token del enlace de estado de reservas de canchas (/public/reservations/r/:token[/cancel|/reschedule])
 * permite ver, cancelar, reprogramar y pagar: nunca debe quedar en los logs.
 *
 * Ojo: pino-http serializa `req.url` al terminar la respuesta, y dentro de un router montado Express la deja
 * relativa al montaje (`/r/<token>`), por eso también se cubre la forma corta (`/r/` + token largo).
 */
const RESERVATION_LINK_RE = /(\/public\/reservations\/r\/)[^/?#\s]+/gi;
const SHORT_LINK_RE = /(\/r\/)[A-Za-z0-9_\-.]{20,}/g;

export function redactSecretsInUrl(url: unknown): string {
    if (typeof url !== 'string') return '';
    return url.replace(RESERVATION_LINK_RE, '$1[REDACTED]').replace(SHORT_LINK_RE, '$1[REDACTED]');
}
