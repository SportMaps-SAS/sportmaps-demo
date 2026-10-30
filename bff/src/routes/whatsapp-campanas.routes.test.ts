/**
 * whatsapp-campanas.routes — solo la administración de ESA escuela ve, crea,
 * aprueba y pausa campañas; con las campañas apagadas el GET no lee nada más.
 * Router real; el servicio va moqueado (lo cubre su propio test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const est = vi.hoisted(() => ({
    usuario: 'milena',
    admins: new Set(['milena']),
    ajustes: { disponible: true, ajustes: null as any },
    llamadas: [] as { fn: string; args: any[] }[],
}));

vi.mock('../config/supabase', () => {
    const api: any = { select: () => api, eq: () => api, then: (ok: any) => Promise.resolve({ data: [{ id: 'S1', name: 'Suba' }], error: null }).then(ok) };
    return { supabase: { from: () => api } };
});
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string) => est.admins.has(uid)),
}));
vi.mock('../services/plataforma-wa.service', () => ({ nombreDeEscuela: vi.fn(async () => 'Monster´s Volley Club') }));
vi.mock('../services/whatsapp-campanas.service', () => {
    const anotar = (fn: string, r: any) => vi.fn(async (...args: any[]) => { est.llamadas.push({ fn, args }); return r; });
    return {
        DECLARACION: { version: 'contacto_previo_v1', texto: (e: string, d: number) => `Declaro que ${e} (${d} días)` },
        leerAjustesCampanas: vi.fn(async () => est.ajustes),
        integracionActivaDeEscuela: anotar('integracion', { id: 'integ-1', waba_id: 'w' }),
        audienciaVigente: anotar('audiencia', [
            { contact_wa_id: 'a', intereses: ['clinica'], branch_id: 'S1' },
            { contact_wa_id: 'b', intereses: ['clase_prueba'], branch_id: null },
        ]),
        campanasDeEscuela: anotar('campanas', [
            { id: 'c-borrador', nombre: 'Cierre', plantilla: 'monster_cierre_2026', estado: 'borrador', filtro: { intereses: ['clinica'] } },
            { id: 'c-curso', nombre: 'Vacacional', plantilla: 'monster_vacacional_2026', estado: 'enviando', filtro: {} },
        ]),
        plantillasDeMarketing: anotar('plantillas', [{ nombre: 'monster_cierre_2026', lista: true }]),
        avanceDeCampanas: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { total: 10, enviado: 4 }]))),
        contarFilas: (filas: any[], filtro?: any) => ({
            total: filas.filter((f) => !filtro?.intereses?.length || f.intereses.some((i: string) => filtro.intereses.includes(i))).length,
            porInteres: {}, porSede: {},
        }),
        crearCampana: anotar('crear', { ok: true, campana: { id: 'nueva' } }),
        simularCampana: anotar('simular', { ok: true, conteo: { total: 2 } }),
        aprobarCampana: anotar('aprobar', { ok: true, destinatarios: 2 }),
        pausarCampana: anotar('pausar', { ok: false, status: 409, error: 'no_esta_en_curso' }),
        reanudarCampana: anotar('reanudar', { ok: true }),
    };
});

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
    est.llamadas = [];
    est.ajustes = {
        disponible: true,
        ajustes: { habilitadas: true, baseConsentimiento: 'contacto_previo_declarado', topeDiarioMax: 200, lotePiloto: 50, antiguedadMaxDias: 180, pausadaAt: null, pausaMotivo: null },
    };
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: unknown = {}) => fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('autorización', () => {
    it('un coach o alguien de otra escuela: 403, sin tocar el servicio', async () => {
        est.usuario = 'coach-1';
        expect((await get(`/${ESCUELA}/campanas`)).status).toBe(403);
        expect((await post(`/${ESCUELA}/campanas/${CAMP}/aprobar`, { declaracion_aceptada: true })).status).toBe(403);
        expect(est.llamadas).toHaveLength(0);
    });

    it('ids inválidos: 400', async () => {
        expect((await get('/no-es-uuid/campanas')).status).toBe(400);
        expect((await post(`/${ESCUELA}/campanas/xx/pausar`)).status).toBe(400);
    });
});

describe('GET /:schoolId/campanas', () => {
    it('sin la migración: disponible=false; apagadas: habilitadas=false, sin leer audiencia ni campañas', async () => {
        est.ajustes = { disponible: false, ajustes: null };
        expect(await (await get(`/${ESCUELA}/campanas`)).json()).toEqual({ disponible: false });
        est.ajustes = { disponible: true, ajustes: null };
        expect(await (await get(`/${ESCUELA}/campanas`)).json()).toEqual({ disponible: true, habilitadas: false });
        expect(est.llamadas).toHaveLength(0);
    });

    it('encendidas: audiencia, declaración, conteo previsto del borrador y avance de la que va en curso', async () => {
        const j = await (await get(`/${ESCUELA}/campanas`)).json();
        expect(j).toMatchObject({
            disponible: true, habilitadas: true, integracion: 'ok',
            ajustes: { base_consentimiento: 'contacto_previo_declarado', lote_piloto: 50, pausada: false },
            audiencia: { total: 2 },
            sedes: [{ id: 'S1', nombre: 'Suba' }],
            declaracion: { version: 'contacto_previo_v1', texto: 'Declaro que Monster´s Volley Club (180 días)' },
        });
        expect(j.campanas[0]).toMatchObject({ id: 'c-borrador', conteo_previsto: 1, avance: null });
        expect(j.campanas[1]).toMatchObject({ id: 'c-curso', conteo_previsto: null, avance: { total: 10, enviado: 4 } });
    });
});

describe('acciones', () => {
    it('aprobar pasa quién aprueba (la sesión) y la declaración tal cual', async () => {
        const r = await post(`/${ESCUELA}/campanas/${CAMP}/aprobar`, { declaracion_aceptada: true });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ destinatarios: 2 });
        expect(est.llamadas.at(-1)).toEqual({ fn: 'aprobar', args: [{ schoolId: ESCUELA, campanaId: CAMP, por: 'milena', declaracionAceptada: true }] });

        await post(`/${ESCUELA}/campanas/${CAMP}/aprobar`, { declaracion_aceptada: 'si' });
        expect(est.llamadas.at(-1)!.args[0].declaracionAceptada).toBe(false);
    });

    it('crear: 201 con el filtro saneado y la sesión como autora', async () => {
        const r = await post(`/${ESCUELA}/campanas`, {
            nombre: 'Cierre 2026', plantilla: 'monster_cierre_2026', filtro: { intereses: ['clinica'] }, respuesta_si: 'Te cuento…',
        });
        expect(r.status).toBe(201);
        expect(est.llamadas.at(-1)).toMatchObject({
            fn: 'crear',
            args: [ESCUELA, 'milena', { nombre: 'Cierre 2026', plantilla: 'monster_cierre_2026', filtro: { intereses: ['clinica'], branch_ids: [] }, respuestaSi: 'Te cuento…', venceAt: null }],
        });
    });

    it('los errores del servicio salen con su código', async () => {
        const r = await post(`/${ESCUELA}/campanas/${CAMP}/pausar`);
        expect(r.status).toBe(409);
        expect(await r.json()).toEqual({ error: 'no_esta_en_curso' });
        expect((await get(`/${ESCUELA}/campanas/${CAMP}/simulacion`)).status).toBe(200);
    });
});
