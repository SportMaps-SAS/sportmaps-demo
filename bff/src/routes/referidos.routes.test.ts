/**
 * Referidos — rutas (F1). Permisos por rol, validación Zod y firma de las RPC.
 * Cero red: base en memoria y RPC moqueadas (mismo patrón que payment-adjustments.routes.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import type { EstadoFalso } from '../services/charge-batches.test-helpers';

const estado = vi.hoisted(() => ({ ref: null as unknown as EstadoFalso }));
vi.mock('../config/supabase', async () => {
    const h = await import('../services/charge-batches.test-helpers');
    estado.ref = h.estadoVacio();
    return { supabase: h.supabaseFalso(new Proxy({} as EstadoFalso, { get: (_t, k) => (estado.ref as any)[k] })) };
});
vi.mock('../utils/authCache', () => ({
    getCachedUser: (_t: string, resolve: any) => resolve(),
    getCachedMembership: (_u: string, _s: any, _t: string, resolve: any) => resolve(),
    invalidateUserAuthCache: () => { },
}));

const { default: router } = await import('./referidos.routes');

const ESCUELA = 'e0000000-0000-4000-8000-000000000001';
const DUENO = 'a0000000-0000-4000-8000-000000000001';
const ADMIN = 'a0000000-0000-4000-8000-000000000002';
const CONTADOR = 'a0000000-0000-4000-8000-000000000004';
const COACH = 'a0000000-0000-4000-8000-000000000005';
const ENR = '11111111-1111-4111-8111-111111111111';
const REFERIDO = '22222222-2222-4222-8222-222222222222';

let server: http.Server;
let base: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/referidos', router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const CAMPANA = { name: 'Referidos', active: true, tiers: [{ age_min: 4, age_max: 15, pct: 50 }, { age_min: 16, age_max: null, pct: 25 }] };

beforeEach(() => {
    estado.ref.tokens = Object.fromEntries([DUENO, ADMIN, CONTADOR, COACH].map((u) => [`tok-${u}`, { id: u, email: 'x@t.co' }]));
    estado.ref.erroresTabla = {};
    estado.ref.llamadasRpc = [];
    const m = (profile_id: string, role: string) => ({ profile_id, role, school_id: ESCUELA, status: 'active', branch_id: null, joined_at: '2026-01-01' });
    estado.ref.tablas = {
        schools: [{ id: ESCUELA, owner_id: DUENO }],
        school_members: [m(ADMIN, 'school_admin'), m(CONTADOR, 'accountant'), m(COACH, 'coach'), m(DUENO, 'owner')],
        platform_admins: [],
        school_discount_campaigns: [{ id: 'c1', school_id: ESCUELA, kind: 'referral', ...CAMPANA }],
    };
    estado.ref.rpc = {
        upsert_school_discount_campaign: (a: any) => ({ data: { id: 'c1', school_id: a.p_school_id, name: a.p_name, active: a.p_active } }),
        register_enrollment_referral: () => ({ data: { ok: true, referral: { id: 'r1', status: 'pendiente', pct: 50 } } }),
        update_enrollment_referral: () => ({ data: { ok: true, referral: { id: 'r1', status: 'anulado' } } }),
        referrals_report: () => ({ data: { rows: [{ id: 'r1' }], totals: { total: 1, por_estado: { pendiente: 1 }, dejado_de_cobrar: 0 }, by_month: [] } }),
    };
});

async function llamar(metodo: string, ruta: string, u: string, cuerpo?: unknown) {
    const r = await fetch(`${base}/api/v1/referidos${ruta}`, {
        method: metodo,
        headers: { 'content-type': 'application/json', 'x-school-id': ESCUELA, authorization: `Bearer tok-${u}` },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
}

describe('permisos por rol', () => {
    it('coach → 403 en todo, sin tocar la base', async () => {
        expect((await llamar('GET', '/campaign', COACH)).status).toBe(403);
        expect((await llamar('PUT', '/campaign', COACH, CAMPANA)).status).toBe(403);
        expect((await llamar('POST', '/', COACH, { referred_enrollment_id: ENR, referrer_name_text: 'Ana' })).status).toBe(403);
        expect((await llamar('PATCH', `/${REFERIDO}`, COACH, { action: 'anular' })).status).toBe(403);
        expect((await llamar('GET', '/report', COACH)).status).toBe(403);
        expect(estado.ref.llamadasRpc).toHaveLength(0);
    });

    it('contador: lee (campaña, listado, informe) pero no escribe', async () => {
        expect((await llamar('GET', '/campaign', CONTADOR)).status).toBe(200);
        expect((await llamar('GET', '/', CONTADOR)).status).toBe(200);
        expect((await llamar('GET', '/report', CONTADOR)).status).toBe(200);
        expect((await llamar('PUT', '/campaign', CONTADOR, CAMPANA)).status).toBe(403);
        expect((await llamar('POST', '/', CONTADOR, { referred_enrollment_id: ENR, referrer_name_text: 'Ana' })).status).toBe(403);
        expect((await llamar('PATCH', `/${REFERIDO}`, CONTADOR, { action: 'anular' })).status).toBe(403);
    });

    it('sin token → 401', async () => {
        const r = await fetch(`${base}/api/v1/referidos/campaign`, { headers: { 'x-school-id': ESCUELA } });
        expect(r.status).toBe(401);
    });
});

describe('campaña', () => {
    it('GET devuelve la campaña y los tramos por defecto', async () => {
        const r = await llamar('GET', '/campaign', ADMIN);
        expect(r.status).toBe(200);
        expect(r.body.campaign).toMatchObject({ school_id: ESCUELA, kind: 'referral' });
        expect(r.body.tramos_por_defecto).toHaveLength(2);
    });

    it('GET sin campaña → campaign null (apagada por defecto)', async () => {
        estado.ref.tablas.school_discount_campaigns = [];
        const r = await llamar('GET', '/campaign', ADMIN);
        expect(r.status).toBe(200);
        expect(r.body.campaign).toBeNull();
    });

    it('PUT llama la RPC con el actor y el contrato', async () => {
        const r = await llamar('PUT', '/campaign', ADMIN, CAMPANA);
        expect(r.status).toBe(200);
        expect(estado.ref.llamadasRpc[0]).toMatchObject({
            nombre: 'upsert_school_discount_campaign',
            args: { p_school_id: ESCUELA, p_actor: ADMIN, p_active: true, p_max_pending: 12, p_require_referrer_current: true },
        });
    });

    it('PUT con tramos que se pisan → 422 sin llamar a la base', async () => {
        const r = await llamar('PUT', '/campaign', ADMIN, { ...CAMPANA, tiers: [{ age_min: 4, age_max: 15, pct: 50 }, { age_min: 10, age_max: null, pct: 25 }] });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('VALIDACION');
        expect(estado.ref.llamadasRpc).toHaveLength(0);
    });
});

describe('captura y gestión', () => {
    it('POST registra con p_actor del usuario y responde 201', async () => {
        const r = await llamar('POST', '/', DUENO, { referred_enrollment_id: ENR, referrer_name_text: 'Ana Pérez' });
        expect(r.status).toBe(201);
        expect(estado.ref.llamadasRpc[0]).toEqual({
            nombre: 'register_enrollment_referral',
            args: {
                p_school_id: ESCUELA, p_referred_enrollment_id: ENR, p_referrer_enrollment_id: null,
                p_referrer_profile_id: null, p_referrer_name_text: 'Ana Pérez', p_actor: DUENO,
            },
        });
    });

    it('POST de un menor de 4 años → 200 {ok:false, califica:false} (no es error)', async () => {
        estado.ref.rpc.register_enrollment_referral = () => ({ data: { ok: false, califica: false, motivo: 'edad_fuera_de_tramos', edad: 3 } });
        const r = await llamar('POST', '/', ADMIN, { referred_enrollment_id: ENR, referrer_name_text: 'Ana' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: false, califica: false });
    });

    it('POST sin referente → 422; misma familia → 422 en español', async () => {
        expect((await llamar('POST', '/', ADMIN, { referred_enrollment_id: ENR })).status).toBe(422);
        estado.ref.rpc.register_enrollment_referral = () => ({ error: { code: 'P0001', message: 'REF_MISMA_FAMILIA' } });
        const r = await llamar('POST', '/', ADMIN, { referred_enrollment_id: ENR, referrer_profile_id: DUENO });
        expect(r.status).toBe(422);
        expect(r.body).toMatchObject({ code: 'REF_MISMA_FAMILIA' });
    });

    it('POST con 42501 de la base (otra escuela) → 403; ya registrado → 409', async () => {
        estado.ref.rpc.register_enrollment_referral = () => ({ error: { code: '42501', message: 'No autorizado' } });
        expect((await llamar('POST', '/', ADMIN, { referred_enrollment_id: ENR, referrer_name_text: 'Ana' })).status).toBe(403);
        estado.ref.rpc.register_enrollment_referral = () => ({ error: { code: '23505', message: 'duplicate key' } });
        expect((await llamar('POST', '/', ADMIN, { referred_enrollment_id: ENR, referrer_name_text: 'Ana' })).status).toBe(409);
    });

    it('PATCH anular: firma de la RPC; id inválido, acción inválida o vincular sin referente → 422', async () => {
        const r = await llamar('PATCH', `/${REFERIDO}`, ADMIN, { action: 'anular', reason: 'Se retiró' });
        expect(r.status).toBe(200);
        expect(estado.ref.llamadasRpc[0]).toMatchObject({
            nombre: 'update_enrollment_referral',
            args: { p_referral_id: REFERIDO, p_action: 'anular', p_reason: 'Se retiró', p_actor: ADMIN },
        });
        expect((await llamar('PATCH', '/no-es-uuid', ADMIN, { action: 'anular' })).status).toBe(422);
        expect((await llamar('PATCH', `/${REFERIDO}`, ADMIN, { action: 'borrar' })).status).toBe(422);
        expect((await llamar('PATCH', `/${REFERIDO}`, ADMIN, { action: 'vincular' })).status).toBe(422);
    });

    it('PATCH sobre un referido ya aplicado → 409', async () => {
        estado.ref.rpc.update_enrollment_referral = () => ({ error: { code: 'P0001', message: 'REF_ESTADO_FINAL' } });
        expect((await llamar('PATCH', `/${REFERIDO}`, ADMIN, { action: 'anular' })).status).toBe(409);
    });
});

describe('listado e informe', () => {
    it('GET / pasa año, mes y estado a la RPC', async () => {
        const r = await llamar('GET', '/?year=2026&month=12&status=ganado', ADMIN);
        expect(r.status).toBe(200);
        expect(r.body.rows).toHaveLength(1);
        expect(estado.ref.llamadasRpc[0]).toMatchObject({
            nombre: 'referrals_report',
            args: { p_school_id: ESCUELA, p_year: 2026, p_month: 12, p_status: 'ganado', p_actor: ADMIN },
        });
    });

    it('GET /report devuelve totales; mes sin año → 422; mes 13 → 422', async () => {
        const r = await llamar('GET', '/report?year=2026', ADMIN);
        expect(r.status).toBe(200);
        expect(r.body.totals).toMatchObject({ total: 1 });
        expect((await llamar('GET', '/report?month=12', ADMIN)).status).toBe(422);
        expect((await llamar('GET', '/report?year=2026&month=13', ADMIN)).status).toBe(422);
    });

    it('«report» no se lee como :id (PATCH /report → 422 de id)', async () => {
        expect((await llamar('PATCH', '/report', ADMIN, { action: 'anular' })).status).toBe(422);
    });
});
