// T1 · Escenario F: invitado sin cuenta (OTP, guest_token, enlace /r/:token, anti-suplantacion, rate limits).
// IMPORTANTE: los limitadores (IP / correo / telefono) viven en memoria del BFF. Reiniciar el BFF antes de
// correr este archivo:  bash test/integration/helpers/reiniciar-bff.sh enforce
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, get, post, q, q1, at, fechaDia, idem, signReservationToken } from './helpers/gemelo';

let m: Mundo;
const PHONE = '+573225550001';
const EMAIL = 't1-guest1@qa.sportmaps.test';
let guestId: string;
let guestToken: string;
let resId: string;
let statusToken: string;
const d = () => fechaDia(5, 9); // viernes
const pub = '/api/v1/public/reservations';
const reservar = (tok: string | undefined, body: any, key = idem('f'), h: Record<string, string> = {}) =>
    post(`${pub}`, body, undefined, { 'Idempotency-Key': key, ...(tok ? { 'X-Guest-Token': tok } : {}), ...h });
const body = (fac: string, a: string, b: string, extra: any = {}) => ({ facility_id: fac, starts_at: at(d(), a), ends_at: at(d(), b), ...extra });

beforeAll(async () => {
    m = await levantarMundo(); await limpiarReservas(m);
    await q(`delete from guest_bookers where phone = any($1)`, [[PHONE, '+573225550002']]);
}, 60_000);
afterAll(closeDb);

describe('F. Invitado sin cuenta', () => {
    it('F1 start: crea guest_bookers y devuelve debug_code (solo con PUBLIC_BOOKING_DEBUG_OTP); correo enmascarado', async () => {
        const r = await post(`${pub}/guests/start`, { phone: '322 555 0001', email: EMAIL, full_name: 'Invitada T1' });
        expect(r.status).toBe(200); expect(r.body.sent).toBe(true);
        expect(r.body.debug_code).toMatch(/^\d{6}$/); expect(r.body.phone_verified).toBe(false);
        expect(r.body.masked_email).not.toContain('guest1');
        const g = await q1('select * from guest_bookers where phone=$1', [PHONE]);
        guestId = g.id; expect(g.email).toBe(EMAIL); expect(g.verified_phone_at).toBeNull(); expect(g.verified_email_at).toBeNull();
        (globalThis as any).__otp = r.body.debug_code;
    });
    it('F2 verify con codigo malo -> 400 INVALID_CODE; con el bueno -> guest_token y SOLO verified_email_at', async () => {
        const bad = await post(`${pub}/guests/verify`, { phone: PHONE, email: EMAIL, code: '000000' });
        expect(bad.status).toBe(400); expect(bad.body.code).toBe('INVALID_CODE');
        const noUser = await post(`${pub}/guests/verify`, { phone: '+573990000000', email: EMAIL, code: '123456' });
        expect(noUser.status).toBe(400); expect(noUser.body.code).toBe('INVALID_CODE');
        expect(noUser.body.error).toBe(bad.body.error); // misma respuesta: no se enumera
        const ok = await post(`${pub}/guests/verify`, { phone: PHONE, email: EMAIL, code: (globalThis as any).__otp });
        expect(ok.status).toBe(200); expect(ok.body.guest_token).toBeTruthy(); expect(ok.body.phone_verified).toBe(false);
        guestToken = ok.body.guest_token;
        const g = await q1('select verified_phone_at, verified_email_at from guest_bookers where id=$1', [guestId]);
        expect(g.verified_phone_at).toBeNull(); expect(g.verified_email_at).toBeTruthy();
    });
    it('F3 anti-suplantacion: mismo telefono con OTRO correo -> 409 PHONE_IN_USE', async () => {
        const r = await post(`${pub}/guests/start`, { phone: PHONE, email: 'otro-correo@qa.sportmaps.test', full_name: 'Impostor' });
        expect(r.status).toBe(409); expect(r.body.code).toBe('PHONE_IN_USE');
        const g = await q1('select email, full_name from guest_bookers where phone=$1', [PHONE]);
        expect(g.email).toBe(EMAIL); expect(g.full_name).toBe('Invitada T1');
    });
    it('F4 POST / sin token -> 401; token basura -> 401; token vencido -> 401', async () => {
        expect((await reservar(undefined, body(m.fac.public, '09:00', '10:00'))).status).toBe(401);
        expect((await reservar('abc.def', body(m.fac.public, '09:00', '10:00'))).status).toBe(401);
        const exp = signReservationToken({ typ: 'g', gid: guestId, exp: Date.now() - 1000 });
        expect((await reservar(exp, body(m.fac.public, '09:00', '10:00'))).status).toBe(401);
        const wrongType = signReservationToken({ typ: 'r', gid: guestId, rid: guestId, exp: Date.now() + 60000 });
        expect((await reservar(wrongType, body(m.fac.public, '09:00', '10:00'))).status).toBe(401);
        const forged = signReservationToken({ typ: 'g', gid: guestId, exp: Date.now() + 60000 }, 'otro-secreto');
        expect((await reservar(forged, body(m.fac.public, '09:00', '10:00'))).status).toBe(401);
    });
    it('F5 con token pero SIN verified_phone_at -> 501 PHONE_VERIFICATION_PENDING (documentado)', async () => {
        const r = await reservar(guestToken, body(m.fac.public, '09:00', '10:00'));
        expect(r.status).toBe(501); expect(r.body.code).toBe('PHONE_VERIFICATION_PENDING');
        expect((await q('select 1 from facility_reservations where guest_booker_id=$1', [guestId])).length).toBe(0);
        const vp = await post(`${pub}/guests/verify-phone`, {});
        expect(vp.status).toBe(501);
    });
    it('F6 simulando canal verificado: reserva -> pending_payment con status_token, sin datos internos', async () => {
        await q('update guest_bookers set verified_phone_at = now() where id=$1', [guestId]);
        const r = await reservar(guestToken, body(m.fac.public, '09:00', '10:00'));
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        expect(r.body.reservation.status).toBe('pending_payment'); expect(r.body.status_token).toBeTruthy(); expect(r.body.status_path).toMatch(/^\/r\//);
        expect(JSON.stringify(r.body)).not.toMatch(/user_id|guest_booker_id|idempotency_key|price_snapshot|payment_id|school_id/);
        resId = r.body.reservation.id; statusToken = r.body.status_token;
        const row = await q1('select * from facility_reservations where id=$1', [resId]);
        expect(row.user_id).toBeNull(); expect(row.guest_booker_id).toBe(guestId); expect(row.channel).toBe('public'); expect(Number(row.price)).toBe(80000);
        // replay idempotente devuelve el MISMO status_token
        const key = idem('f6');
        const a = await reservar(guestToken, body(m.fac.public, '11:00', '12:00'), key);
        const b = await reservar(guestToken, body(m.fac.public, '11:00', '12:00'), key);
        expect(a.status).toBe(201); expect(b.status).toBe(200); expect(b.body.status_token).toBe(a.body.status_token);
    });
    it('F7 reglas: socios -> 403 AUDIENCE_NOT_ALLOWED, entrenamiento -> 422, efectivo -> 402, tope 3 activas -> 429', async () => {
        const a = await reservar(guestToken, body(m.fac.members, '14:00', '15:00'));
        expect(a.status).toBe(403); expect(a.body.code).toBe('AUDIENCE_NOT_ALLOWED');
        const t = await reservar(guestToken, body(m.fac.training, '14:00', '15:00'));
        expect(t.status).toBe(422); expect(t.body.code).toBe('FACILITY_NOT_BOOKABLE');
        const c = await reservar(guestToken, body(m.fac.public, '14:00', '15:00', { payment_method: 'cash' }));
        expect(c.status).toBe(402); expect(c.body.code).toBe('PAYMENT_REQUIRED');
        const k = await reservar(guestToken, body(m.fac.public, '15:00', '16:00')); // 3a activa
        expect(k.status).toBe(201);
        const over = await reservar(guestToken, body(m.fac.public, '16:00', '17:00'));
        expect(over.status).toBe(429); expect(over.body.code).toBe('TOO_MANY_ACTIVE');
    });
    it('F8 /r/:token: GET ok (sin internos); manipulado / vencido / de otra reserva / tipo equivocado -> rechazado', async () => {
        const g = await get(`${pub}/r/${statusToken}`);
        expect(g.status).toBe(200); expect(g.body.reservation.id).toBe(resId);
        expect(JSON.stringify(g.body)).not.toMatch(/user_id|guest_booker_id|idempotency_key|price_snapshot/);
        const [b, s] = statusToken.split('.');
        const tamper = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(b, 'base64url').toString()), rid: guestId })).toString('base64url')}.${s}`;
        expect((await get(`${pub}/r/${tamper}`)).status).toBe(401);
        expect((await get(`${pub}/r/${b}.${s.slice(0, -2)}xx`)).status).toBe(401);
        const expired = signReservationToken({ typ: 'r', gid: guestId, rid: resId, exp: Date.now() - 1000 });
        expect((await get(`${pub}/r/${expired}`)).status).toBe(401);
        expect((await post(`${pub}/r/${expired}/cancel`, {})).status).toBe(401);
        const wrongTyp = signReservationToken({ typ: 'g', gid: guestId, exp: Date.now() + 60000 });
        expect((await get(`${pub}/r/${wrongTyp}`)).status).toBe(401);
        // otro invitado con firma valida pero SU gid y el rid de la reserva ajena
        const other = (await q1(`insert into guest_bookers (phone, email, full_name, verified_phone_at) values ('+573225550002','t1-guest2@qa.sportmaps.test','Otro Invitado',now()) returning id`)).id;
        const cross = signReservationToken({ typ: 'r', gid: other, rid: resId, exp: Date.now() + 3600_000 });
        expect((await get(`${pub}/r/${cross}`)).status).toBe(404);
        const cc = await post(`${pub}/r/${cross}/cancel`, {});
        expect([403, 404]).toContain(cc.status);
        const cr = await post(`${pub}/r/${cross}/reschedule`, { starts_at: at(d(), '18:00'), ends_at: at(d(), '19:00') });
        expect([403, 404]).toContain(cr.status);
        expect((await q1('select status from facility_reservations where id=$1', [resId])).status).toBe('pending_payment');
    });
    it('F9 /r/:token/reschedule y /cancel funcionan para el dueno (reprogramar mas caro -> RESCHEDULE_PRICE_DIFFERS)', async () => {
        const caro = await post(`${pub}/r/${statusToken}/reschedule`, { starts_at: at(d(), '18:00'), ends_at: at(d(), '19:00') });
        expect(caro.status).toBe(422); expect(caro.body.code).toBe('RESCHEDULE_PRICE_DIFFERS');
        const ok = await post(`${pub}/r/${statusToken}/reschedule`, { starts_at: at(d(), '13:00'), ends_at: at(d(), '14:00') });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(JSON.stringify(ok.body)).not.toMatch(/user_id|guest_booker_id|idempotency_key|price_snapshot/);
        const c = await post(`${pub}/r/${statusToken}/cancel`, { reason: 'ya no puedo' });
        expect(c.status).toBe(200);
        const row = await q1('select status, cancellation_reason, cancelled_by from facility_reservations where id=$1', [resId]);
        expect(row.status).toBe('cancelled'); expect(row.cancellation_reason).toBe('ya no puedo'); expect(row.cancelled_by).toBeNull();
    });
    it('F10 rate limit por correo: el 4o /guests/start del mismo correo -> 429', async () => {
        const e = 't1-rate@qa.sportmaps.test'; const ph = '+573225550003';
        await q('delete from guest_bookers where phone=$1', [ph]);
        const rs = [];
        for (let i = 0; i < 4; i++) rs.push(await post(`${pub}/guests/start`, { phone: ph, email: e, full_name: 'Rate Test' }));
        const dist = rs.map((r) => r.status);
        expect(dist.slice(0, 3)).toEqual([200, 200, 200]);
        expect(dist[3]).toBe(429);
        await q('delete from guest_bookers where phone=$1', [ph]);
    });
    it('F11 rate limit de verify por telefono: tras 5 intentos -> 429', async () => {
        const rs = [];
        for (let i = 0; i < 6; i++) rs.push(await post(`${pub}/guests/verify`, { phone: PHONE, email: EMAIL, code: '111111' }));
        expect(rs[5].status).toBe(429);
    });
    it('F12 limitador por IP (5 start / 10 min): a estas alturas ya esta agotado -> 429 con mensaje de IP, sin 500', async () => {
        const a = await post(`${pub}/guests/start`, { phone: '12', email: EMAIL, full_name: 'X Y' });
        expect([400, 429]).toContain(a.status);
        const b = await post(`${pub}/guests/start`, { phone: '3225550009', email: 'sin-arroba', full_name: 'X Y' });
        expect([400, 429]).toContain(b.status);
        expect([a.status, b.status]).toContain(429); // F1+F3+F10x4 ya consumieron las 5 del IP
    });
});
