/**
 * Rutas del modal «Cobros y pagos» (spec cobros-multiples §9.4, F2).
 *
 * Lo que se vigila es sobre todo el «no»: el BFF entra con service_role, así
 * que si la autorización dice sí se crea deuda o se registra plata. Por eso se
 * usa el requireAuth REAL (con la base falsa) y se prueba cada rol.
 *
 * Cero red y cero base: Supabase moqueado (base en memoria) y las RPC de F1
 * moqueadas — todavía no están aplicadas.
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
    // Proxy: cada prueba reemplaza estado.ref.* sin perder la referencia.
    return { supabase: h.supabaseFalso(new Proxy({} as EstadoFalso, { get: (_t, k) => (estado.ref as any)[k] })) };
});
vi.mock('../utils/authCache', () => ({
    getCachedUser: (_t: string, resolve: any) => resolve(),
    getCachedMembership: (_u: string, _s: any, _t: string, resolve: any) => resolve(),
    invalidateUserAuthCache: () => { },
}));

const { default: chargeBatchesRouter } = await import('./charge-batches.routes');
const { chargeBatchRateLimit } = await import('../middlewares/chargeBatchRateLimit');
const { cobrosRateLimit } = await import('../middlewares/cobrosRateLimit');
const { todayInZone, addDaysToDateString } = await import('../utils/businessDate');

// ─── Datos ───────────────────────────────────────────────────────────────────
const ESCUELA = 'e0000000-0000-4000-8000-000000000001';
const OTRA = 'e0000000-0000-4000-8000-000000000002';
const DUENO = 'a0000000-0000-4000-8000-000000000001';
const ADMIN = 'a0000000-0000-4000-8000-000000000002';
const SCHOOL_ADMIN = 'a0000000-0000-4000-8000-000000000003';
const CONTADOR = 'a0000000-0000-4000-8000-000000000004';
const COACH = 'a0000000-0000-4000-8000-000000000005';
const PADRE = 'a0000000-0000-4000-8000-000000000006';
const PLATAFORMA = 'a0000000-0000-4000-8000-000000000007';
const ADMIN_OTRA = 'a0000000-0000-4000-8000-000000000008';
const MIEMBRO_OWNER = 'a0000000-0000-4000-8000-000000000009';

const NINO = 'c0000000-0000-4000-8000-000000000001';
const NINO_OTRA = 'c0000000-0000-4000-8000-000000000002';
const FICHA = 'c0000000-0000-4000-8000-000000000003';
const EQUIPO = 'd0000000-0000-4000-8000-000000000001';
const EQUIPO_OTRA = 'd0000000-0000-4000-8000-000000000002';
const COBRO = 'f0000000-0000-4000-8000-000000000001';
const COBRO_OTRA = 'f0000000-0000-4000-8000-000000000002';
const LOTE = 'b0000000-0000-4000-8000-000000000001';
const EXCEDENTE = '90000000-0000-4000-8000-000000000001';

const HOY = todayInZone();
const VENCE = addDaysToDateString(HOY, 5);
const [ANIO, MES] = [Number(HOY.slice(0, 4)), Number(HOY.slice(5, 7))];

const token = (id: string) => `tok-${id}`;

let server: http.Server;
let base: string;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/charge-batches', chargeBatchesRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(async () => {
    chargeBatchRateLimit.reset();
    await cobrosRateLimit.reset();
    const usuarios = [DUENO, ADMIN, SCHOOL_ADMIN, CONTADOR, COACH, PADRE, PLATAFORMA, ADMIN_OTRA, MIEMBRO_OWNER];
    estado.ref.tokens = Object.fromEntries(usuarios.map((u) => [token(u), { id: u, email: `${u}@t.co` }]));
    estado.ref.erroresTabla = {};
    estado.ref.llamadasRpc = [];
    const m = (profile_id: string, role: string, school_id = ESCUELA) =>
        ({ profile_id, role, school_id, status: 'active', branch_id: null, joined_at: '2026-01-01' });
    estado.ref.tablas = {
        schools: [{ id: ESCUELA, owner_id: DUENO }, { id: OTRA, owner_id: ADMIN_OTRA }],
        school_members: [
            m(DUENO, 'owner'), m(ADMIN, 'admin'), m(SCHOOL_ADMIN, 'school_admin'), m(CONTADOR, 'accountant'),
            m(COACH, 'coach'), m(PADRE, 'parent'), m(ADMIN_OTRA, 'school_admin', OTRA), m(MIEMBRO_OWNER, 'owner'),
        ],
        platform_admins: [{ profile_id: PLATAFORMA, is_active: true }],
        // Rol global autoasignado: no debe abrir nada.
        profiles: [{ id: ADMIN_OTRA, role: 'admin', full_name: 'Admin Otra' }, { id: DUENO, full_name: 'Dueña' }],
        children: [
            { id: NINO, school_id: ESCUELA, full_name: 'Niño Uno', parent_id: PADRE, doc_number: '1000000001', parent_phone_temp: null },
            { id: NINO_OTRA, school_id: OTRA, full_name: 'Niño Ajeno', parent_id: null, doc_number: null },
        ],
        unregistered_athletes: [{ id: FICHA, school_id: ESCUELA, full_name: 'Adulta Sin Cuenta', doc_number: '52000111', phone: '3001234567', guardian_phone: null }],
        enrollments: [
            { id: 'en-1', school_id: ESCUELA, child_id: NINO, user_id: null, unregistered_athlete_id: null, team_id: EQUIPO, offering_plan_id: null, status: 'active', paused_at: null, paused_until: null },
        ],
        teams: [{ id: EQUIPO, school_id: ESCUELA, name: 'Sub-12' }, { id: EQUIPO_OTRA, school_id: OTRA, name: 'Ajeno' }],
        payments: [
            { id: COBRO, school_id: ESCUELA, child_id: NINO, user_id: null, unregistered_athlete_id: null, status: 'pending', amount: 150000 },
            { id: COBRO_OTRA, school_id: OTRA, child_id: NINO_OTRA, status: 'pending', amount: 1 },
        ],
        hour_bank_overage_charges: [{ id: EXCEDENTE, school_id: ESCUELA, status: 'suggested' }],
        charge_batches: [],
    };
    estado.ref.rpc = {
        preview_charge_batch: () => ({ data: { rows_to_create: 1, total_amount: 80000, preview_hash: 'h1', skipped: [] } }),
        create_charge_batch: (a) => ({ data: { batch_id: LOTE, duplicated: false, rows_created: 1, total_amount: 80000, _req: a.p_client_request_id } }),
        annul_charge_batch: () => ({ data: { annulled: 3, kept: [] } }),
    };
});

async function llamar(metodo: string, ruta: string, usuario: string | null, cuerpo?: unknown, escuela = ESCUELA) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-school-id': escuela };
    if (usuario) headers.authorization = `Bearer ${token(usuario)}`;
    const r = await fetch(`${base}/api/v1/charge-batches${ruta}`, { method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) as any };
}

const torneo = (extra: Record<string, unknown> = {}) => ({
    category: 'torneo', amount: 80000, due_date: VENCE, concept: 'Torneo Copa Pony', ...extra,
});
const pedido = (extra: Record<string, unknown> = {}) => ({
    mode: 'single',
    target: { kind: 'athlete', ids: [NINO] },
    athletes: [{ type: 'child', id: NINO }],
    lines: [torneo()],
    ...extra,
});
const crear = (extra: Record<string, unknown> = {}) => ({
    ...pedido(),
    client_request_id: '11111111-1111-4111-8111-111111111111',
    preview_hash: 'h1',
    ...extra,
});

const rpcLlamadas = (n: string) => estado.ref.llamadasRpc.filter((c) => c.nombre === n);

// ─────────────────────────────────────────────────────────────────────────────

describe('autorización por rol en ESTA escuela', () => {
    it.each([
        ['dueño (schools.owner_id)', DUENO],
        ['admin', ADMIN],
        ['school_admin', SCHOOL_ADMIN],
        ['miembro con rol owner', MIEMBRO_OWNER],
        ['super_admin de plataforma', PLATAFORMA],
    ])('%s: preview y create 200', async (_n, u) => {
        expect((await llamar('POST', '/preview', u, pedido())).status).toBe(200);
        expect((await llamar('POST', '/', u, crear())).status).toBe(200);
    });

    it.each([
        ['coach', COACH],
        ['acudiente', PADRE],
        ['contador', CONTADOR],
    ])('%s: 403 en preview, create y annul, sin llamar la RPC', async (_n, u) => {
        expect((await llamar('POST', '/preview', u, pedido())).status).toBe(403);
        expect((await llamar('POST', '/', u, crear())).status).toBe(403);
        expect((await llamar('POST', `/${LOTE}/annul`, u, { reason: 'error', expected_count: 1 })).status).toBe(403);
        expect(estado.ref.llamadasRpc).toHaveLength(0);
    });

    it('coach con descuento o con pago → 403 (no 422): el permiso va antes que los datos', async () => {
        const r = await llamar('POST', '/', COACH, crear({
            lines: [torneo({ discount: { basis: 'porcentaje', value: 10, reason_code: 'convenio' }, pay_amount: 80000 })],
            payment: { method: 'cash', payment_date: HOY },
        }));
        expect(r.status).toBe(403);
    });

    it('admin de OTRA escuela pidiendo esta escuela → 403', async () => {
        expect((await llamar('POST', '/preview', ADMIN_OTRA, pedido())).status).toBe(403);
    });

    it('sin token → 401', async () => {
        expect((await llamar('POST', '/preview', null, pedido())).status).toBe(401);
    });

    it('contador: 200 en el historial y el detalle', async () => {
        estado.ref.tablas.charge_batches = [{ id: LOTE, school_id: ESCUELA, created_by: DUENO, created_at: '2026-10-10T10:00:00Z', status: 'created' }];
        expect((await llamar('GET', '/', CONTADOR)).status).toBe(200);
        expect((await llamar('GET', `/${LOTE}`, CONTADOR)).status).toBe(200);
    });

    it('coach: 403 en el historial', async () => {
        expect((await llamar('GET', '/', COACH)).status).toBe(403);
    });
});

describe('validación (422 en español)', () => {
    const casos: [string, Record<string, unknown>][] = [
        ['mensualidad sin período', pedido({ lines: [{ category: 'mensualidad', due_date: VENCE, concept: 'Mensualidad' }] })],
        ['excedente sin overage_charge_id', pedido({ lines: [torneo({ category: 'excedente' })] })],
        ['201 atletas', pedido({ mode: 'multi', target: { kind: 'list', ids: [] }, athletes: Array.from({ length: 201 }, (_, i) => ({ type: 'child', id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` })) })],
        ['601 filas', pedido({ mode: 'multi', target: { kind: 'list', ids: [] }, athletes: Array.from({ length: 61 }, (_, i) => ({ type: 'child', id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` })), lines: Array.from({ length: 10 }, () => torneo()) })],
        ['modo varios con pendientes', pedido({ mode: 'multi', pending: [{ payment_id: COBRO, seen: { amount: 1, amount_paid: 0 }, pay_amount: 1 }] })],
        ['modo varios con pago', pedido({ mode: 'multi', payment: { method: 'cash', payment_date: HOY } })],
        ['porcentaje 101', pedido({ lines: [torneo({ discount: { basis: 'porcentaje', value: 101, reason_code: 'beca' } })] })],
        ['motivo «otro» sin texto', pedido({ lines: [torneo({ discount: { basis: 'valor', value: 1000, reason_code: 'otro' } })] })],
        ['cerrar sin motivo', pedido({ pending: [{ payment_id: COBRO, seen: { amount: 150000, amount_paid: 0 }, pay_amount: 100000, close_mode: 'cerrar' }], payment: { method: 'cash', payment_date: HOY } })],
        ['vencimiento en el pasado', pedido({ lines: [torneo({ due_date: addDaysToDateString(HOY, -1) })] })],
        ['sin atleta (cobro al aire, T34)', pedido({ athletes: [] })],
        ['mensualidad a 4 meses', pedido({ lines: [{ category: 'mensualidad', due_date: VENCE, concept: 'M', period: { year: ANIO + (MES + 4 > 12 ? 1 : 0), month: ((MES + 4 - 1) % 12) + 1 } }] })],
    ];
    it.each(casos)('%s → 422', async (_n, cuerpo) => {
        const r = await llamar('POST', '/preview', DUENO, cuerpo);
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('VALIDACION');
        expect(typeof r.body.error).toBe('string');
        expect(rpcLlamadas('preview_charge_batch')).toHaveLength(0);
    });

    it('el create exige preview_hash y client_request_id', async () => {
        const r = await llamar('POST', '/', DUENO, pedido());
        expect(r.status).toBe(422);
    });
});

describe('pago sin comprobante deja constancia (quién lo recibió)', () => {
    const conPago = (pago: Record<string, unknown>) => crear({ lines: [torneo({ pay_amount: 80000 })], payment: { method: 'cash', payment_date: HOY, ...pago } });

    it('sin comprobante y sin received_by → 422 y no se crea nada', async () => {
        const r = await llamar('POST', '/', DUENO, conPago({}));
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('RECIBIDO_POR_OBLIGATORIO');
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(0);
    });

    it('received_by de una letra o solo signos → 422', async () => {
        expect((await llamar('POST', '/', DUENO, conPago({ received_by: 'A' }))).status).toBe(422);
        expect((await llamar('POST', '/', DUENO, conPago({ received_by: '[·]' }))).status).toBe(422);
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(0);
    });

    it('con received_by → crea y la RPC recibe el pago', async () => {
        const r = await llamar('POST', '/', DUENO, conPago({ received_by: 'Alejandra L.' }));
        expect(r.status).toBe(200);
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(1);
        // received_by lo usa el BFF; a la RPC no viaja.
        const pago = (rpcLlamadas('create_charge_batch')[0] as any).args.p_payment;
        expect(pago).toMatchObject({ method: 'cash', payment_date: HOY });
        expect('received_by' in pago).toBe(false);
    });

    it('con comprobante no se exige received_by', async () => {
        const r = await llamar('POST', '/', DUENO, conPago({ method: 'transfer', receipt_url: 'u1/soporte.png' }));
        expect(r.status).toBe(200);
    });

    it('la vista previa NO exige received_by (el dato se pide al confirmar)', async () => {
        const r = await llamar('POST', '/preview', DUENO, pedido({ lines: [torneo({ pay_amount: 80000 })], payment: { method: 'cash', payment_date: HOY } }));
        expect(r.status).toBe(200);
    });
});

describe('pertenencia a la escuela (404 antes de la RPC)', () => {
    it('atleta de otra escuela → 404', async () => {
        const r = await llamar('POST', '/preview', DUENO, pedido({ athletes: [{ type: 'child', id: NINO_OTRA }] }));
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('ATLETA_AJENO');
        expect(rpcLlamadas('preview_charge_batch')).toHaveLength(0);
    });

    it('equipo de otra escuela → 404', async () => {
        const r = await llamar('POST', '/preview', DUENO, pedido({ mode: 'multi', target: { kind: 'team', ids: [EQUIPO_OTRA] } }));
        expect(r.status).toBe(404);
    });

    it('pendiente de otra escuela → 404', async () => {
        const r = await llamar('POST', '/preview', DUENO, pedido({
            lines: [],
            pending: [{ payment_id: COBRO_OTRA, seen: { amount: 1, amount_paid: 0 } }],
        }));
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('COBRO_AJENO');
    });

    it('excedente: solo el dueño (H4); el admin recibe 403', async () => {
        const linea = { category: 'excedente', amount: 419188, due_date: VENCE, concept: 'Horas adicionales', overage_charge_id: EXCEDENTE };
        expect((await llamar('POST', '/preview', ADMIN, pedido({ lines: [linea] }))).status).toBe(403);
        expect((await llamar('POST', '/preview', DUENO, pedido({ lines: [linea] }))).status).toBe(200);
    });
});

describe('contrato con las RPC', () => {
    it('preview: firma de §7.2 con p_actor = usuario y p_school_id = escuela del token', async () => {
        await llamar('POST', '/preview', ADMIN, pedido());
        const [c] = rpcLlamadas('preview_charge_batch');
        expect(Object.keys(c.args).sort()).toEqual(['p_actor', 'p_athletes', 'p_global_discount', 'p_lines', 'p_payment', 'p_pending', 'p_school_id'].sort());
        expect(c.args).toMatchObject({ p_school_id: ESCUELA, p_actor: ADMIN, p_athletes: [{ type: 'child', id: NINO }] });
        expect(c.args.p_lines[0]).toMatchObject({ idx: 0, category: 'torneo', amount: 80000, due_date: VENCE });
    });

    it('create: firma de §7.3 con client_request_id, hash, overrides y notify', async () => {
        await llamar('POST', '/', ADMIN, crear({ notify_families: true, overrides: [{ athlete: NINO, line_idx: 0, action: 'force' }] }));
        const [c] = rpcLlamadas('create_charge_batch');
        expect(c.args).toMatchObject({
            p_school_id: ESCUELA, p_actor: ADMIN, p_client_request_id: '11111111-1111-4111-8111-111111111111',
            p_mode: 'single', p_target: { kind: 'athlete', ids: [NINO] }, p_preview_hash: 'h1', p_notify: true,
            p_overrides: [{ athlete: NINO, line_idx: 0, action: 'force' }], p_pending: [], p_global_discount: null, p_payment: null,
        });
        expect(c.args).not.toHaveProperty('p_new_athlete');
    });

    it('atleta nuevo: se manda p_new_athlete', async () => {
        await llamar('POST', '/preview', ADMIN, pedido({
            athletes: [], target: { kind: 'athlete', ids: [] },
            new_athlete: { kind: 'menor', full_name: 'Visitante Nuevo', guardian_phone: '3009998888' },
            lines: [torneo({ category: 'clase_extra' })],
        }));
        const [c] = rpcLlamadas('preview_charge_batch');
        expect(c.args.p_new_athlete).toMatchObject({ kind: 'menor', full_name: 'Visitante Nuevo', allow_duplicate: false });
        expect(c.args.p_athletes).toEqual([]);
    });
});

describe('idempotencia (client_request_id)', () => {
    it('mismo client_request_id → mismo batch_id con duplicated:true (lo decide la RPC; el BFF lo pasa tal cual)', async () => {
        const vistos = new Set<string>();
        estado.ref.rpc.create_charge_batch = (a) => {
            const dup = vistos.has(a.p_client_request_id);
            vistos.add(a.p_client_request_id);
            return { data: { batch_id: LOTE, duplicated: dup, rows_created: 1, total_amount: 80000 } };
        };
        const r1 = await llamar('POST', '/', ADMIN, crear());
        const r2 = await llamar('POST', '/', ADMIN, crear());
        expect(r1.body).toMatchObject({ batch_id: LOTE, duplicated: false });
        expect(r2.status).toBe(200);
        expect(r2.body).toMatchObject({ batch_id: LOTE, duplicated: true });
    });
});

describe('mismo cobro desde otra pantalla (COBRO_DUPLICADO_RECIENTE)', () => {
    const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    const loteAjeno = (extra: Record<string, unknown> = {}) => ({
        id: LOTE, school_id: ESCUELA, client_request_id: '99999999-9999-4999-8999-999999999999',
        mode: 'single', target: { kind: 'athlete', ids: [NINO] },
        lines: [{ idx: 0, category: 'torneo', amount: 80000, concept: 'Torneo Copa Pony', due_date: VENCE, pay_amount: 0 }],
        created_by: DUENO, created_at: hace(3), annulled_at: null, total_amount: 80000, ...extra,
    });

    it('create: otro lote idéntico de hace 3 min → 409 con quién y cuándo, y NO llama la RPC', async () => {
        estado.ref.tablas.charge_batches = [loteAjeno()];
        const r = await llamar('POST', '/', ADMIN, crear());
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('COBRO_DUPLICADO_RECIENTE');
        expect(r.body.duplicates).toHaveLength(1);
        expect(r.body.duplicates[0]).toMatchObject({ batch_id: LOTE, created_by_name: 'Dueña', minutes_ago: 3 });
        expect(r.body.error).toMatch(/ya se registró hace 3 min por Dueña/i);
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(0);
    });

    it('confirmar_duplicado:true → crea igual, con el mismo client_request_id', async () => {
        estado.ref.tablas.charge_batches = [loteAjeno()];
        const r = await llamar('POST', '/', ADMIN, crear({ confirmar_duplicado: true }));
        expect(r.status).toBe(200);
        const [c] = rpcLlamadas('create_charge_batch');
        expect(c.args.p_client_request_id).toBe('11111111-1111-4111-8111-111111111111');
        expect(c.args).not.toHaveProperty('confirmar_duplicado');
    });

    it('el reintento del MISMO client_request_id jamás cae en el bloqueo (sigue idempotente)', async () => {
        estado.ref.tablas.charge_batches = [loteAjeno({ client_request_id: '11111111-1111-4111-8111-111111111111' })];
        const r = await llamar('POST', '/', ADMIN, crear());
        expect(r.status).toBe(200);
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(1);
    });

    it.each([
        ['de hace 20 min (fuera de la ventana)', { created_at: hace(20) }],
        ['anulado', { annulled_at: hace(1) }],
        ['con otro valor', { lines: [{ idx: 0, category: 'torneo', amount: 90000, concept: 'Torneo Copa Pony', due_date: VENCE, pay_amount: 0 }] }],
        ['con otro concepto', { lines: [{ idx: 0, category: 'torneo', amount: 80000, concept: 'Torneo Otra Copa', due_date: VENCE, pay_amount: 0 }] }],
        ['de otro atleta', { target: { kind: 'athlete', ids: [NINO_OTRA] } }],
        ['de otra escuela', { school_id: OTRA }],
    ])('un lote %s no bloquea', async (_n, extra) => {
        estado.ref.tablas.charge_batches = [loteAjeno(extra)];
        expect((await llamar('POST', '/', ADMIN, crear())).status).toBe(200);
    });

    it('preview: avisa con recent_duplicates (no bloquea) y sin coincidencias no agrega la clave', async () => {
        estado.ref.tablas.charge_batches = [loteAjeno()];
        const con = await llamar('POST', '/preview', ADMIN, pedido());
        expect(con.status).toBe(200);
        expect(con.body.preview_hash).toBe('h1');
        expect(con.body.recent_duplicates).toHaveLength(1);
        estado.ref.tablas.charge_batches = [];
        const sin = await llamar('POST', '/preview', ADMIN, pedido());
        expect(sin.body).not.toHaveProperty('recent_duplicates');
    });

    it('si la consulta de lotes recientes falla, no frena una operación legítima', async () => {
        estado.ref.tablas.charge_batches = [loteAjeno()];
        estado.ref.erroresTabla = { charge_batches: { code: 'XX000', message: 'boom' } };
        expect((await llamar('POST', '/', ADMIN, crear())).status).toBe(200);
    });
});

describe('errores de la RPC → HTTP + mensaje en español', () => {
    const casos: [string, any, number][] = [
        ['PREVIEW_STALE', { code: 'P0001', message: 'PREVIEW_STALE' }, 409],
        ['COBRO_CAMBIO', { code: 'P0001', message: 'COBRO_CAMBIO: el cobro ya está pagado' }, 409],
        ['EN_REVISION', { code: 'P0001', message: 'EN_REVISION' }, 409],
        ['PAGO_EN_CURSO', { code: 'P0001', message: 'PAGO_EN_CURSO' }, 409],
        ['COBRO_CERRADO', { code: 'P0001', message: 'COBRO_CERRADO' }, 409],
        ['ATLETA_DUPLICADO', { code: 'P0001', message: 'ATLETA_DUPLICADO', details: '{"id":"x","full_name":"Niño Uno"}' }, 409],
        ['PERIODO_DUPLICADO', { code: '23505', message: 'duplicate key value violates unique constraint "uniq_payment_active_period_per_child"' }, 409],
        ['DESCUENTO_EXCEDE', { code: 'P0001', message: 'DESCUENTO_EXCEDE' }, 422],
        ['SOBREPAGO', { code: 'P0001', message: 'SOBREPAGO' }, 422],
        ['MULTI_NO_PAGA', { code: 'P0001', message: 'MULTI_NO_PAGA' }, 422],
        ['SIN_PERMISO', { code: 'P0001', message: 'FORBIDDEN: actor no es admin' }, 403],
        ['COBROS_NO_DISPONIBLE', { code: 'PGRST202', message: 'Could not find the function public.create_charge_batch' }, 503],
        ['ERROR_INTERNO', { code: 'XX000', message: 'algo raro' }, 500],
    ];
    it.each(casos)('%s', async (codigo, error, status) => {
        estado.ref.rpc.create_charge_batch = () => ({ error });
        const r = await llamar('POST', '/', ADMIN, crear());
        expect(r.status).toBe(status);
        expect(r.body.code).toBe(codigo);
        expect(r.body.error).toMatch(/[a-záéíóúñ]/i);
        expect(r.body.error).not.toContain('duplicate key'); // nunca el texto crudo de Postgres
        if (codigo === 'ATLETA_DUPLICADO') expect(r.body.detalle).toMatchObject({ full_name: 'Niño Uno' });
    });
});

describe('límites de Q11 (429)', () => {
    it('el 11.º lote en 10 minutos del mismo usuario → 429; los reintentos del mismo lote no cuentan', async () => {
        for (let i = 0; i < 10; i++) {
            const id = `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
            expect((await llamar('POST', '/', ADMIN, crear({ client_request_id: id }))).status).toBe(200);
        }
        // Reintento de un lote ya contado: pasa.
        expect((await llamar('POST', '/', ADMIN, crear({ client_request_id: '11111111-1111-4111-8111-000000000003' }))).status).toBe(200);
        const r = await llamar('POST', '/', ADMIN, crear({ client_request_id: '22222222-2222-4222-8222-222222222222' }));
        expect(r.status).toBe(429);
        expect(r.body.code).toBe('RATE_LIMITED');
        expect(rpcLlamadas('create_charge_batch')).toHaveLength(11);
    });

    it('más de 2.000 cobros por hora en la escuela → 429', async () => {
        const muchos = Array.from({ length: 200 }, (_, i) => ({ type: 'child', id: `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
        estado.ref.tablas.children.push(...muchos.map((a) => ({ id: a.id, school_id: ESCUELA, full_name: 'x' })));
        const lote = (n: number) => crear({
            mode: 'multi', target: { kind: 'list', ids: [] }, athletes: muchos,
            lines: [torneo(), torneo(), torneo()], client_request_id: `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`,
        });
        // 3 lotes × 600 = 1.800; el cuarto pasaría a 2.400.
        for (let i = 0; i < 3; i++) expect((await llamar('POST', '/', ADMIN, lote(i))).status).toBe(200);
        const r = await llamar('POST', '/', DUENO, lote(9));
        expect(r.status).toBe(429);
        expect(r.body.error).toContain('2000');
    });
});

describe('cupos por usuario (cobrosRateLimit) en vez del paymentLimiter por IP', () => {
    const limite = async (metodo: string, ruta: string, usuario: string, cuerpo?: unknown) => {
        const r = await fetch(`${base}/api/v1/charge-batches${ruta}`, {
            method: metodo,
            headers: { 'content-type': 'application/json', 'x-school-id': ESCUELA, authorization: `Bearer ${token(usuario)}` },
            body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        });
        return { status: r.status, limit: r.headers.get('ratelimit-limit') };
    };

    it('lecturas → 120/min; preview → 60/min; confirmar y anular → 20/min', async () => {
        expect(await limite('GET', `/targets?kind=team&id=${EQUIPO}`, ADMIN)).toEqual({ status: 200, limit: '120' });
        expect((await limite('GET', '/athlete-search?q=nino', ADMIN)).limit).toBe('120');
        expect((await limite('GET', '/', ADMIN)).limit).toBe('120');
        expect(await limite('POST', '/preview', ADMIN, pedido())).toEqual({ status: 200, limit: '60' });
        expect(await limite('POST', '/', ADMIN, crear())).toEqual({ status: 200, limit: '20' });
        expect((await limite('POST', `/${LOTE}/annul`, ADMIN, { reason: 'Lote por error', expected_count: 3 })).limit).toBe('20');
    });

    it('25 vistas previas seguidas del mismo usuario pasan (antes: 429 a la 21.ª); otro usuario no comparte cupo', async () => {
        for (let i = 0; i < 25; i++) expect((await limite('POST', '/preview', ADMIN, pedido())).status).toBe(200);
        const r = await fetch(`${base}/api/v1/charge-batches/preview`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-school-id': ESCUELA, authorization: `Bearer ${token(DUENO)}` },
            body: JSON.stringify(pedido()),
        });
        expect(r.headers.get('ratelimit-remaining')).toBe('59');
    });

    it('sin token: 401 de requireAuth antes de gastar cupo', async () => {
        const r = await fetch(`${base}/api/v1/charge-batches/targets`, { headers: { 'x-school-id': ESCUELA } });
        expect(r.status).toBe(401);
        expect(r.headers.get('ratelimit-limit')).toBeNull();
    });
});

describe('anular, historial, destinos y buscador', () => {
    it('annul pasa motivo y expected_count a la RPC; ANNUL_STALE → 409', async () => {
        const ok = await llamar('POST', `/${LOTE}/annul`, ADMIN, { reason: 'Lote por error', expected_count: 3 });
        expect(ok.status).toBe(200);
        expect(rpcLlamadas('annul_charge_batch')[0].args).toEqual({
            p_school_id: ESCUELA, p_actor: ADMIN, p_batch_id: LOTE, p_reason: 'Lote por error', p_expected_count: 3,
        });
        estado.ref.rpc.annul_charge_batch = () => ({ error: { code: 'P0001', message: 'ANNUL_STALE' } });
        const r = await llamar('POST', `/${LOTE}/annul`, ADMIN, { reason: 'Lote por error', expected_count: 2 });
        expect(r.status).toBe(409);
        expect(r.body.code).toBe('ANNUL_STALE');
    });

    it('annul sin motivo → 422', async () => {
        expect((await llamar('POST', `/${LOTE}/annul`, ADMIN, { reason: 'x', expected_count: 1 })).status).toBe(422);
    });

    it('detalle de un lote de otra escuela → 404', async () => {
        estado.ref.tablas.charge_batches = [{ id: LOTE, school_id: OTRA, created_at: '2026-10-10T00:00:00Z' }];
        const r = await llamar('GET', `/${LOTE}`, ADMIN);
        expect(r.status).toBe(404);
    });

    it('detalle: conteo exacto de lo anulable (Q12)', async () => {
        estado.ref.tablas.charge_batches = [{ id: LOTE, school_id: ESCUELA, created_by: DUENO, created_at: '2026-10-10T00:00:00Z' }];
        estado.ref.tablas.payments.push(
            { id: 'p1', school_id: ESCUELA, charge_batch_id: LOTE, status: 'pending', amount: 80000, created_at: '1' },
            { id: 'p2', school_id: ESCUELA, charge_batch_id: LOTE, status: 'paid', amount: 80000, amount_paid: 80000, created_at: '2' },
        );
        const r = await llamar('GET', `/${LOTE}`, ADMIN);
        expect(r.body.annul_preview).toEqual({ annullable_count: 1, annullable_total: 80000, kept_count: 1 });
        expect(r.body.batch.created_by_name).toBe('Dueña');
    });

    it('historial: cada lote trae el nombre de su destino (atleta o equipo), no «Un atleta»', async () => {
        estado.ref.tablas.charge_batches = [
            { id: 'b-atleta', school_id: ESCUELA, mode: 'single', target: { kind: 'athlete', ids: [NINO] }, created_by: DUENO, created_at: '2026-10-10T00:00:02Z' },
            { id: 'b-equipo', school_id: ESCUELA, mode: 'multi', target: { kind: 'team', ids: [EQUIPO] }, created_by: DUENO, created_at: '2026-10-10T00:00:01Z' },
            { id: 'b-lista', school_id: ESCUELA, mode: 'multi', target: { kind: 'list', ids: [] }, created_by: DUENO, created_at: '2026-10-10T00:00:00Z' },
        ];
        const r = await llamar('GET', '/', ADMIN);
        expect(r.status).toBe(200);
        const por = Object.fromEntries(r.body.items.map((i: any) => [i.id, i.target_label]));
        expect(por['b-atleta']).toBe('Niño Uno');
        expect(por['b-equipo']).toBe('Equipo Sub-12');
        expect(por['b-lista']).toBeNull(); // sin ids: el front cae a «Varios atletas»
    });

    it('historial sin la tabla (F1 sin aplicar) → 503 claro', async () => {
        estado.ref.erroresTabla.charge_batches = { code: '42P01', message: 'relation "public.charge_batches" does not exist' };
        const r = await llamar('GET', '/', ADMIN);
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('COBROS_NO_DISPONIBLE');
    });

    it('targets: atletas activos del equipo; equipo ajeno → 404', async () => {
        const r = await llamar('GET', `/targets?kind=team&id=${EQUIPO}`, ADMIN);
        expect(r.status).toBe(200);
        expect(r.body.athletes).toEqual([expect.objectContaining({ type: 'child', id: NINO, name: 'Niño Uno', has_guardian: true })]);
        expect((await llamar('GET', `/targets?kind=team&id=${EQUIPO_OTRA}`, ADMIN)).status).toBe(404);
    });

    it('targets: pausado fuera por defecto, dentro con include_paused', async () => {
        estado.ref.tablas.enrollments[0].paused_at = '2026-10-01';
        expect((await llamar('GET', `/targets?kind=team&id=${EQUIPO}`, ADMIN)).body).toMatchObject({ count: 0, paused_excluded: 1 });
        expect((await llamar('GET', `/targets?kind=team&id=${EQUIPO}&include_paused=true`, ADMIN)).body.count).toBe(1);
    });

    it('athlete-search: regla local mientras no exista la RPC; el teléfono solo no es duplicado', async () => {
        estado.ref.tablas.children[0].parent_phone_temp = '300 999 8888';
        const porTel = await llamar('GET', '/athlete-search?phone=3009998888', ADMIN);
        expect(porTel.status).toBe(200);
        expect(porTel.body.items[0]).toMatchObject({ id: NINO, matched_by: ['telefono'], es_duplicado: false });
        expect(porTel.body.has_duplicate).toBe(false);

        const porNombre = await llamar('GET', `/athlete-search?q=${encodeURIComponent('niño uno')}`, ADMIN);
        expect(porNombre.body.items[0]).toMatchObject({ id: NINO, es_duplicado: true, motivo: 'mismo nombre' });
        // Nunca personas de otra escuela.
        expect(JSON.stringify(porNombre.body)).not.toContain(NINO_OTRA);
    });

    it('athlete-search: sin criterio útil → 422', async () => {
        expect((await llamar('GET', '/athlete-search?q=a', ADMIN)).status).toBe(422);
    });

    it('athlete-search: coach → 403', async () => {
        expect((await llamar('GET', '/athlete-search?q=nino', COACH)).status).toBe(403);
    });
});
