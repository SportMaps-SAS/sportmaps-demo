import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Base mínima en memoria: lo que usan sendMatchNotices / runStartingSoonReminders. */
const state: { tables: Record<string, any[]>; queries: string[] } = { tables: {}, queries: [] };

function query(table: string) {
  const filters: Array<(r: any) => boolean> = [];
  let op: 'select' | 'insert' | 'upsert' = 'select';
  let payload: any[] = [];
  let upsertOpts: any = {};
  const api: any = {
    select: () => api,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return api; },
    in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return api; },
    gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return api; },
    lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return api; },
    limit: () => api,
    insert: (rows: any) => { op = 'insert'; payload = Array.isArray(rows) ? rows : [rows]; return api; },
    upsert: (rows: any, o: any) => { op = 'upsert'; payload = Array.isArray(rows) ? rows : [rows]; upsertOpts = o; return api; },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  const run = () => {
    state.queries.push(`${op}:${table}`);
    const t = (state.tables[table] ??= []);
    if (op === 'insert') { t.push(...payload); return { data: payload, error: null }; }
    if (op === 'upsert') {
      const keys = String(upsertOpts.onConflict).split(',');
      const fresh = payload.filter((p) => !t.some((r) => keys.every((k) => r[k] === p[k])));
      t.push(...fresh);
      return { data: fresh, error: null };
    }
    return { data: t.filter((r) => filters.every((f) => f(r))), error: null };
  };
  return api;
}

vi.mock('../../config/supabase', () => ({ supabase: { from: (t: string) => query(t) } }));

import { sendMatchNotices, runStartingSoonReminders, onMatchActionApplied, type NoticeItem } from './tournament-follow.service';

const ev = { id: 'e1', title: 'Copa Monster', slug: 'copa-monster' };
const match = {
  id: 'm1', home_team_id: 't1', away_team_id: 't2', home_name: 'Monsters', away_name: 'Orange', court: 'Cancha 3',
  scheduled_at: '2026-10-27T15:30:00Z', home_score: 2, away_score: 0, model: 'sets' as const,
  sets: [{ home: 25, away: 22, closed: true }, { home: 25, away: 20, closed: true }],
};

beforeEach(() => {
  state.queries = [];
  state.tables = {
    tournament_follows: [
      { event_id: 'e1', team_id: null, user_id: 'fan-torneo' },
      { event_id: 'e1', team_id: 't1', user_id: 'fan-monsters' },
      { event_id: 'e1', team_id: 't9', user_id: 'fan-otro-equipo' },
      { event_id: 'e2', team_id: null, user_id: 'fan-otro-torneo' },
    ],
    event_team_members: [
      { team_id: 't1', profile_id: 'deportista-adulta', children: null },
      { team_id: 't2', profile_id: null, children: { parent_id: 'mama-orange' } },
      { team_id: 't2', profile_id: null, children: { parent_id: 'fan-monsters' } }, // también sigue: un solo aviso
    ],
    tournament_match_notices: [], notifications: [], tournament_matches: [],
  };
});

describe('avisos a quien sigue', () => {
  it('«Empezó»: seguidores del torneo y del equipo + familias de la planilla, sin repetir', async () => {
    const n = await sendMatchNotices([{ kind: 'started', ev, match }]);
    const users = state.tables.notifications.map((r) => r.user_id).sort();
    expect(users).toEqual(['deportista-adulta', 'fan-monsters', 'fan-torneo', 'mama-orange']);
    expect(n).toBe(4);
    expect(state.tables.notifications[0]).toMatchObject({ category: 'tournament', title: '🏐 Empezó Monsters vs Orange', link: '/torneo/copa-monster/en-vivo' });
  });

  it('«Final»: solo seguidores (a la planilla ya le llega el aviso de resultado existente)', async () => {
    await sendMatchNotices([{ kind: 'final', ev, match }]);
    expect(state.tables.notifications.map((r) => r.user_id).sort()).toEqual(['fan-monsters', 'fan-torneo']);
    expect(state.tables.notifications[0].message).toBe('Final: Monsters 2-0 Orange (25-22, 25-20). Copa Monster.');
  });

  it('el mismo aviso nunca sale dos veces (reintento, dos BFF o dos corridas del cron)', async () => {
    const item: NoticeItem = { kind: 'final', ev, match };
    await sendMatchNotices([item]);
    await sendMatchNotices([item]);
    await Promise.all([sendMatchNotices([item]), sendMatchNotices([item])]);
    expect(state.tables.notifications).toHaveLength(2);
    expect(state.tables.tournament_match_notices).toEqual([expect.objectContaining({ match_id: 'm1', kind: 'final', recipients: 2 })]);
  });

  it('varios partidos = las mismas 4 consultas (sin N+1)', async () => {
    const items: NoticeItem[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'starting_soon', ev, match: { ...match, id: `m${i}` } }));
    await sendMatchNotices(items);
    expect(state.queries.sort()).toEqual(['insert:notifications', 'select:event_team_members', 'select:tournament_follows', 'upsert:tournament_match_notices']);
  });

  it('sin seguidores ni planilla no escribe nada', async () => {
    state.tables.tournament_follows = []; state.tables.event_team_members = [];
    expect(await sendMatchNotices([{ kind: 'started', ev, match }])).toBe(0);
    expect(state.queries).not.toContain('upsert:tournament_match_notices');
  });
});

describe('recordatorio de 15 min', () => {
  it('toma solo los partidos programados en la ventana [+10, +20) min', async () => {
    const now = new Date('2026-10-27T15:00:00Z');
    const mk = (id: string, at: string, status = 'scheduled') => ({
      id, event_id: 'e1', home_team_id: 't1', away_team_id: 't2', court: 'Cancha 3', scheduled_at: at, status,
      home: { team_name: 'Monsters' }, away: { team_name: 'Orange' }, event: ev,
    });
    state.tables.tournament_matches = [
      mk('a', '2026-10-27T15:15:00.000Z'), mk('b', '2026-10-27T15:25:00.000Z'), mk('c', '2026-10-27T15:05:00.000Z'),
      mk('d', '2026-10-27T15:12:00.000Z', 'live'),
    ];
    const r = await runStartingSoonReminders(now);
    expect(r.matches).toBe(1);
    expect(state.tables.notifications[0].message).toBe('Monsters vs Orange empieza en 15 min en la cancha 3. Copa Monster.');
  });

  it('sin partidos en la ventana: una sola consulta', async () => {
    const r = await runStartingSoonReminders(new Date('2026-10-27T15:00:00Z'));
    expect(r).toEqual({ matches: 0, sent: 0 });
    expect(state.queries).toEqual(['select:tournament_matches']);
  });
});

describe('enchufe tras la acción del anotador', () => {
  it('no lanza aunque todo falle', () => {
    expect(() => onMatchActionApplied({ ...ev, live: true }, 'scheduled', null as any)).not.toThrow();
  });
});
