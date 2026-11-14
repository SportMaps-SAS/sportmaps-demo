/**
 * QA SEG-31 F3 (H1): cancelacion ajena y ventana de cancelacion en
 * cancelSessionBooking. Supabase en memoria; cero red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    booking: null as any,
    rpcCalls: [] as { fn: string; args: any }[],
    updated: [] as string[],
}));

vi.mock('../config/supabase', () => {
    function builder(table: string) {
        const api: any = {};
        for (const op of ['select', 'eq', 'neq', 'in', 'not', 'gte', 'lte', 'order', 'limit']) api[op] = () => api;
        api.update = () => { db.updated.push(table); return api; };
        api.maybeSingle = async () => ({ data: table === 'session_bookings' ? db.booking : null, error: null });
        api.single = api.maybeSingle;
        api.then = (ok: any, ko: any) => Promise.resolve({ data: [], error: null }).then(ok, ko);
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (fn: string, args: any) => { db.rpcCalls.push({ fn, args }); return { data: { cancelled: true, credit_returned: true }, error: null }; },
        },
    };
});
vi.mock('../services/bridgeWsHub', () => ({ wakeSchool: vi.fn() }));
vi.mock('./access-adms', () => ({
    invalidateDeviceCache: vi.fn(), invalidateMappingCache: vi.fn(),
    reprocessPinEventsForHourBank: vi.fn(async () => ({ reprocessed: 0 })), getHourBankSettings: vi.fn(),
}));

import { cancelSessionBooking } from './session-bookings';

function fakeRes() {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
}
const req = { log: { error: vi.fn() } } as any;
const base = {
    id: 'bk-1', status: 'confirmed', user_id: null, child_id: null, unregistered_athlete_id: 'ua-dueña',
    enrollment_id: null, is_secondary: false, hour_bank_reservation_id: null, session_id: 's1',
    attendance_sessions: { id: 's1', facility_id: null, coach_availability_id: null },
};

beforeEach(() => { db.rpcCalls = []; db.updated = []; db.booking = { ...base }; });

describe('cancelSessionBooking: cancelacion ajena', () => {
    it('ficha distinta a la duena: 403 y la RPC de credito no se llama', async () => {
        const res = fakeRes();
        const handled = await cancelSessionBooking(req, res, { unregisteredAthleteId: 'ua-otra' }, 'bk-1');
        expect(handled).toBe(true);
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: 'unauthorized' });
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.updated).toHaveLength(0);
    });

    it('usuario con cuenta no puede cancelar la reserva de una ficha sin cuenta', async () => {
        const res = fakeRes();
        await cancelSessionBooking(req, res, { userId: 'u1' }, 'bk-1');
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('ya cancelada: 400 Ya cancelada sin RPC', async () => {
        db.booking = { ...base, status: 'cancelled' };
        const res = fakeRes();
        await cancelSessionBooking(req, res, { unregisteredAthleteId: 'ua-dueña' }, 'bk-1');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: 'Ya cancelada' });
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('la duena cancela: la RPC recibe SOLO su identidad', async () => {
        const res = fakeRes();
        await cancelSessionBooking(req, res, { unregisteredAthleteId: 'ua-dueña' }, 'bk-1');
        expect(res.body).toEqual({ success: true });
        expect(db.rpcCalls.map((c) => c.fn)).toEqual(['cancel_session_booking_with_credit']);
        expect(db.rpcCalls[0].args).toEqual({
            p_booking_id: 'bk-1', p_user_id: null, p_child_id: null, p_unregistered_athlete_id: 'ua-dueña',
        });
    });
});
