/** SEG-31 F1: gate único del link /agendar-clase/:slug y limitador por IP real. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const tableResult: Record<string, { data: any; error: any; count?: number }> = {};
const calls: { table: string; op: string; args: any[] }[] = [];

function builder(table: string) {
    const res = () => Promise.resolve(tableResult[table] ?? { data: null, error: null, count: 0 });
    const b: any = {};
    for (const op of ['select', 'eq', 'in', 'or', 'order', 'limit', 'gte', 'insert', 'update']) {
        b[op] = (...args: any[]) => { calls.push({ table, op, args }); return b; };
    }
    b.maybeSingle = res;
    b.single = res;
    b.then = (ok: any, ko: any) => res().then(ok, ko);
    return b;
}

const sendMock = vi.fn();
const listMock = vi.fn();
vi.mock('../config/supabase', () => ({ supabase: { rpc: vi.fn(), from: (t: string) => builder(t) } }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: (...a: any[]) => sendMock(...a) } }));
vi.mock('./session-bookings', () => ({
    listAvailableSessions: (...a: any[]) => listMock(...a),
    bookSession: vi.fn(), cancelSessionBooking: vi.fn(),
}));

vi.setConfig({ testTimeout: 30000 });
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'tok-123';
const ENR = '33333333-3333-4333-8333-333333333333';

async function app() {
    vi.resetModules();
    const router = (await import('./public-booking.routes')).default;
    const a = express();
    a.use(express.json());
    a.use('/b', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = a.listen(0, () => ok(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/b`;
    const call = async (method: string, path: string, body?: any, headers: Record<string, string> = {}) => {
        const r = await fetch(base + path, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call, close: () => srv.close() };
}

function setSettings(enabled: boolean, selfService: boolean) {
    tableResult.school_trial_class_settings = { data: { enabled, self_service_enabled: selfService }, error: null };
}

function setVerif() {
    tableResult.public_booking_verifications = {
        data: {
            id: 'v1', school_id: SCHOOL, verified_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            resolved_kind: 'enrolled_unregistered', resolved_unregistered_id: 'u1',
            resolved_email: 'a@b.co', full_name: 'Ana', booking_token_used_at: null,
        },
        error: null,
    };
}

const DISABLED = { error: 'Esta escuela no tiene activo el agendamiento por este link.', reason: 'link_disabled' };

beforeEach(() => {
    calls.length = 0;
    sendMock.mockReset();
    listMock.mockReset();
    for (const k of Object.keys(tableResult)) delete tableResult[k];
});

describe('POST /trial-start-verification con escuela apagada', () => {
    const body = (email: string) => ({ school_id: SCHOOL, email, full_name: 'Ana' });

    async function expectClosed() {
        const t = await app();
        tableResult.profiles = { data: { id: 'p1' }, error: null };
        const withProfile = await t.call('POST', '/trial-start-verification', body('con@perfil.co'));
        tableResult.profiles = { data: null, error: null };
        const without = await t.call('POST', '/trial-start-verification', body('sin@perfil.co'));
        t.close();
        expect(withProfile.status).toBe(422);
        expect(withProfile.body).toEqual(DISABLED);
        expect(without).toEqual(withProfile);
        expect(calls.some((c) => c.table === 'public_booking_verifications')).toBe(false);
        expect(calls.some((c) => c.table === 'profiles')).toBe(false);
        expect(sendMock).not.toHaveBeenCalled();
    }

    it('enabled=false -> 422 link_disabled igual para cualquier correo', async () => {
        setSettings(false, true);
        await expectClosed();
    });
    it('self_service_enabled=false -> 422', async () => {
        setSettings(true, false);
        await expectClosed();
    });
    it('sin fila -> 422', async () => {
        await expectClosed();
    });
    it('school_id inválido -> 422 sin consultar settings', async () => {
        const t = await app();
        const r = await t.call('POST', '/trial-start-verification', { school_id: 'nope', email: 'a@b.co' });
        t.close();
        expect(r.status).toBe(422);
        expect(calls.some((c) => c.table === 'school_trial_class_settings')).toBe(false);
    });
    it('escuela encendida: el gate no corta (sigue a already_registered)', async () => {
        setSettings(true, true);
        tableResult.profiles = { data: { id: 'p1' }, error: null };
        const t = await app();
        const r = await t.call('POST', '/trial-start-verification', body('con@perfil.co'));
        t.close();
        expect(r.status).toBe(200);
        expect(r.body.scenario).toBe('already_registered');
    });
});

describe('rutas con booking_token y escuela apagada', () => {
    const routes: [string, string, string, any?][] = [
        ['available-for-enrollment', 'GET', `/available-for-enrollment?token=${TOKEN}`],
        ['my-bookings-for-enrollment', 'GET', `/my-bookings-for-enrollment?token=${TOKEN}`],
        ['hour-bank-balance-for-enrollment', 'GET', `/hour-bank-balance-for-enrollment?token=${TOKEN}&enrollment_id=${ENR}`],
        ['book-for-enrollment', 'POST', '/book-for-enrollment', { booking_token: TOKEN, session_id: 's', enrollment_id: ENR }],
        ['cancel-for-enrollment', 'POST', '/cancel-for-enrollment', { booking_token: TOKEN, booking_id: 'b' }],
        ['register-unregistered', 'POST', '/register-unregistered', { booking_token: TOKEN }],
        ['trial-slots', 'GET', `/trial-slots?token=${TOKEN}&category_id=c&from=2026-11-01&to=2026-11-07`],
        ['trial-confirm', 'POST', '/trial-confirm', {
            token: TOKEN, category_id: 'c', facility_availability_id: 'f', coach_availability_id: 'k',
            date: '2026-11-10', start_time: '10:00', end_time: '11:00',
        }],
    ];

    it.each(routes)('%s -> 422 link_disabled con la escuela apagada', async (_n, method, path, body) => {
        setVerif();
        setSettings(true, false);
        const t = await app();
        const r = await t.call(method, path, body);
        t.close();
        expect(r.status).toBe(422);
        expect(r.body).toEqual(DISABLED);
    });

    it('sin fila de settings también cierra', async () => {
        setVerif();
        const t = await app();
        const r = await t.call('GET', `/available-for-enrollment?token=${TOKEN}`);
        t.close();
        expect(r.status).toBe(422);
        expect(r.body.reason).toBe('link_disabled');
        expect(listMock).not.toHaveBeenCalled();
    });

    it('escuela encendida: available-for-enrollment pasa el gate y llama al servicio', async () => {
        setVerif();
        setSettings(true, true);
        listMock.mockResolvedValue({ sessions: [] });
        const t = await app();
        const r = await t.call('GET', `/available-for-enrollment?token=${TOKEN}`);
        t.close();
        expect(r.status).toBe(200);
        expect(listMock).toHaveBeenCalledWith({ unregisteredAthleteId: 'u1' });
    });

    it('escuela encendida: trial-slots pasa el gate (llega al RPC, no 422)', async () => {
        setVerif();
        setSettings(true, true);
        const t = await app();
        const r = await t.call('GET', `/trial-slots?token=${TOKEN}&category_id=c&from=2026-11-01&to=2026-11-07`);
        t.close();
        expect(r.status).not.toBe(422);
    });
});

describe('error de la consulta de settings -> 500, no link_disabled', () => {
    beforeEach(() => {
        tableResult.school_trial_class_settings = { data: null, error: { message: 'boom' } };
    });
    it('/trial-start-verification', async () => {
        const t = await app();
        const r = await t.call('POST', '/trial-start-verification', { school_id: SCHOOL, email: 'a@b.co' });
        t.close();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBeUndefined();
    });
    it('/available-for-enrollment (vía resolveUnregisteredIdentity)', async () => {
        setVerif();
        const t = await app();
        const r = await t.call('GET', `/available-for-enrollment?token=${TOKEN}`);
        t.close();
        expect(r.status).toBe(500);
        expect(r.body.reason).toBeUndefined();
    });
    it('/trial-slots y /register-unregistered', async () => {
        setVerif();
        const t = await app();
        const a = await t.call('GET', `/trial-slots?token=${TOKEN}&category_id=c&from=2026-11-01&to=2026-11-07`);
        const b = await t.call('POST', '/register-unregistered', { booking_token: TOKEN });
        t.close();
        expect(a.status).toBe(500);
        expect(b.status).toBe(500);
    });
});

describe('regresión: el gate no toca el flujo /agendar/:slug ni la validación previa', () => {
    it('con la escuela apagada, /start-verification, /slots y /confirm no responden link_disabled', async () => {
        setSettings(false, false);
        const t = await app();
        const rs = [
            await t.call('POST', '/start-verification', { school_id: SCHOOL, email: 'a@b.co' }),
            await t.call('GET', `/slots?school_id=${SCHOOL}&facility_id=${ENR}`),
            await t.call('POST', '/confirm', { booking_token: TOKEN }),
        ];
        t.close();
        for (const r of rs) expect(r.body?.reason).not.toBe('link_disabled');
        expect(calls.some((c) => c.table === 'school_trial_class_settings')).toBe(false);
    });
    it('/trial-start-verification: sin campos o correo inválido da 400, no 422', async () => {
        const t = await app();
        const noFields = await t.call('POST', '/trial-start-verification', {});
        const noEmail = await t.call('POST', '/trial-start-verification', { school_id: SCHOOL });
        const badEmail = await t.call('POST', '/trial-start-verification', { school_id: SCHOOL, email: 'no-es-correo' });
        t.close();
        expect([noFields.status, noEmail.status, badEmail.status]).toEqual([400, 400, 400]);
        expect(calls.some((c) => c.table === 'school_trial_class_settings')).toBe(false);
    });
});

describe('GET /schools/:slug trial_link_enabled', () => {
    async function get(enabled: boolean, selfService: boolean) {
        tableResult.schools = { data: { id: SCHOOL, name: 'C', slug: 'c' }, error: null };
        tableResult.facilities = { data: [], error: null };
        setSettings(enabled, selfService);
        tableResult.trial_class_categories = { data: [], error: null };
        const t = await app();
        const r = await t.call('GET', '/schools/c');
        t.close();
        return r;
    }
    it('true cuando enabled y self_service', async () => {
        expect((await get(true, true)).body.trial_link_enabled).toBe(true);
    });
    it('false si falta alguno', async () => {
        expect((await get(true, false)).body.trial_link_enabled).toBe(false);
        expect((await get(false, true)).body.trial_link_enabled).toBe(false);
    });
    it('false sin fila', async () => {
        tableResult.schools = { data: { id: SCHOOL, name: 'C', slug: 'c' }, error: null };
        const t = await app();
        const r = await t.call('GET', '/schools/c');
        t.close();
        expect(r.body.trial_link_enabled).toBe(false);
    });
});

describe('otpStartLimiter usa la IP real (cf-connecting-ip)', () => {
    it('cuenta por separado por cabecera y el 6.º del mismo cf da 429', async () => {
        const t = await app();
        const hit = (ip: string) => t.call('POST', '/trial-start-verification', {}, { 'cf-connecting-ip': ip });
        for (let i = 0; i < 5; i++) expect((await hit('9.9.9.1')).status).toBe(400);
        expect((await hit('9.9.9.1')).status).toBe(429);
        // misma req.ip (127.0.0.1), otro cf-connecting-ip: cupo propio
        expect((await hit('9.9.9.2')).status).toBe(400);
        t.close();
    });
});
