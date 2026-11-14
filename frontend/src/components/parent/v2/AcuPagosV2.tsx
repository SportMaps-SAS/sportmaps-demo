/**
 * Pestaña «Pagos» del acudiente — rediseño V2 (tablero AcuPagos).
 *
 * Solo presenta: los datos, el checkout y los modales viven en MyPaymentsPage,
 * que es quien abre el ÚNICO flujo de pago (PaymentCheckoutModal → sesión
 * firmada por el BFF / comprobante). Este componente nunca calcula lo que se
 * cobra: los valores son de pantalla (ver pagosModel.ts).
 *
 * Carga, vacío y error son tres estados distintos: un error al cargar NUNCA
 * puede verse como «no debes nada» (UX-2).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useOcultarFabSoporte } from '@/lib/supportFab';
import { Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FailedAttemptChip } from '@/components/payment/FailedAttemptChip';
import { cn, formatCurrency } from '@/lib/utils';
import {
  groupTransactions, dueAmount, sumDue, rowTitle, payableDetail, waitingLabel, paidDetail, ajusteNota,
  type Transaction,
} from './pagosModel';

export type PagosLoadState = 'loading' | 'error' | 'ready';
type Tab = 'por-pagar' | 'pagados';

export interface AcuPagosV2Props {
  state: PagosLoadState;
  transactions: Transaction[];
  invoiceMap?: Record<string, { number: string | null; public_url: string | null }>;
  onRetry: () => void;
  /** Abre el flujo de pago existente con los cobros marcados (en orden). */
  onPay: (rows: Transaction[]) => void;
  /** «Ya transferí»: el mismo flujo, para subir el comprobante. */
  onUploadProof: (rows: Transaction[]) => void;
  onShowReceipt: (t: Transaction) => void;
  /** Glosa abierta → botón «Responder». Si devuelve false, no hay botón. */
  canClarify?: (t: Transaction) => boolean;
  onClarify?: (t: Transaction) => void;
  /** Débito automático, «Pagar otro concepto»… (debajo de la lista por pagar). */
  porPagarFooter?: ReactNode;
  /** Estado de cuenta, factura a mi nombre… (debajo de la lista de pagados). */
  pagadosFooter?: ReactNode;
}

export function AcuPagosV2({
  state, transactions, invoiceMap = {}, onRetry, onPay, onUploadProof, onShowReceipt,
  canClarify, onClarify, porPagarFooter, pagadosFooter,
}: AcuPagosV2Props) {
  const [tab, setTab] = useState<Tab>('por-pagar');
  // Lo normal viene marcado: se guarda lo que la familia DESmarcó.
  const [off, setOff] = useState<Set<string>>(() => new Set());

  const { payable, waiting, paid } = useMemo(() => groupTransactions(transactions), [transactions]);
  const marked = payable.filter((t) => !off.has(t.id));
  const totalDebe = sumDue(payable);
  const totalMarcado = sumDue(marked);
  const showBar = state === 'ready' && tab === 'por-pagar' && payable.length > 0;
  // La barra va fija abajo, igual que la burbuja de Mapi: el scroll no los
  // separa y la burbuja tapaba «Ya transferí: subir el comprobante». Mientras se
  // ve la barra, la burbuja se esconde (mismo mecanismo que el buzón de WhatsApp).
  useOcultarFabSoporte(showBar);

  const toggle = (id: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  return (
    <div className={cn('mx-auto w-full max-w-page-narrow space-y-4', showBar ? 'pb-40' : 'pb-6')}>
      <header className="space-y-3">
        <h1 className="text-2xl font-bold">Pagos</h1>
        <div role="tablist" aria-label="Pagos" className="flex gap-1 rounded-xl bg-muted p-1">
          {([['por-pagar', 'Por pagar'], ['pagados', 'Pagados']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                'min-h-touch flex-1 rounded-lg text-sm transition-colors',
                tab === value ? 'bg-background font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {state === 'loading' && (
        <div className="space-y-3" aria-busy="true" aria-label="Cargando tus pagos">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      )}

      {state === 'error' && (
        <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            No pudimos cargar tus pagos
          </p>
          <p className="text-sm text-muted-foreground">
            Esto no quiere decir que estés al día. Revisa tu conexión e inténtalo de nuevo.
          </p>
          <Button variant="outline" className="min-h-touch" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      )}

      {state === 'ready' && tab === 'por-pagar' && (
        <section className="space-y-3" aria-label="Por pagar">
          {payable.length > 0 ? (
            <p className="text-base text-muted-foreground">
              Debes <b className="text-foreground">{formatCurrency(totalDebe)}</b> en {payable.length}{' '}
              {payable.length === 1 ? 'cobro' : 'cobros'}.{payable.length > 1 && ' Lo normal ya viene marcado.'}
            </p>
          ) : waiting.length === 0 ? (
            <div className="rounded-xl border bg-card p-6 text-center">
              <p className="font-semibold">Estás al día</p>
              <p className="mt-1 text-sm text-muted-foreground">No tienes cobros pendientes.</p>
            </div>
          ) : (
            <p className="text-base text-muted-foreground">No tienes cobros por pagar ahora.</p>
          )}

          {payable.map((t) => {
            const on = !off.has(t.id);
            return (
              <div key={t.id} className="space-y-1">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(t.id)}
                  className={cn(
                    'flex min-h-touch w-full items-center gap-3 rounded-xl bg-card px-4 py-3 text-left transition-colors motion-safe:active:scale-[0.98]',
                    on ? 'border-2 border-primary' : 'border border-border',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-md border-2',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 bg-background',
                    )}
                  >
                    {on && <Check className="size-4" strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-semibold">{rowTitle(t)}</span>
                    <span className={cn('text-xs', ['rejected', 'failed'].includes(t.status) ? 'text-destructive' : 'text-muted-foreground')}>
                      {payableDetail(t)}
                    </span>
                    {ajusteNota(t) && <span className="text-xs text-muted-foreground">{ajusteNota(t)}</span>}
                  </span>
                  <span className="whitespace-nowrap text-base font-bold">{formatCurrency(dueAmount(t))}</span>
                </button>
                <FailedAttemptChip
                  reason={t.last_failure_reason}
                  at={t.last_failure_at}
                  requiresReview={t.requires_review}
                  showReason
                />
              </div>
            );
          })}

          {waiting.map((t) => {
            const { label, detail } = waitingLabel(t);
            const clarify = t.status === 'glosado' && canClarify?.(t) && onClarify;
            return (
              <div key={t.id} className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold">{rowTitle(t)}</span>
                  <span className="text-xs text-muted-foreground">{detail}</span>
                  {ajusteNota(t) && <span className="text-xs text-muted-foreground">{ajusteNota(t)}</span>}
                  {clarify && (
                    <Button variant="link" className="min-h-touch h-auto justify-start p-0 text-sm" onClick={() => onClarify(t)}>
                      Responder a la escuela
                    </Button>
                  )}
                </span>
                <span
                  className={cn(
                    'whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold',
                    t.status === 'glosado'
                      ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300'
                      : t.status === 'cancelled'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
                  )}
                >
                  {label}
                </span>
              </div>
            );
          })}

          {porPagarFooter}
        </section>
      )}

      {state === 'ready' && tab === 'pagados' && (
        <section className="space-y-3" aria-label="Pagados">
          {paid.length > 0 ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              {paid.map((t, i) => {
                const invoiceUrl = invoiceMap[t.id]?.public_url;
                return (
                  <div key={t.id} className={cn('flex min-h-touch items-center gap-3 px-4 py-2', i > 0 && 'border-t')}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold">{rowTitle(t)}</span>
                      <span className="text-xs text-muted-foreground">{paidDetail(t)}</span>
                    </span>
                    {invoiceUrl && (
                      <a
                        href={invoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex min-h-touch items-center text-sm font-semibold text-primary"
                      >
                        Factura
                      </a>
                    )}
                    {t.receipt_url && (
                      <button
                        type="button"
                        onClick={() => onShowReceipt(t)}
                        className="flex min-h-touch items-center text-sm font-semibold text-primary"
                      >
                        Recibo
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border bg-card p-6 text-center">
              <p className="font-semibold">Aún no tienes pagos registrados</p>
              <p className="mt-1 text-sm text-muted-foreground">Cuando la escuela apruebe un pago, aparece aquí.</p>
            </div>
          )}
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Si la escuela emite factura electrónica, también te llega al correo.
          </p>
          {pagadosFooter}
        </section>
      )}

      {showBar && (
        <div
          className={cn(
            // Celular: fija encima de la barra inferior. Escritorio: pegada al
            // final del contenido (sticky), nunca encima del menú lateral.
            'fixed inset-x-0 bottom-nav-safe z-40 flex flex-col gap-2 border-t bg-background px-gutter py-3',
            'md:sticky md:inset-x-auto md:bottom-4 md:mt-4 md:rounded-xl md:border md:shadow-lg',
          )}
        >
          <Button
            size="lg"
            className="h-14 w-full rounded-xl text-lg font-semibold"
            disabled={marked.length === 0}
            onClick={() => onPay(marked)}
          >
            {marked.length === 0
              ? 'Marca al menos un cobro'
              : marked.length === 1
                ? `Pagar ${formatCurrency(totalMarcado)}`
                : `Pagar ${marked.length} cobros · ${formatCurrency(totalMarcado)}`}
          </Button>
          {marked.length > 1 && (
            <p className="text-center text-xs text-muted-foreground">Se pagan uno por uno, con el valor de cada cobro.</p>
          )}
          <Button
            variant="link"
            className="min-h-touch h-auto text-sm font-semibold"
            disabled={marked.length === 0}
            onClick={() => onUploadProof(marked)}
          >
            Ya transferí: subir el comprobante
          </Button>
        </div>
      )}
    </div>
  );
}
