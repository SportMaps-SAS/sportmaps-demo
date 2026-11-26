/**
 * Autoevaluación post-entreno («¿Qué tan duro fue?», `submit_post_training_self_eval`) como acción de la bandeja.
 *
 * Pasa el checklist de §9 del spec sin migración: la RPC es idempotente (upsert por sujeto + métrica + sesión),
 * valida ADENTRO quién responde (acudiente del hijo, ficha vinculada o la propia cuenta), exige sesión cerrada,
 * asistencia y plazo, y no mueve dinero, cupos ni permisos. Reenviar N veces = 1 efecto.
 *
 * El plazo es fin del día siguiente al cierre: un rechazo tardío es explicable («ya se cerró el plazo») y no deja
 * nada a medias, porque la respuesta es una sola llamada.
 */
import { supabase } from '@/integrations/supabase/client';
import type { ResultadoEnvio } from '@/components/coach/v2/colaAsistencia';
import type { AccionEnBandeja } from './bandeja';
import { esErrorDeRed } from './bandejaEvaluar';

export const TIPO_AUTOEVAL = 'autoeval';

export type SujetoAutoeval =
  | { tipo: 'child'; id: string }
  | { tipo: 'profile'; id: string }
  | { tipo: 'unregistered'; id: string };

export interface PayloadAutoeval {
  sessionId: string;
  sujeto: SujetoAutoeval;
  /** Mismo objeto que recibe `p_answers` (rpe_borg, task_comprehension, focus…). */
  answers: Record<string, unknown>;
}

/** Una respuesta por sesión y sujeto: el reenvío o la corrección reemplaza, no se acumula. */
export const idAutoeval = (sessionId: string, s: SujetoAutoeval) => `${TIPO_AUTOEVAL}:${sessionId}:${s.tipo}:${s.id}`;

/** Parámetros exactos de la RPC según de quién es la respuesta (mismos que enviaban las dos pantallas). */
export function paramsAutoeval(p: PayloadAutoeval) {
  const base = { p_session_id: p.sessionId, p_answers: p.answers };
  if (p.sujeto.tipo === 'unregistered') {
    return { ...base, p_child_id: null, p_user_id: null, p_unregistered_athlete_id: p.sujeto.id };
  }
  return {
    ...base,
    p_child_id: p.sujeto.tipo === 'child' ? p.sujeto.id : null,
    p_user_id: p.sujeto.tipo === 'profile' ? p.sujeto.id : null,
  };
}

/**
 * Al volver a guardar la misma sesión, lo nuevo pisa lo anterior clave por clave, pero lo que ya estaba y no
 * se repite se conserva (el «un toque» de la tarjeta no debe borrar el formulario completo que se guardó antes).
 */
export function fusionarAutoeval(previo: PayloadAutoeval | undefined, nuevo: PayloadAutoeval): PayloadAutoeval {
  if (!previo) return nuevo;
  return { ...nuevo, answers: { ...previo.answers, ...nuevo.answers } };
}

interface ErrorRpc { code?: string | null; message?: string | null; status?: number }

/** Texto para la persona; sin jerga de base de datos. */
export function mensajeErrorAutoeval(error: ErrorRpc | null | undefined): string {
  const code = error?.code ?? '';
  const msg = error?.message ?? '';
  if (code === '55000' && /plazo/i.test(msg)) return 'Ya se cerró el plazo para responder este entreno.';
  if (code === '55000' && /asisti/i.test(msg)) return 'Este entreno no figura como asistido.';
  if (code === '55000' && /cerrado/i.test(msg)) return 'El entrenador todavía no cierra la lista de este entreno.';
  if (code === '55000') return 'Ya no se puede responder este entreno.';
  if (code === '42501') return 'No tienes permiso para responder este entreno.';
  if (code === 'P0002') return 'No encontramos ese entreno.';
  if (code === '22023') return 'La respuesta no es válida para este deporte.';
  return 'Inténtalo de nuevo en un momento.';
}

/**
 * Traduce el error de la RPC a la clasificación de la bandeja.
 *  · sin código y con texto de red → falta de señal: se reintenta.
 *  · 55000 «todavía no se ha cerrado»: la lista del entrenador puede seguir en su teléfono; se reintenta
 *    (si no llega, queda atascada con su motivo).
 *  · plazo vencido, no asistió, sin permiso, sesión inexistente, valor inválido: se aparta con su motivo.
 *  · 401 / JWT vencido: sesión, no falta de señal.
 */
export function clasificarErrorAutoeval(error: ErrorRpc | null | undefined): ResultadoEnvio {
  const code = error?.code ?? '';
  const msg = (error?.message ?? '').trim();
  const status = error?.status ?? 0;
  if (status === 401 || ((code === 'PGRST301' || code === 'PGRST303') && /jwt|token/i.test(msg))) return { kind: 'auth', message: msg || 'Sesión vencida' };
  if (esErrorDeRed(error)) return { kind: 'retry', message: 'Sin señal' };
  if (code === '55000' && /no se ha cerrado/i.test(msg)) {
    return { kind: 'retry', message: mensajeErrorAutoeval(error), servidor: true };
  }
  if (code === '42501' || code === 'P0002' || code === '55000' || code === '22023') {
    return { kind: 'rule', message: mensajeErrorAutoeval(error) };
  }
  return { kind: 'retry', message: mensajeErrorAutoeval(error), servidor: status >= 500 || !!code };
}

export async function enviarAutoeval(a: AccionEnBandeja): Promise<ResultadoEnvio> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'retry', message: 'Sin señal' };
  const p = a.payload as PayloadAutoeval;
  try {
    // p_unregistered_athlete_id no está en types.ts (migración 20261026155123).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (supabase as any).rpc('submit_post_training_self_eval', paramsAutoeval(p));
    if (r.error) {
      const c = clasificarErrorAutoeval(r.error);
      // Sin red el refresco del token falla como «sin sesión»: es falta de señal, no sesión vencida.
      if (c.kind === 'auth' && typeof navigator !== 'undefined' && navigator.onLine === false) return { kind: 'retry', message: 'Sin señal' };
      return c;
    }
    return { kind: 'ok', body: r.data };
  } catch (e) {
    return clasificarErrorAutoeval({ message: e instanceof Error ? e.message : String(e) });
  }
}
