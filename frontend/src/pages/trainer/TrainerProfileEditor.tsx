import { useState, useEffect } from 'react';
import { useTrainerContext } from '@/hooks/useTrainerContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { User, Globe, DollarSign, MapPin, Instagram, Phone, Eye, Save, Loader2, Copy, CheckCircle2, ExternalLink, Upload, Check, ChevronsUpDown, Plus, Minus, Search, Video, Users, Smartphone } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useStorage } from '@/hooks/useStorage';
import { SPORTS_LIST } from '@/lib/constants/sportsCatalog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { LocationAutocomplete } from '@/components/events/LocationAutocomplete';
import { PhoneInput } from '@/components/ui/phone-input';

const BFF_URL = import.meta.env.VITE_BFF_URL || 'http://localhost:3000';

export default function TrainerProfileEditor() {
  const { trainerProfile, trainerSchoolId, refetchProfile, loadingProfile } = useTrainerContext();
  const { session, user } = useAuth();
  const { toast } = useToast();
  const { uploadFile, uploading: storageUploading } = useStorage();

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedModalOpen, setPublishedModalOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [form, setForm] = useState({
    display_name: '',
    tagline: '',
    bio: '',
    primary_sport: '',
    specialties: '',
    experience_years: '',
    rate_per_session: '',
    rate_currency: 'COP',
    rate_notes: '',
    city: '',
    modality: 'presencial' as 'presencial' | 'virtual' | 'ambas',
    instagram_url: '',
    whatsapp_number: '',
    avatar_url: '',
  });

  // Sincronizar formulario cuando cargue el perfil del entrenador
  useEffect(() => {
    if (trainerProfile) {
      setForm({
        display_name: trainerProfile.display_name ?? '',
        tagline: trainerProfile.tagline ?? '',
        bio: trainerProfile.bio ?? '',
        primary_sport: trainerProfile.primary_sport ?? '',
        specialties: (trainerProfile.specialties ?? []).join(', '),
        experience_years: String(trainerProfile.experience_years ?? ''),
        rate_per_session: String(trainerProfile.rate_per_session ?? ''),
        rate_currency: trainerProfile.rate_currency ?? 'COP',
        rate_notes: trainerProfile.rate_notes ?? '',
        city: trainerProfile.city ?? '',
        modality: (trainerProfile.modality ?? 'presencial') as 'presencial' | 'virtual' | 'ambas',
        instagram_url: trainerProfile.instagram_url ?? '',
        whatsapp_number: trainerProfile.whatsapp_number ?? '',
        avatar_url: trainerProfile.avatar_url ?? '',
      });
    }
  }, [trainerProfile]);

  const set = (key: string, value: string) => setForm(prev => ({ ...prev, [key]: value }));

  const formatNumber = (num: string | number) => {
    if (!num) return '';
    const cleanNumber = String(num).replace(/\D/g, "");
    return cleanNumber.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  };

  const parseNumber = (str: string) => {
    return str.replace(/\D/g, "");
  };

  const handleSave = async () => {
    if (!session?.access_token) return;
    setSaving(true);
    try {
      const res = await fetch(`${BFF_URL}/api/v1/trainer/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          display_name: form.display_name,
          tagline: form.tagline,
          bio: form.bio,
          primary_sport: form.primary_sport,
          specialties: form.specialties.split(',').map(s => s.trim()).filter(Boolean),
          experience_years: parseInt(form.experience_years) || null,
          rate_per_session: parseFloat(form.rate_per_session) || null,
          rate_currency: form.rate_currency,
          rate_notes: form.rate_notes,
          city: form.city,
          modality: form.modality,
          instagram_url: form.instagram_url,
          whatsapp_number: form.whatsapp_number,
          avatar_url: form.avatar_url,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await refetchProfile();
      toast({ title: 'Perfil guardado', description: 'Tus cambios han sido actualizados.' });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!session?.access_token) return;
    setPublishing(true);
    try {
      const res = await fetch(`${BFF_URL}/api/v1/trainer/profile/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await refetchProfile();
      setPublishedModalOpen(true);
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setPublishing(false);
    }
  };

  const publicProfileUrl = `${window.location.origin}/entrenador/${user?.id}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(publicProfileUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const isPublished = trainerProfile?.is_published;

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mi Perfil Público</h1>
          <p className="text-muted-foreground text-sm">Personaliza cómo te ven los clientes potenciales.</p>
        </div>
        <div className="flex items-center gap-2">
          {loadingProfile && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />}
          {isPublished ? (
            <Badge className="bg-green-500 text-white gap-1.5"><Globe className="h-3 w-3" /> Publicado</Badge>
          ) : (
            <Button size="sm" onClick={handlePublish} disabled={publishing || loadingProfile} className="gap-2">
              {publishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
              Publicar perfil
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving || loadingProfile} className="gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Guardar
          </Button>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList className="grid grid-cols-3 w-full sm:w-auto">
          <TabsTrigger value="general" className="gap-2"><User className="h-3.5 w-3.5" />General</TabsTrigger>
          <TabsTrigger value="rates" className="gap-2"><DollarSign className="h-3.5 w-3.5" />Tarifas</TabsTrigger>
          <TabsTrigger value="contact" className="gap-2"><Phone className="h-3.5 w-3.5" />Contacto</TabsTrigger>
        </TabsList>

        {/* General */}
        <TabsContent value="general" className="space-y-4 mt-4">
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Presentación</CardTitle>
              <CardDescription>Lo primero que verán tus clientes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <label className="text-sm font-medium">Foto de perfil</label>
                <div className="flex items-center gap-4">
                  <Avatar className="h-20 w-20 border-2 border-primary/20 shrink-0">
                    <AvatarImage src={form.avatar_url} alt="Avatar" />
                    <AvatarFallback className="bg-primary/5 text-primary text-lg font-bold uppercase">
                      {form.display_name?.substring(0, 2) || 'EP'}
                    </AvatarFallback>
                  </Avatar>
                  <div className="space-y-1">
                    <div className="relative">
                      <Input
                        type="file"
                        accept="image/*"
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        disabled={storageUploading}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (!user?.id) return;
                          const url = await uploadFile(file, 'avatars', `trainer-profiles/${user.id}`);
                          if (url) set('avatar_url', url);
                        }}
                      />
                      <Button type="button" variant="outline" disabled={storageUploading} className="gap-2 h-9 px-3">
                        {storageUploading
                          ? <><Loader2 className="h-4 w-4 animate-spin" /> Subiendo...</>
                          : <><Upload className="h-4 w-4" /> {form.avatar_url ? 'Cambiar foto' : 'Subir foto'}</>
                        }
                      </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground uppercase font-medium tracking-tight">JPG, PNG. Máx 5MB.</p>
                    {form.avatar_url && (
                      <button
                        type="button"
                        className="text-xs text-destructive hover:underline font-bold"
                        onClick={() => set('avatar_url', '')}
                      >
                        Eliminar foto
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Nombre para mostrar</label>
                <Input value={form.display_name} onChange={e => set('display_name', e.target.value)} placeholder="Ej: Carlos Ortiz — Entrenador Personal" />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Tagline</label>
                <Input value={form.tagline} onChange={e => set('tagline', e.target.value)} placeholder="Una frase que te defina..." maxLength={100} />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Bio</label>
                <Textarea value={form.bio} onChange={e => set('bio', e.target.value)} placeholder="Tu historia, metodología y qué ofreces..." rows={5} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Deporte y especialidades</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {/* Deporte Principal — Combobox */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Deporte principal</label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className={cn(
                          "w-full justify-between font-normal bg-background/50 border-border/40 hover:bg-background/80",
                          !form.primary_sport && "text-muted-foreground"
                        )}
                      >
                        {form.primary_sport || "Seleccionar deporte..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-full p-0" align="start">
                      <Command className="bg-background">
                        <CommandInput placeholder="Buscar deporte..." />
                        <CommandList>
                          <CommandEmpty>No se encontró el deporte.</CommandEmpty>
                          <CommandGroup className="max-h-48 overflow-y-auto">
                            {SPORTS_LIST.map((sport) => (
                              <CommandItem
                                key={sport}
                                value={sport}
                                onSelect={() => set('primary_sport', sport)}
                                className="cursor-pointer"
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    form.primary_sport === sport ? "opacity-100 text-primary" : "opacity-0"
                                  )}
                                />
                                {sport}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Años de Experiencia — Stepper */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Años de experiencia</label>
                  <div className="flex h-11 items-center bg-background/50 border border-border/40 rounded-xl overflow-hidden group focus-within:border-primary/50 transition-colors">
                    <button 
                      type="button" 
                      className="h-full w-12 flex items-center justify-center border-r border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                      onClick={() => {
                        const val = parseInt(form.experience_years) || 0;
                        if (val > 0) set('experience_years', String(val - 1));
                      }}
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <div className="flex-1 flex items-center justify-center font-bold text-primary px-4 bg-background/20">
                      {form.experience_years || '0'} <span className="ml-1.5 text-muted-foreground text-[10px] font-normal uppercase tracking-tighter">años</span>
                    </div>
                    <button 
                      type="button" 
                      className="h-full w-12 flex items-center justify-center border-l border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                      onClick={() => {
                        const val = parseInt(form.experience_years) || 0;
                        set('experience_years', String(val + 1));
                      }}
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Especialidades <span className="text-muted-foreground text-xs">(separadas por coma)</span></label>
                <Input value={form.specialties} onChange={e => set('specialties', e.target.value)} placeholder="Ej: Porteros, Fuerza explosiva..." />
              </div>
              <div className="space-y-4">
                <label className="text-sm font-medium">Modalidad de entrenamiento</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    { id: 'presencial', label: 'Presencial', sub: 'En persona', icon: Users },
                    { id: 'virtual', label: 'Virtual', sub: 'Online / App', icon: Video },
                    { id: 'ambas', label: 'Híbrido', sub: 'Ambas formas', icon: Smartphone },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => set('modality', opt.id)}
                      className={cn(
                        "flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-200 gap-2",
                        form.modality === opt.id 
                          ? "border-primary bg-primary/10 shadow-lg shadow-primary/5" 
                          : "border-border/40 bg-background/50 hover:border-border/80"
                      )}
                    >
                      <div className={cn(
                        "h-10 w-10 rounded-full flex items-center justify-center",
                        form.modality === opt.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        <opt.icon className="h-5 w-5" />
                      </div>
                      <div className="text-center">
                        <p className={cn("text-sm font-bold", form.modality === opt.id ? "text-foreground" : "text-muted-foreground")}>
                          {opt.label}
                        </p>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-tight">{opt.sub}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Ciudad</label>
                <LocationAutocomplete 
                  value={form.city} 
                  onChange={val => set('city', val)} 
                  placeholder="Ej: Bogotá" 
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Rates */}
        <TabsContent value="rates" className="space-y-4 mt-4">
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Tarifas por sesión</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Tarifa Config */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Tarifa por sesión</label>
                    <div className="flex h-11 bg-background/50 border border-border/40 rounded-xl overflow-hidden focus-within:border-primary/50 transition-colors">
                      <div className="relative flex-1 flex items-center group">
                        <DollarSign className="absolute left-3.5 h-4 w-4 text-primary font-bold" />
                        <Input 
                          className="pl-8 border-0 bg-transparent h-full text-base font-bold focus-visible:ring-0 focus-visible:ring-offset-0" 
                          type="text" 
                          value={formatNumber(form.rate_per_session)} 
                          onChange={e => set('rate_per_session', parseNumber(e.target.value))} 
                          placeholder="80.000" 
                        />
                      </div>
                      <Select value={form.rate_currency} onValueChange={v => set('rate_currency', v)}>
                        <SelectTrigger className="w-20 h-full rounded-none border-0 border-l border-border/40 bg-background/40 font-bold focus:ring-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="COP">COP</SelectItem>
                          <SelectItem value="USD">USD</SelectItem>
                          <SelectItem value="EUR">EUR</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Sugerencias Rápidas */}
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Sugerencias rápidas (COP)</label>
                    <div className="flex flex-wrap gap-2 h-11 items-center">
                      {[60000, 80000, 100000, 120000].map((amt) => (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => {
                            set('rate_per_session', String(amt));
                            set('rate_currency', 'COP');
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-xs font-bold transition-all border",
                            form.rate_per_session === String(amt) && form.rate_currency === 'COP'
                              ? "bg-primary/20 border-primary text-primary"
                              : "bg-background/40 border-border/40 text-muted-foreground hover:border-border/80"
                          )}
                        >
                          ${(amt/1000).toFixed(0)}k
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Notas sobre tarifas</label>
                <Textarea value={form.rate_notes} onChange={e => set('rate_notes', e.target.value)} placeholder="Ej: Paquetes de 10 sesiones con 10% de descuento..." rows={3} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Contact */}
        <TabsContent value="contact" className="space-y-4 mt-4">
          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-base">Redes y contacto</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Instagram</label>
                  <div className="relative group">
                    <Instagram className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-primary font-bold transition-transform group-focus-within:scale-110" />
                    <Input 
                      className="pl-10 h-11 bg-background/50 border-border/40 rounded-xl focus-visible:ring-primary/20 transition-all" 
                      value={form.instagram_url} 
                      onChange={e => set('instagram_url', e.target.value)} 
                      placeholder="https://instagram.com/..." 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">WhatsApp</label>
                  <PhoneInput 
                    value={form.whatsapp_number} 
                    onChange={val => set('whatsapp_number', val)} 
                    placeholder="Número de contacto" 
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={publishedModalOpen} onOpenChange={setPublishedModalOpen}>
        <DialogContent className="max-w-md p-0 overflow-hidden">
          <div className="flex flex-col items-center gap-5 p-8 text-center">
            <div className="h-20 w-20 rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-green-500" />
            </div>

            <div>
              <h2 className="text-2xl font-bold tracking-tight">¡Perfil publicado!</h2>
              <p className="text-muted-foreground text-sm mt-2">
                Ya eres visible para clientes potenciales en SportMaps.
                Comparte tu link para que te encuentren.
              </p>
            </div>

            <div className="w-full bg-muted rounded-xl p-3 flex items-center gap-2 border border-border/50">
              <span className="text-[11px] text-muted-foreground break-all flex-1 text-left font-mono leading-relaxed">
                {publicProfileUrl}
              </span>
              <Button
                size="sm"
                variant={linkCopied ? 'default' : 'outline'}
                className="shrink-0 gap-1.5 transition-all text-[10px] font-bold uppercase h-8"
                onClick={handleCopyLink}
              >
                {linkCopied
                  ? <><CheckCircle2 className="h-3 w-3" /> Copiado</>
                  : <><Copy className="h-3 w-3" /> Copiar</>
                }
              </Button>
            </div>

            <div className="flex gap-3 w-full">
              <Button
                variant="outline"
                className="flex-1 gap-2 font-bold"
                onClick={() => window.open(publicProfileUrl, '_blank')}
              >
                <ExternalLink className="h-4 w-4" />
                Ver Perfil
              </Button>
              <Button
                className="flex-1 font-bold"
                onClick={() => setPublishedModalOpen(false)}
              >
                Listo
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              💡 También puedes encontrar tu perfil en{' '}
              <a 
                href="/explore/trainers" 
                className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                onClick={(e) => {
                  e.preventDefault();
                  setPublishedModalOpen(false);
                  window.location.href = '/explore/trainers';
                }}
              >
                Explorar Entrenadores
              </a>
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
