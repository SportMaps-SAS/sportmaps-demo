/**
 * «Inscripciones y planes» — /enrollments. La usan el acudiente (por hijo) y el
 * deportista adulto (lo suyo).
 *
 * Rediseño V2 (2026-10-24): una frase y un botón arriba, una sola columna con
 * más aire en escritorio (max-w-page), nada de texto por debajo de text-xs.
 * Lo que antes vivía en el panel lateral se reubicó sin perder nada:
 *  - «Clases programadas» → la línea «Próxima clase» de arriba + pestaña Clases
 *    (que es donde se cancela cada clase o reserva).
 *  - «Instalaciones» → pestaña Reservas («Reservar una instalación»). Si el plan
 *    no trae reservas, la lista va plegada: el botón abría un «sin acceso».
 *  - «Clase de prueba» → tarjeta al final, igual para todas las pestañas.
 * Las cuatro tarjetas de conteo se volvieron la frase de arriba y los números
 * de cada pestaña. Los botones a Explorar solo salen con SHOW_EXPLORE.
 * Los modales de agendar/reservar (abajo) son los mismos de antes.
 */
import { useState, useMemo, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  User, Calendar, Clock, Zap, Trophy,
  ChevronRight, CalendarCheck,
  Building2,
  XCircle, CheckCircle2, ChevronLeft,
  Sun, Sunset, Moon, AlertCircle, AlertTriangle, RefreshCw, Sparkles,
} from 'lucide-react';
import {
  format, parseISO, addDays, startOfDay,
  startOfMonth, endOfMonth, eachDayOfInterval, isBefore, isToday,
} from 'date-fns';
import { es } from 'date-fns/locale';
import { useEnrollments } from '@/hooks/useEnrollments';
import { BloqueFamiliaAdulto } from '@/components/familia/FamiliaBloques';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { getSportVisual } from '@/lib/sportVisuals';
import { useToast } from '@/hooks/use-toast';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  useAvailableSessions,
  useMyBookings,
  useMySecondaryBookings,
  useBookSession,
  useBookSecondarySession,
  useCancelBooking,
  useCancelSecondaryBooking,
  useFacilitySlots,
  useAthleteFacilities,
  BookableSession,
  usePTAvailability,
  prefetchPTAvailability,
  useBookPTSession,
  useCancelPTSession,
  PTAvailabilitySlot,
  collapseOverlappingBlocks,
} from '@/hooks/useAthleteSessionBookings';
import { useTrialClassesSelf } from '@/hooks/useTrialClassesSelf';
import { TrialClassSelfModal } from '@/components/school/TrialClassSelfModal';
import { HourBankBalanceCard } from '@/components/access/HourBankBalanceCard';
import { CompactSessionSlot } from '@/components/booking/CompactSessionSlot';
import { HourGridPicker } from '@/components/booking/HourGridPicker';
import { WEEKDAY_LONG, dayNotAllowedMessage, describeAllowedDays, isDayAllowed, weekdayOfDateString } from '@/lib/school/levelProgression';
import { SHOW_EXPLORE } from '@/lib/feature-flags';
import { cn } from '@/lib/utils';
import { fraseResumen, primerNombre, saldoDeClases, venceEn } from '@/components/inscripciones/inscripcionesTextos';

// ─── Tipos de instalación ─────────────────────────────────────────────────────

interface ScheduleSlot { day: number; time: string }

interface Facility {
  id: string;
  name: string;
  type: string;
  school_id: string;
}

type Tab = 'groups' | 'classes' | 'reservations';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(t: string) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function fmtDateShort(d: string) {
  if (!d) return '';
  return format(parseISO(d), "EEE d MMM", { locale: es });
}

function fmtDateLong(d: string) {
  if (!d) return '';
  return format(parseISO(d), "EEEE d 'de' MMMM", { locale: es });
}

function getNextAvailableDates(count = 14) {
  const dates: string[] = [];
  let d = startOfDay(new Date());
  while (dates.length < count) {
    d = addDays(d, 1);
    dates.push(format(d, 'yyyy-MM-dd'));
  }
  return dates;
}

/** Fecha (YYYY-MM-DD) de una reserva unificada, sea clase o instalación. */
function bookingDate(b: any): string {
  return (b._type === 'primary' ? b.attendance_sessions?.session_date : b.reservation_date) || '';
}

/** Nombre de lo que se agendó: equipo / plan / instalación. */
function bookingName(b: any): string {
  if (b._type === 'primary') {
    return (b.booking_type === 'team' ? b.enrollments?.teams?.name : b.enrollments?.offering_plans?.name) || 'Clase';
  }
  return b.facilities?.name || 'Reserva';
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MyEnrollmentsPage() {
  const { user, profile } = useAuth();
  const { currentUserRole } = useSchoolContext();
  const isParent = currentUserRole === 'parent';
  const [selectedChildId, setSelectedChildId] = useState<string | undefined>(undefined);

  // ── Fetch Children (if parent) ──
  const { data: children, isLoading: childrenLoading } = useQuery({
    queryKey: ['children', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('children')
        .select('id, full_name, avatar_url')
        .eq('parent_id', user?.id);
      if (error) throw error;
      return data || [];
    },
    enabled: isParent && !!user?.id,
  });

  // Auto-select first child
  useEffect(() => {
    if (isParent && children?.length && !selectedChildId) {
      setSelectedChildId(children[0].id);
    }
  }, [children, isParent, selectedChildId]);

  const {
    activeEnrollments, loading: activeIsLoading, error: enrollmentsError, refetch: refetchEnrollments,
  } = useEnrollments(selectedChildId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // ── Prefetch PT Availability ──
  useEffect(() => {
    if (!activeEnrollments) return;
    activeEnrollments.forEach(e => {
      if (e.program.school_type === 'personal_trainer') {
        prefetchPTAvailability(queryClient, e.id, selectedChildId);
      }
    });
  }, [activeEnrollments, selectedChildId, queryClient]);

  const [activeTab, setActiveTab] = useState<Tab>('groups');
  const [selectedTeam, setSelectedTeam] = useState<any>(null);
  const [scheduleEnrollment, setScheduleEnrollment] = useState<any>(null);
  const [reservingFacility, setReservingFacility] = useState<Facility | null>(null);
  const [showTrialModal, setShowTrialModal] = useState(false);

  const { data: myBookingsData, isLoading: myBookingsLoading } = useMyBookings(selectedChildId);
  const { data: mySecBookings, isLoading: mySecLoading } = useMySecondaryBookings(selectedChildId);
  const {
    data: facilitiesData, isLoading: facilitiesLoading, error: facilitiesError, refetch: refetchFacilities,
  } = useAthleteFacilities(selectedChildId);
  const { selfServiceAvailable } = useTrialClassesSelf();

  const athleteFacilities: Facility[] = facilitiesData?.facilities ?? [];

  // ── Derivados de enrollments (ANTES del early return — regla de hooks) ──────
  const teamEnrollments = (activeEnrollments ?? []).filter((e: any) => e.team_id && !e.offering_plan_id);
  const planEnrollments = (activeEnrollments ?? []).filter((e: any) => e.offering_plan_id);

  const enrollmentWithSec = (activeEnrollments ?? []).find(
    (e: any) => (e.plan_details?.max_secondary_sessions ?? 0) > 0
  );
  const secondaryLabel = enrollmentWithSec?.plan_details?.secondary_session_label || 'Reservas';

  const enrollmentForFacility = useMemo(() => {
    return planEnrollments.find((e: any) => {
      const max  = e.plan_details?.max_secondary_sessions ?? 0;
      const used = e.secondary_sessions_used ?? 0;
      return max > 0 && used < max;
    }) ?? planEnrollments[0] ?? null;
  }, [planEnrollments]);

  const totalMyClasses = myBookingsData?.filter((b: any) => b.status?.toLowerCase() !== 'cancelled').length ?? 0;
  const totalMyReservations = mySecBookings?.filter((b: any) => b.status?.toLowerCase() !== 'cancelled').length ?? 0;

  // ── Unificación de clases y reservas (pestañas y «Próxima clase») ──
  const allBookings = useMemo(() => {
    const primary = (myBookingsData ?? []).filter((b: any) => b.status?.toLowerCase() !== 'cancelled');
    const secondary = (mySecBookings ?? []).filter((b: any) => b.status?.toLowerCase() !== 'cancelled');

    return [
      ...primary.map(b => ({ ...b, _type: 'primary' })),
      ...secondary.map(b => ({ ...b, _type: 'secondary' }))
    ].sort((a, b) => {
      const dateA = bookingDate(a);
      const dateB = bookingDate(b);
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return (a.start_time || '').localeCompare(b.start_time || '');
    });
  }, [myBookingsData, mySecBookings]);

  const selectedChild = children?.find((c: any) => c.id === selectedChildId);
  const nombre = isParent ? (primerNombre(selectedChild?.full_name) || 'Tu hijo/a') : null;

  const waitingChild = isParent && (childrenLoading || (!!children?.length && !selectedChildId));
  if (activeIsLoading || myBookingsLoading || mySecLoading || waitingChild) {
    return (
      <div className="mx-auto w-full max-w-page space-y-4 pb-6" aria-busy="true" aria-label="Cargando inscripciones">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-full max-w-md" />
        <Skeleton className="h-touch w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-CA');
  const proximas = allBookings.filter((b) => bookingDate(b) >= today);
  const proxima = proximas[0];
  const canReserve = !!enrollmentForFacility && (enrollmentForFacility.plan_details?.max_secondary_sessions ?? 0) > 0;
  // Un solo plan: su botón va arriba. Con varios, cada tarjeta trae el suyo.
  const unicoPlan = planEnrollments.length === 1 ? planEnrollments[0] : null;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'groups', label: 'Equipos y planes', count: teamEnrollments.length + planEnrollments.length },
    { key: 'classes', label: 'Clases', count: totalMyClasses },
    { key: 'reservations', label: 'Reservas', count: totalMyReservations },
  ];

  return (
    <div className="mx-auto w-full max-w-page space-y-5 pb-6">

      {/* ── Arriba: una frase y un botón ── */}
      <header className="space-y-3">
        <h1 className="text-2xl font-bold md:text-3xl">{isParent ? 'Inscripciones y planes' : 'Mis inscripciones'}</h1>

        {isParent && (children?.length ?? 0) > 1 && (
          <div role="radiogroup" aria-label="Deportista" className="flex gap-2 overflow-x-auto scrollbar-none">
            {children!.map((child: any) => {
              const on = selectedChildId === child.id;
              return (
                <button
                  key={child.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setSelectedChildId(child.id)}
                  className={cn(
                    'flex min-h-touch shrink-0 items-center gap-2 rounded-full border px-3 text-sm transition-colors',
                    on ? 'border-2 border-primary bg-primary/10 font-semibold text-foreground' : 'bg-card font-medium text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={child.avatar_url || ''} alt="" />
                    <AvatarFallback className="bg-muted text-xs text-foreground">{child.full_name.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <span className="max-w-40 truncate">{child.full_name}</span>
                </button>
              );
            })}
          </div>
        )}

        {enrollmentsError ? null : (
          <div className="space-y-1">
            <p className="text-base text-muted-foreground">
              {fraseResumen({
                nombre,
                equipos: teamEnrollments.length,
                planes: planEnrollments.length,
                // La frase habla de lo que viene; lo ya pasado sigue en cada pestaña.
                clases: proximas.filter((b) => b._type === 'primary').length,
                reservas: proximas.filter((b) => b._type === 'secondary').length,
              })}
            </p>
            {proxima && (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <CalendarCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span>
                  Próxima: <b className="font-semibold text-foreground">
                    {format(parseISO(bookingDate(proxima)), "EEE d 'de' MMM", { locale: es })}
                    {(proxima._type === 'primary' ? proxima.attendance_sessions?.start_time : proxima.start_time)
                      ? ` · ${fmtTime(proxima._type === 'primary' ? proxima.attendance_sessions?.start_time : proxima.start_time)}`
                      : ''}
                  </b> · {bookingName(proxima)}
                </span>
              </p>
            )}
          </div>
        )}

        {unicoPlan && !enrollmentsError && (
          <Button className="min-h-touch w-full sm:w-auto" onClick={() => setScheduleEnrollment(unicoPlan)}>
            <CalendarCheck className="mr-2 h-4 w-4" aria-hidden="true" />
            Agendar clase
          </Button>
        )}
      </header>

      {enrollmentsError ? (
        <ErrorBox
          titulo="No pudimos cargar las inscripciones"
          detalle={`Esto no quiere decir que ${nombre ? `${nombre} no tenga` : 'no tengas'} equipos ni planes. Revisa tu conexión e inténtalo de nuevo.`}
          onRetry={() => refetchEnrollments()}
        />
      ) : (
        <>
          {/* ── Pestañas ── */}
          <div role="tablist" aria-label="Inscripciones" className="flex gap-1 rounded-xl bg-muted p-1">
            {tabs.map(({ key, label, count }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setActiveTab(key)}
                className={cn(
                  'flex min-h-touch flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm transition-colors',
                  activeTab === key ? 'bg-background font-semibold text-foreground shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="truncate">{label}</span>
                {count > 0 && <span className="text-xs text-muted-foreground">{count}</span>}
              </button>
            ))}
          </div>

          {/* Pestaña: Equipos y planes */}
          {activeTab === 'groups' && (
            <div className="space-y-5">
              {teamEnrollments.length === 0 && planEnrollments.length === 0 ? (
                <div className="space-y-3 rounded-2xl border bg-card p-6 text-center">
                  <p className="font-semibold">{nombre ? `${nombre} no está en ningún equipo ni plan` : 'No estás en ningún equipo ni plan'}</p>
                  <p className="text-sm text-muted-foreground">
                    Cuando la escuela {nombre ? `inscriba a ${nombre}` : 'te inscriba'} en un equipo o le asigne un plan, aparece aquí.
                  </p>
                  {SHOW_EXPLORE && (
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button variant="outline" className="min-h-touch" onClick={() => navigate('/explore')}>Buscar equipos</Button>
                      <Button variant="outline" className="min-h-touch" onClick={() => navigate('/explore')}>Ver membresías</Button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {planEnrollments.length > 0 && (
                    <section className="space-y-2" aria-label="Planes">
                      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        {planEnrollments.length === 1 ? 'Plan' : `Planes (${planEnrollments.length})`}
                      </h2>
                      <div className={cn('grid grid-cols-1 gap-3', planEnrollments.length > 1 && 'md:grid-cols-2')}>
                        {planEnrollments.map((e: any) => (
                          <div key={e.id} className="space-y-3">
                            <PlanCard enrollment={e} onSchedule={unicoPlan ? undefined : () => setScheduleEnrollment(e)} />
                            {/* Banco de horas (F6) — no renderiza nada si la inscripción no tiene un plan por horas */}
                            <HourBankBalanceCard enrollmentId={e.id} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {teamEnrollments.length > 0 && (
                    <section className="space-y-2" aria-label="Equipos">
                      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                        {teamEnrollments.length === 1 ? 'Equipo' : `Equipos (${teamEnrollments.length})`}
                      </h2>
                      <div className="overflow-hidden rounded-2xl border bg-card">
                        {teamEnrollments.map((e: any, i: number) => (
                          <TeamRow key={e.id} enrollment={e} first={i === 0} onClick={() => setSelectedTeam(e)} />
                        ))}
                      </div>
                    </section>
                  )}

                  {SHOW_EXPLORE && (teamEnrollments.length === 0 || planEnrollments.length === 0) && (
                    <Button variant="link" className="min-h-touch h-auto px-1 text-sm" onClick={() => navigate('/explore')}>
                      {teamEnrollments.length === 0 ? 'Buscar equipos' : 'Ver membresías'}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === 'classes' && (
            <MyBookingsTab hasSecondary={!!enrollmentWithSec} secLabel={secondaryLabel} filter="primary" childId={selectedChildId} allBookings={allBookings} />
          )}

          {activeTab === 'reservations' && (
            <div className="space-y-5">
              <MyBookingsTab hasSecondary={!!enrollmentWithSec} secLabel={secondaryLabel} filter="secondary" childId={selectedChildId} allBookings={allBookings} />
              <FacilitiesSection
                facilities={athleteFacilities}
                loading={facilitiesLoading}
                error={!!facilitiesError}
                onRetry={() => refetchFacilities()}
                canReserve={canReserve}
                enrollment={enrollmentForFacility}
                nombre={nombre}
                onReserve={setReservingFacility}
              />
            </div>
          )}

          {selfServiceAvailable && (
            <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center">
              <span className="flex h-touch w-touch shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">Clase de prueba</h2>
                <p className="text-sm text-muted-foreground">
                  ¿Quieres probar otra disciplina, o agendarle una prueba a un hermano/a? Rápido, sin pasar por la escuela.
                </p>
              </div>
              <Button variant="outline" className="min-h-touch shrink-0" onClick={() => setShowTrialModal(true)}>
                Agendar clase de prueba
              </Button>
            </section>
          )}

          {/* Deportista adulto: pausar / retirar el plan y subir soportes (el acudiente lo hace desde «Hijos»). */}
          {!isParent && (
            <BloqueFamiliaAdulto
              usuarioId={user?.id}
              nombre={profile?.full_name || 'Mi plan'}
              inscripciones={(activeEnrollments ?? []) as any[]}
            />
          )}
        </>
      )}

      {/* ── Modals ── */}
      {showTrialModal && (
        <TrialClassSelfModal
          open={showTrialModal}
          onOpenChange={setShowTrialModal}
          facilities={athleteFacilities}
          children={(children ?? []).map((c: any) => ({ id: c.id, full_name: c.full_name }))}
          isParent={isParent}
        />
      )}
      {selectedTeam && (
        <TeamDetailModal enrollment={selectedTeam} onClose={() => setSelectedTeam(null)} />
      )}

      {scheduleEnrollment && (
        <ScheduleClassModal
          enrollment={scheduleEnrollment}
          facilities={athleteFacilities}
          childId={selectedChildId}
          onClose={() => setScheduleEnrollment(null)}
        />
      )}

      {/* enrollment calculado con lógica de créditos, no [0] */}
      {reservingFacility && (
        <FacilityReserveModal
          facility={reservingFacility}
          enrollment={enrollmentForFacility}
          childId={selectedChildId}
          onClose={() => setReservingFacility(null)}
        />
      )}
    </div>
  );
}

// ─── Estados ──────────────────────────────────────────────────────────────────

function ErrorBox({ titulo, detalle, onRetry }: { titulo: string; detalle: string; onRetry: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
      <p className="flex items-center gap-2 font-semibold text-destructive">
        <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
        {titulo}
      </p>
      <p className="text-sm text-muted-foreground">{detalle}</p>
      <Button variant="outline" className="min-h-touch" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
        Reintentar
      </Button>
    </div>
  );
}

// ─── Equipos, planes e instalaciones ──────────────────────────────────────────

function SportBadge({ sport, trainer }: { sport?: string; trainer?: boolean }) {
  return (
    <span className="flex h-touch w-touch shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl text-primary" aria-hidden="true">
      {trainer ? <User className="h-5 w-5" /> : getSportVisual(sport).icon}
    </span>
  );
}

function TeamRow({ enrollment, first, onClick }: { enrollment: any; first: boolean; onClick: () => void }) {
  const isTrainer = enrollment.program?.school_type === 'personal_trainer';
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50', !first && 'border-t')}
    >
      <SportBadge sport={enrollment.program?.sport} trainer={isTrainer} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-base font-semibold">{enrollment.program?.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {isTrainer ? 'Entrenamiento personal' : 'Equipo'}{enrollment.program?.sport ? ` · ${enrollment.program.sport}` : ''}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/** `onSchedule` undefined = el botón ya está arriba de la página (un solo plan). */
function PlanCard({ enrollment, onSchedule }: { enrollment: any; onSchedule?: () => void }) {
  const plan = enrollment.plan_details;
  const hasSecondary = (plan?.max_secondary_sessions ?? 0) > 0;
  const secLeft = Math.max(0, (plan?.max_secondary_sessions ?? 0) - (enrollment.secondary_sessions_used ?? 0));
  const secLabel = plan?.secondary_session_label || 'GYM';

  // Offering arriba (nombre del programa), plan_details abajo (tarifa)
  const offeringName = enrollment.offering?.name ?? enrollment.program?.name ?? 'Mi plan';
  const tariffName = enrollment.offering_plan?.name ?? plan?.name ?? 'Plan';
  const isTrainer = enrollment.program?.school_type === 'personal_trainer';
  const vence = venceEn(enrollment.expires_at);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <SportBadge sport={enrollment.program?.sport} trainer={isTrainer} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground">{isTrainer ? 'Entrenamiento personal' : offeringName}</p>
          <h3 className="text-base font-semibold leading-snug">{tariffName}</h3>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
          <Zap className="h-3.5 w-3.5" aria-hidden="true" />
          {saldoDeClases(plan?.max_sessions ?? null, enrollment.sessions_used)}
        </span>
        {hasSecondary && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            {secLeft} de {plan.max_secondary_sessions} {secLabel}
          </span>
        )}
        {vence && (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {vence}
          </span>
        )}
      </div>
      {onSchedule && (
        <Button variant="outline" className="min-h-touch w-full" onClick={onSchedule}>
          Ver y agendar clases
        </Button>
      )}
    </div>
  );
}

const FACILITIES_VISIBLE = 5;

function FacilitiesSection({ facilities, loading, error, onRetry, canReserve, enrollment, nombre, onReserve }: {
  facilities: Facility[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  canReserve: boolean;
  enrollment: any | null;
  nombre: string | null;
  onReserve: (f: Facility) => void;
}) {
  const [verTodas, setVerTodas] = useState(false);

  if (loading) return <Skeleton className="h-24 w-full rounded-2xl" />;
  if (error) {
    return (
      <ErrorBox
        titulo="No pudimos cargar las instalaciones"
        detalle="Revisa tu conexión e inténtalo de nuevo."
        onRetry={onRetry}
      />
    );
  }
  if (facilities.length === 0) {
    return canReserve
      ? <p className="px-1 text-sm text-muted-foreground">La escuela todavía no tiene instalaciones para reservar.</p>
      : null;
  }

  const lista = (items: Facility[], bare = false) => (
    <div className={cn(!bare && 'overflow-hidden rounded-2xl border bg-card')}>
      {items.map((f, i) => (
        <div key={f.id} className={cn('flex min-h-touch items-center gap-3 px-4 py-2', i > 0 && 'border-t')}>
          <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{f.name}</span>
            {f.type && <span className="truncate text-xs capitalize text-muted-foreground">{f.type.replace(/_/g, ' ')}</span>}
          </span>
          <Button
            variant={canReserve ? 'default' : 'outline'}
            size="sm"
            className="min-h-touch shrink-0 px-4"
            onClick={() => onReserve(f)}
            aria-label={`Reservar ${f.name}`}
          >
            Reservar
          </Button>
        </div>
      ))}
    </div>
  );

  if (!canReserve) {
    // El plan no trae reservas: «Reservar» abre un «sin acceso». La lista queda
    // plegada (no se pierde: se despliega con un toque).
    return (
      <details className="group rounded-2xl border bg-card">
        <summary className="flex min-h-touch cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-semibold">Instalaciones de la escuela ({facilities.length})</span>
            <span className="text-xs text-muted-foreground">
              {nombre ? `El plan de ${nombre}` : 'Tu plan'} no incluye reservas de instalaciones.
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden="true" />
        </summary>
        <div className="border-t">{lista(facilities, true)}</div>
      </details>
    );
  }

  const plan = enrollment?.plan_details;
  const secLeft = Math.max(0, (plan?.max_secondary_sessions ?? 0) - (enrollment?.secondary_sessions_used ?? 0));
  const visibles = verTodas ? facilities : facilities.slice(0, FACILITIES_VISIBLE);
  return (
    <section className="space-y-2" aria-label="Reservar una instalación">
      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Reservar una instalación</h2>
      <p className="px-1 text-sm text-muted-foreground">
        {secLeft === 1 ? 'Queda 1 reserva' : `Quedan ${secLeft} reservas`} de {plan?.max_secondary_sessions} en el plan.
      </p>
      {lista(visibles)}
      {facilities.length > FACILITIES_VISIBLE && (
        <Button variant="link" className="min-h-touch h-auto px-1 text-sm" onClick={() => setVerTodas((v) => !v)}>
          {verTodas ? 'Ver menos' : `Ver las ${facilities.length} instalaciones`}
        </Button>
      )}
    </section>
  );
}

// ─── Modal: Gestión de clases ─────────────────────────────────────────────────

// ✅ FIX: recibe facilities[] en lugar de facilityId/facilityName hardcodeados
function ScheduleClassModal({ enrollment, facilities, childId, onClose }: {
  enrollment: any;
  facilities: Facility[];
  childId?: string;
  onClose: () => void;
}) {
  const isPT = enrollment.school?.school_type === 'personal_trainer' || 
               enrollment.program?.school_type === 'personal_trainer';
  
  const plan = enrollment.plan_details;
  const isUnlimited = !plan || plan.max_sessions === null;
  const creditsLeft = isUnlimited ? null : Math.max(0, (plan?.max_sessions ?? 0) - (enrollment.sessions_used ?? 0));
  const hasSecondary = (plan?.max_secondary_sessions ?? 0) > 0;
  const secLeft = Math.max(0, (plan?.max_secondary_sessions ?? 0) - (enrollment.secondary_sessions_used ?? 0));
  const secLabel = plan?.secondary_session_label || 'GYM';

  // ✅ FIX: nombre correcto según tipo de enrollment
  const displayName = enrollment.offering?.name ?? enrollment.program?.name ?? 'Clases';
  const planName = plan?.name ?? enrollment.program?.name ?? '';

  const [tab, setTab] = useState<'primary' | 'secondary'>('primary');

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-xl max-h-sheet flex flex-col gap-0 p-0 overflow-hidden">
        <DialogTitle className="sr-only">Gestión de Clases</DialogTitle>

        {/* ✅ FIX: displayName en lugar de teamName */}
        <div className="px-6 pt-5 pb-3 border-b border-border/30">
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Gestión de Clases</p>
          <h2 className="text-lg font-black tracking-tight">{displayName}</h2>
        </div>

        <div className="px-6 py-3 border-b border-border/30 bg-muted/20 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-purple-500" />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">{planName}</p>
              <p className="text-xs font-black">{isUnlimited ? '∞ ilimitadas' : `${creditsLeft} clase${creditsLeft !== 1 ? 's' : ''} disponibles`}</p>
            </div>
          </div>
          {hasSecondary && (
            <>
              <div className="w-px h-8 bg-border/40" />
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Building2 className="h-3.5 w-3.5 text-blue-500" />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-wider text-muted-foreground">{secLabel}</p>
                  <p className="text-xs font-black">{secLeft}/{plan.max_secondary_sessions} disponibles</p>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-6 pt-3 pb-1">
          <div className="flex gap-1 p-1 bg-muted/40 rounded-lg border border-border/30">
            <ModalTab active={tab === 'primary'} onClick={() => setTab('primary')}>
              <Zap className="h-3 w-3" /> Clases
            </ModalTab>
            {hasSecondary && (
              <ModalTab active={tab === 'secondary'} onClick={() => setTab('secondary')}>
                <Building2 className="h-3 w-3" /> {secLabel}
              </ModalTab>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-1">
          {tab === 'primary' && (
            isPT ? (
              <PTPrimarySessionsTab
                enrollment={enrollment}
                creditsLeft={creditsLeft}
                isUnlimited={isUnlimited}
                planName={planName}
                childId={childId}
              />
            ) : (
              <PrimarySessionsTab
                enrollment={enrollment}
                creditsLeft={creditsLeft}
                isUnlimited={isUnlimited}
                planName={planName}
                childId={childId}
              />
            )
          )}
          {tab === 'secondary' && hasSecondary && (
            <SecondarySessionsTab
              enrollment={enrollment}
              facilities={facilities}
              secLabel={secLabel}
              secLeft={secLeft}
              maxSec={plan.max_secondary_sessions}
              childId={childId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ModalTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-semibold rounded-md transition-colors ${active ? 'bg-background text-foreground shadow-sm border border-border/40' : 'text-muted-foreground hover:text-foreground'
        }`}
    >
      {children}
    </button>
  );
}

// ── Tab: Clases Principales ───────────────────────────────────────────────────

function PrimarySessionsTab({ enrollment, creditsLeft, isUnlimited, planName, childId }: {
  enrollment: any; creditsLeft: number | null; isUnlimited: boolean; planName: string; childId?: string;
}) {
  const { data, isLoading, error: sessionsError, refetch: refetchSessions, isFetching: fetchingSessions } = useAvailableSessions(childId);
  const { mutate: book, isPending } = useBookSession(childId);
  const { toast } = useToast();
  const [confirming, setConfirming] = useState<BookableSession | null>(null);
  // Piloto "agendamiento flexible de banco de horas" — sesión personalizada:
  // el diálogo siempre arranca en "Por bloque" (el mínimo del plan,
  // default_minutes). "Personalizada" es una elección explícita, no algo
  // que aparece o desaparece solo — así no se confunde con "la opción no
  // está" cuando en realidad solo no se había tocado el toggle.
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [bookingMode, setBookingMode] = useState<'block' | 'custom'>('block');
  // Piloto "agendamiento flexible": la elección Por bloque / Personalizada
  // es un paso PREVIO al calendario, no algo escondido dentro del diálogo
  // de confirmación de cada horario — se pregunta una vez al abrir, y de
  // ahí en más cada tarjeta ya arranca en el modo elegido (se puede seguir
  // ajustando por sesión desde el diálogo, eso no cambia).
  const [bookingModeChoice, setBookingModeChoice] = useState<'block' | 'custom' | null>(null);
  useEffect(() => {
    setDurationMinutes(confirming?.default_minutes ?? null);
    setBookingMode(bookingModeChoice ?? 'block');
  }, [confirming, bookingModeChoice]);
  useEffect(() => {
    setBookingModeChoice(null);
  }, [enrollment.id]);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [classTypeFilter, setClassTypeFilter] = useState<'all' | 'personal' | 'group'>('all');
  // F-F (D9): días que permite el plan de ESTA inscripción; undefined = todos.
  const planAllowedDays = data?.allowed_days_by_enrollment?.[enrollment.id];

  const allSessions = useMemo(() => {
    const sessions = data?.sessions ?? [];

    let filtered: BookableSession[] = [];

    const byEnrollment = sessions.filter(
      s => s.enrollment_id === enrollment.id && s.booking_status === 'open'
    );
    if (byEnrollment.length > 0) {
      filtered = byEnrollment;
    } else if (enrollment.offering_id) {
      const byOffering = sessions.filter(
        s => s.offering_id === enrollment.offering_id && s.booking_status === 'open'
      );
      if (byOffering.length > 0) filtered = byOffering;
    } else if (enrollment.team_id) {
      filtered = sessions.filter(
        s => s.team?.id === enrollment.team_id && s.booking_status === 'open'
      );
    }

    // ── NUEVO: filtro por horario específico ─────────────────────────────────
    const meta = enrollment.plan_details?.metadata;
    if (meta?.schedule_type === 'specific' && Array.isArray(meta.schedule) && meta.schedule.length > 0) {
      const schedule = meta.schedule as ScheduleSlot[];
      filtered = filtered.filter(s => {
        // getDay() usa 0=Dom…6=Sáb, igual que nuestro SchedulePicker
        const dow = new Date(s.session_date + 'T12:00:00').getDay();
        const sessionHHMM = s.start_time.slice(0, 5); // 'HH:MM'
        return schedule.some(slot => slot.day === dow && slot.time === sessionHHMM);
      });
    }
    // ─────────────────────────────────────────────────────────────────────────

    return filtered;
  }, [data, enrollment]);

  const availableDates = useMemo(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    return new Set(
      allSessions
        .filter(s => {
          if (s.session_date === todayStr) {
            const [h, m] = s.start_time.split(':').map(Number);
            return (h * 60 + m) >= nowMinutes - 15;
          }
          return true;
        })
        .map(s => s.session_date)
    );
  }, [allSessions]);

  const sessionsForDay = useMemo(() => {
    if (!selectedDate) return [];
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    return allSessions
      .filter(s => {
        if (s.session_date !== selectedDate) return false;
        // Si es hoy, ocultar sesiones cuya hora de inicio ya pasó
        // (permitimos 15 min de gracia por si el atleta llega tarde)
        if (selectedDate === todayStr) {
          const [h, m] = s.start_time.split(':').map(Number);
          const sessionMinutes = h * 60 + m;
          return sessionMinutes >= nowMinutes - 15;
        }
        return true;
      })
      .filter(s => {
        if (classTypeFilter === 'all') return true;
        if (classTypeFilter === 'personal') return (s as any).available_for_personal_classes === true;
        if (classTypeFilter === 'group') return (s as any).available_for_group_classes === true && s.max_capacity > 1;
        return true;
      });
  }, [allSessions, selectedDate, classTypeFilter]);

  // "Por bloque" muestra solo los inicios fijos sin solapar; "Personalizada"
  // necesita ver TODAS las horas de inicio para poder arrancar en cualquiera
  // y extender la duración desde ahí.
  const sessionsForDayDisplay = useMemo(() => {
    const base = bookingModeChoice === 'block' ? collapseOverlappingBlocks(sessionsForDay) : sessionsForDay;
    return [...base].sort((a, b) => a.start_time.localeCompare(b.start_time));
  }, [sessionsForDay, bookingModeChoice]);

  const groupedSessions = useMemo(() => {
    const groups: Record<string, BookableSession[]> = {};
    sessionsForDayDisplay.forEach(s => {
      // Unificamos por hora Y tipo — Personal y Grupal ahora pueden compartir
      // el mismo horario (ambos se bundlean a 2h+ en el piloto flexible), así
      // que agrupar solo por hora los mezclaba en una sola tarjeta.
      const key = `${s.start_time}-${s.end_time}-${s.available_for_personal_classes ? 'p' : 'g'}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    });
    return Object.values(groups);
  }, [sessionsForDayDisplay]);

  // "Personalizada" no elige entre bloques ya armados — arma su propio
  // bloque tocando horas sueltas, con la grilla atómica real del coach.
  const flexibleHourGridForDay = useMemo(() => {
    if (!selectedDate) return [];
    return (data?.flexible_hour_grid ?? []).filter(g =>
      g.enrollment_id === enrollment.id &&
      g.session_date === selectedDate &&
      (classTypeFilter === 'all' || g.kind === classTypeFilter)
    );
  }, [data, enrollment.id, selectedDate, classTypeFilter]);

  if (isLoading) return <SkeletonList />;

  const noCredits = !isUnlimited && (creditsLeft ?? 0) <= 0;
  if (noCredits) return <EmptyCenter icon={Zap} title="Sin créditos disponibles" desc={`Tu plan ${planName} no tiene más clases este período`} color="amber" />;
  if (allSessions.length === 0) {
    // Un error al cargar NO es "no hay clases": antes un 500 del BFF se
    // pintaba como «Sin clases disponibles» y el acudiente creía que la
    // academia no tenía horario.
    if (sessionsError) {
      return (
        <div className="space-y-3">
          <EmptyCenter
            icon={AlertCircle}
            title="No pudimos cargar los horarios"
            desc={`${(sessionsError as Error)?.message || 'Error de conexión'}. Intenta de nuevo en un momento.`}
            color="amber"
          />
          <div className="flex justify-center">
            <Button size="sm" variant="outline" onClick={() => refetchSessions()} disabled={fetchingSessions}>
              {fetchingSessions ? 'Cargando…' : 'Reintentar'}
            </Button>
          </div>
        </div>
      );
    }
    const noScheduleReason = data?.no_schedule_reason_by_enrollment?.[enrollment.id];
    if (noScheduleReason === 'team_without_coach') {
      return <EmptyCenter icon={CalendarCheck} title="El equipo no tiene entrenador asignado" desc="Tu academia todavía no asignó un entrenador al grupo de este plan, por eso no hay horarios para reservar. Avísale a la academia." color="amber" />;
    }
    if (noScheduleReason === 'team_without_schedule') {
      return <EmptyCenter icon={CalendarCheck} title="El equipo no tiene horario cargado" desc="Los entrenadores del grupo de este plan todavía no tienen horario en SportMaps, por eso no hay clases para reservar. Avísale a la academia." color="amber" />;
    }
    return <EmptyCenter icon={CalendarCheck} title="Sin clases disponibles" desc="No hay horarios programados. Consulta con tu academia." />;
  }

  // Piloto "agendamiento flexible de banco de horas": si ALGUNA sesión trae
  // default_minutes, este plan es de banco de horas con el piloto activo en
  // la escuela — ahí sí se pregunta bloque vs personalizada antes de mostrar
  // el calendario. Un plan normal (sin banco de horas) nunca ve este paso.
  const flexibleSession = allSessions.find(s => s.default_minutes != null);
  const isFlexibleEligible = !!flexibleSession;

  if (isFlexibleEligible && bookingModeChoice === null) {
    const blockMins = flexibleSession!.default_minutes as number;
    const blockLabel = blockMins % 60 === 0 ? `${blockMins / 60}h` : `${blockMins} min`;
    return (
      <div className="space-y-3 py-2">
        <p className="text-center text-xs text-muted-foreground font-semibold px-4">
          ¿Cómo quieres agendar tu clase de {planName}?
        </p>
        <button
          onClick={() => setBookingModeChoice('block')}
          className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
        >
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black uppercase tracking-tight">Por bloque ({blockLabel})</p>
            <p className="text-xs text-muted-foreground">La duración estándar de tu plan, directo.</p>
          </div>
        </button>
        <button
          onClick={() => setBookingModeChoice('custom')}
          className="w-full rounded-xl border border-border/40 hover:border-primary/50 hover:bg-primary/5 transition-all p-4 flex items-center gap-3 text-left"
        >
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
            <Clock className="h-5 w-5 text-indigo-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-black uppercase tracking-tight">Sesión personalizada</p>
            <p className="text-xs text-muted-foreground">Elige cuántas horas agendar — útil si tienes horas acumuladas por vencer.</p>
          </div>
        </button>
      </div>
    );
  }

  const monthStart = startOfMonth(calendarDate);
  const monthEnd = endOfMonth(calendarDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad = (monthStart.getDay() + 6) % 7;
  const todayDate = startOfDay(new Date());

  return (
    <>
      <div className="space-y-4">
        {isFlexibleEligible && (
          <div className="flex items-center justify-between px-1">
            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground">
              {bookingModeChoice === 'custom' ? '⏱️ Sesión personalizada' : `⚡ Por bloque (${flexibleSession!.default_minutes! % 60 === 0 ? `${flexibleSession!.default_minutes! / 60}h` : `${flexibleSession!.default_minutes} min`})`}
            </p>
            <button onClick={() => setBookingModeChoice(null)} className="text-xs font-bold text-primary hover:underline">
              Cambiar
            </button>
          </div>
        )}
        <div className="rounded-xl border border-border/40 overflow-hidden bg-muted/10">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
            <button onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() - 1))} className="p-1 rounded-md hover:bg-muted/60 transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-black uppercase tracking-wider capitalize">
              {format(calendarDate, 'MMMM yyyy', { locale: es })}
            </p>
            <button onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() + 1))} className="p-1 rounded-md hover:bg-muted/60 transition-colors">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 text-center border-b border-border/20">
            {['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map(d => (
              <div key={d} className="py-2 text-xs font-black text-muted-foreground uppercase">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 p-1">
            {Array.from({ length: startPad }).map((_, i) => <div key={`p${i}`} />)}
            {days.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              // Días permitidos del plan (F-F, D9): fuera de ellos el día queda
              // gris, tachado y con la explicación en el tooltip.
              const dayBlocked = !isDayAllowed(planAllowedDays, dateStr);
              const hasSess = availableDates.has(dateStr) && !dayBlocked;
              const isPast = isBefore(day, todayDate);
              const isToday_ = isToday(day);
              const isSelected = selectedDate === dateStr;
              return (
                <button key={dateStr} disabled={!hasSess || isPast}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  title={dayBlocked && !isPast ? `Tu plan no incluye los ${WEEKDAY_LONG[weekdayOfDateString(dateStr)]} (solo: ${describeAllowedDays(planAllowedDays!)})` : undefined}
                  className={`relative flex flex-col items-center justify-center py-2 mx-0.5 my-0.5 text-xs font-semibold rounded-lg transition-all
                    ${isSelected ? 'bg-primary text-primary-foreground shadow-md'
                      : hasSess && !isPast ? 'bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
                        : 'text-muted-foreground/30 cursor-default'}
                    ${dayBlocked && !isPast ? 'line-through bg-muted/30' : ''}
                    ${isToday_ && !isSelected ? 'ring-1 ring-primary/50' : ''}`}
                >
                  {format(day, 'd')}
                  {hasSess && !isPast && !isSelected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Filtro Personal / Grupal ─────────────────────────────────── */}
        {(() => {
          // Mostrar si hay sesiones de coach (que tienen los flags)
          const hasCoachSessions = allSessions.some(s => (s as any).available_for_personal_classes || (s as any).available_for_group_classes);
          if (!hasCoachSessions) return null;

          return (
            <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-xl border border-border/30 w-fit mx-auto">
              {[
                { key: 'all', label: 'Todas' },
                { key: 'personal', label: '👤 Personal' },
                { key: 'group', label: '👥 Grupal' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setClassTypeFilter(key as any)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${classTypeFilter === key
                      ? 'bg-background text-foreground shadow-sm border border-border/40'
                      : 'text-muted-foreground hover:text-foreground'
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>
          );
        })()}

        {selectedDate ? (
          <div className="space-y-6">
            <p className="text-xs font-black uppercase tracking-widest text-muted-foreground capitalize">
              {format(parseISO(selectedDate), "EEEE d 'de' MMMM", { locale: es })}
              {' · '}{allSessions.filter(s => s.session_date === selectedDate).length} clases
            </p>
            
            {bookingModeChoice === 'custom' ? (
              <HourGridPicker groups={flexibleHourGridForDay} noCredits={noCredits} isBooking={isPending} onBook={setConfirming} allowedDays={planAllowedDays} />
            ) : (() => {
              const morning = groupedSessions.filter(g => parseInt(g[0].start_time.split(':')[0]) < 12);
              const afternoon = groupedSessions.filter(g => {
                const h = parseInt(g[0].start_time.split(':')[0]);
                return h >= 12 && h < 17;
              });
              const evening = groupedSessions.filter(g => parseInt(g[0].start_time.split(':')[0]) >= 17);

              return (
                <div className="space-y-6 pb-4">
                  {morning.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1 text-amber-500">
                        <Sun className="h-4 w-4" />
                        <h4 className="text-xs font-black uppercase tracking-widest">Mañana</h4>
                      </div>
                      <div className="space-y-2">
                        {morning.map(group => (
                          <CompactSessionSlot key={group[0].id} sessions={group} noCredits={noCredits} isBooking={isPending} onBook={setConfirming} allowedDays={planAllowedDays} />
                        ))}
                      </div>
                    </div>
                  )}

                  {afternoon.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1 text-orange-500">
                        <Sunset className="h-4 w-4" />
                        <h4 className="text-xs font-black uppercase tracking-widest">Tarde</h4>
                      </div>
                      <div className="space-y-2">
                        {afternoon.map(group => (
                          <CompactSessionSlot key={group[0].id} sessions={group} noCredits={noCredits} isBooking={isPending} onBook={setConfirming} allowedDays={planAllowedDays} />
                        ))}
                      </div>
                    </div>
                  )}

                  {evening.length > 0 && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 px-1 text-indigo-500">
                        <Moon className="h-4 w-4" />
                        <h4 className="text-xs font-black uppercase tracking-widest">Noche</h4>
                      </div>
                      <div className="space-y-2">
                        {evening.map(group => (
                          <CompactSessionSlot key={group[0].id} sessions={group} noCredits={noCredits} isBooking={isPending} onBook={setConfirming} allowedDays={planAllowedDays} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <p className="text-xs text-center text-muted-foreground py-2">
            Selecciona un día <span className="text-primary font-semibold">disponible</span> para ver los horarios
          </p>
        )}
      </div>

      <AlertDialog open={!!confirming} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar clase</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <div className="rounded-lg border p-3 space-y-1 bg-muted/20">
                  <p className="font-bold text-foreground">{confirming?.team?.name ?? planName}</p>
                  <p className="text-muted-foreground capitalize text-xs">
                    {confirming?.session_date ? format(parseISO(confirming.session_date), "EEEE d 'de' MMMM", { locale: es }) : ''}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {fmtTime(confirming?.start_time ?? '')} — {fmtTime(confirming?.end_time ?? '')}
                  </p>
                  {confirming?.coach && (confirming.coach.full_name || confirming.coach.name) ? (
                    <p className="text-muted-foreground text-xs">Coach: {confirming.coach.full_name || confirming.coach.name}</p>
                  ) : (confirming as any)?.facility?.name ? (
                    <p className="text-muted-foreground text-xs">Instalación: {(confirming as any).facility.name}</p>
                  ) : null}
                </div>
                {/* Piloto "agendamiento flexible de banco de horas": el toggle
                    Por bloque / Personalizada siempre se muestra para estas
                    sesiones — antes la opción personalizada aparecía o no
                    según los datos, y eso se leía como "no existe". */}
                {confirming?.default_minutes != null && confirming?.max_bookable_minutes != null && (
                  <div className="rounded-lg border p-3 space-y-2 bg-primary/5 border-primary/20">
                    <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-lg border border-border/30 w-fit">
                      {([
                        { key: 'block', label: `Por bloque (${confirming.default_minutes % 60 === 0 ? `${confirming.default_minutes / 60}h` : `${Math.floor(confirming.default_minutes / 60)}h ${confirming.default_minutes % 60}m`})` },
                        { key: 'custom', label: 'Personalizada' },
                      ] as const).map(({ key, label }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setBookingMode(key);
                            setDurationMinutes(confirming.default_minutes as number);
                          }}
                          className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all ${
                            bookingMode === key
                              ? 'bg-background text-foreground shadow-sm border border-border/40'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {bookingMode === 'custom' && (
                      confirming.max_bookable_minutes > confirming.default_minutes ? (
                        <>
                          <p className="text-xs font-semibold text-foreground">¿Cuántas horas quieres agendar?</p>
                          <div className="flex flex-wrap gap-2">
                            {Array.from(
                              { length: Math.floor((confirming.max_bookable_minutes - confirming.default_minutes) / 60) + 1 },
                              (_, i) => (confirming.default_minutes as number) + i * 60,
                            ).map((mins) => (
                              <button
                                key={mins}
                                type="button"
                                onClick={() => setDurationMinutes(mins)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                                  durationMinutes === mins
                                    ? 'bg-primary text-primary-foreground border-primary shadow-sm'
                                    : 'border-border/50 text-muted-foreground hover:border-primary/40'
                                }`}
                              >
                                {mins % 60 === 0 ? `${mins / 60}h` : `${Math.floor(mins / 60)}h ${mins % 60}m`}
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Sesión personalizada — útil si tienes horas acumuladas por vencer.
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          No hay más horas seguidas disponibles con este entrenador a partir de este horario — se agendará el bloque de {confirming.default_minutes % 60 === 0 ? `${confirming.default_minutes / 60}h` : `${confirming.default_minutes} min`}.
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction disabled={isPending} onClick={() => {
              if (!confirming) return;
              book({ session_id: confirming.id, enrollment_id: confirming.enrollment_id, duration_minutes: durationMinutes ?? undefined }, {
                onSuccess: () => {
                  toast({ title: '✅ Clase agendada', description: `${format(parseISO(confirming.session_date), "EEE d MMM", { locale: es })} · ${fmtTime(confirming.start_time)}` });
                  setConfirming(null);
                  setSelectedDate(null);
                },
                onError: (err: any) => {
                  const body = err?.cause ?? err?.response?.data ?? {};
                  const dayMsg = dayNotAllowedMessage(err);
                  if (dayMsg) {
                    toast({ title: 'Ese día no está en tu plan', description: dayMsg, variant: 'destructive' });
                  } else if (body?.reason === 'already_booked') {
                    toast({ title: 'Ya tienes esta clase agendada', description: 'Cancela la reserva existente antes de volver a agendar.', variant: 'destructive' });
                  } else if (body?.error === 'session_full') {
                    toast({ title: 'Clase llena', description: 'Ya no quedan cupos disponibles para esta clase.', variant: 'destructive' });
                  } else {
                    toast({ title: 'Error al agendar', description: err.message, variant: 'destructive' });
                  }
                  setConfirming(null);
                },
              });
            }}>
              {isPending ? 'Agendando...' : 'Confirmar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Tab especializada para Personal Trainer
 * Permite agendar slots individuales usando créditos del plan
 */
function PTPrimarySessionsTab({ enrollment, creditsLeft, isUnlimited, planName, childId }: {
  enrollment: any;
  creditsLeft: number | null;
  isUnlimited: boolean;
  planName: string;
  childId?: string;
}) {
  const { toast } = useToast();
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<any | null>(null);
  const [classTypeFilter, setClassTypeFilter] = useState<'all' | 'personal' | 'group'>('all');

  const { data, isLoading, isFetching } = usePTAvailability(enrollment.id, childId);
  const availableDays = useMemo(() => new Set(data?.available_days ?? []), [data?.available_days]);
  const { mutate: book, isPending: isBooking } = useBookPTSession(childId);

  // El PT normalmente tiene slots casi todos los días, así que permitimos navegar libremente
  const monthStart = startOfMonth(calendarDate);
  const monthEnd = endOfMonth(calendarDate);
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd });
  const startPad = (monthStart.getDay() + 6) % 7;
  const todayDate = startOfDay(new Date());

  const handleBook = (slot: PTAvailabilitySlot) => {
    if (slot.is_booked) return;
    if (!isUnlimited && creditsLeft !== null && creditsLeft <= 0) {
      toast({ title: 'Sin créditos', description: 'No tienes créditos disponibles en tu plan.', variant: 'destructive' });
      return;
    }
    setConfirming(slot);
  };

  const availability = useMemo(() => {
    const raw = data?.slots || [];
    if (!selectedDate) return [];

    // Filtro de Hora Colombiana (UTC-5)
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const isTodaySelected = selectedDate === todayStr;

    const now = new Date();
    const colombiaTimeStr = now.toLocaleTimeString('en-US', {
      timeZone: 'America/Bogota',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });

    const processed = [];
    for (const s of raw) {
      // Validar fecha
      if (s.session_date !== selectedDate) continue;

      // Validar hora si es hoy
      if (isTodaySelected) {
        const slotTime = s.start_time.substring(0, 5); // HH:mm
        if (slotTime < colombiaTimeStr) continue;
      }

      // Si permite Personal Y (filtro es 'all' o 'personal')
      if (s.available_for_personal_classes && (classTypeFilter === 'all' || classTypeFilter === 'personal')) {
        processed.push({ ...s, _displayType: 'personal', _key: `${s.availability_id}-${s.session_date}-personal` });
      }

      // Si permite Grupal Y (filtro es 'all' o 'group')
      if (s.available_for_group_classes && (classTypeFilter === 'all' || classTypeFilter === 'group')) {
        processed.push({ ...s, _displayType: 'group', _key: `${s.availability_id}-${s.session_date}-group` });
      }
    }

    return processed;
  }, [data, classTypeFilter, selectedDate]);

  if (isLoading || (isFetching && !data)) return <SkeletonList />;

  return (
    <>
      <div className="space-y-4">
        {/* Calendario tipo Mes */}
        <div className="rounded-xl border border-border/40 overflow-hidden bg-muted/10">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
            <button onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() - 1))} className="p-1 rounded-md hover:bg-muted/60 transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-black uppercase tracking-wider capitalize">
              {format(calendarDate, 'MMMM yyyy', { locale: es })}
            </p>
            <button onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() + 1))} className="p-1 rounded-md hover:bg-muted/60 transition-colors">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 text-center border-b border-border/20">
            {['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'].map(d => (
              <div key={d} className="py-2 text-xs font-black text-muted-foreground uppercase">{d}</div>
            ))}
          </div>

          <div className="grid grid-cols-7 p-1">
            {Array.from({ length: startPad }).map((_, i) => <div key={`p${i}`} />)}
            {days.map(day => {
              const dateStr = format(day, 'yyyy-MM-dd');
              const isPast = isBefore(day, todayDate);
              const isToday_ = isToday(day);
              const isSelected = selectedDate === dateStr;
              const dayOfWeek = (day.getDay() + 6) % 7; 
              const isAvailable = availableDays.has(day.getDay());
              
              return (
                <button key={dateStr} disabled={isPast}
                  onClick={() => setSelectedDate(isSelected ? null : dateStr)}
                  className={`relative flex flex-col items-center justify-center py-2 mx-0.5 my-0.5 text-xs font-semibold rounded-lg transition-all
                    ${isSelected ? 'bg-primary text-primary-foreground shadow-md'
                      : (isAvailable && !isPast) ? 'bg-primary/10 text-primary hover:bg-primary/20 cursor-pointer'
                        : 'text-muted-foreground/30 cursor-default'}
                    ${isToday_ && !isSelected ? 'ring-1 ring-primary/50' : ''}`}
                >
                  {format(day, 'd')}
                  {isAvailable && !isPast && !isSelected && (
                    <span className="absolute bottom-1 w-1 h-1 rounded-full bg-primary/40" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Filtro Personal / Grupal (PT) ───────────────────────────── */}
        {selectedDate && data?.slots && data.slots.length > 0 && (
          <div className="flex items-center gap-1 p-1 bg-muted/40 rounded-xl border border-border/30 w-fit mx-auto">
            {[
              { key: 'all', label: 'Todas' },
              { key: 'personal', label: '👤 Personal' },
              { key: 'group', label: '👥 Grupal' },
            ].map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setClassTypeFilter(key as any)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${classTypeFilter === key
                  ? 'bg-background text-foreground shadow-sm border border-border/40'
                  : 'text-muted-foreground hover:text-foreground'
                  }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="space-y-3">
          {!selectedDate ? (
            <div className="py-8 text-center text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border/40">
              <Calendar className="h-8 w-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs font-medium">Selecciona una fecha para ver disponibilidad</p>
            </div>
          ) : availability.length === 0 ? (
            <EmptyCenter icon={Calendar} title="Sin disponibilidad" desc="No hay horarios disponibles para este día. Recuerda que las sesiones deben agendarse con al menos 6 horas de anticipación." color="amber" />
          ) : (
            <div className="space-y-6">
              <p className="text-xs font-black uppercase tracking-widest text-muted-foreground capitalize px-1">
                Disponibilidad para el {format(parseISO(selectedDate), "EEEE d 'de' MMMM", { locale: es })}
              </p>
              
              {(() => {
                const grouped = {
                  morning: availability.filter(s => parseInt(s.start_time.split(':')[0]) < 12),
                  afternoon: availability.filter(s => {
                    const h = parseInt(s.start_time.split(':')[0]);
                    return h >= 12 && h < 17;
                  }),
                  evening: availability.filter(s => parseInt(s.start_time.split(':')[0]) >= 17),
                };

                return (
                  <div className="space-y-6 pb-4">
                    {[
                      { key: 'morning', label: 'Mañana', icon: Sun, color: 'text-amber-500', slots: grouped.morning },
                      { key: 'afternoon', label: 'Tarde', icon: Sunset, color: 'text-orange-500', slots: grouped.afternoon },
                      { key: 'evening', label: 'Noche', icon: Moon, color: 'text-indigo-500', slots: grouped.evening },
                    ].map(section => section.slots.length > 0 && (
                      <div key={section.key} className="space-y-3">
                        <div className={`flex items-center gap-2 px-1 ${section.color}`}>
                          <section.icon className="h-4 w-4" />
                          <h4 className="text-xs font-black uppercase tracking-widest">{section.label}</h4>
                        </div>
                        <div className="space-y-2">
                          {section.slots.map((slot: any) => (
                            <Card key={slot._key} 
                              className={`overflow-hidden border-border/40 transition-all ${
                                slot.is_booked 
                                  ? (slot.is_my_booking ? 'bg-slate-50 border-slate-200 shadow-sm' : 'opacity-40 grayscale bg-muted/20')
                                  : 'hover:border-slate-400/40 hover:bg-muted/5'
                              }`}
                            >
                              <CardContent className="p-0">
                                <div className="flex items-center gap-4 px-4 py-3">
                                  <div className={`flex flex-col items-center justify-center shrink-0 w-16 h-10 rounded-lg border 
                                    ${slot.is_my_booking ? 'bg-slate-900 text-white border-slate-900' : 'bg-muted/30 border-border/30'}`}>
                                    <p className="text-sm font-black italic leading-none">{fmtTime(slot.start_time).split(' ')[0]}</p>
                                    <p className="text-[8px] font-black uppercase opacity-70">{fmtTime(slot.start_time).split(' ')[1]}</p>
                                  </div>
              
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                                      <User className="h-3 w-3" /> {slot.coach.full_name}
                                    </p>
                                    <p className="text-xs font-black uppercase tracking-tight truncate mt-0.5">
                                      {slot.is_my_booking 
                                        ? 'Tu Sesión' 
                                        : (slot.is_booked 
                                          ? 'Ocupado' 
                                          : (slot._displayType === 'group' ? '👥 Clase Grupal' : '👤 Clase Personal')
                                          )
                                      }
                                    </p>
                                  </div>
              
                                  {slot.is_my_booking ? (
                                    <Badge className="bg-green-600 hover:bg-green-700">Agendada</Badge>
                                  ) : slot.is_booked ? (
                                    <Badge variant="secondary">No disponible</Badge>
                                  ) : (
                                    <Button size="sm" onClick={() => handleBook(slot)} disabled={isBooking}
                                      className="h-8 px-4 text-xs font-black uppercase tracking-wider rounded-xl bg-slate-900 hover:bg-black text-white">
                                      Reservar
                                    </Button>
                                  )}
                                </div>
                              </CardContent>
                            </Card>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={!!confirming} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <AlertDialogContent className="sm:max-w-modal-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-slate-950 text-white">
                <CalendarCheck className="h-5 w-5" />
              </div>
              Confirmar Sesión PT
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                <div className="rounded-2xl border border-border/50 p-4 bg-muted/20 space-y-3">
                  <p className="font-bold text-foreground">{planName}</p>
                  <p className="text-muted-foreground text-xs capitalize">
                    {selectedDate ? format(parseISO(selectedDate), "EEEE d 'de' MMMM", { locale: es }) : ''}
                  </p>
                  <p className="text-foreground font-black text-sm">
                    {fmtTime(confirming?.start_time ?? '')} — {fmtTime(confirming?.end_time ?? '')}
                  </p>
                </div>
                
                <div className={`rounded-xl px-4 py-3 text-sm font-medium border-2 ${isUnlimited ? 'bg-green-500/5 text-green-700 border-green-500/20' : 'bg-amber-500/5 text-amber-700 border-amber-500/20'}`}>
                  {isUnlimited 
                    ? 'Plan ilimitado — no se descuenta crédito' 
                    : `Se usará 1 crédito de tu plan (quedarán ${(creditsLeft ?? 1) - 1})`}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-xl border-border/50">Volver</AlertDialogCancel>
            <AlertDialogAction 
              className="bg-slate-950 hover:bg-black text-white rounded-xl font-bold" 
              disabled={isBooking}
              onClick={() => {
                if (!confirming || !selectedDate) return;
                book({
                  enrollment_id: enrollment.id,
                  session_date: selectedDate,
                  session_time: confirming.start_time,
                  session_type: confirming._displayType
                }, {
                  onSuccess: () => {
                    toast({ title: '✅ Sesión agendada', description: 'Tu reserva ha sido confirmada.' });
                    setConfirming(null);
                  },
                  onError: (err: any) => {
                    toast({ title: 'Error al agendar', description: err.message, variant: 'destructive' });
                    setConfirming(null);
                  }
                });
              }}
            >
              {isBooking ? 'Agendando...' : 'Confirmar Reserva'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Tab: Clases Secundarias (GYM) ─────────────────────────────────────────────

// ✅ FIX: recibe facilities[] y permite al usuario elegir instalación
function SecondarySessionsTab({ enrollment, facilities, secLabel, secLeft, maxSec, childId }: {
  enrollment: any;
  facilities: Facility[];
  secLabel: string;
  secLeft: number;
  maxSec: number;
  childId?: string;
}) {
  const { mutate: bookSec, isPending } = useBookSecondarySession(childId);
  const { toast } = useToast();

  const todayStr = useMemo(() => new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().split('T')[0], []);

  // ✅ FIX: estado para la instalación seleccionada — no hardcodeado
  const [selectedFacilityId, setSelectedFacilityId] = useState<string>(facilities[0]?.id ?? '');
  const selectedFacility = facilities.find(f => f.id === selectedFacilityId) ?? facilities[0];

  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [selectedSlots, setSelectedSlots] = useState<{ start: string; end: string }[]>([]);
  const [isConfirming, setIsConfirming] = useState(false);

  // Reset slots al cambiar instalación o fecha
  const handleFacilityChange = (id: string) => {
    setSelectedFacilityId(id);
    setSelectedSlots([]);
  };

  const { data: slotsData, isLoading: slotsLoading } = useFacilitySlots(
    selectedFacilityId, selectedDate, childId
  );
  const availableDates = getNextAvailableDates(14);
  const slots = slotsData?.slots ?? [];

  const toggleSlot = (slot: { start: string; end: string; available: boolean; already_booked: boolean }) => {
    if (!slot.available || slot.already_booked) return;
    const exists = selectedSlots.find(s => s.start === slot.start);
    if (exists) {
      setSelectedSlots(selectedSlots.filter(s => s.start !== slot.start));
    } else {
      if (selectedSlots.length >= 2) {
        toast({ title: "Máximo 2 horas", description: "Solo puedes agendar hasta 2 horas por transacción.", variant: "destructive" });
        return;
      }
      setSelectedSlots([...selectedSlots, { start: slot.start, end: slot.end }]);
    }
  };

  const calculateCredits = () => {
    if (selectedSlots.length === 0) return 0;
    if (selectedSlots.length === 1) return 1;
    const sorted = [...selectedSlots].sort((a, b) => a.start.localeCompare(b.start));
    return sorted[0].end === sorted[1].start ? 1 : 2;
  };

  const creditsNeeded = calculateCredits();

  if (secLeft <= 0) {
    return <EmptyCenter icon={Building2} title={`Sin clases ${secLabel}`} desc={`Has usado las ${maxSec} clases incluidas en tu plan este período`} color="blue" />;
  }

  return (
    <>
      {/* ✅ FIX: selector de instalación visible solo si hay más de una */}
      {facilities.length > 1 && (
        <div className="flex gap-2 flex-wrap mb-3">
          {facilities.map(f => (
            <button
              key={f.id}
              onClick={() => handleFacilityChange(f.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${selectedFacilityId === f.id
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'border-border/50 text-muted-foreground hover:border-blue-400/50 hover:text-foreground'
                }`}
            >
              {f.name}
            </button>
          ))}
        </div>
      )}

      <div className="px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/20 mb-3 flex items-center justify-between">
        <p className="text-xs text-blue-600 font-medium flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5" />
          {selectedFacility?.name} · {secLeft} de {maxSec} {secLabel} disponibles
        </p>
        {selectedSlots.length > 0 && (
          <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700" onClick={() => setIsConfirming(true)}>
            Agendar {selectedSlots.length} {selectedSlots.length === 1 ? 'hora' : 'horas'}
          </Button>
        )}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide">
        {availableDates.map(date => {
          const isSel = selectedDate === date;
          const d = parseISO(date);
          return (
            <button
              key={date}
              onClick={() => { setSelectedDate(date); setSelectedSlots([]); }}
              className={`shrink-0 flex flex-col items-center px-4 py-2.5 rounded-2xl border transition-all ${isSel ? 'bg-blue-600 text-white border-blue-600 shadow-lg shadow-blue-500/20' : 'bg-muted/30 border-border/40 hover:border-blue-400/30'
                }`}
            >
              <span className={`uppercase text-xs font-black tracking-widest ${isSel ? 'text-white/70' : 'text-muted-foreground'}`}>
                {format(d, 'EEE', { locale: es })}
              </span>
              <span className="text-base font-black leading-tight mt-0.5">{format(d, 'd')}</span>
            </button>
          );
        })}
      </div>

      {slotsLoading ? <SkeletonList /> : slots.length === 0 ? (
        <EmptyCenter icon={Building2} title="Instalación cerrada" desc="No hay horarios disponibles para este día" color="blue" />
      ) : (
        <div className="space-y-2">
          {slots.map((slot) => {
            const isSelected = selectedSlots.some(s => s.start === slot.start);
            const isBooked = slot.already_booked;
            return (
              <Card key={slot.start} onClick={() => toggleSlot(slot)}
                className={`overflow-hidden border-border/40 transition-all cursor-pointer ${isBooked ? 'bg-green-500/5 border-green-500/30 opacity-80' :
                    isSelected ? 'bg-blue-600/10 border-blue-600 shadow-md transform scale-[1.01]' :
                      !slot.available ? 'opacity-40 grayscale cursor-not-allowed' :
                        'hover:border-blue-400/40 hover:bg-muted/10'
                  }`}
              >
                <CardContent className="p-0">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className={`w-1 self-stretch rounded-full ${isBooked ? 'bg-green-600' : isSelected ? 'bg-blue-600' : 'bg-blue-400/30'}`} />
                    <div className="text-center shrink-0 w-16">
                      <p className="text-sm font-black leading-none">{fmtTime(slot.start + ':00')}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{fmtTime(slot.end + ':00')}</p>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="text-xs font-semibold">{selectedFacility?.name}</p>
                        {isBooked && <Badge className="text-xs h-4 px-1.5 bg-green-600">Agendada</Badge>}
                        {isSelected && <Badge variant="outline" className="text-xs h-4 px-1.5 border-blue-600 text-blue-600 bg-blue-500/5">Seleccionada</Badge>}
                        {!slot.available && !isBooked && <Badge variant="secondary" className="text-xs h-4 px-1.5">Ocupado</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" /> 1 hora · Uso libre
                      </p>
                    </div>
                    {isBooked ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                    ) : isSelected ? (
                      <div className="h-5 w-5 rounded-full bg-blue-600 flex items-center justify-center">
                        <CheckCircle2 className="h-3.5 w-3.5 text-white" />
                      </div>
                    ) : (
                      <div className={`h-5 w-5 rounded-full border-2 transition-colors ${!slot.available ? 'border-muted' : 'border-muted hover:border-blue-400'}`} />
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
        <AlertDialogContent className="rounded-3xl border-0 shadow-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black tracking-tight flex items-center gap-2">
              <Building2 className="h-5 w-5 text-blue-600" />
              Confirmar agendamiento
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                <div className="rounded-2xl border border-border/50 p-4 bg-muted/20 space-y-3">
                  <div className="pb-2 border-b border-border/30">
                    <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1">Instalación</p>
                    <p className="font-bold text-foreground">{selectedFacility?.name}</p>
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-muted-foreground mb-1">Fecha y Horarios</p>
                    <p className="text-foreground font-bold text-sm capitalize mb-2">{fmtDateLong(selectedDate ?? '')}</p>
                    <div className="grid grid-cols-1 gap-1.5">
                      {selectedSlots.sort((a, b) => a.start.localeCompare(b.start)).map((s, idx) => (
                        <div key={idx} className="flex items-center gap-2 bg-background/50 rounded-lg px-2.5 py-1.5 border border-border/30">
                          <Clock className="h-3 w-3 text-blue-600" />
                          <p className="text-foreground text-xs font-bold">{fmtTime(s.start + ':00')} — {fmtTime(s.end + ':00')}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className={`rounded-xl px-4 py-3 text-sm font-medium border-2 ${creditsNeeded === 1 ? 'bg-emerald-500/5 text-emerald-700 border-emerald-500/20' : 'bg-blue-500/5 text-blue-700 border-blue-500/20'}`}>
                  <div className="flex items-center gap-2.5">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${creditsNeeded === 1 ? 'bg-emerald-500 text-white' : 'bg-blue-600 text-white'}`}>
                      <Zap className="h-4 w-4 fill-current" />
                    </div>
                    <div>
                      <p className="font-black text-sm">Costo: {creditsNeeded} {creditsNeeded === 1 ? 'crédito' : 'créditos'}</p>
                      <p className="text-xs opacity-70">
                        {creditsNeeded === 1 ? 'Ahorras 1 crédito por reservar horas consecutivas.' : 'Se descuentan créditos individuales por horas separadas.'}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="bg-muted/10 p-3 rounded-xl border border-dashed border-border flex items-center gap-2 justify-center">
                  <p className="text-xs font-medium text-muted-foreground">
                    Te quedarán <span className="text-foreground font-bold">{secLeft - creditsNeeded}</span> clases {secLabel}.
                  </p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2 pt-2">
            <AlertDialogCancel className="rounded-2xl border-border/50 font-bold hover:bg-muted/50">Volver</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={() => {
                if (!selectedDate || selectedSlots.length === 0 || !selectedFacilityId) return;
                bookSec({
                  enrollment_id: enrollment.id,
                  facility_id: selectedFacilityId,
                  reservation_date: selectedDate,
                  slots: selectedSlots.map(s => ({ start_time: s.start, end_time: s.end })),
                  ...(childId && { child_id: childId }),
                }, {
                  onSuccess: () => {
                    toast({ title: "Reserva confirmada", description: "Tus clases de gimnasio han sido agendadas." });
                    setIsConfirming(false);
                    setSelectedSlots([]);
                  },
                  onError: (err: any) => toast({ title: "Error", description: err.message, variant: "destructive" }),
                });
              }}
              className="rounded-2xl font-bold bg-blue-600 hover:bg-blue-700 shadow-lg shadow-blue-500/20"
            >
              {isPending ? 'Procesando...' : 'Confirmar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── Pestañas Clases y Reservas ─────────────────────────────────────────────────────────

function MyBookingsTab({ secLabel, filter = 'all', childId, allBookings }: {
  hasSecondary: boolean; secLabel: string; filter?: 'all' | 'primary' | 'secondary'; childId?: string;
  allBookings: any[];
}) {
  const { data: primary, isLoading: l1, error: e1, refetch: r1 } = useMyBookings(childId);
  const { data: secondary, isLoading: l2, error: e2, refetch: r2 } = useMySecondaryBookings(childId);
  const { mutate: cancelP, isPending: cp } = useCancelBooking(childId);
  const { mutate: cancelS, isPending: cs } = useCancelSecondaryBooking(childId);
  const { mutate: cancelPT, isPending: cpt } = useCancelPTSession(childId);
  const { toast } = useToast();
  const [verAnteriores, setVerAnteriores] = useState(false);

  // ✅ Distinguir cancelación normal vs PT
  const [cancelling, setCancelling] = useState<{
    id: string;
    type: 'p' | 's' | 'pt';
    label: string;
    sessionDate?: string;
    sessionTime?: string;
  } | null>(null);

  if (l1 || l2) return <SkeletonList />;

  const queryError = (filter !== 'secondary' && e1) || (filter !== 'primary' && e2);
  if (queryError) {
    return (
      <ErrorBox
        titulo={filter === 'secondary' ? 'No pudimos cargar las reservas' : 'No pudimos cargar las clases'}
        detalle="Esto no quiere decir que no haya nada agendado. Revisa tu conexión e inténtalo de nuevo."
        onRetry={() => { if (filter !== 'secondary') r1(); if (filter !== 'primary') r2(); }}
      />
    );
  }

  const primaryBookings = (filter === 'all' || filter === 'primary') ? (primary ?? []).filter((b: any) => b.status?.toLowerCase() !== 'cancelled') : [];
  const secondaryBookings = (filter === 'all' || filter === 'secondary') ? (secondary ?? []).filter((b: any) => b.status?.toLowerCase() !== 'cancelled') : [];

  if (primaryBookings.length === 0 && secondaryBookings.length === 0) {
    return filter === 'secondary' ? (
      <div className="rounded-2xl border bg-card p-6 text-center">
        <p className="font-semibold">No hay reservas</p>
        <p className="mt-1 text-sm text-muted-foreground">Cuando reserves una instalación, aparece aquí.</p>
      </div>
    ) : (
      <div className="rounded-2xl border bg-card p-6 text-center">
        <p className="font-semibold">No hay clases agendadas</p>
        <p className="mt-1 text-sm text-muted-foreground">Agenda desde el plan, en «Equipos y planes».</p>
      </div>
    );
  }

  // Usar las reservas ya filtradas y unificadas del padre
  const bookingsToShow = allBookings.filter(b => {
    if (filter === 'primary') return b._type === 'primary';
    if (filter === 'secondary') return b._type === 'secondary';
    return true;
  });

  const groups: Record<string, any[]> = {};
  bookingsToShow.forEach(b => {
    const d = bookingDate(b);
    if (!groups[d]) groups[d] = [];
    groups[d].push(b);
  });

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const proximos = Object.keys(groups).filter((d) => d >= todayStr).sort();
  // Lo ya pasado va plegado y del más reciente al más viejo.
  const anteriores = Object.keys(groups).filter((d) => d < todayStr).sort().reverse();

  const renderDia = (dateStr: string) => {
    const day = parseISO(dateStr);
    const isPastDay = isBefore(day, startOfDay(new Date()));
    return (
      <section key={dateStr} className="space-y-2" aria-label={fmtDateLong(dateStr)}>
        <h3 className="flex items-center gap-2 px-1 text-sm font-semibold first-letter:uppercase">
          {fmtDateLong(dateStr)}
          {isToday(day) && <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">Hoy</span>}
        </h3>
        <div className="overflow-hidden rounded-2xl border bg-card">
          {groups[dateStr].map((b, i) => {
            const isPrimary = b._type === 'primary';
            const s = isPrimary ? b.attendance_sessions : b;
            if (!s) return null;
            const isPT = (b as any).school_type === 'personal_trainer';
            const puedeCancelar = !isPastDay && !s.finalized && b.status === 'confirmed';
            return (
              <div key={b.id} className={cn('flex min-h-touch items-center gap-3 px-4 py-3', i > 0 && 'border-t', isPastDay && 'opacity-70')}>
                <span className="flex h-touch w-touch shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden="true">
                  {isPrimary ? (isPT ? <User className="h-5 w-5" /> : <Trophy className="h-5 w-5" />) : <Building2 className="h-5 w-5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{bookingName(b)}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtTime(s.start_time)}{s.end_time ? ` – ${fmtTime(s.end_time)}` : ''} · {isPrimary ? 'Clase' : secLabel}
                  </p>
                  {(s.finalized || b.status === 'attended' || isPT) && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {s.finalized && <Badge variant="secondary" className="text-xs">Finalizada</Badge>}
                      {b.status === 'attended' && (
                        <Badge className="border-transparent bg-emerald-100 text-xs text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300">Asistió</Badge>
                      )}
                      {isPT && (
                        <Badge variant="outline" className="text-xs">{b.session_type === 'group' ? 'Grupal' : 'Personal'}</Badge>
                      )}
                    </div>
                  )}
                </div>
                {puedeCancelar && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-touch shrink-0 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Cancelar ${bookingName(b)} del ${fmtDateShort(dateStr)}`}
                    onClick={() => setCancelling({
                      id: b.id,
                      type: isPrimary ? (isPT ? 'pt' : 'p') : 's',
                      label: fmtDateShort(dateStr),
                      sessionDate: dateStr,
                      sessionTime: s.start_time,
                    })}
                  >
                    Cancelar
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <>
      <div className="space-y-4">
        {proximos.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">
            {filter === 'secondary' ? 'No hay reservas próximas.' : 'No hay clases próximas.'}
          </p>
        )}
        {proximos.map(renderDia)}
        {anteriores.length > 0 && (
          <div className="space-y-4">
            <Button variant="link" className="min-h-touch h-auto px-1 text-sm" onClick={() => setVerAnteriores((v) => !v)} aria-expanded={verAnteriores}>
              {verAnteriores ? 'Ocultar las anteriores' : `Ver las anteriores (${anteriores.reduce((n, d) => n + groups[d].length, 0)})`}
            </Button>
            {verAnteriores && anteriores.map(renderDia)}
          </div>
        )}
      </div>

      <AlertDialog open={!!cancelling} onOpenChange={(o) => { if (!o) setCancelling(null); }}>
        <AlertDialogContent className="sm:max-w-modal-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Cancelar {cancelling?.type === 'pt' ? 'sesión PT' : 'reserva'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling?.type === 'pt'
                ? <>¿Cancelar tu sesión del <span className="font-bold text-foreground">{cancelling.label}</span>? Si faltan menos de 4 horas, tu entrenador decidirá si devuelve el crédito.</>
                : <>¿Estás seguro de cancelar tu reserva del <span className="font-bold text-foreground">{cancelling?.label}</span>? El cupo se liberará y el crédito será devuelto a tu plan automáticamente.</>
              }
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-xl border-border/50">Cerrar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-xl font-bold"
              disabled={cp || cs || cpt}
              onClick={() => {
                if (!cancelling) return;

                if (cancelling.type === 'pt') {
                  cancelPT(cancelling.id, {
                    onSuccess: () => {
                      toast({ title: '✅ Sesión cancelada', description: 'El crédito fue devuelto a tu plan.' });
                      setCancelling(null);
                    },
                    onError: (err: any) => {
                      // Fuera de ventana — mostrar mensaje especial
                      if (err?.message?.includes('outside_cancel_window') || err?.status === 400) {
                        toast({
                          title: '⏰ Cancelación solicitada',
                          description: 'Tu solicitud fue enviada al entrenador. Él decidirá si devuelve el crédito.',
                        });
                      } else {
                        toast({ title: 'Error', description: err.message, variant: 'destructive' });
                      }
                      setCancelling(null);
                    },
                  });
                } else {
                  const fn = cancelling.type === 'p' ? cancelP : cancelS;
                  (fn as any)(cancelling.id, {
                    onSuccess: () => {
                      toast({ title: '✅ Reserva cancelada', description: 'El cupo ha sido liberado.' });
                      setCancelling(null);
                    },
                    onError: (err: any) => {
                      toast({ title: 'Error', description: err.message, variant: 'destructive' });
                      setCancelling(null);
                    },
                  });
                }
              }}>
              {(cp || cs || cpt) ? 'Cancelando...' : 'Sí, cancelar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Modal: Reservar Instalación (standalone) ─────────────────────────────────

// ✅ FIX: recibe facility completo (no facilityId/facilityName separados)
// enrollment ya viene calculado con lógica de créditos desde el padre
function FacilityReserveModal({ facility, enrollment, childId, onClose }: {
  facility: Facility; enrollment: any | null; childId?: string; onClose: () => void;
}) {
  const plan = enrollment?.plan_details;
  const hasSecondary = (plan?.max_secondary_sessions ?? 0) > 0;
  const secLeft = Math.max(0, (plan?.max_secondary_sessions ?? 0) - (enrollment?.secondary_sessions_used ?? 0));
  const secLabel = plan?.secondary_session_label || 'GYM';

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md max-h-sheet flex flex-col gap-0 p-0 overflow-hidden">
        <DialogTitle className="sr-only">Reservar {facility.name}</DialogTitle>
        <div className="px-6 pt-5 pb-3 border-b border-border/30">
          <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Instalación</p>
          <h2 className="text-lg font-black tracking-tight">{facility.name}</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!enrollment || !hasSecondary ? (
            <EmptyCenter icon={Building2} title="Sin acceso al gimnasio"
              desc="Tu plan actual no incluye clases de gimnasio. Consulta con tu academia los planes disponibles." color="blue" />
          ) : (
            // Pasamos una sola instalación como array para reutilizar SecondarySessionsTab
            <SecondarySessionsTab
              enrollment={enrollment}
              facilities={[facility]}
              secLabel={secLabel}
              secLeft={secLeft}
              maxSec={plan.max_secondary_sessions}
              childId={childId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Modal: Detalle Equipo ────────────────────────────────────────────────────

const ESTADO_INSCRIPCION: Record<string, string> = {
  active: 'Activa', pending: 'Por aprobar', paused: 'En pausa', expired: 'Vencida', cancelled: 'Cancelada',
};

function TeamDetailModal({ enrollment, onClose }: { enrollment: any; onClose: () => void }) {
  const { program } = enrollment;
  const filas: [string, string | undefined][] = [
    ['Escuela', program.school?.name],
    ['Ciudad', program.school?.city],
    ['Estado', ESTADO_INSCRIPCION[enrollment.status] ?? enrollment.status],
  ];
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-modal-sm">
        <div className="flex items-start gap-3 pr-6">
          <SportBadge sport={program.sport} trainer={program.school_type === 'personal_trainer'} />
          <div className="min-w-0">
            <DialogTitle className="text-lg font-bold leading-snug">{program.name}</DialogTitle>
            <p className="text-sm capitalize text-muted-foreground">Equipo{program.sport ? ` · ${program.sport}` : ''}</p>
          </div>
        </div>
        <dl className="overflow-hidden rounded-2xl border bg-card">
          {filas.filter(([, v]) => !!v).map(([k, v], i) => (
            <div key={k} className={cn('flex min-h-touch items-center justify-between gap-3 px-4 py-2', i > 0 && 'border-t')}>
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd className="text-right text-sm font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <Button variant="outline" className="min-h-touch w-full" onClick={onClose}>Cerrar</Button>
      </DialogContent>
    </Dialog>
  );
}

// ─── Micro UI ─────────────────────────────────────────────────────────────────

function SkeletonList() {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 rounded-xl bg-muted/40 animate-pulse border border-border/30" />
      ))}
    </div>
  );
}

function EmptyCenter({ icon: Icon, title, desc, color = 'muted' }: {
  icon: any; title: string; desc: string; color?: string;
}) {
  const colorMap: Record<string, string> = {
    muted: 'bg-muted/40 text-muted-foreground',
    amber: 'bg-amber-500/10 text-amber-500',
    blue: 'bg-blue-500/10 text-blue-500',
    green: 'bg-green-500/10 text-green-500',
  };
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
      <div className={`w-12 h-12 rounded-full flex items-center justify-center ${colorMap[color] ?? colorMap.muted}`}>
        <Icon className="h-6 w-6" />
      </div>
      <p className="font-bold text-sm">{title}</p>
      <p className="text-xs text-muted-foreground max-w-xs">{desc}</p>
    </div>
  );
}