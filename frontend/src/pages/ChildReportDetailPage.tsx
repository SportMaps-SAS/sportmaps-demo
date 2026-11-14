/**
 * Informe mensual de un hijo — acudiente V2.
 *
 * Arriba una frase (asistencia del mes) y el consejo del profe; debajo lo
 * mejor del mes, en qué trabajar y todas las mediciones por tipo. Al abrirlo
 * se marca como visto (useAthleteReportDetail) y el PDF sale del mismo
 * `snapshot` congelado vía el BFF.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Download, Lightbulb, Loader2 } from 'lucide-react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useAthleteReportDetail } from '@/hooks/useAthleteReports';
import { BAND_STYLE, CATEGORY_ORDER, CATEGORY_STYLE, fmtWithUnit } from '@/lib/school/performanceDisplay';
import { downloadAthleteReportPdf, type CalendarDay, type SessionMetricSummary, type SnapshotMetric } from '@/lib/school/reportsQueries';
import { capitalize, firstName } from '@/components/parent/v2/hijos/hijosUtils';
import { InlineError, Section, SectionSkeleton } from '@/components/parent/v2/hijos/parts';
import { CabeceraHijo, Cifra, PaginaHijo, VolverLegado } from '@/components/parent/hijo-detalle/HijoDetalle';
import { deltaIsGood, deltaText, metricLabel, plural, POST_TRAINING_SECTIONS } from '@/components/parent/hijo-detalle/hijoDetalleUtils';

// Mismas secciones que el informe de equipo («Lo que trabajó el equipo»),
// más "lo que vio el entrenador": acá sí tiene sentido mostrarlo porque es
// sobre ESTE deportista, no una comparación de equipo.
const SESSION_SECTIONS_DETAIL = [
  ...POST_TRAINING_SECTIONS,
  { key: 'coach_effort_rating', title: 'Lo que vio el entrenador', metricKeys: ['coach_effort_rating'] },
];

/** Rampa fija de intensidad del entreno -- NO reusa verde/ámbar/rojo (eso
 *  queda reservado para el semáforo de bandas) ni teal/azul/violeta/magenta
 *  (reservados para categorías). */
const HEAT = ['#efe9e0', '#e3b9ad', '#cf7d6a', '#b94a37', '#8e2a1f'];
const DOW = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function heatLevel(effort: number | null): number {
  if (effort === null) return 1; // hubo entreno pero sin cansancio cargado ese día
  if (effort <= 2.5) return 1;
  if (effort <= 5) return 2;
  if (effort <= 7.5) return 3;
  return 4;
}

/** Radar "panorama completo": TODAS las métricas con historia, no solo las
 *  de este mes -- misma idea que `PlayerCard.tsx` del roster del coach,
 *  congelada acá para el padre. Normaliza por banda, no por valor crudo. */
function RadarPanorama({ radar }: { radar: SnapshotMetric[] }) {
  if (radar.length < 3) return null;
  const data = radar.map((m) => ({
    label: metricLabel(m.label, m.metric_key),
    score: m.band === 'green' ? 85 : m.band === 'yellow' ? 55 : m.band === 'red' ? 25 : 50,
  }));
  const destacadas = radar.filter((m) => m.band === 'green');

  return (
    <Section title="Panorama completo">
      <div className="space-y-3 p-4 pt-2">
        <p className="text-xs text-muted-foreground">{radar.length} métricas medidas en total</p>
        <div className="-mx-2 h-56">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={data} outerRadius="70%">
              <PolarGrid stroke="hsl(var(--border))" />
              <PolarAngleAxis dataKey="label" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} />
              <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
              <Radar dataKey="score" stroke="#10b981" fill="#10b981" fillOpacity={0.35} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
        {destacadas.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-semibold text-green-700 dark:text-green-400">Lo que más destaca</p>
            <ul className="space-y-1">
              {destacadas.map((m) => (
                <li key={m.metric_key} className="flex items-center justify-between text-sm">
                  <span className="min-w-0 truncate pr-2">{metricLabel(m.label, m.metric_key)}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{fmtWithUnit(m.value, m.unit)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  );
}

/** Mapa de calor del mes día a día -- pedido explícito de Besser: "que se
 *  alimente de todo el historial", no solo el promedio del mes. */
function MonthHeatmap({ calendar, year, month }: { calendar: CalendarDay[]; year: number; month: number }) {
  if (calendar.length === 0) return null;
  const startWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7; // lunes=0

  return (
    <div className="p-4 pt-2">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Intensidad del entreno:</span>
        <span className="flex items-center gap-1">
          suave
          {HEAT.slice(1).map((c) => (
            <span key={c} className="h-3.5 w-3.5 rounded" style={{ background: c }} />
          ))}
          fuerte
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3.5 w-3.5 rounded ring-2 ring-primary ring-inset" /> partido
        </span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-semibold text-muted-foreground">
        {DOW.map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {Array.from({ length: startWeekday }).map((_, i) => <div key={`blank-${i}`} />)}
        {calendar.map((d) => {
          const level = d.has_session ? heatLevel(d.effort) : 0;
          return (
            <div
              key={d.date}
              className={cn('relative aspect-square rounded-lg p-1', d.is_match && 'ring-2 ring-primary ring-inset')}
              style={{ background: d.has_session ? HEAT[level] : 'transparent' }}
            >
              <span className={cn(
                'text-[10px] font-bold tabular-nums',
                !d.has_session && 'text-muted-foreground/50',
                d.has_session && level >= 3 ? 'text-white' : d.has_session && 'text-foreground',
              )}>
                {d.day}
              </span>
              {d.minutes_played != null && (
                <span className="absolute bottom-0.5 right-1 text-[8px] font-bold text-white/90">{d.minutes_played}'</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Una métrica que se registró varias veces en el mes (cansancio, esfuerzo,
 *  satisfacción, aspectos a mejorar…), resumida en promedio/distribución. A
 *  diferencia de `MetricRow` (última vs. anterior), acá no hay "anterior": es
 *  todo el periodo de un vistazo. */
function SessionMetricBlock({ metric }: { metric: SessionMetricSummary }) {
  return (
    <div className="space-y-2 border-t px-4 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{metricLabel(metric.label, metric.metric_key)}</span>
        <span className="text-xs text-muted-foreground">{plural(metric.n, 'respuesta', 'respuestas')}</span>
      </div>

      {metric.aggregation === 'avg' && (
        <p className="text-lg font-semibold tabular-nums text-primary">{metric.avg ?? '—'}</p>
      )}

      {metric.aggregation === 'distribution' && (
        <ul className="space-y-1.5">
          {(metric.distribution ?? []).map((o) => (
            <li key={o.value}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 text-foreground">{o.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{o.pct} % ({o.n})</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <div className="h-full rounded-full bg-primary/70" style={{ width: `${o.pct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {metric.aggregation === 'count' && (
        <p className="text-sm">
          <span className="font-semibold">{metric.count}</span> de {metric.n} lo marcaron
        </p>
      )}
    </div>
  );
}

function MetricRow({ metric }: { metric: SnapshotMetric }) {
  const band = metric.band ? BAND_STYLE[metric.band] : null;
  const delta = deltaText(metric.delta, metric.unit);
  const good = deltaIsGood(metric.delta, metric.higher_is_better);
  return (
    <div className="flex min-h-touch items-center gap-3 border-t px-4 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{metricLabel(metric.label, metric.metric_key)}</p>
        {metric.hint && <p className="text-xs text-muted-foreground">{metric.hint}</p>}
      </div>
      {delta && (
        <span
          className={cn(
            'shrink-0 text-xs font-semibold tabular-nums',
            good === true && 'text-green-700 dark:text-green-400',
            good === false && 'text-red-700 dark:text-red-400',
          )}
        >
          {delta}
        </span>
      )}
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums',
          band ? band.chip : 'border-border bg-muted text-foreground',
        )}
        title={band?.label}
      >
        {fmtWithUnit(metric.value, metric.unit)}
      </span>
    </div>
  );
}

export default function ChildReportDetailPage() {
  const { id, reportId } = useParams<{ id: string; reportId: string }>();
  const { data: report, isLoading, isError, refetch } = useAthleteReportDetail(reportId);
  const { toast } = useToast();
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const handleDownloadPdf = async () => {
    if (!reportId) return;
    setDownloadingPdf(true);
    try {
      await downloadAthleteReportPdf(reportId);
    } catch (e: unknown) {
      toast({
        title: 'No se pudo descargar el PDF',
        description: e instanceof Error ? e.message : 'Intenta de nuevo.',
        variant: 'destructive',
      });
    } finally {
      setDownloadingPdf(false);
    }
  };

  if (isLoading) {
    return (
      <PaginaHijo>
        <SectionSkeleton rows={4} label="Cargando el informe" />
      </PaginaHijo>
    );
  }

  if (isError || !report) {
    return (
      <PaginaHijo>
        <VolverLegado to={`/children/${id}/reports`} label="Volver a informes" />
        <InlineError message="No pudimos abrir este informe. Revisa tu conexión e intenta de nuevo." onRetry={() => refetch()} />
      </PaginaHijo>
    );
  }

  const s = report.snapshot;
  const nombre = firstName(s.athlete?.name ?? '') || 'Tu hijo';
  const metricsByCategory = new Map<string, SnapshotMetric[]>();
  for (const m of s.metrics) {
    const cat = m.category && m.category in CATEGORY_STYLE ? m.category : 'other';
    if (!metricsByCategory.has(cat)) metricsByCategory.set(cat, []);
    metricsByCategory.get(cat)!.push(m);
  }

  // Lo que se registró VARIAS veces en el mes (después de cada entreno) no
  // vive en `s.metrics` (eso solo compara última-vs-anterior, correcto para
  // una prueba física mensual pero no para algo que se carga 8-18 veces).
  const sessionMetrics = s.metrics_session ?? [];
  const sessionByKey = new Map(sessionMetrics.map((m) => [m.metric_key, m]));
  const focusMetrics = sessionMetrics.filter((m) => m.metric_key.startsWith('focus_'));
  const sessionGroups = SESSION_SECTIONS_DETAIL
    .map((section) => ({
      section,
      metrics: section.key === 'focus'
        ? focusMetrics
        : section.metricKeys.map((k) => sessionByKey.get(k)).filter((m): m is SessionMetricSummary => !!m),
    }))
    .filter((g) => g.metrics.length > 0);

  const att = s.attendance;
  const fraseAsistencia =
    att.total > 0
      ? `${nombre} vino a ${att.present} de ${plural(att.total, 'entreno', 'entrenos')} este mes${att.pct !== null ? ` (${att.pct} %)` : ''}.`
      : `Este mes no hubo entrenos con lista para ${nombre}.`;
  // Una frase que reconoce el esfuerzo del mes -- el informe es para que un
  // papá o una mamá lo lea con ganas, no una planilla.
  const fraseMotivacion = s.highlights.length > 0
    ? `¡${nombre} tuvo un gran mes!`
    : `Cada entreno cuenta, ${nombre} va construyendo.`;

  return (
    <PaginaHijo>
      <VolverLegado to={`/children/${id}/reports`} label="Volver a informes" />
      <CabeceraHijo
        titulo={`Informe de ${s.period.label.toLowerCase()}`}
        sub={[s.school?.name, s.governing_team?.name].filter(Boolean).join(' · ')}
      />

      <Section>
        <div className="space-y-3 p-4">
          <p className="text-lg font-bold">{fraseMotivacion}</p>
          <p className="text-base font-semibold">{fraseAsistencia}</p>
          {s.coach_note && (
            <div className="flex gap-2 rounded-xl bg-primary/5 p-3 text-sm">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <p className="whitespace-pre-wrap">
                <span className="font-semibold">Lo que dice el profe: </span>
                {s.coach_note}
              </p>
            </div>
          )}
          {s.training_load && (
            <p className="text-sm text-muted-foreground">
              Registró qué tan duro fue en {plural(s.training_load.sessions_count, 'entreno', 'entrenos')} ({s.training_load.total_ua.toFixed(0)} UA de esfuerzo en el mes).
            </p>
          )}
          <Button
            variant="outline"
            className="min-h-touch w-full gap-2 sm:w-auto"
            onClick={handleDownloadPdf}
            disabled={downloadingPdf}
          >
            {downloadingPdf ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
            {downloadingPdf ? 'Preparando el PDF…' : 'Descargar PDF'}
          </Button>
        </div>
      </Section>

      {s.team_notes.length > 0 && (
        <Section title="Del equipo">
          {s.team_notes.map((n) => (
            <div key={n.team_id} className="border-t px-4 py-3 first:border-t-0">
              <p className="text-xs font-semibold text-muted-foreground">{n.team_name}</p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{n.body}</p>
            </div>
          ))}
        </Section>
      )}

      {s.football && (
        <Section title="Partidos del mes">
          <div className="grid grid-cols-3 gap-2 p-4 pt-2 sm:grid-cols-6">
            <Cifra valor={s.football.matches_played} etiqueta="Partidos" />
            <Cifra valor={`${s.football.minutes_played}'`} etiqueta="Minutos" />
            <Cifra valor={s.football.goals} etiqueta="Goles" />
            <Cifra valor={s.football.assists} etiqueta="Asistencias" />
            <Cifra valor={s.football.yellow_cards} etiqueta="Amarillas" />
            <Cifra valor={s.football.red_cards} etiqueta="Rojas" />
          </div>
        </Section>
      )}

      <RadarPanorama radar={s.radar ?? []} />

      {s.highlights.length > 0 && (
        <Section title="Lo mejor del mes">
          <div className="mt-1">
            {s.highlights.map((m) => <MetricRow key={m.metric_key} metric={m} />)}
          </div>
        </Section>
      )}

      {s.to_work_on.length > 0 && (
        <Section title="Para trabajar">
          <div className="mt-1">
            {s.to_work_on.map((m) => <MetricRow key={m.metric_key} metric={m} />)}
          </div>
        </Section>
      )}

      {CATEGORY_ORDER.filter((cat) => metricsByCategory.has(cat)).map((cat) => (
        <Section key={cat} title={capitalize(CATEGORY_STYLE[cat].label)}>
          <div className="mt-1">
            {metricsByCategory.get(cat)!.map((m) => <MetricRow key={m.metric_key} metric={m} />)}
          </div>
        </Section>
      ))}

      {s.metrics.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Cada medición se compara con la anterior de {nombre}. Nunca con otros niños.
        </p>
      )}

      {sessionGroups.map(({ section, metrics }) => (
        <Section key={section.key} title={section.title}>
          <div className="mt-1">
            {metrics.map((m) => <SessionMetricBlock key={m.metric_key} metric={m} />)}
          </div>
        </Section>
      ))}

      {sessionGroups.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Esto es lo que {nombre} respondió después de cada entreno este mes, resumido.
        </p>
      )}

      {(s.calendar?.length ?? 0) > 0 && (
        <Section title={`${capitalize(s.period.label)}, día a día`}>
          <MonthHeatmap calendar={s.calendar} year={s.period.year} month={s.period.month} />
        </Section>
      )}
    </PaginaHijo>
  );
}
