/**
 * Historial de evaluaciones de un entrenador: barras «¿Cómo le fue en cada
 * período?» (número escrito al lado, sin obligar a leer un eje) y el detalle
 * de cada una. Lo usan la ficha del admin (con editar/borrar) y «Mis
 * evaluaciones» del entrenador (solo lectura, solo publicadas por RLS).
 */
import { useState } from 'react';
import { ChevronDown, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CoachEvaluation } from './api';
import { periodLabel, scoreWord } from './periods';
import { formatCount } from './scoring';

function scoreTone(score: number | null): string {
  if (score === null) return 'bg-muted';
  if (score >= 4) return 'bg-green-500';
  if (score >= 3) return 'bg-amber-500';
  return 'bg-red-500';
}

export function EvaluationHistory({
  evaluations, onEdit, onDelete, emptyText,
}: {
  evaluations: CoachEvaluation[];
  onEdit?: (e: CoachEvaluation) => void;
  onDelete?: (e: CoachEvaluation) => void;
  emptyText: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (evaluations.length === 0) {
    return <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-sm font-semibold">¿Cómo le fue en cada período?</p>
        {evaluations.slice(0, 8).map((e) => (
          <div key={e.id} className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-2 text-xs">
            <span className="truncate text-muted-foreground">{periodLabel(e.period_type, e.period_start)}</span>
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div className={`h-full rounded-full ${scoreTone(e.overall_score)}`} style={{ width: `${((e.overall_score ?? 0) / 5) * 100}%` }} />
            </div>
            <span className="font-bold tabular-nums">{e.overall_score?.toFixed(1) ?? '—'} <span className="font-normal text-muted-foreground">/ 5</span></span>
          </div>
        ))}
      </div>

      <ul className="space-y-2">
        {evaluations.map((e) => {
          const isOpen = openId === e.id;
          return (
            <li key={e.id} className="rounded-lg border">
              <div className="flex items-center gap-2 px-3 py-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(isOpen ? null : e.id)} aria-expanded={isOpen}>
                  <p className="text-sm font-medium">{periodLabel(e.period_type, e.period_start)}</p>
                  <p className="text-xs text-muted-foreground">
                    {e.overall_score == null ? 'Sin ítems con nota' : <>{e.overall_score.toFixed(1)} · {scoreWord(e.overall_score)}</>}
                    {e.coach_evaluation_scores.some((s) => s.not_applicable) && (
                      <> · {formatCount(e.coach_evaluation_scores.filter((s) => !s.not_applicable).length, e.coach_evaluation_scores.length)}</>
                    )}
                  </p>
                </button>
                {onEdit && (
                  <Badge variant={e.status === 'publicada' ? 'default' : 'secondary'} className="shrink-0 text-[10px]">
                    {e.status === 'publicada' ? 'Publicada' : 'Borrador'}
                  </Badge>
                )}
                {onEdit && (
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Editar" onClick={() => onEdit(e)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                {onDelete && (
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="Borrar" onClick={() => onDelete(e)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </div>
              {isOpen && (
                <div className="space-y-3 border-t px-3 py-3 text-sm">
                  <ul className="space-y-1.5">
                    {e.coach_evaluation_scores.map((s) => (
                      <li key={s.criterion_id}>
                        <div className="flex justify-between gap-2">
                          <span>{s.criterion_name}</span>
                          {s.not_applicable
                            ? <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">No aplica</span>
                            : <span className="shrink-0 font-semibold">{s.score} · {scoreWord(s.score)}</span>}
                        </div>
                        {s.comment && <p className="text-xs text-muted-foreground break-words">{s.comment}</p>}
                      </li>
                    ))}
                  </ul>
                  {([
                    ['Fortalezas', e.strengths],
                    ['Aspectos a mejorar', e.improvements],
                    ['Compromisos', e.commitments],
                    ['Otras acotaciones', e.other_notes],
                  ] as const).filter(([, v]) => !!v).map(([label, v]) => (
                    <div key={label}>
                      <p className="text-xs font-semibold">{label}</p>
                      <p className="whitespace-pre-wrap break-words text-muted-foreground">{v}</p>
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
