/**
 * whatsapp-precios-escuela.routes — solo la administración de ESA escuela ve y
 * edita los precios del bot; el servicio recibe la escuela de la ruta y el
 * cuerpo tal cual (él valida), y sus errores salen con su estado y su clave.
 * Router real; el servicio va moqueado (lo cubre su propio test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const PRECIOS = {
    interruptores: { responde_precios: true, cobra_desde_comprobante: false },
    mensualidades: [{ plan_id: 'p1', nombre: 'Mensual', precio: 150000 }],
    matricula: { valor: 100000, valores_distintos: [100000], planes: 1 },
    clase_prueba: { valor: null, habilitada: true },
    articulos: [], servicios: [], avisos: [{ clave: 'sin_articulos', texto: 'No tienes artículos cargados.' }],
};

const est = vi.hoisted(() => ({
    usuario: 'milena',
    admins: new Set(['milena']),
    /** Con qué (usuario, escuela) se preguntó el permiso. */
    gate: [] as [string, string][],
    llamadas: [] as { fn: string; args: any[] }[],
    resultado: null as any,
    lanza: false,
}));

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string, schoolId: string) => { est.gate.push([uid, schoolId]); return est.admins.has(uid); }),
}));
vi.mock('../services/whatsapp-precios-escuela.service', () => {
    const anotar = (fn: string) => vi.fn(async (...args: any[]) => {
        est.llamadas.push({ fn, args });
        if (est.lanza) throw new Error('se cayó');
        return est.resultado;
    });
    return {
        leerPreciosDeEscuela: anotar('leer'),
        guardarInterruptores: anotar('interruptores'),
        guardarMatricula: anotar('matricula'),
        guardarClasePrueba: anotar('clase_prueba'),
        crearArticulo: anotar('crear_articulo'),
        actualizarArticulo: anotar('actualizar_articulo'),
    };
});

import router from './whatsapp-precios-escuela.routes';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const ART = '11111111-1111-4111-8111-111111111111';
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
    est.resultado = { ok: true, precios: PRECIOS };
    est.lanza = false;
});

const pedir = (metodo: string, p: string, body?: unknown) => fetch(`${base}${p}`, {
    method: metodo, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Todos los endpoints, con un cuerpo válido. */
const ENDPOINTS: [string, string, unknown, string][] = [
    ['GET', `/${ESCUELA}/precios`, undefined, 'leer'],
    ['PUT', `/${ESCUELA}/precios/interruptores`, { responde_precios: true }, 'interruptores'],
    ['PUT', `/${ESCUELA}/precios/matricula`, { valor: 310000 }, 'matricula'],
    ['PUT', `/${ESCUELA}/precios/clase-prueba`, { valor: 20000 }, 'clase_prueba'],
    ['POST', `/${ESCUELA}/precios/articulos`, { nombre: 'Uniforme', precio: 85000 }, 'crear_articulo'],
    ['PATCH', `/${ESCUELA}/precios/articulos/${ART}`, { activo: false }, 'actualizar_articulo'],
];

describe('autorización', () => {
    it('un coach o alguien de otra escuela: 403 en TODOS los endpoints, sin tocar el servicio', async () => {
        est.usuario = 'coach-1';
        for (const [metodo, p, body] of ENDPOINTS) {
            const r = await pedir(metodo, p, body);
            expect([metodo, p, r.status]).toEqual([metodo, p, 403]);
            expect(await r.json()).toEqual({ error: 'forbidden' });
        }
        expect(est.llamadas).toHaveLength(0);
    });

    it('el permiso se pregunta por el usuario de la sesión y por ESA escuela, en cada endpoint', async () => {
        for (const [metodo, p, body] of ENDPOINTS) await pedir(metodo, p, body);
        expect(est.gate).toHaveLength(ENDPOINTS.length);
        for (const g of est.gate) expect(g).toEqual(['milena', ESCUELA]);
    });

    it('ids inválidos: 400 sin preguntar permisos ni tocar el servicio', async () => {
        expect((await pedir('GET', '/no-es-uuid/precios')).status).toBe(400);
        expect((await pedir('PUT', '/no-es-uuid/precios/matricula', { valor: 1 })).status).toBe(400);
        const r = await pedir('PATCH', `/${ESCUELA}/precios/articulos/xx`, { activo: false });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'id_invalido' });
        expect(est.gate).toHaveLength(0);
        expect(est.llamadas).toHaveLength(0);
    });
});

describe('GET /:schoolId/precios', () => {
    it('devuelve el contrato tal cual lo arma el servicio', async () => {
        const r = await pedir('GET', `/${ESCUELA}/precios`);
        expect(r.status).toBe(200);
        expect(await r.json()).toEqual(PRECIOS);
        expect(est.llamadas).toEqual([{ fn: 'leer', args: [ESCUELA] }]);
    });
});

describe('escrituras', () => {
    // La escuela sale de la ruta (ya autorizada); un school_id o un usuario en el cuerpo no cambian a quién se le escribe.
    const SUPLANTACION = { school_id: 'otra-escuela', schoolId: 'otra-escuela', user_id: 'otra-persona', por: 'otra-persona' };

    it('cada una llama a su función con la escuela de la ruta y devuelve el GET actualizado', async () => {
        for (const [metodo, p, body, fn] of ENDPOINTS.slice(1)) {
            est.llamadas = [];
            const r = await pedir(metodo, p, { ...(body as object), ...SUPLANTACION });
            expect([fn, r.status]).toEqual([fn, fn === 'crear_articulo' ? 201 : 200]);
            expect(await r.json()).toEqual(PRECIOS);
            expect(est.llamadas).toHaveLength(1);
            expect(est.llamadas[0].fn).toBe(fn);
            expect(est.llamadas[0].args[0]).toBe(ESCUELA);
        }
    });

    it('el artículo se identifica por el :id de la ruta, no por el cuerpo', async () => {
        await pedir('PATCH', `/${ESCUELA}/precios/articulos/${ART}`, { precio: 90000, id: 'otro' });
        expect(est.llamadas).toEqual([{ fn: 'actualizar_articulo', args: [ESCUELA, ART, { precio: 90000, id: 'otro' }] }]);
    });

    it('los errores del servicio salen con su estado y su clave', async () => {
        est.resultado = { ok: false, status: 400, error: 'valor_invalido' };
        let r = await pedir('PUT', `/${ESCUELA}/precios/matricula`, { valor: -1 });
        expect(r.status).toBe(400);
        expect(await r.json()).toEqual({ error: 'valor_invalido' });

        est.resultado = { ok: false, status: 404, error: 'articulo_no_encontrado' };
        r = await pedir('PATCH', `/${ESCUELA}/precios/articulos/${ART}`, { activo: false });
        expect(r.status).toBe(404);
        expect(await r.json()).toEqual({ error: 'articulo_no_encontrado' });

        est.resultado = { ok: false, status: 500, error: 'error_leyendo_precios' };
        r = await pedir('GET', `/${ESCUELA}/precios`);
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: 'error_leyendo_precios' });
    });

    it('si algo lanza, el cliente recibe un 500 con clave (nunca un error sin forma)', async () => {
        est.lanza = true;
        for (const [metodo, p, body] of ENDPOINTS) {
            const r = await pedir(metodo, p, body);
            expect(r.status).toBe(500);
            expect(await r.json()).toEqual({ error: 'error_interno' });
        }
    });

    it('sin cuerpo no revienta: el servicio decide', async () => {
        est.resultado = { ok: false, status: 400, error: 'valor_invalido' };
        expect((await pedir('PUT', `/${ESCUELA}/precios/matricula`)).status).toBe(400);
    });
});
