import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, Star, Check, RotateCw, Wand2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ImageUpload } from '@/components/common/ImageUpload';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import {
  AthleteIdCard,
  type CardData,
  type CardLayout,
  type CardPattern,
  type CardPhotoShape,
  type CardTextMode,
} from '@/components/cards/AthleteIdCard';

export type CardTemplate = {
  id?: string;
  school_id?: string;
  name: string;
  accent_color: string | null;
  secondary_color: string | null;
  layout: CardLayout;
  pattern: CardPattern;
  photo_shape: CardPhotoShape;
  text_mode: CardTextMode;
  background_url: string | null;
  header_text: string | null;
  footer_text: string | null;
  show_fields: Record<string, boolean>;
  is_default: boolean;
  active: boolean;
};

const FIELD_LABELS: [string, string][] = [
  ['photo', 'Foto'],
  ['doc_number', 'Documento'],
  ['team', 'Equipo'],
  ['branch', 'Sede'],
  ['valid_until', 'Vigencia'],
  ['fee_status', 'Estado de cuota'],
  ['blood_type', 'RH (tipo de sangre)'],
  ['eps', 'EPS'],
  ['tshirt_size', 'Talla'],
  ['emergency_contact', 'Contacto de emergencia'],
];

const DEFAULT_SHOW: Record<string, boolean> = {
  photo: true, doc_number: true, team: true, branch: true, plan: true,
  valid_until: true, fee_status: true, blood_type: false,
  emergency_contact: false, eps: false, tshirt_size: false,
};

const LAYOUTS: { key: CardLayout; name: string; hint: string }[] = [
  { key: 'classic', name: 'Clásico',  hint: 'Escudo arriba, retrato centrado' },
  { key: 'modern',  name: 'Moderno',  hint: 'Bloque de color y panel claro' },
  { key: 'minimal', name: 'Minimal',  hint: 'Fondo claro, gasta poca tinta' },
  { key: 'photo',   name: 'Foto',     hint: 'Retrato a sangre, el de más impacto' },
  { key: 'stripe',  name: 'Franja',   hint: 'Banda lateral con el nombre' },
];

const PATTERNS: { key: CardPattern; name: string }[] = [
  { key: 'none',     name: 'Sin textura' },
  { key: 'diagonal', name: 'Diagonales' },
  { key: 'dots',     name: 'Puntos' },
  { key: 'grid',     name: 'Cuadrícula' },
  { key: 'waves',    name: 'Ondas' },
];

const PHOTO_SHAPES: { key: CardPhotoShape; name: string }[] = [
  { key: 'rounded', name: 'Redondeada' },
  { key: 'circle',  name: 'Círculo' },
  { key: 'square',  name: 'Cuadrada' },
];

const TEXT_MODES: { key: CardTextMode; name: string }[] = [
  { key: 'auto',  name: 'Automático' },
  { key: 'light', name: 'Texto claro' },
  { key: 'dark',  name: 'Texto oscuro' },
];

/** Combinaciones listas para arrancar sin pelearse con seis controles. */
const PRESETS: { name: string; patch: Partial<CardTemplate> }[] = [
  { name: 'Federación',  patch: { layout: 'classic', pattern: 'diagonal', photo_shape: 'rounded', accent_color: '#0f4c81', secondary_color: '#0a2540', text_mode: 'auto' } },
  { name: 'Club moderno', patch: { layout: 'modern', pattern: 'waves', photo_shape: 'circle', accent_color: '#0ea5e9', secondary_color: '#1e1b4b', text_mode: 'auto' } },
  { name: 'Sobrio',      patch: { layout: 'minimal', pattern: 'none', photo_shape: 'square', accent_color: '#111827', secondary_color: '#4b5563', text_mode: 'dark' } },
  { name: 'Alto impacto', patch: { layout: 'photo', pattern: 'none', photo_shape: 'rounded', accent_color: '#dc2626', secondary_color: '#111827', text_mode: 'light' } },
  { name: 'Energía',     patch: { layout: 'stripe', pattern: 'dots', photo_shape: 'circle', accent_color: '#f97316', secondary_color: '#7c2d12', text_mode: 'auto' } },
];

const emptyTemplate = (): CardTemplate => ({
  name: '',
  accent_color: '#0ea5e9',
  secondary_color: null,
  layout: 'classic',
  pattern: 'diagonal',
  photo_shape: 'rounded',
  text_mode: 'auto',
  background_url: null,
  header_text: 'Carnet deportivo',
  footer_text: '',
  show_fields: { ...DEFAULT_SHOW },
  is_default: false,
  active: true,
});

/** La fila de la tabla puede venir de antes de la migración de diseño: se
 *  normaliza para que el formulario nunca quede con un select en undefined. */
const hydrate = (row: any): CardTemplate => ({
  ...emptyTemplate(),
  ...row,
  layout: (row.layout as CardLayout) || 'classic',
  pattern: (row.pattern as CardPattern) || 'diagonal',
  photo_shape: (row.photo_shape as CardPhotoShape) || 'rounded',
  text_mode: (row.text_mode as CardTextMode) || 'auto',
  show_fields: { ...DEFAULT_SHOW, ...(row.show_fields || {}) },
});

export function CardTemplatesManager({ schoolId }: { schoolId: string | null | undefined }) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<CardTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<CardTemplate>(emptyTemplate());
  const [saving, setSaving] = useState(false);
  const [school, setSchool] = useState<{ name: string; logo_url: string | null; branding_settings: any } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CardTemplate | null>(null);
  const [previewFace, setPreviewFace] = useState<'front' | 'back'>('front');

  useEffect(() => {
    if (!schoolId) return;
    void load();
    supabase.from('schools').select('name, logo_url, branding_settings').eq('id', schoolId).maybeSingle()
      .then(({ data }) => data && setSchool(data as any));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  async function load() {
    if (!schoolId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('athlete_id_card_templates')
      .select('*')
      .eq('school_id', schoolId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) toast({ title: 'Error', description: error.message, variant: 'destructive' });
    else setTemplates(((data as any[]) || []).map(hydrate));
    setLoading(false);
  }

  function edit(t: CardTemplate) { setForm(hydrate(t)); }
  function newTemplate() { setForm(emptyTemplate()); }
  function patch(p: Partial<CardTemplate>) { setForm((f) => ({ ...f, ...p })); }
  function setField(k: string, v: boolean) {
    setForm((f) => ({ ...f, show_fields: { ...f.show_fields, [k]: v } }));
  }

  async function save() {
    if (!schoolId) return;
    if (!form.name.trim()) {
      toast({ title: 'Falta el nombre', description: 'Ponle un nombre a la plantilla.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Solo una default por escuela: si esta va como default, desmarca las demás.
      if (form.is_default) {
        await supabase.from('athlete_id_card_templates')
          .update({ is_default: false })
          .eq('school_id', schoolId)
          .neq('id', form.id ?? '00000000-0000-0000-0000-000000000000');
      }
      const payload: any = {
        school_id: schoolId,
        name: form.name.trim(),
        accent_color: form.accent_color,
        secondary_color: form.secondary_color,
        layout: form.layout,
        pattern: form.pattern,
        photo_shape: form.photo_shape,
        text_mode: form.text_mode,
        background_url: form.background_url,
        header_text: form.header_text,
        footer_text: form.footer_text,
        show_fields: form.show_fields,
        is_default: form.is_default,
        active: form.active,
      };
      const res = form.id
        ? await supabase.from('athlete_id_card_templates').update(payload).eq('id', form.id)
        : await supabase.from('athlete_id_card_templates').insert(payload);
      if (res.error) throw res.error;
      toast({ title: form.id ? 'Plantilla actualizada' : 'Plantilla creada' });
      newTemplate();
      void load();
    } catch (e: any) {
      toast({ title: 'No se pudo guardar', description: e?.message || 'Error', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    const t = deleteTarget;
    if (!t?.id) return;
    const { error } = await supabase.from('athlete_id_card_templates').delete().eq('id', t.id);
    if (error) { toast({ title: 'Error', description: error.message, variant: 'destructive' }); return; }
    toast({ title: 'Plantilla eliminada' });
    if (form.id === t.id) newTemplate();
    setDeleteTarget(null);
    void load();
  }

  /** CardData de muestra para el preview. Se arma con lo que el formulario
   *  tiene ahora mismo, así el cambio de color o de layout se ve al instante.
   *  Datos NEUTROS a propósito: antes mostraba la sede y un atleta de un
   *  cliente real, y este editor lo ven todas las escuelas. */
  const previewData = (tpl: CardTemplate): CardData => ({
    found: true,
    status: 'active',
    school: {
      id: '',
      name: school?.name || 'Escuela Ejemplo',
      logo_url: school?.logo_url || null,
      branding_settings: school?.branding_settings || {},
    },
    template: {
      id: '',
      name: tpl.name,
      accent_color: tpl.accent_color,
      secondary_color: tpl.secondary_color,
      layout: tpl.layout,
      pattern: tpl.pattern,
      photo_shape: tpl.photo_shape,
      text_mode: tpl.text_mode,
      background_url: tpl.background_url,
      header_text: tpl.header_text,
      footer_text: tpl.footer_text,
      show_fields: tpl.show_fields,
    },
    athlete: {
      kind: 'child',
      full_name: 'Valentina Ejemplo Ruiz',
      avatar_url: null,
      doc_type: 'TI',
      doc_number: '1000000000',
      blood_type: 'O+',
      eps_name: 'EPS Ejemplo',
      tshirt_size: 'S',
      emergency_contact: 'Acudiente Ejemplo · 300 000 0000',
    },
    branch_name: 'Sede principal',
    team_name: 'Equipo Sub-12',
    valid_until: '2026-12-31',
    version: 1,
    fee_status: 'paid',
    last_payment: { concept: 'Mensualidad 07/2026', amount: 100000, payment_date: '2026-07-01' },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
      {/* Columna izquierda: lista + editor */}
      <div className="space-y-6">
        {/* Lista de plantillas */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Plantillas de la escuela</h3>
              <Button size="sm" variant="outline" onClick={newTemplate} className="gap-1">
                <Plus className="h-3.5 w-3.5" /> Nueva
              </Button>
            </div>
            {loading ? (
              <div className="py-6 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
            ) : templates.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">Aún no hay plantillas. Crea una — la primera será la predeterminada.</p>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <div key={t.id} className={`flex items-center gap-3 rounded-lg border p-2.5 ${form.id === t.id ? 'border-primary bg-primary/5' : ''}`}>
                    <span
                      className="h-8 w-8 rounded-md border shrink-0"
                      style={{ background: `linear-gradient(160deg, ${t.accent_color || '#0ea5e9'}, ${t.secondary_color || t.accent_color || '#0ea5e9'})` }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm flex items-center gap-2">
                        {t.name}
                        {t.is_default && <Badge className="bg-amber-100 text-amber-700 gap-1"><Star className="h-3 w-3" />Predeterminada</Badge>}
                        {!t.active && <Badge variant="outline">Inactiva</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {LAYOUTS.find((l) => l.key === t.layout)?.name || 'Clásico'} · {t.header_text || '—'}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => edit(t)}>Editar</Button>
                    <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeleteTarget(t)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Editor */}
        <Card>
          <CardContent className="p-4 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{form.id ? 'Editar plantilla' : 'Nueva plantilla'}</h3>
              <div className="flex flex-wrap gap-1 justify-end">
                {PRESETS.map((p) => (
                  <Button
                    key={p.name}
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => patch(p.patch)}
                    title="Aplica colores, disposición y textura de golpe"
                  >
                    <Wand2 className="h-3 w-3" />
                    {p.name}
                  </Button>
                ))}
              </div>
            </div>

            {/* Disposición */}
            <div>
              <Label className="mb-2 block">Disposición</Label>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {LAYOUTS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => patch({ layout: l.key })}
                    className={`rounded-lg border p-2 text-left transition ${form.layout === l.key ? 'border-primary ring-2 ring-primary/30 bg-primary/5' : 'hover:bg-muted/50'}`}
                  >
                    <LayoutThumb
                      layout={l.key}
                      primary={form.accent_color || '#0ea5e9'}
                      secondary={form.secondary_color || form.accent_color || '#0ea5e9'}
                    />
                    <div className="text-xs font-medium mt-1.5">{l.name}</div>
                    <div className="text-[10px] text-muted-foreground leading-tight">{l.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Nombre</Label>
                <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Carnet 2026" />
              </div>
              <div>
                <Label>Encabezado</Label>
                <Input value={form.header_text || ''} onChange={(e) => patch({ header_text: e.target.value })} placeholder="Carnet deportivo" />
              </div>
              <div>
                <Label>Color principal</Label>
                <div className="flex items-center gap-2">
                  <input type="color" value={form.accent_color || '#0ea5e9'} onChange={(e) => patch({ accent_color: e.target.value })} className="h-9 w-12 rounded border p-0.5 bg-transparent" />
                  <Input value={form.accent_color || ''} onChange={(e) => patch({ accent_color: e.target.value })} placeholder="#0ea5e9" className="flex-1" />
                </div>
              </div>
              <div>
                <Label className="flex items-center gap-2">
                  Segundo color
                  {form.secondary_color && (
                    <button type="button" className="text-[11px] text-muted-foreground underline" onClick={() => patch({ secondary_color: null })}>
                      derivar del principal
                    </button>
                  )}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={form.secondary_color || form.accent_color || '#0ea5e9'}
                    onChange={(e) => patch({ secondary_color: e.target.value })}
                    className="h-9 w-12 rounded border p-0.5 bg-transparent"
                  />
                  <Input
                    value={form.secondary_color || ''}
                    onChange={(e) => patch({ secondary_color: e.target.value || null })}
                    placeholder="Automático (tono oscuro del principal)"
                    className="flex-1"
                  />
                </div>
              </div>
              <div className="sm:col-span-2">
                <Label>Pie de página</Label>
                <Input value={form.footer_text || ''} onChange={(e) => patch({ footer_text: e.target.value })} placeholder="Nota legal opcional" />
              </div>
            </div>

            {/* Acabados */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <ChipGroup
                label="Textura"
                options={PATTERNS}
                value={form.pattern}
                onChange={(v) => patch({ pattern: v as CardPattern })}
              />
              <ChipGroup
                label="Forma de la foto"
                options={PHOTO_SHAPES}
                value={form.photo_shape}
                onChange={(v) => patch({ photo_shape: v as CardPhotoShape })}
              />
              <ChipGroup
                label="Color del texto"
                options={TEXT_MODES}
                value={form.text_mode}
                onChange={(v) => patch({ text_mode: v as CardTextMode })}
              />
            </div>

            <div>
              <Label className="mb-2 block">Imagen de fondo (opcional)</Label>
              <div className="flex items-center gap-3">
                <ImageUpload
                  value={form.background_url}
                  onChange={(url) => patch({ background_url: url })}
                  onRemove={() => patch({ background_url: null })}
                  bucket="school-assets"
                  // La policy de school-assets solo deja subir a logos/, covers/ y
                  // qr/ + <escuela>/: con `carnets/…` la subida fallaba SIEMPRE (RLS).
                  path={`covers/${schoolId}`}
                  compact
                  hideHint
                />
                <p className="text-xs text-muted-foreground">
                  Va detrás de un velo del color de la plantilla para que el texto siga legible.
                  Ideal: una foto del coliseo o una textura, 680 × 1080 px.
                </p>
              </div>
            </div>

            <div>
              <Label className="mb-2 block">Campos visibles en el carnet</Label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {FIELD_LABELS.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2 text-sm cursor-pointer rounded-md border px-2.5 py-1.5">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={!!form.show_fields[k]} onChange={(e) => setField(k, e.target.checked)} />
                    {label}
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Lo que se apague aquí no viaja al carnet público: el QR tampoco lo muestra.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.is_default} onChange={(e) => patch({ is_default: e.target.checked })} />
                Predeterminada
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.active} onChange={(e) => patch({ active: e.target.checked })} />
                Activa
              </label>
              <div className="ml-auto flex gap-2">
                {form.id && <Button variant="outline" onClick={newTemplate}>Cancelar</Button>}
                <Button onClick={save} disabled={saving} className="gap-1">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {form.id ? 'Guardar cambios' : 'Crear plantilla'}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Columna derecha: preview en vivo */}
      <div className="lg:sticky lg:top-4 self-start">
        <p className="text-xs text-muted-foreground mb-2 text-center">Vista previa en vivo</p>
        <div className="flex justify-center">
          <AthleteIdCard data={previewData(form)} face={previewFace} publicUrl="https://sportmaps.co/c/preview" />
        </div>
        <div className="flex justify-center mt-2">
          <Button size="sm" variant="ghost" className="gap-1" onClick={() => setPreviewFace((f) => (f === 'front' ? 'back' : 'front'))}>
            <RotateCw className="h-3.5 w-3.5" />
            {previewFace === 'front' ? 'Ver reverso' : 'Ver frente'}
          </Button>
        </div>
      </div>

      {/* Confirmar eliminación */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Eliminar plantilla</DialogTitle>
            <DialogDescription>
              ¿Eliminar la plantilla <strong>{deleteTarget?.name}</strong>? Los carnets ya emitidos no se ven afectados.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmDelete}>Eliminar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChipGroup({ label, options, value, onChange }: {
  label: string;
  options: { key: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label className="mb-2 block">{label}</Label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange(o.key)}
            className={`rounded-full border px-2.5 py-1 text-xs transition ${value === o.key ? 'border-primary bg-primary/10 text-primary font-medium' : 'hover:bg-muted/50'}`}
          >
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Miniatura esquemática de cada disposición — no es el carnet real, es la
 *  silueta, que es lo que deja elegir de un vistazo. */
function LayoutThumb({ layout, primary, secondary }: { layout: CardLayout; primary: string; secondary: string }) {
  const grad = `linear-gradient(160deg, ${primary}, ${secondary})`;
  const box = 'w-full rounded-md overflow-hidden border';
  const H = 62;

  if (layout === 'modern') {
    return (
      <div className={box} style={{ height: H, background: '#fff' }}>
        <div style={{ height: '42%', background: grad }} />
        <div className="px-1.5 pt-1 flex gap-1">
          <div className="rounded-sm" style={{ width: 14, height: 14, background: primary, marginTop: -10 }} />
          <div className="flex-1 space-y-1 pt-0.5">
            <div style={{ height: 3, background: '#d1d5db' }} />
            <div style={{ height: 3, width: '60%', background: '#e5e7eb' }} />
          </div>
        </div>
      </div>
    );
  }
  if (layout === 'minimal') {
    return (
      <div className={box} style={{ height: H, background: '#f7f8fa' }}>
        <div style={{ height: 4, background: grad }} />
        <div className="p-1.5 flex gap-1.5 items-center">
          <div className="rounded-sm" style={{ width: 16, height: 16, background: '#d1d5db' }} />
          <div className="flex-1 space-y-1">
            <div style={{ height: 3, background: '#d1d5db' }} />
            <div style={{ height: 3, width: '55%', background: '#e5e7eb' }} />
          </div>
        </div>
      </div>
    );
  }
  if (layout === 'photo') {
    return (
      <div className={box} style={{ height: H, background: grad, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.75) 100%)' }} />
        <div style={{ position: 'absolute', left: 6, right: 6, bottom: 5 }} className="space-y-1">
          <div style={{ height: 3, background: 'rgba(255,255,255,0.9)' }} />
          <div style={{ height: 3, width: '50%', background: 'rgba(255,255,255,0.55)' }} />
        </div>
      </div>
    );
  }
  if (layout === 'stripe') {
    return (
      <div className={box} style={{ height: H, background: '#f7f8fa', display: 'flex' }}>
        <div style={{ width: 12, background: grad }} />
        <div className="flex-1 p-1.5 space-y-1">
          <div className="rounded-sm" style={{ width: 14, height: 14, background: '#d1d5db' }} />
          <div style={{ height: 3, background: '#d1d5db' }} />
          <div style={{ height: 3, width: '60%', background: '#e5e7eb' }} />
        </div>
      </div>
    );
  }
  // classic
  return (
    <div className={box} style={{ height: H, background: grad, position: 'relative' }}>
      <div className="flex items-center gap-1 p-1.5">
        <div className="rounded-sm" style={{ width: 10, height: 10, background: 'rgba(255,255,255,0.9)' }} />
        <div style={{ height: 3, width: '55%', background: 'rgba(255,255,255,0.75)' }} />
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="rounded" style={{ width: 16, height: 16, background: 'rgba(255,255,255,0.92)' }} />
        <div style={{ height: 3, width: '52%', background: 'rgba(255,255,255,0.8)' }} />
      </div>
      <div style={{ position: 'absolute', left: 5, bottom: 4, width: 12, height: 12, background: '#fff', borderRadius: 2 }} />
    </div>
  );
}
