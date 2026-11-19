/**
 * CARACTERIZACIÓN («golden master») de los dos handlers de cobro de escuela (SCH-*):
 * `handleSchoolPayment` de Wompi (routes/wompi.ts) y el de Mercado Pago
 * (routes/mercadopago.ts).
 *
 * No afirma que la conducta sea la correcta: congela la que HAY HOY, con todo lo que
 * cada handler escribe (updates, inserts, rpcs, en orden), su respuesta y el estado
 * final de las tablas. Existe para la F1 de docs/specs/pasarela-bold-y-adaptador-de-
 * proveedores.md: al unificar ambos en un núcleo común, estos snapshots deben salir
 * IDÉNTICOS. Si un snapshot cambia, el refactor cambió conducta de cobros: se revierte
 * o se explica en el commit, nunca se actualiza el snapshot «para que pase».
 *
 * Las diferencias entre Wompi y MP que muestran los snapshots son reales (no un
 * defecto de la prueba): están anotadas en el spec §2.2 y NO se «arreglan» aquí.
 * Sin red ni base: todo moqueado; fecha congelada.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;

const estado = vi.hoisted(() => ({
    tablas: {} as Record<string, Fila[]>,
    traza: [] as any[],
    /** `tabla` cuyo UPDATE devuelve error (inyección de fallo). */
    fallaUpdate: null as string | null,
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        let filas: Fila[] = [...(estado.tablas[tabla] ?? [])];
        let modo: 'select' | 'update' = 'select';
        let cambios: Fila = {};
        const resultado = () => {
            if (modo === 'update') {
                const falla = estado.fallaUpdate === tabla;
                estado.traza.push({ op: 'update', tabla, cambios, error: falla ? 'inyectado' : null });
                if (falla) return { data: null, error: { message: 'inyectado' } };
                for (const f of filas) Object.assign(f, cambios);
                return { data: null, error: null };
            }
            return { data: filas, error: null };
        };
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filas = filas.filter(f => f[c] === v); return api; },
            maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
            update: (c: Fila) => { modo = 'update'; cambios = c; return api; },
            insert: async (fila: Fila) => {
                estado.traza.push({ op: 'insert', tabla, fila });
                (estado.tablas[tabla] ??= []).push({ ...fila });
                return { data: null, error: null };
            },
            then: (ok: any, ko: any) => Promise.resolve(resultado()).then(ok, ko),
        };
        return api;
    }
    return {
        supabase: {
            from: (t: string) => builder(t),
            rpc: async (nombre: string, args: any) => {
                estado.traza.push({ op: 'rpc', nombre, args });
                return { data: null, error: null };
            },
        },
    };
});

vi.mock('../services/store-checkout', () => ({
    findStoreOrderByReference: vi.fn(), findStoreOrderById: vi.fn(), sellerGatewayForOrder: vi.fn(),
    sellerWompiCredsForOrder: vi.fn(), amountMatchesOrder: vi.fn(), SellerGatewayError: class extends Error {},
}));
vi.mock('../services/payment-provider.resolver', () => ({
    resolveProvider: vi.fn(async () => null), loadProviderConfig: vi.fn(async () => null),
}));
vi.mock('../services/paymentFailureEmail.service', () => ({
    sendPaymentAttemptFailedEmails: vi.fn((...a: any[]) => { estado.traza.push({ op: 'correo', args: a.slice(0, 3) }); }),
}));
// Ganchos de autopay: solo Wompi los llama. Se registran, no se ejecutan.
vi.mock('../services/autopay.service', async (importOriginal) => {
    const real = await importOriginal<any>();
    return {
        ...real,
        autopayAlResultado: vi.fn(async (a: any) => { estado.traza.push({ op: 'autopayAlResultado', a }); }),
        autopayCobroDoble: vi.fn(async (a: any) => { estado.traza.push({ op: 'autopayCobroDoble', a }); }),
    };
});

import { routeWompiTransaction } from './wompi';
import { routeMercadoPagoTransaction } from './mercadopago';

const COBRO = 'cccccccc-0000-4000-8000-00000000000c';
const REF = 'SCH-CARACT-0001';

type Prov = 'wompi' | 'mercadopago';

interface Entrada {
    /** estado del proveedor: 'ok' | 'rechazado' | 'ambiguo' | 'pendiente' */
    resultado?: 'ok' | 'rechazado' | 'ambiguo' | 'pendiente';
    txId?: string;
    monto?: number;
    metodo?: string;
    link?: Fila;
    pago?: Fila;
    splitsPrevios?: Fila[];
    sinLink?: boolean;
    fallaUpdate?: string;
}

const ESTADO_WOMPI = { ok: 'APPROVED', rechazado: 'DECLINED', ambiguo: 'ERROR', pendiente: 'PENDING' } as const;
const ESTADO_MP = { ok: 'approved', rechazado: 'rejected', ambiguo: 'refunded', pendiente: 'pending' } as const;

function sembrar(prov: Prov, e: Entrada) {
    const refCol = prov === 'wompi' ? 'wompi_reference' : 'provider_reference';
    const txCol = prov === 'wompi' ? 'wompi_transaction_id' : 'provider_transaction_id';
    estado.tablas = {
        payment_links: e.sinLink ? [] : [{
            id: 'link-1', payment_id: COBRO, school_id: 'esc', gross_amount: 157500, base_amount: 150000,
            sportmaps_fee: 7500, status: 'pending', failed_attempts: 0, [refCol]: REF, ...e.link,
        }],
        payments: [{ id: COBRO, status: 'pending', amount: 150000, amount_paid: 0, [txCol]: null, ...e.pago }],
        payment_splits: [...(e.splitsPrevios ?? [])],
    };
    estado.traza = [];
    estado.fallaUpdate = e.fallaUpdate ?? null;
}

async function correr(prov: Prov, e: Entrada = {}) {
    sembrar(prov, e);
    const res = e.resultado ?? 'ok';
    const monto = e.monto ?? 157500;
    const txId = e.txId ?? (prov === 'wompi' ? '1298966-1-1' : '9001');
    const r = prov === 'wompi'
        ? await routeWompiTransaction({
            realTx: {
                id: txId, status: ESTADO_WOMPI[res], reference: REF, amount_in_cents: monto * 100, currency: 'COP',
                payment_method_type: e.metodo ?? 'NEQUI', status_message: res === 'ok' ? undefined : 'Fondos insuficientes',
            },
        })
        : await routeMercadoPagoTransaction({
            payment: {
                id: Number(txId), status: ESTADO_MP[res], external_reference: REF, transaction_amount: monto,
                payment_method_id: e.metodo ?? 'pse', payment_type_id: 'bank_transfer', status_detail: res === 'ok' ? 'accredited' : 'cc_rejected_other_reason',
            } as any,
        });
    return {
        respuesta: { status: r.status, body: r.body, handled: r.handled },
        traza: estado.traza,
        final: { payments: estado.tablas.payments, payment_links: estado.tablas.payment_links, payment_splits: estado.tablas.payment_splits },
    };
}

beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T15:00:00.000Z'));
});
afterAll(() => { vi.useRealTimers(); });
beforeEach(() => { estado.traza = []; estado.fallaUpdate = null; });

const AMBOS: Prov[] = ['wompi', 'mercadopago'];

describe.each(AMBOS)('cobro de escuela — %s', (prov) => {
    it('01 aprobado exacto', async () => {
        expect(await correr(prov)).toMatchSnapshot();
    });
    it('02 sobrepago (el cobro bajó después de firmar el enlace)', async () => {
        expect(await correr(prov, { pago: { amount: 135000 } })).toMatchSnapshot();
    });
    it('03 faltante por mora posterior al enlace', async () => {
        expect(await correr(prov, { pago: { status: 'overdue', amount: 165000, late_fee_amount: 15000 } })).toMatchSnapshot();
    });
    it('04 faltante con abono previo', async () => {
        expect(await correr(prov, { pago: { amount: 200000, amount_paid: 40000 } })).toMatchSnapshot();
    });
    it('05 abono previo que se salda', async () => {
        expect(await correr(prov, { pago: { amount: 190000, amount_paid: 40000 } })).toMatchSnapshot();
    });
    it('06 diferencia de 1 peso (redondeo)', async () => {
        expect(await correr(prov, { pago: { amount: 150001 } })).toMatchSnapshot();
    });
    it('07 el cobro ya estaba pagado por otra vía (doble pago)', async () => {
        expect(await correr(prov, { pago: { status: 'paid', payment_date: '2026-10-01', payment_channel: 'transfer' } })).toMatchSnapshot();
    });
    it('08 monto distinto al del enlace (400)', async () => {
        expect(await correr(prov, { monto: 100000 })).toMatchSnapshot();
    });
    it('09 evento repetido: ya hay split de esa transacción', async () => {
        const col = prov === 'wompi' ? 'wompi_transaction_id' : 'provider_transaction_id';
        const id = prov === 'wompi' ? '1298966-1-1' : '9001';
        expect(await correr(prov, { splitsPrevios: [{ id: 's1', [col]: id }] })).toMatchSnapshot();
    });
    it('10 enlace inexistente', async () => {
        expect(await correr(prov, { sinLink: true })).toMatchSnapshot();
    });
    it('11 rechazado (se puede reintentar)', async () => {
        expect(await correr(prov, { resultado: 'rechazado' })).toMatchSnapshot();
    });
    it('12 ambiguo (error/devuelto): bloquea con revisión', async () => {
        expect(await correr(prov, { resultado: 'ambiguo' })).toMatchSnapshot();
    });
    it('13 pendiente en la pasarela', async () => {
        expect(await correr(prov, { resultado: 'pendiente' })).toMatchSnapshot();
    });
    it('14 rechazado con fallos previos: el contador suma', async () => {
        expect(await correr(prov, { resultado: 'rechazado', link: { failed_attempts: 2 } })).toMatchSnapshot();
    });
    it('15 falla el UPDATE del pago', async () => {
        expect(await correr(prov, { fallaUpdate: 'payments' })).toMatchSnapshot();
    });
    it('16 falla el UPDATE del enlace al rechazar', async () => {
        expect(await correr(prov, { resultado: 'rechazado', fallaUpdate: 'payment_links' })).toMatchSnapshot();
    });
    it('17 enlace del débito automático aprobado', async () => {
        expect(await correr(prov, { link: { origin: 'autopay', recurring_attempt_id: 'intento-1' } })).toMatchSnapshot();
    });
    it('18 enlace del débito automático rechazado', async () => {
        expect(await correr(prov, { resultado: 'rechazado', link: { origin: 'autopay', recurring_attempt_id: 'intento-1' } })).toMatchSnapshot();
    });
    it('19 enlace del débito automático con doble pago', async () => {
        expect(await correr(prov, {
            link: { origin: 'autopay', recurring_attempt_id: 'intento-1' },
            pago: { status: 'paid', payment_date: '2026-10-01', payment_channel: 'transfer' },
        })).toMatchSnapshot();
    });
});

// Solo Wompi: el tipo de instrumento se mapea al CHECK de payments.payment_method.
describe('cobro de escuela — wompi, método de pago', () => {
    it.each(['CARD', 'PSE', 'NEQUI', 'DAVIPLATA', 'BANCOLOMBIA_TRANSFER', 'BANCOLOMBIA_QR', 'BANCOLOMBIA_COLLECT', 'DESCONOCIDO'])(
        '20 método %s', async (metodo) => {
            const r = await correr('wompi', { metodo });
            expect(r.final.payments[0].payment_method).toMatchSnapshot();
        },
    );
});

// Documenta el hecho de que MP escribe un valor fijo (hoy sin mapeo).
describe('cobro de escuela — mercadopago, método de pago', () => {
    it('21 el método que escribe no depende del medio', async () => {
        const a = await correr('mercadopago', { metodo: 'pse' });
        const b = await correr('mercadopago', { metodo: 'visa' });
        expect(a.final.payments[0].payment_method).toBe(b.final.payments[0].payment_method);
        expect(a.final.payments[0].payment_method).toMatchSnapshot();
    });
});
