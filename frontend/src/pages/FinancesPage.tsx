import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AlertCircle, History, RefreshCw } from 'lucide-react';
import { ReminderHistoryModal } from '@/components/finances/ReminderHistoryModal';
import { FinancialSummaryCards } from '@/components/finances/FinancialSummaryCards';
import { OverdueAccountsCard } from '@/components/finances/OverdueAccountsCard';
import { CarteraInformeBar } from '@/components/finances/CarteraInformeBar';
import { PaymentAgingCard } from '@/components/finances/PaymentAgingCard';
import { NextMonthCloseCard } from '@/components/finances/NextMonthCloseCard';
import { PaymentHistoryGridCard } from '@/components/finances/PaymentHistoryGridCard';
import { TransactionsCard } from '@/components/finances/TransactionsCard';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { USED_STATUSES, FETCH_CAP, isOverdueCharge } from '@/lib/paymentCartera';
import { fetchStoreIncome } from '@/lib/accounting/income';
import { todayColombia } from '@/lib/dateUtils';

/**
 * Reorganizado en tabs (antes: 6 <Card> apiladas en scroll vertical, 1370
 * líneas en un solo archivo). Este shell solo resuelve el contexto de la
 * escuela, hace el ÚNICO fetch de `payments` que comparten 3 tabs (KPIs,
 * Cartera, Transacciones — evita triplicar una consulta de hasta 1000 filas),
 * y compone los componentes de `components/finances/`. Cada componente
 * autocontenido (Antigüedad, Próximo Cierre, Historial) trae su propia RPC.
 */
export default function FinancesPage() {
  const { schoolId, activeBranchId, schoolName, totalBranches } = useSchoolContext();
  const multiBranch = totalBranches > 1;
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  // Los dos tabs autocontenidos avisan su conteo para el badge del trigger,
  // sin que el shell tenga que duplicar su query.
  const [agingCount, setAgingCount] = useState(0);
  const [historyCount, setHistoryCount] = useState(0);

  // Fetch payments from Supabase — filtrado por school_id y branch
  const { data: payments, isError, isFetching, refetch } = useQuery({
    queryKey: ['school-payments-all', schoolId, activeBranchId, multiBranch],
    queryFn: async () => {
      let query = supabase
        .from('payments')
        .select(`
          id,
          amount,
          amount_paid,
          status,
          due_date,
          payment_date,
          created_at,
          concept,
          payment_method,
          payment_channel,
          payment_provider,
          receipt_url,
          wompi_reference,
          wompi_transaction_id,
          provider_transaction_id,
          qr_id,
          reference,
          period_year,
          period_month,
          last_failure_at,
          last_failure_reason,
          requires_review,
          student:children(full_name, parent_name_temp, parent_phone_temp),
          parent:profiles!payments_parent_id_fkey(full_name, phone),
          athlete:profiles!payments_user_id_fkey(full_name, phone),
          unregistered:unregistered_athletes(full_name, phone, date_of_birth, guardian_full_name, guardian_phone)
        `)
        .in('status', USED_STATUSES as unknown as string[])
        // `id` como último criterio: sin un desempate determinista, dos cargas
        // de la misma pantalla podían devolver los empates de `due_date` en
        // orden distinto y mover filas de página.
        .order('due_date', { ascending: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(FETCH_CAP);

      if (schoolId) query = query.eq('school_id', schoolId);
      // Sede (multisede S1): con una sede elegida solo los cobros de ESA sede;
      // los sin sede se ven únicamente en «Todas» (no se reparten en cada sede,
      // así no se cuentan dos veces al sumar sedes). En una escuela de UNA sola
      // sede, NULL es esa sede y se sigue viendo (antes con .eq() se caía plata
      // real de la pantalla).
      if (activeBranchId) {
        query = multiBranch
          ? query.eq('branch_id', activeBranchId)
          : query.or(`branch_id.is.null,branch_id.eq.${activeBranchId}`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
    enabled: !!schoolId,
  });

  const overdueCount = (payments ?? []).filter(isOverdueCharge).length;

  // Ventas de la tienda escolar (histórico): no están en `payments` (contrato
  // contabilidad v2 §6). Sin tienda → undefined y la tarjeta queda como antes.
  const storeQuery = useQuery({
    queryKey: ['finances-store-income', schoolId, activeBranchId],
    enabled: !!schoolId,
    queryFn: () => fetchStoreIncome(supabase as any, {
      schoolId: schoolId as string,
      branchId: activeBranchId,
      from: '2000-01-01',
      to: todayColombia(),
    }),
  });
  const storeIncome: number | null | undefined = (() => {
    const r = storeQuery.data;
    if (storeQuery.isError || r?.kind === 'error') return null;
    if (!r || r.kind === 'forbidden' || !r.hasStore) return undefined;
    return r.total;
  })();

  // F-01: NO mostrar $0 silencioso ante un error de carga. En una pantalla de
  // dinero, una tabla vacía se lee como "no hay deuda" — hay que distinguir el
  // fallo de red del estado sin datos y ofrecer reintento.
  if (isError) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Finanzas</h1>
          <p className="text-muted-foreground">Panel de control financiero</p>
        </div>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No se pudieron cargar las finanzas</AlertTitle>
          <AlertDescription className="mt-1 flex flex-col items-start gap-3">
            <span>
              Ocurrió un error al cargar los pagos. Esto <strong>no</strong> significa
              que no haya deuda o ingresos — es un fallo de conexión. Reintenta.
            </span>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Reintentar
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Finanzas</h1>
          <p className="text-muted-foreground">Panel de control financiero</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            Actualizar
          </Button>
          <Button variant="outline" onClick={() => setShowHistoryModal(true)}>
            <History className="mr-2 h-4 w-4" />
            Ver Historial de Recordatorios
          </Button>
        </div>
      </div>

      {/* Truncamiento visible, no silencioso: si la consulta topó el límite, los
          totales de abajo están incompletos y hay que decirlo. */}
      {payments && payments.length >= FETCH_CAP && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Vista incompleta</AlertTitle>
          <AlertDescription>
            Se alcanzó el tope de {FETCH_CAP} cobros por consulta, así que los totales
            y las tablas de esta pantalla <strong>no incluyen todo el histórico</strong>.
            Hay que acotar por período en el servidor antes de usar estos números.
          </AlertDescription>
        </Alert>
      )}

      {/* KPIs siempre visibles arriba de los tabs — no son un tab más. */}
      <FinancialSummaryCards payments={payments} storeIncome={storeIncome} />

      <Tabs defaultValue="cartera" className="space-y-4">
        <TabsList className="w-max min-w-full sm:w-auto flex-wrap h-auto">
          <TabsTrigger value="cartera" className="gap-2">
            Cartera
            <Badge variant="secondary" className="px-1.5">{overdueCount}</Badge>
          </TabsTrigger>
          <TabsTrigger value="antiguedad" className="gap-2">
            Antigüedad por atleta
            <Badge variant="secondary" className="px-1.5">{agingCount}</Badge>
          </TabsTrigger>
          <TabsTrigger value="historial" className="gap-2">
            Historial de pagos
            <Badge variant="secondary" className="px-1.5">{historyCount}</Badge>
          </TabsTrigger>
          <TabsTrigger value="proximo-cierre">Próximo cierre de mes</TabsTrigger>
          <TabsTrigger value="transacciones">Transacciones</TabsTrigger>
        </TabsList>

        <TabsContent value="cartera">
          <Card>
            <CardContent className="pt-6">
              <CarteraInformeBar schoolId={schoolId} />
              <OverdueAccountsCard
                payments={payments}
                schoolId={schoolId}
                schoolName={schoolName}
                onRefresh={refetch}
                refreshing={isFetching}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="antiguedad">
          <Card>
            <CardContent className="pt-6">
              <PaymentAgingCard schoolId={schoolId} activeBranchId={activeBranchId} onCount={setAgingCount} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="historial">
          <Card>
            <CardContent className="pt-6">
              <PaymentHistoryGridCard schoolId={schoolId} activeBranchId={activeBranchId} onCount={setHistoryCount} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="proximo-cierre">
          <Card>
            <CardContent className="pt-6">
              <NextMonthCloseCard schoolId={schoolId} activeBranchId={activeBranchId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="transacciones">
          <Card>
            <CardContent className="pt-6">
              <TransactionsCard payments={payments} onRefresh={refetch} refreshing={isFetching} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Recibia `reminders`, prop que este modal no tiene: carga sus propios
          registros y para eso necesita `schoolId`, que no se le pasaba. Resultado:
          el historial salia vacio siempre. */}
      <ReminderHistoryModal
        open={showHistoryModal}
        onOpenChange={setShowHistoryModal}
        schoolId={schoolId ?? ''}
      />
    </div>
  );
}
