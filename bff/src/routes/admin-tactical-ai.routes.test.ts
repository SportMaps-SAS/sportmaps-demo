/**
 * /api/v1/admin/tactical-ai — solo super_admin (ni admin ni owner), informe
 * del mes y «Dar más cupo» con la sesión del super admin. Supabase mockeado.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

type Fila = Record<string, any>;
const st = vi.hoisted(() => ({ tablas: {} as Record<string, Fila[]>, userRpc: [] as any[], rpcError: null as any }));

vi.mock('../config/supabase', () => {
  function builder(tabla: string) {
    let filas: Fila[] = [...(st.tablas[tabla] ?? [])];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
      in: (c: string, vs: any[]) => { filas = filas.filter((f) => vs.includes(f[c])); return api; },
      lte: (c: string, v: any) => { filas = filas.filter((f) => f[c] <= v); return api; },
      gt: (c: string, v: any) => { filas = filas.filter((f) => f[c] > v); return api; },
      limit: () => api,
      then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
    };
    return api;
  }
  return { supabase: { from: (t: string) => builder(t) }, SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' };
});
vi.mock('../utils/userClient', () => ({
  userClient: () => ({
    rpc: async (name: string, args: any) => {
      st.userRpc.push({ name, args });
      return st.rpcError ? { data: null, error: st.rpcError } : { data: { ok: true, granted_micro_usd: Math.round(args.p_amount_usd * 1e6) }, error: null };
    },
  }),
}));
vi.mock('../middlewares/authMiddleware', async () => {
  const actual = await vi.importActual<any>('../middlewares/authMiddleware');
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { id: 'sa-1' };
      req.role = String(req.headers['x-role'] || 'super_admin');
      next();
    },
  };
});

const { default: router } = await import('./admin-tactical-ai.routes');

let base = '';
let server: http.Server;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/tactical-ai', router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/tactical-ai`;
});
afterAll(() => { server?.close(); });

const S1 = '11111111-1111-4111-8111-111111111111';
const U1 = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  st.userRpc = [];
  st.rpcError = null;
  st.tablas = {
    tactical_ai_user_usage: [{ school_id: S1, user_id: U1, period: '2026-10', budget_micro_usd: 1_000_000, extra_micro_usd: 0, used_micro_usd: 640_000, reserved_micro_usd: 0, analyses: 10, cache_hits: 1, needs_more_count: 0, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, limit_hit_at: null }],
    tactical_ai_school_usage: [{ school_id: S1, period: '2026-10', ceiling_micro_usd: 10_000_000, extra_micro_usd: 0, used_micro_usd: 640_000, reserved_micro_usd: 0, analyses: 10, needs_more_count: 0, limit_hit_at: null }],
    tactical_ai_runs: [{ school_id: S1, user_id: U1, period: '2026-10', sport: 'futbol', status: 'settled', cost_micro_usd: 64_000, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }],
    schools: [{ id: S1, name: 'Club Demo' }],
    profiles: [{ id: U1, full_name: 'Profe Andrés' }],
  };
});

describe('gate', () => {
  for (const role of ['admin', 'owner', 'school_admin', 'coach']) {
    it(`${role} → 403`, async () => {
      expect((await fetch(`${base}/usage`, { headers: { 'x-role': role } })).status).toBe(403);
      const g = await fetch(`${base}/grant`, { method: 'POST', headers: { 'x-role': role, 'content-type': 'application/json' }, body: JSON.stringify({ school_id: S1, amount_usd: 1 }) });
      expect(g.status).toBe(403);
      expect(st.userRpc).toHaveLength(0);
    });
  }
});

describe('usage', () => {
  it('informe del mes con nombres, coach y deporte', async () => {
    const r = await fetch(`${base}/usage?period=2026-10`);
    const b = await r.json() as any;
    expect(r.status).toBe(200);
    expect(b.period).toBe('2026-10');
    expect(b.schools[0]).toMatchObject({ name: 'Club Demo', cost_usd: 0.64 });
    expect(b.schools[0].coaches[0]).toMatchObject({ name: 'Profe Andrés', pct: 64, analyses: 10 });
    expect(b.by_sport.find((s: any) => s.sport === 'futbol').avg_cost_usd).toBe(0.064);
  });

  it('cupo ampliado vigente (x3) en el mes en curso: presupuesto y techo multiplicados; vencido no cuenta', async () => {
    const now = new Date();
    const period = new Date(now.getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);
    for (const t of ['tactical_ai_user_usage', 'tactical_ai_school_usage', 'tactical_ai_runs']) {
      st.tablas[t] = st.tablas[t].map((f) => ({ ...f, period }));
    }
    const iso = (ms: number) => new Date(now.getTime() + ms).toISOString();
    st.tablas.tactical_ai_quota_overrides = [
      { school_id: S1, multiplier: 3, starts_at: iso(-86_400_000), expires_at: iso(86_400_000) },
      { school_id: S1, multiplier: 5, starts_at: iso(-3 * 86_400_000), expires_at: iso(-86_400_000) },
    ];
    const b = await (await fetch(`${base}/usage?period=${period}`)).json() as any;
    expect(b.schools[0]).toMatchObject({ ceiling_usd: 30, quota_multiplier: 3 });
    expect(b.schools[0].coaches[0]).toMatchObject({ budget_usd: 3, pct: 21.3 });
  });
});

describe('grant', () => {
  const post = (body: unknown) => fetch(`${base}/grant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('a un coach, en USD, con la sesión del super admin', async () => {
    const r = await post({ school_id: S1, user_id: U1, amount_usd: 2.5, note: 'piloto' });
    expect(r.status).toBe(200);
    expect(st.userRpc).toEqual([{ name: 'grant_tactical_ai_credits', args: { p_school_id: S1, p_amount_usd: 2.5, p_user_id: U1, p_note: 'piloto' } }]);
  });
  it('a la escuela (sin user_id)', async () => {
    expect((await post({ school_id: S1, amount_usd: 5 })).status).toBe(200);
    expect(st.userRpc[0].args.p_user_id).toBeNull();
  });
  it('montos inválidos → 422 sin llamar a la RPC', async () => {
    expect((await post({ school_id: S1, amount_usd: 0 })).status).toBe(422);
    expect((await post({ school_id: S1, amount_usd: 5000 })).status).toBe(422);
    expect((await post({ school_id: 'x', amount_usd: 1 })).status).toBe(422);
    expect(st.userRpc).toHaveLength(0);
  });
  it('la RPC rechaza (no es super admin en la base) → 403', async () => {
    st.rpcError = { code: '42501', message: 'solo super admin' };
    expect((await post({ school_id: S1, amount_usd: 1 })).status).toBe(403);
  });
});
