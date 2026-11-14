/**
 * Inicio del acudiente — rediseño V2 (lienzo «Acudiente · Inicio»).
 *
 * Orden: cabecera (escuela, fecha, campana) → lo que debe la familia y el botón
 * de pagar (o «Todo al día») → próximo entreno → una tarjeta por hijo → a lo
 * sumo UNA pregunta por un dato que falta (EPS).
 *
 * Carga, error y vacío son estados distintos: un error de red nunca se muestra
 * como «no debes nada» (UX-2).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Clock, AlertCircle } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { parentsAPI } from '@/lib/api/parents';
import { cn } from '@/lib/utils';
import {
  chipHijo,
  cobrosQueSeDeben,
  conPuntoFinal,
  fechaCabecera,
  hijoSinEps,
  iniciales,
  primerNombre,
  proximoEntreno,
  resumenFamilia,
  type Cobro,
  type Hijo,
} from './parentHomeLogic';
import { parentHomeQueryKey, useParentHomeData } from './useParentHomeData';
import { useParentAgenda } from './useParentCalendarData';
import { buildAgenda } from './parentCalendarModel';
import { fraseEntrenoDeAgenda } from './parentHomeLogic';
import { TarjetaConvocatoria, useConvocatoriasFamilia } from './TarjetaConvocatoria';
import { proximaConvocatoriaDe, type ConvocatoriaHijo } from './convocatoriasAcudiente';
import { HoyJuegaCard } from '@/components/tournaments/live/HoyJuegaCard';

/** EPS más comunes como respuesta de un toque. `value` = lo que guarda `children.eps_name` (lib/colombian-eps). */
const OPCIONES_EPS = [
  { label: 'Sura', value: 'Sura EPS' },
  { label: 'Sanitas', value: 'Sanitas EPS' },
  { label: 'Nueva EPS', value: 'Nueva EPS' },
  { label: 'Compensar', value: 'Compensar EPS' },
];

interface ParentHomeV2Props {
  userId: string | undefined;
  nombreAcudiente: string | null | undefined;
  /** Banners que el tablero ya mostraba al acudiente (invitación pendiente, etc.). */
  extras?: ReactNode;
  /** Lo que va al final, debajo de las tarjetas (torneos abiertos). */
  pie?: ReactNode;
  /** Para pruebas. */
  hoy?: Date;
}

export function ParentHomeV2({ userId, nombreAcudiente, extras, pie, hoy }: ParentHomeV2Props) {
  const ahora = useMemo(() => hoy ?? new Date(), [hoy]);
  const { data, isLoading, isError, refetch, isFetching } = useParentHomeData(userId);

  const escuela = data?.hijos.find((h) => h.escuela)?.escuela ?? null;

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 pb-nav-safe font-poppins animate-in fade-in duration-300">
      <Cabecera escuela={escuela} fecha={fechaCabecera(ahora)} />

      {extras}

      {/* «Hoy juega tu hija…» → página en vivo del torneo (solo si hay partido hoy). */}
      <HoyJuegaCard userId={userId} />

      {isLoading || (!data && !isError) ? (
        <CargandoInicio />
      ) : isError || !data ? (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold">No pudimos cargar tu información.</p>
              <p className="text-sm text-muted-foreground">
                Revisa tu conexión. Mientras tanto no sabemos si tienes cobros pendientes.
              </p>
            </div>
          </div>
          <Button variant="outline" className="min-h-touch self-start rounded-xl" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? 'Cargando…' : 'Reintentar'}
          </Button>
        </div>
      ) : (
        <Contenido hijos={data.hijos} cobros={data.cobros} nombreAcudiente={nombreAcudiente ?? ''} ahora={ahora} userId={userId} />
      )}

      {pie}
    </div>
  );
}

// Sin campana propia: la única es la de la cabecera de la app (GlobalNotificationBell).
function Cabecera({ escuela, fecha }: { escuela: string | null; fecha: string }) {
  const nombre = escuela ?? 'SportMaps';
  return (
    <header className="flex items-center gap-3">
      <div
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-primary-foreground"
      >
        {iniciales(nombre)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold">{nombre}</span>
        <span className="text-xs text-muted-foreground">{fecha}</span>
      </div>
    </header>
  );
}

function CargandoInicio() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Cargando tu inicio">
      <Skeleton className="h-8 w-4/5 rounded-lg" />
      <Skeleton className="h-5 w-3/5 rounded-lg" />
      <Skeleton className="h-14 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
    </div>
  );
}

function Contenido({
  hijos, cobros, nombreAcudiente, ahora, userId,
}: { hijos: Hijo[]; cobros: Cobro[]; nombreAcudiente: string; ahora: Date; userId: string | undefined }) {
  const resumen = resumenFamilia(cobros, hijos, nombreAcudiente, ahora);
  // El próximo entreno sale de la MISMA agenda que el Calendario (todos los
  // equipos de cada hijo, y respeta festivos y cancelaciones de la escuela),
  // para que Inicio nunca diga «entrena hoy» cuando el Calendario dice que no.
  // Si la agenda no carga, cae al horario del equipo.
  const agenda = useParentAgenda();
  const entrenoAgenda = useMemo(
    () => (agenda.data ? fraseEntrenoDeAgenda(buildAgenda({ ...agenda.data, now: ahora, days: 7, userId }), ahora) : undefined),
    [agenda.data, ahora, userId],
  );
  const entreno = entrenoAgenda !== undefined ? entrenoAgenda : proximoEntreno(hijos, ahora);
  // B1: «¿Va Tomás?» en la tarjeta de cada hijo convocado.
  const convocatorias = useConvocatoriasFamilia(userId).data ?? [];
  const deudas = cobrosQueSeDeben(cobros);

  return (
    <>
      <section aria-label="Pagos" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-bold leading-tight tracking-tight">{resumen.titulo}</h1>
          {resumen.subtitulo && <p className="text-base text-muted-foreground">{resumen.subtitulo}</p>}
        </div>
        {resumen.debe && (
          <Button asChild className="h-14 rounded-2xl text-lg font-semibold active:scale-[0.97] motion-reduce:active:scale-100">
            <Link to={resumen.pagarHref}>Pagar {formatCurrency(resumen.total)}</Link>
          </Button>
        )}
      </section>

      {entreno && (
        <div className="flex items-center gap-3 rounded-2xl bg-primary/10 px-4 py-3 text-primary">
          <Clock className="h-5 w-5 shrink-0" aria-hidden />
          <p className="text-base leading-snug">
            {entreno.frase.quien} entrena <b>{entreno.frase.cuando}</b>
            {entreno.frase.donde
              ? ` en ${conPuntoFinal(entreno.frase.donde)}`
              : conPuntoFinal(entreno.frase.cuando).slice(entreno.frase.cuando.trimEnd().length)}
          </p>
        </div>
      )}

      {hijos.length === 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <p className="text-base font-semibold">Aún no tienes deportistas vinculados.</p>
          <p className="text-sm text-muted-foreground">
            Si la escuela ya inscribió a tu hijo, acepta la invitación que te llegó al correo. Si no, agrégalo tú.
          </p>
          <Button asChild variant="outline" className="min-h-touch self-start rounded-xl">
            <Link to="/children">Ir a mis hijos</Link>
          </Button>
        </div>
      ) : (
        <section aria-label="Tus deportistas" className="flex flex-col gap-3">
          {hijos.map((h) => (
            <TarjetaHijo
              key={h.id}
              hijo={h}
              cobros={deudas.filter((c) => c.child_id === h.id)}
              convocatoria={proximaConvocatoriaDe(convocatorias, h.id)}
              userId={userId}
            />
          ))}
        </section>
      )}

      <PreguntaEps hijos={hijos} userId={userId} />
    </>
  );
}

function TarjetaHijo({
  hijo, cobros, convocatoria, userId,
}: { hijo: Hijo; cobros: Cobro[]; convocatoria: ConvocatoriaHijo | null; userId: string | undefined }) {
  const chip = chipHijo(cobros);
  const detalle = [hijo.equipo, hijo.profe ? `Profe ${primerNombre(hijo.profe)}` : null].filter(Boolean).join(' · ');
  return (
    <article className="overflow-hidden rounded-2xl border bg-card text-card-foreground" data-testid="tarjeta-hijo">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Avatar className="h-12 w-12">
          {hijo.avatarUrl && <AvatarImage src={hijo.avatarUrl} alt="" className="object-cover" />}
          <AvatarFallback className="bg-primary/10 text-base font-bold text-primary">{iniciales(hijo.nombre)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-lg font-semibold">{primerNombre(hijo.nombre) || hijo.nombre}</span>
          {detalle && <span className="truncate text-xs text-muted-foreground">{detalle}</span>}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
            chip.debe
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
              : 'bg-primary/10 text-primary',
          )}
        >
          {chip.texto}
        </span>
      </div>
      {hijo.fraseProfe && (
        <div className="px-4 pb-3.5">
          <p className="rounded-xl bg-muted/60 p-3 text-sm leading-relaxed">
            «{hijo.fraseProfe}»
            {hijo.profe && <span className="mt-1 block text-xs text-muted-foreground">Profe {primerNombre(hijo.profe)}</span>}
          </p>
        </div>
      )}
      {convocatoria && (
        <div className="border-t px-4 py-3.5">
          <TarjetaConvocatoria conv={convocatoria} userId={userId} compacta />
        </div>
      )}
      <Link
        to={`/children?hijo=${hijo.id}`}
        className="flex min-h-touch items-center gap-3 border-t px-4 py-3 text-base hover:bg-muted/50"
      >
        <span className="flex-1">Ver cómo va</span>
        <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
      </Link>
    </article>
  );
}

function PreguntaEps({ hijos, userId }: { hijos: Hijo[]; userId: string | undefined }) {
  const queryClient = useQueryClient();
  // Hijos ya respondidos en esta visita: la pregunta no reaparece mientras se refresca.
  const [respondidos, setRespondidos] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const hijo = hijoSinEps(hijos.filter((h) => !respondidos.has(h.id)));
  if (!hijo) return null;
  const nombre = primerNombre(hijo.nombre) || 'tu hijo';

  const refrescar = () => queryClient.invalidateQueries({ queryKey: parentHomeQueryKey(userId) });

  const elegir = async (eps: string, label: string) => {
    setGuardando(true);
    try {
      await parentsAPI.updateChild(hijo.id, { eps_name: eps });
      setRespondidos((s) => new Set(s).add(hijo.id));
      try { navigator.vibrate?.(12); } catch { /* sin vibración */ }
      toast.success(`EPS de ${nombre} guardada: ${label}`, {
        duration: 8000,
        action: {
          label: 'Deshacer',
          onClick: async () => {
            try {
              await parentsAPI.updateChild(hijo.id, { eps_name: null });
              setRespondidos((s) => { const n = new Set(s); n.delete(hijo.id); return n; });
              refrescar();
            } catch {
              toast.error('No pudimos deshacerlo. Corrígela en Mis hijos.');
            }
          },
        },
      });
      refrescar();
    } catch {
      toast.error('No pudimos guardar la EPS. Intenta de nuevo.');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <section aria-label="Falta un dato" className="flex flex-col gap-2.5 rounded-2xl border bg-card p-4">
      <p className="text-base font-semibold">Falta un dato de {nombre}</p>
      <p className="text-sm leading-snug text-muted-foreground">
        ¿Cuál es su EPS? Solo la ve la escuela, por si hay una emergencia.
      </p>
      <div className="flex flex-wrap gap-2">
        {OPCIONES_EPS.map((o) => (
          <Button
            key={o.value}
            type="button"
            variant="outline"
            disabled={guardando}
            onClick={() => elegir(o.value, o.label)}
            className="min-h-touch rounded-full px-3.5 text-sm font-medium active:scale-[0.97] motion-reduce:active:scale-100"
          >
            {o.label}
          </Button>
        ))}
        <Button asChild variant="outline" className="min-h-touch rounded-full px-3.5 text-sm font-medium">
          <Link to={`/children?hijo=${hijo.id}&tab=ficha`}>Otra</Link>
        </Button>
      </div>
    </section>
  );
}

export default ParentHomeV2;
