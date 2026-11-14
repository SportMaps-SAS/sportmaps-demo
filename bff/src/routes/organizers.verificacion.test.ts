/**
 * Verificación de organizadores (cierre 2026-10-27).
 *
 *  1. POST /api/v1/organizer/profile hacía upsert con `is_verified: false` fijo
 *     (onConflict profile_id): un organizador YA verificado que re-enviaba el
 *     onboarding perdía la verificación. El upsert ya no lleva is_verified.
 *  2. Tampoco lo puede colar el cliente en el body (zod lo descarta).
 *  3. trainer/training-plans (columnas inexistentes, PUT con update(req.body))
 *     queda desmontada del index hasta que se reescriba.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

const estado = vi.hoisted(() => ({ upserts: [] as any[] }));

vi.mock('../config/supabase', () => ({
    supabase: {
        from: () => {
            const api: any = {
                upsert: (fila: any) => { estado.upserts.push(fila); return api; },
                select: () => api,
                single: async () => ({ data: estado.upserts.at(-1) ?? null, error: null }),
            };
            return api;
        },
    },
}));

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'org-1' }; next(); },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import organizersRouter from './organizers.route';

let server: http.Server;
let url: string;

beforeEach(async () => {
    estado.upserts = [];
    const app = express();
    app.use(express.json());
    app.use('/api/v1/organizer', organizersRouter);
    server = app.listen(0);
    await new Promise<void>(r => server.once('listening', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>(r => server.close(() => r())));

const cuerpo = { organization_name: 'Org', nit: '900', city: 'Bogotá', sports: ['futbol'] };

describe('POST /api/v1/organizer/profile', () => {
    it('no toca is_verified en el upsert (no des-verifica al re-enviar)', async () => {
        const r = await fetch(`${url}/api/v1/organizer/profile`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
        });
        expect(r.status).toBe(201);
        expect(estado.upserts).toHaveLength(1);
        expect(estado.upserts[0]).not.toHaveProperty('is_verified');
        expect(estado.upserts[0].profile_id).toBe('org-1');
    });

    it('descarta is_verified si el cliente lo manda en el body', async () => {
        const r = await fetch(`${url}/api/v1/organizer/profile`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...cuerpo, is_verified: true }),
        });
        expect(r.status).toBe(201);
        expect(estado.upserts[0]).not.toHaveProperty('is_verified');
    });
});

describe('index.ts', () => {
    it('no monta trainer/training-plans', () => {
        const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
        expect(index).not.toMatch(/from '\.\/routes\/trainer\/training-plans'/);
        expect(index).not.toMatch(/trainerTrainingPlansRouter\)/);
    });
});
