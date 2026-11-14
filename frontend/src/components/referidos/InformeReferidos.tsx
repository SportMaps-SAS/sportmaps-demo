/**
 * Informe «Referidos»: quién refirió a quién, porcentaje, mes y estado, con
 * el total «dejado de cobrar». Va junto a la configuración de la campaña y
 * solo se pinta si la escuela tiene campaña.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { todayColombia } from '@/lib/dateUtils';
import {
  ESTADO_REFERIDO_LABEL, fmtCOP, fmtPct, mensajeErrorReferido, mesDelDescuento, nombreReferente, referidosApi,
  type EstadoReferido,
} from '@/lib/api/referidos';
import { EstadoReferidoBadge } from './ReferidoFicha';
import { useCampanaReferidosActiva } from './ReferidoAlta';

export function InformeReferidos({ schoolId }: { schoolId: string }) {
  const { data: campana } = useCampanaReferidosActiva(schoolId);
  const [mes, setMes] = useState(todayColombia().slice(0, 7)); // AAAA-MM
  const [todos, setTodos] = useState(false);
  const [y, m] = mes.split('-').map(Number);

  const q = useQuery({
    queryKey: ['referidos-informe', schoolId, todos ? 'todos' : mes],
    queryFn: () => (todos ? referidosApi.informe(schoolId) : referidosApi.informe(schoolId, y, m)),
    enabled: !!schoolId && !!campana?.campaign,
    retry: false,
  });

  if (!campana?.campaign) return null;

  const rows = q.data?.rows ?? [];
  const t = q.data?.totals;
  const estados = Object.entries(t?.por_estado ?? {}) as Array<[EstadoReferido, number]>;

  return (
    <Card data-testid="informe-referidos">
      <CardHeader className="space-y-3">
        <CardTitle className="text-base">Informe de referidos</CardTitle>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="ref-informe-mes" className="text-xs text-muted-foreground block">Mes del descuento</label>
            <Input id="ref-informe-mes" type="month" value={mes} disabled={todos}
              onChange={(e) => e.target.value && setMes(e.target.value)} className="w-44" />
          </div>
          <Button type="button" size="sm" variant={todos ? 'default' : 'outline'} aria-pressed={todos} onClick={() => setTodos((v) => !v)}>
            Ver todos los meses
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando informe…</p>
        ) : q.isError ? (
          <p role="alert" className="text-sm text-destructive">{mensajeErrorReferido(q.error)}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Referidos</p>
                <p className="text-xl font-semibold">{t?.total ?? 0}</p>
                {estados.length > 0 && (
                  <p className="text-xs text-muted-foreground">{estados.map(([e, n]) => `${n} ${ESTADO_REFERIDO_LABEL[e]?.toLowerCase() ?? e}`).join(' · ')}</p>
                )}
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Dejado de cobrar</p>
                <p className="text-xl font-semibold" data-testid="dejado-de-cobrar">{fmtCOP(t?.dejado_de_cobrar)}</p>
                <p className="text-xs text-muted-foreground">Descuentos ya aplicados</p>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {todos ? 'Todavía no hay referidos registrados.' : 'No hay referidos con descuento en ese mes.'}
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((r) => (
                  <li key={r.id} className="rounded-lg border p-3 space-y-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-sm min-w-0 break-words">
                        <strong>{nombreReferente(r)}</strong> refirió a <strong>{r.referred_name || 'un deportista'}</strong>
                      </p>
                      <EstadoReferidoBadge estado={r.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {fmtPct(r.pct)}
                      {mesDelDescuento(r.apply_year, r.apply_month) ? ` · ${mesDelDescuento(r.apply_year, r.apply_month)}` : ''}
                      {r.status === 'aplicado' && r.discount_amount ? ` · dejó de cobrarse ${fmtCOP(r.discount_amount)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {(q.data?.by_month?.length ?? 0) > 0 && (
              <div>
                <p className="text-sm font-medium mb-1">Por mes</p>
                <ul className="text-sm space-y-1">
                  {q.data!.by_month.map((b) => (
                    <li key={`${b.year}-${b.month}`} className="flex justify-between gap-2">
                      <span>{mesDelDescuento(b.year, b.month)}</span>
                      <span className="text-muted-foreground">{b.aplicados} aplicados · {fmtCOP(b.dejado_de_cobrar)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
