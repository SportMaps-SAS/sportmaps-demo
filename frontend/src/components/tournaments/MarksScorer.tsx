/**
 * Anotador de una prueba por marcas (atletismo): una fila por participante, hasta N intentos,
 * estado (DNS/DNF/DQ) y la posición que sale sola con el motor `rankByMark`.
 *
 * Controlado: recibe `entries` y avisa con `onChange`. La persistencia (tabla tournament_marks y
 * endpoints) está especificada en docs/specs/torneos-en-vivo-multideporte-plan.md y aún no existe.
 */
import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { formatMark, parseMark, rankByMark, type EntryStatus, type MarkEntry, type MarkUnit } from '@/lib/tournamentMarks';

const UNIT_HINT: Record<MarkUnit, string> = {
  time: 'Tiempo (ej. 10.52 o 1:02.35)', distance: 'Metros (ej. 6.45)', height: 'Metros (ej. 1.80)', points: 'Puntos',
};
const STATUS: Array<{ v: EntryStatus; label: string }> = [
  { v: 'ok', label: 'Compite' }, { v: 'dns', label: 'No se presentó' }, { v: 'dnf', label: 'No terminó' }, { v: 'dq', label: 'Descalificado' }, { v: 'nm', label: 'Sin marca' },
];

interface Props {
  title: string;
  unit: MarkUnit;
  attempts?: number;
  entries: MarkEntry[];
  onChange: (entries: MarkEntry[]) => void;
  pointsByPosition?: number[];
}

export function MarksScorer({ title, unit, attempts = unit === 'time' ? 1 : 3, entries, onChange, pointsByPosition }: Props) {
  // Texto que escribe la persona (puede estar a medias); la marca se guarda solo si se entiende.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const ranked = useMemo(() => rankByMark(entries, { unit, points_by_position: pointsByPosition }), [entries, unit, pointsByPosition]);
  const byId = Object.fromEntries(ranked.map((r) => [r.participant_id, r]));

  const setMark = (id: string, i: number, text: string) => {
    setDraft((p) => ({ ...p, [`${id}:${i}`]: text }));
    const v = text.trim() === '' || text.trim().toLowerCase() === 'x' ? null : parseMark(text, unit);
    if (text.trim() !== '' && text.trim().toLowerCase() !== 'x' && v == null) return;
    onChange(entries.map((e) => {
      if (e.participant_id !== id) return e;
      const marks = Array.from({ length: attempts }, (_, k) => (k === i ? v : e.marks[k] ?? null));
      return { ...e, marks };
    }));
  };
  const setStatus = (id: string, status: EntryStatus) => onChange(entries.map((e) => (e.participant_id === id ? { ...e, status } : e)));

  return (
    <div className="space-y-2" data-testid="marks-scorer">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">{UNIT_HINT[unit]} · «x» = nulo</span>
      </div>
      {entries.map((e) => {
        const r = byId[e.participant_id];
        return (
          <div key={e.participant_id} className="rounded-xl border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{e.name}</span>
              <span className="text-sm tabular-nums" data-testid={`pos-${e.participant_id}`}>
                {r?.position ? `${r.position}.º${r.tied ? ' (empate)' : ''}` : '—'} · {formatMark(r?.best ?? null, unit)}{r && r.points ? ` · ${r.points} pts` : ''}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-2">
              {Array.from({ length: attempts }, (_, i) => (
                <Input
                  key={i} aria-label={`Intento ${i + 1} de ${e.name}`} inputMode="decimal" className="h-11 text-center"
                  disabled={(e.status ?? 'ok') !== 'ok'}
                  value={draft[`${e.participant_id}:${i}`] ?? (e.marks[i] == null ? '' : formatMark(e.marks[i] as number, unit).replace(' m', ''))}
                  onChange={(ev) => setMark(e.participant_id, i, ev.target.value)}
                />
              ))}
              <select
                aria-label={`Estado de ${e.name}`} className="h-11 rounded-md border bg-background px-2 text-sm"
                value={e.status ?? 'ok'} onChange={(ev) => setStatus(e.participant_id, ev.target.value as EntryStatus)}
              >
                {STATUS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
