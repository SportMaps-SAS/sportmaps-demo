import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const rpc = vi.fn();
const tableResult: Record<string, { data: any; error: any }> = {};
const calls: { table: string; op: string; args: any[] }[] = [];
const send = vi.fn(async (_p: any) => ({ success: true }));

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
vi.mock('../utils/emailClient', () => ({ emailClient: { send: (p: any) => send(p) } }));
// El router registra su validador del invitado en el módulo de cobro (QA T1): se captura aquí.
let guestAuth: ((req: any, id: string) => Promise<{ guestBookerId: string } | null>) | null = null;
vi.mock('./reservations-checkout.routes', () => ({ setReservationGuestAuth: (fn: any) => { guestAuth = fn; } }));

vi.setConfig({ testTimeout: 30000 });
const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const GID = '44444444-4444-4444-8444-444444444444';
const KEY = { 'Idempotency-Key': 'abcd-1234-efgh' };

// Router fresco por prueba (limitadores y contadores nuevos).
async function app() {
    vi.resetModules();
    const router = (await import('./public-reservations.routes')).default;
    const shared = await import('../utils/reservations.shared');
    const a = express();
    a.use(express.json());
    a.use('/p', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = a.listen(0, () => ok(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/p`;
    const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: any } = {}) => {
        const r = await fetch(base + path, {
            method: init.method ?? 'GET',
            headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call, shared, close: () => srv.close() };
}

const guest = (over: Record<string, any> = {}) => ({
    id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null, ...over,
});
const body = { facility_id: UUID1, starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', payment_method: 'online' };
const okRes = {
    ok: true, idempotent_replay: false,
    reservation: { id: UUID2, school_id: UUID1, user_id: null, guest_booker_id: GID, status: 'pending_payment', ends_at: '2026-11-06T23:00:00Z', price_snapshot: { a: 1 } },
};

beforeEach(() => {
    rpc.mockReset(); rpc.mockResolvedValue({ data: true, error: null }); send.mockClear(); calls.length = 0;
    for (const k of Object.keys(tableResult)) delete tableResult[k];
});

describe('GET /schools/:slug', () => {
    it('filtra por bookable_by public/both y solo devuelve campos publicables', async () => {
        const t = await app();
        tableResult.schools = { data: { id: UUID1, name: 'Club', slug: 'club' }, error: null };
        tableResult.facilities = {
            data: [{ id: UUID2, name: 'Cancha 1', type: 'futbol_5', capacity: 10, slot_step_min: 30, min_duration_min: 60, rental_rate: 99999, min_deposit_pct: 30, school_id: UUID1 }],
            error: null,
        };
        const r = await t.call('/schools/club');
        t.close();
        expect(r.status).toBe(200);
        expect(calls.find((c) => c.table === 'facilities' && c.op === 'in')!.args).toEqual(['bookable_by', ['public', 'both']]);
        expect(calls.some((c) => c.table === 'facilities' && c.op === 'eq' && c.args[0] === 'status' && c.args[1] === 'available')).toBe(true);
        expect(Object.keys(r.body.facilities[0]).sort()).toEqual(['capacity', 'id', 'min_duration_min', 'name', 'slot_step_min', 'type']);
        expect(JSON.stringify(r.body)).not.toMatch(/rental_rate|deposit/);
    });
    it('slug inexistente -> 404', async () => {
        const t = await app();
        const r = await t.call('/schools/nada'); t.close();
        expect(r.status).toBe(404);
    });
});

describe('GET /availability (invitado)', () => {
    it('llama la RPC SIN actor ni audiencia', async () => {
        const t = await app();
        rpc.mockResolvedValue({ data: { ok: true, facilities: [] }, error: null });
        const r = await t.call(`/availability?school_id=${UUID1}&from=2026-11-06&to=2026-11-07`); t.close();
        expect(r.status).toBe(200);
        const args = rpc.mock.calls[0][1];
        expect(args).toEqual({ p_school_id: UUID1, p_from: '2026-11-06', p_to: '2026-11-07' });
        expect(args).not.toHaveProperty('p_actor_profile_id');
    });
});

describe('POST / (invitado)', () => {
    it('sin token de invitado -> 401 y no llama la RPC', async () => {
        const t = await app();
        const r = await t.call('/', { method: 'POST', headers: KEY, body }); t.close();
        expect(r.status).toBe(401);
        expect(rpc).not.toHaveBeenCalled();
    });
    it('token manipulado o vencido -> 401', async () => {
        const t = await app();
        const good = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
        const expired = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() - 1 });
        const forged = good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
        for (const tok of [forged, expired, 'basura']) {
            const r = await t.call('/', { method: 'POST', headers: { ...KEY, 'X-Guest-Token': tok }, body });
            expect(r.status).toBe(401);
        }
        t.close();
    });
    it('token de enlace (/r) no sirve como token de invitado', async () => {
        const t = await app();
        const link = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        const r = await t.call('/', { method: 'POST', headers: { ...KEY, 'X-Guest-Token': link }, body }); t.close();
        expect(r.status).toBe(401);
    });
    it('sin Idempotency-Key -> 400', async () => {
        const t = await app();
        const r = await t.call('/', { method: 'POST', body }); t.close();
        expect(r.status).toBe(400);
    });
    it('teléfono sin verificar -> 501 PHONE_VERIFICATION_PENDING y no llama la RPC', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const tok = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
        const r = await t.call('/', { method: 'POST', headers: { ...KEY, 'X-Guest-Token': tok }, body }); t.close();
        expect(r.status).toBe(501);
        expect(r.body.code).toBe('PHONE_VERIFICATION_PENDING');
        expect(rpc).not.toHaveBeenCalled();
    });
    it('teléfono verificado -> RPC con guest id y canal public; replay devuelve lo mismo', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_phone_at: '2026-11-01T00:00:00Z' }), error: null };
        rpc.mockResolvedValueOnce({ data: okRes, error: null });
        rpc.mockResolvedValueOnce({ data: { ...okRes, idempotent_replay: true }, error: null });
        const h = { ...KEY, 'X-Guest-Token': t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 }) };
        const a = await t.call('/', { method: 'POST', headers: h, body });
        const b = await t.call('/', { method: 'POST', headers: h, body });
        t.close();
        expect(a.status).toBe(201);
        expect(b.status).toBe(200);
        expect(rpc.mock.calls[0][1]).toMatchObject({ p_channel: 'public', p_guest_booker_id: GID, p_idempotency_key: 'abcd-1234-efgh' });
        expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_actor_profile_id');
        expect(b.body.status_token).toBe(a.body.status_token);
        expect(a.body.reservation).not.toHaveProperty('price_snapshot');
        expect(a.body.reservation).not.toHaveProperty('user_id');
        const link = t.shared.verifyToken(a.body.status_token, 'r');
        expect(link).toMatchObject({ gid: GID, rid: UUID2 });
    });
    it('SLOT_TAKEN -> 409 con alternatives', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_phone_at: '2026-11-01T00:00:00Z' }), error: null };
        rpc.mockResolvedValue({ data: { ok: false, error: 'SLOT_TAKEN', alternatives: [{ price: 5 }] }, error: null });
        const h = { ...KEY, 'X-Guest-Token': t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 }) };
        const r = await t.call('/', { method: 'POST', headers: h, body }); t.close();
        expect(r.status).toBe(409);
        expect(r.body.alternatives).toEqual([{ price: 5 }]);
    });
});

describe('guests/start y guests/verify', () => {
    it('start: crea invitado nuevo y manda OTP al correo (no marca teléfono)', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: null, error: null };
        // el insert().select().single() devuelve el mismo registro configurado:
        const created = guest();
        const orig = tableResult.guest_bookers;
        // primera lectura (maybeSingle) vacía; luego el insert devuelve `created`
        let first = true;
        Object.defineProperty(tableResult, 'guest_bookers', { configurable: true, get: () => { if (first) { first = false; return orig; } return { data: created, error: null }; } });
        const r = await t.call('/guests/start', { method: 'POST', body: { phone: '300 111 2233', email: 'ANA@x.co', full_name: 'Ana' } });
        t.close();
        Object.defineProperty(tableResult, 'guest_bookers', { configurable: true, writable: true, value: undefined });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ sent: true, phone_verified: false });
        expect(send).toHaveBeenCalledTimes(1);
        const ins = calls.find((c) => c.table === 'guest_bookers' && c.op === 'insert')!;
        expect(ins.args[0]).toEqual({ phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana' });
        expect(ins.args[0]).not.toHaveProperty('verified_phone_at');
    });
    it('start: teléfono de otro correo -> 409 y no manda OTP', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest({ email: 'otra@x.co' }), error: null };
        const r = await t.call('/guests/start', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', full_name: 'Ana' } }); t.close();
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('PHONE_IN_USE');
        expect(send).not.toHaveBeenCalled();
    });
    it('rate limit por IP: la 6.ª solicitud en 10 min -> 429', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            // correos distintos para no chocar antes con el límite por correo
            statuses.push((await t.call('/guests/start', { method: 'POST', body: { phone: `30011122${10 + i}`, email: `ana${i}@x.co`, full_name: 'Ana' } })).status);
        }
        t.close();
        expect(statuses.slice(0, 5)).not.toContain(429);
        expect(statuses[5]).toBe(429);
    });
    it('rate limit por correo: la 4.ª solicitud del mismo correo -> 429', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++) {
            statuses.push((await t.call('/guests/start', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', full_name: 'Ana' } })).status);
        }
        t.close();
        expect(statuses).toEqual([200, 200, 200, 429]);
    });
    it('verify: código correcto da token de invitado y marca SOLO verified_email_at', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const code = t.shared.currentOtp(GID, 'ana@x.co');
        const r = await t.call('/guests/verify', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', code } }); t.close();
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ email_verified: true, phone_verified: false });
        expect(t.shared.verifyToken(r.body.guest_token, 'g')).toMatchObject({ gid: GID });
        const upd = calls.find((c) => c.table === 'guest_bookers' && c.op === 'update')!;
        expect(Object.keys(upd.args[0])).toEqual(['verified_email_at']);
    });
    it('verify: código malo -> 400 genérico, sin token', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const r = await t.call('/guests/verify', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', code: '000000' } }); t.close();
        expect(r.status).toBe(400);
        expect(r.body).not.toHaveProperty('guest_token');
    });
    it('verify-phone -> 501 pendiente', async () => {
        const t = await app();
        const r = await t.call('/guests/verify-phone', { method: 'POST', body: {} }); t.close();
        expect(r.status).toBe(501);
    });
});

describe('enlace /r/:token', () => {
    it('token inválido -> 401', async () => {
        const t = await app();
        expect((await t.call('/r/basura')).status).toBe(401);
        expect((await t.call('/r/basura/cancel', { method: 'POST', body: {} })).status).toBe(401);
        t.close();
        expect(rpc).not.toHaveBeenCalled();
    });
    it('GET filtra por reserva Y invitado dueño y esconde lo interno', async () => {
        const t = await app();
        tableResult.facility_reservations = { data: { id: UUID2, status: 'confirmed', user_id: null, school_id: UUID1, price_snapshot: {}, guest_booker_id: GID }, error: null };
        const tok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        const r = await t.call(`/r/${tok}`); t.close();
        expect(r.status).toBe(200);
        expect(calls.find((c) => c.table === 'facility_reservations' && c.op === 'eq' && c.args[0] === 'guest_booker_id')!.args[1]).toBe(GID);
        expect(r.body.reservation).not.toHaveProperty('price_snapshot');
    });
    it('cancel y reschedule llaman las RPC con p_guest_booker_id (sin actor ni cancha nueva)', async () => {
        const t = await app();
        const tok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        rpc.mockResolvedValue({ data: { ok: true, reservation: { id: UUID2, price_snapshot: {} } }, error: null });
        const c = await t.call(`/r/${tok}/cancel`, { method: 'POST', body: { reason: 'no puedo' } });
        // facility_id NO se acepta (schema estricto): cambiar de cancha es solo del staff -> 400 y no llama la RPC.
        const rsBad = await t.call(`/r/${tok}/reschedule`, { method: 'POST', body: { starts_at: '2026-11-07T22:00:00Z', ends_at: '2026-11-07T23:00:00Z', facility_id: UUID1 } });
        expect(rsBad.status).toBe(400);
        expect(rpc).not.toHaveBeenCalledWith('reprogramar_reserva', expect.anything());
        const rs = await t.call(`/r/${tok}/reschedule`, { method: 'POST', body: { starts_at: '2026-11-07T22:00:00Z', ends_at: '2026-11-07T23:00:00Z' } });
        t.close();
        expect(c.status).toBe(200);
        expect(rs.status).toBe(200);
        expect(rpc).toHaveBeenCalledWith('cancelar_reserva', { p_reservation_id: UUID2, p_guest_booker_id: GID, p_reason: 'no puedo' });
        expect(rpc).toHaveBeenCalledWith('reprogramar_reserva', {
            p_reservation_id: UUID2, p_new_starts_at: '2026-11-07T22:00:00Z', p_new_ends_at: '2026-11-07T23:00:00Z', p_guest_booker_id: GID,
        });
    });
    it('traduce errores de las RPC (ventana cerrada -> 409)', async () => {
        const t = await app();
        const tok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        rpc.mockResolvedValue({ data: { ok: false, error: 'RESCHEDULE_WINDOW_CLOSED' }, error: null });
        const r = await t.call(`/r/${tok}/reschedule`, { method: 'POST', body: { starts_at: '2026-11-07T22:00:00Z', ends_at: '2026-11-07T23:00:00Z' } });
        t.close();
        expect(r.status).toBe(409);
    });
});

describe('validador del invitado para el cobro (X-Reservation-Token)', () => {
    const reqWith = (tok?: string) => ({ header: (n: string) => (n === 'X-Reservation-Token' ? tok : undefined) });
    it('se registra al cargar el router y acepta solo el token de ESA reserva', async () => {
        guestAuth = null;
        const t = await app();
        t.close();
        expect(guestAuth).toBeTypeOf('function');
        const ok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        expect(await guestAuth!(reqWith(ok), UUID2)).toEqual({ guestBookerId: GID });
        expect(await guestAuth!(reqWith(ok), UUID2.toUpperCase())).toEqual({ guestBookerId: GID });
        expect(await guestAuth!(reqWith(ok), UUID1)).toBeNull();                       // token de otra reserva
        expect(await guestAuth!(reqWith(undefined), UUID2)).toBeNull();
        expect(await guestAuth!(reqWith(ok + 'x'), UUID2)).toBeNull();                 // firma rota
        const venc = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() - 1 });
        expect(await guestAuth!(reqWith(venc), UUID2)).toBeNull();                      // vencido
        const g = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
        expect(await guestAuth!(reqWith(g), UUID2)).toBeNull();                         // token de invitado, no de reserva
    });
});
