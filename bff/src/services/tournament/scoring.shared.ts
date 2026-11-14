/**
 * Motor de marcador de torneos — PURO (sin base de datos ni red).
 *
 * Modelos: `goals` (fútbol, futsal, baloncesto, balonmano, hockey, ajedrez, críquet…) y `sets`
 * (vóley, pádel, bádminton, tenis de mesa, bochas, e-sports por mapas… y tenis/beach tennis con
 * `tennis`: puntos → games → sets con tie-break).
 * El estado de un partido en vivo es una SECUENCIA de puntos ('h' = local, 'a' visitante):
 * todo lo demás (sets, marcador, quién ganó) se DERIVA de ella. Así «deshacer» es quitar el
 * último punto, y un set cerrado se reabre solo. Lo que no cabe en la secuencia (penales,
 * innings de críquet) va en `detail`, que solo cambia con «corregir».
 *
 * Una copia idéntica vive en frontend/src/lib/tournamentScoring.ts (para la cola offline del
 * anotador); una prueba falla si dejan de ser iguales. Editar AMBAS.
 */

export type Side = 'home' | 'away';
export type ScoreModel = 'goals' | 'sets';
export type MatchStatus = 'scheduled' | 'live' | 'played' | 'walkover' | 'cancelled';
export type TiebreakerKey =
  | 'pts' | 'wins' | 'gd' | 'gf' | 'set_ratio' | 'point_ratio' | 'set_diff' | 'point_diff' | 'head_to_head';

/** Desempates disponibles, en el orden en que se ofrecen al organizador. */
export const TIEBREAKER_KEYS: TiebreakerKey[] = ['pts', 'wins', 'set_ratio', 'point_ratio', 'set_diff', 'point_diff', 'gd', 'gf', 'head_to_head'];
/** Desempates que la tabla genérica todavía no sabe calcular: se aplican con `orderWithExtraTiebreakers`. */
export type ExtraTiebreakerKey = 'buchholz' | 'sonneborn_berger';

export interface StandingsPoints {
  win: number;
  draw: number;
  loss: number;
  /** Solo sets: victoria / derrota cuando el partido llegó al set decisivo (ej. vóley 2 y 1). */
  win_deciding_set?: number;
  loss_deciding_set?: number;
}

/** Reglas de tenis / beach tennis: la secuencia son PUNTOS; set_points = games para ganar el set. */
export interface TennisRules {
  /** A cuántos games iguales se juega tie-break (6). null = sin tie-break (se juega con ventaja). */
  tiebreak_at: number | null;
  /** Puntos del tie-break (7, diferencia de 2). */
  tiebreak_points: number;
  /** Si no es null, el set decisivo se reemplaza por un super tie-break a estos puntos (10). */
  super_tiebreak_points: number | null;
  /** Punto de oro a 40-40 (beach tennis, pádel sin ventaja). */
  golden_point: boolean;
}

export interface ScoringConfig {
  model: ScoreModel;
  /** Plantilla de la que salió (para que el anotador y la planilla sepan el deporte). */
  preset?: string;
  /** goals: ¿se permite empatar? (fútbol de liga sí; baloncesto no). */
  allow_draw: boolean;
  /** sets */
  best_of: number;
  set_points: number;
  deciding_set_points: number;
  win_by: number;
  cap: number | null;
  /** sets: tenis (puntos → games → sets). Ausente = cada punto suma directo al set. */
  tennis?: TennisRules | null;
  /** goals: el marcador se lleva en medios puntos (ajedrez: 2-0 = 1-0, 1-1 = ½-½). */
  half_points?: boolean;
  /** goals: críquet (runs / wickets / overs por innings). */
  cricket?: { overs: number } | null;
  standings_points: StandingsPoints;
  walkover: {
    loser_points: number;
    /** sets: marcador de cada set ganado por W.O. */
    set_score: [number, number];
    /** goals: marcador del W.O. (ganador, perdedor). */
    goals: [number, number];
  };
  tiebreakers: TiebreakerKey[];
  /** Desempates posteriores a `tiebreakers` (ajedrez: Buchholz, Sonneborn-Berger). */
  extra_tiebreakers?: ExtraTiebreakerKey[];
  by_category?: Record<string, Partial<Omit<ScoringConfig, 'by_category'>>>;
}

export const FOOTBALL_DEFAULT: ScoringConfig = {
  model: 'goals',
  allow_draw: true,
  best_of: 1,
  set_points: 0,
  deciding_set_points: 0,
  win_by: 1,
  cap: null,
  standings_points: { win: 3, draw: 1, loss: 0 },
  walkover: { loser_points: 0, set_score: [25, 0], goals: [1, 0] },
  tiebreakers: ['pts', 'gd', 'gf', 'head_to_head'],
};

const VOLLEY_TB: TiebreakerKey[] = ['pts', 'wins', 'set_ratio', 'point_ratio', 'head_to_head'];
const RACKET_TB: TiebreakerKey[] = ['pts', 'set_ratio', 'point_ratio', 'head_to_head'];
const GOALS_TB: TiebreakerKey[] = ['pts', 'gd', 'gf', 'head_to_head'];
const VOLLEY_PTS: StandingsPoints = { win: 3, draw: 0, loss: 0, win_deciding_set: 2, loss_deciding_set: 1 };
const TENNIS: TennisRules = { tiebreak_at: 6, tiebreak_points: 7, super_tiebreak_points: null, golden_point: false };

/** Plantillas por deporte/modalidad. La escuela elige una; nunca edita JSON. */
export const SCORING_PRESETS: Record<string, { label: string; config: Partial<ScoringConfig> }> = {
  futbol: { label: 'Fútbol / Futsal (3-1-0, empates)', config: {} },
  baloncesto: {
    label: 'Baloncesto (2-1, sin empates)',
    config: { preset: 'baloncesto', allow_draw: false, standings_points: { win: 2, draw: 0, loss: 1 }, tiebreakers: GOALS_TB, walkover: { loser_points: 0, set_score: [25, 0], goals: [20, 0] } },
  },
  voleibol_3: {
    label: 'Vóley a 2 de 3 sets (25, decisivo a 15)',
    config: { preset: 'voleibol_3', model: 'sets', best_of: 3, set_points: 25, deciding_set_points: 15, win_by: 2, cap: null, allow_draw: false,
      standings_points: VOLLEY_PTS, tiebreakers: VOLLEY_TB },
  },
  voleibol_5: {
    label: 'Vóley a 3 de 5 sets (25, decisivo a 15)',
    config: { preset: 'voleibol_5', model: 'sets', best_of: 5, set_points: 25, deciding_set_points: 15, win_by: 2, cap: null, allow_draw: false,
      standings_points: VOLLEY_PTS, tiebreakers: VOLLEY_TB },
  },
  voley_playa: {
    label: 'Vóley playa a 2 de 3 sets (21, decisivo a 15)',
    config: { preset: 'voley_playa', model: 'sets', best_of: 3, set_points: 21, deciding_set_points: 15, win_by: 2, cap: null, allow_draw: false,
      standings_points: VOLLEY_PTS, tiebreakers: VOLLEY_TB, walkover: { loser_points: 0, set_score: [21, 0], goals: [1, 0] } },
  },
  badminton: {
    label: 'Bádminton a 2 de 3 sets (21, tope 30)',
    config: { preset: 'badminton', model: 'sets', best_of: 3, set_points: 21, deciding_set_points: 21, win_by: 2, cap: 30, allow_draw: false,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [21, 0], goals: [1, 0] } },
  },
  tenis_mesa: {
    label: 'Tenis de mesa a 3 de 5 sets (11)',
    config: { preset: 'tenis_mesa', model: 'sets', best_of: 5, set_points: 11, deciding_set_points: 11, win_by: 2, cap: null, allow_draw: false,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [11, 0], goals: [1, 0] } },
  },
  padel: {
    label: 'Pádel a 2 de 3 sets (a 6 games, diferencia de 2, tope 7)',
    config: { preset: 'padel', model: 'sets', best_of: 3, set_points: 6, deciding_set_points: 6, win_by: 2, cap: 7, allow_draw: false,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [6, 0], goals: [1, 0] } },
  },
  // ── Nuevos (2026-10-27) ─────────────────────────────────────────────────────
  balonmano: {
    label: 'Balonmano (2-1-0, empates en grupos)',
    config: { preset: 'balonmano', allow_draw: true, standings_points: { win: 2, draw: 1, loss: 0 }, tiebreakers: GOALS_TB, walkover: { loser_points: 0, set_score: [25, 0], goals: [10, 0] } },
  },
  balonmano_3: {
    label: 'Balonmano (3-1-0, empates en grupos)',
    config: { preset: 'balonmano_3', allow_draw: true, standings_points: { win: 3, draw: 1, loss: 0 }, tiebreakers: GOALS_TB, walkover: { loser_points: 0, set_score: [25, 0], goals: [10, 0] } },
  },
  hockey: {
    label: 'Hockey (3-1-0, empates; penales en eliminatoria)',
    config: { preset: 'hockey', allow_draw: true, standings_points: { win: 3, draw: 1, loss: 0 }, tiebreakers: GOALS_TB, walkover: { loser_points: 0, set_score: [25, 0], goals: [5, 0] } },
  },
  tenis: {
    label: 'Tenis a 2 de 3 sets (a 6 games, tie-break a 7)',
    config: { preset: 'tenis', model: 'sets', best_of: 3, set_points: 6, deciding_set_points: 6, win_by: 2, cap: null, allow_draw: false, tennis: TENNIS,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [6, 0], goals: [1, 0] } },
  },
  tenis_super: {
    label: 'Tenis a 2 de 3 sets (tie-break a 7; el tercero es super tie-break a 10)',
    config: { preset: 'tenis_super', model: 'sets', best_of: 3, set_points: 6, deciding_set_points: 6, win_by: 2, cap: null, allow_draw: false,
      tennis: { ...TENNIS, super_tiebreak_points: 10 },
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [6, 0], goals: [1, 0] } },
  },
  beach_tennis: {
    label: 'Beach tennis a 1 set (a 6 games, tie-break a 7, punto de oro)',
    config: { preset: 'beach_tennis', model: 'sets', best_of: 1, set_points: 6, deciding_set_points: 6, win_by: 2, cap: null, allow_draw: false,
      tennis: { ...TENNIS, golden_point: true },
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [6, 0], goals: [1, 0] } },
  },
  beach_tennis_3: {
    label: 'Beach tennis a 2 de 3 sets (a 6 games, tie-break a 7, punto de oro)',
    config: { preset: 'beach_tennis_3', model: 'sets', best_of: 3, set_points: 6, deciding_set_points: 6, win_by: 2, cap: null, allow_draw: false,
      tennis: { ...TENNIS, golden_point: true },
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: RACKET_TB, walkover: { loser_points: 0, set_score: [6, 0], goals: [1, 0] } },
  },
  futvoley: {
    label: 'Futvóley a 2 de 3 sets (18, decisivo a 15)',
    config: { preset: 'futvoley', model: 'sets', best_of: 3, set_points: 18, deciding_set_points: 15, win_by: 2, cap: null, allow_draw: false,
      standings_points: VOLLEY_PTS, tiebreakers: VOLLEY_TB, walkover: { loser_points: 0, set_score: [18, 0], goals: [1, 0] } },
  },
  ajedrez: {
    label: 'Ajedrez (1 · ½ · 0; desempate Buchholz y Sonneborn-Berger)',
    config: { preset: 'ajedrez', allow_draw: true, half_points: true, standings_points: { win: 1, draw: 0.5, loss: 0 },
      tiebreakers: ['pts', 'head_to_head', 'wins'], extra_tiebreakers: ['buchholz', 'sonneborn_berger'],
      walkover: { loser_points: 0, set_score: [1, 0], goals: [2, 0] } },
  },
  bochas: {
    label: 'Bochas a 12 puntos',
    config: { preset: 'bochas', model: 'sets', best_of: 1, set_points: 12, deciding_set_points: 12, win_by: 1, cap: null, allow_draw: false,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: ['pts', 'point_ratio', 'head_to_head'], walkover: { loser_points: 0, set_score: [12, 0], goals: [1, 0] } },
  },
  bochas_13: {
    label: 'Bochas / petanca a 13 puntos',
    config: { preset: 'bochas_13', model: 'sets', best_of: 1, set_points: 13, deciding_set_points: 13, win_by: 1, cap: null, allow_draw: false,
      standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: ['pts', 'point_ratio', 'head_to_head'], walkover: { loser_points: 0, set_score: [13, 0], goals: [1, 0] } },
  },
  criquet: {
    label: 'Críquet (runs / wickets / overs; 2-1-0, empate posible)',
    config: { preset: 'criquet', allow_draw: true, cricket: { overs: 20 }, standings_points: { win: 2, draw: 1, loss: 0 },
      tiebreakers: ['pts', 'wins', 'gd', 'head_to_head'], walkover: { loser_points: 0, set_score: [25, 0], goals: [1, 0] } },
  },
  videojuegos_mapas: {
    label: 'Videojuegos al mejor de 3 mapas / partidas',
    config: { preset: 'videojuegos_mapas', model: 'sets', best_of: 3, set_points: 1, deciding_set_points: 1, win_by: 1, cap: null, allow_draw: false,
      standings_points: { win: 3, draw: 0, loss: 0 }, tiebreakers: ['pts', 'wins', 'set_ratio', 'head_to_head'], walkover: { loser_points: 0, set_score: [1, 0], goals: [1, 0] } },
  },
  videojuegos_mapas_5: {
    label: 'Videojuegos al mejor de 5 mapas / partidas',
    config: { preset: 'videojuegos_mapas_5', model: 'sets', best_of: 5, set_points: 1, deciding_set_points: 1, win_by: 1, cap: null, allow_draw: false,
      standings_points: { win: 3, draw: 0, loss: 0 }, tiebreakers: ['pts', 'wins', 'set_ratio', 'head_to_head'], walkover: { loser_points: 0, set_score: [1, 0], goals: [1, 0] } },
  },
  videojuegos_goles: {
    label: 'Videojuegos por goles (FIFA / eFootball, 3-1-0)',
    config: { preset: 'videojuegos_goles', allow_draw: true, standings_points: { win: 3, draw: 1, loss: 0 }, tiebreakers: GOALS_TB, walkover: { loser_points: 0, set_score: [1, 0], goals: [3, 0] } },
  },
  generico: {
    label: 'Genérico: marcador libre con empate (3-1-0)',
    config: { preset: 'generico', allow_draw: true, standings_points: { win: 3, draw: 1, loss: 0 }, tiebreakers: GOALS_TB },
  },
  generico_sin_empate: {
    label: 'Genérico: marcador libre sin empate (2-0)',
    config: { preset: 'generico_sin_empate', allow_draw: false, standings_points: { win: 2, draw: 0, loss: 0 }, tiebreakers: GOALS_TB },
  },
};

/** Plantilla sugerida según el nombre visible del deporte. */
export function presetKeyForSport(sport: string | null | undefined): string {
  const s = (sport ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/futvoley|futevolei|footvolley|futvolei/.test(s)) return 'futvoley';
  if (/beach\s*tennis|tenis\s*playa/.test(s)) return 'beach_tennis';
  if (/voley.*playa|beach/.test(s)) return 'voley_playa';
  if (/voley|volley|voleibol/.test(s)) return 'voleibol_3';
  if (/baloncesto|basket|basquet/.test(s)) return 'baloncesto';
  if (/balonmano|handball/.test(s)) return 'balonmano';
  if (/badminton/.test(s)) return 'badminton';
  if (/tenis.*mesa|ping/.test(s)) return 'tenis_mesa';
  if (/padel/.test(s)) return 'padel';
  if (/tenis|tennis/.test(s)) return 'tenis';
  if (/hockey/.test(s)) return 'hockey';
  if (/criquet|cricket/.test(s)) return 'criquet';
  if (/ajedrez|chess/.test(s)) return 'ajedrez';
  if (/bocha|petanca|bocce/.test(s)) return 'bochas';
  if (/fifa|efootball/.test(s)) return 'videojuegos_goles';
  if (/videojuego|e-?sports?|gaming/.test(s)) return 'videojuegos_mapas';
  if (/generico|otro|atletismo/.test(s)) return 'generico';
  return 'futbol';
}

function mergeConfig(base: ScoringConfig, over: Partial<ScoringConfig> | null | undefined): ScoringConfig {
  if (!over) return base;
  return {
    ...base,
    ...over,
    standings_points: { ...base.standings_points, ...(over.standings_points ?? {}) },
    walkover: { ...base.walkover, ...(over.walkover ?? {}) },
    tiebreakers: over.tiebreakers && over.tiebreakers.length ? over.tiebreakers : base.tiebreakers,
    tennis: over.tennis === undefined ? base.tennis : over.tennis ? { ...(base.tennis ?? TENNIS), ...over.tennis } : null,
  } as ScoringConfig;
}

/**
 * Configuración efectiva: defaults de fútbol ← config del torneo ← ajustes de la categoría.
 * `raw = null` (torneo sin scoring_config) = fútbol 3-1-0, exactamente como hoy.
 */
export function resolveConfig(raw: Partial<ScoringConfig> | null | undefined, categoryId?: string | null): ScoringConfig {
  let cfg = mergeConfig(FOOTBALL_DEFAULT, raw ? { ...raw, by_category: undefined } : null);
  const cat = categoryId && raw?.by_category ? raw.by_category[categoryId] : null;
  if (cat) cfg = mergeConfig(cfg, cat);
  if (cfg.tennis === undefined) delete cfg.tennis;
  if (cfg.model === 'sets') {
    cfg.best_of = cfg.best_of % 2 === 0 ? cfg.best_of + 1 : Math.max(1, cfg.best_of);
    cfg.allow_draw = false;
  }
  return cfg;
}

export function validateConfig(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'La configuración de marcador debe ser un objeto';
  const c = raw as Record<string, any>;
  if (c.model != null && c.model !== 'goals' && c.model !== 'sets') return 'Modelo de marcador no soportado (goals | sets)';
  const num = (v: any, min: number, max: number) => v == null || (Number.isInteger(v) && v >= min && v <= max);
  if (!num(c.best_of, 1, 9)) return 'best_of debe ser un entero entre 1 y 9';
  if (!num(c.set_points, 1, 100) || !num(c.deciding_set_points, 1, 100)) return 'Los puntos por set deben estar entre 1 y 100';
  if (!num(c.win_by, 1, 5)) return 'win_by debe estar entre 1 y 5';
  if (c.cap != null && !num(c.cap, 1, 200)) return 'cap inválido';
  if (c.tiebreakers != null) {
    if (!Array.isArray(c.tiebreakers) || c.tiebreakers.length > TIEBREAKER_KEYS.length) return 'Los desempates deben ser una lista';
    if (c.tiebreakers.some((k: unknown) => !TIEBREAKER_KEYS.includes(k as TiebreakerKey))) return 'Hay un desempate desconocido';
    if (new Set(c.tiebreakers).size !== c.tiebreakers.length) return 'Un desempate está repetido';
  }
  if (c.by_category != null) {
    if (typeof c.by_category !== 'object' || Array.isArray(c.by_category)) return 'Las reglas por categoría deben ser un objeto';
    for (const sub of Object.values(c.by_category)) {
      if (sub != null && typeof sub === 'object' && 'by_category' in (sub as object)) return 'Una categoría no puede tener reglas por categoría';
      const bad = validateConfig(sub);
      if (bad) return `Categoría: ${bad}`;
    }
  }
  if (c.tennis != null) {
    const t = c.tennis;
    if (typeof t !== 'object' || Array.isArray(t)) return 'Reglas de tenis inválidas';
    if (t.tiebreak_at != null && !num(t.tiebreak_at, 1, 20)) return 'tiebreak_at inválido';
    if (!num(t.tiebreak_points, 1, 30) || (t.super_tiebreak_points != null && !num(t.super_tiebreak_points, 1, 30))) return 'Puntos de tie-break inválidos';
  }
  if (c.cricket != null && (typeof c.cricket !== 'object' || !num(c.cricket.overs, 1, 100))) return 'Overs de críquet inválidos (1 a 100)';
  return null;
}

// ── Estado y derivación ──────────────────────────────────────────────────────

/** Críquet: un innings por equipo. `overs` en notación de críquet (19.4 = 19 overs y 4 bolas). */
export interface CricketInnings { side: Side; runs: number; wickets: number; overs: number }

/** Lo que no cabe en la secuencia de puntos. Solo lo cambia «corregir». */
export interface MatchDetail {
  /** Desempate de un partido empatado (penales, shoot-out, super over, armagedón): [local, visitante]. */
  penalties?: [number, number] | null;
  innings?: CricketInnings[] | null;
}

export interface LiveState {
  status: MatchStatus;
  /** Secuencia de puntos/goles: 'h' local, 'a' visitante. */
  points: string;
  /** Si el partido se resolvió por W.O., quién ganó. */
  walkover?: Side | null;
  detail?: MatchDetail | null;
}

export interface SetScore {
  home: number; away: number; closed: boolean; deciding: boolean;
  /** Tenis: puntos del tie-break (o del super tie-break) si se jugó. */
  tb?: { home: number; away: number };
  /** Tenis: el set decisivo se jugó como super tie-break (home/away = 1-0). */
  super?: boolean;
}

export interface Derived {
  homeScore: number; // sets ganados (sets) o goles (goals)
  awayScore: number;
  sets: SetScore[];
  setsToWin: number;
  /** El marcador ya define un ganador (sets) / hay al menos un resultado válido (goals). */
  decided: boolean;
  winner: Side | null;
  drawn: boolean;
  /** Puntos totales a favor (sets) o goles. En tenis: games. */
  pointsHome: number;
  pointsAway: number;
  /** Tenis: el game en juego («15», «40», «AD») o los puntos del tie-break. */
  game?: { home: string; away: string; tiebreak: boolean } | null;
  /** goals: el empate se resolvió por penales / desempate. */
  byPenalties?: boolean;
}

export function setsToWin(cfg: ScoringConfig): number {
  return Math.floor(cfg.best_of / 2) + 1;
}

export function setTarget(cfg: ScoringConfig, setIndex: number): number {
  return setIndex === cfg.best_of - 1 ? cfg.deciding_set_points : cfg.set_points;
}

export function isSetClosed(home: number, away: number, target: number, winBy: number, cap: number | null): boolean {
  const max = Math.max(home, away);
  if (cap != null && max >= cap) return true;
  return max >= target && Math.abs(home - away) >= winBy;
}

const GAME_LABEL = ['0', '15', '30', '40'];

function gameLabels(h: number, a: number): { home: string; away: string } {
  if (h >= 3 && a >= 3) {
    if (h === a) return { home: '40', away: '40' };
    return h > a ? { home: 'AD', away: '40' } : { home: '40', away: 'AD' };
  }
  return { home: GAME_LABEL[Math.min(h, 3)], away: GAME_LABEL[Math.min(a, 3)] };
}

/** Tenis: puntos → games → sets, con tie-break, super tie-break y punto de oro. */
function deriveTennis(points: string, cfg: ScoringConfig): Derived {
  const t = cfg.tennis as TennisRules;
  const need = setsToWin(cfg);
  const sets: SetScore[] = [];
  let wonH = 0, wonA = 0;
  let cur: SetScore | null = null;
  let gh = 0, ga = 0;
  const close = (s: SetScore, homeWon: boolean) => {
    s.closed = true;
    if (homeWon) wonH++; else wonA++;
    cur = null;
  };
  for (const ch of points) {
    if (ch !== 'h' && ch !== 'a') continue;
    if (wonH >= need || wonA >= need) break;
    if (!cur) {
      const deciding = sets.length === cfg.best_of - 1;
      const sup = deciding && cfg.best_of > 1 && t.super_tiebreak_points != null;
      const fresh: SetScore = { home: 0, away: 0, closed: false, deciding };
      if (sup) { fresh.super = true; fresh.tb = { home: 0, away: 0 }; }
      sets.push(fresh);
      cur = fresh;
      gh = 0; ga = 0;
    }
    const s: SetScore = cur;
    if (s.tb) {
      if (ch === 'h') s.tb.home++; else s.tb.away++;
      const target = s.super ? (t.super_tiebreak_points as number) : t.tiebreak_points;
      if (Math.max(s.tb.home, s.tb.away) >= target && Math.abs(s.tb.home - s.tb.away) >= 2) {
        const homeWon = s.tb.home > s.tb.away;
        if (s.super) { s.home = homeWon ? 1 : 0; s.away = homeWon ? 0 : 1; } else if (homeWon) s.home++; else s.away++;
        close(s, homeWon);
      }
      continue;
    }
    if (ch === 'h') gh++; else ga++;
    const w = Math.max(gh, ga), l = Math.min(gh, ga);
    const gameWon = w >= 4 && (w - l >= 2 || (t.golden_point && l === 3));
    if (!gameWon) continue;
    if (gh > ga) s.home++; else s.away++;
    gh = 0; ga = 0;
    const target = setTarget(cfg, sets.length - 1);
    if (t.tiebreak_at != null && s.home === t.tiebreak_at && s.away === t.tiebreak_at) {
      s.tb = { home: 0, away: 0 };
    } else if (Math.max(s.home, s.away) >= target && Math.abs(s.home - s.away) >= cfg.win_by) {
      close(s, s.home > s.away);
    }
  }
  const decided = wonH >= need || wonA >= need;
  const open = sets.find((x) => !x.closed) ?? null;
  const game = decided ? null : open?.tb
    ? { home: String(open.tb.home), away: String(open.tb.away), tiebreak: true }
    : { ...gameLabels(gh, ga), tiebreak: false };
  return {
    homeScore: wonH, awayScore: wonA, sets, setsToWin: need, decided,
    winner: decided ? (wonH > wonA ? 'home' : 'away') : null, drawn: false,
    pointsHome: sets.reduce((acc, x) => acc + x.home, 0), pointsAway: sets.reduce((acc, x) => acc + x.away, 0),
    game,
  };
}

export function derive(state: Pick<LiveState, 'points' | 'walkover' | 'status'> & { detail?: MatchDetail | null }, cfg: ScoringConfig): Derived {
  const need = setsToWin(cfg);

  if (state.walkover) {
    if (cfg.model === 'sets') {
      const [w, l] = cfg.walkover.set_score;
      const sets: SetScore[] = Array.from({ length: need }, (_, i) => ({
        home: state.walkover === 'home' ? w : l, away: state.walkover === 'home' ? l : w, closed: true, deciding: i === cfg.best_of - 1,
      }));
      const pw = w * need, pl = l * need;
      return {
        homeScore: state.walkover === 'home' ? need : 0, awayScore: state.walkover === 'away' ? need : 0,
        sets, setsToWin: need, decided: true, winner: state.walkover, drawn: false,
        pointsHome: state.walkover === 'home' ? pw : pl, pointsAway: state.walkover === 'away' ? pw : pl,
      };
    }
    const [w, l] = cfg.walkover.goals;
    return {
      homeScore: state.walkover === 'home' ? w : l, awayScore: state.walkover === 'away' ? w : l,
      sets: [], setsToWin: need, decided: true, winner: state.walkover, drawn: false,
      pointsHome: state.walkover === 'home' ? w : l, pointsAway: state.walkover === 'away' ? w : l,
    };
  }

  if (cfg.model === 'goals') {
    let h = 0, a = 0;
    for (const ch of state.points) { if (ch === 'h') h++; else if (ch === 'a') a++; }
    const pen = state.detail?.penalties;
    if (h === a && Array.isArray(pen) && pen[0] !== pen[1]) {
      return {
        homeScore: h, awayScore: a, sets: [], setsToWin: need, decided: true,
        winner: pen[0] > pen[1] ? 'home' : 'away', drawn: false, pointsHome: h, pointsAway: a, byPenalties: true,
      };
    }
    return {
      homeScore: h, awayScore: a, sets: [], setsToWin: need, decided: true,
      winner: h > a ? 'home' : a > h ? 'away' : null, drawn: h === a, pointsHome: h, pointsAway: a,
    };
  }

  if (cfg.tennis) return deriveTennis(state.points, cfg);

  const sets: SetScore[] = [];
  let wonH = 0, wonA = 0;
  let cur: SetScore | null = null;
  for (const ch of state.points) {
    if (ch !== 'h' && ch !== 'a') continue;
    if (wonH >= need || wonA >= need) break; // puntos sobrantes tras decidirse: se ignoran
    if (!cur) { cur = { home: 0, away: 0, closed: false, deciding: sets.length === cfg.best_of - 1 }; sets.push(cur); }
    if (ch === 'h') cur.home++; else cur.away++;
    if (isSetClosed(cur.home, cur.away, setTarget(cfg, sets.length - 1), cfg.win_by, cfg.cap)) {
      cur.closed = true;
      if (cur.home > cur.away) wonH++; else wonA++;
      cur = null;
    }
  }
  const decided = wonH >= need || wonA >= need;
  return {
    homeScore: wonH, awayScore: wonA, sets, setsToWin: need, decided,
    winner: decided ? (wonH > wonA ? 'home' : 'away') : null, drawn: false,
    pointsHome: sets.reduce((s, x) => s + x.home, 0), pointsAway: sets.reduce((s, x) => s + x.away, 0),
  };
}

// ── Acciones ─────────────────────────────────────────────────────────────────

/** Un set para «corregir»: [local, visitante] y, en tenis, opcionalmente los puntos del tie-break. */
export type SetEntry = [number, number] | [number, number, number, number];

export type Action =
  | { type: 'start' }
  | { type: 'point'; side: Side }
  | { type: 'undo' }
  | { type: 'finish' }
  | { type: 'reopen' }
  | { type: 'cancel' }
  | { type: 'walkover'; winner: Side }
  /**
   * goals: { home, away } (+ penales si quedó empatado; críquet: innings, y home/away salen de los runs).
   * sets: { sets: [[25,23],[20,25],[15,12]] }; tenis: [7,6,7,4] = 7-6 con tie-break 7-4; super tie-break: [10,8].
   */
  | { type: 'correct'; home?: number; away?: number; sets?: SetEntry[]; penalties?: [number, number] | null; innings?: CricketInnings[] | null };

export const ACTION_TYPES = ['start', 'point', 'undo', 'finish', 'reopen', 'cancel', 'walkover', 'correct'] as const;

export interface ApplyContext {
  /** Fase eliminatoria: no se admite empate al terminar. */
  knockout?: boolean;
}

export type ApplyResult =
  | { ok: true; state: LiveState; derived: Derived }
  | { ok: false; code: string; message: string };

const fail = (code: string, message: string): ApplyResult => ({ ok: false, code, message });

export function emptyState(status: MatchStatus = 'scheduled'): LiveState {
  return { status, points: '', walkover: null };
}

/** Alterna hasta igualar al perdedor y luego suma los del ganador (nunca cierra antes del final si las reglas lo permiten). */
function alternate(h: number, a: number, unitH: string, unitA: string): string {
  const hi = Math.max(h, a), lo = Math.min(h, a);
  const win = h > a ? unitH : unitA, lose = h > a ? unitA : unitH;
  let seq = '';
  for (let i = 0; i < lo; i++) seq += lose + win;
  for (let i = 0; i < hi - lo; i++) seq += win;
  return seq;
}

/** Genera una secuencia de puntos que cierra el set justo en el marcador pedido (o null si es imposible). */
function sequenceForSet(h: number, a: number, target: number, cfg: ScoringConfig): string | null {
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h === a) return null;
  const winCh = h > a ? 'h' : 'a';
  const seq = alternate(h, a, 'h', 'a');
  if (!isSetClosed(h, a, target, cfg.win_by, cfg.cap)) return null;
  // Debe cerrar SOLO en el último punto.
  let ch = 0, cw = 0;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === winCh) cw++; else ch++;
    const closed = isSetClosed(winCh === 'h' ? cw : ch, winCh === 'h' ? ch : cw, target, cfg.win_by, cfg.cap);
    if (closed && i < seq.length - 1) return null;
  }
  return seq;
}

const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** Tenis: secuencia de PUNTOS para un set (games a cero; tie-break por defecto 7-5 o 10-8). */
function tennisSetSequence(entry: number[], idx: number, cfg: ScoringConfig): string | null {
  const t = cfg.tennis as TennisRules;
  const sup = idx === cfg.best_of - 1 && cfg.best_of > 1 && t.super_tiebreak_points != null;
  const [h, a] = entry.map(Number);
  if (!isInt(h, 0, 99) || !isInt(a, 0, 99) || h === a) return null;
  if (sup) return alternate(h, a, 'h', 'a');
  const tbAt = t.tiebreak_at;
  const isTb = tbAt != null && Math.max(h, a) === tbAt + 1 && Math.min(h, a) === tbAt;
  const gH = 'hhhh', gA = 'aaaa';
  if (!isTb) return alternate(h, a, gH, gA);
  const homeWon = h > a;
  let x = Number(entry[2]), y = Number(entry[3]);
  if (entry.length < 4) { x = homeWon ? t.tiebreak_points : t.tiebreak_points - 2; y = homeWon ? t.tiebreak_points - 2 : t.tiebreak_points; }
  if (!isInt(x, 0, 99) || !isInt(y, 0, 99) || (x > y) !== homeWon) return null;
  return (gA + gH).repeat(tbAt as number) + alternate(x, y, 'h', 'a');
}

function validInnings(list: unknown, cfg: ScoringConfig): CricketInnings[] | null {
  if (!Array.isArray(list) || list.length === 0 || list.length > 4) return null;
  const maxOvers = cfg.cricket?.overs ?? 100;
  const out: CricketInnings[] = [];
  for (const raw of list) {
    const i = raw as CricketInnings;
    if (!i || (i.side !== 'home' && i.side !== 'away')) return null;
    if (!isInt(i.runs, 0, 999) || !isInt(i.wickets, 0, 10)) return null;
    const ov = Number(i.overs);
    const balls = Math.round((ov - Math.floor(ov)) * 10);
    if (!Number.isFinite(ov) || ov < 0 || ov > maxOvers || balls > 5) return null;
    out.push({ side: i.side, runs: i.runs, wickets: i.wickets, overs: ov });
  }
  return out;
}

export function applyAction(state: LiveState, action: Action, cfg: ScoringConfig, ctx: ApplyContext = {}): ApplyResult {
  const s: LiveState = { status: state.status, points: state.points ?? '', walkover: state.walkover ?? null };
  if (state.detail) s.detail = state.detail;
  const done = (next: LiveState): ApplyResult => ({ ok: true, state: next, derived: derive(next, cfg) });

  switch (action.type) {
    case 'start':
      if (s.status !== 'scheduled') return fail('estado_invalido', 'Solo un partido programado puede iniciarse');
      return done({ ...s, status: 'live' });

    case 'point': {
      if (s.status !== 'live') return fail('no_en_juego', 'El partido no está en juego');
      if (action.side !== 'home' && action.side !== 'away') return fail('lado_invalido', 'Lado inválido');
      if (cfg.model === 'sets' && derive(s, cfg).decided) return fail('partido_decidido', 'El partido ya está decidido: termínalo o deshaz el último punto');
      return done({ ...s, points: s.points + (action.side === 'home' ? 'h' : 'a') });
    }

    case 'undo': {
      if (s.status !== 'live') return fail('no_en_juego', 'Solo se deshace con el partido en juego');
      if (!s.points) return fail('nada_que_deshacer', 'No hay puntos que deshacer');
      return done({ ...s, points: s.points.slice(0, -1) });
    }

    case 'finish': {
      if (s.status !== 'live') return fail('no_en_juego', 'El partido no está en juego');
      const d = derive(s, cfg);
      if (cfg.model === 'sets' && !d.decided) return fail('no_decidido', 'Aún no se define el ganador del partido');
      if (cfg.model === 'goals' && d.drawn && (!cfg.allow_draw || ctx.knockout)) {
        return fail('empate_no_permitido', ctx.knockout ? 'En eliminatoria no puede terminar empatado: define el desempate' : 'En este deporte no hay empate');
      }
      return done({ ...s, status: 'played' });
    }

    case 'reopen':
      if (s.status !== 'played' && s.status !== 'walkover') return fail('estado_invalido', 'Solo se reabre un partido terminado');
      return done({ ...s, status: 'live', walkover: null });

    case 'cancel':
      if (s.status !== 'scheduled') return fail('estado_invalido', 'Solo se cancela un partido programado');
      return done({ ...s, status: 'cancelled' });

    case 'walkover': {
      if (s.status !== 'scheduled' && s.status !== 'live') return fail('estado_invalido', 'El W.O. se declara en un partido programado o en juego');
      if (action.winner !== 'home' && action.winner !== 'away') return fail('lado_invalido', 'Indica quién gana por W.O.');
      return done({ status: 'walkover', points: '', walkover: action.winner });
    }

    case 'correct': {
      if (s.status === 'cancelled') return fail('estado_invalido', 'Un partido cancelado no admite marcador');
      let points = '';
      let detail: MatchDetail | null = null;
      if (cfg.model === 'goals') {
        let h = action.home, a = action.away;
        if (cfg.cricket && action.innings != null) {
          const inn = validInnings(action.innings, cfg);
          if (!inn) return fail('marcador_invalido', 'Innings inválidos: runs 0-999, wickets 0-10 y overs dentro del límite');
          h = inn.filter((x) => x.side === 'home').reduce((acc, x) => acc + x.runs, 0);
          a = inn.filter((x) => x.side === 'away').reduce((acc, x) => acc + x.runs, 0);
          detail = { innings: inn };
        }
        if (!isInt(h, 0, 999) || !isInt(a, 0, 999)) return fail('marcador_invalido', 'Marcador inválido');
        const pen = action.penalties;
        if (pen != null) {
          if (!Array.isArray(pen) || !isInt(pen[0], 0, 99) || !isInt(pen[1], 0, 99) || pen[0] === pen[1]) return fail('marcador_invalido', 'El desempate debe tener un ganador');
          if (h !== a) return fail('marcador_invalido', 'El desempate solo aplica a un partido empatado');
          detail = { ...(detail ?? {}), penalties: [pen[0], pen[1]] };
        }
        if (h === a && pen == null && (!cfg.allow_draw || ctx.knockout)) {
          return fail('empate_no_permitido', ctx.knockout ? 'En eliminatoria no puede terminar empatado: define el desempate' : 'En este deporte no hay empate');
        }
        points = 'h'.repeat(h as number) + 'a'.repeat(a as number);
      } else {
        const list = action.sets;
        if (!Array.isArray(list) || list.length === 0) return fail('marcador_invalido', 'Indica el marcador de cada set');
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          const seq = !Array.isArray(e) ? null
            : cfg.tennis ? tennisSetSequence(e as number[], i, cfg)
              : sequenceForSet(Number(e[0]), Number(e[1]), setTarget(cfg, i), cfg);
          if (seq == null) return fail('marcador_invalido', `El set ${i + 1} no es un marcador válido para estas reglas`);
          points += seq;
        }
        const d = derive({ points, walkover: null, status: s.status }, cfg);
        if (d.sets.length !== list.length || !d.sets.every((x) => x.closed)) return fail('marcador_invalido', 'Hay sets de más o sets sin cerrar');
        if (cfg.tennis) {
          for (let i = 0; i < list.length; i++) {
            const got = d.sets[i];
            const [eh, ea] = [Number(list[i][0]), Number(list[i][1])];
            const ok = got.super ? got.tb?.home === eh && got.tb?.away === ea : got.home === eh && got.away === ea;
            if (!ok) return fail('marcador_invalido', `El set ${i + 1} no es un marcador válido para estas reglas`);
          }
        }
        if (!d.decided) return fail('marcador_invalido', 'Los sets no definen un ganador');
      }
      // Desde «programado» el marcador cargado cierra el partido (equivale al viejo «cargar resultado»).
      const status: MatchStatus = s.status === 'scheduled' || s.status === 'walkover' ? 'played' : s.status;
      const next: LiveState = { status, points, walkover: null };
      if (detail) next.detail = detail;
      return done(next);
    }

    default:
      return fail('accion_desconocida', 'Acción desconocida');
  }
}

/** Resultado de un partido para la tabla, a partir de su estado (o del marcador entero si es anterior al motor). */
export interface Outcome {
  winner: Side | null;
  drawn: boolean;
  homeScore: number; awayScore: number; // sets ganados o goles
  setsHome: number; setsAway: number;
  pointsHome: number; pointsAway: number;
  deciding: boolean; // llegó al set decisivo
  walkover: boolean;
}

export function matchOutcome(
  m: { status: string; home_score: number | null; away_score: number | null; live_state?: Partial<LiveState> | null },
  cfg: ScoringConfig,
): Outcome | null {
  if (m.status !== 'played' && m.status !== 'walkover') return null;
  const ls = m.live_state && typeof m.live_state === 'object' ? m.live_state : null;
  if (ls && (typeof ls.points === 'string' || ls.walkover)) {
    const d = derive({ points: ls.points ?? '', walkover: (ls.walkover as Side | null) ?? null, status: m.status as MatchStatus, detail: ls.detail ?? null }, cfg);
    const total = d.homeScore + d.awayScore;
    return {
      winner: d.winner, drawn: d.drawn, homeScore: d.homeScore, awayScore: d.awayScore,
      setsHome: cfg.model === 'sets' ? d.homeScore : 0, setsAway: cfg.model === 'sets' ? d.awayScore : 0,
      pointsHome: d.pointsHome, pointsAway: d.pointsAway,
      deciding: cfg.model === 'sets' && cfg.best_of > 1 && total === cfg.best_of, walkover: m.status === 'walkover',
    };
  }
  // Partido anterior al motor: solo marcador entero.
  const hs = Number(m.home_score ?? 0), as = Number(m.away_score ?? 0);
  const winner: Side | null = hs > as ? 'home' : as > hs ? 'away' : null;
  return {
    winner, drawn: hs === as, homeScore: hs, awayScore: as,
    setsHome: cfg.model === 'sets' ? hs : 0, setsAway: cfg.model === 'sets' ? as : 0,
    pointsHome: hs, pointsAway: as,
    deciding: cfg.model === 'sets' && cfg.best_of > 1 && hs + as === cfg.best_of, walkover: m.status === 'walkover',
  };
}

// ── Ajedrez: Buchholz y Sonneborn-Berger ─────────────────────────────────────

export interface ExtraTiebreakMatch {
  home_team_id: string | null; away_team_id: string | null;
  home_score: number | null; away_score: number | null; status: string; live_state?: any;
}

/**
 * Buchholz = suma de los puntos de tabla de los rivales enfrentados.
 * Sonneborn-Berger = suma de los puntos de los rivales vencidos + la mitad de los de los empatados.
 * `pts` = puntos de tabla ya calculados (computeStandings).
 */
export function extraTiebreakValues(
  pts: Record<string, number>, matches: ExtraTiebreakMatch[], cfg: ScoringConfig,
): Record<string, { buchholz: number; sonneborn_berger: number }> {
  const out: Record<string, { buchholz: number; sonneborn_berger: number }> = {};
  for (const id of Object.keys(pts)) out[id] = { buchholz: 0, sonneborn_berger: 0 };
  for (const m of matches) {
    const h = m.home_team_id, a = m.away_team_id;
    if (!h || !a || !out[h] || !out[a]) continue;
    const o = matchOutcome(m, cfg);
    if (!o) continue;
    out[h].buchholz += pts[a]; out[a].buchholz += pts[h];
    if (o.winner === 'home') out[h].sonneborn_berger += pts[a];
    else if (o.winner === 'away') out[a].sonneborn_berger += pts[h];
    else { out[h].sonneborn_berger += pts[a] / 2; out[a].sonneborn_berger += pts[h] / 2; }
  }
  return out;
}

/**
 * Reordena una tabla ya ordenada aplicando `cfg.extra_tiebreakers` SOLO entre filas que quedaron
 * empatadas en puntos. Orden estable: si siguen empatadas, conserva el orden recibido.
 */
export function orderWithExtraTiebreakers<T extends { team_id: string; Pts: number }>(
  rows: T[], matches: ExtraTiebreakMatch[], cfg: ScoringConfig,
): Array<T & { buchholz?: number; sonneborn_berger?: number }> {
  const keys = cfg.extra_tiebreakers ?? [];
  if (keys.length === 0) return rows;
  const pts: Record<string, number> = {};
  rows.forEach((r) => { pts[r.team_id] = r.Pts; });
  const vals = extraTiebreakValues(pts, matches.filter((m) => m.status === 'played' || m.status === 'walkover'), cfg);
  const withVals = rows.map((r, i) => ({ ...r, ...vals[r.team_id], _i: i }));
  withVals.sort((x, y) => {
    if (y.Pts !== x.Pts) return x._i - y._i; // otro criterio ya los separó: no se toca
    for (const k of keys) { const dv = (y[k] ?? 0) - (x[k] ?? 0); if (Math.abs(dv) > 1e-9) return dv; }
    return x._i - y._i;
  });
  return withVals.map(({ _i, ...r }) => r as unknown as T & { buchholz?: number; sonneborn_berger?: number });
}

/** Ajedrez: «1», «½», «0», «1½»… desde medios puntos. */
export function formatHalfPoints(halves: number): string {
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (!half) return String(whole);
  return whole === 0 ? '½' : `${whole}½`;
}
