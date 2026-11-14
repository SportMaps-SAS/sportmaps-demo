import { describe, it, expect } from 'vitest';
import {
  resolveConfig, derive, applyAction, emptyState, matchOutcome, SCORING_PRESETS, presetKeyForSport, validateConfig,
  LiveState, ScoringConfig,
} from './scoring.shared';

const volley3 = resolveConfig(SCORING_PRESETS.voleibol_3.config);
const volley5 = resolveConfig(SCORING_PRESETS.voleibol_5.config);
const football = resolveConfig(null);

function play(cfg: ScoringConfig, seq: string, start: LiveState = { status: 'live', points: '', walkover: null }): LiveState {
  let st = start;
  for (const ch of seq) {
    const r = applyAction(st, { type: 'point', side: ch === 'h' ? 'home' : 'away' }, cfg);
    if (!r.ok) throw new Error(r.code);
    st = r.state;
  }
  return st;
}
const rep = (ch: string, n: number) => ch.repeat(n);
/** Secuencia que lleva un set a (h, a): alterna y remata con el ganador. */
const setSeq = (h: number, a: number) => (h > a ? 'ah' : 'ha').repeat(Math.min(h, a)) + rep(h > a ? 'h' : 'a', Math.abs(h - a));

describe('resolveConfig', () => {
  it('sin configuración = fútbol 3-1-0 con empate (como hoy)', () => {
    expect(football.model).toBe('goals');
    expect(football.allow_draw).toBe(true);
    expect(football.standings_points).toMatchObject({ win: 3, draw: 1, loss: 0 });
  });
  it('mezcla ajustes por categoría', () => {
    const raw = { ...SCORING_PRESETS.voleibol_3.config, by_category: { C1: { set_points: 15, deciding_set_points: 15 } } } as any;
    expect(resolveConfig(raw, 'C1').set_points).toBe(15);
    expect(resolveConfig(raw, 'otra').set_points).toBe(25);
  });
  it('best_of par se corrige a impar y sets nunca empata', () => {
    const cfg = resolveConfig({ model: 'sets', best_of: 4, set_points: 25, deciding_set_points: 15, win_by: 2 } as any);
    expect(cfg.best_of).toBe(5);
    expect(cfg.allow_draw).toBe(false);
  });
  it('plantilla sugerida por nombre del deporte', () => {
    expect(presetKeyForSport('Voleibol')).toBe('voleibol_3');
    expect(presetKeyForSport('Vóley playa')).toBe('voley_playa');
    expect(presetKeyForSport('Baloncesto')).toBe('baloncesto');
    expect(presetKeyForSport('Fútbol')).toBe('futbol');
    expect(presetKeyForSport(null)).toBe('futbol');
  });
  it('validateConfig rechaza valores absurdos', () => {
    expect(validateConfig({ model: 'x' })).toMatch(/Modelo/);
    expect(validateConfig({ best_of: 99 })).toMatch(/best_of/);
    expect(validateConfig({ model: 'sets', best_of: 3 })).toBeNull();
    expect(validateConfig(null)).toBeNull();
  });
});

describe('vóley — casos borde de un set (a 25, decisivo a 15)', () => {
  const setOf = (h: number, a: number) => derive({ points: setSeq(h, a), walkover: null, status: 'live' }, volley3).sets[0];
  it('25-23 cierra', () => expect(setOf(25, 23).closed).toBe(true));
  it('25-24 sigue', () => expect(setOf(25, 24).closed).toBe(false));
  it('26-24 cierra', () => expect(setOf(26, 24).closed).toBe(true));
  it('31-29 cierra (sin tope)', () => expect(setOf(31, 29).closed).toBe(true));
  it('24-24 sigue', () => expect(setOf(24, 24).closed).toBe(false));
  it('set decisivo 15-13 cierra y 15-14 sigue', () => {
    const third = (h: number, a: number) => derive({ points: rep('h', 25) + rep('a', 25) + setSeq(h, a), walkover: null, status: 'live' }, volley3);
    expect(third(15, 13).sets[2]).toMatchObject({ deciding: true, closed: true });
    expect(third(15, 14).sets[2].closed).toBe(false);
  });
  it('con tope (bádminton 21/30) cierra en 30-29', () => {
    const cfg = resolveConfig(SCORING_PRESETS.badminton.config);
    expect(derive({ points: 'ha'.repeat(29) + 'h', walkover: null, status: 'live' }, cfg).sets[0].closed).toBe(true);
  });
});

describe('vóley — partido a 2 de 3', () => {
  it('termina al llegar a 2 sets y no admite más puntos', () => {
    const st = play(volley3, rep('h', 25) + rep('h', 25));
    const d = derive(st, volley3);
    expect(d).toMatchObject({ decided: true, winner: 'home', homeScore: 2 });
    const r = applyAction(st, { type: 'point', side: 'away' }, volley3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('partido_decidido');
  });
  it('3 sets: el tercero es decisivo a 15', () => {
    const d = derive(play(volley3, rep('h', 25) + rep('a', 25) + rep('h', 15)), volley3);
    expect(d.sets).toHaveLength(3);
    expect(d.sets[2]).toMatchObject({ home: 15, away: 0, closed: true, deciding: true });
    expect(d.winner).toBe('home');
  });
  it('no se puede terminar un partido sin ganador', () => {
    const r = applyAction(play(volley3, rep('h', 25)), { type: 'finish' }, volley3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_decidido');
  });
  it('deshacer el último punto de un set cerrado lo reabre', () => {
    const st = play(volley3, rep('h', 25));
    expect(derive(st, volley3).sets[0].closed).toBe(true);
    const r = applyAction(st, { type: 'undo' }, volley3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(derive(r.state, volley3).sets[0]).toMatchObject({ home: 24, away: 0, closed: false });
      expect(derive(r.state, volley3).homeScore).toBe(0);
    }
  });
  it('deshacer sin puntos falla', () => {
    expect(applyAction({ status: 'live', points: '', walkover: null }, { type: 'undo' }, volley3).ok).toBe(false);
  });
  it('3 de 5: se necesitan 3 sets', () => {
    const st = play(volley5, rep('h', 25) + rep('a', 25) + rep('h', 25) + rep('a', 25));
    expect(derive(st, volley5).decided).toBe(false);
    const fin = play(volley5, rep('h', 15), st);
    expect(derive(fin, volley5)).toMatchObject({ decided: true, winner: 'home', homeScore: 3, awayScore: 2 });
    expect(derive(fin, volley5).sets[4].deciding).toBe(true);
  });
});

describe('ciclo de estados', () => {
  it('programado → en juego → terminado', () => {
    const started = applyAction(emptyState(), { type: 'start' }, volley3);
    expect(started.ok && started.state.status).toBe('live');
    const st = play(volley3, rep('h', 50), (started as any).state);
    const fin = applyAction(st, { type: 'finish' }, volley3);
    expect(fin.ok && fin.state.status).toBe('played');
  });
  it('no se puntúa sin iniciar', () => {
    const r = applyAction(emptyState(), { type: 'point', side: 'home' }, volley3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('no_en_juego');
  });
  it('no se inicia dos veces', () => {
    expect(applyAction({ status: 'live', points: '', walkover: null }, { type: 'start' }, volley3).ok).toBe(false);
  });
  it('reabrir un partido terminado lo devuelve a en juego', () => {
    const r = applyAction({ status: 'played', points: rep('h', 50), walkover: null }, { type: 'reopen' }, volley3);
    expect(r.ok && r.state.status).toBe('live');
  });
  it('cancelar solo desde programado', () => {
    expect(applyAction(emptyState(), { type: 'cancel' }, volley3).ok).toBe(true);
    expect(applyAction({ status: 'live', points: '', walkover: null }, { type: 'cancel' }, volley3).ok).toBe(false);
  });
});

describe('walkover', () => {
  it('sets: el ganador recibe los sets de la config (25-0)', () => {
    const r = applyAction(emptyState(), { type: 'walkover', winner: 'away' }, volley3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('walkover');
      expect(r.derived).toMatchObject({ homeScore: 0, awayScore: 2, winner: 'away', pointsAway: 50 });
      expect(r.derived.sets[0]).toMatchObject({ home: 0, away: 25 });
    }
  });
  it('goles: 1-0 por defecto', () => {
    const r = applyAction(emptyState(), { type: 'walkover', winner: 'home' }, football);
    expect(r.ok && r.derived).toMatchObject({ homeScore: 1, awayScore: 0, winner: 'home' });
  });
  it('no desde un partido terminado', () => {
    expect(applyAction({ status: 'played', points: '', walkover: null }, { type: 'walkover', winner: 'home' }, football).ok).toBe(false);
  });
});

describe('goles', () => {
  it('cuenta goles y permite empate en liga', () => {
    expect(derive(play(football, 'hhaah'), football)).toMatchObject({ homeScore: 3, awayScore: 2, winner: 'home' });
    expect(applyAction(play(football, 'ha'), { type: 'finish' }, football).ok).toBe(true);
  });
  it('en eliminatoria no termina empatado', () => {
    const r = applyAction(play(football, 'ha'), { type: 'finish' }, football, { knockout: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('empate_no_permitido');
  });
  it('baloncesto no admite empate', () => {
    const cfg = resolveConfig(SCORING_PRESETS.baloncesto.config);
    expect(applyAction(play(cfg, 'ha'), { type: 'finish' }, cfg).ok).toBe(false);
  });
});

describe('corregir marcador', () => {
  it('goles desde programado carga el resultado final (viejo «cargar resultado»)', () => {
    const r = applyAction(emptyState(), { type: 'correct', home: 3, away: 1 }, football);
    expect(r.ok && r.state.status).toBe('played');
    expect(r.ok && r.derived).toMatchObject({ homeScore: 3, awayScore: 1 });
  });
  it('sets válidos', () => {
    const r = applyAction(emptyState(), { type: 'correct', sets: [[25, 23], [20, 25], [15, 12]] }, volley3);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.derived).toMatchObject({ homeScore: 2, awayScore: 1, winner: 'home', decided: true });
      expect(r.derived.sets.map((s) => [s.home, s.away])).toEqual([[25, 23], [20, 25], [15, 12]]);
      expect(r.state.status).toBe('played');
    }
  });
  it('rechaza un set que no cierra, sets de más o sets de menos', () => {
    expect(applyAction(emptyState(), { type: 'correct', sets: [[25, 24], [25, 10]] }, volley3).ok).toBe(false);
    expect(applyAction(emptyState(), { type: 'correct', sets: [[25, 10], [25, 10], [25, 10]] }, volley3).ok).toBe(false);
    expect(applyAction(emptyState(), { type: 'correct', sets: [[25, 10]] }, volley3).ok).toBe(false);
  });
  it('en juego conserva el estado en juego', () => {
    const r = applyAction({ status: 'live', points: 'h', walkover: null }, { type: 'correct', home: 2, away: 2 }, football);
    expect(r.ok && r.state.status).toBe('live');
  });
});

describe('matchOutcome', () => {
  it('3-2 en vóley llegó al set decisivo', () => {
    const st = play(volley5, rep('h', 25) + rep('a', 25) + rep('h', 25) + rep('a', 25) + rep('h', 15));
    expect(matchOutcome({ status: 'played', home_score: 3, away_score: 2, live_state: st }, volley5)).toMatchObject({ winner: 'home', deciding: true, setsHome: 3, setsAway: 2 });
  });
  it('partido anterior al motor: usa el marcador entero', () => {
    expect(matchOutcome({ status: 'played', home_score: 2, away_score: 2, live_state: null }, football)).toMatchObject({ winner: null, drawn: true });
  });
  it('un partido sin terminar no tiene resultado', () => {
    expect(matchOutcome({ status: 'live', home_score: 0, away_score: 0 }, football)).toBeNull();
  });
});

describe('simulación: 200 partidos aleatorios nunca quedan inconsistentes', () => {
  it('derive y applyAction mantienen invariantes', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let n = 0; n < 200; n++) {
      const cfg = n % 2 ? volley3 : volley5;
      let st: LiveState = { status: 'live', points: '', walkover: null };
      for (let i = 0; i < 600; i++) {
        const r = applyAction(st, { type: 'point', side: rnd() < 0.5 ? 'home' : 'away' }, cfg);
        if (!r.ok) { expect(r.code).toBe('partido_decidido'); break; }
        st = r.state;
        if (rnd() < 0.05) { const u = applyAction(st, { type: 'undo' }, cfg); if (u.ok) st = u.state; }
      }
      const d = derive(st, cfg);
      expect(d.decided).toBe(true);
      expect(Math.max(d.homeScore, d.awayScore)).toBe(d.setsToWin);
      expect(d.homeScore + d.awayScore).toBeLessThanOrEqual(cfg.best_of);
      d.sets.forEach((s) => { if (s.closed) expect(Math.abs(s.home - s.away)).toBeGreaterThanOrEqual(2); });
      expect(applyAction(st, { type: 'finish' }, cfg).ok).toBe(true);
    }
  });
});

describe('validateConfig: desempates y reglas por categoría', () => {
  it('acepta los desempates nuevos de vóley y rechaza desconocidos o repetidos', async () => {
    const { validateConfig } = await import('./scoring.shared');
    expect(validateConfig({ tiebreakers: ['pts', 'set_diff', 'point_diff', 'set_ratio', 'point_ratio', 'head_to_head'] })).toBeNull();
    expect(validateConfig({ tiebreakers: ['pts', 'goles_raros'] })).toMatch(/desconocido/);
    expect(validateConfig({ tiebreakers: ['pts', 'pts'] })).toMatch(/repetido/);
  });
  it('valida cada categoría (Mini a 1 set de 15) y no deja anidar by_category', async () => {
    const { validateConfig, resolveConfig } = await import('./scoring.shared');
    const raw = { ...SCORING_PRESETS.voleibol_3.config, by_category: { mini: { best_of: 1, set_points: 15, deciding_set_points: 15 } } };
    expect(validateConfig(raw)).toBeNull();
    expect(resolveConfig(raw as any, 'mini')).toMatchObject({ model: 'sets', best_of: 1, set_points: 15 });
    expect(resolveConfig(raw as any, 'otra')).toMatchObject({ best_of: 3, set_points: 25 });
    expect(validateConfig({ by_category: { x: { best_of: 20 } } })).toMatch(/Categoría/);
    expect(validateConfig({ by_category: { x: { by_category: {} } } })).toMatch(/no puede/);
  });
});
