/**
 * Plan B4 §3 (respuestas): la fila de preguntas, el resumen de motivos de una
 * ráfaga y la respuesta a «¿de qué es?» con un motivo que tiene precio. Contra
 * tablas en memoria con la forma de las reales.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const state = {
        tablas: {} as Record<string, any[]>,
        lecturas: [] as string[],
    };
    function builder(table: string) {
        const filtros: ((f: any) => boolean)[] = [];
        let orden: { col: string; asc: boolean; nullsFirst: boolean } | null = null;
        let update: any = null;
        const b: any = {};
        b.select = () => b;
        b.eq = (c: string, v: any) => { filtros.push((f) => f[c] === v); return b; };
        b.neq = (c: string, v: any) => { filtros.push((f) => f[c] !== v); return b; };
        b.is = (c: string, v: any) => { filtros.push((f) => (f[c] ?? null) === v); return b; };
        b.in = (c: string, vs: any[]) => { filtros.push((f) => vs.includes(f[c])); return b; };
        b.gte = (c: string, v: any) => { filtros.push((f) => f[c] != null && String(f[c]) >= String(v)); return b; };
        b.gt = b.gte;
        b.lt = () => b;
        b.limit = () => b;
        b.order = (col: string, o: any = {}) => { orden = { col, asc: o.ascending !== false, nullsFirst: o.nullsFirst === true }; return b; };
        b.update = (v: any) => { update = v; return b; };
        const correr = () => {
            if (!update) state.lecturas.push(table);
            let filas = (state.tablas[table] ?? []).filter((f) => filtros.every((p) => p(f)));
            if (update) {
                for (const f of filas) Object.assign(f, update);
                return { data: filas.map((f) => ({ id: f.id })), error: null };
            }
            if (orden) {
                const { col, asc, nullsFirst } = orden;
                filas = [...filas].sort((x, y) => {
                    const a = x[col] ?? null; const z = y[col] ?? null;
                    if (a === null && z === null) return 0;
                    if (a === null) return nullsFirst ? -1 : 1;
                    if (z === null) return nullsFirst ? 1 : -1;
                    return (String(a) < String(z) ? -1 : String(a) > String(z) ? 1 : 0) * (asc ? 1 : -1);
                });
            }
            return { data: filas, error: null };
        };
        b.maybeSingle = () => { const r = correr(); return Promise.resolve({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }); };
        b.single = b.maybeSingle;
        b.then = (res: any, rej: any) => Promise.resolve(correr()).then(res, rej);
        return b;
    }
    return {
        state,
        supabase: { from: (t: string) => builder(t), rpc: vi.fn(async () => ({ data: null, error: null })) },
        aplicarComprobante: vi.fn(async () => ({ ok: true })),
        aplicarComprobanteConMotivo: vi.fn(async () => undefined),
    };
});

vi.mock('../config/supabase', () => ({ supabase: h.supabase }));
vi.mock('../jobs/whatsapp-queue.job', () => ({
    aplicarComprobante: h.aplicarComprobante,
    aplicarComprobanteDeFicha: vi.fn(),
    aplicarComprobanteConMotivo: h.aplicarComprobanteConMotivo,
}));

import {
    resolverRespuestaDeCobro, promoverSiguientePregunta, textoSigueEnFila, botonDeResumen, hayResumenDeMotivosAbierto,
} from './whatsapp-respuesta-de-cobro.service';

const INTEGRATION = { id: 'int-1', school_id: 'school-1' } as any;
const TEL = '573001112233';
const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

type Salida = { texto: string; paso: string; botones?: any[] };
let salidas: Salida[];
let pases: { resumen: string; mensajeFamilia: string | null }[];
const responder = async (texto: string, paso: string, botones?: any[]) => { salidas.push({ texto, paso, botones }); };
const pasar = async (p: { resumen: string; mensajeFamilia: string | null }) => { pases.push(p); };
const contestar = (texto: string) => resolverRespuestaDeCobro(INTEGRATION, TEL, texto, responder, pasar);

const BOTONES_MES = [
    { id: 'sm_cobro_1', title: '1. Octubre 2026' }, { id: 'sm_cobro_2', title: '2. Septiembre 2026' },
    { id: 'sm_cobro_3', title: '3. Agosto 2026' }, { id: 'sm_cobro_4', title: '4. Otro mes' },
];
const OPCIONES_MES = [
    { n: 1, etiqueta: 'Octubre 2026', valor: { mes: 10, anio: 2026 } },
    { n: 2, etiqueta: 'Septiembre 2026', valor: { mes: 9, anio: 2026 } },
    { n: 3, etiqueta: 'Agosto 2026', valor: { mes: 8, anio: 2026 } },
    { n: 4, etiqueta: 'Otro mes', valor: 'otro' },
];
const filaMes = (id: string, extra: Record<string, any> = {}) => ({
    id, integration_id: 'int-1', wa_phone_number: TEL, status: 'waiting_user', school_id: 'school-1', retries: 0,
    created_at: hace(30), pregunta_at: hace(5), pregunta_opciones: [],
    pregunta_ocr: {
        ocr: { amount: 150000 }, sha: `sha-${id}`, storagePath: `s/${id}.jpg`, parentId: 'parent-1', referencias: [],
        tipo: 'mes', guia: { opciones: OPCIONES_MES, monto: 150000, deportista: { id: 'c1', tipo: 'child', nombre: 'Laura Peña', cuota: 180000 } },
    },
    ...extra,
});
const enFila = (id: string, monto: number) => filaMes(id, {
    created_at: hace(29), pregunta_at: null,
    pregunta_ocr: {
        ...filaMes(id).pregunta_ocr, ocr: { amount: monto }, guia: { ...filaMes(id).pregunta_ocr.guia, monto },
        en_fila: { texto: `Recibí tu comprobante por *$${monto.toLocaleString('es-CO')}* de *Laura* 📄 ¿De qué mes es? Toca una opción.`, paso: 'ask_mes', botones: BOTONES_MES, monto },
    },
});

beforeEach(() => {
    vi.clearAllMocks();
    salidas = [];
    pases = [];
    h.state.lecturas = [];
    h.state.tablas = {
        whatsapp_inbound_queue: [],
        whatsapp_conversations: [{ id: 'conv-1', integration_id: 'int-1', contact_wa_id: TEL }],
        whatsapp_messages: [],
    };
});

describe('fila de preguntas: resuelta una, sale la siguiente', () => {
    it('contestó el mes de la primera → sale la que esperaba, con su monto y sus botones', async () => {
        h.state.tablas.whatsapp_inbound_queue = [filaMes('q1'), enFila('q2', 140000)];
        expect(await contestar('1')).toBe(true);
        const [cierre, sigue] = salidas;
        expect(cierre.paso).toBe('resultado_comprobante_guiado');
        expect(sigue).toEqual({
            texto: 'Sigue el comprobante de *$140.000*: ¿De qué mes es? Toca una opción.',
            paso: 'ask_mes',
            botones: BOTONES_MES,
        });
        const q2 = h.state.tablas.whatsapp_inbound_queue.find((f) => f.id === 'q2');
        expect(q2.pregunta_at).toEqual(expect.any(String));
        expect(q2.pregunta_ocr.en_fila).toBeUndefined();
        expect(q2.pregunta_ocr.guia.opciones).toHaveLength(4);
        // La que salió ahora es la que contesta el próximo «2».
        salidas = [];
        expect(await contestar('2')).toBe(true);
        expect(salidas[0].texto).toContain('*$140.000*');
    });

    it('si queda otra pregunta abierta, no se promueve nada', async () => {
        h.state.tablas.whatsapp_inbound_queue = [filaMes('q1'), filaMes('q0', { pregunta_at: hace(60) }), enFila('q2', 140000)];
        await contestar('1');
        expect(salidas).toHaveLength(1);
        expect(h.state.tablas.whatsapp_inbound_queue.find((f) => f.id === 'q2').pregunta_at).toBeNull();
    });

    it('si una persona de la escuela escribió desde que llegó, no sale (la conversación es suya)', async () => {
        h.state.tablas.whatsapp_inbound_queue = [enFila('q2', 140000)];
        h.state.tablas.whatsapp_messages = [{ conversation_id: 'conv-1', direction: 'outbound', ai_generated: false, type: 'text', text_body: 'Hola, ya lo reviso', created_at: hace(10), wa_timestamp: hace(10) }];
        expect(await promoverSiguientePregunta('int-1', TEL, responder)).toBe(false);
        expect(salidas).toHaveLength(0);
    });

    it('una pregunta en fila no se contesta como si hubiera salido', async () => {
        h.state.tablas.whatsapp_inbound_queue = [enFila('q2', 140000)];
        expect(await contestar('1')).toBe(false);
        expect(salidas).toHaveLength(0);
        expect(h.state.tablas.whatsapp_inbound_queue[0].status).toBe('waiting_user');
    });

    it('textoSigueEnFila (pura)', () => {
        expect(textoSigueEnFila({ texto: 'Recibí tu comprobante 📄 ¿De cuál deportista es? Toca el nombre.', monto: 15000 }))
            .toBe('Sigue el comprobante de *$15.000*: ¿De cuál deportista es? Toca el nombre.');
        expect(textoSigueEnFila({ texto: '¿A cuál?', monto: null })).toBe('Sigue el comprobante: ¿A cuál?');
    });
});

describe('resumen de motivos: [Sí, está bien] / [Cambiar un motivo]', () => {
    const resumen = (min = 2) => ({
        conversation_id: 'conv-1', direction: 'outbound', created_at: hace(min),
        payload: {
            step: 'resumen_motivos',
            lineas: [
                { monto: 310000, motivo: 'Inscripción', atleta: 'Mariana Ruiz', paymentId: 'pay-1', nuevo: true },
                { monto: 60000, motivo: 'Uniformes', atleta: 'Mariana Ruiz', paymentId: 'pay-2', nuevo: true },
            ],
        },
    });

    it('«Sí, está bien» → gracias, sin tocar nada más', async () => {
        h.state.tablas.whatsapp_messages = [resumen()];
        expect(await contestar('Sí, está bien')).toBe(true);
        expect(salidas).toEqual([{ texto: '¡Gracias! 🙌 Quedan así; la escuela los revisa y te confirma.', paso: 'resumen_motivos_ok', botones: undefined }]);
        expect(pases).toHaveLength(0);
    });

    it('«Cambiar un motivo» → a la escuela con las líneas (v1: corrige la escuela)', async () => {
        h.state.tablas.whatsapp_messages = [resumen()];
        expect(await contestar('Cambiar un motivo')).toBe(true);
        expect(pases).toHaveLength(1);
        expect(pases[0].resumen).toContain('cambiar_motivo:');
        expect(pases[0].resumen).toContain('$310.000 → Inscripción · Mariana Ruiz');
        expect(pases[0].resumen).toContain('$60.000 → Uniformes · Mariana Ruiz');
        expect(pases[0].mensajeFamilia).toContain('Le aviso a la escuela');
        expect(await hayResumenDeMotivosAbierto('int-1', TEL)).toBe(true);
    });

    it('si el último mensaje del bot NO es el resumen, el botón no hace nada especial', async () => {
        h.state.tablas.whatsapp_messages = [resumen(30), { conversation_id: 'conv-1', direction: 'outbound', created_at: hace(1), payload: { step: 'otro' } }];
        expect(await contestar('Sí, está bien')).toBe(false);
        expect(await hayResumenDeMotivosAbierto('int-1', TEL)).toBe(false);
    });

    it('un texto normal no lee whatsapp_messages (cero lecturas extra)', async () => {
        h.state.tablas.whatsapp_messages = [resumen()];
        expect(await contestar('hola, ¿a qué hora es el entreno?')).toBe(false);
        expect(h.state.lecturas).not.toContain('whatsapp_messages');
        expect(botonDeResumen('si, esta bien')).toBe('ok');
        expect(botonDeResumen('Cambiar un motivo')).toBe('cambiar');
        expect(botonDeResumen('sí')).toBeNull();
    });
});

describe('«¿de qué es?» con motivos que tienen precio (interruptor prendido)', () => {
    const filaConcepto = (monto: number) => filaMes('q1', {
        pregunta_ocr: {
            ocr: { amount: monto }, sha: 'sha', storagePath: 's/q1.jpg', parentId: 'parent-1', referencias: [], tipo: 'concepto',
            guia: {
                monto, deportista: { id: 'c1', tipo: 'child', nombre: 'Laura Peña', cuota: 180000 },
                opciones: [
                    { n: 1, etiqueta: 'Uniformes', valor: { motivo: 'articulos', fuente: 'merchandise_item', fuenteId: 'art-1', monto: 60000, etiqueta: 'Uniformes' } },
                    { n: 2, etiqueta: 'Inscripción', valor: { motivo: 'inscripcion', fuente: 'registration_fee', fuenteId: 'plan-1', monto: 310000, etiqueta: 'Inscripción' } },
                    { n: 3, etiqueta: 'Otro', valor: 'otro' },
                ],
            },
        },
    });

    it('eligió un motivo cuyo precio ES el monto → la cola crea el cobro y lo aplica', async () => {
        h.state.tablas.whatsapp_inbound_queue = [filaConcepto(60000)];
        expect(await contestar('1')).toBe(true);
        expect(h.aplicarComprobanteConMotivo).toHaveBeenCalledTimes(1);
        const [queueId, motivo] = h.aplicarComprobanteConMotivo.mock.calls[0] as any[];
        expect(queueId).toBe('q1');
        expect(motivo).toMatchObject({ motivo: 'articulos', fuenteId: 'art-1', monto: 60000 });
    });

    it('eligió un motivo cuyo precio NO es el monto → la bandeja de siempre, nombrándolo', async () => {
        h.state.tablas.whatsapp_inbound_queue = [filaConcepto(55000)];
        expect(await contestar('Uniformes')).toBe(true);
        expect(h.aplicarComprobanteConMotivo).not.toHaveBeenCalled();
        const fila = h.state.tablas.whatsapp_inbound_queue[0];
        expect(fila).toMatchObject({ status: 'ignored', result_type: 'escalated' });
        expect(fila.error_message).toMatch(/^otro_concepto: uniformes \(la familia lo eligió\)/);
        expect(salidas[0].paso).toBe('resultado_comprobante_guiado');
    });

    it('no entendió: repregunta sin prometer «mensualidad, inscripción u otro»', async () => {
        h.state.tablas.whatsapp_inbound_queue = [filaConcepto(55000)];
        await contestar('mmm no sé');
        expect(salidas[0].texto).toBe('No te entendí 🙏 Toca de qué es el comprobante.');
    });
});
