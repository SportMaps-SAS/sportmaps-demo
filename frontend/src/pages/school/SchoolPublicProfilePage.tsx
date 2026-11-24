import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  User, DollarSign, Phone, Eye, Save, Loader2, Upload, Plus, ExternalLink, Globe,
  MapPin, Mail, Building2, Trophy, Copy, Check, LayoutTemplate, Clock,
} from 'lucide-react';
import { PublishedSuccessModal } from '@/components/settings/PublishedSuccessModal';
import { PlanCard, type PlanFeature, type PlanDuration } from '@/components/explore/PlanCard';
import { useStorage } from '@/hooks/useStorage';
import { formatFriendlyDuration } from '@/lib/utils';
import type { BusinessHourRow } from '@/lib/api/schools';

const DAY_NAMES_FULL = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Horario por defecto al activar por primera vez — mismo aspecto que el respaldo fijo. */
function defaultBusinessHours(): BusinessHourRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    day,
    closed: day === 0,
    open: day === 0 ? null : day === 6 ? '09:00' : '08:00',
    close: day === 0 ? null : day === 6 ? '17:00' : '20:00',
  }));
}

interface SchoolRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  cover_image_url: string | null;
  sports: string[] | null;
  public_page_layout: PublicPageLayout | null;
}

type PublicPageLayout = 'classic' | 'modern' | 'minimal' | 'magazine';

const LAYOUT_OPTIONS: { key: PublicPageLayout; name: string; hint: string; available: boolean }[] = [
  { key: 'classic', name: 'Clásica', hint: 'Portada ancha + pestañas', available: true },
  { key: 'modern', name: 'Moderna', hint: 'Hero partido + scroll continuo', available: true },
  { key: 'minimal', name: 'Minimal', hint: 'Compacta, carga rápida', available: true },
  { key: 'magazine', name: 'Revista', hint: 'Portada editorial, para fotos', available: true },
];

interface SchoolSettingsRow {
  school_id: string;
  public_profile_enabled: boolean;
  show_plans: boolean;
  show_programs: boolean;
  show_facilities: boolean;
  business_hours: BusinessHourRow[] | null;
}

interface OfferingPlanRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  duration_days: number;
  max_sessions: number | null;
  is_active: boolean;
}

interface OfferingRow {
  id: string;
  name: string;
  description: string | null;
  sport: string | null;
  offering_type: string;
  is_active: boolean;
  offering_plans: OfferingPlanRow[];
}

function formatDurationLabel(days: number, price: number) {
  const priceFmt = `$${price.toLocaleString('es-CO')}`;
  return `${formatFriendlyDuration(days)} / ${priceFmt}`;
}

export default function SchoolPublicProfilePage() {
  const { schoolId, schoolName } = useSchoolContext();
  const { uploadFile, uploading } = useStorage();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);

  const [school, setSchool] = useState<SchoolRow | null>(null);
  const [settings, setSettings] = useState<SchoolSettingsRow | null>(null);
  const [offerings, setOfferings] = useState<OfferingRow[]>([]);

  const [form, setForm] = useState({
    name: '',
    description: '',
    city: '',
    address: '',
    phone: '',
    email: '',
    website: '',
    logo_url: '',
    cover_image_url: '',
    sports: '' as string,
    public_page_layout: 'classic' as PublicPageLayout,
    show_plans: true,
    show_programs: true,
    show_facilities: false,
    business_hours_enabled: false,
    business_hours: defaultBusinessHours(),
  });

  const loadData = async () => {
    if (!schoolId) return;
    setLoading(true);
    try {
      const [schoolRes, settingsRes, offeringsRes] = await Promise.allSettled([
        (supabase.from('schools') as any)
          .select('id, slug, name, description, city, address, phone, email, website, logo_url, cover_image_url, sports, public_page_layout')
          .eq('id', schoolId).single(),
        supabase.from('school_settings')
          .select('school_id, public_profile_enabled, show_plans, show_programs, show_facilities, business_hours')
          .eq('school_id', schoolId).maybeSingle(),
        supabase.from('offerings')
          .select('id, name, description, sport, offering_type, is_active, offering_plans(id, name, description, price, currency, duration_days, max_sessions, is_active)')
          .eq('school_id', schoolId)
          .eq('is_active', true)
          .order('sort_order', { ascending: true }),
      ]);

      const s = schoolRes.status === 'fulfilled' ? schoolRes.value.data : null;
      const st = settingsRes.status === 'fulfilled' ? settingsRes.value.data : null;
      const off = offeringsRes.status === 'fulfilled' && !offeringsRes.value.error ? offeringsRes.value.data : null;
      if (s) {
        setSchool(s as SchoolRow);
        setForm(prev => ({
          ...prev,
          name: s.name ?? '',
          description: s.description ?? '',
          city: s.city ?? '',
          address: s.address ?? '',
          phone: s.phone ?? '',
          email: s.email ?? '',
          website: s.website ?? '',
          logo_url: s.logo_url ?? '',
          cover_image_url: s.cover_image_url ?? '',
          sports: (s.sports ?? []).join(', '),
          public_page_layout: (s.public_page_layout ?? 'classic') as PublicPageLayout,
        }));
      }
      if (st) {
        setSettings(st as unknown as SchoolSettingsRow);
        const savedHours = (st as unknown as SchoolSettingsRow).business_hours;
        setForm(prev => ({
          ...prev,
          show_plans: st.show_plans ?? true,
          show_programs: st.show_programs ?? true,
          show_facilities: st.show_facilities ?? false,
          business_hours_enabled: !!savedHours && savedHours.length > 0,
          business_hours: savedHours && savedHours.length > 0 ? savedHours : defaultBusinessHours(),
        }));
      }
      if (off) setOfferings(off as unknown as OfferingRow[]);
    } catch (err: any) {
      console.error('[SchoolPublicProfile] load', err);
      toast.error('Error cargando el perfil');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [schoolId]); // eslint-disable-line

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const setDayHours = (day: number, patch: Partial<BusinessHourRow>) =>
    setForm(prev => ({
      ...prev,
      business_hours: prev.business_hours.map(r => r.day === day ? { ...r, ...patch } : r),
    }));

  const handleUpload = async (file: File, field: 'logo_url' | 'cover_image_url') => {
    if (!schoolId) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Ese archivo no es una imagen. Sube un PNG, JPG, WEBP o SVG.');
      return;
    }
    try {
      const folder = field === 'logo_url' ? `logos/${schoolId}` : `covers/${schoolId}`;
      const publicUrl = await uploadFile(file, 'school-assets', folder);
      if (!publicUrl) return; // useStorage ya mostró toast de error
      set(field, publicUrl);
      toast.success('Imagen subida');
    } catch (err: any) {
      toast.error(err.message || 'Error subiendo imagen');
    }
  };

  const handleSave = async () => {
    if (!schoolId) return;
    setSaving(true);
    try {
      const sportsArray = form.sports.split(',').map(s => s.trim()).filter(Boolean);
      // El logo_url está protegido por el trigger enforce_branding_via_rpc:
      // un UPDATE directo lo rechaza con 42501/403. Guardamos el perfil
      // público (textos + logo + portada) vía RPC SECURITY DEFINER.
      // '' = limpiar el campo; la RPC lo interpreta como NULL.
      const { data: res, error: se } = await (supabase.rpc as any)('update_school_public_profile', {
        p_school_id: schoolId,
        p_name: form.name,
        p_description: form.description,
        p_city: form.city,
        p_address: form.address,
        p_phone: form.phone,
        p_email: form.email,
        p_website: form.website,
        p_logo_url: form.logo_url ?? '',
        p_cover_image_url: form.cover_image_url ?? '',
        p_sports: sportsArray,
        p_public_page_layout: form.public_page_layout,
      });
      if (se) throw se;
      if (res && (res as { ok?: boolean }).ok === false) {
        throw new Error((res as { message?: string; error?: string }).message
          ?? (res as { error?: string }).error
          ?? 'No se pudo guardar el perfil');
      }

      const { error: te } = await (supabase.from('school_settings') as any).upsert({
        school_id: schoolId,
        show_plans: form.show_plans,
        show_programs: form.show_programs,
        show_facilities: form.show_facilities,
        // null = "no configurado", el perfil público usa el horario fijo de respaldo.
        business_hours: form.business_hours_enabled ? form.business_hours : null,
      }, { onConflict: 'school_id' });
      if (te) throw te;

      await loadData();
      toast.success('Cambios guardados');
    } catch (err: any) {
      toast.error(err.message || 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  const handlePublishToggle = async () => {
    if (!schoolId) return;
    const next = !(settings?.public_profile_enabled ?? false);
    setPublishing(true);
    try {
      const { error } = await supabase.from('school_settings').upsert({
        school_id: schoolId,
        public_profile_enabled: next,
      }, { onConflict: 'school_id' });
      if (error) throw error;
      setSettings(prev => prev ? { ...prev, public_profile_enabled: next } : {
        school_id: schoolId, public_profile_enabled: next,
        show_plans: form.show_plans, show_programs: form.show_programs, show_facilities: form.show_facilities,
        business_hours: form.business_hours_enabled ? form.business_hours : null,
      });
      if (next) setSuccessOpen(true);
      else toast.success('Perfil despublicado');
    } catch (err: any) {
      toast.error(err.message || 'Error publicando');
    } finally {
      setPublishing(false);
    }
  };

  const publicUrl = school?.slug
    ? `${window.location.origin}/s/${school.slug}`
    : '';
  const isPublished = settings?.public_profile_enabled ?? false;

  const handleCopyUrl = async () => {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success('Enlace copiado');
    } catch {
      toast.error('No se pudo copiar');
    }
  };

  if (loading || !schoolId) {
    return (
      <div className="flex items-center justify-center min-h-[60dvh]">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mi Perfil Público</h1>
          <p className="text-sm text-muted-foreground">
            Personaliza cómo te ven los alumnos potenciales en Explorar.
          </p>
          {isPublished && (
            <Badge className="mt-2 bg-green-500 text-white gap-1.5">
              <Globe className="h-3 w-3" /> Publicado
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={isPublished ? 'outline' : 'default'}
            onClick={handlePublishToggle}
            disabled={publishing}
            className="gap-1.5"
          >
            {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            {isPublished ? 'Despublicar' : 'Publicar perfil'}
          </Button>
          <Button onClick={handleSave} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Guardar
          </Button>
        </div>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <Tabs defaultValue="general" className="w-full">
        <TabsList className="grid grid-cols-3 w-full max-w-xl">
          <TabsTrigger value="general" className="gap-1.5"><User className="h-3.5 w-3.5" /> General</TabsTrigger>
          <TabsTrigger value="planes" className="gap-1.5"><DollarSign className="h-3.5 w-3.5" /> Planes</TabsTrigger>
          <TabsTrigger value="contacto" className="gap-1.5"><Phone className="h-3.5 w-3.5" /> Contacto</TabsTrigger>
        </TabsList>

        {/* ── GENERAL ───────────────────────────────────────────────────── */}
        <TabsContent value="general" className="space-y-5 mt-6">

          {/* Micrositio publico: link compartible */}
          <Card className="border-dashed bg-muted/40">
            <CardContent className="p-5 space-y-3">
              <div>
                <h3 className="font-semibold text-base flex items-center gap-2">
                  <Globe className="h-4 w-4 text-primary" />
                  Tu Micrositio Público
                </h3>
                <p className="text-sm text-muted-foreground">
                  {isPublished
                    ? 'Comparte este enlace para que padres y alumnos vean tus programas sin registrarse.'
                    : 'Publica tu perfil para activar el enlace y compartirlo.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={publicUrl}
                  placeholder="Se genera al crear la escuela…"
                  className="font-mono text-sm bg-background"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyUrl}
                  disabled={!isPublished || !publicUrl}
                  aria-label="Copiar enlace"
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  onClick={() => publicUrl && window.open(publicUrl, '_blank')}
                  disabled={!isPublished || !publicUrl}
                  className="gap-1.5"
                >
                  <ExternalLink className="h-4 w-4" />
                  Ver Sitio
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 space-y-5">
              <div>
                <h3 className="font-semibold text-base flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-primary" />
                  Presentación
                </h3>
                <p className="text-sm text-muted-foreground">Lo primero que verán tus alumnos.</p>
              </div>

              {/* Logo */}
              <div className="space-y-2">
                <Label>Logo de la escuela</Label>
                <div className="flex items-center gap-4">
                  <Avatar className="h-20 w-20">
                    <AvatarImage src={form.logo_url} />
                    <AvatarFallback>{(form.name ?? 'SM').substring(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <label>
                    <input
                      type="file" className="hidden" accept="image/*"
                      onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0], 'logo_url')}
                    />
                    <Button asChild variant="outline" size="sm" disabled={uploading}>
                      <span><Upload className="h-4 w-4 mr-1.5" /> Subir logo</span>
                    </Button>
                  </label>
                  <p className="text-xs text-muted-foreground">JPG/PNG · máx 5MB</p>
                </div>
              </div>

              {/* Cover */}
              <div className="space-y-2">
                <Label>Imagen de portada</Label>
                {form.cover_image_url ? (
                  <div className="relative rounded-lg overflow-hidden border">
                    <img src={form.cover_image_url} alt="cover" className="w-full h-32 object-cover" />
                    <label className="absolute top-2 right-2">
                      <input
                        type="file" className="hidden" accept="image/*"
                        onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0], 'cover_image_url')}
                      />
                      <Button asChild variant="secondary" size="sm" disabled={uploading}>
                        <span><Upload className="h-3.5 w-3.5 mr-1" /> Cambiar</span>
                      </Button>
                    </label>
                  </div>
                ) : (
                  <label className="block border-2 border-dashed rounded-lg p-8 text-center hover:border-primary cursor-pointer transition-colors">
                    <input
                      type="file" className="hidden" accept="image/*"
                      onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0], 'cover_image_url')}
                    />
                    <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground mt-1">Subir portada (recomendado 1200x300)</p>
                  </label>
                )}
              </div>

              {/* Layout del micrositio */}
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  <LayoutTemplate className="h-3.5 w-3.5" /> Diseño del micrositio
                </Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {LAYOUT_OPTIONS.map(opt => {
                    const selected = form.public_page_layout === opt.key;
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        disabled={!opt.available}
                        onClick={() => set('public_page_layout', opt.key)}
                        className={`relative text-left p-3 rounded-lg border-2 transition-colors ${
                          selected ? 'border-primary bg-primary/5' : 'border-muted'
                        } ${opt.available ? 'hover:border-primary/60 cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
                      >
                        {selected && (
                          <span className="absolute top-1.5 right-1.5 h-4 w-4 rounded-full bg-primary text-white flex items-center justify-center">
                            <Check className="h-2.5 w-2.5" />
                          </span>
                        )}
                        <p className="font-medium text-sm">{opt.name}</p>
                        <p className="text-xs text-muted-foreground">{opt.hint}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Nombre de la escuela *</Label>
                  <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ej. Escuela Futbol Bogota" />
                </div>
                <div className="space-y-2">
                  <Label>Ciudad</Label>
                  <Input value={form.city} onChange={e => set('city', e.target.value)} placeholder="Ej. Bogota" />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Descripción</Label>
                <Textarea
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Cuenta a los alumnos qué ofrece tu academia…"
                  rows={4}
                />
              </div>

              <div className="space-y-2">
                <Label>Deportes</Label>
                <Input
                  value={form.sports}
                  onChange={e => set('sports', e.target.value)}
                  placeholder="Futbol, Natacion, Tenis (separados por coma)"
                />
                <p className="text-xs text-muted-foreground">Aparecen como chips en tu tarjeta de Explorar.</p>
              </div>
            </CardContent>
          </Card>

          {/* ── Secciones mostradas ───────────────────────────────────── */}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div>
                <h3 className="font-semibold text-base">¿Qué mostrar en tu perfil público?</h3>
                <p className="text-sm text-muted-foreground">Controla qué secciones aparecen en Explorar.</p>
              </div>
              <div className="space-y-3">
                {[
                  { k: 'show_programs' as const, label: 'Programas deportivos', desc: 'Listado de programas/equipos' },
                  { k: 'show_plans'    as const, label: 'Planes y mensualidades', desc: 'Card con precios y CTA de inscripción' },
                  { k: 'show_facilities' as const, label: 'Instalaciones', desc: 'Canchas, gimnasios y recursos disponibles' },
                ].map(row => (
                  <div key={row.k} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div>
                      <p className="text-sm font-medium">{row.label}</p>
                      <p className="text-xs text-muted-foreground">{row.desc}</p>
                    </div>
                    <Switch checked={form[row.k]} onCheckedChange={v => set(row.k, v)} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── PLANES ────────────────────────────────────────────────────── */}
        <TabsContent value="planes" className="space-y-5 mt-6">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-base flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-primary" />
                    Planes y mensualidades
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Así ven tus alumnos los planes cuando entran a tu perfil en Explorar.
                  </p>
                </div>
                <Button asChild size="sm" className="gap-1.5">
                  <Link to="/offerings">
                    <Plus className="h-4 w-4" /> Gestionar planes
                  </Link>
                </Button>
              </div>

              {offerings.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed rounded-lg">
                  <Trophy className="h-10 w-10 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="font-medium">Aún no tienes planes publicados</p>
                  <p className="text-sm text-muted-foreground mb-4">
                    Crea tu primera oferta deportiva para que aparezca en Explorar.
                  </p>
                  <Button asChild>
                    <Link to="/offerings">Crear plan</Link>
                  </Button>
                </div>
              ) : (
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  {offerings.map(off => {
                    const activePlans = (off.offering_plans ?? []).filter(p => p.is_active);
                    if (activePlans.length === 0) return null;

                    const features: PlanFeature[] = [];
                    if (off.description) {
                      off.description.split(/\.\s+|\n+/).map(s => s.trim()).filter(s => s.length > 3)
                        .slice(0, 4).forEach(s => features.push({ label: s.replace(/\.$/, '') }));
                    }
                    const firstPlan = activePlans[0];
                    if (firstPlan?.max_sessions != null) {
                      features.push({ label: `${firstPlan.max_sessions} sesiones incluidas` });
                    }
                    if (features.length === 0) {
                      const typeLabel: Record<string, string> = {
                        session_pack: 'Paquete de clases',
                        monthly: 'Mensualidad',
                        drop_in: 'Clase suelta',
                        subscription: 'Suscripción',
                        class: 'Clases regulares',
                        program: 'Programa deportivo',
                      };
                      features.push({ label: typeLabel[off.offering_type] ?? 'Programa deportivo' });
                    }

                    const durations: PlanDuration[] = activePlans.map(p => ({
                      key: p.id,
                      label: formatDurationLabel(p.duration_days, p.price),
                      price: p.price,
                      durationDays: p.duration_days,
                    }));

                    return (
                      <PlanCard
                        key={off.id}
                        title={off.name}
                        sport={off.sport ?? undefined}
                        features={features}
                        durations={durations}
                        primaryCta="Vista previa"
                        onPrimary={() => toast.info('Vista previa: así se ve este plan en Explorar.')}
                      />
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── CONTACTO ──────────────────────────────────────────────────── */}
        <TabsContent value="contacto" className="space-y-5 mt-6">
          <Card>
            <CardContent className="p-6 space-y-5">
              <div>
                <h3 className="font-semibold text-base flex items-center gap-2">
                  <Phone className="h-4 w-4 text-primary" />
                  Contacto público
                </h3>
                <p className="text-sm text-muted-foreground">Cómo los alumnos se ponen en contacto contigo.</p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" /> WhatsApp</Label>
                  <PhoneInput value={form.phone} onChange={(v) => set('phone', v)} />
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> Email</Label>
                  <Input type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="hola@tuacademia.com" />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Sitio web</Label>
                  <Input type="url" value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://tuacademia.com" />
                </div>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" /> Dirección de la sede principal</Label>
                <Input value={form.address} onChange={e => set('address', e.target.value)} placeholder="Calle 123 # 45-67" />
                <p className="text-xs text-muted-foreground">
                  Para que aparezcas en el mapa de Explorar necesitas coordenadas — las defines en{' '}
                  <Link to="/branches" className="underline underline-offset-2 font-medium">Sedes</Link>.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Horarios de Atención */}
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-base flex items-center gap-2">
                    <Clock className="h-4 w-4 text-primary" />
                    Horarios de Atención
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {form.business_hours_enabled
                      ? 'Este horario se muestra en tu perfil público.'
                      : 'Mientras esté apagado, tu perfil público muestra un horario genérico.'}
                  </p>
                </div>
                <Switch
                  checked={form.business_hours_enabled}
                  onCheckedChange={v => set('business_hours_enabled', v)}
                />
              </div>

              {form.business_hours_enabled && (
                <div className="space-y-2 pt-2 border-t">
                  {form.business_hours.map(row => (
                    <div key={row.day} className="flex items-center gap-3 py-1.5">
                      <span className="text-sm font-medium w-24 shrink-0">{DAY_NAMES_FULL[row.day]}</span>
                      <Switch
                        checked={!row.closed}
                        onCheckedChange={v => setDayHours(row.day, {
                          closed: !v,
                          open: !v ? null : (row.open ?? '08:00'),
                          close: !v ? null : (row.close ?? '20:00'),
                        })}
                      />
                      {row.closed ? (
                        <span className="text-sm text-muted-foreground">Cerrado</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            className="w-28"
                            value={row.open ?? ''}
                            onChange={e => setDayHours(row.day, { open: e.target.value })}
                          />
                          <span className="text-sm text-muted-foreground">a</span>
                          <Input
                            type="time"
                            className="w-28"
                            value={row.close ?? ''}
                            onChange={e => setDayHours(row.day, { close: e.target.value })}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <PublishedSuccessModal
        open={successOpen}
        onOpenChange={setSuccessOpen}
        publicUrl={publicUrl}
        viewUrl={school?.slug ? `/s/${school.slug}` : `/schools/${schoolId}`}
        exploreHint={{ label: 'Escuelas', href: '/explorar?category=schools' }}
        description={`${schoolName || 'Tu academia'} ya es visible para alumnos potenciales en SportMaps. Comparte tu link para que te encuentren.`}
      />
    </div>
  );
}
