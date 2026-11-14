/**
 * Cupo de la IA de la pizarra por COSTO REAL (decisión del 2026-10-14, spec
 * docs/specs/pizarra-multideporte-3d-ia.md §6; migración 20261014155445).
 *
 * Lógica PURA (sin base ni red): costo de una llamada, saldo público que ve el
 * coach, «unos N análisis de fútbol 11» y el mensaje de WhatsApp de «Quiero más».
 *
 * PRECIOS: no se duplican acá. Salen de `PRECIOS_POR_MILLON` en
 * llm-usage.service.ts (la ÚNICA tabla de precios del BFF; ahí está la fuente:
 * precios de lista de Anthropic, skill claude-api, caché del 2026-09-25; los de
 * otros proveedores marcados «por confirmar»). Si cambia un precio, se cambia ahí.
 */
import { precioDe } from './llm-usage.service';
import type { TokensUso } from './llm-usage.service';

/** 1 USD = 1.000.000 microdólares (lo que guarda la base). */
export const MICRO = 1_000_000;

export const AI_SPORTS_BUDGET = ['futbol', 'futbol7', 'futbol5', 'futsal', 'voleibol', 'baloncesto', 'balonmano'] as const;
export type BudgetSport = (typeof AI_SPORTS_BUDGET)[number];

export const AI_SPORT_LABEL: Record<BudgetSport, string> = {
  futbol: 'fútbol 11', futbol7: 'fútbol 7', futbol5: 'fútbol 5', futsal: 'futsal',
  voleibol: 'voleibol', baloncesto: 'baloncesto', balonmano: 'balonmano',
};

/**
 * Costo MEDIDO por análisis (USD) — Claude Sonnet 5.5, esfuerzo low, una corrida
 * real por deporte (2026-10-14). Sirve solo para el «unos N análisis» que ve el
 * coach; lo que se cobra es el costo real de cada llamada. Cuando haya volumen,
 * reemplazar por el promedio de tactical_ai_runs (el panel del super admin ya
 * lo calcula).
 */
export const AVG_COST_USD_BY_SPORT: Record<BudgetSport, number> = {
  futbol: 0.064, futbol7: 0.052, futbol5: 0.050, futsal: 0.056,
  voleibol: 0.043, baloncesto: 0.046, balonmano: 0.061,
};

/**
 * Lo que se RESERVA antes de llamar al modelo: USD 0,08, por encima del máximo
 * medido (USD 0,064 en fútbol 11). Con eso la suma de lo reservado nunca pasa el
 * presupuesto. Configurable por env (microdólares) sin redeploy de la base.
 */
export const RESERVE_ESTIMATE_MICRO_USD = Math.max(
  1,
  Math.min(5 * MICRO, Number(process.env.TACTICAL_AI_RESERVE_MICRO_USD) || 80_000),
);

export interface CostResult {
  micro: number;
  /** false = no había precio o tokens: se cobró el estimado de la reserva. */
  priced: boolean;
}

/**
 * Costo en microdólares de una llamada: entrada + escritura de caché + lectura
 * de caché + salida, cada parte a su precio por millón. Sin tokens o sin precio
 * para el modelo se cobra el ESTIMADO (conservador: nunca gratis por no saber).
 */
export function costMicroUsd(model: string | null | undefined, tokens: TokensUso | null | undefined, estimate = RESERVE_ESTIMATE_MICRO_USD): CostResult {
  const p = precioDe(String(model ?? ''));
  if (!tokens || !p || p.input == null || p.output == null) return { micro: estimate, priced: false };
  const usd = (tokens.input * (p.input ?? 0)
    + tokens.output * (p.output ?? 0)
    + tokens.cacheRead * (p.cacheRead ?? 0)
    + tokens.cacheWrite * (p.cacheWrite ?? p.input ?? 0)) / 1_000_000;
  return { micro: Math.max(0, Math.round(usd * MICRO)), priced: true };
}

// ─── Saldo ──────────────────────────────────────────────────────────────────

/** Lo que devuelven las RPC (_tactical_ai_balance_json). */
export interface LedgerSnapshot {
  period: string;
  user: {
    budget_micro_usd: number; extra_micro_usd: number; used_micro_usd: number; reserved_micro_usd: number;
    analyses: number; cache_hits: number;
  } | null;
  school: { ceiling_micro_usd: number; extra_micro_usd: number; used_micro_usd: number; reserved_micro_usd: number };
  /** Cupo ampliado temporal vigente (20261027110401): budget/ceiling ya vienen multiplicados. */
  boost?: { multiplier: number | string; expires_at: string | null } | null;
  ok?: boolean;
  denied_scope?: 'user' | 'school';
  reservation_id?: string;
}

/** Lo que ve el coach. */
export interface AiBudgetBalance {
  period: string;
  used_usd: number;
  budget_usd: number;
  remaining_usd: number;
  /** % USADO del presupuesto (0–100). */
  pct: number;
  /** % que le queda (0–100): «Te queda el 60 %». */
  remaining_pct: number;
  exhausted: boolean;
  /** Quién frena: el cupo del usuario o el techo de la escuela. */
  limited_by: 'user' | 'school' | null;
  approx_remaining: Record<BudgetSport, number>;
  analyses: number;
  cache_hits: number;
  /** Cupo ampliado temporal: «Cupo ×3 hasta el 4 de noviembre». */
  boost: { multiplier: number; expires_at: string | null } | null;
  /** Recarga que se ofrece, en la MISMA moneda que el medidor. */
  recharge: RechargeOffer;
}

// ─── Moneda del medidor y de las recargas ───────────────────────────────────
//
// Regla (2026-10-27): la recarga se ofrece en la misma unidad que el medidor.
// Si el medidor muestra análisis, «+10 análisis»; si muestra %, «+50 % de IA».
// Hoy el medidor del coach es «Te queda el 60 % de tu IA este mes» → %.

export type AiMeterUnit = 'pct' | 'analyses';
export const AI_METER_UNIT: AiMeterUnit = 'pct';
/** Tamaño de la recarga por unidad. */
export const AI_RECHARGE_STEP: Record<AiMeterUnit, number> = { pct: 50, analyses: 10 };

export interface RechargeOffer { unit: AiMeterUnit; amount: number; label: string }

/** «+50 % de IA» / «+10 análisis» (mismo formato que el medidor: «60 %»). */
export function rechargeLabel(unit: AiMeterUnit, amount: number): string {
  return unit === 'pct' ? `+${amount} % de IA` : `+${amount} análisis`;
}

export function rechargeOffer(unit: AiMeterUnit = AI_METER_UNIT, amount = AI_RECHARGE_STEP[unit]): RechargeOffer {
  return { unit, amount, label: rechargeLabel(unit, amount) };
}

/**
 * USD que hay que dar (grant) para cumplir una recarga: % del presupuesto BASE
 * del coach (sin cupo ampliado ni extras), o N análisis al costo medio del deporte.
 * Redondeado HACIA ARRIBA al centavo: nunca se da menos de lo prometido.
 */
export function rechargeUsd(offer: Pick<RechargeOffer, 'unit' | 'amount'>, baseBudgetUsd: number, sport: BudgetSport = 'futbol'): number {
  const raw = offer.unit === 'pct' ? (baseBudgetUsd * offer.amount) / 100 : offer.amount * AVG_COST_USD_BY_SPORT[sport];
  return Math.ceil(Math.round(raw * 1e6) / 1e4) / 100;
}

const usd = (micro: number) => Math.round(micro) / MICRO;
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Cuántos análisis más, aprox.: el primero exige la reserva entera. */
export function approxAnalyses(remainingMicro: number, avgUsd: number, estimate = RESERVE_ESTIMATE_MICRO_USD): number {
  if (remainingMicro < estimate) return 0;
  const avg = Math.max(1, Math.round(avgUsd * MICRO));
  return Math.floor((remainingMicro - estimate) / avg) + 1;
}

export function toPublicBalance(s: LedgerSnapshot, estimate = RESERVE_ESTIMATE_MICRO_USD): AiBudgetBalance {
  const u = s.user ?? { budget_micro_usd: 0, extra_micro_usd: 0, used_micro_usd: 0, reserved_micro_usd: 0, analyses: 0, cache_hits: 0 };
  const budget = num(u.budget_micro_usd) + num(u.extra_micro_usd);
  const userRem = budget - num(u.used_micro_usd) - num(u.reserved_micro_usd);
  const sc = s.school;
  const schoolRem = num(sc?.ceiling_micro_usd) + num(sc?.extra_micro_usd) - num(sc?.used_micro_usd) - num(sc?.reserved_micro_usd);
  const effective = Math.max(0, Math.min(userRem, schoolRem));
  const exhausted = effective < estimate;
  const limited_by: AiBudgetBalance['limited_by'] = !exhausted ? null : userRem < estimate ? 'user' : 'school';
  const remaining_pct = budget > 0 ? Math.max(0, Math.min(100, Math.floor((effective * 100) / budget))) : 0;
  const approx = Object.fromEntries(
    AI_SPORTS_BUDGET.map((sp) => [sp, approxAnalyses(effective, AVG_COST_USD_BY_SPORT[sp], estimate)]),
  ) as Record<BudgetSport, number>;
  return {
    period: s.period,
    used_usd: usd(num(u.used_micro_usd)),
    budget_usd: usd(budget),
    remaining_usd: usd(effective),
    pct: 100 - remaining_pct,
    remaining_pct,
    exhausted,
    limited_by,
    approx_remaining: approx,
    analyses: num(u.analyses),
    cache_hits: num(u.cache_hits),
    boost: toBoost(s.boost),
    recharge: rechargeOffer(),
  };
}

function toBoost(b: LedgerSnapshot['boost']): AiBudgetBalance['boost'] {
  const m = Number(b?.multiplier);
  if (!b || !Number.isFinite(m) || m <= 0 || m === 1) return null;
  return { multiplier: m, expires_at: b.expires_at ?? null };
}

// ─── «Quiero más» por WhatsApp ──────────────────────────────────────────────

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function mesDe(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : period;
}

/** Una línea, sin saltos ni caracteres de control, acotada. */
const clean = (s: string | null | undefined, max = 80) =>
  Array.from(String(s ?? ''), (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Mensaje pre-llenado para el comercial: escuela, quien escribe, deporte y
 * consumo del mes. NADA de atletas: la función no recibe nada de ellos.
 */
export function buildMoreAiWhatsappMessage(args: {
  schoolName: string | null | undefined;
  coachName: string | null | undefined;
  sport: BudgetSport | null | undefined;
  balance: Pick<AiBudgetBalance, 'period' | 'pct' | 'analyses' | 'limited_by'> & { recharge?: RechargeOffer };
}): string {
  const school = clean(args.schoolName) || 'mi escuela';
  const coach = clean(args.coachName, 60) || 'entrenador';
  const sport = args.sport && AI_SPORT_LABEL[args.sport] ? AI_SPORT_LABEL[args.sport] : null;
  const b = args.balance;
  const techo = b.limited_by === 'school' ? ' La escuela llegó a su tope mensual de IA.' : '';
  // Misma moneda que el medidor del coach (%): nada de US$ en lo que él ve.
  const pct = Math.max(0, Math.min(100, Math.round(num(b.pct))));
  const recharge = b.recharge ?? rechargeOffer();
  return [
    `Hola, soy ${coach} de ${school}.`,
    `Usé el ${pct} % de mi IA de la pizarra de ${mesDe(b.period)}${sport ? ` (analizo jugadas de ${sport})` : ''},`,
    `${b.analyses} análisis.${techo}`,
    `Quiero una recarga de ${recharge.label}.`,
  ].join(' ');
}
