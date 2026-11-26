/** Sección «Carnets»: cobertura, «Generar carnets» y «Ver emitidos · PDF por equipo». */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { resumenCobertura } from '@/lib/cards/carnetsV2Model';
import { cargarResumenCarnets, type ResumenCarnets } from './carnetsV2Api';
import { GenerarCarnetsDialog } from './GenerarCarnetsDialog';
import { EmitidosDialog } from './EmitidosDialog';
import { SeccionV2 } from './SeccionV2';

export function SeccionCarnets({ schoolId }: { schoolId: string }) {
  const [resumen, setResumen] = useState<ResumenCarnets | null>(null);
  const [error, setError] = useState(false);
  const [generarAbierto, setGenerarAbierto] = useState(false);
  const [emitidosAbierto, setEmitidosAbierto] = useState(false);

  const cargar = useCallback(async () => {
    setError(false);
    try {
      setResumen(await cargarResumenCarnets(schoolId));
    } catch {
      setError(true);
    }
  }, [schoolId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const cob = resumen ? resumenCobertura(resumen) : null;

  return (
    <SeccionV2 titulo="Carnets" id="sec-carnets">
      <div className="flex flex-col gap-2.5 p-3.5">
        {error ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">No pudimos cargar los carnets.</p>
            <Button variant="outline" size="sm" onClick={() => void cargar()} className="self-start">Reintentar</Button>
          </div>
        ) : !resumen || !cob ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando carnets" /></div>
        ) : (
          <>
            <span className="text-base font-semibold">{cob.titulo}</span>
            {resumen.total > 0 && (
              <div
                role="progressbar"
                aria-label="Deportistas con carnet"
                aria-valuenow={cob.pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-2 bg-primary transition-[width]" style={{ width: `${cob.pct}%` }} />
              </div>
            )}
            <span className="text-xs leading-relaxed text-muted-foreground">{cob.detalle}</span>
            <div className="grid grid-cols-2 gap-2">
              <Button className="min-h-12 rounded-xl" onClick={() => setGenerarAbierto(true)} disabled={resumen.total === 0}>
                Generar carnets
              </Button>
              <Button variant="outline" className="min-h-12 rounded-xl" onClick={() => setEmitidosAbierto(true)}>
                Ver emitidos
              </Button>
            </div>
          </>
        )}
      </div>

      {resumen && (
        <>
          <GenerarCarnetsDialog
            schoolId={schoolId}
            equipos={resumen.equipos}
            open={generarAbierto}
            onOpenChange={setGenerarAbierto}
            onListo={() => void cargar()}
          />
          <EmitidosDialog schoolId={schoolId} equipos={resumen.equipos} open={emitidosAbierto} onOpenChange={setEmitidosAbierto} />
        </>
      )}
    </SeccionV2>
  );
}
