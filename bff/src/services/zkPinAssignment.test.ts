import { describe, it, expect, vi, beforeEach } from 'vitest';

// Cada tabla responde con lo que dejen `tablas[tabla]` (maybeSingle) — la cadena
// select/eq/neq/delete/upsert devuelve siempre el mismo builder.
const tablas: Record<string, any> = {};
const upserts: any[] = [];
const deletes: any[] = [];

vi.mock('../config/supabase', () => ({
    supabase: {
        from: (tabla: string) => {
            const b: any = {
                select: () => b,
                eq: () => b,
                neq: () => b,
                delete: () => { deletes.push(tabla); return b; },
                upsert: (row: any) => { upserts.push({ tabla, row }); return Promise.resolve({ error: null }); },
                maybeSingle: () => Promise.resolve({ data: tablas[tabla] ?? null, error: null }),
                then: (res: any) => res({ error: null }),
            };
            return b;
        },
    },
}));
vi.mock('../routes/access-adms', () => ({ invalidateMappingCache: vi.fn(), reprocessPinEventsForHourBank: vi.fn(async () => ({ reprocessed: 0 })) }));

import {
    validateZkPin, prepareZkPinForSignup, assertZkPinAvailable, assignZkPin, ZkPinError,
} from './zkPinAssignment';

beforeEach(() => {
    for (const k of Object.keys(tablas)) delete tablas[k];
    upserts.length = 0;
    deletes.length = 0;
});

describe('validateZkPin', () => {
    it('acepta enteros positivos', () => {
        expect(validateZkPin(602)).toBe(602);
        expect(validateZkPin('4')).toBe(4);
    });
    it.each([0, -1, 1.5, 'abc', 100_000_000, NaN])('rechaza %s', (v) => {
        expect(() => validateZkPin(v)).toThrow(ZkPinError);
    });
});

describe('prepareZkPinForSignup', () => {
    it('sin ID no hace nada', async () => {
        expect(await prepareZkPinForSignup('s1', undefined)).toBeNull();
        expect(await prepareZkPinForSignup('s1', null)).toBeNull();
        expect(await prepareZkPinForSignup('s1', '')).toBeNull();
    });

    it('escuela sin el flag: 400 ZK_PIN_NOT_ENABLED', async () => {
        tablas.school_settings = { registration_zk_pin_enabled: false };
        await expect(prepareZkPinForSignup('s1', 602)).rejects.toMatchObject({ status: 400, code: 'ZK_PIN_NOT_ENABLED' });
    });

    it('ID libre: lo devuelve validado', async () => {
        tablas.school_settings = { registration_zk_pin_enabled: true };
        expect(await prepareZkPinForSignup('s1', 602)).toBe(602);
    });

    it('ID de otra persona: 409 con su nombre', async () => {
        tablas.school_settings = { registration_zk_pin_enabled: true };
        tablas.zk_user_mappings = { child_id: 'c-otra', user_id: null, unregistered_athlete_id: null };
        tablas.children = { full_name: 'Mariapaz Bolivar' };
        const e = await prepareZkPinForSignup('s1', 605).catch(x => x);
        expect(e).toBeInstanceOf(ZkPinError);
        expect(e.status).toBe(409);
        expect(e.code).toBe('ZK_PIN_IN_USE');
        expect(e.message).toContain('Mariapaz Bolivar');
    });
});

describe('assertZkPinAvailable', () => {
    it('el ID que ya es de la misma persona no es conflicto (edición)', async () => {
        tablas.zk_user_mappings = { child_id: 'c1', user_id: null, unregistered_athlete_id: null };
        await expect(assertZkPinAvailable('s1', 602, { child_id: 'c1' })).resolves.toBeUndefined();
    });
});

describe('assignZkPin', () => {
    it('retira el ID anterior de la persona y deja una sola columna de identidad', async () => {
        await assignZkPin('s1', 602, { child_id: 'c1' });
        expect(deletes).toContain('zk_user_mappings');
        expect(upserts[0].row).toEqual({
            school_id: 's1', zk_pin: 602, child_id: 'c1', user_id: null, unregistered_athlete_id: null,
        });
    });
    it('adulto sin cuenta', async () => {
        await assignZkPin('s1', 78, { unregistered_athlete_id: 'u1' });
        expect(upserts[0].row).toMatchObject({ unregistered_athlete_id: 'u1', child_id: null, user_id: null });
    });
});
