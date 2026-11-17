/**
 * La respuesta de la familia a la cola de comprobantes — auditoría de producción 1–16 nov 2026.
 *
 *  R10  Pregunta abierta que atrapa mensajes ajenos: 16 h después la clienta le hablaba a la dueña de otra cosa y
 *       recibió dos veces «no te entendí a cuál cobro va».
 *  R11  Reclamo o corrección tras el resultado: «Este fue octubre», «Ahora estoy pagando noviembre», «Ahí dice
 *       estado exitoso», «No has revisado este pago del domingo» (5 conversaciones; la fila seguía «resuelta»).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        /** La fila `waiting_user` del contacto (null = no hay pregunta abierta). */
        fila: null as any,
        /** Filas ya cerradas del contacto, por id (las que cita el último resultado). */
        cerradas: [] as any[],
        /** Salientes de la conversación (el resultado que la cola le dio). */
        salientes: [] as any[],
        updates: [] as { table: string; row: any; ids: string[] }[],
    };
    function builder(table: string) {
        const ops: [string, any[]][] = [];
        const b: any = {};
        for (const m of ['select', 'eq', 'in', 'gt', 'gte', 'lt', 'order', 'limit', 'is', 'not', 'or']) {
            b[m] = (...a: any[]) => { ops.push([m, a]); return b; };
        }
        b.update = (row: any) => { ops.push(['update', [row]]); return b; };
        const idsDe = () => {
            const en = ops.find(([m, a]) => m === 'in' && a[0] === 'id');
            const eq = ops.find(([m, a]) => m === 'eq' && a[0] === 'id');
            return en ? (en[1][1] as string[]) : eq ? [eq[1][1] as string] : [];
        };
        const resolver = () => {
            const update = ops.find(([m]) => m === 'update');
            if (update) {
                const ids = idsDe();
                state.updates.push({ table, row: update[1][0], ids });
                if (table === 'whatsapp_inbound_queue') {
                    if (state.fila && ids.includes(state.fila.id)) state.fila = { ...state.fila, ...update[1][0] };
                    state.cerradas = state.cerradas.map((f) => (ids.includes(f.id) ? { ...f, ...update[1][0] } : f));
                }
                return { data: null, error: null };
            }
            if (table === 'whatsapp_inbound_queue') {
                if (ops.some(([m, a]) => m === 'in' && a[0] === 'id')) {
                    const ids = idsDe();
                    return { data: state.cerradas.filter((f) => ids.includes(f.id)), error: null };
                }
                const f = state.fila && state.fila.status === 'waiting_user' ? { ...state.fila } : null;
                return { data: f, error: null };
            }
            if (table === 'whatsapp_conversations') return { data: { id: 'conv-1' }, error: null };
            if (table === 'whatsapp_messages') {
                // Los salientes HUMANOS (¿la escuela tomó la conversación?): ninguno en estos casos.
                if (ops.some(([m, a]) => m === 'eq' && a[0] === 'ai_generated' && a[1] === false)) return { data: [], error: null };
                return { data: state.salientes, error: null };
            }
            return { data: null, error: null };
        };
        b.maybeSingle = () => Promise.resolve(resolver());
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve(resolver()).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: { from: (t: string) => builder(t), rpc: vi.fn(async () => ({ data: null, error: null })) },
        aplicarComprobante: vi.fn(async () => undefined),
        resolverDeportistaDeLaFila: vi.fn(async () => undefined),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('../jobs/whatsapp-queue.job', () => ({
    aplicarComprobante: h.aplicarComprobante,
    aplicarComprobanteDeFicha: vi.fn(),
    aplicarComprobanteConMotivo: vi.fn(),
    resolverDeportistaDeLaFila: h.resolverDeportistaDeLaFila,
}));
vi.mock('./wa-nombre-tardio.service', () => ({
    registrarNombreTardio: vi.fn(async () => null),
    textoNombreTardioGuardado: vi.fn(() => ''),
}));

import { resolverRespuestaDeCobro, esCorreccionDeResultado } from './whatsapp-respuesta-de-cobro.service';
import { clasificarFila } from './whatsapp-bandeja.service';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';

const SEP: PagoPendiente = { id: 'p-sep', amount: 180000, concept: 'Mensualidad 09/2026 - Martina Ruiz', due_date: '2026-09-05', child_id: 'c-1', atleta: 'Martina Ruiz' };
const OCT: PagoPendiente = { id: 'p-oct', amount: 180000, concept: 'Mensualidad 10/2026 - Martina Ruiz', due_date: '2026-10-05', child_id: 'c-1', atleta: 'Martina Ruiz' };
const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;

let salidas: { texto: string; paso: string }[];
let pases: { resumen: string; mensajeFamilia: string | null }[];
const responder = async (texto: string, paso: string) => { salidas.push({ texto, paso }); };
const pasar = async (p: { resumen: string; mensajeFamilia: string | null }) => { pases.push(p); };
const contestar = (texto: string) => resolverRespuestaDeCobro(INTEGRATION, '573001112233', texto, responder, pasar);
const haceMin = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
    vi.clearAllMocks();
    salidas = [];
    pases = [];
    h.state.updates = [];
    h.state.cerradas = [];
    h.state.salientes = [];
    h.state.fila = null;
});

// ─── R10 ─────────────────────────────────────────────────────────────────────

describe('R10 · pregunta abierta que atrapa mensajes ajenos', () => {
    const preguntaHace = (minutos: number, extra: Record<string, unknown> = {}) => {
        h.state.fila = {
            id: 'q-1', status: 'waiting_user', school_id: 'school-1', retries: 0, pregunta_at: haceMin(minutos),
            pregunta_opciones: [SEP, OCT],
            pregunta_ocr: { ocr: { amount: 180000 }, sha: 'abc', storagePath: 'x/y.jpg', parentId: 'parent-1' },
            ...extra,
        };
    };

    it('16 h después, «Hola Milena, ¿el sábado hay entrenamiento?» NO se consume, NO repregunta y la fila sigue igual', async () => {
        preguntaHace(16 * 60);
        expect(await contestar('Hola Milena, ¿el sábado hay entrenamiento?')).toBe(false);
        expect(await contestar('Me confirmas la hora porfa')).toBe(false);
        expect(salidas).toHaveLength(0);
        expect(h.state.updates).toHaveLength(0);
        expect(h.state.fila).toMatchObject({ status: 'waiting_user', retries: 0 });
    });

    it('dentro de la primera hora, lo que no se entiende se repregunta (como siempre)', async () => {
        preguntaHace(20);
        expect(await contestar('Hola Milena, te cuento una cosa')).toBe(true);
        expect(salidas).toHaveLength(1);
        expect(salidas[0].paso).toBe('ask_cual_pago_reintento');
    });

    it('16 h después, una opción ofrecida («2», «el de octubre») sí cuenta y aplica', async () => {
        preguntaHace(16 * 60);
        expect(await contestar('el de octubre')).toBe(true);
        expect(h.aplicarComprobante).toHaveBeenCalledTimes(1);
        expect((h.aplicarComprobante.mock.calls[0] as any[])[1]).toMatchObject({ id: 'p-oct' });
    });

    it('16 h después, algo que habla del pago pero no elige («ya hice la transferencia») se atiende, no se ignora', async () => {
        preguntaHace(16 * 60);
        expect(await contestar('ya hice la transferencia ayer')).toBe(true);
        expect(salidas[0].paso).toBe('ask_cual_pago_reintento');
    });

    it('pregunta de mes (guiada): 5 h después un mensaje ajeno no se consume; «noviembre» sí', async () => {
        const guia = { opciones: [{ n: 1, etiqueta: 'Noviembre 2026', valor: { mes: 11, anio: 2026 } }, { n: 2, etiqueta: 'Otro mes', valor: 'otro' }],
            monto: 180000, deportista: { id: 'c-1', tipo: 'child', nombre: 'Martina Ruiz', cuota: 180000 } };
        preguntaHace(300, { pregunta_opciones: [], pregunta_ocr: { ocr: { amount: 180000 }, sha: 'a', storagePath: 'x', parentId: 'parent-1', tipo: 'mes', guia } });
        expect(await contestar('Buenas tardes profe, mañana no puede ir')).toBe(false);
        expect(salidas).toHaveLength(0);
        expect(await contestar('noviembre')).toBe(true);
        expect(h.state.fila.error_message).toMatch(/^sin_pendientes: Martina Ruiz no tiene cobro de noviembre 2026/);
    });

    it('«¿de qué deportista?»: 3 h después solo cuenta un nombre o algo del pago', async () => {
        preguntaHace(180, { pregunta_opciones: [], pregunta_ocr: { ocr: { amount: 180000 }, sha: 'a', storagePath: 'x', parentId: null, tipo: 'deportista' } });
        expect(await contestar('¿A qué hora abren mañana?')).toBe(false);
        expect(h.resolverDeportistaDeLaFila).not.toHaveBeenCalled();
        expect(await contestar('Sara Valentina Daza Gómez')).toBe(true);
        expect(h.resolverDeportistaDeLaFila).toHaveBeenCalledTimes(1);
    });
});

// ─── R11 ─────────────────────────────────────────────────────────────────────

describe('R11 · reclamo o corrección del cliente tras el resultado', () => {
    const resultado = (paso: string, texto: string, minutos: number, queueId = 'q-9') => {
        h.state.salientes = [{ payload: { step: paso, queue_id: queueId }, text_body: texto, created_at: haceMin(minutos) }];
    };

    it('tras «Listo: comprobante… para octubre», «El 3 de octubre hicimos pago de octubre. Ahora estoy pagando noviembre» → la fila pasa a ACCIÓN con su texto; el cobro no se toca', async () => {
        resultado('resultado_comprobante', 'Listo: comprobante de *$180.000* de *Martina* para *octubre*. La escuela lo confirma.', 3);
        h.state.cerradas = [{ id: 'q-9', status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-oct', error_message: null }];
        expect(await contestar('El 3 de octubre hicimos pago de octubre. Ahora estoy pagando noviembre')).toBe(true);

        const f = h.state.cerradas[0];
        expect(f).toMatchObject({ status: 'ignored', result_type: 'payment_receipt', result_ref_id: 'p-oct' });
        expect(f.error_message).toMatch(/^reclamo_del_cliente: la familia corrige el mes o el concepto \(dice noviembre\): «El 3 de octubre hicimos pago de octubre\. Ahora estoy pagando noviembre»/);
        expect(h.state.updates.every((u) => u.table === 'whatsapp_inbound_queue')).toBe(true);   // ningún UPDATE a payments
        expect(clasificarFila(f)).toMatchObject({ grupo: 'accion', motivo: 'reclamo_del_cliente' });
        // A la familia UNA respuesta, por el canal que escala a la escuela.
        expect(pases).toHaveLength(1);
        expect(pases[0].mensajeFamilia).toBe('Gracias por avisarme 🙏 Le paso tu mensaje a la escuela para que lo revise y te confirme por aquí.');
        expect(pases[0].resumen).toContain('Ahora estoy pagando noviembre');
    });

    it('«Este fue octubre» tras el mismo resultado → también queda en acción', async () => {
        resultado('resultado_comprobante', 'Listo: comprobante de *$180.000* de *Martina* para *noviembre*. La escuela lo confirma.', 5);
        h.state.cerradas = [{ id: 'q-9', status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-nov', error_message: null }];
        expect(await contestar('Este fue octubre')).toBe(true);
        expect(h.state.cerradas[0].error_message).toMatch(/^reclamo_del_cliente: la familia corrige el mes o el concepto \(dice octubre\)/);
    });

    it('tras «no es un comprobante de pago», «Ahí dice estado exitoso» → ACCIÓN (escalada), conservando lo que decía la fila', async () => {
        resultado('no_es_comprobante', 'Revisé el archivo que enviaste y *no es un comprobante de pago*.', 2);
        h.state.cerradas = [{ id: 'q-9', status: 'ignored', result_type: 'none', error_message: 'no es un comprobante' }];
        expect(await contestar('Ahí dice estado exitoso')).toBe(true);
        const f = h.state.cerradas[0];
        expect(f).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(f.error_message).toBe('reclamo_del_cliente: la familia insiste en que sí es un pago: «Ahí dice estado exitoso» (tras no_es_comprobante) | antes: no es un comprobante');
        expect(clasificarFila(f).grupo).toBe('accion');
    });

    it('«No has revisado este pago del domingo» → ACCIÓN', async () => {
        resultado('sin_pendientes', 'Recibí tu comprobante, pero ahora mismo no tienes cobros pendientes ✅', 10);
        h.state.cerradas = [{ id: 'q-9', status: 'ignored', result_type: 'none', error_message: 'sin pagos pendientes' }];
        expect(await contestar('No has revisado este pago del domingo')).toBe(true);
        expect(h.state.cerradas[0].error_message).toMatch(/^reclamo_del_cliente: la familia dice que su pago no se ha revisado/);
    });

    it('una ráfaga: el reclamo marca todas las filas del mensaje de resultado', async () => {
        h.state.salientes = [{ payload: { step: 'resultado_comprobante', queue_id: 'q-1', queue_ids: ['q-1', 'q-2'] },
            text_body: 'Recibí tus 2 comprobantes: … para *octubre*', created_at: haceMin(4) }];
        h.state.cerradas = [
            { id: 'q-1', status: 'done', result_type: 'payment_receipt', result_ref_id: 'p-1', error_message: null },
            { id: 'q-2', status: 'ignored', result_type: 'none', error_message: 'sin pagos pendientes' },
        ];
        expect(await contestar('No, uno es de noviembre y el otro es la mensualidad de octubre')).toBe(true);
        expect(h.state.cerradas.map((f) => f.status)).toEqual(['ignored', 'ignored']);
        expect(h.state.cerradas.map((f) => f.result_type)).toEqual(['payment_receipt', 'escalated']);
        // Dos grupos → dos UPDATE, no uno por fila.
        expect(h.state.updates).toHaveLength(2);
    });

    it('«Muchas gracias» o una pregunta de otra cosa NO es un reclamo: no lee la base ni consume el turno', async () => {
        resultado('resultado_comprobante', 'Listo: comprobante de *$180.000* de *Martina* para *octubre*. La escuela lo confirma.', 3);
        h.state.cerradas = [{ id: 'q-9', status: 'done', result_type: 'payment_receipt', error_message: null }];
        expect(await contestar('Muchas gracias')).toBe(false);
        expect(await contestar('¿El sábado hay clase?')).toBe(false);
        expect(h.state.updates).toHaveLength(0);
        expect(salidas).toHaveLength(0);
    });

    it('pasados 30 minutos del resultado ya no cuenta', async () => {
        h.state.salientes = [];   // la consulta solo trae salientes de los últimos 30 min
        h.state.cerradas = [{ id: 'q-9', status: 'done', result_type: 'payment_receipt', error_message: null }];
        expect(await contestar('Ahora estoy pagando noviembre')).toBe(false);
        expect(h.state.updates).toHaveLength(0);
    });

    it('una fila que la escuela ya cerró no se reabre', async () => {
        resultado('resultado_comprobante', 'Listo: comprobante de *$180.000* de *Martina* para *octubre*. La escuela lo confirma.', 3);
        h.state.cerradas = [{ id: 'q-9', status: 'ignored', result_type: 'escalated', error_message: 'cerrado_escuela: resuelto — ya está (por admin-a) | x' }];
        expect(await contestar('Ahora estoy pagando noviembre')).toBe(false);
        expect(h.state.updates).toHaveLength(0);
    });

    it('la función pura se exporta desde este módulo para quien atienda textos fuera de él', () => {
        expect(esCorreccionDeResultado('Ahí dice compra exitosa', { paso: 'no_es_comprobante', texto: 'no es un comprobante de pago', minutos: 1 }))
            .toEqual({ tipo: 'si_es_un_pago' });
    });
});

// ─── Monster 2026-11-17 (Liliana): un comprobante más nuevo no se contesta con la pregunta vieja ─────────────
describe('hayComprobanteMasNuevo', () => {
    it('sin created_at de la fila no consulta y no bloquea', async () => {
        const { hayComprobanteMasNuevo } = await import('./whatsapp-respuesta-de-cobro.service');
        expect(await hayComprobanteMasNuevo('i', '57300', { id: 'f1' })).toBe(false);
    });
    it('hay un archivo posterior del mismo contacto → true; ninguno → false', async () => {
        const { hayComprobanteMasNuevo } = await import('./whatsapp-respuesta-de-cobro.service');
        const original = h.supabase.from;
        const conFilas = (rows: any[]) => ({ from: () => { const b: any = {}; for (const m of ['select', 'eq', 'in', 'neq', 'gt', 'limit']) b[m] = () => b; b.then = (r: any) => Promise.resolve({ data: rows, error: null }).then(r); return b; } });
        try {
            (h.supabase as any).from = conFilas([{ id: 'nuevo' }]).from;
            expect(await hayComprobanteMasNuevo('i', '57300', { id: 'f1', created_at: '2026-11-15T19:02:00Z' })).toBe(true);
            (h.supabase as any).from = conFilas([]).from;
            expect(await hayComprobanteMasNuevo('i', '57300', { id: 'f1', created_at: '2026-11-15T19:02:00Z' })).toBe(false);
        } finally { (h.supabase as any).from = original; }
    });
    it('ante un error de la consulta se comporta como antes (false)', async () => {
        const { hayComprobanteMasNuevo } = await import('./whatsapp-respuesta-de-cobro.service');
        // el doble de supabase de este archivo no implementa `neq`: lanza y la función lo absorbe
        expect(await hayComprobanteMasNuevo('i', '57300', { id: 'f1', created_at: '2026-11-15T19:02:00Z' })).toBe(false);
    });
});
