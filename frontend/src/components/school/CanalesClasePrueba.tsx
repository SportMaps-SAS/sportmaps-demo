import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Banknote, Loader2, MessageCircle, Plus, Store, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useConfigClasePrueba, useCuposClasePrueba, type ConfigClasePrueba } from '@/hooks/useClasePrueba';
import { useValorClasePrueba } from '@/hooks/useCobrosClasePrueba';
import { AjustesAgendaClasePrueba } from '@/components/school/AjustesAgendaClasePrueba';

/**
 * Interruptor general + canales de la clase de prueba (configuración única,
 * mig. 20261026155701). El link público y las categorías siguen debajo, en
 * TrialClassSettingsModal.
 */
export function CanalesClasePrueba({ schoolId }: { schoolId: string | null | undefined }) {
  const { toast } = useToast();
  const { config, isLoading, guardar } = useConfigClasePrueba(schoolId);
  const whatsappVisible = !!config?.enabled && !!config?.whatsapp_enabled;
  const { cupos, crear, cerrar } = useCuposClasePrueba(schoolId, whatsappVisible);
  // Valor de la clase: lo cobra Gestión de Pagos → «Clases de prueba» (solo admin).
  const { valor, guardar: guardarValor } = useValorClasePrueba(schoolId, !!config?.es_admin);

  const [indicaciones, setIndicaciones] = useState('');
  const [valorTexto, setValorTexto] = useState('');
  const [nuevoCupo, setNuevoCupo] = useState<null | { label: string; fecha: string; inicio: string; fin: string; lugar: string; capacidad: string }>(null);

  useEffect(() => { setIndicaciones(config?.indicaciones ?? ''); }, [config?.indicaciones]);
  useEffect(() => { setValorTexto(valor ? String(valor) : ''); }, [valor]);

  const guardarValorClase = () =>
    guardarValor.mutate(valorTexto ? Number(valorTexto) : null, {
      onSuccess: () => toast({ title: 'Valor de la clase de prueba guardado' }),
      onError: (e: Error) => toast({ title: 'No se pudo guardar el valor', description: e.message, variant: 'destructive' }),
    });

  const cambiar = (cambios: Partial<ConfigClasePrueba>) =>
    guardar.mutate(cambios, {
      onError: (e: any) => toast({ title: 'No se pudo guardar', description: e.message, variant: 'destructive' }),
    });

  const guardarCupo = () => {
    if (!nuevoCupo || !nuevoCupo.label.trim() || !nuevoCupo.fecha || !nuevoCupo.inicio) return;
    crear.mutate({
      label: nuevoCupo.label.trim(),
      fecha: nuevoCupo.fecha,
      inicio: nuevoCupo.inicio,
      fin: nuevoCupo.fin || null,
      lugar: nuevoCupo.lugar.trim() || null,
      capacidad: Math.max(1, Number(nuevoCupo.capacidad) || 1),
    }, {
      onSuccess: () => setNuevoCupo(null),
      onError: (e: any) => toast({ title: 'No se pudo crear el cupo', description: e.message, variant: 'destructive' }),
    });
  };

  if (isLoading || !config) {
    return <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const cuposAbiertos = cupos.filter((c) => c.is_open && c.slot_date >= hoy);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/30 p-4">
        <div>
          <p className="font-semibold text-sm">Recibir clases de prueba</p>
          <p className="text-xs text-muted-foreground mt-0.5">Apagado, no entran por ningún canal.</p>
        </div>
        <Switch checked={config.enabled} onCheckedChange={(v) => cambiar({ enabled: v })} disabled={guardar.isPending} />
      </div>

      {config.enabled && (
        <>
          {config.es_admin && (
            <div className="space-y-2 rounded-xl border border-border/50 bg-muted/20 p-4">
              <div className="flex items-center gap-2">
                <Banknote className="h-4 w-4 text-primary" />
                <div>
                  <p className="font-semibold text-sm">Valor de la clase de prueba</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Se cobra en Gestión de Pagos → Clases de prueba; ahí sale precargado y se puede cambiar. Vacío = sin costo fijo.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  inputMode="numeric"
                  placeholder="Sin valor"
                  value={valorTexto ? `$${Number(valorTexto).toLocaleString('es-CO')}` : ''}
                  onChange={(e) => setValorTexto(e.target.value.replace(/\D/g, ''))}
                  className="h-8 text-xs bg-background max-w-44"
                />
                {valorTexto !== (valor ? String(valor) : '') && (
                  <Button size="sm" className="h-8 text-xs" onClick={guardarValorClase} disabled={guardarValor.isPending}>
                    {guardarValor.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Guardar valor
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <Store className="h-4 w-4 text-primary" />
              <div>
                <p className="font-semibold text-sm">En la escuela</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Admin o coach anota acudiente, teléfono y nombres desde Deportistas → Clase de prueba.
                </p>
              </div>
            </div>
            <Switch checked={config.presencial_enabled} onCheckedChange={(v) => cambiar({ presencial_enabled: v })} disabled={guardar.isPending} />
          </div>

          <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-primary" />
                <div>
                  <p className="font-semibold text-sm">WhatsApp</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    El bot ofrece los cupos. Apagado, igual guarda los datos de quien escribe.
                  </p>
                </div>
              </div>
              <Switch checked={config.whatsapp_enabled} onCheckedChange={(v) => cambiar({ whatsapp_enabled: v })} disabled={guardar.isPending} />
            </div>

            {config.whatsapp_enabled && (
              <div className="space-y-4 border-t border-border/40 pt-3">
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span>
                    <strong>Cupos desde los horarios de los grupos</strong>
                    <span className="block text-muted-foreground">La persona se suma a un entrenamiento real. Necesita grupos con horario.</span>
                  </span>
                  <Switch
                    checked={config.cupos_desde_entrenamientos}
                    onCheckedChange={(v) => cambiar({ cupos_desde_entrenamientos: v })}
                    disabled={guardar.isPending}
                  />
                </label>

                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Qué llevar / a quién buscar</Label>
                  <Textarea
                    value={indicaciones}
                    onChange={(e) => setIndicaciones(e.target.value)}
                    placeholder="Ropa cómoda, hidratación. Preguntar por la coach en recepción."
                    className="min-h-[60px] text-xs bg-background"
                  />
                  {indicaciones !== (config.indicaciones ?? '') && (
                    <Button size="sm" className="h-7 text-xs" onClick={() => cambiar({ indicaciones })} disabled={guardar.isPending}>
                      Guardar indicaciones
                    </Button>
                  )}
                </div>

                {config.es_admin && <AjustesAgendaClasePrueba schoolId={schoolId} />}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold">Cupos cargados a mano ({cuposAbiertos.length})</Label>
                    {!nuevoCupo && config.es_admin && (
                      <Button
                        size="sm" variant="outline" className="h-7 text-xs"
                        onClick={() => setNuevoCupo({ label: '', fecha: '', inicio: '', fin: '', lugar: '', capacidad: '5' })}
                      >
                        <Plus className="h-3 w-3 mr-1" /> Cupo
                      </Button>
                    )}
                  </div>

                  {nuevoCupo && (
                    <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/50 bg-background p-3">
                      <Input className="col-span-2 h-8 text-xs" placeholder="Grupo (ej. Gimnasia inicial)" value={nuevoCupo.label}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, label: e.target.value })} />
                      <Input type="date" min={hoy} className="h-8 text-xs" value={nuevoCupo.fecha}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, fecha: e.target.value })} />
                      <Input type="number" min={1} className="h-8 text-xs" placeholder="Cupos" value={nuevoCupo.capacidad}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, capacidad: e.target.value })} />
                      <Input type="time" className="h-8 text-xs" value={nuevoCupo.inicio}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, inicio: e.target.value })} />
                      <Input type="time" className="h-8 text-xs" value={nuevoCupo.fin}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, fin: e.target.value })} />
                      <Input className="col-span-2 h-8 text-xs" placeholder="Sede (opcional)" value={nuevoCupo.lugar}
                        onChange={(e) => setNuevoCupo({ ...nuevoCupo, lugar: e.target.value })} />
                      <div className="col-span-2 flex justify-end gap-2">
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setNuevoCupo(null)}>Cancelar</Button>
                        <Button size="sm" className="h-7 text-xs" onClick={guardarCupo}
                          disabled={crear.isPending || !nuevoCupo.label.trim() || !nuevoCupo.fecha || !nuevoCupo.inicio}>
                          {crear.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />} Guardar cupo
                        </Button>
                      </div>
                    </div>
                  )}

                  {cuposAbiertos.length === 0 && !nuevoCupo ? (
                    <p className="text-[11px] text-muted-foreground">
                      {config.cupos_desde_entrenamientos
                        ? 'Sin cupos a mano: el bot usa los horarios de los grupos.'
                        : 'Sin cupos: el bot solo puede guardar los datos y avisarte.'}
                    </p>
                  ) : (
                    <ul className="space-y-1 max-h-40 overflow-y-auto">
                      {cuposAbiertos.slice(0, 30).map((c) => (
                        <li key={c.id} className="flex items-center justify-between rounded-md bg-background px-2 py-1.5 text-xs">
                          <span>
                            <strong>{c.label}</strong> · {c.slot_date} {c.start_time?.slice(0, 5)}
                            <span className="text-muted-foreground"> · {c.reserved_count}/{c.max_capacity > 900 ? '∞' : c.max_capacity}</span>
                          </span>
                          {config.es_admin && (
                            <button type="button" aria-label="Cerrar cupo" className="text-muted-foreground hover:text-destructive"
                              onClick={() => cerrar.mutate(c.id)} disabled={cerrar.isPending}>
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
