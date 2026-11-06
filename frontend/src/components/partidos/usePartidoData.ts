/**
 * Lecturas de la pantalla del partido. Todo va con el JWT del usuario: la RLS
 * (match_results, school_metric_definitions, performance_entries,
 * school_settings) decide qué ve cada uno. Las escrituras son RPCs que se
 * llaman desde el componente, también con el JWT (gotchas: una RPC llamada
 * desde el BFF con service role se saltea su propia autorización).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { EvaluationMetric } from '@/components/school/evaluationMetrics';
import type { Escala } from './partidoFlujoLogic';

// Las columnas y RPCs nuevas de partidos no están en types.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db = supabase as any;

export interface PartidoFila {
  id: string;
  team_id: string;
  school_id: string;
  opponent: string;
  match_date: string;
  kickoff_at: string | null;
  location: string | null;
  is_home: boolean | null;
  home_score: number | null;
  away_score: number | null;
  status: string | null;
  match_type: string | null;
  notes: string | null;
  evaluation_published_at: string | null;
  calendar_event_id: string | null;
  live_periods_count: number | null;
  live_period_minutes: number | null;
  match_kind: 'official' | 'practice' | null;
  referee_name: string | null;
}

const COLUMNAS = 'id, team_id, school_id, opponent, match_date, kickoff_at, location, is_home, home_score, away_score, status, match_type, notes, evaluation_published_at, calendar_event_id, live_periods_count, live_period_minutes, match_kind, referee_name';

export const qkPartido = (id: string | null | undefined) => ['partido', id] as const;

export function usePartido(matchId: string | null | undefined) {
  return useQuery({
    queryKey: qkPartido(matchId),
    enabled: !!matchId,
    queryFn: async (): Promise<PartidoFila | null> => {
      const { data, error } = await db.from('match_results').select(COLUMNAS).eq('id', matchId).maybeSingle();
      if (error) throw error;
      return (data as PartidoFila) ?? null;
    },
  });
}

export interface EquipoPartido { id: string; name: string; sport: string | null; school_id: string }

export function useEquipoPartido(teamId: string | null | undefined) {
  return useQuery({
    queryKey: ['partido-equipo', teamId],
    enabled: !!teamId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<EquipoPartido | null> => {
      const { data, error } = await db.from('teams').select('id, name, sport, school_id').eq('id', teamId).maybeSingle();
      if (error) throw error;
      return (data as EquipoPartido) ?? null;
    },
  });
}

export interface CriterioEscuela {
  metric_key: string;
  display_name: string;
  scale: Escala;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  options: { value: number; label: string }[] | null;
  applies_to: 'match' | 'training' | 'both';
  sort_order: number;
  is_active: boolean;
  source_definition_id: string | null;
}

/** Criterios de la escuela (todos; el filtro de partido va en la lógica pura). */
export function useCriteriosEscuela(schoolId: string | null | undefined) {
  return useQuery({
    queryKey: ['partido-criterios', schoolId],
    enabled: !!schoolId,
    queryFn: async (): Promise<CriterioEscuela[]> => {
      const { data, error } = await db
        .from('school_metric_definitions')
        .select('metric_key, display_name, scale, unit, min_value, max_value, options, applies_to, sort_order, is_active, source_definition_id')
        .eq('school_id', schoolId);
      if (error) throw error;
      return (data ?? []) as CriterioEscuela[];
    },
  });
}

/** Criterio de la escuela → la forma que pinta QuickMetricInput. */
export function aMetricaRapida(c: CriterioEscuela): EvaluationMetric {
  return {
    metric_key: c.metric_key,
    display_name: c.display_name,
    parent_label: null,
    scale: c.scale,
    unit: c.unit,
    min_value: c.min_value,
    max_value: c.max_value,
    options: c.options,
    category: null,
    sort_order: c.sort_order,
    source_definition_id: c.source_definition_id,
    thresholds: [],
  };
}

export interface FilaEvaluacion {
  subject_type: string;
  subject_id: string;
  metric_key: string;
  value: number | null;
  notes: string | null;
}

export const qkEvaluacion = (matchId: string | null | undefined) => ['partido-evaluacion', matchId] as const;

export function useEvaluacionPartido(matchId: string | null | undefined) {
  return useQuery({
    queryKey: qkEvaluacion(matchId),
    enabled: !!matchId,
    queryFn: async (): Promise<FilaEvaluacion[]> => {
      const { data, error } = await db
        .from('performance_entries')
        .select('subject_type, subject_id, metric_key, value, notes')
        .eq('context_type', 'competition')
        .eq('context_id', matchId);
      if (error) throw error;
      return (data ?? []) as FilaEvaluacion[];
    },
  });
}

/** school_settings.share_match_evaluations (D7). null = sin fila / sin dato. */
export function useCompartirEvaluaciones(schoolId: string | null | undefined) {
  return useQuery({
    queryKey: ['partido-compartir', schoolId],
    enabled: !!schoolId,
    queryFn: async (): Promise<boolean | null> => {
      const { data, error } = await db
        .from('school_settings')
        .select('share_match_evaluations')
        .eq('school_id', schoolId)
        .maybeSingle();
      if (error) throw error;
      return data ? !!data.share_match_evaluations : null;
    },
  });
}
