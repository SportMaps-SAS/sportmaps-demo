/**
 * Ventana «Constancia» (lienzo DueFlow `car`): deportista + tipo → «Generar y enviar».
 * Misma emisión que «Nueva constancia» de V1: emitir_constancia_escuela + PDF en el BFF.
 */
import { useEffect, useState } from 'react';
import { Loader2, Search, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { etiquetaTipo } from '@/lib/constancias';
import { cn } from '@/lib/utils';
import type { DeportistaCarnet } from '@/lib/cards/carnetsV2Model';
import { generarPdfConstancia, type PlantillaConstancia } from './carnetsV2Api';

export function GenerarConstanciaDialog({
  schoolId, plantillas, open, onOpenChange, onListo,
}: {
  schoolId: string;
  plantillas: PlantillaConstancia[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onListo: () => void;
}) {
  const { toast } = useToast();
  const [busqueda, setBusqueda] = useState('');
  const [resultados, setResultados] = useState<DeportistaCarnet[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [elegido, setElegido] = useState<DeportistaCarnet | null>(null);
  const [plantilla, setPlantilla] = useState('');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusqueda('');
    setElegido(null);
    setPlantilla((plantillas.find((p) => p.is_default) ?? plantillas[0])?.id ?? '');
  }, [open, plantillas]);

  useEffect(() => {
    if (!open || elegido) return;
    const q = busqueda.trim();
    const t = setTimeout(async () => {
      setBuscando(true);
      const { data, error } = await supabase.rpc('list_school_athletes_for_card_issue_v2' as any, {
        p_school_id: schoolId, p_search: q || null, p_team_id: null, p_branch_id: null,
        p_card_filter: 'all', p_limit: 20, p_offset: 0,
      });
      setBuscando(false);
      setResultados(error ? [] : (((data as any)?.rows ?? []) as DeportistaCarnet[]));
    }, 300);
    return () => clearTimeout(t);
  }, [busqueda, open, schoolId, elegido]);

  async function enviar() {
    if (!elegido || !plantilla) return;
    setEnviando(true);
    const { data, error } = await supabase.rpc('emitir_constancia_escuela' as any, {
      p_school_id: schoolId,
      p_template_id: plantilla,
      p_child_id: elegido.kind === 'child' ? elegido.athlete_id : null,
      p_profile_id: elegido.kind === 'profile' ? elegido.athlete_id : null,
    });
    if (error) {
      setEnviando(false);
      toast({ title: 'No se pudo generar la constancia', description: 'Revisa que el deportista esté activo e inténtalo de nuevo.', variant: 'destructive' });
      return;
    }
    const cert = data as { id: string; folio: string };
    try {
      const aviso = await generarPdfConstancia(cert.id);
      toast({ title: `Constancia enviada · ${cert.folio}`, description: aviso || 'La familia ya la tiene en su app.' });
    } catch {
      toast({ title: 'Constancia creada, falta el PDF', description: 'Genéralo desde «Ver todas las constancias».', variant: 'destructive' });
    } finally {
      setEnviando(false);
      onOpenChange(false);
      onListo();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!enviando) onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Constancia</DialogTitle>
          <DialogDescription>Sale emitida de una vez, con su PDF, y la familia la ve en su app.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cons-dep">Deportista</Label>
            {elegido ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border px-3 py-2">
                <span className="text-sm">
                  <b>{elegido.full_name}</b>
                  {elegido.team_name && <span className="text-muted-foreground"> · {elegido.team_name}</span>}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setElegido(null)}>Cambiar</Button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search className="absolute left-2.5 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <Input id="cons-dep" className="min-h-11 pl-8" placeholder="Escribe el nombre…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
                </div>
                <div className="max-h-56 divide-y overflow-y-auto rounded-xl border">
                  {buscando ? (
                    <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin" aria-label="Buscando" /></div>
                  ) : resultados.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">Sin resultados.</p>
                  ) : resultados.map((a) => {
                    const sinCuenta = a.kind === 'unregistered';
                    return (
                      <button
                        key={`${a.kind}:${a.athlete_id}`}
                        type="button"
                        disabled={sinCuenta}
                        onClick={() => setElegido(a)}
                        className={cn('flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50', sinCuenta && 'cursor-not-allowed opacity-60')}
                      >
                        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{a.full_name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {sinCuenta ? 'Sin cuenta: primero invita a la familia' : (a.team_name || 'Sin equipo')}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="cons-tipo">Tipo</Label>
            <Select value={plantilla} onValueChange={setPlantilla}>
              <SelectTrigger id="cons-tipo" className="min-h-11"><SelectValue placeholder="Elige el tipo de constancia" /></SelectTrigger>
              <SelectContent>
                {plantillas.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name} · {etiquetaTipo(p.kind)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>Cancelar</Button>
          <Button onClick={enviar} disabled={!elegido || !plantilla || enviando} className="min-h-11 gap-2">
            {enviando && <Loader2 className="h-4 w-4 animate-spin" />}
            Generar y enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
