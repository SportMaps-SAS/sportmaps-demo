import { describe, it, expect } from 'vitest';
import { SCORING_PRESETS, resolveConfig, validateConfig } from './tournamentScoring';
import { ruleFromConfig, ruleToConfig, withByCategory, validateRule, tiebreakersFor, SAME_AS_TOURNAMENT } from './tournamentRules';
import type { ScoringPreset } from './tournamentTypes';

const presets: ScoringPreset[] = Object.entries(SCORING_PRESETS).map(([key, p]) => ({ key, label: p.label, config: p.config }));
const vol = SCORING_PRESETS.voleibol_3.config;

describe('reglas por categoría', () => {
  it('Mini a 1 set de 15 sobre un torneo de vóley: solo guarda los ajustes de sets', () => {
    const entry = ruleToConfig({ preset: '', best_of: 1, set_points: 15, deciding_set_points: 15 }, presets);
    expect(entry).toEqual({ best_of: 1, set_points: 15, deciding_set_points: 15 });
    const cfg = { ...vol, by_category: { mini: entry! } };
    expect(validateConfig(cfg)).toBeNull();
    expect(resolveConfig(cfg, 'mini')).toMatchObject({ model: 'sets', best_of: 1, set_points: 15, deciding_set_points: 15 });
    expect(ruleFromConfig(entry, presets)).toEqual({ preset: '', best_of: 1, set_points: 15, deciding_set_points: 15 });
  });
  it('una categoría con otra plantilla se reconoce al volver a abrir', () => {
    const entry = ruleToConfig({ ...SAME_AS_TOURNAMENT, preset: 'voleibol_5' }, presets)!;
    expect(ruleFromConfig(entry, presets).preset).toBe('voleibol_5');
    const tweaked = ruleToConfig({ preset: 'voleibol_5', best_of: null, set_points: 21, deciding_set_points: null }, presets)!;
    expect(ruleFromConfig(tweaked, presets)).toMatchObject({ set_points: 21 });
  });
  it('fútbol en una categoría se guarda explícito (no vacío = igual que el torneo)', () => {
    const entry = ruleToConfig({ ...SAME_AS_TOURNAMENT, preset: 'futbol' }, presets)!;
    expect(entry.model).toBe('goals');
    expect(resolveConfig({ ...vol, by_category: { c: entry } }, 'c').model).toBe('goals');
    expect(ruleFromConfig(entry, presets).preset).toBe('futbol');
  });
  it('«igual que el torneo» quita la regla y no toca lo demás', () => {
    const saved = { ...vol, by_category: { a: { best_of: 1 }, b: { best_of: 5 } } };
    const out = withByCategory(saved, { a: SAME_AS_TOURNAMENT, b: { ...SAME_AS_TOURNAMENT, best_of: 5 } }, presets);
    expect(out.by_category).toEqual({ b: { best_of: 5 } });
    expect(out.set_points).toBe(25);
    expect(withByCategory(saved, { a: SAME_AS_TOURNAMENT, b: SAME_AS_TOURNAMENT }, presets).by_category).toBeUndefined();
  });
  it('una regla personalizada que no es plantilla se conserva', () => {
    const custom = { model: 'sets' as const, best_of: 3, set_points: 21, cap: 30 };
    const d = ruleFromConfig(custom, presets);
    expect(d.preset).toBe('personalizada');
    expect(ruleToConfig(d, presets, custom)).toEqual(custom);
  });
  it('valida los números', () => {
    expect(validateRule({ ...SAME_AS_TOURNAMENT, best_of: 2 })).toMatch(/1, 3, 5/);
    expect(validateRule({ ...SAME_AS_TOURNAMENT, set_points: 0 })).toMatch(/entre 1 y 100/);
    expect(validateRule({ ...SAME_AS_TOURNAMENT, best_of: 3, set_points: 25 })).toBeNull();
  });
  it('desempates según el modelo', () => {
    expect(tiebreakersFor('sets')).toContain('set_diff');
    expect(tiebreakersFor('sets')).not.toContain('gd');
    expect(tiebreakersFor('goals')).not.toContain('set_ratio');
  });
});
