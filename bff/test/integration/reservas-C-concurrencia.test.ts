// T1 · Escenario C: concurrencia por HTTP real (varios POST simultaneos contra el BFF + gemelo).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { levantarMundo, limpiarReservas, closeDb, Mundo, post, q, q1, at, fechaDia, idem } from './helpers/gemelo';

let m: Mundo;
beforeAll(async () => { m = await levantarMundo(); await limpiarReservas(m); }, 60_000);
afterAll(closeDb);

const reservar = (tok: string, body: any, key: string) => post('/api/v1/reservations', body, tok, { 'Idempotency-Key': key });

describe('C. Concurrencia', () => {
    it('C1 25 POST simultaneos (staff, llaves distintas) a la MISMA franja -> exactamente 1 creada y 24 con 409', async () => {
        const d = fechaDia(2, 10);
        const body = { facility_id: m.fac.both, starts_at: at(d, '10:00'), ends_at: at(d, '11:00'), payment_method: 'none' };
        const res = await Promise.all(Array.from({ length: 25 }, (_, i) => reservar(m.jwt.staffA, body, idem(`c1-${i}`))));
        const dist = res.reduce((a: any, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
        expect(dist).toEqual({ 201: 1, 409: 24 });
        expect(res.filter((r) => r.status === 409).every((r) => r.body.code === 'SLOT_TAKEN')).toBe(true);
        const n = await q1(`select count(*)::int n from facility_reservations where facility_id=$1 and starts_at=$2 and status not in ('cancelled','expired')`, [m.fac.both, new Date(at(d, '10:00')).toISOString()]);
        expect(n.n).toBe(1);
    });

    it('C2 24 POST simultaneos de 4 usuarios distintos (no staff) a la misma franja -> 1 creada, resto 409', async () => {
        const d = fechaDia(2, 10);
        const body = { facility_id: m.fac.both, starts_at: at(d, '15:00'), ends_at: at(d, '16:00') };
        const users = ['padre', 'atleta', 'externo', 'externo2'];
        const res = await Promise.all(Array.from({ length: 24 }, (_, i) => reservar(m.jwt[users[i % 4]], body, idem(`c2-${i}`))));
        const dist = res.reduce((a: any, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
        expect(dist).toEqual({ 201: 1, 409: 23 });
        const n = await q1(`select count(*)::int n from facility_reservations where facility_id=$1 and starts_at=$2 and status not in ('cancelled','expired')`, [m.fac.both, new Date(at(d, '15:00')).toISOString()]);
        expect(n.n).toBe(1);
        const occ = await q1(`select count(*)::int n from facility_occupancy where facility_id=$1 and lower(slot)=$2 and status in ('active','hold')`, [m.fac.both, new Date(at(d, '15:00')).toISOString()]);
        expect(occ.n).toBe(1);
    });

    it('C3 misma llave x10 en paralelo -> 1 fila; respuestas 201 (1) y 200 replay (9)', async () => {
        const d = fechaDia(2, 11);
        const key = idem('c3');
        const body = { facility_id: m.fac.public, starts_at: at(d, '12:00'), ends_at: at(d, '13:00') };
        const res = await Promise.all(Array.from({ length: 10 }, () => reservar(m.jwt.externo, body, key)));
        const dist = res.reduce((a: any, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
        expect(dist).toEqual({ 201: 1, 200: 9 });
        expect(new Set(res.map((r) => r.body.reservation.id)).size).toBe(1);
        const n = await q1('select count(*)::int n from facility_reservations where school_id=$1 and idempotency_key=$2', [m.A, key]);
        expect(n.n).toBe(1);
    });

    it('C4 el tope de 3 activas aguanta en paralelo: 8 POST (franjas distintas, mismo usuario) -> a lo mas 3 creadas', async () => {
        const d = fechaDia(5, 12);
        const hrs = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00'];
        const res = await Promise.all(hrs.map((h, i) => reservar(m.jwt.externo2, { facility_id: m.fac.public, starts_at: at(d, h), ends_at: at(d, `${String(6 + i + 1).padStart(2, '0')}:00`) }, idem(`c4-${i}`))));
        const created = res.filter((r) => r.status === 201).length;
        const n = await q1(`select count(*)::int n from facility_reservations where user_id=$1 and status in ('hold','pending','pending_payment','confirmed') and starts_at > now()`, [m.u.externo2]);
        // externo2 puede traer reservas de otras corridas: lo que importa es que el total no pase de 3
        expect(n.n).toBeLessThanOrEqual(3);
        expect(created).toBeLessThanOrEqual(3);
    });
});
