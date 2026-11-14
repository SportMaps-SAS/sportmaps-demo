/**
 * «Cobros abiertos» de un atleta (lado admin): anular meses en que no vino y
 * llevar al valor nuevo los cobros que quedaron con el precio anterior.
 * Spec: docs/specs/cambio-plan-y-cobros-abiertos.md
 *
 * Se abre de dos formas: sola, después de guardar un cambio de plan o de cuota
 * (origen 'cambio_plan', propone el valor nuevo), o desde el menú del atleta
 * («No asistió / cobros abiertos»). Todo se aplica en una sola transacción
 * (`resolver_cobros_abiertos`) y la familia recibe un único aviso.
 *
 * La columna de asistencia es ayuda, no criterio: nada viene preseleccionado
 * para anular, y en escuelas que no toman lista ni aparece.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getUserFriendlyError } from '@/lib/error-translator';
import { cn, formatCurrency } from '@/lib/utils';
import {
  ESTADO_LABEL, ayudaAsistencia, decisionesIniciales, decisionesParaEnviar, erroresDeDecisiones,
  fetchCobrosAbiertos, mesLegible, resolverCobrosAbiertos,
  type AccionCobro, type DecisionCobro, type OrigenVentana,
} from '@/lib/cobrosAbiertos';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enrollmentId: string | null;
  athleteName: string;
  origen: OrigenVentana;
}

const ACCIONES: { value: AccionCobro; label: string }[] = [
  { value: 'dejar', label: 'Dejar igual' },
  { value: 'valor', label: 'Valor nuevo' },
  { value: 'anular', label: 'Anular: no asistió' },
];

export default function ResolverCobrosAbiertosDialog({ open, onOpenChange, enrollmentId, athleteName, origen }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [decisiones, setDecisiones] = useState<Record<string, DecisionCobro>>({});
  const [motivo, setMotivo] = useState('');

  const resumen = useQuery({
    queryKey: ['cobros-abiertos', enrollmentId],
    enabled: open && !!enrollmentId,
    queryFn: () => fetchCobrosAbiertos(enrollmentId!),
    staleTime: 0,
  });

  // Cada vez que llegan datos frescos se arranca de las decisiones por defecto.
  useEffect(() => {
    if (resumen.data) setDecisiones(decisionesIniciales(resumen.data, origen));
  }, [resumen.data, origen]);
  useEffect(() => {
    if (!open) { setMotivo(''); setDecisiones({}); }
  }, [open]);

  const cobros = useMemo(() => resumen.data?.cobros ?? [], [resumen.data]);
  const errores = erroresDeDecisiones(cobros, decisiones, motivo);
  const envio = decisionesParaEnviar(cobros, decisiones);
  const hayAnulacion = envio.some((d) => d.accion === 'anular');
  const tomaLista = !!resumen.data?.escuela_toma_lista;

  const aplicar = useMutation({
    mutationFn: () => resolverCobrosAbiertos(enrollmentId!, envio, motivo),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['school-students'] });
      queryClient.invalidateQueries({ queryKey: ['cobros-abiertos'] });
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      toast({
        title: '✅ Cobros actualizados',
        description: [
          r.anulados ? `${r.anulados} mes(es) anulado(s)` : null,
          r.ajustados ? `${r.ajustados} cobro(s) con valor nuevo` : null,
        ].filter(Boolean).join(' · ') + '. La familia recibió el aviso.',
      });
      onOpenChange(false);
    },
    onError: (e: any) => {
      toast({ title: 'No se pudieron actualizar los cobros', description: getUserFriendlyError(e), variant: 'destructive' });
      // Otro admin pudo moverlos: se recarga para mostrar el estado real.
      resumen.refetch();
    },
  });

  const set = (id: string, patch: Partial<DecisionCobro>) =>
    setDecisiones((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cobros abiertos de {athleteName}</DialogTitle>
          <DialogDescription>
            {origen === 'cambio_plan'
              ? 'Cambiaste el plan o la cuota. Decide qué pasa con los cobros que siguen abiertos con el valor anterior.'
              : 'Si no vino uno o más meses, anúlalos aquí. Lo pagado o con abonos no se puede anular.'}
            {resumen.data && resumen.data.cuota_vigente > 0 && (
              <> Cuota vigente: <strong>{formatCurrency(resumen.data.cuota_vigente)}</strong>.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!enrollmentId ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>Este atleta no tiene una inscripción activa.</AlertDescription>
          </Alert>
        ) : resumen.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando cobros…
          </p>
        ) : resumen.isError ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{getUserFriendlyError(resumen.error)}</AlertDescription>
          </Alert>
        ) : cobros.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm">
            No tiene mensualidades abiertas. Nada que resolver.
          </p>
        ) : (
          <div className="space-y-3">
            {cobros.map((c) => {
              const d = decisiones[c.payment_id] ?? { accion: 'dejar', monto: c.amount };
              const ayuda = ayudaAsistencia(c, tomaLista);
              return (
                <div key={c.payment_id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{mesLegible(c)}</p>
                      <p className="text-xs text-muted-foreground">
                        {ESTADO_LABEL[c.status]} · {formatCurrency(c.amount)}
                        {c.amount_paid > 0 && ` · abonado ${formatCurrency(c.amount_paid)}`}
                        {c.late_fee_amount > 0 && ` · incluye mora ${formatCurrency(c.late_fee_amount)}`}
                      </p>
                      {c.tiene_comprobante && (
                        <p className="text-xs text-blue-700 dark:text-blue-400">
                          Tiene comprobante{c.ocr_amount != null ? ` por ${formatCurrency(c.ocr_amount)}` : ''}: no se anula, solo se puede ajustar el valor.
                        </p>
                      )}
                    </div>
                    {ayuda && (
                      <span className={cn(
                        'whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium',
                        ayuda.tono === 'alerta' && 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
                        ayuda.tono === 'normal' && 'bg-muted text-foreground',
                        ayuda.tono === 'sin_dato' && 'bg-muted text-muted-foreground',
                      )}>
                        {ayuda.texto}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={`Qué hacer con ${mesLegible(c)}`}>
                    {ACCIONES.map((a) => {
                      const deshabilitada = a.value === 'anular' && !c.puede_anular;
                      return (
                        <Button
                          key={a.value}
                          type="button"
                          size="sm"
                          role="radio"
                          aria-checked={d.accion === a.value}
                          variant={d.accion === a.value ? (a.value === 'anular' ? 'destructive' : 'default') : 'outline'}
                          disabled={deshabilitada}
                          title={deshabilitada ? 'Solo se anulan cobros pendientes o atrasados, sin abonos, de este mes o anteriores.' : undefined}
                          onClick={() => set(c.payment_id, { accion: a.value })}
                        >
                          {a.label}
                        </Button>
                      );
                    })}
                    {d.accion === 'valor' && (
                      <div className="flex items-center gap-1">
                        <Label htmlFor={`monto-${c.payment_id}`} className="sr-only">Valor nuevo</Label>
                        <Input
                          id={`monto-${c.payment_id}`}
                          type="number"
                          inputMode="numeric"
                          min={1}
                          className="h-9 w-36"
                          value={d.monto ?? ''}
                          onChange={(e) => set(c.payment_id, { monto: e.target.value === '' ? null : Number(e.target.value) })}
                        />
                        {c.monto_sugerido != null && d.monto !== c.monto_sugerido && (
                          <Button type="button" variant="link" size="sm" className="h-auto p-0"
                            onClick={() => set(c.payment_id, { monto: c.monto_sugerido })}>
                            Usar {formatCurrency(c.monto_sugerido)}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Motivo {hayAnulacion ? '(obligatorio para anular)' : '(opcional)'}
              </Label>
              <Textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value.slice(0, 500))}
                placeholder="Ej: la mamá avisó que estuvo fuera de la ciudad en septiembre"
                rows={2}
              />
              <p className="text-xs text-muted-foreground">La familia ve este motivo en el aviso.</p>
            </div>

            {errores.length > 0 && envio.length > 0 && (
              <ul className="text-xs text-destructive list-disc pl-4">
                {errores.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {envio.length ? 'Cancelar' : 'Cerrar'}
          </Button>
          <Button
            disabled={!enrollmentId || envio.length === 0 || errores.length > 0 || aplicar.isPending}
            onClick={() => aplicar.mutate()}
          >
            {aplicar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Aplicar {envio.length > 0 ? `(${envio.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
