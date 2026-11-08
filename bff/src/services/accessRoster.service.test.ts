import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/supabase', () => ({ supabase: {} }));

import { nameTokens, matchScore, pickSuggestion, type AthleteRef } from './accessRoster.service';

const ref = (id: string, name: string, type: AthleteRef['type'] = 'child'): AthleteRef => ({
    key: `${type === 'child' ? 'c' : 'a'}:${id}`, id, type, name,
});

describe('nameTokens', () => {
    it('separa nombres pegados, quita tildes y puntuación', () => {
        expect(nameTokens('AtheneaCardona')).toEqual(['athenea', 'cardona']);
        expect(nameTokens('Andrés Felipe R.')).toEqual(['andres', 'felipe', 'r']);
        expect(nameTokens('GABRIEL CONTRERAS')).toEqual(['gabriel', 'contreras']);
    });
});

describe('matchScore', () => {
    it('nombre exacto = 1', () => {
        expect(matchScore('Carla Puerta', 'Carla Puerta')).toBe(1);
        expect(matchScore('NanaPerez', 'Nana Perez')).toBe(1);
    });
    it('inicial del apellido puntúa alto pero no como exacto', () => {
        expect(matchScore('Katherin T.', 'Katherin Tinjaca')).toBe(0.8);
        expect(matchScore('Andrés Felipe R.', 'Andrés Felipe Rojas')).toBeCloseTo(0.87, 2);
    });
    it('el primer nombre debe coincidir', () => {
        expect(matchScore('Julian G.', 'Gabriel Julian')).toBeLessThan(0.5);
    });
    it('un solo nombre no alcanza para sugerir', () => {
        expect(matchScore('Valentina', 'Valentina Ramírez')).toBeLessThanOrEqual(0.6);
    });
    it('nombres distintos = 0', () => {
        expect(matchScore('Camila R.', 'Mariana Castillo')).toBe(0);
    });
});

describe('pickSuggestion', () => {
    const athletes = [
        ref('1', 'Katherin Tinjaca'),
        ref('2', 'Julian Gomez'), ref('3', 'JULIAN GOMEZ'), ref('4', 'Julian Gomez'),
        ref('5', 'Mariana Castillo', 'unregistered'),
        ref('6', 'Michael castillo', 'unregistered'),
    ];

    it('sugiere cuando la coincidencia es clara', () => {
        expect(pickSuggestion('Katherin T.', athletes)?.athlete.id).toBe('1');
        expect(pickSuggestion('Michael C.', athletes)?.athlete.id).toBe('6');
        expect(pickSuggestion('Mariana C.', athletes)?.athlete.id).toBe('5');
    });
    it('NO sugiere si hay varios deportistas con el mismo nombre', () => {
        expect(pickSuggestion('Julian G.', athletes)).toBeNull();
        expect(pickSuggestion('Julian Gomez', athletes)).toBeNull();
    });
    it('NO sugiere si nada se parece', () => {
        expect(pickSuggestion('Valeria M.', athletes)).toBeNull();
    });
});

import { mergeTri, normalizeRosterUsers } from './accessRoster.service';

describe('mergeTri (credenciales de varios lectores)', () => {
    it('true si alguno la tiene', () => {
        expect(mergeTri(true, false)).toBe(true);
        expect(mergeTri(null, true)).toBe(true);
    });
    it('false solo si alguno la leyó y no está', () => {
        expect(mergeTri(false, null)).toBe(false);
        expect(mergeTri(undefined, false)).toBe(false);
    });
    it('null si ninguno la leyó (no es lo mismo que «no tiene»)', () => {
        expect(mergeTri(null, null)).toBeNull();
        expect(mergeTri(undefined, undefined)).toBeNull();
    });
});

describe('normalizeRosterUsers (lo que manda el bridge)', () => {
    it('limpia nombres, deja el rostro en null si no se leyó y deduplica por PIN', () => {
        const { users, descartados } = normalizeRosterUsers([
            { pin: '12', name: '  Bella   ', has_password: true, has_fingerprint: true, privilege: 0 },
            { pin: 12, name: 'Bella dup', has_password: false },
        ]);
        expect(descartados).toBe(0);
        expect(users).toHaveLength(1);
        expect(users[0]).toMatchObject({ pin: 12, name: 'Bella dup', has_face: null, has_fingerprint: null, has_password: false });
    });
    it('descarta lo inválido sin tumbar el lote y lo cuenta', () => {
        const { users, descartados } = normalizeRosterUsers([
            { pin: 0, name: 'cero' }, { pin: -3, name: 'neg' }, { pin: 1.5, name: 'frac' }, { pin: 'abc' },
            { pin: 100000000, name: 'enorme' }, { pin: 78, name: 'Silvana' },
        ]);
        expect(users.map(u => u.pin)).toEqual([78]);
        expect(descartados).toBe(5);
    });
    it('no admite una lista que no sea arreglo y recorta nombres largos', () => {
        expect(normalizeRosterUsers('x').users).toEqual([]);
        expect(normalizeRosterUsers([{ pin: 5, name: 'a'.repeat(300) }]).users[0].name).toHaveLength(120);
    });
});
