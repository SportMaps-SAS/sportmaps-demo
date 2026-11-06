import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useVenueSummary } from './useVenueSummary';
import { ESTADOS_POR_CONFIRMAR } from './venueMetrics';

const ETIQUETA: Record<string, string> = {
  pending: 'Por confirmar',
  pending_payment: 'Esperando pago',
  pending_reconciliation: 'Por conciliar',
  hold: 'Apartada',
  confirmed: 'Confirmada',
  completed: 'Realizada',
  cancelled: 'Cancelada',
  expired: 'Vencida',
  no_show: 'No asistió',
};

/**
 * Reservas del dueño de espacios: lista de lectura de lo que viene. Crear,
 * confirmar o cancelar una reserva sigue en Instalaciones (/facilities), que
 * es el módulo dueño de esas acciones: aquí no se duplican.
 */
export default function VenueReservationsPage() {
  const { facilities, reservations, loading, error, hoyIso } = useVenueSummary();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60dvh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const proximas = reservations.filter((r) => r.reservation_date >= hoyIso);
  const porConfirmar = proximas.filter((r) => ESTADOS_POR_CONFIRMAR.has(r.status));

  const fila = (r: (typeof reservations)[number]) => (
    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b last:border-0 py-2 text-sm">
      <div>
        <div className="font-medium">{facilities.find((f) => f.id === r.facility_id)?.name ?? 'Cancha'}</div>
        <div className="text-muted-foreground">
          {r.reservation_date} · {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
        </div>
      </div>
      <Badge variant={ESTADOS_POR_CONFIRMAR.has(r.status) ? 'secondary' : 'outline'}>
        {ETIQUETA[r.status] ?? r.status}
      </Badge>
    </div>
  );

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Reservas</h1>
          <p className="text-muted-foreground">Lo que viene en tus instalaciones</p>
        </div>
        <Button asChild><Link to="/facilities">Agendar o gestionar en Instalaciones</Link></Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">No pudimos leer las reservas.</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Por confirmar ({porConfirmar.length})</CardTitle>
          <CardDescription>Esperan tu decisión o su pago</CardDescription>
        </CardHeader>
        <CardContent>
          {porConfirmar.length === 0 ? <p className="text-sm text-muted-foreground">Sin pendientes.</p> : porConfirmar.map(fila)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Próximas ({proximas.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {proximas.length === 0 ? <p className="text-sm text-muted-foreground">Todavía no hay reservas próximas.</p> : proximas.map(fila)}
        </CardContent>
      </Card>
    </div>
  );
}
