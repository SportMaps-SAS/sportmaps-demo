/**
 * Calificar a un entrenador en un período (spec evaluacion-de-entrenadores §4.2).
 * Cada ítem de la escuela con su dato de Seguimiento deportivo al lado, nota
 * 1-5 en palabras y comentario; abajo fortalezas, a mejorar, compromisos y
 * otras acotaciones. Guarda en una sola RPC transaccional.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, AlertTriangle, BarChart3, Mail } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useEntitlements } from '@/hooks/useEntitlements';
import { todayColombia } from '@/lib/dateUtils';
import {
  autoMetricText, getCoachPeriodSummary, listCriteria, listEvaluations, saveEvaluation,
  type CoachEvaluation,
} from './api';
import { buildScoresPayload, canPublish, formatCount, naMajority, summarizeScores } from './scoring';
import {
  PERIOD_TYPES, SCORE_LABELS, lastClosedPeriod, periodEnd, periodLabel, periodStartOf, shiftPeriod,
  type PeriodType,
} from './periods';

export interface EvaluationTarget {
  staffId: string;
  fullName: string;
  hasAccount: boolean;
  /** Evaluación a editar; sin ella se abre en el último período cerrado. */
  evaluation?: CoachEvaluation | null;
}

interface Props {
  schoolId: string;
  target: EvaluationTarget | null;
  onClose: () => void;
}

type ScoreState = Record<string, { score?: number; na?: boolean; comment: string }>;

export function CoachEvaluationDialog({ schoolId, target, onClose }: Props) {
  const { toast } = useToast();
  const { rubricAllowNa } = useEntitlements();
  const qc = useQueryClient();
  const today = todayColombia();
  const [periodType, setPeriodType] = useState<PeriodType>('mensual');
  const [periodStart, setPeriodStart] = useState(() => lastClosedPeriod('mensual', today));
  const [scores, setScores] = useState<ScoreState>({});
  const [texts, setTexts] = useState({ strengths: '', improvements: '', commitments: '', otherNotes: '' });

  const open = !!target;
  const staffId = target?.staffId ?? '';
  const to = periodEnd(periodType, periodStart);

  // Al abrir: período de la evaluación a editar, o el último cerrado.
  useEffect(() => {
    if (!target) return;
    const ev = target.evaluation;
    if (ev) {
      setPeriodType(ev.period_type);
      setPeriodStart(ev.period_start);
    } else {
      setPeriodType('mensual');
      setPeriodStart(lastClosedPeriod('mensual', today));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const criteriaQ = useQuery({
    queryKey: ['coach-eval-criteria', schoolId],
    queryFn: () => listCriteria(schoolId, true),
    enabled: open && !!schoolId,
  });
  const evaluationsQ = useQuery({
    queryKey: ['coach-evaluations', staffId],
    queryFn: () => listEvaluations([staffId]),
    enabled: open && !!staffId,
  });
  const summaryQ = useQuery({
    queryKey: ['coach-eval-summary', staffId, periodStart, to],
    queryFn: () => getCoachPeriodSummary(staffId, periodStart, to),
    enabled: open && !!staffId,
    staleTime: 60 * 1000,
  });

  const existing = useMemo(
    () => evaluationsQ.data?.find((e) => e.period_type === periodType && e.period_start === periodStart) ?? null,
    [evaluationsQ.data, periodType, periodStart],
  );

  // Cargar lo ya guardado del período (o vaciar si no hay).
  useEffect(() => {
    if (!open) return;
    const next: ScoreState = {};
    for (const s of existing?.coach_evaluation_scores ?? []) next[s.criterion_id] = { score: s.score ?? undefined, na: s.not_applicable, comment: s.comment ?? '' };
    setScores(next);
    setTexts({
      strengths: existing?.strengths ?? '',
      improvements: existing?.improvements ?? '',
      commitments: existing?.commitments ?? '',
      otherNotes: existing?.other_notes ?? '',
    });
  }, [open, existing]);

  // Ítems activos + los inactivos que ya tienen nota en esta evaluación.
  const criteria = (criteriaQ.data ?? []).filter((c) => c.active || scores[c.id]?.score || scores[c.id]?.na);
  // Con la opción apagada un N/A ya guardado cuenta como sin responder (la RPC lo rechazaría).
  const effective = (id: string) => {
    const st = scores[id];
    return st && st.na && !rubricAllowNa ? { ...st, na: false } : st;
  };
  const sum = summarizeScores(criteria.map((c) => effective(c.id)));
  const average = sum.average;
  const staleNa = !rubricAllowNa && criteria.some((c) => scores[c.id]?.na);

  const save = useMutation({
    mutationFn: (publish: boolean) => saveEvaluation({
      staffId,
      periodType,
      periodStart,
      scores: buildScoresPayload(criteria.map((c) => ({ id: c.id, state: effective(c.id) })), { allowNa: rubricAllowNa }),
      ...texts,
      // Lo que el admin tiene delante queda congelado con la nota.
      snapshot: summaryQ.data ?? existing?.activity_snapshot ?? null,
      publish,
    }),
    onSuccess: (_id, publish) => {
      qc.invalidateQueries({ queryKey: ['coach-evaluations'] });
      const yaPublicada = existing?.status === 'publicada';
      toast(publish
        ? {
            title: yaPublicada ? 'Evaluación actualizada' : 'Evaluación publicada',
            description: yaPublicada
              ? `Se actualizó la evaluación de ${target?.fullName}.`
              : target?.hasAccount
                ? `${target?.fullName} la verá en «Mis evaluaciones» y le llegó un aviso.`
                : `${target?.fullName} todavía no entra a SportMaps: la verá cuando ingrese.`,
          }
        : { title: 'Borrador guardado', description: 'Solo la administración la ve.' });
      onClose();
    },
    onError: (err: unknown) => toast({
      title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive',
    }),
  });

  const changeType = (t: PeriodType) => {
    setPeriodType(t);
    setPeriodStart(lastClosedPeriod(t, today));
  };
  const canGoNext = shiftPeriod(periodType, periodStart, 1) <= periodStartOf(periodType, today);
  const summary = summaryQ.data;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[92vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b shrink-0 text-left">
          <DialogTitle>Calificar a {target?.fullName}</DialogTitle>
          <DialogDescription>
            Con lo que hizo en el período según Seguimiento deportivo. Solo el dueño y la administración califican.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
          {/* Período */}
          <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-2">
            <Select value={periodType} onValueChange={(v) => changeType(v as PeriodType)}>
              <SelectTrigger aria-label="Tipo de período"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIOD_TYPES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex items-center justify-between gap-2 rounded-md border px-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Período anterior"
                onClick={() => setPeriodStart(shiftPeriod(periodType, periodStart, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="text-center">
                <p className="text-sm font-semibold">{periodLabel(periodType, periodStart)}</p>
                {existing && (
                  <p className="text-[11px] text-muted-foreground">
                    Ya calificado · {existing.status === 'publicada' ? 'publicada' : 'borrador'}
                  </p>
                )}
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Período siguiente" disabled={!canGoNext}
                onClick={() => setPeriodStart(shiftPeriod(periodType, periodStart, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* D9: sin cuenta no hay datos — recomendar que ingrese. */}
          {target && !target.hasAccount && (
            <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="space-y-1">
                <p className="font-medium">{target.fullName} todavía no entra a SportMaps.</p>
                <p className="text-muted-foreground">
                  Sin cuenta no hay sesiones, listas ni evaluaciones a su nombre, así que los datos del período salen en cero.
                  Recomiéndale ingresar: así la próxima calificación se apoya en lo que realmente hizo.
                </p>
                <Link to="/invitations" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                  <Mail className="h-3.5 w-3.5" /> Reenviar su invitación
                </Link>
              </div>
            </div>
          )}

          {/* Resumen del período */}
          {summary && (
            <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <BarChart3 className="h-3.5 w-3.5" /> En el período
              </span>
              <span>{summary.sesiones_planificadas.planned} sesiones planificadas</span>
              <span>{summary.listas_tomadas.lists} listas</span>
              <span>{summary.evaluaciones.athletes} deportistas evaluados</span>
              {summary.teams.length > 0 && <span>Equipos: {summary.teams.join(', ')}</span>}
              {summary.cutoff < summary.to && <span>Medido hasta hoy: el período no ha terminado.</span>}
            </div>
          )}

          {/* Ítems */}
          {criteriaQ.isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : criteriaQ.isError ? (
            <p className="text-sm text-destructive">No se pudieron cargar los ítems para calificar.</p>
          ) : (
            <ol className="space-y-3">
              {criteria.map((c, i) => {
                const st = scores[c.id] ?? { comment: '' };
                const auto = autoMetricText(c.auto_metric, summary);
                return (
                  <li key={c.id} className="rounded-xl border p-3 space-y-2">
                    <div>
                      <p className="text-sm font-semibold">{i + 1}. {c.name}{!c.active && <span className="ml-1 text-xs font-normal text-muted-foreground">(ítem desactivado)</span>}</p>
                      {c.description && <p className="text-xs text-muted-foreground">{c.description}</p>}
                      {c.auto_metric && (
                        <p className="mt-1 text-xs font-medium text-primary">
                          {summaryQ.isLoading ? 'Calculando…' : auto ?? 'Sin datos'}
                        </p>
                      )}
                    </div>
                    <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={`Nota de ${c.name}`}>
                      {[1, 2, 3, 4, 5].map((n) => {
                        const active = st.score === n;
                        return (
                          <button
                            key={n}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => setScores((p) => ({ ...p, [c.id]: { ...st, na: false, score: active ? undefined : n } }))}
                            className={`rounded-lg border px-1 py-1.5 text-center transition-colors ${active
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'hover:bg-accent'}`}
                          >
                            <span className="block text-sm font-bold">{n}</span>
                            <span className="block text-[10px] leading-tight">{SCORE_LABELS[n]}</span>
                          </button>
                        );
                      })}
                    </div>
                    {rubricAllowNa && (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!!st.na}
                        onClick={() => setScores((p) => ({ ...p, [c.id]: { ...st, score: undefined, na: !st.na } }))}
                        className={`w-full rounded-lg border px-2 py-1.5 text-center text-xs transition-colors ${st.na
                          ? 'border-muted-foreground/50 bg-muted font-semibold text-foreground'
                          : 'text-muted-foreground hover:bg-accent'}`}
                      >
                        No aplica
                      </button>
                    )}
                    <Input
                      placeholder="Comentario (opcional)"
                      value={st.comment}
                      onChange={(e) => setScores((p) => ({ ...p, [c.id]: { ...st, comment: e.target.value } }))}
                    />
                  </li>
                );
              })}
            </ol>
          )}

          {staleNa && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Esta evaluación tenía «No aplica» y la opción está apagada; elige una nota para esos ítems.
            </p>
          )}
          {rubricAllowNa && naMajority(sum) && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Marcaste {sum.na} de {sum.total} como «No aplica»; ¿seguro?
            </p>
          )}

          {/* Textos generales */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {([
              ['strengths', 'Fortalezas'],
              ['improvements', 'Aspectos a mejorar'],
              ['commitments', 'Compromisos para el próximo período'],
              ['otherNotes', 'Otras acotaciones'],
            ] as const).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`ce-${key}`}>{label}</Label>
                <Textarea
                  id={`ce-${key}`}
                  rows={3}
                  value={texts[key]}
                  onChange={(e) => setTexts((t) => ({ ...t, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background flex-col-reverse sm:flex-row sm:items-center gap-2">
          <p className="text-sm text-muted-foreground sm:mr-auto">
            {average === null
              ? (sum.na > 0 && sum.applicable === 0
                ? 'Todo en «No aplica»: puedes guardarlo como borrador, no publicarlo.'
                : 'Califica al menos un ítem.')
              : <>Promedio: <span className="font-bold text-foreground">{average.toFixed(1)}</span> · {SCORE_LABELS[Math.round(average)]}
                {sum.na > 0 && <> · {formatCount(sum.applicable, sum.total)} · {sum.na} no aplica</>}</>}
          </p>
          <Button type="button" variant="outline" onClick={() => save.mutate(false)} disabled={save.isPending || sum.answered === 0}>
            Guardar borrador
          </Button>
          <Button type="button" onClick={() => save.mutate(true)} disabled={save.isPending || !canPublish(sum)}>
            {save.isPending ? 'Guardando…' : existing?.status === 'publicada' ? 'Actualizar publicada' : 'Publicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
