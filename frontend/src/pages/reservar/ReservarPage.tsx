import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertCircle, ArrowLeft, ArrowRight, Building2, CalendarCheck, CheckCircle2, Clock, CreditCard,
  Landmark, Loader2, MapPin, ShieldCheck, Timer, Users,
} from 'lucide-react';
import SlotPicker, { useAvailability } from '@/components/reservar/SlotPicker';
import { Alternatives, ErrorBanner, PolicyBox, PriceBox } from '@/components/reservar/ReservaParts';
import { apiRequest, publicUrl, RESERVATIONS_BASE, ReservaApiError } from '@/components/reservar/reservasApi';
import { safeRedirectUrl } from '@/lib/safeRedirect';
import {
  formatCountdown, formatCOP, formatDayLong, formatDuration, formatRange, bogotaDateKey, idempotencyKeyFor,
  isValidEmail, msUntil, newIdemStore, normalizeCoPhone, normalizePolicy, summarySignature,
  type Alternative, type CancellationPolicy, type Slot,
} from '@/components/reservar/reservarLogic';

interface FacilityInfo {
  id: string;
  name: string;
  type: string;
  capacity?: number;
  address?: string | null;
  photos?: string[] | null;
  booking_enabled?: boolean | null;
}

interface SchoolPayload {
  school: { id: string; name: string; slug?: string; logo_url?: string | null; city?: string | null; description?: string | null; cancellation_policy?: unknown };
  facilities: FacilityInfo[];
  cancellation_policy?: unknown;
}

interface ReservationOut {
  id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  hold_expires_at: string | null;
  payment_reference?: string;
  price: number;
  deposit_min: number;
  public_token?: string;
  token?: string;
}

type Step = 'slots' | 'datos' | 'codigo' | 'resumen' | 'transferencia' | 'confirmada';
type Method = 'online' | 'transfer';

const sportLabel = (t: string) => (t || 'Cancha').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export default function ReservarPage() {
  const { slug } = useParams<{ slug: string }>();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SchoolPayload | null>(null);
  const [closedMsg, setClosedMsg] = useState<string | null>(null);

  const [sport, setSport] = useState<string | null>(null);
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [slot, setSlot] = useState<Slot | null>(null);

  const [step, setStep] = useState<Step>('slots');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [guestId, setGuestId] = useState<string | null>(null);
  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>('online');
  const [participants, setParticipants] = useState(1);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<Alternative[]>([]);
  const [reservation, setReservation] = useState<ReservationOut | null>(null);
  const [checkoutFailed, setCheckoutFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const idemRef = useRef(newIdemStore());
  const [idemKey, setIdemKey] = useState<string | null>(null);

  // ── Cargar escuela ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!slug) return;
    const ctrl = new AbortController();
    setLoading(true);
    apiRequest<SchoolPayload>(publicUrl(`/schools/${encodeURIComponent(slug)}`), { signal: ctrl.signal })
      .then((r) => {
        const facs = (r.facilities ?? []).filter((f) => f.booking_enabled !== false);
        setData({ ...r, facilities: facs });
        if (!facs.length) setClosedMsg('Este club no recibe reservas en línea por ahora.');
        if (facs.length === 1) setFacilityId(facs[0].id);
      })
      .catch((e) => {
        if ((e as Error)?.name === 'AbortError') return;
        if (e instanceof ReservaApiError && e.view.pending) setClosedMsg('Las reservas en línea estarán disponibles pronto.');
        else setClosedMsg('Este espacio ya no está disponible o no recibe reservas.');
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [slug]);

  // ── SEO básico ─────────────────────────────────────────────────────────────
  const clubName = data?.school.name;
  useEffect(() => {
    const prevTitle = document.title;
    document.title = clubName ? `Reserva tu cancha en ${clubName} | SportMaps` : 'Reserva tu cancha | SportMaps';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    const prevDesc = meta.content;
    meta.content = clubName
      ? `Reserva y paga tu cancha en ${clubName} sin crear cuenta. Mira horarios libres y precios al instante.`
      : 'Reserva y paga tu cancha sin crear cuenta.';
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (meta) meta.content = prevDesc;
    };
  }, [clubName]);

  // ── Derivados ───────────────────────────────────────────────────────────────
  const sports = useMemo(() => [...new Set((data?.facilities ?? []).map((f) => f.type))], [data]);
  const facilitiesForSport = useMemo(
    () => (data?.facilities ?? []).filter((f) => !sport || f.type === sport),
    [data, sport],
  );
  const facilityInfo = data?.facilities.find((f) => f.id === facilityId) ?? null;
  const policy: CancellationPolicy = useMemo(
    () => normalizePolicy(data?.cancellation_policy ?? data?.school.cancellation_policy),
    [data],
  );

  const { facility, loading: loadingSlots, error: slotsError } = useAvailability({
    schoolId: data?.school.id,
    facilityId: facilityId ?? undefined,
    durationMin: duration,
    refreshKey,
  });

  useEffect(() => {
    if (facility && duration === null) setDuration(facility.duration_min);
  }, [facility, duration]);

  // Cuenta regresiva del apartado
  useEffect(() => {
    if (!reservation?.hold_expires_at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [reservation?.hold_expires_at]);
  const holdMs = reservation ? msUntil(reservation.hold_expires_at, now) : 0;
  const holdExpired = !!reservation?.hold_expires_at && holdMs <= 0;

  // ── Acciones ────────────────────────────────────────────────────────────────
  const resetToSlots = useCallback(() => {
    setReservation(null);
    setSlot(null);
    setAlternatives([]);
    setError(null);
    setCheckoutFailed(false);
    setStep('slots');
    setRefreshKey((k) => k + 1);
  }, []);

  function pickFacility(id: string) {
    setFacilityId(id);
    setDuration(null);
    setSlot(null);
  }

  async function startVerification() {
    if (busyRef.current) return;
    const normPhone = normalizeCoPhone(phone);
    if (fullName.trim().length < 3) return setError('Escribe tu nombre completo.');
    if (!normPhone) return setError('Escribe un WhatsApp válido de Colombia, por ejemplo 300 123 4567.');
    if (!isValidEmail(email)) return setError('Escribe un correo válido.');
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ guest_id?: string; id?: string }>(publicUrl('/guests/start'), {
        method: 'POST',
        body: { phone: normPhone, full_name: fullName.trim(), email: email.trim() },
      });
      setGuestId(r.guest_id ?? r.id ?? null);
      setCode('');
      setStep('codigo');
    } catch (e) {
      if (e instanceof ReservaApiError && e.view.pending) setError('La verificación por WhatsApp aún está pendiente de activar. Intenta más tarde.');
      else setError(e instanceof ReservaApiError ? e.view.message : 'No pudimos enviar el código.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (busyRef.current || code.length < 4) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await apiRequest<{ guest_token: string }>(publicUrl('/guests/verify'), {
        method: 'POST',
        body: guestId ? { guest_id: guestId, code } : { email: email.trim(), code },
      });
      setGuestToken(r.guest_token);
      openSummary();
    } catch (e) {
      setError(e instanceof ReservaApiError ? e.view.message : 'No pudimos verificar el código.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** Abre el resumen: aquí se genera la llave de idempotencia (y se reutiliza en reintentos). */
  function openSummary(nextSlot: Slot | null = slot, nextMethod: Method = method) {
    if (!nextSlot || !facilityId) return;
    const key = idempotencyKeyFor(
      idemRef.current,
      summarySignature({ facilityId, startsAt: nextSlot.starts_at, endsAt: nextSlot.ends_at, paymentMethod: nextMethod }),
    );
    setIdemKey(key);
    setStep('resumen');
  }

  function changeMethod(m: Method) {
    setMethod(m);
    if (step === 'resumen') openSummary(slot, m);
  }

  function pickAlternative(a: Alternative) {
    const s: Slot = {
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      start_local: a.start_local,
      end_local: a.end_local,
      price: a.price,
      deposit_min: Math.round((a.price * (facility?.min_deposit_pct ?? 100)) / 100),
    };
    setSlot(s);
    setAlternatives([]);
    setError(null);
    setReservation(null);
    openSummary(s, method);
  }

  async function checkout(res: ReservationOut) {
    try {
      const r = await apiRequest<{ checkout_url: string }>(`${RESERVATIONS_BASE}/${res.id}/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${guestToken}` },
        body: {},
      });
      setCheckoutFailed(false);
      const dest = safeRedirectUrl(r.checkout_url);
      if (!dest) throw new Error('checkout_url inválida');
      window.location.assign(dest);
    } catch (e) {
      setCheckoutFailed(true);
      setError(
        e instanceof ReservaApiError && e.view.pending
          ? 'El pago en línea estará disponible pronto. Tu cancha sigue apartada: puedes pagar por transferencia.'
          : e instanceof ReservaApiError
            ? e.view.message
            : 'No pudimos abrir el pago.',
      );
    }
  }

  async function submit() {
    if (busyRef.current || !slot || !facilityId || !guestToken || !idemKey) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setAlternatives([]);
    try {
      let res = reservation;
      if (!res || res.starts_at !== slot.starts_at) {
        const r = await apiRequest<{ reservation: ReservationOut; requires_payment: boolean }>(publicUrl(''), {
          method: 'POST',
          headers: { 'Idempotency-Key': idemKey, Authorization: `Bearer ${guestToken}` },
          body: {
            facility_id: facilityId,
            starts_at: slot.starts_at,
            ends_at: slot.ends_at,
            payment_method: method,
            participants,
          },
        });
        res = r.reservation;
        setReservation(res);
        if (!r.requires_payment) {
          setStep('confirmada');
          return;
        }
      }
      if (method === 'online') await checkout(res);
      else setStep('transferencia');
    } catch (e) {
      if (e instanceof ReservaApiError) {
        setError(e.view.message);
        if (e.code === 'SLOT_TAKEN') {
          setAlternatives(e.alternatives);
          setRefreshKey((k) => k + 1);
        }
      } else setError('No pudimos crear la reserva. Intenta de nuevo.');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <Shell>
        <div className="space-y-4" role="status" aria-label="Cargando">
          <Skeleton className="h-8 w-2/3 mx-auto" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </Shell>
    );
  }

  if (closedMsg || !data) {
    return (
      <Shell>
        <Card className="text-center shadow-xl">
          <CardContent className="pt-8 pb-8">
            <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" aria-hidden />
            <h1 className="text-xl font-semibold mb-2">Espacio no disponible</h1>
            <p className="text-muted-foreground text-sm">{closedMsg ?? 'Este espacio ya no está disponible o no recibe reservas.'}</p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const back = (to: Step) => (
    <button
      type="button"
      onClick={() => { setError(null); setStep(to); }}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors mb-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Volver
    </button>
  );

  const slotSummary = slot && (
    <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 text-sm">
      <p className="font-semibold">{facilityInfo?.name}</p>
      <p className="text-xs text-muted-foreground capitalize">
        {formatDayLong(bogotaDateKey(slot.starts_at))} · {formatRange(slot.starts_at, slot.ends_at)}
      </p>
    </div>
  );

  return (
    <Shell>
      <header className="text-center mb-6">
        {data.school.logo_url ? (
          <img src={data.school.logo_url} alt="" className="w-14 h-14 rounded-2xl object-cover mx-auto mb-3" />
        ) : (
          <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-3">
            <Building2 className="h-7 w-7 text-primary" aria-hidden />
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight">{data.school.name}</h1>
        <p className="text-sm text-muted-foreground mt-1">Reserva tu cancha sin crear cuenta</p>
      </header>

      <Card className="shadow-xl border-0">
        <CardContent className="p-5 sm:p-6 space-y-4">
          {/* ── Elegir cancha y hora ── */}
          {step === 'slots' && (
            <>
              {sports.length > 1 && (
                <fieldset>
                  <legend className="text-xs font-semibold text-muted-foreground mb-2">Deporte</legend>
                  <div className="flex flex-wrap gap-2">
                    {[null, ...sports].map((s) => (
                      <button
                        key={s ?? 'todos'}
                        type="button"
                        aria-pressed={sport === s}
                        onClick={() => { setSport(s); setFacilityId(null); setSlot(null); }}
                        className={`px-3 h-9 rounded-full border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          sport === s ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:border-primary/40'
                        }`}
                      >
                        {s ? sportLabel(s) : 'Todos'}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {facilitiesForSport.length > 1 && (
                <fieldset>
                  <legend className="text-xs font-semibold text-muted-foreground mb-2">Cancha</legend>
                  <div className="space-y-2">
                    {facilitiesForSport.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={facilityId === f.id}
                        onClick={() => pickFacility(f.id)}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                          facilityId === f.id ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                        }`}
                      >
                        <span>
                          <span className="block font-semibold text-sm">{f.name}</span>
                          <span className="block text-xs text-muted-foreground">{sportLabel(f.type)}{f.address ? ` · ${f.address}` : ''}</span>
                        </span>
                        {f.capacity ? <Badge variant="outline" className="gap-1"><Users className="h-3 w-3" aria-hidden />{f.capacity}</Badge> : null}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}

              {facilityId ? (
                <>
                  {facilityInfo?.address && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden />{facilityInfo.address}</p>
                  )}
                  <SlotPicker
                    facility={facility}
                    loading={loadingSlots}
                    error={slotsError}
                    selected={slot}
                    onSelect={setSlot}
                    duration={duration}
                    onDurationChange={(d) => { setDuration(d); setSlot(null); }}
                  />
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-6">Elige una cancha para ver los horarios libres.</p>
              )}

              {slot && (
                <div className="sticky bottom-3 space-y-2 rounded-xl bg-background/95 backdrop-blur border border-border p-3 shadow-lg">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">{formatRange(slot.starts_at, slot.ends_at)}</span>
                    <span className="font-bold">{formatCOP(slot.price)}</span>
                  </div>
                  <Button className="w-full h-11 gap-2" onClick={() => { setError(null); setStep(guestToken ? 'resumen' : 'datos'); if (guestToken) openSummary(); }}>
                    Continuar <ArrowRight className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ── Tus datos ── */}
          {step === 'datos' && (
            <form onSubmit={(e) => { e.preventDefault(); void startVerification(); }} className="space-y-4" noValidate>
              {back('slots')}
              {slotSummary}
              <div>
                <h2 className="font-bold text-lg">Tus datos</h2>
                <p className="text-xs text-muted-foreground mt-1">Te enviaremos un código por WhatsApp para confirmar que el número es tuyo.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-nombre">Nombre completo</Label>
                <Input id="rs-nombre" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-12" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-tel">WhatsApp</Label>
                <Input id="rs-tel" type="tel" inputMode="tel" autoComplete="tel" placeholder="300 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} className="h-12" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rs-correo">Correo electrónico</Label>
                <Input id="rs-correo" type="email" autoComplete="email" placeholder="tu@correo.com" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12" />
              </div>
              {error && <ErrorBanner message={error} />}
              <Button type="submit" disabled={busy} className="w-full h-12 gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
                Enviar código
              </Button>
            </form>
          )}

          {/* ── Código ── */}
          {step === 'codigo' && (
            <form onSubmit={(e) => { e.preventDefault(); void verifyCode(); }} className="space-y-4">
              {back('datos')}
              <div className="text-center">
                <ShieldCheck className="h-8 w-8 text-primary mx-auto mb-2" aria-hidden />
                <h2 className="font-bold text-lg">Escribe el código</h2>
                <p className="text-xs text-muted-foreground mt-1">Lo enviamos a tu WhatsApp (o a tu correo si no te llega).</p>
              </div>
              <Label htmlFor="rs-codigo" className="sr-only">Código de verificación</Label>
              <Input
                id="rs-codigo"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="h-14 text-center text-2xl tracking-[0.5em] font-bold"
              />
              {error && <ErrorBanner message={error} />}
              <Button type="submit" disabled={busy || code.length < 4} className="w-full h-12 gap-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                Verificar
              </Button>
              <button type="button" onClick={() => void startVerification()} disabled={busy} className="w-full text-xs text-muted-foreground hover:text-primary">
                ¿No te llegó? Enviar otro código
              </button>
            </form>
          )}

          {/* ── Resumen ── */}
          {step === 'resumen' && slot && (
            <div className="space-y-4">
              {!reservation && back('slots')}
              <h2 className="font-bold text-lg">Resumen de tu reserva</h2>
              {slotSummary}
              {facility && <p className="text-xs text-muted-foreground">Duración: {formatDuration(duration ?? facility.duration_min)}</p>}

              <PriceBox total={reservation?.price ?? slot.price} depositMin={reservation?.deposit_min ?? slot.deposit_min} minDepositPct={facility?.min_deposit_pct} />

              {!reservation && (
                <fieldset>
                  <legend className="text-xs font-semibold text-muted-foreground mb-2">Forma de pago</legend>
                  <div className="grid grid-cols-2 gap-2">
                    {([['online', 'En línea', 'Tarjeta, PSE, Nequi', CreditCard], ['transfer', 'Transferencia', 'Nequi, Bre-B, banco', Landmark]] as const).map(([v, t, d, Icon]) => (
                      <button
                        key={v}
                        type="button"
                        aria-pressed={method === v}
                        onClick={() => changeMethod(v)}
                        className={`p-3 rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${method === v ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}
                      >
                        <Icon className="h-4 w-4 text-primary mb-1" aria-hidden />
                        <span className="block text-sm font-semibold">{t}</span>
                        <span className="block text-[11px] text-muted-foreground">{d}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {method === 'online'
                      ? 'Apartamos la cancha 10 minutos mientras pagas.'
                      : 'Apartamos la cancha 15 minutos: en ese plazo debe llegar tu comprobante o la hora se libera.'}
                  </p>
                </fieldset>
              )}

              {!reservation && (
                <div className="space-y-1.5 max-w-[10rem]">
                  <Label htmlFor="rs-part">Jugadores</Label>
                  <Input id="rs-part" type="number" min={1} max={facilityInfo?.capacity ?? 50} value={participants} onChange={(e) => setParticipants(Math.max(1, Number(e.target.value) || 1))} className="h-11" />
                </div>
              )}

              {/* La política va A LA VISTA, antes del botón de pago */}
              <PolicyBox policy={policy} startsAt={slot.starts_at} />

              {reservation?.hold_expires_at && (
                <div role="timer" aria-live="off" className={`rounded-xl border p-3 flex items-center gap-2 text-sm ${holdExpired ? 'border-red-500/30 bg-red-500/10' : 'border-primary/30 bg-primary/5'}`}>
                  <Timer className="h-4 w-4" aria-hidden />
                  {holdExpired ? 'El tiempo para pagar terminó y la cancha se liberó.' : <>Cancha apartada: <strong>{formatCountdown(holdMs)}</strong></>}
                </div>
              )}

              {error && <ErrorBanner message={error} />}
              <Alternatives items={alternatives} onPick={pickAlternative} />

              {holdExpired ? (
                <Button className="w-full h-12" onClick={resetToSlots}>Elegir otra hora</Button>
              ) : (
                <Button className="w-full h-12 gap-2" disabled={busy} onClick={() => void submit()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : method === 'online' ? <CreditCard className="h-4 w-4" aria-hidden /> : <Landmark className="h-4 w-4" aria-hidden />}
                  {checkoutFailed ? 'Reintentar pago' : method === 'online' ? `Pagar ${formatCOP(reservation?.deposit_min ?? slot.deposit_min)}` : 'Apartar y pagar por transferencia'}
                </Button>
              )}
              <p className="text-[11px] text-center text-muted-foreground">Al continuar aceptas la política de cancelación de arriba.</p>
            </div>
          )}

          {/* ── Transferencia ── */}
          {step === 'transferencia' && reservation && (
            <div className="space-y-4 text-center">
              <Clock className="h-9 w-9 text-amber-600 mx-auto" aria-hidden />
              <h2 className="font-bold text-xl">Cancha apartada</h2>
              {reservation.hold_expires_at && (
                <p role="timer" className="text-sm">{holdExpired ? 'El plazo terminó y la cancha se liberó.' : <>Tienes <strong>{formatCountdown(holdMs)}</strong> para enviar tu comprobante.</>}</p>
              )}
              <p className="text-xs text-muted-foreground leading-relaxed">
                El club te escribirá por WhatsApp con los datos para transferir {formatCOP(reservation.deposit_min)}.
                Referencia de pago: <strong>{reservation.payment_reference ?? '—'}</strong>.
              </p>
              <ManageLink reservation={reservation} />
              {holdExpired && <Button className="w-full h-11" onClick={resetToSlots}>Elegir otra hora</Button>}
            </div>
          )}

          {/* ── Confirmada sin pago ── */}
          {step === 'confirmada' && reservation && (
            <div className="space-y-4 text-center">
              <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto border border-emerald-500/20">
                <CalendarCheck className="h-8 w-8 text-emerald-600" aria-hidden />
              </div>
              <h2 className="font-bold text-xl">¡Reserva confirmada!</h2>
              <p className="text-sm text-muted-foreground capitalize">
                {formatDayLong(bogotaDateKey(reservation.starts_at))} · {formatRange(reservation.starts_at, reservation.ends_at)}
              </p>
              <ManageLink reservation={reservation} />
            </div>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background text-foreground py-8 px-4">
      <div className="container max-w-lg mx-auto">{children}</div>
    </main>
  );
}

function ManageLink({ reservation }: { reservation: ReservationOut }) {
  const token = reservation.public_token ?? reservation.token;
  if (!token) return <p className="text-xs text-muted-foreground">Te enviaremos por WhatsApp el enlace para ver, cancelar o reprogramar tu reserva.</p>;
  return (
    <Button asChild variant="outline" className="w-full h-11">
      <Link to={`/r/${encodeURIComponent(token)}`}>Ver, cancelar o reprogramar mi reserva</Link>
    </Button>
  );
}
