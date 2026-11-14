/**
 * Tabla de posiciones genérica — PURA. Reemplaza las dos copias (solo fútbol) de events.route.ts.
 * Puntos y desempates salen de la configuración del torneo; sin configuración = fútbol 3-1-0 como hoy.
 */
import { matchOutcome, orderWithExtraTiebreakers, ScoringConfig, TiebreakerKey, StandingsPoints } from './scoring.shared';

export interface StandingsTeam { id: string; team_name: string }
export interface StandingsMatch {
  home_team_id: string | null;
  away_team_id: string | null;
  home_score: number | null;
  away_score: number | null;
  status: string;
  live_state?: any;
}

export interface StandingRow {
  team_id: string;
  team_name: string;
  P: number; W: number; D: number; L: number;
  GF: number; GA: number; GD: number;
  Pts: number;
  /** Solo modelo sets */
  SW: number; SL: number; PF: number; PA: number;
  /** Solo sets: diferencias y cocientes (sets ganados/perdidos, puntos a favor/en contra).
   *  Cociente `null` = sin nada en contra (infinito, «MAX»); 0/0 = 0. Redondeado a 3 decimales. */
  set_diff: number; point_diff: number; set_ratio: number | null; point_ratio: number | null;
}

const blank = (t: StandingsTeam): StandingRow => ({
  team_id: t.id, team_name: t.team_name, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, SW: 0, SL: 0, PF: 0, PA: 0,
  set_diff: 0, point_diff: 0, set_ratio: 0, point_ratio: 0,
});

/** Cociente público: null cuando no hay nada en contra pero sí a favor (se muestra «MAX»). */
export function publicRatio(num: number, den: number): number | null {
  if (den === 0) return num === 0 ? 0 : null;
  return Math.round((num / den) * 1000) / 1000;
}

function pointsFor(pts: StandingsPoints, result: 'win' | 'draw' | 'loss', deciding: boolean): number {
  if (result === 'win') return deciding && pts.win_deciding_set != null ? pts.win_deciding_set : pts.win;
  if (result === 'loss') return deciding && pts.loss_deciding_set != null ? pts.loss_deciding_set : pts.loss;
  return pts.draw;
}

function accumulate(rows: Record<string, StandingRow>, matches: StandingsMatch[], cfg: ScoringConfig) {
  for (const m of matches) {
    const h = m.home_team_id ? rows[m.home_team_id] : undefined;
    const a = m.away_team_id ? rows[m.away_team_id] : undefined;
    if (!h || !a) continue;
    const o = matchOutcome(m, cfg);
    if (!o) continue;
    h.P++; a.P++;
    if (cfg.model === 'sets') {
      h.SW += o.setsHome; h.SL += o.setsAway; a.SW += o.setsAway; a.SL += o.setsHome;
      h.PF += o.pointsHome; h.PA += o.pointsAway; a.PF += o.pointsAway; a.PA += o.pointsHome;
    }
    h.GF += o.homeScore; h.GA += o.awayScore; a.GF += o.awayScore; a.GA += o.homeScore;
    if (o.winner === 'home') {
      h.W++; a.L++;
      h.Pts += pointsFor(cfg.standings_points, 'win', o.deciding);
      a.Pts += o.walkover ? cfg.walkover.loser_points : pointsFor(cfg.standings_points, 'loss', o.deciding);
    } else if (o.winner === 'away') {
      a.W++; h.L++;
      a.Pts += pointsFor(cfg.standings_points, 'win', o.deciding);
      h.Pts += o.walkover ? cfg.walkover.loser_points : pointsFor(cfg.standings_points, 'loss', o.deciding);
    } else {
      h.D++; a.D++;
      h.Pts += cfg.standings_points.draw; a.Pts += cfg.standings_points.draw;
    }
  }
  for (const r of Object.values(rows)) {
    r.GD = r.GF - r.GA;
    r.set_diff = r.SW - r.SL;
    r.point_diff = r.PF - r.PA;
    r.set_ratio = publicRatio(r.SW, r.SL);
    r.point_ratio = publicRatio(r.PF, r.PA);
  }
}

const BIG = 1e9;
const ratio = (num: number, den: number) => (den === 0 ? (num === 0 ? 0 : BIG) : num / den);
const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

function metric(k: Exclude<TiebreakerKey, 'head_to_head'>, r: StandingRow): number {
  switch (k) {
    case 'pts': return r.Pts;
    case 'wins': return r.W;
    case 'gd': return r.GD;
    case 'gf': return r.GF;
    case 'set_ratio': return round9(ratio(r.SW, r.SL));
    case 'point_ratio': return round9(ratio(r.PF, r.PA));
    case 'set_diff': return r.SW - r.SL;
    case 'point_diff': return r.PF - r.PA;
  }
}

function groupBy<T>(items: T[], key: (t: T) => number): T[][] {
  const sorted = [...items].sort((x, y) => key(y) - key(x));
  const out: T[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && key(last[0]) === key(it)) last.push(it); else out.push([it]);
  }
  return out;
}

/** Ordena aplicando los desempates en cascada; solo los empatados pasan al siguiente criterio. */
function order(
  teams: StandingRow[], keys: TiebreakerKey[], matches: StandingsMatch[], cfg: ScoringConfig,
): StandingRow[] {
  if (teams.length <= 1) return teams;
  if (keys.length === 0) return [...teams].sort((a, b) => a.team_name.localeCompare(b.team_name, 'es'));
  const [k, ...rest] = keys;

  if (k === 'head_to_head') {
    const ids = new Set(teams.map((t) => t.team_id));
    const mini: Record<string, StandingRow> = {};
    teams.forEach((t) => { mini[t.team_id] = blank({ id: t.team_id, team_name: t.team_name }); });
    accumulate(mini, matches.filter((m) => m.home_team_id && m.away_team_id && ids.has(m.home_team_id) && ids.has(m.away_team_id)), cfg);
    const groups = groupBy(teams, (t) => mini[t.team_id].Pts);
    if (groups.length === 1) return order(teams, rest, matches, cfg);
    return groups.flatMap((g) => order(g, g.length === teams.length ? rest : keys, matches, cfg));
  }

  const groups = groupBy(teams, (t) => metric(k, t));
  return groups.flatMap((g) => order(g, rest, matches, cfg));
}

export function computeStandings(teams: StandingsTeam[], matches: StandingsMatch[], cfg: ScoringConfig): StandingRow[] {
  const rows: Record<string, StandingRow> = {};
  teams.forEach((t) => { rows[t.id] = blank(t); });
  accumulate(rows, matches, cfg);
  const keys = cfg.tiebreakers && cfg.tiebreakers.length ? cfg.tiebreakers : (['pts', 'gd', 'gf'] as TiebreakerKey[]);
  const played = matches.filter((m) => m.status === 'played' || m.status === 'walkover');
  const ordered = order(Object.values(rows), keys, played, cfg);
  // Ajedrez (Buchholz / Sonneborn-Berger): solo entre los que siguen empatados en puntos.
  return cfg.extra_tiebreakers?.length ? orderWithExtraTiebreakers(ordered, played, cfg) : ordered;
}
