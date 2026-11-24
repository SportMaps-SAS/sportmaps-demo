/**
 * generalRateLimit — por IP real del cliente (Cloudflare) y una sola cuenta por
 * request aunque el limitador esté montado varias veces sobre la misma URL.
 * Sin red externa: un express en un puerto efímero.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createGeneralRateLimit, generalRateLimitKey } from './generalRateLimit';

let server: http.Server | null = null;

async function app(max: number) {
    const a = express();
    a.set('trust proxy', 1);
    const limit = createGeneralRateLimit({ max });
    // Igual que index.ts: /api/v1/schools montado dos veces y dos comodines
    // /api/v1 con el mismo limitador antes de la ruta que responde.
    const pasa = express.Router();
    a.use('/api/v1/schools', limit, pasa);
    a.use('/api/v1/schools', limit, pasa);
    a.use('/api/v1', limit, pasa);
    a.use('/api/v1', limit, pasa);
    const ok = express.Router();
    ok.get('/', (_req, res) => { res.json({ ok: true }); });
    a.use('/api/v1/schools', limit, ok);
    server = await new Promise<http.Server>((resolve) => { const s = a.listen(0, () => resolve(s)); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = null;
});

// En Render, X-Forwarded-For trae la IP del borde de Cloudflare (eso ve req.ip)
// y CF-Connecting-IP la del cliente.
const BORDE = '172.70.80.1';
const H = (cliente: string) => ({ 'cf-connecting-ip': cliente, 'x-forwarded-for': BORDE });

describe('generalRateLimitKey', () => {
    it('usa CF-Connecting-IP (cliente) antes que req.ip (borde de Cloudflare)', () => {
        expect(generalRateLimitKey({ headers: { 'cf-connecting-ip': '181.63.24.103' }, ip: BORDE } as any)).toBe('general-181.63.24.103');
        expect(generalRateLimitKey({ headers: {}, ip: '10.0.0.5' } as any)).toBe('general-10.0.0.5');
    });
});

describe('generalRateLimit', () => {
    it('una petición gasta UNA unidad aunque cruce 5 montajes del limitador', async () => {
        const base = await app(3);
        for (let i = 0; i < 3; i++) {
            const r = await fetch(`${base}/api/v1/schools`, { headers: H('181.1.1.1') });
            expect(r.status).toBe(200);
            expect(r.headers.get('ratelimit-remaining')).toBe(String(2 - i));
        }
        expect((await fetch(`${base}/api/v1/schools`, { headers: H('181.1.1.1') })).status).toBe(429);
    });

    it('usuarios distintos detrás del mismo borde de Cloudflare no comparten cupo', async () => {
        const base = await app(2);
        for (let i = 0; i < 2; i++) {
            expect((await fetch(`${base}/api/v1/schools`, { headers: H('181.1.1.1') })).status).toBe(200);
        }
        expect((await fetch(`${base}/api/v1/schools`, { headers: H('181.1.1.1') })).status).toBe(429);
        // Otro cliente, mismo borde: tiene su propio cupo.
        expect((await fetch(`${base}/api/v1/schools`, { headers: H('190.2.2.2') })).status).toBe(200);
    });
});
