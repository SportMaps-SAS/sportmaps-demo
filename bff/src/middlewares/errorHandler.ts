import type { NextFunction, Request, Response } from 'express';

/** Error que lanza el callback `origin` de CORS cuando el Origin no está en la allowlist. */
export class CorsOriginError extends Error {
    // Con status 4xx el handler de Sentry no lo reporta como excepción de servidor.
    status = 403;
    constructor() {
        super('Origen no permitido.');
        this.name = 'CorsOriginError';
    }
}

/**
 * Handler global de errores. Debe tener 4 parámetros para que Express lo reconozca.
 * - Origin bloqueado por CORS (incluye preflight) → 403, sin loguear como error de servidor.
 * - Errores de body-parser (JSON malformado 400, 413, 415…) conservan su status 4xx.
 * - Todo lo demás → 500.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function globalErrorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
    if (err instanceof CorsOriginError) {
        return res.status(403).json({ error: 'Origen no permitido.' });
    }

    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'JSON invalido.' });
    }
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Cuerpo demasiado grande.' });
    }
    if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
        return res.status(415).json({ error: 'Codificacion no soportada.' });
    }

    // pino-http adjunta req.log en cada request
    (req as any).log?.error({ err }, 'Unhandled error');

    const message = process.env.NODE_ENV === 'production'
        ? 'Error interno del servidor.'
        : err?.message;

    res.status(500).json({ error: message });
}
