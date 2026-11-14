/**
 * Asistencia del entrenador — V2 (lienzo «CoaAsistencia», docs/specs/entrenador-deportista-v2.md).
 *
 * Dos pestañas:
 *  - Tomar lista: todos arrancan en «Vino»; un toque rota Vino → Faltó → Excusa → Tarde
 *    (decisión 2). Quien avisó por WhatsApp arranca en «Excusa». «Guardar» deja 8 s
 *    para «Deshacer» y luego sube. SIN SEÑAL la lista queda en el teléfono y sube sola
 *    al volver la red (colaAsistencia.ts, mismo mecanismo que LiveScorer).
 *  - Historial: planillas de papel por revisar, entrenos con lista (corregir hasta el
 *    día siguiente, también en planes) y quién falta mucho.
 *
 * Mismos endpoints que CoachAttendancePage (que queda intacta como versión clásica):
 * POST /api/v1/attendance/session, PATCH …/finalize y …/reopen, roster y sesión del BFF.
 * El profe no ve plata (decisión 5): aquí no hay montos ni estado de pago.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ScanLine, WifiOff, CloudUpload, ChevronRight, CalendarCheck, Lock, AlertTriangle, RotateCcw, Loader2, Check, X, Camera,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { useCoachStaffId } from '@/hooks/useCoachStaffId';
import { useSchoolAthleteAvailability } from '@/hooks/useSchoolAthleteAvailability';
import { useUpdatePTAttendance, useHandleNoShow } from '@/hooks/useAthleteSessionBookings';
import { useToast } from '@/hooks/use-toast';
import { bffClient } from '@/lib/api/bffClient';
import { todayColombia } from '@/lib/dateUtils';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AvisoFichaStaff } from '@/components/common/AvisoFichaStaff';
import { AvailabilityBadge } from '@/components/clinical/AvailabilityBadge';
import {
  ETIQUETA, capitalizar, construirRegistros, estadoDesdeRegistros, estadoInicial, faltanMucho, fechaHumana, fechaMinimaCorregible,
  horaHumana, iniciales, opcionDeFecha, opcionesDeDia, porcentajeAsistencia, resumir, sePuedeCorregir, siguienteEstado, sumarDias,
  textoAyuda, textoListaGuardada, textoVentanaCorreccion,
  type EstadoLista, type OpcionDia,
} from './asistenciaModel';
import { DESHACER_MS, claveLista } from './colaAsistencia';
import { useColaAsistencia, useWakeLock } from './useCoachV2Senal';
import {
  cerrarListaSesion, claveContexto, esAdministracion, useClasesHoy, useEquiposCoach, useHistorial, useOrigenClase, usePlanesCoach,
  usePlanillasPorRevisar, usePtDeHoy, useRoster, useSesionDelDia, useSoloEquipos,
  type ContextoLista, type RosterV2,
} from './useAsistenciaV2Data';

/* eslint-disable @typescript-eslint/no-explicit-any -- respuestas del BFF sin tipar (PT, finalize), igual que la versión clásica */

const MOTIVO_AUSENCIA: Record<string, string> = {
  enfermedad: 'enfermo/a', cita_medica: 'cita médica', viaje: 'de viaje', lesion: 'lesión', colegio: 'colegio', familiar: 'asunto familiar',
};

/** Colores por estado: claro y oscuro. */
const ESTILO: Record<EstadoLista, { pill: string; avatar: string; fila: string }> = {
  present: {
    pill: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    avatar: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    fila: 'bg-card',
  },
  absent: {
    pill: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
    avatar: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
    fila: 'bg-red-50/70 dark:bg-red-950/20',
  },
  excused: {
    pill: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
    avatar: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
    fila: 'bg-amber-50/60 dark:bg-amber-950/20',
  },
  late: {
    pill: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-300',
    avatar: 'bg-sky-100 text-sky-900 dark:bg-sky-950/60 dark:text-sky-300',
    fila: 'bg-sky-50/60 dark:bg-sky-950/20',
  },
};

const vibrar = (ms: number) => { try { navigator.vibrate?.(ms); } catch { /* sin vibración */ } };

function Segmentado<T extends string>({ opciones, valor, onCambio, etiqueta }: {
  opciones: { v: T; l: string }[]; valor: T; onCambio: (v: T) => void; etiqueta: string;
}) {
  return (
    <div role="tablist" aria-label={etiqueta} className="grid gap-1 rounded-xl bg-muted p-1" style={{ gridTemplateColumns: `repeat(${opciones.length}, minmax(0, 1fr))` }}>
      {opciones.map((o) => (
        <button
          key={o.v} type="button" role="tab" aria-selected={valor === o.v} onClick={() => onCambio(o.v)}
          className={cn('min-h-touch rounded-lg px-3 text-sm transition-colors',
            valor === o.v ? 'bg-background font-semibold shadow-sm' : 'font-medium text-muted-foreground hover:text-foreground')}
        >{o.l}</button>
      ))}
    </div>
  );
}

export interface CoachAttendanceV2Props {
  /** Pestaña inicial. */
  tabInicial?: 'lista' | 'historial';
}

export default function CoachAttendanceV2({ tabInicial = 'lista' }: CoachAttendanceV2Props) {
  const [tab, setTab] = useState<'lista' | 'historial'>(tabInicial);
  // «Corregir» desde el Historial abre la lista de ese entreno y esa fecha.
  const [pedido, setPedido] = useState<{ ctx: ContextoLista; fecha: string } | null>(null);

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 px-gutter pb-nav-safe pt-4 md:max-w-page md:pb-8">
      <header className="space-y-0.5">
        <h1 className="text-2xl font-bold tracking-tight">Asistencia</h1>
        <p className="text-sm text-muted-foreground">{capitalizar(fechaHumana(todayColombia()))}</p>
      </header>
      <Segmentado<'lista' | 'historial'>
        etiqueta="Asistencia" valor={tab} onCambio={setTab}
        opciones={[{ v: 'lista', l: 'Tomar lista' }, { v: 'historial', l: 'Historial' }]}
      />
      {tab === 'lista'
        ? <TomarLista pedido={pedido} onPedidoAtendido={() => setPedido(null)} />
        : <Historial onCorregir={(ctx, fecha) => { setPedido({ ctx, fecha }); setTab('lista'); }} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tomar lista
// ─────────────────────────────────────────────────────────────────────────────

function TomarLista({ pedido, onPedidoAtendido }: { pedido: { ctx: ContextoLista; fecha: string } | null; onPedidoAtendido: () => void }) {
  const { user } = useAuth();
  const { schoolId, currentUserRole } = useSchoolContext();
  const { coachAttendanceRetroDays } = useEntitlements();
  const { staffId, estado: estadoFicha, refetch: refetchFicha } = useCoachStaffId();
  const navigate = useNavigate();
  const isAdmin = esAdministracion(currentUserRole);
  const hoy = todayColombia();

  const equiposQ = useEquiposCoach(schoolId, user?.id, staffId, isAdmin);
  const soloEquiposQ = useSoloEquipos(schoolId);
  const planesQ = usePlanesCoach(schoolId, staffId, isAdmin);
  const clasesQ = useClasesHoy(schoolId, hoy, staffId, user?.id, isAdmin);
  const equipos = useMemo(() => equiposQ.data ?? [], [equiposQ.data]);
  const planes = useMemo(() => (soloEquiposQ.data ? [] : planesQ.data ?? []), [planesQ.data, soloEquiposQ.data]);
  const clases = useMemo(() => clasesQ.data ?? [], [clasesQ.data]);

  const [ctx, setCtx] = useState<ContextoLista | null>(null);
  const [fecha, setFecha] = useState(hoy);
  const [autoNota, setAutoNota] = useState<string | null>(null);
  const [elegir, setElegir] = useState(false);
  const retroDias = coachAttendanceRetroDays;

  // Pedido desde el Historial («Corregir»).
  useEffect(() => {
    if (!pedido) return;
    setCtx(pedido.ctx); setFecha(pedido.fecha); setAutoNota(null); setElegir(false);
    onPedidoAtendido();
  }, [pedido, onPedidoAtendido]);

  // Auto-selección (misma regla que la versión clásica, §1.2 de asistencia-rapida-checkin):
  // una sola clase de plan hoy → esa; si no, un solo equipo; si no, el equipo habitual de este día.
  const autoHecha = useRef(false);
  // isPending (no isLoading): mientras la escuela no se conoce la consulta está apagada y no hay que tomarla por «sin equipos».
  const cargandoOpciones = equiposQ.isPending || planesQ.isPending || clasesQ.isPending || soloEquiposQ.isPending;
  useEffect(() => {
    if (autoHecha.current || ctx || cargandoOpciones) return;
    autoHecha.current = true;
    if (clases.length === 1) {
      setCtx({ tipo: 'session', id: clases[0].id, nombre: clases[0].name });
      setAutoNota('Tu clase de hoy');
      return;
    }
    if (clases.length === 0 && equipos.length === 1 && planes.length === 0) {
      setCtx({ tipo: 'team', id: equipos[0].id, nombre: equipos[0].name });
      setAutoNota('Tu equipo');
      return;
    }
    if (clases.length === 0 && equipos.length > 1) {
      try {
        const id = localStorage.getItem(`sm_last_team_weekday_${new Date().getDay()}`);
        const e = id ? equipos.find((x) => x.id === id) : undefined;
        if (e) { setCtx({ tipo: 'team', id: e.id, nombre: e.name }); setAutoNota('El que sueles tener este día'); return; }
      } catch { /* almacenamiento bloqueado */ }
    }
    setElegir(true);
  }, [cargandoOpciones, ctx, clases, equipos, planes]);

  const elegirCtx = (c: ContextoLista) => {
    setCtx(c); setAutoNota(null); setElegir(false); setFecha(hoy);
    if (c.tipo === 'team') {
      try { localStorage.setItem(`sm_last_team_weekday_${new Date().getDay()}`, c.id); } catch { /* sin almacenamiento */ }
    }
  };

  const sinOpciones = !cargandoOpciones && equipos.length === 0 && planes.length === 0 && clases.length === 0;
  const errorOpciones = equiposQ.isError && !equiposQ.data;

  return (
    <div className="space-y-4">
      {!isAdmin && <AvisoFichaStaff estado={estadoFicha} onReintentar={refetchFicha} queSePierde="tus equipos para pasar lista" />}

      {cargandoOpciones && !ctx ? (
        <div className="flex items-center gap-2 rounded-2xl border bg-card p-4 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> Buscando tus equipos…
        </div>
      ) : errorOpciones ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <p className="font-semibold">No pudimos cargar tus equipos.</p>
          <p className="text-muted-foreground">Revisa la señal e inténtalo otra vez.</p>
          <Button variant="outline" className="mt-3 min-h-touch" onClick={() => void equiposQ.refetch()}>Reintentar</Button>
        </div>
      ) : sinOpciones ? (
        <div className="rounded-2xl border bg-card p-5 text-center">
          <p className="font-semibold">No tienes equipos ni clases asignadas</p>
          <p className="mt-1 text-sm text-muted-foreground">Cuando la escuela te asigne un equipo, aquí tomas la lista.</p>
        </div>
      ) : (
        <>
          {ctx && !elegir ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border bg-card p-3">
              <div className="min-w-[7rem] flex-1">
                <p className="truncate font-semibold" data-testid="lista-titulo">{ctx.nombre}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {autoNota ? `${autoNota} · ` : ''}{ctx.tipo === 'team' ? 'Equipo' : 'Clase de plan'}
                </p>
              </div>
              <Button variant="ghost" className="min-h-touch shrink-0" onClick={() => setElegir(true)}>Cambiar</Button>
            </div>
          ) : (
            <SelectorLista equipos={equipos} planes={planes} clases={clases} actual={ctx} onElegir={elegirCtx} onCerrar={ctx ? () => setElegir(false) : undefined} />
          )}

          <Button
            variant="outline" className="min-h-touch w-full justify-start gap-2"
            onClick={() => navigate('/coach-attendance/scan')}
          >
            <ScanLine className="h-4 w-4" /> Escanear carnets en la entrada
          </Button>

          {ctx && !elegir && (
            <ListaDelEntreno
              key={`${claveContexto(ctx)}|${fecha}`}
              ctx={ctx} fecha={fecha} retroDias={retroDias} hoy={hoy} onFecha={setFecha}
              onElegirClase={(id) => elegirCtx({ tipo: 'session', id, nombre: ctx.nombre })}
            />
          )}
        </>
      )}

      <ReservasPersonales hoy={hoy} />
    </div>
  );
}

function SelectorLista({ equipos, planes, clases, actual, onElegir, onCerrar }: {
  equipos: { id: string; name: string; current_students: number | null }[];
  planes: { id: string; name: string }[];
  clases: { id: string; name: string; start_time: string | null }[];
  actual: ContextoLista | null;
  onElegir: (c: ContextoLista) => void;
  onCerrar?: () => void;
}) {
  const fila = (key: string, titulo: string, nota: string, c: ContextoLista) => (
    <button
      key={key} type="button" onClick={() => onElegir(c)}
      className={cn('flex min-h-touch w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/50',
        actual && claveContexto(actual) === key && 'bg-primary/5')}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{titulo}</span>
        {nota && <span className="block truncate text-xs text-muted-foreground">{nota}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
  return (
    <section className="space-y-2" aria-label="Elige la lista">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">¿De quién tomas lista?</h2>
        {onCerrar && <Button variant="ghost" size="sm" className="min-h-touch" onClick={onCerrar}>Cancelar</Button>}
      </div>
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {clases.map((c) => fila(`session:${c.id}`, c.name, `Clase de hoy${horaHumana(c.start_time) ? ` · ${horaHumana(c.start_time)}` : ''}`, { tipo: 'session', id: c.id, nombre: c.name }))}
        {equipos.map((e) => fila(`team:${e.id}`, e.name, e.current_students != null ? `${e.current_students} ${e.current_students === 1 ? 'deportista' : 'deportistas'}` : 'Equipo', { tipo: 'team', id: e.id, nombre: e.name }))}
        {planes.map((p) => fila(`offering:${p.id}`, p.name, 'Plan', { tipo: 'offering', id: p.id, nombre: p.name }))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ListaDelEntreno({ ctx, fecha, retroDias, hoy, onFecha, onElegirClase }: {
  ctx: ContextoLista; fecha: string; retroDias: number; hoy: string;
  onFecha: (f: string) => void; onElegirClase: (sessionId: string) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { byChildId, byProfileId } = useSchoolAthleteAvailability(schoolId);
  useWakeLock(true); // en la cancha, la pantalla no se apaga mientras se toma lista

  const origenQ = useOrigenClase(ctx.tipo === 'session' ? ctx.id : null);
  const rosterTipo = ctx.tipo === 'team' ? 'team' : ctx.tipo === 'offering' ? 'offering'
    : origenQ.data?.team_id ? 'team' : origenQ.data?.offering_id ? 'offering' : null;
  const rosterId = ctx.tipo === 'session' ? (origenQ.data?.team_id ?? origenQ.data?.offering_id ?? null) : ctx.id;
  const rosterQ = useRoster(rosterTipo, rosterId);
  const sesionQ = useSesionDelDia(ctx, fecha);

  const key = schoolId ? claveLista(schoolId, claveContexto(ctx), fecha) : '';
  const avisoSesion = useRef(false);
  const { cola, online, flush } = useColaAsistencia(user?.id, (ev) => {
    for (const e of ev) {
      // Un aviso por pantalla: con la sesión vencida la cola espera con backoff, no hace falta repetirlo.
      if (e.type === 'auth_error' && !avisoSesion.current) {
        avisoSesion.current = true;
        toast({ title: 'No se pudo subir la lista', description: 'Tu sesión venció. Vuelve a entrar: la lista sigue guardada en el teléfono.', variant: 'destructive' });
      }
      if (e.type === 'sent') avisoSesion.current = false;
    }
  });
  const enCola = key ? cola?.get(key) : undefined;

  // La lista salió de la cola (la subió esta pantalla, el sincronizador global u
  // otra pestaña): se refresca la sesión y el historial. Va por el cambio de la
  // cola (onChange), no por el evento de envío de ESTA pantalla.
  const enColaPrevia = useRef(enCola);
  useEffect(() => {
    const previa = enColaPrevia.current;
    enColaPrevia.current = enCola;
    if (previa && !previa.error && !enCola) {
      void queryClient.invalidateQueries({ queryKey: ['v2-asis-sesion', claveContexto(ctx), fecha] });
      void queryClient.invalidateQueries({ queryKey: ['v2-asis-historial'] });
    }
  }, [enCola, queryClient, ctx, fecha]);

  const roster: RosterV2[] = useMemo(() => rosterQ.data?.athletes ?? [], [rosterQ.data]);
  const [estado, setEstado] = useState<Record<string, EstadoLista>>({});
  const [editando, setEditando] = useState(true);
  const [isSecondary, setIsSecondary] = useState(false);
  const [masOpciones, setMasOpciones] = useState(false);
  const [ahora, setAhora] = useState(Date.now());
  const iniciado = useRef(false);

  // Estado inicial UNA vez por lista: lo guardado en el teléfono manda, luego la base, luego «todos Vino».
  useEffect(() => {
    if (iniciado.current || !rosterQ.data || sesionQ.isPending) return;
    iniciado.current = true;
    const local = enCola ? estadoDesdeRegistros(enCola.payload.records) : null;
    setEstado(estadoInicial(roster, sesionQ.data?.records, local));
    if (enCola) setEditando(false);
  }, [rosterQ.data, sesionQ.isPending, sesionQ.data, roster, enCola]);

  // Reloj para la ventana de Deshacer.
  const enVentana = !!enCola && enCola.holdUntil > ahora;
  useEffect(() => {
    if (!enVentana) return;
    const t = setInterval(() => setAhora(Date.now()), 250);
    return () => clearInterval(t);
  }, [enVentana]);
  // Al cerrarse la ventana, subir de una vez (sin esperar al siguiente turno de 2 s).
  useEffect(() => {
    if (enCola && !enVentana && online) void flush(true);
  }, [enVentana, enCola, online, flush]);
  // Si sale de la pantalla con la lista en la ventana, se suelta: Deshacer ya no aplica.
  useEffect(() => () => { if (key) cola?.soltar(key); }, [cola, key]);

  const sesion = sesionQ.data?.session ?? null;
  const cerrada = sesion?.finalized === true;
  const ids = useMemo(() => roster.map((a) => a.id), [roster]);
  const r = resumir(estado, ids);
  const primerAviso = roster.find((a) => estado[a.id] === 'excused' && a.aviso_ausencia)?.full_name.split(' ')[0] ?? null;
  const puedeEditar = editando && !cerrada && !sesionQ.data?.varias && !sesionQ.data?.sinClase;
  const sePuedeGuardar = sePuedeCorregir(fecha, hoy, retroDias) && !!schoolId && roster.length > 0;
  const opcionesDia = opcionesDeDia(retroDias);
  const elegirDia = (o: OpcionDia) => {
    if (o === 'hoy') onFecha(hoy);
    else if (o === 'ayer') onFecha(sumarDias(hoy, -1));
    else if (opcionDeFecha(fecha, hoy) !== 'otro') onFecha(sumarDias(hoy, -2));
  };

  const tocar = (id: string) => {
    if (!puedeEditar) return;
    vibrar(10);
    setEstado((prev) => ({ ...prev, [id]: siguienteEstado(prev[id]) }));
  };

  const guardar = () => {
    if (!schoolId || !sePuedeGuardar) return;
    vibrar(18);
    // Clase de plan: siempre por sessionId (la ruta /session es idempotente por sesión + deportista).
    const sessionId = ctx.tipo === 'team' ? sesion?.id : (ctx.tipo === 'session' ? ctx.id : sesion?.id);
    if (ctx.tipo !== 'team' && !sessionId) {
      toast({ title: 'Este plan no tiene clase ese día', description: 'Elige la clase en «Cambiar».', variant: 'destructive' });
      return;
    }
    cola?.guardar({
      key, schoolId,
      etiqueta: `${ctx.nombre} · ${fecha === hoy ? 'hoy' : fechaHumana(fecha)}`,
      payload: {
        ...(ctx.tipo === 'team' ? { teamId: ctx.id } : {}),
        ...(sessionId ? { sessionId } : {}),
        date: fecha,
        records: construirRegistros(roster, estado, isSecondary),
      },
    }, DESHACER_MS);
    setAhora(Date.now());
    setEditando(false);
  };

  const deshacer = () => {
    if (cola?.deshacer(key)) { setEditando(true); vibrar(10); }
  };

  const reintentar = (k: string = key) => {
    if (cola?.reintentar(k)) void flush(true);
  };

  // «Cerrar y evaluar»: un toque cierra la lista (sale la encuesta a las
  // familias) y abre la evaluación, que exige la lista cerrada. Antes el botón
  // grande era «Evaluar al equipo» sin cerrar y caía en «Primero cierra la
  // lista»: en Besser no salió encuesta ni evaluación del 24 al 29 de octubre.
  const finalizar = useMutation({
    mutationFn: async () => {
      if (!sesion?.id) throw new Error('Guarda la lista antes de cerrarla.');
      return cerrarListaSesion(sesion.id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['v2-asis-sesion', claveContexto(ctx), fecha] });
      toast({ title: 'Lista cerrada', description: 'Ahora cuéntanos cómo le fue a cada uno.' });
      // B10: la V2 califica en «Evaluar al equipo» (Bien · Normal · Le costó);
      // el modal viejo de porcentajes ya no se abre.
      if (sesion?.id) navigate(`/coach/evaluar/${sesion.id}`);
    },
    onError: (e: Error) => toast({ title: 'No se pudo cerrar la lista', description: e.message, variant: 'destructive' }),
  });

  const reabrir = useMutation({
    mutationFn: async () => {
      if (!sesion?.id) throw new Error('No hay lista que reabrir.');
      return bffClient.patch<any>(`/api/v1/attendance/session/${sesion.id}/reopen`, {});
    },
    onSuccess: (b: any) => {
      void queryClient.invalidateQueries({ queryKey: ['v2-asis-sesion', claveContexto(ctx), fecha] });
      setEditando(true);
      toast({ title: 'Lista reabierta', description: b?.aviso });
    },
    onError: (e: Error) => toast({ title: 'No se pudo reabrir', description: e.message, variant: 'destructive' }),
  });

  const cargando = (ctx.tipo === 'session' && origenQ.isPending) || (!!rosterId && rosterQ.isPending) || sesionQ.isPending;
  const errorCarga = (rosterQ.isError && !rosterQ.data) || (ctx.tipo === 'session' && origenQ.isError && !origenQ.data);
  const pendientesOtras = (cola?.pendientes() ?? []).filter((i) => i.key !== key);
  const atascadasOtras = (cola?.rechazadas() ?? []).filter((i) => i.key !== key);
  const segundosVentana = enVentana ? Math.max(1, Math.ceil((enCola!.holdUntil - ahora) / 1000)) : 0;

  return (
    <section className="space-y-3" aria-label="Lista del entreno">
      {!online && (
        <div role="status" className="flex items-start gap-2 rounded-2xl bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200" data-testid="aviso-sin-senal">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Sin señal. La lista se guarda en el teléfono y sube sola cuando vuelva.</span>
        </div>
      )}
      {pendientesOtras.length > 0 && (
        <div role="status" className="flex items-start gap-2 rounded-2xl border p-3 text-sm">
          <CloudUpload className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            {pendientesOtras.length === 1 ? 'Otra lista espera subir: ' : `${pendientesOtras.length} listas esperan subir: `}
            {pendientesOtras.map((i) => i.etiqueta).join(' · ')}.
          </span>
        </div>
      )}
      {atascadasOtras.map((i) => (
        <div key={i.key} role="alert" className="space-y-2 rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="otra-lista-atascada">
          <p><strong>No se pudo subir: {i.etiqueta}.</strong> {i.error}</p>
          <div className="flex gap-2">
            <Button variant="outline" className="min-h-touch flex-1" onClick={() => reintentar(i.key)}><RotateCcw className="mr-2 h-4 w-4" />Volver a intentar</Button>
            <Button variant="ghost" className="min-h-touch" onClick={() => cola?.descartar(i.key)}>Descartar</Button>
          </div>
        </div>
      ))}

      {/* Día de la lista: hoy, ayer u otro día dentro de la ventana de la escuela */}
      {opcionesDia.length > 1 && (
        <Segmentado<OpcionDia>
          etiqueta="Día de la lista" valor={opcionDeFecha(fecha, hoy)} onCambio={elegirDia}
          opciones={opcionesDia.map((o) => ({ v: o, l: o === 'hoy' ? 'Hoy' : o === 'ayer' ? 'Ayer' : 'Otro día' }))}
        />
      )}
      {opcionDeFecha(fecha, hoy) === 'otro' && (
        <label className="flex items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2 text-sm">
          <span className="font-medium">¿Qué día?</span>
          <input
            type="date"
            className="min-h-touch rounded-lg border bg-background px-2 text-sm"
            value={fecha}
            min={fechaMinimaCorregible(hoy, retroDias)}
            max={sumarDias(hoy, -2)}
            onChange={(e) => { if (e.target.value && sePuedeCorregir(e.target.value, hoy, retroDias)) onFecha(e.target.value); }}
            data-testid="lista-otro-dia"
          />
        </label>
      )}
      {fecha !== hoy && (
        <p className="rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
          Estás corrigiendo la lista del <strong>{fechaHumana(fecha)}</strong>. Las clases se descuentan con esa fecha.
        </p>
      )}

      {cargando ? (
        <div className="space-y-2" role="status" aria-label="Cargando la lista">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-touch animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : errorCarga ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <p className="font-semibold">No pudimos cargar la lista.</p>
          <p className="text-muted-foreground">
            {online ? 'Inténtalo otra vez en un momento.' : 'Estás sin señal y esta lista no se había abierto antes en este teléfono. Ábrela una vez con señal y después funciona sin ella.'}
          </p>
          <Button variant="outline" className="mt-3 min-h-touch" onClick={() => { void rosterQ.refetch(); void origenQ.refetch(); }}>Reintentar</Button>
        </div>
      ) : sesionQ.data?.varias ? (
        <div className="space-y-2 rounded-2xl border bg-card p-4">
          <p className="font-semibold">Hay varias clases ese día</p>
          <p className="text-sm text-muted-foreground">Elige de cuál tomas lista.</p>
          <div className="grid gap-2">
            {(sesionQ.data.opciones ?? []).map((o) => (
              <Button key={o.id} variant="outline" className="min-h-touch justify-between" onClick={() => onElegirClase(o.id)}>
                {horaHumana(o.start_time ?? null) ?? 'Sin hora'} {o.finalized ? '· cerrada' : ''}
                <ChevronRight className="h-4 w-4" />
              </Button>
            ))}
          </div>
        </div>
      ) : sesionQ.data?.sinClase ? (
        <div className="rounded-2xl border bg-card p-5 text-center">
          <p className="font-semibold">Este plan no tiene clase {fecha === hoy ? 'hoy' : 'ese día'}</p>
          <p className="mt-1 text-sm text-muted-foreground">La lista de un plan se toma sobre una clase programada en la agenda.</p>
        </div>
      ) : roster.length === 0 ? (
        <div className="rounded-2xl border bg-card p-5 text-center">
          <p className="font-semibold">No hay deportistas en esta lista</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {(rosterQ.data?.atletas_sin_equipo ?? 0) > 0
              ? `Hay ${rosterQ.data?.atletas_sin_equipo} deportistas activos sin equipo: la escuela debe asignárselo.`
              : 'Cuando la escuela inscriba deportistas, aparecen aquí.'}
          </p>
        </div>
      ) : (
        <>
          {cerrada && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
              <Lock className="h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1 text-sm"><strong>Lista cerrada.</strong> Para cambiarla, reábrela.</p>
              <Button variant="outline" className="min-h-touch" disabled={!online || reabrir.isPending} onClick={() => reabrir.mutate()}>
                {reabrir.isPending ? 'Reabriendo…' : 'Reabrir para corregir'}
              </Button>
            </div>
          )}

          <div className="flex items-baseline justify-between gap-2 px-1">
            <p className="text-lg font-bold" data-testid="lista-conteo">Vinieron {r.vinieron} de {r.total}</p>
          </div>
          {puedeEditar && <p className="px-1 text-sm text-muted-foreground" data-testid="lista-ayuda">{textoAyuda(r, primerAviso)}</p>}

          {(rosterQ.data?.atletas_pausados ?? 0) > 0 && (
            <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {rosterQ.data?.atletas_pausados === 1 ? '1 deportista está en pausa (vacaciones o lesión) y no aparece.' : `${rosterQ.data?.atletas_pausados} deportistas están en pausa (vacaciones o lesión) y no aparecen.`}
            </p>
          )}

          <ul className="space-y-1.5" aria-label="Deportistas">
            {roster.map((a) => {
              const s = estado[a.id] ?? 'present';
              const av = a.athlete_type === 'child' ? byChildId.get(a.id) : a.athlete_type === 'adult' ? byProfileId.get(a.id) : undefined;
              const nota = a.aviso_ausencia
                ? `Avisó que no viene${MOTIVO_AUSENCIA[a.aviso_ausencia.motivo ?? ''] ? ` (${MOTIVO_AUSENCIA[a.aviso_ausencia.motivo ?? '']})` : ''}: no descuenta clase`
                : a.booking_today ? 'Ya reservó hoy: no se descuenta otra clase'
                : a.plan?.is_expired ? 'Plan vencido'
                : a.athlete_type === 'unregistered' ? 'Invitado' : null;
              return (
                <li key={a.id}>
                  <button
                    type="button" onClick={() => tocar(a.id)} disabled={!puedeEditar}
                    aria-label={`${a.full_name}: ${ETIQUETA[s]}.${puedeEditar ? ' Toca para cambiar.' : ''}`}
                    data-testid="fila-deportista" data-estado={s}
                    className={cn('flex min-h-touch w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors active:scale-[0.99] disabled:cursor-default',
                      ESTILO[s].fila)}
                  >
                    <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold', ESTILO[s].avatar)} aria-hidden="true">
                      {iniciales(a.full_name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base">{a.full_name}</span>
                      {(nota || av) && (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {nota && <span>{nota}</span>}
                          {av && (
                            <AvailabilityBadge status={av.availability_status} stage={av.rtp_stage} restrictions={av.restrictions}
                              expectedReturn={av.expected_return} bodyRegion={av.body_region} professionalName={av.professional_name} />
                          )}
                        </span>
                      )}
                    </span>
                    <span className={cn('shrink-0 rounded-full px-3 py-1 text-sm font-semibold', ESTILO[s].pill)}>{ETIQUETA[s]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {puedeEditar && (
            <p className="px-1 text-xs text-muted-foreground">
              Toca para cambiar: Vino → Faltó → Excusa → Tarde. Quien avisó por WhatsApp arranca con excusa.
            </p>
          )}

          {puedeEditar && (
            <div className="rounded-2xl border">
              <button type="button" className="flex min-h-touch w-full items-center justify-between px-4 text-sm font-medium" onClick={() => setMasOpciones((v) => !v)} aria-expanded={masOpciones}>
                Más opciones <ChevronRight className={cn('h-4 w-4 transition-transform', masOpciones && 'rotate-90')} />
              </button>
              {masOpciones && (
                <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                  <Label htmlFor="v2-clase-secundaria" className="text-sm">
                    Clase secundaria
                    <span className="block text-xs font-normal text-muted-foreground">Descuenta de las clases secundarias del plan.</span>
                  </Label>
                  <Switch id="v2-clase-secundaria" checked={isSecondary} onCheckedChange={setIsSecondary} />
                </div>
              )}
            </div>
          )}

          {/* Barra de acción */}
          <div className="sticky bottom-0 z-10 -mx-gutter space-y-2 border-t bg-background/95 py-3 pl-gutter pr-[5.5rem] backdrop-blur lg:pr-gutter" data-testid="barra-lista">
            {enCola?.error ? (
              <div role="alert" className="space-y-2">
                <p className="text-sm"><strong>La lista no se pudo subir.</strong> {enCola.error}</p>
                <div className="flex gap-2">
                  <Button className="min-h-touch flex-1" onClick={() => reintentar()}><RotateCcw className="mr-2 h-4 w-4" />Volver a intentar</Button>
                  <Button variant="outline" className="min-h-touch" onClick={() => { cola?.descartar(key); setEditando(true); }}>Descartar</Button>
                </div>
              </div>
            ) : enVentana ? (
              <div role="status" className="flex items-center gap-3" data-testid="aviso-deshacer">
                <p className="min-w-0 flex-1 text-sm">
                  {online ? textoListaGuardada(r) : 'Guardada en el teléfono. Sube sola cuando vuelva la señal.'}
                </p>
                <Button variant="outline" className="min-h-touch shrink-0" onClick={deshacer}>Deshacer · {segundosVentana}</Button>
              </div>
            ) : enCola && !editando ? (
              <div role="status" className="flex items-center gap-3" data-testid="aviso-pendiente">
                <CloudUpload className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="min-w-0 flex-1 text-sm">
                  {online ? 'Subiendo la lista…' : 'Guardada en el teléfono. Sube sola cuando vuelva la señal.'}
                </p>
                <Button variant="ghost" className="min-h-touch shrink-0" onClick={() => setEditando(true)}>Corregir</Button>
              </div>
            ) : !editando && !cerrada ? (
              <div role="status" className="space-y-2" data-testid="aviso-guardada">
                <p className="flex items-center gap-2 text-sm font-medium"><Check className="h-4 w-4 text-emerald-600" /> Lista guardada</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-touch flex-1" disabled={!online || !sesion?.id || finalizar.isPending}
                    onClick={() => finalizar.mutate()} data-testid="cerrar-y-evaluar"
                  >
                    {finalizar.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Cerrando…</> : 'Cerrar y evaluar'}
                  </Button>
                  <Button variant="outline" className="min-h-touch" onClick={() => setEditando(true)}>Corregir</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {online
                    ? 'Al cerrarla, a las familias de los que vinieron les llega la encuesta del entreno.'
                    : 'Sin señal: ciérrala cuando vuelva. Si no, se cierra sola a las 11:55 p. m.'}
                </p>
              </div>
            ) : cerrada && sesion?.id ? (
              <Button asChild className="min-h-touch w-full"><Link to={`/coach/evaluar/${sesion.id}`}>Evaluar al equipo</Link></Button>
            ) : puedeEditar ? (
              <Button className="h-auto min-h-touch w-full whitespace-normal py-2 text-base leading-tight" size="lg" onClick={guardar} disabled={!sePuedeGuardar} data-testid="guardar-lista">
                {online ? 'Guardar lista' : 'Guardar en el teléfono'}
              </Button>
            ) : null}
          </div>
        </>
      )}

    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reservas personales del día (sesiones PT) — se conservan de la versión clásica.
// ─────────────────────────────────────────────────────────────────────────────

function ReservasPersonales({ hoy }: { hoy: string }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const ptQ = usePtDeHoy(user?.id, hoy);
  const { mutate: marcar, isPending } = useUpdatePTAttendance();
  const { mutate: noVino, isPending: procesando } = useHandleNoShow();
  const [noShow, setNoShow] = useState<any | null>(null);
  const sesiones: any[] = ptQ.data?.sessions ?? [];
  if (sesiones.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Reservas personales de hoy">
      <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Reservas personales de hoy</h2>
      <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
        {sesiones.map((s) => {
          const hecha = s.status === 'completed';
          const falto = s.status === 'no_show';
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.client?.full_name || 'Cliente'}</span>
                <span className="text-xs text-muted-foreground">{horaHumana(s.session_time) ?? ''}{hecha ? ' · Asistió' : falto ? ' · No asistió' : ''}</span>
              </span>
              {!hecha && !falto && (
                <>
                  <Button size="sm" className="min-h-touch" disabled={isPending}
                    onClick={() => marcar({ sessionId: s.id, status: 'completed' }, { onSuccess: () => { toast({ title: 'Marcado: asistió' }); void ptQ.refetch(); } })}>
                    <Check className="mr-1 h-4 w-4" /> Asistió
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-touch" disabled={isPending} onClick={() => setNoShow(s)}>
                    <X className="mr-1 h-4 w-4" /> No vino
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog open={!!noShow} onOpenChange={(o) => !o && setNoShow(null)}>
        <DialogContent className="max-w-modal-sm">
          <DialogHeader>
            <DialogTitle>{noShow?.client?.full_name ?? 'El cliente'} no vino</DialogTitle>
            <DialogDescription>¿Le devuelves la clase o se la descuentas?</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {(['return_credit', 'deduct'] as const).map((accion) => (
              <Button key={accion} variant={accion === 'deduct' ? 'outline' : 'default'} className="min-h-touch" disabled={procesando}
                onClick={() => noVino({ sessionId: noShow.id, action: accion }, {
                  onSuccess: () => { toast({ title: accion === 'deduct' ? 'Clase descontada' : 'Clase devuelta' }); setNoShow(null); void ptQ.refetch(); },
                  onError: (e: any) => toast({ title: 'No se pudo', description: e.message, variant: 'destructive' }),
                })}>
                {accion === 'deduct' ? 'Descontar la clase' : 'Devolver la clase'}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Historial
// ─────────────────────────────────────────────────────────────────────────────

function Historial({ onCorregir }: { onCorregir: (ctx: ContextoLista, fecha: string) => void }) {
  const { user } = useAuth();
  const { schoolId, currentUserRole } = useSchoolContext();
  const { coachAttendanceRetroDays } = useEntitlements();
  const { staffId } = useCoachStaffId();
  const isAdmin = esAdministracion(currentUserRole);
  const hoy = todayColombia();
  const equiposQ = useEquiposCoach(schoolId, user?.id, staffId, isAdmin);
  const equipos = useMemo(() => equiposQ.data ?? [], [equiposQ.data]);
  const histHabilitado = !equiposQ.isPending && (equipos.length > 0 || !!staffId);
  const histQ = useHistorial(schoolId, hoy, equipos, staffId, histHabilitado);
  const planillasQ = usePlanillasPorRevisar(schoolId, true);

  const mes = hoy.slice(0, 7);
  const delMes = useMemo(() => (histQ.data?.sesiones ?? []).filter((s) => s.session_date.startsWith(mes)), [histQ.data, mes]);
  const pct = porcentajeAsistencia(delMes);
  const faltan = useMemo(() => faltanMucho(delMes, histQ.data?.nombres ?? new Map()), [delMes, histQ.data]);
  const ayer = sumarDias(hoy, -1);

  return (
    <div className="space-y-4">
      {/* B4: subir planilla siempre a mano, haya o no planillas pendientes. */}
      {!(planillasQ.data && planillasQ.data.total > 0) && (
        <Link to="/school/attendance-sheets" className="flex min-h-touch items-center gap-3 rounded-2xl border bg-card p-3" data-testid="subir-planilla">
          <Camera className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Subir planilla en papel</span>
            <span className="block text-xs text-muted-foreground">Le tomas foto a la lista de papel y la pasamos a la app.</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </Link>
      )}
      {planillasQ.data && planillasQ.data.total > 0 && (
        <Link to="/school/attendance-sheets" className="flex min-h-touch items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">
              {planillasQ.data.total === 1 ? '1 planilla de papel por revisar' : `${planillasQ.data.total} planillas de papel por revisar`}
            </span>
            {planillasQ.data.primera?.teamName && (
              <span className="block truncate text-xs text-muted-foreground">
                Llegaron por foto · {planillasQ.data.primera.teamName}
                {planillasQ.data.primera.sessionDate ? `, ${fechaHumana(planillasQ.data.primera.sessionDate)}` : ''}
              </span>
            )}
          </span>
          <span className="shrink-0 text-sm font-semibold text-primary">Revisar</span>
        </Link>
      )}

      {equiposQ.isPending || (histHabilitado && histQ.isPending) ? (
        <div className="space-y-2" role="status" aria-label="Cargando el historial">
          <div className="h-20 animate-pulse rounded-2xl bg-muted" />
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-touch animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : histQ.isError ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <p className="font-semibold">No pudimos cargar el historial.</p>
          <Button variant="outline" className="mt-3 min-h-touch" onClick={() => void histQ.refetch()}>Reintentar</Button>
        </div>
      ) : (histQ.data?.sesiones.length ?? 0) === 0 ? (
        <div className="rounded-2xl border bg-card p-5 text-center">
          <CalendarCheck className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 font-semibold">No hay listas en los últimos tres meses</p>
          <p className="mt-1 text-sm text-muted-foreground">Cuando tomes lista, aquí ves cada entreno y quién falta mucho.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {[
              { v: pct != null ? `${pct} %` : '—', t: 'asistencia del mes' },
              { v: String(delMes.length), t: delMes.length === 1 ? 'entreno con lista' : 'entrenos con lista' },
              { v: String(faltan.length), t: 'faltan mucho' },
            ].map((k) => (
              <div key={k.t} className="rounded-2xl border bg-card p-3 text-center">
                <p className="text-xl font-bold tabular-nums">{k.v}</p>
                <p className="text-xs text-muted-foreground">{k.t}</p>
              </div>
            ))}
          </div>

          <section className="space-y-1.5">
            <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Entrenos</h2>
            <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
              {histQ.data!.sesiones.slice(0, 30).map((s) => {
                const vino = s.records.filter((x) => x.status === 'present' || x.status === 'late').length;
                const corregible = sePuedeCorregir(s.session_date, hoy, coachAttendanceRetroDays);
                const ctx: ContextoLista = s.team_id ? { tipo: 'team', id: s.team_id, nombre: s.nombre } : { tipo: 'session', id: s.id, nombre: s.nombre };
                return (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {capitalizar(s.session_date === hoy ? 'hoy' : s.session_date === ayer ? 'ayer' : fechaHumana(s.session_date))} · {s.nombre}
                      </span>
                      <span className="text-xs text-muted-foreground">{s.finalized ? 'Cerrada' : 'Abierta'}{horaHumana(s.start_time) ? ` · ${horaHumana(s.start_time)}` : ''}</span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">{vino} / {s.records.length}</span>
                    {corregible ? (
                      <Button variant="outline" size="sm" className="min-h-touch shrink-0" onClick={() => onCorregir(ctx, s.session_date)}>Corregir</Button>
                    ) : (
                      <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Ya no se puede corregir" />
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="px-1 text-xs text-muted-foreground">{textoVentanaCorreccion(coachAttendanceRetroDays)}</p>
          </section>

          {faltan.length > 0 && (
            <section className="space-y-1.5">
              <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Faltan mucho este mes</h2>
              <ul className="divide-y overflow-hidden rounded-2xl border bg-card">
                {faltan.map((f) => (
                  <li key={f.id} className="flex min-h-touch items-center gap-3 px-4 py-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-800 dark:bg-red-950/60 dark:text-red-300" aria-hidden="true">{iniciales(f.nombre)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{f.nombre}</span>
                      <span className="text-xs text-muted-foreground">Vino a {f.vino} de {f.de}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
