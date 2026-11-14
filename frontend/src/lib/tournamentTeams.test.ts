import { describe, it, expect } from 'vitest';
import { parsePastedTeams, suggestShortName } from './tournamentTeams';
import {
  DEFAULT_DRAFT, DEFAULT_CUPS, validateDraft, summarizeDraft, buildFixturesBody, validateCups, positionsText, type FormatDraft,
} from './tournamentFormats';

describe('parsePastedTeams', () => {
  it('una línea por equipo, con viñetas, numeración y club opcional', () => {
    const txt = '1. Águilas\n- Titanes | Club Titanes\n\n• Halcones\tClub Halcón\n  águilas  \n3) Leones';
    expect(parsePastedTeams(txt)).toEqual([
      { team_name: 'Águilas' },
      { team_name: 'Titanes', club_name: 'Club Titanes' },
      { team_name: 'Halcones', club_name: 'Club Halcón' },
      { team_name: 'Leones' },
    ]);
  });
  it('líneas vacías y espacios no crean equipos; corta nombres muy largos', () => {
    expect(parsePastedTeams('   \n\n')).toEqual([]);
    expect(parsePastedTeams('x'.repeat(200))[0].team_name).toHaveLength(80);
  });
  it('no confunde un nombre con barra pegada («Sub 14/15») con un club', () => {
    expect(parsePastedTeams('Monster Sub14/15')).toEqual([{ team_name: 'Monster Sub14/15' }]);
  });
});

describe('suggestShortName', () => {
  it('iniciales o primeras letras, sin tildes, máximo 4', () => {
    expect(suggestShortName('Club Águilas Doradas')).toBe('CAD');
    expect(suggestShortName('Titanes')).toBe('TIT');
    expect(suggestShortName('a b c d e f')).toBe('ABCD');
    expect(suggestShortName('')).toBe('');
  });
});

describe('copas oro / plata en el generador', () => {
  const d = (p: Partial<FormatDraft>): FormatDraft => ({ ...DEFAULT_DRAFT, format: 'grupos', groupCount: 4, cupsOn: true, ...p });
  it('valida como el BFF', () => {
    expect(validateDraft(d({}), 16)).toBeNull();
    expect(validateDraft(d({ cups: [{ label: 'Oro', positions: [1, 2], thirdPlace: false }, { label: 'Plata', positions: [2, 3], thirdPlace: false }] }), 16)).toMatch(/dos copas/);
    expect(validateDraft(d({ cups: [{ label: ' ', positions: [1], thirdPlace: false }] }), 16)).toMatch(/nombre/);
    expect(validateDraft(d({ cups: DEFAULT_CUPS }), 12)).toMatch(/entre 1 y 3/); // grupos de 3: no hay 4.º
    expect(validateCups([], 2, 4)).toMatch(/al menos una/);
  });
  it('resume los partidos por copa', () => {
    const s = summarizeDraft(d({ cups: [{ label: 'Copa oro', positions: [1, 2], thirdPlace: true }, { label: 'Copa plata', positions: [3, 4], thirdPlace: false }] }), 16);
    expect(s.groupMatches).toBe(24);
    expect(s.knockoutMatches).toBe(8 + 7);
    expect(s.text).toContain('8 de Copa oro + 7 de Copa plata');
  });
  it('arma el cuerpo con copas y advance = la última posición', () => {
    const body = buildFixturesBody(d({ cups: [{ label: ' Copa oro ', positions: [2, 1], thirdPlace: true }, { label: 'Copa plata', positions: [3], thirdPlace: false }] }), 12);
    expect(body.config.groups).toEqual({ count: 4, advance: 3 });
    expect(body.config.cups).toEqual([{ label: 'Copa oro', positions: [1, 2], third_place: true }, { label: 'Copa plata', positions: [3], third_place: false }]);
  });
  it('sin copas el cuerpo es el de antes', () => {
    const body = buildFixturesBody(d({ cupsOn: false, advance: 2 }), 16);
    expect(body.config.groups).toEqual({ count: 4, advance: 2 });
    expect(body.config.cups).toBeUndefined();
  });
  it('positionsText', () => {
    expect(positionsText([2, 1])).toBe('1.º y 2.º');
    expect(positionsText([3])).toBe('3.º');
    expect(positionsText([1, 2, 3])).toBe('1.º, 2.º y 3.º');
  });
});
