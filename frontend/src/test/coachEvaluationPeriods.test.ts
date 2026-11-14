import { describe, expect, it } from 'vitest';
import {
  lastClosedPeriod, periodEnd, periodLabel, periodStartOf, scoreWord, shiftPeriod,
} from '@/components/coach-evaluation/periods';

describe('períodos de la evaluación de entrenadores', () => {
  it('alinea el inicio como la base (_coach_eval_period_end)', () => {
    expect(periodStartOf('semanal', '2026-10-28')).toBe('2026-10-26'); // miércoles → lunes
    expect(periodStartOf('semanal', '2026-11-01')).toBe('2026-10-26'); // domingo → lunes anterior
    expect(periodStartOf('mensual', '2026-10-28')).toBe('2026-10-01');
    expect(periodStartOf('trimestral', '2026-11-15')).toBe('2026-10-01');
    expect(periodStartOf('semestral', '2026-06-30')).toBe('2026-01-01');
    expect(periodStartOf('anual', '2026-10-28')).toBe('2026-01-01');
  });

  it('fin del período, incluido febrero y fin de año', () => {
    expect(periodEnd('semanal', '2026-12-28')).toBe('2027-01-03');
    expect(periodEnd('mensual', '2028-02-01')).toBe('2028-02-29');
    expect(periodEnd('trimestral', '2026-10-01')).toBe('2026-12-31');
    expect(periodEnd('semestral', '2026-07-01')).toBe('2026-12-31');
    expect(periodEnd('anual', '2026-01-01')).toBe('2026-12-31');
  });

  it('anterior / siguiente y último cerrado', () => {
    expect(shiftPeriod('trimestral', '2026-01-01', -1)).toBe('2025-10-01');
    expect(shiftPeriod('semanal', '2026-10-26', 1)).toBe('2026-11-02');
    expect(lastClosedPeriod('mensual', '2026-10-28')).toBe('2026-09-01');
    expect(lastClosedPeriod('semanal', '2026-10-28')).toBe('2026-10-19');
  });

  it('etiquetas en palabras', () => {
    expect(periodLabel('semanal', '2026-10-05')).toBe('Semana del 5 al 11 oct 2026');
    expect(periodLabel('semanal', '2026-09-28')).toBe('Semana del 28 sep al 4 oct 2026');
    expect(periodLabel('mensual', '2026-10-01')).toBe('Octubre 2026');
    expect(periodLabel('trimestral', '2026-07-01')).toBe('T3 2026');
    expect(periodLabel('semestral', '2026-07-01')).toBe('Semestre 2 2026');
    expect(periodLabel('anual', '2026-01-01')).toBe('2026');
  });

  it('nota en palabras', () => {
    expect(scoreWord(4.4)).toBe('Bueno');
    expect(scoreWord(4.5)).toBe('Excelente');
    expect(scoreWord(null)).toBe('Sin nota');
  });
});
