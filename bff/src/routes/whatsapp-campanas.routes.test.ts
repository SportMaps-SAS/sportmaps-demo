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
    /** ¿La escuela ya aceptó la declaración de activación? */
    activada: true,
    frenoGlobal: { pausada: false, desde: null as string | null, motivo: null as string | null },
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
        RESPONSABILIDAD: {
            versionActivacion: 'activacion_v1', versionCampana: 'campana_v1',
            textoActivacion: (e: string) => `Activo las campañas de ${e}`,
            textoCampana: (e: string, base: string, d: number) => `Declaro por ${e} (${base}, ${d} días)`,
        },
        leerAjustesCampanas: vi.fn(async () => est.ajustes),
        // Lecturas del GET: no se anotan (lo que se cuenta en `llamadas` es audiencia, campañas y acciones).
        activacionAceptada: vi.fn(async () => est.activada),
        declaracionDeActivacion: vi.fn(async () => ({ version: 'activacion_v1', texto: 'Activo las campañas de Monster´s Volley Club' })),
        serviciosParaCampana: vi.fn(async () => []),
        compradoresDeServicio: vi.fn(async () => new Set<string>()),
        leerFrenoGlobal: vi.fn(async () => est.frenoGlobal),
        textoDeAceptacionDePausa: (motivo: string | null) => `Acepto reanudar (${motivo})`,
        activarCampanas: anotar('activar', { ok: true }),
        reanudarEscuela: anotar('reanudar_escuela', { ok: true }),
        pausarEscuela: anotar('pausar_escuela', { ok: true }),
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

vi.mock('../services/whatsapp-campanas-cupo', () => ({
    cupoDeCampanasHoy: vi.fn(async (integ: any, tope: number) => {
        est.llamadas.push({ fn: 'cupo', args: [integ, tope] });
        return {
            limite: 250, tier: 'TIER_250', fuente: 'graph', reserva: 50, usados24h: 50, limiteCampanas: 200,
            disponibleCampanas: 150, topeDiario: tope, enviadosHoy: 30, cupoHoy: 200, disponibleHoy: 150,
        };
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
    est.llamadas = [];
    est.activada = true;
    est.frenoGlobal = { pausada: false, desde: null, motivo: null };
    est.ajustes = {
        disponible: true,
        ajustes: { habilitadas: true, baseConsentimiento: 'contacto_previo_declarado', topeDiarioMax: 200, lotePiloto: 50, antiguedadMaxDias: 180, pausadaAt: null, pausaMotivo: null, pausaOrigen: null },
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
        expect((await post(`/${ESCUELA}/campanas/activar`, { declaracion_aceptada: true })).status).toBe(403);
        expect((await post(`/${ESCUELA}/campanas/reanudar-escuela`, { acepto_motivo: true })).status).toBe(403);
        expect((await post(`/${ESCUELA}/campanas/pausar-escuela`)).status).toBe(403);
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
        // Apagadas: lo único que viaja es la declaración que la escuela acepta para prenderlas sola.
        expect(await (await get(`/${ESCUELA}/campanas`)).json()).toEqual({
            disponible: true, habilitadas: false,
            activacion: { version: 'activacion_v1', texto: 'Activo las campañas de Monster´s Volley Club' },
        });
        expect(est.llamadas).toHaveLength(0);
    });

    it('encendidas: audiencia, declaración, conteo previsto del borrador y avance de la que va en curso', async () => {
        const j = await (await get(`/${ESCUELA}/campanas`)).json();
        expect(j).toMatchObject({
            disponible: true, habilitadas: true, integracion: 'ok',
            // Ya activadas por la escuela, sin freno global y sin pausa.
            falta_activacion: false, activacion: null, pausa_global: false,
            ajustes: {
                base_consentimiento: 'contacto_previo_declarado', lote_piloto: 50, pausada: false,
                pausa_motivo: null, pausa_origen: null, aceptacion: null,
            },
            audiencia: { total: 2 },
            sedes: [{ id: 'S1', nombre: 'Suba' }],
            // La declaración de responsabilidad de CADA aprobación (versión de campaña, no la de contacto previo).
            declaracion: { version: 'campana_v1', texto: 'Declaro por Monster´s Volley Club (contacto_previo_declarado, 180 días)' },
        });
        // «Cupo de hoy: 150 de 200 · reserva 50 para interesados y avisos», con el tope de la escuela.
        expect(j.cupo).toEqual({
            limite_meta: 250, tier: 'TIER_250', fuente: 'graph', reserva: 50, usados_24h: 50,
            tope_diario: 200, enviados_hoy: 30, cupo_hoy: 200, disponible_hoy: 150,
        });
        expect(est.llamadas.find((l) => l.fn === 'cupo')?.args).toEqual([{ id: 'integ-1', waba_id: 'w' }, 200]);
        expect(j.campanas[0]).toMatchObject({ id: 'c-borrador', conteo_previsto: 1, avance: null });
        expect(j.campanas[1]).toMatchObject({ id: 'c-curso', conteo_previsto: null, avance: { total: 10, enviado: 4 } });
    });

    it('la declaración viaja SIEMPRE, también con base opt-in', async () => {
        est.ajustes.ajustes.baseConsentimiento = 'optin';
        const j = await (await get(`/${ESCUELA}/campanas`)).json();
        expect(j.declaracion).toEqual({ version: 'campana_v1', texto: 'Declaro por Monster´s Volley Club (optin, 180 días)' });
    });

    it('prendidas sin que la escuela haya aceptado la activación: falta_activacion con el texto a aceptar; freno global a la vista', async () => {
        est.activada = false;
        est.frenoGlobal = { pausada: true, desde: '2026-11-15T15:00:00Z', motivo: 'incidente' };
        const j = await (await get(`/${ESCUELA}/campanas`)).json();
        expect(j).toMatchObject({
            habilitadas: true, falta_activacion: true, pausa_global: true,
            activacion: { version: 'activacion_v1', texto: 'Activo las campañas de Monster´s Volley Club' },
        });
    });

    it('en pausa: la del freno trae el texto que la escuela acepta para reanudar; la de plataforma y la propia, no', async () => {
        Object.assign(est.ajustes.ajustes, { pausadaAt: '2026-11-15T15:00:00Z', pausaMotivo: 'calidad_del_numero', pausaOrigen: 'freno' });
        expect((await (await get(`/${ESCUELA}/campanas`)).json()).ajustes).toMatchObject({
            pausada: true, pausa_motivo: 'calidad_del_numero', pausa_origen: 'freno', aceptacion: 'Acepto reanudar (calidad_del_numero)',
        });
        est.ajustes.ajustes.pausaOrigen = 'plataforma';
        expect((await (await get(`/${ESCUELA}/campanas`)).json()).ajustes).toMatchObject({ pausada: true, pausa_origen: 'plataforma', aceptacion: null });
        est.ajustes.ajustes.pausaOrigen = 'escuela';
        expect((await (await get(`/${ESCUELA}/campanas`)).json()).ajustes).toMatchObject({ pausada: true, pausa_origen: 'escuela', aceptacion: null });
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

    // Quien actúa queda en la declaración y en la bitácora: sale de la sesión, nunca del cuerpo.
    const SUPLANTACION = { por: 'otra-persona', p_por: 'otra-persona', user_id: 'otra-persona', schoolId: 'otra-escuela' };

    it('activar: `por` es la sesión aunque el cuerpo traiga otro; la declaración solo vale con `true`', async () => {
        const r = await post(`/${ESCUELA}/campanas/activar`, { declaracion_aceptada: true, ...SUPLANTACION });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({});
        expect(est.llamadas).toEqual([{ fn: 'activar', args: [{ schoolId: ESCUELA, por: 'milena', declaracionAceptada: true }] }]);

        await post(`/${ESCUELA}/campanas/activar`, { declaracion_aceptada: 'true', ...SUPLANTACION });
        expect(est.llamadas.at(-1)).toEqual({ fn: 'activar', args: [{ schoolId: ESCUELA, por: 'milena', declaracionAceptada: false }] });
        await post(`/${ESCUELA}/campanas/activar`);
        expect(est.llamadas.at(-1)!.args[0]).toEqual({ schoolId: ESCUELA, por: 'milena', declaracionAceptada: false });
    });

    it('reanudar-escuela: `por` es la sesión aunque el cuerpo traiga otro; `acepto_motivo` solo vale con `true`', async () => {
        const r = await post(`/${ESCUELA}/campanas/reanudar-escuela`, { acepto_motivo: true, ...SUPLANTACION });
        expect(r.status).toBe(200);
        expect(est.llamadas).toEqual([{ fn: 'reanudar_escuela', args: [{ schoolId: ESCUELA, por: 'milena', aceptada: true }] }]);

        await post(`/${ESCUELA}/campanas/reanudar-escuela`, { acepto_motivo: 1, ...SUPLANTACION });
        expect(est.llamadas.at(-1)).toEqual({ fn: 'reanudar_escuela', args: [{ schoolId: ESCUELA, por: 'milena', aceptada: false }] });
    });

    it('pausar-escuela: `por` es la sesión', async () => {
        const r = await post(`/${ESCUELA}/campanas/pausar-escuela`, SUPLANTACION);
        expect(r.status).toBe(200);
        expect(est.llamadas).toEqual([{ fn: 'pausar_escuela', args: [{ schoolId: ESCUELA, por: 'milena' }] }]);
    });

    it('aprobar: un `por` en el cuerpo se ignora', async () => {
        await post(`/${ESCUELA}/campanas/${CAMP}/aprobar`, { declaracion_aceptada: true, ...SUPLANTACION });
        expect(est.llamadas.at(-1)).toEqual({ fn: 'aprobar', args: [{ schoolId: ESCUELA, campanaId: CAMP, por: 'milena', declaracionAceptada: true }] });
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
