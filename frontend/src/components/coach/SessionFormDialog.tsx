import { useState, useEffect } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { z } from 'zod';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ClipboardList, Plus, Trash2, Star, Calendar, BookOpen, Presentation, ChevronDown, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { TacticalBoard } from '@/components/school/TacticalBoard';
import { ExerciseLibraryPanel } from '@/components/school/ExerciseLibraryPanel';
import { insertExerciseIntoSession, isExerciseSport, type TrainingExercise } from '@/lib/school/exerciseLibrary';
import { logTacticalEvent } from '@/lib/school/tacticalUsage';
import { useTeamTacticalSport } from '@/hooks/useTeamTacticalSport';
import { useToast } from '@/hooks/use-toast';
import type { TacticalSport } from '@/lib/school/tacticalSports';
import { sessionFormLayout } from '@/lib/school/sessionFormLayout';
import { supabase } from '@/integrations/supabase/client';

const sessionSchema = z.object({
  session_date: z.string().min(1, 'Fecha es requerida'),
  objectives: z.string().min(3, 'Objetivos son requeridos'),
  warmup: z.string().optional(),
  materials: z.string().optional(),
  notes: z.string().optional(),
  game_principles: z.string().optional(),
});

type SessionFormData = z.infer<typeof sessionSchema>;

interface Drill {
  name: string;
  focus: string;
  duration: string;
}

/** Bloque de sesión de fútbol (Excel "Sesión Diaria", Club Carmel). Editable
 *  por el coach: no son partes fijas, solo se sugieren como punto de partida.
 *
 *  `id`: identidad propia del bloque para poder engancharle un tablero
 *  táctico (match_lineups.source_id, con sourceType='training_session').
 *  Se genera en el momento en que el coach toca "Tablero táctico" por
 *  primera vez en ESE bloque (ver ensureBlockId más abajo) -- nunca al
 *  crear el bloque, porque la plantilla/el botón "Agregar Bloque" se
 *  reusan para VARIAS sesiones distintas y un id fijo ahí colisionaría
 *  entre sesiones. Opcional a propósito: bloques viejos guardados antes
 *  de esto no tienen id hasta que se abre su tablero por primera vez. */
/** técnico/táctico/físico/mixto — spec periodización §3.5: lo único que la
 *  grilla del Excel de Carmel pedía y CAR-8 no había sumado todavía. Sin
 *  CHECK en la base (vive dentro del jsonb de session_blocks), opcional. */
type BlockComponent = 'tecnico' | 'tactico' | 'fisico' | 'arqueros' | 'mixto';

interface SessionBlock {
  id?: string;
  name: string;
  minutes: string;
  activity: string;
  objective: string;
  description: string;
  component?: BlockComponent | '';
  /** Ejercicio de la biblioteca (pizarra T3) del que salió el bloque. Solo
   *  trazabilidad: la jugada ya quedó copiada en match_lineups del bloque. */
  exercise_id?: string;
}

const BLOCK_COMPONENT_OPTIONS: { value: BlockComponent; label: string }[] = [
  { value: 'tecnico', label: 'Técnico' },
  { value: 'tactico', label: 'Táctico' },
  { value: 'fisico', label: 'Físico' },
  { value: 'arqueros', label: 'Arqueros' },
  { value: 'mixto', label: 'Mixto' },
];

const FOOTBALL_BLOCK_TEMPLATE: SessionBlock[] = [
  { name: 'Calentamiento', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Parte 1 — Introductorio', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Parte 2 — Situacional', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Parte 3 — Evaluativo', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Vuelta a la calma', minutes: '', activity: '', objective: '', description: '', component: '' },
];

/** Bloques de arranque para los demás deportes de pizarra (voleibol,
 *  baloncesto, balonmano, futsal): sin la estructura del Excel de fútbol.
 *  El calentamiento va en su propio campo, como antes. */
const GENERIC_BLOCK_TEMPLATE: SessionBlock[] = [
  { name: 'Parte principal — Técnica', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Parte principal — Juego', minutes: '', activity: '', objective: '', description: '', component: '' },
  { name: 'Vuelta a la calma', minutes: '', activity: '', objective: '', description: '', component: '' },
];

/** Copia de los bloques: la plantilla es una constante del módulo y los de una
 *  sesión vienen del caché de react-query; editarlos en el lugar ensuciaba la
 *  plantilla de la próxima sesión nueva y el caché. */
const copyBlocks = (list: SessionBlock[]): SessionBlock[] => list.map((b) => ({ ...b }));

/** Escribe en la base el id recién generado de un bloque de una sesión YA
 *  guardada. Sin esto el id vivía solo en el formulario: la jugada se guardaba
 *  en la pizarra colgada de ese id, pero si el coach salía o recargaba sin
 *  «Actualizar sesión», el bloque volvía sin id, recibía otro nuevo y la
 *  pizarra abría vacía (12 jugadas huérfanas medidas el 2026-10-29).
 *  Ubica el bloque por posición + nombre (el local o el guardado); si no lo
 *  encuentra (bloque recién agregado y sin guardar) devuelve false. */
async function persistBlockId(sessionId: string, index: number, names: string[], id: string): Promise<boolean> {
  const { data, error } = await supabase.from('training_sessions').select('session_blocks').eq('id', sessionId).single();
  if (error) throw error;
  const saved = (Array.isArray(data?.session_blocks) ? [...data.session_blocks] : []) as unknown as SessionBlock[];
  const free = (b: SessionBlock | undefined, name: string) => !!b && !b.id && (b.name ?? '') === name;
  let at = names.some((n) => free(saved[index], n)) ? index : -1;
  if (at < 0) at = saved.findIndex((b) => names.some((n) => free(b, n)));
  if (at < 0) return false;
  saved[at] = { ...saved[at], id };
  const { error: upErr } = await supabase.from('training_sessions').update({ session_blocks: saved as any }).eq('id', sessionId);
  if (upErr) throw upErr;
  return true;
}

type ObjectivesMet = 'si' | 'parcial' | 'no';

interface Evaluation {
  objectives_met?: ObjectivesMet;
  team_rating?: number;
  highlights?: string;
  improvements?: string;
  /** RPE de sesión (0-10, escala de Borg/sRPE de Foster) — carga real de la
   *  sesión, no la planeada. Lo lee `v_session_load` para calcular UA
   *  (spec periodización §3.3, D4). Sin este dato el módulo de carga queda
   *  vacío (R1) — por eso vive acá, junto a lo demás que el coach completa
   *  al cerrar la sesión, no en un formulario aparte. */
  rpe?: number;
}

interface SessionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    team_id: string;
    session_date: string;
    objectives: string;
    warmup?: string;
    drills?: Drill[];
    materials?: string;
    notes?: string;
    game_principles?: string;
    session_blocks?: SessionBlock[];
    evaluation?: Evaluation;
  }) => void;
  teamId: string;
  /** Solo para el contexto del tablero táctico por bloque (título del modal
   *  fullscreen) -- no se usa para nada más acá. */
  teamName?: string;
  /** Solo fútbol ve principios de juego, evaluación post-sesión y la
   *  plantilla de bloques del Excel "Sesión Diaria Fútbol C.C.C" (Club Carmel). */
  isFootball?: boolean;
  /** D3: deporte con pizarra completa → bloques con «Tablero táctico» y
   *  «Desde la biblioteca». Sin el prop vale lo mismo que isFootball. */
  hasTacticalBoard?: boolean;
  /** Deporte de la pizarra del equipo (sportFromTeam): filtro inicial de la
   *  Biblioteca de ejercicios. */
  teamSport?: TacticalSport;
  isLoading?: boolean;
  session?: any;
}

export function SessionFormDialog({
  open,
  onOpenChange,
  onSubmit,
  teamId,
  teamName,
  isFootball,
  hasTacticalBoard,
  teamSport,
  isLoading,
  session = null
}: SessionFormDialogProps) {
  const layout = sessionFormLayout({ isFootball, hasTacticalBoard, teamSport, session });
  const blockTemplate = layout.blockTemplate === 'futbol' ? FOOTBALL_BLOCK_TEMPLATE : GENERIC_BLOCK_TEMPLATE;
  const [drills, setDrills] = useState<Drill[]>([{ name: '', focus: '', duration: '' }]);
  const [blocks, setBlocks] = useState<SessionBlock[]>(() => copyBlocks(blockTemplate));
  // En una sesión NUEVA, ¿ya se abrió la pizarra o la biblioteca de algún
  // bloque? Cerrar sin «Crear sesión» deja esas jugadas sin sesión: se avisa.
  const [boardUsedUnsaved, setBoardUsedUnsaved] = useState(false);
  const [evaluation, setEvaluation] = useState<Evaluation>({});
  // Bloque desplegado (uno a la vez, el resto queda como fila resumen) y
  // evaluación plegada: así el formulario no es un scroll interminable.
  const [openBlock, setOpenBlock] = useState<number | null>(0);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  // Índice del bloque cuyo tablero táctico está abierto (no el id -- el id
  // puede no existir todavía, ver ensureBlockId más abajo).
  const [tacticalBlockIndex, setTacticalBlockIndex] = useState<number | null>(null);
  // Índice del bloque para el que está abierta la biblioteca de ejercicios.
  const [libraryBlockIndex, setLibraryBlockIndex] = useState<number | null>(null);
  const [applyingExercise, setApplyingExercise] = useState(false);
  const { toast } = useToast();
  // Métrica T0 (library_insert): la escuela del EQUIPO, igual que la pizarra.
  const { schoolId: teamSchoolId } = useTeamTacticalSport(teamId, { enabled: open });
  // Con la pizarra o la biblioteca abiertas, el Dialog de la sesión se oculta
  // (ver el comentario del <Dialog> de abajo: dos Dialogs de Radix abiertos a
  // la vez se cierran solos).
  const childDialogOpen = tacticalBlockIndex !== null || libraryBlockIndex !== null;

  const form = useForm<SessionFormData>({
    resolver: zodResolver(sessionSchema),
    defaultValues: {
      session_date: todayColombia(),
      objectives: '',
      warmup: '',
      materials: '',
      notes: '',
      game_principles: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    if (session) {
      form.reset({
        session_date: session.session_date,
        objectives: session.objectives,
        warmup: session.warmup || '',
        materials: session.materials || '',
        notes: session.notes || '',
        game_principles: session.game_principles || '',
      });
      setDrills(session.drills && session.drills.length > 0 ? session.drills : [{ name: '', focus: '', duration: '' }]);
      setBlocks(copyBlocks(session.session_blocks && session.session_blocks.length > 0 ? session.session_blocks : blockTemplate));
      setEvaluation(session.evaluation || {});
      setEvaluationOpen(Object.values(session.evaluation || {}).some((v) => v !== undefined && v !== ''));
    } else {
      form.reset({
        session_date: todayColombia(),
        objectives: '',
        warmup: '',
        materials: '',
        notes: '',
        game_principles: '',
      });
      setDrills([{ name: '', focus: '', duration: '' }]);
      setBlocks(copyBlocks(blockTemplate));
      setEvaluation({});
      setEvaluationOpen(false);
    }
    setOpenBlock(0);
    setBoardUsedUnsaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, session]);

  const addDrill = () => setDrills([...drills, { name: '', focus: '', duration: '' }]);
  const removeDrill = (index: number) => setDrills(drills.filter((_, i) => i !== index));
  const updateDrill = (index: number, field: keyof Drill, value: string) => {
    const updated = [...drills];
    updated[index][field] = value;
    setDrills(updated);
  };

  const addBlock = () => {
    setBlocks([...blocks, { name: '', minutes: '', activity: '', objective: '', description: '', component: '' }]);
    setOpenBlock(blocks.length);
  };
  const removeBlock = (index: number) => {
    setBlocks(blocks.filter((_, i) => i !== index));
    setOpenBlock((prev) => (prev === null || prev < index ? prev : prev === index ? null : prev - 1));
  };
  const totalMinutes = blocks.reduce((sum, b) => sum + (parseInt(b.minutes, 10) || 0), 0);
  const updateBlock = (index: number, field: keyof SessionBlock, value: any) => {
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, [field]: value } : b)));
  };

  /** Id del bloque para colgarle la jugada: el que ya tiene o uno nuevo. Si la
   *  sesión ya existe, el nuevo se escribe en la base AL MOMENTO (ver
   *  persistBlockId); si es una sesión nueva, viaja con «Crear sesión». */
  const ensureBlockId = (index: number) => {
    const block = blocks[index];
    if (!block || block.id) return;
    const id = crypto.randomUUID();
    setBlocks((prev) => prev.map((b, i) => (i === index ? { ...b, id } : b)));
    if (!session?.id) {
      setBoardUsedUnsaved(true);
      return;
    }
    const original = (session.session_blocks as SessionBlock[] | undefined)?.[index]?.name ?? '';
    persistBlockId(session.id, index, [block.name ?? '', original], id)
      .then((ok) => {
        if (!ok) toast({ title: 'Toca «Actualizar sesión» al terminar', description: 'Así la jugada queda guardada en este bloque.' });
      })
      .catch(() => toast({ title: 'No se pudo enlazar la jugada al bloque', description: 'Toca «Actualizar sesión» al terminar para no perderla.', variant: 'destructive' }));
  };

  /** Cerrar el formulario: en una sesión nueva con jugadas hechas, confirmar. */
  const requestClose = () => {
    if (boardUsedUnsaved && !window.confirm('Todavía no creas la sesión. Si sales ahora, las jugadas de la pizarra quedan sin sesión. ¿Salir igual?')) return;
    onOpenChange(false);
  };

  /** Abre el tablero táctico de un bloque, generándole un id propio primero
   *  si todavía no tiene uno (bloque recién creado, o uno viejo guardado
   *  antes de que esto existiera). El id queda en el estado local del
   *  formulario -- se persiste como parte del bloque al guardar la sesión
   *  (handleSubmit ya manda session_blocks completo, id incluido). */
  const openBlockTacticalBoard = (index: number) => {
    ensureBlockId(index);
    // setTimeout, no directo: TacticalBoard es OTRO <Dialog> de Radix, montado
    // desde un botón que vive DENTRO del <Dialog> de esta sesión. Si se abre
    // en el mismo tick del click, el detector de "click afuera" del diálogo
    // nuevo llega a tiempo de ver ESE MISMO click como un click hacia afuera
    // suyo -- se abre y se cierra solo en el mismo gesto ("abre y cierra
    // automáticamente"). Diferido un tick, el tablero se monta después de que
    // el click ya terminó de procesarse del todo.
    setTimeout(() => setTacticalBlockIndex(index), 0);
  };

  /** «Desde la biblioteca»: igual que el tablero, el bloque necesita su id
   *  ANTES (la jugada del ejercicio se cuelga de él) y el panel se abre
   *  diferido un tick para que el click no lo cierre en el mismo gesto. */
  const openBlockLibrary = (index: number) => {
    ensureBlockId(index);
    setTimeout(() => setLibraryBlockIndex(index), 0);
  };

  /** Aplica el ejercicio elegido al bloque:
   *  1. En el formulario completa SOLO los campos vacíos (nunca pisa lo que el
   *     coach escribió) y guarda exercise_id en el bloque.
   *  2. En la base, por la RPC transaccional insert_exercise_into_session_block:
   *     · sesión YA guardada (session.id): completa el bloque en
   *       session_blocks y arma la jugada del bloque (match_lineups) en una
   *       sola transacción;
   *     · sesión NUEVA (todavía sin id): no hay sesión que actualizar, así que
   *       se manda team_id y la RPC arma solo la jugada del bloque, colgada del
   *       id del bloque — exactamente lo que ya hace el tablero táctico cuando
   *       se abre sobre un bloque de una sesión sin guardar. Los textos del
   *       bloque viajan con «Crear Sesión» (handleSubmit manda session_blocks
   *       completo, exercise_id incluido). Así no hace falta un paso "después
   *       de guardar": onSubmit no devuelve el id de la sesión creada (lo crean
   *       TrainingPlansPage / MesocycleSection). */
  const applyExercise = async (exercise: TrainingExercise) => {
    const index = libraryBlockIndex;
    const blockId = index !== null ? blocks[index]?.id : undefined;
    if (index === null || !blockId) return;
    setApplyingExercise(true);
    try {
      await insertExerciseIntoSession(exercise.id, {
        block_id: blockId,
        session_id: session?.id ?? null,
        team_id: teamId,
      });
      logTacticalEvent({
        schoolId: teamSchoolId, event: 'library_insert', teamId, sourceType: 'session_block', sport: exercise.sport,
      });
      const fill =(current: string | undefined, value: string | null | undefined) =>
        current && current.trim() !== '' ? current : (value ?? '');
      setBlocks((prev) => prev.map((b, i) => (i !== index ? b : {
        ...b,
        name: fill(b.name, exercise.name),
        activity: fill(b.activity, exercise.name),
        minutes: fill(b.minutes, exercise.minutes != null ? String(exercise.minutes) : ''),
        objective: fill(b.objective, exercise.objective),
        description: fill(b.description, exercise.description),
        exercise_id: exercise.id,
      })));
      setLibraryBlockIndex(null);
      toast({
        title: 'Ejercicio agregado al bloque',
        description: `"${exercise.name}" con su jugada. Ábrela con el botón de la pizarra para asignar jugadores.`,
      });
    } catch (err: unknown) {
      toast({ title: 'No se pudo usar el ejercicio', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setApplyingExercise(false);
    }
  };

  const resetLocalState = () => {
    setDrills([{ name: '', focus: '', duration: '' }]);
    setBlocks(copyBlocks(blockTemplate));
    setEvaluation({});
    setBoardUsedUnsaved(false);
  };

  const handleSubmit = (data: SessionFormData) => {
    const validDrills = drills.filter(d => d.name.trim() !== '');
    const validBlocks = blocks.filter(b => b.name.trim() !== '');
    const hasEvaluation = Object.values(evaluation).some(v => v !== undefined && v !== '');

    onSubmit({
      team_id: teamId,
      session_date: data.session_date,
      objectives: data.objectives,
      warmup: data.warmup || undefined,
      materials: data.materials || undefined,
      notes: data.notes || undefined,
      ...(layout.editor === 'blocks'
        ? {
            ...(layout.showGamePrinciples ? { game_principles: data.game_principles || undefined } : {}),
            session_blocks: validBlocks.length > 0 ? validBlocks : undefined,
            ...(layout.showEvaluation ? { evaluation: hasEvaluation ? evaluation : undefined } : {}),
          }
        : {
            drills: validDrills.length > 0 ? validDrills : undefined,
          }),
    });
    form.reset();
    resetLocalState();
    onOpenChange(false);
  };

  return (
    <>
    <Dialog open={open && !childDialogOpen} onOpenChange={(o) => { if (o) onOpenChange(true); else requestClose(); }}>
      {/* Mientras el tablero táctico está abierto, este Dialog se oculta (open=false)
       *  en vez de quedar montado y abierto AL MISMO TIEMPO que el Dialog del tablero.
       *  Dos Dialogs de Radix abiertos a la vez compiten por el mismo FocusScope/
       *  DismissableLayer -- eso era lo que hacía que el tablero se cerrara solo
       *  segundos después de abrir, sin ningún click real de por medio. El estado del
       *  formulario (blocks, etc.) vive en este componente, no en el Dialog, así que
       *  ocultarlo no pierde nada: reaparece igual como estaba al cerrar el tablero. */}
      <DialogContent
        // Encabezado y botones fijos; solo el cuerpo hace scroll.
        className="max-w-4xl max-h-[92vh] p-0 gap-0 flex flex-col overflow-hidden"
        // Mientras tacticalBlockIndex !== null, este Dialog ya está en camino a
        // open=false (ver arriba) pero sigue MONTADO durante su animación de
        // salida (Tailwind animate-out, ~200ms). En esa ventana, el Dialog del
        // tablero táctico monta y le roba el foco (auto-focus de Radix al
        // abrir) -- este Dialog interpreta ESE cambio de foco como "el usuario
        // interactuó afuera" y llama a su propio onOpenChange(false), que en
        // MesocycleSection vacía `sessionDialogDay` y desmonta TODO el árbol
        // (este Dialog + el tablero) de un golpe, sin animación -- eso es lo
        // que se veía como "se cierran los 2 modales" y dejaba la página
        // trabada (el lock de scroll/pointer-events de dos modales Radix
        // desmontados a la fuerza en el mismo tick no se libera bien). Con el
        // tablero abierto no hay ninguna razón legítima para que ESTE diálogo
        // se autocierre por foco/click/Escape afuera, así que se ignora.
        onPointerDownOutside={(e) => { if (childDialogOpen) e.preventDefault(); }}
        onInteractOutside={(e) => { if (childDialogOpen) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (childDialogOpen) e.preventDefault(); }}
      >
        <DialogHeader className="px-6 pt-5 pb-4 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <ClipboardList className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{session?.id ? 'Editar Sesión de Entrenamiento' : 'Crear Sesión de Entrenamiento'}</DialogTitle>
              <DialogDescription>
                {session?.id ? 'Actualiza los detalles de la sesión de entrenamiento.' : 'Crea una sesión de entrenamiento para tu equipo.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Fecha del Entrenamiento *</Label>
              <Controller
                control={form.control}
                name="session_date"
                render={({ field }) => (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className={`w-full justify-start text-left font-normal bg-background border-input ${
                          !field.value ? 'text-muted-foreground' : ''
                        }`}
                      >
                        <Calendar className="mr-2 h-4 w-4 opacity-75" />
                        {field.value ? (
                          format(new Date(field.value + 'T12:00:00'), 'PPP', { locale: es })
                        ) : (
                          <span>Selecciona una fecha</span>
                        )}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0 rounded-xl border-border/60 shadow-xl" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={field.value ? new Date(field.value + 'T12:00:00') : undefined}
                        onSelect={(date) => date && field.onChange(format(date, 'yyyy-MM-dd'))}
                        locale={es}
                        captionLayout="dropdown-buttons"
                        fromYear={new Date().getFullYear() - 3}
                        toYear={new Date().getFullYear() + 1}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                )}
              />
              {form.formState.errors.session_date && (
                <p className="text-sm text-destructive">{form.formState.errors.session_date.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="materials">Materiales Necesarios</Label>
              <Input
                id="materials"
                placeholder="Ej: Conos, balones, petos"
                {...form.register('materials')}
              />
            </div>
          </div>

          <div className={layout.showGamePrinciples ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : ''}>
          <div className="space-y-2">
            <Label htmlFor="objectives">Objetivo General de la Sesión *</Label>
            <Textarea
              id="objectives"
              placeholder="¿Qué quieres lograr en esta sesión?"
              {...form.register('objectives')}
              rows={2}
            />
            {form.formState.errors.objectives && (
              <p className="text-sm text-destructive">{form.formState.errors.objectives.message}</p>
            )}
          </div>

          {layout.showGamePrinciples && (
            <div className="space-y-2">
              <Label htmlFor="game_principles">Principios de Juego a Trabajar</Label>
              <Textarea
                id="game_principles"
                placeholder="Ej: presión tras pérdida, amplitud en ataque..."
                {...form.register('game_principles')}
                rows={2}
              />
            </div>
          )}
          </div>

          {layout.showWarmup && (
            <div className="space-y-2">
              <Label htmlFor="warmup">Calentamiento</Label>
              <Textarea
                id="warmup"
                placeholder="Describe el calentamiento inicial..."
                {...form.register('warmup')}
                rows={2}
              />
            </div>
          )}

          {layout.editor === 'blocks' ? (
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-2">
                <div>
                  <Label>Bloques de la Sesión</Label>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden />
                    {blocks.length} {blocks.length === 1 ? 'bloque' : 'bloques'}
                    {totalMinutes > 0 && <> · {totalMinutes} min en total</>}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addBlock}>
                  <Plus className="h-4 w-4 mr-1" />
                  Agregar Bloque
                </Button>
              </div>

              <ol className="space-y-2">
                {blocks.map((block, index) => {
                  const isOpen = openBlock === index;
                  const componentLabel = BLOCK_COMPONENT_OPTIONS.find((o) => o.value === block.component)?.label;
                  return (
                  <li
                    key={block.id || index}
                    className={`rounded-xl border transition-colors ${isOpen ? 'border-primary/50 bg-muted/40 dark:bg-muted/20' : 'bg-muted/20 dark:bg-muted/10 hover:bg-muted/40'}`}
                  >
                    {/* Fila resumen: siempre visible. Click despliega/pliega. */}
                    <div className="flex items-center gap-2 p-2 pl-3">
                      <span className={`h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${isOpen ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                        {index + 1}
                      </span>
                      <button
                        type="button"
                        className="flex-1 min-w-0 text-left py-1"
                        onClick={() => setOpenBlock(isOpen ? null : index)}
                        aria-expanded={isOpen}
                      >
                        <span className="block text-sm font-medium truncate">{block.name || 'Bloque sin nombre'}</span>
                        <span className="block text-xs text-muted-foreground truncate">
                          {block.activity || block.objective || 'Toca para completar'}
                        </span>
                      </button>
                      {componentLabel && (
                        <span className="hidden sm:inline-flex shrink-0 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] font-medium">
                          {componentLabel}
                        </span>
                      )}
                      {block.minutes && (
                        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">{block.minutes} min</span>
                      )}
                      {layout.showBoardButtons && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1"
                          onClick={() => openBlockTacticalBoard(index)}
                          title="Abrir la pizarra para este bloque"
                        >
                          {/* Ícono + texto: el ícono solo no se reconocía (ítem 20). */}
                          <Presentation className="h-4 w-4" aria-hidden />
                          <span className="hidden sm:inline">Pizarra</span>
                        </Button>
                      )}
                      {blocks.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0 px-2"
                          onClick={() => removeBlock(index)}
                          aria-label="Quitar bloque"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                      <button
                        type="button"
                        className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground"
                        onClick={() => setOpenBlock(isOpen ? null : index)}
                        aria-label={isOpen ? 'Plegar bloque' : 'Desplegar bloque'}
                      >
                        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                      </button>
                    </div>

                    {isOpen && (
                      <div className="border-t px-3 pb-3 pt-3 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_6rem_10rem] gap-2">
                          <Input
                            placeholder="Nombre del bloque (ej: Calentamiento)"
                            value={block.name}
                            onChange={(e) => updateBlock(index, 'name', e.target.value)}
                            className="font-medium"
                            aria-label="Nombre del bloque"
                          />
                          <Input
                            placeholder="Min"
                            inputMode="numeric"
                            value={block.minutes}
                            onChange={(e) => updateBlock(index, 'minutes', e.target.value)}
                            aria-label="Minutos"
                          />
                          <Select
                            value={block.component || undefined}
                            onValueChange={(v) => updateBlock(index, 'component', v)}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Componente" />
                            </SelectTrigger>
                            <SelectContent>
                              {BLOCK_COMPONENT_OPTIONS.filter((o) => o.value !== 'arqueros' || layout.showGoalkeeperComponent || block.component === 'arqueros').map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
                          <Input
                            placeholder="Actividad / ejercicio"
                            value={block.activity}
                            onChange={(e) => updateBlock(index, 'activity', e.target.value)}
                          />
                          {layout.showLibraryButton && (
                            <Button
                              type="button"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => openBlockLibrary(index)}
                              title="Elegir un ejercicio de la biblioteca para este bloque"
                            >
                              <BookOpen className="h-4 w-4" />
                              {block.exercise_id ? 'Cambiar ejercicio' : 'Desde la biblioteca'}
                            </Button>
                          )}
                        </div>
                        {block.id && !session?.id && layout.showBoardButtons && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            La jugada de la pizarra queda en esta sesión cuando tocas «Crear sesión».
                          </p>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <Textarea
                            placeholder="Objetivo específico"
                            value={block.objective}
                            onChange={(e) => updateBlock(index, 'objective', e.target.value)}
                            rows={3}
                          />
                          <Textarea
                            placeholder="Organización / descripción"
                            value={block.description}
                            onChange={(e) => updateBlock(index, 'description', e.target.value)}
                            rows={3}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Ejercicios</Label>
                  {hasTacticalBoard === false && (
                    <p className="text-xs text-muted-foreground mt-0.5" data-testid="session-no-board-hint">
                      Este deporte aún no tiene pizarra táctica: registra aquí los ejercicios de la sesión.
                    </p>
                  )}
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addDrill}>
                  <Plus className="h-4 w-4 mr-1" />
                  Agregar Ejercicio
                </Button>
              </div>

              <div className="space-y-3">
                {drills.map((drill, index) => (
                  <div key={index} className="p-3 border rounded-lg space-y-3 bg-muted/50 dark:bg-muted/30">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Ejercicio {index + 1}</span>
                      {drills.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeDrill(index)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <Input
                        placeholder="Nombre del ejercicio"
                        value={drill.name}
                        onChange={(e) => updateDrill(index, 'name', e.target.value)}
                      />
                      <Input
                        placeholder="Enfoque (ej: Técnica)"
                        value={drill.focus}
                        onChange={(e) => updateDrill(index, 'focus', e.target.value)}
                      />
                      <Input
                        placeholder="Duración (ej: 15 min)"
                        value={drill.duration}
                        onChange={(e) => updateDrill(index, 'duration', e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="notes">Notas Adicionales</Label>
            <Textarea
              id="notes"
              placeholder="Observaciones, recordatorios..."
              {...form.register('notes')}
              rows={2}
            />
          </div>

          {layout.showEvaluation && (
            <div className="rounded-xl border bg-muted/30 dark:bg-muted/10">
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 p-4 text-left"
                onClick={() => setEvaluationOpen((v) => !v)}
                aria-expanded={evaluationOpen}
              >
                <div>
                  <span className="block text-base font-medium">Evaluación de la Sesión</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Opcional — complétala cuando puedas, incluso después del entrenamiento.
                  </span>
                </div>
                <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${evaluationOpen ? 'rotate-180' : ''}`} />
              </button>

              {evaluationOpen && (
              <div className="border-t p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>¿Se cumplieron los objetivos?</Label>
                <Select
                  value={evaluation.objectives_met}
                  onValueChange={(v) => setEvaluation({ ...evaluation, objectives_met: v as ObjectivesMet })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Selecciona una opción" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="si">Sí</SelectItem>
                    <SelectItem value="parcial">Parcialmente</SelectItem>
                    <SelectItem value="no">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Desempeño del equipo</Label>
                <div className="flex gap-1">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setEvaluation({ ...evaluation, team_rating: n })}
                      className="p-0.5"
                      aria-label={`${n} estrellas`}
                    >
                      <Star
                        className={`h-5 w-5 transition-colors ${
                          (evaluation.team_rating || 0) >= n
                            ? 'fill-amber-500 text-amber-500 dark:fill-amber-400 dark:text-amber-400'
                            : 'text-muted-foreground/40'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Carga de la sesión (RPE 0-10)</Label>
                <p className="text-xs text-muted-foreground -mt-1">
                  0 = reposo, 10 = esfuerzo máximo — es la que alimenta los indicadores de carga semanal.
                </p>
                <Select
                  value={evaluation.rpe !== undefined ? String(evaluation.rpe) : undefined}
                  onValueChange={(v) => setEvaluation({ ...evaluation, rpe: Number(v) })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Sin registrar" />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 11 }, (_, n) => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="highlights">Aspectos destacados</Label>
                <Textarea
                  id="highlights"
                  value={evaluation.highlights || ''}
                  onChange={(e) => setEvaluation({ ...evaluation, highlights: e.target.value })}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="improvements">Aspectos a mejorar</Label>
                <Textarea
                  id="improvements"
                  value={evaluation.improvements || ''}
                  onChange={(e) => setEvaluation({ ...evaluation, improvements: e.target.value })}
                  rows={2}
                />
              </div>
              </div>
              )}
            </div>
          )}
          </div>

          <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background">
            <Button type="button" variant="outline" onClick={requestClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Guardando...' : (session?.id ? 'Actualizar Sesión' : 'Crear Sesión')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    {/* Fullscreen sobre este mismo modal (Radix apila portales sin
        problema) -- se cierra solo, el formulario de la sesión sigue
        intacto debajo con lo que ya se había escrito. */}
    {tacticalBlockIndex !== null && blocks[tacticalBlockIndex]?.id && (
      <TacticalBoard
        open
        onClose={() => setTacticalBlockIndex(null)}
        teamId={teamId}
        teamName={teamName || 'Equipo'}
        sourceType="training_session"
        sourceId={blocks[tacticalBlockIndex]!.id!}
        contextLabel={`Entrenamiento — ${blocks[tacticalBlockIndex]?.name || 'Bloque'}`}
      />
    )}

    {/* Biblioteca de ejercicios (pizarra T3): mismo patrón que el tablero --
        el Dialog de la sesión se oculta mientras el panel está abierto. */}
    {libraryBlockIndex !== null && blocks[libraryBlockIndex]?.id && layout.showLibraryButton && (
      <ExerciseLibraryPanel
        open
        onOpenChange={(o) => { if (!o) setLibraryBlockIndex(null); }}
        onPick={applyExercise}
        pickLabel="Usar en esta sesión"
        defaultSport={isExerciseSport(teamSport) ? teamSport : undefined}
        picking={applyingExercise}
        onPackEvent={(event) => logTacticalEvent({ schoolId: teamSchoolId, event, teamId, sourceType: 'library_packs' })}
      />
    )}
    </>
  );
}
