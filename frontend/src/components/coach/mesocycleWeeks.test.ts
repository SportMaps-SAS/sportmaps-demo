import { describe, it, expect } from 'vitest';
import { semanaDeHoy, semanaInicialAbierta, semanaQueContiene } from './mesocycleWeeks';

const SEMANAS = [
  { id: 's1', starts_on: '2026-10-26', ends_on: '2026-11-01' },
  { id: 's2', starts_on: '2026-11-02', ends_on: '2026-11-08' },
  { id: 's3', starts_on: '2026-11-09', ends_on: '2026-11-15' },
];

describe('semanas del mesociclo', () => {
  it('la insignia «Esta semana» solo sale si la semana contiene hoy (B7)', () => {
    expect(semanaDeHoy(SEMANAS, '2026-11-03')).toBe('s2');
    // Mesociclo ya terminado: ninguna semana es «esta semana».
    expect(semanaDeHoy(SEMANAS, '2026-12-01')).toBeNull();
    // Mesociclo futuro: tampoco.
    expect(semanaDeHoy(SEMANAS, '2026-10-01')).toBeNull();
  });

  it('abre la semana del día pedido, si no la de hoy, si no la primera o la última', () => {
    expect(semanaInicialAbierta(SEMANAS, '2026-11-03', '2026-11-12')).toBe('s3');
    expect(semanaInicialAbierta(SEMANAS, '2026-11-03', '2027-01-01')).toBe('s2');
    expect(semanaInicialAbierta(SEMANAS, '2026-11-03')).toBe('s2');
    expect(semanaInicialAbierta(SEMANAS, '2026-10-01')).toBe('s1');
    expect(semanaInicialAbierta(SEMANAS, '2026-12-01')).toBe('s3');
    expect(semanaInicialAbierta([], '2026-12-01')).toBeNull();
  });

  it('los bordes de la semana cuentan', () => {
    expect(semanaQueContiene(SEMANAS, '2026-11-02')).toBe('s2');
    expect(semanaQueContiene(SEMANAS, '2026-11-08')).toBe('s2');
    expect(semanaQueContiene(SEMANAS, null)).toBeNull();
  });
});
