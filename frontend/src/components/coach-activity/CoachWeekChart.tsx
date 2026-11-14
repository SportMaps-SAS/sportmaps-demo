/**
 * Gráficas de "Seguimiento deportivo". Reglas del rediseño (spec §3): una
 * gráfica = una pregunta como título, barras simples, el número escrito en
 * cada barra, leyenda en palabras y una frase debajo que la resume.
 */
import {
  Bar, BarChart, LabelList, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { dayToLocalDate } from '@/lib/dateUtils';
import { SERIES_COLORS, type CoachActivity, type CoachWeekPoint } from './types';
import { shortName } from './format';

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-sm" style={{ background: SERIES_COLORS.planned }} />
        Sesiones planificadas
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-sm" style={{ background: SERIES_COLORS.lists }} />
        Listas de asistencia tomadas
      </span>
    </div>
  );
}

/** "¿Quién trabajó esta semana?" — compacta: dos números arriba, una fila
 *  delgada por entrenador que trabajó (dos minibarras con su número) y los que
 *  no hicieron nada plegados en una sola línea. Antes era una gráfica de 58 px
 *  por entrenador, ceros incluidos, que ocupaba media pantalla. */
export function WhoWorkedChart({ coaches, onOpen }: { coaches: CoachActivity[]; onOpen?: (staffId: string) => void }) {
  const [showIdle, setShowIdle] = useState(false);
  const active = coaches
    .filter((c) => c.sessions_planned_week > 0 || c.attendance_sessions_week > 0)
    .sort((a, b) => (b.sessions_planned_week + b.attendance_sessions_week) - (a.sessions_planned_week + a.attendance_sessions_week)
      || a.full_name.localeCompare(b.full_name, 'es'));
  const idle = coaches
    .filter((c) => c.sessions_planned_week === 0 && c.attendance_sessions_week === 0)
    .sort((a, b) => a.full_name.localeCompare(b.full_name, 'es'));
  const maxValue = Math.max(1, ...active.map((c) => Math.max(c.sessions_planned_week, c.attendance_sessions_week)));
  const both = coaches.filter((c) => c.status === 'verde').length;

  if (coaches.length === 0) return null;

  const MiniBar = ({ value, color, label }: { value: number; color: string; label: string }) => (
    <div className="flex items-center gap-1.5" title={`${value} ${label}`}>
      <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${(value / maxValue) * 100}%`, background: color }} />
      </div>
      <span className={`w-5 text-right text-xs tabular-nums ${value ? 'font-bold' : 'text-muted-foreground'}`}>{value}</span>
    </div>
  );

  return (
    <div className="rounded-xl border bg-card p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold">¿Quién trabajó esta semana?</h2>
        <div className="flex gap-3 text-xs text-muted-foreground">
          <span><span className="text-base font-extrabold text-foreground tabular-nums">{active.length}</span> de {coaches.length} trabajaron</span>
          <span><span className="text-base font-extrabold text-foreground tabular-nums">{both}</span> planificaron y tomaron lista</span>
        </div>
      </div>

      {active.length > 0 && (
        <div className="space-y-0.5">
          <div className="grid grid-cols-[minmax(0,9rem)_1fr_1fr] gap-x-3 px-1 text-[11px] text-muted-foreground">
            <span />
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: SERIES_COLORS.planned }} />Sesiones planificadas</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: SERIES_COLORS.lists }} />Listas tomadas</span>
          </div>
          {active.map((c) => (
            <button
              key={c.staff_id}
              type="button"
              onClick={() => onOpen?.(c.staff_id)}
              disabled={!onOpen}
              className="grid w-full grid-cols-[minmax(0,9rem)_1fr_1fr] items-center gap-x-3 rounded-md px-1 py-1 text-left
                         transition-colors hover:bg-accent disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-sm font-medium" title={c.full_name}>{c.full_name}</span>
              <MiniBar value={c.sessions_planned_week} color={SERIES_COLORS.planned} label="sesiones planificadas" />
              <MiniBar value={c.attendance_sessions_week} color={SERIES_COLORS.lists} label="listas tomadas" />
            </button>
          ))}
        </div>
      )}

      {idle.length > 0 && (
        <div className="border-t pt-2">
          <button
            type="button"
            onClick={() => setShowIdle((v) => !v)}
            aria-expanded={showIdle}
            className="flex w-full items-center gap-2 text-left text-sm"
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
            <span className="font-semibold">{idle.length} sin sesiones ni listas</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {showIdle ? '' : idle.map((c) => shortName(c.full_name)).join(', ')}
            </span>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showIdle ? 'rotate-180' : ''}`} />
          </button>
          {showIdle && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {idle.map((c) => (
                <button
                  key={c.staff_id}
                  type="button"
                  onClick={() => onOpen?.(c.staff_id)}
                  disabled={!onOpen}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-accent
                             disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {c.full_name}
                  {!c.has_account && <span className="text-[10px] text-muted-foreground">· sin cuenta</span>}
                  {c.evaluations_week.entries > 0 && <span className="text-[10px] text-muted-foreground">· solo evaluó</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "¿Cómo le fue las últimas 8 semanas?" — columnas por semana de UN entrenador. */
export function CoachWeeksChart({ weekly, name }: { weekly: CoachWeekPoint[]; name: string }) {
  const data = weekly.map((w) => ({
    label: format(dayToLocalDate(w.week), 'd MMM', { locale: es }),
    planned: w.planned,
    lists: w.lists,
  }));
  const maxValue = Math.max(1, ...data.map((d) => Math.max(d.planned, d.lists)));
  const active = weekly.filter((w) => w.planned > 0 || w.lists > 0).length;
  const summary = active === 0
    ? `${shortName(name)} no registró sesiones ni listas en las últimas ${weekly.length} semanas.`
    : `Trabajó ${active} de las últimas ${weekly.length} semanas.`;

  const topLabel = (props: unknown) => {
    const { x, y, width, value } = props as { x?: number | string; y?: number | string; width?: number | string; value?: number | string };
    if (!Number(value)) return null;
    return (
      <text x={Number(x) + Number(width) / 2} y={Number(y) - 5} textAnchor="middle" fontSize={11} fontWeight={700} fill="hsl(var(--foreground))">
        {value}
      </text>
    );
  };

  return (
    <div className="rounded-xl border bg-card p-3 space-y-2">
      <h3 className="text-sm font-bold">¿Cómo le fue las últimas {weekly.length} semanas?</h3>
      <Legend />
      <div className="h-chart-sm w-full" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: 0, right: 0, top: 18, bottom: 0 }} barGap={1}>
            <XAxis dataKey="label" interval={0} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={{ stroke: 'hsl(var(--border))' }} />
            <YAxis hide domain={[0, maxValue]} allowDecimals={false} />
            <Bar dataKey="planned" fill={SERIES_COLORS.planned} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false}>
              <LabelList dataKey="planned" content={topLabel} />
            </Bar>
            <Bar dataKey="lists" fill={SERIES_COLORS.lists} radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false}>
              <LabelList dataKey="lists" content={topLabel} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-sm font-medium">{summary}</p>
    </div>
  );
}
