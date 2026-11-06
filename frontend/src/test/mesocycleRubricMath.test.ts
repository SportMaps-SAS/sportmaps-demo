import { describe, expect, it } from 'vitest';
import { summarizeCells, summarizeRubric, type RubricCell } from '@/components/coach/mesocycleRubricMath';

const nota = (score: number): RubricCell => ({ score, na: false });
const NA: RubricCell = { score: null, na: true };

describe('promedio de la rúbrica del mesociclo con «No aplica»', () => {
  it('indicador con 3 notas, 1 N/A y 1 pendiente: «3 de 5», pendiente aparte', () => {
    const s = summarizeCells([nota(8), nota(6), nota(7), NA, undefined]);
    expect(s.average).toBe(7);
    expect(s.applicable).toBe(3);
    expect(s.na).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.total).toBe(5);
  });

  it('N/A no es 0', () => {
    expect(summarizeCells([nota(10), NA]).average).toBe(10);
  });

  it('vacío total: promedio null', () => {
    const s = summarizeCells([undefined, undefined, undefined, undefined, undefined]);
    expect(s.average).toBeNull();
    expect(s.pending).toBe(5);
  });

  it('global de 30 celdas (6 indicadores x 5 cortes)', () => {
    const inds = ['a', 'b', 'c', 'd', 'e', 'f'];
    const cps = ['1', '2', '3', '4', '5'];
    const cells = new Map<string, RubricCell>();
    for (const cp of cps) cells.set(`a__${cp}`, nota(8)); // a: 5 notas de 8
    cells.set('b__1', nota(4));
    cells.set('b__2', NA);
    cells.set('c__1', NA);
    const { byIndicator, overall } = summarizeRubric(cells, inds, cps);
    expect(byIndicator.a.average).toBe(8);
    expect(byIndicator.b.average).toBe(4);
    expect(byIndicator.d.average).toBeNull();
    expect(overall.total).toBe(30);
    expect(overall.applicable).toBe(6);
    expect(overall.na).toBe(2);
    expect(overall.pending).toBe(22);
    expect(overall.average).toBeCloseTo((8 * 5 + 4) / 6, 10);
  });
});
