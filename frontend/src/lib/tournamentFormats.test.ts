import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DRAFT, groupSizes, knockoutMatches, validateDraft, summarizeDraft, buildFixturesBody, toColombiaIso, moveItem,
  DEFAULT_CUPS, defaultCupsFor, fitCupsToMax, resolveInitialFormat, validateCups,
  type FormatDraft,
} from './tournamentFormats';

describe('copas según el tamaño del grupo (B7)', () => {
  it('reparte las copas por defecto según la posición máxima', () => {
    expect(defaultCupsFor(4).map((c) => c.positions)).toEqual([[1, 2], [3, 4]]);
    expect(defaultCupsFor(3).map((c) => c.positions)).toEqual([[1, 2], [3]]);
    expect(defaultCupsFor(2).map((c) => c.positions)).toEqual([[1], [2]]);
    expect(defaultCupsFor(1).map((c) => c.positions)).toEqual([[1]]);
  });
  it('copas sin tocar se reparten de nuevo; editadas solo se recortan', () => {
    const fitted = fitCupsToMax(DEFAULT_CUPS, 2);
    expect(fitted.map((c) => c.positions)).toEqual([[1], [2]]);
    expect(validateCups(fitted, 2, 2)).toBeNull();
    expect(fitCupsToMax(fitted, 4).map((c) => c.positions)).toEqual([[1, 2], [3, 4]]);
    const custom = [{ label: 'Oro', positions: [1, 3], thirdPlace: true }];
    expect(fitCupsToMax(custom, 2)).toEqual([{ label: 'Oro', positions: [1], thirdPlace: true }]);
  });
});

describe('formato inicial del generador (B5)', () => {
  it('guardado > ?formato= > liga', () => {
    expect(resolveInitialFormat('grupos', 'copa')).toBe('grupos');
    expect(resolveInitialFormat(null, 'copa')).toBe('copa');
    expect(resolveInitialFormat('americano', 'nada')).toBe('liga');
    expect(resolveInitialFormat(undefined, null)).toBe('liga');
  });
});

const d = (p: Partial<FormatDraft>): FormatDraft => ({ ...DEFAULT_DRAFT, ...p });

describe('groupSizes / knockoutMatches', () => {
  it('reparte parejo', () => {
    expect(groupSizes(8, 2)).toEqual([4, 4]);
    expect(groupSizes(10, 3)).toEqual([4, 3, 3]);
  });
  it('partidos de eliminatoria', () => {
    expect(knockoutMatches(4, false)).toBe(3);
    expect(knockoutMatches(4, true)).toBe(4);
    expect(knockoutMatches(2, true)).toBe(1);
    expect(knockoutMatches(8, true)).toBe(8);
  });
});

describe('summarizeDraft', () => {
  it('liga todos contra todos, con ida y vuelta', () => {
    expect(summarizeDraft(d({}), 6).total).toBe(15);
    expect(summarizeDraft(d({ doubleRound: true }), 6).total).toBe(30);
  });
  it('liga con partidos por equipo', () => {
    expect(summarizeDraft(d({ matchesPerTeam: 3 }), 8).total).toBe(12);
  });
  it('copa con tercer puesto', () => {
    expect(summarizeDraft(d({ format: 'copa', thirdPlace: true }), 8).total).toBe(8);
  });
  it('grupos: 8 equipos, 2 grupos de 4, clasifican 2 → 12 + 3', () => {
    const s = summarizeDraft(d({ format: 'grupos', groupCount: 2, advance: 2 }), 8);
    expect(s.groupMatches).toBe(12);
    expect(s.knockoutMatches).toBe(3);
    expect(s.text).toContain('8 equipos · 2 grupos de 4 · 12 partidos de grupo + 3 de fase final');
  });
});

describe('validateDraft', () => {
  it('pide al menos 2 equipos', () => expect(validateDraft(d({}), 1)).toMatch(/al menos 2/));
  it('límite de partidos por equipo', () => {
    expect(validateDraft(d({ matchesPerTeam: 8 }), 8)).toMatch(/máximo 7/);
    expect(validateDraft(d({ matchesPerTeam: 3 }), 5)).toMatch(/par/);
    expect(validateDraft(d({ matchesPerTeam: 3 }), 8)).toBeNull();
  });
  it('grupos mínimos', () => {
    expect(validateDraft(d({ format: 'grupos', groupCount: 3 }), 5)).toMatch(/al menos 2 equipos/);
    expect(validateDraft(d({ format: 'grupos', groupCount: 1 }), 8)).toMatch(/al menos 2 grupos/);
    expect(validateDraft(d({ format: 'grupos', groupCount: 2, advance: 5 }), 8)).toMatch(/grupo más pequeño/);
    expect(validateDraft(d({ format: 'grupos', groupCount: 2, advance: 2 }), 8)).toBeNull();
  });
  it('tercer puesto necesita 4', () => expect(validateDraft(d({ format: 'copa', thirdPlace: true }), 3)).toMatch(/4 equipos/));
  it('manual exige todos los equipos; calendario exige inicio', () => {
    expect(validateDraft(d({ draw: 'manual', teamOrder: ['a'] }), 4)).toMatch(/orden manual/);
    expect(validateDraft(d({ scheduleOn: true }), 4)).toMatch(/inicio/);
    expect(validateDraft(d({ scheduleOn: true, start: '2026-10-24T09:00' }), 4)).toBeNull();
  });
});

describe('buildFixturesBody', () => {
  it('liga solo manda sus opciones', () => {
    const b = buildFixturesBody(d({ doubleRound: true, thirdPlace: true, groupCount: 4 }), 6);
    expect(b.format).toBe('liga');
    expect(b.config.groups).toBeUndefined();
    expect(b.config.third_place).toBeUndefined();
    expect(b.config.double_round).toBe(true);
    expect(b.config.schedule).toBeNull();
  });
  it('grupos con calendario y semilla numérica', () => {
    const b = buildFixturesBody(d({ format: 'grupos', seed: '42', scheduleOn: true, start: '2026-10-24T09:00', courts: 2 }), 8);
    expect(b.config.groups).toEqual({ count: 2, advance: 2 });
    expect(b.config.seed).toBe(42);
    expect(b.config.schedule?.start).toBe('2026-10-24T09:00:00-05:00');
  });
  it('manual envía team_order y no semilla', () => {
    const b = buildFixturesBody(d({ draw: 'manual', teamOrder: ['b', 'a'], seed: '9' }), 2);
    expect(b.config.team_order).toEqual(['b', 'a']);
    expect(b.config.seed).toBeUndefined();
  });
});

describe('utilidades', () => {
  it('toColombiaIso', () => expect(toColombiaIso('2026-10-24T09:00')).toBe('2026-10-24T09:00:00-05:00'));
  it('moveItem', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  });
});
