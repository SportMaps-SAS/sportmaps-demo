/**
 * Evaluar al equipo — V2 (lienzo «Entrenador · Evaluar»).
 *
 * Una pantalla: solo los que vinieron (presente o tarde) a una sesión con la
 * lista ya cerrada (si sigue abierta, «Cerrar la lista y evaluar» la cierra
 * aquí mismo); todos arrancan en «Normal»; «A todos: Bien»; Felicitar por
 * deportista (si la RPC `give_kudos` existe); nota opcional para las familias;
 * guardar con Deshacer.
 *
 * Escala: Bien · Normal · Le costó → `coach_effort_rating` 90 · 70 · 60 vía
 * `submit_post_training_coach_rating` (ver EFFORT_DE en coachV2Logic). Es la
 * misma métrica que el acudiente ya ve como «Así le fue».
 *
 * «¿Qué tan duro fue el entreno?» del lienzo NO está: la sesión no tiene dónde
 * guardarlo (attendance_sessions no tiene intensidad) y no se inventa columna.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronLeft, Check, Star } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { InlineError, SectionSkeleton, EmptyNote } from '@/components/parent/v2/hijos/parts';
import {
  conRutas,
  diaLargo,
  EFFORT_DE,
  ETIQUETA_COMO,
  iniciales,
  mensajeErrorEvaluar,
  OPCIONES_COMO,
  primerNombre,
  type ComoLeFue,
  type RutasCoachV2,
} from './coachV2Logic';
import { useFelicitarDisponible, usePresentesSesion, useSesionDetalle, type PresenteSesion } from './useCoachV2Data';
import { cerrarListaSesion } from './useAsistenciaV2Data';
import { useAccionConDeshacer } from './useAccionConDeshacer';
import { FelicitarSheet } from './FelicitarSheet';
import { enviarFelicitacion, avisarResultadoFelicitacion, sujetoFelicitar, type ObjetivoFelicitar } from './felicitar';

const TONO: Record<ComoLeFue, string> = {
  bien: 'border-primary bg-primary/10 text-primary',
  normal: 'border-foreground/60 bg-muted text-foreground',
  costo: 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
};

interface Props {
  sessionId: string;
  rutas?: Partial<RutasCoachV2>;
  /** A dónde vuelve la flecha. Por defecto, al Hoy. */
  volverHref?: string;
  onGuardado?: () => void;
}

export function CoachEvaluateV2({ sessionId, rutas: rutasProp, volverHref = '/dashboard', onGuardado }: Props) {
  const rutas = conRutas(rutasProp);
  const sesion = useSesionDetalle(sessionId);
  const presentes = usePresentesSesion(sesion.data?.cerrada ? sessionId : null);
  // Disponibilidad de Felicitar: se prueba una vez con un deportista real de la lista.
  const sujetoPrueba = useMemo(() => {
    for (const p of presentes.data ?? []) {
      const s = sujetoFelicitar({ clave: p.clave, nombre: p.nombre, childId: p.childId, userId: p.userId, unregisteredId: p.unregisteredId });
      if (s) return s;
    }
    return null;
  }, [presentes.data]);
  const felicitarOk = useFelicitarDisponible(sujetoPrueba);
  const qc = useQueryClient();
  const { programar } = useAccionConDeshacer();

  const [como, setComo] = useState<Record<string, ComoLeFue>>({});
  const [nota, setNota] = useState('');
  // B3: «Guardado» solo cuando la RPC respondió bien. Mientras corre la
  // ventana de Deshacer el botón dice «Se guarda en unos segundos».
  const [estado, setEstado] = useState<'editando' | 'programado' | 'guardado'>('editando');
  const guardado = estado !== 'editando';
  const setGuardado = (v: boolean) => setEstado(v ? 'programado' : 'editando');
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);
  const [felicitados, setFelicitados] = useState<Set<string>>(new Set());
  const [hoja, setHoja] = useState<ObjetivoFelicitar | null>(null);
  const [cerrando, setCerrando] = useState(false);

  // Se llega con la lista abierta desde el pendiente «Falta evaluar» del Hoy:
  // se cierra aquí mismo en vez de mandar de vuelta a la lista.
  const cerrarYEvaluar = async () => {
    setCerrando(true);
    try {
      await cerrarListaSesion(sessionId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['coach-v2', 'sesion', sessionId] }),
        qc.invalidateQueries({ queryKey: ['v2-asis-sesion'] }),
      ]);
    } catch (e) {
      toast.error(`No se pudo cerrar la lista: ${(e as Error)?.message || 'inténtalo de nuevo.'}`);
    } finally {
      setCerrando(false);
    }
  };

  // Lo ya guardado manda sobre «Normal» (re-evaluar no borra lo anterior).
  useEffect(() => {
    if (sesion.data) {
      setComo((c) => ({ ...sesion.data!.previas, ...c }));
      setNota((n) => n || sesion.data!.nota || '');
    }
  }, [sesion.data]);

  const evaluables = useMemo(() => (presentes.data ?? []).filter((p) => !p.sinCuenta), [presentes.data]);
  const valor = (p: PresenteSesion): ComoLeFue => como[p.clave] ?? 'normal';
  const bien = evaluables.filter((p) => valor(p) === 'bien').length;
  const costo = evaluables.filter((p) => valor(p) === 'costo').length;

  const elegir = (clave: string, c: ComoLeFue) => {
    setComo((prev) => ({ ...prev, [clave]: c }));
    setGuardado(false);
  };

  const todosBien = () => {
    const previo = como;
    const nuevo: Record<string, ComoLeFue> = { ...como };
    for (const p of evaluables) nuevo[p.clave] = 'bien';
    setComo(nuevo);
    setGuardado(false);
    toast(`Los ${evaluables.length} quedaron en «Bien». Toca al que le costó.`, {
      duration: 8000,
      action: { label: 'Deshacer', onClick: () => setComo(previo) },
    });
  };

  const guardar = () => {
    if (guardado || evaluables.length === 0) return;
    const p_ratings = evaluables.map((p) => ({
      ...(p.childId ? { child_id: p.childId } : { user_id: p.userId }),
      effort_pct: EFFORT_DE[valor(p)],
    }));
    const p_coach_notes = nota.trim() || null;
    setEstado('programado');
    setErrorGuardar(null);
    programar(
      `evaluar:${sessionId}`,
      'Se guarda en 8 segundos.',
      async () => {
        let error: { code?: string; message?: string } | null = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (supabase as any).rpc('submit_post_training_coach_rating', {
            p_session_id: sessionId,
            p_ratings,
            p_coach_notes,
          });
          error = r.error ?? null;
        } catch (e) {
          error = { message: e instanceof Error ? e.message : String(e) };
        }
        if (error) {
          console.error('[evaluar] submit_post_training_coach_rating', error);
          const texto = mensajeErrorEvaluar(error);
          setEstado('editando');
          setErrorGuardar(texto);
          // Sin vencimiento: el error puede llegar cuando el profe ya está en
          // otra pantalla, y no puede pasar desapercibido.
          toast.error(texto, { id: `evaluar-error-${sessionId}`, duration: Infinity, closeButton: true });
          return;
        }
        setEstado('guardado');
        toast.success('Evaluación guardada. Las familias reciben «Así le fue hoy».', { id: `evaluar-ok-${sessionId}` });
        qc.invalidateQueries({ queryKey: ['coach-v2'] });
        onGuardado?.();
      },
      () => setEstado('editando'),
      { tono: 'info' },
    );
  };

  const schoolId = sesion.data?.schoolId ?? null;
  const enviarKudo = (o: ObjetivoFelicitar, mensaje: string) => {
    setHoja(null);
    if (!schoolId) return;
    setFelicitados((s) => new Set(s).add(o.clave));
    programar(
      `kudo:${o.clave}`,
      `Le avisamos a la familia de ${primerNombre(o.nombre)}.`,
      async () => {
        const r = await enviarFelicitacion(schoolId, o, mensaje);
        avisarResultadoFelicitacion(r, o.nombre);
        if (r === 'error') setFelicitados((s) => { const n = new Set(s); n.delete(o.clave); return n; });
      },
      () => setFelicitados((s) => { const n = new Set(s); n.delete(o.clave); return n; }),
    );
  };

  const equipo = sesion.data?.equipo ?? 'el equipo';
  const n = evaluables.length;

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col pb-nav-safe font-poppins md:max-w-page">
      <header className="sticky top-0 z-10 -mx-gutter flex items-center gap-1 border-b bg-background/95 px-2 py-2 backdrop-blur md:mx-0">
        <Link to={volverHref} aria-label="Volver" className="flex h-touch w-touch items-center justify-center rounded-full hover:bg-muted">
          <ChevronLeft className="h-5 w-5" aria-hidden />
        </Link>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-lg font-bold">Evaluar · {equipo}</h1>
          {sesion.data && (
            <span className="text-xs text-muted-foreground">
              {diaLargo(sesion.data.fecha)}{presentes.data ? ` · vinieron ${presentes.data.length}` : ''}
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-4 pt-4">
        {sesion.isLoading ? (
          <SectionSkeleton rows={5} label="Cargando la evaluación" />
        ) : sesion.isError || !sesion.data ? (
          <InlineError message="No pudimos abrir este entreno. Revisa tu conexión." onRetry={() => sesion.refetch()} />
        ) : !sesion.data.cerrada ? (
          <EmptyNote>
            <p className="font-semibold text-foreground">La lista de este entreno sigue abierta.</p>
            <p className="mt-1">Ciérrala para evaluar: solo se evalúa a los que vinieron, y a sus familias les llega la encuesta del entreno.</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <Button className="min-h-touch rounded-xl" disabled={cerrando} onClick={() => void cerrarYEvaluar()}>
                {cerrando ? 'Cerrando…' : 'Cerrar la lista y evaluar'}
              </Button>
              <Button asChild variant="outline" className="min-h-touch rounded-xl"><Link to={rutas.tomarLista}>Revisar la lista</Link></Button>
            </div>
          </EmptyNote>
        ) : presentes.isLoading ? (
          <SectionSkeleton rows={5} label="Cargando a los que vinieron" />
        ) : presentes.isError ? (
          <InlineError message="No pudimos traer a los que vinieron." onRetry={() => presentes.refetch()} />
        ) : (presentes.data ?? []).length === 0 ? (
          <EmptyNote>Nadie vino a este entreno, así que no hay a quién evaluar.</EmptyNote>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <h2 className="text-2xl font-bold leading-tight tracking-tight">¿Cómo le fue a cada uno?</h2>
              <p className="text-sm text-muted-foreground">Todos arrancan en «Normal». Toca solo al que le fue bien o le costó.</p>
            </div>

            <div className="flex items-center justify-between">
              <span className="pl-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{n} {n === 1 ? 'deportista' : 'deportistas'} por evaluar</span>
              {n > 0 && (
                <Button variant="ghost" className="min-h-touch font-semibold text-primary" onClick={todosBien}>
                  A todos: Bien
                </Button>
              )}
            </div>

            <ul className="overflow-hidden rounded-2xl border bg-card md:grid md:grid-cols-2 md:gap-px md:bg-border">
              {(presentes.data ?? []).map((p) => (
                <li key={p.clave} className="flex flex-col gap-2 border-t bg-card px-3.5 py-3 first:border-t-0 md:border-t-0" data-testid="fila-evaluar">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-9 w-9">
                      {p.avatarUrl && <AvatarImage src={p.avatarUrl} alt="" className="object-cover" />}
                      <AvatarFallback className="bg-primary/10 text-xs font-bold text-primary">{iniciales(p.nombre)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate text-base font-medium">{p.nombre}</span>
                    {felicitarOk.data && (
                      felicitados.has(p.clave) ? (
                        <span className="flex min-h-touch items-center gap-1.5 px-2 text-sm font-semibold text-primary">
                          <Check className="h-4 w-4" aria-hidden /> Felicitado
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setHoja({ clave: p.clave, nombre: p.nombre, childId: p.childId, userId: p.userId, unregisteredId: p.unregisteredId })}
                          className="flex min-h-touch items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 text-sm font-semibold text-amber-800 active:scale-[0.97] motion-reduce:active:scale-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          <Star className="h-4 w-4" aria-hidden /> Felicitar
                        </button>
                      )
                    )}
                  </div>
                  {p.sinCuenta ? (
                    <p className="text-xs text-muted-foreground">Sin cuenta todavía: se podrá evaluar cuando la escuela la registre.</p>
                  ) : (
                    <div role="radiogroup" aria-label={`Cómo le fue a ${p.nombre}`} className="grid grid-cols-3 gap-1.5">
                      {OPCIONES_COMO.map((c) => {
                        const activo = valor(p) === c;
                        return (
                          <button
                            key={c}
                            type="button"
                            role="radio"
                            aria-checked={activo}
                            onClick={() => elegir(p.clave, c)}
                            className={cn(
                              'min-h-touch rounded-xl border-2 text-sm transition-transform active:scale-[0.97] motion-reduce:active:scale-100',
                              activo ? `${TONO[c]} font-semibold` : 'border-border bg-card font-medium text-muted-foreground',
                            )}
                          >
                            {ETIQUETA_COMO[c]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            <section className="flex flex-col gap-2 rounded-2xl border bg-card p-4">
              <label htmlFor="nota-familias" className="text-base font-semibold">Nota para las familias (opcional)</label>
              <span className="text-xs text-muted-foreground">Va en el informe del entreno a las familias de los que vinieron.</span>
              <Textarea
                id="nota-familias"
                value={nota}
                onChange={(e) => { setNota(e.target.value.slice(0, 2000)); setGuardado(false); }}
                placeholder="Ej.: Trabajamos la salida desde el arquero."
                className="rounded-xl"
                rows={3}
              />
            </section>

            {errorGuardar && (
              <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="error-evaluar">
                {errorGuardar}
              </div>
            )}

            <div className="sticky bottom-0 z-10 pb-3 pr-[4.5rem] pt-1 lg:pr-0" data-testid="barra-evaluar">
              <Button
                className={cn('h-auto min-h-14 w-full whitespace-normal rounded-2xl py-2 text-base font-semibold leading-tight shadow-lg', guardado && 'bg-muted-foreground hover:bg-muted-foreground')}
                onClick={guardar}
                disabled={n === 0}
              >
                {estado === 'guardado' ? 'Guardado' : estado === 'programado' ? 'Se guarda en unos segundos…' : (
                  <span className="flex flex-wrap items-baseline justify-center gap-x-1.5">
                    <span>Guardar evaluación</span>{' '}
                    <span className="text-sm font-medium opacity-90">({bien} bien · {costo} le costó)</span>
                  </span>
                )}
              </Button>
            </div>
          </>
        )}
      </div>

      <FelicitarSheet objetivo={hoja} onClose={() => setHoja(null)} onEnviar={enviarKudo} />
    </div>
  );
}

export default CoachEvaluateV2;
