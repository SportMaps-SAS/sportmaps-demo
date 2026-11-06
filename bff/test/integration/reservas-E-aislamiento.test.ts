// T1 · Escenario E: aislamiento entre escuelas y entre usuarios.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, get, post, patch, del, q, q1, at, fechaDia, idem } from './helpers/gemelo';

let m: Mundo;
let padreRes: string;   // reserva pending_payment de padre (escuela A)
let legacy: string;     // reserva 'pending' del flujo viejo (escuela A)
const d = () => fechaDia(2, 15);

beforeAll(async () => {
    m = await levantarMundo(); await limpiarReservas(m);
    const r = await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: at(d(), '10:00'), ends_at: at(d(), '11:00') }, m.jwt.padre, { 'Idempotency-Key': idem('e') });
    padreRes = r.body.reservation.id;
    legacy = (await q1(`insert into facility_reservations (facility_id, school_id, user_id, reservation_date, start_time, end_time, status, booker_type) values ($1,$2,$3,$4,'16:00','17:00','pending','parent') returning id`, [m.fac.both, m.A, m.u.padre, d()])).id;
}, 60_000);
afterAll(closeDb);

const estado = async (id: string) => (await q1('select status, starts_at, price, cancellation_reason from facility_reservations where id=$1', [id]));

describe('E. Aislamiento', () => {
    it('E1 staff de B no ve (GET /:id) la reserva de A -> 404 sin datos', async () => {
        const r = await get(`/api/v1/reservations/${padreRes}`, m.jwt.staffB);
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/price|user_id|payment_reference|facility/);
        const ext = await get(`/api/v1/reservations/${padreRes}`, m.jwt.externo);
        expect(ext.status).toBe(404);
    });
    it('E2 staff de B no cancela / reprograma la reserva de A (API nueva) y la base no cambia', async () => {
        const before = await estado(padreRes);
        const c = await post(`/api/v1/reservations/${padreRes}/cancel`, { reason: 'intruso' }, m.jwt.staffB);
        expect([403, 404]).toContain(c.status);
        expect(JSON.stringify(c.body)).not.toMatch(/payment_reference|user_id|price/);
        const rs = await post(`/api/v1/reservations/${padreRes}/reschedule`, { starts_at: at(d(), '12:00'), ends_at: at(d(), '13:00') }, m.jwt.staffB);
        expect([403, 404]).toContain(rs.status);
        expect(await estado(padreRes)).toEqual(before);
    });
    it('E3 rutas de pago (checkout / transfer-proof / confirm-transfer) con staff de B -> 404', async () => {
        for (const p of ['checkout', 'transfer-proof', 'confirm-transfer']) {
            const r = await post(`/api/v1/reservations/${padreRes}/${p}`, { proof_url: 'http://x', amount: 1 }, m.jwt.staffB);
            expect(r.status, p).toBe(404);
        }
        const ext = await post(`/api/v1/reservations/${padreRes}/confirm-transfer`, { amount: 1000 }, m.jwt.externo);
        expect([403, 404]).toContain(ext.status);
    });
    it('E4 reservations-admin con staff de B sobre reserva de A -> 404 y nada cambia; con x-school-id=A -> 403', async () => {
        const before = await estado(legacy);
        const hs = { 'x-school-id': m.B };
        for (const [method, path, body] of [
            ['PATCH', `/api/v1/reservations-admin/facility/${legacy}/approve`, {}],
            ['PATCH', `/api/v1/reservations-admin/facility/${legacy}/complete`, {}],
            ['PATCH', `/api/v1/reservations-admin/facility/${legacy}/cancel`, { reason: 'intruso' }],
            ['PATCH', `/api/v1/reservations-admin/facility/${legacy}/reschedule`, { reservation_date: d(), start_time: '18:00', end_time: '19:00' }],
            ['DELETE', `/api/v1/reservations-admin/facility/${legacy}`, undefined],
        ] as const) {
            const r = method === 'DELETE' ? await del(path, m.jwt.staffB, hs) : await patch(path, body, m.jwt.staffB, hs);
            expect(r.status, `${method} ${path}`).toBe(404);
            const forged = method === 'DELETE' ? await del(path, m.jwt.staffB, { 'x-school-id': m.A }) : await patch(path, body, m.jwt.staffB, { 'x-school-id': m.A });
            expect(forged.status, `forged ${method} ${path}`).toBe(403);
        }
        expect(await estado(legacy)).toEqual(before);
        expect((await q('select 1 from facility_reservations where id=$1', [legacy])).length).toBe(1);
    });
    it('E5 padre (rol parent) no puede usar reservations-admin sobre su propia reserva (requiere staff)', async () => {
        const r = await patch(`/api/v1/reservations-admin/facility/${legacy}/approve`, {}, m.jwt.padre, { 'x-school-id': m.A });
        expect(r.status).toBe(403);
        expect((await estado(legacy)).status).toBe('pending');
    });
    it('E6 /mine solo trae las propias; sin idempotency_key/guest_booker_id/price_snapshot', async () => {
        const mine = await get('/api/v1/reservations/mine', m.jwt.padre);
        expect(mine.status).toBe(200);
        expect(mine.body.reservations.every((x: any) => x.user_id === m.u.padre)).toBe(true);
        expect(mine.body.reservations.some((x: any) => x.id === padreRes)).toBe(true);
        expect(JSON.stringify(mine.body)).not.toMatch(/idempotency_key|guest_booker_id|price_snapshot/);
        const ext = await get('/api/v1/reservations/mine', m.jwt.externo);
        expect(ext.body.reservations.some((x: any) => x.id === padreRes)).toBe(false);
        const anon = await get('/api/v1/reservations/mine');
        expect(anon.status).toBe(401);
    });
    it('E7 GET /:id: dueño no ve internos; staff de la escuela ve price_snapshot pero no idempotency_key/guest_booker_id', async () => {
        const own = await get(`/api/v1/reservations/${padreRes}`, m.jwt.padre);
        expect(own.status).toBe(200);
        expect(JSON.stringify(own.body)).not.toMatch(/idempotency_key|guest_booker_id|price_snapshot/);
        const st = await get(`/api/v1/reservations/${padreRes}`, m.jwt.staffA);
        expect(st.status).toBe(200);
        expect(st.body.reservation.price_snapshot).toBeTruthy();
        expect(JSON.stringify(st.body)).not.toMatch(/idempotency_key|guest_booker_id/);
        const bad = await get('/api/v1/reservations/no-uuid', m.jwt.padre);
        expect(bad.status).toBe(404);
    });
    it('E8 /public/booking/slots sin token: mismo 404 para escuela inexistente, instalacion ajena, no reservable, mal formado', async () => {
        const base = '/api/v1/public/booking/slots';
        const rand = '11111111-1111-4111-8111-111111111111';
        const cases = [
            `${base}?school_id=${rand}&facility_id=${m.fac.both}`,           // escuela inexistente
            `${base}?school_id=${m.A}&facility_id=${m.fac.b}`,               // instalacion de otra escuela
            `${base}?school_id=${m.A}&facility_id=${m.fac.training}`,        // booking_enabled=false
            `${base}?school_id=${m.A}&facility_id=${rand}`,                  // instalacion inexistente
            `${base}?school_id=zzz&facility_id=${m.fac.both}`,               // mal formado
        ];
        const res = await Promise.all(cases.map((c) => get(c)));
        expect(res.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
        expect(new Set(res.map((r) => JSON.stringify(r.body))).size).toBe(1);
        const ok = await get(`${base}?school_id=${m.A}&facility_id=${m.fac.both}`);
        expect(ok.status).toBe(200);
        expect(Object.keys(ok.body.facility).sort()).toEqual(['id', 'name']);
    });
    it('E9 [observacion] /public/booking/slots expone una cancha SOLO PARA SOCIOS (bookable_by=members) a quien tenga el UUID', async () => {
        const r = await get(`/api/v1/public/booking/slots?school_id=${m.A}&facility_id=${m.fac.members}`);
        // Esta ruta es el flujo viejo de clases de cortesia (/agendar): no mira bookable_by.
        // No es el contrato F1 (disponibilidad_canchas oculta la de socios al externo); se reporta como decision.
        console.log('E9 status members-only via /slots =', r.status);
        expect([200, 404]).toContain(r.status);
    });
    it('E10 pagina publica de escuela: solo campos publicables; sin canchas de socios/entrenamiento', async () => {
        const slug = (await q1('select slug from schools where id=$1', [m.A])).slug;
        const r = await get(`/api/v1/public/reservations/schools/${slug}`);
        expect(r.status).toBe(200);
        expect(r.body.facilities.map((f: any) => f.name).sort()).toEqual(['t1-Cancha Ambas', 't1-Cancha Publica']);
        expect(Object.keys(r.body.school).sort()).toEqual(['id', 'name', 'slug']);
        for (const f of r.body.facilities) expect(Object.keys(f).sort()).toEqual(['capacity', 'id', 'min_duration_min', 'name', 'slot_step_min', 'type']);
        expect(JSON.stringify(r.body)).not.toMatch(/rate|deposit|owner|email|phone|address/i);
        expect((await get('/api/v1/public/reservations/schools/no-existe-t1')).status).toBe(404);
        // slug con caracteres raros no rompe (sin 500)
        expect((await get(`/api/v1/public/reservations/schools/${encodeURIComponent("a'b),c.eq.(")}`)).status).toBeLessThan(500);
    });
    it('E11 staff de A ante la escuela B se comporta como externo (no ve ni opera con privilegios de staff)', async () => {
        const r = await get(`/api/v1/reservations/availability?school_id=${m.B}&from=${d()}&to=${d()}&audience=member`, m.jwt.staffA);
        expect(r.status).toBe(200);
        const f = r.body.facilities[0];
        const s = f.days[0].slots.find((x: any) => x.start_local === '10:00');
        expect(s.price).toBe(90000); // tarifa publica: audience=member ignorado
        const no = await post('/api/v1/reservations', { facility_id: m.fac.b, starts_at: at(d(), '10:00'), ends_at: at(d(), '11:00'), payment_method: 'none' }, m.jwt.staffA, { 'Idempotency-Key': idem('e11') });
        expect(no.status).toBe(422); expect(no.body.code).toBe('PAYMENT_METHOD_NOT_ALLOWED');
    });
});
