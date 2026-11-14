/**
 * Rutas HTTP de torneos en vivo: público (ETag, 304, caché), anotador sin cuenta (token), organizador
 * (dueño del torneo) y el PATCH heredado que ahora delega al motor. Base simulada en memoria.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

vi.mock('../config/supabase', async () => {
  const kit = await import('../services/tournament/fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});

const auth = vi.hoisted(() => ({ schoolId: 'school-1' as string | null, role: 'school' }));
vi.mock('../middlewares/authMiddleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; req.schoolId = auth.schoolId; req.role = auth.role; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import { db, resetDb, seedEvent, seedTeams, seedCategory } from '../services/tournament/fakeDb.testkit';
import { _clearPublicCache, loadEvent, loadMatches, generateCategoryFixtures, LiveEvent } from '../services/tournament/tournament-live.service';
import { SCORING_PRESETS } from '../services/tournament/scoring.shared';
import router from './tournament-live.route';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tournament-live', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/tournament-live`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json: any = null;
  try { json = await r.json(); } catch { /* 304 */ }
  return { status: r.status, json, headers: r.headers };
};

async function world(opts: { live?: boolean; scoring?: any; teams?: number } = {}) {
  resetDb(); _clearPublicCache(); auth.schoolId = 'school-1';
  const e = seedEvent({ live_enabled: opts.live ?? true, scoring_config: opts.scoring === undefined ? { ...SCORING_PRESETS.voleibol_3.config } : opts.scoring });
  const cat = seedCategory(e.id);
  seedTeams(e.id, cat, opts.teams ?? 4);
  const ev = (await loadEvent(e.id)) as LiveEvent;
  await generateCategoryFixtures(ev, cat, 'liga', { seed: 1 });
  const matches = await loadMatches(ev.id, cat);
  return { ev, cat, matches };
}

describe('GET /public/:slug/live', () => {
  it('200 con ETag y sin indexar; 304 con If-None-Match', async () => {
    const { ev } = await world();
    const a = await call('GET', `/public/${ev.slug}/live`);
    expect(a.status).toBe(200);
    expect(a.headers.get('x-robots-tag')).toBe('noindex');
    expect(a.headers.get('cache-control')).toBe('public, max-age=5');
    const etag = a.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const b = await call('GET', `/public/${ev.slug}/live`, undefined, { 'if-none-match': etag });
    expect(b.status).toBe(304);
  });
  it('404 para slug inexistente o con caracteres raros', async () => {
    await world();
    expect((await call('GET', '/public/no-existe/live')).status).toBe(404);
    expect((await call('GET', `/public/${encodeURIComponent("x'; drop table")}/live`)).status).toBe(404);
  });
});

describe('anotador sin cuenta', () => {
  it('flujo completo por token: lista, toma, anota, y la revocación lo corta al instante', async () => {
    const { ev, matches } = await world({ teams: 2 });
    const created = await call('POST', `/school/${ev.id}/scorekeepers`, { label: 'Mesa 1', expires_hours: 5 });
    expect(created.status).toBe(201);
    const token = created.json.token as string;

    const list = await call('GET', `/scorer/${token}`);
    expect(list.status).toBe(200);
    expect(list.json.scorekeeper.label).toBe('Mesa 1');
    expect(list.json.matches).toHaveLength(1);

    const mid = matches[0].id;
    const start = await call('POST', `/scorer/${token}/matches/${mid}/actions`, { action: { type: 'start' }, client_action_id: 'a1' });
    expect(start.status).toBe(200);
    expect(start.json.match.status).toBe('live');
    const pt = await call('POST', `/scorer/${token}/matches/${mid}/actions`, { action: { type: 'point', side: 'home' }, client_action_id: 'a2', expected_version: start.json.match.version });
    expect(pt.status).toBe(200);
    expect(pt.json.match.version).toBe(2);
    const dup = await call('POST', `/scorer/${token}/matches/${mid}/actions`, { action: { type: 'point', side: 'home' }, client_action_id: 'a2' });
    expect(dup.json.duplicate).toBe(true);
    const stale = await call('POST', `/scorer/${token}/matches/${mid}/actions`, { action: { type: 'point', side: 'away' }, client_action_id: 'a3', expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('version_conflict');

    const del = await call('DELETE', `/school/${ev.id}/scorekeepers/${created.json.id}`);
    expect(del.status).toBe(200);
    const after = await call('POST', `/scorer/${token}/matches/${mid}/actions`, { action: { type: 'point', side: 'home' } });
    expect(after.status).toBe(403);
    expect(after.json.code).toBe('token_revocado');
    expect((await call('GET', `/scorer/${token}`)).status).toBe(403);
  });
  it('token inventado → 401', async () => {
    await world();
    const r = await call('GET', `/scorer/${'z'.repeat(43)}`);
    expect(r.status).toBe(401);
    expect(r.json.code).toBe('token_invalido');
  });
  it('un enlace de una cancha no anota partidos de otra', async () => {
    const { ev, matches } = await world({ teams: 2 });
    db.tables.tournament_matches.find((m) => m.id === matches[0].id)!.court = 'Cancha 1';
    const c = await call('POST', `/school/${ev.id}/scorekeepers`, { label: 'Mesa 2', court: 'Cancha 2', expires_hours: 5 });
    const r = await call('POST', `/scorer/${c.json.token}/matches/${matches[0].id}/actions`, { action: { type: 'start' } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('otra_cancha');
  });
});

describe('organizador', () => {
  it('otra escuela no ve ni toca el torneo', async () => {
    const { ev, matches } = await world();
    auth.schoolId = 'otra-escuela';
    expect((await call('GET', `/school/${ev.id}/config`)).status).toBe(404);
    expect((await call('POST', `/school/${ev.id}/matches/${matches[0].id}/actions`, { action: { type: 'start' } })).status).toBe(404);
    expect((await call('GET', `/school/${ev.id}/scorekeepers`)).status).toBe(404);
    auth.schoolId = null;
    expect((await call('GET', `/school/${ev.id}/config`)).status).toBe(403);
  });
  it('configura, genera calendario por formato y anota', async () => {
    const { ev, cat } = await world({ live: false, scoring: null });
    const cfg = await call('GET', `/school/${ev.id}/config`);
    expect(cfg.json.suggested_preset).toBe('voleibol_3');
    expect((await call('PATCH', `/school/${ev.id}/config`, { preset: 'voleibol_3', live_enabled: true })).status).toBe(200);

    const bad = await call('POST', `/school/${ev.id}/categories/${cat}/fixtures`, { format: 'grupos', config: {} });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/grupos/);
    const ok = await call('POST', `/school/${ev.id}/categories/${cat}/fixtures`, { format: 'grupos', config: { seed: 1, groups: { count: 2, advance: 2 } } });
    expect(ok.status).toBe(201);
    expect(ok.json.matches).toBe(5); // 2 grupos de 2 equipos (1 partido c/u) + 2 semifinales + final

    const ms = await call('GET', `/school/${ev.id}/matches?category_id=${cat}`);
    expect(ms.json.length).toBe(ok.json.matches);
    const g = ms.json.find((m: any) => m.stage === 'group');
    const res = await call('POST', `/school/${ev.id}/matches/${g.id}/actions`, { action: { type: 'correct', sets: [[25, 20], [25, 21]] } });
    expect(res.status).toBe(200);
    expect(res.json.match.sets).toHaveLength(2);

    const st = await call('GET', `/school/${ev.id}/standings?category_id=${cat}`);
    expect(st.json.groups).toBeTruthy();
    const log = await call('GET', `/school/${ev.id}/log`);
    expect(log.json.length).toBeGreaterThan(0);
  });
  it('acción inválida → 400 y regla incumplida → 422 con código', async () => {
    const { ev, matches } = await world({ teams: 2 });
    expect((await call('POST', `/school/${ev.id}/matches/${matches[0].id}/actions`, { action: { type: 'x' } })).status).toBe(400);
    const r = await call('POST', `/school/${ev.id}/matches/${matches[0].id}/actions`, { action: { type: 'finish' } });
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('no_en_juego');
  });
});

describe('equipos, patrocinadores y hora/cancha (organizador)', () => {
  it('agrega rivales externos pegando una lista, los edita y los quita', async () => {
    const { ev, cat } = await world({ teams: 2 });
    const add = await call('POST', `/school/${ev.id}/teams/external`, { category_id: cat, teams: [{ team_name: 'Águilas' }, { team_name: 'Titanes', short_name: 'tit' }] });
    expect(add.status).toBe(201);
    expect(add.json.created).toHaveLength(2);
    const list = await call('GET', `/school/${ev.id}/teams`);
    expect(list.json.filter((t: any) => t.is_external)).toHaveLength(2);
    const tit = list.json.find((t: any) => t.name === 'Titanes');
    expect(tit.short_name).toBe('TIT');
    const upd = await call('PATCH', `/school/${ev.id}/teams/${tit.id}`, { club_name: 'Club Titanes' });
    expect(upd.status).toBe(200);
    expect(upd.json.club_name).toBe('Club Titanes');
    const del = await call('DELETE', `/school/${ev.id}/teams/${tit.id}`);
    expect(del.status).toBe(200);
    const bad = await call('POST', `/school/${ev.id}/teams/external`, { category_id: cat, teams: [] });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('sin_equipos');
  });
  it('CRUD de patrocinadores y la página pública los muestra', async () => {
    const { ev } = await world();
    const c = await call('POST', `/school/${ev.id}/sponsors`, { name: 'Bebidas', tier: 'principal', url: 'https://bebidas.co' });
    expect(c.status).toBe(201);
    expect((await call('PATCH', `/school/${ev.id}/sponsors/${c.json.id}`, { tier: 'oficial' })).json.tier).toBe('oficial');
    const pub = await call('GET', `/public/${ev.slug}/live`);
    expect(pub.json.tournament.sponsors).toEqual([{ id: c.json.id, name: 'Bebidas', logo_url: null, url: 'https://bebidas.co/', tier: 'oficial' }]);
    expect((await call('DELETE', `/school/${ev.id}/sponsors/${c.json.id}`)).status).toBe(200);
    expect((await call('GET', `/school/${ev.id}/sponsors`)).json).toEqual([]);
  });
  it('edita hora y cancha de un partido y queda en el log', async () => {
    const { ev, matches } = await world({ teams: 2 });
    const r = await call('PATCH', `/school/${ev.id}/matches/${matches[0].id}/schedule`, { scheduled_at: '2026-11-07T09:00:00-05:00', court: 'Cancha 3' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ court: 'Cancha 3', scheduled_at: '2026-11-07T14:00:00.000Z' });
    const log = await call('GET', `/school/${ev.id}/log?match_id=${matches[0].id}`);
    expect(log.json[0].action).toBe('reschedule');
    expect((await call('PATCH', `/school/${ev.id}/matches/${matches[0].id}/schedule`, { scheduled_at: 'x' })).status).toBe(400);
  });
  it('otra escuela no toca equipos, patrocinadores ni horarios', async () => {
    const { ev, cat, matches } = await world({ teams: 2 });
    auth.schoolId = 'otra-escuela';
    expect((await call('GET', `/school/${ev.id}/teams`)).status).toBe(404);
    expect((await call('POST', `/school/${ev.id}/teams/external`, { category_id: cat, teams: [{ team_name: 'X' }] })).status).toBe(404);
    expect((await call('POST', `/school/${ev.id}/sponsors`, { name: 'X' })).status).toBe(404);
    expect((await call('PATCH', `/school/${ev.id}/matches/${matches[0].id}/schedule`, { court: 'X' })).status).toBe(404);
    expect(db.tables.event_teams.filter((t) => t.is_external)).toHaveLength(0);
    expect(db.tables.tournament_sponsors).toHaveLength(0);
  });
});

describe('jugadores, carné e inscripción por link (HTTP)', () => {
  it('organizador agrega jugadores a un rival, imprime carnés y el QR valida sin datos privados', async () => {
    const { ev, cat } = await world({ teams: 2 });
    const add = await call('POST', `/school/${ev.id}/teams/external`, { category_id: cat, teams: [{ team_name: 'Rival' }] });
    const teamId = add.json.created[0].id;
    const p = await call('POST', `/school/${ev.id}/teams/${teamId}/players`, { players: [{ full_name: 'Ana Ruiz', document_number: '777888' }] });
    expect(p.status).toBe(201);
    const cards = await call('GET', `/school/${ev.id}/cards?team_id=${teamId}`);
    expect(cards.json.cards).toHaveLength(1);
    const v = await call('GET', `/public/${ev.slug}/validate/${cards.json.cards[0].token}`);
    expect(v.status).toBe(200);
    expect(v.headers.get('cache-control')).toBe('no-store');
    expect(v.json.player.first_name).toBe('Ana');
    expect(JSON.stringify(v.json)).not.toContain('777888');
    expect((await call('GET', `/public/${ev.slug}/validate/inventado`)).status).toBe(404);
    auth.schoolId = 'otra-escuela';
    expect((await call('GET', `/school/${ev.id}/cards`)).status).toBe(404);
    expect((await call('POST', `/school/${ev.id}/teams/${teamId}/players`, { players: [{ full_name: 'X' }] })).status).toBe(404);
  });
  it('el delegado usa el link sin cuenta; un token inventado → 401', async () => {
    const { ev, cat } = await world({ teams: 2 });
    const add = await call('POST', `/school/${ev.id}/teams/external`, { category_id: cat, teams: [{ team_name: 'Halcones' }] });
    const inv = await call('POST', `/school/${ev.id}/teams/${add.json.created[0].id}/invite`, { delegate_phone: '3001234567' });
    expect(inv.status).toBe(201);
    const token = inv.json.token as string;
    const home = await call('GET', `/invite/${token}`);
    expect(home.status).toBe(200);
    expect(home.json.team.name).toBe('Halcones');
    expect((await call('POST', `/invite/${token}/players`, { players: [{ full_name: 'Uno' }] })).status).toBe(201);
    const sub = await call('POST', `/invite/${token}/submit`, { rules_accepted: true, consent: true, consent_version: home.json.consent.version });
    expect(sub.status).toBe(200);
    expect(sub.json.signup_prefill.club_name).toBe('Halcones');
    expect((await call('GET', `/school/${ev.id}/invites`)).json[0].stage).toBe('listo');
    expect((await call('GET', `/invite/${'z'.repeat(43)}`)).status).toBe(401);
  });
});
