/**
 * SEG-33: confirmaciones y encuestas de asistencia atadas a la escuela.
 * Pasa por las rutas reales (polls.ts, attendance.ts) con requireRole real;
 * Supabase en memoria cuyos .eq/.neq/.in SÍ filtran. Cero red, cero base.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const A = 'school-a';
const B = 'school-b';
const U_MIEMBRO_A = '11111111-1111-4111-8111-111111111111';
const U_MIEMBRO_B = '22222222-2222-4222-8222-222222222222';
const U_INACTIVO_A = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    writes: [] as { op: 'insert' | 'update' | 'delete'; table: string; payload?: any }[],
    rpcCalls: [] as { fn: string; args: any }[],
    embeddedFilters: [] as { table: string; op: string; column: string; value: any }[],
    rpcResult: { cancelled: true, credit_returned: true } as any,
    seq: 0,
}));

vi.mock('../config/supabase', () => {
    function builder(table: string) {
        const filters: ((r: any) => boolean)[] = [];
        let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';
        let payload: any = null;
        let head = false;
        const rows = () => (db.tables[table] ??= []);
        const matching = () => rows().filter((r) => filters.every((f) => f(r)));
        const api: any = {};
        api.select = (_c?: string, opts?: any) => { if (opts?.head) head = true; return api; };
        api.eq = (c: string, v: any) => {
            if (c.includes('.')) db.embeddedFilters.push({ table, op: 'eq', column: c, value: v });
            else filters.push((r) => r[c] === v);
            return api;
        };
        api.neq = (c: string, v: any) => {
            if (c.includes('.')) db.embeddedFilters.push({ table, op: 'neq', column: c, value: v });
            else filters.push((r) => r[c] !== v);
            return api;
        };
        api.in = (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return api; };
        for (const op of ['order', 'limit', 'not', 'gte', 'lte']) api[op] = () => api;
        api.update = (p: any) => { mode = 'update'; payload = p; return api; };
        api.delete = () => { mode = 'delete'; return api; };
        api.insert = (p: any) => { mode = 'insert'; payload = p; return api; };
        const run = () => {
            if (mode === 'insert') {
                const row = { id: `new-${++db.seq}`, ...payload };
                rows().push(row);
                db.writes.push({ op: 'insert', table, payload });
                return [row];
            }
            const hit = matching();
            if (mode === 'update') {
                db.writes.push({ op: 'update', table, payload });
                hit.forEach((r) => Object.assign(r, payload));
            }
            if (mode === 'delete') {
                db.writes.push({ op: 'delete', table });
                db.tables[table] = rows().filter((r) => !hit.includes(r));
            }
            return hit;
        };
        api.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
        api.single = async () => {
            const r = run()[0];
            return r ? { data: r, error: null } : { data: null, error: { message: 'no rows' } };
        };
        api.then = (ok: any, ko: any) => {
            const r = run();
            return Promise.resolve({ data: head ? null : r, count: r.length, error: null }).then(ok, ko);
        };
        return api;
    }
    return {
        SUPABASE_URL: 'https://mock.supabase.co',
        SUPABASE_ANON_KEY: 'x',
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (fn: string, args: any) => {
                db.rpcCalls.push({ fn, args });
                if (fn === 'cancel_session_booking_with_credit' && db.rpcResult.cancelled) {
                    const b = db.tables.session_bookings.find((r) => r.id === args.p_booking_id);
                    if (b) b.status = 'cancelled';
                }
                return { data: fn === 'cancel_session_booking_with_credit' ? db.rpcResult : { marked: 0 }, error: null };
            },
        },
    };
});

const audit = vi.hoisted(() => ({ calls: [] as any[], logError: [] as any[] }));
vi.mock('../middlewares/authMiddleware', async (orig) => {
    const real = await orig<typeof import('../middlewares/authMiddleware')>();
    return {
        ...real,
        // Sesión simulada por cabeceras de prueba; requireRole es el real.
        requireAuth: (req: any, res: any, next: any) => {
            if (!req.headers.authorization?.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Token de autorización requerido.' });
            }
            req.user = { id: 'caller' };
            req.role = req.headers['x-test-role'];
            req.schoolId = req.headers['x-test-school'] ?? '';
            req.log = { error: (...a: any[]) => { audit.logError.push(a); } };
            next();
        },
        auditLog: async (...args: any[]) => { audit.calls.push(args); },
    };
});

import pollsRouter from '../routes/polls';
import attendanceRouter from '../routes/attendance';

let server: Server;
let base: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/polls', pollsRouter);
    app.use('/api/v1/attendance', attendanceRouter);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => { server.close(); });

function seed() {
    db.tables = {
        attendance_polls: [
            { id: 'pA', school_id: A, status: 'open' },
            { id: 'pA2', school_id: A, status: 'open' },
            { id: 'pB', school_id: B, status: 'open' },
        ],
        attendance_sessions: [
            { id: 'sA', poll_id: 'pA', school_id: A, max_capacity: 10, finalized: false, team_id: null, offering_id: null },
            { id: 'sOtraDeA', poll_id: 'pA2', school_id: A, max_capacity: 10, finalized: false, team_id: null, offering_id: null },
            { id: 'sB', poll_id: 'pB', school_id: B, max_capacity: 10, finalized: false, team_id: null, offering_id: null },
        ],
        session_bookings: [
            { id: 'bA', session_id: 'sA', school_id: A, status: 'confirmed', user_id: null, child_id: null,
              unregistered_athlete_id: 'uaA', hour_bank_reservation_id: null, credit_enrollment_id: 'enA' },
            { id: 'bB', session_id: 'sB', school_id: B, status: 'confirmed', user_id: U_MIEMBRO_B, child_id: null,
              unregistered_athlete_id: null, hour_bank_reservation_id: null },
        ],
        school_members: [
            { profile_id: U_MIEMBRO_A, school_id: A, status: 'active' },
            { profile_id: U_MIEMBRO_B, school_id: B, status: 'active' },
            { profile_id: U_INACTIVO_A, school_id: A, status: 'inactive' },
        ],
        unregistered_athletes: [],
    };
}

beforeEach(() => {
    seed();
    db.writes = []; db.rpcCalls = []; db.embeddedFilters = []; db.seq = 0;
    db.rpcResult = { cancelled: true, credit_returned: true };
    audit.calls = []; audit.logError = [];
});

function call(method: string, path: string, opts: { role?: string; school?: string | null; body?: unknown; auth?: boolean } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.auth !== false) headers.authorization = 'Bearer t';
    if (opts.role) headers['x-test-role'] = opts.role;
    if (opts.school !== null) headers['x-test-school'] = opts.school ?? A;
    return fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const coachA = { role: 'coach', school: A };
const adminA = { role: 'school_admin', school: A };
const writesTo = (table: string) => db.writes.filter((w) => w.table === table);

describe('DELETE confirmación (H2)', () => {
    it('1. reserva de otra escuela bajo una sesión propia: 404 sin RPC ni escrituras', async () => {
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bB', coachA);
        expect(r.status).toBe(404);
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.writes).toHaveLength(0);
    });
    it('2. encuesta ajena: 404', async () => {
        const r = await call('DELETE', '/polls/pB/sessions/sB/confirmations/bB', coachA);
        expect(r.status).toBe(404);
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.tables.session_bookings.find((b) => b.id === 'bB')!.status).toBe('confirmed');
    });
    it('3. sesión de A que no es de esa encuesta: 404', async () => {
        const r = await call('DELETE', '/polls/pA/sessions/sOtraDeA/confirmations/bA', adminA);
        expect(r.status).toBe(404);
        expect(db.rpcCalls).toHaveLength(0);
    });
    it('4. propia: 204, RPC con SOLO la identidad de la fila y sin delete()', async () => {
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', adminA);
        expect(r.status).toBe(204);
        expect(db.rpcCalls).toEqual([{ fn: 'cancel_session_booking_with_credit', args: {
            p_booking_id: 'bA', p_user_id: null, p_child_id: null, p_unregistered_athlete_id: 'uaA',
        } }]);
        expect(db.writes.filter((w) => w.op === 'delete')).toHaveLength(0);
        expect(audit.calls.map((c) => c[1])).toContain('poll_confirmation_cancelled');
    });
    it('5. crédito devuelto: 204 y sin log de crédito faltante', async () => {
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', adminA);
        expect(r.status).toBe(204);
        expect(audit.logError).toHaveLength(0);
        expect(db.tables.session_bookings.find((b) => b.id === 'bA')!.status).toBe('cancelled');
    });
    it('6. la RPC rechaza (clase pasada): 400 con reason', async () => {
        db.rpcResult = { cancelled: false, reason: 'session_in_the_past' };
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', adminA);
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'Esta clase ya pasó y no se puede cancelar.', reason: 'session_in_the_past' });
    });
    it('7. reserva ya cancelada: 400 sin RPC', async () => {
        db.tables.session_bookings[0].status = 'cancelled';
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', adminA);
        expect(r.status).toBe(400);
        expect(db.rpcCalls).toHaveLength(0);
    });
});

describe('POST confirmación manual (H3)', () => {
    it('8. sesión de otra escuela: 404 sin insert', async () => {
        const r = await call('POST', '/polls/pA/sessions/sB/confirmations', { ...coachA, body: { guest_name: 'Invitado Prueba' } });
        expect(r.status).toBe(404);
        expect(db.writes).toHaveLength(0);
    });
    it('9. session_id del cuerpo distinto al de la URL: 400 sin insert', async () => {
        const r = await call('POST', '/polls/pA/sessions/sA/confirmations', { ...coachA, body: { session_id: 'sB', guest_name: 'Invitado Prueba' } });
        expect(r.status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
    it('10. invitado como lo manda la UI (sin session_id en el cuerpo): 201 en la escuela de la sesión', async () => {
        const r = await call('POST', '/polls/pA/sessions/sA/confirmations', { ...adminA, body: { guest_name: 'Invitado Prueba', enrollment_id: 'ignorado' } });
        expect(r.status).toBe(201);
        const guest = writesTo('unregistered_athletes')[0].payload;
        expect(guest).toMatchObject({ full_name: 'Invitado Prueba', school_id: A });
        const bk = writesTo('session_bookings')[0].payload;
        expect(bk).toMatchObject({ school_id: A, session_id: 'sA', status: 'confirmed' });
        expect(bk).not.toHaveProperty('enrollment_id');
        expect(bk).not.toHaveProperty('user_id');
    });
    it('11. user_id sin membresía activa en A (inactivo o de B): 404 sin insert', async () => {
        for (const uid of [U_INACTIVO_A, U_MIEMBRO_B]) {
            const r = await call('POST', '/polls/pA/sessions/sA/confirmations', { ...adminA, body: { user_id: uid } });
            expect(r.status).toBe(404);
        }
        expect(db.writes).toHaveLength(0);
    });
    it('12. user_id miembro activo de A: 201; repetirlo da 409', async () => {
        const r = await call('POST', '/polls/pA/sessions/sA/confirmations', { ...coachA, body: { user_id: U_MIEMBRO_A } });
        expect(r.status).toBe(201);
        expect(writesTo('session_bookings')[0].payload).toMatchObject({ user_id: U_MIEMBRO_A, school_id: A, session_id: 'sA' });
        const r2 = await call('POST', '/polls/pA/sessions/sA/confirmations', { ...coachA, body: { user_id: U_MIEMBRO_A } });
        expect(r2.status).toBe(409);
    });
    it('user_id y guest_name a la vez, o ninguno: 400', async () => {
        expect((await call('POST', '/polls/pA/sessions/sA/confirmations', { ...adminA, body: { user_id: U_MIEMBRO_A, guest_name: 'X' } })).status).toBe(400);
        expect((await call('POST', '/polls/pA/sessions/sA/confirmations', { ...adminA, body: {} })).status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
});

describe('cerrar y borrar encuesta (H4, H5)', () => {
    it('13. cerrar encuesta ajena: 404 sin update', async () => {
        const r = await call('PATCH', '/polls/pB/close', coachA);
        expect(r.status).toBe(404);
        expect(db.writes).toHaveLength(0);
        expect(db.tables.attendance_polls.find((p) => p.id === 'pB')!.status).toBe('open');
    });
    it('14. borrar encuesta ajena: 404 sin delete', async () => {
        const r = await call('DELETE', '/polls/pB', coachA);
        expect(r.status).toBe(404);
        expect(db.writes).toHaveLength(0);
        expect(db.tables.attendance_polls.some((p) => p.id === 'pB')).toBe(true);
    });
    it('15. propia: cerrar 200 y borrar (sin reservas) 204', async () => {
        const c = await call('PATCH', '/polls/pA2/close', adminA);
        expect(c.status).toBe(200);
        expect((await c.json()).status).toBe('closed');
        const d = await call('DELETE', '/polls/pA2', adminA);
        expect(d.status).toBe(204);
        expect(db.tables.attendance_polls.some((p) => p.id === 'pA2')).toBe(false);
    });
    it('15b. propia con reservas: 400 sin delete', async () => {
        const d = await call('DELETE', '/polls/pA', adminA);
        expect(d.status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
});

describe('sesión y roles', () => {
    it('16. sin escuela en la sesión (super_admin sin cabecera): 400', async () => {
        const r = await call('PATCH', '/polls/pA/close', { role: 'super_admin', school: '' });
        expect(r.status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
    it('parent y athlete: 403; sin Bearer: 401', async () => {
        for (const role of ['parent', 'athlete']) {
            const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', { role, school: A });
            expect(r.status).toBe(403);
        }
        const r = await call('DELETE', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, auth: false });
        expect(r.status).toBe(401);
        expect(db.rpcCalls).toHaveLength(0);
    });
});

describe('PATCH confirmación (H1, P1 = b)', () => {
    it('17. estados fuera de la lista blanca: 400 sin update', async () => {
        for (const status of ['confirmed', 'cancelled', 'pending', 'foo', undefined]) {
            const r = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, body: { status } });
            expect(r.status).toBe(400);
        }
        expect(db.writes).toHaveLength(0);
    });
    it('17b. confirmed -> attended: 200; luego attended -> no_show: 400', async () => {
        const r = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, body: { status: 'attended' } });
        expect(r.status).toBe(200);
        expect(db.tables.session_bookings.find((b) => b.id === 'bA')!.status).toBe('attended');
        const r2 = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, body: { status: 'no_show' } });
        expect(r2.status).toBe(400);
        expect(db.tables.session_bookings.find((b) => b.id === 'bA')!.status).toBe('attended');
    });
    it('17c. confirmed -> no_show: 200', async () => {
        const r = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...coachA, body: { status: 'no_show' } });
        expect(r.status).toBe(200);
    });
    it('17d. cancelada no se revive ni se marca: 400', async () => {
        db.tables.session_bookings[0].status = 'cancelled';
        const r = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, body: { status: 'attended' } });
        expect(r.status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
    it('17e. reserva ajena o encuesta ajena: 404 sin update', async () => {
        expect((await call('PATCH', '/polls/pA/sessions/sA/confirmations/bB', { ...coachA, body: { status: 'attended' } })).status).toBe(404);
        expect((await call('PATCH', '/polls/pB/sessions/sB/confirmations/bB', { ...coachA, body: { status: 'attended' } })).status).toBe(404);
        expect(db.writes).toHaveLength(0);
        expect(db.tables.session_bookings.find((b) => b.id === 'bB')!.status).toBe('confirmed');
    });
    it('17f. session_id del cuerpo distinto: 400', async () => {
        const r = await call('PATCH', '/polls/pA/sessions/sA/confirmations/bA', { ...adminA, body: { status: 'attended', session_id: 'sB' } });
        expect(r.status).toBe(400);
        expect(db.writes).toHaveLength(0);
    });
});

describe('enlace público y resultados', () => {
    it('18. confirmAttendance: con una reserva previa cancelada se puede volver a confirmar', async () => {
        db.tables.session_bookings.push({ id: 'bOld', session_id: 'sA', school_id: A, status: 'cancelled', user_id: null,
            unregistered_athlete_id: 'uaTok' });
        db.tables.unregistered_athletes.push({ id: 'uaTok', poll_token: 'tok-1', school_id: A });
        // confirmAttendance lee la encuesta embebida en la sesión
        db.tables.attendance_sessions[0].poll = { id: 'pA', status: 'open' };
        const r = await call('POST', '/polls/pA/confirm', { auth: false, school: null,
            body: { session_id: 'sA', guest_name: 'Invitado Prueba', poll_token: 'tok-1' } });
        expect(r.status).toBe(201);
        // y con una reserva activa sigue siendo 409
        const r2 = await call('POST', '/polls/pA/confirm', { auth: false, school: null,
            body: { session_id: 'sA', guest_name: 'Invitado Prueba', poll_token: 'tok-1' } });
        expect(r2.status).toBe(409);
    });
    it('19. getPollResults filtra las reservas canceladas en la relación embebida', async () => {
        const r = await fetch(`${base}/polls/pA/results`, {
            headers: { authorization: 'Bearer t', 'x-test-role': 'school_admin', 'x-test-school': A, 'x-school-id': A },
        });
        expect(r.status).toBe(200);
        expect(db.embeddedFilters).toContainEqual({
            table: 'attendance_polls', op: 'neq', column: 'attendance_sessions.session_bookings.status', value: 'cancelled',
        });
    });
});

describe('PATCH /attendance/session/:id/finalize (H6)', () => {
    it('20. sesión de otra escuela: 404, sin update ni mark_session_absences', async () => {
        for (const role of ['coach', 'owner']) {
            const r = await call('PATCH', '/attendance/session/sB/finalize', { role, school: A });
            expect(r.status).toBe(404);
        }
        expect(db.writes).toHaveLength(0);
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.tables.attendance_sessions.find((s) => s.id === 'sB')!.finalized).toBe(false);
    });
    it('20b. sesión propia: 200 y finaliza', async () => {
        const r = await call('PATCH', '/attendance/session/sA/finalize', { role: 'school_admin', school: A });
        expect(r.status).toBe(200);
        expect(db.tables.attendance_sessions.find((s) => s.id === 'sA')!.finalized).toBe(true);
        expect(db.rpcCalls.map((c) => c.fn)).toEqual(['mark_session_absences']);
    });
});
