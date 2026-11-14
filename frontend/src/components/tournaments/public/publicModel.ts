/**
 * Modelo PURO de la página pública del torneo (payload público v2).
 *
 * Todos los campos nuevos del contrato (docs/specs/torneos-en-vivo-multideporte-plan.md, «Payload público v2»)
 * son OPCIONALES aquí: la página funciona con el payload de hoy y mejora sola cuando el BFF los mande.
 * El BFF puede mandar los datos nuevos del torneo en `tournament` o dentro de `event`: se aceptan los dos.
 */
import type { PublicLiveDto, PublicMatchDto, StandingRow, StandingsDto } from '@/lib/tournamentTypes';
import { byScheduleOrder, buildBracket, NO_COURT, TIMEZONE, type BracketRound } from '@/lib/tournamentDisplay';
import { FOOTBALL_DEFAULT, formatHalfPoints, SCORING_PRESETS } from '@/lib/tournamentScoring';
import { scorerKindFor, sportFromName } from '@/lib/tournamentSports';

// ── Tipos v2 (todo opcional) ─────────────────────────────────────────────────

export type TournamentStatus = 'draft' | 'published' | 'in_progress' | 'finished' | 'cancelled';
export type SponsorTier = 'principal' | 'oficial' | 'aliado';

export interface PublicSponsor { id: string; name: string; logo_url?: string | null; url?: string | null; tier?: SponsorTier | null }
export interface PublicVenue { name?: string | null; address?: string | null; maps_url?: string | null }

export interface PublicTournamentInfo {
  status?: TournamentStatus | null;
  start_date?: string | null;
  end_date?: string | null;
  cover_url?: string | null;
  logo_url?: string | null;
  organizer_name?: string | null;
  stream_url?: string | null;
  rules_url?: string | null;
  venue?: PublicVenue | null;
  sponsors?: PublicSponsor[] | null;
  /** Color de marca del torneo (#RRGGBB). Opcional: si no viene, se usa el de SportMaps. */
  brand_color?: string | null;
}

export interface PublicTeam {
  id: string;
  name: string;
  category_id?: string | null;
  logo_url?: string | null;
  short_name?: string | null;
  is_external?: boolean | null;
  club_name?: string | null;
}

export type PublicMatchV2 = PublicMatchDto & {
  cup_label?: string | null;
  home_logo_url?: string | null;
  away_logo_url?: string | null;
};

export type StandingRowV2 = StandingRow & {
  set_diff?: number | null; point_diff?: number | null; set_ratio?: number | null; point_ratio?: number | null;
  /** Ajedrez (desempates que manda el BFF). */
  buchholz?: number | null; sonneborn_berger?: number | null;
  logo_url?: string | null;
};

export type StandingsV2 = Omit<StandingsDto, 'standings' | 'groups'> & {
  standings: StandingRowV2[];
  groups?: Record<string, StandingRowV2[]>;
};

export interface PublicLiveV2 extends Omit<PublicLiveDto, 'event' | 'tournament' | 'matches' | 'standings'> {
  event: PublicLiveDto['event'] & PublicTournamentInfo;
  /** Mismo objeto que `event` en el payload v2 (lo agrega «datos»). */
  tournament?: PublicLiveDto['event'] & PublicTournamentInfo;
  matches: PublicMatchV2[];
  standings: Record<string, StandingsV2>;
  /** Ranking individual (lo agrega «vivo»). Si no viene, la pestaña Ranking no aparece. */
  player_stats?: PlayerStat[] | null;
}

// ── Torneo ───────────────────────────────────────────────────────────────────

export interface TournamentView extends PublicTournamentInfo {
  title: string;
  sport: string | null;
  city: string | null;
  live_enabled: boolean;
  school_name: string | null;
  sponsors: PublicSponsor[];
}

/** Une `event` y `tournament` (gana lo que traiga valor en `tournament`). */
export function tournamentView(d: PublicLiveV2): TournamentView {
  const t: Partial<NonNullable<PublicLiveV2['tournament']>> = d.tournament ?? {};
  const e = d.event;
  const pick = <K extends keyof PublicTournamentInfo>(k: K) => (t[k] ?? e[k] ?? null) as PublicTournamentInfo[K];
  return {
    title: t.title || e.title,
    sport: e.sport, city: realText(e.city), live_enabled: e.live_enabled, school_name: e.school_name,
    status: pick('status'),
    start_date: pick('start_date') ?? e.event_date,
    end_date: pick('end_date'),
    cover_url: pick('cover_url'), logo_url: pick('logo_url'),
    organizer_name: pick('organizer_name') ?? e.school_name,
    stream_url: pick('stream_url'), rules_url: pick('rules_url'),
    venue: realVenue(pick('venue')), brand_color: pick('brand_color'),
    sponsors: (pick('sponsors') ?? []).filter((s) => s && s.name),
  };
}

/** Textos de relleno que el asistente guarda mientras el torneo es borrador: no son datos de verdad. */
const PLACEHOLDER = /^(por definir|por confirmar|pendiente|n\/?a|-+|—)$/i;

/** El texto si es un dato real; null si viene vacío o es un relleno («Por definir»). */
export function realText(s: string | null | undefined): string | null {
  const v = (s ?? '').trim();
  return v && !PLACEHOLDER.test(v) ? v : null;
}

/**
 * Sede pública sin rellenos: «Por definir, Por definir» → nada. Si no queda nombre ni dirección,
 * null (la página oculta la sede, el mapa y «Cómo llegar»).
 */
export function realVenue(v: PublicVenue | null | undefined): PublicVenue | null {
  if (!v) return null;
  const name = realText(v.name);
  const address = (v.address ?? '').split(',').map((p) => realText(p)).filter(Boolean).join(', ') || null;
  if (!name && !address) return null;
  // Si se limpió algo, el enlace del BFF buscaría el relleno: que la página lo arme con lo real.
  const cleaned = name !== (v.name ?? null) || address !== (v.address ?? null);
  return { name, address, maps_url: cleaned ? null : v.maps_url ?? null };
}

/** Coordenadas «lat,lng» si el enlace del BFF las trae (`…?query=6.25,-75.59`). */
function coordsOf(mapsUrl: string | null | undefined): string | null {
  const m = /[?&]query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:&|$)/.exec(mapsUrl ?? '');
  return m ? `${m[1]},${m[2]}` : null;
}

/**
 * «Cómo llegar» en Google Maps y en Waze. Con coordenadas, las dos van al punto exacto; si no, buscan
 * «sede, dirección, ciudad». null si no hay nada real que buscar (la página no muestra los botones).
 */
export function venueDirections(v: PublicVenue | null | undefined, city: string | null | undefined): { google: string; waze: string } | null {
  if (!v) return null;
  const ll = coordsOf(v.maps_url);
  const q = [v.name, v.address, realText(city)].filter(Boolean).join(', ');
  if (!ll && !q) return null;
  const google = safeUrl(v.maps_url) ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const waze = ll ? `https://waze.com/ul?ll=${encodeURIComponent(ll)}&navigate=yes` : `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
  return { google, waze };
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const GENDER_SHORT: Array<[RegExp, string]> = [[/\s+femenin[oa]s?$/i, ' F'], [/\s+masculin[oa]s?$/i, ' M'], [/\s+mixt[oa]s?$/i, ' Mixto']];

/**
 * Nombre corto de categoría para chips y listas: el BFF la arma como «división · nivel · categoría · rama»
 * («General · 1 · Sub 14 Femenino · Femenino»). Quita lo genérico («General», el nivel numérico), lo repetido
 * (la rama ya dicha en la categoría) y abrevia el género al final: «Sub 14 F», «Mayores M».
 */
export function shortCategoryName(name: string): string {
  const parts = name.split('·').map((p) => p.trim()).filter(Boolean);
  const useful = parts.filter((p) => !/^(general|unica|única|todas?|\d+)$/i.test(p));
  // «Femenino» sobra si otra parte ya lo dice como palabra («Sub 14 Femenino»); «A» no sobra por estar dentro de «Infantil».
  const said = (o: string, p: string) => ` ${fold(o)} `.includes(` ${fold(p)} `);
  const dedup = useful.filter((p, i) => !useful.some((o, j) => j !== i && fold(o) !== fold(p) && said(o, p)))
    .filter((p, i, arr) => arr.findIndex((o) => fold(o) === fold(p)) === i);
  if (dedup.length === 0) return name.trim();
  return dedup.map((p) => {
    if (p.split(/\s+/).length < 2) return p;
    for (const [re, rep] of GENDER_SHORT) if (re.test(p)) return p.replace(re, rep);
    return p;
  }).join(' · ');
}

export type PublicPhase = 'upcoming' | 'in_progress' | 'finished' | 'cancelled';
export const PHASE_LABEL: Record<PublicPhase, string> = {
  upcoming: 'Próximamente', in_progress: 'En curso', finished: 'Finalizado', cancelled: 'Cancelado',
};

const isDone = (s: string) => s === 'played' || s === 'walkover' || s === 'cancelled';

/** Estado público: el que mande el BFF; si no, se deduce de los partidos y las fechas. */
export function tournamentPhase(t: Pick<TournamentView, 'status' | 'start_date' | 'end_date'>, matches: Array<Pick<PublicMatchV2, 'status' | 'is_bye'>>, todayIso: string): PublicPhase {
  if (t.status === 'cancelled') return 'cancelled';
  if (t.status === 'finished') return 'finished';
  if (t.status === 'in_progress') return 'in_progress';
  const real = matches.filter((m) => !m.is_bye && m.status !== 'cancelled');
  if (real.some((m) => m.status === 'live')) return 'in_progress';
  if (real.length > 0 && real.every((m) => isDone(m.status))) return 'finished';
  if (real.some((m) => isDone(m.status))) return 'in_progress';
  const start = t.start_date?.slice(0, 10);
  const end = (t.end_date ?? t.start_date)?.slice(0, 10);
  if (start && todayIso >= start && end && todayIso <= end) return 'in_progress';
  if (end && todayIso > end) return real.length ? 'in_progress' : 'finished';
  return 'upcoming';
}

/** Hoy (YYYY-MM-DD) en Bogotá. */
export function todayBogota(now: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «3 – 13 oct 2026», «24 oct 2026», «28 sep – 2 oct 2026». */
export function dateRangeText(start: string | null | undefined, end: string | null | undefined): string | null {
  const p = (s: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  };
  const a = p(start); const b = p(end);
  if (!a) return null;
  const full = (x: { y: number; mo: number; d: number }) => `${x.d} ${MONTHS[x.mo - 1]} ${x.y}`;
  if (!b || (a.y === b.y && a.mo === b.mo && a.d === b.d)) return full(a);
  if (a.y === b.y && a.mo === b.mo) return `${a.d} – ${b.d} ${MONTHS[a.mo - 1]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.mo - 1]} – ${full(b)}`;
  return `${full(a)} – ${full(b)}`;
}

/** Color de marca seguro (solo #RGB / #RRGGBB). */
export function safeBrandColor(c: string | null | undefined): string | null {
  return c && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : null;
}

/** Texto legible sobre el color de marca (blanco o casi negro según la luminancia). */
export function brandTextColor(hex: string | null): string {
  if (!hex) return '#ffffff';
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111827' : '#ffffff';
}

/** Solo enlaces http(s) — nada de javascript: en lo público. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null; } catch { return null; }
}

// ── Equipos ──────────────────────────────────────────────────────────────────

export interface TeamInfo { id: string; name: string; logo_url: string | null; short_name: string | null; club_name: string | null; category_id?: string | null }

/** Índice de equipos: primero `teams` del payload; si no, lo que se pueda sacar de partidos y tablas. */
export function teamIndex(d: PublicLiveV2): Map<string, TeamInfo> {
  const out = new Map<string, TeamInfo>();
  const put = (id: string | null | undefined, name: string | null | undefined, logo?: string | null) => {
    if (!id || !name) return;
    const prev = out.get(id);
    if (!prev) out.set(id, { id, name, logo_url: logo ?? null, short_name: null, club_name: null });
    else if (!prev.logo_url && logo) prev.logo_url = logo;
  };
  for (const t of d.teams ?? []) {
    out.set(t.id, { id: t.id, name: t.name, logo_url: t.logo_url ?? null, short_name: t.short_name ?? null, club_name: t.club_name ?? null, category_id: t.category_id ?? null });
  }
  for (const m of d.matches) { put(m.home_team_id, m.home_name, m.home_logo_url); put(m.away_team_id, m.away_name, m.away_logo_url); }
  for (const s of Object.values(d.standings ?? {})) for (const r of s.standings ?? []) put(r.team_id, r.team_name, r.logo_url);
  return out;
}

const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'da', 'do', 'the', 'fc', 'cd', 'club']);

/**
 * Iniciales para el avatar cuando no hay logo (hasta 3 letras):
 * «Spikers» → «SPI», «Angeles Premier» → «AP», «EDF La Calera» → «EC», «Club Atlético Sur Oriente» → «ASO».
 */
export function initials(name: string, short?: string | null): string {
  if (short && short.trim()) return short.trim().slice(0, 4).toUpperCase();
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const sig = words.filter((w) => !STOP.has(w.toLowerCase()));
  const use = sig.length > 0 ? sig : words;
  if (use.length === 1) return use[0].slice(0, 3).toUpperCase();
  return use.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

/** Color estable derivado del nombre (mismo equipo → mismo color en todas las pantallas). */
export function avatarColor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (const ch of name.trim().toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue} 62% 42%)`, fg: '#ffffff' };
}

// ── Partidos ─────────────────────────────────────────────────────────────────

export type MatchFilter = 'all' | 'live' | 'played' | 'upcoming';
export const MATCH_FILTER_LABEL: Record<MatchFilter, string> = { all: 'Todos', live: 'En vivo', played: 'Jugados', upcoming: 'Próximos' };

/** Filtro de la pestaña Partidos. Los «pasa directo» no aparecen. Jugados: el más reciente primero. */
export function filterMatches<T extends PublicMatchV2>(matches: T[], f: MatchFilter): T[] {
  const real = matches.filter((m) => !m.is_bye);
  switch (f) {
    case 'live': return real.filter((m) => m.status === 'live').sort(byScheduleOrder);
    case 'played': return real.filter((m) => m.status === 'played' || m.status === 'walkover').sort(byScheduleOrder).reverse();
    case 'upcoming': return real.filter((m) => m.status === 'scheduled').sort(byScheduleOrder);
    default: {
      const rank = (s: string) => (s === 'live' ? 0 : 1);
      return [...real].sort((a, b) => rank(a.status) - rank(b.status) || byScheduleOrder(a, b));
    }
  }
}

export function filterCounts(matches: PublicMatchV2[]): Record<MatchFilter, number> {
  return {
    all: filterMatches(matches, 'all').length, live: filterMatches(matches, 'live').length,
    played: filterMatches(matches, 'played').length, upcoming: filterMatches(matches, 'upcoming').length,
  };
}

/** Clave de día (YYYY-MM-DD en Bogotá) de un partido; null si no tiene hora. */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** «sábado 22 de agosto» */
export function dayTitle(key: string | null): string {
  if (!key) return 'Por programar';
  const d = new Date(`${key}T12:00:00-05:00`);
  return new Intl.DateTimeFormat('es-CO', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export interface ScheduleDay<T> { day: string | null; title: string; courts: Array<{ court: string; matches: T[] }> }

/** Programación: por día (sin hora al final) y dentro de cada día por cancha (orden natural: Cancha 2 < Cancha 10). */
export function scheduleByDayAndCourt<T extends PublicMatchV2>(matches: T[]): Array<ScheduleDay<T>> {
  const real = matches.filter((m) => !m.is_bye && m.status !== 'cancelled');
  const days = Array.from(new Set(real.map((m) => dayKey(m.scheduled_at))));
  days.sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  return days.map((day) => {
    const mine = real.filter((m) => dayKey(m.scheduled_at) === day);
    const courts = Array.from(new Set(mine.map((m) => m.court || NO_COURT)))
      .sort((a, b) => (a === NO_COURT ? 1 : b === NO_COURT ? -1 : a.localeCompare(b, 'es', { numeric: true })));
    return {
      day, title: dayTitle(day),
      courts: courts.map((court) => ({ court, matches: mine.filter((m) => (m.court || NO_COURT) === court).sort(byScheduleOrder) })),
    };
  });
}

/** Etiqueta corta de fase para listas: «Grupo A», «Semifinal», «Final», «3.º y 4.º». */
export function phaseShort(m: Pick<PublicMatchV2, 'stage' | 'group_label' | 'round' | 'cup_label'>, lastKoRound: number): string {
  const cup = m.cup_label ? `${m.cup_label} · ` : '';
  if (m.stage === 'group') return m.group_label ? `Grupo ${m.group_label}` : 'Grupos';
  if (m.stage === 'league') return `Fecha ${m.round}`;
  if (m.stage === 'third_place') return `${cup}3.º y 4.º`;
  const fromEnd = lastKoRound - m.round;
  const n = fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semifinal' : fromEnd === 2 ? 'Cuartos' : fromEnd === 3 ? 'Octavos' : `Ronda ${m.round}`;
  return `${cup}${n}`;
}

/** Última ronda eliminatoria por copa (para nombrar Final / Semifinal). */
export function lastKoRoundByCup(matches: PublicMatchV2[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (m.stage !== 'knockout') continue;
    const k = m.cup_label ?? '';
    out.set(k, Math.max(out.get(k) ?? 0, m.round));
  }
  return out;
}

export type Side = 'home' | 'away';
/** Ganador de un partido terminado (null si no terminó o empató). */
export function winnerSide(m: Pick<PublicMatchV2, 'status' | 'home_score' | 'away_score'>): Side | null {
  if (m.status !== 'played' && m.status !== 'walkover') return null;
  if (m.home_score == null || m.away_score == null || m.home_score === m.away_score) return null;
  return m.home_score > m.away_score ? 'home' : 'away';
}

/** Índice del set en curso (el primero sin cerrar) o -1. */
export function currentSetIndex(sets: Array<{ closed: boolean }> | null | undefined): number {
  return (sets ?? []).findIndex((s) => !s.closed);
}

// ── Copas ────────────────────────────────────────────────────────────────────

export const DEFAULT_CUP = 'Fase final';

export interface CupView<T> {
  label: string;
  rounds: Array<Omit<BracketRound, 'matches'> & { matches: T[] }>;
  thirdPlace: T | null;
  final: T | null;
  champion: string | null;
}

const CUP_ORDER = ['oro', 'plata', 'bronce', 'cobre'];
const cupRank = (label: string) => {
  const l = label.toLowerCase();
  const i = CUP_ORDER.findIndex((c) => l.includes(c));
  return i === -1 ? CUP_ORDER.length : i;
};

/** Un cuadro por `cup_label` (sin etiqueta → «Fase final»). Oro, plata, bronce primero. */
export function buildCups<T extends PublicMatchV2>(matches: T[]): Array<CupView<T>> {
  const ko = matches.filter((m) => m.stage === 'knockout' || m.stage === 'third_place');
  const labels = Array.from(new Set(ko.map((m) => m.cup_label || DEFAULT_CUP)));
  labels.sort((a, b) => cupRank(a) - cupRank(b) || a.localeCompare(b, 'es'));
  return labels.map((label) => {
    const mine = ko.filter((m) => (m.cup_label || DEFAULT_CUP) === label);
    const { rounds, thirdPlace } = buildBracket(mine);
    const lastRound = rounds[rounds.length - 1];
    const final = lastRound && lastRound.matches.length === 1 ? lastRound.matches[0] : null;
    const w = final ? winnerSide(final) : null;
    const champion = final && w ? (w === 'home' ? final.home_name : final.away_name) : null;
    return { label, rounds, thirdPlace, final, champion };
  });
}

/** Medalla por copa (solo decorativa). */
export function cupEmoji(label: string): string {
  const r = cupRank(label);
  return r === 0 ? '🥇' : r === 1 ? '🥈' : r === 2 ? '🥉' : '🏆';
}

/** Nombre de partido dentro de una ronda: «Semifinal 1», «Final». */
export function roundMatchName(roundName: string, idx: number, count: number): string {
  if (count <= 1) return roundName;
  const singular: Record<string, string> = { Semifinales: 'Semifinal', 'Cuartos de final': 'Cuarto de final', 'Octavos de final': 'Octavo de final' };
  return `${singular[roundName] ?? roundName} ${idx + 1}`;
}

// ── Posiciones ───────────────────────────────────────────────────────────────

export interface PublicColumn { key: string; label: string; title: string; strong?: boolean; value: (r: StandingRowV2) => string | number }

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

// ── Formato por deporte (ajedrez en medios puntos, tenis en games) ──────────

export type PublicScoreKind = 'chess' | 'tennis' | 'default';

/**
 * Cómo se lee el marcador según el deporte del torneo. Reusa el catálogo del anotador
 * (`sportFromName` → plantilla por defecto → `scorerKindFor`): ajedrez, tenis, beach tennis y pádel salen de un solo sitio.
 */
export function publicScoreKind(sport: string | null | undefined): PublicScoreKind {
  const s = sportFromName(sport);
  const cfg = s ? SCORING_PRESETS[s.defaultPreset]?.config : undefined;
  if (!cfg) return 'default';
  const k = scorerKindFor({ ...FOOTBALL_DEFAULT, ...cfg });
  // Pádel se anota por games directos (unidad «Games»): en la tabla también son games.
  return k === 'chess' ? 'chess' : k === 'tennis' || s?.unit === 'Games' ? 'tennis' : 'default';
}

/** Cómo se llama cada lado en lo público (ajedrez: Blancas / Negras). null si el deporte no lo distingue. */
export function publicSides(sport: string | null | undefined): { home: string; away: string } | null {
  return sportFromName(sport)?.sides ?? null;
}

/** Ajedrez: puntos de tabla (0.5) → «½», «1½». Lo que no sea múltiplo de ½ va con dos decimales. */
export function chessNumber(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (Number.isInteger(v * 2)) return formatHalfPoints(Math.round(v * 2));
  return v.toFixed(2).replace('.', ',');
}

/**
 * Marcador público de un partido. Ajedrez: el BFF lo guarda en medios puntos (2-0 = 1-0, 1-1 = ½-½).
 * null si aún no hay marcador que mostrar.
 */
export function publicScore(m: Pick<PublicMatchV2, 'home_score' | 'away_score' | 'status'>, kind: PublicScoreKind): { home: string; away: string } | null {
  if (m.home_score == null || m.away_score == null || m.status === 'scheduled') return null;
  if (kind === 'chess') return { home: formatHalfPoints(m.home_score), away: formatHalfPoints(m.away_score) };
  return { home: String(m.home_score), away: String(m.away_score) };
}

/** Columnas de la tabla pública. Voleibol: PJ PG PP PTS SG SP DS PF PC DP. Tenis: games. Ajedrez: puntos ½ + Buchholz / S-B. */
export function publicStandingColumns(model: 'goals' | 'sets', kind: PublicScoreKind = 'default'): PublicColumn[] {
  if (kind === 'chess') {
    return [
      { key: 'P', label: 'PJ', title: 'Partidas jugadas', value: (r) => r.P },
      { key: 'W', label: 'PG', title: 'Partidas ganadas', value: (r) => r.W },
      { key: 'D', label: 'PT', title: 'Tablas', value: (r) => r.D },
      { key: 'L', label: 'PP', title: 'Partidas perdidas', value: (r) => r.L },
      { key: 'Pts', label: 'PTS', title: 'Puntos (1 · ½ · 0)', strong: true, value: (r) => chessNumber(r.Pts) },
      { key: 'BH', label: 'BH', title: 'Buchholz', value: (r) => chessNumber(r.buchholz) },
      { key: 'SB', label: 'SB', title: 'Sonneborn-Berger', value: (r) => chessNumber(r.sonneborn_berger) },
    ];
  }
  if (model === 'sets' && kind === 'tennis') {
    return [
      ...publicStandingColumns('sets').filter((c) => !['PF', 'PA', 'DP'].includes(c.key)),
      { key: 'PF', label: 'GF', title: 'Games a favor', value: (r) => r.PF ?? 0 },
      { key: 'PA', label: 'GC', title: 'Games en contra', value: (r) => r.PA ?? 0 },
      { key: 'DP', label: 'DG', title: 'Diferencia de games', value: (r) => signed(r.point_diff ?? (r.PF ?? 0) - (r.PA ?? 0)) },
    ];
  }
  if (model === 'sets') {
    return [
      { key: 'P', label: 'PJ', title: 'Partidos jugados', value: (r) => r.P },
      { key: 'W', label: 'PG', title: 'Partidos ganados', value: (r) => r.W },
      { key: 'L', label: 'PP', title: 'Partidos perdidos', value: (r) => r.L },
      { key: 'Pts', label: 'PTS', title: 'Puntos en la tabla', strong: true, value: (r) => r.Pts },
      { key: 'SW', label: 'SG', title: 'Sets ganados', value: (r) => r.SW ?? 0 },
      { key: 'SL', label: 'SP', title: 'Sets perdidos', value: (r) => r.SL ?? 0 },
      { key: 'DS', label: 'DS', title: 'Diferencia de sets', value: (r) => signed(r.set_diff ?? (r.SW ?? 0) - (r.SL ?? 0)) },
      { key: 'PF', label: 'PF', title: 'Puntos a favor', value: (r) => r.PF ?? 0 },
      { key: 'PA', label: 'PC', title: 'Puntos en contra', value: (r) => r.PA ?? 0 },
      { key: 'DP', label: 'DP', title: 'Diferencia de puntos', value: (r) => signed(r.point_diff ?? (r.PF ?? 0) - (r.PA ?? 0)) },
    ];
  }
  return [
    { key: 'P', label: 'PJ', title: 'Partidos jugados', value: (r) => r.P },
    { key: 'W', label: 'PG', title: 'Partidos ganados', value: (r) => r.W },
    { key: 'D', label: 'PE', title: 'Partidos empatados', value: (r) => r.D },
    { key: 'L', label: 'PP', title: 'Partidos perdidos', value: (r) => r.L },
    { key: 'Pts', label: 'PTS', title: 'Puntos', strong: true, value: (r) => r.Pts },
    { key: 'GF', label: 'GF', title: 'Goles a favor', value: (r) => r.GF },
    { key: 'GA', label: 'GC', title: 'Goles en contra', value: (r) => r.GA },
    { key: 'GD', label: 'DG', title: 'Diferencia de gol', value: (r) => signed(r.GD) },
  ];
}

export interface StandingGroup { label: string | null; rows: StandingRowV2[] }

export function standingGroups(s: StandingsV2 | null | undefined): StandingGroup[] {
  if (!s) return [];
  const groups = s.groups ? Object.entries(s.groups).sort(([a], [b]) => a.localeCompare(b)) : [];
  if (groups.length > 0) return groups.map(([label, rows]) => ({ label, rows }));
  return [{ label: null, rows: s.standings ?? [] }];
}

/**
 * Quién clasifica a qué copa, sacado de las referencias de la fase final («1.º Grupo A» en la Copa oro).
 * Devuelve: por grupo+puesto la copa, y por equipo ya ubicado la copa.
 */
export function qualificationMap(matches: PublicMatchV2[]): { byPos: Map<string, string>; byTeam: Map<string, string> } {
  const byPos = new Map<string, string>();
  const byTeam = new Map<string, string>();
  const ko = matches.filter((m) => m.stage === 'knockout');
  const firstRound = new Map<string, number>();
  for (const m of ko) { const k = m.cup_label || DEFAULT_CUP; firstRound.set(k, Math.min(firstRound.get(k) ?? Infinity, m.round)); }
  for (const m of ko) {
    const cup = m.cup_label || DEFAULT_CUP;
    for (const lab of [m.home_label, m.away_label]) {
      const g = /^(\d+)\.º Grupo (\S+)$/.exec(lab ?? '');
      if (g) byPos.set(`${g[2]}:${g[1]}`, cup);
    }
    if (m.round === firstRound.get(cup)) {
      for (const id of [m.home_team_id, m.away_team_id]) if (id && !byTeam.has(id)) byTeam.set(id, cup);
    }
  }
  return { byPos, byTeam };
}

/** Copa a la que va cada fila (o null). Si no hay fase final aún, nada. */
export function rowCup(q: ReturnType<typeof qualificationMap>, group: string | null, pos: number, teamId: string): string | null {
  return q.byTeam.get(teamId) ?? (group ? q.byPos.get(`${group}:${pos}`) ?? null : null);
}

/** Leyenda «1.º y 2.º de cada grupo → Copa oro». */
export function qualificationLegend(q: ReturnType<typeof qualificationMap>): Array<{ cup: string; text: string }> {
  const perCup = new Map<string, Set<number>>();
  for (const [key, cup] of q.byPos) {
    const pos = Number(key.split(':')[1]);
    if (!perCup.has(cup)) perCup.set(cup, new Set());
    perCup.get(cup)!.add(pos);
  }
  return Array.from(perCup.entries())
    .sort(([a], [b]) => cupRank(a) - cupRank(b))
    .map(([cup, set]) => {
      const ps = Array.from(set).sort((a, b) => a - b).map((p) => `${p}.º`);
      const list = ps.length > 1 ? `${ps.slice(0, -1).join(', ')} y ${ps[ps.length - 1]}` : ps[0];
      return { cup, text: `${list} de cada grupo` };
    });
}

// ── Ficha de equipo ──────────────────────────────────────────────────────────

export interface TeamSheetData<T> { matches: T[]; position: { group: string | null; pos: number; row: StandingRowV2 } | null; record: { W: number; L: number; D: number } }

export function teamSheet<T extends PublicMatchV2>(teamId: string, matches: T[], standings: StandingsV2 | null | undefined): TeamSheetData<T> {
  const mine = matches.filter((m) => !m.is_bye && (m.home_team_id === teamId || m.away_team_id === teamId)).sort(byScheduleOrder);
  let position: TeamSheetData<T>['position'] = null;
  for (const g of standingGroups(standings)) {
    const i = g.rows.findIndex((r) => r.team_id === teamId);
    if (i >= 0) { position = { group: g.label, pos: i + 1, row: g.rows[i] }; break; }
  }
  const record = { W: 0, L: 0, D: 0 };
  for (const m of mine) {
    if (m.status !== 'played' && m.status !== 'walkover') continue;
    const w = winnerSide(m);
    const mySide: Side = m.home_team_id === teamId ? 'home' : 'away';
    if (!w) record.D++; else if (w === mySide) record.W++; else record.L++;
  }
  return { matches: mine, position, record };
}

// ── Patrocinadores ───────────────────────────────────────────────────────────

export const TIER_LABEL: Record<SponsorTier, string> = { principal: 'Patrocinador principal', oficial: 'Patrocinadores oficiales', aliado: 'Aliados' };

export function sponsorsByTier(list: PublicSponsor[]): Array<{ tier: SponsorTier; sponsors: PublicSponsor[] }> {
  const tiers: SponsorTier[] = ['principal', 'oficial', 'aliado'];
  return tiers
    .map((tier) => ({ tier, sponsors: list.filter((s) => (s.tier ?? 'aliado') === tier) }))
    .filter((g) => g.sponsors.length > 0);
}

// ── Compartir y preferencias ─────────────────────────────────────────────────

export function whatsappShareUrl(title: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${title} — resultados y tabla en vivo: ${url}`)}`;
}

const catKey = (slug: string) => `torneo:${slug}:categoria`;

export function loadCategory(slug: string | undefined): string | null {
  if (!slug) return null;
  try { return window.localStorage.getItem(catKey(slug)); } catch { return null; }
}

export function saveCategory(slug: string | undefined, id: string): void {
  if (!slug) return;
  try { window.localStorage.setItem(catKey(slug), id); } catch { /* modo privado: no pasa nada */ }
}

/** La categoría guardada si sigue existiendo; si no, la primera con partidos; si no, la primera. */
export function pickCategory(cats: Array<{ id: string }>, saved: string | null, matches: Array<{ category_id: string }>): string | null {
  if (saved && cats.some((c) => c.id === saved)) return saved;
  const withMatches = cats.find((c) => matches.some((m) => m.category_id === c.id));
  return withMatches?.id ?? cats[0]?.id ?? null;
}

/** Solo la hora en Bogotá: «8:30 a. m.». */
export function hourOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', { timeZone: TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
}

// ── Todos los partidos (feed que mezcla categorías) ──────────────────────────

export interface FeedItem<T> { match: T; categoryName: string }

/** Feed «Todos los partidos»: todas las categorías; en vivo primero, luego próximos por hora y jugados recientes. */
export function allMatchesFeed<T extends PublicMatchV2>(matches: T[], categories: Array<{ id: string; name: string }>, f: MatchFilter = 'all'): Array<FeedItem<T>> {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  let list: T[];
  if (f === 'all') {
    const live = filterMatches(matches, 'live');
    const next = filterMatches(matches, 'upcoming');
    const played = filterMatches(matches, 'played');
    list = [...live, ...next, ...played];
  } else list = filterMatches(matches, f);
  return list.map((match) => ({ match, categoryName: names.get(match.category_id) ?? '' }));
}

// ── Ranking de jugadoras (lo agrega «vivo»; solo si viene en el payload) ─────

export type PlayerMetric = 'aces' | 'points' | 'attack_points' | 'blocks';
export const PLAYER_METRIC_LABEL: Record<PlayerMetric, string> = { aces: 'Aces', points: 'Puntos', attack_points: 'Ataque', blocks: 'Bloqueo' };

export interface PlayerStat {
  id?: string;
  category_id?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  /** Lo que el BFF decida mostrar (nombre corto o dorsal); la página no lo arma. Puede faltar: se trata como ''. */
  player_label?: string | null;
  aces?: number | null; points?: number | null; attack_points?: number | null; blocks?: number | null;
}

/** Hay ranking si el payload trae al menos una fila (un [] no abre una pestaña vacía). */
export function hasPlayerStats(d: Pick<PublicLiveV2, 'player_stats'>): boolean {
  return Array.isArray(d.player_stats) && d.player_stats.length > 0;
}

const num = (...xs: unknown[]) => { for (const x of xs) if (x != null && Number.isFinite(Number(x))) return Number(x); return 0; };

/**
 * Adaptador tolerante del ranking: acepta el contrato público ({player_label, aces, attack_points, blocks})
 * y también las líneas de «vivo» ({member_id, name, ace, attack, block}) que mandaba el BFF antes del arreglo
 * (B1, 2026-10-28). Completa equipo y categoría desde el índice de equipos si no vienen.
 */
export function normalizePlayerStats(raw: unknown, teams: Map<string, TeamInfo>): PlayerStat[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => {
    const teamId = (r.team_id as string | null | undefined) ?? null;
    const t = teamId ? teams.get(teamId) : undefined;
    const label = r.player_label ?? r.name;
    return {
      id: (r.id ?? r.member_id ?? undefined) as string | undefined,
      team_id: teamId,
      team_name: (r.team_name as string | null | undefined) ?? t?.name ?? null,
      category_id: (r.category_id as string | null | undefined) ?? t?.category_id ?? null,
      player_label: typeof label === 'string' ? label : '',
      aces: num(r.aces, r.ace), attack_points: num(r.attack_points, r.attack), blocks: num(r.blocks, r.block), points: num(r.points),
    };
  });
}

/** Top de una métrica en una categoría: sin ceros, de mayor a menor, empate por nombre. */
export function playerRanking(stats: PlayerStat[] | null | undefined, metric: PlayerMetric, categoryId: string | null, limit = 20): Array<PlayerStat & { value: number; rank: number }> {
  const rows = (stats ?? [])
    .filter((s) => !categoryId || !s.category_id || s.category_id === categoryId)
    .map((s) => ({ ...s, value: Number(s[metric] ?? 0) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || (a.player_label ?? '').localeCompare(b.player_label ?? '', 'es'));
  let rank = 0; let prev: number | null = null;
  return rows.slice(0, limit).map((r, i) => { if (r.value !== prev) { rank = i + 1; prev = r.value; } return { ...r, rank }; });
}

// ── Página del partido ───────────────────────────────────────────────────────

/** Sets en cuadrícula por equipo (mínimo tantas columnas como sets del formato, para que se vean los vacíos). */
export function setsGrid(sets: Array<{ home: number; away: number; closed: boolean }> | null | undefined, minCols = 3): { home: Array<number | null>; away: Array<number | null>; current: number } {
  const list = sets ?? [];
  const n = Math.max(minCols, list.length);
  const home: Array<number | null> = []; const away: Array<number | null> = [];
  for (let i = 0; i < n; i++) { home.push(list[i]?.home ?? null); away.push(list[i]?.away ?? null); }
  return { home, away, current: currentSetIndex(list) };
}

// ── Enlaces para compartir ───────────────────────────────────────────────────

export type ShareScope = 'tournament' | 'category' | 'match';

export function shareLink(origin: string, slug: string, scope: ShareScope, opts: { categoryId?: string | null; matchId?: string | null } = {}): string {
  const base = `${origin}/torneo/${encodeURIComponent(slug)}`;
  if (scope === 'match' && opts.matchId) return `${base}/partido/${encodeURIComponent(opts.matchId)}`;
  if (scope === 'category' && opts.categoryId) return `${base}/en-vivo?cat=${encodeURIComponent(opts.categoryId)}`;
  return `${base}/en-vivo`;
}

/** Texto corto para mostrar el enlace sin el protocolo: «app.sportmaps.co/torneo/copa/en-vivo». */
export function displayLink(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── Modo TV ──────────────────────────────────────────────────────────────────

export type TvSlide =
  | { key: string; kind: 'live'; title: string }
  | { key: string; kind: 'standings'; title: string; categoryId: string }
  | { key: string; kind: 'upcoming'; title: string }
  | { key: string; kind: 'results'; title: string }
  | { key: string; kind: 'sponsors'; title: string };

/**
 * Rotación del modo TV: en vivo → posiciones (una por categoría con tabla) → próximos → últimos resultados → patrocinadores.
 * Solo entra lo que tiene contenido; si no hay nada, lista vacía.
 */
export function tvPlan(d: PublicLiveV2, sponsors: PublicSponsor[]): TvSlide[] {
  const out: TvSlide[] = [];
  const live = d.event.live_enabled && d.matches.some((m) => m.status === 'live');
  if (live) out.push({ key: 'live', kind: 'live', title: 'En vivo' });
  for (const c of d.categories) {
    const s = d.standings[c.id];
    if (s && standingGroups(s).some((g) => g.rows.length > 0)) out.push({ key: `pos-${c.id}`, kind: 'standings', title: `Posiciones · ${c.name}`, categoryId: c.id });
  }
  if (filterMatches(d.matches, 'upcoming').length > 0) out.push({ key: 'next', kind: 'upcoming', title: 'Próximos partidos' });
  if (filterMatches(d.matches, 'played').length > 0) out.push({ key: 'res', kind: 'results', title: 'Últimos resultados' });
  if (sponsors.length > 0) out.push({ key: 'spon', kind: 'sponsors', title: 'Patrocinadores' });
  return out;
}

// ── Insertar en otra web (iframe) ────────────────────────────────────────────

export type EmbedView = 'posiciones' | 'partidos' | 'programacion' | 'copas';
export const EMBED_VIEWS: EmbedView[] = ['posiciones', 'partidos', 'programacion', 'copas'];
export const EMBED_VIEW_LABEL: Record<EmbedView, string> = { posiciones: 'Posiciones', partidos: 'Partidos', programacion: 'Programación', copas: 'Copas' };

export function parseEmbedView(v: string | null | undefined): EmbedView {
  return EMBED_VIEWS.includes(v as EmbedView) ? (v as EmbedView) : 'posiciones';
}

export function embedUrl(origin: string, slug: string, opts: { vista: EmbedView; categoria?: string | null; transparente?: boolean }): string {
  const q = new URLSearchParams({ vista: opts.vista });
  if (opts.categoria) q.set('categoria', opts.categoria);
  if (opts.transparente) q.set('fondo', 'transparente');
  return `${origin}/torneo/${encodeURIComponent(slug)}/embed?${q.toString()}`;
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** El `<iframe>` listo para pegar en la web del club. */
export function embedSnippet(url: string, title: string, height = 640): string {
  return `<iframe src="${escAttr(url)}" title="${escAttr(title)}" width="100%" height="${height}" style="border:0;max-width:100%;" loading="lazy" allow="clipboard-write"></iframe>`;
}
