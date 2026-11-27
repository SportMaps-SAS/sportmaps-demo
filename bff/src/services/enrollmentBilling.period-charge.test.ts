import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import { isPeriodCharge, PLAN_PERIOD_CHARGE_FILTER } from './enrollmentBilling';

// Monster, 2026-11-18: guardar la ficha del atleta anuló sus cobros de la «Copa
// Navidad» porque las limpiezas de equipo/plan solo excluían inscripción, seguro
// y excedente. Ahora es lista blanca: solo la mensualidad del período.
describe('isPeriodCharge / PLAN_PERIOD_CHARGE_FILTER', () => {
    it('la mensualidad y los cobros viejos sin categoría son del período', () => {
        expect(isPeriodCharge('mensualidad')).toBe(true);
        expect(isPeriodCharge(null)).toBe(true);
        expect(isPeriodCharge(undefined)).toBe(true);
    });

    it.each(['torneo', 'inscripcion', 'seguro', 'excedente', 'articulos', 'otro',
        'clase_extra', 'vacacional', 'viaje', 'reserva', 'clase_prueba'])(
        '%s es un cobro aparte: no se anula ni se re-precia al editar la ficha', (cat) => {
            expect(isPeriodCharge(cat)).toBe(false);
        });

    it('el filtro de PostgREST es la misma lista blanca', () => {
        expect(PLAN_PERIOD_CHARGE_FILTER).toBe('payment_category.is.null,payment_category.eq.mensualidad');
    });
});
