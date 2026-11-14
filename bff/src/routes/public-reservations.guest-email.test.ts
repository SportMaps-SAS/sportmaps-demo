/**
 * Decisión de producto: en la web el invitado se verifica SOLO por correo (X-Guest-Token). El teléfono es contacto NO
 * verificado. La reserva web queda detrás de GUEST_WEB_BOOKING_ENABLED (default apagado) hasta aplicar la migración
 * que haga que `reservar_cancha` acepte `verified_email_at` en canal public.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

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
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn(async () => ({ success: true })) } }));
vi.mock('./reservations-checkout.routes', () => ({ setReservationGuestAuth: vi.fn() }));

vi.setConfig({ testTimeout: 30000 });
const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const GID = '44444444-4444-4444-8444-444444444444';
const KEY = { 'Idempotency-Key': 'abcd-1234-efgh' };
const body = { facility_id: UUID1, starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', payment_method: 'online' };
const okRes = {
    ok: true, idempotent_replay: false,
    reservation: { id: UUID2, school_id: UUID1, guest_booker_id: GID, status: 'pending_payment', ends_at: '2026-11-06T23:00:00Z' },
};
const guest = (over: Record<string, any> = {}) => ({
    id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null, ...over,
});

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
    const headers = () => ({ ...KEY, 'X-Guest-Token': shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 }) });
    return { call, shared, headers, close: () => srv.close() };
}

beforeEach(() => {
    rpc.mockReset(); rpc.mockResolvedValue({ data: okRes, error: null }); calls.length = 0;
    for (const k of Object.keys(tableResult)) delete tableResult[k];
    delete process.env.GUEST_WEB_BOOKING_ENABLED;
});
afterEach(() => { delete process.env.GUEST_WEB_BOOKING_ENABLED; });

describe('reserva web de invitado verificado por correo', () => {
    it('interruptor APAGADO (default): correo verificado sin teléfono -> 501 y no llama la RPC', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_email_at: '2026-11-06T00:00:00Z' }), error: null };
        const r = await t.call('/', { method: 'POST', headers: t.headers(), body }); t.close();
        expect(r.status).toBe(501);
        expect(r.body.code).toBe('PHONE_VERIFICATION_PENDING');
        expect(rpc).not.toHaveBeenCalled();
    });
    it('interruptor ENCENDIDO: correo verificado y teléfono sin verificar -> 201 por RPC canal public', async () => {
        process.env.GUEST_WEB_BOOKING_ENABLED = 'true';
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_email_at: '2026-11-06T00:00:00Z' }), error: null };
        const r = await t.call('/', { method: 'POST', headers: t.headers(), body }); t.close();
        expect(r.status).toBe(201);
        expect(rpc.mock.calls[0][1]).toMatchObject({ p_channel: 'public', p_guest_booker_id: GID, p_idempotency_key: 'abcd-1234-efgh' });
        expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_actor_profile_id');
        expect(r.body.reservation).not.toHaveProperty('guest_booker_id');
        expect(r.body.status_token).toBeTruthy();
        // Nunca se marca el teléfono como verificado.
        expect(calls.some((c) => c.table === 'guest_bookers' && c.op === 'update')).toBe(false);
    });
    it('interruptor ENCENDIDO: invitado SIN correo verificado -> 403 y no llama la RPC', async () => {
        process.env.GUEST_WEB_BOOKING_ENABLED = 'true';
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const r = await t.call('/', { method: 'POST', headers: t.headers(), body }); t.close();
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('GUEST_EMAIL_NOT_VERIFIED');
        expect(rpc).not.toHaveBeenCalled();
    });
    it('interruptor ENCENDIDO: siguen vigentes token, Idempotency-Key y validación estricta', async () => {
        process.env.GUEST_WEB_BOOKING_ENABLED = 'true';
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_email_at: '2026-11-06T00:00:00Z' }), error: null };
        const h = t.headers();
        expect((await t.call('/', { method: 'POST', headers: KEY, body })).status).toBe(401);
        expect((await t.call('/', { method: 'POST', headers: { 'X-Guest-Token': h['X-Guest-Token'] }, body })).status).toBe(400);
        expect((await t.call('/', { method: 'POST', headers: h, body: { ...body, p_channel: 'whatsapp' } })).status).toBe(400);
        t.close();
        expect(rpc).not.toHaveBeenCalled();
    });
    it('teléfono verificado (nacido por WhatsApp) sigue pasando con el interruptor apagado', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest({ verified_phone_at: '2026-11-01T00:00:00Z' }), error: null };
        const r = await t.call('/', { method: 'POST', headers: t.headers(), body }); t.close();
        expect(r.status).toBe(201);
    });
    it('/guests/verify marca solo verified_email_at, nunca verified_phone_at', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: guest(), error: null };
        const r = await t.call('/guests/verify', { method: 'POST', body: { phone: '+573001112233', email: 'ana@x.co', code: t.shared.currentOtp(GID, 'ana@x.co') } });
        t.close();
        expect(r.status).toBe(200);
        expect(r.body.phone_verified).toBe(false);
        const upd = calls.filter((c) => c.table === 'guest_bookers' && c.op === 'update');
        expect(upd).toHaveLength(1);
        expect(Object.keys(upd[0].args[0])).toEqual(['verified_email_at']);
    });
});
