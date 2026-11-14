import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Calendar,
  CalendarPlus,
  CalendarRange,
  ClipboardList,
  Copy,
  Eye,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Target,
  Trash2,
} from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { MesocycleFormDialog, type MesocycleFormSubmit } from './MesocycleFormDialog';
import { MesocycleRubricTable } from './MesocycleRubricTable';
import { SessionFormDialog } from './SessionFormDialog';
import { WeeklyLoadPanel } from './WeeklyLoadPanel';
import { MicrocycleLoadPanel } from './MicrocycleLoadPanel';
import { StandaloneMicrocyclesPanel } from './StandaloneMicrocyclesPanel';
import { MesocycleExportButton } from './MesocycleExportButton';
import { MesocycleDocuments } from './MesocycleDocuments';
import { ClosingForm, type ClosingField } from './MesocycleClosingForms';
import { dayToLocalDate, todayColombia } from '@/lib/dateUtils';
import { isTrainingReadOnlyRole } from '@/lib/school/trainingRoles';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import { datesBetween, pickDefaultMesocycle, placeLooseSessions, suggestNextStart } from '@/lib/school/mesocyclePlanning';
import { semanaDeHoy, semanaInicialAbierta, type SemanaRango } from './mesocycleWeeks';

/** 'YYYY-MM-DD' → texto en es-CO SIN correrse un día (ver dayToLocalDate). */
const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions) => dayToLocalDate(iso).toLocaleDateString('es-CO', opts);
const SHORT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

const DAY_TYPE_OPTIONS = [
  { value: 'entrenamiento', label: 'Entrenamiento' },
  { value: 'descanso', label: 'Descanso' },
  { value: 'partido', label: 'Partido' },
  { value: 'regenerativo', label: 'Regenerativo' },
  { value: 'activacion', label: 'Activación' },
] as const;

const DAY_TYPE_LABEL: Record<string, string> = {
  descanso: 'Descanso',
  entrenamiento: 'Entrenamiento',
  partido: 'Partido',
  regenerativo: 'Regenerativo',
  activacion: 'Activación',
};

const DAY_TYPE_BADGE: Record<string, string> = {
  descanso: 'bg-muted text-muted-foreground border-muted-foreground/20',
  entrenamiento: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25',
  partido: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25',
  regenerativo: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/25',
  activacion: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
};

/**
 * Roles que MIRAN el mesociclo (spec rediseño §3: "Dueño = MIRAR"). Ven todo,
 * sin controles de edición. super_admin queda editable (soporte).
 */
// La lista vive en lib/school/trainingRoles.ts: la comparten las semanas
// sueltas, el formulario de la sesión y la pizarra.
/** Administración de la escuela: puede borrar documentos de cualquiera (= user_admin_school_ids()). */
const DOC_ADMIN_ROLES = ['owner', 'school', 'school_admin', 'admin', 'super_admin'];

const WEEK_CLOSING_FIELDS: ClosingField[] = [
  { key: 'objective_compliance', label: 'Cumplimiento de objetivos' },
  { key: 'collective_performance', label: 'Rendimiento colectivo' },
  { key: 'improvement_notes', label: 'Aspectos a mejorar' },
];

const MESO_CLOSING_FIELDS: ClosingField[] = [
  { key: 'strengths', label: 'Fortalezas' },
  { key: 'areas_to_improve', label: 'Aspectos a mejorar' },
  { key: 'next_cycle_notes', label: 'Notas para el próximo mesociclo' },
];

/** Objetivo largo: se recorta a 2 líneas con "Ver más". */
const LONG_TEXT = 160;

interface MesocycleSectionProps {
  teamId: string;
  schoolId: string;
  roster: { id: string; full_name: string; athlete_type?: string }[];
  sessions: any[];
  isFootball?: boolean;
  /** D3: pizarra completa (abre «Tablero táctico» y biblioteca en los bloques). */
  hasTacticalBoard?: boolean;
  /** Deporte de la pizarra del equipo (sportFromTeam): filtro inicial de la
   *  Biblioteca de ejercicios. */
  teamSport?: TacticalSport;
  /** Solo para el título del tablero táctico dentro del SessionFormDialog de un día. */
  teamName?: string;
  onEditSession: (session: any) => void;
  /**
   * Abre la sesión en modo lectura (SessionViewer). Se usa cuando la sección
   * está en solo lectura; si no se pasa, cae en onEditSession.
   */
  onViewSession?: (session: any) => void;
  /**
   * Fuerza el modo solo lectura. Si no se pasa, se deriva del rol en la
   * escuela: dueño/administración miran, entrenadores editan.
   */
  readOnly?: boolean;
  /**
   * Día que se quiere ver (YYYY-MM-DD), p. ej. `?fecha=` desde «Planear» en
   * Sesiones: arranca abierta la semana que lo contiene.
   */
  fechaFoco?: string | null;
}

export function MesocycleSection({
  teamId,
  schoolId,
  roster,
  sessions,
  isFootball,
  hasTacticalBoard,
  teamSport,
  teamName,
  onEditSession,
  onViewSession,
  readOnly: readOnlyProp,
  fechaFoco,
}: MesocycleSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { currentUserRole } = useSchoolContext();
  const readOnly = readOnlyProp ?? isTrainingReadOnlyRole(currentUserRole);
  const canDeleteAnyDoc = DOC_ADMIN_ROLES.includes(currentUserRole || '');
  /** Clic en una sesión: en lectura abre el visor (si existe), si no el editor. */
  const openSession = (session: any) => (readOnly && onViewSession ? onViewSession(session) : onEditSession(session));

  const [formOpen, setFormOpen] = useState(false);
  // Microciclo cuya semana está agregando un día ahora mismo (formulario inline, un solo día a la vez).
  const [addingDayFor, setAddingDayFor] = useState<string | null>(null);
  const [newDay, setNewDay] = useState({ day_date: '', day_type: 'entrenamiento', planned_rpe: '', planned_minutes: '', focus: '' });
  // Semana cuyo selector de fecha de "+ Agregar sesión" está abierto.
  const [pickingDateFor, setPickingDateFor] = useState<string | null>(null);
  // Día para el que se está creando la sesión de contenido (SessionFormDialog, sin tocar el componente).
  const [sessionDialogDay, setSessionDialogDay] = useState<any | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [objectiveExpanded, setObjectiveExpanded] = useState(false);
  // Semana elegida en la pestaña Carga (null = la actual).
  const [loadWeekId, setLoadWeekId] = useState<string | null>(null);
  // Mesociclo elegido en el selector (null = el de por defecto) y si el
  // formulario abre para editar el actual o para crear el siguiente.
  const [selectedMesoId, setSelectedMesoId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'edit' | 'create'>('edit');
  // Objeto ESTABLE para el prop `session` de SessionFormDialog: si en vez de esto
  // se arma un literal `{ session_date: ... }` inline en el JSX, cambia de
  // referencia en CADA render de MesocycleSection (no solo cuando cambia el día
  // elegido). SessionFormDialog resetea blocks/drills/evaluation en un
  // useEffect con `session` en las dependencias -- con una referencia nueva en
  // cada render, cualquier re-render incidental de este componente (ej. un
  // refetch de fondo de las queries del mesociclo) vuelve a disparar ESE
  // efecto y borra el `id` que openBlockTacticalBoard le acababa de generar al
  // bloque, justo en la ventana de un tick antes de que el setTimeout abra el
  // tablero -- el guard `blocks[tacticalBlockIndex]?.id` de TacticalBoard da
  // false, el tablero nunca llega a montar, y tacticalBlockIndex queda
  // trabado en un índice no-null para siempre (nunca se llama a su onClose):
  // el diálogo de sesión de ESE día queda oculto de por vida (open = open &&
  // tacticalBlockIndex === null), y como sessionDialogDay nunca vuelve a
  // null, es la MISMA instancia de SessionFormDialog la que se reutiliza para
  // cualquier otro día -- "Crear sesión" deja de abrir nada, para cualquier
  // día, hasta recargar la página. Memoizado por día, esta referencia solo
  // cambia cuando el coach realmente abre un día distinto.
  const sessionDialogSession = useMemo(
    () => (sessionDialogDay ? { session_date: sessionDialogDay.day_date } : undefined),
    [sessionDialogDay],
  );

  // TODOS los mesociclos del equipo. Antes se traía solo el más reciente y
  // no había forma de crear el siguiente: un equipo con septiembre no podía
  // armar octubre sin borrarlo (Carmel, 2026-10-02). Ahora se elige en un
  // selector y "Nuevo mesociclo" arranca el día después del último.
  const { data: mesocycles, isLoading: loadingMesocycle } = useQuery({
    queryKey: ['mesocycles', teamId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('training_mesocycles')
        .select('*')
        .eq('team_id', teamId)
        .order('starts_on', { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: !!teamId,
  });
  // Por defecto: el que contiene hoy, si no el próximo, si no el último.
  const mesocycle = useMemo(() => {
    const list = mesocycles || [];
    return list.find((m) => m.id === selectedMesoId) ?? pickDefaultMesocycle(list, todayColombia());
  }, [mesocycles, selectedMesoId]);
  /** TrainingPlansPage lee 'mesocycle-current' para ocultar la lista suelta. */
  const invalidateMesocycles = () => {
    queryClient.invalidateQueries({ queryKey: ['mesocycles', teamId] });
    // Antes esta línea se llamaba a sí misma (recursión infinita → RangeError
    // en el onSuccess de crear/editar/borrar/cerrar mesociclo).
    queryClient.invalidateQueries({ queryKey: ['mesocycle-current', teamId] });
  };

  const { data: microcycles } = useQuery({
    queryKey: ['microcycles', mesocycle?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('training_microcycles')
        .select('*')
        .eq('mesocycle_id', mesocycle.id)
        .order('starts_on', { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!mesocycle?.id,
  });

  const { data: days } = useQuery({
    queryKey: ['microcycle-days', mesocycle?.id],
    queryFn: async () => {
      const ids = (microcycles || []).map((m: any) => m.id);
      if (ids.length === 0) return [];
      const { data, error } = await (supabase as any)
        .from('training_microcycle_days')
        .select('*')
        .in('microcycle_id', ids)
        .order('day_date', { ascending: true });
      if (error) throw error;
      return data;
    },
    enabled: !!microcycles && microcycles.length > 0,
  });

  // Índice MD: distancia en días al partido anterior/siguiente del EQUIPO,
  // sin importar en qué microciclo esté cargado ese partido (H1 — antes se
  // calculaba solo contra los partidos de la misma semana, y un lunes no
  // veía el partido del domingo si vivía en el microciclo anterior).
  // training_days_md_labels() lo resuelve en la base contra todo el
  // historial del equipo, RPC 20260921115743.
  const { data: mdLabelsByDate } = useQuery({
    queryKey: ['md-labels', teamId, (days || []).map((d: any) => d.day_date).join(',')],
    queryFn: async () => {
      const dayDates = (days || []).map((d: any) => d.day_date);
      const { data, error } = await (supabase as any).rpc('training_days_md_labels', {
        p_team_id: teamId,
        p_day_dates: dayDates,
      });
      if (error) throw error;
      const map: Record<string, string[]> = {};
      (data || []).forEach((r: any) => { map[r.day_date] = r.md_labels || []; });
      return map;
    },
    enabled: !!days && days.length > 0,
  });

  // Por día, no por id de sesión (§8.2 corregido: un día admite cualquier
  // cantidad de sesiones — gimnasio AM + cancha PM es un caso normal — así
  // que el enganche vive en training_sessions.microcycle_day_id, no al revés).
  const sessionsByDayId = useMemo(() => {
    const m = new Map<string, any[]>();
    sessions.forEach((s) => {
      if (!s.microcycle_day_id) return;
      const list = m.get(s.microcycle_day_id) || [];
      list.push(s);
      m.set(s.microcycle_day_id, list);
    });
    return m;
  }, [sessions]);

  // Sesiones sin día (creadas antes del mesociclo o sueltas): con mesociclo
  // la lista plana se oculta y quedaban guardadas pero invisibles. Las que
  // caen en una semana se muestran en su fecha con "Enganchar".
  const loose = useMemo(
    () => placeLooseSessions(sessions, microcycles || []),
    [sessions, microcycles],
  );

  // Semana que arranca abierta: la del día pedido (fechaFoco), si no la que
  // contiene hoy; si el mesociclo es futuro, la primera; si ya pasó, la última.
  // La insignia «Esta semana» va SOLO en la que contiene hoy (B7).
  const currentWeekId = useMemo(
    () => semanaInicialAbierta((microcycles || []) as SemanaRango[], todayColombia(), fechaFoco),
    [microcycles, fechaFoco],
  );
  const todayWeekId = useMemo(
    () => semanaDeHoy((microcycles || []) as SemanaRango[], todayColombia()),
    [microcycles],
  );

  const createMesocycle = useMutation({
    mutationFn: async (input: MesocycleFormSubmit) => {
      // RPC transaccional (mesociclo + sus 4 semanas en la MISMA transacción
      // de la función) — antes eran dos inserts sueltos desde el cliente: si
      // el segundo (las semanas) chocaba con UNIQUE(team_id, starts_on) por
      // reintentar sobre el mismo equipo/fechas, el mesociclo quedaba
      // igual commiteado, sin semanas y sin forma de agregar sesiones.
      const { data: newMesocycle, error } = await (supabase as any).rpc('create_mesocycle_with_weeks', {
        p_school_id: schoolId,
        p_team_id: teamId,
        p_starts_on: input.starts_on,
        p_ends_on: input.ends_on,
        p_general_objective: input.general_objective ?? null,
        p_game_model: input.game_model ?? null,
        p_n_sessions_planned: input.n_sessions_planned ?? null,
        p_session_duration_minutes: input.session_duration_minutes ?? null,
        p_evaluation_mode: input.evaluation_mode ?? 'team',
      });
      if (error) throw error;

      return newMesocycle;
    },
    onSuccess: (newMesocycle: any) => {
      invalidateMesocycles();
      if (newMesocycle?.id) setSelectedMesoId(newMesocycle.id);
      toast({ title: '✅ Mesociclo creado', description: 'Semanas generadas automáticamente.' });
      setFormOpen(false);
    },
    onError: (error: any) => toast({ title: 'Error', description: error.message, variant: 'destructive' }),
  });

  const updateMesocycle = useMutation({
    mutationFn: async (input: MesocycleFormSubmit) => {
      const { error } = await (supabase as any)
        .from('training_mesocycles')
        .update(input)
        .eq('id', mesocycle.id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateMesocycles();
      toast({ title: '✅ Mesociclo actualizado' });
      setFormOpen(false);
    },
    onError: (error: any) => toast({ title: 'Error', description: error.message, variant: 'destructive' }),
  });

  // Antes no existía forma de borrar un mesociclo mal creado desde la UI —
  // el único recurso del coach era crear uno nuevo, y eso fue lo que disparó
  // el bug de mesociclos fantasma sin semanas (20260918124721). RPC en vez
  // de un DELETE directo: training_microcycles.mesocycle_id es
  // ON DELETE SET NULL (D10, a propósito), así que un DELETE simple sobre
  // training_mesocycles deja las semanas huérfanas SIN borrar, todavía
  // ocupando UNIQUE(team_id, starts_on) — no resolvía el problema que lo
  // motivó. delete_mesocycle_cascade() (20260921120611) borra semanas y
  // mesociclo en la misma transacción. Las sesiones de contenido
  // (training_sessions) NO se borran, solo pierden el enganche al día.
  const deleteMesocycle = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase as any).rpc('delete_mesocycle_cascade', { p_mesocycle_id: mesocycle.id });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateMesocycles();
      setSelectedMesoId(null);
      toast({ title: 'Mesociclo eliminado' });
      setConfirmDelete(false);
    },
    onError: (error: any) => toast({ title: 'Error al eliminar', description: error.message, variant: 'destructive' }),
  });

  const createDay = useMutation({
    mutationFn: async ({ microcycleId, day }: { microcycleId: string; day: typeof newDay }) => {
      const { error } = await (supabase as any).from('training_microcycle_days').insert({
        school_id: schoolId,
        microcycle_id: microcycleId,
        day_date: day.day_date,
        day_type: day.day_type,
        planned_rpe: day.planned_rpe ? Number(day.planned_rpe) : null,
        planned_minutes: day.planned_minutes ? Number(day.planned_minutes) : null,
        focus: day.focus || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microcycle-days', mesocycle?.id] });
      setAddingDayFor(null);
      setNewDay({ day_date: '', day_type: 'entrenamiento', planned_rpe: '', planned_minutes: '', focus: '' });
    },
    onError: (error: any) => toast({ title: 'Error al agregar el día', description: error.message, variant: 'destructive' }),
  });

  // "+ Agregar sesión" en una fecha que todavía no tiene día en la semana:
  // crea el día (entrenamiento) y abre el formulario de sesión ya sobre él.
  // Son dos escrituras, pero un día sin sesión es un estado válido (no deja
  // nada huérfano si el coach cancela el formulario).
  const createDayForSession = useMutation({
    mutationFn: async ({ microcycleId, date }: { microcycleId: string; date: string }) => {
      const { data, error } = await (supabase as any)
        .from('training_microcycle_days')
        .insert({ school_id: schoolId, microcycle_id: microcycleId, day_date: date, day_type: 'entrenamiento' })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (day: any) => {
      queryClient.invalidateQueries({ queryKey: ['microcycle-days', mesocycle?.id] });
      setSessionDialogDay(day);
    },
    onError: (error: any) => toast({ title: 'No se pudo abrir el día', description: error.message, variant: 'destructive' }),
  });

  // Enganchar una sesión suelta al día de su fecha (creándolo si no existe).
  // El UPDATE exige microcycle_day_id nulo: si otra pestaña ya la enganchó,
  // no la mueve.
  const linkLooseSession = useMutation({
    mutationFn: async ({ sessionId, microcycleId, date, dayId }: { sessionId: string; microcycleId: string; date: string; dayId?: string }) => {
      let targetDayId = dayId;
      if (!targetDayId) {
        const { data, error } = await (supabase as any)
          .from('training_microcycle_days')
          .insert({ school_id: schoolId, microcycle_id: microcycleId, day_date: date, day_type: 'entrenamiento' })
          .select('id')
          .single();
        if (error) throw error;
        targetDayId = data.id;
      }
      const { error } = await (supabase as any)
        .from('training_sessions')
        .update({ microcycle_day_id: targetDayId })
        .eq('id', sessionId)
        .is('microcycle_day_id', null);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microcycle-days', mesocycle?.id] });
      queryClient.invalidateQueries({ queryKey: ['training-sessions', teamId] });
      toast({ title: '✅ Sesión enganchada a su día' });
    },
    onError: (error: any) => toast({ title: 'No se pudo enganchar la sesión', description: error.message, variant: 'destructive' }),
  });

  // PER-4 (spec §4 F4): duplicar la semana anterior como punto de partida
  // editable, no un catálogo cerrado — copia día/tipo/RPE/minutos/foco, NUNCA
  // sesiones de contenido (esas las escribe el coach de cero para la semana
  // nueva). No pisa un día que el coach ya haya cargado a mano en destino
  // (ON CONFLICT DO NOTHING del lado de la RPC).
  const duplicatePreviousWeek = useMutation({
    mutationFn: async ({ sourceMicrocycleId, targetMicrocycleId }: { sourceMicrocycleId: string; targetMicrocycleId: string }) => {
      const { data, error } = await (supabase as any).rpc('duplicate_microcycle_days', {
        p_source_microcycle_id: sourceMicrocycleId,
        p_target_microcycle_id: targetMicrocycleId,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (copiedCount) => {
      queryClient.invalidateQueries({ queryKey: ['microcycle-days', mesocycle?.id] });
      toast({
        title: copiedCount > 0 ? `✅ ${copiedCount} día(s) copiados` : 'Sin días para copiar',
        description: copiedCount > 0 ? 'Edítalos como punto de partida para esta semana.' : 'La semana anterior no tenía días cargados.',
      });
    },
    onError: (error: any) => toast({ title: 'Error al duplicar la semana', description: error.message, variant: 'destructive' }),
  });

  // Crea la sesión de contenido (objetivos/bloques/principios de juego, CAR-8)
  // ya enganchada al día — un solo INSERT, sin el segundo UPDATE que antes
  // enganchaba de vuelta desde training_microcycle_days.session_id (§8.2:
  // esa segunda escritura sin transacción era la causa raíz de las sesiones
  // huérfanas del 18-sep). Reusa SessionFormDialog tal cual, sin modificarlo.
  const createSessionForDay = useMutation({
    mutationFn: async ({ dayId, ...data }: { dayId: string; [key: string]: any }) => {
      const targetDayId = dayId || sessionDialogDay?.id;
      if (!targetDayId) {
        throw new Error('No se pudo identificar el día del mesociclo para esta sesión. Cierra el formulario y vuelve a intentar desde "Agregar sesión".');
      }
      // school_id es NOT NULL con RLS que lo exige (deriva sin versionar
      // encontrada y documentada el 25-sep, migración 20260925135425).
      const { data: session, error } = await (supabase as any)
        .from('training_sessions')
        .insert({ ...data, microcycle_day_id: targetDayId, school_id: schoolId })
        .select()
        .single();
      if (error) throw error;
      return session;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microcycle-days', mesocycle?.id] });
      queryClient.invalidateQueries({ queryKey: ['training-sessions', teamId] });
      toast({ title: '✅ Sesión creada y ligada al día' });
      setSessionDialogDay(null);
    },
    onError: (error: any) => toast({ title: 'Error', description: error.message, variant: 'destructive' }),
  });

  const updateMicrocycleClosing = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; objective_compliance?: string; collective_performance?: string; improvement_notes?: string }) => {
      const { error } = await (supabase as any).from('training_microcycles').update(fields).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['microcycles', mesocycle?.id] });
      toast({ title: '✅ Cierre semanal guardado' });
    },
    onError: (error: any) => toast({ title: 'Error al guardar el cierre semanal', description: error.message, variant: 'destructive' }),
  });

  // RPC (merge_mesocycle_closing_review, 20260923215537) en vez de mandar el
  // objeto `closing` completo mergeado en el cliente: closing_review es UNA
  // sola columna jsonb para las 3 cajas de texto. Con el botón "Guardar"
  // explícito se mandan las tres juntas, pero el merge sigue pasando en la
  // base (closing_review || patch) para no pisar otras claves del jsonb.
  const updateClosingReview = useMutation({
    mutationFn: async (patch: Record<string, string>) => {
      const { error } = await (supabase as any).rpc('merge_mesocycle_closing_review', {
        p_mesocycle_id: mesocycle.id,
        p_patch: patch,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateMesocycles();
      toast({ title: '✅ Cierre del mesociclo guardado' });
    },
    onError: (error: any) => toast({ title: 'Error', description: error.message, variant: 'destructive' }),
  });

  /** "+ Agregar sesión" de una semana: abre el día de esa fecha (o lo crea). */
  const addSessionOn = (mc: any, date: string) => {
    setPickingDateFor(null);
    const existing = (days || []).find((d: any) => d.microcycle_id === mc.id && d.day_date === date);
    if (existing) setSessionDialogDay(existing);
    else createDayForSession.mutate({ microcycleId: mc.id, date });
  };

  if (loadingMesocycle) return null;

  if (!mesocycle) {
    return (
      <>
        {/* D10: un equipo puede tener semanas sueltas sin haber creado nunca
            el mesociclo que las agrupe — antes no tenían ninguna vista. */}
        <StandaloneMicrocyclesPanel
          teamId={teamId}
          schoolId={schoolId}
          sessions={sessions}
          isFootball={isFootball}
          hasTacticalBoard={hasTacticalBoard}
          teamSport={teamSport}
          onEditSession={openSession}
          readOnly={readOnly}
        />
        <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm">
          <CardContent className="pt-6 text-center">
            <CalendarRange className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-40" />
            <h3 className="text-lg font-semibold mb-2">Sin mesociclo activo</h3>
            {readOnly ? (
              <p className="text-muted-foreground">El entrenador de este equipo todavía no planificó el mes.</p>
            ) : (
              <>
                <p className="text-muted-foreground mb-4">
                  Planifica el mes — período, objetivo y modelo de juego — antes de cargar sesiones sueltas.
                </p>
                <Button className="gap-2" onClick={() => setFormOpen(true)}>
                  <Plus className="w-4 h-4" />
                  Crear Mesociclo
                </Button>
              </>
            )}
          </CardContent>
        </Card>
        {!readOnly && (
          <MesocycleFormDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            onSubmit={(data) => createMesocycle.mutate(data)}
            teamId={teamId}
            isLoading={createMesocycle.isPending}
            suggestedStart={todayColombia()}
          />
        )}
      </>
    );
  }

  const closing = mesocycle.closing_review || {};
  const objective: string = mesocycle.general_objective || '';
  const objectiveIsLong = objective.length > LONG_TEXT || (mesocycle.game_model || '').length > 0;
  const weeks = (microcycles || []) as any[];
  const weekIndex = (id: string) => weeks.findIndex((w) => w.id === id);
  const loadWeek = weeks.find((w) => w.id === (loadWeekId ?? currentWeekId)) ?? weeks[0];

  const sessionRow = (session: any, extraClass = 'bg-muted/20') => (
    <button
      key={session.id}
      type="button"
      className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs border-t text-left hover:bg-accent/40 ${extraClass}`}
      onClick={() => openSession(session)}
    >
      {readOnly ? <Eye className="w-3 h-3 text-muted-foreground shrink-0" /> : <ClipboardList className="w-3 h-3 text-muted-foreground shrink-0" />}
      <span className="truncate text-muted-foreground">{session.objectives || 'Sesión sin objetivo'}</span>
    </button>
  );

  const renderWeek = (mc: any, idx: number) => {
    const mcDays = (days || []).filter((d: any) => d.microcycle_id === mc.id);
    // Adherencia (spec §3.3): días de entrenamiento con al menos una
    // sesión que registró RPE, sobre el total de días de entrenamiento de
    // la semana. Es la única métrica que dice si el módulo se está usando
    // o quedó vacío (R1).
    const trainingDays = mcDays.filter((d: any) => d.day_type === 'entrenamiento');
    const daysWithRpe = trainingDays.filter((d: any) =>
      (sessionsByDayId.get(d.id) || []).some((s: any) => s.evaluation?.rpe != null),
    );
    const weekDates = datesBetween(mc.starts_on, mc.ends_on);
    // Spec §F6: sin días vacíos. Se muestra un día si tiene sesiones (propias
    // o sueltas), o si el coach lo marcó con algo que planifica la semana
    // (partido, descanso, regenerativo, activación, o un foco escrito). Los
    // días de entrenamiento vacíos no aportan nada que mirar.
    const visibleDates = weekDates.filter((date) => {
      const day = mcDays.find((d: any) => d.day_date === date);
      if ((loose.byDate.get(date) || []).length > 0) return true;
      if (!day) return false;
      return (sessionsByDayId.get(day.id) || []).length > 0 || day.day_type !== 'entrenamiento' || !!day.focus;
    });
    const sessionCount = mcDays.reduce((n: number, d: any) => n + (sessionsByDayId.get(d.id) || []).length, 0);

    return (
      <AccordionItem key={mc.id} value={mc.id} className="px-3">
        <AccordionTrigger className="text-sm">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Semana {idx + 1}</span>
            <span className="text-xs text-muted-foreground font-normal">
              {fmtDay(mc.starts_on, SHORT)}
              {' – '}
              {fmtDay(mc.ends_on, SHORT)}
            </span>
            {mc.id === todayWeekId && (
              <Badge className="text-[10px] h-5 shrink-0">Esta semana</Badge>
            )}
            <span className="text-xs text-muted-foreground font-normal">
              {sessionCount === 1 ? '1 sesión' : `${sessionCount} sesiones`}
            </span>
            {trainingDays.length > 0 && (
              <Badge variant="outline" className="text-[10px] h-5 shrink-0">
                Adherencia {daysWithRpe.length}/{trainingDays.length}
              </Badge>
            )}
          </span>
        </AccordionTrigger>
        <AccordionContent className="space-y-3">
          <div className="space-y-1.5">
            {visibleDates.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-1 py-2">
                {readOnly ? 'Sin sesiones planificadas esta semana.' : 'Todavía no hay sesiones esta semana.'}
              </p>
            )}
            {visibleDates.map((date) => {
              const day = mcDays.find((d: any) => d.day_date === date);
              const looseHere = loose.byDate.get(date) || [];
              const looseRows = looseHere.map((session: any) => (
                <div key={session.id} className="flex items-center gap-2 px-2 py-1.5 text-xs border-t bg-amber-500/5">
                  <ClipboardList className="w-3 h-3 text-amber-600 shrink-0" />
                  <button type="button" className="truncate text-left text-muted-foreground hover:underline flex-1 min-w-0" onClick={() => openSession(session)}>
                    {session.objectives || 'Sesión sin objetivo'}
                  </button>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] gap-1 shrink-0 text-muted-foreground"
                      disabled={linkLooseSession.isPending}
                      onClick={() => linkLooseSession.mutate({ sessionId: session.id, microcycleId: mc.id, date, dayId: day?.id })}
                      title="Esta sesión se guardó sin día del mesociclo: engancharla la deja en esta semana"
                    >
                      <Link2 className="w-3 h-3" /> Enganchar
                    </Button>
                  )}
                </div>
              ));
              if (!day) {
                return (
                  <div key={date} className="rounded-md border border-dashed overflow-hidden">
                    <div className="p-2 text-xs text-muted-foreground capitalize">
                      {fmtDay(date, { weekday: 'short', day: 'numeric' })}
                    </div>
                    {looseRows}
                  </div>
                );
              }
              // Un día admite cualquier cantidad de sesiones (§8.2 — ej.
              // gimnasio AM + cancha PM), no una sola.
              const daySessions = sessionsByDayId.get(day.id) || [];
              const mdLabels = mdLabelsByDate?.[day.day_date] || [];
              // H2 (spec periodización §3.3/D6): el rótulo del día
              // contradice su contenido. Se compara contra el RPE REAL de
              // una sesión ya evaluada cuando existe -- si ninguna tiene RPE
              // cargado todavía, se usa el planeado. Aviso, nunca bloqueo.
              const dayRpe = daySessions.reduce((acc: number | null, s: any) => {
                const actual = s.evaluation?.rpe;
                return typeof actual === 'number' ? actual : acc;
              }, null as number | null) ?? day.planned_rpe ?? null;
              const labelContradicesContent = day.day_type === 'regenerativo' && dayRpe != null && dayRpe > 4;
              return (
                <div key={day.id} className="rounded-md border overflow-hidden">
                  <div className="flex items-center justify-between gap-2 p-2 text-sm">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="text-xs text-muted-foreground w-16 shrink-0 capitalize">
                        {fmtDay(day.day_date, { weekday: 'short', day: 'numeric' })}
                      </span>
                      <Badge variant="outline" className={`text-[10px] h-5 shrink-0 ${DAY_TYPE_BADGE[day.day_type] || ''}`}>
                        {DAY_TYPE_LABEL[day.day_type] || day.day_type}
                      </Badge>
                      {mdLabels.map((l) => (
                        <Badge key={l} variant="outline" className="text-[10px] h-5 shrink-0">
                          {l}
                        </Badge>
                      ))}
                      {labelContradicesContent && (
                        <Badge variant="destructive" className="text-[10px] h-5 shrink-0" title="Regenerativo con RPE alto — el contenido no coincide con el rótulo del día">
                          RPE {dayRpe} en día regenerativo
                        </Badge>
                      )}
                      {daySessions.length === 0 && day.focus && (
                        <span className="truncate text-xs text-muted-foreground">{day.focus}</span>
                      )}
                    </div>
                    {day.planned_rpe != null && (
                      <span className="text-xs text-muted-foreground shrink-0">RPE {day.planned_rpe}</span>
                    )}
                  </div>
                  {daySessions.map((session: any) => sessionRow(session))}
                  {looseRows}
                </div>
              );
            })}
          </div>

          {!readOnly && (
            addingDayFor === mc.id ? (
              <div className="flex flex-wrap items-end gap-2 p-2 rounded-md border bg-muted/30">
                <div className="space-y-1">
                  <Label className="text-[10px]">Fecha</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={`h-8 w-36 justify-start text-left font-normal text-xs bg-background border-input ${!newDay.day_date ? 'text-muted-foreground' : ''}`}
                      >
                        <Calendar className="mr-1.5 h-3.5 w-3.5 opacity-75 shrink-0" />
                        {newDay.day_date ? format(new Date(newDay.day_date + 'T12:00:00'), 'd MMM', { locale: es }) : <span>Elegir</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0 rounded-xl border-border/60 shadow-xl" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={newDay.day_date ? new Date(newDay.day_date + 'T12:00:00') : undefined}
                        onSelect={(date) => date && setNewDay({ ...newDay, day_date: format(date, 'yyyy-MM-dd') })}
                        locale={es}
                        initialFocus
                        fromDate={new Date(mc.starts_on + 'T00:00:00')}
                        toDate={new Date(mc.ends_on + 'T00:00:00')}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">Tipo</Label>
                  <Select value={newDay.day_type} onValueChange={(v) => setNewDay({ ...newDay, day_type: v })}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DAY_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">Intensidad (0-10)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    className="h-8 w-24"
                    value={newDay.planned_rpe}
                    onChange={(e) => setNewDay({ ...newDay, planned_rpe: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px]">Duración (min)</Label>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 w-24"
                    value={newDay.planned_minutes}
                    onChange={(e) => setNewDay({ ...newDay, planned_minutes: e.target.value })}
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!newDay.day_date || createDay.isPending}
                  onClick={() => createDay.mutate({ microcycleId: mc.id, day: newDay })}
                >
                  Guardar
                </Button>
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setAddingDayFor(null)}>
                  Cancelar
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                {/* Un solo botón por semana (antes: uno por cada día vacío). */}
                <Popover open={pickingDateFor === mc.id} onOpenChange={(o) => setPickingDateFor(o ? mc.id : null)}>
                  <PopoverTrigger asChild>
                    <Button size="sm" className="gap-1.5 h-8 text-xs" disabled={createDayForSession.isPending}>
                      <Plus className="w-3.5 h-3.5" />
                      Agregar sesión
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 p-2" align="start">
                    <p className="text-xs font-medium px-1 pb-2">¿Qué día?</p>
                    <div className="grid grid-cols-2 gap-1">
                      {weekDates.map((date) => {
                        const day = mcDays.find((d: any) => d.day_date === date);
                        const n = day ? (sessionsByDayId.get(day.id) || []).length : 0;
                        return (
                          <Button
                            key={date}
                            variant="outline"
                            size="sm"
                            className="h-8 justify-between text-xs capitalize"
                            onClick={() => addSessionOn(mc, date)}
                          >
                            {fmtDay(date, { weekday: 'short', day: 'numeric' })}
                            {day && day.day_type !== 'entrenamiento' ? (
                              <span className="text-[10px] text-muted-foreground normal-case">{DAY_TYPE_LABEL[day.day_type]}</span>
                            ) : n > 0 ? (
                              <span className="text-[10px] text-muted-foreground normal-case">{n}</span>
                            ) : null}
                          </Button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" aria-label="Más acciones de la semana">
                      <MoreHorizontal className="w-4 h-4" />
                      Más
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setAddingDayFor(mc.id)}>
                      <CalendarPlus className="w-4 h-4 mr-2" />
                      Planificar un día (partido, descanso…)
                    </DropdownMenuItem>
                    {idx > 0 && (
                      <DropdownMenuItem
                        disabled={duplicatePreviousWeek.isPending}
                        onClick={() => duplicatePreviousWeek.mutate({ sourceMicrocycleId: weeks[idx - 1].id, targetMicrocycleId: mc.id })}
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Duplicar semana anterior
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          )}
        </AccordionContent>
      </AccordionItem>
    );
  };

  return (
    <div className="space-y-4">
      {/* ── Encabezado ─────────────────────────────────────────────────── */}
      <Card className="border-border/40 bg-background/50 backdrop-blur-sm shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <CalendarRange className="w-4 h-4 text-primary shrink-0" />
                Mesociclo — {fmtDay(mesocycle.starts_on, SHORT)}
                {' → '}
                {fmtDay(mesocycle.ends_on, SHORT)}
              </CardTitle>
              {(mesocycles?.length ?? 0) > 1 && (
                <Select value={mesocycle.id} onValueChange={setSelectedMesoId}>
                  <SelectTrigger className="h-8 w-56 mt-2 text-xs" aria-label="Ver otro mesociclo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(mesocycles || []).map((m: any) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        {fmtDay(m.starts_on, SHORT)} → {fmtDay(m.ends_on, { day: 'numeric', month: 'short', year: 'numeric' })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <MesocycleExportButton mesocycleId={mesocycle.id} mesocycle={mesocycle} teamName={teamName || 'Equipo'} />
              {!readOnly && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 w-8 p-0" aria-label="Acciones del mesociclo">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => { setFormMode('create'); setFormOpen(true); }}>
                      <Plus className="w-4 h-4 mr-2" />
                      Nuevo mesociclo
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => { setFormMode('edit'); setFormOpen(true); }}>
                      <Pencil className="w-4 h-4 mr-2" />
                      Editar
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 className="w-4 h-4 mr-2" />
                      Eliminar
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          {objective && (
            <CardDescription className="mt-1 flex items-start gap-1.5">
              <Target className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className={objectiveExpanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}>{objective}</span>
            </CardDescription>
          )}
          {objectiveExpanded && mesocycle.game_model && (
            <div className="mt-2">
              <Badge variant="secondary" className="mb-1.5">Modelo de juego</Badge>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{mesocycle.game_model}</p>
            </div>
          )}
          {objectiveIsLong && (
            <button
              type="button"
              className="text-xs text-primary hover:underline self-start mt-1"
              onClick={() => setObjectiveExpanded((v) => !v)}
            >
              {objectiveExpanded
                ? 'Ver menos'
                : !mesocycle.game_model
                  ? 'Ver más'
                  : objective.length > LONG_TEXT
                    ? 'Ver objetivo completo y modelo de juego'
                    : 'Ver modelo de juego'}
            </button>
          )}
        </CardHeader>
      </Card>

      {/* ── Pestañas ───────────────────────────────────────────────────── */}
      <Tabs defaultValue="plan" className="space-y-3">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            <TabsTrigger value="plan">Plan</TabsTrigger>
            <TabsTrigger value="carga">Carga</TabsTrigger>
            <TabsTrigger value="rubrica">Rúbrica</TabsTrigger>
            <TabsTrigger value="cierre">Cierre</TabsTrigger>
            <TabsTrigger value="documentos">Documentos</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="plan" className="space-y-4 mt-0">
          {weeks.length > 0 ? (
            // key: al cambiar de mesociclo vuelve a abrir solo su semana actual.
            <Accordion
              key={mesocycle.id}
              type="multiple"
              defaultValue={currentWeekId ? [currentWeekId] : []}
              className="rounded-lg border bg-background/50"
            >
              {weeks.map((mc, idx) => renderWeek(mc, idx))}
            </Accordion>
          ) : (
            <p className="text-sm text-muted-foreground">Este mesociclo no tiene semanas.</p>
          )}

          {loose.outside.length > 0 && (
            // Sesiones sueltas fuera de este mesociclo (de otro mes, o de antes de
            // planificar). Antes no se veían en ningún lado con mesociclo creado.
            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Sesiones sin semana ({loose.outside.length})</CardTitle>
                <CardDescription className="text-xs">
                  {readOnly
                    ? 'Guardadas sin día de mesociclo.'
                    : 'Guardadas sin día de mesociclo. Ábrelas para revisarlas o cambiarles la fecha.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {[...loose.outside].sort((a: any, b: any) => b.session_date.localeCompare(a.session_date)).map((session: any) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => openSession(session)}
                    className="w-full flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs text-left hover:bg-accent/40"
                  >
                    <span className="w-24 shrink-0 text-muted-foreground capitalize">{fmtDay(session.session_date, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                    <span className="truncate">{session.objectives || 'Sesión sin objetivo'}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="carga" className="space-y-3 mt-0">
          {loadWeek ? (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Semana">
                {weeks.map((mc, idx) => (
                  <Button
                    key={mc.id}
                    size="sm"
                    variant={mc.id === loadWeek.id ? 'default' : 'outline'}
                    className="h-8 text-xs"
                    onClick={() => setLoadWeekId(mc.id)}
                  >
                    Semana {idx + 1}
                    <span className="ml-1.5 opacity-70">{fmtDay(mc.starts_on, SHORT)}</span>
                  </Button>
                ))}
              </div>
              <MicrocycleLoadPanel microcycleId={loadWeek.id} />
              <WeeklyLoadPanel microcycleId={loadWeek.id} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Este mesociclo no tiene semanas.</p>
          )}
        </TabsContent>

        <TabsContent value="rubrica" className="mt-0">
          <MesocycleRubricTable
            mesocycleId={mesocycle.id}
            schoolId={schoolId}
            evaluationMode={mesocycle.evaluation_mode}
            roster={roster}
            readOnly={readOnly}
          />
        </TabsContent>

        {/* forceMount: cambiar de pestaña no debe tirar lo escrito sin guardar. */}
        <TabsContent value="cierre" forceMount className="space-y-4 mt-0 data-[state=inactive]:hidden">
          <Card className="border-border/40 bg-background/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold">Cierre del mesociclo</CardTitle>
              <CardDescription className="text-xs">Balance del mes y notas para el siguiente.</CardDescription>
            </CardHeader>
            <CardContent>
              <ClosingForm
                key={mesocycle.id}
                fields={MESO_CLOSING_FIELDS}
                saved={{
                  strengths: closing.strengths || '',
                  areas_to_improve: closing.areas_to_improve || '',
                  next_cycle_notes: closing.next_cycle_notes || '',
                }}
                readOnly={readOnly}
                onSave={(values) => updateClosingReview.mutateAsync(values)}
              />
            </CardContent>
          </Card>

          {weeks.map((mc) => (
            <Card key={mc.id} className="border-border/40 bg-background/50 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold">
                  Cierre de la semana {weekIndex(mc.id) + 1}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {fmtDay(mc.starts_on, SHORT)} – {fmtDay(mc.ends_on, SHORT)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ClosingForm
                  fields={WEEK_CLOSING_FIELDS}
                  gridClassName="grid grid-cols-1 sm:grid-cols-3 gap-3"
                  saved={{
                    objective_compliance: mc.objective_compliance || '',
                    collective_performance: mc.collective_performance || '',
                    improvement_notes: mc.improvement_notes || '',
                  }}
                  readOnly={readOnly}
                  onSave={(values) => updateMicrocycleClosing.mutateAsync({ id: mc.id, ...values })}
                />
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="documentos" className="mt-0">
          {/* Staff (dueño incluido) puede ver, descargar y subir; borra quien
              subió o la administración (RLS 20261008154654). */}
          <MesocycleDocuments mesocycleId={mesocycle.id} schoolId={schoolId} canDeleteAny={canDeleteAnyDoc} />
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <MesocycleFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          onSubmit={(data) => (formMode === 'edit' ? updateMesocycle.mutate(data) : createMesocycle.mutate(data))}
          teamId={teamId}
          isLoading={createMesocycle.isPending || updateMesocycle.isPending}
          mesocycle={formMode === 'edit' ? mesocycle : null}
          // Nuevo: arranca el día después del último y hereda modelo de juego,
          // sesiones planeadas y duración del actual (el coach los ajusta).
          suggestedStart={formMode === 'create' ? suggestNextStart(mesocycles || [], todayColombia()) : undefined}
          template={formMode === 'create' ? mesocycle : undefined}
        />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar este mesociclo?</AlertDialogTitle>
            <AlertDialogDescription>
              Se borran sus semanas, días, la rúbrica de evaluación y los documentos adjuntos. Las sesiones de
              contenido ya creadas NO se eliminan, solo pierden el enganche al día. Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMesocycle.isPending}
              onClick={() => deleteMesocycle.mutate()}
            >
              Eliminar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {sessionDialogDay && !readOnly && (
        <SessionFormDialog
          open={!!sessionDialogDay}
          onOpenChange={(open) => { if (!open) setSessionDialogDay(null); }}
          onSubmit={(data) => createSessionForDay.mutate({ ...data, team_id: teamId, session_date: sessionDialogDay.day_date, dayId: sessionDialogDay.id })}
          teamId={teamId}
          teamName={teamName}
          isFootball={isFootball}
          hasTacticalBoard={hasTacticalBoard}
          teamSport={teamSport}
          isLoading={createSessionForDay.isPending}
          session={sessionDialogSession}
        />
      )}
    </div>
  );
}
