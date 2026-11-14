import { describe, it, expect, beforeEach } from 'vitest';
import fixture from './__fixtures__/torneo-demo.json';
import {
  allMatchesFeed, avatarColor, brandTextColor, buildCups, dateRangeText, filterCounts, filterMatches, initials, loadCategory, phaseShort,
  pickCategory, playerRanking, publicStandingColumns, qualificationLegend, qualificationMap, roundMatchName, rowCup, safeBrandColor, safeUrl,
  saveCategory, scheduleByDayAndCourt, setsGrid, shareLink, sponsorsByTier, teamIndex, teamSheet, tournamentPhase, tournamentView, tvPlan,
  winnerSide, embedUrl, embedSnippet, parseEmbedView, type PublicLiveV2, type PublicMatchV2, type StandingRowV2,
} from './publicModel';

const data = fixture as unknown as PublicLiveV2;
const mk = (p: Partial<PublicMatchV2>): PublicMatchV2 => ({
  id: 'x', category_id: 'c', stage: 'group', group_label: 'A', round: 1, slot: 1, home_team_id: 'a', away_team_id: 'b',
  home_name: 'A', away_name: 'B', home_label: null, away_label: null, home_score: null, away_score: null, status: 'scheduled',
  scheduled_at: null, court: null, sets: [], started_at: null, finished_at: null, model: 'sets', is_bye: false, ...p,
});

describe('torneo: unión de event + tournament y estado', () => {
  it('toma los campos nuevos de tournament y cae a event si no vienen', () => {
    const t = tournamentView(data);
    expect(t.title).toBe('Copa Campestre de Vóley 2026');
    expect(t.organizer_name).toBe('Club Campestre Demo');
    expect(t.venue?.name).toContain('Coliseo');
    expect(t.stream_url).toBe('https://www.youtube.com/watch?v=demo');
    const legacy = tournamentView({ ...data, tournament: undefined });
    expect(legacy.start_date).toBe('2026-10-31');
    expect(legacy.organizer_name).toBe('Club Campestre Demo');
    expect(legacy.sponsors).toEqual([]);
  });
  it('estado: manda el BFF; si no, se deduce de partidos y fechas', () => {
    expect(tournamentPhase({ status: 'finished' }, [], '2026-01-01')).toBe('finished');
    expect(tournamentPhase({}, [mk({ status: 'live' })], '2026-01-01')).toBe('in_progress');
    expect(tournamentPhase({}, [mk({ status: 'played' }), mk({ status: 'walkover' })], '2026-01-01')).toBe('finished');
    expect(tournamentPhase({ start_date: '2026-11-10' }, [mk({})], '2026-10-27')).toBe('upcoming');
    expect(tournamentPhase({ start_date: '2026-10-27', end_date: '2026-10-28' }, [mk({})], '2026-10-27')).toBe('in_progress');
  });
  it('rango de fechas en español', () => {
    expect(dateRangeText('2026-10-03', '2026-10-13')).toBe('3 – 13 oct 2026');
    expect(dateRangeText('2026-10-24', null)).toBe('24 oct 2026');
    expect(dateRangeText('2026-09-28', '2026-10-02')).toBe('28 sep – 2 oct 2026');
    expect(dateRangeText(null, null)).toBeNull();
  });
  it('color de marca y enlaces seguros', () => {
    expect(safeBrandColor('#0b3b8c')).toBe('#0b3b8c');
    expect(safeBrandColor('red; background:url(x)')).toBeNull();
    expect(brandTextColor('#ffd400')).toBe('#111827');
    expect(brandTextColor('#0b3b8c')).toBe('#ffffff');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://a.co/x')).toBe('https://a.co/x');
  });
});

describe('equipos y avatares', () => {
  it('iniciales de 3 letras y color estable', () => {
    expect(initials('Spikers')).toBe('SPI');
    expect(initials('Angeles Premier')).toBe('AP');
    expect(initials('EDF La Calera')).toBe('EC');
    expect(initials('Club Jumping')).toBe('JUM');
    expect(initials('Monsters', 'MVC')).toBe('MVC');
    expect(avatarColor('Spikers')).toEqual(avatarColor(' spikers '));
    expect(avatarColor('Spikers').bg).not.toBe(avatarColor('En Zona').bg);
  });
  it('índice de equipos con logo del payload v2 y respaldo desde partidos', () => {
    const idx = teamIndex(data);
    expect(idx.get('t1')?.logo_url).toMatch(/^data:image\/svg/);
    expect(idx.get('t2')?.logo_url).toBeNull();
    const legacy = teamIndex({ ...data, teams: undefined });
    expect(legacy.get('t2')?.name).toBe('Halcones del Norte');
  });
});

describe('partidos: filtros, feed y programación', () => {
  const c1 = data.matches.filter((m) => m.category_id === 'c1');
  it('Todos / En vivo / Jugados / Próximos', () => {
    const counts = filterCounts(c1);
    expect(counts).toEqual({ all: 20, live: 1, played: 10, upcoming: 9 });
    expect(filterMatches(c1, 'all')[0].status).toBe('live');
    const played = filterMatches(c1, 'played');
    expect(Date.parse(played[0].scheduled_at!)).toBeGreaterThanOrEqual(Date.parse(played[played.length - 1].scheduled_at!));
    expect(filterMatches([mk({ is_bye: true, status: 'played' })], 'played')).toHaveLength(0);
  });
  it('feed «Todos los partidos» mezcla categorías con su nombre, en vivo primero', () => {
    const feed = allMatchesFeed(data.matches, data.categories);
    expect(feed).toHaveLength(30);
    expect(feed[0].match.status).toBe('live');
    expect(new Set(feed.map((f) => f.categoryName))).toEqual(new Set(['Sub 16 · Femenino', 'Mayores · Masculino']));
  });
  it('programación por día y por cancha (orden natural, sin hora al final)', () => {
    const days = scheduleByDayAndCourt([
      ...c1,
      mk({ id: 'n1', court: 'Cancha 10', scheduled_at: '2026-10-31T09:00:00-05:00' }),
      mk({ id: 'n2', court: null, scheduled_at: null }),
    ]);
    expect(days.map((d) => d.day)).toEqual(['2026-10-31', '2026-11-01', null]);
    expect(days[0].courts.map((c) => c.court)).toEqual(['Cancha 1', 'Cancha 2', 'Cancha 10']);
    expect(days[0].title).toMatch(/sábado.*31.*octubre/);
    const hours = days[0].courts[0].matches.map((m) => m.scheduled_at);
    expect([...hours].sort()).toEqual(hours);
    expect(days[2].courts[0].court).toBe('Sin cancha');
  });
  it('fase corta con copa', () => {
    expect(phaseShort(mk({ stage: 'knockout', round: 2, cup_label: 'Copa oro' }), 2)).toBe('Copa oro · Final');
    expect(phaseShort(mk({ stage: 'knockout', round: 1 }), 2)).toBe('Semifinal');
    expect(phaseShort(mk({ stage: 'third_place', cup_label: 'Copa plata' }), 2)).toBe('Copa plata · 3.º y 4.º');
    expect(phaseShort(mk({ stage: 'group', group_label: 'B' }), 0)).toBe('Grupo B');
  });
  it('ganador y cuadrícula de sets con set en curso', () => {
    expect(winnerSide(mk({ status: 'played', home_score: 0, away_score: 2 }))).toBe('away');
    expect(winnerSide(mk({ status: 'live', home_score: 1, away_score: 0 }))).toBeNull();
    const g = setsGrid([{ home: 21, away: 18, closed: true }, { home: 12, away: 14, closed: false }]);
    expect(g).toEqual({ home: [21, 12, null], away: [18, 14, null], current: 1 });
  });
});

describe('posiciones de voleibol', () => {
  it('columnas PJ PG PP PTS SG SP DS PF PC DP con respaldo de diferencias', () => {
    const cols = publicStandingColumns('sets');
    expect(cols.map((c) => c.label)).toEqual(['PJ', 'PG', 'PP', 'PTS', 'SG', 'SP', 'DS', 'PF', 'PC', 'DP']);
    const row: StandingRowV2 = { team_id: 'a', team_name: 'A', P: 3, W: 2, D: 0, L: 1, GF: 0, GA: 0, GD: 0, Pts: 6, SW: 5, SL: 3, PF: 130, PA: 120 };
    const v = Object.fromEntries(cols.map((c) => [c.label, c.value(row)]));
    expect(v).toMatchObject({ PJ: 3, PG: 2, PP: 1, PTS: 6, SG: 5, SP: 3, DS: '+2', PF: 130, PC: 120, DP: '+10' });
    expect(cols.find((c) => c.label === 'DS')!.value({ ...row, set_diff: -4 })).toBe('-4');
    expect(publicStandingColumns('goals').map((c) => c.label)).toContain('DG');
  });
  it('quién clasifica a qué copa (por referencias y por equipos ya ubicados)', () => {
    const q = qualificationMap(data.matches.filter((m) => m.category_id === 'c1'));
    expect(rowCup(q, 'A', 1, 'zz')).toBe('Copa oro');
    expect(rowCup(q, 'B', 4, 'zz')).toBe('Copa plata');
    expect(qualificationLegend(q)).toEqual([
      { cup: 'Copa oro', text: '1.º y 2.º de cada grupo' },
      { cup: 'Copa plata', text: '3.º y 4.º de cada grupo' },
    ]);
    const q2 = qualificationMap(data.matches.filter((m) => m.category_id === 'c2'));
    expect(rowCup(q2, 'A', 1, 't9')).toBe('Copa oro');
  });
});

describe('copas', () => {
  it('un cuadro por cup_label, oro antes que plata, con 3.º y 4.º', () => {
    const cups = buildCups(data.matches.filter((m) => m.category_id === 'c1'));
    expect(cups.map((c) => c.label)).toEqual(['Copa oro', 'Copa plata']);
    expect(cups[0].rounds.map((r) => r.name)).toEqual(['Semifinales', 'Final']);
    expect(cups[0].thirdPlace).not.toBeNull();
    expect(cups[0].champion).toBeNull();
    expect(roundMatchName('Semifinales', 1, 2)).toBe('Semifinal 2');
    expect(roundMatchName('Final', 0, 1)).toBe('Final');
  });
  it('campeón cuando la final terminó; sin etiqueta → «Fase final»', () => {
    const [oro] = buildCups(data.matches.filter((m) => m.category_id === 'c2'));
    expect(oro.champion).toBe('Campestre Titanes');
    const [plain] = buildCups([mk({ stage: 'knockout', round: 1, status: 'played', home_score: 2, away_score: 1 })]);
    expect(plain.label).toBe('Fase final');
    expect(plain.champion).toBe('A');
  });
});

describe('ficha de equipo, patrocinadores, ranking, TV y compartir', () => {
  it('ficha: partidos, posición y récord', () => {
    const s = teamSheet('t9', data.matches, data.standings.c2);
    expect(s.position).toMatchObject({ group: 'A', pos: 1 });
    expect(s.matches.length).toBe(5);
    expect(s.record.W + s.record.L).toBe(5);
  });
  it('patrocinadores por tier en orden', () => {
    expect(sponsorsByTier(tournamentView(data).sponsors).map((g) => [g.tier, g.sponsors.length])).toEqual([['principal', 1], ['oficial', 2], ['aliado', 2]]);
  });
  it('ranking: sin ceros, de mayor a menor, empates con el mismo puesto', () => {
    const stats = [
      { player_label: 'N.º 7', points: 10, category_id: 'c1' }, { player_label: 'N.º 3', points: 12, category_id: 'c1' },
      { player_label: 'N.º 9', points: 10, category_id: 'c1' }, { player_label: 'N.º 1', points: 0, category_id: 'c1' },
      { player_label: 'N.º 5', points: 30, category_id: 'c2' },
    ];
    const r = playerRanking(stats, 'points', 'c1');
    expect(r.map((x) => [x.player_label, x.rank])).toEqual([['N.º 3', 1], ['N.º 7', 2], ['N.º 9', 2]]);
  });
  it('modo TV rota entre en vivo, posiciones, próximos, resultados y patrocinadores', () => {
    expect(tvPlan(data, tournamentView(data).sponsors).map((s) => s.kind)).toEqual(['live', 'standings', 'standings', 'upcoming', 'results', 'sponsors']);
    expect(tvPlan({ ...data, matches: [], standings: {} }, [])).toEqual([]);
  });
  it('enlaces para compartir torneo, categoría y partido', () => {
    expect(shareLink('https://app.sportmaps.co', 'copa', 'tournament')).toBe('https://app.sportmaps.co/torneo/copa/en-vivo');
    expect(shareLink('https://app.sportmaps.co', 'copa', 'category', { categoryId: 'c1' })).toBe('https://app.sportmaps.co/torneo/copa/en-vivo?cat=c1');
    expect(shareLink('https://app.sportmaps.co', 'copa', 'match', { matchId: 'm1' })).toBe('https://app.sportmaps.co/torneo/copa/partido/m1');
  });
});

describe('insertar en otra web', () => {
  it('url y snippet del iframe, con escape de comillas', () => {
    expect(parseEmbedView('copas')).toBe('copas');
    expect(parseEmbedView('<script>')).toBe('posiciones');
    const u = embedUrl('https://app.sportmaps.co', 'copa x', { vista: 'partidos', categoria: 'c1' });
    expect(u).toBe('https://app.sportmaps.co/torneo/copa%20x/embed?vista=partidos&categoria=c1');
    expect(embedSnippet(u, 'Copa "A"')).toBe('<iframe src="https://app.sportmaps.co/torneo/copa%20x/embed?vista=partidos&amp;categoria=c1" title="Copa &quot;A&quot;" width="100%" height="640" style="border:0;max-width:100%;" loading="lazy" allow="clipboard-write"></iframe>');
  });
});

describe('categoría recordada', () => {
  beforeEach(() => localStorage.clear());
  it('guarda y recupera; si ya no existe usa la primera con partidos', () => {
    saveCategory('copa', 'c2');
    expect(loadCategory('copa')).toBe('c2');
    expect(pickCategory(data.categories, 'c2', data.matches)).toBe('c2');
    expect(pickCategory(data.categories, 'borrada', data.matches)).toBe('c1');
    expect(pickCategory([{ id: 'v' }, { id: 'c2' }], null, data.matches)).toBe('c2');
  });
});
