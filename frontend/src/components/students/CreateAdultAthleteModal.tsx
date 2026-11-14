/**
 * CreateAdultAthleteModal — Inscripción de Atleta Adulto
 *
 * Flujo único:
 *   1. Buscar por email o documento en profiles (profiles.email / profiles.document_number)
 *   2a. Si EXISTE → mostrar card, permitir asignar equipo y/o plan → INSERT enrollment (user_id)
 *       + INSERT school_members si no es miembro aún
 *   2b. Si NO EXISTE → crear invitación (no se puede crear profiles sin auth)
 *       El atleta completa su registro vía el link de invitación
 *
 * Enrollment para adultos usa user_id (profiles.id), nunca child_id.
 * Equipo y Plan son INDEPENDIENTES — nunca se cruzan entre sí.
 */

import { useState, useEffect, useCallback } from 'react';
import { todayColombia } from '@/lib/dateUtils';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  UserCheck, Search, ClipboardList, Loader2, CheckCircle2, AlertCircle,
  Info, Send, UserPlus, Calendar as CalendarIcon,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useEntitlements } from '@/hooks/useEntitlements';
import { ZkPinField, zkPinToPayload } from './ZkPinField';
import { phoneForForm, type AthletePrefill } from './athletePrefill';
import { supabase } from '@/integrations/supabase/client';
import { bffClient } from '@/lib/api/bffClient';
import {
  FirstPaymentModeSection, FirstPaymentChoice, DEFAULT_FIRST_PAYMENT_CHOICE,
} from '@/components/students/FirstPaymentModeSection';
import { formatCOP } from '@/lib/prorationUtils';
import { PlanCombobox } from '@/components/students/PlanCombobox';
import {
  AltaFirstChargeCard, FeeWaivers, feeWaiversPayload, defaultFeeWaivers,
} from '@/components/students/AltaFirstChargeCard';
import { useInsuranceActiveSince } from '@/hooks/useInsuranceActiveSince';
import { PhoneInput } from '@/components/ui/phone-input';
import { useReferidoAlta } from '@/components/referidos/ReferidoAlta';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string;
  name: string;
  sport: string;
  price_monthly: number | null;
}

interface PlanOption {
  plan_id: string;
  offering_id: string;
  offering_name: string;
  plan_name: string;
  price: number;
  duration_days: number;
  registration_fee: number | null; // offering_plans.registration_fee (D17) — null = sin inscripción
  insurance_fee: number | null;    // offering_plans.insurance_fee (F-B) — null = sin seguro
}

interface Branch { id: string; name: string; }

interface BillingSettings {
  payment_cutoff_day: number;
  billing_cycle_type: 'prorated' | 'fixed_calendar' | 'rolling_30';
  /** «Primer cobro sin recargo»: la base mueve el primer cobro al próximo corte (trigger). */
  late_fee_skip_signup_month?: boolean;
}

interface FoundProfile {
  id: string;
  role: string;
}

interface CreateAdultAthleteModalProps {
  open: boolean;
  onClose: () => void;
  /** Recibe la respuesta de create-one (`user_id` o `unregistered_athlete_id`). */
  onSuccess: (result?: any) => void;
  schoolId: string;
  /** «No cobrar inscripción / seguro». El coach no exonera (default true; el BFF también lo frena). */
  canWaiveFees?: boolean;
  prefill?: AthletePrefill | null;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

// ─── Main Modal ───────────────────────────────────────────────────────────────

export function CreateAdultAthleteModal({ open, onClose, onSuccess, schoolId, canWaiveFees = true, prefill }: CreateAdultAthleteModalProps) {
  const { toast } = useToast();
  const { registrationZkPinEnabled } = useEntitlements();
  const [submitting, setSubmitting] = useState(false);
  // «¿Quién lo refirió?»: solo con la campaña activa; se registra tras crear la inscripción.
  const referido = useReferidoAlta(schoolId);

  // Lookup data
  const [teams, setTeams]       = useState<Team[]>([]);
  const [plans, setPlans]       = useState<PlanOption[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [billing, setBilling] = useState<BillingSettings>({
    payment_cutoff_day: 10,
    billing_cycle_type: 'prorated',
  });

  // Formulario y validación en segundo plano
  const [uEmail, setUEmail]           = useState('');
  const [checkingEmail, setCheckingEmail] = useState(false);
  const [emailExists, setEmailExists] = useState<boolean | null>(null);
  const [foundProfile, setFoundProfile] = useState<FoundProfile | null>(null);

  const [uDocType, setUDocType]       = useState('CC');
  const [uDocNumber, setUDocNumber]   = useState('');
  const [uFullName, setUFullName]     = useState('');
  const [uPhone, setUPhone]           = useState('+57');
  const [uDob, setUDob]               = useState('');
  const [uGender, setUGender]         = useState('');
  const [uDorsal, setUDorsal]         = useState('');
  const [uZkPin, setUZkPin]           = useState('');
  const [sendInviteEmail, setSendInviteEmail] = useState(true);
  const [sendInviteWhatsapp, setSendInviteWhatsapp] = useState(true);

  // Inscripción
  const [branchId, setBranchId]               = useState('none');
  const [teamId, setTeamId]                   = useState('none');
  const [selectedPlanId, setSelectedPlanId]   = useState('none');
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [selectedPlanPrice, setSelectedPlanPrice] = useState(0);
  const [selectedPlanRegistrationFee, setSelectedPlanRegistrationFee] = useState(0);
  const [selectedPlanInsuranceFee, setSelectedPlanInsuranceFee] = useState(0);
  // Exoneración por alta: «No cobrar inscripción / seguro» (se reinicia al cambiar de plan).
  const [feeWaivers, setFeeWaivers] = useState<FeeWaivers>(() => defaultFeeWaivers(canWaiveFees));
  // Alta a mitad de mes por clases restantes (F7). Flag por escuela, leído aparte
  // para que una base sin la columna no tumbe la lectura de billing.
  const [remainingClassesEnabled, setRemainingClassesEnabled] = useState(false);
  const [firstPayment, setFirstPayment] = useState<FirstPaymentChoice>(DEFAULT_FIRST_PAYMENT_CHOICE);
  const [startDate, setStartDate]             = useState(() => todayColombia());
  // Seguro vigente (12 meses) del atleta que ya tiene cuenta: no se vuelve a cobrar.
  const insuranceActiveSince = useInsuranceActiveSince({
    schoolId,
    planId: selectedPlanId !== 'none' ? selectedPlanId : null,
    startDate,
    userId: foundProfile?.id ?? null,
    enabled: selectedPlanInsuranceFee > 0,
  });
  const [monthlyFee, setMonthlyFee]           = useState('');
  const [discountPct, setDiscountPct]         = useState(0);
 
  const handlePostSuccess = (result: any, name: string, phone?: string | null) => {
    toast({
      title: '✅ Listo',
      description: `${name} fue registrado correctamente.${result?.zk_pin ? ` ID del torniquete ${result.zk_pin} asociado.` : ''}`,
    });
    if (result?.zk_pin_warning) {
      toast({ title: 'ID del torniquete sin asociar', description: result.zk_pin_warning, variant: 'destructive' });
    }

    if (sendInviteWhatsapp && result?.registration_link && (phone || result?.phone)) {
      const phoneClean = (phone || result.phone || '').replace(/\D/g, '');
      const msg = `¡Hola! Te invitamos a unirte a la plataforma deportiva. Completa tu registro aquí: ${result.registration_link}`;
      toast({
        title: 'Enviar invitación por WhatsApp',
        description: (
          <button
            className="mt-2 w-full bg-green-600 hover:bg-green-700 text-white text-xs py-2 px-3 rounded-md"
            onClick={() => window.open(`https://wa.me/${phoneClean}?text=${encodeURIComponent(msg)}`, '_blank')}
          >
            📱 Abrir WhatsApp
          </button>
        ) as any,
      });
    }
  };

  // ── Load lookup data ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !schoolId) return;

    Promise.all([
      supabase.from('teams').select('id, name, sport, price_monthly').eq('school_id', schoolId).eq('status', 'active').order('name'),
      supabase.from('offering_plans').select('id, name, price, duration_days, registration_fee, insurance_fee, offering_id, offerings(id, name)').eq('school_id', schoolId).eq('is_active', true).order('sort_order').order('created_at'),
      supabase.from('school_branches').select('id, name').eq('school_id', schoolId).order('name'),
      supabase.from('school_settings').select('payment_cutoff_day, billing_cycle_type, late_fee_skip_signup_month').eq('school_id', schoolId).maybeSingle(),
    ]).then(([teamsRes, plansRes, branchesRes, settingsRes]) => {
      setTeams((teamsRes.data as Team[]) ?? []);
      const flatPlans: PlanOption[] = ((plansRes.data as any[]) ?? []).map(row => ({
        plan_id:       row.id,
        offering_id:   row.offerings?.id ?? row.offering_id,
        offering_name: row.offerings?.name ?? '',
        plan_name:     row.name,
        price:         Number(row.price),
        duration_days: row.duration_days,
        registration_fee: row.registration_fee != null ? Number(row.registration_fee) : null,
        insurance_fee: row.insurance_fee != null ? Number(row.insurance_fee) : null,
      }));
      setPlans(flatPlans);
      setBranches((branchesRes.data as Branch[]) ?? []);
      if (settingsRes.data) {
        setBilling(settingsRes.data as unknown as BillingSettings);
      }
    });
    supabase.from('school_settings').select('remaining_classes_billing_enabled').eq('school_id', schoolId).maybeSingle()
      .then(({ data, error }) => {
        setRemainingClassesEnabled(!error && !!(data as any)?.remaining_classes_billing_enabled);
    });
  }, [open, schoolId]);

  // Auto-fill mensualidad
  useEffect(() => {
    if (selectedPlanId && selectedPlanId !== 'none') {
      const p = plans.find(p => p.plan_id === selectedPlanId);
      if (p) setMonthlyFee(String(p.price));
    } else if (teamId && teamId !== 'none') {
      const t = teams.find(t => t.id === teamId);
      if (t?.price_monthly) setMonthlyFee(String(t.price_monthly));
    } else {
      setMonthlyFee('');
    }
  }, [selectedPlanId, teamId, plans, teams]);

  const handlePlanSelect = (planId: string) => {
    setSelectedPlanId(planId);
    setFeeWaivers(defaultFeeWaivers(canWaiveFees));
    if (!planId || planId === 'none') {
      setSelectedOfferingId('');
      setSelectedPlanPrice(0);
      setSelectedPlanRegistrationFee(0);
      setSelectedPlanInsuranceFee(0);
      return;
    }
    const p = plans.find(p => p.plan_id === planId);
    if (p) {
      setSelectedOfferingId(p.offering_id);
      setSelectedPlanPrice(p.price);
      setSelectedPlanRegistrationFee(p.registration_fee ?? 0);
      setSelectedPlanInsuranceFee(p.insurance_fee ?? 0);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const reset = () => {
    setUEmail('');
    setCheckingEmail(false);
    setEmailExists(null);
    setFoundProfile(null);
    setBranchId('none'); setTeamId('none');
    setSelectedPlanId('none'); setSelectedOfferingId('');
    setSelectedPlanPrice(0); setSelectedPlanRegistrationFee(0); setSelectedPlanInsuranceFee(0);
    setFirstPayment(DEFAULT_FIRST_PAYMENT_CHOICE);
    setFeeWaivers(defaultFeeWaivers(canWaiveFees));
    setStartDate(todayColombia());
    setMonthlyFee('');
    setDiscountPct(0);

    setUDocType('CC'); setUDocNumber(''); setUFullName(''); setUPhone('+57'); setUDob(''); setUGender(''); setUDorsal(''); setUZkPin('');
    setSendInviteEmail(true); setSendInviteWhatsapp(true);
  };

  const handleClose = () => { referido.reiniciar(); reset(); onClose(); };

  // Abre precargado (prospecto de clase de prueba): solo lo que se sabe.
  useEffect(() => {
    if (!open || !prefill) return;
    if (prefill.fullName) setUFullName(prefill.fullName);
    if (prefill.phone) setUPhone(phoneForForm(prefill.phone));
  }, [open, prefill]);

  // ── Búsqueda silenciosa en profiles ──────────────────────────────────────────
  const checkEmailExists = useCallback(async (emailVal: string) => {
    const emailClean = emailVal.trim().toLowerCase();
    if (!emailClean || !emailClean.includes('@')) {
      setEmailExists(null);
      setFoundProfile(null);
      return;
    }

    setCheckingEmail(true);
    try {
      const data = await bffClient.get(`/api/v1/trainer/search-profile?q=${encodeURIComponent(emailClean)}`, {
        'x-school-id': schoolId
      });

      if (data) {
        const BLOCKED_ROLES = ['school', 'school_admin', 'super_admin', 'organizer', 'admin'];
        if (BLOCKED_ROLES.includes((data as any).role)) {
          toast({
            title: 'Perfil no disponible',
            description: 'Este usuario tiene un rol administrativo y no puede ser inscrito como atleta.',
            variant: 'destructive',
          });
          setEmailExists(null);
          setFoundProfile(null);
          return;
        }
        setEmailExists(true);
        setFoundProfile(data as FoundProfile);
      } else {
        setEmailExists(false);
        setFoundProfile(null);
      }
    } catch {
      setEmailExists(false);
      setFoundProfile(null);
    } finally {
      setCheckingEmail(false);
    }
  }, [schoolId, toast]);

  const handleEmailChange = (val: string) => {
    setUEmail(val);
    setEmailExists(null);
    setFoundProfile(null);
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(val.trim())) {
      checkEmailExists(val);
    }
  };

  const handleEmailBlur = () => {
    checkEmailExists(uEmail);
  };

  // ── Inscribir / Registrar ──────────────────────────────────────────────────
  // F7: la opción solo existe con ciclo fijo + flag + plan mensual. Sin eso el
  // payload no lleva first_payment_mode y el BFF cobra exactamente como siempre.
  const selectedPlanOption = plans.find(p => p.plan_id === selectedPlanId);
  const showFirstPaymentMode = remainingClassesEnabled
    && billing.billing_cycle_type === 'fixed_calendar'
    && !!selectedPlanOption && (selectedPlanOption.duration_days ?? 30) >= 28;
  const firstPaymentPayload = showFirstPaymentMode
    ? (firstPayment.mode === 'remaining_classes'
        ? { first_payment_mode: 'remaining_classes', classes_remaining: firstPayment.classesRemaining, partial_due: firstPayment.partialDue }
        : { first_payment_mode: 'full_month' })
    : {};

  const handleEnroll = async () => {
    if (!uFullName.trim() && !foundProfile) {
      toast({ title: 'Nombre requerido', variant: 'destructive' }); return;
    }
    if (!branchId || branchId === 'none') {
      toast({ title: 'Sede requerida', description: 'Debes seleccionar una sede para inscribir al atleta.', variant: 'destructive' });
      return;
    }
    if (!startDate) {
      toast({ title: 'Falta fecha de inscripción', variant: 'destructive' }); return;
    }
    const fee = Number(monthlyFee);
    if (monthlyFee && (isNaN(fee) || fee < 10000)) {
      toast({ title: 'Mensualidad inválida', description: 'Debe ser ≥ $10.000 COP', variant: 'destructive' }); return;
    }

    setSubmitting(true);
    try {
      if (foundProfile) {
        // Inscribir atleta existente
        const result = await bffClient.post('/api/v1/students/create-one', {
          type: 'adult_existing',
          user_id:          foundProfile.id,
          branch_id:        (branchId && branchId !== 'none') ? branchId : null,
          team_id:          (teamId && teamId !== 'none') ? teamId : null,
          offering_plan_id: (selectedPlanId && selectedPlanId !== 'none') ? selectedPlanId : null,
          offering_id:      selectedOfferingId || null,
          start_date:       startDate,
          monthly_fee:      monthlyFee ? fee : null,
          discount_pct:     discountPct > 0 ? discountPct : undefined,
          ...firstPaymentPayload,
          ...feeWaiversPayload(feeWaivers),
          ...(registrationZkPinEnabled
            ? { zk_pin: zkPinToPayload(uZkPin) }
            : { dorsal: uDorsal.trim() || null }),
        }, { 'x-school-id': schoolId });

        handlePostSuccess(result, uFullName.trim() || 'Atleta', uPhone);
        if (Number((result as any)?.enrollments_created) > 0) {
          await referido.registrarTras({ tipo: 'profile', id: foundProfile.id, nombre: uFullName.trim() || 'el atleta' });
        }
        referido.reiniciar();
        reset();
        onSuccess({ ...(result as any), user_id: (result as any)?.user_id ?? foundProfile.id });
      } else {
        // Registrar atleta nuevo
        const result = await bffClient.post('/api/v1/students/create-one', {
          type: 'unregistered_adult',
          doc_type:         uDocType,
          doc_number:       uDocNumber.trim() || null,
          full_name:        uFullName.trim(),
          email:            uEmail.trim().toLowerCase() || null,
          phone:            uPhone.replace(/\D/g, '') || null,
          date_of_birth:    uDob || null,
          gender:           uGender || null,
          ...(registrationZkPinEnabled
            ? { zk_pin: zkPinToPayload(uZkPin) }
            : { dorsal: uDorsal.trim() || null }),
          branch_id:        (branchId && branchId !== 'none') ? branchId : null,
          team_id:          (teamId && teamId !== 'none') ? teamId : null,
          offering_plan_id: (selectedPlanId && selectedPlanId !== 'none') ? selectedPlanId : null,
          offering_id:      selectedOfferingId || null,
          start_date:       startDate,
          monthly_fee:      monthlyFee ? fee : null,
          discount_pct:     discountPct > 0 ? discountPct : undefined,
          ...firstPaymentPayload,
          ...feeWaiversPayload(feeWaivers),
          send_invite:      sendInviteEmail && !!uEmail.trim(),
        }, { 'x-school-id': schoolId });

        handlePostSuccess(result, uFullName, uPhone);
        if ((result as any)?.unregistered_athlete_id && Number((result as any)?.enrollments_created) > 0) {
          await referido.registrarTras({ tipo: 'unregistered', id: (result as any).unregistered_athlete_id, nombre: uFullName.trim() });
        }
        referido.reiniciar();
        reset();
        onSuccess(result);
      }
    } catch (e: any) {
      toast({ title: 'Error al inscribir', description: e.message || 'Error inesperado', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-green-500" />
            Inscribir Atleta Adulto
          </DialogTitle>
          <DialogDescription>
            Registra un atleta adulto y asígnale sede, equipo o plan. Si el correo electrónico ya está registrado, se asociará su cuenta existente de forma segura.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* ── Datos del Atleta ── */}
          <Section icon={<UserPlus className="h-4 w-4" />} title="Datos Básicos del Atleta">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Nombre Completo *</Label>
                <Input
                  value={uFullName}
                  onChange={e => setUFullName(e.target.value)}
                  disabled={!!emailExists}
                  placeholder="Carlos Martínez"
                />
              </div>

              <div>
                <Label>Correo Electrónico</Label>
                <div className="relative">
                  <Input
                    type="email"
                    value={uEmail}
                    onChange={e => handleEmailChange(e.target.value)}
                    onBlur={handleEmailBlur}
                    placeholder="ejemplo@correo.com"
                    className="pr-10"
                  />
                  {checkingEmail && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                </div>
                {emailExists === true && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1 font-medium">
                    <CheckCircle2 className="h-3.5 w-3.5 inline shrink-0" />
                    Este correo ya está registrado en SportMaps. Se asociará su cuenta.
                  </p>
                )}
                {emailExists === false && uEmail.trim() && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1 font-medium">
                    <Info className="h-3.5 w-3.5 inline shrink-0" />
                    El correo no está registrado. Se le enviará invitación.
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Teléfono</Label>
                <PhoneInput value={uPhone} onChange={setUPhone} disabled={!!emailExists} />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1">
                  <Label>Tipo Doc.</Label>
                  <Select value={uDocType} onValueChange={setUDocType} disabled={!!emailExists}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CC">CC</SelectItem>
                      <SelectItem value="CE">CE</SelectItem>
                      <SelectItem value="PP">Pasaporte</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>Documento</Label>
                  <Input
                    value={uDocNumber}
                    onChange={e => setUDocNumber(e.target.value)}
                    disabled={!!emailExists}
                    placeholder="1020304050"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col">
                <Label className="mb-2">Fecha de Nacimiento</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full pl-3 text-left font-normal",
                        !uDob && "text-muted-foreground"
                      )}
                      disabled={!!emailExists}
                    >
                      {uDob ? (
                        format(new Date(uDob + 'T12:00:00'), "PPP", { locale: es })
                      ) : (
                        <span>Seleccionar fecha</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={uDob ? new Date(uDob + 'T12:00:00') : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const year = date.getFullYear();
                          const month = String(date.getMonth() + 1).padStart(2, '0');
                          const day = String(date.getDate()).padStart(2, '0');
                          setUDob(`${year}-${month}-${day}`);
                        }
                      }}
                      captionLayout="dropdown-buttons"
                      fromYear={1920}
                      toYear={new Date().getFullYear()}
                      disabled={(date) =>
                        date > new Date() || date < new Date("1900-01-01")
                      }
                      initialFocus
                      locale={es}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div>
                <Label>Género</Label>
                <Select value={uGender} onValueChange={setUGender} disabled={!!emailExists}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">Masculino</SelectItem>
                    <SelectItem value="female">Femenino</SelectItem>
                    <SelectItem value="other">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {registrationZkPinEnabled ? (
                <div className="md:col-span-2">
                  <ZkPinField id="adultZkPin" value={uZkPin} onChange={setUZkPin} />
                </div>
              ) : (
                <div>
                  <Label>Dorsal</Label>
                  <Input
                    value={uDorsal}
                    onChange={e => setUDorsal(e.target.value)}
                    placeholder="Ej: 10"
                    maxLength={10}
                  />
                </div>
              )}
            </div>

            {/* Opciones de Invitación (solo si el correo NO existe y hay correo) */}
            {emailExists === false && uEmail.trim() && (
              <div className="space-y-2 rounded-lg border border-amber-100 bg-amber-50/50 p-3 mt-4">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-100 mb-1">
                  Canales de Invitación:
                </p>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      id="sendInviteEmail"
                      checked={sendInviteEmail}
                      onChange={e => setSendInviteEmail(e.target.checked)}
                      className="rounded border-input text-primary focus:ring-primary h-4 w-4"
                    />
                    <label htmlFor="sendInviteEmail" className="text-muted-foreground text-xs cursor-pointer">
                      Enviar invitación por Correo Electrónico a <strong>{uEmail}</strong>
                    </label>
                  </div>
                  {uPhone && uPhone !== '+57' && (
                    <div className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        id="sendInviteWhatsapp"
                        checked={sendInviteWhatsapp}
                        onChange={e => setSendInviteWhatsapp(e.target.checked)}
                        className="rounded border-input text-primary focus:ring-primary h-4 w-4"
                      />
                      <label htmlFor="sendInviteWhatsapp" className="text-muted-foreground text-xs cursor-pointer">
                        Generar link para invitar por WhatsApp al finalizar
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Section>

          <Separator />

          {/* ── Inscripción ── */}
          <Section icon={<ClipboardList className="h-4 w-4" />} title="Inscripción en Escuela">
            <Alert className="py-2 px-3">
              <Info className="h-4 w-4" />
              <AlertDescription className="text-[11px] leading-snug">
                Sede es obligatoria. Equipo y Plan son independientes entre sí. Puedes asignar uno, ambos o ninguno.
              </AlertDescription>
            </Alert>

            {/* Sede */}
            {branches.length > 0 && (
              <div>
                <Label>Sede *</Label>
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger><SelectValue placeholder="Selecciona una sede *" /></SelectTrigger>
                  <SelectContent>
                    {branches.map(b => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Equipo y Plan — INDEPENDIENTES */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Equipo</Label>
                <p className="text-[11px] text-muted-foreground mb-1">Independiente del plan</p>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger><SelectValue placeholder="Sin equipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin equipo</SelectItem>
                    {teams.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}{t.sport ? ` — ${t.sport}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Plan</Label>
                <p className="text-[11px] text-muted-foreground mb-1">Independiente del equipo</p>
                <PlanCombobox
                  plans={plans.map(p => ({ id: p.plan_id, name: p.plan_name, offering_name: p.offering_name, price: p.price }))}
                  value={selectedPlanId}
                  onChange={handlePlanSelect}
                  noneValue="none"
                  showPrice
                />
              </div>
            </div>

            {/* Fecha y mensualidad */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label className="mb-2">Fecha de Inscripción *</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full pl-3 text-left font-normal",
                        !startDate && "text-muted-foreground"
                      )}
                    >
                      {startDate ? (
                        format(new Date(startDate + 'T12:00:00'), "PPP", { locale: es })
                      ) : (
                        <span>Seleccionar fecha</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate ? new Date(startDate + 'T12:00:00') : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const year = date.getFullYear();
                          const month = String(date.getMonth() + 1).padStart(2, '0');
                          const day = String(date.getDate()).padStart(2, '0');
                          setStartDate(`${year}-${month}-${day}`);
                        }
                      }}
                      initialFocus
                      locale={es}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div>
                <Label>Mensualidad (COP)</Label>
                <Input
                  type="number"
                  placeholder="150000"
                  value={monthlyFee}
                  onChange={e => setMonthlyFee(e.target.value)}
                  min={10000}
                  step={1000}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {selectedPlanId !== 'none'
                    ? 'Cargado desde el plan'
                    : teamId !== 'none'
                    ? 'Cargado desde el equipo'
                    : 'Ingresa manualmente'}
                </p>
              </div>
            </div>

            {/* Card de prorrateo */}
            <AltaFirstChargeCard
              startDate={startDate}
              monthlyFee={Number(monthlyFee) || 0}
              billing={billing}
              discountPct={discountPct}
              onDiscountChange={setDiscountPct}
              registrationFee={selectedPlanRegistrationFee}
              insuranceFee={selectedPlanInsuranceFee}
              waivers={feeWaivers}
              onWaiversChange={setFeeWaivers}
              canWaive={canWaiveFees}
              insuranceActiveSince={insuranceActiveSince}
              idSuffix="-adult"
              hideCycleDetail={showFirstPaymentMode && firstPayment.mode === 'remaining_classes'}
            />
            {showFirstPaymentMode && (
              <FirstPaymentModeSection
                schoolId={schoolId}
                planId={selectedPlanId}
                startDate={startDate}
                monthlyFee={Number(monthlyFee) || 0}
                discountPct={discountPct}
                value={firstPayment}
                onChange={setFirstPayment}
                waivers={feeWaivers}
                athleteUserId={foundProfile?.id ?? null}
              />
            )}
          </Section>
        </div>

        {referido.campo}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleEnroll} disabled={submitting || checkingEmail}>
            {submitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Guardando...</>
            ) : emailExists === true ? (
              <><ClipboardList className="h-4 w-4 mr-2" />Inscribir Atleta</>
            ) : (
              <><UserPlus className="h-4 w-4 mr-2" />Registrar Atleta</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
      {referido.dialogo}
    </Dialog>
  );
}

