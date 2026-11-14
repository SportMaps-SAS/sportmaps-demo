/**
 * Ítems con los que la escuela califica a sus entrenadores (D3): crear,
 * editar, ordenar y desactivar. Uno desactivado no se borra, para que las
 * evaluaciones viejas sigan leyéndose.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { AUTO_METRIC_OPTIONS, listCriteria, reorderCriteria, saveCriterion, type AutoMetric, type Criterion } from './api';

interface Draft { id: string | null; name: string; description: string; auto_metric: AutoMetric | '' }
const EMPTY: Draft = { id: null, name: '', description: '', auto_metric: '' };
const NONE = '__none__';

export function CriteriaManagerDialog({ schoolId, open, onOpenChange }: { schoolId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);

  const { data: criteria = [], isLoading } = useQuery({
    queryKey: ['coach-eval-criteria', schoolId],
    queryFn: () => listCriteria(schoolId, true),
    enabled: open && !!schoolId,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['coach-eval-criteria', schoolId] });
  const fail = (err: unknown) => toast({ title: 'No se pudo guardar', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });

  const save = useMutation({
    mutationFn: (d: Draft) => saveCriterion(schoolId, { id: d.id, name: d.name, description: d.description, auto_metric: d.auto_metric }),
    onSuccess: () => { refresh(); setDraft(null); },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (c: Criterion) => saveCriterion(schoolId, { ...c, active: !c.active }),
    onSuccess: refresh,
    onError: fail,
  });
  const move = useMutation({
    mutationFn: (ids: string[]) => reorderCriteria(schoolId, ids),
    onSuccess: refresh,
    onError: fail,
  });
  const swap = (i: number, j: number) => {
    const ids = criteria.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    move.mutate(ids);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ítems para calificar entrenadores</DialogTitle>
          <DialogDescription>
            Define qué califica tu escuela. Un ítem puede mostrar al lado un dato de Seguimiento deportivo para apoyarte.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <ol className="space-y-2">
            {criteria.map((c, i) => (
              <li key={c.id} className={`flex items-center gap-2 rounded-lg border p-2 ${c.active ? '' : 'opacity-60'}`}>
                <div className="flex flex-col">
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Subir" disabled={i === 0 || move.isPending} onClick={() => swap(i, i - 1)}>
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label="Bajar" disabled={i === criteria.length - 1 || move.isPending} onClick={() => swap(i, i + 1)}>
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {AUTO_METRIC_OPTIONS.find((o) => o.value === (c.auto_metric ?? ''))?.label}
                    {c.description ? ` · ${c.description}` : ''}
                  </p>
                </div>
                <Switch checked={c.active} onCheckedChange={() => toggle.mutate(c)} aria-label={c.active ? 'Desactivar' : 'Activar'} />
                <Button type="button" variant="ghost" size="icon" aria-label="Editar"
                  onClick={() => setDraft({ id: c.id, name: c.name, description: c.description ?? '', auto_metric: c.auto_metric ?? '' })}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ol>
        )}

        {draft ? (
          <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
            <p className="text-sm font-semibold">{draft.id ? 'Editar ítem' : 'Nuevo ítem'}</p>
            <div className="space-y-1.5">
              <Label htmlFor="crit-name">Nombre</Label>
              <Input id="crit-name" value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="crit-desc">Qué significa hacerlo bien (opcional)</Label>
              <Input id="crit-desc" value={draft.description} maxLength={500} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Dato de Seguimiento deportivo a mostrar</Label>
              <Select value={draft.auto_metric || NONE} onValueChange={(v) => setDraft({ ...draft, auto_metric: v === NONE ? '' : (v as AutoMetric) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AUTO_METRIC_OPTIONS.map((o) => <SelectItem key={o.value || NONE} value={o.value || NONE}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button type="button" disabled={draft.name.trim().length < 2 || save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? 'Guardando…' : 'Guardar ítem'}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => setDraft(EMPTY)} className="w-full">
            <Plus className="mr-1 h-4 w-4" /> Agregar ítem
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
