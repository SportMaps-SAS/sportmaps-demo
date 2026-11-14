import { useState, useEffect, useRef, useMemo } from 'react';
import { mensajeErrorDeMonto } from '@/lib/paymentAmountError';
import { todayColombia } from '@/lib/dateUtils';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { ArrowLeft, CheckCircle2, Shield, AlertCircle, Download, Users, CreditCard, Upload, Eye, EyeOff, Copy, Maximize2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useSchoolContext } from '@/hooks/useSchoolContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { downloadReceipt } from '@/lib/receipt-generator';
import { usePdfBranding } from '@/hooks/usePdfBranding';
import { openWompiCheckout, generatePaymentReference, mensajeCheckoutNoDisponible } from '@/lib/api/wompi';
import { bffClient } from '@/lib/api/bffClient';
import { autoEvaluate as autoEvaluateGlosa } from '@/lib/api/glosas';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MercadoPagoBrick from '@/components/checkout/MercadoPagoBrick';
import type { MpCreatePaymentResult } from '@/lib/api/mercadopago';
import { BillingDetailsForm } from '@/components/billing/BillingDetailsForm';
import { useSchoolInvoicingActive, mustAskBillingData } from '@/hooks/useSchoolInvoicingActive';
import { getUserFriendlyError } from '@/lib/error-translator';
import { maskSensitive } from '@/lib/utils';
import { resolvePaymentAccounts, resolvePaymentLink, accountDisplayLabel, chargeCategoryOf, isOneTimeCategory } from '@/lib/payment-accounts';
import { PaymentLinkButton } from '@/components/payment/PaymentLinkButton';
import { FileUpload } from '@/components/common/FileUpload';
import type { ReceiptValidationResult, ConceptKind } from '@/hooks/useReceiptValidator';
import { blockPwaReload, unblockPwaReload } from '@/pwa/reloadGuard';
import { useNextUnpaidPeriod, isPeriodActive, type PeriodStatus } from '@/hooks/usePaymentPeriod';

/** Intenta parsear un string como JSON; devuelve null si no es JSON valido. */
function safeParseJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

export default function ParentCheckoutPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { schoolBranding } = useSchoolContext();
  const { toast } = useToast();

  // Copiar un dato de pago (siempre disponible, también en móvil donde no hay hover).
  const copyField = (value: string | null | undefined, label: string) => {
    if (!value) return;
    navigator.clipboard?.writeText(value);
    toast({ title: `${label} copiado`, description: value });
  };

  const [paymentFlow, setPaymentFlow] = useState<'wompi' | 'mercadopago' | 'manual'>('wompi');
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess] = useState(false);
  const [receiptNumber, setReceiptNumber] = useState('');
  const [wompiTxId, setWompiTxId] = useState('');
  const [paymentMethodUsed, setPaymentMethodUsed] = useState('');

  // Reference MP generada cuando el padre selecciona MercadoPago.
  // Se persiste para que recordPaymentWithTraceability use la misma referencia.
  const [mpReference, setMpReference] = useState<string>('');
  const [showSensitive, setShowSensitive] = useState(false);
  const [manualReceiptUrl, setManualReceiptUrl] = useState('');
  const [manualOcrResult, setManualOcrResult] = useState<ReceiptValidationResult | null>(null);

  // En Android/iOS subir el comprobante abre el selector de archivos o la cámara del
  // sistema. Al volver al WebView el acudiente queda donde estaba —arriba, con los
  // datos bancarios y el QR de por medio— y el aviso de "falta el último paso" más el
  // botón de enviar quedan fuera de pantalla. Ese regreso es el punto donde se pierde
  // el paso 2: nueve familias de Dynasty subieron y no confirmaron (2026-08-05).
  // Traerlos al aviso en cuanto el archivo queda cargado.
  /**
   * Enlaza el comprobante al cobro EN CUANTO se sube, sin esperar la confirmación.
   *
   * El flujo del acudiente son dos pasos y el segundo es perdible: si se cae en el
   * medio, el archivo queda huérfano en storage, `payments` sin tocar, y la escuela
   * sin ver nada. Peor: la policy de storage autoriza por `payments.receipt_url`, así
   * que un huérfano NO lo puede leer ni la escuela ni la familia — solo el service
   * role. Medido en Dynasty el 2026-08-05: 9 familias, y el caso de Paola Reyes
   * (pagó $90.000 anticipado por Bre-B el 02-ago y el cobro seguía pendiente).
   *
   * Con esto el comprobante queda visible en "Validación de Cobros" desde la subida.
   * El paso de confirmar sigue existiendo y reescribe esto mismo más el OCR completo;
   * este adelanto es la red por si no llega.
   *
   * DOS GUARDAS, y las dos vienen de errores reales:
   *
   *   1. Solo con `paymentIdParam`. Sin él no sabemos a qué cobro pertenece y NO se
   *      adivina: Diana María Pinzón tenía un comprobante de julio (ya pagado) y un
   *      pendiente de agosto, y un UPDATE que filtraba por "impago" le habría pegado
   *      el soporte de julio al cobro de agosto.
   *   2. Solo sobre cobros abiertos. `paid`/`approved`/`glosado`/`cancelled` no se
   *      tocan. Se incluye `awaiting_approval` a propósito para que una segunda
   *      subida CORRIJA la anterior (subió la imagen equivocada y la reemplaza).
   *
   * OJO — consecuencia contable: al salir de `pending`, el cobro deja de sumar en las
   * tarjetas de Finanzas (que cuentan pending/overdue) y `apply_late_fees` deja de
   * correrle la mora. Es el intercambio buscado —la familia ya hizo su parte— y la
   * plata no se pierde de vista: pasa a la cola de "Por Validar".
   */
  const linkReceiptOnUpload = async (url: string) => {
    if (!paymentIdParam || !url) return;
    const { error } = await supabase
      .from('payments')
      .update({
        receipt_url: url,
        status: 'awaiting_approval',
        updated_at: new Date().toISOString(),
      } as any)
      .eq('id', paymentIdParam)
      .in('status', ['pending', 'overdue', 'awaiting_approval']);

    // No se le grita al acudiente: el botón de confirmar sigue siendo el camino
    // principal y reescribe todo. Esto es el respaldo.
    if (error) console.error('[checkout] no se pudo enlazar el comprobante al subirlo:', error.message);
  };

  const pendingSendRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!manualReceiptUrl) return;
    // rAF: esperar a que el aviso exista en el DOM antes de desplazarse.
    const raf = requestAnimationFrame(() => {
      pendingSendRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [manualReceiptUrl]);

  // Feature Flag State
  const [paymentSettings, setPaymentSettings] = useState<{ allow_online: boolean; allow_manual: boolean } | null>(null);
  // Config de abonos (school_settings). Gatea el OCR: si allow_installments es
  // false, un comprobante por menos del esperado se bloquea.
  const [installmentCfg, setInstallmentCfg] = useState<{ allow_installments: boolean; min_installment_amount: number }>({ allow_installments: false, min_installment_amount: 0 });
  // Días hacia atrás que vale un comprobante (school_settings.receipt_date_window_days,
  // el mismo del BFF). Sin pasarlo, el validador del navegador usaba «hoy o ayer».
  const [receiptWindowDays, setReceiptWindowDays] = useState<number | undefined>(undefined);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [showFullQr, setShowFullQr] = useState(false);

  // Si venimos del QR de inscripción, el pago YA existe (payment_id). Lo cargamos
  // como fuente de verdad (monto/concepto reales) y al pagar lo ACTUALIZAMOS en vez
  // de crear uno nuevo → evita el pago duplicado sin comprobante.
  const paymentIdParam = searchParams.get('payment_id');
  const [qrPayment, setQrPayment] = useState<{ amount: number; amount_paid: number | null; late_fee_amount?: number | null; concept: string; child_id: string | null; team_id: string | null; payment_category?: string | null } | null>(null);

  const amount = qrPayment?.amount ?? parseInt(searchParams.get('amount') || '150000');
  // Abono previo (si el pago ya tiene un parcial). Se cobra solo el SALDO.
  const amountPaid = Number(qrPayment?.amount_paid) || 0;
  const balanceDue = Math.max(amount - amountPaid, 0);
  const chargeAmount = amountPaid > 0 ? balanceDue : amount;
  // Recargo por mora (2026-10-14): apply_late_fees() lo suma DENTRO de `amount`
  // por la noche. El total ya lo incluye; esto solo se lo explica al acudiente.
  const lateFee = Number(qrPayment?.late_fee_amount) || 0;
  const concept = qrPayment?.concept ?? (searchParams.get('concept') || 'Mensualidad Octubre 2024');
  // Nombres reales: primero lo resuelto del pago (child_id / school_id), luego
  // los query params. NUNCA placeholders demo hardcodeados.
  const studentNameParam = searchParams.get('student') || '';
  const schoolNameParam  = searchParams.get('school')  || '';
  const [resolvedStudentName, setResolvedStudentName] = useState('');
  const [resolvedSchoolName,  setResolvedSchoolName]  = useState('');
  // Escuela del cobro: viene en la URL o se deriva del equipo. Se necesita en el
  // render (no solo al pagar) para que el OCR del comprobante pueda computar el
  // veredicto y correr el dedup contra los cobros de ESTA escuela.
  const [resolvedSchoolId,    setResolvedSchoolId]    = useState<string | null>(null);
  const studentName = resolvedStudentName || studentNameParam || 'Deportista';
  const schoolName  = resolvedSchoolName  || schoolNameParam  || '';
  const teamName = searchParams.get('team') || '';
  const schoolIdParam = searchParams.get('school_id');

  const formatPrice = (price: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(price);

  // Concept fijo (bloquea OCR si el monto no coincide) vs lenient (advisory).
  // Por ahora solo mensualidad es 'fixed'; inscripcion/abono pasan como 'lenient'
  // mientras validamos bien esos flujos.
  const conceptKind: ConceptKind = /mensual/i.test(concept) ? 'fixed' : 'lenient';

  const [hasCompleteDianData, setHasCompleteDianData] = useState<boolean>(true);
  const [checkingDian, setCheckingDian] = useState<boolean>(true);
  // Los datos fiscales se piden SOLO si la escuela factura electrónicamente
  // (addon 'invoicing' + facturador activo). Antes se exigían siempre. Mientras
  // no se sabe (o si la consulta falla) se piden, como antes.
  const { active: schoolInvoicingActive } = useSchoolInvoicingActive(resolvedSchoolId ?? schoolIdParam);
  const askDianData = mustAskBillingData(hasCompleteDianData, schoolInvoicingActive);

  // Fetch DIAN Profile Data
  // Bloquear auto-recarga del PWA mientras el acudiente está en el checkout
  // (evita perder el comprobante subido si un SW nuevo toma control).
  useEffect(() => {
    blockPwaReload();
    return () => unblockPwaReload();
  }, []);

  useEffect(() => {
    if (user?.id) {
      const checkProfile = async () => {
        setCheckingDian(true);
        const { data } = await supabase.from('profiles').select('document_type, document_number, billing_address, billing_city_dane').eq('id', user.id).single();
        if (data && data.document_type && data.document_number && data.billing_address && data.billing_city_dane) {
          setHasCompleteDianData(true);
        } else {
          setHasCompleteDianData(false);
        }
        setCheckingDian(false);
      };
      checkProfile();
    }
  }, [user?.id]);

  const [bankDetails, setBankDetails] = useState<any>(null);
  // Llaves visibles de la escuela; si aún no guardó la lista, se arman desde las
  // columnas viejas para no dejar el bloque de transferencia vacío.
  // Una llave restringida (`only_for`, p.ej. el Nequi de inscripciones de
  // Dynasty) solo aparece si este cobro es de su concepto.
  // La categoría de la fila manda (inscripción, seguro…); el concepto es el respaldo.
  const chargeCategory = chargeCategoryOf(qrPayment?.payment_category ?? null, concept);
  const payableAccounts = useMemo(
    () => resolvePaymentAccounts(bankDetails, { category: chargeCategory }),
    [bankDetails, chargeCategory],
  );
  // Link de pago genérico de la escuela (Wompi de Dynasty): botón dentro de la
  // transferencia, porque igual termina en subir el comprobante.
  const paymentLink = useMemo(
    () => resolvePaymentLink(bankDetails, { category: chargeCategory }),
    [bankDetails, chargeCategory],
  );

  // Fetch School Settings (Feature Flag)
  useEffect(() => {
    const fetchSchoolSettings = async () => {
      // Multi-tenant safe: prefer explicit school_id, fall back to name.
      // Never use .limit(1) without a filter - would pick arbitrary tenant.
      let query = supabase.from('schools').select('id, payment_settings');

      if (schoolIdParam) {
        query = query.eq('id', schoolIdParam);
      } else if (schoolNameParam) {
        query = query.eq('name', schoolNameParam);
      } else {
        setPaymentSettings({ allow_online: false, allow_manual: true });
        setPaymentFlow('manual');
        setLoadingSettings(false);
        return;
      }

      const { data } = await query.maybeSingle();

      // La fuente de verdad de "pagos online" es school_settings.wompi_enabled
      // (lo que edita el owner en SportMaps Pay). schools.payment_settings es
      // un JSONB legacy que sólo tenía el default y nunca se actualizaba, por
      // lo que el toggle del owner nunca llegaba al padre. Se deja como OR de
      // respaldo por si alguna escuela vieja lo tuviera seteado.
      const legacy = (data?.payment_settings as any) || { allow_online: false };

      if (data?.id) {
        const { data: ss } = await supabase.from('school_settings')
          .select('wompi_enabled, allow_installments, min_installment_amount, bank_name, bank_account_type, bank_account_number, nequi_number, daviplata_number, breb_number, breb_key, transfer_key, bank_titular_name, bank_titular_id, payment_qr_url, receipt_date_window_days')
          .eq('school_id', data.id)
          .maybeSingle();

        // payment_accounts (migración 20260809095613) va aparte: si el ambiente no
        // la aplicó todavía, PostgREST devuelve 400 y se cae la query completa,
        // dejando al acudiente sin datos de transferencia. Separado, el frontend
        // se puede desplegar antes que la migración.
        const { data: accounts } = await supabase.from('school_settings')
          .select('payment_accounts')
          .eq('school_id', data.id)
          .maybeSingle();

        const s = ss ? { ...ss, payment_accounts: accounts?.payment_accounts ?? null } : ss;
        const allowOnline = Boolean(s?.wompi_enabled) || Boolean(legacy.allow_online);
        // El pago manual (transferencia + comprobante) siempre está disponible.
        setPaymentSettings({ allow_online: allowOnline, allow_manual: true });
        setPaymentFlow(allowOnline ? 'wompi' : 'manual');

        setInstallmentCfg({
          allow_installments: Boolean(s?.allow_installments),
          min_installment_amount: Number(s?.min_installment_amount) || 0,
        });
        {
          const w = Number((s as any)?.receipt_date_window_days);
          setReceiptWindowDays(Number.isFinite(w) && w >= 0 ? w : undefined);
        }
        setBankDetails(s);
      } else {
        setPaymentSettings({ allow_online: false, allow_manual: true });
        setPaymentFlow('manual');
      }

      setLoadingSettings(false);
    };

    fetchSchoolSettings();
  }, [schoolNameParam, schoolIdParam]);

  // Cargar el pago preexistente del QR como fuente de verdad (monto/concepto/ids)
  const QR_PAYMENT_COLUMNS = 'amount, amount_paid, late_fee_amount, concept, child_id, team_id, payment_category';
  useEffect(() => {
    if (!paymentIdParam) return;
    supabase.from('payments')
      .select(QR_PAYMENT_COLUMNS)
      .eq('id', paymentIdParam)
      .maybeSingle()
      .then(({ data }) => { if (data) setQrPayment(data as any); });
  }, [paymentIdParam]);

  /**
   * Relee el cobro justo antes de pagar. La página pudo quedar abierta de un día
   * para otro y en el medio la mora de la noche subió el valor: el acudiente
   * vería (y transferiría) el monto viejo. Si cambió, se actualiza la pantalla,
   * se le avisa con el valor nuevo y NO se sigue: el siguiente clic confirma.
   * Devuelve true si se puede continuar.
   */
  const confirmFreshAmount = async (): Promise<boolean> => {
    if (!paymentIdParam || !qrPayment) return true;
    const { data, error } = await supabase.from('payments')
      .select(QR_PAYMENT_COLUMNS)
      .eq('id', paymentIdParam)
      .maybeSingle();
    // Sin poder releer no se frena el pago: el servidor y la escuela validan el monto.
    if (error || !data) return true;
    const fresh = data as any;
    const changed = Number(fresh.amount) !== Number(qrPayment.amount)
      || (Number(fresh.amount_paid) || 0) !== (Number(qrPayment.amount_paid) || 0)
      || (Number(fresh.late_fee_amount) || 0) !== (Number(qrPayment.late_fee_amount) || 0);
    if (!changed) return true;
    setQrPayment(fresh);
    const freshDue = Math.max((Number(fresh.amount) || 0) - (Number(fresh.amount_paid) || 0), 0);
    const freshFee = Number(fresh.late_fee_amount) || 0;
    toast({
      title: 'El valor de este cobro se actualizó',
      description: `Ahora es ${formatPrice(freshDue)}${freshFee > 0 ? ` (incluye recargo por mora de ${formatPrice(freshFee)})` : ''}. Revisa el total y vuelve a confirmar.`,
    });
    return false;
  };

  // Otros cobros abiertos del mismo deportista en la escuela. El alta por QR emite
  // hasta tres (inscripción + seguro + mensualidad, migración 20261013193011) y el
  // checkout paga uno por vez: sin esta lista el acudiente pagaba la mensualidad y
  // la inscripción y el seguro quedaban colgados sin que nadie se los mostrara.
  const [otherOpenCharges, setOtherOpenCharges] = useState<Array<{
    id: string; amount: number; amount_paid: number | null; concept: string;
    payment_category: string | null; due_date: string | null;
  }>>([]);

  const goToCharge = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('payment_id', id);
    next.delete('amount');
    next.delete('concept');
    setSuccess(false);
    setManualReceiptUrl('');
    setManualOcrResult(null);
    setReceiptNumber('');
    setWompiTxId('');
    setPaymentMethodUsed('');
    setMpReference('');
    navigate(`/parent-checkout?${next.toString()}`);
    window.scrollTo({ top: 0 });
  };

  const pdfBranding = usePdfBranding();

  const handleDownloadReceipt = async () => {
    await downloadReceipt({
      receiptNumber,
      date: new Date().toLocaleDateString('es-CO'),
      customerName: user?.user_metadata?.full_name || 'Cliente',
      customerEmail: user?.email,
      concept,
      amount: chargeAmount,
      paymentMethod: paymentMethodUsed || paymentFlow,
      paymentType: 'monthly',
      schoolName,
      studentName,
      // Feature gate aplicado en usePdfBranding (free -> null + defaults)
      logoUrl: pdfBranding.logoUrl,
      brandingSettings: pdfBranding.brandingSettings,
      receiptUrl: manualReceiptUrl,
    });
  };

  const childId = qrPayment?.child_id ?? searchParams.get('child_id');
  const teamId = qrPayment?.team_id ?? searchParams.get('team_id');

  // Resuelve el nombre real del atleta y de la escuela desde el pago, para que
  // la UI del checkout, la notificación y el recibo no muestren placeholders
  // demo ("Juan Vargas / Spirit All Stars") cuando la URL no trae esos params.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (childId) {
        const { data } = await supabase.from('children').select('full_name').eq('id', childId).maybeSingle();
        if (!cancelled && data?.full_name) setResolvedStudentName(data.full_name);
      }
      let sid = schoolIdParam;
      if (!sid && teamId) {
        const { data: t } = await supabase.from('teams').select('school_id').eq('id', teamId).maybeSingle();
        sid = t?.school_id ?? null;
      }
      if (!cancelled) setResolvedSchoolId(sid);
      if (sid) {
        const { data: s } = await supabase.from('schools').select('name').eq('id', sid).maybeSingle();
        if (!cancelled && s?.name) setResolvedSchoolName(s.name);
      }
    })();
    return () => { cancelled = true; };
  }, [childId, teamId, schoolIdParam]);

  // Cobros hermanos del alta (ver otherOpenCharges). Se recarga al pagar (success)
  // para que la pantalla de éxito muestre lo que todavía falta.
  const chargesSchoolId = resolvedSchoolId ?? schoolIdParam;
  useEffect(() => {
    if (!childId || !chargesSchoolId || !paymentIdParam) { setOtherOpenCharges([]); return; }
    let cancelled = false;
    supabase.from('payments')
      .select('id, amount, amount_paid, concept, payment_category, due_date')
      .eq('child_id', childId)
      .eq('school_id', chargesSchoolId)
      .in('status', ['pending', 'overdue'])
      .in('payment_category', ['inscripcion', 'seguro', 'mensualidad'])
      .neq('id', paymentIdParam)
      .order('due_date', { ascending: true })
      .then(({ data, error }) => {
        if (error) console.warn('[checkout] no se pudieron cargar los otros cobros:', error.message);
        if (!cancelled) setOtherOpenCharges((data as any[]) ?? []);
      });
    return () => { cancelled = true; };
  }, [childId, chargesSchoolId, paymentIdParam, success]);

  // Periodo objetivo (solo si es mensualidad y hay hijo)
  // Un cobro único (categoría explícita ≠ mensualidad) nunca es mensualidad,
  // aunque el nombre del plan en su concepto diga «mensual».
  const isMensualidad = /mensual/i.test(concept) && !isOneTimeCategory(qrPayment?.payment_category);
  const { period: nextPeriod } = useNextUnpaidPeriod(isMensualidad ? childId : null);
  const periodAlreadyCovered =
    !!nextPeriod && isPeriodActive(nextPeriod.current_status as PeriodStatus);

  /** Devuelve true si el cobro quedó registrado; false si falló (ya avisó con toast). */
  const recordPaymentWithTraceability = async (reference: string): Promise<boolean> => {
    // Multi-tenant safe: resolve schoolId from URL or derive from team_id.
    // Never fall back to "any school" - would attach the payment to the wrong tenant.
    let schoolId: string | null = schoolIdParam;
    let ownerId: string | null = null;

    if (!schoolId && teamId) {
      const { data: team } = await supabase
        .from('teams')
        .select('school_id')
        .eq('id', teamId)
        .maybeSingle();
      schoolId = team?.school_id ?? null;
    }

    if (schoolId) {
      const { data: schoolRow } = await supabase
        .from('schools')
        .select('owner_id')
        .eq('id', schoolId)
        .maybeSingle();
      ownerId = schoolRow?.owner_id ?? null;
    }

    if (!schoolId) {
      toast({ title: 'Error', description: 'Falta school_id en el checkout', variant: 'destructive' });
      return false;
    }

    // Period explicito solo cuando es mensualidad y la RPC nos dio un mes
    const periodYear  = isMensualidad && nextPeriod ? nextPeriod.year  : null;
    const periodMonth = isMensualidad && nextPeriod ? nextPeriod.month : null;
    const periodLabel = isMensualidad && nextPeriod ? nextPeriod.label : null;

    // Campos que se setean al pagar (comunes a insertar y actualizar).
    // OJO: period_year/period_month NO van aquí. Al pagar un cobro EXISTENTE
    // (viene del QR con payment_id) el cobro ya trae su propio período; si lo
    // sobreescribiéramos con el que calcula next_unpaid_period, colisionaría con
    // uniq_payment_active_period_per_child cuando hay otros cobros activos del
    // mismo hijo → "Pago rechazado / duplicate key". Solo se setea en INSERT.
    const mutableFields = {
      // Manual queda "awaiting_approval" (la escuela valida). En línea (Wompi/MP)
      // el navegador NO toca status ni payment_date: el webhook del BFF verifica
      // el monto con la pasarela y es el único que marca 'paid'. Además la base
      // lo rechaza (trg_zz_guard_payments_client, spec blindaje-dinero §1.2).
      ...(paymentFlow === 'manual'
        ? { status: 'awaiting_approval', payment_date: todayColombia() }
        : {}),
      receipt_number: reference,
      payment_method: paymentFlow === 'wompi' ? 'card' : 'transfer',
      receipt_url: manualReceiptUrl,
      // Persistir OCR del comprobante (solo manual). Admin lo usa para detectar discrepancias.
      ocr_amount:    manualOcrResult?.extractedAmount    ?? null,
      ocr_currency:  manualOcrResult?.extractedCurrency  ?? null,
      ocr_date:      manualOcrResult?.extractedDate      ?? null,
      ocr_bank:      manualOcrResult?.extractedBank      ?? null,
      ocr_reference: manualOcrResult?.extractedReference ?? null,
      ocr_provider:  manualOcrResult?.provider           ?? null,
      ocr_destination:      manualOcrResult?.extractedDestination     ?? null,
      ocr_destination_name: manualOcrResult?.extractedDestinationName ?? null,
      ocr_origin_name:      manualOcrResult?.extractedOriginName      ?? null,
      ocr_time:             manualOcrResult?.extractedTime            ?? null,
      ocr_raw_response: manualOcrResult?.rawResponse
        ? safeParseJson(manualOcrResult.rawResponse) ?? manualOcrResult.rawResponse
        : null,
      // Veredicto de reglas (modo sombra): se guarda pero NO cambia el status.
      receipt_verdict:             manualOcrResult?.verdict           ?? null,
      receipt_verdict_reasons:     manualOcrResult?.verdictReasons    ?? null,
      receipt_reference_norm:      manualOcrResult?.referenceNorm     ?? null,
      receipt_image_sha256:        manualOcrResult?.imageSha256       ?? null,
      receipt_image_sha256_source: manualOcrResult?.imageSha256Source ?? null,
      receipt_verdict_at:          manualOcrResult?.verdict ? new Date().toISOString() : null,
    };

    let insertError;
    let resolvedPaymentId: string | null = paymentIdParam || null;
    if (paymentIdParam) {
      // Vino del QR: ACTUALIZA el pago ya creado (no duplicar). Conserva
      // amount/concept/child/school del pago original.
      // Solo cobros abiertos: un pago ya aprobado (o que el webhook acaba de
      // marcar 'paid') no se reabre desde el navegador.
      ({ error: insertError } = await supabase.from('payments')
        .update({ ...mutableFields, updated_at: new Date().toISOString() } as any)
        .eq('id', paymentIdParam)
        .in('status', ['pending', 'overdue', 'partial', 'rejected', 'failed', 'awaiting_approval']));
    } else {
      const ins = await supabase.from('payments').insert({
        parent_id: user?.id,
        child_id: childId || null,
        team_id: teamId || null,
        amount,
        // Si tenemos label del periodo, usarlo en lugar del concept libre del
        // query string (mas consistente con la fuente de verdad de la BD).
        concept: periodLabel ? `Mensualidad ${periodLabel}` : concept,
        due_date: todayColombia(),
        payment_type: 'one_time',
        school_id: schoolId,
        // El período solo se estampa al CREAR el cobro (no al actualizar uno del QR).
        period_year:  periodYear,
        period_month: periodMonth,
        ...mutableFields,
      } as any).select('id').single();
      insertError = ins.error;
      resolvedPaymentId = ins.data?.id ?? null;
    }

    if (insertError) {
      console.error('Error inserting payment:', insertError);
      // Conflicto de unique index: el comprobante ya fue usado en otro pago de
      // esta escuela — sea por numero de operacion (uq_payments_school_ocr_reference)
      // o por hash de imagen re-subida (uq_payments_school_receipt_hash).
      const dupMsg = insertError.message?.toLowerCase() ?? '';
      const isOcrDuplicate = insertError.code === '23505'
        && (dupMsg.includes('ocr_reference') || dupMsg.includes('receipt_hash') || dupMsg.includes('receipt_image_sha256'));
      const isPeriodDuplicate = insertError.code === '23505'
        && dupMsg.includes('uniq_payment_active_period_per_child');
      toast({
        title: isOcrDuplicate ? 'Comprobante ya recibido' : isPeriodDuplicate ? 'Ya hay un cobro para este mes' : 'Error',
        description: isOcrDuplicate
          ? 'Este comprobante ya fue recibido: está vinculado a otro pago de esta escuela (puede haber llegado por WhatsApp o por otro cobro tuyo). Si crees que es un error, contacta a la administración.'
          : isPeriodDuplicate
          ? 'Ya existe un cobro activo para este mes de este atleta. Vuelve a la lista de cobros y paga el que aparece pendiente.'
          : (mensajeErrorDeMonto(insertError) ?? 'No se pudo registrar el pago en la base de datos'),
        variant: 'destructive',
      });
      return false;
    }

    // Evaluación post-insert (Fase 5). Fire-and-forget: el BFF decide server-side
    // auto-aprobar (verde+doble extracción+toggle+tope) / abrir glosa (amarillo) / nada.
    if (resolvedPaymentId && (manualOcrResult?.verdict === 'verde' || manualOcrResult?.verdict === 'amarillo')) {
      autoEvaluateGlosa(resolvedPaymentId).catch(() => { /* dormant/no-op tolerado */ });
    }

    const periodSuffix = periodLabel ? ` — ${periodLabel}` : '';
    const traceMsg = `Pago de ${formatPrice(chargeAmount)} por ${studentName}${teamName ? ` (${teamName})` : ''} en ${schoolName}${periodSuffix}`;

    // El comprobante por validar (flujo manual) ya NO se avisa desde acá: lo
    // avisa el job receipt-review-alerts del BFF al dueño Y a los admins, para
    // todos los caminos de entrada (app, bot de WhatsApp, importador), agrupado
    // y con recordatorio si pasa 2 h sin revisar. Avisarlo también acá lo
    // duplicaba. El pago en línea sí se avisa (va a Finanzas).
    if (ownerId && paymentFlow !== 'manual') {
      await supabase.rpc('notify_user', {
        p_user_id: ownerId,
        p_title: `Pago Recibido${periodSuffix}`,
        p_message: traceMsg,
        p_type: 'payment',
        p_link: '/finances',
      });
    }

    return true;
  };

  const handleWompiPayment = async () => {
    if (!user) { toast({ title: 'Inicia sesión', variant: 'destructive' }); navigate('/login'); return; }

    // Security Check
    if (!paymentSettings?.allow_online) {
      toast({ title: 'No disponible', description: 'Esta escuela no acepta pagos en línea.', variant: 'destructive' });
      return;
    }

    // El pago online necesita un pago real registrado: la referencia debe existir
    // en payment_links (la crea create-session). Si generamos una referencia al
    // vuelo, wompi-sign responde 404 "Reference no encontrada", la firma falla y
    // el Widget nunca abre.
    if (!paymentIdParam) {
      toast({
        title: 'No disponible',
        description: 'No se pudo iniciar el pago en línea. Usa transferencia manual.',
        variant: 'destructive',
      });
      return;
    }

    setProcessing(true);

    try {
      if (!(await confirmFreshAmount())) return;

      // 1. Crear la sesión server-side → registra la referencia en payment_links
      //    y devuelve el monto firmado por el servidor (fuente de verdad del monto).
      const session = await bffClient.post<{
        reference: string;
        amountInCents: number;
        // Firma y public key del comercio de ESTA escuela, resueltas por el BFF según su
        // payment_mode. Antes, sin ellas el Widget caía a la llave de build + firma de la
        // Edge Function, de comercios distintos → "La firma es inválida" (Dynasty desde
        // el 27-ago). Hoy, sin ellas, el checkout no abre.
        signature?: string | null;
        publicKey?: string | null;
      }>(
        '/api/v1/payments/create-session',
        { paymentId: paymentIdParam, preferredProvider: 'wompi' },
        schoolIdParam ? { 'x-school-id': schoolIdParam } : undefined,
      );

      const reference = session.reference;
      setReceiptNumber(reference);

      const customerName = user.user_metadata?.full_name || user.email || 'Padre';
      const customerEmail = user.email || 'demo@sportmaps.co';

      // Documento del comprador: se exige antes de pagar (BillingDetailsForm),
      // así que el perfil ya lo tiene. Lo prellenamos en el Widget para que el
      // padre no dependa del desplegable interno (que en algunos Android no abre).
      let legalId: string | undefined;
      let legalIdType: string | undefined;
      const { data: prof } = await supabase
        .from('profiles')
        .select('document_type, document_number')
        .eq('id', user.id)
        .maybeSingle();
      if (prof?.document_number && prof?.document_type) {
        legalId = String(prof.document_number).trim();
        // Wompi usa PP para pasaporte; el resto (CC/CE/NIT/TI/RC) coincide.
        const t = String(prof.document_type).trim().toUpperCase();
        legalIdType = t === 'PASAPORTE' ? 'PP' : t;
      }

      // 2. Abrir el Widget con la referencia válida.
      const transaction = await openWompiCheckout({
        reference,
        amountInCents: session.amountInCents,
        // Llave y firma del BFF, obligatorias: sin ellas openWompiCheckout no abre.
        signature: session.signature ?? undefined,
        publicKey: session.publicKey ?? undefined,
        customerEmail,
        customerName,
        legalId,
        legalIdType,
        studentName,
        teamName: concept,
        schoolName,
      });

      if (transaction && transaction.status === 'APPROVED') {
        setWompiTxId(transaction.id);
        setPaymentMethodUsed(transaction.paymentMethodType || 'CARD');
        // Wompi ya aprobó; el webhook es quien marca el cobro como pagado.
        await recordPaymentWithTraceability(reference);
        setSuccess(true);
        toast({ title: '¡Pago exitoso!', description: 'Procesado con Wompi. En unos segundos queda confirmado en tu cuenta.' });
      } else if (transaction && transaction.status === 'PENDING') {
        setWompiTxId(transaction.id);
        toast({ title: 'Pago pendiente', description: 'Te notificaremos cuando se confirme.' });
      } else if (transaction) {
        toast({ title: 'Pago no completado', description: `Estado: ${transaction.status}`, variant: 'destructive' });
      } else {
        toast({ title: 'Pago cancelado', description: 'Cerraste la ventana de pago.' });
      }
    } catch (error) {
      toast({
        title: 'Error en el pago',
        // El cierre por llave/firma no confiable trae un mensaje pensado para la familia
        // (con la salida por transferencia); el traductor genérico lo taparía.
        description: mensajeCheckoutNoDisponible(error) ?? getUserFriendlyError(error),
        variant: 'destructive'
      });
    } finally { setProcessing(false); }
  };

  const handleManualPayment = async () => {
    if (!user) { toast({ title: 'Inicia sesión', variant: 'destructive' }); navigate('/login'); return; }

    // Security Check
    if (!paymentSettings?.allow_manual) {
      toast({ title: 'No disponible', description: 'Esta escuela no acepta pagos manuales.', variant: 'destructive' });
      return;
    }

    if (!manualReceiptUrl) {
      toast({ title: 'Sube tu comprobante', description: 'Debes subir la imagen de tu transferencia para continuar.', variant: 'destructive' });
      return;
    }
  
    setProcessing(true);

    try {
      if (!(await confirmFreshAmount())) return;
      const reference = generatePaymentReference();
      setReceiptNumber(reference);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      setPaymentMethodUsed('Transferencia manual');
      if (!(await recordPaymentWithTraceability(reference))) return;
      setSuccess(true);
      toast({ title: '¡Pago registrado!', description: 'La escuela confirmará tu pago' });
    } catch (error) {
      toast({
        title: 'Error al registrar',
        description: getUserFriendlyError(error),
        variant: 'destructive'
      });
    } finally { setProcessing(false); }
  };

  const handleMpSuccess = async (result: MpCreatePaymentResult) => {
    setProcessing(true);
    try {
      setWompiTxId(String(result.paymentId));
      setPaymentMethodUsed('MercadoPago');
      const ref = mpReference || `SCH-MP-${Date.now().toString(36).toUpperCase()}`;
      setReceiptNumber(ref);
      if (!(await recordPaymentWithTraceability(ref))) return;
      setSuccess(true);

      if (result.internalStatus === 'paid') {
        toast({ title: '¡Pago exitoso!', description: 'Procesado con MercadoPago' });
      } else {
        toast({
          title: 'Pago en proceso',
          description: `Estado: ${result.statusDetail}. Te notificaremos cuando se confirme.`,
        });
      }
    } catch (error) {
      toast({
        title: 'Error registrando el pago',
        description: getUserFriendlyError(error),
        variant: 'destructive',
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleMpError = (err: Error) => {
    toast({
      title: 'Error en MercadoPago',
      description: err.message,
      variant: 'destructive',
    });
  };

  // Genera la reference MP cuando el padre cambia a MercadoPago, para
  // garantizar consistencia entre la creacion del pago y el registro en DB.
  useEffect(() => {
    if (paymentFlow === 'mercadopago' && !mpReference) {
      const ref = `SCH-MP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      setMpReference(ref);
    }
  }, [paymentFlow, mpReference]);

  const handlePayment = () => {
    if (paymentFlow === 'wompi') {
      handleWompiPayment();
    } else if (paymentFlow === 'mercadopago') {
      // El Brick maneja su propio submit; este boton no aplica para MP.
      toast({ title: 'Completa los datos en el formulario MercadoPago' });
    } else {
      handleManualPayment();
    }
  };

  const otherChargesBlock = (title: string) => otherOpenCharges.length > 0 && (
    <div className="rounded-xl border p-4 mb-6 text-left bg-background">
      <p className="font-semibold text-sm mb-1">{title}</p>
      <p className="text-xs text-muted-foreground mb-2">Se pagan por separado: elige uno y continúa.</p>
      {otherOpenCharges.map((c) => {
        const due = Math.max(Number(c.amount) - (Number(c.amount_paid) || 0), 0);
        return (
          <div key={c.id} className="flex items-center justify-between gap-3 py-2 border-t first:border-t-0">
            <div className="min-w-0">
              <p className="text-sm truncate">{c.concept}</p>
              <p className="text-xs text-muted-foreground">{formatPrice(due)}</p>
            </div>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => goToCharge(c.id)}>
              Pagar
            </Button>
          </div>
        );
      })}
    </div>
  );

  if (loadingSettings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center">
            <div className="h-20 w-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 className="h-10 w-10 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold mb-2">¡Pago Exitoso!</h2>
            <Badge variant="secondary" className="mb-2">Recibo #{receiptNumber}</Badge>

            <div className="bg-muted/50 rounded-xl p-4 mb-6 text-left">
              <div className="flex justify-between font-bold text-lg"><span>Pagado</span><span className="text-green-600">{formatPrice(chargeAmount)}</span></div>
            </div>

            {otherChargesBlock('Todavía tienes estos cobros pendientes')}

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={handleDownloadReceipt}>
                <Download className="h-4 w-4 mr-2" />Recibo
              </Button>
              <Button className="flex-1" onClick={() => navigate('/dashboard')}>Salir</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const canPayOnline = paymentSettings?.allow_online;
  const canPayManual = paymentSettings?.allow_manual;

  return (
    <div className="min-h-screen bg-muted/30">
      <div className="bg-background border-b">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="h-5 w-5" /></Button>
            <div><h1 className="text-xl font-bold">{schoolName}</h1><p className="text-muted-foreground">Pago</p></div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-lg">
        {periodAlreadyCovered && nextPeriod && (
          <div className="mb-4 p-3 rounded-lg border-2 border-amber-300 bg-amber-50 flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-semibold text-amber-900">
                {nextPeriod.label} ya tiene un pago activo
              </p>
              <p className="text-amber-800 text-xs mt-0.5">
                {nextPeriod.current_status === 'paid' || nextPeriod.current_status === 'approved'
                  ? `Ya pagaste ${nextPeriod.label}.`
                  : `Hay un comprobante de ${nextPeriod.label} esperando validación.`}
                {' '}Si continúas, este pago quedará registrado como un cobro adicional para ese mes.
              </p>
            </div>
          </div>
        )}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>
              {nextPeriod && isMensualidad ? `Mensualidad ${nextPeriod.label}` : (amountPaid > 0 ? `Saldo: ${formatPrice(chargeAmount)}` : `Total: ${formatPrice(amount)}`)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex justify-between mb-2"><span className="text-muted-foreground">Concepto</span><span>{nextPeriod && isMensualidad ? `Mensualidad ${nextPeriod.label}` : concept}</span></div>
            <div className="flex justify-between mb-2"><span className="text-muted-foreground">Total</span><span className="font-bold">{formatPrice(amount)}</span></div>
            {lateFee > 0 && (
              <p className="-mt-1 mb-2 text-right text-xs font-semibold text-amber-600 dark:text-amber-400">
                Incluye recargo por mora: {formatPrice(lateFee)}
              </p>
            )}
            {amountPaid > 0 && (
              <>
                <div className="flex justify-between mb-2"><span className="text-muted-foreground">Ya abonado</span><span className="font-semibold text-emerald-600">− {formatPrice(amountPaid)}</span></div>
                <div className="flex justify-between mb-2 pt-2 border-t"><span className="text-muted-foreground">Saldo pendiente</span><span className="font-bold text-amber-600">{formatPrice(chargeAmount)}</span></div>
              </>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">Deportista</span><span>{studentName}</span></div>
          </CardContent>
        </Card>

        {otherChargesBlock(`Otros cobros pendientes de ${studentName}`)}

        <Card className="mb-6">
          <CardHeader><CardTitle className="text-lg">Método de Pago</CardTitle></CardHeader>
          <CardContent>
            {!checkingDian && askDianData ? (
              <div className="pt-2">
                <BillingDetailsForm onComplete={() => setHasCompleteDianData(true)} />
              </div>
            ) : (!canPayOnline && !canPayManual) ? (
              <div className="p-4 bg-destructive/10 text-destructive rounded-lg">Esta escuela no acepta pagos por este medio.</div>
            ) : (
              <>
                <RadioGroup value={paymentFlow} onValueChange={(v) => setPaymentFlow(v as 'wompi' | 'mercadopago' | 'manual')}>
                  {canPayOnline && (
                    <div className={`flex items-center space-x-3 p-4 border rounded-lg cursor-pointer ${paymentFlow === 'wompi' ? 'border-primary bg-primary/5' : ''}`} onClick={() => setPaymentFlow('wompi')}>
                      <RadioGroupItem value="wompi" id="wompi" />
                      <Label htmlFor="wompi" className="cursor-pointer flex-1">
                        <div className="font-medium flex items-center gap-2"><CreditCard className="h-4 w-4" /> Wompi (Online)</div>
                      </Label>
                    </div>
                  )}

                  {/* 2026-08-31: MercadoPago oculto — VITE_MP_PUBLIC_KEY_DEFAULT resuelve a la
                      cuenta comercial de ENV, que resultó ser la cuenta PERSONAL de MercadoPago
                      de un padre real de la plataforma, no una cuenta de SportMaps ni de la
                      escuela. El backend ya lo bloquea fail-closed (payment-provider.resolver.ts),
                      esto además evita mostrar un botón que fallaría. Reactivar cuando haya una
                      cuenta comercial real detrás de MP_ACCESS_TOKEN_DEFAULT. */}
                  {/* eslint-disable-next-line no-constant-binary-expression -- kill switch intencional (SEG-23), no un error */}
                  {false && canPayOnline && import.meta.env.VITE_MP_PUBLIC_KEY_DEFAULT && (
                    <div className={`flex flex-col space-y-3 p-4 border rounded-lg cursor-pointer mt-3 ${paymentFlow === 'mercadopago' ? 'border-primary bg-primary/5' : ''}`} onClick={() => setPaymentFlow('mercadopago')}>
                      <div className="flex items-center space-x-3">
                        <RadioGroupItem value="mercadopago" id="mercadopago" />
                        <Label htmlFor="mercadopago" className="cursor-pointer flex-1">
                          <div className="font-medium flex items-center gap-2">
                            <CreditCard className="h-4 w-4" /> MercadoPago (Online)
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Tarjetas, PSE, Efecty, Wallet MP
                          </div>
                        </Label>
                      </div>

                      {paymentFlow === 'mercadopago' && mpReference && (
                        <div className="pl-7 pt-2 animate-in fade-in slide-in-from-top-2" onClick={(e) => e.stopPropagation()}>
                          <MercadoPagoBrick
                            publicKey={import.meta.env.VITE_MP_PUBLIC_KEY_DEFAULT}
                            sandbox={true}
                            transactionAmount={amount}
                            externalReference={mpReference}
                            payerEmail={user?.email || 'demo@sportmaps.co'}
                            payerFirstName={(user?.user_metadata?.full_name || 'Padre').split(' ')[0]}
                            payerLastName={(user?.user_metadata?.full_name || '').split(' ').slice(1).join(' ') || 'Demo'}
                            description={`${concept} — ${studentName}`}
                            schoolId={schoolIdParam || undefined}
                            onSuccess={handleMpSuccess}
                            onPending={handleMpSuccess}
                            onError={handleMpError}
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {canPayManual && (
                    <div className={`flex flex-col space-y-3 p-4 border rounded-lg cursor-pointer mt-3 ${paymentFlow === 'manual' ? 'border-primary bg-primary/5' : ''}`} onClick={() => setPaymentFlow('manual')}>
                      <div className="flex items-center space-x-3">
                        <RadioGroupItem value="manual" id="manual" />
                        <Label htmlFor="manual" className="cursor-pointer flex-1">
                          <div className="font-medium flex items-center gap-2"><Upload className="h-4 w-4" /> Transferencia Manual</div>
                        </Label>
                      </div>

                      {paymentFlow === 'manual' && bankDetails && (
                        <div className="pl-7 pt-2 animate-in fade-in slide-in-from-top-2">
                          {paymentLink && <PaymentLinkButton url={paymentLink} className="mb-3" />}
                          <div className="bg-background/80 p-3 rounded border space-y-1 font-mono text-xs mb-3">
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-muted-foreground font-sans font-semibold">Datos de Transferencia:</p>
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-6 px-2 text-[10px] font-sans" 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowSensitive(!showSensitive);
                                }}
                              >
                                {showSensitive ? <EyeOff className="h-3 w-3 mr-1" /> : <Eye className="h-3 w-3 mr-1" />}
                                {showSensitive ? "Ocultar" : "Mostrar"}
                              </Button>
                            </div>
                            
                            {bankDetails.bank_name && <p><strong>Banco:</strong> {bankDetails.bank_name} ({bankDetails.bank_account_type})</p>}
                            
                            {bankDetails.bank_account_number && (
                              <div className="flex justify-between items-center gap-2">
                                <p><strong>Número:</strong> {showSensitive ? bankDetails.bank_account_number : maskSensitive(bankDetails.bank_account_number)}</p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 shrink-0 font-sans"
                                  onClick={(e) => { e.stopPropagation(); copyField(bankDetails.bank_account_number, 'Número'); }}
                                >
                                  <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
                                </Button>
                              </div>
                            )}

                            {/* Llaves de la escuela (payment_accounts). Puede tener varias del
                                mismo tipo; solo estas se aceptan como destino del comprobante. */}
                            {payableAccounts.map(account => (
                              <div key={account.id} className="flex justify-between items-center gap-2">
                                <p>
                                  <strong>{accountDisplayLabel(account)}:</strong>{' '}
                                  {showSensitive ? account.value : maskSensitive(account.value)}
                                </p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 shrink-0 font-sans"
                                  onClick={(e) => { e.stopPropagation(); copyField(account.value, accountDisplayLabel(account)); }}
                                >
                                  <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
                                </Button>
                              </div>
                            ))}

                            {bankDetails.bank_titular_name && <p><strong>Titular:</strong> {bankDetails.bank_titular_name}</p>}
                            {bankDetails.bank_titular_id && (
                              <div className="flex justify-between items-center gap-2">
                                <p><strong>NIT/CC:</strong> {showSensitive ? bankDetails.bank_titular_id : maskSensitive(bankDetails.bank_titular_id)}</p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 shrink-0 font-sans"
                                  onClick={(e) => { e.stopPropagation(); copyField(bankDetails.bank_titular_id, 'NIT/CC'); }}
                                >
                                  <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
                                </Button>
                              </div>
                            )}
                          </div>

                          {bankDetails.payment_qr_url && (
                            <div className="mt-3 text-center flex flex-col items-center">
                              <p className="text-xs font-semibold mb-2 text-muted-foreground">O escanea este QR:</p>
                              <div 
                                className="relative group cursor-pointer overflow-hidden rounded-lg border shadow-sm transition-all duration-300 hover:shadow-md hover:scale-[1.02]"
                                onClick={(e) => { e.stopPropagation(); setShowFullQr(true); }}
                              >
                                <img 
                                  src={bankDetails.payment_qr_url} 
                                  alt="QR de Pago" 
                                  className="w-24 h-24 object-cover" 
                                />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <span className="text-[10px] text-white font-medium bg-black/60 px-1.5 py-0.5 rounded flex items-center gap-1">
                                    <Maximize2 className="h-3 w-3" /> Ampliar
                                  </span>
                                </div>
                              </div>
                              <span className="text-[10px] text-muted-foreground mt-1 block">Clic para ampliar 🔍</span>
                            </div>
                          )}
                          
                          {/* Paso a paso ANTES de subir. El aviso de "falta 1 paso" ya
                              existía pero es reactivo: aparece recién después de cargar el
                              archivo y en móvil queda debajo del QR, fuera de pantalla. Nueve
                              familias de Dynasty subieron el comprobante y no confirmaron
                              (medido 2026-08-05): el archivo quedó huérfano en storage, el
                              cobro sin tocar, y la escuela sin ver nada. Decirle que son tres
                              pasos ANTES de empezar es lo que evita que se caiga en el medio. */}
                          <div className="mt-4 pt-4 border-t">
                            {/* Panel propio y no más letra chica suelta: si esto se ve como
                                fine print, se saltea. `list-outside` + `pl-5` para que la
                                línea que se parte en móvil quede alineada con el texto y no
                                debajo del número; `marker:` resalta el número sin maquetar
                                badges a mano. */}
                            {/* Tamaños mobile-first: `sm:` es 640px y un teléfono en vertical
                                mide 390–430, así que `text-xs sm:text-sm` le dejaba 12px al
                                celular —donde la instrucción más importa— y 14 al escritorio.
                                Base 14px para todos. `marker:` no lo aplican WebViews viejos
                                de iOS; degrada a número sin estilo, no rompe el layout. */}
                            <div className="rounded-lg border bg-muted/40 p-3 mb-3">
                              <p className="text-sm font-bold mb-2 leading-snug">
                                Para que tu pago quede registrado, completa los 3 pasos:
                              </p>
                              <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-outside pl-5 leading-snug marker:font-bold marker:text-foreground">
                                <li>Haz la transferencia a la cuenta de arriba.</li>
                                <li>Sube aquí la imagen del comprobante.</li>
                                <li>
                                  Pulsa <strong className="text-foreground">"Enviar comprobante"</strong> al final de la pantalla.
                                  {' '}<span className="text-amber-700 dark:text-amber-500 font-semibold">
                                    Sin este paso tu pago no queda registrado.
                                  </span>
                                </li>
                              </ol>
                            </div>
                            <Label className="text-xs sm:text-sm font-semibold mb-2 block">Paso 2 — Sube tu comprobante:</Label>
                            <FileUpload
                              bucket="payment-receipts"
                              path={`manual-payments/${user?.id}`}
                              accept="image/*,application/pdf"
                              onUploadComplete={(url) => { setManualReceiptUrl(url); void linkReceiptOnUpload(url); }}
                              onValidationResult={(r) => setManualOcrResult(r)}
                              validateReceipt={true}
                              schoolId={resolvedSchoolId || undefined}
                              paymentId={paymentIdParam || undefined}
                              paymentCategory={chargeCategory}
                              expectedAmount={chargeAmount}
                              conceptKind={conceptKind}
                              allowPartial={installmentCfg.allow_installments}
                              minPartialAmount={installmentCfg.min_installment_amount}
                              dateWindowDays={receiptWindowDays}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </RadioGroup>

                {paymentFlow !== 'mercadopago' && (
                  <>
                    {/* Este aviso ya existía en text-xs ámbar suave y no alcanzó: las nueve
                        familias que se cayeron lo tuvieron en pantalla. Se sube el volumen y
                        se nombra la consecuencia — que el comprobante se pierde si cierra —
                        porque "aún no se ha enviado" se lee como un detalle, no como un
                        trabajo a medias. */}
                    {paymentFlow === 'manual' && manualReceiptUrl && (
                      // El tono depende de si el comprobante YA quedó enlazado al cobro
                      // (linkReceiptOnUpload, que solo corre con payment_id). Si llegó,
                      // decir "se pierde si cierras" seria mentirle. Si no hay payment_id
                      // no se enlazo nada y la advertencia fuerte sigue siendo la verdad.
                      <div
                        ref={pendingSendRef}
                        role="alert"
                        aria-live="polite"
                        className={`mt-4 flex items-start gap-3 text-sm rounded-lg p-3 leading-snug scroll-mt-4 border-2 ${
                          paymentIdParam
                            ? 'bg-emerald-50 border-emerald-400 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-600 dark:text-emerald-200'
                            : 'bg-amber-100 border-amber-400 text-amber-900 dark:bg-amber-950/40 dark:border-amber-600 dark:text-amber-200'
                        }`}
                      >
                        {paymentIdParam
                          ? <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
                          : <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />}
                        <span className="min-w-0">
                          {paymentIdParam ? (
                            <>
                              <strong className="block text-base mb-0.5">Tu comprobante ya llegó a la escuela</strong>
                              Queda guardado y la escuela puede verlo. Para terminar de registrar tu pago,
                              pulsa el botón de abajo.
                            </>
                          ) : (
                            <>
                              <strong className="block text-base mb-0.5">Falta el último paso</strong>
                              Tu comprobante se cargó, pero <strong>todavía no llegó a la escuela</strong>.
                              Si cierras esta pantalla ahora se pierde y tu pago sigue pendiente.
                              Pulsa el botón de abajo para enviarlo.
                            </>
                          )}
                        </span>
                      </div>
                    )}
                    <Button className="w-full mt-4" onClick={handlePayment} disabled={processing || (!canPayOnline && !canPayManual)}>
                      {processing
                        ? 'Procesando...'
                        : paymentFlow === 'manual'
                          ? (manualReceiptUrl ? 'Enviar comprobante y registrar pago' : `Registrar pago de ${formatPrice(chargeAmount)}`)
                          : `Pagar ${formatPrice(chargeAmount)}`}
                    </Button>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showFullQr} onOpenChange={setShowFullQr}>
        <DialogContent className="sm:max-w-md max-w-[90vw] rounded-xl p-6 flex flex-col items-center justify-center bg-background/95 backdrop-blur-md border border-primary/20 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
          <DialogHeader className="w-full text-center mb-2">
            <DialogTitle className="text-lg font-bold text-foreground">QR de Pago</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Escanea este código desde la app de tu banco para realizar la transferencia a la escuela
            </DialogDescription>
          </DialogHeader>
          
          <div className="bg-white p-4 rounded-xl border shadow-inner flex items-center justify-center max-w-full max-h-list overflow-hidden">
            <img 
              src={bankDetails?.payment_qr_url || ''} 
              alt="Código QR de Pago Completo" 
              className="max-w-full max-h-[50dvh] object-contain rounded-lg transition-transform duration-300 hover:scale-105"
            />
          </div>
          
          <div className="flex gap-3 w-full mt-6">
            <Button 
              variant="outline" 
              className="flex-1 border-primary/20 hover:bg-primary/5 text-xs h-9" 
              onClick={async () => {
                try {
                  const response = await fetch(bankDetails?.payment_qr_url || '');
                  const blob = await response.blob();
                  const url = window.URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `qr-pago-${schoolName.toLowerCase().replace(/\s+/g, '-')}.png`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  window.URL.revokeObjectURL(url);
                  toast({ title: "Código QR descargado" });
                } catch (e) {
                  window.open(bankDetails?.payment_qr_url || '', '_blank');
                }
              }}
            >
              <Download className="h-4 w-4 mr-2 text-primary" /> Descargar QR
            </Button>
            <Button 
              className="flex-1 text-xs h-9" 
              onClick={() => setShowFullQr(false)}
            >
              Cerrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
