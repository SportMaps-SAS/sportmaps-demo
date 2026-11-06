import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { usePermissions } from '@/hooks/usePermissions';
import { PermissionGate } from '@/components/PermissionGate';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { LocationAutocomplete } from '@/components/events/LocationAutocomplete';
import ParentCalendarV2 from '@/components/parent/v2/ParentCalendarV2';
import { usesParentCalendarV2 } from '@/components/parent/v2/parentCalendarModel';
import { ACUDIENTE_V2 } from '@/lib/feature-flags';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, getDay, isSameDay, isToday, addMonths, subMonths } from 'date-fns';
import { es } from 'date-fns/locale';
import { useEntitlements } from '@/hooks/useEntitlements';
import { FormatoVivoCampos } from '@/components/partidos/FormatoVivoCampos';
import { FORMATO_VIVO_DEFECTO, payloadFormatoVivo, validarFormatoVivo, type FormatoVivoForm } from '@/components/partidos/partidoVivoAgenda';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  MapPin,
  Plus,
  ArrowRight,
  Loader2,
  Megaphone,
  Star,
  Dumbbell,
  Users,
  MessageCircle,
  Trophy,
  Swords,
  GraduationCap,
  Waves,
  CircleDot,
  Sparkles,
  ClipboardList,
  Target,
  Pencil,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────
interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  event_type: string;
  start_time: string;
  end_time: string;
  location?: string;
  all_day: boolean;
  user_id: string;
  sport?: string;
  event_label?: string;
  team_id?: string | null;
  school_id?: string | null;
  team_name?: string | null;
  creator_name?: string;
  /** Partido (match_results) ligado a este evento, si lo hay (create_match). */
  match_id?: string | null;
}

// ─── Sport icon mapping ───────────────────────────────────────────────────
const SPORT_ICONS: Record<string, React.ElementType> = {
  'Porrismo': Megaphone,
  'Fútbol': CircleDot,
  'Fútbol Sala': CircleDot,
  'Baloncesto': Target,
  'Natación': Waves,
  'Tenis': Swords,
  'Gimnasia': Sparkles,
  'Atletismo': Dumbbell,
  'Voleibol': CircleDot,
  'Artes Marciales': Swords,
};

// Colores de badges/íconos conscientes del tema. Antes eran solo `text-*-300`
// sobre `bg-*-500/20`: pensados para modo oscuro, en modo claro quedaban
// verde claro sobre verde claro (reporte Athletic League 2026-09-25).
const SPORT_COLORS: Record<string, { bg: string; text: string; icon: string; border: string }> = {
  'Porrismo': { bg: 'bg-fuchsia-50 dark:bg-fuchsia-500/15', text: 'text-fuchsia-700 dark:text-fuchsia-400', icon: 'text-fuchsia-700 dark:text-fuchsia-400', border: 'border-fuchsia-200 dark:border-fuchsia-500/30' },
  'Fútbol': { bg: 'bg-emerald-50 dark:bg-emerald-500/15', text: 'text-emerald-700 dark:text-emerald-400', icon: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-200 dark:border-emerald-500/30' },
  'Fútbol Sala': { bg: 'bg-teal-50 dark:bg-teal-500/15', text: 'text-teal-700 dark:text-teal-400', icon: 'text-teal-700 dark:text-teal-400', border: 'border-teal-200 dark:border-teal-500/30' },
  'Baloncesto': { bg: 'bg-orange-50 dark:bg-orange-500/15', text: 'text-orange-700 dark:text-orange-400', icon: 'text-orange-700 dark:text-orange-400', border: 'border-orange-200 dark:border-orange-500/30' },
  'Natación': { bg: 'bg-cyan-50 dark:bg-cyan-500/15', text: 'text-cyan-700 dark:text-cyan-400', icon: 'text-cyan-700 dark:text-cyan-400', border: 'border-cyan-200 dark:border-cyan-500/30' },
  'Tenis': { bg: 'bg-lime-50 dark:bg-lime-500/15', text: 'text-lime-700 dark:text-lime-400', icon: 'text-lime-700 dark:text-lime-400', border: 'border-lime-200 dark:border-lime-500/30' },
  'Gimnasia': { bg: 'bg-pink-50 dark:bg-pink-500/15', text: 'text-pink-800 dark:text-pink-300', icon: 'text-pink-800 dark:text-pink-300', border: 'border-pink-200 dark:border-pink-500/30' },
  'Atletismo': { bg: 'bg-amber-50 dark:bg-amber-500/15', text: 'text-amber-700 dark:text-amber-400', icon: 'text-amber-700 dark:text-amber-400', border: 'border-amber-200 dark:border-amber-500/30' },
  'Voleibol': { bg: 'bg-yellow-50 dark:bg-yellow-500/15', text: 'text-yellow-700 dark:text-yellow-400', icon: 'text-yellow-700 dark:text-yellow-400', border: 'border-yellow-200 dark:border-yellow-500/30' },
  'Artes Marciales': { bg: 'bg-red-50 dark:bg-red-500/15', text: 'text-red-700 dark:text-red-400', icon: 'text-red-700 dark:text-red-400', border: 'border-red-200 dark:border-red-500/30' },
};

const DEFAULT_SPORT_COLOR = { bg: 'bg-primary/15', text: 'text-primary', icon: 'text-primary', border: 'border-primary/30' };

// ─── Sport-specific event type labels ─────────────────────────────────────
const BASE_EVENT_TYPES: Record<string, { label: string; color: string }> = {
  training: { label: 'Entrenamiento', color: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-300 border-blue-200 dark:border-blue-500/30' },
  match: { label: 'Partido', color: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-500/30' },
  meeting: { label: 'Reunión', color: 'bg-purple-100 dark:bg-purple-500/20 text-purple-800 dark:text-purple-300 border-purple-200 dark:border-purple-500/30' },
  evaluation: { label: 'Evaluación', color: 'bg-teal-100 dark:bg-teal-500/20 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-500/30' },
  competition: { label: 'Competencia', color: 'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-800 dark:text-fuchsia-300 border-fuchsia-200 dark:border-fuchsia-500/30' },
  workshop: { label: 'Taller', color: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30' },
  staff_meeting: { label: 'Reunión de Staff', color: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-300 border-indigo-200 dark:border-indigo-500/30' },
  other: { label: 'Otro', color: 'bg-gray-100 dark:bg-gray-500/20 text-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-500/30' },
};

const SPORT_EVENT_OVERRIDES: Record<string, Record<string, { label: string; color: string }>> = {
  'Porrismo': {
    training: { label: 'Práctica de Rutina', color: 'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-800 dark:text-fuchsia-300 border-fuchsia-200 dark:border-fuchsia-500/30' },
    match: { label: 'Exhibición', color: 'bg-pink-100 dark:bg-pink-500/20 text-pink-800 dark:text-pink-300 border-pink-200 dark:border-pink-500/30' },
    competition: { label: 'Competencia All-Star', color: 'bg-fuchsia-100 dark:bg-fuchsia-600/20 text-fuchsia-900 dark:text-fuchsia-200 border-fuchsia-300 dark:border-fuchsia-600/30' },
    workshop: { label: 'Taller Técnica de Vuelo', color: 'bg-violet-100 dark:bg-violet-500/20 text-violet-800 dark:text-violet-300 border-violet-200 dark:border-violet-500/30' },
    evaluation: { label: 'Evaluación de Nivel', color: 'bg-teal-100 dark:bg-teal-500/20 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-500/30' },
  },
  'Fútbol': {
    training: { label: 'Entrenamiento Táctico', color: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/30' },
    match: { label: 'Partido Oficial', color: 'bg-green-100 dark:bg-green-500/20 text-green-800 dark:text-green-300 border-green-200 dark:border-green-500/30' },
    competition: { label: 'Torneo', color: 'bg-emerald-100 dark:bg-emerald-600/20 text-emerald-900 dark:text-emerald-200 border-emerald-300 dark:border-emerald-600/30' },
  },
  'Fútbol Sala': {
    training: { label: 'Entrenamiento Táctico', color: 'bg-teal-100 dark:bg-teal-500/20 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-500/30' },
    match: { label: 'Partido Oficial', color: 'bg-teal-100 dark:bg-teal-500/20 text-teal-800 dark:text-teal-300 border-teal-200 dark:border-teal-500/30' },
    competition: { label: 'Torneo', color: 'bg-teal-100 dark:bg-teal-600/20 text-teal-900 dark:text-teal-200 border-teal-300 dark:border-teal-600/30' },
  },
  'Baloncesto': {
    training: { label: 'Práctica de Cancha', color: 'bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-500/30' },
    match: { label: 'Juego Oficial', color: 'bg-orange-100 dark:bg-orange-600/20 text-orange-900 dark:text-orange-200 border-orange-300 dark:border-orange-600/30' },
  },
  'Natación': {
    training: { label: 'Entrenamiento en Piscina', color: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border-cyan-200 dark:border-cyan-500/30' },
    competition: { label: 'Torneo de Natación', color: 'bg-sky-100 dark:bg-sky-500/20 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-500/30' },
  },
  'Gimnasia': {
    training: { label: 'Práctica de Aparatos', color: 'bg-pink-100 dark:bg-pink-500/20 text-pink-800 dark:text-pink-300 border-pink-200 dark:border-pink-500/30' },
    competition: { label: 'Competencia de Gimnasia', color: 'bg-pink-100 dark:bg-pink-600/20 text-pink-900 dark:text-pink-200 border-pink-300 dark:border-pink-600/30' },
  },
  'Atletismo': {
    training: { label: 'Sesión de Pista', color: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30' },
    match: { label: 'Competencia de Pista', color: 'bg-amber-100 dark:bg-amber-600/20 text-amber-900 dark:text-amber-200 border-amber-300 dark:border-amber-600/30' },
  },
  'Tenis': {
    training: { label: 'Práctica de Cancha', color: 'bg-lime-100 dark:bg-lime-500/20 text-lime-800 dark:text-lime-300 border-lime-200 dark:border-lime-500/30' },
    match: { label: 'Partido de Tenis', color: 'bg-lime-100 dark:bg-lime-600/20 text-lime-900 dark:text-lime-200 border-lime-300 dark:border-lime-600/30' },
  },
  'Voleibol': {
    training: { label: 'Práctica de Voleibol', color: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-800 dark:text-yellow-300 border-yellow-200 dark:border-yellow-500/30' },
    match: { label: 'Juego de Voleibol', color: 'bg-yellow-100 dark:bg-yellow-600/20 text-yellow-900 dark:text-yellow-200 border-yellow-300 dark:border-yellow-600/30' },
  },
  'Artes Marciales': {
    training: { label: 'Sesión de Dojo', color: 'bg-red-100 dark:bg-red-500/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30' },
    match: { label: 'Combate', color: 'bg-red-100 dark:bg-red-600/20 text-red-900 dark:text-red-200 border-red-300 dark:border-red-600/30' },
    competition: { label: 'Campeonato', color: 'bg-red-200 dark:bg-red-700/20 text-red-900 dark:text-red-100 border-red-300 dark:border-red-700/30' },
  },
};

const EVENT_TYPE_ICONS: Record<string, React.ElementType> = {
  training: Dumbbell,
  match: Swords,
  meeting: MessageCircle,
  evaluation: ClipboardList,
  competition: Trophy,
  workshop: GraduationCap,
  staff_meeting: Users,
  other: CalendarIcon,
};

// ─── Timezone-safe date helpers ───────────────────────────────────────────
function localDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function eventMatchesDate(event: CalendarEvent, date: Date): boolean {
  return localDateOnly(new Date(event.start_time)) === localDateOnly(date);
}

// ─── Component ────────────────────────────────────────────────────────────
// El acudiente (rol activo `parent`) ve el Calendario V2; los demás roles,
// el calendario mensual de siempre, sin cambios.
export default function CalendarPage() {
  const { profile } = useAuth();
  const { currentUserRole } = useSchoolContext();
  if (ACUDIENTE_V2 && usesParentCalendarV2(currentUserRole, profile?.role)) {
    return <ParentCalendarV2 vistaMes={<CalendarPageClassic soloLectura />} />;
  }
  return <CalendarPageClassic />;
}

/**
 * `soloLectura`: vista «Mes» del acudiente V2. El acudiente RECIBE los eventos
 * de la escuela y del profe; no crea, no edita ni borra (sin «Nuevo Evento»,
 * sin «Crear Evento», sin lápiz).
 */
function CalendarPageClassic({ soloLectura = false }: { soloLectura?: boolean } = {}) {
  const { user, profile } = useAuth();
  const { can } = usePermissions();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { schoolId, currentUserRole } = useSchoolContext();

  // Admin/owner/reporter see all school events
  const isSchoolWideView = ['owner', 'admin', 'super_admin', 'school_admin', 'reporter'].includes(currentUserRole || '');
  // Quién puede publicar un evento para un equipo o para toda la escuela: el
  // staff (la RLS exige user_staff_school_ids). Los padres solo crean lo suyo.
  const isStaff = isSchoolWideView || currentUserRole === 'coach';
  const isParentView = currentUserRole === 'parent' || currentUserRole === 'athlete';

  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [coachSport, setCoachSport] = useState<string | null>(null);

  // Date picker popover states
  const [startDateOpen, setStartDateOpen] = useState(false);
  const [endDateOpen, setEndDateOpen] = useState(false);

  const liveMatchEnabled = useEntitlements().liveMatchEnabled;
  const [formatoVivo, setFormatoVivo] = useState<FormatoVivoForm>(FORMATO_VIVO_DEFECTO);

  // Form state
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    event_type: 'training',
    startDate: null as Date | null,
    startTime: '09:00',
    endDate: null as Date | null,
    endTime: '10:00',
    location: '',
    all_day: false,
    event_label: '',
    // 'private' = solo yo · 'school' = toda la escuela · <uuid> = ese equipo
    target: 'private',
    // Solo para un Partido de un equipo: crea el partido ligado (create_match).
    rival: '',
    is_home: 'true',
  });

  // ── Get sport-specific event types ────────────────────────────────────
  const getEventTypes = useMemo(() => {
    const overrides = coachSport ? SPORT_EVENT_OVERRIDES[coachSport] || {} : {};
    const merged: Record<string, { label: string; color: string }> = {};
    for (const [key, base] of Object.entries(BASE_EVENT_TYPES)) {
      merged[key] = overrides[key] || base;
    }
    return merged;
  }, [coachSport]);

  // ── Fetch coach primary sport ─────────────────────────────────────────
  useEffect(() => {
    if (profile?.role === 'coach' && user?.id) {
      (supabase
        .from('coach_profiles' as any)
        .select('primary_sport')
        .eq('id', user.id)
        .maybeSingle() as any)
        .then(({ data }: { data: { primary_sport: string } | null }) => {
          if (data?.primary_sport) {
            setCoachSport(data.primary_sport);
          }
        });
    }
  }, [profile?.role, user?.id]);

  // ── Equipos que este usuario puede elegir al crear un evento ─────────
  // Owner/admin: todos los equipos activos de la escuela. Coach: solo los
  // suyos (teams.coach_id o team_coaches, comparando contra auth.uid() y
  // contra su school_staff.id — mismo criterio que TrainingPlansPage). Los
  // padres no eligen equipo: sus eventos son personales.
  const { data: selectableTeams = [] } = useQuery({
    queryKey: ['calendar-teams', user?.id, schoolId, currentUserRole],
    queryFn: async () => {
      if (!user?.id || !schoolId || !isStaff) return [] as { id: string; name: string }[];

      const { data: staffData } = await supabase
        .from('school_staff')
        .select('id')
        .eq('coach_auth_id', user.id)
        .eq('school_id', schoolId)
        .maybeSingle();
      const staffId = (staffData as any)?.id as string | undefined;

      const { data, error } = await (supabase
        .from('teams')
        .select('id, name, coach_id, active, team_coaches(coach_id)')
        .eq('school_id', schoolId)
        .eq('active', true) as any);
      if (error) throw error;

      let rows: any[] = data || [];
      if (currentUserRole === 'coach') {
        rows = rows.filter((t) =>
          t.coach_id === user.id
          || (staffId && t.coach_id === staffId)
          || t.team_coaches?.some((tc: any) => tc.coach_id === user.id || (staffId && tc.coach_id === staffId)),
        );
      }
      return rows
        .map((t) => ({ id: t.id as string, name: t.name as string }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: !!user?.id && !!schoolId && isStaff,
  });

  // Con qué "Para quién" arranca el formulario de crear.
  const defaultTarget = useMemo(() => {
    if (!isStaff || !schoolId) return 'private';
    if (currentUserRole === 'coach') {
      // Un solo equipo: se preselecciona. Varios: que elija (no adivinamos).
      return selectableTeams.length === 1 ? selectableTeams[0].id : '';
    }
    return 'school';
  }, [isStaff, schoolId, currentUserRole, selectableTeams]);

  // 'private' → solo mío; 'school' → toda la escuela; <uuid> → ese equipo.
  // school_id viaja siempre que haya equipo, pero en la base manda el equipo
  // (trigger calendar_events_fill_school).
  const targetToColumns = (target: string) => {
    if (!isStaff || !schoolId || !target || target === 'private') return { school_id: null, team_id: null };
    if (target === 'school') return { school_id: schoolId, team_id: null };
    return { school_id: schoolId, team_id: target };
  };

  // ── Fetch events ──────────────────────────────────────────────────────
  // Una sola consulta para todos los roles: lo de la escuela activa (de un
  // equipo o de toda la escuela) más lo propio. Quién ve qué lo decide la RLS
  // de calendar_events: el staff ve todo lo de su escuela, la familia ve los
  // equipos de sus hijos, y cada uno ve lo suyo. Antes cada rol pedía solo
  // `user_id = yo`, y por eso los papás nunca veían lo que creaba el coach.
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['calendar-events', user?.id, schoolId],
    queryFn: async () => {
      if (!user) return [];

      let query = (supabase
        .from('calendar_events' as any)
        .select('*, teams(name), match_results(id)') as any);
      query = schoolId
        ? query.or(`school_id.eq.${schoolId},user_id.eq.${user.id}`)
        : query.eq('user_id', user.id);
      const { data, error } = await query.order('start_time', { ascending: true });
      if (error) throw error;

      const rows: any[] = data || [];

      // Nombre de quien creó cada evento: solo le sirve al staff, que ve
      // eventos de varias personas. Si profiles no deja leer, queda sin nombre.
      const nameMap: Record<string, string> = {};
      if (isStaff && schoolId) {
        const creatorIds = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean)));
        if (creatorIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', creatorIds);
          (profiles || []).forEach((p: any) => { nameMap[p.id] = p.full_name || 'Sin nombre'; });
        }
      }

      return rows.map((e) => ({
        ...e,
        team_name: e.teams?.name ?? null,
        // Embed inverso (match_results.calendar_event_id): arreglo o fila según PostgREST.
        match_id: (Array.isArray(e.match_results) ? e.match_results[0]?.id : e.match_results?.id) ?? null,
        creator_name: nameMap[e.user_id] || undefined,
      })) as CalendarEvent[];
    },
    enabled: !!user?.id,
  });

  // ── Build ISO timestamps from date+time pickers ───────────────────────
  const buildIso = (date: Date | null, time: string): string => {
    if (!date) return '';
    const [h, m] = time.split(':').map(Number);
    const d = new Date(date);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  // Partido para un equipo concreto (no «toda la escuela» ni «solo yo»).
  const esPartidoDeEquipo = (fd: typeof formData) =>
    fd.event_type === 'match' && isStaff && !!schoolId && !!fd.target && fd.target !== 'school' && fd.target !== 'private';

  // ── Create event mutation ─────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: async (fd: typeof formData) => {
      if (!user) throw new Error('No autenticado');
      const startIso = buildIso(fd.startDate, fd.startTime);
      const endIso = buildIso(fd.endDate, fd.endTime);
      if (!startIso || !endIso) throw new Error('Fechas inválidas');

      // F4 del spec de partidos: un Partido para un equipo es UN registro.
      // create_match crea el partido y su evento de calendario ligado en la
      // misma transacción; así aparece en Resultados y en Equipos › Partidos
      // sin volver a escribirlo.
      if (esPartidoDeEquipo(fd)) {
        const errFormato = liveMatchEnabled ? validarFormatoVivo(formatoVivo) : null;
        if (errFormato) throw new Error(errFormato);
        const { data, error } = await (supabase as any).rpc('create_match', {
          p: {
            team_id: fd.target,
            opponent: fd.rival.trim(),
            match_date: format(fd.startDate as Date, 'yyyy-MM-dd'),
            kickoff_at: startIso,
            is_home: fd.is_home === 'true',
            location: fd.location || '',
            notes: fd.description || '',
            match_type: fd.event_label || '',
            create_calendar_event: true,
            ...payloadFormatoVivo(liveMatchEnabled, formatoVivo),
          },
        });
        if (error) throw new Error(error.code === '42501' ? 'No tienes permiso para crear partidos de este equipo' : 'No se pudo crear el partido');
        // Lo que create_match no sabe (título propio, hora de fin, deporte y
        // etiqueta) se ajusta en el mismo evento. Si falla, el partido y el
        // evento ya quedaron bien: solo se pierde el detalle.
        const eventId = (data as { calendar_event_id?: string } | null)?.calendar_event_id;
        if (eventId) {
          const { error: ajuste } = await (supabase
            .from('calendar_events' as any)
            .update({
              title: fd.title.trim() || `Partido vs ${fd.rival.trim()}`,
              end_time: endIso,
              sport: coachSport || null,
              event_label: fd.event_label || null,
            })
            .eq('id', eventId) as any);
          if (ajuste) console.warn('[calendario] ajuste del evento del partido', ajuste);
        }
        return;
      }

      const payload = {
        user_id: user.id,
        title: fd.title,
        description: fd.description || null,
        event_type: fd.event_type,
        start_time: startIso,
        end_time: endIso,
        location: fd.location || null,
        all_day: fd.all_day,
        sport: coachSport || null,
        event_label: fd.event_label || null,
        ...targetToColumns(fd.target),
      };

      const { error } = await (supabase
        .from('calendar_events' as any)
        .insert(payload) as any);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      if (esPartidoDeEquipo(formData)) {
        queryClient.invalidateQueries({ queryKey: ['coach-v2', 'partidos'] });
        queryClient.invalidateQueries({ queryKey: ['coach-v2', 'partidos-proximos'] });
        queryClient.invalidateQueries({ queryKey: ['match-results'] });
        toast({ title: '✅ Partido creado', description: 'Quedó en el calendario y en Resultados. Ábrelo para convocar.' });
      } else {
        toast({ title: '✅ Evento creado', description: `${formData.title} agregado al calendario` });
      }
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message || 'No se pudo crear', variant: 'destructive' });
    },
  });

  // ── Update event mutation ─────────────────────────────────────────────
  const updateMutation = useMutation({
    mutationFn: async ({ id, ...fd }: typeof formData & { id: string }) => {
      if (!user) throw new Error('No autenticado');
      const startIso = buildIso(fd.startDate, fd.startTime);
      const endIso = buildIso(fd.endDate, fd.endTime);
      if (!startIso || !endIso) throw new Error('Fechas inválidas');

      const payload = {
        title: fd.title,
        description: fd.description || null,
        event_type: fd.event_type,
        start_time: startIso,
        end_time: endIso,
        location: fd.location || null,
        all_day: fd.all_day,
        sport: coachSport || null,
        event_label: fd.event_label || null,
        ...targetToColumns(fd.target),
      };

      // Sin `.eq('user_id', yo)`: la RLS deja editar al creador y a la
      // administración de la escuela (para corregir lo de un coach).
      const { data: updated, error } = await (supabase
        .from('calendar_events' as any)
        .update(payload)
        .eq('id', id)
        .select('id') as any);
      if (error) throw error;
      if (!updated || updated.length === 0) throw new Error('No tienes permiso para editar este evento');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      toast({ title: '✅ Evento actualizado', description: `${formData.title} ha sido modificado` });
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message || 'No se pudo actualizar', variant: 'destructive' });
    },
  });

  // ── Delete event mutation ─────────────────────────────────────────────
  // La RLS deja borrar al creador y a la administración de la escuela.
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { data: deleted, error } = await (supabase
        .from('calendar_events' as any)
        .delete()
        .eq('id', id)
        .select('id') as any);
      if (error) throw error;
      if (!deleted || deleted.length === 0) throw new Error('No tienes permiso para eliminar este evento');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
      toast({ title: 'Evento eliminado', description: `${formData.title} ya no está en el calendario` });
      closeDialog();
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message || 'No se pudo eliminar', variant: 'destructive' });
    },
  });

  const handleDelete = () => {
    if (!editingEvent) return;
    if (!window.confirm(`¿Eliminar "${editingEvent.title}"? Las familias dejarán de verlo.`)) return;
    deleteMutation.mutate(editingEvent.id);
  };

  // ── Calendar grid computation ─────────────────────────────────────────
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const days = eachDayOfInterval({ start: monthStart, end: monthEnd });

    const startDow = getDay(monthStart);
    const padBefore = Array.from({ length: startDow }, (_, i) => {
      const d = new Date(monthStart);
      d.setDate(d.getDate() - (startDow - i));
      return { date: d, isCurrentMonth: false };
    });

    const daysWithMonth = days.map(d => ({ date: d, isCurrentMonth: true }));
    const totalCells = 42;
    const remaining = totalCells - padBefore.length - daysWithMonth.length;
    const padAfter = Array.from({ length: remaining }, (_, i) => {
      const d = new Date(monthEnd);
      d.setDate(d.getDate() + i + 1);
      return { date: d, isCurrentMonth: false };
    });

    return [...padBefore, ...daysWithMonth, ...padAfter];
  }, [currentMonth]);

  const eventsForDate = (date: Date) =>
    events.filter(e => eventMatchesDate(e, date));

  const upcomingEvents = useMemo(() => {
    const todayStr = localDateOnly(new Date());
    return events
      .filter(e => localDateOnly(new Date(e.start_time)) >= todayStr)
      .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
      .slice(0, 5);
  }, [events]);

  // ── Helpers ───────────────────────────────────────────────────────────
  const getIconForEvent = (event: CalendarEvent) => {
    const sport = event.sport || coachSport;
    if (sport && SPORT_ICONS[sport]) return SPORT_ICONS[sport];
    return EVENT_TYPE_ICONS[event.event_type] || CalendarIcon;
  };

  const getColorForEvent = (event: CalendarEvent) => {
    const sport = event.sport || coachSport;
    if (sport && SPORT_COLORS[sport]) return SPORT_COLORS[sport];
    return DEFAULT_SPORT_COLOR;
  };

  // Para quién es el evento, tal como se muestra en la tarjeta.
  const audienceLabel = (event: CalendarEvent): string | null => {
    if (event.team_id) return event.team_name || 'Equipo';
    if (event.school_id) return 'Toda la escuela';
    return null;
  };

  // El lápiz solo aparece si la RLS va a dejar guardar: creador o admin.
  const canEdit = (event: CalendarEvent) => !soloLectura && (event.user_id === user?.id || isSchoolWideView);

  const resetForm = () =>
    setFormData({
      title: '',
      description: '',
      event_type: 'training',
      startDate: null,
      startTime: '09:00',
      endDate: null,
      endTime: '10:00',
      location: '',
      all_day: false,
      event_label: '',
      target: 'private',
      rival: '',
      is_home: 'true',
    });

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingEvent(null);
    resetForm();
  };

  const handleOpenCreate = () => {
    setEditingEvent(null);
    resetForm();
    setFormData(prev => ({
      ...prev,
      target: defaultTarget,
      ...(selectedDate ? { startDate: selectedDate, endDate: selectedDate } : {}),
    }));
    setDialogOpen(true);
  };

  const handleOpenEdit = (event: CalendarEvent) => {
    setEditingEvent(event);
    const startD = new Date(event.start_time);
    const endD = new Date(event.end_time);
    setFormData({
      title: event.title,
      description: event.description || '',
      event_type: event.event_type,
      startDate: startD,
      startTime: `${String(startD.getHours()).padStart(2, '0')}:${String(startD.getMinutes()).padStart(2, '0')}`,
      endDate: endD,
      endTime: `${String(endD.getHours()).padStart(2, '0')}:${String(endD.getMinutes()).padStart(2, '0')}`,
      location: event.location || '',
      all_day: event.all_day,
      event_label: event.event_label || '',
      target: event.team_id ? event.team_id : event.school_id ? 'school' : 'private',
      rival: '',
      is_home: 'true',
    });
    setDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEvent && esPartidoDeEquipo(formData) && formData.rival.trim().length < 2) {
      toast({ title: 'Falta el rival', description: 'Escribe contra quién juegan.', variant: 'destructive' });
      return;
    }
    if (editingEvent) {
      updateMutation.mutate({ id: editingEvent.id, ...formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  // ── Loading ───────────────────────────────────────────────────────────
  if (isLoading) return <LoadingSpinner fullScreen text="Cargando calendario..." />;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {isSchoolWideView ? 'Calendario de la Escuela' : isParentView ? 'Calendario Familiar' : 'Mi Calendario'}
          </h1>
          <p className="text-muted-foreground">
            {isSchoolWideView
              ? 'Todos los eventos de entrenadores y sedes'
              : isParentView
                ? 'Entrenamientos, partidos y eventos de los equipos de tu familia'
                : coachSport
                  ? `Gestiona tus actividades de ${coachSport}`
                  : 'Gestiona tus entrenamientos, partidos y eventos'}
          </p>
        </div>
        {!soloLectura && (
          <PermissionGate permission="calendar:create">
            <Button className="gap-2" onClick={handleOpenCreate}>
              <Plus className="h-4 w-4" />
              Nuevo Evento
            </Button>
          </PermissionGate>
        )}
      </div>

      {/* Main grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* ──── Calendar Grid (2 cols) ────────────────────────────────── */}
        <Card className="lg:col-span-2 border-border/50 bg-card/80 backdrop-blur">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-xl capitalize">
                <CalendarIcon className="h-5 w-5 text-primary" />
                {format(currentMonth, 'MMMM yyyy', { locale: es })}
              </CardTitle>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setCurrentMonth(new Date())}>
                  Hoy
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-7 gap-1 mb-2">
              {['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'].map(d => (
                <div key={d} className="text-center text-xs font-semibold text-muted-foreground py-2 uppercase tracking-wider">
                  {d}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map(({ date, isCurrentMonth: isCurMonth }, i) => {
                const dayEvents = eventsForDate(date);
                const hasEvents = dayEvents.length > 0;
                const today = isToday(date);
                const isSelected = selectedDate ? isSameDay(date, selectedDate) : false;

                const DayIcon = hasEvents ? getIconForEvent(dayEvents[0]) : null;
                const dayColor = hasEvents ? getColorForEvent(dayEvents[0]) : null;

                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(date)}
                    className={`
                      relative p-2 rounded-xl text-sm transition-all duration-200 min-h-14
                      flex flex-col items-center justify-start gap-0.5
                      hover:bg-accent/60 hover:scale-[1.03]
                      ${!isCurMonth ? 'opacity-30 pointer-events-none' : ''}
                      ${today ? 'ring-2 ring-primary bg-primary/10 font-bold' : ''}
                      ${isSelected && !today ? 'ring-2 ring-primary/60 bg-accent/40' : ''}
                      ${hasEvents && isCurMonth && !today ? `${dayColor?.bg} ${dayColor?.border} border` : ''}
                    `}
                  >
                    <span className={`text-xs leading-none ${today ? 'text-primary font-bold' : ''}`}>
                      {date.getDate()}
                    </span>
                    {hasEvents && DayIcon && (
                      <DayIcon className={`h-3.5 w-3.5 mt-0.5 ${dayColor?.icon || 'text-primary'}`} />
                    )}
                    {dayEvents.length > 1 && (
                      <span className="text-[9px] text-muted-foreground leading-none">+{dayEvents.length - 1}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {coachSport && (
              <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border/30">
                <span className="text-xs text-muted-foreground">Deporte:</span>
                {(() => {
                  const SportIcon = SPORT_ICONS[coachSport] || Star;
                  const color = SPORT_COLORS[coachSport] || DEFAULT_SPORT_COLOR;
                  return (
                    <Badge variant="outline" className={`${color.bg} ${color.text} ${color.border} text-xs gap-1`}>
                      <SportIcon className="h-3 w-3" />
                      {coachSport}
                    </Badge>
                  );
                })()}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ──── Upcoming Events ────────────────────────────────────────── */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Star className="h-4 w-4 text-primary" />
            Próximos Eventos
          </h2>

          {upcomingEvents.length === 0 ? (
            <Card className="border-dashed border-border/50 bg-card/60">
              <CardContent className="py-10 text-center">
                <CalendarIcon className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No hay eventos próximos</p>
                {!soloLectura && (
                  <Button variant="outline" size="sm" className="mt-3 gap-1" onClick={handleOpenCreate}>
                    <Plus className="h-3 w-3" /> Crear Evento
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            upcomingEvents.map((event, idx) => {
              const Icon = getIconForEvent(event);
              const color = getColorForEvent(event);
              const typeConfig = getEventTypes[event.event_type] || BASE_EVENT_TYPES.other;

              return (
                <Card
                  key={event.id}
                  className="group border-border/40 bg-gradient-to-br from-card/90 to-card/60 hover:shadow-lg hover:shadow-primary/5 hover:border-primary/30 transition-all duration-300 overflow-hidden animate-in slide-in-from-right"
                  style={{ animationDelay: `${idx * 80}ms` }}
                >
                  <CardContent className="p-4">
                    <div className="flex gap-3">
                      <div className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${color.bg} ${color.border} border group-hover:scale-110 transition-transform duration-300`}>
                        <Icon className={`h-6 w-6 ${color.icon}`} />
                      </div>

                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold text-sm leading-tight truncate group-hover:text-primary transition-colors">
                          {event.title}
                        </h4>
                        <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3 shrink-0" />
                          <span>{format(new Date(event.start_time), "EEE d MMM · HH:mm", { locale: es })}</span>
                        </div>
                        {event.location && (
                          <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                            <MapPin className="h-3 w-3 shrink-0" />
                            <span className="truncate">{event.location}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-2">
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${typeConfig.color}`}>
                            {event.event_label || typeConfig.label}
                          </Badge>
                          {audienceLabel(event) && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              <Users className="h-2.5 w-2.5 mr-0.5" />
                              {audienceLabel(event)}
                            </Badge>
                          )}
                          {isStaff && event.creator_name && event.user_id !== user?.id && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                              {event.creator_name}
                            </Badge>
                          )}
                        </div>
                      </div>

                      {canEdit(event) && (
                        <div className="shrink-0 self-start">
                          <Button
                            variant="ghost" size="icon"
                            className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/10"
                            onClick={() => handleOpenEdit(event)}
                          >
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>

      {/* ──── Selected Date Details ──────────────────────────────────────── */}
      {selectedDate && eventsForDate(selectedDate).length > 0 && (
        <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300 border-border/50 bg-card/80">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarIcon className="h-5 w-5 text-primary" />
              Eventos del {format(selectedDate, "EEEE d 'de' MMMM", { locale: es })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              {eventsForDate(selectedDate).map(event => {
                const Icon = getIconForEvent(event);
                const color = getColorForEvent(event);
                const typeConfig = getEventTypes[event.event_type] || BASE_EVENT_TYPES.other;

                return (
                  <div key={event.id} className="p-4 rounded-xl border border-border/40 bg-gradient-to-br from-card to-card/60 hover:shadow-md transition-all group">
                    <div className="flex gap-3">
                      <div className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${color.bg} ${color.border} border`}>
                        <Icon className={`h-5 w-5 ${color.icon}`} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-start justify-between">
                          <h3 className="font-semibold">{event.title}</h3>
                          {canEdit(event) && (
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 -mt-1 -mr-1 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-primary/10"
                              onClick={() => handleOpenEdit(event)}
                            >
                              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          )}
                        </div>
                        {event.description && (
                          <p className="text-sm text-muted-foreground mt-1">{event.description}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted-foreground">
                          <div className="flex items-center gap-1 bg-muted/50 px-2 py-0.5 rounded-md">
                            <Clock className="h-3 w-3" />
                            {format(new Date(event.start_time), 'HH:mm')} – {format(new Date(event.end_time), 'HH:mm')}
                          </div>
                          {event.location && (
                            <div className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              {event.location}
                            </div>
                          )}
                        </div>
                        <Badge variant="outline" className={`mt-2 text-[10px] ${typeConfig.color}`}>
                          {event.event_label || typeConfig.label}
                        </Badge>
                        {audienceLabel(event) && (
                          <Badge variant="secondary" className="mt-2 ml-1 text-[10px]">
                            <Users className="h-2.5 w-2.5 mr-0.5" />
                            {audienceLabel(event)}
                          </Badge>
                        )}
                        {isStaff && event.creator_name && event.user_id !== user?.id && (
                          <Badge variant="outline" className="mt-2 ml-1 text-[10px] text-muted-foreground">
                            {event.creator_name}
                          </Badge>
                        )}
                        {isStaff && event.match_id && (
                          <div className="mt-3">
                            <Button asChild size="sm" variant="outline" className="h-10 gap-1 rounded-xl">
                              <Link to={`/partidos/${event.match_id}`}>Abrir partido <ChevronRight className="h-3.5 w-3.5" /></Link>
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ──── Create / Edit Event Dialog ─────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingEvent ? 'Editar Evento' : 'Crear Nuevo Evento'}</DialogTitle>
            <DialogDescription>
              {editingEvent
                ? 'Modifica los datos de tu evento.'
                : coachSport
                  ? `Nuevo evento de ${coachSport} en tu calendario.`
                  : 'Agrega una actividad a tu calendario.'}
            </DialogDescription>
            {coachSport && (
              <div className="flex items-center gap-2 mt-1">
                {(() => {
                  const SportIcon = SPORT_ICONS[coachSport] || Star;
                  const color = SPORT_COLORS[coachSport] || DEFAULT_SPORT_COLOR;
                  return (
                    <Badge variant="outline" className={`${color.bg} ${color.text} ${color.border} text-xs gap-1`}>
                      <SportIcon className="h-3 w-3" />
                      {coachSport}
                    </Badge>
                  );
                })()}
              </div>
            )}
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 py-2">
            {/* Title */}
            <div className="space-y-2">
              <Label>Título *</Label>
              <Input
                value={formData.title}
                onChange={e => setFormData({ ...formData, title: e.target.value })}
                placeholder={!editingEvent && esPartidoDeEquipo(formData) ? 'Si lo dejas vacío: «Partido vs <rival>»' : 'Ej: Campeonato Nacional'}
                required={editingEvent ? true : !esPartidoDeEquipo(formData)}
              />
            </div>

            {/* Para quién es el evento (solo staff) */}
            {isStaff && schoolId && (
              <div className="space-y-2">
                <Label>Para quién *</Label>
                <Select value={formData.target} onValueChange={v => setFormData({ ...formData, target: v })}>
                  <SelectTrigger><SelectValue placeholder="Elige el equipo" /></SelectTrigger>
                  <SelectContent>
                    {selectableTeams.map(t => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                    <SelectItem value="school">Toda la escuela</SelectItem>
                    <SelectItem value="private">Solo para mí</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {!formData.target
                    ? 'Las familias de ese equipo lo verán en su calendario.'
                    : formData.target === 'private'
                      ? 'Nadie más lo ve.'
                      : formData.target === 'school'
                        ? 'Lo ven todas las familias y el staff de la escuela.'
                        : 'Lo ven las familias de ese equipo y el staff de la escuela.'}
                </p>
              </div>
            )}

            {/* Type + Location */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Tipo de Evento *</Label>
                <Select value={formData.event_type} onValueChange={v => setFormData({ ...formData, event_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(getEventTypes).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Etiqueta personalizada</Label>
                <Input
                  value={formData.event_label}
                  onChange={e => setFormData({ ...formData, event_label: e.target.value })}
                  placeholder={
                    coachSport === 'Porrismo'
                      ? 'Ej: Competencia Nivel 3'
                      : coachSport === 'Fútbol' || coachSport === 'Fútbol Sala'
                        ? 'Ej: Liga Municipal Sub-15'
                        : 'Ej: Competencia Regional'
                  }
                />
              </div>
            </div>

            {/* Partido de un equipo: rival y local/visitante → create_match */}
            {!editingEvent && esPartidoDeEquipo(formData) && (
              <div className="grid grid-cols-2 gap-4 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <div className="col-span-2 space-y-2 sm:col-span-1">
                  <Label htmlFor="cal-rival">Rival *</Label>
                  <Input
                    id="cal-rival"
                    value={formData.rival}
                    onChange={e => setFormData({ ...formData, rival: e.target.value })}
                    placeholder="Ej: Halcones FC"
                  />
                </div>
                <div className="col-span-2 space-y-2 sm:col-span-1">
                  <Label>¿Dónde juegan?</Label>
                  <Select value={formData.is_home} onValueChange={v => setFormData({ ...formData, is_home: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">En casa (local)</SelectItem>
                      <SelectItem value="false">De visita</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {liveMatchEnabled && <FormatoVivoCampos value={formatoVivo} onChange={setFormatoVivo} />}
                <p className="col-span-2 text-xs text-muted-foreground">
                  Se crea el partido: aparece en Resultados y en Equipos › Partidos, donde convocas, registras el resultado y evalúas.
                </p>
              </div>
            )}

            {/* Date pickers */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Fecha de Inicio *</Label>
                <Popover open={startDateOpen} onOpenChange={setStartDateOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={`w-full justify-start text-left font-normal ${!formData.startDate ? 'text-muted-foreground' : ''}`}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formData.startDate
                        ? format(formData.startDate, 'PPP', { locale: es })
                        : 'Seleccionar fecha'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={formData.startDate || undefined}
                      onSelect={(d) => {
                        setFormData(prev => ({
                          ...prev,
                          startDate: d || null,
                          endDate: prev.endDate || d || null,
                        }));
                        setStartDateOpen(false);
                      }}
                      locale={es}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>Hora de Inicio *</Label>
                <Input
                  type="time"
                  value={formData.startTime}
                  onChange={e => setFormData({ ...formData, startTime: e.target.value })}
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Fecha de Fin *</Label>
                <Popover open={endDateOpen} onOpenChange={setEndDateOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={`w-full justify-start text-left font-normal ${!formData.endDate ? 'text-muted-foreground' : ''}`}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formData.endDate
                        ? format(formData.endDate, 'PPP', { locale: es })
                        : 'Seleccionar fecha'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={formData.endDate || undefined}
                      onSelect={(d) => {
                        setFormData(prev => ({ ...prev, endDate: d || null }));
                        setEndDateOpen(false);
                      }}
                      locale={es}
                      disabled={(d) => formData.startDate ? d < formData.startDate : false}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div className="space-y-2">
                <Label>Hora de Fin *</Label>
                <Input
                  type="time"
                  value={formData.endTime}
                  onChange={e => setFormData({ ...formData, endTime: e.target.value })}
                  required
                />
              </div>
            </div>

            {/* Location with autocomplete */}
            <div className="space-y-2">
              <Label>Ubicación</Label>
              <LocationAutocomplete
                value={formData.location}
                onChange={(addr) => setFormData({ ...formData, location: addr })}
                placeholder="Buscar dirección en Colombia..."
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label>Descripción</Label>
              <Textarea
                value={formData.description}
                onChange={e => setFormData({ ...formData, description: e.target.value })}
                placeholder="Detalles adicionales..."
                rows={3}
              />
            </div>

            <DialogFooter>
              {editingEvent && (
                <Button
                  type="button"
                  variant="ghost"
                  className="mr-auto text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={handleDelete}
                  disabled={isSaving || deleteMutation.isPending}
                >
                  {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Eliminar
                </Button>
              )}
              <Button type="button" variant="outline" onClick={closeDialog}>Cancelar</Button>
              <Button type="submit" disabled={isSaving || !formData.startDate || !formData.endDate || (isStaff && !!schoolId && !formData.target)}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingEvent ? 'Guardar Cambios' : 'Crear Evento'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
