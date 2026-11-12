/**
 * A qué cobro va un comprobante según el pie de la foto y si el monto cuadra.
 * Casos inventados, equivalentes a los de Dynasty del 2026-10-09.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));
import { leerTextosDelComprobante, decidirCobroPorTexto } from './whatsapp-cobro-por-texto.service';
import { montoEscrito } from './whatsapp-eleccion-de-pago.service';
import type { PagoPendiente } from './whatsapp-receipt-matching.service';

const p = (id: string, mes: number, amount: number, child = 'c1'): PagoPendiente => ({
    id, amount, concept: `Mensualidad ${String(mes).padStart(2, '0')}/2026`,
    due_date: `2026-${String(mes).padStart(2, '0')}-10`, child_id: child, atleta: child === 'c1' ? 'Lucía Mora' : 'Pablo Mora',
});
const AGO = p('ago', 8, 200000);
const SEP = p('sep', 9, 200000);
const OCT = p('oct', 10, 200000);

const decidir = (o: Partial<Parameters<typeof decidirCobroPorTexto>[0]> & { pie?: string; chat?: string[] }) =>
    decidirCobroPorTexto({
        pendientes: o.pendientes ?? [AGO, SEP, OCT],
        parciales: o.parciales ?? [],
        monto: o.monto === undefined ? 200000 : o.monto,
        lectura: leerTextosDelComprobante(o.pie ?? null, o.chat ?? [], o.pendientes ?? [AGO, SEP, OCT]),
        permiteAbonos: o.permiteAbonos ?? false,
    });

describe('leerTextosDelComprobante', () => {
    it('periodo «sept 15 - oct 15», «saldo» y el monto con «mil» de más', () => {
        const l = leerTextosDelComprobante('Buenos días profe, envío saldo \nsept 15 - oct 15\n$90.000 mil gracias!', []);
        expect(l.meses).toEqual([9, 10]);
        expect(l.saldo).toBe(true);
        expect(l.montoEscrito).toBe(90000);
    });

    it('del chat solo cuenta lo que habla de pago', () => {
        expect(leerTextosDelComprobante(null, ['el sábado de octubre hay torneo']).meses).toEqual([]);
        expect(leerTextosDelComprobante(null, ['te mando el pago de octubre']).meses).toEqual([10]);
    });

    it('montoEscrito: «$80.000 mil» es 80.000; «150 mil» es 150.000', () => {
        expect(montoEscrito('$80.000 mil')).toBe(80000);
        expect(montoEscrito('son 150 mil')).toBe(150000);
    });
});

describe('decidirCobroPorTexto', () => {
    describe('excedente de un cobro parcial (Shara, 2026-11-12)', () => {
        const PARCIAL = { id: 'nov-parcial', amount: 145000, amount_paid: 20000, concept: 'Mensualidad 11/2026' };
        it('comprobante de $145.000 sobre un parcial con saldo $125.000 y sin pendientes → a la escuela, nunca «ya registrado»', () => {
            const d = decidir({ pendientes: [], parciales: [PARCIAL], monto: 145000 });
            expect(d).toMatchObject({ tipo: 'a_la_escuela', codigo: 'excedente_de_parcial', pagoId: 'nov-parcial' });
            expect((d as any).resumen).toContain('saldo de $125.000');
            expect((d as any).resumen).toContain('Excede el saldo en $20.000');
        });
        it('el comprobante por el saldo exacto con la palabra «saldo» sigue yendo como saldo_de_parcial', () => {
            const d = decidir({ pendientes: [], parciales: [PARCIAL], monto: 125000, pie: 'envío el saldo' });
            expect(d).toMatchObject({ tipo: 'a_la_escuela', codigo: 'saldo_de_parcial' });
        });
        it('un monto MENOR al saldo no es excedente', () => {
            const d = decidir({ pendientes: [], parciales: [PARCIAL], monto: 50000 });
            expect((d as any)?.codigo).not.toBe('excedente_de_parcial');
        });
        it('si el monto es el de un pendiente, manda el pendiente (no se desvía a la escuela)', () => {
            const d = decidir({ pendientes: [OCT], parciales: [PARCIAL], monto: 200000 });
            expect((d as any)?.codigo).not.toBe('excedente_de_parcial');
        });
        it('dos parciales que exceden: ambiguo, no se elige uno al azar', () => {
            const d = decidir({ pendientes: [], parciales: [PARCIAL, { ...PARCIAL, id: 'otro', concept: 'Otro' }], monto: 145000 });
            expect((d as any)?.codigo).not.toBe('excedente_de_parcial');
        });
    });

    it('«saldo» igual al que le falta a un cobro parcial → a la escuela (el worker no estampa parciales)', () => {
        const d = decidir({
            pendientes: [OCT], monto: 50000, pie: 'envío el resto de septiembre',
            parciales: [{ id: 'sep-parcial', amount: 200000, amount_paid: 150000, concept: 'Mensualidad 09/2026' }],
        });
        expect(d).toMatchObject({ tipo: 'a_la_escuela', codigo: 'saldo_de_parcial', pagoId: 'sep-parcial' });
        expect((d as any).resumen).toContain('$50.000 como saldo de Mensualidad 09/2026');
        expect((d as any).mensaje).toContain('para el saldo de *Mensualidad 09/2026*');
    });

    it('un solo cobro y el monto no cuadra, sin abonos → a la escuela, no se aplica', () => {
        const d = decidir({ pendientes: [OCT], monto: 90000, pie: 'envío saldo sept 15 - oct 15 $90.000' });
        expect(d).toMatchObject({ tipo: 'a_la_escuela', codigo: 'monto_no_cuadra', pagoId: 'oct' });
        expect((d as any).resumen).toContain('no cuadra con ningún cobro pendiente');
        expect((d as any).resumen).toContain('«envío saldo sept 15 - oct 15 $90.000»');
    });

    it('la escuela SÍ recibe abonos → no se opina por el monto (sigue lo de siempre)', () => {
        expect(decidir({ pendientes: [OCT], monto: 90000, permiteAbonos: true })).toBeNull();
    });

    it('varios cobros y el monto no cuadra → preguntar (entre los del mes que dice, si dice)', () => {
        expect(decidir({ monto: 150000 })).toMatchObject({ tipo: 'preguntar', opciones: [AGO, SEP, OCT] });
        expect(decidir({ monto: 150000, pie: 'pago sept y oct' })).toMatchObject({ tipo: 'preguntar', opciones: [SEP, OCT] });
    });

    it('una suma de cobros sí cuadra → no se opina (la combinación la propone resolverPago)', () => {
        expect(decidir({ monto: 400000 })).toBeNull();
    });

    it('el pie nombra el mes y cuadra → ese mes', () => {
        expect(decidir({ pie: 'mensualidad de octubre' })).toEqual({ tipo: 'aplicar', pago: OCT, motivo: 'mes_del_texto' });
    });

    it('mismo monto, mismo deportista, sin mes → el vencido más antiguo', () => {
        expect(decidir({})).toEqual({ tipo: 'aplicar', pago: AGO, motivo: 'mas_antiguo' });
    });

    it('mismo monto pero deportistas distintos → no se adivina', () => {
        expect(decidir({ pendientes: [AGO, p('sep2', 9, 200000, 'c2')] })).toBeNull();
    });

    it('sin monto leído → no se opina por monto', () => {
        expect(decidir({ pendientes: [OCT], monto: null })).toBeNull();
    });
});
