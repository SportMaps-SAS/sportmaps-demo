/**
 * Catálogo único de motivos (plan B4 §5): claves = último CHECK de
 * `payments.payment_category` en supabase/migrations; cada motivo con
 * etiqueta, corta ≤ 9 única y plural; y lo nuevo que derivan payment-accounts
 * y «Registrar pago» («Clase de prueba», «Reserva»).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CLAVES_MOTIVO,
    MOTIVOS,
    TIPOS_DE_SERVICIO,
    definicionDeMotivo,
    esMotivoDeCobro,
    esTipoDeServicio,
    exentoDeUnicidadDePeriodo,
    motivosEnPantalla,
} from './motivosDeCobro';
import {
    CHARGE_CATEGORIES,
    CHARGE_CATEGORY_LABEL,
    chargeCategoryOf,
    chargeFilterKey,
    chargeFilterLabel,
    chargeLabel,
    existingChargeInfo,
    parsePaymentAccounts,
    resolvePaymentAccounts,
} from './payment-accounts';
import { MANUAL_CHARGE_CATEGORY_OPTIONS, manualChargeInsertFields } from './manualPaymentCharge';

/** Claves del último `ADD CONSTRAINT payments_payment_category_check` de las migraciones. */
function clavesDelCheckVivo(): string[] {
    const dir = resolve(__dirname, '../../../supabase/migrations');
    // De la más nueva hacia atrás: la primera que lo redefine es la viva (y se
    // leen pocos archivos, no los ~900).
    const archivos = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort().reverse();
    for (const f of archivos) {
        const sql = readFileSync(resolve(dir, f), 'utf-8');
        const i = sql.lastIndexOf('ADD CONSTRAINT payments_payment_category_check');
        if (i >= 0) return [...sql.slice(i, sql.indexOf(';', i)).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    }
    throw new Error('No se encontró el CHECK de payment_category');
}

describe('catálogo de motivos', () => {
    it('las claves son las del CHECK vivo, en su orden', () => {
        expect([...CLAVES_MOTIVO]).toEqual(clavesDelCheckVivo());
        expect(MOTIVOS.map((m) => m.clave)).toEqual([...CLAVES_MOTIVO]);
    });

    it('cada motivo tiene etiqueta, plural y una corta ≤ 9 que no se repite', () => {
        for (const m of MOTIVOS) {
            expect(m.etiqueta.trim(), m.clave).not.toBe('');
            expect(m.plural.trim(), m.clave).not.toBe('');
            expect(m.corta.length, m.clave).toBeLessThanOrEqual(9);
        }
        const cortas = MOTIVOS.map((m) => m.corta);
        expect(new Set(cortas).size).toBe(cortas.length);
        expect(definicionDeMotivo('clase_prueba').corta).toBe('Prueba');
        expect(definicionDeMotivo('clase_extra').corta).toBe('Clase');
    });

    it('solo la mensualidad ocupa el período; todo lo demás va exento', () => {
        for (const c of CLAVES_MOTIVO) expect(exentoDeUnicidadDePeriodo(c), c).toBe(c !== 'mensualidad');
    });

    it('los tipos de servicio son los del CHECK de school_tournament_items.kind, en el orden del editor', () => {
        expect([...TIPOS_DE_SERVICIO]).toEqual(['torneo', 'clase_extra', 'vacacional', 'viaje', 'otro']);
        expect(esTipoDeServicio('clase_extra')).toBe(true);
        expect(esTipoDeServicio('clase_prueba')).toBe(false);
        expect(esMotivoDeCobro('clase_prueba')).toBe(true);
        expect(esMotivoDeCobro('evento')).toBe(false);
    });

    it('en pantalla están los 12, una vez cada uno, con «Otro cobro» al final', () => {
        const orden = motivosEnPantalla().map((m) => m.clave);
        expect([...orden].sort()).toEqual([...CLAVES_MOTIVO].sort());
        expect(orden[orden.length - 1]).toBe('otro');
    });

    it('la familia no crea desde la app seguro, horas, reserva ni clase de prueba', () => {
        const noApp = MOTIVOS.filter((m) => !m.enSubidaAcudiente).map((m) => m.clave);
        expect(noApp.sort()).toEqual(['clase_prueba', 'excedente', 'reserva', 'seguro']);
    });
});

describe('payment-accounts deriva del catálogo: lo nuevo', () => {
    it('CHARGE_CATEGORIES = las 12, con «Reserva» y «Clase de prueba» al final', () => {
        expect([...CHARGE_CATEGORIES]).toEqual([...CLAVES_MOTIVO]);
        expect(CHARGE_CATEGORY_LABEL.reserva).toBe('Reserva');
        expect(CHARGE_CATEGORY_LABEL.clase_prueba).toBe('Clase de prueba');
    });

    it('el filtro de Pagos nombra la clase de prueba (antes salía la clave cruda)', () => {
        expect(chargeFilterKey('clase_prueba', 'Clase de prueba — Juan')).toBe('clase_prueba');
        expect(chargeFilterLabel('clase_prueba')).toBe('Clase de prueba');
        expect(chargeFilterLabel('reserva')).toBe('Reserva');
        expect(chargeLabel({ payment_category: 'clase_prueba', concept: 'x' })).toBe('Clase de prueba');
    });

    it('un cobro existente de clase de prueba es único y elige sus llaves', () => {
        expect(existingChargeInfo('update', 'clase_prueba', 'Clase de prueba — Juan')).toEqual({
            isOneTime: true, label: 'Clase de prueba', accountsCategory: 'clase_prueba',
        });
        expect(chargeCategoryOf('reserva', 'Cancha 2')).toBe('reserva');
    });

    it('only_for conserva clase_prueba y reserva (antes las borraba al guardar el panel)', () => {
        const settings = {
            payment_accounts: [
                { id: 'g', type: 'breb', label: 'Bre-B', value: '0092231411', active: true },
                { id: 'p', type: 'nequi', label: 'Nequi pruebas', value: '3194505150', active: true, only_for: ['clase_prueba'] },
            ],
        };
        expect(parsePaymentAccounts(settings.payment_accounts)[1].only_for).toEqual(['clase_prueba']);
        expect(resolvePaymentAccounts(settings, { category: 'clase_prueba' }).map((a) => a.value)).toEqual(['0092231411', '3194505150']);
        expect(resolvePaymentAccounts(settings, { category: 'mensualidad' }).map((a) => a.value)).toEqual(['0092231411']);
    });
});

describe('«Registrar pago» deriva del catálogo', () => {
    it('no ofrece reserva ni clase de prueba (tienen su propio flujo)', () => {
        const valores = MANUAL_CHARGE_CATEGORY_OPTIONS.map((o) => o.value);
        expect(valores).not.toContain('reserva');
        expect(valores).not.toContain('clase_prueba');
        expect([...valores].sort()).toEqual(MOTIVOS.filter((m) => m.enRegistroManual).map((m) => m.clave).sort());
    });

    it('una clase de prueba registrada por otra vía igual sale exenta y sin plan', () => {
        expect(manualChargeInsertFields('clase_prueba', 'plan-1')).toEqual({
            payment_category: 'clase_prueba', period_uniqueness_exempt: true, offering_plan_id: null,
        });
    });
});
