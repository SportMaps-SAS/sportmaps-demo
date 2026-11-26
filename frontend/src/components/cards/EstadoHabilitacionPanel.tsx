/**
 * Semáforo de habilitación al escanear (carnet 3D F5, spec §8) — vista del personal, del
 * acudiente y del deportista adulto en /c/:token.
 *
 * - Coach: semáforo grande + motivo en una línea (sin montos) + datos de emergencia que la
 *   escuela encendió.
 * - Admin del club, acudiente y deportista adulto: además cada criterio con su estado y fecha,
 *   y «Cargar documento» (seguro, certificado, autorización).
 * - Público: nada (la RPC no le responde).
 *
 * D7: este estado NUNCA se pinta en el carnet ni en sus exportaciones; vive solo aquí.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, HeartPulse, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { EstadoHabilitacionPanelProps } from '@/lib/cards/contratos';
import type { EstadoCriterio, Semaforo } from '@/lib/cards/habilitacion';
import { claveEstadoHabilitacion, useEstadoHabilitacion } from '@/hooks/useEstadoHabilitacion';
import { CargarDocumentoVigencia } from './CargarDocumentoVigencia';

const ESTILO: Record<Semaforo, { caja: string; luz: string; Icono: typeof CheckCircle2 }> = {
  verde: { caja: 'border-emerald-200 bg-emerald-50 text-emerald-900', luz: 'bg-emerald-500', Icono: CheckCircle2 },
  amarillo: { caja: 'border-amber-200 bg-amber-50 text-amber-900', luz: 'bg-amber-400', Icono: AlertTriangle },
  rojo: { caja: 'border-red-200 bg-red-50 text-red-900', luz: 'bg-red-500', Icono: XCircle },
};

const PUNTO: Record<EstadoCriterio, string> = {
  verde: 'bg-emerald-500',
  amarillo: 'bg-amber-400',
  rojo: 'bg-red-500',
  no_aplica: 'bg-muted-foreground/40',
};

export function EstadoHabilitacionPanel({ qrToken, eventId }: EstadoHabilitacionPanelProps) {
  const [evento, setEvento] = useState<string | null>(eventId ?? null);
  const [cargando, setCargando] = useState(false);
  const queryClient = useQueryClient();
  const q = useEstadoHabilitacion(qrToken, evento);

  useEffect(() => { setEvento(eventId ?? null); }, [eventId]);

  if (q.isLoading) {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Revisando si puede entrar…
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-card p-4 space-y-2 text-sm">
        <p className="text-red-700">No se pudo revisar el estado. Revisa la conexión.</p>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => q.refetch()}>
          <RefreshCw className="h-3.5 w-3.5" /> Reintentar
        </Button>
      </div>
    );
  }

  const v = q.data;
  if (!v || v.tipo === 'sin_acceso') return null;

  if (v.tipo === 'evento_no_valido') {
    return (
      <div className="w-full max-w-sm rounded-xl border bg-card p-4 space-y-2 text-sm">
        <p>Ese evento no es de esta escuela.</p>
        <Button variant="outline" size="sm" onClick={() => setEvento(null)}>Verificar sin evento</Button>
      </div>
    );
  }

  const estilo = ESTILO[v.semaforo];
  const sujeto = v.sujeto;

  return (
    <section className="w-full max-w-sm space-y-3" data-testid="estado-habilitacion" aria-live="polite">
      <div className={cn('rounded-xl border p-4 flex items-center gap-4', estilo.caja)}>
        <span className={cn('h-14 w-14 shrink-0 rounded-full flex items-center justify-center text-white shadow-inner', estilo.luz)}>
          <estilo.Icono className="h-8 w-8" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-lg font-bold leading-tight" data-testid="semaforo" data-semaforo={v.semaforo}>{v.titulo}</p>
          <p className="text-sm leading-snug" data-testid="motivo">{v.motivo}</p>
        </div>
      </div>

      {v.eventos.length > 0 && (
        <div className="rounded-xl border bg-card p-3 space-y-1.5">
          <Label htmlFor="habil-evento" className="text-xs text-muted-foreground">Verificar para</Label>
          <select
            id="habil-evento"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={evento ?? ''}
            onChange={(e) => setEvento(e.target.value || null)}
          >
            <option value="">Su categoría (entrenamiento)</option>
            {v.eventos.map((ev) => <option key={ev.id} value={ev.id}>{ev.titulo}</option>)}
          </select>
        </div>
      )}

      {v.emergencia.length > 0 && (
        <div className="rounded-xl border bg-card p-3 text-sm">
          <p className="mb-1.5 flex items-center gap-1.5 font-semibold text-foreground">
            <HeartPulse className="h-4 w-4 text-red-500" aria-hidden /> Datos de emergencia
          </p>
          <dl className="space-y-1">
            {v.emergencia.map((f) => (
              <div key={f.etiqueta} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{f.etiqueta}</dt>
                <dd className="text-right font-medium break-words">{f.valor}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {v.conDetalle && v.criterios.length > 0 && (
        <ul className="rounded-xl border bg-card divide-y text-sm" data-testid="criterios">
          {v.criterios.map((c) => (
            <li key={c.clave} className="flex items-start gap-3 p-3">
              <span className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', PUNTO[c.estado])} aria-hidden />
              <div className="min-w-0">
                <p className="font-medium">{c.etiqueta}</p>
                {c.detalle && <p className="text-muted-foreground">{c.detalle}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {v.conDetalle && sujeto && (
        <div className="rounded-xl border bg-card p-3 space-y-3">
          <button
            type="button"
            className="flex w-full items-center justify-between text-sm font-semibold text-foreground"
            onClick={() => setCargando((x) => !x)}
            aria-expanded={cargando}
          >
            Cargar seguro, certificado o autorización
            {cargando ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {cargando && (
            <CargarDocumentoVigencia
              schoolId={sujeto.school_id}
              sujeto={{ tipo: sujeto.tipo, id: sujeto.id }}
              eventos={v.eventos}
              eventoActualId={evento}
              onSubido={() => {
                setCargando(false);
                void queryClient.invalidateQueries({ queryKey: claveEstadoHabilitacion(qrToken, evento) });
              }}
            />
          )}
        </div>
      )}

      <p className="text-center text-[11px] text-muted-foreground">
        Este estado se consulta al momento y no aparece en el carnet.
      </p>
    </section>
  );
}

export default EstadoHabilitacionPanel;
