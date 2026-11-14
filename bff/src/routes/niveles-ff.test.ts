/**
 * F-F de docs/specs/dreamers-reglas-completas-plan.md — niveles: días
 * permitidos por plan (D9/D11b) y progresión por puntaje (D3/D4/D5/D6/D15).
 *
 * Lo que se vigila:
 *   · planDayRules: día de la semana de una fecha calendario y de un instante
 *     en Bogotá (borde de medianoche UTC-5), NULL = sin restricción.
 *   · Reservas: 422 day_not_allowed en bookSession (atleta/acudiente y reserva
 *     pública), POST /:id/book y POST /access/hour-bank-reservations; un plan
 *     sin días sigue de largo igual que hoy.
 *   · Torniquete: un día no permitido queda access_granted = true con
 *     policy_warning (nunca denial_reason); aviso al owner 1 vez por día.
 *   · Progresión: dedupe del aviso por (inscripción, plan destino, temporada);
 *     sin el flag no se calcula ni se avisa nada.
 *
 * La lógica de elegibilidad (rango de nivel, borde de temporada, resultados
 * cargados por el atleta ignorados, umbral NULL nunca destino) vive en SQL y
 * se prueba en supabase/migrations/_smoke/niveles_ff_smoke.sql.
 *
 * Cero red: Supabase en memoria.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    inserted: [] as { table: string; rows: Row[] }[],
    rpcCalls: [] as { fn: string; args: any }[],
    rpcResult: {} as Record<string, any>,
    failSelectOn: new Set<string>(),
}));

vi.mock('../config/supabase', () => {
    const matchContains = (val: any, obj: any): boolean =>
        Object.entries(obj).every(([k, v]) => val && val[k] === v);

    function builder(table: string) {
        let rows: Row[] = [...(db.tables[table] ?? [])];
        let pendingInsert: Row[] | null = null;
        let selectCols = '';
        const result = () => {
            if (pendingInsert) {
                const withIds = pendingInsert.map((r, i) => ({ id: r.id ?? `${table}-new-${i}`, ...r }));
                db.tables[table] = [...(db.tables[table] ?? []), ...withIds];
                db.inserted.push({ table, rows: withIds });
                return { data: withIds, error: null };
            }
            if ([...db.failSelectOn].some((c) => selectCols.includes(c))) {
                return { data: null, error: { message: 'column does not exist' } };
            }
            return { data: rows, error: null };
        };
        const api: any = {
            select: (c?: string) => { selectCols = c ?? ''; return api; },
            insert: (r: Row | Row[]) => { pendingInsert = Array.isArray(r) ? r : [r]; return api; },
            eq: (c: string, v: any) => { rows = rows.filter((r) => r[c] === v); return api; },
            neq: (c: string, v: any) => { rows = rows.filter((r) => r[c] !== v); return api; },
            in: (c: string, vs: any[]) => { rows = rows.filter((r) => vs.includes(r[c])); return api; },
            not: (c: string, _op: string, _v: any) => { rows = rows.filter((r) => r[c] != null); return api; },
            contains: (c: string, obj: any) => { rows = rows.filter((r) => matchContains(r[c], obj)); return api; },
            order: () => api,
            limit: () => api,
            maybeSingle: async () => { const r = result(); return { data: (r.data ?? [])[0] ?? null, error: r.error }; },
            single: async () => { const r = result(); return { data: (r.data ?? [])[0] ?? null, error: r.error }; },
            then: (ok: any, ko: any) => Promise.resolve(result()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (fn: string, args: any) => {
                db.rpcCalls.push({ fn, args });
                const r = db.rpcResult[fn];
                return typeof r === 'function' ? r(args) : { data: r ?? null, error: null };
            },
        },
    };
});
vi.mock('../services/bridgeWsHub', () => ({ wakeSchool: vi.fn() }));
vi.mock('./access-adms', () => ({
    invalidateDeviceCache: vi.fn(), invalidateMappingCache: vi.fn(), reprocessPinEventsForHourBank: vi.fn(async () => ({ reprocessed: 0 })), getHourBankSettings: vi.fn(),
}));

import {
    accessEventDecisionFields,
    bogotaDateOf,
    clearPlanDayRulesCache,
    isDayAllowed,
    notifyOwnerDayNotAllowedOnce,
    resolveEntryDayWarning,
    weekdayOfDateString,
} from '../utils/planDayRules';
import { bookSession } from './session-bookings';
import sessionBookingsRouter from './session-bookings';
import accessApiRouter from './access-api';
import {
    invalidateLevelProgressionCache,
    notifyNewlyEligible,
    parseSeason,
    pendingPromotionNotices,
} from '../services/levelProgression.service';
import { validateIndividualFields } from './school/competition-results';

const SCHOOL = 'school-1';
const PLAN_MWF = 'plan-lmv';      // lunes, miércoles, viernes
const PLAN_FREE = 'plan-libre';   // allowed_days_of_week NULL
const ENR_MWF = 'enr-lmv';
const ENR_FREE = 'enr-libre';

function fakeRes() {
    const res: any = { statusCode: 200, body: undefined };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: any) => { res.body = b; return res; };
    return res;
}

function routeHandler(router: any, method: string, path: string) {
    const layer = router.stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
    if (!layer) throw new Error(`ruta no encontrada: ${method} ${path}`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
}

beforeEach(() => {
    clearPlanDayRulesCache();
    invalidateLevelProgressionCache();
    db.inserted = [];
    db.rpcCalls = [];
    db.rpcResult = {};
    db.failSelectOn = new Set();
    db.tables = {
        enrollments: [
            { id: ENR_MWF, user_id: 'u1', child_id: null, unregistered_athlete_id: null, school_id: SCHOOL, status: 'active', offering_plan_id: PLAN_MWF },
            { id: ENR_FREE, user_id: 'u2', child_id: null, unregistered_athlete_id: null, school_id: SCHOOL, status: 'active', offering_plan_id: PLAN_FREE },
        ],
        offering_plans: [
            { id: PLAN_MWF, allowed_days_of_week: [1, 3, 5] },
            { id: PLAN_FREE, allowed_days_of_week: null },
        ],
        attendance_sessions: [
            { id: 'sess-tue', session_date: '2026-10-06', school_id: SCHOOL }, // martes
            { id: 'sess-wed', session_date: '2026-10-07', school_id: SCHOOL }, // miércoles
        ],
        schools: [{ id: SCHOOL, owner_id: 'owner-1' }],
        notifications: [],
        school_settings: [{ school_id: SCHOOL, level_progression_enabled: true }],
        school_members: [{ school_id: SCHOOL, profile_id: 'admin-1', status: 'active', role: 'admin' }],
        profiles: [{ id: 'admin-1', full_name: 'Admin', email: 'a@x.co', phone: null }],
    };
});

// ── planDayRules ────────────────────────────────────────────────────────────
describe('planDayRules', () => {
    it('día de la semana de una fecha calendario (0 = domingo), sin zona horaria', () => {
        expect(weekdayOfDateString('2026-10-04')).toBe(0); // domingo
        expect(weekdayOfDateString('2026-10-05')).toBe(1); // lunes
        expect(weekdayOfDateString('2026-10-10')).toBe(6); // sábado
    });

    it('un instante se lee en hora de Bogotá (UTC-5): 03:00Z del martes sigue siendo lunes', () => {
        expect(bogotaDateOf('2026-10-06T03:00:00Z')).toBe('2026-10-05');
        expect(weekdayOfDateString(bogotaDateOf('2026-10-06T03:00:00Z'))).toBe(1);
        expect(bogotaDateOf('2026-10-06T05:00:00Z')).toBe('2026-10-06');
    });

    it('NULL / vacío = sin restricción; con días, solo esos', () => {
        expect(isDayAllowed(null, '2026-10-06')).toBe(true);
        expect(isDayAllowed([], '2026-10-06')).toBe(true);
        expect(isDayAllowed([1, 3, 5], '2026-10-06')).toBe(false); // martes
        expect(isDayAllowed([1, 3, 5], '2026-10-07')).toBe(true);  // miércoles
    });
});

// ── Reservas: 422 day_not_allowed ───────────────────────────────────────────
describe('reservas en día no permitido', () => {
    it('bookSession (atleta/acudiente y reserva pública): 422 sin crear nada', async () => {
        const res = fakeRes();
        await bookSession({ log: undefined } as any, res, { userId: 'u1' }, { session_id: 'sess-tue', enrollment_id: ENR_MWF }, 'u1');
        expect(res.statusCode).toBe(422);
        expect(res.body).toMatchObject({ reserved: false, reason: 'day_not_allowed', allowed_days: [1, 3, 5] });
        expect(db.inserted).toHaveLength(0);
        expect(db.rpcCalls).toHaveLength(0);
    });

    it('bookSession con pseudo-sesión avail_ toma el día del id', async () => {
        const res = fakeRes();
        await bookSession({} as any, res, { userId: 'u1' }, { session_id: 'avail_p_abc_2026-10-06', enrollment_id: ENR_MWF }, 'u1');
        expect(res.statusCode).toBe(422);
    });

    it('bookSession con plan sin días (NULL) sigue de largo como hoy', async () => {
        const res = fakeRes();
        // Pasa el chequeo de días y sigue al paso 3: el avail_ no existe en el mock → 404.
        await bookSession({} as any, res, { userId: 'u2' }, { session_id: 'avail_p_abc_2026-10-06', enrollment_id: ENR_FREE }, 'u2');
        expect(res.statusCode).toBe(404);
        expect(res.body?.reason).not.toBe('day_not_allowed');
    });

    it('bookSession en día permitido sigue de largo', async () => {
        const res = fakeRes();
        await bookSession({} as any, res, { userId: 'u1' }, { session_id: 'avail_p_abc_2026-10-07', enrollment_id: ENR_MWF }, 'u1');
        expect(res.statusCode).not.toBe(422);
    });

    it('POST /:id/book: 422 antes de mover saldo (la inscripción debe ser de la identidad y la escuela)', async () => {
        const handler = routeHandler(sessionBookingsRouter, 'post', '/:id/book');
        const ENR = '11111111-1111-4111-8111-111111111111';
        const USR = '22222222-2222-4222-8222-222222222222';
        const body = { enrollment_id: ENR, user_id: USR };
        const reqBase = { params: { id: 'sess-tue' }, schoolId: SCHOOL, role: 'admin', user: { id: 'staff' }, body };

        // Inscripción que no existe: 403 (SEG-31 R3), nada se mueve.
        const res = fakeRes();
        await handler(reqBase, res);
        expect(res.statusCode).toBe(403);
        expect(db.rpcCalls).toHaveLength(0);

        db.tables.enrollments.push({ id: ENR, user_id: USR, child_id: null, unregistered_athlete_id: null, school_id: SCHOOL, status: 'active', offering_plan_id: PLAN_MWF });
        clearPlanDayRulesCache();
        const res2 = fakeRes();
        await handler(reqBase, res2);
        expect(res2.statusCode).toBe(422);
        expect(res2.body.reason).toBe('day_not_allowed');
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.inserted).toHaveLength(0);
    });

    it('POST /access/hour-bank-reservations: 422 antes del RPC; día libre sí llama el RPC', async () => {
        const handler = routeHandler(accessApiRouter, 'post', '/hour-bank-reservations');
        const res = fakeRes();
        await handler({
            schoolId: SCHOOL, role: 'owner', user: { id: 'owner-1' },
            body: { enrollment_id: ENR_MWF, reservation_date: '2026-10-06' },
        }, res);
        expect(res.statusCode).toBe(422);
        expect(res.body.reason).toBe('day_not_allowed');
        expect(db.rpcCalls).toHaveLength(0);

        db.rpcResult.reserve_hour_bank = { reserved: true, reservation_id: 'r1' };
        const res2 = fakeRes();
        await handler({
            schoolId: SCHOOL, role: 'owner', user: { id: 'owner-1' },
            body: { enrollment_id: ENR_FREE, reservation_date: '2026-10-06' },
        }, res2);
        expect(res2.statusCode).toBe(201);
        expect(db.rpcCalls.map((c) => c.fn)).toEqual(['reserve_hour_bank']);
    });

    it('fail-open: si la columna allowed_days_of_week no existe aún, se reserva como hoy', async () => {
        db.failSelectOn.add('allowed_days_of_week');
        db.rpcResult.reserve_hour_bank = { reserved: true, reservation_id: 'r1' };
        const handler = routeHandler(accessApiRouter, 'post', '/hour-bank-reservations');
        const res = fakeRes();
        await handler({
            schoolId: SCHOOL, role: 'owner', user: { id: 'owner-1' },
            body: { enrollment_id: ENR_MWF, reservation_date: '2026-10-06' },
        }, res);
        expect(res.statusCode).toBe(201);
    });
});

// ── Torniquete: registrar + avisar, nunca negar (D11b) ──────────────────────
describe('torniquete en día no permitido', () => {
    it('la advertencia aparece en un martes para plan L-M-V (hora Bogotá)', async () => {
        // 2026-10-06 15:00 Bogotá = martes
        expect(await resolveEntryDayWarning(ENR_MWF, '2026-10-06T20:00:00Z')).toBe('day_not_allowed');
        // 2026-10-06 03:00Z = lunes 22:00 en Bogotá → permitido
        expect(await resolveEntryDayWarning(ENR_MWF, '2026-10-06T03:00:00Z')).toBeUndefined();
        expect(await resolveEntryDayWarning(ENR_FREE, '2026-10-06T20:00:00Z')).toBeUndefined();
        expect(await resolveEntryDayWarning(undefined, '2026-10-06T20:00:00Z')).toBeUndefined();
    });

    it('el evento queda CONCEDIDO con policy_warning, nunca como denial_reason', () => {
        expect(accessEventDecisionFields({ granted: true, policyWarning: 'day_not_allowed' })).toEqual({
            access_granted: true, denial_reason: null, policy_warning: 'day_not_allowed',
        });
        // Sin advertencia no se escribe la columna nueva (no depende de la migración).
        expect(accessEventDecisionFields({ granted: true })).toEqual({ access_granted: true, denial_reason: null });
        expect(accessEventDecisionFields({ granted: false, reason: 'payment_overdue' })).toEqual({
            access_granted: false, denial_reason: 'payment_overdue',
        });
    });

    it('aviso al owner: una sola vez por atleta por día', async () => {
        const params = { schoolId: SCHOOL, enrollmentId: ENR_MWF, athleteName: 'Ana', occurredAt: '2026-10-06T20:00:00Z' };
        expect(await notifyOwnerDayNotAllowedOnce(params)).toBe(true);
        expect(await notifyOwnerDayNotAllowedOnce({ ...params, occurredAt: '2026-10-06T22:00:00Z' })).toBe(false);
        expect(await notifyOwnerDayNotAllowedOnce({ ...params, occurredAt: '2026-10-08T20:00:00Z' })).toBe(true);
        const notifs = db.tables.notifications;
        expect(notifs).toHaveLength(2);
        expect(notifs[0]).toMatchObject({ user_id: 'owner-1', type: 'access_day_not_allowed', category: 'access' });
    });
});

// ── Progresión por puntaje ──────────────────────────────────────────────────
describe('progresión por puntaje', () => {
    const eligibleRow = {
        enrollment_id: ENR_MWF, subject_type: 'profile', subject_id: 'u1', athlete_name: 'Ana',
        current_plan_id: PLAN_MWF, current_plan_name: 'N1', current_threshold: null,
        best_result_id: 'res-1', best_points: 35, best_level: 'regional', best_competition_date: '2026-05-01',
        suggested_plan_id: 'plan-n2', suggested_plan_name: 'N2', suggested_threshold: 30,
        suggested_min_level: 'regional', suggested_fee: 723000, qualifying_result_id: 'res-1', qualifying_points: 35,
    };

    it('temporada: año calendario; vacío = año actual en Bogotá', () => {
        expect(parseSeason('2026')).toBe(2026);
        expect(parseSeason('abc')).toBeNull();
        expect(parseSeason(undefined, new Date('2027-01-01T03:00:00Z'))).toBe(2026); // aún 31-dic en Bogotá
    });

    it('dedupe: mismo tipo + inscripción + destino + temporada no se repite', () => {
        const rows = [eligibleRow as any, { ...eligibleRow, enrollment_id: 'otra' } as any, { ...eligibleRow, suggested_plan_id: null } as any];
        const pending = pendingPromotionNotices(rows, [{ enrollment_id: ENR_MWF, target_plan_id: 'plan-n2', season: 2026 }], 2026);
        expect(pending.map((r) => r.enrollment_id)).toEqual(['otra']);
        // otra temporada = aviso nuevo
        expect(pendingPromotionNotices([eligibleRow as any], [{ enrollment_id: ENR_MWF, target_plan_id: 'plan-n2', season: 2025 }], 2026)).toHaveLength(1);
    });

    it('con el flag: avisa a owner + admins una vez; la segunda carga no repite', async () => {
        db.rpcResult.get_level_promotion_eligibility = [eligibleRow];
        const args = { schoolId: SCHOOL, subjectType: 'profile' as const, subjectId: 'u1', season: 2026, resultId: 'res-1' };

        expect(await notifyNewlyEligible(args)).toEqual({ notified: 1 });
        const sent = db.tables.notifications;
        expect(sent.map((n) => n.user_id).sort()).toEqual(['admin-1', 'owner-1']);
        expect(sent[0]).toMatchObject({
            type: 'level_promotion_eligible', category: 'enrollment',
            data: { enrollment_id: ENR_MWF, target_plan_id: 'plan-n2', points: 35, season: 2026, result_id: 'res-1' },
        });

        expect(await notifyNewlyEligible({ ...args, resultId: 'res-2' })).toEqual({ notified: 0 });
        expect(db.tables.notifications).toHaveLength(2);
    });

    it('sin el flag: ni RPC ni aviso (dato pasivo)', async () => {
        db.tables.school_settings = [{ school_id: SCHOOL, level_progression_enabled: false }];
        db.rpcResult.get_level_promotion_eligibility = [eligibleRow];
        const out = await notifyNewlyEligible({ schoolId: SCHOOL, subjectType: 'profile', subjectId: 'u1', season: 2026, resultId: 'r' });
        expect(out).toEqual({ notified: 0 });
        expect(db.rpcCalls).toHaveLength(0);
        expect(db.tables.notifications).toHaveLength(0);
    });

    it('sin plan sugerido no se avisa', async () => {
        db.rpcResult.get_level_promotion_eligibility = [{ ...eligibleRow, suggested_plan_id: null }];
        const out = await notifyNewlyEligible({ schoolId: SCHOOL, subjectType: 'profile', subjectId: 'u1', season: 2026, resultId: 'r' });
        expect(out).toEqual({ notified: 0 });
        expect(db.tables.notifications).toHaveLength(0);
    });

    it('resultado individual: points >= 0, nivel del catálogo, result_type de cualquiera de los dos catálogos', () => {
        expect(validateIndividualFields({ points: 34.5, competition_date: '2026-05-01', competition_level: 'nacional' }, false))
            .toEqual({ errors: [], values: { points: 34.5, competition_level: 'nacional', result_type: 'competencia_oficial', competition_date: '2026-05-01' } });
        expect(validateIndividualFields({ points: -1, competition_date: '2026-05-01' }, false).errors).toHaveLength(1);
        expect(validateIndividualFields({ points: 3, competition_date: '2026-05-01', competition_level: 'mundial' }, false).errors).toHaveLength(1);
        expect(validateIndividualFields({ points: 3, competition_date: '2026-05-01', result_type: 'score' }, false).errors).toHaveLength(0);
        expect(validateIndividualFields({ points: 3 }, false).errors).toContain('competition_date (YYYY-MM-DD) es requerido.');
    });
});
