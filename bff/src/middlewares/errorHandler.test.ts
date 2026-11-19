import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import cors from 'cors';
import { CorsOriginError, globalErrorHandler } from './errorHandler';

let server: http.Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(cors({
        origin: (origin, cb) => (!origin || origin === 'https://ok.sportmaps.co' ? cb(null, true) : cb(new CorsOriginError())),
        credentials: true,
    }));
    app.use(express.json({ limit: '1kb' }));
    app.post('/x', (_req, res) => res.json({ ok: true }));
    app.get('/boom', () => { throw new Error('boom'); });
    app.use(globalErrorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
    fetch(`${base}/x`, { method: 'POST', headers, body });

describe('globalErrorHandler', () => {
    it('Origin no permitido → 403 limpio, sin cabeceras CORS', async () => {
        const r = await fetch(`${base}/x`, { method: 'POST', headers: { origin: 'https://evil.io', 'content-type': 'application/json' }, body: '{}' });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'Origen no permitido.' });
        expect(r.headers.get('access-control-allow-origin')).toBeNull();
    });
    it('preflight OPTIONS con Origin no permitido → 403', async () => {
        const r = await fetch(`${base}/x`, { method: 'OPTIONS', headers: { origin: 'https://evil.io', 'access-control-request-method': 'POST' } });
        expect(r.status).toBe(403);
        expect(await r.json()).toEqual({ error: 'Origen no permitido.' });
    });
    it('Origin permitido pasa', async () => {
        const r = await fetch(`${base}/x`, { method: 'POST', headers: { origin: 'https://ok.sportmaps.co', 'content-type': 'application/json' }, body: '{}' });
        expect(r.status).toBe(200);
    });
    it('JSON malformado → 400', async () => {
        const r = await post('{bad');
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'JSON invalido.' });
    });
    it('cuerpo demasiado grande → 413', async () => {
        const r = await post(JSON.stringify({ a: 'x'.repeat(5000) }));
        expect(r.status).toBe(413);
    });
    it('error inesperado sigue siendo 500', async () => {
        const r = await fetch(`${base}/boom`);
        expect(r.status).toBe(500);
    });
});
