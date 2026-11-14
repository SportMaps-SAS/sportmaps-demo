import { useEffect, useRef, useState } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { acceptPendingInvitations } from '@/lib/invitations/acceptPendingInvitations';
import { OnboardingShell, type ShellStep } from '@/components/onboarding/OnboardingShell';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PhoneInput } from '@/components/ui/phone-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { UserCircle, Activity, Loader2, ChevronLeft, ChevronRight, Check, KeyRound } from 'lucide-react';
import { SPORTS_LIST } from '@/lib/constants/sportsCatalog';
import { getUserFriendlyError } from '@/lib/error-translator';
import { toast } from 'sonner';
import { OnboardingSchoolCodeField } from '@/components/school-join/OnboardingSchoolCodeField';
import { formatJoinCode, isJoinCodeShape, readPendingJoinCode } from '@/lib/schoolJoinCode';

const EXPERIENCE_LEVELS = [
  { value: 'principiante', label: 'Principiante' },
  { value: 'intermedio', label: 'Intermedio' },
  { value: 'avanzado', label: 'Avanzado' },
  { value: 'profesional', label: 'Profesional / Competitivo' },
];

export default function AthleteOnboarding() {
  const { user, profile, loading: authLoading, updateProfile } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [dob, setDob] = useState(profile?.date_of_birth ?? '');
  const [sports, setSports] = useState<string[]>([]);
  const [level, setLevel] = useState('');
  const [bio, setBio] = useState(profile?.bio ?? '');
  // Código de escuela opcional (precargado si llegó por /unirse?codigo=… antes de registrarse).
  const [schoolCode, setSchoolCode] = useState(() => formatJoinCode(readPendingJoinCode() ?? ''));

  // Backstop de invitaciones: quien se registra SIN el link llega acá antes que
  // al dashboard (el gate de onboarding lo saca de /dashboard), así que el
  // backstop del dashboard nunca corría y la invitación quedaba 'pending' para
  // siempre. Se acepta acá, una vez por montaje, y se avisa a qué escuela quedó vinculado.
  const autoAcceptRan = useRef(false);
  useEffect(() => {
    if (!user || autoAcceptRan.current) return;
    autoAcceptRan.current = true;
    acceptPendingInvitations().then(({ schools }) => {
      if (schools.length) {
        toast.success(`Te vinculamos con ${schools.join(', ')}.`);
      }
    });
  }, [user]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (profile && profile.onboarding_completed) return <Navigate to="/dashboard" replace />;

  const toggleSport = (s: string) =>
    setSports((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const step1Done = fullName.trim().length >= 2 && phone.trim().length >= 7 && !!dob;
  const step2Done = sports.length > 0 && !!level;

  const handleFinish = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: fullName.trim(),
          phone: phone.trim(),
          date_of_birth: dob,
          bio: bio.trim() || null,
          sports_interests: sports,
          preferences: { ...(profile?.preferences ?? {}), experience_level: level },
        })
        .eq('id', user.id);
      if (error) throw error;

      const { error: rpcError } = await (supabase.rpc as any)('complete_onboarding');
      if (rpcError) throw rpcError;

      await updateProfile({}, { silent: true });
      toast.success('¡Perfil completo! Bienvenido a SportMaps.');
      navigate(
        isJoinCodeShape(schoolCode) ? `/unirse?codigo=${encodeURIComponent(formatJoinCode(schoolCode))}` : '/dashboard',
        { replace: true },
      );
    } catch (err) {
      console.error('Athlete onboarding failed:', err);
      toast.error(getUserFriendlyError(err));
      setSaving(false);
    }
  };

  const steps: ShellStep[] = [
    { id: 'datos', title: 'Tus datos', description: 'Información personal de contacto', icon: UserCircle, done: step > 1 || step1Done },
    { id: 'deporte', title: 'Tu deporte', description: 'Deportes que practicas y tu nivel', icon: Activity, done: step > 2 },
    { id: 'escuela', title: 'Tu escuela', description: 'Opcional: únete con el código de tu escuela', icon: KeyRound, done: false },
  ];

  const canAdvance = step === 1 ? step1Done : step2Done;

  const footer = (
    <>
      <Button variant="ghost" size="sm" onClick={() => setStep((p) => Math.max(1, p - 1))} disabled={step === 1 || saving}>
        <ChevronLeft className="h-4 w-4 mr-1" /> Anterior
      </Button>
      {step < 3 ? (
        <Button onClick={() => setStep(step + 1)} disabled={!canAdvance}>
          Siguiente <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      ) : (
        <Button onClick={handleFinish} disabled={saving || !canAdvance}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
          {isJoinCodeShape(schoolCode) ? 'Finalizar y unirme' : 'Finalizar'}
        </Button>
      )}
    </>
  );

  return (
    <OnboardingShell
      title="Completa tu perfil de atleta"
      steps={steps}
      currentStep={step - 1}
      onStepChange={(idx) => idx + 1 <= step && setStep(idx + 1)}
      footer={footer}
    >
      {step === 1 && (
        <div className="space-y-4">
          {profile?.avatar_url && (
            <div className="flex justify-center">
              <Avatar className="h-20 w-20 border-2 border-primary/20">
                <AvatarImage src={profile.avatar_url} className="object-cover" />
                <AvatarFallback>{fullName.charAt(0) || 'A'}</AvatarFallback>
              </Avatar>
            </div>
          )}
          <div className="space-y-2">
            <Label>Nombre completo *</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Tu nombre y apellido" maxLength={120} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Teléfono / WhatsApp *</Label>
              <PhoneInput value={phone} onChange={setPhone} placeholder="Número de celular" />
            </div>
            <div className="space-y-2">
              <Label>Fecha de nacimiento *</Label>
              <Input type="date" value={dob ?? ''} onChange={(e) => setDob(e.target.value)} max={todayColombia()} />
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Deportes que practicas *</Label>
            <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-1">
              {SPORTS_LIST.map((s) => (
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
            <Label>Nivel de experiencia *</Label>
            <Select value={level} onValueChange={setLevel}>
              <SelectTrigger><SelectValue placeholder="Selecciona tu nivel" /></SelectTrigger>
              <SelectContent>
                {EXPERIENCE_LEVELS.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Sobre ti (opcional)</Label>
            <Textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Cuéntanos sobre tus metas deportivas..." maxLength={500} rows={3} />
          </div>
        </div>
      )}

      {step === 3 && (
        <OnboardingSchoolCodeField value={schoolCode} onChange={setSchoolCode} />
      )}
    </OnboardingShell>
  );
}
