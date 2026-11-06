import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

// ── Mock de supabase: rpc + builder encadenable que registra llamadas ───────
const rpc = vi.fn();
const tableResult: Record<string, { data: any; error: any }> = {};
const calls: { table: string; op: string; args: any[] }[] = [];

function builder(table: string) {
    const res = () => Promise.resolve(tableResult[table] ?? { data: null, error: null });
    const b: any = {};
    for (const op of ['select', 'eq', 'in', 'or', 'order', 'limit', 'gte', 'insert', 'update']) {
        b[op] = (...args: any[]) => { calls.push({ table, op, args }); return b; };
    }
    b.maybeSingle = res;
    b.single = res;
    b.then = (ok: any, ko: any) => res().then(ok, ko);
    return b;
}

vi.mock('../config/supabase', () => ({
    supabase: { rpc: (...a: any[]) => rpc(...a), from: (t: string) => builder(t) },
}));
// optionalAuth falso: el usuario sale del header x-test-user.
vi.mock('../middlewares/authMiddleware', () => ({
    optionalAuth: (req: any, _res: any, next: any) => {
        const id = req.headers['x-test-user'];
        req.user = id ? { id, email: 'u@x.co' } : null;
        next();
    },
}));

import router, { isStaffOfSchool } from './reservations.routes';
import { translateRpcError, RESERVATION_ERRORS } from '../utils/reservations.shared';

vi.setConfig({ testTimeout: 30000 });
const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

async function server() {
    const app = express();
    app.use(express.json());
    app.use('/r', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = app.listen(0, () => ok(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/r`;
    return { base, close: () => srv.close() };
}

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
    const s = await server();
    try {
        const r = await fetch(s.base + path, {
            method: init.method ?? 'GET',
            headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    } finally { s.close(); }
}

const auth = { 'x-test-user': USER };
const reserveBody = { facility_id: UUID1, starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', payment_method: 'online' };
const okReservation = {
    ok: true, idempotent_replay: false, requires_payment: true,
    reservation: { id: UUID2, facility_id: UUID1, status: 'pending_payment', payment_reference: 'RSV-AAAA' },
    pricing: { total: 120000 },
};

beforeEach(() => {
    rpc.mockReset(); rpc.mockResolvedValue({ data: true, error: null });
    calls.length = 0;
    for (const k of Object.keys(tableResult)) delete tableResult[k];
});

describe('traducción de errores (contrato §7)', () => {
    it('SLOT_TAKEN conserva alternatives y da 409 en español', () => {
        const t = translateRpcError({ ok: false, error: 'SLOT_TAKEN', message: 'Franja ocupada', alternatives: [{ facility_id: UUID1 }] });
        expect(t.status).toBe(409);
        expect(t.body).toMatchObject({ code: 'SLOT_TAKEN', error: 'Franja ocupada', alternatives: [{ facility_id: UUID1 }] });
    });
    it('usa el mensaje propio si el SQL no trae message', () => {
        const t = translateRpcError({ ok: false, error: 'TOO_SOON' });
        expect(t.status).toBe(422);
        expect(t.body.error).toMatch(/anticipación/);
    });
    it.each([
        ['IDEMPOTENCY_KEY_REUSED', 409], ['INVALID_STATE', 409], ['FACILITY_BLOCKED', 409],
        ['FORBIDDEN', 403], ['MINOR_CANNOT_BOOK', 403], ['ENTITLEMENT_REQUIRED', 403], ['PAYMENT_REQUIRED', 402],
        ['FACILITY_NOT_FOUND', 404], ['RESERVATION_NOT_FOUND', 404], ['FACILITY_NOT_BOOKABLE', 422],
        ['INVALID_ARGUMENT', 400], ['OUTSIDE_HOURS', 422], ['RANGE_TOO_LARGE', 422],
        // QA T1: TOO_MANY_ACTIVE caía al 422 genérico; el contrato §7 dice 429.
        ['TOO_MANY_ACTIVE', 429], ['DURATION_TOO_LONG', 422], ['PRICE_NOT_CONFIGURED', 422], ['RESCHEDULE_PRICE_DIFFERS', 422],
    ])('%s -> %i', (code, status) => {
        expect(RESERVATION_ERRORS[code].status).toBe(status);
    });
    it('código desconocido -> 422 genérico', () => {
        expect(translateRpcError({ ok: false, error: 'RARO' }).status).toBe(422);
    });
});

describe('sesión obligatoria', () => {
    it('sin usuario -> 401 en todas las rutas', async () => {
        for (const [m, p] of [['GET', '/availability'], ['POST', '/'], ['GET', '/mine'], ['GET', `/${UUID2}`], ['POST', `/${UUID2}/cancel`], ['POST', `/${UUID2}/reschedule`]]) {
            const r = await call(p, { method: m, body: m === 'POST' ? {} : undefined });
            expect(r.status, `${m} ${p}`).toBe(401);
        }
        expect(rpc).not.toHaveBeenCalled();
    });
});

describe('GET /availability', () => {
    it('llama disponibilidad_canchas con p_actor_profile_id = usuario', async () => {
        rpc.mockResolvedValue({ data: { ok: true, facilities: [] }, error: null });
        const r = await call(`/availability?school_id=${UUID1}&from=2026-11-06&to=2026-11-08&duration_min=60`, { headers: auth });
        expect(r.status).toBe(200);
        const c = rpc.mock.calls.find((x) => x[0] === 'disponibilidad_canchas')!;
        expect(c[1]).toMatchObject({ p_school_id: UUID1, p_from: '2026-11-06', p_to: '2026-11-08', p_duration_min: 60, p_actor_profile_id: USER });
    });
    it('fechas inválidas -> 400 sin tocar la RPC', async () => {
        const r = await call(`/availability?school_id=${UUID1}&from=hoy&to=2026-11-08`, { headers: auth });
        expect(r.status).toBe(400);
        expect(rpc.mock.calls.find((x) => x[0] === 'disponibilidad_canchas')).toBeUndefined();
    });
    it('traduce RANGE_TOO_LARGE', async () => {
        rpc.mockResolvedValue({ data: { ok: false, error: 'RANGE_TOO_LARGE' }, error: null });
        const r = await call(`/availability?school_id=${UUID1}&from=2026-11-06&to=2026-12-30`, { headers: auth });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('RANGE_TOO_LARGE');
    });
});

describe('POST / (reservar)', () => {
    it('exige Idempotency-Key', async () => {
        const r = await call('/', { method: 'POST', headers: auth, body: reserveBody });
        expect(r.status).toBe(400);
        expect(r.body.reason).toBe('idempotency_key_required');
    });
    it('idempotencia: mismo header -> misma llave a la RPC y misma respuesta (201 luego 200)', async () => {
        rpc.mockResolvedValueOnce({ data: okReservation, error: null });
        rpc.mockResolvedValueOnce({ data: { ...okReservation, idempotent_replay: true }, error: null });
        const h = { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' };
        const a = await call('/', { method: 'POST', headers: h, body: reserveBody });
        const b = await call('/', { method: 'POST', headers: h, body: reserveBody });
        expect(a.status).toBe(201);
        expect(b.status).toBe(200);
        expect(b.body.reservation).toEqual(a.body.reservation);
        expect(rpc.mock.calls.map((c) => c[1].p_idempotency_key)).toEqual(['abcd-1234-efgh', 'abcd-1234-efgh']);
        expect(rpc.mock.calls[0][1]).toMatchObject({ p_channel: 'app', p_actor_profile_id: USER, p_payment_method: 'online' });
    });
    it('SLOT_TAKEN -> 409 con alternatives', async () => {
        rpc.mockResolvedValue({ data: { ok: false, error: 'SLOT_TAKEN', message: 'Ocupada', alternatives: [{ price: 1 }] }, error: null });
        const r = await call('/', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' }, body: reserveBody });
        expect(r.status).toBe(409);
        expect(r.body.alternatives).toEqual([{ price: 1 }]);
    });
    it('channel admin de un no-staff baja a app', async () => {
        tableResult.facilities = { data: { school_id: UUID1 }, error: null };
        tableResult.platform_admins = { data: null, error: null };
        tableResult.school_members = { data: [{ role: 'parent' }], error: null };
        rpc.mockResolvedValue({ data: okReservation, error: null });
        await call('/', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' }, body: { ...reserveBody, channel: 'admin' } });
        expect(rpc.mock.calls[0][1].p_channel).toBe('app');
    });
    it('channel admin de staff se respeta', async () => {
        tableResult.facilities = { data: { school_id: UUID1 }, error: null };
        tableResult.platform_admins = { data: null, error: null };
        tableResult.school_members = { data: [{ role: 'school_admin' }], error: null };
        rpc.mockResolvedValue({ data: okReservation, error: null });
        await call('/', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' }, body: { ...reserveBody, channel: 'admin', payment_method: 'cash', amount_paid: 50000 } });
        expect(rpc.mock.calls[0][1]).toMatchObject({ p_channel: 'admin', p_payment_method: 'cash', p_amount_paid: 50000 });
    });
    it('error de base (excepción SQL) -> 500 genérico', async () => {
        rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
        const r = await call('/', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' }, body: reserveBody });
        expect(r.status).toBe(500);
        expect(JSON.stringify(r.body)).not.toMatch(/boom/);
    });
    it('ends_at <= starts_at -> 400', async () => {
        const r = await call('/', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'abcd-1234-efgh' }, body: { ...reserveBody, ends_at: reserveBody.starts_at } });
        expect(r.status).toBe(400);
    });
});

describe('cancelar / reprogramar', () => {
    it('cancel pasa actor y motivo', async () => {
        rpc.mockResolvedValue({ data: { ok: true, already_cancelled: false }, error: null });
        const r = await call(`/${UUID2}/cancel`, { method: 'POST', headers: auth, body: { reason: 'lluvia' } });
        expect(r.status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('cancelar_reserva', { p_reservation_id: UUID2, p_actor_profile_id: USER, p_reason: 'lluvia' });
    });
    it('cancel fuera de ventana -> 409', async () => {
        rpc.mockResolvedValue({ data: { ok: false, error: 'CANCELLATION_WINDOW_CLOSED' }, error: null });
        const r = await call(`/${UUID2}/cancel`, { method: 'POST', headers: auth, body: {} });
        expect(r.status).toBe(409);
    });
    it('reschedule pasa rango y cancha nueva', async () => {
        rpc.mockResolvedValue({ data: { ok: true, unchanged: false }, error: null });
        await call(`/${UUID2}/reschedule`, { method: 'POST', headers: auth, body: { starts_at: '2026-11-07T22:00:00Z', ends_at: '2026-11-07T23:00:00Z', facility_id: UUID1 } });
        expect(rpc).toHaveBeenCalledWith('reprogramar_reserva', {
            p_reservation_id: UUID2, p_new_starts_at: '2026-11-07T22:00:00Z', p_new_ends_at: '2026-11-07T23:00:00Z',
            p_actor_profile_id: USER, p_new_facility_id: UUID1,
        });
    });
});

describe('GET /mine y /:id (alcance)', () => {
    it('/mine filtra por user_id y quita lo interno', async () => {
        tableResult.facility_reservations = { data: [{ id: UUID2, user_id: USER, idempotency_key: 'k', price_snapshot: { x: 1 }, guest_booker_id: null }], error: null };
        const r = await call('/mine', { headers: auth });
        expect(r.status).toBe(200);
        expect(calls.find((c) => c.op === 'eq' && c.args[0] === 'user_id')!.args[1]).toBe(USER);
        expect(r.body.reservations[0]).not.toHaveProperty('idempotency_key');
        expect(r.body.reservations[0]).not.toHaveProperty('price_snapshot');
    });
    it('/:id de otro usuario que no es staff -> 404', async () => {
        tableResult.facility_reservations = { data: { id: UUID2, user_id: UUID1, school_id: UUID1 }, error: null };
        tableResult.platform_admins = { data: null, error: null };
        tableResult.school_members = { data: [{ role: 'parent' }], error: null };
        expect((await call(`/${UUID2}`, { headers: auth })).status).toBe(404);
    });
    it('/:id propio -> 200; de staff -> 200 con price_snapshot', async () => {
        tableResult.facility_reservations = { data: { id: UUID2, user_id: USER, school_id: UUID1, price_snapshot: { t: 1 } }, error: null };
        const own = await call(`/${UUID2}`, { headers: auth });
        expect(own.status).toBe(200);
        expect(own.body.reservation).not.toHaveProperty('price_snapshot');

        tableResult.facility_reservations = { data: { id: UUID2, user_id: UUID1, school_id: UUID1, price_snapshot: { t: 1 } }, error: null };
        tableResult.school_members = { data: [{ role: 'facility_manager' }], error: null };
        const staff = await call(`/${UUID2}`, { headers: auth });
        expect(staff.status).toBe(200);
        expect(staff.body.reservation.price_snapshot).toEqual({ t: 1 });
    });
    it('isStaffOfSchool: admin de plataforma cuenta', async () => {
        tableResult.platform_admins = { data: { profile_id: USER }, error: null };
        expect(await isStaffOfSchool(USER, UUID1)).toBe(true);
    });
});
