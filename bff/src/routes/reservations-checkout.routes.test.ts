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
    storage: [] as { bucket: string; name: string; carpeta: string; id?: string | null; metadata?: any }[],
    storageError: null as any,
    /** Se ejecuta al empezar un UPDATE (simula un cambio concurrente entre la lectura y la escritura). */
    alActualizar: null as null | (() => void),
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
            neq: (c: string, v: any) => { filas = filas.filter(f => f[c] !== v); return api; },
            gte: (c: string, v: any) => {
                const get = (f: Fila) => c.split('->').reduce((acc: any, k) => acc?.[k.replace(/^>/, '')], f);
                filas = filas.filter(f => { const x = get(f); return typeof x === 'string' && x >= v; });
                return api;
            },
            limit: (n: number) => { filas = filas.slice(0, n); return api; },
            maybeSingle: async () => ({ data: filas[0] ? structuredClone(filas[0]) : null, error: null }), // copia: la base no comparte objetos con el BFF
            update: (c: Fila) => { modo = 'update'; cambios = c; const h = st.alActualizar; st.alActualizar = null; h?.(); return api; },
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
            storage: {
                from: (bucket: string) => ({
                    list: async (carpeta: string, opts: any) => {
                        if (st.storageError) return { data: null, error: st.storageError };
                        const data = st.storage
                            .filter(o => o.bucket === bucket && o.carpeta === carpeta && (!opts?.search || o.name.includes(opts.search)))
                            .map(o => ({ name: o.name, id: o.id === undefined ? 'obj-1' : o.id, metadata: o.metadata ?? { size: 1234, mimetype: 'image/png' } }));
                        return { data, error: null };
                    },
                }),
            },
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
    st.storage = [{ bucket: 'payment-receipts', carpeta: CLIENTE, name: 'x.png' }];
    st.storageError = null; st.alActualizar = null;
    delete process.env.PUBLIC_API_URL; delete process.env.RESERVATION_PROOF_BUCKETS;
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
    const URL_OK = `https://proj.supabase.co/storage/v1/object/public/payment-receipts/${CLIENTE}/x.png`;
    const enRevision = (id: string, extra: Fila = {}) => reserva({
        id, payment_reference: `RSV-${id.slice(0, 16).toUpperCase().replace(/-/g, 'A')}`,
        price_snapshot: { transfer_proof: { submitted_at: new Date().toISOString(), url: 'u' } }, ...extra,
    });

    it('guarda el comprobante, alarga el hold UNA vez y avisa al admin', async () => {
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(200);
        const j: any = await r.json();
        expect(j).toMatchObject({ ok: true, in_review: true, status: 'pending_payment' });
        const upd = st.updates.find(x => x.tabla === 'facility_reservations')!;
        expect(new Date(upd.cambios.hold_expires_at).getTime()).toBeGreaterThan(Date.now() + 11 * 3600 * 1000);
        expect(upd.cambios.price_snapshot.transfer_proof.url).toBe(URL_OK);
        expect(upd.cambios.price_snapshot.transfer_proof).toMatchObject({ bucket: 'payment-receipts', path: `${CLIENTE}/x.png` });
        expect(st.inserts.find(i => i.fila.type === 'reservation_transfer_proof')?.fila.user_id).toBe('admin-1');

        // Segundo comprobante: no vuelve a alargar.
        st.updates = [];
        st.storage.push({ bucket: 'payment-receipts', carpeta: CLIENTE, name: 'y.png' });
        await post(`/${RES}/transfer-proof`, { proof_url: URL_OK.replace('x.png', 'y.png') });
        expect(st.updates[0].cambios.hold_expires_at).toBeUndefined();
    });

    it('A2: URL de otro host / esquema / credenciales / bucket no permitido / extensión / traversal → 400 sin tocar nada', async () => {
        const malas = [
            'https://evil.example/storage/v1/object/public/payment-receipts/' + CLIENTE + '/x.png',
            'https://proj.supabase.co.evil.example/storage/v1/object/public/payment-receipts/' + CLIENTE + '/x.png',
            'https://user:pw@proj.supabase.co/storage/v1/object/public/payment-receipts/' + CLIENTE + '/x.png',
            'http://proj.supabase.co/storage/v1/object/public/payment-receipts/' + CLIENTE + '/x.png',
            `https://proj.supabase.co/storage/v1/object/public/avatars/${CLIENTE}/x.png`,           // bucket fuera de la lista
            `https://proj.supabase.co/storage/v1/object/public/payment-receipts/${CLIENTE}/x.exe`,  // extensión
            `https://proj.supabase.co/storage/v1/object/public/payment-receipts/${CLIENTE}/../${OTRO}/x.png`, // traversal hacia la carpeta de otro
            `https://proj.supabase.co/storage/v1/object/public/payment-receipts/${CLIENTE}/%2e%2e%2fx.png`,
            'https://proj.supabase.co/storage/v1/object/public/payment-receipts/x.png',              // sin carpeta
            'https://proj.supabase.co/storage/v1/render/image/public/payment-receipts/x/y.png',
            'no es url',
        ];
        for (const proof_url of malas) {
            const r = await post(`/${RES}/transfer-proof`, { proof_url });
            expect(r.status, proof_url).toBe(400);
        }
        expect(st.updates).toHaveLength(0);
    });

    it('A2: ruta de OTRO usuario → 403 proof_not_owned; la carpeta de la reserva sí sirve', async () => {
        const ajena = `https://proj.supabase.co/storage/v1/object/public/payment-receipts/${OTRO}/x.png`;
        const r = await post(`/${RES}/transfer-proof`, { proof_url: ajena });
        expect(r.status).toBe(403);
        expect(await r.json()).toMatchObject({ error: 'proof_not_owned' });
        expect(st.updates).toHaveLength(0);

        st.storage.push({ bucket: 'payment-receipts', carpeta: RES, name: 'z.pdf' });
        const ok = await post(`/${RES}/transfer-proof`, { proof_url: `https://proj.supabase.co/storage/v1/object/sign/payment-receipts/${RES}/z.pdf?token=abc` });
        expect(ok.status).toBe(200);
    });

    it('A2: el objeto NO existe en Storage → 400 proof_not_found y el hold NO se alarga', async () => {
        st.storage = [];
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(400);
        expect(await r.json()).toMatchObject({ error: 'proof_not_found' });
        expect(st.updates).toHaveLength(0);
    });

    it('A2: objeto inválido (tamaño 0 / tipo no imagen ni PDF) → 400; Storage caído → 503', async () => {
        st.storage = [{ bucket: 'payment-receipts', carpeta: CLIENTE, name: 'x.png', metadata: { size: 0, mimetype: 'image/png' } }];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(400);
        st.storage = [{ bucket: 'payment-receipts', carpeta: CLIENTE, name: 'x.png', metadata: { size: 100, mimetype: 'text/html' } }];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(400);
        st.storageError = { message: 'boom' };
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(503);
        expect(st.updates).toHaveLength(0);
    });

    it('A2: 3 reservas del usuario ya con comprobante en revisión hoy → 429 (scope user)', async () => {
        st.tablas.facility_reservations = [
            reserva(),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa2'),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa3'),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa4'),
        ];
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(429);
        expect(await r.json()).toMatchObject({ error: 'proof_daily_limit', scope: 'user' });
        expect(st.updates).toHaveLength(0);
    });

    it('A2: con 2 en revisión todavía pasa; las de más de 24 h no cuentan', async () => {
        st.tablas.facility_reservations = [
            reserva(),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa2'),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa3'),
            enRevision('aaaaaaaa-0000-4000-8000-00000000aaa4', { price_snapshot: { transfer_proof: { submitted_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() } } }),
        ];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(200);
    });

    it('A2: 20 comprobantes en revisión hoy en la escuela (de otros usuarios) → 429 (scope school)', async () => {
        const otras = Array.from({ length: 20 }, (_, i) => enRevision(`aaaaaaaa-0000-4000-8000-0000000b${String(i).padStart(4, '0')}`, { user_id: `u-${i}` }));
        st.tablas.facility_reservations = [reserva(), ...otras];
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(429);
        expect(await r.json()).toMatchObject({ scope: 'school' });
    });

    it('A2: invitado — la carpeta debe ser su guest_booker_id o la de la reserva', async () => {
        st.tablas.facility_reservations = [reserva({ user_id: null, guest_booker_id: 'guest-1' })];
        setReservationGuestAuth(async () => ({ guestBookerId: 'guest-1' }));
        const h = { 'x-reservation-token': 'tok' };
        const ajena = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK }, h); // carpeta de CLIENTE
        expect(ajena.status).toBe(403);
        st.storage.push({ bucket: 'payment-receipts', carpeta: 'guest-1', name: 'g.jpg' });
        const ok = await post(`/${RES}/transfer-proof`, { proof_url: 'https://proj.supabase.co/storage/v1/object/public/payment-receipts/guest-1/g.jpg' }, h);
        expect(ok.status).toBe(200);
    });

    it('bucket configurable por RESERVATION_PROOF_BUCKETS', async () => {
        process.env.RESERVATION_PROOF_BUCKETS = 'reserva-comprobantes';
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(400);
        st.storage = [{ bucket: 'reserva-comprobantes', carpeta: CLIENTE, name: 'x.png' }];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK.replace('payment-receipts', 'reserva-comprobantes') })).status).toBe(200);
    });

    it('hold vencido → 409', async () => {
        st.tablas.facility_reservations = [reserva({ hold_expires_at: new Date(Date.now() - 1000).toISOString() })];
        expect((await post(`/${RES}/transfer-proof`, { proof_url: URL_OK })).status).toBe(409);
    });

    it('M5: un webhook escribió el snapshot entre la lectura y el UPDATE → se relee y se FUSIONA (no se pierde payment_events)', async () => {
        const fila = reserva({ updated_at: 'v1' });
        st.tablas.facility_reservations = [fila];
        st.alActualizar = () => { fila.updated_at = 'v2'; fila.price_snapshot = { deposit_min: 36000, payment_events: ['wompi:tx-9'] }; };
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(200);
        // el primer intento no pegó (0 filas por updated_at); el segundo sí y conserva lo del webhook
        expect(fila.price_snapshot.payment_events).toEqual(['wompi:tx-9']);
        expect(fila.price_snapshot.transfer_proof.url).toBe(URL_OK);
        expect(fila.updated_at).toBe('v2');
    });

    it('M5: si la reserva dejó de estar pending_payment durante el cambio concurrente → 409, sin sobrescribir', async () => {
        const fila = reserva({ updated_at: 'v1' });
        st.tablas.facility_reservations = [fila];
        st.alActualizar = () => { fila.updated_at = 'v2'; fila.status = 'confirmed'; };
        const r = await post(`/${RES}/transfer-proof`, { proof_url: URL_OK });
        expect(r.status).toBe(409);
        expect(fila.price_snapshot.transfer_proof).toBeUndefined();
    });
});

describe('M5 checkout: bloqueo optimista del snapshot', () => {
    it('el webhook guardó payment_events entre la lectura y el UPDATE → el checkout lo conserva', async () => {
        const fila = reserva({ updated_at: 'v1' });
        st.tablas.facility_reservations = [fila];
        st.alActualizar = () => { fila.updated_at = 'v2'; fila.price_snapshot = { deposit_min: 36000, payment_events: ['mercadopago:77'] }; };
        const r = await post(`/${RES}/checkout`);
        expect(r.status).toBe(200);
        expect(fila.price_snapshot.payment_events).toEqual(['mercadopago:77']);
        expect(fila.price_snapshot.checkout_amounts).toEqual([36000]);
        expect(fila.updated_at).toBe('v2');
    });
});

describe('notificationUrl de MercadoPago', () => {
    it('producción sin PUBLIC_API_URL → 409 claro y NO se crea la preferencia (no se confía en Host)', async () => {
        st.proveedor = mpDirecto;
        const nodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const r = await post(`/${RES}/checkout`, { provider: 'mercadopago' }, { 'x-user': CLIENTE, host: 'evil.example' });
            expect(r.status).toBe(409);
            expect(await r.json()).toMatchObject({ error: 'PUBLIC_API_URL_REQUIRED' });
            expect(st.mpPreference).toHaveLength(0);
        } finally { process.env.NODE_ENV = nodeEnv; }
    });
    it('con PUBLIC_API_URL se usa esa base (sin barra final)', async () => {
        st.proveedor = mpDirecto;
        process.env.PUBLIC_API_URL = 'https://api.sportmaps.co/';
        const r = await post(`/${RES}/checkout`, { provider: 'mercadopago' });
        expect(r.status).toBe(200);
        expect(st.mpPreference[0].notificationUrl).toBe(`https://api.sportmaps.co/api/v1/webhooks/mercadopago/webhook/${ESC}`);
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
