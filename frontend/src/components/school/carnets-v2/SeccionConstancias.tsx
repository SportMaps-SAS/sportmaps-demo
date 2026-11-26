/**
 * Sección «Constancias»: por aprobar (Emitir / No aprobar, como en
 * SchoolCertificatesAdminPage), «Generar y enviar una constancia» y Plantillas.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { etiquetaTipo } from '@/lib/constancias';
import { quienPidio, tituloPorAprobar } from '@/lib/cards/carnetsV2Model';
import {
  cargarPlantillasConstancia, cargarPorAprobar, generarPdfConstancia,
  type ConstanciaFila, type PlantillaConstancia,
} from './carnetsV2Api';
import { GenerarConstanciaDialog } from './GenerarConstanciaDialog';
import { FilaV2, SeccionV2 } from './SeccionV2';

const VISIBLES = 5;

type Resuelta = 'ok' | 'no';

function cuando(d: string): string {
  const dias = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  return `hace ${dias} días`;
}

export function SeccionConstancias({ schoolId }: { schoolId: string }) {
  const { toast } = useToast();
  const [pendientes, setPendientes] = useState<ConstanciaFila[] | null>(null);
  const [totalPend, setTotalPend] = useState(0);
  const [plantillas, setPlantillas] = useState<PlantillaConstancia[] | null>(null);
  const [error, setError] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [resueltas, setResueltas] = useState<Record<string, Resuelta>>({});
  const [rechazo, setRechazo] = useState<ConstanciaFila | null>(null);
  const [motivo, setMotivo] = useState('');
  const [rechazando, setRechazando] = useState(false);
  const [nuevaAbierta, setNuevaAbierta] = useState(false);

  const cargar = useCallback(async () => {
    setError(false);
    try {
      const [p, t] = await Promise.all([cargarPorAprobar(schoolId), cargarPlantillasConstancia(schoolId)]);
      setPendientes(p.rows);
      setTotalPend(p.total);
      setPlantillas(t);
      setResueltas({});
    } catch {
      setError(true);
    }
  }, [schoolId]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function aprobar(r: ConstanciaFila) {
    setOcupado(r.id);
    const { error: e } = await supabase.rpc('issue_athlete_certificate' as any, { p_certificate_id: r.id });
    if (e) {
      setOcupado(null);
      toast({ title: 'No se pudo emitir', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
      return;
    }
    try {
      const aviso = await generarPdfConstancia(r.id);
      if (aviso) toast({ title: `Constancia emitida · ${r.folio}`, description: aviso });
    } catch {
      toast({ title: 'Emitida, pero sin PDF', description: 'Genéralo desde «Ver todas las constancias».', variant: 'destructive' });
    }
    setResueltas((s) => ({ ...s, [r.id]: 'ok' }));
    setOcupado(null);
  }

  async function confirmarRechazo() {
    if (!rechazo) return;
    setRechazando(true);
    const { error: e } = await supabase.rpc('revoke_athlete_certificate' as any, {
      p_certificate_id: rechazo.id,
      p_reason: motivo.trim() || null,
    });
    setRechazando(false);
    if (e) {
      toast({ title: 'No se pudo', description: 'Inténtalo de nuevo en un momento.', variant: 'destructive' });
      return;
    }
    setResueltas((s) => ({ ...s, [rechazo.id]: 'no' }));
    setRechazo(null);
  }

  const abiertas = (pendientes ?? []).filter((p) => !resueltas[p.id]).length;
  const faltanPorAprobar = Math.max(0, totalPend - Object.keys(resueltas).length);
  const sinPlantillas = plantillas !== null && plantillas.length === 0;

  return (
    <SeccionV2 titulo="Constancias" id="sec-constancias">
      {error ? (
        <div className="flex flex-col gap-2 p-3.5">
          <p className="text-sm text-muted-foreground">No pudimos cargar las constancias.</p>
          <Button variant="outline" size="sm" onClick={() => void cargar()} className="self-start">Reintentar</Button>
        </div>
      ) : pendientes === null ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando constancias" /></div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-3.5 pb-1.5 pt-3.5">
            <span className="flex-1 text-base font-semibold">{tituloPorAprobar(faltanPorAprobar)}</span>
            <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-blue-50 px-2 text-xs font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">
              {abiertas ? 'Pedidas por familias' : 'Al día'}
            </span>
          </div>

          <ul aria-live="polite">
            {pendientes.slice(0, VISIBLES).map((p) => {
              const r = resueltas[p.id];
              return (
                <li key={p.id} className="flex flex-col gap-2 border-t px-3.5 py-2.5">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{p.athlete_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.template_name || etiquetaTipo(p.kind)} · {quienPidio(p)} {cuando(p.created_at)}
                    </span>
                  </span>
                  {!r ? (
                    <span className="flex gap-2">
                      <Button className="min-h-11 flex-1 rounded-xl" onClick={() => aprobar(p)} disabled={ocupado === p.id}>
                        {ocupado === p.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Emitir
                      </Button>
                      <Button variant="outline" className="min-h-11 flex-1 rounded-xl" onClick={() => { setRechazo(p); setMotivo(''); }} disabled={ocupado === p.id}>
                        No aprobar
                      </Button>
                    </span>
                  ) : (
                    <span className={r === 'ok' ? 'text-[13px] font-semibold text-primary' : 'text-[13px] font-semibold text-muted-foreground'}>
                      {r === 'ok' ? 'Emitida · la familia ya la puede descargar' : 'No aprobada · le avisamos a la familia'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {totalPend > VISIBLES && (
            <FilaV2 titulo={`Ver las ${totalPend} por aprobar`} href="/certificates" />
          )}

          {sinPlantillas ? (
            <div className="flex flex-col gap-2 border-t px-3.5 py-3">
              <p className="text-sm"><b>Primero crea una plantilla.</b> Sin plantillas, las familias no pueden pedir constancias y tú no puedes enviarlas.</p>
            </div>
          ) : (
            <FilaV2 titulo="Generar y enviar una constancia" onClick={() => setNuevaAbierta(true)} />
          )}
          <FilaV2
            titulo="Plantillas"
            detalle={plantillas && plantillas.length ? plantillas.slice(0, 2).map((t) => t.name).join(' · ') : 'Crea la primera con un toque'}
            href="/cards/templates/certificates"
          />
          <FilaV2 titulo="Ver todas las constancias" detalle="Emitidas, anuladas y su PDF" href="/certificates" />
        </>
      )}

      <GenerarConstanciaDialog
        schoolId={schoolId}
        plantillas={plantillas ?? []}
        open={nuevaAbierta}
        onOpenChange={setNuevaAbierta}
        onListo={() => void cargar()}
      />

      <Dialog open={!!rechazo} onOpenChange={(o) => { if (!o) setRechazo(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>No aprobar la solicitud</DialogTitle>
            <DialogDescription>
              La solicitud de {rechazo?.athlete_name} se cierra. Le avisamos a la familia con el motivo que escribas.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="motivo-v2">Motivo (opcional)</Label>
            <Textarea id="motivo-v2" value={motivo} maxLength={300} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: el deportista ya no está inscrito" />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRechazo(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmarRechazo} disabled={rechazando} className="gap-2">
              {rechazando && <Loader2 className="h-4 w-4 animate-spin" />}
              No aprobar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SeccionV2>
  );
}
