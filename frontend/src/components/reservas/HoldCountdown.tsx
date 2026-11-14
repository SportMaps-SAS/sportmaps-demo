import { useEffect, useState } from 'react';
import { CreditCard, Loader2, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import {
  checkoutErrorMessage,
  checkoutUrlOf,
  formatCOP,
  formatCountdown,
  secondsLeft,
  startCheckout,
  type BookingReservation,
} from './reservasApi';

interface HoldCountdownProps {
  reservation: BookingReservation;
  /** Se llama una vez cuando la cuenta llega a cero (la franja se libera). */
  onExpired?: () => void;
}

/** Cuenta regresiva del hold (hold_expires_at) y botón «Pagar» (POST /reservations/:id/checkout). */
export function HoldCountdown({ reservation, onExpired }: HoldCountdownProps) {
  const { toast } = useToast();
  const [left, setLeft] = useState(() => secondsLeft(reservation.hold_expires_at));
  const [paying, setPaying] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    setLeft(secondsLeft(reservation.hold_expires_at));
    const t = setInterval(() => setLeft(secondsLeft(reservation.hold_expires_at)), 1000);
    return () => clearInterval(t);
  }, [reservation.hold_expires_at]);

  const expired = left <= 0;
  useEffect(() => {
    if (expired && reservation.hold_expires_at) onExpired?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  const pay = async () => {
    setPaying(true);
    setInfo(null);
    try {
      const res = await startCheckout(reservation.id);
      const url = checkoutUrlOf(res);
      if (url) {
        window.location.assign(url);
        return;
      }
      setInfo(res?.instructions ?? res?.message ?? 'Pago iniciado. Revisa las instrucciones que te enviamos.');
    } catch (e: any) {
      toast({ title: 'No se pudo iniciar el pago', description: checkoutErrorMessage(e), variant: 'destructive' });
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20" role="status">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Timer className="h-4 w-4 text-amber-600" />
          {expired ? 'La reserva venció' : 'Tu franja está apartada por'}
        </span>
        {!expired && (
          <span className="font-mono text-xl font-bold tabular-nums" data-testid="hold-countdown">
            {formatCountdown(left)}
          </span>
        )}
      </div>
      {expired ? (
        <p className="text-xs text-muted-foreground">
          La franja se liberó porque no se pagó a tiempo. Si ya pagaste, la escuela la confirmará al validar el pago; si no, haz una reserva nueva.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Paga antes de que termine el tiempo o la franja queda libre para otra persona.
            {reservation.deposit_min ? ` Abono mínimo: ${formatCOP(reservation.deposit_min)}.` : ''}
          </p>
          <Button type="button" className="w-full" onClick={pay} disabled={paying}>
            {paying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CreditCard className="mr-2 h-4 w-4" />}
            Pagar
          </Button>
        </>
      )}
      {info && <p className="text-xs text-foreground/80">{info}</p>}
    </div>
  );
}
