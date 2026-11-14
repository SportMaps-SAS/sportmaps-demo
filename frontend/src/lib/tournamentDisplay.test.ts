import { describe, it, expect } from 'vitest';
import {
  formatSetsLine, scoreText, teamName, validateStreamUrl, buildBracket, knockoutRoundName, standingColumns,
  nowAndNextByCourt, groupForScorer, refreshIntervalMs, agoText, formatBogota, currentSetText, stageLabel, type DisplayMatch,
} from './tournamentDisplay';

const m = (p: Partial<DisplayMatch>): DisplayMatch => ({
  id: 'x', stage: 'league', group_label: null, round: 1, slot: 1, home_name: 'A', away_name: 'B', home_label: null, away_label: null,
  home_score: null, away_score: null, status: 'scheduled', scheduled_at: null, court: null, sets: [], model: 'goals', category_id: 'c', ...p,
});

describe('marcadores y etiquetas', () => {
  it('sets en línea', () => expect(formatSetsLine([{ home: 25, away: 23, closed: true, deciding: false }, { home: 20, away: 25, closed: true, deciding: false }, { home: 15, away: 12, closed: true, deciding: true }])).toBe('25-23 · 20-25 · 15-12'));
  it('score', () => { expect(scoreText(m({}))).toBe('vs'); expect(scoreText(m({ home_score: 2, away_score: 1 }))).toBe('2 - 1'); });
  it('equipo por definir usa la referencia', () => {
    expect(teamName(m({ home_name: null, home_label: '1.º Grupo A' }), 'home')).toBe('1.º Grupo A');
    expect(teamName(m({ away_name: null }), 'away')).toBe('Por definir');
  });
  it('set en curso', () => expect(currentSetText([{ home: 25, away: 20, closed: true, deciding: false }, { home: 14, away: 12, closed: false, deciding: false }])).toBe('Set 2 · 14-12'));
  it('etiqueta de fase', () => { expect(stageLabel(m({ stage: 'group', group_label: 'A', round: 2 }))).toBe('Grupo A · Fecha 2'); });
  it('hora de Bogotá', () => expect(formatBogota('2026-10-24T20:00:00Z', { day: false })).toMatch(/3:00/));
});

describe('enlace de transmisión', () => {
  it('acepta vacío y plataformas permitidas', () => {
    expect(validateStreamUrl('')).toBeNull();
    expect(validateStreamUrl('https://www.youtube.com/watch?v=1')).toBeNull();
    expect(validateStreamUrl('https://youtu.be/abc')).toBeNull();
    expect(validateStreamUrl('https://fb.watch/xyz')).toBeNull();
    expect(validateStreamUrl('https://vimeo.com/1')).toBeNull();
    expect(validateStreamUrl('https://app.veo.co/matches/20261029-final-sub-13/')).toBeNull();
    expect(validateStreamUrl('https://live.veo.co/stream/abc')).toBeNull();
    expect(validateStreamUrl('https://notveo.co/x')).toMatch(/Veo/);
  });
  it('rechaza http, otros dominios y basura', () => {
    expect(validateStreamUrl('http://youtube.com/x')).toMatch(/https/);
    expect(validateStreamUrl('https://evil.com/youtube.com')).toMatch(/YouTube/);
    expect(validateStreamUrl('https://notyoutube.com/x')).toMatch(/YouTube/);
    expect(validateStreamUrl('hola')).toMatch(/no es válido/);
  });
});

describe('cuadro', () => {
  it('nombra rondas desde la final y separa el tercer puesto', () => {
    const list = [
      m({ stage: 'knockout', round: 1, slot: 2 }), m({ stage: 'knockout', round: 1, slot: 1 }),
      m({ stage: 'knockout', round: 2 }), m({ stage: 'third_place', round: 2, slot: 2 }),
    ];
    const b = buildBracket(list);
    expect(b.rounds.map((r) => r.name)).toEqual(['Semifinales', 'Final']);
    expect(b.rounds[0].matches.map((x) => x.slot)).toEqual([1, 2]);
    expect(b.thirdPlace?.stage).toBe('third_place');
    expect(knockoutRoundName(1, 4)).toBe('Octavos de final');
  });
});

describe('tabla y agrupaciones', () => {
  it('columnas por modelo', () => {
    expect(standingColumns('goals').map((c) => c.label)).toEqual(['PJ', 'G', 'E', 'P', 'GF', 'GC', 'DG', 'Pts']);
    expect(standingColumns('sets').map((c) => c.label)).toEqual(['PJ', 'G', 'P', 'Pts', 'SW-SL', 'PF-PA']);
  });
  it('en juego y siguiente por cancha', () => {
    const r = nowAndNextByCourt([
      m({ id: '1', court: 'Cancha 1', status: 'live' }),
      m({ id: '2', court: 'Cancha 1', scheduled_at: '2026-10-24T15:00:00Z' }),
      m({ id: '3', court: 'Cancha 1', scheduled_at: '2026-10-24T14:00:00Z' }),
      m({ id: '4', court: 'Cancha 2', scheduled_at: '2026-10-24T14:00:00Z' }),
    ]);
    expect(r[0]).toMatchObject({ court: 'Cancha 1' });
    expect(r[0].live?.id).toBe('1');
    expect(r[0].next?.id).toBe('3');
    expect(r[1].live).toBeNull();
    expect(r[1].next?.id).toBe('4');
  });
  it('lista del anotador: en juego primero', () => {
    const g = groupForScorer([m({ id: 'a', status: 'played', court: 'C1' }), m({ id: 'b', status: 'live', court: 'C1' }), m({ id: 'c', status: 'scheduled', court: 'C1' })]);
    expect(g[0].matches.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
  it('refresco y «hace Ns»', () => {
    expect(refreshIntervalMs([{ status: 'live' }])).toBe(10000);
    expect(refreshIntervalMs([{ status: 'played' }])).toBe(60000);
    expect(agoText(1000, 13000)).toBe('actualizado hace 12 s');
    expect(agoText(null, 1)).toBe('sin actualizar');
  });
});
