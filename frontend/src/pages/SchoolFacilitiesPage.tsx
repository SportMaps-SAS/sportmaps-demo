import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  Building2, MapPin, Trash2, Users, Calendar, Clock,
  CheckCircle2, XCircle, Eye, Pencil, Ban, MoreHorizontal, CalendarCheck, RefreshCw, Link2, Check,
  GraduationCap, Settings, UserX, PartyPopper, Mail, CalendarClock, MessageCircle, Copy,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSchoolFacilities } from '@/hooks/useSchoolData';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useFacilityReservations } from '@/hooks/useFacilityReservations';
import type { FacilityReservation } from '@/hooks/useFacilityReservations';
import { useTrialClasses, type TrialClassBooking, type TrialClassStatus, type BookingChangeNotice } from '@/hooks/useTrialClasses';
import { FacilityFormDialog } from '@/components/school/FacilityFormDialog';
import { OwnerReservationModal } from '@/components/school/OwnerReservationModal';
import { FacilityRatesPanel } from '@/components/reservas/FacilityRatesPanel';
import { FacilityAvailabilityModal } from '@/components/school/FacilityAvailabilityModal';
import { TrialClassBookingModal } from '@/components/school/TrialClassBookingModal';
import { TrialClassSettingsModal } from '@/components/school/TrialClassSettingsModal';
import { TrialClassRescheduleModal } from '@/components/school/TrialClassRescheduleModal';
import { CourtesyBookingRescheduleModal } from '@/components/school/CourtesyBookingRescheduleModal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { StatFilterBar } from '@/components/common/StatFilterBar';
import { TableRefreshBar } from '@/components/common/TableRefreshBar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { format, parseISO } from 'date-fns';
import { es } from 'date-fns/locale';

// ─── Status helpers (Improved for Dark Mode) ──────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  completed: 'Completada',
  hold: 'Apartada',
  pending_payment: 'Pendiente de pago',
  pending_reconciliation: 'Por conciliar',
  expired: 'Vencida',
  no_show: 'No asistió',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 border-yellow-500/20',
  confirmed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-500/20',
  cancelled: 'bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-500/20',
  completed: 'bg-blue-500/10 text-blue-600 dark:text-blue-500 border-blue-500/20',
  hold: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 border-yellow-500/20',
  pending_payment: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 border-yellow-500/20',
  pending_reconciliation: 'bg-orange-500/10 text-orange-600 dark:text-orange-500 border-orange-500/20',
  expired: 'bg-muted text-muted-foreground border-border/40',
  no_show: 'bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-500/20',
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5 mr-1.5" />,
  confirmed: <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />,
  cancelled: <XCircle className="h-3.5 w-3.5 mr-1.5" />,
  completed: <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />,
};

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={`text-[11px] font-bold py-0.5 flex items-center w-fit shadow-sm backdrop-blur-[2px] ${STATUS_COLORS[status] ?? ''}`}>
      {STATUS_ICONS[status]}
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ─── Trial class status helpers ────────────────────────────────────────────────

const TRIAL_STATUS_LABELS: Record<TrialClassStatus, string> = {
  agendada: 'Agendada',
  realizada: 'Realizada',
  no_show: 'No-show',
  cancelada: 'Cancelada',
  convertida: 'Convertida',
};

const TRIAL_STATUS_COLORS: Record<TrialClassStatus, string> = {
  agendada: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-500 border-yellow-500/20',
  realizada: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-500 border-emerald-500/20',
  no_show: 'bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-500/20',
  cancelada: 'bg-rose-500/10 text-rose-600 dark:text-rose-500 border-rose-500/20',
  convertida: 'bg-blue-500/10 text-blue-600 dark:text-blue-500 border-blue-500/20',
};

function TrialStatusBadge({ status }: { status: TrialClassStatus }) {
  return (
    <Badge variant="outline" className={`text-[11px] font-bold py-0.5 flex items-center w-fit shadow-sm backdrop-blur-[2px] ${TRIAL_STATUS_COLORS[status]}`}>
      {TRIAL_STATUS_LABELS[status]}
    </Badge>
  );
}

function TrialClassRow({
  booking, onMarkRealizada, onMarkNoShow, onMarkConvertida, onCancel, onResendEmail, onReschedule,
}: {
  booking: TrialClassBooking;
  onMarkRealizada: () => void;
  onMarkNoShow: () => void;
  onMarkConvertida: () => void;
  onCancel: () => void;
  onResendEmail: () => void;
  onReschedule: () => void;
}) {
  return (
    <TableRow className="group hover:bg-muted/5 transition-colors">
      <TableCell className="font-bold py-5">
        <span className="text-sm">{booking.is_minor ? booking.child_name : booking.prospect_name}</span>
        <span className="block text-[10px] text-muted-foreground font-medium mt-0.5">
          {booking.is_minor ? `Acudiente: ${booking.prospect_name}` : booking.prospect_email}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Calendar className="h-3.5 w-3.5 text-primary opacity-60" />
          {format(parseISO(booking.scheduled_date), 'dd MMM yyyy', { locale: es })}
          <span className="opacity-40">·</span>
          <span className="font-bold">{booking.start_time.slice(0, 5)}</span>
        </div>
      </TableCell>
      <TableCell>
        <TrialStatusBadge status={booking.status} />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted font-black">
              <MoreHorizontal className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 p-1.5 bg-card border-border/40 backdrop-blur-md shadow-2xl">
            {booking.status === 'agendada' && (
              <>
                <DropdownMenuItem className="py-2.5 font-bold cursor-pointer text-emerald-600 focus:text-emerald-700 focus:bg-emerald-500/10" onClick={onMarkRealizada}>
                  <CheckCircle2 className="h-4 w-4 mr-3" /> Marcar realizada
                </DropdownMenuItem>
                <DropdownMenuItem className="py-2.5 font-bold cursor-pointer text-amber-600 focus:text-amber-700 focus:bg-amber-500/10" onClick={onMarkNoShow}>
                  <UserX className="h-4 w-4 mr-3" /> Marcar no-show
                </DropdownMenuItem>
                <DropdownMenuItem className="py-2.5 font-bold cursor-pointer" onClick={onReschedule}>
                  <CalendarClock className="h-4 w-4 mr-3 text-primary" /> Reprogramar
                </DropdownMenuItem>
                <DropdownMenuSeparator className="my-1.5 opacity-40" />
                <DropdownMenuItem className="py-2.5 font-bold cursor-pointer text-rose-600 focus:text-rose-700 focus:bg-rose-500/10" onClick={onCancel}>
                  <Ban className="h-4 w-4 mr-3" /> Cancelar
                </DropdownMenuItem>
              </>
            )}
            {booking.status === 'realizada' && (
              <DropdownMenuItem className="py-2.5 font-bold cursor-pointer text-blue-600 focus:text-blue-700 focus:bg-blue-500/10" onClick={onMarkConvertida}>
                <PartyPopper className="h-4 w-4 mr-3" /> Marcar convertida
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="py-2.5 font-bold cursor-pointer" onClick={onResendEmail}>
              <Mail className="h-4 w-4 mr-3 text-primary" /> Reenviar correo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

// ─── Reservation detail modal ─────────────────────────────────────────────────

function ReservationDetailModal({
  reservation,
  onClose,
  onApprove,
  onCancel,
}: {
  reservation: FacilityReservation;
  onClose: () => void;
  onApprove: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md bg-card text-card-foreground border-border/40 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">Detalle de Reserva</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <div className="bg-primary/5 border border-primary/10 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-bold text-lg">
                {reservation.requester?.full_name ?? reservation.requester?.email ?? 'Usuario'}
              </p>
              <StatusBadge status={reservation.status} />
            </div>
            {reservation.facility && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
                <Building2 className="h-4 w-4 text-primary" />
                <span>{reservation.facility.name}</span>
                <span className="text-xs opacity-40">|</span>
                <span className="text-xs uppercase tracking-wider">{reservation.facility.type}</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-6 text-sm">
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Fecha</p>
              <p className="font-bold">
                {format(parseISO(reservation.reservation_date), 'PPP', { locale: es })}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Horario</p>
              <p className="font-bold flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-primary" />
                {reservation.start_time.slice(0, 5)} — {reservation.end_time.slice(0, 5)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Precio</p>
              <p className="font-bold text-emerald-600 dark:text-emerald-500">
                {reservation.price > 0
                  ? `$${reservation.price.toLocaleString('es-CO')} COP`
                  : 'Sin costo'}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Participantes</p>
              <p className="font-bold">{reservation.participants || '—'}</p>
            </div>
          </div>

          {reservation.notes && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Notas</p>
              <p className="text-sm bg-muted/40 rounded-lg p-4 italic text-muted-foreground border border-border/30">
                "{reservation.notes}"
              </p>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            {reservation.status === 'pending' && (
              <>
                <Button
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-11"
                  onClick={() => { onApprove(reservation.id); onClose(); }}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" /> Aprobar
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 text-rose-600 border-rose-200 dark:border-rose-900/50 hover:bg-rose-50 dark:hover:bg-rose-950/30 font-bold h-11"
                  onClick={() => { onCancel(reservation.id); onClose(); }}
                >
                  <XCircle className="h-4 w-4 mr-2" /> Rechazar
                </Button>
              </>
            )}
            {reservation.status !== 'pending' && (
              <Button variant="outline" className="w-full h-11 font-bold border-border/50" onClick={onClose}>Cerrar</Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SchoolFacilitiesPage() {
  const { schoolId } = useSchoolContext();
  const {
    facilities: supaFacilities,
    isLoading: facilitiesLoading,
    createFacility,
    deleteFacility,
    updateFacility,
    isCreating,
    isUpdating: facilitiesUpdating,
  } = useSchoolFacilities();

  const {
    reservations,
    isLoading: reservationsLoading,
    isFetching: reservationsFetching,
    refetch: refetchReservations,
    stats,
    createReservation,
    deleteReservation,
    approveReservation,
    completeReservation,
    cancelReservation,
    hasMore: hasMoreReservations,
    loadMore: loadMoreReservations,
    rescheduleReservation,
  } = useFacilityReservations();

  const {
    bookings: trialBookings,
    isLoading: trialLoading,
    isFetching: trialFetching,
    refetch: refetchTrialBookings,
    stats: trialStats,
    updateStatus: updateTrialStatus,
    resendConfirmation: resendTrialConfirmation,
  } = useTrialClasses();

  const [reschedulingTrial, setReschedulingTrial] = useState<TrialClassBooking | null>(null);
  const [trialNotice, setTrialNotice] = useState<BookingChangeNotice | null>(null);

  const facilities = supaFacilities ?? [];

  // UI state
  const [facilityDialogOpen, setFacilityDialogOpen] = useState(false);
  const [editingFacility, setEditingFacility] = useState<any | null>(null);
  const [deleteFacilityId, setDeleteFacilityId] = useState<string | null>(null);

  // Trial classes UI state
  const [trialBookingModalOpen, setTrialBookingModalOpen] = useState(false);
  const [trialSettingsModalOpen, setTrialSettingsModalOpen] = useState(false);
  const [trialStatusFilter, setTrialStatusFilter] = useState<TrialClassStatus | null>(null);
  const [cancelingTrialId, setCancelingTrialId] = useState<string | null>(null);

  // Reservation CRUD state
  const [reservationModalOpen, setReservationModalOpen] = useState(false);
  const [viewingReservation, setViewingReservation] = useState<FacilityReservation | null>(null);
  const [deleteReservationId, setDeleteReservationId] = useState<string | null>(null);
  // Cancelar pide el motivo (opcional) antes de avisar a la persona.
  const [cancelingReservationId, setCancelingReservationId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [isCancellingReservation, setIsCancellingReservation] = useState(false);
  const cancelingReservation = reservations.find((r) => r.id === cancelingReservationId) ?? null;
  const cancelingFacility = cancelingReservation
    ? facilities.find((f) => f.id === cancelingReservation.facility_id) ?? null
    : null;

  const requestCancelReservation = (id: string) => {
    setCancelReason('');
    setCancelingReservationId(id);
  };

  const confirmCancelReservation = async () => {
    if (!cancelingReservationId) return;
    setIsCancellingReservation(true);
    try {
      // El servidor valida la política de cancelación; si responde 409 el hook muestra el motivo.
      await cancelReservation(cancelingReservationId, cancelReason.trim() || undefined);
      setCancelingReservationId(null);
    } catch {
      // el toast de error ya lo muestra el hook; el diálogo queda abierto para reintentar o cerrar
    } finally {
      setIsCancellingReservation(false);
    }
  };
  const [reschedulingFacilityReservation, setReschedulingFacilityReservation] = useState<FacilityReservation | null>(null);
  const [reschedulingCourtesyBooking, setReschedulingCourtesyBooking] = useState<FacilityReservation | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [availabilityFacility, setAvailabilityFacility] = useState<any | null>(null);

  // Derived filtered reservations
  const filteredReservations = statusFilter 
    ? (reservations ?? []).filter(r => r.status === statusFilter)
    : (reservations ?? []);

  const { toast } = useToast();
  const [schoolSlug, setSchoolSlug] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    (supabase.from('schools') as any)
      .select('slug')
      .eq('id', schoolId)
      .maybeSingle()
      .then(({ data }: any) => {
        if (data?.slug) {
          setSchoolSlug(data.slug);
        }
      });
  }, [schoolId]);

  const handleCopyLink = () => {
    if (!schoolSlug) return;
    const url = `${window.location.origin}/agendar/${schoolSlug}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: '📋 Link copiado', description: 'El enlace de agendamiento público se copió al portapapeles.' });
  };

  // Handlers
  const handleFacilitySubmit = (data: any) => {
    if (editingFacility) {
      updateFacility({ id: editingFacility.id, ...data });
    } else {
      createFacility(data);
    }
    setFacilityDialogOpen(false);
    setEditingFacility(null);
  };

  const handleOpenNewFacility = () => {
    setEditingFacility(null);
    setFacilityDialogOpen(true);
  };

  const handleEditFacility = (facility: any) => {
    setEditingFacility(facility);
    setFacilityDialogOpen(true);
  };

  const handleDeleteFacility = () => {
    if (deleteFacilityId) { deleteFacility(deleteFacilityId); setDeleteFacilityId(null); }
  };

  const handleDeleteReservation = async () => {
    if (deleteReservationId) {
      await deleteReservation(deleteReservationId);
      setDeleteReservationId(null);
    }
  };

  const handleOpenNew = () => {
    setReservationModalOpen(true);
  };

  // Reprogramar es una acción aparte de "Editar": para instalaciones (alquiler
  // manual) reusa el mismo modal de fecha/hora pero pasa por el endpoint que
  // avisa por correo; para clases de cortesía abre el picker de slots por
  // cancha (reprogramar fecha/hora no existía para ellas).
  const handleOpenReschedule = (r: FacilityReservation) => {
    if (r.isSessionBooking) {
      setReschedulingCourtesyBooking(r);
    } else {
      setReschedulingFacilityReservation(r);
    }
  };

  // Reprogramar una fila sin starts_at (anterior a F1): rutas viejas de reservations-admin.
  // Las filas con starts_at las reprograma el propio modal por POST /reservations/:id/reschedule.
  const handleLegacyReschedule = async (p: { id: string; reservation_date: string; start_time: string; end_time: string }) => {
    await rescheduleReservation({
      id: p.id,
      isSessionBooking: false,
      reservation_date: p.reservation_date,
      start_time: p.start_time,
      end_time: p.end_time,
    });
  };

  if (facilitiesLoading) return <LoadingSpinner text="Cargando instalaciones..." />;

  // ── Empty state ──
  if (facilities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center space-y-6 min-h-[60dvh]">
        <div className="bg-primary/10 p-5 rounded-full ring-8 ring-primary/5">
          <Building2 className="w-14 h-14 text-primary" />
        </div>
        <div className="max-w-md space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">Configura tus Instalaciones</h1>
          <p className="text-muted-foreground text-lg italic">
            Aún no has registrado ninguna sede, cancha o gimnasio. Comienza ahora para habilitar reservas.
          </p>
        </div>
        <Button size="lg" className="h-12 px-8 font-bold text-base shadow-xl shadow-primary/20" onClick={() => setFacilityDialogOpen(true)}>
          <Building2 className="w-5 h-5 mr-3" /> Agregar Primera Instalación
        </Button>
        <FacilityFormDialog
          open={facilityDialogOpen}
          onOpenChange={setFacilityDialogOpen}
          onSubmit={createFacility}
          isLoading={isCreating}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <Tabs defaultValue="facilities" className="space-y-8">
        <div className="flex items-center justify-between border-b pb-1">
          <TabsList className="bg-muted/50 p-1 border border-border/50">
            <TabsTrigger value="facilities" className="px-6 py-2.5 font-bold data-[state=active]:shadow-md">Instalaciones</TabsTrigger>
            <TabsTrigger value="reservations" className="px-6 py-2.5 font-bold data-[state=active]:shadow-md">
              Reservas
              {stats.pending > 0 && (
                <Badge className="ml-2 bg-yellow-500 text-white text-[10px] px-1.5 py-0 min-w-5 flex items-center justify-center font-black">
                  {stats.pending}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="trial-classes" className="px-6 py-2.5 font-bold data-[state=active]:shadow-md">
              Clases de Prueba
              {trialStats.agendada > 0 && (
                <Badge className="ml-2 bg-primary text-primary-foreground text-[10px] px-1.5 py-0 min-w-5 flex items-center justify-center font-black">
                  {trialStats.agendada}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="rates" className="px-6 py-2.5 font-bold data-[state=active]:shadow-md">
              Tarifas y política
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ═══════════════ INSTALACIONES ═══════════════ */}
        <TabsContent value="facilities" className="space-y-8 animate-in slide-in-from-left-4 duration-300">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight">Instalaciones</h1>
              <p className="text-muted-foreground mt-1.5 flex items-center gap-2 font-medium">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                {facilities.length} espacio{facilities.length !== 1 ? 's' : ''} deportivo{facilities.length !== 1 ? 's' : ''} gestionado{facilities.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              {schoolSlug && (
                <Button variant="outline" className="font-bold h-11 border-2 border-border/80" onClick={handleCopyLink}>
                  {copied ? <Check className="w-4 h-4 mr-2 text-emerald-600 dark:text-emerald-500" /> : <Link2 className="w-4 h-4 mr-2" />}
                  {copied ? '¡Copiado!' : 'Copiar Link Público'}
                </Button>
              )}
              <Button className="font-bold h-11 shadow-lg shadow-primary/20" onClick={handleOpenNewFacility}>
                <Building2 className="w-4 h-4 mr-2" /> Agregar Instalación
              </Button>
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {facilities.map((facility) => (
              <Card key={facility.id} className="group relative overflow-hidden border-border/40 hover:border-primary/40 hover:shadow-2xl hover:shadow-primary/5 transition-all duration-300 transform hover:-translate-y-1">
                <div className="p-6 space-y-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="p-2 rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                        <MapPin className="w-4 h-4" />
                      </div>
                      <h3 className="font-bold text-lg leading-tight">{facility.name}</h3>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground/40 hover:text-primary hover:bg-primary/10"
                        onClick={() => setAvailabilityFacility(facility)}
                        title="Configurar disponibilidad"
                      >
                        <Clock className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground/40 hover:text-primary hover:bg-primary/10" onClick={() => handleEditFacility(facility)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10" onClick={() => setDeleteFacilityId(facility.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary" className="bg-muted/80 font-bold uppercase tracking-widest text-[9px] px-2">{facility.type}</Badge>
                    <Badge
                      variant={facility.status === 'available' ? 'default' : 'outline'}
                      className={facility.status === 'available' ? 'bg-primary/90' : 'border-primary/20 text-primary/60'}
                    >
                      {facility.status === 'available' ? 'Disponible' : 'Ocupado'}
                    </Badge>
                  </div>
                  
                  <div className="pt-2 flex items-center gap-2 text-sm text-muted-foreground/80 font-medium whitespace-nowrap overflow-hidden">
                    <Users className="w-4 h-4 text-primary/60" />
                    <span>Capacidad: <span className="text-foreground font-bold">{facility.capacity}</span> personas</span>
                  </div>
                  
                  {facility.description && (
                    <p className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-2 italic">"{facility.description}"</p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ═══════════════ RESERVAS ═══════════════ */}
        <TabsContent value="reservations" className="space-y-8 animate-in slide-in-from-right-4 duration-300">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-4xl font-black tracking-tight">Gestión de Reservas</h1>
              <p className="text-muted-foreground font-medium mt-1.5 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                {stats.total} reservas en historial · <span className="text-foreground font-bold">{stats.pending}</span> por confirmar
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="font-bold h-11"
                onClick={() => void refetchReservations()}
                disabled={reservationsFetching}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${reservationsFetching ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Actualizar</span>
              </Button>
              <Button className="font-bold h-11 shadow-lg shadow-primary/20" onClick={handleOpenNew}>
                <Users className="mr-2 h-4 w-4" /> Nueva Reserva
              </Button>
            </div>
          </div>

          {/* Stats Bar */}
          <StatFilterBar
            value={statusFilter}
            onChange={setStatusFilter}
            items={[
              { key: null, label: 'Total Historial', value: stats.total, tone: 'neutral' },
              { key: 'confirmed', label: 'Confirmadas', value: stats.confirmed, tone: 'emerald' },
              { key: 'pending', label: 'Pendientes', value: stats.pending, tone: 'yellow' },
              { key: 'cancelled', label: 'Canceladas', value: stats.cancelled, tone: 'rose' },
              { key: 'completed', label: 'Completadas', value: stats.completed, tone: 'blue' },
            ]}
          />

          {/* Table Container */}
          <Card className="border-border/40 overflow-hidden shadow-xl shadow-foreground/5 mb-10">
            <div className="p-0">
              {reservationsLoading ? (
                <div className="p-12 text-center space-y-4">
                  <Loader2 className="h-10 w-10 text-primary animate-spin mx-auto" />
                  <p className="text-muted-foreground font-medium animate-pulse">Actualizando…</p>
                </div>
              ) : filteredReservations.length === 0 ? (
                <div className="p-20 text-center space-y-6">
                  <div className="bg-muted/30 w-16 h-16 rounded-full flex items-center justify-center mx-auto ring-4 ring-muted/10">
                    <CalendarCheck className="h-8 w-8 text-muted-foreground/60" />
                  </div>
                  <div className="max-w-xs mx-auto space-y-2">
                    <p className="text-foreground font-bold text-lg">No hay reservas {statusFilter ? `en estado '${STATUS_LABELS[statusFilter]}'` : 'registradas'}</p>
                    <p className="text-muted-foreground text-sm">
                      {statusFilter 
                        ? 'Prueba seleccionando otro filtro o agrega una nueva reserva.'
                        : 'Tus registros de alquiler y bloqueos aparecerán aquí una vez que los crees.'}
                    </p>
                  </div>
                  {!statusFilter && (
                    <Button variant="outline" className="font-bold border-2 hover:bg-primary hover:text-primary-foreground transition-all" onClick={handleOpenNew}>
                      Crear primera reserva
                    </Button>
                  )}
                  {statusFilter && (
                    <Button variant="ghost" className="font-bold border bg-muted/20" onClick={() => setStatusFilter(null)}>
                      Limpiar filtros
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/20">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Instalación {statusFilter && <Badge variant="secondary" className="ml-2 text-[8px] bg-primary/20 text-primary">{STATUS_LABELS[statusFilter]}</Badge>}</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Solicitante</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Fecha</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Horario</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Estado</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredReservations.map((res) => (
                        <TableRow key={res.id} className="group hover:bg-muted/5 transition-colors">
                          <TableCell className="font-bold py-5">
                            <span className="text-sm">{res.facility?.name ?? '—'}</span>
                            <span className="block text-[10px] text-muted-foreground font-black uppercase tracking-tighter mt-0.5 opacity-60">
                              {res.facility?.type}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span className="text-sm font-semibold">
                              {res.requester?.full_name ?? res.requester?.email ?? '—'}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <Calendar className="h-3.5 w-3.5 text-primary opacity-60" />
                              {format(parseISO(res.reservation_date), 'dd MMM yyyy', { locale: es })}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <Clock className="h-3.5 w-3.5 text-primary opacity-60" />
                              <span className="font-bold">{res.start_time.slice(0, 5)}</span>
                              <span className="opacity-40">—</span>
                              <span className="font-bold">{res.end_time.slice(0, 5)}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={res.status} />
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full hover:bg-muted font-black">
                                  <MoreHorizontal className="h-5 w-5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52 p-1.5 bg-card border-border/40 backdrop-blur-md shadow-2xl">
                                {/* View */}
                                <DropdownMenuItem className="py-2.5 font-bold cursor-pointer" onClick={() => setViewingReservation(res)}>
                                  <Eye className="h-4 w-4 mr-3 text-primary" /> Ver detalle
                                </DropdownMenuItem>

                                {/* Reschedule — cambia fecha/hora y avisa por correo */}
                                {(res.status === 'pending' || res.status === 'confirmed' || res.status === 'hold' || res.status === 'pending_payment') && (
                                  <DropdownMenuItem className="py-2.5 font-bold cursor-pointer" onClick={() => handleOpenReschedule(res)}>
                                    <CalendarClock className="h-4 w-4 mr-3 text-primary" /> Reprogramar
                                  </DropdownMenuItem>
                                )}

                                <DropdownMenuSeparator className="my-1.5 opacity-40" />

                                {/* Approve */}
                                {res.status === 'pending' && (
                                  <DropdownMenuItem
                                    className="py-2.5 font-bold cursor-pointer text-emerald-600 focus:text-emerald-700 focus:bg-emerald-500/10"
                                    onClick={() => approveReservation(res.id)}
                                  >
                                    <CheckCircle2 className="h-4 w-4 mr-3" /> Aprobar
                                  </DropdownMenuItem>
                                )}

                                {/* Complete — la reserva ya se usó (confirmed -> completed) */}
                                {res.status === 'confirmed' && (
                                  <DropdownMenuItem
                                    className="py-2.5 font-bold cursor-pointer text-blue-600 focus:text-blue-700 focus:bg-blue-500/10"
                                    onClick={() => completeReservation(res.id)}
                                  >
                                    <CheckCircle2 className="h-4 w-4 mr-3" /> Marcar como completada
                                  </DropdownMenuItem>
                                )}

                                {/* Cancel — avisa por correo */}
                                {(res.status === 'pending' || res.status === 'confirmed' || res.status === 'hold' || res.status === 'pending_payment') && (
                                  <DropdownMenuItem
                                    className="py-2.5 font-bold cursor-pointer text-amber-600 focus:text-amber-700 focus:bg-amber-500/10"
                                    onClick={() => requestCancelReservation(res.id)}
                                  >
                                    <Ban className="h-4 w-4 mr-3" /> Cancelar
                                  </DropdownMenuItem>
                                )}

                                {/* Delete */}
                                <DropdownMenuItem
                                  className="py-2.5 font-bold cursor-pointer text-rose-600 focus:text-rose-700 focus:bg-rose-500/10"
                                  onClick={() => setDeleteReservationId(res.id)}
                                >
                                  <Trash2 className="h-4 w-4 mr-3" /> Eliminar
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
            {hasMoreReservations && (
              <div className="flex flex-col items-center gap-2 border-t border-border/40 p-4 text-center">
                <p className="text-xs text-muted-foreground">
                  Mostrando las reservas más recientes; los totales cuentan solo lo cargado.
                </p>
                <Button variant="outline" size="sm" className="font-bold" onClick={loadMoreReservations} disabled={reservationsFetching}>
                  Ver más
                </Button>
              </div>
            )}
            <TableRefreshBar
              onRefresh={refetchReservations}
              loading={reservationsFetching}
              summary={`${filteredReservations.length} de ${stats.total} reservas`}
            />
          </Card>
        </TabsContent>

        {/* ═══════════════ CLASES DE PRUEBA ═══════════════ */}
        {/* ═══════════════ TARIFAS Y POLÍTICA DE CANCELACIÓN ═══════════════ */}
        <TabsContent value="rates" className="space-y-8 animate-in slide-in-from-right-4 duration-300">
          <FacilityRatesPanel facilities={facilities} />
        </TabsContent>

        <TabsContent value="trial-classes" className="space-y-8 animate-in slide-in-from-right-4 duration-300">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-4xl font-black tracking-tight">Agenda de Clases de Prueba</h1>
              <p className="text-muted-foreground font-medium mt-1.5 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                {trialStats.total} clases agendadas en total · <span className="text-foreground font-bold">{trialStats.agendada}</span> pendientes
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="font-bold h-11" onClick={() => setTrialSettingsModalOpen(true)}>
                <Settings className="mr-2 h-4 w-4" /> <span className="hidden sm:inline">Configurar</span>
              </Button>
              <Button
                variant="outline"
                className="font-bold h-11"
                onClick={() => void refetchTrialBookings()}
                disabled={trialFetching}
              >
                <RefreshCw className={`mr-2 h-4 w-4 ${trialFetching ? 'animate-spin' : ''}`} />
                <span className="hidden sm:inline">Actualizar</span>
              </Button>
              <Button className="font-bold h-11 shadow-lg shadow-primary/20" onClick={() => setTrialBookingModalOpen(true)}>
                <GraduationCap className="mr-2 h-4 w-4" /> Agendar Clase de Prueba
              </Button>
            </div>
          </div>

          <StatFilterBar
            value={trialStatusFilter}
            onChange={(v) => setTrialStatusFilter(v as TrialClassStatus | null)}
            items={[
              { key: null, label: 'Total', value: trialStats.total, tone: 'neutral' },
              { key: 'agendada', label: 'Agendadas', value: trialStats.agendada, tone: 'yellow' },
              { key: 'realizada', label: 'Realizadas', value: trialStats.realizada, tone: 'emerald' },
              { key: 'no_show', label: 'No-show', value: trialStats.no_show, tone: 'rose' },
              { key: 'convertida', label: 'Convertidas', value: trialStats.convertida, tone: 'blue' },
              { key: 'cancelada', label: 'Canceladas', value: trialStats.cancelada, tone: 'rose' },
            ]}
          />

          <Card className="border-border/40 overflow-hidden shadow-xl shadow-foreground/5 mb-10">
            <div className="p-0">
              {trialLoading ? (
                <div className="p-12 text-center space-y-4">
                  <Loader2 className="h-10 w-10 text-primary animate-spin mx-auto" />
                  <p className="text-muted-foreground font-medium animate-pulse">Cargando agenda…</p>
                </div>
              ) : (trialStatusFilter ? trialBookings.filter((b) => b.status === trialStatusFilter) : trialBookings).length === 0 ? (
                <div className="p-20 text-center space-y-6">
                  <div className="bg-muted/30 w-16 h-16 rounded-full flex items-center justify-center mx-auto ring-4 ring-muted/10">
                    <GraduationCap className="h-8 w-8 text-muted-foreground/60" />
                  </div>
                  <div className="max-w-xs mx-auto space-y-2">
                    <p className="text-foreground font-bold text-lg">
                      No hay clases de prueba {trialStatusFilter ? `en estado '${TRIAL_STATUS_LABELS[trialStatusFilter]}'` : 'agendadas'}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      Agenda la primera clase de prueba para un prospecto atado a la disponibilidad de un entrenador.
                    </p>
                  </div>
                  {!trialStatusFilter && (
                    <Button variant="outline" className="font-bold border-2 hover:bg-primary hover:text-primary-foreground transition-all" onClick={() => setTrialBookingModalOpen(true)}>
                      Agendar primera clase de prueba
                    </Button>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/20">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Prospecto</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Fecha</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest">Estado</TableHead>
                        <TableHead className="py-4 font-black text-xs uppercase tracking-widest text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(trialStatusFilter ? trialBookings.filter((b) => b.status === trialStatusFilter) : trialBookings).map((b) => (
                        <TrialClassRow
                          key={b.id}
                          booking={b}
                          onMarkRealizada={() => updateTrialStatus({ id: b.id, status: 'realizada' })}
                          onMarkNoShow={() => updateTrialStatus({ id: b.id, status: 'no_show' })}
                          onMarkConvertida={() => updateTrialStatus({ id: b.id, status: 'convertida' })}
                          onCancel={() => setCancelingTrialId(b.id)}
                          onResendEmail={() => resendTrialConfirmation(b.id)}
                          onReschedule={() => setReschedulingTrial(b)}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Reservation detail ── */}
      {viewingReservation && (
        <ReservationDetailModal
          reservation={viewingReservation}
          onClose={() => setViewingReservation(null)}
          onApprove={approveReservation}
          onCancel={requestCancelReservation}
        />
      )}

      {/* ── Nueva reserva (BFF: disponibilidad + POST /reservations) ── */}
      <OwnerReservationModal
        open={reservationModalOpen}
        onOpenChange={setReservationModalOpen}
        facilities={facilities}
        onBlock={createReservation}
        onChanged={() => void refetchReservations()}
      />

      {/* ── Reprogramar reserva de instalación (POST /reservations/:id/reschedule) ── */}
      <OwnerReservationModal
        open={!!reschedulingFacilityReservation}
        onOpenChange={(v) => { if (!v) setReschedulingFacilityReservation(null); }}
        facilities={facilities}
        editReservation={reschedulingFacilityReservation}
        onBlock={createReservation}
        onLegacyReschedule={handleLegacyReschedule}
        onChanged={() => void refetchReservations()}
      />

      {/* ── Reprogramar clase de cortesía — avisa por correo ── */}
      <CourtesyBookingRescheduleModal
        reservation={reschedulingCourtesyBooking}
        onClose={() => setReschedulingCourtesyBooking(null)}
      />

      {/* ── Facility form ── */}
      <FacilityFormDialog
        open={facilityDialogOpen}
        onOpenChange={(open) => {
          setFacilityDialogOpen(open);
          if (!open) setEditingFacility(null);
        }}
        onSubmit={handleFacilitySubmit}
        isLoading={isCreating || facilitiesUpdating}
        facility={editingFacility}
      />

      {/* ── Cancelar reserva: motivo opcional + política ── */}
      <AlertDialog open={!!cancelingReservationId} onOpenChange={(v) => { if (!v && !isCancellingReservation) setCancelingReservationId(null); }}>
        <AlertDialogContent className="bg-card text-card-foreground border-border/40">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black">¿Cancelar reserva?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground/80 font-medium">
              Se le avisará a la persona por correo. Puedes contarle el motivo (opcional).
              {cancelingFacility && (cancelingFacility.min_cancellation_hours ?? 0) > 0 && (
                <span className="mt-2 block text-foreground/80">
                  Política de esta instalación: se cancela con al menos {cancelingFacility.min_cancellation_hours} h de anticipación.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="Motivo de la cancelación (opcional)"
            maxLength={500}
            rows={3}
          />
          <AlertDialogFooter className="pt-2">
            <AlertDialogCancel className="font-bold border-border/60" disabled={isCancellingReservation}>No, conservar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); void confirmCancelReservation(); }}
              disabled={isCancellingReservation}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-black"
            >
              {isCancellingReservation ? 'Cancelando…' : 'Sí, cancelar reserva'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete reservation confirm ── */}
      <AlertDialog open={!!deleteReservationId} onOpenChange={() => setDeleteReservationId(null)}>
        <AlertDialogContent className="bg-card text-card-foreground border-border/40 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-destructive" />
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black">¿Eliminar reserva?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground/80 font-medium">
              Esta acción no se puede deshacer. El registro del solicitante y la asignación del espacio serán removidos permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="pt-4">
            <AlertDialogCancel className="font-bold border-border/60">No, conservar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteReservation}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-black shadow-lg shadow-destructive/20 active:scale-95 transition-all"
            >
              Sí, eliminar registro
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete facility confirm ── */}
      <AlertDialog open={!!deleteFacilityId} onOpenChange={() => setDeleteFacilityId(null)}>
        <AlertDialogContent className="bg-card text-card-foreground border-border/40">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black">¿Eliminar instalación?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground/80 font-medium">
              ¿Estás seguro de que deseas eliminar <span className="text-foreground font-bold">"{facilities.find(f => f.id === deleteFacilityId)?.name}"</span>? 
              Se perderá el registro del espacio, pero las reservas pasadas se mantendrán como histórico sin vinculación.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="pt-4">
            <AlertDialogCancel className="font-bold border-border/60">Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteFacility}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-black shadow-lg shadow-destructive/20"
            >
              Eliminar espacio
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Clase de prueba: agendar ── */}
      <TrialClassBookingModal
        open={trialBookingModalOpen}
        onOpenChange={setTrialBookingModalOpen}
        facilities={facilities}
      />

      {/* ── Clase de prueba: configuración ── */}
      <TrialClassSettingsModal
        open={trialSettingsModalOpen}
        onOpenChange={setTrialSettingsModalOpen}
      />

      {/* ── Clase de prueba: confirmar cancelación ── */}
      <AlertDialog open={!!cancelingTrialId} onOpenChange={() => setCancelingTrialId(null)}>
        <AlertDialogContent className="bg-card text-card-foreground border-border/40 overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-destructive" />
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-black">¿Cancelar clase de prueba?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground/80 font-medium">
              Se le avisará al prospecto por correo automáticamente, y se armará un mensaje de WhatsApp para que lo envíes tú.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="pt-4">
            <AlertDialogCancel className="font-bold border-border/60">No, conservar</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (cancelingTrialId) {
                  const notice = await updateTrialStatus({ id: cancelingTrialId, status: 'cancelada' });
                  if (notice?.whatsapp_message) setTrialNotice(notice);
                }
                setCancelingTrialId(null);
              }}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground font-black shadow-lg shadow-destructive/20 active:scale-95 transition-all"
            >
              Sí, cancelar clase
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Clase de prueba: reprogramar ── */}
      <TrialClassRescheduleModal
        booking={reschedulingTrial}
        onClose={() => setReschedulingTrial(null)}
        onRescheduled={setTrialNotice}
      />

      {/* ── Clase de prueba: aviso tras cancelar/reprogramar ── */}
      <Dialog open={!!trialNotice} onOpenChange={(v) => { if (!v) setTrialNotice(null); }}>
        <DialogContent className="sm:max-w-md bg-card text-card-foreground border-border/40 backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              <Mail className="h-5 w-5 text-primary" />
              {trialNotice?.email_sent ? 'Correo enviado' : 'No se pudo enviar el correo'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted/20 border border-border/40 rounded-lg p-4 text-sm italic text-muted-foreground">
              "{trialNotice?.whatsapp_message}"
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 h-11 font-medium border-border/50"
                onClick={() => {
                  if (trialNotice?.whatsapp_message) navigator.clipboard.writeText(trialNotice.whatsapp_message);
                }}
              >
                <Copy className="h-4 w-4 mr-2" /> Copiar mensaje
              </Button>
              {trialNotice?.whatsapp_link && (
                <Button
                  className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                  onClick={() => window.open(trialNotice.whatsapp_link, '_blank')}
                >
                  <MessageCircle className="h-4 w-4 mr-2" /> Abrir WhatsApp
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Facility availability modal ── */}
      {availabilityFacility && (
        <FacilityAvailabilityModal
          open={!!availabilityFacility}
          onOpenChange={(open) => {
            if (!open) setAvailabilityFacility(null);
          }}
          facilityId={availabilityFacility.id}
          facilityName={availabilityFacility.name}
          facilityCapacity={availabilityFacility.capacity}
          schoolId={schoolId!}
        />
      )}
    </div>
  );
}

// Add Loader2 to imports if not present
import { Loader2 } from 'lucide-react';
