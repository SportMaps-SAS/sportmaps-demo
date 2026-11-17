import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { Navigate } from 'react-router-dom';
import { getUserFriendlyError } from '@/lib/error-translator';
import {
  MessageSquare, Save, Loader2, Eye, RotateCcw, Bell,
  Clock, AlertTriangle, CheckCircle2, CreditCard, Hash
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────
interface Template {
  id: string;
  school_id: string | null;
  template_type: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  days_offset: number | null;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
}

interface TemplateVariable {
  key: string;
  label: string;
  description: string;
  applies_to: string[];
}

// ── Config ────────────────────────────────────────────────
const TYPE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  reminder_before: { label: 'Recordatorio Previo', icon: Clock, color: 'bg-blue-100 text-blue-700' },
  reminder_due:    { label: 'Día de Vencimiento', icon: Bell, color: 'bg-amber-100 text-amber-700' },
  overdue:         { label: 'Mora / Vencido', icon: AlertTriangle, color: 'bg-red-100 text-red-700' },
  payment_confirmed: { label: 'Pago Confirmado', icon: CheckCircle2, color: 'bg-emerald-100 text-emerald-700' },
  partial_received:  { label: 'Abono Recibido', icon: CreditCard, color: 'bg-purple-100 text-purple-700' },
  custom:          { label: 'Personalizado', icon: MessageSquare, color: 'bg-slate-100 text-slate-700' },
};

const TYPE_ORDER = ['reminder_before', 'reminder_due', 'overdue', 'payment_confirmed', 'partial_received', 'custom'];

// ── Component ─────────────────────────────────────────────
export default function MessageTemplatesPage() {
  const { profile } = useAuth();
  const { schoolId, currentUserRole } = useSchoolContext();
  const { toast } = useToast();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  // Editor state
  const [editing, setEditing] = useState<Template | null>(null);
  const [editBody, setEditBody] = useState('');
  const [previewMode, setPreviewMode] = useState(false);

  // ── Data fetching ─────────────────────────────────────────
  useEffect(() => {
    if (schoolId) loadData();
  }, [schoolId]);

  // ── Auth gate ─────────────────────────────────────────────
  const isAuthorized = profile && (
    ['school', 'admin', 'school_admin', 'super_admin'].includes(profile.role) ||
    ['owner', 'admin', 'school_admin', 'super_admin'].includes(currentUserRole || '')
  );
  if (!isAuthorized) return <Navigate to="/dashboard" replace />;

  const loadData = async () => {
    setLoading(true);
    try {
      // Load templates: school-specific + defaults (school_id IS NULL)
      const { data: tpl, error: tplErr } = await (supabase as any)
        .from('payment_message_templates')
        .select('*')
        .or(`school_id.eq.${schoolId},school_id.is.null`)
        .order('sort_order', { ascending: true });

      if (tplErr) throw tplErr;

      // Load template variables
      const { data: vars, error: varErr } = await (supabase as any)
        .from('template_variables')
        .select('*');

      if (varErr) throw varErr;

      // Merge: if school has a custom version, use it; else show the default
      const schoolTemplates = (tpl || []).filter((t: Template) => t.school_id === schoolId);
      const defaultTemplates = (tpl || []).filter((t: Template) => t.school_id === null);

      const merged: Template[] = [];
      for (const def of defaultTemplates) {
        const override = schoolTemplates.find(
          (s: Template) => s.template_type === def.template_type && s.channel === def.channel && s.name === def.name
        );
        merged.push(override || def);
      }
      // Add any school-only templates not matching a default
      for (const custom of schoolTemplates) {
        if (!merged.find(m => m.id === custom.id)) {
          merged.push(custom);
        }
      }

      setTemplates(merged);
      setVariables(vars || []);
    } catch (err) {
      toast({ title: 'Error', description: getUserFriendlyError(err), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  // ── Toggle active ─────────────────────────────────────────
  const handleToggle = async (template: Template, newActive: boolean) => {
    setSaving(template.id);
    try {
      if (template.school_id === null) {
        // Create school-specific copy with the new state
        const { id: _, created_at, updated_at, ...rest } = template as any;
        const { error } = await (supabase as any).from('payment_message_templates')
          .insert({ ...rest, school_id: schoolId, is_active: newActive, is_default: false });
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from('payment_message_templates')
          .update({ is_active: newActive })
          .eq('id', template.id);
        if (error) throw error;
      }
      await loadData();
      toast({ title: newActive ? '✅ Plantilla activada' : '⏸️ Plantilla desactivada' });
    } catch (err) {
      toast({ title: 'Error', description: getUserFriendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  // ── Save body edit ────────────────────────────────────────
  const handleSaveBody = async () => {
    if (!editing) return;
    setSaving(editing.id);
    try {
      if (editing.school_id === null) {
        // Clone default -> school-specific
        const { id: _, created_at, updated_at, ...rest } = editing as any;
        const { error } = await (supabase as any).from('payment_message_templates')
          .insert({ ...rest, school_id: schoolId, body: editBody, is_default: false });
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from('payment_message_templates')
          .update({ body: editBody, updated_at: new Date().toISOString() })
          .eq('id', editing.id);
        if (error) throw error;
      }
      await loadData();
      setEditing(null);
      toast({ title: '✅ Plantilla guardada' });
    } catch (err) {
      toast({ title: 'Error', description: getUserFriendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  // ── Reset to default ──────────────────────────────────────
  const handleReset = async (template: Template) => {
    if (template.school_id === null) return; // Already default
    setSaving(template.id);
    try {
      const { error } = await (supabase as any).from('payment_message_templates')
        .delete()
        .eq('id', template.id);
      if (error) throw error;
      await loadData();
      toast({ title: '↩️ Plantilla restaurada a la versión original' });
    } catch (err) {
      toast({ title: 'Error', description: getUserFriendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  // ── Preview helper ────────────────────────────────────────
  const renderPreview = (body: string) => {
    let preview = body;
    const sampleValues: Record<string, string> = {
      '{{nombre_padre}}': 'Carlos Castañeda',
      '{{nombre_atleta}}': 'Santiago Castañeda',
      '{{nombre_escuela}}': 'NPC Academy',
      '{{monto}}': '$150.000',
      '{{monto_pendiente}}': '$75.000',
      '{{fecha_vencimiento}}': '10 de Abril, 2026',
      '{{dias_vencimiento}}': '3',
      '{{dias_mora}}': '5',
      '{{equipo}}': 'Taekwondo Avanzado',
      '{{plan}}': 'Plan Mensual',
      '{{banco}}': 'Bancolombia - Ahorros ****4321',
      '{{nequi}}': '300 123 4567',
      '{{link_pago}}': 'https://sportmaps.co/pago/abc123',
    };
    Object.entries(sampleValues).forEach(([k, v]) => {
      preview = preview.split(k).join(`**${v}**`);
    });
    return preview;
  };

  // ── Group templates by type ───────────────────────────────
  const grouped = TYPE_ORDER.map(type => ({
    type,
    config: TYPE_CONFIG[type] || TYPE_CONFIG.custom,
    templates: templates.filter(t => t.template_type === type),
  })).filter(g => g.templates.length > 0);

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden animate-in fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Plantillas de Mensajes</h1>
          <p className="text-muted-foreground text-sm">
            Personaliza los textos de cobro y recordatorio que envías a mano.
          </p>
        </div>
      </div>

      {/* Qué cambia y qué NO cambia esta pantalla (spec whatsapp-autoservicio F0, 2026-11-15). */}
      <div
        role="note"
        data-testid="aviso-alcance-plantillas"
        className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-sm"
      >
        <p className="font-medium">Estos textos solo cambian el enlace manual de WhatsApp y el correo.</p>
        <p className="text-muted-foreground mt-1">
          Sirven cuando envías un recordatorio a mano desde Recordatorios de pago. Los mensajes que WhatsApp
          envía solo (recordatorios automáticos de cobro, avisos de vencimiento) usan las plantillas aprobadas
          por Meta y <strong>no cambian aquí</strong>: se ven en{' '}
          <a href="/whatsapp?tab=plantillas" className="underline font-medium">WhatsApp › Plantillas</a>.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(({ type, config, templates: groupTpl }) => {
            const Icon = config.icon;
            return (
              <Card key={type}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                    <span className={`inline-flex items-center justify-center h-8 w-8 rounded-lg ${config.color}`}>
                      <Icon className="h-4 w-4" />
                    </span>
                    {config.label}
                  </CardTitle>
                  <CardDescription>
                    {groupTpl.length} plantilla{groupTpl.length !== 1 ? 's' : ''}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {groupTpl.map((tpl) => (
                    <div
                      key={tpl.id}
                      className={`border rounded-lg p-4 space-y-3 transition-colors ${
                        tpl.is_active ? 'bg-card' : 'bg-muted/30 opacity-60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-semibold text-sm truncate">{tpl.name}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {tpl.channel === 'whatsapp' ? '📱 WhatsApp' : '📧 Email'}
                          </Badge>
                          {tpl.school_id !== null && (
                            <Badge variant="secondary" className="text-[10px] shrink-0 bg-blue-50 text-blue-700">
                              Personalizada
                            </Badge>
                          )}
                          {tpl.days_offset !== null && (
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              <Hash className="h-2.5 w-2.5 mr-0.5" />
                              {tpl.days_offset > 0 ? `+${tpl.days_offset}d` : `${tpl.days_offset}d`}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {tpl.school_id !== null && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs text-muted-foreground"
                              onClick={() => handleReset(tpl)}
                              disabled={saving === tpl.id}
                            >
                              <RotateCcw className="h-3 w-3 mr-1" />
                              Restaurar
                            </Button>
                          )}
                          <Switch
                            checked={tpl.is_active}
                            onCheckedChange={(v) => handleToggle(tpl, v)}
                            disabled={saving === tpl.id}
                          />
                        </div>
                      </div>

                      {/* Body preview */}
                      <div className="bg-muted/50 rounded-md p-3 text-sm whitespace-pre-wrap font-mono text-xs leading-relaxed">
                        {tpl.body}
                      </div>

                      {/* Actions */}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            setEditing(tpl);
                            setEditBody(tpl.body);
                            setPreviewMode(false);
                          }}
                        >
                          <MessageSquare className="h-3 w-3 mr-1" />
                          Editar
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}

          {/* Available variables reference */}
          {variables.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Hash className="h-4 w-4" />
                  Variables Disponibles
                </CardTitle>
                <CardDescription>
                  Usa estas variables en tus plantillas para personalizar automáticamente los mensajes.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {variables.map((v) => (
                    <div key={v.key} className="flex items-start gap-2 p-2 rounded border bg-muted/30">
                      <code className="text-xs font-mono bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded shrink-0">
                        {v.key}
                      </code>
                      <div className="min-w-0">
                        <p className="text-xs font-medium">{v.label}</p>
                        <p className="text-[10px] text-muted-foreground">{v.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Edit Modal ────────────────────────────────────────── */}
      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="sm:max-w-modal max-h-sheet overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar Plantilla</DialogTitle>
            <DialogDescription>
              {editing?.name} — {editing?.channel === 'whatsapp' ? '📱 WhatsApp' : '📧 Email'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Tab toggle: edit / preview */}
            <div className="flex gap-2 border-b pb-2">
              <Button
                variant={!previewMode ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPreviewMode(false)}
              >
                <MessageSquare className="h-3 w-3 mr-1" />
                Editar
              </Button>
              <Button
                variant={previewMode ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPreviewMode(true)}
              >
                <Eye className="h-3 w-3 mr-1" />
                Vista Previa
              </Button>
            </div>

            {previewMode ? (
              <div className="bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 text-sm whitespace-pre-wrap leading-relaxed">
                {renderPreview(editBody)}
              </div>
            ) : (
              <>
                <div>
                  <Label className="text-sm font-semibold">Cuerpo del mensaje</Label>
                  <Textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={8}
                    className="font-mono text-xs mt-1"
                    placeholder="Escribe el mensaje..."
                  />
                </div>

                {/* Variables quick insert */}
                {editing && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">
                      Variables disponibles (clic para insertar):
                    </Label>
                    <div className="flex flex-wrap gap-1">
                      {variables
                        .filter(v => v.applies_to.includes(editing.template_type))
                        .map(v => (
                          <button
                            key={v.key}
                            type="button"
                            className="text-[10px] font-mono bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 px-2 py-1 rounded transition-colors"
                            onClick={() => setEditBody(prev => prev + v.key)}
                            title={v.description}
                          >
                            {v.key}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={handleSaveBody} disabled={saving === editing?.id}>
              {saving === editing?.id ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
