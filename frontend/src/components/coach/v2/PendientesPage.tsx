/**
 * «Pendientes por enviar» — todo lo que el entrenador hizo sin señal y todavía no llegó:
 * listas de asistencia (cola de siempre) y evaluaciones (bandeja común). Lo rechazado muestra su
 * motivo con «Volver a intentar» / «Descartar» (descartar pide confirmación). Nada se pierde en silencio.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, CloudOff, RotateCcw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { usePendientes } from '@/lib/offline/useBandeja';
import type { PendienteVista } from '@/lib/offline/pendientesModel';
import { EmptyNote } from '@/components/parent/v2/hijos/parts';
import { cn } from '@/lib/utils';

const ESTADO: Record<PendienteVista['estado'], string> = {
  pendiente: 'Esperando señal',
  rechazada: 'El servidor no la aceptó',
  atascada: 'No pudo enviarse',
};

export default function PendientesPage() {
  const { user } = useAuth();
  const { vistas, enLinea, reintentar, descartar } = usePendientes(user?.id);
  const [aDescartar, setADescartar] = useState<PendienteVista | null>(null);

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-3 pb-nav-safe font-poppins md:max-w-page">
      <header className="sticky top-0 z-10 -mx-gutter flex items-center gap-1 border-b bg-background/95 px-2 py-2 backdrop-blur md:mx-0">
        <Link to="/dashboard" aria-label="Volver" className="flex h-touch w-touch items-center justify-center rounded-full hover:bg-muted">
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-lg font-bold">Pendientes por enviar</h1>
          <span className="text-xs text-muted-foreground">
            {enLinea ? 'Con señal: lo pendiente se envía solo.' : 'Sin señal: se envía solo cuando vuelva.'}
          </span>
        </div>
      </header>

      {vistas.length === 0 ? (
        <EmptyNote>Todo lo que hiciste ya llegó. No hay nada pendiente.</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-2">
          {vistas.map((p) => (
            <li
              key={`${p.origen}:${p.id}`}
              className={cn('rounded-2xl border bg-card p-3', p.estado !== 'pendiente' && 'border-amber-500/60')}
              data-testid="pendiente"
            >
              <div className="flex items-start gap-2">
                {p.estado === 'pendiente' && <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{p.clase}</p>
                  <p className="break-words text-base font-medium">{p.etiqueta}</p>
                  <p className="text-sm text-muted-foreground">{ESTADO[p.estado]}</p>
                  {p.error && <p className="mt-1 break-words text-sm text-amber-800 dark:text-amber-300">{p.error}</p>}
                </div>
              </div>
              {p.estado !== 'pendiente' && (
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" className="min-h-touch flex-1" onClick={() => void reintentar(p)}>
                    <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />Volver a intentar
                  </Button>
                  <Button variant="ghost" className="min-h-touch" onClick={() => setADescartar(p)}>Descartar</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <AlertDialog open={!!aDescartar} onOpenChange={(o) => { if (!o) setADescartar(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar esto?</AlertDialogTitle>
            <AlertDialogDescription>
              {aDescartar ? `«${aDescartar.etiqueta}» no se enviará y no se podrá recuperar.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Conservar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (aDescartar) void descartar(aDescartar); setADescartar(null); }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
