import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ── Mock de supabase: rpc + builder encadenable por tabla ───────────────────
const rpc = vi.fn();
const tableResult: Record<string, { data: any; error: any }> = {};

function builder(table: string) {
    const res = () => Promise.resolve(tableResult[table] ?? { data: null, error: null });
    const b: any = {};
    for (const op of ['select', 'eq', 'in', 'insert', 'update', 'neq', 'gte']) b[op] = () => b;
    b.maybeSingle = res;
    b.single = res;
    b.then = (ok: any, ko: any) => res().then(ok, ko);
    return b;
}

vi.mock('../config/supabase', () => ({
    supabase: { rpc: (...a: any[]) => rpc(...a), from: (t: string) => builder(t) },
}));
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: USER }; req.schoolId = 'sch'; next(); },
    requireRole: () => (_req: any, _res: any, next: any) => next(),
    auditLog: vi.fn(async () => undefined),
}));

import router from './session-bookings';

vi.setConfig({ testTimeout: 30000 });
const USER = '33333333-3333-4333-8333-333333333333';
const ENR = '11111111-1111-4111-8111-111111111111';
const FAC = '22222222-2222-4222-8222-222222222222';
const body = {
    enrollment_id: ENR, facility_id: FAC, reservation_date: '2026-11-10',
    slots: [{ start_time: '10:00', end_time: '11:00' }],
};

async function post(payload: any = body) {
    const app = express();
    app.use(express.json());
    app.use('/s', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = app.listen(0, () => ok(s)); });
    try {
        const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/s/athlete/book-secondary`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    } finally { srv.close(); }
}

const creditCalls = () => rpc.mock.calls.filter((c) => c[0] === 'move_session_credit').map((c) => c[1]);

beforeEach(() => {
    rpc.mockReset();
    for (const k of Object.keys(tableResult)) delete tableResult[k];
    tableResult.enrollments = { data: { id: ENR, user_id: USER, school_id: 'sch', status: 'active', offering_plans: { included_minutes_per_period: null } }, error: null };
    tableResult.facilities = { data: { id: FAC, school_id: 'sch', booking_enabled: true, status: 'available' }, error: null };
    tableResult.facility_reservations = { data: { id: 'r1' }, error: null };
    tableResult.notifications = { data: null, error: null };
});

describe('POST /athlete/book-secondary — tope max_secondary_sessions', () => {
    it('bajo el tope: reserva el cupo ANTES del insert y responde 201 sin segundo consumo', async () => {
        rpc.mockResolvedValue({ data: { moved: true, capped: false, secondary_sessions_used: 1, max_secondary_sessions: 3 }, error: null });
        const r = await post();
        expect(r.status).toBe(201);
        expect(creditCalls()).toEqual([{ p_enrollment_id: ENR, p_delta: 1, p_is_secondary: true }]);
    });

    it('en el tope: 409 SECONDARY_CAP_REACHED y no inserta ni compensa', async () => {
        rpc.mockResolvedValue({ data: { moved: false, capped: true, secondary_sessions_used: 3, max_secondary_sessions: 3 }, error: null });
        const r = await post();
        expect(r.status).toBe(409);
        expect(r.body).toMatchObject({ code: 'SECONDARY_CAP_REACHED', max_secondary_sessions: 3, secondary_sessions_used: 3 });
        expect(creditCalls()).toHaveLength(1); // solo el intento, sin delta -1
    });

    it('tope 0 (default del plan): bloquea', async () => {
        rpc.mockResolvedValue({ data: { moved: false, capped: true, secondary_sessions_used: 0, max_secondary_sessions: 0 }, error: null });
        expect((await post()).status).toBe(409);
    });

    it('plan ilimitado / sin plan (moved sin capped o no_plan): deja reservar', async () => {
        rpc.mockResolvedValue({ data: { moved: false, reason: 'no_plan' }, error: null });
        const r = await post();
        expect(r.status).toBe(201);
        expect(creditCalls()).toHaveLength(1);
    });

    it('si el insert falla, devuelve el cupo (delta -1) y responde 409 por choque de horario', async () => {
        rpc.mockResolvedValue({ data: { moved: true, capped: false }, error: null });
        tableResult.facility_reservations = { data: null, error: { message: 'facility_slot_conflict', code: 'P0001' } };
        const r = await post();
        expect(r.status).toBe(409);
        expect(r.body.reason).toBe('facility_slot_conflict');
        expect(creditCalls()).toEqual([
            { p_enrollment_id: ENR, p_delta: 1, p_is_secondary: true },
            { p_enrollment_id: ENR, p_delta: -1, p_is_secondary: true },
        ]);
    });

    it('plan por horas: no toca el contador de secundarias (manda el banco)', async () => {
        tableResult.enrollments = { data: { id: ENR, user_id: USER, school_id: 'sch', status: 'active', offering_plans: { included_minutes_per_period: 600 } }, error: null };
        rpc.mockResolvedValue({ data: { reserved: true, reservation_id: 'hb1' }, error: null });
        const r = await post();
        expect(r.status).toBe(201);
        expect(creditCalls()).toHaveLength(0);
    });

    it('error del RPC de crédito: falla cerrado (500), no reserva', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
        const r = await post();
        expect(r.status).toBe(500);
    });
});
