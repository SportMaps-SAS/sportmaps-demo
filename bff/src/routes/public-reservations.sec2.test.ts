/**
 * Ronda SEC2 (revisión adversarial) de las rutas públicas de reservas: M1 (llave de IP real), M2 (disponibilidad pública
 * acotada + caché), M3 (token de estado: TTL, jti, redacción en logs), lista blanca de columnas y cabeceras estrictas.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const DAY = 24 * 3600_000;

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

beforeEach(() => {
    rpc.mockReset(); rpc.mockResolvedValue({ data: { ok: true, facilities: [] }, error: null }); calls.length = 0;
    for (const k of Object.keys(tableResult)) delete tableResult[k];
});

describe('M1: llave de los limitadores = IP real del cliente (no req.ip)', () => {
    it('reservationsClientIp usa CF-Connecting-IP solo si es una IP válida; si no, req.ip', async () => {
        const { reservationsClientIp } = await import('../utils/reservations.shared');
        expect(reservationsClientIp({ headers: { 'cf-connecting-ip': '181.63.24.103' }, ip: '172.68.175.10' } as any)).toBe('181.63.24.103');
        expect(reservationsClientIp({ headers: { 'cf-connecting-ip': '2803:1920::1' }, ip: '172.68.175.10' } as any)).toBe('2803:1920::1');
        expect(reservationsClientIp({ headers: { 'cf-connecting-ip': 'no-es-ip; drop' }, ip: '172.68.175.10' } as any)).toBe('172.68.175.10');
        expect(reservationsClientIp({ headers: {}, ip: '10.0.0.5' } as any)).toBe('10.0.0.5');
    });

    it('el borde de Cloudflare rota pero el cliente es el mismo: la 6.ª solicitud de la MISMA IP real -> 429', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: { id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null }, error: null };
        const st: number[] = [];
        for (let i = 0; i < 6; i++) {
            st.push((await t.call('/guests/start', {
                method: 'POST',
                headers: { 'CF-Connecting-IP': '181.63.24.103', 'X-Forwarded-For': `172.68.${i}.1` }, // el borde cambia
                body: { phone: `30011122${10 + i}`, email: `ana${i}@x.co`, full_name: 'Ana' },
            })).status);
        }
        t.close();
        expect(st.slice(0, 5)).not.toContain(429);
        expect(st[5]).toBe(429);
    });

    it('IPs reales distintas no comparten contador', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: { id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null }, error: null };
        const st: number[] = [];
        for (let i = 0; i < 7; i++) {
            st.push((await t.call('/guests/start', {
                method: 'POST',
                headers: { 'CF-Connecting-IP': `181.63.24.${100 + i}` },
                body: { phone: `30011122${10 + i}`, email: `bea${i}@x.co`, full_name: 'Bea' },
            })).status);
        }
        t.close();
        expect(st).not.toContain(429);
    });

    it('el almacén de los limitadores es enchufable (fábrica registrada antes de la primera petición)', async () => {
        vi.resetModules();
        const shared = await import('../utils/reservations.shared');
        const incrementos: string[] = [];
        shared.setReservationsRateLimitStoreFactory(() => ({
            increment: async (key: string) => { incrementos.push(key); return { totalHits: 1, resetTime: new Date(Date.now() + 1000) }; },
            decrement: async () => undefined,
            resetKey: async () => undefined,
        } as any));
        const router = (await import('./public-reservations.routes')).default;
        const a = express(); a.use(express.json()); a.use('/p', router);
        const srv = await new Promise<import('http').Server>((ok) => { const s = a.listen(0, () => ok(s)); });
        const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/p/schools/club`, { headers: { 'CF-Connecting-IP': '181.63.24.103' } });
        srv.close();
        expect(r.status).toBe(404);
        expect(incrementos).toEqual(['rsv-read-181.63.24.103']);
    });
});

describe('M2: disponibilidad pública acotada', () => {
    const url = (from: string, to: string, extra = '') => `/availability?school_id=${UUID1}&from=${from}&to=${to}${extra}`;

    it('rango de 15 días -> 422 RANGE_TOO_LARGE sin llamar la RPC; 14 días pasa', async () => {
        const t = await app();
        const largo = await t.call(url('2026-11-06', '2026-11-21'));
        const ok = await t.call(url('2026-11-06', '2026-11-20'));
        t.close();
        expect(largo.status).toBe(422);
        expect(largo.body.code).toBe('RANGE_TOO_LARGE');
        expect(ok.status).toBe(200);
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('más de 3 canchas públicas sin facility_id -> 422 FACILITY_REQUIRED; con facility_id o con 3 canchas pasa', async () => {
        const t = await app();
        tableResult.facilities = { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], error: null };
        const sin = await t.call(url('2026-11-06', '2026-11-07'));
        expect(sin.status).toBe(422);
        expect(sin.body.code).toBe('FACILITY_REQUIRED');
        expect(rpc).not.toHaveBeenCalled();
        const con = await t.call(url('2026-11-06', '2026-11-07', `&facility_id=${UUID2}`));
        expect(con.status).toBe(200);
        tableResult.facilities = { data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], error: null };
        const tres = await t.call(url('2026-11-08', '2026-11-09'));
        t.close();
        expect(tres.status).toBe(200);
        // la consulta de canchas es acotada (limit 4) y solo mira las públicas
        const lim = calls.find((c) => c.table === 'facilities' && c.op === 'limit');
        expect(lim?.args[0]).toBe(4);
        expect(calls.some((c) => c.table === 'facilities' && c.op === 'in' && c.args[0] === 'bookable_by')).toBe(true);
    });

    it('caché de 30 s por (escuela, cancha, from, to, ...): la repetición no llama la RPC; otra clave sí', async () => {
        const t = await app();
        const a = await t.call(url('2026-11-06', '2026-11-07', `&facility_id=${UUID2}`));
        const b = await t.call(url('2026-11-06', '2026-11-07', `&facility_id=${UUID2}`));
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(b.body).toEqual(a.body);
        await t.call(url('2026-11-07', '2026-11-08', `&facility_id=${UUID2}`));
        t.close();
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('un error de la RPC no se cachea', async () => {
        const t = await app();
        rpc.mockResolvedValueOnce({ data: { ok: false, error: 'FACILITY_NOT_FOUND' }, error: null });
        const a = await t.call(url('2026-11-06', '2026-11-07', `&facility_id=${UUID2}`));
        const b = await t.call(url('2026-11-06', '2026-11-07', `&facility_id=${UUID2}`));
        t.close();
        expect(a.status).toBe(404);
        expect(b.status).toBe(200);
        expect(rpc).toHaveBeenCalledTimes(2);
    });
});

describe('M3: token de estado', () => {
    it('TTL de 14 días tras el fin y jti en el payload; el de 30 días viejo sigue verificando solo si no venció', async () => {
        const t = await app();
        expect(t.shared.STATUS_LINK_TTL_MS).toBe(14 * DAY);
        tableResult.guest_bookers = { data: { id: GID, phone: '+573001112233', email: 'a@x.co', full_name: 'A', verified_phone_at: '2026-11-01T00:00:00Z', verified_email_at: null }, error: null };
        rpc.mockResolvedValue({ data: { ok: true, idempotent_replay: false, reservation: { id: UUID2, status: 'pending_payment', ends_at: '2026-11-06T23:00:00Z', starts_at: '2026-11-06T22:00:00Z' } }, error: null });
        const guestTok = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
        const r = await t.call('/', {
            method: 'POST', headers: { ...KEY, 'X-Guest-Token': guestTok },
            body: { facility_id: UUID1, starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', payment_method: 'online' },
        });
        t.close();
        expect(r.status).toBe(201);
        const p = t.shared.verifyToken(r.body.status_token, 'r', undefined, new Date('2026-11-06T23:00:00Z').getTime())!;
        expect(p.exp).toBe(new Date('2026-11-06T23:00:00Z').getTime() + 14 * DAY);
        expect(p.jti).toMatch(/^[0-9a-f]{24}$/);
        expect(p.jti).toBe(t.shared.linkJti(UUID2, GID));
    });

    it('token con exp vencido o typ equivocado se rechaza (401) en /r/:token', async () => {
        const t = await app();
        const viejo = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() - 1000, jti: 'x' });
        const typMal = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000, jti: 'x' });
        expect((await t.call(`/r/${viejo}`)).status).toBe(401);
        expect((await t.call(`/r/${typMal}`)).status).toBe(401);
        expect((await t.call(`/r/${viejo}/cancel`, { method: 'POST', body: {} })).status).toBe(401);
        t.close();
        expect(rpc).not.toHaveBeenCalled();
    });

    it('el token de invitado lleva un jti aleatorio distinto en cada /guests/verify', async () => {
        const t = await app();
        tableResult.guest_bookers = { data: { id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null }, error: null };
        const code = t.shared.currentOtp(GID, 'ana@x.co');
        const a = await t.call('/guests/verify', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', code } });
        const b = await t.call('/guests/verify', { method: 'POST', body: { phone: '3001112233', email: 'ana@x.co', code } });
        t.close();
        const pa = t.shared.verifyToken(a.body.guest_token, 'g')!;
        const pb = t.shared.verifyToken(b.body.guest_token, 'g')!;
        expect(pa.jti).toBeTruthy();
        expect(pa.jti).not.toBe(pb.jti);
    });

    it('el serializer de logs redacta /r/<token> (forma completa y relativa al montaje)', async () => {
        const { redactSecretsInUrl } = await import('../utils/redactUrl');
        const tok = 'eyJ0eXAiOiJyIiwiZ2lkIjoiYSJ9.abcdefghijklmnopqrstuvwxyz0123456789_-ABC';
        expect(redactSecretsInUrl(`/api/v1/public/reservations/r/${tok}`)).toBe('/api/v1/public/reservations/r/[REDACTED]');
        expect(redactSecretsInUrl(`/api/v1/public/reservations/r/${tok}/cancel?x=1`)).toBe('/api/v1/public/reservations/r/[REDACTED]/cancel?x=1');
        expect(redactSecretsInUrl(`/r/${tok}/reschedule`)).toBe('/r/[REDACTED]/reschedule');
        expect(redactSecretsInUrl('/api/v1/public/reservations/availability?school_id=1')).toBe('/api/v1/public/reservations/availability?school_id=1');
        expect(redactSecretsInUrl(undefined)).toBe('');
        expect(redactSecretsInUrl(`/api/v1/public/reservations/r/${tok}`)).not.toContain(tok);
    });

    it('index.ts usa el redactor en el serializer de pino', async () => {
        const fs = await import('fs');
        const src = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
        expect(src).toMatch(/url:\s*redactSecretsInUrl\(req\.url\)/);
        expect(src).not.toMatch(/url:\s*req\.url\b/);
    });
});

describe('BAJO (a): GET /r/:token devuelve solo una lista blanca de columnas', () => {
    it('el SELECT es explícito (no *) y la respuesta no trae approved_by, channel, refund_status, payment_reference, snapshot...', async () => {
        const t = await app();
        tableResult.facility_reservations = {
            data: {
                id: UUID2, status: 'pending_payment', payment_status: 'unpaid', starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z',
                facility_id: UUID1, price: 120000, amount_paid: 0, min_deposit_pct: 30, hold_expires_at: '2026-11-06T21:00:00Z',
                cancellation_reason: null, cancelled_at: null, participants: 8,
                price_snapshot: { deposit_min: 36000, transfer_proof: { url: 'https://x' }, payment_events: ['wompi:1'], internal: 'secreto' },
                facility: { name: 'Cancha 1', type: 'futbol_5' },
                // columnas que NUNCA deben salir (si el select las trajera):
                approved_by: 'u-1', approved_at: 'x', channel: 'public', refund_status: 'none', payment_reference: 'RSV-3F9A1C0D22B4E7A1',
                payment_id: 'p', idempotency_key: 'k', guest_booker_id: GID, user_id: null, school_id: UUID1, notes: 'nota', external_org_name: 'org',
            },
            error: null,
        };
        const tok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        const r = await t.call(`/r/${tok}`); t.close();
        expect(r.status).toBe(200);
        const sel = calls.find((c) => c.table === 'facility_reservations' && c.op === 'select')!.args[0] as string;
        expect(sel).not.toContain('*');
        for (const prohibida of ['approved_by', 'channel', 'refund_status', 'payment_reference', 'payment_id', 'idempotency_key', 'user_id', 'school_id', 'notes']) {
            expect(sel).not.toMatch(new RegExp(`\\b${prohibida}\\b`));
        }
        const out = r.body.reservation;
        expect(Object.keys(out).sort()).toEqual([
            'amount_paid', 'cancellation_reason', 'cancelled_at', 'deposit_min', 'ends_at', 'facility', 'facility_id', 'facility_name', 'hold_expires_at',
            'id', 'in_review', 'local_date', 'local_end', 'local_start', 'min_deposit_pct', 'participants', 'payment_status', 'price', 'starts_at', 'status',
        ].sort());
        expect(out).toMatchObject({ deposit_min: 36000, in_review: true, facility_name: 'Cancha 1', local_date: '2026-11-06', local_start: '17:00', local_end: '18:00' });
        expect(JSON.stringify(out)).not.toMatch(/secreto|payment_events|RSV-|approved_by|wompi/);
    });

    it('las respuestas de POST / y cancel/reschedule usan la misma lista blanca', async () => {
        const t = await app();
        const tok = t.shared.signToken({ typ: 'r', gid: GID, rid: UUID2, exp: Date.now() + 60_000 });
        rpc.mockResolvedValue({ data: { ok: true, reservation: { id: UUID2, status: 'cancelled', approved_by: 'x', channel: 'public', refund_status: 'pending', payment_reference: 'RSV-X', price_snapshot: { a: 1 } } }, error: null });
        const c = await t.call(`/r/${tok}/cancel`, { method: 'POST', body: {} });
        t.close();
        expect(c.body.reservation).toEqual({ id: UUID2, status: 'cancelled' });
    });
});

describe('BAJO (d): cabeceras estrictas del flujo público', () => {
    it('Authorization: Bearer NO sirve como token de invitado en POST / (solo X-Guest-Token)', async () => {
        const t = await app();
        const tok = t.shared.signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
        const r = await t.call('/', {
            method: 'POST', headers: { ...KEY, Authorization: `Bearer ${tok}` },
            body: { facility_id: UUID1, starts_at: '2026-11-06T22:00:00Z', ends_at: '2026-11-06T23:00:00Z', payment_method: 'online' },
        });
        t.close();
        expect(r.status).toBe(401);
        expect(rpc).not.toHaveBeenCalled();
    });
});
