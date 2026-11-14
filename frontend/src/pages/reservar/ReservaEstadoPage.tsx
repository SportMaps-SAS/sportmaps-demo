import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, CalendarPlus, CalendarClock, CheckCircle2, Clock, Loader2, Timer, XCircle } from 'lucide-react';
import SlotPicker, { useAvailability } from '@/components/reservar/SlotPicker';
import { Alternatives, ErrorBanner, PolicyBox } from '@/components/reservar/ReservaParts';
import { apiRequest, publicUrl, ReservaApiError } from '@/components/reservar/reservasApi';
import {
  CANCELLABLE, RESCHEDULABLE, bogotaDateKey, buildIcs, computeRefund, formatCOP, formatCountdown,
  formatDayLong, formatRange, msUntil, normalizePolicy, statusView,
  type Alternative, type Slot,
} from '@/components/reservar/reservarLogic';

interface ReservaView {
  id: string;
  status: string;
  payment_status?: string | null;
  starts_at: string;
  ends_at: string;
  facility_id: string;
  facility_name?: string;
  school_id: string;
  school_name?: string;
  hold_expires_at?: string | null;
  price?: number;
  amount_paid?: number;
  deposit_min?: number;
  payment_reference?: string;
  address?: string | null;
}

interface EstadoPayload {
  reservation: ReservaView;
  school?: { name?: string; address?: string | null };
  policy?: unknown;
  cancellation_policy?: unknown;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground py-8 px-4">
      <div className="container max-w-lg mx-auto">{children}</div>
    </main>
  );
}

const TONE: Record<string, string> = {
  ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  wait: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  bad: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30',
  info: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
};

export default function ReservaEstadoPage() {
  const { token } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<EstadoPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const [mode, setMode] = useState<'view' | 'cancel' | 'reschedule'>('view');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<Alternative[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await apiRequest<EstadoPayload>(publicUrl(`/r/${encodeURIComponent(token)}`));
      setPayload(r);
      setFatal(null);
    } catch (e) {
      if (e instanceof ReservaApiError) {
        setFatal(e.view.pending ? 'La consulta de reservas estará disponible pronto.' : e.status === 404 || e.code === 'RESERVATION_NOT_FOUND' ? 'No encontramos esta reserva. Revisa que el enlace esté completo.' : e.view.message);
      } else setFatal('No pudimos cargar tu reserva.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const r = payload?.reservation ?? null;
  const policy = useMemo(() => normalizePolicy(payload?.policy ?? payload?.cancellation_policy), [payload]);

  useEffect(() => {
    const prev = document.title;
    document.title = r?.school_name ?? payload?.school?.name ? `Tu reserva en ${r?.school_name ?? payload?.school?.name} | SportMaps` : 'Tu reserva | SportMaps';
    return () => { document.title = prev; };
  }, [r?.school_name, payload?.school?.name]);

  useEffect(() => {
    if (!r?.hold_expires_at || !['hold', 'pending_payment'].includes(r.status)) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [r?.hold_expires_at, r?.status]);

  const durationMin = r ? Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60000) : null;
  const { facility, loading: loadingSlots, error: slotsError } = useAvailability({
    schoolId: mode === 'reschedule' ? r?.school_id : undefined,
    facilityId: mode === 'reschedule' ? r?.facility_id : undefined,
    durationMin: mode === 'reschedule' ? durationMin : null,
    refreshKey,
  });

  async function act(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setAlternatives([]);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ReservaApiError) {
        setError(e.view.message);
        if (e.code === 'SLOT_TAKEN') {
          setAlternatives(e.alternatives);
          setRefreshKey((k) => k + 1);
        }
      } else setError('No pudimos completar la acción. Intenta de nuevo.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const cancel = () =>
    act(async () => {
      const res = await apiRequest<{ refund?: { pct: number; amount: number } }>(publicUrl(`/r/${encodeURIComponent(token!)}/cancel`), {
        method: 'POST',
        body: reason.trim() ? { reason: reason.trim() } : {},
      });
      setNotice(res.refund && res.refund.amount > 0 ? `Reserva cancelada. Te corresponde una devolución de ${formatCOP(res.refund.amount)} (${res.refund.pct} %); el club la gestionará contigo.` : 'Reserva cancelada.');
      setMode('view');
      await load();
    });

  const reschedule = (s: Slot | null = slot) =>
    act(async () => {
      if (!s) return;
      await apiRequest(publicUrl(`/r/${encodeURIComponent(token!)}/reschedule`), {
        method: 'POST',
        body: { starts_at: s.starts_at, ends_at: s.ends_at },
      });
      setNotice('Listo, reprogramamos tu reserva.');
      setSlot(null);
      setMode('view');
      await load();
    });

  function downloadIcs() {
    if (!r) return;
    const ics = buildIcs({
      uid: r.id,
      title: `Cancha${r.facility_name ? ` · ${r.facility_name}` : ''}${r.school_name ? ` (${r.school_name})` : ''}`,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      location: r.address ?? payload?.school?.address ?? undefined,
      description: r.payment_reference ? `Referencia: ${r.payment_reference}` : undefined,
    });
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'reserva-cancha.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (loading) {
    return (
      <Shell>
        <div className="space-y-4" role="status" aria-label="Cargando">
          <Skeleton className="h-8 w-2/3 mx-auto" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      </Shell>
    );
  }

  if (fatal || !r) {
    return (
      <Shell>
        <Card className="text-center shadow-xl">
          <CardContent className="pt-8 pb-8">
            <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" aria-hidden />
            <h1 className="text-xl font-semibold mb-2">No pudimos mostrar tu reserva</h1>
            <p className="text-muted-foreground text-sm">{fatal}</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const view = statusView(r.status, r.payment_status);
  const isFuture = new Date(r.starts_at).getTime() > now;
  const holdMs = msUntil(r.hold_expires_at, now);
  const inHold = ['hold', 'pending_payment'].includes(r.status) && !!r.hold_expires_at;
  const canCancel = CANCELLABLE.includes(r.status) && isFuture;
  const canResched = RESCHEDULABLE.includes(r.status) && isFuture && !(inHold && holdMs <= 0);
  const refund = computeRefund(policy, r.amount_paid ?? 0, r.starts_at, now);
  const showIcs = ['confirmed', 'pending', 'pending_payment', 'hold'].includes(r.status) && isFuture;

  return (
    <Shell>
      <header className="text-center mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{r.school_name ?? payload?.school?.name ?? 'Tu reserva'}</h1>
        <p className="text-sm text-muted-foreground mt-1">Estado de tu reserva de cancha</p>
      </header>

      <Card className="shadow-xl border-0">
        <CardContent className="p-5 sm:p-6 space-y-4">
          <div className="text-center space-y-2">
            <Badge variant="outline" className={TONE[view.tone]}>
              {view.tone === 'ok' ? <CheckCircle2 className="h-3 w-3 mr-1" aria-hidden /> : view.tone === 'bad' ? <XCircle className="h-3 w-3 mr-1" aria-hidden /> : <Clock className="h-3 w-3 mr-1" aria-hidden />}
              {view.label}
            </Badge>
            <p className="text-sm text-muted-foreground" role="status">{view.text}</p>
          </div>

          {notice && <div role="status" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-900 dark:text-emerald-200">{notice}</div>}

          <dl className="rounded-xl border border-border bg-muted/20 p-3.5 text-sm space-y-2">
            {r.facility_name && <Row k="Cancha" v={r.facility_name} />}
            <Row k="Fecha" v={<span className="capitalize">{formatDayLong(bogotaDateKey(r.starts_at))}</span>} />
            <Row k="Hora (Colombia)" v={formatRange(r.starts_at, r.ends_at)} />
            {typeof r.price === 'number' && <Row k="Precio total" v={formatCOP(r.price)} />}
            {typeof r.amount_paid === 'number' && r.amount_paid > 0 && <Row k="Pagado" v={formatCOP(r.amount_paid)} />}
            {r.payment_reference && <Row k="Referencia" v={r.payment_reference} />}
          </dl>

          {inHold && (
            <div role="timer" className="rounded-xl border border-primary/30 bg-primary/5 p-3 flex items-center gap-2 text-sm">
              <Timer className="h-4 w-4" aria-hidden />
              {holdMs > 0 ? <>Cancha apartada: <strong>{formatCountdown(holdMs)}</strong></> : 'El tiempo para pagar terminó.'}
            </div>
          )}

          <PolicyBox policy={policy} startsAt={r.starts_at} />

          {error && <ErrorBanner message={error} />}
          <Alternatives items={alternatives} onPick={(a) => void reschedule({ ...a, deposit_min: 0 })} />

          {mode === 'view' && (
            <div className="space-y-2">
              {showIcs && (
                <Button variant="outline" className="w-full h-11 gap-2" onClick={downloadIcs}>
                  <CalendarPlus className="h-4 w-4" aria-hidden /> Añadir al calendario
                </Button>
              )}
              {canResched && (
                <Button variant="outline" className="w-full h-11 gap-2" onClick={() => { setNotice(null); setError(null); setMode('reschedule'); }}>
                  <CalendarClock className="h-4 w-4" aria-hidden /> Reprogramar
                </Button>
              )}
              {canCancel && (
                <Button variant="outline" className="w-full h-11 gap-2 text-red-700 dark:text-red-300 border-red-500/40" onClick={() => { setNotice(null); setError(null); setMode('cancel'); }}>
                  <XCircle className="h-4 w-4" aria-hidden /> Cancelar reserva
                </Button>
              )}
            </div>
          )}

          {mode === 'cancel' && (
            <div className="space-y-3 rounded-xl border border-red-500/30 p-4" role="group" aria-label="Confirmar cancelación">
              <h2 className="font-bold text-sm">¿Cancelar esta reserva?</h2>
              {(r.amount_paid ?? 0) > 0 ? (
                <p className="text-sm">
                  Según la política, te devolvemos <strong>{formatCOP(refund.amount)}</strong> ({refund.pct} % de lo pagado).
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">No has pagado nada, así que no hay devolución.</p>
              )}
              <label htmlFor="rs-motivo" className="text-xs font-semibold">Motivo (opcional)</label>
              <textarea id="rs-motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} className="w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" />
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => setMode('view')} disabled={busy}>Mantener</Button>
                <Button variant="destructive" onClick={() => void cancel()} disabled={busy}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden />} Sí, cancelar
                </Button>
              </div>
            </div>
          )}

          {mode === 'reschedule' && (
            <div className="space-y-3">
              <h2 className="font-bold text-sm">Elige la nueva hora</h2>
              <SlotPicker
                facility={facility}
                loading={loadingSlots}
                error={slotsError}
                selected={slot}
                onSelect={setSlot}
                duration={durationMin}
                lockedDuration={durationMin ?? undefined}
              />
              <p className="text-[11px] text-muted-foreground">Reprogramar no tiene costo: conservas tu precio. Solo es posible dentro del plazo de devolución total.</p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => { setMode('view'); setSlot(null); }} disabled={busy}>Volver</Button>
                <Button onClick={() => void reschedule()} disabled={busy || !slot}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden />} Confirmar cambio
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-semibold text-right">{v}</dd>
    </div>
  );
}
