import { describe, expect, it } from 'vitest';
import { montoMostrado } from './montoMostrado';

describe('montoMostrado', () => {
    it('abono parcial en Pagos recibidos: muestra lo recibido y el valor del cobro (Carlos Martínez)', () => {
        expect(montoMostrado({ status: 'partial', amount: 300000, amount_paid: 175000 }))
            .toEqual({ principal: 175000, deCobro: 300000, declarado: null });
    });

    it('pago completo: solo el monto', () => {
        expect(montoMostrado({ status: 'paid', amount: 300000, amount_paid: 300000 }))
            .toEqual({ principal: 300000, deCobro: null, declarado: null });
    });

    it('por validar con comprobante menor al cobro: declara el abono (Emiliano)', () => {
        expect(montoMostrado({ status: 'awaiting_approval', amount: 300000, ocr_amount: 150000 }))
            .toEqual({ principal: 300000, deCobro: null, declarado: 150000 });
    });

    it('por validar con comprobante igual al cobro (±$1): sin aviso', () => {
        expect(montoMostrado({ status: 'awaiting_approval', amount: 175000, ocr_amount: 175000 }).declarado).toBeNull();
        expect(montoMostrado({ status: 'awaiting_approval', amount: 175000, ocr_amount: 175001 }).declarado).toBeNull();
    });

    it('en la cola no se recorta un parcial a lo recibido', () => {
        expect(montoMostrado({ status: 'partial', amount: 300000, amount_paid: 175000 }, { cola: true }).principal).toBe(300000);
    });

    it('sin lectura del comprobante: solo el monto', () => {
        expect(montoMostrado({ status: 'awaiting_approval', amount: 100000, ocr_amount: null }))
            .toEqual({ principal: 100000, deCobro: null, declarado: null });
    });
});
