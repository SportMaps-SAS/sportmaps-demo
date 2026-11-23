import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OnboardingShell, type ShellStep } from '@/components/onboarding/OnboardingShell';
import { PhoneInput } from '@/components/ui/phone-input';
import { CityCombobox } from '@/components/common/CityCombobox';
import { BankCombobox } from '@/components/common/BankCombobox';
import { newAccountId } from '@/lib/payment-accounts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building,
  UserPlus,
  GraduationCap,
  CreditCard,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Trophy,
  ArrowRight,
  SkipForward,
  Tag,
  Layers,
} from 'lucide-react';
import { SPORTS_LIST } from '@/lib/constants/sportsCatalog';
import { emailClient } from '@/lib/email-client';
import { esNombreDePagoUnico, PAGO_UNICO_NO_ES_PLAN_MSG } from '@/lib/school/pagosUnicos';
import { FootballModalitySelect } from '@/components/teams/FootballModalitySelect';
import { modalityToSave } from '@/lib/sports/footballModality';
import { resolveSignupSport } from '@/lib/auth/signupMetadata';

type BusinessModel = 'teams' | 'plans' | 'both';
type StepId = 'branch' | 'model' | 'team' | 'plan' | 'coach' | 'student' | 'payments';

/**
 * Convierte errores tecnicos de Supabase/PostgREST en mensajes que un
 * administrador no tecnico pueda entender. Lista basada en errores reales
 * observados en staging.
 */
function friendlyError(err: any): string {
  const msg = String(err?.message || err || '');
  if (msg.includes('schema cache') && (msg.includes('subscription_plans') || msg.includes('offerings') || msg.includes('offering_plans'))) {
    return 'El módulo de planes aún no está disponible. Pídele al administrador que aplique la última actualización.';
  }
  if (msg.includes('schema cache') && msg.includes('school_settings')) {
    return 'La configuración de cobros aún no está disponible. Pídele al administrador que aplique la última actualización.';
  }
  if (msg.includes('schema cache')) {
    return 'Esta función está siendo actualizada. Espera un minuto y vuelve a intentar.';
  }
  if (msg.includes('duplicate key') || msg.includes('already exists')) {
    return 'Ya existe un registro con esos datos.';
  }
  if (msg.includes('violates check constraint')) {
    return 'Alguno de los valores no es válido. Revisa los campos marcados con asterisco.';
  }
  if (msg.includes('permission denied') || msg.includes('not authorized')) {
    return 'No tienes permisos para realizar esta acción.';
  }
  if (msg.toLowerCase().includes('network')) {
    return 'Error de conexión. Verifica tu internet e intenta de nuevo.';
  }
  // Fallback: mensaje original sin el prefijo tecnico
  return msg.replace(/^[A-Za-z]+Error:\s*/i, '') || 'Ocurrió un error. Intenta nuevamente.';
}

/** Sanitizadores que filtran caracteres no permitidos en tiempo de tecla. */
const onlyDigits = (v: string) => v.replace(/\D/g, '');
const onlyLetters = (v: string) => v.replace(/[^A-Za-zÁÉÍÓÚáéíóúÑñ \-']/g, '');

interface OnboardingStatus {
  has_school: boolean;
  has_branches: boolean;
  has_teams: boolean;
  has_plans?: boolean;
  has_staff: boolean;
  has_students: boolean;
  payment_setup_completed: boolean;
  business_model?: BusinessModel | null;
  school_id: string | null;
}

interface WizardStep {
  id: StepId;
  title: string;
  subtitle: string;
  icon: React.ElementType;
  required: boolean;
}

// Pasos disponibles. El wizard ensambla cuales se muestran segun business_model.
const STEP_DEFS: Record<StepId, WizardStep> = {
  branch:   { id: 'branch',   title: 'Tu Sede',           subtitle: 'Confirma la direccion de tu sede principal', icon: Building,      required: true  },
  model:    { id: 'model',    title: 'Modelo',            subtitle: '¿Como organizas tu academia?',               icon: Layers,        required: true  },
  team:     { id: 'team',     title: 'Primer Equipo',     subtitle: 'Crea tu primer grupo o equipo deportivo',    icon: Trophy,        required: true  },
  plan:     { id: 'plan',     title: 'Primer Plan',       subtitle: 'Crea tu primera mensualidad o paquete',      icon: Tag,           required: true  },
  coach:    { id: 'coach',    title: 'Entrenador',        subtitle: 'Invita a tu primer entrenador',              icon: UserPlus,      required: false },
  student:  { id: 'student',  title: 'Primer Atleta',     subtitle: 'Registra a tu primer deportista',            icon: GraduationCap, required: false },
  payments: { id: 'payments', title: 'Cobros',            subtitle: 'Configura como recibir pagos',               icon: CreditCard,    required: false },
};

const buildSteps = (model: BusinessModel | null): WizardStep[] => {
  // El paso "Modelo" aparece SIEMPRE (no se autoesconde cuando hay default
  // 'teams' del backfill). El admin puede volver a este paso desde las pills
  // para cambiar su organizacion.
  const steps: WizardStep[] = [STEP_DEFS.branch, STEP_DEFS.model];
  if (model === 'teams' || model === 'both') steps.push(STEP_DEFS.team);
  if (model === 'plans' || model === 'both') steps.push(STEP_DEFS.plan);
  steps.push(STEP_DEFS.coach, STEP_DEFS.student, STEP_DEFS.payments);
  return steps;
};

interface SchoolOnboardingWizardProps {
  status: OnboardingStatus;
  onComplete: () => void;
  onRefresh: () => void;
  /** Default 'card' para uso embebido en dashboard.
   *  Pasar 'full' cuando se usa como pagina standalone en /onboarding/school. */
  variant?: 'card' | 'full';
}

export function SchoolOnboardingWizard({ status, onComplete, onRefresh, variant = 'card' }: SchoolOnboardingWizardProps) {
  const { schoolId, schoolName } = useSchoolContext();
  const { user } = useAuth();
  const { toast } = useToast();

  const [businessModel, setBusinessModel] = useState<BusinessModel | null>(
    (status.business_model as BusinessModel | undefined) ?? null,
  );
  // Si el RPC trae has_teams o has_plans pero business_model viene null, asumimos
  // que la escuela ya estaba en marcha con el modelo viejo (equipos).
  useEffect(() => {
    if (businessModel) return;
    if (status.has_teams && status.has_plans) setBusinessModel('both');
    else if (status.has_plans)                setBusinessModel('plans');
    else if (status.has_teams)                setBusinessModel('teams');
  }, [businessModel, status.has_teams, status.has_plans]);

  const STEPS = buildSteps(businessModel);

  // `model` se considera "done" solo si la escuela ya creó al menos un team o
  // plan, no solo porque schools.business_model tenga valor (puede venir del
  // default 'teams' del backfill). Asi forzamos al admin a ver el step en su
  // primer onboarding y confirmar explicitamente como organiza su academia.
  const isStepDoneById = useCallback((id: StepId): boolean => {
    switch (id) {
      case 'branch':   return !!status.has_branches;
      case 'model':    return !!status.has_teams || !!status.has_plans;
      case 'team':     return !!status.has_teams;
      case 'plan':     return !!status.has_plans;
      case 'coach':    return !!status.has_staff;
      case 'student':  return !!status.has_students;
      case 'payments': return !!status.payment_setup_completed;
      default:         return false;
    }
  }, [status]);

  // Determine initial step based on what's already done
  const getInitialStep = useCallback(() => {
    for (let i = 0; i < STEPS.length; i++) {
      if (!isStepDoneById(STEPS[i].id)) return i;
    }
    return 0;
  }, [STEPS, isStepDoneById]);

  const [currentStep, setCurrentStep] = useState(getInitialStep);
  const [saving, setSaving] = useState(false);

  // Branch form
  const [branchAddress, setBranchAddress] = useState('');
  const [branchCity, setBranchCity] = useState('');
  const [branchPhone, setBranchPhone] = useState('');

  // Team form
  const [teamName, setTeamName] = useState('');
  const [teamSport, setTeamSport] = useState('');
  const [teamModality, setTeamModality] = useState('');
  const [teamPrice, setTeamPrice] = useState('150000');

  // Plan form (mensualidad / paquete)
  const [planName, setPlanName] = useState('');
  const [planPrice, setPlanPrice] = useState('120000');
  const [planBilling, setPlanBilling] = useState<'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [planSessions, setPlanSessions] = useState<string>(''); // vacio = ilimitado

  // Coach form
  const [coachName, setCoachName] = useState('');
  const [coachEmail, setCoachEmail] = useState('');

  // Student form
  const [studentName, setStudentName] = useState('');
  const [studentIsAdult, setStudentIsAdult] = useState(false);
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('');

  // Payments form — bloque unificado school/trainer/vendor:
  // Nequi + Bre-B + Banco + Cuenta + Tipo + WhatsApp.
  const [nequi,         setNequi]         = useState('');
  const [brebKey,       setBrebKey]       = useState('');
  const [bankCode,      setBankCode]      = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType,   setAccountType]   = useState('ahorros');
  const [whatsapp,      setWhatsapp]      = useState('');

  // Existing records IDs for update
  const [existingTeamId, setExistingTeamId] = useState<string | null>(null);
  const [existingOfferingId, setExistingOfferingId] = useState<string | null>(null);
  const [existingPlanId, setExistingPlanId] = useState<string | null>(null);

  // Load existing onboarding data
  useEffect(() => {
    if (schoolId) {
      loadBranchData();
      loadTeamData();
      loadPlanData();
      loadPaymentsData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schoolId]);

  const loadBranchData = async () => {
    if (!schoolId) return;
    const { data } = await supabase
      .from('school_branches')
      .select('address, city, phone')
      .eq('school_id', schoolId)
      .eq('is_main', true)
      .maybeSingle();

    if (data) {
      setBranchAddress(data.address || '');
      setBranchCity(data.city || '');
      setBranchPhone(data.phone || '');
    }
  };

  const loadTeamData = async () => {
    if (!schoolId) return;
    const { data } = await supabase
      .from('teams')
      .select('id, name, sport, sport_modality, price_monthly')
      .eq('school_id', schoolId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (data) {
      setExistingTeamId(data.id);
      setTeamName(data.name || '');
      setTeamSport(data.sport || '');
      setTeamModality(data.sport_modality || '');
      setTeamPrice(String(data.price_monthly || '150000'));
      return;
    }

    // Sin equipo todavía: se precarga el deporte que la academia ya eligió en el
    // registro, en vez de volver a preguntarlo (hallazgo A).
    const { data: school } = await supabase
      .from('schools')
      .select('sports')
      .eq('id', schoolId)
      .maybeSingle();
    const sport = resolveSignupSport({
      schoolSports: (school as { sports?: string[] | null } | null)?.sports,
      metadataSport: user?.user_metadata?.sport_name,
      catalog: SPORTS_LIST,
    });
    if (sport) setTeamSport((prev) => prev || sport);
  };

  const loadPlanData = async () => {
    if (!schoolId) return;
    const { data: offering } = await supabase
      .from('offerings')
      .select('id, name, sport')
      .eq('school_id', schoolId)
      .eq('offering_type', 'membership')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (offering) {
      setExistingOfferingId(offering.id);
      setPlanName(offering.name || '');

      const { data: plan } = await supabase
        .from('offering_plans')
        .select('id, price, duration_days, max_sessions')
        .eq('offering_id', offering.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (plan) {
        setExistingPlanId(plan.id);
        setPlanPrice(String(plan.price || '120000'));
        const billing = plan.duration_days === 365 ? 'yearly'
          : (plan.duration_days === 90 ? 'quarterly' : 'monthly');
        setPlanBilling(billing);
        setPlanSessions(plan.max_sessions === null ? '' : String(plan.max_sessions));
      }
    }
  };

  const loadPaymentsData = async () => {
    if (!schoolId) return;
    const { data } = await supabase
      .from('school_settings')
      .select('bank_name, bank_account_number, bank_account_type, nequi_number, breb_key, whatsapp_number')
      .eq('school_id', schoolId)
      .maybeSingle();

    if (data) {
      setBankCode(data.bank_name || '');
      setAccountNumber(data.bank_account_number || '');
      setAccountType(data.bank_account_type || 'ahorros');
      setNequi(data.nequi_number || '');
      setBrebKey(data.breb_key || '');
      setWhatsapp(data.whatsapp_number || '');
    }
  };

  // Wrapper indice-based para compatibilidad con codigo de render que itera por index
  const isStepDone = (index: number) => {
    const step = STEPS[index];
    return step ? isStepDoneById(step.id) : false;
  };

  const completedCount = STEPS.filter((_, i) => isStepDone(i)).length;
  const progress = Math.round((completedCount / STEPS.length) * 100);
  // Solo se considera "todo listo para finalizar" si los pasos required estan hechos.
  const allRequiredDone = STEPS.filter(s => s.required).every(s => isStepDoneById(s.id));

  // ── Step Handlers ──

  const handleSaveBranch = async () => {
    if (!schoolId) return;
    if (!branchAddress.trim()) {
      toast({ title: 'Ingresa la direccion de tu sede', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Update existing main branch
      const { error } = await supabase
        .from('school_branches')
        .update({
          address: branchAddress.trim(),
          city: branchCity.trim() || null,
          phone: branchPhone.trim() || null,
        })
        .eq('school_id', schoolId)
        .eq('is_main', true);

      if (error) throw error;

      toast({ title: 'Sede actualizada' });
      onRefresh();
      goNext();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleChooseModel = async (model: BusinessModel) => {
    if (!schoolId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('schools')
        .update({ business_model: model })
        .eq('id', schoolId);

      if (error) throw error;

      setBusinessModel(model);
      toast({ title: 'Modelo guardado' });
      onRefresh();
      // Avanzamos al siguiente paso (team o plan) automaticamente para que
      // el usuario no se quede preguntandose como seguir. El step 'model'
      // permanece en STEPS y puede revisitarse via las pills.
      setCurrentStep(prev => prev + 1);
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  /**
   * Crea el primer plan de la escuela en las DOS tablas que hacen falta.
   *
   * 1. `offering` + `offering_plan` (por `school_id`): es lo que lee el resto
   *    del producto — el selector de plan del editor de atleta, el QR de
   *    inscripción y el motor de cobros. Sin esto, el paso "creaba" un plan que
   *    no aparecía en ninguna parte: la escuela terminaba el onboarding y al ir
   *    a asignárselo a un atleta la lista estaba vacía. Medido el 2026-08-11:
   *    5 de las 10 escuelas que pasaron por este paso no tenían ni un
   *    `offering_plan`, o sea que su único plan era invisible.
   *
   * 2. `subscription_plan` tipo school_monthly atado al vendor_profile del
   *    owner: es del dominio de marketplace/cobros recurrentes, y además es lo
   *    que mira `has_plans` en get_onboarding_status para marcar el paso como
   *    hecho. Por eso se conserva. Si el owner no tiene vendor_profile aun
   *    (school role ya no auto-crea), lo creamos silenciosamente con
   *    capabilities en false. No abre Mi Tienda — el addon store sigue
   *    siendo lo que decide eso.
   */
  const handleCreatePlan = async () => {
    if (!schoolId || !user) return;
    if (!planName.trim()) {
      toast({ title: 'Ingresa el nombre del plan', variant: 'destructive' });
      return;
    }
    // Inscripción / seguro no son planes (pagos únicos del plan mensual). Este paso
    // escribe directo en Supabase, sin el guard del BFF: se valida acá.
    if (esNombreDePagoUnico(planName)) {
      toast({ title: 'Ese nombre no es un plan', description: PAGO_UNICO_NO_ES_PLAN_MSG, variant: 'destructive' });
      return;
    }
    if (!planPrice || Number(planPrice) <= 0) {
      toast({ title: 'Precio inválido', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const durationDays = planBilling === 'yearly' ? 365
        : planBilling === 'quarterly' ? 90
        : 30;

      let offeringId = existingOfferingId;

      if (offeringId) {
        // Update existing offering
        const { error: offErr } = await supabase
          .from('offerings')
          .update({
            name: planName.trim(),
            sport: teamSport || null,
          })
          .eq('id', offeringId);
        if (offErr) throw offErr;
      } else {
        // Insert new offering
        const { data: newOffering, error: offErr } = await supabase
          .from('offerings')
          .insert({
            school_id:     schoolId,
            name:          planName.trim(),
            offering_type: 'membership',
            sport:         teamSport || null,
          })
          .select('id')
          .single();
        if (offErr) throw offErr;
        offeringId = (newOffering as any).id;
        setExistingOfferingId(offeringId);
      }

      if (existingPlanId) {
        // Update existing offering_plan
        const { error: planErr } = await supabase
          .from('offering_plans')
          .update({
            name:         planBilling === 'yearly' ? 'Anual' : (planBilling === 'quarterly' ? 'Trimestral' : 'Mensual'),
            price:        Number(planPrice),
            duration_days: durationDays,
            max_sessions: planSessions === '' ? null : Number(planSessions),
          })
          .eq('id', existingPlanId);
        if (planErr) throw planErr;
        toast({ title: 'Plan actualizado' });
      } else {
        // Insert new offering_plan
        const { data: newPlanData, error: planErr } = await supabase
          .from('offering_plans')
          .insert({
            school_id:    schoolId,
            offering_id:  offeringId,
            name:         planBilling === 'yearly' ? 'Anual' : (planBilling === 'quarterly' ? 'Trimestral' : 'Mensual'),
            price:        Number(planPrice),
            duration_days: durationDays,
            max_sessions: planSessions === '' ? null : Number(planSessions),
            is_active:    true,
          })
          .select('id')
          .single();
        if (planErr) throw planErr;
        if (newPlanData) {
          setExistingPlanId(newPlanData.id);
        }
        toast({ title: 'Plan creado' });
      }

      onRefresh();
      goNext();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateTeam = async () => {
    if (!schoolId) return;
    if (!teamName.trim() || !teamSport) {
      toast({ title: 'Completa nombre y deporte del equipo', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Get main branch
      const { data: branch } = await supabase
        .from('school_branches')
        .select('id')
        .eq('school_id', schoolId)
        .eq('is_main', true)
        .maybeSingle();

      if (existingTeamId) {
        // Update existing team
        const { error } = await supabase
          .from('teams')
          .update({
            name: teamName.trim(),
            sport: teamSport,
            sport_modality: modalityToSave(teamSport, teamModality),
            price_monthly: Number(teamPrice) || 150000,
            branch_id: branch?.id || null,
          })
          .eq('id', existingTeamId);

        if (error) throw error;
        toast({ title: 'Equipo actualizado' });
      } else {
        // Insert new team
        const { data: newTeam, error } = await supabase
          .from('teams')
          .insert({
            school_id: schoolId,
            name: teamName.trim(),
            sport: teamSport,
            sport_modality: modalityToSave(teamSport, teamModality),
            price_monthly: Number(teamPrice) || 150000,
            branch_id: branch?.id || null,
            status: 'active',
            current_students: 0,
          })
          .select('id')
          .single();

        if (error) throw error;
        if (newTeam) {
          setExistingTeamId(newTeam.id);
        }
        toast({ title: 'Equipo creado' });
      }

      onRefresh();
      goNext();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleInviteCoach = async () => {
    if (!schoolId) return;
    if (!coachName.trim() || !coachEmail.trim()) {
      toast({ title: 'Completa nombre y email del entrenador', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Create staff record
      const { error: staffError } = await supabase
        .from('school_staff')
        .insert({
          school_id: schoolId,
          full_name: coachName.trim(),
          email: coachEmail.trim().toLowerCase(),
          specialty: 'coach',
          status: 'active',
        });

      if (staffError) throw staffError;

      // Enviar email de invitacion al coach
      const registrationUrl = `${window.location.origin}/register?email=${encodeURIComponent(coachEmail.trim())}&role=coach`;
      try {
        await emailClient.send({
          type: 'coach_invitation',
          to: coachEmail.trim().toLowerCase(),
          data: {
            coachName: coachName.trim(),
            schoolName: schoolName || 'Tu Academia',
            registrationUrl,
          },
        });
      } catch (emailErr) {
        console.warn('Email de coach no enviado:', emailErr);
      }

      toast({ title: 'Entrenador agregado e invitacion enviada' });
      onRefresh();
      goNext();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleCreateStudent = async () => {
    if (!schoolId) return;
    if (!studentName.trim()) {
      toast({ title: 'Ingresa el nombre del atleta', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      // Get first team for auto-assign
      const { data: firstTeam } = await supabase
        .from('teams')
        .select('id, name, price_monthly')
        .eq('school_id', schoolId)
        .limit(1)
        .maybeSingle();

      const { error } = await supabase
        .from('children')
        .insert({
          full_name: studentName.trim(),
          school_id: schoolId,
          team_id: firstTeam?.id || null,
          // Si el atleta es mayor de edad, no se piden datos del padre.
          parent_email_temp: studentIsAdult ? null : (parentEmail.trim() || null),
          parent_phone_temp: studentIsAdult ? null : (parentPhone.trim() || null),
        });

      if (error) throw error;

      // Enviar email de invitacion al padre solo si NO es adulto y hay email
      if (!studentIsAdult && parentEmail.trim()) {
        const registrationUrl = `${window.location.origin}/register?email=${encodeURIComponent(parentEmail.trim())}&role=parent`;
        try {
          await emailClient.send({
            type: 'parent_invitation',
            to: parentEmail.trim().toLowerCase(),
            data: {
              schoolName: schoolName || 'Tu Academia',
              childName: studentName.trim(),
              registrationUrl,
            },
          });
        } catch (emailErr) {
          console.warn('Email de padre no enviado:', emailErr);
        }
      }

      toast({
        title: studentIsAdult
          ? 'Atleta registrado'
          : (parentEmail.trim()
              ? 'Atleta registrado e invitación enviada al padre'
              : 'Atleta registrado'),
      });
      onRefresh();
      goNext();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleSavePayments = async () => {
    if (!schoolId) return;
    // Validacion: minimo un metodo de cobro (Nequi, Bre-B, o cuenta bancaria).
    const hasBank = !!bankCode && !!accountNumber.trim();
    const hasNequi = !!nequi.trim();
    const hasBreb = !!brebKey.trim();
    if (!hasBank && !hasNequi && !hasBreb) {
      toast({
        title: 'Necesitas al menos un método de cobro',
        description: 'Agrega un número Nequi, una llave Bre-B, o una cuenta bancaria.',
        variant: 'destructive',
      });
      return;
    }
    setSaving(true);
    try {
      // Las llaves se guardan en payment_accounts, que es lo que ve el acudiente y
      // lo que el OCR acepta como destino. Las columnas sueltas se siguen llenando
      // como espejo. Desde el panel de cobros la escuela puede agregar las que
      // quiera; acá el wizard solo captura la primera de cada tipo.
      const paymentAccounts = [
        ...(nequi.trim()   ? [{ id: newAccountId(), type: 'nequi' as const, label: 'Nequi', value: nequi.trim(),   active: true }] : []),
        ...(brebKey.trim() ? [{ id: newAccountId(), type: 'breb'  as const, label: 'Bre-B', value: brebKey.trim(), active: true }] : []),
      ];

      const { error } = await supabase
        .from('school_settings')
        .upsert({
          school_id:           schoolId,
          bank_name:           bankCode || null,
          bank_account_number: accountNumber.trim() || null,
          bank_account_type:   hasBank ? accountType : null,
          payment_accounts:    paymentAccounts,
          nequi_number:        nequi.trim() || null,
          breb_key:            brebKey.trim() || null,
          whatsapp_number:     whatsapp.trim() || null,
        }, { onConflict: 'school_id' });

      if (error) throw error;

      toast({ title: 'Datos de cobro guardados' });
      onRefresh();
      handleFinish();
    } catch (err: any) {
      toast({ title: 'Error', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleFinish = async () => {
    if (!schoolId) return;
    // Mark onboarding as completed
    await supabase
      .from('schools')
      .update({ onboarding_status: 'completed' })
      .eq('id', schoolId);

    onComplete();
  };

  const goNext = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  const goBack = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSkip = () => {
    if (!STEPS[currentStep].required) {
      goNext();
    }
  };

  // ── Render Step Content ──

  const renderStepContent = () => {
    const stepId = STEPS[currentStep]?.id;
    switch (stepId) {
      case 'branch':
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Direccion *</Label>
              <Input
                placeholder="Calle 123 #45-67, Barrio Centro"
                value={branchAddress}
                onChange={(e) => setBranchAddress(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Ciudad</Label>
                <CityCombobox value={branchCity} onChange={setBranchCity} />
              </div>
              <div className="space-y-2">
                <Label>Teléfono</Label>
                <PhoneInput value={branchPhone} onChange={setBranchPhone} placeholder="Número de celular" />
              </div>
            </div>
            <Button onClick={handleSaveBranch} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              Confirmar Sede
            </Button>
          </div>
        );

      case 'model': {
        const MODELS: Array<{ key: BusinessModel; title: string; subtitle: string; icon: React.ElementType }> = [
          { key: 'teams', title: 'Equipos / grupos',     subtitle: 'Fútbol sub-15, natación intermedia, etc.',           icon: Trophy },
          { key: 'plans', title: 'Planes / membresías',  subtitle: 'Mensualidad gym, paquete 10 clases, curso por mes.', icon: Tag },
          { key: 'both',  title: 'Ambos',                 subtitle: 'Tengo equipos competitivos y también planes libres.', icon: Layers },
        ];
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Elige cómo organizas a tus deportistas. Esto define los siguientes pasos del onboarding.
            </p>
            <div className="grid gap-3">
              {MODELS.map(m => {
                const Icon = m.icon;
                const active = businessModel === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    disabled={saving}
                    onClick={() => handleChooseModel(m.key)}
                    className={`flex items-start gap-3 text-left rounded-lg border p-4 transition-colors hover:bg-muted ${active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border'}`}
                  >
                    <div className="p-2 rounded-md bg-primary/10 shrink-0">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{m.title}</p>
                      <p className="text-xs text-muted-foreground">{m.subtitle}</p>
                    </div>
                    {active && <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Podrás cambiarlo después en Configuraciones.
            </p>
          </div>
        );
      }

      case 'team':
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nombre del equipo *</Label>
              <Input
                placeholder="Ej: Futbol Sub-15, Natacion Iniciacion"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Deporte *</Label>
                <Select value={teamSport} onValueChange={(v) => { setTeamSport(v); setTeamModality(''); }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar" />
                  </SelectTrigger>
                  <SelectContent>
                    {SPORTS_LIST.map((sport) => (
                      <SelectItem key={sport} value={sport}>{sport}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Precio mensual (COP)</Label>
                <Input
                  type="number"
                  placeholder="150000"
                  value={teamPrice}
                  onChange={(e) => setTeamPrice(e.target.value)}
                />
              </div>
            </div>
            <FootballModalitySelect sport={teamSport} value={teamModality} onChange={setTeamModality} />
            <Button onClick={handleCreateTeam} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trophy className="h-4 w-4 mr-2" />}
              Crear Equipo
            </Button>
          </div>
        );

      case 'plan':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Crea tu primera mensualidad o paquete. Lo usarás para inscribir a los atletas.
            </p>
            <div className="space-y-2">
              <Label>Nombre del plan *</Label>
              <Input
                placeholder="Ej: Mensualidad ilimitada, Paquete 10 clases"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Precio (COP) *</Label>
                <Input
                  type="number"
                  placeholder="120000"
                  value={planPrice}
                  onChange={(e) => setPlanPrice(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Cobro cada</Label>
                <Select value={planBilling} onValueChange={(v: any) => setPlanBilling(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Mes</SelectItem>
                    <SelectItem value="quarterly">Trimestre</SelectItem>
                    <SelectItem value="yearly">Año</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sesiones</Label>
                <Input
                  type="number"
                  placeholder="Ilimitado"
                  value={planSessions}
                  onChange={(e) => setPlanSessions(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={handleCreatePlan} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Tag className="h-4 w-4 mr-2" />}
              Crear Plan
            </Button>
          </div>
        );

      case 'coach':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Agrega a tu entrenador principal. Recibira una invitacion para unirse.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Nombre completo *</Label>
                <Input
                  placeholder="Carlos Rodriguez"
                  value={coachName}
                  onChange={(e) => setCoachName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Email *</Label>
                <Input
                  type="email"
                  placeholder="coach@email.com"
                  value={coachEmail}
                  onChange={(e) => setCoachEmail(e.target.value)}
                />
              </div>
            </div>
            <Button onClick={handleInviteCoach} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
              Invitar Entrenador
            </Button>
          </div>
        );

      case 'student':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Registra a tu primer deportista. Si es menor de edad necesitamos los datos del padre/madre para enviarles la invitación.
            </p>
            <div className="space-y-2">
              <Label>Nombre del atleta *</Label>
              <Input
                placeholder="Juan Pérez"
                value={studentName}
                onChange={(e) => setStudentName(onlyLetters(e.target.value))}
              />
              <p className="text-[11px] text-muted-foreground">Solo letras. Sin números.</p>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={studentIsAdult}
                onChange={(e) => setStudentIsAdult(e.target.checked)}
              />
              El atleta es mayor de edad
            </label>

            {!studentIsAdult && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Email del padre (opcional)</Label>
                  <Input
                    type="email"
                    placeholder="padre@email.com"
                    value={parentEmail}
                    onChange={(e) => setParentEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Teléfono del padre (opcional)</Label>
                  <PhoneInput value={parentPhone} onChange={setParentPhone} placeholder="Número de celular" />
                </div>
              </div>
            )}

            <Button onClick={handleCreateStudent} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <GraduationCap className="h-4 w-4 mr-2" />}
              Registrar Atleta
            </Button>
          </div>
        );

      case 'payments':
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Configura cómo vas a recibir pagos de las familias. Mínimo un método.
            </p>

            <div className="space-y-2">
              <Label>Número Nequi</Label>
              <Input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="Número de 10 dígitos"
                value={nequi}
                onChange={(e) => setNequi(onlyDigits(e.target.value).slice(0, 10))}
              />
            </div>

            <div className="space-y-2">
              <Label>Llave Bre-B</Label>
              <Input
                placeholder="Celular, email, NIT, CC o alias custom"
                value={brebKey}
                onChange={(e) => setBrebKey(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Bre-B es el sistema de pagos inmediatos del Banco de la República. La llave puede ser tu celular, email, NIT, cédula o un alias.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Banco</Label>
              <BankCombobox value={bankCode} onChange={setBankCode} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Número de cuenta</Label>
                <Input
                  inputMode="numeric"
                  placeholder="0000000000"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(onlyDigits(e.target.value))}
                />
                <p className="text-[11px] text-muted-foreground">Solo números, sin guiones.</p>
              </div>
              <div className="space-y-2">
                <Label>Tipo de cuenta</Label>
                <Select value={accountType} onValueChange={setAccountType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ahorros">Ahorros</SelectItem>
                    <SelectItem value="corriente">Corriente</SelectItem>
                    <SelectItem value="billetera_digital">Billetera digital</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>WhatsApp de contacto</Label>
              <PhoneInput value={whatsapp} onChange={setWhatsapp} placeholder="Número de celular" />
            </div>

            <Button onClick={handleSavePayments} disabled={saving} className="w-full">
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CreditCard className="h-4 w-4 mr-2" />}
              Guardar y Finalizar
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  const shellSteps: ShellStep[] = STEPS.map(s => ({
    id:          s.id,
    title:       s.title,
    description: s.subtitle,
    icon:        s.icon,
    done:        isStepDoneById(s.id),
  }));

  const currentStepDef = STEPS[currentStep];
  const isCurrentDone  = currentStepDef ? isStepDoneById(currentStepDef.id) : false;

  const stepBody = isCurrentDone ? (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <CheckCircle2 className="h-12 w-12 text-primary" />
      <p className="text-muted-foreground">Este paso ya está completado. Puedes continuar al siguiente.</p>
      <Button onClick={goNext} disabled={currentStep >= STEPS.length - 1}>
        Siguiente <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  ) : (
    renderStepContent()
  );

  const isLastStep = currentStep >= STEPS.length - 1;
  // Siguiente queda habilitado solo si el paso actual esta completo. Asi
  // el usuario no avanza dejando datos atras en pasos required, pero si
  // puede avanzar en pasos opcionales una vez que los completo o saltó.
  const canAdvance = isCurrentDone && !isLastStep;

  const footer = (
    <>
      <Button variant="ghost" size="sm" onClick={goBack} disabled={currentStep === 0}>
        <ChevronLeft className="h-4 w-4 mr-1" /> Anterior
      </Button>
      <div className="flex items-center gap-2">
        {currentStepDef && !currentStepDef.required && !isCurrentDone && (
          <Button variant="ghost" size="sm" onClick={handleSkip}>
            <SkipForward className="h-4 w-4 mr-1" /> Saltar
          </Button>
        )}
        {allRequiredDone && (
          <Button variant="outline" size="sm" onClick={handleFinish}>
            Terminar después <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        )}
        {!isLastStep && (
          <Button
            size="sm"
            onClick={goNext}
            disabled={!canAdvance}
            title={canAdvance ? 'Continuar al siguiente paso' : 'Completa este paso para continuar'}
          >
            Siguiente <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
      </div>
    </>
  );

  return (
    <OnboardingShell
      title={schoolName ? `Configura ${schoolName}` : 'Configura tu academia'}
      eyebrow="Configuración inicial"
      steps={shellSteps}
      currentStep={currentStep}
      onStepChange={setCurrentStep}
      footer={footer}
      variant={variant}
    >
      {stepBody}
    </OnboardingShell>
  );
}
