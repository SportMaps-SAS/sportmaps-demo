/**
 * Cobro de reservas (RSV-*): rama de los webhooks de Wompi y MercadoPago +
 * validación de monto + idempotencia + conciliación. Sin red ni base.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    inserts: [] as { tabla: string; fila: Fila }[],
    rpcs: [] as { nombre: string; args: any }[],
    rpcRespuesta: null as any,
    rpcError: null as any,
    // M4: fuente de las llaves con que se resuelve la pasarela de la escuela dueña de la reserva.
    fuente: 'school_direct' as string | null,
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(estado.tablas[tabla] ?? [])];
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter(f => f[c] === v); return api; },
            in: (c: string, vs: any[]) => { filas = filas.filter(f => vs.includes(f[c])); return api; },
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            insert: async (fila: Fila) => {
                estado.inserts.push({ tabla, fila });
                return { data: null, error: null };
            },
            then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (nombre: string, args: any) => {
                estado.rpcs.push({ nombre, args });
                return { data: estado.rpcRespuesta, error: estado.rpcError };
            },
        },
    };
});

vi.mock('../services/store-checkout', () => ({
    findStoreOrderByReference: vi.fn(), sellerWompiCredsForOrder: vi.fn(), amountMatchesOrder: vi.fn(),
    findStoreOrderById: vi.fn(), sellerGatewayForOrder: vi.fn(), SellerGatewayError: class extends Error {},
}));
vi.mock('../services/payment-provider.resolver', () => ({
    resolveProvider: vi.fn(async (c: any) => (estado.fuente ? { provider: c.preferredProvider, source: estado.fuente } : null)),
    loadProviderConfig: vi.fn(async () => null),
}));
vi.mock('../services/paymentFailureEmail.service', () => ({ sendPaymentAttemptFailedEmails: vi.fn() }));

import { routeWompiTransaction } from '../routes/wompi';
import { routeMercadoPagoTransaction } from '../routes/mercadopago';
import {
    baseReservationReference,
    validarMontoDeReserva,
    abonoMinimoDeReserva,
    adminsDeLaEscuela,
} from './reservation-payments.service';

const RES_ID = 'aaaaaaaa-0000-4000-8000-00000000aaa1';
const REF = 'RSV-3F9A1C0D22B4E7A1';
const ESCUELA = 'ssssssss-0000-4000-8000-000000000001';
const ADMIN = 'uuuuuuuu-0000-4000-8000-0000000000ad';
const CLIENTE = 'uuuuuuuu-0000-4000-8000-0000000000cl';

const reserva = (extra: Fila = {}): Fila => ({
    id: RES_ID, school_id: ESCUELA, facility_id: 'fac-1', user_id: CLIENTE, guest_booker_id: null,
    status: 'pending_payment', payment_status: 'unpaid', price: 120000, amount_paid: 0,
    min_deposit_pct: 30, hold_expires_at: new Date(Date.now() + 5 * 60000).toISOString(),
    payment_reference: REF,
    price_snapshot: { deposit_min: 36000, checkout_amounts: [36000, 120000], payment_events: [] },
    ...extra,
});

const txWompi = (monto: number, extra: Fila = {}) => ({
    id: 'tx-1', status: 'APPROVED', reference: REF, amount_in_cents: monto * 100, currency: 'COP',
    payment_method_type: 'NEQUI', ...extra,
});

const pagoMp = (monto: number, extra: Fila = {}) => ({
    id: 99887766, status: 'approved', external_reference: REF, transaction_amount: monto,
    currency_id: 'COP', payment_method_id: 'visa', payment_type_id: 'credit_card', ...extra,
}) as any;

const rpcsDeReserva = () => estado.rpcs.filter(r => r.nombre === 'confirmar_pago_reserva');
const alertas = () => estado.inserts.filter(i => i.tabla === 'notifications' && String(i.fila.type).startsWith('reservation_'));

beforeEach(() => {
    estado.tablas = {
        facility_reservations: [reserva()],
        schools: [{ id: ESCUELA, owner_id: ADMIN }],
        school_members: [],
    };
    estado.inserts = [];
    estado.rpcs = [];
    estado.rpcError = null;
    estado.fuente = 'school_direct';
    estado.rpcRespuesta = {
        ok: true, already_processed: false, confirmed: true, reconciliation: false,
        reservation: { id: RES_ID, facility_name: 'Cancha 1', local_date: '2026-11-06', local_start: '17:00' },
    };
});

describe('referencia RSV', () => {
    it('acepta RSV-<16> y con sufijo; rechaza lo demás', () => {
        expect(baseReservationReference(REF)).toBe(REF);
        expect(baseReservationReference(`${REF}-MX12AB`)).toBe(REF);
        expect(baseReservationReference('RSV-123')).toBeNull();
        expect(baseReservationReference("RSV-3F9A1C0D22B4E7A1'; drop")).toBeNull();
        expect(baseReservationReference('SCH-ABC-123')).toBeNull();
    });
});

describe('webhook Wompi — RSV', () => {
    it('APPROVED por el abono: llama confirmar_pago_reserva con el id de evento y avisa a quien reservó', async () => {
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.handled).toBe(true);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'ok', kind: 'reservation', confirmed: true });
        expect(rpcsDeReserva()).toHaveLength(1);
        expect(rpcsDeReserva()[0].args).toEqual({
            p_reference: REF, p_amount: 36000, p_payment_id: null,
            p_provider: 'wompi', p_provider_event_id: 'wompi:tx-1',
        });
        const aviso = estado.inserts.find(i => i.fila.type === 'booking_confirmed');
        expect(aviso?.fila.user_id).toBe(CLIENTE);
    });

    it('monto que no cuadra → rechazado SIN llamar la RPC, alerta al admin, responde 200', async () => {
        const r = await routeWompiTransaction({ realTx: txWompi(50000) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
        expect(rpcsDeReserva()).toHaveLength(0);
        expect(alertas()).toHaveLength(1);
        expect(alertas()[0].fila).toMatchObject({ user_id: ADMIN, type: 'reservation_payment_rejected', link: '/facilities' });
    });

    it('sobrepago (más que el saldo) → rechazado', async () => {
        const r = await routeWompiTransaction({ realTx: txWompi(130000) });
        expect(r.body).toMatchObject({ status: 'rejected', reason: 'amount_exceeds_balance' });
        expect(rpcsDeReserva()).toHaveLength(0);
    });

    it('moneda distinta de COP → rechazado', async () => {
        const r = await routeWompiTransaction({ realTx: txWompi(36000, { currency: 'USD' }) });
        expect(r.body).toMatchObject({ status: 'rejected', reason: 'unsupported_currency' });
        expect(rpcsDeReserva()).toHaveLength(0);
    });

    it('mismo evento dos veces → un solo efecto (already_processed)', async () => {
        // 1ª vez: la RPC aplica.
        await routeWompiTransaction({ realTx: txWompi(36000) });
        // 2ª vez: la base ya lo registró en payment_events → ni siquiera se llama la RPC.
        estado.tablas.facility_reservations = [reserva({
            amount_paid: 36000, status: 'confirmed',
            price_snapshot: { deposit_min: 36000, checkout_amounts: [36000], payment_events: ['wompi:tx-1'] },
        })];
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.body).toMatchObject({ status: 'already_processed' });
        expect(rpcsDeReserva()).toHaveLength(1);
    });

    it('la RPC responde already_processed → 200 already_processed, sin avisos', async () => {
        estado.rpcRespuesta = { ok: true, already_processed: true, confirmed: true, reconciliation: false };
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.body).toMatchObject({ status: 'already_processed' });
        expect(estado.inserts).toHaveLength(0);
    });

    it('reconciliation:true → alerta al admin y el pago NO se pierde (200)', async () => {
        estado.rpcRespuesta = { ok: true, already_processed: false, confirmed: false, reconciliation: true, reservation: { id: RES_ID } };
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'ok', reconciliation: true });
        expect(rpcsDeReserva()).toHaveLength(1);
        expect(alertas()).toHaveLength(1);
        expect(alertas()[0].fila).toMatchObject({ user_id: ADMIN, type: 'reservation_reconciliation' });
        expect(estado.inserts.find(i => i.fila.type === 'booking_confirmed')).toBeUndefined();
    });

    it('abono que no alcanza el mínimo → ok sin confirmar y aviso de abono', async () => {
        estado.rpcRespuesta = { ok: true, already_processed: false, confirmed: false, reconciliation: false, reason: 'DEPOSIT_NOT_REACHED' };
        estado.tablas.facility_reservations = [reserva({ price_snapshot: { deposit_min: 36000, checkout_amounts: [10000] } })];
        const r = await routeWompiTransaction({ realTx: txWompi(10000) });
        expect(r.body).toMatchObject({ status: 'ok', confirmed: false, reason: 'DEPOSIT_NOT_REACHED' });
        expect(estado.inserts.find(i => i.fila.type === 'payment_received')?.fila.user_id).toBe(CLIENTE);
    });

    it('referencia desconocida → ignorada con 200 (reservation_not_found) y sin RPC', async () => {
        estado.tablas.facility_reservations = [];
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'ignored', reason: 'reservation_not_found' });
        expect(rpcsDeReserva()).toHaveLength(0);
    });

    it('DECLINED → no mueve plata ni llama la RPC', async () => {
        const r = await routeWompiTransaction({ realTx: txWompi(36000, { status: 'DECLINED' }) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ applied: false, internalStatus: 'rejected' });
        expect(rpcsDeReserva()).toHaveLength(0);
    });

    it('error de la RPC (transitorio) → 500 para que la pasarela reintente', async () => {
        estado.rpcRespuesta = null;
        estado.rpcError = { message: 'connection reset' };
        const r = await routeWompiTransaction({ realTx: txWompi(36000) });
        expect(r.status).toBe(500);
    });

    it('referencia con sufijo (segundo pago) se resuelve a la reserva', async () => {
        estado.tablas.facility_reservations = [reserva({
            amount_paid: 36000, price_snapshot: { deposit_min: 36000, checkout_amounts: [84000] },
        })];
        const r = await routeWompiTransaction({ realTx: txWompi(84000, { reference: `${REF}-MABC12` }) });
        expect(r.body).toMatchObject({ status: 'ok', confirmed: true });
        expect(rpcsDeReserva()[0].args.p_reference).toBe(REF);
    });
});

describe('webhook MercadoPago — RSV', () => {
    it('approved por el monto ofrecido → confirma con provider mercadopago', async () => {
        const r = await routeMercadoPagoTransaction({ payment: pagoMp(120000) });
        expect(r.handled).toBe(true);
        expect(r.body).toMatchObject({ status: 'ok', kind: 'reservation', confirmed: true });
        expect(rpcsDeReserva()[0].args).toMatchObject({ p_provider: 'mercadopago', p_provider_event_id: 'mercadopago:99887766', p_amount: 120000 });
    });

    it('monto que no cuadra → rechazado y alerta', async () => {
        const r = await routeMercadoPagoTransaction({ payment: pagoMp(77777) });
        expect(r.body).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
        expect(rpcsDeReserva()).toHaveLength(0);
        expect(alertas()).toHaveLength(1);
    });

    it('reconciliation:true → alerta', async () => {
        estado.rpcRespuesta = { ok: true, already_processed: false, confirmed: false, reconciliation: true };
        const r = await routeMercadoPagoTransaction({ payment: pagoMp(36000) });
        expect(r.body).toMatchObject({ reconciliation: true });
        expect(alertas()[0].fila.type).toBe('reservation_reconciliation');
    });

    it('referencia desconocida → 200 ignored', async () => {
        estado.tablas.facility_reservations = [];
        const r = await routeMercadoPagoTransaction({ payment: pagoMp(36000) });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ status: 'ignored', reason: 'reservation_not_found' });
    });
});

describe('validarMontoDeReserva / abonoMinimoDeReserva', () => {
    it('sin montos registrados exige al menos el abono mínimo', () => {
        const r = reserva({ price_snapshot: { deposit_min: 36000 } });
        expect(validarMontoDeReserva(r, 36000, 'COP').ok).toBe(true);
        expect(validarMontoDeReserva(r, 20000, 'COP')).toMatchObject({ ok: false, reason: 'amount_below_deposit' });
    });
    it('el abono mínimo descuenta lo ya pagado y nunca pasa del saldo', () => {
        expect(abonoMinimoDeReserva(reserva())).toBe(36000);
        expect(abonoMinimoDeReserva(reserva({ amount_paid: 30000 }))).toBe(6000);
        expect(abonoMinimoDeReserva(reserva({ amount_paid: 119000 }))).toBe(1000);
    });
    it('cero y negativos no pasan', () => {
        expect(validarMontoDeReserva(reserva(), 0, 'COP').ok).toBe(false);
        expect(validarMontoDeReserva(reserva(), -5, 'COP').ok).toBe(false);
        expect(validarMontoDeReserva(reserva(), NaN, 'COP').ok).toBe(false);
    });
});

describe('destinatarios de las alertas (QA T1)', () => {
    it('incluyen al dueño, a los admin y a los school_admin (antes se perdían); no a coach/parent', async () => {
        estado.tablas.school_members = [
            { school_id: ESCUELA, profile_id: 'sadmin-1', role: 'school_admin', status: 'active' },
            { school_id: ESCUELA, profile_id: 'admin-2', role: 'admin', status: 'active' },
            { school_id: ESCUELA, profile_id: 'coach-1', role: 'coach', status: 'active' },
            { school_id: ESCUELA, profile_id: 'padre-1', role: 'parent', status: 'active' },
        ];
        const ids = (await adminsDeLaEscuela(ESCUELA)).sort();
        expect(ids).toEqual([ADMIN, 'admin-2', 'sadmin-1'].sort());
    });
});

describe('M4: solo se aplica el pago si la escuela tiene pasarela directa propia', () => {
    for (const fuente of ['env', null] as const) {
        it(`Wompi con resolución ${fuente ?? 'null'} → 200 ignored not_school_direct, SIN RPC y con alerta al admin`, async () => {
            estado.fuente = fuente;
            const r = await routeWompiTransaction({ realTx: txWompi(36000) });
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ status: 'ignored', reason: 'not_school_direct' });
            expect(rpcsDeReserva()).toHaveLength(0);
            expect(alertas()).toHaveLength(1);
            expect(alertas()[0].fila.user_id).toBe(ADMIN);
        });
        it(`MercadoPago con resolución ${fuente ?? 'null'} → 200 ignored not_school_direct, SIN RPC y con alerta al admin`, async () => {
            estado.fuente = fuente;
            const r = await routeMercadoPagoTransaction({ payment: pagoMp(36000) });
            expect(r.status).toBe(200);
            expect(r.body).toMatchObject({ status: 'ignored', reason: 'not_school_direct' });
            expect(rpcsDeReserva()).toHaveLength(0);
            expect(alertas()).toHaveLength(1);
        });
    }
    it('un pago rechazado (no paid) en escuela sin pasarela directa se ignora sin alertar', async () => {
        estado.fuente = 'env';
        const r = await routeWompiTransaction({ realTx: txWompi(36000, { status: 'DECLINED' }) });
        expect(r.body).toMatchObject({ status: 'ignored', reason: 'not_school_direct' });
        expect(alertas()).toHaveLength(0);
    });
});
