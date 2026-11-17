import { describe, it, expect, afterEach } from 'vitest';
import {
    esFestivoColombia, festivosColombia, domingoDePascua, fijarFestivosDeLaBase, olvidarFestivosDeLaBase,
} from './festivos-colombia';

// Calendarios oficiales verificados el 2026-10-04 contra prensa nacional
// (El País Cali / Caracol para 2025-2026, El Universal para 2027) y la
// Ley 2578 de 2026 (Virgen de Chiquinquirá, 9 de julio con traslado).
const OFICIAL_2025 = [
    '2025-01-01', '2025-01-06', '2025-03-24', '2025-04-17', '2025-04-18',
    '2025-05-01', '2025-06-02', '2025-06-23',
    '2025-06-30', // San Pedro y Sagrado Corazón el MISMO lunes
    '2025-07-20', '2025-08-07', '2025-08-18', '2025-10-13', '2025-11-03',
    '2025-11-17', '2025-12-08', '2025-12-25',
];

const OFICIAL_2026 = [
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03',
    '2026-05-01', '2026-05-18', '2026-06-08', '2026-06-15', '2026-06-29',
    '2026-07-13', // Virgen de Chiquinquirá (9 jul jueves → lunes 13)
    '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02',
    '2026-11-16', '2026-12-08', '2026-12-25',
];

const OFICIAL_2027 = [
    '2027-01-01', '2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26',
    '2027-05-01', '2027-05-10', '2027-05-31', '2027-06-07', '2027-07-05',
    '2027-07-12', '2027-07-20', '2027-08-07', '2027-08-16', '2027-10-18',
    '2027-11-01', '2027-11-15', '2027-12-08', '2027-12-25',
];

describe('la tabla co_holidays es la fuente; el cálculo es la red de seguridad', () => {
    afterEach(() => olvidarFestivosDeLaBase());

    it('lo leído de la base manda sobre el cálculo, y avisa de las diferencias', () => {
        const tabla = festivosColombia(2027).filter((d) => d !== '2027-07-12').concat('2027-09-09');
        const r = fijarFestivosDeLaBase(tabla);
        expect(r.anios).toEqual([2027]);
        expect(r.diferencias).toEqual(['2027-07-12 (solo en el cálculo)', '2027-09-09 (solo en la tabla)']);
        expect(esFestivoColombia('2027-09-09')).toBe(true);
        expect(esFestivoColombia('2027-07-12')).toBe(false);
    });

    it('un año que la tabla no trae, o que llega a medias, se calcula', () => {
        fijarFestivosDeLaBase(['2031-01-01', '2031-12-25']);   // a medias: no reemplaza
        expect(esFestivoColombia('2031-05-01')).toBe(true);
        expect(esFestivoColombia('2040-01-01')).toBe(true);
    });

    it('Virgen de Chiquinquirá con traslado: 13-jul-2026, 12-jul-2027, 10-jul-2028', () => {
        for (const d of ['2026-07-13', '2027-07-12', '2028-07-10']) expect(esFestivoColombia(d)).toBe(true);
    });
});

describe('festivos-colombia', () => {
    it('Pascua: 2025-04-20, 2026-04-05, 2027-03-28', () => {
        expect(domingoDePascua(2025)).toEqual({ mes: 4, dia: 20 });
        expect(domingoDePascua(2026)).toEqual({ mes: 4, dia: 5 });
        expect(domingoDePascua(2027)).toEqual({ mes: 3, dia: 28 });
    });

    it.each([
        [2025, OFICIAL_2025],
        [2026, OFICIAL_2026],
        [2027, OFICIAL_2027],
    ])('calendario %i coincide exacto con el oficial', (anio, oficial) => {
        expect(festivosColombia(anio)).toEqual([...oficial].sort());
    });

    it('cada fecha oficial es festivo y el día anterior hábil no lo es', () => {
        for (const f of [...OFICIAL_2025, ...OFICIAL_2026, ...OFICIAL_2027]) {
            expect(esFestivoColombia(f)).toBe(true);
        }
        expect(esFestivoColombia('2026-10-13')).toBe(false); // martes después del puente
        expect(esFestivoColombia('2026-07-09')).toBe(false); // Chiquinquirá se trasladó
        expect(esFestivoColombia('2025-07-14')).toBe(false); // antes de la Ley 2578 no existía
    });

    it('Date se evalúa en hora de Bogotá, no en UTC', () => {
        // Lunes 12-oct-2026 21:00 COT = martes 13-oct 02:00 UTC → sigue siendo festivo.
        expect(esFestivoColombia(new Date('2026-10-13T02:00:00Z'))).toBe(true);
        // Lunes 12-oct 03:00 UTC = domingo 11-oct 22:00 COT → no es festivo.
        expect(esFestivoColombia(new Date('2026-10-12T03:00:00Z'))).toBe(false);
        expect(esFestivoColombia(new Date('2026-10-12T05:00:00Z'))).toBe(true); // 00:00 COT
        expect(esFestivoColombia('2026-10-12T00:30:00-05:00')).toBe(true);
    });

    it('entrada inválida → false, no lanza', () => {
        expect(esFestivoColombia('no-es-fecha')).toBe(false);
        expect(esFestivoColombia(new Date('x'))).toBe(false);
    });
});
