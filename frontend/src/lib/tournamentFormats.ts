/**
 * Formatos de calendario de torneos (liga / copa / grupos + fase final) — PURO.
 * Replica las validaciones del BFF para avisar antes de enviar y calcula el resumen en vivo.
 */
import type { FixtureFormat, FormatConfig } from '@/lib/tournamentTypes';

export interface FormatDraft {
  format: FixtureFormat;
  /** Liga: null = todos contra todos. */
  matchesPerTeam: number | null;
  doubleRound: boolean;
  groupCount: number;
  advance: number;
  thirdPlace: boolean;
  draw: 'random' | 'manual';
  seed: string;
  teamOrder: string[];
  scheduleOn: boolean;
  /** `YYYY-MM-DDTHH:mm` (hora local de Colombia). */
  start: string;
  courts: number;
  slotMinutes: number;
  breakMinutes: number;
  /** Grupos: varias copas (oro, plata…) en vez de una sola fase final. */
  cupsOn: boolean;
  cups: CupDraft[];
}

export interface CupDraft { label: string; positions: number[]; thirdPlace: boolean }

export const DEFAULT_CUPS: CupDraft[] = [
  { label: 'Copa oro', positions: [1, 2], thirdPlace: false },
  { label: 'Copa plata', positions: [3, 4], thirdPlace: false },
];

export const DEFAULT_DRAFT: FormatDraft = {
  format: 'liga', matchesPerTeam: null, doubleRound: false,
  groupCount: 2, advance: 2, thirdPlace: false,
  draw: 'random', seed: '', teamOrder: [],
  scheduleOn: false, start: '', courts: 1, slotMinutes: 60, breakMinutes: 10,
  cupsOn: false, cups: DEFAULT_CUPS,
};

/**
 * Copas por defecto según cuántas posiciones tiene el grupo más pequeño: con grupos de 4+ va
 * oro [1,2] y plata [3,4]; con 3, plata [3]; con 2, oro [1] y plata [2]; con 1, solo oro.
 */
export function defaultCupsFor(maxPosition: number): CupDraft[] {
  const max = Math.max(1, Math.floor(maxPosition));
  if (max >= 4) return DEFAULT_CUPS.map((c) => ({ ...c, positions: [...c.positions] }));
  if (max === 3) return [{ label: 'Copa oro', positions: [1, 2], thirdPlace: false }, { label: 'Copa plata', positions: [3], thirdPlace: false }];
  if (max === 2) return [{ label: 'Copa oro', positions: [1], thirdPlace: false }, { label: 'Copa plata', positions: [2], thirdPlace: false }];
  return [{ label: 'Copa oro', positions: [1], thirdPlace: false }];
}

const sameCups = (a: CupDraft[], b: CupDraft[]) => a.length === b.length && a.every((c, i) =>
  c.label === b[i].label && c.thirdPlace === b[i].thirdPlace && c.positions.join(',') === b[i].positions.join(','));

/**
 * Ajusta las copas al tamaño real de los grupos. Si siguen siendo unas copas por defecto (el usuario
 * no las tocó) se reparten de nuevo para ese máximo; si las editó, solo se recortan las posiciones
 * que ya no existen (con 5 equipos en 2 grupos no hay 3.º ni 4.º en el grupo pequeño).
 */
export function fitCupsToMax(cups: CupDraft[], maxPosition: number): CupDraft[] {
  const isDefault = [1, 2, 3, 4].some((m) => sameCups(cups, defaultCupsFor(m)));
  if (isDefault) return defaultCupsFor(maxPosition);
  return cups.map((c) => ({ ...c, positions: c.positions.filter((p) => p >= 1 && p <= maxPosition) }));
}

const FIXTURE_FORMATS: readonly FixtureFormat[] = ['liga', 'copa', 'grupos'];
export const isFixtureFormat = (v: unknown): v is FixtureFormat => typeof v === 'string' && (FIXTURE_FORMATS as readonly string[]).includes(v);

/** Formato con el que arranca el generador: el guardado en el torneo, si no el `?formato=` del asistente, si no liga. */
export function resolveInitialFormat(saved: unknown, fromUrl: unknown): FixtureFormat {
  if (isFixtureFormat(saved)) return saved;
  if (isFixtureFormat(fromUrl)) return fromUrl;
  return 'liga';
}

/** Mismas reglas que el BFF (validateCups): nombre único, posiciones sin repetir y dentro del grupo más pequeño. */
export function validateCups(cups: CupDraft[], groupCount: number, minSize: number): string | null {
  if (cups.length === 0) return 'Agrega al menos una copa.';
  if (cups.length > 8) return 'Máximo 8 copas.';
  const labels = new Set<string>();
  const used = new Set<number>();
  for (const c of cups) {
    const label = c.label.trim();
    if (!label) return 'Ponle nombre a cada copa (por ejemplo «Copa oro»).';
    if (label.length > 40) return 'El nombre de la copa puede tener máximo 40 caracteres.';
    if (labels.has(label.toLowerCase())) return `La copa «${label}» está repetida.`;
    labels.add(label.toLowerCase());
    if (c.positions.length === 0) return `Elige qué posiciones juegan la ${label}.`;
    for (const p of c.positions) {
      if (p > minSize) return `En la ${label} las posiciones deben estar entre 1 y ${minSize} (el grupo más pequeño).`;
      if (used.has(p)) return `El ${p}.º de cada grupo está en dos copas.`;
      used.add(p);
    }
    if (c.positions.length * groupCount < 2) return `La ${label} necesita al menos 2 equipos.`;
  }
  return null;
}

/** Texto corto de las posiciones de una copa: [1,2] → «1.º y 2.º». */
export function positionsText(positions: number[]): string {
  const p = [...positions].sort((a, b) => a - b).map((n) => `${n}.º`);
  if (p.length <= 1) return p.join('');
  return `${p.slice(0, -1).join(', ')} y ${p[p.length - 1]}`;
}

/** Reparte `teams` equipos en `count` grupos lo más parejos posible (los primeros grupos reciben el sobrante). */
export function groupSizes(teams: number, count: number): number[] {
  if (count < 1) return [];
  const base = Math.floor(teams / count);
  const extra = teams % count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

const roundRobin = (n: number) => (n * (n - 1)) / 2;

/** Partidos de la fase eliminatoria para `k` equipos (k - 1, más tercer puesto si hay semifinales). */
export function knockoutMatches(k: number, thirdPlace: boolean): number {
  if (k < 2) return 0;
  return k - 1 + (thirdPlace && k >= 4 ? 1 : 0);
}

export interface FormatSummary {
  groupMatches: number;
  leagueMatches: number;
  knockoutMatches: number;
  total: number;
  text: string;
}

/** `teams = null` = no sabemos cuántos equipos hay: solo se validan las opciones, y el BFF valida el resto. */
export function validateDraft(d: FormatDraft, teamsOrNull: number | null): string | null {
  const known = teamsOrNull != null;
  const teams = teamsOrNull ?? 0;
  if (known && (!Number.isInteger(teams) || teams < 2)) return 'Se necesitan al menos 2 equipos para generar el calendario.';
  if (d.format === 'liga') {
    if (d.matchesPerTeam != null) {
      const m = d.matchesPerTeam;
      if (!Number.isInteger(m) || m < 1) return 'Los partidos por equipo deben ser un número entero de 1 en adelante.';
      if (known && m > teams - 1) return `Con ${teams} equipos cada uno puede jugar máximo ${teams - 1} partidos (usa «ida y vuelta» con todos contra todos si quieres más).`;
      if (known && (teams * m) % 2 !== 0) return `Con ${teams} equipos no se puede dar ${m} partido(s) a cada uno (equipos × partidos debe ser par). Prueba con otro número.`;
    }
  }
  if (d.format === 'grupos') {
    if (!Number.isInteger(d.groupCount) || d.groupCount < 2) return 'Debe haber al menos 2 grupos.';
    const min = known ? Math.floor(teams / d.groupCount) : Number.POSITIVE_INFINITY;
    if (min < 2) return `Con ${teams} equipos no se pueden armar ${d.groupCount} grupos de al menos 2 equipos.`;
    if (d.cupsOn) {
      const err = validateCups(d.cups, d.groupCount, min);
      if (err) return err;
    } else {
      if (!Number.isInteger(d.advance) || d.advance < 1) return 'Debe clasificar al menos 1 equipo por grupo.';
      if (d.advance > min) return `No pueden clasificar ${d.advance} por grupo: el grupo más pequeño tiene ${min} equipos.`;
      if (d.advance * d.groupCount < 2) return 'La fase final necesita al menos 2 equipos clasificados.';
    }
  }
  if (known && d.format === 'copa' && d.thirdPlace && teams < 4) return 'El partido por el tercer puesto necesita al menos 4 equipos.';
  if (d.draw === 'manual' && (!known || d.teamOrder.length !== teams)) return 'El orden manual debe incluir a todos los equipos.';
  if (d.scheduleOn) {
    if (!d.start || Number.isNaN(Date.parse(d.start))) return 'Indica la fecha y hora de inicio del calendario.';
    if (!Number.isInteger(d.courts) || d.courts < 1 || d.courts > 50) return 'Las canchas deben ser entre 1 y 50.';
    if (!Number.isInteger(d.slotMinutes) || d.slotMinutes < 5 || d.slotMinutes > 600) return 'Los minutos por partido deben estar entre 5 y 600.';
    if (!Number.isInteger(d.breakMinutes) || d.breakMinutes < 0 || d.breakMinutes > 240) return 'El descanso debe estar entre 0 y 240 minutos.';
  }
  return null;
}

export function summarizeDraft(d: FormatDraft, teams: number): FormatSummary {
  if (teams < 2) return { groupMatches: 0, leagueMatches: 0, knockoutMatches: 0, total: 0, text: 'Aún no hay equipos suficientes para calcular los partidos.' };
  let groupMatches = 0, leagueMatches = 0, ko = 0;
  let text = '';
  const eq = `${teams} equipo${teams === 1 ? '' : 's'}`;
  if (d.format === 'liga') {
    if (d.matchesPerTeam != null) leagueMatches = Math.floor((teams * d.matchesPerTeam) / 2);
    else leagueMatches = roundRobin(teams) * (d.doubleRound ? 2 : 1);
    text = `${eq} · ${leagueMatches} partidos de liga`;
  } else if (d.format === 'copa') {
    ko = knockoutMatches(teams, d.thirdPlace);
    text = `${eq} · ${ko} partidos de eliminación directa`;
  } else {
    const sizes = groupSizes(teams, Math.max(d.groupCount, 1));
    groupMatches = sizes.reduce((s, n) => s + roundRobin(n) * (d.doubleRound ? 2 : 1), 0);
    const distinct = Array.from(new Set(sizes));
    const sizeTxt = distinct.length === 1 ? `de ${distinct[0]}` : `de ${distinct.join(' o ')}`;
    if (d.cupsOn && d.cups.length > 0) {
      const parts = d.cups.map((c) => ({ label: c.label.trim() || 'Copa', n: knockoutMatches(c.positions.length * d.groupCount, c.thirdPlace) }));
      ko = parts.reduce((s, p) => s + p.n, 0);
      text = `${eq} · ${d.groupCount} grupos ${sizeTxt} · ${groupMatches} partidos de grupo + ${parts.map((p) => `${p.n} de ${p.label}`).join(' + ')}`;
    } else {
      ko = knockoutMatches(d.advance * d.groupCount, d.thirdPlace);
      text = `${eq} · ${d.groupCount} grupos ${sizeTxt} · ${groupMatches} partidos de grupo + ${ko} de fase final`;
    }
  }
  return { groupMatches, leagueMatches, knockoutMatches: ko, total: groupMatches + leagueMatches + ko, text };
}

/** `2026-10-24T09:00` → `2026-10-24T09:00:00-05:00` (Colombia no tiene horario de verano). */
export function toColombiaIso(local: string): string {
  const base = local.length === 16 ? `${local}:00` : local;
  return `${base}-05:00`;
}

/** ISO (cualquier zona) → `YYYY-MM-DDTHH:mm` en hora de Colombia, para un `<input type="datetime-local">`. */
export function toColombiaLocalInput(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t - 5 * 3600_000).toISOString().slice(0, 16);
}

/** Cuerpo para POST /school/:id/categories/:catId/fixtures. */
export function buildFixturesBody(d: FormatDraft, teams: number): { format: FixtureFormat; config: FormatConfig } {
  const config: FormatConfig = { draw: d.draw };
  if (d.draw === 'random' && d.seed.trim() !== '') {
    const n = Number(d.seed);
    config.seed = d.seed.trim() !== '' && Number.isFinite(n) && /^\d+$/.test(d.seed.trim()) ? n : d.seed.trim();
  }
  if (d.draw === 'manual') config.team_order = d.teamOrder;
  if (d.format === 'liga') {
    config.matches_per_team = d.matchesPerTeam;
    config.double_round = d.matchesPerTeam == null ? d.doubleRound : false;
  } else if (d.format === 'copa') {
    config.third_place = d.thirdPlace;
  } else {
    config.double_round = d.doubleRound;
    if (d.cupsOn && d.cups.length > 0) {
      const maxPos = Math.max(...d.cups.flatMap((c) => c.positions));
      config.groups = { count: d.groupCount, advance: maxPos };
      config.cups = d.cups.map((c) => ({ label: c.label.trim(), positions: [...c.positions].sort((a, b) => a - b), third_place: c.thirdPlace }));
      config.third_place = false;
    } else {
      config.groups = { count: d.groupCount, advance: d.advance };
      config.third_place = d.thirdPlace;
    }
  }
  config.schedule = d.scheduleOn
    ? { start: toColombiaIso(d.start), courts: d.courts, slot_minutes: d.slotMinutes, break_minutes: d.breakMinutes }
    : null;
  void teams;
  return { format: d.format, config };
}

/** Mueve un elemento de la lista (para el sorteo manual con subir/bajar). */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list;
  const next = list.slice();
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
