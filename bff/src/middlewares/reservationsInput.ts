// Guarda de entrada para los routers de reservas de canchas.
//
//  · Cuerpo JSON acotado (20 KB por defecto; 200 KB para el lote): 413 claro, no el 5 MB global.
//  · Content-Type JSON obligatorio cuando hay cuerpo: 415 claro.
//  · JSON mal formado -> 400 `invalid_json` (antes caía al handler global y salía 500).
//  · Cuerpo no objeto (array, número, null) -> lo valida el schema zod; aquí solo se asegura que
//    el parser no lo tumbe.
//
// Se monta en index.ts ANTES del express.json() global (body-parser salta si ya se parseó).
import express, { Request, Response, NextFunction, RequestHandler } from 'express';

export const RESERVATIONS_BODY_LIMIT_BYTES = 20 * 1024;
export const RESERVATIONS_BATCH_BODY_LIMIT_BYTES = 200 * 1024;

const isJsonType = (ct: string | undefined) => !!ct && /^application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/i.test(ct.trim());

export function reservationsJsonBody(limitBytes = RESERVATIONS_BODY_LIMIT_BYTES): RequestHandler {
    const parser = express.json({
        limit: limitBytes,
        strict: true, // solo objetos y arreglos en la raíz
        verify: (req, _res, buf) => { (req as any).rawBody = buf; },
    });
    return (req: Request, res: Response, next: NextFunction) => {
        // Ya parseado por un guarda anterior (p. ej. el del lote, más amplio): no se vuelve a limitar.
        if ((req as any)._rsvBodyParsed === true) return next();
        const len = Number(req.headers['content-length'] ?? 0);
        const hasBody = len > 0 || req.headers['transfer-encoding'] !== undefined;
        if (len > limitBytes) {
            return res.status(413).json({ error: 'El cuerpo de la petición es demasiado grande.', code: 'PAYLOAD_TOO_LARGE', max_bytes: limitBytes });
        }
        if (hasBody && !isJsonType(req.headers['content-type'] as string | undefined)) {
            return res.status(415).json({ error: 'Content-Type debe ser application/json.', code: 'UNSUPPORTED_MEDIA_TYPE' });
        }
        parser(req, res, (err?: any) => {
            if (!err) { (req as any)._rsvBodyParsed = true; return next(); }
            const type = String(err?.type ?? '');
            if (type === 'entity.too.large') {
                return res.status(413).json({ error: 'El cuerpo de la petición es demasiado grande.', code: 'PAYLOAD_TOO_LARGE', max_bytes: limitBytes });
            }
            if (type === 'entity.parse.failed' || err instanceof SyntaxError) {
                return res.status(400).json({ error: 'JSON mal formado.', code: 'INVALID_JSON' });
            }
            if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
                return res.status(415).json({ error: 'Codificación no soportada.', code: 'UNSUPPORTED_MEDIA_TYPE' });
            }
            const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 400;
            return res.status(status).json({ error: 'Petición inválida.', code: 'BAD_REQUEST' });
        });
    };
}

/** Respuesta uniforme de validación zod: 400 con code y detalle acotado (sin eco del valor enviado). */
export function zodBadRequest(res: Response, issues: ReadonlyArray<{ path: PropertyKey[]; message: string; code?: string }>) {
    return res.status(400).json({
        error: 'Datos inválidos',
        code: 'VALIDATION_ERROR',
        details: issues.slice(0, 10).map((i) => ({ path: i.path.map(String).join('.'), message: String(i.message).slice(0, 200), code: i.code })),
    });
}
