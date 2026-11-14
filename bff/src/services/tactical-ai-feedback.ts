/**
 * «Útil / No útil» en cada sugerencia de la IA de la pizarra y registro de las
 * que terminan en «Guardar como nueva jugada» (2026-10-27, migración
 * 20261027110420_pizarra_ia_feedback_sugerencias).
 *
 * El análisis se identifica por su hash anónimo (analysis_ref = board_hash de
 * la caché tactical_ai_analyses). No se guarda texto del cliente: el título que
 * ve el coach lleva las etiquetas que él escribió; el texto de la sugerencia se
 * lee de la caché.
 *
 * Escritura con la sesión del coach (userClient → la RLS manda: solo filas
 * propias en una escuela donde trabaja). Antes, con el cliente de servicio, se
 * valida que el análisis exista en la caché de SU escuela y que la sugerencia
 * (tipo + índice) exista en ese análisis.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isAiSport, type AiSport } from '../routes/school/tacticalAiShapes';

export const FEEDBACK_KINDS = ['contraataque', 'variante'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_VERDICTS = ['util', 'no_util'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const HASH_RE = /^[0-9a-f]{64}$/;

export interface FeedbackInput {
  analysisRef: string;
  sport: AiSport;
  kind: FeedbackKind;
  index: number;
  /** undefined = no tocar; null = quitar el voto. */
  verdict?: FeedbackVerdict | null;
  /** true = la sugerencia se pasó a la cancha con «Guardar como nueva jugada». */
  saved?: boolean;
}

/** Cuerpo: { analysis_ref, sport, kind, index, verdict?: 'util'|'no_util'|null, saved?: true }. */
export function parseFeedbackInput(body: unknown): { errors: string[]; input: FeedbackInput | null } {
  const errors: string[] = [];
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const analysisRef = typeof b.analysis_ref === 'string' ? b.analysis_ref : '';
  if (!HASH_RE.test(analysisRef)) errors.push('analysis_ref inválido.');
  if (!isAiSport(b.sport)) errors.push('sport inválido.');
  if (!(FEEDBACK_KINDS as readonly unknown[]).includes(b.kind)) errors.push('kind debe ser contraataque o variante.');
  const index = Number(b.index);
  if (!Number.isInteger(index) || index < 0 || index > 9) errors.push('index fuera de rango (0..9).');
  let verdict: FeedbackVerdict | null | undefined;
  if (b.verdict === null) verdict = null;
  else if (b.verdict !== undefined) {
    if ((FEEDBACK_VERDICTS as readonly unknown[]).includes(b.verdict)) verdict = b.verdict as FeedbackVerdict;
    else errors.push('verdict debe ser util, no_util o null.');
  }
  if (b.saved !== undefined && b.saved !== true) errors.push('saved solo puede ser true.');
  const saved = b.saved === true;
  if (verdict === undefined && !saved) errors.push('Nada que registrar: manda verdict o saved.');
  if (errors.length) return { errors, input: null };
  return {
    errors,
    input: {
      analysisRef, sport: b.sport as AiSport, kind: b.kind as FeedbackKind, index,
      ...(verdict !== undefined ? { verdict } : {}), ...(saved ? { saved } : {}),
    },
  };
}

/** ¿Existe esa sugerencia en el resultado guardado del análisis? */
export function suggestionExists(result: unknown, kind: FeedbackKind, index: number): boolean {
  const r = (result ?? {}) as Record<string, unknown>;
  const list = kind === 'contraataque' ? r.contraataques : r.variantes;
  return Array.isArray(list) && index >= 0 && index < list.length;
}

/** Fila a escribir: SOLO las columnas que cambian (el upsert no pisa lo demás). */
export function feedbackRow(args: { schoolId: string; userId: string; input: FeedbackInput; now?: Date }): Record<string, unknown> {
  const { schoolId, userId, input } = args;
  return {
    school_id: schoolId,
    user_id: userId,
    board_hash: input.analysisRef,
    sport: input.sport,
    suggestion_kind: input.kind,
    suggestion_index: input.index,
    ...(input.verdict !== undefined ? { verdict: input.verdict } : {}),
    ...(input.saved ? { saved_as_play_at: (args.now ?? new Date()).toISOString() } : {}),
  };
}

export type FeedbackOutcome =
  | { status: 200; body: { ok: true } }
  | { status: 404 | 422 | 403 | 503; body: { error: string } };

const isMissing = (err: any) => {
  const code = String(err?.code ?? '');
  return code === '42P01' || code === 'PGRST205' || /does not exist|schema cache/i.test(String(err?.message ?? ''));
};

export async function recordSuggestionFeedback(args: {
  service: SupabaseClient | any;
  asUser: SupabaseClient | any;
  schoolId: string;
  userId: string;
  input: FeedbackInput;
  log?: { warn: (o: any, m?: string) => void };
}): Promise<FeedbackOutcome> {
  const { service, asUser, schoolId, userId, input, log } = args;
  const { data: analysis, error: aErr } = await service
    .from('tactical_ai_analyses')
    .select('result')
    .eq('school_id', schoolId)
    .eq('board_hash', input.analysisRef)
    .maybeSingle();
  if (aErr) {
    if (isMissing(aErr)) return { status: 503, body: { error: 'El análisis con IA todavía no está habilitado.' } };
    throw aErr;
  }
  if (!analysis) return { status: 404, body: { error: 'No encontramos ese análisis en tu escuela.' } };
  if (!suggestionExists((analysis as any).result, input.kind, input.index)) {
    return { status: 422, body: { error: 'Esa sugerencia no existe en el análisis.' } };
  }
  const { error } = await asUser
    .from('tactical_ai_suggestion_feedback')
    .upsert(feedbackRow({ schoolId, userId, input }), {
      onConflict: 'user_id,school_id,board_hash,suggestion_kind,suggestion_index',
    });
  if (error) {
    if (isMissing(error)) return { status: 503, body: { error: 'La valoración de sugerencias todavía no está habilitada.' } };
    if (String(error.code) === '42501') return { status: 403, body: { error: 'No puedes valorar sugerencias en esta escuela.' } };
    log?.warn({ err: error }, 'tactical-ai: no se pudo guardar la valoración');
    throw error;
  }
  return { status: 200, body: { ok: true } };
}
