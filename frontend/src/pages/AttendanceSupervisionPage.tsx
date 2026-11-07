import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { Calendar } from '@/components/ui/calendar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  CheckCircle2, XCircle, Clock, AlertCircle, Users, Lock,
  Flag, Search, UserX, CalendarCheck, Layers, Dumbbell,
  CreditCard, AlertTriangle, ChevronRight, Trophy, Zap, Target, Star,
  Calendar as CalendarIcon, TrendingUp, Building2, Plus,
} from 'lucide-react';
import { getSportVisual } from '@/lib/sportVisuals';
import { cn } from '@/lib/utils';

// ── Tipos ──────────────────────────────────────────────────────────────────────
type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

interface TeamCard    { id: string; name: string; sport: string; current_students: number }
interface OfferingCard { id: string; name: string; offering_type: string; current_students: number }

interface PlanInfo {
  name: string;
  start_date: string | null;
  expires_at: string | null;
  days_left: number | null;
  is_expired: boolean;
  sessions_used: number;
  max_sessions: number | null;
  sessions_remaining: number | null;
  secondary_sessions_used: number;
  max_secondary_sessions: number | null;
  secondary_remaining: number | null;
  payment_status: string | null;
  payment_due_date: string | null;
  price: number | null;
  currency: string | null;
}

interface RosterItem {
  id: string;
  full_name: string;
  avatar_url?: string | null;
  athlete_type: 'child' | 'adult' | 'unregistered';
  enrollment_id: string | null;
  plan: PlanInfo | null;
  /** Reserva de hoy: si existe, pasar lista NO descuenta otra clase. */
  booking_today?: { start_time: string | null; status: string } | null;
  /** La familia avisó por WhatsApp que no viene (athlete_absence_notices). */
  aviso_ausencia?: { motivo: string | null; nota: string | null; fuente: string } | null;
  payment: { status: string; due_date: string | null } | null;
}

const MOTIVO_AUSENCIA: Record<string, string> = {
  enfermedad: 'enfermo/a', cita_medica: 'cita médica', viaje: 'de viaje', lesion: 'lesión',
  colegio: 'colegio', familiar: 'asunto familiar',
};

type CreditOutcome =
  | 'deducted' | 'covered_by_booking' | 'returned' | 'booking_released'
  | 'no_plan' | 'no_credits' | 'expired' | 'unchanged';

/** El entrenador/admin tiene que entender por qué se descontó o por qué no. */
function describeOutcomes(outcomes: { outcome: CreditOutcome | undefined; name: string }[]): string | undefined {
  let deducted = 0, returned = 0, noPlan = 0;
  const covered: string[] = [], noCredits: string[] = [];

  for (const { outcome, name } of outcomes) {
    if (outcome === 'deducted') deducted++;
    else if (outcome === 'returned' || outcome === 'booking_released') returned++;
    else if (outcome === 'covered_by_booking') covered.push(name);
    else if (outcome === 'no_plan') noPlan++;
    else if (outcome === 'no_credits' || outcome === 'expired') noCredits.push(name);
  }

  const parts: string[] = [];
  if (deducted) parts.push(`se descontó 1 clase a ${deducted} atleta${deducted > 1 ? 's' : ''}`);
  if (covered.length) parts.push(`${covered.join(', ')} ya tenía reserva para hoy: no se le descontó`);
  if (returned) parts.push(`${returned} clase${returned > 1 ? 's' : ''} devuelta${returned > 1 ? 's' : ''}`);
  if (noCredits.length) parts.push(`${noCredits.join(', ')} sin clases disponibles en el plan`);
  if (noPlan) parts.push(`${noPlan} sin plan de clases`);
  return parts.length ? parts.join(' · ') : undefined;
}

function formatHour(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(':');
  const hour = Number(h);
  const suffix = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m ?? '00'} ${suffix}`;
}

interface BookingRow {
  id: string;
  session_id: string;
  start_time: string;
  end_time: string;
  context_name: string;
  person_name: string;
  child_id: string | null;
  user_id: string | null;
  enrollment_id: string | null;
  booking_type: string;
  attendance?: AttendanceStatus | null;
}

interface ModalContext { type: 'team' | 'offering' | 'facility' | 'facility_session'; id: string; name: string; sessionId?: string }

// ── Helpers ────────────────────────────────────────────────────────────────────
const fmt = (d: Date) => d.toISOString().split('T')[0];

async function getBearerToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('No autenticado');
  return token;
}
const BFF_URL = import.meta.env.VITE_BFF_URL ?? '';

const STATUS_CFG: Record<AttendanceStatus, { label: string; icon: React.ReactNode; active: string; inactive: string }> = {
  present: { label: 'Presente', icon: <CheckCircle2 className="w-3.5 h-3.5" />, active: 'bg-green-500 border-green-500 text-white', inactive: 'border-border text-muted-foreground hover:border-green-400 hover:text-green-500' },
  absent: { label: 'Ausente', icon: <XCircle className="w-3.5 h-3.5" />, active: 'bg-red-500 border-red-500 text-white', inactive: 'border-border text-muted-foreground hover:border-red-400 hover:text-red-500' },
  late: { label: 'Tarde', icon: <Clock className="w-3.5 h-3.5" />, active: 'bg-yellow-500 border-yellow-500 text-white', inactive: 'border-border text-muted-foreground hover:border-yellow-400 hover:text-yellow-500' },
  excused: { label: 'Excusado', icon: <AlertCircle className="w-3.5 h-3.5" />, active: 'bg-blue-500 border-blue-500 text-white', inactive: 'border-border text-muted-foreground hover:border-blue-400 hover:text-blue-500' },
};

function getPlanVisual(name: string = '') {
  const n = name.toLowerCase();
  if (n.includes('elite') || n.includes('premium') || n.includes('oro') || n.includes('gold') || n.includes('black')) {
    return { gradient: 'from-zinc-900 via-zinc-800 to-black', accent: 'text-amber-400', tag: 'bg-amber-400/20 text-amber-400 border-amber-400/30', icon: Trophy, glow: 'shadow-amber-900/20' };
  }
  if (n.includes('combate') || n.includes('mma') || n.includes('box') || n.includes('warrior')) {
    return { gradient: 'from-rose-700 via-rose-800 to-red-950', accent: 'text-white', tag: 'bg-white/20 text-white border-white/20', icon: Target, glow: 'shadow-red-900/30' };
  }
  if (n.includes('gym') || n.includes('fitness') || n.includes('iron')) {
    return { gradient: 'from-orange-500 via-orange-600 to-amber-700', accent: 'text-white', tag: 'bg-white/20 text-white border-white/20', icon: Zap, glow: 'shadow-orange-900/20' };
  }
  if (n.includes('yoga') || n.includes('zen') || n.includes('balance') || n.includes('wellness')) {
    return { gradient: 'from-emerald-500 via-teal-600 to-cyan-700', accent: 'text-white', tag: 'bg-white/20 text-white border-white/20', icon: Star, glow: 'shadow-emerald-900/20' };
  }
  if (n.includes('basico') || n.includes('básico') || n.includes('estandar') || n.includes('base') || n.includes('inicial')) {
    return { gradient: 'from-slate-500 via-slate-600 to-slate-700', accent: 'text-white', tag: 'bg-white/20 text-white border-white/20', icon: Target, glow: 'shadow-slate-900/20' };
  }
  return { gradient: 'from-[#6366f1] via-[#8b5cf6] to-[#a855f7]', accent: 'text-white', tag: 'bg-white/20 text-white border-white/20', icon: Zap, glow: 'shadow-purple-900/30' };
}

// ── PlanInfoCard ───────────────────────────────────────────────────────────────
function PlanInfoCard({ plan }: { plan: PlanInfo }) {
  const payBadge = ({
    paid: { label: 'Al día', cls: 'bg-green-500/10 text-green-600 border-green-500/30' },
    pending: { label: 'Pendiente', cls: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30' },
    overdue: { label: 'Vencido', cls: 'bg-red-500/10 text-red-600 border-red-500/30' },
  } as any)[plan.payment_status ?? 'pending'] ?? { label: 'Sin info', cls: 'bg-muted text-muted-foreground border-border' };

  const expiryColor = plan.is_expired
    ? 'text-red-500'
    : plan.days_left !== null && plan.days_left <= 7
      ? 'text-yellow-500'
      : 'text-muted-foreground';

  return (
    <div className="mt-1.5 space-y-1">
      <div className="flex items-center gap-3 text-[11px] flex-wrap">
        {/* Nombre de tarifa + precio */}
        <span className="flex items-center gap-1 font-medium text-muted-foreground">
          {plan.name}
          {plan.price != null && (
            <span className="font-normal opacity-75">
              · {new Intl.NumberFormat('es-CO', {
                  style: 'currency', currency: plan.currency ?? 'COP',
                  maximumFractionDigits: 0,
                }).format(plan.price)}
            </span>
          )}
        </span>

        {/* Clases principales */}
        <span className="flex items-center gap-1 text-muted-foreground">
          <TrendingUp className="w-3 h-3" />
          {plan.max_sessions === null
            ? `${plan.sessions_used} usadas (ilimitadas)`
            : `${plan.sessions_used}/${plan.max_sessions} clases`
          }
        </span>

        {/* Secundarias — solo si aplica */}
        {plan.max_secondary_sessions != null && plan.max_secondary_sessions > 0 && (
          <span className="text-muted-foreground">
            · {plan.secondary_sessions_used}/{plan.max_secondary_sessions} secundarias
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
        {plan.start_date && (
          <span className="flex items-center gap-1">
            <CalendarIcon className="w-3 h-3" />
            Inicio: {new Date(plan.start_date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}
          </span>
        )}
        {plan.expires_at && (
          <span className={`flex items-center gap-1 font-medium ${expiryColor}`}>
            <CalendarIcon className="w-3 h-3" />
            {plan.is_expired
              ? 'Plan vencido'
              : plan.days_left !== null && plan.days_left <= 7
                ? `Vence en ${plan.days_left}d`
                : `Vence: ${new Date(plan.expires_at + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}`
            }
          </span>
        )}
      </div>

      <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${payBadge.cls}`}>
        <CreditCard className="w-2.5 h-2.5" />
        {payBadge.label}
        {plan.payment_due_date && plan.payment_status !== 'paid' && (
          <span className="opacity-75">
            · {new Date(plan.payment_due_date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}
          </span>
        )}
      </span>
    </div>
  );
}

// ── Componente principal ───────────────────────────────────────────────────────
export default function AttendanceSupervisionPage() {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [date, setDate] = useState<Date>(new Date());
  const [modalCtx, setModalCtx] = useState<ModalContext | null>(null);
  const [attendanceState, setAttendanceState] = useState<Record<string, AttendanceStatus>>({});
  const [bookingAttendance, setBookingAttendance] = useState<Record<string, AttendanceStatus>>({});
  const [search, setSearch]                   = useState('');
  const [isSecondary, setIsSecondary]         = useState(false);
  const [savingBooking, setSavingBooking]     = useState<string | null>(null);

  // States for facility walk-in search and guest creation
  const [globalSearch, setGlobalSearch] = useState('');
  const [guestDialogOpen, setGuestDialogOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestPhone, setGuestPhone] = useState('');
  const [guestDoc, setGuestDoc] = useState('');

  const [offeringPicker, setOfferingPicker] = useState<{ offering: OfferingCard; sessions: any[] } | null>(null);

  const handleOpenOffering = async (off: OfferingCard) => {
    const { data: sessions } = await supabase
      .from('attendance_sessions')
      .select('id, start_time, end_time, current_bookings, max_capacity')
      .eq('school_id', schoolId)
      .eq('offering_id', off.id)
      .eq('session_date', selectedDate)
      .eq('finalized', false)
      .order('start_time');

    if ((sessions?.length ?? 0) > 1) {
      setOfferingPicker({ offering: off, sessions: sessions! });
      return;
    }
    // 0 o 1 sesión: exactamente el comportamiento actual, sin fricción nueva
    openModal({ type: 'offering', id: off.id, name: off.name });
  };

  const selectedDate = fmt(date);

  // ── 1. Equipos ───────────────────────────────────────────────────────────
  const { data: teams = [], isLoading: loadingTeams } = useQuery<TeamCard[]>({
    queryKey: ['supervision-teams', schoolId],
    queryFn: async () => {
      if (!schoolId) return [];
      const { data, error } = await supabase
        .from('teams').select('id, name, sport, current_students')
        .eq('school_id', schoolId).eq('status', 'active').order('name');
      if (error) throw error;
      return (data || []) as TeamCard[];
    },
    enabled: !!schoolId,
  });

  // ── 2. Offerings ─────────────────────────────────────────────────────────
  const { data: offerings = [], isLoading: loadingOfferings } = useQuery<OfferingCard[]>({
    queryKey: ['supervision-offerings', schoolId],
    queryFn: async () => {
      if (!schoolId) return [];
      const { data, error } = await supabase
        .from('offerings').select('id, name, offering_type, current_students')
        .eq('school_id', schoolId).eq('is_active', true).order('name');
      if (error) throw error;
      return (data || []) as any as OfferingCard[];
    },
    enabled: !!schoolId,
  });

  // ── 3. Reservas del día ───────────────────────────────────────────────────
  const { data: bookings = [], isLoading: loadingBookings } = useQuery<BookingRow[]>({
    queryKey: ['supervision-bookings', schoolId, selectedDate],
    queryFn: async () => {
      if (!schoolId) return [];

      const { data: sessions } = await (supabase as any)
        .from('attendance_sessions')
        .select(`id, start_time, end_time, current_bookings,
          offerings!attendance_sessions_offering_id_fkey(name),
          teams!attendance_sessions_team_id_fkey(name),
          facilities!attendance_sessions_facility_id_fkey(name)`)
        .eq('school_id', schoolId).eq('session_date', selectedDate).gt('current_bookings', 0);

      const sessionIds = (sessions || []).map((s: any) => s.id);
      const { data: bks } = sessionIds.length
        ? await supabase.from('session_bookings')
            .select('id, session_id, user_id, child_id, booking_type, enrollment_id')
            .in('session_id', sessionIds).neq('status', 'cancelled')
        : { data: [] };

      const { data: facRes } = await supabase
        .from('facility_reservations')
        .select('id, facility_id, user_id, child_id, start_time, end_time, enrollment_id, status, facilities(name)')
        .eq('school_id', schoolId)
        .eq('reservation_date', selectedDate)
        .eq('status', 'confirmed');

      const allBks = bks || [];
      const allFacRes = facRes || [];

      if (!allBks.length && !allFacRes.length) return [];

      const uIds = [...new Set([
        ...allBks.map((b: any) => b.user_id),
        ...allFacRes.map((r: any) => r.user_id)
      ].filter(Boolean))] as string[];

      const cIds = [...new Set([
        ...allBks.map((b: any) => b.child_id),
        ...allFacRes.map((r: any) => r.child_id)
      ].filter(Boolean))] as string[];

      const [pRes, cRes] = await Promise.all([
        uIds.length ? supabase.from('profiles').select('id, full_name').in('id', uIds) : Promise.resolve({ data: [] }),
        cIds.length ? supabase.from('children').select('id, full_name').in('id', cIds) : Promise.resolve({ data: [] }),
      ]);
      const pMap = Object.fromEntries((pRes.data || []).map((p: any) => [p.id, p.full_name]));
      const cMap = Object.fromEntries((cRes.data || []).map((c: any) => [c.id, c.full_name]));

      const { data: existingRecords } = await supabase
        .from('attendance_records').select('child_id, user_id, session_id, status')
        .eq('attendance_date', selectedDate).eq('school_id', schoolId);
      const existingMap: Record<string, AttendanceStatus> = {};
      (existingRecords || []).forEach((r: any) => {
        const key = `${r.session_id ?? ''}_${r.child_id ?? r.user_id ?? ''}`;
        if (key !== '_') existingMap[key] = r.status;
      });

      const sMap = Object.fromEntries((sessions || []).map((s: any) => [s.id, {
        start_time: s.start_time?.slice(0, 5) ?? '',
        end_time:   s.end_time?.slice(0, 5)   ?? '',
        name:       (s.offerings as any)?.name ?? (s.teams as any)?.name ?? (s.facilities as any)?.name ?? 'Sesión',
      }]));

      const regularRows = allBks.map((b: any): BookingRow => {
        return {
          id: b.id, session_id: b.session_id,
          start_time: sMap[b.session_id]?.start_time ?? '',
          end_time:   sMap[b.session_id]?.end_time   ?? '',
          person_name:  b.user_id ? (pMap[b.user_id] ?? 'Atleta') : (cMap[b.child_id] ?? 'Deportista'),
          context_name: sMap[b.session_id]?.name ?? '',
          child_id: b.child_id ?? null, user_id: b.user_id ?? null,
          enrollment_id: b.enrollment_id ?? null,
          booking_type: b.booking_type,
          attendance: existingMap[`${b.session_id}_${b.child_id ?? b.user_id}`] ?? null,
        };
      });

      const facilityRows = allFacRes.map((r: any): BookingRow => {
        const matchingSession = (sessions || []).find((s: any) => s.facility_id === r.facility_id && s.start_time?.slice(0, 5) === r.start_time?.slice(0, 5));
        const attStatus = matchingSession ? (existingMap[`${matchingSession.id}_${r.child_id ?? r.user_id}`] ?? null) : null;

        return {
          id: r.id,
          session_id: matchingSession?.id ?? `new_${r.id}`,
          start_time: r.start_time?.slice(0, 5) ?? '',
          end_time: r.end_time?.slice(0, 5) ?? '',
          person_name: r.user_id ? (pMap[r.user_id] ?? 'Atleta') : (cMap[r.child_id] ?? 'Deportista'),
          context_name: r.facilities?.name ?? 'Instalación',
          child_id: r.child_id ?? null,
          user_id: r.user_id ?? null,
          enrollment_id: r.enrollment_id ?? null,
          booking_type: 'secondary_class',
          attendance: attStatus,
        };
      });

      const rows = [...regularRows, ...facilityRows];

      const preloaded: Record<string, AttendanceStatus> = {};
      rows.forEach((r) => { if (r.attendance) preloaded[r.id] = r.attendance; });
      setBookingAttendance(preloaded);
      return rows;
    },
    enabled: !!schoolId,
  });

  // ── 3b. Instalaciones de la escuela ───────────────────────────────────────
  const { data: supervisionFacilities = [], isLoading: loadingSupervisionFacilities } = useQuery<any[]>({
    queryKey: ['supervision-facilities', schoolId],
    queryFn: async () => {
      if (!schoolId) return [];
      const { data, error } = await (supabase as any)
        .from('facilities').select('id, name, type, capacity')
        .eq('school_id', schoolId).eq('status', 'available').order('name');
      if (error) throw error;
      return data || [];
    },
    enabled: !!schoolId,
  });

  // ── 3c. Bloques de disponibilidad de la instalación seleccionada ─────────
  const { data: facilityBlocks = [], isLoading: loadingBlocks } = useQuery<any[]>({
    queryKey: ['facility-blocks', modalCtx?.id, selectedDate],
    queryFn: async () => {
      if (!modalCtx || modalCtx.type !== 'facility') return [];
      const dbDay = date.getDay();
      const { data, error } = await (supabase as any)
        .from('facility_availability')
        .select('id, start_time, end_time, max_group_capacity')
        .eq('facility_id', modalCtx.id)
        .eq('day_of_week', dbDay)
        .order('start_time', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!modalCtx && modalCtx.type === 'facility',
  });

  // ── 3d. Sesiones ya creadas de la instalación seleccionada hoy ───────────
  const { data: facilitySessions = [] } = useQuery<any[]>({
    queryKey: ['facility-sessions', modalCtx?.id, selectedDate],
    queryFn: async () => {
      if (!modalCtx || modalCtx.type !== 'facility') return [];
      const { data, error } = await (supabase as any)
        .from('attendance_sessions')
        .select('id, facility_availability_id, finalized, finalized_at, current_bookings, max_capacity')
        .eq('facility_id', modalCtx.id)
        .eq('session_date', selectedDate);
      if (error) throw error;
      return data || [];
    },
    enabled: !!modalCtx && modalCtx.type === 'facility',
  });

  // ── 3f. Reservaciones de instalaciones de hoy (clases secundarias) ────────
  const { data: facilityReservations = [] } = useQuery<any[]>({
    queryKey: ['supervision-facility-reservations', schoolId, selectedDate],
    queryFn: async () => {
      if (!schoolId) return [];
      // M6: el coach ya no lee facility_reservations (datos de contacto/pagos). RPC con solo columnas no sensibles.
      const next = new Date(`${selectedDate}T12:00:00-05:00`);
      next.setUTCDate(next.getUTCDate() + 1);
      const nextDay = next.toISOString().slice(0, 10);
      const { data, error } = await (supabase as any).rpc('agenda_reservas_escuela', {
        p_school_id: schoolId,
        p_from: `${selectedDate}T00:00:00-05:00`,
        p_to: `${nextDay}T00:00:00-05:00`,
      });
      if (error) throw error;
      return ((data as any[]) || []).filter((r) => r.status === 'confirmed');
    },
    enabled: !!schoolId,
  });

  // ── 3e. Búsqueda global de estudiantes (Walk-in de instalaciones) ────────
  const { data: globalRoster = [], isLoading: loadingGlobalRoster } = useQuery<any[]>({
    queryKey: ['supervision-global-roster', globalSearch, schoolId],
    queryFn: async () => {
      if (globalSearch.trim().length < 2) return [];
      const token = await getBearerToken();
      const res = await fetch(
        `${BFF_URL}/api/v1/attendance/school-roster?search=${encodeURIComponent(globalSearch)}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' } }
      );
      if (!res.ok) throw new Error('Error buscando estudiantes');
      const data = await res.json();
      return data.athletes || [];
    },
    enabled: !!globalSearch.trim() && globalSearch.trim().length >= 2 && !!schoolId && modalCtx?.type === 'facility_session',
  });

  // ── 4. Roster del modal (BFF) ─────────────────────────────────────────────
  const { data: rosterData, isLoading: loadingRoster } = useQuery<{ athletes: RosterItem[] }>({
    queryKey: ['supervision-roster', modalCtx?.type, modalCtx?.id, schoolId, selectedDate],
    queryFn: async () => {
      if (!modalCtx) return { athletes: [] };
      const token = await getBearerToken();
      const res = await fetch(
        `${BFF_URL}/api/v1/attendance/roster/${modalCtx.type}/${modalCtx.id}?date=${selectedDate}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' } }
      );
      if (!res.ok) throw new Error('Error cargando roster');
      return res.json();
    },
    enabled: !!modalCtx && !!schoolId && modalCtx.type !== 'facility',
  });

  // ── 5. Sesión activa ──────────────────────────────────────────────────────
  const { data: sessionData } = useQuery<{ session: any; records: any[] }>({
    queryKey: ['supervision-session', modalCtx?.type, modalCtx?.id, selectedDate],
    queryFn: async () => {
      if (!modalCtx) return { session: null, records: [] };

      if (modalCtx.type === 'team') {
        const token = await getBearerToken();
        const res = await fetch(`${BFF_URL}/api/v1/attendance/session/${modalCtx.id}`,
          { headers: { Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' } });
        if (!res.ok) return { session: null, records: [] };
        const data = await res.json();
        if (data.records?.length) {
          const preloaded: Record<string, AttendanceStatus> = {};
          data.records.forEach((r: any) => {
            const id = r.child_id ?? r.user_id ?? r.unregistered_athlete_id;
            if (id) preloaded[id] = r.status;
          });
          setAttendanceState(preloaded);
        }
        return data;
      }

      // Para offerings — cargar registros de hoy por session_id
      if (modalCtx.type === 'offering') {
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
        
        // Buscar sesiones de hoy para este offering
        let sessQuery = supabase
          .from('attendance_sessions')
          .select('id')
          .eq('school_id', schoolId)
          .eq('session_date', today);
        sessQuery = modalCtx.sessionId
          ? sessQuery.eq('id', modalCtx.sessionId)
          : sessQuery.eq('offering_id', modalCtx.id);
        const { data: sessions } = await sessQuery;

        if (!sessions?.length) return { session: null, records: [] };

        const sessionIds = sessions.map((s: any) => s.id);

        // Registros de asistencia de esas sesiones
        const { data: records } = await (supabase as any)
          .from('attendance_records')
          .select('child_id, user_id, unregistered_athlete_id, session_id, status')
          .in('session_id', sessionIds);

        if (records?.length) {
          const preloaded: Record<string, AttendanceStatus> = {};
          records.forEach((r: any) => {
            const id = r.child_id ?? r.user_id ?? r.unregistered_athlete_id;
            if (id) preloaded[id] = r.status;
          });
          setAttendanceState(preloaded);
        }

        return { session: null, records: records || [] };
      }

      if (modalCtx.type === 'facility_session') {
        if (modalCtx.id.startsWith('new_')) {
          return { session: null, records: [] };
        }
        
        const [sessionRes, recordsRes] = await Promise.all([
          (supabase as any)
            .from('attendance_sessions')
            .select('id, session_date, finalized, finalized_at, created_by, created_at')
            .eq('id', modalCtx.id)
            .maybeSingle(),
          (supabase as any)
            .from('attendance_records')
            .select('child_id, user_id, unregistered_athlete_id, status')
            .eq('session_id', modalCtx.id)
        ]);

        if (sessionRes.error) throw sessionRes.error;
        if (recordsRes.error) throw recordsRes.error;

        const session = sessionRes.data;
        const records = recordsRes.data || [];

        if (records.length) {
          const preloaded: Record<string, AttendanceStatus> = {};
          records.forEach((r: any) => {
            const id = r.child_id ?? r.user_id ?? r.unregistered_athlete_id;
            if (id) preloaded[id] = r.status;
          });
          setAttendanceState(preloaded);
        }

        return { session, records };
      }

      return { session: null, records: [] };
    },
    enabled: !!modalCtx && modalCtx.type !== 'facility',
  });

  // ── Roster filtrado por búsqueda ──────────────────────────────────────────
  const filteredRoster = useMemo(() => {
    const all = rosterData?.athletes ?? [];
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter((a) => a.full_name.toLowerCase().includes(q));
  }, [rosterData, search]);

  const session = sessionData?.session ?? null;
  const isFinalized = session?.finalized === true;
  const markedCount = Object.keys(attendanceState).length;
  const totalCount = rosterData?.athletes.length ?? 0;

  // ── Guardar asistencia del modal ──────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!modalCtx) throw new Error('Sin contexto');
      const athletes = rosterData?.athletes ?? [];
      const token    = await getBearerToken();

      const presentEntries = Object.entries(attendanceState).filter(([, s]) => s === 'present');
      const otherEntries   = Object.entries(attendanceState).filter(([, s]) => s !== 'present');
      const walkInErrors: string[] = [];
      const outcomes: { outcome: CreditOutcome | undefined; name: string }[] = [];

      // Presentes → walk-in con descuento
      for (const [id] of presentEntries) {
        const a = athletes.find((x) => x.id === id);
        if (!a || !a.enrollment_id) continue;
        const payload: any = { enrollmentId: a.enrollment_id, is_secondary: isSecondary, status: 'present' };
        if (modalCtx.type === 'team')     payload.teamId     = modalCtx.id;
        if (modalCtx.type === 'offering') {
          if (modalCtx.sessionId) payload.sessionId = modalCtx.sessionId;
          else payload.offeringId = modalCtx.id;
        }
        if (modalCtx.type === 'facility_session') {
          if (modalCtx.id.startsWith('new_')) {
            payload.facilityAvailabilityId = modalCtx.id.replace('new_', '');
          } else {
            payload.sessionId = modalCtx.id;
          }
        }
        if (a.athlete_type === 'child')        payload.childId               = id;
        else if (a.athlete_type === 'adult')   payload.userId                = id;
        else                                    payload.unregisteredAthleteId = id;

        const res = await fetch(`${BFF_URL}/api/v1/attendance/walk-in`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) {
          // Falta de saldo y plan vencido ya NO fallan: la asistencia se registra
          // y el motivo llega en `credit_outcome`. Acá solo errores reales.
          const msgs: Record<string, string> = {
            not_found:  `${a.full_name}: sin inscripción activa`,
            no_session: `${a.full_name}: no hay sesión activa`,
          };
          walkInErrors.push(msgs[body.reason] || `${a.full_name}: ${body.error}`);
        } else {
          outcomes.push({ outcome: body.credit_outcome, name: a.full_name });
          // Si era una sesión nueva y se creó con éxito, actualizamos la url de la sesión en el modal
          if (body.sessionId && modalCtx.id.startsWith('new_')) {
            modalCtx.id = body.sessionId;
          }
        }
      }

      // Otros estados → registro sin descuento
      if (otherEntries.length > 0) {
        if (modalCtx.type === 'team') {
          // Equipo → POST /session directo
          const records = otherEntries.map(([id, status]) => {
            const a = athletes.find((x) => x.id === id);
            return {
              childId:               a?.athlete_type === 'child'        ? id : undefined,
              userId:                a?.athlete_type === 'adult'         ? id : undefined,
              unregisteredAthleteId: a?.athlete_type === 'unregistered' ? id : undefined,
              status,
            };
          });
          const res = await fetch(`${BFF_URL}/api/v1/attendance/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' },
            body: JSON.stringify({ teamId: modalCtx.id, records }),
          });
          const b = await res.json();
          if (!res.ok) throw new Error(b.error);
          // Esta ruta ahora también mueve créditos (devolución al corregir a ausente).
          for (const [id, outcome] of Object.entries(b.credit_outcomes ?? {})) {
            outcomes.push({
              outcome: outcome as CreditOutcome,
              name: athletes.find((x) => x.id === id)?.full_name ?? 'Atleta',
            });
          }

        } else {
          // Offering o Facility_session → walk-in por cada atleta (sin descuento porque status != present)
          for (const [id, status] of otherEntries) {
            const a = athletes.find((x) => x.id === id);
            if (!a?.enrollment_id) continue;
            const payload: any = {
              enrollmentId: a.enrollment_id,
              status,
              is_secondary: false,
            };
            if (modalCtx.type === 'facility_session') {
              if (modalCtx.id.startsWith('new_')) {
                payload.facilityAvailabilityId = modalCtx.id.replace('new_', '');
              } else {
                payload.sessionId = modalCtx.id;
              }
            } else {
              if (modalCtx.sessionId) payload.sessionId = modalCtx.sessionId;
              else payload.offeringId = modalCtx.id;
            }
            if (a.athlete_type === 'child')        payload.childId               = id;
            else if (a.athlete_type === 'adult')   payload.userId                = id;
            else                                    payload.unregisteredAthleteId = id;

            const res = await fetch(`${BFF_URL}/api/v1/attendance/walk-in`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' },
              body: JSON.stringify(payload),
            });
            const body = await res.json();
            if (!res.ok) {
              if (!['expired', 'no_credits', 'no_session'].includes(body.reason)) {
                throw new Error(body.error);
              }
            } else {
              outcomes.push({ outcome: body.credit_outcome, name: a.full_name });
              if (body.sessionId && modalCtx.id.startsWith('new_')) {
                modalCtx.id = body.sessionId;
              }
            }
          }
        }
      }

      if (walkInErrors.length) throw new Error(walkInErrors.join('\n'));
      return outcomes;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-roster'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-bookings', schoolId, selectedDate] });
      toast({ title: '✅ Asistencia guardada', description: describeOutcomes(result ?? []) });
    },
    onError: (e: any) => toast({ title: 'Algunos registros no se guardaron', description: e.message, variant: 'destructive' }),
  });

  // ── Finalizar sesión ──────────────────────────────────────────────────────
  const finalizeMutation = useMutation({
    mutationFn: async () => {
      if (!session?.id) throw new Error('Sin sesión activa');
      const token = await getBearerToken();
      const res = await fetch(`${BFF_URL}/api/v1/attendance/session/${session.id}/finalize`,
        { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      toast({ title: '🏁 Sesión finalizada' });
    },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  // ── Marcar asistencia de una reserva ─────────────────────────────────────
  const handleBookingAttendance = async (booking: BookingRow, status: AttendanceStatus) => {
    const current   = bookingAttendance[booking.id];
    const newStatus = current === status ? undefined : status;

    setBookingAttendance((prev) => {
      const next = { ...prev };
      if (newStatus) {
        next[booking.id] = newStatus;
      } else {
        delete next[booking.id];
      }
      return next;
    });
    if (!newStatus) return;

    setSavingBooking(booking.id);
    try {
      const token = await getBearerToken();
      const records = [{
        childId: booking.child_id ?? undefined,
        userId:  booking.user_id  ?? undefined,
        status:  newStatus,
      }];
      const res = await fetch(`${BFF_URL}/api/v1/attendance/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-school-id': schoolId ?? '' },
        body: JSON.stringify({ sessionId: booking.session_id, records }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Error al guardar');
      }
      queryClient.invalidateQueries({ queryKey: ['supervision-session'] });
      queryClient.invalidateQueries({ queryKey: ['supervision-roster'] });
    } catch {
      setBookingAttendance((prev) => { const n = { ...prev }; delete n[booking.id]; return n; });
      toast({ title: 'Error al marcar reserva', variant: 'destructive' });
    } finally {
      setSavingBooking(null);
    }
  };

  const openModal = (ctx: ModalContext) => {
    setModalCtx(ctx); setSearch(''); setIsSecondary(false); setAttendanceState({});
  };

  const closeModal = () => {
    setModalCtx(null);
    setSearch('');
    setGlobalSearch('');
    setAttendanceState({});
  };

  // Mutation to create guest athlete
  const createGuestMutation = useMutation({
    mutationFn: async () => {
      const token = await getBearerToken();
      const res = await fetch(`${BFF_URL}/api/v1/attendance/quick-guest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-school-id': schoolId ?? '',
        },
        body: JSON.stringify({
          fullName: guestName,
          phone: guestPhone,
          docNumber: guestDoc,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Error creando invitado');
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: '✅ Invitado creado', description: data.message });
      setGuestDialogOpen(false);
      setGuestName('');
      setGuestPhone('');
      setGuestDoc('');
      setGlobalSearch(data.athlete.full_name);
    },
    onError: (err: any) => {
      toast({ title: 'Error al crear invitado', description: err.message, variant: 'destructive' });
    },
  });

  const handleWalkIn = async (athlete: any) => {
    try {
      const token = await getBearerToken();
      const payload: any = {
        enrollmentId: athlete.enrollment_id,
        status: 'present',
        is_secondary: false,
      };
      if (modalCtx?.type === 'offering') {
        if (modalCtx.sessionId) payload.sessionId = modalCtx.sessionId;
        else payload.offeringId = modalCtx.id;
      } else if (modalCtx?.id.startsWith('new_')) {
        payload.facilityAvailabilityId = modalCtx.id.replace('new_', '');
      } else {
        payload.sessionId = modalCtx?.id;
      }
      if (athlete.athlete_type === 'child') payload.childId = athlete.id;
      else if (athlete.athlete_type === 'adult') payload.userId = athlete.id;
      else payload.unregisteredAthleteId = athlete.id;

      const res = await fetch(`${BFF_URL}/api/v1/attendance/walk-in`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-school-id': schoolId ?? '',
        },
        body: JSON.stringify(payload),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Error al registrar asistencia');
      }

      toast({ title: '✅ Estudiante agregado', description: 'Se registró su asistencia correctamente.' });
      setGlobalSearch('');
      
      // Si se creó la sesión, cambiamos el ID del modal a la sesión creada
      if (body.sessionId && modalCtx) {
        modalCtx.id = body.sessionId;
      }

      queryClient.invalidateQueries({ queryKey: ['supervision-roster', modalCtx?.type, modalCtx?.id, schoolId] });
      queryClient.invalidateQueries({ queryKey: ['supervision-session', modalCtx?.type, modalCtx?.id, selectedDate] });
      queryClient.invalidateQueries({ queryKey: ['supervision-bookings', schoolId, selectedDate] });
    } catch (err: any) {
      toast({ title: 'Error al agregar', description: err.message, variant: 'destructive' });
    }
  };

  const isBusy = saveMutation.isPending || finalizeMutation.isPending;
  const isLoading = loadingTeams || loadingOfferings;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Cabecera Premiun */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-border/50 pb-6 mb-2">
        <div>
          <h1 className="text-3xl font-black tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Asistencias</h1>
          <p className="text-muted-foreground text-sm font-medium flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-primary" />
            Gestión de equipos y planes en tiempo real
          </p>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 bg-muted/40 backdrop-blur-sm rounded-2xl border border-border/50 shadow-inner">
           <span className="text-xs font-black uppercase tracking-widest text-muted-foreground/60">Fecha:</span>
           <span className="text-sm font-bold text-primary capitalize">
             {date.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}
           </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-2">

        {/* ══ COLUMNA IZQUIERDA ══════════════════════════════════════════════ */}
        <div className="flex flex-col gap-6">

          {/* Calendario Premiun */}
          <Card className="overflow-hidden border-border/50 shadow-xl bg-card/40 backdrop-blur-md">
            <CardHeader className="pb-2 bg-muted/20 border-b border-border/40">
              <div className="flex items-center justify-between">
                <CardTitle className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/70">Calendario</CardTitle>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-6 px-2 text-[9px] font-black uppercase tracking-widest text-primary hover:bg-primary/10 transition-all"
                  onClick={() => setDate(new Date())}
                >
                  <Clock className="w-3 h-3 mr-1" />
                  Hoy
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-2">
              <Calendar
                mode="single"
                selected={date}
                onSelect={(d) => d && setDate(d)}
                className="rounded-none w-full flex justify-center py-2"
                classNames={{
                  months: "w-full space-y-4",
                  month: "w-full space-y-4",
                  table: "w-full border-collapse space-y-1",
                  head_row: "flex justify-between px-2",
                  row: "flex w-full mt-2 justify-between px-2",
                  day_selected: "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground shadow-lg shadow-primary/30 rounded-xl font-black transition-all",
                  day_today: "bg-primary/10 text-primary font-black border-2 border-primary/20",
                  day: cn(buttonVariants({ variant: "ghost" }), "h-11 w-11 sm:h-12 sm:w-12 p-0 font-bold hover:bg-primary/10 hover:text-primary transition-all rounded-xl text-sm"),
                  head_cell: "text-muted-foreground/60 rounded-md w-11 sm:w-12 font-black text-[11px] uppercase tracking-tighter text-center",
                  nav_button: cn(
                    buttonVariants({ variant: "outline" }),
                    "h-8 w-8 bg-muted/50 p-0 opacity-80 hover:opacity-100 hover:bg-primary/10 hover:border-primary/30 transition-all rounded-lg"
                  ),
                }}
              />
            </CardContent>
          </Card>

          {/* Widget reservas del día */}
          <Card className="flex-1 shadow-sm border-muted/40 overflow-hidden">
            <CardHeader className="pb-3 bg-muted/30 border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs font-black uppercase tracking-[0.15em] flex items-center gap-2 text-muted-foreground">
                  <CalendarCheck className="w-3.5 h-3.5 text-primary" />
                  Reservas del día
                </CardTitle>
                <Badge variant="secondary" className="bg-primary/10 text-primary border-none font-bold">
                  {bookings.length}
                </Badge>
              </div>
              <p className="text-[10px] uppercase font-bold text-muted-foreground/70 mt-1">
                {new Date(selectedDate + 'T12:00:00').toLocaleDateString('es-CO', {
                  weekday: 'long', day: 'numeric', month: 'long',
                })}
              </p>
            </CardHeader>
            <CardContent className="p-3">
              {loadingBookings ? (
                <div className="py-12"><LoadingSpinner text="Cargando..." /></div>
              ) : bookings.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground bg-muted/10 rounded-xl border border-dashed">
                  <CalendarCheck className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p className="text-xs font-medium">Sin reservas hoy</p>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-list overflow-y-auto pr-1 custom-scrollbar">
                  {bookings.map((b) => {
                    const current  = bookingAttendance[b.id];
                    const isSaving = savingBooking === b.id;
                    const initials = b.person_name.split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase();
                    
                    return (
                      <div key={b.id} className={`p-3 rounded-xl border transition-all duration-200 ${
                        current === 'present' ? 'border-green-500/30 bg-green-500/[0.03] shadow-inner'
                        : current === 'absent' ? 'border-red-500/20 bg-red-500/[0.02]'
                        : 'border-border bg-card hover:border-primary/30 hover:shadow-sm shadow-sm'
                      }`}>
                        <div className="flex items-start gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[10px] font-black shrink-0 border ${
                            current === 'present' ? 'bg-green-500 text-white border-green-400'
                            : current === 'absent' ? 'bg-red-500 text-white border-red-400'
                            : 'bg-primary/5 text-primary border-primary/10'
                          }`}>
                            {initials}
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                              <p className="font-bold text-sm truncate tracking-tight text-foreground">{b.person_name}</p>
                              <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-tighter text-muted-foreground/60">
                                {b.booking_type === 'drop_in' ? (
                                  <>
                                    <Star className="w-2.5 h-2.5 text-amber-500" />
                                    Drop-in
                                  </>
                                ) : (
                                  <>
                                    <CalendarIcon className="w-2.5 h-2.5 text-blue-500" />
                                    Reserva
                                  </>
                                )}
                              </span>
                            </div>
                            <p className="text-[11px] font-medium text-muted-foreground truncate opacity-80">
                              {b.context_name}{b.start_time && ` · ${b.start_time.substring(0, 5)}–${b.end_time.substring(0, 5)}`}
                            </p>
                          </div>
                        </div>

                        <div className="flex gap-1.5 mt-3 pt-3 border-t border-muted/40">
                          {(Object.keys(STATUS_CFG) as AttendanceStatus[]).map((s) => (
                            <button key={s} disabled={isSaving}
                              onClick={() => handleBookingAttendance(b, s)}
                              className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest border transition-all ${
                                current === s ? STATUS_CFG[s].active : STATUS_CFG[s].inactive
                              } ${isSaving ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {isSaving && current === s ? (
                                <div className="w-3 h-3 border-2 border-current border-t-transparent animate-spin rounded-full" />
                              ) : (
                                STATUS_CFG[s].icon
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ══ COLUMNA DERECHA ════════════════════════════════════════════════ */}
        <div className="lg:col-span-2 space-y-6">

          {isLoading ? (
            <LoadingSpinner text="Cargando equipos y planes..." />
          ) : (
            <>
              {/* Equipos */}
              {teams.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Dumbbell className="w-4 h-4 text-muted-foreground" />
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                      Equipos
                    </h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {teams.map((team) => {
                      const vis = getSportVisual(team.sport);
                      return (
                        <Card
                          key={team.id}
                          onClick={() => openModal({ type: 'team', id: team.id, name: team.name })}
                          className="group relative overflow-hidden border-none bg-gradient-to-br from-red-600 to-red-800 text-white shadow-lg transition-all hover:scale-[1.02] hover:shadow-red-900/40 cursor-pointer"
                        >
                          <CardContent className="p-5">
                            <div className="flex items-start gap-4">
                              <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center text-2xl border border-white/20 shrink-0">
                                {vis.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-80 mb-1">Equipo</p>
                                <h4 className="text-lg font-black leading-tight truncate uppercase tracking-tighter">{team.name}</h4>
                                <div className="flex items-center gap-2 mt-3 flex-wrap">
                                  <Badge variant="outline" className="border-white/30 text-white bg-white/10 text-[10px] font-bold py-0 px-2 h-5">
                                    <Trophy className="h-3 w-3 mr-1" />{team.sport || 'Deporte'}
                                  </Badge>
                                  <div className="flex items-center gap-1.5 px-2 py-0 h-5 bg-white/10 rounded-full border border-white/20 text-[10px] font-bold">
                                    <Users className="w-3 h-3" />
                                    {team.current_students}
                                  </div>
                                </div>
                              </div>
                              <ChevronRight className="h-5 w-5 opacity-40 self-center shrink-0" />
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Planes */}
              {offerings.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Layers className="w-4 h-4 text-muted-foreground" />
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                      Planes
                    </h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {offerings.map((off) => {
                      const visual = getPlanVisual(off.name);
                      const VisualIcon = visual.icon;
                      return (
                        <Card
                          key={off.id}
                          onClick={() => handleOpenOffering(off)}
                          className={`group relative overflow-hidden border-none bg-gradient-to-br ${visual.gradient} text-white shadow-lg transition-all hover:scale-[1.02] ${visual.glow} cursor-pointer`}
                        >
                          <CardContent className="p-5">
                            <div className="flex items-start gap-4">
                              <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center border border-white/20 shrink-0">
                                <VisualIcon className={`h-7 w-7 ${visual.accent}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-80 mb-1 truncate">Mis Planes</p>
                                <h4 className="text-lg font-black leading-tight truncate uppercase tracking-tighter">{off.name}</h4>
                                <div className="flex items-center gap-2 mt-3">
                                  <div className="flex items-center gap-1 px-2 py-0 h-5 bg-white/10 rounded-full border border-white/20 text-[10px] font-bold capitalize">
                                    <Zap className="h-3 w-3" />
                                    {off.offering_type?.replace(/_/g, ' ') ?? 'Plan'}
                                  </div>
                                  <div className="flex items-center gap-1.5 px-2 py-0 h-5 bg-white/10 rounded-full border border-white/20 text-[10px] font-bold">
                                    <Users className="w-3 h-3" />
                                    {off.current_students}
                                  </div>
                                </div>
                              </div>
                              <ChevronRight className="h-5 w-5 opacity-40 self-center shrink-0" />
                            </div>
                            <VisualIcon className="absolute -bottom-3 -right-3 h-20 w-20 opacity-10 rotate-12" />
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Instalaciones */}
              {supervisionFacilities.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3 mt-6">
                    <Building2 className="w-4 h-4 text-muted-foreground" />
                    <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                      Instalaciones (Alquiler / Uso Libre)
                    </h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {supervisionFacilities.map((fac) => {
                      return (
                        <Card
                          key={fac.id}
                          onClick={() => openModal({ type: 'facility', id: fac.id, name: fac.name })}
                          className="group relative overflow-hidden border-none bg-gradient-to-br from-cyan-600 via-teal-700 to-emerald-800 text-white shadow-lg transition-all hover:scale-[1.02] shadow-cyan-900/20 cursor-pointer animate-in fade-in-50 duration-200"
                        >
                          <CardContent className="p-5">
                            <div className="flex items-start gap-4">
                              <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center text-2xl border border-white/20 shrink-0">
                                <Building2 className="h-7 w-7 text-white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-80 mb-1">Instalación</p>
                                <h4 className="text-lg font-black leading-tight truncate uppercase tracking-tighter">{fac.name}</h4>
                                <div className="flex items-center gap-2 mt-3 flex-wrap">
                                  <Badge variant="outline" className="border-white/30 text-white bg-white/10 text-[10px] font-bold py-0 px-2 h-5">
                                    {fac.type || 'Sede'}
                                  </Badge>
                                  <div className="flex items-center gap-1.5 px-2 py-0 h-5 bg-white/10 rounded-full border border-white/20 text-[10px] font-bold">
                                    <Users className="w-3 h-3" />
                                    Capacidad: {fac.capacity}
                                  </div>
                                </div>
                              </div>
                              <ChevronRight className="h-5 w-5 opacity-40 self-center shrink-0" />
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              )}

              {teams.length === 0 && offerings.length === 0 && supervisionFacilities.length === 0 && (
                <div className="text-center py-16 text-muted-foreground">
                  <Layers className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p className="font-medium">Sin equipos, planes ni instalaciones configuradas</p>
                  <p className="text-sm mt-1">Crea un equipo, plan o instalación para comenzar</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ══ MODAL DE ASISTENCIA ════════════════════════════════════════════════ */}
      <Dialog open={!!modalCtx && (modalCtx.type === 'team' || modalCtx.type === 'offering' || modalCtx.type === 'facility_session')} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="max-w-2xl max-h-[90dvh] flex flex-col p-0 gap-0">

          {/* Header */}
          <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                {modalCtx?.type === 'team'
                  ? <Dumbbell className="w-4 h-4 text-primary" />
                  : <Layers className="w-4 h-4 text-primary" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <DialogTitle className="text-lg">{modalCtx?.name}</DialogTitle>
                <DialogDescription>
                  {new Date(selectedDate + 'T12:00:00').toLocaleDateString('es-CO', {
                    weekday: 'long', day: 'numeric', month: 'long',
                  })}
                  {isFinalized && (
                    <Badge className="bg-green-500 ml-2 text-[10px] gap-1 h-4">
                      <Lock className="w-3 h-3" /> Finalizada
                    </Badge>
                  )}
                </DialogDescription>
              </div>
            </div>

            <div className="flex items-center gap-3 mt-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar deportista por nombre..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              {!isFinalized && modalCtx?.type === 'offering' && (
                <div className="flex items-center gap-2 shrink-0">
                  <Switch id="secondary-toggle" checked={isSecondary} onCheckedChange={setIsSecondary} />
                  <Label htmlFor="secondary-toggle" className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap">
                    Clase secundaria
                  </Label>
                </div>
              )}
            </div>

            {totalCount > 0 && (
              <div className="flex items-center gap-3 mt-2">
                <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${(markedCount / totalCount) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {markedCount} / {totalCount}
                </span>
              </div>
            )}

            {!isFinalized && modalCtx?.type === 'facility_session' && (
              <div className="space-y-2 mt-3 pt-3 border-t relative">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/80 flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5 text-primary" />
                    Registrar Walk-in (deportista de la escuela)
                  </Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1.5 text-[9px] font-black uppercase tracking-widest text-primary hover:bg-primary/10"
                    onClick={() => setGuestDialogOpen(true)}
                  >
                    Crear Invitado Rápido
                  </Button>
                </div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Escribe nombre para buscar en toda la escuela..."
                    value={globalSearch}
                    onChange={(e) => setGlobalSearch(e.target.value)}
                    className="pl-9 h-9 text-xs"
                  />
                </div>

                {globalSearch.trim().length >= 2 && (
                  <Card className="absolute left-0 right-0 z-50 border border-border/80 shadow-2xl max-h-60 overflow-y-auto mt-1 p-1 bg-card/95 backdrop-blur-md">
                    {loadingGlobalRoster ? (
                      <div className="p-3 text-center text-xs text-muted-foreground">Buscando...</div>
                    ) : globalRoster.length === 0 ? (
                      <div className="p-3 text-center text-xs text-muted-foreground">Sin resultados</div>
                    ) : (
                      globalRoster.map((athlete) => (
                        <div
                          key={athlete.id}
                          onClick={() => handleWalkIn(athlete)}
                          className="flex items-center justify-between p-2 hover:bg-primary/10 rounded-lg cursor-pointer transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
                              {athlete.full_name.charAt(0).toUpperCase()}
                            </div>
                            <div className="text-left">
                              <p className="text-xs font-bold">{athlete.full_name}</p>
                              <p className="text-[9px] text-muted-foreground">{athlete.plan?.name || 'Sin plan'}</p>
                            </div>
                          </div>
                          <Badge variant="outline" className="text-[9px] capitalize">{athlete.athlete_type}</Badge>
                        </div>
                      ))
                    )}
                  </Card>
                )}
              </div>
            )}
          </DialogHeader>

          {/* Roster */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
            {loadingRoster ? (
              <LoadingSpinner text="Cargando deportistas..." />
            ) : filteredRoster.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">
                  {search 
                    ? 'Sin resultados para esa búsqueda' 
                    : modalCtx?.type === 'facility_session'
                      ? 'No hay reservas en este bloque hoy. Agrega estudiantes usando el buscador global.'
                      : 'No hay deportistas en este grupo'
                  }
                </p>
              </div>
            ) : (
              filteredRoster.map((athlete) => {
                const current = attendanceState[athlete.id];
                const rowBg =
                  current === 'present' ? 'border-green-500/40 bg-green-500/5'
                  : current === 'absent' ? 'border-red-500/30 bg-red-500/5'
                  : current === 'late' ? 'border-yellow-500/40 bg-yellow-500/5'
                  : current === 'excused' ? 'border-blue-500/30 bg-blue-500/5'
                  : 'border-border bg-card';
                return (
                  <div key={athlete.id} className={`p-3 rounded-xl border transition-colors ${rowBg}`}>
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 overflow-hidden">
                        {athlete.avatar_url
                          ? <img src={athlete.avatar_url} alt={athlete.full_name} className="w-full h-full object-cover" />
                          : athlete.full_name.charAt(0).toUpperCase()
                        }
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium text-sm truncate">{athlete.full_name}</span>
                          {athlete.athlete_type === 'unregistered' && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1 gap-0.5">
                              <UserX className="w-2.5 h-2.5" /> Sin cuenta
                            </Badge>
                          )}
                          {athlete.plan?.is_expired && (
                            <Badge variant="destructive" className="text-[10px] h-4 px-1 gap-0.5">
                              <AlertTriangle className="w-2.5 h-2.5" /> Vencido
                            </Badge>
                          )}
                          {!athlete.plan?.is_expired && athlete.plan?.days_left !== null && (athlete.plan?.days_left ?? 99) <= 7 && (
                            <Badge className="bg-yellow-500/15 text-yellow-600 border border-yellow-500/30 text-[10px] h-4 px-1">
                              Vence pronto
                            </Badge>
                          )}
                        </div>
                        {athlete.plan ? (
                          <PlanInfoCard plan={athlete.plan as any} />
                        ) : athlete.payment ? (
                          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border mt-1.5 ${
                            athlete.payment.status === 'paid'
                              ? 'bg-green-500/10 text-green-600 border-green-500/30'
                              : athlete.payment.status === 'overdue'
                                ? 'bg-red-500/10 text-red-600 border-red-500/30'
                                : 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30'
                          }`}>
                            <CreditCard className="w-2.5 h-2.5" />
                            {athlete.payment.status === 'paid' ? 'Al día'
                              : athlete.payment.status === 'overdue' ? 'Vencido'
                              : 'Pago pendiente'}
                            {athlete.payment.due_date && athlete.payment.status !== 'paid' && (
                              <span className="opacity-75">
                                · {new Date(athlete.payment.due_date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}
                              </span>
                            )}
                          </span>
                        ) : (
                          <p className="text-[11px] text-muted-foreground mt-0.5">No maneja plan de clases</p>
                        )}
                        {athlete.booking_today && (
                          <p className="text-[11px] mt-1 flex items-center gap-1 text-blue-600 font-medium">
                            <Clock className="w-3 h-3 shrink-0" />
                            {athlete.booking_today.status === 'attended'
                              ? `Reserva de hoy ya usada${formatHour(athlete.booking_today.start_time) ? ` (${formatHour(athlete.booking_today.start_time)})` : ''}`
                              : `Ya reservó hoy${formatHour(athlete.booking_today.start_time) ? ` (${formatHour(athlete.booking_today.start_time)})` : ''} — no se descuenta otra clase`}
                          </p>
                        )}
                        {athlete.aviso_ausencia && (
                          <p className="text-[11px] mt-1 text-amber-600 dark:text-amber-400 font-medium" title={athlete.aviso_ausencia.nota ?? undefined}>
                            La familia avisó que no viene{MOTIVO_AUSENCIA[athlete.aviso_ausencia.motivo ?? ''] ? ` (${MOTIVO_AUSENCIA[athlete.aviso_ausencia.motivo ?? '']})` : ''}
                          </p>
                        )}
                      </div>

                      {!isFinalized ? (
                        <div className="flex gap-1 shrink-0 mt-0.5">
                          {(Object.keys(STATUS_CFG) as AttendanceStatus[]).map((s) => (
                            <button
                              key={s}
                              title={STATUS_CFG[s].label}
                              onClick={() => setAttendanceState((prev) =>
                                prev[athlete.id] === s
                                  ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== athlete.id))
                                  : { ...prev, [athlete.id]: s }
                              )}
                              className={`w-7 h-7 rounded-lg flex items-center justify-center border transition-all ${current === s ? STATUS_CFG[s].active : STATUS_CFG[s].inactive}`}
                            >
                              {STATUS_CFG[s].icon}
                            </button>
                          ))}
                        </div>
                      ) : (
                        current ? (
                          <div className={`flex items-center gap-1 text-xs font-medium shrink-0 ${current === 'present' ? 'text-green-500' : current === 'absent' ? 'text-red-500' : current === 'late' ? 'text-yellow-500' : 'text-blue-500'}`}>
                            {STATUS_CFG[current].icon}
                            {STATUS_CFG[current].label}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground shrink-0">Sin marcar</span>
                        )
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer con acciones */}
          {!isFinalized ? (
            <DialogFooter className="px-6 py-4 border-t gap-2 shrink-0 flex-row justify-between">
              <Button variant="outline" onClick={() => setModalCtx(null)} disabled={isBusy}>Cerrar</Button>
              <div className="flex gap-2">
                <Button onClick={() => saveMutation.mutate()} disabled={markedCount === 0 || isBusy}>
                  {saveMutation.isPending ? 'Guardando...' : `Guardar (${markedCount}/${totalCount})`}
                </Button>
                {session && (
                  <Button variant="destructive" className="gap-1.5"
                    onClick={() => finalizeMutation.mutate()} disabled={isBusy}>
                    <Flag className="w-3.5 h-3.5" />
                    {finalizeMutation.isPending ? 'Finalizando...' : 'Finalizar'}
                  </Button>
                )}
              </div>
            </DialogFooter>
          ) : (
            <div className="px-6 py-4 border-t flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-green-600 text-sm">
                <Lock className="w-4 h-4" />
                <span>Sesión finalizada · Solo lectura</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => setModalCtx(null)}>Cerrar</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── MODAL DE SELECCIÓN DE BLOQUE DE INSTALACIÓN ────────────────────── */}
      <Dialog open={!!modalCtx && modalCtx.type === 'facility'} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent className="max-w-md bg-card text-card-foreground border-border/40 backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <Building2 className="h-5 w-5 text-primary" />
              Bloques de {modalCtx?.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Selecciona un bloque para gestionar la asistencia del {date.toLocaleDateString('es-CO', { day: 'numeric', month: 'long' })}.
            </DialogDescription>
          </DialogHeader>

          {loadingBlocks ? (
            <div className="py-8"><LoadingSpinner text="Cargando bloques..." /></div>
          ) : facilityBlocks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground bg-muted/10 rounded-xl border border-dashed border-border/50">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-20" />
              <p className="text-sm font-bold">Sin disponibilidad configurada</p>
              <p className="text-xs">No hay bloques de horario para este día de la semana.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-list overflow-y-auto pr-1">
              {facilityBlocks.map((block) => {
                const session = facilitySessions.find(s => s.facility_availability_id === block.id);
                const blockTimes = `${block.start_time.substring(0, 5)} - ${block.end_time.substring(0, 5)}`;
                
                const blockStart = block.start_time.substring(0, 5);
                const resCount = facilityReservations.filter(
                  (r: any) => r.facility_id === block.facility_id && r.start_time.substring(0, 5) === blockStart
                ).length;

                const totalBookings = (session?.current_bookings ?? 0) + (session ? 0 : resCount);
                const hasBookings = (session && session.current_bookings > 0) || resCount > 0;

                return (
                  <div
                    key={block.id}
                    onClick={() => {
                      if (session) {
                        openModal({
                          type: 'facility_session',
                          id: session.id,
                          name: `${modalCtx?.name} (${blockTimes})`,
                        });
                      } else {
                        openModal({
                          type: 'facility_session',
                          id: `new_${block.id}`,
                          name: `${modalCtx?.name} (${blockTimes})`,
                        });
                      }
                    }}
                    className={`p-4 rounded-xl border transition-all duration-200 cursor-pointer flex items-center justify-between hover:scale-[1.01] ${
                      session?.finalized
                        ? 'border-green-500/20 bg-green-500/[0.02] hover:bg-green-500/[0.04]'
                        : (session || hasBookings)
                          ? 'border-yellow-500/30 bg-yellow-500/[0.02] hover:bg-yellow-500/[0.04]'
                          : 'border-border bg-card hover:border-primary/40 hover:shadow-sm'
                    }`}
                  >
                    <div className="space-y-1">
                      <p className="font-bold text-sm flex items-center gap-2 text-foreground">
                        <Clock className="h-4 w-4 text-primary" />
                        {blockTimes}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {(session || hasBookings)
                          ? `${totalBookings} / ${session?.max_capacity || block.max_group_capacity || 10} personas`
                          : `Aforo máx: ${block.max_group_capacity || 10} personas`
                        }
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {session?.finalized ? (
                        <Badge className="bg-green-500 text-[10px]">Finalizada</Badge>
                      ) : (session || hasBookings) ? (
                        <Badge className="bg-yellow-500 text-[10px]">Abierta</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] text-muted-foreground bg-muted">Sin iniciar</Badge>
                      )}
                      <ChevronRight className="h-4 w-4 opacity-40" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" className="w-full h-11 font-bold border-border/50" onClick={closeModal}>
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DIALOG CREAR INVITADO RÁPIDO ─────────────────────────────────────── */}
      <Dialog open={guestDialogOpen} onOpenChange={setGuestDialogOpen}>
        <DialogContent className="max-w-sm bg-card text-card-foreground border-border/40 backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">Crear Invitado Rápido</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Registra una persona externa a la escuela para poder marcarle asistencia.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="guestName" className="text-xs">Nombre Completo *</Label>
              <Input
                id="guestName"
                placeholder="Ej: Juan Pérez"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guestPhone" className="text-xs">Teléfono (opcional)</Label>
              <Input
                id="guestPhone"
                placeholder="Ej: +57 300 1234567"
                value={guestPhone}
                onChange={(e) => setGuestPhone(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guestDoc" className="text-xs">Documento (opcional)</Label>
              <Input
                id="guestDoc"
                placeholder="CC, TI, etc."
                value={guestDoc}
                onChange={(e) => setGuestDoc(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setGuestDialogOpen(false)}>Cancelar</Button>
            <Button
              onClick={() => createGuestMutation.mutate()}
              disabled={!guestName.trim() || createGuestMutation.isPending}
            >
              {createGuestMutation.isPending ? 'Creando...' : 'Crear'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!offeringPicker} onOpenChange={(open) => !open && setOfferingPicker(null)}>
        <DialogContent className="max-w-md bg-card text-card-foreground border-border/40 backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <Clock className="h-5 w-5 text-primary" />
              Horarios de {offeringPicker?.offering.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Este plan tiene varios bloques hoy. Elige uno para marcar asistencia.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-[50dvh] overflow-y-auto pr-1">
            {offeringPicker?.sessions.map((s) => (
              <div key={s.id}
                onClick={() => {
                  openModal({
                    type: 'offering', id: offeringPicker.offering.id,
                    name: `${offeringPicker.offering.name} (${s.start_time.slice(0,5)})`,
                    sessionId: s.id,
                  });
                  setOfferingPicker(null);
                }}
                className="p-4 rounded-xl border border-border bg-card hover:border-primary/40 hover:shadow-sm cursor-pointer flex items-center justify-between transition-all duration-200 hover:scale-[1.01]">
                <span className="font-bold text-sm text-foreground">{s.start_time.slice(0,5)} - {s.end_time.slice(0,5)}</span>
                <span className="text-xs text-muted-foreground">{s.current_bookings} / {s.max_capacity ?? '—'} personas</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" className="w-full h-11 font-bold border-border/50" onClick={() => setOfferingPicker(null)}>
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}