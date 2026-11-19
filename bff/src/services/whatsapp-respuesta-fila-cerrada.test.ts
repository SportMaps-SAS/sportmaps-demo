/**
 * A-1 (revisión 2026-11-18): una fila `waiting_user` que pasó a «Por clasificar» (`error_message` con
 * `cerrado_escuela:`) ya no espera a la familia. La promoción de la siguiente pregunta no la cuenta como abierta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { filas: [] as any[], updates: [] as any[] };

vi.mock('../config/supabase', () => {
    const chain: any = {
        select: () => chain, eq: () => chain, is: () => chain, order: () => chain, limit: () => chain, gte: () => chain,
        update: (v: any) => { state.updates.push(v); return chain; },
        maybeSingle: () => Promise.resolve({ data: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: state.filas }).then(res, rej),
    };
    return { supabase: { from: () => chain, rpc: vi.fn() } };
});
vi.mock('../jobs/whatsapp-queue.job', () => ({ aplicarComprobante: vi.fn(), aplicarComprobanteConMotivo: vi.fn() }));
vi.mock('./whatsapp-comprobante-de-ficha.service', () => ({
    resolverRespuestaDeDeportista: vi.fn(), resolverRespuestaDeAsistente: vi.fn(), botonesDeCobros: vi.fn(),
}));

import { promoverSiguientePregunta } from './whatsapp-respuesta-de-cobro.service';

const enFila = (extra: Record<string, unknown> = {}) => ({
    id: 'q2', pregunta_at: null, created_at: new Date().toISOString(),
    pregunta_ocr: { en_fila: { texto: 'hola', paso: 'p', monto: 1000 }, ocr: { amount: 1000 } }, ...extra,
});

describe('promoverSiguientePregunta ignora las filas cerradas por la escuela', () => {
    beforeEach(() => { state.filas = []; state.updates = []; });

    it('una fila cerrada con pregunta reciente NO bloquea la promoción ni se promueve ella misma', async () => {
        const responder = vi.fn();
        state.filas = [{
            id: 'q1', pregunta_at: new Date().toISOString(), created_at: new Date().toISOString(),
            error_message: 'cerrado_escuela: resuelto_auto — pasó a «Por clasificar» en Cobros | sin_familia: x', pregunta_ocr: {},
        }];
        // Sin otra fila en fila: nada que promover, y no lanza.
        expect(await promoverSiguientePregunta('i1', '573001', responder)).toBe(false);
        expect(responder).not.toHaveBeenCalled();
    });

    it('una fila en fila que ya está cerrada por la escuela no se promueve (no se le pregunta nada a la familia)', async () => {
        const responder = vi.fn();
        state.filas = [enFila({ error_message: 'cerrado_escuela: resuelto_auto — pasó a «Por clasificar» en Cobros | x' })];
        expect(await promoverSiguientePregunta('i1', '573001', responder)).toBe(false);
        expect(state.updates).toHaveLength(0);
        expect(responder).not.toHaveBeenCalled();
    });
});
