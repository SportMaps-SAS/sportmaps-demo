import { Link } from 'react-router-dom';
import { Lightbulb, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useChildPerformanceEntries,
  useChildPerformanceEvolution,
  useChildReports,
  useLatestReportSnapshot,
} from './useHijosData';
import {
  comentariosDelProfe,
  firstName,
  formatLongDate,
  recentSessions,
  skillRows,
  skillRowsFromSnapshot,
  type Hijo,
  type SessionRating,
} from './hijosUtils';
import { EmptyNote, InlineError, Pill, Row, Section, SectionSkeleton, type Tone } from './parts';

const RATING_TONE: Record<SessionRating, Tone> = { Bien: 'good', Normal: 'neutral', 'Le costó': 'bad' };

export function ProgresoTab({ hijo }: { hijo: Hijo }) {
  const entries = useChildPerformanceEntries(hijo.id);
  const evolution = useChildPerformanceEvolution(hijo.id);
  const reports = useChildReports(hijo.id);
  const latestReportId = reports.data?.[0]?.id;
  const snapshot = useLatestReportSnapshot(latestReportId);

  const nombre = firstName(hijo.full_name);

  if (entries.isLoading || evolution.isLoading) {
    return <SectionSkeleton rows={4} label="Cargando el progreso" />;
  }

  if (entries.isError && evolution.isError) {
    return (
      <InlineError
        message={`No pudimos cargar el progreso de ${nombre}. Revisa tu conexión e intenta de nuevo.`}
        onRetry={() => {
          entries.refetch();
          evolution.refetch();
        }}
      />
    );
  }

  const sessions = recentSessions(entries.data);
  let skills = skillRows(evolution.data?.metrics, evolution.data?.evolution);
  if (skills.length === 0) skills = skillRowsFromSnapshot(snapshot.data?.snapshot?.metrics);

  const snap = snapshot.data?.snapshot;
  const coachNote = snap?.coach_note?.trim() || null;
  const toWorkOn = (snap?.to_work_on ?? []).map((m) => m.label).filter(Boolean).slice(0, 2);

  const comentarios = comentariosDelProfe(entries.data);

  const nothing = sessions.rows.length === 0 && skills.length === 0 && !coachNote && toWorkOn.length === 0
    && comentarios.length === 0;
  const parcial = entries.isError || evolution.isError;

  // Si una de las dos lecturas falló, «no hay evaluaciones» sería mentira (UX-2).
  if (nothing && parcial) {
    return (
      <InlineError
        message={`No pudimos cargar todo el progreso de ${nombre}. Revisa tu conexión e intenta de nuevo.`}
        onRetry={() => {
          entries.refetch();
          evolution.refetch();
        }}
      />
    );
  }

  if (nothing) {
    return (
      <div className="space-y-2">
        <EmptyNote icon={<TrendingUp className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          <p className="font-medium text-foreground">Todavía no hay evaluaciones de {nombre}.</p>
          <p className="mt-1">Cuando el profe califique un entreno o mida una habilidad, lo verás aquí.</p>
        </EmptyNote>
        {/* La pantalla completa de progreso (rutinas, sesiones, comentarios) siempre debe ser alcanzable. */}
        <Link
          to={`/children/${hijo.id}/progress`}
          className="flex min-h-touch items-center justify-center text-sm font-medium text-primary hover:underline"
        >
          Ver el progreso completo
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(entries.isError || evolution.isError) && (
        <InlineError message="Una parte del progreso no cargó. Lo que ves puede estar incompleto." />
      )}

      <Section title="Cómo le fue en los últimos entrenos">
        {sessions.rows.length === 0 ? (
          <p className="px-4 pb-4 pt-1 text-sm text-muted-foreground">El profe todavía no ha calificado entrenos.</p>
        ) : (
          <>
            {sessions.source === 'self' && (
              <p className="px-4 pb-1 text-xs text-muted-foreground">Según cómo se sintió {nombre} al terminar.</p>
            )}
            <div className="mt-1">
              {sessions.rows.map((s) => (
                <Row key={s.date}>
                  <span className="min-w-0 flex-1 truncate text-sm">{formatLongDate(s.date)}</span>
                  <Pill tone={RATING_TONE[s.rating]}>{s.rating}</Pill>
                </Row>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title="En qué va mejorando">
        {skills.length === 0 ? (
          <p className="px-4 pb-4 pt-1 text-sm text-muted-foreground">Todavía no hay habilidades medidas.</p>
        ) : (
          <ul className="space-y-4 px-4 pb-4 pt-2">
            {skills.map((s) => (
              <li key={s.key}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{s.label}</span>
                  <span className="shrink-0 tabular-nums">
                    <span className="font-semibold">{s.valueLabel}</span>
                    {s.deltaLabel && (
                      <span
                        className={cn(
                          'ml-2 text-xs font-semibold',
                          s.improved === true && 'text-green-700 dark:text-green-400',
                          s.improved === false && 'text-muted-foreground',
                        )}
                      >
                        {s.deltaLabel}
                      </span>
                    )}
                  </span>
                </div>
                {s.score !== null && (
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(s.score / 5) * 100}%` }} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {(coachNote || toWorkOn.length > 0) && (
          <div className="mx-4 mb-4 flex gap-2 rounded-xl bg-primary/5 p-3 text-sm">
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <p>
              {coachNote ? (
                <>
                  <span className="font-semibold">Consejo del profe: </span>
                  {coachNote}
                </>
              ) : (
                <>
                  <span className="font-semibold">Para trabajar en casa: </span>
                  {toWorkOn.join(' y ').toLowerCase()}.
                </>
              )}
            </p>
          </div>
        )}
        {comentarios.length > 0 && (
          <div className="mx-4 mb-4 space-y-2" data-testid="comentarios-profe">
            <p className="text-sm font-semibold">Lo que dijo el profe</p>
            {comentarios.map((c) => (
              <blockquote key={`${c.fecha}-${c.texto}`} className="rounded-xl bg-muted/60 p-3 text-sm leading-relaxed">
                «{c.texto}»
                <span className="mt-1 block text-xs text-muted-foreground">
                  {c.contexto === 'competition' ? 'Partido' : c.contexto === 'session' ? 'Entreno' : 'Evaluación'} · {formatLongDate(c.fecha)}
                </span>
              </blockquote>
            ))}
          </div>
        )}
        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Solo se compara con su propio avance. Nunca con otros niños.
        </p>
      </Section>

      <Link
        to={`/children/${hijo.id}/progress`}
        className="flex min-h-touch items-center justify-center text-sm font-medium text-primary hover:underline"
      >
        Ver todas las mediciones
      </Link>
    </div>
  );
}
