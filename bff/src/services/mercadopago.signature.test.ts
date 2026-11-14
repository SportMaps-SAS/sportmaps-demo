/**
 * validateMpWebhookSignature: formato estricto (sin lanzar con v1 no hexadecimal), timingSafeEqual con buffers del
 * mismo largo y frescura del `ts` (±5 min).
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { validateMpWebhookSignature } from './mercadopago.service';

const SECRET = 'whsec_test';
const firmar = (dataId: string, reqId: string, ts: string, secret = SECRET) =>
    crypto.createHmac('sha256', secret).update(`id:${dataId};request-id:${reqId};ts:${ts};`).digest('hex');

const llamar = (xSignature: string | undefined, over: Record<string, unknown> = {}) =>
    validateMpWebhookSignature({ xSignature, xRequestId: 'req-1', dataId: '123', secret: SECRET, isSandbox: false, ...over } as any);

describe('validateMpWebhookSignature', () => {
    it('firma válida y fresca -> true (ts en ms y en segundos)', () => {
        const ms = String(Date.now());
        expect(llamar(`ts=${ms},v1=${firmar('123', 'req-1', ms)}`)).toBe(true);
        const seg = String(Math.floor(Date.now() / 1000));
        expect(llamar(`ts=${seg},v1=${firmar('123', 'req-1', seg)}`)).toBe(true);
    });

    it('v1 no hexadecimal / de largo raro / vacío -> false SIN lanzar (antes: 500)', () => {
        const ms = String(Date.now());
        for (const v1 of ['zzzz', 'g'.repeat(64), 'ab', '', firmar('123', 'req-1', ms) + 'ff', '%%%', 'é'.repeat(64)]) {
            expect(() => llamar(`ts=${ms},v1=${v1}`)).not.toThrow();
            expect(llamar(`ts=${ms},v1=${v1}`)).toBe(false);
        }
    });

    it('ts no numérico -> false', () => {
        expect(llamar(`ts=abc,v1=${firmar('123', 'req-1', 'abc')}`)).toBe(false);
    });

    it('ts fuera de ±5 min (replay) -> false aunque la firma sea correcta', () => {
        const viejo = String(Date.now() - 6 * 60_000);
        expect(llamar(`ts=${viejo},v1=${firmar('123', 'req-1', viejo)}`)).toBe(false);
        const futuro = String(Date.now() + 6 * 60_000);
        expect(llamar(`ts=${futuro},v1=${firmar('123', 'req-1', futuro)}`)).toBe(false);
        const casi = String(Date.now() - 4 * 60_000);
        expect(llamar(`ts=${casi},v1=${firmar('123', 'req-1', casi)}`)).toBe(true);
    });

    it('secreto o datos distintos -> false', () => {
        const ms = String(Date.now());
        expect(llamar(`ts=${ms},v1=${firmar('123', 'req-1', ms, 'otro')}`)).toBe(false);
        expect(llamar(`ts=${ms},v1=${firmar('999', 'req-1', ms)}`)).toBe(false);
    });

    it('sin cabecera / sin secreto en producción -> false', () => {
        expect(llamar(undefined)).toBe(false);
        expect(llamar('ts=1', { secret: null })).toBe(false);
    });
});
