// SEC-BFF · Escenario J: expirar_holds con pago parcial, requireEntitlement (enforce), formato de errores y campos internos.
// El gating audit/soft se prueba con un segundo BFF efimero (puerto 3102) si GATING_EXTRA=1 (tarda ~70 s por arranque).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { levantarMundo, limpiarReservas, closeDb, Mundo, get, post, q, q1, at, fechaDia, idem, http } from './helpers/gemelo';

let m: Mundo;
const d = () => fechaDia(4, 12);
const reservar = async (tok: string, fac: string, h: number, extra: any = {}) => {
    const r = await post('/api/v1/reservations', { facility_id: fac, starts_at: at(d(), `${String(h).padStart(2, '0')}:00`), ends_at: at(d(), `${String(h + 1).padStart(2, '0')}:00`), ...extra }, tok, { 'Idempotency-Key': idem('j') });
    if (r.status !== 201) throw new Error(`reservar ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.reservation;
};
beforeAll(async () => { m = await levantarMundo(); await limpiarReservas(m); }, 90_000);
afterAll(async () => { await q(`update school_addons set enabled=true, disabled_at=null where school_id=$1 and addon_key='reservations'`, [m.A]).catch(() => {}); await closeDb(); });

describe('J1. expirar_holds', () => {
    it('hold vencido SIN pago -> expired y libera la franja; CON pago parcial -> pending_reconciliation (no se pierde la plata)', async () => {
        const sin = await reservar(m.jwt.padre, m.fac.both, 8);
        const con = await reservar(m.jwt.padre, m.fac.both, 9);
        await q(`update facility_reservations set amount_paid=30000, payment_status='partial' where id=$1`, [con.id]);
        await q(`update facility_reservations set hold_expires_at = now() - interval '1 minute' where id = any($1::uuid[])`, [[sin.id, con.id]]);
        await q('select expirar_holds()');
        expect((await q1('select status from facility_reservations where id=$1', [sin.id])).status).toBe('expired');
        const c = await q1('select status, amount_paid from facility_reservations where id=$1', [con.id]);
        expect(c.status).toBe('pending_reconciliation'); expect(Number(c.amount_paid)).toBe(30000);
        const occ = await q1(`select status from facility_occupancy where source_id=$1`, [sin.id]);
        expect(occ?.status ?? 'released').toBe('released');
    });
});

describe('J2. requireEntitlement (BFF en enforce)', () => {
    it('escuela sin el addon -> 403 entitlement_required en /availability; con addon -> 200', async () => {
        const url = `/api/v1/reservations/availability?school_id=${m.A}&from=${d()}&to=${d()}`;
        await q(`update school_addons set enabled=false where school_id=$1 and addon_key='reservations'`, [m.A]);
        const off = await get(url, m.jwt.padre, { 'x-school-id': m.A });
        expect(off.status, JSON.stringify(off.body)).toBe(403);
        await q(`update school_addons set enabled=true, disabled_at=null where school_id=$1 and addon_key='reservations'`, [m.A]);
        const on = await get(url, m.jwt.padre, { 'x-school-id': m.A });
        expect(on.status).toBe(200);
    });
    const extra = process.env.GATING_EXTRA === '1';
    it.skipIf(!extra)('audit y soft NO bloquean; soft pone X-Entitlement-Missing', async () => {
        const base = join(process.cwd(), 'test', 'integration', 'helpers', 'levantar-bff-gemelo.mjs');
        const url = `/api/v1/reservations/availability?school_id=${m.A}&from=${d()}&to=${d()}`;
        await q(`update school_addons set enabled=false where school_id=$1 and addon_key='reservations'`, [m.A]);
        for (const mode of ['audit', 'soft']) {
            const p: ChildProcess = spawn(process.execPath, [base, `--gating=${mode}`, '--port=3102'], { stdio: 'ignore' });
            try {
                for (let i = 0; i < 60; i++) { try { if ((await fetch('http://127.0.0.1:3102/health')).ok) break; } catch { /* */ } await new Promise((ok) => setTimeout(ok, 2000)); }
                const r = await http('GET', url, { token: m.jwt.padre, headers: { 'x-school-id': m.A }, base: 'http://127.0.0.1:3102' });
                // La RPC disponibilidad_canchas tambien exige el entitlement: la respuesta puede ser 403 de la RPC, no del middleware.
                expect(r.body?.reason === 'entitlement_required' && r.body?.entitlement === 'reservations').toBe(false);
                if (mode === 'soft') expect(r.headers.get('x-entitlement-missing')).toBe('reservations');
            } finally { p.kill(); }
        }
        await q(`update school_addons set enabled=true, disabled_at=null where school_id=$1 and addon_key='reservations'`, [m.A]);
    }, 300_000);
});

describe('J3. formato de errores y campos internos', () => {
    it('errores de negocio y de validacion son JSON con code; jamas SQLERRM crudo ni stack', async () => {
        const casos = [
            await post('/api/v1/reservations', { facility_id: 'x' }, m.jwt.padre, { 'Idempotency-Key': idem('j3') }),
            await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: at(d(), '10:00'), ends_at: at(d(), '11:00'), extra: 1 }, m.jwt.padre, { 'Idempotency-Key': idem('j3') }),
            await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: '2020-01-01T10:00:00-05:00', ends_at: '2020-01-01T11:00:00-05:00' }, m.jwt.padre, { 'Idempotency-Key': idem('j3') }),
            await post('/api/v1/reservations/00000000-0000-4000-8000-000000000000/cancel', {}, m.jwt.padre),
            await post('/api/v1/reservations/no-es-uuid/cancel', {}, m.jwt.padre),
        ];
        for (const r of casos) {
            expect(r.status).toBeGreaterThanOrEqual(400); expect(r.status).toBeLessThan(500);
            const s = JSON.stringify(r.body);
            expect(s).not.toMatch(/SQLSTATE|violates|syntax error|pg_|at .*\.ts:|stack|relation ".*" does not exist|P000/i);
        }
        // JSON roto y tipo de contenido
        const bad = await fetch(`http://127.0.0.1:3101/api/v1/reservations`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${m.jwt.padre}`, 'Idempotency-Key': idem('j3') }, body: '{"a":' });
        expect(bad.status).toBe(400);
        const big = await fetch(`http://127.0.0.1:3101/api/v1/reservations`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${m.jwt.padre}`, 'Idempotency-Key': idem('j3') }, body: JSON.stringify({ notes: 'x'.repeat(30000) }) });
        expect(big.status).toBe(413);
    });
    it('un no-staff no ve idempotency_key, guest_booker_id ni price_snapshot (POST, GET /:id y /mine)', async () => {
        const r = await reservar(m.jwt.atleta, m.fac.both, 12);
        const g = await get(`/api/v1/reservations/${r.id}`, m.jwt.atleta);
        const mine = await get('/api/v1/reservations/mine', m.jwt.atleta);
        for (const body of [r, g.body?.reservation, ...(mine.body?.reservations ?? [])]) {
            expect(body).toBeTruthy();
            expect(Object.keys(body)).not.toContain('idempotency_key');
            expect(Object.keys(body)).not.toContain('guest_booker_id');
            expect(Object.keys(body)).not.toContain('price_snapshot');
        }
        const staff = await get(`/api/v1/reservations/${r.id}`, m.jwt.staffA);
        expect(staff.status).toBe(200); expect(Object.keys(staff.body.reservation)).toContain('price_snapshot');
        expect(Object.keys(staff.body.reservation)).not.toContain('idempotency_key');
    });
    it('canal ai / import desde el cliente -> 403; staff no puede fijarlos', async () => {
        for (const channel of ['ai', 'import']) {
            const r = await post('/api/v1/reservations', { facility_id: m.fac.both, starts_at: at(d(), '14:00'), ends_at: at(d(), '15:00'), channel }, m.jwt.staffA, { 'Idempotency-Key': idem('j3c') });
            expect(r.status).toBe(403); expect(r.body.code).toBe('CHANNEL_NOT_ALLOWED');
        }
    });
});

describe('J4. bloqueos internos y lote (HTTP real)', () => {
    it('bloqueo: crea 201, choque con reserva vigente 409, borrado 200; coach 403; otra escuela 404; queda auditado', async () => {
        const f = fechaDia(5, 20);
        const hs = { 'x-school-id': m.A };
        const ok = await post('/api/v1/reservations-admin/blackouts', { facility_id: m.fac.public, starts_at: at(f, '10:00'), ends_at: at(f, '12:00'), kind: 'maintenance', reason: '  Pintura <b>cancha</b>  ' }, m.jwt.staffA, hs);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.blackout.reason).toBe('Pintura <b>cancha</b>');
        const clash = await post('/api/v1/reservations-admin/blackouts', { facility_id: m.fac.public, starts_at: at(f, '11:00'), ends_at: at(f, '13:00') }, m.jwt.staffA, hs);
        // dos bloqueos solapados: la ocupacion exclusiva lo rechaza igual que una reserva
        expect([409, 422]).toContain(clash.status);
        expect((await post('/api/v1/reservations-admin/blackouts', { facility_id: m.fac.public, starts_at: at(f, '15:00'), ends_at: at(f, '16:00') }, m.jwt.coachA, hs)).status).toBe(403);
        expect((await post('/api/v1/reservations-admin/blackouts', { facility_id: m.fac.b, starts_at: at(f, '15:00'), ends_at: at(f, '16:00') }, m.jwt.staffA, hs)).status).toBe(404);
        const lst = await get(`/api/v1/reservations-admin/blackouts?facility_id=${m.fac.public}&from=${f}&to=${f}`, m.jwt.staffA, hs);
        expect(lst.status).toBe(200); expect(lst.body.blackouts.some((b: any) => b.id === ok.body.blackout.id)).toBe(true);
        const res = await post('/api/v1/reservations', { facility_id: m.fac.public, starts_at: at(f, '10:00'), ends_at: at(f, '11:00') }, m.jwt.padre, { 'Idempotency-Key': idem('j4') });
        expect(res.status).toBe(409); // la franja bloqueada no se reserva
        const del = await http('DELETE', `/api/v1/reservations-admin/blackouts/${ok.body.blackout.id}`, { token: m.jwt.staffA, headers: hs });
        expect(del.status).toBe(200);
        const aud = await q(`select action from security_audit_log where target_id=$1 order by ts`, [ok.body.blackout.id]);
        expect(aud.map((a: any) => a.action)).toEqual(['facility_blackout_create', 'facility_blackout_delete']);
    });
    it('lote dry-run: admin 200 sin escribir; coach 403; 201 filas 400; la franja ya reservada sale como error', async () => {
        const f = fechaDia(1, 40); const hs = { 'x-school-id': m.A };
        await reservar(m.jwt.padre, m.fac.both, 16).catch(() => null);
        const row = (h: number) => ({ facility_id: m.fac.both, starts_at: at(f, `${h}:00`), ends_at: at(f, `${h + 1}:00`), guest: { phone: '+573001112233', full_name: 'Ana Gomez' } });
        const body = { source_kind: 'import', source_id: `doc-${Date.now()}`, school_id: m.A, rows: [row(10), row(11)] };
        const antes = (await q1('select count(*)::int n from facility_reservations')).n;
        const ok = await post('/api/v1/reservations/batch/dry-run', body, m.jwt.staffA, hs);
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body).toMatchObject({ dry_run: true, writes_performed: false, total: 2 });
        expect((await q1('select count(*)::int n from facility_reservations')).n).toBe(antes);
        expect((await post('/api/v1/reservations/batch/dry-run', body, m.jwt.coachA, hs)).status).toBe(403);
        expect((await post('/api/v1/reservations/batch/dry-run', { ...body, rows: Array.from({ length: 201 }, () => row(10)) }, m.jwt.staffA, hs)).status).toBe(400);
        expect((await post('/api/v1/reservations/batch/dry-run', { ...body, school_id: m.B }, m.jwt.staffA, hs)).status).toBe(403);
        const aud = await q1(`select count(*)::int n from security_audit_log where action='reservation_batch_dry_run'`);
        expect(aud.n).toBeGreaterThan(0);
    });
});
