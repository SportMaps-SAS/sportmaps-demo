import { describe, it, expect } from 'vitest';
import { chargeFilterKey, chargeFilterLabel } from '@/lib/payment-accounts';

describe('chargeFilterKey (filtro «Tipo de cobro» de Pagos)', () => {
    it('la categoría explícita manda', () => {
        expect(chargeFilterKey('torneo', 'Mensualidad Octubre')).toBe('torneo');
        expect(chargeFilterKey('inscripcion', null)).toBe('inscripcion');
    });

    it('sin categoría (cron y filas viejas) es mensualidad, salvo que el concepto diga otra cosa', () => {
        expect(chargeFilterKey(null, 'Mensualidad Octubre 2026')).toBe('mensualidad');
        expect(chargeFilterKey(null, 'Pago')).toBe('mensualidad');
        expect(chargeFilterKey(null, 'Inscripción 2027')).toBe('inscripcion');
        expect(chargeFilterKey(null, 'Torneo Halloween')).toBe('torneo');
    });

    it("'otro' se reclasifica por el concepto y si no, queda en otro", () => {
        expect(chargeFilterKey('otro', 'Uniforme talla 10')).toBe('articulos');
        expect(chargeFilterKey('otro', 'Donación')).toBe('otro');
    });

    it('una categoría que el front no conoce no se esconde en mensualidad', () => {
        expect(chargeFilterKey('reserva', 'Cancha 2')).toBe('reserva');
        expect(chargeFilterLabel('reserva')).toBe('Reserva');
    });

    it('etiquetas en español', () => {
        expect(chargeFilterLabel('mensualidad')).toBe('Mensualidad');
        expect(chargeFilterLabel('inscripcion')).toBe('Inscripción');
        expect(chargeFilterLabel('torneo')).toBe('Torneo');
    });
});
