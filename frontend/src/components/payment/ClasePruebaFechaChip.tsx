import { CalendarDays } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useCobrosClasePrueba } from '@/hooks/useCobrosClasePrueba';

function fechaCorta(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

interface Props {
  paymentId: string;
  schoolId: string | null | undefined;
}

/**
 * Pagos → «Pagos recibidos»: en un pago de clase de prueba, el DÍA de la clase.
 * La fila solo traía cuándo se pagó; la fecha de la clase vivía en Deportistas → «Clase de prueba».
 * Sale de `listar_cobros_clase_prueba` (una sola consulta compartida por todas las filas, mismo caché que
 * el diálogo «Clases de prueba»): el pago de la fila coincide con `prospecto.pago.id`. Solo dueño y
 * administradores (la RPC lo exige); sin fecha agendada no pinta nada.
 */
export function ClasePruebaFechaChip({ paymentId, schoolId }: Props) {
  const { prospectos } = useCobrosClasePrueba(schoolId, true);
  const fecha = prospectos.find((p) => p.pago?.id === paymentId)?.fecha_clase;
  if (!fecha) return null;
  return (
    <Badge variant="outline" className="text-[10px] w-fit gap-1" data-testid="clase-prueba-fecha">
      <CalendarDays className="h-3 w-3" /> Clase {fechaCorta(fecha)}
    </Badge>
  );
}
