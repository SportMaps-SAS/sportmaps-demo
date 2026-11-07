/**
 * «Por asignar»: la inscripción quedó creada, pero confirmarla espera a que
 * estén todos los soportes (SQLSTATE SP001 / SOPORTES_INCOMPLETOS). Muestra lo
 * que falta, deja subirlo ahí mismo y reintenta la confirmación.
 */
import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  esSoportesIncompletos, etiquetaSoporte, tiposFaltantesDeError, type TipoSujetoSoporte,
} from '@/lib/api/soportes';
import { SoportesFicha } from './SoportesFicha';

export interface BloqueoSoportes {
  athleteName: string;
  faltan: string[];
  /** null si no se pudo ubicar la ficha: entonces solo se lista lo que falta. */
  sujeto: { tipo: TipoSujetoSoporte; id: string } | null;
}

/** Arma el bloqueo desde el error de la RPC; null si el error no es de soportes. */
export function bloqueoDesdeError(
  e: unknown,
  athleteName: string,
  sujeto: BloqueoSoportes['sujeto'],
): BloqueoSoportes | null {
  if (!esSoportesIncompletos(e)) return null;
  return { athleteName, faltan: tiposFaltantesDeError(e), sujeto };
}

export function SoportesBloqueoDialog({
  schoolId, info, onClose, onReintentar, onConfirmado,
}: {
  schoolId: string;
  info: BloqueoSoportes;
  onClose: () => void;
  /** Vuelve a confirmar la inscripción (la misma llamada de «Por asignar»). */
  onReintentar: () => Promise<unknown>;
  onConfirmado: () => void;
}) {
  const [faltan, setFaltan] = useState<string[]>(info.faltan);
  const [reintentando, setReintentando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  const reintentar = async () => {
    setReintentando(true);
    setMensaje(null);
    try {
      await onReintentar();
      onConfirmado();
    } catch (e) {
      if (esSoportesIncompletos(e)) {
        setFaltan(tiposFaltantesDeError(e));
        setMensaje('Todavía faltan soportes.');
      } else {
        setMensaje((e as Error)?.message || 'No se pudo confirmar. Intenta de nuevo.');
      }
      setReintentando(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !reintentando && onClose()}>
      <DialogContent className="w-[95vw] max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" aria-hidden /> Falta confirmar a {info.athleteName}
          </DialogTitle>
          <DialogDescription>
            La inscripción ya quedó creada. Solo falta confirmarla, y eso espera a que estén todos los soportes de la ficha.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {faltan.length > 0 && (
            <div role="status" className="rounded-md border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm">
              <p className="font-medium">
                {faltan.length === 1 ? 'Falta 1 soporte:' : `Faltan ${faltan.length} soportes:`}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {faltan.map((t) => <li key={t}>{etiquetaSoporte(t)}</li>)}
              </ul>
            </div>
          )}

          {info.sujeto ? (
            <SoportesFicha
              schoolId={schoolId}
              tipoSujeto={info.sujeto.tipo}
              sujetoId={info.sujeto.id}
              titulo="Subir los soportes"
              onCambio={(r) => setFaltan(r.faltan)}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Súbelos desde la ficha del deportista en Atletas, o pídeselos a la familia por WhatsApp.
            </p>
          )}

          {mensaje && <p role="alert" className="text-sm text-destructive">{mensaje}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose} disabled={reintentando}>Confirmar después</Button>
          <Button onClick={() => void reintentar()} disabled={reintentando}>
            {reintentando && <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />}
            Confirmar ahora
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
