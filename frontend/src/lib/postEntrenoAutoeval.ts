/**
 * Autoevaluación post-entreno (spec docs/specs/evaluacion-post-entrenamiento.md §5.1)
 * — opciones y armado del envío, sin React.
 *
 * Los VALORES son los que guarda `submit_post_training_self_eval` y leen los
 * informes del equipo: no cambiarlos. Los textos sí se pueden pulir (son
 * neutros en género: la responde un niño, una niña o un adulto).
 */
import type { Json } from '@/integrations/supabase/types';

export interface EvalAnswers {
  rpe_borg: number | null;
  task_comprehension: number | null;
  self_effort_pct: number | null;
  satisfaction: number | null;
  focus: string[];
  focus_other_text: string;
}

export const EMPTY_ANSWERS: EvalAnswers = {
  rpe_borg: null,
  task_comprehension: null,
  self_effort_pct: null,
  satisfaction: null,
  focus: [],
  focus_other_text: '',
};

/** ¿Qué tan duro fue? — escala 0 a 10. */
export const BORG_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Nada, como en reposo' },
  { value: 1, label: 'Muy, muy suave' },
  { value: 2, label: 'Muy suave' },
  { value: 3, label: 'Suave' },
  { value: 4, label: 'Algo duro' },
  { value: 5, label: 'Duro' },
  { value: 6, label: 'Más duro' },
  { value: 7, label: 'Muy duro' },
  { value: 8, label: 'Muy, muy duro' },
  { value: 9, label: 'Al máximo' },
  { value: 10, label: 'Lo más duro posible' },
];

export const COMPREHENSION_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: 'Los entendí y los hice bien' },
  { value: 2, label: 'Los entendí, pero no me salieron' },
  { value: 3, label: 'Los hice sin entender bien para qué' },
  { value: 4, label: 'Ni los entendí ni los pude hacer' },
];

export const EFFORT_OPTIONS: { value: number; label: string }[] = [
  { value: 100, label: '¡Lo di todo!' },
  { value: 90, label: 'Me esforcé mucho' },
  { value: 80, label: 'Me esforcé bien' },
  { value: 70, label: 'Me esforcé normal' },
  { value: 60, label: 'Di la mitad' },
  { value: 50, label: 'Me costó, di menos de la mitad' },
];

/** El orden de los valores es el del catálogo; el de pantalla, de mejor a peor. */
export const SATISFACTION_OPTIONS: { value: number; label: string }[] = [
  { value: 3, label: 'Feliz y conforme con lo que hice' },
  { value: 4, label: 'Feliz' },
  { value: 2, label: 'Conforme con lo que hice' },
  { value: 5, label: 'Ni feliz ni conforme' },
  { value: 1, label: 'No quedé conforme' },
];

export const TOTAL_QUESTIONS = 5;

/** Paso 1–4: hay respuesta. Paso 5 (qué mejorar) es opcional. */
export function isAnswered(step: number, a: EvalAnswers): boolean {
  if (step === 1) return a.rpe_borg !== null;
  if (step === 2) return a.task_comprehension !== null;
  if (step === 3) return a.self_effort_pct !== null;
  if (step === 4) return a.satisfaction !== null;
  return true;
}

/** El `p_answers` que recibe submit_post_training_self_eval (igual que antes del rediseño). */
export function buildPayload(a: EvalAnswers): Record<string, Json> {
  const payload: Record<string, Json> = {
    rpe_borg: a.rpe_borg,
    task_comprehension: a.task_comprehension,
    self_effort_pct: a.self_effort_pct,
    satisfaction: a.satisfaction,
  };
  if (a.focus.length > 0) payload.focus = a.focus;
  if (a.focus.includes('focus_other') && a.focus_other_text.trim()) {
    payload.focus_other_text = a.focus_other_text.trim();
  }
  return payload;
}

export function toggleFocus(a: EvalAnswers, key: string): EvalAnswers {
  return { ...a, focus: a.focus.includes(key) ? a.focus.filter((f) => f !== key) : [...a.focus, key] };
}

/** Colombia no tiene horario de verano: UTC−5 todo el año. */
const BOGOTA_UTC_OFFSET_MS = 5 * 3_600_000;

/**
 * Hasta cuándo se puede responder: fin del día siguiente (Bogotá) al cierre real
 * de la lista. Misma regla que `post_training_plazo_respuesta` (migración
 * 20261029211413). El cierre real es el mayor entre finalized_at y updated_at:
 * el cierre automático de las 23:55 deja finalized_at en la hora del entreno.
 * Sin ninguna de las dos fechas no hay plazo (la RPC tampoco lo exige).
 */
export function plazoAutoeval(finalizedAt: string | null | undefined, updatedAt: string | null | undefined): Date | null {
  const tiempos = [finalizedAt, updatedAt]
    .map((t) => (t ? new Date(t).getTime() : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  if (tiempos.length === 0) return null;
  const local = new Date(Math.max(...tiempos) - BOGOTA_UTC_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 2) + BOGOTA_UTC_OFFSET_MS);
}

/** «Viernes 31 de julio» desde «2026-07-31» sin correrse de día (no usar new Date(fecha) directo). */
export function sessionDateLabel(value: string | null | undefined): string {
  if (!value) return '';
  const d = value.length <= 10 ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const s = d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1).replace(',', '');
}
