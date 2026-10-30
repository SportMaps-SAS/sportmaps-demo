/**
 * Clases de prueba de un día en la Semana del profe (paso 11 de la maqueta):
 * «🔔 Clase de prueba · Mariana · 2011 · Punta · Pagó ✅», y después de la
 * clase [Asistió] [No vino] y «Grupo recomendado» (equipos de la escuela).
 * Lo marca la RPC `marcar_clase_prueba_entrenador`; la escuela lo ve en
 * Deportistas → Clase de prueba. La asistencia y el grupo van por separado
 * (asistencia sin equipo = solo marca; equipo sin asistencia = solo recomienda),
 * y solo con la clase agendada: un cupo separado sin pago no se marca.
 */
import { toast } from 'sonner';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { hora12 } from '@/lib/clasePruebaTextos';
import { lineaClasePrueba, textoPagoClase, type ClasePruebaSemana } from './semanaAjustesModel';
import type { ResultadoAccion } from './useSemanaAjustes';

interface Props {
  clases: ClasePruebaSemana[];
  hoy: string;
  equiposEscuela: { id: string; name: string }[];
  guardando: boolean;
  onMarcar: (p: { leadId: string; asistencia: 'asistio' | 'no_vino' | null; teamRecomendado?: string | null }) => Promise<ResultadoAccion>;
}

export function ClasesPruebaDelDia({ clases, hoy, equiposEscuela, guardando, onMarcar }: Props) {
  if (clases.length === 0) return null;

  const marcar = async (p: Parameters<Props['onMarcar']>[0], listo: string) => {
    const r = await onMarcar(p);
    if (r.ok) toast.success(listo);
    else toast.error(r.error ?? 'No se pudo guardar.');
  };

  return (
    <ul className="space-y-2 px-3 pb-3" aria-label="Clases de prueba" data-testid="clases-prueba-dia">
      {clases.map((c) => {
        const pago = textoPagoClase(c);
        const yaFue = !!c.fecha && c.fecha <= hoy;
        const separada = c.estadoCupo === 'separada';
        const cuando = [hora12(c.hora), c.equipo].filter(Boolean).join(' · ');
        return (
          <li key={c.leadId} className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
            <p className="flex items-center gap-1.5 font-semibold">
              <Bell className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
              <span className="min-w-0">Clase de prueba{cuando ? ` · ${cuando}` : ''}</span>
            </p>
            <p className="leading-snug">
              {lineaClasePrueba(c)}
              {pago && <span className={cn('ml-1 font-medium', c.pago === 'pagado' ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300')}>· {pago}</span>}
            </p>
            {separada ? (
              <p className="text-xs text-muted-foreground">Falta el comprobante: la clase todavía no está confirmada.</p>
            ) : yaFue ? (
              <>
                <div className="flex gap-2" role="group" aria-label={`¿Vino ${c.nombre}?`}>
                  <Button size="sm" className="min-h-touch flex-1" variant={c.asistencia === 'asistio' ? 'default' : 'outline'} aria-pressed={c.asistencia === 'asistio'}
                    disabled={guardando} onClick={() => void marcar({ leadId: c.leadId, asistencia: 'asistio', teamRecomendado: null }, `${c.nombre}: asistió.`)}>
                    Asistió
                  </Button>
                  <Button size="sm" className="min-h-touch flex-1" variant={c.asistencia === 'no_vino' ? 'default' : 'outline'} aria-pressed={c.asistencia === 'no_vino'}
                    disabled={guardando} onClick={() => void marcar({ leadId: c.leadId, asistencia: 'no_vino', teamRecomendado: null }, `${c.nombre}: no vino.`)}>
                    No vino
                  </Button>
                </div>
                {equiposEscuela.length > 0 && (
                  <label className="flex flex-col gap-1 text-xs font-semibold">
                    Grupo recomendado
                    <select value={c.teamRecomendado ?? ''} disabled={guardando}
                      onChange={(e) => e.target.value && void marcar({ leadId: c.leadId, asistencia: null, teamRecomendado: e.target.value },
                        `${c.nombre}: grupo recomendado guardado.`)}
                      className="min-h-touch rounded-xl border bg-background px-3 text-sm font-normal">
                      <option value="">Elige el grupo</option>
                      {equiposEscuela.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Después de la clase marcas si vino y el grupo que le recomiendas.</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
