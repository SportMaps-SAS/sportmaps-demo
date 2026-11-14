/**
 * Cobros ÚNICOS del lado de la familia (2026-10-10). Caso de origen: alta de
 * Dreamers con mensualidad + inscripción + seguro para un atleta nuevo. El modal
 * de pago trataba el seguro como una mensualidad (período, descuento por pronto
 * pago, bloqueo «ya existe un pago activo para Octubre») y la llave restringida
 * a seguros no se resolvía si el concepto no decía «seguro».
 */
import { describe, it, expect } from 'vitest';
import {
    CHARGE_CATEGORIES,
    CHARGE_CATEGORY_LABEL,
    chargeCategoryOf,
    chargeLabel,
    existingChargeInfo,
    isChargeCategory,
    isOneTimeCategory,
    oneTimeLabelFromConcept,
    parsePaymentAccounts,
    resolvePaymentAccounts,
    type PaymentChargeCategory,
} from '@/lib/payment-accounts';

describe('categorías de cobro', () => {
    it('la lista es la del CHECK de payments.payment_category y todas tienen etiqueta', () => {
        expect([...CHARGE_CATEGORIES].sort()).toEqual(
            ['articulos', 'clase_extra', 'clase_prueba', 'excedente', 'inscripcion', 'mensualidad', 'otro', 'reserva', 'seguro', 'torneo', 'vacacional', 'viaje'],
        );
        for (const c of CHARGE_CATEGORIES) expect(CHARGE_CATEGORY_LABEL[c]).toBeTruthy();
        expect(isChargeCategory('viaje')).toBe(true);
        expect(isChargeCategory('inventada')).toBe(false);
    });

    it('cobro único = categoría explícita distinta de mensualidad (genérico)', () => {
        expect(isOneTimeCategory(null)).toBe(false);
        expect(isOneTimeCategory('mensualidad')).toBe(false);
        for (const c of CHARGE_CATEGORIES.filter((c) => c !== 'mensualidad')) expect(isOneTimeCategory(c)).toBe(true);
        expect(isOneTimeCategory('categoria_futura_por_plan')).toBe(true);
    });

    it('etiquetas', () => {
        expect(chargeLabel({ payment_category: 'seguro', concept: 'x' })).toBe('Seguro de accidentes');
        expect(chargeLabel({ payment_category: 'clase_extra', concept: null })).toBe('Clase extra');
        expect(oneTimeLabelFromConcept('Seguro de accidentes — Plan X — Atleta')).toBe('Seguro de accidentes');
        expect(oneTimeLabelFromConcept('Inscripción — Plan X — Atleta')).toBe('Inscripción');
        expect(oneTimeLabelFromConcept('Mensualidad Octubre 2026')).toBeNull();
        expect(oneTimeLabelFromConcept('Plan X')).toBeNull();
    });
});

describe('existingChargeInfo (modal de pago, mode=update)', () => {
    it('seguro: único, con etiqueta y categoría de llaves aunque el concepto sea solo el plan', () => {
        // AthletePaymentsPage pasa como concepto el nombre del plan («Atleta — Plan X»).
        expect(existingChargeInfo('update', 'seguro', 'Atleta — Plan X')).toEqual({
            isOneTime: true, label: 'Seguro de accidentes', accountsCategory: 'seguro',
        });
    });

    it('mensualidad (o fila vieja sin categoría): no es único', () => {
        expect(existingChargeInfo('update', 'mensualidad', 'Mensualidad Octubre 2026'))
            .toEqual({ isOneTime: false, label: null, accountsCategory: 'mensualidad' });
        expect(existingChargeInfo('update', null, 'Mensualidad Octubre 2026').isOneTime).toBe(false);
        // Sin categoría la llave se elige por concepto, como antes.
        expect(existingChargeInfo('update', null, 'Inscripción Anual').accountsCategory).toBe('inscripcion');
    });

    it('mode=create no tiene cobro existente', () => {
        expect(existingChargeInfo('create', 'seguro', 'x')).toEqual({ isOneTime: false, label: null, accountsCategory: null });
    });
});

describe('llaves restringidas a cobros únicos (only_for)', () => {
    const settings = {
        breb_number: '0092231411',
        payment_accounts: [
            { id: 'a', type: 'breb', label: 'Bre-B', value: '0092231411', active: true },
            { id: 's', type: 'nequi', label: 'Nequi seguros', value: '3000000001', active: true, only_for: ['seguro'] },
            { id: 'v', type: 'nequi', label: 'Nequi viajes', value: '3000000002', active: true, only_for: ['viaje', 'vacacional'] },
        ],
    };

    it('el parseo conserva las categorías nuevas (viaje, vacacional)', () => {
        expect(parsePaymentAccounts(settings.payment_accounts)[2].only_for).toEqual(['viaje', 'vacacional']);
    });

    it('cada cobro ve las generales + las suyas; la mensualidad solo las generales', () => {
        const valores = (cat: PaymentChargeCategory | null) =>
            resolvePaymentAccounts(settings, { category: cat }).map((a) => a.value);
        expect(valores('seguro')).toEqual(['0092231411', '3000000001']);
        expect(valores('viaje')).toEqual(['0092231411', '3000000002']);
        expect(valores('mensualidad')).toEqual(['0092231411']);
        expect(valores(chargeCategoryOf('seguro', 'Atleta — Plan X'))).toContain('3000000001');
        // Categoría desconocida: solo las generales (fallback sensato, nunca la restringida).
        expect(valores(null)).toEqual(['0092231411']);
    });
});
