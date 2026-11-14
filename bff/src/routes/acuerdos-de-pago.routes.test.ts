/**
 * Rutas de acuerdos de pago: validación Zod y permisos (staff/admin/ajeno). El servicio se simula;
 * las RPC y la RLS reales se prueban en _smoke/acuerdos_smoke.sql.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const S = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333';

const { alcance, svc } = vi.hoisted(() => ({
    alcance: { admin: false, staff: false },
    svc: {
        solicitar: vi.fn(), resolver: vi.fn(), cancelar: vi.fn(), previsualizar: vi.fn(),
        misAcuerdos: vi.fn(), acuerdosDeEscuela: vi.fn(), guardarTopes: vi.fn(),
    },
}));

vi.mock('../config/supabase', () => ({ supabase: {}, SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' }));
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'U1' }; next(); },
}));
vi.mock('../services/acuerdos-de-pago.service', async (orig) => {
    const real = await orig<typeof import('../services/acuerdos-de-pago.service')>();
    return {
        ...real,
        clienteDeUsuario: () => ({}),
        alcanceEnEscuela: async () => alcance,
        topesDeEscuela: async () => ({ habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: true }),
        ...svc,
    };
});

import router from './acuerdos-de-pago.routes';

let server: Server; let base: string;
beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use('/api/v1/payment-agreements', router);
    server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/payment-agreements`;
});
afterAll(() => { server.close(); });
beforeEach(() => { Object.values(svc).forEach((f) => f.mockReset()); alcance.admin = false; alcance.staff = false; });

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /', () => {
    it('valida el cuerpo (400) y no llama al servicio', async () => {
        const r = await post('/', { school_id: 'no-uuid', payment_ids: [], items: [] });
        expect(r.status).toBe(400);
        expect(svc.solicitar).not.toHaveBeenCalled();
    });
    it('rechaza montos no enteros y fechas mal formadas', async () => {
        expect((await post('/', { school_id: S, payment_ids: [P], items: [{ due_date: '2026-11-20', amount: 10.5 }] })).status).toBe(400);
        expect((await post('/', { school_id: S, payment_ids: [P], items: [{ due_date: '20/11/2026', amount: 1000 }] })).status).toBe(400);
    });
    it('201 con el contrato', async () => {
        svc.solicitar.mockResolvedValue({ ok: true, acuerdo: { agreement_id: A, status: 'activo', auto_approved: true, total_amount: 100000, installments: 2 } });
        const r = await post('/', { school_id: S, payment_ids: [P], items: [{ due_date: '2026-11-20', amount: 50000 }, { due_date: '2026-12-20', amount: 50000 }] });
        expect(r.status).toBe(201);
        expect(await r.json()).toEqual({ agreement_id: A, status: 'activo', auto_aprobado: true, total: 100000, cuotas: 2 });
    });
    it('propaga el error de la base con su status (403 ajeno)', async () => {
        svc.solicitar.mockResolvedValue({ ok: false, status: 403, error: 'forbidden' });
        const r = await post('/', { school_id: S, payment_ids: [P], items: [{ due_date: '2026-11-20', amount: 1000 }] });
        expect(r.status).toBe(403);
    });
});

describe('POST /preview', () => {
    it('exige cuotas, fechas o montos', async () => {
        expect((await post('/preview', { school_id: S, payment_ids: [P] })).status).toBe(400);
    });
    it('devuelve el calendario en el contrato', async () => {
        svc.previsualizar.mockResolvedValue({
            ok: true, cobros: [], topes: { habilitado: true, maxCuotas: 3, maxDias: 60, autoAprobar: true },
            calendario: { cuotas: [{ seq: 1, fecha: '2026-11-26', monto: 100000 }], saldoTotal: 100000, primeraFecha: '2026-11-26', ultimaFecha: '2026-11-26', dias: 20, requiereAprobacion: false, motivos: [] },
        });
        const r = await post('/preview', { school_id: S, payment_ids: [P], cuotas: 1 });
        expect(r.status).toBe(200);
        expect(await r.json()).toMatchObject({ saldo_total: 100000, requiere_aprobacion: false, cuotas: [{ seq: 1, fecha: '2026-11-26', monto: 100000 }] });
    });
});

describe('GET /school/:schoolId', () => {
    it('un ajeno recibe 403 sin consultar', async () => {
        const r = await fetch(`${base}/school/${S}`);
        expect(r.status).toBe(403);
        expect(svc.acuerdosDeEscuela).not.toHaveBeenCalled();
    });
    it('el staff ve la lista pero no puede resolver; el admin sí', async () => {
        svc.acuerdosDeEscuela.mockResolvedValue({ ok: true, acuerdos: [] });
        alcance.staff = true;
        expect(await (await fetch(`${base}/school/${S}`)).json()).toEqual({ acuerdos: [], puede_resolver: false });
        alcance.admin = true;
        expect(await (await fetch(`${base}/school/${S}`)).json()).toEqual({ acuerdos: [], puede_resolver: true });
    });
});

describe('POST /:id/resolve y /cancel', () => {
    it('valida la decisión', async () => {
        expect((await post(`/${A}/resolve`, { decision: 'tal_vez' })).status).toBe(400);
        expect(svc.resolver).not.toHaveBeenCalled();
    });
    it('un no-administrador recibe el 403 de la RPC', async () => {
        svc.resolver.mockResolvedValue({ ok: false, status: 403, error: 'forbidden' });
        expect((await post(`/${A}/resolve`, { decision: 'aprobar' })).status).toBe(403);
    });
    it('aprobar y cancelar devuelven el estado', async () => {
        svc.resolver.mockResolvedValue({ ok: true, agreement_id: A, status: 'activo' });
        expect(await (await post(`/${A}/resolve`, { decision: 'aprobar', nota: 'ok' })).json()).toEqual({ agreement_id: A, status: 'activo' });
        expect(svc.resolver.mock.calls[0].slice(1)).toEqual([A, 'aprobar', 'ok']);
        svc.cancelar.mockResolvedValue({ ok: true, agreement_id: A, status: 'cancelado' });
        expect((await post(`/${A}/cancel`, {})).status).toBe(200);
    });
    it('id inválido → 400', async () => {
        expect((await post('/xyz/resolve', { decision: 'aprobar' })).status).toBe(400);
    });
});

describe('PUT /settings/:schoolId', () => {
    const put = (body: unknown) => fetch(`${base}/settings/${S}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const OK = { habilitado: true, max_cuotas: 3, max_dias: 60, auto_aprobar: true };

    it('solo la administración: staff y ajenos reciben 403 sin escribir', async () => {
        expect((await put(OK)).status).toBe(403);
        alcance.staff = true;
        expect((await put(OK)).status).toBe(403);
        expect(svc.guardarTopes).not.toHaveBeenCalled();
    });
    it('valida rangos (400): cuotas 1–12 y días 1–365, tipos booleanos', async () => {
        alcance.admin = true;
        expect((await put({ ...OK, max_cuotas: 0 })).status).toBe(400);
        expect((await put({ ...OK, max_cuotas: 13 })).status).toBe(400);
        expect((await put({ ...OK, max_dias: 366 })).status).toBe(400);
        expect((await put({ ...OK, habilitado: 'si' })).status).toBe(400);
        expect(svc.guardarTopes).not.toHaveBeenCalled();
    });
    it('guarda y devuelve el contrato de GET /settings', async () => {
        alcance.admin = true;
        svc.guardarTopes.mockResolvedValue({ ok: true, topes: { habilitado: true, maxCuotas: 4, maxDias: 90, autoAprobar: false } });
        const r = await put({ habilitado: true, max_cuotas: 4, max_dias: 90, auto_aprobar: false });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ habilitado: true, max_cuotas: 4, max_dias: 90, auto_aprobar: false });
        expect(svc.guardarTopes).toHaveBeenCalledWith(S, { habilitado: true, maxCuotas: 4, maxDias: 90, autoAprobar: false });
    });
    it('propaga 503 si la migración falta', async () => {
        alcance.admin = true;
        svc.guardarTopes.mockResolvedValue({ ok: false, status: 503, error: 'migracion_pendiente' });
        expect((await put(OK)).status).toBe(503);
    });
});
describe('GET /mine', () => {
    it('pide los del propio usuario autenticado', async () => {
        svc.misAcuerdos.mockResolvedValue({ ok: true, acuerdos: [{ id: A }] });
        const r = await fetch(`${base}/mine?estado=activo,solicitado,basura`);
        expect(await r.json()).toEqual({ acuerdos: [{ id: A }] });
        expect(svc.misAcuerdos.mock.calls[0][1]).toBe('U1');
        expect(svc.misAcuerdos.mock.calls[0][2]).toEqual(['activo', 'solicitado']);
    });
});
