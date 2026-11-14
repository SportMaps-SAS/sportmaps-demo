import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { SPORTS_CATALOG } from '@/lib/constants/sportsCatalog';
import { CITY_LABEL } from '@/lib/colombian-cities';
import { BANK_LABEL } from '@/lib/colombian-banks';
import { CityCombobox } from '@/components/common/CityCombobox';
import { BankCombobox } from '@/components/common/BankCombobox';
import { useStorage } from '@/hooks/useStorage';
import { PhoneInput } from '@/components/ui/phone-input';
import { Minus, Plus, Dumbbell, MapPin, Clock, DollarSign, CreditCard, Camera, ChevronRight, ChevronLeft, Check, Search, ChevronsUpDown, Upload, Loader2, Video, Smartphone, Users } from 'lucide-react';
import { useActiveWorkPage } from '@/hooks/useActiveWorkPage';

const BFF_URL = import.meta.env.VITE_BFF_URL || 'http://localhost:3000';

const STEPS = [
  { id: 1, title: 'Tu Deporte', icon: Dumbbell, description: 'Especialidades y experiencia' },
  { id: 2, title: 'Modalidad', icon: MapPin, description: 'Cómo y dónde entrenas' },
  { id: 3, title: 'Disponibilidad', icon: Clock, description: 'Días y horarios' },
  { id: 4, title: 'Tarifas', icon: DollarSign, description: 'Precio por sesión' },
  { id: 5, title: 'Pagos', icon: CreditCard, description: 'Métodos de cobro' },
  { id: 6, title: 'Perfil', icon: Camera, description: 'Foto y presentación' },
];

async function callBff(path: string, method: string, body: any, token: string) {
  const res = await fetch(`${BFF_URL}/api/v1/trainer${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error en BFF');
  return res.json();
}

export default function TrainerOnboarding() {
  useActiveWorkPage();
  const { session, trainerSchoolId, trainerOnboardingStatus } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { uploadFile, uploading } = useStorage();

  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);

  // Step data state
  const [sport, setSport] = useState('');
  const [sportOpen, setSportOpen] = useState(false);
  const [specialties, setSpecialties] = useState('');
  const [expYears, setExpYears] = useState('');
  const [modality, setModality] = useState<'presencial' | 'virtual' | 'ambas'>('presencial');
  const [city, setCity] = useState('');
  const [rate, setRate] = useState('');
  const [rateNotes, setRateNotes] = useState('');
  const [nequi, setNequi] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [bio, setBio] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tagline, setTagline] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');

  const token = session?.access_token;

  // Utilize catalog of sports directly
  const allSports = SPORTS_CATALOG.map(d => ({
    id: d.id,
    nombre: d.nombre,
    slug: d.slug
  }));

  useEffect(() => {
    if (trainerOnboardingStatus === 'completed') {
      navigate('/trainer/dashboard', { replace: true });
    }
  }, [trainerOnboardingStatus, navigate]);

  const formatNumber = (num: string | number) => {
    if (!num) return '';
    const cleanNumber = String(num).replace(/\D/g, "");
    return cleanNumber.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  };

  const parseNumber = (str: string) => {
    return str.replace(/\D/g, "");
  };

  const getStepData = (step: number): Record<string, any> => {
    switch (step) {
      case 1:
        return {
          primary_sport: sport,
          specialties: specialties.split(',').map(s => s.trim()).filter(Boolean),
          experience_years: parseInt(expYears) || null,
        };
      case 2:
        return { modality, city: CITY_LABEL[city] || city };
      case 3:
        return {}; // Disponibilidad: se configura por separado en /trainer/availability
      case 4:
        return { rate_per_session: parseFloat(parseNumber(rate)) || null, rate_currency: 'COP', rate_notes: rateNotes };
      case 5:
        return {
          payment_settings: {
            nequi_number:        nequi,
            bank_code:           bankCode,
            bank_name:           BANK_LABEL[bankCode] || '',
            bank_account_number: bankAccountNumber,
          },
          whatsapp_number: whatsapp,
        };
      case 6:
        return { 
          display_name: displayName, 
          bio, 
          avatar_url: avatarUrl || null,
          tagline
        };
      default:
        return {};
    }
  };

  const handleNext = async () => {
    if (!token) return;

    // Validaciones de campos obligatorios
    if (currentStep === 1 && !sport) {
      toast({ title: 'Campo requerido', description: 'Por favor selecciona tu deporte principal.', variant: 'destructive' });
      return;
    }
    if (currentStep === 6 && !displayName) {
      toast({ title: 'Campo requerido', description: 'Por favor ingresa tu nombre de perfil o marca.', variant: 'destructive' });
      return;
    }

    // El paso 3 es puramente informativo, no enviamos nada al BFF
    if (currentStep === 3) {
      setCurrentStep(prev => prev + 1);
      return;
    }

    setIsLoading(true);
    try {
      await callBff('/onboarding/step', 'POST', { step: currentStep, data: getStepData(currentStep) }, token);

      if (currentStep === 6) {
        await callBff('/onboarding/complete', 'POST', {}, token);
        toast({ title: '¡Onboarding completado!', description: 'Tu workspace está listo. Bienvenido.' });
        window.location.href = '/trainer/dashboard';
      } else {
        setCurrentStep(prev => prev + 1);
      }
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const progress = ((currentStep - 1) / STEPS.length) * 100;
  const stepInfo = STEPS[currentStep - 1];

  // Validacion por step. Step 3 (disponibilidad) y 6 (perfil) son
  // opcionales — siempre permiten avanzar. Los demas exigen su data.
  const stepValid = (() => {
    switch (currentStep) {
      case 1: return !!sport;                         // deporte principal obligatorio
      case 2: return !!city;                          // ciudad obligatoria
      case 3: return true;                            // disponibilidad se configura despues
      case 4: return !!rate && Number(rate) > 0;      // tarifa requerida
      case 5: return !!nequi || !!bankCode;           // al menos un metodo de cobro
      case 6: return true;                            // perfil opcional, foto/bio recomendadas pero no bloquean
      default: return true;
    }
  })();

  return (
    <div className="screen-safe bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center">
      <div className="w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/20 rounded-full px-4 py-1.5 mb-4">
            <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />
            <span className="text-xs font-bold uppercase tracking-widest text-primary">Configuración inicial</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight mb-2">Configura tu workspace</h1>
          <p className="text-muted-foreground">Paso {currentStep} de {STEPS.length}: <span className="font-medium text-foreground">{stepInfo.description}</span></p>
        </div>

        {/* Progress */}
        <Progress value={progress} className="h-1.5 mb-8" />

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-8 flex-wrap">
          {STEPS.map((step) => {
            const Icon = step.icon;
            const isDone = currentStep > step.id;
            const isCurrent = currentStep === step.id;
            return (
              <div key={step.id} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300 ${
                isCurrent ? 'bg-primary text-primary-foreground shadow-md shadow-primary/30' :
                isDone ? 'bg-primary/15 text-primary' :
                'bg-muted text-muted-foreground'
              }`}>
                {isDone ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                <span className="hidden sm:inline">{step.title}</span>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <Card className="shadow-xl border-border/50 animate-in fade-in slide-in-from-bottom-4 duration-400">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <stepInfo.icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle>{stepInfo.title}</CardTitle>
                <CardDescription>{stepInfo.description}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {currentStep === 1 && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Deporte principal</label>
                  <Popover open={sportOpen} onOpenChange={setSportOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={sportOpen}
                        className={cn(
                          "w-full justify-between font-normal bg-background border-input hover:bg-muted/50",
                          !sport && "text-muted-foreground"
                        )}
                      >
                        <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                        {sport 
                          ? sport
                          : "Buscar Deporte..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Filtrar por nombre..." className="text-sm h-10 w-full" />
                        <CommandEmpty>No se encontró el deporte.</CommandEmpty>
                        <CommandGroup className="max-h-72 overflow-y-auto">
                          {allSports.map((s) => (
                            <CommandItem
                              key={s.id}
                              value={s.nombre}
                              onSelect={() => {
                                setSport(s.nombre);
                                setSportOpen(false);
                              }}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  sport === s.nombre ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {s.nombre}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Especialidades <span className="text-muted-foreground text-xs">(separadas por coma)</span></label>
                  <Input
                    value={specialties}
                    onChange={e => setSpecialties(e.target.value.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñÜü\s,]/g, ''))}
                    placeholder="Ej: Porteros, Fuerza, Resistencia..."
                  />
                </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Años de experiencia</label>
                    <div className="flex h-11 items-center bg-background/50 border border-border/40 rounded-xl overflow-hidden group focus-within:border-primary/50 transition-colors">
                      <button 
                        type="button" 
                        className="h-full w-12 flex items-center justify-center border-r border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                        onClick={() => {
                          const val = parseInt(expYears) || 0;
                          if (val > 0) setExpYears(String(val - 1));
                        }}
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <div className="flex-1 flex items-center justify-center font-bold text-primary px-4 bg-background/20">
                        {expYears || '0'} <span className="ml-1.5 text-muted-foreground text-[10px] font-normal uppercase tracking-tighter">años</span>
                      </div>
                      <button 
                        type="button" 
                        className="h-full w-12 flex items-center justify-center border-l border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                        onClick={() => {
                          const val = parseInt(expYears) || 0;
                          setExpYears(String(val + 1));
                        }}
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
              </>
            )}

            {currentStep === 2 && (
              <>
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
                        onClick={() => setModality(opt.id as any)}
                        className={cn(
                          "flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all duration-200 gap-2",
                          modality === opt.id 
                            ? "border-primary bg-primary/10 shadow-lg shadow-primary/5" 
                            : "border-border/40 bg-background/50 hover:border-border/80"
                        )}
                      >
                        <div className={cn(
                          "h-10 w-10 rounded-full flex items-center justify-center",
                          modality === opt.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                        )}>
                          <opt.icon className="h-5 w-5" />
                        </div>
                        <div className="text-center">
                          <p className={cn("text-sm font-bold", modality === opt.id ? "text-foreground" : "text-muted-foreground")}>
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
                  <CityCombobox value={city} onChange={setCity} />
                </div>
              </>
            )}

            {currentStep === 3 && (
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-5 text-center space-y-2">
                <Clock className="h-10 w-10 text-primary mx-auto" />
                <p className="font-semibold">Configura tu disponibilidad después</p>
                <p className="text-sm text-muted-foreground">Una vez completes el onboarding podrás definir tus horarios detallados desde la sección <strong>Disponibilidad</strong> del dashboard.</p>
              </div>
            )}

            {currentStep === 4 && (
              <>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Tarifa por sesión</label>
                    <div className="flex h-11 bg-background/50 border border-border/40 rounded-xl overflow-hidden focus-within:border-primary/50 transition-colors">
                      <button 
                        type="button" 
                        className="w-10 flex items-center justify-center border-r border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                        onClick={() => {
                          const val = parseInt(parseNumber(rate)) || 0;
                          if (val >= 5000) setRate(String(val - 5000));
                        }}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <div className="relative flex-1 flex items-center group">
                        <DollarSign className="absolute left-3 h-4 w-4 text-primary font-bold" />
                        <Input 
                          className="pl-8 border-0 bg-transparent h-full text-base font-bold focus-visible:ring-0 focus-visible:ring-offset-0" 
                          type="text" 
                          value={formatNumber(rate)} 
                          onChange={e => setRate(parseNumber(e.target.value))} 
                          placeholder="80.000" 
                        />
                        <span className="absolute right-3 text-xs font-bold text-muted-foreground">COP</span>
                      </div>
                      <button 
                        type="button" 
                        className="w-10 flex items-center justify-center border-l border-border/40 hover:bg-primary/10 hover:text-primary transition-colors text-muted-foreground"
                        onClick={() => {
                          const val = parseInt(parseNumber(rate)) || 0;
                          setRate(String(val + 5000));
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Sugerencias rápidas (COP)</label>
                    <div className="flex flex-wrap gap-2 items-center">
                      {[60000, 80000, 100000, 120000].map((amt) => (
                        <button
                          key={amt}
                          type="button"
                          onClick={() => setRate(String(amt))}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-xs font-bold transition-all border",
                            rate === String(amt)
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
                <div className="space-y-2">
                  <label className="text-sm font-medium">Notas sobre tarifas <span className="text-muted-foreground text-xs">(opcional)</span></label>
                  <Textarea value={rateNotes} onChange={e => setRateNotes(e.target.value)} placeholder="Ej: Descuento del 10% en paquetes de 10 sesiones..." rows={3} />
                </div>
              </>
            )}

            {currentStep === 5 && (
              <>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Número Nequi</label>
                  <div className="relative group">
                    <CreditCard className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-primary font-bold transition-transform group-focus-within:scale-110" />
                    <Input 
                      className="pl-10 h-11 bg-background/50 border-border/40 rounded-xl focus-visible:ring-primary/20 transition-all" 
                      type="tel"
                      maxLength={10}
                      value={nequi} 
                      onChange={e => setNequi(e.target.value.replace(/\D/g, '').slice(0, 10))} 
                      placeholder="Número de 10 dígitos" 
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Banco</label>
                  <BankCombobox value={bankCode} onChange={setBankCode} />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Número de cuenta</label>
                  <Input
                    className="h-11 bg-background/50 border-border/40 rounded-xl"
                    type="text"
                    inputMode="numeric"
                    value={bankAccountNumber}
                    onChange={e => setBankAccountNumber(e.target.value.replace(/\D/g, ''))}
                    placeholder="123-456789-00"
                    disabled={!bankCode}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">WhatsApp de contacto</label>
                  <PhoneInput 
                    value={whatsapp} 
                    onChange={setWhatsapp} 
                    placeholder="Número de celular" 
                  />
                </div>
              </>
            )}

            {currentStep === 6 && (
              <>
                <div className="space-y-4 mb-4">
                  <label className="text-sm font-medium">Foto de perfil (Opcional)</label>
                  <div className="flex items-center gap-4">
                    <Avatar className="h-20 w-20 border-2 border-primary/20">
                      {avatarUrl ? (
                        <AvatarImage src={avatarUrl} alt="Avatar Preview" />
                      ) : (
                        <AvatarFallback className="bg-primary/5 text-primary">
                          <Camera className="h-8 w-8 opacity-50" />
                        </AvatarFallback>
                      )}
                    </Avatar>
                    <div>
                      <div className="relative">
                        <Input 
                          type="file" 
                          accept="image/*"
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                          disabled={uploading}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            if (!session?.user?.id) return;
                            const url = await uploadFile(file, 'avatars', `trainer-profiles/${session.user.id}`);
                            if (url) setAvatarUrl(url);
                          }}
                        />
                        <Button type="button" variant="outline" disabled={uploading}>
                          {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                          {uploading ? 'Subiendo...' : 'Subir imagen'}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">Formatos: JPG, PNG. Máx 5MB.</p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Nombre para mostrar</label>
                  <Input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Ej: Carlos Ortiz — Entrenador Personal" />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Tagline <span className="text-muted-foreground text-xs">(frase corta)</span>
                  </label>
                  <Input 
                    value={tagline} 
                    onChange={e => setTagline(e.target.value)} 
                    placeholder="Ej: Transforma tu cuerpo, transforma tu vida" 
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Bio / Presentación</label>
                  <Textarea value={bio} onChange={e => setBio(e.target.value)} placeholder="Cuéntales a tus clientes quién eres y qué ofreces..." rows={4} />
                </div>
              </>
            )}

          </CardContent>
        </Card>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <Button
            variant="outline"
            onClick={() => setCurrentStep(prev => Math.max(1, prev - 1))}
            disabled={currentStep === 1 || isLoading}
            className="gap-2"
          >
            <ChevronLeft className="h-4 w-4" />
            Anterior
          </Button>
          <Button onClick={handleNext} disabled={isLoading || !stepValid} className="gap-2"
                  title={stepValid ? 'Continuar' : 'Completa los campos requeridos para continuar'}>
            {currentStep === 6 ? 'Finalizar' : 'Siguiente'}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
