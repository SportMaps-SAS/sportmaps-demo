/**
 * CreateChildModal — Registro de Menor de Edad
 *
 * Escrituras en BD:
 *   1. INSERT children         → child_id
 *   2. INSERT enrollments      → child_id + team_id (si aplica, independiente)
 *   3. INSERT enrollments      → child_id + offering_plan_id + offering_id (si aplica, independiente)
 *   4. INSERT payments         → pago proporcional del primer mes
 *   5. INSERT invitations      → para el acudiente
 *
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
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Baby, Users, ClipboardList, Info, Loader2, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { phoneForForm, type AthletePrefill } from './athletePrefill';
import { useEntitlements } from '@/hooks/useEntitlements';
import { ZkPinField, zkPinToPayload } from './ZkPinField';
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
import { Search, CheckCircle2, Calendar as CalendarIcon } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { PhoneInput } from '@/components/ui/phone-input';
import { SiblingChildPicker, SiblingDiscountChip, type SiblingPreview } from '@/components/students/siblings';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Team {
  id: string;
  name: string;
  sport: string;
  price_monthly: number | null;
}

/** Fila aplanada de offering_plans JOIN offerings */
interface PlanOption {
  plan_id: string;          // offering_plans.id
  offering_id: string;      // offerings.id
  offering_name: string;    // offerings.name  (ej: "PLAN COMBATE")
  plan_name: string;        // offering_plans.name (ej: "FULL")
  price: number;            // offering_plans.price
  duration_days: number;
  registration_fee: number | null; // offering_plans.registration_fee (D17) — null = sin inscripción
  insurance_fee: number | null;    // offering_plans.insurance_fee (F-B) — null = sin seguro
}

interface Branch { id: string; name: string; }

interface CreateChildModalProps {
  open: boolean;
  onClose: () => void;
  /** Recibe la respuesta de create-one (`child_id`, …). */
  onSuccess: (result?: any) => void;
  schoolId: string;
  prefill?: AthletePrefill | null;
  /** «No cobrar inscripción / seguro». El coach no exonera (default true; el BFF también lo frena). */
  canWaiveFees?: boolean;
  /**
   * «¿Tiene un hermano inscrito?» (F2 hermanos). El coach no la ve y el BFF le
   * responde 403. Por defecto sigue a `canWaiveFees` (false para el coach).
   */
  canUseSiblings?: boolean;
}

interface BillingSettings {
  payment_cutoff_day: number;
  billing_cycle_type: 'prorated' | 'fixed_calendar' | 'rolling_30';
  /** «Primer cobro sin recargo»: la base mueve el primer cobro al próximo corte (trigger). */
  late_fee_skip_signup_month?: boolean;
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  icon, title, children,
}: {
  icon: React.ReactNode; title: string; children: React.ReactNode;
}) {
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

export function CreateChildModal({ open, onClose, onSuccess, schoolId, canWaiveFees = true, canUseSiblings, prefill }: CreateChildModalProps) {
  const siblingsAllowed = canUseSiblings ?? canWaiveFees;
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [showMedical, setShowMedical] = useState(false);

  // Lookup data
  const [teams, setTeams]       = useState<Team[]>([]);
  const [plans, setPlans]       = useState<PlanOption[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [billing, setBilling] = useState<BillingSettings>({
    payment_cutoff_day: 10,
    billing_cycle_type: 'prorated',
  });

  // ── Sección 1: Datos del menor ────────────────────────────────────────────
  const [docType, setDocType]     = useState('TI');
  const [docNumber, setDocNumber] = useState('');
  const [fullName, setFullName]   = useState('');
  const [dob, setDob]             = useState('');
  const [gender, setGender]       = useState('');
  const [grade, setGrade]         = useState('');
  const [dorsal, setDorsal]       = useState('');
  const [zkPin, setZkPin]         = useState('');
  const [medicalHasAllergies, setMedicalHasAllergies] = useState<'false' | 'true'>('false');
  const [medicalNotes, setMedicalNotes] = useState('');

  // ── Sección 2: Acudiente ──────────────────────────────────────────────────
  const [parentName, setParentName]   = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [parentPhone, setParentPhone] = useState('+57');

  const [checkingParentEmail, setCheckingParentEmail] = useState(false);
  const [parentEmailExists, setParentEmailExists] = useState<boolean | null>(null);
  const [sendInviteEmail, setSendInviteEmail]       = useState(true);
  const [sendInviteWhatsapp, setSendInviteWhatsapp] = useState(true);

  // ── Sección 3: Inscripción ────────────────────────────────────────────────
  const [branchId, setBranchId]   = useState('none');
  const [teamId, setTeamId]       = useState('none');
  const [selectedPlanId, setSelectedPlanId]       = useState('none');
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
  const [startDate, setStartDate]   = useState(() => todayColombia());
  // `hasBilling` y no el tipo de escuela: la pregunta es si esta escuela
  // factura por SportMaps, no si ademas alquila espacios. Falla ABIERTO
  // (true mientras carga), asi que el caso normal no cambia.
  const { hasBilling, parentEmailOptional, registrationZkPinEnabled } = useEntitlements();

  const [monthlyFee, setMonthlyFee] = useState('');
  const [discountPct, setDiscountPct] = useState(0);

  // ── Hermanos (F2): hermano ya inscrito cuyo acudiente aún no tiene cuenta ──
  const [hasSibling, setHasSibling] = useState(false);
  const [siblingOfChildId, setSiblingOfChildId] = useState<string | null>(null);
  const [siblingPreview, setSiblingPreview] = useState<SiblingPreview | null>(null);
  const [siblingPreviewLoading, setSiblingPreviewLoading] = useState(false);
  // Sube cuando el BFF responde HERMANOS_DESACTUALIZADO: fuerza recalcular.
  const [siblingPreviewNonce, setSiblingPreviewNonce] = useState(0);

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

  // Auto-fill mensualidad desde equipo seleccionado (solo si no hay plan)
  useEffect(() => {
    if (teamId && teamId !== 'none' && selectedPlanId === 'none') {
      const t = teams.find(t => t.id === teamId);
      if (t?.price_monthly) setMonthlyFee(String(t.price_monthly));
    }
  }, [teamId, teams, selectedPlanId]);

  // Cuando se selecciona plan, guardar offering_id y precio
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
      setMonthlyFee(String(p.price));
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const reset = () => {
    setDocType('TI'); setDocNumber(''); setFullName(''); setDob('');
    setGender(''); setGrade(''); setDorsal(''); setZkPin('');
    setMedicalHasAllergies('false'); setMedicalNotes('');
    setParentName(''); setParentEmail(''); setParentPhone('+57');
    setBranchId('none'); setTeamId('none');
    setSelectedPlanId('none'); setSelectedOfferingId(''); setSelectedPlanPrice(0); setSelectedPlanRegistrationFee(0); setSelectedPlanInsuranceFee(0);
    setFirstPayment(DEFAULT_FIRST_PAYMENT_CHOICE);
    setFeeWaivers(defaultFeeWaivers(canWaiveFees));
    setStartDate(todayColombia()); setMonthlyFee('');
    setDiscountPct(0);
    setHasSibling(false); setSiblingOfChildId(null); setSiblingPreview(null);
    setCheckingParentEmail(false);
    setParentEmailExists(null);
    setSendInviteEmail(true);
    setSendInviteWhatsapp(true);
  };

  const handleClose = () => { reset(); onClose(); };

  // Abre precargado (prospecto de clase de prueba): solo lo que se sabe.
  useEffect(() => {
    if (!open || !prefill) return;
    if (prefill.fullName) setFullName(prefill.fullName);
    if (prefill.parentName) setParentName(prefill.parentName);
    if (prefill.phone) setParentPhone(phoneForForm(prefill.phone));
  }, [open, prefill]);

  // ── Búsqueda silenciosa en acudiente ──────────────────────────────────────────
  const checkParentEmailExists = useCallback(async (emailVal: string) => {
    const emailClean = emailVal.trim().toLowerCase();
    if (!emailClean || !emailClean.includes('@')) {
      setParentEmailExists(null);
      return;
    }

    setCheckingParentEmail(true);
    try {
      const data = await bffClient.get(`/api/v1/trainer/search-profile?q=${encodeURIComponent(emailClean)}`, {
        'x-school-id': schoolId
      });

      setParentEmailExists(!!data);
    } catch {
      setParentEmailExists(false);
    } finally {
      setCheckingParentEmail(false);
    }
  }, [schoolId]);

  const handleParentEmailChange = (val: string) => {
    setParentEmail(val);
    setParentEmailExists(null);
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(val.trim())) {
      checkParentEmailExists(val);
    }
  };

  const handleParentEmailBlur = () => {
    checkParentEmailExists(parentEmail);
  };

  // ── Validation ─────────────────────────────────────────────────────────────
  const validate = (): string | null => {
    if (!fullName.trim())  return 'El nombre completo es obligatorio.';
    if (!dob)              return 'La fecha de nacimiento es obligatoria.';
    if (!parentName.trim() || parentName.trim().length < 2)
      return 'El nombre del acudiente es obligatorio (mín. 2 caracteres).';
    if (!parentEmailOptional && (!parentEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parentEmail)))
      return 'El email del acudiente no es válido.';
    if (!/^\d{10,}$/.test(parentPhone.replace(/\D/g, '')))
      return 'El teléfono del acudiente debe tener mínimo 10 dígitos.';
    if (!startDate) return 'La fecha de inscripción es obligatoria.';
    if (!branchId || branchId === 'none') return 'La sede es obligatoria.';
    const fee = Number(monthlyFee);
    if (monthlyFee && (isNaN(fee) || fee < 10000))
      return 'La mensualidad debe ser ≥ $10.000 COP.';
    return null;
  };

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

  // ── Preview del descuento por hermanos (lo calcula el BFF) ──────────────────
  // first-payment-preview exige un plan; sin plan no hay mensualidad que
  // descontar y el chip no se muestra. Si el acudiente ya tiene cuenta y comparte
  // parent_id, el BFF puede devolver `sibling` sin que se elija nada.
  const siblingPayload: { sibling_of_child_id?: string } = siblingsAllowed && hasSibling && siblingOfChildId
    ? { sibling_of_child_id: siblingOfChildId }
    : {};
  useEffect(() => {
    if (!open || !hasBilling || !siblingsAllowed || !schoolId || !startDate || !selectedPlanId || selectedPlanId === 'none') {
      setSiblingPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSiblingPreviewLoading(true);
      try {
        const fee = Number(monthlyFee) || 0;
        const res = await bffClient.post('/api/v1/students/first-payment-preview', {
          offering_plan_id: selectedPlanId,
          start_date: startDate,
          monthly_fee: fee > 0 ? fee : null,
          discount_pct: discountPct > 0 ? discountPct : undefined,
          ...feeWaiversPayload(feeWaivers),
          ...siblingPayload,
        }, { 'x-school-id': schoolId }) as { sibling?: SiblingPreview | null };
        if (!cancelled) setSiblingPreview(res?.sibling ?? null);
      } catch {
        // El preview es informativo: si falla, el alta sigue igual y el
        // descuento lo vuelve a calcular el BFF al crear el cobro.
        if (!cancelled) setSiblingPreview(null);
      } finally {
        if (!cancelled) setSiblingPreviewLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasBilling, siblingsAllowed, schoolId, selectedPlanId, startDate, monthlyFee, discountPct,
      feeWaivers.registration, feeWaivers.insurance, hasSibling, siblingOfChildId, siblingPreviewNonce]);

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast({ title: 'Datos incompletos', description: err, variant: 'destructive' }); return; }

    const medicalInfo = JSON.stringify({
      has_allergies: medicalHasAllergies === 'true',
      notes: medicalNotes.trim(),
    });

    setSubmitting(true);

    try {
      // Verificar duplicado localmente
      if (docNumber.trim()) {
        const { data: existingChild } = await supabase
          .from('children')
          .select('id, full_name')
          .eq('school_id', schoolId)
          .eq('doc_number', docNumber.trim())
          .maybeSingle();

        if (existingChild) {
          toast({
            title: 'Menor ya registrado',
            description: `Ya existe un menor con documento ${docNumber} en esta escuela: "${existingChild.full_name}".`,
            variant: 'destructive',
          });
          setSubmitting(false);
          return;
        }
      }

      const enrollmentData = {
        branch_id:        (branchId && branchId !== 'none') ? branchId : null,
        team_id:          (teamId && teamId !== 'none') ? teamId : null,
        offering_plan_id: (selectedPlanId && selectedPlanId !== 'none') ? selectedPlanId : null,
        offering_id:      selectedOfferingId || null,
        start_date:       startDate,
        monthly_fee:      monthlyFee ? Number(monthlyFee) : null,
        discount_pct:     discountPct > 0 ? discountPct : undefined,
        ...firstPaymentPayload,
        ...feeWaiversPayload(feeWaivers),
        ...siblingPayload,
      };

      const result = await bffClient.post('/api/v1/students/create-one', {
        type: 'child',
        ...enrollmentData,
        doc_type:   docType,
        doc_number: docNumber.trim() || null,
        full_name:    fullName.trim(),
        date_of_birth: dob || null,
        gender:       gender || null,
        grade:        grade  || null,
        // Escuelas con torniquete en el registro (Dreamers): el ID del lector
        // reemplaza al dorsal y se asocia en el alta.
        ...(registrationZkPinEnabled
          ? { zk_pin: zkPinToPayload(zkPin) }
          : { dorsal: dorsal.trim() || null }),
        medical_info: medicalInfo,
        parent_name:  parentName.trim(),
        parent_email: parentEmail.trim() ? parentEmail.trim().toLowerCase() : null,
        parent_phone: parentPhone.replace(/\D/g, ''),
        send_invite:  sendInviteEmail,
      }, { 'x-school-id': schoolId }) as any;

      toast({
        title: '✅ Registro exitoso',
        description: `${fullName} fue procesado correctamente.${result?.zk_pin ? ` ID del torniquete ${result.zk_pin} asociado.` : ''}`,
      });
      if (result?.zk_pin_warning) {
        toast({ title: 'ID del torniquete sin asociar', description: result.zk_pin_warning, variant: 'destructive' });
      }

      if (sendInviteWhatsapp && result?.registration_link && parentPhone) {
        const phoneClean = parentPhone.replace(/\D/g, '');
        const msg = `¡Hola ${parentName}! ${fullName} ha sido inscrito. Activa tu cuenta aquí: ${result.registration_link}`;
        toast({
          title: 'Invitar acudiente por WhatsApp',
          description: (
            <Button
              className="mt-2 w-full bg-green-600 hover:bg-green-700 text-white text-xs"
              onClick={() => window.open(`https://wa.me/${phoneClean}?text=${encodeURIComponent(msg)}`, '_blank')}
            >
              📱 Abrir WhatsApp
            </Button>
          ) as any,
        });
      }
      reset();
      onSuccess(result);
    } catch (e: any) {
      // F2: entre el preview y el alta cambió la familia (otro hermano entró o
      // salió). El BFF no crea nada; se muestra su mensaje y se recalcula.
      const code = e?.body?.code ?? e?.body?.error_code;
      if (e?.status === 409 && code === 'HERMANOS_DESACTUALIZADO') {
        toast({
          title: 'El descuento por hermanos cambió',
          description: e?.body?.message || e?.body?.error || e.message || 'Revisa el nuevo descuento y vuelve a registrar.',
          variant: 'destructive',
        });
        setSiblingPreviewNonce(n => n + 1);
        return;
      }
      toast({
        title: 'Error al registrar',
        description: e.message || 'Error inesperado',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Baby className="h-5 w-5 text-blue-500" />
            Registrar Menor de Edad
          </DialogTitle>
          <DialogDescription>
            Registra a un menor de edad y asócialo a un acudiente. El acudiente recibirá una invitación para activar su cuenta.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          
          {/* ── Sección 1: Datos del menor ── */}
          <Section icon={<Baby className="h-4 w-4" />} title="Información del Menor">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Tipo de Doc. *</Label>
                <Select value={docType} onValueChange={setDocType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RC">RC — Registro civil</SelectItem>
                    <SelectItem value="TI">TI</SelectItem>
                    <SelectItem value="CC">CC</SelectItem>
                    <SelectItem value="CE">CE</SelectItem>
                    <SelectItem value="PP">Pasaporte</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Número de Documento <span className="text-muted-foreground font-normal">(opcional)</span></Label>
                <Input placeholder="1234567890" value={docNumber} onChange={e => setDocNumber(e.target.value)} />
              </div>
            </div>

            <div>
              <Label>Nombre Completo *</Label>
              <Input placeholder="Ana María Gómez López" value={fullName} onChange={e => setFullName(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col">
                <Label className="mb-2">Fecha de Nacimiento *</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant={"outline"}
                      className={cn(
                        "w-full pl-3 text-left font-normal",
                        !dob && "text-muted-foreground"
                      )}
                    >
                      {dob ? (
                        format(new Date(dob + 'T12:00:00'), "PPP", { locale: es })
                      ) : (
                        <span>Seleccionar fecha</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={dob ? new Date(dob + 'T12:00:00') : undefined}
                      onSelect={(date) => {
                        if (date) {
                          const year = date.getFullYear();
                          const month = String(date.getMonth() + 1).padStart(2, '0');
                          const day = String(date.getDate()).padStart(2, '0');
                          setDob(`${year}-${month}-${day}`);
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
                <Select value={gender} onValueChange={setGender}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">Masculino</SelectItem>
                    <SelectItem value="female">Femenino</SelectItem>
                    <SelectItem value="other">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Grado Escolar</Label>
                <Input placeholder="Ej: 6A, 7B, Primaria" value={grade} onChange={e => setGrade(e.target.value)} />
              </div>
              {registrationZkPinEnabled ? (
                <div className="col-span-2">
                  <ZkPinField id="childZkPin" value={zkPin} onChange={setZkPin} />
                </div>
              ) : (
                <div>
                  <Label>Dorsal</Label>
                  <Input placeholder="Ej: 10" maxLength={10} value={dorsal} onChange={e => setDorsal(e.target.value)} />
                </div>
              )}
            </div>

            <button type="button" onClick={() => setShowMedical(v => !v)} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              {showMedical ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              Información médica {showMedical ? '' : '(opcional)'}
            </button>

            {showMedical && (
              <div className="space-y-3 rounded-lg border border-dashed p-4">
                <div>
                  <Label>¿Tiene alergias?</Label>
                  <Select value={medicalHasAllergies} onValueChange={v => setMedicalHasAllergies(v as 'true' | 'false')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="false">No</SelectItem>
                      <SelectItem value="true">Sí</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Notas adicionales</Label>
                  <Textarea placeholder="Condiciones, medicamentos, restricciones físicas..." value={medicalNotes} onChange={e => setMedicalNotes(e.target.value)} rows={3} />
                </div>
              </div>
            )}
          </Section>

          <Separator />

          {/* ── Sección 2: Acudiente ── */}
          <Section icon={<Users className="h-4 w-4" />} title="Datos del Acudiente">
            <div className="space-y-3 rounded-lg border border-dashed p-4 bg-muted/20">
              <div>
                <Label>Nombre del Acudiente *</Label>
                <Input placeholder="María López" value={parentName} onChange={e => setParentName(e.target.value)} />
              </div>
              <div className={cn('grid grid-cols-1 gap-3', !parentEmailOptional && 'md:grid-cols-2')}>
                {!parentEmailOptional && (
                  <div>
                    <Label>Correo Electrónico *</Label>
                    <div className="relative">
                      <Input
                        type="email"
                        placeholder="madre@email.com"
                        value={parentEmail}
                        onChange={e => handleParentEmailChange(e.target.value)}
                        onBlur={handleParentEmailBlur}
                        className="pr-10"
                      />
                      {checkingParentEmail && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                    </div>
                    {parentEmailExists === true && (
                      <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center gap-1 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5 inline shrink-0" />
                        Acudiente ya registrado. Se vinculará el menor a su cuenta existente.
                      </p>
                    )}
                    {parentEmailExists === false && parentEmail.trim() && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1 font-medium">
                        <Info className="h-3.5 w-3.5 inline shrink-0" />
                        El acudiente no está registrado. Se le enviará invitación.
                      </p>
                    )}
                  </div>
                )}
                <div>
                  <Label>Teléfono *</Label>
                  <PhoneInput value={parentPhone} onChange={setParentPhone} />
                </div>
              </div>

              {parentEmailOptional && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Info className="h-3.5 w-3.5 inline shrink-0" />
                  Esta escuela no requiere el correo del acudiente. Sin ese dato, el acudiente no recibirá invitación para crear su cuenta.
                </p>
              )}

              {/* Canales de Invitación */}
              {!parentEmailOptional && parentEmailExists === false && parentEmail.trim() && (
                <div className="space-y-2 rounded-lg border border-amber-100 bg-amber-50/50 p-3 mt-4">
                  <p className="text-xs font-semibold text-amber-900 dark:text-amber-100 mb-1">
                    Canales de Invitación:
                  </p>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        id="sendInviteEmailChild"
                        checked={sendInviteEmail}
                        onChange={e => setSendInviteEmail(e.target.checked)}
                        className="rounded border-input text-primary focus:ring-primary h-4 w-4"
                      />
                      <label htmlFor="sendInviteEmailChild" className="text-muted-foreground text-xs cursor-pointer">
                        Enviar invitación por Correo Electrónico a <strong>{parentEmail}</strong>
                      </label>
                    </div>
                    {parentPhone && parentPhone !== '+57' && (
                      <div className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          id="sendInviteWhatsappChild"
                          checked={sendInviteWhatsapp}
                          onChange={e => setSendInviteWhatsapp(e.target.checked)}
                          className="rounded border-input text-primary focus:ring-primary h-4 w-4"
                        />
                        <label htmlFor="sendInviteWhatsappChild" className="text-muted-foreground text-xs cursor-pointer">
                          Generar link para invitar al acudiente por WhatsApp al finalizar
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Separator />

          {/* ── Sección 3: Inscripción ── */}
          <Section icon={<ClipboardList className="h-4 w-4" />} title="Inscripción">
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Equipo</Label>
                <p className="text-[11px] text-muted-foreground mb-1">Opcional — independiente del plan</p>
                <Select value={teamId} onValueChange={setTeamId}>
                  <SelectTrigger><SelectValue placeholder="Sin equipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Sin equipo</SelectItem>
                    {teams.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                        {t.sport ? <span className="ml-1 text-xs text-muted-foreground">— {t.sport}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Cuando la escuela no cobra por SportMaps, Plan y Mensualidad
                  no aplican: un plan es un producto FACTURABLE. El estado de la
                  membresia se registra aparte, en «Membresias». */}
              {hasBilling && (
              <div>
                <Label>Plan</Label>
                <p className="text-[11px] text-muted-foreground mb-1">Opcional — independiente del equipo</p>
                <PlanCombobox
                  plans={plans.map(p => ({ id: p.plan_id, name: p.plan_name, offering_name: p.offering_name, price: p.price }))}
                  value={selectedPlanId}
                  onChange={handlePlanSelect}
                  noneValue="none"
                  showPrice
                />
              </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex flex-col">
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
              {hasBilling ? (
              <div>
                <Label>Mensualidad (COP) *</Label>
                <Input type="number" placeholder="150000" value={monthlyFee} onChange={e => setMonthlyFee(e.target.value)} min={10000} step={1000} />
                <p className="text-[11px] text-muted-foreground mt-1">
                  {selectedPlanId !== 'none' ? 'Cargado desde el plan' : teamId !== 'none' ? 'Cargado desde el equipo' : 'Ingresa manualmente'}
                </p>
              </div>
              ) : (
              <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                Esta escuela no cobra mensualidades por SportMaps, asi que no se pide monto.
                El estado de la membresia se registra en <b>Membresias</b>, y ahi aparece este
                atleta en cuanto quede creado.
              </div>
              )}
            </div>

            {hasBilling && siblingsAllowed && (
              <div className="space-y-2 rounded-lg border border-border p-3" data-testid="alta-sibling-section">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="alta-has-sibling"
                    checked={hasSibling}
                    onChange={e => { setHasSibling(e.target.checked); if (!e.target.checked) setSiblingOfChildId(null); }}
                    className="h-4 w-4 rounded border-input"
                    data-testid="alta-has-sibling"
                  />
                  <label htmlFor="alta-has-sibling" className="text-sm font-medium cursor-pointer">
                    ¿Tiene un hermano inscrito?
                  </label>
                </div>
                {hasSibling && (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Elige al hermano que ya está en la escuela. Así quedan en la misma familia aunque el acudiente aún no tenga cuenta.
                    </p>
                    <SiblingChildPicker
                      schoolId={schoolId}
                      value={siblingOfChildId}
                      onChange={setSiblingOfChildId}
                      enabled={open && hasSibling}
                      testIdPrefix="alta-sibling-picker"
                    />
                  </>
                )}
                {siblingPreviewLoading && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Calculando descuento por hermanos…
                  </p>
                )}
                {!siblingPreviewLoading && siblingPreview && <SiblingDiscountChip sibling={siblingPreview} />}
                {!siblingPreviewLoading && hasSibling && siblingOfChildId && !siblingPreview && selectedPlanId !== 'none' && (
                  <p className="text-xs text-muted-foreground" data-testid="alta-sibling-no-discount">
                    Con este hermano no aplica descuento (la escuela no lo tiene activo o este sería el 1.º hijo).
                  </p>
                )}
                {hasSibling && selectedPlanId === 'none' && (
                  <p className="text-xs text-muted-foreground">Elige un plan para ver el descuento.</p>
                )}
              </div>
            )}
            {hasBilling && <AltaFirstChargeCard
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
              hideCycleDetail={showFirstPaymentMode && firstPayment.mode === 'remaining_classes'}
            />}
            {hasBilling && showFirstPaymentMode && (
              <FirstPaymentModeSection
                schoolId={schoolId}
                planId={selectedPlanId}
                startDate={startDate}
                monthlyFee={Number(monthlyFee) || 0}
                discountPct={discountPct}
                value={firstPayment}
                onChange={setFirstPayment}
                waivers={feeWaivers}
                siblingOfChildId={siblingsAllowed && hasSibling ? siblingOfChildId : null}
              />
            )}
          </Section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || checkingParentEmail}>
            {submitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Guardando...</>
            ) : (
              <><Baby className="h-4 w-4 mr-2" />Registrar Menor</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
