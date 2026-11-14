/**
 * Ranking por marca (atletismo y pruebas que no son «A vs B») — PURO.
 *
 * Cada participante carga una o varias marcas (intentos). La mejor marca define la posición:
 *   · time:     menor es mejor (carreras, natación). Empate en la marca = misma posición.
 *   · distance: mayor es mejor (saltos horizontales, lanzamientos). Desempate: la segunda mejor
 *               marca, luego la tercera… (regla de la World Athletics para concursos).
 *   · height:   mayor es mejor (alto, garrocha). Desempate: menos fallos en la altura ganada,
 *               luego menos fallos totales.
 *   · points:   mayor es mejor (combinadas, gimnasia, pruebas con jueces).
 * DNS / DNF / DQ / NM no tienen marca y van al final sin posición ni puntos.
 * Puntos por posición configurables (ej. 10-8-6-5-4-3-2-1) para una tabla por delegación.
 *
 * Copia idéntica en frontend/src/lib/tournamentMarks.ts (prueba de paridad). Editar AMBAS.
 */

export type MarkUnit = 'time' | 'distance' | 'height' | 'points';
export type EntryStatus = 'ok' | 'dns' | 'dnf' | 'dq' | 'nm';

export interface MarkEntry {
  participant_id: string;
  name: string;
  /** Equipo / delegación para la tabla por puntos (opcional). */
  team_id?: string | null;
  /** Intentos válidos en la unidad base (segundos o metros). null = intento nulo. */
  marks: Array<number | null>;
  status?: EntryStatus;
  /** height: fallos en la altura con la que se quedó y fallos totales. */
  failures_at_best?: number;
  failures_total?: number;
}

export interface MarkRules {
  unit: MarkUnit;
  /** Puntos por posición: [1.º, 2.º, …]. Lo que no está = 0. */
  points_by_position?: number[];
}

export interface RankedEntry extends MarkEntry {
  best: number | null;
  /** null para DNS/DNF/DQ/NM o sin marca válida. */
  position: number | null;
  points: number;
  tied: boolean;
}

export const POINTS_8 = [10, 8, 6, 5, 4, 3, 2, 1];

export const lowerIsBetter = (u: MarkUnit) => u === 'time';

const valid = (e: MarkEntry) => (e.status ?? 'ok') === 'ok' ? e.marks.filter((m): m is number => typeof m === 'number' && Number.isFinite(m) && m >= 0) : [];

export function bestMark(e: MarkEntry, unit: MarkUnit): number | null {
  const v = valid(e);
  if (v.length === 0) return null;
  return lowerIsBetter(unit) ? Math.min(...v) : Math.max(...v);
}

/** Compara dos participantes con marca: negativo si `a` va antes. 0 = empate real. */
function compare(a: MarkEntry, b: MarkEntry, unit: MarkUnit): number {
  const va = valid(a), vb = valid(b);
  const sa = [...va].sort((x, y) => (lowerIsBetter(unit) ? x - y : y - x));
  const sb = [...vb].sort((x, y) => (lowerIsBetter(unit) ? x - y : y - x));
  const better = (x: number, y: number) => (lowerIsBetter(unit) ? x - y : y - x);
  const d0 = better(sa[0], sb[0]);
  if (Math.abs(d0) > 1e-9) return d0;
  if (unit === 'distance') {
    for (let i = 1; i < Math.max(sa.length, sb.length); i++) {
      if (sa[i] == null && sb[i] == null) break;
      if (sa[i] == null) return 1;
      if (sb[i] == null) return -1;
      const d = better(sa[i], sb[i]);
      if (Math.abs(d) > 1e-9) return d;
    }
  }
  if (unit === 'height') {
    const fa = a.failures_at_best ?? 0, fb = b.failures_at_best ?? 0;
    if (fa !== fb) return fa - fb;
    const ta = a.failures_total ?? 0, tb = b.failures_total ?? 0;
    if (ta !== tb) return ta - tb;
  }
  return 0;
}

export function rankByMark(entries: MarkEntry[], rules: MarkRules): RankedEntry[] {
  const table = rules.points_by_position ?? [];
  const withMark = entries.filter((e) => bestMark(e, rules.unit) != null);
  const without = entries.filter((e) => bestMark(e, rules.unit) == null);
  const sorted = [...withMark].sort((a, b) => compare(a, b, rules.unit) || a.name.localeCompare(b.name, 'es'));

  const out: RankedEntry[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && compare(sorted[i], sorted[j], rules.unit) === 0) j++;
    const group = sorted.slice(i, j);
    // Empatados comparten posición y se reparten los puntos de los puestos que ocupan.
    const share = group.reduce((acc, _, k) => acc + (table[i + k] ?? 0), 0) / group.length;
    for (const e of group) {
      out.push({ ...e, best: bestMark(e, rules.unit), position: i + 1, points: Math.round(share * 100) / 100, tied: group.length > 1 });
    }
    i = j;
  }
  for (const e of without) out.push({ ...e, best: null, position: null, points: 0, tied: false });
  return out;
}

/** Puntos por equipo/delegación sumando todas las pruebas. */
export function teamPoints(ranked: RankedEntry[][]): Array<{ team_id: string; points: number; golds: number }> {
  const acc: Record<string, { team_id: string; points: number; golds: number }> = {};
  for (const list of ranked) {
    for (const e of list) {
      if (!e.team_id) continue;
      const t = (acc[e.team_id] ??= { team_id: e.team_id, points: 0, golds: 0 });
      t.points += e.points;
      if (e.position === 1) t.golds++;
    }
  }
  return Object.values(acc).sort((a, b) => b.points - a.points || b.golds - a.golds || a.team_id.localeCompare(b.team_id));
}

/**
 * Lee una marca escrita por una persona. Tiempo: «10.52», «10,52», «1:02.35», «2:01:15.4».
 * Distancia/altura: «6.45», «6,45 m». Devuelve la unidad base (segundos o metros) o null.
 */
export function parseMark(text: string, unit: MarkUnit): number | null {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s*(m|s|seg|pts?)$/, '').replace(',', '.');
  if (!t) return null;
  if (unit === 'time' && t.includes(':')) {
    const parts = t.split(':');
    if (parts.length > 3 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
    const nums = parts.map(Number);
    if (nums.slice(1).some((n) => n >= 60)) return null;
    return Math.round(nums.reduce((acc, n) => acc * 60 + n, 0) * 1000) / 1000;
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function formatMark(value: number | null, unit: MarkUnit): string {
  if (value == null) return '—';
  if (unit === 'time') {
    if (value < 60) return value.toFixed(2);
    const h = Math.floor(value / 3600), m = Math.floor((value % 3600) / 60), s = value % 60;
    const ss = s.toFixed(2).padStart(5, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }
  if (unit === 'points') return String(Math.round(value * 100) / 100);
  return `${value.toFixed(2)} m`;
}
