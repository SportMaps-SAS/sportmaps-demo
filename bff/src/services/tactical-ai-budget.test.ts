/**
 * Cupo de la IA de la pizarra por costo real (migración 20261014155445):
 * costo por modelo/tokens, saldo público, reserva/cobro/liberación con un libro
 * falso, CONCURRENCIA (20 análisis en paralelo no pasan el presupuesto), la RPC
 * con FOR UPDATE leída del .sql, el mensaje de WhatsApp sin atletas y el
 * informe del super admin. Sin base ni modelo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Fila = Record<string, any>;
const st = vi.hoisted(() => ({ tablas: {} as Record<string, Fila[]>, inserts: [] as Fila[] }));
vi.mock('../config/supabase', () => {
  function builder(tabla: string) {
    let filas: Fila[] = [...(st.tablas[tabla] ?? [])];
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { filas = filas.filter((f) => f[c] === v); return api; },
      maybeSingle: async () => ({ data: filas[0] ?? null, error: null }),
      insert: async (fila: Fila) => { st.inserts.push(fila); return { error: null }; },
      then: (ok: any, ko: any) => Promise.resolve({ data: filas, error: null }).then(ok, ko),
    };
    return api;
  }
  return { supabase: { from: (t: string) => builder(t), rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) } };
});

const llm = vi.hoisted(() => ({ calls: 0, impl: null as null | (() => Promise<any>) }));
vi.mock('./llm.service', () => ({
  generarJsonEstructurado: async () => { llm.calls += 1; return llm.impl!(); },
  fallasDeError: (err: any) => (Array.isArray(err?.fallas) ? err.fallas : []),
}));

const budget = await import('./tactical-ai-budget');
const { analyzeTacticalPlay } = await import('./tactical-ai.service');
const { FakeTacticalAiLedger } = await import('./__fixtures__/fakeTacticalAiLedger');
const { buildUsageReport, currentPeriodBogota } = await import('./tactical-ai-report');
const { samplePlay, FAKE_ROSTER_NAMES } = await import('../routes/school/__fixtures__/tacticalAiPlays');
const { parseAnalyzeInput } = await import('../routes/school/tacticalAiShapes');

const recorded = JSON.parse(readFileSync(join(__dirname, '..', 'routes', 'school', '__fixtures__', 'tacticalAi.recorded.json'), 'utf8'));
const MIG = readFileSync(join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20261015171128_pizarra_ia_cupo_por_entrenador_tokens.sql'), 'utf8');

const OK_LLM = async () => ({ texto: recorded.futbol.texto, provider: 'claude', model: 'claude-sonnet-5-5', tokens: { input: 1400, output: 5900, cacheRead: 0, cacheWrite: 3600 } });

beforeEach(() => {
  st.tablas = { tactical_ai_analyses: [], school_athletes: [] };
  st.inserts = [];
  llm.calls = 0;
  llm.impl = OK_LLM;
});

describe('costo por modelo y tokens', () => {
  it('Sonnet 5.5: cada parte a su precio por millón (entrada 2, salida 10, caché lectura 0,2, escritura 2,5)', () => {
    const c = budget.costMicroUsd('claude-sonnet-5-5', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
    expect(c).toEqual({ micro: (2 + 10 + 0.2 + 2.5) * 1_000_000, priced: true });
  });
  it('un análisis típico de fútbol 11 cuesta ≈ US$ 0,07', () => {
    expect(budget.costMicroUsd('claude-sonnet-5-5-20261001', { input: 1400, output: 5900, cacheRead: 0, cacheWrite: 3600 }).micro).toBe(70_800);
  });
  it('Haiku es más barato que Sonnet, Opus más caro', () => {
    const t = { input: 2000, output: 5000, cacheRead: 3000, cacheWrite: 0 };
    const h = budget.costMicroUsd('claude-haiku-4-5', t).micro;
    const s = budget.costMicroUsd('claude-sonnet-5-5', t).micro;
    const o = budget.costMicroUsd('claude-opus-5-5', t).micro;
    expect(h).toBeLessThan(s);
    expect(s).toBeLessThan(o);
    expect(h).toBe(Math.round((2000 * 1 + 5000 * 5 + 3000 * 0.1)));
  });
  it('modelo sin precio o sin tokens → se cobra el estimado (nunca gratis por no saber)', () => {
    expect(budget.costMicroUsd('modelo-raro', { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })).toEqual({ micro: 80_000, priced: false });
    expect(budget.costMicroUsd('claude-sonnet-5-5', null)).toEqual({ micro: 80_000, priced: false });
  });
  it('la reserva (US$ 0,08) cubre el máximo medido por deporte', () => {
    for (const v of Object.values(budget.AVG_COST_USD_BY_SPORT)) expect(v * 1_000_000).toBeLessThan(budget.RESERVE_ESTIMATE_MICRO_USD);
  });
});

const snap = (u: Partial<Record<string, number>>, s: Partial<Record<string, number>> = {}) => ({
  period: '2026-10',
  user: { budget_micro_usd: 1_000_000, extra_micro_usd: 0, used_micro_usd: 0, reserved_micro_usd: 0, analyses: 0, cache_hits: 0, ...u },
  school: { ceiling_micro_usd: 10_000_000, extra_micro_usd: 0, used_micro_usd: 0, reserved_micro_usd: 0, ...s },
});

describe('saldo público', () => {
  it('40 % usado → queda el 60 %, unos 9 análisis de fútbol 11', () => {
    const b = budget.toPublicBalance(snap({ used_micro_usd: 400_000 }));
    expect(b.remaining_pct).toBe(60);
    expect(b.pct).toBe(40);
    expect(b.approx_remaining.futbol).toBe(9); // floor((600000-80000)/64000)+1
    expect(b.exhausted).toBe(false);
  });
  it('menos que la reserva → agotado, 0 análisis, limited_by user', () => {
    const b = budget.toPublicBalance(snap({ used_micro_usd: 930_000 }));
    expect(b.exhausted).toBe(true);
    expect(b.limited_by).toBe('user');
    expect(b.approx_remaining.voleibol).toBe(0);
  });
  it('el techo de la escuela manda si es menor', () => {
    const b = budget.toPublicBalance(snap({}, { used_micro_usd: 9_960_000 }));
    expect(b.exhausted).toBe(true);
    expect(b.limited_by).toBe('school');
  });
  it('lo reservado en vuelo cuenta como no disponible', () => {
    expect(budget.toPublicBalance(snap({ reserved_micro_usd: 500_000 })).remaining_pct).toBe(50);
  });
});

describe('mensaje de WhatsApp «Quiero más»', () => {
  it('escuela, coach, deporte y consumo; nada de atletas ni ids', () => {
    const msg = budget.buildMoreAiWhatsappMessage({
      schoolName: 'Club Demo', coachName: 'Profe\nAndrés', sport: 'futbol',
      balance: { period: '2026-10', pct: 98, analyses: 15, limited_by: 'user' },
    });
    expect(msg).toBe('Hola, soy Profe Andrés de Club Demo. Usé el 98 % de mi IA de la pizarra de octubre 2026 (analizo jugadas de fútbol 11), 15 análisis. Quiero una recarga de +50 % de IA.');
    // Misma moneda que el medidor (%): nada de US$ en lo que ve el coach.
    expect(msg).not.toContain('US$');
    for (const n of FAKE_ROSTER_NAMES) expect(msg).not.toContain(n);
    expect(msg).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(msg).not.toMatch(/\n/);
  });
  it('techo de escuela: lo dice', () => {
    const msg = budget.buildMoreAiWhatsappMessage({
      schoolName: null, coachName: null, sport: null,
      balance: { period: '2026-10', pct: 20, analyses: 3, limited_by: 'school' },
    });
    expect(msg).toContain('mi escuela');
    expect(msg).toContain('tope mensual');
  });
});

describe('recargas en la moneda del medidor', () => {
  it('medidor en % → «+50 % de IA»; en análisis → «+10 análisis»', () => {
    expect(budget.AI_METER_UNIT).toBe('pct');
    expect(budget.rechargeOffer()).toEqual({ unit: 'pct', amount: 50, label: '+50 % de IA' });
    expect(budget.rechargeOffer('analyses')).toEqual({ unit: 'analyses', amount: 10, label: '+10 análisis' });
  });
  it('el saldo público trae la recarga en la misma moneda', () => {
    expect(budget.toPublicBalance(snap({})).recharge.label).toBe('+50 % de IA');
  });
  it('USD de la recarga: % del presupuesto BASE o análisis al costo medio, redondeado hacia arriba', () => {
    expect(budget.rechargeUsd({ unit: 'pct', amount: 50 }, 1)).toBe(0.5);
    expect(budget.rechargeUsd({ unit: 'pct', amount: 100 }, 1)).toBe(1);
    expect(budget.rechargeUsd({ unit: 'analyses', amount: 10 }, 1, 'futbol')).toBe(0.64);
    expect(budget.rechargeUsd({ unit: 'analyses', amount: 10 }, 1, 'voleibol')).toBe(0.43);
    expect(budget.rechargeUsd({ unit: 'pct', amount: 33 }, 0.333333)).toBe(0.11);
  });
});

describe('cupo ampliado temporal (boost)', () => {
  it('sin boost → null; con x3 lo expone (el presupuesto ya viene multiplicado de la RPC)', () => {
    expect(budget.toPublicBalance(snap({})).boost).toBeNull();
    const s = { ...snap({ budget_micro_usd: 3_000_000 }), boost: { multiplier: '3.00', expires_at: '2026-11-05T05:00:00+00:00' } };
    const b = budget.toPublicBalance(s as any);
    expect(b.boost).toEqual({ multiplier: 3, expires_at: '2026-11-05T05:00:00+00:00' });
    expect(b.budget_usd).toBe(3);
    expect(b.remaining_pct).toBe(100);
  });
  it('multiplicador 1 o basura → null', () => {
    expect(budget.toPublicBalance({ ...snap({}), boost: { multiplier: 1, expires_at: null } } as any).boost).toBeNull();
    expect(budget.toPublicBalance({ ...snap({}), boost: { multiplier: 'x', expires_at: null } } as any).boost).toBeNull();
  });
});

const input = () => parseAnalyzeInput(samplePlay('futbol')).input!;
const run = (ledger: InstanceType<typeof FakeTacticalAiLedger>, userId = 'coach-1', schoolId = 'esc-1') =>
  analyzeTacticalPlay({ schoolId, userId, input: input(), ledger });

describe('reserva → cobro / liberación', () => {
  it('éxito: reserva 0,08 y cobra el costo REAL; no queda nada reservado', async () => {
    const L = new FakeTacticalAiLedger();
    const out = await run(L);
    expect(out.status).toBe(200);
    expect(L.calls).toEqual(['reserve', 'settle']);
    const u = L.user('esc-1', 'coach-1');
    expect(u.used).toBe(70_800);
    expect(u.reserved).toBe(0);
    expect(L.school('esc-1').used).toBe(70_800);
    expect(u.tokens).toBe(1400 + 5900 + 3600);
  });
  it('caché = US$ 0: no reserva ni cobra', async () => {
    const L = new FakeTacticalAiLedger();
    await run(L);
    const { boardHash, anonymizePlay } = await import('../routes/school/tacticalAiShapes');
    const { kbVersion } = await import('./tactical-ai-knowledge');
    st.tablas.tactical_ai_analyses = [{ school_id: 'esc-1', board_hash: boardHash(anonymizePlay(input(), new Set()).play, kbVersion('futbol')), result: st.inserts[0].result }];
    const before = L.user('esc-1', 'coach-1').used;
    const out = await run(L);
    expect(out.status).toBe(200);
    expect((out as any).body.cached).toBe(true);
    expect(L.user('esc-1', 'coach-1').used).toBe(before);
    expect(L.user('esc-1', 'coach-1').cache_hits).toBe(1);
    expect(llm.calls).toBe(1);
  });
  it('el modelo falla → libera la reserva (no paga)', async () => {
    llm.impl = async () => { const e: any = new Error('x'); e.fallas = [{ proveedor: 'claude', error: 'claude_500', ms: 1 }]; throw e; };
    const L = new FakeTacticalAiLedger();
    const out = await run(L);
    expect(out.status).toBe(502);
    expect(L.calls).toEqual(['reserve', 'release']);
    expect(L.user('esc-1', 'coach-1')).toMatchObject({ used: 0, reserved: 0 });
  });
  it('salida inválida → libera', async () => {
    llm.impl = async () => ({ texto: 'no', provider: 'claude', model: 'claude-sonnet-5-5', tokens: null });
    const L = new FakeTacticalAiLedger();
    expect((await run(L)).status).toBe(502);
    expect(L.user('esc-1', 'coach-1')).toMatchObject({ used: 0, reserved: 0 });
  });
  it('límite del usuario: el coach agotado no llama al modelo; otro coach de la misma escuela sí', async () => {
    const L = new FakeTacticalAiLedger();
    L.user('esc-1', 'coach-1').used = 990_000;
    expect((await run(L, 'coach-1')).status).toBe(402);
    expect(llm.calls).toBe(0);
    expect((await run(L, 'coach-2')).status).toBe(200);
  });
  it('límite de la escuela: con el techo usado nadie de la escuela pasa; otra escuela sí', async () => {
    const L = new FakeTacticalAiLedger();
    L.school('esc-1').used = 10_000_000;
    const out = await run(L, 'coach-9');
    expect(out.status).toBe(402);
    expect((out as any).body.limited_by).toBe('school');
    expect((await run(L, 'coach-9', 'esc-2')).status).toBe(200);
  });
});

describe('concurrencia', () => {
  it('20 análisis en paralelo del mismo coach NO pasan el presupuesto (12 × 0,08 ≤ 1,00)', async () => {
    let inFlight = 0;
    llm.impl = async () => { inFlight += 1; await new Promise((r) => setTimeout(r, 5)); inFlight -= 1; return OK_LLM(); };
    const L = new FakeTacticalAiLedger();
    const outs = await Promise.all(Array.from({ length: 20 }, () => run(L)));
    const ok = outs.filter((o) => o.status === 200).length;
    expect(ok).toBe(12);
    expect(outs.filter((o) => o.status === 402)).toHaveLength(8);
    expect(llm.calls).toBe(12);
    const u = L.user('esc-1', 'coach-1');
    expect(u.reserved).toBe(0);
    expect(u.used).toBe(12 * 70_800);
    expect(u.used).toBeLessThanOrEqual(u.budget);
  });
  it('20 coaches en paralelo con el techo de la escuela a US$ 0,50 → máximo 6 reservas', async () => {
    const L = new FakeTacticalAiLedger();
    L.school('esc-1').ceiling = 500_000;
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => run(L, `c-${i}`)));
    expect(outs.filter((o) => o.status === 200)).toHaveLength(6);
    expect(L.school('esc-1').used).toBeLessThanOrEqual(500_000);
  });
  it('control: SIN el candado (FOR UPDATE) la misma prueba se pasa del presupuesto', async () => {
    const L = new FakeTacticalAiLedger();
    L.serialize = false;
    const outs = await Promise.all(Array.from({ length: 20 }, () => run(L)));
    expect(outs.filter((o) => o.status === 200).length).toBeGreaterThan(12);
  });
});

describe('la migración 20261014155445 (leída)', () => {
  const fn = (name: string) => {
    const i = MIG.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(i).toBeGreaterThan(-1);
    return MIG.slice(i, MIG.indexOf('$$;', MIG.indexOf('AS $$', i)) + 3);
  };
  it('los candados son SELECT … FOR UPDATE', () => {
    expect(fn('_tactical_ai_lock_school')).toMatch(/FOR UPDATE/);
    expect(fn('_tactical_ai_lock_user')).toMatch(/FOR UPDATE/);
  });
  it('reserve bloquea escuela ANTES que usuario y compara contra el estimado', () => {
    const r = fn('tactical_ai_reserve');
    expect(r.indexOf('_tactical_ai_lock_school')).toBeGreaterThan(-1);
    expect(r.indexOf('_tactical_ai_lock_school')).toBeLessThan(r.indexOf('_tactical_ai_lock_user'));
    expect(r).toMatch(/< p_estimate_micro_usd/);
    expect(r).toMatch(/SECURITY DEFINER/);
  });
  it('settle y release también bloquean escuela → usuario → run', () => {
    for (const n of ['tactical_ai_settle', 'tactical_ai_release']) {
      const f = fn(n);
      expect(f.indexOf('_tactical_ai_lock_school')).toBeLessThan(f.indexOf('_tactical_ai_lock_user'));
      expect(f.indexOf('_tactical_ai_lock_user')).toBeLessThan(f.indexOf('FOR UPDATE'));
    }
  });
  it('toda función tiene search_path fijo y las RPC del BFF solo service_role', () => {
    const creates = MIG.match(/CREATE OR REPLACE FUNCTION/g)!.length;
    expect(MIG.match(/^SET search_path = pg_catalog, public, pg_temp\r?$/gm)!.length).toBe(creates);
    for (const sig of ['tactical_ai_reserve(uuid, uuid, text, bigint)', 'tactical_ai_release(uuid)', 'tactical_ai_record_cache_hit(uuid, uuid, text)', 'tactical_ai_user_balance(uuid, uuid)']) {
      expect(MIG).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon, authenticated;`);
      expect(MIG).toContain(`GRANT EXECUTE ON FUNCTION public.${sig} TO service_role;`);
    }
  });
  it('estados en text + CHECK (sin CREATE TYPE) y sin policies de escritura', () => {
    expect(MIG).not.toMatch(/^\s*CREATE TYPE/m);
    expect(MIG).toMatch(/status IN \('reserved', 'settled', 'released', 'expired', 'cache_hit', 'denied'\)/);
    const pols = MIG.match(/CREATE POLICY[^;]*;/g)!;
    expect(pols).toHaveLength(4);
    for (const p of pols) expect(p).toMatch(/FOR SELECT\s+TO authenticated/);
  });
  it('no edita lo viejo: deprecia tactical_ai_credits sin DROP', () => {
    expect(MIG).not.toMatch(/DROP (TABLE|FUNCTION)/);
    expect(MIG).toMatch(/COMMENT ON TABLE public\.tactical_ai_credits IS\s+'OBSOLETA/);
  });
});

describe('informe del super admin', () => {
  it('por escuela, por coach y costo medio por deporte', () => {
    const r = buildUsageReport({
      period: '2026-10',
      schoolNames: { s1: 'Club Uno', s2: 'Club Dos' },
      userNames: { a: 'Ana', b: 'Beto', c: 'Caro' },
      schools: [
        { school_id: 's1', period: '2026-10', ceiling_micro_usd: 10_000_000, extra_micro_usd: 0, used_micro_usd: 1_100_000, reserved_micro_usd: 0, analyses: 17, needs_more_count: 0, limit_hit_at: null },
        { school_id: 's2', period: '2026-10', ceiling_micro_usd: 10_000_000, extra_micro_usd: 0, used_micro_usd: 50_000, reserved_micro_usd: 0, analyses: 1, needs_more_count: 0, limit_hit_at: null },
      ],
      users: [
        { school_id: 's1', user_id: 'a', period: '2026-10', budget_micro_usd: 1_000_000, extra_micro_usd: 0, used_micro_usd: 1_000_000, reserved_micro_usd: 0, analyses: 15, cache_hits: 2, needs_more_count: 3, input_tokens: 100, output_tokens: 200, cache_read_tokens: 10, cache_write_tokens: 20, limit_hit_at: '2026-10-10' },
        { school_id: 's1', user_id: 'b', period: '2026-10', budget_micro_usd: 1_000_000, extra_micro_usd: 0, used_micro_usd: 100_000, reserved_micro_usd: 0, analyses: 2, cache_hits: 0, needs_more_count: 0, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, limit_hit_at: null },
        { school_id: 's2', user_id: 'c', period: '2026-10', budget_micro_usd: 1_000_000, extra_micro_usd: 0, used_micro_usd: 50_000, reserved_micro_usd: 0, analyses: 1, cache_hits: 0, needs_more_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, limit_hit_at: null },
      ],
      runs: [
        { school_id: 's1', user_id: 'a', sport: 'futbol', status: 'settled', cost_micro_usd: 64_000, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        { school_id: 's1', user_id: 'a', sport: 'futbol', status: 'settled', cost_micro_usd: 66_000, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        { school_id: 's1', user_id: 'a', sport: 'futbol', status: 'cache_hit', cost_micro_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        { school_id: 's2', user_id: 'c', sport: 'voleibol', status: 'settled', cost_micro_usd: 43_000, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
      ],
    });
    expect(r.schools.map((s) => s.name)).toEqual(['Club Uno', 'Club Dos']);
    const uno = r.schools[0];
    expect(uno.coaches.map((c) => c.name)).toEqual(['Ana', 'Beto']);
    expect(uno.coaches[0]).toMatchObject({ pct: 100, hit_limit: true, tokens_in: 130, tokens_out: 200, cost_usd: 1 });
    expect(uno.coaches_at_limit).toBe(1);
    expect(uno.pct).toBe(11);
    expect(r.totals).toMatchObject({ analyses: 18, cache_hits: 2, cost_usd: 1.15, coaches: 3, coaches_at_limit: 1 });
    const fut = r.by_sport.find((s) => s.sport === 'futbol')!;
    expect(fut).toMatchObject({ analyses: 2, cache_hits: 1, avg_cost_usd: 0.065 });
    expect(r.by_sport.find((s) => s.sport === 'baloncesto')!.avg_cost_usd).toBeNull();
  });
  it('periodo en hora de Bogotá', () => {
    expect(currentPeriodBogota(new Date('2026-11-01T03:00:00Z'))).toBe('2026-10');
    expect(currentPeriodBogota(new Date('2026-11-01T06:00:00Z'))).toBe('2026-11');
  });
});
