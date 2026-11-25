/**
 * Búsqueda de deportistas: funciones puras (tildes, apodos).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/supabase', () => ({ supabase: {}, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' }));

import { coincideNombre, normalizar, variantesDeApodo, fonetica, coincideAproximado, unaLetraDeDiferencia } from './deportistas';

describe('búsqueda aproximada (audio y tecleo)', () => {
    it('b/v, s/z, ll/y, h muda, qu/k', () => {
        expect(fonetica('Valentina')).toBe(fonetica('balentina'));
        expect(fonetica('Ortiz')).toBe(fonetica('ortis'));
        expect(fonetica('López')).toBe(fonetica('lopes'));
        expect(fonetica('Yuliana')).toBe(fonetica('lluliana'));
        expect(fonetica('Héctor')).toBe(fonetica('ector'));
    });
    it('una letra de diferencia solo en palabras de 4+', () => {
        expect(unaLetraDeDiferencia('samuel', 'samel')).toBe(true);
        expect(unaLetraDeDiferencia('samuel', 'manuel')).toBe(false);
        expect(coincideAproximado('Samuel Ortiz', 'samel ortis')).toBe(true);
        expect(coincideAproximado('Valentina Ruiz', 'balentina ruis')).toBe(true);
        expect(coincideAproximado('Mariana López', 'juan')).toBe(false);
    });
});

describe('variantesDeApodo', () => {
    it('«majo» se busca como «maria jose» y conserva el apellido', () => {
        expect(variantesDeApodo('majo')).toEqual(['maria jose']);
        expect(variantesDeApodo('Majo Pérez')).toEqual(['maria jose perez']);
    });
    it('un apodo con dos nombres probables da las dos búsquedas', () => {
        expect(variantesDeApodo('vale')).toEqual(['valentina', 'valeria']);
    });
    it('un nombre normal no tiene variantes', () => {
        expect(variantesDeApodo('mariana')).toEqual([]);
    });
});

describe('normalizar y coincideNombre', () => {
    it('sin tildes ni mayúsculas', () => {
        expect(normalizar('  María  José ')).toBe('maria jose');
        expect(coincideNombre('María José Ruiz', 'maria jose')).toBe(true);
        expect(coincideNombre('Mariana López', 'maria jose')).toBe(false);
    });
});
