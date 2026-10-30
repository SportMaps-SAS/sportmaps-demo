import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, MessageCircle, Plus, Search, Settings, Store, Trash2, UserCheck, X, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { whatsappLink } from '@/lib/clinical/family-extra';
import {
  useConfigClasePrueba, useProspectosClasePrueba, type ProspectoClasePrueba,
} from '@/hooks/useClasePrueba';
import { ProspectoDetalleEmbudo } from './ProspectoDetalleEmbudo';

const CANAL: Record<string, { label: string; icon: typeof Store }> = {
  presencial: { label: 'En la escuela', icon: Store },
  whatsapp: { label: 'WhatsApp', icon: MessageCircle },
  formulario: { label: 'Formulario', icon: FileText },
};

function fechaCorta(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
    .toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

/** Qué le falta para pasar a deportista (lo que pide el alta normal). */
function faltantes(p: ProspectoClasePrueba): string[] {
  const f: string[] = [];
  if (!p.birth_date) f.push('fecha de nacimiento');
  if (!p.email) f.push('correo');
  return f;
}

interface Props {
  schoolId: string;
  /** Abre el alta normal precargada; el padre cierra el prospecto al guardar. */
  onCompletar: (p: ProspectoClasePrueba) => void;
  onConfigurar: () => void;
}

/**
 * Pestaña «Clase de prueba» de Deportistas: los prospectos de todos los
 * canales (WhatsApp, formulario, en la escuela) hasta que se completan con el
 * alta o se descartan. No son deportistas: no cobran ni cuentan en asistencia.
 */
export function ClasePruebaPanel({ schoolId, onCompletar, onConfigurar }: Props) {
  const { toast } = useToast();
  const { config } = useConfigClasePrueba(schoolId);
  const { prospectos, isLoading, error, registrar, cerrar } = useProspectosClasePrueba(schoolId);
  const [busqueda, setBusqueda] = useState('');
  const [registroAbierto, setRegistroAbierto] = useState(false);

  const filtrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return prospectos;
    return prospectos.filter((p) =>
      [p.full_name, p.guardian_name, p.phone].some((v) => (v ?? '').toLowerCase().includes(q)));
  }, [prospectos, busqueda]);

  const puedeRegistrar = !!config?.enabled && !!config?.presencial_enabled;

  const descartar = (p: ProspectoClasePrueba) => {
    if (!window.confirm(`¿Descartar a ${p.full_name}? Sale de esta lista.`)) return;
    cerrar.mutate({ leadId: p.id, estado: 'discarded' }, {
      onError: (e: any) => toast({ title: 'No se pudo descartar', description: e.message, variant: 'destructive' }),
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
          <p className="text-sm text-muted-foreground">
            Quienes tomaron o pidieron clase de prueba. Se quedan acá hasta completar sus datos.
          </p>
          <div className="flex gap-2">
            {config?.es_admin && (
              <Button variant="outline" size="sm" onClick={onConfigurar}>
                <Settings className="h-4 w-4 mr-1.5" /> Configurar
              </Button>
            )}
            <Button size="sm" onClick={() => setRegistroAbierto(true)} disabled={!puedeRegistrar}
              title={puedeRegistrar ? undefined : 'El registro en la escuela está apagado en la configuración'}>
              <Plus className="h-4 w-4 mr-1.5" /> Registrar clase de prueba
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
          <Input placeholder="Buscar por nombre, acudiente o teléfono..." value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)} className="pl-10" />
        </div>
      </CardHeader>
      <CardContent>
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
              const falta = faltantes(p);
              const wa = p.phone ? whatsappLink(p.phone) : null;
              return (
                <li key={p.id} className="py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm truncate">{p.full_name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {p.guardian_name ? `${p.guardian_name} · ` : ''}{p.phone}
                    </p>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge variant="secondary" className="text-[10px] gap-1"><Icono className="h-3 w-3" />{canal.label}</Badge>
                      {p.fecha_clase && (
                        <Badge variant="outline" className="text-[10px]">
                          Clase {fechaCorta(p.fecha_clase)}{p.cupo_hora ? ` ${p.cupo_hora.slice(0, 5)}` : ''}{p.cupo_label ? ` · ${p.cupo_label}` : ''}
                        </Badge>
                      )}
                      {p.asistencia === 'asistio' && <Badge className="text-[10px] bg-emerald-600 hover:bg-emerald-600">Asistió</Badge>}
                      {p.asistencia === 'no_vino' && <Badge variant="outline" className="text-[10px]">No vino</Badge>}
                      {falta.length > 0 && (
                        <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300 dark:text-amber-400">
                          Falta: {falta.join(', ')}
                        </Badge>
                      )}
                    </div>
                    <ProspectoDetalleEmbudo prospecto={p} />
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {wa && (
                      <Button asChild size="sm" variant="outline" aria-label="Escribir por WhatsApp">
                        <a href={wa} target="_blank" rel="noreferrer">
                          <MessageCircle className="h-4 w-4 text-emerald-600" />
                        </a>
                      </Button>
                    )}
                    <Button size="sm" onClick={() => onCompletar(p)}>
                      <UserCheck className="h-4 w-4 mr-1.5" /> Completar datos
                    </Button>
                    {config?.es_admin && (
                      <Button size="sm" variant="ghost" aria-label="Descartar" onClick={() => descartar(p)} disabled={cerrar.isPending}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {registroAbierto && <RegistroRapidoDialog
        open={registroAbierto}
        onClose={() => setRegistroAbierto(false)}
        guardando={registrar.isPending}
        onGuardar={(datos) => registrar.mutate(datos, {
          onSuccess: (r) => {
            toast({
              title: 'Clase de prueba registrada',
              description: `${r.creados + r.actualizados} en la lista de Clase de prueba.`,
            });
            setRegistroAbierto(false);
          },
          onError: (e: any) => toast({ title: 'No se pudo registrar', description: e.message, variant: 'destructive' }),
        })}
      />}
    </Card>
  );
}

function RegistroRapidoDialog({ open, onClose, onGuardar, guardando }: {
  open: boolean;
  onClose: () => void;
  guardando: boolean;
  onGuardar: (d: { acudiente: string; telefono: string; nombres: string[]; esAdulto: boolean }) => void;
}) {
  const [esAdulto, setEsAdulto] = useState(false);
  const [acudiente, setAcudiente] = useState('');
  const [telefono, setTelefono] = useState('');
  const [nombres, setNombres] = useState<string[]>(['']);

  const limpiar = () => { setEsAdulto(false); setAcudiente(''); setTelefono(''); setNombres(['']); };
  const cerrar = () => { limpiar(); onClose(); };

  const nombresValidos = nombres.map((n) => n.trim()).filter(Boolean);
  const telefonoOk = telefono.replace(/\D/g, '').length >= 7;
  const listo = telefonoOk && nombresValidos.length > 0 && (esAdulto || acudiente.trim().length > 0);

  const guardar = () => {
    if (!listo) return;
    onGuardar({ acudiente: acudiente.trim(), telefono, nombres: esAdulto ? nombresValidos.slice(0, 1) : nombresValidos, esAdulto });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) cerrar(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Registrar clase de prueba</DialogTitle>
          <DialogDescription>Solo lo básico. Los demás datos se completan si se inscribe.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="flex items-center justify-between text-sm">
            <span>Es un adulto (la clase es para él/ella)</span>
            <Switch checked={esAdulto} onCheckedChange={(v) => { setEsAdulto(v); if (v) setNombres((n) => [n[0] ?? '']); }} />
          </label>

          {!esAdulto && (
            <div className="space-y-1.5">
              <Label>Nombre del acudiente</Label>
              <Input value={acudiente} onChange={(e) => setAcudiente(e.target.value)} placeholder="Nombre y apellido" autoFocus />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{esAdulto ? 'Teléfono / WhatsApp' : 'Teléfono / WhatsApp del acudiente'}</Label>
            <Input value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="300 000 0000" inputMode="tel" />
          </div>

          <div className="space-y-2">
            <Label>{esAdulto ? 'Nombre completo' : 'Niños'}</Label>
            {nombres.map((n, i) => (
              <div key={i} className="flex gap-2">
                <Input
                  value={n}
                  onChange={(e) => setNombres((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={esAdulto ? 'Nombre y apellido' : `Nombre del niño ${nombres.length > 1 ? i + 1 : ''}`.trim()}
                  autoFocus={esAdulto && i === 0}
                />
                {nombres.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" aria-label="Quitar"
                    onClick={() => setNombres((prev) => prev.filter((_, j) => j !== i))}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {!esAdulto && nombres.length < 10 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setNombres((prev) => [...prev, ''])}>
                <Plus className="h-4 w-4 mr-1" /> Otro niño
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={cerrar}>Cancelar</Button>
          <Button onClick={guardar} disabled={!listo || guardando}>
            {guardando && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />} Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
