/**
 * Lo que el bot de WhatsApp averiguó del interesado (embudo por escuela, mig.
 * embudo_y_agenda_clase_prueba), debajo de su nombre en Deportistas → Clase de
 * prueba (paso 11 de la maqueta):
 *
 *   2011 · Mujer · Punta · Club y torneos (Club Titanes, Distrital 2025)
 *   Sede Norte · Infantil Femenino · Profe Iván
 *   [Cupo separado · sin comprobante]  /  [Pago en revisión]  /  [Pagó $15.000]
 *
 * Un prospecto sin datos del embudo (los de siempre, o la base sin la
 * migración) no muestra nada: la fila queda exactamente como antes.
 */
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ProspectoClasePrueba } from '@/hooks/useClasePrueba';
import { detalleEmbudo, type Tono } from './prospectoEmbudoModel';

const TONO: Record<Tono, string> = {
  ok: 'text-emerald-700 border-emerald-300 dark:text-emerald-400',
  pendiente: 'text-amber-700 border-amber-300 dark:text-amber-400',
  neutro: '',
};

export function ProspectoDetalleEmbudo({ prospecto }: { prospecto: ProspectoClasePrueba }) {
  const d = detalleEmbudo(prospecto);
  if (!d) return null;
  return (
    <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground" data-testid="prospecto-embudo">
      {d.perfil && <p className="line-clamp-2">{d.perfil}</p>}
      {d.agenda && <p className="truncate">{d.agenda}</p>}
      {d.estado && (
        <Badge variant="outline" className={cn('mt-1 text-[10px]', TONO[d.estado.tono])}>{d.estado.texto}</Badge>
      )}
    </div>
  );
}
