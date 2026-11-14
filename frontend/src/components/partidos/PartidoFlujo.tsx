/**
 * Pantalla del partido: un solo lugar, en orden,
 *   Programar → Convocar → Resultado → Evaluar → Reporte.
 *
 * La usan el entrenador (Equipos › Partidos, «+ Partido») y la escuela
 * (Resultados → cada partido). Pensada para el celular en la cancha: botones
 * grandes y una sola cosa por pantalla.
 *
 * Escrituras (todas con el JWT del usuario; la RPC es el gate):
 *   - create_match / update_match            (20260926131340)
 *   - save_match_roster                       (vía ConvocatoriaPartido)
 *   - goles/asistencias/tarjetas              (BFF /school/football/events, igual que MatchEventsModal)
 *   - submit_match_evaluation / publish_match_evaluation
 *   - reporte                                 (MatchReportDialog / useMatchReports)
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, FileText, Loader2, Minus, Plus, Radio, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { todayColombia } from '@/lib/dateUtils';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useMinutosVivo } from '@/components/partido-vivo/informe/useInformeVivo';
import { FormatoVivoCampos } from './FormatoVivoCampos';
import { FORMATO_VIVO_DEFECTO, payloadFormatoVivo, validarFormatoVivo, type FormatoVivoForm } from './partidoVivoAgenda';
import { useFootballEvents, useCreateFootballEvents, useDeleteFootballEvent } from '@/hooks/useFootballData';
import { useSchoolPerformanceMetrics } from '@/hooks/usePerformanceData';
import { useMatchReports } from '@/hooks/useMatchReports';
import { MatchReportDialog } from '@/components/coach/MatchReportDialog';
import { QuickMetricInput } from '@/components/school/QuickMetricInput';
import { readEvaluation, type EvaluationMetric } from '@/components/school/evaluationMetrics';
import { InlineError, SectionSkeleton, EmptyNote } from '@/components/parent/v2/hijos/parts';
import { ConvocatoriaPartido } from '@/components/coach/v2/equipos/ConvocatoriaPartido';
import { useConvocatoria, useDeportistasEquipo, useNombresConvocados, usePartidosEquipo } from '@/components/coach/v2/useCoachV2Data';
import { nombreCorto, refuerzosDe, sujetoDe, type Partido } from '@/components/coach/v2/coachV2Logic';
import type { FootballEventType } from '@/lib/school/footballQueries';
import {
  BARRA_GUARDAR,
  PASOS,
  aColumnasMarcador,
  claveSujeto,
  criteriosDePartido,
  entradasEvaluacion,
  evaluadasDe,
  eventosPorJugadora,
  horaDeKickoff,
  indicePaso,
  kickoffIso,
  marcadorNuestroSugerido,
  marcadorPropio,
  marcadorRivalSugerido,
  pasoHabilitado,
  pasoInicial,
  planillaDesdeFilas,
  quienesSeEvaluan,
  sumaGoles,
  ultimoEvento,
  usaEventosDeFutbol,
  type PasoPartido,
  type Planilla,
  type Sujeto,
} from './partidoFlujoLogic';
import {
  aMetricaRapida,
  db,
  qkEvaluacion,
  qkPartido,
  useCompartirEvaluaciones,
  useCriteriosEscuela,
  useEquipoPartido,
  useEvaluacionPartido,
  usePartido,
  type PartidoFila,
} from './usePartidoData';

const ADMIN_ROLES = ['owner', 'admin', 'school_admin', 'super_admin'];
// Mismo criterio que tenía ResultsPage: registrar o corregir un partido es de
// la dirección de la escuela y de los entrenadores, no de cualquier 'staff'.
const EDITAN_PARTIDOS = [...ADMIN_ROLES, 'coach'];
const TIPOS = ['Amistoso', 'Liga', 'Copa', 'Torneo', 'Clasificatorio', 'Final'];

interface Props {
  /** null = partido nuevo. */
  matchId: string | null;
  /** Equipo del partido nuevo (con matchId se toma del partido). */
  teamId: string | null;
  /** Se creó el partido: la página cambia la URL a /partidos/:id. */
  onCreado: (matchId: string, siguiente: PasoPartido) => void;
  onVolver: () => void;
  /** Paso pedido por la URL (?paso=). */
  pasoPedido?: PasoPartido | null;
}

/** Errores de las RPC → mensaje en español claro, sin el texto crudo del servidor. */
function mensajeError(e: unknown, porDefecto: string): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') return 'No tienes permiso para hacer esto en esta escuela.';
  if (err?.code === '22023' && err.message && /^[A-ZÁÉÍÓÚÑa-záéíóúñ ,]+$/.test(err.message)) return err.message;
  return porDefecto;
}

const aPartidoCoach = (m: PartidoFila): Partido => ({
  id: m.id,
  rival: m.opponent,
  fecha: m.match_date,
  kickoffAt: m.kickoff_at,
  lugar: m.location,
  enCasa: m.is_home,
  golesLocal: m.home_score,
  golesVisita: m.away_score,
  estado: m.status,
  tipo: m.match_type,
  nota: m.notes,
});

export function PartidoFlujo({ matchId, teamId: teamIdNuevo, onCreado, onVolver, pasoPedido }: Props) {
  const { schoolId, currentUserRole } = useSchoolContext();
  const partido = usePartido(matchId);
  const teamId = partido.data?.team_id ?? teamIdNuevo;
  const equipo = useEquipoPartido(teamId);
  const evaluacion = useEvaluacionPartido(matchId);
  const esAdmin = ADMIN_ROLES.includes(currentUserRole || '');
  const puedeEditar = EDITAN_PARTIDOS.includes(currentUserRole || '');
  const escuela = partido.data?.school_id ?? equipo.data?.school_id ?? schoolId ?? null;
  const navigate = useNavigate();
  const vivoHabilitado = useEntitlements().liveMatchEnabled;

  const [paso, setPaso] = useState<PasoPartido | null>(pasoPedido ?? (matchId ? null : 'programar'));

  // Paso inicial cuando ya se sabe en qué va el partido.
  useEffect(() => {
    if (paso || !matchId || partido.isLoading || evaluacion.isLoading) return;
    setPaso(pasoInicial(partido.data ?? null, { hoyIso: todayColombia(), tieneEvaluacion: (evaluacion.data?.length ?? 0) > 0 }));
  }, [paso, matchId, partido.isLoading, partido.data, evaluacion.isLoading, evaluacion.data]);

  if (currentUserRole && !puedeEditar) {
    return (
      <div className="p-4">
        <EmptyNote>
          <p className="font-semibold text-foreground">Solo la dirección de la escuela y los entrenadores registran partidos.</p>
          <Button variant="outline" className="mt-3 min-h-touch rounded-xl" onClick={onVolver}>Volver</Button>
        </EmptyNote>
      </div>
    );
  }
  if (matchId && partido.isLoading) return <div className="p-4"><SectionSkeleton rows={4} label="Cargando el partido" /></div>;
  if (matchId && partido.isError) return <div className="p-4"><InlineError message="No pudimos traer el partido." onRetry={() => partido.refetch()} /></div>;
  if (matchId && !partido.data) {
    return (
      <div className="p-4">
        <EmptyNote>
          <p className="font-semibold text-foreground">No encontramos este partido.</p>
          <p className="mt-1">Puede que lo hayan borrado o que no sea de tu escuela.</p>
          <Button variant="outline" className="mt-3 min-h-touch rounded-xl" onClick={onVolver}>Volver</Button>
        </EmptyNote>
      </div>
    );
  }
  if (!teamId) {
    return (
      <div className="p-4">
        <EmptyNote>
          <p className="font-semibold text-foreground">Falta el equipo.</p>
          <p className="mt-1">Abre «+ Partido» desde el equipo o desde Resultados.</p>
          <Button variant="outline" className="mt-3 min-h-touch rounded-xl" onClick={onVolver}>Volver</Button>
        </EmptyNote>
      </div>
    );
  }

  // Mientras se decide el paso inicial (falta saber si ya hay evaluación).
  if (!paso) return <div className="p-4"><SectionSkeleton rows={4} label="Cargando el partido" /></div>;

  const m = partido.data ?? null;
  const actual = paso;
  const existe = !!m;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 pb-28">
      <header className="flex items-start gap-2">
        <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 rounded-xl" onClick={onVolver} aria-label="Volver">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-bold">{m ? `Contra ${m.opponent}` : 'Nuevo partido'}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {[equipo.data?.name, m?.status === 'cancelled' ? 'Cancelado' : m?.status === 'played' ? 'Jugado' : m ? 'Por jugar' : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        {vivoHabilitado && m && m.status !== 'cancelled' && puedeEditar && (
          <Button
            className="min-h-touch h-11 shrink-0 rounded-xl"
            onClick={() => navigate(`/partido-en-vivo/${encodeURIComponent(m.id)}`)}
          >
            <Radio className="mr-1.5 h-4 w-4" />Llevar en vivo
          </Button>
        )}
      </header>

      <nav aria-label="Pasos del partido" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {PASOS.map((p, i) => {
          const on = p.id === actual;
          const hecho = indicePaso(p.id) < indicePaso(actual);
          const habil = pasoHabilitado(p.id, existe);
          return (
            <button
              key={p.id}
              type="button"
              disabled={!habil}
              aria-current={on ? 'step' : undefined}
              onClick={() => setPaso(p.id)}
              className={cn(
                'flex min-h-touch shrink-0 items-center gap-1.5 rounded-full border-2 px-3 text-sm font-semibold',
                on ? 'border-primary bg-primary text-primary-foreground' : hecho ? 'border-primary/40 text-primary' : 'border-border text-muted-foreground',
                !habil && 'opacity-40',
              )}
            >
              <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-xs', on ? 'bg-primary-foreground/20' : 'bg-muted')}>
                {hecho ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
              </span>
              {p.titulo}
            </button>
          );
        })}
      </nav>

      {actual === 'programar' && (
        <PasoProgramar
          partido={m}
          teamId={teamId}
          onGuardado={(id, siguiente) => {
            if (!m) onCreado(id, siguiente);
            setPaso(siguiente);
          }}
        />
      )}
      {actual === 'convocar' && m && escuela && (
        <PasoConvocar partido={m} schoolId={escuela} onSiguiente={() => setPaso('cerrar')} />
      )}
      {actual === 'cerrar' && m && escuela && (
        <PasoCerrar partido={m} schoolId={escuela} equipo={equipo.data?.name ?? 'Nosotros'} deporte={equipo.data?.sport ?? null} onGuardado={() => setPaso('evaluar')} />
      )}
      {actual === 'evaluar' && m && escuela && (
        <PasoEvaluar partido={m} schoolId={escuela} esAdmin={esAdmin} onIrAConvocar={() => setPaso('convocar')} onSiguiente={() => setPaso('reporte')} />
      )}
      {actual === 'reporte' && m && <PasoReporte partido={m} onTerminar={onVolver} />}
    </div>
  );
}

// ── 1. Programar ────────────────────────────────────────────────────────────

function PasoProgramar({ partido, teamId, onGuardado }: {
  partido: PartidoFila | null; teamId: string; onGuardado: (matchId: string, siguiente: PasoPartido) => void;
}) {
  const qc = useQueryClient();
  const hoy = todayColombia();
  const [rival, setRival] = useState(partido?.opponent ?? '');
  const [fecha, setFecha] = useState(partido?.match_date ?? hoy);
  const [hora, setHora] = useState(horaDeKickoff(partido?.kickoff_at));
  const [local, setLocal] = useState(partido?.is_home !== false);
  const [lugar, setLugar] = useState(partido?.location ?? '');
  const [tipo, setTipo] = useState(partido?.match_type ?? 'Amistoso');
  const [notas, setNotas] = useState(partido?.notes ?? '');
  const [guardando, setGuardando] = useState(false);
  const vivo = useEntitlements().liveMatchEnabled;
  const pv = partido as (PartidoFila & Partial<{ live_periods_count: number | null; live_period_minutes: number | null; match_kind: 'official' | 'practice'; referee_name: string | null }>) | null;
  const [formatoVivo, setFormatoVivo] = useState<FormatoVivoForm>({
    periodos: pv?.live_periods_count ?? FORMATO_VIVO_DEFECTO.periodos,
    minutos: pv?.live_period_minutes ?? FORMATO_VIVO_DEFECTO.minutos,
    clase: pv?.match_kind ?? FORMATO_VIVO_DEFECTO.clase,
    arbitro: pv?.referee_name ?? '',
  });
  const errorVivo = vivo ? validarFormatoVivo(formatoVivo) : null;

  const yaPaso = fecha <= hoy;
  const valido = rival.trim().length >= 2 && !!fecha && !errorVivo;

  const guardar = async (yaSeJugo: boolean) => {
    if (!valido || guardando) return;
    setGuardando(true);
    const datos = {
      opponent: rival.trim(),
      match_date: fecha,
      kickoff_at: kickoffIso(fecha, hora) ?? '',
      is_home: local,
      location: lugar.trim(),
      match_type: tipo,
      notes: notas.trim(),
      ...payloadFormatoVivo(vivo, formatoVivo),
    };
    try {
      let id = partido?.id ?? null;
      if (partido) {
        const { error } = await db.rpc('update_match', { p_match: partido.id, p: datos });
        if (error) throw error;
      } else {
        // Si todavía no se juega, queda también en el calendario del equipo
        // (create_match crea el evento ligado en la misma transacción).
        const { data, error } = await db.rpc('create_match', {
          p: { ...datos, team_id: teamId, create_calendar_event: fecha >= hoy && !yaSeJugo },
        });
        if (error) throw error;
        id = (data as { match_id: string }).match_id;
      }
      qc.invalidateQueries({ queryKey: qkPartido(id) });
      qc.invalidateQueries({ queryKey: ['coach-v2', 'partidos', teamId] });
      qc.invalidateQueries({ queryKey: ['coach-v2', 'partidos-proximos'] });
      qc.invalidateQueries({ queryKey: ['match-results', teamId] });
      qc.invalidateQueries({ queryKey: ['team-matches', teamId] });
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
      toast.success(partido ? 'Partido actualizado.' : 'Partido creado.');
      onGuardado(id as string, yaSeJugo ? 'cerrar' : 'convocar');
    } catch (e) {
      console.error('[partido] programar', e);
      toast.error(mensajeError(e, 'No pudimos guardar el partido. Revisa tu conexión e inténtalo de nuevo.'));
    } finally {
      setGuardando(false);
    }
  };

  const cambiarEstado = async (status: 'cancelled' | 'scheduled') => {
    if (!partido) return;
    setGuardando(true);
    const { error } = await db.rpc('update_match', { p_match: partido.id, p: { status } });
    setGuardando(false);
    if (error) { toast.error(mensajeError(error, 'No pudimos cambiar el partido.')); return; }
    qc.invalidateQueries({ queryKey: qkPartido(partido.id) });
    qc.invalidateQueries({ queryKey: ['coach-v2', 'partidos', partido.team_id] });
    toast.success(status === 'cancelled' ? 'Partido cancelado.' : 'Partido programado de nuevo.');
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl border bg-card p-4" aria-label="Programar">
      {partido?.status === 'cancelled' && (
        <div className="rounded-xl bg-muted p-3 text-sm">
          Este partido está cancelado.
          <Button variant="outline" className="mt-2 h-11 w-full rounded-xl" disabled={guardando} onClick={() => cambiarEstado('scheduled')}>Volver a programarlo</Button>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="pf-rival" className="text-base">¿Contra quién?</Label>
        <Input id="pf-rival" className="h-12 text-base" placeholder="Ej: Halcones FC" value={rival} onChange={(e) => setRival(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="pf-fecha" className="text-base">Fecha</Label>
          <Input id="pf-fecha" type="date" className="h-12 text-base" value={fecha} onChange={(e) => setFecha(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pf-hora" className="text-base">Hora <span className="font-normal text-muted-foreground">(opcional)</span></Label>
          <Input id="pf-hora" type="time" className="h-12 text-base" value={hora} onChange={(e) => setHora(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <span className="text-base font-medium">¿Dónde jugamos?</span>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Local o visitante">
          {[{ v: true, t: 'En casa (local)' }, { v: false, t: 'De visita' }].map((o) => (
            <button
              key={String(o.v)}
              type="button"
              role="radio"
              aria-checked={local === o.v}
              onClick={() => setLocal(o.v)}
              className={cn('h-12 rounded-xl border-2 text-base font-semibold', local === o.v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}
            >
              {o.t}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pf-lugar" className="text-base">Cancha o lugar <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Input id="pf-lugar" className="h-12 text-base" placeholder="Ej: Cancha 2, Unidad Deportiva" value={lugar} onChange={(e) => setLugar(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <span className="text-base font-medium">Tipo de partido</span>
        <div className="flex flex-wrap gap-2">
          {TIPOS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tipo === t}
              onClick={() => setTipo(t)}
              className={cn('min-h-touch rounded-full border-2 px-3.5 text-sm font-semibold', tipo === t ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground')}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {vivo && <FormatoVivoCampos value={formatoVivo} onChange={setFormatoVivo} />}
      <div className="space-y-1.5">
        <Label htmlFor="pf-notas" className="text-base">Nota para las familias <span className="font-normal text-muted-foreground">(opcional)</span></Label>
        <Textarea id="pf-notas" rows={2} placeholder="Uniforme, hora de llegada…" value={notas} onChange={(e) => setNotas(e.target.value)} />
      </div>

      <div className="flex flex-col gap-2 pt-1">
        {!yaPaso && (
          <Button className="h-14 rounded-2xl text-base font-semibold" disabled={!valido || guardando} onClick={() => guardar(false)}>
            {guardando ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
            {partido ? 'Guardar y seguir a convocar' : 'Programar y convocar'}
          </Button>
        )}
        <Button
          variant={yaPaso ? 'default' : 'outline'}
          className="h-14 rounded-2xl text-base font-semibold"
          disabled={!valido || guardando}
          onClick={() => guardar(true)}
        >
          {guardando && yaPaso ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
          {yaPaso ? 'Guardar y registrar el resultado' : 'Ya se jugó: registrar el resultado'}
        </Button>
        {partido && partido.status !== 'cancelled' && partido.status !== 'played' && (
          <Button variant="ghost" className="h-12 rounded-xl text-destructive" disabled={guardando} onClick={() => cambiarEstado('cancelled')}>
            Cancelar este partido
          </Button>
        )}
      </div>
    </section>
  );
}

// ── 2. Convocar ─────────────────────────────────────────────────────────────

function PasoConvocar({ partido, schoolId, onSiguiente }: { partido: PartidoFila; schoolId: string; onSiguiente: () => void }) {
  const navigate = useNavigate();
  const vivoHabilitado = useEntitlements().liveMatchEnabled;
  const partidos = usePartidosEquipo(partido.team_id);
  const propio = aPartidoCoach(partido);
  // La convocatoria arranca con la del último partido anterior a este.
  const todos = useMemo(() => {
    const lista = partidos.data ?? [];
    return lista.some((p) => p.id === propio.id) ? lista : [propio, ...lista];
  }, [partidos.data, propio]);

  return (
    <div className="flex flex-col gap-3">
      <ConvocatoriaPartido schoolId={schoolId} teamId={partido.team_id} partido={propio} todos={todos} etiqueta="Convocatoria" />
      {vivoHabilitado && partido.status !== 'played' && partido.status !== 'cancelled' && (
        <Button className="h-14 rounded-2xl text-base font-semibold" onClick={() => navigate(`/partido-en-vivo/${encodeURIComponent(partido.id)}`)}>
          <Radio className="mr-2 h-5 w-5" aria-hidden />Iniciar partido (titulares, cambios y tiempo)
        </Button>
      )}
      <Button variant="outline" className="h-14 rounded-2xl text-base font-semibold" onClick={onSiguiente}>
        {vivoHabilitado ? 'Registrar el resultado a mano' : 'Siguiente: resultado'} <ChevronRight className="ml-1 h-5 w-5" aria-hidden />
      </Button>
    </div>
  );
}

// ── Jugadoras del partido (convocadas; sin convocatoria, todo el equipo) ────

interface Jugadora extends Sujeto {
  nombre: string;
  /** Fila de match_lineup_players (solo convocadas): ahí van los minutos. */
  filaId?: string;
  minutos?: number | null;
}

function useJugadoras(partido: PartidoFila, schoolId: string) {
  const roster = useDeportistasEquipo(schoolId, partido.team_id);
  const conv = useConvocatoria(partido.id);
  const convocados = useMemo(() => conv.data?.players ?? [], [conv.data]);
  const fuera = useMemo(() => refuerzosDe(roster.data ?? [], convocados), [roster.data, convocados]);
  const nombres = useNombresConvocados(schoolId, fuera);

  const lista = useMemo((): { convocadas: Jugadora[]; equipo: Jugadora[] } => {
    const delRoster = new Map((roster.data ?? []).map((d) => [claveSujeto(sujetoDe(d)), d.nombre]));
    const nombreDe = (s: Sujeto) => delRoster.get(claveSujeto(s)) ?? nombres.data?.get(claveSujeto(s)) ?? 'Deportista';
    return {
      convocadas: quienesSeEvaluan(convocados).map((p) => ({
        subject_type: p.subject_type, subject_id: p.subject_id, nombre: nombreDe(p), filaId: p.id, minutos: p.minutes_played ?? null,
      })),
      equipo: (roster.data ?? []).map((d) => ({ ...sujetoDe(d), nombre: d.nombre })),
    };
  }, [roster.data, convocados, nombres.data]);

  return {
    ...lista,
    isLoading: roster.isLoading || conv.isLoading,
    isError: roster.isError || conv.isError,
    refetch: () => { roster.refetch(); conv.refetch(); },
  };
}

// ── 3. Cerrar partido (resultado + goles por jugadora) ──────────────────────

const ACCIONES: Array<{ tipo: FootballEventType; texto: string; corto: string; tono: string }> = [
  { tipo: 'goal', texto: 'Gol', corto: 'G', tono: 'bg-primary text-primary-foreground' },
  { tipo: 'assist', texto: 'Asistencia', corto: 'A', tono: 'bg-sky-600 text-white' },
  { tipo: 'yellow', texto: 'Amarilla', corto: 'TA', tono: 'bg-yellow-400 text-black' },
  { tipo: 'red', texto: 'Roja', corto: 'TR', tono: 'bg-red-600 text-white' },
  { tipo: 'own_goal', texto: 'Autogol', corto: 'AG', tono: 'bg-muted text-foreground' },
];

function PasoCerrar({ partido, schoolId, equipo, deporte, onGuardado }: {
  partido: PartidoFila; schoolId: string; equipo: string; deporte: string | null; onGuardado: () => void;
}) {
  const qc = useQueryClient();
  const conEventos = usaEventosDeFutbol(deporte);
  const jugadoras = useJugadoras(partido, schoolId);
  const eventosQ = useFootballEvents({ source_type: 'team_match', source_id: conEventos ? partido.id : undefined });
  const crear = useCreateFootballEvents();
  const borrar = useDeleteFootballEvent();
  const eventos = useMemo(() => eventosQ.data ?? [], [eventosQ.data]);
  const conteo = useMemo(() => eventosPorJugadora(eventos), [eventos]);
  const guardado = marcadorPropio(partido);

  const [nuestroManual, setNuestroManual] = useState<number | null>(null);
  const [rivalManual, setRivalManual] = useState<number | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const nuestros = nuestroManual ?? marcadorNuestroSugerido(guardado.nuestros, eventos);
  const rival = rivalManual ?? marcadorRivalSugerido(guardado.rival, eventos);
  const goles = sumaGoles(eventos);

  const lista = jugadoras.convocadas.length > 0 ? jugadoras.convocadas : jugadoras.equipo;

  const sumar = async (j: Jugadora, tipo: FootballEventType) => {
    try {
      await crear.mutateAsync({
        team_id: partido.team_id,
        source_type: 'team_match',
        source_id: partido.id,
        events: [{ subject_type: j.subject_type as 'child' | 'profile' | 'unregistered', subject_id: j.subject_id, type: tipo }],
      });
    } catch (e) {
      console.error('[partido] evento', e);
      toast.error('No pudimos anotar eso. Revisa tu conexión e inténtalo de nuevo.');
    }
  };

  const quitar = async (j: Jugadora, tipo: string) => {
    const ev = ultimoEvento(eventos, claveSujeto(j), tipo);
    if (!ev) return;
    try {
      await borrar.mutateAsync(ev.id);
    } catch (e) {
      console.error('[partido] quitar evento', e);
      toast.error('No pudimos quitarlo. Inténtalo de nuevo.');
    }
  };

  const guardar = async () => {
    setGuardando(true);
    const { error } = await db.rpc('update_match', {
      p_match: partido.id,
      p: { ...aColumnasMarcador(nuestros, rival, partido.is_home), status: 'played' },
    });
    setGuardando(false);
    if (error) {
      console.error('[partido] cerrar', error);
      toast.error(mensajeError(error, 'No pudimos guardar el resultado. Inténtalo de nuevo.'));
      return;
    }
    qc.invalidateQueries({ queryKey: qkPartido(partido.id) });
    qc.invalidateQueries({ queryKey: ['coach-v2', 'partidos', partido.team_id] });
    qc.invalidateQueries({ queryKey: ['match-results', partido.team_id] });
    qc.invalidateQueries({ queryKey: ['team-matches', partido.team_id] });
    toast.success(`Resultado guardado: ${nuestros} – ${rival}.`);
    onGuardado();
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border bg-card p-4" aria-label="Marcador">
        <div className="grid grid-cols-2 gap-3">
          <Marcador titulo={equipo} valor={nuestros} onCambio={setNuestroManual} />
          <Marcador titulo={partido.opponent} valor={rival} onCambio={setRivalManual} />
        </div>
        {conEventos && goles.nuestros > 0 && nuestroManual != null && nuestroManual !== goles.nuestros && (
          <p className="mt-2 text-xs text-muted-foreground">Ojo: los goles anotados por jugadora suman {goles.nuestros}.</p>
        )}
      </section>

      {conEventos && (
        <section className="flex flex-col gap-2" aria-label="Goles y tarjetas por jugadora">
          <span className="pl-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">
            Toca una jugadora para anotar goles, asistencias o tarjetas
          </span>
          {jugadoras.isLoading ? (
            <SectionSkeleton rows={3} label="Cargando jugadoras" />
          ) : jugadoras.isError ? (
            <InlineError message="No pudimos traer a las jugadoras." onRetry={jugadoras.refetch} />
          ) : lista.length === 0 ? (
            <EmptyNote>Este equipo no tiene deportistas activos.</EmptyNote>
          ) : (
            <>
              {jugadoras.convocadas.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">No hubo convocatoria: te mostramos a todo el equipo.</p>
              )}
              <ul className="overflow-hidden rounded-2xl border bg-card">
                {lista.map((j) => {
                  const k = claveSujeto(j);
                  const c = conteo.get(k) ?? {};
                  const abierta = elegida === k;
                  return (
                    <li key={k} className="border-t first:border-t-0">
                      <button
                        type="button"
                        aria-expanded={abierta}
                        onClick={() => setElegida(abierta ? null : k)}
                        className="flex min-h-14 w-full items-center gap-2 px-4 text-left"
                      >
                        <span className="flex-1 truncate text-base font-medium">{nombreCorto(j.nombre)}</span>
                        {ACCIONES.filter((a) => (c[a.tipo] ?? 0) > 0).map((a) => (
                          <span key={a.tipo} className={cn('rounded-md px-1.5 py-0.5 text-xs font-bold', a.tono)}>
                            {a.corto}{(c[a.tipo] ?? 0) > 1 ? ` ×${c[a.tipo]}` : ''}
                          </span>
                        ))}
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', abierta && 'rotate-180')} aria-hidden />
                      </button>
                      {abierta && (
                        <div className="grid grid-cols-2 gap-2 px-3 pb-3 sm:grid-cols-3">
                          {ACCIONES.map((a) => {
                            const n = c[a.tipo] ?? 0;
                            return (
                              <div key={a.tipo} className="flex items-stretch overflow-hidden rounded-xl border">
                                <button
                                  type="button"
                                  disabled={crear.isPending}
                                  onClick={() => sumar(j, a.tipo)}
                                  className="flex min-h-12 flex-1 items-center gap-1.5 px-2.5 text-sm font-semibold active:bg-muted"
                                  aria-label={`Sumar ${a.texto.toLowerCase()} a ${j.nombre}`}
                                >
                                  <Plus className="h-4 w-4" aria-hidden /> {a.texto}
                                  {n > 0 && <span className={cn('ml-auto rounded-md px-1.5 text-xs', a.tono)}>{n}</span>}
                                </button>
                                {n > 0 && (
                                  <button
                                    type="button"
                                    disabled={borrar.isPending}
                                    onClick={() => quitar(j, a.tipo)}
                                    className="flex w-11 items-center justify-center border-l text-muted-foreground active:bg-muted"
                                    aria-label={`Quitar ${a.texto.toLowerCase()} a ${j.nombre}`}
                                  >
                                    <Minus className="h-4 w-4" aria-hidden />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      <div className={BARRA_GUARDAR} data-testid="barra-guardar-partido">
        <div className="mx-auto max-w-xl">
          <Button className="h-14 w-full rounded-2xl text-base font-semibold" disabled={guardando} onClick={guardar}>
            {guardando && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            Guardar resultado {nuestros} – {rival}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Marcador({ titulo, valor, onCambio }: { titulo: string; valor: number; onCambio: (v: number) => void }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="w-full truncate text-center text-sm font-semibold text-muted-foreground">{titulo}</span>
      <span className="text-5xl font-bold tabular-nums" aria-live="polite">{valor}</span>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-12 w-12 rounded-xl" disabled={valor <= 0} onClick={() => onCambio(Math.max(0, valor - 1))} aria-label={`Restar un gol a ${titulo}`}>
          <Minus className="h-5 w-5" />
        </Button>
        <Button type="button" variant="outline" className="h-12 w-12 rounded-xl" onClick={() => onCambio(valor + 1)} aria-label={`Sumar un gol a ${titulo}`}>
          <Plus className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}

// ── 4. Evaluar (solo convocadas) ────────────────────────────────────────────

function PasoEvaluar({ partido, schoolId, esAdmin, onIrAConvocar, onSiguiente }: {
  partido: PartidoFila; schoolId: string; esAdmin: boolean; onIrAConvocar: () => void; onSiguiente: () => void;
}) {
  const qc = useQueryClient();
  const jugadoras = useJugadoras(partido, schoolId);
  const criteriosQ = useCriteriosEscuela(schoolId);
  const globales = useSchoolPerformanceMetrics();
  const guardadas = useEvaluacionPartido(partido.id);
  const compartir = useCompartirEvaluaciones(schoolId);
  const vivo = useMinutosVivo(partido.id, schoolId); // null con flag apagado o sin registro en vivo
  const minutosBase = (j: Jugadora): number | '' => vivo?.get(claveSujeto(j)) ?? j.minutos ?? '';

  const deEscuela = useMemo(() => criteriosDePartido(criteriosQ.data ?? []), [criteriosQ.data]);
  const usaEscuela = deEscuela.length > 0;
  const metricas: EvaluationMetric[] = useMemo(() => {
    if (usaEscuela) return deEscuela.map(aMetricaRapida);
    // Sin criterios de partido de la escuela: los generales del deporte (o la lista que la escuela eligió para entrenos).
    return readEvaluation(globales.data as Parameters<typeof readEvaluation>[0]).quick;
  }, [usaEscuela, deEscuela, globales.data]);

  const [planilla, setPlanilla] = useState<Planilla | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [publicando, setPublicando] = useState(false);
  // Minutos editados en esta pantalla (clave del sujeto → valor); lo no tocado sale de la convocatoria.
  const [minutos, setMinutos] = useState<Record<string, number | ''>>({});

  useEffect(() => {
    if (planilla || !guardadas.data || metricas.length === 0) return;
    setPlanilla(planillaDesdeFilas(guardadas.data, metricas));
  }, [planilla, guardadas.data, metricas]);

  const evaluables = jugadoras.convocadas;
  const p = planilla ?? {};
  const listas = evaluadasDe(p, metricas, evaluables);
  const hayGuardado = (guardadas.data?.length ?? 0) > 0;
  const publicada = !!partido.evaluation_published_at;

  const poner = (clave: string, metric: string, v: { value?: number | ''; notes?: string }) =>
    setPlanilla((prev) => {
      const base = prev ?? {};
      return { ...base, [clave]: { ...(base[clave] ?? {}), [metric]: v } };
    });

  const minutosDe = (j: Jugadora): number | '' => {
    const k = claveSujeto(j);
    return k in minutos ? minutos[k] : minutosBase(j);
  };

  const guardar = async () => {
    const entradas = entradasEvaluacion(p, metricas, evaluables);
    // Solo las filas cuyo valor cambió. UPDATE directo de minutes_played: no
    // pasa por save_match_roster, que borra y reinserta (perdería la pizarra).
    const cambiosMin = evaluables.filter((j) => j.filaId && claveSujeto(j) in minutos && minutosDe(j) !== minutosBase(j));
    if (cambiosMin.some((j) => { const v = minutosDe(j); return v !== '' && (!Number.isInteger(v) || v < 0 || v > 200); })) {
      toast.error('Los minutos van en números enteros, entre 0 y 200.');
      return;
    }
    if (entradas.length === 0 && cambiosMin.length === 0) { toast.info('Califica al menos un criterio o pon los minutos antes de guardar.'); return; }
    setGuardando(true);
    if (cambiosMin.length > 0) {
      const res = await Promise.all(cambiosMin.map((j) => {
        const v = minutosDe(j);
        return db.from('match_lineup_players').update({ minutes_played: v === '' ? null : v }).eq('id', j.filaId).select('id');
      }));
      const fallo = res.find((r: { error: unknown; data: unknown[] | null }) => r.error || !r.data?.length);
      if (fallo) {
        setGuardando(false);
        console.error('[partido] minutos', fallo.error);
        toast.error('No pudimos guardar los minutos. Inténtalo de nuevo.');
        return;
      }
      setMinutos({});
      qc.invalidateQueries({ queryKey: ['coach-v2', 'convocatoria', partido.id] });
    }
    if (entradas.length > 0) {
      const { error } = await db.rpc('submit_match_evaluation', { p_match: partido.id, p_entries: entradas });
      if (error) {
        setGuardando(false);
        console.error('[partido] evaluar', error);
        toast.error(mensajeError(error, 'No pudimos guardar la evaluación. Inténtalo de nuevo.'));
        return;
      }
      qc.invalidateQueries({ queryKey: qkEvaluacion(partido.id) });
      qc.invalidateQueries({ queryKey: qkPartido(partido.id) });
    }
    setGuardando(false);
    toast.success(entradas.length > 0
      ? `Evaluación guardada (${listas} ${listas === 1 ? 'deportista' : 'deportistas'}).`
      : 'Minutos guardados.');
  };

  const publicar = async (si: boolean) => {
    setPublicando(true);
    const { error } = await db.rpc('publish_match_evaluation', { p_match: partido.id, p_publish: si });
    setPublicando(false);
    if (error) { toast.error(mensajeError(error, 'No pudimos cambiar la publicación.')); return; }
    qc.invalidateQueries({ queryKey: qkPartido(partido.id) });
    toast.success(si ? 'Publicada: cada familia ve solo la evaluación de su deportista.' : 'Evaluación oculta para las familias.');
  };

  const cambiarCompartir = async (si: boolean) => {
    const { data, error } = await db.from('school_settings').update({ share_match_evaluations: si }).eq('school_id', schoolId).select('school_id');
    if (error || !data?.length) {
      toast.error('No pudimos cambiar el ajuste de la escuela.');
      return;
    }
    qc.invalidateQueries({ queryKey: ['partido-compartir', schoolId] });
  };

  const sembrar = async () => {
    const { error } = await db.rpc('seed_school_match_criteria', { p_school: schoolId });
    if (error) { toast.error(mensajeError(error, 'No pudimos crear los criterios.')); return; }
    setPlanilla(null);
    qc.invalidateQueries({ queryKey: ['partido-criterios', schoolId] });
    toast.success('Listo: la escuela ya tiene criterios para evaluar partidos.');
  };

  if (jugadoras.isLoading || criteriosQ.isLoading || guardadas.isLoading || (!usaEscuela && globales.isLoading)) {
    return <SectionSkeleton rows={4} label="Cargando la evaluación" />;
  }
  if (jugadoras.isError || guardadas.isError) {
    return <InlineError message="No pudimos traer la evaluación." onRetry={() => { jugadoras.refetch(); guardadas.refetch(); }} />;
  }
  if (evaluables.length === 0) {
    return (
      <EmptyNote>
        <p className="font-semibold text-foreground">Primero convoca.</p>
        <p className="mt-1">Solo se evalúa a quienes quedaron convocados a este partido.</p>
        <Button className="mt-3 h-12 rounded-xl" onClick={onIrAConvocar}>Ir a convocar</Button>
      </EmptyNote>
    );
  }
  if (metricas.length === 0) {
    return (
      <EmptyNote>
        <p className="font-semibold text-foreground">No hay criterios para evaluar.</p>
        {esAdmin ? (
          <Button className="mt-3 h-12 rounded-xl" onClick={sembrar}>Usar los criterios sugeridos para partidos</Button>
        ) : (
          <p className="mt-1">Pídele a la administración de la escuela que defina los criterios de evaluación.</p>
        )}
      </EmptyNote>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-sm text-muted-foreground">
        {listas} de {evaluables.length} evaluadas. Toca cada deportista, pon sus minutos y califica. Lo que dejes en blanco no se guarda.
      </p>
      {!usaEscuela && (
        <div className="rounded-xl bg-muted p-3 text-xs text-muted-foreground">
          Estos son los criterios generales del deporte.
          {esAdmin ? (
            <Button variant="outline" className="mt-2 h-11 w-full rounded-xl" onClick={sembrar}>Crear criterios de partido de la escuela</Button>
          ) : ' La administración puede definir los de la escuela.'}
        </div>
      )}

      <ul className="overflow-hidden rounded-2xl border bg-card">
        {evaluables.map((j) => {
          const k = claveSujeto(j);
          const abiertaEsta = abierta === k;
          const hechos = entradasEvaluacion({ [k]: p[k] ?? {} }, metricas, [j]).length;
          return (
            <li key={k} className="border-t first:border-t-0">
              <button
                type="button"
                aria-expanded={abiertaEsta}
                onClick={() => setAbierta(abiertaEsta ? null : k)}
                className="flex min-h-14 w-full items-center gap-2 px-4 text-left"
              >
                <span className="flex-1 py-2 text-base font-medium leading-tight">{j.nombre}</span>
                {minutosDe(j) !== '' && <span className="text-sm font-semibold tabular-nums text-muted-foreground">{minutosDe(j)}′</span>}
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', hechos > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
                  {hechos}/{metricas.length}
                </span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', abiertaEsta && 'rotate-180')} aria-hidden />
              </button>
              {abiertaEsta && (
                <div className="flex flex-col gap-4 px-4 pb-4">
                  {j.filaId && (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`min-${k}`} className="text-sm font-semibold">Minutos jugados</Label>
                      <Input
                        id={`min-${k}`}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={200}
                        placeholder="Ej: 45"
                        className="h-12 w-28 rounded-xl text-base"
                        value={minutosDe(j)}
                        onChange={(e) => setMinutos((prev) => ({ ...prev, [k]: e.target.value === '' ? '' : Number(e.target.value) }))}
                      />
                    </div>
                  )}
                  {metricas.map((mt) => {
                    const v = p[k]?.[mt.metric_key];
                    return (
                      <div key={mt.metric_key} className="flex flex-col gap-1.5">
                        <span className="text-sm font-semibold">{mt.display_name}</span>
                        {mt.scale === 'text' ? (
                          <Textarea rows={2} value={v?.notes ?? ''} placeholder="Escribe un comentario corto" onChange={(e) => poner(k, mt.metric_key, { notes: e.target.value })} />
                        ) : (
                          <QuickMetricInput metric={mt} value={v?.value ?? ''} onChange={(val) => poner(k, mt.metric_key, { value: val })} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4" aria-label="Publicar a las familias">
        <span className="text-base font-semibold">Familias</span>
        {compartir.data ? (
          <>
            <p className="text-sm text-muted-foreground">
              {publicada ? 'Publicada: cada familia ve solo la evaluación de su deportista.' : 'Las familias todavía no la ven. Cada una verá solo la de su deportista.'}
            </p>
            <Button
              variant={publicada ? 'outline' : 'default'}
              className="h-12 rounded-xl"
              disabled={publicando || (!publicada && !hayGuardado)}
              onClick={() => publicar(!publicada)}
            >
              {publicando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {publicada ? 'Dejar de mostrar a las familias' : hayGuardado ? 'Publicar a las familias' : 'Guarda la evaluación para poder publicarla'}
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Tu escuela no comparte las evaluaciones de partido con las familias. Quedan solo para el cuerpo técnico.
            </p>
            {esAdmin && compartir.data === false && (
              <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
                <span>Compartir con las familias las evaluaciones de partido (toda la escuela)</span>
                <Switch checked={false} onCheckedChange={(v) => cambiarCompartir(v)} />
              </label>
            )}
          </>
        )}
      </section>

      <div className={BARRA_GUARDAR} data-testid="barra-guardar-partido">
        <div className="mx-auto flex max-w-xl gap-2">
          <Button className="h-14 flex-1 rounded-2xl text-base font-semibold" disabled={guardando} onClick={guardar}>
            {guardando && <Loader2 className="mr-2 h-5 w-5 animate-spin" />}
            Guardar evaluación
          </Button>
          <Button variant="outline" className="h-14 rounded-2xl px-4" onClick={onSiguiente} aria-label="Siguiente: reporte">
            Reporte <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 5. Reporte ──────────────────────────────────────────────────────────────

function PasoReporte({ partido, onTerminar }: { partido: PartidoFila; onTerminar: () => void }) {
  const reportes = useMatchReports([partido.id]);
  const [abierto, setAbierto] = useState(false);
  const r = reportes.data?.[partido.id] ?? null;
  const res = marcadorPropio(partido);

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4" aria-label="Reporte del partido">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" aria-hidden />
          <span className="text-base font-semibold">Reporte del partido</span>
        </div>
        {res.nuestros != null && res.rival != null && (
          <p className="text-sm text-muted-foreground">Quedó {res.nuestros} – {res.rival} contra {partido.opponent}.</p>
        )}
        <p className="text-sm text-muted-foreground">
          {reportes.isLoading ? 'Cargando…' : !r ? 'Todavía no hay reporte. Cuenta cómo fue el partido y qué van a trabajar.' : r.published_at ? 'Reporte publicado a las familias.' : 'Reporte guardado, sin publicar.'}
        </p>
        <Button className="h-12 rounded-xl" onClick={() => setAbierto(true)} disabled={reportes.isLoading}>
          {r ? 'Ver o editar el reporte' : 'Escribir el reporte'}
        </Button>
      </section>
      <Button variant="outline" className="h-14 rounded-2xl text-base font-semibold" onClick={onTerminar}>
        <X className="mr-1 h-5 w-5" aria-hidden /> Terminar
      </Button>
      <MatchReportDialog
        open={abierto}
        onOpenChange={setAbierto}
        match={{ id: partido.id, opponent: partido.opponent, match_date: partido.match_date }}
        report={r}
      />
    </div>
  );
}
