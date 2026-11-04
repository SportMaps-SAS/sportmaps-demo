/**
 * whatsapp-anuncios.routes — solo la administración de ESA escuela ve el
 * embudo y mapea anuncios; el embudo va con el JWT del usuario (no service
 * role); sin la migración, `disponible:false`. Router real; datos moqueados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const est = vi.hoisted(() => ({
    usuario: 'milena',
    admins: new Set(['milena']),
    rpc: { data: [] as any[] | null, error: null as any },
    rpcLlamadas: [] as { auth: string; args: any }[],
    mapeos: { data: [] as any[] | null, error: null as any },
    upsert: { data: null as any, error: null as any },
    escrituras: [] as { op: string; args: any[] }[],
}));

vi.mock('@supabase/supabase-js', () => ({
    createClient: (_url: string, _key: string, opts: any) => ({
        rpc: async (fn: string, args: any) => {
            est.rpcLlamadas.push({ auth: opts?.global?.headers?.Authorization, args: { fn, ...args } });
            return { data: est.rpc.data, error: est.rpc.error };
        },
    }),
}));

vi.mock('../config/supabase', () => {
    const consulta = (tabla: string) => {
        const q: any = {
            _tabla: tabla,
            select: () => q, eq: () => q, is: () => q, order: () => q, limit: () => q,
            upsert: (...args: any[]) => { est.escrituras.push({ op: 'upsert', args }); return q; },
            delete: () => { est.escrituras.push({ op: 'delete', args: [] }); return q; },
            single: async () => est.upsert,
            then: (ok: any, ko: any) => {
                let r: any;
                if (tabla === 'whatsapp_anuncio_destino') {
                    r = est.escrituras.at(-1)?.op === 'delete' ? { data: [{ source_id: 'AD1' }], error: null } : est.mapeos;
                } else if (tabla === 'school_tournament_items') {
                    r = { data: [{ id: 'S-1', name: 'Clínica de diciembre', kind: 'clase_extra', active: true }], error: null };
                } else {
                    r = { data: [{ id: 'B-1', name: 'Suba' }], error: null };
                }
                return Promise.resolve(r).then(ok, ko);
            },
        };
        return q;
    };
    return { supabase: { from: (t: string) => consulta(t) }, SUPABASE_URL: 'http://supabase', SUPABASE_ANON_KEY: 'anon' };
});
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string) => est.admins.has(uid)),
}));

import router from './whatsapp-anuncios.routes';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const SERV = '11111111-1111-4111-8111-111111111111';
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
    est.rpc = {
        data: [
            { es_total: false, source_id: '120251275521150783', headline: 'Aparta tu cupo', conversaciones: 4, contestaron: 2, monto: '0', pagos_por_motivo: [] },
            { es_total: true, source_id: null, conversaciones: 4, contestaron: 2, monto: 0, pagos_por_motivo: [] },
        ],
        error: null,
    };
    est.rpcLlamadas = [];
    est.mapeos = { data: [{ source_id: '120251275521150783', destino: 'clase_prueba', servicio_id: null, nota: null, updated_at: 'x' }], error: null };
    est.upsert = { data: { source_id: '120251275521150783', destino: 'servicio', servicio_id: SERV, nota: null, updated_at: 'y' }, error: null };
    est.escrituras = [];
});

const pedir = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, {
    ...init, headers: { authorization: 'Bearer token-de-milena', 'content-type': 'application/json', ...(init.headers ?? {}) },
});

describe('autorización', () => {
    it('un coach o alguien de otra escuela: 403 y no se llama la RPC ni se escribe', async () => {
        est.usuario = 'coach-1';
        expect((await pedir(`/${ESCUELA}/anuncios`)).status).toBe(403);
        expect((await pedir(`/${ESCUELA}/anuncios/AD1/destino`, { method: 'PUT', body: JSON.stringify({ destino: 'persona' }) })).status).toBe(403);
        expect((await pedir(`/${ESCUELA}/anuncios/AD1/destino`, { method: 'DELETE' })).status).toBe(403);
        expect(est.rpcLlamadas).toEqual([]);
        expect(est.escrituras).toEqual([]);
    });
    it('ids inválidos: 400 antes de preguntar nada', async () => {
        expect((await pedir('/no-es-uuid/anuncios')).status).toBe(400);
        expect((await pedir(`/${ESCUELA}/anuncios/a%20b/destino`, { method: 'PUT', body: '{}' })).status).toBe(400);
    });
    it('el candado de la RPC también cuenta: 42501 → 403', async () => {
        est.rpc = { data: null, error: { code: '42501', message: 'Forbidden' } };
        expect((await pedir(`/${ESCUELA}/anuncios`)).status).toBe(403);
    });
});

describe('GET embudo', () => {
    it('llama la RPC con el JWT del usuario, el rango de Bogotá y la sede', async () => {
        const sede = '22222222-2222-4222-8222-222222222222';
        const r = await pedir(`/${ESCUELA}/anuncios?desde=2026-10-01&hasta=2026-11-04&sede=${sede}`);
        expect(r.status).toBe(200);
        const b = await r.json();
        expect(est.rpcLlamadas).toEqual([{
            auth: 'Bearer token-de-milena',
            args: { fn: 'wa_embudo_anuncios', p_school_id: ESCUELA, p_desde: '2026-10-01', p_hasta: '2026-11-04', p_branch_id: sede },
        }]);
        expect(b.disponible).toBe(true);
        expect(b.rango).toEqual({ desde: '2026-10-01', hasta: '2026-11-04' });
        expect(b.anuncios).toHaveLength(1);
        expect(b.anuncios[0]).toMatchObject({ source_id: '120251275521150783', headline: 'Aparta tu cupo', conversaciones: 4, monto: 0 });
        expect(b.total).toMatchObject({ conversaciones: 4, contestaron: 2 });
        expect(b.mapeos[0]).toMatchObject({ destino: 'clase_prueba' });
        expect(b.servicios).toEqual([{ id: 'S-1', nombre: 'Clínica de diciembre', tipo: 'clase_extra', activo: true }]);
        expect(b.sedes).toEqual([{ id: 'B-1', nombre: 'Suba' }]);
    });
    it('rango o sede inválidos: 400 sin llamar la RPC', async () => {
        expect((await pedir(`/${ESCUELA}/anuncios?desde=2026-11-05&hasta=2026-11-04`)).status).toBe(400);
        expect((await pedir(`/${ESCUELA}/anuncios?sede=suba`)).status).toBe(400);
        expect(est.rpcLlamadas).toEqual([]);
    });
    it('sin la migración: disponible:false (no 500)', async () => {
        est.rpc = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.wa_embudo_anuncios' } };
        est.mapeos = { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } };
        const r = await pedir(`/${ESCUELA}/anuncios`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ disponible: false });
    });
    it('sede de otra escuela (22023 SEDE_INVALIDA) → 400', async () => {
        est.rpc = { data: null, error: { code: '22023', message: 'SEDE_INVALIDA' } };
        const r = await pedir(`/${ESCUELA}/anuncios`);
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'sede_invalida' });
    });
    it('error inesperado → 500 con mensaje', async () => {
        est.rpc = { data: null, error: { code: 'XX000', message: 'boom' } };
        expect((await pedir(`/${ESCUELA}/anuncios`)).status).toBe(500);
    });
});

describe('mapeo anuncio → destino', () => {
    it('GET destinos: mapeos + catálogo', async () => {
        const b = await (await pedir(`/${ESCUELA}/anuncios/destinos`)).json();
        expect(b).toMatchObject({ disponible: true, mapeos: [{ source_id: '120251275521150783' }], servicios: [{ id: 'S-1' }] });
    });
    it('PUT servicio: upsert por (escuela, anuncio) con quién lo guardó', async () => {
        const r = await pedir(`/${ESCUELA}/anuncios/120251275521150783/destino`, {
            method: 'PUT', body: JSON.stringify({ destino: 'servicio', servicio_id: SERV }),
        });
        expect(r.status).toBe(200);
        expect((await r.json()).mapeo).toMatchObject({ destino: 'servicio', servicio_id: SERV });
        expect(est.escrituras).toEqual([{
            op: 'upsert',
            args: [
                { school_id: ESCUELA, source_id: '120251275521150783', destino: 'servicio', servicio_id: SERV, nota: null, actualizado_por: 'milena' },
                { onConflict: 'school_id,source_id' },
            ],
        }]);
    });
    it('PUT sin servicio o destino raro: 400 sin escribir', async () => {
        const a = await pedir(`/${ESCUELA}/anuncios/AD1/destino`, { method: 'PUT', body: JSON.stringify({ destino: 'servicio' }) });
        expect(a.status).toBe(400);
        expect(await a.json()).toEqual({ error: 'falta_servicio' });
        expect((await pedir(`/${ESCUELA}/anuncios/AD1/destino`, { method: 'PUT', body: JSON.stringify({ destino: 'torneo' }) })).status).toBe(400);
        expect(est.escrituras).toEqual([]);
    });
    it('PUT con un servicio de otra escuela: el trigger lo frena → 400 servicio_invalido', async () => {
        est.upsert = { data: null, error: { code: '23503', message: 'SERVICIO_INVALIDO' } };
        const r = await pedir(`/${ESCUELA}/anuncios/AD1/destino`, {
            method: 'PUT', body: JSON.stringify({ destino: 'servicio', servicio_id: SERV }),
        });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'servicio_invalido' });
    });
    it('DELETE: quita el mapeo', async () => {
        const r = await pedir(`/${ESCUELA}/anuncios/AD1/destino`, { method: 'DELETE' });
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual({ borrados: 1 });
    });
});
