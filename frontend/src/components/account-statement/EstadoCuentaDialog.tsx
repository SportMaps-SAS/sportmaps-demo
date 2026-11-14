/**
 * Estado de cuenta de un deportista en un modal, para la escuela.
 *
 * Es la misma pantalla V2 que ve la familia (EstadoCuentaAcudiente) en
 * `modo="escuela"`: solo consulta, sin botones de pagar. Se abre desde las listas
 * del Ciclo de Mes; «Abrir en página completa» lleva a /estado-cuenta.
 * El contenido solo se monta con el modal abierto: no consulta nada mientras tanto.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EstadoCuentaAcudiente } from './EstadoCuentaAcudiente';
import { parametrosEstadoCuenta, type ObjetivoEstadoCuenta } from './estadoCuentaModel';

export interface EstadoCuentaDialogProps {
  schoolId: string | null | undefined;
  objetivo: ObjetivoEstadoCuenta | null;
  onClose: () => void;
  months?: number;
  /** Algo extra al pie (p. ej. «Ver sesiones de octubre»). */
  pie?: ReactNode;
}

export function EstadoCuentaDialog({ schoolId, objetivo, onClose, months = 12, pie }: EstadoCuentaDialogProps) {
  return (
    <Dialog open={!!objetivo} onOpenChange={(abierto) => { if (!abierto) onClose(); }}>
      <DialogContent className="max-w-lg">
        {/* El título visible es el de la pantalla («Sofía debe …»); este es para lectores de pantalla. */}
        <DialogHeader className="sr-only">
          <DialogTitle>Estado de cuenta de {objetivo?.name ?? ''}</DialogTitle>
          <DialogDescription>Cobros mes a mes, con fechas, puntualidad y cómo se pagó.</DialogDescription>
        </DialogHeader>
        {objetivo && (
          <div className="space-y-3">
            <p className="pr-8 text-sm font-medium text-muted-foreground">{objetivo.name}</p>
            <EstadoCuentaAcudiente
              modo="escuela"
              schoolId={schoolId}
              childId={objetivo.child_id ?? undefined}
              userId={objetivo.adult_id ?? undefined}
              unregisteredId={objetivo.unregistered_athlete_id ?? undefined}
              months={months}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
              <Link to={`/estado-cuenta?${parametrosEstadoCuenta(objetivo)}`} className="font-semibold text-primary hover:underline" onClick={onClose}>
                Abrir en página completa
              </Link>
              {pie}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
