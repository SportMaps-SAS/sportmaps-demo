import { useState, useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Clock, Building2, CalendarCheck, CheckCircle2, Loader2,
  Wrench, UserCheck, Lock, Pencil, User, Users, Wallet, AlertTriangle,
} from 'lucide-react';
import { format, isBefore, startOfDay } from 'date-fns';
import { es } from 'date-fns/locale';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import type { FacilityReservation } from '@/hooks/useFacilityReservations';
import { SlotGrid } from '@/components/reservas/SlotGrid';
import { db, useAvailability } from '@/components/reservas/reservasHooks';
import {
  BLACKOUT_KIND_LABEL,
  blackoutErrorMessage,
  bookingSignature,
  buildBlackoutBody,
  createBlackout,
  createBooking,
  createIdempotencyHolder,
  dropStartedSlots,
  durationOptions,
  findFacilityAvailability,
  formatCOP,
  formatDuration,
  parseBookingError,
  pickDaySlots,
  rescheduleBooking,
  slotFromAlternative,
  usesNewReservationRoutes,
  type AvailabilitySlot,
  type BlackoutKind,
  type BookingAlternative,
  type CreateBookingBody,
  type PaymentMethod,
  type RateAudience,
} from '@/components/reservas/reservasApi';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Facility {
  id: string;
  name: string;
  type: string;
  capacity: number;
  hourly_rate?: number;
}

type ReservationType = 'manual' | 'block';
type Step = 'details' | 'datetime' | 'confirm';
type Who = 'internal' | 'user' | 'guest';

interface FoundUser { id: string; full_name: string | null; email: string | null }

export interface LegacyReschedulePayload {
  id: string;
  reservation_date: string;
  start_time: string;
  end_time: string;
}

export interface OwnerReservationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facilities: Facility[];
  /** Si viene, el modal reprograma esa reserva (no crea). */
  editReservation?: FacilityReservation | null;
  /** Reprogramar una fila sin starts_at (rutas viejas de reservations-admin). */
  onLegacyReschedule?: (payload: LegacyReschedulePayload) => Promise<unknown>;
  /** Para que la página refresque su lista cuando algo cambió. */
  onChanged?: () => void;
}

const RESERVATION_TYPES: {
  value: ReservationType; label: string; description: string;
  icon: React.ReactNode; color: string;
}[] = [
  {
    value: 'manual',
    label: 'Reserva',
    description: 'A nombre de un usuario, un invitado o uso interno.',
    icon: <UserCheck className="h-5 w-5" />,
    color: 'border-blue-500/20 bg-blue-500/5 text-blue-600 dark:text-blue-400',
  },
  {
    value: 'block',
    label: 'Bloqueo Interno',
    description: 'Bloquea el espacio para mantenimiento o uso interno.',
    icon: <Lock className="h-5 w-5" />,
    color: 'border-amber-500/20 bg-amber-500/5 text-amber-600 dark:text-amber-400',
  },
];

const WHO_OPTIONS: { value: Who; label: string; icon: React.ReactNode }[] = [
  { value: 'user', label: 'Usuario de SportMaps', icon: <User className="h-4 w-4" /> },
  { value: 'guest', label: 'Invitado (teléfono)', icon: <Users className="h-4 w-4" /> },
  { value: 'internal', label: 'Uso interno', icon: <Building2 className="h-4 w-4" /> },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

/** Quita caracteres que rompen el filtro .or() de PostgREST. */
function sanitizeSearch(q: string): string {
  return q.replace(/[,()%*\\]/g, ' ').trim();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OwnerReservationModal({
  open, onOpenChange, facilities, editReservation, onLegacyReschedule, onChanged,
}: OwnerReservationModalProps) {
  const isEdit = !!editReservation;
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('details');
  const [reservationType, setReservationType] = useState<ReservationType>('manual');
  const [selectedFacilityId, setSelectedFacilityId] = useState('');
  const [notes, setNotes] = useState('');
  const [blockKind, setBlockKind] = useState<BlackoutKind>('maintenance');
  const [selectedDate, setSelectedDate] = useState<Date | undefined>();
  const [duration, setDuration] = useState<number | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);
  const [audience, setAudience] = useState<RateAudience>('public');
  const [who, setWho] = useState<Who>('user');
  const [userQuery, setUserQuery] = useState('');
  const [userResults, setUserResults] = useState<FoundUser[]>([]);
  const [pickedUser, setPickedUser] = useState<FoundUser | null>(null);
  const [guestPhone, setGuestPhone] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [participants, setParticipants] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<BookingAlternative[]>([]);

  const submittingRef = useRef(false);
  // Una llave de idempotencia por resumen: nace al abrir el resumen, no al hacer clic.
  const idem = useRef(createIdempotencyHolder());
  const [summaryKey, setSummaryKey] = useState<string | null>(null);

  const resetState = () => {
    setStep('details');
    setReservationType('manual');
    setSelectedFacilityId('');
    setNotes('');
    setBlockKind('maintenance');
    setSelectedDate(undefined);
    setDuration(null);
    setSelectedSlot(null);
    setAudience('public');
    setWho('user');
    setUserQuery('');
    setUserResults([]);
    setPickedUser(null);
    setGuestPhone('');
    setGuestName('');
    setGuestEmail('');
    setAmountPaid('');
    setParticipants('1');
    setError(null);
    setAlternatives([]);
    setSummaryKey(null);
    idem.current.reset();
  };

  // Reprogramar: arranca en la fecha/hora con la cancha y la duración actuales.
  useEffect(() => {
    if (editReservation && open) {
      setSelectedFacilityId(editReservation.facility_id);
      setNotes(editReservation.notes ?? '');
      setReservationType('manual');
      setSelectedDate(new Date(`${editReservation.reservation_date}T12:00:00`));
      if (editReservation.starts_at && editReservation.ends_at) {
        setDuration(minutesBetween(editReservation.starts_at, editReservation.ends_at));
      }
      setSelectedSlot(null);
      setStep('datetime');
    } else if (!open) {
      resetState();
    }
  }, [editReservation, open]);

  // Búsqueda de usuarios (con pausa para no consultar en cada tecla).
  useEffect(() => {
    const q = sanitizeSearch(userQuery);
    if (who !== 'user' || pickedUser || q.length < 3) {
      setUserResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await db
        .from('profiles')
        .select('id, full_name, email')
        .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8);
      if (!cancelled) setUserResults((data ?? []) as FoundUser[]);
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [userQuery, who, pickedUser]);

  const day = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : null;
  const availabilityEnabled = open && !!selectedFacilityId && !!day && step !== 'details';
  const availabilityQuery = useAvailability(
    schoolId && day && selectedFacilityId
      ? {
          school_id: schoolId,
          from: day,
          to: day,
          facility_id: selectedFacilityId,
          duration_min: duration,
          audience: reservationType === 'block' || who === 'internal' ? null : audience,
        }
      : null,
    availabilityEnabled,
  );
  const facAvail = findFacilityAvailability(availabilityQuery.data, selectedFacilityId);
  const durations = useMemo(() => durationOptions(facAvail), [facAvail]);
  const daySlots = useMemo(
    () => dropStartedSlots(pickDaySlots(availabilityQuery.data, selectedFacilityId, day ?? '')),
    [availabilityQuery.data, selectedFacilityId, day],
  );

  const selectedFacility = facilities.find((f) => f.id === selectedFacilityId);
  const selectedType = RESERVATION_TYPES.find((t) => t.value === reservationType)!;
  const STEPS: Step[] = ['details', 'datetime', 'confirm'];
  const isBlock = reservationType === 'block';

  const paymentMethod: PaymentMethod = who === 'internal' ? 'none' : 'cash';

  const guestPhoneDigits = guestPhone.replace(/\D/g, '');
  const detailsValid =
    !!selectedFacilityId &&
    (isBlock ||
      who === 'internal' ||
      (who === 'user' && !!pickedUser) ||
      (who === 'guest' && guestPhoneDigits.length >= 7 && guestName.trim().length >= 2));

  const amountNumber = Math.max(0, Math.round(Number(amountPaid.replace(/[^\d]/g, '')) || 0));

  // Cuerpo de la reserva (sin precio: lo calcula el servidor).
  const bookingBody: CreateBookingBody | null = useMemo(() => {
    if (!selectedFacilityId || !selectedSlot || isBlock || isEdit) return null;
    const body: CreateBookingBody = {
      facility_id: selectedFacilityId,
      starts_at: selectedSlot.starts_at,
      ends_at: selectedSlot.ends_at,
      payment_method: paymentMethod,
    };
    if (who === 'user' && pickedUser) body.booker_profile_id = pickedUser.id;
    if (who === 'guest') {
      body.guest = {
        phone: guestPhoneDigits,
        full_name: guestName.trim(),
        ...(guestEmail.trim() ? { email: guestEmail.trim() } : {}),
      };
    }
    if (who !== 'internal') {
      body.rate_audience = audience;
      if (amountNumber > 0) body.amount_paid = amountNumber;
    }
    const p = parseInt(participants, 10);
    if (Number.isFinite(p) && p > 0) body.participants = p;
    if (notes.trim()) body.notes = notes.trim();
    return body;
  }, [selectedFacilityId, selectedSlot, isBlock, isEdit, paymentMethod, who, pickedUser,
      guestPhoneDigits, guestName, guestEmail, audience, amountNumber, participants, notes]);

  // La llave nace al abrir el resumen (y solo cambia si cambian los datos).
  useEffect(() => {
    if (step === 'confirm' && bookingBody) {
      setSummaryKey(idem.current.forSummary(bookingSignature(bookingBody)));
    } else {
      setSummaryKey(null);
    }
  }, [step, bookingBody]);

  const pickSlot = (s: AvailabilitySlot) => {
    setSelectedSlot(s);
    setError(null);
    setAlternatives([]);
  };

  const onDateChange = (d: Date | undefined) => {
    setSelectedDate(d);
    setSelectedSlot(null);
  };

  const onDurationChange = (v: string) => {
    setDuration(Number(v));
    setSelectedSlot(null);
  };

  const onAudienceChange = (v: string) => {
    setAudience(v as RateAudience);
    setSelectedSlot(null);
  };

  const refreshOutside = () => {
    queryClient.invalidateQueries({ queryKey: ['school-facility-reservations'] });
    queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
    queryClient.invalidateQueries({ queryKey: ['reservas-availability'] });
    onChanged?.();
  };

  const applyAlternative = (a: BookingAlternative) => {
    if (a.facility_id && a.facility_id !== selectedFacilityId) setSelectedFacilityId(a.facility_id);
    setSelectedSlot(slotFromAlternative(a, selectedSlot?.deposit_min ?? 0));
    setError(null);
    setAlternatives([]);
  };

  const handleSubmit = async () => {
    if (!selectedFacility || !selectedDate || !selectedSlot || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setAlternatives([]);
    try {
      if (isBlock) {
        // Bloqueo: POST /reservations-admin/blackouts (el navegador no escribe en facility_reservations).
        await createBlackout(buildBlackoutBody({
          facility_id: selectedFacility.id,
          starts_at: selectedSlot.starts_at,
          ends_at: selectedSlot.ends_at,
          kind: blockKind,
          reason: notes,
        }));
        toast({ title: '✅ Bloqueo creado' });
        refreshOutside();
        onOpenChange(false);
        return;
      }

      if (isEdit && editReservation) {
        if (usesNewReservationRoutes(editReservation)) {
          await rescheduleBooking(editReservation.id, {
            starts_at: selectedSlot.starts_at,
            ends_at: selectedSlot.ends_at,
            ...(selectedFacilityId !== editReservation.facility_id ? { facility_id: selectedFacilityId } : {}),
          });
        } else if (onLegacyReschedule) {
          await onLegacyReschedule({
            id: editReservation.id,
            reservation_date: format(selectedDate, 'yyyy-MM-dd'),
            start_time: selectedSlot.start_local,
            end_time: selectedSlot.end_local,
          });
        }
        toast({ title: '✅ Reserva reprogramada' });
        refreshOutside();
        onOpenChange(false);
        return;
      }

      if (!bookingBody) return;
      const key = summaryKey ?? idem.current.forSummary(bookingSignature(bookingBody));
      const res = await createBooking(bookingBody, key);
      idem.current.reset();
      toast({
        title: '✅ Reserva creada',
        description: res.pricing
          ? `Total: ${formatCOP(res.pricing.total)}${res.reservation.amount_paid ? ` · cobrado ${formatCOP(res.reservation.amount_paid)}` : ''}`
          : 'La reserva fue registrada.',
      });
      refreshOutside();
      onOpenChange(false);
    } catch (e: unknown) {
      const info = parseBookingError(e);
      setError(isBlock ? blackoutErrorMessage(e) : info.message);
      if (info.code === 'SLOT_TAKEN') setAlternatives(info.alternatives);
      refreshOutside();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const endLabel = selectedSlot?.end_local ?? '';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetState(); onOpenChange(v); }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto bg-card text-card-foreground border-border/40 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            {isEdit
              ? <><Pencil className="h-6 w-6 text-primary" /> Reprogramar Reserva</>
              : <><Building2 className="h-6 w-6 text-primary" /> Nueva Reserva</>
            }
          </DialogTitle>
          <DialogDescription className="text-muted-foreground/80">
            {isEdit
              ? 'Elige la nueva fecha y hora. El servidor valida que la franja esté libre.'
              : 'Reserva a nombre de alguien, registra uso interno o bloquea un espacio.'}
          </DialogDescription>
        </DialogHeader>

        {/* Step dots */}
        <div className="flex items-center justify-center gap-2 py-4">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300 ${
                step === s ? 'bg-primary text-primary-foreground scale-110 shadow-lg shadow-primary/20'
                  : i < STEPS.indexOf(step) ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}>{i + 1}</div>
              {i < 2 && <div className={`w-10 h-0.5 mx-1 transition-colors duration-300 ${i < STEPS.indexOf(step) ? 'bg-primary/40' : 'bg-muted'}`} />}
            </div>
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive space-y-2" role="alert">
            <p className="flex items-start gap-2"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>
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

        {/* ── Step 1 ── */}
        {step === 'details' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">Tipo de reserva</Label>
              <div className="grid grid-cols-2 gap-4">
                {RESERVATION_TYPES.map((type) => (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => setReservationType(type.value)}
                    className={`flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                      reservationType === type.value
                        ? `${type.color} border-current ring-2 ring-current/10 shadow-md`
                        : 'border-border/50 bg-muted/30 hover:border-muted-foreground/30 hover:bg-muted/50'
                    }`}
                  >
                    <div className={reservationType === type.value ? '' : 'text-muted-foreground'}>{type.icon}</div>
                    <div>
                      <p className="text-sm font-bold leading-tight">{type.label}</p>
                      <p className="text-[11px] opacity-80 leading-snug mt-1">{type.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">Instalación</Label>
              <Select value={selectedFacilityId} onValueChange={(v) => { setSelectedFacilityId(v); setSelectedSlot(null); }}>
                <SelectTrigger className="bg-muted/30 border-border/50 h-11">
                  <SelectValue placeholder="Selecciona una instalación…" />
                </SelectTrigger>
                <SelectContent>
                  {facilities.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      <div className="flex flex-col">
                        <span className="font-semibold">{f.name}</span>
                        <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{f.type}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!isBlock && (
              <>
                <div className="space-y-3">
                  <Label className="text-sm font-semibold tracking-tight">¿A nombre de quién?</Label>
                  <div className="grid grid-cols-3 gap-2">
                    {WHO_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        type="button"
                        onClick={() => setWho(o.value)}
                        className={`flex flex-col items-center gap-1 rounded-lg border p-2.5 text-xs font-semibold transition-colors ${
                          who === o.value ? 'border-primary bg-primary/10 text-primary' : 'border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/50'
                        }`}
                        aria-pressed={who === o.value}
                      >
                        {o.icon}
                        <span className="text-center leading-tight">{o.label}</span>
                      </button>
                    ))}
                  </div>

                  {who === 'user' && (
                    <div className="space-y-2">
                      {pickedUser ? (
                        <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                          <div>
                            <p className="font-semibold">{pickedUser.full_name ?? 'Sin nombre'}</p>
                            <p className="text-xs text-muted-foreground">{pickedUser.email}</p>
                          </div>
                          <Button type="button" variant="ghost" size="sm" onClick={() => { setPickedUser(null); setUserQuery(''); }}>Cambiar</Button>
                        </div>
                      ) : (
                        <>
                          <Input
                            placeholder="Busca por nombre o correo (mín. 3 letras)…"
                            value={userQuery}
                            onChange={(e) => setUserQuery(e.target.value)}
                            className="bg-muted/30 border-border/50"
                          />
                          {userResults.length > 0 && (
                            <ul className="max-h-40 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/40">
                              {userResults.map((u) => (
                                <li key={u.id}>
                                  <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-muted/50" onClick={() => setPickedUser(u)}>
                                    <span className="font-semibold">{u.full_name ?? 'Sin nombre'}</span>
                                    <span className="block text-xs text-muted-foreground">{u.email}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {who === 'guest' && (
                    <div className="grid gap-2">
                      <Input placeholder="Nombre completo *" value={guestName} onChange={(e) => setGuestName(e.target.value)} className="bg-muted/30 border-border/50" />
                      <Input placeholder="Teléfono *" inputMode="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} className="bg-muted/30 border-border/50" />
                      <Input placeholder="Correo (opcional)" inputMode="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} className="bg-muted/30 border-border/50" />
                    </div>
                  )}

                  {who === 'internal' && (
                    <p className="text-xs text-muted-foreground">Uso interno de la escuela: queda confirmada, sin costo y sin cobro.</p>
                  )}
                </div>

                {who !== 'internal' && (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label className="text-sm font-semibold tracking-tight">Tarifa</Label>
                      <Select value={audience} onValueChange={onAudienceChange}>
                        <SelectTrigger className="bg-muted/30 border-border/50 h-11" aria-label="Tarifa">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="public">Tarifa: Público</SelectItem>
                          <SelectItem value="member">Tarifa: Socio</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-sm font-semibold tracking-tight">Personas</Label>
                      <Input type="number" min={1} value={participants} onChange={(e) => setParticipants(e.target.value)} className="bg-muted/30 border-border/50 h-11" />
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">
                Notas <span className="text-muted-foreground font-normal text-xs">(opcional)</span>
              </Label>
              <Textarea
                placeholder={isBlock ? 'Ej. Mantenimiento de piso, evento institucional…' : 'Ej. Grupo de 8 personas, trae sus balones…'}
                value={notes}
                maxLength={isBlock ? 200 : 1000}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="bg-muted/30 border-border/50 resize-none focus-visible:ring-primary/20"
              />
            </div>

            {isBlock && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold tracking-tight">Tipo de bloqueo</Label>
                <Select value={blockKind} onValueChange={(v) => setBlockKind(v as BlackoutKind)}>
                  <SelectTrigger className="bg-muted/30 border-border/50 h-11" aria-label="Tipo de bloqueo"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(BLACKOUT_KIND_LABEL) as BlackoutKind[]).map((k) => (
                      <SelectItem key={k} value={k}>{BLACKOUT_KIND_LABEL[k]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  El bloqueo cierra la cancha en el horario elegido. Si ya hay una reserva vigente, el servidor no lo permite.
                </p>
              </div>
            )}

            <Button className="w-full h-11 text-base font-semibold" onClick={() => setStep('datetime')} disabled={!detailsValid}>
              Continuar
            </Button>
          </div>
        )}

        {/* ── Step 2 ── */}
        {step === 'datetime' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="text-center">
              <h3 className="font-bold text-lg">Selecciona la fecha y hora</h3>
              <p className="text-xs text-muted-foreground mt-1">Solo se muestran franjas libres, con su precio real.</p>
            </div>

            {isEdit && (
              <div className="space-y-2">
                <Label className="text-sm font-semibold tracking-tight">Instalación</Label>
                <Select value={selectedFacilityId} onValueChange={(v) => { setSelectedFacilityId(v); setSelectedSlot(null); }}>
                  <SelectTrigger className="bg-muted/30 border-border/50 h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {facilities.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex justify-center bg-muted/20 p-4 rounded-2xl border border-border/30">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={onDateChange}
                disabled={(d) => isBefore(d, startOfDay(new Date()))}
                locale={es}
                className="rounded-md"
              />
            </div>

            {selectedDate && (
              <div className="space-y-4">
                <div className="flex items-center justify-between border-b border-border/30 pb-2">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <Clock className="h-4 w-4 text-primary" /> Horarios disponibles
                  </h3>
                  <p className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full capitalize">
                    {format(selectedDate, 'EEEE d MMM', { locale: es })}
                  </p>
                </div>

                {durations.length > 1 && (
                  <div className="flex items-center gap-3">
                    <Label className="text-xs font-semibold">Duración</Label>
                    <Select value={String(duration ?? facAvail?.duration_min ?? durations[0])} onValueChange={onDurationChange}>
                      <SelectTrigger className="h-9 w-40 bg-muted/30 border-border/50" aria-label="Duración"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {durations.map((d) => <SelectItem key={d} value={String(d)}>{formatDuration(d)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <SlotGrid
                  slots={daySlots}
                  selectedStartsAt={selectedSlot?.starts_at ?? null}
                  onSelect={pickSlot}
                  loading={availabilityQuery.isFetching}
                  errorMessage={availabilityQuery.isError ? parseBookingError(availabilityQuery.error).message : null}
                  showPrice={!isBlock && who !== 'internal'}
                />
              </div>
            )}

            <div className="flex gap-3 pt-2">
              {!isEdit && (
                <Button variant="outline" onClick={() => setStep('details')} className="flex-1 h-11 font-medium border-border/50">Atrás</Button>
              )}
              <Button onClick={() => setStep('confirm')} disabled={!selectedDate || !selectedSlot} className="flex-1 h-11 font-bold">
                Confirmar Horario
              </Button>
            </div>
          </div>
        )}

        {/* ── Step 3 ── */}
        {step === 'confirm' && selectedFacility && selectedDate && selectedSlot && (
          <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
            <Card className="border-primary/20 bg-primary/5 shadow-inner overflow-hidden">
              <CardContent className="p-0">
                <div className="p-4 border-b border-primary/10 flex items-center justify-between">
                  <Badge variant="secondary" className={`${selectedType.color} border-current/20 font-bold px-3 py-1`}>
                    {selectedType.icon}
                    <span className="ml-2">{isEdit ? 'Reprogramación' : selectedType.label}</span>
                  </Badge>
                </div>

                <div className="p-5 space-y-4 text-sm">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" />Instalación</span>
                    <span className="font-bold text-base">{selectedFacility.name}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground flex items-center gap-2"><CalendarCheck className="h-4 w-4 text-primary" />Fecha</span>
                    <span className="font-bold text-base">{format(selectedDate, 'PPPP', { locale: es })}</span>
                  </div>
                  <div className="flex justify-between items-start">
                    <span className="text-muted-foreground flex items-center gap-2 mt-0.5"><Clock className="h-4 w-4 text-primary" />Horario</span>
                    <div className="text-right">
                      <span className="font-bold text-base block">{selectedSlot.start_local} — {endLabel}</span>
                      <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-tight">
                        Duración: {formatDuration(minutesBetween(selectedSlot.starts_at, selectedSlot.ends_at))}
                      </span>
                    </div>
                  </div>

                  {!isBlock && !isEdit && (
                    <>
                      <div className="flex justify-between items-center">
                        <span className="text-muted-foreground flex items-center gap-2"><User className="h-4 w-4 text-primary" />Reserva a nombre de</span>
                        <span className="font-bold text-right">
                          {who === 'user' ? (pickedUser?.full_name ?? pickedUser?.email) : who === 'guest' ? `${guestName} · ${guestPhone}` : 'Uso interno'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center border-t border-primary/10 pt-3">
                        <span className="text-muted-foreground">
                          {who === 'internal' ? 'Costo' : `Total (tarifa ${audience === 'member' ? 'Socio' : 'Público'})`}
                        </span>
                        <span className="font-bold text-base">
                          {who === 'internal' ? 'Sin costo' : selectedSlot.price > 0 ? formatCOP(selectedSlot.price) : 'Sin costo'}
                        </span>
                      </div>
                      {who !== 'internal' && (
                        <div className="space-y-1.5">
                          <Label htmlFor="amount_paid" className="text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                            <Wallet className="h-3.5 w-3.5 text-primary" /> Cobrado en sede (efectivo)
                          </Label>
                          <div className="flex gap-2">
                            <Input
                              id="amount_paid"
                              inputMode="numeric"
                              placeholder="0"
                              value={amountPaid}
                              onChange={(e) => setAmountPaid(e.target.value.replace(/[^\d]/g, ''))}
                              className="bg-background/60"
                            />
                            {selectedSlot.price > 0 && (
                              <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setAmountPaid(String(selectedSlot.price))}>
                                Cobrar total
                              </Button>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground">El estado de pago (sin pagar / abono / pagado) lo calcula el servidor.</p>
                        </div>
                      )}
                    </>
                  )}

                  {notes && (
                    <div className="space-y-1.5 pt-1 border-t border-primary/10">
                      <span className="text-muted-foreground flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><Wrench className="h-3.5 w-3.5 text-primary" />Notas Internas</span>
                      <p className="font-medium bg-background/50 p-3 rounded-lg border border-border/30 text-xs italic">{notes}</p>
                    </div>
                  )}
                </div>

                <div className="p-4 bg-primary/10 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-widest text-primary/60">Estado automático</span>
                  <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white border-0 px-2 py-0.5 font-bold shadow-sm shadow-emerald-500/20">
                    <CheckCircle2 className="h-3 w-3 mr-1" />Confirmada
                  </Badge>
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep('datetime')} className="flex-1 h-12 font-medium border-border/50" disabled={submitting}>Revisar</Button>
              <Button onClick={handleSubmit} disabled={submitting} className="flex-1 h-12 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-base shadow-lg shadow-emerald-600/20 active:scale-[0.98] transition-all">
                {submitting
                  ? <Loader2 className="h-5 w-5 animate-spin mr-2" />
                  : <CheckCircle2 className="h-5 w-5 mr-2" />
                }
                {isEdit ? 'Reprogramar' : isBlock ? 'Confirmar Bloqueo' : 'Finalizar Registro'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
