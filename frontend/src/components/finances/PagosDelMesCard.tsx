/**
 * «¿Quién pagó en <mes>?» — Ciclo de Mes.
 *
 * Una lista de todos los atletas con cobro de mensualidad en el período: estado
 * en palabras, fecha límite y de pago, puntualidad y valor. Lo urgente va arriba.
 * Tocar una fila abre su estado de cuenta (EstadoCuentaDialog).
 *
 * Los datos salen de `payments` filtrados por escuela y período, y los nombres de
 * un `.in('id', ids)` por tabla (sin consultas por fila). El dinero del mes no se
 * suma aquí: lo da la RPC `preview_close_month` en las tarjetas de arriba.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatFilterBar } from '@/components/common/StatFilterBar';
import { ChipEstado } from '@/components/common/ChipEstado';
import { formatCurrency, cn } from '@/lib/utils';
import { isMensualidad } from '@/lib/cobrosYPagos';
import { lineaFechas, puntualidad, type ObjetivoEstadoCuenta } from '@/components/account-statement/estadoCuentaModel';
import { filasDelMes, resumenPagos, valorFila, type CobroDelMes, type GrupoPago } from './pagosDelMes';

const COLUMNAS =
  'id, status, amount, amount_paid, concept, due_date, payment_date, period_year, period_month, created_at, '
  + 'payment_category, child_id, user_id, unregistered_athlete_id, branch_id, '
  + 'payment_method, payment_channel, payment_provider, receipt_url, wompi_reference, wompi_transaction_id, provider_transaction_id';

const PAGINA = 1000;
const TROZO = 200;
const FILAS_VISIBLES = 50;

type Filtro = GrupoPago;

const trozos = <T,>(a: T[]) => Array.from({ length: Math.ceil(a.length / TROZO) }, (_, i) => a.slice(i * TROZO, (i + 1) * TROZO));

async function nombresPorId(tabla: 'children' | 'profiles' | 'unregistered_athletes', ids: string[]): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const t of trozos(ids)) {
    const { data, error } = await (supabase.from(tabla) as any).select('id, full_name').in('id', t);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; full_name: string | null }>) out.push([r.id, r.full_name ?? 'Sin nombre']);
  }
  return out;
}

interface PagosDelMes { cobros: CobroDelMes[]; nombres: Array<[string, string]> }

async function leerPagosDelMes(schoolId: string, activeBranchId: string | null | undefined, year: number, month: number): Promise<PagosDelMes> {
  const cobros: CobroDelMes[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    let q = (supabase.from('payments') as any)
      .select(COLUMNAS)
      .eq('school_id', schoolId)
      .eq('period_year', year)
      .eq('period_month', month)
      .neq('status', 'cancelled');
    // Con una sede elegida: los de esa sede Y los que no tienen sede (como Pagos).
    if (activeBranchId) q = q.or(`branch_id.eq.${activeBranchId},branch_id.is.null`);
    const { data, error } = await q.order('id', { ascending: true }).range(desde, desde + PAGINA - 1);
    if (error) throw error;
    cobros.push(...((data ?? []) as CobroDelMes[]));
    if ((data?.length ?? 0) < PAGINA) break;
  }
  const mensualidades = cobros.filter((c) => isMensualidad(c.payment_category));
  const ids = (campo: 'child_id' | 'user_id' | 'unregistered_athlete_id', excluir: Array<'child_id' | 'user_id' | 'unregistered_athlete_id'>) =>
    [...new Set(mensualidades.filter((c) => c[campo] && !excluir.some((e) => c[e])).map((c) => c[campo] as string))];
  const [hijos, adultos, fichas] = await Promise.all([
    nombresPorId('children', ids('child_id', [])),
    nombresPorId('profiles', ids('user_id', ['child_id', 'unregistered_athlete_id'])),
    nombresPorId('unregistered_athletes', ids('unregistered_athlete_id', ['child_id'])),
  ]);
  return { cobros: mensualidades, nombres: [...hijos, ...adultos, ...fichas] };
}

const COLOR_PUNTUALIDAD: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  aviso: 'text-orange-700 dark:text-orange-300',
  peligro: 'text-destructive',
};

export interface PagosDelMesCardProps {
  schoolId: string | null | undefined;
  activeBranchId: string | null | undefined;
  year: number;
  month: number;
  /** «Octubre», «Noviembre»… */
  mesLabel: string;
  onAthleteClick: (a: ObjetivoEstadoCuenta) => void;
}

export function PagosDelMesCard({ schoolId, activeBranchId, year, month, mesLabel, onAthleteClick }: PagosDelMesCardProps) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['pagos-del-mes', schoolId, activeBranchId, year, month],
    queryFn: () => leerPagosDelMes(schoolId as string, activeBranchId, year, month),
    enabled: !!schoolId,
  });
  const [filtro, setFiltro] = useState<Filtro | null>(null);
  const [verTodos, setVerTodos] = useState(false);
  const ahora = useMemo(() => new Date(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const filas = useMemo(() => (data ? filasDelMes(data.cobros, new Map(data.nombres), ahora) : []), [data, ahora]);
  const resumen = useMemo(() => resumenPagos(filas), [filas]);
  const cuenta = (g: Filtro) => filas.filter((f) => f.grupo === g).length;
  const visibles = filtro ? filas.filter((f) => f.grupo === filtro) : filas;
  const recortadas = verTodos ? visibles : visibles.slice(0, FILAS_VISIBLES);

  const frase = (() => {
    if (!data || resumen.total === 0) return null;
    const partes = [`${resumen.pagaron} de ${resumen.total} ya pagaron`];
    if (resumen.vencidos) partes.push(`${resumen.vencidos} ${resumen.vencidos === 1 ? 'vencido' : 'vencidos'}`);
    if (resumen.enRevision) partes.push(`${resumen.enRevision} en revisión`);
    if (resumen.abonos) partes.push(`${resumen.abonos} con abono`);
    return partes.join(' · ');
  })();

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="text-base">¿Quién pagó en {mesLabel}?</CardTitle>
          <CardDescription>{frase ?? 'Cobros de mensualidad del período, con fecha límite, fecha de pago y puntualidad.'}</CardDescription>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link to="/payments-automation?tab=history">Ver en Historial</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatFilterBar<Filtro>
          columns={5}
          value={filtro}
          onChange={(v) => { setFiltro(v); setVerTodos(false); }}
          items={[
            { key: null, label: 'Todos', value: filas.length, tone: 'neutral' },
            { key: 'vencido', label: 'Vencidos', value: cuenta('vencido'), tone: 'rose' },
            { key: 'revision', label: 'En revisión', value: cuenta('revision'), tone: 'blue' },
            { key: 'abono', label: 'Abonos', value: cuenta('abono'), tone: 'orange' },
            { key: 'pago', label: 'Pagaron', value: cuenta('pago'), tone: 'emerald' },
            { key: 'pendiente', label: 'Por pagar', value: cuenta('pendiente'), tone: 'yellow', hidden: cuenta('pendiente') === 0 },
          ]}
        />

        {isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Cargando los pagos de {mesLabel}…</p>}
        {isError && (
          <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
            <p className="font-semibold text-destructive">No pudimos cargar los pagos de {mesLabel}.</p>
            <p className="text-muted-foreground">Esto no quiere decir que todos estén al día.</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>Reintentar</Button>
          </div>
        )}
        {!isLoading && !isError && visibles.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {filtro ? 'Nadie cae en este filtro.' : `No hay cobros de mensualidad de ${mesLabel} todavía.`}
          </p>
        )}

        {recortadas.length > 0 && (
          <ul className="overflow-hidden rounded-xl border">
            {recortadas.map((f, i) => {
              const punt = puntualidad(f.cobro, ahora, formatCurrency);
              return (
                <li key={f.clave} className={cn(i > 0 && 'border-t')}>
                  <button
                    type="button"
                    onClick={() => onAthleteClick(f.objetivo)}
                    className="flex min-h-touch w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold">
                        {f.nombre}
                        {f.otros > 0 && <span className="font-normal text-muted-foreground"> · +{f.otros} {f.otros === 1 ? 'cobro' : 'cobros'}</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">{lineaFechas(f.cobro, ahora)}</span>
                      {punt && <span className={cn('text-xs font-semibold', COLOR_PUNTUALIDAD[punt.tono])}>{punt.label}</span>}
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <span className="whitespace-nowrap text-sm font-bold">{formatCurrency(valorFila(f))}</span>
                      <ChipEstado {...f.estado} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!verTodos && visibles.length > FILAS_VISIBLES && (
          <Button variant="link" className="h-auto w-full text-sm font-semibold" onClick={() => setVerTodos(true)}>
            Mostrar los {visibles.length} atletas
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
