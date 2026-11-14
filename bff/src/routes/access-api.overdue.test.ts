/**
 * GET /api/v1/access/overdue — F0 cobros únicos (migración 20261010143132):
 * la lista para bloquear/restaurar a mano solo trae MENSUALIDADES vencidas
 * (categoría NULL o 'mensualidad'). Un torneo/artículo/inscripción 'overdue'
 * de antes de F0 no aparece.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

type Fila = Record<string, any>;
const st = vi.hoisted(() => ({ tablas: {} as Record<string, Fila[]> }));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(st.tablas[tabla] ?? [])];
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[c])); return api; },
            or: (expr: string) => {
                const conds = expr.split(',').map((s) => {
                    const [c, op, ...r] = s.split('.');
                    const v = r.join('.');
                    return (f: any) => (op === 'is' && v === 'null' ? (f[c] ?? null) === null : op === 'eq' ? f[c] === v : false);
                });
                filas = filas.filter((f) => conds.some((k) => k(f)));
                return api;
            },
            order: () => api,
            limit: () => api,
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.schoolId = 'esc-1'; req.user = { id: 'owner-1' }; next(); },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    auditLog: async () => undefined,
}));
vi.mock('./access-adms', () => ({
    invalidateDeviceCache: vi.fn(), invalidateMappingCache: vi.fn(), reprocessPinEventsForHourBank: vi.fn(async () => ({ reprocessed: 0 })),
    getHourBankSettings: vi.fn(), computeHourBankBilledMinutes: vi.fn(), formatHourBankMinutes: vi.fn(),
}));
vi.mock('../services/bridgeWsHub', () => ({ wakeSchool: vi.fn() }));

const { default: router } = await import('./access-api');

let base = '';
let server: http.Server;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/', router);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

beforeEach(() => {
    st.tablas = {
        payments: [
            { id: 'p-mens', school_id: 'esc-1', user_id: 'u-1', child_id: null, unregistered_athlete_id: null, status: 'overdue', payment_category: 'mensualidad', due_date: '2026-09-05', amount: 100 },
            { id: 'p-null', school_id: 'esc-1', user_id: 'u-2', child_id: null, unregistered_athlete_id: null, status: 'overdue', payment_category: null, due_date: '2026-09-05', amount: 100 },
            { id: 'p-torneo', school_id: 'esc-1', user_id: 'u-3', child_id: null, unregistered_athlete_id: null, status: 'overdue', payment_category: 'torneo', due_date: '2026-09-05', amount: 100 },
            { id: 'p-insc', school_id: 'esc-1', user_id: 'u-1', child_id: null, unregistered_athlete_id: null, status: 'overdue', payment_category: 'inscripcion', due_date: '2026-09-05', amount: 100 },
        ],
        zk_user_mappings: [
            { school_id: 'esc-1', zk_pin: 1, user_id: 'u-1', unregistered_athlete_id: null, child_id: null },
            { school_id: 'esc-1', zk_pin: 2, user_id: 'u-2', unregistered_athlete_id: null, child_id: null },
            { school_id: 'esc-1', zk_pin: 3, user_id: 'u-3', unregistered_athlete_id: null, child_id: null },
        ],
        profiles: [{ id: 'u-1', full_name: 'Uno' }, { id: 'u-2', full_name: 'Dos' }, { id: 'u-3', full_name: 'Tres' }],
        school_settings: [{ school_id: 'esc-1', access_block_mechanism: 'group' }],
        turnstile_devices: [],
        device_commands: [],
    };
});

describe('GET /overdue — solo mensualidades', () => {
    it('lista la mensualidad explícita y la de categoría NULL; no los cobros únicos', async () => {
        const r = await fetch(`${base}/overdue`);
        expect(r.status).toBe(200);
        const { overdue } = await r.json();
        expect(overdue.map((o: any) => o.payment_id).sort()).toEqual(['p-mens', 'p-null']);
    });

    it('solo cobros únicos vencidos → lista vacía', async () => {
        st.tablas.payments = st.tablas.payments.filter((p) => p.payment_category && p.payment_category !== 'mensualidad');
        const { overdue } = await (await fetch(`${base}/overdue`)).json();
        expect(overdue).toEqual([]);
    });
});
