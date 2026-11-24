import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Loader2, Banknote, Building2, Wallet, Landmark, Calendar as CalendarIcon, User, FileText, CheckCircle2, Paperclip, AlertTriangle, Receipt } from 'lucide-react';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { useEntitlements } from '@/hooks/useEntitlements';
import { BillingDetailsForm } from '@/components/billing/BillingDetailsForm';
import { NumberStepper } from '@/components/ui/number-stepper';
import { useToast } from '@/hooks/use-toast';
import { emailClient } from '@/lib/email-client';
import { formatCurrency, cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { FileUpload } from '@/components/common/FileUpload';
import type { ReceiptValidationResult } from '@/hooks/useReceiptValidator';
import { buildReceiptOcrFields, isDuplicateReceiptError } from '@/lib/receiptOcrFields';
import {
  type PaymentPeriod,
  formatPeriodLabel,
  currentPeriodBogota,
  periodOptions,
  periodKey,
  parsePeriodKey,
  isDuplicatePeriodError,
} from '@/lib/paymentPeriod';
import { chargeCategoryOf, type PaymentChargeCategory } from '@/lib/payment-accounts';
import { todayColombia } from '@/lib/dateUtils';
import { SiblingFamilySection, parseSiblingFamily } from '@/components/students/siblings';
import { repartirExcedente, excedenteDeGrupo, recibidoMenorQueSuma, recibidoPorDefecto, avisoReparto, MENSAJE_RECIBIDO_MENOR } from '@/lib/payments/pagoFamilia';
import { errorDeRecibido, notasConRecibido, lineaRecibido, type RecibidoSinComprobante } from '@/lib/payments/constanciaDeRecibido';
import { RecibidoSinComprobanteCampos } from '@/components/payment/RecibidoSinComprobanteCampos';
import {
  MANUAL_CHARGE_CATEGORY_OPTIONS,
  effectiveManualCategory,
  manualChargeInsertFields,
  manualChargeIsPeriodic,
  canReuseOnPeriodConflict,
} from '@/lib/manualPaymentCharge';

interface RegisterCashPaymentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  /**
   * Deportista con el que abre el modal (id de la vista school_athletes). Lo
   * usa «Estado de cuenta» en el listado de deportistas: la escuela ya eligió
   * a quién, no tiene que buscarlo otra vez.
   */
  initialAthleteId?: string;
}

/**
 * Qué tan listos están los datos fiscales del pagador.
 *
 * Antes era un booleano y `billing_city_dane` se daba por bueno por ser
 * truthy: 'Bogotá' es truthy, así que un perfil con el municipio en texto
 * libre contaba como completo y el código DANE NUNCA se llegaba a pedir. Por
 * eso 0 de 147 pagos de septiembre lo tienen, y las 147 facturas saldrían
 * diciendo el municipio de la escuela.
 *
 * Se parte en tres y no en dos porque el municipio NO bloquea la emisión (el
 * adaptador cae al municipio de la escuela): tratarlo como "faltan datos"
 * pintaría el mismo aviso que un perfil vacío y el registro de pagos en fila
 * se volvería un campo de alertas rojas idénticas. `no_dane` dice exactamente
 * lo que pasa y ofrece corregirlo, sin frenar nada.
 */
type PayerDianState =
  /** Documento, dirección y municipio como código DANE. Nada que hacer. */
  | 'complete'
  /** Emitible, pero el municipio no es código DANE → la factura sale con la ciudad de la escuela. */
  | 'no_dane'
  /** Falta documento y/o dirección → el motor corta con customer_missing_fiscal_data. */
  | 'incomplete';

/** El código DANE del municipio: 4 o 5 dígitos. Texto libre no sirve para facturar. */
const DANE_CODE = /^\d{4,5}$/;

/** Estados de un cobro al que todavía se le puede registrar plata. */
const OPEN_STATUSES = ['pending', 'overdue', 'partial'];

/**
 * Lo que importa del cobro para cobrarlo bien. Mora (2026-10-14): la mora nunca
 * cancela; apply_late_fees() suma el recargo DENTRO de `amount` por la noche
 * (y deja el detalle en late_fee_amount). Por eso el monto se vuelve a leer
 * justo antes de guardar: el formulario pudo quedar abierto de un día al otro.
 */
interface ChargeSnapshot {
  amount: number;
  amountPaid: number;
  lateFee: number;
  earlyDiscount: number;
  status: string;
}

const PAYMENT_SNAPSHOT_COLUMNS = 'id, amount, amount_paid, late_fee_amount, early_payment_discount_applied, status, notes';

function snapshotOf(p: any): ChargeSnapshot {
  return {
    amount: Number(p?.amount) || 0,
    amountPaid: Number(p?.amount_paid) || 0,
    lateFee: Number(p?.late_fee_amount) || 0,
    earlyDiscount: Number(p?.early_payment_discount_applied) || 0,
    status: String(p?.status ?? ''),
  };
}

/** saldo = amount − amount_paid − early_payment_discount_applied (lib/cobrosYPagos §6.5). */
function balanceOf(s: ChargeSnapshot): number {
  return Math.max(s.amount - s.amountPaid - s.earlyDiscount, 0);
}

function snapshotChanged(a: ChargeSnapshot, b: ChargeSnapshot): boolean {
  return a.amount !== b.amount || a.amountPaid !== b.amountPaid || a.lateFee !== b.lateFee || a.status !== b.status;
}

/**
 * Campos de dinero/estado para registrar `received` sobre un cobro existente.
 *
 * NUNCA baja `amount`: bajarlo dispara el rebase de la base, que encoge
 * list_amount y deja late_fee_amount igual — el recargo se pierde y el libro
 * queda torcido. Una plata menor al saldo es un ABONO (status 'partial' +
 * amount_paid acumulado, igual que lib/approvePayment). Si hay que perdonar la
 * mora, eso es la condonación explícita de «Cobros y pagos», no pisar el monto.
 *
 * Una plata MAYOR al saldo (p. ej. se quitó un descuento) sí sube `amount`,
 * con la confirmación que ya pedía el modal.
 */
function applyFieldsFor(s: ChargeSnapshot, received: number) {
  const balance = balanceOf(s);
  const totalPaid = s.amountPaid + received;
  if (received < balance) {
    return { fields: { status: 'partial', amount_paid: totalPaid }, isAbono: true, saldo: balance - received };
  }
  return {
    fields: {
      status: 'paid',
      amount_paid: totalPaid,
      ...(received > balance ? { amount: s.amount + (received - balance) } : {}),
    },
    isAbono: false,
    saldo: 0,
  };
}

export function RegisterCashPaymentModal({ open, onOpenChange, onSuccess, initialAthleteId }: RegisterCashPaymentModalProps) {
  const { user } = useAuth();
  const { schoolId, schoolName } = useSchoolContext();
  const { toast } = useToast();
  const { hasAddon } = useEntitlements();
  
  const [loading, setLoading] = useState(false);
  const [athletes, setAthletes] = useState<any[]>([]);
  const [loadingAthletes, setLoadingAthletes] = useState(false);
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);

  // Form state
  const [selectedAthleteId, setSelectedAthleteId] = useState<string>('');
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>('new');
  // Pagar varios cobros pendientes del mismo deportista en una sola operación.
  const [multiMode, setMultiMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Hermanas vinculadas con cobros abiertos: un comprobante puede cubrir a varias
  // (spec docs/specs/pago-hermanas-un-comprobante.md).
  const [hermanas, setHermanas] = useState<{ child_id: string; full_name: string }[]>([]);
  const [hermanasPending, setHermanasPending] = useState<any[]>([]);
  const [hermanasKey, setHermanasKey] = useState(0);
  const [showVincular, setShowVincular] = useState(false);
  const [recibidoManual, setRecibidoManual] = useState<number | ''>('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'transfer'>('cash');
  const [concept, setConcept] = useState('Mensualidad');
  // Tipo de cobro del cobro NUEVO. null = se deduce del concepto (ver
  // lib/manualPaymentCharge). Al aplicar a un pendiente no se usa: ese cobro
  // ya trae su payment_category y la base no deja cambiarla.
  const [chosenCategory, setChosenCategory] = useState<PaymentChargeCategory | null>(null);
  const [amount, setAmount] = useState<number | ''>(0);
  const [paymentDate, setPaymentDate] = useState<Date>(new Date());

  /**
   * El día que la escuela eligió en el calendario, tal cual.
   *
   * Antes se guardaba con `paymentDate.toISOString().split('T')[0]`, y
   * `toISOString()` pasa la fecha LOCAL a UTC: registrar un pago pasadas las
   * 7 p.m. hora
   * Colombia guardaba el día SIGUIENTE — el calendario mostraba "4 de agosto"
   * (se pinta con `format`, local) y en la base quedaba `2026-08-05`. 28 pagos
   * desde julio quedaron así, 13 con fecha de pago en el futuro, y en Finanzas
   * se iban al tope del listado como si fueran los más recientes.
   */
  const pickedDay = () => format(paymentDate, 'yyyy-MM-dd');

  // Soporte de la transferencia (comprobante que la familia envio por WhatsApp).
  // Solo aplica a paymentMethod === 'transfer'; opcional, porque la escuela
  // tambien concilia contra el extracto bancario sin tener la imagen.
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  // Quién del equipo recibió la plata. Obligatorio cuando no hay comprobante
  // (efectivo, o transferencia sin soporte): ver lib/payments/constanciaDeRecibido.
  const [receivedBy, setReceivedBy] = useState('');
  const [showReceivedError, setShowReceivedError] = useState(false);
  const [ocrResult, setOcrResult] = useState<ReceiptValidationResult | null>(null);
  // Key para remontar el FileUpload y limpiar su estado interno al quitar el soporte.
  const [uploadKey, setUploadKey] = useState(0);

  // Periodo (mes cubierto) del cobro. Solo aplica a mensualidades y a cobros
  // NUEVOS: cuando se aplica a un pendiente, ese cobro ya trae el suyo y
  // pisarlo colisiona con los indices unicos de periodo.
  const [period, setPeriod] = useState<PaymentPeriod | null>(null);
  const [periodSuggested, setPeriodSuggested] = useState<PaymentPeriod | null>(null);
  const [loadingPeriod, setLoadingPeriod] = useState(false);

  // Athlete search state
  const [athletePopoverOpen, setAthletePopoverOpen] = useState(false);
  const [athleteSearchQuery, setAthleteSearchQuery] = useState('');

  // Facturación electrónica del pagador (opcional, solo si el addon está
  // activo): el registro manual no pasa por el checkout del padre, así que
  // ese formulario nunca se le muestra — sin esto, el pago quedaba `paid`
  // pero la factura se saltaba en silencio (customer_missing_fiscal_data).
  const [wantsEInvoice, setWantsEInvoice] = useState(false);
  const [payerDianState, setPayerDianState] = useState<PayerDianState | null>(null); // null = aún sin consultar
  const [checkingDian, setCheckingDian] = useState(false);

  const filteredAthletes = athletes.filter(ath => {
    const term = athleteSearchQuery.toLowerCase();
    const fullName = (ath.full_name || '').toLowerCase();
    const parentName = (ath.parent_name || '').toLowerCase();
    return fullName.includes(term) || parentName.includes(term);
  });

  // Quién factura: el padre (menor) o el atleta mismo (adulto paga por sí
  // solo). 'unregistered' no tiene perfil → null, no aplica facturación.
  const selectedAthleteForPayer = athletes.find(a => a.id === selectedAthleteId);
  const payerProfileId = selectedAthleteForPayer
    ? (selectedAthleteForPayer.athlete_type === 'adult'
        ? selectedAthleteForPayer.id
        : selectedAthleteForPayer.parent_id || null)
    : null;

  // Nombre del DUEÑO del perfil que se va a tocar, no del deportista. El
  // formulario fiscal tiene que decirlo: registrando pagos en fila, es lo
  // unico que permite notar que la cedula se esta guardando en el perfil
  // equivocado. Sale de la misma vista school_athletes (`full_name` para el
  // adulto, `parent_name` para el acudiente), asi que no cuesta una consulta.
  const payerName: string | null = selectedAthleteForPayer
    ? (selectedAthleteForPayer.athlete_type === 'adult'
        ? selectedAthleteForPayer.full_name || null
        : selectedAthleteForPayer.parent_name || null)
    : null;

  useEffect(() => {
    if (!payerProfileId || !hasAddon('invoicing')) {
      setPayerDianState(null);
      setWantsEInvoice(false);
      return;
    }
    let cancelled = false;
    setCheckingDian(true);
    (async () => {
      const { data } = await supabase.from('profiles')
        .select('document_type, document_number, billing_address, billing_city_dane')
        .eq('id', payerProfileId).single();
      if (cancelled) return;
      // El bloqueo duro es documento + dirección: es lo que hace que
      // loadCustomer devuelva null y el motor corte. `document_type` no se
      // exige porque loadCustomer lo asume 'CC' cuando falta.
      const emitible = !!(data?.document_number && data?.billing_address);
      const conDane = DANE_CODE.test(String(data?.billing_city_dane ?? '').trim());
      setPayerDianState(!emitible ? 'incomplete' : conDane ? 'complete' : 'no_dane');
      setCheckingDian(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payerProfileId]);

  useEffect(() => {
    if (open && schoolId) {
      fetchAthletes();
    }
  }, [open, schoolId]);

  // Hermanas vinculadas (get_sibling_family) y sus cobros abiertos, en UNA lectura
  // con .in(). Solo para menores: el saldo a favor de la RPC familiar es por child_id.
  useEffect(() => {
    setHermanas([]);
    setHermanasPending([]);
    const student = athletes.find(a => a.id === selectedAthleteId);
    if (!selectedAthleteId || !schoolId || !student || student.athlete_type !== 'child') return;
    let cancelled = false;
    (async () => {
      const { data, error } = await (supabase as any).rpc('get_sibling_family', { p_school_id: schoolId, p_child_id: selectedAthleteId });
      if (cancelled || error) return;
      const otras = parseSiblingFamily(data)
        .filter(m => m.via !== 'self')
        .map(m => ({ child_id: m.child_id, full_name: m.full_name }));
      if (otras.length === 0) return;
      const { data: pend } = await (supabase.from('payments') as any)
        .select('id, child_id, concept, amount, amount_paid, late_fee_amount, due_date, status, discount_pct')
        .eq('school_id', schoolId)
        .in('child_id', otras.map(o => o.child_id))
        .in('status', ['pending', 'overdue'])
        .order('due_date', { ascending: true });
      if (cancelled) return;
      setHermanas(otras);
      setHermanasPending(pend || []);
    })();
    return () => { cancelled = true; };
  }, [selectedAthleteId, schoolId, athletes, hermanasKey]);

  useEffect(() => {
    if (selectedAthleteId) {
      fetchPendingPayments(selectedAthleteId);
    } else {
      setPendingPayments([]);
      setSelectedPaymentId('new');
    }
  }, [selectedAthleteId]);

  const fetchAthletes = async () => {
    setLoadingAthletes(true);
    try {
      const { data, error } = await supabase
        .from('school_athletes')
        .select('*')
        .eq('school_id', schoolId)
        .eq('is_active', true);

      if (error) throw error;
      setAthletes(data || []);
      // Se fija en el mismo render que la lista: fetchPendingPayments busca al
      // deportista en `athletes`, y si llegara antes no lo encontraría.
      if (initialAthleteId && (data || []).some((a: any) => a.id === initialAthleteId)) {
        setSelectedAthleteId(initialAthleteId);
      }
    } catch (err: any) {
      console.error(err);
      toast({ title: 'Error al cargar deportistas', description: err.message, variant: 'destructive' });
    } finally {
      setLoadingAthletes(false);
    }
  };

  const fetchPendingPayments = async (athleteId: string) => {
    const student = athletes.find(a => a.id === athleteId);
    if (!student || !schoolId) return;

    setLoadingPending(true);
    setSelectedPaymentId('new');
    setMultiMode(false);
    setSelectedIds([]);
    try {
      // Clasificar por athlete_type de la vista school_athletes (fuente de verdad),
      // NO por presencia de parent_id: un 'child' sin padre vinculado (parent_id
      // null) se tomaba como 'unregistered' y su children.id chocaba la FK
      // payments_unregistered_athlete_id_fkey.
      const userId         = student.athlete_type === 'adult' ? student.id : null;
      const childId        = student.athlete_type === 'child' ? student.id : null;
      const unregisteredId = student.athlete_type === 'unregistered' ? student.id : null;

      // `as any`: discount_pct / list_amount aún no están en los tipos generados de Supabase.
      let q = (supabase.from('payments') as any)
        .select('id, concept, amount, amount_paid, late_fee_amount, early_payment_discount_applied, due_date, status, requires_review, last_failure_at, last_failure_reason, payment_category, payment_type, discount_pct, list_amount')
        .eq('school_id', schoolId)
        // 'partial' también: un abono deja saldo y aquí es donde se completa.
        .in('status', OPEN_STATUSES)
        .order('due_date', { ascending: true });

      if (userId)              q = q.eq('user_id', userId);
      else if (childId)        q = q.eq('child_id', childId);
      else if (unregisteredId) q = q.eq('unregistered_athlete_id', unregisteredId);

      const { data, error } = await q;
      if (error) throw error;
      setPendingPayments(data || []);
      // Abierto desde «Editar estado de cuenta»: la escuela viene a poner al día
      // a ESE deportista, así que se elige el cobro más atrasado (orden por
      // due_date). Con «Nuevo cobro» por defecto era fácil crear un pago suelto
      // y dejar el vencido abierto.
      const oldest = (data || [])[0];
      if (oldest && athleteId === initialAthleteId) {
        setSelectedPaymentId(oldest.id);
        setConcept(oldest.concept);
        // El SALDO (con mora incluida), no el valor original del cobro.
        setAmount(balanceOf(snapshotOf(oldest)));
      }
    } catch (err: any) {
      console.error(err);
      setPendingPayments([]);
    } finally {
      setLoadingPending(false);
    }
  };

  // Categoría del cobro NUEVO: la elegida o la que se deduce del concepto.
  const newChargeCategory = effectiveManualCategory(chosenCategory, concept);

  // Un cobro nuevo de mensualidad debe llevar periodo; aplicado a un pendiente NO
  // (ese ya trae el suyo desde que se genero). Un cobro único (inscripción,
  // seguro, artículos…) tampoco: no es un mes de servicio.
  const periodApplies = !multiMode && selectedPaymentId === 'new' && !!selectedAthleteId && manualChargeIsPeriodic(newChargeCategory);

  useEffect(() => {
    if (!periodApplies) {
      setPeriod(null);
      setPeriodSuggested(null);
      return;
    }

    const student = athletes.find(a => a.id === selectedAthleteId);
    if (!student) return;

    let cancelled = false;
    (async () => {
      setLoadingPeriod(true);
      // next_unpaid_period solo resuelve menores (recibe p_child_id). Para
      // adultos y no registrados no hay RPC: se arranca en el mes actual y el
      // admin ajusta si esta poniendo al dia un mes atrasado.
      const childId = student.athlete_type === 'child' ? student.id : null;
      let resolved: PaymentPeriod = currentPeriodBogota();

      if (childId) {
        try {
          const { data, error } = await (supabase.rpc as any)('next_unpaid_period', { p_child_id: childId });
          if (!error && data?.year && data?.month) {
            resolved = { year: Number(data.year), month: Number(data.month) };
          }
        } catch {
          // Sin RPC nos quedamos con el mes actual: es mejor un periodo poblado
          // (entra al dedup) que dejarlo null.
        }
      }

      if (!cancelled) {
        setPeriodSuggested(resolved);
        setPeriod(resolved);
      }
      setLoadingPeriod(false);
    })();

    return () => { cancelled = true; };
  }, [periodApplies, selectedAthleteId, athletes]);

  const clearReceipt = () => {
    setReceiptUrl(null);
    setOcrResult(null);
    setUploadKey(k => k + 1);
  };

  // Razones del veredicto que ameritan avisar al admin (duplicado, destino que no
  // coincide, fecha fuera de ventana...). NO bloquean: el admin ya vio la plata.
  const verdictWarnings: string[] = (() => {
    if (!ocrResult?.verdict || ocrResult.verdict === 'verde') return [];
    const reasons = Array.isArray(ocrResult.verdictReasons) ? ocrResult.verdictReasons : [];
    return reasons
      .map(r => (r as { message?: string })?.message)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
  })();

  const selectedPending = selectedPaymentId !== 'new'
    ? pendingPayments.find(p => p.id === selectedPaymentId)
    : undefined;

  // Sin comprobante = efectivo, o transferencia sin soporte adjunto. Ahí la
  // escuela deja constancia de quién recibió la plata; cómo y cuándo ya los dicen
  // «Método de pago» y «Fecha del pago».
  const needsReceivedBy = paymentMethod === 'cash' || !receiptUrl;
  const receivedError = needsReceivedBy
    ? errorDeRecibido({ metodo: paymentMethod, fecha: pickedDay(), por: receivedBy }, todayColombia())
    : null;
  const constancia = (): RecibidoSinComprobante | null =>
    needsReceivedBy && !receivedError ? { metodo: paymentMethod, fecha: pickedDay(), por: receivedBy } : null;

  // Categoría que se le pasa al verificador del comprobante: con ella, una
  // llave restringida a esa categoría (p. ej. Nequi solo para inscripciones)
  // cuenta como destino válido en vez de salir amarilla.
  const receiptCategory: PaymentChargeCategory | null = selectedPending
    ? chargeCategoryOf(selectedPending.payment_category, selectedPending.concept)
    : newChargeCategory;

  /**
   * Cobro que la pasarela dejo marcado `requires_review` tras un rechazo.
   *
   * NO bloquea el registro manual. El lock existe para frenar al PADRE en
   * reintentos de checkout online; aplicarlo tambien al efectivo/transferencia
   * era al reves: ese es justamente el camino de salida cuando la tarjeta
   * rebota, y para entonces el admin ya tiene la plata en la mano. Nueve
   * cobros de Dynasty quedaron muertos asi — sin ninguna pantalla que los
   * destrabara — hasta el 19 ago 2026. Se avisa, y aprobar limpia la marca.
   */
  const reviewNotice: string | null = selectedPending?.requires_review
    ? `Un intento de pago con tarjeta fue rechazado${
        selectedPending.last_failure_at
          ? ` el ${format(new Date(selectedPending.last_failure_at), "d 'de' MMMM", { locale: es })}`
          : ''
      }. Al registrar el pago manualmente este cobro se destraba.`
    : null;

  // El descuento aplicado al registrar al estudiante viaja con el cobro
  // (payments.discount_pct / list_amount). El monto del cobro YA viene descontado:
  // aquí solo se muestra, y si el monto a registrar se aleja del del cobro se pide
  // confirmación explícita — antes un monto distinto se escribía en silencio.
  const pendingSnap = selectedPending ? snapshotOf(selectedPending) : null;
  const pendingAmount = pendingSnap ? pendingSnap.amount : null;
  // Lo que se cobra hoy: el saldo, con la mora ya sumada por apply_late_fees().
  const pendingBalance = pendingSnap ? balanceOf(pendingSnap) : null;
  const pendingLateFee = pendingSnap ? pendingSnap.lateFee : 0;
  // El cobro sin el recargo: sobre esto se lee el descuento (el recargo no se descuenta).
  const pendingBase = pendingAmount !== null ? pendingAmount - pendingLateFee : null;
  const pendingDiscountPct = selectedPending ? Number(selectedPending.discount_pct) || 0 : 0;
  const pendingListAmount = selectedPending
    ? (Number(selectedPending.list_amount)
        || (pendingDiscountPct > 0 && pendingBase ? Math.round(pendingBase / (1 - pendingDiscountPct / 100)) : 0))
    : 0;
  const pendingIsMensualidad = selectedPending
    ? chargeCategoryOf(selectedPending.payment_category, selectedPending.concept) === 'mensualidad'
    : false;
  const receivedAmount = typeof amount === 'number' ? amount : 0;
  // Menos que el saldo → se registra como abono (no se toca el valor del cobro).
  const isPartialReceipt = !multiMode && pendingBalance !== null && receivedAmount > 0 && receivedAmount < pendingBalance;
  // Más que el saldo → sube el valor del cobro; se confirma explícitamente.
  const isOverReceipt = !multiMode && pendingBalance !== null && receivedAmount > pendingBalance;
  const amountDiffersFromCharge = isPartialReceipt || isOverReceipt;

  // Varios cobros: cada uno se paga por su propio valor (ya con descuento y mora);
  // el total es la suma. No hay monto ni concepto editables. Los abonados
  // ('partial') quedan fuera: register_manual_payments salda el valor completo
  // de cada cobro y a esos solo les falta el saldo — se pagan de a uno.
  const multiCandidates = pendingPayments.filter(p => p.status !== 'partial');
  // Cobros de hermanas vinculadas: se pueden marcar junto a los de la deportista.
  const todosCandidatos = [...multiCandidates, ...hermanasPending];
  const selectedMulti = todosCandidatos.filter(p => selectedIds.includes(p.id));
  const multiTotal = selectedMulti.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const multiLateFee = selectedMulti.reduce((s, p) => s + (Number(p.late_fee_amount) || 0), 0);
  const toggleSelected = (id: string) =>
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const allSelected = multiCandidates.length > 0 && selectedIds.length === multiCandidates.length;
  const [confirmAmountChange, setConfirmAmountChange] = useState(false);

  // ── Hermanas y monto recibido (solo menores) ──────────────────────────────
  const esMenor = selectedAthleteForPayer?.athlete_type === 'child';
  const ownSelected = selectedMulti.some(p => !p.child_id);
  const hermanasSelected = selectedMulti.filter(p => !!p.child_id);
  const usaFamilia = hermanasSelected.length > 0;
  const grupoChildIds: string[] = Array.from(new Set([
    ...(ownSelected && selectedAthleteId ? [selectedAthleteId] : []),
    ...hermanasSelected.map(p => p.child_id as string),
  ]));
  const anclaChild: string = ownSelected && selectedAthleteId ? selectedAthleteId : (grupoChildIds[0] ?? '');
  const ocrMonto = paymentMethod === 'transfer' && receiptUrl ? (ocrResult?.extractedAmount ?? null) : null;
  const recibidoSugerido = recibidoPorDefecto(multiTotal, ocrMonto);
  const recibido = recibidoManual === '' ? recibidoSugerido : Number(recibidoManual);
  const excedenteGrupo = esMenor && selectedMulti.length > 0 ? excedenteDeGrupo(recibido, multiTotal) : 0;
  const recibidoMenor = esMenor && selectedMulti.length > 0 && recibidoMenorQueSuma(recibido, multiTotal);
  const partesSaldo = repartirExcedente(excedenteGrupo, grupoChildIds, anclaChild);
  const nombresGrupo: Record<string, string> = {
    ...(selectedAthleteId ? { [selectedAthleteId]: selectedAthleteForPayer?.full_name || 'la deportista' } : {}),
    ...Object.fromEntries(hermanas.map(h => [h.child_id, h.full_name])),
  };
  const avisoSaldo = avisoReparto(partesSaldo, nombresGrupo, excedenteGrupo);
  // Si cambia la selección o el total, el monto recibido vuelve a su sugerencia.
  useEffect(() => { setRecibidoManual(''); }, [multiTotal, paymentMethod, receiptUrl]);
  useEffect(() => { setConfirmAmountChange(false); }, [selectedPaymentId, amount]);
  // El cobro cambió en la base entre que se abrió el formulario y el clic
  // (típico: la mora de la noche). Se avisa y se pide confirmar de nuevo.
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  useEffect(() => { setStaleNotice(null); }, [selectedPaymentId, selectedAthleteId]);

  const handlePendingSelect = (value: string) => {
    setSelectedPaymentId(value);
    if (value === 'new') return;
    const pmt = pendingPayments.find(p => p.id === value);
    if (pmt) {
      setConcept(pmt.concept);
      setAmount(balanceOf(snapshotOf(pmt)));
    }
  };

  /**
   * El cobro ya no es el que la escuela vio: se refresca en pantalla con lo que
   * dice la base, se propone el saldo nuevo y NO se guarda — el siguiente clic
   * es la confirmación con el monto actualizado.
   */
  const showStaleCharge = (fresh: any, before: ChargeSnapshot) => {
    const now = snapshotOf(fresh);
    setPendingPayments(prev => prev.map(p => (p.id === fresh.id ? { ...p, ...fresh } : p)));
    setAmount(balanceOf(now));
    const feeAdded = now.lateFee - before.lateFee;
    setStaleNotice(
      `Este cobro cambió mientras el formulario estaba abierto${
        feeAdded > 0 ? `: se sumó un recargo por mora de ${formatCurrency(feeAdded)}` : ''
      }. El saldo ahora es ${formatCurrency(balanceOf(now))}. Revisa el monto y vuelve a confirmar.`,
    );
  };

  /**
   * Varios cobros del mismo deportista en UNA operación atómica (RPC
   * register_manual_payments): se paga el valor de cada cobro (con descuento y
   * mora) y, si algo falla, no queda ninguno a medias. La RPC exige owner/admin de
   * la escuela, que la escuela esté operativa y que los cobros sean pendientes o
   * atrasados de un mismo deportista.
   */
  const handleSaveMulti = async () => {
    const selectedStudent = athletes.find(a => a.id === selectedAthleteId);
    if (!selectedStudent || !schoolId || !user) return;
    if (selectedMulti.length === 0) {
      toast({ title: 'Selecciona cobros', description: 'Marca al menos un cobro para registrar su pago.', variant: 'destructive' });
      return;
    }

    if (receivedError) {
      setShowReceivedError(true);
      toast({ title: 'Falta la constancia del pago', description: receivedError, variant: 'destructive' });
      return;
    }
    if (recibidoMenor) {
      toast({ title: 'Monto recibido menor', description: MENSAJE_RECIBIDO_MENOR, variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const prefix = paymentMethod === 'cash' ? 'CASH' : 'TRF';
      const reference = `${prefix}-${Date.now().toString(36).toUpperCase()}`;
      const isTransfer = paymentMethod === 'transfer';
      // RPC familiar: hermanas marcadas o excedente que queda como saldo a favor.
      const usarFamilia = esMenor && (usaFamilia || excedenteGrupo > 0);

      const { data, error } = await (supabase as any).rpc(usarFamilia ? 'register_manual_payments_familia' : 'register_manual_payments', {
        p_school_id: schoolId,
        p_payment_ids: selectedMulti.map(p => p.id),
        p_method: paymentMethod,
        p_payment_date: pickedDay(),
        p_reference_base: reference,
        p_receipt_url: isTransfer ? receiptUrl : null,
        p_receipt_fields: isTransfer && receiptUrl ? buildReceiptOcrFields(ocrResult) : null,
        ...(usarFamilia ? { p_monto_recibido: recibido, p_ancla_child: anclaChild } : {}),
      });
      if (error) throw error;

      // register_manual_payments no recibe notas: la constancia se anota aquí, en
      // UNA lectura de las notas y un UPDATE por cobro (máx. 50, acción manual).
      // Si falla, el pago YA quedó registrado: se avisa para anotarlo a mano.
      const c = constancia();
      let constanciaFallo = false;
      if (c) {
        try {
          const ids = selectedMulti.map(p => p.id);
          const { data: previas, error: lecErr } = await (supabase.from('payments') as any)
            .select('id, notes').in('id', ids).eq('school_id', schoolId);
          if (lecErr) throw lecErr;
          const porId = new Map<string, string | null>((previas || []).map((r: any) => [r.id, r.notes]));
          const res = await Promise.all(ids.map(id =>
            (supabase.from('payments') as any)
              .update({ notes: notasConRecibido(porId.get(id), c) })
              .eq('id', id).eq('school_id', schoolId)));
          constanciaFallo = res.some((r: any) => r.error);
        } catch {
          constanciaFallo = true;
        }
      }

      const total = Number(data?.total) || multiTotal;
      const resumen = selectedMulti.length <= 3
        ? selectedMulti.map(p => p.concept).join(' · ')
        : `${selectedMulti.slice(0, 3).map(p => p.concept).join(' · ')} y ${selectedMulti.length - 3} más`;

      const recipientId = selectedStudent.parent_id || (selectedStudent.athlete_type === 'adult' ? selectedStudent.id : null);
      if (recipientId) {
        await supabase.rpc('notify_user', {
          p_user_id: recipientId,
          p_title: isTransfer ? '✅ Transferencia registrada' : '✅ Pago en efectivo registrado',
          p_message: `${schoolName || 'La escuela'} registró tu pago de ${formatCurrency(total)} (${selectedMulti.length} cobros): ${resumen}.`,
          p_type: 'success',
          p_link: '/my-payments',
        });
      }
      if (selectedStudent.parent_email) {
        emailClient.send({
          type: 'payment_confirmation',
          to: selectedStudent.parent_email,
          data: {
            userName: selectedStudent.parent_name || 'Padre de familia',
            schoolName: schoolName || 'La escuela',
            amount: formatCurrency(total),
            concept: resumen,
            reference,
          },
        }).catch(() => {}); // Fire and forget
      }

      toast({
        title: 'Pagos registrados',
        description: `${selectedMulti.length} cobro(s) por ${formatCurrency(total)} quedaron como pagados.${
          Number(data?.excedente) > 0 ? ` ${avisoSaldo ?? `Saldo a favor: ${formatCurrency(Number(data.excedente))}.`}` : ''}${
          constanciaFallo ? ' No se pudo guardar quién recibió el pago: anótalo en las notas de cada cobro.' : ''
        }`,
        variant: constanciaFallo ? 'destructive' : undefined,
      });
      onSuccess();
      onOpenChange(false);
      resetForm();
    } catch (err: any) {
      console.error(err);
      if (isDuplicateReceiptError(err)) {
        toast({
          title: 'Comprobante ya registrado',
          description: 'Este soporte ya está vinculado a otro pago de la escuela. Revísalo en Validación de Cobros antes de volver a registrarlo.',
          variant: 'destructive',
        });
      } else {
        const msg: string = err?.message || 'Ocurrió un error inesperado';
        toast({
          title: 'No se registraron los pagos',
          // Los errores de la RPC vienen como «codigo: explicación».
          description: msg.includes(':') ? msg.split(':').slice(1).join(':').trim() : msg,
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    const numericAmount = typeof amount === 'number' ? amount : 0;
    if (!selectedAthleteId || !concept || numericAmount <= 0) {
      toast({ title: 'Datos incompletos', description: 'Por favor completa todos los campos requeridos.', variant: 'destructive' });
      return;
    }

    const selectedStudent = athletes.find(a => a.id === selectedAthleteId);
    if (!selectedStudent || !schoolId || !user) return;

    if (receivedError) {
      setShowReceivedError(true);
      toast({ title: 'Falta la constancia del pago', description: receivedError, variant: 'destructive' });
      return;
    }
    const c = constancia();

    setLoading(true);
    setStaleNotice(null);
    try {
      const prefix = paymentMethod === 'cash' ? 'CASH' : 'TRF';
      const reference = `${prefix}-${Date.now().toString(36).toUpperCase()}`;

      // Comprobante: solo se adjunta en transferencia. Los campos ocr_*/receipt_*
      // alimentan los indices de dedup (uq_payments_school_ocr_reference y
      // uq_payments_school_receipt_hash), asi que registrar dos veces el mismo
      // soporte de WhatsApp revienta con 23505 en vez de duplicar el ingreso.
      const receiptFields = paymentMethod === 'transfer' && receiptUrl
        ? { receipt_url: receiptUrl, ...buildReceiptOcrFields(ocrResult) }
        : {};

      // Registrar el pago a mano CIERRA la revision de la pasarela: el rechazo
      // fue de la tarjeta y aca hay plata que el admin ya confirmo. Se conserva
      // last_failure_at / last_failure_reason como rastro de auditoria.
      const unblockFields = {
        requires_review: false,
        unblocked_at: new Date().toISOString(),
        unblocked_by: user.id,
      };

      // Resolve correct IDs from the school_athletes view.
      // Payments are created with exactly ONE of these three fields:
      //   Flujo A (menores)      → child_id   (user_id null, parent_id null in view)
      //   Flujo B (adultos)      → user_id    (user_id set in view)
      //   Flujo C (sin cuenta)   → unregistered_athlete_id (user_id null, parent_id null)
      // Clasificar por athlete_type (fuente de verdad de la vista), NO por
      // parent_id: un 'child' sin padre vinculado caía a 'unregistered' y su
      // children.id violaba payments_unregistered_athlete_id_fkey.
      const userId           = selectedStudent.athlete_type === 'adult' ? selectedStudent.id : null;
      const childId          = selectedStudent.athlete_type === 'child' ? selectedStudent.id : null;
      const unregisteredId   = selectedStudent.athlete_type === 'unregistered' ? selectedStudent.id : null;

      // Abono (menos que el saldo): cambia el aviso a la familia y el toast.
      let abonoInfo: { saldo: number } | null = null;

      // Apply only to the selected pending payment, or create a new one.
      if (selectedPaymentId !== 'new') {
        const loaded = snapshotOf(selectedPending);
        // Releer el cobro JUSTO antes de escribir: la mora de la noche (o un
        // abono desde otra pestaña) pudo cambiar el monto desde que se abrió.
        const { data: fresh, error: freshError } = await (supabase.from('payments') as any)
          .select(PAYMENT_SNAPSHOT_COLUMNS)
          .eq('id', selectedPaymentId)
          .maybeSingle();
        if (freshError) throw freshError;
        if (!fresh || !OPEN_STATUSES.includes(fresh.status)) {
          toast({
            title: 'Este cobro ya no está abierto',
            description: 'Pudo registrarse o anularse mientras tanto. Se actualizó la lista de cobros.',
            variant: 'destructive',
          });
          await fetchPendingPayments(selectedAthleteId);
          return;
        }
        if (snapshotChanged(loaded, snapshotOf(fresh))) {
          showStaleCharge(fresh, loaded);
          return;
        }

        const current = snapshotOf(fresh);
        const { fields: moneyFields, isAbono, saldo } = applyFieldsFor(current, numericAmount);
        const { data: updatedRows, error: updateError } = await supabase
          .from('payments')
          .update({
            ...moneyFields,
            concept,
            payment_method: paymentMethod === 'cash' ? 'cash' : 'transfer',
            payment_channel: paymentMethod === 'cash' ? 'cash' : 'transfer',
            payment_date: pickedDay(),
            approved_by: user.id,
            approved_at: new Date().toISOString(),
            reference,
            ...(c ? { notes: notasConRecibido(fresh.notes, c) } : {}),
            ...unblockFields,
            ...receiptFields,
          } as any)
          .eq('id', selectedPaymentId)
          // Candado optimista: si entre la relectura y este UPDATE cambió el
          // monto o se cerró el cobro, no se escribe nada.
          .in('status', OPEN_STATUSES)
          .eq('amount', current.amount)
          .select('id');

        if (updateError) throw updateError;
        if (!updatedRows || updatedRows.length === 0) {
          // ¿Cambió justo ahora, o el rol no puede escribir? Se distingue releyendo.
          const { data: again } = await (supabase.from('payments') as any)
            .select(PAYMENT_SNAPSHOT_COLUMNS)
            .eq('id', selectedPaymentId)
            .maybeSingle();
          if (again && (!OPEN_STATUSES.includes(again.status) || snapshotChanged(current, snapshotOf(again)))) {
            if (OPEN_STATUSES.includes(again.status)) {
              showStaleCharge(again, current);
            } else {
              toast({ title: 'Este cobro ya no está abierto', description: 'Se registró o anuló mientras tanto.', variant: 'destructive' });
              await fetchPendingPayments(selectedAthleteId);
            }
            return;
          }
          // La policy «Payments: update admin» solo deja actualizar a owner/admin: con
          // otro rol el UPDATE afecta 0 filas SIN error y esto reportaba «Cobro
          // registrado» sin haber registrado nada.
          throw new Error('No se registró el pago: tu rol no puede modificar cobros de esta escuela. Pídele a un owner o administrador que lo registre.');
        }
        if (isAbono) abonoInfo = { saldo };
      } else {
        // No pending payment found — create a new one
        const chargeFields = manualChargeInsertFields(newChargeCategory, selectedStudent.offering_plan_id || null);
        const { error: insertError } = await supabase.from('payments').insert({
          school_id: schoolId,
          child_id: childId,
          user_id: userId,
          unregistered_athlete_id: unregisteredId,
          parent_id: selectedStudent.parent_id || null,
          // Bloqueador B (docs/specs/vigencia-cobranza-y-sesiones-unificado.md
          // §3.2): sin esto, trg_extend_enrollment_on_payment_paid nunca
          // extiende expires_at para un pago registrado directo como 'paid'.
          // Un cobro único va SIN plan (no extiende vigencia), con su
          // categoría y exento del índice de período (lib/manualPaymentCharge).
          ...chargeFields,
          amount: numericAmount,
          concept,
          status: 'paid',
          payment_method: paymentMethod === 'cash' ? 'cash' : 'transfer',
          payment_channel: paymentMethod === 'cash' ? 'cash' : 'transfer',
          payment_type: 'one_time',
          payment_date: pickedDay(),
          due_date: pickedDay(),
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          reference,
          ...(c ? { notes: lineaRecibido(c) } : {}),
          amount_paid: numericAmount,
          // Periodo solo en INSERT. En el UPDATE se respeta el que ya trae el
          // cobro pendiente: pisarlo colisiona con uniq_payment_active_period_*.
          period_year: periodApplies && period ? period.year : null,
          period_month: periodApplies && period ? period.month : null,
          ...receiptFields,
        } as any);

        if (insertError) {
          // 23505: ya existe un cobro para este atleta+período (el finder de
          // pendientes no lo agarró, p.ej. estados distintos). En vez de romper
          // con un 409 crudo, reutilizamos ese cobro: si sigue pendiente lo
          // marcamos pagado; si YA está pagado, avisamos (no duplicar).
          // Solo se rescata un choque del índice de PERÍODO con período elegido:
          // sin período, "el último cobro del deportista" podía ser otro (la
          // mensualidad pendiente) y se saldaba con la plata equivocada.
          if (canReuseOnPeriodConflict(insertError as any, periodApplies && !!period)) {
            let q = (supabase.from('payments') as any).select(PAYMENT_SNAPSHOT_COLUMNS)
              .eq('school_id', schoolId);
            if (childId) q = q.eq('child_id', childId);
            else if (userId) q = q.eq('user_id', userId);
            else if (unregisteredId) q = q.eq('unregistered_athlete_id', unregisteredId);
            if (period) {
              q = q.eq('period_year', period.year).eq('period_month', period.month);
            }
            // Solo la mensualidad del mes: un cobro único exento no es "el cobro del período".
            q = q.eq('period_uniqueness_exempt', false);
            const { data: existing } = await q.order('created_at', { ascending: false }).limit(1);
            const conflict = existing?.[0] as any;

            if (conflict && conflict.status === 'paid') {
              toast({
                title: 'Ya existe un pago para este período',
                description: 'Ese atleta ya tiene registrado el pago de este mes. No se duplicó.',
              });
              setLoading(false);
              return;
            }
            // El cobro del mes existe, pero la escuela nunca vio su valor (pudo
            // tener mora o abonos). Solo se salda acá si la plata coincide con
            // el saldo exacto; si no, se le manda a elegirlo en «Aplicar a» para
            // que vea el desglose — nunca se pisa su monto.
            const conflictSnap = conflict ? snapshotOf(conflict) : null;
            if (conflict?.id && conflictSnap && OPEN_STATUSES.includes(conflictSnap.status)
                && numericAmount !== balanceOf(conflictSnap)) {
              toast({
                title: 'Ese mes ya tiene un cobro abierto',
                description: `El cobro de ${period ? formatPeriodLabel(period.year, period.month) : 'ese mes'} tiene un saldo de ${formatCurrency(balanceOf(conflictSnap))}${
                  conflictSnap.lateFee > 0 ? ` (incluye recargo por mora de ${formatCurrency(conflictSnap.lateFee)})` : ''
                }. Elígelo en «Aplicar a» para registrar el pago.`,
                variant: 'destructive',
              });
              await fetchPendingPayments(selectedAthleteId);
              setLoading(false);
              return;
            }
            if (conflict?.id && conflictSnap) {
              const { fields: moneyFields } = applyFieldsFor(conflictSnap, numericAmount);
              const { data: reusedRows, error: reuseErr } = await supabase.from('payments').update({
                ...moneyFields,
                concept,
                payment_method: paymentMethod === 'cash' ? 'cash' : 'transfer',
                payment_channel: paymentMethod === 'cash' ? 'cash' : 'transfer',
                payment_date: pickedDay(),
                approved_by: user.id,
                approved_at: new Date().toISOString(),
                reference,
                ...(c ? { notes: notasConRecibido(conflict.notes, c) } : {}),
                ...unblockFields,
                ...receiptFields,
              } as any).eq('id', conflict.id).eq('amount', conflictSnap.amount).select('id');
              if (reuseErr) throw reuseErr;
              if (!reusedRows || reusedRows.length === 0) {
                throw new Error('No se registró el pago: el cobro de ese mes cambió o tu rol no puede modificarlo. Búscalo en «Aplicar a» e inténtalo de nuevo.');
              }
            } else {
              throw insertError;
            }
          } else {
            throw insertError;
          }
        }
      }

      // Notificar al padre o al atleta (si tienen cuenta)
      const recipientId = selectedStudent.parent_id || userId;
      if (recipientId) {
        await supabase.rpc('notify_user', {
          p_user_id: recipientId,
          p_title: abonoInfo
            ? '💰 Abono registrado'
            : paymentMethod === 'cash' ? '✅ Pago en efectivo registrado' : '✅ Transferencia registrada',
          p_message: abonoInfo
            ? `${schoolName || 'La escuela'} registró un abono de ${formatCurrency(numericAmount)} por ${concept}. Saldo pendiente: ${formatCurrency(abonoInfo.saldo)}.`
            : `${schoolName || 'La escuela'} registró tu pago de ${formatCurrency(numericAmount)} por ${concept}.`,
          p_type: abonoInfo ? 'payment' : 'success',
          p_link: '/my-payments'
        });
      }

      // Enviar correo de confirmación silencioso
      if (selectedStudent.parent_email) {
        emailClient.send({
          type: 'payment_confirmation',
          to: selectedStudent.parent_email,
          data: { 
            userName: selectedStudent.parent_name || 'Padre de familia',
            schoolName: schoolName || 'La escuela',
            amount: formatCurrency(numericAmount), 
            concept, 
            reference
          }
        }).catch(() => {}); // Fire and forget
      }

      const methodLabel = paymentMethod === 'cash' ? 'en efectivo' : 'por transferencia';
      toast(abonoInfo
        ? {
            title: 'Abono registrado',
            description: `Se registró un abono ${methodLabel} de ${formatCurrency(numericAmount)}. Queda un saldo de ${formatCurrency(abonoInfo.saldo)}.`,
          }
        : { title: 'Cobro Registrado', description: `El pago ${methodLabel} se ha registrado exitosamente.` });
      onSuccess();
      onOpenChange(false);
      resetForm();
    } catch (err: any) {
      console.error(err);
      if (isDuplicatePeriodError(err)) {
        toast({
          title: 'Mes ya cobrado',
          description: `Ya existe un cobro activo de ${period ? formatPeriodLabel(period.year, period.month) : 'ese mes'} para este deportista. Búscalo en "Aplicar a" en vez de crear uno nuevo.`,
          variant: 'destructive',
        });
      } else if (isDuplicateReceiptError(err)) {
        toast({
          title: 'Comprobante ya registrado',
          description: 'Este soporte ya está vinculado a otro pago de la escuela. Revísalo en Validación de Cobros antes de volver a registrarlo.',
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Error al reportar', description: err.message, variant: 'destructive' });
      }
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setSelectedAthleteId('');
    setSelectedPaymentId('new');
    setMultiMode(false);
    setSelectedIds([]);
    setPendingPayments([]);
    setPaymentMethod('cash');
    setConcept('Mensualidad');
    setChosenCategory(null);
    setAmount(0);
    setPaymentDate(new Date());
    setReceivedBy('');
    setShowReceivedError(false);
    setAthleteSearchQuery('');
    setAthletePopoverOpen(false);
    setPeriod(null);
    setPeriodSuggested(null);
    setWantsEInvoice(false);
    setPayerDianState(null);
    clearReceipt();
  };

  return (
    <Dialog open={open} onOpenChange={(val) => {
      onOpenChange(val);
      if (!val) resetForm();
    }}>
      <DialogContent className="sm:max-w-lg w-[95vw] p-0 overflow-hidden border-primary/20 bg-background/95 backdrop-blur-xl shadow-2xl max-h-[90vh] flex flex-col">
        <DialogHeader className="p-8 pb-4 border-b bg-primary/5 shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-emerald-500/10 rounded-xl">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            </div>
            <DialogTitle className="text-2xl font-black tracking-tight">Registrar pago manual</DialogTitle>
          </div>
          <DialogDescription className="text-muted-foreground font-medium">
            Registra transacciones de efectivo o transferencias de forma inmediata.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-8 space-y-6">
          <div className="space-y-3">
            <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <Wallet className="h-3.5 w-3.5" /> Método de pago
            </Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                className={cn(
                  "flex flex-col items-center justify-center p-4 rounded-2xl border-2 transition-all gap-2 group",
                  paymentMethod === 'cash' 
                    ? "bg-emerald-500/10 border-emerald-500 shadow-lg shadow-emerald-500/10" 
                    : "bg-muted/20 border-border/40 hover:border-border/80"
                )}
                onClick={() => {
                  setPaymentMethod('cash');
                  // El soporte solo aplica a transferencia: descartarlo evita
                  // guardar un receipt_url en un pago marcado como efectivo.
                  clearReceipt();
                }}
              >
                <div className={cn(
                  "p-2 rounded-xl transition-colors",
                  paymentMethod === 'cash' ? "bg-emerald-500 text-white" : "bg-muted/40 text-muted-foreground group-hover:bg-muted"
                )}>
                  <Banknote className="h-5 w-5" />
                </div>
                <span className={cn(
                  "text-xs font-black uppercase tracking-widest",
                  paymentMethod === 'cash' ? "text-emerald-500" : "text-muted-foreground"
                )}>Efectivo</span>
              </button>

              <button
                type="button"
                className={cn(
                  "flex flex-col items-center justify-center p-4 rounded-2xl border-2 transition-all gap-2 group",
                  paymentMethod === 'transfer' 
                    ? "bg-blue-500/10 border-blue-500 shadow-lg shadow-blue-500/10" 
                    : "bg-muted/20 border-border/40 hover:border-border/80"
                )}
                onClick={() => setPaymentMethod('transfer')}
              >
                <div className={cn(
                  "p-2 rounded-xl transition-colors",
                  paymentMethod === 'transfer' ? "bg-blue-500 text-white" : "bg-muted/40 text-muted-foreground group-hover:bg-muted"
                )}>
                  <Building2 className="h-5 w-5" />
                </div>
                <span className={cn(
                  "text-xs font-black uppercase tracking-widest",
                  paymentMethod === 'transfer' ? "text-blue-500" : "text-muted-foreground"
                )}>Transferencia</span>
              </button>
            </div>
          </div>

          {/* Soporte de la transferencia. Aca el comprobante YA le llego a la escuela
              (tipicamente por WhatsApp, dias antes), asi que dateMode='any': no se
              valida la fecha, solo se adjunta como evidencia. La ventana de fechas
              aplica al flujo del acudiente, no a este. El veredicto del BFF igual
              avisa si algo no cuadra, y el dedup por referencia/hash sigue vivo. */}
          {paymentMethod === 'transfer' && (
            <div className="space-y-3">
              <Label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <Paperclip className="h-3.5 w-3.5" /> Soporte de la transferencia
                <span className="font-bold normal-case tracking-normal text-[10px] text-muted-foreground/70">(opcional)</span>
              </Label>

              {receiptUrl ? (
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/5 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-xs font-bold text-blue-500">
                      <CheckCircle2 className="h-4 w-4 shrink-0" /> Soporte adjunto
                    </span>
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearReceipt}>
                      Quitar
                    </Button>
                  </div>

                  {/* Sugerencias del OCR: el admin decide si las aplica al formulario. */}
                  {(ocrResult?.extractedAmount != null || ocrResult?.extractedDate) && (
                    <div className="flex flex-wrap gap-2">
                      {ocrResult?.extractedAmount != null && ocrResult.extractedAmount !== amount && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs rounded-lg"
                          onClick={() => setAmount(ocrResult.extractedAmount as number)}
                        >
                          Usar monto {formatCurrency(ocrResult.extractedAmount)}
                        </Button>
                      )}
                      {ocrResult?.extractedDate && ocrResult.extractedDate !== format(paymentDate, 'yyyy-MM-dd') && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs rounded-lg"
                          onClick={() => setPaymentDate(new Date(`${ocrResult.extractedDate}T00:00:00`))}
                        >
                          Usar fecha {ocrResult.extractedDate}
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Avisos del motor de reglas. Informativos: el admin ya confirmo el ingreso. */}
                  {verdictWarnings.length > 0 && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                      <div className="space-y-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                        <p className="font-bold">Revisa antes de confirmar:</p>
                        {verdictWarnings.map((msg, i) => <p key={i}>{msg}</p>)}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <FileUpload
                  key={uploadKey}
                  bucket="payment-receipts"
                  accept="image/*,application/pdf"
                  validateReceipt
                  dateMode="any"
                  // El admin ya vio la plata: un rojo se le muestra arriba en
                  // `verdictWarnings` pero no le bloquea el registro. Al
                  // acudiente sí lo bloquea (default true).
                  blockOnRedVerdict={false}
                  schoolId={schoolId || undefined}
                  expectedAmount={typeof amount === 'number' && amount > 0 ? amount : undefined}
                  paymentId={selectedPaymentId !== 'new' ? selectedPaymentId : undefined}
                  paymentCategory={receiptCategory}
                  onUploadComplete={(url) => setReceiptUrl(url)}
                  onValidationResult={(r) => setOcrResult(r)}
                />
              )}
            </div>
          )}

          <div className="space-y-3">
            <Label htmlFor="student" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <User className="h-3.5 w-3.5" /> Deportista / Atleta
            </Label>
            <Popover open={athletePopoverOpen} onOpenChange={setAthletePopoverOpen}>
              <PopoverTrigger asChild disabled={loadingAthletes}>
                <Button
                  id="student"
                  variant="outline"
                  role="combobox"
                  aria-expanded={athletePopoverOpen}
                  className="w-full h-12 justify-between bg-background/50 border-border/40 rounded-xl font-bold px-4 py-2 hover:bg-background/80 text-left"
                >
                  <span className="truncate">
                    {selectedAthleteId 
                      ? athletes.find((a) => a.id === selectedAthleteId)?.full_name || 'Selecciona a quién aplica'
                      : 'Selecciona a quién aplica'
                    }
                  </span>
                  <span className="text-xs text-muted-foreground ml-2">▼</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2 rounded-xl bg-background/95 backdrop-blur-md border-border/40 shadow-2xl" align="start">
                <div className="p-1 mb-2">
                  <Input
                    placeholder="Buscar deportista..."
                    value={athleteSearchQuery}
                    onChange={(e) => setAthleteSearchQuery(e.target.value)}
                    className="h-10 bg-muted/40 rounded-lg text-sm focus-visible:ring-primary/20"
                    autoFocus
                  />
                </div>
                <div className="max-h-60 overflow-y-auto space-y-0.5">
                  {filteredAthletes.length === 0 ? (
                    <p className="p-3 text-center text-xs text-muted-foreground">No se encontraron deportistas.</p>
                  ) : (
                    filteredAthletes.map((ath) => (
                      <button
                        key={ath.id}
                        type="button"
                        onClick={() => {
                          setSelectedAthleteId(ath.id);
                          setAthletePopoverOpen(false);
                          setAthleteSearchQuery('');
                        }}
                        className={cn(
                          "w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-muted/60 transition-colors flex flex-col justify-center",
                          selectedAthleteId === ath.id && "bg-primary/10 text-primary font-bold hover:bg-primary/20"
                        )}
                      >
                        <span className="font-semibold">{ath.full_name}</span>
                        {ath.parent_name && (
                          <span className="text-[10px] text-muted-foreground">Padre: {ath.parent_name}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          {selectedAthleteId && (
            <div className="space-y-3">
              <Label htmlFor="pending-payment" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <FileText className="h-3.5 w-3.5" /> Aplicar a
              </Label>
              {!multiMode && (
              <Select value={selectedPaymentId} onValueChange={handlePendingSelect} disabled={loadingPending}>
                <SelectTrigger id="pending-payment" className="h-12 bg-background/50 border-border/40 rounded-xl font-bold">
                  <SelectValue placeholder={loadingPending ? 'Cargando...' : 'Selecciona un pago pendiente'} />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/40 bg-background/95 backdrop-blur-md">
                  <SelectItem value="new" className="rounded-lg py-2.5">
                    Nuevo cobro (sin asociar)
                  </SelectItem>
                  {pendingPayments.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="rounded-lg py-2.5">
                      {p.concept} — {formatCurrency(balanceOf(snapshotOf(p)))} · Vence {format(new Date(p.due_date), 'd MMM yyyy', { locale: es })}
                      {p.status === 'overdue' ? ' (atrasado)' : ''}
                      {p.status === 'partial' ? ' (saldo de un abono)' : ''}
                      {Number(p.late_fee_amount) > 0 ? ' · con mora' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              )}

              {/* Pagar varios cobros a la vez. */}
              {(multiCandidates.length > 1 || hermanasPending.length > 0) && (
                <button
                  type="button"
                  className="text-[11px] font-bold text-primary underline-offset-2 hover:underline"
                  onClick={() => {
                    setMultiMode(v => !v);
                    setSelectedIds([]);
                    setSelectedPaymentId('new');
                  }}
                >
                  {multiMode ? 'Volver a pagar un solo cobro' : 'Pagar varios cobros a la vez'}
                </button>
              )}

              {/* Hermana sin vincular: se vincula aquí mismo (link_siblings) y la lista se recarga. */}
              {esMenor && selectedAthleteId && schoolId && (
                <>
                  <button
                    type="button"
                    data-testid="cyp-vincular-hermana"
                    className="block text-[11px] font-bold text-primary underline-offset-2 hover:underline"
                    onClick={() => setShowVincular(v => !v)}
                  >
                    {showVincular ? 'Ocultar vínculo de hermanas' : '¿Falta una hermana? Vincúlala'}
                  </button>
                  {showVincular && (
                    <SiblingFamilySection
                      schoolId={schoolId}
                      childId={selectedAthleteId}
                      onChanged={() => setHermanasKey(k => k + 1)}
                    />
                  )}
                </>
              )}

              {multiMode && (
                <div className="space-y-2 rounded-xl border border-border/40 bg-background/50 p-3">
                  <label className="flex items-center gap-2 text-[11px] font-bold cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={allSelected}
                      onChange={(e) => setSelectedIds(e.target.checked ? multiCandidates.map(p => p.id) : [])}
                    />
                    Seleccionar todos ({multiCandidates.length})
                  </label>
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {multiCandidates.map((p) => (
                      <label key={p.id} className="flex items-start gap-2 rounded-lg p-1.5 text-xs cursor-pointer hover:bg-muted/40">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-4 w-4"
                          checked={selectedIds.includes(p.id)}
                          onChange={() => toggleSelected(p.id)}
                        />
                        <span className="flex-1">
                          <span className="block font-medium">{p.concept}</span>
                          <span className="block text-muted-foreground">
                            {formatCurrency(Number(p.amount) || 0)} · Vence {format(new Date(p.due_date), 'd MMM yyyy', { locale: es })}
                            {p.status === 'overdue' ? ' · atrasado' : ''}
                            {Number(p.discount_pct) > 0 ? ` · desc. ${Number(p.discount_pct)}%` : ''}
                            {Number(p.late_fee_amount) > 0 ? ` · incluye recargo por mora de ${formatCurrency(Number(p.late_fee_amount))}` : ''}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {hermanasPending.length > 0 && (
                    <div className="space-y-1 border-t border-border/40 pt-2" data-testid="cyp-hermanas">
                      <p className="text-[11px] font-bold">¿Este pago también es de sus hermanas?</p>
                      {hermanas.filter(h => hermanasPending.some(p => p.child_id === h.child_id)).map(h => (
                        <div key={h.child_id} className="space-y-1">
                          <p className="text-[11px] font-black text-muted-foreground">{h.full_name}</p>
                          {hermanasPending.filter(p => p.child_id === h.child_id).map(p => (
                            <label key={p.id} className="flex items-start gap-2 rounded-lg p-1.5 text-xs cursor-pointer hover:bg-muted/40">
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4"
                                data-testid={`cyp-hermana-cobro-${p.id}`}
                                checked={selectedIds.includes(p.id)}
                                onChange={() => toggleSelected(p.id)}
                              />
                              <span className="flex-1">
                                <span className="block font-medium">{p.concept}</span>
                                <span className="block text-muted-foreground">
                                  {formatCurrency(Number(p.amount) || 0)} · Vence {format(new Date(p.due_date), 'd MMM yyyy', { locale: es })}
                                  {p.status === 'overdue' ? ' · atrasado' : ''}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between border-t border-border/40 pt-2 text-sm font-black">
                    <span>Total a registrar ({selectedMulti.length})</span>
                    <span>{formatCurrency(multiTotal)}</span>
                  </div>
                  {multiLateFee > 0 && (
                    <p className="text-[11px] font-bold text-amber-700 dark:text-amber-400">
                      Incluye recargo por mora: {formatCurrency(multiLateFee)}
                    </p>
                  )}
                  {esMenor && selectedMulti.length > 0 && (
                    <div className="space-y-1 border-t border-border/40 pt-2" data-testid="cyp-monto-recibido">
                      <Label htmlFor="monto-recibido" className="text-[11px] font-bold">Monto recibido ($ COP)</Label>
                      <NumberStepper
                        value={recibidoManual === '' ? recibidoSugerido : recibidoManual}
                        onChange={setRecibidoManual}
                        step={500}
                        min={0}
                        unit="COP"
                        className="h-10"
                      />
                      {ocrMonto != null && Math.round(ocrMonto) !== Math.round(multiTotal) && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400" data-testid="cyp-recibido-ocr">
                          El comprobante dice {formatCurrency(Math.round(ocrMonto))} y los cobros suman {formatCurrency(multiTotal)}. Revisa que el monto recibido sea el correcto.
                        </p>
                      )}
                      {recibidoMenor && (
                        <p className="text-[11px] font-bold text-destructive" data-testid="cyp-recibido-menor">{MENSAJE_RECIBIDO_MENOR}</p>
                      )}
                      {avisoSaldo && (
                        <p className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400" data-testid="cyp-aviso-reparto">{avisoSaldo}</p>
                      )}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Cada cobro se registra por su propio valor (ya con descuento y mora). Si alguno falla, no se registra ninguno.
                  </p>
                </div>
              )}

              {/* Descuento aplicado al registrar al estudiante. */}
              {selectedPending && pendingDiscountPct > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-400/40 bg-emerald-500/10 p-2">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-500" />
                  <div className="space-y-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                    <p className="font-bold">Este cobro tiene un descuento del {pendingDiscountPct}%</p>
                    {pendingListAmount > 0 && pendingBase !== null && (
                      <p>
                        Precio de lista {formatCurrency(pendingListAmount)} − descuento{' '}
                        {formatCurrency(pendingListAmount - pendingBase)} = {formatCurrency(pendingBase)}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Recargo por mora: apply_late_fees() ya lo sumó al cobro. Se
                  muestra el desglose para que la escuela cobre el total y se lo
                  pueda explicar a la familia. */}
              {selectedPending && pendingLateFee > 0 && pendingAmount !== null && pendingBase !== null && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                  <div className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                    <p className="font-bold">Este cobro tiene recargo por mora</p>
                    <p>
                      {pendingIsMensualidad ? 'Mensualidad' : 'Valor del cobro'} {formatCurrency(pendingBase)} + recargo por mora{' '}
                      {formatCurrency(pendingLateFee)} = {formatCurrency(pendingAmount)}
                    </p>
                    {pendingSnap && pendingSnap.amountPaid > 0 && pendingBalance !== null && (
                      <p>Ya abonado {formatCurrency(pendingSnap.amountPaid)} · saldo {formatCurrency(pendingBalance)}</p>
                    )}
                    <p className="opacity-80">
                      Si la escuela decide perdonar el recargo, hazlo con «Condonar recargo» en Cobros y pagos; aquí no se
                      puede bajar el valor del cobro.
                    </p>
                  </div>
                </div>
              )}

              {/* Abono previo sin mora: igual se cobra solo el saldo. */}
              {selectedPending && pendingLateFee === 0 && pendingSnap && pendingSnap.amountPaid > 0 && pendingBalance !== null && (
                <p className="text-[11px] text-muted-foreground">
                  Ya abonado {formatCurrency(pendingSnap.amountPaid)} de {formatCurrency(pendingSnap.amount)} · saldo{' '}
                  {formatCurrency(pendingBalance)}
                </p>
              )}

              {/* Rechazo previo de la pasarela. Informativo: no frena el registro manual. */}
              {reviewNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
                  <div className="space-y-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                    <p className="font-bold">Este cobro venía marcado en revisión</p>
                    <p>{reviewNotice}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Facturación electrónica del pagador. Se muestra SIEMPRE que la
              escuela tenga el addon, con los cuatro estados dichos en voz alta:
              datos listos / listos pero sin código DANE / faltan / no hay a
              quién cargarlos. Antes solo aparecía cuando faltaban, y desde
              afuera no se distinguía "ya está" de "no aplica" — ni había forma
              de corregir un dato malo.

              NINGUNO de estos estados frena el registro del pago: este bloque
              es informativo. La escuela registra la plata que ya recibió, y el
              dato fiscal se completa acá si está a mano o después desde
              Contabilidad → Datos fiscales faltantes. */}
          {selectedAthleteId && hasAddon('invoicing') && (
            <div className="rounded-2xl border border-border/40 bg-muted/10 p-4 space-y-3">
              {!payerProfileId ? (
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                    <span className="font-bold">Sin acudiente con cuenta.</span> No hay un perfil
                    al cual cargarle los datos fiscales, así que este cobro no se puede facturar
                    a nombre del pagador. Vincula un acudiente, o factúralo a nombre del propio
                    deportista.
                  </p>
                </div>
              ) : checkingDian ? (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Revisando datos de facturación…
                </span>
              ) : payerDianState === 'complete' ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-xs font-bold text-emerald-600">
                    <CheckCircle2 className="h-4 w-4 shrink-0" /> Datos de facturación completos
                  </span>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => setWantsEInvoice((v) => !v)}>
                    {wantsEInvoice ? 'Cerrar' : 'Corregir'}
                  </Button>
                </div>
              ) : payerDianState === 'no_dane' ? (
                /* Emitible, pero el municipio está en texto libre. Se dice qué
                   sale mal en el documento —no un genérico "faltan datos"—
                   porque el dato existe y quien registra el pago puede tener al
                   acudiente enfrente para preguntarle la ciudad. */
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                      <span className="font-bold">Falta el municipio con código DANE.</span> La factura
                      se emite igual, pero saldrá con la ciudad de la escuela, no con la del pagador.
                    </p>
                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 text-xs"
                      onClick={() => setWantsEInvoice((v) => !v)}>
                      {wantsEInvoice ? 'Cerrar' : 'Completar'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="wants-einvoice" className="text-sm font-bold flex items-center gap-2 cursor-pointer">
                    <Receipt className="h-4 w-4 text-primary" /> ¿Desea factura electrónica?
                  </Label>
                  <Switch id="wants-einvoice" checked={wantsEInvoice} onCheckedChange={setWantsEInvoice} />
                </div>
              )}

              {wantsEInvoice && payerProfileId && (
                <BillingDetailsForm
                  userId={payerProfileId}
                  schoolId={schoolId || undefined}
                  payerName={payerName || undefined}
                  payerKind={selectedAthleteForPayer?.athlete_type === 'adult' ? 'adult_athlete' : 'guardian'}
                  /* El formulario exige el código DANE (regex en su schema), así
                     que al guardar el perfil queda 'complete' de verdad. */
                  onComplete={() => { setPayerDianState('complete'); setWantsEInvoice(false); }}
                />
              )}
            </div>
          )}

          {!multiMode && (
          <div className="space-y-3">
            <Label htmlFor="concept" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
              <FileText className="h-3.5 w-3.5" /> Concepto de pago
            </Label>
            <Input
              id="concept"
              placeholder="Ej. Mensualidad Mayo..."
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
              className="h-12 bg-background/50 border-border/40 rounded-xl font-medium focus-visible:ring-primary/20"
            />
          </div>
          )}

          {/* Tipo del cobro NUEVO. Decide si lleva «Mes que cubre» (solo la
              mensualidad) y si pagarlo extiende la vigencia (un cobro único
              no). Por defecto se deduce del concepto; la escuela lo corrige.
              Al aplicar a un pendiente no se muestra: ese cobro ya tiene el suyo. */}
          {selectedPaymentId === 'new' && (
            <div className="space-y-3">
              <Label htmlFor="charge-category" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <FileText className="h-3.5 w-3.5" /> Tipo de cobro
              </Label>
              <Select
                value={newChargeCategory ?? ''}
                onValueChange={(v) => setChosenCategory(v as PaymentChargeCategory)}
              >
                <SelectTrigger id="charge-category" className="h-12 bg-background/50 border-border/40 rounded-xl font-bold">
                  <SelectValue placeholder="Selecciona el tipo de cobro" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/40 bg-background/95 backdrop-blur-md">
                  {MANUAL_CHARGE_CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="rounded-lg py-2.5">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newChargeCategory && newChargeCategory !== 'mensualidad' && (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Cobro único: no cubre un mes ni extiende la vigencia de la inscripción.
                </p>
              )}
            </div>
          )}

          {/* Tipo del cobro NUEVO. Decide si lleva «Mes que cubre» (solo la
              mensualidad) y si pagarlo extiende la vigencia (un cobro único
              no). Por defecto se deduce del concepto; la escuela lo corrige.
              Al aplicar a un pendiente no se muestra: ese cobro ya tiene el suyo. */}
          {selectedPaymentId === 'new' && (
            <div className="space-y-3">
              <Label htmlFor="charge-category" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <FileText className="h-3.5 w-3.5" /> Tipo de cobro
              </Label>
              <Select
                value={newChargeCategory ?? ''}
                onValueChange={(v) => setChosenCategory(v as PaymentChargeCategory)}
              >
                <SelectTrigger id="charge-category" className="h-12 bg-background/50 border-border/40 rounded-xl font-bold">
                  <SelectValue placeholder="Selecciona el tipo de cobro" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/40 bg-background/95 backdrop-blur-md">
                  {MANUAL_CHARGE_CATEGORY_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value} className="rounded-lg py-2.5">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {newChargeCategory && newChargeCategory !== 'mensualidad' && (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Cobro único: no cubre un mes ni extiende la vigencia de la inscripción.
                </p>
              )}
            </div>
          )}

          {/* Mes que cubre el cobro. NO es la fecha del pago: se puede registrar
              hoy (julio) un pago que cubre agosto. Poblarlo mete el cobro en los
              indices uniq_payment_active_period_* — sin esto la app le volveria a
              ofrecer el mismo mes al acudiente y se cobraria dos veces. */}
          {periodApplies && (
            <div className="space-y-3">
              <Label htmlFor="period" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <CalendarIcon className="h-3.5 w-3.5" /> Mes que cubre
              </Label>
              <Select
                value={period ? periodKey(period) : ''}
                onValueChange={(v) => { const p = parsePeriodKey(v); if (p) setPeriod(p); }}
                disabled={loadingPeriod}
              >
                <SelectTrigger id="period" className="h-12 bg-background/50 border-border/40 rounded-xl font-bold">
                  <SelectValue placeholder={loadingPeriod ? 'Calculando...' : 'Selecciona el mes'} />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-border/40 bg-background/95 backdrop-blur-md max-h-72">
                  {(periodSuggested ? periodOptions(periodSuggested) : periodOptions(currentPeriodBogota())).map((p) => (
                    <SelectItem key={periodKey(p)} value={periodKey(p)} className="rounded-lg py-2.5">
                      {formatPeriodLabel(p.year, p.month)}
                      {periodSuggested && periodKey(p) === periodKey(periodSuggested) ? ' — sugerido' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                El mes que se está pagando, no la fecha en que entró la plata. Se sugiere el
                primer mes sin pagar; cámbialo si estás poniendo al día un mes atrasado.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-3">
              <Label htmlFor="amount" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <Landmark className="h-3.5 w-3.5" /> Monto ($ COP)
              </Label>
              {multiMode ? (
                <div className="flex h-12 items-center rounded-xl border border-border/40 bg-muted/30 px-3 font-black">
                  {formatCurrency(multiTotal)}
                </div>
              ) : (
              <NumberStepper
                value={amount}
                onChange={setAmount}
                step={10000}
                min={0}
                unit="COP"
                className="h-12"
              />
              )}
            </div>
            <div className="space-y-3">
              <Label htmlFor="date" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <CalendarIcon className="h-3.5 w-3.5" /> Fecha del pago
              </Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant={"outline"}
                    className={cn(
                      "w-full h-12 justify-start text-left font-medium bg-background/50 border-border/40 rounded-xl",
                      !paymentDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4 opacity-50" />
                    {paymentDate ? format(paymentDate, "PPP", { locale: es }) : <span>Seleccionar fecha</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 rounded-xl overflow-hidden border-border/30 shadow-2xl" align="start">
                  <Calendar
                    mode="single"
                    selected={paymentDate}
                    onSelect={(date) => date && setPaymentDate(date)}
                    initialFocus
                    locale={es}
                    className="bg-background/95 backdrop-blur-md"
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Sin comprobante: quién del equipo recibió la plata (cómo y cuándo ya están arriba). */}
          {needsReceivedBy && (
            <RecibidoSinComprobanteCampos
              value={{ metodo: paymentMethod, fecha: pickedDay(), por: receivedBy }}
              onChange={(v) => setReceivedBy(v.por)}
              hoy={todayColombia()}
              mostrarMetodo={false}
              mostrarFecha={false}
              idPrefix="manual-recibido"
              error={showReceivedError ? receivedError : null}
            />
          )}

          {/* El cobro cambió en la base desde que se abrió el formulario. */}
          {staleNotice && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                <span className="font-bold block">El cobro se actualizó</span>
                {staleNotice}
              </p>
            </div>
          )}

          {/* El monto a registrar no coincide con el saldo del cobro: menos es un
              abono (el valor del cobro NO se toca); más sube el valor del cobro
              (p. ej. se quitó el descuento). En los dos casos se confirma. */}
          {amountDiffersFromCharge && pendingBalance !== null && (
            <label className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={confirmAmountChange}
                onChange={(e) => setConfirmAmountChange(e.target.checked)}
              />
              {isPartialReceipt ? (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  <span className="font-bold block">Se registrará como abono</span>
                  El saldo del cobro es {formatCurrency(pendingBalance)}
                  {pendingLateFee > 0 ? ` (incluye recargo por mora de ${formatCurrency(pendingLateFee)})` : ''} y vas a registrar{' '}
                  {formatCurrency(receivedAmount)}. El cobro queda abierto con un saldo de{' '}
                  {formatCurrency(pendingBalance - receivedAmount)}. Marca la casilla para confirmar.
                </span>
              ) : (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  <span className="font-bold block">El monto es mayor al saldo del cobro</span>
                  El saldo es de {formatCurrency(pendingBalance)}
                  {pendingDiscountPct > 0 ? ` (ya con el descuento del ${pendingDiscountPct}%)` : ''} y vas a registrar{' '}
                  {formatCurrency(receivedAmount)}: el valor del cobro sube a{' '}
                  {formatCurrency((pendingAmount ?? 0) + (receivedAmount - pendingBalance))}. Marca la casilla para confirmar que es correcto.
                </span>
              )}
            </label>
          )}

          <Button
            className={cn(
              "w-full h-14 mt-4 font-black uppercase tracking-widest text-sm shadow-xl transition-all gap-3",
              paymentMethod === 'cash'
                ? "bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/20"
                : "bg-blue-500 hover:bg-blue-600 shadow-blue-500/20"
            )}
            disabled={loading || (multiMode && selectedMulti.length === 0) || (multiMode && recibidoMenor) || (amountDiffersFromCharge && !confirmAmountChange)}
            onClick={multiMode ? handleSaveMulti : handleSave}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            {loading ? 'Registrando...' : 'Confirmar Registro'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
