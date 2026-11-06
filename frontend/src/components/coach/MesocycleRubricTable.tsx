import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useEntitlements } from '@/hooks/useEntitlements';
import { Star, X } from 'lucide-react';
import { summarizeRubric, type RubricCell } from './mesocycleRubricMath';

const INDICATORS = [
  { key: 'tecnica_individual', label: 'Técnica individual' },
  { key: 'toma_decisiones', label: 'Toma de decisiones' },
  { key: 'principios_juego', label: 'Principios de juego' },
  { key: 'condicion_fisica', label: 'Condición física' },
  { key: 'comportamiento_colectivo', label: 'Comportamiento colectivo' },
  { key: 'rendimiento_competitivo', label: 'Rendimiento competitivo' },
] as const;

const CHECKPOINTS = [
  { key: 'inicial', label: 'Inicial' },
  { key: 'semana_2', label: 'Sem. 2' },
  { key: 'semana_3', label: 'Sem. 3' },
  { key: 'semana_4', label: 'Sem. 4' },
  { key: 'final', label: 'Final' },
] as const;

/** metric_key en performance_entries para el modo 'individual' —
 *  prefijadas mesociclo_ para no repetir la colisión de duelos_ganados. */
const METRIC_KEY_BY_INDICATOR: Record<string, string> = {
  tecnica_individual: 'mesociclo_tecnica_individual',
  toma_decisiones: 'mesociclo_toma_decisiones',
  principios_juego: 'mesociclo_principios_juego',
  condicion_fisica: 'mesociclo_condicion_fisica',
  comportamiento_colectivo: 'mesociclo_comportamiento_colectivo',
  rendimiento_competitivo: 'mesociclo_rendimiento_competitivo',
};

interface RosterMember {
  id: string;
  full_name: string;
  athlete_type?: string;
}

interface MesocycleRubricTableProps {
  mesocycleId: string;
  schoolId: string;
  evaluationMode: 'team' | 'individual';
  roster: RosterMember[];
  /** Dueño/administración (spec rediseño §3, "Dueño = MIRAR"): se ven los
   *  valores, sin campos para editarlos. */
  readOnly?: boolean;
}

function subjectTypeFor(member: RosterMember): 'profile' | 'child' | 'unregistered' {
  if (member.athlete_type === 'adult') return 'profile';
  if (member.athlete_type === 'child') return 'child';
  return 'unregistered';
}

const fmt = (n: number) => n.toFixed(1).replace('.', ',');

/** Celda de solo lectura: el valor guardado, «N/A» (decidido) o un guion (pendiente). */
function ScoreValue({ value, na = false }: { value: number | undefined; na?: boolean }) {
  if (na) {
    return <span className="inline-flex h-8 w-16 items-center justify-center rounded-md text-xs italic text-muted-foreground">N/A</span>;
  }
  return (
    <span className={`inline-flex h-8 w-16 items-center justify-center rounded-md tabular-nums ${value != null ? 'font-semibold' : 'text-muted-foreground'}`}>
      {value ?? '—'}
    </span>
  );
}

export function MesocycleRubricTable({ mesocycleId, schoolId, evaluationMode, roster, readOnly = false }: MesocycleRubricTableProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { rubricAllowNa } = useEntitlements();
  const [selectedAthleteId, setSelectedAthleteId] = useState<string>(roster[0]?.id ?? '');

  // Modo 'team': training_mesocycle_evaluations (mesocycle_id, indicator, checkpoint).
  const { data: teamScores } = useQuery({
    queryKey: ['mesocycle-evaluations', mesocycleId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('training_mesocycle_evaluations')
        .select('indicator, checkpoint, score, not_applicable')
        .eq('mesocycle_id', mesocycleId);
      if (error) throw error;
      return data as { indicator: string; checkpoint: string; score: number | null; not_applicable: boolean }[];
    },
    enabled: evaluationMode === 'team' && !!mesocycleId,
  });

  // Modo 'individual': performance_entries con context_type='evaluation', context_id=mesocycleId.
  const selectedMember = roster.find((m) => m.id === selectedAthleteId) || roster[0];
  const { data: individualScores } = useQuery({
    queryKey: ['mesocycle-individual-evaluations', mesocycleId, selectedMember?.id],
    queryFn: async () => {
      if (!selectedMember) return [];
      const { data, error } = await (supabase as any)
        .from('performance_entries')
        .select('metric_key, checkpoint, value, notes, recorded_at')
        .eq('context_type', 'evaluation')
        .eq('context_id', mesocycleId)
        .eq('subject_type', subjectTypeFor(selectedMember))
        .eq('subject_id', selectedMember.id)
        .order('recorded_at', { ascending: true });
      if (error) throw error;
      return data as { metric_key: string; checkpoint: string | null; value: number; notes: string | null; recorded_at: string }[];
    },
    enabled: evaluationMode === 'individual' && !!mesocycleId && !!selectedMember,
  });

  const teamScoreMap = useMemo(() => {
    const m = new Map<string, RubricCell>();
    (teamScores || []).forEach((r) => m.set(`${r.indicator}__${r.checkpoint}`, { score: r.score, na: r.not_applicable === true }));
    return m;
  }, [teamScores]);

  // Promedios solo con el flag: apagado, la tabla es la de siempre.
  const rubricSummary = useMemo(
    () => summarizeRubric(teamScoreMap, INDICATORS.map((i) => i.key), CHECKPOINTS.map((c) => c.key)),
    [teamScoreMap],
  );

  // Cada guardado es una fila NUEVA de performance_entries (nunca un
  // update) -- el historial completo lo sigue mostrando "Evolución"
  // (AthleteEvolutionModal) leyendo la misma tabla sin filtrar por
  // checkpoint. Acá, ordenado ascendente por recorded_at, la fila más
  // reciente de cada (metric_key, checkpoint) pisa a las anteriores en el
  // mapa -- así una corrección posterior del mismo corte se ve sin
  // necesitar un upsert ni una constraint UNIQUE. Filas viejas guardadas
  // ANTES de esta migración (checkpoint aún NULL, cero uso real reportado
  // en el ROADMAP) no entran al mapa -- no había dónde mostrarlas antes,
  // no se pierde nada mostrándolas ahora.
  const individualScoreMap = useMemo(() => {
    const m = new Map<string, { value: number; notes: string | null }>();
    (individualScores || []).forEach((r) => {
      if (!r.checkpoint) return;
      m.set(`${r.metric_key}__${r.checkpoint}`, { value: r.value, notes: r.notes });
    });
    return m;
  }, [individualScores]);

  const saveTeamScore = useMutation({
    mutationFn: async ({ indicator, checkpoint, score }: { indicator: string; checkpoint: string; score: number | null }) => {
      // Siempre se mandan score y not_applicable juntos: un upsert sobre una fila
      // N/A nunca deja score con not_applicable = true (violaría el CHECK).
      const { error } = await (supabase as any).from('training_mesocycle_evaluations').upsert(
        {
          school_id: schoolId,
          mesocycle_id: mesocycleId,
          indicator,
          checkpoint,
          score,
          not_applicable: score === null,
          created_by: user?.id,
        },
        { onConflict: 'mesocycle_id,indicator,checkpoint' },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesocycle-evaluations', mesocycleId] });
    },
    onError: (error: any) => {
      toast({ title: 'Error al guardar', description: error.message, variant: 'destructive' });
    },
  });

  // N/A -> pendiente: se borra la fila de la celda.
  const clearTeamCell = useMutation({
    mutationFn: async ({ indicator, checkpoint }: { indicator: string; checkpoint: string }) => {
      const { error } = await (supabase as any)
        .from('training_mesocycle_evaluations')
        .delete()
        .eq('mesocycle_id', mesocycleId)
        .eq('indicator', indicator)
        .eq('checkpoint', checkpoint);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesocycle-evaluations', mesocycleId] });
    },
    onError: (error: any) => {
      toast({ title: 'Error al guardar', description: error.message, variant: 'destructive' });
    },
  });

  const saveIndividualScore = useMutation({
    mutationFn: async ({ indicator, checkpoint, score }: { indicator: string; checkpoint: string; score: number }) => {
      if (!selectedMember) return;
      const { error } = await (supabase as any).from('performance_entries').insert({
        school_id: schoolId,
        subject_type: subjectTypeFor(selectedMember),
        subject_id: selectedMember.id,
        metric_key: METRIC_KEY_BY_INDICATOR[indicator],
        checkpoint,
        value: score,
        context_type: 'evaluation',
        context_id: mesocycleId,
        recorded_by: user?.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesocycle-individual-evaluations', mesocycleId, selectedMember?.id] });
    },
    onError: (error: any) => {
      toast({ title: 'Error al guardar', description: error.message, variant: 'destructive' });
    },
  });

  return (
    <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-bold flex items-center gap-2">
          <Star className="w-4 h-4 text-primary" />
          Rúbrica del Mesociclo
        </CardTitle>
        <CardDescription>
          {evaluationMode === 'team'
            ? 'Desarrollo del equipo en 6 indicadores, a lo largo de 5 cortes.'
            : 'Desarrollo individual — cada guardado queda en el historial del atleta (botón "Evolución" en el roster).'}
        </CardDescription>
        {evaluationMode === 'individual' && (
          <Select value={selectedAthleteId || selectedMember?.id} onValueChange={setSelectedAthleteId}>
            <SelectTrigger className="w-full sm:w-64 mt-2">
              <SelectValue placeholder="Selecciona un atleta" />
            </SelectTrigger>
            <SelectContent>
              {roster.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {evaluationMode === 'team' && rubricAllowNa && (
          <p className="mb-2 text-xs text-muted-foreground">
            {rubricSummary.overall.average == null
              ? 'Promedio general: sin notas todavía'
              : <>Promedio general <span className="font-semibold text-foreground">{fmt(rubricSummary.overall.average)}</span> · {rubricSummary.overall.applicable} de {rubricSummary.overall.total} con nota</>}
            {rubricSummary.overall.na > 0 && <> · {rubricSummary.overall.na} N/A</>}
            {rubricSummary.overall.pending > 0 && <> · {rubricSummary.overall.pending} pendientes</>}
          </p>
        )}
        {evaluationMode === 'team' ? (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="text-left p-2 font-medium text-muted-foreground">Indicador</th>
                {CHECKPOINTS.map((cp) => (
                  <th key={cp.key} className="p-2 font-medium text-muted-foreground text-center w-20">
                    {cp.label}
                  </th>
                ))}
                {rubricAllowNa && <th className="p-2 font-medium text-muted-foreground text-center w-24">Prom.</th>}
              </tr>
            </thead>
            <tbody>
              {INDICATORS.map((ind) => (
                <tr key={ind.key} className="border-t">
                  <td className="p-2 font-medium">{ind.label}</td>
                  {CHECKPOINTS.map((cp) => {
                    const key = `${ind.key}__${cp.key}`;
                    const cell = teamScoreMap.get(key);
                    return (
                      <td key={cp.key} className="p-1.5 text-center">
                        {readOnly ? <ScoreValue value={cell?.score ?? undefined} na={cell?.na} /> : cell?.na ? (
                          <button
                            type="button"
                            className="mx-auto inline-flex h-8 w-16 items-center justify-center gap-1 rounded-md bg-muted text-xs italic text-muted-foreground hover:bg-accent"
                            aria-label={`Quitar «No aplica» de ${ind.label}, ${cp.label}`}
                            onClick={() => clearTeamCell.mutate({ indicator: ind.key, checkpoint: cp.key })}
                          >
                            N/A <X className="h-3 w-3" />
                          </button>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <Input
                              type="number"
                              min={1}
                              max={10}
                              className="h-8 w-16 text-center"
                              defaultValue={cell?.score ?? ''}
                              onBlur={(e) => {
                                const val = Number(e.target.value);
                                if (val >= 1 && val <= 10) {
                                  saveTeamScore.mutate({ indicator: ind.key, checkpoint: cp.key, score: val });
                                }
                              }}
                            />
                            {rubricAllowNa && (
                              <button
                                type="button"
                                className="h-8 rounded-md border px-1.5 text-[10px] text-muted-foreground hover:bg-accent"
                                aria-label={`Marcar «No aplica» en ${ind.label}, ${cp.label}`}
                                onClick={() => saveTeamScore.mutate({ indicator: ind.key, checkpoint: cp.key, score: null })}
                              >
                                N/A
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                  {rubricAllowNa && (() => {
                    const s = rubricSummary.byIndicator[ind.key];
                    return (
                      <td className="p-1.5 text-center text-xs tabular-nums">
                        {s.average == null ? '—' : <><span className="font-semibold">{fmt(s.average)}</span> <span className="text-muted-foreground">· {s.applicable} de {s.total}</span></>}
                      </td>
                    );
                  })()}
                </tr>
              ))}
            </tbody>
          </table>
        ) : selectedMember ? (
          // key={selectedMember.id}: los <Input> de acá son no controlados
          // (defaultValue), y ni <tr>/<td> cambian de key al cambiar de
          // atleta -- sin este key en la tabla, React reutiliza los mismos
          // nodos del DOM y defaultValue nunca se vuelve a aplicar. Cambiar
          // de atleta en el selector se veía siempre con los valores del
          // atleta anterior.
          <table key={selectedMember.id} className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className="text-left p-2 font-medium text-muted-foreground">Indicador</th>
                {CHECKPOINTS.map((cp) => (
                  <th key={cp.key} className="p-2 font-medium text-muted-foreground text-center w-20">
                    {cp.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {INDICATORS.map((ind) => {
                const metricKey = METRIC_KEY_BY_INDICATOR[ind.key];
                return (
                  <tr key={ind.key} className="border-t">
                    <td className="p-2 font-medium">{ind.label}</td>
                    {CHECKPOINTS.map((cp) => {
                      const current = individualScoreMap.get(`${metricKey}__${cp.key}`);
                      return (
                        <td key={cp.key} className="p-1.5 text-center">
                          {readOnly ? <ScoreValue value={current?.value} /> : <Input
                            type="number"
                            min={1}
                            max={10}
                            className="h-8 w-16 text-center mx-auto"
                            defaultValue={current?.value ?? ''}
                            onBlur={(e) => {
                              const val = Number(e.target.value);
                              if (val >= 1 && val <= 10) {
                                saveIndividualScore.mutate({ indicator: ind.key, checkpoint: cp.key, score: val });
                              }
                            }}
                          />}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">Sin deportistas en el roster.</p>
        )}
      </CardContent>
    </Card>
  );
}
