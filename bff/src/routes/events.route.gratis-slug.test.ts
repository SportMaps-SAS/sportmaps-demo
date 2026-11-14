/**
 * Torneos de escuela creados con el asistente: el link conserva las letras sin tildes
 * («Copa Vóley» → «copa-voley-…», no «copa-v-ley-…») y un torneo gratis (is_paid === false)
 * no le cobra a la delegación aunque exista una fase de precio.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { randomUUID } from 'crypto';

vi.mock('../config/supabase', async () => {
  const kit = await import('../services/tournament/fakeDb.testkit');
  return { supabase: kit.fakeSupabase };
});
vi.mock('../middlewares/authMiddleware', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; req.schoolId = 'school-2'; next(); },
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

import { db, resetDb, seedEvent } from '../services/tournament/fakeDb.testkit';
import router, { slugBase, slugifyTitle } from './events.route';

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
beforeEach(() => resetDb());

const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

describe('slug del torneo', () => {
  it('quita tildes, diéresis y la ñ sin partir la palabra', () => {
    expect(slugBase('Copa Demo Vóley E2E')).toBe('copa-demo-voley-e2e');
    expect(slugBase('Ñandú Pingüino — Sub 14')).toBe('nandu-pinguino-sub-14');
    expect(slugBase('¡¡¡')).toBe('');
  });
  it('agrega un sufijo y cae a «torneo» si no queda nada', () => {
    expect(slugifyTitle('Fútbol Niñas')).toMatch(/^futbol-ninas-[a-z0-9]{1,6}$/);
    expect(slugifyTitle('***')).toMatch(/^torneo-[a-z0-9]{1,6}$/);
  });
  it('no deja guion al final al recortar a 60', () => {
    const s = slugBase(`${'a'.repeat(59)} b`);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('inscripción de delegación en torneo gratis', () => {
  const enroll = (eventId: string) => post(`/school-tournaments/${eventId}/enroll`, { teams: [{ team_name: 'Halcones' }] });
  const seedPhase = (eventId: string) => {
    (db.tables.event_price_phases ??= []).push({ id: randomUUID(), event_id: eventId, phase_name: 'Inscripción', valid_until: '2099-12-31', price_solo: 50000, sort_order: 0 });
  };

  it('is_paid === false ⇒ la delegación no debe nada aunque haya fase de precio', async () => {
    const ev = seedEvent({ tournament_scope: 'external', status: 'active', registrations_open: true, visibility: 'public', is_paid: false });
    seedPhase(ev.id);
    const r = await enroll(ev.id);
    expect(r.status).toBe(201);
    expect(Number(r.json.total_owed)).toBe(0);
    expect(r.json.price_phase_id ?? null).toBeNull();
  });

  it('con costo sigue cobrando la fase vigente', async () => {
    const ev = seedEvent({ tournament_scope: 'external', status: 'active', registrations_open: true, visibility: 'public', is_paid: true });
    seedPhase(ev.id);
    const r = await enroll(ev.id);
    expect(r.status).toBe(201);
    expect(Number(r.json.total_owed)).toBe(50000);
  });
});
