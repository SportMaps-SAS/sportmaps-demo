/**
 * POST /:schoolId/cortesias/sincronizar-franjas — lo dispara «Mi semana» del
 * entrenador: avisa «clase reprogramada» a los agendados de una sesión
 * cancelada y ajusta las franjas del generador. Lo puede pedir el STAFF de esa
 * escuela (el coach), no un padre ni el staff de otra escuela.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const estado = vi.hoisted(() => ({
    usuario: 'coach-1',
    tablas: {} as Record<string, Record<string, any>[]>,
    avisos: [] as any[],
    sincronizadas: [] as any[],
}));

vi.mock('../config/supabase', () => {
    function builder(tabla: string) {
        const filtros: ((f: any) => boolean)[] = [];
        const filas = () => (estado.tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((f) => f[c] === v); return api; },
            not: (c: string, op: string, v: string) => {
                const lista = v.replace(/[()]/g, '').split(',');
                if (op === 'in') filtros.push((f) => !lista.includes(f[c]));
                return api;
            },
            limit: () => api,
            maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
            then: (ok: any, err: any) => Promise.resolve({ data: filas(), error: null }).then(ok, err),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: estado.usuario }; next(); },
}));
vi.mock('../services/cortesia-reservas.service', () => ({ listarCortesias: vi.fn(), marcarAsistencia: vi.fn() }));
vi.mock('../services/clase-prueba-agenda.service', () => ({
    avisarClasesCanceladas: vi.fn(async (p: any) => { estado.avisos.push(p); return { excepciones: 1, porTexto: 1 }; }),
}));
vi.mock('../services/franjas-cortesia.service', () => ({
    sincronizarFranjasDeEscuela: vi.fn(async (schoolId: string, op: any) => {
        estado.sincronizadas.push({ schoolId, op });
        return { creadas: 2, cerradas: 1, conservadasConReserva: [], errores: [] };
    }),
}));

import router from './whatsapp-cortesias.routes';

const ESCUELA = '2d509571-3238-4c04-ac3f-6dfe20539226';
const OTRA = '11111111-1111-4111-8111-111111111111';
const EQUIPO = '33333333-3333-4333-8333-333333333333';
const EQUIPO_OTRA = '44444444-4444-4444-8444-444444444444';

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
    estado.usuario = 'coach-1';
    estado.avisos = [];
    estado.sincronizadas = [];
    estado.tablas = {
        platform_admins: [],
        schools: [{ id: ESCUELA, owner_id: 'duena' }, { id: OTRA, owner_id: 'otro' }],
        school_members: [
            { school_id: ESCUELA, profile_id: 'coach-1', role: 'coach', status: 'active' },
            { school_id: ESCUELA, profile_id: 'papa-1', role: 'parent', status: 'active' },
            { school_id: OTRA, profile_id: 'coach-otra', role: 'coach', status: 'active' },
        ],
        school_staff: [],
        teams: [{ id: EQUIPO, school_id: ESCUELA }, { id: EQUIPO_OTRA, school_id: OTRA }],
        school_settings: [{ school_id: ESCUELA, courtesy_from_training: true }],
    };
});

const post = (escuela: string, body: any = {}) => fetch(`${base}/${escuela}/cortesias/sincronizar-franjas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST sincronizar-franjas', () => {
    it('el coach de la escuela: avisa reprogramadas y sincroniza solo su equipo', async () => {
        const r = await post(ESCUELA, { team_id: EQUIPO });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({
            ok: true, reprogramadas: { excepciones: 1, porTexto: 1 },
            franjas: { creadas: 2, cerradas: 1, conservadasConReserva: 0, errores: 0 },
        });
        expect(estado.avisos).toEqual([{ schoolId: ESCUELA, teamId: EQUIPO }]);
        expect(estado.sincronizadas).toEqual([{ schoolId: ESCUELA, op: { aplicar: true, soloEquipo: EQUIPO } }]);
    });

    it('acepta el body de «Mi semana» ({ teamId })', async () => {
        const r = await post(ESCUELA, { teamId: EQUIPO });
        expect(r.status).toBe(200);
        expect(estado.avisos).toEqual([{ schoolId: ESCUELA, teamId: EQUIPO }]);
        expect(estado.sincronizadas).toEqual([{ schoolId: ESCUELA, op: { aplicar: true, soloEquipo: EQUIPO } }]);
    });

    it('sin franjas desde los entrenamientos: avisa, pero no toca el generador', async () => {
        estado.tablas.school_settings = [{ school_id: ESCUELA, courtesy_from_training: false }];
        const r = await post(ESCUELA);
        expect(await r.json()).toMatchObject({ ok: true, franjas: null, motivo: 'franjas_desde_entrenamientos_apagadas' });
        expect(estado.avisos).toHaveLength(1);
        expect(estado.sincronizadas).toHaveLength(0);
    });

    it('un padre de la escuela: 403', async () => {
        estado.usuario = 'papa-1';
        expect((await post(ESCUELA)).status).toBe(403);
        expect(estado.avisos).toHaveLength(0);
    });

    it('el coach de OTRA escuela: 403', async () => {
        estado.usuario = 'coach-otra';
        expect((await post(ESCUELA)).status).toBe(403);
    });

    it('un equipo de otra escuela: 404; ids inválidos: 400', async () => {
        expect((await post(ESCUELA, { team_id: EQUIPO_OTRA })).status).toBe(404);
        expect((await post(ESCUELA, { team_id: 'abc' })).status).toBe(400);
        expect((await post('no-es-uuid')).status).toBe(400);
        expect(estado.avisos).toHaveLength(0);
    });

    it('la dueña también puede', async () => {
        estado.usuario = 'duena';
        expect((await post(ESCUELA)).status).toBe(200);
    });
});
