/**
 * Botón «Ver en 3D» (M4). Liviano a propósito (vive en el chunk de la
 * pizarra): el diálogo, el visor y three.js llegan con import() solo al tocar
 * el botón. Antes de descargar nada revisa que haya WebGL2; si no, o si el
 * chunk no baja, avisa y se queda en 2D.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { detectWebGL2, FALLBACK_TOAST, minFpsOverride, type Viewer3DSource } from '@/lib/school/tactical3dLaunch';

type ModalProps = { source: Viewer3DSource; onClose: () => void; onFallback: () => void; minFps?: number };

/** Sin conexión el import() falla: en vez de romper la pizarra, vuelve a 2D. */
function ChunkFailed({ onFallback }: ModalProps) {
  useEffect(() => { onFallback(); }, [onFallback]);
  return null;
}
const Tactical3DModal = lazy(() => import('./Tactical3DModal').catch(() => ({ default: ChunkFailed })));

export function Tactical3DLauncher({ getInput, disabled, className, onOpen, minFps, label = 'Ver en 3D', ariaLabel }: {
  /** Lo mismo que arma «Exportar» (TacticalExportInput sirve tal cual). */
  getInput: () => Viewer3DSource;
  disabled?: boolean;
  className?: string;
  onOpen?: () => void;
  /** Piso de fps para caer a 2D (por defecto 20; las pruebas lo cambian). */
  minFps?: number;
  /** Texto del botón (por defecto «Ver en 3D»). */
  label?: string;
  ariaLabel?: string;
}) {
  const { toast } = useToast();
  const [source, setSource] = useState<Viewer3DSource | null>(null);

  const fallbackTo2D = () => {
    setSource(null);
    toast({ title: FALLBACK_TOAST });
  };

  const open = () => {
    if (!detectWebGL2()) { fallbackTo2D(); return; }
    setSource(getInput());
    onOpen?.();
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={open} className={cn('h-11 min-w-11', className)} aria-label={ariaLabel}>
        {label}
      </Button>
      {source && (
        <Suspense fallback={(
          <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950 text-sm text-white" role="status" aria-live="polite">
            <span className="flex flex-col items-center gap-3"><Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-hidden="true" />Cargando la cancha en 3D…</span>
          </div>
        )}>
          <Tactical3DModal source={source} onClose={() => setSource(null)} onFallback={fallbackTo2D} minFps={minFps ?? minFpsOverride()} />
        </Suspense>
      )}
    </>
  );
}
