/**
 * Datos de la evaluación de entrenadores (spec evaluacion-de-entrenadores).
 * Escritura SOLO por RPC (migración 20261028201746); lectura con RLS
 * (admin de la escuela, o el propio entrenador si está publicada).
 * `supabase as any`: las tablas nuevas entran a types.ts al regenerar tipos
 * al final del lote de migraciones.
 */
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import type { PeriodType } from './periods';

const db = supabase as any;

export type AutoMetric = 'sesiones_planificadas' | 'listas_tomadas' | 'evaluaciones' | 'adherencia_mesociclo';

export const AUTO_METRIC_OPTIONS: { value: AutoMetric | ''; label: string }[] = [
  { value: '', label: 'Ninguno (solo tu criterio)' },
  { value: 'sesiones_planificadas', label: 'Sesiones planificadas' },
  { value: 'listas_tomadas', label: 'Listas tomadas' },
  { value: 'evaluaciones', label: 'Evaluaciones a deportistas' },
  { value: 'adherencia_mesociclo', label: 'Cumplimiento del mesociclo' },
];

export interface Criterion {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  auto_metric: AutoMetric | null;
  sort_order: number;
  active: boolean;
}

export interface EvaluationScore {
  criterion_id: string;
  criterion_name: string;
  /** null cuando not_applicable. */
  score: number | null;
  not_applicable: boolean;
  comment: string | null;
}

export interface CoachEvaluation {
  id: string;
  school_id: string;
  staff_id: string;
  period_type: PeriodType;
  period_start: string;
  period_end: string;
  status: 'borrador' | 'publicada';
  overall_score: number | null;
  strengths: string | null;
  improvements: string | null;
  commitments: string | null;
  other_notes: string | null;
  activity_snapshot: CoachPeriodSummary | null;
  published_at: string | null;
  updated_at: string;
  coach_evaluation_scores: EvaluationScore[];
}

/** Respuesta de GET /api/v1/school/coach-evaluation-summary (BFF coach-evaluation-summary.ts). */
export interface CoachPeriodSummary {
  staff_id: string;
  full_name: string;
  has_account: boolean;
  from: string;
  to: string;
  cutoff: string;
  teams: string[];
  sesiones_planificadas: { planned: number; weeks_total: number; weeks_with_plan: number };
  listas_tomadas: { lists: number; days: number; due_sessions: number; due_with_list: number; pct: number | null };
  evaluaciones: { entries: number; athletes: number; mesocycle_evaluations: number };
  adherencia_mesociclo: { due: number; done: number; pct: number | null };
  last_activity_at: string | null;
}

/** Texto del dato automático de un ítem, en palabras. */
export function autoMetricText(metric: AutoMetric | null, s: CoachPeriodSummary | null | undefined): string | null {
  if (!metric || !s) return null;
  switch (metric) {
    case 'sesiones_planificadas': {
      const { planned, weeks_total, weeks_with_plan } = s.sesiones_planificadas;
      return weeks_total > 0
        ? `${planned} sesiones planificadas · ${weeks_with_plan} de ${weeks_total} semanas con plan`
        : `${planned} sesiones planificadas`;
    }
    case 'listas_tomadas': {
      const l = s.listas_tomadas;
      return l.due_sessions > 0
        ? `Tomó lista en ${l.due_with_list} de ${l.due_sessions} sesiones planificadas (${l.pct}%) · ${l.lists} listas en total`
        : `${l.lists} listas tomadas`;
    }
    case 'evaluaciones': {
      const e = s.evaluaciones;
      return `Evaluó a ${e.athletes} deportista${e.athletes === 1 ? '' : 's'} (${e.entries} registro${e.entries === 1 ? '' : 's'})`
        + (e.mesocycle_evaluations > 0 ? ` · ${e.mesocycle_evaluations} de la rúbrica del mesociclo` : '');
    }
    case 'adherencia_mesociclo': {
      const a = s.adherencia_mesociclo;
      return a.due > 0
        ? `${a.pct}% de cumplimiento: ${a.done} de ${a.due} sesiones del mesociclo con lista`
        : 'Sin sesiones de mesociclo vencidas en el período';
    }
  }
}

async function ok<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message || 'Error de base de datos');
  return data;
}

export async function listCriteria(schoolId: string, ensure: boolean): Promise<Criterion[]> {
  if (ensure) await ok(db.rpc('ensure_coach_evaluation_criteria', { p_school_id: schoolId }));
  return ok(db.from('coach_evaluation_criteria')
    .select('id, school_id, name, description, auto_metric, sort_order, active')
    .eq('school_id', schoolId)
    .order('sort_order')
    .order('created_at'));
}

export function saveCriterion(schoolId: string, c: { id?: string | null; name: string; description?: string | null; auto_metric?: AutoMetric | '' | null; active?: boolean }) {
  return ok<string>(db.rpc('save_coach_evaluation_criterion', {
    p_school_id: schoolId,
    p_id: c.id ?? null,
    p_name: c.name,
    p_description: c.description ?? null,
    p_auto_metric: c.auto_metric || null,
    p_active: c.active ?? true,
  }));
}

export function reorderCriteria(schoolId: string, ids: string[]) {
  return ok(db.rpc('reorder_coach_evaluation_criteria', { p_school_id: schoolId, p_ids: ids }));
}

const EVAL_COLS = 'id, school_id, staff_id, period_type, period_start, period_end, status, overall_score, strengths, improvements, commitments, other_notes, activity_snapshot, published_at, updated_at, coach_evaluation_scores(criterion_id, criterion_name, score, not_applicable, comment)';

/** Evaluaciones de un entrenador (admin: todas; RLS deja al coach solo las publicadas). */
export function listEvaluations(staffIds: string[]): Promise<CoachEvaluation[]> {
  if (staffIds.length === 0) return Promise.resolve([]);
  return ok(db.from('coach_evaluations')
    .select(EVAL_COLS)
    .in('staff_id', staffIds)
    .order('period_start', { ascending: false }));
}

export function getCoachPeriodSummary(staffId: string, from: string, to: string) {
  const q = new URLSearchParams({ staff_id: staffId, from, to });
  return bffClient.get<CoachPeriodSummary>(`/api/v1/school/coach-evaluation-summary?${q}`);
}

export function saveEvaluation(input: {
  staffId: string;
  periodType: PeriodType;
  periodStart: string;
  scores: { criterion_id: string; score: number | null; not_applicable?: boolean; comment?: string | null }[];
  strengths?: string;
  improvements?: string;
  commitments?: string;
  otherNotes?: string;
  snapshot: CoachPeriodSummary | null;
  publish: boolean;
}) {
  return ok<string>(db.rpc('save_coach_evaluation', {
    p_staff_id: input.staffId,
    p_period_type: input.periodType,
    p_period_start: input.periodStart,
    p_scores: input.scores,
    p_strengths: input.strengths ?? null,
    p_improvements: input.improvements ?? null,
    p_commitments: input.commitments ?? null,
    p_other_notes: input.otherNotes ?? null,
    p_snapshot: input.snapshot,
    p_publish: input.publish,
  }));
}

export function deleteEvaluation(id: string) {
  return ok(db.rpc('delete_coach_evaluation', { p_id: id }));
}
