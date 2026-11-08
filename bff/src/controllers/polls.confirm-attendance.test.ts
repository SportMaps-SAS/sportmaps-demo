/**
 * SEG-31 R2: confirmAttendance no guarda el enrollment_id del body (nadie lo
 * valida contra el usuario ni la escuela de la sesión).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    inserts: [] as { table: string; row: any }[],
}));

vi.mock('../config/supabase', () => {
    function builder(table: string) {
        let pending: any = null;
        const api: any = {};
        for (const op of ['select', 'eq', 'neq', 'in', 'order', 'limit']) api[op] = () => api;
        api.insert = (row: any) => { pending = row; db.inserts.push({ table, row }); return api; };
        const one = () => {
            if (pending) return { data: { id: 'bk-1', ...pending }, error: null };
            if (table === 'attendance_sessions') {
                return {
                    data: { id: 's1', max_capacity: 10, poll_id: 'p1', school_id: 'sch1', poll: { id: 'p1', status: 'open' } },
                    error: null,
                };
            }
            return { data: null, error: null };
        };
        api.single = async () => one();
        api.maybeSingle = async () => one();
        api.then = (ok: any, ko: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(ok, ko);
        return api;
    }
    return { supabase: { from: (t: string) => builder(t), rpc: vi.fn() } };
});

import { pollsController } from './polls.controller';

function fakeRes() {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
}

beforeEach(() => { db.inserts = []; });

describe('confirmAttendance: enrollment_id del body', () => {
    it('usuario autenticado: la reserva NO lleva enrollment_id', async () => {
        const res = fakeRes();
        await pollsController.confirmAttendance({
            params: { pollId: 'p1' }, user: { id: 'u1' },
            body: { session_id: 's1', user_id: 'u1', enrollment_id: 'enrollment-ajena' },
        } as any, res);
        expect(res.statusCode).toBe(201);
        const ins = db.inserts.find((i) => i.table === 'session_bookings')!;
        expect(ins.row).not.toHaveProperty('enrollment_id');
        expect(ins.row).toMatchObject({ user_id: 'u1', school_id: 'sch1', status: 'confirmed' });
        expect(ins.row.child_id).toBeUndefined();
    });

    it('invitado: solo unregistered_athlete_id, sin user_id ni enrollment_id', async () => {
        const res = fakeRes();
        await pollsController.confirmAttendance({
            params: { pollId: 'p1' }, user: undefined,
            body: { session_id: 's1', guest_name: 'Ana', poll_token: 'tok', enrollment_id: 'enrollment-ajena' },
        } as any, res);
        expect(res.statusCode).toBe(201);
        const ins = db.inserts.find((i) => i.table === 'session_bookings')!;
        expect(ins.row).not.toHaveProperty('enrollment_id');
        expect(ins.row).not.toHaveProperty('user_id');
        expect(ins.row.unregistered_athlete_id).toBeTruthy();
    });
});
