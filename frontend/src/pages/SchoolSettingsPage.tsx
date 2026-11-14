import React, { useState, useEffect, useRef } from 'react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { supabase } from '@/integrations/supabase/client';
import { Save, Building2, MapPin, Phone, Mail, Globe, Image, Camera } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { BrandingSettingsForm } from '@/components/settings/BrandingSettingsForm';
import { BrandingAuditLog } from '@/components/settings/BrandingAuditLog';
import { comprimirParaSubir } from '@/lib/imageCompression';

interface SchoolProfile {
    id: string;
    name: string;
    description: string | null;
    city: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    logo_url: string | null;
}

export default function SchoolSettingsPage() {
    const { schoolId, schoolName } = useSchoolContext();
    const navigate = useNavigate();
    const [profile, setProfile] = useState<SchoolProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (schoolId) loadProfile();
    }, [schoolId]);

    async function loadProfile() {
        if (!schoolId) return;
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('schools')
                .select('id, name, description, city, address, phone, email, website, logo_url')
                .eq('id', schoolId)
                .single();
            if (error) throw error;
            setProfile(data as SchoolProfile);
        } catch (error) {
            console.error('Error loading school profile:', error);
            toast.error('Error al cargar perfil de la escuela');
        } finally {
            setLoading(false);
        }
    }

    async function handleSave() {
        if (!profile || !schoolId) return;
        try {
            setSaving(true);
            const { error } = await supabase
                .from('schools')
                .update({
                    name: profile.name,
                    description: profile.description,
                    city: profile.city,
                    address: profile.address,
                    phone: profile.phone,
                    email: profile.email,
                    website: profile.website,
                })
                .eq('id', schoolId);
            if (error) throw error;
            toast.success('✅ Perfil guardado exitosamente');
        } catch (error: any) {
            console.error('Error saving profile:', error);
            toast.error(error.message || 'Error al guardar');
        } finally {
            setSaving(false);
        }
    }

    async function handleLogoUpload(file: File) {
        if (!schoolId) return;
        try {
            setUploadingLogo(true);
            const fileC = await comprimirParaSubir(file, 'logo');
            const ext = fileC.name.split('.').pop() || 'jpg';
            // Nombre único y sin upsert: sobrescribir exigía SELECT + UPDATE en avatars.
            const path = `schools/${schoolId}/logo-${Date.now()}.${ext}`;
            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(path, fileC, { upsert: false, contentType: fileC.type || undefined });
            if (uploadError) throw uploadError;
            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(path);
            const { error: updateError } = await supabase
                .from('schools')
                .update({ logo_url: publicUrl })
                .eq('id', schoolId);
            if (updateError) throw updateError;
            setProfile(prev => prev ? { ...prev, logo_url: publicUrl } : prev);
            toast.success('✅ Logo actualizado');
        } catch (error: any) {
            toast.error(error.message || 'Error al subir logo');
        } finally {
            setUploadingLogo(false);
        }
    }

    const update = <K extends keyof SchoolProfile>(key: K, value: SchoolProfile[K]) => {
        if (profile) setProfile({ ...profile, [key]: value });
    };

    if (loading) {
        return (
            <div className="space-y-6">
                <div className="h-10 w-64 bg-muted animate-pulse rounded" />
                <div className="grid gap-6 md:grid-cols-2">
                    {[1, 2, 3].map(i => <div key={i} className="h-48 bg-muted animate-pulse rounded-xl" />)}
                </div>
            </div>
        );
    }

    if (!profile) return null;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                        <Building2 className="h-8 w-8 text-primary" />
                        Perfil de la Escuela
                    </h1>
                    <p className="text-muted-foreground mt-1">
                        Información pública y datos de contacto de <span className="font-medium text-foreground">{schoolName}</span>.
                    </p>
                </div>
                <Button onClick={handleSave} disabled={saving} className="w-full md:w-auto shadow-sm">
                    <Save className="h-4 w-4 mr-2" />
                    {saving ? 'Guardando...' : 'Guardar Cambios'}
                </Button>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                {/* Identidad Visual (Logo y Colores) — reactivado 2026-05-28
                    tras fix de scoping en ThemeContext + RPC seguro + audit log.
                    El form muestra upsell si el tier no incluye whitelabel. */}
                <div className="md:col-span-2 space-y-6">
                    <BrandingSettingsForm />
                    <BrandingAuditLog />
                </div>

                {/* Basic Info */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Building2 className="h-5 w-5 text-primary" />
                            Información General
                        </CardTitle>
                        <CardDescription>Nombre y descripción de la escuela.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="name">Nombre de la Escuela *</Label>
                            <Input
                                id="name"
                                value={profile.name || ''}
                                onChange={(e) => update('name', e.target.value)}
                                placeholder="Academia Deportiva..."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="description">Descripción</Label>
                            <Textarea
                                id="description"
                                value={profile.description || ''}
                                onChange={(e) => update('description', e.target.value)}
                                placeholder="Escuela especializada en formación deportiva..."
                                rows={4}
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Location */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <MapPin className="h-5 w-5 text-amber-500" />
                            Ubicación
                        </CardTitle>
                        <CardDescription>Ciudad y dirección física de la sede principal.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="city">Ciudad</Label>
                            <Input
                                id="city"
                                value={profile.city || ''}
                                onChange={(e) => update('city', e.target.value)}
                                placeholder="Bogotá, Medellín, Cali..."
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="address">Dirección</Label>
                            <Input
                                id="address"
                                value={profile.address || ''}
                                onChange={(e) => update('address', e.target.value)}
                                placeholder="Calle 10 # 20-30"
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Contact */}
                <Card className="md:col-span-2">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Phone className="h-5 w-5 text-blue-500" />
                            Contacto
                        </CardTitle>
                        <CardDescription>Teléfono, email y sitio web de la escuela.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-2">
                            <Label htmlFor="phone" className="flex items-center gap-1">
                                <Phone className="h-3 w-3" /> Teléfono
                            </Label>
                            <Input
                                id="phone"
                                value={profile.phone || ''}
                                onChange={(e) => update('phone', e.target.value)}
                                placeholder="+57 300 123 4567"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="contact_email" className="flex items-center gap-1">
                                <Mail className="h-3 w-3" /> Email
                            </Label>
                            <Input
                                id="contact_email"
                                type="email"
                                value={profile.email || ''}
                                onChange={(e) => update('email', e.target.value)}
                                placeholder="contacto@academia.co"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="website" className="flex items-center gap-1">
                                <Globe className="h-3 w-3" /> Sitio Web
                            </Label>
                            <Input
                                id="website"
                                value={profile.website || ''}
                                onChange={(e) => update('website', e.target.value)}
                                placeholder="https://academia.co"
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Infrastructure Management */}
                <Card className="md:col-span-2 bg-primary/5 border-primary/20">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Building2 className="h-5 w-5 text-primary" />
                            Sedes e Infraestructura
                        </CardTitle>
                        <CardDescription>Gestiona tus sedes físicas y las instalaciones (canchas, gimnasios, etc.) disponibles.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid gap-4 md:grid-cols-2">
                            <Button
                                variant="outline"
                                className="h-auto py-4 flex flex-col items-center gap-2 border-primary/30 hover:bg-primary/10"
                                onClick={() => navigate('/branches')}
                            >
                                <MapPin className="h-6 w-6 text-primary" />
                                <div className="text-center">
                                    <div className="font-semibold">Gestionar Sedes</div>
                                    <div className="text-xs text-muted-foreground">Configurar sucursales y ubicaciones</div>
                                </div>
                            </Button>
                            <Button
                                variant="outline"
                                className="h-auto py-4 flex flex-col items-center gap-2 border-primary/30 hover:bg-primary/10"
                                onClick={() => navigate('/facilities')}
                            >
                                <Building2 className="h-6 w-6 text-primary" />
                                <div className="text-center">
                                    <div className="font-semibold">Gestionar Instalaciones</div>
                                    <div className="text-xs text-muted-foreground">Canchas, espacios y equipamiento</div>
                                </div>
                            </Button>
                        </div>
                    </CardContent>
                </Card>
                </div>
            </div>
    );
}
