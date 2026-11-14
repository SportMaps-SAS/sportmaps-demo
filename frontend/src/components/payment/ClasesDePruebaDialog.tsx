import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Banknote, CheckCircle2, FileText, Loader2, MessageCircle, Search, Store } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import {
  METODOS_PAGO_CLASE_PRUEBA, useCobrosClasePrueba,
  type CobroClasePrueba, type MetodoPagoClasePrueba,
} from '@/hooks/useCobrosClasePrueba';

const CANAL: Record<string, { label: string; icon: typeof Store }> = {
  presencial: { label: 'En la escuela', icon: Store },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  formulario: { label: 'Formulario', icon: FileText },
};

const ERRORES: Record<string, string> = {
  CLASE_PRUEBA_YA_PAGADA: 'Esta clase de prueba ya tiene un pago registrado.',
  PROSPECTO_DESCARTADO: 'El prospecto fue descartado.',
  MONTO_INVALIDO: 'El valor debe ser mayor que cero.',
  METODO_INVALIDO: 'Elige cómo pagó.',
  Forbidden: 'Solo el dueño o un administrador de la escuela puede registrar este pago.',
};

const pesos = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

function fechaCorta(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schoolId: string | null | undefined;
  /** Para refrescar el historial de pagos de la página. */
  onPagado?: () => void;
}

/**
 * Gestión de Pagos → «Clases de prueba»: los prospectos de Deportistas →
 * «Clase de prueba» con el estado de su pago, y el registro del pago en sede
 * (mig. 20261029215003). Solo dueño y administradores.
 */
export function ClasesDePruebaDialog({ open, onOpenChange, schoolId, onPagado }: Props) {
  const { toast } = useToast();
  const { valor, prospectos, isLoading, error, registrar } = useCobrosClasePrueba(schoolId, open);
  const [busqueda, setBusqueda] = useState('');
  const [cobrando, setCobrando] = useState<null | { leadId: string; monto: string; metodo: MetodoPagoClasePrueba; referencia: string }>(null);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return prospectos;
    return prospectos.filter((p) =>
      [p.full_name, p.guardian_name, p.phone].some((v) => (v ?? '').toLowerCase().includes(q)));
  }, [prospectos, busqueda]);

  const pendientes = prospectos.filter((p) => !p.pago).length;

  const abrirCobro = (p: CobroClasePrueba) =>
    setCobrando({ leadId: p.id, monto: valor ? String(valor) : '', metodo: 'cash', referencia: '' });

  const guardar = (p: CobroClasePrueba) => {
    if (!cobrando) return;
    const monto = Number(cobrando.monto);
    if (!monto || monto <= 0) return;
    registrar.mutate({ leadId: p.id, monto, metodo: cobrando.metodo, referencia: cobrando.referencia }, {
      onSuccess: () => {
        toast({ title: 'Pago registrado', description: `${p.full_name} · ${pesos(monto)}` });
        setCobrando(null);
        onPagado?.();
      },
      onError: (e: Error) => {
        const clave = Object.keys(ERRORES).find((k) => e.message.includes(k));
        toast({ title: 'No se pudo registrar el pago', description: clave ? ERRORES[clave] : e.message, variant: 'destructive' });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setCobrando(null); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Clases de prueba</DialogTitle>
          <DialogDescription>
            Quienes tomaron o pidieron clase de prueba. El pago entra como ingreso y, al completar el alta, pasa al
            estado de cuenta del deportista.
            {valor
              ? <> Valor de la clase: <strong>{pesos(valor)}</strong>.</>
              : <> Sin valor configurado: ponlo en Deportistas → Clase de prueba → Configurar, o escríbelo al cobrar.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input placeholder="Buscar por nombre, acudiente o teléfono..." value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)} className="pl-10" />
        </div>

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : error ? (
            <p className="text-sm text-destructive py-6 text-center">No se pudo cargar la lista: {error.message}</p>
          ) : filtrados.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">
              {busqueda ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay clases de prueba.'}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {filtrados.map((p) => {
                const canal = CANAL[p.canal] ?? CANAL.formulario;
                const Icono = canal.icon;
                const abierto = cobrando?.leadId === p.id;
                const metodo = METODOS_PAGO_CLASE_PRUEBA.find((m) => m.value === p.pago?.metodo)?.label ?? 'Otro';
                return (
                  <li key={p.id} className="py-3 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{p.full_name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {p.guardian_name ? `${p.guardian_name} · ` : ''}{p.phone}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          <Badge variant="secondary" className="text-[10px] gap-1"><Icono className="h-3 w-3" />{canal.label}</Badge>
                          {p.fecha_clase && <Badge variant="outline" className="text-[10px]">Clase {fechaCorta(p.fecha_clase)}</Badge>}
                          {p.asistencia === 'asistio' && <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600">Asistió</Badge>}
                          {p.asistencia === 'no_vino' && <Badge variant="outline" className="text-[10px]">No vino</Badge>}
                          {p.status === 'converted' && <Badge variant="outline" className="text-[10px]">Ya es deportista</Badge>}
                        </div>
                      </div>
                      <div className="shrink-0">
                        {p.pago ? (
                          <Badge variant="outline" className="gap-1 text-xs text-emerald-700 border-emerald-300 dark:text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Pagó {pesos(p.pago.monto)} · {metodo}{p.pago.fecha ? ` · ${fechaCorta(p.pago.fecha)}` : ''}
                          </Badge>
                        ) : !abierto && (
                          <Button size="sm" onClick={() => abrirCobro(p)}>
                            <Banknote className="h-4 w-4 mr-1.5" /> Registrar pago
                          </Button>
                        )}
                      </div>
                    </div>

                    {abierto && cobrando && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-border/50 bg-muted/30 p-3">
                        <div className="space-y-1.5">
                          <Label htmlFor={`monto-${p.id}`} className="text-xs font-semibold">Valor</Label>
                          <Input
                            id={`monto-${p.id}`}
                            inputMode="numeric"
                            placeholder="$0"
                            value={cobrando.monto ? `$${Number(cobrando.monto).toLocaleString('es-CO')}` : ''}
                            onChange={(e) => setCobrando({ ...cobrando, monto: e.target.value.replace(/\D/g, '') })}
                            className="h-9"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-semibold">Cómo pagó</Label>
                          <Select value={cobrando.metodo} onValueChange={(v) => setCobrando({ ...cobrando, metodo: v as MetodoPagoClasePrueba })}>
                            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {METODOS_PAGO_CLASE_PRUEBA.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor={`ref-${p.id}`} className="text-xs font-semibold">Referencia (opcional)</Label>
                          <Input id={`ref-${p.id}`} value={cobrando.referencia} maxLength={120}
                            onChange={(e) => setCobrando({ ...cobrando, referencia: e.target.value })} className="h-9" />
                        </div>
                        <div className="sm:col-span-3 flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setCobrando(null)} disabled={registrar.isPending}>Cancelar</Button>
                          <Button size="sm" onClick={() => guardar(p)} disabled={registrar.isPending || !Number(cobrando.monto)}>
                            {registrar.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                            Guardar pago{Number(cobrando.monto) ? ` de ${pesos(Number(cobrando.monto))}` : ''}
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {!isLoading && prospectos.length > 0 && (
          <p className="text-xs text-muted-foreground border-t border-border/50 pt-3">
            {pendientes === 0 ? 'Todas las clases de prueba de la lista están pagadas.' : `${pendientes} sin pago registrado.`}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
