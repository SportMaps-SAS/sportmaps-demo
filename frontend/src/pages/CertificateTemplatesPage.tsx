/**
 * Plantillas de constancias (escuela). Qué constancias ofrece la escuela, con
 * qué texto y firma. Las familias ven las plantillas ACTIVAS al pedir una.
 *
 * Hoy no se cobra por las constancias (decisión 2026-11-24): el interruptor
 * de cobro ya no se muestra y toda plantilla se guarda sin precio.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Eye, FileText, Loader2, Plus, Save, Sparkles, Star, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ImageUpload } from '@/components/common/ImageUpload';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import {
  etiquetaTipo, insertarVariable, PLANTILLAS_SUGERIDAS, TIPOS_CONSTANCIA, VARIABLES_CONSTANCIA,
  variablesDesconocidas, type TipoConstancia,
} from '@/lib/constancias';

type Tpl = {
  id?: string;
  school_id?: string;
  name: string;
  kind: TipoConstancia;
  title: string;
  body_template: string;
  signature_name?: string | null;
  signature_title?: string | null;
  signature_image_url?: string | null;
  footer_text?: string | null;
  is_default: boolean;
  active: boolean;
};

const NUEVA: Tpl = {
  name: PLANTILLAS_SUGERIDAS[0].name,
  kind: PLANTILLAS_SUGERIDAS[0].kind,
  title: PLANTILLAS_SUGERIDAS[0].title,
  body_template: PLANTILLAS_SUGERIDAS[0].body_template,
  signature_name: '',
  signature_title: 'Director(a)',
  signature_image_url: null,
  footer_text: PLANTILLAS_SUGERIDAS[0].footer_text,
  is_default: false,
  active: true,
};

const GRUPOS = ['Deportista', 'Inscripción', 'Escuela', 'Documento'] as const;

/** Solo las columnas que se escriben: requires_payment/price quedan en su default (sin cobro). */
function payloadDe(t: Tpl, schoolId: string) {
  return {
    school_id: schoolId,
    name: t.name.trim(),
    kind: t.kind,
    title: t.title.trim(),
    body_template: t.body_template,
    signature_name: t.signature_name?.trim() || null,
    signature_title: t.signature_title?.trim() || null,
    signature_image_url: t.signature_image_url || null,
    footer_text: t.footer_text?.trim() || null,
    is_default: t.is_default,
    active: t.active,
    requires_payment: false,
    price: 0,
  };
}

export default function CertificateTemplatesPage() {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();
  const [items, setItems] = useState<Tpl[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Tpl | null>(null);
  const [saving, setSaving] = useState(false);
  const [creatingSuggested, setCreatingSuggested] = useState(false);
  const [toDelete, setToDelete] = useState<Tpl | null>(null);
  const [inUse, setInUse] = useState<Tpl | null>(null);
  const [preview, setPreview] = useState<{ url: string; aviso: string | null } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  /** Siempre contra el estado ACTUAL. La subida de la firma termina segundos
   *  después: con un setEditing sobre la copia del render, el callback guardaba la copia
   *  de cuando empezó y borraba lo que se escribió mientras subía. */
  const patch = (p: Partial<Tpl>) => setEditing((e) => (e ? { ...e, ...p } : e));

  useEffect(() => {
    if (!schoolId) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  // Libera el PDF de la vista previa al cerrarla.
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url); }, [preview]);

  async function load() {
    if (!schoolId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('school_certificate_templates' as any)
      .select('id, school_id, name, kind, title, body_template, signature_name, signature_title, signature_image_url, footer_text, is_default, active, created_at')
      .eq('school_id', schoolId)
      .order('active', { ascending: false })
      .order('created_at', { ascending: false });
    setLoading(false);
    if (error) {
      toast({ title: 'No se pudieron cargar las plantillas', description: error.message, variant: 'destructive' });
      setItems([]);
      return;
    }
    setItems((data as any[]) as Tpl[]);
  }

  /** Solo una predeterminada por tipo (índice único en la base): se desmarcan las otras antes. */
  async function liberarPredeterminada(kind: string, exceptId?: string) {
    if (!schoolId) return;
    let q = supabase
      .from('school_certificate_templates' as any)
      .update({ is_default: false })
      .eq('school_id', schoolId)
      .eq('kind', kind)
      .eq('is_default', true);
    if (exceptId) q = q.neq('id', exceptId);
    await q;
  }

  async function save() {
    if (!editing || !schoolId) return;
    if (!editing.name.trim() || !editing.title.trim() || !editing.body_template.trim()) {
      toast({ title: 'Faltan datos', description: 'La plantilla necesita nombre, título y texto.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    if (editing.is_default) await liberarPredeterminada(editing.kind, editing.id);
    const payload = payloadDe(editing, schoolId);
    const { error } = editing.id
      ? await supabase.from('school_certificate_templates' as any).update(payload).eq('id', editing.id)
      : await supabase.from('school_certificate_templates' as any).insert(payload);
    setSaving(false);
    if (error) {
      toast({ title: 'No se pudo guardar', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: editing.id ? 'Plantilla actualizada' : 'Plantilla creada' });
    setEditing(null);
    await load();
  }

  async function crearSugeridas() {
    if (!schoolId) return;
    setCreatingSuggested(true);
    const existentes = new Set(items.map((t) => t.name.trim().toLowerCase()));
    const nuevas = PLANTILLAS_SUGERIDAS
      .filter((p) => !existentes.has(p.name.toLowerCase()))
      .map((p) => payloadDe({
        ...NUEVA, ...p, signature_name: '', signature_title: 'Director(a)',
        // La primera de cada tipo queda como predeterminada si el tipo no tiene una.
        is_default: !items.some((t) => t.kind === p.kind && t.is_default),
      }, schoolId));
    const { error } = nuevas.length
      ? await supabase.from('school_certificate_templates' as any).insert(nuevas)
      : { error: null };
    setCreatingSuggested(false);
    if (error) {
      toast({ title: 'No se pudieron crear', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Plantillas listas', description: 'Ábrelas para poner el nombre y la firma de quien firma.' });
    await load();
  }

  async function setActive(t: Tpl, active: boolean) {
    const { error } = await supabase.from('school_certificate_templates' as any).update({ active }).eq('id', t.id!);
    if (error) {
      toast({ title: 'No se pudo cambiar', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: active ? 'Plantilla activada' : 'Plantilla desactivada', description: active ? 'Las familias ya pueden pedirla.' : 'Las familias ya no la ven.' });
    await load();
  }

  async function confirmDelete() {
    const t = toDelete;
    setToDelete(null);
    if (!t?.id) return;
    const { error } = await supabase.from('school_certificate_templates' as any).delete().eq('id', t.id);
    if (error) {
      // 23503: ya hay constancias emitidas con esta plantilla (FK RESTRICT).
      if ((error as any).code === '23503') {
        setInUse(t);
        return;
      }
      toast({ title: 'No se pudo eliminar', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: 'Plantilla eliminada' });
    await load();
  }

  function insertar(clave: string) {
    if (!editing) return;
    const el = bodyRef.current;
    const inicio = el?.selectionStart ?? editing.body_template.length;
    const fin = el?.selectionEnd ?? inicio;
    const r = insertarVariable(editing.body_template, inicio, fin, clave);
    patch({ body_template: r.texto });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(r.cursor, r.cursor);
    });
  }

  async function verPrevia(t: Tpl) {
    setPreviewing(true);
    try {
      const res = await bffClient.post<any>('/api/v1/certificates/preview', {
        title: t.title,
        body_template: t.body_template,
        signature_name: t.signature_name || null,
        signature_title: t.signature_title || null,
        signature_image_url: t.signature_image_url || null,
        footer_text: t.footer_text || null,
      });
      if (!res?.pdf_base64) throw new Error('sin_pdf');
      const bytes = Uint8Array.from(atob(res.pdf_base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const desconocidas = (res.variables_desconocidas ?? []).map((v: any) => `{{${v.clave}}}`);
      const avisos = [
        desconocidas.length ? `Estas variables no existen y salen vacías: ${desconocidas.join(', ')}.` : null,
        res.firma_omitida ? 'La imagen de la firma no se pudo usar: súbela otra vez en PNG o JPG.' : null,
      ].filter(Boolean).join(' ');
      setPreview({ url, aviso: avisos || null });
    } catch (e: any) {
      toast({ title: 'No se pudo armar la vista previa', description: e?.message || 'Inténtalo de nuevo.', variant: 'destructive' });
    } finally {
      setPreviewing(false);
    }
  }

  const desconocidas = editing ? variablesDesconocidas(editing.body_template) : [];

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <Link to="/carnets-constancias" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-1">
            <ArrowLeft className="h-4 w-4" /> Carnets, constancias y QR
          </Link>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileText className="h-7 w-7 text-primary" />
            Plantillas de constancias
          </h1>
          <p className="text-muted-foreground text-sm mt-1 max-w-2xl">
            Cada plantilla es un tipo de constancia que tu escuela entrega: el texto, quién firma y el pie.
            Los datos del deportista se llenan solos al emitirla. Las familias pueden pedir las plantillas activas.
          </p>
        </div>
        <Button onClick={() => setEditing({ ...NUEVA, school_id: schoolId ?? undefined })} className="gap-2">
          <Plus className="h-4 w-4" />
          Nueva plantilla
        </Button>
      </header>

      {loading ? (
        <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center text-center gap-3">
            <Sparkles className="h-8 w-8 text-primary" />
            <p className="text-lg font-semibold">Aún no tienes plantillas</p>
            <p className="text-sm text-muted-foreground max-w-md">
              Empieza con las dos más pedidas —constancia de inscripción y de deportista activo— y ajústalas a tu escuela.
            </p>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <Button onClick={crearSugeridas} disabled={creatingSuggested} className="gap-2">
                {creatingSuggested ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Crear las plantillas sugeridas
              </Button>
              <Button variant="outline" onClick={() => setEditing({ ...NUEVA, school_id: schoolId ?? undefined })}>
                Empezar desde cero
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((t) => (
            <Card key={t.id} className={t.active ? 'border-2' : 'border-2 border-dashed opacity-80'}>
              <CardContent className="pt-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold break-words">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{etiquetaTipo(t.kind)}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1 shrink-0">
                    {t.is_default && <Badge className="gap-1"><Star className="h-3 w-3" />Predeterminada</Badge>}
                    {t.active ? <Badge variant="secondary">Activa</Badge> : <Badge variant="outline">Inactiva</Badge>}
                  </div>
                </div>
                <p className="text-xs line-clamp-3 text-muted-foreground italic whitespace-pre-line">{t.body_template}</p>
                <p className="text-xs text-muted-foreground">
                  Firma: {t.signature_name ? `${t.signature_name}${t.signature_title ? ` · ${t.signature_title}` : ''}` : <span className="text-amber-700">sin nombre de quien firma</span>}
                  {t.signature_image_url ? ' · con imagen' : ''}
                </p>
                <div className="flex flex-wrap items-center justify-end gap-1 pt-1">
                  <Button size="sm" variant="ghost" onClick={() => verPrevia(t)} disabled={previewing} className="gap-1">
                    <Eye className="h-3.5 w-3.5" /> Vista previa
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setActive(t, !t.active)}>
                    {t.active ? 'Desactivar' : 'Activar'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing({ ...t })}>Editar</Button>
                  <Button size="sm" variant="ghost" onClick={() => setToDelete(t)} className="text-red-600" aria-label={`Eliminar ${t.name}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Editor */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-4xl max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Editar plantilla' : 'Nueva plantilla'}</DialogTitle>
            <DialogDescription>
              Escribe el texto como quieres que salga y toca una variable para ponerla donde está el cursor.
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-5">
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="tpl-nombre">Nombre (lo ve la familia al pedirla)</Label>
                    <Input id="tpl-nombre" value={editing.name} onChange={(e) => patch({ name: e.target.value })} />
                  </div>
                  <div>
                    <Label>Tipo</Label>
                    <Select value={editing.kind} onValueChange={(v) => patch({ kind: v as TipoConstancia })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIPOS_CONSTANCIA.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div>
                  <Label htmlFor="tpl-titulo">Título del documento</Label>
                  <Input id="tpl-titulo" value={editing.title} onChange={(e) => patch({ title: e.target.value })} />
                </div>

                <div>
                  <Label htmlFor="tpl-cuerpo">Texto</Label>
                  <Textarea
                    id="tpl-cuerpo"
                    ref={bodyRef}
                    className="min-h-52 text-sm leading-relaxed"
                    value={editing.body_template}
                    onChange={(e) => patch({ body_template: e.target.value })}
                  />
                  {desconocidas.length > 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      Estas variables no existen y saldrán vacías: {desconocidas.map((d) => `{{${d}}}`).join(', ')}.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    Si la ficha del deportista no tiene un dato (por ejemplo el documento), ese espacio sale vacío: al emitir te avisamos cuál faltó.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="tpl-firma-nombre">Quién firma — nombre</Label>
                    <Input id="tpl-firma-nombre" value={editing.signature_name ?? ''} onChange={(e) => patch({ signature_name: e.target.value })} />
                  </div>
                  <div>
                    <Label htmlFor="tpl-firma-cargo">Quién firma — cargo</Label>
                    <Input id="tpl-firma-cargo" value={editing.signature_title ?? ''} onChange={(e) => patch({ signature_title: e.target.value })} />
                  </div>
                </div>

                <div>
                  <Label className="mb-2 block">Imagen de la firma (opcional)</Label>
                  <div className="flex items-center gap-3">
                    <ImageUpload
                      value={editing.signature_image_url ?? null}
                      onChange={(url) => patch({ signature_image_url: url })}
                      onRemove={() => patch({ signature_image_url: null })}
                      bucket="school-assets"
                      path={`logos/${schoolId}`}
                      accept="image/png,image/jpeg,image/webp"
                      compact
                      hideHint
                    />
                    <p className="text-xs text-muted-foreground">
                      Una foto de la firma sobre papel blanco, recortada, o un PNG con fondo transparente. Va encima de la línea.
                    </p>
                  </div>
                </div>

                <div>
                  <Label htmlFor="tpl-pie">Pie de página</Label>
                  <Input id="tpl-pie" value={editing.footer_text ?? ''} onChange={(e) => patch({ footer_text: e.target.value })} />
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 pt-1">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={editing.active} onCheckedChange={(v) => patch({ active: v })} />
                    Activa: las familias pueden pedirla
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={editing.is_default} onCheckedChange={(v) => patch({ is_default: v })} />
                    Predeterminada para «{etiquetaTipo(editing.kind)}»
                  </label>
                </div>
              </div>

              <aside className="space-y-3 rounded-xl border bg-muted/30 p-3 h-fit">
                <p className="text-sm font-semibold">Variables</p>
                {GRUPOS.map((g) => (
                  <div key={g} className="space-y-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {VARIABLES_CONSTANCIA.filter((v) => v.grupo === g).map((v) => (
                        <button
                          key={v.clave}
                          type="button"
                          onClick={() => insertar(v.clave)}
                          title={`{{${v.clave}}}`}
                          className="rounded-full border bg-background px-2.5 py-1 text-xs hover:border-primary hover:text-primary"
                        >
                          {v.etiqueta}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </aside>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => editing && verPrevia(editing)} disabled={previewing || !editing} className="gap-2 sm:mr-auto">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              Vista previa
            </Button>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button onClick={save} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Vista previa del PDF */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Vista previa</DialogTitle>
            <DialogDescription>Con datos de ejemplo. Así sale el PDF que descarga la familia.</DialogDescription>
          </DialogHeader>
          {preview?.aviso && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{preview.aviso}</p>}
          {preview && (
            <>
              <iframe title="Vista previa de la constancia" src={preview.url} className="h-[70dvh] w-full rounded-lg border" />
              <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-primary">
                Abrir en otra pestaña
              </a>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Eliminar */}
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar «{toDelete?.name}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Las familias dejan de verla. Si ya emitiste constancias con ella no se puede borrar: en ese caso te ofrecemos desactivarla.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">Eliminar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Ya tiene constancias: desactivar en vez de borrar */}
      <AlertDialog open={!!inUse} onOpenChange={(o) => !o && setInUse(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Esta plantilla ya se usó</AlertDialogTitle>
            <AlertDialogDescription>
              Hay constancias emitidas con «{inUse?.name}» y deben poder seguir verificándose, así que no se puede borrar.
              Desactívala: las familias dejan de verla y las constancias emitidas siguen válidas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Dejarla así</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const t = inUse; setInUse(null); if (t) void setActive(t, false); }}>
              Desactivar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
