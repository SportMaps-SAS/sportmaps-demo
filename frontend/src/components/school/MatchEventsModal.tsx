import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Plus, X, Users, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useFootballEvents, useCreateFootballEvents, useDeleteFootballEvent } from '@/hooks/useFootballData';
import { EVENT_CONFIG } from '@/lib/school/footballDisplay';
import type { FootballEventType, FootballSourceType, NewFootballMatchEvent } from '@/lib/school/footballQueries';

interface MatchEventsModalProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  sourceType: FootballSourceType;
  sourceId: string;
  matchLabel: string;
  /** Jugadores elegibles para el evento -- típicamente los de la alineación de este partido. */
  players: { subject_type: 'profile' | 'child' | 'unregistered'; subject_id: string; full_name: string }[];
}

const EVENT_TYPES: FootballEventType[] = ['goal', 'assist', 'own_goal', 'yellow', 'red'];

export function MatchEventsModal({
  open, onClose, teamId, teamName, sourceType, sourceId, matchLabel, players,
}: MatchEventsModalProps) {
  const { toast } = useToast();
  const { data: existingEvents, isLoading } = useFootballEvents({ source_type: sourceType, source_id: sourceId });
  const createEvents = useCreateFootballEvents();
  const deleteEvent = useDeleteFootballEvent();

  const [staged, setStaged] = useState<NewFootballMatchEvent[]>([]);
  const [draftSubject, setDraftSubject] = useState('');
  const [draftType, setDraftType] = useState<FootballEventType>('goal');
  const [draftMinute, setDraftMinute] = useState<number | ''>('');

  const nameOf = (subjectType: string, subjectId: string) =>
    players.find((p) => p.subject_type === subjectType && p.subject_id === subjectId)?.full_name ?? 'Jugador';

  const handleAddStaged = () => {
    if (!draftSubject) {
      toast({ title: 'Elige un jugador.', variant: 'destructive' });
      return;
    }
    const [subject_type, subject_id] = draftSubject.split(':') as [NewFootballMatchEvent['subject_type'], string];
    setStaged((prev) => [
      ...prev,
      { subject_type, subject_id, type: draftType, minute: draftMinute === '' ? undefined : Number(draftMinute) },
    ]);
    setDraftMinute('');
  };

  const removeStaged = (index: number) => {
    setStaged((prev) => prev.filter((_, i) => i !== index));
  };

  const handleClose = () => {
    setStaged([]);
    setDraftSubject('');
    setDraftMinute('');
    onClose();
  };

  const handleSave = async () => {
    if (staged.length === 0) {
      toast({ title: 'Agrega al menos un evento antes de guardar.', variant: 'destructive' });
      return;
    }
    try {
      await createEvents.mutateAsync({ team_id: teamId, source_type: sourceType, source_id: sourceId, events: staged });
      toast({ title: '✅ Eventos guardados', description: `${staged.length} evento(s) registrado(s).` });
      handleClose();
    } catch (err: any) {
      toast({ title: 'Error al guardar', description: err?.message ?? 'Intenta de nuevo.', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto custom-scrollbar">
        <DialogHeader>
          <DialogTitle>Eventos del partido</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Users className="h-3 w-3" /> {teamName} · {matchLabel}
          </DialogDescription>
        </DialogHeader>

        {players.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-8 w-8 text-amber-500" />
            <p className="text-sm text-muted-foreground max-w-xs">
              Primero armá la alineación de este partido -- los eventos se registran sobre los jugadores convocados.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-primary mr-2" />
                <span className="text-xs text-muted-foreground">Cargando eventos...</span>
              </div>
            ) : (existingEvents?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ya registrados</p>
                {existingEvents!.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className={`gap-1 ${EVENT_CONFIG[e.type].color}`}>
                      {EVENT_CONFIG[e.type].shortLabel}
                    </Badge>
                    <span className="flex-1 truncate">{nameOf(e.subject_type, e.subject_id)}</span>
                    {e.minute !== null && <span className="text-xs text-muted-foreground">{e.minute}'</span>}
                    <button
                      type="button"
                      onClick={() => deleteEvent.mutate(e.id)}
                      disabled={deleteEvent.isPending}
                      className="text-muted-foreground hover:text-red-500"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 border-t pt-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Agregar evento</p>
              <div className="flex flex-col gap-2">
                <Select value={draftSubject} onValueChange={setDraftSubject}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder="Jugador" />
                  </SelectTrigger>
                  <SelectContent>
                    {players.map((p) => (
                      <SelectItem key={`${p.subject_type}:${p.subject_id}`} value={`${p.subject_type}:${p.subject_id}`}>
                        {p.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-2">
                  <Select value={draftType} onValueChange={(v) => setDraftType(v as FootballEventType)}>
                    <SelectTrigger className="h-9 text-sm flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EVENT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{EVENT_CONFIG[t].label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    placeholder="Min."
                    className="h-9 text-sm w-20"
                    min={0}
                    value={draftMinute}
                    onChange={(e) => setDraftMinute(e.target.value === '' ? '' : Number(e.target.value))}
                  />
                  <Button type="button" size="icon" className="h-9 w-9 shrink-0" onClick={handleAddStaged}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>

            {staged.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Por guardar ({staged.length})
                </p>
                {staged.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <Badge variant="outline" className={`gap-1 ${EVENT_CONFIG[e.type].color}`}>
                      {EVENT_CONFIG[e.type].shortLabel}
                    </Badge>
                    <span className="flex-1 truncate">{nameOf(e.subject_type, e.subject_id)}</span>
                    {e.minute !== undefined && <span className="text-xs text-muted-foreground">{e.minute}'</span>}
                    <button type="button" onClick={() => removeStaged(i)} className="text-muted-foreground hover:text-red-500">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="pt-4 border-t">
          <Button variant="outline" onClick={handleClose} disabled={createEvents.isPending}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={createEvents.isPending || staged.length === 0}>
            {createEvents.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Guardando...
              </>
            ) : (
              `Guardar${staged.length > 0 ? ` (${staged.length})` : ''}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
