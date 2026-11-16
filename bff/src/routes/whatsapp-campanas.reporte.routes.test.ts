/**
 * GET /:schoolId/campanas/:campanaId/reporte — solo la administración de ESA
 * escuela; quien consulta sale de la sesión, nunca de la query ni del cuerpo.
 * Router real; los servicios van moqueados (los cubren sus propios tests).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const est = vi.hoisted(() => ({
    usuario: 'milena',
    admins: new Set(['milena']),
    gate: [] as { uid: string; schoolId: string }[],
    llamadas: [] as any[][],
    respuesta: { ok: true, reporte: { campana: { id: 'c' }, resumen: { enviados: 7 }, lista_de_espera: null } } as any,
    lanza: false,
}));

vi.mock('../config/supabase', () => ({ supabase: { from: () => { throw new Error('la ruta del reporte no lee la base'); } } }));
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string, schoolId: string) => { est.gate.push({ uid, schoolId }); return est.admins.has(uid); }),
}));
vi.mock('../services/plataforma-wa.service', () => ({ nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club') }));
vi.mock('../services/whatsapp-campanas.service', () => ({ RESPONSABILIDAD: {} }));
vi.mock('../services/whatsapp-campanas-cupo', () => ({ cupoDeCampanasHoy: vi.fn() }));
vi.mock('../services/whatsapp-campana-reporte.service', () => ({
    leerReporteDeCampana: vi.fn(async (...args: any[]) => {
        est.llamadas.push(args);
        if (est.lanza) throw new Error('boom');
        return est.respuesta;
    }),
}));

import router from './whatsapp-campanas.routes';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CAMP = '11111111-1111-4111-8111-111111111111';
let server: http.Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/whatsapp', router);
    server = http.createServer(app);
    await new Promise<void>((ok) => server.listen(0, ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/whatsapp`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
    est.usuario = 'milena';
    est.gate = [];
    est.llamadas = [];
    est.lanza = false;
    est.respuesta = { ok: true, reporte: { campana: { id: 'c' }, resumen: { enviados: 7 }, lista_de_espera: null } };
});

describe('GET /:schoolId/campanas/:campanaId/reporte', () => {
    it('la administración de la escuela recibe el reporte tal cual', async () => {
        const res = await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ campana: { id: 'c' }, resumen: { enviados: 7 }, lista_de_espera: null });
        expect(est.llamadas).toEqual([[ESCUELA, CAMP]]);
    });

    it('un coach o alguien de otra escuela: 403, sin tocar el servicio', async () => {
        est.usuario = 'coach-1';
        expect((await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte`)).status).toBe(403);
        expect(est.llamadas).toHaveLength(0);
    });

    it('un `por` o un usuario en la query o en el cuerpo se ignora: manda la sesión', async () => {
        est.usuario = 'coach-1';
        const res = await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte?por=milena&user_id=milena&usuario=milena`, {
            headers: { 'content-type': 'application/json', 'x-user-id': 'milena' },
        });
        expect(res.status).toBe(403);
        expect(est.gate).toEqual([{ uid: 'coach-1', schoolId: ESCUELA }]);
        expect(est.llamadas).toHaveLength(0);

        // Y al revés: la sesión buena con un `por` ajeno sigue siendo la sesión, y al servicio no le llega nada de eso.
        est.usuario = 'milena';
        est.gate = [];
        const ok = await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte?por=coach-1&school_id=otra`);
        expect(ok.status).toBe(200);
        expect(est.gate).toEqual([{ uid: 'milena', schoolId: ESCUELA }]);
        expect(est.llamadas).toEqual([[ESCUELA, CAMP]]);
    });

    it('ids inválidos: 400 sin preguntar permisos', async () => {
        expect((await fetch(`${base}/no-es-uuid/campanas/${CAMP}/reporte`)).status).toBe(400);
        expect((await fetch(`${base}/${ESCUELA}/campanas/xx/reporte`)).status).toBe(400);
        expect(est.gate).toHaveLength(0);
    });

    it('propaga el estado del servicio (404 de otra escuela, 409 de un borrador) y nunca revienta', async () => {
        est.respuesta = { ok: false, status: 404, error: 'campana_no_encontrada' };
        const r404 = await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte`);
        expect(r404.status).toBe(404);
        expect(await r404.json()).toEqual({ error: 'campana_no_encontrada' });

        est.respuesta = { ok: false, status: 409, error: 'sin_aprobar' };
        expect((await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte`)).status).toBe(409);

        est.lanza = true;
        const r500 = await fetch(`${base}/${ESCUELA}/campanas/${CAMP}/reporte`);
        expect(r500.status).toBe(500);
        expect(await r500.json()).toEqual({ error: 'No se pudo armar el reporte' });
    });
});
