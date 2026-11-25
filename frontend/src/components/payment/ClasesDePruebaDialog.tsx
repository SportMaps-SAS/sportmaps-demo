import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Banknote, CalendarDays, CheckCircle2, Eye, FileText, Loader2, MessageCircle, Plus, Search, Settings, Store, UserCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeReceiptUrl } from '@/lib/normalizeReceiptUrl';
import { useConfigClasePrueba, useProspectosClasePrueba } from '@/hooks/useClasePrueba';
import { RegistroRapidoDialog } from '@/components/students/ClasePruebaPanel';
import { TrialClassSettingsModal } from '@/components/school/TrialClassSettingsModal';
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

type Filtro = 'todos' | 'sin_pagar' | 'pagaron' | 'sin_agendar';
const FILTROS: { id: Filtro; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'sin_pagar', label: 'Sin pagar' },
  { id: 'pagaron', label: 'Pagaron' },
  { id: 'sin_agendar', label: 'Sin agendar' },
];

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
  const [filtro, setFiltro] = useState<Filtro>('todos');
  const [registroAbierto, setRegistroAbierto] = useState(false);
  const [configAbierta, setConfigAbierta] = useState(false);
  const navigate = useNavigate();
  const { config } = useConfigClasePrueba(open ? schoolId : null);
  const { prospectos: detalle, registrar: registrarRapido } = useProspectosClasePrueba(open ? schoolId : null);
  // Hora, grupo, sede, profe y asistencia viven en `listar_clase_prueba`; el pago, en `listar_cobros_clase_prueba`.
  // Se juntan por el id del prospecto para que este modal lo tenga todo en una fila.
  const detallePorLead = useMemo(() => new Map(detalle.map((d) => [d.id, d])), [detalle]);
  const pagoIds = useMemo(() => prospectos.map((p) => p.pago?.id).filter((x): x is string => !!x), [prospectos]);
  const { data: comprobantes } = useQuery({
    queryKey: ['clase-prueba-comprobantes', schoolId, pagoIds.join(',')],
    enabled: open && !!schoolId && pagoIds.length > 0,
    queryFn: async () => {
      const { data, error: e } = await supabase.from('payments').select('id, receipt_url, payment_date, created_at').in('id', pagoIds);
      if (e) throw new Error(e.message);
      return new Map(((data ?? []) as { id: string; receipt_url: string | null; payment_date: string | null; created_at: string }[]).map((r) => [r.id, r]));
    },
  });
  const puedeRegistrar = !!config?.enabled && !!config?.presencial_enabled;

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return prospectos.filter((p) => {
      if (filtro === 'sin_pagar' && p.pago) return false;
      if (filtro === 'pagaron' && !p.pago) return false;
      if (filtro === 'sin_agendar' && (p.fecha_clase || detallePorLead.get(p.id)?.fecha_clase)) return false;
      return !q || [p.full_name, p.guardian_name, p.phone].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [prospectos, busqueda, filtro, detallePorLead]);

  const verComprobante = async (pagoId: string) => {
    const ruta = comprobantes?.get(pagoId)?.receipt_url;
    if (!ruta) return;
    if (ruta.startsWith('http')) { window.open(ruta, '_blank', 'noopener'); return; }
    const { data, error: e } = await supabase.storage.from('payment-receipts').createSignedUrl(normalizeReceiptUrl(ruta), 300);
    if (e || !data?.signedUrl) {
      toast({ title: 'Error de acceso', description: 'No se pudo abrir el comprobante.', variant: 'destructive' });
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener');
  };

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
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!o) setCobrando(null); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Clases de prueba</DialogTitle>
          <DialogDescription>
            Quienes tomaron o pidieron clase de prueba. El pago entra como ingreso y, al completar el alta, pasa al
            estado de cuenta del deportista.
            {valor
              ? <> Valor de la clase: <strong>{pesos(valor)}</strong>.</>
              : <> Sin valor configurado: ponlo en «Configurar», o escríbelo al cobrar.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => setRegistroAbierto(true)} disabled={!puedeRegistrar}
            title={puedeRegistrar ? undefined : 'El registro en la escuela está apagado en la configuración'}>
            <Plus className="h-4 w-4 mr-1.5" /> Registrar clase de prueba
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfigAbierta(true)}>
            <Settings className="h-4 w-4 mr-1.5" /> Configurar
          </Button>
          <div className="flex flex-wrap gap-1.5 sm:ml-auto" role="group" aria-label="Filtrar">
            {FILTROS.map((f) => (
              <Button key={f.id} size="sm" variant={filtro === f.id ? 'default' : 'outline'} className="h-8 text-xs"
                aria-pressed={filtro === f.id} onClick={() => setFiltro(f.id)}>{f.label}</Button>
            ))}
          </div>
        </div>

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
                const d = detallePorLead.get(p.id);
                const fechaClase = p.fecha_clase ?? d?.fecha_clase ?? null;
                const grupo = d?.cupo_label ?? d?.grupo ?? null;
                const pagoExtra = p.pago ? comprobantes?.get(p.pago.id) : null;
                const comprobante = pagoExtra?.receipt_url ?? null;
                // Fecha del pago: la que quedó en el pago; si no trae, el día en que se registró.
                const fechaPago = p.pago?.fecha ?? pagoExtra?.payment_date ?? pagoExtra?.created_at ?? null;
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
                          {fechaClase
                            ? (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <CalendarDays className="h-3 w-3" />
                                Clase {fechaCorta(fechaClase)}{d?.cupo_hora ? ` ${d.cupo_hora.slice(0, 5)}` : ''}{grupo ? ` · ${grupo}` : ''}
                              </Badge>
                            )
                            : <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 dark:text-amber-400">Sin agendar</Badge>}
                          <Badge variant="outline" className="text-[10px]" title="Día en que entró a la lista de clase de prueba">
                            Se registró {fechaCorta(p.created_at)}
                          </Badge>
                          {d?.sede && <Badge variant="outline" className="text-[10px]">{d.sede}</Badge>}
                          {p.asistencia === 'asistio' && <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600">Asistió</Badge>}
                          {p.asistencia === 'no_vino' && <Badge variant="outline" className="text-[10px]">No vino</Badge>}
                          {p.status === 'converted' && <Badge variant="outline" className="text-[10px]">Ya es deportista</Badge>}
                        </div>
                      </div>
                      <div className="shrink-0 flex flex-wrap items-center gap-1.5">
                        {p.pago ? (
                          <>
                            <Badge variant="outline" className="gap-1 text-xs text-emerald-700 border-emerald-300 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Pagó {pesos(p.pago.monto)} · {metodo}{fechaPago ? ` · ${fechaCorta(fechaPago)}` : ''}
                            </Badge>
                            {comprobante && (
                              <Button size="sm" variant="ghost" className="h-7 text-blue-600" aria-label="Ver comprobante"
                                onClick={() => verComprobante(p.pago!.id)}>
                                <Eye className="h-3.5 w-3.5 mr-1" /> Comprobante
                              </Button>
                            )}
                          </>
                        ) : !abierto && (
                          <Button size="sm" onClick={() => abrirCobro(p)}>
                            <Banknote className="h-4 w-4 mr-1.5" /> Registrar pago
                          </Button>
                        )}
                        {p.status !== 'converted' && (
                          <Button size="sm" variant="outline" className="h-8"
                            onClick={() => { onOpenChange(false); navigate('/students?tab=prueba'); }}>
                            <UserCheck className="h-3.5 w-3.5 mr-1" /> Completar datos
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
    {registroAbierto && (
      <RegistroRapidoDialog
        open={registroAbierto}
        onClose={() => setRegistroAbierto(false)}
        guardando={registrarRapido.isPending}
        onGuardar={(datos) => registrarRapido.mutate(datos, {
          onSuccess: (r) => {
            toast({ title: 'Clase de prueba registrada', description: `${r.creados + r.actualizados} en la lista.` });
            setRegistroAbierto(false);
          },
          onError: (e: Error) => toast({ title: 'No se pudo registrar', description: e.message, variant: 'destructive' }),
        })}
      />
    )}
    <TrialClassSettingsModal open={configAbierta} onOpenChange={setConfigAbierta} />
    </>
  );
}
