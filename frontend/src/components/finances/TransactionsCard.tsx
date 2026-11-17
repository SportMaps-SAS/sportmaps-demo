import { useState, useEffect } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PaymentOriginBadge } from '@/components/payment/PaymentOriginBadge';
import { PagoOrigenInsignia } from '@/components/payment/PagoOrigenInsignia';
import type { OrigenDelPagoInput } from '@/lib/payments/origenDelPago';
import { StatFilterBar, type StatFilterTone } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';
import { formatDayCO } from '@/lib/dateUtils';
import {
  resolvePaymentOrigin,
  ORIGIN_FILTERS,
  type PaymentOrigin,
  type PaymentOriginInput,
  type PaymentOriginKind,
} from '@/lib/paymentOrigin';
import { Button } from '@/components/ui/button';

// Color de cada origen en las tarjetas de filtro.
const ORIGIN_TONES: Record<string, StatFilterTone> = {
  gateway: 'blue',
  transfer_receipt: 'emerald',
  transfer_manual: 'yellow',
  cash: 'violet',
  card_manual: 'orange',
  pse_manual: 'primary',
  other: 'neutral',
  unknown: 'rose',
};

interface Transaction {
  id: string;
  date: string;
  /** Deportista del cobro. Es lo que distingue dos pagos del mismo pagador. */
  athlete: string;
  /** Acudiente, solo cuando es distinto del deportista (menores). */
  payer: string | null;
  concept: string;
  amount: number;
  isPartial: boolean;
  origin: PaymentOrigin;
  raw: OrigenDelPagoInput;
  /** Día + hora + id: orden estable. Ver `sortKey` más abajo. */
  sortKey: string;
}

const TX_PAGE_SIZE = 10;

const nameOf = (v: unknown): string | null =>
  (Array.isArray(v) ? (v[0] as { full_name?: string })?.full_name : (v as { full_name?: string })?.full_name) || null;

interface RawPayment {
  id: string;
  status: string;
  payment_date?: string | null;
  created_at?: string | null;
  due_date: string;
  student?: unknown;
  parent?: unknown;
  concept: string;
  amount: number | string;
  amount_paid?: number | string | null;
  [key: string]: unknown;
}

interface TransactionsCardProps {
  payments: RawPayment[] | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}

/** Contenido del tab "Transacciones": pagos que ya entraron (paid/partial). */
export function TransactionsCard({ payments, onRefresh, refreshing }: TransactionsCardProps) {
  const [txSearch, setTxSearch] = useState('');
  const [txOrigin, setTxOrigin] = useState<PaymentOriginKind | 'all'>('all');
  const [txPage, setTxPage] = useState(1);
  useEffect(() => { setTxPage(1); }, [txSearch, txOrigin]);

  /**
   * Clave de orden del listado. El DÍA lo manda `payment_date` (la fecha
   * declarada del pago), pero `payment_date` es una columna `date`: no tiene
   * hora, así que no desempata nada. Con 53 pagos entre el 3 y el 5 de agosto
   * todos empataban, y el orden dentro del empate lo terminaba decidiendo el
   * orden en que Postgres devolvía las filas — que no está garantizado y cambia
   * entre cargas. Resultado: la página 1 mezclaba días salteados y NO eran las
   * 10 transacciones más recientes, así que un pago recién aprobado parecía no
   * existir (estaba en la página 7). `created_at` + `id` desempatan estable.
   */
  const sortKey = (p: { payment_date?: string | null; created_at?: string | null; due_date?: string | null; id: string }) =>
    `${(p.payment_date || p.created_at || p.due_date || '').slice(0, 10)}|${p.created_at || ''}|${p.id}`;

  // Antes: los 5 primeros `paid` ordenados por due_date (no por fecha de pago),
  // mostrando solo el PADRE y con `method: 'Transferencia'` hardcodeado. Eso hacía
  // que (a) dos atletas de la misma familia con el mismo plan se vieran como filas
  // duplicadas, (b) un pago por Wompi se anunciara como transferencia, y (c) el
  // orden pareciera aleatorio. Ahora: atleta + pagador, origen real, y filtros.
  const allTransactions: Transaction[] = (payments || [])
    .filter(p => p.status === 'paid' || p.status === 'partial')
    .map(p => ({
      id: p.id,
      // La fecha del movimiento es cuándo se pagó; due_date es cuándo se debía.
      date: p.payment_date || p.created_at || p.due_date,
      sortKey: sortKey(p),
      athlete: nameOf(p.student) || nameOf(p.parent) || 'Sin nombre',
      // Solo se muestra el pagador si es alguien distinto del atleta (menores).
      payer: nameOf(p.student) ? nameOf(p.parent) : null,
      concept: p.concept,
      amount: Number(p.status === 'partial' ? (p.amount_paid ?? 0) : p.amount),
      isPartial: p.status === 'partial',
      origin: resolvePaymentOrigin(p as unknown as PaymentOriginInput),
      raw: p as unknown as OrigenDelPagoInput,
    }))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  // Base = solo búsqueda. De acá salen los contadores de las tarjetas de origen,
  // para que el número de cada tarjeta cuadre con lo que muestra la tabla.
  const txBase = allTransactions.filter(t => {
    const term = txSearch.trim().toLowerCase();
    return !term ||
      t.athlete.toLowerCase().includes(term) ||
      (t.payer || '').toLowerCase().includes(term) ||
      (t.concept || '').toLowerCase().includes(term);
  });

  const transactions = txBase.filter(t => txOrigin === 'all' || t.origin.kind === txOrigin);

  const txOriginCounts = txBase.reduce<Record<string, number>>((acc, t) => {
    acc[t.origin.kind] = (acc[t.origin.kind] ?? 0) + 1;
    return acc;
  }, {});

  const txTotalPages = Math.max(1, Math.ceil(transactions.length / TX_PAGE_SIZE));
  const pagedTransactions = transactions.slice((txPage - 1) * TX_PAGE_SIZE, txPage * TX_PAGE_SIZE);
  const txTotal = transactions.reduce((sum, t) => sum + t.amount, 0);

  return (
    <>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-4">
        <p className="text-sm text-muted-foreground">
          Pagos que entraron: pasarela, transferencia, efectivo y QR. La cartera por cobrar está en su propio tab.
        </p>
        <Input
          placeholder="Buscar deportista, acudiente o concepto..."
          value={txSearch}
          onChange={(e) => setTxSearch(e.target.value)}
          className="w-full sm:w-64 h-9"
        />
      </div>
      {/* Filtro por origen en tarjetas. Solo se muestran los orígenes que
          existen en los datos: con los 9 siempre visibles la mayoría
          quedaba en 0 y el filtro se volvía ruido. */}
      <div className="mb-4">
        <StatFilterBar
          columns={4}
          value={txOrigin === 'all' ? null : txOrigin}
          onChange={(v) => setTxOrigin((v as PaymentOriginKind) ?? 'all')}
          items={[
            { key: null, label: 'Todos', value: txBase.length, tone: 'neutral' },
            ...ORIGIN_FILTERS.filter(o => o.value !== 'all').map(o => ({
              key: o.value as PaymentOriginKind,
              label: o.label,
              value: txOriginCounts[o.value] ?? 0,
              tone: ORIGIN_TONES[o.value] ?? 'neutral',
              hidden: (txOriginCounts[o.value] ?? 0) === 0 && txOrigin !== o.value,
            })),
          ]}
        />
      </div>
      {/* Mobile: tarjetas. Una tabla de 5 columnas en un teléfono obliga a
          scrollear en horizontal para leer el monto, que es justo el dato
          que se viene a buscar. */}
      <div className="grid grid-cols-1 gap-3 md:hidden">
        {transactions.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">No hay transacciones con estos filtros.</p>
        ) : pagedTransactions.map((t) => (
          <div key={t.id} className="border rounded-lg p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">{t.athlete}</p>
                {t.payer && <p className="text-xs text-muted-foreground truncate">Paga: {t.payer}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold text-green-500 whitespace-nowrap">${t.amount.toLocaleString('es-CO')}</p>
                {t.isPartial && (
                  <Badge variant="outline" className="text-[10px] py-0 bg-blue-50 text-blue-700 border-blue-200">abono</Badge>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">{t.concept}</p>
            <div className="flex items-center justify-between gap-2">
              <PaymentOriginBadge payment={t.raw} /><PagoOrigenInsignia payment={t.raw} />
              <span className="text-[11px] text-muted-foreground whitespace-nowrap shrink-0">
                {formatDayCO(t.date)}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop */}
      <div className="hidden md:block overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Deportista</TableHead>
              <TableHead>Concepto</TableHead>
              <TableHead>Monto</TableHead>
              <TableHead>Entró por</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  No hay transacciones con estos filtros.
                </TableCell>
              </TableRow>
            ) : pagedTransactions.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {formatDayCO(t.date)}
                </TableCell>
                <TableCell>
                  {/* El deportista es lo que diferencia dos pagos del mismo
                      acudiente: antes solo se veía el padre y dos hijos con
                      el mismo plan parecían la misma fila repetida. */}
                  <div className="flex flex-col">
                    <span className="font-semibold">{t.athlete}</span>
                    {t.payer && <span className="text-xs text-muted-foreground">Paga: {t.payer}</span>}
                  </div>
                </TableCell>
                <TableCell className="text-sm">{t.concept}</TableCell>
                <TableCell className="font-bold text-green-500 whitespace-nowrap">
                  ${t.amount.toLocaleString('es-CO')}
                  {t.isPartial && (
                    <Badge variant="outline" className="ml-1 text-[10px] py-0 h-4 bg-blue-50 text-blue-700 border-blue-200">
                      abono
                    </Badge>
                  )}
                </TableCell>
                <TableCell><div className="flex flex-col items-start gap-1"><PaymentOriginBadge payment={t.raw} /><PagoOrigenInsignia payment={t.raw} /></div></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <TableRefreshBar
        className="-mx-6 -mb-6 mt-2 rounded-b-lg"
        onRefresh={onRefresh}
        loading={refreshing}
        summary={
          `${transactions.length} transacción(es) · $${txTotal.toLocaleString('es-CO')}` +
          (txTotalPages > 1 ? ` · página ${txPage} de ${txTotalPages}` : '')
        }
      >
        {txTotalPages > 1 && (
          <>
            <Button variant="outline" size="sm" disabled={txPage <= 1}
              onClick={() => setTxPage(p => Math.max(1, p - 1))}>Anterior</Button>
            <Button variant="outline" size="sm" disabled={txPage >= txTotalPages}
              onClick={() => setTxPage(p => Math.min(txTotalPages, p + 1))}>Siguiente</Button>
          </>
        )}
      </TableRefreshBar>
    </>
  );
}
