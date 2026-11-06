/**
 * POST /api/v1/reservations/:id/checkout, /transfer-proof y /confirm-transfer.
 * Sin red ni base: supabase, resolver de pasarela y MP mockeados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

type Fila = Record<string, any>;

const st = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    updates: [] as { tabla: string; cambios: Fila }[],
    inserts: [] as { tabla: string; fila: Fila }[],
    rpcs: [] as { nombre: string; args: any }[],
    rpcRespuesta: null as any,
    proveedor: null as any,
    mpPreference: [] as any[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(st.tablas[tabla] ?? [])];
        let modo: 'select' | 'update' = 'select';
        let cambios: Fila = {};
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter(f => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filas = filas.filter(f => vs.includes(f[c])); return api; },
            gt: (c: string, v: any) => { filas = filas.filter(f => f[c] > v); return api; },
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            update: (c: Fila) => { modo = 'update'; cambios = c; return api; },
            insert: async (fila: Fila) => { st.inserts.push({ tabla, fila }); return { data: null, error: null }; },
            then: (ok: any, ko: any) => {
                if (modo === 'update') {
                    st.updates.push({ tabla, cambios });
                    for (const f of filas) Object.assign(f, cambios);
                }
                return Promise.resolve({ data: filas, error: null }).then(ok, ko);
            },
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (nombre: string, args: any) => { st.rpcs.push({ nombre, args }); return { data: st.rpcRespuesta, error: null }; },
        },
    };
});

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, res: any, next: any) => {
        const uid = req.headers['x-user'];
        if (!uid) return res.status(401).json({ error: 'auth' });
        req.user = { id: String(uid) };
        next();
    },
}));
vi.mock('../services/payment-provider.resolver', () => ({ resolveProvider: vi.fn(async () => st.proveedor) }));
vi.mock('../services/mercadopago.service', () => ({
    createMpPreference: vi.fn(async (p: any) => { st.mpPreference.push(p); return { ok: true, id: 'pref-1', initPoint: 'https://www.mercadopago.com.co/checkout/v1/redirect?pref_id=pref-1', sandboxInitPoint: null }; }),
}));

const { default: router, setReservationGuestAuth } = await import('./reservations-checkout.routes');

let base = '';
let server: http.Server;
beforeAll(async () => {
    process.env.SUPABASE_URL = 'https://proj.supabase.co';
    const app = express();
    app.use(express.json());
    app.use('/api/v1/reservations', router);
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/reservations`;
});
afterAll(() => { server?.close(); });

const RES = 'aaaaaaaa-0000-4000-8000-00000000aaa1';
const ESC = 'bbbbbbbb-0000-4000-8000-00000000bbb1';
const CLIENTE = 'cccccccc-0000-4000-8000-00000000ccc1';
const OTRO = 'dddddddd-0000-4000-8000-00000000ddd1';
const REF = 'RSV-3F9A1C0D22B4E7A1';

const reserva = (extra: Fila = {}): Fila => ({
    id: RES, school_id: ESC, facility_id: 'fac-1', user_id: CLIENTE, guest_booker_id: null,
    status: 'pending_payment', payment_status: 'unpaid', price: 120000, amount_paid: 0, min_deposit_pct: 30,
    hold_expires_at: new Date(Date.now() + 8 * 60000).toISOString(), payment_reference: REF,
    price_snapshot: { deposit_min: 36000 }, ...extra,
});

const wompiDirecto = {
    provider: 'wompi', publicKey: 'pub_prod_abc', accessToken: 'prv_prod_abc', webhookSecret: 'evt', integritySecret: 'integ',
    sandbox: false, isDefault: true, source: 'school_direct',
};
const mpDirecto = {
    provider: 'mercadopago', publicKey: 'APP_USR-pub', accessToken: 'APP_USR-tok', webhookSecret: 'wh',
    sandbox: false, isDefault: true, source: 'school_direct',
};

const post = (path: string, body: any = {}, headers: Record<string, string> = { 'x-user': CLIENTE }) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
    st.tablas = {
        facility_reservations: [reserva()],
        schools: [{ id: ESC, owner_id: 'admin-1' }],
        school_members: [],
    };
    st.updates = []; st.inserts = []; st.rpcs = []; st.mpPreference = [];
    st.proveedor = wompiDirecto;
    st.rpcRespuesta = { ok: true, confirmed: true, already_processed: false, reconciliation: false, reservation: { id: RES } };
    setReservationGuestAuth(null);
});

describe('checkout', () => {
    it('Wompi de la escuela: URL firmada con monto = abono mínimo, referencia RSV y expiración = hold', async () => {
        const r = await post(`/${RES}/checkout`);
        expect(r.status).toBe(200);
        const j: any = await r.json();
        expect(j).toMatchObject({ amount: 36000, provider: 'wompi', reference: REF });
        const u = new URL(j.checkout_url);
        expect(u.searchParams.get('public-key')).toBe('pub_prod_abc');
        expect(u.searchParams.get('reference')).toBe(REF);
        expect(u.searchParams.get('amount-in-cents')).toBe('3600000');
        expect(u.searchParams.get('expiration-time')).toBe(j.expires_at);
        expect(u.searchParams.get('signature:integrity')).toMatch(/^[0-9a-f]{64}$/);
        // El monto ofrecido queda registrado para que el webhook lo valide.
        const upd = st.updates.find(x => x.tabla === 'facility_reservations');
        expect(upd?.cambios.price_snapshot.checkout_amounts).toEqual([36000]);
    });

    it('mode total cobra el saldo; amount fuera de [mínimo, saldo] → 400', async () => {
        const t: any = await (await post(`/${RES}/checkout`, { mode: 'total' })).json();
        expect(t.amount).toBe(120000);
        const bajo = await post(`/${RES}/checkout`, { amount: 1000 });
        expect(bajo.status).toBe(400);
        expect(await bajo.json()).toMatchObject({ error: 'amount_out_of_range', min: 36000, max: 120000 });
        expect((await post(`/${RES}/checkout`, { amount: 999999 })).status).toBe(400);
        expect((await post(`/${RES}/checkout`, { amount: 40000.5 })).status).toBe(400);
    });

    it('con un pago previo la referencia lleva sufijo (Wompi no reutiliza una aprobada)', async () => {
        st.tablas.facility_reservations = [reserva({ amount_paid: 36000 })];
        const j: any = await (await post(`/${RES}/checkout`, { mode: 'total' })).json();
        expect(j.amount).toBe(84000);
        expect(j.reference).toMatch(/^RSV-3F9A1C0D22B4E7A1-[A-Z0-9]+$/);
    });

    it('MercadoPago de la escuela: preferencia con X-Idempotency-Key determinista y vencimiento = hold', async () => {
        st.proveedor = mpDirecto;
        const a: any = await (await post(`/${RES}/checkout`, { provider: 'mercadopago' })).json();
        const b: any = await (await post(`/${RES}/checkout`, { provider: 'mercadopago' })).json();
        expect(a).toMatchObject({ provider: 'mercadopago', amount: 36000 });
        expect(st.mpPreference).toHaveLength(2);
        expect(st.mpPreference[0]).toMatchObject({ accessToken: 'APP_USR-tok', externalReference: REF, amount: 36000 });
        expect(st.mpPreference[0].notificationUrl).toContain(`/webhooks/mercadopago/webhook/${ESC}`);
        expect(st.mpPreference[0].expiresAt).toBe(a.expires_at);
        expect(st.mpPreference[0].idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(st.mpPreference[0].idempotencyKey).toBe(st.mpPreference[1].idempotencyKey);
        expect(b.checkout_url).toBe(a.checkout_url);
    });

    it('sin pasarela directa → 409 SIN_PASARELA_DIRECTA (resolver null)', async () => {
        st.proveedor = null;
        const r = await post(`/${RES}/checkout`);
        expect(r.status).toBe(409);
        expect(await r.json()).toMatchObject({ error: 'SIN_PASARELA_DIRECTA' });
        expect(st.updates).toHaveLength(0);
    });

    it('llaves de ENV (escuela en aggregator) → 409: nunca credenciales de otra cuenta', async () => {
        st.proveedor = { ...wompiDirecto, source: 'env' };
        const r = await post(`/${RES}/checkout`);
        expect(r.status).toBe(409);
        expect(await r.json()).toMatchObject({ error: 'SIN_PASARELA_DIRECTA' });
    });

    it('hold vencido → 409 hold_expired; reserva confirmada → 409 reservation_not_payable', async () => {
        st.tablas.facility_reservations = [reserva({ hold_expires_at: new Date(Date.now() - 1000).toISOString() })];
        expect(await (await post(`/${RES}/checkout`)).json()).toMatchObject({ error: 'hold_expired' });
        st.tablas.facility_reservations = [reserva({ status: 'confirmed' })];
        expect(await (await post(`/${RES}/checkout`)).json()).toMatchObject({ error: 'reservation_not_payable' });
    });

    it('otro usuario → 404; sin sesión → 401; staff de la escuela sí', async () => {
        expect((await post(`/${RES}/checkout`, {}, { 'x-user': OTRO })).status).toBe(404);
        expect((await post(`/${RES}/checkout`, {}, {})).status).toBe(401);
        expect((await post(`/${RES}/checkout`, {}, { 'x-user': 'admin-1' })).status).toBe(200);
    });

    it('invitado: token validado por el validador inyectado y atado al guest_booker_id', async () => {
        st.tablas.facility_reservations = [reserva({ user_id: null, guest_booker_id: 'guest-1' })];
        setReservationGuestAuth(async (_req, id) => (id === RES ? { guestBookerId: 'guest-1' } : null));
        expect((await post(`/${RES}/checkout`, {}, { 'x-reservation-token': 'tok' })).status).toBe(200);
        setReservationGuestAuth(async () => ({ guestBookerId: 'guest-OTRO' }));
        expect((await post(`/${RES}/checkout`, {}, { 'x-reservation-token': 'tok' })).status).toBe(404);
        setReservationGuestAuth(async () => null);
        expect((await post(`/${RES}/checkout`, {}, { 'x-reservation-token': 'tok' })).status).toBe(404);
    });
});

describe('transfer-proof', () => {
    const URL_OK = 'https://proj.supabase.co/storage/v1/object/public/receipts/x.png';

    it('guarda el comprobante, alarga el hold UNA vez y avisa al admin', async () => {
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(200);
        const j: any = await r.json();
        expect(j).toMatchObject({ ok: true, in_review: true, status: 'pending_payment' });
        const upd = st.updates.find(x => x.tabla === 'facility_reservations')!;
        expect(new Date(upd.cambios.hold_expires_at).getTime()).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);
        expect(upd.cambios.price_snapshot.transfer_proof.url).toBe(URL_OK);
        expect(st.inserts.find(i => i.fila.type === 'reservation_transfer_proof')?.fila.user_id).toBe('admin-1');

        // Segundo comprobante: no vuelve a alargar.
        st.updates = [];
        await post(`/${RES}/transfer-proof`, { proof_url: URL_OK + '?v=2' });
        expect(st.updates[0].cambios.hold_expires_at).toBeUndefined();
    });

    it('URL que no es de nuestro Storage → 400; hold vencido → 409', async () => {
        expect((await post(`/${RES}/transfer-proof`, { proof_url: 'https://evil.example/x.png' })).status).toBe(400);
        st.tablas.facility_reservations = [reserva({ hold_expires_at: new Date(Date.now() - 1000).toISOString() })];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(409);
    });
});

describe('confirm-transfer (staff)', () => {
    const conComprobante = () => reserva({ price_snapshot: { deposit_min: 36000, transfer_proof: { url: 'https://proj.supabase.co/storage/v1/object/public/r/x.png' } } });

    it('solo staff: el dueño de la reserva recibe 404', async () => {
        st.tablas.facility_reservations = [conComprobante()];
        expect((await post(`/${RES}/confirm-transfer`, { amount: 36000 })).status).toBe(404);
        expect(st.rpcs).toHaveLength(0);
    });

    it('staff confirma: RPC con provider transfer e id de evento determinista', async () => {
        st.tablas.facility_reservations = [conComprobante()];
        const r = await post(`/${RES}/confirm-transfer`, { amount: 36000 }, { 'x-user': 'admin-1' });
        expect(r.status).toBe(200);
        expect(st.rpcs[0].args).toMatchObject({ p_reference: REF, p_amount: 36000, p_provider: 'transfer' });
        expect(st.rpcs[0].args.p_provider_event_id).toMatch(/^transfer:/);
        await post(`/${RES}/confirm-transfer`, { amount: 36000 }, { 'x-user': 'admin-1' });
        expect(st.rpcs[1].args.p_provider_event_id).toBe(st.rpcs[0].args.p_provider_event_id);
    });

    it('QA T1: el administrador con rol school_admin (no dueño) también confirma; coach/parent no', async () => {
        st.tablas.facility_reservations = [conComprobante()];
        st.tablas.school_members = [
            { school_id: ESC, profile_id: 'sadmin-1', role: 'school_admin', status: 'active' },
            { school_id: ESC, profile_id: 'coach-1', role: 'coach', status: 'active' },
        ];
        expect((await post(`/${RES}/confirm-transfer`, { amount: 36000 }, { 'x-user': 'sadmin-1' })).status).toBe(200);
        expect((await post(`/${RES}/confirm-transfer`, { amount: 36000 }, { 'x-user': 'coach-1' })).status).toBe(404);
    });

    it('sin comprobante → 409; monto mayor al saldo → 400', async () => {
        expect((await post(`/${RES}/confirm-transfer`, { amount: 36000 }, { 'x-user': 'admin-1' })).status).toBe(409);
        st.tablas.facility_reservations = [conComprobante()];
        expect((await post(`/${RES}/confirm-transfer`, { amount: 500000 }, { 'x-user': 'admin-1' })).status).toBe(400);
    });
});
