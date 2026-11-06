import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Eye, EyeOff, MailCheck, Mail, School, Check, ChevronsUpDown, Search, User, Phone, Lock, Calendar as CalendarIcon, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { USER_ROLES } from '@/constants/roles';
import { Controller } from 'react-hook-form';
import { useToast } from '@/hooks/use-toast';
import { AlertCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useInvitationBranding } from '@/hooks/useInvitationBranding';
import { usePublicTenant } from '@/hooks/usePublicTenant';
import { getUserFriendlyError } from '@/lib/error-translator';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { useSportsCatalog } from '@/hooks/useSportsCatalog';
import { GoogleSignInButton, AuthDivider } from '@/components/auth/GoogleSignInButton';

// Roles que representan instituciones/negocios (no personas físicas)
// 'facility_manager' = dueño de espacios («Club / Canchas»): una escuela-venue
// (school_type 'venue') sin equipos ni atletas. Es un negocio, no una persona.
const INSTITUTION_ROLES = ['school', 'school_admin', 'store_owner', 'external_vendor', 'organizer', 'personal_trainer', 'facility_manager'];

// Edad mínima para abrir cuenta propia. Los menores NO tienen cuenta en
// SportMaps: el acudiente los registra como hijos bajo su propio perfil
// (ver la Política de Privacidad, sección de menores de edad). Esto sostiene
// la declaración de "público objetivo: adultos" en Google Play y App Store —
// si un menor pudiera auto-registrarse, aplicaría la Families Policy.
const MIN_SELF_SIGNUP_AGE = 18;

/** Edad cumplida a hoy según una fecha ISO (yyyy-mm-dd). null si no parsea. */
function ageFromDateOfBirth(iso: string | undefined): number | null {
  if (!iso || iso.trim() === '') return null;
  const dob = new Date(iso);
  if (Number.isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  // Aún no ha llegado el cumpleaños de este año.
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }
  return age;
}

const registerSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  fullName: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  phone: z.string().regex(/^\+?[0-9\s-]*$/, 'Formato de teléfono inválido').optional().or(z.literal('')),
  dateOfBirth: z.string().optional(),
  // Acudiente: en vez de la fecha de nacimiento (4 clics de calendario que no
  // aportan al vínculo con la escuela) declara la mayoría de edad con una casilla.
  isAdult: z.boolean().optional(),
  code: z.string().optional(),
  role: z.string().min(1, 'Selecciona un rol'),
  schoolName: z.string().optional(),
  // uuid desde que el catálogo se lee de `sports_categories`; number cuando el
  // hook cae en la constante de respaldo. Estaba en z.number() y el uuid no
  // pasaba la validación: la escuela elegía su deporte y el formulario se
  // negaba a enviarse, sin que el error apuntara a nada visible.
  sportId: z.union([z.string(), z.number()]).optional(),
  acceptTerms: z.boolean().refine(val => val === true, {
    message: 'Debes aceptar los términos y condiciones para continuar',
  }),
}).refine((data) => {
  if (data.role === 'parent') return true; // el acudiente declara la mayoría de edad con la casilla
  if (!INSTITUTION_ROLES.includes(data.role) && (!data.dateOfBirth || data.dateOfBirth.trim() === '')) {
    return false;
  }
  return true;
}, {
  message: 'La fecha de nacimiento es requerida',
  path: ['dateOfBirth'],
}).refine((data) => {
  // Gate de edad: solo personas físicas mayores de edad abren cuenta propia.
  if (INSTITUTION_ROLES.includes(data.role) || data.role === 'parent') return true;
  const age = ageFromDateOfBirth(data.dateOfBirth);
  if (age === null) return true; // el refine anterior ya exige la fecha
  return age >= MIN_SELF_SIGNUP_AGE;
}, {
  message:
    'Debes ser mayor de edad para crear una cuenta. Si eres menor, pídele a tu padre, madre o acudiente que cree su cuenta y te registre como deportista a su cargo.',
  path: ['dateOfBirth'],
}).refine((data) => data.role !== 'parent' || data.isAdult === true, {
  message: 'Confirma que eres mayor de edad para registrarte como acudiente',
  path: ['isAdult'],
}).refine((data) => {
  // El WhatsApp es la identidad del acudiente (el bot lo reconoce por el
  // número y los recordatorios de cobro salen por ahí). Se pide una sola vez,
  // acá, y ya no en el onboarding.
  if (data.role !== 'parent') return true;
  return (data.phone || '').replace(/\D/g, '').length >= 7;
}, {
  message: 'Tu WhatsApp es obligatorio: por ahí te llegan los cobros y las novedades del menor',
  path: ['phone'],
}).refine((data) => {
  if ((data.role === 'school' || data.role === 'facility_manager') && (!data.schoolName || data.schoolName.trim() === '')) {
    return false;
  }
  return true;
}, {
  message: 'El nombre es requerido',
  path: ['schoolName'],
}).refine((data) => {
  if (data.role === 'school' && !data.sportId) {
    return false;
  }
  return true;
}, {
  message: 'El deporte es requerido para academias',
  path: ['sportId'],
});

type RegisterFormData = z.infer<typeof registerSchema>;

interface RoleOption {
  id: string;
  name: string;
  display_name: string;
}

const ROLE_DISPLAY_NAMES: Record<string, string> = {
  athlete: '🏃 Deportista/Atleta',
  parent: '👨‍👩‍👧 Padre/Madre',
  coach: '🎓 Entrenador/Coach',
  school: '🏫 Escuela/Centro Deportivo',
  school_admin: '🏢 Administrador de Sede',
  reporter: '📊 Súper Usuario (Reporter)',
  guest: '👤 Invitado',
  admin: '🛡️ Administrador',
  super_admin: '🛡️ Super Administrador',
  wellness_professional: '💚 Profesional Bienestar',
  personal_trainer: '🏋️ Entrenador Personal',
  external_vendor: '🛍️ Vendedor / Marca',
  store_owner: '🏪 Dueño de Tienda',
  organizer: '📋 Organizador',
};

export default function RegisterPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [emailForDisplay, setEmailForDisplay] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [userExistsError, setUserExistsError] = useState(false);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [pwStrength, setPwStrength] = useState(0);
  const checkPw = (val: string) => {
    let strength = 0;
    if (val.length >= 8) strength++;
    if (val.length >= 12) strength++;
    if (/[A-Z]/.test(val) && /[0-9]/.test(val)) strength++;
    if (/[^A-Za-z0-9]/.test(val)) strength++;
    setPwStrength(strength);
  };

  const [sportOpen, setSportOpen] = useState(false);
  // Catálogo leído de la BD (con la constante como respaldo). Antes era
  // SPORTS_CATALOG directo, y actualizar un deporte exigía desplegar front.
  const { sports: allSports } = useSportsCatalog();
  
  const inviteId = searchParams.get('invite');
  const inviteEmail = searchParams.get('email');
  const inviteRole = searchParams.get('role');
  const referralCode = searchParams.get('ref');
  const [invitationInfo, setInvitationInfo] = useState<{
    school_name: string;
    role_to_assign: string;
    child_name?: string;
    program_name?: string;
    monthly_fee?: number;
  } | null>(null);

  const inviteBranding = useInvitationBranding(inviteId);

  // Esta es LA pantalla donde aterrizan las familias que invita la escuela: los
  // links de invitacion y el QR de inscripcion llevan ?t=<slug>. Sin esto, el
  // padre abre el link de su club y lo recibe una pantalla verde de SportMaps.
  const { tenant } = usePublicTenant();
  const colorMarca = /^#[0-9A-Fa-f]{6}$/.test(tenant?.branding_settings?.primary_color ?? '')
    ? tenant!.branding_settings!.primary_color!
    : null;

  const { signUp, user } = useAuth();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    control,
    formState: { errors },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      code: searchParams.get('code') || '',
      role: searchParams.get('role') || '',
      sportId: undefined,
      // Las casillas arrancan en false, no undefined: con undefined z.boolean()
      // aborta el parse del objeto y Zod ya no evalúa NINGÚN refine cruzado
      // (mayoría de edad, WhatsApp, contraseña), así que el usuario veía un
      // "Required" en inglés y nada más.
      acceptTerms: false,
      isAdult: false,
    }
  });

  const selectedSportId = watch('sportId');
  const selectedSport = useMemo(() => 
    allSports.find(s => s.id === selectedSportId), 
    [selectedSportId, allSports]
  );

  useEffect(() => {
    const roleParam = searchParams.get('role');
    if (roleParam) {
      setValue('role', roleParam);
    }
    if (inviteEmail) {
      setValue('email', inviteEmail);
    }
    const invitePhone = searchParams.get('phone');
    if (invitePhone) {
      setValue('phone', invitePhone);
    }
    const inviteName = searchParams.get('name');
    if (inviteName) {
      setValue('fullName', inviteName);
    }
  }, [searchParams, setValue, inviteEmail]);

  useEffect(() => {
    if (!inviteId) return;
    const fetchInvite = async () => {
      try {
        const { data } = await supabase.rpc('get_invitation_details', {
          p_invite_id: inviteId
        });
        if (data && (data as any).length > 0) {
          const invite = (data as any)[0];
          setInvitationInfo({
            school_name: invite.school_name || 'Tu Academia',
            role_to_assign: invite.role_to_assign,
            child_name: invite.child_name,
            program_name: invite.program_name,
            monthly_fee: invite.monthly_fee,
          });
          if (invite.school_name) {
            setValue('schoolName', invite.school_name);
          }
        }
      } catch (err) {
        console.warn('Invitation validation failed or ID is invalid.', err);
      }
    };
    fetchInvite();
  }, [inviteId]);

  useEffect(() => {
    const fetchRoles = async () => {
      try {
        const { data } = await supabase
          .from('roles')
          .select('id, name, display_name')
          .eq('is_visible', true)
          .order('display_name');
        if (data) setRoles(data);
      } catch {
        console.error("Error fetching roles");
      }
    };
    fetchRoles();
  }, []);

  const handleAcceptLoggedIn = useCallback(async () => {
    if (!inviteId) return;
    setIsLoading(true);
    try {
      const { error } = await (supabase.rpc as any)('accept_invitation_pro', { p_invite_id: inviteId });
      if (error) throw error;
      // El acudiente invitado ya dio nombre, teléfono y contraseña, y el menor
      // viene precargado por la escuela: no hay nada que el onboarding de
      // /onboarding/parent pueda pedirle. Se cierra acá para que el dashboard no
      // lo desvíe a dos pantallas más. Si falla, el gate del dashboard lo lleva
      // al onboarding como antes; no es bloqueante.
      const { error: onboardingErr } = await (supabase.rpc as any)('complete_onboarding');
      if (onboardingErr) console.warn('[register] complete_onboarding falló, el dashboard pedirá el onboarding:', onboardingErr);
      toast({ title: "¡Configuración lista!", description: "Se ha vinculado tu perfil. Redirigiendo..." });
      localStorage.removeItem('pending_invite_id');
      window.location.href = '/dashboard';
    } catch (err: any) {
      toast({ title: "Error al aceptar", description: getUserFriendlyError(err), variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [inviteId, toast]);

  // El registro deja sesión activa al instante (el correo se autoconfirma en
  // este ambiente: email_confirmed_at queda a milisegundos de created_at). Con
  // la aceptación colgada de un clic, el acudiente se quedaba mirando «revisa
  // tu correo» —una pantalla sin ninguna acción real pendiente— y se iba sin
  // vincularse nunca: 17 cuentas confirmadas y 0 en school_members.
  // Se dispara sola, una vez, en cuanto hay sesión e invitación.
  const autoAcceptedRef = useRef(false);
  useEffect(() => {
    if (!user || !inviteId || autoAcceptedRef.current) return;
    autoAcceptedRef.current = true;
    handleAcceptLoggedIn();
  }, [user, inviteId, handleAcceptLoggedIn]);

  useEffect(() => {
    if (user && inviteEmail && user.email !== inviteEmail && !isSubmitted) {
      supabase.auth.signOut().then(() => { window.location.reload(); });
    }
  }, [user, inviteEmail, isSubmitted]);

  if (user && !isSubmitted && (!inviteEmail || user.email === inviteEmail)) {
    return <Navigate to="/dashboard" replace />;
  }

  const onSubmit = async (data: RegisterFormData) => {
    setIsLoading(true);
    setEmailForDisplay(data.email);
    try {
      const metadata: any = {
        full_name: data.fullName,
        phone: data.phone,
        date_of_birth: data.dateOfBirth,
        role: data.role as any,
        invitation_code: data.code,
        school_name: data.schoolName,
        referral_code: referralCode || undefined,
      };

      if (data.role === 'facility_manager') {
        // Dueño de espacios: la cuenta nace con rol facility_manager y una
        // escuela-venue (school_type 'venue'). Sin deporte, categorías ni equipos.
        // Lo materializa handle_new_user (ver reporte: hoy su lista blanca de
        // roles NO incluye facility_manager y la escuela se crea sin school_type).
        metadata.school_type = 'venue';
      }

      if (data.role === 'school' && selectedSport) {
        metadata.sport_id = selectedSport.id;
        metadata.sport_name = selectedSport.nombre;
        const defaultCategories = [];
        if (selectedSport.categoriasCompetencia) {
          for (const key in selectedSport.categoriasCompetencia) {
            if (Array.isArray(selectedSport.categoriasCompetencia[key])) {
              defaultCategories.push(...selectedSport.categoriasCompetencia[key]);
            }
          }
        }
        metadata.suggested_categories = defaultCategories.slice(0, 10);
      }

      await signUp(data.email, data.password, metadata);
      setIsSubmitted(true);

      if (data.role === 'personal_trainer') {
        // No redirect yet — user must verify email first.
        // After verification & login, AuthContext will detect isPersonalTrainer
        // and the router guard will redirect to /trainer/onboarding.
        localStorage.setItem('post_register_role', 'personal_trainer');
      }

      if (inviteId) {
        localStorage.setItem('pending_invite_id', inviteId);
      }
    } catch (error: any) {
      console.error("Registration error:", error);
      if (error?.message?.includes('User already registered') || error?.message?.includes('already exist')) {
        setUserExistsError(true);
        if (inviteId) localStorage.setItem('pending_invite_id', inviteId);
      }
      toast({
        variant: "destructive",
        title: "Error de registro",
        description: getUserFriendlyError(error),
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (user && inviteId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a1a0d] p-4 font-poppins">
        <Card className="w-full max-w-md shadow-2xl border-t-8 border-[#248223] bg-[#0f2614] text-[#f5f7f2] animate-in fade-in zoom-in duration-300">
          <CardContent className="pt-10 flex flex-col items-center text-center">
            <div className="flex justify-center mb-6">
              {inviteBranding?.logo_url ? (
                <img src={inviteBranding.logo_url} alt="Logo de la Academia" className="h-16 w-auto object-contain" />
              ) : (
                <div className="bg-[#248223]/20 p-4 rounded-full">
                  <School className="w-12 h-12 text-[#2ea82d]" />
                </div>
              )}
            </div>
            <h2 className="text-2xl font-bold mb-2">Invitación Pendiente</h2>
            {invitationInfo ? (
              <>
                <p className="text-[#8a9186] mb-6">
                  Ya tienes una sesión activa como <strong className="text-[#2ea82d]">{user.email}</strong>.<br />
                  ¿Deseas aceptar la invitación de <strong className="text-[#2ea82d]">{invitationInfo.school_name}</strong>?
                </p>
                <div className="flex flex-col gap-3 w-full">
                  <Button onClick={handleAcceptLoggedIn} disabled={isLoading} className="w-full bg-[#248223] hover:bg-[#2ea82d] text-white h-12 text-lg font-bold">
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : null}
                    Aceptar Invitación Ahora
                  </Button>
                  <Button asChild variant="ghost" className="w-full text-[#8a9186] hover:text-[#2ea82d] hover:bg-white/5">
                    <Link to="/dashboard">Ir al Dashboard directamente</Link>
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 py-4">
                <Loader2 className="w-8 h-8 animate-spin text-[#2ea82d]" />
                <p className="text-sm text-[#8a9186]">Validando invitación...</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }
  
  if (user && !inviteId) {
    return <Navigate to="/dashboard" />;
  }

  if (isSubmitted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a1a0d] p-4 font-poppins">
        <Card className="w-full max-w-md shadow-2xl border-t-8 border-[#248223] bg-[#0f2614] text-[#f5f7f2] animate-in fade-in zoom-in duration-300">
          <CardContent className="pt-10 flex flex-col items-center text-center">
            <div className="bg-[#248223]/20 p-4 rounded-full mb-6">
              <MailCheck className="w-12 h-12 text-[#2ea82d]" />
            </div>
            <h2 className="text-2xl font-bold text-[#2ea82d] mb-4">¡Casi listo!</h2>
            <p className="text-[#8a9186] mb-6 text-center">
              Hemos enviado un enlace de verificación a:<br />
              <span className="text-[#f5f7f2] font-semibold">{emailForDisplay}</span>
            </p>
            <div className="bg-[#FB9F1E]/10 border border-[#FB9F1E]/20 p-4 rounded-xl mb-8 text-sm text-[#FB9F1E]">
              <p className="font-medium">¿No ves el correo?</p>
              <p>Revisa tu carpeta de <strong>Spam</strong> o Promociones.</p>
            </div>
            <Button asChild variant="outline" className="w-full border-[#248223] text-[#248223] hover:bg-[#248223] hover:text-white transition-colors bg-transparent h-12">
              <Link to="/login">Volver al Inicio de Sesión</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const roleValue = watch('role');
  const showDateOfBirth = roleValue && !INSTITUTION_ROLES.includes(roleValue) && roleValue !== 'parent';

  return (
    // Con tenant, fondo gris NEUTRO en vez del verde de SportMaps. Se mantiene
    // oscuro: los campos y placeholders estan estilados para fondo oscuro.
    <div className={`min-h-screen flex ${tenant ? 'bg-[#0d0f12]' : 'bg-[#0a1a0d]'} text-[#f5f7f2] font-['DM_Sans'] overflow-x-hidden`}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&display=swap');
        .sportmaps-grid {
          background-image:
            linear-gradient(rgba(36,130,35,.06) 1px, transparent 1px),
            linear-gradient(90deg, rgba(36,130,35,.06) 1px, transparent 1px);
          background-size: 52px 52px;
        }
        .hero-title { font-family: 'Syne', sans-serif; }
        .logo-name { font-family: 'Syne', sans-serif; }
        .syne { font-family: 'Syne', sans-serif; }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: .5; transform: scale(.7); }
        }
        .animate-pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
        .role-card-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 8px;
        }
        @media (min-width: 400px) {
          .role-card-grid { grid-template-columns: repeat(4, 1fr); }
        }
      `}</style>

      {/* ── LEFT PANEL ──
          Se oculta con tenant: es copy comercial de SportMaps y el padre esta
          entrando a la app de SU escuela. */}
      {!tenant && (
      <div className="hidden lg:flex w-[42%] min-h-screen bg-[#0f2614] relative flex-col justify-between p-12 overflow-hidden border-r border-white/5">
        <div className="absolute inset-0 sportmaps-grid"></div>
        {/* px a propósito: adorno del panel lg+ (hidden en móvil) */}
        <div className="absolute -top-[120px] -right-[120px] w-[420px] h-[420px] rounded-full bg-[radial-gradient(circle,rgba(36,130,35,.35)_0%,transparent_70%)] pointer-events-none"></div>
        <div className="absolute -bottom-[80px] -left-[80px] w-[300px] h-[300px] rounded-full bg-[radial-gradient(circle,rgba(36,130,35,.2)_0%,transparent_70%)] pointer-events-none"></div>
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 bg-[#248223] rounded-[10px] flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-white"><path d="M12 2C8.5 2 6 5 6 8c0 4 6 12 6 12s6-8 6-12c0-3-2.5-6-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"/></svg>
          </div>
          <span className="logo-name font-extrabold text-xl tracking-tight">SportMaps</span>
        </div>
        <div className="relative z-10">
          <div className="inline-flex items-center gap-2 bg-[#248223]/10 border border-[#248223]/30 rounded-full px-4 py-1.5 mb-8">
            <span className="w-1.5 h-1.5 bg-[#2ea82d] rounded-full animate-pulse-dot"></span>
            <p className="text-[10px] text-[#4dcc4c] font-bold uppercase tracking-widest">Plataforma deportiva</p>
          </div>
          <h1 className="hero-title font-extrabold text-6xl leading-[1.05] tracking-tighter mb-6">
            El deporte,<br />
            <span className="text-[#2ea82d]">mejor</span><br />
            organizado.
          </h1>
          <p className="text-sm text-[#8a9186] leading-relaxed max-w-xs font-light">
            Conectamos academias, entrenadores, atletas y familias en un solo ecosistema diseñado para el deporte latinoamericano.
          </p>
        </div>
        <div className="relative z-10 flex border border-white/5 rounded-2xl overflow-hidden bg-white/5 backdrop-blur-sm">
          <div className="flex-1 p-5 border-r border-white/5">
            <div className="hero-title font-bold text-2xl">+120<span className="text-[#2ea82d]">k</span></div>
            <div className="text-[10px] text-[#8a9186] uppercase tracking-wider font-medium">Atletas</div>
          </div>
          <div className="flex-1 p-5 border-r border-white/5">
            <div className="hero-title font-bold text-2xl">+800</div>
            <div className="text-[10px] text-[#8a9186] uppercase tracking-wider font-medium">Escuelas</div>
          </div>
          <div className="flex-1 p-5">
            <div className="hero-title font-bold text-2xl">32<span className="text-[#2ea82d]">+</span></div>
            <div className="text-[10px] text-[#8a9186] uppercase tracking-wider font-medium">Ciudades</div>
          </div>
        </div>
      </div>

      )}

      {/* ── RIGHT PANEL ── */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-lg animate-in slide-in-from-bottom-6 duration-500 ease-out">

          {tenant ? (
            /* Sin panel izquierdo, la identidad de la escuela pasa a ser el
               encabezado: logo grande y nombre, en todos los tamanios. */
            <div className="flex flex-col items-center gap-3 mb-10">
              {tenant.logo_url && (
                <img
                  src={tenant.logo_url}
                  alt={tenant.name}
                  className="w-20 h-20 rounded-2xl object-contain bg-white/5 p-2"
                />
              )}
              <span className="logo-name font-bold text-xl text-center">{tenant.name}</span>
            </div>
          ) : (
            <div className="lg:hidden flex items-center gap-2 mb-8 justify-center">
              <div className="w-8 h-8 bg-[#248223] rounded-lg flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white"><path d="M12 2C8.5 2 6 5 6 8c0 4 6 12 6 12s6-8 6-12c0-3-2.5-6-6-6zm0 8a2 2 0 110-4 2 2 0 010 4z"/></svg>
              </div>
              <span className="logo-name font-bold text-lg">SportMaps</span>
            </div>
          )}

          <div className="mb-10">
            <h2 className="hero-title font-bold text-3xl tracking-tight mb-2">Crear cuenta</h2>
            <p className="text-sm text-[#8a9186] font-light">Únete a la comunidad líder en gestión deportiva.</p>
          </div>

          {invitationInfo && (
            <div className="bg-[#248223]/10 border border-[#248223]/20 rounded-2xl p-4 mb-8 flex items-center gap-4">
              <div className="w-10 h-10 bg-[#248223]/20 rounded-xl flex items-center justify-center flex-shrink-0">
                <School className="w-5 h-5 text-[#2ea82d]" />
              </div>
              <div>
                <p className="text-sm font-semibold">Invitación de <span className="text-[#2ea82d]">{invitationInfo.school_name}</span></p>
                <p className="text-xs text-[#8a9186]">{invitationInfo.program_name || 'Nuevo Ingreso'}</p>
              </div>
            </div>
          )}

          {userExistsError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-5 mb-8 animate-in zoom-in duration-300">
              <div className="flex items-center gap-2 text-red-500 font-bold text-sm mb-2">
                <AlertCircle className="w-4 h-4" /> Cuenta registrada
              </div>
              <p className="text-xs text-[#8a9186] mb-4">Este correo ya tiene un perfil. Por favor inicia sesión.</p>
              <Button asChild className="w-full bg-red-500 hover:bg-red-600 text-white border-none py-6 rounded-xl font-bold">
                <Link to={`/login?email=${encodeURIComponent(watch('email'))}${inviteId ? `&invite=${inviteId}` : ''}`}>
                  Ir al inicio de sesión
                </Link>
              </Button>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className={cn("space-y-6", (userExistsError || isLoading) && "opacity-50 pointer-events-none")}>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Email */}
              <div className="space-y-2 md:col-span-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Correo electrónico</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Mail className="w-4 h-4 text-[#4a5246] group-focus-within:text-[#2ea82d] transition-colors" />
                  </div>
                  <input
                    {...register('email')}
                    type="email"
                    placeholder="tu@correo.com"
                    readOnly={!!inviteEmail}
                    className="w-full bg-[#0f2614] border border-white/5 rounded-xl py-3.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all placeholder:text-[#4a5246]"
                  />
                </div>
                {errors.email && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.email.message}</p>}
              </div>

              {/* Password */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Contraseña</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <Lock className="w-4 h-4 text-[#4a5246] group-focus-within:text-[#2ea82d] transition-colors" />
                  </div>
                  <input
                    {...register('password')}
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Min. 8 caracteres"
                    onInput={(e) => checkPw(e.currentTarget.value)}
                    className="w-full bg-[#0f2614] border border-white/5 rounded-xl py-3.5 pl-11 pr-12 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all placeholder:text-[#4a5246]"
                  />
                  <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-4 top-1/2 -translate-y-1/2 text-[#4a5246] hover:text-[#f5f7f2]">
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="flex gap-1 px-1 mt-2">
                  {[1,2,3,4].map(i => (
                    <div key={i} className={cn("h-1 flex-1 rounded-full bg-[#163a1c] transition-all", 
                      i <= pwStrength && (pwStrength <= 1 ? "bg-red-500" : pwStrength <= 2 ? "bg-orange-400" : "bg-[#2ea82d]"))} 
                    />
                  ))}
                </div>
              </div>

              {/* "Confirmar contraseña" se quitó: el ojo para verla cumple lo mismo
                  con un campo menos. */}
              <div className="h-4 md:col-span-2"></div>

              {/* Name */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Nombre Completo</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                    <User className="w-4 h-4 text-[#4a5246] group-focus-within:text-[#2ea82d] transition-colors" />
                  </div>
                  <input
                    {...register('fullName')}
                    type="text"
                    placeholder="Ej: Carlos Ortiz"
                    className="w-full bg-[#0f2614] border border-white/5 rounded-xl py-3.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all placeholder:text-[#4a5246]"
                  />
                </div>
                {errors.fullName && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.fullName.message}</p>}
              </div>

              {/* Phone — obligatorio para el acudiente (ver refine del esquema) */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">
                  WhatsApp{roleValue === 'parent' && <span className="text-[#4dcc4c]"> *</span>}
                </label>
                <Controller
                  name="phone"
                  control={control}
                  render={({ field }) => (
                    <PhoneInput
                      value={field.value || ''}
                      onChange={field.onChange}
                    />
                  )}
                />
                {errors.phone && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.phone.message}</p>}
              </div>

              {/* Role Selection */}
              <div className="space-y-3 md:col-span-2 mt-4">
                <label className="text-[10px] font-bold uppercase tracking-widest text-[#4a5246]">Soy...</label>
                {!inviteRole && (
                  <p className="text-[11px] text-[#8a9186] leading-snug px-1">
                    <span className="text-[#d4d8d0] font-semibold">Atleta:</span> me inscribo yo mismo, soy mayor de edad.{' '}
                    <span className="text-[#d4d8d0] font-semibold">Acudiente:</span> inscribo a un menor de edad a mi cargo
                    (la cuenta va a tu nombre y tú pagas).
                  </p>
                )}
                <div className="role-card-grid">
                  {[
                    { id: 'athlete', icon: '⚽', label: 'Atleta 18+' },
                    { id: 'parent', icon: '👨‍👩‍👧', label: 'Acudiente' },
                    { id: 'coach', icon: '📋', label: 'Coach' },
                    { id: 'school', icon: '🏫', label: 'Escuela' },
                    { id: 'facility_manager', icon: '🏟️', label: 'Club / Canchas' },
                    { id: 'wellness_professional', icon: '💚', label: 'Profesional' },
                    { id: 'store_owner', icon: '🏪', label: 'Tienda' },
                    { id: 'personal_trainer', icon: '🏋️', label: 'Entrenador' },
                  ].map((role) => (
                    <div 
                      key={role.id}
                      onClick={() => !inviteRole && setValue('role', role.id)}
                      className={cn(
                        "relative flex flex-col items-center justify-center p-3 rounded-xl border transition-all cursor-pointer group",
                        inviteRole && inviteRole !== role.id && "hidden",
                        roleValue === role.id 
                          ? "bg-[#248223]/15 border-[#248223] ring-2 ring-[#248223]/20" 
                          : "bg-[#0f2614] border-white/5 hover:border-[#248223]/50"
                      )}
                    >
                      <span className="text-xl mb-1">{role.icon}</span>
                      <span className="text-[9px] font-bold uppercase tracking-tight text-[#d4d8d0]">{role.label}</span>
                      {roleValue === role.id && <div className="absolute top-1 right-1 w-1.5 h-1.5 bg-[#2ea82d] rounded-full"></div>}
                    </div>
                  ))}
                </div>
                {errors.role && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.role.message}</p>}
              </div>

              {/* ── ACUDIENTE: declaración de mayoría de edad (reemplaza la fecha) ── */}
              {roleValue === 'parent' && (
                <div className="md:col-span-2 animate-in slide-in-from-top-2 duration-300">
                  <div
                    className="flex items-start gap-4 cursor-pointer select-none"
                    onClick={() => setValue('isAdult', !watch('isAdult'), { shouldValidate: true })}
                  >
                    <div
                      className={cn("w-5 h-5 rounded-md border flex items-center justify-center transition-all flex-shrink-0 mt-0.5",
                        watch('isAdult') ? "bg-[#248223] border-[#248223]" : "bg-[#0f2614] border-white/10")}
                    >
                      {watch('isAdult') && <Check className="w-3.5 h-3.5 text-white" />}
                    </div>
                    <p className="text-xs text-[#8a9186] leading-relaxed">
                      Soy mayor de edad y acudiente del menor que voy a inscribir.
                    </p>
                  </div>
                  {errors.isAdult && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.isAdult.message}</p>}
                </div>
              )}

              {/* ── FECHA DE NACIMIENTO — atleta, coach y profesional (no acudiente) ── */}
              {showDateOfBirth && (
                <div className="space-y-2 md:col-span-2 animate-in slide-in-from-top-2 duration-300">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">
                    {roleValue === 'parent' ? 'Tu fecha de nacimiento (acudiente)' : 'Tu fecha de nacimiento'}
                  </label>
                  {roleValue === 'athlete' && (
                    <p className="text-[11px] text-[#8a9186] leading-snug px-1">
                      La tuya, la del atleta. Si el atleta es menor de edad, la cuenta la debe crear
                      su acudiente con el rol <span className="text-[#d4d8d0] font-semibold">Acudiente</span>.
                    </p>
                  )}
                  <Controller
                    name="dateOfBirth"
                    control={control}
                    render={({ field }) => (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full bg-[#0f2614] border border-white/5 rounded-xl py-6 pl-11 pr-4 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all hover:bg-[#0f2614] hover:text-[#f5f7f2] justify-start text-left font-normal",
                              !field.value && "text-[#4a5246]",
                              field.value && "text-[#f5f7f2]"
                            )}
                          >
                            <CalendarIcon className="absolute left-4 w-4 h-4 text-[#4a5246]" />
                            {field.value ? (
                              format(new Date(field.value + "T12:00:00"), "PPP", { locale: es })
                            ) : (
                              <span>Selecciona una fecha</span>
                            )}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0 bg-[#0f2614] border-white/10 text-[#f5f7f2] shadow-2xl" align="start">
                          <Calendar
                            mode="single"
                            selected={field.value ? new Date(field.value + "T12:00:00") : undefined}
                            onSelect={(date) => {
                              if (date) {
                                field.onChange(format(date, 'yyyy-MM-dd'));
                              } else {
                                field.onChange('');
                              }
                            }}
                            disabled={(date) =>
                              date > new Date() || date < new Date("1900-01-01")
                            }
                            defaultMonth={field.value ? new Date(field.value + "T12:00:00") : new Date(new Date().setFullYear(new Date().getFullYear() - 15))}
                            captionLayout="dropdown-buttons"
                            fromYear={1920}
                            toYear={new Date().getFullYear()}
                            initialFocus
                            className="bg-[#0f2614] text-[#f5f7f2] rounded-xl"
                            classNames={{
                              head_cell: "text-[#8a9186] font-normal text-[0.8rem] w-9",
                              cell: "h-9 w-9 text-center text-sm p-0",
                              day: "h-9 w-9 p-0 font-normal aria-selected:opacity-100 hover:bg-white/10 rounded-md transition-colors",
                              day_selected: "bg-[#248223] text-white hover:bg-[#2ea82d] hover:text-white focus:bg-[#248223] focus:text-white font-bold",
                              day_today: "bg-white/5 text-[#4dcc4c] font-bold",
                              day_outside: "text-[#8a9186]/50",
                              day_disabled: "text-[#8a9186]/30",
                              nav_button: "h-7 w-7 bg-transparent p-0 text-[#f5f7f2] hover:bg-white/10 rounded-md border border-white/10 transition-colors",
                              dropdown: "bg-[#0f2614] border border-white/10 text-[#f5f7f2] rounded-md custom-scrollbar focus:ring-[#248223]",
                              dropdown_month: "[&>option]:text-black",
                              dropdown_year: "[&>option]:text-black"
                            }}
                          />
                        </PopoverContent>
                      </Popover>
                    )}
                  />
                  {errors.dateOfBirth && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.dateOfBirth.message}</p>}
                </div>
              )}

              {/* Dueño de espacios: solo el nombre. Sin deporte, equipos ni atletas. */}
              {roleValue === 'facility_manager' && !inviteId && (
                <div className="md:col-span-2 space-y-3 pt-4 animate-in slide-in-from-top-4 duration-300">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Nombre del club o espacio</label>
                    <div className="relative group">
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                        <School className="w-4 h-4 text-[#4a5246] group-focus-within:text-[#2ea82d] transition-colors" />
                      </div>
                      <input
                        {...register('schoolName')}
                        type="text"
                        placeholder="Ej: Canchas El Campín"
                        className="w-full bg-[#0f2614] border border-white/5 rounded-xl py-3.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all placeholder:text-[#4a5246]"
                      />
                    </div>
                    {errors.schoolName && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.schoolName.message}</p>}
                  </div>
                  <p className="text-[11px] text-[#8a9186] px-1">
                    Publica tus canchas y recibe reservas, sin necesidad de ser una escuela.
                  </p>
                </div>
              )}

              {/* School Specific Fields */}
              {roleValue === 'school' && !inviteId && (
                <div className="md:col-span-2 space-y-6 pt-4 animate-in slide-in-from-top-4 duration-300">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Nombre de la Academia</label>
                    <div className="relative group">
                      <div className="absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none">
                        <School className="w-4 h-4 text-[#4a5246] group-focus-within:text-[#2ea82d] transition-colors" />
                      </div>
                      <input
                        {...register('schoolName')}
                        type="text"
                        placeholder="Ej: Academy Los Tigres"
                        className="w-full bg-[#0f2614] border border-white/5 rounded-xl py-3.5 pl-11 pr-4 text-sm focus:outline-none focus:border-[#248223] focus:ring-4 focus:ring-[#248223]/10 transition-all placeholder:text-[#4a5246]"
                      />
                    </div>
                    {errors.schoolName && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.schoolName.message}</p>}
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-bold uppercase tracking-widest text-[#d4d8d0]">Deporte Principal</label>
                    <Controller
                      name="sportId"
                      control={control}
                      render={({ field }) => (
                        <Popover open={sportOpen} onOpenChange={setSportOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={sportOpen}
                              className={cn(
                                "w-full justify-between bg-[#0f2614] border-white/5 hover:bg-[#0f2614] hover:border-[#248223]/50 text-sm font-normal py-6 rounded-xl",
                                !field.value && "text-[#4a5246]",
                                errors.sportId && "border-red-500"
                              )}
                            >
                              <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
                              {field.value ? allSports.find((s) => s.id === field.value)?.nombre : "Buscar Deporte..."}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-full p-0 bg-[#0f2614] border-white/10" align="start">
                            <Command className="bg-transparent">
                              <CommandInput placeholder="Filtrar por nombre..." className="text-sm h-11" />
                              <CommandEmpty>No se encontró el deporte.</CommandEmpty>
                              <CommandGroup className="max-h-72 overflow-y-auto">
                                {allSports.map((sport) => (
                                  <CommandItem
                                    key={sport.id}
                                    value={sport.nombre}
                                    onSelect={() => { setValue('sportId', sport.id); setSportOpen(false); }}
                                    className="text-[#f5f7f2]/80 data-[selected=true]:bg-[#248223]/20 data-[selected=true]:text-[#f5f7f2]"
                                  >
                                    <Check className={cn("mr-2 h-4 w-4", field.value === sport.id ? "opacity-100" : "opacity-0")} />
                                    {sport.nombre}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      )}
                    />
                    {errors.sportId && <p className="text-[10px] text-red-500 font-medium px-1 mt-1">{errors.sportId.message}</p>}
                    <p className="text-[9px] text-[#8a9186] px-1 italic">Este deporte autogenerará categorías sugeridas para tu academia.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-start gap-4 pt-4">
              <div 
                className={cn("w-5 h-5 rounded-md border flex items-center justify-center cursor-pointer transition-all flex-shrink-0 mt-0.5", 
                  watch('acceptTerms') ? "bg-[#248223] border-[#248223]" : "bg-[#0f2614] border-white/10")}
                onClick={() => setValue('acceptTerms', !watch('acceptTerms'))}
              >
                {watch('acceptTerms') && <Check className="w-3.5 h-3.5 text-white" />}
              </div>
              <p className="text-xs text-[#8a9186] leading-relaxed select-none">
                Acepto los <a href="/terminos-y-condiciones" target="_blank" rel="noopener noreferrer" className="text-[#4dcc4c] hover:underline font-bold">Términos y Condiciones</a> y la <a href="/politica-de-privacidad" target="_blank" rel="noopener noreferrer" className="text-[#4dcc4c] hover:underline font-bold">Política de Privacidad</a> de SportMaps.
              </p>
            </div>
            {errors.acceptTerms && <p className="text-[10px] text-red-500 font-medium px-1 -mt-4">{errors.acceptTerms.message}</p>}

            <Button 
              type="submit"
              // Color de la escuela por estilo inline: es un hex arbitrario y
              // Tailwind no genera clases para valores que no conoce en build.
              style={colorMarca ? { backgroundColor: colorMarca } : undefined}
              className={`w-full ${colorMarca ? 'text-white hover:opacity-90' : 'bg-[#248223] hover:bg-[#2ea82d] text-white shadow-xl shadow-[#248223]/15'} py-8 rounded-2xl text-base font-bold syne tracking-wide transition-all group`}
              disabled={isLoading}
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <ArrowRight className="w-5 h-5 mr-1 group-hover:translate-x-1 transition-transform" />}
              Crear mi cuenta
            </Button>

            <AuthDivider text="o regístrate con" />
            {/* OAuth no recoge rol → el usuario lo elige en /onboarding/role */}
            <GoogleSignInButton redirectTo="/dashboard" label="Registrarme con Google" />

            <div className="text-center pt-2">
              <p className="text-sm text-[#8a9186]">
                ¿Ya tienes cuenta? <Link to="/login" className="text-[#4dcc4c] font-bold hover:underline">Inicia sesión</Link>
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}