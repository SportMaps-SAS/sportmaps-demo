/**
 * Sesiones del entrenador — V2 (lienzo «CoaSesiones», docs/specs/entrenador-deportista-v2.md).
 *
 * Hoy · Semana · Plan del mes, con la pizarra por bloque y el MODO CANCHA (letra
 * grande, bloque por bloque, pantalla encendida con Wake Lock).
 *
 * - El coach ve SU semana (sus equipos). En la versión clásica el panel semanal
 *   (WeekSessionsPanel) era solo para la administración (TrainingPlansPage:155/372).
 * - «Plan del mes» lee el mismo plan que MesocycleSection (training_mesocycles,
 *   training_microcycles, training_microcycle_days) con las MISMAS queryKeys, así
 *   que comparte caché con la planificación completa. Aquí solo se lee; crear y
 *   editar sigue en la planificación completa (`rutaPlanificacion`).
 * - La pizarra es TacticalBoard, igual que en la versión clásica: si un bloque no
 *   tiene id propio se le asigna y se guarda antes de abrirla (mismo criterio que
 *   openBlockTacticalBoard de TrainingPlansPage).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast as aviso } from 'sonner';
import { CalendarPlus, ChevronLeft, ChevronRight, Maximize2, MoreHorizontal, Presentation, Repeat, Sun, X, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { todayColombia } from '@/lib/dateUtils';
import { fetchCoachTeams, isSchoolAdminRole } from '@/lib/coachTeamScope';
import { teamBoardAccess } from '@/lib/sports/sportCatalog';
import { leerFranjas } from '@/components/parent/v2/parentHomeLogic';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TacticalBoard } from '@/components/school/TacticalBoard';
import { SessionViewer } from '@/components/school/SessionViewer';
import { fechaHumana } from './asistenciaModel';
import { registrosPorEquipoYDia } from './useAsistenciaV2Data';
import {
  bloquesDeSesion, cargaDeSemana, entrenosDelHorario, estadoDelDia, etiquetaDia, horaCorta, listasEntre, mesDelPlan, nombreMes, objetivoTexto,
  planVigente, rangoSemana, rutaPlanear, semanaActual, semanaDe, textoSemana, type BloqueV2, type EstadoDia, type SemanaPlan,
} from './sesionesModel';
import { useWakeLock, wakeLockDisponible } from './useCoachV2Senal';
import {
  entrenosDelDia, entrenosDelHorarioConAjustes, esFechaIso, etiquetaEstado, horarioTexto, semanasHasta,
  type EquipoSemana, type EstadoEntreno,
} from './semana/semanaAjustesModel';
import { useSemanaAjustes } from './semana/useSemanaAjustes';
import { AjustarEntrenoSheet, type AbrirAjuste } from './semana/AjustarEntrenoSheet';
import { ClasesPruebaDelDia } from './semana/ClasesPruebaDelDia';

/* eslint-disable @typescript-eslint/no-explicit-any -- tablas del plan sin tipar en types.ts (igual que MesocycleSection) */

interface EquipoS { id: string; name: string; sport: string | null; sport_modality: string | null; age_group: string | null; schedule?: unknown }
interface SesionS {
  id: string; team_id: string; session_date: string; objectives: unknown; session_blocks: unknown; warmup: string | null;
  drills: unknown; materials: string | null; evaluation: unknown; microcycle_day_id: string | null;
}

function Segmentado<T extends string>({ opciones, valor, onCambio, etiqueta }: {
  opciones: { v: T; l: string }[]; valor: T; onCambio: (v: T) => void; etiqueta: string;
}) {
  return (
    <div role="tablist" aria-label={etiqueta} className="grid gap-1 rounded-xl bg-muted p-1" style={{ gridTemplateColumns: `repeat(${opciones.length}, minmax(0, 1fr))` }}>
      {opciones.map((o) => (
        <button key={o.v} type="button" role="tab" aria-selected={valor === o.v} onClick={() => onCambio(o.v)}
          className={cn('min-h-touch min-w-0 rounded-lg px-1 text-[clamp(0.625rem,3.6vw,0.875rem)] leading-tight transition-colors',
            valor === o.v ? 'bg-background font-semibold shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground')}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

// ── Datos ────────────────────────────────────────────────────────────────────

function useEquipos() {
  const { user } = useAuth();
  const { schoolId, currentUserRole } = useSchoolContext();
  const admin = isSchoolAdminRole(currentUserRole);
  return useQuery<EquipoS[]>({
    queryKey: ['v2-ses-equipos', schoolId, user?.id, admin],
    enabled: !!schoolId && !!user?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('teams').select('id, name, sport, sport_modality, age_group, schedule').eq('school_id', schoolId);
      if (error) throw error;
      let lista = (data ?? []) as EquipoS[];
      if (!admin) {
        const { teamIds } = await fetchCoachTeams(schoolId!);
        const mios = new Set(teamIds);
        lista = lista.filter((t) => mios.has(t.id));
      }
      return lista.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

function useSesionesRango(teamIds: string[], desde: string, hasta: string) {
  return useQuery<SesionS[]>({
    queryKey: ['v2-ses-rango', teamIds.join(','), desde, hasta],
    enabled: teamIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('training_sessions')
        .select('id, team_id, session_date, objectives, session_blocks, warmup, drills, materials, evaluation, microcycle_day_id')
        .in('team_id', teamIds).gte('session_date', desde).lte('session_date', hasta)
        .order('session_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SesionS[];
    },
  });
}

/** Listas tomadas en el rango, por equipo y día: vinieron / total. */
function useListasRango(teamIds: string[], desde: string, hasta: string) {
  return useQuery<Map<string, { vino: number; total: number }>>({
    queryKey: ['v2-ses-listas', teamIds.join(','), desde, hasta],
    enabled: teamIds.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      // Las listas (attendance_sessions) se ven directo; sus registros, por el BFF
      // (al coach la RLS viva de attendance_records no se los muestra).
      const { data, error } = await (supabase as any)
        .from('attendance_sessions').select('team_id, session_date')
        .in('team_id', teamIds).gte('session_date', desde).lte('session_date', hasta).limit(200);
      if (error) throw error;
      const regs = await registrosPorEquipoYDia(((data ?? []) as any[]).map((s) => ({ teamId: s.team_id, fecha: s.session_date })));
      const m = new Map<string, { vino: number; total: number }>();
      for (const [k, recs] of regs) {
        if (recs.length === 0) continue;
        m.set(k, { vino: recs.filter((r) => r.status === 'present' || r.status === 'late').length, total: recs.length });
      }
      return m;
    },
  });
}

/** El plan del mes del equipo. MISMAS queryKeys y consultas que MesocycleSection (comparten caché). */
function usePlanDelMes(teamId: string | null) {
  const hoy = todayColombia();
  const mesosQ = useQuery({
    queryKey: ['mesocycles', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('training_mesocycles').select('*').eq('team_id', teamId).order('starts_on', { ascending: false });
      if (error) throw error;
      return (data || []) as any[];
    },
  });
  // Solo el plan vigente (o el próximo): uno ya terminado no es «el del mes».
  const meso = useMemo(() => planVigente(mesosQ.data ?? [], hoy), [mesosQ.data, hoy]);
  const microsQ = useQuery({
    queryKey: ['microcycles', meso?.id],
    enabled: !!meso?.id,
    queryFn: async () => {
      const { data, error } = await (supabase as any).from('training_microcycles').select('*').eq('mesocycle_id', meso!.id).order('starts_on', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
  const diasQ = useQuery({
    queryKey: ['microcycle-days', meso?.id],
    enabled: !!microsQ.data && (microsQ.data as any[]).length > 0,
    queryFn: async () => {
      const ids = ((microsQ.data as any[]) || []).map((m: any) => m.id);
      if (ids.length === 0) return [];
      const { data, error } = await (supabase as any).from('training_microcycle_days').select('*').in('microcycle_id', ids).order('day_date', { ascending: true });
      if (error) throw error;
      return data;
    },
  });
  return {
    cargando: !teamId || mesosQ.isPending || (!!meso && microsQ.isPending),
    error: mesosQ.isError || microsQ.isError,
    reintentar: () => { void mesosQ.refetch(); void microsQ.refetch(); },
    meso: meso as any | null,
    semanas: ((microsQ.data as any[]) ?? []) as SemanaPlan[],
    dias: ((diasQ.data as any[]) ?? []) as { id: string; microcycle_id: string; day_date: string; day_type: string; planned_rpe: number | null; focus: string | null }[],
  };
}

// ── Pantalla ─────────────────────────────────────────────────────────────────

export interface CoachSessionsV2Props {
  /** `?tab=semana&fecha=YYYY-MM-DD` (link del aviso de clase de prueba) manda sobre esto. */
  tabInicial?: 'hoy' | 'semana' | 'plan';
  /** Donde se crean y editan sesiones y el plan (la planificación completa). */
  rutaPlanificacion?: string;
  /** Pizarra libre (pantalla independiente, sin formulario). */
  rutaPizarra?: string;
}

export default function CoachSessionsV2({ tabInicial = 'hoy', rutaPlanificacion = '/training-plans', rutaPizarra = '/pizarra' }: CoachSessionsV2Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const hoy = todayColombia();
  // El aviso al profe («Nueva clase de prueba») abre la Semana en ese día.
  const [params] = useSearchParams();
  const fechaUrl = esFechaIso(params.get('fecha')) ? params.get('fecha') : null;
  const [tab, setTab] = useState<'hoy' | 'semana' | 'plan'>(() => {
    const t = params.get('tab');
    if (t === 'hoy' || t === 'semana' || t === 'plan') return t;
    return fechaUrl ? 'semana' : tabInicial;
  });
  // Otro aviso con la pantalla ya abierta: vuelve a la Semana de ese día.
  useEffect(() => { if (fechaUrl) setTab('semana'); }, [fechaUrl]);
  const [cancha, setCancha] = useState<{ sesion: SesionS; equipo: EquipoS } | null>(null);
  const [pizarra, setPizarra] = useState<{ teamId: string; teamName: string; blockId: string; label: string } | null>(null);
  const [verSesion, setVerSesion] = useState<{ id: string; teamId: string; teamName: string } | null>(null);
  const [planTeamId, setPlanTeamId] = useState<string | null>(null);

  const equiposQ = useEquipos();
  const equipos = useMemo(() => equiposQ.data ?? [], [equiposQ.data]);
  const teamIds = useMemo(() => equipos.map((e) => e.id), [equipos]);
  const equipoPorId = useMemo(() => new Map(equipos.map((e) => [e.id, e])), [equipos]);

  const hoyQ = useSesionesRango(teamIds, hoy, hoy);
  const sesionesHoy = hoyQ.data ?? [];
  const [elegidaHoy, setElegidaHoy] = useState<string | null>(null);
  const sesionHoy = sesionesHoy.find((s) => s.id === elegidaHoy) ?? sesionesHoy[0] ?? null;

  // El plan del mes abre por defecto en el equipo del entreno de hoy.
  useEffect(() => {
    if (!planTeamId && (sesionHoy || equipos[0])) setPlanTeamId(sesionHoy?.team_id ?? equipos[0].id);
  }, [planTeamId, sesionHoy, equipos]);

  /** Abre la pizarra de un bloque; si el bloque no tiene id propio, se le asigna y se guarda primero. */
  const abrirPizarra = async (sesion: SesionS, bloque: BloqueV2) => {
    const equipo = equipoPorId.get(sesion.team_id);
    if (!equipo || bloque.index == null) return;
    let blockId = bloque.id;
    if (!blockId) {
      blockId = crypto.randomUUID();
      const next = (Array.isArray(sesion.session_blocks) ? sesion.session_blocks : []).slice();
      next[bloque.index] = { ...(next[bloque.index] as object), id: blockId };
      const { error } = await supabase.from('training_sessions').update({ session_blocks: next }).eq('id', sesion.id);
      if (error) { toast({ title: 'No se pudo abrir la pizarra', description: error.message, variant: 'destructive' }); return; }
      void queryClient.invalidateQueries({ queryKey: ['v2-ses-rango'] });
      void queryClient.invalidateQueries({ queryKey: ['training-sessions', sesion.team_id] });
    }
    setPizarra({
      teamId: equipo.id, teamName: equipo.name, blockId,
      label: `Entrenamiento ${fechaHumana(sesion.session_date)} — ${bloque.nombre}`,
    });
  };

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 px-gutter pb-nav-safe pt-4 md:max-w-page md:pb-8">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight">Sesiones</h1>
        {/* Acceso directo a la pizarra libre: se dibuja sin formulario (ítem 3). */}
        <Button asChild variant="outline" className="min-h-touch gap-1.5 rounded-xl" data-testid="sesiones-pizarra">
          <Link to={rutaPizarra}><Presentation className="h-4 w-4" aria-hidden /> Pizarra</Link>
        </Button>
      </header>
      <Segmentado<'hoy' | 'semana' | 'plan'> etiqueta="Sesiones" valor={tab} onCambio={setTab}
        opciones={[{ v: 'hoy', l: 'Hoy' }, { v: 'semana', l: 'Semana' }, { v: 'plan', l: 'Plan del mes' }]} />

      {equiposQ.isPending ? (
        <div className="space-y-2" role="status" aria-label="Cargando tus sesiones">
          <div className="h-28 animate-pulse rounded-2xl bg-muted" />
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-touch animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : equiposQ.isError ? (
        <ErrorCaja texto="No pudimos cargar tus equipos." onReintentar={() => void equiposQ.refetch()} />
      ) : equipos.length === 0 ? (
        <Vacio titulo="No tienes equipos asignados" texto="Cuando la escuela te asigne un equipo, aquí ves sus sesiones y el plan del mes." />
      ) : tab === 'hoy' ? (
        <TabHoy
          cargando={hoyQ.isLoading} error={hoyQ.isError} reintentar={() => void hoyQ.refetch()}
          sesiones={sesionesHoy} sesion={sesionHoy} equipoPorId={equipoPorId} onElegir={setElegidaHoy}
          onCancha={(s) => { const e = equipoPorId.get(s.team_id); if (e) setCancha({ sesion: s, equipo: e }); }}
          onPizarra={abrirPizarra} onSemana={() => setTab('semana')} rutaPlanificacion={rutaPlanificacion}
        />
      ) : tab === 'semana' ? (
        <TabSemana
          key={fechaUrl ?? 'semana'}
          hoy={hoy} teamIds={teamIds} equipoPorId={equipoPorId} rutaPlanificacion={rutaPlanificacion} fechaInicial={fechaUrl}
          onVer={(s) => setVerSesion({ id: s.id, teamId: s.team_id, teamName: equipoPorId.get(s.team_id)?.name ?? 'Equipo' })}
          onCancha={(s) => { const e = equipoPorId.get(s.team_id); if (e) setCancha({ sesion: s, equipo: e }); }}
        />
      ) : (
        <TabPlan
          hoy={hoy} equipos={equipos} teamId={planTeamId} onTeam={setPlanTeamId} rutaPlanificacion={rutaPlanificacion}
        />
      )}

      {cancha && <ModoCancha sesion={cancha.sesion} equipo={cancha.equipo} onSalir={() => setCancha(null)} />}

      {pizarra && (
        <TacticalBoard
          open={!!pizarra} onClose={() => setPizarra(null)} teamId={pizarra.teamId} teamName={pizarra.teamName}
          sourceType="training_session" sourceId={pizarra.blockId} contextLabel={pizarra.label}
        />
      )}
      <SessionViewer open={!!verSesion} onClose={() => setVerSesion(null)} sessionId={verSesion?.id ?? null}
        teamId={verSesion?.teamId ?? ''} teamName={verSesion?.teamName ?? ''} />
    </div>
  );
}

function ErrorCaja({ texto, onReintentar }: { texto: string; onReintentar: () => void }) {
  return (
    <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
      <p className="font-semibold">{texto}</p>
      <p className="text-muted-foreground">Revisa la señal e inténtalo otra vez.</p>
      <Button variant="outline" className="mt-3 min-h-touch" onClick={onReintentar}>Reintentar</Button>
    </div>
  );
}

function Vacio({ titulo, texto, children }: { titulo: string; texto: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border bg-card p-5 text-center">
      <p className="font-semibold">{titulo}</p>
      <p className="mt-1 text-sm text-muted-foreground">{texto}</p>
      {children && <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

// ── Hoy ──────────────────────────────────────────────────────────────────────

function TabHoy({ cargando, error, reintentar, sesiones, sesion, equipoPorId, onElegir, onCancha, onPizarra, onSemana, rutaPlanificacion }: {
  cargando: boolean; error: boolean; reintentar: () => void;
  sesiones: SesionS[]; sesion: SesionS | null; equipoPorId: Map<string, EquipoS>;
  onElegir: (id: string) => void; onCancha: (s: SesionS) => void; onPizarra: (s: SesionS, b: BloqueV2) => void;
  onSemana: () => void; rutaPlanificacion: string;
}) {
  const plan = usePlanDelMes(sesion?.team_id ?? null);
  if (cargando) return <div className="h-48 animate-pulse rounded-2xl bg-muted" role="status" aria-label="Cargando el entreno de hoy" />;
  if (error) return <ErrorCaja texto="No pudimos cargar el entreno de hoy." onReintentar={reintentar} />;
  if (!sesion) {
    return (
      <Vacio titulo="Hoy no tienes un entreno planeado" texto="Mira la semana o planea la sesión de hoy.">
        <Button variant="outline" className="min-h-touch" onClick={onSemana}>Ver la semana</Button>
        <Button asChild className="min-h-touch"><Link to={rutaPlanificacion}>Planear una sesión</Link></Button>
      </Vacio>
    );
  }
  const equipo = equipoPorId.get(sesion.team_id);
  const bloques = bloquesDeSesion(sesion);
  const tienePizarra = equipo ? teamBoardAccess(equipo).hasTacticalBoard : false;
  const objetivo = objetivoTexto(sesion.objectives);

  // «Semana 2 del plan de octubre · carga media»
  let lineaPlan: string | null = null;
  const hoy = sesion.session_date;
  const iSemana = semanaActual(plan.semanas, hoy);
  if (plan.meso && iSemana >= 0) {
    const sem = plan.semanas[iSemana];
    const c = cargaDeSemana(plan.dias.filter((d) => d.microcycle_id === sem.id));
    lineaPlan = `Semana ${sem.number ?? iSemana + 1} del plan de ${mesDelPlan(plan.meso.starts_on, plan.meso.ends_on).toLowerCase()}${c ? ` · carga ${c.carga.toLowerCase()}` : ''}`;
  }

  return (
    <div className="space-y-4">
      {sesiones.length > 1 && (
        <div className="flex gap-2 overflow-x-auto scrollbar-none" role="tablist" aria-label="Entrenos de hoy">
          {sesiones.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={s.id === sesion.id} onClick={() => onElegir(s.id)}
              className={cn('min-h-touch shrink-0 rounded-full border px-4 text-sm', s.id === sesion.id ? 'border-primary bg-primary/10 font-semibold' : 'bg-card')}>
              {equipoPorId.get(s.team_id)?.name ?? 'Equipo'}
            </button>
          ))}
        </div>
      )}

      <article className="space-y-3 rounded-2xl border bg-card p-4" data-testid="sesion-hoy">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Hoy</p>
        <h2 className="text-xl font-bold leading-tight">{equipo?.name ?? 'Equipo'}{objetivo ? ` · ${objetivo}` : ''}</h2>
        {lineaPlan && <p className="text-sm text-muted-foreground">{lineaPlan}</p>}
        <Button className="min-h-touch w-full gap-2 text-base" size="lg" onClick={() => onCancha(sesion)} disabled={bloques.length === 0} data-testid="abrir-cancha">
          <Maximize2 className="h-5 w-5" /> Abrir en la cancha
        </Button>
        <p className="text-center text-xs text-muted-foreground">Letra grande y la pantalla no se apaga.</p>
      </article>

      {bloques.length === 0 ? (
        <Vacio titulo="Esta sesión no tiene bloques" texto="Agrega los bloques (calentamiento, ejercicios, partido) en la planificación.">
          <Button asChild variant="outline" className="min-h-touch"><Link to={rutaPlanificacion}>Editar la sesión</Link></Button>
        </Vacio>
      ) : (
        <ol className="space-y-2" aria-label="Bloques del entreno">
          {bloques.map((b, i) => (
            <li key={i} className="flex gap-3 rounded-2xl border bg-card p-3">
              <span className="w-12 shrink-0 text-center text-sm font-bold tabular-nums text-primary">{b.minutos != null ? `${b.minutos}′` : '—'}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{b.nombre}</span>
                {b.texto && <span className="block text-sm text-muted-foreground">{b.texto}</span>}
              </span>
              {tienePizarra && b.index != null && (
                <Button variant="outline" size="sm" className="min-h-touch shrink-0 gap-1" onClick={() => onPizarra(sesion, b)}>
                  <Presentation className="h-4 w-4" aria-hidden /> Pizarra
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {sesion.materials && <p className="px-1 text-sm text-muted-foreground"><strong className="text-foreground">Material:</strong> {sesion.materials}</p>}
      <p className="px-1 text-center text-xs"><Link to={rutaPlanificacion} className="text-primary underline-offset-2 hover:underline">Editar la sesión en la planificación completa</Link></p>
    </div>
  );
}

// ── Semana ───────────────────────────────────────────────────────────────────

const ESTILO_DIA: Record<Exclude<EstadoDia, ''>, string> = {
  Hoy: 'bg-foreground text-background',
  Hecho: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  'Sin evaluar': 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
  'Sin lista': 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  Planeado: 'bg-muted text-muted-foreground',
};

/** Etiqueta del entreno ajustado (cancelado / cambiado / extra). */
const ESTILO_ENTRENO: Record<Exclude<EstadoEntreno, 'normal'>, string> = {
  cancelada: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  movida: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
  extra: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-300',
};

function TabSemana({ hoy, teamIds, equipoPorId, rutaPlanificacion, fechaInicial, onVer, onCancha }: {
  hoy: string; teamIds: string[]; equipoPorId: Map<string, EquipoS>; rutaPlanificacion: string;
  /** Día que abre el link del aviso (`?fecha=`): la semana de ese día, marcado. */
  fechaInicial?: string | null;
  onVer: (s: SesionS) => void; onCancha: (s: SesionS) => void;
}) {
  // El horario del equipo (teams.schedule): un día con horario y sin sesión planeada no es «Día libre».
  const conHorario: EquipoSemana[] = useMemo(
    () => [...equipoPorId.values()].map((e) => ({ id: e.id, name: e.name, franjas: leerFranjas(e.schedule) })),
    [equipoPorId],
  );
  const [offset, setOffset] = useState(() => (fechaInicial ? semanasHasta(hoy, fechaInicial) : 0));
  const dias = useMemo(() => semanaDe(hoy, offset), [hoy, offset]);
  const sesQ = useSesionesRango(teamIds, dias[0], dias[6]);
  const listasQ = useListasRango(teamIds, dias[0], dias[6]);
  const [abierto, setAbierto] = useState<string | null>(fechaInicial ?? hoy);

  // «Mi semana»: cancelar, mover o agregar un entreno solo esa fecha, y las clases
  // de prueba. Sin la migración (tabla o RPC inexistente) la pestaña es la de siempre.
  const semana = useSemanaAjustes({ teamIds, lunes: dias[0] });
  const [ajustando, setAjustando] = useState<AbrirAjuste | null>(null);
  const equiposLista = useMemo(() => conHorario.map((e) => ({ id: e.id, name: e.name })), [conHorario]);
  const lugares = useMemo(
    () => [...new Set(conHorario.flatMap((e) => e.franjas.map((f) => f.place?.trim() ?? '').filter(Boolean)))],
    [conHorario],
  );
  const marcado = useRef<HTMLLIElement | null>(null);
  useEffect(() => { marcado.current?.scrollIntoView?.({ block: 'center' }); }, []);

  const repetir = async () => {
    const r = await semana.repetir();
    if (!r.ok) { aviso.error(r.error ?? 'No se pudo copiar.'); return; }
    aviso.success((r.copiadas ?? 0) > 0
      ? `Listo: ${r.copiadas} ${r.copiadas === 1 ? 'ajuste copiado' : 'ajustes copiados'} a esta semana.`
      : 'Esta semana ya tenía esos ajustes.');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="h-touch w-touch" aria-label="Semana anterior" onClick={() => setOffset((o) => o - 1)}><ChevronLeft className="h-5 w-5" /></Button>
        <p className="min-w-0 flex-1 text-balance text-center text-sm font-semibold">{rangoSemana(dias)}</p>
        <Button variant="ghost" size="icon" className="h-touch w-touch" aria-label="Semana siguiente" onClick={() => setOffset((o) => o + 1)}><ChevronRight className="h-5 w-5" /></Button>
      </div>
      {offset !== 0 && <Button variant="outline" size="sm" className="min-h-touch w-full" onClick={() => setOffset(0)}>Volver a esta semana</Button>}

      {semana.disponible && (
        <div className="flex flex-wrap gap-2">
          {semana.repetirPlan.total > 0 && (
            <Button variant="outline" size="sm" className="min-h-touch flex-1 gap-1.5" disabled={semana.guardando} onClick={() => void repetir()} data-testid="repetir-semana">
              <Repeat className="h-4 w-4" aria-hidden /> Repetir ajustes de la semana pasada
            </Button>
          )}
          <Button variant="outline" size="sm" className="min-h-touch flex-1 gap-1.5" data-testid="entreno-extra"
            onClick={() => setAjustando({ entreno: null, fecha: dias.includes(hoy) ? hoy : dias[0] })}>
            <CalendarPlus className="h-4 w-4" aria-hidden /> Entreno extra
          </Button>
        </div>
      )}

      {sesQ.isLoading ? (
        <div className="space-y-2" role="status" aria-label="Cargando la semana">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-muted" />)}
        </div>
      ) : sesQ.isError ? (
        <ErrorCaja texto="No pudimos cargar la semana." onReintentar={() => void sesQ.refetch()} />
      ) : (
        <ul className="space-y-2" aria-label="Días de la semana">
          {dias.map((d) => {
            const delDia = (sesQ.data ?? []).filter((s) => s.session_date === d);
            const { dia, num } = etiquetaDia(d);
            const listas = delDia.map((s) => listasQ.data?.get(`${s.team_id}|${d}`));
            // Entrenos del horario (con los ajustes de esa fecha) sin sesión planeada ese día.
            const delHorario = semana.disponible ? entrenosDelHorarioConAjustes(d, conHorario, semana.ajustes) : entrenosDelHorario(d, conHorario);
            const sinPlan = delHorario.filter((p) => !delDia.some((s) => s.team_id === p.teamId));
            const entrenosDia = semana.disponible ? entrenosDelDia(d, conHorario, semana.ajustes) : [];
            const cancelados = entrenosDia.filter((e) => e.estado === 'cancelada');
            const clasesDia = semana.clases.filter((c) => c.fecha === d);
            const listaSinPlan = sinPlan.some((p) => !!listasQ.data?.get(`${p.teamId}|${d}`));
            const hayEntreno = delDia.length > 0 || sinPlan.length > 0;
            const est = hayEntreno
              ? estadoDelDia(d, hoy, true, listas.some(Boolean) || listaSinPlan, delDia.length > 0 && sinPlan.length === 0 && delDia.every((s) => !!s.evaluation))
              : '';
            const titulo = hayEntreno
              ? [...delDia.map((s) => equipoPorId.get(s.team_id)?.name ?? 'Equipo'), ...sinPlan.map((p) => p.nombre)].join(' · ')
              : cancelados.length ? [...new Set(cancelados.map((c) => c.nombre))].join(' · ') : 'Sin entrenos';
            const horas = sinPlan.map((p) => p.hora).filter(Boolean).join(' · ');
            const sub = delDia.length
              ? delDia.map((s) => objetivoTexto(s.objectives)).filter(Boolean).join(' · ')
              : sinPlan.length ? `Entreno${horas ? ` ${horas}` : ''} · sin plan`
              : cancelados.length ? `Entreno cancelado${cancelados[0].motivo ? ` por ${cancelados[0].motivo}` : ''}` : 'Día libre';
            const open = abierto === d && delDia.length > 0;
            return (
              <li key={d} ref={d === fechaInicial ? marcado : undefined}
                className={cn('overflow-hidden rounded-2xl border', d === hoy ? 'bg-primary/5' : 'bg-card', d === fechaInicial && 'ring-2 ring-primary')} data-testid="dia-semana">
                <div className="flex items-center">
                <button type="button" className="flex min-h-touch min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left" onClick={() => setAbierto(open ? null : d)} aria-expanded={open} disabled={delDia.length === 0}>
                  <span className="w-10 shrink-0 text-center">
                    <span className="block text-xs text-muted-foreground">{dia}</span>
                    <span className="block text-lg font-bold tabular-nums">{num}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('line-clamp-2 block font-medium leading-snug', !hayEntreno && 'text-muted-foreground')}>{titulo}</span>
                    <span className="block truncate text-xs text-muted-foreground">{sub}</span>
                  </span>
                  {est && <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold', ESTILO_DIA[est])}>{est}</span>}
                </button>
                {delDia.length === 0 && sinPlan.length > 0 && (
                  <Button asChild variant="outline" size="sm" className="mr-3 min-h-touch shrink-0"><Link to={rutaPlanear(rutaPlanificacion, { equipo: sinPlan[0].teamId, fecha: d })}>Planear</Link></Button>
                )}
                </div>
                {entrenosDia.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label={`Entrenos del ${dia} ${num}`}>
                    {entrenosDia.map((en) => {
                      const etiqueta = etiquetaEstado(en);
                      return (
                        <button key={en.clave} type="button" onClick={() => setAjustando({ entreno: en, fecha: d })} data-testid="entreno-ajustable"
                          aria-label={`Ajustar ${en.nombre}, ${horarioTexto(en)}${etiqueta ? `, ${etiqueta}` : ''}`}
                          className={cn('flex min-h-touch items-center gap-1.5 rounded-full border px-3 text-xs', en.estado === 'cancelada' ? 'border-dashed text-muted-foreground' : 'bg-background')}>
                          <span className={cn('tabular-nums', en.estado === 'cancelada' && 'line-through')}>
                            {en.hora ? horaCorta(en.hora) : 'Sin hora'}{conHorario.length > 1 ? ` · ${en.nombre}` : ''}
                          </span>
                          {en.estado !== 'normal' && etiqueta && <span className={cn('rounded-full px-1.5 py-0.5 font-semibold', ESTILO_ENTRENO[en.estado])}>{etiqueta}</span>}
                          <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden />
                        </button>
                      );
                    })}
                  </div>
                )}
                <ClasesPruebaDelDia clases={clasesDia} hoy={hoy} equiposEscuela={semana.equiposEscuela} guardando={semana.guardando} onMarcar={semana.marcar} />
                {open && (
                  <div className="space-y-3 border-t px-3 py-3">
                    {sinPlan.map((p) => (
                      <div key={p.teamId} className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 text-sm">Entreno de {p.nombre}{p.hora ? ` ${p.hora}` : ''} · sin plan</p>
                        <Button asChild variant="outline" size="sm" className="min-h-touch shrink-0"><Link to={rutaPlanear(rutaPlanificacion, { equipo: p.teamId, fecha: d })}>Planear</Link></Button>
                      </div>
                    ))}
                    {delDia.map((s, i) => {
                      const bl = bloquesDeSesion(s);
                      const lista = listas[i];
                      return (
                        <div key={s.id} className="space-y-2">
                          {delDia.length > 1 && <p className="text-sm font-semibold">{equipoPorId.get(s.team_id)?.name}</p>}
                          <p className="text-sm text-muted-foreground">
                            {bl.length ? bl.map((b) => `${b.nombre}${b.minutos != null ? ` ${b.minutos}′` : ''}`).join(' · ') : 'Sin bloques.'}
                          </p>
                          {d <= hoy && (
                            <p className="text-sm">
                              {lista ? `Lista: ${lista.vino} de ${lista.total}.` : 'Sin lista.'} {lista && (s.evaluation ? 'Evaluado.' : 'Falta evaluar al equipo.')}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button variant="outline" size="sm" className="min-h-touch" onClick={() => onVer(s)}>Ver sesión</Button>
                            {bl.length > 0 && <Button size="sm" className="min-h-touch gap-1" onClick={() => onCancha(s)}><Maximize2 className="h-4 w-4" /> Abrir en la cancha</Button>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="px-1 text-xs text-muted-foreground">
        Ves tus equipos. La escuela ve la semana de todos los profes.
        {semana.disponible && ' Toca la hora de un entreno para cancelarlo o moverlo solo ese día.'}
      </p>
      <AjustarEntrenoSheet abierto={ajustando} equipos={equiposLista} lugares={lugares} guardando={semana.guardando}
        onAplicar={semana.aplicar} onClose={() => setAjustando(null)} />
    </div>
  );
}

// ── Plan del mes ─────────────────────────────────────────────────────────────

function TabPlan({ hoy, equipos, teamId, onTeam, rutaPlanificacion }: {
  hoy: string; equipos: EquipoS[]; teamId: string | null; onTeam: (id: string) => void; rutaPlanificacion: string;
}) {
  const equipo = equipos.find((e) => e.id === teamId) ?? null;
  const plan = usePlanDelMes(teamId);
  const meso = plan.meso;
  const sesQ = useSesionesRango(teamId ? [teamId] : [], meso?.starts_on ?? hoy, meso?.ends_on ?? hoy);
  const listasQ = useListasRango(teamId ? [teamId] : [], meso?.starts_on ?? hoy, meso && meso.ends_on < hoy ? meso.ends_on : hoy);

  const actual = semanaActual(plan.semanas, hoy);
  const entrenosPlaneados = (meso?.n_sessions_planned as number | null) ?? (plan.dias.filter((d) => d.day_type === 'entrenamiento').length || (sesQ.data?.length ?? 0));
  // «Hechos» = listas tomadas (attendance_sessions) hasta hoy, no sesiones planeadas.
  const clavesListas = [...(listasQ.data?.keys() ?? [])];
  const hechos = clavesListas.length;
  let vino = 0, total = 0;
  for (const c of listasQ.data?.values() ?? []) { vino += c.vino; total += c.total; }
  const asistencia = total ? Math.round((vino / total) * 100) : null;
  const cargaMes = cargaDeSemana(plan.dias.filter((d) => d.day_date <= hoy));
  const partidosPorSemana = plan.semanas.length ? Math.round(plan.dias.filter((d) => d.day_type === 'partido').length / plan.semanas.length) : 0;

  return (
    <div className="space-y-4">
      {equipos.length > 1 && (
        <div className="flex gap-2 overflow-x-auto scrollbar-none" role="tablist" aria-label="Equipo">
          {equipos.map((e) => (
            <button key={e.id} type="button" role="tab" aria-selected={e.id === teamId} onClick={() => onTeam(e.id)}
              className={cn('min-h-touch shrink-0 rounded-full border px-4 text-sm', e.id === teamId ? 'border-primary bg-primary/10 font-semibold' : 'bg-card')}>
              {e.name}
            </button>
          ))}
        </div>
      )}

      {plan.cargando ? (
        <div className="h-40 animate-pulse rounded-2xl bg-muted" role="status" aria-label="Cargando el plan del mes" />
      ) : plan.error ? (
        <ErrorCaja texto="No pudimos cargar el plan del mes." onReintentar={plan.reintentar} />
      ) : !meso ? (
        <Vacio titulo={`No tienes plan para ${nombreMes(hoy).toLowerCase()}`} texto={`${equipo?.name ?? 'Este equipo'}: arma el plan del mes, con el objetivo, las semanas y qué tan duro va cada una.`}>
          <Button asChild className="min-h-touch"><Link to={rutaPlanear(rutaPlanificacion, { equipo: teamId, fecha: hoy })}>Crear el plan</Link></Button>
        </Vacio>
      ) : (
        <>
          <section className="space-y-1 rounded-2xl border bg-card p-4" data-testid="plan-del-mes">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Plan del mes · {equipo?.name}</p>
            <h2 className="text-xl font-bold leading-tight">
              {mesDelPlan(meso.starts_on, meso.ends_on)}{meso.general_objective ? `: ${meso.general_objective}` : ''}
            </h2>
            <p className="text-sm text-muted-foreground">
              {plan.semanas.length} {plan.semanas.length === 1 ? 'semana' : 'semanas'} · {entrenosPlaneados} entrenos
              {partidosPorSemana > 0 ? ` · ${partidosPorSemana} partido${partidosPorSemana === 1 ? '' : 's'} por semana` : ''}
            </p>
          </section>

          {plan.semanas.length > 0 && (
            <ol className="space-y-2" aria-label="Semanas del plan">
              {plan.semanas.map((w, i) => {
                const c = cargaDeSemana(plan.dias.filter((d) => d.microcycle_id === w.id));
                return (
                  <li key={w.id} className={cn('flex items-center gap-3 rounded-2xl border p-3', i === actual ? 'bg-primary/5' : 'bg-card')}>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-xs', i === actual ? 'font-semibold text-primary' : 'text-muted-foreground')}>{textoSemana(i, actual, plan.semanas, hoy, listasQ.data ? listasEntre(clavesListas, w.starts_on, w.ends_on) : undefined)}</span>
                      <span className="block font-medium">{w.objective || 'Sin objetivo escrito'}</span>
                    </span>
                    {c ? (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="flex gap-0.5" aria-hidden="true">
                          {[1, 2, 3].map((n) => <span key={n} className={cn('h-3 w-1.5 rounded-sm', n <= c.nivel ? 'bg-primary' : 'bg-muted')} />)}
                        </span>
                        <span className="text-xs text-muted-foreground">{c.carga}</span>
                      </span>
                    ) : <span className="shrink-0 text-xs text-muted-foreground">Sin carga</span>}
                  </li>
                );
              })}
            </ol>
          )}

          <section className="space-y-2 rounded-2xl border bg-card p-4">
            <h3 className="text-sm font-semibold">Balance del mes, hasta hoy</h3>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div><p className="text-lg font-bold tabular-nums">{hechos} de {entrenosPlaneados || hechos}</p><p className="text-xs text-muted-foreground">entrenos hechos</p></div>
              <div><p className="text-lg font-bold tabular-nums">{asistencia != null ? `${asistencia} %` : '—'}</p><p className="text-xs text-muted-foreground">asistencia</p></div>
              <div><p className="text-lg font-bold">{cargaMes?.carga ?? '—'}</p><p className="text-xs text-muted-foreground">qué tan duro fue</p></div>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button asChild variant="outline" className="min-h-touch"><Link to={rutaPlanificacion}>Editar el plan</Link></Button>
            <Button asChild variant="outline" className="min-h-touch"><Link to={rutaPlanificacion}>Armar el plan del mes siguiente</Link></Button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Modo cancha ──────────────────────────────────────────────────────────────

function ModoCancha({ sesion, equipo, onSalir }: { sesion: SesionS; equipo: EquipoS; onSalir: () => void }) {
  const bloques = bloquesDeSesion(sesion);
  const [i, setI] = useState(0);
  const { encendida } = useWakeLock(true);
  const soportado = wakeLockDisponible();
  const b = bloques[i];
  const ultimo = i >= bloques.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSalir();
      if (e.key === 'ArrowRight') setI((x) => Math.min(bloques.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [bloques.length, onSalir]);

  if (!b) return null;
  // Portal al final del body: queda encima de la barra inferior y de cualquier cabecera de la app.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Modo cancha" data-testid="modo-cancha"
      className="fixed inset-0 z-50 flex flex-col bg-background pb-safe-b pt-safe-t text-foreground">
      <div className="flex items-center gap-3 border-b px-gutter py-2">
        <p className="min-w-0 flex-1 truncate text-base font-semibold">{equipo.name} · bloque {i + 1} de {bloques.length}</p>
        <Button variant="ghost" className="min-h-touch gap-1" onClick={onSalir} data-testid="cancha-salir"><X className="h-5 w-5" /> Salir</Button>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col justify-center gap-4 overflow-y-auto px-gutter py-6">
        {b.minutos != null && <p className="text-5xl font-black tabular-nums text-primary md:text-7xl">{b.minutos}′</p>}
        <h2 className="text-4xl font-bold leading-tight md:text-6xl" data-testid="cancha-titulo">{b.nombre}</h2>
        {b.texto && <p className="text-2xl leading-snug text-muted-foreground md:text-3xl">{b.texto}</p>}
      </div>
      <p className="flex items-center justify-center gap-1.5 px-gutter pb-2 text-center text-sm text-muted-foreground" role="status">
        {encendida ? <><Sun className="h-4 w-4" /> La pantalla se queda encendida mientras estés aquí.</>
          : soportado ? <><Loader2 className="h-4 w-4 animate-spin" /> Manteniendo la pantalla encendida…</>
          : 'Este teléfono no deja mantener la pantalla encendida: tócala de vez en cuando.'}
      </p>
      <div className="grid grid-cols-2 gap-3 border-t px-gutter py-3">
        <Button variant="outline" className="h-16 text-lg" disabled={i === 0} onClick={() => setI((x) => Math.max(0, x - 1))}>
          <ChevronLeft className="mr-1 h-6 w-6" /> Anterior
        </Button>
        <Button className="h-16 text-lg" onClick={() => (ultimo ? onSalir() : setI((x) => x + 1))} data-testid="cancha-siguiente">
          {ultimo ? 'Terminar' : <>Siguiente <ChevronRight className="ml-1 h-6 w-6" /></>}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
