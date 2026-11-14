/**
 * Reglas de marcador por categoría y desempates — PURO (LiveSettingsPanel).
 * El motor (tournamentScoring.ts / scoring.shared.ts) ya resuelve `scoring_config.by_category[catId]`;
 * esto solo traduce entre lo que elige el organizador y ese JSON.
 */
import { FOOTBALL_DEFAULT, TIEBREAKER_KEYS, type ScoringConfig, type TiebreakerKey } from '@/lib/tournamentScoring';
import type { ScoringPreset } from '@/lib/tournamentTypes';

export const TIEBREAKER_LABEL: Record<TiebreakerKey, string> = {
  pts: 'Puntos',
  wins: 'Partidos ganados',
  set_ratio: 'Cociente de sets',
  point_ratio: 'Cociente de puntos',
  set_diff: 'Diferencia de sets',
  point_diff: 'Diferencia de puntos',
  gd: 'Diferencia de goles',
  gf: 'Goles a favor',
  head_to_head: 'Resultado entre ellos',
};

/** Los que tienen sentido según el modelo (goles no tiene sets; sets no tiene goles). */
export function tiebreakersFor(model: 'goals' | 'sets'): TiebreakerKey[] {
  const goalsOnly: TiebreakerKey[] = ['gd', 'gf'];
  const setsOnly: TiebreakerKey[] = ['set_ratio', 'point_ratio', 'set_diff', 'point_diff'];
  return TIEBREAKER_KEYS.filter((k) => (model === 'sets' ? !goalsOnly.includes(k) : !setsOnly.includes(k)));
}

/** Lo que el organizador elige para una categoría. preset '' = «igual que el torneo» (con ajustes de sets opcionales). */
export interface CategoryRuleDraft {
  preset: string;
  best_of: number | null;
  set_points: number | null;
  deciding_set_points: number | null;
}

export const SAME_AS_TOURNAMENT: CategoryRuleDraft = { preset: '', best_of: null, set_points: null, deciding_set_points: null };

const NUMERIC = ['best_of', 'set_points', 'deciding_set_points'] as const;

/** Config completa de una plantilla: la de fútbol viene vacía (= defaults) y en una categoría hay que explicitarla. */
export function presetConfig(p: ScoringPreset): Partial<ScoringConfig> {
  if (p.config.model) return { ...p.config };
  const { by_category: _b, ...football } = FOOTBALL_DEFAULT;
  void _b;
  return { ...football, ...p.config };
}

const isNumericKey = (k: string) => (NUMERIC as readonly string[]).includes(k);
const nonNumeric = (c: Partial<ScoringConfig>) => Object.fromEntries(Object.entries(c).filter(([k]) => !isNumericKey(k)));

/** Lee la regla guardada de una categoría y la devuelve como borrador (plantilla + ajustes de sets). */
export function ruleFromConfig(entry: Partial<ScoringConfig> | null | undefined, presets: ScoringPreset[]): CategoryRuleDraft {
  if (!entry || Object.keys(entry).length === 0) return { ...SAME_AS_TOURNAMENT };
  const rest = nonNumeric(entry);
  let key = '';
  let base: Partial<ScoringConfig> = {};
  if (Object.keys(rest).length > 0) {
    const candidates = presets.filter((p) => JSON.stringify(sortKeys(nonNumeric(presetConfig(p)))) === JSON.stringify(sortKeys(rest)));
    // vóley a 3 y a 5 solo difieren en los números: se prefiere la que coincide también en ellos.
    const hit = candidates.find((p) => NUMERIC.every((k) => (presetConfig(p) as Record<string, unknown>)[k] === (entry as Record<string, unknown>)[k]))
      ?? candidates[0];
    key = hit?.key ?? 'personalizada';
    base = hit ? presetConfig(hit) : entry;
  }
  const num = (k: typeof NUMERIC[number]) => {
    const v = (entry as Record<string, unknown>)[k];
    return typeof v === 'number' && v !== (base as Record<string, unknown>)[k] ? v : null;
  };
  return { preset: key, best_of: num('best_of'), set_points: num('set_points'), deciding_set_points: num('deciding_set_points') };
}

function sortKeys(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Borrador → entrada de by_category (null = sin regla propia). Mantiene una regla «personalizada» tal cual. */
export function ruleToConfig(
  d: CategoryRuleDraft, presets: ScoringPreset[], previous?: Partial<ScoringConfig> | null,
): Partial<ScoringConfig> | null {
  let base: Partial<ScoringConfig> = {};
  if (d.preset === 'personalizada') base = { ...(previous ?? {}) };
  else if (d.preset !== '') {
    const p = presets.find((x) => x.key === d.preset);
    base = p ? presetConfig(p) : {};
  }
  for (const k of NUMERIC) if (d[k] != null) (base as Record<string, unknown>)[k] = d[k];
  return Object.keys(base).length ? base : null;
}

/** Arma el scoring_config completo con las reglas por categoría (sin tocar lo del torneo). */
export function withByCategory(
  saved: Partial<ScoringConfig> | null, drafts: Record<string, CategoryRuleDraft>, presets: ScoringPreset[],
): Partial<ScoringConfig> {
  const prev = saved?.by_category ?? {};
  const by: Record<string, Partial<ScoringConfig>> = {};
  for (const [catId, d] of Object.entries(drafts)) {
    const c = ruleToConfig(d, presets, prev[catId] as Partial<ScoringConfig> | undefined);
    if (c) by[catId] = c;
  }
  const { by_category: _old, ...rest } = saved ?? {};
  void _old;
  return Object.keys(by).length ? { ...rest, by_category: by } : { ...rest };
}

/** Valida los números de sets que escribe el organizador (mismos límites que el BFF). */
export function validateRule(d: CategoryRuleDraft): string | null {
  if (d.best_of != null && (!Number.isInteger(d.best_of) || d.best_of < 1 || d.best_of > 9 || d.best_of % 2 === 0)) return 'Los sets deben ser 1, 3, 5, 7 o 9.';
  for (const k of ['set_points', 'deciding_set_points'] as const) {
    const v = d[k];
    if (v != null && (!Number.isInteger(v) || v < 1 || v > 100)) return 'Los puntos por set deben estar entre 1 y 100.';
  }
  return null;
}
