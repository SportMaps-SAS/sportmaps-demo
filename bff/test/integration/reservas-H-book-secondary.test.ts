// SEC-BFF · Escenario H: POST /api/v1/session-bookings/athlete/book-secondary (flujo viejo de clase secundaria).
// Inserta directo en facility_reservations con service_role (no pasa por reservar_cancha): se verifica que
//  - una instalacion de OTRA escuela da 404 (sin filtrar que existe),
//  - booking_enabled=false da 422,
//  - la misma Idempotency-Key NO mueve el credito dos veces,
//  - el choque de horario da 409 y NO mueve credito,
//  - la creacion y la cancelacion quedan en security_audit_log.
// Reiniciar el BFF antes:  bash test/integration/helpers/reiniciar-bff.sh enforce
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, post, del, q, q1, fechaDia, idem } from './helpers/gemelo';

let m: Mundo; let enr: string; let plan: string;
const BASE = '/api/v1/session-bookings/athlete';
const used = async () => Number((await q1('select secondary_sessions_used u from enrollments where id=$1', [enr])).u);
const dia = (extra = 0) => fechaDia(3, 20, extra); // miercoles, >= 20 dias adelante
const body = (fac: string, date: string, start: string, end: string, over: any = {}) =>
    ({ enrollment_id: enr, facility_id: fac, reservation_date: date, slots: [{ start_time: start, end_time: end }], ...over });

beforeAll(async () => {
    m = await levantarMundo(); await limpiarReservas(m);
    await q(`delete from enrollments where user_id=$1 and school_id=$2`, [m.u.atleta, m.A]);
    const off = (await q1(`select id from offerings where school_id=$1 and name='t1-H oferta'`, [m.A]))
        ?? (await q1(`insert into offerings (school_id, name, offering_type, is_active, booking_mode) values ($1,'t1-H oferta','subscription',true,'coach') returning id`, [m.A]));
    plan = ((await q1(`select id from offering_plans where offering_id=$1 and name='t1-H plan'`, [off.id]))
        ?? (await q1(`insert into offering_plans (offering_id, school_id, name, price, max_secondary_sessions) values ($1,$2,'t1-H plan',100000,2) returning id`, [off.id, m.A]))).id;
    enr = (await q1(`insert into enrollments (user_id, school_id, offering_plan_id, status, start_date, secondary_sessions_used) values ($1,$2,$3,'active', current_date, 0) returning id`, [m.u.atleta, m.A, plan])).id;
}, 60_000);
afterAll(async () => { await q(`delete from facility_reservations where enrollment_id=$1`, [enr]).catch(() => {}); await closeDb(); });

describe('H. book-secondary', () => {
    it('H1 instalacion de OTRA escuela -> 404 facility_not_found; credito intacto', async () => {
        const r = await post(`${BASE}/book-secondary`, body(m.fac.b, dia(), '10:00', '11:00'), m.jwt.atleta);
        expect(r.status).toBe(404); expect(r.body.reason).toBe('facility_not_found');
        expect(await used()).toBe(0);
        // id inexistente: misma respuesta (no se enumera)
        const nx = await post(`${BASE}/book-secondary`, body('00000000-0000-4000-8000-000000000000', dia(), '10:00', '11:00'), m.jwt.atleta);
        expect(nx.status).toBe(404); expect(nx.body.reason).toBe('facility_not_found');
    });
    it('H2 booking_enabled=false -> 422 facility_not_bookable; credito intacto', async () => {
        const r = await post(`${BASE}/book-secondary`, body(m.fac.training, dia(), '10:00', '11:00'), m.jwt.atleta);
        expect(r.status).toBe(422); expect(r.body.reason).toBe('facility_not_bookable');
        expect(await used()).toBe(0);
    });
    it('H3 enrollment de otro usuario -> 403; sin sesion -> 401; cuerpo con claves de mas no rompe', async () => {
        expect((await post(`${BASE}/book-secondary`, body(m.fac.both, dia(), '10:00', '11:00'), m.jwt.externo)).status).toBe(403);
        expect((await post(`${BASE}/book-secondary`, body(m.fac.both, dia(), '10:00', '11:00'), undefined)).status).toBe(401);
        const odd = await post(`${BASE}/book-secondary`, { enrollment_id: 5 }, m.jwt.atleta);
        expect(odd.status).toBeLessThan(500);
    });
    it('H4 Idempotency-Key repetida: misma reserva, replay 200 y el credito se mueve UNA sola vez', async () => {
        const key = idem('h4'); const d = dia();
        const a = await post(`${BASE}/book-secondary`, body(m.fac.both, d, '10:00', '11:00'), m.jwt.atleta, { 'Idempotency-Key': key });
        expect(a.status, JSON.stringify(a.body)).toBe(201);
        expect(await used()).toBe(1);
        const b = await post(`${BASE}/book-secondary`, body(m.fac.both, d, '10:00', '11:00'), m.jwt.atleta, { 'Idempotency-Key': key });
        expect(b.status).toBe(200); expect(b.body.idempotent_replay).toBe(true);
        expect(b.body.reservation.id).toBe(a.body.reservation.id);
        expect(await used()).toBe(1);
        // misma llave con otra fecha -> 409
        const c = await post(`${BASE}/book-secondary`, body(m.fac.both, dia(1), '10:00', '11:00'), m.jwt.atleta, { 'Idempotency-Key': key });
        expect(c.status).toBe(409); expect(c.body.reason).toBe('idempotency_key_conflict');
        expect(await used()).toBe(1);
        // llave mal formada -> 400
        expect((await post(`${BASE}/book-secondary`, body(m.fac.both, dia(2), '10:00', '11:00'), m.jwt.atleta, { 'Idempotency-Key': 'x' })).status).toBe(400);
    });
    it('H5 choque de horario (otra llave, misma franja) -> 409 facility_slot_conflict y NO mueve credito', async () => {
        const antes = await used();
        const r = await post(`${BASE}/book-secondary`, body(m.fac.both, dia(), '10:00', '11:00'), m.jwt.atleta, { 'Idempotency-Key': idem('h5') });
        expect(r.status, JSON.stringify(r.body)).toBe(409);
        expect(await used()).toBe(antes);
    });
    it('H6 creacion y cancelacion quedan en security_audit_log', async () => {
        const row = await q1(`select id from facility_reservations where enrollment_id=$1 and status<>'cancelled' order by created_at limit 1`, [enr]);
        const created = await q(`select user_id, action, metadata from security_audit_log where action='facility_reservation_book_secondary' and target_id=$1`, [row.id]);
        expect(created.length).toBe(1); expect(created[0].user_id).toBe(m.u.atleta); expect(created[0].metadata.school_id).toBe(m.A);
        const antes = await used();
        const c = await del(`${BASE}/secondary/${row.id}/cancel`, m.jwt.atleta);
        expect(c.status).toBe(200);
        expect(await used()).toBe(antes - 1);
        const cancelled = await q(`select user_id from security_audit_log where action='facility_reservation_cancel_secondary' and target_id=$1`, [row.id]);
        expect(cancelled.length).toBe(1);
        // el ajeno no cancela
        const again = await del(`${BASE}/secondary/${row.id}/cancel`, m.jwt.externo);
        expect([400, 403, 404]).toContain(again.status);
    });
    it('H7 TOPE del plan (max_secondary_sessions=2): HALLAZGO documentado, ver reporte', async () => {
        // El tope vive solo en move_session_credit (capa el CONTADOR), la ruta no lo consulta antes de insertar.
        const plans = await q1('select max_secondary_sessions m from offering_plans where id=$1', [plan]);
        expect(plans.m).toBe(2);
        const res: number[] = [];
        for (let i = 0; i < 4; i++) {
            const r = await post(`${BASE}/book-secondary`, body(m.fac.both, dia(3 + i), '12:00', '13:00'), m.jwt.atleta, { 'Idempotency-Key': idem(`h7${i}`) });
            res.push(r.status);
        }
        const u = await used();
        console.log(`H7: estados=${JSON.stringify(res)} secondary_sessions_used=${u} (tope 2)`);
        expect(u).toBeLessThanOrEqual(2); // el contador nunca pasa del tope
    });
});
