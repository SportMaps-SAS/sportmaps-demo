/**
 * «Datos que salen en el carnet» (spec §4.1, D8, lienzo DueDatosCarnet): interruptores
 * de `show_fields` de la plantilla predeterminada. Gratis para todas las escuelas.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { CAMPOS_CARNET, alternarCampo, camposVisibles } from '@/lib/cards/carnetsV2Model';
import { cargarPlantillasCarnet, guardarCamposCarnet } from './carnetsV2Api';

const QUIEN_VE: Array<{ t: string; d: string }> = [
  { t: 'Cualquier persona', d: 'Si el carnet es válido, la foto, el nombre y el club. Nunca estos datos.' },
  { t: 'Entrenadores', d: 'Los datos de emergencia que actives (RH, EPS, contacto).' },
  { t: 'Administración del club', d: 'Todo lo que actives.' },
  { t: 'Acudiente y deportista adulto', d: 'Su propio carnet completo.' },
];

export function DatosCarnetDialog({ schoolId, open, onOpenChange }: { schoolId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [plantillaId, setPlantillaId] = useState<string | null>(null);
  const [campos, setCampos] = useState<Record<string, boolean>>(camposVisibles(null));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelado = false;
    setCargando(true);
    setError(null);
    cargarPlantillasCarnet(schoolId)
      .then((ps) => {
        if (cancelado) return;
        const pred = ps.find((p) => p.is_default) ?? null;
        setPlantillaId(pred?.id ?? null);
        setCampos(camposVisibles(pred?.show_fields));
      })
      .catch(() => { if (!cancelado) setError('No pudimos cargar los datos del carnet. Inténtalo de nuevo.'); })
      .finally(() => { if (!cancelado) setCargando(false); });
    return () => { cancelado = true; };
  }, [open, schoolId]);

  async function guardar() {
    setGuardando(true);
    try {
      await guardarCamposCarnet(schoolId, plantillaId, campos);
      toast({ title: 'Listo', description: 'Los carnets muestran los datos que elegiste.' });
      onOpenChange(false);
    } catch {
      toast({ title: 'No se pudo guardar', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Datos que salen en el carnet</DialogTitle>
          <DialogDescription>
            Elige qué datos del deportista salen en el reverso del carnet y al verificarlo. <b className="text-foreground">Nunca se muestran al público.</b>
          </DialogDescription>
        </DialogHeader>

        {cargando ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" /></div>
        ) : error ? (
          <p className="rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">{error}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="overflow-hidden rounded-2xl border">
              {CAMPOS_CARNET.map((c) => {
                const id = `campo-${c.clave}`;
                return (
                  <div key={c.clave} className="flex min-h-[60px] items-center gap-3 border-t px-3.5 py-2 first:border-t-0">
                    <label htmlFor={id} className="flex flex-1 cursor-pointer flex-col gap-0.5">
                      <span className="text-[15px] font-medium">{c.etiqueta}</span>
                      {c.detalle && <span className="text-xs text-muted-foreground">{c.detalle}</span>}
                    </label>
                    <Switch id={id} checked={!!campos[c.clave]} onCheckedChange={(v) => setCampos((a) => alternarCampo(a, c.clave, v))} />
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-[13px] font-semibold text-muted-foreground">Siempre van en el carnet</span>
              <p className="rounded-2xl border px-3.5 py-3 text-sm leading-relaxed text-muted-foreground">
                Nombre, foto o iniciales, número, posición, club, categoría y código del carnet.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="px-1 text-[13px] font-semibold text-muted-foreground">Quién ve qué al escanear</span>
              <div className="overflow-hidden rounded-2xl border">
                {QUIEN_VE.map((w) => (
                  <div key={w.t} className="flex flex-col gap-0.5 border-t px-3.5 py-3 first:border-t-0">
                    <span className="text-sm font-semibold">{w.t}</span>
                    <span className="text-[13px] leading-relaxed text-muted-foreground">{w.d}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-center text-xs text-muted-foreground">Gratis para todas las escuelas: la privacidad no es parte del complemento.</p>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={guardar} disabled={cargando || guardando || !!error} className="min-h-11 gap-2">
            {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
