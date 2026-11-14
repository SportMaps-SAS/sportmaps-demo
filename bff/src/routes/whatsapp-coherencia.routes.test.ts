/**
 * whatsapp-coherencia.routes — solo la administración de ESA escuela ve las
 * contradicciones de su ficha contra el catálogo. Router real; datos moqueados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const est = vi.hoisted(() => ({
    usuario: 'ivan',
    admins: new Set(['ivan']),
    ficha: null as string | null,
    items: [] as any[],
    falla: false,
}));

vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string) => est.admins.has(uid)),
}));
vi.mock('../services/whatsapp-prospecto-ia.service', () => ({
    fichaDeProspectos: vi.fn(async () => { if (est.falla) throw new Error('caída'); return est.ficha; }),
}));
vi.mock('../services/whatsapp-anuncio-destino', async (orig) => ({
    ...(await orig<typeof import('../services/whatsapp-anuncio-destino')>()),
    serviciosDeAnuncio: vi.fn(async () => est.items),
}));

import router from './whatsapp-coherencia.routes';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CLINICA = {
    id: '16766d2e-f8b0-4285-88e3-b1e67dda6d45', name: 'Clínica de armadores y atacantes', kind: 'clase_extra',
    price: 300000, active: true, event_id: null, starts_at: '2026-11-21T05:00:00+00:00', ends_at: '2026-11-23T04:59:00+00:00',
    allow_installments: true, precio_afiliado: 250000, precios_por_fecha: [{ desde: '2026-11-11', precio: 350000 }],
    abono_minimo_pct: 50, opciones: null, description: 'Valor de preventa $300.000 hasta el 10 de noviembre',
};
let server: http.Server;
let base = '';

beforeAll(async () => {
    const app = express();
    app.use('/api/v1/whatsapp', router);
    server = http.createServer(app);
    await new Promise<void>((ok) => server.listen(0, ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/whatsapp`;
});
afterAll(() => { server.close(); });

beforeEach(() => {
    est.usuario = 'ivan';
    est.ficha = '🏐 CLÍNICA DE ARMADORES Y ATACANTES\n• Preventa: $300.000 hasta el 9 de noviembre.';
    est.items = [CLINICA];
    est.falla = false;
});

describe('GET /:schoolId/coherencia-ficha', () => {
    it('administración de la escuela: la contradicción de la ficha con su texto claro', async () => {
        const r = await fetch(`${base}/${ESCUELA}/coherencia-ficha`);
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(body.servicios).toBe(1);
        expect(body.ficha).toBe(true);
        expect(body.contradicciones).toHaveLength(1);
        expect(body.contradicciones[0]).toMatchObject({ fuente: 'ficha', linea: 2, tipo: 'fecha_de_precio', servicioId: CLINICA.id });
        expect(body.contradicciones[0].mensaje).toContain('Tu texto para el asistente dice “Preventa: $300.000 hasta el 9 de noviembre”');
        expect(body.contradicciones[0].mensaje).toContain('hasta el martes 10 de noviembre');
    });

    it('sin ficha y con una descripción coherente: nada que avisar', async () => {
        est.ficha = null;
        const body = await (await fetch(`${base}/${ESCUELA}/coherencia-ficha`)).json();
        expect(body).toEqual({ servicios: 1, ficha: false, contradicciones: [] });
    });

    it('otro usuario: 403; id inválido: 400; si la lectura falla: 500', async () => {
        est.usuario = 'intruso';
        expect((await fetch(`${base}/${ESCUELA}/coherencia-ficha`)).status).toBe(403);
        est.usuario = 'ivan';
        expect((await fetch(`${base}/no-es-uuid/coherencia-ficha`)).status).toBe(400);
        est.falla = true;
        expect((await fetch(`${base}/${ESCUELA}/coherencia-ficha`)).status).toBe(500);
    });
});
