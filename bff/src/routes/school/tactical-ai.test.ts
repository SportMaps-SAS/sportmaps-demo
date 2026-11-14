/**
 * POST /api/v1/school/tactical/analyze — permisos, caché, cupo y fallas del
 * modelo. Supabase y llm.service van MOCKEADOS: ninguna prueba llama al modelo
 * ni a la base. La respuesta "del modelo" es el fixture grabado de fútbol.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Fila = Record<string, any>;
const st = vi.hoisted(() => ({
  tablas: {} as Record<string, Fila[]>,
  rpcs: [] as { name: string; args: any }[],
  inserts: [] as { tabla: string; fila: Fila }[],
  ledger: null as any,
  upserts: [] as { tabla: string; fila: Fila; opts: any }[],
  upsertError: null as any,
}));

// Sesión del coach (RLS): se registra lo que se escribiría.
vi.mock('../../utils/userClient', () => ({
  userClient: () => ({
    from: (tabla: string) => ({
      upsert: async (fila: Fila, opts: any) => {
        if (st.upsertError) return { error: st.upsertError };
        st.upserts.push({ tabla, fila, opts });
        return { error: null };
      },
    }),
  }),
}));

// supabase.rpc → el libro en memoria (fiel a las RPC de 20261014155445).
vi.mock('../../config/supabase', async () => {
  const { FakeTacticalAiLedger } = await import('../../services/__fixtures__/fakeTacticalAiLedger');
  st.ledger = new FakeTacticalAiLedger();
  function builder(tabla: string) {
    let filas: Fila[] = [...(st.tablas[tabla] ?? [])];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
      maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
      insert: async (fila: Fila) => { st.inserts.push({ tabla, fila }); return { error: null }; },
      then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
    };
    return api;
  }
  const L = () => st.ledger;
  const handlers: Record<string, (a: any) => Promise<any>> = {
    tactical_ai_reserve: (a) => L().reserve({ schoolId: a.p_school_id, userId: a.p_user_id, sport: a.p_sport, estimateMicro: a.p_estimate_micro_usd }),
    tactical_ai_settle: (a) => L().settle({
      reservationId: a.p_reservation_id, costMicro: a.p_cost_micro_usd, provider: a.p_provider, model: a.p_model,
      tokens: { input: a.p_input_tokens, output: a.p_output_tokens, cacheRead: a.p_cache_read_tokens, cacheWrite: a.p_cache_write_tokens },
    }),
    tactical_ai_release: (a) => L().release(a.p_reservation_id),
    tactical_ai_record_cache_hit: (a) => L().cacheHit({ schoolId: a.p_school_id, userId: a.p_user_id, sport: a.p_sport }),
    tactical_ai_user_balance: (a) => L().balance(a.p_school_id, a.p_user_id),
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: async (name: string, args: any) => {
        st.rpcs.push({ name, args });
        const h = handlers[name];
        if (!h) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
        try { return { data: await h(args), error: null }; } catch (e: any) { return { data: null, error: e }; }
      },
    },
  };
});

vi.mock('../../middlewares/authMiddleware', async () => {
  const actual = await vi.importActual<any>('../../middlewares/authMiddleware');
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { id: String(req.headers['x-user'] || 'coach-1') };
      req.schoolId = String(req.headers['x-school'] || 'esc-1');
      req.role = String(req.headers['x-role'] || 'coach');
      next();
    },
  };
});

const llm = vi.hoisted(() => ({ calls: [] as any[], impl: null as null | ((p: any) => Promise<any>) }));
vi.mock('../../services/llm.service', () => ({
  generarJsonEstructurado: async (p: any) => { llm.calls.push(p); return llm.impl!(p); },
  fallasDeError: (err: any) => (Array.isArray(err?.fallas) ? err.fallas : []),
}));

const { default: router } = await import('./tactical-ai');
const { samplePlay, FAKE_ROSTER_NAMES, fakeKey } = await import('./__fixtures__/tacticalAiPlays');
const { anonymizePlay, boardHash, parseAnalyzeInput, validateAiResult } = await import('./tacticalAiShapes');
const { kbVersion } = await import('../../services/tactical-ai-knowledge');

const ledgerMod = await import('../../services/__fixtures__/fakeTacticalAiLedger');
const recorded = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'tacticalAi.recorded.json'), 'utf8'));
const TEAM = '11111111-2222-4333-8444-555555555555';

let base = '';
let server: http.Server;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/v1/school', router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); });

beforeEach(() => {
  st.tablas = {
    teams: [{ id: TEAM, school_id: 'esc-1' }, { id: '99999999-2222-4333-8444-555555555555', school_id: 'esc-2' }],
    school_athletes: FAKE_ROSTER_NAMES.map((full_name) => ({ school_id: 'esc-1', enrolled_team_id: TEAM, full_name })),
    tactical_ai_analyses: [],
  };
  st.tablas.schools = [{ id: 'esc-1', name: 'Club Demo' }];
  st.tablas.profiles = [{ id: 'coach-x', full_name: 'Profe Andrés' }];
  st.rpcs = [];
  st.inserts = [];
  st.upserts = [];
  st.upsertError = null;
  const { FakeTacticalAiLedger } = ledgerMod;
  st.ledger = new FakeTacticalAiLedger();
  llm.calls = [];
  llm.impl = async () => ({ texto: recorded.futbol.texto, provider: 'claude', model: 'claude-sonnet-5-5', tokens: { input: 1400, output: 5900, cacheRead: 0, cacheWrite: 3600 } });
});

let ipSeq = 0;
async function post(body: unknown, headers: Record<string, string> = {}) {
  // Usuario distinto por petición: el rate limit por usuario no interfiere.
  const res = await fetch(`${base}/api/v1/school/tactical/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': `u-${++ipSeq}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

describe('permisos', () => {
  it('padre (rol sin permiso táctico) → 403 y no se toca cupo ni modelo', async () => {
    const r = await post(samplePlay('futbol'), { 'x-role': 'parent' });
    expect(r.status).toBe(403);
    expect(st.rpcs).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
  it('atleta → 403', async () => {
    expect((await post(samplePlay('futbol'), { 'x-role': 'athlete' })).status).toBe(403);
  });
  it('coach de OTRA escuela con un equipo ajeno → 403', async () => {
    const r = await post(samplePlay('futbol'), { 'x-school': 'esc-2' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no es de tu escuela/);
    expect(llm.calls).toHaveLength(0);
  });
  it('jugada inválida → 422 sin llamar al modelo', async () => {
    const r = await post({ ...samplePlay('futbol'), frames: 'x' });
    expect(r.status).toBe(422);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('análisis', () => {
  it('éxito: descuenta 1, guarda la caché anónima y devuelve claves reales', async () => {
    const r = await post(samplePlay('futbol'));
    expect(r.status).toBe(200);
    expect(r.body.cached).toBe(false);
    // Costo REAL: 1400×$2 + 5900×$10 + 3600×$2,5 por millón (Sonnet 5.5) = US$ 0,0708.
    expect(r.body.balance.used_usd).toBeCloseTo(0.0708, 6);
    expect(r.body.balance.budget_usd).toBe(1);
    expect(r.body.balance.remaining_pct).toBe(92);
    expect(r.body.balance.approx_remaining.futbol).toBe(14);
    expect(r.body.balance.exhausted).toBe(false);
    // Mapa p1..pN → clave real: el cliente traduce cualquier «p5» de los textos.
    expect(r.body.keys.p1).toBe(fakeKey(0)); // el arquero (más cerca del arco propio)
    expect(Object.keys(r.body.keys)).toHaveLength(11);
    expect(st.rpcs.map((x) => x.name)).toEqual(['tactical_ai_reserve', 'tactical_ai_settle']);
    expect(st.rpcs[0].args.p_estimate_micro_usd).toBe(80_000);
    expect(st.rpcs[1].args).toMatchObject({ p_cost_micro_usd: 70_800, p_input_tokens: 1400, p_output_tokens: 5900, p_cache_read_tokens: 0, p_cache_write_tokens: 3600, p_model: 'claude-sonnet-5-5' });
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].uso).toEqual({ schoolId: 'esc-1', feature: 'pizarra_ia' });
    // Nada de atletas en lo que se mandó al modelo.
    const sent = `${llm.calls[0].system}\n${llm.calls[0].user}`;
    expect(sent).not.toMatch(/athlete:|aaaa-4bbb/);
    for (const n of FAKE_ROSTER_NAMES) expect(sent).not.toContain(n);
    expect(sent).not.toContain('Sofi');
    // Base táctica propia: principios del deporte en el sistema.
    expect(llm.calls[0].system).toContain('PRINCIPIOS TÁCTICOS DE REFERENCIA');
    expect(llm.calls[0].system).toContain('Transición ataque→defensa');
    // Caché: anónima (p1/r1), con tokens.
    const ins = st.inserts.find((i) => i.tabla === 'tactical_ai_analyses')!;
    expect(ins.fila.board_hash).toMatch(/^[0-9a-f]{64}$/);
    // analysis_ref = hash de la caché: identifica la sugerencia en «Útil / No útil».
    expect(r.body.analysis_ref).toBe(ins.fila.board_hash);
    expect(JSON.stringify(ins.fila.result)).not.toMatch(/athlete:/);
    expect(ins.fila.input_tokens).toBe(5000);
    expect(ins.fila.output_tokens).toBe(5900);
    const keys = r.body.result.contraataques.flatMap((s: any) => s.frames.flatMap((f: any) => f.players.map((p: any) => p.key)));
    expect(keys.some((k: string) => k === fakeKey(0))).toBe(true);
    expect(keys.some((k: string) => k.startsWith('rival:'))).toBe(true);
  });

  it('caché por hash: misma jugada → no llama al modelo NI descuenta cupo', async () => {
    const body = samplePlay('futbol');
    const { input } = parseAnalyzeInput(body);
    const { play, keyMap } = anonymizePlay(input!, new Set());
    const { result } = validateAiResult(recorded.futbol.texto, { sport: 'futbol', ownKeys: new Set(keyMap.keys()) });
    st.tablas.tactical_ai_analyses = [{ school_id: 'esc-1', board_hash: boardHash(play, kbVersion('futbol')), result }];
    const r = await post(body);
    expect(r.status).toBe(200);
    expect(r.body.cached).toBe(true);
    expect(r.body.keys.p1).toBe(fakeKey(0));
    expect(llm.calls).toHaveLength(0);
    // Caché = US$ 0: solo se cuenta el acierto, sin reservar ni cobrar.
    expect(st.rpcs.map((x) => x.name)).toEqual(['tactical_ai_record_cache_hit']);
    expect(r.body.balance.used_usd).toBe(0);
    expect(r.body.balance.cache_hits).toBe(1);
  });

  it('la caché es por escuela: el mismo hash de otra escuela no sirve', async () => {
    const body = samplePlay('futbol');
    const { play } = anonymizePlay(parseAnalyzeInput(body).input!, new Set());
    st.tablas.tactical_ai_analyses = [{ school_id: 'esc-2', board_hash: boardHash(play), result: { lectura: 'ajena' } }];
    const r = await post(body);
    expect(r.body.cached).toBe(false);
    expect(llm.calls).toHaveLength(1);
  });

  it('cupo del usuario agotado → 402 needs_more SIN llamar al modelo, con el mensaje de WhatsApp', async () => {
    st.ledger.user('esc-1', 'coach-x').used = 950_000; // le quedan US$ 0,05 < reserva de 0,08
    const r = await post(samplePlay('futbol'), { 'x-user': 'coach-x' });
    expect(r.status).toBe(402);
    expect(r.body.needs_more).toBe(true);
    expect(r.body.limited_by).toBe('user');
    expect(r.body.error).toBe('Usaste tu IA de este mes.');
    expect(r.body.balance.exhausted).toBe(true);
    expect(r.body.balance.approx_remaining.futbol).toBe(0);
    expect(llm.calls).toHaveLength(0);
    expect(st.rpcs.map((x) => x.name)).toEqual(['tactical_ai_reserve']);
    const msg: string = r.body.request_more_message;
    expect(msg).toContain('Profe Andrés');
    expect(msg).toContain('Club Demo');
    expect(msg).toContain('fútbol 11');
    expect(msg).toContain('Usé el 95 % de mi IA');
    expect(msg).toContain('+50 % de IA');
    expect(msg).not.toContain('US$');
    for (const n of FAKE_ROSTER_NAMES) expect(msg).not.toContain(n);
    expect(msg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('techo de la ESCUELA agotado (10 × US$ 1) → 402 limited_by school aunque el coach tenga saldo', async () => {
    st.ledger.school('esc-1').used = 9_950_000;
    const r = await post(samplePlay('futbol'));
    expect(r.status).toBe(402);
    expect(r.body.limited_by).toBe('school');
    expect(r.body.error).toMatch(/escuela/);
    expect(llm.calls).toHaveLength(0);
  });

  it('con cupo extra (grant) sigue después del presupuesto', async () => {
    const u = st.ledger.user('esc-1', 'coach-x');
    u.used = 1_000_000; u.extra = 500_000;
    const r = await post(samplePlay('futbol'), { 'x-user': 'coach-x' });
    expect(r.status).toBe(200);
    expect(r.body.balance.budget_usd).toBe(1.5);
  });

  it('el modelo falla → 502, se devuelve el análisis (refund)', async () => {
    llm.impl = async () => { const e: any = new Error('todos fallaron'); e.fallas = [{ proveedor: 'claude', error: 'claude_500', ms: 10 }]; throw e; };
    const r = await post(samplePlay('futbol'));
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/No se descontó/);
    expect(st.rpcs.map((x) => x.name)).toEqual(['tactical_ai_reserve', 'tactical_ai_release']);
    expect(r.body.error).toMatch(/No se descontó/);
  });

  it('timeout de todos los proveedores → 504', async () => {
    llm.impl = async () => { const e: any = new Error('x'); e.fallas = [{ proveedor: 'claude', error: 'Request timed out.', ms: 75000 }]; throw e; };
    const r = await post(samplePlay('futbol'));
    expect(r.status).toBe(504);
    expect(r.body.error).toMatch(/tardó demasiado/);
    expect([...st.ledger.users.values()].every((u: any) => u.used === 0 && u.reserved === 0)).toBe(true);
  });

  it('salida inválida del modelo → 502 con refund y sin caché', async () => {
    llm.impl = async () => ({ texto: 'lo siento, no puedo', provider: 'claude', model: 'm', tokens: null });
    const r = await post(samplePlay('futbol'));
    expect(r.status).toBe(502);
    expect(r.body.detalle).toBe('json_invalido');
    expect([...st.ledger.users.values()].every((u: any) => u.used === 0 && u.reserved === 0)).toBe(true);
    expect(st.inserts).toHaveLength(0);
  });

  it('migración sin aplicar (RPC inexistente) → 503 claro', async () => {
    const real = (await import('../../config/supabase')).supabase as any;
    const orig = real.rpc;
    real.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.tactical_ai_reserve' } });
    try {
      const r = await post(samplePlay('futbol'));
      expect(r.status).toBe(503);
      expect(llm.calls).toHaveLength(0);
    } finally { real.rpc = orig; }
  });
});

describe('GET ai-balance', () => {
  async function get(path: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/v1/school/tactical/ai-balance${path}`, { headers: { 'x-user': 'coach-x', ...headers } });
    return { status: res.status, body: await res.json() as any };
  }
  it('mes nuevo: 100 % y unos 15 análisis de fútbol 11, sin mensaje de venta', async () => {
    const r = await get('?sport=futbol');
    expect(r.status).toBe(200);
    expect(r.body.remaining_pct).toBe(100);
    expect(r.body.approx_remaining.futbol).toBe(15);
    expect(r.body.approx_remaining.voleibol).toBe(22);
    expect(r.body.request_more_message).toBeUndefined();
  });
  it('agotado: trae el mensaje con el deporte pedido', async () => {
    st.ledger.user('esc-1', 'coach-x').used = 1_000_000;
    const r = await get('?sport=voleibol');
    expect(r.body.exhausted).toBe(true);
    expect(r.body.request_more_message).toContain('voleibol');
  });
  it('padre → 403', async () => {
    expect((await get('', { 'x-role': 'parent' })).status).toBe(403);
  });
});

describe('POST ai-feedback («Útil / No útil» y «Guardar como nueva jugada»)', () => {
  const HASH = 'a'.repeat(64);
  const result = { lectura: 'x', riesgos: [], contraataques: [{ titulo: 'c', frames: [] }, { titulo: 'c2', frames: [] }], variantes: [{ titulo: 'v', frames: [] }] };
  async function fb(body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/api/v1/school/tactical/ai-feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': 'coach-x', ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  }
  beforeEach(() => { st.tablas.tactical_ai_analyses = [{ school_id: 'esc-1', board_hash: HASH, result }]; });

  it('«Útil» en el contraataque 2: upsert con la sesión del coach, solo las columnas que cambian', async () => {
    const r = await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'contraataque', index: 1, verdict: 'util' });
    expect(r.status).toBe(200);
    expect(st.upserts).toHaveLength(1);
    expect(st.upserts[0].tabla).toBe('tactical_ai_suggestion_feedback');
    expect(st.upserts[0].fila).toEqual({
      school_id: 'esc-1', user_id: 'coach-x', board_hash: HASH, sport: 'futbol', suggestion_kind: 'contraataque', suggestion_index: 1, verdict: 'util',
    });
    expect(st.upserts[0].opts.onConflict).toBe('user_id,school_id,board_hash,suggestion_kind,suggestion_index');
  });
  it('«Guardar como nueva jugada» marca saved_as_play_at sin tocar el voto', async () => {
    const r = await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, saved: true });
    expect(r.status).toBe(200);
    expect(st.upserts[0].fila.saved_as_play_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect('verdict' in st.upserts[0].fila).toBe(false);
  });
  it('análisis de OTRA escuela → 404 sin escribir', async () => {
    const r = await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, verdict: 'no_util' }, { 'x-school': 'esc-2' });
    expect(r.status).toBe(404);
    expect(st.upserts).toHaveLength(0);
  });
  it('sugerencia que no existe → 422', async () => {
    expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 3, verdict: 'util' })).status).toBe(422);
    expect(st.upserts).toHaveLength(0);
  });
  it('cuerpo inválido → 422', async () => {
    expect((await fb({ analysis_ref: 'x', sport: 'futbol', kind: 'variante', index: 0, verdict: 'util' })).status).toBe(422);
    expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0 })).status).toBe(422);
    expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, verdict: 'meh' })).status).toBe(422);
  });
  it('padre / atleta → 403', async () => {
    for (const role of ['parent', 'athlete']) {
      expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, verdict: 'util' }, { 'x-role': role })).status).toBe(403);
    }
    expect(st.upserts).toHaveLength(0);
  });
  it('la RLS rechaza (42501) → 403; tabla sin crear → 503', async () => {
    st.upsertError = { code: '42501', message: 'new row violates row-level security policy' };
    expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, verdict: 'util' })).status).toBe(403);
    st.upsertError = { code: '42P01', message: 'relation does not exist' };
    expect((await fb({ analysis_ref: HASH, sport: 'futbol', kind: 'variante', index: 0, verdict: 'util' })).status).toBe(503);
  });
});

describe('rate limit por usuario', () => {
  it('el 7.º análisis del mismo usuario en un minuto → 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${base}/api/v1/school/tactical/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': 'mismo' }, body: JSON.stringify({ team_id: 'x' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 6).every((s) => s === 422)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});
