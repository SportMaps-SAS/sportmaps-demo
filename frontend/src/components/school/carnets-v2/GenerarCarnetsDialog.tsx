/**
 * Ventana «Generar carnets» (lienzo DueFlow `car`): equipo + plantilla → genera el
 * carnet a todos los del equipo que no lo tienen. Misma emisión que la masiva de V1
 * (issue_athlete_id_card, uno por deportista).
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  mensajeErrorEmision, objetivosEmision, parametrosEmision, resolverPlantilla, vigenciaPorDefecto,
  type DeportistaCarnet,
} from '@/lib/cards/carnetsV2Model';
import { cargarDeportistas, cargarPlantillasCarnet, type Equipo, type PlantillaCarnet } from './carnetsV2Api';

const TODOS = '__todos__';

export function GenerarCarnetsDialog({
  schoolId, equipos, open, onOpenChange, onListo,
}: {
  schoolId: string;
  equipos: Equipo[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onListo: () => void;
}) {
  const { toast } = useToast();
  const [equipo, setEquipo] = useState<string>(TODOS);
  const [plantilla, setPlantilla] = useState('default');
  const [plantillas, setPlantillas] = useState<PlantillaCarnet[]>([]);
  const [vence, setVence] = useState(vigenciaPorDefecto());
  const [deportistas, setDeportistas] = useState<DeportistaCarnet[] | null>(null);
  const [cargando, setCargando] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [avance, setAvance] = useState<{ hechos: number; total: number } | null>(null);
  const [fallas, setFallas] = useState<Array<{ nombre: string; motivo: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setFallas([]);
    setVence(vigenciaPorDefecto());
    void cargarPlantillasCarnet(schoolId).then(setPlantillas).catch(() => setPlantillas([]));
  }, [open, schoolId]);

  useEffect(() => {
    if (!open) return;
    let cancelado = false;
    setCargando(true);
    setDeportistas(null);
    cargarDeportistas(schoolId, equipo === TODOS ? null : equipo, 'without')
      .then((rows) => { if (!cancelado) setDeportistas(rows); })
      .catch(() => { if (!cancelado) setDeportistas([]); })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [open, schoolId, equipo]);

  const obj = useMemo(() => objetivosEmision(deportistas ?? []), [deportistas]);
  const predeterminada = plantillas.find((p) => p.is_default) ?? null;

  async function generar() {
    if (obj.listos.length === 0) return;
    setGenerando(true);
    setFallas([]);
    const templateId = resolverPlantilla(plantilla, plantillas);
    const errores: Array<{ nombre: string; motivo: string }> = [];
    let ok = 0;
    setAvance({ hechos: 0, total: obj.listos.length });
    for (const a of obj.listos) {
      const { error } = await supabase.rpc('issue_athlete_id_card' as any, parametrosEmision(schoolId, a, templateId, vence));
      if (error) errores.push({ nombre: a.full_name, motivo: mensajeErrorEmision(error) });
      else ok++;
      setAvance({ hechos: ok + errores.length, total: obj.listos.length });
    }
    setGenerando(false);
    setAvance(null);
    setFallas(errores);
    onListo();
    if (errores.length === 0) {
      toast({ title: ok === 1 ? '1 carnet generado' : `${ok} carnets generados`, description: 'A cada familia le llega el aviso.' });
      onOpenChange(false);
    } else {
      toast({ title: `${ok} generados, ${errores.length} sin generar`, description: 'Revisa el detalle en la ventana.', variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!generando) onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generar carnets</DialogTitle>
          <DialogDescription>Para los deportistas que todavía no tienen carnet. A cada familia le llega un aviso.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="gen-equipo">Equipo</Label>
            <Select value={equipo} onValueChange={setEquipo} disabled={generando}>
              <SelectTrigger id="gen-equipo" className="min-h-11"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={TODOS}>Todos los equipos</SelectItem>
                {equipos.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {plantillas.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="gen-plantilla">Plantilla</Label>
              <Select value={plantilla} onValueChange={setPlantilla} disabled={generando}>
                <SelectTrigger id="gen-plantilla" className="min-h-11"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Predeterminada{predeterminada ? ` (${predeterminada.name})` : ''}</SelectItem>
                  {plantillas.filter((p) => !p.is_default).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="gen-vence">Vale hasta</Label>
            <Input id="gen-vence" type="date" className="min-h-11" value={vence} onChange={(e) => setVence(e.target.value)} disabled={generando} />
          </div>

          <div className="rounded-xl bg-muted/60 px-3.5 py-3 text-sm" aria-live="polite">
            {cargando ? (
              <span className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Buscando deportistas…</span>
            ) : obj.listos.length === 0 ? (
              <span className="text-muted-foreground">
                {obj.sinCuenta > 0
                  ? `No hay a quién generarle carnet. ${obj.sinCuenta} sin cuenta: primero invita a su familia.`
                  : 'Todos los deportistas de este equipo ya tienen carnet.'}
              </span>
            ) : (
              <span className="flex flex-col gap-1">
                <b>{obj.listos.length === 1 ? 'Se genera 1 carnet' : `Se generan ${obj.listos.length} carnets`}</b>
                {obj.sinFoto.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {obj.sinFoto.length === 1 ? '1 deportista no tiene foto' : `${obj.sinFoto.length} deportistas no tienen foto`}: su carnet sale con las iniciales.
                  </span>
                )}
                {obj.sinCuenta > 0 && (
                  <span className="text-xs text-muted-foreground">{obj.sinCuenta} sin cuenta quedan por fuera hasta que su familia se registre.</span>
                )}
              </span>
            )}
          </div>

          {fallas.length > 0 && (
            <div role="alert" className="flex flex-col gap-1.5 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-3 text-sm text-destructive">
              <span className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> No se generaron {fallas.length}</span>
              <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
                {fallas.slice(0, 8).map((f, i) => <li key={`${i}-${f.nombre}`}>{f.nombre}: {f.motivo}</li>)}
              </ul>
              {fallas.length > 8 && <span className="text-xs">y {fallas.length - 8} más.</span>}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={generando}>Cancelar</Button>
          <Button onClick={generar} disabled={generando || cargando || obj.listos.length === 0} className="min-h-11 gap-2">
            {generando && <Loader2 className="h-4 w-4 animate-spin" />}
            {generando && avance ? `Generando ${avance.hechos} de ${avance.total}…` : 'Generar carnets'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
