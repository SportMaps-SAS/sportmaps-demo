import { useEffect, useState, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Camera, Check, ChevronsUpDown, IdCard, Loader2, Save, User as UserIcon, X } from 'lucide-react';
import { useStorage } from '@/hooks/useStorage';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { SPORTS_LIST } from '@/lib/constants/sportsCatalog';
import { supabase } from '@/integrations/supabase/client';

const sportsList = SPORTS_LIST;

// Nunca el rol interno en pantalla («parent», «school_admin»): palabras de V2Palabras.
const ROL_VISIBLE: Record<string, string> = {
  parent: 'Acudiente',
  athlete: 'Deportista',
  coach: 'Profe',
  school: 'Dueño de la escuela',
  owner: 'Dueño de la escuela',
  school_admin: 'Administración',
  wellness_professional: 'Profesional de salud',
  store_owner: 'Tienda',
  personal_trainer: 'Entrenador personal',
  organizer: 'Organizador',
};

interface ProfileSectionProps {
  data: any;
  saving: boolean;
  onSave: (updates: { 
    full_name: string; 
    phone: string; 
    bio: string; 
    date_of_birth?: string | null; 
    sports_interests?: string[] | null;
  }) => Promise<void>;
}

export function ProfileSection({ data, saving, onSave }: ProfileSectionProps) {
  const { profile, updateProfile: updateAuthProfile } = useAuth();
  const { uploadFile, uploading } = useStorage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [openSports, setOpenSports] = useState(false);
  const [formData, setFormData] = useState({
    full_name: data?.profile?.full_name || '',
    phone: data?.profile?.phone || '',
    bio: data?.profile?.bio || '',
    date_of_birth: data?.profile?.date_of_birth || '' as string | null,
    sports_interests: data?.profile?.sports_interests || [] as string[] | null,
  });

  type DocRow = { id: string; full_name: string; doc_type: string | null; doc_number: string | null; own?: boolean };
  const [docRows, setDocRows] = useState<DocRow[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const showDocs = profile?.role === 'athlete' || profile?.role === 'parent';

  useEffect(() => {
    let cancelled = false;
    if (!profile?.id || !showDocs) {
      setDocRows([]);
      return;
    }
    setLoadingDocs(true);
    (async () => {
      const { data: rows } = await (supabase as any)
        .from('children')
        .select('id, full_name, doc_type, doc_number')
        .eq('parent_id', profile.id)
        .order('full_name', { ascending: true });
      // El deportista ve SU documento (profiles). Antes «Mi Documento» mostraba los
      // hijos de la cuenta: una mamá que también entrena veía la TI de su hijo.
      let own: DocRow[] = [];
      if (profile.role === 'athlete') {
        const { data: me } = await (supabase as any)
          .from('profiles').select('full_name, document_type, document_number').eq('id', profile.id).maybeSingle();
        if (me?.document_number) {
          own = [{ id: `own-${profile.id}`, full_name: me.full_name || '', doc_type: me.document_type ?? null, doc_number: me.document_number, own: true }];
        }
      }
      if (!cancelled) {
        setDocRows([...own, ...((rows as DocRow[]) || [])]);
        setLoadingDocs(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profile?.id, showDocs]);

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !profile?.id) return;

    try {
      const publicUrl = await uploadFile(file, 'avatars', profile.id);
      if (publicUrl) {
        // Directo via AuthContext, no via el onSave de datos personales:
        // save_profile_settings (el RPC detrás de onSave) no tiene parámetro
        // p_avatar_url, así que nunca persiste esta columna. Antes viajaba
        // igual "de colado" porque onSave reenviaba el objeto completo (con
        // avatar_url adentro) a updateAuthProfile — funcionaba por
        // casualidad y quedaba atado al éxito de un guardado que no tiene
        // nada que ver con la foto.
        await updateAuthProfile({ avatar_url: publicUrl });
      }
    } catch (error) {
      console.error('Error uploading avatar:', error);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 animate-in fade-in duration-500">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserIcon className="h-5 w-5 text-primary" />
            Información Personal
          </CardTitle>
          <CardDescription>
            Actualiza tu información pública y cómo te ven otros usuarios en SportMaps.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col sm:flex-row items-center gap-6 pb-6 border-b border-muted/50">
            <div className="relative group">
              <Avatar className="h-24 w-24 border-2 border-primary/10 transition-transform group-hover:scale-105">
                <AvatarImage src={profile?.avatar_url || ''} />
                <AvatarFallback className="text-2xl bg-primary/5 text-primary">
                  {formData.full_name?.charAt(0) || 'U'}
                </AvatarFallback>
              </Avatar>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 flex items-center justify-center bg-black/40 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <Camera className="h-6 w-6" />
              </button>
              <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept="image/*"
                onChange={handleAvatarUpload}
                disabled={uploading}
              />
            </div>
            <div className="space-y-1 text-center sm:text-left">
              <h3 className="font-medium text-lg">{formData.full_name || 'Tu Nombre'}</h3>
              <p className="text-sm text-muted-foreground">{profile?.email}</p>
              <p className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full inline-block mt-1 font-medium">
                {ROL_VISIBLE[profile?.role ?? ''] ?? profile?.role?.replace('_', ' ')}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="full_name">Nombre Completo</Label>
              <Input
                id="full_name"
                value={formData.full_name}
                onChange={(e) => setFormData(prev => ({ ...prev, full_name: e.target.value }))}
                placeholder="Ej. Juan Pérez"
              />
            </div>
            <div className="space-y-2">
              <Label>WhatsApp</Label>
              <PhoneInput
                value={formData.phone}
                onChange={(v) => setFormData(prev => ({ ...prev, phone: v }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="date_of_birth">Fecha de Nacimiento</Label>
              <Input
                id="date_of_birth"
                type="date"
                value={formData.date_of_birth || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, date_of_birth: e.target.value }))}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="sports_interests">Intereses Deportivos (Máximo 5)</Label>
              <div className="flex flex-wrap gap-2 mb-2 p-2 min-h-11 border rounded-md bg-muted/5">
                {formData.sports_interests && formData.sports_interests.length > 0 ? (
                  formData.sports_interests.map((sport) => (
                    <Badge key={sport} variant="secondary" className="gap-1 px-2 py-1">
                      {sport}
                      <button
                        type="button"
                        onClick={() => {
                          setFormData(prev => ({
                            ...prev,
                            sports_interests: prev.sports_interests?.filter(s => s !== sport) || []
                          }));
                        }}
                        className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      >
                        <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                      </button>
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground px-1 py-1">No has seleccionado deportes aún</span>
                )}
              </div>
              
              <Popover open={openSports} onOpenChange={setOpenSports}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={openSports}
                    className="w-full justify-between"
                    disabled={formData.sports_interests && formData.sports_interests.length >= 5}
                  >
                    {formData.sports_interests && formData.sports_interests.length >= 5 
                      ? "Límite alcanzado (5 deportes)" 
                      : "Añadir deporte..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Buscar deporte..." />
                    <CommandList>
                      <CommandEmpty>No se encontró el deporte.</CommandEmpty>
                      <CommandGroup className="max-h-48 overflow-auto">
                        {SPORTS_LIST.map((sport) => (
                          <CommandItem
                            key={sport}
                            value={sport}
                            onSelect={() => {
                              if (formData.sports_interests && formData.sports_interests.length < 5 && !formData.sports_interests.includes(sport)) {
                                setFormData(prev => ({
                                  ...prev,
                                  sports_interests: [...(prev.sports_interests || []), sport]
                                }));
                              }
                              setOpenSports(false);
                            }}
                            className={cn(
                              "flex items-center justify-between",
                              formData.sports_interests?.includes(sport) && "opacity-50 pointer-events-none"
                            )}
                          >
                            {sport}
                            {formData.sports_interests?.includes(sport) && <Check className="h-4 w-4" />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              <p className="text-[11px] text-muted-foreground">
                Selecciona hasta 5 deportes que te interesen para personalizar tu experiencia.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bio">Biografía / Descripción</Label>
            <Textarea
              id="bio"
              value={formData.bio}
              onChange={(e) => setFormData(prev => ({ ...prev, bio: e.target.value }))}
              placeholder="Cuéntanos un poco sobre ti..."
              className="min-h-24 resize-none"
            />
          </div>
        </CardContent>
        <CardFooter className="flex justify-end border-t bg-muted/5 py-4">
          <Button type="submit" disabled={saving || uploading} className="gap-2 shadow-sm">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Guardar Cambios
          </Button>
        </CardFooter>
      </Card>

      {showDocs && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IdCard className="h-5 w-5 text-primary" />
              {profile?.role === 'athlete' ? 'Mis documentos' : 'Documentos de mis hijos'}
            </CardTitle>
            <CardDescription>
              Información solo de lectura. Para cambios contacta a la escuela.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingDocs ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
              </div>
            ) : docRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {profile?.role === 'athlete'
                  ? 'Aún no hay un documento registrado para tu cuenta.'
                  : 'Aún no tienes hijos vinculados a tu cuenta.'}
              </p>
            ) : (
              <div className="space-y-3">
                {docRows.map((row) => (
                  <div key={row.id} className="grid gap-3 sm:grid-cols-3 rounded-md border bg-muted/5 p-3">
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Nombre</Label>
                      <Input value={row.full_name || ''} readOnly disabled className="bg-muted/30" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Tipo</Label>
                      <Input value={row.doc_type || '—'} readOnly disabled className="bg-muted/30 uppercase" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Número</Label>
                      <Input value={row.doc_number || '—'} readOnly disabled className="bg-muted/30 font-mono" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </form>
  );
}
