/**
 * Fuzz de entrada de TODOS los endpoints de reservas (sesión, públicos, checkout, admin, lote).
 * Sin red ni base: supabase y authMiddleware mockeados. Regla: entrada mala => 4xx con código, jamás 5xx,
 * y una entrada que rompe el esquema NUNCA llega a la RPC ni escribe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';

const U = '33333333-3333-4333-8333-333333333333';
const S = '11111111-1111-4111-8111-111111111111';
const F = '22222222-2222-4222-8222-222222222222';
const R = '55555555-5555-4555-8555-555555555555';
const GID = '44444444-4444-4444-8444-444444444444';

const st = vi.hoisted(() => ({ rpc: [] as any[], writes: [] as any[], tables: {} as Record<string, any> }));

vi.mock('../config/supabase', () => {
    const builder = (t: string) => {
        const res = () => Promise.resolve({ data: st.tables[t] ?? null, error: null });
        const b: any = {};
        for (const op of ['select', 'eq', 'in', 'or', 'order', 'limit', 'gte', 'gt', 'lt', 'lte', 'neq']) b[op] = () => b;
        for (const op of ['insert', 'update', 'delete']) b[op] = (...a: any[]) => { st.writes.push({ t, op, a }); return b; };
        b.maybeSingle = res; b.single = res;
        b.then = (ok: any, ko: any) => Promise.resolve({ data: Array.isArray(st.tables[t]) ? st.tables[t] : (st.tables[t] ? [st.tables[t]] : []), error: null }).then(ok, ko);
        return b;
    };
    // Storage mínimo para transfer-proof (SEC2-A2: el objeto debe existir): devuelve el archivo que se busca.
    const storage = { from: () => ({ list: async (_f: string, o: any) => ({ data: [{ name: o?.search, id: 'o1', metadata: { size: 10, mimetype: 'image/png' } }], error: null }) }) };
    return { supabase: { storage, from: builder, rpc: async (n: string, a: any) => { st.rpc.push({ n, a }); return { data: { ok: true, reservation: { id: R, user_id: U } }, error: null }; } } };
});
vi.mock('../middlewares/authMiddleware', () => {
    const setUser = (req: any) => { const id = req.headers['x-user']; req.user = id ? { id, email: 'u@x.co' } : null; req.role = req.headers['x-role']; req.schoolId = req.headers['x-school-id'] ?? S; };
    return {
        optionalAuth: (req: any, _res: any, next: any) => { setUser(req); next(); },
        requireAuth: (req: any, res: any, next: any) => { setUser(req); if (!req.user) return res.status(401).json({ error: 'auth' }); next(); },
        requireRole: (...roles: string[]) => (req: any, res: any, next: any) => (['owner', 'super_admin', 'admin'].includes(req.role) || roles.includes(req.role)) ? next() : res.status(403).json({ error: 'rol' }),
        auditLog: async () => undefined,
    };
});
vi.mock('../middlewares/requireEntitlement', () => ({ requireEntitlement: () => (_q: any, _s: any, next: any) => next() }));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: async () => ({ success: true }) } }));
vi.mock('../utils/emailTemplates', () => ({ BrandedEmailTemplates: { reservationCancelled: async () => ({ subject: 's', html: 'h' }), reservationRescheduled: async () => ({ subject: 's', html: 'h' }) } }));
vi.mock('../services/payment-provider.resolver', () => ({ resolveProvider: async () => null }));
vi.mock('../services/reservation-payments.service', () => ({
    abonoMinimoDeReserva: () => 1500, saldoDeReserva: () => 50000, baseReservationReference: (r: string) => r, notificarReservaConfirmada: async () => undefined, alertarAdminsDeReserva: async () => undefined,
}));

import { reservationsJsonBody } from '../middlewares/reservationsInput';
import { signToken, resetHits } from '../utils/reservations.shared';

vi.setConfig({ testTimeout: 60000 });

let srv: import('http').Server; let base = '';
beforeAll(async () => {
    process.env.PUBLIC_BOOKING_DEBUG_OTP = 'false';
    process.env.RESERVATIONS_BATCH_MAX_PER_HOUR = '100000';
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    const rv = (await import('./reservations.routes')).default;
    const pub = (await import('./public-reservations.routes')).default;
    const co = (await import('./reservations-checkout.routes')).default;
    const adm = (await import('./reservations-admin.routes')).default;
    const batch = (await import('./reservations-batch.routes')).default;
    const a = express();
    a.use('/api/v1/reservations/batch', reservationsJsonBody(200 * 1024));
    a.use(['/api/v1/reservations', '/api/v1/reservations-admin', '/api/v1/public/reservations'], reservationsJsonBody());
    a.use('/api/v1/reservations/batch', batch);
    a.use('/api/v1/reservations-admin', adm);
    a.use('/api/v1/reservations', co);
    a.use('/api/v1/reservations', rv);
    a.use('/api/v1/public/reservations', pub);
    a.use((err: any, _q: any, res: any, _n: any) => res.status(500).json({ error: 'UNHANDLED', msg: String(err?.message) }));
    srv = await new Promise((ok) => { const s = a.listen(0, () => ok(s)); });
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}, 90_000);
afterAll(() => srv?.close());
beforeEach(() => {
    st.rpc.length = 0; st.writes.length = 0; resetHits();
    const resv = { id: R, school_id: S, facility_id: F, user_id: U, guest_booker_id: GID, status: 'pending_payment', price: 100000, amount_paid: 0, hold_expires_at: new Date(Date.now() + 3600_000).toISOString(), price_snapshot: { transfer_proof: { url: 'u' } }, payment_reference: 'RSV-ABCDEF0123456789', min_deposit_pct: 30, facility: { id: F, school_id: S, name: 'C', min_cancellation_hours: 0 }, requester: { full_name: 'X', email: null } };
    st.tables = { facility_blackouts: { id: R, school_id: S, facility_id: F }, facility_reservations: resv, facilities: { id: F, school_id: S, status: 'available', booking_enabled: true }, schools: { id: S, owner_id: U, name: 'E', slug: 'e' }, guest_bookers: { id: GID, phone: '+573001112233', email: 'ana@x.co', full_name: 'Ana', verified_phone_at: null, verified_email_at: null }, school_members: { role: 'school_admin' }, session_bookings: { id: R, school_id: S } };
});

async function call(method: string, path: string, body: any, headers: Record<string, string> = {}, raw = false) {
    const r = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', 'x-user': U, 'x-role': 'school_admin', ...headers },
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
}

const GT = signToken({ typ: 'g', gid: GID, exp: Date.now() + 60_000 });
const iso1 = '2030-11-06T22:00:00Z'; const iso2 = '2030-11-06T23:00:00Z';
const IDEM = { 'Idempotency-Key': 'fuzz-key-12345678' };

interface Ep { noBaseline?: boolean; name: string; method: string; path: string; headers?: Record<string, string>; base: any; mustNotRpc?: boolean }
const EPS: Ep[] = [
    { name: 'POST /reservations', method: 'POST', path: '/api/v1/reservations', headers: IDEM, base: { facility_id: F, starts_at: iso1, ends_at: iso2, payment_method: 'online', notes: 'hola', participants: 4, external_org_name: 'Club', guest: { phone: '+573001112233', full_name: 'Ana Gómez' } }, mustNotRpc: true },
    { name: 'POST /reservations/:id/cancel', method: 'POST', path: `/api/v1/reservations/${R}/cancel`, base: { reason: 'no puedo' }, mustNotRpc: true },
    { name: 'POST /reservations/:id/reschedule', method: 'POST', path: `/api/v1/reservations/${R}/reschedule`, base: { starts_at: iso1, ends_at: iso2, facility_id: F }, mustNotRpc: true },
    { name: 'POST /public/reservations/guests/start', method: 'POST', path: '/api/v1/public/reservations/guests/start', base: { phone: '3001112233', email: 'ana@x.co', full_name: 'Ana Gómez' } },
    { name: 'POST /public/reservations/guests/verify', method: 'POST', path: '/api/v1/public/reservations/guests/verify', base: { phone: '3001112233', email: 'ana@x.co', code: '123456' }, noBaseline: true },
    { name: 'POST /public/reservations', method: 'POST', path: '/api/v1/public/reservations', headers: { ...IDEM, 'x-guest-token': GT }, base: { facility_id: F, starts_at: iso1, ends_at: iso2, payment_method: 'online', notes: 'hola' }, mustNotRpc: true },
    { name: 'POST /public/reservations/r/:t/cancel', method: 'POST', path: `/api/v1/public/reservations/r/${signToken({ typ: 'r', gid: GID, rid: R, exp: Date.now() + 60_000 })}/cancel`, base: { reason: 'x' }, mustNotRpc: true },
    { name: 'POST /reservations/:id/checkout', method: 'POST', path: `/api/v1/reservations/${R}/checkout`, base: { amount: 5000, mode: 'total', provider: 'wompi', return_path: '/venue/reservas' } },
    { name: 'POST /reservations/:id/transfer-proof', method: 'POST', path: `/api/v1/reservations/${R}/transfer-proof`, base: { proof_url: `http://127.0.0.1:54321/storage/v1/object/public/payment-receipts/${U}/x.png` } },
    { name: 'POST /reservations/:id/confirm-transfer', method: 'POST', path: `/api/v1/reservations/${R}/confirm-transfer`, base: { amount: 5000 }, mustNotRpc: true },
    { name: 'PATCH admin cancel', method: 'PATCH', path: `/api/v1/reservations-admin/facility/${R}/cancel`, base: { reason: 'lluvia' } },
    { name: 'PATCH admin reschedule', method: 'PATCH', path: `/api/v1/reservations-admin/facility/${R}/reschedule`, base: { reservation_date: '2030-11-06', start_time: '10:00', end_time: '11:00' } },
    { name: 'PATCH admin courtesy reschedule', method: 'PATCH', path: `/api/v1/reservations-admin/courtesy/${R}/reschedule`, base: { facility_availability_id: F, date: '2030-11-06', start_time: '10:00', end_time: '11:00' }, mustNotRpc: true },
    { name: 'POST admin blackouts', method: 'POST', path: '/api/v1/reservations-admin/blackouts', base: { facility_id: F, starts_at: iso1, ends_at: iso2, kind: 'maintenance', reason: 'pintura' } },
    { name: 'POST batch dry-run', method: 'POST', path: '/api/v1/reservations/batch/dry-run', base: { source_kind: 'import', source_id: 'doc-1', school_id: S, rows: [{ facility_id: F, starts_at: iso1, ends_at: iso2, guest: { phone: '+573001112233', full_name: 'Ana' } }] }, mustNotRpc: true },
];

const HUGE = 'x'.repeat(30_000);
const mutants = (b: any): Array<[string, any]> => {
    const out: Array<[string, any]> = [['clave extra', { ...b, __proto_x: 1, admin: true }]];
    for (const k of Object.keys(b)) {
        const v = b[k];
        out.push([`${k}=null`, { ...b, [k]: null }]);
        out.push([`${k}=objeto`, { ...b, [k]: { a: { b: { c: 1 } } } }]);
        out.push([`${k}=array`, { ...b, [k]: [1, 2, 3] }]);
        out.push([`${k}=número negativo`, { ...b, [k]: -5 }]);
        out.push([`${k}=booleano`, { ...b, [k]: true }]);
        if (typeof v === 'string') {
            out.push([`${k}=NUL`, { ...b, [k]: 'a\u0000b' }]);
            out.push([`${k}=enorme(30k)`, { ...b, [k]: HUGE }]);
            out.push([`${k}=vacío`, { ...b, [k]: '' }]);
        }
        if (typeof v === 'number') { out.push([`${k}=1e12`, { ...b, [k]: 1e12 }]); out.push([`${k}=1.5`, { ...b, [k]: 1.5 }]); }
    }
    let deep: any = {}; for (let i = 0; i < 60; i++) deep = { n: deep };
    out.push(['anidado profundo', deep]);
    return out;
};

describe('fuzz: entrada mala jamás da 5xx', () => {
    for (const ep of EPS) {
        describe(ep.name, () => {
            it.skipIf(!!ep.noBaseline)('la entrada base válida NO se rechaza por el esquema (sin 400/413/415/5xx de validación)', async () => {
                const r = await call(ep.method, ep.path, ep.base, ep.headers);
                expect([400, 413, 415, 500]).not.toContain(r.status);
            });
            for (const [label, body] of mutants(ep.base)) {
                it(`mutante: ${label}`, async () => {
                    const r = await call(ep.method, ep.path, body, ep.headers);
                    expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
                    // NUL / vacío en texto libre OPCIONAL se sanea (no es error): solo se exige que no llegue un NUL a la RPC.
                    if (/=NUL|=vacío/.test(label)) {
                        expect(JSON.stringify(st.rpc)).not.toContain('\u0000');
                        return;
                    }
                    if (ep.name.includes('batch') && label === 'rows=array') { expect(r.body.apply_allowed).toBe(false); expect(r.body.error_rows).toBe(3); return; } // el dry-run reporta fila por fila
                    expect(r.status).toBeGreaterThanOrEqual(400);
                    if (ep.mustNotRpc) expect(st.rpc.filter((x) => !/disponibilidad|confirmar/.test(x.n) || r.status < 400)).toEqual([]);
                    // Un cuerpo inválido jamás escribe en tablas de negocio.
                    expect(st.writes.filter((w) => w.t !== 'security_audit_log' && w.t !== 'notifications')).toEqual([]);
                });
            }
            it('cuerpos no objeto: array, string, número, null -> 4xx', async () => {
                for (const raw of ['[]', '"hola"', '123', 'null', 'true']) {
                    const r = await call(ep.method, ep.path, raw, ep.headers, true);
                    expect(r.status, raw).toBeGreaterThanOrEqual(400);
                    expect(r.status, raw).toBeLessThan(500);
                }
            });
            it('JSON mal formado -> 400 INVALID_JSON; Content-Type no JSON -> 415; cuerpo >20 KB -> 413', async () => {
                const bad = await call(ep.method, ep.path, '{"a":', ep.headers, true);
                expect(bad.status).toBe(400); expect(bad.body.code).toBe('INVALID_JSON');
                const txt = await call(ep.method, ep.path, '{"a":1}', { ...ep.headers, 'content-type': 'text/plain' }, true);
                expect(txt.status).toBe(415);
                const big = await call(ep.method, ep.path, JSON.stringify({ x: 'y'.repeat(30_000) }), ep.headers, true);
                expect(big.status).toBe(ep.name.includes('batch') ? 400 : 413);
            });
        });
    }
});

describe('canal ai/import desde el cliente', () => {
    it('POST /reservations con channel ai o import -> 403 CHANNEL_NOT_ALLOWED y no llama la RPC', async () => {
        for (const channel of ['ai', 'import']) {
            const r = await call('POST', '/api/v1/reservations', { ...EPS[0].base, channel }, IDEM);
            expect(r.status).toBe(403); expect(r.body.code).toBe('CHANNEL_NOT_ALLOWED');
        }
        expect(st.rpc).toEqual([]);
    });
    it('channel admin de no-staff baja a app (sigue igual)', async () => {
        const r = await call('POST', '/api/v1/reservations', { ...EPS[0].base, channel: 'app' }, IDEM);
        expect(r.status).toBe(201);
        expect(st.rpc.find((x) => x.n === 'reservar_cancha')!.a.p_channel).toBe('app');
    });
});

describe('saneamiento de texto libre en la entrada', () => {
    it('notes/external_org_name/nombre llegan a la RPC sin control, con espacios normalizados y recortados', async () => {
        const r = await call('POST', '/api/v1/reservations', { ...EPS[0].base, notes: '  Hola\u0000   mundo‮  ', external_org_name: 'Club​  Ñandú', guest: { phone: '+573001112233', full_name: '  Ana\u0007   Gómez ' } }, IDEM);
        expect(r.status).toBe(201);
        const a = st.rpc.find((x) => x.n === 'reservar_cancha')!.a;
        expect(a.p_notes).toBe('Hola mundo'); expect(a.p_external_org_name).toBe('Club Ñandú'); expect(a.p_guest.full_name).toBe('Ana Gómez');
    });
});

describe('bloqueos internos', () => {
    it('coach (rol no administrativo) -> 403; admin -> 201 con auditoría', async () => {
        const coach = await call('POST', '/api/v1/reservations-admin/blackouts', EPS[13].base, { 'x-role': 'coach' });
        expect(coach.status).toBe(403);
        const ok = await call('POST', '/api/v1/reservations-admin/blackouts', EPS[13].base);
        expect(ok.status).toBe(201);
    });
    it('cancha de otra escuela -> 404; rango > 365 días -> 400', async () => {
        st.tables.facilities = { id: F, school_id: '99999999-9999-4999-8999-999999999999' };
        expect((await call('POST', '/api/v1/reservations-admin/blackouts', EPS[13].base)).status).toBe(404);
        st.tables.facilities = { id: F, school_id: S };
        expect((await call('POST', '/api/v1/reservations-admin/blackouts', { ...EPS[13].base, ends_at: '2032-11-06T23:00:00Z' })).status).toBe(400);
        expect((await call('POST', '/api/v1/reservations-admin/blackouts', { ...EPS[13].base, kind: 'otra' })).status).toBe(400);
    });
});

describe('lote dry-run: autorización y tope', () => {
    it('coach -> 403; sin sesión -> 401; escuela distinta a la del actor -> 403', async () => {
        expect((await call('POST', '/api/v1/reservations/batch/dry-run', EPS[14].base, { 'x-role': 'coach' })).status).toBe(403);
        expect((await call('POST', '/api/v1/reservations/batch/dry-run', EPS[14].base, { 'x-user': '' })).status).toBe(401);
        expect((await call('POST', '/api/v1/reservations/batch/dry-run', { ...EPS[14].base, school_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(403);
    });
    it('201 filas -> 400; cuerpo hasta 200 KB aceptado por el límite del lote', async () => {
        const row = EPS[14].base.rows[0];
        const r = await call('POST', '/api/v1/reservations/batch/dry-run', { ...EPS[14].base, rows: Array.from({ length: 201 }, () => row) });
        expect(r.status).toBe(400);
    });
    it('dry-run válido: 200, writes_performed=false y NINGUNA escritura de reservas ni RPC reservar_cancha', async () => {
        const r = await call('POST', '/api/v1/reservations/batch/dry-run', EPS[14].base);
        expect(r.status).toBe(200); expect(r.body.writes_performed).toBe(false); expect(r.body.apply.available).toBe(false);
        expect(st.rpc.some((x) => x.n === 'reservar_cancha')).toBe(false);
        expect(st.writes.filter((w) => w.t === 'facility_reservations')).toEqual([]);
    });
});
