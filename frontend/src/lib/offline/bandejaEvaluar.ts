/**
 * Evaluación del entrenador (`submit_post_training_coach_rating`) como acción de la bandeja.
 *
 * Pasa el checklist de §9 del spec: la RPC es idempotente (upsert por sesión + deportista + métrica;
 * la nota de la sesión se sobrescribe), valida ADENTRO que quien llama sea coach del equipo y no mueve
 * dinero, cupos ni permisos. Reenviar N veces = 1 efecto.
 */
import { supabase } from '@/integrations/supabase/client';
import type { ResultadoEnvio } from '@/components/coach/v2/colaAsistencia';
import { mensajeErrorEvaluar } from '@/components/coach/v2/coachV2Logic';
import type { AccionEnBandeja } from './bandeja';

export const TIPO_EVALUAR = 'evaluar';

export interface PayloadEvaluar {
  sessionId: string;
  ratings: Array<{ child_id?: string; user_id?: string; effort_pct: number }>;
  notas: string | null;
}

export const idEvaluar = (sessionId: string) => `${TIPO_EVALUAR}:${sessionId}`;

interface ErrorRpc { code?: string | null; message?: string | null; status?: number }

const RED = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

/** ¿Falló por falta de señal (la petición ni llegó al servidor)? */
export function esErrorDeRed(error: ErrorRpc | null | undefined): boolean {
  const msg = (error?.message ?? '').trim();
  return !error?.code && (!msg || RED.test(msg));
}

/**
 * Traduce el error de la RPC a la clasificación de la bandeja.
 *  · sin código y con texto de red → falta de señal: se reintenta.
 *  · 55000 «todavía no se ha cerrado» / «no asistió»: la lista de asistencia de ESA sesión
 *    puede estar todavía en la cola del teléfono; se reintenta (si no llega, queda atascada con su motivo).
 *  · 55000 de «informe ya publicado» y el resto de reglas (42501, P0002, 22023, P0001): se aparta con su motivo.
 *  · 401 / JWT vencido: sesión, no falta de señal.
 */
export function clasificarErrorEvaluar(error: ErrorRpc | null | undefined): ResultadoEnvio {
  const code = error?.code ?? '';
  const msg = (error?.message ?? '').trim();
  const status = error?.status ?? 0;
  if (status === 401 || ((code === 'PGRST301' || code === 'PGRST303') && /jwt|token/i.test(msg))) return { kind: 'auth', message: msg || 'Sesión vencida' };
  if (esErrorDeRed(error)) return { kind: 'retry', message: 'Sin señal' };
  if (code === '55000' && /no se ha cerrado|no asisti[oó]/i.test(msg)) {
    return { kind: 'retry', message: mensajeErrorEvaluar(error), servidor: true };
  }
  if (code === '42501' || code === 'P0002' || code === '55000' || code === '22023' || code === 'P0001') {
    return { kind: 'rule', message: mensajeErrorEvaluar(error) };
  }
  // 5xx / 429 / error desconocido del servidor: se reintenta con espera creciente.
  return { kind: 'retry', message: mensajeErrorEvaluar(error), servidor: status >= 500 || !!code };
}

export async function enviarEvaluacion(a: AccionEnBandeja): Promise<ResultadoEnvio> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'retry', message: 'Sin señal' };
  const p = a.payload as PayloadEvaluar;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (supabase as any).rpc('submit_post_training_coach_rating', {
      p_session_id: p.sessionId,
      p_ratings: p.ratings,
      p_coach_notes: p.notas,
    });
    if (r.error) {
      const c = clasificarErrorEvaluar(r.error);
      // Sin red el refresco del token falla como «sin sesión»: es falta de señal, no sesión vencida.
      if (c.kind === 'auth' && typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'retry', message: 'Sin señal' };
      return c;
    }
    return { kind: 'ok', body: r.data };
  } catch (e) {
    return clasificarErrorEvaluar({ message: e instanceof Error ? e.message : String(e) });
  }
}
