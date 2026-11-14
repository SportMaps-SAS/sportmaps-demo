/**
 * recurring.routes — motor viejo de cobros recurrentes, retirado.
 *
 * POST /subscriptions llamaba la RPC `create_recurring_subscription`, que no
 * existe en la base viva (500 seguro) y confiaba schoolId/childId del body.
 * Se fija:
 *   · responde 410 con el reemplazo, sin llamar ninguna RPC ni tocar tablas;
 *   · sigue exigiendo sesión (401 sin usuario);
 *   · index.ts no monta este router y /api/v1/recurring sigue en 410.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import fs from 'fs';
import path from 'path';

const st = vi.hoisted(() => ({
    rpcCalls: [] as string[],
    fromCalls: [] as string[],
}));

vi.mock('../config/supabase', () => ({
    supabase: {
        rpc: async (fn: string) => { st.rpcCalls.push(fn); return { data: { ok: true }, error: null }; },
        from: (t: string) => { st.fromCalls.push(t); throw new Error('no debe tocar tablas'); },
    },
}));

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, res: any, next: any) => {
        const id = req.header('x-test-user');
        if (!id) return res.status(401).json({ error: 'no' });
        req.user = { id, email: `${id}@qa.co` };
        next();
    },
}));

vi.mock('../services/recurring-charges.service', () => ({
    runDueRecurringCharges: async () => ({ processed: 0 }),
}));

let server: http.Server;
let base = '';

beforeAll(async () => {
    const { default: router } = await import('./recurring.routes');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/recurring', router);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
});

beforeEach(() => {
    st.rpcCalls.length = 0;
    st.fromCalls.length = 0;
});

const UUID = '11111111-1111-4111-8111-111111111111';
const body = { schoolId: UUID, childId: UUID, paymentTokenId: UUID, amount: 150000 };

async function post(headers: Record<string, string>) {
    const r = await fetch(`${base}/api/v1/recurring/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as any };
}

describe('POST /recurring/subscriptions (retirado)', () => {
    it('sin sesión → 401', async () => {
        const r = await post({});
        expect(r.status).toBe(401);
        expect(st.rpcCalls).toEqual([]);
    });

    it('con sesión → 410 con el reemplazo, sin RPC ni tablas', async () => {
        const r = await post({ 'x-test-user': 'padre-1' });
        expect(r.status).toBe(410);
        expect(r.json.code).toBe('recurring_v1_retired');
        expect(r.json.replacement).toBe('/api/v1/autopay/subscriptions');
        expect(st.rpcCalls).toEqual([]);
        expect(st.fromCalls).toEqual([]);
    });

    it('ya no referencia la RPC inexistente create_recurring_subscription', () => {
        const src = fs.readFileSync(path.join(__dirname, 'recurring.routes.ts'), 'utf8');
        expect(src).not.toMatch(/rpc\(\s*['"]create_recurring_subscription['"]/);
    });
});

describe('montaje en index.ts', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

    it('no importa recurring.routes', () => {
        expect(idx).not.toMatch(/from\s+['"]\.\/routes\/recurring\.routes['"]/);
    });

    it('/api/v1/recurring responde 410 recurring_v1_retired', () => {
        expect(idx).toMatch(/app\.use\('\/api\/v1\/recurring'[\s\S]{0,200}status\(410\)[\s\S]{0,200}recurring_v1_retired/);
    });
});
