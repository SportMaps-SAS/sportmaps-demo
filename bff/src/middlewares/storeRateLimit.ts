/**
 * Límite de operaciones de la TIENDA (pedidos, checkout del carrito, /store).
 *
 * Antes estas rutas colgaban del `paymentLimiter` global (20/min) y pasaba esto:
 *  - LEER un pedido gastaba cupo de pago (y DOS veces: el GET de
 *    /api/v1/marketplace/orders/:id atraviesa también el montaje del checkout en
 *    /api/v1/marketplace). Con unas cuantas recargas de "Mis compras" el
 *    comprador recibía 429 y la pantalla decía "Pedido no encontrado".
 *  - La llave era `req.ip`, que detrás de Cloudflare + Render (`trust proxy` = 1)
 *    es la IP del BORDE de Cloudflare: todos los compradores compartían un
 *    puñado de cupos (ver access-adms.ts::clientIp e incidente 2026-09-22).
 *
 * Ahora:
 *  - Lecturas (GET/HEAD y la cotización POST /checkout/cart/quote): cupo propio,
 *    alto (120/min por cliente).
 *  - Escrituras (crear orden, comprobante, cancelar, código de retiro…):
 *    20/min por cliente, como antes.
 *  - Llave = IP real del cliente: `CF-Connecting-IP` (Cloudflare lo fija en su
 *    borde y lo sobreescribe siempre; Render pasa SIEMPRE por Cloudflare, hasta
 *    pegándole al *.onrender.com), con `req.ip` de respaldo en local.
 *  - Una sola cuenta por request aunque el middleware esté en varios montajes.
 *  - 429 con `error: 'RATE_LIMITED'` para que el frontend lo distinga de un 404.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from '../utils/clientIp';

export const STORE_READ_LIMIT_PER_MIN = 120;
export const STORE_WRITE_LIMIT_PER_MIN = 20;

/** IP del cliente detrás de Cloudflare → Render (mismo criterio que access-adms.ts). */
export function storeClientIp(req: Pick<Request, 'headers' | 'ip'> & { socket?: { remoteAddress?: string } }): string {
    return clientIp(req);
}

/** ¿La request solo lee? (GET/HEAD, o la cotización del carrito, que es POST pero no escribe). */
export function isStoreRead(req: Pick<Request, 'method' | 'originalUrl'>): boolean {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
    const path = (req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    return method === 'POST' && path.endsWith('/checkout/cart/quote');
}

function limiter(kind: 'read' | 'write', max: number) {
    return rateLimit({
        windowMs: 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => `store-${kind}-${ipKeyGenerator(storeClientIp(req))}`,
        handler: (_req, res) => {
            res.status(429).json({
                ok: false,
                error: 'RATE_LIMITED',
                message: 'Demasiadas solicitudes, intenta en un minuto.',
            });
        },
    });
}

const COUNTED = Symbol.for('sportmaps.storeRateLimitCounted');

/**
 * Fábrica (cada instancia tiene sus propios contadores). En index.ts se usa UNA
 * sola instancia para todos los montajes de la tienda.
 */
export function createStoreRateLimit(opts: { readMax?: number; writeMax?: number } = {}): RequestHandler {
    const read = limiter('read', opts.readMax ?? STORE_READ_LIMIT_PER_MIN);
    const write = limiter('write', opts.writeMax ?? STORE_WRITE_LIMIT_PER_MIN);
    return (req: Request, res: Response, next: NextFunction) => {
        const locals = res.locals as Record<symbol, unknown>;
        if (locals[COUNTED]) return next();
        locals[COUNTED] = true;
        return (isStoreRead(req) ? read : write)(req, res, next);
    };
}

export const storeRateLimit = createStoreRateLimit();
