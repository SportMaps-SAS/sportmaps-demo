/**
 * T1 · Historial de Coexistence: al terminar un alta con Coexistence se pide el
 * historial a Meta (`POST /<PHONE_NUMBER_ID>/smb_app_data`, 24 h, una sola vez).
 *
 * Hasta el 2026-10-30 nadie lo pedía (Dynasty: 0 mensajes anteriores al alta)
 * y, además, la pantalla de la escuela no mandaba el `event` de la sesión, así
 * que el BFF nunca sabía que era Coexistence: por eso también se pregunta a
 * Graph (`is_on_biz_app`).
 *
 * Supabase en memoria y `fetch` simulado por URL. Datos inventados.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fila = Record<string, any>;

const h = vi.hoisted(() => {
    process.env.META_APP_ID = 'app-1';
    process.env.WHATSAPP_APP_SECRET = 'secreto';
    return {
        tablas: {} as Record<string, Fila[]>,
        avisar: null as any,
    };
});

vi.mock('../config/supabase', () => {
    const valor = (f: Fila, c: string) => {
        const [col, sub] = c.split('->>');
        return sub ? f[col]?.[sub] : f[col];
    };
    function builder(tabla: string) {
        const filtros: ((f: Fila) => boolean)[] = [];
        let alta: Fila | null = null;
        let limite = Infinity;
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((f) => valor(f, c) === v); return api; },
            limit: (n: number) => { limite = n; return api; },
            insert: (fila: Fila) => { alta = fila; return api; },
            maybeSingle: async () => resolver(true),
            single: async () => resolver(true),
            then: (ok: any, ko: any) => Promise.resolve(resolver(false)).then(ok, ko),
        };
        function resolver(uno: boolean) {
            h.tablas[tabla] ??= [];
            if (alta) {
                const nueva = { id: `${tabla}-${h.tablas[tabla].length + 1}`, ...alta };
                h.tablas[tabla].push(nueva);
                return { data: nueva, error: null };
            }
            const filas = h.tablas[tabla].filter((f) => filtros.every((p) => p(f))).slice(0, limite);
            return { data: uno ? filas[0] ?? null : filas, error: null };
        }
        return api;
    }
    return { supabase: { from: (t: string) => builder(t) } };
});

vi.mock('./whatsapp.service', () => ({
    encryptToken: (t: string) => `cifrado:${t}`,
    decryptToken: (c: string) => c.replace(/^cifrado:/, ''),
}));

vi.mock('./whatsapp-coexistence.service', () => {
    h.avisar = vi.fn(async () => undefined);
    return {
        CAMPO_PEDIDO_HISTORIAL: 'history_sync_request',
        avisarPlataformaSobreHistorial: (...a: any[]) => h.avisar(...a),
    };
});

const { conectarEscuela, pedirHistorialDeCoexistencia } = await import('./whatsapp-onboarding.service');

/** Lo que contesta Meta en cada prueba. */
let enBizApp = false;
let smbAppData: (body: any) => { status: number; json: any } | 'red' = () => ({
    status: 200, json: { messaging_product: 'whatsapp', request_id: 'req-123' },
});
let llamadas: { url: string; init?: any }[] = [];

const respuesta = (status: number, json: any) => ({
    ok: status >= 200 && status < 300, status, json: async () => json,
});

beforeEach(() => {
    h.tablas = { school_whatsapp_integrations: [], whatsapp_settings: [], whatsapp_account_events: [] };
    h.avisar.mockClear();
    enBizApp = false;
    smbAppData = () => ({ status: 200, json: { messaging_product: 'whatsapp', request_id: 'req-123' } });
    llamadas = [];
    delete process.env.WA_SYNC_CONTACTOS;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
        llamadas.push({ url, init });
        if (url.includes('/oauth/access_token')) return respuesta(200, { access_token: 'tok-escuela' });
        if (url.includes('/waba-1/phone_numbers')) {
            return respuesta(200, { data: [{ id: 'pn-1', display_phone_number: '+57 319 450 5150' }] });
        }
        if (url.includes('/waba-1/subscribed_apps')) return respuesta(200, { success: true });
        if (url.includes('/pn-1?fields=is_on_biz_app')) {
            return respuesta(200, { is_on_biz_app: enBizApp, platform_type: 'CLOUD_API', id: 'pn-1' });
        }
        if (url.endsWith('/pn-1/smb_app_data')) {
            const r = smbAppData(JSON.parse(init?.body ?? '{}'));
            if (r === 'red') throw new Error('socket hang up');
            return respuesta(r.status, r.json);
        }
        return respuesta(404, { error: { message: `URL no simulada: ${url}` } });
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WA_SYNC_CONTACTOS;
});

const pedidosSmb = () => llamadas.filter((l) => l.url.endsWith('/smb_app_data'));
const eventos = () => h.tablas.whatsapp_account_events;

describe('conectarEscuela · pedido del historial', () => {
    it('alta con Coexistence (event de la sesión): pide el historial con el contrato de Meta y lo registra', async () => {
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', waba_id: 'waba-1' }, 'user-1');

        expect(r).toMatchObject({ ok: true, coexistence: true });
        const pedidos = pedidosSmb();
        expect(pedidos).toHaveLength(1);
        expect(pedidos[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/pn-1\/smb_app_data$/);
        expect(pedidos[0].init.method).toBe('POST');
        expect(pedidos[0].init.headers.Authorization).toBe('Bearer tok-escuela');
        expect(JSON.parse(pedidos[0].init.body)).toEqual({ messaging_product: 'whatsapp', sync_type: 'history' });

        expect(eventos()).toHaveLength(1);
        expect(eventos()[0]).toMatchObject({
            field: 'history_sync_request', nuevo_estado: 'pedido', school_id: 'school-1',
            phone_number_id: 'pn-1', waba_id: 'waba-1',
            payload: { sync_type: 'history', request_id: 'req-123', error: null },
        });
        // El plazo de Meta queda escrito: 24 h desde el alta.
        const alta = Date.parse(h.tablas.school_whatsapp_integrations[0].connected_at);
        expect(Date.parse(eventos()[0].payload.plazo_hasta) - alta).toBe(24 * 3600_000);
        // El alta sigue completa: ajustes con el bot apagado.
        expect(h.tablas.whatsapp_settings).toHaveLength(1);
        expect(h.avisar).not.toHaveBeenCalled();
    });

    it('sin `event` en la sesión (lo que mandaba la pantalla de la escuela) lo detecta por Graph is_on_biz_app', async () => {
        enBizApp = true;
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso', { waba_id: 'waba-1' }, 'user-1');
        expect(r).toMatchObject({ ok: true, coexistence: true });
        expect(pedidosSmb()).toHaveLength(1);
    });

    it('alta normal (número nuevo, sin app Business): no pide nada', async () => {
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH', waba_id: 'waba-1' }, 'user-1');
        expect(r).toMatchObject({ ok: true, coexistence: false });
        expect(pedidosSmb()).toHaveLength(0);
        expect(eventos()).toHaveLength(0);
    });

    it('si Graph no contesta is_on_biz_app, se toma como alta normal (no rompe)', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
            llamadas.push({ url, init });
            if (url.includes('/oauth/access_token')) return respuesta(200, { access_token: 'tok-escuela' });
            if (url.includes('/waba-1/phone_numbers')) return respuesta(200, { data: [{ id: 'pn-1', display_phone_number: '1' }] });
            if (url.includes('/waba-1/subscribed_apps')) return respuesta(200, { success: true });
            throw new Error('Graph caído');
        }));
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso', { waba_id: 'waba-1' }, 'user-1');
        expect(r).toMatchObject({ ok: true, coexistence: false });
        expect(pedidosSmb()).toHaveLength(0);
    });

    it('Meta rechaza el pedido: el alta NO se cae, queda «fallido» y se avisa a la plataforma', async () => {
        smbAppData = () => ({ status: 400, json: { error: { message: 'Sync already requested', code: 100 } } });
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', waba_id: 'waba-1' }, 'user-1');

        expect(r).toMatchObject({ ok: true, coexistence: true });
        expect(h.tablas.school_whatsapp_integrations).toHaveLength(1);
        expect(h.tablas.whatsapp_settings).toHaveLength(1);
        expect(eventos()[0]).toMatchObject({
            field: 'history_sync_request', nuevo_estado: 'fallido', motivo: 'Sync already requested',
            payload: { sync_type: 'history', request_id: null, error: 'Sync already requested' },
        });
        expect(h.avisar).toHaveBeenCalledTimes(1);
        expect(h.avisar.mock.calls[0][0]).toMatchObject({
            motivo: 'pedido_fallido', integrationId: r.ok ? r.integrationId : '', schoolId: 'school-1',
            tipo: 'history', detalle: 'Sync already requested',
        });
    });

    it('error de red en el pedido: el alta tampoco se cae', async () => {
        smbAppData = () => 'red';
        const r = await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', waba_id: 'waba-1' }, 'user-1');
        expect(r).toMatchObject({ ok: true, coexistence: true });
        expect(eventos()[0]).toMatchObject({ nuevo_estado: 'fallido', motivo: 'socket hang up' });
        expect(h.avisar).toHaveBeenCalledTimes(1);
    });

    it('contactos (smb_app_state_sync) SOLO con WA_SYNC_CONTACTOS=true', async () => {
        process.env.WA_SYNC_CONTACTOS = 'true';
        await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', waba_id: 'waba-1' }, 'user-1');
        expect(pedidosSmb().map((l) => JSON.parse(l.init.body).sync_type)).toEqual(['smb_app_state_sync', 'history']);
        expect(eventos().map((e) => e.payload.sync_type)).toEqual(['smb_app_state_sync', 'history']);
    });

    it('cualquier otro valor de WA_SYNC_CONTACTOS no pide contactos', async () => {
        process.env.WA_SYNC_CONTACTOS = '1';
        await conectarEscuela('school-1', 'codigo-de-un-solo-uso',
            { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', waba_id: 'waba-1' }, 'user-1');
        expect(pedidosSmb().map((l) => JSON.parse(l.init.body).sync_type)).toEqual(['history']);
    });
});

describe('pedirHistorialDeCoexistencia · idempotencia', () => {
    const datos = {
        integrationId: 'int-9', schoolId: 'school-9', wabaId: 'waba-1', phoneNumberId: 'pn-1',
        token: 'tok-escuela', conectadoAt: '2026-10-30T15:00:00.000Z',
    };

    it('no lo pide dos veces para la misma integración', async () => {
        expect((await pedirHistorialDeCoexistencia(datos)).map((p) => p.estado)).toEqual(['pedido']);
        expect((await pedirHistorialDeCoexistencia(datos)).map((p) => p.estado)).toEqual(['ya_pedido']);
        expect(pedidosSmb()).toHaveLength(1);
        expect(eventos()).toHaveLength(1);
    });

    it('un pedido fallido sí se puede reintentar dentro del plazo', async () => {
        smbAppData = () => ({ status: 500, json: { error: { message: 'Temporal' } } });
        expect((await pedirHistorialDeCoexistencia(datos))[0].estado).toBe('fallido');
        smbAppData = () => ({ status: 200, json: { request_id: 'req-2' } });
        expect((await pedirHistorialDeCoexistencia(datos))[0]).toMatchObject({ estado: 'pedido', requestId: 'req-2' });
        expect(pedidosSmb()).toHaveLength(2);
        expect((await pedirHistorialDeCoexistencia(datos))[0].estado).toBe('ya_pedido');
        expect(pedidosSmb()).toHaveLength(2);
    });

    it('el pedido de contactos no cuenta como pedido del historial', async () => {
        process.env.WA_SYNC_CONTACTOS = 'true';
        h.tablas.whatsapp_account_events.push({
            integration_id: 'int-9', field: 'history_sync_request', nuevo_estado: 'pedido',
            payload: { sync_type: 'smb_app_state_sync' },
        });
        const r = await pedirHistorialDeCoexistencia(datos);
        expect(r.map((p) => [p.tipo, p.estado])).toEqual([['smb_app_state_sync', 'ya_pedido'], ['history', 'pedido']]);
        expect(pedidosSmb().map((l) => JSON.parse(l.init.body).sync_type)).toEqual(['history']);
    });
});
