import { describe, expect, it, vi } from 'vitest';
import { isValidIdempotencyKey, requireIdempotencyKey } from './requireIdempotencyKey';

function run(headers: Record<string, string>) {
    const req: any = { header: (n: string) => headers[n] };
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
    const next = vi.fn();
    requireIdempotencyKey(req, res, next);
    return { req, res, next };
}

describe('requireIdempotencyKey', () => {
    it('400 si falta el header', () => {
        const { res, next } = run({});
        expect(res.statusCode).toBe(400);
        expect(res.body.reason).toBe('idempotency_key_required');
        expect(next).not.toHaveBeenCalled();
    });
    it('400 si es muy corta, muy larga o con espacios', () => {
        expect(run({ 'Idempotency-Key': 'abc' }).res.statusCode).toBe(400);
        expect(run({ 'Idempotency-Key': 'a'.repeat(129) }).res.statusCode).toBe(400);
        expect(run({ 'Idempotency-Key': 'hola mundo largo' }).res.statusCode).toBe(400);
    });
    it('acepta UUID y strings 8-128 y deja req.idempotencyKey', () => {
        const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
        const a = run({ 'Idempotency-Key': uuid });
        expect(a.next).toHaveBeenCalled();
        expect(a.req.idempotencyKey).toBe(uuid);
        const b = run({ 'Idempotency-Key': '  reserva-123456  ' });
        expect(b.req.idempotencyKey).toBe('reserva-123456');
        expect(isValidIdempotencyKey('a'.repeat(128))).toBe(true);
    });
});
