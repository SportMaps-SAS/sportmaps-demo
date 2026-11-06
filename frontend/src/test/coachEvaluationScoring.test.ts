import { describe, expect, it } from 'vitest';
import {
  buildScoresPayload, canPublish, formatCount, naMajority, round2, summarizeScores,
} from '@/components/coach-evaluation/scoring';

const n = (score: number) => ({ score });
const NA = { na: true };

describe('promedio de la evaluación de entrenadores con «No aplica»', () => {
  it('N/A queda fuera del numerador y del denominador', () => {
    const s = summarizeScores([n(5), n(4), NA, n(3), NA, n(5)]);
    expect(s.average).toBe(4.25);
    expect(s.applicable).toBe(4);
    expect(s.na).toBe(2);
    expect(s.total).toBe(6);
    expect(s.answered).toBe(6);
  });

  it('sin N/A es el promedio de siempre', () => {
    expect(summarizeScores([n(4), n(2)]).average).toBe(3);
  });

  it('todo N/A: promedio null, no se publica', () => {
    const s = summarizeScores([NA, NA]);
    expect(s.average).toBeNull();
    expect(canPublish(s)).toBe(false);
    expect(s.answered).toBe(2);
  });

  it('un solo aplicable alcanza para publicar', () => {
    const s = summarizeScores([NA, n(5), NA]);
    expect(s.average).toBe(5);
    expect(canPublish(s)).toBe(true);
  });

  it('ninguno respondido', () => {
    const s = summarizeScores([undefined, {}, undefined]);
    expect(s.answered).toBe(0);
    expect(s.average).toBeNull();
    expect(canPublish(s)).toBe(false);
  });

  it('aviso suave: 3 de 6 no avisa, 4 de 6 sí', () => {
    expect(naMajority(summarizeScores([NA, NA, NA, n(3), n(3), n(3)]))).toBe(false);
    expect(naMajority(summarizeScores([NA, NA, NA, NA, n(3), n(3)]))).toBe(true);
  });

  it('formato «5 de 6 ítems»', () => {
    expect(formatCount(5, 6)).toBe('5 de 6 ítems');
    expect(formatCount(1, 1)).toBe('1 de 1 ítem');
  });

  it('redondeo a 2 decimales como round(x, 2) de SQL', () => {
    expect(round2(10 / 3)).toBe(3.33);
    expect(round2(4.255)).toBe(4.26);
    expect(round2(4)).toBe(4);
  });
});

describe('payload de p_scores', () => {
  const items = [
    { id: 'a', state: { score: 4, comment: 'bien' } },
    { id: 'b', state: { na: true, comment: '' } },
    { id: 'c', state: { comment: '' } },
    { id: 'd' },
  ];

  it('flag apagado: payload idéntico al de antes (sin clave not_applicable, sin N/A)', () => {
    const out = buildScoresPayload(items, { allowNa: false });
    expect(out).toEqual([{ criterion_id: 'a', score: 4, comment: 'bien' }]);
    expect(out.every((o) => !('not_applicable' in o))).toBe(true);
  });

  it('flag encendido: N/A va {score:null, not_applicable:true}', () => {
    expect(buildScoresPayload(items, { allowNa: true })).toEqual([
      { criterion_id: 'a', score: 4, comment: 'bien' },
      { criterion_id: 'b', score: null, not_applicable: true, comment: null },
    ]);
  });
});
