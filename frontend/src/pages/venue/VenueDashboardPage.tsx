import { Link, Navigate } from 'react-router-dom';
import { Building, CalendarCheck, CalendarClock, DollarSign, Gauge, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { useVenueSummary } from './useVenueSummary';
import { contarPorConfirmar, ESTADOS_POR_CONFIRMAR, ingresosDelMes, ocupacionSemanal } from './venueMetrics';

const cop = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);

interface StatProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  value: string;
  hint?: string;
  to?: string;
}

function Stat({ icon: Icon, title, value, hint, to }: StatProps) {
  const body = (
    <Card className={to ? 'transition-shadow hover:shadow-md' : undefined}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

/**
 * Inicio del dueño de espacios (facility_manager). Hoy, ocupación de la semana,
 * reservas por confirmar e ingresos del mes, leídos con las tablas que ya
 * existen. Sin instalaciones todavía → onboarding mínimo.
 */
export default function VenueDashboardPage() {
  const { profile } = useAuth();
  const { schoolName } = useSchoolContext();
  const { facilities, reservations, loading, error, hoyIso, semanaIso, mesIso } = useVenueSummary();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60dvh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (facilities.length === 0) {
    return <Navigate to="/venue/onboarding" replace />;
  }

  const deHoy = reservations.filter((r) => r.reservation_date === hoyIso && r.status !== 'cancelled' && r.status !== 'expired');
  const deLaSemana = reservations.filter((r) => r.reservation_date >= semanaIso.desde && r.reservation_date <= semanaIso.hasta);
  const delMes = reservations.filter((r) => r.reservation_date >= mesIso.desde && r.reservation_date <= mesIso.hasta);
  const porConfirmar = contarPorConfirmar(reservations.filter((r) => r.reservation_date >= hoyIso));
  const ocupacion = ocupacionSemanal(facilities, deLaSemana);
  const ingresos = ingresosDelMes(delMes);
  const primerNombre = (profile?.full_name || '').split(' ')[0];

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{primerNombre ? `Hola, ${primerNombre}` : 'Inicio'}</h1>
        <p className="text-muted-foreground">{schoolName || 'Tu espacio'}</p>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">
            No pudimos leer las reservas. Abre Instalaciones para verlas allí.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={CalendarCheck} title="Reservas de hoy" value={String(deHoy.length)}
          hint={deHoy.length === 0 ? 'Nada agendado para hoy' : undefined} to="/venue/reservas" />
        <Stat icon={Gauge} title="Ocupación de la semana"
          value={ocupacion === null ? '—' : `${ocupacion}%`}
          hint={ocupacion === null ? 'Carga el horario de tus canchas para calcularla' : 'Horas reservadas sobre horas abiertas'}
          to="/facilities" />
        <Stat icon={CalendarClock} title="Por confirmar" value={String(porConfirmar)}
          hint={porConfirmar === 0 ? 'Sin pendientes' : 'Reservas que esperan tu decisión o su pago'}
          to="/venue/reservas" />
        <Stat icon={DollarSign} title="Ingresos del mes" value={cop(ingresos)}
          hint="Valor de las reservas confirmadas" to="/venue/cobros" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Próximas reservas</CardTitle>
            <CardDescription>Lo que sigue en tu agenda</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {reservations.filter((r) => r.reservation_date >= hoyIso && !['cancelled', 'expired'].includes(r.status)).slice(0, 5).map((r) => {
              const cancha = facilities.find((f) => f.id === r.facility_id)?.name ?? 'Cancha';
              return (
                <div key={r.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
                  <span>{cancha}</span>
                  <span className="text-muted-foreground">
                    {r.reservation_date} · {r.start_time.slice(0, 5)}–{r.end_time.slice(0, 5)}
                    {ESTADOS_POR_CONFIRMAR.has(r.status) ? ' · por confirmar' : ''}
                  </span>
                </div>
              );
            })}
            {reservations.filter((r) => r.reservation_date >= hoyIso).length === 0 && (
              <p className="text-sm text-muted-foreground">Todavía no hay reservas próximas.</p>
            )}
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link to="/venue/reservas">Ver todas las reservas</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tu espacio</CardTitle>
            <CardDescription>{facilities.length} {facilities.length === 1 ? 'instalación publicada' : 'instalaciones'}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild size="sm"><Link to="/facilities"><Building className="h-4 w-4 mr-2" />Instalaciones</Link></Button>
            <Button asChild size="sm" variant="outline"><Link to="/venue/cobros"><DollarSign className="h-4 w-4 mr-2" />Forma de cobro</Link></Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
