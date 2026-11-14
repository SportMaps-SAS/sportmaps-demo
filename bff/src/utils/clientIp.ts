/**
 * IP real del cliente detrás de Cloudflare -> Render (`trust proxy` = 1).
 * `req.ip` ahí es la IP del BORDE de Cloudflare, compartida por muchos
 * usuarios; por eso se prefieren las cabeceras que Cloudflare fija
 * (ver storeRateLimit.ts y ROADMAP SEG-28).
 *
 * OJO: `cf-connecting-ip` / `true-client-ip` solo son confiables porque Render
 * se alcanza únicamente vía Cloudflare (ROADMAP SEG-28), que las sobreescribe
 * siempre. Si el servicio pasara a ser alcanzable directo, cualquiera podría
 * falsificarlas y esquivar los limitadores.
 */
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

type ClientIpRequest = Pick<Request, 'headers' | 'ip'> & { socket?: { remoteAddress?: string } };

function firstHeader(value: string | string[] | undefined): string {
    const raw = Array.isArray(value) ? value[0] : value;
    return (raw ?? '').trim();
}

export function clientIp(req: ClientIpRequest): string {
    const fromEdge = firstHeader(req.headers['cf-connecting-ip']) || firstHeader(req.headers['true-client-ip']);
    if (fromEdge) return fromEdge;
    return (req.ip || req.socket?.remoteAddress || '').trim();
}

/** Llave del limitador global del link público de agendamiento. */
export function publicBookingRateKey(req: ClientIpRequest): string {
    return `public-booking-${ipKeyGenerator(clientIp(req))}`;
}
