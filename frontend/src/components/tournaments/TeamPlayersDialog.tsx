import { useCallback, useEffect, useState } from 'react';
import { bffClient } from '@/lib/api/bffClient';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Ban, Printer, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import type { TeamDto } from '@/lib/tournamentTypes';
import { draftToBody, type PlayerDto, type PlayerForm } from '@/lib/tournamentPlayers';
import { printHtml, rosterHtml } from '@/lib/tournamentPrint';
import { RosterImporter } from './RosterImporter';
import { LIVE_BASE } from './FixtureGeneratorDialog';

/** Jugadores de un equipo (interno o externo): subir, corregir, suspender, quitar e imprimir la nómina. */
export function TeamPlayersDialog({ eventId, team, categoryName, tournamentTitle, onClose }: {
  eventId: string; team: TeamDto | null; categoryName: string; tournamentTitle: string; onClose: () => void;
}) {
  const { toast } = useToast();
  const base = `${LIVE_BASE}/school/${eventId}`;
  const [players, setPlayers] = useState<PlayerDto[]>([]);
  const [form, setForm] = useState<PlayerForm>({ required: ['full_name'], custom: [] });
  const [kids, setKids] = useState<Array<{ id: string; full_name: string }> | null>(null);
  const [kidQ, setKidQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!team) return;
    try {
      const [p, f] = await Promise.all([
        bffClient.get<PlayerDto[]>(`${base}/teams/${team.id}/players`),
        bffClient.get<PlayerForm>(`${base}/player-form`),
      ]);
      setPlayers(p); setForm(f);
    } catch (e) { toast({ title: 'No se pudieron cargar los jugadores', description: (e as Error).message, variant: 'destructive' }); }
  }, [base, team, toast]);
  useEffect(() => { setKids(null); setPicked([]); void load(); }, [load]);

  const save = async (drafts: Parameters<React.ComponentProps<typeof RosterImporter>['onSave']>[0]) => {
    await bffClient.post(`${base}/teams/${team!.id}/players`, { players: drafts.map(draftToBody) });
    toast({ title: `${drafts.length} jugador${drafts.length === 1 ? '' : 'es'} guardado${drafts.length === 1 ? '' : 's'}` });
    await load();
  };

  const patch = async (p: PlayerDto, body: Record<string, unknown>) => {
    try { await bffClient.patch(`${base}/players/${p.id}`, body); await load(); }
    catch (e) { toast({ title: 'No se pudo guardar', description: (e as Error).message, variant: 'destructive' }); }
  };

  const remove = async (p: PlayerDto) => {
    if (!window.confirm(`¿Quitar a ${p.full_name}?`)) return;
    try { await bffClient.delete(`${base}/players/${p.id}`); await load(); }
    catch (e) { toast({ title: 'No se pudo quitar', description: (e as Error).message, variant: 'destructive' }); }
  };

  const reissue = async (p: PlayerDto) => {
    if (!window.confirm(`¿Reemitir el carné de ${p.full_name}? El QR anterior deja de servir.`)) return;
    try { await bffClient.post(`${base}/players/${p.id}/reissue-card`, {}); toast({ title: 'Carné reemitido', description: 'Descarga el nuevo en la pestaña Carnés.' }); }
    catch (e) { toast({ title: 'No se pudo reemitir', description: (e as Error).message, variant: 'destructive' }); }
  };

  const suspend = (p: PlayerDto) => {
    if (p.suspended) return patch(p, { suspended: false });
    const reason = window.prompt('Motivo de la suspensión (sale al validar el carné):', '') ?? null;
    if (reason === null) return;
    return patch(p, { suspended: true, suspended_reason: reason });
  };

  const searchKids = async () => {
    try { setKids(await bffClient.get(`${base}/school-athletes${kidQ.trim() ? `?q=${encodeURIComponent(kidQ.trim())}` : ''}`)); }
    catch (e) { toast({ title: 'No se pudieron cargar tus deportistas', description: (e as Error).message, variant: 'destructive' }); }
  };
  const addKids = async () => {
    try {
      const r = await bffClient.post<{ added: number }>(`${base}/teams/${team!.id}/players/from-school`, { child_ids: picked });
      toast({ title: r.added ? `${r.added} deportista${r.added === 1 ? '' : 's'} agregado${r.added === 1 ? '' : 's'}` : 'Ya estaban en el equipo' });
      setPicked([]); setKids(null); await load();
    } catch (e) { toast({ title: 'No se pudieron agregar', description: (e as Error).message, variant: 'destructive' }); }
  };

  const print = () => {
    if (!team) return;
    if (!printHtml(rosterHtml(tournamentTitle, [{ team: team.name, category: categoryName, club: team.club_name, players }]))) {
      toast({ title: 'Permite las ventanas emergentes para imprimir', variant: 'destructive' });
    }
  };

  const readPhoto = (b64: string, mime: string) => bffClient.post<{ players: Array<{ full_name: string }> }>(`${base}/roster-photo`, { image_base64: b64, mime });

  return (
    <Dialog open={!!team} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Jugadores · {team?.name}</DialogTitle>
          <DialogDescription>{categoryName} · Total: {players.length}</DialogDescription>
        </DialogHeader>

        {players.length > 0 && (
          <div className="flex justify-end"><Button size="sm" variant="outline" onClick={print}><Printer className="mr-1 h-4 w-4" /> Imprimir nómina</Button></div>
        )}
        {players.length === 0 ? <p className="text-sm text-muted-foreground">Aún no hay jugadores.</p> : (
          <ul className="divide-y rounded-md border" data-testid="players-list">
            {players.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm">
                <Input className="h-8 w-14" aria-label={`Número de ${p.full_name}`} defaultValue={p.shirt_number ?? ''} inputMode="numeric"
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== String(p.shirt_number ?? '')) void patch(p, { shirt_number: v === '' ? null : Number(v) }); }} />
                <span className="min-w-0 flex-1 truncate">{p.full_name}{p.position ? <span className="text-muted-foreground"> · {p.position}</span> : null}</span>
                {p.suspended && <Badge variant="destructive">Suspendido</Badge>}
                {p.from_school && <Badge variant="outline">De la escuela</Badge>}
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={p.suspended ? `Quitar suspensión a ${p.full_name}` : `Suspender a ${p.full_name}`} onClick={() => suspend(p)}><Ban className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Reemitir carné de ${p.full_name}`} title="Reemitir carné (invalida el QR anterior)" onClick={() => reissue(p)}><RefreshCw className="h-4 w-4" /></Button>
                {!p.from_school && <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Quitar a ${p.full_name}`} onClick={() => remove(p)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">Agregar jugadores</p>
          <RosterImporter form={form} onSave={save} readPhoto={readPhoto} />
        </div>

        {team && !team.is_external && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-sm font-medium">Traer deportistas de tu escuela</p>
            <div className="flex gap-2">
              <Input aria-label="Buscar deportista" placeholder="Buscar por nombre" value={kidQ} onChange={(e) => setKidQ(e.target.value)} />
              <Button variant="outline" onClick={searchKids}><UserPlus className="mr-1 h-4 w-4" /> Buscar</Button>
            </div>
            {kids && (kids.length === 0 ? <p className="text-xs text-muted-foreground">No encontramos deportistas activos.</p> : (
              <div className="max-h-48 space-y-1 overflow-auto rounded border p-2">
                {kids.map((k) => (
                  <label key={k.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={picked.includes(k.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k.id] : p.filter((x) => x !== k.id)))} />
                    {k.full_name}
                  </label>
                ))}
              </div>
            ))}
            {picked.length > 0 && <Button size="sm" onClick={addKids}>Agregar {picked.length}</Button>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
