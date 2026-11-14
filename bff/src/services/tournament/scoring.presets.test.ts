import { describe, it, expect } from 'vitest';
import {
  resolveConfig, derive, applyAction, SCORING_PRESETS, presetKeyForSport, validateConfig, matchOutcome,
  orderWithExtraTiebreakers, extraTiebreakValues, formatHalfPoints, LiveState, ScoringConfig, Action,
} from './scoring.shared';
import { computeStandings } from './standings.shared';

const cfgOf = (k: string) => resolveConfig(SCORING_PRESETS[k].config);
const live = (points = ''): LiveState => ({ status: 'live', points, walkover: null });

function run(cfg: ScoringConfig, actions: Action[], start: LiveState = live(), knockout = false): LiveState {
  let st = start;
  for (const a of actions) {
    const r = applyAction(st, a, cfg, { knockout });
    if (!r.ok) throw new Error(`${a.type}: ${r.code}`);
    st = r.state;
  }
  return st;
}
const pts = (seq: string): Action[] => [...seq].map((c) => ({ type: 'point', side: c === 'h' ? 'home' : 'away' }) as Action);
const finish = (cfg: ScoringConfig, st: LiveState, knockout = false) => applyAction(st, { type: 'finish' }, cfg, { knockout });
const game = (c: 'h' | 'a') => c.repeat(4);

describe('todas las plantillas', () => {
  it('cada plantilla pasa validateConfig y trae su clave', () => {
    for (const [k, p] of Object.entries(SCORING_PRESETS)) {
      expect(validateConfig(p.config), k).toBeNull();
      if (k !== 'futbol') expect(p.config.preset, k).toBe(k);
    }
  });
  it('la tabla funciona con cada plantilla (victoria + W.O.)', () => {
    for (const k of Object.keys(SCORING_PRESETS)) {
      const cfg = cfgOf(k);
      const won = cfg.model === 'sets'
        ? applyAction({ status: 'scheduled', points: '', walkover: null }, { type: 'walkover', winner: 'home' }, cfg)
        : applyAction({ status: 'scheduled', points: '', walkover: null }, { type: 'correct', home: 2, away: 0 }, cfg);
      if (!won.ok) throw new Error(k);
      const rows = computeStandings(
        [{ id: 'A', team_name: 'A' }, { id: 'B', team_name: 'B' }],
        [{ home_team_id: 'A', away_team_id: 'B', home_score: won.derived.homeScore, away_score: won.derived.awayScore, status: won.state.status, live_state: won.state }],
        cfg,
      );
      expect(rows[0].team_id, k).toBe('A');
      expect(rows[0].Pts, k).toBeGreaterThan(rows[1].Pts);
    }
  });
  it('sugerencia por nombre del deporte', () => {
    expect(presetKeyForSport('Futvóley')).toBe('futvoley');
    expect(presetKeyForSport('Beach tennis')).toBe('beach_tennis');
    expect(presetKeyForSport('Vóley playa')).toBe('voley_playa');
    expect(presetKeyForSport('Tenis')).toBe('tenis');
    expect(presetKeyForSport('Tenis de mesa')).toBe('tenis_mesa');
    expect(presetKeyForSport('Balonmano')).toBe('balonmano');
    expect(presetKeyForSport('Hockey')).toBe('hockey');
    expect(presetKeyForSport('Críquet')).toBe('criquet');
    expect(presetKeyForSport('Ajedrez')).toBe('ajedrez');
    expect(presetKeyForSport('Bochas')).toBe('bochas');
    expect(presetKeyForSport('Videojuegos (e-sports)')).toBe('videojuegos_mapas');
    expect(presetKeyForSport('FIFA')).toBe('videojuegos_goles');
    expect(presetKeyForSport('Deporte genérico')).toBe('generico');
  });
});

describe('balonmano', () => {
  const cfg = cfgOf('balonmano');
  it('victoria y empate en grupos (2-1-0)', () => {
    const win = run(cfg, [{ type: 'correct', home: 28, away: 25 }]);
    const draw = run(cfg, [{ type: 'correct', home: 24, away: 24 }]);
    const rows = computeStandings([{ id: 'A', team_name: 'A' }, { id: 'B', team_name: 'B' }, { id: 'C', team_name: 'C' }], [
      { home_team_id: 'A', away_team_id: 'B', home_score: 28, away_score: 25, status: 'played', live_state: win },
      { home_team_id: 'B', away_team_id: 'C', home_score: 24, away_score: 24, status: 'played', live_state: draw },
    ], cfg);
    expect(rows.map((r) => [r.team_id, r.Pts])).toEqual([['A', 2], ['C', 1], ['B', 1]]) // C con mejor diferencia de gol;
  });
  it('3-1-0 da 3 por victoria', () => expect(cfgOf('balonmano_3').standings_points.win).toBe(3));
  it('en eliminatoria el empate exige desempate', () => {
    const st = run(cfg, pts('hhaa'));
    expect(finish(cfg, st, true).ok).toBe(false);
  });
});

describe('hockey (penales en eliminatoria)', () => {
  const cfg = cfgOf('hockey');
  it('empate en liga termina', () => expect(finish(cfg, run(cfg, pts('ha'))).ok).toBe(true));
  it('empate en eliminatoria: con penales gana el de más penales', () => {
    const st = run(cfg, [...pts('ha'), { type: 'correct', home: 1, away: 1, penalties: [3, 4] }], live(), true);
    const r = finish(cfg, st, true);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.derived.winner).toBe('away'); expect(r.derived.byPenalties).toBe(true); expect(r.state.detail?.penalties).toEqual([3, 4]); }
  });
  it('penales sobre un marcador no empatado se rechazan', () => {
    const r = applyAction(live(), { type: 'correct', home: 2, away: 1, penalties: [3, 4] }, cfg, { knockout: true });
    expect(r.ok).toBe(false);
  });
  it('los penales sobreviven a un punto y deshacer (la secuencia no los toca)', () => {
    const st = run(cfg, [{ type: 'correct', home: 1, away: 1, penalties: [5, 4] }, ...pts('h'), { type: 'undo' }], live(), true);
    expect(derive(st, cfg).winner).toBe('home');
  });
});

describe('tenis (games con tie-break a 7, 2 de 3)', () => {
  const cfg = cfgOf('tenis');
  it('los puntos forman games: 15, 30, 40, ventaja y game', () => {
    expect(derive(live('h'), cfg).game).toMatchObject({ home: '15', away: '0' });
    expect(derive(live('hhhaaa'), cfg).game).toMatchObject({ home: '40', away: '40' });
    expect(derive(live('hhhaaah'), cfg).game).toMatchObject({ home: 'AD', away: '40' });
    const d = derive(live('hhhaaahh'), cfg);
    expect(d.sets[0]).toMatchObject({ home: 1, away: 0 });
    expect(d.game).toMatchObject({ home: '0', away: '0' });
  });
  it('6-4 cierra el set; 6-5 no', () => {
    const six4 = (game('a') + game('h')).repeat(4) + game('h') + game('h');
    expect(derive(live(six4), cfg).sets[0]).toMatchObject({ home: 6, away: 4, closed: true });
    const six5 = (game('a') + game('h')).repeat(5) + game('h');
    expect(derive(live(six5), cfg).sets[0].closed).toBe(false);
  });
  it('a 6-6 se juega tie-break a 7 con diferencia de 2 y el set queda 7-6', () => {
    const toSix = (game('a') + game('h')).repeat(6);
    const d0 = derive(live(toSix), cfg);
    expect(d0.sets[0]).toMatchObject({ home: 6, away: 6, closed: false });
    expect(d0.game?.tiebreak).toBe(true);
    // 6-6 en el tie-break: no cierra; 8-6 sí.
    const tb66 = toSix + 'ha'.repeat(6);
    expect(derive(live(tb66), cfg).sets[0].closed).toBe(false);
    const d = derive(live(tb66 + 'hh'), cfg);
    expect(d.sets[0]).toMatchObject({ home: 7, away: 6, closed: true, tb: { home: 8, away: 6 } });
  });
  it('partido completo 6-4 7-6 y no admite más puntos', () => {
    const r = applyAction({ status: 'scheduled', points: '', walkover: null }, { type: 'correct', sets: [[6, 4], [7, 6, 7, 3]] }, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.derived.winner).toBe('home');
    expect(r.derived.sets.map((s) => [s.home, s.away])).toEqual([[6, 4], [7, 6]]);
    expect(r.derived.sets[1].tb).toEqual({ home: 7, away: 3 });
    expect(r.derived.pointsHome).toBe(13);
    const again = applyAction({ ...r.state, status: 'live' }, { type: 'point', side: 'away' }, cfg);
    expect(again.ok).toBe(false);
  });
  it('corregir rechaza 6-5 y 8-6', () => {
    expect(applyAction(live(), { type: 'correct', sets: [[6, 5], [6, 0]] }, cfg).ok).toBe(false);
    expect(applyAction(live(), { type: 'correct', sets: [[8, 6], [6, 0]] }, cfg).ok).toBe(false);
  });
  it('super tie-break a 10 en el tercer set', () => {
    const sup = cfgOf('tenis_super');
    const r = applyAction(live(), { type: 'correct', sets: [[6, 3], [4, 6], [10, 8]] }, sup);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.derived.sets[2]).toMatchObject({ super: true, home: 1, away: 0, tb: { home: 10, away: 8 } }); expect(r.derived.winner).toBe('home'); }
    expect(applyAction(live(), { type: 'correct', sets: [[6, 3], [4, 6], [10, 9]] }, sup).ok).toBe(false);
  });
});

describe('beach tennis (punto de oro)', () => {
  const cfg = cfgOf('beach_tennis');
  it('a 40-40 el siguiente punto gana el game', () => {
    expect(derive(live('hhhaaaa'), cfg).sets[0]).toMatchObject({ home: 0, away: 1 });
  });
  it('a 1 set: 6-3 termina el partido', () => {
    const r = applyAction(live(), { type: 'correct', sets: [[6, 3]] }, cfg);
    expect(r.ok && r.derived.decided).toBe(true);
  });
});

describe('futvóley (18, decisivo a 15)', () => {
  const cfg = cfgOf('futvoley');
  it('18-16 cierra, 18-17 sigue, el tercero va a 15', () => {
    const r = applyAction(live(), { type: 'correct', sets: [[18, 16], [15, 18], [15, 13]] }, cfg);
    expect(r.ok && r.derived.winner).toBe('home');
    expect(applyAction(live(), { type: 'correct', sets: [[18, 17], [18, 10]] }, cfg).ok).toBe(false);
  });
});

describe('ajedrez (1 · ½ · 0)', () => {
  const cfg = cfgOf('ajedrez');
  it('tablas = medio punto para cada uno', () => {
    const tablas = run(cfg, [{ type: 'correct', home: 1, away: 1 }], { status: 'scheduled', points: '', walkover: null });
    expect(tablas.status).toBe('played');
    const rows = computeStandings([{ id: 'B', team_name: 'Blancas' }, { id: 'N', team_name: 'Negras' }],
      [{ home_team_id: 'B', away_team_id: 'N', home_score: 1, away_score: 1, status: 'played', live_state: tablas }], cfg);
    expect(rows.map((r) => r.Pts)).toEqual([0.5, 0.5]);
    expect(formatHalfPoints(1)).toBe('½');
    expect(formatHalfPoints(2)).toBe('1');
    expect(formatHalfPoints(5)).toBe('2½');
  });
  it('Buchholz y Sonneborn-Berger desempatan', () => {
    // A vence a C, B vence a D, C vence a D, A y B no juegan entre sí. A y B: 1 pt. C: 1. D: 0.
    const m = (h: string, a: string, hs: number, as: number) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'played', live_state: { status: 'played', points: 'h'.repeat(hs) + 'a'.repeat(as), walkover: null } });
    const matches = [m('A', 'C', 2, 0), m('B', 'D', 2, 0), m('C', 'D', 2, 0)];
    const teams = ['A', 'B', 'C', 'D'].map((id) => ({ id, team_name: id }));
    const rows = computeStandings(teams, matches, cfg);
    const vals = extraTiebreakValues(Object.fromEntries(rows.map((r) => [r.team_id, r.Pts])), matches, cfg);
    expect(vals.A.buchholz).toBe(1); // C tiene 1
    expect(vals.B.buchholz).toBe(0); // D tiene 0
    const ordered = orderWithExtraTiebreakers(rows, matches, cfg);
    expect(ordered.findIndex((r) => r.team_id === 'A')).toBeLessThan(ordered.findIndex((r) => r.team_id === 'B'));
  });
  it('en eliminatoria las tablas exigen desempate (armagedón)', () => {
    expect(applyAction(live(), { type: 'correct', home: 1, away: 1 }, cfg, { knockout: true }).ok).toBe(false);
    expect(applyAction(live(), { type: 'correct', home: 1, away: 1, penalties: [0, 1] }, cfg, { knockout: true }).ok).toBe(true);
  });
});

describe('bochas (a 12 / 13)', () => {
  const cfg = cfgOf('bochas');
  it('12-11 termina (diferencia de 1); 11-11 sigue', () => {
    expect(derive(live('ha'.repeat(11)), cfg).decided).toBe(false);
    const d = derive(live('ha'.repeat(11) + 'h'), cfg);
    expect(d.decided && d.winner).toBe('home');
  });
  it('a 13', () => expect(applyAction(live(), { type: 'correct', sets: [[9, 13]] }, cfgOf('bochas_13')).ok).toBe(true));
});

describe('críquet (runs / wickets / overs)', () => {
  const cfg = cfgOf('criquet');
  it('gana quien más runs; los innings quedan en el detalle', () => {
    const r = applyAction(live(), { type: 'correct', innings: [
      { side: 'home', runs: 156, wickets: 7, overs: 20 }, { side: 'away', runs: 149, wickets: 10, overs: 19.4 },
    ] }, cfg);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.derived.homeScore).toBe(156); expect(r.derived.winner).toBe('home'); expect(r.state.detail?.innings).toHaveLength(2); }
  });
  it('empate posible (2-1-0: 1 punto cada uno)', () => {
    const r = applyAction({ status: 'scheduled', points: '', walkover: null }, { type: 'correct', innings: [
      { side: 'home', runs: 140, wickets: 8, overs: 20 }, { side: 'away', runs: 140, wickets: 9, overs: 20 },
    ] }, cfg);
    expect(r.ok && r.derived.drawn).toBe(true);
    if (!r.ok) return;
    const o = matchOutcome({ status: 'played', home_score: 140, away_score: 140, live_state: r.state }, cfg);
    expect(o?.drawn).toBe(true);
    const rows = computeStandings([{ id: 'A', team_name: 'A' }, { id: 'B', team_name: 'B' }],
      [{ home_team_id: 'A', away_team_id: 'B', home_score: 140, away_score: 140, status: 'played', live_state: r.state }], cfg);
    expect(rows.map((x) => x.Pts)).toEqual([1, 1]);
  });
  it('rechaza 11 wickets u overs de más', () => {
    expect(applyAction(live(), { type: 'correct', innings: [{ side: 'home', runs: 10, wickets: 11, overs: 5 }] }, cfg).ok).toBe(false);
    expect(applyAction(live(), { type: 'correct', innings: [{ side: 'home', runs: 10, wickets: 1, overs: 21 }] }, cfg).ok).toBe(false);
    expect(applyAction(live(), { type: 'correct', innings: [{ side: 'home', runs: 10, wickets: 1, overs: 5.6 }] }, cfg).ok).toBe(false);
  });
});

describe('videojuegos', () => {
  it('al mejor de 3 mapas: cada punto es un mapa; 2-1 termina', () => {
    const cfg = cfgOf('videojuegos_mapas');
    const st = run(cfg, pts('hah'));
    const d = derive(st, cfg);
    expect([d.homeScore, d.awayScore, d.decided]).toEqual([2, 1, true]);
    expect(finish(cfg, st).ok).toBe(true);
  });
  it('mejor de 5 necesita 3', () => {
    const cfg = cfgOf('videojuegos_mapas_5');
    expect(derive(live('hhaa'), cfg).decided).toBe(false);
    expect(derive(live('hhaah'), cfg).winner).toBe('home');
  });
  it('por goles (FIFA) admite empate en grupos', () => {
    const cfg = cfgOf('videojuegos_goles');
    expect(finish(cfg, run(cfg, pts('ha'))).ok).toBe(true);
  });
});

describe('genérico', () => {
  it('con empate termina empatado; sin empate no', () => {
    expect(finish(cfgOf('generico'), run(cfgOf('generico'), pts('ha'))).ok).toBe(true);
    const sin = cfgOf('generico_sin_empate');
    expect(finish(sin, run(sin, pts('ha'))).ok).toBe(false);
    expect(finish(sin, run(sin, pts('hah'))).ok).toBe(true);
  });
});

describe('compatibilidad', () => {
  it('pádel existente (games como unidad, tope 7) no cambia', () => {
    const cfg = cfgOf('padel');
    expect(cfg.tennis).toBeUndefined();
    expect(applyAction(live(), { type: 'correct', sets: [[6, 4], [7, 6]] }, cfg).ok).toBe(true);
  });
  it('un torneo de fútbol sin configuración sigue igual', () => {
    const cfg = resolveConfig(null);
    expect(cfg.preset).toBeUndefined();
    expect(cfg.tennis).toBeUndefined();
    expect(finish(cfg, run(cfg, pts('ha'))).ok).toBe(true);
  });
});
