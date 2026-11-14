import { describe, it, expect } from 'vitest';
import { rankByMark, parseMark, formatMark, teamPoints, POINTS_8, MarkEntry } from './marks.shared';

const e = (id: string, marks: Array<number | null>, extra: Partial<MarkEntry> = {}): MarkEntry => ({ participant_id: id, name: id, marks, ...extra });

describe('ranking por marca', () => {
  it('tiempo: menor es mejor y DNF va al final sin posición', () => {
    const r = rankByMark([e('A', [11.2]), e('B', [10.9]), e('C', [], { status: 'dnf' }), e('D', [11.05])], { unit: 'time', points_by_position: POINTS_8 });
    expect(r.map((x) => [x.participant_id, x.position, x.points])).toEqual([['B', 1, 10], ['D', 2, 8], ['A', 3, 6], ['C', null, 0]]);
  });
  it('tiempo: empate comparte posición y reparte los puntos', () => {
    const r = rankByMark([e('A', [10.5]), e('B', [10.5]), e('C', [10.8])], { unit: 'time', points_by_position: POINTS_8 });
    expect(r.map((x) => [x.position, x.points, x.tied])).toEqual([[1, 9, true], [1, 9, true], [3, 6, false]]);
  });
  it('distancia: mejor marca y desempate por la segunda mejor; los nulos no cuentan', () => {
    const r = rankByMark([e('A', [6.4, null, 6.1]), e('B', [6.4, 6.3, null]), e('C', [null, null, null])], { unit: 'distance' });
    expect(r.map((x) => [x.participant_id, x.position])).toEqual([['B', 1], ['A', 2], ['C', null]]);
  });
  it('altura: desempate por menos fallos', () => {
    const r = rankByMark([e('A', [1.8], { failures_at_best: 2 }), e('B', [1.8], { failures_at_best: 0 })], { unit: 'height' });
    expect(r[0].participant_id).toBe('B');
  });
  it('puntos por delegación', () => {
    const p1 = rankByMark([e('A', [10], { team_id: 'X' }), e('B', [11], { team_id: 'Y' })], { unit: 'time', points_by_position: POINTS_8 });
    const p2 = rankByMark([e('C', [5], { team_id: 'Y' }), e('D', [6], { team_id: 'X' })], { unit: 'distance', points_by_position: POINTS_8 });
    expect(teamPoints([p1, p2])).toEqual([{ team_id: 'X', points: 20, golds: 2 }, { team_id: 'Y', points: 16, golds: 0 }]);
  });
  it('lee y escribe marcas', () => {
    expect(parseMark('10,52', 'time')).toBe(10.52);
    expect(parseMark('1:02.35', 'time')).toBe(62.35);
    expect(parseMark('6.45 m', 'distance')).toBe(6.45);
    expect(parseMark('1:75', 'time')).toBeNull();
    expect(parseMark('abc', 'distance')).toBeNull();
    expect(formatMark(62.35, 'time')).toBe('1:02.35');
    expect(formatMark(10.5, 'time')).toBe('10.50');
    expect(formatMark(6.45, 'distance')).toBe('6.45 m');
  });
});
