import { useState, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { esMenorDeEdad } from '@/lib/invitations/contactoFicha';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Clock,
  Users,
  CheckCircle2,
  CalendarCheck,
  DollarSign,
  Loader2,
  MessageCircle,
  Mail,
  Info,
} from 'lucide-react';
import { format, addDays, isBefore, startOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { SlotGrid } from '@/components/reservas/SlotGrid';
import { HoldCountdown } from '@/components/reservas/HoldCountdown';
import { useAvailability, useCancellationPolicy } from '@/components/reservas/reservasHooks';
import {
  MINOR_MESSAGE,
  bookingSignature,
  createBooking,
  createIdempotencyHolder,
  describeCancellationPolicy,
  dropStartedSlots,
  durationOptions,
  findFacilityAvailability,
  formatCOP,
  formatDuration,
  parseBookingError,
  pickDaySlots,
  slotFromAlternative,
  type AvailabilitySlot,
  type BookingAlternative,
  type BookingResult,
  type CreateBookingBody,
  type PaymentMethod,
} from '@/components/reservas/reservasApi';

interface Facility {
  id: string;
  school_id?: string;
  name: string;
  type: string;
  capacity: number;
  hourly_rate?: number;
  booking_enabled?: boolean;
  available_hours?: Record<string, string[]>;
}

interface FacilityReservationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facility: Facility | null;
  schoolName: string;
  schoolPhone?: string | null;
  schoolEmail?: string | null;
}

type Step = 'date' | 'time' | 'confirm' | 'done';

const PAYMENT_LABELS: Record<'online' | 'transfer', string> = {
  online: 'Pago en línea (tarjeta, PSE, Nequi…)',
  transfer: 'Transferencia bancaria',
};

export function FacilityReservationModal({
  open,
  onOpenChange,
  facility,
  schoolName,
  schoolPhone,
  schoolEmail,
}: FacilityReservationModalProps) {
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();

  const [selectedDate, setSelectedDate] = useState<Date | undefined>(addDays(new Date(), 1));
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'transfer'>('online');
  const [step, setStep] = useState<Step>('date');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<BookingAlternative[]>([]);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [summaryKey, setSummaryKey] = useState<string | null>(null);
  const idem = useRef(createIdempotencyHolder());
  const submittingRef = useRef(false);

  // Los menores no reservan: reserva su acudiente. Solo se bloquea si el perfil
  // trae fecha de nacimiento y es menor de 18; sin fecha no se inventa nada
  // (el servidor hace cumplir la regla de fondo: MINOR_CANNOT_BOOK).
  const isMinor = esMenorDeEdad(profile?.date_of_birth) === true;

  const schoolId = facility?.school_id ?? null;
  const day = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
  const availabilityQuery = useAvailability(
    schoolId && day && facility
      ? { school_id: schoolId, from: day, to: day, facility_id: facility.id, duration_min: duration }
      : null,
    open && !!facility && !!schoolId && !!day && step !== 'done',
  );
  const facAvail = findFacilityAvailability(availabilityQuery.data, facility?.id ?? '');
  const durations = useMemo(() => durationOptions(facAvail), [facAvail]);
  const slots = useMemo(
    () => dropStartedSlots(pickDaySlots(availabilityQuery.data, facility?.id ?? '', day ?? '')),
    [availabilityQuery.data, facility?.id, day],
  );
  const policyQuery = useCancellationPolicy(schoolId, facility?.id);

  const body: CreateBookingBody | null = useMemo(() => {
    if (!facility || !selectedSlot) return null;
    return {
      facility_id: facility.id,
      starts_at: selectedSlot.starts_at,
      ends_at: selectedSlot.ends_at,
      payment_method: paymentMethod as PaymentMethod,
    };
  }, [facility, selectedSlot, paymentMethod]);

  // La llave de idempotencia nace al abrir el resumen y se reusa en reintentos/doble tap.
  useEffect(() => {
    if (step === 'confirm' && body) setSummaryKey(idem.current.forSummary(bookingSignature(body)));
    else if (step !== 'confirm') setSummaryKey(null);
  }, [step, body]);

  const resetState = () => {
    setSelectedDate(addDays(new Date(), 1));
    setSelectedSlot(null);
    setDuration(null);
    setPaymentMethod('online');
    setStep('date');
    setError(null);
    setAlternatives([]);
    setResult(null);
    setSummaryKey(null);
    idem.current.reset();
  };

  // Al cerrar se limpia, salvo que se esté mostrando el resultado (el hold sigue corriendo en el servidor).
  useEffect(() => {
    if (!open) resetState();
  }, [open]);

  const isDateDisabled = (date: Date) => isBefore(date, startOfDay(new Date()));

  const applyAlternative = (a: BookingAlternative) => {
    setSelectedSlot(slotFromAlternative(a, selectedSlot?.deposit_min ?? 0));
    setError(null);
    setAlternatives([]);
  };

  const submit = async () => {
    if (!body || !user || submittingRef.current) return;
    if (isMinor) {
      setError(MINOR_MESSAGE);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setAlternatives([]);
    try {
      const key = summaryKey ?? idem.current.forSummary(bookingSignature(body));
      const res = await createBooking(body, key);
      idem.current.reset();
      setResult(res);
      setStep('done');
      queryClient.invalidateQueries({ queryKey: ['school-facility-reservations'] });
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
    } catch (e: unknown) {
      const info = parseBookingError(e);
      setError(info.message);
      if (info.code === 'SLOT_TAKEN') {
        setAlternatives(info.alternatives);
        queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!facility) return null;

  const price = selectedSlot?.price ?? 0;
  const deposit = selectedSlot?.deposit_min ?? 0;
  const status = result?.reservation.status;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-poppins">
            <CalendarCheck className="h-5 w-5 text-primary" />
            Reservar Práctica Libre
          </DialogTitle>
          <DialogDescription className="font-poppins">
            {facility.name} • {schoolName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Step Indicator */}
          {step !== 'done' && (
            <div className="flex items-center justify-center gap-2">
              {['date', 'time', 'confirm'].map((s, i) => (
                <div key={s} className="flex items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    step === s
                      ? 'bg-primary text-white'
                      : i < ['date', 'time', 'confirm'].indexOf(step)
                        ? 'bg-primary/20 text-primary'
                        : 'bg-muted text-muted-foreground'
                  }`}>
                    {i + 1}
                  </div>
                  {i < 2 && <div className="w-8 h-0.5 bg-muted mx-1" />}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive space-y-2" role="alert">
              <p>{error}</p>
              {alternatives.length > 0 && (
                <div className="flex flex-wrap gap-2" data-testid="slot-alternatives">
                  {alternatives.map((a) => (
                    <Button key={a.starts_at} type="button" size="sm" variant="outline" className="bg-background text-foreground" onClick={() => applyAlternative(a)}>
                      {a.start_local} – {a.end_local}{a.price > 0 ? ` · ${formatCOP(a.price)}` : ''}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Step: Select Date */}
          {step === 'date' && (
            <div className="space-y-4">
              <h3 className="font-semibold text-center font-poppins">Selecciona la fecha</h3>
              <div className="flex justify-center">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(d) => { setSelectedDate(d); setSelectedSlot(null); }}
                  disabled={isDateDisabled}
                  locale={es}
                  className="rounded-md border"
                />
              </div>
              <Button className="w-full" onClick={() => setStep('time')} disabled={!selectedDate}>
                Continuar
              </Button>
            </div>
          )}

          {/* Step: Select Time */}
          {step === 'time' && (
            <div className="space-y-4">
              <div className="text-center">
                <h3 className="font-semibold font-poppins">Selecciona la hora</h3>
                <p className="text-sm text-muted-foreground">
                  {selectedDate && format(selectedDate, 'PPPP', { locale: es })}
                </p>
              </div>

              {!schoolId ? (
                <p className="text-sm text-destructive">No pudimos identificar la escuela de esta instalación. Recarga la página.</p>
              ) : (
                <>
                  {durations.length > 1 && (
                    <div className="flex items-center gap-3">
                      <Label className="text-xs font-semibold">Duración</Label>
                      <Select
                        value={String(duration ?? facAvail?.duration_min ?? durations[0])}
                        onValueChange={(v) => { setDuration(Number(v)); setSelectedSlot(null); }}
                      >
                        <SelectTrigger className="h-9 w-40" aria-label="Duración"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {durations.map((d) => <SelectItem key={d} value={String(d)}>{formatDuration(d)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <SlotGrid
                    slots={slots}
                    selectedStartsAt={selectedSlot?.starts_at ?? null}
                    onSelect={(s) => { setSelectedSlot(s); setError(null); setAlternatives([]); }}
                    loading={availabilityQuery.isFetching}
                    errorMessage={availabilityQuery.isError ? parseBookingError(availabilityQuery.error).message : null}
                    emptyText={
                      availabilityQuery.data && !facAvail
                        ? 'Esta instalación no recibe reservas de tu tipo de usuario o no está disponible.'
                        : undefined
                    }
                  />
                </>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep('date')} className="flex-1">
                  Atrás
                </Button>
                <Button onClick={() => setStep('confirm')} disabled={!selectedSlot} className="flex-1">
                  Continuar
                </Button>
              </div>
            </div>
          )}

          {/* Step: Confirm */}
          {step === 'confirm' && selectedSlot && (
            <div className="space-y-4">
              <Card className="border-primary/20">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Instalación</span>
                    <span className="font-semibold">{facility.name}</span>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <CalendarCheck className="h-4 w-4" />
                      Fecha
                    </span>
                    <span className="font-semibold">
                      {selectedDate && format(selectedDate, 'PPP', { locale: es })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      Hora
                    </span>
                    <span className="font-semibold">{selectedSlot.start_local} - {selectedSlot.end_local}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      Capacidad
                    </span>
                    <span className="font-semibold">{facility.capacity} personas</span>
                  </div>
                  <Separator />
                  {/* Desglose del precio: el que calculó el servidor para esta franja */}
                  <div className="space-y-1.5 text-sm" data-testid="price-breakdown">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">
                        Tarifa {facAvail?.audience === 'member' ? 'de socio' : 'pública'}
                      </span>
                      <span>{price > 0 ? formatCOP(price) : 'Sin costo'}</span>
                    </div>
                    {price > 0 && deposit > 0 && deposit < price && (
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Abono mínimo para confirmar</span>
                        <span>{formatCOP(deposit)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-lg">
                    <span className="font-semibold flex items-center gap-2">
                      <DollarSign className="h-5 w-5 text-primary" />
                      Total
                    </span>
                    <span className="font-bold text-primary">{price > 0 ? formatCOP(price) : 'Sin costo'}</span>
                  </div>
                </CardContent>
              </Card>

              {price > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Forma de pago</Label>
                  <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as 'online' | 'transfer')}>
                    <SelectTrigger aria-label="Forma de pago"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(PAYMENT_LABELS) as Array<'online' | 'transfer'>).map((k) => (
                        <SelectItem key={k} value={k}>{PAYMENT_LABELS[k]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Apartamos la franja {paymentMethod === 'online' ? '10' : '15'} minutos mientras pagas; si no se paga a tiempo, queda libre.
                  </p>
                </div>
              )}

              {isMinor && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                  {MINOR_MESSAGE}
                </div>
              )}

              <div className="flex gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs text-muted-foreground" data-testid="cancellation-policy">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{describeCancellationPolicy(policyQuery.data)}</p>
              </div>

              {(schoolPhone || schoolEmail) && (
                <div className="flex flex-wrap gap-2">
                  {schoolPhone && (
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs gap-1 bg-background">
                      <a href={`https://wa.me/${schoolPhone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hola ${schoolName}, quiero reservar ${facility.name}.`)}`} target="_blank" rel="noreferrer">
                        <MessageCircle className="h-3.5 w-3.5" />
                        WhatsApp
                      </a>
                    </Button>
                  )}
                  {schoolEmail && (
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs gap-1 bg-background">
                      <a href={`mailto:${schoolEmail}?subject=${encodeURIComponent(`Reserva ${facility.name}`)}`}>
                        <Mail className="h-3.5 w-3.5" />
                        Email
                      </a>
                    </Button>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep('time')} className="flex-1" disabled={submitting}>
                  Atrás
                </Button>
                <Button
                  onClick={submit}
                  disabled={submitting || !user || isMinor}
                  className="flex-1 bg-[#248223] hover:bg-[#1d6a1c]"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  {price > 0 ? 'Reservar' : 'Confirmar reserva'}
                </Button>
              </div>
            </div>
          )}

          {/* Step: Resultado */}
          {step === 'done' && result && (
            <div className="space-y-4">
              <Card className="border-primary/20">
                <CardContent className="space-y-2 p-4 text-sm">
                  <p className="flex items-center gap-2 text-base font-semibold">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    {status === 'confirmed'
                      ? 'Reserva confirmada'
                      : status === 'pending_payment' || status === 'hold'
                        ? 'Franja apartada: falta el pago'
                        : 'Solicitud enviada'}
                  </p>
                  <p className="text-muted-foreground">
                    {facility.name} · {result.reservation.local_date ?? day} · {result.reservation.local_start ?? selectedSlot?.start_local} – {result.reservation.local_end ?? selectedSlot?.end_local}
                  </p>
                  {result.reservation.price > 0 && (
                    <p className="font-semibold">Total: {formatCOP(result.reservation.price)}</p>
                  )}
                  {status === 'pending' && (
                    <p className="text-xs text-muted-foreground">La escuela debe aprobar tu solicitud; te avisaremos cuando la confirme.</p>
                  )}
                </CardContent>
              </Card>

              {(status === 'pending_payment' || status === 'hold') && (
                <HoldCountdown reservation={result.reservation} />
              )}

              <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>Cerrar</Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
