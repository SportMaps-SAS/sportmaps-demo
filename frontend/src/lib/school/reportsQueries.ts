/**
 * Athlete Reports (Informe Mensual del Atleta) — Vista del padre.
 *
 * A diferencia de performanceQueries.ts, esto NO pasa por el BFF: RLS ya
 * permite a la familia leer sus propios informes publicados
 * (athlete_reports_select_family) y mark_report_viewed ya tiene
 * GRANT EXECUTE TO authenticated -- ambos self-autorizan por auth.uid(),
 * así que el patrón "frontend lee DB directo" aplica tal cual.
 */
import { supabase } from '@/integrations/supabase/client';
import type { MetricBand, MetricThreshold } from './performanceQueries';

export type SubjectType = 'profile' | 'child' | 'unregistered';
export type ReportStatus = 'borrador' | 'listo' | 'publicado' | 'retenido' | 'omitido';

export interface SnapshotMetric {
  metric_key: string;
  label: string;
  hint: string | null;
  category: string | null;
  unit: string | null;
  higher_is_better: boolean;
  value: number;
  previous: number | null;
  delta: number | null;
  score: number | null;
  band: MetricBand;
  measured_at: string;
}

export interface FootballSummary {
  matches_played: number;
  minutes_played: number;
  goals: number;
  own_goals: number;
  assists: number;
  yellow_cards: number;
  red_cards: number;
}

/** PER-6 mitad B — carga de entrenamiento del mes (sRPE de Foster). */
export interface TrainingLoadSummary {
  sessions_count: number;
  total_ua: number;
}

export interface SessionMetricOption {
  value: number;
  label: string;
  n: number;
  pct: number;
}

/** Agregado del mes para una métrica que se registra varias veces (por
 *  sesión) — cansancio, comprensión, esfuerzo, satisfacción, aspectos a
 *  mejorar, rating del coach. A diferencia de `SnapshotMetric` (última vs.
 *  anterior), acá se promedia o distribuye TODO el periodo. */
export interface SessionMetricSummary {
  metric_key: string;
  label: string;
  category: string | null;
  aggregation: 'avg' | 'distribution' | 'count';
  n: number;
  avg?: number;
  distribution?: SessionMetricOption[];
  count?: number;
}

/** Un día del mes para el mapa de calor: si hubo entreno, qué tan duro fue
 *  (promedio de cansancio autopercibido) y si fue día de partido. */
export interface CalendarDay {
  date: string;
  day: number;
  has_session: boolean;
  attended: boolean | null;
  effort: number | null;
  is_match: boolean;
  minutes_played: number | null;
}

export interface ReportSnapshot {
  version: 1;
  generated_at: string;
  period: { year: number; month: number; label: string };
  athlete: { name: string; subject_type: SubjectType; subject_id: string };
  school: { id: string; name: string };
  teams: { id: string; name: string }[];
  governing_team: { id: string; name: string } | null;
  team_notes: { team_id: string; team_name: string; body: string }[];
  coach_note: string | null;
  attendance: { present: number; total: number; pct: number | null };
  highlights: SnapshotMetric[];
  to_work_on: SnapshotMetric[];
  metrics: SnapshotMetric[];
  metrics_session: SessionMetricSummary[];
  /** Panorama completo: última banda de cada métrica con historia, no solo este mes. */
  radar: SnapshotMetric[];
  calendar: CalendarDay[];
  football: FootballSummary | null;
  training_load: TrainingLoadSummary | null;
}

export interface AthleteReportListItem {
  id: string;
  period_year: number;
  period_month: number;
  status: ReportStatus;
  published_at: string | null;
  viewed_at: string | null;
}

export interface AthleteReportDetail extends AthleteReportListItem {
  snapshot: ReportSnapshot;
}

/** Solo informes YA publicados -- RLS filtra igual, pero se acota acá para no confiar solo en RLS. */
export async function getAthleteReports(
  subjectType: SubjectType,
  subjectId: string
): Promise<AthleteReportListItem[]> {
  // 'as any': athlete_reports todavía no está en el types.ts generado
  // (mismo patrón que 'school_athletes' en performance.ts del BFF).
  const { data, error } = await supabase
    .from('athlete_reports' as any)
    .select('id, period_year, period_month, status, published_at, viewed_at')
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .eq('status', 'publicado')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false });

  if (error) throw error;
  return (data as unknown as AthleteReportListItem[]) ?? [];
}

export async function getAthleteReportDetail(id: string): Promise<AthleteReportDetail> {
  const { data, error } = await supabase
    .from('athlete_reports' as any)
    .select('id, period_year, period_month, status, published_at, viewed_at, snapshot')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data as unknown as AthleteReportDetail;
}

/**
 * Descarga el PDF "al vuelo" (spec §8.4/§15, F4). A diferencia del resto de
 * este archivo, SÍ pasa por el BFF: pdfkit corre en Node, no en el navegador.
 * Abre el PDF en una pestaña nueva — no lo persiste en Storage, se regenera
 * cada vez desde el mismo `snapshot` congelado, así que nunca puede diferir
 * de lo que la pantalla ya mostró.
 */
export async function downloadAthleteReportPdf(id: string): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('No hay sesión activa.');

  const bffUrl = (import.meta as any).env?.VITE_BFF_URL
    || (window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://sportmaps-bff-prod.onrender.com');

  const response = await fetch(`${bffUrl}/api/v1/athlete-reports/${id}/pdf`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!response.ok) throw new Error('No se pudo generar el PDF del informe.');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Descarga el PDF del informe GRUPAL (de equipo) — spec
 * evaluacion-post-entrenamiento.md §5.3, "el PDF se genera igual, Besser lo
 * necesita para el club". Mismo patrón que `downloadAthleteReportPdf`, pero
 * esta ruta SÍ exige `x-school-id` (vive bajo `requireRole` de
 * `school/reports.ts`, no se autoriza solo por el id del recurso).
 */
export async function downloadTeamReportPdf(schoolId: string, teamId: string, year: number, month: number): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('No hay sesión activa.');

  const bffUrl = (import.meta as any).env?.VITE_BFF_URL
    || (window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://sportmaps-bff-prod.onrender.com');

  const response = await fetch(
    `${bffUrl}/api/v1/school/reports/team/${teamId}/pdf?year=${year}&month=${month}`,
    { headers: { Authorization: `Bearer ${session.access_token}`, 'x-school-id': schoolId } },
  );
  if (!response.ok) throw new Error('No se pudo generar el PDF del informe de equipo.');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function markReportViewed(id: string): Promise<void> {
  // 'as never': mark_report_viewed tampoco está en el types.ts generado
  // todavía (mismo escape hatch que useEquipment.ts ya usa para RPCs nuevas).
  const { error } = await supabase.rpc('mark_report_viewed' as never, { p_report_id: id } as never);
  // No es bloqueante: si falla el marcado de "visto" no tiene sentido tumbar
  // la lectura del informe que el padre ya está viendo.
  if (error) console.error('mark_report_viewed falló:', error);
}

export type { MetricThreshold };
