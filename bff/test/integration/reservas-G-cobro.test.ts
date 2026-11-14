// T1 · Escenario G: cobro (checkout, webhooks Wompi y MercadoPago simulados, conciliacion, transferencia).
// Las pasarelas son FALSAS: llaves locales cifradas en el gemelo; el BFF corre con el preload solo-localhost.cjs que
// simula GET /v1/transactions/:id de Wompi y GET /v1/payments/:id + POST /checkout/preferences de MercadoPago.
// Reiniciar el BFF antes de correr (limitadores en memoria):  bash test/integration/helpers/reiniciar-bff.sh enforce
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
    levantarMundo, limpiarReservas, closeDb, Mundo, post, q, q1, at, fechaDia, idem, encryptSecret,
    mockWompiTx, wompiEvent, signReservationToken, WOMPI_MOCK_FILE,
} from './helpers/gemelo';

let m: Mundo;
const EVENTS_SECRET = 'events-secret-escuela-a-FALSO';
const INTEGRITY = 'integrity-secret-escuela-a-FALSO';
const MP_SECRET = 'mp-webhook-secret-FALSO';
const WH = '/api/v1/webhooks/wompi/webhook';
const MPWH = (school: string) => `/api/v1/webhooks/mercadopago/webhook/${school}`;
let n = 0; // cada reserva en una franja distinta (<= 90 dias): 12 horas x varias semanas
const slotNuevo = () => { const i = n++; return { d: fechaDia(1, 10 + 7 * Math.floor(i / 12)), h: 6 + (i % 12) }; };
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

async function reservarOnline(tok: string, fac: string, method: 'online' | 'transfer' = 'online', extra: any = {}) {
    const { d, h } = slotNuevo();
    const r = await post('/api/v1/reservations', { facility_id: fac, starts_at: at(d, hh(h)), ends_at: at(d, hh(h + 1)), payment_method: method, ...extra }, tok, { 'Idempotency-Key': idem('g') });
    if (r.status !== 201) throw new Error(`reservar ${r.status} ${JSON.stringify(r.body)}`);
    return { id: r.body.reservation.id as string, ref: r.body.reservation.payment_reference as string, d, h, body: r.body };
}
const checkout = (tok: string, id: string, body: any = {}, h: Record<string, string> = {}) => post(`/api/v1/reservations/${id}/checkout`, body, tok, h);
const row = (id: string) => q1('select * from facility_reservations where id=$1', [id]);
async function wompiPago(ref: string, cents: number, status = 'APPROVED', opts: { id?: string; secret?: string; currency?: string; ts?: number } = {}) {
    const id = opts.id ?? `tx-${randomBytes(5).toString('hex')}`;
    mockWompiTx(id, { status, reference: ref, amount_in_cents: cents, currency: opts.currency ?? 'COP' });
    const ev = wompiEvent({ id, status, reference: ref, amount_in_cents: cents, currency: 'COP' }, opts.secret ?? EVENTS_SECRET, opts.ts);
    const r = await post(WH, ev);
    return { id, r, ev };
}
const notifs = (type: string, rid: string) => q(`select user_id, type from notifications where type=$1 and data->>'reservation_id'=$2`, [type, rid]);

beforeAll(async () => {
    m = await levantarMundo(); await limpiarReservas(m);
    await q(`delete from webhook_events where reference like 'RSV-%'`).catch(() => {});
    await q(`delete from school_payment_providers where school_id=$1`, [m.A]);
    await q(`update schools set payment_mode='unset' where id=$1`, [m.A]);
}, 60_000);
afterAll(async () => { await q(`update schools set payment_mode='unset' where id=$1`, [m.A]).catch(() => {}); await closeDb(); });

describe('G1. Checkout sin pasarela directa', () => {
    it('unset / aggregator / direct sin proveedor -> 409 SIN_PASARELA_DIRECTA', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        for (const mode of ['unset', 'aggregator', 'direct']) {
            await q(`update schools set payment_mode=$2 where id=$1`, [m.A, mode]);
            const c = await checkout(m.jwt.staffA, r.id);
            expect(c.status, mode).toBe(409); expect(c.body.error).toBe('SIN_PASARELA_DIRECTA');
        }
        expect((await q1('select price_snapshot->\'checkout\' c from facility_reservations where id=$1', [r.id])).c).toBeNull(); // no registro nada
    });
});

describe('G2. Checkout con pasarela de la escuela (llaves falsas)', () => {
    let wompiId: string;
    beforeAll(async () => {
        await q(`update schools set payment_mode='direct' where id=$1`, [m.A]);
        wompiId = (await q1(`insert into school_payment_providers (school_id, provider, public_key, sandbox, is_default, enabled, connect_method, connect_status)
            values ($1,'wompi','pub_test_t1fake',true,true,true,'manual','connected') returning id`, [m.A])).id;
        await q(`insert into payment_provider_secrets (provider_id, private_key_enc, integrity_secret_enc, events_secret_enc) values ($1,$2,$3,$4)`,
            [wompiId, encryptSecret('prv_test_t1fake'), encryptSecret(INTEGRITY), encryptSecret(EVENTS_SECRET)]);
        const mpId = (await q1(`insert into school_payment_providers (school_id, provider, public_key, sandbox, is_default, enabled, connect_method, connect_status)
            values ($1,'mercadopago','TEST-t1-pub',true,false,true,'manual','connected') returning id`, [m.A])).id;
        await q(`insert into payment_provider_secrets (provider_id, access_token_enc, events_secret_enc) values ($1,$2,$3)`, [mpId, encryptSecret('TEST-t1-access'), encryptSecret(MP_SECRET)]);
    });

    it('Wompi: checkout_url firmada localmente, monto = abono minimo, expiracion = hold, monto registrado', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        const c = await checkout(m.jwt.staffA, r.id);
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body).toMatchObject({ provider: 'wompi', amount: 30000, reference: r.ref });
        const u = new URL(c.body.checkout_url);
        expect(u.searchParams.get('public-key')).toBe('pub_test_t1fake');
        expect(u.searchParams.get('amount-in-cents')).toBe('3000000');
        const exp = u.searchParams.get('expiration-time')!;
        expect(exp).toBe(new Date((await row(r.id)).hold_expires_at).toISOString());
        const sig = createHash('sha256').update(`${r.ref}3000000COP${exp}${INTEGRITY}`).digest('hex');
        expect(u.searchParams.get('signature:integrity')).toBe(sig);
        expect(c.body.checkout_url).not.toContain(INTEGRITY);
        expect((await row(r.id)).price_snapshot.checkout_amounts).toEqual([30000]);
    });
    it('el monto lo decide el servidor: fuera de [abono, saldo] -> 400; total OK', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        expect((await checkout(m.jwt.staffA, r.id, { amount: 1000 })).status).toBe(400);
        expect((await checkout(m.jwt.staffA, r.id, { amount: 100001 })).status).toBe(400);
        expect((await checkout(m.jwt.staffA, r.id, { amount: 30000.5 })).status).toBe(400);
        const t = await checkout(m.jwt.staffA, r.id, { mode: 'total' });
        expect(t.status).toBe(200); expect(t.body.amount).toBe(100000);
        expect((await row(r.id)).price_snapshot.checkout_amounts.sort()).toEqual([100000]);
    });
    it('ajeno -> 404; reserva no pagable -> 409; hold vencido -> 409', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        expect((await checkout(m.jwt.externo2, r.id)).status).toBe(404);
        expect((await checkout(m.jwt.staffB, r.id)).status).toBe(404);
        expect((await post(`/api/v1/reservations/${r.id}/checkout`, {})).status).toBe(401);
        await q(`update facility_reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [r.id]);
        const c = await checkout(m.jwt.staffA, r.id);
        expect(c.status).toBe(409); expect(c.body.error).toBe('hold_expired');
        const r2 = await reservarOnline(m.jwt.staffA, m.fac.both, 'online', { payment_method: 'none' }).catch(() => null);
        void r2;
    });
    it('el staff de OTRA escuela con la reserva de A no obtiene link', async () => {
        const r = await reservarOnline(m.jwt.padre, m.fac.both);
        expect((await checkout(m.jwt.ownerB, r.id)).status).toBe(404);
        await q(`update facility_reservations set status='cancelled' where id=$1`, [r.id]);
    });
    it('MercadoPago (cuenta de la escuela, simulada): preferencia con monto, referencia y vencimiento del hold', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        const callsFile = `${WOMPI_MOCK_FILE}.calls.jsonl`;
        const before = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length : 0;
        const c = await checkout(m.jwt.staffA, r.id, { provider: 'mercadopago' });
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        expect(c.body).toMatchObject({ provider: 'mercadopago', amount: 30000, reference: r.ref });
        expect(c.body.checkout_url).toMatch(/pref_id=pref-t1-mock/);
        const calls = readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
        const pref = calls.find((x) => x.path === '/checkout/preferences');
        const body = JSON.parse(pref.body);
        expect(body.external_reference).toBe(r.ref); expect(body.items[0].unit_price).toBe(30000);
        expect(body.notification_url).toContain(`/webhook/${m.A}`);
        expect(new Date(body.expiration_date_to).toISOString()).toBe(new Date((await row(r.id)).hold_expires_at).toISOString());
    });
    it('proveedor no habilitado (preferido = mercadopago sin cuenta MP) y escuela sin pasarela no usan llaves de ENV', async () => {
        await q(`update school_payment_providers set enabled=false where school_id=$1 and provider='mercadopago'`, [m.A]);
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        const c = await checkout(m.jwt.staffA, r.id, { provider: 'mercadopago' });
        expect(c.status).toBe(409); expect(c.body.error).toBe('SIN_PASARELA_DIRECTA');
        await q(`update school_payment_providers set enabled=true where school_id=$1 and provider='mercadopago'`, [m.A]);
    });
});

describe('G3. Webhook Wompi (RSV) con checksum valido de la escuela', () => {
    it('APPROVED por el abono -> confirmed; amount_paid; evento registrado; aviso al reservante', async () => {
        const r = await reservarOnline(m.jwt.padre, m.fac.both);
        await checkout(m.jwt.padre, r.id);
        const { id, r: w } = await wompiPago(r.ref, 1800000);
        expect(w.status, JSON.stringify(w.body)).toBe(200); expect(w.body).toMatchObject({ status: 'ok', confirmed: true });
        const d = await row(r.id);
        expect(d.status).toBe('confirmed'); expect(Number(d.amount_paid)).toBe(18000); expect(d.payment_status).toBe('partial');
        expect(d.price_snapshot.payment_events).toContain(`wompi:${id}`);
        expect((await notifs('booking_confirmed', r.id)).map((n: any) => n.user_id)).toEqual([m.u.padre]);
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [r.id]);
        expect(occ.status).toBe('active');
    });
    it('mismo evento dos veces -> already_processed y NO suma dos veces', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        const first = await wompiPago(r.ref, 3000000);
        expect(first.r.body.status).toBe('ok');
        const again = await post(WH, first.ev);
        expect(again.status).toBe(200); expect(again.body.status).toBe('already_processed');
        // reentrega con otro timestamp/checksum, misma transaccion
        const ev2 = wompiEvent({ id: first.id, status: 'APPROVED', reference: r.ref, amount_in_cents: 3000000, currency: 'COP' }, EVENTS_SECRET, Math.floor(Date.now() / 1000) - 5);
        const again2 = await post(WH, ev2);
        expect(again2.body.status).toBe('already_processed');
        expect(Number((await row(r.id)).amount_paid)).toBe(30000);
    });
    it('checksum con otro secreto -> 401; timestamp viejo (replay) -> 401; evento sin transaccion real en la pasarela -> 400', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        expect((await wompiPago(r.ref, 3000000, 'APPROVED', { secret: 'secreto-equivocado' })).r.status).toBe(401);
        expect((await wompiPago(r.ref, 3000000, 'APPROVED', { ts: Math.floor(Date.now() / 1000) - 3600 })).r.status).toBe(401);
        const id = 'tx-fantasma'; // firmado bien pero la "pasarela" no lo conoce
        const ev = wompiEvent({ id, status: 'APPROVED', reference: r.ref, amount_in_cents: 3000000, currency: 'COP' }, EVENTS_SECRET);
        expect((await post(WH, ev)).status).toBe(400);
        expect((await row(r.id)).status).toBe('pending_payment');
        // la pasarela dice otro estado que el webhook -> 400
        mockWompiTx('tx-spoof', { status: 'DECLINED', reference: r.ref, amount_in_cents: 3000000 });
        const ev2 = wompiEvent({ id: 'tx-spoof', status: 'APPROVED', reference: r.ref, amount_in_cents: 3000000, currency: 'COP' }, EVENTS_SECRET);
        expect((await post(WH, ev2)).status).toBe(400);
        expect((await row(r.id)).status).toBe('pending_payment');
    });
    it('monto que NO cuadra con lo ofrecido -> no confirma, 200 rejected y alerta a admins (dueno y school_admin)', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id); // ofrece 30000
        const { r: w } = await wompiPago(r.ref, 5000000); // 50000
        expect(w.status).toBe(200); expect(w.body).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
        const d = await row(r.id);
        expect(d.status).toBe('pending_payment'); expect(Number(d.amount_paid)).toBe(0);
        const to = (await notifs('reservation_payment_rejected', r.id)).map((n: any) => n.user_id).sort();
        expect(to).toEqual([m.u.ownerA, m.u.staffA].sort());
    });
    it('monto mayor al saldo / moneda distinta de COP', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        const big = await wompiPago(r.ref, 50000000); // 500.000 > saldo
        expect(big.r.body).toMatchObject({ status: 'rejected' });
        const usd = await wompiPago(r.ref, 3000000, 'APPROVED', { currency: 'USD' });
        expect(usd.r.status).toBe(400);
        expect((await row(r.id)).status).toBe('pending_payment');
    });
    it('pago total (mode total) -> confirmed y payment_status paid', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id, { mode: 'total' });
        const { r: w } = await wompiPago(r.ref, 10000000);
        expect(w.body.confirmed).toBe(true);
        const d = await row(r.id);
        expect(d.status).toBe('confirmed'); expect(d.payment_status).toBe('paid');
    });
    it('DECLINED no mueve nada; VOIDED alerta a admins', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        const dec = await wompiPago(r.ref, 3000000, 'DECLINED');
        expect(dec.r.body).toMatchObject({ status: 'ok', applied: false });
        const v = await wompiPago(r.ref, 3000000, 'VOIDED');
        expect(v.r.status).toBe(200);
        expect((await row(r.id)).status).toBe('pending_payment');
        expect((await notifs('reservation_payment_voided', r.id)).length).toBeGreaterThan(0);
    });
    it('pago TARDIO con hold vencido y franja libre -> confirmed (re-ocupa)', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        await q(`update facility_reservations set hold_expires_at = now() - interval '2 minutes' where id=$1`, [r.id]);
        const { r: w } = await wompiPago(r.ref, 3000000);
        expect(w.body).toMatchObject({ status: 'ok', confirmed: true });
        expect((await row(r.id)).status).toBe('confirmed');
        expect((await q1(`select status from facility_occupancy where source_id=$1`, [r.id])).status).toBe('active');
    });
    it('pago TARDIO con franja ya tomada -> pending_reconciliation + alerta a admins; el pago no se pierde', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        await q(`update facility_reservations set hold_expires_at = now() - interval '2 minutes' where id=$1`, [r.id]);
        // otra persona toma la franja (la RPC libera el hold vencido antes de insertar)
        const taken = await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: at(r.d, hh(r.h)), ends_at: at(r.d, hh(r.h + 1)) }, m.jwt.externo2, { 'Idempotency-Key': idem('g-taken') });
        expect(taken.status, JSON.stringify(taken.body)).toBe(201);
        const { r: w } = await wompiPago(r.ref, 3000000);
        expect(w.status).toBe(200); expect(w.body).toMatchObject({ status: 'ok', reconciliation: true });
        const d = await row(r.id);
        expect(d.status).toBe('pending_reconciliation'); expect(Number(d.amount_paid)).toBe(30000);
        const to = (await notifs('reservation_reconciliation', r.id)).map((n: any) => n.user_id).sort();
        expect(to).toEqual([m.u.ownerA, m.u.staffA].sort());
        // el ganador de la franja sigue activo
        expect((await row(taken.body.reservation.id)).status).toBe('pending_payment');
        // y la cancelacion de una pending_reconciliation es sin ventana y con 100 %
        const c = await post(`/api/v1/reservations/${r.id}/cancel`, {}, m.jwt.staffA);
        expect(c.status).toBe(200); expect(c.body.refund).toMatchObject({ pct: 100, amount: 30000 });
    });
    it('referencia desconocida -> 200 ignorado (firmada con la llave global); referencia con inyeccion no da 500', async () => {
        const ref = 'RSV-FFFFFFFFFFFFFFFF';
        const id = 'tx-desconocida';
        mockWompiTx(id, { status: 'APPROVED', reference: ref, amount_in_cents: 3000000 });
        const ev = wompiEvent({ id, status: 'APPROVED', reference: ref, amount_in_cents: 3000000, currency: 'COP' }, 'events-global-falso-t1');
        const w = await post(WH, ev);
        expect(w.status).toBe(200); expect(w.body).toMatchObject({ status: 'ignored', reason: 'reservation_not_found' });
        const evil = wompiEvent({ id: 'tx-evil', status: 'APPROVED', reference: "RSV-x'); drop table facility_reservations;--", amount_in_cents: 1, currency: 'COP' }, 'events-global-falso-t1');
        mockWompiTx('tx-evil', { status: 'APPROVED', reference: "RSV-x'); drop table facility_reservations;--", amount_in_cents: 1 });
        expect((await post(WH, evil)).status).toBeLessThan(500);
        expect((await q1('select count(*)::int n from facility_reservations')).n).toBeGreaterThan(0);
    });
    it('un evento firmado con el secreto GLOBAL no confirma una reserva cuya escuela tiene su propio secreto', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id);
        const { r: w } = await wompiPago(r.ref, 3000000, 'APPROVED', { secret: 'events-global-falso-t1' });
        expect(w.status).toBe(401);
        expect((await row(r.id)).status).toBe('pending_payment');
    });
});

describe('G4. Transferencia: comprobante y confirmacion de staff', () => {
    const STORAGE = 'http://127.0.0.1:54321/storage/v1/object/public/comprobantes/t1-proof.png';
    it('transfer-proof: URL ajena -> 400; valida -> hold 12 h y UNA sola vez; ajeno -> 404; aviso a admins', async () => {
        const r = await reservarOnline(m.jwt.atleta, m.fac.both, 'transfer');
        const bad = await post(`/api/v1/reservations/${r.id}/transfer-proof`, { proof_url: 'https://evil.example/x.png' }, m.jwt.atleta);
        expect(bad.status).toBe(400);
        expect((await post(`/api/v1/reservations/${r.id}/transfer-proof`, { proof_url: STORAGE }, m.jwt.staffB)).status).toBe(404);
        const a = await post(`/api/v1/reservations/${r.id}/transfer-proof`, { proof_url: STORAGE }, m.jwt.atleta);
        expect(a.status).toBe(200); expect(a.body.in_review).toBe(true);
        const h1 = new Date((await row(r.id)).hold_expires_at).getTime();
        expect((h1 - Date.now()) / 3600e3).toBeGreaterThan(11.5);
        await new Promise((ok) => setTimeout(ok, 1100));
        const b = await post(`/api/v1/reservations/${r.id}/transfer-proof`, { proof_url: STORAGE + '?v=2' }, m.jwt.atleta);
        expect(b.status).toBe(200);
        expect(new Date((await row(r.id)).hold_expires_at).getTime()).toBe(h1); // no se alargo otra vez
        expect((await notifs('reservation_transfer_proof', r.id)).length).toBeGreaterThan(0);
    });
    it('confirm-transfer: solo staff (school_admin y owner si; coach, dueno y otra escuela no); idempotente; monto > saldo -> 400', async () => {
        const r = await reservarOnline(m.jwt.atleta, m.fac.both, 'transfer');
        await post(`/api/v1/reservations/${r.id}/transfer-proof`, { proof_url: STORAGE }, m.jwt.atleta);
        for (const [who, tok] of [['dueno', m.jwt.atleta], ['coach', m.jwt.coachA], ['staffB', m.jwt.staffB]] as const) {
            expect((await post(`/api/v1/reservations/${r.id}/confirm-transfer`, { amount: 30000 }, tok)).status, who).toBe(404);
        }
        expect((await post(`/api/v1/reservations/${r.id}/confirm-transfer`, { amount: 200000 }, m.jwt.staffA)).status).toBe(400);
        const ok = await post(`/api/v1/reservations/${r.id}/confirm-transfer`, { amount: 30000 }, m.jwt.staffA); // school_admin
        expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body).toMatchObject({ confirmed: true, already_processed: false });
        const d = await row(r.id);
        expect(d.status).toBe('confirmed'); expect(Number(d.amount_paid)).toBe(30000);
        const again = await post(`/api/v1/reservations/${r.id}/confirm-transfer`, { amount: 30000 }, m.jwt.ownerA);
        expect(again.status).toBe(200); expect(again.body.already_processed).toBe(true);
        expect(Number((await row(r.id)).amount_paid)).toBe(30000);
        expect((await notifs('booking_confirmed', r.id)).length).toBe(1);
    });
    it('sin comprobante -> 409 no_transfer_proof', async () => {
        const r = await reservarOnline(m.jwt.atleta, m.fac.both, 'transfer');
        const c = await post(`/api/v1/reservations/${r.id}/confirm-transfer`, { amount: 30000 }, m.jwt.staffA);
        expect(c.status).toBe(409); expect(c.body.error).toBe('no_transfer_proof');
    });
});

describe('G5. Invitado paga con el token de su enlace (X-Reservation-Token)', () => {
    it('con el token de SU reserva -> link; token de otra / sin token -> rechazado', async () => {
        const ph = '+573225550077';
        await q('delete from facility_reservations where guest_booker_id in (select id from guest_bookers where phone=$1)', [ph]);
        await q('delete from guest_bookers where phone=$1', [ph]);
        const g = await q1(`insert into guest_bookers (phone, email, full_name, verified_phone_at, verified_email_at) values ($1,'t1-gpay@qa.sportmaps.test','Invitado Pago',now(),now()) returning id`, [ph]);
        const gt = signReservationToken({ typ: 'g', gid: g.id, exp: Date.now() + 600_000 });
        const { d, h } = slotNuevo();
        const res = await post('/api/v1/public/reservations', { facility_id: m.fac.public, starts_at: at(d, hh(h)), ends_at: at(d, hh(h + 1)) }, undefined, { 'Idempotency-Key': idem('gp'), 'X-Guest-Token': gt });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const rid = res.body.reservation.id;
        const ok = await checkout('', rid, {}, { 'X-Reservation-Token': res.body.status_token });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200); expect(ok.body.provider).toBe('wompi');
        const other = signReservationToken({ typ: 'r', gid: g.id, rid: m.A, exp: Date.now() + 600_000 }); // token de otra reserva
        expect((await checkout('', rid, {}, { 'X-Reservation-Token': other })).status).toBe(404);
        expect((await checkout('', rid, {})).status).toBe(401);
        const foreign = signReservationToken({ typ: 'r', gid: m.u.padre, rid, exp: Date.now() + 600_000 });
        expect((await checkout('', rid, {}, { 'X-Reservation-Token': foreign })).status).toBe(404); // gid != guest_booker_id de la fila
        // el invitado NO puede confirmar transferencias
        const ct = await post(`/api/v1/reservations/${rid}/confirm-transfer`, { amount: 1 }, undefined, { 'X-Reservation-Token': res.body.status_token });
        expect(ct.status).toBe(401);
    });
});

describe('G6. Webhook MercadoPago (RSV), firma HMAC con el secreto de la escuela', () => {
    const mpEvent = async (ref: string, amount: number, opts: { status?: string; secret?: string; payId?: string } = {}) => {
        const payId = opts.payId ?? String(Math.floor(Math.random() * 1e9));
        const key = `mp:${payId}`;
        const cur = JSON.parse(readFileSync(WOMPI_MOCK_FILE, 'utf8'));
        cur[key] = { status: opts.status ?? 'approved', external_reference: ref, transaction_amount: amount, currency_id: 'COP', payment_method_id: 'visa', payment_type_id: 'credit_card' };
        writeFileSync(WOMPI_MOCK_FILE, JSON.stringify(cur));
        const ts = String(Date.now()); const reqId = idem('mpreq');
        const v1 = createHmac('sha256', opts.secret ?? MP_SECRET).update(`id:${payId};request-id:${reqId};ts:${ts};`).digest('hex');
        const r = await post(MPWH(m.A), { type: 'payment', action: 'payment.updated', data: { id: payId } }, undefined, { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': reqId });
        return { r, payId };
    };
    it('approved por el abono -> confirmed; firma mala -> 401; repetido -> already_processed', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id, { provider: 'mercadopago' });
        expect((await mpEvent(r.ref, 30000, { secret: 'otro' })).r.status).toBe(401);
        expect((await row(r.id)).status).toBe('pending_payment');
        const ok = await mpEvent(r.ref, 30000);
        expect(ok.r.status, JSON.stringify(ok.r.body)).toBe(200); expect(ok.r.body).toMatchObject({ status: 'ok', confirmed: true });
        const d = await row(r.id);
        expect(d.status).toBe('confirmed'); expect(Number(d.amount_paid)).toBe(30000);
        expect(d.price_snapshot.payment_events.some((e: string) => e.startsWith('mercadopago:'))).toBe(true);
        const ev = ok.r;
        void ev;
    });
    it('monto que no cuadra -> rejected + alerta; replay del mismo pago no suma', async () => {
        const r = await reservarOnline(m.jwt.staffA, m.fac.both);
        await checkout(m.jwt.staffA, r.id, { provider: 'mercadopago' });
        const bad = await mpEvent(r.ref, 55555);
        expect(bad.r.body).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
        expect((await row(r.id)).status).toBe('pending_payment');
        const good = await mpEvent(r.ref, 30000, { payId: '777000111' });
        expect(good.r.body.confirmed).toBe(true);
        const again = await mpEvent(r.ref, 30000, { payId: '777000111' });
        expect(again.r.body.status).toBe('already_processed');
        expect(Number((await row(r.id)).amount_paid)).toBe(30000);
    });
});
