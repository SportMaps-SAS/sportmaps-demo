/**
 * Búsqueda de deportistas: funciones puras (tildes, apodos).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/supabase', () => ({ supabase: {}, supabaseUrl: 'http://supabase.local', supabaseServiceKey: 'clave-de-prueba' }));

import { coincideNombre, normalizar, variantesDeApodo } from './deportistas';

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
