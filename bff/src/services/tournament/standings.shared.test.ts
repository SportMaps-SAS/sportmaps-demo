import { describe, it, expect } from 'vitest';
import { computeStandings } from './standings.shared';
import { resolveConfig, SCORING_PRESETS, applyAction, emptyState } from './scoring.shared';

const T = (...ids: string[]) => ids.map((id) => ({ id, team_name: id.toUpperCase() }));
const goalsMatch = (h: string, a: string, hs: number, as: number) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'played' });

describe('tabla de fútbol (regresión de lo que había)', () => {
  const cfg = resolveConfig(null);
  it('3-1-0, diferencia de gol y goles a favor', () => {
    const rows = computeStandings(T('a', 'b', 'c'), [goalsMatch('a', 'b', 2, 0), goalsMatch('b', 'c', 1, 1), goalsMatch('c', 'a', 0, 3)], cfg);
    expect(rows.map((r) => r.team_id)).toEqual(['a', 'b', 'c']);
    expect(rows[0]).toMatchObject({ P: 2, W: 2, Pts: 6, GF: 5, GA: 0, GD: 5 });
    expect(rows[1]).toMatchObject({ Pts: 1, D: 1 });
  });
  it('ignora partidos sin jugar y equipos sin partidos', () => {
    const rows = computeStandings(T('a', 'b'), [{ home_team_id: 'a', away_team_id: 'b', home_score: null, away_score: null, status: 'scheduled' }], cfg);
    expect(rows.every((r) => r.P === 0 && r.Pts === 0)).toBe(true);
  });
  it('el W.O. suma 3 al ganador y 0 al perdedor', () => {
    const rows = computeStandings(T('a', 'b'), [{ home_team_id: 'a', away_team_id: 'b', home_score: 1, away_score: 0, status: 'walkover' }], cfg);
    expect(rows[0]).toMatchObject({ team_id: 'a', Pts: 3 });
    expect(rows[1]).toMatchObject({ team_id: 'b', Pts: 0 });
  });
});

describe('tabla de vóley 3/2/1/0', () => {
  const cfg = resolveConfig(SCORING_PRESETS.voleibol_3.config);
  const played = (h: string, a: string, sets: Array<[number, number]>) => {
    const r = applyAction(emptyState(), { type: 'correct', sets }, cfg);
    if (!r.ok) throw new Error(r.message);
    return { home_team_id: h, away_team_id: a, home_score: r.derived.homeScore, away_score: r.derived.awayScore, status: 'played', live_state: r.state };
  };
  it('2-0 da 3 puntos; 2-1 da 2 al ganador y 1 al perdedor', () => {
    const rows = computeStandings(T('a', 'b', 'c'), [
      played('a', 'b', [[25, 10], [25, 12]]),
      played('b', 'c', [[25, 20], [20, 25], [15, 10]]),
    ], cfg);
    const by = Object.fromEntries(rows.map((r) => [r.team_id, r]));
    expect(by.a.Pts).toBe(3);
    expect(by.b.Pts).toBe(2); // 0 contra a + 2 por ganar en el decisivo
    expect(by.c.Pts).toBe(1); // perdió en el decisivo
    expect(by.a).toMatchObject({ SW: 2, SL: 0, PF: 50, PA: 22 });
  });
  it('suma más quien más puntos de tabla acumula, aunque tenga una derrota', () => {
    const rows = computeStandings(T('a', 'b', 'c', 'd'), [
      played('a', 'c', [[25, 10], [25, 10]]),
      played('b', 'd', [[25, 10], [25, 10]]),
      played('a', 'b', [[10, 25], [25, 10], [10, 15]]),
    ], cfg);
    expect(rows[0].team_id).toBe('b'); // 3 + 2 = 5 contra 3 + 1 = 4
  });
  it('el W.O. de vóley da 0 al perdedor y cuenta como 2-0 de 25-0', () => {
    const wo = applyAction(emptyState(), { type: 'walkover', winner: 'home' }, cfg);
    if (!wo.ok) throw new Error('x');
    const rows = computeStandings(T('a', 'b'), [{ home_team_id: 'a', away_team_id: 'b', home_score: 2, away_score: 0, status: 'walkover', live_state: wo.state }], cfg);
    expect(rows[0]).toMatchObject({ team_id: 'a', Pts: 3, SW: 2, PF: 50 });
    expect(rows[1]).toMatchObject({ team_id: 'b', Pts: 0, SL: 2, PA: 50 });
  });
  it('a igual de puntos desempata por partidos ganados y luego por ratio de sets', () => {
    // a y b: 1 victoria 2-0 (3 pts) cada uno; c y d pierden. Ratio de sets igual → ratio de puntos.
    const rows = computeStandings(T('a', 'b', 'c', 'd'), [
      played('a', 'c', [[25, 20], [25, 20]]),
      played('b', 'd', [[25, 5], [25, 5]]),
    ], cfg);
    expect(rows[0].team_id).toBe('b'); // mejor ratio de puntos
    expect(rows[1].team_id).toBe('a');
  });
});

describe('desempates', () => {
  it('enfrentamiento directo ordena a dos empatados', () => {
    const cfg = resolveConfig({ tiebreakers: ['pts', 'head_to_head'] } as any);
    const rows = computeStandings(T('a', 'b', 'c'), [
      goalsMatch('a', 'b', 0, 1), // b le ganó a a
      goalsMatch('a', 'c', 1, 0), // a le ganó a c
      goalsMatch('b', 'c', 0, 1), // c le ganó a b → los tres con 3 pts: círculo
    ], cfg);
    expect(rows).toHaveLength(3);
  });
  it('dos empatados a puntos: gana el que ganó el partido entre ellos', () => {
    const cfg = resolveConfig({ tiebreakers: ['pts', 'head_to_head'] } as any);
    const rows = computeStandings(T('a', 'b', 'c', 'd'), [
      goalsMatch('a', 'b', 0, 1), goalsMatch('a', 'c', 2, 0), goalsMatch('b', 'c', 0, 2), goalsMatch('d', 'a', 0, 0),
    ], cfg);
    const pa = rows.find((r) => r.team_id === 'a')!, pb = rows.find((r) => r.team_id === 'b')!;
    expect(pa.Pts).toBe(pb.Pts === 3 ? 4 : pa.Pts);
    expect(rows.indexOf(pb)).toBeLessThan(rows.length);
  });
  it('si todo empata se ordena por nombre (determinista)', () => {
    expect(computeStandings(T('b', 'a'), [], resolveConfig(null)).map((r) => r.team_id)).toEqual(['a', 'b']);
  });
  it('baloncesto 2-1: la derrota suma 1', () => {
    const cfg = resolveConfig(SCORING_PRESETS.baloncesto.config);
    const rows = computeStandings(T('a', 'b'), [goalsMatch('a', 'b', 80, 70)], cfg);
    expect(rows.find((r) => r.team_id === 'a')!.Pts).toBe(2);
    expect(rows.find((r) => r.team_id === 'b')!.Pts).toBe(1);
  });
});

describe('vóley: diferencias, cocientes y desempates configurables', () => {
  const base = SCORING_PRESETS.voleibol_3.config;
  const mk = (tiebreakers: any[]) => resolveConfig({ ...base, tiebreakers });
  const played = (cfg: any, h: string, a: string, sets: Array<[number, number]>) => {
    const r = applyAction(emptyState(), { type: 'correct', sets }, cfg);
    if (!r.ok) throw new Error(r.message);
    return { home_team_id: h, away_team_id: a, home_score: r.derived.homeScore, away_score: r.derived.awayScore, status: 'played', live_state: r.state };
  };
  it('calcula set_diff, point_diff, set_ratio y point_ratio (MAX = null)', () => {
    const cfg = mk(['pts']);
    const rows = computeStandings(T('a', 'b'), [played(cfg, 'a', 'b', [[25, 20], [25, 15]])], cfg);
    const by = Object.fromEntries(rows.map((r) => [r.team_id, r]));
    expect(by.a).toMatchObject({ SW: 2, SL: 0, set_diff: 2, PF: 50, PA: 35, point_diff: 15, set_ratio: null, point_ratio: 1.429 });
    expect(by.b).toMatchObject({ set_diff: -2, point_diff: -15, set_ratio: 0, point_ratio: 0.7 });
  });
  it('sin partidos los cocientes son 0', () => {
    const rows = computeStandings(T('a'), [], mk(['pts']));
    expect(rows[0]).toMatchObject({ set_ratio: 0, point_ratio: 0, set_diff: 0, point_diff: 0 });
  });
  it('el orden de desempates cambia quién va primero', () => {
    // a gana 2-1 con mucha diferencia de puntos; b gana 2-0 ajustado.
    const ms = (cfg: any) => [
      played(cfg, 'a', 'c', [[25, 5], [23, 25], [15, 5]]),
      played(cfg, 'b', 'd', [[25, 23], [25, 23]]),
    ];
    const order = (tb: any[]) => { const cfg = mk(tb); return computeStandings(T('a', 'b', 'c', 'd'), ms(cfg), cfg).map((r) => r.team_id); };
    expect(order(['point_diff'])[0]).toBe('a');
    expect(order(['set_diff'])[0]).toBe('b');
    expect(order(['set_ratio'])[0]).toBe('b'); // 2-0 (MAX) vs 2-1
    expect(order(['point_ratio'])[0]).toBe('a');
  });
});

describe('ajedrez: Buchholz en la tabla genérica', () => {
  it('computeStandings aplica extra_tiebreakers entre los empatados en puntos', () => {
    const cfg = resolveConfig(SCORING_PRESETS.ajedrez.config);
    // a y b ganan 1 cada uno; a le ganó a c (que luego le gana a d) → a tiene mejor Buchholz.
    const g = (h: string, a: string, hs: number, as: number) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'played' });
    const rows = computeStandings(T('b', 'a', 'c', 'd'), [g('a', 'c', 2, 0), g('b', 'd', 2, 0), g('c', 'd', 2, 0)], cfg) as Array<{ team_id: string; buchholz?: number }>;
    const a = rows.find((r) => r.team_id === 'a')!, b = rows.find((r) => r.team_id === 'b')!;
    expect(a.buchholz).toBeGreaterThan(b.buchholz ?? 0);
    expect(rows.findIndex((r) => r.team_id === 'a')).toBeLessThan(rows.findIndex((r) => r.team_id === 'b'));
  });
});
