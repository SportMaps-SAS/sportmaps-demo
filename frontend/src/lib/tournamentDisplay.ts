/**
 * Helpers de presentación de torneos en vivo — PUROS (etiquetas, marcadores, horas, agrupaciones).
 */
import type { MatchStatus, MatchStage, SetDto, StandingRow } from '@/lib/tournamentTypes';

export interface DisplayMatch {
  id: string;
  stage: MatchStage;
  group_label: string | null;
  round: number;
  slot: number;
  home_name: string | null;
  away_name: string | null;
  home_label: string | null;
  away_label: string | null;
  home_score: number | null;
  away_score: number | null;
  status: MatchStatus;
  scheduled_at: string | null;
  court: string | null;
  sets: SetDto[];
  model: 'goals' | 'sets';
  category_id: string;
  is_bye?: boolean;
}

export const STATUS_LABEL: Record<MatchStatus, string> = {
  scheduled: 'Programado', live: 'En juego', played: 'Terminado', walkover: 'W.O.', cancelled: 'Cancelado',
};

export const TIMEZONE = 'America/Bogota';

export function teamName(m: Pick<DisplayMatch, 'home_name' | 'away_name' | 'home_label' | 'away_label'>, side: 'home' | 'away'): string {
  const name = side === 'home' ? m.home_name : m.away_name;
  const label = side === 'home' ? m.home_label : m.away_label;
  return name || label || ((m as { is_bye?: boolean }).is_bye ? 'Pasa directo' : 'Por definir');
}

/** «25-23 · 20-25 · 15-12» (solo sets). */
export function formatSetsLine(sets: SetDto[] | null | undefined): string {
  return (sets ?? []).map((s) => `${s.home}-${s.away}`).join(' · ');
}

/** «2 - 1» o «vs» si aún no hay marcador. */
export function scoreText(m: Pick<DisplayMatch, 'home_score' | 'away_score' | 'status'>): string {
  if (m.home_score == null || m.away_score == null) return 'vs';
  return `${m.home_score} - ${m.away_score}`;
}

/** Etiqueta del set en curso para un partido en juego (sets), p. ej. «Set 2 · 14-12». */
export function currentSetText(sets: SetDto[] | null | undefined): string | null {
  const list = sets ?? [];
  const open = list.find((s) => !s.closed);
  if (!open) return null;
  return `Set ${list.indexOf(open) + 1} · ${open.home}-${open.away}`;
}

export function stageLabel(m: Pick<DisplayMatch, 'stage' | 'group_label' | 'round'>): string {
  switch (m.stage) {
    case 'league': return `Jornada ${m.round}`;
    case 'group': return `${m.group_label ? `Grupo ${m.group_label}` : 'Grupo'} · Fecha ${m.round}`;
    case 'third_place': return 'Tercer puesto';
    default: return 'Fase final';
  }
}

/** Nombre de una ronda eliminatoria según cuántas rondas faltan para la final. */
export function knockoutRoundName(round: number, lastRound: number): string {
  const fromEnd = lastRound - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinales';
  if (fromEnd === 2) return 'Cuartos de final';
  if (fromEnd === 3) return 'Octavos de final';
  return `Ronda ${round}`;
}

export interface BracketRound { round: number; name: string; matches: DisplayMatch[] }

/** Cuadro de fase final: rondas ascendentes (el tercer puesto va aparte). */
export function buildBracket<T extends DisplayMatch>(matches: T[]): { rounds: Array<Omit<BracketRound, 'matches'> & { matches: T[] }>; thirdPlace: T | null } {
  const ko = matches.filter((m) => m.stage === 'knockout');
  const rounds = Array.from(new Set(ko.map((m) => m.round))).sort((a, b) => a - b);
  const last = rounds[rounds.length - 1] ?? 0;
  return {
    rounds: rounds.map((r) => ({
      round: r, name: knockoutRoundName(r, last),
      matches: ko.filter((m) => m.round === r).sort((a, b) => a.slot - b.slot),
    })),
    thirdPlace: matches.find((m) => m.stage === 'third_place') ?? null,
  };
}

export function formatBogota(iso: string | null | undefined, opts: { day?: boolean } = {}): string {
  if (!iso) return 'Por programar';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Por programar';
  const hour = new Intl.DateTimeFormat('es-CO', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  if (opts.day === false) return hour;
  const day = new Intl.DateTimeFormat('es-CO', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  return `${day}, ${hour}`;
}

/** Orden de cronograma: hora, cancha, ronda. Sin hora al final. */
export function byScheduleOrder<T extends DisplayMatch>(a: T, b: T): number {
  const ta = a.scheduled_at ? Date.parse(a.scheduled_at) : Number.POSITIVE_INFINITY;
  const tb = b.scheduled_at ? Date.parse(b.scheduled_at) : Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (a.court ?? '').localeCompare(b.court ?? '') || a.round - b.round || a.slot - b.slot;
}

export const NO_COURT = 'Sin cancha';

/** Por cada cancha: el partido en juego o, si no hay, el siguiente programado. */
export function nowAndNextByCourt<T extends DisplayMatch>(matches: T[]): Array<{ court: string; live: T | null; next: T | null }> {
  const courts = Array.from(new Set(matches.map((m) => m.court || NO_COURT))).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  return courts.map((court) => {
    const mine = matches.filter((m) => (m.court || NO_COURT) === court);
    const live = mine.find((m) => m.status === 'live') ?? null;
    const next = mine.filter((m) => m.status === 'scheduled' && !m.is_bye).sort(byScheduleOrder)[0] ?? null;
    return { court, live, next };
  });
}

export function liveMatches<T extends DisplayMatch>(matches: T[]): T[] {
  return matches.filter((m) => m.status === 'live').sort(byScheduleOrder);
}

/** Lista del anotador: en juego primero, luego programados por hora, luego terminados; agrupada por cancha. */
export function groupForScorer<T extends DisplayMatch>(matches: T[]): Array<{ court: string; matches: T[] }> {
  const rank = (s: MatchStatus) => (s === 'live' ? 0 : s === 'scheduled' ? 1 : 2);
  const courts = Array.from(new Set(matches.map((m) => m.court || NO_COURT))).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  return courts.map((court) => ({
    court,
    matches: matches.filter((m) => (m.court || NO_COURT) === court)
      .sort((a, b) => rank(a.status) - rank(b.status) || byScheduleOrder(a, b)),
  }));
}

// Veo (app.veo.co / live.veo.co): su en vivo no se puede incrustar, se abre en Veo.
const STREAM_HOSTS = ['youtube.com', 'youtu.be', 'facebook.com', 'fb.watch', 'vimeo.com', 'veo.co'];

/** null si es válido (o vacío); si no, el mensaje de error. */
export function validateStreamUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try { u = new URL(v); } catch { return 'El enlace no es válido. Pega la dirección completa, empezando por https://'; }
  if (u.protocol !== 'https:') return 'El enlace debe empezar por https://';
  const host = u.hostname.toLowerCase();
  if (!STREAM_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'Solo se admiten enlaces de YouTube, Facebook, Vimeo o Veo.';
  return null;
}

export interface TableColumn { key: string; label: string; strong?: boolean; value: (r: StandingRow) => string | number }

export function standingColumns(model: 'goals' | 'sets'): TableColumn[] {
  if (model === 'sets') {
    return [
      { key: 'P', label: 'PJ', value: (r) => r.P },
      { key: 'W', label: 'G', value: (r) => r.W },
      { key: 'L', label: 'P', value: (r) => r.L },
      { key: 'Pts', label: 'Pts', strong: true, value: (r) => r.Pts },
      { key: 'sets', label: 'SW-SL', value: (r) => `${r.SW ?? 0}-${r.SL ?? 0}` },
      { key: 'pts', label: 'PF-PA', value: (r) => `${r.PF ?? 0}-${r.PA ?? 0}` },
    ];
  }
  return [
    { key: 'P', label: 'PJ', value: (r) => r.P },
    { key: 'W', label: 'G', value: (r) => r.W },
    { key: 'D', label: 'E', value: (r) => r.D },
    { key: 'L', label: 'P', value: (r) => r.L },
    { key: 'GF', label: 'GF', value: (r) => r.GF },
    { key: 'GA', label: 'GC', value: (r) => r.GA },
    { key: 'GD', label: 'DG', value: (r) => r.GD },
    { key: 'Pts', label: 'Pts', strong: true, value: (r) => r.Pts },
  ];
}

/** «actualizado hace 12 s» */
export function agoText(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return 'sin actualizar';
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return `actualizado hace ${s} s`;
  return `actualizado hace ${Math.floor(s / 60)} min`;
}

/** Cada cuánto refrescar la página pública. */
export function refreshIntervalMs(matches: Array<{ status: MatchStatus }>): number {
  return matches.some((m) => m.status === 'live') ? 10_000 : 60_000;
}
