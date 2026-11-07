/**
 * /api/v1/soportes — permisos (coach / otra escuela => 403), validación y subida. Cero red: auth y servicio simulados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const h = vi.hoisted(() => ({
    userId: 'user-1',
    admin: true,
    familia: false,
    estado: {
        ok: true, activo: true, requeridos: ['athlete_photo'],
        resumen: { total: 2, completos: 1, incompletos: 1, sin_cuenta_incompletos: 0 },
        deportistas: [
            { subject_type: 'child', subject_id: 'a', full_name: 'Ana', complete: true, missing: [] },
            { subject_type: 'child', subject_id: 'b', full_name: 'Bruno', complete: false, missing: ['athlete_photo'] },
        ],
    } as any,
    verif: { ok: true, activo: true, completo: false, requeridos: ['athlete_photo'], faltan: ['athlete_photo'] } as any,
    verifFamilia: { ok: true, activo: true, completo: false, requeridos: ['athlete_photo', 'eps_certificate'], faltan: ['eps_certificate'] } as any,
    guardar: { ok: true, id: 'doc-1', tipo: 'athlete_photo', faltan: [], completo: true, activo: true } as any,
    guardarLlamadas: [] as any[],
}));

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: h.userId }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({ administraEstaEscuela: () => Promise.resolve(h.admin) }));
vi.mock('../services/soportes.service', async () => {
    const real: any = await vi.importActual('../services/soportes.service');
    return {
        ...real,
        estadoDeEscuela: () => Promise.resolve(h.estado),
        verificarSujeto: () => Promise.resolve(h.verif),
        verificarSujetoDeFamilia: () => Promise.resolve(h.verifFamilia),
        esFamiliaDelSujeto: () => Promise.resolve(h.familia),
        guardarSoporte: (p: any) => { h.guardarLlamadas.push(p); return Promise.resolve(h.guardar); },
    };
});
vi.mock('../config/supabase', () => ({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'a', supabase: {} }));

const { default: router } = await import('./soportes.routes');

const ESC = '11111111-1111-4111-8111-111111111111';
const HIJO = '22222222-2222-4222-8222-222222222222';
const PNG_B64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]).toString('base64');

let server: http.Server;
let base: string;
beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/v1/soportes', router);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
    h.admin = true;
    h.familia = false;
    h.guardarLlamadas = [];
    h.guardar = { ok: true, id: 'doc-1', tipo: 'athlete_photo', faltan: [], completo: true, activo: true };
    h.verif = { ok: true, activo: true, completo: false, requeridos: ['athlete_photo'], faltan: ['athlete_photo'] };
});

const get = (p: string) => fetch(`${base}/api/v1/soportes${p}`);
const subir = (tipo: string, body: unknown, tipoSujeto = 'child') =>
    fetch(`${base}/api/v1/soportes/${ESC}/deportistas/${tipoSujeto}/${HIJO}/${tipo}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

describe('GET /:schoolId/estado', () => {
    it('administración: 200 con resumen y lote', async () => {
        const res = await get(`/${ESC}/estado`);
        expect(res.status).toBe(200);
        const j = await res.json();
        expect(j.activo).toBe(true);
        expect(j.deportistas).toHaveLength(2);
        expect(j.resumen.incompletos).toBe(1);
    });
    it('solo_faltan=true filtra a los incompletos', async () => {
        const j = await (await get(`/${ESC}/estado?solo_faltan=true`)).json();
        expect(j.deportistas.map((d: any) => d.full_name)).toEqual(['Bruno']);
    });
    it('coach / otra escuela (no administra) → 403', async () => {
        h.admin = false;
        expect((await get(`/${ESC}/estado`)).status).toBe(403);
    });
    it('la RPC corta (42501) → 403 aunque el BFF haya dejado pasar', async () => {
        const antes = h.estado;
        h.estado = { ok: false, status: 403, error: 'forbidden' };
        expect((await get(`/${ESC}/estado`)).status).toBe(403);
        h.estado = antes;
    });
    it('id inválido → 400', async () => {
        expect((await get('/no-es-uuid/estado')).status).toBe(400);
    });
});

describe('GET deportista', () => {
    it('administración: 200 con faltantes', async () => {
        const res = await get(`/${ESC}/deportistas/child/${HIJO}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ activo: true, completo: false, requeridos: ['athlete_photo'], faltan: ['athlete_photo'] });
    });
    it('ni administra ni es su familia → 403', async () => {
        h.admin = false; h.familia = false;
        expect((await get(`/${ESC}/deportistas/child/${HIJO}`)).status).toBe(403);
    });
    it('la familia titular ve lo que le falta a su hijo (sin pasar por la RPC de administración)', async () => {
        h.admin = false; h.familia = true;
        const res = await get(`/${ESC}/deportistas/child/${HIJO}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ activo: true, completo: false, requeridos: ['athlete_photo', 'eps_certificate'], faltan: ['eps_certificate'] });
    });
    it('tipo de sujeto inválido → 400', async () => {
        expect((await get(`/${ESC}/deportistas/perro/${HIJO}`)).status).toBe(400);
    });
    it('deportista de otra escuela → 404', async () => {
        h.verif = { ok: false, status: 404, error: 'deportista_no_encontrado' };
        expect((await get(`/${ESC}/deportistas/child/${HIJO}`)).status).toBe(404);
    });
});

describe('POST subir soporte', () => {
    it('administración sube → 201 y se llama guardarSoporte con el contrato', async () => {
        const res = await subir('athlete_photo', { archivoBase64: PNG_B64, nombre: 'foto.png' });
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ id: 'doc-1', tipo: 'athlete_photo', completo: true, faltan: [] });
        expect(h.guardarLlamadas[0]).toMatchObject({ schoolId: ESC, sujeto: { tipo: 'child', id: HIJO }, tipo: 'athlete_photo', subidoPor: 'user-1' });
        expect(Buffer.isBuffer(h.guardarLlamadas[0].archivo.buffer)).toBe(true);
    });
    it('la propia familia (no administra) también puede', async () => {
        h.admin = false;
        h.familia = true;
        expect((await subir('athlete_photo', { archivoBase64: PNG_B64 })).status).toBe(201);
    });
    it('coach u otro perfil (ni administra ni es la familia) → 403 y no se guarda', async () => {
        h.admin = false;
        h.familia = false;
        expect((await subir('athlete_photo', { archivoBase64: PNG_B64 })).status).toBe(403);
        expect(h.guardarLlamadas).toHaveLength(0);
    });
    it('tipo de documento inexistente → 400', async () => {
        expect((await subir('cedula', { archivoBase64: PNG_B64 })).status).toBe(400);
        expect(h.guardarLlamadas).toHaveLength(0);
    });
    it('cuerpo sin archivo → 400', async () => {
        expect((await subir('athlete_photo', {})).status).toBe(400);
    });
    it('archivo de más de 4 MB → 413 sin guardar', async () => {
        const grande = Buffer.alloc(4 * 1024 * 1024 + 10, 0xff).toString('base64');
        expect((await subir('athlete_photo', { archivoBase64: grande })).status).toBe(413);
        expect(h.guardarLlamadas).toHaveLength(0);
    });
    it('el servicio rechaza el formato → 400 con el código', async () => {
        h.guardar = { ok: false, status: 400, error: 'formato_no_permitido' };
        const res = await subir('athlete_photo', { archivoBase64: PNG_B64 });
        expect(res.status).toBe(400);
        expect((await res.json()).codigo).toBe('formato_no_permitido');
    });
    it('no devuelve ni la ruta de storage ni URLs', async () => {
        const j = await (await subir('athlete_photo', { archivoBase64: PNG_B64 })).json();
        expect(JSON.stringify(j)).not.toMatch(/storage|http|identity-documents/i);
    });
});
