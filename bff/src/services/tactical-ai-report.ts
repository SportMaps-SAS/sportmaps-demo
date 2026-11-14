/**
 * «Uso de IA de pizarra» para el super admin (spec §6, decisión 2026-10-14).
 * Es el dato para fijar el precio después: por mes, por escuela y por coach
 * (análisis, aciertos de caché, tokens, costo real, % del presupuesto, quién
 * topó), totales y costo medio por deporte. Agregación PURA (se prueba sin base).
 */
import { AI_SPORT_LABEL, AI_SPORTS_BUDGET, MICRO, type BudgetSport } from './tactical-ai-budget';

export interface UserUsageRow {
  school_id: string; user_id: string; period: string;
  budget_micro_usd: number; extra_micro_usd: number; used_micro_usd: number; reserved_micro_usd: number;
  analyses: number; cache_hits: number; needs_more_count: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  limit_hit_at: string | null;
}
export interface SchoolUsageRow {
  school_id: string; period: string;
  ceiling_micro_usd: number; extra_micro_usd: number; used_micro_usd: number; reserved_micro_usd: number;
  analyses: number; needs_more_count: number; limit_hit_at: string | null;
}
export interface RunRow {
  school_id: string; user_id: string | null; sport: string; status: string; cost_micro_usd: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
}

export interface CoachReport {
  user_id: string; name: string;
  analyses: number; cache_hits: number;
  tokens_in: number; tokens_out: number;
  cost_usd: number; budget_usd: number; pct: number;
  hit_limit: boolean; needs_more_count: number;
}
export interface SchoolReport {
  school_id: string; name: string;
  analyses: number; cache_hits: number;
  tokens_in: number; tokens_out: number;
  cost_usd: number; ceiling_usd: number; pct: number;
  hit_limit: boolean; coaches_at_limit: number;
  coaches: CoachReport[];
  /** Cupo ampliado temporal vigente (×N), si lo hay. */
  quota_multiplier?: number;
}
export interface SportReport {
  sport: BudgetSport; label: string; analyses: number; cache_hits: number; cost_usd: number; avg_cost_usd: number | null;
}
export interface UsageReport {
  period: string;
  totals: { analyses: number; cache_hits: number; tokens_in: number; tokens_out: number; cost_usd: number; schools: number; coaches: number; coaches_at_limit: number };
  by_sport: SportReport[];
  schools: SchoolReport[];
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const usd = (micro: number) => Math.round(micro) / MICRO;
const pct = (used: number, budget: number) => (budget > 0 ? Math.round((used * 1000) / budget) / 10 : 0);
/** Tokens de entrada = sin caché + escritura de caché + lectura de caché. */
const tokensIn = (r: { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number }) =>
  n(r.input_tokens) + n(r.cache_read_tokens) + n(r.cache_write_tokens);

export function buildUsageReport(args: {
  period: string;
  users: UserUsageRow[];
  schools: SchoolUsageRow[];
  runs: RunRow[];
  schoolNames: Record<string, string>;
  userNames: Record<string, string>;
  /** Cupo ampliado VIGENTE por escuela (tactical_ai_quota_overrides,
   *  20261027110401). Solo se pasa para el mes en curso: multiplica el
   *  presupuesto del coach y el techo de la escuela, como hacen las RPC. */
  multipliers?: Record<string, number>;
}): UsageReport {
  const { period, users, schools, runs, schoolNames, userNames } = args;
  const mult = (schoolId: string) => {
    const m = Number(args.multipliers?.[schoolId]);
    return Number.isFinite(m) && m > 0 ? m : 1;
  };
  const bySchool = new Map<string, SchoolReport>();
  const ensure = (id: string): SchoolReport => {
    let s = bySchool.get(id);
    if (!s) {
      s = {
        school_id: id, name: schoolNames[id] ?? 'Escuela sin nombre',
        analyses: 0, cache_hits: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, ceiling_usd: 0, pct: 0,
        hit_limit: false, coaches_at_limit: 0, coaches: [],
        ...(mult(id) !== 1 ? { quota_multiplier: mult(id) } : {}),
      };
      bySchool.set(id, s);
    }
    return s;
  };

  for (const sc of schools) {
    const s = ensure(sc.school_id);
    const ceiling = Math.round(n(sc.ceiling_micro_usd) * mult(sc.school_id)) + n(sc.extra_micro_usd);
    s.ceiling_usd = usd(ceiling);
    s.cost_usd = usd(n(sc.used_micro_usd));
    s.pct = pct(n(sc.used_micro_usd), ceiling);
    s.hit_limit = !!sc.limit_hit_at;
  }

  for (const u of users) {
    const s = ensure(u.school_id);
    const budget = Math.round(n(u.budget_micro_usd) * mult(u.school_id)) + n(u.extra_micro_usd);
    const coach: CoachReport = {
      user_id: u.user_id,
      name: userNames[u.user_id] ?? 'Usuario sin nombre',
      analyses: n(u.analyses),
      cache_hits: n(u.cache_hits),
      tokens_in: tokensIn(u),
      tokens_out: n(u.output_tokens),
      cost_usd: usd(n(u.used_micro_usd)),
      budget_usd: usd(budget),
      pct: pct(n(u.used_micro_usd), budget),
      hit_limit: !!u.limit_hit_at,
      needs_more_count: n(u.needs_more_count),
    };
    s.coaches.push(coach);
    s.analyses += coach.analyses;
    s.cache_hits += coach.cache_hits;
    s.tokens_in += coach.tokens_in;
    s.tokens_out += coach.tokens_out;
    if (coach.hit_limit) s.coaches_at_limit += 1;
  }

  const sportAgg = new Map<BudgetSport, { analyses: number; cache_hits: number; cost: number }>();
  for (const sp of AI_SPORTS_BUDGET) sportAgg.set(sp, { analyses: 0, cache_hits: 0, cost: 0 });
  for (const r of runs) {
    const a = sportAgg.get(r.sport as BudgetSport);
    if (!a) continue;
    if (r.status === 'settled') { a.analyses += 1; a.cost += n(r.cost_micro_usd); }
    else if (r.status === 'cache_hit') a.cache_hits += 1;
  }

  const list = [...bySchool.values()];
  for (const s of list) s.coaches.sort((a, b) => b.cost_usd - a.cost_usd || a.name.localeCompare(b.name));
  list.sort((a, b) => b.cost_usd - a.cost_usd || a.name.localeCompare(b.name));

  const by_sport: SportReport[] = AI_SPORTS_BUDGET.map((sp) => {
    const a = sportAgg.get(sp)!;
    return {
      sport: sp, label: AI_SPORT_LABEL[sp], analyses: a.analyses, cache_hits: a.cache_hits,
      cost_usd: usd(a.cost), avg_cost_usd: a.analyses > 0 ? Math.round(a.cost / a.analyses) / MICRO : null,
    };
  });

  const coaches = list.flatMap((s) => s.coaches);
  return {
    period,
    totals: {
      analyses: list.reduce((t, s) => t + s.analyses, 0),
      cache_hits: list.reduce((t, s) => t + s.cache_hits, 0),
      tokens_in: list.reduce((t, s) => t + s.tokens_in, 0),
      tokens_out: list.reduce((t, s) => t + s.tokens_out, 0),
      cost_usd: usd(schools.reduce((t, s) => t + n(s.used_micro_usd), 0)),
      schools: list.length,
      coaches: coaches.length,
      coaches_at_limit: coaches.filter((c) => c.hit_limit).length,
    },
    by_sport,
    schools: list,
  };
}

/** 'YYYY-MM' en hora de Bogotá (igual que tactical_ai_current_period()). */
export function currentPeriodBogota(now = new Date()): string {
  const d = new Date(now.getTime() - 5 * 3600 * 1000); // Bogotá = UTC−5, sin horario de verano
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const PERIOD_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
