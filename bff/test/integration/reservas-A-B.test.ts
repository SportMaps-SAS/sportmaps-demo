// T1 · Escenarios A (disponibilidad) y B (reservar con sesion) por HTTP real contra el BFF + gemelo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, get, post, q, q1, at, utc, fechaDia, idem } from './helpers/gemelo';

let m: Mundo;
const avail = (tok: string, extra = '', school?: string) => get(`/api/v1/reservations/availability?school_id=${school ?? m.A}${extra}`, tok);
const names = (b: any) => (b.facilities ?? []).map((f: any) => f.name).sort();
const slot = (b: any, facId: string, date: string, startLocal: string) =>
    b.facilities.find((f: any) => f.facility_id === facId)?.days.find((d: any) => d.date === date)?.slots.find((s: any) => s.start_local === startLocal);

beforeAll(async () => { m = await levantarMundo(); await limpiarReservas(m); }, 60_000);
afterAll(closeDb);

describe('A. Disponibilidad', () => {
    const wed = fechaDia(3, 4);       // miercoles
    const sat = fechaDia(6, 4);
    const holiday = '2026-11-16';     // lunes festivo (co_holidays)
    const monNormal = '2026-11-09';

    it('A0 sin sesion -> 401', async () => {
        const r = await get(`/api/v1/reservations/availability?school_id=${m.A}&from=${wed}&to=${wed}`);
        expect(r.status).toBe(401);
    });
    it('A1 staff ve members+public+both (no entrenamiento) con tarifa public por defecto', async () => {
        const r = await avail(m.jwt.staffA, `&from=${wed}&to=${wed}`);
        expect(r.status).toBe(200);
        expect(names(r.body)).toEqual(['t1-Cancha Ambas', 't1-Cancha Publica', 't1-Cancha Socios']);
        expect(names(r.body)).not.toContain('t1-Entrenamiento');
    });
    it('A2 staff con audience=member ve tarifa socio', async () => {
        const r = await avail(m.jwt.staffA, `&from=${wed}&to=${wed}&audience=member`);
        expect(slot(r.body, m.fac.both, wed, '10:00').price).toBe(60000);
        const rp = await avail(m.jwt.staffA, `&from=${wed}&to=${wed}`);
        expect(slot(rp.body, m.fac.both, wed, '10:00').price).toBe(100000);
    });
    it('A3 miembro (padre) ve socios+publica+ambas con tarifa member donde aplica', async () => {
        const r = await avail(m.jwt.padre, `&from=${wed}&to=${wed}`);
        expect(r.status).toBe(200);
        expect(names(r.body)).toEqual(['t1-Cancha Ambas', 't1-Cancha Publica', 't1-Cancha Socios']);
        expect(slot(r.body, m.fac.members, wed, '10:00').price).toBe(50000);
        expect(slot(r.body, m.fac.both, wed, '10:00').price).toBe(60000);
        expect(slot(r.body, m.fac.public, wed, '10:00').price).toBe(80000); // bookable_by=public => tarifa public
    });
    it('A4 externo NO ve la cancha de socios ni la de entrenamiento', async () => {
        const r = await avail(m.jwt.externo, `&from=${wed}&to=${wed}`);
        expect(r.status).toBe(200);
        expect(names(r.body)).toEqual(['t1-Cancha Ambas', 't1-Cancha Publica']);
        expect(slot(r.body, m.fac.both, wed, '10:00').price).toBe(100000);
    });
    it('A5 externo no puede forzar audience=member (solo staff)', async () => {
        const r = await avail(m.jwt.externo, `&from=${wed}&to=${wed}&audience=member`);
        expect(r.status).toBe(200);
        expect(slot(r.body, m.fac.both, wed, '10:00').price).toBe(100000);
    });
    it('A6 pico/valle: 17:00=80k, 18:00=120k, 17:30 mezcla (40k+60k)=100k', async () => {
        const r = await avail(m.jwt.externo, `&from=${wed}&to=${wed}&facility_id=${m.fac.public}`);
        expect(slot(r.body, m.fac.public, wed, '17:00').price).toBe(80000);
        expect(slot(r.body, m.fac.public, wed, '18:00').price).toBe(120000);
        expect(slot(r.body, m.fac.public, wed, '17:30').price).toBe(100000);
        expect(slot(r.body, m.fac.public, wed, '17:00').deposit_min).toBe(24000); // 30 %
    });
    it('A7 festivo se cobra como domingo; fin de semana igual', async () => {
        const r = await avail(m.jwt.externo, `&from=${monNormal}&to=${holiday}&facility_id=${m.fac.public}`);
        expect(r.status).toBe(200);
        expect(slot(r.body, m.fac.public, monNormal, '10:00').price).toBe(80000);
        const h = r.body.facilities[0].days.find((d: any) => d.date === holiday);
        expect(h.is_holiday).toBe(true);
        expect(slot(r.body, m.fac.public, holiday, '10:00').price).toBe(100000);
        const s = await avail(m.jwt.externo, `&from=${sat}&to=${sat}&facility_id=${m.fac.public}`);
        expect(slot(s.body, m.fac.public, sat, '10:00').price).toBe(100000);
    });
    it('A8 facility_id explicito: entrenamiento -> 422 FACILITY_NOT_BOOKABLE; socios a externo -> 403 AUDIENCE_NOT_ALLOWED', async () => {
        const a = await avail(m.jwt.padre, `&from=${wed}&to=${wed}&facility_id=${m.fac.training}`);
        expect(a.status).toBe(422); expect(a.body.code).toBe('FACILITY_NOT_BOOKABLE');
        const b = await avail(m.jwt.externo, `&from=${wed}&to=${wed}&facility_id=${m.fac.members}`);
        expect(b.status).toBe(403); expect(b.body.code).toBe('AUDIENCE_NOT_ALLOWED');
    });
    it('A9 facility de otra escuela -> 404 FACILITY_NOT_FOUND; rango >30 dias -> 422 RANGE_TOO_LARGE; fecha mala -> 400', async () => {
        const a = await avail(m.jwt.externo, `&from=${wed}&to=${wed}&facility_id=${m.fac.b}`);
        expect(a.status).toBe(404); expect(a.body.code).toBe('FACILITY_NOT_FOUND');
        const b = await avail(m.jwt.externo, `&from=${wed}&to=${fechaDia(3, 50)}`);
        expect(b.status).toBe(422); expect(b.body.code).toBe('RANGE_TOO_LARGE');
        const c = await avail(m.jwt.externo, `&from=hoy&to=${wed}`);
        expect(c.status).toBe(400);
    });
    it('A10 pagina publica /public/reservations/availability = vista del externo (sin sesion)', async () => {
        const r = await get(`/api/v1/public/reservations/availability?school_id=${m.A}&from=${wed}&to=${wed}`);
        expect(r.status).toBe(200);
        expect(names(r.body)).toEqual(['t1-Cancha Ambas', 't1-Cancha Publica']);
        expect(JSON.stringify(r.body)).not.toMatch(/idempotency|guest_booker|price_snapshot|hourly_rate|rental_rate/);
    });
});

describe('B. Reservar con sesion', () => {
    const d = fechaDia(4, 6);   // jueves, lejos
    const post_ = (tok: string, body: any, key = idem(), extraH: Record<string, string> = {}) =>
        post('/api/v1/reservations', body, tok, { 'Idempotency-Key': key, ...extraH });
    const body = (fac: string, from: string, to: string, extra: any = {}) => ({ facility_id: fac, starts_at: at(d, from), ends_at: at(d, to), ...extra });

    it('B1 sin Idempotency-Key -> 400', async () => {
        const r = await post('/api/v1/reservations', body(m.fac.public, '08:00', '09:00'), m.jwt.externo);
        expect(r.status).toBe(400); expect(r.body.reason).toBe('idempotency_key_required');
    });
    it('B2 sin sesion -> 401', async () => {
        const r = await post('/api/v1/reservations', body(m.fac.public, '08:00', '09:00'), undefined, { 'Idempotency-Key': idem() });
        expect(r.status).toBe(401);
    });
    it('B3 staff uso interno (none) -> confirmed, waived, price 0, staff_override', async () => {
        const r = await post_(m.jwt.staffA, body(m.fac.public, '06:00', '07:00', { payment_method: 'none', channel: 'admin' }));
        expect(r.status).toBe(201);
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.status).toBe('confirmed'); expect(row.payment_status).toBe('waived'); expect(Number(row.price)).toBe(0);
        expect(row.user_id).toBe(m.u.staffA); expect(row.channel).toBe('admin');
        const occ = await q1(`select count(*)::int n from facility_occupancy where source_id=$1 and status='active' and source_kind='rental'`, [r.body.reservation.id]);
        expect(occ.n).toBe(1);
    });
    it('B3b staff se salta OUTSIDE_HOURS (05:00) y queda staff_override=true; no staff recibe OUTSIDE_HOURS', async () => {
        const r = await post_(m.jwt.staffA, body(m.fac.public, '05:00', '06:00', { payment_method: 'none' }));
        expect(r.status).toBe(201);
        const row = await q1('select price_snapshot from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.price_snapshot.staff_override).toBe(true);
    });
    it('B4 staff a nombre de tercero con cuenta (efectivo con amount_paid parcial)', async () => {
        const r = await post_(m.jwt.staffA, body(m.fac.both, '07:00', '08:00', { payment_method: 'cash', booker_profile_id: m.u.padre, amount_paid: 20000, channel: 'admin' }));
        expect(r.status).toBe(201);
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.user_id).toBe(m.u.padre); expect(row.status).toBe('confirmed'); expect(row.payment_status).toBe('partial'); expect(Number(row.amount_paid)).toBe(20000);
        expect(Number(row.price)).toBe(100000); // tarifa public (staff elige; por defecto public)
    });
    it('B5 staff a nombre de invitado (p_guest) con tarifa member explicita', async () => {
        const r = await post_(m.jwt.staffA, body(m.fac.both, '08:00', '09:00', { payment_method: 'cash', guest: { phone: '+573115550001', full_name: 'Invitado T1', email: 't1-inv@qa.sportmaps.test' }, amount_paid: 60000, rate_audience: 'member', channel: 'admin' }));
        expect(r.status).toBe(201);
        const row = await q1(`select r.*, g.phone, g.verified_phone_at from facility_reservations r join guest_bookers g on g.id=r.guest_booker_id where r.id=$1`, [r.body.reservation.id]);
        expect(row.user_id).toBeNull(); expect(row.phone).toBe('+573115550001'); expect(row.verified_phone_at).toBeNull();
        expect(Number(row.price)).toBe(60000); expect(row.payment_status).toBe('paid');
    });
    it('B6 miembro (padre) con tarifa member, pago online -> pending_payment + hold 10 min', async () => {
        const r = await post_(m.jwt.padre, body(m.fac.both, '10:00', '11:00'));
        expect(r.status).toBe(201); expect(r.body.requires_payment).toBe(true);
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.status).toBe('pending_payment'); expect(Number(row.price)).toBe(60000); expect(row.price_snapshot.audience).toBe('member');
        const mins = (new Date(row.hold_expires_at).getTime() - Date.now()) / 60000;
        expect(mins).toBeGreaterThan(8); expect(mins).toBeLessThan(10.5);
        expect(row.payment_reference).toMatch(/^RSV-[0-9A-F]{16}$/i);
    });
    it('B7 atleta adulto miembro con tarifa member (transfer -> hold 15 min)', async () => {
        const r = await post_(m.jwt.atleta, body(m.fac.members, '10:00', '11:00', { payment_method: 'transfer' }));
        expect(r.status).toBe(201);
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(Number(row.price)).toBe(50000);
        const mins = (new Date(row.hold_expires_at).getTime() - Date.now()) / 60000;
        expect(mins).toBeGreaterThan(13); expect(mins).toBeLessThan(15.5);
    });
    it('B8 externo con cuenta en cancha public -> 201 tarifa public; cash externo -> 402 PAYMENT_REQUIRED', async () => {
        const r = await post_(m.jwt.externo, body(m.fac.public, '09:00', '10:00'));
        expect(r.status).toBe(201);
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(Number(row.price)).toBe(80000); expect(row.user_id).toBe(m.u.externo);
        const c = await post_(m.jwt.externo, body(m.fac.public, '12:00', '13:00', { payment_method: 'cash' }));
        expect(c.status).toBe(402); expect(c.body.code).toBe('PAYMENT_REQUIRED');
    });
    it('B9 el MENOR recibe 403 MINOR_CANNOT_BOOK; su acudiente (padre) si puede', async () => {
        const r = await post_(m.jwt.menor, body(m.fac.both, '13:00', '14:00'));
        expect(r.status).toBe(403); expect(r.body.code).toBe('MINOR_CANNOT_BOOK');
        const ok = await post_(m.jwt.padre, body(m.fac.both, '13:00', '14:00'));
        expect(ok.status).toBe(201);
    });
    it('B10 externo en cancha de socios -> 403 AUDIENCE_NOT_ALLOWED', async () => {
        const r = await post_(m.jwt.externo, body(m.fac.members, '15:00', '16:00'));
        expect(r.status).toBe(403); expect(r.body.code).toBe('AUDIENCE_NOT_ALLOWED');
    });
    it('B11 cancha en entrenamiento -> 422 FACILITY_NOT_BOOKABLE (tambien staff)', async () => {
        const r = await post_(m.jwt.externo, body(m.fac.training, '15:00', '16:00'));
        expect(r.status).toBe(422); expect(r.body.code).toBe('FACILITY_NOT_BOOKABLE');
        const s = await post_(m.jwt.staffA, body(m.fac.training, '15:00', '16:00', { payment_method: 'none' }));
        expect(s.status).toBe(422); expect(s.body.code).toBe('FACILITY_NOT_BOOKABLE');
    });
    it('B12 misma llave repetida -> 200 idempotent_replay y UNA sola fila; llave de otro usuario -> 409 IDEMPOTENCY_KEY_REUSED', async () => {
        const key = idem('rep');
        const b = body(m.fac.public, '16:00', '17:00');
        const r1 = await post_(m.jwt.externo, b, key);
        expect(r1.status).toBe(201);
        const r2 = await post_(m.jwt.externo, b, key);
        expect(r2.status).toBe(200); expect(r2.body.idempotent_replay).toBe(true);
        expect(r2.body.reservation.id).toBe(r1.body.reservation.id);
        const n = await q1('select count(*)::int n from facility_reservations where school_id=$1 and idempotency_key=$2', [m.A, key]);
        expect(n.n).toBe(1);
        const r3 = await post_(m.jwt.padre, b, key);
        expect(r3.status).toBe(409); expect(r3.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
        const r4 = await post_(m.jwt.externo, body(m.fac.public, '19:00', '20:00'), key);
        expect(r4.status).toBe(409); expect(r4.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
    it('B13 TOO_MANY_ACTIVE al 4o (no staff) -> 429', async () => {
        const d2 = fechaDia(2, 8);
        const bd = (a: string, b: string) => ({ facility_id: m.fac.both, starts_at: at(d2, a), ends_at: at(d2, b) });
        const res = [];
        for (const [a, b] of [['06:00', '07:00'], ['07:00', '08:00'], ['08:00', '09:00'], ['09:00', '10:00']]) res.push(await post_(m.jwt.externo2, bd(a, b)));
        expect(res.slice(0, 3).map((x) => x.status)).toEqual([201, 201, 201]);
        expect(res[3].status).toBe(429); expect(res[3].body.code).toBe('TOO_MANY_ACTIVE');
    });
    it('B14 DURATION_TOO_LONG (>240 min) -> 422', async () => {
        const r = await post_(m.jwt.externo, body(m.fac.public, '06:00', '11:00'));
        expect(r.status).toBe(422); expect(r.body.code).toBe('DURATION_TOO_LONG');
    });
    it('B15 franja ocupada -> 409 SLOT_TAKEN con alternatives', async () => {
        const r = await post_(m.jwt.staffA, body(m.fac.public, '09:00', '10:00', { payment_method: 'none' })); // B8 ya la tomo
        expect(r.status).toBe(409); expect(r.body.code).toBe('SLOT_TAKEN');
        expect(Array.isArray(r.body.alternatives)).toBe(true); expect(r.body.alternatives.length).toBeGreaterThan(0);
    });
    it('B16 validaciones: fuera de horario, no alineada, pasado', async () => {
        const o = await post_(m.jwt.externo, body(m.fac.public, '22:00', '23:00'));
        expect(o.status).toBe(422); expect(o.body.code).toBe('OUTSIDE_HOURS');
        const n = await post_(m.jwt.externo, body(m.fac.public, '17:10', '18:10'));
        expect(n.status).toBe(422); expect(n.body.code).toBe('SLOT_NOT_ALIGNED');
        const p = await post_(m.jwt.staffA, { facility_id: m.fac.public, starts_at: '2020-01-01T10:00:00-05:00', ends_at: '2020-01-01T11:00:00-05:00', payment_method: 'none' });
        expect(p.status).toBe(422); expect(p.body.code).toBe('IN_THE_PAST');
    });
    it('B17 externo no puede usar campos de staff (booker_profile_id, amount_paid, none)', async () => {
        const a = await post_(m.jwt.externo, body(m.fac.public, '20:00', '21:00', { booker_profile_id: m.u.padre }));
        expect(a.status).toBe(403);
        const b = await post_(m.jwt.externo, body(m.fac.public, '20:00', '21:00', { payment_method: 'none' }));
        expect(b.status).toBe(422); expect(b.body.code).toBe('PAYMENT_METHOD_NOT_ALLOWED');
        const c = await post_(m.jwt.externo, body(m.fac.public, '20:00', '21:00', { amount_paid: 80000 }));
        expect(c.status).toBe(403);
        const e = await post_(m.jwt.externo, body(m.fac.public, '20:00', '21:00', { channel: 'admin' }));
        expect(e.status).toBe(201);
        const row = await q1('select channel from facility_reservations where id=$1', [e.body.reservation.id]);
        expect(row.channel).toBe('app'); // 'admin' degradado a 'app' para no staff
    });
    it('B18 staff de OTRA escuela no puede reservar a nombre de miembro de A', async () => {
        const r = await post_(m.jwt.staffB, body(m.fac.both, '14:00', '15:00', { payment_method: 'cash', booker_profile_id: m.u.padre }));
        expect([403, 404]).toContain(r.status);
    });
});
