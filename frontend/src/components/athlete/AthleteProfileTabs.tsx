import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { User, Shield, Activity, Heart, Save, Loader2, Camera, Lock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { getAgeCategory } from '@/lib/athlete/queries';
import { comprimirParaSubir } from '@/lib/imageCompression';

export function AthleteProfileTabs() {
  const { user, profile, updateProfile } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [formData, setFormData] = useState({
    full_name: profile?.full_name || '',
    phone: profile?.phone || '',
    date_of_birth: profile?.date_of_birth || '',
    document_type: '',
    document_number: '',
    gender: '',
    experience_level: '',
    bio: profile?.bio || '',
  });

  // Load extended profile data
  useEffect(() => {
    if (user) {
      loadExtendedProfile();
    }
  }, [user]);

  const loadExtendedProfile = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    if (data) {
      setFormData(prev => ({
        ...prev,
        full_name: data.full_name || '',
        phone: data.phone || '',
        date_of_birth: data.date_of_birth || '',
        document_type: (data as any).document_type || '',
        document_number: (data as any).document_number || '',
        gender: (data as any).gender || '',
        experience_level: (data as any).experience_level || '',
        bio: data.bio || '',
      }));
    }
  };

  const handleSavePersonal = async () => {
    try {
      setSaving(true);
      await updateProfile({
        full_name: formData.full_name,
        phone: formData.phone,
        date_of_birth: formData.date_of_birth,
        bio: formData.bio,
      } as any);

      // Update extended fields directly
      await supabase
        .from('profiles')
        .update({
          document_type: formData.document_type || null,
          document_number: formData.document_number || null,
          gender: formData.gender || null,
        } as any)
        .eq('id', user!.id);

      toast({
        title: 'Perfil actualizado',
        description: 'Tus datos personales han sido guardados.',
      });
    } catch (err) {
      console.error('Error saving profile:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSport = async () => {
    try {
      setSaving(true);
      await supabase
        .from('profiles')
        .update({
          experience_level: formData.experience_level || null,
        } as any)
        .eq('id', user!.id);

      toast({
        title: 'Perfil deportivo actualizado',
        description: 'Tu nivel de experiencia ha sido guardado.',
      });
    } catch (err) {
      console.error('Error saving sport profile:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    try {
      setUploading(true);
      const fileC = await comprimirParaSubir(file, 'avatar');
      const fileExt = fileC.name.split('.').pop();
      // Carpeta propia: la policy de INSERT de avatars exige ser dueño de la ruta.
      const fileName = `${user.id}/${Date.now()}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, fileC, { upsert: false, contentType: fileC.type });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);

      await updateProfile({ avatar_url: urlData.publicUrl });

      toast({
        title: 'Foto actualizada',
        description: 'Tu foto de perfil ha sido cambiada.',
      });
    } catch (err) {
      console.error('Error uploading avatar:', err);
      toast({
        title: 'Error',
        description: 'No se pudo subir la imagen.',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const ageCategory = formData.date_of_birth ? getAgeCategory(formData.date_of_birth) : null;

  return (
    <Tabs defaultValue="personal" className="w-full">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="personal" className="gap-1">
          <User className="h-4 w-4" /> Personal
        </TabsTrigger>
        <TabsTrigger value="sport" className="gap-1">
          <Activity className="h-4 w-4" /> Deportivo
        </TabsTrigger>
        <TabsTrigger value="health" className="gap-1">
          <Heart className="h-4 w-4" /> Salud
        </TabsTrigger>
        <TabsTrigger value="security" className="gap-1">
          <Shield className="h-4 w-4" /> Seguridad
        </TabsTrigger>
      </TabsList>

      {/* ─── Tab 1: Personal ────────────────────────────── */}
      <TabsContent value="personal" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Datos Personales</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Avatar */}
            <div className="flex items-center gap-4">
              <div className="relative">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={profile?.avatar_url || undefined} />
                  <AvatarFallback className="text-xl">
                    {profile?.full_name?.charAt(0) || '?'}
                  </AvatarFallback>
                </Avatar>
                <label className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-primary flex items-center justify-center cursor-pointer hover:bg-primary/90 transition">
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 text-white animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5 text-white" />
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarUpload}
                    disabled={uploading}
                  />
                </label>
              </div>
              <div>
                <p className="font-semibold">{profile?.full_name || 'Sin nombre'}</p>
                <Badge variant="outline" className="text-xs mt-1">Atleta</Badge>
                {ageCategory && (
                  <Badge variant="secondary" className="text-xs mt-1 ml-2">
                    Categoría: {ageCategory}
                  </Badge>
                )}
              </div>
            </div>

            {/* Form */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Nombre completo</Label>
                <Input
                  value={formData.full_name}
                  onChange={e => setFormData({ ...formData, full_name: e.target.value })}
                />
              </div>
              <div>
                <Label>WhatsApp</Label>
                <PhoneInput
                  value={formData.phone}
                  onChange={(v) => setFormData({ ...formData, phone: v })}
                />
              </div>
              <div>
                <Label>Fecha de nacimiento</Label>
                <Input
                  type="date"
                  value={formData.date_of_birth}
                  onChange={e => setFormData({ ...formData, date_of_birth: e.target.value })}
                />
              </div>
              <div>
                <Label>Género</Label>
                <Select value={formData.gender} onValueChange={v => setFormData({ ...formData, gender: v })}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="M">Masculino</SelectItem>
                    <SelectItem value="F">Femenino</SelectItem>
                    <SelectItem value="X">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Tipo de documento</Label>
                <Select value={formData.document_type} onValueChange={v => setFormData({ ...formData, document_type: v })}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CC">Cédula de Ciudadanía</SelectItem>
                    <SelectItem value="CE">Cédula de Extranjería</SelectItem>
                    <SelectItem value="PA">Pasaporte</SelectItem>
                    <SelectItem value="TI">Tarjeta de Identidad</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Número de documento</Label>
                <Input
                  value={formData.document_number}
                  onChange={e => setFormData({ ...formData, document_number: e.target.value })}
                />
              </div>
            </div>

            <Button onClick={handleSavePersonal} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Guardar datos personales
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      {/* ─── Tab 2: Deportivo ───────────────────────────── */}
      <TabsContent value="sport" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Perfil Deportivo</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Nivel de experiencia</Label>
                <Select value={formData.experience_level} onValueChange={v => setFormData({ ...formData, experience_level: v })}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar nivel" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="novice">Novato — Empezando</SelectItem>
                    <SelectItem value="prep">Preparación — Con experiencia</SelectItem>
                    <SelectItem value="elite">Élite — Competitivo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {ageCategory && (
                <div>
                  <Label>Categoría de edad</Label>
                  <div className="flex items-center gap-2 mt-2">
                    <Badge variant="secondary" className="text-sm">{ageCategory}</Badge>
                    <span className="text-xs text-muted-foreground">Calculada automáticamente</span>
                  </div>
                </div>
              )}
            </div>

            <Button onClick={handleSaveSport} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Guardar perfil deportivo
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      {/* ─── Tab 3: Salud / Bienestar (Solo lectura) ────── */}
      <TabsContent value="health" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Heart className="h-5 w-5 text-rose-500" />
              Evaluaciones de Bienestar
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-4 text-sm text-blue-700">
              <strong>Solo lectura:</strong> Las evaluaciones de bienestar son realizadas por tu entrenador o profesional de salud. 
              Aquí puedes consultar tus resultados.
            </div>

            <div className="mt-6 text-center py-8 text-muted-foreground">
              <Heart className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Sin evaluaciones aún</p>
              <p className="text-sm mt-1">Aparecerán aquí cuando tu equipo médico las registre.</p>
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      {/* ─── Tab 4: Seguridad ───────────────────────────── */}
      <TabsContent value="security" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Seguridad de la cuenta
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Email</Label>
              <Input value={profile?.email || ''} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground mt-1">El email no se puede cambiar.</p>
            </div>
            <div>
              <Label>Rol</Label>
              <div className="flex items-center gap-2 mt-1">
                <Badge>Atleta</Badge>
                <span className="text-xs text-muted-foreground">No editable</span>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                await supabase.auth.resetPasswordForEmail(profile?.email || '');
                toast({
                  title: 'Email enviado',
                  description: 'Revisa tu correo para cambiar tu contraseña.',
                });
              }}
            >
              <Lock className="h-4 w-4 mr-2" />
              Cambiar contraseña
            </Button>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
