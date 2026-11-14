/**
 * Contrato del ranking público (`player_stats` del payload v2) — bug B1 del E2E 2026-10-28:
 * el BFF mandaba las líneas de «vivo» ({member_id, name, ace, attack, block}) y la página pública
 * espera {id, player_label, team_id, team_name, category_id, aces, attack_points, blocks, points}.
 * Con un empate, `player_label.localeCompare` reventaba la página («Algo salió mal»).
 * Datos tomados del torneo demo real `copa-demo-voley-e2e` (Club Campestre Demo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/supabase', async () => {
  const kit = await import('./fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

import { db, resetDb, seedEvent } from './fakeDb.testkit';
import { publicLive, _clearPublicCache, toPublicPlayerStats } from './tournament-live.service';
import type { PlayerStatLine } from './tournament-social.service';

const CAT_SUB14F = 'cf0ffcc9-329c-4891-8fd0-39a8061cd474';
const TITANES = '426e8e8c-10df-4be2-be90-78994139e022';
const CONTRACT_KEYS = ['aces', 'attack_points', 'blocks', 'category_id', 'id', 'player_label', 'points', 'team_id', 'team_name'];

/** Lo que mandaba el BFF en dev el 2026-10-28 (GET /public/copa-demo-voley-e2e/live → player_stats). */
const REAL_LINES: PlayerStatLine[] = [
  { member_id: '12736835-b585-4c89-9047-95c5e2585fc3', name: 'Isabella', team_id: TITANES, ace: 0, attack: 1, block: 0, points: 1 },
  { member_id: '32639250-fba4-4e9f-b8e9-2a7941ea4947', name: 'Camila R.', team_id: TITANES, ace: 1, attack: 0, block: 0, points: 1 },
  { member_id: '28a2a274-784e-47ee-b5d6-635795c44d75', name: 'Laura', team_id: TITANES, ace: 0, attack: 0, block: 1, points: 1 },
];

describe('toPublicPlayerStats', () => {
  it('mapea las líneas de «vivo» al contrato de la página pública, con la categoría del equipo', () => {
    const out = toPublicPlayerStats(REAL_LINES, new Map([[TITANES, { name: 'Titanes', category_id: CAT_SUB14F }]]));
    expect(out).toHaveLength(3);
    for (const r of out) expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS);
    expect(out[1]).toEqual({
      id: '32639250-fba4-4e9f-b8e9-2a7941ea4947', player_label: 'Camila R.', team_id: TITANES, team_name: 'Titanes', category_id: CAT_SUB14F,
      aces: 1, attack_points: 0, blocks: 0, points: 1,
    });
    expect(out.map((r) => [r.attack_points, r.blocks])).toEqual([[1, 0], [0, 0], [0, 1]]);
  });

  it('equipo desconocido: categoría y nombre en null, nunca revienta', () => {
    const [r] = toPublicPlayerStats([REAL_LINES[0]], new Map());
    expect(r).toMatchObject({ team_name: null, category_id: null, player_label: 'Isabella' });
  });
});

describe('publicLive → player_stats', () => {
  beforeEach(() => { resetDb(); _clearPublicCache(); });

  it('sale con el contrato público y category_id para el filtro por categoría', async () => {
    const ev = seedEvent({ slug: 'copa-demo-voley-e2e-test', live_enabled: true });
    db.tables.event_categories_config.push({ id: CAT_SUB14F, event_id: ev.id, division: 'General', level: '1', category: 'Sub 14 Femenino', rama: 'Femenino' });
    const rival = 'c494fa95-0000-4000-8000-000000000001';
    db.tables.event_teams.push(
      { id: TITANES, event_id: ev.id, category_id: CAT_SUB14F, team_name: 'Titanes', status: 'confirmed', is_external: true },
      { id: rival, event_id: ev.id, category_id: CAT_SUB14F, team_name: 'Panteras', status: 'confirmed', is_external: true },
    );
    const matchId = '357c2e10-0000-4000-8000-000000000002';
    db.tables.tournament_matches.push({
      id: matchId, event_id: ev.id, category_id: CAT_SUB14F, stage: 'league', round: 1, slot: 1, home_team_id: TITANES, away_team_id: rival,
      status: 'played', home_score: 2, away_score: 0, version: 3, live_state: { points: 'hha' }, updated_at: new Date().toISOString(),
    });
    db.tables.event_team_members = REAL_LINES.map((l) => ({ id: l.member_id, team_id: TITANES, full_name: l.name, birth_year: 2012 }));
    db.tables.tournament_player_stats = [
      { event_id: ev.id, match_id: matchId, member_id: REAL_LINES[0].member_id, side: 'home', stat: 'attack', point_index: 0 },
      { event_id: ev.id, match_id: matchId, member_id: REAL_LINES[1].member_id, side: 'home', stat: 'ace', point_index: 1 },
    ];
    const out = (await publicLive(ev.slug!))!.payload;
    expect(out.player_stats).toHaveLength(2);
    for (const r of out.player_stats) {
      expect(Object.keys(r).sort()).toEqual(CONTRACT_KEYS);
      expect(r.category_id).toBe(CAT_SUB14F);
      expect(r.team_name).toBe('Titanes');
      expect(typeof r.player_label).toBe('string');
      expect(r.player_label.length).toBeGreaterThan(0);
    }
    const byId = new Map(out.player_stats.map((r: any) => [r.id, r]));
    expect(byId.get(REAL_LINES[0].member_id)).toMatchObject({ attack_points: 1, aces: 0, points: 1 });
    expect(byId.get(REAL_LINES[1].member_id)).toMatchObject({ aces: 1, attack_points: 0, points: 1 });
  });
});
