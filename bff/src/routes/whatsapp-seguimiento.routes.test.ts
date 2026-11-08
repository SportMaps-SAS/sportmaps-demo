/**
 * whatsapp-seguimiento.routes — solo la administración de ESA escuela (o de
 * plataforma) ve la lista; rango por defecto 14 días y máximo 31; filtros; CSV; y
 * la lectura es mínima: una consulta por tabla, columnas contadas, sin el payload
 * crudo y con tope. Router real; Supabase moqueado (no sale nada).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

const ESCUELA = 'eb3ebc77-4ea4-4992-96c8-3c8ec574578c';
const CLINICA = '16766d2e-f8b0-4285-88e3-b1e67dda6d45';

const est = vi.hoisted(() => ({
    usuario: 'ivan',
    admins: new Set(['ivan', 'plataforma']),
    consultas: [] as { tabla: string; ops: [string, any[]][] }[],
    tablas: {} as Record<string, { data: any; error: any }>,
}));

vi.mock('../config/supabase', () => {
    const consulta = (tabla: string) => {
        const registro = { tabla, ops: [] as [string, any[]][] };
        est.consultas.push(registro);
        const q: any = {};
        for (const op of ['select', 'eq', 'neq', 'gte', 'lte', 'in', 'or', 'order', 'limit', 'range', 'is', 'not']) {
            q[op] = (...args: any[]) => { registro.ops.push([op, args]); return q; };
        }
        q.then = (ok: any, ko: any) => Promise.resolve(est.tablas[tabla] ?? { data: [], error: null }).then(ok, ko);
        return q;
    };
    return { supabase: { from: (t: string) => consulta(t) } };
});
vi.mock('../middlewares/authMiddleware', () => ({
    requireAuth: (req: any, _res: any, next: any) => { req.user = { id: est.usuario }; next(); },
}));
vi.mock('./whatsapp-admin.routes', () => ({
    administraEstaEscuela: vi.fn(async (uid: string) => est.admins.has(uid)),
}));

import router from './whatsapp-seguimiento.routes';

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

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(() => {
    est.usuario = 'ivan';
    est.consultas = [];
    est.tablas = {
        whatsapp_conversations: {
            data: [
                { id: 'c-1', contact_wa_id: '573124567890', contact_name: 'Laura', contact_kind: 'desconocido', parent_id: null, tomada_por: null },
                { id: 'c-2', contact_wa_id: '573001112233', contact_name: 'Andrés', contact_kind: 'desconocido', parent_id: null, tomada_por: null },
            ],
            error: null,
        },
        whatsapp_messages: {
            data: [
                { conversation_id: 'c-1', direction: 'inbound', type: 'text', text_body: 'info de la clínica de armadores', ai_generated: false, status: 'received', created_at: hace(300) },
                { conversation_id: 'c-1', direction: 'outbound', type: 'text', text_body: 'La clínica es el 21 y 22 de noviembre.', ai_generated: true, status: 'read', created_at: hace(299), venta_servicio_id: CLINICA, step: 'venta_ficha' },
                { conversation_id: 'c-2', direction: 'inbound', type: 'text', text_body: '¿Cuánto vale la mensualidad?', ai_generated: false, status: 'received', created_at: hace(200) },
            ],
            error: null,
        },
        school_tournament_items: {
            data: [{ id: CLINICA, name: 'Clínica de armadores y atacantes', kind: 'clase_extra', price: 300000, active: true, event_id: null, ends_at: '2099-01-01T00:00:00Z' }],
            error: null,
        },
    };
});

const pedir = (p: string) => fetch(`${base}${p}`, { headers: { authorization: 'Bearer token' } });

describe('autorización', () => {
    it('alguien que no administra la escuela: 403 y no se lee nada', async () => {
        est.usuario = 'coach-1';
        expect((await pedir(`/${ESCUELA}/seguimiento`)).status).toBe(403);
        expect(est.consultas).toEqual([]);
    });
    it('id inválido: 400 antes de preguntar nada', async () => {
        expect((await pedir('/no-es-uuid/seguimiento')).status).toBe(400);
        expect(est.consultas).toEqual([]);
    });
    it('admin de plataforma: entra', async () => {
        est.usuario = 'plataforma';
        expect((await pedir(`/${ESCUELA}/seguimiento`)).status).toBe(200);
    });
});

describe('GET seguimiento', () => {
    it('rango por defecto de 14 días; filas, resumen y servicios', async () => {
        const r = await pedir(`/${ESCUELA}/seguimiento`);
        expect(r.status).toBe(200);
        const j = await r.json();
        const dias = (Date.parse(j.rango.hasta) - Date.parse(j.rango.desde)) / 86_400_000 + 1;
        expect(dias).toBe(14);
        expect(j.filas).toHaveLength(2);
        expect(j.resumen).toMatchObject({ escribieron: 2, respondioBot: 1, respondioEscuela: 0, sinResponder: 1 });
        expect(j.servicios).toEqual([{ id: CLINICA, nombre: 'Clínica de armadores y atacantes' }]);
        const c1 = j.filas.find((f: any) => f.conversacionId === 'c-1');
        expect(c1.tema).toMatchObject({ tipo: 'servicio', servicioId: CLINICA });
        const c2 = j.filas.find((f: any) => f.conversacionId === 'c-2');
        expect(c2.esperandoMin).toBeGreaterThanOrEqual(199);
        expect(c2.alerta).toBe(true);
    });

    it('lectura mínima: una consulta por tabla, escuela + rango, columnas contadas, sin payload crudo, con tope', async () => {
        await pedir(`/${ESCUELA}/seguimiento?desde=2026-11-01&hasta=2026-11-07`);
        const por = (t: string) => est.consultas.filter((c) => c.tabla === t);
        expect(por('whatsapp_conversations')).toHaveLength(1);
        expect(por('whatsapp_messages')).toHaveLength(1);
        expect(por('payments')).toHaveLength(1);
        expect(por('whatsapp_inbound_queue')).toHaveLength(1);
        expect(por('school_signup_leads')).toHaveLength(1);
        const op = (t: string, nombre: string) => por(t)[0].ops.filter(([o]) => o === nombre).map(([, a]) => a);

        expect(op('whatsapp_conversations', 'eq')).toContainEqual(['school_id', ESCUELA]);
        expect(op('whatsapp_conversations', 'gte')).toContainEqual(['last_message_at', '2026-11-01T05:00:00.000Z']);
        expect(op('whatsapp_conversations', 'limit')[0][0]).toBeLessThanOrEqual(1000);

        const selMsg = String(op('whatsapp_messages', 'select')[0][0]);
        expect(selMsg).not.toMatch(/(^|,\s*)payload(\s*,|$)/);      // nunca el payload crudo de Meta
        expect(selMsg).toContain('pendiente_escuela:payload->>pendiente_escuela');
        expect(selMsg).toContain('venta_servicio_id:payload->>venta_servicio_id');
        expect(op('whatsapp_messages', 'in')[0]).toEqual(['conversation_id', ['c-1', 'c-2']]);
        expect(op('whatsapp_messages', 'gte')).toContainEqual(['created_at', '2026-11-01T05:00:00.000Z']);
        expect(op('whatsapp_messages', 'lte')).toContainEqual(['created_at', '2026-11-08T04:59:59.999Z']);
        expect(op('whatsapp_messages', 'range')[0]).toEqual([0, 999]);

        expect(op('payments', 'eq')).toContainEqual(['school_id', ESCUELA]);
        expect(op('payments', 'limit')[0][0]).toBeLessThanOrEqual(1000);
        expect(op('whatsapp_inbound_queue', 'eq')).toContainEqual(['school_id', ESCUELA]);
        expect(op('whatsapp_inbound_queue', 'in')).toContainEqual(['message_type', ['image', 'document']]);
    });

    it('el cobro se cruza por el comprobante de la cola (id del pago en el `or`)', async () => {
        const pago = '9a0c8f8e-1111-4222-8333-444455556666';
        est.tablas.whatsapp_inbound_queue = {
            data: [{ wa_phone_number: '573124567890', message_type: 'image', status: 'done', result_type: 'payment_receipt', result_ref_id: pago, created_at: hace(100) }],
            error: null,
        };
        est.tablas.payments = {
            data: [{ id: pago, amount: 300000, status: 'awaiting_approval', payment_category: 'clase_extra', concept: 'Clínica', signup_lead_id: null, created_at: hace(99) }],
            error: null,
        };
        const j = await (await pedir(`/${ESCUELA}/seguimiento`)).json();
        const or = est.consultas.find((c) => c.tabla === 'payments')!.ops.find(([o]) => o === 'or')![1][0];
        expect(or).toContain(`id.in.(${pago})`);
        const c1 = j.filas.find((f: any) => f.conversacionId === 'c-1');
        expect(c1.comprobanteRecibido).toBe(true);
        expect(c1.cobro).toMatchObject({ monto: 300000, estado: 'awaiting_approval' });
        expect(j.resumen).toMatchObject({ conComprobante: 1, conCobro: 1 });
    });

    it('filtros: servicio y solo sin responder (los contadores siguen contando todo el servicio)', async () => {
        const porServicio = await (await pedir(`/${ESCUELA}/seguimiento?servicio=${CLINICA}`)).json();
        expect(porServicio.filas.map((f: any) => f.conversacionId)).toEqual(['c-1']);
        const sinResp = await (await pedir(`/${ESCUELA}/seguimiento?soloSinResponder=1`)).json();
        expect(sinResp.filas.map((f: any) => f.conversacionId)).toEqual(['c-2']);
        expect(sinResp.resumen.escribieron).toBe(2);
    });

    it('parámetros inválidos: 400', async () => {
        expect((await pedir(`/${ESCUELA}/seguimiento?desde=2026-09-01&hasta=2026-11-07`)).status).toBe(400);
        expect((await pedir(`/${ESCUELA}/seguimiento?desde=ayer`)).status).toBe(400);
        expect((await pedir(`/${ESCUELA}/seguimiento?servicio=cualquiera`)).status).toBe(400);
        expect(est.consultas).toEqual([]);
    });

    it('formato=csv: archivo para Excel', async () => {
        const r = await pedir(`/${ESCUELA}/seguimiento?formato=csv&desde=2026-11-01&hasta=2026-11-07`);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('text/csv');
        expect(r.headers.get('content-disposition')).toContain('seguimiento-whatsapp-2026-11-01-a-2026-11-07.csv');
        // ignoreBOM: que el decodificador NO se coma el BOM (es lo que se está probando).
        const cuerpo = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer());
        expect(cuerpo.charCodeAt(0)).toBe(0xfeff);
        expect(cuerpo).toContain('Contacto;Teléfono;');
    });

    it('si una consulta falla: 500 sin detalles internos', async () => {
        est.tablas.whatsapp_conversations = { data: null, error: { message: 'timeout' } };
        const r = await pedir(`/${ESCUELA}/seguimiento`);
        expect(r.status).toBe(500);
        expect((await r.json()).error).toBe('No se pudo cargar el seguimiento de conversaciones');
    });
});
