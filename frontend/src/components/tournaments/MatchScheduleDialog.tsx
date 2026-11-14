import { useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { MatchDto } from '@/lib/tournamentTypes';
import { toColombiaIso, toColombiaLocalInput } from '@/lib/tournamentFormats';
import { LIVE_BASE } from './FixtureGeneratorDialog';

/** Editar a mano la hora y la cancha de un partido. Queda en el registro de cambios del torneo. */
export function MatchScheduleDialog({ eventId, match, courts, onClose, onSaved }: {
  eventId: string; match: MatchDto | null; courts: string[]; onClose: () => void; onSaved: (m: MatchDto) => void;
}) {
  const { toast } = useToast();
  const [when, setWhen] = useState('');
  const [court, setCourt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!match) return;
    setWhen(match.scheduled_at ? toColombiaLocalInput(match.scheduled_at) : '');
    setCourt(match.court ?? '');
    setError(null);
  }, [match]);

  const title = match ? `${match.home_name ?? match.home_label ?? 'Por definir'} vs ${match.away_name ?? match.away_label ?? 'Por definir'}` : '';

  const save = async () => {
    if (!match) return;
    if (court.trim().length > 40) { setError('La cancha puede tener máximo 40 caracteres.'); return; }
    setBusy(true); setError(null);
    try {
      const m = await bffClient.patch<MatchDto>(`${LIVE_BASE}/school/${eventId}/matches/${match.id}/schedule`, {
        scheduled_at: when ? toColombiaIso(when) : null,
        court: court.trim() || null,
      });
      toast({ title: 'Partido actualizado', description: 'La página pública ya muestra la nueva hora y cancha.' });
      onSaved(m);
      onClose();
    } catch (e) {
      setError((e as Error)?.message || 'No se pudo guardar el cambio.');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={!!match} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hora y cancha</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ms-when">Fecha y hora (hora de Colombia)</Label>
            <Input id="ms-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            <p className="text-xs text-muted-foreground">Déjala vacía si aún no tiene hora.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ms-court">Cancha</Label>
            <Input id="ms-court" list="ms-courts" maxLength={40} placeholder="Cancha 1" value={court} onChange={(e) => setCourt(e.target.value)} />
            <datalist id="ms-courts">{courts.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={save} disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
