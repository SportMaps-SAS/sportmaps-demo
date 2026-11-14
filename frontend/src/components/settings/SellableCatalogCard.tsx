import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Loader2, Plus, Pencil, ShieldOff, X, ShoppingBag, MessageCircle, Trophy, Link2Off } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { bffClient } from '@/lib/api/bffClient';
import { useEntitlements } from '@/hooks/useEntitlements';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { TIPOS_DE_SERVICIO, definicionDeMotivo, type TipoDeServicio } from '@/lib/motivosDeCobro';
import {
  FORMULARIO_VACIO,
  columnasDePrecios,
  etiquetasDePrecios,
  formularioDePrecios,
  type FormularioDePrecios,
  type OpcionDeServicio,
  type PrecioPorFecha,
} from '@/lib/preciosDeServicio';
import { PreciosDeServicioEditor } from '@/components/settings/PreciosDeServicioEditor';

/**
 * school_tournament_items.kind (mig. 20261007095911, ventas por WhatsApp F0):
 * los tipos de servicio del catálogo único de motivos (lib/motivosDeCobro.ts),
 * que es también la categoría con la que se cobra cada ítem.
 */
type ServiceKind = TipoDeServicio;
const SERVICE_KINDS: { value: ServiceKind; label: string }[] =
  TIPOS_DE_SERVICIO.map((k) => ({ value: k, label: definicionDeMotivo(k).servicio?.tipo ?? definicionDeMotivo(k).etiqueta }));
const KIND_LABEL: Record<string, string> = Object.fromEntries(SERVICE_KINDS.map((k) => [k.value, k.label]));

interface CatalogItem {
  id: string;
  name: string;
  price: number;
  size_options?: string | null;
  image_url?: string | null;
  active: boolean;
  // Campos de servicio (solo school_tournament_items, con la migración F0 aplicada)
  description?: string | null;
  kind?: ServiceKind | null;
  starts_at?: string | null;
  ends_at?: string | null;
  capacity?: number | null;
  per_athlete?: boolean | null;
  /** Torneo interno (events) al que está vinculado el cobro; null = cobro suelto. */
  event_id?: string | null;
  // Precios especiales (migración M2 comprobantes_con_motivo; ver lib/preciosDeServicio.ts)
  precio_afiliado?: number | null;
  opciones?: OpcionDeServicio[] | null;
  precios_por_fecha?: PrecioPorFecha[] | null;
  abono_minimo_pct?: number | null;
}

/** Torneo interno de la escuela, para vincular un cobro del catálogo. */
interface TorneoOpcion { id: string; title: string; status: string }

interface SellableCatalogCardProps {
  schoolId: string;
  /** Tabla real detrás del catálogo — cada una tiene su propia RLS/gate en school_settings. */
  table: 'school_merchandise_items' | 'school_tournament_items';
  /** school_settings.merchandise_enabled / tournament_charges_enabled — SOLO SportMaps lo prende
      (guard trigger, ver 20260908152538); esta card nunca ofrece encenderlo. */
  enabled: boolean;
  title: string;
  description: string;
  /** Usado en los toasts y el formulario, ej. "artículo" / "cobro". */
  itemLabel: string;
  /** Artículos usa tallas + imagen; torneos no (no aplica a una cuota). */
  withSizesAndImage?: boolean;
  /**
   * Cobros de servicio vendibles por WhatsApp (docs/specs/ventas-por-whatsapp.md §4.4):
   * tipo, descripción, fecha, cupos, foto y si se cobra por atleta, más el
   * interruptor `school_settings.wa_ventas_habilitadas`. Si la migración F0 no
   * está aplicada, la tarjeta se ve como antes.
   */
  withServiceFields?: boolean;
  /**
   * Cobros de torneo: permite crear el torneo en el módulo de Torneos desde el ítem, o
   * vincularlo a uno existente. Un ítem vinculado ya no se vende como cobro suelto: se
   * inscribe en el torneo (así no se cobra dos veces). Solo en la vista de la propia escuela.
   */
  linkTournaments?: boolean;
}

/** ISO → valor de <input type="datetime-local"> en la hora del navegador. */
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function formatWhen(item: CatalogItem): string | null {
  if (!item.starts_at) return null;
  const f = (iso: string) => new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return item.ends_at ? `${f(item.starts_at)} – ${f(item.ends_at)}` : f(item.starts_at);
}

const BASE_COLS = 'id, name, price, active';
const SERVICE_COLS = 'id, name, price, active, description, kind, image_url, starts_at, ends_at, capacity, per_athlete, event_id';
/** Columnas de M2 (comprobantes_con_motivo). Si no existen todavía, la tarjeta se ve como antes. */
const PRECIOS_COLS = 'precio_afiliado, opciones, precios_por_fecha, abono_minimo_pct';

/**
 * CRUD de un catálogo vendible (artículos deportivos, cobros de torneo) que la
 * propia escuela administra una vez SportMaps lo habilitó. Mismo componente lo
 * usa AdminSubscriptionsPage (soporte interno) y PaymentsAutomationPage
 * (self-service de la escuela) — ver migración 20260908152538.
 */
export function SellableCatalogCard({
  schoolId, table, enabled, title, description, itemLabel, withSizesAndImage = false, withServiceFields = false, linkTournaments = false,
}: SellableCatalogCardProps) {
  const navigate = useNavigate();
  const { hasAddon } = useEntitlements();
  const [torneos, setTorneos] = useState<TorneoOpcion[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [sizes, setSizes] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  // Servicio (ventas por WhatsApp)
  const [serviceReady, setServiceReady] = useState(false);
  const [kind, setKind] = useState<ServiceKind>('torneo');
  const [desc, setDesc] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [capacity, setCapacity] = useState('');
  const [perAthlete, setPerAthlete] = useState(true);
  /** null = la columna no existe todavía (migración sin aplicar): no se muestra el interruptor. */
  const [waSales, setWaSales] = useState<boolean | null>(null);
  // Precios especiales (afiliados, opciones, por fecha, abono): solo con M2 aplicada.
  const [preciosReady, setPreciosReady] = useState(false);
  const [precios, setPrecios] = useState<FormularioDePrecios>(FORMULARIO_VACIO);

  const showService = withServiceFields && serviceReady;
  const showPrecios = showService && preciosReady;
  // Vincular requiere el módulo de Torneos y la columna event_id (migración 20261020122827).
  const canLink = linkTournaments && hasAddon('tournaments');

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setPrice('');
    setSizes('');
    setImageUrl('');
    setKind('torneo');
    setDesc('');
    setStartsAt('');
    setEndsAt('');
    setCapacity('');
    setPerAthlete(true);
    setPrecios(FORMULARIO_VACIO);
  };

  const load = async () => {
    setLoading(true);
    let data: unknown = null;
    let error: { message: string } | null = null;
    if (withServiceFields) {
      // Con M2 aplicada trae también los precios especiales; con F0, los campos de
      // servicio; si no, la consulta de siempre. Una columna que falta da 400 y se
      // pide la versión anterior: la pantalla nunca se rompe por una migración pendiente.
      const conPrecios = await supabase.from(table as any).select(`${SERVICE_COLS}, ${PRECIOS_COLS}`).eq('school_id', schoolId).order('sort_order', { ascending: true });
      const r = conPrecios.error
        ? await supabase.from(table as any).select(SERVICE_COLS).eq('school_id', schoolId).order('sort_order', { ascending: true })
        : conPrecios;
      setPreciosReady(!conPrecios.error);
      if (!r.error) {
        data = r.data;
        setServiceReady(true);
      } else {
        setServiceReady(false);
      }
    }
    if (data === null) {
      const cols = withSizesAndImage ? 'id, name, price, size_options, image_url, active' : BASE_COLS;
      const r = await supabase.from(table as any).select(cols).eq('school_id', schoolId).order('sort_order', { ascending: true });
      data = r.data;
      error = r.error;
    }
    if (error) toast({ title: 'Error cargando el catálogo', description: error.message, variant: 'destructive' });
    setItems(((data as any) || []) as CatalogItem[]);
    setLoading(false);

    if (withServiceFields) {
      const s = await supabase.from('school_settings' as any).select('wa_ventas_habilitadas').eq('school_id', schoolId).maybeSingle();
      setWaSales(s.error ? null : Boolean((s.data as any)?.wa_ventas_habilitadas));
    }
  };

  useEffect(() => {
    if (enabled && schoolId) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId, enabled, table]);

  // Torneos internos de la escuela (para «Vincular»). Si falla, solo se pierde esa opción.
  useEffect(() => {
    if (!enabled || !canLink) return;
    bffClient.get<(TorneoOpcion & { tournament_scope: string | null })[]>('/api/v1/events/school-tournaments')
      .then((rows) => setTorneos((rows ?? []).filter((t) => t.tournament_scope === 'internal' && t.status !== 'cancelled')))
      .catch(() => setTorneos([]));
  }, [enabled, canLink, schoolId]);

  const linkEvent = async (item: CatalogItem, eventId: string | null) => {
    setSaving(true);
    const { error } = await supabase.from(table as any).update({ event_id: eventId }).eq('id', item.id);
    setSaving(false);
    if (error) {
      const dup = /school_tournament_items_event_uq|duplicate key/i.test(error.message);
      toast({ title: 'No se pudo vincular', description: dup ? 'Ese torneo ya está vinculado a otro cobro.' : error.message, variant: 'destructive' });
      return;
    }
    toast({ title: eventId ? 'Cobro vinculado al torneo' : 'Cobro desvinculado', description: item.name });
    await load();
  };

  const startEdit = (item: CatalogItem) => {
    setEditingId(item.id);
    setName(item.name);
    setPrice(String(item.price));
    setSizes(item.size_options || '');
    setImageUrl(item.image_url || '');
    setKind((item.kind as ServiceKind) || 'torneo');
    setDesc(item.description || '');
    setStartsAt(toLocalInput(item.starts_at));
    setEndsAt(toLocalInput(item.ends_at));
    setCapacity(item.capacity ? String(item.capacity) : '');
    setPerAthlete(item.per_athlete !== false);
    setPrecios(formularioDePrecios(item));
  };

  const save = async () => {
    const trimmedName = name.trim();
    const parsedPrice = Number(price.replace(/\./g, '').replace(/,/g, ''));
    if (!trimmedName) { toast({ title: 'Falta el nombre', variant: 'destructive' }); return; }
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) { toast({ title: 'Precio inválido', variant: 'destructive' }); return; }
    if ((withSizesAndImage || showService) && imageUrl.trim() && !/^https:\/\//.test(imageUrl.trim())) {
      toast({ title: 'La imagen debe ser una URL https://', variant: 'destructive' });
      return;
    }
    const row: Record<string, unknown> = { school_id: schoolId, name: trimmedName, price: parsedPrice };
    if (withSizesAndImage) {
      row.size_options = sizes.trim() || null;
      row.image_url = imageUrl.trim() || null;
    }
    if (showService) {
      const starts = fromLocalInput(startsAt);
      const ends = fromLocalInput(endsAt);
      if (ends && starts && ends < starts) { toast({ title: 'La fecha de fin es anterior al inicio', variant: 'destructive' }); return; }
      const cap = capacity.trim() ? Number(capacity.trim()) : null;
      if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) { toast({ title: 'Los cupos deben ser un número mayor que 0', variant: 'destructive' }); return; }
      row.kind = kind;
      row.description = desc.trim() || null;
      row.image_url = imageUrl.trim() || null;
      row.starts_at = starts;
      row.ends_at = ends;
      row.capacity = cap;
      row.per_athlete = perAthlete;
    }
    if (showPrecios) {
      const r = columnasDePrecios(precios);
      if ('error' in r) { toast({ title: r.error, variant: 'destructive' }); return; }
      Object.assign(row, r.columnas);
    }
    setSaving(true);
    const { error } = editingId
      ? await supabase.from(table as any).update(row).eq('id', editingId)
      : await supabase.from(table as any).insert(row);
    setSaving(false);
    if (error) { toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' }); return; }
    toast({ title: editingId ? `${itemLabel} actualizado` : `${itemLabel} agregado`, description: trimmedName });
    resetForm();
    await load();
  };

  const toggleActive = async (item: CatalogItem) => {
    setSaving(true);
    const { error } = await supabase.from(table as any).update({ active: !item.active }).eq('id', item.id);
    setSaving(false);
    if (error) { toast({ title: 'No se pudo aplicar', description: error.message, variant: 'destructive' }); return; }
    await load();
  };

  const toggleWaSales = async (value: boolean) => {
    setSaving(true);
    const { error } = await supabase.from('school_settings' as any).update({ wa_ventas_habilitadas: value }).eq('school_id', schoolId);
    setSaving(false);
    if (error) { toast({ title: 'No se pudo cambiar', description: error.message, variant: 'destructive' }); return; }
    setWaSales(value);
    toast({ title: value ? 'Mapi ya vende estos servicios por WhatsApp' : 'Ventas por WhatsApp apagadas' });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {!enabled ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            SportMaps todavía no habilitó este catálogo para tu escuela. Contacta a soporte si lo necesitas.
          </div>
        ) : loading ? (
          <div className="py-4 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {showService && waSales !== null && (
              <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="flex gap-2">
                  <MessageCircle className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
                  <div>
                    <p className="text-sm font-medium">Vender por WhatsApp</p>
                    <p className="text-xs text-muted-foreground">
                      Mapi responde precio, fecha y cupos de estos servicios y, a las familias identificadas, les manda el link de pago con 1 hora para pagar.
                    </p>
                  </div>
                </div>
                <Switch checked={waSales} disabled={saving} onCheckedChange={toggleWaSales} />
              </div>
            )}

            {items.length > 0 && (
              <div className="space-y-1.5">
                {items.map((item) => (
                  <div key={item.id} className={`flex items-center gap-2 rounded-lg border p-2 ${!item.active ? 'opacity-50 bg-muted/30' : ''}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{item.name}</span>
                        {item.size_options && <span className="text-[11px] text-muted-foreground">{item.size_options}</span>}
                        {showService && item.kind && <Badge variant="outline" className="text-[10px]">{KIND_LABEL[item.kind] ?? item.kind}</Badge>}
                        {item.event_id && <Badge variant="secondary" className="text-[10px]" title="Se paga inscribiendo en el torneo; no se vende como cobro suelto">Torneo vinculado</Badge>}
                      </div>
                      <div className="text-xs text-primary font-semibold">
                        ${item.price.toLocaleString('es-CO')}
                        {showService && formatWhen(item) && <span className="ml-2 font-normal text-muted-foreground">{formatWhen(item)}</span>}
                        {showService && item.capacity ? <span className="ml-2 font-normal text-muted-foreground">{item.capacity} cupos</span> : null}
                      </div>
                      {showPrecios && etiquetasDePrecios(item).length > 0 && (
                        <div className="text-[11px] text-muted-foreground">{etiquetasDePrecios(item).join(' · ')}</div>
                      )}
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                      {canLink && showService && (item.kind ?? 'torneo') === 'torneo' && (
                        item.event_id ? (
                          <>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] shrink-0" onClick={() => navigate(`/school/tournaments/${item.event_id}`)}>
                              <Trophy className="h-3 w-3 mr-1" /> Ver torneo
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" title="Desvincular del torneo" disabled={saving} onClick={() => linkEvent(item, null)}>
                              <Link2Off className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px] shrink-0" disabled={saving} onClick={() => navigate(`/school/tournaments/new?from_item=${item.id}`)}>
                              <Trophy className="h-3 w-3 mr-1" /> Crear en Torneos
                            </Button>
                            {torneos.filter((t) => !items.some((o) => o.event_id === t.id)).length > 0 && (
                              <select
                                aria-label={`Vincular ${item.name} a un torneo`}
                                value=""
                                disabled={saving}
                                onChange={(e) => e.target.value && void linkEvent(item, e.target.value)}
                                className="h-7 rounded-md border border-input bg-background px-1 text-[11px] max-w-[130px] shrink-0"
                              >
                                <option value="">Vincular…</option>
                                {torneos.filter((t) => !items.some((o) => o.event_id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                              </select>
                            )}
                          </>
                        )
                      )}
                      </div>
                    </div>
                    <Badge variant={item.active ? 'secondary' : 'outline'} className="text-[10px] shrink-0">
                      {item.active ? 'Activo' : 'Inactivo'}
                    </Badge>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" aria-label={`Editar ${item.name}`} disabled={saving} onClick={() => startEdit(item)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 shrink-0" aria-label={item.active ? `Desactivar ${item.name}` : `Activar ${item.name}`} disabled={saving} onClick={() => toggleActive(item)}>
                      <ShieldOff className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="rounded-xl border border-dashed p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold">{editingId ? `Editar ${itemLabel}` : `+ Agregar ${itemLabel}`}</p>
                {editingId && (
                  <Button size="sm" variant="ghost" className="h-6 px-2" onClick={resetForm}>
                    <X className="h-3 w-3 mr-1" /> Cancelar
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
                <Input placeholder="Precio (COP)" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} className="h-8 text-sm" />
                {withSizesAndImage && (
                  <>
                    <Input placeholder="Tallas, ej. S, M, L (opcional)" value={sizes} onChange={(e) => setSizes(e.target.value)} className="h-8 text-sm" />
                    <Input placeholder="Imagen https:// (opcional)" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="h-8 text-sm" />
                  </>
                )}
                {showService && (
                  <>
                    <select
                      aria-label="Tipo de servicio"
                      value={kind}
                      onChange={(e) => setKind(e.target.value as ServiceKind)}
                      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      {SERVICE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                    <Input placeholder="Cupos (opcional)" inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} className="h-8 text-sm" />
                    <Input placeholder="Descripción corta (opcional)" value={desc} onChange={(e) => setDesc(e.target.value)} className="h-8 text-sm sm:col-span-2" />
                    <label className="text-[11px] text-muted-foreground space-y-1">
                      <span>Empieza (opcional)</span>
                      <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="h-8 text-sm" />
                    </label>
                    <label className="text-[11px] text-muted-foreground space-y-1">
                      <span>Termina (opcional)</span>
                      <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="h-8 text-sm" />
                    </label>
                    <Input placeholder="Foto https:// (opcional)" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} className="h-8 text-sm" />
                    <label className="flex items-center gap-2 text-xs">
                      <Switch checked={perAthlete} onCheckedChange={setPerAthlete} />
                      Se cobra por deportista
                    </label>
                  </>
                )}
                {showPrecios && (
                  <PreciosDeServicioEditor
                    key={editingId ?? 'nuevo'}
                    value={precios}
                    onChange={setPrecios}
                    precioBase={price}
                    disabled={saving}
                  />
                )}
              </div>
              <Button size="sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                {editingId ? 'Guardar cambios' : 'Agregar'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
