import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Printer, Loader2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { esAcudienteV2 } from '@/lib/vistaAcudiente';
import { EstadoCuentaAcudiente } from '@/components/account-statement/EstadoCuentaAcudiente';
import { VolverAtras } from '@/components/account-statement/VolverAtras';
import { ACUDIENTE_V2 } from '@/lib/feature-flags';
import { canManageCharges } from '@/lib/cobrosYPagos';
import { printStatement, STATUS_LABELS, type StatementData as Statement } from '@/components/account-statement/statementPrint';

/**
 * Estado de Cuenta. La MISMA RPC sirve a la escuela (admin viendo a cualquier
 * deportista) y a la familia. El acudiente V2 ve su propia presentación
 * (EstadoCuentaAcudiente: una frase, un botón para pagar y el detalle por
 * mes); la escuela y el deportista adulto siguen viendo esta pantalla igual.
 */
export default function AccountStatementPage() {
  const { profile } = useAuth();
  const { schoolId, currentUserRole, loading: schoolLoading } = useSchoolContext();
  const [searchParams] = useSearchParams();
  const esAcudiente = esAcudienteV2(currentUserRole ?? profile?.role)
    && !searchParams.get('user_id') && !searchParams.get('unregistered_athlete_id');
  if (esAcudiente) {
    return (
      <EstadoCuentaAcudiente
        schoolId={schoolId}
        childId={searchParams.get('child_id') || undefined}
        months={Number(searchParams.get('months') || 12)}
        schoolLoading={schoolLoading}
      />
    );
  }
  // Quien administra la escuela ve la misma presentación que la familia (una
  // línea por mes, fechas, puntualidad, cómo pagó) pero solo para consultar. Se
  // apaga con el mismo VITE_ACUDIENTE_V2=false. El deportista adulto que mira su
  // propia cuenta (`?user_id=`) sigue en la pantalla de siempre.
  const childParam = searchParams.get('child_id') || undefined;
  const userParam = searchParams.get('user_id') || undefined;
  const unregisteredParam = searchParams.get('unregistered_athlete_id') || undefined;
  if (ACUDIENTE_V2 && canManageCharges(currentUserRole) && (childParam || userParam || unregisteredParam)) {
    return (
      <>
        <div className="mx-auto w-full max-w-page-narrow">
          <VolverAtras destino="/payments-automation?tab=cierre" etiqueta="Volver" />
        </div>
        <EstadoCuentaAcudiente
          modo="escuela"
          schoolId={schoolId}
          childId={childParam}
          userId={userParam}
          unregisteredId={unregisteredParam}
          months={Number(searchParams.get('months') || 12)}
          schoolLoading={schoolLoading}
        />
      </>
    );
  }
  return <AccountStatementClassic />;
}

function AccountStatementClassic() {
  const { schoolId } = useSchoolContext();
  const [searchParams] = useSearchParams();
  const childId = searchParams.get('child_id') || undefined;
  const userId = searchParams.get('user_id') || undefined;
  const unregisteredId = searchParams.get('unregistered_athlete_id') || undefined;
  const months = Number(searchParams.get('months') || 12);

  const { data, isLoading, error } = useQuery({
    queryKey: ['account-statement', schoolId, childId, userId, unregisteredId, months],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_athlete_account_statement', {
        p_school_id: schoolId,
        p_child_id: childId || null,
        p_user_id: userId || null,
        p_unregistered_athlete_id: unregisteredId || null,
        p_months: months,
      });
      if (error) throw error;
      return data as Statement;
    },
    enabled: !!schoolId && !!(childId || userId || unregisteredId),
  });

  const handlePrint = () => {
    if (!data) return;
    printStatement(data, months);
  };

  if (isLoading) {
    return <div className="p-8 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Cargando estado de cuenta...</div>;
  }
  if (error || !data) {
    return <div className="p-8 text-sm text-destructive">No se pudo cargar el estado de cuenta. {(error as any)?.message}</div>;
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between print:hidden">
        <div>
          <h1 className="text-xl font-semibold">{data.athlete_name}</h1>
          <p className="text-sm text-muted-foreground">Estado de cuenta — últimos {months} meses en el detalle, resumen histórico completo.</p>
        </div>
        <Button variant="outline" onClick={handlePrint}><Printer className="h-4 w-4 mr-2" />Imprimir</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Facturado</p><p className="text-lg font-bold">{formatCurrency(data.summary.total_expected)}</p></CardContent></Card>
        <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Cobrado</p><p className="text-lg font-bold text-emerald-600">{formatCurrency(data.summary.total_settled)}</p></CardContent></Card>
        <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Saldo pendiente</p><p className="text-lg font-bold text-red-500">{formatCurrency(data.summary.total_open)}</p></CardContent></Card>
        <Card><CardContent className="py-3"><p className="text-xs text-muted-foreground">Mora aplicada</p><p className="text-lg font-bold text-orange-600">{formatCurrency(data.summary.total_late_fees)}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Meses (últimos {months})</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Período</TableHead><TableHead>Estado</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.meses.map((m, idx) => (
                <TableRow key={idx}>
                  <TableCell>{m.periodo}</TableCell>
                  <TableCell>{m.status ? <Badge variant="outline">{STATUS_LABELS[m.status] || m.status}</Badge> : <span className="text-xs text-muted-foreground">Sin cobro</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Detalle — pagos y sesiones</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Fecha</TableHead><TableHead>Tipo</TableHead><TableHead>Estado</TableHead><TableHead>Monto</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.events.length === 0 ? (
                <TableRow><TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-6">Sin movimientos en este rango.</TableCell></TableRow>
              ) : data.events.map((ev, idx) => (
                <TableRow key={idx}>
                  <TableCell>{new Date(ev.fecha).toLocaleDateString('es-CO')}</TableCell>
                  <TableCell className="capitalize">{ev.tipo}</TableCell>
                  <TableCell>{ev.tipo === 'pago' ? (STATUS_LABELS[ev.status || ''] || ev.status) : ev.attendance_status}</TableCell>
                  <TableCell>{ev.tipo === 'pago' && ev.amount != null ? formatCurrency(ev.amount) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
