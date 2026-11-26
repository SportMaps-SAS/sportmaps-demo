/**
 * Retro-auditoría de saldos a favor (§8.3, D7): la comparación entre el
 * `ocr_amount` guardado y lo que el servidor lee hoy, y la salida CSV/markdown.
 */
import { describe, it, expect } from 'vitest';
import {
    compararLectura, aCsv, celdaCsv, resumir, resumenMarkdown, TOLERANCIA_AUDITORIA, type FilaSaldoAFavor,
} from './auditoria-saldos-a-favor';

const fila = (o: Partial<FilaSaldoAFavor> = {}): FilaSaldoAFavor => ({
    ajusteId: 'aj1', pagoId: 'p1', schoolId: 's1', escuela: 'Club Uno', familia: 'Ana Pérez (paga Luis Pérez)',
    concepto: 'Mensualidad noviembre', creadoEn: '2026-11-20T10:00:00Z', credito: 55000, montoCobro: 145000,
    ocrGuardado: 200000, fuenteHuella: 'server_verified', origen: 'saldo_a_favor', receiptUrl: 'u/p1.jpg', ...o,
});

describe('comparación del monto', () => {
    it('la tolerancia es 1 %', () => {
        expect(TOLERANCIA_AUDITORIA).toBe(0.01);
    });

    it('igual o dentro del 1 %: ok', () => {
        expect(compararLectura(fila({ ocrHoy: 200000 }), true)).toMatchObject({ estado: 'ok', diferencia: 0 });
        expect(compararLectura(fila({ ocrHoy: 201999 }), true).estado).toBe('ok');
        expect(compararLectura(fila({ ocrHoy: 198000 }), true).estado).toBe('ok'); // justo 1 %
    });

    it('más de 1 %: revisar, con el monto de hoy y el guardado', () => {
        const c = compararLectura(fila({ ocrHoy: 145000 }), true);
        expect(c.estado).toBe('revisar');
        expect(c.motivo).toBe('el comprobante dice 145000 y se guardó 200000');
        expect(c.diferencia).toBeCloseTo(0.275, 5);
        expect(compararLectura(fila({ ocrHoy: 202100 }), true).estado).toBe('revisar');
    });

    it('imagen que no se lee o lectura sin monto: revisar', () => {
        expect(compararLectura(fila({ errorRelectura: 'ningún proveedor lo pudo leer' }), true))
            .toMatchObject({ estado: 'revisar', motivo: 'no se pudo leer la imagen: ningún proveedor lo pudo leer' });
        expect(compararLectura(fila({ ocrHoy: null }), true)).toMatchObject({ estado: 'revisar', motivo: 'la lectura de hoy no trae monto' });
        expect(compararLectura(fila({ ocrHoy: 0 }), true).estado).toBe('revisar');
    });

    it('saldo a favor sin monto guardado: revisar, aun sin releer', () => {
        expect(compararLectura(fila({ ocrGuardado: null }), false).estado).toBe('revisar');
        expect(compararLectura(fila({ ocrGuardado: null }), true).estado).toBe('revisar');
    });

    it('sin --releer no compara: queda «sin releer» y dice si la huella no es del servidor', () => {
        expect(compararLectura(fila(), false)).toEqual({ estado: 'sin releer', motivo: 'pendiente de releer', diferencia: null });
        expect(compararLectura(fila({ fuenteHuella: 'client_original' }), false).motivo).toMatch(/no es del servidor/);
        expect(compararLectura(fila({ fuenteHuella: null }), false).motivo).toMatch(/no es del servidor/);
    });
});

describe('salida', () => {
    it('CSV con BOM, comillas donde hace falta y sin fórmulas', () => {
        expect(celdaCsv('a, b')).toBe('"a, b"');
        expect(celdaCsv('dijo "hola"')).toBe('"dijo ""hola"""');
        expect(celdaCsv('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
        expect(celdaCsv(-5)).toBe('-5');
        expect(celdaCsv(null)).toBe('');
        const csv = aCsv([{ fila: fila({ ocrHoy: 145000 }), cmp: compararLectura(fila({ ocrHoy: 145000 }), true) }]);
        expect(csv.startsWith('﻿estado,motivo,diferencia_pct,')).toBe(true);
        expect(csv).toContain('revisar,el comprobante dice 145000 y se guardó 200000,27.50,Club Uno,p1,Ana Pérez (paga Luis Pérez)');
    });

    it('resumen por estado, fuente y escuela; el markdown no lleva nombres de familias', () => {
        const filas = [
            fila(), fila({ ajusteId: 'aj2', pagoId: 'p2', credito: 20000, fuenteHuella: null, ocrGuardado: null }),
            fila({ ajusteId: 'aj3', pagoId: 'p3', escuela: 'Club Dos', credito: 10000, fuenteHuella: 'client_original' }),
        ];
        const r = resumir(filas.map((f) => ({ fila: f, cmp: compararLectura(f, false) })));
        expect(r.creditos).toBe(3);
        expect(r.total).toBe(85000);
        expect(r.porEstado.revisar).toEqual({ n: 1, monto: 20000 });
        expect(r.porEstado['sin releer']).toEqual({ n: 2, monto: 65000 });
        expect(r.porFuente).toEqual({
            server_verified: { n: 1, monto: 55000 }, 'sin fuente': { n: 1, monto: 20000 }, client_original: { n: 1, monto: 10000 },
        });
        expect(r.porEscuela.map((e) => [e.escuela, e.n, e.monto, e.revisar])).toEqual([['Club Uno', 2, 75000, 1], ['Club Dos', 1, 10000, 0]]);
        const md = resumenMarkdown(r, false, '2026-11-26');
        expect(md).toContain('sin relectura');
        expect(md).toContain('| Club Uno | 2 |');
        expect(md).not.toContain('Ana Pérez');
    });
});
