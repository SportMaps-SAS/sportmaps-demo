/**
 * Progreso del deportista — V2 (lienzo DepProgreso):
 * Cómo me fue · En qué mejoro · Informes · Felicitaciones.
 *
 * Fuentes (las mismas del acudiente, con él como sujeto):
 *  · Cómo me fue / En qué mejoro → BFF /api/v1/athlete/performance/{entries,evolution}
 *    sin child_id (= él), y asistencia de attendance_records.
 *  · Informes → athlete_reports publicados con subject_type 'profile' y
 *    subject_id = él (RLS athlete_reports_select_family ya lo permite: B4 vivo).
 *    El detalle se abre aquí mismo: la ruta /children/:id/reports es del acudiente.
 *  · Felicitaciones → RPC list_kudos (B1). Si aún no existe, la pestaña se oculta.
 *
 * Decisión 9: informes y felicitaciones los ve el deportista, mayor o menor.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, FileText, Heart, Lightbulb, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getAthletePerformanceEntries, getAthletePerformanceEvolution } from '@/lib/school/performanceQueries';
import { downloadAthleteReportPdf, getAthleteReportDetail, markReportViewed } from '@/lib/school/reportsQueries';
import { informeEntrenoDeportista } from '@/lib/api/v2Contratos';
import {
  MESES, formatLongDate, recentSessions, skillRows, skillRowsFromSnapshot, type SessionRating,
} from '@/components/parent/v2/hijos/hijosUtils';
import { EmptyNote, InlineError, Pill, Row, Section, SectionSkeleton, type Tone } from '@/components/parent/v2/hijos/parts';
import { asistenciaDelMes, cargaSemanal, profeCorto } from './athleteV2Model';
import { useAthleteAttendance, useAthleteTeams, useMisInformes, useMyKudos } from './useAthleteV2Data';
import { useDeportista } from './useDeportista';
import { SegmentedTabs } from './SegmentedTabs';
import { useAhora } from './useAhora';

type Tab = 'fue' | 'mejoro' | 'informes' | 'felicitaciones';
const RATING_TONE: Record<SessionRating, Tone> = { Bien: 'good', Normal: 'neutral', 'Le costó': 'bad' };

export interface AthleteProgressV2Props {
  /** Pestaña con la que abre. Si no se pasa, se lee `?tab=` (p. ej. «felicitaciones» desde Hoy). */
  inicial?: Tab;
  hoy?: Date;
}

function useEntries(userId: string | undefined) {
  return useQuery({ queryKey: ['athlete-performance-entries', 'self', userId], queryFn: () => getAthletePerformanceEntries(), enabled: !!userId, retry: 1 });
}
function useEvolution(userId: string | undefined) {
  return useQuery({ queryKey: ['athlete-performance-evolution', 'self', userId, 365], queryFn: () => getAthletePerformanceEvolution(undefined, 365), enabled: !!userId, retry: 1 });
}

const TABS: Tab[] = ['fue', 'mejoro', 'informes', 'felicitaciones'];
const esTab = (v: string | null): v is Tab => !!v && (TABS as string[]).includes(v);

export function AthleteProgressV2({ inicial, hoy }: AthleteProgressV2Props) {
  const ahora = useAhora(hoy);
  const d = useDeportista();
  const kudos = useMyKudos(d.userId);
  // La pestaña existe si list_kudos existe; con error también (para decirlo y reintentar).
  const hayKudos = kudos.isError || (!!kudos.data && !kudos.data.oculto);
  const [params] = useSearchParams();
  const deUrl = params.get('tab');
  const [tab, setTab] = useState<Tab>(inicial ?? (esTab(deUrl) ? deUrl : 'fue'));
  const tabs: { value: Tab; label: string }[] = [
    { value: 'fue', label: 'Cómo me fue' },
    { value: 'mejoro', label: 'En qué mejoro' },
    { value: 'informes', label: 'Informes' },
    ...(hayKudos ? [{ value: 'felicitaciones' as const, label: 'Felicitaciones' }] : []),
  ];
  const actual: Tab = tab === 'felicitaciones' && !hayKudos ? 'fue' : tab;

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 pb-nav-safe">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">Progreso</h1>
        <SegmentedTabs<Tab> tabs={tabs} value={actual} onChange={setTab} label="Progreso" />
      </header>
      {actual === 'fue' && <ComoMeFue userId={d.userId} ahora={ahora} />}
      {actual === 'mejoro' && <EnQueMejoro userId={d.userId} />}
      {actual === 'informes' && <Informes userId={d.userId} ahora={ahora} />}
      {actual === 'felicitaciones' && kudos.isError && (
        <InlineError message="No pudimos cargar tus felicitaciones." onRetry={() => { void kudos.refetch(); }} />
      )}
      {actual === 'felicitaciones' && !kudos.isError && kudos.data && !kudos.data.oculto && (
        kudos.data.data.length === 0 ? (
          <EmptyNote icon={<Heart className="h-8 w-8 opacity-40" aria-hidden />}>
            <p className="font-medium text-foreground">Todavía no tienes felicitaciones.</p>
            <p className="mt-1">Cuando tu profe te felicite, la verás aquí.</p>
          </EmptyNote>
        ) : (
          <section className="space-y-3">
            <p className="text-base text-muted-foreground">
              Te han felicitado {kudos.data.data.length} {kudos.data.data.length === 1 ? 'vez' : 'veces'}.
            </p>
            {kudos.data.data.map((k) => (
              <article key={k.id} className="rounded-2xl border bg-card p-4">
                <p className="text-base">«{k.mensaje}»</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {profeCorto(k.profe)}{k.fecha ? ` · ${formatLongDate(k.fecha.slice(0, 10)).toLowerCase()}` : ''}
                </p>
              </article>
            ))}
          </section>
        )
      )}
    </div>
  );
}

function ComoMeFue({ userId, ahora }: { userId: string | undefined; ahora: Date }) {
  const entries = useEntries(userId);
  const att = useAthleteAttendance(userId);
  if (entries.isLoading) return <SectionSkeleton rows={3} label="Cargando cómo te fue" />;

  const mes = asistenciaDelMes(att.data, ahora);
  const carga = cargaSemanal(entries.data, ahora);
  const hayCarga = carga.some((c) => c.valor !== null);
  const sesiones = recentSessions(entries.data);

  return (
    <div className="space-y-4">
      {mes.total > 0 && (
        <p className="text-lg font-semibold leading-snug">
          En {mes.mes} viniste a {mes.vino} de {mes.total} {mes.total === 1 ? 'entreno' : 'entrenos'}.
        </p>
      )}
      {entries.isError ? (
        <InlineError message="No pudimos cargar tus evaluaciones. Revisa tu conexión e intenta de nuevo." onRetry={() => { void entries.refetch(); }} />
      ) : (
        <>
          {hayCarga && (
            <Section title="¿Qué tan duro fue? Últimas 4 semanas">
              <div className="flex h-32 items-end gap-3 px-4 pb-2 pt-3" aria-hidden>
                {carga.map((c, i) => (
                  <div key={c.label} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-xs font-semibold tabular-nums">{c.valor ?? '—'}</span>
                    <div
                      className={cn('w-full rounded-md', i === carga.length - 1 ? 'bg-primary' : 'bg-primary/40')}
                      style={{ height: `${((c.valor ?? 0) / 10) * 80}px` }}
                    />
                    <span className="text-xs text-muted-foreground">{c.label}</span>
                  </div>
                ))}
              </div>
              <p className="sr-only">{carga.map((c) => `${c.label}: ${c.valor ?? 'sin respuesta'}`).join('. ')}</p>
              <p className="border-t px-4 py-3 text-xs text-muted-foreground">Promedio de lo que respondiste, de 0 (nada) a 10 (lo más duro posible).</p>
            </Section>
          )}
          <Section title={sesiones.source === 'self' ? 'Cómo te sentiste en los últimos entrenos' : 'Lo que dijo el profe'}>
            {sesiones.rows.length === 0 ? (
              <p className="px-4 pb-4 pt-1 text-sm text-muted-foreground">Tu profe todavía no ha calificado entrenos.</p>
            ) : (
              <div className="mt-1">
                {sesiones.rows.map((s) => (
                  <Row key={s.date}>
                    <span className="min-w-0 flex-1 truncate text-sm">{formatLongDate(s.date)}</span>
                    <Pill tone={RATING_TONE[s.rating]}>{s.rating}</Pill>
                  </Row>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
      <Link to="/stats/todo" className="flex min-h-touch items-center justify-center gap-1 text-sm font-semibold text-primary">
        Ver todas mis estadísticas <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}

function EnQueMejoro({ userId }: { userId: string | undefined }) {
  const evolution = useEvolution(userId);
  const reports = useMisInformes(userId);
  const latest = reports.data?.data[0]?.id;
  const snap = useQuery({ queryKey: ['athlete-report-snapshot', latest], queryFn: () => getAthleteReportDetail(latest!), enabled: !!latest, staleTime: 5 * 60 * 1000 });

  if (evolution.isLoading) return <SectionSkeleton rows={3} label="Cargando en qué mejoras" />;
  let skills = skillRows(evolution.data?.metrics, evolution.data?.evolution);
  if (skills.length === 0) skills = skillRowsFromSnapshot(snap.data?.snapshot?.metrics);
  if (skills.length === 0 && evolution.isError) {
    return <InlineError message="No pudimos cargar tus mediciones. Revisa tu conexión e intenta de nuevo." onRetry={() => { void evolution.refetch(); }} />;
  }
  if (skills.length === 0) {
    return (
      <EmptyNote icon={<TrendingUp className="h-8 w-8 opacity-40" aria-hidden />}>
        <p className="font-medium text-foreground">Todavía no hay habilidades medidas.</p>
        <p className="mt-1">Cuando tu profe mida algo, verás aquí cómo vas mejorando.</p>
      </EmptyNote>
    );
  }
  const tip = snap.data?.snapshot?.coach_note?.trim();
  return (
    <div className="space-y-4">
      <p className="text-base text-muted-foreground">Lo que mide tu profe. Solo se compara con tu propio avance.</p>
      <Section>
        <ul className="space-y-4 p-4">
          {skills.map((s) => (
            <li key={s.key}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="min-w-0 truncate">{s.label}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-semibold">{s.valueLabel}</span>
                  {s.deltaLabel && (
                    <span className={cn('ml-2 text-xs font-semibold', s.improved === true && 'text-green-700 dark:text-green-400', s.improved === false && 'text-muted-foreground')}>
                      {s.deltaLabel}
                    </span>
                  )}
                </span>
              </div>
              {s.score !== null && (
                <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${(s.score / 5) * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
        {tip && (
          <div className="mx-4 mb-4 flex gap-2 rounded-xl bg-primary/5 p-3 text-sm">
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p><span className="font-semibold">Consejo del profe: </span>{tip}</p>
          </div>
        )}
      </Section>
    </div>
  );
}

function Informes({ userId, ahora }: { userId: string | undefined; ahora: Date }) {
  const reports = useMisInformes(userId);
  const teams = useAthleteTeams(userId);
  const [abierto, setAbierto] = useState<string | null>(null);
  if (reports.isLoading) return <SectionSkeleton rows={2} label="Cargando tus informes" />;
  if (reports.isError) return <InlineError message="No pudimos cargar tus informes." onRetry={() => { void reports.refetch(); }} />;
  const list = reports.data?.data ?? [];
  return (
    <div className="space-y-4">
      {(teams.data ?? []).map((t) => <InformeEntreno key={t.teamId} teamId={t.teamId} equipo={t.nombre} ahora={ahora} />)}
      {list.length === 0 ? (
        <EmptyNote icon={<FileText className="h-8 w-8 opacity-40" aria-hidden />}>
          <p className="font-medium text-foreground">Todavía no tienes informes mensuales.</p>
          <p className="mt-1">Cuando tu profe publique el informe del mes, aparece aquí.</p>
        </EmptyNote>
      ) : (
        <Section title="Informes mensuales">
          {list.map((r) => (
            <InformeFila
              key={r.id}
              id={r.id}
              titulo={`Informe de ${MESES[r.period_month - 1] ?? ''} ${r.period_year}`}
              nuevo={!r.viewed_at}
              abierto={abierto === r.id}
              onToggle={() => setAbierto((a) => (a === r.id ? null : r.id))}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

/**
 * «Lo que trabajó el equipo» del mes (informe grupal con su dato encima, B4).
 * El BFF devuelve el snapshot grupal COMPLETO aunque aquí solo se use la nota
 * del profe: por eso se pide solo cuando el deportista abre la sección, no al
 * cargar Progreso. Si el BFF todavía exige child_id (noDisponible), la sección
 * se oculta después de abrirla; si el informe no se ha publicado, se dice.
 */
function InformeEntreno({ teamId, equipo, ahora }: { teamId: string; equipo: string; ahora: Date }) {
  const [abierto, setAbierto] = useState(false);
  const year = ahora.getFullYear();
  const month = ahora.getMonth() + 1;
  const q = useQuery({
    queryKey: ['athlete-v2-informe-entreno', teamId, year, month],
    queryFn: () => informeEntrenoDeportista(teamId, year, month),
    enabled: abierto,
    staleTime: 10 * 60 * 1000,
  });
  if (q.data?.noDisponible) return null;
  const nota = q.data?.data?.coach_note?.trim();
  return (
    <Section>
      <button
        type="button"
        onClick={() => setAbierto((a) => !a)}
        aria-expanded={abierto}
        className="flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        <span className="min-w-0 flex-1 text-sm font-semibold">{`Lo que trabajó ${equipo} en ${MESES[ahora.getMonth()]}`}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', abierto && 'rotate-180')} aria-hidden />
      </button>
      {abierto && (
        <div className="px-4 pb-4">
          {q.isLoading ? (
            <SectionSkeleton rows={1} label="Abriendo el informe del entreno" />
          ) : q.data?.error ? (
            <InlineError message="No pudimos abrir el informe del entreno." onRetry={() => { void q.refetch(); }} />
          ) : !q.data?.data ? (
            <p className="text-sm text-muted-foreground">Tu profe todavía no publica el informe del entreno de este mes.</p>
          ) : (
            <p className="text-sm">{nota ? `«${nota}»` : 'Tu profe publicó el informe del entreno de este mes.'}</p>
          )}
        </div>
      )}
    </Section>
  );
}

function InformeFila({ id, titulo, nuevo, abierto, onToggle }: { id: string; titulo: string; nuevo: boolean; abierto: boolean; onToggle: () => void }) {
  const det = useQuery({
    queryKey: ['athlete-report-detail-v2', id],
    queryFn: async () => {
      const r = await getAthleteReportDetail(id);
      void markReportViewed(id); // no bloquea: si falla, el informe se lee igual
      return r;
    },
    enabled: abierto,
  });
  const snap = det.data?.snapshot;
  const trabajar = (snap?.to_work_on ?? []).map((m) => m.label).filter(Boolean).slice(0, 3);
  return (
    <div className="border-t first:border-t-0">
      <button type="button" onClick={onToggle} aria-expanded={abierto} className="flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium">{titulo}</span>
        {nuevo && <Pill tone="info">Nuevo</Pill>}
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', abierto && 'rotate-180')} aria-hidden />
      </button>
      {abierto && (
        <div className="space-y-3 px-4 pb-4">
          {det.isLoading ? (
            <SectionSkeleton rows={1} label="Abriendo el informe" />
          ) : det.isError ? (
            <InlineError message="No pudimos abrir el informe." onRetry={() => { void det.refetch(); }} />
          ) : (
            <>
              {snap?.coach_note?.trim() ? (
                <p className="rounded-xl bg-primary/5 p-3 text-sm">«{snap.coach_note.trim()}»</p>
              ) : (
                <p className="text-sm text-muted-foreground">Tu profe no dejó comentario este mes.</p>
              )}
              {trabajar.length > 0 && (
                <p className="text-sm"><span className="font-semibold">Para trabajar: </span>{trabajar.join(', ').toLowerCase()}.</p>
              )}
              <Button
                variant="outline"
                className="min-h-touch rounded-xl"
                onClick={() => {
                  downloadAthleteReportPdf(id).catch(() => toast.error('No pudimos descargar el informe', { description: 'Inténtalo de nuevo en un momento.' }));
                }}
              >
                Descargar el informe (PDF)
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default AthleteProgressV2;
