import { useEffect, useMemo, useState } from 'react';
import { Loader2, CalendarX } from 'lucide-react';
import { apiRequest, publicUrl, ReservaApiError } from './reservasApi';
import {
  dayChipParts,
  durationOptions,
  formatCOP,
  formatDayLong,
  formatDuration,
  formatHM,
  rangeFromToday,
  type AvailFacility,
  type Slot,
} from './reservarLogic';

interface AvailabilityParams {
  schoolId: string | undefined;
  facilityId: string | undefined;
  durationMin: number | null;
  days?: number;
  /** Cambia para forzar una recarga (p. ej. tras un 409). */
  refreshKey?: number;
}

export function useAvailability({ schoolId, facilityId, durationMin, days = 14, refreshKey = 0 }: AvailabilityParams) {
  const [data, setData] = useState<AvailFacility[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; pending: boolean } | null>(null);

  useEffect(() => {
    if (!schoolId || !facilityId) return;
    const ctrl = new AbortController();
    const { from, to } = rangeFromToday(days);
    const qs = new URLSearchParams({ school_id: schoolId, from, to, facility_id: facilityId });
    if (durationMin) qs.set('duration_min', String(durationMin));
    setLoading(true);
    setError(null);
    apiRequest<{ facilities?: AvailFacility[] }>(publicUrl(`/availability?${qs}`), { signal: ctrl.signal })
      .then((r) => setData(r.facilities ?? []))
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') return;
        setData([]);
        if (e instanceof ReservaApiError) setError({ message: e.view.message, pending: e.view.pending });
        else setError({ message: 'No pudimos cargar los horarios.', pending: false });
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [schoolId, facilityId, durationMin, days, refreshKey]);

  return { facility: data[0] ?? null, loading, error };
}

interface Props {
  facility: AvailFacility | null;
  loading: boolean;
  error: { message: string; pending: boolean } | null;
  selected: Slot | null;
  onSelect: (s: Slot) => void;
  duration: number | null;
  onDurationChange?: (min: number) => void;
  /** Si se pasa, solo se muestra esa duración (reprogramar). */
  lockedDuration?: number;
}

export default function SlotPicker({ facility, loading, error, selected, onSelect, duration, onDurationChange, lockedDuration }: Props) {
  const days = useMemo(() => facility?.days ?? [], [facility]);
  const [day, setDay] = useState<string | null>(null);

  // Mantener un día válido seleccionado.
  useEffect(() => {
    if (!days.length) {
      setDay(null);
      return;
    }
    setDay((cur) => (cur && days.some((d) => d.date === cur) ? cur : days[0].date));
  }, [days]);

  const current = useMemo(() => days.find((d) => d.date === day) ?? null, [days, day]);
  const durations = useMemo(
    () => (facility ? durationOptions(facility.min_duration_min, facility.slot_step_min) : []),
    [facility],
  );

  return (
    <div className="space-y-4">
      {!lockedDuration && onDurationChange && durations.length > 1 && (
        <fieldset>
          <legend className="text-xs font-semibold text-muted-foreground mb-2">Duración</legend>
          <div className="flex flex-wrap gap-2">
            {durations.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={duration === d}
                onClick={() => onDurationChange(d)}
                className={`px-3 h-10 rounded-full border text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  duration === d ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40'
                }`}
              >
                {formatDuration(d)}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {lockedDuration ? (
        <p className="text-xs text-muted-foreground">Duración: {formatDuration(lockedDuration)} (la misma de tu reserva)</p>
      ) : null}

      {loading ? (
        <div className="py-10 text-center" role="status" aria-live="polite">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" aria-hidden />
          <span className="sr-only">Cargando horarios</span>
        </div>
      ) : error ? (
        <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm text-center" role="alert">
          {error.pending ? 'Los horarios en línea estarán disponibles pronto.' : error.message}
        </div>
      ) : days.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          <CalendarX className="h-10 w-10 mx-auto mb-2 opacity-40" aria-hidden />
          <p className="text-sm">No hay horarios libres en los próximos 14 días.</p>
        </div>
      ) : (
        <>
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1" role="group" aria-label="Día">
            {days.map((d) => {
              const c = dayChipParts(d.date);
              return (
                <button
                  key={d.date}
                  type="button"
                  aria-pressed={day === d.date}
                  aria-label={`${formatDayLong(d.date)}${d.is_holiday ? ', festivo' : ''}`}
                  onClick={() => setDay(d.date)}
                  className={`shrink-0 min-w-[3.75rem] flex flex-col items-center px-3 py-2 rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    day === d.date ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <span className="text-[10px] uppercase font-bold opacity-80">{c.dow}</span>
                  <span className="text-base font-bold leading-tight">{c.day}</span>
                  <span className="text-[10px] opacity-80">{c.month}</span>
                  {d.is_holiday && <span className="text-[9px] font-semibold mt-0.5">Festivo</span>}
                </button>
              );
            })}
          </div>

          {current && (
            <div>
              <p className="text-sm font-semibold capitalize mb-2">{formatDayLong(current.date)}</p>
              <div className="grid grid-cols-2 gap-2">
                {current.slots.map((s) => {
                  const isSel = selected?.starts_at === s.starts_at && selected?.ends_at === s.ends_at;
                  return (
                    <button
                      key={s.starts_at}
                      type="button"
                      aria-pressed={isSel}
                      onClick={() => onSelect(s)}
                      className={`flex flex-col items-start p-3 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                        isSel ? 'bg-primary/10 border-primary' : 'border-border hover:border-primary/40 hover:bg-primary/5'
                      }`}
                    >
                      <span className="text-sm font-semibold">{formatHM(s.start_local)} – {formatHM(s.end_local)}</span>
                      <span className="text-xs text-muted-foreground">{formatCOP(s.price)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
