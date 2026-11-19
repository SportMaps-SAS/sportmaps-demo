import { describe, it, expect } from 'vitest';
import {
    normalizeEmail,
    normalizePhone,
    pickSiblingSuggestion,
    type SiblingCandidateRow,
} from './sibling-suggestion.service';

const helena: SiblingCandidateRow = {
    id: 'helena', full_name: 'Helena Alfonso Fonseca', is_active: true, parent_id: null,
    parent_name_temp: 'CAROLINA FONSECA', parent_email_temp: 'Fonsecar.Carolina@gmail.com', parent_phone_temp: '573124208761',
};
const activos = new Set(['helena', 'otra', 'x1', 'x2']);

describe('normalizadores', () => {
    it('correo: minúsculas y sin espacios; basura = null', () => {
        expect(normalizeEmail('  Fonsecar.Carolina@Gmail.com ')).toBe('fonsecar.carolina@gmail.com');
        expect(normalizeEmail('no-es-correo')).toBeNull();
    });
    it('teléfono: últimos 10 dígitos; corto = null', () => {
        expect(normalizePhone('+57 312 420 8761')).toBe('3124208761');
        expect(normalizePhone('573124208761')).toBe('3124208761');
        expect(normalizePhone('12345')).toBeNull();
    });
});

describe('pickSiblingSuggestion', () => {
    it('coincide el correo → propone al hermano', () => {
        const r = pickSiblingSuggestion([helena], activos, { email: 'fonsecar.carolina@gmail.com' });
        expect(r.suggested_child_id).toBe('helena');
        expect(r.matched_by).toEqual(['email']);
        expect(r.ambiguous).toBe(false);
    });

    it('coincide el teléfono (con indicativo distinto) → propone al hermano', () => {
        const r = pickSiblingSuggestion([helena], activos, { phone: '3124208761' });
        expect(r.suggested_child_id).toBe('helena');
        expect(r.matched_by).toEqual(['phone']);
    });

    it('correo compartido por 2 familias distintas → candidatos sin forzar ninguno', () => {
        const a: SiblingCandidateRow = { ...helena, id: 'x1', full_name: 'Niña A', parent_name_temp: 'Abuela Perez' };
        const b: SiblingCandidateRow = { ...helena, id: 'x2', full_name: 'Niño B', parent_name_temp: 'Tía Gómez' };
        const r = pickSiblingSuggestion([a, b], activos, { email: 'fonsecar.carolina@gmail.com' });
        expect(r.ambiguous).toBe(true);
        expect(r.suggested_child_id).toBeNull();
        expect(r.candidates.map(c => c.child_id).sort()).toEqual(['x1', 'x2']);
    });

    it('dos hijos de la MISMA familia → se propone uno, no es ambiguo', () => {
        const a: SiblingCandidateRow = { ...helena, id: 'x1', full_name: 'Niña A' };
        const b: SiblingCandidateRow = { ...helena, id: 'x2', full_name: 'Niño B', parent_name_temp: 'carolina  fonseca' };
        const r = pickSiblingSuggestion([a, b], activos, { email: 'fonsecar.carolina@gmail.com' });
        expect(r.ambiguous).toBe(false);
        expect(r.suggested_child_id).toBe('x1');
        expect(r.candidates).toHaveLength(2);
    });

    it('sin coincidencia (ni correo ni teléfono) → nada', () => {
        const r = pickSiblingSuggestion([helena], activos, { email: 'otro@correo.com', phone: '3000000000' });
        expect(r.candidates).toHaveLength(0);
        expect(r.suggested_child_id).toBeNull();
    });

    it('sin contacto válido → nada', () => {
        expect(pickSiblingSuggestion([helena], activos, { email: 'x', phone: '123' }).candidates).toHaveLength(0);
    });

    it('hermano inactivo o sin inscripción activa se ignora', () => {
        const inactivo: SiblingCandidateRow = { ...helena, is_active: false };
        expect(pickSiblingSuggestion([inactivo], activos, { email: 'fonsecar.carolina@gmail.com' }).candidates).toHaveLength(0);
        expect(pickSiblingSuggestion([helena], new Set<string>(), { email: 'fonsecar.carolina@gmail.com' }).candidates).toHaveLength(0);
    });

    it('no se propone a sí mismo', () => {
        const r = pickSiblingSuggestion([helena], activos, { email: 'fonsecar.carolina@gmail.com' }, 'helena');
        expect(r.candidates).toHaveLength(0);
    });
});
