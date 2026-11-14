/**
 * «Analizar jugada» con IA (M3, docs/specs/pizarra-multideporte-3d-ia.md D6 y §6).
 *
 * Cupo por COSTO REAL (decisión 2026-10-14, migración 20261014155445): cada
 * usuario (coach/staff que analiza) tiene USD 1,00 al mes en su escuela y la
 * escuela un techo de 10 × eso. Orden de una petición (cliente de servicio; el
 * gate de quién puede pedir lo hace la ruta):
 *   1. Jugada anónima + hash (tacticalAiShapes).
 *   2. Caché por (escuela, hash): si existe, se devuelve sin llamar al modelo y
 *      cuesta USD 0 (solo se cuenta el acierto de caché).
 *   3. tactical_ai_reserve: reserva un estimado (USD 0,08) con FOR UPDATE sobre
 *      la escuela y el usuario. Sin saldo → needs_more y NO se llama al modelo.
 *   4. Modelo (llm.service.generarJsonEstructurado) con tope de tiempo.
 *   5. Validación de la salida. Si el modelo falla o la salida no sirve, se
 *      LIBERA la reserva (tactical_ai_release): el coach no paga un error.
 *   6. tactical_ai_settle con el costo real (tokens × precio del modelo).
 *   7. Se guarda en la caché (anónimo: claves p1..pN / r1..rN).
 *
 * El libro de cupo va detrás de la interfaz `TacticalAiLedger` para probar la
 * lógica (y la concurrencia) con un repositorio falso sin base.
 */
import { supabase } from '../config/supabase';
import { generarJsonEstructurado, fallasDeError, type JsonEstructuradoResult } from './llm.service';
import {
  AI_RESULT_SCHEMA, AiOutputError, anonymizePlay, boardHash, buildSystemPrompt, buildUserPrompt,
  deanonymizeResult, promptLeaks, rosterNameTokens, validateAiResult,
  type AiResult, type AnalyzeInput,
} from '../routes/school/tacticalAiShapes';
import {
  RESERVE_ESTIMATE_MICRO_USD, buildMoreAiWhatsappMessage, costMicroUsd, toPublicBalance,
  type AiBudgetBalance, type BudgetSport, type LedgerSnapshot,
} from './tactical-ai-budget';
import { selectKnowledge } from './tactical-ai-knowledge';

export const TACTICAL_AI_TIMEOUT_MS = Number(process.env.TACTICAL_AI_TIMEOUT_MS) || 75_000;

// ─── Libro de cupo ──────────────────────────────────────────────────────────

export interface SettleArgs {
  reservationId: string;
  costMicro: number;
  provider: string;
  model: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface TacticalAiLedger {
  reserve(a: { schoolId: string; userId: string; sport: string; estimateMicro: number }): Promise<LedgerSnapshot>;
  settle(a: SettleArgs): Promise<LedgerSnapshot>;
  release(reservationId: string): Promise<LedgerSnapshot>;
  cacheHit(a: { schoolId: string; userId: string; sport: string }): Promise<LedgerSnapshot>;
  balance(schoolId: string, userId: string): Promise<LedgerSnapshot>;
}

/** La RPC no existe todavía (migración sin aplicar): PostgREST PGRST202 / 42883. */
export function isMissingRpc(err: any): boolean {
  const code = String(err?.code ?? '');
  return code === 'PGRST202' || code === '42883' || code === '42P01' || /could not find the function/i.test(String(err?.message ?? ''));
}

async function rpc(name: string, args: Record<string, unknown>): Promise<LedgerSnapshot> {
  const { data, error } = await supabase.rpc(name as any, args as any);
  if (error) throw error;
  return data as unknown as LedgerSnapshot;
}

/** Implementación real: las RPC SECURITY DEFINER de 20261014155445 (solo service_role). */
export const supabaseLedger: TacticalAiLedger = {
  reserve: (a) => rpc('tactical_ai_reserve', {
    p_school_id: a.schoolId, p_user_id: a.userId, p_sport: a.sport, p_estimate_micro_usd: a.estimateMicro,
  }),
  settle: (a) => rpc('tactical_ai_settle', {
    p_reservation_id: a.reservationId,
    p_cost_micro_usd: a.costMicro,
    p_provider: a.provider,
    p_model: a.model,
    p_input_tokens: a.tokens.input,
    p_output_tokens: a.tokens.output,
    p_cache_read_tokens: a.tokens.cacheRead,
    p_cache_write_tokens: a.tokens.cacheWrite,
  }),
  release: (id) => rpc('tactical_ai_release', { p_reservation_id: id }),
  cacheHit: (a) => rpc('tactical_ai_record_cache_hit', { p_school_id: a.schoolId, p_user_id: a.userId, p_sport: a.sport }),
  balance: (schoolId, userId) => rpc('tactical_ai_user_balance', { p_school_id: schoolId, p_user_id: userId }),
};

// ─── Saldo y «Quiero más» ───────────────────────────────────────────────────

export async function getAiBalance(schoolId: string, userId: string, ledger: TacticalAiLedger = supabaseLedger): Promise<AiBudgetBalance | null> {
  try {
    return toPublicBalance(await ledger.balance(schoolId, userId));
  } catch (err) {
    if (isMissingRpc(err)) return null;
    throw err;
  }
}

/**
 * Mensaje de WhatsApp de «Quiero más»: nombre de la escuela y de quien pide,
 * deporte y consumo del mes. Solo lee schools.name y profiles.full_name.
 */
export async function requestMoreMessage(args: {
  schoolId: string; userId: string; sport: BudgetSport | null; balance: AiBudgetBalance;
}): Promise<string> {
  const [school, me] = await Promise.all([
    supabase.from('schools').select('name').eq('id', args.schoolId).maybeSingle().then((r: any) => r?.data, () => null),
    supabase.from('profiles').select('full_name').eq('id', args.userId).maybeSingle().then((r: any) => r?.data, () => null),
  ]);
  return buildMoreAiWhatsappMessage({
    schoolName: (school as any)?.name, coachName: (me as any)?.full_name, sport: args.sport, balance: args.balance,
  });
}

// ─── Análisis ───────────────────────────────────────────────────────────────

export type AnalyzeOutcome =
  | { status: 200; body: {
      result: AiResult; cached: boolean; balance: AiBudgetBalance | null; keys: Record<string, string>; dropped?: string[];
      /** Hash anónimo del análisis: identifica la sugerencia en «Útil / No útil» (tactical_ai_suggestion_feedback). */
      analysis_ref: string;
    } }
  | { status: 402; body: { error: string; needs_more: true; limited_by: 'user' | 'school' | null; balance: AiBudgetBalance } }
  | { status: 422 | 502 | 503 | 504; body: { error: string; detalle?: string } };

/** Nombres del plantel del equipo (control extra de que ninguno llega al prompt). */
async function rosterNames(schoolId: string, teamId: string): Promise<string[]> {
  try {
    const { data } = await supabase
      .from('school_athletes' as any)
      .select('full_name')
      .eq('school_id', schoolId)
      .eq('enrolled_team_id', teamId);
    return ((data ?? []) as any[]).map((r) => String(r.full_name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

const UNAVAILABLE: AnalyzeOutcome = {
  status: 503,
  body: { error: 'El análisis con IA todavía no está habilitado en esta cuenta. Intenta más tarde.' },
};

const EXHAUSTED_MSG = {
  user: 'Usaste tu IA de este mes.',
  school: 'Tu escuela usó toda la IA de este mes.',
} as const;

type Log = { warn: (o: any, m?: string) => void; info?: (o: any, m?: string) => void };

export async function analyzeTacticalPlay(args: {
  schoolId: string;
  userId: string;
  input: AnalyzeInput;
  log?: Log;
  ledger?: TacticalAiLedger;
}): Promise<AnalyzeOutcome> {
  const { schoolId, userId, input, log } = args;
  const ledger = args.ledger ?? supabaseLedger;
  const names = await rosterNames(schoolId, input.teamId);
  const { play, keyMap } = anonymizePlay(input, rosterNameTokens(names));
  // Base táctica propia (RAG ligero): principios del deporte + formación.
  const kb = selectKnowledge({ sport: input.sport, formationKey: play.formacion, firstFrame: play.cuadros[0] ?? null });
  const hash = boardHash(play, kb.version);
  // p1..pN → clave real del tablero: el cliente la usa para que ningún «p5»
  // llegue a la pantalla aunque el modelo lo escriba en un texto.
  const keys = Object.fromEntries(keyMap);

  // 2. Caché: USD 0.
  const { data: cachedRow, error: cacheErr } = await supabase
    .from('tactical_ai_analyses' as any)
    .select('result')
    .eq('school_id', schoolId)
    .eq('board_hash', hash)
    .maybeSingle();
  if (cacheErr && !isMissingRpc(cacheErr)) log?.warn({ err: cacheErr }, 'tactical-ai: no se pudo leer la caché');
  if (cachedRow && (cachedRow as any).result) {
    const snap = await ledger.cacheHit({ schoolId, userId, sport: input.sport }).catch((err) => {
      if (!isMissingRpc(err)) log?.warn({ err }, 'tactical-ai: no se pudo contar el acierto de caché');
      return null;
    });
    return {
      status: 200,
      body: {
        result: deanonymizeResult((cachedRow as any).result as AiResult, keyMap), cached: true,
        balance: snap ? toPublicBalance(snap) : null, keys, analysis_ref: hash,
      },
    };
  }

  // 3. Reserva
  let reserved: LedgerSnapshot;
  try {
    reserved = await ledger.reserve({ schoolId, userId, sport: input.sport, estimateMicro: RESERVE_ESTIMATE_MICRO_USD });
  } catch (err) {
    if (isMissingRpc(err)) return UNAVAILABLE;
    throw err;
  }
  if (!reserved?.ok || !reserved.reservation_id) {
    const balance = toPublicBalance(reserved);
    const scope = reserved?.denied_scope ?? balance.limited_by ?? 'user';
    return { status: 402, body: { error: EXHAUSTED_MSG[scope], needs_more: true, limited_by: scope, balance } };
  }
  const reservationId = reserved.reservation_id;

  const release = async () => {
    try { await ledger.release(reservationId); } catch (err) {
      // Si esto falla, la reserva vence sola (tactical_ai_reservation_ttl).
      log?.warn({ err }, 'tactical-ai: no se pudo liberar la reserva');
    }
  };

  // 4. Modelo
  const system = kb.system ? `${buildSystemPrompt(input.sport)}\n\n${kb.system}` : buildSystemPrompt(input.sport);
  const user = kb.user ? `${buildUserPrompt(play)}\n${kb.user}` : buildUserPrompt(play);
  const leaks = promptLeaks(`${system}\n${user}`, [...names, ...keyMap.values()]);
  if (leaks.length) {
    // No debería pasar nunca (las claves se reemplazan y las etiquetas son
    // vocabulario): si pasa, no se manda nada.
    await release();
    log?.warn({ count: leaks.length }, 'tactical-ai: el prompt tenía datos de atletas; no se envió');
    return { status: 422, body: { error: 'La jugada tiene datos personales en las etiquetas. Quítalos e intenta de nuevo.' } };
  }

  let llm: JsonEstructuradoResult;
  try {
    llm = await generarJsonEstructurado({
      system,
      user,
      schema: AI_RESULT_SCHEMA,
      maxTokens: 12_000,
      timeoutMs: TACTICAL_AI_TIMEOUT_MS,
      uso: { schoolId, feature: 'pizarra_ia' },
    });
  } catch (err: any) {
    await release();
    const fallas = fallasDeError(err);
    log?.warn({ fallas }, 'tactical-ai: el modelo no respondió');
    const timeout = fallas.length > 0 && fallas.every((f) => /timeout|timed out|aborted/i.test(f.error));
    return timeout
      ? { status: 504, body: { error: 'La IA tardó demasiado en responder. No se descontó nada de tu cupo; intenta de nuevo.' } }
      : { status: 502, body: { error: 'La IA no está disponible en este momento. No se descontó nada de tu cupo; intenta en unos minutos.' } };
  }

  // 5. Validación
  let validated: { result: AiResult; dropped: string[] };
  try {
    validated = validateAiResult(llm.texto, { sport: input.sport, ownKeys: new Set(keyMap.keys()) });
  } catch (err) {
    await release();
    log?.warn({ err: (err as Error).message, provider: llm.provider }, 'tactical-ai: salida inválida');
    return {
      status: 502,
      body: {
        error: 'La IA respondió algo que no se pudo usar. No se descontó nada de tu cupo; intenta de nuevo.',
        detalle: err instanceof AiOutputError ? err.code : undefined,
      },
    };
  }
  if (validated.dropped.length) log?.info?.({ dropped: validated.dropped }, 'tactical-ai: partes descartadas');

  // 6. Cobro del costo real
  const tokens = {
    input: llm.tokens?.input ?? 0,
    output: llm.tokens?.output ?? 0,
    cacheRead: llm.tokens?.cacheRead ?? 0,
    cacheWrite: llm.tokens?.cacheWrite ?? 0,
  };
  const cost = costMicroUsd(llm.model, llm.tokens);
  if (!cost.priced) log?.warn({ model: llm.model }, 'tactical-ai: modelo sin precio o sin tokens; se cobró el estimado');
  let settled: LedgerSnapshot | null = null;
  try {
    settled = await ledger.settle({
      reservationId, costMicro: cost.micro, provider: String(llm.provider), model: String(llm.model).slice(0, 120), tokens,
    });
  } catch (err) {
    log?.warn({ err, reservationId }, 'tactical-ai: no se pudo cobrar el análisis');
  }

  // 7. Caché (anónima). Un choque de unique (dos coaches a la vez) no importa.
  const { error: insErr } = await supabase.from('tactical_ai_analyses' as any).insert({
    school_id: schoolId,
    team_id: input.teamId,
    board_hash: hash,
    sport: input.sport,
    result: validated.result,
    provider: llm.provider,
    model: String(llm.model).slice(0, 120),
    input_tokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    output_tokens: tokens.output,
    created_by: userId,
  } as any);
  if (insErr && String((insErr as any).code) !== '23505') log?.warn({ err: insErr }, 'tactical-ai: no se pudo guardar la caché');

  return {
    status: 200,
    body: {
      result: deanonymizeResult(validated.result, keyMap),
      cached: false,
      balance: settled ? toPublicBalance(settled) : null,
      keys,
      analysis_ref: hash,
      ...(validated.dropped.length ? { dropped: validated.dropped } : {}),
    },
  };
}
