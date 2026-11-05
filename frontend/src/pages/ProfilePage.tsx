import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  User,
  Mail,
  Phone,
  Calendar,
  Shield,
  Edit2,
  IdCard,
  Save,
  X,
  Camera,
  Loader2,
  Repeat
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '@/hooks/use-toast';
import { useStorage } from '@/hooks/useStorage';
import { supabase } from '@/integrations/supabase/client';

export default function ProfilePage() {
  const { user, profile, updateProfile, roleContexts, activeRoleContext } = useAuth();
  const { toast } = useToast();
  const { uploadFile, uploading: isUploadingAvatar } = useStorage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    full_name: profile?.full_name || '',
    phone: profile?.phone || '',
    avatar_url: profile?.avatar_url || '',
    date_of_birth: profile?.date_of_birth || '',
  });

  useEffect(() => {
    if (profile) {
      setFormData({
        full_name: profile.full_name || '',
        phone: profile.phone || '',
        avatar_url: profile.avatar_url || '',
        date_of_birth: profile.date_of_birth || '',
      });
    }
  }, [profile]);

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

  const handleSave = async () => {
    try {
      setLoading(true);
      await updateProfile(formData);
      setIsEditing(false);
      toast({
        title: 'Perfil actualizado',
        description: 'Tus cambios han sido guardados exitosamente',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'No se pudo actualizar el perfil',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setFormData({
      full_name: profile?.full_name || '',
      phone: profile?.phone || '',
      avatar_url: profile?.avatar_url || '',
      date_of_birth: profile?.date_of_birth || '',
    });
    setIsEditing(false);
  };
  
  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !profile?.id) return;

    try {
      const publicUrl = await uploadFile(file, 'avatars', `profiles/${profile.id}`);
      if (publicUrl) {
        setFormData(prev => ({ ...prev, avatar_url: publicUrl }));
        toast({
          title: 'Imagen cargada',
          description: 'Recuerda guardar los cambios para conservar la nueva foto.',
        });
      }
    } catch (error) {
      console.error('Error uploading avatar:', error);
    }
  };

  const getRoleName = (role: string) => {
    const roles: Record<string, string> = {
      athlete: 'Deportista/Atleta',
      parent: 'Padre/Madre',
      coach: 'Entrenador/Coach',
      school: 'Escuela/Centro Deportivo',
      school_admin: 'Administrador de Sede',
      wellness_professional: 'Profesional de Bienestar',
      store_owner: 'Tienda/Vendedor',
      admin: 'Administrador',
      reporter: 'Auditoría/Súper Usuario',

    };
    return roles[role] || role;
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (!profile) return null;

  return (
    <div className="container max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Mi Perfil</h1>
          <p className="text-muted-foreground">
            Gestiona tu información personal
          </p>
        </div>
        {!isEditing ? (
          <Button onClick={() => setIsEditing(true)}>
            <Edit2 className="h-4 w-4 mr-2" />
            Editar Perfil
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel} disabled={loading}>
              <X className="h-4 w-4 mr-2" />
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={loading}>
              <Save className="h-4 w-4 mr-2" />
              Guardar
            </Button>
          </div>
        )}
      </div>

      {/* Persona multirol: con qué rol está usando la app y cómo cambiarlo. */}
      {roleContexts.length > 0 && (
        <Card>
          <CardContent className="flex flex-col sm:flex-row sm:items-center gap-3 pt-6">
            <div className="flex-1 min-w-0">
              <p className="font-semibold">Estás entrando {activeRoleContext ? (activeRoleContext.label.startsWith('Como') ? activeRoleContext.label.toLowerCase() : `como ${activeRoleContext.label.toLowerCase()}`) : 'sin rol elegido'}</p>
              <p className="text-sm text-muted-foreground">
                Tienes {roleContexts.length} roles: {roleContexts.map((c) => c.label.replace(/^Como /, '')).join(', ')}.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/elegir-rol"><Repeat className="h-4 w-4 mr-2" />Cambiar de rol</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Profile Card */}
      <Card>
        <CardHeader>
          <CardTitle>Información Personal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar Section */}
          <div className="flex items-center gap-6">
            <div className="relative">
              <Avatar className="h-24 w-24">
                <AvatarImage src={formData.avatar_url} />
                <AvatarFallback className="text-2xl">
                  {getInitials(formData.full_name || 'Usuario')}
                </AvatarFallback>
              </Avatar>
              {isEditing && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="absolute bottom-0 right-0 h-8 w-8 rounded-full p-0 shadow-md hover:bg-primary hover:text-white transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploadingAvatar}
                  >
                    {isUploadingAvatar ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                  </Button>
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                  />
                </>
              )}
            </div>
            <div className="space-y-1">
              <h3 className="text-xl font-semibold">{profile.full_name}</h3>
              <Badge variant="secondary" className="gap-1">
                <Shield className="h-3 w-3" />
                {getRoleName(profile.role)}
              </Badge>
            </div>
          </div>

          {/* Form Fields */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Full Name */}
            <div className="space-y-2">
              <Label htmlFor="full_name" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                Nombre Completo
              </Label>
              <Input
                id="full_name"
                value={formData.full_name}
                onChange={(e) =>
                  setFormData({ ...formData, full_name: e.target.value })
                }
                disabled={!isEditing}
              />
            </div>

            {/* Email */}
            <div className="space-y-2">
              <Label htmlFor="email" className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Email
              </Label>
              <Input
                id="email"
                type="email"
                value={user?.email || ''}
                disabled
                className="bg-muted"
              />
            </div>

            {/* Phone */}
            <div className="space-y-2">
              <Label htmlFor="phone" className="flex items-center gap-2">
                <Phone className="h-4 w-4" />
                Teléfono
              </Label>
              <PhoneInput
                id="phone"
                value={formData.phone || ''}
                onChange={(v) => setFormData({ ...formData, phone: v })}
                disabled={!isEditing}
              />
            </div>

            {/* Role (read-only) */}
            <div className="space-y-2">
              <Label htmlFor="role" className="flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Tipo de Usuario
              </Label>
              <Input
                id="role"
                value={getRoleName(profile.role)}
                disabled
                className="bg-muted"
              />
            </div>

            {/* Date of Birth */}
            <div className="space-y-2">
              <Label htmlFor="date_of_birth" className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Fecha de Nacimiento
              </Label>
              <Input
                id="date_of_birth"
                type="date"
                value={formData.date_of_birth || ''}
                onChange={(e) =>
                  setFormData({ ...formData, date_of_birth: e.target.value })
                }
                disabled={!isEditing}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Document Card (read-only) */}
      {showDocs && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IdCard className="h-5 w-5 text-primary" />
              {profile.role === 'athlete' ? 'Mis documentos' : 'Documentos de mis hijos'}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Información solo de lectura. Para cambios contacta a la escuela.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {loadingDocs ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
              </div>
            ) : docRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {profile.role === 'athlete'
                  ? 'Aún no hay un documento registrado para tu cuenta.'
                  : 'Aún no tienes hijos vinculados a tu cuenta.'}
              </p>
            ) : (
              <div className="space-y-3">
                {docRows.map((row) => (
                  <div key={row.id} className="grid gap-3 md:grid-cols-3 rounded-md border bg-muted/20 p-3">
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Nombre</Label>
                      <Input value={row.full_name || ''} readOnly disabled className="bg-muted" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Tipo</Label>
                      <Input value={row.doc_type || '—'} readOnly disabled className="bg-muted uppercase" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Número</Label>
                      <Input value={row.doc_number || '—'} readOnly disabled className="bg-muted font-mono" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stats Card */}
      <Card>
        <CardHeader>
          <CardTitle>Estadísticas de la Cuenta</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Puntos SportMaps</p>
              <p className="text-2xl font-bold">{profile.sportmaps_points || 0}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Nivel de Suscripción</p>
              <p className="text-2xl font-bold uppercase">{profile.subscription_tier || 'Gratis'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Miembro desde</p>
              <p className="text-2xl font-bold">
                {profile.created_at ? new Date(profile.created_at).getFullYear() : '2025'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-destructive">Zona de Peligro</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-semibold">Eliminar cuenta</h4>
              <p className="text-sm text-muted-foreground">
                Esta acción es permanente y no se puede deshacer
              </p>
            </div>
            <Button variant="destructive">Eliminar Cuenta</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
