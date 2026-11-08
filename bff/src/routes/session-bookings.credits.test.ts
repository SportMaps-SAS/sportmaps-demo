/**
 * SEG-31 F3 (H1/H2): vencimiento y cupo al agendar, y devolución de crédito
 * al cancelar, delegados a las RPC book_session_with_credit /
 * cancel_session_booking_with_credit. Cero red: Supabase en memoria.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
    tables: {} as Record<string, any>,
    inserted: [] as { table: string; rows: Row[] }[],
    updated: [] as string[],
    rpcCalls: [] as { fn: string; args: any }[],
    rpcResult: {} as Record<string, any>,
    reads: {} as Record<string, number>,
    failFromRead: null as { table: string; n: number } | null,
}));

vi.mock('../config/supabase', () => {
    function builder(table: string) {
        const raw = () => db.tables[table] ?? null;
        const first = () => {
            const r = raw();
            return Array.isArray(r) ? (r[0] ?? null) : r;
        };
        const api: any = {};
        for (const op of ['select', 'eq', 'neq', 'in', 'not', 'gte', 'lte', 'order', 'limit', 'contains']) {
            api[op] = () => api;
        }
        api.insert = (r: any) => { db.inserted.push({ table, rows: [r] }); return api; };
        api.update = () => { db.updated.push(table); return api; };
        const read = () => {
            db.reads[table] = (db.reads[table] ?? 0) + 1;
            const f = db.failFromRead;
            if (f && f.table === table && db.reads[table] >= f.n) return { data: null, error: { message: 'boom' } };
            return { data: first(), error: null };
        };
        api.maybeSingle = async () => read();
        api.single = async () => read();
        api.then = (ok: any, ko: any) =>
            Promise.resolve({ data: raw() ?? [], error: null, count: 0 }).then(ok, ko);
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (fn: string, args: any) => {
                db.rpcCalls.push({ fn, args });
                const r = db.rpcResult[fn];
                return typeof r === 'function' ? r(args) : (r ?? { data: null, error: null });
            },
        },
    };
});
vi.mock('../services/bridgeWsHub', () => ({ wakeSchool: vi.fn() }));
vi.mock('./access-adms', () => ({
    invalidateDeviceCache: vi.fn(), invalidateMappingCache: vi.fn(),
    reprocessPinEventsForHourBank: vi.fn(async () => ({ reprocessed: 0 })), getHourBankSettings: vi.fn(),
}));

import { clearPlanDayRulesCache } from '../utils/planDayRules';
import sessionBookingsRouter, {
    bookSession, cancelSessionBooking, listAvailableSessions, precheckEnrollmentCredit,
    cancelRefusalBody, shouldLogMissingCredit, translateBookingRpcError,
} from './session-bookings';

function routeHandler(method: string, path: string) {
    const layer = (sessionBookingsRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    if (!layer) throw new Error('ruta no encontrada: ' + method + ' ' + path);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

const SCHOOL = 'school-1';
const ENR = 'enr-1';
const SESSION = 'sess-1';
const PAST = '2020-01-01';
const FUTURE = '2099-12-31';

function fakeRes() {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
}

function enrollment(over: Row = {}, plan: Row = {}): Row {
    return {
        id: ENR, user_id: 'u1', child_id: null, unregistered_athlete_id: null, school_id: SCHOOL,
        status: 'active', expires_at: FUTURE, sessions_used: 0, secondary_sessions_used: 0,
        offering_plans: {
            max_sessions: 8, max_secondary_sessions: 2, included_minutes_per_period: null, ...plan,
        },
        ...over,
    };
}

const rpcCalled = (fn: string) => db.rpcCalls.filter((c) => c.fn === fn);
const log = { error: vi.fn() };
const req = { log } as any;

beforeEach(() => {
    clearPlanDayRulesCache();
    log.error.mockReset();
    db.inserted = [];
    db.updated = [];
    db.rpcCalls = [];
    db.reads = {};
    db.failFromRead = null;
    db.rpcResult = {
        book_session_with_credit: { data: { id: 'bk-1', session_id: SESSION }, error: null },
        reserve_hour_bank: { data: { reserved: true, reservation_id: 'hb-1' }, error: null },
    };
    db.tables = {
        enrollments: enrollment(),
        offering_plans: [],
        attendance_sessions: { school_id: SCHOOL, max_capacity: 10, current_bookings: 0, session_date: FUTURE, start_time: '10:00:00', end_time: '11:00:00' },
        session_bookings: null,
    };
});

describe('bookSession: prechequeo de vencimiento y cupo', () => {
    it('plan vencido: 422 plan_expired sin RPC ni mutaciones', async () => {
        db.tables.enrollments = enrollment({ expires_at: PAST });
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: 'avail_p_abc_2099-01-05', enrollment_id: ENR });
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({ error: 'Tu plan venció el 01/01/2020.', reason: 'plan_expired' });
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.inserted).toHaveLength(0);
        expect(db.updated).toHaveLength(0);
    });

    it('inscripción vencida también corta en plan de horas y para hijo y ficha sin cuenta', async () => {
        db.tables.enrollments = enrollment({ expires_at: PAST, child_id: 'c1', user_id: null }, { included_minutes_per_period: 600 });
        const res = fakeRes();
        await bookSession(req, res, { childId: 'c1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.body?.reason).toBe('plan_expired');

        db.tables.enrollments = enrollment({ expires_at: PAST, user_id: null, unregistered_athlete_id: 'ua1' });
        const res2 = fakeRes();
        await bookSession(req, res2, { unregisteredAthleteId: 'ua1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res2.body?.reason).toBe('plan_expired');
    });

    it('sin cupo: 422 no_credits', async () => {
        db.tables.enrollments = enrollment({ sessions_used: 8 });
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({ error: 'Ya usaste las 8 clases de tu plan.', reason: 'no_credits' });
        expect(rpcCalled('book_session_with_credit')).toHaveLength(0);
    });

    it('plan de horas sin cupos: no aplica no_credits', () => {
        const own = {
            valid: true, expiresAt: FUTURE, sessionsUsed: 99, secondarySessionsUsed: 0,
            plan: { max_sessions: 8, max_secondary_sessions: null, included_minutes_per_period: 600 },
        };
        expect(precheckEnrollmentCredit(own, false)).toBeNull();
    });

    const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    it.each([
        ['expires_at = hoy no vence', TODAY, 0, 8, null],
        ['expires_at = ayer vence', '2000-01-01', 0, 8, 'plan_expired'],
        ['max_sessions null es ilimitado', null, 500, null, null],
        ['used = max-1 pasa', null, 7, 8, null],
        ['used = max no pasa', null, 8, 8, 'no_credits'],
    ])('casos limite: %s', (_n, expiresAt, used, max, expected) => {
        const own = {
            valid: true, expiresAt, sessionsUsed: used, secondarySessionsUsed: 0,
            plan: { max_sessions: max, max_secondary_sessions: null, included_minutes_per_period: null },
        };
        expect(precheckEnrollmentCredit(own, false)?.reason ?? null).toBe(expected);
    });

    it('secundaria respeta su propia bolsa', () => {
        const own = {
            valid: true, expiresAt: null, sessionsUsed: 8, secondarySessionsUsed: 0,
            plan: { max_sessions: 8, max_secondary_sessions: 2, included_minutes_per_period: null },
        };
        expect(precheckEnrollmentCredit(own, false)?.reason).toBe('no_credits');
        expect(precheckEnrollmentCredit(own, true)).toBeNull();
        expect(precheckEnrollmentCredit({ ...own, secondarySessionsUsed: 2 }, true)?.reason).toBe('no_credits');
    });
});

describe('bookSession: RPC book_session_with_credit', () => {
    it('éxito: usa la fila de la RPC y no inserta ni mueve crédito por su cuenta', async () => {
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR, is_secondary: true });
        expect(res.statusCode).toBe(201);
        expect(res.body.booking).toEqual({ id: 'bk-1', session_id: SESSION });
        const calls = rpcCalled('book_session_with_credit');
        expect(calls).toHaveLength(1);
        expect(calls[0].args).toMatchObject({
            p_school_id: SCHOOL, p_session_id: SESSION, p_enrollment_id: ENR, p_user_id: 'u1',
            p_child_id: null, p_unregistered_athlete_id: null, p_is_secondary: true, p_hour_bank_reservation_id: null,
        });
        expect(rpcCalled('move_session_credit')).toHaveLength(0);
        expect(db.inserted.filter((i) => i.table === 'session_bookings')).toHaveLength(0);
    });

    it('ficha sin cuenta pasa p_unregistered_athlete_id', async () => {
        db.tables.enrollments = enrollment({ user_id: null, unregistered_athlete_id: 'ua1' });
        const res = fakeRes();
        await bookSession(req, res, { unregisteredAthleteId: 'ua1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(201);
        expect(rpcCalled('book_session_with_credit')[0].args).toMatchObject({
            p_user_id: null, p_child_id: null, p_unregistered_athlete_id: 'ua1',
        });
    });

    it('plan_expired: de la RPC: 422 y compensa la reserva de banco de horas', async () => {
        db.tables.enrollments = enrollment({}, { included_minutes_per_period: 600 });
        db.rpcResult.book_session_with_credit = { data: null, error: { message: 'plan_expired: Tu plan venció el 01/11/2026.' } };
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(422);
        expect(res.body).toEqual({ error: 'Tu plan venció el 01/11/2026.', reason: 'plan_expired' });
        const cancels = rpcCalled('cancel_hour_bank_reservation');
        expect(cancels).toHaveLength(1);
        expect(cancels[0].args).toEqual({ p_reservation_id: 'hb-1' });
    });

    it('error sin prefijo "Sesión llena" sale como 409 capacity_full', async () => {
        db.rpcResult.book_session_with_credit = { data: null, error: { message: 'Sesión llena (10/10)' } };
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: 'Sesión llena (10/10)', reason: 'capacity_full' });
    });

    it('traduce los prefijos y reenvía el texto útil', () => {
        expect(translateBookingRpcError('enrollment_unauthorized: x')).toEqual({ status: 403, body: { error: 'enrollment_unauthorized' } });
        expect(translateBookingRpcError('no_credits: Ya usaste las 8 clases de tu plan.')).toEqual({
            status: 422, body: { error: 'Ya usaste las 8 clases de tu plan.', reason: 'no_credits' },
        });
        expect(translateBookingRpcError('plan_expired: Tu plan venció el 01/11/2026.').body.error).toBe('Tu plan venció el 01/11/2026.');
        expect(translateBookingRpcError('enrollment_not_active: La inscripción no está activa (estado: paused).').body.reason).toBe('enrollment_not_active');
        expect(translateBookingRpcError('plan_expired:').body.error).toBe('Tu plan venció.');
        expect(translateBookingRpcError('invalid_identity: x').status).toBe(422);
        expect(translateBookingRpcError('hour_bank_reservation_required: x')).toEqual({
            status: 409,
            body: { error: 'No pudimos reservar tus horas. Intenta de nuevo.', reason: 'hour_bank_reservation_required' },
        });
        expect(translateBookingRpcError('session_not_found: La sesión no existe')).toEqual({
            status: 404, body: { error: 'Clase no encontrada.', reason: 'session_not_found' },
        });
        expect(translateBookingRpcError('hour_bank_reservation_mismatch: x')).toEqual({
            status: 409,
            body: { error: 'No pudimos reservar tus horas. Intenta de nuevo.', reason: 'hour_bank_reservation_mismatch' },
        });
    });

    it('errores sin prefijo salen con reason', () => {
        expect(translateBookingRpcError('Sesión llena (10/10)')).toEqual({ status: 409, body: { error: 'Sesión llena (10/10)', reason: 'capacity_full' } });
        expect(translateBookingRpcError('No se puede reservar en una sesión ya finalizada').body.reason).toBe('session_finalized');
        expect(translateBookingRpcError('duplicate key value', '23505')).toEqual({
            status: 409, body: { error: 'Ya tienes una reserva activa para esta clase.', reason: 'already_booked' },
        });
        expect(translateBookingRpcError('El plan ha expirado el 2026-11-06')).toEqual({
            status: 422, body: { error: 'El plan ha expirado el 2026-11-06', reason: 'plan_expired' },
        });
        expect(translateBookingRpcError('algo raro')).toEqual({ status: 409, body: { error: 'algo raro' } });
    });

    it.each([
        ['session_not_found: x', 404],
        ['hour_bank_reservation_mismatch: x', 409],
        ['El plan ha expirado el 2026-11-06', 422],
    ])('%s compensa el banco de horas', async (message, status) => {
        db.tables.enrollments = enrollment({}, { included_minutes_per_period: 600 });
        db.rpcResult.book_session_with_credit = { data: null, error: { message } };
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(status);
        expect(rpcCalled('cancel_hour_bank_reservation')).toHaveLength(1);
    });

    it('23505 desde la RPC: 409 already_booked y compensa', async () => {
        db.tables.enrollments = enrollment({}, { included_minutes_per_period: 600 });
        db.rpcResult.book_session_with_credit = { data: null, error: { message: 'duplicate key', code: '23505' } };
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(409);
        expect(res.body.reason).toBe('already_booked');
        expect(rpcCalled('cancel_hour_bank_reservation')).toHaveLength(1);
    });
});

describe('bookSession: otros', () => {
    it('error leyendo el plan de la inscripcion: 500 y no llama a la RPC', async () => {
        db.failFromRead = { table: 'enrollments', n: 2 };
        const res = fakeRes();
        await bookSession(req, res, { userId: 'u1' }, { session_id: SESSION, enrollment_id: ENR });
        expect(res.statusCode).toBe(500);
        expect(rpcCalled('book_session_with_credit')).toHaveLength(0);
    });

    it('ruta publica: responde solo id, session_id y status', async () => {
        db.rpcResult.book_session_with_credit = {
            data: { id: 'bk-1', session_id: SESSION, status: 'confirmed', user_id: null, unregistered_athlete_id: 'ua1' }, error: null,
        };
        db.tables.enrollments = enrollment({ user_id: null, unregistered_athlete_id: 'ua1' });
        const res = fakeRes();
        await bookSession(req, res, { unregisteredAthleteId: 'ua1' }, { session_id: SESSION, enrollment_id: ENR },
            undefined, async () => ({ email_sent: true }), true);
        expect(res.body).toEqual({ booking: { id: 'bk-1', session_id: SESSION, status: 'confirmed' }, email_sent: true });
    });
});

describe('shouldLogMissingCredit', () => {
    it.each([
        [{ credit_returned: true }, false, false],
        [{ credit_returned: false, reason: 'not_moved' }, false, true],
        [{ credit_returned: false, hour_bank: true }, false, false],
        [{ credit_returned: false }, true, false],
        [{ credit_returned: false, reason: 'hours_plan_without_reservation' }, false, false],
        [{ credit_returned: false, hour_bank: true, reason: 'no_credit_enrollment' }, false, true],
        [{ credit_returned: false, reason: 'no_credit_enrollment' }, false, true],
        [{ credit_returned: false, reason: 'no_plan' }, false, true],
    ])('%j hourBank=%s -> %s', (out, hb, expected) => {
        expect(shouldLogMissingCredit(out as any, hb)).toBe(expected);
    });
});

describe('cancelRefusalBody', () => {
    it('mensajes claros para session_in_the_past y attendance_recorded; el resto usa el fallback', () => {
        expect(cancelRefusalBody({ cancelled: false, reason: 'session_in_the_past' }, 'x')).toEqual({
            error: 'Esta clase ya pasó y no se puede cancelar.', reason: 'session_in_the_past',
        });
        expect(cancelRefusalBody({ cancelled: false, reason: 'attendance_recorded' }, 'x')).toEqual({
            error: 'Ya se registró tu asistencia a esta clase y no se puede cancelar.', reason: 'attendance_recorded',
        });
        expect(cancelRefusalBody({ cancelled: false }, 'Ya cancelada')).toEqual({ error: 'Ya cancelada' });
        expect(cancelRefusalBody({ cancelled: false, reason: 'not_cancellable' }, 'Ya cancelada')).toEqual({ error: 'Ya cancelada' });
    });
});

describe('POST /:id/book: autorizacion (R3)', () => {
    const BODY = { enrollment_id: '11111111-1111-4111-8111-111111111111', user_id: '22222222-2222-4222-8222-222222222222' };
    const ME = BODY.user_id;
    const CHILD = '33333333-3333-4333-8333-333333333334';
    const call = async (over: Row = {}, body: Row = BODY) => {
        const res = fakeRes();
        await routeHandler('post', '/:id/book')({
            params: { id: SESSION }, body, user: { id: ME }, role: 'athlete', schoolId: SCHOOL, log, ...over,
        }, res);
        return res;
    };
    beforeEach(() => {
        db.tables.enrollments = enrollment({ id: BODY.enrollment_id, user_id: ME });
    });

    it('cross-tenant: staff de otra escuela da 403 y no toca nada', async () => {
        const res = await call({ role: 'admin', schoolId: 'otra-escuela' });
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('identidad ajena: un atleta no reserva a nombre de otro user_id', async () => {
        const res = await call({ user: { id: 'otro-usuario' } });
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('hijo ajeno: un padre no reserva a un child_id que no es suyo', async () => {
        db.tables.children = null;
        const res = await call({}, { enrollment_id: BODY.enrollment_id, child_id: '33333333-3333-4333-8333-333333333333' });
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('inscripcion de otra escuela que la sesion: 403 enrollment_unauthorized', async () => {
        db.tables.enrollments = enrollment({ id: BODY.enrollment_id, user_id: ME, school_id: 'otra-escuela' });
        const res = await call();
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'enrollment_unauthorized' });
        expect(rpcCalled('book_session_with_credit')).toHaveLength(0);
    });

    it('inscripcion de otra persona: 403 aunque el body diga ser el caller', async () => {
        db.tables.enrollments = enrollment({ id: BODY.enrollment_id, user_id: 'alguien-mas' });
        const res = await call();
        expect(res.statusCode).toBe(403);
        expect(rpcCalled('book_session_with_credit')).toHaveLength(0);
    });

    it('sesion inexistente: 404', async () => {
        db.tables.attendance_sessions = null;
        const res = await call();
        expect(res.statusCode).toBe(404);
    });

    it('atleta legitimo: 201 por la RPC, sin insert ni move_session_credit sueltos', async () => {
        const res = await call();
        expect(res.statusCode).toBe(201);
        expect(res.body.booking.id).toBe('bk-1');
        expect(rpcCalled('book_session_with_credit')[0].args).toMatchObject({ p_user_id: ME, p_enrollment_id: BODY.enrollment_id });
        expect(rpcCalled('move_session_credit')).toHaveLength(0);
        expect(db.inserted.filter((i) => i.table === 'session_bookings')).toHaveLength(0);
    });

    it('padre con hijo propio: 201 con p_child_id', async () => {
        db.tables.children = { id: CHILD };
        db.tables.enrollments = enrollment({ id: BODY.enrollment_id, user_id: null, child_id: CHILD });
        const res = await call({}, { enrollment_id: BODY.enrollment_id, child_id: CHILD });
        expect(res.statusCode).toBe(201);
        expect(rpcCalled('book_session_with_credit')[0].args).toMatchObject({ p_child_id: CHILD, p_user_id: null });
    });

    it('staff de la misma escuela (drop-in): 201 y persiste booking_type', async () => {
        const res = await call({ user: { id: 'staff-1' }, role: 'coach' }, { ...BODY, booking_type: 'drop_in' });
        expect(res.statusCode).toBe(201);
        expect(db.updated).toContain('session_bookings');
        expect(res.body.booking.booking_type).toBe('drop_in');
    });
});

describe('rutas de cancelacion con RPC y alcance', () => {
    const OWN = { id: 'bk-1', school_id: SCHOOL, user_id: 'u1', child_id: null, unregistered_athlete_id: null, status: 'confirmed' };
    beforeEach(() => {
        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: true, credit_returned: true }, error: null };
    });

    it('C1: DELETE /athlete/cancel-booking con child_id ajeno da 403 sin tocar la reserva', async () => {
        db.tables.children = null;
        const res = fakeRes();
        await routeHandler('delete', '/athlete/cancel-booking')(
            { query: { booking_id: 'bk-1', child_id: 'c-ajeno' }, user: { id: 'parent' }, log }, res);
        expect(res.statusCode).toBe(403);
        expect(rpcCalled('cancel_session_booking_with_credit')).toHaveLength(0);
    });

    it('C1: con hijo propio sigue de largo', async () => {
        db.tables.children = { id: 'c1' };
        db.tables.session_bookings = { id: 'bk-1', status: 'confirmed', child_id: 'c1', user_id: null, attendance_sessions: null };
        const res = fakeRes();
        await routeHandler('delete', '/athlete/cancel-booking')(
            { query: { booking_id: 'bk-1', child_id: 'c1' }, user: { id: 'parent' }, log }, res);
        expect(res.body).toEqual({ success: true });
        expect(rpcCalled('cancel_session_booking_with_credit')[0].args.p_child_id).toBe('c1');
    });

    it('I1: /bookings/:id de otra escuela da 403 para admin', async () => {
        db.tables.session_bookings = { ...OWN, school_id: 'otra' };
        const res = fakeRes();
        await routeHandler('delete', '/bookings/:id')(
            { params: { id: 'bk-1' }, user: { id: 'admin' }, role: 'admin', schoolId: SCHOOL, log }, res);
        expect(res.statusCode).toBe(403);
        expect(rpcCalled('cancel_session_booking_with_credit')).toHaveLength(0);
    });

    it('I1: /bookings/:id admin de la misma escuela cancela con la identidad de la fila', async () => {
        db.tables.session_bookings = { ...OWN };
        const res = fakeRes();
        await routeHandler('delete', '/bookings/:id')(
            { params: { id: 'bk-1' }, user: { id: 'admin' }, role: 'admin', schoolId: SCHOOL, log }, res);
        expect(res.body).toEqual({ success: true });
        expect(rpcCalled('cancel_session_booking_with_credit')[0].args).toEqual({
            p_booking_id: 'bk-1', p_user_id: 'u1', p_child_id: null, p_unregistered_athlete_id: null,
        });
        expect(rpcCalled('move_session_credit')).toHaveLength(0);
    });

    it('I1: /bookings/:id doble llamada: la segunda (cancelled:false) da 400', async () => {
        db.tables.session_bookings = { ...OWN };
        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false }, error: null };
        const res = fakeRes();
        await routeHandler('delete', '/bookings/:id')(
            { params: { id: 'bk-1' }, user: { id: 'u1' }, role: 'athlete', schoolId: SCHOOL, log }, res);
        expect(res.statusCode).toBe(400);
    });

    it.each([
        ['/bookings/:id', { params: { id: 'bk-1' }, user: { id: 'u1' }, role: 'athlete', schoolId: SCHOOL }],
        ['/athlete/:id/cancel', { params: { id: 'bk-1' }, query: {}, user: { id: 'u1' } }],
    ])('%s: session_in_the_past / attendance_recorded dan 400 con reason', async (path, reqBase) => {
        db.tables.session_bookings = { ...OWN, attendance_sessions: null };
        for (const reason of ['session_in_the_past', 'attendance_recorded']) {
            db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false, reason }, error: null };
            const res = fakeRes();
            await routeHandler('delete', path)({ ...reqBase, log }, res);
            expect(res.statusCode).toBe(400);
            expect(res.body.reason).toBe(reason);
        }
    });

    it('cancel-booking: session_in_the_past da 400 con reason', async () => {
        db.tables.session_bookings = { ...OWN, attendance_sessions: null };
        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false, reason: 'session_in_the_past' }, error: null };
        const res = fakeRes();
        await routeHandler('delete', '/athlete/cancel-booking')({ query: { booking_id: 'bk-1' }, user: { id: 'u1' }, log }, res);
        expect(res.statusCode).toBe(400);
        expect(res.body.reason).toBe('session_in_the_past');
    });

    it('no_credit_enrollment: cancela (200) pero loguea', async () => {
        db.tables.session_bookings = { ...OWN, attendance_sessions: null };
        db.rpcResult.cancel_session_booking_with_credit = {
            data: { cancelled: true, credit_returned: false, reason: 'no_credit_enrollment' }, error: null,
        };
        const res = fakeRes();
        await routeHandler('delete', '/athlete/:id/cancel')({ params: { id: 'bk-1' }, query: {}, user: { id: 'u1' }, log }, res);
        expect(res.body).toEqual({ success: true });
        expect(log.error).toHaveBeenCalled();
    });

    it('I1: /athlete/:id/cancel usa la RPC y cancelled:false da 400', async () => {
        db.tables.session_bookings = { ...OWN, attendance_sessions: null };
        const res = fakeRes();
        await routeHandler('delete', '/athlete/:id/cancel')({ params: { id: 'bk-1' }, query: {}, user: { id: 'u1' }, log }, res);
        expect(res.body).toEqual({ success: true });
        expect(rpcCalled('move_session_credit')).toHaveLength(0);

        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false }, error: null };
        const res2 = fakeRes();
        await routeHandler('delete', '/athlete/:id/cancel')({ params: { id: 'bk-1' }, query: {}, user: { id: 'u1' }, log }, res2);
        expect(res2.statusCode).toBe(400);
    });
});

describe('cancelSessionBooking: RPC cancel_session_booking_with_credit', () => {
    const booking = {
        id: 'bk-1', status: 'confirmed', user_id: 'u1', child_id: null, unregistered_athlete_id: null,
        enrollment_id: ENR, is_secondary: false, hour_bank_reservation_id: null, session_id: SESSION,
        attendance_sessions: { id: SESSION, facility_id: null },
    };

    beforeEach(() => {
        db.tables.session_bookings = { ...booking };
        db.rpcResult.cancel_session_booking_with_credit = {
            data: { cancelled: true, credit_returned: true, session_id: SESSION, hour_bank: false }, error: null,
        };
    });

    it('éxito: pasa la identidad y no toca el crédito desde el BFF', async () => {
        const res = fakeRes();
        const handled = await cancelSessionBooking(req, res, { userId: 'u1' }, 'bk-1');
        expect(handled).toBe(true);
        expect(res.body).toEqual({ success: true });
        expect(rpcCalled('cancel_session_booking_with_credit')[0].args).toEqual({
            p_booking_id: 'bk-1', p_user_id: 'u1', p_child_id: null, p_unregistered_athlete_id: null,
        });
        expect(rpcCalled('move_session_credit')).toHaveLength(0);
        expect(db.updated).not.toContain('session_bookings');
        expect(log.error).not.toHaveBeenCalled();
    });

    it('cancelled:false: 400 Ya cancelada', async () => {
        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false }, error: null };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { userId: 'u1' }, 'bk-1');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Ya cancelada' });
    });

    it('credit_returned:false fuera de banco de horas: loguea y responde success', async () => {
        db.rpcResult.cancel_session_booking_with_credit = {
            data: { cancelled: true, credit_returned: false, hour_bank: false, reason: 'not_moved' }, error: null,
        };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { userId: 'u1' }, 'bk-1');
        expect(res.body).toEqual({ success: true });
        expect(log.error).toHaveBeenCalledWith({ booking_id: 'bk-1', reason: 'not_moved' }, expect.any(String));
    });

    it('hours_plan_without_reservation: esperado, no loguea', async () => {
        db.rpcResult.cancel_session_booking_with_credit = {
            data: { cancelled: true, credit_returned: false, hour_bank: false, reason: 'hours_plan_without_reservation' }, error: null,
        };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { userId: 'u1' }, 'bk-1');
        expect(res.body).toEqual({ success: true });
        expect(log.error).not.toHaveBeenCalled();
    });

    it('ficha sin cuenta pasa p_unregistered_athlete_id', async () => {
        db.tables.session_bookings = { ...booking, user_id: null, unregistered_athlete_id: 'ua1' };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { unregisteredAthleteId: 'ua1' }, 'bk-1');
        expect(rpcCalled('cancel_session_booking_with_credit')[0].args).toMatchObject({
            p_user_id: null, p_unregistered_athlete_id: 'ua1',
        });
    });
});

describe('listAvailableSessions: plan vencido', () => {
    function seedList(expiresAt: string) {
        db.tables = {
            enrollments: [{
                id: ENR, school_id: SCHOOL, team_id: null, offering_plan_id: 'plan-1', offering_id: 'off-1',
                sessions_used: 0, scheduling_team_id: null, expires_at: expiresAt,
                offering_plans: { max_sessions: 8, offering_id: 'off-1', included_minutes_per_period: null, session_block_minutes: null },
            }],
            attendance_sessions: [{
                id: 'as-1', offering_id: 'off-1', team_id: null, session_date: FUTURE, start_time: '10:00:00',
                end_time: '11:00:00', max_capacity: 10, current_bookings: 0, coach_availability_id: null,
            }],
        };
    }

    it('marca plan_expired sin eliminar la sesión', async () => {
        seedList(PAST);
        const out = await listAvailableSessions({ userId: 'u1' });
        expect(out.sessions).toHaveLength(1);
        expect(out.sessions[0].booking_status).toBe('plan_expired');
    });

    it('plan vigente sigue open', async () => {
        seedList(FUTURE);
        const out = await listAvailableSessions({ userId: 'u1' });
        expect(out.sessions[0].booking_status).toBe('open');
    });
});

// QA SEG-31 F3 (R3): bordes adicionales de POST /:id/book.
describe('POST /:id/book: bordes de autorizacion (QA)', () => {
    const ENR_ID = '11111111-1111-4111-8111-111111111111';
    const ME = '22222222-2222-4222-8222-222222222222';
    const OTHER = '44444444-4444-4444-8444-444444444444';
    const call = async (over: Row = {}, body: Row = { enrollment_id: ENR_ID, user_id: ME }) => {
        const res = fakeRes();
        await routeHandler('post', '/:id/book')({
            params: { id: SESSION }, body, user: { id: ME }, role: 'athlete', schoolId: SCHOOL, log, ...over,
        }, res);
        return res;
    };
    beforeEach(() => {
        db.tables.enrollments = enrollment({ id: ENR_ID, user_id: ME });
    });

    it('staff sin schoolId en la sesion del caller: 403, sin RPC', async () => {
        const res = await call({ role: 'admin', schoolId: undefined, user: { id: 'staff-1' } });
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('rol no staff (wellness_professional) no reserva a nombre de otro', async () => {
        const res = await call({ role: 'wellness_professional', user: { id: OTHER } });
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('body con user_id y child_id a la vez: 400 sin tocar nada', async () => {
        const res = await call({}, { enrollment_id: ENR_ID, user_id: ME, child_id: OTHER });
        expect(res.statusCode).toBe(400);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('body sin identidad o con enrollment_id no uuid: 400', async () => {
        expect((await call({}, { enrollment_id: ENR_ID })).statusCode).toBe(400);
        expect((await call({}, { enrollment_id: 'no-uuid', user_id: ME })).statusCode).toBe(400);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('padre (rol parent) reservando para si mismo con su inscripcion: 201', async () => {
        const res = await call({ role: 'parent' });
        expect(res.statusCode).toBe(201);
    });

    it('staff reservando con inscripcion de una persona de OTRA escuela: 403 enrollment_unauthorized', async () => {
        db.tables.enrollments = enrollment({ id: ENR_ID, user_id: ME, school_id: 'otra-escuela' });
        const res = await call({ role: 'owner', user: { id: 'staff-1' } });
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'enrollment_unauthorized' });
        expect(rpcCalled('book_session_with_credit')).toHaveLength(0);
    });
});

// QA SEG-31 F3 (R1): cancelSessionBooking (ruta publica sin cuenta y atleta)
// propaga los reason nuevos como 400 con texto claro, sin loguear falta de credito.
describe('cancelSessionBooking: reason de rechazo R1 (QA)', () => {
    const booking = {
        id: 'bk-1', status: 'confirmed', user_id: null, child_id: null, unregistered_athlete_id: 'ua-1',
        enrollment_id: null, is_secondary: false, hour_bank_reservation_id: null, session_id: SESSION,
        attendance_sessions: { id: SESSION, facility_id: null },
    };
    it.each(['session_in_the_past', 'attendance_recorded'])('%s -> 400 con reason y mensaje en error', async (reason) => {
        db.tables.session_bookings = { ...booking };
        db.rpcResult.cancel_session_booking_with_credit = { data: { cancelled: false, reason }, error: null };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { unregisteredAthleteId: 'ua-1' }, 'bk-1');
        expect(res.statusCode).toBe(400);
        expect(res.body.reason).toBe(reason);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error).not.toBe('Ya cancelada');
        expect(log.error).not.toHaveBeenCalled();
    });
});
