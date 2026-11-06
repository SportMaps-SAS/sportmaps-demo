// T1 · Escenario D: cancelar / reprogramar por la API nueva + rutas reservations-admin (flujo viejo 'pending').
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, post, patch, del, rest, q, q1, at, fechaDia, idem } from './helpers/gemelo';

let m: Mundo;
beforeAll(async () => { m = await levantarMundo(); await limpiarReservas(m); }, 60_000);
afterAll(closeDb);

/** Inicio alineado a 30 min a `hours` horas desde ahora (ISO UTC). */
function enHoras(hours: number, durMin = 60) {
    let s = new Date(Math.ceil((Date.now() + hours * 3600_000) / 1800_000) * 1800_000);
    const dayBogota = (t: Date) => new Date(t.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
    // las reservas no cruzan la medianoche de Bogota: si cae ahi, se corre hasta que quepa
    while (dayBogota(s) !== dayBogota(new Date(s.getTime() + durMin * 60_000))) s = new Date(s.getTime() + 1800_000 * Math.sign(hours || 1));
    return { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + durMin * 60_000).toISOString() };
}
const staffBook = async (fac: string, slot: any, booker: string, paid: number) => {
    const r = await staffBook0(fac, slot, booker, 0);
    if (r.status !== 201) throw new Error('staffBook ' + r.status + ' ' + JSON.stringify(r.body) + ' ' + JSON.stringify(slot));
    // fixture: reserva de 100.000 con `paid` ya cobrado en efectivo (los precios de la grilla no importan para la politica)
    await q(`update facility_reservations set price=100000, amount_paid=$2, payment_status=$3 where id=$1`, [r.body.reservation.id, paid, paid >= 100000 ? 'paid' : paid > 0 ? 'partial' : 'unpaid']);
    return r;
};
const staffBook0 = (fac: string, slot: any, booker: string, paid: number) =>
    post('/api/v1/reservations', { facility_id: fac, ...slot, payment_method: 'cash', booker_profile_id: booker, amount_paid: paid, channel: 'admin' }, m.jwt.staffA, { 'Idempotency-Key': idem('d') });
const cancel = (tok: string, id: string, reason?: string) => post(`/api/v1/reservations/${id}/cancel`, reason ? { reason } : {}, tok);
const resched = (tok: string, id: string, slot: any, facility_id?: string) => post(`/api/v1/reservations/${id}/reschedule`, { ...slot, ...(facility_id ? { facility_id } : {}) }, tok);

describe('D1. Cancelar con politica de reembolso (24h / 6h / 50 %)', () => {
    it('>=24 h -> 100 % reembolso (refund_status manual) y libera la franja', async () => {
        const slot = enHoras(50);
        const r = await staffBook(m.fac.both, slot, m.u.atleta, 100000);
        expect(r.status).toBe(201);
        const c = await cancel(m.jwt.atleta, r.body.reservation.id, 'cambio de planes');
        expect(c.status).toBe(200);
        expect(c.body.refund).toMatchObject({ pct: 100, amount: 100000, status: 'manual' });
        const row = await q1('select * from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.status).toBe('cancelled'); expect(row.cancelled_by).toBe(m.u.atleta); expect(row.cancellation_reason).toBe('cambio de planes'); expect(row.refund_status).toBe('manual');
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [r.body.reservation.id]);
        expect(occ.status).toBe('released');
        // idempotente
        const c2 = await cancel(m.jwt.atleta, r.body.reservation.id);
        expect(c2.status).toBe(200); expect(c2.body.already_cancelled).toBe(true);
    });
    it('entre 6 y 24 h -> 50 %', async () => {
        const r = await staffBook(m.fac.both, enHoras(10), m.u.atleta, 100000);
        const c = await cancel(m.jwt.atleta, r.body.reservation.id);
        expect(c.status).toBe(200);
        expect(c.body.refund).toMatchObject({ pct: 50, amount: 50000, status: 'manual' });
    });
    it('< 6 h -> 0 % (refund none)', async () => {
        const r = await staffBook(m.fac.both, enHoras(3), m.u.padre, 100000);
        const c = await cancel(m.jwt.padre, r.body.reservation.id);
        expect(c.status).toBe(200);
        expect(c.body.refund).toMatchObject({ pct: 0, amount: 0, status: 'none' });
    });
    it('el STAFF siempre 100 %, incluso a 2 h', async () => {
        const r = await staffBook(m.fac.both, enHoras(2), m.u.padre, 100000);
        const c = await cancel(m.jwt.staffA, r.body.reservation.id, 'cancha en mantenimiento');
        expect(c.status).toBe(200);
        expect(c.body.refund).toMatchObject({ pct: 100, amount: 100000, status: 'manual' });
        const row = await q1('select cancelled_by from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.cancelled_by).toBe(m.u.staffA);
    });
    it('politica propia de la cancha (cancellation_policies) manda sobre el default', async () => {
        await q(`delete from cancellation_policies where school_id=$1`, [m.A]);
        await q(`insert into cancellation_policies (school_id, facility_id, hours_full_refund, hours_partial_refund, partial_pct, no_show_penalty_pct, is_active) values ($1,$2,72,12,25,0,true)`, [m.A, m.fac.both]);
        try {
            const r = await staffBook(m.fac.both, enHoras(50), m.u.atleta, 100000);
            const c = await cancel(m.jwt.atleta, r.body.reservation.id);
            expect(c.body.refund).toMatchObject({ pct: 25, amount: 25000 });
            expect(c.body.refund.policy.source).toBe('facility');
        } finally { await q(`delete from cancellation_policies where school_id=$1`, [m.A]); }
    });
    it('ventana cerrada (min_cancellation_hours) -> 409 CANCELLATION_WINDOW_CLOSED; staff si puede', async () => {
        await q(`update facilities set min_cancellation_hours=12 where id=$1`, [m.fac.both]);
        try {
            const r = await staffBook(m.fac.both, enHoras(8), m.u.atleta, 0);
            const c = await cancel(m.jwt.atleta, r.body.reservation.id);
            expect(c.status).toBe(409); expect(c.body.code).toBe('CANCELLATION_WINDOW_CLOSED');
            const s = await cancel(m.jwt.staffA, r.body.reservation.id);
            expect(s.status).toBe(200);
        } finally { await q(`update facilities set min_cancellation_hours=0 where id=$1`, [m.fac.both]); }
    });
    it('ya empezada -> 409 ALREADY_STARTED (cancelar y reprogramar); estados finales -> 409 INVALID_STATE', async () => {
        const past = enHoras(-1);
        const row = await q1(`insert into facility_reservations (facility_id, school_id, user_id, reservation_date, start_time, end_time, status, price, starts_at, ends_at, booker_type, resv_type, channel)
            values ($1,$2,$3,(($4::timestamptz at time zone 'America/Bogota')::date),(($4::timestamptz at time zone 'America/Bogota')::time),(($5::timestamptz at time zone 'America/Bogota')::time),'confirmed',60000,$4,$5,'athlete','internal','app') returning id`,
            [m.fac.both, m.A, m.u.atleta, past.starts_at, past.ends_at]);
        const c = await cancel(m.jwt.atleta, row.id);
        expect(c.status).toBe(409); expect(c.body.code).toBe('ALREADY_STARTED');
        const r = await resched(m.jwt.atleta, row.id, enHoras(60));
        expect(r.status).toBe(409); expect(r.body.code).toBe('ALREADY_STARTED');
        await q(`update facility_reservations set status='completed' where id=$1`, [row.id]);
        const c2 = await cancel(m.jwt.staffA, row.id);
        expect(c2.status).toBe(409); expect(c2.body.code).toBe('INVALID_STATE');
    });
    it('ajeno (otro usuario sin relacion) no puede cancelar -> 403/404 sin filtrar', async () => {
        const r = await staffBook(m.fac.both, enHoras(70), m.u.atleta, 0);
        const c = await cancel(m.jwt.externo, r.body.reservation.id);
        expect([403, 404]).toContain(c.status);
        expect(JSON.stringify(c.body)).not.toMatch(/price|user_id|payment_reference/);
        const bad = await cancel(m.jwt.externo, 'no-es-uuid');
        expect(bad.status).toBe(404);
    });
});

describe('D2. Reprogramar', () => {
    const d = () => fechaDia(3, 20);
    it('no staff: mas caro -> 422 RESCHEDULE_PRICE_DIFFERS; igual/menor OK y conserva precio; otra duracion -> DURATION_MISMATCH', async () => {
        const r = await post('/api/v1/reservations', { facility_id: m.fac.public, starts_at: at(d(), '10:00'), ends_at: at(d(), '11:00') }, m.jwt.externo, { 'Idempotency-Key': idem('d2') });
        expect(r.status).toBe(201); const id = r.body.reservation.id;
        const caro = await resched(m.jwt.externo, id, { starts_at: at(d(), '18:00'), ends_at: at(d(), '19:00') });
        expect(caro.status).toBe(422); expect(caro.body.code).toBe('RESCHEDULE_PRICE_DIFFERS');
        const dur = await resched(m.jwt.externo, id, { starts_at: at(d(), '10:00'), ends_at: at(d(), '12:00') });
        expect(dur.status).toBe(422); expect(dur.body.code).toBe('DURATION_MISMATCH');
        const ok = await resched(m.jwt.externo, id, { starts_at: at(d(), '14:00'), ends_at: at(d(), '15:00') });
        expect(ok.status).toBe(200); expect(ok.body.unchanged).toBe(false);
        const row = await q1('select starts_at, price, price_snapshot from facility_reservations where id=$1', [id]);
        expect(new Date(row.starts_at).toISOString()).toBe(new Date(at(d(), '14:00')).toISOString()); expect(Number(row.price)).toBe(80000);
        // la ocupacion se movio (1 sola fila activa para la reserva)
        const occ = await q(`select lower(slot) l, status from facility_occupancy where source_id=$1`, [id]);
        expect(occ.length).toBe(1); expect(new Date(occ[0].l).toISOString()).toBe(new Date(at(d(), '14:00')).toISOString());
        // mismo rango -> unchanged
        const same = await resched(m.jwt.externo, id, { starts_at: at(d(), '14:00'), ends_at: at(d(), '15:00') });
        expect(same.status).toBe(200); expect(same.body.unchanged).toBe(true);
        // cambiar de cancha no staff
        const fac = await resched(m.jwt.externo, id, { starts_at: at(d(), '14:00'), ends_at: at(d(), '15:00') }, m.fac.both);
        expect([403, 409]).toContain(fac.status);
    });
    it('no staff dentro de las 24 h previas -> 409 RESCHEDULE_WINDOW_CLOSED', async () => {
        const slot = enHoras(10);
        const r = await staffBook(m.fac.both, slot, m.u.padre, 0);
        expect(r.status).toBe(201);
        const x = await resched(m.jwt.padre, r.body.reservation.id, enHoras(12));
        expect(x.status).toBe(409); expect(x.body.code).toBe('RESCHEDULE_WINDOW_CLOSED');
        // staff si puede, y cambia duracion y cancha
        const s = await resched(m.jwt.staffA, r.body.reservation.id, enHoras(30, 90), m.fac.public);
        expect(s.status).toBe(200);
        const row = await q1('select facility_id, price_snapshot from facility_reservations where id=$1', [r.body.reservation.id]);
        expect(row.facility_id).toBe(m.fac.public); expect(row.price_snapshot.rescheduled_from?.length).toBe(1);
    });
    it('reprogramar sobre franja ocupada -> 409 SLOT_TAKEN con alternatives (la original NO se pierde)', async () => {
        const a = await post('/api/v1/reservations', { facility_id: m.fac.public, starts_at: at(d(), '08:00'), ends_at: at(d(), '09:00') }, m.jwt.externo, { 'Idempotency-Key': idem('d2a') });
        const b = await post('/api/v1/reservations', { facility_id: m.fac.public, starts_at: at(d(), '09:00'), ends_at: at(d(), '10:00') }, m.jwt.externo2, { 'Idempotency-Key': idem('d2b') });
        expect([a.status, b.status]).toEqual([201, 201]);
        const x = await resched(m.jwt.externo, a.body.reservation.id, { starts_at: at(d(), '09:00'), ends_at: at(d(), '10:00') });
        expect(x.status).toBe(409); expect(x.body.code).toBe('SLOT_TAKEN'); expect(x.body.alternatives?.length).toBeGreaterThan(0);
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [a.body.reservation.id]);
        expect(['active', 'hold']).toContain(occ.status);
    });
});

describe('D3. reservations-admin sobre una reserva pending del flujo viejo (insert directo del padre)', () => {
    let rid: string;
    const dd = () => fechaDia(1, 25);
    const H = (tok: string) => ({ 'x-school-id': m.A });
    it('el padre inserta la solicitud pending directo (PostgREST con su JWT)', async () => {
        const r = await rest(m.jwt.padre, 'POST', '/facility_reservations', {
            facility_id: m.fac.both, user_id: m.u.padre, school_id: m.A, reservation_date: dd(), start_time: '16:00', end_time: '17:00', status: 'pending', booker_type: 'parent', participants: 5,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        rid = r.body[0].id;
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [rid]);
        expect(occ.status).toBe('active');
    });
    it('approve -> confirmed con approved_by y rastro en security_audit_log', async () => {
        const a = await patch(`/api/v1/reservations-admin/facility/${rid}/approve`, {}, m.jwt.staffA, H(''));
        expect(a.status, JSON.stringify(a.body)).toBe(200);
        const row = await q1('select status, approved_by from facility_reservations where id=$1', [rid]);
        expect(row.status).toBe('confirmed'); expect(row.approved_by).toBe(m.u.staffA);
        const log = await q1(`select count(*)::int n from security_audit_log where action='facility_reservation_approve' and target_id=$1`, [rid]);
        expect(log.n).toBe(1);
        const again = await patch(`/api/v1/reservations-admin/facility/${rid}/approve`, {}, m.jwt.staffA, H(''));
        expect(again.status).toBe(409);
    });
    it('reschedule (PATCH) mueve fecha/hora y la ocupacion; conflicto -> 409', async () => {
        const r = await patch(`/api/v1/reservations-admin/facility/${rid}/reschedule`, { reservation_date: dd(), start_time: '18:00', end_time: '19:00' }, m.jwt.staffA, H(''));
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const row = await q1(`select to_char(start_time,'HH24:MI') s, status from facility_reservations where id=$1`, [rid]);
        expect(row.s).toBe('18:00'); expect(row.status).toBe('confirmed');
        const occ = await q(`select status, to_char(lower(slot) at time zone 'America/Bogota','HH24:MI') s from facility_occupancy where source_id=$1`, [rid]);
        expect(occ).toEqual([{ status: 'active', s: '18:00' }]);
        // choque con otra
        const o = await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: at(dd(), '20:00'), ends_at: at(dd(), '21:00'), payment_method: 'none' }, m.jwt.staffA, { 'Idempotency-Key': idem('d3') });
        expect(o.status).toBe(201);
        const c = await patch(`/api/v1/reservations-admin/facility/${rid}/reschedule`, { reservation_date: dd(), start_time: '20:00', end_time: '21:00' }, m.jwt.staffA, H(''));
        expect(c.status).toBe(409);
    });
    it('complete (confirmed -> completed)', async () => {
        const c = await patch(`/api/v1/reservations-admin/facility/${rid}/complete`, {}, m.jwt.staffA, H(''));
        expect(c.status).toBe(200);
        const row = await q1('select status from facility_reservations where id=$1', [rid]);
        expect(row.status).toBe('completed');
        const c2 = await patch(`/api/v1/reservations-admin/facility/${rid}/complete`, {}, m.jwt.staffA, H(''));
        expect(c2.status).toBe(409);
    });
    it('cancel con reason guarda motivo/cancelled_by y libera la ocupacion', async () => {
        const ins = await rest(m.jwt.padre, 'POST', '/facility_reservations', { facility_id: m.fac.both, user_id: m.u.padre, school_id: m.A, reservation_date: dd(), start_time: '12:00', end_time: '13:00', status: 'pending', booker_type: 'parent' });
        const id = ins.body[0].id;
        const c = await patch(`/api/v1/reservations-admin/facility/${id}/cancel`, { reason: 'cancha en uso por torneo' }, m.jwt.staffA, H(''));
        expect(c.status, JSON.stringify(c.body)).toBe(200);
        const row = await q1('select status, cancellation_reason, cancelled_by, cancelled_at from facility_reservations where id=$1', [id]);
        expect(row).toMatchObject({ status: 'cancelled', cancellation_reason: 'cancha en uso por torneo', cancelled_by: m.u.staffA });
        expect(row.cancelled_at).toBeTruthy();
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [id]);
        expect(occ.status).toBe('released');
    });
    it('cancelar una reserva YA completada o cancelada por esta ruta debe rechazarse (guard de estado)', async () => {
        // rid esta 'completed'
        const c = await patch(`/api/v1/reservations-admin/facility/${rid}/cancel`, { reason: 'x' }, m.jwt.staffA, H(''));
        expect(c.status, 'cancelar una reserva completed no deberia ser 200').toBe(409);
    });
    it('reprogramar una reserva cancelada/completada por esta ruta debe rechazarse', async () => {
        const c = await patch(`/api/v1/reservations-admin/facility/${rid}/reschedule`, { reservation_date: dd(), start_time: '07:00', end_time: '08:00' }, m.jwt.staffA, H(''));
        expect(c.status, 'reprogramar una reserva completed no deberia ser 200').toBe(409);
    });
    it('delete fisico deja rastro (snapshot en security_audit_log) y libera ocupacion', async () => {
        const ins = await rest(m.jwt.padre, 'POST', '/facility_reservations', { facility_id: m.fac.both, user_id: m.u.padre, school_id: m.A, reservation_date: dd(), start_time: '11:00', end_time: '12:00', status: 'pending', booker_type: 'parent' });
        const id = ins.body[0].id;
        const x = await del(`/api/v1/reservations-admin/facility/${id}`, m.jwt.staffA, H(''));
        expect(x.status).toBe(200);
        expect((await q('select 1 from facility_reservations where id=$1', [id])).length).toBe(0);
        const log = await q1(`select old_value->>'status' st, user_id from security_audit_log where action='facility_reservation_delete' and target_id=$1`, [id]);
        expect(log.st).toBe('pending'); expect(log.user_id).toBe(m.u.staffA);
        expect((await q(`select 1 from facility_occupancy where source_id=$1 and status <> 'released'`, [id])).length).toBe(0);
    });
    it('id invalido en cancel/reschedule/delete no debe dar 500', async () => {
        const a = await patch(`/api/v1/reservations-admin/facility/no-uuid/cancel`, {}, m.jwt.staffA, H(''));
        expect(a.status).toBeLessThan(500);
        const b = await del(`/api/v1/reservations-admin/facility/no-uuid`, m.jwt.staffA, H(''));
        expect(b.status).toBeLessThan(500);
    });
});
