/**
 * Estado de cuenta del hijo — vista del ACUDIENTE (rediseño V2) y, con
 * `modo="escuela"`, la misma pantalla para quien administra la escuela.
 *
 * Una frase («Sofía debe $ 765.000» / «Sofía está al día») y, para la familia,
 * un botón que lleva al ÚNICO flujo de pago (/my-payments, con `?pay=<id>` si es
 * un solo cobro). Debajo, los meses con su estado en palabras y UNA línea de
 * fechas («Límite 10 oct · pagó 8 oct»); cada mes se abre para ver sus cobros:
 * puntualidad, valor cobrado y pagado, y cómo se pagó. «Imprimir» es secundario.
 *
 * `modo="escuela"`: mismos datos, sin botones de pagar y con voz neutra. Quién la
 * ve lo decide AccountStatementPage (roles de administración); el adulto que
 * mira su propia cuenta sigue en la pantalla de siempre.
 *
 * Montos: el saldo es summary.total_open de la RPC; los valores por cobro son
 * los de la base, para mostrar. Nada se calcula aquí para cobrar.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Printer, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatCurrency } from '@/lib/utils';
import { getSignedReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  agruparPorMes, resumenCuenta, estadoCobro, detalleCobro, valorCobro, tituloCobro, primerNombre,
  lineaFechas, puntualidad, comoPago, asistenciaPorMes, textoAsistencia, ABRE_CHECKOUT, type AsistenciaMes, type CobroCuenta, type MesCuenta,
} from './estadoCuentaModel';
import { ChipEstado } from '@/components/common/ChipEstado';
import { printStatement, type StatementData } from './statementPrint';
import { imprimirEstadoConMarca } from './statementPrintBranded';
import { usePdfBranding } from '@/hooks/usePdfBranding';
import { EnviarAlAcudiente } from './EnviarAlAcudiente';

const MESES_VISIBLES = 12;

/** Quién mira: la familia (puede pagar) o la escuela (solo consulta). */
export type ModoEstadoCuenta = 'familia' | 'escuela' | 'publica';
// familia: con sesión, puede pagar (/my-payments). escuela: administración, solo consulta, ve comprobantes.
// publica: la página /e/:token (sin login): solo lectura; el «Pagar» lo pone la página, con el enlace de cobro.

/** Columnas de `payments` que usa esta pantalla (incluye las que dicen cómo se pagó). */
const COLUMNAS_COBRO =
  'id, status, amount, amount_paid, concept, due_date, payment_date, period_year, period_month, created_at, '
  + 'payment_method, payment_channel, payment_provider, receipt_url, wompi_reference, wompi_transaction_id, provider_transaction_id';

export interface EstadoCuentaAcudienteViewProps {
  state: 'loading' | 'error' | 'ready';
  statement?: StatementData;
  cobros?: CobroCuenta[];
  months: number;
  onRetry: () => void;
  onPrint: () => void;
  now?: Date;
  modo?: ModoEstadoCuenta;
  /** Asistencia ya resumida por mes (`YYYY-MM`). La página pública la trae del servidor; sin esto se calcula de `statement.events`. */
  asistencia?: Record<string, AsistenciaMes>;
}

/** Solo presenta (probado aparte). */
export function EstadoCuentaAcudienteView({ state, statement, cobros = [], months, onRetry, onPrint, now, modo = 'familia', asistencia: asistenciaDada }: EstadoCuentaAcudienteViewProps) {
  const ahora = useMemo(() => now ?? new Date(), [now]);
  const meses = useMemo(() => agruparPorMes(cobros, ahora), [cobros, ahora]);
  const asistencia = useMemo(
    () => (asistenciaDada ? new Map(Object.entries(asistenciaDada)) : asistenciaPorMes(statement?.events ?? [])),
    [asistenciaDada, statement],
  );
  const [abiertos, setAbiertos] = useState<Set<string> | null>(null);
  const [verTodos, setVerTodos] = useState(false);
  const escuela = modo === 'escuela';
  const puedePagar = modo === 'familia';

  if (state === 'loading') {
    return (
      <div className="mx-auto w-full max-w-page-narrow space-y-4 pb-nav-safe" aria-busy="true" aria-label="Cargando el estado de cuenta">
        <Skeleton className="h-8 w-4/5 rounded-lg" />
        <Skeleton className="h-5 w-3/5 rounded-lg" />
        <Skeleton className="h-14 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  if (state === 'error' || !statement) {
    return (
      <div className="mx-auto w-full max-w-page-narrow pb-nav-safe">
        <div role="alert" className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="flex items-center gap-2 text-base font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            No pudimos cargar el estado de cuenta
          </p>
          <p className="text-sm text-muted-foreground">
            Esto no quiere decir que esté al día. Revisa tu conexión e inténtalo de nuevo.
          </p>
          <Button variant="outline" className="min-h-touch rounded-xl" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Reintentar
          </Button>
        </div>
      </div>
    );
  }

  const nombre = statement.athlete_name;
  const resumen = resumenCuenta(nombre, Number(statement.summary.total_open || 0), cobros, formatCurrency, ahora);
  // «Te avisamos cuando la escuela lo apruebe» solo es verdad con sesión (la familia recibe la notificación).
  const subtitulo = puedePagar ? resumen.subtitulo : resumen.subtitulo?.replace(' Te avisamos cuando la escuela lo apruebe.', '');
  // Por defecto queda abierto el mes más reciente que tenga algo pendiente.
  const abiertosEfectivos = abiertos ?? new Set(meses.filter((m) => m.estado.label !== 'Pagado').slice(0, 1).map((m) => m.key));
  const toggle = (key: string) => {
    const next = new Set(abiertosEfectivos);
    if (next.has(key)) next.delete(key); else next.add(key);
    setAbiertos(next);
  };
  const visibles = verTodos ? meses : meses.slice(0, MESES_VISIBLES);
  const totalAsistencia: AsistenciaMes | null = [...asistencia.values()].reduce<AsistenciaMes | null>((acc, a) => ({
    asistio: (acc?.asistio ?? 0) + a.asistio, tarde: (acc?.tarde ?? 0) + a.tarde, excusada: (acc?.excusada ?? 0) + a.excusada,
    falto: (acc?.falto ?? 0) + a.falto, total: (acc?.total ?? 0) + a.total,
  }), null);

  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-5 pb-nav-safe">
      <section aria-label="Resumen" className="space-y-3">
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-muted-foreground">Estado de cuenta</p>
          <h1 className="text-2xl font-bold leading-tight tracking-tight">{resumen.titulo}</h1>
          {subtitulo && <p className="text-base text-muted-foreground">{subtitulo}</p>}
        </div>
        {puedePagar && resumen.boton && (
          <Button asChild className="h-14 w-full rounded-2xl text-lg font-semibold active:scale-[0.97] motion-reduce:active:scale-100">
            <Link to={resumen.boton.href}>{resumen.boton.label}</Link>
          </Button>
        )}
      </section>

      <section aria-label="Mes a mes" className="space-y-1.5">
        <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Mes a mes</h2>
        {meses.length === 0 ? (
          <div className="rounded-2xl border bg-card p-6 text-center">
            <p className="font-semibold">Aún no hay cobros</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {escuela
                ? `Cuando le generen un cobro a ${primerNombre(nombre)}, aparece aquí.`
                : `Cuando la escuela le genere un cobro a ${primerNombre(nombre)}, aparece aquí.`}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-card">
            {visibles.map((m, i) => (
              <FilaMes
                key={m.key}
                mes={m}
                primero={i === 0}
                abierto={abiertosEfectivos.has(m.key)}
                onToggle={() => toggle(m.key)}
                nombre={nombre}
                now={ahora}
                modo={modo}
                asistencia={asistencia.get(m.key)}
              />
            ))}
          </div>
        )}
        {!verTodos && meses.length > MESES_VISIBLES && (
          <Button variant="link" className="min-h-touch h-auto w-full text-sm font-semibold" onClick={() => setVerTodos(true)}>
            Ver meses anteriores
          </Button>
        )}
      </section>

      <section aria-label="Más opciones" className="space-y-3">
        {totalAsistencia && (
          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            Asistencia en los últimos {months} meses: {textoAsistencia(totalAsistencia)}.
          </p>
        )}
        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          Desde que entró: {formatCurrency(Number(statement.summary.total_expected || 0))} en cobros
          {' · '}{formatCurrency(Number(statement.summary.total_settled || 0))} pagados
          {Number(statement.summary.total_late_fees || 0) > 0 && ` · ${formatCurrency(Number(statement.summary.total_late_fees))} de recargo por mora`}.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center print:hidden">
          {puedePagar && (
            <Button asChild variant="outline" className="min-h-touch rounded-xl">
              <Link to="/my-payments">Ver todos los pagos</Link>
            </Button>
          )}
          <Button variant="ghost" className="min-h-touch rounded-xl" onClick={onPrint}>
            <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
            Imprimir
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">Al imprimir salen los últimos {months} meses.</p>
      </section>
    </div>
  );
}

function FilaMes({
  mes, primero, abierto, onToggle, nombre, now, modo, asistencia,
}: { mes: MesCuenta; primero: boolean; abierto: boolean; onToggle: () => void; nombre: string; now: Date; modo: ModoEstadoCuenta; asistencia?: AsistenciaMes }) {
  const panelId = `mes-${mes.key}`;
  const unico = mes.cobros.length === 1 ? mes.cobros[0] : null;
  return (
    <div className={cn(!primero && 'border-t')}>
      <button
        type="button"
        aria-expanded={abierto}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-base font-semibold">{mes.titulo}</span>
          <span className="text-xs text-muted-foreground">
            {unico ? lineaFechas(unico, now) : `${mes.cobros.length} cobros`}
          </span>
        </span>
        <ChipEstado {...mes.estado} />
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', abierto && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {abierto && (
        <ul id={panelId} className="space-y-2 bg-muted/30 px-4 pb-4 pt-1">
          {asistencia && (
            <li className="rounded-xl border border-dashed bg-card px-3 py-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Asistencia · </span>{textoAsistencia(asistencia)}
            </li>
          )}
          {mes.cobros.map((c) => (
            <FilaCobro key={c.id} cobro={c} nombre={nombre} now={now} modo={modo} conFechas={!unico} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Estados en los que ya hubo plata o un comprobante: ahí tiene sentido decir cómo se pagó. */
const CON_PAGO = ['paid', 'approved', 'partial', 'awaiting_approval'];

const COLOR_PUNTUALIDAD: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  aviso: 'text-orange-700 dark:text-orange-300',
  peligro: 'text-destructive',
};

function FilaCobro({ cobro, nombre, now, modo, conFechas }: { cobro: CobroCuenta; nombre: string; now: Date; modo: ModoEstadoCuenta; conFechas: boolean }) {
  const estado = estadoCobro(cobro, now);
  const escuela = modo === 'escuela';
  const pagable = modo === 'familia' && ABRE_CHECKOUT.includes(cobro.status);
  const irAPagos = modo === 'familia' && (cobro.status === 'partial' || cobro.status === 'glosado');
  const punt = puntualidad(cobro, now, formatCurrency);
  const conPago = CON_PAGO.includes(cobro.status);
  const como = conPago ? comoPago(cobro) : null;
  // «Sin registrar» solo le sirve a la escuela (le dice qué completar); a la familia no.
  const mostrarComo = !!como && (escuela || !como.sinRegistrar);
  const pagado = Number(cobro.amount_paid || 0);
  return (
    <li className="rounded-xl border bg-card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">{tituloCobro(cobro, nombre)}</span>
          {conFechas && <span className="text-xs text-muted-foreground">{lineaFechas(cobro, now)}</span>}
          <span className={cn('text-xs', estado.tono === 'peligro' ? 'text-destructive' : 'text-muted-foreground')}>
            {detalleCobro(cobro, now, formatCurrency, escuela ? 'escuela' : modo === 'publica' ? 'publica' : 'familia')}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span className="whitespace-nowrap text-sm font-bold">{formatCurrency(valorCobro(cobro))}</span>
          <ChipEstado {...estado} />
        </span>
      </div>
      {punt && <p className={cn('mt-1.5 text-xs font-semibold', COLOR_PUNTUALIDAD[punt.tono])}>{punt.label}</p>}
      {conPago && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <div>
            <dt className="text-muted-foreground">Valor cobrado</dt>
            <dd className="font-semibold">{formatCurrency(Number(cobro.amount || 0))}</dd>
          </div>
          {pagado > 0 && (
            <div>
              <dt className="text-muted-foreground">Valor pagado</dt>
              <dd className="font-semibold">{formatCurrency(pagado)}</dd>
            </div>
          )}
          {mostrarComo && como && (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Cómo pagó</dt>
              <dd className="font-semibold">
                {como.label}
                {escuela && como.nota && <span className="font-normal text-muted-foreground"> · {como.nota}</span>}
              </dd>
            </div>
          )}
          {como && como.soporte === 'comprobante' && cobro.receipt_url && (
            <div className="col-span-2">
              <dt className="text-muted-foreground">Comprobante</dt>
              <dd className="font-semibold">
                {escuela
                  ? <ComprobanteBoton receiptUrl={cobro.receipt_url} titulo={tituloCobro(cobro, nombre)} />
                  : 'Recibido por la escuela'}
              </dd>
            </div>
          )}
        </dl>
      )}
      {(pagable || irAPagos) && (
        <Link
          to={pagable ? `/my-payments?pay=${cobro.id}` : '/my-payments'}
          className="mt-1 inline-flex min-h-touch items-center gap-1 text-sm font-semibold text-primary"
        >
          {pagable ? 'Pagar este cobro' : cobro.status === 'glosado' ? 'Responder a la escuela' : 'Pagar el saldo'}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </li>
  );
}

/**
 * «Ver comprobante» (solo la escuela): pide un enlace temporal de 5 minutos al
 * almacenamiento (el mismo camino que Gestión de Pagos) y lo muestra en un modal.
 * Si el archivo no se puede abrir lo dice; nunca queda un botón que no hace nada.
 */
function ComprobanteBoton({ receiptUrl, titulo }: { receiptUrl: string; titulo: string }) {
  const [cargando, setCargando] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const abrir = async () => {
    setCargando(true);
    setError(false);
    const firmada = await getSignedReceiptUrl(receiptUrl);
    setCargando(false);
    if (!firmada) { setError(true); return; }
    setUrl(firmada);
  };
  const esPdf = /\.pdf(\?|$)/i.test(receiptUrl);
  return (
    <>
      <button type="button" onClick={() => void abrir()} disabled={cargando} className="inline-flex min-h-touch items-center gap-1.5 font-semibold text-primary underline underline-offset-2 disabled:opacity-60">
        {cargando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        Ver comprobante
      </button>
      {error && <span role="alert" className="mt-0.5 block text-xs font-normal text-destructive">No se pudo abrir el comprobante. Inténtalo de nuevo.</span>}
      <Dialog open={!!url} onOpenChange={(abierto) => { if (!abierto) setUrl(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Comprobante</DialogTitle>
            <DialogDescription>{titulo}</DialogDescription>
          </DialogHeader>
          {url && (esPdf
            ? <a href={url} target="_blank" rel="noreferrer" className="font-semibold text-primary underline">Abrir el PDF en otra pestaña</a>
            : <img src={url} alt={`Comprobante de ${titulo}`} className="max-h-[70vh] w-full rounded-lg border object-contain" />)}
          {url && <a href={url} target="_blank" rel="noreferrer" className="text-sm font-semibold text-primary hover:underline">Abrir en otra pestaña</a>}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Sin `child_id` en la URL: que la familia elija a cuál hijo. */
function ElegirHijo() {
  const { user } = useAuth();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['estado-cuenta-hijos', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.from('children').select('id, full_name').eq('parent_id', user!.id).order('full_name');
      if (error) throw error;
      return (data || []) as Array<{ id: string; full_name: string }>;
    },
  });
  if (isLoading) return <EstadoCuentaAcudienteView state="loading" months={12} onRetry={() => {}} onPrint={() => {}} />;
  if (isError) return <EstadoCuentaAcudienteView state="error" months={12} onRetry={() => void refetch()} onPrint={() => {}} />;
  return (
    <div className="mx-auto w-full max-w-page-narrow space-y-4 pb-nav-safe">
      <h1 className="text-2xl font-bold leading-tight tracking-tight">¿De quién quieres ver el estado de cuenta?</h1>
      {data && data.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border bg-card">
          {data.map((h, i) => (
            <Link
              key={h.id}
              to={`/estado-cuenta?child_id=${h.id}`}
              className={cn('flex min-h-touch items-center gap-3 px-4 py-3 hover:bg-muted/50', i > 0 && 'border-t')}
            >
              <span className="flex-1 text-base">{h.full_name}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border bg-card p-6 text-center">
          <p className="font-semibold">Aún no tienes deportistas vinculados</p>
          <Button asChild variant="outline" className="mt-3 min-h-touch rounded-xl">
            <Link to="/children">Ir a mis hijos</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

export interface EstadoCuentaAcudienteProps {
  schoolId: string | null | undefined;
  childId: string | undefined;
  /** Solo `modo="escuela"`: deportista adulto con cuenta, o ficha sin cuenta. */
  userId?: string;
  unregisteredId?: string;
  months: number;
  /** El contexto de escuela aún está cargando (sin escuela todavía no es un error). */
  schoolLoading?: boolean;
  modo?: ModoEstadoCuenta;
}

export function EstadoCuentaAcudiente({ schoolId, childId, userId, unregisteredId, months, schoolLoading = false, modo = 'familia' }: EstadoCuentaAcudienteProps) {
  const { toast } = useToast();
  const marca = usePdfBranding();
  const haySujeto = !!(childId || userId || unregisteredId);

  // Misma RPC y misma llave de caché que la vista clásica de la escuela.
  const statement = useQuery({
    queryKey: ['account-statement', schoolId, childId, userId, unregisteredId, months],
    enabled: !!schoolId && haySujeto,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('get_athlete_account_statement', {
        p_school_id: schoolId,
        p_child_id: childId ?? null,
        p_user_id: userId ?? null,
        p_unregistered_athlete_id: unregisteredId ?? null,
        p_months: months,
      });
      if (error) throw error;
      return data as StatementData;
    },
  });

  // Los cobros del deportista en esa escuela (mismo alcance que la RPC), para el
  // detalle por mes y para saber a qué cobro lleva «Pagar».
  const cobros = useQuery({
    queryKey: ['estado-cuenta-cobros', schoolId, childId, userId, unregisteredId],
    enabled: !!schoolId && haySujeto,
    queryFn: async () => {
      let q = supabase.from('payments').select(COLUMNAS_COBRO).eq('school_id', schoolId!);
      if (childId) q = q.eq('child_id', childId);
      else if (userId) q = q.eq('user_id', userId);
      else q = q.eq('unregistered_athlete_id', unregisteredId!);
      const { data, error } = await q.order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as CobroCuenta[];
    },
  });

  if (!haySujeto) return <ElegirHijo />;

  const state: 'loading' | 'error' | 'ready' =
    !schoolId
      ? (schoolLoading ? 'loading' : 'error')
      : statement.isError || cobros.isError
        ? 'error'
        : statement.data && cobros.data
          ? 'ready'
          : 'loading';

  // Revisión antes de enviar: el mismo documento que ve la familia, sin abrir el diálogo de impresión.
  const verDocumento = () => {
    if (!statement.data || !cobros.data) return;
    imprimirEstadoConMarca({
      statement: statement.data, cobros: cobros.data, months, modo: 'familia',
      marca: {
        nombre: marca.schoolName, logoUrl: marca.logoUrl,
        colorPrimario: marca.brandingSettings.primary_color, colorSecundario: marca.brandingSettings.secondary_color,
        fondoLogo: marca.iconBg ?? null, mostrarMarcaSportmaps: marca.brandingSettings.show_sportmaps_watermark,
      },
    }, { imprimir: false });
  };

  // «Enviar al acudiente»: solo la escuela, para el deportista que está mirando.
  const atleta = childId ? { tipo: 'hijo' as const, id: childId }
    : userId ? { tipo: 'adulto' as const, id: userId }
    : unregisteredId ? { tipo: 'ficha' as const, id: unregisteredId } : null;

  return (
    <>
      {modo === 'escuela' && atleta && state === 'ready' && (
        <div className="mx-auto flex w-full max-w-page-narrow justify-end pb-3">
          <EnviarAlAcudiente atleta={atleta} onVerDocumento={statement.data && cobros.data ? verDocumento : undefined} />
        </div>
      )}
      <EstadoCuentaAcudienteView
        state={state}
        statement={statement.data}
        cobros={cobros.data}
        months={months}
        modo={modo}
        onRetry={() => { void statement.refetch(); void cobros.refetch(); }}
        onPrint={() => {
          if (!statement.data) return;
          // Con los cobros cargados sale el documento con la marca de la escuela (mes a mes, fechas,
          // cómo pagó, asistencia); sin ellos, la versión simple de siempre.
          const impreso = cobros.data
            ? imprimirEstadoConMarca({
              statement: statement.data,
              cobros: cobros.data,
              months,
              modo: modo === 'escuela' ? 'escuela' : 'familia',
              marca: {
                nombre: marca.schoolName,
                logoUrl: marca.logoUrl,
                colorPrimario: marca.brandingSettings.primary_color,
                colorSecundario: marca.brandingSettings.secondary_color,
                fondoLogo: marca.iconBg ?? null,
                mostrarMarcaSportmaps: marca.brandingSettings.show_sportmaps_watermark,
              },
            })
            : printStatement(statement.data, months);
          if (!impreso) {
            toast({
              title: 'No se pudo abrir la impresión',
              description: 'Tu navegador bloqueó la ventana. Permite las ventanas emergentes para este sitio o ábrelo desde el navegador del celular.',
            });
          }
        }}
      />
    </>
  );
}
