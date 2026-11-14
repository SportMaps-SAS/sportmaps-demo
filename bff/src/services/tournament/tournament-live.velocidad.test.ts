/**
 * B9 — velocidad del anotador y tabla pública fresca.
 *   · el Broadcast sale apenas la RPC guarda, antes del avance de llaves y la fase final;
 *   · un punto cuesta: lecturas previas en paralelo + RPC (sin releer el partido después);
 *   · terminar un partido descarta la caché pública de ese torneo y el mensaje lo marca (`standings`);
 *   · los espectadores que piden a la vez comparten una lectura, y una lectura vieja no queda en caché.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/supabase', async () => {
  const kit = await import('./fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

/** Registro de lo que «se mandó» por tiempo real, con una foto de la base en ese instante. */
const pushes: Array<{ slug: string; match: any; extra: any; snapshot: any[] }> = [];
vi.mock('./live-push', async (importOriginal) => {
  const real = await importOriginal<typeof import('./live-push')>();
  const kit = await import('./fakeDb.testkit');
  return {
    ...real,
    pushMatchUpdate: (slug: string, match: any, _b?: unknown, extra: any = {}) => {
      pushes.push({ slug, match, extra, snapshot: kit.db.tables.tournament_matches.map((m) => ({ ...m })) });
      return true;
    },
  };
});

import { db, fakeSupabase, resetDb, seedEvent, seedTeams, seedCategory } from './fakeDb.testkit';
import {
  loadEvent, loadMatches, performMatchAction, preloadMatchAction, generateCategoryFixtures, publicLive, _clearPublicCache,
  authScorekeeper, createScorekeeper, touchScorekeeper, invalidatePublicLive, type Actor, type LiveEvent,
} from './tournament-live.service';
import { assertTournamentOrganizer } from './tournament-access';
import { SCORING_PRESETS } from './scoring.shared';
import { buildLivePayload } from './live-push';

const admin: Actor = { type: 'user', id: 'u1', label: 'Administración' };
const volleyCfg = { ...SCORING_PRESETS.voleibol_3.config };

async function setup(teams = 4) {
  resetDb(); _clearPublicCache(); pushes.length = 0;
  const ev = seedEvent({ live_enabled: true, scoring_config: volleyCfg });
  const cat = seedCategory(ev.id);
  seedTeams(ev.id, cat, teams);
  return { ev: (await loadEvent(ev.id)) as LiveEvent, cat };
}

const act = (ev: LiveEvent, matchId: string, action: any, extra: Record<string, any> = {}) =>
  performMatchAction(ev, matchId, admin, { action, ...extra });

async function playToDecided(ev: LiveEvent, matchId: string, side: 'home' | 'away') {
  await act(ev, matchId, { type: 'start' });
  for (let i = 0; i < 50; i++) await act(ev, matchId, { type: 'point', side });
}

/** Cuenta las consultas a la base (from + rpc) por tabla mientras corre `fn`. */
async function countQueries(fn: () => Promise<unknown>) {
  const tables: string[] = [];
  const orig = fakeSupabase.from;
  const from = vi.spyOn(fakeSupabase, 'from').mockImplementation(((t: string) => { tables.push(t); return orig(t); }) as any);
  const before = db.rpcCalls;
  try { await fn(); } finally { from.mockRestore(); }
  return { tables, rpc: db.rpcCalls - before };
}

beforeEach(() => { pushes.length = 0; });

describe('B9 — camino crítico del anotador', () => {
  it('un punto: partido + idempotencia + RPC; no se relee el partido después de guardar', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const q = await countQueries(() => act(ev, m.id, { type: 'point', side: 'home' }, { client_action_id: 'p-1' }));
    expect(q.rpc).toBe(1);
    expect(q.tables.filter((t) => t === 'tournament_matches')).toHaveLength(1);
    expect(q.tables.filter((t) => t === 'tournament_match_log')).toHaveLength(1);
    expect(q.tables).toHaveLength(2);
  });

  it('el partido que devuelve es el mismo que quedó en la base (versión, estado, sets)', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const r = await act(ev, m.id, { type: 'point', side: 'away' });
    const row = db.tables.tournament_matches.find((x) => x.id === m.id)!;
    expect(r.match).toMatchObject({ version: row.version, status: row.status, live_state: row.live_state, scorer_label: 'Administración' });
    expect((r.match as any).sets[0]).toMatchObject({ home: 0, away: 1 });
    // y el Broadcast lleva esa misma versión
    expect(pushes.at(-1)!.match.version).toBe(row.version);
  });

  it('con las lecturas hechas por la ruta (preload) la acción solo llama a la RPC', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const pre = await preloadMatchAction(ev.id, m.id, 'p-2');
    const q = await countQueries(() => performMatchAction(ev, m.id, admin, { action: { type: 'point', side: 'home' }, client_action_id: 'p-2' }, pre));
    expect(q).toEqual({ tables: [], rpc: 1 });
  });

  it('preload por id (anotador sin cuenta): un partido de OTRO torneo responde 404', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    const other = (await loadEvent(seedEvent({ live_enabled: true, slug: 'otro-torneo' }).id)) as LiveEvent;
    const pre = await preloadMatchAction(null, m.id, null);
    expect(pre.match?.id).toBe(m.id);
    await expect(performMatchAction(other, m.id, admin, { action: { type: 'start' } }, pre)).rejects.toMatchObject({ status: 404 });
  });

  it('un reintento ya aplicado se detecta en el preload y no vuelve a la RPC', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    await act(ev, m.id, { type: 'point', side: 'home' }, { client_action_id: 'dup' });
    const pre = await preloadMatchAction(ev.id, m.id, 'dup');
    const q = await countQueries(() => performMatchAction(ev, m.id, admin, { action: { type: 'point', side: 'home' }, client_action_id: 'dup' }, pre));
    expect(q.rpc).toBe(0);
    expect(db.tables.tournament_matches.find((x) => x.id === m.id)!.live_state.points).toBe('h');
  });
});

describe('B9 — el Broadcast va antes de los efectos secundarios', () => {
  it('al terminar un semifinal el mensaje sale ANTES de llenar la final, y la final queda llena al responder', async () => {
    const { ev, cat } = await setup(4);
    await generateCategoryFixtures(ev, cat, 'copa', { seed: 3 });
    const ms = await loadMatches(ev.id, cat);
    const semi = ms.find((m) => m.stage === 'knockout' && m.round === 1 && m.slot === 1)!;
    const final = ms.find((m) => m.stage === 'knockout' && m.round === 2)!;
    await playToDecided(ev, semi.id, 'home');
    pushes.length = 0;
    const r = await act(ev, semi.id, { type: 'finish' });

    expect(pushes).toHaveLength(1);
    const msg = pushes[0];
    expect(msg.match).toMatchObject({ id: semi.id, status: 'played' });
    expect(msg.extra).toEqual({ standings: true });
    // En el instante del mensaje la final todavía no tenía al ganador…
    expect(msg.snapshot.find((x) => x.id === final.id).home_team_id ?? null).toBeNull();
    // …y cuando el anotador recibe la respuesta, sí.
    expect(r.match.status).toBe('played');
    expect(db.tables.tournament_matches.find((x) => x.id === final.id)!.home_team_id).toBe(semi.home_team_id);
  });

  it('un punto normal no marca la tabla; terminar, reabrir y corregir sí', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    await act(ev, m.id, { type: 'point', side: 'home' });
    expect(pushes.at(-1)!.extra).toEqual({ standings: false });
    for (let i = 0; i < 49; i++) await act(ev, m.id, { type: 'point', side: 'home' });
    await act(ev, m.id, { type: 'finish' });
    expect(pushes.at(-1)!.extra).toEqual({ standings: true });
    await act(ev, m.id, { type: 'reopen' });
    expect(pushes.at(-1)!.extra).toEqual({ standings: true });
  });
});

describe('B9 — tabla pública fresca al terminar un partido', () => {
  it('terminar descarta la caché de 5 s de ESE torneo: la siguiente lectura ya trae la tabla nueva', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await playToDecided(ev, m.id, 'home');
    const before = (await publicLive(ev.slug!))!;
    expect(before.payload.standings[cat].standings.every((r: any) => r.Pts === 0)).toBe(true);

    await act(ev, m.id, { type: 'finish' });
    const after = (await publicLive(ev.slug!))!; // dentro de los 5 s
    expect(after.etag).not.toBe(before.etag);
    expect(after.payload.matches.find((x: any) => x.id === m.id).status).toBe('played');
    expect(after.payload.standings[cat].standings[0].Pts).toBe(3);
  });

  it('un punto normal NO toca la caché (el polling sigue leyendo cada 5 s como mucho)', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await act(ev, m.id, { type: 'start' });
    const a = (await publicLive(ev.slug!))!;
    await act(ev, m.id, { type: 'point', side: 'home' });
    const b = (await publicLive(ev.slug!))!;
    expect(b.etag).toBe(a.etag);
  });

  it('cien espectadores que refrescan a la vez comparten UNA ronda de consultas', async () => {
    const { ev, cat } = await setup(4);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    invalidatePublicLive(ev.slug);
    const q = await countQueries(() => Promise.all(Array.from({ length: 100 }, () => publicLive(ev.slug!))));
    expect(q.tables.filter((t) => t === 'tournament_matches')).toHaveLength(1);
  });

  it('una lectura que empezó antes de terminar el partido no deja en caché la tabla vieja', async () => {
    const { ev, cat } = await setup(2);
    await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
    const [m] = await loadMatches(ev.id, cat);
    await playToDecided(ev, m.id, 'home');
    const slow = publicLive(ev.slug!); // en curso…
    invalidatePublicLive(ev.slug);     // …y llega una invalidación (p. ej. terminó un partido)
    await slow;
    await act(ev, m.id, { type: 'finish' });
    const fresh = (await publicLive(ev.slug!))!;
    expect(fresh.payload.matches.find((x: any) => x.id === m.id).status).toBe('played');
  });
});

describe('B9 — autorización y enlace del anotador en una sola lectura', () => {
  it('assertTournamentOrganizer: una consulta (school_id + creator_role) y misma regla', async () => {
    const { ev } = await setup(2);
    const req: any = { schoolId: 'school-1' };
    const q = await countQueries(() => assertTournamentOrganizer(req, ev.id));
    expect(q.tables).toEqual(['events']);
    // Una organización de torneos (creator_role 'organizer', school_id propio) organiza igual que una escuela.
    db.tables.events.find((e) => e.id === ev.id)!.creator_role = 'organizer';
    await expect(assertTournamentOrganizer(req, ev.id)).resolves.toMatchObject({ id: ev.id });
    // Cualquier otro creador NO es dueño.
    db.tables.events.find((e) => e.id === ev.id)!.creator_role = 'store_owner';
    await expect(assertTournamentOrganizer(req, ev.id)).rejects.toMatchObject({ status: 404 });
    await expect(assertTournamentOrganizer({ schoolId: 'otra' } as any, ev.id)).rejects.toMatchObject({ status: 404 });
  });

  it('authScorekeeper trae el torneo embebido: una consulta', async () => {
    const { ev } = await setup(2);
    const { token } = await createScorekeeper(ev, 'u1', { label: 'Mesa 1' }, 'https://app.sportmaps.co');
    const q = await countQueries(() => authScorekeeper(token));
    expect(q.tables).toEqual(['tournament_scorekeepers']);
    expect((await authScorekeeper(token)).event.id).toBe(ev.id);
  });

  it('«último uso» del enlace: como mucho una escritura por minuto', async () => {
    const { ev } = await setup(2);
    const { id } = await createScorekeeper(ev, 'u1', { label: 'Mesa 1' }, 'https://app.sportmaps.co');
    const t0 = 5_000_000_000_000;
    const q = await countQueries(async () => {
      await touchScorekeeper(id, t0);
      await touchScorekeeper(id, t0 + 10_000);
      await touchScorekeeper(id, t0 + 59_000);
    });
    expect(q.tables).toHaveLength(1);
    const q2 = await countQueries(() => touchScorekeeper(id, t0 + 61_000));
    expect(q2.tables).toHaveLength(1);
  });
});

describe('B9 — contrato del mensaje', () => {
  it('`standings` solo viaja cuando es true (un punto normal no agrega bytes)', () => {
    const m = { id: 'm1', version: 3, status: 'played', home_score: 2, away_score: 0, sets: [] };
    expect(buildLivePayload(m, new Date(0), { standings: true }).standings).toBe(true);
    expect('standings' in buildLivePayload(m, new Date(0), { standings: false })).toBe(false);
    expect('standings' in buildLivePayload(m, new Date(0))).toBe(false);
  });
});
