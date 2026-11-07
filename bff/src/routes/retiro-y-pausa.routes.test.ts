/**
 * Retiro, pausa y reactivación por canales (docs/specs/campanas-descuento-referidos-y-plazos-por-whatsapp.md §6).
 *
 * Cero red: base en memoria (supabaseFalso) y las RPC moqueadas. Aquí se prueba lo
 * que es del BFF: validación, meses completos, que la titularidad se compruebe
 * ANTES de la RPC, que el retiro jamás pase por una vía de aprobación, que resolver
 * sea solo de la administración de ESA escuela, y que el bot (sin JWT) llame con
 * service_role + p_actor. La regla del tope y la autoaprobación viven en SQL
 * (request_enrollment_pause_v2): la cubre supabase/migrations/_smoke/retiro_pausa_smoke.sql,
 * y acá solo se prueba que el BFF respete lo que la base responde.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import type { EstadoFalso } from '../services/charge-batches.test-helpers';

const estado = vi.hoisted(() => ({
    ref: null as unknown as EstadoFalso,
    /** RPC llamadas con el JWT del usuario (createClient moqueado). */
    usuario: [] as { nombre: string; args: any; authorization: string }[],
    rpcUsuario: {} as Record<string, (args: any) => { data?: any; error?: any }>,
}));
vi.mock('../config/supabase', async () => {
    const h = await import('../services/charge-batches.test-helpers');
    estado.ref = h.estadoVacio();
    return {
        supabase: h.supabaseFalso(new Proxy({} as EstadoFalso, { get: (_t, k) => (estado.ref as any)[k] })),
        SUPABASE_URL: 'http://localhost', SUPABASE_ANON_KEY: 'anon',
    };
});
vi.mock('@supabase/supabase-js', () => ({
    createClient: (_u: string, _k: string, opts: any) => ({
        rpc: async (nombre: string, args: any) => {
            estado.usuario.push({ nombre, args, authorization: opts?.global?.headers?.Authorization });
            const h = estado.rpcUsuario[nombre];
            if (!h) return { data: null, error: { code: 'PGRST202', message: 'no existe' } };
            const r = h(args);
            return { data: r.data ?? null, error: r.error ?? null };
        },
    }),
}));
vi.mock('../utils/authCache', () => ({
    getCachedUser: (_t: string, resolve: any) => resolve(),
    getCachedMembership: (_u: string, _s: any, _t: string, resolve: any) => resolve(),
    invalidateUserAuthCache: () => { },
}));

const { default: router } = await import('./retiro-y-pausa.routes');
const servicio = await import('../services/retiro-y-pausa.service');

const ESCUELA = 'e0000000-0000-4000-8000-000000000001';
const OTRA_ESCUELA = 'e0000000-0000-4000-8000-000000000002';
const ACUDIENTE = 'a0000000-0000-4000-8000-000000000001';
const AJENO = 'a0000000-0000-4000-8000-000000000002';
const ADULTO = 'a0000000-0000-4000-8000-000000000003';
const ADMIN = 'a0000000-0000-4000-8000-000000000004';
const ADMIN_OTRA = 'a0000000-0000-4000-8000-000000000005';
const HIJO = 'c0000000-0000-4000-8000-000000000001';
const ENR_HIJO = 'b0000000-0000-4000-8000-000000000001';
const ENR_ADULTO = 'b0000000-0000-4000-8000-000000000002';
const SOL = '70000000-0000-4000-8000-000000000001';

let server: http.Server;
let base: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/plan-requests', router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
    const m = (profile_id: string, role: string, school_id = ESCUELA) =>
        ({ profile_id, role, school_id, status: 'active', branch_id: null, joined_at: '2026-01-01' });
    estado.usuario = [];
    estado.rpcUsuario = {};
    estado.ref.tokens = Object.fromEntries([ACUDIENTE, AJENO, ADULTO, ADMIN, ADMIN_OTRA].map((u) => [`tok-${u}`, { id: u, email: 'x@t.co' }]));
    estado.ref.erroresTabla = {};
    estado.ref.llamadasRpc = [];
    estado.ref.rpc = {};
    estado.ref.tablas = {
        platform_admins: [],
        schools: [{ id: ESCUELA, owner_id: null }, { id: OTRA_ESCUELA, owner_id: null }],
        school_members: [
            m(ACUDIENTE, 'parent'), m(AJENO, 'parent'), m(ADULTO, 'athlete'),
            m(ADMIN, 'school_admin'), m(ADMIN_OTRA, 'school_admin', OTRA_ESCUELA),
        ],
        children: [{ id: HIJO, full_name: 'Niño Uno', parent_id: ACUDIENTE }],
        profiles: [{ id: ADULTO, full_name: 'Adulta Uno' }],
        enrollments: [
            { id: ENR_HIJO, school_id: ESCUELA, child_id: HIJO, user_id: null, status: 'active' },
            { id: ENR_ADULTO, school_id: ESCUELA, child_id: null, user_id: ADULTO, status: 'active' },
        ],
        enrollment_pause_requests: [],
        enrollment_withdrawal_requests: [],
    };
});

async function llamar(metodo: string, ruta: string, u: string, cuerpo?: unknown) {
    const r = await fetch(`${base}/api/v1/plan-requests${ruta}`, {
        method: metodo,
        headers: { 'content-type': 'application/json', authorization: `Bearer tok-${u}` },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
}

describe('POST /pausa — meses completos y lo que responde la base', () => {
    const cuerpo = { enrollment_id: ENR_HIJO, reason: 'vacation', month_from: '2026-12', month_to: '2027-01' };

    it('normaliza AAAA-MM a día 1, manda el canal app y llama con el JWT del usuario', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ data: { request_id: SOL, status: 'approved', auto_aprobada: true } });
        const r = await llamar('POST', '/pausa', ACUDIENTE, cuerpo);
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ status: 'approved', auto_aprobada: true });
        expect(estado.usuario).toHaveLength(1);
        expect(estado.usuario[0]).toEqual({
            nombre: 'request_enrollment_pause_v2',
            args: {
                p_enrollment_id: ENR_HIJO, p_reason: 'vacation', p_month_from: '2026-12-01', p_month_to: '2027-01-01',
                p_reason_note: null, p_channel: 'app',
            },
            authorization: `Bearer tok-${ACUDIENTE}`,
        });
        expect(estado.ref.llamadasRpc).toHaveLength(0); // nada con service_role
    });

    it('acepta AAAA-MM-01 y rechaza un día distinto de 1', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ data: { status: 'pending' } });
        expect((await llamar('POST', '/pausa', ACUDIENTE, { ...cuerpo, month_from: '2026-12-01' })).status).toBe(201);
        const malo = await llamar('POST', '/pausa', ACUDIENTE, { ...cuerpo, month_from: '2026-12-15' });
        expect(malo.status).toBe(400);
    });

    it('rechaza hasta < desde, más de 12 meses y motivos desconocidos (incluido no_asistio)', async () => {
        expect((await llamar('POST', '/pausa', ACUDIENTE, { ...cuerpo, month_from: '2027-02', month_to: '2027-01' })).status).toBe(400);
        expect((await llamar('POST', '/pausa', ACUDIENTE, { ...cuerpo, month_from: '2026-12', month_to: '2028-01' })).status).toBe(400);
        expect((await llamar('POST', '/pausa', ACUDIENTE, { ...cuerpo, reason: 'no_asistio' })).status).toBe(400);
        expect(estado.usuario).toHaveLength(0);
    });

    it('fuera de tope: la base la deja pendiente para la administración y el BFF lo refleja tal cual', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({
            data: { request_id: SOL, status: 'pending', auto_aprobada: false, fuera_de_tope: true, tope: 2, usados: 2 },
        });
        const r = await llamar('POST', '/pausa', ACUDIENTE, cuerpo);
        expect(r.status).toBe(201);
        expect(r.body).toMatchObject({ status: 'pending', auto_aprobada: false, fuera_de_tope: true });
    });

    it('errores de regla de la base salen con su texto y 422; los inesperados no filtran el texto', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ error: { code: 'P0001', message: 'La pausa por vacaciones no está habilitada en esta escuela.' } });
        const a = await llamar('POST', '/pausa', ACUDIENTE, cuerpo);
        expect(a.status).toBe(422);
        expect(a.body.error).toBe('La pausa por vacaciones no está habilitada en esta escuela.');

        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ error: { code: 'XX000', message: 'relation "x" secret detail' } });
        const b = await llamar('POST', '/pausa', ACUDIENTE, cuerpo);
        expect(b.status).toBe(500);
        expect(JSON.stringify(b.body)).not.toContain('secret');

        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ error: { code: 'P0001', message: 'Ya hay una solicitud de pausa pendiente para esta inscripción.' } });
        expect((await llamar('POST', '/pausa', ACUDIENTE, cuerpo)).status).toBe(409);
    });

    it('migración sin aplicar -> 503 migracion_pendiente', async () => {
        // sin handler: el mock responde PGRST202
        const r = await llamar('POST', '/pausa', ACUDIENTE, cuerpo);
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('migracion_pendiente');
    });
});

describe('permisos de titularidad', () => {
    const pausa = (enr: string) => ({ enrollment_id: enr, reason: 'other', month_from: '2026-12', month_to: '2026-12' });

    it('el acudiente solo pide por SUS hijos: otro acudiente -> 403 y la RPC ni se llama', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ data: { status: 'approved' } });
        const r = await llamar('POST', '/pausa', AJENO, pausa(ENR_HIJO));
        expect(r.status).toBe(403);
        expect(estado.usuario).toHaveLength(0);
    });

    it('el adulto pide lo suyo (201) y no la inscripción de un menor ni la de otro adulto', async () => {
        estado.rpcUsuario.request_enrollment_pause_v2 = () => ({ data: { status: 'pending' } });
        expect((await llamar('POST', '/pausa', ADULTO, pausa(ENR_ADULTO))).status).toBe(201);
        expect((await llamar('POST', '/pausa', ADULTO, pausa(ENR_HIJO))).status).toBe(403);
        expect((await llamar('POST', '/pausa', AJENO, pausa(ENR_ADULTO))).status).toBe(403);
    });

    it('una inscripción que no existe -> 404', async () => {
        const r = await llamar('POST', '/pausa', ACUDIENTE, pausa('b0000000-0000-4000-8000-0000000000ff'));
        expect(r.status).toBe(404);
    });

    it('la administración de la escuela NO pide a nombre de la familia por estas rutas (no es titular)', async () => {
        const r = await llamar('POST', '/retiro', ADMIN, { enrollment_id: ENR_HIJO, exit_date: '2026-12-01' });
        expect(r.status).toBe(403);
    });
});

describe('retiro: nunca se autoaprueba', () => {
    it('pedir retiro llama SOLO request_enrollment_withdrawal y devuelve solicitado', async () => {
        estado.rpcUsuario.request_enrollment_withdrawal = () => ({ data: { request_id: SOL, status: 'solicitado', kind: 'retiro' } });
        const r = await llamar('POST', '/retiro', ACUDIENTE, { enrollment_id: ENR_HIJO, exit_date: '2026-12-01', reason: 'Nos mudamos' });
        expect(r.status).toBe(201);
        expect(r.body.status).toBe('solicitado');
        expect(estado.usuario.map((u) => u.nombre)).toEqual(['request_enrollment_withdrawal']);
        expect(estado.usuario[0].args).toEqual({
            p_enrollment_id: ENR_HIJO, p_effective_date: '2026-12-01', p_reason: 'Nos mudamos', p_channel: 'app',
        });
    });

    it('valida la fecha de salida', async () => {
        const r = await llamar('POST', '/retiro', ACUDIENTE, { enrollment_id: ENR_HIJO, exit_date: '1 de diciembre' });
        expect(r.status).toBe(400);
        expect(estado.usuario).toHaveLength(0);
    });

    it('desde el servicio con el canal whatsapp (bot): service_role + p_actor, sin JWT', async () => {
        estado.ref.rpc.request_enrollment_withdrawal = () => ({ data: { request_id: SOL, status: 'solicitado', kind: 'retiro' } });
        const r = await servicio.pedirRetiro(
            { actorId: ACUDIENTE, canal: 'whatsapp' },
            { enrollment_id: ENR_HIJO, exit_date: '2026-12-01' },
        );
        expect(r.ok).toBe(true);
        expect(estado.usuario).toHaveLength(0);
        expect(estado.ref.llamadasRpc).toEqual([{
            nombre: 'request_enrollment_withdrawal',
            args: { p_enrollment_id: ENR_HIJO, p_effective_date: '2026-12-01', p_reason: null, p_channel: 'whatsapp', p_actor: ACUDIENTE },
        }]);
    });

    it('el bot ajeno a la inscripción no pasa (403) ni llega a la base', async () => {
        const r = await servicio.pedirRetiro(
            { actorId: AJENO, canal: 'whatsapp' },
            { enrollment_id: ENR_HIJO, exit_date: '2026-12-01' },
        );
        expect(r).toMatchObject({ ok: false, status: 403 });
        expect(estado.ref.llamadasRpc).toHaveLength(0);
    });

    it('reactivación: AAAA-MM -> día 1', async () => {
        estado.rpcUsuario.request_enrollment_reactivation = () => ({ data: { status: 'solicitado', kind: 'reactivacion' } });
        const r = await llamar('POST', '/reactivacion', ACUDIENTE, { enrollment_id: ENR_HIJO, from_month: '2027-01' });
        expect(r.status).toBe(201);
        expect(estado.usuario[0].args.p_effective_date).toBe('2027-01-01');
    });
});

describe('resolver: solo la administración de ESA escuela', () => {
    beforeEach(() => {
        estado.ref.tablas.enrollment_withdrawal_requests = [
            { id: SOL, school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, kind: 'retiro', status: 'solicitado', effective_date: '2026-12-01', channel: 'whatsapp', requester_role: 'parent', requested_at: '2026-11-06T10:00:00Z' },
        ];
        estado.rpcUsuario.resolve_enrollment_withdrawal = () => ({ data: { status: 'aprobado' } });
    });

    it('el acudiente no resuelve su propio retiro (403, sin RPC)', async () => {
        const r = await llamar('POST', `/retiro/${SOL}/resolver`, ACUDIENTE, { decision: 'aprobar' });
        expect(r.status).toBe(403);
        expect(estado.usuario).toHaveLength(0);
    });

    it('el administrador de OTRA escuela -> 403', async () => {
        const r = await llamar('POST', `/retiro/${SOL}/resolver`, ADMIN_OTRA, { decision: 'aprobar' });
        expect(r.status).toBe(403);
        expect(estado.usuario).toHaveLength(0);
    });

    it('la administración aprueba con su JWT y la firma de la RPC', async () => {
        const r = await llamar('POST', `/retiro/${SOL}/resolver`, ADMIN, { decision: 'aprobar', note: 'ok', dar_de_baja: true });
        expect(r.status).toBe(200);
        expect(estado.usuario).toEqual([{
            nombre: 'resolve_enrollment_withdrawal',
            args: { p_request_id: SOL, p_decision: 'aprobar', p_review_note: 'ok', p_dar_de_baja: true },
            authorization: `Bearer tok-${ADMIN}`,
        }]);
    });

    it('una solicitud inexistente -> 404; tipo inválido -> 400', async () => {
        expect((await llamar('POST', '/retiro/70000000-0000-4000-8000-0000000000ff/resolver', ADMIN, { decision: 'aprobar' })).status).toBe(404);
        expect((await llamar('POST', `/cualquiera/${SOL}/resolver`, ADMIN, { decision: 'aprobar' })).status).toBe(400);
    });

    it('pausa: aprobar/rechazar usa approve_/reject_enrollment_pause; dar_de_baja no aplica', async () => {
        estado.ref.tablas.enrollment_pause_requests = [
            { id: SOL, school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, status: 'pending', month_from: '2026-12-01', month_to: '2026-12-01', reason: 'other', source: 'parent', requested_at: '2026-11-06T10:00:00Z' },
        ];
        estado.rpcUsuario.approve_enrollment_pause = () => ({ data: { payments_cancelled: 1 } });
        estado.rpcUsuario.reject_enrollment_pause = () => ({ data: { status: 'rejected' } });
        expect((await llamar('POST', `/pausa/${SOL}/resolver`, ADMIN, { decision: 'aprobar' })).status).toBe(200);
        expect((await llamar('POST', `/pausa/${SOL}/resolver`, ADMIN, { decision: 'rechazar', note: 'no' })).status).toBe(200);
        expect(estado.usuario.map((u) => u.nombre)).toEqual(['approve_enrollment_pause', 'reject_enrollment_pause']);
        expect((await llamar('POST', `/pausa/${SOL}/resolver`, ADMIN, { decision: 'aprobar', dar_de_baja: true })).status).toBe(400);
    });

    it('sin JWT (bot) el servicio se niega a resolver', async () => {
        const r = await servicio.resolverSolicitud({ actorId: ADMIN, canal: 'whatsapp' }, 'retiro', SOL, { decision: 'aprobar' });
        expect(r).toMatchObject({ ok: false, status: 403 });
        expect(estado.ref.llamadasRpc).toHaveLength(0);
    });
});

describe('cancelar y listar', () => {
    it('DELETE llama cancel_enrollment_request con el tipo y el JWT', async () => {
        estado.rpcUsuario.cancel_enrollment_request = () => ({ data: { status: 'cancelado' } });
        const r = await llamar('DELETE', `/retiro/${SOL}`, ACUDIENTE);
        expect(r.status).toBe(200);
        expect(estado.usuario[0]).toMatchObject({ nombre: 'cancel_enrollment_request', args: { p_tipo: 'retiro', p_request_id: SOL } });
    });

    it('si la base dice que no es suya -> 403', async () => {
        estado.rpcUsuario.cancel_enrollment_request = () => ({ error: { code: 'P0001', message: 'No autorizado.' } });
        expect((await llamar('DELETE', `/pausa/${SOL}`, AJENO)).status).toBe(403);
    });

    it('/mias: el acudiente ve las de su hijo con nombre y estado unificado; el ajeno ve 0', async () => {
        estado.ref.tablas.enrollment_pause_requests = [
            { id: 'p1', school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, status: 'pending', month_from: '2026-12-01', month_to: '2027-01-01', reason: 'vacation', source: 'parent', channel: 'whatsapp', auto_approved: false, fuera_de_tope: true, requested_at: '2026-11-06T10:00:00Z' },
            { id: 'p2', school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, status: 'approved', month_from: '2026-03-01', month_to: '2026-03-01', reason: 'no_asistio', source: 'admin', requested_at: '2026-03-01T10:00:00Z' },
        ];
        estado.ref.tablas.enrollment_withdrawal_requests = [
            { id: 'w1', school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, kind: 'retiro', status: 'solicitado', effective_date: '2026-12-01', channel: 'app', requester_role: 'parent', requested_at: '2026-11-07T10:00:00Z' },
        ];
        const r = await llamar('GET', '/mias', ACUDIENTE);
        expect(r.status).toBe(200);
        expect(r.body.solicitudes.map((s: any) => s.id)).toEqual(['w1', 'p1']); // más reciente primero; 'no_asistio' fuera
        expect(r.body.solicitudes[1]).toMatchObject({ tipo: 'pausa', estado: 'solicitado', atleta_nombre: 'Niño Uno', canal: 'whatsapp', fuera_de_tope: true, desde: '2026-12-01', hasta: '2027-01-01' });
        expect((await llamar('GET', '/mias', AJENO)).body.solicitudes).toEqual([]);
        expect((await llamar('GET', '/mias?estado=aprobado', ACUDIENTE)).body.solicitudes).toEqual([]);
    });

    it('/escuela/:id: solo administración de esa escuela', async () => {
        estado.ref.tablas.enrollment_withdrawal_requests = [
            { id: 'w1', school_id: ESCUELA, enrollment_id: ENR_HIJO, child_id: HIJO, kind: 'reactivacion', status: 'solicitado', effective_date: '2027-01-01', channel: 'whatsapp', requester_role: 'parent', requested_at: '2026-11-07T10:00:00Z' },
        ];
        const ok = await llamar('GET', `/escuela/${ESCUELA}?tipo=reactivacion`, ADMIN);
        expect(ok.status).toBe(200);
        expect(ok.body.solicitudes).toHaveLength(1);
        expect(ok.body.solicitudes[0]).toMatchObject({ tipo: 'reactivacion', canal: 'whatsapp', atleta_nombre: 'Niño Uno' });
        expect((await llamar('GET', `/escuela/${ESCUELA}`, ADMIN_OTRA)).status).toBe(403);
        expect((await llamar('GET', `/escuela/${ESCUELA}`, ACUDIENTE)).status).toBe(403);
        expect((await llamar('GET', '/escuela/no-es-uuid', ADMIN)).status).toBe(400);
    });
});

describe('normalizarMes / mesesEntre', () => {
    it('meses completos', () => {
        expect(servicio.normalizarMes('2026-12')).toBe('2026-12-01');
        expect(servicio.normalizarMes('2026-12-01')).toBe('2026-12-01');
        expect(servicio.normalizarMes('2026-12-02')).toBeNull();
        expect(servicio.normalizarMes('2026-13')).toBeNull();
        expect(servicio.mesesEntre('2026-12-01', '2027-02-01')).toBe(3);
    });
});
