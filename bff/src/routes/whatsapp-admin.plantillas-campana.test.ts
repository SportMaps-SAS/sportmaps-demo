/**
 * POST /:schoolId/plantillas con pie y botones rápidos (plan B5 T5): sin los
 * campos nuevos, el cuerpo que va a Meta es IDÉNTICO al de antes; con ellos,
 * FOOTER y BUTTONS de QUICK_REPLY. Router real, Meta interceptado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const est = vi.hoisted(() => ({ aMeta: [] as any[] }));

vi.mock('../config/supabase', () => {
    const tablas: Record<string, any[]> = {
        platform_admins: [],
        schools: [{ id: 'school-1', owner_id: 'admin-1' }],
        school_members: [],
        school_whatsapp_integrations: [{ school_id: 'school-1', waba_id: 'waba-1', access_token_encrypted: 'gcm:x' }],
    };
    function builder(tabla: string) {
        const filtros: ((f: any) => boolean)[] = [];
        const datos = () => (tablas[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
        const api: any = {
            select: () => api,
            eq: (c: string, v: any) => { filtros.push((f) => f[c] === v); return api; },
            limit: () => api,
            maybeSingle: async () => ({ data: datos()[0] ?? null, error: null }),
            then: (ok: any, ko: any) => Promise.resolve({ data: datos(), error: null }).then(ok, ko),
        };
        return api;
    }
    return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) } };
});
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'admin-1' }; next(); },
}));
vi.mock('../services/whatsapp.service', () => ({
    decryptToken: vi.fn(() => 'token-claro'),
    aFormatoWhatsApp: (t: string) => t,
    sendTextMessage: vi.fn(),
}));
vi.mock('../services/whatsapp-onboarding.service', () => ({ conectarEscuela: vi.fn() }));

import router, { cuerpoDePlantilla } from './whatsapp-admin.routes';

let server: http.Server;
let base = '';
const fetchReal = globalThis.fetch;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/whatsapp', router);
    server = http.createServer(app);
    await new Promise<void>((ok) => server.listen(0, ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/whatsapp`;
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
        if (String(url).startsWith('https://graph.facebook.com')) {
            est.aMeta.push(JSON.parse(init.body));
            return { ok: true, json: async () => ({ id: 'tpl-1', status: 'PENDING', category: 'MARKETING' }) } as any;
        }
        return fetchReal(url, init);
    }));
});
afterAll(() => { vi.unstubAllGlobals(); server.close(); });
beforeEach(() => { est.aMeta = []; });

const post = (body: unknown) => fetchReal(`${base}/school-1/plantillas`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const CUERPO_DE_ANTES = {
    name: 'clase_cancelada', language: 'es_CO', category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}, la clase de {{2}} fue cancelada.', example: { body_text: [['Carolina', 'Samuel']] } }],
};

describe('POST /:schoolId/plantillas', () => {
    it('sin pie ni botones: el cuerpo a Meta es idéntico al de antes', async () => {
        const r = await post({ name: 'clase_cancelada', body: 'Hola {{1}}, la clase de {{2}} fue cancelada.', ejemplos: ['Carolina', 'Samuel'] });
        expect(r.status).toBe(201);
        expect(est.aMeta).toEqual([CUERPO_DE_ANTES]);
    });

    it('con pie y 3 botones rápidos: FOOTER y BUTTONS de QUICK_REPLY, en ese orden', async () => {
        const r = await post({
            name: 'monster_cierre_2026', category: 'MARKETING', body: '¡Hola {{1}}! Dos novedades del club. ¿Te enviamos la información?',
            ejemplos: ['Carolina'], pie: 'Puedes dejar de recibir promociones cuando quieras',
            botones_rapidos: ['Sí, cuéntame', 'Más adelante', 'No recibir más'],
        });
        expect(r.status).toBe(201);
        expect(est.aMeta[0].components).toEqual([
            { type: 'BODY', text: '¡Hola {{1}}! Dos novedades del club. ¿Te enviamos la información?', example: { body_text: [['Carolina']] } },
            { type: 'FOOTER', text: 'Puedes dejar de recibir promociones cuando quieras' },
            { type: 'BUTTONS', buttons: ['Sí, cuéntame', 'Más adelante', 'No recibir más'].map((text) => ({ type: 'QUICK_REPLY', text })) },
        ]);
    });

    it('más de 3 botones o un botón de más de 25 caracteres: 400 sin llamar a Meta', async () => {
        const largo = await post({ name: 'x_promo', body: 'Texto de prueba suficiente.', botones_rapidos: ['a', 'b', 'c', 'd'] });
        expect(largo.status).toBe(400);
        const texto = await post({ name: 'x_promo', body: 'Texto de prueba suficiente.', botones_rapidos: ['Un botón con un texto demasiado largo'] });
        expect(texto.status).toBe(400);
        expect(est.aMeta).toHaveLength(0);
    });

    it('cuerpoDePlantilla es pura y no agrega nada sin los campos nuevos', () => {
        expect(cuerpoDePlantilla({ name: 'a_b', language: 'es_CO', category: 'UTILITY', body: 'Hola, texto sin variables.', ejemplos: [] }))
            .toEqual({ name: 'a_b', language: 'es_CO', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola, texto sin variables.' }] });
    });
});
