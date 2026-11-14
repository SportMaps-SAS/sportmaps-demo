import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/supabase', () => ({ supabase: {} }));

import { buildIcs, buildNotice, courtPhrase, finalLine, hasProfanity, publicPlayerName, validateComment, validVideoUrl } from './tournament-follow.notices';
import { aggregateStats, challengeVerdict, checkChallenge, countableStats, issueChallenge, mvpVotingOpen, pickWinner } from './tournament-social.service';
import { bogotaDayRange, relationFromGender } from './tournament-follow.service';

const ev = { id: 'e1', title: 'Copa Monster 2026', slug: 'copa-monster' };
const m = {
  id: 'm1', home_name: 'Monsters', away_name: 'Orange', court: 'Cancha 3', scheduled_at: '2026-10-27T15:30:00Z',
  home_score: 2, away_score: 0, model: 'sets' as const,
  sets: [{ home: 25, away: 22, closed: true }, { home: 25, away: 20, closed: true }],
};

describe('avisos del partido', () => {
  it('«Tu partido empieza en 15 min en la cancha 3»', () => {
    const n = buildNotice('starting_soon', ev, m, new Date('2026-10-27T15:15:00Z'));
    expect(n.message).toBe('Monsters vs Orange empieza en 15 min en la cancha 3. Copa Monster 2026.');
    expect(n.link).toBe('/torneo/copa-monster/en-vivo');
    expect(n.data).toEqual({ eventId: 'e1', matchId: 'm1', kind: 'starting_soon' });
  });

  it('«Empezó Monsters vs Orange»', () => {
    const n = buildNotice('started', ev, m);
    expect(n.title).toBe('🏐 Empezó Monsters vs Orange');
    expect(n.message).toBe('La cancha 3 · Síguelo en vivo en Copa Monster 2026.');
  });

  it('«Final: Monsters 2-0 Orange (25-22, 25-20)»', () => {
    expect(finalLine(m)).toBe('Final: Monsters 2-0 Orange (25-22, 25-20)');
    expect(buildNotice('final', ev, m).message).toBe('Final: Monsters 2-0 Orange (25-22, 25-20). Copa Monster 2026.');
  });

  it('si gana el visitante va primero y los sets desde su lado', () => {
    const r = finalLine({ ...m, home_score: 1, away_score: 2, sets: [{ home: 25, away: 20, closed: true }, { home: 18, away: 25, closed: true }, { home: 10, away: 15, closed: true }] });
    expect(r).toBe('Final: Orange 2-1 Monsters (20-25, 25-18, 15-10)');
  });

  it('fútbol: sin sets y empate', () => {
    expect(finalLine({ ...m, model: 'goals', sets: [], home_score: 1, away_score: 1 })).toBe('Final: Monsters 1-1 Orange');
    expect(finalLine({ ...m, model: 'goals', sets: [], home_score: 3, away_score: 1 })).toBe('Final: Monsters 3-1 Orange');
  });

  it('cancha en texto libre y sin cancha', () => {
    expect(courtPhrase('Coliseo El Salitre')).toBe('Coliseo El Salitre');
    expect(courtPhrase(null)).toBeNull();
    expect(buildNotice('starting_soon', ev, { ...m, court: null }, new Date('2026-10-27T15:20:00Z')).message).toBe('Monsters vs Orange empieza en 10 min. Copa Monster 2026.');
  });
});

describe('calendario .ics', () => {
  const matches = [
    { ...m, status: 'scheduled', home_team_id: 't1', away_team_id: 't2' },
    { ...m, id: 'm2', home_name: 'Lobas', away_name: 'Tigres', status: 'scheduled', home_team_id: 't3', away_team_id: 't4', court: 'Cancha 1' },
    { ...m, id: 'm3', status: 'cancelled', home_team_id: 't1', away_team_id: 't3' },
    { ...m, id: 'm4', scheduled_at: null, status: 'scheduled', home_team_id: 't1', away_team_id: 't4' },
  ];
  it('un evento por partido con hora, alarma de 15 min y enlace en vivo', () => {
    const ics = buildIcs(ev, matches, { origin: 'https://app.sportmaps.co', now: new Date('2026-10-27T00:00:00Z') });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('DTSTART:20261027T153000Z');
    expect(ics).toContain('DTEND:20261027T163000Z');
    expect(ics).toContain('SUMMARY:Monsters vs Orange');
    expect(ics).toContain('TRIGGER:-PT15M');
    expect(ics.replace(/\r\n /g, '')).toContain('URL:https://app.sportmaps.co/torneo/copa-monster/en-vivo');
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
  });
  it('filtra por equipo', () => {
    const ics = buildIcs(ev, matches, { origin: 'https://app.sportmaps.co', teamId: 't3' });
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(ics).toContain('SUMMARY:Lobas vs Tigres');
  });
  it('escapa comas y punto y coma', () => {
    const ics = buildIcs({ ...ev, title: 'Copa, Monster; 2026' }, [], { origin: 'https://x' });
    expect(ics).toContain('X-WR-CALNAME:Copa\\, Monster\\; 2026');
  });
});

describe('privacidad de jugadoras', () => {
  it('menor de edad: solo nombre de pila', () => {
    expect(publicPlayerName('SOFÍA ramírez López', 2012, { year: 2026 })).toBe('Sofía');
  });
  it('sin año de nacimiento se trata como menor', () => {
    expect(publicPlayerName('Valentina Gómez', null, { year: 2026 })).toBe('Valentina');
  });
  it('mayor de edad: nombre + inicial del apellido', () => {
    expect(publicPlayerName('Laura Martínez', 2000, { year: 2026 })).toBe('Laura M.');
  });
  it('si hay número, va con el nombre', () => {
    expect(publicPlayerName('Ana Ruiz', 2012, { year: 2026, number: 7 })).toBe('Ana #7');
  });
});

describe('comentarios', () => {
  it('filtra groserías comunes (tildes, mayúsculas, leet y letras repetidas)', () => {
    expect(hasProfanity('qué partido tan bueno')).toBe(false);
    expect(hasProfanity('GONORREA ese árbitro')).toBe(true);
    expect(hasProfanity('m13rda')).toBe(true);
    expect(hasProfanity('hptaaaa')).toBe(true);
    expect(hasProfanity('computadora')).toBe(false); // no por subcadena
  });
  it('valida nombre, largo, enlaces y groserías', () => {
    expect(validateComment('A', 'hola')).toMatch(/nombre/);
    expect(validateComment('Ana', '')).toMatch(/Escribe/);
    expect(validateComment('Ana', 'x'.repeat(501))).toMatch(/500/);
    expect(validateComment('Ana', 'mira https://spam.com')).toMatch(/enlaces/);
    expect(validateComment('Ana', 'malparido')).toMatch(/no se permiten/);
    expect(validateComment('Ana', '¡Vamos Monsters!')).toBeNull();
  });
  it('reto anti-spam: firmado, con mínimo de 3 s y vencimiento', () => {
    const t0 = 1_700_000_000_000;
    const c = issueChallenge(t0, () => 0.5, 'k'); // 5 + 5
    expect(c.question).toBe('¿Cuánto es 5 + 5?');
    expect(checkChallenge(c.token, 10, t0 + 1000, 'k')).toBe(false); // demasiado rápido (bot)
    expect(checkChallenge(c.token, 10, t0 + 5000, 'k')).toBe(true);
    expect(checkChallenge(c.token, 9, t0 + 5000, 'k')).toBe(false);
    expect(checkChallenge(c.token, 10, t0 + 5000, 'otra')).toBe(false);
    expect(checkChallenge(c.token, 10, t0 + 31 * 60_000, 'k')).toBe(false);
    expect(checkChallenge('basura', 10, t0 + 5000, 'k')).toBe(false);
  });
  it('reto anti-spam: «muy rápido» no se confunde con «suma mal» (E2E B14b)', () => {
    const t0 = 1_700_000_000_000;
    const c = issueChallenge(t0, () => 0.5, 'k');
    expect(challengeVerdict(c.token, 10, t0 + 1000, 'k')).toBe('muy_rapido');
    expect(challengeVerdict(c.token, 9, t0 + 1000, 'k')).toBe('incorrecto');
    expect(challengeVerdict(c.token, 10, t0 + 5000, 'k')).toBe('ok');
    expect(challengeVerdict(c.token, 10, t0 + 31 * 60_000, 'k')).toBe('vencido');
    expect(challengeVerdict(c.token, 10, t0 + 5000, 'otra')).toBe('incorrecto');
  });
  it('videos: solo https de plataformas conocidas', () => {
    expect(validVideoUrl('https://youtu.be/abc')).toBe('https://youtu.be/abc');
    expect(validVideoUrl('http://youtu.be/abc')).toBeNull();
    expect(validVideoUrl('https://evil.com/v')).toBeNull();
  });
});

describe('estadísticas y MVP', () => {
  const rows = [
    { match_id: 'm1', member_id: 'a', side: 'home' as const, stat: 'ace' as const, point_index: 0 },
    { match_id: 'm1', member_id: 'a', side: 'home' as const, stat: 'attack' as const, point_index: 2 },
    { match_id: 'm1', member_id: 'b', side: 'away' as const, stat: 'block' as const, point_index: 1 },
    { match_id: 'm1', member_id: 'b', side: 'away' as const, stat: 'ace' as const, point_index: 3 }, // punto deshecho
    { match_id: 'm1', member_id: 'a', side: 'home' as const, stat: 'ace' as const, point_index: 1 }, // lado equivocado
  ];
  it('solo cuentan los puntos que siguen en el marcador y del lado correcto', () => {
    const ok = countableStats(rows, new Map([['m1', 'hah']]));
    expect(ok.map((r) => r.point_index)).toEqual([0, 2, 1]);
  });
  it('agrega Aces / Ataque / Bloqueos / Puntos por jugadora', () => {
    const names = new Map([['a', { name: 'Sofía', team_id: 't1' }], ['b', { name: 'Laura M.', team_id: 't2' }]]);
    const out = aggregateStats(countableStats(rows, new Map([['m1', 'hah']])), names);
    expect(out).toEqual([
      { member_id: 'a', name: 'Sofía', team_id: 't1', side: undefined, ace: 1, attack: 1, block: 0, points: 2 },
      { member_id: 'b', name: 'Laura M.', team_id: 't2', side: undefined, ace: 0, attack: 0, block: 1, points: 1 },
    ]);
  });
  it('MVP: manda la elección del organizador; si no, el más votado', () => {
    const c = [{ id: 'a', team_id: 't1', side: 'home' as const, name: 'Sofía' }, { id: 'b', team_id: 't2', side: 'away' as const, name: 'Ana' }];
    expect(pickWinner(c, { a: 3, b: 5 }, null)).toMatchObject({ member_id: 'b', source: 'public' });
    expect(pickWinner(c, { a: 3, b: 5 }, 'a')).toMatchObject({ member_id: 'a', source: 'organizer' });
    expect(pickWinner(c, {}, null)).toBeNull();
  });
  it('votación abierta en juego y hasta 3 h después', () => {
    const now = Date.parse('2026-10-27T18:00:00Z');
    expect(mvpVotingOpen({ status: 'live', finished_at: null }, now)).toBe(true);
    expect(mvpVotingOpen({ status: 'played', finished_at: '2026-10-27T16:00:00Z' }, now)).toBe(true);
    expect(mvpVotingOpen({ status: 'played', finished_at: '2026-10-27T14:00:00Z' }, now)).toBe(false);
    expect(mvpVotingOpen({ status: 'scheduled', finished_at: null }, now)).toBe(false);
  });
});

describe('«hoy juega»', () => {
  it('día de Bogotá (UTC-5)', () => {
    expect(bogotaDayRange(new Date('2026-10-28T03:00:00Z'))).toEqual({ start: '2026-10-27T05:00:00.000Z', end: '2026-10-28T05:00:00.000Z' });
    expect(bogotaDayRange(new Date('2026-10-28T06:00:00Z')).start).toBe('2026-10-28T05:00:00.000Z');
  });
  it('relación por género', () => {
    expect(relationFromGender('Femenino')).toBe('hija');
    expect(relationFromGender('m')).toBe('hijo');
    expect(relationFromGender(null)).toBe('child');
  });
});
