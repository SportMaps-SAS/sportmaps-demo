// requireIdempotencyKey — exige el header `Idempotency-Key` en endpoints que
// crean cosas (reservas, cobros). Valida UUID o string de 8-128 caracteres
// imprimibles y deja el valor en `req.idempotencyKey`.
//
// Todavía NO está enrutado masivamente: se engancha endpoint por endpoint.
import { Request, Response, NextFunction } from 'express';

declare global {
    namespace Express {
        interface Request {
            idempotencyKey?: string;
        }
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 8-128 caracteres ASCII imprimibles sin espacios (cubre UUID, ULID, nanoid, etc.).
const TOKEN_RE = /^[\x21-\x7E]{8,128}$/;

export function isValidIdempotencyKey(value: unknown): value is string {
    return typeof value === 'string' && (UUID_RE.test(value) || TOKEN_RE.test(value));
}

export function requireIdempotencyKey(req: Request, res: Response, next: NextFunction) {
    const raw = req.header('Idempotency-Key');
    if (raw === undefined || raw.trim() === '') {
        return res.status(400).json({
            error: 'Falta el encabezado Idempotency-Key.',
            reason: 'idempotency_key_required',
        });
    }
    const key = raw.trim();
    if (!isValidIdempotencyKey(key)) {
        return res.status(400).json({
            error: 'Idempotency-Key inválida: usa un UUID o un texto de 8 a 128 caracteres sin espacios.',
            reason: 'invalid_idempotency_key',
        });
    }
    req.idempotencyKey = key;
    next();
}
