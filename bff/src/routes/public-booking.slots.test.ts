/** GET /public/booking/slots respeta facilities.bookable_by: `members` no ofrece franjas a externos. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

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

vi.mock('../config/supabase', () => ({ supabase: { rpc: vi.fn(), from: (t: string) => builder(t) } }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./session-bookings', () => ({ listAvailableSessions: vi.fn(), bookSession: vi.fn(), cancelSessionBooking: vi.fn() }));

vi.setConfig({ testTimeout: 30000 });
const SCHOOL = '11111111-1111-4111-8111-111111111111';
const FAC = '22222222-2222-4222-8222-222222222222';

async function app() {
    vi.resetModules();
    const router = (await import('./public-booking.routes')).default;
    const a = express();
    a.use(express.json());
    a.use('/b', router);
    const srv = await new Promise<import('http').Server>((ok) => { const s = a.listen(0, () => ok(s)); });
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/b`;
    const get = async (path: string) => { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => null) }; };
    return { get, close: () => srv.close() };
}

beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(tableResult)) delete tableResult[k];
});

describe('GET /slots y bookable_by', () => {
    it('la consulta de la instalación filtra bookable_by public/both', async () => {
        const t = await app();
        tableResult.schools = { data: { id: SCHOOL }, error: null };
        tableResult.facilities = { data: { id: FAC, name: 'Cancha', school_id: SCHOOL, min_booking_advance_hours: 0 }, error: null };
        tableResult.facility_availability = { data: [], error: null };
        const r = await t.get(`/slots?school_id=${SCHOOL}&facility_id=${FAC}`); t.close();
        expect(r.status).toBe(200);
        expect(calls.find((c) => c.table === 'facilities' && c.op === 'in')!.args).toEqual(['bookable_by', ['public', 'both']]);
    });
    it('espacio solo `members` (la consulta no lo devuelve) -> 404 y no lee franjas', async () => {
        const t = await app();
        tableResult.schools = { data: { id: SCHOOL }, error: null };
        tableResult.facilities = { data: null, error: null };
        const r = await t.get(`/slots?school_id=${SCHOOL}&facility_id=${FAC}`); t.close();
        expect(r.status).toBe(404);
        expect(calls.some((c) => c.table === 'facility_availability')).toBe(false);
    });
    it('el listado de instalaciones de la escuela también filtra bookable_by', async () => {
        const t = await app();
        tableResult.schools = { data: { id: SCHOOL, name: 'C', slug: 'c' }, error: null };
        tableResult.facilities = { data: [], error: null };
        await t.get('/schools/c'); t.close();
        expect(calls.find((c) => c.table === 'facilities' && c.op === 'in')!.args).toEqual(['bookable_by', ['public', 'both']]);
    });
});
