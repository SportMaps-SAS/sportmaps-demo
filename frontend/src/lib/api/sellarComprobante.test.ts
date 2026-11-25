/**
 * Sellado del comprobante por el servidor (spec seguridad-veredicto-comprobante §3.7).
 *
 * La familia ya no escribe la lectura, el veredicto ni la huella del comprobante:
 * guarda el archivo y pide el sellado SIEMPRE. Estas pruebas fijan el cliente del
 * endpoint, el aviso (solo el duplicado; nunca «aprobado») y que las dos pantallas
 * de la familia no vuelvan a mandar esas columnas.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('./bffClient', () => ({ bffClient: { post: (...a: unknown[]) => post(...a) } }));

import {
    avisoDelSellado,
    MENSAJE_COMPROBANTE_YA_RECIBIDO,
    sellarComprobante,
    sellarSinEsperar,
} from './sellarComprobante';

// Con llaves: un beforeEach que DEVUELVE una función la toma vitest como limpieza y la llama al final.
beforeEach(() => { post.mockReset(); });

describe('sellarComprobante', () => {
    it('pide el sellado del cobro sin mandar nada del comprobante', async () => {
        post.mockResolvedValue({ verdict: 'verde', action: 'none', duplicado: false });
        await sellarComprobante('a1000000-0000-4000-8000-0000000000a1');
        expect(post).toHaveBeenCalledWith('/api/v1/payments/a1000000-0000-4000-8000-0000000000a1/sellar-comprobante', {});
    });
});

describe('avisoDelSellado', () => {
    it('solo el duplicado se avisa', () => {
        expect(avisoDelSellado({ verdict: null, action: 'rejected', duplicado: true }))
            .toEqual({ title: 'Comprobante ya recibido', description: MENSAJE_COMPROBANTE_YA_RECIBIDO });
    });

    it('aprobado, glosa, rechazo por rojo o nada: la familia sigue viendo «recibido»', () => {
        for (const action of ['approved', 'glosa', 'rejected', 'none'] as const) {
            expect(avisoDelSellado({ verdict: 'verde', action, duplicado: false })).toBeNull();
        }
        expect(avisoDelSellado(null)).toBeNull();
        expect(avisoDelSellado(undefined)).toBeNull();
    });
});

describe('sellarSinEsperar', () => {
    it('avisa el duplicado cuando llega la respuesta', async () => {
        post.mockResolvedValue({ verdict: null, action: 'rejected', duplicado: true });
        const avisar = vi.fn();
        sellarSinEsperar('p1', avisar);
        await vi.waitFor(() => expect(avisar).toHaveBeenCalledTimes(1));
        expect(avisar.mock.calls[0][0].title).toBe('Comprobante ya recibido');
    });

    it('nunca lanza: si el BFF falla, lo recoge el barrido', async () => {
        post.mockImplementation(() => Promise.reject(new Error('502')));
        const avisar = vi.fn();
        // Si lanzara (sincrónico) o dejara el rechazo sin manejar, la prueba falla.
        sellarSinEsperar('p1', avisar);
        await new Promise((r) => setTimeout(r, 10));
        expect(post).toHaveBeenCalledTimes(1);
        expect(avisar).not.toHaveBeenCalled();
    });
});

describe('contrato: la familia no escribe la lectura del comprobante', () => {
    const SRC = join(__dirname, '..', '..');
    const PANTALLAS = ['pages/ParentCheckoutPage.tsx', 'components/payment/PaymentCheckoutModal.tsx'];
    // Una columna como LLAVE de objeto (`ocr_amount:`), que es como se escribe en un payload.
    const COLUMNA_ESCRITA = /\b(ocr_[a-z_]+|receipt_verdict[a-z_]*|receipt_image_sha256[a-z_]*|receipt_reference_norm|receipt_amount_confirmed[a-z_]*|receipt_amount_change_reason)\s*:/;

    for (const archivo of PANTALLAS) {
        it(`${archivo} no manda ocr_*, veredicto, huella ni valor confirmado`, () => {
            const fuente = readFileSync(join(SRC, archivo), 'utf8');
            const lineas = fuente.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l) && COLUMNA_ESCRITA.test(l));
            expect(lineas).toEqual([]);
        });

        it(`${archivo} pide el sellado y ya no usa /auto-evaluate`, () => {
            const fuente = readFileSync(join(SRC, archivo), 'utf8');
            expect(fuente).toContain('sellarSinEsperar(');
            expect(fuente).not.toMatch(/autoEvaluate/);
        });
    }
});
