import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { ChevronLeft, ChevronRight, Loader2, Lock, LockOpen } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/lib/utils';
import { todayColombia } from '@/lib/dateUtils';
import { PaymentAgingCard } from './PaymentAgingCard';
import { PagosDelMesCard } from './PagosDelMesCard';
import { EstadoCuentaDialog } from '@/components/account-statement/EstadoCuentaDialog';
import { ChipEstado } from '@/components/common/ChipEstado';
import { etiquetaAsistencia, etiquetaEstadoPago } from '@/components/account-statement/estadoCuentaModel';

const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

interface CloseTotals {
  count_expected: number; total_expected: number;
  count_settled: number;  total_settled: number;
  count_open: number;     total_open: number;
  total_late_fees: number;
}

interface CloseRow extends CloseTotals {
  id: string; status: 'abierto' | 'cerrado' | 'reabierto';
  period_year: number; period_month: number;
  closed_at: string | null; reopened_at: string | null; reopen_reason: string | null;
}

interface AthleteTarget {
  child_id: string | null; adult_id: string | null; unregistered_athlete_id: string | null; name: string;
}

export function MonthCloseTab({ schoolId, activeBranchId }: { schoolId: string | null | undefined; activeBranchId: string | null | undefined }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [today] = useState(() => { const [y, m] = todayColombia().split('-').map(Number); return { y, m }; });
  const [period, setPeriod] = useState(() => {
    // Default: el mes anterior al actual — el que normalmente se cierra.
    const d = new Date(today.y, today.m - 1 - 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const esMesEnCurso = period.year === today.y && period.month === today.m;

  const shiftPeriod = (delta: number) => setPeriod((p) => {
    const d = new Date(p.year, p.month - 1 + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  const periodKey = ['month-close', schoolId, activeBranchId, period.year, period.month];

  // La fila persistida (si el período ya se abrió/cerró alguna vez) — RLS ya
  // filtra por is_school_admin/is_super_admin, lectura directa sin RPC.
  const { data: closeRow, isLoading: closeRowLoading } = useQuery({
    queryKey: periodKey,
    queryFn: async () => {
      // `monthly_closes` es tabla nueva (F1), todavía no está en los tipos
      // generados de Supabase — mismo patrón `as any` que el resto de las
      // RPCs nuevas del archivo (preview_open_month, open_month, etc.).
      let q = (supabase as any)
        .from('monthly_closes')
        .select('*')
        .eq('school_id', schoolId as string)
        .eq('scope', 'cobros')
        .eq('period_year', period.year)
        .eq('period_month', period.month);
      q = activeBranchId ? q.eq('branch_id', activeBranchId) : q.is('branch_id', null);
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return data as CloseRow | null;
    },
    enabled: !!schoolId,
  });

  // Totales EN VIVO (siempre, aunque ya esté cerrado) — para que el admin vea
  // si el número cerrado quedó desactualizado por pagos que entraron después.
  const { data: liveTotals, isLoading: liveLoading } = useQuery({
    queryKey: [...periodKey, 'preview'],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('preview_close_month', {
        p_school_id: schoolId, p_year: period.year, p_month: period.month, p_branch_id: activeBranchId || null,
      });
      if (error) throw error;
      return data as CloseTotals;
    },
    enabled: !!schoolId,
  });

  const { data: history } = useQuery({
    queryKey: ['month-close-history', schoolId, activeBranchId],
    queryFn: async () => {
      let q = (supabase as any).from('monthly_closes').select('*').eq('school_id', schoolId as string).eq('scope', 'cobros');
      q = activeBranchId ? q.eq('branch_id', activeBranchId) : q.is('branch_id', null);
      const { data, error } = await q.order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(24);
      if (error) throw error;
      return (data ?? []) as CloseRow[];
    },
    enabled: !!schoolId,
  });

  const { data: yearReport } = useQuery({
    queryKey: ['month-close-year-report', schoolId, activeBranchId, period.year],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_school_year_closes_report', {
        p_school_id: schoolId, p_year: period.year, p_branch_id: activeBranchId || null,
      });
      if (error) throw error;
      return data as { meses: Array<CloseTotals & { period_month: number; status: string }> };
    },
    enabled: !!schoolId,
  });

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);
  const [timelineTarget, setTimelineTarget] = useState<AthleteTarget | null>(null);
  // Estado de cuenta del atleta (modal V2). Desde ahí se puede pasar a las sesiones del mes.
  const [statementTarget, setStatementTarget] = useState<AthleteTarget | null>(null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: periodKey });
    queryClient.invalidateQueries({ queryKey: ['month-close-history', schoolId, activeBranchId] });
    queryClient.invalidateQueries({ queryKey: ['month-close-year-report', schoolId, activeBranchId, period.year] });
  };

  const handleClose = async () => {
    setClosing(true);
    try {
      const { error } = await (supabase as any).rpc('close_month', {
        p_school_id: schoolId, p_year: period.year, p_month: period.month, p_branch_id: activeBranchId || null,
      });
      if (error) throw error;
      toast({ title: `Mes de ${MESES[period.month]} ${period.year} cerrado` });
      setConfirmOpen(false);
      invalidateAll();
    } catch (e: any) {
      toast({ title: 'Error al cerrar el mes', description: e.message, variant: 'destructive' });
    } finally {
      setClosing(false);
    }
  };

  const handleReopen = async () => {
    if (!reopenReason.trim()) return;
    setReopening(true);
    try {
      const { error } = await (supabase as any).rpc('reopen_month', {
        p_school_id: schoolId, p_year: period.year, p_month: period.month,
        p_reason: reopenReason, p_branch_id: activeBranchId || null,
      });
      if (error) throw error;
      toast({ title: 'Cierre reabierto' });
      setReopenOpen(false);
      setReopenReason('');
      invalidateAll();
    } catch (e: any) {
      toast({ title: 'Error al reabrir', description: e.message, variant: 'destructive' });
    } finally {
      setReopening(false);
    }
  };

  const { data: timeline, isLoading: timelineLoading } = useQuery({
    queryKey: ['athlete-timeline', schoolId, period.year, period.month, timelineTarget?.child_id, timelineTarget?.adult_id, timelineTarget?.unregistered_athlete_id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_athlete_payment_timeline', {
        p_school_id: schoolId, p_year: period.year, p_month: period.month,
        p_child_id: timelineTarget?.child_id ?? null,
        p_user_id: timelineTarget?.adult_id ?? null,
        p_unregistered_athlete_id: timelineTarget?.unregistered_athlete_id ?? null,
      });
      if (error) throw error;
      return data as { events: Array<Record<string, any>> };
    },
    enabled: !!schoolId && !!timelineTarget,
  });

  const status = closeRow?.status ?? 'sin_cierre';

  return (
    <div className="space-y-4">
      {/* Selector de período */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <Button variant="ghost" size="icon" onClick={() => shiftPeriod(-1)}><ChevronLeft className="h-4 w-4" /></Button>
          <div className="text-center">
            <p className="text-lg font-semibold">{MESES[period.month]} {period.year}</p>
            {esMesEnCurso ? (
              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300 mt-1">Mes en curso — sin cerrar</Badge>
            ) : status === 'cerrado' ? (
              <Badge className="bg-emerald-100 text-emerald-800 border-emerald-300 mt-1"><Lock className="h-3 w-3 mr-1" />Cerrado{closeRow?.closed_at ? ` el ${new Date(closeRow.closed_at).toLocaleDateString('es-CO')}` : ''}</Badge>
            ) : status === 'reabierto' ? (
              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-300 mt-1"><LockOpen className="h-3 w-3 mr-1" />Reabierto</Badge>
            ) : (
              <Badge variant="outline" className="mt-1">Sin cerrar</Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => shiftPeriod(1)}><ChevronRight className="h-4 w-4" /></Button>
        </CardContent>
      </Card>

      {/* Totales en vivo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Facturado', count: liveTotals?.count_expected, total: liveTotals?.total_expected, tone: 'text-foreground' },
          { label: 'Cobrado', count: liveTotals?.count_settled, total: liveTotals?.total_settled, tone: 'text-emerald-600' },
          { label: 'Cartera', count: liveTotals?.count_open, total: liveTotals?.total_open, tone: 'text-red-500' },
          { label: 'Mora aplicada', count: null, total: liveTotals?.total_late_fees, tone: 'text-orange-600' },
        ].map((c) => (
          <Card key={c.label}>
            <CardContent className="py-3">
              <p className="text-xs text-muted-foreground">{c.label}</p>
              <p className={`text-lg font-bold ${c.tone}`}>{liveLoading ? '…' : formatCurrency(c.total ?? 0)}</p>
              {c.count != null && <p className="text-xs text-muted-foreground">{c.count} cobro(s)</p>}
            </CardContent>
          </Card>
        ))}
      </div>
      {closeRow?.status === 'cerrado' && liveTotals && (liveTotals.total_expected !== closeRow.total_expected || liveTotals.total_settled !== closeRow.total_settled) && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2">
          El número cerrado (facturado {formatCurrency(closeRow.total_expected)} · cobrado {formatCurrency(closeRow.total_settled)}) quedó desactualizado — entraron movimientos después del cierre. Volvé a cerrar para recalcular.
        </p>
      )}

      {/* Acción de cierre — arriba de las listas largas (cartera puede tener
          cientos de filas) para que el botón principal de la pestaña no
          dependa de cuánto haya que scrollear. */}
      <Card>
        <CardContent className="flex flex-col sm:flex-row items-center justify-between gap-3 py-4">
          <p className="text-sm text-muted-foreground">
            Cerrar el mes NO bloquea pagos ni la generación del mes siguiente — es un registro. Los pendientes siguen vivos y se pueden cobrar después.
          </p>
          <div className="flex gap-2 shrink-0">
            {status === 'cerrado' && (
              <Button variant="outline" onClick={() => setReopenOpen(true)}>Reabrir</Button>
            )}
            <Button onClick={() => setConfirmOpen(true)}>
              {status === 'cerrado' ? 'Volver a cerrar' : 'Cerrar mes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quién pagó en el mes: todos los atletas, con fecha límite, fecha de pago y
          puntualidad. Tocar una fila abre su estado de cuenta. */}
      <PagosDelMesCard
        schoolId={schoolId}
        activeBranchId={activeBranchId}
        year={period.year}
        month={period.month}
        mesLabel={MESES[period.month]}
        onAthleteClick={setStatementTarget}
      />

      {/* Cartera pendiente — antigüedad por atleta, en vivo */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cartera pendiente de {MESES[period.month]}</CardTitle>
          <CardDescription>Quién debe ese período (o anteriores) — incluye las sesiones que tomó mientras debía.</CardDescription>
        </CardHeader>
        <CardContent>
          <PaymentAgingCard
            schoolId={schoolId}
            activeBranchId={activeBranchId}
            periodFilter={{ year: period.year, month: period.month }}
            onAthleteClick={setStatementTarget}
          />
        </CardContent>
      </Card>

      {/* Historial de cierres */}
      <Card>
        <CardHeader><CardTitle className="text-base">Historial de cierres</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Período</TableHead><TableHead>Estado</TableHead><TableHead>Facturado</TableHead><TableHead>Cobrado</TableHead><TableHead>Cartera</TableHead></TableRow></TableHeader>
            <TableBody>
              {(history ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-6">Todavía no se cerró ningún mes.</TableCell></TableRow>
              ) : (history ?? []).map((h) => (
                <TableRow key={h.id}>
                  <TableCell>{MESES[h.period_month]} {h.period_year}</TableCell>
                  <TableCell className="capitalize">{h.status}</TableCell>
                  <TableCell>{formatCurrency(h.total_expected)}</TableCell>
                  <TableCell className="text-emerald-600">{formatCurrency(h.total_settled)}</TableCell>
                  <TableCell className="text-red-500">{formatCurrency(h.total_open)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Reporte general del año */}
      <Card>
        <CardHeader><CardTitle className="text-base">Reporte del año {period.year}</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Mes</TableHead><TableHead>Estado</TableHead><TableHead>Facturado</TableHead><TableHead>Cobrado</TableHead><TableHead>Cartera</TableHead></TableRow></TableHeader>
            <TableBody>
              {(yearReport?.meses ?? []).map((m) => (
                <TableRow key={m.period_month}>
                  <TableCell>{MESES[m.period_month]}</TableCell>
                  <TableCell className="capitalize">{m.status === 'sin_cierre' ? '—' : m.status}</TableCell>
                  <TableCell>{formatCurrency(m.total_expected)}</TableCell>
                  <TableCell className="text-emerald-600">{formatCurrency(m.total_settled)}</TableCell>
                  <TableCell className="text-red-500">{formatCurrency(m.total_open)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Confirmación de cierre */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{status === 'cerrado' ? 'Volver a cerrar' : 'Cerrar'} {MESES[period.month]} {period.year}</DialogTitle>
            <DialogDescription>
              Esto congela los totales de facturado, cobrado, cartera y mora del período. No bloquea pagos: los pendientes siguen vivos y se pueden seguir cobrando después — solo queda registrado el número de hoy.
              {status === 'cerrado' && ' Como ya estaba cerrado, esto recalcula y sobreescribe el número anterior.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button onClick={handleClose} disabled={closing}>
              {closing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Cerrando...</> : 'Confirmar'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reapertura con motivo obligatorio */}
      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reabrir {MESES[period.month]} {period.year}</DialogTitle>
            <DialogDescription>El motivo queda registrado junto con quién y cuándo reabrió.</DialogDescription>
          </DialogHeader>
          <Textarea placeholder="Motivo de la reapertura..." value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReopenOpen(false)}>Cancelar</Button>
            <Button onClick={handleReopen} disabled={reopening || !reopenReason.trim()}>
              {reopening ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Reabriendo...</> : 'Confirmar reapertura'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Estado de cuenta del atleta (V2, solo consulta) */}
      <EstadoCuentaDialog
        schoolId={schoolId}
        objetivo={statementTarget}
        onClose={() => setStatementTarget(null)}
        pie={statementTarget && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs font-normal"
            onClick={() => { setTimelineTarget(statementTarget); setStatementTarget(null); }}
          >
            Ver sesiones de {MESES[period.month]}
          </Button>
        )}
      />

      {/* Drill-down por atleta: pagos y sesiones del mes */}
      <Dialog open={!!timelineTarget} onOpenChange={(open) => !open && setTimelineTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 pr-6">
              {timelineTarget?.name}
              {timelineTarget && (
                <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs font-normal">
                  <Link to={`/estado-cuenta?${new URLSearchParams({
                    ...(timelineTarget.child_id ? { child_id: timelineTarget.child_id } : {}),
                    ...(timelineTarget.adult_id ? { user_id: timelineTarget.adult_id } : {}),
                    ...(timelineTarget.unregistered_athlete_id ? { unregistered_athlete_id: timelineTarget.unregistered_athlete_id } : {}),
                  }).toString()}`}>
                    Ver estado de cuenta completo →
                  </Link>
                </Button>
              )}
            </DialogTitle>
            <DialogDescription>Pagos y sesiones de {MESES[period.month]} {period.year}, en orden — todavía sin marcar si cada sesión quedó cubierta por el pago.</DialogDescription>
          </DialogHeader>
          {timelineLoading ? (
            <p className="text-sm text-muted-foreground py-4">Cargando...</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {(timeline?.events ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">Sin pagos ni sesiones registradas en este rango.</p>
              ) : (timeline?.events ?? []).map((ev, idx) => (
                <div key={idx} className="flex items-center justify-between border-b pb-2 text-sm">
                  <div>
                    <span className="font-medium">{new Date(ev.fecha).toLocaleDateString('es-CO')}</span>{' '}
                    {ev.tipo === 'pago' ? (
                      <span>— Pago <ChipEstado className="ml-1" {...etiquetaEstadoPago(ev.status)} /></span>
                    ) : (
                      <span>— Clase <ChipEstado className="ml-1" {...etiquetaAsistencia(ev.attendance_status)} /></span>
                    )}
                  </div>
                  {ev.tipo === 'pago' && <span className="font-bold">{formatCurrency(ev.amount)}</span>}
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
