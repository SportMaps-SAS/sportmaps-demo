/**
 * Caso real — Monster's Volley, hilo ...3060 (María José Zabala), 18-nov-2026.
 *   09:55 comprobante de $120.000 (valor de AFILIADO de «2 semanas» del Vacacional Suba) → la cola lo escaló a «Por clasificar»
 *         (`venta_…`, «asiste: sin nombre»).
 *   09:59 texto con el nombre, la fecha de nacimiento y «2 semanas del vacacional» + fechas → no recibió respuesta y no se unió
 *         al comprobante.
 * AHORA: los datos se adjuntan a la fila escalada (pregunta_ocr.datos_tardios + línea en el motivo) y se acusa recibo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    filas: [] as any[], updates: [] as { tabla: string; valores: any; id: any }[], errorUpdate: null as any, lecturas: [] as string[],
}));

vi.mock('../config/supabase', () => {
    const consulta = (tabla: string) => {
        const f: Record<string, any> = {};
        const q: any = {
            select: () => q, eq: (c: string, v: any) => { f[c] = v; return q; }, gte: () => q, not: () => q, in: () => q,
            order: () => q, limit: () => q,
            maybeSingle: async () => ({ data: null, error: null }),
            update: (valores: any) => ({
                eq: (_c: string, id: any) => ({
                    eq: async () => { h.updates.push({ tabla, valores, id }); return { error: h.errorUpdate }; },
                }),
            }),
            then: (ok: any) => {
                h.lecturas.push(`${tabla}:${f.status ?? ''}:${f.result_type ?? ''}`);
                const data = tabla === 'whatsapp_inbound_queue'
                    ? h.filas.filter((r) => r.status === f.status && r.result_type === f.result_type)
                    : [];
                return Promise.resolve({ data, error: null }).then(ok);
            },
        };
        return q;
    };
    return { supabase: { from: consulta } };
});

import { registrarNombreTardio, textoNombreTardioGuardado } from './wa-nombre-tardio.service';

const AHORA = new Date('2026-11-18T09:59:30-05:00').getTime();
const TEXTO = 'María José Zabala Pérez\nNacimiento: 14/03/2015\n2 semanas del vacacional\ndel 23 al 27 de noviembre y del 30 de noviembre al 4 de diciembre';
const MOTIVO = 'venta_monto_no_cuadra: comprobante de $120.000 para Vacacional de voleibol — Sede Suba | Propuesta → pagó: Zabala · asiste: sin nombre · falta: nombre completo, fecha de nacimiento · revisar';
const args = (texto = TEXTO) => ({ integrationId: 'int-1', schoolId: 'sch-1', contactWaId: '573000003060', texto, ahora: AHORA });

beforeEach(() => {
    h.updates.length = 0; h.lecturas.length = 0; h.errorUpdate = null;
    h.filas = [{ id: 'q-escalada', status: 'ignored', result_type: 'escalated', error_message: MOTIVO,
        pregunta_ocr: { huellas: ['abc'] }, created_at: '2026-11-18T09:55:10-05:00' }];
});

describe('datos que llegan después de un comprobante de venta escalado', () => {
    it('los adjunta a la fila escalada, sin perder las huellas, y devuelve qué acusar', async () => {
        const g = await registrarNombreTardio(args());
        expect(g).toMatchObject({ nombre: 'María José Zabala Pérez', aComprobanteEscalado: true });
        expect(h.updates).toHaveLength(1);
        const u = h.updates[0];
        expect(u).toMatchObject({ tabla: 'whatsapp_inbound_queue', id: 'q-escalada' });
        expect(u.valores.pregunta_ocr.huellas).toEqual(['abc']);
        expect(u.valores.pregunta_ocr.datos_tardios).toMatchObject({ nombre: 'María José Zabala Pérez', fecha_nacimiento: '2015-03-14' });
        expect(u.valores.pregunta_ocr.datos_tardios.texto).toContain('2 semanas del vacacional');
        expect(u.valores.error_message.startsWith(MOTIVO)).toBe(true);
        expect(u.valores.error_message).toContain('Datos que llegaron después del comprobante');
        expect(u.valores.error_message).toContain('María José Zabala Pérez');
        expect(u.valores.error_message).toContain('2 semanas del vacacional');
        // No se toca nada del cobro: solo se escribe en la cola.
        expect(h.updates.every((x) => x.tabla === 'whatsapp_inbound_queue')).toBe(true);
    });

    it('acusa recibo con el nombre y dice que la escuela confirma el cupo', async () => {
        const g = await registrarNombreTardio(args());
        const t = textoNombreTardioGuardado(g!);
        expect(t).toContain('Recibí los datos de *María José Zabala Pérez*');
        expect(t).toContain('la escuela');
        expect(t).toContain('confirma el cupo');
    });

    it('si no se pudo guardar NO promete nada', async () => {
        h.errorUpdate = { message: 'boom' };
        expect(await registrarNombreTardio(args())).toBeNull();
    });

    it('sin comprobante escalado reciente de venta no hace nada', async () => {
        h.filas = [{ ...h.filas[0], error_message: 'comprobante_ilegible: foto borrosa' }];
        expect(await registrarNombreTardio(args())).toBeNull();
        h.filas = [];
        expect(await registrarNombreTardio(args())).toBeNull();
        expect(h.updates).toHaveLength(0);
    });

    it('el mismo texto reenviado no se duplica ni se vuelve a acusar', async () => {
        const primera = await registrarNombreTardio(args());
        expect(primera).not.toBeNull();
        h.filas = [{ ...h.filas[0], pregunta_ocr: h.updates[0].valores.pregunta_ocr, error_message: h.updates[0].valores.error_message }];
        h.updates.length = 0;
        expect(await registrarNombreTardio(args())).toBeNull();
        expect(h.updates).toHaveLength(0);
    });

    it('un texto que no es un nombre no lee la cola ni escribe', async () => {
        expect(await registrarNombreTardio(args('gracias'))).toBeNull();
        expect(h.updates).toHaveLength(0);
    });
});
