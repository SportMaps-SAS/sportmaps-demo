import { AlertCircle, ScrollText, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  formatCOP,
  formatHM,
  policyLines,
  policyOneLiner,
  type Alternative,
  type CancellationPolicy,
} from './reservarLogic';

export function ErrorBanner({ message, title = 'No fue posible continuar' }: { message: string; title?: string }) {
  return (
    <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 flex items-start gap-3">
      <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden />
      <div className="text-xs">
        <p className="font-bold text-red-900 dark:text-red-200">{title}</p>
        <p className="text-red-800 dark:text-red-300 mt-0.5 leading-relaxed">{message}</p>
      </div>
    </div>
  );
}

export function PolicyBox({ policy, startsAt }: { policy: CancellationPolicy; startsAt?: string }) {
  const isDefault = policy.source === 'default';
  return (
    <section aria-labelledby="politica-titulo" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3.5">
      <div className="flex items-center gap-2 mb-1.5">
        <ScrollText className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />
        <h3 id="politica-titulo" className="text-sm font-bold">Política de cancelación</h3>
        {isDefault && (
          <span className="text-[10px] font-semibold rounded-full border border-border px-2 py-0.5 text-muted-foreground">
            Por defecto
          </span>
        )}
      </div>
      {startsAt && <p className="text-xs font-medium mb-1.5">{policyOneLiner(policy, startsAt)}</p>}
      <ul className="text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
        {policyLines(policy).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {isDefault && (
        <p className="text-[11px] text-muted-foreground mt-1.5 flex gap-1.5">
          <Info className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
          El club no ha publicado una política propia; aplica esta.
        </p>
      )}
    </section>
  );
}

export interface PricingView {
  total: number;
  deposit_min: number;
  breakdown?: { from: string; to: string; rate: number }[];
}

export function PriceBox({ total, depositMin, minDepositPct }: { total: number; depositMin: number; minDepositPct?: number }) {
  const saldo = Math.max(0, total - depositMin);
  return (
    <dl className="rounded-xl border border-border bg-muted/20 p-3.5 text-sm space-y-1.5">
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Precio total</dt>
        <dd className="font-bold">{formatCOP(total)}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">
          Abono mínimo{minDepositPct ? ` (${minDepositPct} %)` : ''}
        </dt>
        <dd className="font-semibold">{formatCOP(depositMin)}</dd>
      </div>
      {depositMin < total && (
        <div className="flex justify-between text-xs">
          <dt className="text-muted-foreground">Saldo a pagar en la sede</dt>
          <dd>{formatCOP(saldo)}</dd>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground pt-1">Sin cargos adicionales: este es el precio final.</p>
    </dl>
  );
}

export function Alternatives({
  items,
  onPick,
}: {
  items: Alternative[];
  onPick: (a: Alternative) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-2" role="group" aria-label="Horarios alternativos">
      <p className="text-xs font-semibold">Estas franjas siguen libres:</p>
      <div className="grid grid-cols-1 gap-2">
        {items.map((a) => (
          <Button
            key={a.starts_at}
            type="button"
            variant="outline"
            className="h-auto py-2.5 justify-between"
            onClick={() => onPick(a)}
          >
            <span className="text-sm font-semibold">{formatHM(a.start_local)} – {formatHM(a.end_local)}</span>
            <span className="text-xs text-muted-foreground">{formatCOP(a.price)}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
