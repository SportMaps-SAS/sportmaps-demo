import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { Badge } from '@/components/ui/badge';
import { Building, ImagePlus, Loader2, ChevronLeft, ChevronRight, Trophy } from 'lucide-react';
import { sanitizeText } from '@/lib/inputSanitizers';
import { OnboardingShell, type ShellStep } from '@/components/onboarding/OnboardingShell';
import { CityCombobox } from '@/components/common/CityCombobox';
import { comprimirParaSubir } from '@/lib/imageCompression';

/**
 * Onboarding corto del organizador (spec organizador-torneos-modulo-aparte §6, B7):
 *   1. Organización: nombre, ciudad, deportes (y una descripción opcional).
 *   2. Logo (opcional).
 * Termina en «crea tu primer torneo». La organización es una fila de `schools` con
 * school_type 'event_organizer'; la crea/completa la RPC `create_organizer_org`, que se ata
 * siempre al usuario de la sesión. Los cobros y la verificación se configuran luego desde
 * la escuela/organización (Configuración), no aquí.
 */

const AVAILABLE_SPORTS = [
  'Fútbol', 'Fútbol Sala', 'Baloncesto', 'Voleibol', 'Tenis', 'Ajedrez', 'Natación',
  'Patinaje', 'Gimnasia', 'Porrismo', 'Atletismo', 'Ciclismo', 'Otro',
];

/** Ruta a la que se entra al terminar: el primer torneo, con el asistente rápido. */
export const ORGANIZER_AFTER_ONBOARDING = '/school/tournaments/nuevo-rapido';

export default function OrganizerOnboardingPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const [sports, setSports] = useState<string[]>([]);
  const [logoFile, setLogoFile] = useState<File | null>(null);

  const toggleSport = (s: string) =>
    setSports((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const step1Done = name.trim().length >= 2 && !!city && sports.length > 0;

  /** Sube el logo (si lo hay) y devuelve su URL pública https; null si no hay o falla (no frena el alta). */
  const subirLogo = async (): Promise<string | null> => {
    if (!logoFile || !user?.id) return null;
    try {
      const comprimido = await comprimirParaSubir(logoFile, 'logo');
      const ext = (comprimido.name.split('.').pop() || 'png').toLowerCase();
      const path = `${user.id}/organizer-logo-${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('avatars').upload(path, comprimido, { cacheControl: '3600', upsert: false, contentType: comprimido.type || undefined });
      if (error) throw error;
      return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
    } catch (err) {
      console.error('Logo del organizador:', err);
      toast({ title: 'No se pudo subir el logo', description: 'Puedes agregarlo después en Configuración.' });
      return null;
    }
  };

  const terminar = async () => {
    setLoading(true);
    try {
      const logoUrl = await subirLogo();
      const { error } = await (supabase.rpc as any)('create_organizer_org', {
        p_name: name.trim(),
        p_city: city || null,
        p_sports: sports,
        p_description: bio.trim() || null,
        p_logo_url: logoUrl,
      });
      if (error) throw error;
      toast({ title: '¡Listo!', description: 'Tu organización está creada. Crea tu primer torneo.' });
      // Recarga completa: el contexto de escuela y el menú nacen con la membresía recién creada.
      window.location.assign(ORGANIZER_AFTER_ONBOARDING);
    } catch (err: any) {
      console.error('create_organizer_org:', err);
      toast({ title: 'No se pudo crear tu organización', description: err?.message || 'Intenta de nuevo.', variant: 'destructive' });
      setLoading(false);
    }
  };

  const shellSteps: ShellStep[] = [
    { id: 'organization', title: 'Organización', description: 'Nombre, ciudad y deportes que cubres', icon: Building, done: step > 1 },
    { id: 'logo', title: 'Logo', description: 'La cara de tus torneos (opcional)', icon: ImagePlus, done: false },
  ];

  const footer = (
    <>
      <Button variant="ghost" size="sm" onClick={() => setStep(1)} disabled={step === 1 || loading}>
        <ChevronLeft className="h-4 w-4 mr-1" /> Anterior
      </Button>
      <div className="flex items-center gap-2">
        {step === 1 && (
          <Button onClick={() => setStep(2)} disabled={!step1Done} title={step1Done ? 'Continuar' : 'Completa nombre, ciudad y al menos un deporte'}>
            Siguiente <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
        {step === 2 && (
          <Button onClick={terminar} disabled={loading || !step1Done}>
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trophy className="h-4 w-4 mr-2" />}
            Crear mi primer torneo
          </Button>
        )}
      </div>
    </>
  );

  return (
    <OnboardingShell
      title="Portal de Organizador"
      eyebrow="Configuración inicial"
      steps={shellSteps}
      currentStep={step - 1}
      onStepChange={(idx) => idx + 1 <= step && setStep(idx + 1)}
      footer={footer}
    >
      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="org-name">Nombre de la organización *</Label>
              <Input
                id="org-name"
                value={name}
                onChange={(e) => setName(sanitizeText(e.target.value))}
                placeholder="Ej: Liga de Voleibol del Valle"
                maxLength={120}
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>Ciudad principal *</Label>
              <CityCombobox value={city} onChange={setCity} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Deportes que cubres *</Label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_SPORTS.map((s) => (
                <Badge
                  key={s}
                  variant={sports.includes(s) ? 'default' : 'outline'}
                  className="cursor-pointer px-3 py-1.5 text-sm hover:bg-primary/10"
                  onClick={() => toggleSport(s)}
                >
                  {s}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Selecciona al menos uno.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="org-bio">Descripción (opcional)</Label>
            <Textarea
              id="org-bio"
              value={bio}
              onChange={(e) => setBio(sanitizeText(e.target.value))}
              placeholder="Cuéntales a los equipos quién eres y qué torneos organizas."
              rows={3}
              maxLength={1000}
            />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-logo">Logo de tu organización (opcional)</Label>
            <Input id="org-logo" type="file" accept="image/*" onChange={(e) => setLogoFile(e.target.files?.[0] ?? null)} />
            <p className="text-xs text-muted-foreground">
              Aparece en la página pública de tus torneos. Puedes cambiarlo después en Configuración.
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1">
            <p className="font-medium">{name || 'Tu organización'}</p>
            <p className="text-muted-foreground">{[city, sports.join(', ')].filter(Boolean).join(' · ')}</p>
            <p className="text-xs text-muted-foreground pt-1">
              Plan Gratis: 1 torneo activo, página pública y marcador en vivo. Sin tarjeta.
            </p>
          </div>
        </div>
      )}
    </OnboardingShell>
  );
}
