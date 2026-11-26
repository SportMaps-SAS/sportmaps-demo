import { useEffect, useRef, useState } from 'react';
import { Loader2, Plus, QrCode, Save, Trash2, Download, ExternalLink, BarChart3, FileImage, FileCode2, FileText } from 'lucide-react';
import { QRCodeSVG, QRCodeCanvas } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import { VolverCarnetsV2 } from '@/components/school/carnets-v2/VolverCarnetsV2';

type QrRow = {
  id: string;
  slug: string;
  name: string;
  target_type: 'open' | 'team' | 'branch' | 'plan';
  target_id: string | null;
  target_name?: string | null;
  intro_text: string | null;
  cta_text: string;
  accept_payments: boolean;
  require_first_payment: boolean;
  active: boolean;
  expires_at: string | null;
  scan_count: number;
  signup_count: number;
  paid_count: number;
  created_at: string;
  updated_at: string;
  branch_id: string | null;
  branch_name?: string | null;
  fixed_amount?: number | null;
};

type Team = { id: string; name: string };
type Branch = { id: string; name: string };
type Plan = {
  id: string;
  name: string;
  price: number;
  billing_period: string;
  sessions_included: number | null;
};
type BusinessModel = 'teams' | 'plans' | 'both';

const FORM_DEFAULT = {
  name: '',
  target_type: 'open' as QrRow['target_type'],
  target_id: '',
  branch_id: '',
  intro_text: '',
  cta_text: 'Inscribir a mi hijo/a',
  accept_payments: true,
  require_first_payment: true,
  expires_at: '',
  slug: '',
  fixed_amount: '',
};

const fmtCOP = (n: number) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

const planLabel = (p: Plan) => {
  const period = ({ weekly: 'sem', biweekly: 'quinc', monthly: 'mes', quarterly: 'trim', yearly: 'año' } as Record<string, string>)[p.billing_period] || p.billing_period;
  const sessions = p.sessions_included == null ? 'ilimitado' : `${p.sessions_included} sesiones`;
  return `${p.name} · ${fmtCOP(p.price)}/${period} · ${sessions}`;
};

export default function SchoolJoinQRsPage() {
  const { schoolId } = useSchoolContext();
  const { toast } = useToast();

  const [rows, setRows] = useState<QrRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(FORM_DEFAULT);
  const [saving, setSaving] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [businessModel, setBusinessModel] = useState<BusinessModel>('teams');
  const [previewQr, setPreviewQr] = useState<QrRow | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement>(null);
  const exportSvgRef = useRef<SVGSVGElement>(null);
  const [schoolLogo, setSchoolLogo] = useState<string | null>(null);

  useEffect(() => {
    if (!schoolId) return;
    void load();
    void loadOptions();
    // Logo de la escuela para incrustarlo en el centro del QR (branding).
    supabase.from('schools').select('logo_url').eq('id', schoolId).single()
      .then(({ data }) => setSchoolLogo((data as any)?.logo_url ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  // Logo centrado en el QR. Nivel H (30% corrección) tolera el overlay.
  // crossOrigin para no "tintar" el canvas y poder exportar PNG.
  const logoSettings = (size: number) =>
    schoolLogo
      ? { src: schoolLogo, height: Math.round(size * 0.22), width: Math.round(size * 0.22), excavate: true, crossOrigin: 'anonymous' as const }
      : undefined;

  async function load() {
    if (!schoolId) return;
    setLoading(true);
    const { data, error } = await supabase.rpc('list_school_join_qrs' as any, {
      p_school_id: schoolId,
      p_active: null,
      p_search: null,
    });
    setLoading(false);
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      return;
    }
    setRows((data as QrRow[]) || []);
  }

  async function loadOptions() {
    if (!schoolId) return;
    const [{ data: t }, { data: b }, { data: sch }, { data: pl }] = await Promise.all([
      supabase.from('teams').select('id, name').eq('school_id', schoolId).order('name'),
      supabase.from('school_branches').select('id, name').eq('school_id', schoolId).order('name'),
      supabase.from('schools').select('business_model').eq('id', schoolId).single(),
      supabase.rpc('list_school_plans' as any, { p_school_id: schoolId }),
    ]);
    setTeams((t as Team[]) || []);
    setBranches((b as Branch[]) || []);
    setBusinessModel(((sch as any)?.business_model as BusinessModel) || 'teams');
    setPlans((pl as Plan[]) || []);
  }

  function startNew() {
    setForm(FORM_DEFAULT);
    setOpen(true);
  }

  async function save() {
    if (!schoolId) {
      toast({ title: 'Falta escuela activa', description: 'No hay schoolId en contexto.', variant: 'destructive' });
      return;
    }
    if (!form.name.trim()) {
      toast({ title: 'Nombre requerido', description: 'Ingresa un nombre interno para el QR.', variant: 'destructive' });
      return;
    }
    if ((form.target_type === 'team' || form.target_type === 'branch' || form.target_type === 'plan') && !form.target_id) {
      toast({
        title: form.target_type === 'team' ? 'Equipo requerido' : form.target_type === 'plan' ? 'Plan requerido' : 'Sede requerida',
        description: 'Selecciona la opción específica o cambia a tipo "Abierto".',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    const payload = {
      p_school_id:   schoolId,
      p_name:        form.name.trim(),
      p_target_type: form.target_type,
      p_target_id:   form.target_id || null,
      p_branch_id:   form.branch_id || null,
      p_intro_text:  form.intro_text || null,
      p_cta_text:    form.cta_text?.trim() || 'Inscribir a mi hijo/a',
      p_accept_payments: form.accept_payments,
      p_require_first_payment: form.require_first_payment,
      p_expires_at:  form.expires_at ? new Date(form.expires_at).toISOString() : null,
      p_slug:        form.slug?.trim() || null,
      p_fixed_amount: form.fixed_amount ? Number(form.fixed_amount) : null,
    };
    const { data, error } = await supabase.rpc('create_school_join_qr' as any, payload);
    setSaving(false);
    if (error) {
      console.error('[create_school_join_qr] failed', { payload, error });
      const msg = [error.message, error.details, error.hint].filter(Boolean).join(' — ');
      toast({ title: 'No se pudo crear el QR', description: msg || 'Error desconocido', variant: 'destructive' });
      return;
    }
    console.log('[create_school_join_qr] ok', data);
    toast({ title: 'QR creado', description: (data as any)?.slug ? `Slug: ${(data as any).slug}` : undefined });
    setOpen(false);
    await load();
  }

  async function toggleActive(qr: QrRow) {
    const { error } = await supabase
      .from('school_join_qr_codes' as any)
      .update({ active: !qr.active })
      .eq('id', qr.id);
    if (error) return toast({ title: 'Error', description: error.message, variant: 'destructive' });
    toast({ title: !qr.active ? 'QR activado' : 'QR desactivado' });
    await load();
  }

  async function remove(qr: QrRow) {
    if (!window.confirm(`¿Eliminar el QR "${qr.name}"?`)) return;
    const { error } = await supabase.from('school_join_qr_codes' as any).delete().eq('id', qr.id);
    if (error) return toast({ title: 'Error', description: error.message, variant: 'destructive' });
    toast({ title: 'QR eliminado' });
    await load();
  }

  function triggerDownload(blob: Blob, filename: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // PNG 1024×1024 con margen — formato ideal para flyers/Instagram/WhatsApp.
  function downloadPng(qr: QrRow) {
    try {
      const canvas = exportCanvasRef.current;
      if (!canvas) {
        toast({ title: 'Abre primero "Ver QR"', description: 'Necesito renderizar el QR para exportarlo.', variant: 'destructive' });
        return;
      }
      canvas.toBlob((blob) => {
        if (!blob) {
          toast({ title: 'No se pudo generar PNG', variant: 'destructive' });
          return;
        }
        triggerDownload(blob, `${qr.slug}-qr-1024.png`);
      }, 'image/png');
    } catch (e: any) {
      console.error('[downloadPng] failed', e);
      toast({ title: 'No se pudo generar PNG', description: e?.message || 'Error', variant: 'destructive' });
    }
  }

  // SVG vectorial — escala a cualquier tamaño sin pérdida (mejor para impresión grande).
  function downloadSvg(qr: QrRow) {
    try {
      const svg = exportSvgRef.current;
      if (!svg) {
        toast({ title: 'Abre primero "Ver QR"', description: 'Necesito renderizar el QR para exportarlo.', variant: 'destructive' });
        return;
      }
      const clone = svg.cloneNode(true) as SVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const svgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      triggerDownload(blob, `${qr.slug}-qr.svg`);
    } catch (e: any) {
      console.error('[downloadSvg] failed', e);
      toast({ title: 'No se pudo generar SVG', description: e?.message || 'Error', variant: 'destructive' });
    }
  }

  async function downloadPoster(qr: QrRow) {
    try {
      // BffClient.get retorna parsed JSON; el endpoint devuelve PDF binario.
      // Hacemos fetch directo via JWT del usuario.
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error('No session');
      const url = (import.meta.env.VITE_BFF_URL || 'https://sportmaps-bff-prod.onrender.com') + `/api/v1/join-qr/${qr.slug}/poster.pdf`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'x-school-id': schoolId || '' },
      });
      if (!r.ok) throw new Error(await r.text());
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${qr.slug}-poster.pdf`;
      a.click();
    } catch (e: any) {
      toast({ title: 'No se pudo descargar', description: e?.message || 'Error', variant: 'destructive' });
    }
  }

  function publicUrl(qr: QrRow): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/join/${qr.slug}`;
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <VolverCarnetsV2 />
      <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <QrCode className="h-7 w-7 text-primary" />
            Códigos QR de inscripción (menores)
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Genera códigos para imprimir en flyers/posters. Cada escaneo lleva al <strong>acudiente</strong> a
            tu landing branded para registrar a un <strong>menor de edad</strong> y pagar el primer mes.
            Para atletas mayores de edad usa Invitaciones → Atleta.
          </p>
        </div>
        <Button onClick={startNew} className="gap-2">
          <Plus className="h-4 w-4" />
          Nuevo QR
        </Button>
      </header>

      <Card>
        <CardHeader><CardTitle>Mis códigos</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-12 flex justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">Aún no creas códigos.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {rows.map((qr) => (
                <Card key={qr.id} className="border-2">
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="font-bold">{qr.name}</p>
                        <p className="text-xs text-muted-foreground">{qr.slug}</p>
                      </div>
                      <div className="flex flex-col gap-1 items-end">
                        {qr.active ? <Badge className="bg-green-100 text-green-700">Activo</Badge> : <Badge variant="outline">Pausado</Badge>}
                        {qr.expires_at && new Date(qr.expires_at) < new Date() && (
                          <Badge variant="destructive">Expirado</Badge>
                        )}
                      </div>
                    </div>

                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>Target: <span className="capitalize">{qr.target_type}</span>{qr.target_name ? ` · ${qr.target_name}` : ''}</p>
                      {qr.branch_name && <p>Sede: {qr.branch_name}</p>}
                      {qr.fixed_amount != null && <p className="text-amber-600 font-medium">Promo: {fmtCOP(qr.fixed_amount)}</p>}
                      <p>Pago primer mes: {qr.require_first_payment ? 'Sí' : 'No'}</p>
                    </div>

                    <div className="flex justify-around text-center border-t border-b py-2">
                      <div>
                        <p className="text-lg font-bold">{qr.scan_count}</p>
                        <p className="text-[10px] uppercase text-muted-foreground">Scans</p>
                      </div>
                      <div>
                        <p className="text-lg font-bold">{qr.signup_count}</p>
                        <p className="text-[10px] uppercase text-muted-foreground">Inscritos</p>
                      </div>
                      <div>
                        <p className="text-lg font-bold text-green-600">{qr.paid_count}</p>
                        <p className="text-[10px] uppercase text-muted-foreground">Pagaron</p>
                      </div>
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => setPreviewQr(qr)} className="gap-1">
                        <QrCode className="h-3.5 w-3.5" />
                        Ver QR
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => downloadPoster(qr)} className="gap-1">
                        <Download className="h-3.5 w-3.5" />
                        Poster PDF
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => window.open(publicUrl(qr), '_blank')} className="gap-1">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(qr)}>
                        {qr.active ? 'Pausar' : 'Activar'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(qr)} className="text-red-600 ml-auto">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* New QR dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Nuevo código QR</DialogTitle>
            <DialogDescription>Crea un código para una campaña, equipo o sede específica.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900">
              Quien escanea queda registrado como <strong>acudiente</strong> y el atleta como <strong>menor a su cargo</strong>.
              Si el atleta es mayor de edad y se registra solo, invítalo desde <strong>Invitaciones → Atleta</strong>;
              por el QR quedaría como hijo de sí mismo.
            </div>
            <div>
              <Label>Nombre interno *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ej: Flyer Plaza Mayor"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Tipo</Label>
                <Select value={form.target_type} onValueChange={(v) => setForm({ ...form, target_type: v as any, target_id: '' })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">
                      {teams.length > 0 && plans.length > 0 ? 'Abierto (equipos y planes)' : plans.length > 0 ? 'Abierto (cualquier plan)' : 'Abierto (cualquier equipo)'}
                    </SelectItem>
                    {teams.length > 0 && (
                      <SelectItem value="team">Equipo específico</SelectItem>
                    )}
                    {plans.length > 0 && (
                      <SelectItem value="plan">Plan específico</SelectItem>
                    )}
                    <SelectItem value="branch">Sede específica</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.target_type === 'team' && (
                <div>
                  <Label>Equipo</Label>
                  <Select value={form.target_id} onValueChange={(v) => setForm({ ...form, target_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Elige" /></SelectTrigger>
                    <SelectContent>
                      {teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.target_type === 'plan' && (
                <div>
                  <Label>Plan</Label>
                  <Select value={form.target_id} onValueChange={(v) => setForm({ ...form, target_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Elige" /></SelectTrigger>
                    <SelectContent>
                      {plans.length === 0 ? (
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">No tienes planes activos. Créalos en tu catálogo.</div>
                      ) : (
                        plans.map((p) => <SelectItem key={p.id} value={p.id}>{planLabel(p)}</SelectItem>)
                      )}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {form.target_type === 'branch' && (
                <div>
                  <Label>Sede</Label>
                  <Select value={form.target_id} onValueChange={(v) => setForm({ ...form, target_id: v, branch_id: v })}>
                    <SelectTrigger><SelectValue placeholder="Elige" /></SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <div>
              <Label>Monto fijo / promo (opcional)</Label>
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={form.fixed_amount}
                onChange={(e) => setForm({ ...form, fixed_amount: e.target.value })}
                placeholder="Ej: 50000 — sobrescribe el precio del equipo/plan"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Déjalo vacío para usar el precio del {businessModel === 'plans' ? 'plan' : 'equipo/plan'}. Úsalo solo para campañas u ofertas puntuales.
              </p>
            </div>
            <div>
              <Label>Texto introductorio</Label>
              <Textarea
                value={form.intro_text}
                onChange={(e) => setForm({ ...form, intro_text: e.target.value })}
                placeholder="Bienvenido a nuestra escuela…"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Texto del botón</Label>
                <Input
                  value={form.cta_text}
                  onChange={(e) => setForm({ ...form, cta_text: e.target.value })}
                  placeholder="Ej: Inscribir a mi hijo/a"
                />
              </div>
              <div>
                <Label>Slug personalizado</Label>
                <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="(auto)" />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Switch checked={form.require_first_payment} onCheckedChange={(v) => setForm({ ...form, require_first_payment: v })} />
                <Label>Exigir primer pago al inscribirse</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.accept_payments} onCheckedChange={(v) => setForm({ ...form, accept_payments: v })} />
                <Label>Aceptar pagos online</Label>
              </div>
            </div>
            <div>
              <Label>Vence el (opcional)</Label>
              <Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save} disabled={saving || !form.name} className="gap-2">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview QR */}
      <Dialog open={!!previewQr} onOpenChange={(o) => !o && setPreviewQr(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{previewQr?.name}</DialogTitle>
            <DialogDescription className="break-all">{previewQr ? publicUrl(previewQr) : ''}</DialogDescription>
          </DialogHeader>
          {previewQr && (
            <>
              <div ref={previewRef} className="flex flex-col items-center gap-3 bg-white p-4 rounded border">
                <QRCodeSVG
                  value={publicUrl(previewQr)}
                  size={240}
                  level="H"
                  marginSize={4}
                  imageSettings={logoSettings(240)}
                />
                <p className="text-xs text-center text-muted-foreground break-all">{publicUrl(previewQr)}</p>
              </div>

              {/* Hidden hi-res renders usados para exportar PNG (1024px) y SVG vectorial */}
              <div className="hidden" aria-hidden="true">
                <QRCodeCanvas
                  ref={exportCanvasRef}
                  value={publicUrl(previewQr)}
                  size={1024}
                  level="H"
                  marginSize={4}
                  imageSettings={logoSettings(1024)}
                />
                <QRCodeSVG
                  ref={exportSvgRef}
                  value={publicUrl(previewQr)}
                  size={1024}
                  level="H"
                  marginSize={4}
                  imageSettings={logoSettings(1024)}
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <Button variant="outline" onClick={() => downloadPng(previewQr)} className="gap-1 text-xs" title="PNG 1024px — ideal flyers/redes">
                  <FileImage className="h-4 w-4" />
                  PNG
                </Button>
                <Button variant="outline" onClick={() => downloadSvg(previewQr)} className="gap-1 text-xs" title="SVG vectorial — imprime a cualquier tamaño">
                  <FileCode2 className="h-4 w-4" />
                  SVG
                </Button>
                <Button variant="outline" onClick={() => downloadPoster(previewQr)} className="gap-1 text-xs" title="Poster A4 listo para imprimir">
                  <FileText className="h-4 w-4" />
                  Poster
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground text-center">
                PNG sirve para WhatsApp/Instagram. SVG es el mejor para impresión grande sin perder calidad.
              </p>
            </>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => previewQr && window.open(publicUrl(previewQr), '_blank')} className="gap-1">
              <ExternalLink className="h-4 w-4" />
              Abrir landing
            </Button>
            <Button variant="ghost" onClick={() => { if (previewQr) { navigator.clipboard.writeText(publicUrl(previewQr)); toast({ title: 'Link copiado' }); } }} className="gap-1">
              Copiar link
            </Button>
          </DialogFooter>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 justify-center">
            <BarChart3 className="h-3 w-3" />
            {previewQr?.scan_count} scans · {previewQr?.signup_count} inscritos · {previewQr?.paid_count} pagaron
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
