/**
 * Caracterización (plan B4 §5, T5): las salidas de HOY de las listas de motivos
 * del frontend —L9 `lib/payment-accounts.ts` y L10 `lib/manualPaymentCharge.ts`—
 * fijadas ANTES de derivarlas del catálogo único `lib/motivosDeCobro.ts`.
 * Después del refactor las 10 categorías viejas tienen que salir idénticas;
 * lo nuevo («Clase de prueba», «Reserva») se prueba aparte.
 */
import { describe, expect, it } from 'vitest';
import {
    CHARGE_CATEGORIES,
    CHARGE_CATEGORY_LABEL,
    chargeCategoryOf,
    chargeFilterKey,
    chargeFilterLabel,
    chargeLabel,
    existingChargeInfo,
    isChargeCategory,
    isOneTimeCategory,
    oneTimeLabelFromConcept,
    parsePaymentAccounts,
} from '@/lib/payment-accounts';
import {
    MANUAL_CHARGE_CATEGORY_OPTIONS,
    effectiveManualCategory,
    manualChargeInsertFields,
    manualChargeIsPeriodic,
} from '@/lib/manualPaymentCharge';

const VIEJAS = ['mensualidad', 'inscripcion', 'articulos', 'torneo', 'otro', 'seguro', 'excedente', 'clase_extra', 'vacacional', 'viaje'] as const;

describe('payment-accounts — salidas de hoy (10 categorías)', () => {
    it('CHARGE_CATEGORIES empieza con las 10 de siempre, en el orden del CHECK', () => {
        expect(CHARGE_CATEGORIES.slice(0, 10)).toEqual(VIEJAS);
        for (const c of VIEJAS) expect(isChargeCategory(c)).toBe(true);
        expect(isChargeCategory('inventada')).toBe(false);
        expect(isChargeCategory(null)).toBe(false);
        expect(isChargeCategory(7)).toBe(false);
    });

    it('CHARGE_CATEGORY_LABEL de las 10', () => {
        expect(Object.fromEntries(VIEJAS.map((c) => [c, CHARGE_CATEGORY_LABEL[c]]))).toEqual({
            mensualidad: 'Mensualidad',
            inscripcion: 'Inscripción',
            articulos: 'Artículos',
            torneo: 'Torneo',
            otro: 'Otro cobro',
            seguro: 'Seguro de accidentes',
            excedente: 'Horas adicionales',
            clase_extra: 'Clase extra',
            vacacional: 'Vacacional',
            viaje: 'Viaje',
        });
    });

    it('chargeCategoryOf: la categoría manda; sin ella (u «otro»), el concepto', () => {
        for (const c of VIEJAS.filter((c) => c !== 'otro')) expect(chargeCategoryOf(c, 'Mensualidad octubre')).toBe(c);
        const porConcepto: [string | null, string | null, string | null][] = [
            [null, 'Matrícula 2026', 'inscripcion'],
            [null, 'Inscripción anual', 'inscripcion'],
            [null, 'Seguro de accidentes', 'seguro'],
            [null, 'Mensualidad Octubre 2026', 'mensualidad'],
            [null, 'Pago mensual', 'mensualidad'],
            [null, 'Torneo Halloween', 'torneo'],
            [null, 'Uniforme de gala', 'articulos'],
            [null, 'Kit de entrenamiento', 'articulos'],
            [null, 'Dotación', 'articulos'],
            [null, 'Artículos deportivos', 'articulos'],
            ['otro', 'Uniforme talla 10', 'articulos'],
            ['otro', 'Donación', 'otro'],
            [null, 'Donación', null],
            [null, '', null],
            [null, null, null],
            ['inventada', 'Pago', null],
            ['inventada', 'Torneo', 'torneo'],
        ];
        for (const [cat, concepto, esperado] of porConcepto) {
            expect(chargeCategoryOf(cat, concepto), `${cat} / ${concepto}`).toBe(esperado);
        }
    });

    it('chargeLabel y oneTimeLabelFromConcept', () => {
        expect(chargeLabel({ payment_category: 'seguro', concept: 'x' })).toBe('Seguro de accidentes');
        expect(chargeLabel({ payment_category: 'viaje' })).toBe('Viaje');
        expect(chargeLabel({ payment_category: null, concept: 'Cuota', payment_type: 'subscription' })).toBe('Mensualidad');
        expect(chargeLabel({ payment_category: null, concept: 'Cuota', payment_type: 'one_time' })).toBe('Cobro');
        expect(chargeLabel({ payment_category: 'inventada', concept: 'Cuota' })).toBe('Cobro');
        expect(oneTimeLabelFromConcept('Torneo Halloween')).toBe('Torneo');
        expect(oneTimeLabelFromConcept('Mensualidad Octubre 2026')).toBeNull();
    });

    it('chargeFilterKey / chargeFilterLabel (filtro «Tipo de cobro» de Pagos)', () => {
        expect(chargeFilterKey(null, 'Pago')).toBe('mensualidad');
        expect(chargeFilterKey('vacacional', null)).toBe('vacacional');
        expect(chargeFilterKey('reserva', 'Cancha 2')).toBe('reserva');
        expect(chargeFilterKey('inventada', 'Torneo')).toBe('inventada');
        for (const c of VIEJAS) expect(chargeFilterLabel(c)).toBe(CHARGE_CATEGORY_LABEL[c]);
        expect(chargeFilterLabel('reserva')).toBe('Reserva');
        expect(chargeFilterLabel('inventada')).toBe('inventada');
    });

    it('isOneTimeCategory y existingChargeInfo', () => {
        expect(isOneTimeCategory(null)).toBe(false);
        expect(isOneTimeCategory('mensualidad')).toBe(false);
        for (const c of VIEJAS.filter((c) => c !== 'mensualidad')) expect(isOneTimeCategory(c)).toBe(true);
        expect(existingChargeInfo('update', 'clase_extra', 'Perfeccionamiento')).toEqual({
            isOneTime: true, label: 'Clase extra', accountsCategory: 'clase_extra',
        });
        expect(existingChargeInfo('update', null, 'Torneo Halloween')).toEqual({
            isOneTime: false, label: null, accountsCategory: 'torneo',
        });
    });

    it('only_for conserva las categorías conocidas y descarta las desconocidas', () => {
        const [a] = parsePaymentAccounts([{ id: 'x', type: 'nequi', value: '3000000001', only_for: ['seguro', 'viaje', 'inventada'] }]);
        expect(a.only_for).toEqual(['seguro', 'viaje']);
    });
});

describe('manualPaymentCharge — salidas de hoy («Registrar pago»)', () => {
    it('MANUAL_CHARGE_CATEGORY_OPTIONS: mismo orden y mismos textos', () => {
        expect(MANUAL_CHARGE_CATEGORY_OPTIONS).toEqual([
            { value: 'mensualidad', label: 'Mensualidad' },
            { value: 'inscripcion', label: 'Inscripción' },
            { value: 'seguro', label: 'Seguro' },
            { value: 'articulos', label: 'Artículos / uniformes' },
            { value: 'torneo', label: 'Torneo' },
            { value: 'clase_extra', label: 'Clase extra' },
            { value: 'vacacional', label: 'Vacacional' },
            { value: 'viaje', label: 'Viaje' },
            { value: 'excedente', label: 'Horas adicionales' },
            { value: 'otro', label: 'Otro cobro' },
        ]);
    });

    it('manualChargeInsertFields: solo la mensualidad conserva plan y período', () => {
        for (const c of VIEJAS) {
            const unico = c !== 'mensualidad';
            expect(manualChargeInsertFields(c, 'plan-1')).toEqual({
                payment_category: c,
                period_uniqueness_exempt: unico,
                offering_plan_id: unico ? null : 'plan-1',
            });
            expect(manualChargeIsPeriodic(c)).toBe(!unico);
        }
    });

    it('effectiveManualCategory: la elegida o la del concepto', () => {
        expect(effectiveManualCategory('viaje', 'Mensualidad')).toBe('viaje');
        expect(effectiveManualCategory(null, 'Torneo relámpago')).toBe('torneo');
        expect(effectiveManualCategory(null, 'Cuota')).toBeNull();
    });
});
