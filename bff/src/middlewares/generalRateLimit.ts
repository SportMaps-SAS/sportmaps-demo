/**
 * Límite general de la API (`generalLimiter` de index.ts): 200 peticiones cada
 * 15 min por cliente en producción.
 *
 * Antes tenía dos fallas que la prueba de carga del 2026-11-24 dejó a la vista
 * (scripts/carga/escalera.mjs, informe en docs/qa/pruebas-de-carga-2026-11-24.md):
 *
 *  1. La llave era `req.ip`. Detrás de Cloudflare → Render (`trust proxy` = 1)
 *     esa es la IP del BORDE de Cloudflare, compartida por muchos usuarios (el
 *     mismo bug que tumbó la tienda el 2026-09-22, ver storeRateLimit.ts).
 *     Con 300 usuarios simulados entrando por el mismo borde, el 99 % recibió
 *     429 desde el primer escalón.
 *  2. El mismo limitador está montado en varios `app.use` que matchean la misma
 *     URL (`/api/v1/schools` dos veces y dos comodines `app.use('/api/v1', …)`),
 *     y express-rate-limit cuenta una vez por montaje: según la ruta, una sola
 *     petición gastaba entre 1 y 4 unidades del cupo.
 *
 * Ahora: llave = IP real (`clientIp`: CF-Connecting-IP, con `req.ip` de
 * respaldo en local) y una sola cuenta por request, como la tienda.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from '../utils/clientIp';

export const GENERAL_WINDOW_MS = 15 * 60 * 1000;
export const GENERAL_MAX_PRODUCTION = 200;
export const GENERAL_MAX_DEFAULT = 2000;

const COUNTED = Symbol.for('sportmaps.generalRateLimitCounted');

export function generalRateLimitKey(req: Pick<Request, 'headers' | 'ip'> & { socket?: { remoteAddress?: string } }): string {
    return `general-${ipKeyGenerator(clientIp(req))}`;
}

/** Fábrica (cada instancia tiene sus propios contadores). index.ts usa UNA sola. */
export function createGeneralRateLimit(
    opts: { max?: number; windowMs?: number } = {},
): RequestHandler {
    const limiter = rateLimit({
        windowMs: opts.windowMs ?? GENERAL_WINDOW_MS,
        max: opts.max ?? (process.env.NODE_ENV === 'production' ? GENERAL_MAX_PRODUCTION : GENERAL_MAX_DEFAULT),
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => generalRateLimitKey(req),
        message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' },
    });
    return (req: Request, res: Response, next: NextFunction) => {
        const locals = res.locals as Record<symbol, unknown>;
        if (locals[COUNTED]) return next();
        locals[COUNTED] = true;
        return limiter(req, res, next);
    };
}
