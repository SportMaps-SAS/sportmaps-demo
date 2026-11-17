/**
 * Cableado de dos piezas sueltas en el bot (2026-11-16):
 *  1. el reclamo tras el resultado («Este fue octubre») también lo atienden el desconocido y el no identificado;
 *  2. `anotarOpcion` de la venta guarda la opción y las fechas en la ficha del prospecto, con merge.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
    reclamo: vi.fn(async (..._a: any[]) => true),
    identificada: false,
    lead: null as any,
    updates: [] as any[],
    updateError: null as any,
}));

vi.mock('../config/supabase', () => {
    const builder = (table: string) => {
        const resolve = () => {
            if (table === 'whatsapp_conversations') {
                return { data: { id: 'conv-1', parent_id: h.identificada ? 'p-1' : null, identified: h.identificada, status: 'open' }, error: null };
            }
            if (table === 'whatsapp_settings') return { data: { ai_enabled: true, mode: 'auto' }, error: null };
            return { data: null, error: null, count: 0 };
        };
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'or', 'order', 'limit', 'is', 'not', 'neq', 'filter', 'contains', 'ilike', 'insert', 'upsert']) b[m] = () => b;
        b.update = (v: any) => {
            if (table === 'school_signup_leads') h.updates.push(v);
            return { eq: () => Promise.resolve({ error: h.updateError }) };
        };
        b.maybeSingle = () => Promise.resolve(resolve());
        b.single = () => Promise.resolve(resolve());
        b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej);
        return b;
    };
    return { supabase: { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } };
});
vi.mock('./whatsapp-atencion.service', async () => {
    const real = await vi.importActual<typeof import('./whatsapp-atencion.service')>('./whatsapp-atencion.service');
    return { ...real, botEncendido: vi.fn(async () => true), debeAtender: vi.fn() };
});
vi.mock('./wa-cobro-desde-comprobante.service', async () => {
    const real = await vi.importActual<typeof import('./wa-cobro-desde-comprobante.service')>('./wa-cobro-desde-comprobante.service');
    return { ...real, leadDeVenta: vi.fn(async () => h.lead) };
});
vi.mock('./llm.service', () => ({ chatWithTools: vi.fn() }));
vi.mock('./whatsapp.service', () => ({
    sendTextMessage: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.txt' })),
    sendInteractiveButtons: vi.fn(async () => ({ ok: true, waMessageId: 'wamid.btn' })),
    aFormatoWhatsApp: (t: string) => t,
    markAsRead: vi.fn(),
}));
vi.mock('./whatsapp-optin.service', () => ({ estaDadoDeBaja: vi.fn(async () => false), AVISO_DADO_DE_BAJA: '' }));
vi.mock('./whatsapp-respuesta-de-cobro.service', () => ({
    resolverRespuestaDeCobro: vi.fn(async () => false),
    resolverReclamoDeResultado: (...a: any[]) => h.reclamo(...a),
}));
vi.mock('../utils/emailClient', () => ({ emailClient: { send: vi.fn() } }));
vi.mock('./push.service', () => ({ sendToUser: vi.fn() }));
vi.mock('./whatsapp-queue.service', () => ({ encolarAdjunto: vi.fn() }));
vi.mock('./whatsapp-prospecto-lead.service', () => ({ registrarLeadDeProspecto: vi.fn(async () => {}) }));

import { runBotTurn, atenderDesconocido, simularEnvios, guardarOpcionDeVenta } from './whatsapp-bot.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;

beforeEach(() => {
    h.reclamo.mockClear();
    h.reclamo.mockImplementation(async () => true);
    h.identificada = false;
    h.lead = null;
    h.updates = [];
    h.updateError = null;
});

describe('reclamo tras el resultado: contacto no identificado', () => {
    it('desconocido: «Este fue octubre» consume el turno y se le pasan los helpers del bot', async () => {
        const { resultado } = await simularEnvios(() =>
            atenderDesconocido(INTEGRATION, 'conv-1', '573001112233', 'Este fue octubre'));
        expect(resultado).toBe('pregunta_de_comprobante');
        expect(h.reclamo).toHaveBeenCalledTimes(1);
        const a = h.reclamo.mock.calls[0];
        expect(a[2]).toBe('Este fue octubre');
        expect(typeof a[3]).toBe('function');
        expect(typeof a[4]).toBe('function');
    });

    it('desconocido: si no es un reclamo (false), el turno sigue su camino normal', async () => {
        h.reclamo.mockImplementation(async () => false);
        const { resultado } = await simularEnvios(() =>
            atenderDesconocido(INTEGRATION, 'conv-1', '573001112233', 'Este fue octubre'));
        expect(h.reclamo).toHaveBeenCalledTimes(1);
        expect(resultado).not.toBe('pregunta_de_comprobante');
    });

    it('desconocido por audio o con botón: no se mira (mueve plata y solo ve texto)', async () => {
        await simularEnvios(() => atenderDesconocido(INTEGRATION, 'conv-1', '573001112233', 'Este fue octubre', null, null, 'audio'));
        await simularEnvios(() => atenderDesconocido(INTEGRATION, 'conv-1', '573001112233', 'Este fue octubre', 'btn-x'));
        expect(h.reclamo).not.toHaveBeenCalled();
    });

    it('no identificado en runBotTurn: el reclamo se atiende ANTES de la identificación (sin OTP)', async () => {
        const { salidas } = await simularEnvios(() =>
            runBotTurn(INTEGRATION, 'conv-1', '573001112233', 'Ahí dice compra exitosa', 'wamid.a', false, null, { origen: 'texto' }));
        expect(h.reclamo).toHaveBeenCalledTimes(1);
        expect(salidas).toEqual([]);
    });

    it('identificado: no pasa por acá (lo ve la cola con la respuesta de cobro)', async () => {
        h.identificada = true;
        await simularEnvios(() =>
            runBotTurn(INTEGRATION, 'conv-1', '573001112233', 'Ahí dice compra exitosa', 'wamid.a', false, null, { origen: 'texto' }));
        expect(h.reclamo).not.toHaveBeenCalled();
    });

    it('si el resolver lanza (módulo roto), el bot sigue y no se cae', async () => {
        h.reclamo.mockImplementation(async () => { throw new Error('boom'); });
        const { resultado } = await simularEnvios(() =>
            atenderDesconocido(INTEGRATION, 'conv-1', '573001112233', 'Este fue octubre'));
        expect(resultado).not.toBe('pregunta_de_comprobante');
    });
});

describe('anotarOpcion: la opción elegida y las fechas quedan en la ficha', () => {
    const opcion = { clave: '2s', etiqueta: '2 semanas', fechas: '8 al 19 de diciembre' };
    const item = { id: 'item-vac' };

    it('guarda opcion, opcion_etiqueta y fechas sin pisar el resto de source_detail', async () => {
        h.lead = { id: 'lead-1', sourceDetail: { campana: 'vacacional', asistente_servicio: { nombre: 'Sofía', servicio_id: 'item-vac' } } };
        expect(await guardarOpcionDeVenta('school-1', '573001112233', opcion, item)).toBe(true);
        expect(h.updates).toHaveLength(1);
        const sd = h.updates[0].source_detail;
        expect(sd.campana).toBe('vacacional');
        expect(sd.asistente_servicio).toMatchObject({
            nombre: 'Sofía', servicio_id: 'item-vac', opcion: '2s', opcion_etiqueta: '2 semanas', fechas: '8 al 19 de diciembre',
        });
    });

    it('sin fechas nuevas conserva las ya dichas', async () => {
        h.lead = { id: 'lead-1', sourceDetail: { asistente_servicio: { fechas: '1 al 5 de diciembre' } } };
        await guardarOpcionDeVenta('school-1', '573001112233', { ...opcion, fechas: null }, item);
        expect(h.updates[0].source_detail.asistente_servicio.fechas).toBe('1 al 5 de diciembre');
    });

    it('sin ficha del prospecto: false y no escribe nada (la venta no dice que anotó)', async () => {
        h.lead = null;
        expect(await guardarOpcionDeVenta('school-1', '573001112233', opcion, item)).toBe(false);
        expect(h.updates).toHaveLength(0);
    });

    it('la base responde error: false', async () => {
        h.lead = { id: 'lead-1', sourceDetail: {} };
        h.updateError = { message: 'rls' };
        expect(await guardarOpcionDeVenta('school-1', '573001112233', opcion, item)).toBe(false);
    });
});

describe('«ACTIVAR» tras una campaña: el filtro de la campaña NO se lo come', () => {
    it.each([
        { type: 'text', textBody: 'ACTIVAR', botonId: null },
        { type: 'text', textBody: 'Activar', botonId: null },
        { type: 'text', textBody: '*ACTIVAR*', botonId: null },
        { type: 'interactive', textBody: 'Activar', botonId: 'activar' },
    ])('no es respuesta de campaña: %j', async (msg) => {
        const { esPosibleRespuestaDeCampana } = await import('./whatsapp-campana-respuesta.service');
        expect(esPosibleRespuestaDeCampana(msg as any)).toBe(false);
    });
});
