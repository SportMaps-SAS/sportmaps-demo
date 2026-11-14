import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Loader2, Settings, Plus, Pencil, ArrowLeft, Smartphone, Share2 } from 'lucide-react';
import { useTrialClasses, type TrialClassCategory } from '@/hooks/useTrialClasses';
import { useTrialClassSelfServiceSettings, type TrialPaymentMode } from '@/hooks/useTrialClassesSelf';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { supabase } from '@/integrations/supabase/client';
import { ShareTrialLinkDialog } from '@/components/school/ShareTrialLinkDialog';
import { CanalesClasePrueba } from '@/components/school/CanalesClasePrueba';

export interface TrialClassSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type CategoryForm = {
  id?: string;
  name: string;
  description: string;
  price: string;
  is_active: boolean;
  allow_repeat: boolean;
  repeat_price: string;
};

const EMPTY_FORM: CategoryForm = { name: '', description: '', price: '0', is_active: true, allow_repeat: false, repeat_price: '' };

export function TrialClassSettingsModal({ open, onOpenChange }: TrialClassSettingsModalProps) {
  const {
    categories, isLoadingCategories,
    createCategory, isCreatingCategory,
    updateCategory, isUpdatingCategory,
    setCategoryActive,
    setCategoryRepeatPricing, isSavingRepeatPricing,
  } = useTrialClasses();

  const { settings: ssSettings, saveSettings: saveSsSettings, isSaving: isSavingSs } = useTrialClassSelfServiceSettings();
  const { schoolId, schoolName } = useSchoolContext();

  const [form, setForm] = useState<CategoryForm | null>(null);
  const [schoolSlug, setSchoolSlug] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    if (!schoolId) return;
    (supabase.from('schools') as any)
      .select('slug')
      .eq('id', schoolId)
      .maybeSingle()
      .then(({ data }: any) => { if (data?.slug) setSchoolSlug(data.slug); });
  }, [schoolId]);

  const trialPublicUrl = schoolSlug ? `${window.location.origin}/agendar-clase/${schoolSlug}` : '';

  // Borrador del self-service — separado de la config del owner (arriba) a
  // propósito: son dos endpoints/RPCs distintas (spec §4.1). El precio de
  // repetición vive por CATEGORÍA (ver form de categoría abajo), no acá.
  const [ssForm, setSsForm] = useState({
    self_service_enabled: false,
    reschedule_cutoff_hours: 12,
    payment_mode: 'en_sede' as TrialPaymentMode,
  });

  useEffect(() => {
    if (!ssSettings) return;
    setSsForm({
      self_service_enabled: ssSettings.self_service_enabled,
      reschedule_cutoff_hours: ssSettings.reschedule_cutoff_hours,
      payment_mode: ssSettings.payment_mode,
    });
  }, [ssSettings]);

  const handleSaveSelfService = () => {
    saveSsSettings({
      self_service_enabled: ssForm.self_service_enabled,
      reschedule_cutoff_hours: ssForm.reschedule_cutoff_hours,
      payment_mode: ssForm.payment_mode,
    });
  };

  const openNewCategory = () => setForm(EMPTY_FORM);
  const openEditCategory = (c: TrialClassCategory) => setForm({
    id: c.id, name: c.name, description: c.description ?? '', price: String(c.price), is_active: c.is_active,
    allow_repeat: c.allow_repeat, repeat_price: c.repeat_price != null ? String(c.repeat_price) : '',
  });

  const handleSaveCategory = async () => {
    if (!form) return;
    const price = Number(form.price);
    if (!form.name.trim() || Number.isNaN(price) || price < 0) return;
    if (form.allow_repeat && form.repeat_price.trim() === '') return;

    const payload = { name: form.name.trim(), description: form.description.trim() || undefined, price, is_active: form.is_active };
    let categoryId = form.id;
    if (categoryId) {
      await updateCategory({ id: categoryId, ...payload });
    } else {
      const created = await createCategory(payload);
      categoryId = created.id;
    }

    // Precio de repetición: RPC/endpoint aparte (trial_class_category_set_repeat_pricing),
    // separado del upsert de la categoría — igual patrón "hermano pero separado" del resto del repo.
    if (categoryId) {
      await setCategoryRepeatPricing({
        id: categoryId,
        allow_repeat: form.allow_repeat,
        repeat_price: form.allow_repeat ? Number(form.repeat_price) : null,
      });
    }
    setForm(null);
  };

  const isSavingCategory = isCreatingCategory || isUpdatingCategory || isSavingRepeatPricing;

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setForm(null); }}>
      <DialogContent className="sm:max-w-xl bg-card text-card-foreground border-border/40 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            {form && (
              <Button variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={() => setForm(null)}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <Settings className="h-5 w-5 text-primary" />
            {form ? (form.id ? 'Editar categoría' : 'Nueva categoría') : 'Clases de Prueba'}
          </DialogTitle>
          {!form && (
            <DialogDescription className="text-muted-foreground/80">
              Todo lo de clases de prueba en un solo lugar: por dónde entran (en la escuela, WhatsApp, link) y qué categorías se ofrecen.
            </DialogDescription>
          )}
        </DialogHeader>

        {!form ? (
          <div className="space-y-6 py-2">
            {/* Interruptor general + canales (en la escuela, WhatsApp): configuración única. */}
            <CanalesClasePrueba schoolId={schoolId} />

            <div className="space-y-4 rounded-xl border border-border/50 bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-primary" />
                  <div>
                    <p className="font-semibold text-sm">Link público y Mis Inscripciones</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Cualquier persona agenda sola su clase de prueba por el link, o desde Mis Inscripciones si ya tiene cuenta.
                    </p>
                  </div>
                </div>
                <Switch
                  checked={ssForm.self_service_enabled}
                  onCheckedChange={(v) => setSsForm({ ...ssForm, self_service_enabled: v })}
                />
              </div>

              {ssForm.self_service_enabled && (
                <div className="space-y-4 pt-1 border-t border-border/40">
                  <div className="space-y-2 pt-3">
                    <Label className="text-xs font-semibold tracking-tight">Ventana para reprogramar solo (horas antes de la clase)</Label>
                    <Input
                      type="number" min={0} max={240}
                      value={ssForm.reschedule_cutoff_hours}
                      onChange={(e) => setSsForm({ ...ssForm, reschedule_cutoff_hours: Number(e.target.value) || 0 })}
                      className="bg-background border-border/50 h-9 w-28"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Pasado ese punto, la familia tiene que coordinar el cambio directamente con la escuela.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs font-semibold tracking-tight">Cómo se cobra</Label>
                    <RadioGroup
                      value={ssForm.payment_mode}
                      onValueChange={(v) => setSsForm({ ...ssForm, payment_mode: v as TrialPaymentMode })}
                      className="space-y-1.5"
                    >
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <RadioGroupItem value="en_sede" className="mt-0.5" />
                        <span><strong>En sede</strong> — nada se cobra en la app, se coordina en persona (igual que hoy).</span>
                      </label>
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <RadioGroupItem value="manual" className="mt-0.5" />
                        <span><strong>Manual</strong> — nace un cobro pendiente, se concilia igual que una mensualidad.</span>
                      </label>
                      <label className="flex items-start gap-2 text-xs cursor-pointer">
                        <RadioGroupItem value="gateway" className="mt-0.5" />
                        <span><strong>Pasarela</strong> — cobro online al agendar (necesita pasarela conectada).</span>
                      </label>
                    </RadioGroup>
                  </div>

                  <p className="text-[11px] text-muted-foreground bg-background/60 rounded-lg p-2.5 border border-border/40">
                    ¿Permitir repetir y a qué precio? Eso se configura <strong>por categoría</strong>, no aquí: abre cada categoría abajo.
                  </p>

                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveSelfService} disabled={isSavingSs} className="font-bold h-8">
                      {isSavingSs && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                      Guardar cambios
                    </Button>
                    {ssSettings?.self_service_enabled && (
                      <Button size="sm" variant="outline" onClick={() => setShareOpen(true)} disabled={!schoolSlug} className="h-8 font-semibold border-border/50 gap-1.5">
                        <Share2 className="h-3.5 w-3.5" /> Compartir link
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {!ssForm.self_service_enabled && (
                <Button size="sm" variant="outline" onClick={handleSaveSelfService} disabled={isSavingSs} className="h-8 font-semibold border-border/50">
                  {isSavingSs && <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />}
                  Guardar
                </Button>
              )}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold tracking-tight">Categorías</Label>
                <Button size="sm" variant="outline" className="h-8 font-semibold border-border/50" onClick={openNewCategory}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> Nueva categoría
                </Button>
              </div>

              {isLoadingCategories ? (
                <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
              ) : categories.length === 0 ? (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  Aún no hay categorías. Crea la primera para poder agendar clases de prueba.
                </p>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {categories.map((c) => (
                    <div key={c.id} className="flex items-start justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 p-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm truncate">{c.name}</p>
                          {!c.is_active && <Badge variant="outline" className="text-[10px] py-0 text-muted-foreground">Inactiva</Badge>}
                        </div>
                        {c.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{c.description}</p>}
                        <p className="text-xs font-bold text-emerald-600 dark:text-emerald-500 mt-1">
                          {c.price > 0 ? `$${c.price.toLocaleString('es-CO')} COP` : 'Sin costo'}
                        </p>
                        {c.allow_repeat && (
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            Repetir: ${(c.repeat_price ?? 0).toLocaleString('es-CO')} COP
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Switch checked={c.is_active} onCheckedChange={(v) => setCategoryActive({ id: c.id, is_active: v })} />
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditCategory(c)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5 py-2">
            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">Nombre</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ej. Clase individual"
                className="bg-muted/30 border-border/50 h-11"
              />
            </div>
            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">Descripción</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Se muestra al owner cuando elige esta categoría al agendar."
                className="bg-muted/30 border-border/50 min-h-20"
              />
            </div>
            <div className="space-y-3">
              <Label className="text-sm font-semibold tracking-tight">Precio (COP)</Label>
              <div className="flex items-center border border-border/50 rounded-md h-11 bg-muted/30 overflow-hidden relative">
                <span className="absolute left-3 text-muted-foreground font-medium z-10 pointer-events-none">$</span>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={form.price && form.price !== '0' ? Number(form.price).toLocaleString('es-CO') : ''}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '');
                    setForm({ ...form, price: digits === '' ? '0' : digits });
                  }}
                  placeholder="0"
                  className="border-0 bg-transparent pl-7 h-full focus-visible:ring-0"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                $0 = sin costo. El cobro se coordina con el prospecto por fuera del sistema.
              </p>
            </div>

            <div className="space-y-3 rounded-xl border border-border/50 bg-muted/20 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-sm">Permitir repetir esta prueba</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Solo desde Mis Inscripciones. Sin tope de veces — cada vez que no sea la primera, se cobra este precio.
                  </p>
                </div>
                <Switch checked={form.allow_repeat} onCheckedChange={(v) => setForm({ ...form, allow_repeat: v })} />
              </div>
              {form.allow_repeat && (
                <div className="space-y-2">
                  <Label className="text-xs font-semibold tracking-tight">Precio de repetición (COP)</Label>
                  <div className="flex items-center border border-border/50 rounded-md h-10 bg-background overflow-hidden relative w-40">
                    <span className="absolute left-3 text-muted-foreground font-medium z-10 pointer-events-none text-xs">$</span>
                    <Input
                      type="text" inputMode="numeric"
                      value={form.repeat_price ? Number(form.repeat_price).toLocaleString('es-CO') : ''}
                      onChange={(e) => setForm({ ...form, repeat_price: e.target.value.replace(/\D/g, '') })}
                      placeholder="0"
                      className="border-0 bg-transparent pl-6 h-full text-xs focus-visible:ring-0"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between rounded-xl border border-border/50 bg-muted/30 p-4">
              <p className="font-semibold text-sm">Activa</p>
              <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
            </div>
          </div>
        )}

        <DialogFooter>
          {form ? (
            <>
              <Button variant="outline" onClick={() => setForm(null)} className="font-medium border-border/50">Atrás</Button>
              <Button onClick={handleSaveCategory} disabled={isSavingCategory || !form.name.trim()} className="font-bold">
                {isSavingCategory && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Guardar categoría
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} className="font-medium border-border/50">Cerrar</Button>
          )}
        </DialogFooter>
      </DialogContent>

      {trialPublicUrl && (
        <ShareTrialLinkDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          publicUrl={trialPublicUrl}
          schoolName={schoolName || 'tu escuela'}
        />
      )}
    </Dialog>
  );
}
