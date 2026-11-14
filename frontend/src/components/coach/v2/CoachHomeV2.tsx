/**
 * Hoy del entrenador — V2 (lienzo «Entrenador · Hoy»).
 *
 * Orden: cabecera (escuela, fecha, campana) → frase y UN botón según el momento
 * (antes del entreno: «Tomar lista»; después: «Evaluar al equipo»; día sin
 * entreno: el próximo y «Preparar el entreno») → plan de hoy plegable →
 * pendientes reales con «Más tarde» (8 s para Deshacer) → cita de la agenda.
 *
 * Pendientes (todos de datos vivos, nada de ejemplo):
 *   - entreno cerrado sin evaluar (últimos 7 días)  → Evaluar
 *   - informe del mes listo, si la escuela deja publicar al profe → Publicar
 *   - partido de los próximos 7 días sin convocatoria → Convocar
 *
 * Carga, error y vacío son distintos: si los equipos no cargan no se dice «Hoy
 * no entrenas».
 *
 * Pizarra: botón grande siempre (abre `/pizarra`, se dibuja sin formulario).
 * «Hoy no entrenas» no deja la pantalla vacía: resumen de la semana, la última
 * jugada guardada y la pizarra / Mapi. Equipos sin horario fijo: «Agregar
 * horario» (o el aviso para la administración si la escuela no lo permite).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Check, ChevronDown, ChevronRight, ClipboardCheck, MessageCircleQuestion, Presentation } from 'lucide-react';
import { SupportChatModal } from '@/components/support/SupportChatModal';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { cn } from '@/lib/utils';
import { InlineError } from '@/components/parent/v2/hijos/parts';
import { fechaCabecera } from '@/components/parent/v2/parentHomeLogic';
import {
  conRutas,
  construirPendientes,
  equiposSinHorario,
  fraseMomento,
  guardarMasTarde,
  horaDePartido,
  horaColombia,
  iniciales,
  isoDia,
  leerMasTarde,
  minutosTotales,
  momentoDelDia,
  pasosDelPlan,
  primerNombre,
  resumenSemana,
  type Momento,
  type RutasCoachV2,
} from './coachV2Logic';
import { useAhora } from './useAhora';
import {
  useCitasDeHoy,
  useEquiposCoach,
  useInformesDelMes,
  usePartidosProximos,
  usePlanesDeHoy,
  usePresentesSesion,
  useSesionesRecientes,
  useUltimaJugada,
  type EquipoCoach,
} from './useCoachV2Data';
import { AgregarHorarioBoton } from './equipos/AgregarHorarioSheet';

interface Props {
  nombreProfe?: string | null;
  rutas?: Partial<RutasCoachV2>;
  /** Para pruebas. */
  hoy?: Date;
}

export function CoachHomeV2({ nombreProfe, rutas: rutasProp, hoy }: Props) {
  const rutas = conRutas(rutasProp);
  // La hora avanza (tic por minuto y al volver a la pestaña): la frase del momento no se congela.
  const ahora = useAhora(hoy);
  const { user } = useAuth();
  const { schoolId, schoolName, loading: cargandoEscuela } = useSchoolContext();
  const equipos = useEquiposCoach(schoolId);
  const teamIds = useMemo(() => (equipos.data ?? []).map((e) => e.id), [equipos.data]);
  const sesiones = useSesionesRecientes(teamIds, ahora, 7);
  const planes = usePlanesDeHoy(teamIds, ahora);
  const informes = useInformesDelMes(schoolId, ahora.getFullYear(), ahora.getMonth() + 1);
  const partidos = usePartidosProximos(teamIds, ahora);
  const citas = useCitasDeHoy(user?.id, ahora);
  const hoyIso = isoDia(ahora);
  const libre = useMemo(
    () => momentoDelDia(equipos.data ?? [], ahora, (sesiones.data ?? []).filter((s) => s.fecha === hoyIso)).tipo === 'libre',
    [equipos.data, ahora, sesiones.data, hoyIso],
  );
  const ultimaJugada = useUltimaJugada(libre ? schoolId : null, user?.id);

  const nombre = primerNombre(nombreProfe);
  const cabeceraFecha = `${fechaCabecera(ahora)}${nombre ? ` · Profe ${nombre}` : ''}`;

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 pb-nav-safe font-poppins animate-in fade-in duration-300">
      {/* Sin campana propia: la única es la de la cabecera de la app (GlobalNotificationBell). */}
      <header className="flex items-center gap-3">
        <div aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-primary-foreground">
          {iniciales(schoolName ?? 'SportMaps')}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{schoolName ?? 'SportMaps'}</span>
          <span className="text-xs text-muted-foreground">{cabeceraFecha}</span>
        </div>
      </header>

      {!schoolId && !cargandoEscuela ? (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4" data-testid="sin-escuela">
          <h1 className="text-2xl font-bold leading-tight">Todavía no tienes equipos.</h1>
          <p className="text-sm text-muted-foreground">Pídele a la escuela que te asigne a tus equipos. Cuando lo haga, aquí verás qué entrenas hoy.</p>
        </section>
      ) : equipos.isLoading || !schoolId ? (
        <div className="flex flex-col gap-4" aria-busy="true" aria-label="Cargando tu día">
          <Skeleton className="h-8 w-4/5 rounded-lg" />
          <Skeleton className="h-5 w-3/5 rounded-lg" />
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      ) : equipos.isError ? (
        <InlineError message="No pudimos cargar tus equipos. Revisa tu conexión: mientras tanto no sabemos qué entrenas hoy." onRetry={() => equipos.refetch()} />
      ) : (equipos.data ?? []).length === 0 ? (
        <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
          <h1 className="text-2xl font-bold leading-tight">Todavía no tienes equipos.</h1>
          <p className="text-sm text-muted-foreground">La escuela te asigna a tus equipos. Cuando lo haga, aquí verás qué entrenas hoy.</p>
        </section>
      ) : (
        <>
          <MomentoBloque
            equipos={equipos.data ?? []}
            ahora={ahora}
            sesiones={sesiones.data ?? []}
            cargandoSesiones={sesiones.isLoading}
            rutas={rutas}
          />
          <BotonPizarra href={rutas.pizarra} />
          {libre && (
            <DiaLibre
              equipos={equipos.data ?? []}
              sesiones={sesiones.data ?? []}
              ahora={ahora}
              rutas={rutas}
              ultima={ultimaJugada.data ?? null}
            />
          )}
          <PlanDeHoy equipos={equipos.data ?? []} planes={planes.data ?? []} rutas={rutas} />
          <Pendientes
            ahora={ahora}
            rutas={rutas}
            listo={!sesiones.isLoading && !informes.isLoading && !partidos.isLoading}
            sinEvaluar={(sesiones.data ?? [])
              .filter((s) => s.cerrada && !s.evaluada)
              .map((s) => ({ ...s, equipo: (equipos.data ?? []).find((e) => e.id === s.teamId)?.nombre ?? 'Equipo' }))}
            informes={(informes.data?.equipos ?? []).filter((i) => teamIds.includes(i.teamId))}
            puedePublicar={!!informes.data?.puedePublicar}
            partidos={(partidos.data ?? []).map((p) => ({
              id: p.id, teamId: p.teamId, rival: p.rival, fecha: p.fecha, hora: horaDePartido(p), convocado: p.convocado,
              equipo: (equipos.data ?? []).find((e) => e.id === p.teamId)?.nombre ?? 'Equipo',
            }))}
          />
          {(citas.data ?? []).length > 0 && (
            <Link to={rutas.agenda} className="flex items-center gap-3 rounded-2xl border bg-card px-4 py-3.5 active:scale-[0.97] motion-reduce:active:scale-100">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">
                <CalendarDays className="h-5 w-5" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-base font-semibold">Tu agenda: {citas.data!.length} {citas.data!.length === 1 ? 'cita' : 'citas'} hoy</span>
                {citas.data![0] && (
                  <span className="truncate text-xs text-muted-foreground">
                    {[citas.data![0].con ? `Con ${citas.data![0].con}` : 'Clase personal', citas.data![0].hora ? horaColombia(citas.data![0].hora) : null].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            </Link>
          )}
          {!libre && <ResumenSemana sesiones={sesiones.data ?? []} ahora={ahora} />}
        </>
      )}
    </div>
  );
}

function MomentoBloque({ equipos, ahora, sesiones, cargandoSesiones, rutas }: {
  equipos: EquipoCoach[]; ahora: Date; sesiones: { id: string; teamId: string; fecha: string; cerrada: boolean; evaluada: boolean }[];
  cargandoSesiones: boolean; rutas: RutasCoachV2;
}) {
  const hoyIso = isoDia(ahora);
  const m: Momento = momentoDelDia(equipos, ahora, sesiones.filter((s) => s.fecha === hoyIso));
  const sesionEvaluar = m.tipo === 'despues' && m.sesion?.cerrada ? m.sesion : null;
  const presentes = usePresentesSesion(sesionEvaluar?.id ?? null);
  const { titulo, detalle } = fraseMomento(m, presentes.data?.length ?? null);

  let boton: { txt: string; href: string; primario: boolean } | null;
  if (m.tipo === 'antes' || m.tipo === 'durante') boton = { txt: 'Tomar lista', href: rutas.tomarLista, primario: true };
  else if (m.tipo === 'despues') {
    boton = sesionEvaluar
      ? { txt: 'Evaluar al equipo', href: rutas.evaluar(sesionEvaluar.id), primario: true }
      : { txt: 'Tomar lista', href: rutas.tomarLista, primario: true };
  } else boton = { txt: m.proximo?.enDias === 1 ? 'Preparar el entreno de mañana' : 'Preparar el próximo entreno', href: rutas.sesiones, primario: false };

  return (
    <section aria-label="Lo que toca ahora" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-balance text-3xl font-bold leading-tight tracking-tight">{titulo}</h1>
        {detalle && <p className="text-base text-muted-foreground">{detalle}</p>}
      </div>
      {boton && !(m.tipo === 'despues' && cargandoSesiones) && (
        <Button
          asChild
          variant={boton.primario ? 'default' : 'outline'}
          className={cn(
            'rounded-2xl font-semibold active:scale-[0.97] motion-reduce:active:scale-100',
            boton.primario ? 'h-16 text-lg' : 'h-14 border-2 border-primary text-base text-primary',
          )}
        >
          <Link to={boton.href}>
            {boton.primario && boton.txt === 'Tomar lista' && <ClipboardCheck className="mr-2 h-5 w-5" aria-hidden />}
            {boton.txt}
          </Link>
        </Button>
      )}
    </section>
  );
}

/** Botón grande «Pizarra»: dibujar una jugada ya, sin llenar nada (ítem 3). */
function BotonPizarra({ href }: { href: string }) {
  return (
    <Link
      to={href}
      className="flex min-h-16 items-center gap-3 rounded-2xl border-2 border-primary/30 bg-primary/5 px-4 py-3 active:scale-[0.97] motion-reduce:active:scale-100"
      data-testid="boton-pizarra"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Presentation className="h-6 w-6" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-lg font-bold">Pizarra</span>
        <span className="text-xs text-muted-foreground">Dibuja una jugada ya, sin llenar nada.</span>
      </span>
      <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden />
    </Link>
  );
}

const FUENTE_JUGADA: Record<string, string> = {
  training_session: 'de un entreno',
  team_match: 'de un partido',
};

/** «Hoy no entrenas»: lo que sirve un día libre (ítem 30) y el horario que falta (ítem 31). */
function DiaLibre({ equipos, sesiones, ahora, rutas, ultima }: {
  equipos: EquipoCoach[];
  sesiones: { fecha: string; cerrada: boolean; evaluada: boolean }[];
  ahora: Date;
  rutas: RutasCoachV2;
  ultima: { id: string; teamId: string | null; fuente: string | null; fecha: string } | null;
}) {
  const [mapi, setMapi] = useState(false);
  const r = resumenSemana(sesiones, ahora);
  const sinHorario = equiposSinHorario(equipos);
  const equipoJugada = ultima?.teamId ? equipos.find((e) => e.id === ultima.teamId)?.nombre ?? null : null;
  const fechaJugada = ultima ? new Date(ultima.fecha).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' }) : null;

  return (
    <section aria-label="Tu semana" className="flex flex-col gap-3 rounded-2xl border bg-card p-4" data-testid="dia-libre">
      <h2 className="text-base font-semibold">Tu semana</h2>
      {r.entrenos === 0 ? (
        <p className="text-sm text-muted-foreground">Esta semana todavía no hay listas tomadas.</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 text-center">
          <li className="flex flex-col"><span className="text-2xl font-bold tabular-nums">{r.entrenos}</span><span className="text-xs text-muted-foreground">{r.entrenos === 1 ? 'entreno' : 'entrenos'}</span></li>
          <li className="flex flex-col"><span className="text-2xl font-bold tabular-nums">{r.conLista}</span><span className="text-xs text-muted-foreground">con lista cerrada</span></li>
          <li className="flex flex-col"><span className={cn('text-2xl font-bold tabular-nums', r.sinEvaluar > 0 && 'text-amber-600 dark:text-amber-400')}>{r.sinEvaluar}</span><span className="text-xs text-muted-foreground">sin evaluar</span></li>
        </ul>
      )}

      {ultima && (
        <Link to={`${rutas.pizarra}?jugada=${encodeURIComponent(ultima.id)}`} className="flex min-h-touch items-center gap-3 rounded-xl border px-3 py-2" data-testid="ultima-jugada">
          <Presentation className="h-5 w-5 shrink-0 text-primary" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-semibold">Tu última jugada</span>
            <span className="truncate text-xs text-muted-foreground">
              {[equipoJugada, ultima.fuente ? FUENTE_JUGADA[ultima.fuente] ?? null : null, fechaJugada].filter(Boolean).join(' · ')}
            </span>
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Link>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button asChild variant="outline" className="h-auto min-h-touch whitespace-normal rounded-xl py-2">
          <Link to={rutas.pizarra}><Presentation className="mr-2 h-4 w-4 shrink-0" aria-hidden />Abrir la pizarra</Link>
        </Button>
        <Button variant="outline" className="h-auto min-h-touch whitespace-normal rounded-xl py-2" onClick={() => setMapi(true)}>
          <MessageCircleQuestion className="mr-2 h-4 w-4 shrink-0" aria-hidden />Pedirle ideas a Mapi
        </Button>
      </div>

      {sinHorario.length > 0 && (
        <div className="flex flex-col gap-2 border-t pt-3" data-testid="sin-horario">
          <p className="text-sm font-semibold">
            {sinHorario.length === 1 ? `${sinHorario[0].nombre} no tiene horario fijo.` : `${sinHorario.length} equipos no tienen horario fijo.`}
          </p>
          {sinHorario.slice(0, 3).map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2">
              {sinHorario.length > 1 && <span className="min-w-0 flex-1 truncate text-sm">{e.nombre}</span>}
              <AgregarHorarioBoton equipo={e} />
            </div>
          ))}
        </div>
      )}
      <SupportChatModal isOpen={mapi} onClose={() => setMapi(false)} />
    </section>
  );
}

function PlanDeHoy({ equipos, planes, rutas }: { equipos: EquipoCoach[]; planes: Array<{ id: string; teamId: string; objetivo: string | null; session_blocks: unknown; drills: unknown; warmup: string | null }>; rutas: RutasCoachV2 }) {
  const [abierto, setAbierto] = useState(true);
  const plan = planes[0];
  if (!plan) return null;
  const equipo = equipos.find((e) => e.id === plan.teamId)?.nombre ?? 'Equipo';
  const pasos = pasosDelPlan(plan);
  const total = minutosTotales(pasos);
  return (
    <section className="overflow-hidden rounded-2xl border bg-card" aria-label="Plan de hoy">
      <button
        type="button"
        aria-expanded={abierto}
        onClick={() => setAbierto((a) => !a)}
        className="flex min-h-14 w-full items-center gap-2.5 px-4 text-left"
      >
        <span className="flex-1 text-base font-semibold">Plan de hoy · {equipo}</span>
        {total && <span className="text-xs text-muted-foreground">{total} min</span>}
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none', abierto && 'rotate-180')} aria-hidden />
      </button>
      {plan.objetivo && <p className="px-4 pb-1.5 text-sm text-muted-foreground">Objetivo: {plan.objetivo}</p>}
      {abierto && (
        <>
          {pasos.length > 0 && (
            <ol className="flex flex-col px-4 pb-1 pt-1.5">
              {pasos.map((p, i) => (
                <li key={i} className="flex gap-3 border-t py-2.5 text-base">
                  <span className="w-9 shrink-0 font-bold text-primary">{p.min ?? '·'}</span>
                  <span className="flex-1">{p.texto}</span>
                </li>
              ))}
            </ol>
          )}
          {planes.length > 1 && <p className="px-4 pb-2 text-xs text-muted-foreground">Hoy tienes {planes.length} planes. Ábrelos todos en Sesiones.</p>}
          <Link to={rutas.sesiones} className="flex min-h-12 items-center justify-between border-t px-4 text-sm font-semibold text-primary">
            Abrir en la cancha (letra grande y pizarra) <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </>
      )}
    </section>
  );
}

function Pendientes(props: {
  ahora: Date; rutas: RutasCoachV2; listo: boolean;
  sinEvaluar: Parameters<typeof construirPendientes>[0]['sinEvaluar'];
  informes: Parameters<typeof construirPendientes>[0]['informes'];
  puedePublicar: boolean;
  partidos: Parameters<typeof construirPendientes>[0]['partidos'];
}) {
  const { ahora, rutas } = props;
  const [ocultos, setOcultos] = useState<string[]>(() => leerMasTarde(ahora));
  const lista = construirPendientes({
    sinEvaluar: props.sinEvaluar,
    informes: props.informes,
    puedePublicar: props.puedePublicar,
    mes: ahora.getMonth() + 1,
    partidos: props.partidos,
    ocultos,
    hoy: ahora,
    rutas,
  });

  const masTarde = (id: string) => {
    const nuevos = [...ocultos, id];
    setOcultos(nuevos);
    guardarMasTarde(ahora, nuevos);
    toast('Te lo recordamos mañana.', {
      duration: 8000,
      action: {
        label: 'Deshacer',
        onClick: () => {
          setOcultos((o) => {
            const sin = o.filter((x) => x !== id);
            guardarMasTarde(ahora, sin);
            return sin;
          });
        },
      },
    });
  };

  if (!props.listo) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Cargando pendientes">
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  if (lista.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-2xl bg-primary/10 px-4 py-3.5 text-base text-primary">
        <Check className="h-5 w-5 shrink-0" aria-hidden /> Nada pendiente. Buen trabajo, profe.
      </div>
    );
  }

  return (
    <section aria-label="Pendientes" className="flex flex-col gap-2.5">
      <h2 className="pl-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Pendientes</h2>
      {lista.map((p) => (
        <article key={p.id} data-testid="pendiente" className="flex flex-col gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 pb-2.5 pt-3.5 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-semibold">{p.titulo}</span>
            <span className="text-xs text-muted-foreground">{p.detalle}</span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" className="min-h-touch rounded-xl text-sm text-muted-foreground" onClick={() => masTarde(p.id)}>
              Más tarde
            </Button>
            <Button asChild className="min-h-touch rounded-xl bg-foreground px-5 text-sm font-semibold text-background hover:bg-foreground/90">
              <Link to={p.href}>{p.cta}</Link>
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}

function ResumenSemana({ sesiones, ahora }: { sesiones: { fecha: string; cerrada: boolean }[]; ahora: Date }) {
  // Lunes de esta semana.
  const lunes = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - ((ahora.getDay() + 6) % 7));
  const desde = isoDia(lunes);
  const deLaSemana = sesiones.filter((s) => s.fecha >= desde);
  if (deLaSemana.length === 0) return null;
  const conLista = deLaSemana.filter((s) => s.cerrada).length;
  return (
    <p className="text-center text-xs text-muted-foreground">
      Esta semana: {conLista} de {deLaSemana.length} entrenos con lista tomada.
    </p>
  );
}

export default CoachHomeV2;
