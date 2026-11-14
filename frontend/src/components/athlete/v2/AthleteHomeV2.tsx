/**
 * Hoy del deportista — V2 (lienzo DepHoy).
 *
 * Orden: cabecera → si el ADULTO debe, la frase y «Pagar $X» (mismo checkout
 * del deportista); si no, el próximo entreno y «Mostrar mi carnet» → la
 * convocatoria con «Voy / No puedo ir» (si es menor, solo lectura: responde su
 * acudiente; sin fecha de nacimiento responde él) → «¿Qué tan duro fue el martes?» de un toque con Deshacer → la
 * felicitación del profe → asistencia del mes y racha de entrenos asistidos →
 * torneos abiertos de su escuela (si hay).
 * Un error de lectura nunca se pinta como «no hay»: se dice y se puede reintentar.
 *
 * Al menor NUNCA se le muestra plata ni «Pagar» (decisión 6). Un error al
 * cargar los cobros del adulto nunca se ve como «al día».
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, CalendarCheck, Check, ChevronRight, Clock, Flame, IdCard, Trophy, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCurrency } from '@/lib/utils';
import { sumDue } from '@/components/parent/v2/pagosModel';
import { fechaCabecera, fraseVencimiento, iniciales, proximoEntreno, type Hijo } from '@/components/parent/v2/parentHomeLogic';
import {
  RPE_RAPIDO, asistenciaDelMes, cobrosPorPagar, cuandoFue, fechaCorta, fraseDeuda, mensajeErrorRpe, profeCorto, rachaDeEntrenos,
  respondeConvocatoria, textoPartido, unToqueAlcanza, vencimientoMasUrgente,
  type Edad, type RpeRapido,
} from './athleteV2Model';
import {
  autoevalKey, callupsKey, enviarRpeRapido, formularioAutoeval, responderConvocatoria, useAthleteAttendance, useAthleteTeams,
  useAutoevalPendiente, useMyCallups, useMyKudos, useTorneosAbiertos, type AutoevalPendiente, type EquipoDeportista,
} from './useAthleteV2Data';
import { useDeportista } from './useDeportista';
import { useAthleteCheckout } from './useAthleteCheckout';
import { SEGUNDOS_DESHACER, useEnvioConDeshacer } from './useEnvioConDeshacer';
import { useAhora } from './useAhora';
import { HoyJuegaCard } from '@/components/tournaments/live/HoyJuegaCard';

export interface AthleteHomeV2Props {
  /** A dónde lleva «Mostrar mi carnet» (pestaña Carnet). */
  carnetHref?: string;
  /** A dónde lleva «Ver mis felicitaciones» (Progreso › Felicitaciones). */
  felicitacionesHref?: string;
  /** Para pruebas. */
  hoy?: Date;
}

const vibrar = () => {
  try { navigator.vibrate?.(12); } catch { /* sin vibración */ }
};

export function AthleteHomeV2({ carnetHref = '/my-cards', felicitacionesHref = '/stats?tab=felicitaciones', hoy }: AthleteHomeV2Props) {
  const ahora = useAhora(hoy);
  const d = useDeportista();
  const teams = useAthleteTeams(d.userId);
  const escuela = teams.data?.find((t) => t.escuela)?.escuela ?? null;

  return (
    <div className="mx-auto flex w-full max-w-page-narrow flex-col gap-4 pb-nav-safe font-poppins animate-in fade-in duration-300 md:gap-5">
      {/* Sin campana propia: la única es la de la cabecera de la app (GlobalNotificationBell). */}
      <header className="flex items-center gap-3">
        <div aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-xs font-bold text-primary-foreground">
          {iniciales(escuela ?? 'SportMaps')}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">{escuela ?? 'SportMaps'}</span>
          <span className="text-xs text-muted-foreground">{fechaCabecera(ahora)}</span>
        </div>
      </header>

      {/* «Hoy juegas: Monsters vs Orange · Cancha 3» → página en vivo (solo si hay partido hoy). */}
      <HoyJuegaCard userId={d.userId} />

      <Principal
        ahora={ahora}
        carnetHref={carnetHref}
        equipos={teams.data ?? []}
        cargandoEquipos={teams.isLoading}
        errorEquipos={teams.isError}
        onReintentarEquipos={() => { void teams.refetch(); }}
      />

      <TarjetaConvocatoria userId={d.userId} edad={d.edad} />
      <TarjetaRpe userId={d.userId} ahora={ahora} />
      <TarjetaFelicitacion userId={d.userId} href={felicitacionesHref} />
      <Asistencia userId={d.userId} ahora={ahora} />
      <TorneosAbiertos userId={d.userId} />
    </div>
  );
}

/** Error discreto con «Reintentar»: nunca se confunde con «no hay». */
function ErrorDiscreto({ texto, onRetry, label }: { texto: string; onRetry: () => void; label: string }) {
  return (
    <section aria-label={label} role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-dashed px-4 py-2">
      <p className="flex flex-1 items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span>{texto}</span>
      </p>
      <Button variant="link" className="min-h-touch px-0 text-sm font-semibold" onClick={onRetry}>
        Reintentar
      </Button>
    </section>
  );
}

// ── Lo primero: pagar (adulto que debe) o el próximo entreno ────────────────

function Principal({ ahora, carnetHref, equipos, cargandoEquipos, errorEquipos, onReintentarEquipos }: {
  ahora: Date; carnetHref: string; equipos: EquipoDeportista[]; cargandoEquipos: boolean;
  /** Falló la lectura de equipos: NO es «no tienes equipo». */
  errorEquipos: boolean;
  onReintentarEquipos: () => void;
}) {
  const d = useDeportista();
  const checkout = useAthleteCheckout(d.userId, d.nombre);
  const entreno = useMemo(() => {
    const pseudo: Hijo[] = equipos.map((t) => ({
      id: t.teamId, nombre: '', avatarUrl: null, equipo: t.nombre, profe: t.profe, lugar: t.lugar,
      franjas: t.franjas, eps: null, fraseProfe: null, escuela: t.escuela,
    }));
    const p = proximoEntreno(pseudo, ahora);
    if (!p) return null;
    const team = equipos.find((t) => t.teamId === p.hijoId);
    return { ...p.frase, team };
  }, [equipos, ahora]);

  // Solo el adulto (o pagador explícito): al menor ni se le consulta.
  const cobrosCargando = d.paga && (d.cobros.isLoading || (!d.cobros.data && !d.cobros.isError));
  const cobrosError = d.paga && d.cobros.isError;
  const porPagar = d.paga ? cobrosPorPagar(d.cobros.data?.transacciones ?? []) : [];
  const debe = porPagar.length > 0;

  if (cobrosCargando || (cargandoEquipos && !debe)) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label="Cargando tu día">
        <Skeleton className="h-8 w-4/5 rounded-lg" />
        <Skeleton className="h-5 w-3/5 rounded-lg" />
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    );
  }

  const fraseEntreno = entreno && (
    <>
      Entrenas <b>{entreno.cuando}</b>
      {entreno.donde ? ` en ${entreno.donde}.` : '.'}
    </>
  );

  return (
    <>
      {cobrosError && (
        <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-start gap-2 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            No pudimos revisar tus pagos. Esto no quiere decir que estés al día.
          </p>
          <Button variant="outline" className="min-h-touch self-start rounded-xl" onClick={() => { void d.cobros.refetch(); }}>
            Reintentar
          </Button>
        </div>
      )}

      {debe ? (
        <section aria-label="Pagos" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-2xl font-bold leading-tight tracking-tight">{fraseDeuda(porPagar)}</h1>
            <p className="text-base text-muted-foreground">
              {[fraseVencimiento(vencimientoMasUrgente(porPagar), ahora), 'Pagas aquí o con el enlace que te llegó por WhatsApp.'].filter(Boolean).join(' ')}
            </p>
          </div>
          <Button
            className="h-14 rounded-2xl text-lg font-semibold active:scale-[0.97] motion-reduce:active:scale-100"
            onClick={() => checkout.pagar(porPagar)}
          >
            Pagar {formatCurrency(sumDue(porPagar))}
          </Button>
          {errorEquipos ? (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
              <span>No pudimos cargar tu entreno ·</span>
              <button type="button" className="min-h-touch font-semibold text-primary underline-offset-4 hover:underline" onClick={onReintentarEquipos}>
                Reintentar
              </button>
            </p>
          ) : fraseEntreno && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" aria-hidden />
              <span>{fraseEntreno}</span>
            </p>
          )}
          {checkout.modal}
        </section>
      ) : errorEquipos ? (
        <section aria-label="Tu día" role="alert" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <h1 className="flex items-center gap-2 text-lg font-bold leading-tight">
            <AlertCircle className="h-5 w-5 shrink-0 text-destructive" aria-hidden />
            No pudimos cargar tu entreno
          </h1>
          <p className="text-sm text-muted-foreground">Revisa tu conexión. Tu carnet sigue disponible.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="min-h-touch rounded-xl" onClick={onReintentarEquipos}>Reintentar</Button>
            <Button asChild variant="ghost" className="min-h-touch rounded-xl">
              <Link to={carnetHref}>Mostrar mi carnet</Link>
            </Button>
          </div>
        </section>
      ) : entreno ? (
        <section aria-label="Tu próximo entreno" className="flex flex-col gap-3 rounded-2xl border bg-card p-4 md:p-5">
          <h1 className="text-xl font-bold leading-tight tracking-tight md:text-2xl">{fraseEntreno}</h1>
          {entreno.team && (
            <p className="text-sm text-muted-foreground">
              {[entreno.team.nombre, entreno.team.profe ? profeCorto(entreno.team.profe) : null].filter(Boolean).join(' · ')}
            </p>
          )}
          <Button asChild className="h-14 rounded-2xl text-lg font-semibold">
            <Link to={carnetHref}>
              <IdCard className="mr-2 h-5 w-5" aria-hidden />
              Mostrar mi carnet
            </Link>
          </Button>
        </section>
      ) : (
        <section aria-label="Tu día" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
          <h1 className="text-xl font-bold leading-tight">
            {equipos.length === 0 ? 'Aún no tienes un equipo con horario.' : 'No tienes entrenos en los próximos días.'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {equipos.length === 0
              ? 'Cuando la escuela te asigne a un equipo, aquí verás cuándo y dónde entrenas.'
              : 'Cuando tu profe programe el siguiente, aparece aquí.'}
          </p>
          <Button asChild variant="outline" className="min-h-touch self-start rounded-xl">
            <Link to={carnetHref}>Mostrar mi carnet</Link>
          </Button>
        </section>
      )}
    </>
  );
}

// ── Convocatoria ─────────────────────────────────────────────────────────────

function TarjetaConvocatoria({ userId, edad }: { userId: string | undefined; edad: Edad }) {
  const q = useMyCallups(userId);
  const queryClient = useQueryClient();
  const envio = useEnvioConDeshacer();
  const [local, setLocal] = useState<Record<string, 'va' | 'no_va' | null>>({});

  // Un error de lectura NO es «no estás convocado»: se dice y se puede reintentar.
  // (Si la RPC no existe, useMyCallups devuelve `oculto` sin error y no se pinta nada.)
  if (q.isError) {
    return <ErrorDiscreto label="Convocatoria" texto="No pudimos revisar tus convocatorias." onRetry={() => { void q.refetch(); }} />;
  }
  if (!q.data || q.data.oculto) return null; // RPC aún sin aplicar, o cargando: no se pinta nada.
  const conv = q.data.data[0];
  if (!conv) return null;
  const responde = respondeConvocatoria(edad);
  const resp = conv.lineupId in local ? local[conv.lineupId] : conv.respuesta;

  const elegir = (r: 'va' | 'no_va') => {
    if (!userId) return;
    const antes = resp;
    vibrar();
    setLocal((m) => ({ ...m, [conv.lineupId]: r }));
    envio.programar(() => {
      responderConvocatoria(conv, r)
        .then(() => queryClient.invalidateQueries({ queryKey: callupsKey(userId) }))
        .catch((e: unknown) => {
          console.error('[deportista-v2] respond_callup', e);
          setLocal((m) => ({ ...m, [conv.lineupId]: antes }));
          toast.error('No pudimos avisarle a tu profe', { description: 'Inténtalo de nuevo.' });
        });
    });
    toast.success(r === 'va' ? 'Listo: vas al partido. Tu profe ya lo sabe.' : 'Le avisamos a tu profe que no puedes ir.', {
      duration: SEGUNDOS_DESHACER * 1000,
      action: {
        label: 'Deshacer',
        onClick: () => {
          if (envio.deshacer()) setLocal((m) => ({ ...m, [conv.lineupId]: antes }));
        },
      },
    });
  };

  const titulo = conv.rival ? `Estás en la convocatoria del partido contra ${conv.rival}.` : 'Estás en la convocatoria del próximo partido.';
  const detalle = [textoPartido(conv), conv.nota].filter(Boolean).join('. ');

  return (
    <section aria-label="Convocatoria" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        <Trophy className="h-4 w-4" aria-hidden /> Convocatoria
      </p>
      <div>
        <p className="text-base font-semibold leading-snug">{titulo}</p>
        {detalle && <p className="mt-1 text-sm text-muted-foreground">{detalle}</p>}
      </div>
      {!responde ? (
        <p className="rounded-xl bg-muted px-3 py-2 text-sm">
          {resp === 'va' ? 'Tu acudiente confirmó que vas.' : resp === 'no_va' ? 'Tu acudiente avisó que no puedes ir.' : 'Tu acudiente responde por ti desde su app.'}
        </p>
      ) : resp ? (
        <div className={cn('flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold', resp === 'va' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
          {resp === 'va' ? <Check className="h-4 w-4" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
          <span className="flex-1">{resp === 'va' ? 'Vas al partido' : 'Avisaste que no puedes ir'}</span>
          <button type="button" className="min-h-touch text-xs font-semibold underline" onClick={() => elegir(resp === 'va' ? 'no_va' : 'va')}>
            Cambiar
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button className="h-12 min-h-touch rounded-xl text-base font-semibold" onClick={() => elegir('va')}>Voy</Button>
          <Button variant="outline" className="h-12 min-h-touch rounded-xl text-base font-semibold" onClick={() => elegir('no_va')}>No puedo ir</Button>
        </div>
      )}
    </section>
  );
}

// ── ¿Qué tan duro fue? ──────────────────────────────────────────────────────

function TarjetaRpe({ userId, ahora }: { userId: string | undefined; ahora: Date }) {
  const q = useAutoevalPendiente(userId);
  if (!q.data) return null; // cargando, sin entreno pendiente o error de lectura: la tarjeta no sale.
  return <PreguntaRpe key={q.data.sessionId} pend={q.data} userId={userId!} ahora={ahora} />;
}

function PreguntaRpe({ pend, userId, ahora }: { pend: AutoevalPendiente; userId: string; ahora: Date }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const envio = useEnvioConDeshacer();
  const [elegido, setElegido] = useState<RpeRapido | null>(null);
  const alcanza = unToqueAlcanza(pend.requeridas);
  const formulario = formularioAutoeval(pend);

  const elegir = (label: RpeRapido, valor: number) => {
    if (!alcanza) {
      // La escuela pide más preguntas: se abre el formulario completo (no se inventan respuestas).
      navigate(formulario);
      return;
    }
    vibrar();
    setElegido(label);
    envio.programar(() => {
      enviarRpeRapido(pend.sessionId, userId, valor, pend.fichaId)
        .then(() => queryClient.invalidateQueries({ queryKey: autoevalKey(userId) }))
        .catch((e: unknown) => {
          console.error('[deportista-v2] submit_post_training_self_eval', e);
          setElegido(null);
          toast.error('No pudimos guardar tu respuesta', { description: mensajeErrorRpe(e) });
        });
    });
    toast.success(`Guardado: ${label}. Tu profe ya lo ve.`, {
      duration: SEGUNDOS_DESHACER * 1000,
      action: { label: 'Deshacer', onClick: () => { if (envio.deshacer()) setElegido(null); } },
    });
  };

  return (
    <section aria-label="¿Qué tan duro fue?" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <p className="text-base font-semibold">¿Qué tan duro fue {cuandoFue(pend.sessionDate, ahora)}?</p>
      <div role="radiogroup" aria-label="Qué tan duro fue" className="grid grid-cols-3 gap-2">
        {RPE_RAPIDO.map((o) => {
          const sel = elegido === o.label;
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={sel}
              onClick={() => elegir(o.label, o.value)}
              className={cn(
                'min-h-touch h-12 rounded-xl border text-base font-semibold transition motion-safe:active:scale-[0.97]',
                sel ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
                elegido && !sel && 'opacity-55',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <p className={cn('text-xs', elegido ? 'font-semibold text-primary' : 'text-muted-foreground')}>
        {elegido
          ? 'Listo. Tu profe ya lo ve.'
          : alcanza
            ? 'Un toque y listo. Tu profe lo usa para cuidar la carga.'
            : 'Tu escuela pide unas preguntas más: te llevamos al formulario.'}
      </p>
    </section>
  );
}

// ── Felicitación ────────────────────────────────────────────────────────────

function TarjetaFelicitacion({ userId, href }: { userId: string | undefined; href: string }) {
  const q = useMyKudos(userId, 1);
  if (!q.data || q.data.oculto) return null;
  const k = q.data.data[0];
  if (!k) return null;
  return (
    <section aria-label="Felicitación" className="flex gap-3 rounded-2xl border bg-card p-4">
      <div aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
        {iniciales(k.profe ?? 'Profe')}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{profeCorto(k.profe)} te felicitó</p>
        <p className="mt-0.5 text-base">«{k.mensaje}»</p>
        <Link to={href} className="mt-1 inline-flex min-h-touch items-center text-sm font-semibold text-primary">
          Ver mis felicitaciones <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

// ── Asistencia y racha ──────────────────────────────────────────────────────

function Asistencia({ userId, ahora }: { userId: string | undefined; ahora: Date }) {
  const q = useAthleteAttendance(userId);
  if (q.isLoading) return <Skeleton className="h-16 w-full rounded-2xl" />;
  if (q.isError) return null; // dato secundario: sin él la pantalla sigue (no se inventa una racha).
  const mes = asistenciaDelMes(q.data, ahora);
  const racha = rachaDeEntrenos(q.data);
  if (mes.total === 0 && racha === 0) return null;
  return (
    <section aria-label="Tu asistencia" className="grid grid-cols-1 gap-2 rounded-2xl border bg-card p-4 sm:grid-cols-2">
      <p className="flex items-center gap-2 text-sm">
        <CalendarCheck className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <span><b>{mes.vino} de {mes.total}</b> entrenos en {mes.mes}</span>
      </p>
      {racha > 0 && (
        <p className="flex items-center gap-2 text-sm">
          <Flame className="h-5 w-5 shrink-0 text-orange" aria-hidden />
          <span>
            <b>{racha} {racha === 1 ? 'entreno seguido' : 'seguidos'}</b> sin faltar
          </span>
        </p>
      )}
    </section>
  );
}

// ── Torneos abiertos (antes OpenTournamentsCard en el Dashboard) ─────────────

function TorneosAbiertos({ userId }: { userId: string | undefined }) {
  const q = useTorneosAbiertos(userId);
  const torneos = q.data ?? [];
  if (torneos.length === 0) return null; // cargando, sin torneos o error: no se pinta nada (como la tarjeta clásica).
  return (
    <section aria-label="Torneos abiertos" className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        <Trophy className="h-4 w-4" aria-hidden /> {torneos.length === 1 ? 'Torneo abierto' : 'Torneos abiertos'}
      </p>
      <ul className="flex flex-col gap-3">
        {torneos.map((t) => (
          <li key={t.id} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="break-words text-base font-semibold leading-snug">{t.title}</p>
              <p className="break-words text-sm text-muted-foreground">
                {[t.sport, t.city, fechaCorta(t.event_date)].filter(Boolean).join(' · ')}
              </p>
            </div>
            <Button asChild variant="outline" className="min-h-touch shrink-0 self-start rounded-xl sm:self-center">
              <Link to={`/tournaments/${t.id}/register`}>
                Inscribirme <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default AthleteHomeV2;
