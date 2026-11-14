/**
 * Torneos de escuela: identidad pública (logo, portada, sede, reglamento, fecha de cierre) y guardar
 * categorías SIN cambiarles el id (antes se borraban y reinsertaban: los equipos quedaban sin categoría).
 * Base simulada en memoria (fakeDb.testkit).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// validateImageUrl compara contra el host de SUPABASE_URL; el CI lo fija en mock.supabase.co.
// Estas pruebas usan x.supabase.co, así que lo fijamos aquí (cada archivo corre aislado).
process.env.SUPABASE_URL = 'https://x.supabase.co';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

vi.mock('../config/supabase', async () => {
  const kit = await import('../services/tournament/fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});
vi.mock('../middlewares/authMiddleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; req.schoolId = 'school-1'; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import { db, resetDb, seedEvent, seedCategory, seedExternalTeam } from '../services/tournament/fakeDb.testkit';
import { _clearPublicCache } from '../services/tournament/tournament-live.service';
import router from './events.route';

let server: http.Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/events', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/events`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};

function world() {
  resetDb(); _clearPublicCache();
  const ev = seedEvent({ status: 'active' });
  const cat = seedCategory(ev.id);
  return { ev, cat };
}

describe('PATCH /school-tournaments/:id — identidad del torneo', () => {
  it('guarda logo, portada, sede, reglamento y fecha de cierre', async () => {
    const { ev } = world();
    const r = await call('PATCH', `/school-tournaments/${ev.id}`, {
      logo_url: 'https://x.supabase.co/logo.png', banner_url: 'https://x.supabase.co/portada.jpg',
      venue_name: '  Coliseo   Mayor ', venue_maps_url: 'https://maps.app.goo.gl/abc', rules_url: 'https://drive.google.com/r',
      end_date: '2026-11-08', organizer_name: '',
    });
    expect(r.status).toBe(200);
    expect(db.tables.events[0]).toMatchObject({
      logo_url: 'https://x.supabase.co/logo.png', venue_name: 'Coliseo Mayor', end_date: '2026-11-08', organizer_name: null,
    });
  });
  it('rechaza enlaces sin https y una fecha de cierre anterior al inicio', async () => {
    const { ev } = world();
    expect((await call('PATCH', `/school-tournaments/${ev.id}`, { rules_url: 'http://inseguro.co/r' })).json.code).toBe('enlace_invalido');
    expect((await call('PATCH', `/school-tournaments/${ev.id}`, { logo_url: 'ftp://x/logo.png' })).status).toBe(400);
    const r = await call('PATCH', `/school-tournaments/${ev.id}`, { end_date: '2026-11-01' });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('fechas_invalidas');
  });
});

describe('PUT /school-tournaments/:id/categories — conserva los ids', () => {
  const cat = (over: Record<string, unknown> = {}) => ({ division: 'Infantil', level: 'A', category: 'Sub 14', rama: 'Femenina', ...over });

  it('editar una categoría existente no cambia su id (los equipos la conservan)', async () => {
    const { ev, cat: catId } = world();
    const team = seedExternalTeam(ev.id, catId, 'Rival');
    const r = await call('PUT', `/school-tournaments/${ev.id}/categories`, { categories: [cat({ id: catId, age_max: 14 }), cat({ category: 'Mini', rama: 'Mixto' })] });
    expect(r.status).toBe(200);
    expect(db.tables.event_categories_config).toHaveLength(2);
    expect(db.tables.event_categories_config.find((c) => c.id === catId)).toMatchObject({ age_max: 14 });
    expect(db.tables.event_teams.find((t) => t.id === team.id)!.category_id).toBe(catId);
  });
  it('un cliente viejo sin id se empareja por división/nivel/categoría/rama', async () => {
    const { ev, cat: catId } = world();
    await call('PUT', `/school-tournaments/${ev.id}/categories`, { categories: [cat({ age_min: 12 })] });
    expect(db.tables.event_categories_config).toHaveLength(1);
    expect(db.tables.event_categories_config[0]).toMatchObject({ id: catId, age_min: 12 });
  });
  it('no deja quitar una categoría que ya tiene equipos', async () => {
    const { ev, cat: catId } = world();
    seedExternalTeam(ev.id, catId, 'Rival');
    const r = await call('PUT', `/school-tournaments/${ev.id}/categories`, { categories: [cat({ category: 'Otra' })] });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('categoria_en_uso');
    expect(db.tables.event_categories_config.map((c) => c.id)).toEqual([catId]);
  });
  it('quita una categoría vacía', async () => {
    const { ev, cat: catId } = world();
    const r = await call('PUT', `/school-tournaments/${ev.id}/categories`, { categories: [cat({ category: 'Otra' })] });
    expect(r.status).toBe(200);
    expect(db.tables.event_categories_config.map((c) => c.id)).not.toContain(catId);
    expect(db.tables.event_categories_config).toHaveLength(1);
  });
});
